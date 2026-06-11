# Acceptance: implement

## Required report fields

The report must contain: `Why I did it this way`; `What I actually did` with branch + head state, the complete files-changed list, the intent-appended pointer, the row-coverage table covering **every** acceptance/inherited row and custom-section requirement, and the test-changes enumeration (explicit `none` allowed); `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Contract coverage** — every acceptance row and custom-section requirement of the live issue body is either addressed, or flagged with a concrete deviation reason in the row-coverage table. Silent drops are gaps. (Cross-check the table against the issue body you read during investigation; re-fetch if stale.)
- **Classification sanity** — the declared change kind matches what the issue demands; for substitutive/removal work the footprint list exists and each site has an owner. "Added the new thing" with the old thing unaccounted for is the classic trap — a gap.
- **Test integrity** — a non-empty test-changes enumeration must be justified by the issue contract; removal/skip/loosening the issue body does not literally demand is a gap to send back now (cheaper here than at review's diff-audit).
- **Intent landed** — the handoff file contains an `Intent (run …)` block for this run. Missing intent on a substantive change is a gap (review will hard-fail it later).
- **Boundary compliance** — no batching, no commits/PRs/GitHub writes from this step.
- Apply `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md` — especially intent-action mismatch, cross-issue deferral, and test weakening triggers in the report itself.

Your gate is the contract and the report's coherence — review's diff-audit independently reads the code against the issue design and conventions, so do not duplicate a line-by-line code review here; but a report that itself reveals a design deviation (mechanism/placement differing from what the issue names) is a gap to send back now, cheaper than at review. Send back precise gap lists; do not fix code yourself.
