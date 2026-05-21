# Operations Reference

排障、debug、改状态的参考。

排障入口永远是稳定 CLI，不要直接读 runtime 文件：

```bash
coder-loop doctor /path/to/target --repo owner/repo
coder-loop status /path/to/target --json
coder-loop daemon status /path/to/target --json
```

---

## 1. Daemon 架构

单进程集中 daemon，管理所有 target 的队列调度。

### 存储布局

```
~/Ext/loop-data/
  state.db          # SQLite（WAL mode，busy_timeout=5000ms）
  daemon.sock       # Unix domain socket
  daemon.pid        # PID file
  chains/
    <chain-name>/
      shared.md     # 持久化跨 run 上下文
      issues/       # issue markdown handoff 文件
      evidence/     # 证据目录（截图、日志）
      runs/
        <run-id>/
          events.jsonl              # 结构化事件流
          <phase>/
            latest.md               # 最新 attempt 索引
            stdout.jsonl            # agent JSONL 输出
            stderr.txt              # agent stderr
            status.json             # spawn 元数据
            sessions.jsonl          # 跨 attempt 会话记录
      daemon/
        <timestamp>/
          engine.log    # daemon 引擎日志
          stdout.log    # 子进程 stdout 汇总
          stderr.log    # 子进程 stderr 汇总
```

`state.db` 三张表：

| 表 | 内容 | 主键 |
|---|---|---|
| `chains` | 命名工作队列，绑定 preset / repo / baseBranch | `id` (INTEGER) |
| `items` | 队列条目，映射到 GitHub issue | `id` (INTEGER)，UNIQUE(chain_id, issue, repo_cwd) |
| `runs` | 执行记录，每 (item, phase) 一条 | `id` (TEXT, run-id string) |

Item 调度优先级：`priority`（high > medium > low）→ `attempts` ASC → `id` ASC。Pending statuses：`queued`、`changes_requested`。Terminal statuses：`done`、`moot`、`blocked`、`merged`、`skipped`、`failed-permanent`。

### 命令

| 命令 | 行为 |
|---|---|
| `daemon start <target>` | socket 不在线则启动 daemon 进程；然后导入 target queue 到 DB（幂等：已存在的 chain 做 upsert）。Legacy `state.json` 自动迁移到 DB |
| `daemon stop <target>` | 暂停 target items，daemon 进程继续服务其他 target |
| `daemon restart <target>` | stop + start，返回单个 JSON |
| `daemon status [<target>] --json` | 无 target：daemon 全局状态。有 target：chain / items / slots 快照 |
| `daemon down` | 优雅关闭 daemon（给子进程 5s SIGTERM grace） |

### Socket 协议

JSONL：一行一个 JSON request，一行一个 JSON response。

```jsonc
// 请求
{"cmd": "daemon.status"}
{"cmd": "chain.create", "name": "my-chain", "preset": "gh-issue-pr-iteration", "repo": "owner/repo"}
{"cmd": "item.add", "chain": "my-chain", "issue": 42, "repoCwd": "/path/to/repo"}
{"cmd": "item.list", "chain": "my-chain"}
{"cmd": "item.update", "itemId": 7, "patch": {"status": "queued", "attempts": 0}}
{"cmd": "chain.complete", "chain": "my-chain"}
{"cmd": "daemon.shutdown"}

// 响应
{"ok": true, "data": ...}
{"ok": false, "error": "..."}
```

### 调度器

`src/scheduler.ts` 每 5 秒 tick 一次。核心概念：

- **Slot**：(chainId, repoCwd) 唯一。每个 slot 同时最多一个 running agent 子进程
- **Tick**：遍历所有 active chains → 遍历每个 chain 的 repoCwd → 如果 slot 空闲且有 pending item → spawn 引擎子进程
- **Chain completion**：当一个 chain 的所有 items 都处于 terminal status 且没有 busy slot 时，自动标记 chain 为 `completed`
- **Rate limit**：agent 遇到 429 时，daemon 从 stdout 提取 reset 时间戳（`CODER_LOOP_RATE_LIMIT` 或 `rate_limit_event` JSONL），暂停调度直到 reset 时间点，然后进入 stagger 模式（30s 窗口内限制 maxSpawns=1）

---

## 2. `status --json` 结构

| 顶层字段 | 内容 |
|---|---|
| `target` | cwd、config/workflow/state 路径、preset metadata、runner 选择 |
| `state` | `kind` discriminant：`ok` / `missing-config` / `invalid-state` / ... |
| `queue` | `total`、`continuable`、`terminal`、按 status 分组的 `byStatus`、`selected` item |
| `current` | 当前 run（phase、runId、startedAt）、phase status（runner、pid、exitCode、sessionId） |
| `events` | events JSONL 路径、最近事件列表、latest 事件 |
| `processes` | `.dev-loop` 归属信息、pid alive、匹配的 live process 列表 |

Runner 选择字段：

| 路径 | 含义 |
|---|---|
| `target.runner.hostDefault` | 机器级默认 runner kind |
| `target.runner.default` | target iteration runner（kind/source/binary/model） |
| `target.runner.reviewDefault` | review runner |
| `queue.selected.runner` | 当前选中 item 的 iteration runner |
| `queue.selected.reviewRunner` | 当前选中 item 的 review runner |

---

## 3. Agent 进程生命周期

### Spawn

引擎为每个 phase 调用 `buildRunnerInvocation` 构造 CLI 命令：

- **Codex**：`codex --ask-for-approval never exec --json --cd <agentCwd> --sandbox danger-full-access [--add-dir ...] <prompt>`
- **Claude**：`claude -p --output-format stream-json --verbose [--add-dir ...] <prompt>`

子进程以 `detached: true` 启动（成为进程组 leader），stdout/stderr 分别写入 `stdout.jsonl` 和 `stderr.txt`。

### Session 和 Resume

每次 spawn 结束后，引擎把 (attempt 时间、runner、model、sessionId、exitCode、terminated 原因) 追加到 `sessions.jsonl`。

下次对同一 item 同一 phase 执行时，引擎检查 `sessions.jsonl` 最后一条记录：如果 runner 和 model 兼容且上次是非正常终止（rate limit、timeout、crash），自动 resume：

- Claude：`claude --resume <sessionId> -p <continue-prompt>`
- Codex：`codex exec resume <threadId> --json --ignore-rules <continue-prompt>`

Runner/model 不兼容时放弃 resume，重新 spawn。

### 两个终止机制

**Post-summary watchdog**：agent 输出 `ITERATION SUMMARY:` 或 `REVIEW SUMMARY:` 后启动 5 分钟定时器。超时发 SIGTERM（给进程组），5 秒后 SIGKILL。用于防止 agent 在已完成总结后继续做无效工作。

**Attempt timeout**：`preset.toml` 的 `attemptTimeoutSeconds`（默认 3600）。如果 agent 在此时间内未产出 summary marker，发 SIGTERM/SIGKILL。如果 watchdog 已经 armed（说明 summary 已输出），attempt timeout 自动取消。

两个机制都对进程组发信号（`kill(-pid, sig)`），确保 agent 的子进程（bash、sleep、browser 等）一起被杀。

### Events JSONL

每个 run 产出 `events.jsonl`，事件类型：

| 类型 | 时机 |
|---|---|
| `queue.select` | item 被选中 |
| `phase.start` | phase spawn 前 |
| `attempt.start` | 单次 attempt 开始（含 pid、resume 状态） |
| `attempt.timeout` | attempt timeout 触发 |
| `watchdog.fire` | post-summary watchdog 触发 |
| `attempt.close` | 单次 attempt 结束（含 exitCode、terminated 原因、sessionId） |
| `phase.end` | phase 结束（含 exitCode、duration） |
| `queue.terminal` | item 进入 terminal status |

---

## 4. Review Verdict

Review agent 的最后一个 agent message 必须以 `REVIEW SUMMARY: verdict=<v>;` 结尾。引擎解析最后一个 verdict（忽略中间引用的 stale summary）。

有效 verdict：`accepted`、`retry`、`skip`、`blocked`、`stop`。

解析方式随 runner 不同：Codex 从 `agent_message` JSONL 事件提取 text；Claude 从 `assistant` 事件的 `message.content` text 部分提取。如果整个 stdout 没有被解析为 JSONL 事件，回退到对原始文本做解析。

---

## 5. Issue Kind 路由

引擎从 GitHub label 获取 issue kind（`kind:code`、`kind:comment`、`kind:code-spike`、`kind:blocked`），注入为 `runtime.issueKind`。Preset prompt 根据 kind 决定 iteration 行为：

- `code`：正常代码 PR 路径
- `comment`：PR comment / review reply 路径，不开新 PR
- `code-spike`：source-writing spike evidence，不走 merge
- `blocked`：解除阻塞条件并恢复被阻塞 loop

---

## 6. Worktree 模式

`--worktree` 在 `<targetCwd>/.coder-loop-worktrees/` 下为每个 item 创建 git worktree，基于 `origin/<baseBranch>` 创建分支。item 进入 terminal 后自动 remove worktree。启动时 prune 不再 continuable 的 stale worktree。

需要 config 中 `baseBranch` 非空。

---

## 7. Legacy `state.json`

文件位置：`<target>/.coder-loop/runtime/state.json`。集中 daemon 架构下，`install` 和 `daemon start` 自动把 legacy state 迁移到 SQLite DB。迁移是幂等的（duplicate 做 update）。

迁移后 legacy `state.json` 保留作为备份源（安装时会写 `.bak`），但不再被引擎主路径读取。

直接引擎调用（`bun src/loop.ts --target-cwd ... --once`）仍读写 `state.json`，但 daemon 调度走 DB 路径。

---

## 8. `kind:blocked` 跨仓工作流

1. Review 判定 item 状态为 `blocked`，在 state 中记录 `blockerRepo` / `blockerRef`
2. `blocked-responder` trigger phase（`afterPhase=review, whenStatus=blocked`）在 blocker 仓创建 follow-up issue，注入该仓 queue，启动该仓 daemon
3. Blocker 仓 follow-up PR merge 后，对原仓执行 unblock：

```bash
coder-loop queue unblock /path/to/source-target --issue 123 --start-daemon --require-browser-evidence
```

---

## 9. `.dev-loop` Sentinel

Legacy 循环控制文件（直接引擎调用时使用）。引擎启动时创建，在主循环每轮迭代间检查——删除后当前 phase 跑完正常退出。不会强杀 in-flight agent。

集中 daemon 架构下通常用 `daemon stop/start` 代替手动操作此文件。进程崩溃后 `.dev-loop` 不自动清理，可能导致 `doctor` 报告 stale loop file，手动 `rm .dev-loop` 即可。

---

## 10. Debug 速查

```bash
# 看当前运行状态
coder-loop status . --json | jq '.current, .events.latest'

# 看最近的 run 日志
ls -lt ~/Ext/loop-data/chains/<chain>/runs/ | head

# 看某个 run 的 iteration phase 输出
cat ~/Ext/loop-data/chains/<chain>/runs/<run-id>/iteration/stdout.jsonl | head -20

# 看 daemon 引擎日志
tail -50 ~/Ext/loop-data/chains/<chain>/daemon/<latest>/engine.log

# 看 review verdict
cat ~/Ext/loop-data/chains/<chain>/runs/<run-id>/review/stdout.jsonl \
  | grep -o '"REVIEW SUMMARY:.*"' | tail -1

# check-runtime 校验
coder-loop --target-cwd . --check-runtime
```

### 常见 `--check-runtime` 错误

| 错误 | 修法 |
|---|---|
| `state.version: must be 1` | legacy state.json 加 `"version": 1` |
| `state.repository: must match configured` | 对齐 state.json 和 config.json 的 repository |
| `workflow: must be outside .coder-loop/runtime` | workflow.md 放 `.coder-loop/` 不是 `runtime/` 下 |
| `duplicate id` | queue 去重 |
| `status "foo" is not in preset.statuses` | 用 preset 声明的 status 值 |
| `current.issue: non-continuable status` | legacy 路径：`jq '.current = null' state.json > t && mv t state.json` |

---

## 11. 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `CODER_LOOP_DATA_ROOT` | loop-data 根目录 | `~/Ext/loop-data` |
| `CODER_LOOP_IDLE_SLEEP_MS` | 队列空时 sleep 毫秒数 | 30000 |
