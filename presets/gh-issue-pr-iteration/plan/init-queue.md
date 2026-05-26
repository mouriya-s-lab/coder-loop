# Fragment: plan/init-queue

## Goal

Initialize the executable planning output through the current centralized chain/item contract. Create or select a chain with `coder-loop chain ...`, add actionable issues with `coder-loop item batch-add` (or repeated `coder-loop item add` only when batch input is unavailable), write per-issue handoff files under the chain runtime `issues` directory, and validate with `coder-loop status` plus `--check-runtime`.

## Inputs

- Issue numbers and metadata from `plan/create-issues` (only `issues_created` verdict reaches this fragment).
- Target's existing centralized chain, if planning is a top-up onto an existing mission.
- `contract.md` §1 (`item` fields).

## Procedure

1. **Resolve the chain**. Use the stable chain API; do not inspect or edit a legacy queue structure directly.
   ```bash
   coder-loop chain status <chain-name> --json
   # if missing and this is a fresh mission:
   coder-loop chain create <chain-name> --repo <owner>/<repo> --json
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

3. **Write per-issue handoff files** under the centralized chain runtime, not under target-local runtime state. Use the path reported by `coder-loop status <target> --json` / chain runtime layout; conceptually it is:

   ```text
   loop-data/chains/<chain>/issues/<N>.md
   ```

   Minimum content:

   ```markdown
   # Issue #<N>: <title>

   ## Scope from planning

   <quote of the validated `## 问题` paragraph>

   ## Expected deliverable

   <quote of `## 预期结果` + which `## 验收标准` rows are critical>

   ## Dependencies

   - Depends on: #<M> (already queued / external)
   - Blocks: #<P>

   ## Planning notes

   <any non-obvious context from intake / classify / decompose phases that the iter agent should know — e.g. "this spike's failure branch creates a design-question issue, do not implement a workaround">
   ```

4. **Create evidence directories** under the chain runtime, conceptually:
   ```text
   loop-data/chains/<chain>/evidence/issue-<N>
   ```
   Empty directory at this stage; iter agent will populate.

5. **Construct item API payloads**. Each new item passed to `coder-loop item batch-add` / daemon `item.batchAdd` contains the current item fields. `issueFile` and `evidenceDir` are relative to the chain root, so include the `issues/` or `evidence/` prefix:
   ```json
   {
     "issueNumber": <number>,
     "repoCwd": "{{TARGET_CWD}}",
     "title": "<the issue title>",
     "priority": "<high|medium|low>" or null,
     "issueFile": "issues/<N>.md",
     "evidenceDir": "evidence/issue-<N>",
     "agentCwd": null,
     "runner": null,
     "extra": { "dependsOn": [<item ids>] }
   }
   ```
   - The preset-facing item id remains `issue`; the daemon API field is `issueNumber`.
   - `status` defaults to the preset's first continuable status; for this preset new items become `queued`.
   - `issueFile` must resolve inside `loop-data/chains/<chain>/issues`; `evidenceDir` must resolve inside `loop-data/chains/<chain>/evidence`. Do not pass bare `"<N>.md"` or `"issue-<N>"`, because runtime path validation resolves item paths from the chain root.
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
- delete handoff/evidence artifacts that are not referenced by any item;
- do not leave a half-described queue in handoff prose.

If an issueFile fails to write (disk full, permission), the queue item that references it will fail runtime validation. Either fix the write and re-run validation, or remove the affected item through the supported item API before handoff.

If you set `agentCwd` for cross-repo work and validation reports it is not absolute or does not exist, fix it to a real absolute path or set it back to `null` before handoff.

## Output verdict

Choose exactly one:

- `queue_initialized` → read `plan/handoff`. `--check-runtime` exit 0; chain items exist; per-issue files exist.
- `queue_init_failed` → read `plan/handoff` with the runtime check error + restoration steps taken.

Do not advance to handoff while runtime is in an inconsistent state.
