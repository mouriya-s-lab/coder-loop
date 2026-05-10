# Fragment: review/action-accept-pr

## Goal

Accept PR-backed work by publishing acceptance, merging the PR, and closing the GitHub issue before local `done`.

## Preconditions

Use only when PR protocol, evidence gate, code gate, and issue closure gate pass.

## Procedure

1. Post an acceptance summary on the PR. State that evidence was sufficient before code review and list the decisive evidence layers.
2. Merge the PR:

```bash
gh pr merge <PR_NUMBER> -R <REPO> --squash --delete-branch
```

3. If merge succeeds, comment on and close the issue:

```bash
gh issue comment <ISSUE> -R <REPO> --body "$(cat <<'EOF'
## Coder-loop closure review (<RUN_ID>)

Review verified that this issue is fully handled.

- Current issue acceptance criteria: complete.
- Child/subtask issues: all closed.
- Corresponding PRs: merged, or no-code closure is justified in issue history.
- Final transition was made by coder-loop review.

Reason:
<evidence-backed reason>
EOF
)"

gh issue close <ISSUE> -R <REPO> --comment "Closed by coder-loop review <RUN_ID> after verifying completion of parent scope, child issues, and corresponding PRs."
```

If merge or issue close fails, do not set local `done`; retry with exact PR feedback.

## Output verdict

Choose exactly one:

- `accepted_pr_closed` → read `review/update-state` with transition `accepted_pr`.
- `accept_pr_failed` → read `review/action-retry`.