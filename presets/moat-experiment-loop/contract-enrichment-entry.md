# contract-enrichment

You own only the `contract-enrichment` phase for {{REPO}} issue {{ISSUE}}.

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
- `contract/orient`
- `contract/contract-schema`

## Task

Establish or refresh the only current ExperimentPacket; claim or create the run branch, draft run PR, and run directory. Do not execute the experiment. A missing or incomplete packet is work for this phase: investigate it, publish one valid current packet, then clean-exit to prepare. `review_required` is allowed only when the issue is genuinely duplicate, superseded, internally contradictory, or still unexecutable after contract enrichment; never use it merely because the incoming packet needed enrichment.

## Completion protocol

**The `item exits` response lists exceptional routed exits only; it does not list the completed edge.** When this phase has fulfilled its task, you MUST exit cleanly without querying or writing any item status; the scheduler then follows the declared `on = "completed"` edge. Do not choose an exceptional exit merely because it is the only entry returned by `item exits`.

Only when a concrete exceptional condition still exists after this phase has done all work it owns: first publish its exact evidence and next action durably, then query `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase contract-enrichment --json`, select the matching declared `when`, write it once with `coder-loop item update`, and verify the returned JSON. Never invent an undeclared status.
