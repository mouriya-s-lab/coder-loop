---
name: coder-loop
description: "Operate coder-loop as a generic task-state-machine runner. Use when installing coder-loop in a repo, checking loop health/status, starting or recovering loop daemons, choosing Claude vs Codex runners, shaping queue work, or explaining how supervisor should consume coder-loop without reading runtime internals first."
---

# coder-loop

This file is the repo-owned source for the operator-facing coder-loop skill. Keep command details aligned with `docs/operations.md` and the live `src/loop.ts` CLI surface.

## Core model

Coder-loop is a preset-driven task progress engine, not a GitHub-only workflow. The engine owns loop continuation mechanics; the active preset and target policy own task semantics, review gates, evidence quality, and terminal decisions.

Treat the centralized daemon plus chain/item store as the operational runtime. Use the CLI API first, then inspect fallback files only when a status/doctor result points to a concrete local artifact.

## Stable first reads

For bootstrap and health, use these before reading runtime internals:

```bash
coder-loop install <target-cwd> --repo <owner>/<repo>
coder-loop doctor <target-cwd> --repo <owner>/<repo>
coder-loop status <target-cwd> --json
coder-loop daemon status <target-cwd> --json
```

`status` is the machine contract for supervisors and scripts. It exposes target config, queue counts, selected item, current run, event path, live process scan, and runner selection.

## Daemon lifecycle

Central daemon lifecycle and target-chain lifecycle are distinct:

```bash
coder-loop daemon up --json
coder-loop daemon down --json
coder-loop daemon status <target-cwd> --json
coder-loop daemon start <target-cwd>
coder-loop daemon stop <target-cwd>
coder-loop daemon restart <target-cwd>
```

`daemon up/down` controls the central socket service. `daemon start/stop/restart <target-cwd>` resolves the target chain and operates through the daemon API; do not rebuild old background-process launch paths.

## Chain and item operations

Use chain/item commands for queue-shape and recovery work instead of editing runtime storage directly:

```bash
coder-loop chain create <name> --repo <owner>/<repo> --preset <preset>
coder-loop chain list --json
coder-loop chain status <name> --json
coder-loop chain delete <name>

coder-loop item add --chain <name> --issue <number> --repo-cwd <target-cwd>
coder-loop item list --chain <name> --json
coder-loop item update --chain <name> --issue <number> --status <status>
```

For blocked follow-up recovery, use the preset-aware queue helper:

```bash
coder-loop queue unblock <target-cwd> --issue <id> --start-daemon --require-browser-evidence
```

## Runner selection

Runner choice is runtime policy, not preset business state:

- Built-in iteration default is `codex`.
- Target config may set the default iteration runner.
- A queue item may override only its own iteration runner.
- Review runner defaults to `claude` unless target config sets `reviewRunner`; Claude review forces the review model defined by the engine contract.

Check actual runner truth through `coder-loop status <target-cwd> --json`: `target.runner.default`, `target.runner.reviewDefault`, `queue.selected.runner`, `queue.selected.reviewRunner`, `current.runner`, and `current.phaseStatus.value.runner/model`.

## Recovery discipline

Use `doctor`, `status`, and `daemon status` to identify the broken layer before changing anything. If bootstrap is missing, run `coder-loop install`. If a target has actionable items and no live loop, run `coder-loop daemon start`. If a target is wedged, collect status output and stop/restart through daemon APIs.

Only inspect fallback logs or local runtime artifacts after the stable API has named the relevant path. Do not make target-local files or old sentinel artifacts the source of truth for queue/current state.

## Supervisor handoff

Supervisor should verify blockers, route repo-owned fixes into the owning repo as issues, and let that repo's coder-loop own source changes and implementation PRs. For `kind:blocked` follow-ups, let review acceptance call `coder-loop queue unblock` on the originally blocked target rather than manually flipping status fields.
