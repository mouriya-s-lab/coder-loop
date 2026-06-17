# Acceptance: diff-audit (review)

## Required report fields

Reject the report (send back the gap list) unless it contains all of: `Refs audited` with both SHAs; `Scope mapping` table covering **every** changed file (cross-check the count against `gh pr view --json files` yourself); `Hygiene findings`; `Issue-named pattern coverage` table with one row per pattern the issue body declares as a whole-repo target (every row carries a verbatim issue quote, a source-section pointer, a runnable criterion/command, an explicit site count, and — when count > 0 — every remaining site listed individually with `file:line`; an explicit single `none | - | - | - | -` row only after you confirmed the issue body declares no such target); `Code findings` with per-finding anchors; `Change footprint`; `Problems`. A report that paraphrases the PR description instead of auditing the diff is not a diff audit — send it back.

## Judgment

Form your verdict input from the accepted report:

- **Unmapped files** → scope violation finding. An unmapped file is excusable only when the live issue body literally covers it; your reading of "probably fine" does not excuse it.
- **Hygiene findings** → any staged runtime artifact / scheduling state / run log is a hard retry finding.
- **Issue-named pattern coverage** → every row whose Sites > 0 is a retry finding; cite **all** remaining sites for that pattern in the feedback in one shot, never split the same pattern across rounds (the whole reason this section exists is to stop the "review finds three sites in round N, three more in round N+1, three more in round N+2" pattern). A pattern the issue body literally names but the report omits is a step defect — send back. A row marked `0 / converged` whose criterion you can re-run (the report records the command) and re-running surfaces sites is a credibility failure — send back. Conversely, a finding the report includes here that is **not** literally named by the issue body is divergence dressed up as coverage — discard it and tell the subagent why.
- **Code findings** → verdict inputs only when properly anchored: a logic finding must carry a traceable failure path; a design-deviation finding must quote the issue sentence it deviates from; a convention finding must cite the convention source or neighboring counter-example. Anchored findings route to retry with the anchor quoted in the feedback. Discard (and tell the subagent why) findings that are alternative-design taste, improvement ideas beyond the issue's design, or about code the diff does not touch *and is not covered by an issue-named pattern in 5a* — divergence is not a verdict input, and accepting it trains the loop to wander.
- **Change footprint** feeds your caveat-honesty judgment: compare it against the iteration's declared `Intent (run …)` blocks for intent-action mismatch.
- The report describing findings with severity-downgrading language ("minor", "cosmetic") violates its task — treat as report defect, send back.
