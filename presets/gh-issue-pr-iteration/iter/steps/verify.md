# Step: verify

The verification runbook for one coder-loop iteration. Iteration executes this step inline in its own session — this preset forbids subagents, so treat the sections below as your own instruction set, not a task spec for a nested agent. The deliverable is executed verification plus a reviewer-consumable evidence trail under `EVIDENCE_DIR`. The e2e direct run is a separate step you execute next in the same session (verify then e2e — sequential; there is no concurrent dispatch here) — your scope in this step is the marker Checks, the test suite, and workflow commands.

## Task

From the iteration's runtime bindings and your Step focus: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch the implement step produced), `EVIDENCE_DIR`, `TARGET_CWD`, and `Step focus`. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` (whichever exists; both is normal) for project test / build / lint / typecheck commands; plus `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/cleanup.md` — every artifact below is bound by them.

**Claim gate.** No verdict without fresh evidence: before writing any pass wording, identify the command that proves the claim, run it in full this run, and read the complete output and exit code — a previous run, a partial check, or "should pass" is not a verdict. Before reporting, confirm the executed set as a whole still covers the marker Checks.

1. **Enumerate the Checks and plan each one.** Fetch the complete issue comments and parse the unique current executable-contract marker; collect **every** typed `Checks` row. Plan each row from its `Kind`:
   - `browser` → not yours: browser Checks are e2e territory, executed by the e2e step's real-UI walk. Plan the stable ID as `deferred: e2e step` — it still appears in your results table with that verdict, never silently dropped.
   - `shell` → execute the literal command in its declared cwd/env and compare its expected exit/output.

   Write the per-Check plan (execute here / deferred to e2e) before running anything. No stable ID is silently dropped.
2. **Run the shell Checks.** Before the first Check, make the worktree runnable — that is your job, not a blocker: run the project's dependency install (per its manifest/lockfile and the target repo's `CLAUDE.md` / `AGENTS.md`) and any required build if the implement step left them undone; record the setup commands and exits.

   Per Check: run the literal command in its declared cwd/env, capture command + exit status + output vs expected exit/output. A mismatch is a result to record, not a thing to fix — product failures route back to a fresh implement step (iteration inserts one before re-running verify then e2e); you never patch product code or tests. Fix-and-rerun is allowed only for your own invocation mistakes, and the correction is recorded. An intrinsically broken marker Check is contract-invalid, not a command to reinterpret.
3. **Test suite.** Run the canonical full-suite command named in the target repo's `CLAUDE.md` / `AGENTS.md` on the issue branch, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and read the runner's own aggregated summary line in full. A failing suite is a product finding that routes back to a fresh implement step. Test-integrity accounting (every test the diff removes, renames, skips, or weakens, judged against the marker `Test delta` authority) is owned by the diff-audit phase — your job here is that the suite passes as run, not the base-vs-head bookkeeping.
4. **Project commands.** From the target repo's `CLAUDE.md` / `AGENTS.md`, run build / lint / typecheck / migration / deployment-preview commands that apply to this issue, obeying wrappers and prohibitions; capture the artifacts the project's conventions require. Capture both positive and negative paths when the issue scope or project conventions require them.
5. **Land the artifacts and report.** Everything lands under `EVIDENCE_DIR`. You had no reason to commit, push, open PRs, or write GitHub/queue state — confirm you did not. Report per the Report section, mismatches reported as mismatches without softening. (The e2e direct run, the typed runtime handoff belong to the e2e step.)

## Report

```markdown
## Why this verification set
<which checks you chose and why they cover the issue contract; what you deliberately
did not run and why>

## Check results
| ID | Kind | Command/action | Exit | Actual vs expected | Verdict |
|---|---|---|---|---|---|
<one line per marker Check; browser Checks carry verdict `deferred: e2e step`>

## Test suite
<canonical command + exit + the runner's aggregated summary line + log path>

## Workflow commands
<per command: command + exit + concise excerpt>

## Artifacts
<path → what it proves, one line each>

## Problems
<failures and hangs observed; Checks that could not run (with the exact cause);
processes started (PIDs / log paths); files written outside EVIDENCE_DIR — or `none` per item>
```

## Acceptance

Report structurally missing any section, or a Check results table with stable IDs absent → send back before judging substance.

- **Check coverage** — every marker Check appears with an actual result or a `deferred: e2e step` verdict (`Kind=browser` only). A stable ID absent from the table is a gap. Deferred browser IDs must equal the browser set already written into the e2e line's `Step focus`; judge them from the e2e step's report.
- **Mismatch honesty** — mismatching Checks reported as mismatches, not rationalized. Cosmetic-handwave is a hard fail per `{{PRESET_ROOT}}/quality/honesty.md`. An implementation mismatch routes back to implementation; a broken marker Check routes to contract-invalid.
- **Test suite ran in full** — the canonical command's own aggregated summary line is read and recorded; a failing suite routes back to implementation, never into the report as a softened note.
- **Evidence quality** — apply `{{PRESET_ROOT}}/quality/evidence.md`: claim ↔ observation, no weak-signal acceptance, no synthetic artifacts, every artifact mapped to the behavior it proves.
- **Side effects declared** — processes and temp files listed for the cleanup ledger.

If this step's self-check surfaces gaps, do the missing work now. If verification surfaced product failures, iteration inserts a new implement step (fix), then re-runs verify then e2e sequentially for the full contract — not just the failed row.
