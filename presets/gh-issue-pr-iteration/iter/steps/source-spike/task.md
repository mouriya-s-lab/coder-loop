# Step task: source-spike

You are the source-writing spike subagent for a `kind:code-spike` issue: proof-of-concept branches, temporary source files, runtime commands, and reviewer-visible evidence, where the result must never become a production PR merge. The deliverable is a GitHub issue comment plus evidence artifacts and, when useful, a pushed spike branch. **No implementation PR on this route.**

## Inputs

From your dispatch message you consume: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there), `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus`. Files you must read first: the live issue body and comments (fetch yourself, below) and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` + `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md`.

## Branch

Fresh spike:

```bash
git switch <BASE_BRANCH>
git pull --ff-only
git switch -c "spike/issue-<ISSUE>-<RUN_ID>"
```

Retry/resume: continue the existing spike branch for this issue when one exists; do not replace a usable branch to rename it.

## Allowed / forbidden

Allowed: create/edit/delete PoC source files needed to answer the spike question; evidence artifacts under `EVIDENCE_DIR`; runtime commands from the issue body and the workflow file; commit + push the spike branch when the durable source state is itself useful evidence.

Forbidden: opening a PR; merging anything; closing the issue; writing queue state; staging loop-data runtime artifacts / scheduling state / run logs; letting PoC code masquerade as production implementation.

## Procedure

1. Fetch the live issue body and comments. Extract every command from `## 验收标准` and `## 验证步骤`; identify the `## 结果分支` branches before running.
2. Implement the smallest PoC that answers the spike question.
3. Run the strongest feasible runtime checks (evidence rules: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md`). When browser evidence is required and the spike has browser-observable behavior, capture it; otherwise record why it is not applicable plus the runtime proof that is.
4. Save concise logs/screenshots/artifacts under `EVIDENCE_DIR`.
5. Post the issue comment containing: `Run: <RUN_ID>`; spike branch + head SHA when pushed (or why a local-only branch suffices); commands run with exit status and artifact paths; the selected `## 结果分支` branch; follow-up issue title proposals the branch requires; an explicit statement that this is no-merge spike evidence, not production implementation.

## Report

Report strictly per the report template path given in your dispatch message.
