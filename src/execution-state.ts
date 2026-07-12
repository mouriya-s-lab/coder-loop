import type { AgentRunnerKind } from "./loop"

export type PresetDefinitionRef = {
	kind: "preset"
	contentIdentity: string
}

export type ChainDefinitionRef = {
	kind: "chain"
	contentIdentity: string
}

export type ExecutionDefinitionRef = PresetDefinitionRef | ChainDefinitionRef

export type TaskNodeIdentity = {
	runtimeNodeId: string
	definitionRef: ExecutionDefinitionRef
	definitionNodeId: string
}

export type ClosureLifecycle = "active" | "suspended" | "consumed"

export type ClosureSession = {
	runner: AgentRunnerKind
	sessionId: string
}

export type ClosureSnapshot = {
	closureId: string
	itemRowId: number
	itemId: string
	phase: string
	lifecycle: ClosureLifecycle
	worktreePath: string | null
	branchName: string | null
	baseCommit: string
	sourceParNodeId: string | null
	sessions: readonly ClosureSession[]
}

export type JoinValueSnapshot =
	| { kind: "drain" }
	| {
		kind: "validator"
		candidate: {
			definitionRef: ExecutionDefinitionRef
			candidateId: string
		}
	}

export type JoinEvaluationSnapshot =
	| { kind: "not-evaluating" }
	| { kind: "evaluating"; epoch: number; bindingVersion: number }
	| { kind: "decided"; epoch: number; bindingVersion: number }
	| { kind: "consumed"; epoch: number; bindingVersion: number }

export type TaskLeafSnapshot = {
	kind: "leaf"
	identity: TaskNodeIdentity
	closure: ClosureSnapshot
}

export type TaskSeqSnapshot = {
	kind: "seq"
	identity: TaskNodeIdentity
	cursor: { kind: "next"; nodeId: string } | { kind: "complete" }
	children: readonly TaskNodeSnapshot[]
}

export type TaskParSnapshot = {
	kind: "par"
	identity: TaskNodeIdentity
	groupId: string
	pinCommit: string
	state: "open" | "completed" | "exhausted"
	reopen: {
		count: number
		budgetRef: string
	}
	join: {
		currentVersion: number
		value: JoinValueSnapshot
		evaluation: JoinEvaluationSnapshot
	}
	children: readonly TaskNodeSnapshot[]
}

export type TaskNodeSnapshot = TaskLeafSnapshot | TaskSeqSnapshot | TaskParSnapshot

export type ActiveRunSnapshot = {
	closureId: string
	runId: string
	phase: string
	startedAt: number
}

export type TaskTreeSnapshot = {
	root: TaskNodeSnapshot
	activeRuns: readonly ActiveRunSnapshot[]
}

export function taskNodeChildren(node: TaskNodeSnapshot): readonly TaskNodeSnapshot[] {
	switch (node.kind) {
		case "leaf": return []
		case "seq": return node.children
		case "par": return node.children
	}
}

export function closureRetainsEnvironment(lifecycle: ClosureLifecycle): boolean {
	switch (lifecycle) {
		case "active": return true
		case "suspended": return true
		case "consumed": return false
	}
}
