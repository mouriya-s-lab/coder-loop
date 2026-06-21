import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises"
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { type as arkType } from "arktype"

import type { ItemRecord } from "./sqlite-state"

const SubjectBoundary = arkType.or(
	{ kind: arkType.unit("engine") },
	{ kind: arkType.unit("operator") },
	{ kind: arkType.unit("agent"), runId: "string", phase: "string" },
)

const ObservabilityKindBoundary = arkType.or(
	arkType.unit("audit"),
	arkType.unit("decision"),
	arkType.unit("lifecycle"),
	arkType.unit("validation"),
	arkType.unit("diagnostic"),
)

const ObservabilityEventTypeBoundary = arkType.or(
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
	arkType.unit("daemon.warning"),
	arkType.unit("scheduler.tick_failed"),
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
	// (runId, phase, itemId, issueNumber) bound.
	arkType.unit("chain.stop.from_phase_exit"),
	// #407: item.add / item.batchAdd per-phase rights admission. One event per create request
	// (allow or deny). Operator path emits with reason=operator; agent path emits with
	// reason=agent-allowed / no-create-grant / no-rights-segment. Pairs with
	// `item.mutation.caller_admission` (mutate gate) and `item.status.write_admission` (transition
	// gate) to give the auditor a three-leg replay of the item-mutation surface.
	arkType.unit("item.add.rights_admission"),
)

const PresetPlaceholderDirectionBoundary = arkType.or(
	arkType.unit("template-undeclared"),
	arkType.unit("declared-unused"),
)

const PresetPlaceholderVerdictBoundary = arkType.or(
	arkType.unit("error"),
	arkType.unit("warn"),
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

const RecoveredItemBoundary = arkType({
	itemId: "number",
	issueNumber: "number",
	fromStatus: "string",
	toStatus: "string",
})

const ReconciledRunBoundary = arkType({
	runId: "string",
	itemId: "number",
	phase: "string",
	"pid": arkType.or("number", "null"),
})

const EventBaseBoundary = {
	ts: "string",
	"chain?": "string",
	"item?": "number",
	"runId?": "string",
	"phase?": "string",
	"subject?": SubjectBoundary,
} as const

const ObservabilityEventBoundary = arkType.or(
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("chain.layout"),
		payload: { chainId: "number", state: "string" },
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
		payload: { itemId: "number", issueNumber: "number", status: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.status"),
		payload: { itemId: "number", issueNumber: "number", fromStatus: "string", toStatus: "string", reason: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.reordered"),
		payload: { itemId: "number", issueNumber: "number", position: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("queue.terminal"),
		payload: { itemId: "number", terminalStatus: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("audit"),
		type: arkType.unit("item.dependency_unblocked"),
		payload: { itemId: "number", fromStatus: "string", toStatus: "string", dependsOn: "number[]" },
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
		payload: { itemId: "number", dependsOn: "number[]", unsatisfied: "number[]" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("decision"),
		type: arkType.unit("item.backoff"),
		payload: { itemId: "number", failureCount: "number", nextRunAt: "number" },
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
			reason: arkType.or(arkType.unit("stale_current_run"), arkType.unit("orphaned_run_reconciled")),
			"pid": arkType.or("number", "null"),
			recoveredItems: RecoveredItemBoundary.array(),
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
		payload: { slotKey: "string", chainId: "number", issueNumber: "number", reason: "string", toStatus: "string" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("validation"),
		type: arkType.unit("session_id.invalidated"),
		payload: {
			runner: arkType.or(arkType.unit("claude"), arkType.unit("codex")),
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
			itemId: "number",
			issueNumber: "number",
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
			itemId: "number",
			issueNumber: "number",
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
			itemId: "number",
			issueNumber: "number",
			phase: "string",
			selectionKind: arkType.unit("chain-action"),
			selectedAction: arkType.unit("stop"),
			declaredItemStatuses: "string[]",
			declaredChainActions: "string[]",
			outcome: arkType.or(arkType.unit("allow"), arkType.unit("deny")),
			reason: arkType.or(arkType.unit("admitted"), arkType.unit("phase-exits")),
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
			issueNumber: "number",
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
			),
		},
	},
)

export type ObservabilityEvent = typeof ObservabilityEventBoundary.infer
export type ObservabilityKind = typeof ObservabilityKindBoundary.infer
export type ObservabilityEventType = typeof ObservabilityEventTypeBoundary.infer
export type ObservabilityExcerpt = Extract<ObservabilityEvent, { type: "agent.exit" }>["payload"]["excerpt"]
export type ObservabilitySubject = NonNullable<ObservabilityEvent["subject"]>
export type PresetPlaceholderDirection = typeof PresetPlaceholderDirectionBoundary.infer
export type PresetPlaceholderVerdict = typeof PresetPlaceholderVerdictBoundary.infer

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
		const line = `${JSON.stringify(event)}\n`
		await mkdir(dirname(eventsFile), { recursive: true })
		await rotateObservabilityEventStream(eventsFile, event.ts, Buffer.byteLength(line))
		await appendFile(eventsFile, line)
	} catch (error) {
		writeObservabilityStderr(`coder-loop observability write failed (${eventsFile}): ${errorMessage(error)}; event=${renderObservabilityEvent(event)}`)
	}
}

export function appendObservabilityEventSync(eventsFile: string, event: ObservabilityEvent): void {
	try {
		const line = `${JSON.stringify(event)}\n`
		mkdirSync(dirname(eventsFile), { recursive: true })
		rotateObservabilityEventStreamSync(eventsFile, event.ts, Buffer.byteLength(line))
		appendFileSync(eventsFile, line)
	} catch (error) {
		writeObservabilityStderr(`coder-loop observability write failed (${eventsFile}): ${errorMessage(error)}; event=${renderObservabilityEvent(event)}`)
	}
}

export async function queryObservabilityEvents(eventsFile: string, query: ObservabilityEventQuery = {}): Promise<ObservabilityQueryResult> {
	const events: ObservabilityEvent[] = []
	for (const segmentFile of await listObservabilityEventSegments(eventsFile)) {
		const raw = await readFile(segmentFile, "utf-8")
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
			return `${event.type}:${event.chain ?? ""}:${event.item ?? event.payload.itemId}`
		case "item.backoff":
			return `${event.type}:${event.chain ?? ""}:${event.item ?? event.payload.itemId}`
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
			return `${event.ts} audit queue.terminal chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} status=${event.payload.terminalStatus}`
		case "item.dependency_unblocked":
			return `${event.ts} audit item.dependency_unblocked chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} ${event.payload.fromStatus}->${event.payload.toStatus}`
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
		default:
			return assertNever(event)
	}
}

function renderDecisionEvent(event: Extract<ObservabilityEvent, { kind: "decision" }>): string {
	switch (event.type) {
		case "slot.busy":
			return `${event.ts} decision slot.busy chain=${event.chain ?? event.payload.chainId} run=${event.payload.activeRunId} slot=${JSON.stringify(event.payload.slotKey)}`
		case "item.dependency_wait":
			return `${event.ts} decision item.dependency_wait chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} unsatisfied=${event.payload.unsatisfied.join(",")}`
		case "item.backoff":
			return `${event.ts} decision item.backoff chain=${event.chain ?? "-"} item=${event.item ?? event.payload.itemId} nextRunAt=${event.payload.nextRunAt}`
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
	await rename(eventsFile, rotatedObservabilityEventSegment(eventsFile, current.mtime, eventTs))
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
	renameSync(eventsFile, rotatedObservabilityEventSegment(eventsFile, current.mtime, eventTs))
}

function shouldRotateObservabilityEventStream(size: number, mtime: Date, eventTs: string, pendingBytes: number): boolean {
	return mtime.toISOString().slice(0, 10) !== eventTs.slice(0, 10)
		|| size + pendingBytes > OBSERVABILITY_EVENT_SEGMENT_BYTES
}

function rotatedObservabilityEventSegment(eventsFile: string, mtime: Date, eventTs: string): string {
	const timestamp = sanitizeSegmentTimestamp(`${mtime.toISOString()}-${eventTs}`)
	return resolve(dirname(eventsFile), `${activeObservabilityEventBasename(eventsFile)}-${timestamp}-${randomUUID()}.jsonl`)
}

async function listObservabilityEventSegments(eventsFile: string): Promise<string[]> {
	const eventsDir = dirname(eventsFile)
	let entries: string[]
	try {
		entries = await readdir(eventsDir)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return []
		throw error
	}
	const activeName = basename(eventsFile)
	const rotatedPrefix = `${activeObservabilityEventBasename(eventsFile)}-`
	const files = entries
		.filter((entry) => entry === activeName || (entry.startsWith(rotatedPrefix) && entry.endsWith(".jsonl")))
		.sort()
		.map((entry) => resolve(eventsDir, entry))
	return files
}

function activeObservabilityEventBasename(eventsFile: string): string {
	const name = basename(eventsFile)
	return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name
}

function sanitizeSegmentTimestamp(input: string): string {
	return input.replace(/[^A-Za-z0-9._-]/g, "-")
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
