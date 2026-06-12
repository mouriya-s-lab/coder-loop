# State write

Apply the transition chosen by the terminal action by writing the item status yourself. The scheduler does not infer status from your output — the status written through `coder-loop item update` is the single source of truth; without a terminal status the item stays actionable and is re-selected.

## How to write

The daemon-serialized CLI validates against the preset vocabulary and writes atomically:

```bash
coder-loop item update <CHAIN_NAME> --issue <ISSUE> --status <status> --agent-run-id <RUN_ID> --agent-phase review [--field-json '{"pr":123,"branch":"<name>"}'] [--blocker-repo <owner/repo>] [--blocker-ref <ref>] [--clear-blocker]
```

Run once per transition, then verify the write landed:

```bash
coder-loop item update <CHAIN_NAME> --issue <ISSUE> --status <status> --agent-run-id <RUN_ID> --agent-phase review --json
```

Non-zero exit or verification not showing the intended status = the write did not land; do not report the transition as applied — treat state as untrustworthy in global assessment.

## Transitions

- `retry` → `--status changes_requested`. Add `--field-json '{"branch":"<verified>","pr":123}'` only for verified non-empty values.
- `expanded incomplete parent` → first insert the child batch, then set the parent `--status changes_requested`; leave the parent GitHub issue open. Batch insertion: read latest items with `coder-loop item list <CHAIN_NAME> --json`; skip child numbers already queued; add via `coder-loop item batch-add <CHAIN_NAME> --items-json '<json-array>'`; if the parent sits before the new children, move children forward with `coder-loop item reorder <CHAIN_NAME> --issue <child> --position <n>` so they are selected before the parent retry and before older queued siblings.
- `accepted_pr` → only after PR merge AND issue close both succeeded: `--status done --field-json '{"pr":123}'`.
- `accepted_no_pr` → only after issue close succeeded: `--status done`.
- `skip` → only after issue close succeeded: `--status moot`.
- `blocked` → `--status blocked --blocker-repo <owner/repo> --blocker-ref <ref>`.

If merge fails, close fails, the issue remains open, checks are not green, or expansion fails: do not write a terminal status — keep the item actionable with exact feedback.

## Blocker metadata

Only `blocked` writes blocker metadata, via the typed flags (never raw JSON): `--blocker-repo owner/repo`, `--blocker-ref '#267'` (or `owner/repo#267`, or a concise condition string). The daemon merges them into the item's `extra` without disturbing other keys (e.g. `dependsOn`), so `blocked-responder` can read them. For non-blocked transitions never pass blocker flags; clear stale metadata with `--clear-blocker` when moving out of blocked. Cross-repo blockers: record repo+ref so `blocked-responder` can resolve the blocking repository; the item's `agentCwd` is daemon-owned and cannot be set here — state the cross-repo context in the handoff instead.
