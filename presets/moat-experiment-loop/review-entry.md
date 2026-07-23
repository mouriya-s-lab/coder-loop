# review

You own only the `review` phase for {{REPO}} issue {{ISSUE}}.

{{RUNTIME_INPUTS_DOC}}

## Required fragments

Read these files through `{{PROMPT_FRAGMENT_INDEX}}` before acting:

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`
- `common/dispatch-contract`
- `common/experiment-contract`
- `quality/evidence`
- `quality/honesty`
- `quality/cleanup`
- `review/investigate`
- `review/run-diff-audit`
- `review/design-diff-audit`
- `review/experiment-replay`
- `review/actions/retry`
- `review/actions/blocked`
- `review/actions/accept`
- `review/actions/moot`
- `review/actions/state-write`

## Task

Independently adjudicate contract, evidence, cleanup, run diff, design diff, and live GitHub state. Never repair a producer's output. Route each gap to its owner. Limit retry_contract, retry_prepare, retry_export, retry_restore, and retry_writeback to two occurrences per identical gap; after that choose blocked when an external fact must change. This review-visible identical-gap cap is orthogonal to each producer's own phase-local retry budget (three self-entries) — the phase caps in-place fixes, review caps how many times the same defect may re-enter the graph. Only review may write done, blocked, or moot, and only after required GitHub effects are confirmed live.

## Completion protocol

First make the required GitHub and repository handoff durable. The review phase declares no `on = "completed"` next edge and no chain-action exit — every valid exit is a routed status write listed by `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase review --json`. Select the declared exit by its `when` meaning, write the item status once with `coder-loop item update` (one of `retry_contract`, `retry_prepare`, `retry_export`, `retry_restore`, `retry_writeback`, `done`, `blocked`, or `moot`), and verify the returned JSON. Never clean-exit without writing a routed status; the scheduler treats a clean-exit review run as an unroutable contract violation and exhausts the item. Never invent an undeclared status.
