# Step: verify

A verification subagent for one coder-loop iteration. The deliverable is executed verification plus a reviewer-consumable evidence trail under `EVIDENCE_DIR`. The e2e direct run is a separate step that may be running in parallel (it works in its own worktree; `AGENT_CWD` is yours) — your scope is the marker Checks, the test suite, CI parity, and workflow commands.

## Task

From your dispatch message: `ISSUE`, `REPO`, `BASE_BRANCH`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch the implement step produced), `EVIDENCE_DIR`, `TARGET_CWD`, and `Step focus`. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` (whichever exists; both is normal) for project test / build / lint / typecheck commands and CI parity guidance; plus `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/cleanup.md` — every artifact below is bound by them.

**Claim gate.** No verdict without fresh evidence: before writing any pass wording, identify the command that proves the claim, run it in full this run, and read the complete output and exit code — a previous run, a partial check, or "should pass" is not a verdict. Before reporting, confirm the executed set as a whole still covers the marker Checks.

1. **Enumerate the Checks and plan each one.** Fetch the complete issue comments and parse the unique current executable-contract marker; collect **every** typed `Checks` row. Plan each row from its `Kind`:
   - `browser` → not yours: browser Checks are e2e territory, executed by the e2e step's real-UI walk. Plan the stable ID as `deferred: e2e step` — it still appears in your results table with that verdict, never silently dropped.
   - `shell` → execute the literal command in its declared cwd/env and compare its expected exit/output.

   Write the per-Check plan (execute here / deferred to e2e) before running anything. No stable ID is silently dropped.
2. **Run the shell Checks.** Before the first Check, make the worktree runnable — that is your job, not a blocker: run the project's dependency install (per its manifest/lockfile and the target repo's `CLAUDE.md` / `AGENTS.md`) and any required build if the implement step left them undone; record the setup commands and exits.

   Per Check: run the literal command in its declared cwd/env, capture command + exit status + output vs expected exit/output. A mismatch is a result to record, not a thing to fix — product failures are findings the orchestrator routes back to implementation; you never patch product code or tests. Fix-and-rerun is allowed only for your own invocation mistakes, and the correction is recorded. An intrinsically broken marker Check is contract-invalid, not a command to reinterpret.
3. **Test suite and inventory delta.** Run the canonical full-suite command named in the target repo's `CLAUDE.md` / `AGENTS.md` on the issue branch, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and parse the head-side integer from the runner's own aggregated summary line (see `quality/evidence.md` for the runner-specific rule — the integer is the runner's aggregated total, never a static `rg` / `grep` count of `test(` / `it(` declarations). Then measure the base side **without disturbing your checkout**, in a detached scratch worktree of your own:

   ```bash
   SCRATCH=$(mktemp -d)
   git worktree add --detach "$SCRATCH/verify-base" "$(git merge-base <BASE_BRANCH> HEAD)"
   # install deps there, run the same canonical command, tee its output to a log
   git worktree remove "$SCRATCH/verify-base"   # confirm gone; record path and removal
   ```

   Record command, parsed integer, and relative log path for each side; enumerate every test removed/renamed/skipped/weakened by this branch (explicit `none` only after enumerating, never assumed). Publish the delta in the single-line format from `quality/evidence.md`. This delta goes into the evidence packet; review independently re-measures the head side with the same counting rule and cross-checks the enumeration against the diff.
4. **CI parity.** Detect the project's CI configuration and record what you found. For GitHub Actions jobs reproducible locally, run the relevant job with `act` (derive workflow path/event/job/architecture from the project; prefer native arch, record amd64 caveats). If parity cannot run (Docker, act install, image pull, network): record the exact command, failure mode, exit status, log excerpt as an infrastructure blocker — never skip silently, never substitute remote PR checks. If parity reaches product tests and they fail or hang, that is a fixable product finding.
5. **Project commands.** From the target repo's `CLAUDE.md` / `AGENTS.md`, run build / lint / typecheck / migration / deployment-preview commands that apply to this issue, obeying wrappers and prohibitions; capture the artifacts the project's conventions require. Capture both positive and negative paths when the issue scope or project conventions require them.
6. **Land the artifacts and report.** Everything lands under `EVIDENCE_DIR`. You had no reason to commit, push, open PRs, or write GitHub/queue state — confirm you did not. Report per the Report section, mismatches reported as mismatches without softening. (The e2e direct run, the typed runtime handoff belong to the e2e step.)

## Report

```markdown
## Why this verification set
<which checks you chose and why they cover the issue contract; what you deliberately
did not run and why>

## Check results
| ID | Kind | Command/action | Exit | Actual vs expected | Verdict |
|---|---|---|---|---|---|
<one line per marker Check; browser Checks carry verdict `deferred: e2e step`>

## Test inventory delta
base=<count> (<command>) head=<count> (<command>)
Base measured in: <scratch worktree path, confirmed removed>
Removed/renamed/skipped/weakened: <enumerated list or `none`>

## CI parity
<detection result; parity command + arch + exit + log path — or the exact infrastructure
blocker (command, failure mode, exit, excerpt)>

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
- **Test inventory delta** — present, base side measured in a removed scratch worktree, and consistent with the implement report's test-changes enumeration; an unexplained non-empty delta routes back to implementation, not into the packet.
- **Evidence quality** — apply `{{PRESET_ROOT}}/quality/evidence.md`: claim ↔ observation, no weak-signal acceptance, no synthetic artifacts, every artifact mapped to the behavior it proves.
- **CI parity present** — either parity ran with command/arch/exit/log, or an exact infrastructure blocker is recorded. "Suite passed" alone does not satisfy parity.
- **Side effects declared** — processes and temp files listed for the cleanup ledger (the scratch worktree confirmed removed).

Send back precise gap lists. If verification surfaced product failures, route to a new implement dispatch, then re-dispatch verify and e2e in parallel for the full contract — not just the failed row.
