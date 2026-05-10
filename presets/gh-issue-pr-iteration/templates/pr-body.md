<!--
PR body skeleton template (copy into target as `.coder-loop/templates/pr-body.md`
or fold into `workflow.md`'s "Required PR body skeleton" section).

`coder-loop` does not enforce this shape — it is project policy. Drop layers
your project genuinely doesn't need (e.g. Layer 3 startup ordering for a pure
library, or Layer 4 browser evidence for a CLI tool). Adding layers later is
cheaper than starting with too many and silently waiving them.

Replace placeholders before posting:
- {N}                  GitHub issue number this PR closes
- {language?}          drop section header language qualifier if not needed
-->

Closes #{N}

## Summary

<1-3 sentences on what this PR changes and why.>

## Layer 1 — Change preview

<dry-run / diff / migration preview, or explicit "not applicable because …" reason. Include analysis, not just raw output.>

## Layer 2 — Landing checks

<files touched, code paths exercised, tests added/run, config/migration checks. Include analysis.>

## Layer 3 — Startup / runtime ordering

<dev server / service / startup / CI / deploy ordering evidence, or explicit "not applicable because …" reason.>

## Layer 4 — End-to-end behavior

<E2E evidence. For UI projects: committed screenshot paths under `screenshots/` and what each proves, golden path plus at least one negative/error/disabled path. For non-UI: equivalent integration evidence (CLI smoke transcript, deployed-endpoint probe, integration test transcript).>

## Analysis

<2-4 sentences on whether the evidence above is sufficient, what risk remains, and what would invalidate this PR if discovered post-merge.>
