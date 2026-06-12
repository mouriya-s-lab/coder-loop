# Report template: e2e

Structure your final message exactly as below. Every section and field is required; write `none` for empty sets — never omit a field.

```markdown
## E2E run
Surface: program / web / consuming-surface-of-library
Setup: <install/build/start commands + exits, including how auth was minted/resolved
(location only, never the secret value)>
Entry driven: <the real command invoked as an operator would / the agent-browser path walked>
Observed: <the end-to-end behavior seen, with transcript/log/screenshot artifact paths>

## Browser acceptance rows
| Row | Check | Driven how | Observed vs Expect | Verdict |
|---|---|---|---|---|
<one line per deferred row from Step focus — or a single row `none | - | - | - | -`
when none were deferred>

## Runtime manifest
Binaries: <name + how installed — or `none beyond toolchain`>
Services: <start command per service — or `none`>
Auth: <resolution location only (keychain entry / config path) — never the secret value — or `none`>
Ports/env/fixtures: <list or `none`>
Standing environment: <PID + port + log path + stop command per process left up — or `none`>

## Artifacts
<path → what it proves, one line each>

## Problems
<mismatches observed; scratch processes stopped (and which were left up on purpose);
files written outside EVIDENCE_DIR — or `none` per item>
```
