import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import {
	closeProgramOnlyAgentStage,
	evaluateTransition,
	freezePrompt,
	openAgentValueSession,
	parseContext0,
	routeProgramException,
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
	type ContextValues,
	type FrozenPrompt,
	type FunctionCheckpoint,
} from "./context"
import { DefinitionStore, type DefinitionStoreError, type DefinitionStoreService } from "./definition-store"
import { type DeclaredValue, type FinalizerDefinition, type JsonValue, type RecursiveTaskDefinition, type ValueConsumer } from "./definition"
import { MapRuntime, PredicateRuntime, type PredicateAdapterError } from "./function-adapters"
import { HookRuntime, type HookDeliveryAudit, type HookProjection, type HookRuntimeError, type HookRuntimeService } from "./hooks"
import {
	groupKey,
	taskKey,
	type AwaitIdentity,
	type AwaitRecord,
	type CommittedTransition,
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
	| { readonly kind: "suspended"; readonly await: AwaitIdentity; readonly hooks: readonly HookDispatchObservation[] }

export type FunctionRuntimeService = {
	readonly execute: (task: TaskIdentity) => Effect.Effect<FunctionExecutionResult, FunctionRuntimeError>
	readonly submit: (authority: AgentRunAuthority, payload: unknown) => Effect.Effect<AgentSubmissionResult, FunctionRuntimeError>
}

export class FunctionRuntime extends Context.Tag("coder-loop/v3/FunctionRuntime")<FunctionRuntime, FunctionRuntimeService>() {}

export function makeFunctionRuntimeLive(agentTransport: { readonly socketPath: string; readonly submitArgv: readonly string[] }): Layer.Layer<FunctionRuntime, never, DefinitionStore | ObjectDomainStore | MapRuntime | PredicateRuntime | HookRuntime | RunnerProvider | ProviderFactStore> {
	if (agentTransport.submitArgv.length === 0) throw new Error("agent submit argv must not be empty")
	return Layer.effect(FunctionRuntime, Effect.gen(function*() {
		const definitions = yield* DefinitionStore
		const store = yield* ObjectDomainStore
		const maps = yield* MapRuntime
		const predicates = yield* PredicateRuntime
		const hooks = yield* HookRuntime
		const runner = yield* RunnerProvider
		const facts = yield* ProviderFactStore
		const sessions = new Map<string, AgentValueSession>()
		const submissionGate = yield* Effect.makeSemaphore(1)

		const submit = (authority: AgentRunAuthority, payload: unknown): Effect.Effect<AgentSubmissionResult, FunctionRuntimeError> =>
			submissionGate.withPermits(1)(Effect.gen(function*() {
				const key = authorityKey(authority)
				const snapshot = yield* store.readSnapshot({ kind: "chain", value: authority.chainId })
				const task = Object.values(snapshot.tasks).find((candidate) => taskKey(candidate.identity) === authority.taskId)
				if (task === undefined || !authorityOwnsLiveLease(authority, task, Date.now())) return { kind: "rejected", reason: "wrong-run", fields: [] }
				const checkpoint = yield* store.readFunctionCheckpoint(authority)
				if (checkpoint === null) return { kind: "rejected", reason: "wrong-run", fields: [] }
				let session = sessions.get(key)
				if (session === undefined) {
					const loaded = yield* loadLeaf(definitions, task, checkpoint.stepId)
					const recovered = restoreAgentSessionFromCheckpoint(checkpoint, loaded.declarations)
					if (recovered === null) return { kind: "rejected", reason: "wrong-run", fields: [] }
					session = recovered
				}
				const result = submitAgentValues(session, authority, payload)
				if (result.kind === "rejected") return result
				sessions.set(key, result.session)
				const updated: FunctionCheckpoint = result.session.state === "closed"
					? checkpointAtContext2(checkpoint, result.session.context)
					: checkpointAtAgentOpen(checkpoint, result.session.accepted)
				yield* store.writeFunctionCheckpoint(updated)
				return result
			}))

		const execute = (identity: TaskIdentity): Effect.Effect<FunctionExecutionResult, FunctionRuntimeError> => Effect.gen(function*() {
			const snapshot = yield* store.readSnapshot(identity.chain)
			const task = snapshot.tasks[taskKey(identity)]
			if (task === undefined) return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "missing-task", message: `task ${taskKey(identity)} does not exist` })
			if (task.state.kind !== "leased") return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "not-leased", message: `task ${taskKey(identity)} is not leased` })
			if (task.closure.kind !== "active" && task.closure.kind !== "suspended") return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "invalid-closure", message: `leased task ${taskKey(identity)} has no live closure` })
			const run = task.state.run
			const authority = authorityFor(run)
			const checkpointRead = yield* store.readFunctionCheckpoint(authority)
			const continuationSessionIdentity = task.closure.kind === "suspended" && task.closure.continuation.kind === "present"
				? task.closure.continuation.sessionIdentity
				: null
			let checkpoint: FunctionCheckpoint = checkpointRead === null
				? emptyCheckpoint(authority, task.input.entrypoint, continuationSessionIdentity)
				: {
						...checkpointRead,
						run: authority,
						runnerSessionIdentity: checkpointRead.runnerSessionIdentity ?? continuationSessionIdentity,
					}
			if (checkpointRead !== null) yield* store.writeFunctionCheckpoint(checkpoint)
			const awaitDelivery = Object.values(snapshot.awaits).find((record): record is Extract<AwaitRecord, { kind: "delivered" }> =>
				record.kind === "delivered"
				&& taskKey(record.identity.parent) === taskKey(task.identity)
				&& record.parentClosure.attempt === run.closure.attempt)
			const hooksObserved: HookDispatchObservation[] = []
			yield* observeHook(hooks, hooksObserved, run, "function-entry", { task: taskKey(task.identity) })

			while (true) {
				const loaded = yield* loadLeaf(definitions, task, checkpoint.stepId)
				const declarations = loaded.declarations
				let context0 = checkpoint.context0
				if (context0 === null) {
					const parsed = parseContext0(declarations, task.input.value)
					if (parsed.kind === "rejected") return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
					context0 = parsed.context
					checkpoint = checkpointAtContext0(checkpoint, context0)
					yield* store.writeFunctionCheckpoint(checkpoint)
				}

				let context1 = checkpoint.context1
				if (context1 === null) {
					yield* observeHook(hooks, hooksObserved, run, "pre-map", context0.values, checkpoint.stepId)
					const preResults = yield* maps.execute("pre-agent", task.input.definition, declarations, context0.values, task.closure.worktree)
					const pre = settlePreAgentMaps(context0, declarations, preResults)
					if (pre.kind === "exception") {
						const next = failureSuccessor(loaded.leaf.contract)
						if (next === null) return yield* settleException(store, hooks, hooksObserved, task, run, pre.exception)
						checkpoint = stepCheckpoint(authority, next, context0.values, checkpoint.runnerSessionIdentity)
						yield* store.writeFunctionCheckpoint(checkpoint)
						continue
					}
					context1 = pre.context
					checkpoint = checkpointAtContext1(checkpoint, context1)
					yield* store.writeFunctionCheckpoint(checkpoint)
				}

				let prompt = checkpoint.prompt
				if (prompt === null) {
					const rendered = freezePrompt(agentPrompt(loaded.prompt, declarations, agentTransport.submitArgv), context1)
					if (rendered.kind === "exception") {
						const next = failureSuccessor(loaded.leaf.contract)
						if (next === null) return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
						checkpoint = stepCheckpoint(authority, next, context1.values, checkpoint.runnerSessionIdentity)
						yield* store.writeFunctionCheckpoint(checkpoint)
						continue
					}
					prompt = rendered.prompt
					yield* observeHook(hooks, hooksObserved, run, "prompt-frozen", context1.values, checkpoint.stepId)
					checkpoint = checkpointAtPrompt(checkpoint, prompt)
					yield* store.writeFunctionCheckpoint(checkpoint)
				}

					let session = restoreAgentSessionFromCheckpoint(checkpoint, declarations)
					let context2 = checkpoint.context2
					if ((checkpoint.stage === "context-2" || checkpoint.stage === "context-3") && session === null) {
						return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
					}
					if (context2 === null) {
					if (session === null) {
						session = declarations.some((value) => value.source.kind === "agent" && !Object.hasOwn(context1.values, value.name))
							? openAgentValueSession(authority, context1, declarations)
							: closeProgramOnlyAgentStage(context1, declarations)
						sessions.set(authorityKey(authority), session)
						checkpoint = session.state === "open"
							? checkpointAtAgentOpen(checkpoint, session.accepted)
							: checkpointAtContext2(checkpoint, session.context)
						yield* store.writeFunctionCheckpoint(checkpoint)
					}

					if (session.state === "open") {
						const factIdentity = runProviderFactIdentity(run)
						const existing = yield* facts.read(factIdentity)
						const probe = existing === null ? yield* runner.probe : null
						if (existing === null && probe?.kind !== "ready") {
							const reason: TaskHoldReason = probe?.kind === "absent"
								? { kind: "pre-spawn-absence", endpoint: probe.endpoint.digest, detail: probe.evidence.detail, observedAt: probe.evidence.observedAt }
								: { kind: "unknown-effect", endpoint: probe?.endpoint.digest ?? runner.endpoint.digest, run, detail: probe?.evidence.detail ?? "runner endpoint state is unknown", observedAt: probe?.evidence.observedAt ?? Date.now() }
							if (probe?.kind === "absent") yield* runner.recordAbsence(`${runKey(run)}:${checkpoint.stepId}`, probe.evidence)
							const hold = yield* store.commit({ identity: `hold:${runKey(run)}`, transition: { family: "task-held", task: task.identity, expectedRun: run, reason } })
							return { kind: "held", commit: hold, reason, hooks: hooksObserved }
					}
						yield* observeHook(hooks, hooksObserved, run, "agent-start", { endpoint: runner.endpoint.digest }, checkpoint.stepId)
						const fact = existing ?? (yield* runner.invoke({
							attemptIdentity: `${runKey(run)}:${checkpoint.stepId}`,
							factIdentity,
							run,
							prompt: awaitDelivery === undefined ? prompt.text : awaitResumePrompt(awaitDelivery),
							cwd: task.closure.worktree,
							env: {
								CODER_LOOP_AGENT_AUTHORITY: JSON.stringify(authority),
								CODER_LOOP_SOCKET: agentTransport.socketPath,
								...(awaitDelivery === undefined ? {} : { CODER_LOOP_AWAIT_DELIVERY: JSON.stringify(awaitDelivery) }),
							},
							allowedSocketPath: agentTransport.socketPath,
							continuation: checkpoint.runnerSessionIdentity === null
								? { kind: "fresh" }
								: { kind: "resume", sessionIdentity: checkpoint.runnerSessionIdentity },
						}))
						if (awaitDelivery !== undefined && fact.kind !== "unknown-effect") {
							yield* store.commit({
								identity: `await-consume:${awaitDelivery.token}`,
								transition: {
									family: "await-consumption",
									task: task.identity,
									record: { ...awaitDelivery, kind: "consumed", consumedAt: Date.now() },
								},
							})
						}
						const postInvocationSnapshot = yield* store.readSnapshot(identity.chain)
						const postInvocationTask = postInvocationSnapshot.tasks[taskKey(identity)]
						if (postInvocationTask?.state.kind === "suspended") {
							return { kind: "suspended", await: postInvocationTask.state.await, hooks: hooksObserved }
						}
						if (fact.kind === "unknown-effect") {
							const reason: TaskHoldReason = { kind: "unknown-effect", endpoint: fact.endpoint.digest, run, detail: fact.detail, observedAt: fact.observedAt }
							const hold = yield* store.commit({ identity: `hold:${runKey(run)}`, transition: { family: "task-held", task: task.identity, expectedRun: run, reason } })
							return { kind: "held", commit: hold, reason, hooks: hooksObserved }
						}
						if (fact.kind !== "terminal-winner") {
							const next = failureSuccessor(loaded.leaf.contract)
							if (next === null) return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
							checkpoint = stepCheckpoint(authority, next, context1.values, checkpoint.runnerSessionIdentity)
							yield* store.writeFunctionCheckpoint(checkpoint)
							continue
						}
						checkpoint = { ...checkpoint, runnerSessionIdentity: fact.sessionIdentity }
						const persistedAfterRun = yield* store.readFunctionCheckpoint(authority)
						const persistedSession = persistedAfterRun === null ? null : restoreAgentSessionFromCheckpoint(persistedAfterRun, declarations)
						const reported = persistedSession ?? sessions.get(authorityKey(authority))
						if (reported?.state !== "closed") return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
						session = reported
						sessions.set(authorityKey(authority), session)
						}
					if (session.state !== "closed") return yield* settleException(store, hooks, hooksObserved, task, run, programFault())
					context2 = session.context
					sessions.delete(authorityKey(authority))
					checkpoint = checkpointAtContext2(checkpoint, context2)
					yield* store.writeFunctionCheckpoint(checkpoint)
				}

				let context3 = checkpoint.context3
				if (context3 === null) {
					const postResults = yield* maps.execute("post-agent", task.input.definition, declarations, context2.values, task.closure.worktree)
					const post = settlePostAgentMaps(context2, declarations, postResults)
					if (post.kind === "exception") {
						const next = failureSuccessor(loaded.leaf.contract)
						if (next === null) return yield* settleException(store, hooks, hooksObserved, task, run, post.exception)
						checkpoint = stepCheckpoint(authority, next, context2.values, checkpoint.runnerSessionIdentity)
						yield* store.writeFunctionCheckpoint(checkpoint)
						continue
					}
					context3 = post.context
					checkpoint = checkpointAtContext3(checkpoint, context3)
					yield* store.writeFunctionCheckpoint(checkpoint)
				}

				yield* observeHook(hooks, hooksObserved, run, "post-map", context2.values, checkpoint.stepId)
				const pendingPredicates = loaded.leaf.contract.predicates.filter((predicate) => !Object.hasOwn(checkpoint.predicates, predicate))
				if (pendingPredicates.length > 0) {
					const evaluated = yield* predicates.evaluate(pendingPredicates, loaded.consumers, context3)
					if (checkpoint.stage !== "context-3") throw new Error("predicates require a context-3 checkpoint")
					checkpoint = { ...checkpoint, predicates: { ...checkpoint.predicates, ...evaluated } }
					yield* store.writeFunctionCheckpoint(checkpoint)
				}
				const predicateValues = checkpoint.predicates
				yield* observeHook(hooks, hooksObserved, run, "routing", context3.values, checkpoint.stepId)
				const transition = evaluateTransition(
					loaded.leaf.contract,
					context3,
					(name) => predicateValues[name] ?? false,
					(name) => context3.values[loaded.consumers.find((consumer) => consumer.kind === "chooser" && consumer.chooser === name)?.value ?? ""],
				)
				if (transition.kind === "internal-successor") {
					checkpoint = stepCheckpoint(authority, transition.target, context3.values, checkpoint.runnerSessionIdentity)
					yield* store.writeFunctionCheckpoint(checkpoint)
					continue
				}
				if (transition.exit.kind === "exception") return yield* settleException(store, hooks, hooksObserved, task, run, transition.exit.cause)
				const returnedValue = transition.exit.value

				const targets = nextObjectLeaves(loaded.programRoot, checkpoint.stepId)
				const latest = yield* store.readSnapshot(identity.chain)
				const group = latest.groups[groupKey(task.group)]
				if (group === undefined) return yield* Effect.fail<FunctionRuntimeError>({ kind: "runtime-state-error", reason: "missing-group", message: `group ${groupKey(task.group)} does not exist` })
				const pendingTargets = targets.filter((target) => !Object.hasOwn(latest.tasks, taskKey({ kind: "task", chain: task.identity.chain, value: target })))
				const successors = pendingTargets.map((target, index) => {
					const successor = makeSuccessor(task, target, context3.values, declarations)
					return {
						fact: { kind: "fact", source: `function:${taskKey(task.identity)}`, value: `${target}:${run.value}` } as const,
						task: successor,
						position: { group: task.group, expectedMemberVersion: group.memberVersion + index },
					}
				})
				const settlement: TaskSettlement = { kind: "returned", value: returnedValue }
				return yield* commitSettlement(store, hooks, hooksObserved, task, run, settlement, successors, null)
			}
		})

		return { execute, submit }
	}))
}

function agentPrompt(template: string, declarations: readonly DeclaredValue[], submitArgv: readonly string[]): string {
	const values = declarations.filter((value) => value.source.kind === "agent")
	if (values.length === 0) return template
	const fields = values.map((value) => ({ name: value.name, required: value.required, type: value.type }))
	return `${template}

The task returns typed values through coder-loop's agent submission boundary.
Required declaration: ${JSON.stringify(fields)}
Before your final response, write one JSON object containing those fields to an absolute file path. Invoke this exact argv followed by --values and that path:
${JSON.stringify(submitArgv)}
If the command rejects a field, correct the JSON and submit again. Do not report success until the command accepts and closes the value session.`
}
function awaitResumePrompt(delivery: Extract<AwaitRecord, { kind: "delivered" }>): string {
	return `The child awaited by this preserved session has settled. Consume this one-shot typed delivery exactly once, continue the suspended task, and use the existing coder-loop agent submission command for the final declared values.
${JSON.stringify({ token: delivery.token, child: taskKey(delivery.child), settlement: delivery.settlement })}`
}


function emptyCheckpoint(authority: AgentRunAuthority, stepId: string, runnerSessionIdentity: string | null): FunctionCheckpoint {
	return {
		run: authority,
		stepId,
		runnerSessionIdentity,
		stage: "initial",
		context0: null,
		context1: null,
		context2: null,
		context3: null,
		prompt: null,
		agent: { state: "not-opened", accepted: {} },
		predicates: {},
	}
}

function stepCheckpoint(authority: AgentRunAuthority, stepId: string, values: ContextValues, runnerSessionIdentity: string | null): FunctionCheckpoint {
	return checkpointAtContext0(emptyCheckpoint(authority, stepId, runnerSessionIdentity), { stage: "context-0", values: { ...values } })
}

function checkpointIdentity(checkpoint: FunctionCheckpoint): Pick<FunctionCheckpoint, "run" | "stepId" | "runnerSessionIdentity"> {
	return { run: checkpoint.run, stepId: checkpoint.stepId, runnerSessionIdentity: checkpoint.runnerSessionIdentity }
}

function checkpointAtContext0(checkpoint: FunctionCheckpoint, context0: Context0): FunctionCheckpoint {
	return { ...checkpointIdentity(checkpoint), stage: "context-0", context0, context1: null, context2: null, context3: null, prompt: null, agent: { state: "not-opened", accepted: {} }, predicates: {} }
}

function checkpointAtContext1(checkpoint: FunctionCheckpoint, context1: Context1): FunctionCheckpoint {
	if (checkpoint.context0 === null) throw new Error("context-1 requires context-0")
	return { ...checkpointIdentity(checkpoint), stage: "context-1", context0: checkpoint.context0, context1, context2: null, context3: null, prompt: null, agent: { state: "not-opened", accepted: {} }, predicates: {} }
}

function checkpointAtPrompt(checkpoint: FunctionCheckpoint, prompt: FrozenPrompt): FunctionCheckpoint {
	if (checkpoint.context0 === null || checkpoint.context1 === null) throw new Error("frozen prompt requires context-1")
	return { ...checkpointIdentity(checkpoint), stage: "prompt-frozen", context0: checkpoint.context0, context1: checkpoint.context1, context2: null, context3: null, prompt, agent: { state: "not-opened", accepted: {} }, predicates: {} }
}

function checkpointAtAgentOpen(checkpoint: FunctionCheckpoint, accepted: ContextValues): FunctionCheckpoint {
	if (checkpoint.context0 === null || checkpoint.context1 === null || checkpoint.prompt === null) throw new Error("open agent requires a frozen prompt")
	return { ...checkpointIdentity(checkpoint), stage: "agent-open", context0: checkpoint.context0, context1: checkpoint.context1, context2: null, context3: null, prompt: checkpoint.prompt, agent: { state: "open", accepted }, predicates: {} }
}

function checkpointAtContext2(checkpoint: FunctionCheckpoint, context2: Context2): FunctionCheckpoint {
	if (checkpoint.context0 === null || checkpoint.context1 === null || checkpoint.prompt === null) throw new Error("context-2 requires a frozen prompt")
	return { ...checkpointIdentity(checkpoint), stage: "context-2", context0: checkpoint.context0, context1: checkpoint.context1, context2, context3: null, prompt: checkpoint.prompt, agent: { state: "closed", accepted: context2.values }, predicates: {} }
}

function checkpointAtContext3(checkpoint: FunctionCheckpoint, context3: Context3): FunctionCheckpoint {
	if (checkpoint.context0 === null || checkpoint.context1 === null || checkpoint.context2 === null || checkpoint.prompt === null) throw new Error("context-3 requires context-2")
	return { ...checkpointIdentity(checkpoint), stage: "context-3", context0: checkpoint.context0, context1: checkpoint.context1, context2: checkpoint.context2, context3, prompt: checkpoint.prompt, agent: { state: "closed", accepted: checkpoint.context2.values }, predicates: {} }
}

export function restoreAgentSessionFromCheckpoint(checkpoint: FunctionCheckpoint, declarations: readonly DeclaredValue[]): AgentValueSession | null {
	if (checkpoint.context1 === null) return null
	const fresh = openAgentValueSession(checkpoint.run, checkpoint.context1, declarations)
	if (checkpoint.stage === "agent-open") {
		const restored = submitAgentValues(fresh, checkpoint.run, checkpoint.agent.accepted)
		return restored.kind === "accepted" && restored.session.state === "open" ? restored.session : null
	}
	if (checkpoint.stage !== "context-2" && checkpoint.stage !== "context-3") return null
	const agentValues = Object.fromEntries(Object.entries(checkpoint.context2.values).filter(([name]) => !Object.hasOwn(checkpoint.context1.values, name)))
	const restored = submitAgentValues(fresh, checkpoint.run, agentValues)
	return restored.kind === "accepted" && restored.session.state === "closed" && sameContextValues(restored.session.context.values, checkpoint.context2.values)
		? restored.session
		: null
}

function sameContextValues(left: ContextValues, right: ContextValues): boolean {
	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
}

function sameJsonValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === undefined || right === undefined || left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right
	if (isJsonValueArray(left)) return isJsonValueArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
	if (isJsonValueArray(right)) return false
	return sameContextValues(left, right)
}

function isJsonValueArray(value: JsonValue): value is readonly JsonValue[] {
	return Array.isArray(value)
}

function authorityKey(authority: AgentRunAuthority): string {
	return `${authority.chainId}/${authority.taskId}/${authority.closureId}/${authority.runId}`
}


function loadLeaf(definitions: DefinitionStoreService, task: Task, stepId: string): Effect.Effect<{
	readonly programRoot: RecursiveTaskDefinition
	readonly declarations: readonly DeclaredValue[]
	readonly consumers: readonly ValueConsumer[]
	readonly leaf: Extract<RecursiveTaskDefinition, { kind: "leaf" }>
	readonly prompt: string
}, FunctionRuntimeError> {
	return Effect.flatMap(definitions.resolve(task.input.definition), (bundle) => Effect.try({
		try: () => {
			const node = findTask(bundle.definition.task, stepId)
			const finalizer = node === null ? findFinalizerProgram(bundle.definition.task, stepId) : null
			const leaf = node?.kind === "leaf" ? node : finalizer?.task
			if (leaf === undefined) throw definitionError("missing-task", `leaf ${stepId} does not exist in the pinned definition`)
			const promptBytes = bundle.assets[leaf.promptAsset]
			if (promptBytes === undefined) throw definitionError("missing-prompt", `prompt asset ${leaf.promptAsset} is missing`)
			return {
				programRoot: finalizer?.task ?? bundle.definition.task,
				declarations: finalizer?.values ?? bundle.definition.values,
				consumers: finalizer?.consumers ?? bundle.definition.consumers,
				leaf,
				prompt: new TextDecoder("utf-8", { fatal: true }).decode(promptBytes),
			}
		},
		catch: (error): FunctionRuntimeError => {
			if (isFunctionRuntimeError(error)) return error
			const message = error instanceof Error ? error.message : String(error)
			return definitionError("invalid-definition", message)
		},
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

function observeHook(
	hooks: HookRuntimeService,
	observed: HookDispatchObservation[],
	run: RunIdentity,
	anchor: HookProjection["anchor"],
	facts: HookProjection["facts"],
	stepId?: string,
): Effect.Effect<void> {
	const projection: HookProjection = { anchor, occurrenceIdentity: `${runKey(run)}:${stepId ?? "function"}:${anchor}`, observedAt: Date.now(), facts }
	return Effect.map(Effect.match(hooks.trigger(projection), {
		onFailure: (error): HookDispatchObservation => ({ kind: "failed", anchor, error }),
		onSuccess: (audits): HookDispatchObservation => ({ kind: "delivered", anchor, audits }),
	}), (observation) => { observed.push(observation) })
}

function makeSuccessor(parent: Task, target: string, context: ContextValues, declarations: readonly DeclaredValue[]): Task {
	const identity: TaskIdentity = { kind: "task", chain: parent.identity.chain, value: target }
	const itemNames = new Set(declarations.filter((declaration) => declaration.source.kind === "item").map((declaration) => declaration.name))
	const value = Object.fromEntries(Object.entries(context).filter(([name]) => itemNames.has(name)))
	const valueIdentity = createHash("sha256").update(JSON.stringify(value)).digest("hex")
	return { kind: "task", identity, group: parent.group, input: { definition: parent.input.definition, entrypoint: identity.value, basePin: parent.input.basePin, value, valueIdentity }, dependsOn: [parent.identity], priority: parent.priority, state: { kind: "ready" }, closure: { kind: "unallocated" } }
}

function failureSuccessor(contract: Extract<RecursiveTaskDefinition, { readonly kind: "leaf" }>["contract"]): string | null {
	const transition = routeProgramException(contract)
	return transition.kind === "internal-successor" ? transition.target : null
}

function programFault(): { readonly kind: "policy"; readonly reason: "program-fault" } {
	return { kind: "policy", reason: "program-fault" }
}

function nextObjectLeaves(root: RecursiveTaskDefinition, currentId: string): readonly string[] {
	const path = findTaskPath(root, currentId)
	if (path === null) return []
	for (let index = path.length - 2; index >= 0; index -= 1) {
		const parent = path[index]
		const current = path[index + 1]
		if (parent === undefined || current === undefined || parent.kind === "leaf") continue
		const childIndex = parent.children.findIndex((child) => child.id === current.id)
		const next = parent.children[childIndex + 1]
		if (parent.kind === "par") continue
		if (next !== undefined) return entryLeaves(next)
	}
	return []
}

function entryLeaves(node: RecursiveTaskDefinition): readonly string[] {
	if (node.kind === "leaf") return [node.id]
	if (node.kind === "seq") return node.children[0] === undefined ? [] : entryLeaves(node.children[0])
	return node.children.flatMap(entryLeaves)
}

function findTaskPath(node: RecursiveTaskDefinition, id: string): readonly RecursiveTaskDefinition[] | null {
	if (node.id === id) return [node]
	if (node.kind === "leaf") return null
	for (const child of node.children) {
		const found = findTaskPath(child, id)
		if (found !== null) return [node, ...found]
	}
	return null
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
function findFinalizerProgram(node: RecursiveTaskDefinition, id: string): FinalizerDefinition | null {
	if (node.kind === "leaf") return null
	if (node.kind === "par" && node.finalizer.task.id === id) return node.finalizer
	for (const child of node.children) {
		const found = findFinalizerProgram(child, id)
		if (found !== null) return found
	}
	return null
}


function authorityFor(run: RunIdentity): AgentRunAuthority {
	return { kind: "agent-run", chainId: run.closure.task.chain.value, taskId: taskKey(run.closure.task), closureId: `${taskKey(run.closure.task)}/${run.closure.attempt}`, runId: run.value }
}

function authorityOwnsLiveLease(authority: AgentRunAuthority, task: Task, now: number): boolean {
	if (task.state.kind !== "leased" || task.state.expiresAt <= now) return false
	const expected = authorityFor(task.state.run)
	return authority.chainId === expected.chainId
		&& authority.taskId === expected.taskId
		&& authority.closureId === expected.closureId
		&& authority.runId === expected.runId
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
