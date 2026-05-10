# Fragment: review/action-skip

## Goal

Mark an issue moot locally only after closing it on GitHub with a verified skip reason.

## Preconditions

Use only for verified invalid, duplicate, out-of-scope, no-code, or truly moot outcomes. Parent/umbrella issues are never skipped merely because they are parents.

## Procedure

1. Comment on the issue with the verified reason no implementation PR should be merged.
2. If a live PR must be explicitly abandoned as invalid, also comment on the PR.
3. Close the GitHub issue.

```bash
gh issue comment <ISSUE> -R <REPO> --body "$(cat <<'EOF'
## Coder-loop skip review (<RUN_ID>)

This issue will be closed without implementation.

Reason:
<verified skip reason>
EOF
)"

gh issue close <ISSUE> -R <REPO> --comment "Closed by coder-loop review <RUN_ID>: <short verified skip reason>."
```

If close fails or the issue remains open, do not set local `moot`.

## Output verdict

Choose exactly one:

- `skip_closed` → read `review/update-state` with transition `skip`.
- `skip_close_failed` → read `review/action-retry`.