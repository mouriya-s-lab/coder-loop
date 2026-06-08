# Fragment: iter/final

## Goal

Exit this single iteration invocation.

## Declare your status before exiting

Iteration does not write item status. The scheduler uses its run ledger to advance from this phase to review after your process exits. Do not write `done`, `moot`, `blocked`, `changes_requested`, or `in_progress` from iteration — those are review outcomes or obsolete handoff statuses.

## Required final line

Before exiting for any reason, print exactly one final line shaped as:

```text
ITERATION SUMMARY: <what happened, issue number, PR if any, verification/evidence status, why exiting>
```

Do not start another iteration inside this process. The orchestrator will always run review after a successful iteration exit.
