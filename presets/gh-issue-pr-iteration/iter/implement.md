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