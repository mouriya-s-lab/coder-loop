# RFC #548 · RR request scope 与安全 fixture follow-up

## A. 主 agent 摘要（≤1 页）

### 结论

固定事实源为 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。R12 的三个剩余阻断都有确定修法，不需要实现产品代码，也不需要缩窄 D7。

1. **D7 的量词是全部可关联 engine request，不是草案列出的十个 operator mutation。** 当前生产 dispatcher 有 **21 个已知 command variants**：6 个读取、15 个 mutation/stateful request；其中 8 个 operator-only、13 个 operator 与 agent 均可到达（权限条件不同），严格 agent-only 为 0。除此之外，合法稳定 identity + unknown command 是一个可关联 rejected 类，也必须有 record。合法 identity + 已知 command 但坏 args 属于相应 variant 的 rejected 路径。malformed JSON、缺失/非法 id、以及在 identity 提取前被 size gate 拒绝的输入才在量词外。D7 没有允许排除 read、agent-oriented request、ephemeral context request 或 `daemon.down`。
2. **不要增加 `request coverage --command ... => true` 自证接口。** 生产 dispatcher registry 必须成为单一执行源；静态上用真正的 union/registry 双向 equality 阻止漏项，runtime 上从实际执行 registry 取得 keys，与 issue 明列的期望全集作双向 equality，并逐个通过真实 socket 请求后按 request identity 查询 record。当前 `DAEMON_COMMAND_NAMES` 所谓“双向”检查实际只证明 tuple 无 extra，不能证明 union 无 missing（`src/daemon.ts:5755-5762`）。
3. **完全隔离且零 runner 的 fixture 可行。** 使用 `/tmp/rfc548-rr-scope-*` 下新建的本地 git repo作为 `--repo-cwd`，chain repository identity 使用合法 `owner/repo` 字符串；以 production `startCoderLoopDaemon({scheduler:{enabled:false}})` 启动真实 Unix-socket daemon，再由真实 `bun src/loop.ts ...` CLI 驱动。最小实验确认 active chain + continuable item 在 1 秒后仍为 `runs=0`、slot directory 数为 0，并可由真实 `item update` 改为 `done`。这没有启动 runner、scheduler tick 或 worktree。
4. **并发 duplicate 必须使用 fresh `RACE_ITEM`。** 先断言不存在，再以两个不同 request identities、相同完整 add args并发提交，期望恰为 `created + already-existing`；随后用其中一个原 identity和完全相同 args重放，仍只有一行。setup 的 seed `ITEM`只用于 changed，不参与 race。

草案应修改 setup、checkpoint 10、checkpoint 13及随之变化的对抗检查编号；不需要改 RR 的单 issue边界。

---

## B. 完整 request 集合与 D7 量词

### B1. 权威入口

- closed command union：`src/daemon.ts:161-205`。
- 实际 handler/auth registry：`src/daemon.ts:1725-1765`。
- 所有已知 command 都经 `narrowDaemonCommandName → commandSpecs → authorization gate → handler`：`src/daemon.ts:1920-1931`。
- 当前 wire parser 在完整 `id/command/args` 都解析成功后才返回 request：`src/daemon.ts:4978-4983`；`responseForLine` 在此之后才保存 id：`src/daemon.ts:1706-1722`。
- public client 当前随机生成 identity：`src/daemon.ts:4692-4694`，因此 RR 仍须补显式稳定 identity传递。
- 当前 tuple registry：`src/daemon.ts:5731-5753`。

### B2. 精确集合（21）

“operator/agent”描述的是当前 dispatcher admission可达性，不把面向 agent 的命令误称为严格 agent-only。

| 类别 | 数量 | 精确 variants | 当前 admission | RR 含义 |
|---|---:|---|---|---|
| 普通 read | 5 | `chain.list`, `chain.status`, `item.list`, `item.exits`, `daemon.status` | `read-no-auth`，operator与agent均可达 | 都是稳定 read verdict；`item.exits`虽面向agent但不是agent-only |
| operator-only read | 1 | `logs.query` | `hard-deny-for-agent` | operator成功read与agent rejected都可关联 |
| operator-only mutation/state | 7 | `chain.create`, `chain.stop`, `chain.resume`, `chain.delete`, `chain.updateBindings`, `daemon.down`, `queue.unblock` | `hard-deny-for-agent` | success/no-op/rejected都记录；`daemon.down`是进程状态请求，不能因非SQLite业务row而排除 |
| operator + admitted-agent mutation | 4 | `item.add`, `item.batchAdd`, `item.update`, `item.exitAction` | `mutation-credential-gated` | operator或credential-bound agent主体均来自admission；deny也记录 |
| operator + phase-authorized agent mutation | 1 | `item.reorder` | `per-phase-authorized` | operator允许；agent依preset phase right允许或拒绝 |
| operator + admitted-agent stateful context | 3 | `context.append.begin`, `context.append.chunk`, `context.append.commit` | `mutation-credential-gated` | begin/chunk虽先改daemon内存session而非SQLite，仍是可关联engine request；commit落持久context |

交叉计数：

- read = 6；mutation/stateful = 15；总计 = **21**。
- operator-only = 8（7 mutation/state + `logs.query`）。
- operator 与 agent 均可到达 = 13（5 read + 4 item mutation + reorder + 3 context）。
- 严格 agent-only = **0**。`item.exits`与`item.exitAction`是 agent-oriented，不是当前权限模型中的 agent-only。

### B3. registry之外的可关联 rejection

D7 的“逐请求”应稳定解释为：**只要 wire 上存在可验证的稳定 request identity，就必须得到唯一 durable typed record，不论该请求最终是已知 command success/no-op，还是业务/权限/shape rejection。**

- 合法 id + unknown command：在 `handleRequest` 的 narrow 失败（`src/daemon.ts:1920-1924`），必须记录 typed `rejected/unknown_command`；它不是第22个已知 command，但属于可关联 request空间。
- 合法 id + 已知 command + handler args错误：归入该已知 variant 的 rejected路径。
- 合法 id + command/args envelope type错误：RR必须把 identity提取提前到业务 envelope判定之前，形成可查 rejected；这是 seam既定要求。
- malformed JSON、缺 id、id本身非法：没有稳定关联键，零 record。
- `validateRequestLineSize` 当前早于 parse（`src/daemon.ts:1709-1711`）；超限输入在 identity可验证前被拒绝，仍属pre-identity。不能从任意超限字节串猜 id。

因此草案 `rolling-resplit-next-batch.md:34,39,67` 对 read/agent-only 的自行排除必须删除。若将来真要缩窄量词，需要新的 operator裁决；D7现文没有该授权。

### B4. 真正双向、不可自报的穷尽 gate

建议把以下三层同时写进 issue，不新增公共 `request coverage` 产品命令：

1. **生产单一执行 registry。** dispatcher查找、auth分类与RR wrapper都从同一个 `Record<DaemonCommandName, Spec>` 取得；RR不是每个handler自选的布尔字段。`handleRequest`在 narrow成功后统一进入 record/replay wrapper，再由wrapper调用registry handler。这样新增registry command天然进入RR，不能靠实现者漏写 `durableVerdict: true`。
2. **真正的编译期双向 equality。** 对 `type RegistryName = keyof typeof DAEMON_COMMAND_SPECS` 使用 `Exclude<DaemonCommandName, RegistryName>` 与 `Exclude<RegistryName, DaemonCommandName>` 两个 `never` assertion，或标准 `Equal<DaemonCommandName, RegistryName>` assertion。当前 `readonly DaemonCommandName[] = DAEMON_COMMAND_NAMES`只检查每个tuple成员属于union，**不会**在tuple漏掉一个union member时失败；`:5760`只检查字面量 `chain.create`在tuple中，也不是反向覆盖证明。
3. **runtime直接验证生产registry，而非询问coverage布尔值。** test/helper可以import实际生产registry的只读 command names（或从同一registry构造dispatcher后取得keys），排序后与测试中独立写死的上述21项作 `actual ⊆ expected` 与 `expected ⊆ actual` 双向比较；然后对每个actual variant通过真实socket发送至少一个稳定identity请求，并用公共 `request get`确认record。需要fixture前置的命令可接受 typed rejected，但不能缺record。另单列unknown command与pre-identity malformed边界。生产 registry keys是实际执行面，不是“我已覆盖”的自报值。

最小静态形状示意（只作为issue文字，不预选handler实现）：

```ts
type RegistryName = keyof typeof DAEMON_COMMAND_SPECS
type AssertNever<T extends never> = T
type MissingFromRegistry = AssertNever<Exclude<DaemonCommandName, RegistryName>>
type ExtraInRegistry = AssertNever<Exclude<RegistryName, DaemonCommandName>>
```

runtime equality必须比较完整集合，不能只循环期望十项；否则实现漏掉第11项仍会绿。

---

## C. 完全隔离、零调度 fixture

### C1. 为什么 stopped-chain方案本身不够

固定main的 `item.add`拒绝非active chain。实测先stop再add返回：

```text
chain_not_active: item.add cannot mutate non-active chain rr-safe with status stopped
```

而先在active chain add再stop存在scheduler抢跑窗口。因此“stopped chain + continuable item”只有在直接改DB时才能预置，不适合本文要求的真实CLI fixture。

### C2. 可用方案

`startCoderLoopDaemon`公开接受 `scheduler.enabled?: boolean`（入口 `src/daemon.ts:4648-4650`；option与判定在 `src/daemon.ts:303-307,3609`）。验收launcher只选择已有production option，不注入handler状态、不fake runner、不改产品：

```sh
export SOURCE_ROOT="$(git rev-parse --show-toplevel)"
export LOOP_DATA_ROOT="$(mktemp -d /tmp/rfc548-rr-scope-data.XXXXXX)"
export FIXTURE_REPO="$(mktemp -d /tmp/rfc548-rr-scope-repo.XXXXXX)"
export REPO="fixture/main"
export OTHER_REPO="fixture/other"
export CHAIN="rr-chain"
export ITEM="rr-item"
export RACE_ITEM="rr-race-item"
export VALID_NEXT_STATUS="done"
export RR_SOCKET="$LOOP_DATA_ROOT/daemon.sock"
export DB="$LOOP_DATA_ROOT/db.sqlite"

git -C "$FIXTURE_REPO" init -q
git -C "$FIXTURE_REPO" config user.email fixture@example.invalid
git -C "$FIXTURE_REPO" config user.name fixture
printf 'rr fixture\n' >"$FIXTURE_REPO/README.md"
git -C "$FIXTURE_REPO" add README.md
git -C "$FIXTURE_REPO" commit -qm init

rr_cli() { bun "$SOURCE_ROOT/src/loop.ts" "$@"; }
start_rr_daemon() {
  LOOP_DATA_ROOT="$LOOP_DATA_ROOT" bun --cwd "$SOURCE_ROOT" --eval '
    import { startCoderLoopDaemon } from "./src/daemon.ts";
    await startCoderLoopDaemon({
      loopDataRoot: process.env.LOOP_DATA_ROOT,
      scheduler: { enabled: false },
    });
  ' >"$LOOP_DATA_ROOT/fixture-daemon.log" 2>&1 &
  export RR_DAEMON_LAUNCH_PID=$!
  end=$((SECONDS+10))
  until test -S "$RR_SOCKET"; do
    test "$SECONDS" -lt "$end"
    sleep .1
  done
  rr_cli daemon status --loop-data-root "$LOOP_DATA_ROOT" >/dev/null
}
cleanup() {
  rr_cli daemon down --loop-data-root "$LOOP_DATA_ROOT" >/dev/null 2>&1 || true
  test -z "${RR_DAEMON_LAUNCH_PID:-}" || wait "$RR_DAEMON_LAUNCH_PID" 2>/dev/null || true
  sqlite3 "$DB" 'DROP TRIGGER IF EXISTS rr_abort' >/dev/null 2>&1 || true
  rm -f /tmp/rr-*.json /tmp/rr-*.jsonl /tmp/rr-*.out
  rm -rf "$LOOP_DATA_ROOT" "$FIXTURE_REPO"
}
trap cleanup EXIT INT TERM

start_rr_daemon
rr_cli chain create "$CHAIN" \
  --preset single-phase-example \
  --config-json "$(jq -nc --arg r "$REPO" '{repository:$r}')" \
  --loop-data-root "$LOOP_DATA_ROOT"
rr_cli item add "$CHAIN" \
  --issue "$ITEM" \
  --repo-cwd "$FIXTURE_REPO" \
  --preset single-phase-example \
  --loop-data-root "$LOOP_DATA_ROOT"
```

注意：固定main的 `chain create`没有 `--repository` option，实际入口是 `--config-json`；repository字段要求 `owner/repo`格式，不能传本地路径。业务checkout路径由 `item add --repo-cwd "$FIXTURE_REPO"`提供。item命令的第一个参数是chain name，不能用草案的 `TARGET="$PWD"`。

checkpoint 8重启也必须重新调用 `start_rr_daemon`，不能改回默认scheduler-enabled的 `daemon up`。

### C3. 已运行的最小实验

在固定main源码上实际执行上述launcher与真实CLI，建立local git fixture、active `single-phase-example` chain和continuable item；等待1秒后观察：

```text
runs=0
slotdirs=0
{"itemId":"seed","status":"done"}
cleaned
```

- `runs=0`来自隔离 `db.sqlite` 的 `select count(*) from runs`。
- `slotdirs=0`来自隔离data root扫描。
- 最后一条item JSON来自真实 `item update --status done` 后的 `item list`。
- 没有替换runner binary，没有创建worktree，没有scheduler tick；daemon与CLI均为production入口。
- 实验所用 `/tmp/rfc548-rr-scope-*` repo、data root及辅助文件均已清理；复查无残留。

这比active chain后抢时间stop更强，也比直接向SQLite塞fixture row更接近真实用户路径。

---

## D. fresh concurrent duplicate checkpoint

setup中保留 `ITEM=rr-item`给changed checkpoint，新增从未add过的 `RACE_ITEM=rr-race-item`。两条并发请求必须具有完全相同的work identity与payload，只让request identity不同：

```sh
test "$(rr_cli item list "$CHAIN" --loop-data-root "$LOOP_DATA_ROOT" --json \
  | jq --arg id "$RACE_ITEM" '[.items[]|select(.itemId==$id)]|length')" -eq 0

rr_cli item add "$CHAIN" \
  --issue "$RACE_ITEM" --repo-cwd "$FIXTURE_REPO" --preset single-phase-example \
  --request-id rr-race-a --loop-data-root "$LOOP_DATA_ROOT" --json >/tmp/rr-race-a-reply.json &
pid_a=$!
rr_cli item add "$CHAIN" \
  --issue "$RACE_ITEM" --repo-cwd "$FIXTURE_REPO" --preset single-phase-example \
  --request-id rr-race-b --loop-data-root "$LOOP_DATA_ROOT" --json >/tmp/rr-race-b-reply.json &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

rr_cli request get "$CHAIN" --request-id rr-race-a --json >/tmp/rr-race-a.json
rr_cli request get "$CHAIN" --request-id rr-race-b --json >/tmp/rr-race-b.json
jq -s -e 'map(.verdict)|sort==["already-existing","created"]' \
  /tmp/rr-race-a.json /tmp/rr-race-b.json

rr_cli item add "$CHAIN" \
  --issue "$RACE_ITEM" --repo-cwd "$FIXTURE_REPO" --preset single-phase-example \
  --request-id rr-race-a --loop-data-root "$LOOP_DATA_ROOT" --json >/dev/null
rr_cli item list "$CHAIN" --loop-data-root "$LOOP_DATA_ROOT" --json \
  | jq -e --arg id "$RACE_ITEM" '[.items[]|select(.itemId==$id)]|length==1'
```

预期：一个record为`created`，另一个为`already-existing`；重放`rr-race-a`不重新执行；最终只有一个`.itemId == RACE_ITEM`的row。不能把setup已经创建的`ITEM`用于此checkpoint，否则两者只能是already-existing。

---

## E. 对 draft 的精确修订建议（不在本报告中改 draft）

1. `rolling-resplit-next-batch.md:34,39,67`：把“operator recordable mutation”“read-only/agent-only不在范围”替换为“全部可关联engine request”；列出B2的21项、unknown-command可关联类与pre-identity例外。
2. `:76-101`：以C2 setup整体替换。特别删除`TARGET="$PWD"`、`REPO="$PWD"`、`OTHER_REPO="$PWD/.git"`；增加独立local git fixture、合法repository identities、固定源码CLI函数与scheduler-disabled production daemon launcher。
3. 全部item命令用`"$CHAIN"`作为位置参数，并显式传`--repo-cwd "$FIXTURE_REPO" --preset single-phase-example`给add。request query若设计确实以chain为target，也使用`"$CHAIN"`；不要让`TARGET`同时承担cwd和chain两种语义。
4. `:129-131,134,136,138`的`chain create --repository`改为固定main存在的`--config-json`形态，除非RR issue明确把新增`--repository` alias列为交付（当前没有）。conflict使用`REPO=fixture/main`与`OTHER_REPO=fixture/other`，两者都是合法repository identity，确保命中conflict而非参数validation。
5. `:132` changed checkpoint继续使用seed `ITEM`；字段断言按当前公共JSON使用`.itemId`，不是`.id`。
6. `:135` restart改为`daemon down`后调用同一个`start_rr_daemon`，继续保持scheduler disabled。
7. `:137` checkpoint 10由D节命令整体替换，使用fresh `RACE_ITEM`并在并发前断言零row。
8. `:140`删除公共`request coverage`命令。替换为B4的静态双向equality + runtime生产registry key双向equality + 对每个actual variant真实发请求并query record；期望全集必须独立写死为21项，unknown/pre-identity另测。
9. `:154-160`同步checkpoint编号与描述；reply-loss=7、restart=8、rollback=9、concurrent duplicate=10、collision=11、scope isolation=12、registry completeness=13。
10. 保留`:145`逐字real-e2e结论；本follow-up没有理由扩大到#685 compatibility gate。

---

## F. 完成核对

- [x] 固定并核对 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- [x] 读取当前R12 review、RR draft、runtime seam与operator D7。
- [x] 从真实union、tuple、dispatcher与auth registry枚举全部21项并完成read/mutation/operator/agent分类。
- [x] 明确D7覆盖量词、unknown-command类和pre-identity例外，未擅自排除read或agent-oriented请求。
- [x] 给出不依赖产品自报布尔值的静态/runtime双向registry gate。
- [x] 用真实production daemon/socket/CLI运行scheduler-disabled隔离fixture实验；确认0 run、0 slot/worktree、真实item update成功。
- [x] 给出fresh concurrent identity的可复现命令与精确预期。
- [x] 未修改draft、产品源码、测试、config、`WORKFLOW.md`、issue或worktree。
- [x] 唯一仓内写入为本报告。
- [x] `/tmp/rfc548-rr-scope-*`全部清理，复查无残留。

