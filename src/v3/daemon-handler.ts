import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { TypedAdmission, type AdmissionCommitResult } from "./admission"
import { parseContext0, type AgentFieldRejection, type AgentSubmissionResult } from "./context"
import {
	parseDaemonRequest,
	type ChainBootstrapCommand,
	type DaemonRequest,
	type DaemonRequestRejection,
} from "./daemon-protocol"
import { compilePresetDefinition, resolveCompileAssets, type RecursiveTaskDefinition } from "./definition"
import { DefinitionStore, type DefinitionRef, type DefinitionStoreError } from "./definition-store"
import { FunctionRuntime, type FunctionRuntimeError } from "./function-runtime"
import { RepositoryGit, type GitServiceError } from "./git-service"
import { HookRuntime, type HookRuntimeError } from "./hooks"
import { groupKey, taskKey, type AdmissionRequest, type GroupIdentity, type RunIdentity } from "./object-domain"
import { buildEventProjection, buildSideEffectAuditProjection, buildStatusProjection, type EventProjectionV3, type SideEffectAuditProjection, type StatusProjectionV3 } from "./projection"
import { ProviderFactStore, type ProviderFactStoreError } from "./provider"
import { ObjectDomainStore, type BootstrapRequest, type CommitResult, type ObjectStoreError } from "./sqlite-store"

export type DaemonCommandSuccess =
	| { readonly kind: "definition-published"; readonly ref: DefinitionRef }
	| { readonly kind: "chain-bootstrapped"; readonly chain: string }
	| { readonly kind: "status"; readonly projection: StatusProjectionV3 }
	| { readonly kind: "events"; readonly projection: EventProjectionV3 }
	| { readonly kind: "audit"; readonly projection: SideEffectAuditProjection }
	| { readonly kind: "admission"; readonly result: AdmissionCommitResult }
	| { readonly kind: "await-suspended"; readonly await: string; readonly result: CommitResult }
	| { readonly kind: "task-unheld"; readonly result: CommitResult }
	| { readonly kind: "agent-submission"; readonly result: AgentSubmissionResult }

export type ChainBootstrapError = {
	readonly kind: "chain-bootstrap-rejected"
	readonly fields: readonly AgentFieldRejection[]
}

export type TaskInputError = {
	readonly kind: "task-input-rejected"
	readonly task: string
	readonly fields: readonly AgentFieldRejection[]
}

export type AgentAuthorityError = {
	readonly kind: "agent-authority-rejected"
	readonly reason: "missing-live-run" | "scope-mismatch"
	readonly message: string
}

export type DaemonHandlerError = ObjectStoreError | FunctionRuntimeError | DefinitionStoreError | GitServiceError | HookRuntimeError | ProviderFactStoreError | ChainBootstrapError | TaskInputError | AgentAuthorityError

export type DaemonResponse = {
	readonly schemaVersion: 3
	readonly requestId: string | null
	readonly outcome:
		| { readonly kind: "success"; readonly value: DaemonCommandSuccess }
		| { readonly kind: "rejected"; readonly rejection: DaemonRequestRejection }
		| { readonly kind: "failure"; readonly error: DaemonHandlerError }
}

export type DaemonProtocolService = {
	readonly handle: (candidate: unknown) => Effect.Effect<DaemonResponse>
}

export class DaemonProtocol extends Context.Tag("coder-loop/v3/DaemonProtocol")<DaemonProtocol, DaemonProtocolService>() {}

export const DaemonProtocolLive: Layer.Layer<DaemonProtocol, never, ObjectDomainStore | TypedAdmission | FunctionRuntime | DefinitionStore | RepositoryGit | HookRuntime | ProviderFactStore> = Layer.effect(DaemonProtocol, Effect.gen(function*() {
	const store = yield* ObjectDomainStore
	const admission = yield* TypedAdmission
	const runtime = yield* FunctionRuntime
	const definitions = yield* DefinitionStore
	const repository = yield* RepositoryGit
	const hooks = yield* HookRuntime
	const providerFacts = yield* ProviderFactStore
	return {
		handle: (candidate) => {
			const parsed = parseDaemonRequest(candidate)
			if (parsed.kind === "rejected") return Effect.succeed({ schemaVersion: 3, requestId: requestIdentity(candidate), outcome: { kind: "rejected", rejection: parsed.rejection } })
			return Effect.match(dispatch(parsed.request, store, admission, runtime, definitions, repository, hooks, providerFacts), {
				onFailure: (error): DaemonResponse => ({ schemaVersion: 3, requestId: parsed.request.requestId, outcome: { kind: "failure", error } }),
				onSuccess: (value): DaemonResponse => ({ schemaVersion: 3, requestId: parsed.request.requestId, outcome: { kind: "success", value } }),
			})
		},
	}
}))

function dispatch(
	request: DaemonRequest,
	store: typeof ObjectDomainStore.Service,
	admission: typeof TypedAdmission.Service,
	runtime: typeof FunctionRuntime.Service,
	definitions: typeof DefinitionStore.Service,
	repository: typeof RepositoryGit.Service,
	hooks: typeof HookRuntime.Service,
	providerFacts: typeof ProviderFactStore.Service,
): Effect.Effect<DaemonCommandSuccess, DaemonHandlerError> {
	const command = request.command
	switch (command.kind) {
		case "definition-publish": {
			const assets = { ...command.assets, "definition.json": `${JSON.stringify(command.definition)}\n` }
			const envelope = resolveCompileAssets(compilePresetDefinition(command.definition), assets)
			return Effect.map(definitions.publish(envelope, assets), (ref): DaemonCommandSuccess => ({ kind: "definition-published", ref }))
		}
		case "chain-bootstrap":
			return Effect.gen(function*() {
				const bundle = yield* definitions.resolve(command.definition)
				const input = parseContext0(bundle.definition.values, command.input)
				if (input.kind === "rejected") return yield* Effect.fail<ChainBootstrapError>({ kind: "chain-bootstrap-rejected", fields: input.fields })
				const basePin = yield* repository.resolveBasePin(command.basePin)
				const bootstrap = bootstrapRequest({ ...command, basePin, input: input.context.values }, bundle.definition.task)
				return yield* Effect.as(store.bootstrap(bootstrap), { kind: "chain-bootstrapped" as const, chain: command.chain.value })
			})
		case "status-read":
			return Effect.map(store.readSnapshot(command.chain), (snapshot): DaemonCommandSuccess => ({ kind: "status", projection: buildStatusProjection(snapshot) }))
		case "events-read":
			return Effect.map(store.listTransitions(command.chain, command.since), (transitions): DaemonCommandSuccess => ({ kind: "events", projection: buildEventProjection(command.chain.value, transitions) }))
		case "audit-read":
			return Effect.map(
				Effect.all([hooks.listAudit, providerFacts.list]),
				([hookAudit, facts]): DaemonCommandSuccess => ({ kind: "audit", projection: buildSideEffectAuditProjection(hookAudit, facts) }),
			)
		case "task-admit":
			return Effect.gen(function*() {
				const admissionRequest = yield* authorizeAdmissionRequest(store, request.caller, command.chain.value, command.request)
				const bundle = yield* definitions.resolve(admissionRequest.task.input.definition)
				const input = parseContext0(bundle.definition.values, admissionRequest.task.input.value)
				if (input.kind === "rejected") return yield* Effect.fail<TaskInputError>({ kind: "task-input-rejected", task: taskKey(admissionRequest.task.identity), fields: input.fields })
				const value = input.context.values
				const valueIdentity = createHash("sha256").update(JSON.stringify(value)).digest("hex")
				const task = { ...admissionRequest.task, input: { ...admissionRequest.task.input, value, valueIdentity } }
				return yield* Effect.map(admission.admit(command.chain, { ...admissionRequest, task }), (result): DaemonCommandSuccess => ({ kind: "admission", result }))
			})
		case "task-unhold":
			return Effect.map(admission.unhold(command.task, command.commandIdentity), (result): DaemonCommandSuccess => ({ kind: "task-unheld", result }))
		case "agent-await":
			if (request.caller.kind !== "agent" || command.child.authority.kind !== "internal") {
				return Effect.dieMessage("authorized agent-await request lost internal agent authority")
			}
			const internalAuthority = command.child.authority
			const callerAuthority = request.caller.authority
			return Effect.gen(function*() {
				yield* verifyInternalAuthority(store, callerAuthority, internalAuthority.run, internalAuthority.allowedGroup)
				const bundle = yield* definitions.resolve(command.child.task.input.definition)
				const input = parseContext0(bundle.definition.values, command.child.task.input.value)
				if (input.kind === "rejected") return yield* Effect.fail<TaskInputError>({ kind: "task-input-rejected", task: taskKey(command.child.task.identity), fields: input.fields })
				const value = input.context.values
				const child = {
					...command.child,
					task: {
						...command.child.task,
						input: {
							...command.child.task.input,
							value,
							valueIdentity: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
						},
					},
				}
				const run = internalAuthority.run
				const identity = { kind: "await" as const, parent: run.closure.task, attempt: run.closure.attempt, site: command.site }
				const record = { kind: "waiting" as const, identity, parentClosure: run.closure, child: child.task.identity }
				const result = yield* store.commit({
					identity: `await-suspend:${taskKey(run.closure.task)}:${run.closure.attempt}:${command.site}`,
					transition: {
						family: "await-suspension",
						task: run.closure.task,
						run,
						record,
						continuation: { kind: "present", sessionIdentity: command.sessionIdentity, observedAt: Date.now() },
						child,
					},
				})
				return { kind: "await-suspended" as const, await: `${taskKey(identity.parent)}/${identity.attempt}/${identity.site}`, result }
			})
		case "agent-submit":
			if (request.caller.kind !== "agent") return Effect.dieMessage("authorized agent-submit request lost agent authority")

			return Effect.map(runtime.submit(request.caller.authority, command.values), (result): DaemonCommandSuccess => ({ kind: "agent-submission", result }))
	}
}

function authorizeAdmissionRequest(
	store: typeof ObjectDomainStore.Service,
	caller: DaemonRequest["caller"],
	chain: string,
	request: AdmissionRequest,
): Effect.Effect<AdmissionRequest, ObjectStoreError | AgentAuthorityError> {
	if (request.authority.kind === "external") return Effect.succeed(request)
	if (caller.kind !== "agent" || chain !== caller.authority.chainId) {
		return Effect.fail({ kind: "agent-authority-rejected", reason: "scope-mismatch", message: "internal admission requires matching agent caller authority" })
	}
	return Effect.as(verifyInternalAuthority(store, caller.authority, request.authority.run, request.authority.allowedGroup), request)
}

function verifyInternalAuthority(
	store: typeof ObjectDomainStore.Service,
	caller: Extract<DaemonRequest["caller"], { readonly kind: "agent" }>["authority"],
	run: RunIdentity,
	allowedGroup: GroupIdentity,
): Effect.Effect<void, ObjectStoreError | AgentAuthorityError> {
	return Effect.flatMap(store.readSnapshot(run.closure.task.chain), (snapshot): Effect.Effect<void, AgentAuthorityError> => {
		const task = snapshot.tasks[taskKey(run.closure.task)]
		const live = task?.state.kind === "leased"
			&& task.state.run.value === run.value
			&& task.state.run.closure.attempt === run.closure.attempt
			&& taskKey(task.state.run.closure.task) === taskKey(run.closure.task)
		if (!live) {
			return Effect.fail({ kind: "agent-authority-rejected", reason: "missing-live-run", message: "agent authority does not own the current live lease" })
		}
		const matchesCaller = caller.chainId === run.closure.task.chain.value
			&& caller.taskId === taskKey(run.closure.task)
			&& caller.closureId === `${taskKey(run.closure.task)}/${run.closure.attempt}`
			&& caller.runId === run.value
		if (!matchesCaller || groupKey(task.group) !== groupKey(allowedGroup)) {
			return Effect.fail({ kind: "agent-authority-rejected", reason: "scope-mismatch", message: "agent authority scope does not match its persisted task lease" })
		}
		return Effect.void
	})
}

function requestIdentity(candidate: unknown): string | null {
	if (typeof candidate !== "object" || candidate === null || !("requestId" in candidate)) return null
	return typeof candidate.requestId === "string" ? candidate.requestId : null
}

function bootstrapRequest(command: ChainBootstrapCommand, root: RecursiveTaskDefinition): BootstrapRequest {
	const group = { kind: "group" as const, chain: command.chain, value: root.id }
	const valueIdentity = createHash("sha256").update(JSON.stringify(command.input)).digest("hex")
	return {
		chain: command.chain,
		group: {
			kind: "task-group",
			identity: group,
			wait: waitWindow(root),
			join: root.kind === "par" ? { kind: "finalizer", definition: command.definition, entrypoint: root.finalizer.task.id } : { kind: "drain" },
		},
		admissions: initialLeafDefinitions(root).map((leaf) => ({
			fact: { kind: "fact" as const, source: "bootstrap", value: leaf.id },
			task: {
				kind: "task",
				identity: { kind: "task" as const, chain: command.chain, value: leaf.id },
				group,
				input: { definition: command.definition, entrypoint: leaf.id, basePin: command.basePin, value: command.input, valueIdentity },
				dependsOn: [],
				priority: command.priority,
			},
		})),
	}
}

function initialLeafDefinitions(definition: RecursiveTaskDefinition): readonly Extract<RecursiveTaskDefinition, { readonly kind: "leaf" }>[] {
	switch (definition.kind) {
		case "leaf": return [definition]
		case "seq": return initialLeafDefinitions(definition.children[0] as RecursiveTaskDefinition)
		case "par": return definition.children.flatMap(initialLeafDefinitions)
	}
}

function waitWindow(definition: RecursiveTaskDefinition): { readonly kind: "none" } | { readonly kind: "fixed-deadline" | "sliding-deadline"; readonly durationMs: number } {
	return definition.kind === "par" && definition.growth !== "closed"
		? definition.growth
		: { kind: "none" }
}
