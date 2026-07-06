# Action: accept without a PR

Use only when closure judgment proves current scope and children are complete without a new implementation PR: already satisfied on base, complete no-code closure, or a complete source-writing-spike-deliverable spike (which becomes `done`, not `moot`).

## Procedure

1. Comment on the issue with the already-satisfied/spike-complete evidence and the child closure table when applicable.
2. When the issue is an unblock-deliverable issue (its body carries `Unblocks:` and `## 阻塞条件` per `contract.md` §1.2), perform the unblock side effect first — same sub-procedure and failure rules as in `{{PRESET_ROOT}}/review/actions/accept-pr.md` step 3.
3. Close with an evidence-backed reason:

```bash
gh issue comment <ISSUE> -R <REPO> --body "$(cat <<'EOF'
## Coder-loop closure review (<RUN_ID>)

Review verified this issue is fully handled without an implementation PR.

Reason:
<evidence-backed reason>
EOF
)"

gh issue close <ISSUE> -R <REPO> --comment "Closed by coder-loop review <RUN_ID> after verifying completion."
```

## Failure routing

Side effect blocked by an approval boundary / failed before durable publication → record exact command + output in handoff, do not write `done`, take the stop action. Comment published but close fails for an ordinary reason → do not write `done`; take the retry action with exact issue feedback. Issue still open = no `done`, ever.

On full success, write state per `{{PRESET_ROOT}}/review/actions/state-write.md` with transition `accepted_no_pr`, then continue the entry's wrap-up.
