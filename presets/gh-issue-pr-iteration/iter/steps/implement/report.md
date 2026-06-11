# Report template: implement

Structure your final message exactly as below. Every section and field is required; write `none` for empty sets — never omit a field.

```markdown
## Why I did it this way
<your reading of the issue contract; change classification and why; footprint decision
(sites touched vs left, with owners); path chosen over which alternatives>

## What I actually did
Branch: <name> @ <head sha (uncommitted: say so)>
Files changed: <bulleted list, every file, with one clause each on what changed>
Intent appended: <handoff path + heading written>

Row coverage:
| Row | Addressed by | Status |
|---|---|---|
| <row # or custom-section name> | <which change> | addressed / deviated: <how> / deferred: <why> |

Test changes: <every test added/modified/removed/renamed/skipped with old→new — or `none`>

## Problems
<uncertainties; discoveries outside the issue scope; deviations from intent;
unclassifiable footprint sites; processes started / files scattered (for the cleanup ledger)
— or `none` per item>
```
