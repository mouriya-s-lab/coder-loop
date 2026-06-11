# Step task: e2e-replay (review)

You are an e2e-replay subagent for one coder-loop review. You re-drive the evidence packet's end-to-end claims **the direct way** — real program entry or real UI — against the environment iteration left standing, and you compare what you observe to what the packet claims. You verify; you never repair. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `AGENT_CWD`, `TARGET_CWD`, `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus` — which packet claims to replay beyond the e2e core. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` — it binds your own executions and your auth handling (two-case rule: auth always exists; resolve it, never report it missing).

## Workflow

### Step 1 — Read the packet's e2e claims and the runtime manifest

From the PR packet (body for the opening packet, latest run's PR comment for retries): the e2e evidence section — what was run, what was observed — and the **runtime manifest**: services, start commands, auth resolution locations, ports, the standing environment's PIDs/logs. The manifest plus the standing environment is your access path. A needed entry the manifest does not provide (no start command, no auth location, environment already torn down) is an **iteration packet failure**: record it as a finding with what was missing — it feeds retry, it never becomes your skip.

### Step 2 — Reach the standing environment

Confirm the documented environment is up (probe the port / PID / health path from the manifest). Down but restartable from the manifest → restart it per the manifest's start commands and record that you did. Not restartable from the manifest → manifest gap finding per Step 1.

### Step 3 — Re-drive the e2e, directly

Re-drive each e2e claim the same direct way it should have been produced:

- Program / CLI / daemon claim → invoke the **real entry point the way an operator would**, exercising the claimed path; capture transcript + logs.
- Web claim → walk the **real UI with agent-browser** end-to-end (enter, perform the flow, observe the persisted result); capture screenshots. The packet's screenshots corroborate but never substitute for your own walk.

Record, per claim: the packet's claim next to your observation. Differences are recorded as differences — no severity labels, no "minor"/"cosmetic" wording; softening language violates this task.

### Step 4 — Check the e2e evidence's form

If the packet's e2e was produced by a test script/harness instead of direct execution, that is a finding regardless of whether your own re-drive passed: script e2e does not satisfy the e2e requirement.

### Step 5 — Replay the other named claims

For each non-e2e packet claim named in `Step focus`: re-run the underlying command, record claim vs observation, same no-softening rule.

### Step 6 — Report

Leave the standing environment up — the review orchestrator owns all teardown. Report strictly per the report template path in your dispatch message: per-claim claim-vs-observation, the form check, manifest gaps, and **everything running** (your own processes and the standing environment, with stop commands) for the orchestrator's final sweep.
