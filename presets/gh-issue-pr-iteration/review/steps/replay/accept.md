# Acceptance: replay (review)

## Required report fields

The report must contain: `Replay strategy` with the branch/state replayed against; `Row results` table with one line per acceptance + inherited row (including could-not-execute rows with exact errors); `Packet spot-replay` (claim vs observation per replayed claim); `Checks and mergeability` with names/statuses/conclusions/timestamps/head SHA/`mergeStateStatus`; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

Judge the replay report against:

- **Row completeness** — every row of both tables appears in the results with an actual or an exact could-not-execute error. Any silently absent row invalidates the replay: send back for the missing rows.
- **Execution truth** — locally-runnable rows were executed, not artifact-waved; actuals carry exit/output, not summaries of the packet's own claims (a replay that just re-reads the packet is not a replay).
- **No verdict smuggling** — mismatches are reported raw; if the report labels mismatches "minor/cosmetic", that violates its task — the judgment is yours, and cosmetic-handwave from a replay agent gets the same hard treatment as from iteration (`/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`).
- **Checks observed, not assumed** — the checks section has concrete names/conclusions/timestamps; "CI is green" without them is a gap.
- **Side effects declared** for the cleanup ledger.

Then form your own verdict from the accepted report: all rows matched + packet claims corroborated + checks green and mergeable → contract holds; any mismatch/missing artifact/broken Command → retry (cite every failing row); checks legitimately running → retry with observe-again; environment rows with no artifact and no feasible re-execution → retry or blocked per whether iteration can fix it.
