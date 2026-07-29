import { type as arkType } from "arktype"

export type PresetDefinitionRef = { kind: "preset"; contentIdentity: string }
export type ChainDefinitionRef = { kind: "chain"; contentIdentity: string }
export type ExecutionDefinitionRef = PresetDefinitionRef | ChainDefinitionRef

export type TaskNodeIdentity = {
	runtimeNodeId: string
	definitionRef: ExecutionDefinitionRef
	definitionNodeId: string
}

export type ClosureLifecycle = "active" | "suspended" | "consumed"
export type ClosureSession = { runner: "claude" | "codex" | "opencode"; sessionId: string }
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
	| { kind: "validator"; candidate: JoinValidatorCandidateSnapshot }

export type JoinValidatorCandidateSnapshot = { definitionRef: ExecutionDefinitionRef; candidateId: string }

export type JoinEvaluationSnapshot =
	| { kind: "not-evaluating" }
	| { kind: "evaluating"; epoch: number; bindingVersion: number }
	| { kind: "decided"; epoch: number; bindingVersion: number }
	| { kind: "consumed"; epoch: number; bindingVersion: number }

export type SeqCursorSnapshot = { kind: "next"; nodeId: string } | { kind: "complete" }
export type ParReopenSnapshot = { count: number; budgetRef: string }
export type ParJoinSnapshot = { currentVersion: number; value: JoinValueSnapshot; evaluation: JoinEvaluationSnapshot }
export type TaskLeafNodeSnapshot = { kind: "leaf"; identity: TaskNodeIdentity; closure: ClosureSnapshot }
export type TaskSeqNodeSnapshot = { kind: "seq"; identity: TaskNodeIdentity; cursor: SeqCursorSnapshot; children: readonly TaskNodeSnapshot[] }
export type TaskParNodeSnapshot = {
	kind: "par"
	identity: TaskNodeIdentity
	groupId: string
	pinCommit: string
	state: "open" | "completed" | "exhausted"
	reopen: ParReopenSnapshot
	join: ParJoinSnapshot
	children: readonly TaskNodeSnapshot[]
}
export type TaskNodeSnapshot = TaskLeafNodeSnapshot | TaskSeqNodeSnapshot | TaskParNodeSnapshot

export type ActiveRunSnapshot = { closureId: string; runId: string; phase: string; startedAt: number }
export type TaskTreeSnapshot = { root: TaskNodeSnapshot; activeRuns: readonly ActiveRunSnapshot[] }

const NonEmptyStringBoundary = arkType("string>0")
const DefinitionRefBoundary = arkType.or(
	{ kind: arkType.unit("preset"), contentIdentity: NonEmptyStringBoundary },
	{ kind: arkType.unit("chain"), contentIdentity: NonEmptyStringBoundary },
)
const IdentityBoundary = arkType({
	runtimeNodeId: NonEmptyStringBoundary,
	definitionRef: DefinitionRefBoundary,
	definitionNodeId: NonEmptyStringBoundary,
})
const SessionBoundary = arkType({
	runner: arkType("'claude'|'codex'|'opencode'"),
	sessionId: NonEmptyStringBoundary,
})
const ClosureBoundary = arkType({
	closureId: NonEmptyStringBoundary,
	itemRowId: "number.integer>0",
	itemId: NonEmptyStringBoundary,
	phase: NonEmptyStringBoundary,
	lifecycle: arkType("'active'|'suspended'|'consumed'"),
	worktreePath: "string|null",
	branchName: "string|null",
	baseCommit: NonEmptyStringBoundary,
	sourceParNodeId: "string|null",
	sessions: SessionBoundary.array(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function accepts(boundary: { allows(value: unknown): boolean }, value: unknown): boolean {
	return boundary.allows(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value)
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isDefinitionRef(value: unknown): value is ExecutionDefinitionRef {
	return isRecord(value)
		&& accepts(DefinitionRefBoundary, value)
		&& hasExactKeys(value, ["kind", "contentIdentity"])
}

function isIdentity(value: unknown): value is TaskNodeIdentity {
	return isRecord(value)
		&& accepts(IdentityBoundary, value)
		&& isDefinitionRef(value.definitionRef)
		&& hasExactKeys(value, ["runtimeNodeId", "definitionRef", "definitionNodeId"])
}

function isSession(value: unknown): value is ClosureSession {
	return isRecord(value)
		&& accepts(SessionBoundary, value)
		&& hasExactKeys(value, ["runner", "sessionId"])
}

function isClosure(value: unknown): value is ClosureSnapshot {
	return isRecord(value)
		&& accepts(ClosureBoundary, value)
		&& Array.isArray(value.sessions)
		&& value.sessions.every(isSession)
		&& hasExactKeys(value, ["closureId", "itemRowId", "itemId", "phase", "lifecycle", "worktreePath", "branchName", "baseCommit", "sourceParNodeId", "sessions"])
}

function isTaskNodeSnapshot(value: unknown): value is TaskNodeSnapshot {
	if (!isRecord(value) || !isIdentity(value.identity)) return false
	if (value.kind === "leaf") return isClosure(value.closure) && hasExactKeys(value, ["kind", "identity", "closure"])
	if (!Array.isArray(value.children) || !value.children.every(isTaskNodeSnapshot)) return false
	if (value.kind === "seq") {
		if (!isRecord(value.cursor)) return false
		const cursorOk = value.cursor.kind === "complete"
			? Object.keys(value.cursor).length === 1
			: value.cursor.kind === "next" && typeof value.cursor.nodeId === "string" && value.cursor.nodeId.length > 0 && Object.keys(value.cursor).length === 2
		return cursorOk && hasExactKeys(value, ["kind", "identity", "cursor", "children"])
	}
	const identity = value.identity
	if (!isRecord(identity)) return false
	if (value.kind !== "par" || value.groupId !== identity.runtimeNodeId) return false
	if (typeof value.pinCommit !== "string" || value.pinCommit.length === 0) return false
	if (value.state !== "open" && value.state !== "completed" && value.state !== "exhausted") return false
	if (!isRecord(value.reopen) || !Number.isInteger(value.reopen.count) || Number(value.reopen.count) < 0 || typeof value.reopen.budgetRef !== "string" || value.reopen.budgetRef.length === 0 || !hasExactKeys(value.reopen, ["count", "budgetRef"])) return false
	if (!isRecord(value.join) || !Number.isInteger(value.join.currentVersion) || Number(value.join.currentVersion) < 1 || !hasExactKeys(value.join, ["currentVersion", "value", "evaluation"])) return false
	if (!isJoinValue(value.join.value) || !isJoinEvaluation(value.join.evaluation)) return false
	return hasExactKeys(value, ["kind", "identity", "groupId", "pinCommit", "state", "reopen", "join", "children"])
}

function isJoinValue(value: unknown): value is JoinValueSnapshot {
	if (!isRecord(value)) return false
	if (value.kind === "drain") return Object.keys(value).length === 1
	if (value.kind !== "validator" || !isRecord(value.candidate)) return false
	return isDefinitionRef(value.candidate.definitionRef)
		&& typeof value.candidate.candidateId === "string" && value.candidate.candidateId.length > 0
		&& Object.keys(value.candidate).length === 2 && Object.keys(value).length === 2
}

function isJoinEvaluation(value: unknown): value is JoinEvaluationSnapshot {
	if (!isRecord(value)) return false
	if (value.kind === "not-evaluating") return Object.keys(value).length === 1
	if (value.kind !== "evaluating" && value.kind !== "decided" && value.kind !== "consumed") return false
	return Number.isInteger(value.epoch) && Number(value.epoch) >= 0
		&& Number.isInteger(value.bindingVersion) && Number(value.bindingVersion) >= 1
		&& Object.keys(value).length === 3
}

export const TaskTreeSnapshotBoundary = arkType("unknown").narrow((value): value is TaskTreeSnapshot => {
	if (!isRecord(value) || !isTaskNodeSnapshot(value.root) || !Array.isArray(value.activeRuns)) return false
	return hasExactKeys(value, ["root", "activeRuns"]) && value.activeRuns.every((run) => isRecord(run)
		&& typeof run.closureId === "string" && run.closureId.length > 0
		&& typeof run.runId === "string" && run.runId.length > 0
		&& typeof run.phase === "string" && run.phase.length > 0
		&& typeof run.startedAt === "number"
		&& Object.keys(run).length === 4)
})

export function assertTaskTreeSnapshot(value: unknown): TaskTreeSnapshot {
	return TaskTreeSnapshotBoundary.assert(value)
}
