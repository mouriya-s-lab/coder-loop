# Quality: evidence — orchestrator judgment

Judgment criteria for evidence produced by executor subagents. This file is orchestrator-facing; executors never read it (their constraints live in `evidence-execute.md`, the same rule set enforced from the other side).

Judge an executor report or evidence packet against these criteria. Any miss is a gap to send back; do not rationalize.

- **Claim ↔ observation.** Every claim of success must map to an actually-executed command with exit status and output (or an artifact). A claim without its observation is a gap, not a formality.
- **Weak signals are not acceptance.** Bare status bits (`is-active: active`, HTTP 200 without body analysis), framework completion lines (`Apply complete!`, `Build succeeded`), whole-suite pass counts, and type-check/build success prove tooling ran — not that the issue's behavior holds on the real path. They may support Layer 2 style landing checks; they never satisfy end-to-end behavior.
- **Synthetic evidence is rejected.** Screenshots of locally rendered HTML/logs/data; text that should have been pasted but was screenshotted; evidence whose content could have been produced without the real system running.
- **Mapping required.** Each artifact or log excerpt must be tied to the specific behavior or acceptance row it proves. An unmapped pile of logs is not an evidence packet.
- **Inspectability.** Evidence that is missing, stale (only exists on main / deleted branches), local-only when review must consume it from GitHub, or impossible to open is insufficient — regardless of how plausible the surrounding prose is.
- **Real-path substitution check.** If the report admits the real path was not exercised, the corresponding acceptance rows are unmet, no matter how complete the rest of the packet looks.
- **Test-inventory delta present.** A report covering a test-suite run without the base-vs-branch test inventory delta (counts plus removed/renamed/skipped/weakened list, even when empty) is incomplete — send it back. A non-empty delta is not automatically a failure; it must be justified by the issue contract (judged under the honesty rules).
