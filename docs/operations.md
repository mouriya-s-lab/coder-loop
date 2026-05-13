# 运维 / Debug Reference

读者：循环跑挂了 / 行为奇怪 / 想 reset 状态 / 想理解某轮跑哪儿去了的人。

读完后你能：读懂 `state.json` 每个字段、知道 trace 文件在哪、判断 `--check-runtime` 错码、理解 resume 触发条件、理解 `.dev-loop` sentinel 的删除时点。

不在范围内：写新 preset（看 [preset-authoring](./preset-authoring.md)）；`gh-issue-pr-iteration` 内部跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）。

---

## 1. `state.json` schema

文件：`<target>/.coder-loop/runtime/state.json`，UTF-8 JSON。

TypeScript shape（`src/loop.ts:55-62`）：

```typescript
type LoopState = {
  version: number          // 必须为 1
  queue: QueueItem[]
  repository: string | null
  baseBranch: string | null
  recentRuns: unknown[]    // 引擎不读不写，preset 可自由用
  current: CurrentRun | null
}

type QueueItem = {
  status: string                  // 必须落在 preset.statuses.{continuable, terminal} 任一集合
  attempts: number | null         // 非负整数或 null
  title: string | null
  priority: string | null         // gh-issue-pr-iteration: "high" | "medium" | "low" | null
  branch: string | null
  pr: number | null               // 正整数或 null
  lastRunId: string | null
  issueFile: string | null        // 相对 issueDir 的路径或绝对路径
  evidenceDir: string | null      // 相对 evidenceRootDir 或绝对
  agentCwd: string | null         // 绝对路径；spawn 子进程的 cwd。null → 等于 targetCwd。跨 repo 迭代用：指向外部 repo 的 checkout
  [<preset.item.idField>]: string | number   // 默认 "issue"
  [其他字段]: unknown              // preset 可加任意自定义字段
}

type CurrentRun = {
  phase: string                   // 必须落在 preset.phases.*.name
  runId: string                   // 非空
  startedAt: string               // ISO 8601 datetime
  [<preset.item.idField>]: string | number   // 当前正在跑的 item id
  [其他字段]: unknown
}
```

不变量（引擎在 `--check-runtime` / spawn 前强制）：

- `state.version === 1`；
- 若 config `repository` 非 null，`state.repository` 必须匹配；`baseBranch` 同理；
- `queue` 内 id 不可重复；
- 每个 queue item 的 `status` 必须落在 preset 的 status 集合内；
- 若 `state.current` 存在，其 `idField` 值必须能在 `queue` 找到匹配项，且该项的 status 必须落在 `statuses.continuable` 内；
- 若 `state.current.phase` 存在，必须落在 `preset.phases.*.name` 内；
- `state.current.startedAt` 必须 ISO 8601；
- 若 queue item 声明 `agentCwd`，必须是绝对路径，且必须是个已存在目录。

不变量违反 → `--check-runtime` 非零退出，引擎 spawn 前 abort。

---

## 2. Trace / 日志文件 layout

| 文件 | 路径模板 | 用途 | 何时写 |
|---|---|---|---|
| 当前迭代 trace | `<target>/.dev-trace.txt` | 当前 / 最近一轮的高层事件流，给人看 | 每轮覆盖 |
| 进程级日志 | `<target>/.coder-loop/runtime/logs/coder-loop-<pid>.<timestamp>.log` | 引擎自身 stderr/stdout | 每次 `coder-loop` 启动一份，append |
| Agent latest 输出 | `<logDir>/<runId>.<phase>.txt` | agent 当前轮全 stdout | spawn 时覆盖 |
| Agent attempt 归档 | `<logDir>/<runId>.<phase>.attempt-<timestamp>.<pid>.txt` | 每次 spawn 留底（防 latest 被下次覆盖） | 每次 spawn 新建 |
| Agent status | `<logDir>/<runId>.<phase>.status.json` | spawn 结束元数据（exitCode / signal / bytes / 错误） | spawn 退出时写 |

`<logDir>` = `<target>/.coder-loop/runtime/logs/`，引擎绝对路径暴露为 `runtime.logDir`。

`status.json` 字段（`src/loop.ts:156-169`）：

```json
{
  "label": "iteration",
  "pid": 12345,
  "startedAt": "2026-05-11T10:00:00.000Z",
  "lastEventAt": "2026-05-11T10:14:32.123Z",
  "outputPath": "/abs/path/<runId>.iteration.txt",
  "statusPath": "/abs/path/<runId>.iteration.status.json",
  "bytesWritten": 123456,
  "promptChars": 8901,
  "lastStream": "stdout",
  "exitCode": 0,
  "signal": null,
  "error": null
}
```

`exitCode != 0` 或 `signal != null` → spawn 异常（不是 agent 内部逻辑失败，agent 内部失败是 `exitCode == 0` 但 trace 末尾 verdict 是 blocked/failed）。

---

## 3. `--check-runtime` 错误分类

`coder-loop --target-cwd <path> --check-runtime` 执行 `checkRuntime`（`src/loop.ts:732-826`），失败 → exit 1，stderr 列出每条错误：

```
Runtime check failed: <N> error(s)
- <path>: <message>
- <path>: <message>
```

错误类别：

| 类别 | 示例 | 修法 |
|---|---|---|
| schema 版本错 | `state.version: must be 1` | state.json 顶层加 / 改 `"version": 1` |
| repo 不匹配 | `state.repository: must match configured repository <owner>/<repo>` | 改 state.json 或 config.json 二选一对齐 |
| base branch 不匹配 | `state.baseBranch: must match configured baseBranch main` | 同上 |
| 必需文件 / 目录缺失 | `targetCwd: directory does not exist` / `workflow: file does not exist` | bootstrap 缺失项（看 [operator-quickstart](./operator-quickstart.md#1-bootstrap-目标-repo-的-coder-loop)） |
| 路径越出 target | `state: must be inside <target>` | 不要把 state.json 放 target 外 |
| 路径越出 runtime 根 | `state: must be inside <target>/.coder-loop/runtime` | runtime 文件强制在 `runtime/` 内 |
| workflow 误入 runtime | `workflow: must be project policy outside .coder-loop/runtime` | workflow.md 留在 `.coder-loop/` 而不是 `.coder-loop/runtime/` |
| queue item id 缺失 / 重复 | `state.queue[N].issue: must be a non-empty string` / `duplicate id "42"` | 修 state.json 队列 |
| queue item status 非法 | `state.queue[N].status: status "foo" is not in preset.statuses` | 用 preset 声明的 status 字面量 |
| queue item 字段类型错 | `state.queue[N].attempts: must be null or a non-negative integer` | 改字段类型 |
| issueFile / evidenceDir 找不到 | `state.queue[N].issueFile: file does not exist` | 创建文件或把字段设回 null |
| agentCwd 不是绝对路径 / 不存在 | `state.queue[N].agentCwd: must be an absolute path` / `directory does not exist` | 改成已存在的绝对目录或设回 null（用 targetCwd） |
| current 引用不到 queue 项 | `state.current.issue: id "42" is not present in queue` | 队列没该 id，要么补回 queue，要么 `state.current = null` |
| current 引用了 terminal item | `state.current.issue: id "42" has non-continuable status done` | 已完成 item 不该是 current，`state.current = null` |
| current.phase 不在 preset | `state.current.phase: phase "foo" is not declared in preset.phases` | phase 字面量错，改为 preset 声明的名字 |
| current.runId 空 | `state.current.runId: must not be empty` | 给个非空 runId 或清 current |
| current.startedAt 格式错 | `state.current.startedAt: must be an ISO date string` | 用 `new Date().toISOString()` 格式 |
| preset 加载错 | `loadPreset throws`（preset.toml 字段缺失 / fragment 文件不可读 / 集合冲突等） | 看 stderr 具体错，按 [preset-authoring](./preset-authoring.md#3-presettoml-字段表) 修 preset |

exit 0 时 stderr 输出：

```
Runtime check passed: target=<abs>
Runtime check passed: repo=<owner>/<repo>          # 仅 config.repository 非 null 时
Runtime check passed: config=<abs> (json|toml)
Runtime check passed: state=<abs>
Runtime check passed: queue=<N>, selected=<id>|none
Runtime check passed: preset=<name>
```

---

## 4. Resume 行为

引擎在 spawn 前看 `state.current`（`src/loop.ts:411-466`）。决策表：

| `state.current` | 与选中 item id 关系 | `current.phase` | 结果 |
|---|---|---|---|
| `null` | n/a | n/a | 新 run；`runIdGeneration = "new"`；attempts++ 后从 `phases[0]` 跑 |
| 非 null | id 不匹配选中 item | n/a | 视为 stale，丢弃 `state.current`；按 `null` 路径处理 |
| 非 null | id 匹配选中 item | `iteration` | resume iteration；`runIdGeneration = "resumed"`；resumedFromPhase = "iteration"`；从 iter 入口重跑（attempts 不重新自增） |
| 非 null | id 匹配选中 item | `review` | 跳过 iter 直接 review；`runIdGeneration = "resumed"`；resumedFromPhase = "review"` |

Resume 时引擎注入：

- `runtime.runIdGeneration = "resumed"`
- `runtime.resumedFromPhase = <state.current.phase>`
- `runtime.resumedStartedAt = <state.current.startedAt>`

新 run：

- `runtime.runIdGeneration = "new"`
- `runtime.resumedFromPhase = ""`
- `runtime.resumedStartedAt = ""`

preset prompt 自行用这三个变量决定续跑细节（如「`runIdGeneration == resumed` 时不要重写 PR description，只 append 新一轮证据」）。引擎不识别这些领域分类。

### 强制重头：清 current

```bash
jq '.current = null' .coder-loop/runtime/state.json > /tmp/state.json && mv /tmp/state.json .coder-loop/runtime/state.json
coder-loop --target-cwd . --check-runtime          # 验证仍合法
```

### 强制 review 不重跑 iter：保留 current.phase = review

`state.current.phase == "review"` 自动跳过 iteration，按当前 iter 输出的 trace 进 review。常用于 review fragment bug fix 后重跑同一 issue 的 review。

---

## 5. `.dev-loop` Sentinel

文件：`<target>/.dev-loop`，引擎绝对路径暴露为 `runtime.loopFile`。

**创建时点**：`coder-loop` 进程启动、`--check-runtime` / `--dry-run` 通过、即将进入主循环时（`src/loop.ts:367-371`）。

内容（人类可读）：

```
started: 2026-05-11T10:00:00.000Z
pid: 12345
log: /tmp/coder-loop-XXX.log
cwd: /abs/path/to/target
state: /abs/path/.coder-loop/runtime/state.json
```

**检查时点**：每轮主循环入口（`src/loop.ts:375-407`）。删除 → 当前轮跑完后正常退出。

**不强杀 in-flight agent**：sentinel 检查在轮间隔；当前 spawn 的 agent 进程继续跑直到结束。要立即停 → `kill <pid>` 杀引擎 + agent。

**进程死后残留**：`.dev-loop` 不会自动清理（引擎正常退出时不删，crash 时更不删）。下次 `coder-loop` 启动会覆盖文件内容，无害。

---

## 6. CLI 全表

### 6.1 子命令（必须作为第一位置参数）

`coder-loop install / uninstall / doctor`（源：`src/install-commands.ts`）。详细行为见 [operator-quickstart §1](./operator-quickstart.md#1-bootstrap-目标-repo-的-coder-loop)：

| 子命令 | 用途 | 主要 flag |
|---|---|---|
| `install <target>` | 幂等四层 bootstrap | `--repo <slug>` `--preset <name>` `--force` `--dry-run` `--install-skills` `--skip-skill-check` |
| `uninstall <target>` | 仅删 `.claude/commands/dev-*.md` | — |
| `doctor <target>` | 只读四层体检 | `--repo <slug>` |

跑 loop 自身时**不**带子命令，直接进 6.2。

### 6.2 主循环 flags

`bun src/loop.ts [flags]` 或 `coder-loop [flags]`：

| Flag | 类型 | 默认 | 含义 |
|---|---|---|---|
| `<N>` | positional int | 无（无限） | 最大循环轮次；不传则无限 |
| `--target-cwd <path>` | string | `process.cwd()` | target 目录绝对 / 相对路径 |
| `--config <path>` | string | `<target>/.coder-loop/runtime/config.json` 或 `.toml` | config 文件路径 |
| `--workflow <path>` | string | config 字段或 `<target>/.coder-loop/workflow.md` | workflow 文件路径 |
| `--state <path>` | string | config 字段或 `<target>/.coder-loop/runtime/state.json` | state 文件路径 |
| `--repo <owner>/<repo>` | string | config 字段或 null | 校验 `state.repository` 一致；不会改写 state |
| `--require-browser-evidence` | bool flag | config 字段或 false | 暴露 `runtime.requireBrowserEvidence = "true"` 给 preset，preset prompt 自行决定是否拒收非浏览器证据；引擎自身不验证截图存在 |
| `--once` | bool flag | false | 跑 1 轮就退出（等价 `1`） |
| `--dry-run` | bool flag | false | 选中 item 后停（不 spawn agent，不写 trace） |
| `--check-runtime` | bool flag | false | 校验 schema 后退出，不 spawn agent |

flag 冲突优先级：CLI > config > 默认。

### 6.3 Agent 进程与监控（非 CLI 参数，但运维需要知道）

- **Per-run events JSONL**：每次 loop 启动会写 `<target>/.coder-loop/runtime/events/<runId>.jsonl`，行级 JSON 事件（`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.close` / `watchdog.fire` / `queue.terminal`）。`runId` 在 `state.current.runId`。外部 watcher（supervisor / 下游 agent）订阅这条流而不是 scrape stdout：`tail -F <runId>.jsonl`。
- **Post-summary watchdog**：iteration agent 输出 `ITERATION SUMMARY` 后 5 分钟未自然退出，引擎发 SIGTERM；再 30 秒后 SIGKILL。事件流写一条 `watchdog.fire`。这是引擎层兜底，防止 wedged agent 卡死循环。
- **Agent --resume**：claude CLI spawn 中断（5xx / 网络）时引擎自动 `--resume <sessionId>` 续跑，最多重试若干次后退避。sessionId 索引在 `<logDir>/<runId>.<phase>.sessions.jsonl`。

---

## 7. 常用 debug 操作

### 看上一轮跑去哪了

```bash
ls -t .coder-loop/runtime/logs/ | head
tail -50 .coder-loop/runtime/logs/<runId>.iteration.txt    # iter trace 末尾
cat .coder-loop/runtime/logs/<runId>.iteration.status.json # spawn 元数据
```

### 把卡住的 current run 清掉，从队首重新选

```bash
jq '.current = null' .coder-loop/runtime/state.json > /tmp/state.json && mv /tmp/state.json .coder-loop/runtime/state.json
coder-loop --target-cwd . --check-runtime
```

### 把某 issue 从 done 拉回 queued 重跑

```bash
jq '.queue |= map(if .issue == 42 then .status = "queued" | .attempts = 0 else . end) | .current = null' \
    .coder-loop/runtime/state.json > /tmp/state.json && mv /tmp/state.json .coder-loop/runtime/state.json
```

### 看活着的 coder-loop 进程

```bash
ps aux | grep coder-loop
cat .dev-loop      # pid / cwd / log 都在里面
```

### 把 state reset 到空队列（核手段）

```bash
cat > .coder-loop/runtime/state.json <<EOF
{ "version": 1, "queue": [], "repository": null, "baseBranch": null, "recentRuns": [], "current": null }
EOF
```

⚠ 这会丢失所有进度（除了 GitHub 上已落地的 PR / comment 等真持久状态）。

---

## 8. 已知坑

- **`status.json` 显示 exitCode=0 但 trace 末尾是 blocked** —— spawn 成功，agent 内部逻辑选了 blocked verdict。看 trace 末尾的 fragment verdict，不是看 exitCode。
- **`--check-runtime` 报 `workflow: must be project policy outside .coder-loop/runtime`** —— 你把 `workflow.md` 放进 `runtime/` 了。它应在 `.coder-loop/workflow.md`（runtime 的同级父）。
- **resume 后 attempts 不变** —— 这是 spec 行为，resume 不算新 attempt；只有 `current = null` 的新 run 才 attempts++。
- **删了 `.dev-loop` 但循环又跑了一轮** —— sentinel 检查在轮间隔，已经 spawn 的 agent 跑完才退出。
- **`gh issue view --json labels` 调用失败** —— 引擎在 spawn 前 fetch `ISSUE_KIND`，gh auth 失效或网络异常会导致 spawn 直接 abort，stderr 显示 `gh issue view exited <code>` 或 `failed to spawn`。
