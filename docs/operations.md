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
| `current` | 当前 run、item、phase status JSON snapshot |
| `events` | 当前或最近 run 的 events JSONL 路径、最近事件、解析错误 |
| `processes` | central/process scan 结果：`live[]` 与 `scanError` |

Runner 选择也在 `status` 中显式暴露：

| JSON path | 含义 |
|---|---|
| `target.runner.hostDefault` | 当前宿主推断出的 runner 诊断信息；不决定 iteration 默认值 |
| `target.runner.default` | target 默认 iteration runner；来源为 config 或内建 default |
| `target.runner.reviewDefault` | review runner；默认 `claude`，可由 config 的 `reviewRunner` 覆盖；当 kind 为 `claude` 时 model 强制为 `claude-opus-4-7` |
| `queue.selected.runner` | 当前 selected item 的实际 iteration runner；queue item 上的 `runner` 会覆盖 target default |
| `queue.selected.reviewRunner` | 当前 selected item 的 review runner；不受 queue item `runner` 影响 |
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
coder-loop item list <chain-name> --json
coder-loop item update ...
coder-loop queue unblock <target> --issue <id> --start-daemon --require-browser-evidence
```

如果必须做人工恢复，先备份 DB，再用 `status` / `doctor` 定位到具体 chain 与 item；只修被诊断出的字段。旧文档里的 target-local `.coder-loop/runtime/state.json` 属于 legacy/debug 语境，不是新版 centralized chain runtime 的一线状态源。

`--check-runtime` 仍会检查这些不变量：

- `state.version === 1`；
- 若 config `repository` 非 null，`state.repository` 必须匹配；`baseBranch` 同理；
- `queue` 内 id 不可重复；
- 每个 queue item 的 `status` 必须落在 preset 的 status 集合内；
- 若 `current` 存在，其 id 必须能在 `queue` 找到匹配项，且该项必须是 continuable；
- 若 `current.phase` 存在，必须落在 `preset.phases.*.name` 内；
- 若 queue item 声明 `agentCwd`，必须是绝对路径，且必须是个已存在目录；
- centralized chain 必须是 active，且 chain runtime layout 必须能解析。

exit 0 时 stderr 输出类似：

```text
Runtime check passed: target=<abs>
Runtime check passed: repo=<owner>/<repo>          # 仅 config.repository 非 null 时
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
| repo/base branch 不匹配 | `state.repository: must match configured repository <owner>/<repo>` | 对齐 target config 与 chain state |
| 必需文件 / 目录缺失 | `targetCwd: directory does not exist` / `workflow: file does not exist` | bootstrap 缺失项，先跑 `coder-loop install` / `doctor` |
| workflow 误入 runtime | `workflow: must be project policy outside .coder-loop/runtime` | workflow.md 留在 `.coder-loop/` 而不是 runtime 内 |
| queue item id 缺失 / 重复 | `state.queue[N].issue: must be a non-empty string or finite number` / `duplicate id "42"` | 修 chain item |
| queue item status 非法 | `state.queue[N].status: status "foo" is not in preset.statuses` | 用 preset 声明的 status 字面量 |
| issueFile / evidenceDir 找不到 | `state.queue[N].issueFile: file does not exist` | 创建文件或清空字段 |
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
| `status <target> --json` | 只读 JSON runtime/process snapshot | `--config <path>` `--repo <slug>` `--loop-data-root <dir>` `--chain <name>` |
| `daemon up` | 运行 centralized daemon process | `--json` `--loop-data-root <dir>` |
| `daemon down` | 通过 Unix socket 要求 centralized daemon 退出 | `--json` `--loop-data-root <dir>` |
| `daemon status <target> --json` | daemon 视角 JSON snapshot | `--config <path>` `--repo <slug>` `--loop-data-root <dir>` `--chain <name>` |
| `daemon start <target>` | 解析 target chain 并确认 daemon 可调度；已运行/已存在时幂等返回 | `--config <path>` `--repo <slug>` `--require-browser-evidence` `--max-iterations <N>` `--dry-run` |
| `daemon stop <target>` | 解析 target chain 并调用 `chain.delete` | `--config <path>` `--repo <slug>` `--dry-run` |
| `daemon restart <target>` | 解析 target chain 并确认 central daemon 可用，输出单个 JSON object | `--config <path>` `--repo <slug>` `--require-browser-evidence` `--max-iterations <N>` `--dry-run` |
| `chain create/list/status/delete` | centralized chain CRUD | 看 `coder-loop chain --help` |
| `item add/list/update` | centralized chain item CRUD | 看 `coder-loop item --help` |
| `queue unblock <target>` | 将一个 blocked item 改回 queued 并清除 blocker metadata；用于 `kind:blocked` accept 后反向解除源仓 block | `--issue <id>` `--start-daemon` `--require-browser-evidence` |

### 6.2 主循环 flags

`bun src/loop.ts [flags]` 或 `coder-loop [flags]`：

| Flag | 类型 | 默认 | 含义 |
|---|---|---|---|
| `<N>` | positional int | 无（无限） | 最大循环轮次；不传则无限 |
| `--target-cwd <path>` | string | `process.cwd()` | target 目录绝对 / 相对路径 |
| `--config <path>` | string | target runtime config | config 文件路径 |
| `--workflow <path>` | string | config 字段或 `<target>/.coder-loop/workflow.md` | workflow 文件路径 |
| `--repo <owner>/<repo>` | string | config 字段或 null | 校验 state repository 一致；不会改写 state |
| `--loop-data-root <dir>` | string | `~/.coder-loop/loop-data` | centralized DB/socket/runtime 根 |
| `--chain <name>` | string | target/config 推导 | 指定 centralized chain |
| `--require-browser-evidence` | bool flag | config 字段或 false | 暴露给 preset；引擎自身不验证截图存在 |
| `--once` | bool flag | false | 跑 1 轮就退出（等价 `1`） |
| `--dry-run` | bool flag | false | 选中 item 后停（不 spawn agent） |
| `--check-runtime` | bool flag | false | 校验 schema 后退出，不 spawn agent |

flag 冲突优先级：CLI > config > 默认。

### 6.3 Agent 进程与监控（fallback reference）

- **Per-run events JSONL**：`<logDir>/<runId>/events.jsonl`，路径由 `coder-loop status <target> --json` 的 `events.path` 暴露。
- **Absolute attempt timeout**：每个 agent attempt 默认 60 分钟绝对上限，可在 preset.toml `[agent] attemptTimeoutSeconds = <seconds>` 覆盖。到期且尚未观察到 phase summary marker 时，引擎对 agent 进程组发 SIGTERM，5 秒后仍未退出则 SIGKILL；attempt 记录 `terminated.kind = "timeout"`，事件流写 `attempt.timeout`。
- **Post-summary watchdog**：iteration agent 输出 `ITERATION SUMMARY` 后 5 分钟未自然退出，引擎发 SIGTERM；再 5 秒后 SIGKILL。事件流写 `watchdog.fire`。
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
coder-loop item list <chain-name> --json
```

确认是不是所有 item 已 terminal；如果需要追加 work，用 planning/issue handoff 或 `coder-loop item add`，不要直接拼旧 JSON 文件。

---

## 8. 常见坑

- **把 `.coder-loop/runtime/` 入了 git** → runtime / logs / handoff 进了 PR diff；把整个 runtime 目录加 `.gitignore` 后 `git rm --cached -r .coder-loop/runtime/`。
- **`.coder-loop/workflow.md` 缺失或没入仓** → iter/review agent 读不到项目工作方式，行为退化为 bundled preset 默认值，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → `iter/read-context` 会以 `infrastructure_failure` 出局，agent 输出里能看到 `gh auth status` 失败回显。
- **`config.json` 的 `repository` 字段与远端不一致** → `--check-runtime` 报 `repository mismatch`；改 config 或 chain state，不是只改 `--repo` 参数。
- **只看日志文件、不看 status** → 新版 authoritative path 来自 central chain；先看 `status` 返回的路径，避免按旧 flat-log layout 找错文件。

## 9. Operator skill / command contract sync

`coder-loop` operator guidance has one repo-owned maintenance source: the docs in this directory plus the optional skill template at `templates/skills/coder-loop/SKILL.md`. User-home copies under `~/.claude/skills/` or `~/.agents/skills/` are installed artifacts, not authoritative repo state. When a command changes, update the repo docs/template first, then sync user-home copies outside the PR if needed.

Current stable command surface, verified against `src/loop.ts` help, is:

```bash
coder-loop install <target> --repo <owner>/<repo>
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop status <target> --json
coder-loop daemon up --json
coder-loop daemon down --json
coder-loop daemon status <target> --json
coder-loop daemon start <target>
coder-loop daemon stop <target>
coder-loop daemon restart <target>
coder-loop chain create --help
coder-loop chain list --help
coder-loop chain status --help
coder-loop chain delete --help
coder-loop item add --help
coder-loop item list --help
coder-loop item update --help
coder-loop queue unblock <target> --issue <id> --start-daemon --require-browser-evidence
```

Operator order is always:

1. **Bootstrap / verify**: `install`, then `doctor`, then `status`.
2. **Operate daemon**: `daemon up/down` for the central socket service; `daemon start/stop/restart <target>` for one target chain.
3. **Operate chain/item**: `chain create/list/status/delete` and `item add/list/update` when planning or manual recovery needs explicit queue changes.
4. **Read before fallback**: use `status --json` paths before reading run artifacts directly.
5. **Unblock explicitly**: use `queue unblock` only for a reviewed `kind:blocked` reverse side effect.

Runner truth is also part of the command contract. Do not infer it from host identity or old flat logs; read `target.runner.default`, `target.runner.reviewDefault`, `queue.selected.runner`, `queue.selected.reviewRunner`, `current.runner`, and `current.phaseStatus.value.runner` from `coder-loop status <target> --json`.

If a copied skill says something different from this section, the copied skill is stale. Sync it from the repo template or update this section and the template in the same PR.

## 10. 只读巡查清单

巡查是只读工作。目标是回答“loop 是否还在推进、卡在哪里、GitHub 侧是否一致”，不是顺手修 state。按下面顺序执行；前一层给出 WARN / ERROR 后再下钻。

| Step | Command | OK | WARN | ERROR |
|---|---|---|---|---|
| 1 daemon | `coder-loop daemon status <target> --json` | central daemon reachable，target chain 可解析 | daemon 活着但 target 没有 selected/current | socket 不可达、daemon 无响应、scanError 非空 |
| 2 target | `coder-loop status <target> --json` | `.state.kind == "ok"`，queue/current/events/processes 可读 | selected 为 null 但 GitHub parent 仍 open | `missing-*` / `invalid-*` state kind |
| 3 doctor | `coder-loop doctor <target> --repo <owner>/<repo>` | bootstrap layers 与 runner CLI 全 OK | optional skill copy stale | PATH / gh auth / preset / workflow 缺失 |
| 4 chain | `coder-loop chain status <chain-name> --json` | chain active，item counts 与 status 一致 | chain completed 但 umbrella open | chain missing/deleted 或 runtime layout 不可解析 |
| 5 item | `coder-loop item list <chain-name> --json` | queued / blocked / done 分布符合预期 | terminal item 仍有 open GitHub issue | duplicate id、非法 status、依赖未满足却被调度 |
| 6 run | `coder-loop status <target> --json | jq '.current, .events.latest'` | `lastEventAt` 近期更新或 phase clean exit | 长时间无新事件但进程仍有 CPU/IO | exitCode 非 0、signal 非 null、attempt timeout |
| 7 GitHub issue | `gh issue view <n> -R <repo> --json state,labels,comments,closedByPullRequestsReferences` | issue state 与 queue status 一致 | issue open 但 local terminal，需要 review 解释 | issue closed 但 local queued，或 label kind 缺失 |
| 8 GitHub PR | `gh pr view <n> -R <repo> --json state,mergedAt,reviewDecision,statusCheckRollup,closingIssuesReferences` | PR merged/closed state 与 item verdict 一致 | checks pending | PR open 且 item done，或 merged PR 未关闭 issue |
| 9 checks | `gh pr checks <n> -R <repo>` | required checks pass | pending / skipped 有说明 | failed checks 且 review accepted |

巡查时如果需要 issue、PR、checks 三类 GitHub 侧状态，优先使用：

```bash
gh issue view <issue> -R <owner>/<repo> --json number,state,labels,comments,closedByPullRequestsReferences
gh pr view <pr> -R <owner>/<repo> --json number,state,mergedAt,reviewDecision,statusCheckRollup,closingIssuesReferences
gh pr checks <pr> -R <owner>/<repo>
```

只有当 `status` 返回的 `events.path`、`current.phaseStatus.value.outputPath`、`statusPath` 指向具体 run artifact 时，才读取 run files。不要把旧 target-local JSON 或 sentinel 文件当成巡查入口；它们只属于 legacy/debug 说明。

## 11. Level 1/2/3 故障诊断清单

默认诊断步骤只读。任何会修改 chain、item、PR、issue、DB 或进程的恢复步骤必须先写明风险、备份对象和预期影响。

### Level 1：稳定 API 定位

```bash
coder-loop daemon status <target> --json
coder-loop status <target> --json
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop chain status <chain-name> --json
coder-loop item list <chain-name> --json
```

Level 1 只回答：daemon 是否存在、socket 是否可达、target state 是否 OK、scheduler 是否有 selected、item 是否卡住、lastTick / lastEventAt 是否推进、GitHub issue/PR 是否与本地一致。

### Level 2：日志 / 事件下钻

从 `coder-loop status <target> --json` 取路径，不猜路径：

```bash
STATUS=$(coder-loop status <target> --json)
echo "$STATUS" | jq -r '.events.path // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.outputPath // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.statusPath // empty'
```

事件速查：`queue.select`、`phase.start`、`phase.end`、`attempt.start`、`attempt.close`、`watchdog.fire`、`queue.terminal`、`attempt.timeout`。缺失的配对事件通常比 agent 文字更可信：有 `attempt.start` 无 `attempt.close` 说明 spawn 尚未结束或监控中断；有 `phase.end` 无 `queue.terminal` 说明 review 未把 item 带到 terminal。

### Level 3：进程级 / 存储级检查

只有 Level 1/2 指向进程或存储问题时才用：

```bash
ps -axo pid,ppid,etime,stat,%cpu,%mem,command | rg 'coder-loop|codex|claude'
lsof -U | rg 'coder-loop|loop-data' || true
```

DB 级恢复是最后手段。若 central DB 不可读、DB locked、或 daemon socket 长期不可达，先停 daemon、备份 loop-data root，再用 CLI 或小型 migration 恢复；不要直接手写 SQLite 行作为常规修复。

### 场景速查

| 场景 | 症状 | 诊断命令 | 根因解释 | 恢复步骤 |
|---|---|---|---|---|
| daemon 不存在 | `daemon status` 无 live daemon | `coder-loop daemon status <target> --json` | central socket service 未启动或已退出 | 只读确认后 `coder-loop daemon up --json`；会启动 central daemon |
| socket 不可达 | `daemon status` 报 socket / connection error | `coder-loop daemon status <target> --json` | socket 文件失效、daemon crash、loop-data-root 不一致 | 确认 root 后 `daemon down` 再 `daemon up`；会改进程状态 |
| scheduler 不 tick / lastTick 不变 | `lastTick` 或 `lastEventAt` 长时间不变 | `coder-loop status <target> --json | jq '.events.latest,.current'` | daemon 活着但 selected/current 没推进，可能 agent hung 或 watchdog 未触发 | 先读 statusPath/outputPath；必要时 `daemon stop` 后 `daemon start` |
| rate-limit pause | agent stderr/status 反复出现 rate-limit/backoff | 读 `current.phaseStatus.value.statusPath` 与 stderr | runner 暂停，不是 queue 错误 | 等待或切 runner/model；修改 config 属写操作 |
| item 卡住 | selected 同一 item，attempt 不结束 | `coder-loop status <target> --json | jq '.queue.selected,.current.phaseStatus'` | agent 子进程仍运行、summary 后 watchdog 等待、或 resume 状态残留 | 读输出，确认后 restart；不要直接改 terminal status |
| agent 子进程异常 | `exitCode != 0` 或 `signal != null` | `jq '.current.phaseStatus.value'` | runner CLI 崩溃、权限、PATH、sandbox 或 prompt 输入问题 | 修前置条件后让 daemon retry；必要时 issue/PR 留反馈 |
| DB locked / DB 不可达 | chain/item 命令失败或 long lock | `coder-loop chain status <chain-name> --json` | central SQLite 被旧进程占用或 loop-data root 错 | 停相关 daemon，备份 DB，重启 daemon；直接 DB 写入为高风险 |
| worktree 残留 | git branch/worktree 与 queue item 不一致 | `git status --short --branch` + `coder-loop item list <chain-name> --json` | 上轮 PR/branch 未清理或 local checkout 未回 main | 先确认 PR/issue live state，再清理 branch/worktree；会改 git state |

## 12. 复杂编码任务使用 coder-loop 的触发规则

coder-loop 是长任务 / 多 actor / 多阶段工作的调度器，不是所有改代码请求的默认包装层。

### 触发条件

满足任一条件时，优先使用 coder-loop 或至少先规划 chain/item：

- 复杂编码任务跨多个 issue、多个 PR、多个 repo，或需要父子 issue 图。
- 任务预期长于单 session，需要 daemon 持续推进、review 接力或恢复。
- 用户明确要求“用 coder-loop”、“队列跑”、“daemon 跑”、“自动 review”。
- 任务需要持续巡查、故障诊断、block/unblock side effect 或后续 patrol。
- 任务有依赖顺序，需要 `chain create` / `item add` 表达可执行 item，而不是靠聊天记忆。

典型流程：

```bash
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop chain create <chain-name> --repo <owner>/<repo> --json
coder-loop item add <chain-name> --issue <n> --repo-cwd <target> --json
coder-loop daemon start <target>
coder-loop status <target> --json
coder-loop daemon status <target> --json
```

### 不触发条件

这些工作通常手动完成更快，不强制进 coder-loop：

- 简单单文件修复，影响面清楚，能在当前 session 完成。
- 低风险文档更新或小 bugfix，不需要多轮 review/daemon 恢复。
- 只读调查、一次性命令、格式化、翻译、轻量说明。
- 用户明确说不要 coder-loop 或要人工直接实现。

不触发 coder-loop 不等于跳过规范：仍然遵守 GitHub issue/PR routing、`writing-issue` / `writing-pr` / `review-pr` 的职责边界，仍然做 runtime verification。coder-loop guidance 不覆盖这些规则；它只决定是否把工作交给 chain/daemon 调度。
