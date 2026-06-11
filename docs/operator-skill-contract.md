# coder-loop 操作 skill / 命令契约

本文件是 repo-owned 的 coder-loop 操作指南源。用户 home 下的 skill 副本是 operator 个人资产，不由 engine 校验、同步或分发；命令契约变化时先改本文件和相关 CLI/docs。

## 当前稳定入口

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
coder-loop queue unblock <target> --issue <id> --start-daemon
```

## 操作顺序

1. **Bootstrap / verify**: 先 `install`，再 `doctor`，最后 `status`。
2. **Daemon 生命周期**: `daemon up/down` 管 central socket service；`daemon start/stop/restart <target>` 管一个 target 对应的 chain。
3. **Chain / item 变更**: 用 `chain create/list/status/delete` 与 `item add/list/update` 表达队列操作，不手写 runtime 文件。
4. **Fallback 阅读边界**: 先从 `coder-loop status <target> --json` 读取 `events.path`、`current.phaseStatus.value.outputPath`、`statusPath`，再按路径读 run artifacts。
5. **Blocked item 恢复**: 只在确认 `kind:blocked` side effect 已满足后用 `queue unblock`，不要直接改 status。

## Runner / model 真相

Runner 选择是 target runtime contract，不由 host 身份或旧 flat log 推断。以 `coder-loop status <target> --json` 为准，读取：

- `target.runner.hostDefault`
- `target.runner.phases`
- `target.runner.default`
- `target.runner.reviewDefault`
- `queue.selected.phaseRunners`
- `queue.selected.runner`
- `queue.selected.reviewRunner`
- `current.runner`
- `current.phaseStatus.value.runner`
- `current.phaseStatus.value.model`

## 不是当前权威状态的旧入口

不要把 `state.json`、`.dev-loop`、`.dev-trace.txt` 写成当前权威状态。它们只能出现在 legacy/debug、ignore、迁移说明或反例语境里。当前队列 / current / run artifact 的权威入口是 centralized daemon + chain DB，并通过 `status` / `doctor` / `daemon status` 暴露。
