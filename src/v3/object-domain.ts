import type { ClosureExit } from "./context"
import type { DefinitionRef } from "./definition-store"
import type { JsonValue } from "./definition"

export type ChainIdentity = { readonly kind: "chain"; readonly value: string }
export type TaskIdentity = { readonly kind: "task"; readonly chain: ChainIdentity; readonly value: string }
export type GroupIdentity = { readonly kind: "group"; readonly chain: ChainIdentity; readonly value: string }
export type ClosureIdentity = { readonly kind: "closure"; readonly task: TaskIdentity; readonly attempt: number }
export type RunIdentity = { readonly kind: "run"; readonly closure: ClosureIdentity; readonly value: string }
export type AwaitIdentity = { readonly kind: "await"; readonly parent: TaskIdentity; readonly attempt: number; readonly site: string }
export type FactIdentity = { readonly kind: "fact"; readonly source: string; readonly value: string }
export type ConsumptionIdentity = { readonly kind: "consumption"; readonly group: GroupIdentity; readonly value: string }

export type TaskInput = {
	readonly definition: DefinitionRef
	readonly basePin: string
	readonly value: JsonValue
	readonly valueIdentity: string
}

export type TaskHoldReason =
	| { readonly kind: "pre-spawn-absence"; readonly endpoint: string; readonly detail: string; readonly observedAt: number }
	| { readonly kind: "unknown-effect"; readonly endpoint: string; readonly run: RunIdentity; readonly detail: string; readonly observedAt: number }

export type TaskState =
	| { readonly kind: "ready" }
	| { readonly kind: "leased"; readonly run: RunIdentity; readonly acquiredAt: number; readonly expiresAt: number }
	| { readonly kind: "suspended"; readonly await: AwaitIdentity }
	| { readonly kind: "held"; readonly reason: TaskHoldReason }
	| { readonly kind: "settled"; readonly settlement: TaskSettlement; readonly settledAt: number }

export type TaskSettlement =
	| { readonly kind: "returned"; readonly value: JsonValue }
	| { readonly kind: "exception"; readonly cause: ClosureExit & { readonly kind: "exception" }; readonly attempt: number; readonly closure: ClosureIdentity }

export type Task = {
	readonly identity: TaskIdentity
	readonly group: GroupIdentity
	readonly input: TaskInput
	readonly dependsOn: readonly TaskIdentity[]
	readonly priority: number
	readonly state: TaskState
	readonly closure: ClosureResourceState
}

export type ClosureResourceState =
	| { readonly kind: "unallocated" }
	| { readonly kind: "active"; readonly identity: ClosureIdentity; readonly basePin: string; readonly branch: string; readonly worktree: string; readonly scratch: string }
	| { readonly kind: "suspended"; readonly identity: ClosureIdentity; readonly basePin: string; readonly branch: string; readonly worktree: string; readonly scratch: string; readonly continuation: ContinuationFact }
	| { readonly kind: "evidence-frozen"; readonly identity: ClosureIdentity; readonly basePin: string; readonly branch: string; readonly worktree: string; readonly scratch: string; readonly publication: PublicationEvidence }
	| { readonly kind: "collected"; readonly identity: ClosureIdentity; readonly publication: PublicationEvidence; readonly collectedAt: number }

export type ContinuationFact =
	| { readonly kind: "present"; readonly sessionIdentity: string; readonly observedAt: number }
	| { readonly kind: "lost"; readonly observedAt: number }

export type PublicationEvidence =
	| { readonly kind: "published"; readonly tip: string; readonly remoteRef: string; readonly observedAt: number }
	| { readonly kind: "unpublished"; readonly tip: string; readonly observedAt: number }
	| { readonly kind: "unknown"; readonly tip: string; readonly reason: string; readonly observedAt: number }
	| { readonly kind: "no-work"; readonly observedAt: number }

export type WaitWindow =
	| { readonly kind: "none" }
	| { readonly kind: "fixed-deadline"; readonly durationMs: number }
	| { readonly kind: "sliding-deadline"; readonly durationMs: number }

export type GroupState =
	| { readonly kind: "open" }
	| { readonly kind: "waiting"; readonly deadline: number; readonly memberVersion: number }
	| { readonly kind: "terminated"; readonly reason: "immediate" | "deadline"; readonly memberVersion: number; readonly terminatedAt: number }
	| { readonly kind: "consumed"; readonly consumption: ConsumptionIdentity; readonly consumedAt: number }

export type GroupConsumer =
	| { readonly kind: "drain" }
	| { readonly kind: "validator"; readonly definition: DefinitionRef }
	| { readonly kind: "finalizer"; readonly definition: DefinitionRef }

export type TaskGroup = {
	readonly identity: GroupIdentity
	readonly members: readonly TaskIdentity[]
	readonly memberVersion: number
	readonly wait: WaitWindow
	readonly consumer: GroupConsumer
	readonly state: GroupState
}

export type AwaitRecord =
	| {
		readonly kind: "waiting"
		readonly identity: AwaitIdentity
		readonly parentClosure: ClosureIdentity
		readonly child: TaskIdentity
	}
	| {
		readonly kind: "delivered"
		readonly identity: AwaitIdentity
		readonly parentClosure: ClosureIdentity
		readonly child: TaskIdentity
		readonly settlement: TaskSettlement
		readonly token: string
	}
	| {
		readonly kind: "continuation-lost"
		readonly identity: AwaitIdentity
		readonly parentClosure: ClosureIdentity
		readonly child: TaskIdentity
	}

export type AdmissionPosition = {
	readonly group: GroupIdentity
	readonly expectedMemberVersion: number
}

export type AdmissionTiming =
	| { readonly kind: "before-termination" }
	| { readonly kind: "before-deadline"; readonly claimedAt: number }

export type AdmissionAuthority =
	| { readonly kind: "internal"; readonly run: RunIdentity; readonly allowedGroup: GroupIdentity }
	| { readonly kind: "external"; readonly principal: string; readonly allowedChain: ChainIdentity }

export type AdmissionRequest = {
	readonly fact: FactIdentity
	readonly position: AdmissionPosition
	readonly timing: AdmissionTiming
	readonly authority: AdmissionAuthority
	readonly task: Omit<Task, "state" | "closure">
}

export type OpenFrontier = readonly {
	readonly group: GroupIdentity
	readonly memberVersion: number
	readonly deadline: number | null
}[]

export type AdmissionRejection =
	| { readonly kind: "position-unavailable"; readonly frontier: OpenFrontier }
	| { readonly kind: "timing-invalid"; readonly frontier: OpenFrontier }
	| { readonly kind: "contract-rejected"; readonly reason: "definition-chain-mismatch" | "dependency-cycle" | "duplicate-task"; readonly frontier: OpenFrontier }
	| { readonly kind: "unauthorized"; readonly frontier: OpenFrontier }

export type AdmissionResult =
	| { readonly kind: "admitted"; readonly task: Task; readonly position: AdmissionPosition }
	| { readonly kind: "rejected"; readonly reason: AdmissionRejection }

export type RetryPolicy =
	| { readonly kind: "never" }
	| { readonly kind: "limited"; readonly maxAttempts: number; readonly backoffMs: number }

export type ExhaustionPolicy = {
	readonly step: "skip-step" | "stop-task"
	readonly task: "skip-task" | "stop-group"
	readonly group: "advance-next-item" | "stay-on-current-item"
}

export type EscalationPolicy = {
	readonly retry: RetryPolicy
	readonly exhausted: ExhaustionPolicy
}

export type ObjectDomainAction =
	| { readonly kind: "retry-step"; readonly afterMs: number }
	| { readonly kind: "skip-step" }
	| { readonly kind: "settle-task-exception" }
	| { readonly kind: "skip-task" }
	| { readonly kind: "terminate-group" }
	| { readonly kind: "advance-next-item" }
	| { readonly kind: "stay-on-current-item" }
	| { readonly kind: "stop-engine" }

export type CommittedTransition =
	| { readonly family: "task-admission"; readonly fact: FactIdentity; readonly task: Task; readonly position: AdmissionPosition }
	| { readonly family: "lease-acquire"; readonly task: TaskIdentity; readonly run: RunIdentity; readonly closure: Extract<ClosureResourceState, { kind: "active" }>; readonly acquiredAt: number; readonly expiresAt: number }
	| { readonly family: "lease-release"; readonly task: TaskIdentity; readonly run: RunIdentity; readonly reason: "cancelled" }
	| { readonly family: "task-held"; readonly task: TaskIdentity; readonly expectedRun: RunIdentity | null; readonly reason: TaskHoldReason }
	| { readonly family: "task-unhold"; readonly task: TaskIdentity }
	| { readonly family: "task-resume"; readonly task: TaskIdentity; readonly run: RunIdentity; readonly resumedAt: number; readonly expiresAt: number }
	| { readonly family: "task-settlement"; readonly task: TaskIdentity; readonly run: RunIdentity; readonly settlement: TaskSettlement; readonly successors: readonly { readonly fact: FactIdentity; readonly task: Task; readonly position: AdmissionPosition }[] }
	| { readonly family: "await-suspension"; readonly task: TaskIdentity; readonly run: RunIdentity; readonly record: Extract<AwaitRecord, { kind: "waiting" }>; readonly continuation: ContinuationFact }
	| { readonly family: "await-resumption"; readonly task: TaskIdentity; readonly record: Extract<AwaitRecord, { kind: "delivered" | "continuation-lost" }> }
	| { readonly family: "group-waiting"; readonly group: GroupIdentity; readonly state: Extract<GroupState, { kind: "waiting" }> }
	| { readonly family: "group-termination"; readonly group: GroupIdentity; readonly state: Extract<GroupState, { kind: "terminated" }> }
	| { readonly family: "group-consumption"; readonly group: GroupIdentity; readonly state: Extract<GroupState, { kind: "consumed" }>; readonly settlements: readonly TaskSettlement[] }
	| { readonly family: "resource-intent"; readonly closure: ClosureIdentity; readonly action: "freeze-evidence" | "collect"; readonly publication: PublicationEvidence | null }

export type ObjectDomainSnapshot = {
	readonly chain: ChainIdentity
	readonly tasks: Readonly<Record<string, Task>>
	readonly groups: Readonly<Record<string, TaskGroup>>
	readonly awaits: Readonly<Record<string, AwaitRecord>>
	readonly admittedFacts: Readonly<Record<string, TaskIdentity>>
}

export function taskKey(identity: TaskIdentity): string {
	return `${identity.chain.value}/${identity.value}`
}

export function groupKey(identity: GroupIdentity): string {
	return `${identity.chain.value}/${identity.value}`
}

export function factKey(identity: FactIdentity): string {
	return `${identity.source}/${identity.value}`
}

export function evaluateAdmission(snapshot: ObjectDomainSnapshot, request: AdmissionRequest): AdmissionResult {
	const group = snapshot.groups[groupKey(request.position.group)]
	const frontier = openFrontier(snapshot)
	if (group === undefined || group.state.kind === "terminated" || group.state.kind === "consumed" || group.memberVersion !== request.position.expectedMemberVersion) {
		return { kind: "rejected", reason: { kind: "position-unavailable", frontier } }
	}
	if (!authorityAllows(request.authority, request.position.group)) {
		return { kind: "rejected", reason: { kind: "unauthorized", frontier } }
	}
	if (request.timing.kind === "before-deadline" && (group.state.kind !== "waiting" || request.timing.claimedAt > group.state.deadline)) {
		return { kind: "rejected", reason: { kind: "timing-invalid", frontier } }
	}
	if (Object.hasOwn(snapshot.tasks, taskKey(request.task.identity))) {
		return { kind: "rejected", reason: { kind: "contract-rejected", reason: "duplicate-task", frontier } }
	}
	if (request.task.identity.chain.value !== snapshot.chain.value || request.position.group.chain.value !== snapshot.chain.value) {
		return { kind: "rejected", reason: { kind: "contract-rejected", reason: "definition-chain-mismatch", frontier } }
	}
	if (wouldIntroduceDependencyCycle(snapshot, request.task.identity, request.task.dependsOn)) {
		return { kind: "rejected", reason: { kind: "contract-rejected", reason: "dependency-cycle", frontier } }
	}
	const task: Task = { ...request.task, state: { kind: "ready" }, closure: { kind: "unallocated" } }
	return { kind: "admitted", task, position: request.position }
}

export function readyTasks(snapshot: ObjectDomainSnapshot): readonly Task[] {
	return Object.values(snapshot.tasks)
		.filter((task) => task.state.kind === "ready" && task.dependsOn.every((dependency) => snapshot.tasks[taskKey(dependency)]?.state.kind === "settled"))
		.sort((left, right) => right.priority - left.priority || taskKey(left.identity).localeCompare(taskKey(right.identity)))
}

export function evaluateEscalation(policy: EscalationPolicy, attempt: number): readonly ObjectDomainAction[] {
	if (policy.retry.kind === "limited" && attempt < policy.retry.maxAttempts) {
		return [{ kind: "retry-step", afterMs: policy.retry.backoffMs }]
	}
	if (policy.exhausted.step === "skip-step") return [{ kind: "skip-step" }]
	if (policy.exhausted.task === "skip-task") return [{ kind: "settle-task-exception" }, { kind: "skip-task" }]
	if (policy.exhausted.group === "advance-next-item") {
		return [{ kind: "settle-task-exception" }, { kind: "terminate-group" }, { kind: "advance-next-item" }]
	}
	return [{ kind: "settle-task-exception" }, { kind: "terminate-group" }, { kind: "stay-on-current-item" }]
}

export function nextGroupState(group: TaskGroup, tasks: Readonly<Record<string, Task>>, now: number): GroupState {
	if (group.state.kind === "terminated" || group.state.kind === "consumed") return group.state
	const allSettled = group.members.every((identity) => tasks[taskKey(identity)]?.state.kind === "settled")
	if (!allSettled) return { kind: "open" }
	if (group.wait.kind === "none") return { kind: "terminated", reason: "immediate", memberVersion: group.memberVersion, terminatedAt: now }
	if (group.state.kind === "waiting") {
		if (group.state.memberVersion !== group.memberVersion && group.wait.kind === "sliding-deadline") {
			return { kind: "waiting", deadline: now + group.wait.durationMs, memberVersion: group.memberVersion }
		}
		if (now >= group.state.deadline) return { kind: "terminated", reason: "deadline", memberVersion: group.memberVersion, terminatedAt: now }
		return group.state
	}
	return { kind: "waiting", deadline: now + group.wait.durationMs, memberVersion: group.memberVersion }
}

export function openFrontier(snapshot: ObjectDomainSnapshot): OpenFrontier {
	return Object.values(snapshot.groups)
		.filter((group) => group.state.kind === "open" || group.state.kind === "waiting")
		.map((group) => ({
			group: group.identity,
			memberVersion: group.memberVersion,
			deadline: group.state.kind === "waiting" ? group.state.deadline : null,
		}))
}

function authorityAllows(authority: AdmissionAuthority, group: GroupIdentity): boolean {
	return authority.kind === "internal"
		? groupKey(authority.allowedGroup) === groupKey(group)
		: authority.allowedChain.value === group.chain.value
}

function wouldIntroduceDependencyCycle(snapshot: ObjectDomainSnapshot, task: TaskIdentity, dependencies: readonly TaskIdentity[]): boolean {
	const target = taskKey(task)
	const visit = (identity: TaskIdentity, seen: ReadonlySet<string>): boolean => {
		const key = taskKey(identity)
		if (key === target) return true
		if (seen.has(key)) return false
		const nextSeen = new Set(seen)
		nextSeen.add(key)
		return snapshot.tasks[key]?.dependsOn.some((dependency) => visit(dependency, nextSeen)) ?? false
	}
	return dependencies.some((dependency) => visit(dependency, new Set()))
}
