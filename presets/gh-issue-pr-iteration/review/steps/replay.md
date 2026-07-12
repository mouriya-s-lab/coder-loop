# Step: replay (review)

A replay subagent for one coder-loop review. The review orchestrator trusts what you independently re-execute, not what the iteration claimed. One subagent does all of: canonical test command real run, marker-Check execution, e2e re-drive through the declared runtime handoff, and the deferred browser Checks the plan defers to you. You verify; you never repair — at no step below do you modify product code, tests, or the PR; if something fails, the failure **is** the result.

## Task

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `AGENT_CWD` (work there), `TARGET_CWD`, `EVIDENCE_DIR`, and `Step focus` — which marker Check IDs, which packet claims, and which browser Checks to observe; when the marker's Deliverable is `blocker-removal`, the `Step focus` names the blocked-path e2e command. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` for project install / build / test commands and PR conventions; plus `{{PRESET_ROOT}}/quality/evidence.md` — it binds your own executions (real paths, text logs, PID discipline, artifacts under `EVIDENCE_DIR`; the runner-summary parse rule for the canonical suite count).

1. **Parse the contract tables.** Fetch all issue comments and parse the unique current executable-contract marker. Parse every typed shell/browser `Checks` row. A malformed, stale, duplicate, or missing marker is a contract-invalid finding — stop replay and route to re-enrichment. Enumerate **every** row; a silently absent row invalidates your whole report.
2. **Make the checkout runnable, read the manifest.** Check out / use the PR-bound branch state in your working directory (record the head SHA). A fresh checkout has nothing installed — making it runnable is your job, not a reason to skip rows: run dependency install per the project's manifest/lockfile and the target repo's `CLAUDE.md` / `AGENTS.md`, any required build, and a cheap toolchain probe. Record the setup commands and exits.

   Then read the iteration's **runtime manifest** and require exactly one lifetime kind:
   - `durable`: verify `sourceSha`, stable `ownerRef`, and `livenessCommand` before re-driving `behaviorCommand`; lost ownership/liveness is a runtime failure.
   - `recreatable`: the old PID may be absent. Verify the pinned clean `sourceSha`, run `setupCommands`, `startCommand`, and `readinessCommand`, then re-drive `behaviorCommand`. Old PID absence alone is not a claim mismatch.

   Missing, mixed, or unknown kind is an iteration packet failure. Never infer lifetime from prose or PID presence.
3. **Canonical test suite (head count).** Run the canonical full-suite command named in the target repo's `CLAUDE.md` / `AGENTS.md` on the PR head, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and parse the head-side integer from the runner's own aggregated summary line (rule per `quality/evidence.md` — never a static `rg` / `grep` count of `test(` / `it(` declarations). Record command, integer, and log path. This is the review's head-side inventory measurement; a mismatch with the packet's published integer routes to investigation (evolving HEAD, dependency drift) per `quality/evidence.md`, not automatic credibility failure.
4. **Execute every marker Check.** Per check, by `Kind`:

   - `shell` — execute the literal command in the row's declared cwd/env; capture exit + output and compare to its expected exit/output. No auth/binary excuse: binaries you install, credentials you resolve from the manifest's location. A check you still cannot run means one of two things and you report which: your setup is unfinished (finish it), or the manifest lacks the needed entry (iteration packet failure — finding, not skip). Never mark an unrun check passed or reinterpret its command.
   - `browser` — execute inside the e2e re-drive walk in Step 5. Quote the stable ID, start/readiness, action, and expected observation; the actual observation lives in the Browser Checks table.
5. **E2E re-drive (direct).** Route exhaustively by the declared handoff kind. Durable reaches the declared owner and liveness surface; recreatable starts a new runtime from the pinned committed source. Any other shape is rejected before replay.

   Re-drive each e2e claim the same direct way it should have been produced:

   - Program / CLI / daemon claim → invoke the **real entry point the way an operator would**, exercising the claimed path; capture transcript + logs.
   - Web claim → walk the **real UI with agent-browser** end-to-end (enter, perform the flow, observe the persisted result); capture screenshots. The packet's screenshots corroborate but never substitute for your own walk.

   Deferred browser Checks are executed inside this walk: drive each stable Check ID's action, compare your observation to its expected observation, and record the verdict per ID.

   Record, per claim: the packet's claim next to your observation. Differences are recorded as differences — no severity labels, no "minor"/"cosmetic" wording; softening language violates this task.
6. **Form check.** A target-mandated canonical E2E driver is valid only when it exercises the real runtime/user path. Evidence from a substitute mock or harness-only path is a finding regardless of whether your own re-drive passed.
7. **Blocked-path e2e** (only when Step focus names it). Run the named command that exercises the previously blocked path end-to-end; record exit + output. Without this succeeding, the unblock cannot be accepted.

## Report

```markdown
## Replay strategy
<branch/state replayed against; how the runtime manifest was used (which entries, what
the declared handoff provided); which rows ran locally vs were artifact-verified vs
re-executed in their environment; what could not be attempted and why>

## Canonical suite (head)
head <count> (<command>, exit <n>, log <relative path>)
Setup performed: <install/build commands + exits>

## Check results
| ID | Kind | Check/action | Command or driven path | Actual (exit/output/ref) | Expected | Verdict |
|---|---|---|---|---|---|---|
<one line per marker Check — browser checks carry verdict
`observed in e2e re-drive (see Browser Checks below)`;
could-not-execute checks carry their exact cause>

## E2E re-drive
Handoff replayed: <durable owner/liveness result OR recreatable source/setup/start/readiness result>

| Claim (packet) | How I re-drove it | Observed | Match |
|---|---|---|---|
| <claim> | <real entry invocation / agent-browser walk> | <observation + artifact path> | yes / no |

## Browser Checks
| ID | Action | Driven how | Observed vs expected | Verdict |
|---|---|---|---|---|
<one line per deferred Check from Step focus — or a single row `none | - | - | - | -`
when none were deferred>

## Form check
<canonical driver and real runtime/user path, or the substitute mock/harness-only path (= finding)>

## Blocked-path e2e
<the named command + exit + output — or `not applicable (Step focus named none)`>

## Problems
<manifest gaps (exact missing entries); unrun Checks / claims with their two-shape cause
(unfinished setup with attempts shown / manifest gap); everything left running —
own processes and any durable/recreated runtime — with stop commands, for the orchestrator's sweep>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Check completeness** — every stable ID from marker `Checks` appears in `Check results` with an actual, a browser hand-off to `Browser Checks`, or an exact could-not-execute error. Any silently absent check invalidates the replay: send back for the missing IDs.
- **Execution truth** — shell Checks executed, not artifact-waved; actuals carry exit/output, not summaries of the packet's own claims. An unrun Check is legal in exactly two shapes: unfinished setup with attempts shown (→ send back to finish and run it), or a named manifest gap (→ iteration packet failure feeding retry). "No auth"/"no binary" with neither shape is a report defect — auth exists by construction.
- **Canonical suite present** — head count, command, exit, log path recorded per `quality/evidence.md`'s runner-summary rule; a static `rg` / `grep` count is a protocol violation.
- **E2E re-driven, not corroborated** — every e2e claim shows the subagent's own direct re-drive with its own artifacts; accepting the packet's screenshots/transcripts as the observation is not a replay — send it back.
- **Deferred checks closed** — every deferred browser Check appears in `Browser Checks` with an observed-vs-expected verdict from the real UI walk. Any absent stable ID → send back.
- **No auth/binary excuse** — an unre-driven claim is legal only as unfinished-setup or named manifest gap. Anything else → send back.
- **Manifest gaps** — iteration packet failures feeding retry; they never excuse the review.
- **Substitute-path E2E** — a form-check finding of mock or harness-only E2E is a packet failure → retry, even when the re-drive itself passed; a target-mandated driver that exercises the real path is valid.
- **No verdict smuggling** — mismatches reported raw; "minor"/"cosmetic" labels are a report defect (`quality/honesty.md` treats cosmetic-handwave as hard fail).
- **Side effects declared** for the cleanup ledger, including the durable/recreated runtime state.

Verdict formation: all non-deferred Checks matched + all e2e claims matched + no manifest gap + no form finding + blocked-path e2e passed (when applicable) → those contract Checks hold. Any implementation mismatch, missing artifact, manifest gap, substitute-path E2E, or failing blocked-path → retry citing every failing item at once. A malformed or intrinsically broken marker Check → contract-invalid and re-enrichment, never implementation retry.
