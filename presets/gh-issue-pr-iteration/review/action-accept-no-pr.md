# Fragment: review/action-accept-no-pr

## Goal

Accept an issue without a PR only when live evidence proves it is already satisfied on the base branch, is a complete no-code closure, or is a complete `kind:code-spike` source-writing spike that should become `done` rather than `moot`.

## Preconditions

Use only when `review/issue-closure-gate` proves current scope and children are complete without requiring a new implementation PR.

## Procedure

1. Comment on the issue with the already-satisfied evidence and child closure table when applicable.
2. Close the issue with an evidence-backed reason.

```bash
gh issue comment <ISSUE> -R <REPO> --body "$(cat <<'EOF'
## Coder-loop closure review (<RUN_ID>)

Review verified that this issue is fully handled without an implementation PR.

Reason:
<evidence-backed reason>
EOF
)"

gh issue close <ISSUE> -R <REPO> --comment "Closed by coder-loop review <RUN_ID> after verifying completion."
```

If close fails or the issue remains open, do not set local `done`.

## Output verdict

Choose exactly one:

- `accepted_no_pr_closed` → read `review/update-state` with transition `accepted_no_pr`.
- `accept_no_pr_failed` → read `review/action-retry`.
