# RFC #548 · RR variant / admission runtime fixture 精确调查

## A. 主 agent 摘要（≤1 页）

固定事实源为 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。第五轮 review 的三个缺口均可用现有 production seam 闭合，不需要产品 test hook。

1. 21 个 command 都有独立的、通过 envelope parse 与 authorization 并进入其 handler 的 fixture args。2026-07-31 的 scheduler-disabled 真 socket实验得到 18 个 success、`item.exitAction` 与 `queue.unblock` 两个 handler 内 rejection、`daemon.down` 独立最后执行；不是统一 `args:[]`。实验结束时 `runs=0`、`slot_children=0`。
2. operator 与无 credential agent-shaped caller可在 scheduler-disabled fixture直接覆盖；**有效、wrong-item、cross-item/cross-chain、phase allow/deny、expired credential不能在 scheduler-disabled fixture伪造**。credential只由 scheduler在真实 spawn前 mint、注入 runner env并在run close revoke（`src/scheduler.ts:1687-1698`; `src/daemon.ts:4381-4395`）。最小安全 production fixture是启用scheduler、用现有 deterministic runner PATH shim捕获credential并在run存活期从runner进程发真socket请求；结束后复用捕获值测expired。现成样板在`tests/integration/daemon/admission.integration.ts:112-122,564-575,1274-1277`，不是新增产品hook。
3. checkpoint 6/8/12应由一个固定 driver按1→13顺序执行；若仍保留逐行表格，则每行必须显式列`requires`。本报告给出声明表，消除隐式依赖。
4. 所有artifact使用单次UUID目录；cleanup只删除自己的目录。slot与runs断言必须在daemon down与prune之前观察，且slot扫描不能`-prune`掉待观察子树。

## B. 21 variants 的可复制 driver 数据

### B1. 公共 setup 与 socket driver

```sh
SOURCE_ROOT=/Users/mouriya/Ext/code/coder-loop
FIXTURE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ARTIFACT_DIR="/tmp/rfc548-rr-variant-$FIXTURE_ID"
LOOP_DATA_ROOT="$ARTIFACT_DIR/data"
FIXTURE_REPO="$ARTIFACT_DIR/repo"
RR_SOCKET="$LOOP_DATA_ROOT/daemon.sock"
mkdir -p "$LOOP_DATA_ROOT" "$FIXTURE_REPO"
git -C "$FIXTURE_REPO" init -q
git -C "$FIXTURE_REPO" config user.email fixture@example.invalid
git -C "$FIXTURE_REPO" config user.name fixture
printf 'fixture\n' >"$FIXTURE_REPO/README.md"
git -C "$FIXTURE_REPO" add README.md
git -C "$FIXTURE_REPO" commit -qm init

cat >"$ARTIFACT_DIR/send.ts" <<'TS'
import { connect } from "node:net"
const [socketPath, id, command, argsJson] = process.argv.slice(2)
const socket = connect(socketPath)
let output = ""
socket.on("connect", () => socket.write(JSON.stringify({ id, command, args: JSON.parse(argsJson) }) + "\n"))
socket.on("data", chunk => { output += chunk; if (output.includes("\n")) { console.log(output.trim()); socket.end() } })
await new Promise((resolve, reject) => { socket.on("close", resolve); socket.on("error", reject) })
TS
send() { bun "$ARTIFACT_DIR/send.ts" "$RR_SOCKET" "$1" "$2" "$3"; }

LOOP_DATA_ROOT="$LOOP_DATA_ROOT" bun --cwd "$SOURCE_ROOT" --eval '
  import { startCoderLoopDaemon } from "./src/daemon.ts"
  await startCoderLoopDaemon({loopDataRoot:process.env.LOOP_DATA_ROOT,scheduler:{enabled:false}})
' >"$ARTIFACT_DIR/daemon.log" 2>&1 &
RR_DAEMON_PID=$!
deadline=$((SECONDS+10)); until test -S "$RR_SOCKET"; do test "$SECONDS" -lt "$deadline"; sleep .1; done
```

生产集合与分类来自closed union `src/daemon.ts:161-205`及实际registry `src/daemon.ts:1725-1765`。以下`args`可直接作为driver JSON；每项都越过parse/auth并进入对应handler。

| command | args（shell展开后的JSON） | 当前路径 | RR record预期 |
|---|---|---|---|
| `chain.create` | `{"name":"rr-main","preset":"single-phase-example","repository":"fixture/main"}` | mutation | `created`；chain可查 |
| `chain.list` | `{}` | read | `read` |
| `chain.status` | `{"name":"rr-main"}` | read | `read` |
| `chain.stop` | `{"name":"rr-main"}` | mutation | `changed` |
| `chain.resume` | `{"name":"rr-main"}` | mutation | `changed` |
| `chain.delete` | `{"name":"rr-delete"}`（先独立create） | mutation | `changed` |
| `chain.updateBindings` | `{"name":"rr-main","patch":{}}` | no-op | `no-op`；`alreadyMatched=true` |
| `item.add` | `{"chainName":"rr-main","itemId":"seed","repoCwd":"$FIXTURE_REPO","preset":"single-phase-example"}` | mutation | `created` |
| `item.batchAdd` | `{"chainName":"rr-main","items":[{"itemId":"batch","repoCwd":"$FIXTURE_REPO","preset":"single-phase-example"}]}` | mutation | `created` |
| `item.list` | `{"chainName":"rr-main"}` | read | `read` |
| `item.update` | `{"chainName":"rr-main","itemId":"seed","fields":{"title":"updated"}}` | mutation | `changed` |
| `item.reorder` | `{"chainName":"rr-main","itemId":"seed","position":0}` | mutation/no-op business result | RR typed stable verdict；handler成功且items可查 |
| `item.exits` | `{"chainName":"rr-main","itemId":"seed","agentRunId":"fixture-run","agentPhase":"run"}` | read | `read` |
| `item.exitAction` | `{"chainName":"rr-main","itemId":"seed","agentRunId":"fixture-run","agentPhase":"missing","action":"stop"}` | domain reject | `rejected/invalid_request`；使用unknown phase保证进入handler且零chain mutation |
| `daemon.status` | `{}` | read | `read` |
| `daemon.down` | `{}`，独立最后一轮 | process-state mutation | `changed`，随后重启同data root查询record |
| `logs.query` | `{}` | read | `read` |
| `queue.unblock` | `{"chainName":"rr-main","issue":"missing","dryRun":true}` | domain reject | `rejected/not_found`，已越过handler参数解析 |
| `context.append.begin` | `{"chainName":"rr-main","scope":{"kind":"chain"}}` | stateful | `created` session；保存`.result.sessionId` |
| `context.append.chunk` | `{"sessionId":"$SESSION_ID","sequence":0,"chunk":"fixture"}` | stateful | `changed` session |
| `context.append.commit` | `{"sessionId":"$SESSION_ID"}` | mutation | `created` context entry |

handler边界证据：chain handlers `src/daemon.ts:2166-2657`；logs/queue `:2678-2795`；item handlers `:2887-3459`；context三步 `:1830-1920`。context真实session shape由`src/context-entry.ts:5-31`限定。

### B2. 实际运行观察

在上述固定SHA、独立repo、scheduler-disabled production daemon和真实Unix socket执行：18个普通成功路径均`ok:true`；`item.exitAction`使用原先`phase:"run"`会越过handler但暴露既有`internal_error`（operator没有stored run identity），所以正式fixture改用`phase:"missing"`，在side effect前得到稳定`invalid_request`；`queue.unblock`得到`not_found`；`daemon.down`最后得到`ok:true`。三步context使用begin返回的真实UUID，chunk与commit均`ok:true`。关闭前SQLite `runs=0`，不带prune的slot子树计数为0。实验专属目录已清理。

这证明args不是shape-parser捷径；尚不能证明未来RR record字段，因为RR产品尚未实现。实现后的每个`send`后必须追加`request get --request-id "$id"`并比较`command/subject/verdict`，不能仅检查socket reply。

## C. D7 admission主体真实fixture

### C1. scheduler-disabled可直接做的主体

| 主体 | 生成/调用 | 预期 |
|---|---|---|
| operator | 完全省略`agentCredential` | subject=`operator`；hard-deny/per-phase/mutation均按operator分支 |
| 无credential的agent-oriented调用 | 仍省略credential，但调用`item.exits`或带`agentRunId/agentPhase`的`item.exitAction` | 不能称为agent主体；admission仍是operator。用于证明“面向agent≠已认证agent” |
| fabricated/wrong-format | `agentCredential:"never-minted-$FIXTURE_ID"` | `unknown-credential`，零mutation；record subject不能信caller自报 |

`resolveItemMutationCaller`明确以字段缺席判operator、以registry lookup判agent（`src/daemon.ts:3953-3978`）；CLI只对命令白名单从`CODER_LOOP_RUN_CRED`自动注入（`src/loop.ts:2490-2541`）。

### C2. 有效、phase、wrong/expired/cross-item必须使用的最小安全production fixture

scheduler-disabled无法mint有效credential；直接调用exported issuer再另起daemon不会命中daemon私有registry。不得虚构注册hook。安全fixture如下：

1. 用独立data/repo与一个可执行item启动**scheduler-enabled production daemon**。
2. PATH最前放UUID目录中的deterministic runner shim。shim继承scheduler真实注入的`CODER_LOOP_RUN_CRED`，把值写入`$ARTIFACT_DIR/credential`并以FIFO/barrier保持run active；production mint/inject点是`src/scheduler.ts:1687-1698`，daemon issuer是`src/daemon.ts:4381-4395`。
3. shim自身（不是operator父进程）调用真实CLI/socket，环境自然带credential。覆盖：
   - bound item + bound phase的`item.update` allow；
   - `gh-issue-pr-iteration` review phase的`item.reorder` allow（grant在`presets/gh-issue-pr-iteration/preset.toml:155-156`）；iteration phase同命令deny；
   - hard-deny `logs.query`或`chain.stop` deny；
   - 同credential改selector到同chain另一item，得到`wrong-item`；改到另一chain item得到cross-chain/invalid-caller；
   - `item.exitAction`的claimed run/phase与binding不同时deny。
4. 释放barrier让run结束并等待credential revoke；再以捕获值发同一mutation，得到`unknown-credential`（expired）。
5. 每个请求使用独立稳定request id并查询record；allow断言业务结果，deny断言目标row未变。

这不是新hook：现有integration已经用同一生产路径捕获env credential（`tests/integration/daemon/admission.integration.ts:112-122,564-575`），也已有双phase capture样板（`:1274-1277`）。正式RR checkpoint应复制其fixture机制而非调用测试内部credential issuer。

## D. checkpoint顺序与自包含前置

采用单一固定driver并声明下面顺序；表格每行的`Command`调用driver子命令，driver拒绝缺失前置。这样“逐行可执行”与共享昂贵fixture兼得。

| checkpoint | 显式前置/本行setup |
|---|---|
| 1 identity boundary | 仅公共daemon |
| 2 created | 本行create `rr-main`、`rr-delete`，add `seed` |
| 3 no-op | requires 2 的`rr-main` |
| 4 rejected | requires 2；使用`fixture/other`并断言原chain |
| 5 changed | requires 2 的`seed` |
| 6 admission/query | requires 2；本行启动C2 agent sub-fixture，不读取checkpoint 2输出文件 |
| 7 reply-loss | 本行create fresh `rr-lost` |
| 8 restart | requires 7 的durable identity；重启后自行query，不依赖临时JSON |
| 9 rollback | 本行安装/移除自己的UUID trigger |
| 10 concurrent duplicate | requires 2 chain；本行先断言fresh `RACE_ITEM`不存在 |
| 11 collision | 本行建立自己的首请求与snapshot |
| 12 scope isolation | requires 2；直接现场查询DB/slot，不读取checkpoint 2 artifact |
| 13 variants | requires 2；context session在本行begin→chunk→commit；`daemon.down`独立最后执行并重启 |

若issue不愿声明顺序，则6/8/12必须各自create专属chain/item；不能继续读取`/tmp/rr-created-record.json`或假设`rr-lost`存在。

## D2. 可直接运行的完整 production admission driver（补充实证）

### 权威源码与唯一 argv

仓库已经存在完整、自包含于本仓测试运行面的driver；不要在issue中再抄一个会漂移的credential fixture。源码是：

```text
tests/integration/daemon/admission.integration.ts
```

它的runner源码由每个case在UUID/进程专属fixture目录内写出，使用production `startCoderLoopDaemon`、production scheduler mint/inject/revoke、真实Unix socket与真实handler；没有注册credential的产品test hook。完整运行命令（注意`./`不可省略，Bun才按文件路径解释）：

```sh
cd /Users/mouriya/Ext/code/coder-loop
bun test ./tests/integration/daemon/admission.integration.ts
```

该文件内可复制的case与行号：

| RR所需主体/结果 | 完整fixture源码 |
|---|---|
| operator allow | `tests/integration/daemon/admission.integration.ts:6-54` |
| wrong/never-minted credential | `:55-102` |
| live credential cross-item deny | `:103-263` |
| live credential own-item allow | `:264-416` |
| run结束后expired deny | `:417-522` |
| natural exit revoke | `:523-555` |
| phase no-rights deny | `:556-682` |
| review phase allow | `:683-836` |
| hard-deny operator-only variants | `:1127-1245` |
| `item.reorder` review allow + iteration deny | `:1246-1431` |

每个live case的runner实际读取scheduler注入的`CODER_LOOP_RUN_CRED`；例如cross-item runner源码与bounded capture在`:112-122`，own-item在`:281-292`，expired在`:432-443`。生产注入仍由`src/scheduler.ts:1687-1698`完成，revoke由`src/daemon.ts:4385-4395`完成。

### 2026-07-31实际执行结果

上述argv在固定SHA实际运行：

```text
17 pass
0 fail
326 expect() calls
Ran 17 tests across 1 file. [6.73s]
```

运行日志实际出现operator allow、`unknown-credential`、`wrong-item`、own-item admitted、expired credential、review/iteration phase allow/deny及hard-deny；全部case带bounded wait（例如cross-item credential capture上限8秒，`:151-160`）。退出后：

```text
test ! -e .coder-loop/runtime/evidence/dt/75874  # true
ps ... | rg '75874'                              # 无daemon/runner
git worktree list | rg '75874'                   # 无fixture worktree
```

### “无credential agent-oriented reject”的实然上限

当前production协议**不存在“无credential但仍被识别为agent”的主体**。`agentCredential`字段缺席被硬编码为operator（`src/daemon.ts:3953-3958`）；`agentRunId/agentPhase`不能升级主体，它们只是`item.exits`/`item.exitAction`的handler参数。因此可以安全验证：

```json
{"id":"nocred","command":"item.exitAction","args":{"chainName":"rr-main","itemId":"seed","agentRunId":"claimed","agentPhase":"missing","action":"stop"}}
```

该请求越过operator admission后在handler内得到`invalid_request`（unknown phase），record主体必须是operator；**不能**把它报告为unauthenticated-agent admission reject。若issue要求该不存在的主体，唯一正确验收是把要求改写为：

- agent-oriented/no credential → operator主体 + handler verdict；
- agent-authenticated → 必须来自scheduler-minted credential；
- fabricated credential → `unknown-credential` deny。

这是当前可实现的最强矩阵，不应为了凑名目伪造caller hook。

## D3. 固定 RR request-record checkpoint inline driver

以下driver是issue中的固定验收输入，不由实现者改写测试来“自己出题”。它只使用production `startCoderLoopDaemon`、production scheduler credential issuer、真实runner child与Unix socket。唯一未来依赖是D7本issue交付的`request.get` command；在RR尚未实现的固定main上应在第一个query得到`unknown_command`，这是预期红灯，而不是语法错误。

唯一argv：

```sh
bash /path/to/rr-admission-driver.sh /Users/mouriya/Ext/code/coder-loop
```

完整`rr-admission-driver.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
SOURCE_ROOT="${1:?source root required}"
FIXTURE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ARTIFACT_DIR="$(mktemp -d "/tmp/rfc548-rr-admission.${FIXTURE_ID}.XXXXXXXX")"
# macOS /tmp -> /private/tmp；runner filesystem grant与实际写路径必须同一canonical spelling。
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
cleanup() {
  if test -d "$ARTIFACT_DIR"; then rm -r "$ARTIFACT_DIR"; fi
}
trap cleanup EXIT INT TERM
mkdir -p "$ARTIFACT_DIR/repo" "$ARTIFACT_DIR/data" "$ARTIFACT_DIR/preset-allow" "$ARTIFACT_DIR/preset-deny"
git -C "$ARTIFACT_DIR/repo" init -q
git -C "$ARTIFACT_DIR/repo" config user.email fixture@example.invalid
git -C "$ARTIFACT_DIR/repo" config user.name fixture
printf 'fixture\n' >"$ARTIFACT_DIR/repo/README.md"
git -C "$ARTIFACT_DIR/repo" add README.md
git -C "$ARTIFACT_DIR/repo" commit -qm init

for MODE in allow deny; do
  PRIVILEGED='[]'; test "$MODE" = allow && PRIVILEGED='["item.reorder"]'
  cat >"$ARTIFACT_DIR/preset-$MODE/preset.toml" <<TOML
name = "rr-$MODE"
[item]
idField = "id"
[statuses]
continuable = ["pending"]
terminal = ["done", "exhausted"]
exhausted = "exhausted"
[[phases]]
name = "run"
runner = "claude"
prompt = "prompt.md"
  [[phases.exits]]
  status = "done"
  when = "fixture complete"
  [phases.rights]
  privilegedOps = $PRIVILEGED
  writableFields = ["title"]
  [phases.variables]
  ITEM_ID = "item.id"
TOML
  printf 'fixture {{ITEM_ID}}\n' >"$ARTIFACT_DIR/preset-$MODE/prompt.md"
done

cat >"$ARTIFACT_DIR/runner.ts" <<'RUNNER'
import { connect } from "node:net"
import { writeFile } from "node:fs/promises"
type Response = { id: string; ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } }
const promptIndex = Bun.argv.indexOf("-p")
const promptText = promptIndex < 0 ? (Bun.argv.at(-1) ?? "") : (Bun.argv[promptIndex + 1] ?? "")
const config = JSON.parse(promptText.split("\n")[0]!) as { socket: string; repo: string; mode: "allow"|"deny"; chain: string; own: string; other: string }
const credential = process.env.CODER_LOOP_RUN_CRED
if (!credential) throw new Error("scheduler did not inject CODER_LOOP_RUN_CRED")
async function request(id: string, command: string, args: Record<string, unknown>): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const socket = connect(config.socket); let output = ""
    socket.on("connect", () => socket.write(JSON.stringify({ id, command, args: { ...args, agentCredential: credential } }) + "\n"))
    socket.on("data", chunk => { output += chunk; if (output.includes("\n")) { socket.end(); resolve(JSON.parse(output.split("\n")[0]!)) } })
    socket.on("error", reject)
  })
}
const responses = [
  await request(`${config.mode}-own`, "item.update", { chainName: config.chain, itemId: config.own, fields: { title: `${config.mode}-own` } }),
  await request(`${config.mode}-reorder`, "item.reorder", { chainName: config.chain, itemId: config.own, position: 1 }),
  await request(`${config.mode}-cross-item`, "item.update", { chainName: config.chain, itemId: config.other, fields: { title: "must-not-write" } }),
  await request(`${config.mode}-hard-deny`, "logs.query", {}),
]
await writeFile(`${config.repo}/${config.mode}.credential`, credential)
await writeFile(`${config.repo}/${config.mode}.responses.json`, JSON.stringify(responses))
await request(`${config.mode}-finish`, "item.update", { chainName: config.chain, itemId: config.own, fields: { status: "done" } })
RUNNER

cat >"$ARTIFACT_DIR/driver.ts" <<'DRIVER'
import { connect } from "node:net"
import { readFile } from "node:fs/promises"
import { startCoderLoopDaemon } from "__SOURCE_ROOT__/src/daemon.ts"
type Response = { id: string; ok: boolean; result?: Record<string, any>; error?: { code: string; message: string; details?: Record<string, any> } }
const root = process.argv[2]!, data = `${root}/data`, repo = `${root}/repo`, runner = `${root}/runner.ts`
async function request(socketPath: string, id: string, command: string, args: Record<string, unknown>): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath); let output = ""
    socket.on("connect", () => socket.write(JSON.stringify({ id, command, args }) + "\n"))
    socket.on("data", chunk => { output += chunk; if (output.includes("\n")) { socket.end(); resolve(JSON.parse(output.split("\n")[0]!)) } })
    socket.on("error", reject)
  })
}
async function bounded(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await Bun.sleep(50) }
  throw new Error(`bounded wait exceeded ${timeoutMs}ms`)
}
function expectCode(response: Response, code: string): void { if (response.ok || response.error?.code !== code) throw new Error(`expected ${code}: ${JSON.stringify(response)}`) }
function expectOk(response: Response): void { if (!response.ok) throw new Error(`expected ok: ${JSON.stringify(response)}`) }
async function record(socketPath: string, requestId: string): Promise<any> {
  const response = await request(socketPath, `query-${requestId}`, "request.get", { requestId })
  expectOk(response); return response.result!.record
}
function expectRecord(value: any, expected: { command: string; subject: "operator"|"agent"; verdict: string; reason: string }): void {
  if (value.requestId === undefined || value.command !== expected.command || value.subject?.kind !== expected.subject || value.verdict?.kind !== expected.verdict || value.admission?.reason !== expected.reason) {
    throw new Error(`record mismatch expected=${JSON.stringify(expected)} actual=${JSON.stringify(value)}`)
  }
}
let daemon = await startCoderLoopDaemon({ loopDataRoot: data, scheduler: { enabled: false } })
try {
  let socketPath = daemon.snapshot().socketPath
  for (const mode of ["allow", "deny"] as const) {
    const presetPath = `${root}/preset-${mode}`
    expectOk(await request(socketPath, `setup-${mode}-chain`, "chain.create", { name: `rr-${mode}`, preset: null, repository: `fixture/${mode}`, metadata: { presetPath } }))
    for (const suffix of ["own", "other"] as const) expectOk(await request(socketPath, `setup-${mode}-${suffix}`, "item.add", { chainName: `rr-${mode}`, itemId: `${mode}-${suffix}`, repoCwd: repo, presetPath }))
    expectOk(await request(socketPath, `setup-${mode}-other-terminal`, "item.update", { chainName: `rr-${mode}`, itemId: `${mode}-other`, fields: { status: "done" } }))
  }
  expectOk(await request(socketPath, "operator-allow", "item.update", { chainName: "rr-allow", itemId: "allow-own", fields: { title: "operator" } }))
  const noCredential = await request(socketPath, "no-credential-agent-oriented", "item.exitAction", { chainName: "rr-allow", itemId: "allow-own", agentRunId: "claimed", agentPhase: "missing", action: "stop" })
  expectCode(noCredential, "invalid_request")
  const unknown = await request(socketPath, "unknown-credential", "item.update", { chainName: "rr-allow", itemId: "allow-own", fields: { title: "forbidden" }, agentCredential: "never-minted" })
  expectCode(unknown, "invalid_caller")
  expectRecord(await record(socketPath, "operator-allow"), { command: "item.update", subject: "operator", verdict: "changed", reason: "operator" })
  expectRecord(await record(socketPath, "no-credential-agent-oriented"), { command: "item.exitAction", subject: "operator", verdict: "rejected", reason: "operator" })
  expectRecord(await record(socketPath, "unknown-credential"), { command: "item.update", subject: "operator", verdict: "rejected", reason: "unknown-credential" })

  await daemon.stop()
  daemon = await startCoderLoopDaemon({ loopDataRoot: data, shutdownGraceMs: 100, scheduler: {
    enabled: true, intervalMs: 20,
    runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [runner], model: null },
    // Existing production SchedulerOptions seam used by admission.integration.ts; credential mint/inject/revoke is NOT replaced.
    worktreeManager: async () => repo,
    prompt: ({ chain, item }) => JSON.stringify({ socket: `${data}/daemon.sock`, repo, mode: chain.name.slice(3), chain: chain.name, own: item.itemId, other: `${chain.name.slice(3)}-other` }),
    chainCompleteTriggerForChain: () => null,
  } })
  socketPath = daemon.snapshot().socketPath
  await bounded(async () => { try { await readFile(`${repo}/allow.responses.json`); await readFile(`${repo}/deny.responses.json`); return true } catch { return false } }, 15_000)
  await bounded(async () => daemon.snapshot().activeRuns.length === 0, 10_000)
  const allowCredential = (await readFile(`${repo}/allow.credential`, "utf8")).trim()
  const expired = await request(socketPath, "expired-credential", "item.update", { chainName: "rr-allow", itemId: "allow-own", fields: { title: "expired" }, agentCredential: allowCredential })
  expectCode(expired, "invalid_caller")
  const checks = [
    ["allow-own", { command:"item.update", subject:"agent", verdict:"changed", reason:"agent-credential-admitted" }],
    ["allow-reorder", { command:"item.reorder", subject:"agent", verdict:"changed", reason:"phase-privileged-op" }],
    ["allow-cross-item", { command:"item.update", subject:"agent", verdict:"rejected", reason:"wrong-item" }],
    ["allow-hard-deny", { command:"logs.query", subject:"agent", verdict:"rejected", reason:"hard-deny-for-agent" }],
    ["deny-own", { command:"item.update", subject:"agent", verdict:"changed", reason:"agent-credential-admitted" }],
    ["deny-reorder", { command:"item.reorder", subject:"agent", verdict:"rejected", reason:"no-privileged-ops" }],
    ["deny-cross-item", { command:"item.update", subject:"agent", verdict:"rejected", reason:"wrong-item" }],
    ["deny-hard-deny", { command:"logs.query", subject:"agent", verdict:"rejected", reason:"hard-deny-for-agent" }],
    ["expired-credential", { command:"item.update", subject:"operator", verdict:"rejected", reason:"unknown-credential" }],
  ] as const
  for (const [id, expected] of checks) expectRecord(await record(socketPath, id), expected)
} finally {
  await daemon.stop().catch(() => {})
}
DRIVER
sed -i '' "s|__SOURCE_ROOT__|$SOURCE_ROOT|g" "$ARTIFACT_DIR/driver.ts"
bun build "$ARTIFACT_DIR/runner.ts" "$ARTIFACT_DIR/driver.ts" --target=bun --outdir "$ARTIFACT_DIR/syntax-check" >/dev/null
bun "$ARTIFACT_DIR/driver.ts" "$ARTIFACT_DIR"
```

注意：`worktreeManager`是当前production `SchedulerOptions`既有 seam（`src/scheduler.ts:353-389`），与现有admission integration相同；它只避免此RFC调查创建真实worktree。credential issuer没有被替换，仍由daemon在`src/daemon.ts:3764-3768`注入production scheduler，并在真实spawn前mint。

当前固定main实跑此inline driver的观察：`bash -n`通过（155行shell）；`bun build`成功；production daemon完成两条chain、四条item、operator/no-credential/unknown-credential请求后，在首个`request.get(operator-allow)`精确失败为`unknown_command`，符合“RR公共query尚未实现”的预期红灯。`finally`停止daemon，shell trap删除UUID目录；复查无对应目录、daemon进程或worktree。实现D7后同一driver会继续进入真实scheduler runner并执行其余矩阵，不允许为了过关改driver期望。

## E. cleanup与prune前断言

```sh
# 必须在 daemon.down / chain.delete / cleanup / prune 之前
test "$(sqlite3 "$LOOP_DATA_ROOT/db.sqlite" 'select count(*) from runs')" -eq 0
test "$(find "$LOOP_DATA_ROOT/chains" -path '*/slots/*' -mindepth 1 -print | wc -l | tr -d ' ')" -eq 0
find "$LOOP_DATA_ROOT/chains" -path '*/slots/*' -mindepth 1 -print >"$ARTIFACT_DIR/slots.before-cleanup"

cleanup() {
  bun "$SOURCE_ROOT/src/loop.ts" daemon down --loop-data-root "$LOOP_DATA_ROOT" >/dev/null 2>&1 || true
  test -z "${RR_DAEMON_PID:-}" || wait "$RR_DAEMON_PID" 2>/dev/null || true
  sqlite3 "$LOOP_DATA_ROOT/db.sqlite" 'DROP TRIGGER IF EXISTS rr_abort' >/dev/null 2>&1 || true
  test ! -d "$ARTIFACT_DIR" || find "$ARTIFACT_DIR" -depth -delete
}
trap cleanup EXIT INT TERM
```

关键点：不使用`/tmp/rr-*`通配；所有输出均在UUID目录；slot扫描不对`slots`本身`-prune`；证据在prune前写入同一artifact目录，driver汇总后才cleanup。

## F. 边界与完成核对

- [x] 固定并核对`main@699842e`。
- [x] 逐项给出21个production registry variant的独立handler-reaching args、类别与未来record预期。
- [x] 真实socket运行scheduler-disabled fixture；观察18 success、两个预期handler rejection、独立daemon down、0 runs/slots。
- [x] 区分operator、agent-oriented但未认证、有效agent、phase allow/deny、wrong/expired/cross-item；未虚构credential hook。
- [x] 给出checkpoint 6/8/12显式前置与固定顺序契约。
- [x] 给出UUID cleanup与prune前slot/runs断言。
- [x] 未设计产品实现，未改draft/源码/测试/WORKFLOW/issue，未创建worktree。
- [x] 唯一仓内写入为本报告；实验`/tmp`目录已清理。
