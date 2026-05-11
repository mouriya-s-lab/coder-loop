---
name: bootstrap
description: Bootstrap a fresh session into the target project's supervisor / coder-loop context. Resolves the target dir, repo slug, and active mission from local state, derives current state from state.json + gh + processes, and reports current situation plus next supervisor action. Use when resuming work after compaction, restart, cron wake, or `/resume`.
disable-model-invocation: true
allowed-tools: Read, Bash, Glob, Grep
---

# Bootstrap into the target project's supervisor context

The target uses a two-layer architecture. **You are the outer layer (supervisor)**; the inner layer is `coder-loop`. State is split across three different stores. Bootstrap = resolve target paths, read state in the right order, then report.

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

## Bootstrap procedure (execute in order, then report)

### Step 0 — Derive target context (runtime, no hand-edit)

Run from anywhere inside the target worktree. Export shell variables that every later step references:

```bash
TARGET_DIR="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel)"
TARGET_REPO="$(cd "$TARGET_DIR" && gh repo view --json nameWithOwner -q .nameWithOwner)"
LOG_PREFIX="coder-loop-$(basename "$TARGET_DIR")"
MEMORY_DIR="$HOME/.claude/projects/$(printf '%s' "$TARGET_DIR" | sed 's|/|-|g')/memory"
[ -f "$MEMORY_DIR/MEMORY.md" ] || MEMORY_DIR=""   # empty if target has no auto-memory

printf 'TARGET_DIR=%s\nTARGET_REPO=%s\nLOG_PREFIX=%s\nMEMORY_DIR=%s\n' \
  "$TARGET_DIR" "$TARGET_REPO" "$LOG_PREFIX" "${MEMORY_DIR:-<none>}"
```

If `TARGET_DIR` doesn't resolve or `gh repo view` errors, stop and report the failure — the target isn't set up.

### Step 1 — Identify active mission (list `supervisor/` by mtime, pick latest)

```bash
ls -lt "$TARGET_DIR/.coder-loop/runtime/supervisor/"
```

Pick the directory whose `log.md` was modified most recently (or the only one). Call it `<mission>` below. If none exist, report "no supervisor mission initialized" and stop.

### Step 2 — Read the mission's role contract

`$TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/role.md` (full). If `role.md` references an upstream repo or other mission-specific durable paths, they live here, not in this skill.

### Step 3 — Read the mission's recent decisions

`$TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/log.md` (tail ~200 lines or last 5–10 entries).

### Step 4 — Derive current state

```bash
jq '{current: .current, queue_counts: (.queue | group_by(.status) | map({status: .[0].status, n: length})), in_progress: (.queue | map(select(.status=="in_progress")))}' \
  "$TARGET_DIR/.coder-loop/runtime/state.json"

gh issue list --repo "$TARGET_REPO" --state open --limit 30
gh pr list   --repo "$TARGET_REPO" --state open --limit 10

ls -lt /tmp/${LOG_PREFIX}*.log 2>/dev/null | head -3
ps -ef | grep -E "(coder-loop|caffeinate.*coder-loop)" | grep -v grep
```

### Step 5 — Report a concise situation

- Active mission + its contract one-liner.
- Last meaningful event from `log.md`.
- Loop liveness verdict (running / stalled / stopped) with multi-signal evidence (process + log mtime + status JSON + elapsed-time vs. phase).
- Current issue / phase / runId / queue counts from `state.json`.
- Open PRs and their states (focus on PRs that block this mission).
- Recommended next supervisor action; flag whether you'll take it now or want user confirmation.

## Where state actually lives — never duplicate

| Kind | Source (variables resolved in Step 0) |
|---|---|
| Long-term direction / lessons / safety boundaries | `$MEMORY_DIR` (auto-loaded via `MEMORY.md`) — only if non-empty |
| Cross-patrol decisions / restarts / blockers (this mission) | `<mission>/log.md` |
| Loop queue / current run / run history | `$TARGET_DIR/.coder-loop/runtime/state.json` |
| Issue/PR truth | `gh` on `$TARGET_REPO` |
| Liveness | `/tmp/$LOG_PREFIX*.log` + `$TARGET_DIR/.coder-loop/runtime/logs/*.status.json` + process tree |

Anything derivable from these sources must not be re-written into a hand-maintained MD.

## Cron re-entry convention

Self-rescheduling cron prompts for this project must be exactly one line, nothing else:

```
Read $TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/patrol-entry.md and follow it exactly.
```

(Resolve `$TARGET_DIR` and `<mission>` to their concrete strings when scheduling — cron prompts run without this skill's shell context.)

Never inline full patrol rules into the cron prompt. Never use recurring cron expressions (`*/15 * * * *` etc.). Never use launchd or external `claude -p`.

## Mission-specific durable paths

The active mission's `role.md` owns mission-specific paths (upstream repos, design-doc anchors, demo repos, etc.). This skill does not enumerate them — read `role.md` after Step 1.
