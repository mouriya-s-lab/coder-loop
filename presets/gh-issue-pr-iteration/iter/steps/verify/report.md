# Report template: verify

Structure your final message exactly as below. Every section and field is required; write `none` for empty sets — never omit a field.

```markdown
## Why this verification set
<which checks you chose and why they cover the issue contract; what you deliberately
did not run and why>

## Row results
| Row | Command | Exit | Actual vs Expect | Verdict |
|---|---|---|---|---|
<one line per acceptance + inherited row — every row, including environment deviations
(state the alternative proof in the Actual column)>

## Test inventory delta
base=<count> (<command>) head=<count> (<command>)
Removed/renamed/skipped/weakened: <enumerated list or `none`>

## CI parity
<detection result; parity command + arch + exit + log path — or the exact infrastructure
blocker (command, failure mode, exit, excerpt)>

## Workflow commands
<per command: command + exit + concise excerpt>

## Artifacts
<path → what it proves, one line each>

## Problems
<failures and hangs observed; rows that could not run (with the alternative produced);
processes started (PIDs / log paths); files written outside EVIDENCE_DIR — or `none` per item>
```
