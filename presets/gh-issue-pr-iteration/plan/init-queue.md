# Fragment: plan/init-queue

## Goal

Write the actionable issues into `{{TARGET_CWD}}/.coder-loop/runtime/state.json` as queue items. Write per-issue handoff files into `runtime/issues/`. Validate the resulting runtime with `--check-runtime`.

## Inputs

- Issue numbers and metadata from `plan/create-issues` (only `issues_created` verdict reaches this fragment).
- Target's existing `state.json` (planning may be a fresh init OR a top-up onto an existing queue).
- `contract.md` §1 (`item` fields).

## Procedure

1. Read existing `{{TARGET_CWD}}/.coder-loop/runtime/state.json`. Preserve existing `queue`, `repository`, `baseBranch`, `recentRuns`, `current` fields if present.

2. **Queue selection** — only push these to `queue`:
   - `kind:code` `implementation` issues that are ready to run (have unmet `Blocks:` dependencies that ARE other queued issues, not external blockers);
   - `kind:comment` `spike` issues that block downstream implementation;
   - prerequisites before dependents (when both queue, list prereq first).

   Don't queue:
   - `parent` umbrella issues that are coordinator-only (no `kind:*` label);
   - `design-question` issues (operator must answer first);
   - `no-code` references (nothing actionable);
   - issues blocked by external work not in this queue.

3. **Construct queue items**. Each item is:
   ```json
   {
     "issue": <number>,
     "status": "queued",
     "attempts": 0,
     "title": "<the issue title>",
     "priority": "<high|medium|low>" or null,
     "branch": null,
     "pr": null,
     "lastRunId": null,
     "issueFile": ".coder-loop/runtime/issues/<N>.md",
     "evidenceDir": ".coder-loop/runtime/evidence/issue-<N>"
   }
   ```
   - `issue` field name comes from `preset.item.idField`; for this preset it's literally `"issue"`.
   - `priority`: pull from your classification judgment. Spikes that block multiple implementations → `high`. Optional polish → `low`.
   - `status` is always `queued` for new items; `in_progress` is legacy, never write it on new entries.

4. **Order matters**. coder-loop's `selectIssue` picks the first `continuable` item. Push prerequisites to the front of the queue (`unshift`), dependents to the back (`push`). Don't rely on review agent to re-order.

5. **Write per-issue handoff files** at `{{TARGET_CWD}}/.coder-loop/runtime/issues/<N>.md`. This file is what `iter/read-context` reads for issue scope context. Minimum content:

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

6. **Create evidence directories**: `mkdir -p {{TARGET_CWD}}/.coder-loop/runtime/evidence/issue-<N>` for each queued issue. Empty directory at this stage; iter agent will populate.

7. **Update `state.json`**:
   - Append new queue items to `queue` array (or `unshift` for prerequisites).
   - Don't touch `current` — let coder-loop pick on next `/dev-loop` start.
   - Don't touch `recentRuns`.

8. **Run schema check**:
   ```bash
   coder-loop --target-cwd {{TARGET_CWD}} --check-runtime
   ```
   Expected output:
   ```
   Runtime check passed: target=...
   Runtime check passed: repo=...
   Runtime check passed: config=... (json)
   Runtime check passed: state=...
   Runtime check passed: queue=<N>, selected=<id>
   Runtime check passed: preset=gh-issue-pr-iteration
   ```
   Exit 0 required. Any error → unwind your edits to `state.json` (restore the backup you made in step 1) and bail with `queue_init_failed`.

## Failure handling

If `--check-runtime` fails after your edits:

- restore `state.json` from the snapshot taken before edits;
- delete the issueFile / evidenceDir entries you created;
- emit `queue_init_failed` with the runtime check error output verbatim;
- don't leave a half-initialized queue that will misbehave on next `/dev-loop`.

If an issueFile fails to write (disk full, permission), the queue item that references it will fail `--check-runtime` (`state.queue[N].issueFile: file does not exist`). Either fix the write and re-run, or remove that queue item.

## Output verdict

Choose exactly one:

- `queue_initialized` → read `plan/handoff`. `--check-runtime` exit 0; queue contains the new items; per-issue files exist.
- `queue_init_failed` → read `plan/handoff` with the runtime check error + restoration steps taken.

Do not advance to handoff while runtime is in an inconsistent state.
