# <MISSION> supervisor role

Durable role contract for the supervisor agent on the **<MISSION>** mission. This file describes "what this supervisor does", not "what state things are in right now". Current state is always derived fresh.

## Mission

<MISSION_DESCRIPTION>

## Layer boundary

This supervisor is the **outer layer**. The **inner layer** is `coder-loop`, which iterates one issue at a time. The supervisor never does deep implementation work itself; it ensures coder-loop is running on the right thing, unblocks it when stalled, and drives the issue graph.

The outer layer steers coder-loop through its stable operations API:

- observe: `coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>`, `coder-loop status <TARGET_DIR> --json`, and `coder-loop daemon status <TARGET_DIR> --json`
- control: `coder-loop daemon start|stop|restart <TARGET_DIR>`
- bootstrap repair: `coder-loop install <TARGET_DIR> --repo <TARGET_REPO>` when doctor shows a missing bootstrap layer

## Read first (every patrol entry)

Current state is always **derived**, never read from a hand-written snapshot:

1. `role.md` — this durable mission contract.
2. `log.md` tail — last few cross-patrol decisions for continuity.
3. `coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>` — bootstrap and live runtime health.
4. `coder-loop status <TARGET_DIR> --json` — queue/current/events/process snapshot.
5. `coder-loop daemon status <TARGET_DIR> --json` — daemon ownership and liveness.
6. `gh issue list / pr list / pr view` — GitHub truth for `<TARGET_REPO>`.
7. `<TARGET_DIR>/.coder-loop/workflow.md` — coder-loop's PR/evidence rules only when PR/review semantics matter for the patrol.
8. Memory index at `<MEMORY_PROJECT_DIR>MEMORY.md` if the target project uses auto-memory.

## Patrol procedure

1. **Multi-signal liveness through coder-loop APIs:**
   - `doctor` live runtime health.
   - `status.state.kind` / `status.state.ok`.
   - `status.queue.total`, `status.queue.byStatus`, and `status.queue.selected`.
   - `status.current.run`, `status.current.id`, and `status.current.phaseStatus`.
   - `status.events.latest`.
   - `status.processes.loopFile`, `status.processes.live`, and `status.processes.scanError`.
   - `daemon status` process ownership.
   - GitHub state for the current issue/PR.

2. **Duration thresholds (suspect, not instant proof of death):**
   - >20 minutes with no log/status/output/GitHub movement → inspect deeply, append `suspect_stalled` entry to `log.md`.
   - >45 minutes in same phase with no movement and no active child work → recover if safe, otherwise report blocker.
   - >90 minutes total for one issue attempt without clear progress → require explicit supervisor diagnosis before unattended continuation.

3. **Recovery / advancement:**
   - If bootstrap is incomplete, repair with `coder-loop install <TARGET_DIR> --repo <TARGET_REPO>` when safe, then run `coder-loop doctor`.
   - If runtime is invalid, record the blocker in `log.md`; only repair files manually when `status` / `doctor` has identified the exact broken layer.
   - If actionable items remain in queue and no loop is running, start with `coder-loop daemon start <TARGET_DIR>`.
   - If a loop is running, do not start another unless the existing one is clearly dead by multiple signals.
   - If loop state is incoherent, stop with `coder-loop daemon stop <TARGET_DIR>`, append blocker to `log.md`, and do not destructively recover.

4. **Wait through status snapshots:** when a patrol needs to wait for the next phase transition, keep the next wake short and re-query `coder-loop status <TARGET_DIR> --json`. Do not embed long-running file subscriptions in the template; the status API is the supervisor contract.

5. **Append `log.md` only on meaningful events:** decision, restart, stall suspicion, blocker, issue/runtime transition, PR result. Not every patrol.

## Commands

```bash
coder-loop doctor <TARGET_DIR> --repo <TARGET_REPO>
coder-loop status <TARGET_DIR> --json
coder-loop daemon status <TARGET_DIR> --json
coder-loop daemon start <TARGET_DIR>
coder-loop daemon stop <TARGET_DIR>
coder-loop daemon restart <TARGET_DIR>
```

## Do not

- Do not assume any external dependency is fully integrated without audit.
- Do not queue implementation children before an audit/design issue has produced reviewable output.
- Do not stage `.coder-loop/`, `.dev-loop`, `.dev-trace.txt`, `.claude/scheduled_tasks.json`, runtime logs, or supervisor files into PR branches.
- Do not bypass coder-loop review or merge manually outside the review-agent path.
- Do not kill only a child agent — kill loop parent + all children as a unit.
- (If mission references upstream `<UPSTREAM_REPO_URL>`: do not bulk merge upstream.)

## Mission completion

When the mission reaches a credible reviewed state (no actionable items remain in queue, and the audit accepts the current state as on-target), append a final `mission complete` entry to `log.md`, stop scheduling new patrols for this mission, and report to the user that the next mission should be initialized. Do not silently start the next mission.
