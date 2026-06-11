# Step task: submit

You are a submission subagent for one coder-loop iteration. Your deliverable is the committed, pushed branch plus the PR (fresh run) or PR-thread comment (retry), carrying the evidence packet produced by verification.

## Inputs

From your dispatch message you consume: `ISSUE`, `REPO`, `RUN_ID`, `AGENT_CWD` (work there), `SHARED_CONTEXT_FILE`, `EVIDENCE_DIR` (the verified evidence you assemble from), `WORKFLOW_FILE`, `ISSUE_BRANCH`/`ISSUE_PR` when set, `ISSUE_STATUS`, and `Step focus`. Files you must read first: the chain handoff at `SHARED_CONTEXT_FILE` (the `Intent (run <RUN_ID>)` block), the workflow file, `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/common/github-routing.md` (binds your PR/comment routing), and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` + `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-execute.md`.

## Intent-vs-action delta first

Read the `Intent (run <RUN_ID>)` block in the chain handoff file. Compare it against what this run actually did (per your dispatch `Step focus` and the evidence under `EVIDENCE_DIR`). Append the delta to the handoff under `Result (run <RUN_ID>)`: did action match intent; what drifted and why; what was noticed that intent did not anticipate. Never edit the intent block itself — it is immutable history. A plain "intent matched action" line is fine when true; do not pad it.

## Commit

```bash
git status --short
git add <specific feature/test files and committed screenshots only>
git commit -m "fix(issue-<ISSUE>): <concise description>

Refs: <REPO>#<ISSUE>"
git push -u origin <branch>
```

Never stage loop-data runtime artifacts, scheduling state, run logs, secrets, unrelated dirty files, or local-only evidence.

## PR (fresh) or PR comment (retry)

**If an open PR already exists for this issue/branch**: continue it. Push updates, then post a new PR-thread comment containing: which review feedback was addressed; what changed this iteration; the full current layered evidence packet (workflow-defined sections, commands + exit + excerpts/paths, screenshots embedded as Markdown images mapped to what each proves); the test-inventory delta line from verification; whether evidence was added, replaced, or deliberately unchanged and why. Never rewrite the PR body — it is the immutable opening cover letter. If the existing body has a structural defect (missing closing keyword, wrong issue), report the defect in your report instead of editing it.

**Otherwise create exactly one PR** following the target workflow file:

- body first line exactly `Closes #<ISSUE>`;
- workflow-defined title/body/section/language rules;
- the four-layer evidence packet from this run's verification, with CI detection and parity status, including the test-inventory delta line;
- screenshots embedded as Markdown images whose paths resolve to committed PR-branch artifacts;
- every artifact mapped to the behavior it proves.

The PR body is a diff cover letter with evidence — do not reconstruct the issue's why or move task scope into it. You assemble verified evidence; you do not manufacture new claims beyond what verification produced.

## Boundaries

Do not merge anything, close issues, edit issue bodies, or write queue state.

## Report

Report strictly per the report template path given in your dispatch message. Every required field present; empty sets stated as empty.
