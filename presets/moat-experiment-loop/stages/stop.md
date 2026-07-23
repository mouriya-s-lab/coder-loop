# Stop chain action

`restore` is the only phase in this preset that declares `chainAction = "stop"`. Choose it only when restore itself cannot complete automatically or a required irreversible GitHub effect fails, and operator recovery is the sole path forward.

Before invoking the action, publish the exact current state, residual mutations, safe operator commands, and re-entry condition on the durable GitHub handoff. Then invoke the declared stop with `coder-loop item exit-action {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase restore --action stop`, and verify from its JSON that the chain stopped. Never write a terminal success alongside stop, and never write a routed item status in the same run.
