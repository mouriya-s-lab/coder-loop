---
name: bootstrap
description: Bootstrap a fresh session into the target project's supervisor / coder-loop context. Resolves the target dir, repo slug, and active mission, reads mission files, queries coder-loop through its stable operations API, and reports current situation plus next supervisor action. Use when resuming work after compaction, restart, heartbeat wake, or `/resume`.
disable-model-invocation: true
allowed-tools: Read, Bash, Glob, Grep
---

# Bootstrap into the target project's supervisor context

The target uses a two-layer architecture. **You are the outer layer
(supervisor)**; the inner layer is `coder-loop`. Bootstrap resolves the mission
workdir, reads the mission contract, then asks coder-loop for its current state
through the stable operations API.

Do not rebuild coder-loop runtime knowledge here. Use:

- `coder-loop doctor <target>` for bootstrap and live runtime health.
- `coder-loop status <target> --json` for queue/current/events/process snapshot.
- `coder-loop daemon status <target> --json` for daemon ownership and liveness.
- `coder-loop daemon start|stop|restart <target>` for controlled loop changes.

## Mission scope

Only one mission is active at a time. Each mission has its own dir:

```
.coder-loop/runtime/supervisor/<mission>/
  role.md          # durable role contract
  patrol-entry.md  # heartbeat re-entry prompt
  PHASE            # init | running | complete
  log.md           # append-only cross-patrol event stream
```

Past missions stay on disk after `mission complete`; do not start a new mission
silently. Active mission = the one whose `PHASE` file says `running`. If exactly
one mission exists and has no `PHASE` file, treat it as legacy input and report
that the mission needs a `PHASE` file before unattended patrol continues.

## Bootstrap procedure

### Step 0 — Derive target context

Run from anywhere inside the target worktree:

```bash
TARGET_DIR="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel)"
TARGET_REPO="$(cd "$TARGET_DIR" && gh repo view --json nameWithOwner -q .nameWithOwner)"
MEMORY_DIR="$HOME/.claude/projects/$(printf '%s' "$TARGET_DIR" | sed 's|/|-|g')/memory"
[ -f "$MEMORY_DIR/MEMORY.md" ] || MEMORY_DIR=""

printf 'TARGET_DIR=%s\nTARGET_REPO=%s\nMEMORY_DIR=%s\n' \
  "$TARGET_DIR" "$TARGET_REPO" "${MEMORY_DIR:-<none>}"
```

If `TARGET_DIR` or `TARGET_REPO` cannot be resolved, stop and report that the
target is not ready for supervisor bootstrap.

### Step 1 — Identify active mission

```bash
find "$TARGET_DIR/.coder-loop/runtime/supervisor" -maxdepth 2 -name PHASE -print 2>/dev/null
```

Pick the single mission whose `PHASE` content is `running`. If more than one
mission is running, stop and report the conflict. If no mission is running,
report `no running supervisor mission initialized` and stop.

### Step 2 — Read durable mission files

Read these files before making any decision:

- `$TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/role.md`
- `$TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/patrol-entry.md`
- `$TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/log.md` tail, about the
  last 5-10 entries or last 200 lines
- `$MEMORY_DIR/MEMORY.md` only when `MEMORY_DIR` is non-empty

Mission-specific paths, upstream repos, and safety boundaries belong in
`role.md`. Do not copy them into this bootstrap skill.

### Step 3 — Query coder-loop state through stable APIs

```bash
coder-loop doctor "$TARGET_DIR" --repo "$TARGET_REPO"
coder-loop status "$TARGET_DIR" --json
coder-loop daemon status "$TARGET_DIR" --json
```

Use the JSON snapshots to derive:

- state health from `state.kind` / `state.ok`
- queue shape from `queue.total`, `queue.byStatus`, and `queue.selected`
- runner selection from `target.runner.default`, `queue.selected.runner`, and
  `current.runner`
- current run from `current.run`, `current.id`, and `current.phaseStatus`
- latest event summary from `events.latest`
- daemon ownership from `processes.loopFile`, `processes.live`, and
  `processes.scanError`

If `doctor` reports a bootstrap failure, repair with `coder-loop install
"$TARGET_DIR" --repo "$TARGET_REPO"` when that is obviously safe, then rerun
`doctor`. If `status` reports an invalid runtime state, record the blocker in
`log.md` before attempting manual file repair.

Runner note: do not assume Claude. Iteration defaults to Codex unless target
config or the selected queue item overrides it; review defaults to Claude unless
target config overrides it. Trust `status` / `doctor` output over runtime file
guesswork.

### Step 4 — Check GitHub truth

```bash
gh issue list --repo "$TARGET_REPO" --state open --limit 30
gh pr list --repo "$TARGET_REPO" --state open --limit 10
```

Use GitHub for issue/PR truth and coder-loop status for loop runtime truth. Do
not use a hand-written snapshot as a source of truth.

### Step 5 — Report a concise situation

Report:

- active mission and one-line goal from `role.md`
- last meaningful `log.md` entry
- coder-loop health from `doctor` / `status` / `daemon status`
- current selected item, runner, run, phase status, and queue counts
- open PRs or issues that block the mission
- recommended next supervisor action, and whether you already took it

## Where state actually lives

| Kind | Source |
|---|---|
| Mission contract | `<mission>/role.md` |
| Cross-patrol decisions / restarts / blockers | `<mission>/log.md` |
| Loop runtime snapshot | `coder-loop status "$TARGET_DIR" --json` |
| Daemon liveness and ownership | `coder-loop daemon status "$TARGET_DIR" --json` |
| Bootstrap / live health | `coder-loop doctor "$TARGET_DIR" --repo "$TARGET_REPO"` |
| Issue/PR truth | `gh` on `$TARGET_REPO` |
| Long-term lessons / safety boundaries | `$MEMORY_DIR` when present |

Anything derivable from these sources must not be re-written into a
hand-maintained state file.

## Heartbeat re-entry convention

Recurring durable heartbeat prompts for this project must be exactly one line,
nothing else:

```
Read $TARGET_DIR/.coder-loop/runtime/supervisor/<mission>/patrol-entry.md and follow it exactly.
```

Resolve `$TARGET_DIR` and `<mission>` to concrete strings when scheduling. Never
inline full patrol rules into the heartbeat prompt. Use one recurring durable
heartbeat for the active mission, typically every 15 minutes (`*/15 * * * *`).
Never use launchd or external `claude -p`.
