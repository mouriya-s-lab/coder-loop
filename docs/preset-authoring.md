# Preset 作者手册

读者：想写一个新 preset（非 `gh-issue-pr-iteration`）或修改现有 preset 的人。

读完后你能：理解 `preset.toml` 全部字段、写出最小可跑 preset、知道变量绑定 DSL 三前缀边界、知道怎么往 `runtime.*` 白名单加新 key。

不在范围内：`gh-issue-pr-iteration` 内部 fragment 跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）；运行期状态 / trace（看 [operations](./operations.md)）。

---

## 1. 引擎契约（preset 看不到引擎的什么）

`src/loop.ts` 是有限状态机，行为由 preset 驱动。引擎职责：

| 引擎职责 | 说明 |
|---|---|
| **加载 preset** | 从 `<pkg>/presets/<name>/` 或 target 的 `presetPath` 读 `preset.toml`，解析 `name / version / item.idField / statuses / phases / fragments / agent`。每个 fragment 路径必须可读。 |
| **加载 target runtime** | 读 target `.coder-loop/runtime/{config.json,state.json,shared.md}`，校验路径都落在 target 目录下。 |
| **选 actionable item** | 若 `state.current` 存在且其 status 在 preset 的 `statuses.continuable` 内，继续它；否则在队列里找首个 `continuable` item。`continuable` 外的所有 item 视为 terminal，引擎不动。 |
| **按 phase 顺序 spawn agent** | 遍历 `preset.phases`：每个 phase 读 entry prompt 模板，按 `[phases.variables]` 表绑定变量替换 `{{KEY}}`，把渲染后的 prompt 传给当前 runner（`claude` 或 `codex`）。捕获 stdout/stderr 写 trace。每个 phase spawn 完写一个 status JSON。 |
| **resume / 不丢工作** | spawn 中途崩溃，重启时根据 `state.current.phase` 跳到当前 phase 而非从头。 |
| **`.dev-loop` 开关** | 启动时创建 `.dev-loop`；删除该文件即正常退出当前轮，不强杀正在跑的 agent。 |
| **`--check-runtime` 健康检查** | 不 spawn agent。校验 preset、target 文件、queue item id / status 是否合法、`state.current` 是否一致。返回错误清单。 |
| **`--dry-run` 渲染检查** | 选 actionable item，跑到 spawn 前为止，输出选中的 item id；不写 trace、不调 agent。 |

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
binary    = "echo"
extraArgs = []
```

`presets/single-phase-example/run-entry.md`：

```
hello {{ITEM_ID}} run={{RUN_ID}} cwd={{TARGET_CWD}}
```

跑通验证（参见 `src/smoke.test.ts`）：

```bash
bun src/loop.ts --target-cwd <fresh-target> --check-runtime
# Runtime check passed: queue=N, selected=<id>
# Runtime check passed: preset=single-phase-example
```

---

## 3. `preset.toml` 字段表

| Section / Field | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | preset 标识，必须 match `^[a-zA-Z][a-zA-Z0-9_-]*$`，禁止路径分隔符与 `..`，所以 bundled name 一定落在 `<pkg>/presets/<name>/` 内 |
| `version` | int | 是 | preset schema 版本（手动维护，引擎当前只读不校验向后兼容） |
| `description` | string | 否 | 给人看 |
| `[item].idField` | string | 是 | queue item 的 id 字段名（如 `gh-issue-pr-iteration` 用 `issue`，single-phase-example 用 `id`） |
| `[statuses].continuable` | string[] | 是 | 引擎会调度的 status 集合；item.status 落在这个集合内才被选中 |
| `[statuses].terminal` | string[] | 是 | 引擎跳过的 status 集合（与 continuable 合并去重） |
| `[[phases]].name` | string | 是 | phase 名字，写入 `state.current.phase` |
| `[[phases]].prompt` | string | 是 | 相对 preset.toml 的 entry prompt 模板路径 |
| `[phases.variables]` | table | 是 | 模板中 `{{KEY}}` 的解析表，详见下节 |
| `[[fragments]].id` | string | 是 | fragment 唯一标识（如 `iter/read-context`），entry prompt 通过该 id 引用 |
| `[[fragments]].role` | string | 是 | fragment 角色（如 `common` / `iter` / `review`），仅 metadata，引擎不校验 |
| `[[fragments]].path` | string | 是 | 相对 preset.toml 的 markdown 文件路径，文件必须可读 |
| `[agent].binary` | string | 是 | schema 保留字段；实际 spawn 由 target runtime 的 runner selection 决定。新 preset 可填 `"claude"` 作为兼容占位 |
| `[agent].extraArgs` | string[] | 否 | schema 保留字段；实际 runner args 用 target config 的 `claude.extraArgs` / `codex.extraArgs` |

引擎在加载时强制：

- `name` 与目录名一致或与 `presetPath` 一致；
- 同 `name` 的 phase 不可重名；
- 同 `id` 的 fragment 不可重复；
- `[statuses]` 的 continuable / terminal 集合不可有交集；
- 每条 `[phases.variables]` 右侧必须 match `^(item|config|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`。

任何一条失败 → preset load throws，`--check-runtime` 报错。

---

## 4. 变量绑定 DSL（三前缀）

`[phases.variables]` 表的右侧字符串必须 match `^(item|config|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`，引擎按前缀路由：

| 前缀 | 来源 | 缺失 / 错误行为 |
|---|---|---|
| `item.<field>` | 当前 actionable queue item 字段（含 `idField` 与任意附加字段） | 缺失/null → `""`；string/number/boolean → `String(...)`；其他类型 → throw |
| `config.<field>` | target `.coder-loop/runtime/config.{json,toml}` 字段 | 字段不存在 → throw；`null/undefined` → throw；类型同上 |
| `runtime.<key>` | 引擎计算的运行期值 | key 必须在白名单内；否则 throw |

模板里 `{{KEY}}` 替换为 `String(...)`；多次出现都替换。

### `runtime.*` 白名单（当前 19 key）

```
runtime.runId               runtime.targetCwd            runtime.agentCwd
runtime.workflowPath        runtime.sharedContextPath    runtime.statePath
runtime.currentIssueFile    runtime.issueDir             runtime.evidenceDir
runtime.evidenceRootDir     runtime.logDir               runtime.traceFile
runtime.loopFile            runtime.presetDir            runtime.fragmentIndex
runtime.runIdGeneration     runtime.resumedFromPhase     runtime.resumedStartedAt
runtime.issueKind
```

| Key | 含义 |
|---|---|
| `runId` | 本轮 spawn 的 runId（新生成或 resumed） |
| `targetCwd` | target 目录绝对路径（`.coder-loop/runtime/` 所在 repo） |
| `agentCwd` | agent `claude -p` 子进程的实际 `cwd` 绝对路径。等于 `item.agentCwd ?? targetCwd`；跨 repo 迭代时 item 可声明绝对路径覆盖。 |
| `workflowPath` | `.coder-loop/workflow.md` 绝对路径 |
| `sharedContextPath` | `.coder-loop/runtime/shared.md` 绝对路径 |
| `statePath` | `.coder-loop/runtime/state.json` 绝对路径 |
| `currentIssueFile` | 当前 item 的 issue handoff 文件绝对路径（无则 `""`） |
| `issueDir` | issue handoff 文件根目录绝对路径 |
| `evidenceDir` | 当前 item 的证据子目录绝对路径（无则 fallback `evidenceRootDir`） |
| `evidenceRootDir` | 证据根目录绝对路径 |
| `logDir` | 日志 / trace 根目录绝对路径 |
| `traceFile` | `<target>/.dev-trace.txt` 绝对路径（每轮覆盖） |
| `loopFile` | `<target>/.dev-loop` sentinel 绝对路径 |
| `presetDir` | preset 目录绝对路径（让 agent prompt 能 `cat <presetDir>/iter/...md`） |
| `fragmentIndex` | 全部 fragments 的 markdown 表格（id + role + 绝对路径），entry prompt 嵌它给 agent 当索引 |
| `runIdGeneration` | `"new"` / `"resumed"`，本轮 runId 是新生成还是 resume |
| `resumedFromPhase` | 若 resume，从哪个 phase 续；否则 `""` |
| `resumedStartedAt` | 若 resume，原 run 起始时间戳；否则 `""` |
| `issueKind` | `"code"` / `"comment"` / `""`（empty = 无 label / legacy）；从 `gh issue view --json labels` fetch |

`runIdGeneration` 是引擎对「这次 spawn 是新生成 runId 还是从 state.current 恢复」的客观回答；preset 自行用这一信号 + `item.status` + `item.lastRunId` 派生 fresh / retry / resume 三种调度形态——引擎不识别这些领域分类。

`issueKind` 是 `gh-issue-pr-iteration` 专用信号（issue 上的 `kind:code` / `kind:comment` label），其他 preset 一般可忽略或不引用。

### 扩 `runtime.*` 白名单的流程

新增一个白名单 key 必须**同时**改两处 `src/loop.ts`：

1. `RUNTIME_BINDING_KEYS`（`src/loop.ts:185-204`）数组加 key 字面量。
2. `buildRuntimeBindings`（`src/loop.ts:1024-1052`）返回对象加该 key 的赋值；类型系统会强制要求。

只改其中一处会 TypeScript 编译失败。改完跑 `bun test`（`src/loop.test.ts` 有完整 binding 测试覆盖）+ `bun x tsc --noEmit`。

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

Runner 是 target runtime 配置，不是 preset 状态机的一部分。默认 runner 继承宿主；target 可写：

```json
{
  "preset": "single-phase-example",
  "runner": "codex",
  "codex": { "binary": "codex", "extraArgs": [] },
  "claude": { "binary": "claude", "extraArgs": [] }
}
```

queue item 可加 `"runner": "claude" | "codex"` 只覆盖该 item。preset 作者不要把某个 runner 的 CLI 细节写进 engine contract；若某个 preset 只支持特定 runner，把它写进该 preset 的 README / target workflow，并用 `doctor` / `status` 验证 target config 是否符合预期。

---

## 6. 最小 target 文件

跑一个新 preset 所需的最小 target（参见 `src/smoke.test.ts`）：

```
<target>/.coder-loop/
  workflow.md                   # 占位即可，preset 是否引用看 entry prompt
  runtime/
    config.json                 # { "preset": "<name>" }
    state.json                  # { version: 1, queue: [{<idField>, status}], recentRuns: [], current: null }
    shared.md                   # 占位
    issues/                     # 空目录
    evidence/                   # 空目录
    logs/                       # 空目录
```

`bun src/loop.ts --target-cwd <target> --check-runtime` 应当 exit 0、输出 `preset=<name>` 与 `queue=N, selected=<id>`。

---

## 7. Agent prompt 写作约定

引擎不要求 entry prompt 用任何特定结构。但 `gh-issue-pr-iteration` 用了一套约定（其他 preset 可借鉴）：

- 每个 fragment 文件以 `# Fragment: <id>` 起手。
- 入口 prompt 把 `{{PROMPT_FRAGMENT_INDEX}}` 嵌入做索引，agent 按 id 读 fragment。
- 每个 fragment 末尾有 `## Output verdict` 段，列出该 fragment 的可能出口 + 下一跳目标 fragment id。
- agent 按 verdict 链跑，trace 文件记录每个 fragment 的 verdict 出口，review 阶段据此审查。

这套约定让 review agent 能从 trace 复核 iter 的 fragment 链路是否合法。换 preset 时这套不强制——你也可以让 agent 跑单一 prompt 不分 fragment。

---

## 8. 改 preset 后必跑的自测

任何 preset 改动后：

```bash
cd /path/to/coder-loop
bun test                  # 跑 preset.test.ts / loop.test.ts / smoke.test.ts
bun x tsc --noEmit        # 类型检查（buildRuntimeBindings 双处一致性靠类型系统）
```

`preset.test.ts` 验证 bundled `gh-issue-pr-iteration` 的 fragment 集合 / 变量绑定 / phase 顺序与 src 一致；改默认 preset 后这个测试会先红，按 diff 修测试期望。
