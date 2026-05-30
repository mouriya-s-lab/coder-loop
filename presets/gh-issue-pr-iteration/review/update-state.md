# Fragment: review/update-state

## Goal

Apply the state transition chosen by the terminal action fragment by writing the item status yourself.

The scheduler does not infer status from your output. The status you write through `coder-loop item update --status` is the single source of truth the scheduler reads to advance the queue. If you do not write a terminal status, the item stays actionable and will be re-selected on the next pass.

## How to write status

Use the daemon-serialized CLI, which validates the status against the preset vocabulary and writes atomically:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status <status> [--pr <N>] [--branch <name>] [--extra '<json>']
```

Run it once per transition, then verify the write reached the store:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status <status> --json
```

If the command exits non-zero or the verification does not show the intended status, the write did not land — do not report the transition as applied; fall through to `state_update_failed`.

## State transitions

For the selected queue item, run exactly the command for the chosen verdict:

- `retry` → `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status changes_requested`. Keep branch/PR fields if known by adding `--branch {{ISSUE_BRANCH}}` / `--pr {{ISSUE_PR}}` only when you have verified values.
- `expanded incomplete parent` → prepend the new child queue items first (see "Expanded parent queue rules"), then `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status changes_requested`, and leave the parent GitHub issue open.
- `accepted_pr` → only after PR merge and issue close both succeeded: `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status done --pr <merged-pr-number>`.
- `accepted_no_pr` → only after issue close succeeded: `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status done`.
- `skip` → only after issue close succeeded: `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status moot`.
- `blocked` → `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status blocked --extra '<blocker-json>'` (see "Blocked metadata"), then record the blocker in the handoff.

If merge fails, issue close fails, the GitHub issue remains open, checks/mergeability are not green, or parent expansion fails, do not write a terminal status. Keep the issue actionable with exact feedback so it is retried.

## Blocked metadata

Only the `blocked` transition writes blocker metadata. Pass it as a JSON object to `--extra`:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status blocked --extra '{"blockerRepo":"owner/repo","blockerRef":"#267"}'
```

- `blockerRepo`: the blocking repository in `owner/repo` format. If the blocker is inside the current repository, omit it or set it to the current `REPO`.
- `blockerRef`: the blocking issue reference such as `#267`, `owner/repo#267`, or a concise condition string when the blocker is not a concrete issue.

`--extra` merges these as top-level fields on the queue item, so they deserialize into `QueueItem.extra` and `blocked-responder` can read them.

For retry, expanded-parent, accepted, accepted-no-PR, and skip transitions, do not pass `blockerRepo` or `blockerRef`. If stale blocker metadata is present while moving the item to a non-blocked status, clear it by passing `--extra '{"blockerRepo":null,"blockerRef":null}'`.

If `blockerRepo` names a different repository from `REPO`, resolve that repository's local checkout before writing state. When a verified checkout exists, set the selected queue item's `agentCwd` to that absolute path with `--extra '{"blockerRepo":"owner/repo","blockerRef":"#267","agentCwd":"/abs/path"}'` so the post-review `blocked-responder` trigger spawns in the blocking repository while retaining the current target repo as an additional readable directory. Verify by git remote owner/name, not by directory basename alone. If no checkout can be verified, leave `agentCwd` unset and state the lookup failure in the handoff so `blocked-responder` can report the infrastructure blocker.

## Expanded parent queue rules

When prepending children, use the centralized item CLI:

- read the latest items immediately before writing with `coder-loop item list {{CHAIN_NAME}} --json`;
- avoid duplicate child issue numbers already in queue;
- add the new child items with `coder-loop item batch-add {{CHAIN_NAME}} --items-json '<json-array>'` (or repeated `coder-loop item add` when batch input is unavailable);
- if the parent item is currently before the new child batch, move the new children to the front with `coder-loop item reorder {{CHAIN_NAME}} --issue <child-issue> --position <n>` so they are selected before the parent retry item and before any older queued siblings;
- do not set the parent to `done`, `moot`, or `blocked`.

## Handoff

Append a concise review note to the current issue handoff with verdict, reasons, actions performed, state transition, child closure table when applicable, and next action.

Promote only stable, source-cited cross-issue facts to the shared context file.

## Output verdict

Choose exactly one:

- `state_updated` → read `review/global-assessment`.
- `state_update_failed` → read `review/global-assessment` and classify review infrastructure as broken if state cannot be trusted.
