import type { Context0, Context1, Context2, Context3 } from "./context"
import type { JsonValue } from "./definition"
import type { HookDeliveryAudit } from "./hooks"
import {
	groupKey,
	readyTasks,
	taskKey,
	type ObjectDomainSnapshot,
	type TaskHoldReason,
} from "./object-domain"
import type { ProviderFact } from "./provider"
import type { CommittedTransitionAudit } from "./sqlite-store"

export type TaskProjection =
	| { readonly identity: string; readonly group: string; readonly state: "ready"; readonly priority: number }
	| { readonly identity: string; readonly group: string; readonly state: "leased"; readonly priority: number; readonly run: string; readonly expiresAt: number }
	| { readonly identity: string; readonly group: string; readonly state: "suspended"; readonly priority: number; readonly await: string }
	| { readonly identity: string; readonly group: string; readonly state: "held"; readonly priority: number; readonly reason: TaskHoldReason }
	| { readonly identity: string; readonly group: string; readonly state: "settled"; readonly priority: number; readonly settlement: "returned" | "exception"; readonly settledAt: number }

export type GroupProjection = {
	readonly identity: string
	readonly state: "open" | "waiting" | "terminated" | "consuming" | "consumed"
	readonly memberCount: number
	readonly memberVersion: number
	readonly deadline: number | null
}

export type StatusProjectionV3 = {
	readonly schemaVersion: 3
	readonly chain: string
	readonly taskCounts: Readonly<Record<TaskProjection["state"], number>>
	readonly ready: readonly string[]
	readonly tasks: readonly TaskProjection[]
	readonly groups: readonly GroupProjection[]
	readonly awaits: number
	readonly admittedFacts: number
}

export type EventProjectionV3 = {
	readonly schemaVersion: 3
	readonly chain: string
	readonly transitions: readonly CommittedTransitionAudit[]
}

export type PredicateObservation = { readonly name: string; readonly passed: boolean }

export type FunctionTimelineProjection = {
	readonly schemaVersion: 3
	readonly closure: string
	readonly contexts: readonly {
		readonly timeline: "context-0" | "context-1" | "context-2" | "context-3"
		readonly values: Readonly<Record<string, JsonValue>>
	}[]
	readonly predicates: readonly PredicateObservation[]
}

export type SideEffectAuditProjection = {
	readonly schemaVersion: 3
	readonly hooks: readonly HookDeliveryAudit[]
	readonly providers: readonly ProviderFact[]
}

export function buildStatusProjection(snapshot: ObjectDomainSnapshot): StatusProjectionV3 {
	const tasks = Object.values(snapshot.tasks).map(projectTask).sort((left, right) => left.identity.localeCompare(right.identity))
	const taskCounts: Record<TaskProjection["state"], number> = { ready: 0, leased: 0, suspended: 0, held: 0, settled: 0 }
	for (const task of tasks) taskCounts[task.state] += 1
	const groups = Object.values(snapshot.groups).map((group): GroupProjection => ({
		identity: groupKey(group.identity),
		state: group.state.kind,
		memberCount: group.members.length,
		memberVersion: group.memberVersion,
		deadline: group.state.kind === "waiting" ? group.state.deadline : null,
	})).sort((left, right) => left.identity.localeCompare(right.identity))
	return {
		schemaVersion: 3,
		chain: snapshot.chain.value,
		taskCounts,
		ready: readyTasks(snapshot).map((task) => taskKey(task.identity)),
		tasks,
		groups,
		awaits: Object.keys(snapshot.awaits).length,
		admittedFacts: Object.keys(snapshot.admittedFacts).length,
	}
}

export function buildEventProjection(chain: string, transitions: readonly CommittedTransitionAudit[]): EventProjectionV3 {
	return { schemaVersion: 3, chain, transitions }
}

export function buildFunctionTimelineProjection(closure: string, contexts: readonly [Context0, Context1, Context2, Context3], predicates: readonly PredicateObservation[]): FunctionTimelineProjection {
	return {
		schemaVersion: 3,
		closure,
		contexts: contexts.map((context) => ({ timeline: context.stage, values: context.values })),
		predicates,
	}
}

export function buildSideEffectAuditProjection(hooks: readonly HookDeliveryAudit[], providers: readonly ProviderFact[]): SideEffectAuditProjection {
	return { schemaVersion: 3, hooks, providers }
}

function projectTask(task: ObjectDomainSnapshot["tasks"][string]): TaskProjection {
	const identity = taskKey(task.identity)
	const group = groupKey(task.group)
	switch (task.state.kind) {
		case "ready": return { identity, group, state: "ready", priority: task.priority }
		case "leased": return { identity, group, state: "leased", priority: task.priority, run: `${task.state.run.closure.attempt}/${task.state.run.value}`, expiresAt: task.state.expiresAt }
		case "suspended": return { identity, group, state: "suspended", priority: task.priority, await: `${task.state.await.attempt}/${task.state.await.site}` }
		case "held": return { identity, group, state: "held", priority: task.priority, reason: task.state.reason }
		case "settled": return { identity, group, state: "settled", priority: task.priority, settlement: task.state.settlement.kind, settledAt: task.state.settledAt }
	}
}
