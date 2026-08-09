import { Context, Effect, Layer } from "effect"
import {
	groupKey,
	taskKey,
	type ChainIdentity,
	type ClosureIdentity,
	type PublicationEvidence,
	type RunIdentity,
	type Task,
	type TaskGroup,
} from "./object-domain"
import { ProviderFactStore, runProviderFactIdentity, type ProviderFact, type ProviderFactStoreError } from "./provider"
import { RepositoryGit, type GitServiceError } from "./git-service"
import { ObjectDomainStore, type ObjectStoreError } from "./sqlite-store"

export type RecoveryDecision =
	| { readonly kind: "provider-fact-ready"; readonly task: Task["identity"]; readonly fact: Extract<ProviderFact, { kind: "terminal-winner" | "active-loss" }> }
	| { readonly kind: "unknown-held"; readonly task: Task["identity"]; readonly detail: string }

export type GarbageCollectionDecision =
	| { readonly kind: "evidence-frozen"; readonly closure: ClosureIdentity; readonly publication: PublicationEvidence }
	| { readonly kind: "collected"; readonly closure: ClosureIdentity; readonly publication: PublicationEvidence }
export type RecoveryError = ObjectStoreError | ProviderFactStoreError | GitServiceError

export type RecoveryService = {
	readonly recoverExpiredLeases: (chains: readonly ChainIdentity[], now: number) => Effect.Effect<readonly RecoveryDecision[], RecoveryError>
	readonly freezeEvidence: (chains: readonly ChainIdentity[]) => Effect.Effect<readonly GarbageCollectionDecision[], RecoveryError>
	readonly collect: (chains: readonly ChainIdentity[]) => Effect.Effect<readonly GarbageCollectionDecision[], RecoveryError>
}

export class RuntimeRecovery extends Context.Tag("coder-loop/v3/RuntimeRecovery")<RuntimeRecovery, RecoveryService>() {}

export function makeRuntimeRecoveryLive(leaseMs: number): Layer.Layer<RuntimeRecovery, never, ObjectDomainStore | ProviderFactStore | RepositoryGit> {
	if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer")
	return Layer.effect(RuntimeRecovery, Effect.gen(function*() {
	const store = yield* ObjectDomainStore
	const facts = yield* ProviderFactStore
	const repository = yield* RepositoryGit
	return {
		recoverExpiredLeases: (chains, now) => Effect.map(
			Effect.forEach(chains, (chain) => Effect.flatMap(store.readSnapshot(chain), (snapshot) => Effect.forEach(
				Object.values(snapshot.tasks).filter((task) => isRecoverable(task, now)),
				(task) => recoverTask(store, facts, task, now, leaseMs),
				{ concurrency: "unbounded" },
			)), { concurrency: "unbounded" }),
			(decisions) => decisions.flat(),
		),
		freezeEvidence: (chains) => Effect.map(
			Effect.forEach(chains, (chain) => Effect.flatMap(store.readSnapshot(chain), (snapshot) => Effect.forEach(
				Object.values(snapshot.tasks).filter((task) => isFreezeEligible(snapshot.groups[groupKey(task.group)]?.state.kind, task)),
				(task) => freezeTask(store, repository, task),
				{ concurrency: 1 },
			)), { concurrency: 1 }),
			(decisions) => decisions.flat(),
		),
		collect: (chains) => Effect.map(
			Effect.forEach(chains, (chain) => Effect.flatMap(store.readSnapshot(chain), (snapshot) => Effect.forEach(
				Object.values(snapshot.tasks).filter((task) => isCollectEligible(snapshot.groups[groupKey(task.group)], task)),
				(task) => collectTask(store, repository, task),
				{ concurrency: 1 },
			)), { concurrency: 1 }),
			(decisions) => decisions.flat(),
		),
	}
	}))
}

function recoverTask(store: typeof ObjectDomainStore.Service, facts: typeof ProviderFactStore.Service, task: Task, now: number, leaseMs: number): Effect.Effect<RecoveryDecision, ObjectStoreError | ProviderFactStoreError> {
	let run: RunIdentity
	if (task.state.kind === "leased") {
		run = task.state.run
	} else if (task.state.kind === "held" && task.state.reason.kind === "unknown-effect") {
		run = task.state.reason.run
	} else {
		return Effect.dieMessage("recoverTask requires an expired lease or unknown-effect hold")
	}
	const factIdentity = runProviderFactIdentity(run)
	return Effect.flatMap(facts.read(factIdentity), (fact): Effect.Effect<RecoveryDecision, ObjectStoreError> => {
		if (fact?.kind === "terminal-winner" || fact?.kind === "active-loss") {
			if (task.state.kind === "leased") return Effect.succeed({ kind: "provider-fact-ready", task: task.identity, fact })
			return Effect.as(
				store.commit({
					identity: `recovery-resume:${factIdentity}`,
					transition: { family: "task-resume", task: task.identity, run, resumedAt: now, expiresAt: now + leaseMs },
				}),
				{ kind: "provider-fact-ready", task: task.identity, fact },
			)
		}
		const detail = fact?.kind === "unknown-effect" ? fact.detail : "lease expired without a durable terminal or loss winner"
		if (task.state.kind === "held") return Effect.succeed({ kind: "unknown-held", task: task.identity, detail })
		const endpoint = fact?.kind === "unknown-effect" ? fact.endpoint.digest : "unresolved"
		return Effect.as(
			store.commit({
				identity: `recovery-hold:${factIdentity}`,
				transition: { family: "task-held", task: task.identity, expectedRun: run, reason: { kind: "unknown-effect", endpoint, run, detail, observedAt: now } },
			}),
			{ kind: "unknown-held", task: task.identity, detail },
		)
	})
}

function isRecoverable(task: Task, now: number): boolean {
	return task.state.kind === "held" && task.state.reason.kind === "unknown-effect"
		|| task.state.kind === "leased" && task.state.expiresAt <= now
}

function freezeTask(store: typeof ObjectDomainStore.Service, repository: typeof RepositoryGit.Service, task: Task): Effect.Effect<GarbageCollectionDecision, ObjectStoreError | GitServiceError> {
	if (task.closure.kind !== "active" && task.closure.kind !== "suspended") return Effect.dieMessage("freezeTask requires a live closure")
	const closure = task.closure
	return Effect.flatMap(repository.publication(closure), (publication): Effect.Effect<GarbageCollectionDecision, ObjectStoreError> =>
		Effect.as(
			store.commit({ identity: `freeze-evidence:${closureKey(closure.identity)}`, transition: { family: "resource-intent", closure: closure.identity, action: "freeze-evidence", publication } }),
			{ kind: "evidence-frozen" as const, closure: closure.identity, publication },
		),
	)
}

function collectTask(store: typeof ObjectDomainStore.Service, repository: typeof RepositoryGit.Service, task: Task): Effect.Effect<GarbageCollectionDecision, ObjectStoreError | GitServiceError> {
	if (task.closure.kind !== "evidence-frozen") return Effect.dieMessage("collectTask requires frozen evidence")
	const closure = task.closure
	const publication = closure.publication
	return Effect.as(
		Effect.zipRight(
			repository.collect(closure),
			store.commit({ identity: `collect:${closureKey(closure.identity)}`, transition: { family: "resource-intent", closure: closure.identity, action: "collect", publication } }),
		),
		{ kind: "collected", closure: closure.identity, publication },
	)
}

function isFreezeEligible(groupState: string | undefined, task: Task): boolean {
	return groupState === "consumed" && task.state.kind === "settled" && (task.closure.kind === "active" || task.closure.kind === "suspended")
}

function isCollectEligible(group: TaskGroup | undefined, task: Task): boolean {
	return group?.state.kind === "consumed"
		&& group.members.some((member) => taskKey(member) === taskKey(task.identity))
		&& task.closure.kind === "evidence-frozen"
}

function closureKey(identity: ClosureIdentity): string {
	return `${taskKey(identity.task)}/${identity.attempt}`
}
