# Fragment: review/caveat-honesty-gate

## Goal

Catch the failure mode where iteration honestly admits a substantive scope reduction (system-under-test not actually run on the user-facing path, asserted invariant silently weakened, mismatch rationalized as cosmetic, scope deferred to a sibling/future issue) but downstream commitment-gate still passes because each acceptance row has *some* artifact mapped to it.

This gate is the answer to `Mouriya-Emma/fulcrum#185/#186` round 1: PR #190 review handwaved `00000008` vs `0000000c` channel_id 错位 as "展示层瑕疵"; PR #191 iteration handoff openly wrote "fulcrum server did not run", "probe spawns claude via `bash -lc`, not via fulcrum's dtach/WS terminal", "deferred to wave-2 D3/D4". Both passed the existing gates because the iteration agents were honest *and* the row-to-artifact mapping was structurally complete — but the substance was missing.

Honesty in the handoff is good. Letting honest admissions of scope reduction through is the bug this gate fixes.

## When this gate runs

Always, for every iteration regardless of `ISSUE_KIND`. The pattern occurs in both code and comment issues (e.g., spike report that downgrades the spike question).

## Inputs

- PR body (latest), specifically Analysis / Notes / Caveats / Known issues sections.
- PR thread review-iteration comments for the current run (latest evidence packet posted as comment).
- Iteration handoff at `{{ISSUE_DIR}}/{{ISSUE}}.md` (the Run handoff / Iteration section the iteration agent wrote).
- Live issue body (`gh issue view {{ISSUE}} -R {{REPO}} --json body --jq .body`) — re-fetch to check whether the substitution was pre-authorized.

## Procedure

1. Concatenate the four input sources into a single review buffer for grep.

2. Scan the buffer for trigger phrases. The categories below are non-exhaustive; the rule is "any phrasing semantically equivalent to one of these categories triggers the gate". Do not require literal string match.

   **A. System-under-test path bypass.** Phrases that admit the path being tested is not the path the user / acceptance row demands:
   - "fulcrum server did not run", "did not start the server", "server was not running"
   - "via `bash -lc`" / "spawned via shell" when the issue demands the agent's normal runtime path
   - "not via [intended path / dtach / WS terminal / dev server]"
   - "probed in isolation", "simulated in a driver script", "synthetic harness"
   - "would be exercised by [other surface], not tested here"

   **B. Invariant downgrade.** Phrases that admit the assertion checked is weaker than the row's Expect column:
   - "verified via X, not literal Y"
   - "approximated by", "checked the prefix relationship instead of"
   - "fallback acceptance", "weaker but related invariant"
   - "treated as equivalent because [reason]" — when the row's Expect demands literal equality

   **C. Cosmetic handwave.** Phrases that rationalize an observed mismatch as not affecting acceptance:
   - "展示层瑕疵", "presentation-layer only", "cosmetic", "display-only"
   - "doesn't affect substantive acceptance", "不影响 substantive acceptance"
   - "minor mismatch", "off by [N]", "off-by-one ID" — when the acceptance row required exact match

   **D. Cross-issue scope deferral.** Phrases that move part of this issue's scope to a sibling/future issue mid-iteration:
   - "deferred to [wave-N / issue #N / D3 / D4]"
   - "out of scope for this issue, see [N]"
   - "covered by [other issue]" — when the other issue is not a declared dependency / blocked-by in the issue body

   **E. Environment-precondition admission.** Phrases that admit a precondition the issue body required was not present:
   - "[required service] was not running / not available / not installed"
   - "could not reach [target]; used [substitute] instead"
   - "skipped [precondition] step because [reason]"

3. For each trigger hit:
   - Quote the exact phrase + which input source it came from.
   - Locate the specific acceptance row (from `## 验收标准` or the issue body's acceptance bullets) whose substance is undermined by the admission.
   - Check the live issue body for explicit authorization of the substitution (e.g., body says "PM probe may run outside fulcrum dtach for this acceptance"). If the body authorizes it, the trigger does not fail this gate — note it as `authorized_substitution`.
   - If unauthorized, the trigger is a hard fail.

4. Cosmetic-handwave (category C) is uniformly a hard fail. Even if a reviewer-author judges the mismatch trivial, that judgment is exactly the rationalization this gate exists to prevent. The fix is not to wave it through; the fix is for the iteration to make the artifact match the acceptance row, or for the issue body to be revised (separately, before retry) to weaken the row.

## Output verdict

Choose exactly one:

- `caveat_honesty_passed` → read `review/commitment-gate`. No trigger phrases found, or every trigger was matched by explicit pre-authorization in the issue body.
- `caveat_honesty_failed` → read `review/action-retry`. Emit a retry-feedback block listing every trigger (verbatim quote + source file + affected acceptance row + why it's not authorized). The retry must address all triggers — either by re-doing the probe on the demanded path, by tightening the invariant check, by removing the cosmetic-handwave language and resolving the actual mismatch, or by first opening a separate issue / amendment to the body if the scope reduction is truly necessary.

## Anti-rationalization rule for this gate itself

The reviewer running this gate must not promote a triggered phrase to `authorized_substitution` based on its own reading of "what the issue probably meant". Authorization must be a literal sentence in the live issue body that names the substitution. If the body is silent on the substitution, the gate fails.

## Why this gate exists separately from commitment-gate

Commitment-gate verifies the row-to-artifact mapping is *structurally* complete (every row has some artifact). It cannot detect that the artifact silently checks a weaker invariant than the row demanded. That semantic check is what this gate adds.

Putting it before commitment-gate means commitment-gate's row execution is run against a buffer the reviewer has already confirmed contains no scope-reduction admissions — so when commitment-gate says "row 5 passed", it really means the row's full assertion passed, not "the row's downgraded variant passed".
