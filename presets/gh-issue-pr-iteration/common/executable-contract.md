# Executable contract authority

Before dispatching or judging work, fetch every issue comment and locate comments whose first line is `<!-- coder-loop:executable-contract schema=1 source-issue=<current issue> -->`.

Exactly one marker may be current: a later marker may supersede an earlier one only by linking it in `Supersedes`. Reject a missing marker, two unsuperseded markers, an unknown schema/variant, a source revision older than a later operator correction, or any missing required section. Do not silently fall back to treating the issue body as an executable checklist.

Use the issue body and later operator comments for intent. Use the current marker packet for literal checks, Pattern scope, canonical runtime/E2E, test-delta authorization, deliverable route and verified dependencies. PR review feedback may demand implementation correction but cannot rewrite either source without attribution.
