import { type as arkType } from "arktype"
import type { AgentRunAuthority } from "./context"
import { parseDeclaredValue, type JsonValue, type PresetDefinition } from "./definition"
import type { DefinitionRef } from "./definition-store"
import {
	taskKey,
	type AdmissionRequest,
	type ChainIdentity,
	type TaskIdentity,
} from "./object-domain"
import { parsePresetDefinition } from "./schema"

export type DaemonCaller =
	| { readonly kind: "operator" }
	| { readonly kind: "agent"; readonly authority: AgentRunAuthority }

export type ChainBootstrapCommand = {
	readonly kind: "chain-bootstrap"
	readonly chain: ChainIdentity
	readonly definition: DefinitionRef
	readonly basePin: string
	readonly input: JsonValue
	readonly priority: number
}

export type DaemonCommand =
	| { readonly kind: "definition-publish"; readonly definition: PresetDefinition; readonly assets: Readonly<Record<string, string>> }
	| ChainBootstrapCommand
	| { readonly kind: "status-read"; readonly chain: ChainIdentity }
	| { readonly kind: "events-read"; readonly chain: ChainIdentity; readonly since: number }
	| { readonly kind: "audit-read" }
	| { readonly kind: "task-admit"; readonly chain: ChainIdentity; readonly request: AdmissionRequest }
	| { readonly kind: "task-unhold"; readonly task: TaskIdentity; readonly commandIdentity: string }
	| { readonly kind: "agent-await"; readonly site: string; readonly sessionIdentity: string; readonly child: AdmissionRequest }
	| { readonly kind: "agent-submit"; readonly values: Readonly<Record<string, unknown>> }

export type DaemonRequest = {
	readonly schemaVersion: 3
	readonly requestId: string
	readonly caller: DaemonCaller
	readonly command: DaemonCommand
}

export type DaemonRequestRejection = {
	readonly kind: "request-rejected"
	readonly reason: "invalid-envelope" | "invalid-command" | "unauthorized"
	readonly issues: readonly string[]
}

export type DaemonRequestParseResult =
	| { readonly kind: "accepted"; readonly request: DaemonRequest }
	| { readonly kind: "rejected"; readonly rejection: DaemonRequestRejection }

const ChainBoundary = arkType({ kind: "'chain'", value: "string > 0", "+": "reject" })
const TaskBoundary = arkType({ kind: "'task'", chain: ChainBoundary, value: "string > 0", "+": "reject" })
const GroupBoundary = arkType({ kind: "'group'", chain: ChainBoundary, value: "string > 0", "+": "reject" })
const RunBoundary = arkType({
	kind: "'run'",
	closure: { kind: "'closure'", task: TaskBoundary, attempt: "number.integer >= 0", "+": "reject" },
	value: "string > 0",
	"+": "reject",
})
const CallerBoundary = arkType.or(
	{ kind: "'operator'", "+": "reject" },
	{ kind: "'agent'", authority: { kind: "'agent-run'", chainId: "string > 0", taskId: "string > 0", closureId: "string > 0", runId: "string > 0", "+": "reject" }, "+": "reject" },
)
const EnvelopeBoundary = arkType({ schemaVersion: "3", requestId: "string > 0", caller: CallerBoundary, command: "unknown", "+": "reject" })
const DefinitionRefBoundary = arkType({
	kind: "'published-definition'",
	content: { kind: "'definition-content'", digest: "string > 0", "+": "reject" },
	product: { kind: "'compiled-product'", digest: "string > 0", "+": "reject" },
	"+": "reject",
})
const AdmissionBoundary = arkType({
	fact: { kind: "'fact'", source: "string > 0", value: "string > 0", "+": "reject" },
	position: { group: GroupBoundary, expectedMemberVersion: "number.integer >= 0", "+": "reject" },
	timing: arkType.or(
		{ kind: "'before-termination'", "+": "reject" },
		{ kind: "'before-deadline'", claimedAt: "number", "+": "reject" },
	),
	authority: arkType.or(
		{ kind: "'internal'", run: RunBoundary, allowedGroup: GroupBoundary, "+": "reject" },
		{ kind: "'external'", principal: "string > 0", allowedChain: ChainBoundary, "+": "reject" },
	),
	task: {
		identity: TaskBoundary,
		group: GroupBoundary,
		input: { definition: DefinitionRefBoundary, entrypoint: "string > 0", basePin: "string > 0", value: "unknown", valueIdentity: "string > 0", "+": "reject" },
		dependsOn: TaskBoundary.array(),
		priority: "number.integer",
		"+": "reject",
	},
	"+": "reject",
})
const BootstrapBoundary = arkType({
	kind: "'chain-bootstrap'",
	chain: ChainBoundary,
	definition: DefinitionRefBoundary,
	basePin: "string > 0",
	input: "unknown",
	priority: "number.integer",
	"+": "reject",
})

export function parseDaemonRequest(candidate: unknown): DaemonRequestParseResult {
	const envelope = EnvelopeBoundary(candidate)
	if (envelope instanceof arkType.errors) return rejected("invalid-envelope", envelope.summary)
	const command = parseCommand(envelope.command)
	if (command.kind === "rejected") return command
	const request: DaemonRequest = { schemaVersion: 3, requestId: envelope.requestId, caller: envelope.caller, command: command.command }
	const authorization = authorize(request)
	return authorization === null ? { kind: "accepted", request } : { kind: "rejected", rejection: authorization }
}

type CommandParseResult =
	| { readonly kind: "accepted-command"; readonly command: DaemonCommand }
	| { readonly kind: "rejected"; readonly rejection: DaemonRequestRejection }

function parseCommand(candidate: unknown): CommandParseResult {
	if (isCommandKind(candidate, "definition-publish")) {
		const parsed = arkType({ kind: "'definition-publish'", definition: "unknown", assets: { "[string]": "string" }, "+": "reject" })(candidate)
		if (parsed instanceof arkType.errors) return rejectedCommand(parsed.summary)
		const definition = parsePresetDefinition(parsed.definition)
		return definition.kind === "rejected"
			? rejectedCommand(definition.issues.map((issue) => `${issue.path.join(".")}: ${issue.expected}`).join("; "))
			: { kind: "accepted-command", command: { kind: "definition-publish", definition: definition.definition, assets: parsed.assets } }
	}
	if (isCommandKind(candidate, "chain-bootstrap")) {
		const parsed = BootstrapBoundary(candidate)
		if (parsed instanceof arkType.errors) return rejectedCommand(parsed.summary)
		const input = parseDeclaredValue({ kind: "json" }, parsed.input)
		return input.kind === "rejected"
			? rejectedCommand("chain bootstrap input is not JSON")
			: { kind: "accepted-command", command: { ...parsed, input: input.value } }
	}
	if (isCommandKind(candidate, "status-read")) {
		const parsed = arkType({ kind: "'status-read'", chain: ChainBoundary, "+": "reject" })(candidate)
		return parsed instanceof arkType.errors ? rejectedCommand(parsed.summary) : { kind: "accepted-command", command: parsed }
	}
	if (isCommandKind(candidate, "events-read")) {
		const parsed = arkType({ kind: "'events-read'", chain: ChainBoundary, since: "number.integer >= 0", "+": "reject" })(candidate)
		return parsed instanceof arkType.errors ? rejectedCommand(parsed.summary) : { kind: "accepted-command", command: parsed }
	}
	if (isCommandKind(candidate, "audit-read")) {
		const parsed = arkType({ kind: "'audit-read'", "+": "reject" })(candidate)
		return parsed instanceof arkType.errors ? rejectedCommand(parsed.summary) : { kind: "accepted-command", command: parsed }
	}
	if (isCommandKind(candidate, "task-admit")) {
		const parsed = arkType({ kind: "'task-admit'", chain: ChainBoundary, request: AdmissionBoundary, "+": "reject" })(candidate)
		if (parsed instanceof arkType.errors) return rejectedCommand(parsed.summary)
		const value = parseDeclaredValue({ kind: "json" }, parsed.request.task.input.value)
		if (value.kind === "rejected") return rejectedCommand("task input is not JSON")
		return { kind: "accepted-command", command: { ...parsed, request: { ...parsed.request, task: { ...parsed.request.task, input: { ...parsed.request.task.input, value: value.value } } } } }
	}
	if (isCommandKind(candidate, "task-unhold")) {
		const parsed = arkType({ kind: "'task-unhold'", task: TaskBoundary, commandIdentity: "string > 0", "+": "reject" })(candidate)
		return parsed instanceof arkType.errors ? rejectedCommand(parsed.summary) : { kind: "accepted-command", command: parsed }
	}
	if (isCommandKind(candidate, "agent-await")) {
		const parsed = arkType({ kind: "'agent-await'", site: "string > 0", sessionIdentity: "string > 0", child: AdmissionBoundary, "+": "reject" })(candidate)
		if (parsed instanceof arkType.errors) return rejectedCommand(parsed.summary)
		const value = parseDeclaredValue({ kind: "json" }, parsed.child.task.input.value)
		if (value.kind === "rejected") return rejectedCommand("await child input is not JSON")
		return { kind: "accepted-command", command: { ...parsed, child: { ...parsed.child, task: { ...parsed.child.task, input: { ...parsed.child.task.input, value: value.value } } } } }
	}
	if (isCommandKind(candidate, "agent-submit")) {
		const parsed = arkType({ kind: "'agent-submit'", values: { "[string]": "unknown" }, "+": "reject" })(candidate)
		return parsed instanceof arkType.errors ? rejectedCommand(parsed.summary) : { kind: "accepted-command", command: { kind: "agent-submit", values: parsed.values } }
	}
	return rejectedCommand("unknown command kind")
}


function authorize(request: DaemonRequest): DaemonRequestRejection | null {
	if (request.command.kind === "agent-submit") return request.caller.kind === "agent" ? null : { kind: "request-rejected", reason: "unauthorized", issues: ["agent-submit requires agent authority"] }
	if (request.command.kind === "agent-await") {
		if (request.caller.kind !== "agent" || request.command.child.authority.kind !== "internal") {
			return { kind: "request-rejected", reason: "unauthorized", issues: ["agent-await requires matching internal agent authority"] }
		}
		const run = request.command.child.authority.run
		const caller = request.caller.authority
		const expectedClosure = `${taskKey(run.closure.task)}/${run.closure.attempt}`
		const matches = caller.chainId === run.closure.task.chain.value
			&& caller.taskId === taskKey(run.closure.task)
			&& caller.closureId === expectedClosure
			&& caller.runId === run.value
		return matches ? null : { kind: "request-rejected", reason: "unauthorized", issues: ["caller authority does not match the await parent run"] }
	}
	if (request.command.kind === "task-admit" && request.command.request.authority.kind === "internal") {
		if (request.caller.kind !== "agent") return { kind: "request-rejected", reason: "unauthorized", issues: ["internal admission requires agent authority"] }
		const run = request.command.request.authority.run
		const expectedClosure = `${taskKey(run.closure.task)}/${run.closure.attempt}`
		const caller = request.caller.authority
		const matches = caller.chainId === run.closure.task.chain.value
			&& caller.taskId === taskKey(run.closure.task)
			&& caller.closureId === expectedClosure
			&& caller.runId === run.value
			&& request.command.chain.value === caller.chainId
		return matches ? null : { kind: "request-rejected", reason: "unauthorized", issues: ["caller authority does not match the complete admission run identity"] }
	}
	return request.caller.kind === "operator" ? null : { kind: "request-rejected", reason: "unauthorized", issues: ["operator command requires operator authority"] }
}

function isCommandKind(candidate: unknown, kind: DaemonCommand["kind"]): candidate is Readonly<Record<string, unknown>> & { readonly kind: string } {
	return typeof candidate === "object" && candidate !== null && "kind" in candidate && candidate.kind === kind
}

function rejected(reason: DaemonRequestRejection["reason"], issue: string): DaemonRequestParseResult {
	return { kind: "rejected", rejection: { kind: "request-rejected", reason, issues: [issue] } }
}

function rejectedCommand(issue: string): { readonly kind: "rejected"; readonly rejection: DaemonRequestRejection } {
	return { kind: "rejected", rejection: { kind: "request-rejected", reason: "invalid-command", issues: [issue] } }
}
