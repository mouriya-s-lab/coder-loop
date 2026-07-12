# Step: e2e

The e2e subagent for one coder-loop iteration. The deliverable is the formal deliverable evidence: the real thing run directly and one explicitly typed runtime handoff. Unit/integration results and acceptance-row outputs from verify are supporting layers only.

## Task

From your dispatch message: `ISSUE`, `REPO`, `RUN_ID`, `AGENT_CWD` (the issue-branch checkout — the verify step may be running in it at the same time, so you never build or run services there directly; Step 2 gives you your own worktree), `EVIDENCE_DIR`, `REQUIRE_BROWSER_EVIDENCE`, and `Step focus` — the changed path to exercise and the marker Checks whose `Kind` is `browser` (the orchestrator enumerates them by stable ID; verify defers the same checks to you). Read now, before Step 1: `{{PRESET_ROOT}}/quality/evidence.md` and `{{PRESET_ROOT}}/quality/cleanup.md` — they bind every run and side effect below, including the two-case auth rule.

**Claim gate.** No e2e claim without observing the end-to-end effect itself, fresh, this run: "started successfully" or a healthy port probe is startup evidence, not behavior evidence — every claim must point to the observed result (transcript, persisted state, screenshot) that backs it.

1. **Identify the surface and collect the deferred rows.** Decide what the deliverable actually is: a program / CLI / daemon, a web app, or a library (then its real consuming surface — "it is a library" is not an exemption). When `Step focus` names deferred browser rows, read the current executable-contract marker and quote each named browser check's action, observation, and expected result — those rows are yours to satisfy through the real UI walk.
2. **Start the environment.** First take your own worktree — the parallel verify step owns `AGENT_CWD`, and two agents installing/building in one checkout corrupt each other:

   ```bash
   E2E_WT="$(mktemp -d)/e2e"
   git -C <AGENT_CWD> worktree add --detach "$E2E_WT" <ISSUE_BRANCH or the branch checked out in AGENT_CWD>
   cd "$E2E_WT"   # all subsequent build/run work happens here
   ```

   Record the detached worktree and its exact clean source SHA. It may remain owned by a durable runtime, or serve as the immutable reconstruction source for a recreatable handoff.

   Stand the deliverable's runtime up for real: install what is missing, run required builds, start the services. Auth is yours to resolve per the two-case rule in `quality/evidence.md` — standalone program → mint the auth while starting the environment; service plugin → resolve the IaC-provisioned auth from this machine's stores. Neither auth nor binaries is ever a reason this step doesn't happen. Record every setup command and exit.
3. **Run the real thing, directly.**
   - Program / CLI / daemon → invoke its **real entry point the way an operator would** (real arguments, real config), exercise the path this issue changes, capture the command transcript and service logs.
   - Web app → drive the **real UI** end-to-end with agent-browser: enter, perform the changed flow, observe the persisted result; capture real screenshots. Each deferred browser row is executed inside this walk: drive the row's flow, compare what you observe to its Expect, record the verdict per row. `REQUIRE_BROWSER_EVIDENCE=true` forces browser evidence whenever the change has any browser-observable behavior.
   - **A script is valid only when target rules name it as the canonical driver and it exercises the real runtime/user path; substitute harness-only e2e is forbidden**: a test script/harness wrapping the calls is integration testing whatever its filename.

   A mismatch (observed ≠ expected, deferred row failing) is a result to record, not a thing to fix — you never patch product code. Mismatches reported raw, no softening.
4. **Choose exactly one runtime handoff kind and write the manifest.** This is a closed union; mixed or unstated lifetime is invalid.
   - `durable`: legal only when a supervisor/service manager owns the runtime beyond this phase. Record clean `sourceSha`, `worktree`, a stable `ownerRef` (systemd unit, container/stack id, daemon-owned resource), `livenessCommand`, `behaviorCommand`, `logPath`, and `stopCommand`. A bare child PID owned by this agent is **not durable**.
   - `recreatable`: use when the phase owns an ordinary child process or no process must remain. Stop phase-owned processes, then record clean `sourceSha`, `worktree`, and complete `setupCommands`, `startCommand`, `readinessCommand`, `behaviorCommand`, `logPath`, and `stopCommand`. The old PID is historical evidence only and MUST NOT be described as live or standing.

   Both kinds retain real auth resolution locations, real entry point, readiness, behavior, and teardown facts. The source SHA must equal the checked-out committed tree; dirty/uncommitted source is an invalid handoff.
5. **Land the artifacts and report.** Everything lands under `EVIDENCE_DIR`. You had no reason to commit, push, open PRs, or write GitHub/queue state — confirm you did not.

## Report

```markdown
## E2E run
Surface: program / web / consuming-surface-of-library
Setup: <install/build/start commands + exits, including how auth was minted/resolved
(location only, never the secret value)>
Entry driven: <the real command invoked as an operator would / the agent-browser path walked>
Observed: <the end-to-end behavior seen, with transcript/log/screenshot artifact paths>

## Browser acceptance rows
| Row | Check | Driven how | Observed vs Expect | Verdict |
|---|---|---|---|---|
<one line per deferred row from Step focus — or a single row `none | - | - | - | -`
when none were deferred>

## Runtime manifest
Handoff kind: durable / recreatable
Source SHA: <full committed SHA>
Worktree: <absolute path>
Binaries: <name + how installed — or `none beyond toolchain`>
Services: <start command per service — or `none`>
Auth: <resolution location only (keychain entry / config path) — never the secret value — or `none`>
Ports/env/fixtures: <list or `none`>
Durable ownership: <ownerRef + livenessCommand, only for durable; otherwise `not applicable`>
Recreation: <setupCommands + startCommand + readinessCommand, only for recreatable; otherwise `not applicable`>
Behavior/log/stop: <behaviorCommand + logPath + stopCommand>

## Artifacts
<path → what it proves, one line each>

## Problems
<mismatches observed; scratch processes stopped (and which were left up on purpose);
files written outside EVIDENCE_DIR — or `none` per item>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Real path or absent** — the `E2E run` section must show the real runtime/user path driven (operator-style program invocation, a target-mandated canonical driver that exercises that path, or an agent-browser walk of the real UI) with this run's own artifacts. A substitute mock or harness-only path is integration testing — treat the e2e as missing and send it back. Unit/integration results never substitute; "no auth"/"no binary" never excuses (evidence.md's two-case rule guarantees auth exists — a report claiming otherwise has skipped setup; send it back with the setup it owes).
- **Deferred Checks closed** — every `Kind=browser` stable ID from the dispatch's `Step focus` appears here with an observed-vs-expected verdict from the real UI walk (and once the verify report arrives, its deferred set must be covered too — same IDs by construction). A failing Check is a product failure: route back to implementation, then re-dispatch verify and e2e in parallel for the full contract.
- **Lifetime ADT is valid** — exactly one kind is declared. `durable` requires stable ownership plus liveness; `recreatable` requires setup/start/readiness and no live claim about the old PID. Missing, mixed, or extra-kind shapes are gaps.
- **Manifest re-runnable** — judge it by one question: could the review side either verify durable ownership or recreate from the pinned clean SHA using the manifest alone? Vague entries ("auth: configured") or secret values pasted inline are both gaps.
- **Mismatch honesty** — mismatches reported raw; cosmetic-handwave is a hard fail per `quality/honesty.md`.
- **Ownership matches cleanup** — durable runtime remains under its declared supervisor owner; recreatable phase-owned runtime is stopped and carries no standing claim. There is no third "happened to survive" state.
