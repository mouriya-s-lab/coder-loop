# Step task: submit

You are a submission subagent for one coder-loop iteration. Your deliverable is the committed, pushed branch plus the PR (fresh run) or PR-thread comment (retry), carrying the evidence packet the verify and e2e steps produced. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `RUN_ID`, `AGENT_CWD` (work there), `SHARED_CONTEXT_FILE`, `EVIDENCE_DIR` (the verified evidence you assemble from — you add no new claims), `WORKFLOW_FILE`, `ISSUE_BRANCH`/`ISSUE_PR` when set, `ISSUE_STATUS`, and `Step focus`. Read now, before Step 1: the `Intent (run <RUN_ID>)` block in `SHARED_CONTEXT_FILE`, the workflow file, `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/common/github-routing.md` (binds Step 3 routing), and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` + `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-execute.md`.

## Workflow

### Step 1 — Write the result delta

Compare the `Intent (run <RUN_ID>)` block against what this run actually did (your `Step focus` plus the evidence under `EVIDENCE_DIR`). Append to the handoff under `Result (run <RUN_ID>)`: did action match intent; what drifted and why; what was noticed that intent did not anticipate. Never edit the intent block itself — it is immutable history. A plain "intent matched action" line is fine when true; do not pad it.

### Step 2 — Commit and push

Run `git status --short` and read it before staging. At the moment of `git add`, this rule applies: stage only the feature/test files and committed screenshots of this change — staging loop-data runtime artifacts, scheduling state, run logs, secrets, unrelated dirty files, or local-only evidence is forbidden; check the staged list (`git diff --cached --name-only`) against that rule before committing.

```bash
git commit -m "fix(issue-<ISSUE>): <concise description>

Refs: <REPO>#<ISSUE>"
git push -u origin <branch>
```

### Step 3 — Route the deliverable

**An open PR already exists for this issue/branch** → retry route. Push went to the same branch; now post a **new PR-thread comment** containing: which review feedback was addressed; what changed this iteration; the full current layered evidence packet (sections per the workflow file; commands + exit + excerpts/paths; screenshots embedded as Markdown images, each mapped to what it proves; the **E2E direct-run evidence** — real entry driven, observed behavior, trace artifacts; the **runtime manifest** with credentials referenced by resolution location only, never a secret value in the PR; the test-inventory delta line from verification); and whether evidence was added, replaced, or deliberately unchanged and why. At this moment, the PR body is untouchable: it is the immutable opening cover letter — if it has a structural defect (missing closing keyword, wrong issue), record the defect for your report instead of editing it.

**No PR exists** → create exactly one:

- body first line exactly `Closes #<ISSUE>`;
- title/body/section/language rules per the workflow file;
- the four-layer evidence packet from this run's verification, including CI detection + parity status and the test-inventory delta line;
- the **E2E direct-run evidence** as the formal deliverable layer: the real entry driven (operator-style invocation / agent-browser walk), observed behavior, runtime trace artifacts — unit/integration results are supporting layers only;
- the **runtime manifest** (binaries, services + start commands, auth by resolution location — **never a secret value in the PR** — ports, standing-environment PIDs/logs/stop commands) so review can re-run everything;
- screenshots embedded as Markdown images whose paths resolve to committed PR-branch artifacts;
- every artifact mapped to the behavior it proves.

The PR body is a diff cover letter with evidence — do not reconstruct the issue's why or move task scope into it. Everything in the packet traces to the verify and e2e steps' output; manufacturing a claim those steps did not produce violates honesty-execute and will be caught by replay.

### Step 4 — Verify liveness, then report

Confirm your deliverable exists live: `gh pr view <N> -R <REPO> --json url` (fresh) or the comment URL resolving (retry). Nothing in this step merges PRs, closes issues, edits issue bodies, or writes queue state — confirm you did none. Report strictly per the report template path in your dispatch message: every required field, empty sets as `none`.
