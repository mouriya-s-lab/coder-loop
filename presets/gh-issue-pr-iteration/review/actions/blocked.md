# Action: blocked

Record a real external dependency that prevents progress. Use only when evidence proves a required dependency is unavailable and an immediate rerun cannot create it — the relevant command/query must have been attempted and recorded. Examples: required binary absent; external service unreachable; credentials/access missing; environment unprovisionable from this loop. Weak evidence, failed tests, bad code, PR conflicts, pending checks, missing screenshots are **not** blockers — they are retry.

## Feedback target

Comment on the PR if one exists and the blocker concerns its implementation/verification; otherwise on the issue.

## Required metadata block

```text
blockerRepo: owner/repo
blockerRef: #123
```

`blockerRepo`: the blocking repository (`owner/repo`; current `REPO` if in-repo). `blockerRef`: the blocking issue (`#123` / `owner/repo#123`) or a concise condition string when no concrete issue exists.

## After

Blocker durably posted → write state per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md` with transition `blocked` (the `blocker` keys flow through `--field-json '{"extraPatch":{"blockerRepo":...,"blockerRef":...}}'` since #457). Publication failed → do not write local state as if the blocker were durable; take the stop action.
