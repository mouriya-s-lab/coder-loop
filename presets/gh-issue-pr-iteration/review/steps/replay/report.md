# Report template: replay (review)

Structure your final message exactly as:

```markdown
## Replay strategy
<branch/state replayed against; how the runtime manifest was used (which entries, what
the standing environment provided); which rows ran locally vs were artifact-verified vs
re-executed in their environment; what could not be attempted and why>

## Row results
| Row | Check | Command/artifact | Actual (exit/output/ref) | Expect | Verdict |
|---|---|---|---|---|---|
<one line per acceptance + inherited row — every row: browser rows carry verdict
`deferred: e2e-replay`; could-not-execute rows carry their exact cause>

## Blocked-path e2e
<the named command + exit + output — or `not applicable (Step focus named none)`>

## Problems
<unrun rows with their two-shape cause (unfinished setup with attempts shown / named
manifest gap); everything left running — own processes and the standing environment —
with stop commands, for the orchestrator's sweep>
```
