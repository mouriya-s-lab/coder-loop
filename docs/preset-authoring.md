# Preset Authoring

写新 preset 或改现有 preset 的参考。

## 引擎做什么

引擎（`src/loop.ts`）是 preset 驱动的有限状态机：

1. 从 `preset.toml` 加载 item idField、status 集合、phase 列表、fragments
2. 从 target `.coder-loop/runtime/` 加载 config + state
3. 选首个 `continuable` status 的 item
4. 按 phase 顺序 spawn agent（渲染 entry prompt → 替换 `{{KEY}}` → 传给 runner）
5. 捕获 stdout/stderr 写 trace，每 phase 写 status JSON
6. Resume：崩溃重启时根据 `state.current.phase` 续跑

引擎不知道 phase 含义、status 语义、GitHub。所有领域判断（完成、正确、证据充分）都在 preset prompt 里。

## 最小 preset

结构：

```
presets/<name>/
  preset.toml        # 必需
  <phase>-entry.md   # 每个 phase 一个 entry prompt
  [fragments/...]    # 可选
```

示例（`presets/single-phase-example/`）：

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

Entry prompt：

```
hello {{ITEM_ID}} run={{RUN_ID}} cwd={{TARGET_CWD}}
```

验证：

```bash
bun src/loop.ts --target-cwd <target> --check-runtime
```

## `preset.toml` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | `^[a-zA-Z][a-zA-Z0-9_-]*$`，match 目录名 |
| `version` | int | 是 | schema 版本 |
| `[item].idField` | string | 是 | queue item 的 id 字段名 |
| `[statuses].continuable` | string[] | 是 | 引擎会调度的 status 集合 |
| `[statuses].terminal` | string[] | 是 | 引擎跳过的 status 集合（与 continuable 不可交集） |
| `[[phases]].name` | string | 是 | phase 名字 |
| `[[phases]].prompt` | string | 是 | entry prompt 模板路径（相对 preset.toml） |
| `[phases.variables]` | table | 是 | `{{KEY}}` 绑定表 |
| `[[phases]].trigger` | table | 否 | `{ afterPhase, whenStatus }` 条件触发 |
| `[[fragments]].id` | string | 是 | fragment 唯一标识 |
| `[[fragments]].path` | string | 是 | fragment 文件路径（相对 preset.toml） |
| `[agent].binary` | string | 是 | 保留字段，实际由 target runner selection 决定 |
| `[agent].attemptTimeoutSeconds` | number | 否 | 默认 3600 |

加载校验：phase 不重名、fragment id 不重复、continuable ∩ terminal = ∅、变量右侧 match `^(item|config|runtime)\.\w+$`。

## 变量绑定 DSL

`[phases.variables]` 右侧格式：`<prefix>.<field>`。

| 前缀 | 来源 | 缺失行为 |
|---|---|---|
| `item.<f>` | 当前 queue item 字段 | null/缺失 → `""` |
| `config.<f>` | target config.json 字段 | 缺失 → throw |
| `runtime.<k>` | 引擎计算值 | 不在白名单 → throw |

### `runtime.*` 白名单

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

注：`requireBrowserEvidence` 是 config binding（`config.requireBrowserEvidence`），不在 runtime 白名单内。

关键 key：

| Key | 说明 |
|---|---|
| `runIdGeneration` | `"new"` / `"resumed"` |
| `fragmentIndex` | 所有 fragments 的 markdown 表格（给 agent 当索引） |
| `issueKind` | `"code"` / `"comment"` / `"code-spike"` / `"blocked"` / `""`（从 GitHub label fetch） |

### 扩白名单

必须同时改 `src/loop.ts` 两处：

1. `RUNTIME_BINDING_KEYS` 数组
2. `buildRuntimeBindings` 返回对象

只改一处会 TypeScript 编译失败。改完跑 `bun test` + `bun run typecheck`。

## Target 选 preset

`.coder-loop/runtime/config.json`：

```json
{ "preset": "single-phase-example" }
```

或：

```json
{ "presetPath": "/abs/path/to/preset" }
```

不写时默认 `gh-issue-pr-iteration`。Runner 配置见 [README §Runner 选择](../README.md#runner-选择)。

## 最小 target 文件

```
<target>/.coder-loop/
  workflow.md                   # 占位即可
  runtime/
    config.json                 # { "preset": "<name>" }
    state.json                  # { "version": 1, "queue": [...], "current": null }
    shared.md                   # 占位
    issues/  evidence/  logs/   # 空目录
```

## 改 preset 后自测

```bash
bun test          # preset.test.ts 校验 fragment 集合 / 变量绑定 / phase 顺序
bun run typecheck # buildRuntimeBindings 双处一致性靠类型系统
```
