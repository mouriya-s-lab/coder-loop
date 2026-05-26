# coder-loop Level 1/2/3 故障诊断清单

默认诊断步骤只读。任何会修改 chain、item、PR、issue、DB、worktree 或进程的恢复步骤必须先写明风险、备份对象和预期影响。

## Level 1：稳定 API 定位

```bash
coder-loop daemon status <target> --json
coder-loop status <target> --json
coder-loop doctor <target> --repo <owner>/<repo>
coder-loop chain status <chain-name> --json
coder-loop item list <chain-name> --json
```

Level 1 先确认 daemon 是否存在、socket 是否可达、target state 是否 OK、scheduler 是否有 selected、item 是否卡住、lastTick / lastEventAt 是否推进、GitHub issue/PR 是否与本地一致。

## Level 2：日志 / 事件下钻

从 `coder-loop status <target> --json` 取路径，不猜 runtime 路径：

```bash
STATUS=$(coder-loop status <target> --json)
echo "$STATUS" | jq -r '.events.path // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.outputPath // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.statusPath // empty'
```

事件速查：`queue.select`、`phase.start`、`phase.end`、`attempt.start`、`attempt.close`、`watchdog.fire`、`queue.terminal`、`attempt.timeout`。缺失的配对事件通常比 agent 文字更可信：有 `attempt.start` 无 `attempt.close` 说明 spawn 尚未结束或监控中断；有 `phase.end` 无 `queue.terminal` 说明 review 未把 item 带到 terminal。

## Level 3：进程级 / 存储级检查

只有 Level 1/2 指向进程或存储问题时才用：

```bash
ps -axo pid,ppid,etime,stat,%cpu,%mem,command | rg 'coder-loop|codex|claude'
lsof -U | rg 'coder-loop|loop-data' || true
```

DB 级恢复是最后手段。若 central DB 不可读、DB locked、或 daemon socket 长期不可达，先停 daemon、备份 loop-data root，再用 CLI 或小型 migration 恢复；不要直接手写 SQLite 行作为常规修复。

## 场景速查

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

## 旧 runtime 修补路径边界

不要把旧 `state.json`、`.dev-loop`、`runtime/events/` 或 `sync-daemon-registry` 当成当前诊断入口。当前入口是 Level 1 的稳定 API；只有稳定 API 返回了具体 run artifact 路径时才读文件。
