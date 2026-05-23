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
- `blocked` → set `status: "blocked"`, write structured blocker metadata to the selected queue item, record blocker in handoff, clear `current`.

If merge fails, issue close fails, the GitHub issue remains open, checks/mergeability are not green, or parent expansion fails, keep the issue actionable with exact feedback.

## Blocked metadata

Only the `blocked` transition writes blocker metadata. For retry, expanded-parent, accepted, accepted-no-PR, and skip transitions, do not add `blockerRepo` or `blockerRef`; if stale blocker metadata is present while moving the item to a non-blocked status, remove those stale fields.

When applying the `blocked` transition, update the selected queue item in `central state DB` with:

- `blockerRepo`: the blocking repository in `owner/repo` format. If the blocker is inside the current repository, this may be omitted or set to the current `REPO`.
- `blockerRef`: the blocking issue reference such as `#267`, `owner/repo#267`, or a concise condition string when the blocker is not a concrete issue.

`central state DB` stores queue-item extra fields as top-level JSON fields on each queue item. Add `blockerRepo` and `blockerRef` at the selected queue item's top level so they deserialize into `QueueItem.extra`; do not create a literal nested `extra` object in the file.

If `blockerRepo` names a different repository from `REPO`, resolve that repository's local checkout before writing state. When a verified checkout exists, set the selected queue item's top-level `agentCwd` to that absolute path so the post-review `blocked-responder` trigger spawns in the blocking repository while retaining the current target repo as an additional readable directory. Verify by git remote owner/name, not by directory basename alone. If no checkout can be verified, leave `agentCwd` null and state the lookup failure in the handoff so `blocked-responder` can report the infrastructure blocker.

## Expanded parent queue rules

When prepending children:

- read the latest state immediately before writing;
- avoid duplicate child issue numbers already in queue;
- insert the new child items as a batch at the front, preserving creation order;
- if the parent item is currently before the new child batch, move or rewrite the array/store order so the new children are selected before the parent retry item and before any older queued siblings;
- set `current: null` because the orchestrator selects actionable current before queue front;
- do not set the parent to `done`, `moot`, or `blocked`.

## Handoff

Append a concise review note to the current issue handoff with verdict, reasons, actions performed, state transition, child closure table when applicable, and next action.

Promote only stable, source-cited cross-issue facts to the shared context file.

## Output verdict

Choose exactly one:

- `state_updated` → read `review/global-assessment`.
- `state_update_failed` → read `review/global-assessment` and classify review infrastructure as broken if state cannot be trusted.
