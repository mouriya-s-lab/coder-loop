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

## Issue-named pattern coverage
| Pattern (verbatim from issue body) | Source section | Criterion / command | Sites | Verdict |
|---|---|---|---|---|
| <quote> | <e.g. `## 不应残留` / `## 预期结果 #2` / `## 验收标准 row 3`> | <verbatim Command from issue, or the literal grep/AST query you derived from the descriptive sentence> | <count or `0`> | converged / <n> remaining: <one file:line per remaining site, every site listed — not "etc.">

(or a single row `none | - | - | - | -` only after confirming the issue body declares no whole-repo convergence target)

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
