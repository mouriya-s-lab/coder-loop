# Step task: verify

You are a verification subagent for one coder-loop iteration. Your deliverable is executed verification plus a reviewer-consumable evidence trail under `EVIDENCE_DIR`. The e2e direct run is a separate step that may be running in parallel with you (it works in its own worktree; `AGENT_CWD` is yours) — your scope is the contract rows, the test suite, CI parity, and workflow commands. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch the implement step produced), `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus`. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md` — every artifact you produce below is bound by them (real path only, logs as text, artifacts under `EVIDENCE_DIR`).

## Workflow

### Step 1 — Enumerate the rows and plan each one

Fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`); collect **every** row of `## 验收标准` and `## 继承验证义务`. Plan each row from its Env column:

- `browser` → not yours: browser rows are e2e territory, executed by the e2e step's real-UI walk. Plan the row as `deferred: e2e step` — it still appears in your results table with that verdict, never silently dropped.
- `local` → executable here.
- `VM` / `container` / `CI` / `downstream` / `integration` → executable only if this machine actually reaches that environment (tooling installed, service reachable) — when unsure, run the cheapest probe (version check, ping-equivalent) and record the probe as the basis.

Write the per-row plan (execute here / deferred to e2e / alternative proof, and which) before running anything. No row may be silently dropped.

### Step 2 — Run the executable rows

Before the first row, make the worktree runnable — that is your job, not a blocker: run the project's dependency install (per its manifest/lockfile and `WORKFLOW_FILE`) and any required build step if the implement step left them undone; record the setup commands and exits. A row may be declared non-executable for environment reasons only after this setup was actually attempted — "dependencies missing" is never that reason.

Per row: run the Command exactly as written, capture command + exit status + output vs Expect. A mismatch is a result to record, not a thing to fix — product code failures are findings the orchestrator routes back to implementation; you never patch product code or tests. Fix-and-rerun is allowed only for your own harness mistakes (wrong cwd, missing env var, typo in your invocation), and the correction is recorded. For rows planned as non-executable: produce the strongest feasible alternative observable proof and record the deviation explicitly next to the row.

### Step 3 — Test suite and inventory delta

This step is bound by `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/common/test-inventory-protocol.md`. Read it now if not already in context; the rules below are the protocol applied to this step and never override it.

Run the canonical full-suite command named in `WORKFLOW_FILE` on the issue branch, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and parse the head-side integer from the runner's own aggregated summary line per the protocol's runner-specific rule. Then measure the base side **without disturbing your checkout**, in a detached scratch worktree of your own:

```bash
SCRATCH=$(mktemp -d)
git worktree add --detach "$SCRATCH/verify-base" "$(git merge-base <BASE_BRANCH> HEAD)"
# install deps there per the project's manifest/lockfile, then run the same canonical command and tee its output to a log
git worktree remove "$SCRATCH/verify-base"   # confirm gone; record the path and removal in your report
```

Record the command, the parsed integer, and the relative log path for each side, plus the enumerated list of tests removed/renamed/skipped/weakened by this branch (per evidence-execute) — explicit `none` only after enumerating, never as an assumption. Publish the delta in the protocol's single-line format. The published integer is the runner-emitted total, not a static `rg` / `grep` count of `test(` / `it(` declarations — that path is forbidden by the protocol. This delta goes into the evidence packet; review re-measures it from the same protocol, and any mismatch is traced to either the runner log or a setup drift before the packet's credibility is judged.

### Step 4 — CI parity

Detect the project's CI configuration and record what you found. For GitHub Actions jobs reproducible locally, run the relevant job with `act` (derive workflow path/event/job/architecture from the project; prefer native arch, record amd64 caveats). If parity cannot run (Docker, act install, image pull, network): record the exact command, failure mode, exit status, and log excerpt as an infrastructure blocker — never skip silently, never substitute remote PR checks. If parity reaches product tests and they fail or hang, that is a fixable product finding, not something to paper over.

### Step 5 — Workflow commands

From `WORKFLOW_FILE`, run the build/lint/typecheck/migration/deployment-preview commands that apply to this issue, obeying its wrappers and prohibitions; capture workflow-required artifacts. Capture both positive and negative paths when the issue scope or workflow requires them.

### Step 6 — Land the artifacts and report

Everything lands under `EVIDENCE_DIR`: command logs as text, each artifact named for what it proves. You had no reason to commit, push, open PRs, or write GitHub/queue state in this step — confirm you did not. Report strictly per the report template path in your dispatch message: every required field, empty sets as `none`, mismatches reported as mismatches without softening. (The e2e direct run, the runtime manifest, and the standing environment belong to the e2e step, not yours.)
