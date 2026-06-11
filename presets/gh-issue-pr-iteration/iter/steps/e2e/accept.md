# Acceptance: e2e

## Required report fields

The report must contain: `E2E run` with surface, setup (auth by resolution location), the real entry driven, and observed behavior; `Browser acceptance rows` covering every row the verify step deferred (cross-check against the verify report's deferred rows yourself); `Runtime manifest` including the standing environment; `Artifacts` mapped to what each proves; `Problems`. Structurally incomplete → send back the missing fields before judging substance.

## Judgment

- **Direct or absent** — the `E2E run` section must show the real entry point driven (operator-style program invocation, or an agent-browser walk of the real UI) with this run's own artifacts. A script/harness presented as e2e is integration testing — treat the e2e as missing and send it back. Unit/integration results never substitute; "no auth"/"no binary" never excuses (evidence-execute's two-case rule guarantees auth exists — a report claiming otherwise has skipped setup; send it back with the setup it owes).
- **Deferred rows closed** — every browser row the verify report deferred appears here with an observed-vs-Expect verdict from the real UI walk. A failing row is a product failure: route it back to implementation, then re-dispatch verify and e2e for the full contract. A deferred row absent from this report leaves the contract unverified — send it back.
- **Manifest re-runnable** — judge it by one question: could the review side re-run this e2e from the manifest alone (binaries, services, auth resolution locations, ports, standing PIDs/stop commands)? Vague entries ("auth: configured") or secret values pasted inline are both gaps — secret values are a hard gap per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-judge.md`.
- **Mismatch honesty** — mismatches reported raw; cosmetic-handwave is a hard fail per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md`.
- **Standing environment documented, not torn down** — the runtime stays up for review; a report that killed it (or omits its PIDs/stop commands) recreates the "review couldn't run it" failure — send it back to restart and document.
