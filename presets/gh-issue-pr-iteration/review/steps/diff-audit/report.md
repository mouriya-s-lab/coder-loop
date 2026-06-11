# Report template: diff-audit (review)

Structure your final message exactly as below. Every section is required; write `none` for empty sets — never omit a section.

```markdown
## Refs audited
base=<branch>@<sha> head=<branch>@<sha> (PR #<n>)

## Scope mapping
| File | Class | Mapped to |
|---|---|---|
| <path> | in-scope / support / unmapped | <issue requirement or row #, or entailing change, or `-`> |

Unmapped files: <list or `none`>

## Hygiene findings
<staged runtime artifacts / scheduling state / logs / droppings, with paths — or `none`>

## Test integrity
Inventory: base=<count> (<command>), head=<count> (<command>)
| Test | File | What happened |
|---|---|---|
| <name> | <path> | removed / renamed to X / skipped via Y / weakened: <how> |

(or a single row `none | - | -` after enumeration)

## Code findings (anchored to the issue's design)
| # | Category | Location | Finding | Anchor |
|---|---|---|---|---|
| <n> | logic / design-deviation / convention / structure | <file:line> | <concrete defect> | <failure path / issue sentence quote / convention source / diff evidence> |

(or a single row `none | - | - | - | -` after actually reading the changed code)

## Change footprint (factual)
<surfaces touched and the nature of each change, 3-8 lines, no quality judgments>

## Problems
<commands that failed, parts of the diff you could not audit and why,
processes started / files written (for the cleanup ledger)>
```
