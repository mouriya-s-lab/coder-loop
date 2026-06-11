# Action: accept PR-backed work

Use only when all four dispatched reports (diff-audit, test-integrity, replay, e2e-replay), all judgments, and the closure judgment passed.

## Procedure

1. Post the acceptance review report on the PR — same fixed structure as every review reply:

```markdown
## Review verdict: accepted (<RUN_ID>)

## Check reports
### diff-audit — pass: <digest: scope mapping, hygiene, code findings (none expected)>
### test-integrity — pass: <digest: enumeration, both counts>
### replay — pass: <digest: rows run, all matched; blocked-path e2e when applicable>
### e2e-replay — pass: <digest: claims re-driven, observations matched>
### Judgments — contract integrity / trace honesty / PR protocol / title-intent / caveat honesty / evidence form / checks+mergeability: <one line each>

## 缺失汇总
none

## Skipped checks
- <check → reason — or `none`>
```

An acceptance whose 缺失汇总 is not `none` is not an acceptance — go back to the retry action.
2. Merge:

```bash
gh pr merge <PR_NUMBER> -R <REPO> --squash --delete-branch
```

3. If merge succeeds and `ISSUE_KIND` is `blocked`, perform the unblock side effect before closing:
   - Re-fetch the issue body; parse the `Unblocks: owner/repo#N` back-link. Multiple `Unblocks:` lines → do not guess; retry or stop with the ambiguity recorded.
   - No back-link at all → log `skip-no-cross-repo-back-link` in the handoff and proceed to close (compatibility path).
   - Resolve the source repository's target checkout/runtime from local state, handoff, supervisor state, or paths in the issue history. Do not ask for credentials or paths in chat.
   - Re-queue and restart the source target:

```bash
coder-loop queue unblock <SOURCE_TARGET_CWD> --issue <SOURCE_ISSUE> --start-daemon
coder-loop status <SOURCE_TARGET_CWD> --json   # verify: item no longer blocked, daemon running
```

   - If any of back-link/source-target/re-queue/daemon-start/verification cannot complete: do not close the issue, do not write local `done`; record the exact failed command and take the stop action (infrastructure). A merged unblock PR without the downstream side effect is not complete.
4. Comment on and close the issue:

```bash
gh issue comment <ISSUE> -R <REPO> --body "$(cat <<'EOF'
## Coder-loop closure review (<RUN_ID>)

Review verified this issue is fully handled.

- Acceptance criteria: independently replayed, all rows matched.
- Child/subtask issues: all closed with merged PRs or justified no-code closure.
- Final transition made by coder-loop review.

Reason:
<evidence-backed reason>
EOF
)"

gh issue close <ISSUE> -R <REPO> --comment "Closed by coder-loop review <RUN_ID> after verifying completion of scope, children, and PRs."
```

## Failure routing

Every command above is a required side effect. Side effect blocked by a noninteractive approval boundary or failing before durable feedback/closure/unblock published → record exact command + output in handoff, do **not** write local `done`, take the stop action so the daemon cannot replay the same accepted PR. Acceptance posted but merge/close fails for an ordinary reason (conflict, failing checks, stale mergeability) → do not write `done`; take the retry action with exact PR feedback.

On full success, write state per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md` with transition `accepted_pr`, then continue the entry's wrap-up.
