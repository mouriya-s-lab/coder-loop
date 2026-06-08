# Reserved Strings

This file is the repository registry for literal strings that have control
semantics inside a `coder-loop` preset. Do not put these strings verbatim in
GitHub issue titles, issue bodies, or issue comments that agents will read. Link
to this file or split the token in prose when the string itself must be
discussed.

The registry is writing discipline only. It is not prompt injection defense, and
it does not replace runtime parsing.

## Engine Strings

| String | Use | Source |
|--------|-----|--------|
| `FINALIZER SUMMARY:` | Chain-complete trigger decision marker parsed after the bundled umbrella finalizer phase exits. | `src/loop.ts` `parseFinalizerSummaryDecisionFromText` |
| `decision=complete` | Finalizer summary decision that permits the chain-complete trigger to finish the chain. | `src/loop.ts` `parseFinalizerSummaryDecisionFromText` |
| `decision=keep-active` | Finalizer summary decision that keeps the chain active for remaining or uncertain umbrella scope. | `src/loop.ts` `parseFinalizerSummaryDecisionFromText` |
| `verdict=retry` | Review summary verdict that routes the item to another iteration. | `src/loop.ts` `parseReviewSummaryVerdictFromText` |
| `verdict=accepted` | Review summary verdict that accepts the PR or no-PR resolution. | `src/loop.ts` `parseReviewSummaryVerdictFromText` |
| `verdict=skip` | Review summary verdict that classifies the issue as no longer requiring work. | `src/loop.ts` `parseReviewSummaryVerdictFromText` |
| `verdict=blocked` | Review summary verdict that records an external blocker. | `src/loop.ts` `parseReviewSummaryVerdictFromText` |
| `verdict=stop` | Review summary verdict that stops the loop because review infrastructure or global state cannot safely continue. | `src/loop.ts` `parseReviewSummaryVerdictFromText` |

## Preset-Declared Strings

Post-summary watchdog stdout markers are declared with
`[[phases]].summaryMarker` in `preset.toml`. A phase without `summaryMarker`
does not enable the post-summary watchdog. The bundled `gh-issue-pr-iteration`
preset declares its phase markers in
`presets/gh-issue-pr-iteration/preset.toml`.

Preset-declared markers are not duplicated in the engine table above because
the engine reads them from preset metadata rather than owning their literal
values.

## Maintenance

- Update this table in the same PR that adds, removes, or renames an engine
  marker/sentinel or preset-declared marker that may appear in agent stdout.
- Update `templates/skills/writing-issue/SKILL.md` when the issue-writing rule
  changes.
- Run `bun test src/loop.test.ts` after changing this file or the marker
  declaration mechanism.
