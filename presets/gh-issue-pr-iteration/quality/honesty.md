# Quality: honesty

Statement-truthfulness rules — bind executor claims and orchestrator judgment as one contract.

## Executor: how to claim

- **Report observations, not expectations.** Success wording ("passed", "works", "verified", "done") may only describe results actually executed and observed this run. "Should work", "logically correct", and memory of a previous run are not observations.
- **Declare intent before acting; declare the delta after.** Substantive work states its intent (understanding of the task, planned scope, known uncertainties) before execution, and afterwards states the delta between intent and what actually happened. Write the delta rather than editing intent to match the outcome — the intent block is your working log for review to compare against.
- **Admit gaps.** Anything not done, partially done, uncertain, or substituted goes in the problems section. An honest admission is always cheaper than a discovered omission — admission does not make the gap acceptable (the orchestrator decides that).

## Orchestrator: claim-vs-observation audit

For every success claim in a report or evidence packet, locate the observation that backs it (command, exit, output, artifact). Claimed-but-unobserved = the claim is false. Typical forms: claims tests passed but no command output exists; claims a PR/comment was posted but the live object does not exist; claims browser evidence but no readable screenshot; claims blocked but the obvious next command was never attempted.

## Scope-reduction triggers

Scan reports, PR body/comments, and handoff for admissions that the substance was reduced even though the surface looks complete. Semantic equivalence triggers the category — honest admission does not neutralize the trigger.

For the retry-comment and PR-body caveat sections (the sections where these phrases live), quote the trigger sentence verbatim with source (file/URL + location); scope-reduction judgment does not survive paraphrase. Everywhere else, summary is fine.

- **Path bypass** — the tested path is not the path the task demands: "server did not run", "spawned via shell, not via the intended runtime", "probed in isolation", "synthetic harness", "would be exercised by [other surface], not tested here".
- **Invariant downgrade** — the checked assertion is weaker than demanded: "verified via X, not literal Y", "approximated by", "checked the prefix relationship instead of", "treated as equivalent because…" when literal equality was required.
- **Cosmetic handwave** — an observed mismatch rationalized as not mattering: "presentation-layer only", "展示层瑕疵", "cosmetic", "minor mismatch", "off-by-one ID" when exact match was required. **Uniformly a hard fail** — the judgment that a mismatch is trivial is exactly the rationalization this rule exists to prevent.
- **Cross-issue deferral** — part of this task's scope moved mid-run to a sibling/future issue that is not a declared dependency: "deferred to wave-N / issue #N", "out of scope for this issue, see #N".
- **Precondition admission** — a required precondition was absent: "[required service] was not running", "could not reach [target]; used [substitute]", "skipped [precondition] because…".
- **Intent-action mismatch** — the declared intent and the actual change footprint do not correspond and the delta is undisclosed: intent named scope X but action touched meaningfully different Y; "research-only" intent but substantive code change (or vice versa); intent absent entirely on a substantive change. This is a substance judgment ("would a reasonable engineer say these correspond?"), not string matching. Honestly disclosed trivial drift is not a trigger.
- **Test weakening** — tests removed, skipped, loosened, or rewritten to pass without the marker packet Test delta authorizing that specific change. A non-empty test-inventory delta outside that authorization is this trigger, regardless of how the surrounding prose justifies it.

## Authorization rule

A trigger is excused only when the current marker packet explicitly authorizes that specific substitution in Test delta. Do not promote a trigger to "authorized" from your own reading of what the issue probably meant. Marker silent → the trigger stands.

**Stale-baseline exception.** A literal numeric or version expectation inside an acceptance row (test pass counts, dependency versions, line numbers) that no longer matches reality **because the base branch moved after the issue was written** is contract drift, not scope reduction. Condition: an independent measurement of the same command on the current base branch shows the same new value, and the branch introduces no regression relative to that fresh baseline. When the condition holds, accept on fresh-baseline parity and note the stale literal in the closure comment — do not demand issue-body authorization and do not bounce retries over the literal. When provenance cannot be shown (no fresh base measurement), the trigger stands.

## Intent/Result scope check

Review compares the iter-written `Intent (run …)` block against the matching `Result (run …)` block and the diff-audit's change footprint. Reduced scope between intent and result — implementation surface narrower than declared, sites intent named as touched but result silently dropped, extra sites the intent did not anticipate — is an intent-action mismatch trigger unless the result block itself discloses the drift with a reason.
