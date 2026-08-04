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
| `{{PRESET_ROOT}}` | Engine-owned template token that preset source md files use for cross-file references (e.g. `{{PRESET_ROOT}}/quality/evidence.md`). The compiler includes the referenced markdown in the immutable definition bundle, and the resolver replaces the token with that verified bundle's asset root. Direct one-shot compilation uses the authoring source root. It is **not** a `[steps.values]` placeholder; the placeholder validator does not see it because substitution happens at prompt read time. Do not declare `PRESET_ROOT` under `[steps.values]`. | `src/loop.ts` `substitutePresetRootToken` / definition resolver |

Review's terminal action flows through the typed phase-exits selection face (`coder-loop item exits` + `coder-loop item update --status` for item-status exits; `coder-loop item exit-action --action stop` for chain-action exits). No stdout-derived flow word carries engine semantics; stdout occurrences of `verdict=` produce zero engine effect.

## Preset-Declared Strings

Presets currently declare no stdout control strings. The engine does not
read any per-phase stdout marker. Process recycling is armed by the daemon
on admissible-status writes and never by stdout content. Any informational summary line an author writes into an entry
prompt is just prose for downstream readers — the engine does not parse
it, and no such literal is a reserved string.

## Maintenance

- Update this table in the same PR that adds, removes, or renames an engine
  marker/sentinel or preset-declared marker that may appear in agent stdout.
- Update `presets/gh-issue-pr-iteration/contract.md` when preset issue-writing
  rules change.
- Run `bun test tests/unit/loop/runtime-bindings.test.ts` after changing this file or the marker
  declaration mechanism.
