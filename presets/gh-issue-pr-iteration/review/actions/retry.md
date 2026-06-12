# Action: retry

Publish precise feedback for work that remains actionable.

## Feedback target

- Live implementation PR exists → all retry feedback on that PR. Prefer `gh pr review --request-changes`; if GitHub rejects a formal self-review, post an ordinary PR comment.
- No PR → feedback as an issue comment.
- Never post PR-related review results only to the issue.

## Feedback body — a full review report, fixed structure

Every field below demands a measured value, a verbatim quote, or an identifier that only exists if the check was actually performed. A field you cannot fill is a check you have not done — go back and do it; never pad the field with prose.

```markdown
## Review verdict: changes requested (<RUN_ID>)
<if contract integrity failed, the red-line warning opens here, before anything else:
the issue body is the contract; it was edited without authorization, the tampering has
been detected and reversed to the snapshot of <editedAt>; editing the contract to pass
review is the one inviolable line — recurrence routes this issue out of the loop.>

## Check reports
### diff-audit — <pass/fail>
refs <base-sha>..<head-sha>; files changed <n>: in-scope <n> / support <n> / unmapped <n: list or none>;
hygiene: <none / findings with paths>; code findings: <none / one line per finding:
category @ file:line — anchor>
### test-integrity — <pass/fail>
base <count> (`<command>`) vs head <count> (`<command>`); enumerated: removed <n> /
renamed <n> / skipped <n> / weakened <n>; correlation: <consistent / hidden weakening: what>;
packet delta line: <agrees / mismatch: quote both>
### replay — <pass/fail>
head <sha>; rows <total>: matched <n> / failed <n: row #s> / deferred-browser <n: row #s> /
artifact-verified <n>; blocked-path e2e: <command + exit / not applicable>
### e2e-replay — <pass/fail>
environment: <probe result; restarted: yes/no>; claims re-driven <n>: matched <n> /
mismatched <n: which>; browser rows closed <n>/<n deferred>; form: <direct / script: name it>
### Judgments
- contract integrity: <body edits since enqueue: n; per edit: editedAt + editor; verdict —
  tampered cases add `restored to snapshot <editedAt>`>
- trace honesty: <claims cross-checked: n; one named pair: "<claim>" ↔ <observation>; verdict>
- PR protocol: <body first line quoted verbatim; this run's PR comment URL; verdict>
- title-intent: <"<issue title>" vs "<PR title>" after prefix strip; verdict>
- caveat honesty: <Intent/Result blocks read: run ids; trigger phrases: none / "<exact quote>">
- evidence form: <required packet sections: present / missing by name; manifest
  re-runnable: yes / no + the missing entry>
- checks/mergeability: <head sha observed; each check: name=conclusion; mergeStateStatus;
  observed at <timestamp>>

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

Every check that ran appears in `Check reports` even when it passed — with its measured values, never a bare verdict; every check that did not run appears in `Skipped checks` with its reason. The 缺失汇总 block is the single authoritative gap list — iteration fixes everything in it in one retry.

## After publishing

Feedback durably posted → write state per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md` with transition `retry`, then continue the entry's wrap-up.

Feedback publication itself failed → do not update local state as if feedback were durable; take the stop action with the exact failure.
