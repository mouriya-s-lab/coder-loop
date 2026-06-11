# Step task: replay (review)

You are a replay subagent for one coder-loop review. The review orchestrator trusts what you independently re-execute, not what the iteration claimed. You verify; you never repair — at no step below do you modify product code, tests, or the PR; if something fails, the failure **is** the result. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `ISSUE_KIND`, `AGENT_CWD` (work there), `TARGET_CWD`, `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus` — which acceptance rows, which packet claims, which checks to observe; for `blocked` kind it names the blocked-path e2e command. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` — it binds your own executions (real paths, text logs, PID discipline, artifacts under `EVIDENCE_DIR`).

## Workflow

### Step 1 — Parse the contract tables

Fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`). Parse the `## 验收标准` table (columns `#`, `Dimension`, `Check`, `Command`, `Env`, `Expect`) and the `## 继承验证义务` table when present (columns `From`, `Original #`, `Check`, `Command`, `Env`, `Expect`); concatenate the rows. A malformed table (wrong columns/headers) is itself a finding — record it and stop parsing that table; do not guess what it meant. Enumerate **every** row; a silently absent row invalidates your whole report.

### Step 2 — Execute every row

Check out / use the PR-bound branch state in your working directory (record the head SHA you replayed against). Then per row, by Env:

- `local` — execute the Command exactly as written; capture exit + output; compare to Expect. The Command erroring for environmental reasons you cannot fix (auth, missing binary): record `could not execute` with the exact error — at this moment the rule is: never mark such a row passed, and never reinterpret the Command into something you can run.
- `VM` / `container` / `CI` / `browser` / `downstream` / `integration` — locate the matching artifact in the PR evidence packet proving the row ran in its environment with the expected result; where this machine can feasibly reach the environment (browser via local tooling, a reachable service), also re-execute for the stronger signal. No matching artifact and no feasible re-execution = the row failed; cite the missing artifact.

### Step 3 — Spot-replay the packet claims

For each evidence-packet claim named in `Step focus` (typically the headline runtime/e2e claims): re-run the underlying command and record the packet's claim next to your observation. Differences are recorded as differences — at this moment the rule is: no severity labels, no "minor"/"cosmetic" wording; the judgment whether a mismatch matters belongs to the orchestrator, and softening language from you violates this task.

### Step 4 — Blocked-path e2e (only when Step focus names it)

Run the named command that exercises the previously blocked path end-to-end; record exit + output. Without this succeeding, the unblock cannot be accepted — report it exactly as observed.

### Step 5 — Observe checks and mergeability

From live PR state: check names, statuses, conclusions, timestamps, head SHA, elapsed time, your timed-out/hung assessment, and `mergeStateStatus`. Observed values only — never infer "CI is green" from absence of failures.

### Step 6 — Report

Stop any process you started and note what you could not stop. Report strictly per the report template path in your dispatch message: the row-results table with one line per row (including could-not-execute rows with their exact errors), packet spot-replay comparisons, the checks observation, and your side effects for the cleanup ledger.
