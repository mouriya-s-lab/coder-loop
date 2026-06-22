# Preset 作者手册

读者：想写一个新 preset（非 `gh-issue-pr-iteration`）或修改现有 preset 的人。

读完后你能：理解 `preset.toml` 全部字段、写出最小可跑 preset、知道变量绑定 DSL 三前缀边界、知道怎么区分 engine-owned `runtime.*` fact 与 preset-declared runtime business key。

不在范围内：`gh-issue-pr-iteration` 内部 fragment 跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）；运行期状态 / trace（看 [operations](./operations.md)）。

---

## 1. 引擎契约（preset 看不到引擎的什么）

`src/loop.ts` 是有限状态机，行为由 preset 驱动。引擎职责：

| 引擎职责 | 说明 |
|---|---|
| **加载 preset** | 从 `<pkg>/presets/<name>/` 或 target 的 `presetPath` 读 `preset.toml`，解析 `name / item.idField / statuses / phases / fragments / agent`。每个 fragment 路径必须可读。 |
| **加载 target runtime** | 读 target `.coder-loop/runtime/shared.md`，并从 centralized SQLite loop-data store 解析 active chain / queue / current（preset 选择与 binding 来自 chain.metadata.bindings；target-side 的 config / workflow 文件随 #433 / #434 退役，install/uninstall 子命令随 #436 退役）。 |
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
printf '# shared\n' > "$TARGET/.coder-loop/runtime/shared.md"

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
| `[item].idField` | string | 是 | queue item 的 id 字段名（如 `gh-issue-pr-iteration` 用 `issue`，single-phase-example 用 `id`） |
| `[item.fields]` | table | 否 | preset 额外要绑定的透明 item 字段声明。每个字段值是 `"string"|"number"|"boolean"|"json"`，或 `{ type = "..." }` |
| `[runtime].businessKeys` | string[] | 否 | preset 拥有语义、但仍通过 `runtime.<key>` 暴露给 prompt 的业务 key。不能重声明 engine-owned fact。仅声明 key 名字；值的来源由下面 `businessKeyValues` 或引擎 runtime 数据面提供。 |
| `[runtime.businessKeyValues]` | table | 否 | 为 `businessKeys` 中声明的 key 在 preset 文件内供值。每条形如 `<key> = { literal = "<string>" }`；当前唯一支持 `literal`。每个 key 必须出现在 `businessKeys` 中。未在此表中供值的 key 由引擎运行期数据面补；都没补 → render 报 `missing runtime binding value`。 |
| `[statuses].continuable` | string[] | 是 | 引擎会调度的 status 集合；item.status 落在这个集合内才被选中 |
| `[statuses].terminal` | string[] | 是 | 引擎跳过的 status 集合（与 continuable 合并去重） |
| `[statuses].entry` | string | 否 | 依赖解除或手动 `queue unblock` 后恢复到的 continuable status；默认取 `continuable[0]` |
| `[statuses].success` | string[] | 否 | terminal 子集；dependsOn 依赖全部进入 success 后，下游 terminal item 会恢复到 `entry` |
| `[statuses].unblockable` | string[] | 否 | terminal 子集；`queue unblock` 只会把这些 terminal status 恢复到 `entry` |
| `[statuses].retry` | string | 否 | continuable status，表示"上一轮被打回需重跑"。声明后 `retryStatusDoc` doc builder 把它注入到 md 中需要引用 retry 概念的位置（issue #404），preset prose 不再硬编码 status 字面量 |
| `[[phases]].name` | string | 是 | phase 名字，写入 `state.current.phase` |
| `[[phases]].prompt` | string | 是 | 相对 preset.toml 的 entry prompt 模板路径 |
| `[[phases]].runner` | `"claude"|"codex"` | 否 | phase 默认 runner；未声明时使用 engine-builtin fallback |
| `[[phases]].model` | string | 否 | phase 默认 model。只在解析出的 runner kind 与本 phase 声明的 runner 一致时生效（item override 切换 runner 后不继承） |
| `[[phases]].summaryMarker` | string | 否 | 该 phase 在 stdout 中声明完成后的 marker；声明后 post-summary watchdog 观察该 marker，未声明则该 phase 不启用 post-summary watchdog |
| `[[phases.exits]]` | array | 否 | 该 phase 允许 agent 写出的结构化出口。每项包含 `status` 与给 prompt 渲染用的 `when` 说明；不声明 exits 表示该 phase 不写 status |
| `[[phases]].trigger` | table | 否 | 可把 phase 声明为 trigger phase。支持 `trigger = { afterPhase = "...", whenStatus = "..." }` 的 item phase trigger，或 `trigger = { on = "chain-complete" }` 的 chain lifecycle trigger |
| `[[phases]].roles` | string[] | preset 声明 fragments 时必填，否则可省 | 该 phase 渲染 `{{PROMPT_FRAGMENT_INDEX}}` 时可见的 fragment role 集合（issue #400）。引擎从不通过 phase 名猜 role；只列在这里的 role 对应的 fragment 才会进该 phase 的索引切片。`[[fragments]]` 中未出现的 role 名会在加载期报错。 |
| `[phases.variables]` | table | 是 | 模板中 `{{KEY}}` 的解析表。值可为 `"item|chain|runtime.<key>"` 字符串，或 `{ source = "...", label = "...", suffix = "...", style = "code|plain" }`，后者会参与 `{{RUNTIME_INPUTS_DOC}}` 渲染 |
| `[[fragments]].id` | string | 是 | fragment 唯一标识（如 `iter/read-context`），entry prompt 通过该 id 引用 |
| `[[fragments]].role` | string | 是 | fragment 角色（如 `common` / `iter` / `review`）。issue #400 后，该字段参与 `[[phases]].roles` 切片：当前 phase 渲染的 fragment 索引仅含 role 出现在该 phase `roles` 数组里的条目。fragment 文件完整性校验（`assertReadable`）仍覆盖全量。 |
| `[[fragments]].path` | string | 是 | 相对 preset.toml 的 markdown 文件路径，文件必须可读 |
| `[agent].attemptTimeoutSeconds` | number | 否 | 每次 agent attempt 的绝对超时秒数；默认 `3600`。到期且尚未观察到 phase summary marker 时，先对进程组发 `SIGTERM`，5 秒后仍未退出则发 `SIGKILL`。#433：原 `[agent].binary` / `[agent].extraArgs` 已退役，preset.toml 中再写会在加载期报错 |

引擎在加载时强制：

- `name` 与目录名一致或与 `presetPath` 一致；
- 同 `name` 的 phase 不可重名；
- 同 `id` 的 fragment 不可重复；
- `[statuses]` 的 continuable / terminal 集合不可有交集；
- `[statuses].entry` 必须属于 continuable；`success` 与 `unblockable` 必须属于 terminal；`[statuses].retry` 声明后必须属于 continuable；
- `[[phases.exits]]` 中每个 status 必须属于 continuable 或 terminal status，且同一 phase 内不可重复；
- preset 声明任何 `[[fragments]]` 时，每个 `[[phases]]` 必须声明 `roles` 数组（issue #400：phase↔role 映射必须显式，引擎不按 phase 名推断）；数组内每个 role 必须出现在某个 `[[fragments]].role` 里，且不可重复；preset 无 fragments 时可省 `roles`；
- item phase trigger 的 `afterPhase` 必须指向已声明 phase，`whenStatus` 必须属于 continuable 或 terminal status，且必须出现在 source phase 的 exits 里；
- chain lifecycle trigger 目前只支持 `on = "chain-complete"`，且不能同时声明 `afterPhase` / `whenStatus`；
- 每条 `[phases.variables]` source 必须 match `^(item|chain|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`；
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

`[phases.variables]` 表的右侧字符串必须 match `^(item|chain|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`，引擎按前缀路由：

| 前缀 | 来源 | 缺失 / 错误行为 |
|---|---|---|
| `item.<field>` | 当前 actionable queue item 字段：`idField`、`id/status/phase/runner/agentCwd`，或 `[item.fields]` 声明的透明字段 | 未声明字段 → preset load throw；缺失/null → `""`；string/number/boolean → `String(...)`；其他类型 → throw |
| `chain.<field>` | centralized chain.metadata.bindings 字段（chain 创建时通过 `coder-loop chain create --config-json '{...}'` 写入；#433 后此前的 `config.<field>` 形式已退役） | 字段不存在 → throw；`null/undefined` → throw；类型同上 |
| `runtime.<key>` | 引擎计算的运行期值，或 preset 声明的业务运行期值 | key 必须是 engine-owned fact 或 `[runtime].businessKeys` 声明项；否则 preset load throw。声明项运行时缺值则 render throw |

模板里 `{{KEY}}` 替换为 `String(...)`；多次出现都替换。

### `runtime.*` fact 与 business key

Engine-owned fact 由 `src/loop.ts` 的 `ENGINE_RUNTIME_BINDING_KEYS` 定义。Engine runtime fact key count: 26.

<!-- engine-runtime-binding-keys:start -->
```
runtime.runId                  runtime.targetCwd              runtime.agentCwd
runtime.sharedContextPath      runtime.stateFile              runtime.currentIssueFile
runtime.issueDir               runtime.evidenceDir            runtime.evidenceRootDir
runtime.logDir                 runtime.traceFile              runtime.loopFile
runtime.presetDir              runtime.fragmentIndex          runtime.runtimeInputsDoc
runtime.phaseExitsDoc          runtime.statusVocabularyDoc    runtime.triggerStatusDoc
runtime.terminalStatusesDoc    runtime.retryStatusDoc         runtime.runIdGeneration
runtime.resumedFromPhase       runtime.resumedStartedAt       runtime.resumedSessionId
runtime.chainName              runtime.repoCwd
```
<!-- engine-runtime-binding-keys:end -->

Preset business key 通过 `preset.toml` 两步声明 + 供值（issue #448）：

**1. 声明 key 名字**（必填）：

```toml
[runtime]
businessKeys = ["auditDemo"]
```

**2. 在 preset 文件内为 key 供值**（可选；不供值时该 key 必须由引擎为对应 preset 提供值，否则 render 期报错）：

```toml
[runtime.businessKeyValues]
auditDemo = { literal = "business-key-e2e-ok" }
```

每条 value spec 是 inline table，目前唯一支持的形式是 `{ literal = "<string>" }`。`businessKeyValues` 中的每个 key 必须出现在 `businessKeys` 中；engine-owned key 不能出现（声明面已拦截）。

这些 key 的语义属于 preset，而不是引擎契约。引擎只负责：加载时确认 `runtime.<key>` 已声明、`businessKeyValues` 中的 key 都已 declared，渲染时把 preset 提供的 literal 合并进 `RuntimeBindings`，并按字符串值供模板替换。新增业务 key 只改 preset 声明 + 供值；不改 `ENGINE_RUNTIME_BINDING_KEYS`、不改 `src/`。

新增业务 key 时**优先用 `businessKeyValues` literal 供值**——只改 preset 文件即可，不动 `src/`。如果业务 key 的值必须由运行期动态计算（preset 无法用 literal 表达），需要把数据面写进 `buildSchedulerResolveContext` / `buildRuntimeBindings`，此时改 `src/` 不可避免。

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
| `fragmentIndex` | 按当前 phase 的 `[[phases]].roles` 切片后的 fragments markdown 表格（id + role + 绝对路径）；entry prompt 嵌它给 agent 当索引。issue #400：phase↔role 映射来自 preset 元数据，引擎不通过 phase 名猜；preset 声明 fragments 但 phase 缺 `roles` 时 loadPreset 报错。fragment 完整性校验（`assertReadable`）仍覆盖全量 fragments，与可见性切片相互独立。 |
| `runtimeInputsDoc` | 按 phase 变量 metadata 生成的 bound runtime input 文档。 |
| `phaseExitsDoc` | 按 phase `[[phases.exits]]` 生成的出口状态文档。 |
| `statusVocabularyDoc` | #404：按 phase 切片的 status 词表（`actionable` / `non-actionable` 分组）；trigger phase 只渲染 `whenStatus`，普通工作 phase 渲染 continuable，含 `[[phases.exits]]` 的 phase（如 review）渲染 continuable + terminal。 |
| `triggerStatusDoc` | #404：当前 phase 的 trigger 关注 status 字面量（仅 trigger phase 非 chain-complete 时非空）。 |
| `terminalStatusesDoc` | #404：`preset.statuses.terminal` 的逗号分隔字面表，供 phase prose 引用「不可写入的终态集合」。 |
| `retryStatusDoc` | #404：preset 声明的 retry continuable status（`[statuses].retry`）加 backtick；未声明则为空串。 |
| `runIdGeneration` | `"new"` / `"resumed"`，本轮 runId 是新生成还是 resume |
| `resumedFromPhase` | 若 resume，从哪个 phase 续；否则 `""` |
| `resumedStartedAt` | 若 resume，原 run 起始时间戳；否则 `""` |
| `resumedSessionId` | 若 resume，上一轮 runner session id；否则 `""`。 |
| `chainName` | centralized chain 名称。 |
| `repoCwd` | 当前 item 所属 target repo cwd；跨 repo queue item 与 agent cwd 分离时用于提示。 |

> #457：`chainUmbrellaRepo` / `chainUmbrellaIssue` / `chainBaseBranch` 引擎 fact 已退役。`baseBranch` 仍然是 chain 一等列（worktree 创建机制消费）；prompt 业务侧通过 `chain.baseBranch` 命名空间读取（`buildSchedulerChainBindings` 的常规展开）。umbrella 值降为 chain 声明字段（`chain.umbrellaRepo` / `chain.umbrellaIssue`），存在 `metadata.bindings` 里，bundled `gh-issue-pr-iteration` preset 通过 `chain.<field>` 读取并带 `default = ""` fallback。引擎不再注入这些 runtime fact。

Bundled `gh-issue-pr-iteration` 当前不声明任何 business key（#450 / #420 / #401 链先后退役了引擎侧的 kind 分类机制 / 取值机制 / 词表与渲染面，preset 不再消费 kind 信号）。

`runIdGeneration` 是引擎对「这次 spawn 是新生成 runId 还是从 state.current 恢复」的客观回答；preset 自行用这一信号 + `item.status` + `item.lastRunId` 派生 fresh / retry / resume 三种调度形态——引擎不识别这些领域分类。

### 扩 `runtime.*` key 的流程

新增 engine-owned fact 必须**同时**改两处 `src/loop.ts`：

1. `ENGINE_RUNTIME_BINDING_KEYS` 数组加 key 字面量。
2. `buildRuntimeBindings` 返回对象加该 key 的赋值；类型系统会强制要求。

只改其中一处会 TypeScript 编译失败。改完跑 `bun test`（binding / smoke 覆盖）+ `bun x tsc --noEmit`。

新增 preset 业务 key 不改 engine-owned fact 清单。只在对应 preset 的 `[runtime].businessKeys` 加 key 名字（声明步），并在 `[runtime.businessKeyValues]` 中通过 `<key> = { literal = "<string>" }` 提供值（供值步）；引擎在 `buildSchedulerResolveContext` / `buildRuntimeBindings` 中把这些 literal 合并进 runtime 表，无须改 `src/`。未声明 key 在 preset load 阶段失败，声明但缺值（既无 `businessKeyValues` literal 也无引擎运行期数据面补值）则在 render 阶段失败。

复合验收 fixture：`presets/business-key-example/` 用最小形态演示「声明 + literal 供值」一步式新增——`businessKeys = ["auditDemo"]` + `[runtime.businessKeyValues] auditDemo = { literal = "business-key-e2e-ok" }`，phase 模板 `{{AUDIT_DEMO}}` 在真实 spawn 路径渲染等于 `business-key-e2e-ok`，引擎源码无该 fixture 字面量。

---

## 5. Target 怎么选 preset

Preset 选择存在 chain.metadata.bindings 里，由 `coder-loop chain create` 在创建 chain 时落地（target 侧没有 config 文件）：

```bash
# 用 bundled preset by name
coder-loop chain create my-chain \
  --preset single-phase-example \
  --config-json '{"repository":"owner/repo","baseBranch":"main"}'

# 用 absolute presetPath
coder-loop chain create my-chain \
  --config-json '{"repository":"owner/repo","baseBranch":"main","presetPath":"/abs/path/to/preset"}'

# target-side 相对路径（chain.create 会归一化为绝对路径再落库）
coder-loop chain create my-chain \
  --config-json '{"repository":"owner/repo","baseBranch":"main","presetPath":"../my-custom-preset"}'
```

`preset` 和 `presetPath` 二选一互斥。都不写时引擎走默认的 `gh-issue-pr-iteration`。`preset` 名只允许 `^[a-zA-Z][a-zA-Z0-9_-]*$`，禁止路径分隔符与 `..`，所以 bundled name 一定落在 `<pkg>/presets/<name>/` 内。

Runner 与 model 默认值写在 `preset.toml`，不是角色 entry md。每个 phase 可声明：

```toml
[[phases]]
name = "review"
prompt = "review-entry.md"
runner = "codex"
model  = "gpt-5.5"
```

`runner` 只能是 `claude` 或 `codex`。未声明的 phase 使用 `source=engine-builtin` fallback；已声明的 phase 在 `status --json` 中显示 `source=preset`。`model` 是该 phase 的默认模型，可省略（缺省即让 runner CLI 用自身默认）。Runner binary 直接是 `claude` / `codex`（在 PATH 上），不再有 target 级覆盖通道。

queue item 可加 `"runner": "claude" | "codex"` 覆盖允许 item override 的普通执行 phase；review 和 trigger 这类角色使用自己的 phase runner 声明。item override 把 runner 切到与 phase 声明不同的 kind 时，不继承该 phase 的 `model` 声明（phase model 绑定在它声明的 runner kind 上）。preset 作者不要把某个 runner 的 CLI 细节写进 engine contract；若某个 preset 只支持特定 runner，把它写进该 preset 的 README 或 target 自有的 `CLAUDE.md` / `AGENTS.md`，并用 `doctor` / `status` 验证 preset runner 是否符合预期。

---

## 6. 最小 target / chain 文件

跑一个新 preset 所需的最小 target（参见 `src/smoke.test.ts`）：

```
<target>/CLAUDE.md 或 AGENTS.md      # 项目命令 / 约定 / PR 形态；plan/iter/review prompts 显式读取
<target>/.coder-loop/
  runtime/
    shared.md                   # 占位；central chain 也可有自己的 shared context
    issues/                     # handoff 文件目录
    evidence/                   # evidence 根目录
    logs/                       # legacy/local fallback；新版 runs/log path 由 chain runtime 决定
```

Preset 选择与 chain binding 都在 centralized SQLite loop-data store 的 chain.metadata.bindings 里（由 `coder-loop chain create --preset <name> --config-json '{...}'` 写入），target spawn cwd 只承载 `CLAUDE.md` / `AGENTS.md` 等 agent 指令文件作为项目命令源，不承载引擎可读的状态或绑定源。队列 / current / recentRuns 同样存在该 store 中。用 `coder-loop chain create`、`coder-loop item add`、安装/规划命令，或测试 helper 建 chain + item；不要为新版 runtime 手写 `.coder-loop/runtime/state.json` 当 authoritative queue。

`coder-loop status <target> --json --chain <chain>` 应当 exit 0，且输出里 `.target.preset.name` 是目标 preset、`.state.kind == "ok"`；有可推进 item 时 `.queue.selected.id` 应指向该 preset 的 `item.idField` 值。没有 queue 时先用 `coder-loop chain create` / `coder-loop item add` 建立 centralized chain 与 item，再读取 status。

---

## 7. Agent prompt 写作约定

引擎不要求 entry prompt 用任何特定结构。`gh-issue-pr-iteration` 当前用两套约定（其他 preset 可借鉴或自定义）：

- **plan 链：查表式 fragment 链**。每个 fragment 文件以 `# Fragment: <id>` 起手；入口 prompt 把 `{{PROMPT_FRAGMENT_INDEX}}` 嵌入做索引；每个 fragment 末尾有 `## Output verdict` 段（出口 + 下一跳 fragment id），agent 按 verdict 链跑。
- **iteration / review：调度者 workflow**。entry md 是按序编号的 workflow（不是散文手册）：调度者维护显式任务清单（两态出口 `[x] accepted` / `[-] skipped`，全勾完才能退出），每个 Step 在使用现场内联写明做什么、亲自命令闭集、派哪个 subagent、传什么、查什么、verdict 去哪。fragment 改组为步骤三件套（`task.md` 给 subagent，含 Inputs 节 / `report.md` 必填字段汇报模板 / `accept.md` 验收判据，内嵌 Required report fields）与按受众拆分的 `quality/*-execute.md`（执行者）/ `quality/*-judge.md`（调度者）——单文件双受众会双向泄漏（执行者向判据表演 / 调度者吞执行细节）。调度者 dispatch 消息只传文件指针与运行时键值。注意：fragment 文件不经引擎渲染，跨文件引用要写运行时安装位置的绝对路径。

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
