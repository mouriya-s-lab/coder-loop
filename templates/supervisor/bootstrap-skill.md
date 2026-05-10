---
name: bootstrap
description: Bootstrap a fresh session into the <TARGET_REPO> supervisor / coder-loop context. Reads the active mission's role and log, derives current state from state.json + gh + processes, and reports current situation plus next supervisor action. Use when resuming work after compaction, restart, cron wake, or `/resume`.
disable-model-invocation: true
allowed-tools: Read, Bash, Glob, Grep
---

# Bootstrap into <TARGET_REPO> supervisor context

This project uses a two-layer architecture. **You are the outer layer (supervisor)**; the inner layer is `coder-loop`. State is split across three different stores. Bootstrap = read them in the right order, then report.

## Architecture

- **Inner — `coder-loop`** (harness): iterates one issue at a time, runs iter→review→PR. Source: `/Users/mouriya/Ext/code/coder-loop/src/loop.ts`.
- **Outer — supervisor agent + cron**: stateless, cron-woken, ensures the right mission is being worked, unblocks the inner loop, manages the issue graph.

The two layers do not share state. The outer steers the inner via `state.json` + process control + GitHub.

## Mission scope

Only one mission is active at a time. Each has its own dir:

```
.coder-loop/runtime/supervisor/<mission>/
  role.md          # durable role contract
  patrol-entry.md  # cron re-entry prompt
  log.md           # append-only cross-patrol event stream
```

Past missions stay on disk after `mission complete`; do not start a new mission silently. Active mission = the one whose `log.md` is most recently modified (or the only one).

## Where state actually lives — never duplicate

| Kind | Source |
|---|---|
| Long-term direction / lessons / safety boundaries | `<MEMORY_PROJECT_DIR>` (auto-loaded via `MEMORY.md`) — only if the target uses auto-memory |
| Cross-patrol decisions / restarts / blockers (this mission) | `<mission>/log.md` |
| Loop queue / current run / run history | `.coder-loop/runtime/state.json` |
| Issue/PR truth | `gh` on `<TARGET_REPO>` |
| Liveness | `/tmp/<LOG_PREFIX>-*.log` + `.coder-loop/runtime/logs/*.status.json` + process tree |

Anything derivable from these sources must not be re-written into a hand-maintained MD.

## Bootstrap procedure (execute in order, then report)

1. **Identify active mission:**

   ```bash
   ls -lt <TARGET_DIR>/.coder-loop/runtime/supervisor/
   ```

   Pick the directory whose `log.md` was modified most recently (or the only one). Call it `<mission>` below.

2. **Read the mission's role contract:** `<mission>/role.md` (full).

3. **Read the mission's recent decisions:** `<mission>/log.md` (tail ~200 lines or last 5–10 entries).

4. **Derive current state:**

   ```bash
   jq '{current: .current, queue_counts: (.queue | group_by(.status) | map({status: .[0].status, n: length})), in_progress: (.queue | map(select(.status=="in_progress")))}' \
     <TARGET_DIR>/.coder-loop/runtime/state.json

   gh issue list --repo <TARGET_REPO> --state open --limit 30
   gh pr list   --repo <TARGET_REPO> --state open --limit 10

   ls -lt /tmp/<LOG_PREFIX>-*.log 2>/dev/null | head -3
   ps -ef | grep -E '(coder-loop|caffeinate.*coder-loop)' | grep -v grep
   ```

5. **Report a concise situation:**

   - Active mission + its contract one-liner.
   - Last meaningful event from `log.md`.
   - Loop liveness verdict (running / stalled / stopped) with multi-signal evidence (process + log mtime + status JSON + elapsed-time vs. phase).
   - Current issue / phase / runId / queue counts from `state.json`.
   - Open PRs and their states (focus on PRs that block this mission).
   - Recommended next supervisor action; flag whether you'll take it now or want user confirmation.

## Cron re-entry convention

Self-rescheduling cron prompts for this project must be exactly one line, nothing else:

```
Read <TARGET_DIR>/.coder-loop/runtime/supervisor/<mission>/patrol-entry.md and follow it exactly.
```

Never inline full patrol rules into the cron prompt. Never use recurring cron expressions (`*/15 * * * *` etc.). Never use launchd or external `claude -p`.

## Durable external paths

- Target repo: `<TARGET_REPO>`. Worktree: `<TARGET_DIR>`.
- coder-loop source: `/Users/mouriya/Ext/code/coder-loop/src/loop.ts`.
- Upstream repo (if applicable): `<UPSTREAM_REPO_URL>`.
