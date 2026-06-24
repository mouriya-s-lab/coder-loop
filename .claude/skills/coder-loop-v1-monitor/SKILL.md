---
name: coder-loop-v1-monitor
description: Monitor a running v1 per-target coder-loop daemon's phase progress (iteration/review agent spawn/finished, SUMMARY verdict, queue terminal transitions, blocked-responder skips, attempt timeouts). Use when the user wants to track "where the daemon is now", "is daemon still running", "看 daemon 跑哪了", "盯 v1 daemon", "monitor v1 phase 进展", or after starting `coder-loop daemon start <target>` (or `bun src/loop.ts daemon start <target>`) and needing continuous visibility. Wraps the Monitor tool with the correct stderr log discovery + `grep --line-buffered` filter so events stream in as notifications instead of forcing polling. Read-only — never restarts/stops the daemon.
---

# coder-loop-v1-monitor

监控 v1 `coder-loop` per-target daemon 的 phase 推进。v1 daemon 把所有 phase 事件写到 target 自己的 `.coder-loop/runtime/logs/coder-loop-daemon-<TS>.stderr.log`，本 skill 把 tail 这份 log 的工作封装成 Monitor 调用，每条匹配事件作为一条 chat 通知到达。

## 适用范围

- 只用于 **v1**（`stable-v1` branch 或同形态的 coder-loop binary）。v1 = `src/loop.ts daemon start <target>` 起的 per-target daemon，单 target 单进程，phase 顺序 iter→review→optional trigger 串行跑。
- v2（central daemon + scheduler tick + 多 chain 并发）有它自己的 `daemon up` socket + `~/.coder-loop/loop-data/db.sqlite` events 表，**不用本 skill**——v2 看 `coder-loop status <target> --json` / `daemon status` 或新版 system skill `coder-loop`。

## 当不该用

- 用户要**改**配置 / 重启 daemon / 停 daemon：本 skill 是 read-only，那些走 `bun src/loop.ts daemon stop|restart <target>`。
- 用户要看**单次** progress snapshot 不要订阅事件流：直接 `tail -50 <log>` + `coder-loop doctor . --repo <slug>` 即可，不必挂 Monitor。
- 用户要看 **agent 内部行为**（哪些 file 被 read/edit、tool_use 分布、prompt 内容）：tail stderr 看不到，要打开 `.coder-loop/runtime/logs/run-<TS>-issue-<N>.iteration.attempt-<TS>.<PID>.jsonl` 直接 `jq` 解析。

## 触发关键词

- "看 daemon 跑哪了" / "盯 v1 daemon" / "monitor v1 phase" / "daemon 还在跑吗 + 进展" / "下一 phase 啥时候完"
- 用户刚跑完 `bun .../loop.ts daemon start <target>` 等待结果

## 操作

### Step 1 — 确认 target 路径 + daemon 已起

向用户拿 target path（典型 `/Users/mouriya/Ext/code/coder-loop` 或者 pve-vctcn / homelab-tf 这类 IaC repo）。然后确认 daemon 在跑：

```bash
ps -ef | grep 'loop.ts.*--target-cwd <TARGET>' | grep -v grep
```

或读 daemon PID 文件（v1 把 pid 写到 target 的 `.coder-loop/runtime/.dev-loop` 文件）+ 检查进程：

```bash
PID=$(cat <TARGET>/.coder-loop/runtime/.dev-loop 2>/dev/null | head -1)
[ -n "$PID" ] && ps -p "$PID" -o pid,etime,stat,command
```

daemon 不在跑就 stop 在这里——告诉用户先 `bun /Users/mouriya/Ext/app/coder-loop/src/loop.ts daemon start <TARGET>` 再回来挂监控。

### Step 2 — 找最新 daemon stderr.log

v1 每次 `daemon start` 写一个新 stderr log，文件名 `coder-loop-daemon-<UTC-TS>.stderr.log`：

```bash
log=$(ls -t <TARGET>/.coder-loop/runtime/logs/coder-loop-daemon-*.stderr.log | head -1)
```

确认能读 + 非空。

### Step 3 — 挂 Monitor

调 `Monitor` 工具，`timeout_ms=3600000`（1h，覆盖 v1 默认单 phase `attemptTimeout=3600s`），`persistent=false`，命令如下：

```bash
log=$(ls -t <TARGET>/.coder-loop/runtime/logs/coder-loop-daemon-*.stderr.log | head -1)
tail -n 0 -F "$log" 2>/dev/null | grep -E --line-buffered "Starting (iteration|review) agent|review-on-empty|Iteration [0-9]+ \(work\) complete|Stop requested|Loop ended|Issue #[0-9]+ kind|Empty queue|Reached.*iteration|Agent \[(iteration|review)\] (finished|attempt closed)|Skipping trigger phase|kind=blocked|Resuming|Failed|fatal"
```

`description` 字段给具体内容（"v1 daemon phase 进展：<target 名>"），不要泛化。`grep --line-buffered` 是 unbuffered 关键，少了它事件可能延迟到 phase 结束才一次性吐出。

### Step 4 — 解释每条事件

事件流入时按下表给出短解读（不要每条都回复用户长篇，只在状态转换 / 异常 / 收尾时报告）：

| 事件 pattern | 含义 |
|---|---|
| `Issue #<N> kind=<k>` | 选中新 item 进 phase 起步 |
| `Starting iteration agent for issue #<N>` | iter agent spawn |
| `Agent [iteration] attempt closed: exit=0` | iter 进程退出（exit code + sessionId） |
| `iteration agent finished: ... duration=<S>s, output=<F> (<N> bytes)` | iter 完成统计 |
| `Starting review agent` | review agent spawn |
| `Agent [review] attempt closed: exit=0` | review 退出 |
| `review agent finished: ... duration=<S>s` | review 完成 |
| `Skipping trigger phase blocked-responder: status=<S>, wanted=blocked` | review verdict ≠ blocked，blocked-responder 跳过（正常路径，不是错） |
| `Iteration <N> (work) complete` | 当前 item 一轮 iter→review 完成；下面要么切下一 item 要么 retry 本 item |
| `Resuming iteration agent` | continuable status 续跑同 runId（不是新 attempt） |
| `Empty queue: running review-on-empty` | 队列空，跑 global assessment review |
| `Reached <N> iteration` | 达到 maxIterations 上限退出 |
| `Stop requested` / `Loop ended` | daemon 主动停 |
| `Agent [...] attempt failed` / `Failed` / `fatal` | 异常路径——要看 stderr.txt 细节 |

### Step 5 — Monitor timeout 后续挂

`tail -F` 不会自然退出（除非 log 被轮转 / 删除），所以 Monitor 会在 1h timeout 时被 kill。timeout 通知到达时：

1. `ps -p <DAEMON_PID> -o etime,stat` 确认 daemon 还活
2. `jq '.queue | map({issue, status, attempts})' <TARGET>/.coder-loop/runtime/state.json` 看 queue 进度
3. 如果 queue 还有 continuable item + daemon 活 → 重挂下一段 Monitor（同样命令）
4. 如果 queue 全 terminal / daemon 死 → 不挂了，直接报告最终状态

## v1 stderr 事件实测 timing 参考

来自 2026-05-27 `Ext/code/coder-loop` 跑 12 个 `kind:code` child 实测（iter=review=claude-opus-4-7）：

- 单 phase iter agent: 300s–1360s（5–22min），output 240KB–2.6MB
- 单 phase review agent: 384s–565s（6.4–9.4min），output 470KB–520KB
- 单 item iter+review 一轮: ~30min
- changes_requested retry 加一轮: +30min/item
- 12 个 child 估算总时长: ~6-8h（v1 串行 + 部分 retry）

如果用户嫌慢 → 用 `coder-loop status <target> --json` 看 queue.selected.runner 是不是 codex（codex 推理快，但无 session resume 每次重读源码反而慢）vs claude（有 session resume，但单次推理慢）。改 iter runner 改 `<target>/.coder-loop/runtime/config.json` 的 `"runner"` 字段。

## 直接看 agent 内部行为（非 Monitor 路径，用户问"agent 到底干了什么"）

```bash
jsonl=$(ls -t <TARGET>/.coder-loop/runtime/logs/run-*-issue-<N>.iteration.attempt-*.jsonl | head -1)

# tool_use 分布
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$jsonl" | sort | uniq -c | sort -rn

# Bash 命令前缀分布
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | select(.name == "Bash") | .input.command' "$jsonl" | awk '{print $1}' | sort | uniq -c | sort -rn

# Edit/Write 改了哪些文件
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | select(.name == "Edit" or .name == "Write") | .input.file_path' "$jsonl" | sort | uniq -c | sort -rn
```

这些只在用户具体问"做了什么"时跑，不在监控流里自动跑。

## 反例（不要犯）

- ❌ 用 Bash 循环 `sleep + cat` 轮询 log：消耗 cache TTL + 看不到 inter-event timing。Monitor 才是设计意图。
- ❌ `tail -f log | grep ...` 不加 `--line-buffered`：grep 默认 fully-buffered，phase 跑 20min 期间一条事件都不吐。
- ❌ 把 v2 system skill `coder-loop` 的 daemon API 命令（`daemon up` / `chain create` / `item add` / `chain status --json`）混进 v1 路径：v1 没有 chain 概念，所有这些 v2 API 都没有效果或不存在。
- ❌ Monitor `command` 写成 `cat $log`（一次性 dump）：不流式，事件不进 chat。
