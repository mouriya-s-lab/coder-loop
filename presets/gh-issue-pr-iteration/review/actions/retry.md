# Action: retry

Publish precise feedback for work that remains actionable.

## Feedback target

- Live implementation PR exists → all retry feedback on that PR. Prefer `gh pr review --request-changes`; if GitHub rejects a formal self-review, post an ordinary PR comment.
- No PR → feedback as an issue comment.
- Never post PR-related review results only to the issue.

## Feedback body — a full review report, fixed shape

Every check that ran gets a section that references observed values (SHAs, counts, verbatim quotes from the retry comment / PR-body caveat sections, URLs, timestamps). The `## 缺失汇总` block is the single authoritative gap list — iteration fixes everything in it in one retry. Every check that did not run appears in `## Skipped checks` with its reason.

```markdown
## Review verdict: changes requested (<RUN_ID>)

## Check reports
### diff-audit — <pass/fail>
refs <base-sha>..<head-sha>; files changed <n>: in-scope <n> / support <n> / unmapped <n: list or none>;
hygiene: <none / findings with paths>; test changes in diff: <enumeration or none>;
code findings: <none / one line per finding: category @ file:line — anchor>
### replay — <pass/fail>
head <sha>; canonical suite: <count>; rows <total>: matched <n> / failed <n: row #s> /
browser <n: row #s>; e2e re-drive: <n> matched / <n> mismatched (which);
form: <direct / script: name it>; blocked-path e2e: <command + exit / not applicable>
### Judgments
- trace honesty: <one named pair or verdict>
- PR protocol: <body first line quoted; PR comment URL; verdict>
- title-intent: <"<issue title>" vs "<PR title>"; verdict>
- caveat honesty: <Intent/Result verdict; trigger phrases: none / "<exact quote>">
- evidence form: <sections present / missing by name; manifest re-runnable: yes / no + missing entry>
- checks/mergeability: <head sha; each check: name=conclusion; mergeStateStatus>

## 缺失汇总
- <every missing/failing item across all checks, one line each, in one place —
  every failed replay row (#, Check, Command, actual vs Expect), every code finding
  with its anchor, every manifest gap — or `none`>

## Skipped checks
- <check → reason (deliverable-route routing / no-PR route / infra) — or `none`>

## Required changes
<concrete fixes, one per 缺失 item; a row failing because the issue body's Command
itself is broken instructs fixing the issue contract first, then re-running — not
reinterpreting the row>

## Constraints
do not bypass coder-loop review; do not merge manually; do not close the issue manually;
never edit the issue body; contract corrections are superseding marker comments produced by contract-enrichment
```

## After publishing

Feedback durably posted → write state per `{{PRESET_ROOT}}/review/actions/state-write.md` with transition `retry`, then continue the entry's wrap-up.

Feedback publication itself failed → do not update local state as if feedback were durable; take the stop action with the exact failure.
