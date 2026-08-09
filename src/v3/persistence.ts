import { type as arkType } from "arktype"
import { isBoundaryRecord } from "../boundary-types"
import type { JsonValue } from "./definition"
import { parseDeclaredValue } from "./definition"
import type { ContextValues, FunctionCheckpoint, MapFaultEntry } from "./context"
import {
	replaceTaskLifecycle,
	type AwaitRecord,
	type ClosureResourceState,
	type GroupState,
	type PublicationEvidence,
	type Task,
	type TaskGroup,
	type TaskSettlement,
} from "./object-domain"

const ChainIdentityBoundary = arkType({ kind: "'chain'", value: "string > 0", "+": "reject" })
const TaskIdentityBoundary = arkType({ kind: "'task'", chain: ChainIdentityBoundary, value: "string > 0", "+": "reject" })
const GroupIdentityBoundary = arkType({ kind: "'group'", chain: ChainIdentityBoundary, value: "string > 0", "+": "reject" })
const ClosureIdentityBoundary = arkType({ kind: "'closure'", task: TaskIdentityBoundary, attempt: "number.integer >= 0", "+": "reject" })
const RunIdentityBoundary = arkType({ kind: "'run'", closure: ClosureIdentityBoundary, value: "string > 0", "+": "reject" })
const AwaitIdentityBoundary = arkType({ kind: "'await'", parent: TaskIdentityBoundary, attempt: "number.integer >= 0", site: "string > 0", "+": "reject" })
const DefinitionRefBoundary = arkType({
	kind: "'published-definition'",
	content: { kind: "'definition-content'", digest: "string > 0", "+": "reject" },
	product: { kind: "'compiled-product'", digest: "string > 0", "+": "reject" },
	"+": "reject",
})
const AgentAuthorityBoundary = arkType({ kind: "'agent-run'", chainId: "string > 0", taskId: "string > 0", closureId: "string > 0", runId: "string > 0", "+": "reject" })
const CheckpointBoundary = arkType({
	run: AgentAuthorityBoundary,
	stepId: "string > 0",
	runnerSessionIdentity: "string | null",
	context0: arkType.or({ stage: "'context-0'", values: "unknown", "+": "reject" }, "null"),
	context1: arkType.or({ stage: "'context-1'", values: "unknown", "+": "reject" }, "null"),
	context2: arkType.or({ stage: "'context-2'", values: "unknown", "+": "reject" }, "null"),
	context3: arkType.or({ stage: "'context-3'", values: "unknown", "+": "reject" }, "null"),
	prompt: arkType.or({ kind: "'frozen-prompt'", text: "string", inputValues: "unknown", "+": "reject" }, "null"),
	agent: { state: "'not-opened'|'open'|'closed'", accepted: "unknown", "+": "reject" },
	predicates: { "[string]": "boolean" },
	"+": "reject",
})

const PublicationEvidenceBoundary = arkType.or(
	{ kind: "'published'", tip: "string > 0", remoteRef: "string > 0", observedAt: "number", "+": "reject" },
	{ kind: "'unpublished'", tip: "string > 0", observedAt: "number", "+": "reject" },
	{ kind: "'unknown'", tip: "string > 0", reason: "string > 0", observedAt: "number", "+": "reject" },
	{ kind: "'no-work'", observedAt: "number", "+": "reject" },
)
const ContinuationFactBoundary = arkType.or(
	{ kind: "'present'", sessionIdentity: "string > 0", observedAt: "number", "+": "reject" },
	{ kind: "'lost'", observedAt: "number", "+": "reject" },
)
const ClosureResourceStateBoundary = arkType.or(
	{ kind: "'unallocated'", "+": "reject" },
	{ kind: "'allocating'", identity: ClosureIdentityBoundary, allocation: "string > 0", basePin: "string > 0", branch: "string > 0", "+": "reject" },
	{
		kind: "'active'",
		identity: ClosureIdentityBoundary,
		basePin: "string > 0",
		branch: "string > 0",
		worktree: "string > 0",
		scratch: "string > 0",
		"+": "reject",
	},
	{ kind: "'suspended'", identity: ClosureIdentityBoundary, basePin: "string > 0", branch: "string > 0", worktree: "string > 0", scratch: "string > 0", continuation: ContinuationFactBoundary, "+": "reject" },
	{ kind: "'evidence-frozen'", identity: ClosureIdentityBoundary, basePin: "string > 0", branch: "string > 0", worktree: "string > 0", scratch: "string > 0", publication: PublicationEvidenceBoundary, "+": "reject" },
	{ kind: "'collected'", identity: ClosureIdentityBoundary, basePin: "string > 0", publication: PublicationEvidenceBoundary, collectedAt: "number", "+": "reject" },
)

const ValueParseIssueBoundary = arkType({ path: "(string | number)[]", expected: "string", actual: "string", "+": "reject" })
const MapFaultBoundary = arkType({ kind: "'spawn' | 'timeout' | 'exit' | 'map-rejected'", message: "string", "+": "reject" })
const MapFaultReasonBoundary = arkType.or(
	{ kind: "'duplicate-result'", "+": "reject" },
	{ kind: "'missing-result'", "+": "reject" },
	{ kind: "'unexpected-result'", "+": "reject" },
	{ kind: "'required-value-absent'", "+": "reject" },
	{ kind: "'parse-rejected'", issues: ValueParseIssueBoundary.array(), "+": "reject" },
	{ kind: "'map-fault'", fault: MapFaultBoundary, "+": "reject" },
)
const MapFaultEntryBoundary = arkType({ valueName: "string", reason: MapFaultReasonBoundary, "+": "reject" })
const ClosureCauseBoundary = arkType.or(
	{ kind: "'map-batch-exception'", stage: "'pre-agent' | 'post-agent'", faults: MapFaultEntryBoundary.array(), "+": "reject" },
	{ kind: "'policy'", reason: "'predicate-false' | 'program-fault'", "+": "reject" },
	{ kind: "'cascade-exhausted'", "+": "reject" },
)
const ClosureExceptionBoundary = arkType({ kind: "'exception'", cause: ClosureCauseBoundary, "+": "reject" })
const TaskSettlementBoundary = arkType.or(
	{ kind: "'returned'", value: "unknown", "+": "reject" },
	{ kind: "'exception'", cause: ClosureExceptionBoundary, attempt: "number.integer >= 0", closure: ClosureIdentityBoundary, "+": "reject" },
)
const TaskStateBoundary = arkType.or(
	{ kind: "'ready'", "+": "reject" },
	{ kind: "'leased'", run: RunIdentityBoundary, acquiredAt: "number", expiresAt: "number", "+": "reject" },
	{ kind: "'suspended'", await: AwaitIdentityBoundary, "+": "reject" },
	{ kind: "'held'", reason: arkType.or(
		{ kind: "'pre-spawn-absence'", endpoint: "string", detail: "string", observedAt: "number", "+": "reject" },
		{ kind: "'unknown-effect'", endpoint: "string", run: RunIdentityBoundary, detail: "string", observedAt: "number", "+": "reject" },
	), "+": "reject" },
	{ kind: "'settled'", settlement: TaskSettlementBoundary, settledAt: "number", "+": "reject" },
)
const TaskBoundary = arkType({
	kind: "'task'",
	identity: TaskIdentityBoundary,
	group: GroupIdentityBoundary,
	input: { definition: DefinitionRefBoundary, entrypoint: "string > 0", basePin: "string > 0", value: "unknown", valueIdentity: "string > 0", "+": "reject" },
	dependsOn: TaskIdentityBoundary.array(),
	priority: "number.integer",
	state: TaskStateBoundary,
	closure: ClosureResourceStateBoundary,
	"+": "reject",
})

const WaitWindowBoundary = arkType.or(
	{ kind: "'none'", "+": "reject" },
	{ kind: "'fixed-deadline'", durationMs: "number > 0", "+": "reject" },
	{ kind: "'sliding-deadline'", durationMs: "number > 0", "+": "reject" },
)
const GroupStateBoundary = arkType.or(
	{ kind: "'open'", "+": "reject" },
	{ kind: "'waiting'", deadline: "number", memberVersion: "number.integer >= 0", "+": "reject" },
	{ kind: "'terminated'", reason: "'immediate' | 'deadline'", memberVersion: "number.integer >= 0", terminatedAt: "number", "+": "reject" },
	{
		kind: "'consuming'",
		consumerTask: TaskIdentityBoundary,
		consumerGroup: GroupIdentityBoundary,
		settlementsDigest: "string > 0",
		startedAt: "number",
		"+": "reject",
	},
	{ kind: "'consumed'", consumption: { kind: "'consumption'", group: GroupIdentityBoundary, value: "string > 0", "+": "reject" }, consumedAt: "number", "+": "reject" },
)
const GroupConsumerBoundary = arkType.or(
	{ kind: "'drain'", "+": "reject" },
	{ kind: "'validator'", definition: DefinitionRefBoundary, entrypoint: "string > 0", "+": "reject" },
	{ kind: "'finalizer'", definition: DefinitionRefBoundary, entrypoint: "string > 0", "+": "reject" },
)
const TaskGroupBoundary = arkType({
	kind: "'task-group'",
	identity: GroupIdentityBoundary,
	members: TaskIdentityBoundary.array(),
	memberVersion: "number.integer >= 0",
	wait: WaitWindowBoundary,
	join: GroupConsumerBoundary,
	state: GroupStateBoundary,
	"+": "reject",
})

const AwaitRecordBoundary = arkType.or(
	{ kind: "'waiting'", identity: AwaitIdentityBoundary, parentClosure: ClosureIdentityBoundary, child: TaskIdentityBoundary, "+": "reject" },
	{
		kind: "'delivered'",
		identity: AwaitIdentityBoundary,
		parentClosure: ClosureIdentityBoundary,
		child: TaskIdentityBoundary,
		settlement: TaskSettlementBoundary,
		token: "string > 0",
		"+": "reject",
	},
	{
		kind: "'consumed'",
		identity: AwaitIdentityBoundary,
		parentClosure: ClosureIdentityBoundary,
		child: TaskIdentityBoundary,
		settlement: TaskSettlementBoundary,
		token: "string > 0",
		consumedAt: "number",
		"+": "reject",
	},
	{ kind: "'continuation-lost'", identity: AwaitIdentityBoundary, parentClosure: ClosureIdentityBoundary, child: TaskIdentityBoundary, "+": "reject" },
)

export type PersistenceParseError = {
	readonly kind: "persisted-shape-invalid"
	readonly entity: "task" | "group" | "await" | "publication" | "group-state" | "closure" | "settlement" | "checkpoint"
	readonly message: string
}

export type PersistenceParseResult<T> =
	| { readonly kind: "accepted"; readonly value: T }
	| { readonly kind: "rejected"; readonly error: PersistenceParseError }

export function parsePersistedTask(candidate: unknown): PersistenceParseResult<Task> {
	const parsed = TaskBoundary(candidate)
	if (parsed instanceof arkType.errors) return rejected("task", parsed.summary)
	const inputValue = jsonValue(parsed.input.value, "task.input.value")
	if (inputValue.kind === "rejected") return inputValue
	const state = parseTaskState(parsed.state)
	if (state.kind === "rejected") return state
	const seed: Task = { kind: "task", identity: parsed.identity, group: parsed.group, input: { ...parsed.input, value: inputValue.value }, dependsOn: parsed.dependsOn, priority: parsed.priority, state: { kind: "ready" }, closure: { kind: "unallocated" } }
	try {
		return { kind: "accepted", value: replaceTaskLifecycle(seed, state.value, parsed.closure) }
	} catch (error) {
		return rejected("task", error instanceof Error ? error.message : String(error))
	}
}

export function parsePersistedGroup(candidate: unknown): PersistenceParseResult<TaskGroup> {
	const parsed = TaskGroupBoundary(candidate)
	if (parsed instanceof arkType.errors) return rejected("group", parsed.summary)
	if (parsed.state.kind === "consuming" && parsed.join.kind === "drain") return rejected("group", "drain join cannot enter consuming")
	return { kind: "accepted", value: parsed }
}

export function parsePersistedAwait(candidate: unknown): PersistenceParseResult<AwaitRecord> {
	const parsed = AwaitRecordBoundary(candidate)
	if (parsed instanceof arkType.errors) return rejected("await", parsed.summary)
	if (parsed.kind !== "delivered" && parsed.kind !== "consumed") return { kind: "accepted", value: parsed }
	const settlement = parseSettlement(parsed.settlement)
	if (settlement.kind === "rejected") return settlement
	return { kind: "accepted", value: { ...parsed, settlement: settlement.value } }
}

export function parsePersistedPublication(candidate: unknown): PersistenceParseResult<PublicationEvidence> {
	const parsed = PublicationEvidenceBoundary(candidate)
	return parsed instanceof arkType.errors ? rejected("publication", parsed.summary) : { kind: "accepted", value: parsed }
}

export function parsePersistedClosure(candidate: unknown): PersistenceParseResult<ClosureResourceState> {
	const parsed = ClosureResourceStateBoundary(candidate)
	return parsed instanceof arkType.errors ? rejected("closure", parsed.summary) : { kind: "accepted", value: parsed }
}

export function parsePersistedGroupState(candidate: unknown): PersistenceParseResult<GroupState> {
	const parsed = GroupStateBoundary(candidate)
	return parsed instanceof arkType.errors ? rejected("group-state", parsed.summary) : { kind: "accepted", value: parsed }
}

export function parsePersistedSettlement(candidate: unknown): PersistenceParseResult<TaskSettlement> {
	const parsed = TaskSettlementBoundary(candidate)
	if (parsed instanceof arkType.errors) return rejected("settlement", parsed.summary)
	return parseSettlement(parsed)
}

export function parseFunctionCheckpoint(candidate: unknown): PersistenceParseResult<FunctionCheckpoint> {
	const parsed = CheckpointBoundary(candidate)
	if (parsed instanceof arkType.errors) return rejected("checkpoint", parsed.summary)
	const context0Values: PersistenceParseResult<ContextValues | null> = parsed.context0 === null ? { kind: "accepted", value: null } : contextValues(parsed.context0.values, "context-0 values")
	if (context0Values.kind === "rejected") return context0Values
	const context1Values: PersistenceParseResult<ContextValues | null> = parsed.context1 === null ? { kind: "accepted", value: null } : contextValues(parsed.context1.values, "context-1 values")
	if (context1Values.kind === "rejected") return context1Values
	const context2Values: PersistenceParseResult<ContextValues | null> = parsed.context2 === null ? { kind: "accepted", value: null } : contextValues(parsed.context2.values, "context-2 values")
	if (context2Values.kind === "rejected") return context2Values
	const context3Values: PersistenceParseResult<ContextValues | null> = parsed.context3 === null ? { kind: "accepted", value: null } : contextValues(parsed.context3.values, "context-3 values")
	if (context3Values.kind === "rejected") return context3Values
	const accepted = contextValues(parsed.agent.accepted, "agent accepted values")
	if (accepted.kind === "rejected") return accepted
	let prompt: FunctionCheckpoint["prompt"] = null
	if (parsed.prompt !== null) {
		const inputValues = contextValues(parsed.prompt.inputValues, "frozen prompt input values")
		if (inputValues.kind === "rejected") return inputValues
		prompt = { kind: "frozen-prompt", text: parsed.prompt.text, inputValues: inputValues.value }
	}
	return {
		kind: "accepted",
		value: {
			run: parsed.run,
			stepId: parsed.stepId,
			runnerSessionIdentity: parsed.runnerSessionIdentity,
			context0: context0Values.value === null ? null : { stage: "context-0", values: context0Values.value },
			context1: context1Values.value === null ? null : { stage: "context-1", values: context1Values.value },
			context2: context2Values.value === null ? null : { stage: "context-2", values: context2Values.value },
			context3: context3Values.value === null ? null : { stage: "context-3", values: context3Values.value },
			prompt,
			agent: { state: parsed.agent.state, accepted: accepted.value },
			predicates: parsed.predicates,
		},
	}
}

export function encodePersisted(value: Task | TaskGroup | AwaitRecord | TaskSettlement | ClosureResourceState | GroupState | PublicationEvidence): string {
	return JSON.stringify(value)
}

export function decodePersisted(raw: string): PersistenceParseResult<JsonValue> {
	let candidate: unknown
	try {
		candidate = JSON.parse(raw)
	} catch (error) {
		return rejected("task", error instanceof Error ? error.message : String(error))
	}
	return jsonValue(candidate, "persisted JSON")
}

function parseTaskState(candidate: typeof TaskStateBoundary.infer): PersistenceParseResult<Task["state"]> {
	if (candidate.kind !== "settled") return { kind: "accepted", value: candidate }
	const settlement = parseSettlement(candidate.settlement)
	if (settlement.kind === "rejected") return settlement
	return { kind: "accepted", value: { ...candidate, settlement: settlement.value } }
}

function parseSettlement(candidate: typeof TaskSettlementBoundary.infer): PersistenceParseResult<TaskSettlement> {
	if (candidate.kind === "returned") {
		const value = jsonValue(candidate.value, "task settlement value")
		return value.kind === "rejected" ? value : { kind: "accepted", value: { kind: "returned", value: value.value } }
	}
	const cause = candidate.cause.cause
	if (cause.kind !== "map-batch-exception") {
		return {
			kind: "accepted",
			value: {
				kind: "exception",
				cause: { kind: "exception", cause },
				attempt: candidate.attempt,
				closure: candidate.closure,
			},
		}
	}
	const faults: MapFaultEntry[] = []
	for (const fault of cause.faults) {
		if (fault.reason.kind !== "parse-rejected") {
			faults.push({ valueName: fault.valueName, reason: fault.reason })
			continue
		}
		const [first, ...rest] = fault.reason.issues
		if (first === undefined) return rejected("settlement", "parse-rejected fault must contain at least one issue")
		faults.push({ ...fault, reason: { kind: "parse-rejected", issues: [first, ...rest] } })
	}
	return {
		kind: "accepted",
		value: {
			...candidate,
			cause: { ...candidate.cause, cause: { ...cause, faults } },
		},
	}
}

function contextValues(candidate: unknown, label: string): PersistenceParseResult<ContextValues> {
	if (!isBoundaryRecord(candidate)) return rejected("checkpoint", `${label}: expected record`)
	const values: Record<string, JsonValue> = {}
	for (const [name, value] of Object.entries(candidate)) {
		const parsed = jsonValue(value, `${label}.${name}`)
		if (parsed.kind === "rejected") return parsed
		values[name] = parsed.value
	}
	return { kind: "accepted", value: values }
}

function jsonValue(candidate: unknown, label: string): PersistenceParseResult<JsonValue> {
	const parsed = parseDeclaredValue({ kind: "json" }, candidate)
	return parsed.kind === "accepted" ? parsed : rejected("task", `${label}: ${parsed.issues.map((issue) => `${issue.path.join(".")}: ${issue.expected}`).join(", ")}`)
}

function rejected<T>(entity: PersistenceParseError["entity"], message: string): PersistenceParseResult<T> {
	return { kind: "rejected", error: { kind: "persisted-shape-invalid", entity, message } }
}
