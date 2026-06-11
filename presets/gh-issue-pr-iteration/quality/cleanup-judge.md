# Quality: cleanup — orchestrator final sweep

Site-cleanliness ownership for orchestrators. Executors report side effects (their constraints live in `cleanup-execute.md`); you own the sweep.

- Maintain a dispatch ledger across the run: for each dispatched step, record the reported side effects (PIDs, temp paths, branches, background services).
- Ownership is split by phase. **Iteration orchestrator**: sweep scratch only — temp files and processes the reports declared no longer needed; the standing e2e runtime documented in the runtime manifest stays up for review. **Review orchestrator**: you own all teardown — sweep your own dispatches' side effects **and** the standing environment iteration documented (use the manifest's stop commands).
- When sweeping, verify each kill took effect (`ps -p <pid>` empty / port no longer listening) rather than assuming.
- Clean means: no processes left running that this run started; no stray files outside the evidence directory and the committed deliverable; evidence artifacts preserved in place; pre-existing dirty state untouched.
- If something cannot be cleaned (e.g. a process owned by another run, a file the environment will not let you remove), record exactly what remains and why in the handoff note — an honest residue line beats a silent leak.
