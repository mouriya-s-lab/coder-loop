# Action: retry

Publish precise feedback for work that remains actionable.

## Feedback target

- Live implementation PR exists → all retry feedback on that PR. Prefer `gh pr review --request-changes`; if GitHub rejects a formal self-review, post an ordinary PR comment.
- No PR → feedback as an issue comment.
- Never post PR-related review results only to the issue.

## Feedback body — a full review report, fixed structure

```markdown
## Review verdict: changes requested (<RUN_ID>)
<if contract integrity failed, the red-line warning opens here, before anything else:
the issue body is the contract; it was edited without authorization, the tampering has
been detected and reversed to the snapshot of <editedAt>; editing the contract to pass
review is the one inviolable line — recurrence routes this issue out of the loop.>

## Check reports
### diff-audit — <pass/fail; digest: scope mapping result, hygiene, code findings with anchors>
### test-integrity — <pass/fail; digest: enumeration, both counts, correlation>
### replay — <pass/fail; digest: rows run/matched/failed, blocked-path e2e when applicable>
### e2e-replay — <pass/fail; digest: claims re-driven, observations, form check>
### Judgments — contract integrity / trace honesty / PR protocol / title-intent / caveat honesty / evidence form / checks+mergeability: <one line each, pass or fail with the exact trigger quote>

## 缺失汇总
- <every missing/failing item across all checks, one line each, in one place —
  every failed replay row (#, Check, Command, actual vs Expect), every code finding
  with its anchor, every manifest gap, every judgment trigger — or `none`>

## Skipped checks
- <check → reason (kind-matrix routing / no-PR route / infra) — or `none`>

## Required changes
<concrete fixes, one per 缺失 item; a row failing because the issue body's Command
itself is broken instructs fixing the issue contract first, then re-running — not
reinterpreting the row>

## Constraints
do not bypass coder-loop review; do not merge manually; do not close the issue manually;
never edit the issue body without literal authorization on the issue thread
```

Every check that ran appears in `Check reports` even when it passed; every check that did not run appears in `Skipped checks` with its reason. The 缺失汇总 block is the single authoritative gap list — iteration fixes everything in it in one retry.

## After publishing

Feedback durably posted → write state per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md` with transition `retry`, then continue the entry's wrap-up.

Feedback publication itself failed → do not update local state as if feedback were durable; take the stop action with the exact failure.
