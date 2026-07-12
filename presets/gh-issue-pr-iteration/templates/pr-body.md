<!--
PR body skeleton template (reference; fold into the project's `CLAUDE.md` /
`AGENTS.md` PR-conventions section if your repo wants the skeleton checked in).

This is the bundled preset's required packet shape. Keep all four headings;
when a layer is genuinely inapplicable, state why and cite the current
executable-contract marker rather than dropping the layer.

Replace placeholders before posting:
- {N}                  GitHub issue number this PR closes
- {CONTRACT_URL}       unique current executable-contract marker comment
- {CONTRACT_SCHEMA}    marker schema version
- {SOURCE_REVISION}    intent revision recorded by enrichment
- {language?}          drop section header language qualifier if not needed
-->

Closes #{N}

## Summary

<1-3 sentences on what this PR changes and why.>

Executable contract: {CONTRACT_URL} (`schema={CONTRACT_SCHEMA}`, source revision `{SOURCE_REVISION}`)

## Layer 1 — Change preview

<dry-run / diff / migration preview. Map claims to executable-contract Check IDs and Pattern/Test-delta rules.>

## Layer 2 — Landing checks

<files touched, code paths exercised, tests added/run, config/migration checks. Map each result to Check IDs.>

## Layer 3 — Startup / runtime ordering

<setup/start/readiness/log/stop evidence from the marker's Canonical runtime, or a marker-cited not-applicable reason.>

## Layer 4 — End-to-end behavior

<Run the target-mandated real driver named by Canonical runtime. It may be a repository script when that script is the target's real driver. Record invocation, exit, observed behavior and artifacts; for browser Checks map actions/observations to their Check IDs.>

## Analysis

<2-4 sentences on whether the evidence above is sufficient, what risk remains, and what would invalidate this PR if discovered post-merge.>
