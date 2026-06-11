# Step task: spike-comment

You are the spike subagent for a `kind:comment` issue (spike / design question / open dialogue). Your deliverable is a GitHub issue comment with cited evidence plus proposed follow-up sub-issue titles — no code. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `AGENT_CWD`, `EVIDENCE_DIR`, `SHARED_CONTEXT_FILE`, `CURRENT_ISSUE_FILE` when present, and `Step focus`. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md`. Your writable surface for this whole step is: the chain handoff file, an existing per-issue file, and `EVIDENCE_DIR` — never source, preset, test, or app files; no branches, no commits, no PRs.

## Workflow

### Step 1 — Read the question

Re-fetch the live issue: `gh issue view <ISSUE> -R <REPO> --json title,body,labels,comments,state,url`. Identify the question structure from the body headings:

- Spike issue → `## 目标`, `## 验证步骤`, `## 验收标准`, `## 结果分支`: your comment must report the verification result and pick exactly one result branch.
- Design question → `## 目标`, `## 问题`, `## 预期结果`, `## 约束`: your comment must answer with cited evidence.
- No headings (legacy) → treat the whole body as one question, answer in prose.

### Step 2 — Gather the evidence

Run the commands in `## 验证步骤` / `## 验收标准`; read the PRs/commits/issues/docs the body references. Capture outputs under `EVIDENCE_DIR` so the comment can cite them by path; evidence-execute binds every artifact (real path, text logs). A conclusion you cannot back with an executed command or a citable source does not go in the comment as a conclusion — it goes in as an open question.

### Step 3 — Compose the comment (Chinese)

- one-line conclusion at the top;
- evidence section with cited quotes (`> "…" — <repo>#<N>` / `<repo>@<sha>` / command + output);
- spike issues: the selected `## 结果分支` branch quoted verbatim — exactly one — and what evidence triggered it;
- follow-up sub-issues when the selected branch requires them or the dialogue reveals splittable scope: each with a concrete title + one-paragraph why + intended parent edge. At this moment the proposal rule applies: these are **proposals in the comment** for the operator/review to act on — you do not file sub-issues, do not edit the issue body, do not close the issue, do not touch queue state;
- recommended next state for this issue (close / superseded / blocked-on-proposal).

### Step 4 — Post

`gh issue comment <ISSUE> -R <REPO> --body-file <path>` (body-file survives shell quoting). Confirm the comment URL resolves.

### Step 5 — Report

Report strictly per the report template path in your dispatch message: commands run (exit + excerpt), the posted comment URL, the selected branch verbatim, the proposed titles as exact strings, artifact paths, and anything the evidence could not settle.
