# Fragment: iter/final

## Goal

Exit this single iteration invocation.

## Declare your status before exiting

The scheduler does not infer your status from this output — it reads the status you wrote to the item. Iteration is never a terminal phase, so the only status you may write is the actionable `in_progress`, which hands the item off to review:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status in_progress
```

Run it once when you have advanced the work (branch/PR/evidence updated) and are handing off to review. Do not write `done`, `moot`, `blocked`, or `changes_requested` from iteration — those are review's to write (see `iter-entry.md`). If you could not advance the work, still leave the item `in_progress`; review will inspect the incomplete state and decide retry vs. block.

## Required final line

Before exiting for any reason, print exactly one final line shaped as:

```text
ITERATION SUMMARY: <what happened, issue number, PR if any, verification/evidence status, why exiting>
```

Do not start another iteration inside this process. The orchestrator will always run review after a successful iteration exit.