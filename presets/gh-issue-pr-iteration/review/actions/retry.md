# Action: retry

Publish precise feedback for work that remains actionable.

## Feedback target

- Live implementation PR exists → all retry feedback on that PR. Prefer `gh pr review --request-changes`; if GitHub rejects a formal self-review, post an ordinary PR comment.
- No PR → feedback as an issue comment.
- Never post PR-related review results only to the issue.

## Feedback body — a full review report, fixed shape

Every check that ran gets a section that references observed values (SHAs, counts, verbatim quotes from the retry comment / PR-body caveat sections, URLs, timestamps). The `## 缺失汇总` block is the single authoritative gap list — the next iteration fixes everything in it in one retry. Every check that did not run appears in `## Skipped checks` with its reason.

Rounds must be monotone: a finding that was discoverable at the previous review round's head — not caused by code changed since, and not surfaced by a newly identified mechanism's class sweep — is marked `late-discovery` and obliges you to include its mechanism's complete class sweep in this same round's list. An already-swept class must never resurface one site at a time in later rounds.

```markdown
## Review verdict: changes requested (<RUN_ID>)

## Check reports
### diff-audit — <pass/fail>
refs <base-sha>..<head-sha>; files changed <n>: in-scope <n> / support <n> / unmapped <n: list or none>;
hygiene: <none / findings with paths>; test changes in diff: <enumeration or none>;
code findings: <none / one line per finding: category @ file:line — anchor>
### verification-audit — <pass/fail>
identity binding: <bound / MISMATCH sha-pair>; coverage: <n>/<n> marker rows, gaps: <IDs or none>;
artifacts: <resolved / contradictions with anchors>; live checks: <each name=conclusion>;
runtime record: <kind, complete/missing fields>; conclusion consistency: <consistent / contradiction>
### Judgments
- trace honesty: <one named pair or verdict>
- PR protocol: <body first line quoted; ready/draft; PR comment URL; verdict>
- title-intent: <"<issue title>" vs "<PR title>"; verdict>
- caveat honesty: <Intent/Result verdict; trigger phrases: none / "<exact quote>">
- evidence form: <sections present / missing by name; manifest re-runnable: yes / no + missing entry>
- checks/mergeability: <head sha; each check: name=conclusion; mergeStateStatus>

## 缺失汇总
- <every missing/failing item across all checks, in one place, grouped by root mechanism
  where the diff-audit established one: the mechanism sentence, its provenance, and the
  complete site set it produces — the fix targets the mechanism once, never one site per
  round; plus every identity mismatch (both SHAs), every uncovered/contradicted marker
  row (ID), every packet gap — or `none`>

## 范围外根因（不入本 PR 账单）
- <defect groups from the diff-audit `Out-of-scope roots` section: mechanism, provenance
  (base-owned / sibling-issue-owned / engine-level), complete sites, evidence. These are
  NOT required changes for this PR and the next iteration is not judged on them; they
  exist so the operator can route each one to its own issue — or `none`>

## Skipped checks
- <check → reason (deliverable-route routing / no-PR route / infra) — or `none`>

## Required changes
<concrete implementation fixes, one per 缺失 mechanism or item — a mechanism-rooted
entry gets one mechanism-level fix covering its complete site set. A malformed, stale, or
intrinsically broken marker Check is not an implementation retry: use the
contract-invalid action so contract-enrichment publishes a superseding marker>

## Constraints
do not bypass coder-loop review; do not merge manually; do not close the issue manually;
never edit the issue body; contract corrections are superseding marker comments produced by contract-enrichment
```

## After publishing

Feedback durably posted → write state per `{{PRESET_ROOT}}/review/actions/state-write.md` with transition `retry`, then continue the entry's wrap-up. The next fresh iteration consumes the 缺失汇总; verification and publish then re-run on its new candidate before you see the issue again.

Feedback publication itself failed → do not update local state as if feedback were durable; take the stop action with the exact failure.
