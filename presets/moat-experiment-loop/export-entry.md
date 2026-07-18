# export

You own only the `export` phase for {{REPO}} issue {{ISSUE}}.

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
- `stages/export`

## Task

Export raw evidence, transcript, manifest, logs, and provenance without rewriting observations. Verify referenced files are committed, present, and non-empty. Limit retry_export to three entries; otherwise cleanup_required.

## Completion protocol

**The `item exits` response lists exceptional routed exits only; it does not list the completed edge.** When this phase has fulfilled its task, you MUST exit cleanly without querying or writing any item status; the scheduler then follows the declared `on = "completed"` edge. Do not choose an exceptional exit merely because it is the only entry returned by `item exits`.

Only when a concrete exceptional condition still exists after this phase has done all work it owns: first publish its exact evidence and next action durably, then query `coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase export --json`, select the matching declared `when`, write it once with `coder-loop item update`, and verify the returned JSON. Never invent an undeclared status.
