import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import type { JsonValue } from "./definition"
import { FunctionRuntime, type FunctionExecutionResult, type FunctionRuntimeError, type FunctionRuntimeService } from "./function-runtime"
import { RepositoryGit, type GitService, type GitServiceError } from "./git-service"
import { GroupConsumerRuntime, type GroupConsumerService } from "./group-consumer"
import {
	groupKey,
	taskKey,
	type ChainIdentity,
	type ClosureIdentity,
	type ClosureResourceState,
	type GroupIdentity,
	type Task,
	type TaskGroup,
	type AwaitRecord,
	type TaskSettlement,
} from "./object-domain"
import { RunnerProvider, type EndpointProbe, type ProviderFactStoreError, type RunnerProviderService } from "./provider"
import { RuntimeRecovery, type GarbageCollectionDecision, type RecoveryDecision, type RecoveryError, type RecoveryService } from "./recovery"
import { Scheduler, type GroupReconciliation, type SchedulerService } from "./scheduler"
import { ObjectDomainStore, type CommitResult, type ObjectDomainStoreService, type ObjectStoreError } from "./sqlite-store"

export type OrchestratorError =
	| FunctionRuntimeError
	| GitServiceError
	| RecoveryError
	| ProviderFactStoreError
	| ObjectStoreError
	| { readonly kind: "claim-cleanup-error"; readonly claim: ObjectStoreError; readonly cleanup: GitServiceError | null }
	| { readonly kind: "orchestrator-state-error"; readonly task: string; readonly message: string }

export type OrchestratorAction =
	| { readonly kind: "idle" }
	| { readonly kind: "endpoint-unknown"; readonly task: Task["identity"]; readonly probe: Extract<EndpointProbe, { kind: "unknown" }> }
	| { readonly kind: "pre-spawn-held"; readonly task: Task["identity"]; readonly commit: CommitResult }
	| { readonly kind: "executed"; readonly task: Task["identity"]; readonly result: FunctionExecutionResult }

export type OrchestratorCycle = {
	readonly recovered: readonly RecoveryDecision[]
	readonly resumed: readonly FunctionExecutionResult[]
	readonly awaitsResumed: readonly Extract<AwaitRecord, { kind: "delivered" | "continuation-lost" }>[]
	readonly reconciled: readonly GroupReconciliation[]
	readonly actions: readonly OrchestratorAction[]
	readonly garbageCollected: readonly GarbageCollectionDecision[]
}

export type RuntimeOrchestratorService = {
	readonly cycle: (chains: readonly ChainIdentity[], now: number) => Effect.Effect<OrchestratorCycle, OrchestratorError>
}

export class RuntimeOrchestrator extends Context.Tag("coder-loop/v3/RuntimeOrchestrator")<RuntimeOrchestrator, RuntimeOrchestratorService>() {}

export function makeRuntimeOrchestratorLive(leaseMs: number, maxConcurrency: number): Layer.Layer<RuntimeOrchestrator, never, Scheduler | RuntimeRecovery | RunnerProvider | RepositoryGit | FunctionRuntime | GroupConsumerRuntime | ObjectDomainStore> {
	if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive")
	if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new Error("maxConcurrency must be a positive integer")
	return Layer.effect(RuntimeOrchestrator, Effect.gen(function*() {
		const scheduler = yield* Scheduler
		const recovery = yield* RuntimeRecovery
		const provider = yield* RunnerProvider
		const repository = yield* RepositoryGit
		const runtime = yield* FunctionRuntime
		const consumers = yield* GroupConsumerRuntime
		const store = yield* ObjectDomainStore
		return { cycle: (chains, now) => runCycle({ scheduler, recovery, provider, repository, runtime, consumers, store, leaseMs, maxConcurrency }, chains, now) }
	}))
}

type OrchestratorDependencies = {
	readonly scheduler: SchedulerService
	readonly recovery: RecoveryService
	readonly provider: RunnerProviderService
	readonly repository: GitService
	readonly runtime: FunctionRuntimeService
	readonly consumers: GroupConsumerService
	readonly store: ObjectDomainStoreService
	readonly leaseMs: number
	readonly maxConcurrency: number
}

function runCycle(dependencies: OrchestratorDependencies, chains: readonly ChainIdentity[], now: number): Effect.Effect<OrchestratorCycle, OrchestratorError> {
	return Effect.gen(function*() {
		const allocationRecovery = yield* dependencies.recovery.recoverAllocations(chains)
		const recovered = [...allocationRecovery, ...yield* dependencies.recovery.recoverExpiredLeases(chains, now)]
		const resumed = yield* Effect.forEach(
			recovered.filter((decision): decision is Extract<RecoveryDecision, { kind: "provider-fact-ready" }> => decision.kind === "provider-fact-ready"),
			(decision) => dependencies.runtime.execute(decision.task),
			{ concurrency: dependencies.maxConcurrency },
		)
		const awaitsResumed = yield* reconcileAwaits(dependencies.store, chains)
		const claimed: Task["identity"][] = []
		const actions: OrchestratorAction[] = []
		for (let slot = 0; slot < dependencies.maxConcurrency; slot += 1) {
			const selection = yield* dependencies.scheduler.nextReady(chains)
			if (selection === null) break
			const probe = yield* dependencies.provider.probe
			const attemptIdentity = `${taskKey(selection.task.identity)}:${attemptNumber(selection.task)}`
			if (probe.kind === "unknown") {
				actions.push({ kind: "endpoint-unknown", task: selection.task.identity, probe })
				break
			}
			if (probe.kind === "absent") {
				yield* dependencies.provider.recordAbsence(attemptIdentity, probe.evidence)
				const commit = yield* dependencies.store.commit({
					identity: `hold-absence:${attemptIdentity}:${probe.endpoint.digest}`,
					transition: { family: "task-held", task: selection.task.identity, expectedRun: null, reason: { kind: "pre-spawn-absence", endpoint: probe.endpoint.digest, detail: probe.evidence.detail, observedAt: probe.evidence.observedAt } },
				})
				actions.push({ kind: "pre-spawn-held", task: selection.task.identity, commit })
				continue
			}

			const closureIdentity: ClosureIdentity = { kind: "closure", task: selection.task.identity, attempt: 0 }
			const run = { kind: "run" as const, closure: closureIdentity, value: randomUUID() }
			const allocation = yield* allocateClosure(dependencies.store, dependencies.repository, selection.task, run.value)
			const closure = allocation.closure
			const claimIdentity = `claim:${taskKey(selection.task.identity)}:${run.value}`
			yield* dependencies.scheduler.claim({ identity: claimIdentity, task: selection.task, run, closure, acquiredAt: now, expiresAt: now + dependencies.leaseMs }).pipe(
				Effect.catchAll((claim) => Effect.flatMap(
					allocation.owned
						? Effect.either(dependencies.repository.discard(allocation.closure))
						: Effect.either(Effect.void),
					(cleanup) => Effect.fail<OrchestratorError>({ kind: "claim-cleanup-error", claim, cleanup: cleanup._tag === "Left" ? cleanup.left : null }),
				)),
			)
			claimed.push(selection.task.identity)
		}
		const executed = yield* Effect.forEach(
			claimed,
			(task) => Effect.map(dependencies.runtime.execute(task), (result): OrchestratorAction => ({ kind: "executed", task, result })),
			{ concurrency: dependencies.maxConcurrency },
		)
		actions.push(...executed)
		const reconciled = yield* reconcileChains(dependencies, chains, Date.now())
		const garbageCollected = yield* reconcileLifecycle(dependencies.recovery, chains)
		return {
			recovered,
			resumed,
			awaitsResumed,
			reconciled,
			garbageCollected,
			actions: actions.length === 0 ? [{ kind: "idle" }] : actions,
		}
	})
}

type ClosureAllocation =
	| { readonly closure: Extract<ClosureResourceState, { kind: "active" }>; readonly owned: true }
	| { readonly closure: Extract<ClosureResourceState, { kind: "active" | "suspended" }>; readonly owned: false }

function allocateClosure(store: ObjectDomainStoreService, repository: GitService, task: Task, allocation: string): Effect.Effect<ClosureAllocation, GitServiceError | ObjectStoreError | Extract<OrchestratorError, { kind: "orchestrator-state-error" }>> {
	if (task.closure.kind === "active" || task.closure.kind === "suspended") return Effect.succeed({ closure: task.closure, owned: false })
	if (task.closure.kind !== "unallocated") return Effect.fail({ kind: "orchestrator-state-error", task: taskKey(task.identity), message: `ready task has ${task.closure.kind} closure resources` })
	const identity: ClosureIdentity = { kind: "closure", task: task.identity, attempt: 0 }
	return Effect.gen(function*() {
		const basePin = yield* repository.resolveBasePin(task.input.basePin)
		const digest = createHash("sha256").update(`${taskKey(task.identity)}:${basePin}`).digest("hex").slice(0, 16)
		const intent = { kind: "allocating" as const, identity, allocation, basePin, branch: `coder-loop/v3/${digest}-${allocation.slice(0, 8)}` }
		yield* store.commit({ identity: `allocation-start:${taskKey(task.identity)}:${allocation}`, transition: { family: "closure-allocation-start", task: task.identity, allocation: intent } })
		const closure = yield* repository.prepare(intent).pipe(Effect.catchAll((error) => Effect.zipRight(
			Effect.zipRight(repository.discardAllocation(intent), store.commit({ identity: `allocation-cleaned:${taskKey(task.identity)}:${allocation}`, transition: { family: "closure-allocation-cleanup", task: task.identity, allocation: intent } })),
			Effect.fail(error),
		)))
		return { closure, owned: true } as const
	})
}

function reconcileAwaits(
	store: ObjectDomainStoreService,
	chains: readonly ChainIdentity[],
): Effect.Effect<readonly Extract<AwaitRecord, { kind: "delivered" | "continuation-lost" }>[], ObjectStoreError> {
	return Effect.gen(function*() {
		const resumed: Extract<AwaitRecord, { kind: "delivered" | "continuation-lost" }>[] = []
		for (const chain of chains) {
			const snapshot = yield* store.readSnapshot(chain)
			for (const record of Object.values(snapshot.awaits)) {
				if (record.kind !== "waiting") continue
				const parent = snapshot.tasks[taskKey(record.identity.parent)]
				const child = snapshot.tasks[taskKey(record.child)]
				if (parent?.state.kind !== "suspended" || child?.state.kind !== "settled") continue
				const delivered: Extract<AwaitRecord, { kind: "delivered" | "continuation-lost" }> =
					parent.closure.kind === "suspended" && parent.closure.continuation.kind === "present"
						? {
								kind: "delivered",
								identity: record.identity,
								parentClosure: record.parentClosure,
								child: record.child,
								settlement: child.state.settlement,
								token: createHash("sha256").update(JSON.stringify([record.identity, child.state.settlement])).digest("hex"),
							}
						: { kind: "continuation-lost", identity: record.identity, parentClosure: record.parentClosure, child: record.child }
				yield* store.commit({
					identity: `await-resume:${taskKey(record.identity.parent)}:${record.identity.attempt}:${record.identity.site}`,
					transition: { family: "await-resumption", task: record.identity.parent, record: delivered },
				})
				resumed.push(delivered)
			}
		}
		return resumed
	})
}

function reconcileChains(dependencies: OrchestratorDependencies, chains: readonly ChainIdentity[], now: number): Effect.Effect<readonly GroupReconciliation[], OrchestratorError> {
	return Effect.gen(function*() {
		const reconciled: GroupReconciliation[] = []
		for (const chain of chains) {
			const snapshot = yield* dependencies.store.readSnapshot(chain)
			for (const group of Object.values(snapshot.groups)) {
				const reconciliation = yield* dependencies.scheduler.reconcileGroup(group.identity, now)
				const latest = yield* dependencies.store.readSnapshot(chain)
				const current = latest.groups[groupKey(group.identity)]
				if (current === undefined) {
					return yield* Effect.fail<ObjectStoreError>({ kind: "transition-rejected", family: "group-consumption", reason: "not-found", message: `group ${groupKey(group.identity)} not found` })
				}
				if (current.state.kind === "consuming") {
					const consumer = latest.tasks[taskKey(current.state.consumerTask)]
					if (consumer?.state.kind !== "settled") {
						reconciled.push({ kind: "consuming", group: current.identity })
						continue
					}
					const settlement = consumer.state.settlement
					if (settlement.kind === "returned" && consumerAllowsCompletion(current, settlement.value)) {
						const settlements = committedSettlements(current, latest.tasks)
						if (settlements === null) return yield* incompleteGroup(current)
						const consumption = yield* dependencies.consumers.consume(current, settlements)
						yield* dependencies.scheduler.consumeGroup(current.identity, consumption, now)
						reconciled.push({ kind: "consumed", group: current.identity })
						continue
					}
					if (settlement.kind === "returned") {
						yield* dependencies.store.commit({
							identity: `group-hold:${groupKey(current.identity)}:${current.state.settlementsDigest}:${current.memberVersion}`,
							transition: {
								family: "group-hold",
								group: current.identity,
								state: {
									kind: "held",
									consumerTask: current.state.consumerTask,
									consumerGroup: current.state.consumerGroup,
									settlementsDigest: current.state.settlementsDigest,
									memberVersion: current.memberVersion,
									heldAt: now,
								},
							},
						})
						reconciled.push({ kind: "held", group: current.identity })
						continue
					}
					if (settlement.kind === "exception") {
						yield* dependencies.store.commit({
							identity: `group-stop:${groupKey(current.identity)}:${current.state.settlementsDigest}`,
							transition: {
								family: "group-stop",
								group: current.identity,
								state: {
									kind: "stopped",
									consumerTask: current.state.consumerTask,
									consumerGroup: current.state.consumerGroup,
									settlementsDigest: current.state.settlementsDigest,
									stoppedAt: now,
								},
							},
						})
						reconciled.push({ kind: "stopped", group: current.identity })
						continue
					}
					return assertNever(settlement)
				}
				if (reconciliation.kind !== "terminated") {
					reconciled.push(reconciliation)
					continue
				}
				const settlements = committedSettlements(current, latest.tasks)
				if (settlements === null) {
					reconciled.push(reconciliation)
					continue
				}
				if (current.join.kind === "drain") {
					const consumption = yield* dependencies.consumers.consume(current, settlements)
					yield* dependencies.scheduler.consumeGroup(current.identity, consumption, now)
					reconciled.push({ kind: "consumed", group: current.identity })
					continue
				}
				const started = materializeGroupConsumer(current, latest.tasks, settlements, now)
				yield* dependencies.store.commit({
					identity: `group-consumer-start:${groupKey(current.identity)}:${current.memberVersion}:${started.state.settlementsDigest}`,
					transition: {
						family: "group-consumer-start",
						group: current.identity,
						state: started.state,
						consumerGroup: started.group,
						task: started.task,
						settlements,
					},
				})
				reconciled.push({ kind: "consuming", group: current.identity })
			}
		}
		return reconciled
	})
}

function committedSettlements(group: TaskGroup, tasks: Readonly<Record<string, Task>>): TaskSettlement[] | null {
	const settlements: TaskSettlement[] = []
	for (const identity of group.members) {
		const state = tasks[taskKey(identity)]?.state
		if (state?.kind !== "settled") return null
		settlements.push(state.settlement)
	}
	return settlements
}

function incompleteGroup(group: TaskGroup): Effect.Effect<never, ObjectStoreError> {
	return Effect.fail({ kind: "transition-rejected", family: "group-consumption", reason: "state-mismatch", message: `group ${groupKey(group.identity)} lost a committed member settlement` })
}

function consumerAllowsCompletion(group: TaskGroup, value: JsonValue): boolean {
	switch (group.join.kind) {
		case "drain":
			throw new Error("drain groups do not materialize consumer tasks")
		case "validator":
			return true
		case "finalizer":
			return typeof value === "object" && value !== null && "kind" in value && value.kind === "advance"
	}
	return assertNever(group.join)
}

function materializeGroupConsumer(group: TaskGroup, tasks: Readonly<Record<string, Task>>, settlements: readonly TaskSettlement[], now: number): {
	readonly state: Extract<TaskGroup["state"], { kind: "consuming" }>
	readonly group: TaskGroup
	readonly task: Task
} {
	const consumer = fixedGroupConsumer(group.join)
	const suffix = `${group.identity.value}/$${consumer.kind}/${group.memberVersion}`
	const consumerGroup: GroupIdentity = { kind: "group", chain: group.identity.chain, value: `${suffix}/group` }
	const consumerTask = { kind: "task" as const, chain: group.identity.chain, value: `${suffix}/task` }
	const settlementsDigest = createHash("sha256").update(JSON.stringify(settlements)).digest("hex")
	const value = { settlements }
	const valueIdentity = createHash("sha256").update(JSON.stringify(value)).digest("hex")
	const members = group.members.map((identity) => tasks[taskKey(identity)]).filter((task): task is Task => task !== undefined)
	const basePin = members[0]?.input.basePin
	if (basePin === undefined) throw new Error("fixed consumer requires at least one committed group member")
	const task: Task = {
		kind: "task",
		identity: consumerTask,
		group: consumerGroup,
		input: { definition: consumer.definition, entrypoint: consumer.entrypoint, basePin, value, valueIdentity },
		dependsOn: [...group.members],
		priority: Math.max(...members.map((member) => member.priority)),
		state: { kind: "ready" },
		closure: { kind: "unallocated" },
	}
	return {
		state: { kind: "consuming", consumerTask, consumerGroup, settlementsDigest, startedAt: now },
		group: { kind: "task-group", identity: consumerGroup, members: [consumerTask], memberVersion: 1, wait: { kind: "none" }, join: { kind: "drain" }, state: { kind: "open" } },
		task,
	}
}

function fixedGroupConsumer(consumer: TaskGroup["join"]): Exclude<TaskGroup["join"], { readonly kind: "drain" }> {
	switch (consumer.kind) {
		case "drain":
			throw new Error("drain groups do not materialize consumer tasks")
		case "validator":
		case "finalizer":
			return consumer
	}
	return assertNever(consumer)
}

function assertNever(value: never): never {
	throw new Error(`unreachable variant: ${JSON.stringify(value)}`)
}

function reconcileLifecycle(recovery: RecoveryService, chains: readonly ChainIdentity[]): Effect.Effect<readonly GarbageCollectionDecision[], RecoveryError> {
	return Effect.flatMap(recovery.freezeEvidence(chains), (frozen) =>
		Effect.map(recovery.collect(chains), (collected) => [...frozen, ...collected]))
}

function attemptNumber(task: Task): number {
	return task.closure.kind === "unallocated" ? 0 : task.closure.identity.attempt
}
