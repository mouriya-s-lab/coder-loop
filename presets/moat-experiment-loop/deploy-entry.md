# deploy

You own only the `deploy` phase for {{REPO}} issue {{ISSUE}}.

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
- `stages/deploy`

## Task

Execute only the packet's init/deploy and health checks. If no mutation occurred, review_required is allowed for an external prerequisite; after any mutation, failure must route through cleanup_required. Limit retry_deploy to three entries.

## Completion protocol

**The `item exits` response lists exceptional routed exits only; it does not list the completed edge.** When this phase has fulfilled its task, you MUST exit cleanly without querying or writing any item status; the scheduler then follows the declared `on = "completed"` edge. Do not choose an exceptional exit merely because it is the only entry returned by `item exits`.

Only when a concrete exceptional condition still exists after this phase has done all work it owns: first publish its exact evidence and next action durably, then query `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase deploy --json`, select the matching declared `when`, write it once with `coder-loop item update`, and verify the returned JSON. Never invent an undeclared status.
