# Fragment: iter/implement

## Goal

Implement one complete deliverable for the selected issue.

## Branch and PR continuity

If this spawn is a retry (`ISSUE_STATUS` is `changes_requested` and `ISSUE_LAST_RUN_ID` is non-empty) or a resumed iteration (`RUN_ID_GENERATION` is `resumed` and `RESUMED_FROM_PHASE` is the iteration phase), continue the existing branch/PR/worktree state when present. Inspect the existing branch, PR, latest PR review/comment, handoff, trace, evidence directory, and dirty files. Do not restart from the base branch unless the existing branch/PR is unrelated to the selected issue.

For a fresh issue when code changes are needed, use the configured base branch and create a run-specific branch:

```bash
git switch <BASE_BRANCH>
git pull --ff-only
git switch -c "issue-<ISSUE>-<RUN_ID>"
```

## Read commitments before implementing

For `kind:code`, `kind:blocked`, and legacy unlabeled issues, the issue body may carry machine-checkable commitments that review will enforce row-by-row. Before writing code, read the issue body's `## 验收标准` 与 `## 继承验证义务` 表全部 Command 列 from the live GitHub state (use the `gh issue view --json body` output from `iter/read-context`). Each row's Command column is a concrete check; each row's Expect column is the result review will compare against.

Implement the change so that every Command row will pass. If a row's Command cannot be made to pass within the current environment (e.g. it requires VM, browser, or external service), capture the evidence that the row's intent is satisfied via an alternative observable proof and record the deviation in handoff — but do not silently drop the row.

If the issue body has no `## 验收标准` table (legacy issue without structured body), this section does not apply; proceed under the implementation constraints below.

## Implementation constraints

- Make a small direct change that closes exactly the selected issue.
- Do not batch multiple issues.
- Do not weaken tests.
- Do not stage `.coder-loop/runtime/`, `.dev-loop`, or `.dev-trace.txt`.
- Do not create child issues, link sub-issues, merge PRs, close issues, or write final local state.
- Preserve unrelated dirty files.

## Output verdict

Choose exactly one:

- `implementation_ready_for_verification` → read `iter/verify-evidence`.
- `implementation_blocked` → read `iter/handoff` with the exact blocker and attempted command/query.

Do not proceed to commit/PR before required verification evidence exists.
