# Fragment: iter/spike-comment

## Goal

For a `kind:comment` issue (spike / design question / open dialogue), the deliverable is an issue comment + sub-issue 列表, not 代码. Post the answer/findings as a GitHub issue comment and propose any required follow-up sub-issues for the operator to approve. Do not write code files.

## When this fragment runs

`ISSUE_KIND` is `comment`. If `ISSUE_KIND` is `blocked`, use `iter/resolve-blocker` instead. If `ISSUE_KIND` is empty or `code`, this fragment does not apply — return to `iter/classify-scope` from `iter/read-context`.

## Hard constraints

- The `Write` and `Edit` tools may only touch `{{SHARED_CONTEXT_FILE}}` (chain handoff), an existing optional `{{CURRENT_ISSUE_FILE}}`, and files under `{{EVIDENCE_DIR}}`. Do NOT Write to any source code, preset, fragment, test, or app file. The deliverable 是 issue comment + sub-issue 列表，不得 Write 代码文件.
- Do NOT create branches, commits, or pull requests.
- Do NOT edit the issue body. Produce a new comment via `gh issue comment`.
- Do NOT actually file the proposed sub-issues — propose them in the comment so the operator can approve. Sub-issue creation belongs to the review action layer.
- Do NOT close the issue or set final state in the central state DB.

## Procedure

1. Re-read the live issue body to ground the comment in current state (not a stale snapshot):

   ```bash
   gh issue view {{ISSUE}} -R {{REPO}} --json title,body,labels,comments,state,url
   ```

2. Identify the issue's question structure from its body section headings (writing-issue skill enforces stable section names):
   - Spike issue → read `## 目标`, `## 验证步骤`, `## 验收标准`, `## 结果分支`. The comment must answer the verification result and pick one branch.
   - Design-question / open-discussion issue → read `## 目标`, `## 问题`, `## 预期结果`, `## 约束`. The comment must answer the question with cited evidence.
   - If section headings are missing (legacy comment-style issue), treat the whole body as one question and answer in prose.

3. Gather evidence: run the spike commands in `## 验证步骤` / `## 验收标准` if any; read referenced PRs, commits, issues, and design docs. Capture command outputs into `{{EVIDENCE_DIR}}/` so the comment can cite them.

4. Compose the comment body (Chinese, per writing-issue voice):
   - One-line conclusion at the top.
   - Evidence section with cited quotes (`> "..." — <repo>#<N>` body / `<repo>@<sha>` commit / command output).
   - For spike issues: explicit selection of one `## 结果分支` and what triggers it.
   - Proposed follow-up sub-issues (if `## 结果分支` requires one, or if the dialogue reveals split-able scope): each with title + one-paragraph why + the parent edge it would hang under. Mark these as proposals, not filed.
   - Recommended next state for this issue: `Closes` (answered, no follow-up), `Replaces` (a new umbrella supersedes this), `Blocks` (depends on a proposed sub-issue first).

5. Post the comment:

   ```bash
   gh issue comment {{ISSUE}} -R {{REPO}} --body-file <path-to-comment.md>
   ```

   Prefer `--body-file` over inline `--body` so the comment markdown survives shell quoting.

## Output verdict

Choose exactly one:

- `spike_comment_posted` → read `iter/handoff`. Record the posted comment URL and the proposed sub-issue titles.
- `spike_blocked` → read `iter/handoff` and record the exact blocker (gh auth failure, conflicting prior comments, ambiguous question that needs operator clarification) with the attempted command/output.

Do not proceed to code-writing fragments under any verdict.
