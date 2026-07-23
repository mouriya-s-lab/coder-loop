import { afterAll, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	SqliteStateError,
	type ChainRecord,
	type CreateItemInput,
	type ItemRecord,
	openSqliteStateStore,
} from "../../../src/sqlite-state"
import type { JsonObject } from "../../../src/loop"
import type { TaskTreeSnapshot } from "../../../src/task-runtime"
import { chainBindings, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"
import { seedCanonicalHistoricalRuntime } from "../../../src/issue-558-historical-fixture"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
export const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/sqlite-state-tests", String(process.pid))

export let nextRootId = 0

// #397 test brand helper — see install-commands.test.ts for rationale.
export function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

export function expectSqliteCode(action: () => void, code: SqliteStateError["code"]): void {
	try {
		action()
		throw new Error(`expected SqliteStateError ${code}`)
	} catch (error: unknown) {
		if (!(error instanceof SqliteStateError)) throw error
		expect(error.code).toBe(code)
	}
}

export function captureSqliteError(action: () => void): SqliteStateError {
	try {
		action()
		throw new Error("expected SqliteStateError")
	} catch (error: unknown) {
		if (error instanceof SqliteStateError) return error
		throw error
	}
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

export async function openTestStore(name: string): Promise<{ store: ReturnType<typeof openSqliteStateStore>; dbFile: string }> {
	const loopDataRoot = resolve(TEST_ROOT, `${name}-${Date.now()}-${++nextRootId}`)
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	return { store, dbFile: resolve(loopDataRoot, "db.sqlite") }
}

export function createFullChain(store: ReturnType<typeof openSqliteStateStore>): ChainRecord {
	return store.createChain({
		name: "central-state",
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		status: "active",
		// #457: umbrella values previously stored in chains.umbrella_issue / umbrella_repo first-class
		// columns. The columns are retired; bundled preset reads umbrella through metadata.bindings
		// (chain.umbrellaRepo / chain.umbrellaIssue declared-binding namespace).
		metadata: storedChainMetadata({
			flavor: "codex",
			tier: "claude",
			nested: { enabled: true },
			bindings: { umbrellaIssue: 176, umbrellaRepo: "mouriya-s-lab/coder-loop" },
		}),
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_010,
	})
}

// #419: ItemRecord/CreateItemInput retired top-level `issueNumber` / `branch` / `pr`. Tests use
// `issueNumber` / `branch` / `pr` as shim aliases for clarity; the fixture folds them into
// `itemId` and `extra` so the actual DB write matches the new shape.
export type FullItemOverrides = Omit<Partial<CreateItemInput>, "status" | "extra"> & {
	status?: string
	extra?: JsonObject
	issueNumber?: number
	branch?: string | null
	pr?: number | null
}

export function createFullItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	overrides: FullItemOverrides = {},
): ItemRecord {
	const {
		status = "queued",
		extra,
		issueNumber,
		branch,
		pr,
		itemId,
		...rest
	} = overrides
	const resolvedIssueNumber = issueNumber ?? 177
	const resolvedBranch = branch !== undefined ? branch : "issue-177"
	const resolvedPr = pr !== undefined ? pr : 188
	const defaultExtra: JsonObject = { issue: resolvedIssueNumber, phase: "A", nested: { db: true } }
	const baseExtra: JsonObject = extra ?? defaultExtra
	const extraWithLegacy: JsonObject = { ...baseExtra }
	if (resolvedBranch !== null) extraWithLegacy.branch = resolvedBranch
	if (resolvedPr !== null) extraWithLegacy.pr = resolvedPr
	return store.createItem({
		chainId: chain.id,
		itemId: itemId ?? String(resolvedIssueNumber),
		repoCwd: "/repo/coder-loop",
		status: runtimeStatus(status),
		attempts: 1,
		title: "feat: SQLite 状态存储与 LoopState 完整映射",
		priority: "10",
		lastRunId: "run-177",
		issueFile: "issues/177.md",
		evidenceDir: "evidence/177",
		agentCwd: "/repo/coder-loop",
		runner: "codex",
		extra: storedItemExtra(extraWithLegacy),
		createdAt: 1_800_000_020,
		updatedAt: 1_800_000_030,
		...rest,
	})
}

export function definitionRunExtra(overrides: JsonObject = {}) {
	return storedItemExtra({
		definitionKind: "preset",
		definitionContentIdentity: "sha256:persisted-definition",
		definitionPhases: [
			{ phase: "iteration", definitionNodeId: "task:iteration" },
			{ phase: "review", definitionNodeId: "task:review" },
			{ phase: "blocked-responder", definitionNodeId: "task:blocked-responder" },
			{ phase: "umbrella-finalizer", definitionNodeId: "task:umbrella-finalizer" },
		],
		worktreePath: "/repo/coder-loop",
		branchName: "issue-177",
		baseCommit: "0123456789abcdef",
		...overrides,
	})
}

export function singleLeafTree(item: ItemRecord): TaskTreeSnapshot {
	return {
		root: {
			kind: "leaf",
			identity: { runtimeNodeId: `leaf-${item.id}`, definitionRef: { kind: "chain", contentIdentity: "sha256:single-leaf" }, definitionNodeId: "leaf" },
			state: "pending",
			closure: { closureId: `closure-${item.id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] },
		},
		activeRuns: [],
	}
}

export function twoPhaseLeafTree(item: ItemRecord, sourceParNodeId: string | null = null): TaskTreeSnapshot {
	const definitionRef = { kind: "chain", contentIdentity: "sha256:two-phase" } as const
	const closure = (phase: string) => ({ kind: "leaf", identity: { runtimeNodeId: `leaf-${item.id}-${phase}`, definitionRef, definitionNodeId: phase }, state: "pending", closure: { closureId: `closure-${item.id}-${phase}`, itemRowId: item.id, itemId: item.itemId, phase, lifecycle: "active", worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId, sessions: [] } } as const)
	return { root: { kind: "seq", identity: { runtimeNodeId: `root-${item.id}`, definitionRef, definitionNodeId: "root" }, cursor: { kind: "next", nodeId: `leaf-${item.id}-iteration` }, children: [closure("iteration"), closure("review")] }, activeRuns: [] }
}

export function dbFileRoot(dbFile: string): string {
	return dbFile.slice(0, -"db.sqlite".length - 1)
}

export { Database, cp, mkdir, rm, writeFile, resolve, SqliteStateError, openSqliteStateStore, chainBindings, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra, seedCanonicalHistoricalRuntime }
export type { ChainRecord, CreateItemInput, ItemRecord, JsonObject, TaskTreeSnapshot }
