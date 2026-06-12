import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises"
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { type as arkType } from "arktype"

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
	arkType.unit("daemon.socket.rebind"),
	arkType.unit("daemon.fatal"),
	arkType.unit("scheduler.recovery"),
	arkType.unit("agent.spawn"),
	arkType.unit("agent.exit"),
	arkType.unit("phase.start"),
	arkType.unit("phase.end"),
	arkType.unit("chain.completed"),
	arkType.unit("attempt.timeout"),
	arkType.unit("watchdog.armed"),
	arkType.unit("watchdog.fire"),
	arkType.unit("spawn.aborted"),
	arkType.unit("session_id.invalidated"),
	arkType.unit("chain.invalid"),
	arkType.unit("preset.fallback"),
	arkType.unit("daemon.warning"),
	arkType.unit("scheduler.tick_failed"),
	arkType.unit("chain.complete_trigger_failed"),
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
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("watchdog.armed"),
		payload: { marker: "string", graceMs: "number" },
	},
	{
		...EventBaseBoundary,
		kind: arkType.unit("lifecycle"),
		type: arkType.unit("watchdog.fire"),
		payload: { signal: arkType.or(arkType.unit("SIGTERM"), arkType.unit("SIGKILL")), graceMs: "number", excerpt: ExcerptBoundary },
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
		type: arkType.unit("preset.fallback"),
		payload: { chainId: "number", preset: "string", fallbackPreset: "string", reason: arkType.or(arkType.unit("invalid_name"), arkType.unit("unknown_preset")) },
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
)

export type ObservabilityEvent = typeof ObservabilityEventBoundary.infer
export type ObservabilityKind = typeof ObservabilityKindBoundary.infer
export type ObservabilityEventType = typeof ObservabilityEventTypeBoundary.infer
export type ObservabilityExcerpt = Extract<ObservabilityEvent, { type: "agent.exit" }>["payload"]["excerpt"]
export type ObservabilitySubject = NonNullable<ObservabilityEvent["subject"]>

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
		case "watchdog.armed":
			return `${event.ts} lifecycle watchdog.armed chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} graceMs=${event.payload.graceMs}`
		case "watchdog.fire":
			return `${event.ts} lifecycle watchdog.fire chain=${event.chain ?? "-"} item=${event.item ?? "-"} run=${event.runId ?? "-"} phase=${event.phase ?? "-"} signal=${event.payload.signal}`
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
		case "preset.fallback":
			return `${event.ts} validation preset.fallback chain=${event.payload.chainId} preset=${event.payload.preset} reason=${event.payload.reason}`
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
