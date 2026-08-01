# R12：deterministic metadata concurrency harness 窄事实调查

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本文只回答现有 seam 能否构造确定性的 metadata 并发验收；不设计生产修法。

## A. 摘要

**Verdict: FAIL。** 当前 checkout 没有公开/现成测试工具能让两个 metadata writer 都完成 pre-read 后停在 barrier、再由测试按两种顺序逐一 release。现有 operator CLI happy-path 只能证明单 writer round-trip 与幂等；现有 scheduler trigger callback 只能暂停 keep-active writer。`chain set-runner-model` 的 metadata pre-read、merge、`updateChain` 调用之间没有 `await`、callback、注入 store 或测试 latch，因此无法在不改产品代码的 spike 中把该 writer 确定地停在 pre-read 后。

这不是说 lost update 不存在。旧调查已用两个 store snapshot 确定性证明 whole-snapshot replacement 的覆盖；生产 keep-active 路径也确有跨外部 `await` 的 stale snapshot 窗口。这里的 FAIL 只表示：**要求的真实 operator CLI/status、双 pre-read、双 commit-order harness 尚缺一个可控 seam。** shell 同时启动两个 CLI 不满足 barrier，也不能证明两个 writer 都已完成 pre-read。

现有 seam 可覆盖的子集：

1. 单 writer：真实 `chain set-runner-model --json` → daemon → SQLite → response/read-back；已实跑通过。
2. keep-active stale-read 后 binding 先提交：scheduler 的 `chainCompleteTrigger` callback 可作为 barrier，期间运行真实 operator CLI，然后 release trigger。
3. binding stale-read 后 keep-active 先提交：**不可确定构造**；binding handler 在 pre-read 后没有 yield。
4. 两个 binding writer：不同 socket虽可并发进入 auth gate，但 handler 的 read/merge/write 段同步执行；没有 pre-read 后 latch，启动时序不能替代控制点。

## B. 调用链与可插 barrier seam

### B1. `chain set-runner-model` 完整链路

1. CLI 在 `src/loop.ts:2242-2253` 组装 `{ [kind]: { model } }`，调用 daemon op `chain.updateBindings`。
2. `requestDaemonResult` 经 Unix socket 发请求并 await reply；daemon error 在普通 chain 命令路径被压成 `fail("<code>: <message>")`，见 `src/loop.ts:2487-2504`。
3. daemon 对每个 socket 建局部 `requestSequence`；不同 socket 没有全局 request queue，见 `src/daemon.ts:1660-1693`。
4. `handleRequest` 先 `await runAuthorizationGate(...)`，再调用 handler，见 `src/daemon.ts:1920-1932`。该 await 在 metadata pre-read **之前**，所以只能作为“尚未读”的门，不能证明 writer 已 pre-read。
5. `handleChainUpdateBindings` 在 `src/daemon.ts:2624-2661` 连续同步执行：
   - `resolveChain(args)` 读取 chain snapshot；
   - 复制整个 metadata；
   - 校验/merge runner kind；
   - `this.requireStore().updateChain(...)`。
6. 第一个 handler 内 await 出现在 DB commit 之后的 audit 写：`src/daemon.ts:2662-2669`。它不能控制 commit order。
7. store 的 `updateChain` 在 immediate transaction 内重读 row，但传入 metadata 时选择调用方 whole snapshot；SQL predicate 只有 chain id，见 `src/sqlite-state.ts:1605-1612,1713-1734`。

因此公开链路里的 await 点是：socket round-trip、pre-read 前 auth gate、commit 后 audit。**没有一个 await 位于 pre-read 与 commit 之间。**

### B2. scheduler keep-active seam

`chainCompletionTriggerAllowsCompletion` 先持有 `chain` snapshot，再 `await options.chainCompleteTrigger(context)`，随后用旧 `chain.metadata` 调 `persistKeepActiveTriggerState`，见 `src/scheduler.ts:2752-2777,2798-2816`。测试提供的 trigger callback 可以：

- signal “keep-active 已完成 pre-read”；
- 等待外部 release；
- release 后提交旧 metadata。

它足以确定地覆盖“binding 先提交，stale keep-active 后提交”，不足以覆盖反向顺序，因为 operator binding writer自身不可在 pre-read 后暂停。

### B3. 审计到的所有候选 seam

| seam | 位置 | 能否满足双 pre-read barrier | 原因 |
|---|---|---:|---|
| daemon auth audit / auth await | `daemon.ts:1930` | 否 | 在 handler / metadata read 之前 |
| per-socket `requestSequence` | `daemon.ts:1665-1677` | 否 | 只串行同一 socket；没有 expose release API |
| scheduler `chainCompleteTrigger` | `scheduler.ts:2764-2766` | 部分 | 只暂停 keep-active writer |
| SQLite `BEGIN IMMEDIATE` / busy timeout | `sqlite-state.ts:1605-1612` | 否 | 控制 DB writer lock，不证明调用方已在 lock 前完成 pre-read；同步 busy wait还会阻塞 in-process daemon event loop |
| commit 后 `chain.layout` audit | `daemon.ts:2662-2668` | 否 | 已经完成 commit |
| `StartCoderLoopDaemonOptions` | `daemon.ts:299-310` | 否 | 只有 scheduler config / shutdown grace；无 store factory、handler hook或 barrier injection |
| 私有 `CoderLoopDaemon.store` | `daemon.ts:1175-1180` | 否（非 public） | 运行时 monkey patch/private-field bypass 不是现有 public seam，也不能作为稳定 harness |

外部 SQLite lock、轮询 audit file、sleep、两个后台 shell同时启动均不能建立“两个 writer 都已 pre-read”的证据。它们最多控制或推测请求到达/SQL等待。

## C. 现有 fixture 与安全性

### C1. 可复用的安全部分

`tests/integration/cli/smoke.integration.ts:275-294` 的 `createTarget` 只创建隔离 target、loop-data 及 `issues/evidence/runs` 目录；不调用 git，不创建 worktree。runner-model smoke 在 `:60-112`：

- 用隔离 `openSqliteStateStore` seed 一个无 item chain；
- `startCoderLoopDaemon({ scheduler: { enabled: false } })`；
- 运行真实 Bun CLI subprocess；
- 校验 daemon JSON reply 和 SQLite read-back；
- finally `daemon.stop()`，afterAll 删除 fixture。

该 fixture 满足本调查的“不新增 item、不触发 scheduler spawn、不创建 worktree”。本次已按 D1 原样运行目标 test，1 pass、0 fail。

### C2. 不可直接声称满足的部分

现有 smoke helper 是测试文件私有函数，不是可从独立 spike import 的公共 harness。它也没有 barrier、commit-order controller或 metadata revision/conflict assertion。

daemon integration harness 中存在带 scheduler、runner和 worktree生命周期的 fixture；本任务不需要也不应复用这些路径。安全方案必须保持 scheduler disabled，chain 无 item，只运行 metadata operator CLI。若验证 keep-active writer，则应直接用 scheduler store seam和纯 terminal fixture，且在执行前另行证明该具体 helper不调用 worktree setup；不能笼统借用 daemon harness。

## D. 实验、真实 CLI/status 和逐字命令

### D1. 已实跑的单 writer 回归（PASS）

以下命令已在固定 SHA 上运行：

```bash
cd /Users/mouriya/Ext/code/coder-loop
test "$(git rev-parse HEAD)" = "699842eba2eefc242d19f8fa9232bc1d9d5c3bdd"
bun test ./tests/integration/cli/smoke.integration.ts \
  --test-name-pattern 'chain set-runner-model patches'
```

观察：`1 pass, 6 filtered out, 0 fail`；日志含两次真实 `chain.updateBindings` operator admission、首次 `chain.layout`、正常 daemon stop。该 test 验证 single writer、同值幂等与 SQLite read-back，不验证并发。

### D2. 当前可以审计的真实 operator/read surface

writer 闭集（正常 runtime metadata mutation）：

```bash
cd /Users/mouriya/Ext/code/coder-loop
rg -n 'updateChain\([^\n]*metadata|metadata: withChainCompleteTriggerState|handleChainUpdateBindings' src
```

期望审计到：scheduler keep-active writer 与 daemon `chain.updateBindings`；create/migration 是初始化或启动迁移，不是该并发 runtime writer闭集。

operator writer 与读取命令形状：

```bash
bun src/loop.ts chain set-runner-model <CHAIN> \
  --kind codex --model <MODEL> --loop-data-root <ROOT> --json
bun src/loop.ts chain status <CHAIN> \
  --loop-data-root <ROOT> --json
```

`chain status --json` 返回 daemon 的完整 `chain` JSON（daemon `chainToJson`），可断言 `chain.metadata`。writer success JSON返回 `chain`, `alreadyMatched`, `updatedKinds`。当前普通 chain command 的 daemon failure不是结构化 JSON：即使传 `--json`，`requestDaemonResult` 仍调用 `fail("code: message")`；结构化 `{ok:false,error:{...}}` helper只用于 daemon command路径（`src/loop.ts:2559-2656`）。因此“typed conflict”在当前 CLI不存在，未来 harness不能把 stderr字符串误称 typed response。

### D3. 要求的完整 harness 目前没有可原样运行命令

不存在诚实的 setup/run/assert/teardown 命令能够在 **不改产品/测试** 的前提下同时证明：

1. writer A 与 B 都已 pre-read；
2. 外部 barrier分别 release A→B、B→A；
3. 每轮经真实 operator CLI与 `chain status --json`验证；
4. 不相交字段保留；
5. 同字段得到规范指定的确定结果或 typed conflict；
6. 单 writer回归。

若把 `cmdA & cmdB & wait` 写成 run命令，只能证明竞争启动，不能证明 barrier状态或 commit顺序，故本文明确不提供这种伪命令。

### D4. 当前 lost update 能否由真实 CLI 确定复现

**只能确定复现一个方向，不能覆盖完整矩阵。** trigger callback可先截住 stale keep-active，真实 CLI提交 runner model，再 release keep-active；最终 `chain status --json` 可观察 model被旧 snapshot覆盖。反向顺序要求真实 CLI先 pre-read并暂停，再让 keep-active提交，当前没有 seam。两条 operator CLI互相竞争也因 handler read→commit连续同步，无法用外部 barrier证明双方都读了同一基线。

所以“当前 lost-update 可用真实 CLI确定复现”若指至少一条生产交错：是；若指本任务要求的两种 commit order与完整断言：否。

## E. Assumption verdict

| assumption | verdict | 证据 |
|---|---|---|
| 已有公开 harness 可做双 pre-read / 双 release | **FAIL** | updateBindings pre-read→commit无 await/injection |
| 不改产品代码的 spike 可仅靠 public seams完成完整矩阵 | **FAIL** | scheduler只提供一侧 barrier；CLI一侧无 barrier |
| 真实 operator CLI/status可作为 writer/read assertion面 | **PASS** | smoke实跑；CLI/daemon链路直接证据 |
| 现有 fixture可避免 item/spawn/worktree | **PASS（限定 smoke fixture）** | scheduler disabled、无 item、helper只建普通目录 |
| 当前已有 typed conflict | **FAIL** | store无 revision/CAS；普通 chain CLI error被压成字符串 |
| shell并发启动可替代 barrier | **FAIL** | 无 pre-read完成证据、无确定 commit order |

**最小 tooling gap（只描述验收能力，不设计生产修法）：** 需要一个受支持的 deterministic checkpoint，使测试能观察“metadata writer 已取得其基准版本/快照”并分别 release commit；该 checkpoint必须同时覆盖 operator writer和 keep-active writer，或由两者共同经过的公共 metadata mutation boundary提供。还需要读取明确的 mutation outcome（success含提交版本/结果，或结构化 conflict）供 CLI断言。没有这些，完整 harness只能依赖 private monkey patch、时序猜测或直接 store replacement，均不满足需求。

## F. 后续 spike issue 必须具备的 checkpoint

若后续专门 issue 建 harness，其验收边界至少必须逐项钉住：

1. 固定独立 loop-data/SQLite；scheduler不 spawn runner；不创建 item；不调用任何 git/worktree helper。
2. writer闭集明确为 operator runner-model mutation与 scheduler keep-active metadata mutation；setup只 seed chain/必要的纯状态。
3. barrier必须有两个独立的 `pre-read reached` acknowledgement；在两者都 ack 前禁止任一 commit。
4. controller能逐一 release并观察 commit ack，分别运行 A→B 与 B→A；禁止 sleep、shell并发和轮询概率替代。
5. 每轮使用真实 `bun src/loop.ts chain set-runner-model ... --json` 作为 operator入口，并用真实 `chain status ... --json` 读取最终 metadata。
6. 不相交字段：两种顺序都保留双方值。
7. 同一字段：两种顺序都断言 RFC最终规定的确定结果，或断言稳定、机器可解析的 typed conflict code/details；不能只匹配自由文本。
8. 单 writer：首次成功、同值幂等、重启后读取仍一致。
9. setup/run/assert/teardown命令可原样复制；teardown即使 assertion失败也停止隔离 daemon并删除隔离目录。
10. 运行时证据明确报告 daemon socket、两个 pre-read ack、release顺序、每个 mutation outcome、最终 CLI status与“无 worktree created”核对。

这些是 harness checkpoint，不是生产协议选择。revision、CAS、field merge等生产机制仍由对应 RFC/implementation issue裁决。

## G. 尾部核对

- [x] 固定并核实 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- [x] 查清 `set-runner-model` CLI → socket → auth → handler → store → audit完整调用链和所有 await。
- [x] 穷尽可插 barrier seam，并区分 public、private与commit后 seam。
- [x] 核对 smoke fixture setup/teardown，确认该路径不创建worktree、不新增item、不spawn scheduler。
- [x] 核对 CLI success/error/status结构。
- [x] 审计 runtime metadata writer闭集。
- [x] 判断真实 CLI lost-update确定复现边界。
- [x] 提供已实跑的原样命令；明确完整 harness当前无诚实原样命令。
- [x] 未修改产品代码、测试、配置、WORKFLOW或其他报告；未启动中央 daemon；未创建任何 git worktree；未做 GitHub 操作。

## H. 第四轮补充核实：fixture、CLI 原始证据与外层可验证性

### H1. 隔离 fixture 的真实 DB、表名与只读 item-count

路径解析事实源是 `src/runtime-paths.ts:12`：loop-data root 下的 DB 固定名为 `db.sqlite`。因此若 harness 的隔离根为 `$FIXTURE_ROOT`，数据库固定为：

```text
$FIXTURE_ROOT/loop-data/db.sqlite
```

当前 schema 的相关表名是 `chains` 与 `items`；本次无 item 隔离实验实际 DB 为 `/tmp/r12-cli-evidence/loop-data/db.sqlite`，只读查询观察到 `items.count=0`，chain row 的 metadata 同时保留 `codex` 和 `opencode`。

固定、不会迁移或写入 DB 的 item-count 命令应直接用 Bun SQLite readonly mode，而不是启动 coder-loop：

```bash
DB="$FIXTURE_ROOT/loop-data/db.sqlite"
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { readonly: true });
  const row = db.query("SELECT COUNT(*) AS count FROM items").get();
  console.log(JSON.stringify(row));
  db.close();
' "$DB"
```

机器断言版本：

```bash
DB="$FIXTURE_ROOT/loop-data/db.sqlite"
test "$(bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1], { readonly: true });
  const row = db.query("SELECT COUNT(*) AS count FROM items").get();
  process.stdout.write(String(row.count));
  db.close();
' "$DB")" = 0
```

这条命令只打开 readonly connection；不会创建 schema、WAL、item或worktree。前提是 setup 已经创建 DB/schema，否则应失败而不是隐式初始化。

### H2. runner-model CLI 成功的原始 stdout/stderr/status

本次用 scheduler disabled、无 item 的隔离 daemon 实跑两次真实 CLI。第一笔：

```json
{
  "status": 0,
  "stderr": "",
  "stdout": {
    "chain": {
      "name": "r12-chain",
      "metadata": { "codex": { "model": "codex-m1" } }
    },
    "alreadyMatched": false,
    "updatedKinds": ["codex"]
  }
}
```

第二笔写不相交 kind 后：

```json
{
  "status": 0,
  "stderr": "",
  "stdout": {
    "chain": {
      "name": "r12-chain",
      "metadata": {
        "codex": { "model": "codex-m1" },
        "opencode": { "model": "open-m1" }
      }
    },
    "alreadyMatched": false,
    "updatedKinds": ["opencode"]
  }
}
```

随后真实 `chain status --json` 的稳定机器路径是：

- `.chain.name == "r12-chain"`
- `.chain.metadata.codex.model == "codex-m1"`
- `.chain.metadata.opencode.model == "open-m1"`
- `.summary.items.total == 0`
- `.items == []`
- `.activeRuns == []`

writer success response本身可断言：进程 exit status `0`、stderr精确为空、JSON `.chain.metadata.<kind>.model`、`.alreadyMatched`、`.updatedKinds`。`kind` 不作为独立顶层字段回显；它只能由 `.updatedKinds[0]` 与 `.chain.metadata.<kind>.model` 联合确定。model也不作为顶层字段回显。不能编造 `.kind` / `.model` 路径。

可复制的断言形状（假设 stdout分别落 `$OUT1`、`$OUT2`、`$STATUS`）：

```bash
bun -e '
  import { readFileSync } from "node:fs";
  const w1=JSON.parse(readFileSync(process.argv[1],"utf8"));
  const w2=JSON.parse(readFileSync(process.argv[2],"utf8"));
  const st=JSON.parse(readFileSync(process.argv[3],"utf8"));
  if (w1.chain.metadata.codex.model!=="codex-m1") process.exit(1);
  if (JSON.stringify(w1.updatedKinds)!==JSON.stringify(["codex"])) process.exit(2);
  if (w2.chain.metadata.opencode.model!=="open-m1") process.exit(3);
  if (st.chain.metadata.codex.model!=="codex-m1") process.exit(4);
  if (st.chain.metadata.opencode.model!=="open-m1") process.exit(5);
  if (st.summary.items.total!==0 || st.items.length!==0 || st.activeRuns.length!==0) process.exit(6);
' "$OUT1" "$OUT2" "$STATUS"
```

### H3. 是否存在不受未来 `run.sh` 控制的 keep-active barrier 证据

**不存在。** 逐项核实如下：

| 外层候选证据 | 能证明什么 | 不能证明什么 |
|---|---|---|
| scheduler `chain.complete_trigger` event | callback已经返回的 decision；event位于 callback await 之后、metadata persist之前（`scheduler.ts:2764-2777`） | callback曾在 pre-read barrier停住；release前另一个writer已pre-read；两个ack同时成立 |
| DB `chains.metadata.coderLoopChainCompleteTrigger` | keep-active persist最终执行并曾提交 | 使用的确为barrier前snapshot；barrier时序；随后覆盖是否来自指定writer |
| daemon `chain.layout` audit | operator binding commit后到达audit路径 | operator writer何时完成pre-read；其 commit与另一writer的精确release关系 |
| runner/trigger子进程 exec日志 | 某进程被启动/输出了自报消息 | 自报消息与daemon内部pre-read checkpoint同一时刻；自报无法排除伪造/提前写 |
| 当前 test helper callback | 测试内 Promise可以暂停 scheduler trigger | 证据完全由同一未来 test/run脚本控制；无独立固定hook或daemon counter供外层验证 |
| SQLite readonly final query | 最终 metadata、item count | 中间 barrier状态和commit顺序 |

现有 scheduler event 的可执行观察命令最多是：

```bash
bun src/loop.ts logs "$FIXTURE_ROOT" \
  --loop-data-root "$FIXTURE_ROOT/loop-data" \
  --json --type chain.complete_trigger
```

它只能在 trigger callback返回后看到 decision；不能作为“barrier已到达但尚未release”的外层证明。DB最终状态可用：

```bash
bun -e '
  import { Database } from "bun:sqlite";
  const db=new Database(process.argv[1],{readonly:true});
  console.log(JSON.stringify(db.query("SELECT metadata FROM chains WHERE name=$name").get({name:"r12-chain"})));
  db.close();
' "$FIXTURE_ROOT/loop-data/db.sqlite"
```

它同样只证明最终态。

所以第四轮提出的“由不受未来 run.sh控制的外层证据独立证明真实 keep-active writer与barrier”在现有能力下**不可执行验收**。要保持“不改产品代码”的本 spike边界，验收必须弱化为：

1. 静态设计证据：精确引用真实 scheduler 调用链，证明 callback位于 snapshot read与persist之间；
2. test内控制证据：结构化输出两个ack/release/commit记录，但明确它是 harness自证，不称外层独立证明；
3. 外层独立证据仅核实可核实部分：真实 CLI exit/stdout/stderr、最终 `chain status`、readonly DB item count、最终 DB metadata、daemon正常teardown；
4. 不把 event/DB最终字段升级为barrier时序证明。

如果验收必须保留“外层独立证明 barrier真实发生”，则本 spike不是缺少更聪明的 shell，而是缺少产品或固定 test-only instrumentation；在禁止修改代码的前提下应判 **assumption FAIL / 不可完成**，不能写一个貌似可运行的 `run.sh` 代替。

### H4. `fixture-path.txt` 的生成责任与是否可取消

**可以且应直接取消。** 最清晰的契约是由外层 controller 固定创建根路径并作为参数传入 setup/run/assert/teardown；所有命令共同使用同一个 shell变量：

```bash
FIXTURE_ROOT="$(mktemp -d /tmp/coder-loop-r12.XXXXXX)"
export FIXTURE_ROOT
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
bun /path/to/harness.ts --fixture-root "$FIXTURE_ROOT"
```

这样 DB路径可由固定规则直接推导为 `$FIXTURE_ROOT/loop-data/db.sqlite`，无需一个可能由 `run.sh` 自己伪造、写迟或指向错误目录的 `fixture-path.txt`。

若后续执行框架强制每个 checkpoint运行在全新 shell，确实需要文件交接，则生成责任必须属于**外层 setup/controller**，而不是受测的 `run.sh`：setup先创建root，以原子写固定绝对路径；run只读且拒绝覆盖；assert重新解析并校验路径位于允许的隔离前缀。示例：

```bash
CONTROL_DIR="$(mktemp -d /tmp/coder-loop-r12-control.XXXXXX)"
FIXTURE_ROOT="$(mktemp -d /tmp/coder-loop-r12-fixture.XXXXXX)"
printf '%s\n' "$FIXTURE_ROOT" > "$CONTROL_DIR/fixture-path.txt.tmp"
mv "$CONTROL_DIR/fixture-path.txt.tmp" "$CONTROL_DIR/fixture-path.txt"
```

但只要同一 orchestration shell可持有环境变量，path file没有增加证据强度，应删除而非规定“由谁生成”。

### H5. 补充实验清理核对

补充实验使用 `/tmp/r12-cli-evidence`、scheduler disabled、单个无 item chain；未调用任何 item API、runner或worktree helper。观察：两次writer和status均 exit `0`、stderr空；readonly `SELECT COUNT(*) FROM items` 为 `0`。隔离 daemon已在 `finally` 中停止。未创建git worktree，未触碰中央daemon。
