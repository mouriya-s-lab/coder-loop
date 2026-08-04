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
import { groupKey, taskKey, type ObjectDomainSnapshot, type Task } from "./object-domain"
import { buildEventProjection, buildStatusProjection, type EventProjectionV3, type StatusProjectionV3 } from "./projection"
import { ObjectDomainStore, type CommitResult, type ObjectStoreError } from "./sqlite-store"

export type DaemonCommandSuccess =
	| { readonly kind: "definition-published"; readonly ref: DefinitionRef }
	| { readonly kind: "chain-bootstrapped"; readonly chain: string }
	| { readonly kind: "status"; readonly projection: StatusProjectionV3 }
	| { readonly kind: "events"; readonly projection: EventProjectionV3 }
	| { readonly kind: "admission"; readonly result: AdmissionCommitResult }
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

export type DaemonHandlerError = ObjectStoreError | FunctionRuntimeError | DefinitionStoreError | ChainBootstrapError | TaskInputError

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

export const DaemonProtocolLive: Layer.Layer<DaemonProtocol, never, ObjectDomainStore | TypedAdmission | FunctionRuntime | DefinitionStore> = Layer.effect(DaemonProtocol, Effect.gen(function*() {
	const store = yield* ObjectDomainStore
	const admission = yield* TypedAdmission
	const runtime = yield* FunctionRuntime
	const definitions = yield* DefinitionStore
	return {
		handle: (candidate) => {
			const parsed = parseDaemonRequest(candidate)
			if (parsed.kind === "rejected") return Effect.succeed({ schemaVersion: 3, requestId: requestIdentity(candidate), outcome: { kind: "rejected", rejection: parsed.rejection } })
			return Effect.match(dispatch(parsed.request, store, admission, runtime, definitions), {
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
				const snapshot = bootstrapSnapshot({ ...command, input: input.context.values }, bundle.definition.task)
				return yield* Effect.as(store.bootstrap(snapshot), { kind: "chain-bootstrapped" as const, chain: command.chain.value })
			})
		case "status-read":
			return Effect.map(store.readSnapshot(command.chain), (snapshot): DaemonCommandSuccess => ({ kind: "status", projection: buildStatusProjection(snapshot) }))
		case "events-read":
			return Effect.map(store.listTransitions(command.chain, command.since), (transitions): DaemonCommandSuccess => ({ kind: "events", projection: buildEventProjection(command.chain.value, transitions) }))
		case "task-admit":
			return Effect.gen(function*() {
				const bundle = yield* definitions.resolve(command.request.task.input.definition)
				const input = parseContext0(bundle.definition.values, command.request.task.input.value)
				if (input.kind === "rejected") return yield* Effect.fail<TaskInputError>({ kind: "task-input-rejected", task: taskKey(command.request.task.identity), fields: input.fields })
				const value = input.context.values
				const valueIdentity = createHash("sha256").update(JSON.stringify(value)).digest("hex")
				const task = { ...command.request.task, input: { ...command.request.task.input, value, valueIdentity } }
				return yield* Effect.map(admission.admit(command.chain, { ...command.request, task }), (result): DaemonCommandSuccess => ({ kind: "admission", result }))
			})
		case "task-unhold":
			return Effect.map(admission.unhold(command.task, command.commandIdentity), (result): DaemonCommandSuccess => ({ kind: "task-unheld", result }))
		case "agent-submit":
			if (request.caller.kind !== "agent") return Effect.dieMessage("authorized agent-submit request lost agent authority")
			return Effect.map(runtime.submit(request.caller.authority, command.values), (result): DaemonCommandSuccess => ({ kind: "agent-submission", result }))
	}
}

function requestIdentity(candidate: unknown): string | null {
	if (typeof candidate !== "object" || candidate === null || !("requestId" in candidate)) return null
	return typeof candidate.requestId === "string" ? candidate.requestId : null
}

function bootstrapSnapshot(command: ChainBootstrapCommand, root: RecursiveTaskDefinition): ObjectDomainSnapshot {
	const group = { kind: "group" as const, chain: command.chain, value: root.id }
	const identities = initialLeafDefinitions(root).map((leaf) => ({ kind: "task" as const, chain: command.chain, value: leaf.id }))
	const valueIdentity = createHash("sha256").update(JSON.stringify(command.input)).digest("hex")
	const tasks = Object.fromEntries(identities.map((identity): [string, Task] => [taskKey(identity), {
		identity,
		group,
		input: { definition: command.definition, basePin: command.basePin, value: command.input, valueIdentity },
		dependsOn: [],
		priority: command.priority,
		state: { kind: "ready" },
		closure: { kind: "unallocated" },
	}]))
	return {
		chain: command.chain,
		tasks,
		groups: {
			[groupKey(group)]: {
				identity: group,
				members: identities,
				memberVersion: identities.length,
				wait: waitWindow(root),
				consumer: { kind: "drain" },
				state: { kind: "open" },
			},
		},
		awaits: {},
		admittedFacts: {},
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
