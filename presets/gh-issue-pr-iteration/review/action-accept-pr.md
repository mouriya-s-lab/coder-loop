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

3. If merge succeeds and `ISSUE_KIND` is `blocked`, perform the unblock side effect before closing the current issue:

   - Re-fetch the current issue body and parse the `Unblocks: owner/repo#N` back-link. If multiple `Unblocks:` lines exist, do not guess; retry or stop with the ambiguity recorded.
   - Resolve the source repository target checkout/runtime for that back-link from available local state, handoff, supervisor state, or an explicit path already present in the issue/comment history. Do not ask for credentials or target paths in chat.
   - Through the supported `coder-loop` CLI for that source target, re-queue the blocked item named by the back-link so it becomes actionable again, then start or restart that source target's daemon.
   - Verify with `coder-loop status <SOURCE_TARGET_CWD> --json --repo <SOURCE_REPO>` that the item is no longer `blocked` and that the daemon is running or was started successfully.

   If the back-link, source target, re-queue command, daemon start, or status verification cannot be completed, do not close the current issue and do not write local `done`; record the exact failed command/query and use the infrastructure failure path. A merged unblock PR without the downstream re-queue/start side effect is not complete for `kind:blocked`.

4. If merge succeeds and any required unblock side effect succeeds, comment on and close the issue:

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

Each command above is a required side effect. For `kind:blocked`, that includes the cross-repo unblock/re-queue/start verification before current issue closure. If any required side effect is blocked by a noninteractive approval/permission boundary (for example, `This command requires approval`) or otherwise fails before durable feedback/closure/linking/unblock can be published, record the exact failed command, target PR/issue/source target, and accepted verdict in handoff, do not set local `done`, and stop as review infrastructure failure so the daemon cannot immediately replay the same accepted PR.

If the acceptance comment was published and a later merge/closure command fails for an ordinary actionable reason such as merge conflict, failing checks, or stale mergeability, do not set local `done`; retry with exact PR feedback.

## Output verdict

Choose exactly one:

- `accepted_pr_closed` → read `review/update-state` with transition `accepted_pr`.
- `accept_pr_infrastructure_failed` → read `review/action-stop`.
- `accept_pr_retry_needed` → read `review/action-retry`.
