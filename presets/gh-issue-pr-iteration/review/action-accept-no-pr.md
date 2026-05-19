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

Each command above is a required GitHub side effect. If any required side effect is blocked by a noninteractive approval/permission boundary (for example, `This command requires approval`) or otherwise fails before durable feedback/closure can be published, record the exact failed command, target repo/issue, accepted verdict, and command output in handoff, do not set local `done`, and stop as review infrastructure failure so the daemon cannot immediately replay the same accepted no-PR closure.

If the closure comment was published and a later close command fails for an ordinary actionable reason such as transient GitHub failure, stale issue state, or issue status mismatch, do not set local `done`; retry with exact issue feedback.

If close fails or the issue remains open, do not set local `done`.

## Output verdict

Choose exactly one:

- `accepted_no_pr_closed` → read `review/update-state` with transition `accepted_no_pr`.
- `accept_no_pr_infrastructure_failed` → read `review/action-stop`.
- `accept_no_pr_retry_needed` → read `review/action-retry`.
