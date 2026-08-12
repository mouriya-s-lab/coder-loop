import { Context, Effect, Layer } from "effect"
import {
	groupKey,
	nextGroupState,
	readyTasks,
	taskKey,
	type ChainIdentity,
	type ClosureResourceState,
	type ConsumptionIdentity,
	type GroupIdentity,
	type RunIdentity,
	type Task,
	type TaskSettlement,
} from "./object-domain"
import { ObjectDomainStore, type CommitResult, type ObjectStoreError } from "./sqlite-store"

export type ReadySelection = {
	readonly chain: ChainIdentity
	readonly task: Task
}

export type LeaseClaim = {
	readonly identity: string
	readonly task: Task
	readonly run: RunIdentity
	readonly closure: Extract<ClosureResourceState, { kind: "active" | "suspended" }>
	readonly acquiredAt: number
	readonly expiresAt: number
}

export type GroupReconciliation =
	| { readonly kind: "running"; readonly group: GroupIdentity }
	| { readonly kind: "waiting"; readonly group: GroupIdentity; readonly deadline: number }
	| { readonly kind: "terminated"; readonly group: GroupIdentity }
	| { readonly kind: "consuming"; readonly group: GroupIdentity }
	| { readonly kind: "held"; readonly group: GroupIdentity }
	| { readonly kind: "stopped"; readonly group: GroupIdentity }
	| { readonly kind: "consumed"; readonly group: GroupIdentity }

export type SchedulerService = {
	readonly nextReady: (chains: readonly ChainIdentity[]) => Effect.Effect<ReadySelection | null, ObjectStoreError>
	readonly claim: (claim: LeaseClaim) => Effect.Effect<CommitResult, ObjectStoreError>
	readonly reconcileGroup: (group: GroupIdentity, now: number) => Effect.Effect<GroupReconciliation, ObjectStoreError>
	readonly consumeGroup: (group: GroupIdentity, consumption: ConsumptionIdentity, consumedAt: number) => Effect.Effect<CommitResult, ObjectStoreError>
}

export class Scheduler extends Context.Tag("coder-loop/v3/Scheduler")<Scheduler, SchedulerService>() {}

export const SchedulerLive: Layer.Layer<Scheduler, never, ObjectDomainStore> = Layer.effect(Scheduler, Effect.gen(function*() {
	const store = yield* ObjectDomainStore
	return {
		nextReady: (chains) => Effect.map(
			Effect.forEach(chains, (chain) => store.readSnapshot(chain), { concurrency: "unbounded" }),
			(snapshots) => selectReadyTask(snapshots.map((snapshot) => ({ chain: snapshot.chain, tasks: readyTasks(snapshot) }))),
		),
		claim: (claim) => store.commit({
			identity: claim.identity,
			transition: {
				family: "lease-acquire",
				task: claim.task.identity,
				run: claim.run,
				closure: claim.closure,
				acquiredAt: claim.acquiredAt,
				expiresAt: claim.expiresAt,
			},
		}),
		reconcileGroup: (group, now) => Effect.flatMap(store.readSnapshot(group.chain), (snapshot): Effect.Effect<GroupReconciliation, ObjectStoreError> => {
			const current = snapshot.groups[groupKey(group)]
			if (current === undefined) return Effect.fail<ObjectStoreError>({ kind: "transition-rejected", family: "group-termination", reason: "not-found", message: `group ${groupKey(group)} not found` })
			if (current.state.kind === "consumed") return Effect.succeed({ kind: "consumed", group })
			if (current.state.kind === "stopped") return Effect.succeed({ kind: "stopped", group })
			if (current.state.kind === "terminated") return Effect.succeed({ kind: "terminated", group })
			if (current.state.kind === "consuming") return Effect.succeed({ kind: "consuming", group })
			const next = nextGroupState(current, snapshot.tasks, now)
			if (next.kind === "open") return Effect.succeed({ kind: "running", group })
			if (next.kind === "waiting") {
				if (current.state.kind === "waiting" && current.state.deadline === next.deadline && current.state.memberVersion === next.memberVersion) {
					return Effect.succeed({ kind: "waiting", group, deadline: next.deadline })
				}
				return Effect.as(
					store.commit({ identity: `group-waiting:${groupKey(group)}:${next.memberVersion}:${next.deadline}`, transition: { family: "group-waiting", group, state: next } }),
					{ kind: "waiting", group, deadline: next.deadline },
				)
			}
			if (next.kind === "held") return Effect.succeed({ kind: "held", group })
			if (next.kind === "consuming") return Effect.succeed({ kind: "consuming", group })
			if (next.kind === "consumed") return Effect.succeed({ kind: "consumed", group })
			if (next.kind === "stopped") return Effect.succeed({ kind: "stopped", group })
			return Effect.as(
				store.commit({ identity: `group-terminated:${groupKey(group)}:${next.memberVersion}:${next.terminatedAt}`, transition: { family: "group-termination", group, state: next } }),
				{ kind: "terminated", group },
			)
		}),
		consumeGroup: (group, consumption, consumedAt) => Effect.flatMap(store.readSnapshot(group.chain), (snapshot) => {
			const current = snapshot.groups[groupKey(group)]
			if (current === undefined) return Effect.fail<ObjectStoreError>({ kind: "transition-rejected", family: "group-consumption", reason: "not-found", message: `group ${groupKey(group)} not found` })
			const settlements: TaskSettlement[] = []
			for (const identity of current.members) {
				const state = snapshot.tasks[taskKey(identity)]?.state
				if (state?.kind !== "settled") return Effect.fail<ObjectStoreError>({ kind: "transition-rejected", family: "group-consumption", reason: "state-mismatch", message: `task ${taskKey(identity)} is not settled` })
				settlements.push(state.settlement)
			}
			return store.commit({
				identity: `group-consumed:${groupKey(group)}:${consumption.value}`,
				transition: { family: "group-consumption", group, state: { kind: "consumed", consumption, consumedAt }, settlements },
			})
		}),
	}
}))

export function selectReadyTask(chains: readonly { readonly chain: ChainIdentity; readonly tasks: readonly Task[] }[]): ReadySelection | null {
	const candidates = chains.flatMap(({ chain, tasks }) => tasks
		.filter((task) => task.state.kind === "ready")
		.map((task) => ({ chain, task })))
	candidates.sort((left, right) => right.task.priority - left.task.priority || taskKey(left.task.identity).localeCompare(taskKey(right.task.identity)))
	return candidates[0] ?? null
}
