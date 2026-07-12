# Judgment guide: source-writing spike audit (source-writing-spike-deliverable)

A source-writing-spike-deliverable issue produces a no-merge spike: PoC branch, command evidence, and an issue comment. Audit it without treating it as PR-backed implementation.

## Route check first

- No PR exists → audit below.
- A PR exists for the issue → retry immediately: spike output must not be represented as an implementation PR. A route flip requires an operator intent correction followed by a superseding marker whose `Deliverable` is `implementation-pr`. Feedback goes on the issue.

## Inputs

- Live issue body + comments (re-fetch), including the unique current executable-contract marker; the run-matching comment (`Run: <RUN_ID>`).
- Handoff and evidence artifacts; pushed spike branch when named.

## Judge

1. **Comment liveness and no-merge framing** — a run-matching comment exists and explicitly states this is no-merge spike evidence, not production implementation.
2. **Branch evidence** — source changes come with spike branch + head SHA, or an explicit local-only justification.
3. **Check coverage** — every stable ID in marker `Checks` has an exit status and output/artifact reference for `shell`, or an observed result for `browser`. Where feasible, dispatch a replay to re-run the decisive marker Checks rather than trusting the comment. A malformed or intrinsically broken Check routes to contract-invalid, not implementation retry.
4. **Browser evidence** — when required and browser-observable behavior exists, it is present; otherwise an explicit scope-based not-applicable reason.
5. **Branch selection and follow-ups** — `## 结果分支`: exactly one branch selected; required follow-up titles concrete (same minimums as the spike-followup guide).

## Outcome

All satisfied → the spike is acceptable; a complete spike closes through the accept-no-PR action (`done`, not `moot`). Any miss → retry with feedback on the issue thread listing each missing element.
