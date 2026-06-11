# Report template: e2e-replay (review)

Structure your final message exactly as below. Every section is required; write `none` for empty sets — never omit a section.

```markdown
## Environment reached
<standing-environment probe result; restarted via manifest: yes/no + commands — or the
manifest gap that made it unreachable>

## E2E re-drive
| Claim (packet) | How I re-drove it | Observed | Match |
|---|---|---|---|
| <claim> | <real entry invocation / agent-browser walk> | <observation + artifact path> | yes / no |

## Form check
<e2e evidence produced by direct execution / by script-harness (= finding, name the script)>

## Other claims replayed
| Claim | Command | Observed | Match |
|---|---|---|---|

## Problems
<manifest gaps (exact missing entries); claims that could not be re-driven and the
two-shape cause (unfinished setup with attempts shown / manifest gap); everything left
running with stop commands, for the orchestrator's sweep — or `none` per item>
```
