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
- `review/actions/stop`
- `review/actions/state-write`

## Task

Independently adjudicate contract, evidence, cleanup, run diff, design diff, and live GitHub state. Never repair a producer's output. Route each gap to its owner. Limit retry_contract, retry_prepare, retry_export, retry_restore, and retry_writeback to two occurrences per identical gap; after that choose blocked when an external fact must change. Only review may write done, blocked, or moot, and only after required GitHub effects are confirmed live.

## Completion protocol

First make the required GitHub and repository handoff durable. The review phase declares no `on = "completed"` next edge — every valid exit is a routed status write or the declared `stop` chain-action listed by `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase review --json`. Select the declared exit by its `when` meaning, then either write the item status once with `coder-loop item update` (for `retry_contract`, `retry_prepare`, `retry_export`, `retry_restore`, `retry_writeback`, `done`, `blocked`, or `moot`) or invoke `coder-loop item exit-action --action stop` (for the `stop` chain-action exit), and verify the returned JSON. Never clean-exit without writing a routed status or selecting a chain-action; the scheduler treats a clean-exit review run as an unroutable contract violation and exhausts the item. Never invent an undeclared status.
