# Step task: verify

You are a verification subagent for one coder-loop iteration. Your deliverable is executed verification plus a reviewer-consumable evidence trail under `EVIDENCE_DIR`. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch the implement step produced), `EVIDENCE_DIR`, `WORKFLOW_FILE`, `REQUIRE_BROWSER_EVIDENCE`, and `Step focus`. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md` — every artifact you produce below is bound by them (real path only, logs as text, real screenshots, artifacts under `EVIDENCE_DIR`).

## Workflow

### Step 1 — Enumerate the rows and plan each one

Fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`); collect **every** row of `## 验收标准` and `## 继承验证义务`. For each row decide from its Env column whether this machine can execute it: `local` → executable; `VM` / `container` / `CI` / `browser` / `downstream` / `integration` → executable only if this machine actually reaches that environment (tooling installed, service reachable) — when unsure, run the cheapest probe (version check, ping-equivalent) and record the probe as the basis. Write the per-row plan (execute here / alternative proof, and which) before running anything. No row may be silently dropped.

### Step 2 — Run the executable rows

Before the first row, make the worktree runnable — that is your job, not a blocker: run the project's dependency install (per its manifest/lockfile and `WORKFLOW_FILE`) and any required build step if the implement step left them undone; record the setup commands and exits. A row may be declared non-executable for environment reasons only after this setup was actually attempted — "dependencies missing" is never that reason.

Per row: run the Command exactly as written, capture command + exit status + output vs Expect. A mismatch is a result to record, not a thing to fix — product code failures are findings the orchestrator routes back to implementation; you never patch product code or tests. Fix-and-rerun is allowed only for your own harness mistakes (wrong cwd, missing env var, typo in your invocation), and the correction is recorded. For rows planned as non-executable: produce the strongest feasible alternative observable proof and record the deviation explicitly next to the row.

### Step 3 — Test suite and inventory delta

Run the project's full test suite on the issue branch. Then measure the test inventory delta against `BASE_BRANCH` per evidence-execute: total counts on both sides with the exact commands used, plus the enumerated list of tests removed/renamed/skipped/weakened by this branch — explicit `none` only after enumerating, never as an assumption. This delta goes into the evidence packet; review re-measures it independently, and a mismatch destroys the whole packet's credibility.

### Step 4 — CI parity

Detect the project's CI configuration and record what you found. For GitHub Actions jobs reproducible locally, run the relevant job with `act` (derive workflow path/event/job/architecture from the project; prefer native arch, record amd64 caveats). If parity cannot run (Docker, act install, image pull, network): record the exact command, failure mode, exit status, and log excerpt as an infrastructure blocker — never skip silently, never substitute remote PR checks. If parity reaches product tests and they fail or hang, that is a fixable product finding, not something to paper over.

### Step 5 — Workflow commands and runtime paths

From `WORKFLOW_FILE`, run the build/test/lint/typecheck/migration/browser/deployment-preview commands that apply to this issue, obeying its wrappers and prohibitions; capture workflow-required artifacts. When `REQUIRE_BROWSER_EVIDENCE` is true and the change has browser-observable behavior, capture real-system screenshots per evidence-execute. Capture both positive and negative paths when the issue scope or workflow requires them.

### Step 6 — Land the artifacts and close your processes

Everything lands under `EVIDENCE_DIR`: command logs as text, screenshots verified openable, each artifact named for what it proves. Long-running services you started used background + PID + log; stop them now and confirm they died — unless your `Step focus` says to leave one running, in which case say so in the report. List every PID and every file you created outside `EVIDENCE_DIR` for the report.

### Step 7 — Report

You had no reason to commit, push, open PRs, or write GitHub/queue state in this step — confirm you did not. Report strictly per the report template path in your dispatch message: every required field, empty sets as `none`, mismatches reported as mismatches without softening.
