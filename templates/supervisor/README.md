# Supervisor pattern templates

These templates implement an **outer-layer supervisor** that drives `coder-loop` (the inner harness). The supervisor handles cross-patrol continuity, mission scope, blocker resolution, and stateless cron re-entry. coder-loop only iterates one issue at a time; the supervisor decides whether the loop is on the right thing and whether to restart it.

Use this pattern when a target project has long-running multi-mission work (upstream sync, design-doc loops, channel implementations, etc.) that needs more than just running coder-loop end-to-end.

## Two-layer architecture

- **Inner — `coder-loop`** (this repo, `src/loop.ts`): iterates one issue at a time; iter→review→PR. Pure black box from the supervisor's perspective.
- **Outer — supervisor agent + cron** (these templates): stateless, cron-woken, ensures the right mission is being worked, unblocks the inner loop, manages issue graph, decides restart vs. wait.

The two layers do not share state. The outer steers the inner through coder-loop's stable operations API (`coder-loop doctor`, `coder-loop status <target> --json`, and `coder-loop daemon ...`) plus GitHub. coder-loop itself does not depend on this pattern.

## Mission scope

Only one mission active at a time. Each mission has its own dir under the target repo:

```
<TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/
  role.md          # durable role contract
  patrol-entry.md  # cron re-entry prompt
  log.md           # append-only cross-patrol event stream
```

Past missions stay on disk after `mission complete`; do not start a new mission silently. Concurrent missions are intentionally out of scope (would imply concurrent loops).

## What to copy

| From (this dir) | To (target project) | Placeholder handling |
|---|---|---|
| `bootstrap-skill.md` | `<TARGET_DIR>/.claude/skills/bootstrap/SKILL.md` | **verbatim copy, no hand-edit** — resolves target dir / repo / log prefix / memory dir at runtime via Step 0 shell block |
| `role.md` | `<TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/role.md` | mission-level placeholders need hand-edit on copy (see below) |
| `patrol-entry.md` | `<TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/patrol-entry.md` | mission-level placeholders need hand-edit on copy (see below) |

Plus seed an empty `<TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/log.md` with this header:

```
# <MISSION> supervisor log

Append-only cross-patrol event stream. Each patrol invocation appends one concise dated entry only on meaningful events: decision, restart, stall suspicion, blocker, issue/runtime transition, PR result, mission completion. Local runtime state, must not be committed.
```

## Placeholders in `role.md` / `patrol-entry.md` (replace on copy)

- `<TARGET_DIR>` — absolute path to the target repo worktree (e.g. `/Users/mouriya/Ext/code/<repo>`).
- `<TARGET_REPO>` — GitHub `owner/repo` slug (e.g. `Mouriya-Emma/<repo>`).
- `<MISSION>` — short kebab-case mission name (e.g. `upstream-alignment`).
- `<MISSION_DESCRIPTION>` — one-line goal sentence in role.md mission section.
- `<LOG_PREFIX>` — `/tmp` log-file prefix the loop uses for this mission (e.g. `coder-loop-<repo>-<mission>`).
- `<MEMORY_PROJECT_DIR>` — the encoded path under `~/.claude/projects/` if the target uses auto-memory (e.g. `~/.claude/projects/-Users-mouriya-Ext-code-<repo>/memory/`); otherwise remove the row.
- `<UPSTREAM_REPO_URL>` — only if the mission references an upstream; remove the line otherwise.

`bootstrap-skill.md` no longer contains these placeholders — it derives `TARGET_DIR / TARGET_REPO / MEMORY_DIR` at runtime and reads mission-specific paths from the active mission's `role.md`.

## Where state actually lives — never duplicate

| Kind | Source |
|---|---|
| Long-term direction / lessons | target project's user memory (`~/.claude/projects/.../memory/`) if used |
| Cross-patrol decisions for this mission | `<MISSION>/log.md` |
| Loop runtime snapshot | `coder-loop status <TARGET_DIR> --json` |
| Loop daemon liveness | `coder-loop daemon status <TARGET_DIR> --json` |
| Bootstrap / live health | `coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>` |
| Issue/PR truth | `gh` on `<TARGET_REPO>` |

Anything derivable from these sources must not be duplicated into a hand-written MD; that is how earlier `STATE.md` / `TODO.md`-style files went stale within a day. Only `log.md` (append-only history) is hand-maintained, because by definition each entry was true at its timestamp.

## Mission lifecycle

1. Initialize: copy + customize the three files; seed `log.md`.
2. Run: cron self-reschedules patrols using only the bootstrap line (see below). Each patrol reads role + log + derives state, then advances or no-ops.
3. Complete: append a final `mission complete` entry to `log.md`, stop scheduling more patrols, report to user.
4. Next mission: user creates a new directory under `supervisor/` with the same three-file shape. Don't reuse a completed mission's directory.

## Cron re-entry convention

Cron prompts must be exactly one bootstrap line, nothing else:

```
Read <TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/patrol-entry.md and follow it exactly.
```

Never inline full patrol rules into the cron prompt. Never use recurring cron expressions (`*/15 * * * *` etc.). Never use launchd or external `claude -p`.
