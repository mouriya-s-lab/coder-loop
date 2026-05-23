# Fragment: iter/source-writing-spike

## Goal

Execute one source-writing spike for a `kind:code-spike` issue. This route is for proof-of-concept branches, temporary source files, runtime commands, and reviewer-visible evidence where the result must not become a production PR merge.

The deliverable is a GitHub issue comment plus evidence artifacts and, when useful, a pushed spike branch. Do not open an implementation PR for this route.

## Applicability

`ISSUE_KIND` must be `code-spike`. If `ISSUE_KIND` is `comment`, use `iter/spike-comment` instead. If `ISSUE_KIND` is `blocked`, use `iter/resolve-blocker` instead. If `ISSUE_KIND` is `code` or empty, use `iter/classify-scope` instead.

## Branch and source writes

For a fresh source-writing spike, start from the configured base branch and create a spike branch:

```bash
git switch <BASE_BRANCH>
git pull --ff-only
git switch -c "spike/issue-<ISSUE>-<RUN_ID>"
```

On retry or resumed iteration, continue the existing spike branch from the queue item, handoff, trace, or local worktree when it belongs to the same issue. Do not replace a usable spike branch just to rename it.

Allowed on this route:

- create, edit, and delete PoC/source files needed to prove the spike question;
- create evidence artifacts under `{{EVIDENCE_DIR}}`;
- run runtime commands from the issue body and workflow file;
- commit and push the spike branch when a durable branch is useful evidence.

Forbidden on this route:

- open a PR;
- merge a PR or branch;
- close the issue;
- write final local state such as `done`, `moot`, or final `blocked`;
- stage `loop-data runtime artifacts`, central daemon scheduling state, or run stdout log;
- let temporary PoC code masquerade as production implementation.

## Procedure

1. Read the live issue body and comments gathered by `iter/read-context`.
2. Extract every command from the issue body's `## 验收标准` and `## 验证步骤` sections. If the issue has `## 结果分支`, identify the pass/fail branches before running commands.
3. Implement the smallest PoC needed to answer the spike question.
4. Run the strongest feasible runtime checks. When `Browser evidence required` is `true`, capture browser evidence if the spike has any browser-observable behavior. If it does not, record why browser evidence is not applicable and include the runtime proof that is applicable.
5. Save concise command logs, screenshots, or other artifacts under `{{EVIDENCE_DIR}}`.
6. Commit and push the spike branch only when the source state itself is needed for review. Do not open a PR.
7. Post a GitHub issue comment that includes:
   - `Run: <RUN_ID>`;
   - spike branch name and head SHA when one was pushed;
   - commands run, exit status, and artifact paths;
   - selected `## 结果分支` branch when present;
   - follow-up issue title proposals when the selected branch requires them;
   - an explicit statement that this is no-merge spike evidence, not production implementation.
8. Append handoff with the comment URL, branch/SHA, files changed, commands, artifacts, and blockers if any.

## Output verdict

Choose exactly one:

- `source_spike_comment_posted` -> read `iter/handoff`.
- `source_spike_blocked` -> read `iter/handoff` with the exact blocker and attempted command/query.

Do not proceed to `iter/commit-pr`; this route has no implementation PR.
