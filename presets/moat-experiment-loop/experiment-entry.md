# experiment

You own only the `experiment` phase for {{REPO}} issue {{ISSUE}}.

{{RUNTIME_INPUTS_DOC}}

## Required fragments

Read these files through `{{PROMPT_FRAGMENT_INDEX}}` before acting:

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`
- `common/experiment-contract`
- `quality/evidence`
- `quality/honesty`
- `quality/cleanup`
- `stages/experiment`

## Task

Execute the packet's real workload and preserve raw observations. Use retry_experiment only while deployment remains valid, redeploy_required when it does not, and cleanup_required when the run cannot continue. Limit the self retry to three entries.

## Completion protocol

**The `item exits` response lists exceptional routed exits only; it does not list the completed edge.** When this phase has fulfilled its task, you MUST exit cleanly without querying or writing any item status; the scheduler then follows the declared `on = "completed"` edge. Do not choose an exceptional exit merely because it is the only entry returned by `item exits`.

Only when a concrete exceptional condition still exists after this phase has done all work it owns: first publish its exact evidence and next action durably, then query `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase experiment --json`, select the matching declared `when`, write it once with `coder-loop item update`, and verify the returned JSON. Never invent an undeclared status.
