# Acceptance: verify

## Required report fields

The report must contain: `Why this verification set`; `Row results` table covering **every** acceptance/inherited row; `Test inventory delta` with both counts, commands, and the enumeration (explicit `none` allowed); `CI parity` (ran, or exact blocker); `Workflow commands`; `Artifacts` mapped to what each proves; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Row coverage** — every acceptance/inherited row appears with an actual result, or an explicit environment deviation plus the alternative proof. A row absent from the table is a gap, full stop.
- **Mismatch honesty** — mismatching rows reported as mismatches, not rationalized (cosmetic-handwave is a hard fail per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`). A mismatch routes back to implementation — verification passing is not the goal; the contract holding is.
- **Test inventory delta** — present and consistent with the implement report's test-changes enumeration; an unexplained non-empty delta routes back to implementation, not into the packet.
- **Evidence quality** — apply `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-judge.md`: claim ↔ observation, no weak-signal acceptance, no synthetic artifacts, every artifact mapped to the behavior it proves.
- **CI parity present** — either parity ran with command/arch/exit/log, or an exact infrastructure blocker is recorded. "Suite passed" alone does not satisfy parity.
- **Unit tests alone never suffice** for UI/runtime/integration changes — demand the runtime-path evidence.
- **Side effects declared** — started processes and scattered files are listed (your cleanup ledger input).

Send back precise gap lists (missing rows, unproven claims, weak artifacts). If verification surfaced product failures, route the gap to a new implement dispatch, then re-dispatch verification for the full contract — not just the failed row.
