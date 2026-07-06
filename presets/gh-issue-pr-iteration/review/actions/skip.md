# Action: skip

Mark an issue moot locally only after closing it on GitHub with a verified skip reason. Only for verified invalid, duplicate, out-of-scope, no-code, or truly moot outcomes. Parent/umbrella issues are never skipped merely for being parents.

## Procedure

1. Comment on the issue with the verified reason no implementation PR should be merged.
2. If a live PR must be explicitly abandoned as invalid, also comment on the PR.
3. Close:

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

## After

Close succeeded → write state per `{{PRESET_ROOT}}/review/actions/state-write.md` with transition `skip`. Close failed or issue remains open → no local `moot`; take the retry action.
