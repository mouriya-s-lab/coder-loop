# Acceptance: verify

## Required report fields

The report must contain: `Why this verification set`; `Row results` table covering **every** acceptance/inherited row (browser rows present with verdict `deferred: e2e step`); `Test inventory delta` with both counts, commands, the scratch-worktree note for the base side, and the enumeration (explicit `none` allowed); `CI parity` (ran, or exact blocker); `Workflow commands`; `Artifacts` mapped to what each proves; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Row coverage** — every acceptance/inherited row appears with an actual result, a `deferred: e2e step` verdict (browser rows only — anything else deferred is a gap), or an explicit environment deviation plus the alternative proof. A row absent from the table is a gap, full stop. Deferred browser rows are not done: carry them into the e2e line's `Step focus` and judge them from that step's report.
- **Mismatch honesty** — mismatching rows reported as mismatches, not rationalized (cosmetic-handwave is a hard fail per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`). A mismatch routes back to implementation — verification passing is not the goal; the contract holding is.
- **Test inventory delta** — present, base side measured in a removed scratch worktree (a delta with no base command, or measured by switching the issue branch away, is a defect), and consistent with the implement report's test-changes enumeration; an unexplained non-empty delta routes back to implementation, not into the packet.
- **Evidence quality** — apply `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-judge.md`: claim ↔ observation, no weak-signal acceptance, no synthetic artifacts, every artifact mapped to the behavior it proves.
- **CI parity present** — either parity ran with command/arch/exit/log, or an exact infrastructure blocker is recorded. "Suite passed" alone does not satisfy parity.
- **Side effects declared** — processes and temp files listed for the cleanup ledger (the scratch worktree confirmed removed).

Send back precise gap lists (missing rows, unproven claims, weak artifacts). If verification surfaced product failures, route the gap to a new implement dispatch, then re-dispatch verification for the full contract — not just the failed row.
