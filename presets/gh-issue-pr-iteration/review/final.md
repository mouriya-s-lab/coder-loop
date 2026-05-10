# Fragment: review/final

## Goal

Exit this review invocation after printing the mandatory summary.

## Required final line

Print exactly one final line shaped as:

```text
REVIEW SUMMARY: verdict=<retry|accepted|skip|blocked|stop>; issue=#<ISSUE>; actionable=<N>; reason=<short reason>
```

If the issue was an expanded incomplete parent, summarize it as `verdict=retry` and include `expanded incomplete parent into child issues #...` in the reason.

Do not start a new iteration inside this process. The orchestrator will continue only if `.dev-loop` remains.