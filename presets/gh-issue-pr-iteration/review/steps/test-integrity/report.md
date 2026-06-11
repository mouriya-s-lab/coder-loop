# Report template: test-integrity (review)

Structure your final message exactly as below. Every section is required; write `none` for empty sets — never omit a section.

```markdown
## Refs measured
base=<branch>@<sha> head=<branch>@<sha> (PR #<n>)

## Test changes enumerated from the diff
| Test | File | What happened |
|---|---|---|
| <name> | <path> | removed / renamed to X / skipped via Y / weakened: <how> |

(or a single row `none | - | -` after enumeration)

## Inventory
base: <count> (<command>, exit <n>)
head: <count> (<command>, exit <n>)
Setup performed per side: <install/build commands + exits>

## Correlation findings
<count delta vs enumeration: consistent / hidden weakening: <what the numbers say
that the enumeration does not> — or `none`>

## Problems
<suites that failed to run after attempted setup (commands + output); worktrees
created and confirmed removed; files written, for the cleanup ledger — or `none` per item>
```
