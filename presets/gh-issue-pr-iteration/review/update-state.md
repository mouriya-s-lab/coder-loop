# Fragment: review/update-state

## Goal

Apply the state transition chosen by the terminal action fragment.

## State transitions

For the selected queue item:

- `retry` → `status: "changes_requested"`; keep branch/PR fields if known; clear `current`.
- `expanded incomplete parent` → prepend new child queue items, set parent `status: "changes_requested"`, set `current: null`, and leave parent GitHub issue open.
- `accepted_pr` → only after PR merge and issue close succeeded: set `status: "done"`, set PR number if known, clear `current`.
- `accepted_no_pr` → only after issue close succeeded: set `status: "done"`, clear `current`.
- `skip` → only after issue close succeeded: set `status: "moot"`, clear `current`.
- `blocked` → set `status: "blocked"`, record blocker in handoff, clear `current`.

If merge fails, issue close fails, the GitHub issue remains open, checks/mergeability are not green, or parent expansion fails, keep the issue actionable with exact feedback.

## Expanded parent queue rules

When prepending children:

- read the latest state immediately before writing;
- avoid duplicate child issue numbers already in queue;
- insert the new child items as a batch at the front, preserving creation order;
- set `current: null` because the orchestrator selects actionable current before queue front;
- do not set the parent to `done`, `moot`, or `blocked`.

## Handoff

Append a concise review note to the current issue handoff with verdict, reasons, actions performed, state transition, child closure table when applicable, and next action.

Promote only stable, source-cited cross-issue facts to the shared context file.

## Output verdict

Choose exactly one:

- `state_updated` → read `review/global-assessment`.
- `state_update_failed` → read `review/global-assessment` and classify review infrastructure as broken if state cannot be trusted.