# Quality: cleanup

Side-effect discipline — executors declare what they did; orchestrators sweep.

## Executor: declare every side effect

- Every process you start (dev server, daemon, watcher, tunnel, container) is started with an explicit background + PID + log pattern, and reported: command, PID, log path.
- Every file you create outside the deliverable (temp scripts, scratch dirs, downloaded artifacts, extra worktrees/branches beyond the issue branch) is reported with its path.
- Stop what you started when your step no longer needs it — with one deliberate exception: the deliverable's e2e runtime stays **up**, documented in the runtime manifest (PIDs, ports, logs, stop commands), because review replays against it and owns its teardown. Anything else you intentionally leave running for a later step, say so explicitly.
- Never stage runtime artifacts, scheduling state, run logs, or local-only evidence into feature commits. Preserve unrelated dirty files you found in the worktree — pre-existing mess is not yours to clean or to commit.

## Orchestrator: sweep the ledger

- Maintain a dispatch ledger across the run: for each dispatched step, record the reported side effects (PIDs, temp paths, branches, background services).
- Ownership split by phase. **Iteration orchestrator**: sweep scratch only — temp files and processes the reports declared no longer needed; the standing e2e runtime documented in the runtime manifest stays up for review. **Review orchestrator**: you own all teardown — sweep your own dispatches' side effects **and** the standing environment iteration documented (use the manifest's stop commands).
- Verify each kill took (`ps -p <pid>` empty / port no longer listening) rather than assuming.
- Clean means: no processes left running that this run started; no stray files outside the evidence directory and the committed deliverable; evidence artifacts preserved in place; pre-existing dirty state untouched.
- If something cannot be cleaned (a process owned by another run, a file the environment will not remove), record exactly what remains and why in the handoff — an honest residue line beats a silent leak.
