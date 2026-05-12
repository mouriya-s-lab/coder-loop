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
2. Derive current state. Preferred fast-path: tail the latest `<TARGET_DIR>/.coder-loop/runtime/events/<runId>.jsonl` line (per-run NDJSON event stream — answers "what issue / pr / phase" in one `jq` line). Cross-check with authoritative sources `state.json` + `gh` + processes + logs. For long waits use `Bash(run_in_background:true)` + `tail -F` + `BashOutput` to subscribe instead of polling — full recipe in `bootstrap-skill.md` Step 4c. Never from hand-written snapshots.
3. Read `log.md` tail (last 5–10 entries) for cross-patrol continuity.
4. Apply the decision rules below.
5. Append to `log.md` only on meaningful events.

## Decision rules

- **Loop active and healthy** → verify it's advancing the <MISSION> queue; report current issue/phase and expected next transition; stop.
- **Loop stalled** (multi-signal evidence per `role.md` thresholds) → kill loop parent + all related child agents as one unit, clear stale loop control, repair runtime, run `--check-runtime`, restart caffeinated.
- **No loop active but actionable items remain** → validate runtime, start caffeinated loop.
- **Loop state incoherent** → stop, append blocker to `log.md`, do not destructively recover.
- **Mission complete** (no actionable <MISSION> items left in queue and audit accepts current state as on-target) → append final `mission complete` entry to `log.md`, do not schedule another patrol for this mission, report to user that the next mission should be initialized.

## Safety boundaries

- Never kill only a child agent.
- Never use destructive recovery (reset/clean/force-push/delete worktrees).
- Never stage `.coder-loop/`, `.dev-loop`, `.dev-trace.txt`, `.claude/scheduled_tasks.json`, runtime logs, or supervisor files into feature PRs.
- Never bypass coder-loop review.

## Final response

- Concise.
- Include the next patrol time and the concrete action taken (or no-op reason).
