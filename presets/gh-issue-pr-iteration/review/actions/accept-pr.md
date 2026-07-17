# Action: accept PR-backed work

Use only when both durable audit reports (DiffAuditReport, VerificationAuditReport) came back `clean`, all self-judgments, and the completeness judgment passed. This action publishes the durable ReviewVerdict and ends in a clean exit — you do not merge or close anything; closure re-reads live state and performs the irreversible effects after you.

## Procedure

1. Post the acceptance review report on the PR — same fixed shape as every review reply. Each check that ran gets a section that references observed values (SHAs, counts, verbatim quotes from the retry comment / PR body caveats, URLs); each check that did not run appears in `## Skipped checks` with its reason:

The comment follows the legibility rules of `{{PRESET_ROOT}}/common/github-routing.md`: headline first, the verdict block and operator-facing routing record above the fold, the check/judgment bulk folded.

```markdown
**[review] accepted @ <short-sha>** — all checks pass; closure may merge

## Review verdict: accepted (<RUN_ID>)

## 范围外根因（不入本 PR 账单）
- <defect groups from the diff-audit `Out-of-scope roots` section: mechanism, provenance
  (base-owned / sibling-issue-owned / engine-level), complete sites, evidence — a routing
  record for the operator; entries here do not block acceptance — or `none`>

<details>
<summary>Check reports & judgments (observed values)</summary>

## Check reports
### diff-audit — pass
refs <base-sha>..<head-sha>; files changed <n>: in-scope <n> / support <n> / unmapped none;
hygiene: none; test changes in diff: <enumeration or none>; code findings: none
### verification-audit — pass
identity binding: CandidateRef <sha> == packet.candidate == live head; coverage: <n>/<n> marker
rows in packet, all consistent; artifacts: resolved and matching; live checks: <each name=conclusion>;
runtime record: <kind>, conclusion verified
### Judgments
- trace honesty: <one named pair: "<claim>" ↔ <observation>>
- PR protocol: <body first line quoted; ready (not draft); this run's PR comment URL>
- title-intent: <"<issue title>" vs "<PR title>" after prefix strip>
- caveat honesty: Intent/Result verdict; trigger phrases: none
- evidence form: required packet sections all present; manifest re-runnable: yes
- checks/mergeability: <head sha; each check: name=conclusion; mergeStateStatus>
- cross-round regression: <historical findings ledger row count = submit ledger row count = <n>; every row status ∈ addressed/regressed-and-refixed/deferred with cited evidence verified; no silent drops; no regression of previously-addressed findings — or `n=0 (round 1)`>

## 缺失汇总
none

## Skipped checks
- <check → reason — or `none`>

</details>
```

An acceptance whose 缺失汇总 is not `none` is not an acceptance — go back to the retry action. A non-empty `范围外根因` section is compatible with acceptance: those defects are not this PR's debt, and dropping them from the report would discard the only durable record the operator can route from.

2. In the same comment, directly under the headline and above any fold, publish the machine-readable verdict per `{{PRESET_ROOT}}/common/packets.md` — a fenced json block labeled `coder-loop:review-verdict`:

```json
{
  "kind": "accepted-pr",
  "candidate": { "kind": "implementation-pr", "pr": 123, "branch": "…", "headSha": "<the audited head sha>" },
  "verificationPacketUrl": "<the audited packet comment URL>"
}
```

Populate `candidate` verbatim from the CandidateRef the verification-audit bound, and `verificationPacketUrl` from the packet comment it audited. Closure consumes exactly this block; a verdict naming an unaudited SHA sends closure after the wrong object.

3. Verify the verdict comment resolves live (fetch the comment URL back). Record the URL in the handoff — closure and the unblock relation (when the issue body carries `Unblocks:`) both key off live GitHub state, so nothing else needs pre-staging here. Then update the PR body's `coder-loop:current-state` index by **appending** this comment's URL to `reviewVerdictUrls` (never overwrite an earlier array element, never truncate — per `{{PRESET_ROOT}}/common/packets.md`); closure resolves the latest verdict as `reviewVerdictUrls[length-1]`, and the earlier entries stay as durable audit trail for future iter-entry cross-round reads. Then minimize your own previous (superseded) verdict comments on this thread per `common/github-routing.md`.

## Failure routing

The verdict comment is the required side effect. Publication blocked by a noninteractive approval boundary or failing before the comment is durable → record exact command + output in handoff and take the stop action; do not exit clean without a durable verdict — closure would find nothing to execute and route the item back as review-drift.

On full success: no status write. Continue the entry's wrap-up and exit 0 — the scheduler advances to closure, which merges the PR, performs any unblock side effect, closes the issue, and writes the terminal status.
