# State write

Apply the transition chosen by the verdict action by writing the item status yourself. The scheduler does not infer status from your output — the status written through `coder-loop item update` is the single source of truth; without it the item stays on its current status and is re-selected. Accepted/moot verdicts do **not** come here: they publish the ReviewVerdict and clean-exit; closure writes the terminal statuses after performing the external effects.

## How to write

The daemon-serialized CLI validates against the preset vocabulary and writes atomically:

```bash
coder-loop item update <CHAIN_NAME> --issue <ISSUE> --status <status> [--field-json '{"extraPatch":{...}}']
```

Blocker metadata for the `blocked` transition lives inside `--field-json` as an `extraPatch` block — see the Blocker metadata section below.

Run once per transition, then verify the write landed:

```bash
coder-loop item update <CHAIN_NAME> --issue <ISSUE> --status <status> --json
```

The engine binds your identity to this run automatically: the spawn environment carries the run-scoped credential (`CODER_LOOP_RUN_CRED` env var), the CLI auto-attaches it to the daemon request, and the daemon resolves it to the active (chain, item, run). Never copy any env value into the prompt, into another command line, or into trace artifacts — the credential is the engine's, not yours to forward.

Non-zero exit or verification not showing the intended status = the write did not land; do not report the transition as applied — treat state as untrustworthy in global assessment.

## Transitions

Resolve the status name for each verdict from the preset metadata, not from this fragment: run `coder-loop item exits <CHAIN_NAME> --issue <ISSUE> --agent-run-id <RUN_ID> --agent-phase review --json` to list the allowed status set for the review phase, then pick the status whose `when` text matches the verdict you reached. The `--status <chosen>` value below is described in semantic terms — the literal name comes from your `exits` query.

- `retry` → write the preset's retry continuable status (the status that routes the item into a fresh iteration). PR identity mirrors (`branch`/`pr`) are not yours to write — iteration and publish own that sync on their next pass.
- `reenrich` → write the preset's contract-invalid continuable status; the declared next-node edge returns to `contract-enrichment`.
- `expanded incomplete parent` → first insert the child batch, then set the parent to the same retry continuable status `retry` writes; leave the parent GitHub issue open. Batch insertion: read latest items with `coder-loop item list <CHAIN_NAME> --json`; skip child numbers already queued; add via `coder-loop item batch-add <CHAIN_NAME> --items-json '<json-array>'`. Since #412, every child item JSON must declare `preset` (or `presetPath`); inherit the parent item's preset by setting `"preset": "<the parent's preset name>"` so the child renders against the same preset family the parent assumed. If the parent sits before the new children, move children forward with `coder-loop item reorder <CHAIN_NAME> --issue <child> --position <n>` so they are selected before the parent retry and before older queued siblings.
- `blocked` → write the preset's blocked terminal status with `--field-json '{"extraPatch":{"blockerRepo":"<owner/repo>","blockerRef":"<ref>"}}'`.

If feedback publication, expansion, or blocker publication failed: do not write the corresponding status — keep the item on its current status with exact failure recorded, per the action file's failure routing.

## Blocker metadata

Only `blocked` writes blocker metadata. Since #457 the engine no longer carries a first-class blocker mutation; the preset writes blocker info through the generic `extraPatch` path inside `--field-json`:

```bash
--field-json '{"extraPatch":{"blockerRepo":"owner/repo","blockerRef":"#267"}}'
```

`blockerRepo` is `owner/repo` (use the current `REPO` if the blocker is in-repo); `blockerRef` is `#123` / `owner/repo#123` or a concise condition string when no concrete issue exists. The daemon merges this patch into the item's `extra` without disturbing other keys (e.g. `dependsOn`), so `blocked-responder` can read them.

For non-blocked transitions never write these keys. When moving an item OUT of `blocked`, rebuild the full `extra` object without the blocker keys (the engine no longer offers a typed "clear blocker" op — it does not own those keys' semantics any more):

```bash
--field-json '{"extra":{"dependsOn":[42]}}'
```

(Inspect the item's current extra with `coder-loop item list <CHAIN_NAME> --json` first to know which other keys to preserve.)

Cross-repo blockers: record repo+ref so `blocked-responder` can resolve the blocking repository; the item's `agentCwd` is daemon-owned and cannot be set here — state the cross-repo context in the handoff instead.
