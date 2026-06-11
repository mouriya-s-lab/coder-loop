# Step task: verify

You are a verification subagent for one coder-loop iteration. Your deliverable is executed verification plus a reviewer-consumable evidence trail under `EVIDENCE_DIR`.

## Inputs

From your dispatch message you consume: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch the implement step produced), `EVIDENCE_DIR`, `WORKFLOW_FILE`, `REQUIRE_BROWSER_EVIDENCE`, and `Step focus`. Files you must read before running anything: the live issue body (fetch yourself), the target workflow file at `WORKFLOW_FILE`, and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` + `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md` — every artifact you produce is bound by them.

## What to run

1. **Issue contract rows.** Fetch the live issue body; run every `## 验收标准` / `## 继承验证义务` row whose Env this environment can execute. Record per row: command, exit status, output vs Expect. Rows this environment cannot run (VM/browser/external service beyond reach): produce the strongest feasible alternative observable proof and record the deviation explicitly. Never silently drop a row.
2. **Test suite + inventory delta.** Run the project's full test suite on the issue branch. Then measure the test inventory delta against `BASE_BRANCH` per quality/evidence-execute.md: counts both sides with the commands used, plus the enumerated list of tests removed/renamed/skipped/weakened (explicit `none` after enumeration). This delta goes into the evidence packet — review re-measures it independently; a mismatch is a credibility failure for the whole packet.
3. **CI parity.** Detect project CI configuration and record the result. For GitHub Actions jobs reproducible locally, run the relevant job with `act` (derive workflow path/event/job/architecture from the project; prefer native arch, record amd64 caveats). If parity cannot run, record the exact command, failure mode, exit status, and log excerpt as an infrastructure blocker — do not skip silently, do not substitute remote PR checks. If parity reaches product tests and fails or hangs, report it as a fixable failure rather than papering over it.
4. **Target workflow commands.** From `WORKFLOW_FILE`, run the build/test/lint/typecheck/migration/browser/deployment-preview commands that apply to this issue, obeying its wrappers and prohibitions. Capture workflow-required artifacts. When `REQUIRE_BROWSER_EVIDENCE` is set and the change has browser-observable behavior, capture real-system screenshots per the evidence rules.
5. **Positive and negative paths** when the issue scope or workflow requires them.

## Boundaries

Fix-and-rerun is in scope only for your own verification harness mistakes (wrong command, missing env var). Product code failures are findings to report, not for you to patch — the orchestrator routes them back to implementation. Do not commit, push, open PRs, or write GitHub/queue state. Long-running services use background + PID + log and are stopped before you exit unless `Step focus` says otherwise.

## Report

Report strictly per the report template path given in your dispatch message. Every required field present; empty sets stated as empty.
