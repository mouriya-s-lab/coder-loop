import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import {
	closeProgramOnlyAgentStage,
	evaluateTransition,
	freezePrompt,
	openAgentValueSession,
	parseContext0,
	settlePostAgentMaps,
	settlePreAgentMaps,
	submitAgentValues,
	type AgentRunAuthority,
	type AgentSubmissionResult,
	type AgentValueSession,
	type Context0,
	type Context1,
	type Context2,
	type Context3,
	type FunctionCheckpoint,
} from "./context"
import { DefinitionStore, type DefinitionStoreError, type DefinitionStoreService } from "./definition-store"
import { type DeclaredValue, type JsonValue, type PresetDefinition, type RecursiveTaskDefinition } from "./definition"
import { MapRuntime, PredicateRuntime, type PredicateAdapterError } from "./function-adapters"
import { HookRuntime, type HookDeliveryAudit, type HookProjection, type HookRuntimeError, type HookRuntimeService } from "./hooks"
import {
	groupKey,
	taskKey,
	type CommittedTransition,
	type FactIdentity,
	type RunIdentity,
	type Task,
	type TaskHoldReason,
	type TaskIdentity,
	type TaskSettlement,
} from "./object-domain"
import { ProviderFactStore, RunnerProvider, runProviderFactIdentity, type ProviderFactStoreError } from "./provider"
import { ObjectDomainStore, type CommitResult, type ObjectDomainStoreService, type ObjectStoreError } from "./sqlite-store"

export type FunctionRuntimeError =
	| DefinitionStoreError
	| ObjectStoreError
	| ProviderFactStoreError
	| PredicateAdapterError
	| { readonly kind: "runtime-definition-error"; readonly reason: "invalid-json" | "invalid-definition" | "identity-mismatch" | "missing-task" | "missing-prompt"; readonly message: string }
	| { readonly kind: "runtime-state-error"; readonly reason: "missing-task" | "not-leased" | "missing-group" | "invalid-closure"; readonly message: string }

export type HookDispatchObservation =
	| { readonly kind: "delivered"; readonly anchor: HookProjection["anchor"]; readonly audits: readonly HookDeliveryAudit[] }
	| { readonly kind: "failed"; readonly anchor: HookProjection["anchor"]; readonly error: HookRuntimeError }

export type FunctionTimeline = readonly [Context0, Context1, Context2, Context3]

export type FunctionExecutionResult =
	| { readonly kind: "settled"; readonly commit: CommitResult; readonly settlement: TaskSettlement; readonly timeline: FunctionTimeline; readonly hooks: readonly HookDispatchObservation[] }
	| { readonly kind: "held"; readonly commit: CommitResult; readonly reason: TaskHoldReason; readonly hooks: readonly HookDispatchObservation[] }

export type FunctionRuntimeService = {
	readonly execute: (task: TaskIdentity) => Effect.Effect<FunctionExecutionResult, FunctionRuntimeError>
	readonly submit: (authority: AgentRunAuthority, payload: unknown) => Effect.Effect<AgentSubmissionResult, FunctionRuntimeError>
}

export class FunctionRuntime extends Context.Tag("coder-loop/v3/FunctionRuntime")<FunctionRuntime, FunctionRuntimeService>() {}

export function makeFunctionRuntimeLive(agentTransport: { readonly socketPath: string; readonly submitArgv: readonly string[] }): Layer.Layer<FunctionRuntime, never, DefinitionStore | ObjectDomainStore | MapRuntime | PredicateRuntime | HookRuntime | RunnerProvider | ProviderFactStore> {
	if (agentTransport.submitArgv.length === 0) throw new Error("agent submit argv must not be empty")
	return Layer.effect(
	FunctionRuntime,
	Effect.gen(function*() {
		const definitions = yield* DefinitionStore
		const store = yield* ObjectDomainStore
		const maps = yield* MapRuntime
		const predicates = yield* PredicateRuntime
		const hooks = yield* HookRuntime
		const provider = yield* RunnerProvider
		const facts = yield* ProviderFactStore
		const sessions = new Map<string, AgentValueSession>()

		const submit = (authority: AgentRunAuthority, payload: unknown): Effect.Effect<AgentSubmissionResult, FunctionRuntimeError> => Effect.gen(function*() {
			const key = authorityKey(authority)
			let session = sessions.get(key)
			const checkpoint = yield* store.readFunctionCheckpoint(authority)
			if (checkpoint === null) return { kind: "rejected", reason: "wrong-run", fields: [] }
			if (session === undefined) {
				const snapshot = yield* store.readSnapshot({ kind: "chain", value: authority.chainId })
				const task = Object.values(snapshot.tasks).find((candidate) => taskKey(candidate.identity) === authority.taskId)
				if (task === undefined) return { kind: "rejected", reason: "wrong-run", fields: [] }
				const loaded = yield* loadLeaf(definitions, task)
				const recovered = sessionFromCheckpoint(checkpoint, loaded.definition.values)
				if (recovered === null) return { kind: "rejected", reason: "wrong-run", fields: [] }
				session = recovered
			}
			const result = submitAgentValues(session, authority, payload)
			if (result.kind === "rejected") return result
			sessions.set(key, result.session)
			const updated: FunctionCheckpoint = result.session.state === "closed"
				? { ...checkpoint, context2: result.session.context, agent: { state: "closed", accepted: checkpoint.agent.accepted } }
				: { ...checkpoint, agent: { state: "open", accepted: result.session.accepted } }
			yield* store.writeFunctionCheckpoint(updated)
			return result
		})

		const execute = (identity: TaskIdentity): Effect.Effect<FunctionExecutionResult, FunctionRuntimeError> => Effect.gen(function*() {
			const snapshot = yield* store.readSnapshot(identity.chain)
			const task = snapshot.tasks[taskKey(identity)]
			if (task === undefined) return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "missing-task", message: `task ${taskKey(identity)} does not exist` })
			if (task.state.kind !== "leased") return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "not-leased", message: `task ${taskKey(identity)} is not leased` })
			if (task.closure.kind !== "active") return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "invalid-closure", message: `leased task ${taskKey(identity)} does not have active closure resources` })
			const run = task.state.run
			const authority = authorityFor(run)
			const loaded = yield* loadLeaf(definitions, task)
			const hooksObserved: HookDispatchObservation[] = []
			let checkpoint = (yield* store.readFunctionCheckpoint(authority)) ?? emptyCheckpoint(authority)
			yield* observeHook(hooks, hooksObserved, run, "function-entry", task.input.value)

			let context0 = checkpoint.context0
			if (context0 === null) {
				const parsed = parseContext0(loaded.definition.values, task.input.value)
				if (parsed.kind === "rejected") return yield* settleException(store, hooks, hooksObserved, task, run, { kind: "policy", reason: "program-fault" })
				context0 = parsed.context
				checkpoint = { ...checkpoint, context0 }
				yield* store.writeFunctionCheckpoint(checkpoint)
			}

			let context1 = checkpoint.context1
			if (context1 === null) {
				yield* observeHook(hooks, hooksObserved, run, "pre-map", context0.values)
				const preResults = yield* maps.execute("pre-agent", task.input.definition, loaded.definition.values, context0.values, task.closure.worktree)
				const pre = settlePreAgentMaps(context0, loaded.definition.values, preResults)
				if (pre.kind === "exception") return yield* settleException(store, hooks, hooksObserved, task, run, pre.exception)
				context1 = pre.context
				checkpoint = { ...checkpoint, context1 }
				yield* store.writeFunctionCheckpoint(checkpoint)
			}

			let frozenPrompt = checkpoint.prompt
			if (frozenPrompt === null) {
				const prompt = freezePrompt(loaded.prompt, context1)
				if (prompt.kind === "exception") return yield* settleException(store, hooks, hooksObserved, task, run, { kind: "policy", reason: "program-fault" })
				frozenPrompt = prompt.prompt
				checkpoint = { ...checkpoint, prompt: frozenPrompt }
				yield* store.writeFunctionCheckpoint(checkpoint)
			}
			yield* observeHook(hooks, hooksObserved, run, "prompt-frozen", frozenPrompt.inputValues)

			const key = authorityKey(authority)
			let session = sessionFromCheckpoint(checkpoint, loaded.definition.values)
			if (session === null) {
				const hasAgentValues = loaded.definition.values.some((value) => value.source.kind === "agent")
				session = hasAgentValues ? openAgentValueSession(authority, context1, loaded.definition.values) : closeProgramOnlyAgentStage(context1, loaded.definition.values)
				checkpoint = session.state === "closed"
					? { ...checkpoint, context2: session.context, agent: { state: "closed", accepted: {} } }
					: { ...checkpoint, agent: { state: "open", accepted: session.accepted } }
				yield* store.writeFunctionCheckpoint(checkpoint)
			}
			sessions.set(key, session)
			yield* observeHook(hooks, hooksObserved, run, "agent-start", { run: authority.runId })
			const existingFact = yield* facts.read(runProviderFactIdentity(run))
			const fact = existingFact ?? (yield* provider.invoke({
				attemptIdentity: `${taskKey(task.identity)}:${run.closure.attempt}`,
				run,
				prompt: agentPrompt(frozenPrompt.text, loaded.definition.values, agentTransport.submitArgv),
				continuation: continuationFor(task),
				cwd: task.closure.worktree,
				env: { CODER_LOOP_AGENT_AUTHORITY: JSON.stringify(authority), CODER_LOOP_SOCKET: agentTransport.socketPath },
			}))

			if (fact.kind === "unknown-effect") {
				const reason: TaskHoldReason = { kind: "unknown-effect", endpoint: fact.endpoint.digest, run, detail: fact.detail, observedAt: fact.observedAt }
				const commit = yield* store.commit({ identity: `hold:${runKey(run)}`, transition: { family: "task-held", task: task.identity, expectedRun: run, reason } })
				sessions.delete(key)
				return { kind: "held", commit, reason, hooks: hooksObserved }
			}
			if (fact.kind !== "terminal-winner") {
				sessions.delete(key)
				return yield* settleException(store, hooks, hooksObserved, task, run, { kind: "policy", reason: "program-fault" })
			}
			const durableCheckpoint = yield* store.readFunctionCheckpoint(authority)
			const closed = sessions.get(key) ?? (durableCheckpoint === null ? null : sessionFromCheckpoint(durableCheckpoint, loaded.definition.values))
			sessions.delete(key)
			if (closed?.state !== "closed") return yield* settleException(store, hooks, hooksObserved, task, run, { kind: "policy", reason: "program-fault" })
			const context2 = closed.context

			let context3 = durableCheckpoint?.context3 ?? null
			let predicateValues = durableCheckpoint?.predicates ?? {}
			if (context3 === null) {
				yield* observeHook(hooks, hooksObserved, run, "post-map", context2.values)
				const postResults = yield* maps.execute("post-agent", task.input.definition, loaded.definition.values, context2.values, task.closure.worktree)
				const post = settlePostAgentMaps(context2, loaded.definition.values, postResults)
				if (post.kind === "exception") return yield* settleException(store, hooks, hooksObserved, task, run, post.exception)
				context3 = post.context
				predicateValues = yield* predicates.evaluate(loaded.leaf.contract.predicates, loaded.definition.consumers, context3)
				checkpoint = { ...(durableCheckpoint ?? checkpoint), context2, context3, predicates: predicateValues, agent: { state: "closed", accepted: checkpoint.agent.accepted } }
				yield* store.writeFunctionCheckpoint(checkpoint)
			}
			yield* observeHook(hooks, hooksObserved, run, "routing", predicateValues)
			const transition = evaluateTransition(
				loaded.leaf.contract,
				context3,
				(name) => predicateValues[name] ?? false,
				(name, kind, current) => {
					const consumer = loaded.definition.consumers.find((candidate) => candidate.kind === "chooser" && candidate.chooser === name)
					if (consumer === undefined) return undefined
					const declaration = loaded.definition.values.find((value) => value.name === consumer.value)
					return declaration?.source.kind === kind ? current.values[consumer.value] : undefined
				},
			)
			const timeline: FunctionTimeline = [context0, context1, context2, context3]
			if (transition.kind === "exit") {
				const settlement: TaskSettlement = transition.exit.kind === "returned"
					? { kind: "returned", value: transition.exit.value }
					: { kind: "exception", cause: transition.exit, attempt: run.closure.attempt, closure: run.closure }
				return yield* commitSettlement(store, hooks, hooksObserved, task, run, settlement, [], timeline)
			}
			const latest = yield* store.readSnapshot(task.identity.chain)
			const group = latest.groups[groupKey(task.group)]
			if (group === undefined) return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "missing-group", message: `group ${groupKey(task.group)} does not exist` })
			const successor = makeSuccessor(task, transition.target, context3)
			const successorFact: FactIdentity = { kind: "fact", source: `handoff:${taskKey(task.identity)}`, value: `${transition.target}:${run.value}` }
			const settlement: TaskSettlement = { kind: "returned", value: context3.values[loaded.leaf.contract.returnValue] ?? null }
			return yield* commitSettlement(store, hooks, hooksObserved, task, run, settlement, [{ fact: successorFact, task: successor, position: { group: task.group, expectedMemberVersion: group.memberVersion } }], timeline)
		})

		return { execute, submit }
	}),
)
}

function agentPrompt(template: string, declarations: readonly DeclaredValue[], submitArgv: readonly string[]): string {
	const values = declarations.filter((value) => value.source.kind === "agent")
	if (values.length === 0) return template
	const fields = values.map((value) => ({ name: value.name, required: value.required, type: value.type }))
	return `${template}

The task returns typed values through coder-loop's agent submission boundary.
Required declaration: ${JSON.stringify(fields)}
Before your final response, write one JSON object containing those fields to an absolute file path. Invoke this exact argv followed by --values and that path:
${JSON.stringify([...submitArgv, "agent", "submit"])}
If the command rejects a field, correct the JSON and submit again. Do not report success until the command accepts and closes the value session.`
}

function emptyCheckpoint(authority: AgentRunAuthority): FunctionCheckpoint {
	return {
		run: authority,
		context0: null,
		context1: null,
		context2: null,
		context3: null,
		prompt: null,
		agent: { state: "not-opened", accepted: {} },
		predicates: {},
	}
}

function sessionFromCheckpoint(checkpoint: FunctionCheckpoint, declarations: readonly DeclaredValue[]): AgentValueSession | null {
	if (checkpoint.agent.state === "closed") {
		return checkpoint.context2 === null ? null : { state: "closed", authority: checkpoint.run, context: checkpoint.context2 }
	}
	if (checkpoint.agent.state !== "open" || checkpoint.context1 === null) return null
	return {
		state: "open",
		authority: checkpoint.run,
		entry: checkpoint.context1,
		declarations: Object.fromEntries(declarations.filter((value) => value.source.kind === "agent").map((value) => [value.name, value])),
		accepted: checkpoint.agent.accepted,
	}
}

function authorityKey(authority: AgentRunAuthority): string {
	return `${authority.chainId}/${authority.taskId}/${authority.closureId}/${authority.runId}`
}

function loadLeaf(definitions: DefinitionStoreService, task: Task): Effect.Effect<{ readonly definition: PresetDefinition; readonly leaf: Extract<RecursiveTaskDefinition, { kind: "leaf" }>; readonly prompt: string }, FunctionRuntimeError> {
	return Effect.flatMap(definitions.resolve(task.input.definition), (bundle) => Effect.try({
		try: () => {
			const node = findTask(bundle.definition.task, task.identity.value)
			if (node?.kind !== "leaf") throw definitionError("missing-task", `leaf ${task.identity.value} does not exist in the pinned definition`)
			const promptBytes = bundle.assets[node.promptAsset]
			if (promptBytes === undefined) throw definitionError("missing-prompt", `prompt asset ${node.promptAsset} is missing`)
			return { definition: bundle.definition, leaf: node, prompt: new TextDecoder("utf-8", { fatal: true }).decode(promptBytes) }
		},
		catch: (error): FunctionRuntimeError => isFunctionRuntimeError(error) ? error : definitionError("invalid-definition", error instanceof Error ? error.message : String(error)),
	}))
}

function settleException(
	store: ObjectDomainStoreService, hooks: HookRuntimeService, observed: HookDispatchObservation[], task: Task, run: RunIdentity,
	cause: Extract<TaskSettlement, { kind: "exception" }>["cause"]["cause"],
): Effect.Effect<FunctionExecutionResult, FunctionRuntimeError> {
	const settlement: TaskSettlement = { kind: "exception", cause: { kind: "exception", cause }, attempt: run.closure.attempt, closure: run.closure }
	return commitSettlement(store, hooks, observed, task, run, settlement, [], null)
}

function commitSettlement(
	store: ObjectDomainStoreService, hooks: HookRuntimeService, observed: HookDispatchObservation[], task: Task, run: RunIdentity,
	settlement: TaskSettlement,
	successors: Extract<CommittedTransition, { family: "task-settlement" }>["successors"],
	timeline: FunctionTimeline | null,
): Effect.Effect<FunctionExecutionResult, FunctionRuntimeError> {
	return Effect.gen(function*() {
		yield* observeHook(hooks, observed, run, "function-exit", { settlement: settlement.kind })
		const commit = yield* store.commit({ identity: `settle:${runKey(run)}`, transition: { family: "task-settlement", task: task.identity, run, settlement, successors } })
		yield* observeHook(hooks, observed, run, "committed-transition", { identity: commit.identity })
		const resolvedTimeline = timeline ?? syntheticTimeline(task.input.value)
		return { kind: "settled", commit, settlement, timeline: resolvedTimeline, hooks: observed }
	})
}

function observeHook(hooks: HookRuntimeService, observed: HookDispatchObservation[], run: RunIdentity, anchor: HookProjection["anchor"], facts: HookProjection["facts"]): Effect.Effect<void> {
	const projection: HookProjection = { anchor, occurrenceIdentity: `${runKey(run)}:${anchor}`, observedAt: Date.now(), facts }
	return Effect.map(Effect.match(hooks.trigger(projection), {
		onFailure: (error): HookDispatchObservation => ({ kind: "failed", anchor, error }),
		onSuccess: (audits): HookDispatchObservation => ({ kind: "delivered", anchor, audits }),
	}), (observation) => { observed.push(observation) })
}

function makeSuccessor(parent: Task, target: string, context: Context3): Task {
	const identity: TaskIdentity = { kind: "task", chain: parent.identity.chain, value: target }
	const valueIdentity = createHash("sha256").update(JSON.stringify(context.values)).digest("hex")
	return { identity, group: parent.group, input: { definition: parent.input.definition, basePin: parent.input.basePin, value: context.values, valueIdentity }, dependsOn: [parent.identity], priority: parent.priority, state: { kind: "ready" }, closure: { kind: "unallocated" } }
}

function findTask(node: RecursiveTaskDefinition, id: string): RecursiveTaskDefinition | null {
	if (node.id === id) return node
	if (node.kind === "leaf") return null
	for (const child of node.children) {
		const found = findTask(child, id)
		if (found !== null) return found
	}
	return null
}

function authorityFor(run: RunIdentity): AgentRunAuthority {
	return { kind: "agent-run", chainId: run.closure.task.chain.value, taskId: taskKey(run.closure.task), closureId: `${taskKey(run.closure.task)}/${run.closure.attempt}`, runId: run.value }
}

function continuationFor(task: Task): { readonly kind: "fresh" } | { readonly kind: "resume"; readonly sessionIdentity: string } {
	return task.closure.kind === "suspended" && task.closure.continuation.kind === "present"
		? { kind: "resume", sessionIdentity: task.closure.continuation.sessionIdentity }
		: { kind: "fresh" }
}

function runKey(run: RunIdentity): string {
	return `${taskKey(run.closure.task)}/${run.closure.attempt}/${run.value}`
}

function syntheticTimeline(value: Task["input"]["value"]): FunctionTimeline {
	const values: Readonly<Record<string, JsonValue>> = isJsonRecord(value) ? value : {}
	return [
		{ stage: "context-0", values },
		{ stage: "context-1", values },
		{ stage: "context-2", values },
		{ stage: "context-3", values },
	]
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function definitionError(reason: Extract<FunctionRuntimeError, { kind: "runtime-definition-error" }>["reason"], message: string): Extract<FunctionRuntimeError, { kind: "runtime-definition-error" }> {
	return { kind: "runtime-definition-error", reason, message }
}

function isFunctionRuntimeError(error: unknown): error is FunctionRuntimeError {
	return typeof error === "object" && error !== null && "kind" in error && typeof error.kind === "string"
}

