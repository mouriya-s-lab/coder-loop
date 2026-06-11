# Step task: replay (review)

You are a replay subagent for one coder-loop review. The review orchestrator trusts what you independently re-execute, not what the iteration claimed. You verify; you never repair — at no step below do you modify product code, tests, or the PR; if something fails, the failure **is** the result. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `ISSUE_KIND`, `AGENT_CWD` (work there), `TARGET_CWD`, `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus` — which acceptance rows, which packet claims, which checks to observe; for `blocked` kind it names the blocked-path e2e command. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` — it binds your own executions (real paths, text logs, PID discipline, artifacts under `EVIDENCE_DIR`).

## Workflow

### Step 1 — Parse the contract tables

Fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`). Parse the `## 验收标准` table (columns `#`, `Dimension`, `Check`, `Command`, `Env`, `Expect`) and the `## 继承验证义务` table when present (columns `From`, `Original #`, `Check`, `Command`, `Env`, `Expect`); concatenate the rows. A malformed table (wrong columns/headers) is itself a finding — record it and stop parsing that table; do not guess what it meant. Enumerate **every** row; a silently absent row invalidates your whole report.

### Step 2 — Make the checkout runnable

Check out / use the PR-bound branch state in your working directory (record the head SHA you replayed against). A fresh checkout has nothing installed — making it runnable is your job, not a reason to skip rows: run the project's dependency install (per its manifest/lockfile and `WORKFLOW_FILE`), any required build step, and a cheap toolchain probe (e.g. the project's typecheck or `--version` of the required binaries) before touching the first row. Record the setup commands and exits.

Then read the iteration's **runtime manifest** (in the PR packet and the chain handoff): it lists the binaries, services + start commands, auth resolution locations, ports, and the **standing e2e environment** (PIDs/ports/logs) the iteration left up for you. Use it — the standing environment plus the manifest is how every row and claim is reachable. A needed entry the manifest does not provide (a service with no start command, auth with no resolution location, the environment already torn down) is an **iteration packet failure**: record it as a finding with what was missing; it feeds retry, it never becomes your skip.

### Step 3 — Execute every row

Per row, by Env:

- `local` — execute the Command exactly as written; capture exit + output; compare to Expect. There is no auth/binary excuse: binaries you install, credentials you resolve from the manifest's stated location (or this machine's stores) — both are Step 2 work. A row you still cannot run means exactly one of two things, and you report which: your setup is unfinished (go back and finish it), or the manifest lacks the needed entry (iteration packet failure — a finding, not a skip). Never mark an unrun row passed, and never reinterpret the Command into something you can run.
- `browser` — re-drive the real UI with agent-browser against the standing environment; the packet's screenshots corroborate but do not substitute for your own walk.
- `VM` / `container` / `CI` / `downstream` / `integration` — locate the matching artifact in the PR evidence packet proving the row ran in its environment with the expected result; where this machine reaches the environment (per the manifest), also re-execute for the stronger signal. No matching artifact and no feasible re-execution = the row failed; cite the missing artifact.

### Step 4 — Blocked-path e2e (only when Step focus names it)

Run the named command that exercises the previously blocked path end-to-end; record exit + output. Without this succeeding, the unblock cannot be accepted — report it exactly as observed.

### Step 5 — Report

Report strictly per the report template path in your dispatch message: the row-results table with one line per row (including unrun rows with their exact cause — your unfinished setup vs manifest gap), and **everything left running** — your own processes and the iteration's standing environment with its manifest stop commands — for the orchestrator's final sweep; the review orchestrator owns all teardown. (The packet's e2e claims and live checks belong to other review steps, not yours.)
