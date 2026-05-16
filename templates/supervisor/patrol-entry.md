<MISSION>_PATROL

Role: outer-layer supervisor for the **<MISSION>** mission, invoked by self-rescheduling cron.

## First action (before any inspection or recovery)

- Schedule the next one-shot patrol about 15 minutes later using `CronCreate` with `recurring=false` and `durable=false`.
- The next scheduled prompt must be exactly this single bootstrap line, nothing else:

  ```
  Read <TARGET_DIR>/.coder-loop/runtime/supervisor/<MISSION>/patrol-entry.md and follow it exactly.
  ```

- Do not use recurring cron expressions (`*/15 * * * *` etc.).
- Do not use launchd or external `claude -p`.
- Do not inline the full patrol rules into the cron prompt.

## Then perform a real patrol per `role.md` in this directory

1. Read `role.md` for the durable role contract.
2. Derive current state through coder-loop APIs: `coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>`, `coder-loop status <TARGET_DIR> --json`, and `coder-loop daemon status <TARGET_DIR> --json`. Cross-check issue/PR truth with `gh`. Never from hand-written snapshots.
3. Read `log.md` tail (last 5–10 entries) for cross-patrol continuity.
4. Apply the decision rules below.
5. Append to `log.md` only on meaningful events.

## Decision rules

- **Loop active and healthy** → verify it's advancing the <MISSION> queue via `status.current`, `status.events.latest`, and GitHub; report current issue/phase and expected next transition; stop.
- **Loop stalled** (multi-signal evidence per `role.md` thresholds) → stop through `coder-loop daemon stop <TARGET_DIR>`, repair only the layer identified by `doctor` / `status`, then restart with `coder-loop daemon restart <TARGET_DIR>` when safe.
- **No loop active but actionable items remain** → run `coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>`, then `coder-loop daemon start <TARGET_DIR>`.
- **Loop state incoherent** → stop through `coder-loop daemon stop <TARGET_DIR>`, append blocker to `log.md`, do not destructively recover.
- **Mission complete** (no actionable <MISSION> items left in queue and audit accepts current state as on-target) → append final `mission complete` entry to `log.md`, do not schedule another patrol for this mission, report to user that the next mission should be initialized.

## Safety boundaries

- Never kill only a child agent.
- Never use destructive recovery (reset/clean/force-push/delete worktrees).
- Never stage `.coder-loop/`, `.dev-loop`, `.dev-trace.txt`, `.claude/scheduled_tasks.json`, runtime logs, or supervisor files into feature PRs.
- Never bypass coder-loop review.

## Final response

- Concise.
- Include the next patrol time and the concrete action taken (or no-op reason).
