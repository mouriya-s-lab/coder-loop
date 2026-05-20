# Fragment: review/action-accept-no-pr

## Goal

Accept an issue without a PR only when live evidence proves it is already satisfied on the base branch, is a complete no-code closure, or is a complete `kind:code-spike` source-writing spike that should become `done` rather than `moot`.

## Preconditions

Use only when `review/issue-closure-gate` proves current scope and children are complete without requiring a new implementation PR.

## Procedure

1. Comment on the issue with the already-satisfied evidence and child closure table when applicable.
2. If `ISSUE_KIND` is `blocked`, perform the unblock side effect before closing the current issue:

   - Re-fetch the current issue body and parse the `Unblocks: owner/repo#N` back-link. If multiple `Unblocks:` lines exist, do not guess; retry or stop with the ambiguity recorded.
   - If the issue body contains no `Unblocks: owner/repo#N` line at all, log `skip-no-cross-repo-back-link` in the issue handoff and proceed to close the current issue without invoking `coder-loop queue unblock`. This is the compatibility path for non-cross-repo `kind:blocked` issues.
   - Resolve the source repository target checkout/runtime for that back-link from available local state, handoff, supervisor state, or an explicit path already present in the issue/comment history. Do not ask for credentials or target paths in chat.
   - Through the supported `coder-loop` CLI for that source target, re-queue the blocked item named by the back-link so it becomes actionable again, then start or restart that source target's daemon:

```bash
coder-loop queue unblock <SOURCE_TARGET_CWD> --repo <SOURCE_REPO> --issue <SOURCE_ISSUE> --start-daemon --require-browser-evidence
```

   - Verify with `coder-loop status <SOURCE_TARGET_CWD> --json --repo <SOURCE_REPO>` that the item is no longer `blocked` and that the daemon is running or was started successfully.

   If the back-link, source target, re-queue command, daemon start, or status verification cannot be completed, do not close the current issue and do not write local `done`; record the exact failed command/query and use the infrastructure failure path. A no-PR accepted unblock issue without the downstream re-queue/start side effect is not complete for `kind:blocked`.

3. Close the issue with an evidence-backed reason.

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

Each command above is a required side effect. For `kind:blocked`, that includes the cross-repo unblock/re-queue/start verification before current issue closure. If any required side effect is blocked by a noninteractive approval/permission boundary (for example, `This command requires approval`) or otherwise fails before durable feedback/closure/unblock can be published, record the exact failed command, target repo/issue/source target, accepted verdict, and command output in handoff, do not set local `done`, and stop as review infrastructure failure so the daemon cannot immediately replay the same accepted no-PR closure.

If the closure comment was published and a later close command fails for an ordinary actionable reason such as transient GitHub failure, stale issue state, or issue status mismatch, do not set local `done`; retry with exact issue feedback.

If close fails or the issue remains open, do not set local `done`.

## Output verdict

Choose exactly one:

- `accepted_no_pr_closed` → read `review/update-state` with transition `accepted_no_pr`.
- `accept_no_pr_infrastructure_failed` → read `review/action-stop`.
- `accept_no_pr_retry_needed` → read `review/action-retry`.
