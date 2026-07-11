# Step: replay (review)

A replay subagent for one coder-loop review. The review orchestrator trusts what you independently re-execute, not what the iteration claimed. One subagent does all of: canonical test command real run, acceptance-row execution, e2e re-drive through the declared runtime handoff, and the deferred browser rows the row-plan defers to you. You verify; you never repair — at no step below do you modify product code, tests, or the PR; if something fails, the failure **is** the result.

## Task

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `AGENT_CWD` (work there), `TARGET_CWD`, `EVIDENCE_DIR`, and `Step focus` — which acceptance rows, which packet claims, which browser rows to observe; when the issue's deliverable is unblocking another issue, the `Step focus` names the blocked-path e2e command. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` for project install / build / test commands and PR conventions; plus `{{PRESET_ROOT}}/quality/evidence.md` — it binds your own executions (real paths, text logs, PID discipline, artifacts under `EVIDENCE_DIR`; the runner-summary parse rule for the canonical suite count).

1. **Parse the contract tables.** Fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`). Parse the `## 验收标准` table (columns `#`, `Dimension`, `Check`, `Command`, `Env`, `Expect`) and the `## 继承验证义务` table when present; concatenate the rows. A malformed table (wrong columns/headers) is itself a finding — record and stop parsing that table. Enumerate **every** row; a silently absent row invalidates your whole report.
2. **Make the checkout runnable, read the manifest.** Check out / use the PR-bound branch state in your working directory (record the head SHA). A fresh checkout has nothing installed — making it runnable is your job, not a reason to skip rows: run dependency install per the project's manifest/lockfile and the target repo's `CLAUDE.md` / `AGENTS.md`, any required build, and a cheap toolchain probe. Record the setup commands and exits.

   Then read the iteration's **runtime manifest** and require exactly one lifetime kind:
   - `durable`: verify `sourceSha`, stable `ownerRef`, and `livenessCommand` before re-driving `behaviorCommand`; lost ownership/liveness is a runtime failure.
   - `recreatable`: the old PID may be absent. Verify the pinned clean `sourceSha`, run `setupCommands`, `startCommand`, and `readinessCommand`, then re-drive `behaviorCommand`. Old PID absence alone is not a claim mismatch.

   Missing, mixed, or unknown kind is an iteration packet failure. Never infer lifetime from prose or PID presence.
3. **Canonical test suite (head count).** Run the canonical full-suite execution through the phase's declared host-resource critical section: prefix the complete, otherwise unchanged command with `coder-loop resource run canonical-verification --`. The wrapper may wait for another chain, but after acquisition it executes the original command once and releases immediately when that command exits; setup, metadata reads, row planning, diff work, e2e replay, and report writing remain outside the critical section. Run the canonical full-suite command named in the target repo's `CLAUDE.md` / `AGENTS.md` on the PR head, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and parse the head-side integer from the runner's own aggregated summary line (rule per `quality/evidence.md` — never a static `rg` / `grep` count of `test(` / `it(` declarations). Record command, integer, and log path. This is the review's head-side inventory measurement; a mismatch with the packet's published integer routes to investigation (evolving HEAD, dependency drift) per `quality/evidence.md`, not automatic credibility failure.
4. **Execute every acceptance row.** Per row, by Env:

   - `local` — execute the Command exactly as written; capture exit + output; compare to Expect. No auth/binary excuse: binaries you install, credentials you resolve from the manifest's location. A row you still cannot run means one of two things and you report which: your setup is unfinished (finish it), or the manifest lacks the needed entry (iteration packet failure — finding, not skip). Never mark an unrun row passed, never reinterpret the Command.
   - `browser` — execute inside the e2e re-drive walk in Step 5. When `Step focus` names deferred browser rows, quote each named row's Check, Command, and Expect here; the actual observation lives in the Browser acceptance rows table.
   - `VM` / `container` / `CI` / `downstream` / `integration` — locate the matching artifact in the PR evidence packet proving the row ran in its environment with the expected result; where this machine reaches the environment (per the manifest), also re-execute for the stronger signal. No matching artifact and no feasible re-execution = the row failed; cite the missing artifact.
5. **E2E re-drive (direct).** Route exhaustively by the declared handoff kind. Durable reaches the declared owner and liveness surface; recreatable starts a new runtime from the pinned committed source. Any other shape is rejected before replay.

   Re-drive each e2e claim the same direct way it should have been produced:

   - Program / CLI / daemon claim → invoke the **real entry point the way an operator would**, exercising the claimed path; capture transcript + logs.
   - Web claim → walk the **real UI with agent-browser** end-to-end (enter, perform the flow, observe the persisted result); capture screenshots. The packet's screenshots corroborate but never substitute for your own walk.

   Deferred browser acceptance rows are executed inside this walk: drive the row's flow, compare your observation to its Expect, record the verdict per row.

   Record, per claim: the packet's claim next to your observation. Differences are recorded as differences — no severity labels, no "minor"/"cosmetic" wording; softening language violates this task.
6. **Form check.** If the packet's e2e was produced by a test script/harness instead of direct execution, that is a finding regardless of whether your own re-drive passed: script e2e does not satisfy the e2e requirement.
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

## Row results
| Row | Check | Command/artifact | Actual (exit/output/ref) | Expect | Verdict |
|---|---|---|---|---|---|
<one line per acceptance + inherited row — browser rows carry verdict
`observed in e2e re-drive (see Browser acceptance rows below)`;
could-not-execute rows carry their exact cause>

## E2E re-drive
Handoff replayed: <durable owner/liveness result OR recreatable source/setup/start/readiness result>

| Claim (packet) | How I re-drove it | Observed | Match |
|---|---|---|---|
| <claim> | <real entry invocation / agent-browser walk> | <observation + artifact path> | yes / no |

## Browser acceptance rows
| Row | Check | Driven how | Observed vs Expect | Verdict |
|---|---|---|---|---|
<one line per deferred row from Step focus — or a single row `none | - | - | - | -`
when none were deferred>

## Form check
<e2e evidence produced by direct execution / by script-harness (= finding, name the script)>

## Blocked-path e2e
<the named command + exit + output — or `not applicable (Step focus named none)`>

## Problems
<manifest gaps (exact missing entries); unrun rows / claims with their two-shape cause
(unfinished setup with attempts shown / manifest gap); everything left running —
own processes and any durable/recreated runtime — with stop commands, for the orchestrator's sweep>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Row completeness** — every row of both acceptance tables appears in `Row results` with an actual, a browser-row hand-off to `Browser acceptance rows`, or an exact could-not-execute error. Any silently absent row invalidates the replay: send back for the missing rows.
- **Execution truth** — locally-runnable rows executed, not artifact-waved; actuals carry exit/output, not summaries of the packet's own claims. An unrun row is legal in exactly two shapes: unfinished setup with attempts shown (→ send back to finish and run it), or a named manifest gap (→ iteration packet failure feeding retry). "No auth"/"no binary" with neither shape is a report defect — auth exists by construction.
- **Canonical suite present** — head count, command, exit, log path recorded per `quality/evidence.md`'s runner-summary rule; a static `rg` / `grep` count is a protocol violation.
- **E2E re-driven, not corroborated** — every e2e claim shows the subagent's own direct re-drive with its own artifacts; accepting the packet's screenshots/transcripts as the observation is not a replay — send it back.
- **Deferred rows closed** — every deferred browser row appears in `Browser acceptance rows` with an observed-vs-Expect verdict from the real UI walk. Any absent row → send back.
- **No auth/binary excuse** — an unre-driven claim is legal only as unfinished-setup or named manifest gap. Anything else → send back.
- **Manifest gaps** — iteration packet failures feeding retry; they never excuse the review.
- **Script e2e** — a form-check finding of script-produced e2e is a packet failure → retry, even when the re-drive itself passed.
- **No verdict smuggling** — mismatches reported raw; "minor"/"cosmetic" labels are a report defect (`quality/honesty.md` treats cosmetic-handwave as hard fail).
- **Side effects declared** for the cleanup ledger, including the durable/recreated runtime state.

Verdict formation: all non-deferred rows matched + all e2e claims matched + no manifest gap + no form finding + blocked-path e2e passed (when applicable) → those contract rows hold. Any mismatch/missing artifact/broken Command/manifest gap/script-e2e/failing blocked-path → retry citing every failing item at once.
