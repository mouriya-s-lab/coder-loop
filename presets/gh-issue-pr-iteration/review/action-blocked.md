# Fragment: review/action-blocked

## Goal

Record a real external dependency that prevents progress.

## Preconditions

Use `blocked` only when the iteration or review evidence proves a required local/runtime dependency is unavailable and rerunning immediately cannot create the missing evidence. The relevant command/query must have been attempted and recorded.

Examples:

- required binary absent;
- required external service unreachable;
- required credentials or access missing;
- required environment cannot be provisioned from this loop.

Weak evidence, failed tests, bad code, PR conflicts, pending checks, or missing screenshots are not blockers; they are retry.

## Feedback target

Comment on the PR if one exists and the blocker concerns implementation/verification of that PR; otherwise comment on the issue.

## Standard blocker metadata

The blocker comment must include a machine-readable metadata block:

```text
blockerRepo: owner/repo
blockerRef: #123
```

Use `blockerRepo` for the blocking repository in `owner/repo` format. If the blocker is in the current repository, set it to the current `REPO` value.

Use `blockerRef` for the blocking issue reference (`#123` or `owner/repo#123`) when a concrete issue exists. If the blocker is an environmental condition rather than an issue, use a concise condition string, for example `macOS DirectoryServices user lookup unavailable`.

## Output verdict

Choose exactly one:

- `blocked_feedback_posted` → read `review/update-state` with transition `blocked`.
- `blocked_feedback_failed` → read `review/action-stop`; blocker publication failed, so do not update local issue state as if the blocker is durable.
