# Fragment: review/update-state

## Goal

Apply the state transition chosen by the terminal action fragment by writing the item status yourself.

The scheduler does not infer status from your output. The status you write through `coder-loop item update --status` is the single source of truth the scheduler reads to advance the queue. If you do not write a terminal status, the item stays actionable and will be re-selected on the next pass.

## How to write status

Use the daemon-serialized CLI, which validates the status against the preset vocabulary and writes atomically:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status <status> [--pr <N>] [--branch <name>] [--blocker-repo <owner/repo>] [--blocker-ref <ref>] [--clear-blocker]
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
- `blocked` → `coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status blocked --blocker-repo <owner/repo> --blocker-ref <ref>` (see "Blocked metadata"), then record the blocker in the handoff.

If merge fails, issue close fails, the GitHub issue remains open, checks/mergeability are not green, or parent expansion fails, do not write a terminal status. Keep the issue actionable with exact feedback so it is retried.

## Blocked metadata

Only the `blocked` transition writes blocker metadata. Each field has its own typed flag — do not pass raw JSON:

```bash
coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status blocked --blocker-repo owner/repo --blocker-ref '#267'
```

- `--blocker-repo`: the blocking repository in `owner/repo` format. If the blocker is inside the current repository, omit it or pass the current `REPO`.
- `--blocker-ref`: the blocking issue reference such as `#267`, `owner/repo#267`, or a concise condition string when the blocker is not a concrete issue.

The daemon merges these as named fields into the queue item's `extra` (without disturbing other `extra` keys such as `dependsOn`), so `blocked-responder` can read them.

For retry, expanded-parent, accepted, accepted-no-PR, and skip transitions, do not pass `--blocker-repo` / `--blocker-ref`. If stale blocker metadata may be present while moving the item to a non-blocked status, clear it with `--clear-blocker`.

If the blocker names a different repository from `REPO`, record `--blocker-repo` / `--blocker-ref` so `blocked-responder` can resolve the blocking repository itself. The queue item's top-level `agentCwd` is daemon-owned and cannot be set through `item update`; do not attempt to redirect the trigger's spawn directory from here. State the cross-repo blocker in the handoff so `blocked-responder` can act on it.

## Expanded parent queue rules

When prepending children, use the centralized item CLI:

- read the latest items immediately before writing with `coder-loop item list {{CHAIN_NAME}} --json`;
- avoid duplicate child issue numbers already in queue;
- add the new child items with `coder-loop item batch-add {{CHAIN_NAME}} --items-json '<json-array>'` (or repeated `coder-loop item add` when batch input is unavailable);
- if the parent item is currently before the new child batch, move the new children to the front with `coder-loop item reorder {{CHAIN_NAME}} --issue <child-issue> --position <n>` so they are selected before the parent retry item and before any older queued siblings;
- do not set the parent to `done`, `moot`, or `blocked`.

## Handoff

Append a concise review note to the chain handoff/shared file with verdict, reasons, actions performed, state transition, child closure table when applicable, and next action.

If `{{CURRENT_ISSUE_FILE}}` is non-empty and already exists, you may also append issue-local details there. Do not fail review because the optional per-issue file is absent.

## Output verdict

Choose exactly one:

- `state_updated` → read `review/global-assessment`.
- `state_update_failed` → read `review/global-assessment` and classify review infrastructure as broken if state cannot be trusted.
