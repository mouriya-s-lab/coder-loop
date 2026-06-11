# Preset 作者手册

读者：想写一个新 preset（非 `gh-issue-pr-iteration`）或修改现有 preset 的人。

读完后你能：理解 `preset.toml` 全部字段、写出最小可跑 preset、知道变量绑定 DSL 三前缀边界、知道怎么区分 engine-owned `runtime.*` fact 与 preset-declared runtime business key。

不在范围内：`gh-issue-pr-iteration` 内部 fragment 跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）；运行期状态 / trace（看 [operations](./operations.md)）。

---

## 1. 引擎契约（preset 看不到引擎的什么）

`src/loop.ts` 是有限状态机，行为由 preset 驱动。引擎职责：

| 引擎职责 | 说明 |
|---|---|
| **加载 preset** | 从 `<pkg>/presets/<name>/` 或 target 的 `presetPath` 读 `preset.toml`，解析 `name / version / item.idField / statuses / phases / fragments / agent`。每个 fragment 路径必须可读。 |
| **加载 target runtime** | 读 target `.coder-loop/runtime/config.{json,toml}`、`.coder-loop/runtime/shared.md`、`.coder-loop/workflow.md`，并从 centralized SQLite loop-data store 解析 active chain / queue / current。 |
| **选 actionable item** | 若 `state.current` 存在且其 status 在 preset 的 `statuses.continuable` 内，继续它；否则在队列里找首个 `continuable` item。`continuable` 外的所有 item 视为 terminal，引擎不动。 |
| **按 phase 顺序 spawn agent** | 遍历 `preset.phases`：每个 phase 读 entry prompt 模板，按 `[phases.variables]` 表绑定变量替换 `{{KEY}}`，把渲染后的 prompt 传给当前 runner（`claude` 或 `codex`）。捕获 stdout/stderr 写入 `<logDir>/<runId>/<phase>/`，每个 phase spawn 完写 `status.json`。 |
| **resume / 不丢工作** | spawn 中途崩溃，重启时根据 `state.current.phase` 跳到当前 phase 而非从头。 |
| **daemon / chain 控制** | 新版运行期由 centralized daemon socket + chain/item state 控制；target start/stop/restart 通过 daemon API 解析 chain，而不是依赖 target-local sentinel 文件。 |
| **runtime 状态快照** | `coder-loop status <target> --json` 不 spawn agent，读取 preset、target 文件、central chain layout、queue、current、runner 与 process snapshot，供 operator / supervisor 做结构化判断。 |
| **daemon 调度预演** | `coder-loop daemon start <target> --dry-run` 解析 target chain 与 central daemon 需求，但不启动 target run；这是 daemon 子命令自己的预演 flag。 |

引擎**不知道**：phase 数量、phase 名字、status 字面量（`queued / done / pending` 之类）、item id 字段名、已知变量 KEY（`{{REPO}}` / `{{ISSUE}}` 之类）、preset 之间的差异、GitHub。

引擎**不判断**：item 是否完成、PR 是否正确、证据是否充分、parent 是否可关闭、queue 优先级。这些由 preset 的 agent prompt 判断（默认 preset 让 agent 改 GitHub state；其他 preset 可以让 agent 改任何东西）。

---

## 2. 最小可跑 preset

最小示例在 `presets/single-phase-example/`。结构：

```
presets/<preset-name>/
  preset.toml          # 必需
  <phase>-entry.md     # 每个 phase 一个 entry prompt 模板
  [common/, role-x/, ...]   # 可选：fragment 文件，preset.toml 里 [[fragments]] 声明
```

`presets/single-phase-example/preset.toml`：

```toml
name        = "single-phase-example"
version     = 1
description = "Minimal 1-phase preset for engine smoke testing."

[item]
idField = "id"

[statuses]
continuable = ["pending"]
terminal    = ["done"]

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [phases.variables]
  ITEM_ID    = "item.id"
  RUN_ID     = "runtime.runId"
  TARGET_CWD = "runtime.targetCwd"

[agent]
binary                = "echo"
extraArgs             = []
attemptTimeoutSeconds = 3600
```

`presets/single-phase-example/run-entry.md`：

```
hello {{ITEM_ID}} run={{RUN_ID}} cwd={{TARGET_CWD}}
```

跑通验证（参见 `src/smoke.test.ts`），用一个临时 target 和独立 loop-data root：

```bash
TARGET=$(mktemp -d)
LOOP_DATA_ROOT="$TARGET/loop-data"
CHAIN=single-phase-demo

mkdir -p "$TARGET/.coder-loop/runtime/issues" \
  "$TARGET/.coder-loop/runtime/evidence" \
  "$TARGET/.coder-loop/runtime/logs"
printf '# workflow\n' > "$TARGET/.coder-loop/workflow.md"
printf '# shared\n' > "$TARGET/.coder-loop/runtime/shared.md"
printf '{"preset":"single-phase-example","loopDataRoot":"%s"}\n' "$LOOP_DATA_ROOT" \
  > "$TARGET/.coder-loop/runtime/config.json"

coder-loop daemon up --loop-data-root "$LOOP_DATA_ROOT" --json \
  > "$TARGET/daemon.out" 2> "$TARGET/daemon.err" &
DAEMON_PID=$!

coder-loop chain create "$CHAIN" \
  --config-json '{"repository":"fixture/repo","baseBranch":"main"}' \
  --preset single-phase-example \
  --loop-data-root "$LOOP_DATA_ROOT" \
  --json
coder-loop item add "$CHAIN" \
  --issue 1 \
  --repo-cwd "$TARGET" \
  --field-json '{"id":"demo-item"}' \
  --loop-data-root "$LOOP_DATA_ROOT" \
  --json
coder-loop item update "$CHAIN" \
  --issue 1 \
  --status pending \
  --loop-data-root "$LOOP_DATA_ROOT" \
  --json
coder-loop status "$TARGET" --chain "$CHAIN" --json \
  | jq '.target.preset.name, .state.kind, .queue.selected.id'

coder-loop daemon down --loop-data-root "$LOOP_DATA_ROOT" --json
wait "$DAEMON_PID"
rm -rf "$TARGET"
```

---

## 3. `preset.toml` 字段表

| Section / Field | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | preset 标识，必须 match `^[a-zA-Z][a-zA-Z0-9_-]*$`，禁止路径分隔符与 `..`，所以 bundled name 一定落在 `<pkg>/presets/<name>/` 内 |
| `version` | int | 是 | preset schema 版本（手动维护，引擎当前只读不校验向后兼容） |
| `description` | string | 否 | 给人看 |
| `[item].idField` | string | 是 | queue item 的 id 字段名（如 `gh-issue-pr-iteration` 用 `issue`，single-phase-example 用 `id`） |
| `[item.fields]` | table | 否 | preset 额外要绑定的透明 item 字段声明。每个字段值是 `"string"|"number"|"boolean"|"json"`，或 `{ type = "..." }` |
| `[runtime].businessKeys` | string[] | 否 | preset 拥有语义、但仍通过 `runtime.<key>` 暴露给 prompt 的业务 key。不能重声明 engine-owned fact。 |
| `[statuses].continuable` | string[] | 是 | 引擎会调度的 status 集合；item.status 落在这个集合内才被选中 |
| `[statuses].terminal` | string[] | 是 | 引擎跳过的 status 集合（与 continuable 合并去重） |
| `[statuses].entry` | string | 否 | 依赖解除或手动 `queue unblock` 后恢复到的 continuable status；默认取 `continuable[0]` |
| `[statuses].success` | string[] | 否 | terminal 子集；dependsOn 依赖全部进入 success 后，下游 terminal item 会恢复到 `entry` |
| `[statuses].unblockable` | string[] | 否 | terminal 子集；`queue unblock` 只会把这些 terminal status 恢复到 `entry` |
| `[[phases]].name` | string | 是 | phase 名字，写入 `state.current.phase` |
| `[[phases]].prompt` | string | 是 | 相对 preset.toml 的 entry prompt 模板路径 |
| `[[phases]].runner` | `"claude"|"codex"` | 否 | phase 默认 runner；未声明时使用 engine-builtin fallback |
| `[[phases]].model` | string | 否 | phase 默认 model；target config 显式 `claude.model` / `codex.model` 优先于它。只在解析出的 runner kind 与本 phase 声明的 runner 一致时生效（item override 切换 runner 后不继承） |
| `[[phases]].summaryMarker` | string | 否 | 该 phase 在 stdout 中声明完成后的 marker；声明后 post-summary watchdog 观察该 marker，未声明则该 phase 不启用 post-summary watchdog |
| `[[phases.exits]]` | array | 否 | 该 phase 允许 agent 写出的结构化出口。每项包含 `status` 与给 prompt 渲染用的 `when` 说明；不声明 exits 表示该 phase 不写 status |
| `[[phases]].trigger` | table | 否 | 可把 phase 声明为 trigger phase。支持 `trigger = { afterPhase = "...", whenStatus = "..." }` 的 item phase trigger，或 `trigger = { on = "chain-complete" }` 的 chain lifecycle trigger |
| `[phases.variables]` | table | 是 | 模板中 `{{KEY}}` 的解析表。值可为 `"item|config|runtime.<key>"` 字符串，或 `{ source = "...", label = "...", suffix = "...", style = "code|plain" }`，后者会参与 `{{RUNTIME_INPUTS_DOC}}` 渲染 |
| `[[fragments]].id` | string | 是 | fragment 唯一标识（如 `iter/read-context`），entry prompt 通过该 id 引用 |
| `[[fragments]].role` | string | 是 | fragment 角色（如 `common` / `iter` / `review`），仅 metadata，引擎不校验 |
| `[[fragments]].path` | string | 是 | 相对 preset.toml 的 markdown 文件路径，文件必须可读 |
| `[agent].binary` | string | 是 | schema 保留字段；实际 spawn 由 target runtime 的 runner selection 决定。新 preset 可填 `"claude"` 作为兼容占位 |
| `[agent].extraArgs` | string[] | 否 | schema 保留字段；实际 runner args 用 target config 的 `claude.model` / `claude.extraArgs`、`codex.model` / `codex.extraArgs` |
| `[agent].attemptTimeoutSeconds` | number | 否 | 每次 agent attempt 的绝对超时秒数；默认 `3600`。到期且尚未观察到 phase summary marker 时，先对进程组发 `SIGTERM`，5 秒后仍未退出则发 `SIGKILL` |

引擎在加载时强制：

- `name` 与目录名一致或与 `presetPath` 一致；
- 同 `name` 的 phase 不可重名；
- 同 `id` 的 fragment 不可重复；
- `[statuses]` 的 continuable / terminal 集合不可有交集；
- `[statuses].entry` 必须属于 continuable；`success` 与 `unblockable` 必须属于 terminal；
- `[[phases.exits]]` 中每个 status 必须属于 continuable 或 terminal status，且同一 phase 内不可重复；
- item phase trigger 的 `afterPhase` 必须指向已声明 phase，`whenStatus` 必须属于 continuable 或 terminal status，且必须出现在 source phase 的 exits 里；
- chain lifecycle trigger 目前只支持 `on = "chain-complete"`，且不能同时声明 `afterPhase` / `whenStatus`；
- 每条 `[phases.variables]` source 必须 match `^(item|config|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`；
- `item.<field>` 只能引用 `[item].idField`、引擎自有字段（`id/status/phase/runner/agentCwd`），或 `[item.fields]` 显式声明的透明字段。未声明字段在 preset 加载期报错。
- `runtime.<key>` 只能引用 engine-owned fact，或 `[runtime].businessKeys` 显式声明的 preset 业务 key。未声明 key 在 preset 加载期报错；声明了但运行时没有提供值则渲染时报错。

任何一条失败 → preset load throws；`coder-loop status <target> --json` 会把 state 标成 `invalid-preset` 或相邻的 invalid runtime 状态，`doctor` 会在人类可读输出中呈现同一类问题。

### Trigger phases

普通 trigger phase 仍用于“某个 phase 之后，当前 item status 等于某值”的场景：

```toml
[[phases]]
name = "blocked-responder"
prompt = "blocked-responder-entry.md"
trigger = { afterPhase = "review", whenStatus = "blocked" }
```

chain-complete trigger 是 chain lifecycle hook。调度器在 active chain 有 item、没有 active slot、所有 item 都落入 terminal status、且即将写入 `status = "completed"` 前调用该 hook。没有 chain-complete trigger 时保持旧行为：直接完成 chain 并 emit `chain.completed`。

```toml
[[phases]]
name = "umbrella-finalizer"
prompt = "umbrella-finalizer-entry.md"
trigger = { on = "chain-complete" }
```

hook 决策只控制 lifecycle：允许 completed、保持 active，或因为 hook 失败而保持 active。语义判断仍属于 preset prompt 或外部 operator，不属于 scheduler。`decision=keep-active` 会在 chain metadata 中记录当前 all-terminal item 指纹；后续 tick 若 item 集合、terminal status contract 和相关 chain metadata 未变化，调度器保持 active 但不重复触发 finalizer。新增/完成 follow-up item 或其他会改变指纹的状态更新会允许 finalizer 再次运行。

bundled `gh-issue-pr-iteration` preset 用这个 hook 声明 `umbrella-finalizer`：

- phase: `umbrella-finalizer`
- prompt: `presets/gh-issue-pr-iteration/umbrella-finalizer-entry.md`
- trigger: `trigger = { on = "chain-complete" }`

这个 finalizer 是 umbrella-level prompt，不是 L1 engine 判断。它在 chain 准备 completed 前读取 umbrella issue、sub-issues、closing PRs、本地 handoff/evidence 和相关 review 记录，向 umbrella 发布 assessment comment，再用 `FINALIZER SUMMARY: decision=<complete|keep-active>` 表达是否允许 chain completed。发现剩余 scope、缺证据、未合并 PR、未关闭 child 或需要 follow-up issue 时必须保持 chain active；只有 umbrella comment 和 child closure table 证明 scope 完整时才能允许 completion。

---

## 4. 变量绑定 DSL（三前缀）

`[phases.variables]` 表的右侧字符串必须 match `^(item|config|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`，引擎按前缀路由：

| 前缀 | 来源 | 缺失 / 错误行为 |
|---|---|---|
| `item.<field>` | 当前 actionable queue item 字段：`idField`、`id/status/phase/runner/agentCwd`，或 `[item.fields]` 声明的透明字段 | 未声明字段 → preset load throw；缺失/null → `""`；string/number/boolean → `String(...)`；其他类型 → throw |
| `config.<field>` | target `.coder-loop/runtime/config.{json,toml}` 字段 | 字段不存在 → throw；`null/undefined` → throw；类型同上 |
| `runtime.<key>` | 引擎计算的运行期值，或 preset 声明的业务运行期值 | key 必须是 engine-owned fact 或 `[runtime].businessKeys` 声明项；否则 preset load throw。声明项运行时缺值则 render throw |

模板里 `{{KEY}}` 替换为 `String(...)`；多次出现都替换。

### `runtime.*` fact 与 business key

Engine-owned fact 由 `src/loop.ts` 的 `ENGINE_RUNTIME_BINDING_KEYS` 定义。Engine runtime fact key count: 25.

<!-- engine-runtime-binding-keys:start -->
```
runtime.runId                runtime.targetCwd            runtime.agentCwd
runtime.sharedContextPath    runtime.stateFile            runtime.currentIssueFile
runtime.issueDir             runtime.evidenceDir          runtime.evidenceRootDir
runtime.logDir               runtime.traceFile            runtime.loopFile
runtime.presetDir            runtime.fragmentIndex        runtime.runtimeInputsDoc
runtime.phaseExitsDoc        runtime.runIdGeneration      runtime.resumedFromPhase
runtime.resumedStartedAt     runtime.resumedSessionId     runtime.chainName
runtime.chainUmbrellaRepo    runtime.chainUmbrellaIssue   runtime.chainBaseBranch
runtime.repoCwd
```
<!-- engine-runtime-binding-keys:end -->

Preset business key 由 `preset.toml` 声明：

```toml
[runtime]
businessKeys = ["issueKind", "issueKindDoc"]
```

这些 key 的语义属于 preset，而不是引擎契约。引擎只负责：加载时确认 `runtime.<key>` 已声明，渲染时从运行期 binding 表取字符串值。新增业务 key 只改 preset 声明和提供该值的运行期数据面；不改 `ENGINE_RUNTIME_BINDING_KEYS`。

| Key | 含义 |
|---|---|
| `runId` | 本轮 spawn 的 runId（新生成或 resumed） |
| `targetCwd` | target 目录绝对路径 |
| `agentCwd` | agent 子进程的实际 `cwd` 绝对路径。等于 `item.agentCwd ?? targetCwd`；跨 repo 迭代时 item 可声明绝对路径覆盖。 |
| `sharedContextPath` | 当前 chain handoff/shared 文件绝对路径；daemon 负责创建和恢复 |
| `stateFile` | centralized SQLite state DB 的描述；默认 preset 把它展示为 state source，而不是可读文件路径。 |
| `currentIssueFile` | 当前 item 的可选 per-issue handoff attachment 绝对路径（无则 `""`）；不要把它当启动必需条件 |
| `issueDir` | issue handoff 文件根目录绝对路径 |
| `evidenceDir` | 当前 item 的证据子目录绝对路径（无则 fallback `evidenceRootDir`） |
| `evidenceRootDir` | 证据根目录绝对路径 |
| `logDir` | 当前 chain runs/log 根目录绝对路径；agent 输出位于 `<logDir>/<runId>/<phase>/` |
| `traceFile` | phase stdout trace 的显示路径模板：`<logDir>/<runId>/<phase>/stdout.jsonl`。 |
| `loopFile` | central daemon scheduling state 的描述；默认 preset 用它强调调度状态不可提交。 |
| `presetDir` | preset 目录绝对路径（让 agent prompt 能 `cat <presetDir>/iter/...md`） |
| `fragmentIndex` | 全部 fragments 的 markdown 表格（id + role + 绝对路径），entry prompt 嵌它给 agent 当索引 |
| `runtimeInputsDoc` | 按 phase 变量 metadata 生成的 bound runtime input 文档。 |
| `phaseExitsDoc` | 按 phase `[[phases.exits]]` 生成的出口状态文档。 |
| `runIdGeneration` | `"new"` / `"resumed"`，本轮 runId 是新生成还是 resume |
| `resumedFromPhase` | 若 resume，从哪个 phase 续；否则 `""` |
| `resumedStartedAt` | 若 resume，原 run 起始时间戳；否则 `""` |
| `resumedSessionId` | 若 resume，上一轮 runner session id；否则 `""`。 |
| `chainName` | centralized chain 名称。 |
| `chainUmbrellaRepo` | chain metadata 中登记的 umbrella repo，缺失则 `""`。 |
| `chainUmbrellaIssue` | chain metadata 中登记的 umbrella issue number，缺失则 `""`。 |
| `chainBaseBranch` | chain metadata 的 base branch。 |
| `repoCwd` | 当前 item 所属 target repo cwd；跨 repo queue item 与 agent cwd 分离时用于提示。 |

Bundled `gh-issue-pr-iteration` 当前声明的 business key：

| Key | 含义 |
|---|---|
| `issueKind` | `"code"` / `"comment"` / `"code-spike"` / `"blocked"` / `""`（empty = 无 label / legacy）；从 `gh issue view --json labels` fetch，或无 repo 的本地 fixture 从 queue item `kind` 读 |
| `issueKindDoc` | 默认 preset issue-kind 路由说明；其他 preset 一般不引用。 |

`runIdGeneration` 是引擎对「这次 spawn 是新生成 runId 还是从 state.current 恢复」的客观回答；preset 自行用这一信号 + `item.status` + `item.lastRunId` 派生 fresh / retry / resume 三种调度形态——引擎不识别这些领域分类。

`issueKind` 是 `gh-issue-pr-iteration` 专用信号（issue 上的 `kind:code` / `kind:comment` / `kind:code-spike` / `kind:blocked` label），所以它由该 preset 的 `[runtime].businessKeys` 声明；其他 preset 一般可忽略或不引用。

### 扩 `runtime.*` key 的流程

新增 engine-owned fact 必须**同时**改两处 `src/loop.ts`：

1. `ENGINE_RUNTIME_BINDING_KEYS` 数组加 key 字面量。
2. `buildRuntimeBindings` 返回对象加该 key 的赋值；类型系统会强制要求。

只改其中一处会 TypeScript 编译失败。改完跑 `bun test`（binding / smoke 覆盖）+ `bun x tsc --noEmit`。

新增 preset 业务 key 不改 engine-owned fact 清单。只在对应 preset 的 `[runtime].businessKeys` 加 key，并确保运行期 binding 表提供该 key 的字符串值；未声明引用会在 preset load 阶段失败，声明但缺值会在 render 阶段失败。

---

## 5. Target 怎么选 preset

target 在 `.coder-loop/runtime/config.json`（或 `config.toml`）写：

```json
{ "preset": "single-phase-example" }            // 用 bundled preset by name
```

或：

```json
{ "presetPath": "../my-custom-preset" }         // target-side 相对路径
```

或：

```json
{ "presetPath": "/abs/path/to/preset" }         // 绝对路径
```

两者互斥。都不写时引擎走默认的 `gh-issue-pr-iteration`。`preset` 名只允许 `^[a-zA-Z][a-zA-Z0-9_-]*$`，禁止路径分隔符与 `..`，所以 bundled name 一定落在 `<pkg>/presets/<name>/` 内。

Runner 与 model 默认值写在 `preset.toml`，不是角色 entry md 或 target runtime config。每个 phase 可声明：

```toml
[[phases]]
name = "review"
prompt = "review-entry.md"
runner = "codex"
model  = "gpt-5.5"
```

`runner` 只能是 `claude` 或 `codex`。未声明的 phase 使用 `source=engine-builtin` fallback；已声明的 phase 在 `status --json` 中显示 `source=preset`。`model` 是该 phase 的默认模型，可省略；模型解析优先级为 target config 显式 `claude.model` / `codex.model`（override）> phase `model` 声明（preset 默认）> 无（runner CLI 自身默认）。target config 继续提供 runner command 参数，例如：

```json
{
  "preset": "single-phase-example",
  "codex": { "binary": "codex", "model": "gpt-5.4", "extraArgs": [] },
  "claude": { "binary": "claude", "model": "sonnet", "extraArgs": [] }
}
```

queue item 可加 `"runner": "claude" | "codex"` 覆盖允许 item override 的普通执行 phase；review 和 trigger 这类角色使用自己的 phase runner 声明。item override 把 runner 切到与 phase 声明不同的 kind 时，不继承该 phase 的 `model` 声明（phase model 绑定在它声明的 runner kind 上）。Iteration 与 review 共享同一份 `claude.model` / `codex.model` config，源码不再为 review 强制模型。preset 作者不要把某个 runner 的 CLI 细节写进 engine contract；若某个 preset 只支持特定 runner，把它写进该 preset 的 README / target workflow，并用 `doctor` / `status` 验证 preset runner 与 target command config 是否符合预期。

---

## 6. 最小 target / chain 文件

跑一个新 preset 所需的最小 target（参见 `src/smoke.test.ts`）：

```
<target>/.coder-loop/
  workflow.md                   # 占位即可，preset 是否引用看 entry prompt
  runtime/
    config.json                 # { "preset": "<name>" }
    shared.md                   # 占位；central chain 也可有自己的 shared context
    issues/                     # handoff 文件目录
    evidence/                   # evidence 根目录
    logs/                       # legacy/local fallback；新版 runs/log path 由 chain runtime 决定
```

队列 / current / recentRuns 存在 centralized SQLite loop-data store 中。用 `coder-loop chain create`、`coder-loop item add`、安装/规划命令，或测试 helper 建 chain + item；不要为新版 runtime 手写 `.coder-loop/runtime/state.json` 当 authoritative queue。

`coder-loop status <target> --json --chain <chain>` 应当 exit 0，且输出里 `.target.preset.name` 是目标 preset、`.state.kind == "ok"`；有可推进 item 时 `.queue.selected.id` 应指向该 preset 的 `item.idField` 值。没有 queue 时先用 `coder-loop chain create` / `coder-loop item add` 建立 centralized chain 与 item，再读取 status。

---

## 7. Agent prompt 写作约定

引擎不要求 entry prompt 用任何特定结构。`gh-issue-pr-iteration` 当前用两套约定（其他 preset 可借鉴或自定义）：

- **plan 链：查表式 fragment 链**。每个 fragment 文件以 `# Fragment: <id>` 起手；入口 prompt 把 `{{PROMPT_FRAGMENT_INDEX}}` 嵌入做索引；每个 fragment 末尾有 `## Output verdict` 段（出口 + 下一跳 fragment id），agent 按 verdict 链跑。
- **iteration / review：调度者模式**。entry md 是调度者手册（调查 → 计划 → 派 subagent → 验收 → 补缺 → 清场）；fragment 改组为步骤三件套（`task.md` 给 subagent / `report.md` 汇报模板 / `accept.md` 验收判据）与 `quality/` 品质判据；调度者 dispatch 消息只传文件指针与运行时键值。注意：fragment 文件不经引擎渲染，跨文件引用要写运行时安装位置的绝对路径。

形态详见 `docs/gh-issue-pr-iteration-fragments.md`。换 preset 时这两套都不强制——你也可以让 agent 跑单一 prompt 不分 fragment。

---

## 8. 改 preset 后必跑的自测

任何 preset 改动后：

```bash
cd /path/to/coder-loop
bun test                  # 跑 preset.test.ts / loop.test.ts / smoke.test.ts
bun x tsc --noEmit        # 类型检查（engine runtime fact 双处一致性靠类型系统）
```

`preset.test.ts` 验证 bundled `gh-issue-pr-iteration` 的 fragment 集合 / 变量绑定 / phase 顺序与 src 一致；改默认 preset 后这个测试会先红，按 diff 修测试期望。
