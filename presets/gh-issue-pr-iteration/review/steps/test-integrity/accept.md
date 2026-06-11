# Acceptance: test-integrity (review)

## Required report fields

The report must contain: `Refs measured` with both SHAs; `Test changes enumerated from the diff` (explicit `none` only after enumeration); `Inventory` with both counts, both commands, and the setup performed per side; `Correlation findings`; `Problems` confirming the scratch worktrees were removed. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Measured, not narrated** — both counts come from executed commands with exits; a report quoting the packet's delta instead of measuring is not a measurement — send it back.
- **Setup shown** — "suite would not start" is acceptable only with the attempted install/build commands and output; otherwise it is skipped setup — send it back.
- **Weakening is an honesty trigger** — a non-empty enumeration not literally demanded by the issue body, or a count drop the enumeration does not explain (hidden weakening), routes to retry under the test-weakening trigger of `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`. Apply the same file's stale-baseline exception to pure count drift explained by base movement.
- **Cross-check iteration's claim** — the packet's test-inventory delta line must agree with this report; a mismatch is a packet credibility failure feeding retry.
