# Action: accept PR-backed work

Use only when both dispatched reports (diff-audit, verification-audit), all judgments, and the completeness judgment passed. This action publishes the durable ReviewVerdict and ends in a clean exit — you do not merge or close anything; closure re-reads live state and performs the irreversible effects after you.

## Procedure

1. Post the acceptance review report on the PR — same fixed shape as every review reply. Each check that ran gets a section that references observed values (SHAs, counts, verbatim quotes from the retry comment / PR body caveats, URLs); each check that did not run appears in `## Skipped checks` with its reason:

```markdown
## Review verdict: accepted (<RUN_ID>)

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

## 缺失汇总
none

## 范围外根因（不入本 PR 账单）
- <defect groups from the diff-audit `Out-of-scope roots` section: mechanism, provenance
  (base-owned / sibling-issue-owned / engine-level), complete sites, evidence — a routing
  record for the operator; entries here do not block acceptance — or `none`>

## Skipped checks
- <check → reason — or `none`>
```

An acceptance whose 缺失汇总 is not `none` is not an acceptance — go back to the retry action. A non-empty `范围外根因` section is compatible with acceptance: those defects are not this PR's debt, and dropping them from the report would discard the only durable record the operator can route from.

2. In the same comment, publish the machine-readable verdict per `{{PRESET_ROOT}}/common/packets.md` — a fenced json block labeled `coder-loop:review-verdict`:

```json
{
  "kind": "accepted-pr",
  "candidate": { "kind": "implementation-pr", "pr": 123, "branch": "…", "headSha": "<the audited head sha>" },
  "verificationPacketUrl": "<the audited packet comment URL>"
}
```

Populate `candidate` verbatim from the CandidateRef the verification-audit bound, and `verificationPacketUrl` from the packet comment it audited. Closure consumes exactly this block; a verdict naming an unaudited SHA sends closure after the wrong object.

3. Verify the verdict comment resolves live (fetch the comment URL back). Record the URL in the handoff — closure and the unblock relation (when the issue body carries `Unblocks:`) both key off live GitHub state, so nothing else needs pre-staging here.

## Failure routing

The verdict comment is the required side effect. Publication blocked by a noninteractive approval boundary or failing before the comment is durable → record exact command + output in handoff and take the stop action; do not exit clean without a durable verdict — closure would find nothing to execute and route the item back as review-drift.

On full success: no status write. Continue the entry's wrap-up and exit 0 — the scheduler advances to closure, which merges the PR, performs any unblock side effect, closes the issue, and writes the terminal status.
