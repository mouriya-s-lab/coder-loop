# Operations Reference

循环挂了、行为奇怪、想 debug 或 reset 状态时看这里。

排障入口永远是稳定 CLI，不要直接读 runtime 文件：

```bash
coder-loop doctor /path/to/target --repo owner/repo
coder-loop status /path/to/target --json
coder-loop daemon status /path/to/target --json
```

---

## 1. Daemon

单进程集中 daemon，SQLite 状态，Unix socket 通信。

```
~/Ext/loop-data/
  state.db       # SQLite DB（chains, items, runs）
  daemon.pid     # PID file
  daemon.sock    # Unix domain socket
  chains/<name>/daemon/<timestamp>/   # per-chain 日志
```

### 命令

| 命令 | 用途 |
|---|---|
| `daemon start <target>` | 导入 target queue 到 DB + 开始执行。socket 不在线时自动启动 daemon |
| `daemon stop <target>` | 将 target items 标记为 `paused`，daemon 继续在线 |
| `daemon restart <target>` | stop + start，输出单个 JSON |
| `daemon status [<target>] --json` | 无 target 时显示 daemon 全局状态；有 target 时显示 chain/items/slots |
| `daemon down` | 关闭 daemon 进程 |

`daemon start` 幂等：socket 已在线时只导入 queue。

### Socket 协议

一行一个 JSON request，响应也是一行 JSON：

```json
{ "cmd": "daemon.status" }
{ "cmd": "chain.create", "name": "release", "preset": "gh-issue-pr-iteration", "repo": "owner/repo", "baseBranch": "main" }
{ "cmd": "item.add", "chain": "release", "issue": 127, "repoCwd": "/path/to/repo", "priority": "high" }
{ "cmd": "item.list", "chain": "release" }
{ "cmd": "daemon.shutdown" }
```

响应：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

### 测试 / 开发

```bash
coder-loop daemon up \
  --root .cache/daemon-dev \
  --db .cache/daemon-dev/state.db \
  --socket .cache/daemon-dev/daemon.sock \
  --pid .cache/daemon-dev/daemon.pid
```

---

## 2. `status --json` 字段

| 顶层字段 | 内容 |
|---|---|
| `target` | cwd、config/workflow/state 路径、preset metadata |
| `state` | `kind` discriminant：`ok` / `missing-config` / `invalid-state` / ... |
| `queue` | 总数、按 status 计数、selected item |
| `current` | 当前 run、item、phase status |
| `events` | events JSONL 路径、最近事件 |
| `processes` | `.dev-loop` 归属、pid alive、匹配的 live process |

Runner 选择字段：

| Path | 含义 |
|---|---|
| `target.runner.default` | target iteration runner（含 kind/source/binary/model） |
| `target.runner.reviewDefault` | review runner |
| `queue.selected.runner` | 当前 item 的 iteration runner |
| `queue.selected.reviewRunner` | 当前 item 的 review runner |

---

## 3. Resume 行为

引擎在 spawn 前检查 `state.current`：

| `state.current` | 结果 |
|---|---|
| `null` | 新 run，attempts++，从 phase[0] 开始 |
| 存在，id 不匹配选中 item | 丢弃 current，按 null 处理 |
| 存在，id 匹配，phase=`iteration` | resume iteration（attempts 不变） |
| 存在，id 匹配，phase=`review` | 跳过 iteration 直接 review |

Resume 注入 `runtime.runIdGeneration = "resumed"` + `runtime.resumedFromPhase`。

强制重头：

```bash
jq '.current = null' .coder-loop/runtime/state.json > .tmp && mv .tmp .coder-loop/runtime/state.json
```

---

## 4. Agent 进程监控

- **Attempt timeout**：默认 60 分钟（`preset.toml` 的 `attemptTimeoutSeconds`）。到期发 SIGTERM，5s 后 SIGKILL
- **Post-summary watchdog**：agent 输出 summary marker 后 5 分钟未退出则 SIGTERM
- **Events JSONL**：`<target>/.coder-loop/runtime/events/<runId>.jsonl`
  - 事件类型：`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.timeout` / `attempt.close` / `watchdog.fire` / `queue.terminal`
- **Auto-resume**：claude CLI spawn 中断时自动 `--resume <sessionId>`

---

## 5. Trace 文件

| 文件 | 路径 | 用途 |
|---|---|---|
| Agent latest | `<logDir>/<runId>.<phase>.txt` | 当前轮全 stdout（每轮覆盖） |
| Agent attempt 归档 | `<logDir>/<runId>.<phase>.attempt-<ts>.<pid>.txt` | 每次 spawn 留底 |
| Agent status | `<logDir>/<runId>.<phase>.status.json` | spawn 元数据（exitCode/signal/bytes/runner/model） |
| Daemon log | `<logDir>/coder-loop-<pid>.<ts>.log` | 引擎 stderr/stdout |
| Trace | `<target>/.dev-trace.txt` | 当前迭代高层事件流 |

`exitCode != 0` → spawn 失败。`exitCode == 0` 但 trace 末尾 verdict 是 blocked/failed → agent 内部逻辑选了非成功路径。

---

## 6. `--check-runtime` 错误

`coder-loop --target-cwd <path> --check-runtime` 校验 schema，exit 1 时输出错误清单。

常见错误：

| 错误 | 修法 |
|---|---|
| `state.version: must be 1` | state.json 加 `"version": 1` |
| `state.repository: must match configured ...` | 对齐 state.json 和 config.json |
| `workflow: must be project policy outside .coder-loop/runtime` | workflow.md 放 `.coder-loop/` 不是 `runtime/` |
| `duplicate id "42"` | queue 里去重 |
| `status "foo" is not in preset.statuses` | 用 preset 声明的 status |
| `state.current.issue: id "42" has non-continuable status` | `jq '.current = null'` 清 current |

---

## 7. `.dev-loop` Sentinel

Legacy 循环控制文件。集中 daemon 架构下通常用 `daemon stop/start`，不需要手动操作这个文件。

- 引擎启动时创建，删除后当前轮跑完正常退出
- 不强杀 in-flight agent——sentinel 检查在轮间隔
- 进程死后不自动清理，下次启动会覆盖

---

## 8. `kind:blocked` 工作流

1. Review 判定 item blocked，写入 `blockerRepo` / `blockerRef`
2. `blocked-responder` trigger phase 在 blocker 仓创建 follow-up issue，注入该仓 queue，启动该仓 daemon
3. Blocker 仓 follow-up PR merge 后，review 执行 `coder-loop queue unblock` 恢复原仓 item

```bash
coder-loop queue unblock /path/to/source-target --issue 123 --start-daemon --require-browser-evidence
```

---

## 9. Debug 速查

```bash
# 看上一轮跑去哪了
coder-loop status . --json | jq '.current, .events.latest'
ls -t .coder-loop/runtime/logs/ | head
tail -50 .coder-loop/runtime/logs/<runId>.iteration.txt

# 清掉卡住的 current，从队首重选
jq '.current = null' .coder-loop/runtime/state.json > .tmp && mv .tmp .coder-loop/runtime/state.json
coder-loop --target-cwd . --check-runtime

# 把某 issue 从 done 拉回 queued 重跑
jq '.queue |= map(if .issue == 42 then .status = "queued" | .attempts = 0 else . end) | .current = null' \
    .coder-loop/runtime/state.json > .tmp && mv .tmp .coder-loop/runtime/state.json

# 核手段：reset 到空队列
echo '{ "version": 1, "queue": [], "repository": null, "baseBranch": null, "recentRuns": [], "current": null }' \
    > .coder-loop/runtime/state.json
```

---

## 10. `state.json` Schema

文件：`<target>/.coder-loop/runtime/state.json`。

```typescript
type LoopState = {
  version: 1
  queue: QueueItem[]
  repository: string | null
  baseBranch: string | null
  recentRuns: unknown[]
  current: CurrentRun | null
}

type QueueItem = {
  [idField]: string | number     // preset 定义的 id 字段
  status: string                 // preset statuses 集合内
  attempts: number | null
  title: string | null
  priority: "high" | "medium" | "low" | null
  branch: string | null
  pr: number | null
  lastRunId: string | null
  issueFile: string | null
  evidenceDir: string | null
  agentCwd: string | null        // 跨 repo 时指定绝对路径
  runner: "claude" | "codex" | null
}

type CurrentRun = {
  phase: string                  // preset phases 内
  runId: string
  startedAt: string              // ISO 8601
  [idField]: string | number
}
```

不变量（`--check-runtime` 强制）：queue id 不重复、status 在 preset 集合内、current.phase 在 preset phases 内、agentCwd 必须是已存在的绝对目录。

---

## 11. CLI Flags 全表

### 子命令

| 子命令 | 主要 flags |
|---|---|
| `install <target>` | `--repo` `--preset` `--force` `--dry-run` `--install-skills` |
| `uninstall <target>` | — |
| `doctor <target>` | `--repo` |
| `status <target> --json` | `--config` `--repo` |
| `daemon start <target>` | `--require-browser-evidence` `--max-iterations` `--worktree` `--dry-run` |
| `daemon stop <target>` | `--dry-run` |
| `daemon restart <target>` | 同 start |
| `daemon status [<target>] --json` | — |
| `daemon down` | — |
| `queue unblock <target>` | `--issue` `--start-daemon` `--require-browser-evidence` |

### 主循环 flags

| Flag | 默认 | 含义 |
|---|---|---|
| `<N>` | 无限 | 最大轮次 |
| `--target-cwd <path>` | cwd | target 目录 |
| `--require-browser-evidence` | false | 启用最强 E2E 证据要求 |
| `--worktree` | false | 在 git worktree 中执行 |
| `--once` | false | 跑 1 轮 |
| `--dry-run` | false | 选 item 不 spawn |
| `--check-runtime` | false | 只校验 schema |
