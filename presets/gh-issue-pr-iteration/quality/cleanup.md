# Quality: cleanup

Side-effect discipline — executors declare what they did; orchestrators sweep.

## Executor: declare every side effect

- Every process you start (dev server, daemon, watcher, tunnel, container) is started with an explicit background + PID + log pattern, and reported: command, PID, log path.
- Every file you create outside the deliverable (temp scripts, scratch dirs, downloaded artifacts, extra worktrees/branches beyond the issue branch) is reported with its path.
- Stop what you started when your step no longer needs it — with one deliberate exception: the deliverable's e2e runtime stays **up**, documented in the runtime manifest (PIDs, ports, logs, stop commands), because review replays against it and owns its teardown. Anything else you intentionally leave running for a later step, say so explicitly.
- Never stage runtime artifacts, scheduling state, run logs, or local-only evidence into feature commits. Preserve unrelated dirty files you found in the worktree — pre-existing mess is not yours to clean or to commit.

## Orchestrator: sweep the ledger

- Maintain a dispatch ledger across the run: for each dispatched step, record the reported side effects (PIDs, temp paths, branches, background services).
- Ownership follows the runtime handoff ADT. **Iteration orchestrator**: for `durable`, leave only the supervisor-owned runtime; for `recreatable`, stop every phase-owned process and preserve the pinned worktree/manifest. **Review orchestrator**: replay by kind, stop any runtime it started, and use the durable manifest's stop command when final teardown owns that environment.
- Verify each kill took (`ps -p <pid>` empty / port no longer listening) rather than assuming.
- Clean means: no processes left running that this run started; no stray files outside the evidence directory and the committed deliverable; evidence artifacts preserved in place; pre-existing dirty state untouched.
- If something cannot be cleaned (a process owned by another run, a file the environment will not remove), record exactly what remains and why in the handoff — an honest residue line beats a silent leak.
