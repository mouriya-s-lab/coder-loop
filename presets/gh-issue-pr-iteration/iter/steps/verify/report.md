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

## E2E run
Surface: program / web / consuming-surface-of-library
Entry driven: <the real command invoked as an operator would / the agent-browser path walked>
Observed: <the end-to-end behavior seen, with transcript/log/screenshot artifact paths>

## Runtime manifest
Binaries: <name + how installed — or `none beyond toolchain`>
Services: <start command per service — or `none`>
Auth: <resolution location only (keychain entry / config path) — never the secret value — or `none`>
Ports/env/fixtures: <list or `none`>
Standing environment: <PID + port + log path + stop command per process left up — or `none`>

## Artifacts
<path → what it proves, one line each>

## Problems
<failures and hangs observed; rows that could not run (with the alternative produced);
processes started (PIDs / log paths); files written outside EVIDENCE_DIR — or `none` per item>
```
