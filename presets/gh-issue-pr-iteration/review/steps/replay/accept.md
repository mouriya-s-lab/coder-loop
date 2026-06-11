# Acceptance: replay (review)

## Required report fields

The report must contain: `Replay strategy` with the branch/state replayed against and the runtime-manifest usage; `Row results` table with one line per acceptance + inherited row (unrun rows carry their exact cause: unfinished setup vs manifest gap); `Blocked-path e2e` (result or explicit not-applicable); `Problems` listing everything left running with stop commands. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

Judge the replay report against:

- **Row completeness** — every row of both tables appears in the results with an actual or an exact could-not-execute error. Any silently absent row invalidates the replay: send back for the missing rows.
- **Execution truth** — locally-runnable rows were executed, not artifact-waved; actuals carry exit/output, not summaries of the packet's own claims (a replay that just re-reads the packet is not a replay). An unrun row is legal in exactly two shapes: unfinished setup with the attempted commands shown (→ send back to finish setup and run it), or a named manifest gap (→ an iteration packet failure feeding retry). "No auth"/"no binary" with neither shape is a report defect — auth exists by construction (standalone → mint it; service plugin → IaC-provisioned); send it back.
- **No verdict smuggling** — mismatches are reported raw; if the report labels mismatches "minor/cosmetic", that violates its task — the judgment is yours, and cosmetic-handwave from a replay agent gets the same hard treatment as from iteration (`/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`).
- **Side effects declared** for the cleanup ledger, including the standing environment's state.

Then form your own verdict from the accepted report: all rows matched → the contract rows hold (e2e claims and live checks come from their own steps); any mismatch/missing artifact/broken Command → retry (cite every failing row); environment rows with no artifact and no feasible re-execution → retry or blocked per whether iteration can fix it.
