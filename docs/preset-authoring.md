# Preset Authoring

写新 preset 或改现有 preset 的参考。

## 引擎做什么

引擎（`src/loop.ts`）是 preset 驱动的有限状态机。运行时行为完全由 preset 定义：

1. 从 `preset.toml` 加载 item idField、status 集合（continuable / terminal）、phase 列表（名字 + prompt 模板 + 变量绑定）、fragments、agent 配置
2. 从 target `.coder-loop/runtime/` 加载 config + state
3. 选首个 status 在 `continuable` 集合内的 item
4. 按 phase 顺序 spawn agent：读 entry prompt 模板 → 替换 `{{KEY}}` 为变量绑定解析值 → 构造 runner CLI 命令 → spawn 子进程 → 捕获 stdout/stderr 到 trace 文件
5. Phase 结束后检查 trigger phases：如果某 trigger 的 `afterPhase` 匹配刚跑完的 phase 且 item 当前 status 匹配 `whenStatus`，spawn 该 trigger phase
6. Item 进入 terminal status 后跳到下一个 item
7. Resume：崩溃重启时根据 `state.current.phase` 决定从哪个 phase 续跑

引擎不知道 phase 含义、status 语义、GitHub。所有领域判断都在 preset prompt 和 fragments 里。

## Preset 目录结构

```
presets/<name>/
  preset.toml          # 必需：schema 定义
  <phase>-entry.md     # 每个 phase 一个 entry prompt 模板
  fragments/           # 可选：prompt 片段，给 agent 当参考
    common/
    iter/
    review/
    ...
```

## `preset.toml` 字段

```toml
name    = "my-preset"           # ^[a-zA-Z][a-zA-Z0-9_-]*$，必须匹配目录名
version = 1                     # schema 版本，固定 1

[item]
idField = "issue"               # queue item 的 id 字段名

[statuses]
continuable = ["queued", "changes_requested"]   # 引擎会调度的 status
terminal    = ["done", "blocked", "skipped"]     # 引擎跳过的 status

[[phases]]
name   = "iteration"
prompt = "iteration-entry.md"   # 相对 preset.toml 的路径
  [phases.variables]
  ISSUE         = "item.issue"
  REPO          = "config.repository"
  RUN_ID        = "runtime.runId"
  TARGET_CWD    = "runtime.targetCwd"
  AGENT_CWD     = "runtime.agentCwd"
  ISSUE_KIND    = "runtime.issueKind"

[[phases]]
name   = "review"
prompt = "review-entry.md"
  [phases.variables]
  ISSUE         = "item.issue"
  RUN_ID        = "runtime.runId"

[[phases]]
name   = "blocked-responder"
prompt = "blocked-responder-entry.md"
  [phases.trigger]
  afterPhase = "review"         # 在哪个 phase 之后触发
  whenStatus = "blocked"        # item status 匹配时才触发
  [phases.variables]
  ISSUE         = "item.issue"

[[fragments]]
id   = "read-context"           # 唯一标识
path = "fragments/common/read-context.md"   # 相对路径

[[fragments]]
id   = "review-protocol"
path = "fragments/review/review-protocol.md"

[agent]
binary                = "codex"   # 保留字段，实际由 target runner selection 决定
attemptTimeoutSeconds = 3600      # 默认 3600，单次 attempt 超时（秒）
```

### 加载校验规则

- phase name 不重名
- fragment id 不重复
- continuable ∩ terminal = ∅
- 变量右侧格式 `^(item|config|runtime)\.\w+$`
- 每个 phase 的 prompt 文件存在

## 变量绑定 DSL

`[phases.variables]` 的右侧格式：`<prefix>.<field>`。

| 前缀 | 来源 | 缺失行为 |
|---|---|---|
| `item.<f>` | 当前 queue item 的字段 | null 或缺失 → `""` |
| `config.<f>` | target config.json 的字段 | 缺失 → throw |
| `runtime.<k>` | 引擎计算值 | 不在白名单 → throw |

### `runtime.*` 白名单（24 个 key）

```
runId              targetCwd           agentCwd
workflowPath       sharedContextPath   stateDbPath
currentIssueFile   issueDir            evidenceDir
evidenceRootDir    logDir              loopDataRoot
chainName          chainDir            runDir
eventsFile         iterationStdoutFile presetDir
fragmentIndex      runIdGeneration     resumedFromPhase
resumedStartedAt   issueKind
```

关键 key 说明：

| Key | 值 |
|---|---|
| `runIdGeneration` | `"new"` 或 `"resumed"` |
| `resumedFromPhase` | resume 时来源 phase 名，新 run 为 `""` |
| `fragmentIndex` | 所有 fragments 的 markdown 表格（`| id | path |`），注入 prompt 给 agent 当索引 |
| `issueKind` | 从 GitHub label 解析：`"code"` / `"comment"` / `"code-spike"` / `"blocked"` / `""` |
| `stateDbPath` | 集中 SQLite DB 路径 |
| `chainName` / `chainDir` | 当前 chain 名和运行时目录 |
| `iterationStdoutFile` | iteration phase 的 stdout.jsonl 路径（review 读它审证据） |

注意：`requireBrowserEvidence` 是 config 绑定（`config.requireBrowserEvidence`），不在 runtime 白名单内。

### 扩展白名单

必须同时改 `src/loop.ts` 两处：

1. `RUNTIME_BINDING_KEYS` 数组
2. `buildRuntimeBindings` 函数的返回对象

TypeScript 类型系统强制两处一致——只改一处会编译失败。改完跑 `bun run typecheck && bun test`。

## Prompt 模板

Entry prompt 是 markdown 文件，用 `{{KEY}}` 占位符引用变量绑定：

```markdown
你是 iteration agent。

当前 issue: #{{ISSUE}}
仓库: {{REPO}}
工作目录: {{AGENT_CWD}}
Issue kind: {{ISSUE_KIND}}

## Fragment 索引

{{FRAGMENT_INDEX}}

## 任务

根据 issue 要求写代码、跑测试、开 PR。
```

渲染规则：引擎读模板文件 → 遍历 phase 的 variables 表 → 每个 `KEY` 替换为解析后的值。未在 variables 里声明的 `{{KEY}}` 不会被替换（原样保留）。

## Fragment 机制

Fragments 是 prompt 的辅助参考文件，不直接注入 prompt 文本。引擎把所有 fragment 的 `| id | path |` 表格渲染为 `runtime.fragmentIndex`，注入 prompt 后由 agent 自己决定读哪些 fragment。

Fragment 文件可以引用其他 fragment 的内容。Agent 通过 `--add-dir` 获得 preset 目录的读权限。

## Trigger Phase

普通 phase 按顺序执行。Trigger phase 只在条件满足时执行：

```toml
[[phases]]
name = "blocked-responder"
prompt = "blocked-responder-entry.md"
  [phases.trigger]
  afterPhase = "review"       # 在 review phase 完成后检查
  whenStatus = "blocked"      # 此时 item status 必须是 "blocked"
```

引擎在每个非 trigger phase 完成后，遍历所有带 trigger 的 phase，按顺序执行条件匹配的。一个 phase 可以改变 item status（通过修改 state），后续 trigger 会看到更新后的 status。

## Target 选 preset

`.coder-loop/runtime/config.json`：

```json
{ "preset": "my-preset" }
```

或绝对路径：

```json
{ "presetPath": "/abs/path/to/preset" }
```

不写时默认 `gh-issue-pr-iteration`。

## 最小 target 文件

```
<target>/.coder-loop/
  workflow.md                   # 占位即可，但必须存在
  runtime/
    config.json                 # { "preset": "<name>" }
```

集中 daemon 架构下，`install` 会创建 chain 和 runtime skeleton 在 `~/Ext/loop-data/chains/<name>/`（issues/、evidence/、runs/、daemon/、shared.md）。Legacy `runtime/state.json` 仅在直接引擎调用时需要。

## 验证

```bash
# 检查 preset 加载 + runtime 校验
bun src/loop.ts --target-cwd <target> --check-runtime

# 跑 preset 相关测试
bun test                  # preset.test.ts 校验 fragment 集合 / 变量绑定 / phase 顺序
bun run typecheck         # buildRuntimeBindings 一致性靠类型系统
```

## 最小 preset 示例

目录 `presets/single-phase-example/`：

**preset.toml**：

```toml
name    = "single-phase-example"
version = 1

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
attemptTimeoutSeconds = 3600
```

**run-entry.md**：

```
hello {{ITEM_ID}} run={{RUN_ID}} cwd={{TARGET_CWD}}
```

## `gh-issue-pr-iteration` Preset 概况

内置生产 preset。3 个 phase（iteration、review、blocked-responder），48 个 fragment 分布在：

- `fragments/common/` — 共享上下文（read-context、evidence 规则、项目约定）
- `fragments/plan/` — 计划阶段参考
- `fragments/iter/` — iteration agent 行为定义
- `fragments/review/` — review agent 行为定义（verdict 协议、证据审核规则）

Variables 绑定 20+ 个 key 到 item / config / runtime 值。Review phase 通过 `runtime.iterationStdoutFile` 读取 iteration 的完整输出来审核证据。

详见 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)。
