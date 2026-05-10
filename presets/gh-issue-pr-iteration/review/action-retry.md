# Fragment: review/action-retry

## Goal

Publish precise feedback for work that remains actionable.

## Feedback target

- If a live implementation PR exists, all retry feedback must be posted on that PR. Prefer `gh pr review --request-changes`; if GitHub rejects a formal self-review, post an ordinary PR comment on the same PR.
- If no PR exists, post the feedback as an issue comment.
- Do not post PR-related review results only to the issue.

## Feedback body

Include:

- what was done, based on trace;
- specific problems found;
- required changes;
- evidence status, including whether review stopped before code review;
- live CI observation and timeout/hang assessment when relevant;
- constraints: do not bypass coder-loop review, do not merge manually, do not close the issue manually.

## Output verdict

Choose exactly one:

- `retry_feedback_posted` → read `review/update-state` with transition `retry`.
- `retry_feedback_failed` → read `review/action-stop`; feedback publication failed, so do not update local issue state as if review feedback is durable.