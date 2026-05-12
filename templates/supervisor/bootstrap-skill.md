---
name: bootstrap
description: Bootstrap a fresh session into the target project's supervisor / coder-loop context. Resolves the target dir, repo slug, and active mission from local state, derives current state from state.json + gh + processes, and reports current situation plus next supervisor action. Use when resuming work after compaction, restart, cron wake, or `/resume`.
disable-model-invocation: true
allowed-tools: Read, Bash, BashOutput, KillShell, Glob, Grep
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

Prefer the events.jsonl subscription path (Step 4a) for "what's running right now" and use state.json + gh + logs (Step 4b) as authoritative cross-checks. The two never disagree about the current issue / phase / pr in a healthy loop; if they do, state.json wins (events.jsonl is best-effort) and the supervisor logs the divergence.

#### Step 4a — Snapshot via events.jsonl (preferred fast-path)

`coder-loop` writes per-run append-only NDJSON to `$TARGET_DIR/.coder-loop/runtime/events/<runId>.jsonl`. Each line carries `ts` / `type` / `runId` / `issueId` / `pr` / `branch` / `phase` (+ type-specific fields). Snapshot the latest run without subscribing:

```bash
LATEST_EVENTS=$(ls -t "$TARGET_DIR/.coder-loop/runtime/events/"*.jsonl 2>/dev/null | head -1)
printf 'latest events file: %s\n' "${LATEST_EVENTS:-<none>}"

if [ -n "$LATEST_EVENTS" ]; then
  # "What issue / PR / phase right now"
  tail -n 50 "$LATEST_EVENTS" | jq -r 'select(.type=="phase.start") | "\(.issueId) phase=\(.phase) pr=\(.pr // "null") branch=\(.branch // "null")"' | tail -1
  # Most recent attempt termination
  tail -n 50 "$LATEST_EVENTS" | jq -c 'select(.type=="attempt.close") | {ts, issueId, phase, terminated, exitCode}' | tail -1
  # Any recent watchdog forced-terminate
  tail -n 50 "$LATEST_EVENTS" | jq -c 'select(.type=="watchdog.fire")'
fi
```

If `LATEST_EVENTS` is empty (engine never ran here, or the engine version predates events.jsonl), skip Step 4a and rely on Step 4b alone.

#### Step 4b — Authoritative cross-check (state.json + gh + logs)

```bash
jq '{current: .current, queue_counts: (.queue | group_by(.status) | map({status: .[0].status, n: length})), in_progress: (.queue | map(select(.status=="in_progress")))}' \
  "$TARGET_DIR/.coder-loop/runtime/state.json"

gh issue list --repo "$TARGET_REPO" --state open --limit 30
gh pr list   --repo "$TARGET_REPO" --state open --limit 10

ls -lt /tmp/${LOG_PREFIX}*.log 2>/dev/null | head -3
ps -ef | grep -E "(coder-loop|caffeinate.*coder-loop)" | grep -v grep
```

#### Step 4c — Subscribe to live events (Bash run_in_background + BashOutput)

When the patrol needs to wait for the next state transition (long-running iter, in-flight watchdog window, expecting `queue.terminal`), spawn a background `tail -F` and pull increments via `BashOutput` instead of polling files in a sleep loop:

```
Bash({
  command: `tail -F -n +1 "${LATEST_EVENTS}"`,
  run_in_background: true,
  description: "subscribe coder-loop events.jsonl"
})
```

The tool returns a shell id. Periodically call `BashOutput(bash_id=<id>)` to fetch new stdout since the last read; each non-empty line is one JSON event. Pass `filter='"type":"(phase\\.|watchdog\\.|queue\\.terminal)"'` to suppress per-attempt chatter when only phase-level transitions matter. When the run ends (you observe `queue.terminal` for the current issue, or the file mtime stops moving across multiple patrols), call `KillShell(shell_id=<id>)` to stop the tail; the next runId gets a fresh tail spawned against the new `events/<newRunId>.jsonl`.

`tail -F` (capital F) follows by name, so the subscription survives log rotation / atomic-rename writes. `tail -n +1` replays the file from the start so the first `BashOutput` read gives the full backlog; subsequent reads are pure increments.

#### Step 4d — type → action matrix

| event.type | supervisor reaction |
|---|---|
| `queue.select` | record "current issue + pr + branch", reset phase / attempt timers |
| `phase.start` | mark phase entry, start phase-elapsed clock |
| `attempt.start` | record attempt pid + `resume` mode (`fresh` / `resume`); use for stuck-detection comparisons |
| `attempt.close` | inspect `terminated.kind`: `clean` = normal; `signal` / `error` = engine will resume or backoff per `decideResume` / `isTransient5xx`; `watchdog` = post-summary forced-terminate, next phase should auto-advance |
| `watchdog.fire` | engine self-recovered; record `signal=SIGTERM/SIGKILL`. Repeated fires on the same `attemptStartedAt` without a follow-up `attempt.close` → escalate to manual kill |
| `phase.end` | check `exitCode`; review-phase exit 0 with no new `queue.select` line means the loop ran out of actionable items |
| `queue.terminal` | item reached terminal status (e.g. `merged` / `dropped`); supervisor can drop attention on that issue |

#### Step 4e — handling run switches

Each issue gets its own runId → its own events file. The active subscription must follow:

```bash
NEW=$(ls -t "$TARGET_DIR/.coder-loop/runtime/events/"*.jsonl 2>/dev/null | head -1)
if [ "$NEW" != "$LATEST_EVENTS" ]; then
  # Stop the old background tail, start a new one against $NEW
  printf 'run switch: %s -> %s\n' "$LATEST_EVENTS" "$NEW"
fi
```

Per patrol: re-resolve `LATEST_EVENTS`; if it changed, `KillShell` the old subscription and `Bash(run_in_background:true)` a new `tail -F` against the new file. Tailing all files at once (`tail -F .../events/*.jsonl`) is possible but cross-run ordering is by mtime and not always clean — prefer one-tail-per-run for live patrols and batch `cat`/`jq` for historical replay.

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
| Live event stream (recommended subscription source) | `$TARGET_DIR/.coder-loop/runtime/events/<runId>.jsonl` (per-run NDJSON) |
| Loop queue / current run / run history (authoritative) | `$TARGET_DIR/.coder-loop/runtime/state.json` |
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
