# Acceptance: diff-audit (review)

## Required report fields

Reject the report (send back the gap list) unless it contains all of: `Refs audited` with both SHAs; `Scope mapping` table covering **every** changed file (cross-check the count against `gh pr view --json files` yourself); `Hygiene findings`; `Test integrity` with both inventory counts, their commands, and the enumeration table (explicit `none` allowed only after enumeration); `Code findings` with per-finding anchors; `Change footprint`; `Problems`. A report that paraphrases the PR description instead of auditing the diff is not a diff audit — send it back.

## Judgment

Form your verdict input from the accepted report:

- **Unmapped files** → scope violation finding. An unmapped file is excusable only when the live issue body literally covers it; your reading of "probably fine" does not excuse it.
- **Hygiene findings** → any staged runtime artifact / scheduling state / run log is a hard retry finding.
- **Test integrity** → a non-empty removed/skipped/weakened enumeration is a test-weakening trigger under `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md` unless the issue body literally demands that exact change (e.g. the issue is itself about removing that test). An inventory count drop without a matching enumerated entry is hidden weakening — hard retry. Apply the stale-baseline exception of the same file to pure count drift explained by base movement.
- **Code findings** → verdict inputs only when properly anchored: a logic finding must carry a traceable failure path; a design-deviation finding must quote the issue sentence it deviates from; a convention finding must cite the convention source or neighboring counter-example. Anchored findings route to retry with the anchor quoted in the feedback. Discard (and tell the subagent why) findings that are alternative-design taste, improvement ideas beyond the issue's design, or about code the diff does not touch — divergence is not a verdict input, and accepting it trains the loop to wander.
- **Change footprint** feeds your caveat-honesty judgment: compare it against the iteration's declared `Intent (run …)` blocks for intent-action mismatch.
- The report describing findings with severity-downgrading language ("minor", "cosmetic") violates its task — treat as report defect, send back.
