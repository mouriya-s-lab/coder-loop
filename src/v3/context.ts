import { isBoundaryRecord } from "../boundary-types"
import {
	parseDeclaredValue,
	type DeclaredValue,
	type HandoffContract,
	type JsonValue,
	type ValueParseIssue,
} from "./definition"

export type ContextValues = Readonly<Record<string, JsonValue>>

export type Context0 = { readonly stage: "context-0"; readonly values: ContextValues }
export type Context1 = { readonly stage: "context-1"; readonly values: ContextValues }
export type Context2 = { readonly stage: "context-2"; readonly values: ContextValues }
export type Context3 = { readonly stage: "context-3"; readonly values: ContextValues }
export type TypedContext = Context0 | Context1 | Context2 | Context3
type FunctionCheckpointIdentity = {
	readonly run: AgentRunAuthority
	readonly stepId: string
	readonly runnerSessionIdentity: string | null
}

type FunctionCheckpointPrefix = FunctionCheckpointIdentity & {
	readonly context0: Context0
}

type FunctionCheckpointPreAgent = FunctionCheckpointPrefix & {
	readonly context1: Context1
}

type FunctionCheckpointPrompted = FunctionCheckpointPreAgent & {
	readonly prompt: FrozenPrompt
}

export type FunctionCheckpoint =
	| FunctionCheckpointIdentity & {
		readonly stage: "initial"
		readonly context0: null
		readonly context1: null
		readonly context2: null
		readonly context3: null
		readonly prompt: null
		readonly agent: { readonly state: "not-opened"; readonly accepted: Readonly<Record<string, never>> }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPrefix & {
		readonly stage: "context-0"
		readonly context1: null
		readonly context2: null
		readonly context3: null
		readonly prompt: null
		readonly agent: { readonly state: "not-opened"; readonly accepted: Readonly<Record<string, never>> }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPreAgent & {
		readonly stage: "context-1"
		readonly context2: null
		readonly context3: null
		readonly prompt: null
		readonly agent: { readonly state: "not-opened"; readonly accepted: Readonly<Record<string, never>> }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPrompted & {
		readonly stage: "prompt-frozen"
		readonly context2: null
		readonly context3: null
		readonly agent: { readonly state: "not-opened"; readonly accepted: Readonly<Record<string, never>> }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPrompted & {
		readonly stage: "agent-open"
		readonly context2: null
		readonly context3: null
		readonly agent: { readonly state: "open"; readonly accepted: ContextValues }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPrompted & {
		readonly stage: "context-2"
		readonly context2: Context2
		readonly context3: null
		readonly agent: { readonly state: "closed"; readonly accepted: ContextValues }
		readonly predicates: Readonly<Record<string, never>>
	}
	| FunctionCheckpointPrompted & {
		readonly stage: "context-3"
		readonly context2: Context2
		readonly context3: Context3
		readonly agent: { readonly state: "closed"; readonly accepted: ContextValues }
		readonly predicates: Readonly<Record<string, boolean>>
	}

export type FrozenPrompt = {
	readonly kind: "frozen-prompt"
	readonly text: string
	readonly inputValues: ContextValues
}

export type MapFault = {
	readonly kind: "spawn" | "timeout" | "exit" | "map-rejected"
	readonly message: string
}

export type MapResult =
	| { readonly kind: "produced"; readonly valueName: string; readonly value: unknown }
	| { readonly kind: "absent"; readonly valueName: string }
	| { readonly kind: "fault"; readonly valueName: string; readonly fault: MapFault }

export type MapBatchException = {
	readonly kind: "map-batch-exception"
	readonly stage: "pre-agent" | "post-agent"
	readonly faults: readonly MapFaultEntry[]
}

export type MapFaultEntry = {
	readonly valueName: string
	readonly reason:
		| { readonly kind: "duplicate-result" }
		| { readonly kind: "missing-result" }
		| { readonly kind: "unexpected-result" }
		| { readonly kind: "required-value-absent" }
		| { readonly kind: "parse-rejected"; readonly issues: readonly [ValueParseIssue, ...ValueParseIssue[]] }
		| { readonly kind: "map-fault"; readonly fault: MapFault }
}

export type MapBatchResult<TContext extends Context1 | Context3> =
	| { readonly kind: "settled"; readonly context: TContext }
	| { readonly kind: "exception"; readonly exception: MapBatchException }

export type AgentRunAuthority = {
	readonly kind: "agent-run"
	readonly chainId: string
	readonly taskId: string
	readonly closureId: string
	readonly runId: string
}

export type AgentValueSession =
	| {
		readonly state: "open"
		readonly authority: AgentRunAuthority
		readonly entry: Context1
		readonly declarations: Readonly<Record<string, DeclaredValue>>
		readonly accepted: ContextValues
	}
	| {
		readonly state: "closed"
		readonly authority: AgentRunAuthority
		readonly context: Context2
	}

export type AgentSubmissionResult =
	| {
		readonly kind: "rejected"
		readonly reason: "wrong-run" | "closed" | "undeclared-value" | "invalid-value"
		readonly fields: readonly AgentFieldRejection[]
	}
	| { readonly kind: "accepted"; readonly session: AgentValueSession }

export type AgentFieldRejection = {
	readonly valueName: string
	readonly issues: readonly ValueParseIssue[]
}

export type PromptRenderResult =
	| { readonly kind: "frozen"; readonly prompt: FrozenPrompt }
	| { readonly kind: "exception"; readonly missingValues: readonly string[] }

export type PredicateEvaluator = (name: string, context: Context3) => boolean
export type ChooserEvaluator = (name: string, kind: "agent" | "map", context: Context3) => JsonValue | undefined

export type ClosureEscalation =
	| { readonly kind: "policy"; readonly reason: "predicate-false" | "program-fault" }
	| { readonly kind: "cascade-exhausted" }

export type ClosureExit =
	| { readonly kind: "returned"; readonly value: JsonValue }
	| { readonly kind: "exception"; readonly cause: MapBatchException | ClosureEscalation }

export type TransitionResult =
	| { readonly kind: "internal-successor"; readonly target: string }
	| { readonly kind: "exit"; readonly exit: ClosureExit }

export type Context0Result =
	| { readonly kind: "accepted"; readonly context: Context0 }
	| { readonly kind: "rejected"; readonly fields: readonly AgentFieldRejection[] }

export function parseContext0(declarations: readonly DeclaredValue[], payload: unknown): Context0Result {
	if (!isBoundaryRecord(payload)) {
		return { kind: "rejected", fields: [{ valueName: "$", issues: [{ path: [], expected: "record", actual: payload === null ? "null" : typeof payload }] }] }
	}
	const itemDeclarations = Object.fromEntries(declarations.filter((value) => value.source.kind === "item").map((value) => [value.name, value]))
	const fields: AgentFieldRejection[] = []
	const values: Record<string, JsonValue> = {}
	for (const name of Object.keys(payload)) {
		const declaration = itemDeclarations[name]
		if (declaration === undefined) {
			fields.push({ valueName: name, issues: [{ path: [name], expected: "declared item value", actual: "unexpected field" }] })
			continue
		}
		const parsed = parseDeclaredValue(declaration.type, payload[name])
		if (parsed.kind === "rejected") fields.push({ valueName: name, issues: parsed.issues })
		else values[name] = parsed.value
	}
	for (const declaration of Object.values(itemDeclarations)) {
		if (declaration.required && !Object.hasOwn(values, declaration.name)) fields.push({ valueName: declaration.name, issues: [{ path: [declaration.name], expected: "required item value", actual: "missing" }] })
	}
	return fields.length === 0 ? { kind: "accepted", context: context0(values) } : { kind: "rejected", fields }
}

export function context0(values: ContextValues): Context0 {
	return { stage: "context-0", values: { ...values } }
}

export function settlePreAgentMaps(
	entry: Context0,
	declarations: readonly DeclaredValue[],
	results: readonly MapResult[],
): MapBatchResult<Context1> {
	const settled = settleMapBatch("pre-agent", entry.values, declarations, results)
	return settled.kind === "exception" ? settled : { kind: "settled", context: { stage: "context-1", values: settled.values } }
}

export function freezePrompt(template: string, context: Context1): PromptRenderResult {
	const placeholders = [...template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu)].map((match) => match[1]).filter((value): value is string => value !== undefined)
	const missingValues = [...new Set(placeholders.filter((name) => !Object.hasOwn(context.values, name)))]
	if (missingValues.length > 0) return { kind: "exception", missingValues }
	const text = template.replaceAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu, (_placeholder, name: string) => canonicalValueText(context.values[name] ?? null))
	return { kind: "frozen", prompt: { kind: "frozen-prompt", text, inputValues: { ...context.values } } }
}

export function openAgentValueSession(
	authority: AgentRunAuthority,
	entry: Context1,
	declarations: readonly DeclaredValue[],
): AgentValueSession {
	return {
		state: "open",
		authority,
		entry,
		declarations: Object.fromEntries(declarations.filter((value) => value.source.kind === "agent" && !Object.hasOwn(entry.values, value.name)).map((value) => [value.name, value])),
		accepted: {},
	}
}

export function closeProgramOnlyAgentStage(entry: Context1, _declarations: readonly DeclaredValue[]): AgentValueSession {
	return {
		state: "closed",
		authority: { kind: "agent-run", chainId: "program", taskId: "program", closureId: "program", runId: "program" },
		context: { stage: "context-2", values: { ...entry.values } },
	}
}

export function submitAgentValues(
	session: AgentValueSession,
	authority: AgentRunAuthority,
	payload: unknown,
): AgentSubmissionResult {
	if (session.state === "closed") return { kind: "rejected", reason: "closed", fields: [] }
	if (!sameAuthority(session.authority, authority)) return { kind: "rejected", reason: "wrong-run", fields: [] }
	if (!isBoundaryRecord(payload)) {
		return {
			kind: "rejected",
			reason: "invalid-value",
			fields: [{ valueName: "$", issues: [{ path: [], expected: "record", actual: payload === null ? "null" : typeof payload }] }],
		}
	}

	const unknownFields = Object.keys(payload).filter((name) => !Object.hasOwn(session.declarations, name))
	if (unknownFields.length > 0) {
		return { kind: "rejected", reason: "undeclared-value", fields: unknownFields.map((valueName) => ({ valueName, issues: [] })) }
	}

	const accepted: Record<string, JsonValue> = { ...session.accepted }
	const rejections: AgentFieldRejection[] = []
	for (const [name, input] of Object.entries(payload)) {
		const declaration = session.declarations[name]
		if (declaration === undefined) continue
		const parsed = parseDeclaredValue(declaration.type, input)
		if (parsed.kind === "rejected") rejections.push({ valueName: name, issues: parsed.issues })
		else accepted[name] = parsed.value
	}
	if (rejections.length > 0) return { kind: "rejected", reason: "invalid-value", fields: rejections }

	const missingRequired = Object.values(session.declarations).filter((value) => value.required && !Object.hasOwn(accepted, value.name))
	if (missingRequired.length > 0) {
		return { kind: "accepted", session: { ...session, accepted } }
	}
	return {
		kind: "accepted",
		session: {
			state: "closed",
			authority: session.authority,
			context: { stage: "context-2", values: { ...session.entry.values, ...accepted } },
		},
	}
}

export function settlePostAgentMaps(
	entry: Context2,
	declarations: readonly DeclaredValue[],
	results: readonly MapResult[],
): MapBatchResult<Context3> {
	const settled = settleMapBatch("post-agent", entry.values, declarations, results)
	return settled.kind === "exception" ? settled : { kind: "settled", context: { stage: "context-3", values: settled.values } }
}

export function evaluateTransition(
	contract: HandoffContract,
	context: Context3,
	evaluatePredicate: PredicateEvaluator,
	evaluateChooser: ChooserEvaluator = (name, _kind, current) => current.values[name],
): TransitionResult {
	const fail = contract.successors.find((successor) => successor.when === "fail")
	const normal = contract.successors.filter((successor) => successor.when !== "fail")
	if (!contract.predicates.every((predicate) => evaluatePredicate(predicate, context))) {
		if (fail !== undefined) return { kind: "internal-successor", target: fail.target }
		return contract.onNil === "return-nil"
			? { kind: "exit", exit: { kind: "returned", value: null } }
			: { kind: "exit", exit: { kind: "exception", cause: { kind: "policy", reason: "predicate-false" } } }
	}
	if (normal.length === 0) {
		const value = context.values[contract.returnValue]
		if (value === undefined) return { kind: "exit", exit: { kind: "exception", cause: { kind: "policy", reason: "program-fault" } } }
		return { kind: "exit", exit: { kind: "returned", value } }
	}
	if (normal.length === 1) {
		const target = normal[0]?.target
		return target === undefined
			? { kind: "exit", exit: { kind: "exception", cause: { kind: "cascade-exhausted" } } }
			: { kind: "internal-successor", target }
	}
	const chooser = contract.chooser
	const selected = chooser === null ? undefined : evaluateChooser(chooser.name, chooser.kind, context)
	if (typeof selected !== "string" || !normal.some((successor) => successor.target === selected)) {
		return { kind: "exit", exit: { kind: "exception", cause: { kind: "policy", reason: "program-fault" } } }
	}
	return { kind: "internal-successor", target: selected }
}

export function routeProgramException(contract: HandoffContract): TransitionResult {
	const fail = contract.onException === "fail"
		? contract.successors.find((successor) => successor.when === "fail")
		: undefined
	return fail === undefined
		? { kind: "exit", exit: { kind: "exception", cause: { kind: "policy", reason: "program-fault" } } }
		: { kind: "internal-successor", target: fail.target }
}
function settleMapBatch(
	stage: "pre-agent" | "post-agent",
	entryValues: ContextValues,
	declarations: readonly DeclaredValue[],
	results: readonly MapResult[],
): { readonly kind: "settled"; readonly values: ContextValues } | { readonly kind: "exception"; readonly exception: MapBatchException } {
	const expected = Object.fromEntries(declarations.filter((value) => value.source.kind === "map" && value.source.stage === stage && !Object.hasOwn(entryValues, value.name)).map((value) => [value.name, value]))
	const grouped = new Map<string, MapResult[]>()
	for (const result of results) {
		const entries = grouped.get(result.valueName)
		if (entries === undefined) grouped.set(result.valueName, [result])
		else entries.push(result)
	}
	const faults: MapFaultEntry[] = []
	const additions: Record<string, JsonValue> = {}

	for (const [valueName, entries] of grouped) {
		const declaration = expected[valueName]
		if (declaration === undefined) {
			faults.push({ valueName, reason: { kind: "unexpected-result" } })
			continue
		}
		if (entries.length !== 1) {
			faults.push({ valueName, reason: { kind: "duplicate-result" } })
			continue
		}
		const result = entries[0]
		if (result === undefined) continue
		if (result.kind === "fault") faults.push({ valueName, reason: { kind: "map-fault", fault: result.fault } })
		else if (result.kind === "absent") {
			if (declaration.required) faults.push({ valueName, reason: { kind: "required-value-absent" } })
		} else {
			const parsed = parseDeclaredValue(declaration.type, result.value)
			if (parsed.kind === "rejected") faults.push({ valueName, reason: { kind: "parse-rejected", issues: parsed.issues } })
			else additions[valueName] = parsed.value
		}
	}
	for (const [valueName, declaration] of Object.entries(expected)) {
		if (!grouped.has(valueName)) faults.push({ valueName, reason: declaration.required ? { kind: "required-value-absent" } : { kind: "missing-result" } })
	}
	return faults.length > 0
		? { kind: "exception", exception: { kind: "map-batch-exception", stage, faults } }
		: { kind: "settled", values: { ...entryValues, ...additions } }
}

function sameAuthority(left: AgentRunAuthority, right: AgentRunAuthority): boolean {
	return left.chainId === right.chainId && left.taskId === right.taskId && left.closureId === right.closureId && left.runId === right.runId
}

function canonicalValueText(value: JsonValue): string {
	return typeof value === "string" ? value : JSON.stringify(value)
}
