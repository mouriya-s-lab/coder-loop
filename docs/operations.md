# 运维 / Debug Reference

读者：循环跑挂了 / 行为奇怪 / 想 reset 状态 / 想理解某轮跑哪儿去了的人。

读完后你能：先用稳定 CLI 运维面判断 target 是否健康、central daemon 是否活着、当前 chain / queue / item 正在做什么；必要时再下钻到 SQLite runtime、events JSONL、agent `status.json` 等文件。

不在范围内：写新 preset（看 [preset-authoring](./preset-authoring.md)）；`gh-issue-pr-iteration` 内部跳转（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）。

---

## 1. 稳定运维 API 优先

operator / supervisor 的默认入口是 `coder-loop` 自己暴露的只读或受控子命令，不是直接拼 runtime 文件路径。

| 场景 | 首选命令 | 何时用 |
|---|---|---|
| 接入 target | `coder-loop chain create <name> --config-json '{"repository":"<owner>/<repo>"}' --preset <name>` | 中央 daemon socket 一次写入 chain metadata；target 目录零文件依赖 |
| 体检 target | `coder-loop doctor <target> --repo <owner>/<repo>` | 只读检查 operator 机器先决条件 + live runtime health（零 target 文件检查） |
| 读机器状态 | `coder-loop status <target> --json` | supervisor / script 读取当前 state/queue/current/events/process snapshot |
| 管理 central daemon | `coder-loop daemon <up [--detach] \| down>` | `up --detach` fork + unref 起后台（写 pid，立即返回）；纯前台去掉 `--detach`（供 launchd / systemd / e2e）；`down` 走 socket 关机 |
| 查中央 daemon 存活 | `coder-loop status --loop-data-root <dir> --json` | 无 `<target>` → 只返 daemon pid / socket / activeRuns |
| 管理 chain | `coder-loop chain create/list/status/stop/resume/delete/set-runner-model` | target-scoped 的停 / 恢复 / 删都在 chain 层（历史上曾有 `daemon start/stop/restart <target>` wrapper，已删除，等价路径见下表） |
| 管理 item | `coder-loop item add/batch-add/list/update/reorder` | 直接操作 centralized chain item |
| 恢复 blocked item | `coder-loop queue unblock <target> --issue <id>` | 将 preset 声明的 unblockable terminal item 恢复到 `statuses.entry`，清空其 phase 使 scheduler 从 entry phase 重捡；chain 已 completed 时一并恢复为 active（#679） |

常规排障顺序：

```bash
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json | jq '.state.kind, .queue, .current, .processes.live'
coder-loop status --loop-data-root ~/.coder-loop/loop-data --json | jq '.processes // .daemon'
```

判断 / 控制 daemon：

```bash
coder-loop daemon up --detach --json                                       # 起中央 daemon 后台（fork + unref + 写 pid，立即返回）
coder-loop daemon up --json                                                # 前台形态，供 launchd / systemd / e2e
coder-loop status --loop-data-root ~/.coder-loop/loop-data --json          # 中央 daemon 存活探测（无 target）
coder-loop chain stop <chain>                                              # 停某 chain 的 scheduling（可 chain resume）
coder-loop daemon down --json                                              # 关闭 central daemon socket 服务
coder-loop queue unblock <target> --issue <id> --start-daemon              # unblock 完 + 顺带 spawn detached daemon
```

历史上曾有 `daemon start|stop|restart <target>` 与 `daemon status <target>` 四个 target-scoped 子命令，已经删除，替代路径：

| 想做的事 | 用这个 |
|---|---|
| `daemon status <target>` | `status <target> --json`（顶层 status 兼容两种形态） |
| `daemon status`（无 target） | `status --loop-data-root <dir> --json`（同一命令，位置参数缺省 → 走 socket 探测） |
| `daemon start <target>` | `daemon up --detach`（或 `queue unblock ... --start-daemon` 顺带起） |
| `daemon stop <target>` | `chain stop <chain>` |
| `daemon restart <target>` | `daemon down && daemon up --detach` |

删除原因：`daemon start` 从不真 spawn（只是查 `daemon.status`）、`daemon stop` 只是 `chain stop` 别名、`daemon restart` 完全 no-op、`daemon status <target>` 与顶层 `status <target>` 重合。真正 spawn 中央 daemon 的能力（`executeDaemonStart`）现在 wire 到 `daemon up --detach` 和 `queue unblock --start-daemon` 两处。

`status <target> --json` 是 supervisor 的稳定读取契约。它会在 state 缺失或损坏时仍输出 JSON，让外部逻辑根据 `state.kind` 分支，而不是从 stderr 猜测失败类型。当前顶层字段：

| 字段 | 含义 |
|---|---|
| `target` | target cwd、shared / runtime / log 路径、preset metadata、runner policy |
| `state` | `ok` 与 `kind` discriminant；如 `ok`、`missing-preset`、`invalid-preset`、`missing-state`、`invalid-state`、`invalid-runtime` |
| `queue` | 队列总数、按 status 计数、continuable/terminal 数、当前 selected item |
| `runs` | SQLite `runs.status` 聚合出的 run 总数与 phase × status 计数 |
| `current` | 当前 run、item、phase status JSON snapshot |
| `events` | 当前或最近 run 的 events JSONL 路径、最近事件、解析错误 |
| `processes` | central/process scan 结果：`live[]` 与 `scanError` |

### items wire shape

`items` 表按 preset `[item.fields]` 声明的透明字段落盘；engine 只保留 `item_id`（opaque string identity）与调度所需的最少列。`gh-issue-pr-iteration` 用 `[item.fields]` 声明 `issue`（number）/ `branch`（string）/ `pr`（number）/ `lastRunId`（string）。`status --json` / daemon API 上 item 的 wire 形态：

| 路径 | 含义 |
|---|---|
| `queue.selected.id: string` | preset `idField`-valued opaque string identity（`gh-issue-pr-iteration` 中即 GitHub issue number 的字符串编码）|
| `queue.selected.item.issue: number` | preset `[item.fields].issue = "number"` 声明的透明字段，在 wire 层平铺 |
| `queue.selected.item.branch: string \| null` | `[item.fields].branch = "string"`，同上，wire 层平铺 |
| `queue.selected.item.pr: number \| null` | `[item.fields].pr = "number"`，同上，wire 层平铺 |
| `queue.selected.item.extra` | wire 上恒为 `null` — `flattenExtraReplacer` 把 `extra.*` 平铺到 `queue.selected.item.<field>`；消费者不要走 `.extra.<field>` 嵌套路径 |
| daemon wire `item.add` / `item.update` 的 identity 字段 | `itemId: string`；CLI flag 仍是 `--issue`（接受 opaque string） |
| audit/decision event payload `rowId: number` | `queue.terminal` / `item.dependency_unblocked` / `item.dependency_wait` / `item.backoff` 携带 SQLite rowid；`itemId` 恒是 opaque string identity |

`coder-loop item update` / `item add` 的 `--field-json` 接受 `{"branch": "...", "pr": N}`——它们走 preset 声明的 `[item.fields]` 透明字段路径，与 schema 物理层无关。

Runner 选择也在 `status` 中显式暴露：

| JSON path | 含义 |
|---|---|
| `target.runner.hostDefault` | 当前宿主推断出的 runner 诊断信息；不决定 iteration 默认值 |
| `target.runner.phases` | 每个 phase 的 preset / engine-builtin default runner（唯一 per-phase face，无角色专属字段） |
| `target.runner.default` | 默认执行 phase runner；来源通常是 preset |
| `queue.selected.phaseRunners` | 当前 selected item 逐 phase effective runner；允许 item override 的 phase 可显示 `source=queue` |
| `queue.selected.runner` | 当前 selected item 的默认执行 phase runner |
| `current.runner` | 当前 phase 的实际 runner；没有 current 时为 `null` |
| `current.phaseStatus.value.runner` / `.model` | 已落盘 phase status 里记录的 runner kind 与 model；旧 status 文件可能为 `null` |
| `current.activity.windows` | 当前 chain agent stdout 的兼容读面；独立 operator 命令优先使用 `activity item/all` |

Runtime 文件是必要的 debug reference，但不是外层长期依赖的首选 API。只有在 `doctor/status/daemon` 输出指出某个局部异常，或需要人工恢复状态时，才直接编辑/读取下面的文件。

---

## 2. Fallback: centralized SQLite state

持久来源是 central SQLite store。默认路径：

```text
~/.coder-loop/loop-data/db.sqlite
```

可通过 `--loop-data-root <dir>` 改变 loop-data 根。`coder-loop status <target> --json` 会在 `.state.path`、`.state.repository`、`.state.baseBranch` 与 `.target.*` 路径字段里暴露实际 runtime 与 chain 解析结果。

Operator 不应直接写 DB 表作为常规操作。优先使用：

```bash
coder-loop status <target> --json
coder-loop chain status <chain-name> --json
coder-loop item list <chain-name> --json
coder-loop item update ...
coder-loop queue unblock <target> --issue <id> --start-daemon
```

如果必须做人工恢复，先备份 DB，再用 `status` / `doctor` 定位到具体 chain 与 item；只修被诊断出的字段。

`coder-loop status <target> --json` 与 `coder-loop doctor <target>` 会检查并暴露这些 runtime 不变量：

- centralized chain 的 `repository` / `baseBranch` 是功能性 chain identity；prompt 专用值通过 preset 的透明 `chain.*` binding 读取；
- `queue` 内 id 不可重复；
- 每个 queue item 的 `status` 必须落在 preset 的 status 集合内；
- 若 `current` 存在，其 id 必须能在 `queue` 找到匹配项，且该项必须是 continuable；
- 若 `current.phase` 存在，必须落在 `preset.phases.*.name` 内；
- 若 queue item 声明 `agentCwd`，必须是绝对路径，且必须是个已存在目录；
- centralized chain 必须是 active，且 chain runtime layout 必须能解析。

`status --json` 成功时输出单个 JSON object；常用字段：

```bash
coder-loop status /path/to/target --json \
  | jq '.state.kind, .state.path, .state.repository, .state.baseBranch, .target.preset.name, .queue.total, .queue.selected'
```

`.state.kind == "ok"` 表示 preset、central chain layout、queue/current 都能解析；其他 kind 说明 status 仍可读，但需要按 `.state` 里的 discriminant 继续排错。

---

## 3. Fallback: events / agent 日志 layout

`<logDir>` 在 centralized chain runtime 中是该 chain 的 runs 目录，具体路径以 `coder-loop status <target> --json` 的 `target.logDir` / `events.path` / `current.phaseStatus.value.*Path` 为准。

| 文件 | 路径模板 | 用途 | 何时写 |
|---|---|---|---|
| Per-run events JSONL | `<logDir>/<runId>/events.jsonl` | 行级 JSON 事件，权威 union 见 `src/observability.ts` `ObservabilityEventTypeBoundary`；常见成员：`phase.start` / `phase.end` / `attempt.timeout` / `run.startup_idle_kill` / `recycle.pending_entered` / `recycle.timeout_kill` / `recycle.natural_exit` / `queue.terminal` / `chain.completed` / `agent.spawn` / `agent.exit`，另含 `item.*` / `chain.*` / `daemon.*` / `scheduler.*` audit / lifecycle 事件 | run 期间 append |
| Agent stdout stream | `<logDir>/<runId>/<phase>/stdout.jsonl` | agent stdout stream / JSONL 输出 | spawn 时写入 |
| Agent stderr | `<logDir>/<runId>/<phase>/stderr.txt` | agent stderr | spawn 时写入 |
| Agent status | `<logDir>/<runId>/<phase>/status.json` | spawn 结束元数据（exitCode / signal / bytes / runner / model / sessionId / terminated） | spawn 退出时写 |
| Agent sessions | `<logDir>/<runId>/<phase>/sessions.jsonl` | 可 resume 的 session id 索引 | 观察到 session 时 append |
| Agent activity | `<logDir>/<runId>/<phase>/activity.json` | 最近 5 分钟的逐秒 stdout 完整行计数桶；`status.current.activity` 的有界数据源 | run 期间原子更新 |

`status.json` 字段由 `AgentRunStatus` 定义，包含：`label`、`runner`、`model`、`pid`、`startedAt`、`lastEventAt`、`outputPath`、`statusPath`、`bytesWritten`、`promptChars`、`lastStream`、`exitCode`、`signal`、`error`、`sessionId`、`terminated`。

`runner` / `model` 为本次 phase 使用的 runner kind 与模型。`exitCode != 0` 或 `signal != null` 说明 spawn 异常；agent 内部业务失败通常表现为 exit 0 但 phase exit（`item update --status` / `item exit-action`）落到 blocked 或 exhausted 分支。

外部 watcher 优先 poll `coder-loop status <target> --json`。需要非轮询事件流时，用 `status.events.path` 返回的路径：

```bash
coder-loop status /path/to/target --json | jq -r '.events.path'
tail -F "$(coder-loop status /path/to/target --json | jq -r '.events.path')"
```

---

## 4. Runtime Health 错误分类

`coder-loop doctor <target>` 覆盖 operator 机器先决条件与 live runtime health。只想校验 target runtime/schema、不查 PATH / runner CLI 时，读结构化 status：

```bash
coder-loop status <path> --json | jq '.state, .target, .queue.selected'
```

`status` 对 state 缺失或损坏仍输出 JSON；调用方按 `.state.kind` 分支，不从 stderr 猜错误类型。`doctor` 适合给人看同类问题的 operator 机器 / live runtime 上下文。

常见错误：

| 类别 | 示例 | 修法 |
|---|---|---|
| chain 选择不匹配 | `SQLite chain "x" repository is owner/a, expected owner/b` | 指定正确 `--chain`，或修正 centralized chain identity |
| 必需文件 / 目录缺失 | `targetCwd: directory does not exist` / `sharedContextPath: missing file: .../shared.md` | 先跑 `coder-loop doctor`；缺 chain 时 `coder-loop chain create <name> --config-json '{"repository":"<owner>/<repo>"}'` |
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
| `null` | n/a | n/a | 新 run；`runIdGeneration = "new"`；从 `phases[0]` 开始新的业务周期并令 attempts++ |
| 非 null | id 不匹配选中 item | n/a | 视为 stale，丢弃 current；按新 run 处理 |
| 非 null | id 匹配选中 item | 任一 continuable phase | resume 该 phase；`runIdGeneration = "resumed"`；从该 phase 入口重跑（attempts 不重新自增） |

`items.attempts` 的单位是完整业务周期：只在 preset 的第一个 non-trigger phase 以 fresh session 启动时递增。后续 non-trigger phase、trigger phase、同 phase resume 和 rate-limit rollback 都不消耗新的周期预算。

Resume 时引擎注入：

- `runtime.runIdGeneration = "resumed"`
- `runtime.resumedFromPhase = <state.current.phase>`
- `runtime.resumedStartedAt = <state.current.startedAt>`

新 run：

- `runtime.runIdGeneration = "new"`
- `runtime.resumedFromPhase = ""`
- `runtime.resumedStartedAt = ""`

需要强制重头或强制某 phase 时，优先通过 chain/item API 做恢复；没有 API 覆盖时才在备份 SQLite 后手工修 current。

---

## 6. CLI 全表

### 6.1 子命令（必须作为第一位置参数）

`coder-loop doctor / status / logs / daemon / chain / item / queue`。子命令 help 可用：

```bash
coder-loop daemon --help
coder-loop chain --help
coder-loop item --help
```

不带子命令或子命令未匹配时，`coder-loop` 打印 root usage 后 exit 1。

| 子命令 | 用途 | 主要 flag |
|---|---|---|
| `doctor <target>` | 只读体检：operator 机器先决条件 + live runtime health（零 target 文件检查） | `--repo <slug>` `--loop-data-root <dir>` `--chain <name>` |
| `status [<target>] --json` | 带 `<target>` → JSON runtime/process snapshot；不带 → 中央 daemon socket 存活探测（等价于旧 `daemon status`） | `--loop-data-root <dir>` `--chain <name>` |
| `logs --json` | 结构化 events / audit 查询（**全局**，不接 target 参数） | `--kind K` `--type T` `--chain C` `--item ID` `--run RUN_ID` `--phase P` `--since TS` `--follow` |
| `activity item <chain> --issue <id>` | 直接读取本地 SQLite/artifact，显示指定存活任务的 10s / 30s / 1m / 5m 输出行数 | `--json` `--loop-data-root <dir>` |
| `activity all` | 直接读取本地 SQLite/artifact，显示全部 PID 仍存活的 current task | `--json` `--loop-data-root <dir>` |
| `activity log <chain> --issue <id>` | 输出指定存活任务当前 phase 的 `stdout.jsonl` 完整绝对路径 | `--json` `--loop-data-root <dir>` |
| `daemon up` | 运行 centralized daemon process；默认前台阻塞（launchd / systemd / e2e），`--detach` 后台化（fork + unref + 写 pid，立即返回） | `--detach` `--json` `--loop-data-root <dir>` `--scheduler-interval-ms <n>` |
| `daemon down` | 通过 Unix socket 要求 centralized daemon 退出 | `--json` `--loop-data-root <dir>` |
| `chain create <name>` | 中央 daemon socket 上创建 chain metadata | `--config-json '{"repository":"...","baseBranch":"...","bindings":{...}}'` `--preset <name>` `--umbrella <ref>` `--force` |
| `chain list` / `chain status <name>` | list / show one chain | `--json` `--loop-data-root <dir>` |
| `chain stop <name>` / `chain resume <name>` | 暂停 / 恢复 chain scheduling | `--json` `--loop-data-root <dir>` |
| `chain delete <name>` | 标记 chain 删除 | `--json` `--loop-data-root <dir>` |
| `chain set-runner-model <chain>` | patch `chain.metadata.<kind>.model` runner-binding override | `--kind <claude\|codex\|opencode>` `--model <name>` |
| `item add <chain>` | 加一个 item；`--preset` / `--preset-path` 二选一必填 | `--issue <id>` `--repo-cwd <dir>` `--preset <name>` / `--preset-path <abs>` `--status` `--attempts` `--title` `--priority` `--field-json '{...}'` `--last-run-id` `--issue-file` `--evidence-dir` `--agent-cwd` `--runner` |
| `item batch-add <chain> --items-json '[...]'` | 原子批量加 item | `--items-json` `--loop-data-root <dir>` |
| `item list <chain>` / `item update <chain>` / `item reorder <chain>` | item 常规 CRUD | 看 `coder-loop item --help` |
| `item exits <chain>` / `item exit-action <chain>` | **agent 面**：查该 item 当前 run phase 的 typed phase-exits / 选择 chain-action exit | `--issue` `--agent-run-id` `--agent-phase` `--action`（exit-action） |
| `queue unblock <target>` | 将 preset 声明的 unblockable terminal item 恢复到 `statuses.entry`，清空其 phase 使 scheduler 从 entry phase 重捡；chain 已 completed 时一并恢复为 active（#679） | `--issue <id>` `--start-daemon` `--dry-run` |

### 6.2 Source entry

本仓调试时可以用源码入口运行同一组子命令：

```bash
bun src/loop.ts status <target> --json
bun src/loop.ts daemon up --detach
```

源码入口仍然要求第一位置参数是子命令；不带子命令时只打印 usage 并 exit 1。启动中央 daemon 走 `coder-loop daemon up --detach`（或 `queue unblock ... --start-daemon` 顺带起），只读健康检查走 `coder-loop status <target> --json` 或 `coder-loop doctor <target>`。

### 6.3 Agent 进程与监控（fallback reference）

- **Per-run events JSONL**：`<logDir>/<runId>/events.jsonl`，路径由 `coder-loop status <target> --json` 的 `events.path` 暴露。
- **Absolute attempt timeout**：每个 agent attempt 的绝对上限由 preset.toml `[agent] attemptTimeoutSeconds` 声明（bundled `gh-issue-pr-iteration` 是 7200；`engine-integration` 是 120；`real-e2e-minimal` 是 900；`single-phase-example` 是 3600）。到期无条件对 agent 进程组发 SIGTERM，5 秒后仍未退出则 SIGKILL；attempt 记录 `terminated.kind = "timeout"`，事件流写 `attempt.timeout`。
- **Startup idle watchdog**（#462）：spawn 后前 10 分钟内 stdout 字节数 < 200B 判"启动即挂死"，SIGKILL 该 attempt，事件流写 `run.startup_idle_kill`（阈值可用 `CODER_LOOP_STARTUP_IDLE_TIMEOUT_MS` / `CODER_LOOP_STARTUP_IDLE_PROGRESS_BYTES` 覆盖）。
- **Recycle zone**（#452，替代已退役的 post-summary watchdog）：agent 通过 `coder-loop item update --status` 写入 admissible status 后，daemon 给它 500 秒自然退出。事件流写 `recycle.pending_entered` 起手；自然退出写 `recycle.natural_exit`；到期未退出直接 SIGKILL 进程组，事件流写 `recycle.timeout_kill`（因为 agent 已经宣告完成，SIGTERM 不再需要）。
- **Agent --resume**：Claude CLI spawn 中断（5xx / 网络）时引擎自动 `--resume <sessionId>` 续跑，sessionId 索引在 `<logDir>/<runId>/<phase>/sessions.jsonl`；stderr 检测到 invalid-session pattern 时清 sessionIds 并 emit `session_id.invalidated`，下一 attempt 自动 fresh。

---

## 7. 常见排障流程

### 7.1 status 显示 missing/invalid runtime

```bash
coder-loop doctor /path/to/target --repo <owner>/<repo>
coder-loop status /path/to/target --json | jq '.state, .target, .queue.selected'
```

按 `doctor` / `status` 报出的具体层修，不要先手写 DB 或删 runtime。

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
coder-loop item list <chain-name> --json
```

确认是不是所有 item 已 terminal；需要追加 work 时用 `coder-loop item add` / `item batch-add`（issue 由 operator 或上游工具按 `presets/gh-issue-pr-iteration/contract.md` 提前写好）。

---

## 8. 常见坑

- **`.coder-loop/` 入了 git** → runtime / logs / handoff 进了 PR diff；`.gitignore` 加 `.coder-loop/` 后 `git rm --cached -r .coder-loop/`。
- **target 的 `CLAUDE.md` / `AGENTS.md` 缺失或没入仓** → 各执行 phase 读不到项目工作方式（项目命令 / PR 约定），行为退化为推测项目命令，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → iteration 的 issue body 亲读 / review 的 `gh pr checks` 都会失败，agent 输出里能看到 `gh auth status` 失败回显。
- **chain identity 与目标 repo 不一致** → `status <target>` / `queue unblock <target>` 会在解析 chain 时报告 repository/baseBranch 不匹配；指定正确 `--chain`，或修正 centralized chain identity。
- **只看日志文件、不看 status** → authoritative path 来自 central chain；先看 `status` 返回的路径，不要按老式 flat log layout 找文件。
