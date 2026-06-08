# Fragment: plan/init-queue

## Goal

Initialize the executable planning output through the current centralized chain/item contract. Create or select a chain with `coder-loop chain ...`, rely on the daemon-owned chain handoff/shared file for run-to-run context, add actionable issues with `coder-loop item batch-add` (or repeated `coder-loop item add` only when batch input is unavailable), and validate with `coder-loop status` plus `--check-runtime`.

## Inputs

- Issue numbers and metadata from `plan/create-issues` (only `issues_created` verdict reaches this fragment).
- Target's existing centralized chain, if planning is a top-up onto an existing mission.
- `contract.md` §1 (`item` fields).

## Procedure

1. **Resolve the chain**. Use the stable chain API; do not inspect or edit a legacy queue structure directly.
   ```bash
   coder-loop chain status <chain-name> --json
   # if missing and this is a fresh mission:
   coder-loop chain create <chain-name> --config-json '{"repository":"<owner>/<repo>"}' --json
   ```
   Preserve existing chain metadata and current run state. Do not clear or rewrite `current` / recent run artifacts.

2. **Queue selection** — only add these as chain items:
   - `kind:code` `implementation` issues that are ready to run (have unmet `Blocks:` dependencies that ARE other queued issues, not external blockers);
   - `kind:comment` `spike` issues that block downstream implementation;
   - `kind:code-spike` source-writing spikes that block downstream implementation and must not merge into production;
   - `kind:blocked` unblock issues that have a concrete blocker description and are ready to resolve;
   - prerequisites before dependents (when both queue, model the dependency instead of relying on text order alone).

   Don't queue:
   - `parent` umbrella issues that are coordinator-only (no `kind:*` label);
   - `design-question` issues (operator must answer first);
   - `no-code` references (nothing actionable);
   - issues blocked by external work not in this queue.

3. **Record planning context in the chain handoff/shared file**. The daemon owns and creates:

   ```text
   loop-data/chains/<chain>/shared.md
   ```

   Append concise source-cited context for the issue set being queued. Minimum content:

   ```markdown
   ## Planning queue init (<run id>)

   - #<N> <title>: <validated scope / expected deliverable summary>
   - Dependencies: depends on #<M>; blocks #<P>
   - Notes: <non-obvious planning context the iter/review agents need>
   ```

   Optional per-issue handoff files under `loop-data/chains/<chain>/issues/<N>.md` may be written for bulky issue-local notes, but they are attachments. Do not make item startup depend on them.

4. **Create evidence directories** under the chain runtime, conceptually:
   ```text
   loop-data/chains/<chain>/evidence/issue-<N>
   ```
   Empty directory at this stage; iter agent will populate.

5. **Construct item API payloads**. Each new item passed to `coder-loop item batch-add` / daemon `item.batchAdd` contains the current item fields. Leave `issueFile` null unless you intentionally created an optional per-issue attachment. `evidenceDir` may be relative to the chain root when you want an issue-specific evidence directory:
   ```json
   {
     "issueNumber": <number>,
     "repoCwd": "{{TARGET_CWD}}",
     "title": "<the issue title>",
     "priority": "<high|medium|low>" or null,
     "issueFile": null,
     "evidenceDir": "evidence/issue-<N>",
     "agentCwd": null,
     "runner": null,
     "extra": { "dependsOn": [<item ids>] }
   }
   ```
   - The preset-facing item id remains `issue`; the daemon API field is `issueNumber`.
   - `status` defaults to the preset's first continuable status; for this preset new items become `queued`.
   - If `issueFile` is set, it must resolve inside `loop-data/chains/<chain>/issues`; if `evidenceDir` is set, it must resolve inside `loop-data/chains/<chain>/evidence`. Do not pass bare `"<N>.md"` or `"issue-<N>"`, because runtime path validation resolves item paths from the chain root.
   - `agentCwd`: leave `null` for in-repo work. Only set when the issue requires code changes in a **different repo's checkout**; then it must be an **absolute path** to an existing working directory.
   - `extra.dependsOn` stores item ids for prerequisites that already exist in the chain. If the prerequisite is created in the same batch and its DB id is not known yet, add the prerequisite first, read `item list`, then add dependents in a second batch.

6. **Add items through the stable item API**. Prefer one atomic batch:
   ```bash
   coder-loop item batch-add <chain-name> --items-json '<json-array>' --json
   ```
   If the local binary does not yet expose `batch-add`, use repeated compatible fallback calls and document that fallback in handoff:
   ```bash
   coder-loop item add <chain-name> --issue <N> --repo-cwd {{TARGET_CWD}} --title '<title>' --json
   ```
   Do not hand-write SQLite rows, target-local state files, or a legacy queue structure.

7. **Validate current runtime through stable APIs**:
   ```bash
   coder-loop chain status <chain-name> --json
   coder-loop item list <chain-name> --json
   coder-loop status {{TARGET_CWD}} --json
   coder-loop --target-cwd {{TARGET_CWD}} --check-runtime
   ```
   Required result: the new items are visible in `chain status` / `item list`, `status` can select the expected next item, and `--check-runtime` exits 0.

## Failure handling

If item creation or `--check-runtime` fails:

- for `item batch-add`, trust the daemon transaction boundary: no item from the failed batch should exist; verify with `coder-loop item list <chain-name> --json`;
- for fallback repeated `item add`, stop immediately, list what was already inserted, and emit `queue_init_failed` with the compensating action needed;
- delete optional per-issue/evidence artifacts that are not referenced by any item;
- do not leave a half-described queue in handoff prose.

If an optional per-issue handoff file fails to write (disk full, permission), leave `issueFile` null and put the planning note in the chain handoff/shared file instead. Do not leave an item pointing at a missing optional attachment.

If you set `agentCwd` for cross-repo work and validation reports it is not absolute or does not exist, fix it to a real absolute path or set it back to `null` before handoff.

## Output verdict

Choose exactly one:

- `queue_initialized` → read `plan/handoff`. `--check-runtime` exit 0; chain items exist; the daemon-owned chain handoff/shared file exists.
- `queue_init_failed` → read `plan/handoff` with the runtime check error + restoration steps taken.

Do not advance to handoff while runtime is in an inconsistent state.
