# Engine Reserved Strings

This file is the repository registry for literal strings that have control
semantics inside `coder-loop`. Do not put these strings verbatim in GitHub issue
titles, issue bodies, or issue comments that agents will read. Link to this file
or split the token in prose when the string itself must be discussed.

The registry is writing discipline only. It is not prompt injection defense, and
it does not replace runtime parsing.

## Current Strings

| String | Use | Source |
|--------|-----|--------|
| `ITERATION SUMMARY:` | Iteration phase completion marker observed by the post-summary watchdog. | `src/loop.ts` `SUMMARY_WATCHDOG_MARKER` |
| `REVIEW SUMMARY:` | Review phase completion marker observed by the post-summary watchdog. | `src/loop.ts` `REVIEW_SUMMARY_WATCHDOG_MARKER` |

## Maintenance

- Update this table in the same PR that adds, removes, or renames an engine
  marker/sentinel that may appear in agent stdout.
- Update `templates/skills/writing-issue/SKILL.md` when the issue-writing rule
  changes.
- Run `bun test src/loop.test.ts` after changing this file or the marker
  constants.
