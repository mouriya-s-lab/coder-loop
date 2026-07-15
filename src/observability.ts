import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises"
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { type as arkType } from "arktype"

import { ContextWriteAdmissionPayloadBoundary } from "./context-entry"
import type { ItemRecord } from "./sqlite-state"

const SubjectBoundary = arkType.or(
	{ kind: arkType.unit("engine") },
	{ kind: arkType.unit("operator") },
	{ kind: arkType.unit("agent"), runId: "string", phase: "string" },
)

export const ObservabilityKindBoundary = arkType.or(
	arkType.unit("audit"),
	arkType.unit("decision"),
	arkType.unit("lifecycle"),
	arkType.unit("validation"),
	arkType.unit("diagnostic"),
)

export const ObservabilityEventTypeBoundary = arkType.or(
	arkType.unit("chain.layout"),
	arkType.unit("chain.status"),
	arkType.unit("item.created"),
	arkType.unit("item.status"),
	arkType.unit("item.reordered"),
	arkType.unit("queue.terminal"),
	arkType.unit("item.dependency_unblocked"),
	arkType.unit("slot.busy"),
	arkType.unit("item.dependency_wait"),
	arkType.unit("item.backoff"),
	arkType.unit("chain.complete_trigger"),
	arkType.unit("daemon.start"),
	arkType.unit("daemon.stop"),
	arkType.unit("daemon.stop.terminated_runs"),
	arkType.unit("daemon.socket.rebind"),
	arkType.unit("daemon.fatal"),
	arkType.unit("daemon.preset_load_failed"),
	arkType.unit("scheduler.recovery"),
	arkType.unit("agent.spawn"),
	arkType.unit("agent.exit"),
	arkType.unit("phase.start"),
	arkType.unit("phase.end"),
	arkType.unit("chain.completed"),
	arkType.unit("attempt.timeout"),
	// #462: startup idle reclaim. Distinct type from `attempt.timeout` so observers
	// classify early zero-output kills separately from the absolute attempt-timeout
	// floor. Payload exposes the threshold (idleTimeoutMs) and observed bytes
	// (stdoutBytes) at kill time for post-mortem.
	arkType.unit("run.startup_idle_kill"),
	// #478: account-level rate-limit observed on a run's stdout. Distinct lifecycle type so
	// observers separate it from `attempt.timeout` (absolute floor) and from generic
	// `agent.exit` failures. The payload exposes the reset Unix timestamp + ISO + the
	// rate-limit category (`five_hour` / `seven_day` / null) so an auditor can identify
	// which budget tripped without re-reading the run logs.
	arkType.unit("scheduler.rate_limited"),
	// #452: recycle-zone lifecycle. `pending_entered` arms on a successful agent state
	// write; `timeout_kill` fires when the window elapsed without natural exit and the
	// engine SIGKILLed the process group; `natural_exit` records that the child closed
	// during the recycle window without timeout. Replaces the retired stdout-summary
	// watchdog (`watchdog.armed` / `watchdog.fire`).
	arkType.unit("recycle.pending_entered"),
	arkType.unit("recycle.timeout_kill"),
	arkType.unit("recycle.natural_exit"),
	arkType.unit("spawn.aborted"),
	arkType.unit("session_id.invalidated"),
	arkType.unit("chain.invalid"),
	arkType.unit("preset.placeholder_check"),
	// #408: per-finding emission from the cross-table preset DAG checker. One
	// event per `PresetDagFinding` the checker returned during a daemon-driven
	// preset load — both `verdict=warn` (dead-vocabulary drift) and
	// `verdict=error` (deadlock-continuable; load throws right after). Pairs
	// with `daemon.preset_load_failed` on the error path so an operator
	// inspecting an event stream sees the structural cause before the generic
	// load-failure event.
	arkType.unit("preset.dag_check"),
	arkType.unit("daemon.warning"),
	arkType.unit("scheduler.tick_failed"),
	arkType.unit("scheduler.lifecycle_event_persistence_failed"),
	arkType.unit("runner.status_persistence_failed"),
	arkType.unit("chain.complete_trigger_failed"),
	// #397: per-phase admission gate audit. One event per item.status write request the daemon
	// runs through `admitItemStatusForRequest` — both allow and deny outcomes — so a default-deny
	// rejection is replayable from the event stream alongside the lifecycle context.
	arkType.unit("item.status.write_admission"),
	// #406: caller-admission audit. One event per item.update request the daemon runs through
	// the credential gate (allow or deny). The pair (`item.mutation.caller_admission` +
	// `item.status.write_admission`) gives an auditor two-leg replay: who wrote ("谁能写") and
	// what they wrote ("能写什么"). The event's `subject` field is the true caller (operator |
	// agent+run) — not a self-attributed claim — because the daemon constructs the subject from
	// the validated credential, not from caller-supplied fields.
	arkType.unit("item.mutation.caller_admission"),
	// #405 chain-action exit-selection audit. One event per `item.exitAction` request — both
	// allow (action declared by phase) and deny (action not declared = default-deny per #397
	// pattern) outcomes. The `selectionKind` discriminator is "chain-action" today; future
	// item-status-via-exit-select paths would add a "item-status" branch and the discriminator
	// surface stays the same. Companion to the existing `item.status.write_admission` event;
	// together they cover both write faces an agent may use to advance an item or its chain.
	arkType.unit("item.exit.selected"),
	// #405 chain-stop lifecycle distinguisher. The daemon emits this alongside the existing
	// `chain.status` audit event whenever the engine executes chain.stop on behalf of a
	// phase-exit selection (i.e., NOT operator-direct chain.stop). Reading the lifecycle stream
	// gives `(timestamp, who, why)` for every chain stop: operator path emits only `chain.status`;
	// phase-exit path emits `chain.status` plus this lifecycle event with the originating
	// (runId, phase, itemId) bound. #419 retired the integer `issueNumber` field —
	// the opaque preset-declared `itemId` string is the canonical id.
	arkType.unit("chain.stop.from_phase_exit"),
	// #407: item.add / item.batchAdd per-phase rights admission. One event per create request
	// (allow or deny). Operator path emits with reason=operator; agent path emits with
	// reason=agent-allowed / no-create-grant / no-rights-segment. Pairs with
	// `item.mutation.caller_admission` (mutate gate) and `item.status.write_admission` (transition
	// gate) to give the auditor a three-leg replay of the item-mutation surface.
	arkType.unit("item.add.rights_admission"),
	// #409: privileged-op caller admission. One event per daemon request that runs through the
	// caller-stratification gate — both `hard-deny-for-agent` (chain lifecycle / daemon.down /
	// logs.query / queue.unblock) and `per-phase-authorized` (item.reorder). Operator path emits
	// reason=operator; agent path emits reason=agent-allowed / hard-deny-for-agent /
	// no-privileged-ops-grant / no-rights-segment. The `op` payload field is the engine-internal
	// DaemonCommandName the gate decided on (closed union — adding a new gated op extends the
	// dispatch table and forces this audit event to surface it). Pairs with
	// `item.mutation.caller_admission` and `item.add.rights_admission` to give the auditor a full
	// matrix of "who can do what" across the daemon surface.
	arkType.unit("privileged_op.caller_admission"),
	// #410: item.update non-status field-write admission. One event per item.update request
	// after caller admission — both allow (operator path, or agent path with every requested
	// field in the phase's `writableFields`) and deny (operator-impossible: operators always
	// allow; agent path with at least one undeclared or control-plane field). Pairs with
	// `item.mutation.caller_admission` (caller gate) and `item.status.write_admission` (status
	// transition gate) to give the auditor a full per-field replay of every item-mutation surface.
	arkType.unit("item.update.field_write_admission"),
	arkType.unit("context.write_admission"),
)
// #409: vocabulary of daemon ops that flow through the privileged-op caller-admission gate.
// Closed boundary so a corrupted / forged event file can't smuggle an unknown op past the
// reader. The daemon's `DaemonCommandName` is the source of truth; a compile-time check inside
// daemon.ts asserts every emitted op value satisfies this union (so the two stay in lockstep).
const PrivilegedOpAuditOpBoundary = arkType.or(
	arkType.unit("chain.create"),
	arkType.unit("chain.stop"),
	arkType.unit("chain.resume"),
	arkType.unit("chain.delete"),
	arkType.unit("chain.updateBindings"),
	arkType.unit("daemon.down"),
	arkType.unit("logs.query"),
	arkType.unit("queue.unblock"),
	arkType.unit("item.reorder"),
)

const PrivilegedOpAuditReasonBoundary = arkType.or(
	arkType.unit("operator"),
	arkType.unit("agent-allowed"),
	arkType.unit("hard-deny-for-agent"),
	arkType.unit("no-privileged-ops-grant"),
	arkType.unit("no-rights-segment"),
	arkType.unit("missing-credential"),
	arkType.unit("unknown-credential"),
	arkType.unit("inactive-run"),
)

// #410: item.update field-write admission reason vocabulary.
//   `operator`          — operator path (no agentCredential); always allow.
//   `agent-allowed`     — every requested field/inner-key is in the phase's writableFields.
//   `no-rights-segment` — agent phase's `[phases.rights]` is the default-deny shape (no grants
//                         declared at all); structurally equivalent to a missing segment.
//   `field-not-granted` — at least one requested passthrough field or extra-inner-key is not in
//                         the phase's writableFields (and no control-plane field is involved).
//   `control-plane-denied` — at least one requested field (top-level or inside extra/extraPatch)
//                         classifies as control-plane; takes precedence over `field-not-granted`
//                         since the deny is structurally non-recoverable by preset config.
const ItemUpdateFieldWriteReasonBoundary = arkType.or(
	arkType.unit("operator"),
	arkType.unit("agent-allowed"),
	arkType.unit("no-rights-segment"),
	arkType.unit("field-not-granted"),
	arkType.unit("control-plane-denied"),
)

const PresetPlaceholderDirectionBoundary = arkType.or(
	arkType.unit("template-undeclared"),
	arkType.unit("declared-unused"),
)

const PresetPlaceholderVerdictBoundary = arkType.or(
	arkType.unit("error"),
	arkType.unit("warn"),
)

// #408 cross-table DAG checker payload literals. `kind` discriminates the
// finding variant; `table` names the metadata table the offending status lives
// in (today `statuses.continuable` for both variants — every R2/R3 finding
// pinpoints a continuable status). `verdict` reuses the placeholder verdict
// vocabulary so a downstream consumer rendering "preset validation" events can
// switch on a single shared error/warn enum.
const PresetDagFindingKindBoundary = arkType.or(
	arkType.unit("deadlock-continuable"),
	arkType.unit("dead-vocabulary"),
)

const PresetDagFindingTableBoundary = arkType.or(
	arkType.unit("statuses.continuable"),
)

const ExcerptSourceBoundary = arkType({
	path: "string",
	missing: "boolean",
	truncated: "boolean",
	records: "string[]",
})

const ExcerptBoundary = arkType({
	stdout: ExcerptSourceBoundary,
	stderr: ExcerptSourceBoundary,
})

// #419: split the integer rowid (`rowId`) from the opaque preset-declared id (`itemId` string).
// Same shape change applied across every audit / lifecycle payload below.
//
// #508: `RecoveredItemBoundary` retired alongside the `recoveredItems` field on
// `scheduler.recovery` — daemon recovery no longer mutates item business state, so there is no
// list of "items the engine reset" to surface to consumers.

const TaskIdentityFields = {
	runtimeNodeId: "string>0",
	definitionRef: arkType.or(
		{ kind: arkType.unit("preset"), contentIdentity: "string>0", "+": "reject" },
		{ kind: arkType.unit("chain"), contentIdentity: "string>0", "+": "reject" },
	),
	definitionNodeId: "string>0",
} as const

const ReconciledRunBoundary = arkType({
	runId: "string",
	// `itemId` here is the integer rowid (FK to items.id) — `runs.item_id`. Kept as `itemId` for
	// back-compat with the run-record shape; the per-item-update audit payloads use `rowId` /
	// `itemId` split (rowid + opaque string) — `runs` does not yet need the opaque string in this
	// shape because it references items by rowid through the FK column.
	itemId: "number",
	phase: "string",
	"pid": arkType.or("number", "null"),
	...TaskIdentityFields,
})

const EventBaseBoundary = {
	ts: "string",
	"chain?": "string",
	"item?": "number",
	"runId?": "string",
	"phase?": "string",
	"subject?": SubjectBoundary,
} as const

// Keep the run/identity relation in one ADT. Chaining independent intersections here makes
// ArkType distribute the large payload union twice during every short-lived CLI startup.
const EventIdentityBoundary = arkType.or(
	{ runId: "string", ...TaskIdentityFields },
	{ "runId?": "never", ...TaskIdentityFields },
	{ "runId?": "never", "runtimeNodeId?": "never", "definitionRef?": "never", "definitionNodeId?": "never" },
)

const ObservabilityEventPayloadBoundary = arkType.or(
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("context.write_admission"),
		payload: ContextWriteAdmissionPayloadBoundary,
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("chain.layout"),
		// #481: `updatedKinds` is optional and identifies which runner-binding slots the
		// chain.layout event reflects — empty/absent for the original create-time event, populated
		// for the `chain.updateBindings` operator surface (which patches `claude.model` /
		// `codex.model` / `opencode.model` on an existing chain without touching anything else).
		payload: { chainId: "number", state: "string", "updatedKinds?": "string[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("chain.status"),
		payload: { chainId: "number", fromStatus: "string", toStatus: "string", terminatedRunIds: "string[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.created"),
		payload: { rowId: "number", itemId: "string", status: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.status"),
		payload: { rowId: "number", itemId: "string", fromStatus: "string", toStatus: "string", reason: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.reordered"),
		payload: { rowId: "number", itemId: "string", position: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("queue.terminal"),
		// #419 review I2: `itemId: "number"` (rowid) → `rowId: "number"`. The audit wire's `itemId`
		// field now uniformly carries the opaque preset-declared string identity (used by other
		// `item.*` audit events via the split shape `{ rowId, itemId }`); these decision/audit
		// events only need the rowid and therefore expose it on `rowId`.
		payload: { rowId: "number", terminalStatus: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.dependency_unblocked"),
		// #419 review I2: same rename — rowid moves from `itemId` to `rowId`.
		payload: { rowId: "number", fromStatus: "string", toStatus: "string", dependsOn: "number[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("decision"),
		type: arkType.unit("slot.busy"),
		payload: { slotKey: "string", chainId: "number", repoCwd: "string", activeRunId: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("decision"),
		type: arkType.unit("item.dependency_wait"),
		// #419 review I2: `itemId: "number"` (rowid) → `rowId: "number"` for wire-shape consistency
		// with the split convention `{ rowId: number, itemId: string }` adopted on `item.*` audit events.
		payload: { rowId: "number", dependsOn: "number[]", unsatisfied: "number[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("decision"),
		type: arkType.unit("item.backoff"),
		// #419 review I2: same rename — rowid moves from `itemId` to `rowId`.
		payload: { rowId: "number", failureCount: "number", nextRunAt: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("decision"),
		type: arkType.unit("chain.complete_trigger"),
		payload: { chainId: "number", decision: arkType.or(arkType.unit("complete"), arkType.unit("keep-active")), "reason?": "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("daemon.start"),
		payload: { pid: "number", socketPath: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("daemon.stop"),
		payload: { pid: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("daemon.stop.terminated_runs"),
		payload: { pid: "number", runIds: "string[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("daemon.socket.rebind"),
		payload: { pid: "number", socketPath: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("daemon.fatal"),
		payload: { fatalKind: "string", pid: "number", error: "string" },
	},
	{
		...EventBaseBoundary,
		// #403: migrated from `lifecycle` to `validation`. The fail-fast policy that replaced engine
		// fallback status vocabularies turns every preset-resolution refusal into a *validation* event
		// (an operation declined because the preset cannot be resolved), not a lifecycle transition.
		// The new `operation` payload field carries the refused operation name (`chain.status`,
		// `scheduler.tick`, `item.exits`, ...) so the event is per-operation-resolvable rather than
		// a generic "preset broken" log line.
		kind: arkType.unit("validation"),
		type: arkType.unit("daemon.preset_load_failed"),
		// `preset` is nullable since #412 (chain may carry no preset; chain-wide fall back to chain.preset
		// only applies when items are absent). Item-scoped failures will populate it with the item's preset
		// name; chain-only failures with no item context may emit null.
		payload: {
			chainId: "number",
			"preset": arkType.or("string", "null"),
			presetDir: "string",
			error: "string",
			// #403: operation that was refused because the preset could not be resolved. Required so
			// operators can correlate the refusal back to the calling surface without parsing stack
			// traces.
			operation: "string",
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("scheduler.recovery"),
		payload: {
			reason: arkType.unit("orphaned_run_reconciled"),
			"pid": arkType.or("number", "null"),
			// #508: `recoveredItems` retired — daemon recovery is process-layer only and never
			// rewrites item business fields, so there is no list to surface here.
			reconciledRuns: ReconciledRunBoundary.array(),
		},
	},
	{
		...EventBaseBoundary,
		...TaskIdentityFields,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("scheduler.recovery"),
		payload: {
			reason: arkType.unit("stale_current_run"),
			"pid": arkType.or("number", "null"),
			reconciledRuns: ReconciledRunBoundary.array(),
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("agent.spawn"),
		payload: { slotKey: "string", pid: arkType.or("number", "null"), worktreePath: "string", presetDir: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("agent.exit"),
		payload: { slotKey: "string", exitCode: "number", status: "string", excerpt: ExcerptBoundary },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("phase.start"),
		payload: { repoCwd: "string", pid: arkType.or("number", "null") },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("phase.end"),
		payload: { exitCode: "number", durationSeconds: "number", status: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("chain.completed"),
		payload: { chainId: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("attempt.timeout"),
		payload: { signal: arkType.or(arkType.unit("SIGTERM"), arkType.unit("SIGKILL")), attemptMs: "number", excerpt: ExcerptBoundary },
	},
	{
		// #462 startup idle reclaim: zero-output runner killed at the threshold. Payload
		// carries the configured idle window (idleTimeoutMs) and the observed cumulative
		// stdout bytes at kill time (stdoutBytes; ~101 on the run-1781258195574-6 incident
		// shape) so post-mortems do not need to re-read the run logs to classify the kill.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("run.startup_idle_kill"),
		payload: { idleTimeoutMs: "number", stdoutBytes: "number" },
	},
	{
		// #478 rate-limit: scheduler observed an account-level 429 / rejected
		// `rate_limit_event` on this run's stdout. Payload mirrors the RateLimitReset shape
		// so a consumer can pair (chainId, itemId, runId) with `daemon.status.rateLimit`
		// and compute its own resume timing without re-deriving from logs.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("scheduler.rate_limited"),
		payload: { resetsAt: "number", resetAtIso: "string", "rateLimitType": "string|null" },
	},
	{
		// #452 recycle-zone lifecycle: armed exactly once when the daemon observes a
		// successful agent-attributed state write; followed by exactly one of
		// `recycle.timeout_kill` (window elapsed without exit) or `recycle.natural_exit`
		// (child closed within the window). `recycleAfterMs` is the configured window so
		// that consumers do not need to re-derive it from scheduler config.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("recycle.pending_entered"),
		payload: { recycleAfterMs: "number" },
	},
	{
		// #452 recycle-zone fire: SIGKILL-only because the agent has already declared
		// completion via its state write; SIGTERM-first would only delay the inevitable
		// for an already-acknowledged-done process. Carries the same excerpt shape as
		// `attempt.timeout` / `watchdog.fire` did, so existing log consumers stay aligned.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("recycle.timeout_kill"),
		payload: { signal: arkType.unit("SIGKILL"), recycleAfterMs: "number", excerpt: ExcerptBoundary },
	},
	{
		// #452 recycle-zone natural exit: child closed during the recycle window. The
		// `elapsedMs` field lets lifecycle consumers histogram how fast agents close
		// after writing state without paging through the full event stream.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("recycle.natural_exit"),
		payload: { elapsedMs: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("spawn.aborted"),
		payload: { slotKey: "string", chainId: "number", id: "string", reason: "string", toStatus: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("session_id.invalidated"),
		payload: {
			runner: arkType.or(arkType.unit("claude"), arkType.unit("codex"), arkType.unit("opencode")),
			"previousSessionId": arkType.or("string", "null"),
			reason: arkType.unit("runner_session_id_invalid"),
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("chain.invalid"),
		payload: { chainId: "number", chainName: "string", context: "string", error: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("preset.placeholder_check"),
		payload: {
			file: "string",
			key: "string",
			direction: PresetPlaceholderDirectionBoundary,
			verdict: PresetPlaceholderVerdictBoundary,
		},
	},
	{
		// #408 cross-table preset DAG checker finding. Payload mirrors the
		// shape `PresetDagFinding` exposes at the boundary: `kind` discriminates
		// the variant; `table` is the metadata table the status lives in (today
		// `statuses.continuable` for both R2 and R3); `status` is the offending
		// status string; `message` is the renderable diagnostic. `verdict`
		// reuses the placeholder vocabulary (`error|warn`) so both validation
		// event families share one verdict enum across the unified stream.
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("preset.dag_check"),
		payload: {
			kind: PresetDagFindingKindBoundary,
			verdict: PresetPlaceholderVerdictBoundary,
			table: PresetDagFindingTableBoundary,
			status: "string",
			message: "string",
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("diagnostic"),
		type: arkType.unit("daemon.warning"),
		payload: { message: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("diagnostic"),
		type: arkType.unit("scheduler.tick_failed"),
		payload: { pid: "number", error: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("diagnostic"),
		type: arkType.unit("scheduler.lifecycle_event_persistence_failed"),
		payload: { eventKind: "string", error: "string", originalPersisted: arkType.unit(false) },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("diagnostic"),
		type: arkType.unit("runner.status_persistence_failed"),
		payload: { path: arkType.or(arkType.unit("scheduler"), arkType.unit("chain-complete")), stage: "string", persistencePath: "string", error: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("diagnostic"),
		type: arkType.unit("chain.complete_trigger_failed"),
		payload: { chainId: "number", error: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.mutation.caller_admission"),
		// #406 caller-admission audit. `outcome=allow` records the caller the daemon accepted
		// (operator or a credential-bound agent); the `subject` field on the event base already
		// carries the typed `operator | agent` ADT, so the payload duplicates only the fields
		// auditors need for fast queries without parsing the subject union.
		// `outcome=deny` records why the agent path was rejected — every reason maps 1:1 to one
		// of the issue's threat-model branches (stale credential after run end; cross-item write
		// from a parallel slot; CLI flags shipped without env-borne credential).
		payload: {
			rowId: "number",
			itemId: "string",
			"claimedRunId": arkType.or("string", "null"),
			"claimedPhase": arkType.or("string", "null"),
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: arkType.or(
				arkType.unit("operator"),
				arkType.unit("agent-credential-admitted"),
				arkType.unit("missing-credential"),
				arkType.unit("unknown-credential"),
				arkType.unit("wrong-item"),
				arkType.unit("inactive-run"),
			),
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.status.write_admission"),
		// outcome=allow → request passed both vocabulary check and per-phase admission (or the
		// item carried no active phase, in which case only vocabulary applied). outcome=deny →
		// rejected; `reason` records which leg failed.
		// `phase` is null when item.phase is null at write time (operator mid-run path / brand-new
		// item before its first phase). `declaredExits` is the preset's `[[phases.exits]]` set for
		// the active phase ([] when phase has no exits declared = default-deny under #397), and is
		// always an empty list when phase is null (the per-phase leg does not run).
		payload: {
			rowId: "number",
			itemId: "string",
			"phase": arkType.or("string", "null"),
			requestedStatus: "string",
			declaredExits: "string[]",
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: arkType.or(
				arkType.unit("vocabulary"),
				arkType.unit("phase-exits"),
				arkType.unit("no-phase-active"),
				arkType.unit("admitted"),
			),
		},
	},
	{
		// #405 chain-action exit-selection audit. Mirrors `item.status.write_admission` but for
		// the chain-action branch of the exit ADT. `selectionKind=chain-action` discriminates
		// the selected branch; today only `selectedAction=stop` is in the vocabulary. The two
		// `declared*` lists together echo back the phase's full declared exit set so an auditor
		// can replay the gate's view without re-reading the preset.
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.exit.selected"),
		payload: {
			rowId: "number",
			itemId: "string",
			phase: "string",
			selectionKind: arkType.unit("chain-action"),
			selectedAction: arkType.unit("stop"),
			declaredItemStatuses: "string[]",
			declaredChainActions: "string[]",
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: arkType.or(
				arkType.unit("admitted"),
				arkType.unit("phase-exits"),
				arkType.unit("caller-attribution-mismatch"),
			),
		},
	},
	{
		// #405 chain-stop lifecycle distinguisher for the phase-exit-driven path. Pairs with the
		// existing `chain.status` audit event already emitted by the chain stop dispatcher. The
		// `terminatedRunIds` field mirrors the operator-chain-stop audit shape so downstream
		// lifecycle consumers can reuse the same parse.
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("chain.stop.from_phase_exit"),
		payload: {
			chainId: "number",
			id: "string",
			alreadyStopped: "boolean",
			terminatedRunIds: "string[]",
		},
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.add.rights_admission"),
		// #407 rights admission. `claimedPhase` is the agent's bound phase from the credential
		// (null on the operator path); `presetName` is the new item's preset (bundled name or
		// absolute presetPath, identical to how the per-item preset is declared by the request).
		// `reason` enumerates the four mutually-exclusive outcomes — operator (always allow),
		// agent-allowed (rights segment declared createItems=true on caller phase),
		// no-create-grant (rights segment present but createItems missing or false),
		// no-rights-segment (rights segment absent or all-default; matches #407 acceptance #4).
		payload: {
			"claimedPhase": arkType.or("string", "null"),
			presetName: "string",
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: arkType.or(
				arkType.unit("operator"),
				arkType.unit("agent-allowed"),
				arkType.unit("no-create-grant"),
				arkType.unit("no-rights-segment"),
				arkType.unit("control-plane-denied"),
			),
		},
	},
	{
		// #409 privileged-op caller admission. Emitted once per request the daemon runs through
		// the caller-stratification gate (hard-deny-for-agent + per-phase-authorized classes).
		// The pair `(op, reason)` is the diagnostic surface: `op` is the engine's typed daemon
		// command name (PrivilegedOpAuditOpBoundary above); `reason` enumerates the gate
		// branches (operator allow, per-phase agent allow, four kinds of agent deny). The
		// `subject` field on the event base carries the typed operator|agent ADT so an auditor
		// can index "all denies for agent X in run Y" without re-parsing the payload.
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("privileged_op.caller_admission"),
		payload: {
			op: PrivilegedOpAuditOpBoundary,
			"claimedRunId": arkType.or("string", "null"),
			"claimedPhase": arkType.or("string", "null"),
			// `presetName` is meaningful only for the per-phase-authorized class (the gate
			// reads the agent's phase's rights from this preset). Hard-deny rejects without
			// consulting a preset, so callers pass `null`.
			"presetName": arkType.or("string", "null"),
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: PrivilegedOpAuditReasonBoundary,
		},
	},
	{
		// #410 item.update field-write admission. Emitted once per item.update request after
		// caller admission. `requestedFields` is the union of top-level update fields named in
		// the request plus expanded inner keys for any `extra` / `extraPatch` payload (so an
		// `extra: { blockerRepo: ..., blockerRef: ... }` write surfaces those two inner keys
		// alongside the top-level "extra" carrier). `deniedFields` is the subset that failed
		// the matrix (control-plane fields or fields missing from the phase's writableFields);
		// empty on allow. `presetName` is null on the operator path (gate skipped entirely)
		// and the bundled preset name / absolute presetPath on the agent path.
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.update.field_write_admission"),
		payload: {
			rowId: "number",
			itemId: "string",
			"claimedPhase": arkType.or("string", "null"),
			"presetName": arkType.or("string", "null"),
			requestedFields: "string[]",
			grantedFields: "string[]",
			deniedFields: "string[]",
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: ItemUpdateFieldWriteReasonBoundary,
		},
	},
)

export const ObservabilityEventBoundary = ObservabilityEventPayloadBoundary.and(EventIdentityBoundary)

export type ObservabilityEvent = typeof ObservabilityEventBoundary.infer
export type ObservabilityEventType = typeof ObservabilityEventTypeBoundary.infer
export type ObservabilityKind = typeof ObservabilityKindBoundary.infer
export type ObservabilityExcerpt = Extract<ObservabilityEvent, { type: "agent.exit" }>["payload"]["excerpt"]
export type ObservabilitySubject = NonNullable<ObservabilityEvent["subject"]>
export type PresetPlaceholderDirection = typeof PresetPlaceholderDirectionBoundary.infer
export type PresetPlaceholderVerdict = typeof PresetPlaceholderVerdictBoundary.infer
// #409: re-export the privileged-op vocabulary so daemon.ts (the only emitter) can
// type-assert every `op` it writes belongs to the closed boundary union.
export type PrivilegedOpAuditOp = typeof PrivilegedOpAuditOpBoundary.infer
export type PrivilegedOpAuditReason = typeof PrivilegedOpAuditReasonBoundary.infer
// #410: re-export the field-write reason vocabulary so daemon.ts (the only emitter) can
// type-assert every `reason` it writes belongs to the closed boundary union.
export type ItemUpdateFieldWriteReason = typeof ItemUpdateFieldWriteReasonBoundary.infer

// #397 in-memory companion to the `item.status.write_admission` audit-event schema above.
// Co-located with that schema so the wire shape (arktype, payload of ObservabilityEvent) and the
// in-memory shape the daemon hands to its admission-event emitter evolve together.
//
// Discriminated on `outcome`: every `outcome=allow` carries `reason` from the admit-side vocabulary
// (`"admitted" | "no-phase-active"`) and every `outcome=deny` carries `reason` from the reject-side
// vocabulary (`"vocabulary" | "phase-exits"`). The four logically-impossible cross-product entries
// (`allow×vocabulary`, `allow×phase-exits`, `deny×admitted`, `deny×no-phase-active`) are
// unrepresentable at the type level — the typechecker rejects any caller trying to construct them.
export type ItemStatusAdmissionRecord =
	| {
		item: ItemRecord
		phase: string | null
		requestedStatus: string
		declaredExits: readonly string[]
		subject: ObservabilitySubject
		outcome: "allow"
		reason: "admitted" | "no-phase-active"
	}
	| {
		item: ItemRecord
		phase: string | null
		requestedStatus: string
		declaredExits: readonly string[]
		subject: ObservabilitySubject
		outcome: "deny"
		reason: "vocabulary" | "phase-exits"
	}

export const OBSERVABILITY_EXCERPT_RECORD_LIMIT = 5
// Real runner JSONL records can inline large file bodies; this is an explicit excerpt payload contract.
export const OBSERVABILITY_EXCERPT_RECORD_BYTES = 64 * 1024
// Event stream segments are rotated, never truncated; this bounds one active JSONL segment.
export const OBSERVABILITY_EVENT_SEGMENT_BYTES = 32 * 1024 * 1024

export const ObservabilityEventSegmentBoundary = arkType.or(
	{ kind: arkType.unit("history"), path: "string", name: "string", sequence: "number.integer >= 1", startedAt: "string", endedAt: "string", id: "string" },
	{ kind: arkType.unit("legacy-history"), path: "string", name: "string", startedAt: "string", endedAt: "string", id: "string" },
	{ kind: arkType.unit("active"), path: "string", name: "string" },
)

export type ObservabilityEventSegment = typeof ObservabilityEventSegmentBoundary.infer

export type ObservabilityEventQuery = {
	kind?: ObservabilityKind
	type?: ObservabilityEventType
	chain?: string
	item?: number
	run?: string
	phase?: string
	since?: string
}

export type ObservabilityQueryResult = {
	path: string
	events: ObservabilityEvent[]
}

export function makeObservabilityEvent(input: Omit<ObservabilityEvent, "ts">, now = new Date()): ObservabilityEvent {
	return ObservabilityEventBoundary.assert({ ...input, ts: now.toISOString() })
}

// #409: structural roundtrip from an ObservabilityEvent to a generic JsonValue. Used by the
// `logs.query` daemon handler to embed event entries inside the daemon's JsonObject reply
// without forging an `as` cast across the type boundary. The arktype-asserted event is
// already JSON-serializable (the boundary union is built from arktype primitives), so the
// JSON.stringify → JSON.parse pair safely produces a plain JsonValue tree.
export function observabilityEventToJsonValue(event: ObservabilityEvent): unknown {
	return JSON.parse(JSON.stringify(event))
}

export function parseObservabilityEvent(input: unknown): ObservabilityEvent {
	return ObservabilityEventBoundary.assert(input)
}

export function parseObservabilityKind(input: string): ObservabilityKind {
	return ObservabilityKindBoundary.assert(input)
}

export function parseObservabilityEventType(input: string): ObservabilityEventType {
	return ObservabilityEventTypeBoundary.assert(input)
}

export async function appendObservabilityEvent(eventsFile: string, event: ObservabilityEvent): Promise<void> {
	try {
		await appendObservabilityEventOrThrow(eventsFile, event)
	} catch (error) {
		writeObservabilityStderr(`coder-loop observability write failed (${eventsFile}): ${errorMessage(error)}; event=${renderObservabilityEvent(event)}`)
	}
}

export async function appendObservabilityEventOrThrow(eventsFile: string, event: ObservabilityEvent): Promise<void> {
	const line = `${JSON.stringify(event)}\n`
	await mkdir(dirname(eventsFile), { recursive: true })
	await rotateObservabilityEventStream(eventsFile, event.ts, Buffer.byteLength(line))
	await appendFile(eventsFile, line)
}

export function appendObservabilityEventSync(eventsFile: string, event: ObservabilityEvent): void {
	try {
		appendObservabilityEventSyncOrThrow(eventsFile, event)
	} catch (error) {
		writeObservabilityStderr(`coder-loop observability write failed (${eventsFile}): ${errorMessage(error)}; event=${renderObservabilityEvent(event)}`)
	}
}

export function appendObservabilityEventSyncOrThrow(eventsFile: string, event: ObservabilityEvent): void {
	const line = `${JSON.stringify(event)}\n`
	mkdirSync(dirname(eventsFile), { recursive: true })
	rotateObservabilityEventStreamSync(eventsFile, event.ts, Buffer.byteLength(line))
	appendFileSync(eventsFile, line)
}

export async function queryObservabilityEvents(eventsFile: string, query: ObservabilityEventQuery = {}): Promise<ObservabilityQueryResult> {
	const events: ObservabilityEvent[] = []
	for (const segment of await discoverObservabilityEventSegments(eventsFile)) {
		const raw = await readFile(segment.path, "utf-8")
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue
			const parsed: unknown = JSON.parse(line)
			const event = parseObservabilityEvent(parsed)
			if (matchesObservabilityQuery(event, query)) events.push(event)
		}
	}
	return { path: eventsFile, events }
}

export function matchesObservabilityQuery(event: ObservabilityEvent, query: ObservabilityEventQuery): boolean {
	if (query.kind !== undefined && event.kind !== query.kind) return false
	if (query.type !== undefined && event.type !== query.type) return false
	if (query.chain !== undefined && event.chain !== query.chain) return false
	if (query.item !== undefined && event.item !== query.item) return false
	if (query.run !== undefined && event.runId !== query.run) return false
	if (query.phase !== undefined && event.phase !== query.phase) return false
	if (query.since !== undefined && Date.parse(event.ts) < Date.parse(query.since)) return false
	return true
}

export function observabilityDecisionKey(event: Extract<ObservabilityEvent, { kind: "decision" }>): string {
	switch (event.type) {
		case "slot.busy":
			return `${event.type}:${event.chain ?? String(event.payload.chainId)}:${event.payload.slotKey}`
		case "item.dependency_wait":
			// #419 review I2: rowid moved from `payload.itemId` to `payload.rowId`.
			return `${event.type}:${event.chain ?? ""}:${event.item ?? event.payload.rowId}`
		case "item.backoff":
			return `${event.type}:${event.chain ?? ""}:${event.item ?? event.payload.rowId}`
		case "chain.complete_trigger":
			return `${event.type}:${event.chain ?? String(event.payload.chainId)}:${event.runId ?? ""}`
		default:
			return assertNever(event)
	}
}

export function observabilityDecisionFingerprint(event: Extract<ObservabilityEvent, { kind: "decision" }>): string {
	switch (event.type) {
		case "slot.busy":
			return JSON.stringify({ activeRunId: event.payload.activeRunId, repoCwd: event.payload.repoCwd })
		case "item.dependency_wait":
			return JSON.stringify({ dependsOn: event.payload.dependsOn, unsatisfied: event.payload.unsatisfied })
		case "item.backoff":
			return JSON.stringify({ failureCount: event.payload.failureCount, nextRunAt: event.payload.nextRunAt })
		case "chain.complete_trigger":
			return JSON.stringify({ decision: event.payload.decision, reason: event.payload.reason ?? null })
		default:
			return assertNever(event)
	}
}

export async function collectObservabilityExcerpt(input: {
	stdoutPath: string
	stderrPath: string
	recordLimit?: number
	recordByteLimit?: number
}): Promise<ObservabilityExcerpt> {
	const recordLimit = input.recordLimit ?? OBSERVABILITY_EXCERPT_RECORD_LIMIT
	const recordByteLimit = input.recordByteLimit ?? OBSERVABILITY_EXCERPT_RECORD_BYTES
	return {
		stdout: await collectExcerptSource(input.stdoutPath, recordLimit, recordByteLimit),
		stderr: await collectExcerptSource(input.stderrPath, recordLimit, recordByteLimit),
	}
}

export function renderObservabilityEvent(event: ObservabilityEvent): string {
	switch (event.kind) {
		case "audit":
			return renderAuditEvent(event)
		case "decision":
			return renderDecisionEvent(event)
		case "lifecycle":
			return renderLifecycleEvent(event)
		case "validation":
			return renderValidationEvent(event)
		case "diagnostic":
			return renderDiagnosticEvent(event)
		default:
			return assertNever(event)
	}
}

function renderAuditEvent(event: Extract<ObservabilityEvent, { kind: "audit" }>): string {
	switch (event.type) {
		case "chain.layout":
			return `${event.ts} audit chain.layout chain=${event.chain ?? event.payload.chainId} state=${event.payload.state}`
		case "chain.status":
			return `${event.ts} audit chain.status chain=${event.chain ?? event.payload.chainId} ${event.payload.fromStatus}->${event.payload.toStatus}`
		case "item.created":
			return `${event.ts} audit item.created chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} status=${event.payload.status}`
		case "item.status":
			return `${event.ts} audit item.status chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} ${event.payload.fromStatus}->${event.payload.toStatus} reason=${event.payload.reason}`
		case "item.reordered":
			return `${event.ts} audit item.reordered chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} position=${event.payload.position}`
		case "queue.terminal":
			// #419 review I2: rowid moved from `payload.itemId` to `payload.rowId`.
			return `${event.ts} audit queue.terminal chain=${event.chain ?? "-"} item=${event.item ?? event.payload.rowId} status=${event.payload.terminalStatus}`
		case "item.dependency_unblocked":
			return `${event.ts} audit item.dependency_unblocked chain=${event.chain ?? "-"} item=${event.item ?? event.payload.rowId} ${event.payload.fromStatus}->${event.payload.toStatus}`
		case "item.status.write_admission":
			// #397: render shape mirrors the payload — outcome + reason carry the deny diagnostic
			// (allowed exits set follows so operators reading a default-deny rejection see what the
			// phase actually exposes). `phase=-` indicates the no-active-phase mid-run path.
			return `${event.ts} audit item.status.write_admission chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} phase=${event.payload.phase ?? "-"} requested=${event.payload.requestedStatus} outcome=${event.payload.outcome} reason=${event.payload.reason} exits=${event.payload.declaredExits.join(",") || "-"}`
		case "item.mutation.caller_admission":
			// #406: render shape names the credential outcome and the bound vs claimed run when an
			// agent path is rejected. `claimedRunId=-` / `claimedPhase=-` mark the operator path
			// (no claim made); a populated value with `outcome=deny` is the diagnostic surface for
			// "agent shipped CLI flags without env credential" or similar misconfigurations.
			return `${event.ts} audit item.mutation.caller_admission chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} claimedRunId=${event.payload.claimedRunId ?? "-"} claimedPhase=${event.payload.claimedPhase ?? "-"} outcome=${event.payload.outcome} reason=${event.payload.reason}`
		case "item.exit.selected":
			// #405: render shape names the selected exit branch + the phase's declared options so
			// a default-deny rejection reads end-to-end without re-loading the preset.
			return `${event.ts} audit item.exit.selected chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} run=${event.runId ?? "-"} phase=${event.payload.phase} kind=${event.payload.selectionKind} action=${event.payload.selectedAction} outcome=${event.payload.outcome} reason=${event.payload.reason} declaredChainActions=${event.payload.declaredChainActions.join(",") || "-"}`
		case "item.add.rights_admission":
			// #407: render shape names the new item's preset (where the rights live) and the
			// caller's bound phase (when the agent path runs). `claimedPhase=-` marks the operator
			// path (always allowed). The reason field is the most useful filter — agents looking
			// at deny lines want to know "no-create-grant" vs "no-rights-segment" at a glance.
			return `${event.ts} audit item.add.rights_admission chain=${event.chain ?? "-"} preset=${event.payload.presetName} claimedPhase=${event.payload.claimedPhase ?? "-"} outcome=${event.payload.outcome} reason=${event.payload.reason}`
		case "privileged_op.caller_admission":
			// #409: render shape names the gated op, the caller (claimedRunId/Phase or `-` for
			// operator), and the gate verdict. `preset=-` for hard-deny ops which do not consult
			// a preset; `preset=<name>` for per-phase-authorized ops where the gate looked up the
			// caller-phase's `[phases.rights] privilegedOps` grant.
			return `${event.ts} audit privileged_op.caller_admission chain=${event.chain ?? "-"} op=${event.payload.op} claimedRunId=${event.payload.claimedRunId ?? "-"} claimedPhase=${event.payload.claimedPhase ?? "-"} preset=${event.payload.presetName ?? "-"} outcome=${event.payload.outcome} reason=${event.payload.reason}`
		case "item.update.field_write_admission":
			// #410: render shape names the caller phase / preset, the requested field set, the
			// granted / denied subsets, and the gate verdict. The deny lines are the most useful
			// audit row — surface `denied=<csv>` first so an operator scanning for "what was
			// blocked" sees it without parsing the rest.
			return `${event.ts} audit item.update.field_write_admission chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} preset=${event.payload.presetName ?? "-"} claimedPhase=${event.payload.claimedPhase ?? "-"} outcome=${event.payload.outcome} reason=${event.payload.reason} denied=${event.payload.deniedFields.join(",") || "-"} requested=${event.payload.requestedFields.join(",") || "-"} granted=${event.payload.grantedFields.join(",") || "-"}`
		case "context.write_admission":
			return `${event.ts} audit context.write_admission chain=${event.chain ?? "-"} command=${event.payload.command} outcome=${event.payload.outcome} reason=${event.payload.reason} session=${event.payload.sessionId ?? "-"}`
		default:
			return assertNever(event)
	}
}

function renderDecisionEvent(event: Extract<ObservabilityEvent, { kind: "decision" }>): string {
	switch (event.type) {
		case "slot.busy":
			return `${event.ts} decision slot.busy chain=${event.chain ?? event.payload.chainId} run=${event.payload.activeRunId} slot=${JSON.stringify(event.payload.slotKey)}`
		case "item.dependency_wait":
			// #419 review I2: rowid moved from `payload.itemId` to `payload.rowId`.
			return `${event.ts} decision item.dependency_wait chain=${event.chain ?? "-"} item=${event.item ?? event.payload.rowId} unsatisfied=${event.payload.unsatisfied.join(",")}`
		case "item.backoff":
			return `${event.ts} decision item.backoff chain=${event.chain ?? "-"} item=${event.item ?? event.payload.rowId} nextRunAt=${event.payload.nextRunAt}`
		case "chain.complete_trigger":
			return `${event.ts} decision chain.complete_trigger chain=${event.chain ?? event.payload.chainId} decision=${event.payload.decision}`
		default:
			return assertNever(event)
	}
}

function renderLifecycleEvent(event: Extract<ObservabilityEvent, { kind: "lifecycle" }>): string {
	switch (event.type) {
		case "daemon.start":
			return `${event.ts} lifecycle daemon.start pid=${event.payload.pid} socket=${event.payload.socketPath}`
		case "daemon.stop":
			return `${event.ts} lifecycle daemon.stop pid=${event.payload.pid}`
		case "daemon.stop.terminated_runs":
			return `${event.ts} lifecycle daemon.stop.terminated_runs pid=${event.payload.pid} runs=${event.payload.runIds.join(",")}`
		case "daemon.socket.rebind":
			return `${event.ts} lifecycle daemon.socket.rebind pid=${event.payload.pid} socket=${event.payload.socketPath}`
		case "daemon.fatal":
			return `${event.ts} lifecycle daemon.fatal pid=${event.payload.pid} kind=${event.payload.fatalKind}`
		case "scheduler.recovery":
			return `${event.ts} lifecycle scheduler.recovery chain=${event.chain ?? "-"} reason=${event.payload.reason}`
		case "agent.spawn":
			return `${event.ts} lifecycle agent.spawn chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} pid=${event.payload.pid ?? "null"}`
		case "agent.exit":
			return `${event.ts} lifecycle agent.exit chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} exit=${event.payload.exitCode} status=${event.payload.status}`
		case "phase.start":
			return `${event.ts} lifecycle phase.start chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} pid=${event.payload.pid ?? "null"}`
		case "phase.end":
			return `${event.ts} lifecycle phase.end chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} exit=${event.payload.exitCode} status=${event.payload.status}`
		case "chain.completed":
			return `${event.ts} lifecycle chain.completed chain=${event.chain ?? event.payload.chainId}`
		case "attempt.timeout":
			return `${event.ts} lifecycle attempt.timeout chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} signal=${event.payload.signal}`
		case "run.startup_idle_kill":
			return `${event.ts} lifecycle run.startup_idle_kill chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} idleTimeoutMs=${event.payload.idleTimeoutMs} stdoutBytes=${event.payload.stdoutBytes}`
		case "scheduler.rate_limited":
			return `${event.ts} lifecycle scheduler.rate_limited chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} resetsAt=${event.payload.resetsAt} rateLimitType=${event.payload.rateLimitType ?? "-"}`
		case "recycle.pending_entered":
			return `${event.ts} lifecycle recycle.pending_entered chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} recycleAfterMs=${event.payload.recycleAfterMs}`
		case "recycle.timeout_kill":
			return `${event.ts} lifecycle recycle.timeout_kill chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} signal=${event.payload.signal} recycleAfterMs=${event.payload.recycleAfterMs}`
		case "recycle.natural_exit":
			return `${event.ts} lifecycle recycle.natural_exit chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} elapsedMs=${event.payload.elapsedMs}`
		case "chain.stop.from_phase_exit":
			return `${event.ts} lifecycle chain.stop.from_phase_exit chain=${event.chain ?? event.payload.chainId} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} alreadyStopped=${event.payload.alreadyStopped} terminatedRuns=${event.payload.terminatedRunIds.join(",") || "-"}`
		default:
			return assertNever(event)
	}
}

function renderValidationEvent(event: Extract<ObservabilityEvent, { kind: "validation" }>): string {
	switch (event.type) {
		case "spawn.aborted":
			return `${event.ts} validation spawn.aborted chain=${event.chain ?? event.payload.chainId} item=${event.item ?? "-"} reason=${event.payload.reason}`
		case "session_id.invalidated":
			return `${event.ts} validation session_id.invalidated chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} runner=${event.payload.runner}`
		case "chain.invalid":
			return `${event.ts} validation chain.invalid chain=${event.payload.chainId} context=${event.payload.context} error=${event.payload.error}`
		case "preset.placeholder_check":
			return `${event.ts} validation preset.placeholder_check chain=${event.chain ?? "-"} file=${event.payload.file} key=${event.payload.key} direction=${event.payload.direction} verdict=${event.payload.verdict}`
		case "preset.dag_check":
			// #408: render shape names the finding kind, the offending status,
			// and the metadata table. The `message` field carries the full
			// human-readable diagnostic; the rendered line stays one-tuple so
			// operators grepping the event stream can pivot on `verdict=` or
			// `kind=` cheaply without parsing JSON.
			return `${event.ts} validation preset.dag_check chain=${event.chain ?? "-"} kind=${event.payload.kind} verdict=${event.payload.verdict} table=${event.payload.table} status=${event.payload.status}`
		case "daemon.preset_load_failed":
			// #403: migrated from `lifecycle` to `validation`. The fail-fast policy that replaced the
			// engine fallback status vocabularies turns every preset-resolution refusal into a
			// validation event. `operation` names the refused surface (chain.status, scheduler.tick,
			// item.exits, ...).
			return `${event.ts} validation daemon.preset_load_failed chain=${event.chain ?? event.payload.chainId} operation=${event.payload.operation} preset=${event.payload.preset} presetDir=${event.payload.presetDir} error=${event.payload.error}`
		default:
			return assertNever(event)
	}
}

function renderDiagnosticEvent(event: Extract<ObservabilityEvent, { kind: "diagnostic" }>): string {
	switch (event.type) {
		case "daemon.warning":
			return `${event.ts} diagnostic daemon.warning ${event.payload.message}`
		case "scheduler.tick_failed":
			return `${event.ts} diagnostic scheduler.tick_failed pid=${event.payload.pid} error=${event.payload.error}`
		case "scheduler.lifecycle_event_persistence_failed":
			return `${event.ts} diagnostic scheduler.lifecycle_event_persistence_failed chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} eventKind=${event.payload.eventKind} originalPersisted=false error=${event.payload.error}`
		case "runner.status_persistence_failed":
			return `${event.ts} diagnostic runner.status_persistence_failed chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} path=${event.payload.path} stage=${event.payload.stage} persistencePath=${event.payload.persistencePath} error=${event.payload.error}`
		case "chain.complete_trigger_failed":
			return `${event.ts} diagnostic chain.complete_trigger_failed chain=${event.chain ?? event.payload.chainId} error=${event.payload.error}`
		default:
			return assertNever(event)
	}
}

function assertNever(value: never): never {
	throw new Error(`unhandled observability event: ${JSON.stringify(value)}`)
}

async function collectExcerptSource(path: string, recordLimit: number, recordByteLimit: number): Promise<ObservabilityExcerpt["stdout"]> {
	let raw: string
	try {
		raw = await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { path, missing: true, truncated: false, records: [] }
		throw error
	}
	const records = recordsFromText(raw)
	const tail = records.slice(-recordLimit)
	const truncatedByTail = records.length > tail.length
	let truncatedByBytes = false
	const boundedRecords = tail.map((record) => {
		const buffer = Buffer.from(record)
		if (buffer.byteLength <= recordByteLimit) return record
		truncatedByBytes = true
		return buffer.subarray(0, recordByteLimit).toString("utf-8")
	})
	return {
		path,
		missing: false,
		truncated: truncatedByTail || truncatedByBytes,
		records: boundedRecords,
	}
}

function recordsFromText(raw: string): string[] {
	const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw
	return text === "" ? [] : text.split("\n")
}

async function rotateObservabilityEventStream(eventsFile: string, eventTs: string, pendingBytes: number): Promise<void> {
	let current: Awaited<ReturnType<typeof stat>>
	try {
		current = await stat(eventsFile)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
	if (current.size === 0) return
	if (!shouldRotateObservabilityEventStream(current.size, current.mtime, eventTs, pendingBytes)) return
	const sequence = nextObservabilityEventSegmentSequence(await discoverObservabilityEventSegments(eventsFile))
	await rename(eventsFile, rotatedObservabilityEventSegment(eventsFile, current.mtime, eventTs, sequence))
}

function rotateObservabilityEventStreamSync(eventsFile: string, eventTs: string, pendingBytes: number): void {
	let current: ReturnType<typeof statSync>
	try {
		current = statSync(eventsFile)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
	if (current.size === 0) return
	if (!shouldRotateObservabilityEventStream(current.size, current.mtime, eventTs, pendingBytes)) return
	const sequence = nextObservabilityEventSegmentSequence(discoverObservabilityEventSegmentsSync(eventsFile))
	renameSync(eventsFile, rotatedObservabilityEventSegment(eventsFile, current.mtime, eventTs, sequence))
}

export function shouldRotateObservabilityEventStream(size: number, mtime: Date, eventTs: string, pendingBytes: number): boolean {
	return mtime.toISOString().slice(0, 10) !== eventTs.slice(0, 10)
		|| size + pendingBytes > OBSERVABILITY_EVENT_SEGMENT_BYTES
}

export function rotatedObservabilityEventSegment(eventsFile: string, mtime: Date, eventTs: string, sequence: number): string {
	const startedAt = sanitizeSegmentTimestamp(mtime.toISOString())
	const endedAt = sanitizeSegmentTimestamp(eventTs)
	const order = String(sequence).padStart(16, "0")
	return resolve(dirname(eventsFile), `${activeObservabilityEventBasename(eventsFile)}-${order}-${startedAt}-${endedAt}-${randomUUID()}.jsonl`)
}

export function parseObservabilityEventSegmentName(eventsFile: string, name: string): ObservabilityEventSegment | null {
	const activeName = basename(eventsFile)
	if (name === activeName) return ObservabilityEventSegmentBoundary.assert({ kind: "active", path: eventsFile, name })
	const stem = activeObservabilityEventBasename(eventsFile)
	const match = new RegExp(`^${escapeRegExp(stem)}-(\\d{16})-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z)-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.jsonl$`, "i").exec(name)
	if (match !== null) {
		const sequenceText = match[1]
		const startedAt = match[2]
		const endedAt = match[3]
		const id = match[4]
		if (sequenceText === undefined || startedAt === undefined || endedAt === undefined || id === undefined) throw new Error(`invalid observability segment match: ${name}`)
		return ObservabilityEventSegmentBoundary.assert({ kind: "history", path: resolve(dirname(eventsFile), name), name, sequence: Number(sequenceText), startedAt, endedAt, id })
	}
	const legacy = new RegExp(`^${escapeRegExp(stem)}-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z)-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.jsonl$`, "i").exec(name)
	if (legacy === null) return null
	const startedAt = legacy[1]
	const endedAt = legacy[2]
	const id = legacy[3]
	if (startedAt === undefined || endedAt === undefined || id === undefined) throw new Error(`invalid legacy observability segment match: ${name}`)
	return ObservabilityEventSegmentBoundary.assert({ kind: "legacy-history", path: resolve(dirname(eventsFile), name), name, startedAt, endedAt, id })
}

export async function discoverObservabilityEventSegments(eventsFile: string): Promise<ObservabilityEventSegment[]> {
	const eventsDir = dirname(eventsFile)
	let entries: string[]
	try {
		entries = await readdir(eventsDir)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return []
		throw error
	}
	return orderObservabilityEventSegments(entries.flatMap((entry) => {
		const segment = parseObservabilityEventSegmentName(eventsFile, entry)
		return segment === null ? [] : [segment]
	}))
}

function discoverObservabilityEventSegmentsSync(eventsFile: string): ObservabilityEventSegment[] {
	let entries: string[]
	try {
		entries = readdirSync(dirname(eventsFile))
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return []
		throw error
	}
	return orderObservabilityEventSegments(entries.flatMap((entry) => {
		const segment = parseObservabilityEventSegmentName(eventsFile, entry)
		return segment === null ? [] : [segment]
	}))
}

export function orderObservabilityEventSegments(segments: readonly ObservabilityEventSegment[]): ObservabilityEventSegment[] {
	const legacy = segments.filter((segment): segment is Extract<ObservabilityEventSegment, { kind: "legacy-history" }> => segment.kind === "legacy-history")
	legacy.sort((left, right) => {
		const leftOrder = `${left.startedAt}/${left.endedAt}/${left.name}`
		const rightOrder = `${right.startedAt}/${right.endedAt}/${right.name}`
		return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0
	})
	const history = segments.filter((segment): segment is Extract<ObservabilityEventSegment, { kind: "history" }> => segment.kind === "history")
	const sequences = new Set<number>()
	for (const segment of history) {
		if (sequences.has(segment.sequence)) throw new Error(`duplicate observability segment sequence ${segment.sequence}`)
		sequences.add(segment.sequence)
	}
	history.sort((left, right) => left.sequence - right.sequence)
	const active = segments.filter((segment): segment is Extract<ObservabilityEventSegment, { kind: "active" }> => segment.kind === "active")
	if (active.length > 1) throw new Error("multiple active observability event segments")
	return [...legacy, ...history, ...active]
}

function nextObservabilityEventSegmentSequence(segments: readonly ObservabilityEventSegment[]): number {
	const last = segments.filter((segment): segment is Extract<ObservabilityEventSegment, { kind: "history" }> => segment.kind === "history").at(-1)
	return (last?.sequence ?? 0) + 1
}

export function activeObservabilityEventBasename(eventsFile: string): string {
	const name = basename(eventsFile)
	return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name
}

function sanitizeSegmentTimestamp(input: string): string {
	return input.replace(/[^A-Za-z0-9._-]/g, "-")
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function writeObservabilityStderr(message: string): void {
	try {
		process.stderr.write(`${message}\n`)
	} catch {
		// No alternate local sink exists if stderr itself is unavailable.
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}
