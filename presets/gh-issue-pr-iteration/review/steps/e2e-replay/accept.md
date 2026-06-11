# Acceptance: e2e-replay (review)

## Required report fields

The report must contain: `Environment reached`; `E2E re-drive` table with per-claim re-drive method, observation, and match; `Browser acceptance rows` covering every row the replay report deferred (cross-check against that report's `deferred: e2e-replay` verdicts yourself); `Form check`; `Other claims replayed`; `Problems` listing everything left running with stop commands. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Re-driven, not corroborated** — every e2e claim shows the subagent's own direct re-drive (operator-style invocation or agent-browser walk) with its own artifacts; accepting the packet's screenshots/transcripts as the observation is not a replay — send it back.
- **Deferred rows closed** — every browser row the replay report deferred appears with an observed-vs-Expect verdict from the real UI walk; these are contract rows, so a failing row routes to retry exactly like a failing replay row, and an absent row leaves the contract unverified — send it back.
- **No auth/binary excuse** — auth exists by construction (two-case rule of `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md`); an unre-driven claim is legal only as unfinished-setup-with-attempts-shown or a named manifest gap. Anything else → send back.
- **Manifest gaps are packet failures** — they feed retry charged to iteration, never excuse the review.
- **Script e2e flagged** — a form-check finding of script-produced e2e is a packet failure → retry, even when the re-drive itself passed.
- **No verdict smuggling** — mismatches reported raw; "minor"/"cosmetic" labels are a report defect — send it back (`/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md` treats cosmetic-handwave as a hard fail).
