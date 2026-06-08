# 运维 / Debug Reference

读者：循环跑挂了 / 行为奇怪 / 想 reset 状态 / 想理解某轮跑哪儿去了的人。

读完后你能：先用稳定 CLI 运维面判断 target 是否健康、central daemon 是否活着、当前 chain / queue / item 正在做什么；必要时再下钻到 SQLite runtime、events JSONL、agent `status.json` 等文件。

不在范围内：写新 preset（看 [preset-authoring](./preset-authoring.md)）；`gh-issue-pr-iteration` 内部跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）。

---

## 1. 稳定运维 API 优先

operator / supervisor 的默认入口是 `coder-loop` 自己暴露的只读或受控子命令，不是直接拼 runtime 文件路径。

| 场景 | 首选命令 | 何时用 |
|---|---|---|
| 初始化 target | `coder-loop install <target> --repo <owner>/<repo>` | 幂等写 slash command、runtime layout、config、workflow starter，并检查 GitHub label / PATH / skill |
| 体检 target | `coder-loop doctor <target> --repo <owner>/<repo>` | 只读检查 bootstrap layers 和 live runtime health |
| 读机器状态 | `coder-loop status <target> --json` | supervisor / script 读取当前 config/state/queue/current/events/process snapshot |
| 管理 central daemon | `coder-loop daemon up/down/status/start/stop/restart <target>` | 管理全局 daemon socket 与 target chain；避免手写 `nohup` / PID 归属逻辑 |
| 管理 chain | `coder-loop chain create/list/status/delete ...` | 直接操作 centralized coder-loop chain |
| 管理 item | `coder-loop item add/list/update ...` | 直接操作 centralized chain item |
| 人类快捷入口 | `/dev-loop [N]` | target 内通过 slash command 调用 daemon API，`N` 会传给 `--max-iterations` |

常规排障顺序：

```bash
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json | jq '.state.kind, .queue, .current, .processes.live'
coder-loop daemon status /path/to/target --json | jq '.processes'
```

判断 / 控制 daemon：

```bash
coder-loop daemon up --json                      # 启动 central daemon（需要时）
coder-loop daemon status /path/to/target --json  # 读 daemon + target chain 状态
coder-loop daemon start /path/to/target          # 解析 target chain 并确认 central daemon 可调度
coder-loop daemon stop /path/to/target           # 通过 central daemon 删除/停止该 target chain
coder-loop daemon restart /path/to/target        # 解析 chain 并确认 central daemon 可用；不是旧式 PID restart
coder-loop daemon down --json                    # 关闭 central daemon socket 服务
```

`daemon up/down` 是 central daemon 生命周期。`daemon start/stop/restart <target>` 是 target-aware wrapper：先解析 target 对应的 centralized chain，再通过 daemon socket 操作或校验 chain。`daemon start` 对已存在/已运行 target 幂等；`daemon stop` 当前实现调用 `chain.delete` 标记 target chain 删除；`daemon restart` 不拼接旧 stop/start JSON，也不重启某个 target-owned PID，而是确认全局 daemon 可用并返回单个 JSON object。

`status <target> --json` 是 supervisor 的稳定读取契约。它会在 config/state 缺失或损坏时仍输出 JSON，让外部逻辑根据 `state.kind` 分支，而不是从 stderr 猜测失败类型。当前顶层字段：

| 字段 | 含义 |
|---|---|
| `target` | target cwd、config/workflow/shared/runtime/log 路径、preset metadata、runner policy |
| `state` | `ok` 与 `kind` discriminant；如 `ok`、`missing-config`、`invalid-config`、`missing-preset`、`invalid-preset`、`missing-state`、`invalid-state`、`invalid-runtime` |
| `queue` | 队列总数、按 status 计数、continuable/terminal 数、当前 selected item |
| `runs` | SQLite `runs.status` 聚合出的 run 总数与 phase × status 计数 |
| `current` | 当前 run、item、phase status JSON snapshot |
| `events` | 当前或最近 run 的 events JSONL 路径、最近事件、解析错误 |
| `processes` | central/process scan 结果：`live[]` 与 `scanError` |

Runner 选择也在 `status` 中显式暴露：

| JSON path | 含义 |
|---|---|
| `target.runner.hostDefault` | 当前宿主推断出的 runner 诊断信息；不决定 iteration 默认值 |
| `target.runner.phases` | 每个 phase 的 preset / engine-builtin default runner |
| `target.runner.default` | 默认执行 phase runner；来源通常是 preset |
| `target.runner.reviewDefault` | review phase runner；model 跟随 `claude.model` / `codex.model` config，源码不再强制覆盖 |
| `queue.selected.phaseRunners` | 当前 selected item 逐 phase effective runner；允许 item override 的 phase 可显示 `source=queue` |
| `queue.selected.runner` | 当前 selected item 的默认执行 phase runner |
| `queue.selected.reviewRunner` | 当前 selected item 的 review phase runner；不受 queue item `runner` 影响 |
| `current.runner` | 当前 phase 的实际 runner；没有 current 时为 `null` |
| `current.phaseStatus.value.runner` / `.model` | 已落盘 phase status 里记录的 runner kind 与 model；旧 status 文件可能为 `null` |

Runtime 文件仍是必要的 debug reference，但它们不是外层长期依赖的首选 API。只有在 `doctor/status/daemon` 输出指出某个局部异常，或需要人工恢复状态时，才直接编辑/读取下面的文件。

---

## 2. Fallback: centralized SQLite state

当前实现的持久来源是 central SQLite store，而不是 target-local JSON state 文件。默认路径：

```text
~/.coder-loop/loop-data/db.sqlite
```

也可通过 `--loop-data-root <dir>` 改变 loop-data 根。`--check-runtime` 会把实际 DB 路径打印为 `state=<abs-db-file>`，并打印解析出的 `chain=<name>`。

内存中的 `LoopState` shape 仍是引擎内部契约：

```typescript
type LoopState = {
  version: number
  queue: QueueItem[]
  repository: string | null
  baseBranch: string | null
  recentRuns: JsonValue[]
  current: CurrentRun | null
}
```

但 operator 不应直接写 DB 表作为常规操作。优先使用：

```bash
coder-loop status <target> --json
coder-loop chain status <chain-name> --json
coder-loop item list --chain <chain-name> --json
coder-loop item update ...
coder-loop queue unblock <target> --issue <id> --start-daemon
```

如果必须做人工恢复，先备份 DB，再用 `status` / `doctor` 定位到具体 chain 与 item；只修被诊断出的字段。旧文档里的 target-local `.coder-loop/runtime/state.json` 属于 legacy/debug 语境，不是新版 centralized chain runtime 的一线状态源。

`--check-runtime` 仍会检查这些不变量：

- `state.version === 1`；
- centralized chain 的 `repository` / `baseBranch` 是功能性 chain identity；prompt 专用值通过 preset 的透明 `config.*` binding 读取；
- `queue` 内 id 不可重复；
- 每个 queue item 的 `status` 必须落在 preset 的 status 集合内；
- 若 `current` 存在，其 id 必须能在 `queue` 找到匹配项，且该项必须是 continuable；
- 若 `current.phase` 存在，必须落在 `preset.phases.*.name` 内；
- 若 queue item 声明 `agentCwd`，必须是绝对路径，且必须是个已存在目录；
- centralized chain 必须是 active，且 chain runtime layout 必须能解析。

exit 0 时 stderr 输出类似：

```text
Runtime check passed: target=<abs>
Runtime check passed: repo=<owner>/<repo>          # 来自 centralized chain identity
Runtime check passed: config=<abs> (json|toml)
Runtime check passed: state=<abs-loop-data-root>/db.sqlite
Runtime check passed: chain=<chain-name>
Runtime check passed: queue=<N>, selected=<id>|none
Runtime check passed: preset=<name>
```

---

## 3. Fallback: events / agent 日志 layout

`<logDir>` 在 centralized chain runtime 中通常是该 chain 的 runs 目录，具体路径以 `coder-loop status <target> --json` 的 `target.logDir` / `events.path` / `current.phaseStatus.value.*Path` 为准。

| 文件 | 路径模板 | 用途 | 何时写 |
|---|---|---|---|
| Per-run events JSONL | `<logDir>/<runId>/events.jsonl` | 行级 JSON 事件：`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.timeout` / `attempt.close` / `watchdog.fire` / `queue.terminal` | run 期间 append |
| Agent stdout stream | `<logDir>/<runId>/<phase>/stdout.jsonl` | agent stdout stream / JSONL 输出 | spawn 时写入 |
| Agent stderr | `<logDir>/<runId>/<phase>/stderr.txt` | agent stderr | spawn 时写入 |
| Agent status | `<logDir>/<runId>/<phase>/status.json` | spawn 结束元数据（exitCode / signal / bytes / runner / model / sessionId / terminated） | spawn 退出时写 |
| Agent sessions | `<logDir>/<runId>/<phase>/sessions.jsonl` | 可 resume 的 session id 索引 | 观察到 session 时 append |

`status.json` 字段由 `AgentRunStatus` 定义，包含：`label`、`runner`、`model`、`pid`、`startedAt`、`lastEventAt`、`outputPath`、`statusPath`、`bytesWritten`、`promptChars`、`lastStream`、`exitCode`、`signal`、`error`、`sessionId`、`terminated`。

`runner` / `model` 为本次 phase 使用的 runner kind 与模型（旧文件可能缺失）。`exitCode != 0` 或 `signal != null` 说明 spawn 异常；agent 内部业务失败通常表现为 exit 0 但 phase verdict / issue state 进入 blocked 或 failed 分支。

外部 watcher 优先 poll `coder-loop status <target> --json`。需要非轮询事件流时，用 `status.events.path` 返回的路径：

```bash
coder-loop status /path/to/target --json | jq -r '.events.path'
tail -F "$(coder-loop status /path/to/target --json | jq -r '.events.path')"
```

---

## 4. `--check-runtime` 错误分类

`coder-loop doctor <target>` 已经覆盖 bootstrap 与 live runtime health。只想校验 target runtime schema、不查 PATH / GitHub / skill 时，再用：

```bash
coder-loop --target-cwd <path> --check-runtime
```

它执行 `checkRuntime`，失败 → exit 1，stderr 列出每条错误：

```text
Runtime check failed: <N> error(s)
- <path>: <message>
- <path>: <message>
```

常见错误：

| 类别 | 示例 | 修法 |
|---|---|---|
| schema 版本错 | `state.version: must be 1` | 通过 chain/item API 或备份 DB 后修正 state snapshot |
| chain 选择不匹配 | `SQLite chain "x" repository is owner/a, expected owner/b` | 指定正确 `--chain`，或修正 centralized chain identity |
| 必需文件 / 目录缺失 | `targetCwd: directory does not exist` / `workflow: file does not exist` | bootstrap 缺失项，先跑 `coder-loop install` / `doctor` |
| workflow 误入 runtime | `workflow: must be project policy outside .coder-loop/runtime` | workflow.md 留在 `.coder-loop/` 而不是 runtime 内 |
| queue item id 缺失 / 重复 | `state.queue[N].issue: must be a non-empty string or finite number` / `duplicate id "42"` | 修 chain item |
| queue item status 非法 | `state.queue[N].status: status "foo" is not in preset.statuses` | 用 preset 声明的 status 字面量 |
| chain handoff / runtime 目录缺失 | `sharedContextPath: missing file: .../shared.md` / `evidenceRootDir: missing directory: .../evidence` | 启动/重启 daemon 让它补齐 chain runtime layout，或手动修复对应 chain 目录 |
| issueFile / evidenceDir 越界 | `state.queue[N].issueFile: must resolve inside .../issues` | 清空可选 `issueFile`，或改成 chain root 下的相对 attachment 路径 |
| agentCwd 不是绝对路径 / 不存在 | `state.queue[N].agentCwd: must be an absolute path` / `directory does not exist` | 改成已存在的绝对目录或设回 null |
| current 引用不到 queue 项 | `state.current.issue: id "42" is not present in queue` | 补回 queue item 或清 current |
| current 引用了 terminal item | `state.current.issue: id "42" has non-continuable status done` | terminal item 不该是 current，清 current |
| current.phase 不在 preset | `state.current.phase: phase "foo" is not declared in preset.phases` | phase 字面量改为 preset 声明的名字 |
| current.runId 空 / startedAt 错 | `state.current.runId: must not be empty` / `must be an ISO date string` | 修 current 或清 current |
| centralized chain 非 active | `chain.status: must be active` | 用 chain API 选择/恢复 active chain |
| preset 加载错 | `loadPreset throws` | 看 stderr 具体错，按 [preset-authoring](./preset-authoring.md) 修 preset |

---

## 5. Resume 行为

引擎在 spawn 前看 `state.current`。决策表：

| `state.current` | 与选中 item id 关系 | `current.phase` | 结果 |
|---|---|---|---|
| `null` | n/a | n/a | 新 run；`runIdGeneration = "new"`；attempts++ 后从 `phases[0]` 跑 |
| 非 null | id 不匹配选中 item | n/a | 视为 stale，丢弃 current；按新 run 处理 |
| 非 null | id 匹配选中 item | iteration phase | resume iteration；`runIdGeneration = "resumed"`；从 iter 入口重跑（attempts 不重新自增） |
| 非 null | id 匹配选中 item | review phase | 跳过 iter 直接 review；`runIdGeneration = "resumed"` |

Resume 时引擎注入：

- `runtime.runIdGeneration = "resumed"`
- `runtime.resumedFromPhase = <state.current.phase>`
- `runtime.resumedStartedAt = <state.current.startedAt>`

新 run：

- `runtime.runIdGeneration = "new"`
- `runtime.resumedFromPhase = ""`
- `runtime.resumedStartedAt = ""`

需要强制重头或强制 review 时，优先通过 chain/item/status API 做恢复；没有 API 覆盖时才在备份 SQLite 后手工修 current。

---

## 6. CLI 全表

### 6.1 子命令（必须作为第一位置参数）

`coder-loop install / uninstall / doctor / status / daemon / chain / item / queue`。子命令 help 可用：

```bash
coder-loop daemon --help
coder-loop chain --help
coder-loop item --help
```

当前 top-level `--help` 不可用；需要查某类命令时进对应子命令 help。

| 子命令 | 用途 | 主要 flag |
|---|---|---|
| `install <target>` | 幂等 bootstrap | `--repo <slug>` `--preset <name>` `--force` `--dry-run` `--install-skills` `--skip-skill-check` |
| `uninstall <target>` | 仅删 `.claude/commands/dev-*.md` | — |
| `doctor <target>` | 只读体检 + live runtime health | `--repo <slug>` |
| `status <target> --json` | 只读 JSON runtime/process snapshot | `--config <path>` `--loop-data-root <dir>` `--chain <name>` |
| `daemon up` | 运行 centralized daemon process | `--json` `--loop-data-root <dir>` |
| `daemon down` | 通过 Unix socket 要求 centralized daemon 退出 | `--json` `--loop-data-root <dir>` |
| `daemon status <target> --json` | daemon 视角 JSON snapshot | `--config <path>` `--loop-data-root <dir>` `--chain <name>` |
| `daemon start <target>` | 解析 target chain 并确认 daemon 可调度；已运行/已存在时幂等返回 | `--config <path>` `--max-iterations <N>` `--dry-run` |
| `daemon stop <target>` | 解析 target chain 并调用 `chain.delete` | `--config <path>` `--dry-run` |
| `daemon restart <target>` | 解析 target chain 并确认 central daemon 可用，输出单个 JSON object | `--config <path>` `--max-iterations <N>` `--dry-run` |
| `chain create/list/status/delete` | centralized chain CRUD | 看 `coder-loop chain --help` |
| `item add/list/update` | centralized chain item CRUD | `--field-json '{"branch":"issue-1","pr":2}'` 写 preset 声明的透明 item 字段；其他看 `coder-loop item --help` |
| `queue unblock <target>` | 将 preset 声明的 unblockable terminal item 恢复到 `statuses.entry` 并清除 blocker metadata；`gh-issue-pr-iteration` 用于 `kind:blocked` accept 后反向解除源仓 block | `--issue <id>` `--start-daemon` |

### 6.2 主循环 flags

`bun src/loop.ts [flags]` 或 `coder-loop [flags]`：

| Flag | 类型 | 默认 | 含义 |
|---|---|---|---|
| `<N>` | positional int | 无（无限） | 最大循环轮次；不传则无限 |
| `--target-cwd <path>` | string | `process.cwd()` | target 目录绝对 / 相对路径 |
| `--config <path>` | string | target runtime config | config 文件路径 |
| `--workflow <path>` | string | config 字段或 `<target>/.coder-loop/workflow.md` | workflow 文件路径 |
| `--loop-data-root <dir>` | string | `~/.coder-loop/loop-data` | centralized DB/socket/runtime 根 |
| `--chain <name>` | string | target/config 推导 | 指定 centralized chain |
| `--once` | bool flag | false | 跑 1 轮就退出（等价 `1`） |
| `--dry-run` | bool flag | false | 选中 item 后停（不 spawn agent） |
| `--check-runtime` | bool flag | false | 校验 schema 后退出，不 spawn agent |

flag 冲突优先级：CLI > config > 默认。

### 6.3 Agent 进程与监控（fallback reference）

- **Per-run events JSONL**：`<logDir>/<runId>/events.jsonl`，路径由 `coder-loop status <target> --json` 的 `events.path` 暴露。
- **Absolute attempt timeout**：每个 agent attempt 默认 60 分钟绝对上限，可在 preset.toml `[agent] attemptTimeoutSeconds = <seconds>` 覆盖。到期且尚未观察到当前 phase 的 `summaryMarker` 时，引擎对 agent 进程组发 SIGTERM，5 秒后仍未退出则 SIGKILL；attempt 记录 `terminated.kind = "timeout"`，事件流写 `attempt.timeout`。
- **Post-summary watchdog**：当前 phase 声明 `summaryMarker` 且 agent stdout 出现该 marker 后，若 agent 未自然退出，引擎按 watchdog 配置发 SIGTERM，再发 SIGKILL。未声明 `summaryMarker` 的 phase 不启用 post-summary watchdog。事件流写 `watchdog.fire`。
- **Agent --resume**：Claude CLI spawn 中断（5xx / 网络）时引擎自动 `--resume <sessionId>` 续跑，sessionId 索引在 `<logDir>/<runId>/<phase>/sessions.jsonl`。

---

## 7. 常见排障流程

### 7.1 status 显示 missing/invalid runtime

```bash
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json | jq '.state, .target, .queue.selected'
coder-loop --target-cwd /path/to/target --check-runtime
```

按 `doctor/status/check-runtime` 报出的具体层修，不要先手写 DB 或删 runtime。

### 7.2 当前 item 卡住

```bash
coder-loop status /path/to/target --json | jq '.current, .events.latest, .processes.live'
# 再按 status.current.phaseStatus.value.outputPath/statusPath 定位 agent 输出
```

若多信号确认 wedged，先用 daemon/chain API 停或删除 target chain；不要只杀 child agent。

### 7.3 需要看当前 run 的 agent 输出

```bash
STATUS_JSON=$(coder-loop status /path/to/target --json)
echo "$STATUS_JSON" | jq -r '.current.phaseStatus.value.outputPath'
echo "$STATUS_JSON" | jq -r '.current.phaseStatus.value.statusPath'
echo "$STATUS_JSON" | jq -r '.events.path'
```

然后读取对应 `stdout.jsonl`、`status.json`、`events.jsonl`。

### 7.4 队列完全空 / 没有 selected

```bash
coder-loop status /path/to/target --json | jq '.queue'
coder-loop item list --chain <chain-name> --json
```

确认是不是所有 item 已 terminal；如果需要追加 work，用 planning / chain handoff 或 `coder-loop item add`，不要直接拼旧 JSON 文件。

---

## 8. 常见坑

- **把 `.coder-loop/runtime/` 入了 git** → runtime / logs / handoff 进了 PR diff；把整个 runtime 目录加 `.gitignore` 后 `git rm --cached -r .coder-loop/runtime/`。
- **`.coder-loop/workflow.md` 缺失或没入仓** → iter/review agent 读不到项目工作方式，行为退化为 bundled preset 默认值，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → `iter/read-context` 会以 `infrastructure_failure` 出局，agent 输出里能看到 `gh auth status` 失败回显。
- **chain identity 与目标 repo 不一致** → `status` / `daemon start` 会在解析 chain 时报告 repository/baseBranch 不匹配；指定正确 `--chain`，或修正 centralized chain identity。
- **只看日志文件、不看 status** → 新版 authoritative path 来自 central chain；先看 `status` 返回的路径，避免按旧 flat-log layout 找错文件。
