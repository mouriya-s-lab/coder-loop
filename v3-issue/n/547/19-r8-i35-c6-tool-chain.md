# R8 recovery I-35 — C6 tool closed-loop owner/API investigation

**Baseline:** `mouriya-s-lab/coder-loop` `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
**Question:** locate the real owner/repo/API/event/store for C6 (`runtime tool enforcement + outcome achievement channel + run-fail enforcement`) and test whether a common identity spans `definition → tool → run → invocation → outcome → finalize → restart/recovery`.  
**Method:** read-only local-source inspection. Remote source was not read through GitHub APIs. `mouriya-s-lab/hapi-remote-session` was checked via repository metadata and then cloned locally; the clone is empty.

## A. Summary (≤1 page)

C6 has a real and unambiguous **planned owner**: the `mouriya-s-lab/coder-loop` repository, RFC [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545), implementation child [#597](https://github.com/mouriya-s-lab/coder-loop/issues/597). The declaration producer is sibling child [#553](https://github.com/mouriya-s-lab/coder-loop/issues/553). This is stronger than the earlier “external C6 owner unknown” wording: “external” means external to RFC #547’s delivery tree, not an unidentified external repository.

At the frozen baseline, the chain is **partially implemented but not closed**:

- The context tool’s write/outcome substrate exists in coder-loop: daemon socket commands `context.append.begin|chunk|commit`, credential-derived author `(chainId,itemId,runId,phase)`, and append-only SQLite `context_entries`.
- The declaration/tool half does not exist: there is no `[[tools]]` registry, `entry-existence` outcome ADT, or runtime `required|expected` declaration consumer. The two current `toolRequirements` occurrences are only a generic runtime binding declaration/default (`src/loop.ts:573,2946`), not the RFC registry.
- Invocation is not a separate persisted fact. Successful `context.append.commit` creates an entry; therefore “outcome achieved” can be derived by matching the entry author’s `runId`, but there is no call record for failed/aborted invocations.
- Run finalization currently completes the run and revokes the credential without evaluating any declared tool outcome (`src/scheduler.ts:1925-2200`; especially completion at 2052-2072 and final revoke at 2185-2190 in repository line numbering shown by local inspection).
- Restart recovery persists entries and reconciles unfinished runs as orphaned, but has no persisted C6 evaluation/finalization decision. Thus a crash around future outcome evaluation would need an explicit idempotent checkpoint/ordering contract; current code cannot supply it.

No other investigated repository supplies the missing common identity. Router `deliveryId/repository/issue/sessionId` and `consumed|not-consumed` describe delivery acceptance, not a coder-loop tool invocation/outcome. HAPI/OpenCode emits `sessionId + callId + tool name` call/result UI events and can resume a backend session, but has no coder-loop definition reference, run identity, `toolRequirements`, required outcome evaluation, or run-fail finalizer. HAPI helpers and the IaC consumer are launch/delivery wrappers. The remote-session repository is empty.

**Conclusion:** there is no implemented end-to-end common-identity chain at this baseline. The authoritative construction site is coder-loop #553 → #597, using the already landed context-entry substrate. TF-35 should not ask users to choose a repository or API: ownership is already documentary fact. It must instead record the unresolved implementation contract—how a pinned definition’s tool requirement is carried to the run, how `entry-existence` is evaluated and persisted atomically/idempotently before run completion and credential revocation, and how restart replays or recognizes that decision. E-class tool design must not substitute router/HAPI identities for coder-loop identity.

## B. Evidence and owner inventory

### B1. Normative ownership chain

| Layer | Real owner | Evidence | Baseline state |
|---|---|---|---|
| Declaration and compile | `mouriya-s-lab/coder-loop` [#553](https://github.com/mouriya-s-lab/coder-loop/issues/553), under RFC [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) | `AGGREGATE-547.md:127-140,244,288,317-321`; `v3/children-brief.md:21` | Planned/open; registry absent in source |
| Tool body and achievement substrate | `mouriya-s-lab/coder-loop` [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545), children [#594](https://github.com/mouriya-s-lab/coder-loop/issues/594) / [#595](https://github.com/mouriya-s-lab/coder-loop/issues/595) / [#596](https://github.com/mouriya-s-lab/coder-loop/issues/596) | Cached full issue body assigns tool body, outcome channel and enforcement to #545; local source has context append implementation | Write/storage foundation landed; read/group portions not established here as complete |
| Runtime required/expected evaluation and run-fail | `mouriya-s-lab/coder-loop` [#597](https://github.com/mouriya-s-lab/coder-loop/issues/597) | #545 child mapping explicitly says #597 consumes #594/#595/#553; #597 body names `attachRunCloseHandler` | Open and absent at baseline |
| Cross-tree acceptance | v3 integration gate, not C6 owner | `AGGREGATE-547.md:291,343,355`; `v3-issue/design/execution-orchestration.md:204,235` | Suspended until implementation joins |

This resolves the apparent ambiguity in `AGGREGATE-547.md:259`: “工具树 / #545” identifies an external **RFC tree in the same repo**, not a separate unknown service.

### B2. Candidate owner inventory (8 repositories)

| # | Repository / owner surface | Actual API, event, or store | Identity | Failure/restart behavior | C6 relation |
|---|---|---|---|---|---|
| 1 | `mouriya-s-lab/coder-loop` | daemon socket `context.append.begin/chunk/commit`; SQLite `context_entries`; scheduler run-close path | context author `{chainId,itemId,runId,phase}` plus entry id; runs also carry definition/task identity elsewhere | SQLite survives restart; unfinished runs reconciled orphaned; current close path revokes credential | **Authoritative owner and partial substrate; missing declaration→evaluation→finalize closure** |
| 2 | `mouriya-s-lab/github-hapi-agent-router` | signed HTTP push; JSON-file queue, delivery store, detection zone | `deliveryId`, repository/issue, optional HAPI `sessionId` | transport/not-consumed deferral and persisted queue recovery | Adjacent delivery machinery only; `consumed` is receiver acceptance, not tool outcome |
| 3 | `mouriya-s-lab/hapi` | session APIs/events; OpenCode hook translation to `tool-call` / `tool-call-result` | HAPI/backend `sessionId`, per-call `callId`, tool name | backend session resume; on resume failure starts a new session | Adjacent invocation telemetry; no coder-loop definition/run/finalize identity |
| 4 | `mouriya-s-lab/hapi-remote-session` | no source/API/store | none | none | Private repository exists but local clone reports an empty repository; cannot own C6 implementation |
| 5 | `mouriya-s-lab/github-hapi-iac-daemon` | `POST /github/events`, returns `consumed|not-consumed`, launches HAPI session | router delivery/issue and launched session | clean-workspace refusal causes router retry | Delivery consumer, not runtime tool enforcement |
| 6 | `mouriya-s-lab/hapi-runner-macos` | LaunchAgent wrapper around `hapi runner start-sync` | machine/runner process identity | launchd process restart | Packaging/process owner only |
| 7 | `mouriya-s-lab/hapi-open-session` | HAPI spawn/session/message APIs | HAPI machine/session | waits for active session; launcher-level errors | Session launcher only |
| 8 | `mouriya-s-lab/hapi-send-msg` | `POST /api/sessions/{id}/messages` | HAPI session id + message local id when scheduled | hub-owned scheduling | Message producer only |

Exact-string searches across all eight candidate sources found no `toolRequirements`, `entry-existence`, coder-loop tool outcome/finalize contract, or #545 C6 binding outside coder-loop. The helper repos were included to exhaust plausible launch/runtime owners rather than stopping at “not found.”

## B3. Coder-loop call/data chain at the frozen baseline

```mermaid
flowchart LR
  D["Pinned compiled definition"] -. "no [[tools]] / requirement model yet" .-> T["Context tool capability"]
  T --> A["context.append.begin"]
  A --> K["chunk(s)"]
  K --> C["context.append.commit"]
  C --> E["SQLite context_entries"]
  E --> O["Derivable: entry author.runId exists"]
  O -. "no outcome evaluator/checkpoint" .-> F["attachRunCloseHandler"]
  F --> R["complete run + clear current run"]
  R --> V["revoke run credential"]
  V --> X["startup orphan reconciliation"]
```

Concrete facts:

1. `src/context-entry.ts:12-15` defines the agent author as `(chainId,itemId,runId,phase)`.
2. `src/daemon.ts:1763-1765` registers the three mutation-credential-gated commands; `1769-1774` derives author from the admitted caller; `1909-1914` commits the entry.
3. `src/sqlite-state.ts:775-784` defines the append-only table; `2045-2063` inserts, lists by chain, and deletes on chain deletion. The only index is `(chain_id, created_at, id)`, so a future per-run outcome check either scans/parses authors or adds a first-class query/index.
4. There is no invocation table/event. Begin/chunk sessions are in-memory daemon state; only commit creates durable evidence. This is compatible with the defined outcome (“entry exists”), but it is not evidence that every attempted invocation is recoverable.
5. `src/scheduler.ts:1686-1694` mints/injects a run credential. The close path writes artifacts and completes/clears the run before credential revocation; no tool evaluation appears between them (`src/scheduler.ts:2034-2072`). Final cleanup revokes again idempotently (`2184-2190`).
6. `src/daemon.ts:2400-2430` reconciles open runs after restart as orphaned. It does not evaluate required tools or restore an in-progress tool-finalization decision.

### Identity coverage matrix

| Link | Present? | Current identity/evidence | Missing binding |
|---|---|---|---|
| definition → tool | No | none | pinned definition ref + tool definition id |
| tool → run requirement | No | none | per-phase requirement carried into spawned run |
| run → invocation | Partial | socket caller credential resolves run author | durable invocation identity/event absent |
| invocation → outcome | Partial | commit produces entry with same run author | explicit outcome instance/evaluation absent |
| outcome → finalize | No | current finalizer ignores entries | required/expected decision and run-fail mapping |
| finalize → restart/recovery | No | runs/entries persist separately; orphan reconciliation exists | atomic/idempotent evaluation checkpoint and replay rule |

Therefore the exact requested common chain does **not** exist. The strongest stable join presently available is `ContextAuthor.runId ↔ runs.run_id`; it begins only at a successful commit and cannot bridge backward to a declared tool or forward to a persisted finalization verdict.

## B4. Why adjacent systems cannot close the gap

### Router

`src/forwarder.ts:39-52` parses receiver outcomes `consumed|not-consumed`; `src/push-loop.ts:65-84` either moves a delivery into the detection zone or defers it. `src/queue-store.ts` persists `deliveryId`, event, target, attempts and retry time. This chain answers “did a consumer accept a GitHub task?”, not “did coder-loop run R achieve required tool outcome O?”. It lacks definition/tool/run/call identity.

### HAPI / OpenCode telemetry

`hapi/cli/src/opencode/opencodeLocalLauncher.ts:239-240,331-359,413-443` deduplicates tool-call and tool-result events by `callId`. `opencodeRemoteLauncher.ts:79-93` resumes by backend session id and falls back to a new session when resume fails. These are real invocation and recovery mechanics, but their identity is session/call scoped. No mapping exists to coder-loop `definitionRef`, phase requirement, run finalization, or SQLite context outcome. Importing them would introduce an adapter and semantics not demanded by the C6 contract; they are evidence of an adjacent protocol, not the owner.

### Launchers/wrappers

The IaC daemon, runner wrapper, open-session CLI, and send-message CLI operate before or around a HAPI session. None observes coder-loop context commits or owns coder-loop run completion. Their retry/restart behavior cannot enforce a per-run tool requirement.

## B5. Failure and recovery gaps that TF-35 must preserve

1. **Window closure:** outcome evaluation must occur after the last admitted commit and before (or atomically with) credential revocation/run completion. Current code has no such step.
2. **Crash consistency:** entries and runs are durable, but no durable evaluation record exists. A daemon crash between evaluation, run failure mutation, completion, and revoke would otherwise allow duplicate/missed enforcement.
3. **Idempotence:** restart must distinguish “not evaluated” from “evaluated missing/present.” Recomputing from append-only entries is possible only if the evidence window is already closed and the pinned requirement is recoverable.
4. **Pinned definition:** recovery cannot reload the mutable preset path and guess requirements. It must use the run/instance’s pinned definition identity.
5. **Expected vs required:** both consume the same outcome; only the consequence differs. `expected` emits a non-blocking validation event, while `required` enters the existing failure/backoff/exhausted path. They must not create separate outcome truths.
6. **Existing failure precedence:** #597 states that already failing/rate-limited runs retain existing semantics. The finalizer needs an explicit composition rule rather than overwriting exit/rate-limit facts.
7. **No provider shortcut:** `provider=engine` does not prove achievement. The evaluator must switch on the declared outcome variant (`entry-existence`), consistent with RFC #547.
8. **No body inspection:** existence is the outcome. Content, call logs, HAPI UI events, or router acceptance cannot substitute.

## B6. Constraints for E-class tool design

- Model a stable tool definition id and closed outcome ADT in the compiled/pinned definition; do not branch on raw tool names.
- Bind each spawned run to the exact phase requirement slice from that pinned definition.
- For `entry-existence`, query durable context entries by typed agent author/run identity. If stored author remains JSON, add a typed store method and prove its query/index behavior rather than leaking JSON parsing into the scheduler.
- Persist an outcome evaluation/finalization record or make one atomic transaction cover evaluation and run consequence. The design must state the authoritative replay rule after `kill -9`.
- Keep invocation telemetry optional: the required claim is outcome achievement, not “a process emitted a call event.” Failed begin/chunk is not a successful outcome.
- Emit structured validation/audit facts containing definition/tool/run/outcome identity, without entry body or credentials.
- Keep gate execution separate. Tool enforcement consumes tool declarations; it must not be folded into script/join gate executors.
- Do not couple to HAPI/router session and delivery ids. An adapter may correlate them for observability later, but they cannot become the C6 primary key.

## B7. Remaining unknowns (implementation questions, not owner questions)

- The exact compiled artifact field names and stable tool-definition identity are owned by open #553 and are not present at this baseline.
- The read/filter API from #595 is not established as landed; current store exposes only chain-wide listing. C6 needs a store-level exists-by-author operation regardless of GUI read shape.
- The exact structured validation event variant for missing `expected|required` outcome remains unspecified in source.
- The atomicity boundary among outcome evaluation, existing run completion, item backoff mutation, and credential revocation remains to be designed in #597.
- Whether an outcome verdict is stored per tool requirement, per run, or inside the run completion record is undecided. The recovery invariant, not a user preference, must decide it.

## Tail conclusion

**Owner is known; closed loop is not implemented.** C6 belongs to `mouriya-s-lab/coder-loop` #545/#597 and consumes #553 declarations. The landed context append/store path supplies `run → committed entry`, but no stable identity spans `definition → tool → run → invocation → outcome → finalize → restart/recovery`. Router and HAPI provide adjacent delivery/session/call mechanisms with incompatible identities and must not be presented as alternate C6 owners. TF-35 should bind the missing coder-loop API/store/recovery contract, not ballot repository ownership.
