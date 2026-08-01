# RFC #545 R7 D-05 — read identity / command authorization wiring audit

Fixed baseline: `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` (verified before inspection). This report only investigates present command classification, CLI credential injection, daemon caller resolution, chain selectors, and the falsifiable test seam for a future context read. It does not define or implement that read.

## A. Main-agent summary

1. **There is no context read to attack or validate.** The present daemon union has 21 commands and ends at `context.append.{begin,chunk,commit}`; no context query/read command or CLI response boundary exists. Therefore this report does not claim a context-read privilege escalation has occurred.

2. **The present authorization system has two independent command lists, and they have already drifted.** The daemon has a closed `DaemonCommandName` union, an exact `DAEMON_COMMAND_NAMES` tuple, and a `Record<DaemonCommandName, DaemonCommandSpec>` auth table. Missing a daemon command/spec is a compile failure. The CLI separately uses `AGENT_ATTRIBUTED_COMMANDS`; it is only a subset and has no type- or runtime equality check against commands whose auth gate needs caller identity.

3. **The drift is not merely hypothetical:** `chain.updateBindings` is `hard-deny-for-agent` in the daemon but absent from `AGENT_ATTRIBUTED_COMMANDS`. In an isolated real daemon, invoking `coder-loop chain set-runner-model` with `CODER_LOOP_RUN_CRED=fabricated` succeeded, changed `chain.metadata.codex.model`, and emitted `privileged_op.caller_admission` with `subject=operator, reason=operator`. The CLI dropped the env credential, so the daemon saw “field absent” and classified the caller as operator. This is an existing command-wiring bypass, not a claim about nonexistent context read.

4. **`read-no-auth` does not mean “agent-readable but chain-bound.”** Its daemon gate returns without resolving `agentCredential`; present examples accept a caller-selected chain. Direct socket probes with an explicit fabricated credential successfully returned arbitrary `chain.status` and `item.list`, because those handlers neither consume nor reject the field. `item.exits` rejects a directly supplied credential as an unknown argument, but its CLI intentionally omits the env credential and accepts a caller-supplied fake `agentRunId` plus phase. These are public inspection commands, so this is their present contract, not a context-read violation. They prove that this class cannot enforce D3/S15 chain confinement.

5. **The “operator” trust boundary is absence of one JSON field, not an OS account, socket peer credential, session, or capability.** `resolveItemMutationCaller` maps `args.agentCredential === undefined` directly to `{kind:"operator"}`. The server does not inspect Unix peer UID/PID. It creates the root/socket with ordinary recursive mkdir/listen and no explicit chmod; the isolated run produced root and socket mode `0755`, owned by the launching user. At minimum every same-user process able to connect can send a raw request omitting the field and obtain the operator branch. CLI auto-injection is a convenience/discipline boundary, not a hostile-client security boundary.

6. **Credential identity itself is precise once resolution is actually invoked.** Mint stores an opaque UUID in an in-memory registry bound to `{chainId,item rowId,runId,phase}`; CLI injection reads `CODER_LOOP_RUN_CRED`; daemon lookup rejects wrong type/empty, unknown, and inactive runs; successful resolution ignores caller claims and yields the registry binding. Revoke deletes the binding; daemon restart loses the registry. Context append then compares selected chain to bound chain and derives author from the binding. The existing integration test passed all five cases and includes active success, unknown, inactive, cross-chain, and session-owner mismatch.

7. **Explicit chain selectors do not provide authorization by themselves.** `resolveChain` accepts `chainId` or `chainName`; if both are present it requires they resolve to the same chain. `resolveItem` with a string item ID first resolves the caller-selected chain; a numeric row ID is globally resolved and disallows redundant chain selectors only in some request validators. Chain-bound mutation/context handlers compare the resulting chain/item with credential binding. `read-no-auth` handlers do not. Thus selector consistency prevents ambiguous addressing, not cross-chain access.

8. **Audit and consumers reflect the same split.** Hard-deny/per-phase gates emit `privileged_op.caller_admission`; mutation handlers own bespoke audits; `read-no-auth` emits no caller-admission audit. Current context consumers only cover append/store internals; no GUI/hook/socket read consumer exists. A future read classified or wired incorrectly could therefore be both cross-chain and unaudited depending on its chosen class/handler, but that is a falsifiable wiring risk, not an observed future API behavior.

9. **Tests share the blind spot.** Daemon tests often call `sendDaemonRequest` and manually attach a credential, proving daemon behavior but bypassing CLI injection. CLI tests prove hard-deny injection for selected old commands and happy-path `set-runner-model`, but no test runs `set-runner-model` under `CODER_LOOP_RUN_CRED`; no test or type assertion relates auth class to the CLI tuple. The isolated experiment falsified the implicit completeness assumption.

### Root-cause set and determinate consequences

- **R1 — identity is optional wire data:** absent field deterministically becomes operator. Consequence: any caller path that omits it reaches operator semantics.
- **R2 — daemon auth and CLI attribution are independently maintained:** daemon completeness is compiled; CLI completeness is not. Consequence: a newly or later-added gated command can compile and ship while the CLI strips agent identity; `chain.updateBindings` proves it already happened.
- **R3 — `read-no-auth` intentionally bypasses identity resolution:** consequence: it cannot derive the credential’s chain, reject stale/unknown credentials, or distinguish operator/agent.
- **R4 — selectors and identity are separate:** `resolveChain` validates address consistency, but only a credential-aware handler compares selected chain with bound chain. Consequence: caller-controlled target survives unless the handler explicitly confines it.
- **R5 — tests exercise daemon and CLI seams separately:** consequence: both suites can be green while their composition misclassifies the caller.

### D-04 usable construction facts

For D-04’s public-read experiment, the decisive construction is: create chains A/B; obtain a live credential bound to A; invoke the candidate read through the **real CLI** while explicitly selecting B; separately invoke the raw socket with the same credential selecting B; then repeat with no credential. Assert not just result rows but whether the credential appeared on wire, resolved caller kind/chain, boundary response, and any audit. A daemon-only request with a manually supplied credential cannot prove CLI wiring. A fabricated env credential is a cheap discriminator: `unknown-credential` proves injection/reolution occurred; success proves it was omitted or ignored. Do not use `read-no-auth` success as evidence of agent confinement.

## B. Evidence appendix

### B1. Exhaustive present command → auth → CLI credential mapping

| Daemon command | Daemon auth class | CLI auto-injects env credential | Selected target / handler identity behavior | Determinate omission result |
|---|---|---:|---|---|
| `chain.create` | hard-deny | yes | no existing chain | agent/fake reaches resolver; omission is operator |
| `chain.list` | read-no-auth | no | all chains | identity not resolved |
| `chain.status` | read-no-auth | no | caller `chainId/name` | arbitrary selected chain; identity not resolved |
| `chain.stop` | hard-deny | yes | caller chain | agent denied; omission operator |
| `chain.resume` | hard-deny | yes | caller chain | agent denied; omission operator |
| `chain.delete` | hard-deny | yes | caller chain | agent denied; omission operator |
| `chain.updateBindings` | hard-deny | **no (drift)** | caller chain | real CLI agent env is omitted and operation is admitted as operator |
| `item.add` | mutation-gated | yes | caller chain | bespoke caller + phase rights |
| `item.batchAdd` | mutation-gated | yes | caller chain | bespoke caller + phase rights |
| `item.list` | read-no-auth | no | caller chain | arbitrary selected chain; identity not resolved |
| `item.update` | mutation-gated | yes | selected item/chain | active credential must own row item; omission operator |
| `item.reorder` | per-phase | yes | selected item/chain | active phase grant required; omission operator |
| `item.exits` | read-no-auth | no | selected item plus caller-claimed run/phase | run claim is not credential-checked; CLI env omitted |
| `item.exitAction` | mutation-gated | yes | selected item/chain | credential and claimed run/phase must match |
| `daemon.status` | read-no-auth | no | daemon-wide | identity not resolved |
| `daemon.down` | hard-deny | yes | daemon-wide | agent denied; omission operator |
| `logs.query` | hard-deny | yes | cross-chain event stream | agent denied; omission operator |
| `queue.unblock` | hard-deny | yes | caller chain/item | agent denied; omission operator |
| `context.append.begin` | mutation-gated | yes | caller chain/scope | active agent selected chain must equal bound chain |
| `context.append.chunk` | mutation-gated | yes | session ID | active caller must own session |
| `context.append.commit` | mutation-gated | yes | session ID | active caller must own session |

Counts: 21 total = 8 hard-deny + 1 per-phase + 7 mutation-gated + 5 read-no-auth. CLI tuple contains 15 commands: all 7 mutation, the per-phase command, and only 7 of 8 hard-deny commands. `chain.updateBindings` is the sole present hard-deny omission.

Source: `src/daemon.ts:161-205,1725-1766,1920-2120,5731-5818`; `src/loop.ts:2487-2556`.

### B2. Identity chain

1. Scheduler spawn mints through `buildSchedulerRunCredentialIssuer`; the registry stores UUID → copied `SchedulerRunCredentialContext`.
2. Spawn puts the value in `CODER_LOOP_RUN_CRED`.
3. `requestDaemonResult` calls `withInjectedRunCredential`.
4. Injection happens only if command belongs to the private tuple and does not overwrite an explicit request field.
5. `resolveItemMutationCaller`:
   - field absent → operator;
   - present but non-string/empty → missing;
   - unregistered → unknown;
   - registered but run absent from active scheduler slots → inactive and evicted;
   - active → agent with registry-bound chain/row item/run/phase.
6. Context author conversion verifies selected chain equals binding, resolves row item to business item ID, then constructs the agent author. Client `author` at begin is rejected.
7. Revoke deletes the registry record; restart clears the in-memory registry and append sessions.

Sources: `src/scheduler.ts:416-433,1565-1706`; `src/loop.ts:2487-2556`; `src/daemon.ts:1769-1775,1819-1917,3949-3996,4381-4395`.

### B3. Operator/no-credential trust boundary

- Protocol rule: absence of `agentCredential`, not “valid operator credential,” creates operator.
- No peer-credential call (`getpeereid`/`SO_PEERCRED`) or operator token exists in the server request path.
- Socket is chosen from caller-controlled/default `loopDataRoot`; start uses `mkdir(...,{recursive:true})` and `server.listen(path)` without an explicit restrictive chmod.
- Isolated observation: `/tmp/rfc545-d05/live-1785432352` and its `daemon.sock` were both mode `0755`, owner `mouriya:wheel`.
- Therefore the exact minimum trust boundary is “a process that can connect to this socket and omit the JSON field.” Same-user spawned agents satisfy that ability through the shipped CLI/socket surface. Whether a different OS user can connect is platform permission behavior and deployment umask/ACL dependent; this report does not generalize beyond the observed modes.

Sources: `src/daemon.ts:1245-1250,1567-1570,1698-1722,1949-1999,3949-3961,6087-6105`; isolated `stat` output.

### B4. Selector precedents: override, discard, validation

- `resolveChain`: `chainId` wins as the first lookup; if a name is also supplied it is not discarded—it must resolve to the same ID, otherwise `invalid_request`; either selector alone is accepted.
- `requestedChainName`: `chainName` and legacy/name alias must agree if both exist.
- `resolveItem`: numeric row ID globally resolves without chain; string ID requires a chain selector. `validateItemUpdateSelector` rejects chain selectors alongside numeric row ID for request types that invoke it.
- Credential-aware examples:
  - context begin resolves target then `resolveContextAuthor` rejects bound-chain mismatch;
  - item update resolves item then rejects bound row-item mismatch;
  - per-phase reorder resolves credential first, then selected item/chain/preset for rights.
- Non-credential examples:
  - `chain.status` and `item.list` accept caller chain;
  - `item.exits` accepts caller item and caller phase; `agentRunId` is required but is not used to establish caller identity.

Sources: `src/daemon.ts:1769-1775,1940-2119,3293-3340,3541-3588,4034-4105,5383-5389`.

### B5. Experiments

All experiments used isolated `/tmp/rfc545-d05/`; no production DB/config was touched.

#### E1 — real CLI composition exposes the existing tuple drift

Commands:

```sh
bun src/loop.ts daemon up --loop-data-root /tmp/rfc545-d05/live-1785432352 --json
bun src/loop.ts chain create d05-a \
  --config-json '{"repository":"mouriya-s-lab/coder-loop"}' \
  --preset single-phase-example \
  --loop-data-root /tmp/rfc545-d05/live-1785432352 --json
CODER_LOOP_RUN_CRED=fabricated bun src/loop.ts chain set-runner-model d05-a \
  --kind codex --model d05-model \
  --loop-data-root /tmp/rfc545-d05/live-1785432352 --json
```

Observed: exit 0; metadata became `codex.model=d05-model`; audit event `op=chain.updateBindings`, `subject.kind=operator`, `reason=operator`. A fabricated credential would have produced `unknown-credential` if injected. This directly proves omission and operator misclassification.

Evidence: `/tmp/rfc545-d05/audit.json`.

#### E2 — present `read-no-auth` ignores identity

Raw socket requests supplied `agentCredential:"fabricated"`:

- `chain.status {chainName:"d05-a"}` → success with chain/items.
- `item.list {chainName:"d05-a"}` → success.
- `item.exits {...,agentCredential:"fabricated"}` → handler rejected the extra field because its known-key set excludes credential.
- `logs.query {agentCredential:"fabricated"}` → `invalid_caller/unknown-credential`, proving hard-deny actually resolves it.

Real CLI:

```sh
CODER_LOOP_RUN_CRED=fabricated bun src/loop.ts item exits d05-a \
  --issue x --agent-run-id not-a-real-run --agent-phase run \
  --loop-data-root /tmp/rfc545-d05/live-1785432352 --json
```

Observed: success and phase exits returned. This distinguishes “direct credential rejected as extra field” from “CLI actually attributes agent.”

Evidence: `/tmp/rfc545-d05/probe.ts`, `/tmp/rfc545-d05/probe.out`.

#### E3 — existing closest-equivalent credential lifecycle test

```sh
bun test ./tests/integration/daemon/context.integration.ts
```

Observed: 5 pass, 0 fail, 54 assertions. Its first case drives a real active credential through:

- own-chain append success and derived agent author;
- empty/unknown rejection;
- no-credential chunk against agent session → session-owner mismatch;
- active credential selecting another chain → cross-chain rejection;
- stopped/inactive run registration → inactive rejection.

This proves the resolver/handler mechanism when invoked. It does not prove future read or CLI tuple completeness.

Evidence: `/tmp/rfc545-d05/context-test.out`; test source `tests/integration/daemon/context.integration.ts:4-87`.

### B6. Future read minimum discriminating experiment (no implementation supplied)

Once a real read exists, the smallest experiment that distinguishes all required identities is:

| Case | Invocation seam | Target | Required observation |
|---|---|---|---|
| operator | real CLI, env absent | A then B | both allowed; boundary-parsed JSON |
| valid agent | real CLI, live cred for A | A | allowed; on-wire credential proven |
| cross-chain | same CLI/live cred | B explicitly | denied or target replaced with A according to the eventual declared request contract; never B rows |
| unknown | real CLI, fabricated env | A | `unknown-credential` (if identity required); success falsifies injection/resolution |
| inactive | real CLI, revoked cred | A | inactive/unknown rejection |
| session/run mismatch | raw socket + live A cred plus any caller run/phase fields | A | registry identity wins; caller claim rejected/ignored per typed boundary |
| raw omission | raw socket, field absent, launched from agent-capable process | B | documents the actual operator trust boundary separately from CLI discipline |

For each case, capture: request JSON at daemon seam (or a discriminating error), result rows and chain IDs, response parser success, audit subject/outcome if the future class requires audit, and DB/store ground truth. Repeat through raw socket because CLI-only success cannot distinguish handler confinement from client-side selector rewriting. Repeat through real CLI because daemon-only manual credentials cannot detect the known tuple failure.

### B7. Audit / consumer inventory

- `hard-deny-for-agent` and `per-phase-authorized`: exactly one `privileged_op.caller_admission` verdict on normal gate paths.
- `mutation-credential-gated`: top gate deliberately does nothing; each handler must resolve/audit. Context append uses `context.write_admission`; item operations use their own event families.
- `read-no-auth`: no caller resolution and no caller-admission audit.
- Context public consumer: append CLI only. Internal `listContextEntries(chainId)` is store-level full-chain read, used by tests/migration-oriented code, not a socket contract.
- No repository GUI/hook context-read consumer or arktype query result contract exists. D-04 must not infer a consumer shape from current chain/item inspection JSON.

### B8. Test blind spots / shared-failure modes

1. No compile assertion derives CLI attribution need from `DaemonCommandSpec.authClass`.
2. No runtime table test iterates all 21 commands under fabricated/live env credentials through the real CLI.
3. Daemon tests manually set `agentCredential`, bypassing `withInjectedRunCredential`.
4. `set-runner-model` tests cover operator happy path and parser rejection only; they lock in product behavior while missing its hard-deny composition.
5. `read-no-auth` tests describe these ops as “untouched” and generally omit credentials, so they cannot show whether a future agent-readable read is chain-confined.
6. `item.exits` tests can pass with self-reported run ID because the handler only uses phase; the name `agentRunId` creates stronger identity appearance than the implementation provides.
7. Audit tests can faithfully report `operator` after a CLI omission; correct audit serialization does not mean correct upstream identity.

### B9. Evidence index

| Fact | Evidence |
|---|---|
| command/auth closed unions | `src/daemon.ts:130-205` |
| exact daemon auth table | `src/daemon.ts:1725-1766` |
| authorization gate behavior | `src/daemon.ts:1920-2120` |
| no context read command | `src/daemon.ts:183-208,5731-5753`; `src/loop.ts:1977-1985` |
| CLI injection tuple/drift | `src/loop.ts:2487-2556` |
| operator/agent resolver | `src/daemon.ts:3949-3996` |
| mint/revoke registry | `src/daemon.ts:4381-4395` |
| context chain/session binding | `src/daemon.ts:1769-1917` |
| chain/item selector rules | `src/daemon.ts:3541-3588,5383-5389` |
| item.exits caller claims | `src/daemon.ts:3293-3340`; `src/loop.ts:2310-2317` |
| exact daemon command tuple | `src/daemon.ts:5731-5767` |
| test blind spot for update bindings | `tests/integration/cli/smoke.integration.ts:54-130` |
| credential lifecycle equivalent | `tests/integration/daemon/context.integration.ts:4-87` |
| live composition evidence | `/tmp/rfc545-d05/probe.out`, `/tmp/rfc545-d05/audit.json`, command outputs above |

## Complete handoff

This audit covers every current daemon command and auth class; both daemon and CLI classification mechanisms; mint/inject/lookup/active/revoke identity; chain and item selector precedents; no-credential Unix-socket/operator trust; valid, unknown, inactive, cross-chain, session mismatch, and operator paths through existing equivalent commands; audit and consumer behavior; test/shared-blind-spot analysis; deterministic root causes; and a future-read experiment that can falsify CLI or handler confinement without inventing the API. The only new product fact found is the reproducible `chain.updateBindings` CLI attribution omission; it should be carried as a present wiring defect, not misreported as context-read escalation.
