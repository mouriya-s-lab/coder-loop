import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { FunctionRuntime, type FunctionExecutionResult, type FunctionRuntimeError, type FunctionRuntimeService } from "./function-runtime"
import { RepositoryGit, type GitService, type GitServiceError } from "./git-service"
import { GroupConsumerRuntime, type GroupConsumerService } from "./group-consumer"
import {
	groupKey,
	taskKey,
	type ChainIdentity,
	type ClosureIdentity,
	type ClosureResourceState,
	type Task,
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
	readonly reconciled: readonly GroupReconciliation[]
	readonly action: OrchestratorAction
	readonly garbageCollected: readonly GarbageCollectionDecision[]
}

export type RuntimeOrchestratorService = {
	readonly cycle: (chains: readonly ChainIdentity[], now: number) => Effect.Effect<OrchestratorCycle, OrchestratorError>
}

export class RuntimeOrchestrator extends Context.Tag("coder-loop/v3/RuntimeOrchestrator")<RuntimeOrchestrator, RuntimeOrchestratorService>() {}

export function makeRuntimeOrchestratorLive(leaseMs: number): Layer.Layer<RuntimeOrchestrator, never, Scheduler | RuntimeRecovery | RunnerProvider | RepositoryGit | FunctionRuntime | GroupConsumerRuntime | ObjectDomainStore> {
	if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive")
	return Layer.effect(RuntimeOrchestrator, Effect.gen(function*() {
		const scheduler = yield* Scheduler
		const recovery = yield* RuntimeRecovery
		const provider = yield* RunnerProvider
		const repository = yield* RepositoryGit
		const runtime = yield* FunctionRuntime
		const consumers = yield* GroupConsumerRuntime
		const store = yield* ObjectDomainStore
		return { cycle: (chains, now) => runCycle({ scheduler, recovery, provider, repository, runtime, consumers, store, leaseMs }, chains, now) }
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
}

function runCycle(dependencies: OrchestratorDependencies, chains: readonly ChainIdentity[], now: number): Effect.Effect<OrchestratorCycle, OrchestratorError> {
	return Effect.gen(function*() {
		const recovered = yield* dependencies.recovery.recoverExpiredLeases(chains, now)
		const resumed = yield* Effect.forEach(
			recovered.filter((decision): decision is Extract<RecoveryDecision, { kind: "terminal-awaiting-consumption" }> => decision.kind === "terminal-awaiting-consumption"),
			(decision) => dependencies.runtime.execute(decision.task),
			{ concurrency: 1 },
		)
		const selection = yield* dependencies.scheduler.nextReady(chains)
		if (selection === null) {
			const reconciled = yield* reconcileChains(dependencies, chains, now)
			const garbageCollected = yield* reconcileLifecycle(dependencies.recovery, chains)
			return { recovered, resumed, reconciled, garbageCollected, action: { kind: "idle" } }
		}
		const probe = yield* dependencies.provider.probe
		const attemptIdentity = `${taskKey(selection.task.identity)}:${attemptNumber(selection.task)}`
		if (probe.kind === "unknown") {
			const reconciled = yield* reconcileChains(dependencies, chains, now)
			const garbageCollected = yield* reconcileLifecycle(dependencies.recovery, chains)
			return { recovered, resumed, reconciled, garbageCollected, action: { kind: "endpoint-unknown", task: selection.task.identity, probe } }
		}
		if (probe.kind === "absent") {
			yield* dependencies.provider.recordAbsence(attemptIdentity, probe.evidence)
			const commit = yield* dependencies.store.commit({
				identity: `hold-absence:${attemptIdentity}:${probe.endpoint.digest}`,
				transition: { family: "task-held", task: selection.task.identity, expectedRun: null, reason: { kind: "pre-spawn-absence", endpoint: probe.endpoint.digest, detail: probe.evidence.detail, observedAt: probe.evidence.observedAt } },
			})
			const reconciled = yield* reconcileChains(dependencies, chains, now)
			const garbageCollected = yield* reconcileLifecycle(dependencies.recovery, chains)
			return { recovered, resumed, reconciled, garbageCollected, action: { kind: "pre-spawn-held", task: selection.task.identity, commit } }
		}

		const closure = yield* allocateClosure(dependencies.repository, selection.task)
		const run = { kind: "run" as const, closure: closure.identity, value: randomUUID() }
		const claimIdentity = `claim:${taskKey(selection.task.identity)}:${run.value}`
		const claim = yield* Effect.catchAll(
			dependencies.scheduler.claim({ identity: claimIdentity, task: selection.task, run, closure, acquiredAt: now, expiresAt: now + dependencies.leaseMs }),
			(claimError) => Effect.gen(function*() {
				const cleanup = selection.task.closure.kind === "unallocated"
					? yield* Effect.match(dependencies.repository.discard(closure), { onFailure: (error) => error, onSuccess: () => null })
					: null
				return yield* Effect.fail<OrchestratorError>({ kind: "claim-cleanup-error", claim: claimError, cleanup })
			}),
		)
		void claim
		const result = yield* dependencies.runtime.execute(selection.task.identity)
		const reconciled = yield* reconcileChains(dependencies, chains, now)
		const garbageCollected = yield* reconcileLifecycle(dependencies.recovery, chains)
		return { recovered, resumed, reconciled, garbageCollected, action: { kind: "executed", task: selection.task.identity, result } }
	})
}

function allocateClosure(repository: GitService, task: Task): Effect.Effect<Extract<ClosureResourceState, { kind: "active" }>, GitServiceError | Extract<OrchestratorError, { kind: "orchestrator-state-error" }>> {
	if (task.closure.kind === "active") return Effect.succeed(task.closure)
	if (task.closure.kind !== "unallocated") return Effect.fail({ kind: "orchestrator-state-error", task: taskKey(task.identity), message: `ready task has ${task.closure.kind} closure resources` })
	const identity: ClosureIdentity = { kind: "closure", task: task.identity, attempt: 0 }
	const digest = createHash("sha256").update(`${taskKey(task.identity)}:${task.input.basePin}`).digest("hex").slice(0, 16)
	return repository.prepare({ identity, basePin: task.input.basePin, branch: `coder-loop/v3/${digest}` })
}

function reconcileChains(dependencies: OrchestratorDependencies, chains: readonly ChainIdentity[], now: number): Effect.Effect<readonly GroupReconciliation[], OrchestratorError> {
	return Effect.gen(function*() {
		const reconciled: GroupReconciliation[] = []
		for (const chain of chains) {
			const snapshot = yield* dependencies.store.readSnapshot(chain)
			for (const group of Object.values(snapshot.groups)) {
				const reconciliation = yield* dependencies.scheduler.reconcileGroup(group.identity, now)
				if (reconciliation.kind !== "terminated") {
					reconciled.push(reconciliation)
					continue
				}
				const latest = yield* dependencies.store.readSnapshot(chain)
				const current = latest.groups[groupKey(group.identity)]
				if (current === undefined) {
					return yield* Effect.fail<ObjectStoreError>({ kind: "transition-rejected", family: "group-consumption", reason: "not-found", message: `group ${groupKey(group.identity)} not found` })
				}
				const settlements: TaskSettlement[] = []
				for (const identity of current.members) {
					const state = latest.tasks[taskKey(identity)]?.state
					if (state?.kind !== "settled") break
					settlements.push(state.settlement)
				}
				if (settlements.length !== current.members.length) {
					reconciled.push(reconciliation)
					continue
				}
				const consumption = yield* dependencies.consumers.consume(current, settlements)
				if (consumption === null) {
					reconciled.push(reconciliation)
					continue
				}
				yield* dependencies.scheduler.consumeGroup(current.identity, consumption, now)
				reconciled.push({ kind: "consumed", group: current.identity })
			}
		}

		return reconciled
	})
}
function reconcileLifecycle(recovery: RecoveryService, chains: readonly ChainIdentity[]): Effect.Effect<readonly GarbageCollectionDecision[], RecoveryError> {
	return Effect.flatMap(recovery.freezeEvidence(chains), (frozen) =>
		Effect.map(recovery.collect(chains), (collected) => [...frozen, ...collected]))
}


function attemptNumber(task: Task): number {
	return task.closure.kind === "unallocated" ? 0 : task.closure.identity.attempt
}
