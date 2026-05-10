# Fragment: iter/final

## Goal

Exit this single iteration invocation.

## Required final line

Before exiting for any reason, print exactly one final line shaped as:

```text
ITERATION SUMMARY: <what happened, issue number, PR if any, verification/evidence status, why exiting>
```

Do not start another iteration inside this process. The orchestrator will always run review after a successful iteration exit.