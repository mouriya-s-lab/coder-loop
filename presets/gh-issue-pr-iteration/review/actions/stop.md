# Action: stop chain

Stop the chain for mechanical completion or review infrastructure failure. Use only when: no actionable queue item exists and global assessment confirms completion; review infrastructure is broken and state cannot be safely audited/updated; the trace or required runtime files are unavailable and continuing would tight-loop or corrupt state; or a required GitHub side effect failed before durable feedback/closure/linking/unblock was published, so local state must not advance as if it succeeded.

Never use stop for bad code, weak evidence, failed tests, PR conflicts, pending checks, merge failure, or unproven blocked/skip claims — those are retry or blocked.

## Procedure

- State readable → record the actionable/non-actionable classification before stopping.
- State unreadable → record the exact infrastructure failure.
- For an accepted-but-unpublished side-effect failure: append a handoff note with the accepted outcome, failed command, target repo/PR/issue, command output, and why rerunning would hit the same boundary.
- Do not mark the selected issue `done` / `moot` / `blocked` unless the corresponding action already proved and performed that transition.

## Final write — chain-action exit

Stop the chain through the typed phase-exits selection face — the only controlled channel for an agent to stop the chain it owns. Direct `coder-loop chain stop` calls from an agent are rejected (#409); the engine accepts the stop only when it arrives through this exit:

```
coder-loop item exit-action <CHAIN> --item <ISSUE> --agent-run-id <RUN_ID> --agent-phase review --action stop
```

The engine maps this selection to the same code path operator `chain stop` runs: scheduler stops selecting new items from this chain, chain status is set to `stopped`, in-flight runs naturally complete, `chain resume` reversibly restores active status. No item terminal status is written by this action — chain stop is a chain-level side effect, not an item verdict.
