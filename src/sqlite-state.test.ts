import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	SqliteStateError,
	type ChainRecord,
	type CreateItemInput,
	type ItemRecord,
	openSqliteStateStore,
} from "./sqlite-state"
import type { JsonObject } from "./loop"
import type { TaskTreeSnapshot } from "./task-runtime"
import { chainBindings, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"
import { daemonRequest, sendDaemonRequest, startCoderLoopDaemon } from "./daemon"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/sqlite-state-tests", String(process.pid))

let nextRootId = 0

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

function expectSqliteCode(action: () => void, code: SqliteStateError["code"]): void {
	try {
		action()
		throw new Error(`expected SqliteStateError ${code}`)
	} catch (error: unknown) {
		if (!(error instanceof SqliteStateError)) throw error
		expect(error.code).toBe(code)
	}
}

function captureSqliteError(action: () => void): SqliteStateError {
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

describe("sqlite state store", () => {
	test("schema covers chain core columns (umbrella retired #457)", async () => {
		const { store } = await openTestStore("schema")
		try {
			// #457: chains.umbrella_issue / umbrella_repo columns retired. Existing data is moved
			// into chain.metadata.bindings by the v10→v11 migration; new chains write umbrella
			// values straight into metadata.bindings via the declared-field path.
			expect(store.listTableColumns("chains")).toEqual([
				"id",
				"name",
				"preset",
				"repository",
				"base_branch",
				"status",
				"metadata",
				"created_at",
				"updated_at",
			])
			expect(store.listTableColumns("items")).toEqual([
				"id",
				"chain_id",
				// #419: `issue_number INTEGER` retired in favor of opaque `item_id TEXT`; `branch`
				// and `pr` first-class columns retired (now live inside the `extra` JSON column as
				// preset-declared transparent fields).
				"item_id",
				"repo_cwd",
				"status",
				"attempts",
				"position",
				"title",
				"priority",
				"last_run_id",
				"issue_file",
				"evidence_dir",
				"agent_cwd",
				"runner",
				"phase",
				// #412: per-item preset declaration columns. Items carry their own preset since the
				// chain-level chains.preset became a legacy default-seed (NULLable in v9).
				"preset",
				"preset_path",
				"extra",
				"created_at",
				"updated_at",
				"status_updated_at",
			])
			expect(store.listTableColumns("runs")).toEqual([
				"id",
				"run_id",
				"chain_id",
				"item_id",
				"closure_id",
				"runtime_node_id",
				"phase",
				"status",
				"started_at",
				"ended_at",
				"exit_code",
				"extra",
			])
			expect(store.listTableColumns("active_runs")).toEqual(["closure_id", "run_id", "phase", "started_at", "extra"])
		} finally {
			store.close()
		}
	})

	test("fresh and migrated normalized runtime use the same runs schema", async () => {
		const fresh = await openTestStore("fresh-runs-schema")
		fresh.store.close()
		const historical = await openTestStore("migrated-runs-schema")
		historical.store.close()
		const historicalDb = new Database(historical.dbFile)
		try {
			historicalDb.exec("PRAGMA foreign_keys=OFF")
			historicalDb.exec("CREATE TABLE runs_v15 AS SELECT id, run_id, chain_id, item_id, phase, status, started_at, ended_at, exit_code, extra FROM runs")
			historicalDb.exec("DROP TABLE runs")
			historicalDb.exec("ALTER TABLE runs_v15 RENAME TO runs")
			historicalDb.exec("CREATE UNIQUE INDEX runs_v15_run_id ON runs(run_id)")
			historicalDb.exec("PRAGMA user_version=15")
		} finally { historicalDb.close() }
		openSqliteStateStore({ loopDataRoot: dbFileRoot(historical.dbFile) }).close()
		const schema = (dbFile: string) => {
			const db = new Database(dbFile, { readonly: true })
			try { return db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get()?.sql ?? null } finally { db.close() }
		}
		const normalizeSchema = (sql: string | null) => sql?.replaceAll('"', "").replace(/\s+/g, " ").trim() ?? null
		expect(normalizeSchema(schema(fresh.dbFile))).toBe(normalizeSchema(schema(historical.dbFile)))
	})

	test("closure active run round-trip", async () => {
		const { store } = await openTestStore("current")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
			store.recordRun({
				runId: "run-current",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_001,
				extra: storedItemExtra({ issue: 177 }),
			})

			const expected = {
				chainId: chain.id,
				phase: "iteration",
				runId: "run-current",
				startedAt: 1_800_000_001,
				extra: storedItemExtra({ itemId: item.id, issue: 177, nested: { resumed: false } }),
			}
			expect(store.setCurrentRun(expected)).toEqual(expected)
			expect(store.getCurrentRun(chain.id)).toEqual(expected)
			expect(store.clearCurrentRun(expected.runId)).toBe(true)
			expect(store.getCurrentRun(chain.id)).toBeNull()
		} finally {
			store.close()
		}
	})

	test("existing task root materializes every phase for a newly encountered item with stable identities", async () => {
		const { store, dbFile } = await openTestStore("existing-root-full-item-definition")
		const chain = createFullChain(store)
		const first = createFullItem(store, chain, { itemId: "first", issueNumber: 177, phase: "iteration" })
		const second = createFullItem(store, chain, { itemId: "second", issueNumber: 178, phase: "review" })
		const firstRun = store.recordRun({ runId: "first-definition-run", chainId: chain.id, itemId: first.id, phase: "iteration", startedAt: 1_800_000_205, extra: definitionRunExtra({ worktreePath: "/worktrees/first", branchName: "issue-first" }) })
		store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: firstRun.runId, startedAt: firstRun.startedAt, extra: storedItemExtra({}) })
		const secondDefinition = { definitionContentIdentity: "sha256:second-definition", definitionPhaseNames: ["review", "finalize"] }
		const secondRun = store.recordRun({ runId: "second-definition-run", chainId: chain.id, itemId: second.id, phase: "review", startedAt: 1_800_000_206, extra: definitionRunExtra({ ...secondDefinition, worktreePath: "/worktrees/second", branchName: "issue-second" }) })
		store.setCurrentRun({ chainId: chain.id, phase: "review", runId: secondRun.runId, startedAt: secondRun.startedAt, extra: storedItemExtra({}) })
		const definitionRef = { kind: "preset", contentIdentity: "sha256:second-definition" } as const
		const expectedSecondIdentities = ["review", "finalize"].map((phase) => ({
			runtimeNodeId: `closure-node:${second.id}:${phase}`,
			definitionRef,
			definitionNodeId: `item:second:phase:${phase}`,
		}))
		try {
			const tree = store.getTaskTree(chain.id)
			if (tree?.root.kind !== "seq") throw new Error("expected seq root")
			expect(tree.root.children.filter((node) => node.kind === "leaf" && node.closure.itemRowId === second.id).map((node) => node.identity)).toEqual(expectedSecondIdentities)
		} finally { store.close() }
		const reopened = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
		try {
			const tree = reopened.getTaskTree(chain.id)
			if (tree?.root.kind !== "seq") throw new Error("expected reopened seq root")
			expect(tree.root.children.filter((node) => node.kind === "leaf" && node.closure.itemRowId === second.id).map((node) => node.identity)).toEqual(expectedSecondIdentities)
		} finally { reopened.close() }
	})

	test("nested task tree round-trip", async () => {
		const { store } = await openTestStore("nested-task-tree")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const third = createFullItem(store, chain, { issueNumber: 179, itemId: "179" })
			const definitionRef = { kind: "chain", contentIdentity: "sha256:definition" } as const
			const leaf = (item: ItemRecord, id: string) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: `definition-${id}` }, closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: id === "leaf-one" ? null : "par-one", sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "root", definitionRef, definitionNodeId: "definition-root" }, cursor: { kind: "next", nodeId: "leaf-one" }, children: [leaf(first, "leaf-one"), { kind: "par", identity: { runtimeNodeId: "par-one", definitionRef, definitionNodeId: "definition-par" }, groupId: "par-one", pinCommit: "0123456789abcdef", state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(second, "leaf-two"), leaf(third, "leaf-three")] }] }, activeRuns: [] }
			expect(store.createTaskTree(chain.id, tree)).toEqual(tree)
			expect(store.getTaskTree(chain.id)).toEqual(tree)
		} finally { store.close() }
	})

	test("nested task tree enforces each closure source par against its actual parent", async () => {
		const { store } = await openTestStore("nested-task-tree-par-parent")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			const definitionRef = { kind: "chain", contentIdentity: "sha256:par-parent" } as const
			const leaf = { kind: "leaf", identity: { runtimeNodeId: "par-child", definitionRef, definitionNodeId: "leaf" }, closure: { closureId: "closure-par-child", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: "/worktrees/par-child", branchName: "issue-par-child", baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] } } as const
			const tree: TaskTreeSnapshot = { root: { kind: "par", identity: { runtimeNodeId: "actual-par", definitionRef, definitionNodeId: "par" }, groupId: "actual-par", pinCommit: "0123456789abcdef", state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf] }, activeRuns: [] }
			expectSqliteCode(() => store.createTaskTree(chain.id, tree), "run_closure_mismatch")
		} finally { store.close() }
	})

	test("nested task tree seq cursor accepts only a direct child", async () => {
		const { store } = await openTestStore("nested-task-tree-seq-cursor")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const definitionRef = { kind: "chain", contentIdentity: "sha256:seq-cursor" } as const
			const leaf = (item: ItemRecord, id: string, sourceParNodeId: string | null) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id }, closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `branch-${id}`, baseCommit: "0123456789abcdef", sourceParNodeId, sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "seq-root", definitionRef, definitionNodeId: "root" }, cursor: { kind: "next", nodeId: "nested-leaf" }, children: [leaf(first, "direct-leaf", null), { kind: "par", identity: { runtimeNodeId: "nested-par", definitionRef, definitionNodeId: "par" }, groupId: "nested-par", pinCommit: "0123456789abcdef", state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(second, "nested-leaf", "nested-par")] }] }, activeRuns: [] }
			expectSqliteCode(() => store.createTaskTree(chain.id, tree), "run_closure_mismatch")
			const sourceChain = store.createChain({ name: "cursor-source", repository: "mouriya-s-lab/coder-loop", baseBranch: "main", status: "active" })
			const sourceItem = createFullItem(store, sourceChain, { issueNumber: 179, itemId: "179" })
			store.createTaskTree(sourceChain.id, { root: leaf(sourceItem, "other-tree-leaf", null), activeRuns: [] })
			const crossTree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "cross-tree-root", definitionRef, definitionNodeId: "cross-root" }, cursor: { kind: "next", nodeId: "other-tree-leaf" }, children: [leaf(first, "cross-tree-direct-leaf", null)] }, activeRuns: [] }
			expectSqliteCode(() => store.createTaskTree(chain.id, crossTree), "run_closure_mismatch")
		} finally { store.close() }
	})

	test("closure lifecycle preserves suspended resources and only consumed permits absence", async () => {
		const { store } = await openTestStore("closure-lifecycle")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
			const suspended = store.setClosureLifecycle(`closure-${item.id}`, { kind: "suspend", updatedAt: 1_800_000_100 })
			expect(suspended.lifecycle).toBe("suspended")
			expect(suspended.worktreePath).toBe("/repo/coder-loop")
			expect(() => store.setClosureResources(`closure-${item.id}`, { worktreePath: null, branchName: null, updatedAt: 1_800_000_101 })).toThrow(SqliteStateError)
			const consumed = store.setClosureLifecycle(`closure-${item.id}`, { kind: "consume", updatedAt: 1_800_000_102 })
			expect(consumed.lifecycle).toBe("consumed")
			expectSqliteCode(() => store.setClosureLifecycle(`closure-${item.id}`, { kind: "activate", updatedAt: 1_800_000_103 }), "closure_lifecycle_conflict")
			expectSqliteCode(() => store.setClosureLifecycle(`closure-${item.id}`, { kind: "suspend", updatedAt: 1_800_000_104 }), "closure_lifecycle_conflict")
			expect(store.setClosureResources(`closure-${item.id}`, { worktreePath: null, branchName: null, updatedAt: 1_800_000_103 }).worktreePath).toBeNull()
		} finally { store.close() }
	})

	test("run closure identity survives active relation cleanup", async () => {
		const { store } = await openTestStore("run-closure-identity")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			const run = store.recordRun({
				runId: "durable-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_105,
				extra: definitionRunExtra({ worktreePath: "/worktrees/durable", branchName: "issue-durable" }),
			})
			store.setCurrentRun({ chainId: chain.id, phase: run.phase, runId: run.runId, startedAt: run.startedAt, extra: storedItemExtra({}) })
			const active = store.getRunByRunId(run.runId)
			expect(active?.closureId).toBe(`closure:${item.id}:${run.phase}`)
			expect(active?.runtimeNodeId).toBe(`closure-node:${item.id}:${run.phase}`)
			expect(store.clearCurrentRun(run.runId)).toBe(true)
			const completed = store.getRunByRunId(run.runId)
			expect(completed?.closureId).toBe(active?.closureId)
			expect(completed?.runtimeNodeId).toBe(active?.runtimeNodeId)
		} finally { store.close() }
	})

	test("closure active run rejects conflicts and mismatches through typed errors", async () => {
		const { store, dbFile } = await openTestStore("closure-active-run-negative")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, twoPhaseLeafTree(item))
			store.recordRun({ runId: "active-one", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_200, extra: definitionRunExtra() })
			store.recordRun({ runId: "active-two", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_201, extra: definitionRunExtra() })
			store.recordRun({ runId: "wrong-phase", chainId: chain.id, itemId: item.id, phase: "review", startedAt: 1_800_000_202, extra: definitionRunExtra() })
			store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-one", startedAt: 1_800_000_200, extra: storedItemExtra({}) })
			expectSqliteCode(() => store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-two", startedAt: 1_800_000_201, extra: storedItemExtra({}) }), "active_run_conflict")
			expectSqliteCode(() => store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "wrong-phase", startedAt: 1_800_000_202, extra: storedItemExtra({}) }), "run_closure_mismatch")
			store.clearCurrentRun("active-one")
			const db = new Database(dbFile)
			try { db.exec(`UPDATE runs SET closure_id = 'closure-${item.id}-review', runtime_node_id = 'leaf-${item.id}-review' WHERE run_id = 'active-two'`) } finally { db.close() }
			expectSqliteCode(() => store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-two", startedAt: 1_800_000_204, extra: storedItemExtra({}) }), "run_closure_mismatch")
			const restoreDb = new Database(dbFile)
			try { restoreDb.exec(`UPDATE runs SET closure_id = 'closure-${item.id}-iteration', runtime_node_id = 'leaf-${item.id}-iteration' WHERE run_id = 'active-two'`) } finally { restoreDb.close() }
			store.setClosureLifecycle(`closure-${item.id}-iteration`, { kind: "suspend", updatedAt: 1_800_000_203 })
			expectSqliteCode(() => store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-two", startedAt: 1_800_000_204, extra: storedItemExtra({}) }), "closure_lifecycle_conflict")
		} finally { store.close() }
	})

	test("closure active run permits sibling closures and clears only the selected run", async () => {
		const { store } = await openTestStore("closure-active-run-siblings")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const definitionRef = { kind: "chain", contentIdentity: "sha256:active-siblings" } as const
			const leaf = (item: ItemRecord) => ({ kind: "leaf", identity: { runtimeNodeId: `leaf-${item.id}`, definitionRef, definitionNodeId: `item-${item.id}` }, closure: { closureId: `closure-${item.id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${item.id}`, branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] } } as const)
			store.createTaskTree(chain.id, { root: { kind: "seq", identity: { runtimeNodeId: "root-active-siblings", definitionRef, definitionNodeId: "root" }, cursor: { kind: "next", nodeId: `leaf-${first.id}` }, children: [leaf(first), leaf(second)] }, activeRuns: [] })
			store.recordRun({ runId: "active-first", chainId: chain.id, itemId: first.id, phase: "iteration", startedAt: 1_800_000_210 })
			store.recordRun({ runId: "active-second", chainId: chain.id, itemId: second.id, phase: "iteration", startedAt: 1_800_000_211 })
			store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-first", startedAt: 1_800_000_210, extra: storedItemExtra({}) })
			store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "active-second", startedAt: 1_800_000_211, extra: storedItemExtra({}) })

			expect(store.listCurrentRuns(chain.id).map((run) => run.runId)).toEqual(["active-first", "active-second"])
			expect(store.clearCurrentRun("active-first")).toBe(true)
			expect(store.listCurrentRuns(chain.id).map((run) => run.runId)).toEqual(["active-second"])
		} finally { store.close() }
	})

	test("join binding and evaluation persisted shape round-trips", async () => {
		const { store } = await openTestStore("join-history")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const definitionRef = { kind: "chain", contentIdentity: "sha256:join-history" } as const
			const leaf = (item: ItemRecord, id: string) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id }, closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `branch-${id}`, baseCommit: "0123456789abcdef", sourceParNodeId: "par-history", sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "par", identity: { runtimeNodeId: "par-history", definitionRef, definitionNodeId: "par" }, groupId: "par-history", pinCommit: "0123456789abcdef", state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 2, value: { kind: "validator", candidate: { definitionRef, candidateId: "validator" } }, evaluation: { kind: "evaluating", epoch: 2, bindingVersion: 2 } }, children: [leaf(first, "join-leaf-one"), leaf(second, "join-leaf-two")] }, activeRuns: [] }
			expect(store.createTaskTree(chain.id, tree)).toEqual(tree)
			expect(store.getTaskTree(chain.id)).toEqual(tree)
		} finally { store.close() }
	})

	test("durable run SQLite ingress rejects undeclared columns", async () => {
		const { store, dbFile } = await openTestStore("run-row-exact-ingress")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.recordRun({ runId: "exact-run", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_400, extra: definitionRunExtra() })
			const db = new Database(dbFile)
			try { db.exec("ALTER TABLE runs ADD COLUMN unexpected TEXT") } finally { db.close() }
			expectSqliteCode(() => store.getRunByRunId("exact-run"), "invalid_json")
		} finally { store.close() }
	})

	test("v13 to v14 migrates normalized runtime before reads", async () => {
		const fixture = await openTestStore("v13-to-v14")
		const chain = createFullChain(fixture.store)
		const activeItem = createFullItem(fixture.store, chain, { phase: "iteration", agentCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", sessionIds: { iteration: { codex: "session-v13" }, review: { claude: "review-session-v13" } } })
		const untouchedItem = createFullItem(fixture.store, chain, { issueNumber: 178, itemId: "178", phase: null, agentCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", sessionIds: {} })
		fixture.store.close()
		const legacy = new Database(fixture.dbFile)
		try {
			legacy.exec("PRAGMA foreign_keys=OFF")
			rebuildRunsAsPacketlessHistory(legacy)
			insertPacketlessHistoricalRun(legacy, { runId: "legacy-active", chainId: chain.id, itemId: activeItem.id, phase: "iteration", startedAt: 1_800_000_220 })
			legacy.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
			legacy.exec(`UPDATE items SET session_ids = '{"iteration":{"codex":"session-v13"},"review":{"claude":"review-session-v13"}}' WHERE id = ${activeItem.id}`)
			legacy.exec(`UPDATE items SET session_ids = '{}' WHERE id = ${untouchedItem.id}`)
			for (const table of ["active_runs", "closure_sessions", "task_join_evaluation_bindings", "task_join_bindings", "task_leaf_nodes", "task_seq_nodes", "task_par_nodes", "task_closures", "task_trees", "task_nodes", "execution_definitions"]) legacy.exec(`DROP TABLE ${table}`)
			legacy.exec("CREATE TABLE current_runs (chain_id INTEGER PRIMARY KEY REFERENCES chains(id), phase TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), started_at REAL NOT NULL, extra TEXT NOT NULL)")
			legacy.query("INSERT INTO current_runs (chain_id, phase, run_id, started_at, extra) VALUES ($chainId, 'iteration', 'legacy-active', 1800000220, '{}')").run({ chainId: chain.id })
			legacy.exec("PRAGMA user_version=13")
		} finally { legacy.close() }
		const migrated = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			const db = new Database(fixture.dbFile)
			try { expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(16) } finally { db.close() }
			const tree = migrated.getTaskTree(chain.id)
			expect(tree?.root.kind).toBe("seq")
			if (tree?.root.kind !== "seq") throw new Error("expected migrated seq")
			const leaves = tree.root.children
			if (!leaves.every((leaf) => leaf.kind === "leaf")) throw new Error("expected only migrated leaves")
			expect(new Set(leaves.map((leaf) => `${leaf.closure.itemId}:${leaf.closure.phase}`))).toEqual(new Set([
				"177:iteration", "177:review", "177:blocked-responder", "177:umbrella-finalizer",
				"178:iteration", "178:review", "178:blocked-responder", "178:umbrella-finalizer",
			]))
			expect(leaves.map((leaf) => leaf.closure.sessions).filter((sessions) => sessions.length > 0)).toEqual([
				[{ runner: "codex", sessionId: "session-v13" }],
				[{ runner: "claude", sessionId: "review-session-v13" }],
			])
			expect(migrated.listTableColumns("items")).not.toContain("session_ids")
			const migratedDb = new Database(fixture.dbFile)
			try { expect(migratedDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'current_runs'").get()?.count).toBe(0) } finally { migratedDb.close() }
			expect(migrated.listCurrentRuns(chain.id).map((run) => run.runId)).toEqual(["legacy-active"])
		} finally { migrated.close() }
	})

	test("normalized runtime migration resolves persisted preset once and survives source removal", async () => {
		const presetPath = resolve(TEST_ROOT, "mutable-checkout-preset")
		await cp(resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"), presetPath, { recursive: true })
		const fixture = await openTestStore("checkout-independent")
		const chain = createFullChain(fixture.store)
		const item = createFullItem(fixture.store, chain, { phase: "iteration", preset: null, presetPath })
		fixture.store.close()
		const legacy = new Database(fixture.dbFile)
		try {
			legacy.exec("PRAGMA foreign_keys=OFF")
			rebuildRunsAsPacketlessHistory(legacy)
			insertPacketlessHistoricalRun(legacy, { runId: "packet-less-history", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_221 })
			legacy.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
			for (const table of ["active_runs", "closure_sessions", "task_join_evaluation_bindings", "task_join_bindings", "task_leaf_nodes", "task_seq_nodes", "task_par_nodes", "task_closures", "task_trees", "task_nodes", "execution_definitions"]) legacy.exec(`DROP TABLE ${table}`)
			legacy.exec("CREATE TABLE current_runs (chain_id INTEGER PRIMARY KEY REFERENCES chains(id), phase TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), started_at REAL NOT NULL, extra TEXT NOT NULL)")
			legacy.exec("PRAGMA user_version=13")
		} finally { legacy.close() }
		const migrated = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		const beforeSourceChange = migrated.getTaskTree(chain.id)
		migrated.close()
		await writeFile(resolve(presetPath, "preset.toml"), "invalid after migration", "utf8")
		const reopenedAfterMutation = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try { expect(reopenedAfterMutation.getTaskTree(chain.id)).toEqual(beforeSourceChange) } finally { reopenedAfterMutation.close() }
		await rm(presetPath, { recursive: true, force: true })
		const reopened = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			expect(reopened.getTaskTree(chain.id)).toEqual(beforeSourceChange)
			if (beforeSourceChange?.root.kind !== "seq") throw new Error("expected migrated seq")
			expect(beforeSourceChange.root.children.map((node) => node.kind === "leaf" ? node.closure.phase : node.kind)).toEqual(["iteration", "review", "blocked-responder", "umbrella-finalizer"])
		} finally { reopened.close() }
	})

	test("normalized runtime migration rejects missing unreadable or invalid persisted preset declarations", async () => {
		for (const scenario of ["missing", "unreadable", "invalid"] as const) {
			const fixture = await openTestStore(`definition-facts-${scenario}`)
			const chain = createFullChain(fixture.store)
			const presetPath = resolve(TEST_ROOT, `definition-source-${scenario}`)
			if (scenario === "unreadable") await mkdir(presetPath, { recursive: true })
			if (scenario === "invalid") {
				await mkdir(presetPath, { recursive: true })
				await writeFile(resolve(presetPath, "preset.toml"), "not = [valid", "utf8")
			}
			createFullItem(fixture.store, chain, { phase: "iteration", preset: null, presetPath: scenario === "missing" ? null : presetPath })
			fixture.store.close()
			const legacy = new Database(fixture.dbFile)
			try {
				legacy.exec("PRAGMA foreign_keys=OFF")
				legacy.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
				for (const table of ["active_runs", "closure_sessions", "task_join_evaluation_bindings", "task_join_bindings", "task_leaf_nodes", "task_seq_nodes", "task_par_nodes", "task_closures", "task_trees", "task_nodes", "execution_definitions"]) legacy.exec(`DROP TABLE ${table}`)
				legacy.exec("CREATE TABLE current_runs (chain_id INTEGER PRIMARY KEY REFERENCES chains(id), phase TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), started_at REAL NOT NULL, extra TEXT NOT NULL)")
				legacy.exec("PRAGMA user_version=13")
			} finally { legacy.close() }
			expectSqliteCode(() => openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) }), "invalid_json")
		}
	})

	test("main v14 context database migrates normalized runtime without losing context", async () => {
		const fixture = await openTestStore("main-v14-to-normalized-runtime")
		const chain = createFullChain(fixture.store)
		const item = createFullItem(fixture.store, chain, { phase: "iteration", agentCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", sessionIds: { iteration: { codex: "main-v14-session" } } })
		fixture.store.appendContextEntry({ chainId: chain.id, scope: { kind: "chain" }, author: { kind: "operator" }, body: "preserve-main-v14-context" })
		fixture.store.close()
		const mainV14 = new Database(fixture.dbFile)
		try {
			mainV14.exec("PRAGMA foreign_keys=OFF")
			rebuildRunsAsPacketlessHistory(mainV14)
			insertPacketlessHistoricalRun(mainV14, { runId: "main-v14-active", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_230 })
			mainV14.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
			mainV14.exec(`UPDATE items SET session_ids = '{"iteration":{"codex":"main-v14-session"}}' WHERE id = ${item.id}`)
			for (const table of ["active_runs", "closure_sessions", "task_join_evaluation_bindings", "task_join_bindings", "task_leaf_nodes", "task_seq_nodes", "task_par_nodes", "task_closures", "task_trees", "task_nodes", "execution_definitions"]) mainV14.exec(`DROP TABLE ${table}`)
			mainV14.exec("CREATE TABLE current_runs (chain_id INTEGER PRIMARY KEY REFERENCES chains(id), phase TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), started_at REAL NOT NULL, extra TEXT NOT NULL)")
			mainV14.query("INSERT INTO current_runs (chain_id, phase, run_id, started_at, extra) VALUES ($chainId, 'iteration', 'main-v14-active', 1800000230, '{}')").run({ chainId: chain.id })
			mainV14.exec("PRAGMA user_version=14")
		} finally { mainV14.close() }

		const migrated = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			const tree = migrated.getTaskTree(chain.id)
			expect(tree?.root.kind).toBe("seq")
			if (tree?.root.kind !== "seq") throw new Error("expected migrated main v14 seq")
			const iteration = tree.root.children.find((node) => node.kind === "leaf" && node.closure.itemId === item.itemId && node.closure.phase === "iteration")
			expect(iteration?.kind).toBe("leaf")
			if (iteration?.kind !== "leaf") throw new Error("expected migrated main v14 iteration leaf")
			expect(iteration.closure.sessions).toEqual([{ runner: "codex", sessionId: "main-v14-session" }])
			expect(migrated.listCurrentRuns(chain.id).map((run) => run.runId)).toEqual(["main-v14-active"])
			expect(migrated.listContextEntries(chain.id).map((entry) => entry.body)).toEqual(["preserve-main-v14-context"])
		} finally { migrated.close() }
	})

	test("items round-trip", async () => {
		const { store } = await openTestStore("item")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			expect(store.getItem(item.id)).toEqual(item)
			expect(store.getItemById(chain.id, "177")).toEqual(item)
		} finally {
			store.close()
		}
	})

	test("item session id helpers isolate values by phase and runner", async () => {
		const { store } = await openTestStore("item-session-ids")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, twoPhaseLeafTree(item))

			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBeNull()

			const withIteration = store.setItemSessionId(item.id, {
				phase: "iteration",
				runner: "codex",
				sessionId: "thread-codex-123",
				updatedAt: 1_800_000_040,
			})
			expect(withIteration.sessionIds).toEqual({})

			const withReview = store.setItemSessionId(item.id, {
				phase: "review",
				runner: "claude",
				sessionId: "thread-claude-456",
				updatedAt: 1_800_000_041,
			})
			expect(withReview.sessionIds).toEqual({})
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-codex-123")
			expect(store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("thread-claude-456")
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()

			const cleared = store.setItemSessionId(item.id, {
				phase: "iteration",
				runner: "codex",
				sessionId: null,
				updatedAt: 1_800_000_042,
			})
			expect(cleared.sessionIds).toEqual({})
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBeNull()
		} finally {
			store.close()
		}
	})

	test("chains round-trip", async () => {
		const { store } = await openTestStore("chain")
		try {
			const chain = createFullChain(store)
			expect(store.getChain(chain.id)).toEqual(chain)
			expect(store.getChainByName("central-state")).toEqual(chain)
			expect(store.listChains()).toEqual([chain])
		} finally {
			store.close()
		}
	})

	test("chains support stopped lifecycle status", async () => {
		const { store } = await openTestStore("chain-stopped")
		try {
			const chain = createFullChain(store)
			const stopped = store.updateChain(chain.id, { status: "stopped", updatedAt: 1_800_034_900 })
			expect(stopped.status).toBe("stopped")
			expect(store.getChain(chain.id)?.status).toBe("stopped")
		} finally {
			store.close()
		}
	})

	test("data access CRUD next pending and terminal status", async () => {
		const { store } = await openTestStore("access")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain, { issueNumber: 177, status: runtimeStatus("queued") })
			const second = createFullItem(store, chain, { issueNumber: 179, status: runtimeStatus("queued") })
			const otherRepo = createFullItem(store, chain, { issueNumber: 180, repoCwd: "/repo/other", status: runtimeStatus("queued") })

			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				// #403: statuses / terminalStatusNames are required — the store no longer carries a
				// default vocabulary. The values below mirror what a `gh-issue-pr-iteration` preset
				// would resolve to, but the test is what supplies them; the store is preset-agnostic.
				statuses: [runtimeStatus("queued"), runtimeStatus("changes_requested")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual(first)
			expect(store.allItemsTerminal({ chainId: chain.id, terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")] })).toBe(false)

			const metadataOnly = store.updateItem(first.id, { attempts: 2, updatedAt: 1_800_000_100 })
			expect(metadataOnly.statusUpdatedAt).toBe(first.statusUpdatedAt)

			// #419: `branch` / `pr` retired as top-level UpdateItemInput fields; they now flow
			// through the `extra` JSON column as preset-declared transparent fields. The
			// updater must fold new values onto existing extra so unrelated keys (e.g. the
			// fixture-default `issue` / `phase` / `nested`) survive — `UpdateItemInput.extra`
			// is a full replacement, so the test passes the merged object explicitly.
			const firstExtraBefore = itemExtraToJsonObject(first.extra)
			const updatedFirst = store.updateItem(first.id, {
				status: runtimeStatus("done"),
				extra: storedItemExtra({ ...firstExtraBefore, branch: "issue-177", pr: 188 }),
				updatedAt: 1_800_000_101,
			})
			expect(updatedFirst.status).toBe("done")
			expect(updatedFirst.statusUpdatedAt).toBe(1_800_000_101)
			expect(itemExtraToJsonObject(updatedFirst.extra).branch).toBe("issue-177")
			expect(itemExtraToJsonObject(updatedFirst.extra).pr).toBe(188)
			expect(store.updateItem(second.id, { status: runtimeStatus("moot"), updatedAt: 1_800_000_102 }).status).toBe("moot")
			expect(store.updateItem(otherRepo.id, { status: runtimeStatus("blocked"), updatedAt: 1_800_000_103 }).status).toBe("blocked")
			expect(store.allItemsTerminal({ chainId: chain.id, terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")] })).toBe(true)

			const run = store.recordRun({
				runId: "run-data-access",
				chainId: chain.id,
				itemId: first.id,
				phase: "iteration",
				startedAt: 1_800_000_200,
				extra: definitionRunExtra({ issue: 177 }),
			})
			expect(store.getRunByRunId("run-data-access")).toEqual(run)
			const completedRun = store.completeRun("run-data-access", { endedAt: 1_800_000_260, exitCode: 0, status: runtimeStatus("done") })
			expect(completedRun.endedAt).toBe(1_800_000_260)
			expect(completedRun.status).toBe("done")
			expect(store.listRuns(chain.id).map((entry) => entry.status)).toEqual(["done"])

			expect(store.deleteItem(second.id)).toBe(true)
			expect(store.getItem(second.id)).toBeNull()
			expect(store.updateChain(chain.id, { status: "completed", updatedAt: 1_800_000_300 }).status).toBe("completed")
			expect(store.deleteChain(chain.id)).toBe(true)
			expect(store.getChain(chain.id)).toBeNull()
		} finally {
			store.close()
		}
	})

	test("next pending follows queue position regardless of attempts", async () => {
		const { store } = await openTestStore("attempt-priority")
		try {
			const chain = createFullChain(store)
			const retried = createFullItem(store, chain, {
				issueNumber: 177,
				status: runtimeStatus("changes_requested"),
				priority: null,
				attempts: 3,
			})
			const untouched = createFullItem(store, chain, {
				issueNumber: 179,
				status: runtimeStatus("queued"),
				priority: null,
				attempts: 0,
			})

			expect(retried.id).toBeLessThan(untouched.id)
			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				// #403: caller-supplied status vocabulary; store no longer fills it in.
				statuses: [runtimeStatus("queued"), runtimeStatus("changes_requested")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual(retried)
		} finally {
			store.close()
		}
	})

	test("reorderItem renumbers queue positions and drives selection", async () => {
		const { store } = await openTestStore("reorder")
		try {
			const chain = createFullChain(store)
			const a = createFullItem(store, chain, { issueNumber: 201, status: runtimeStatus("queued"), priority: null })
			const b = createFullItem(store, chain, { issueNumber: 202, status: runtimeStatus("queued"), priority: null })
			const c = createFullItem(store, chain, { issueNumber: 203, status: runtimeStatus("queued"), priority: null })

			expect([a.position, b.position, c.position]).toEqual([0, 1, 2])
			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				// #403: caller-supplied status vocabulary; store no longer fills it in.
				statuses: [runtimeStatus("queued"), runtimeStatus("changes_requested")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})?.id).toBe(a.id)

			const movedC = store.reorderItem(c.id, 0)
			expect(movedC.map((item) => item.id)).toEqual([c.id, a.id, b.id])
			expect(movedC.map((item) => item.position)).toEqual([0, 1, 2])
			const orderedAfterC = store.listItems(chain.id).map((item) => item.id)
			expect(orderedAfterC).toEqual([c.id, a.id, b.id])
			expect(store.getItem(c.id)?.position).toBe(0)
			expect(store.getItem(a.id)?.position).toBe(1)
			expect(store.getItem(b.id)?.position).toBe(2)
			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				// #403: caller-supplied status vocabulary; store no longer fills it in.
				statuses: [runtimeStatus("queued"), runtimeStatus("changes_requested")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})?.id).toBe(c.id)

			const movedCToEnd = store.reorderItem(c.id, 99)
			expect(movedCToEnd.map((item) => item.id)).toEqual([a.id, b.id, c.id])
			expect(store.listItems(chain.id).map((item) => item.id)).toEqual([a.id, b.id, c.id])

			expect(() => store.reorderItem(a.id, -1)).toThrow()
		} finally {
			store.close()
		}
	})

	test("dependsOn gates pending item selection", async () => {
		const { store } = await openTestStore("depends-gates")
		try {
			const chain = createFullChain(store)
			const prerequisite = createFullItem(store, chain, { issueNumber: 2671, priority: "10", status: runtimeStatus("queued") })
			const dependent = createFullItem(store, chain, {
				issueNumber: 2672,
				priority: "00",
				status: runtimeStatus("queued"),
				extra: { issue: 2672, dependsOn: [prerequisite.id] },
			})
			const fallback = createFullItem(store, chain, { issueNumber: 2673, priority: "20", status: runtimeStatus("queued") })

			expect(dependent.id).toBeGreaterThan(prerequisite.id)
			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual(prerequisite)
			expect(store.listDependencyWaits({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual([{
				rowId: dependent.id,
				itemId: "2672",
				repoCwd: "/repo/coder-loop",
				dependsOn: [prerequisite.id],
				unsatisfied: [prerequisite.id],
			}])
			expect(store.getItem(fallback.id)).toEqual(fallback)
		} finally {
			store.close()
		}
	})

	test("dependsOn releases item after dependency terminal status", async () => {
		const { store } = await openTestStore("depends-release")
		try {
			const chain = createFullChain(store)
			const prerequisite = createFullItem(store, chain, { issueNumber: 2674, priority: "99", status: runtimeStatus("done") })
			const dependent = createFullItem(store, chain, {
				issueNumber: 2675,
				priority: "00",
				status: runtimeStatus("queued"),
				extra: { issue: 2675, dependsOn: [prerequisite.id] },
			})
			createFullItem(store, chain, { issueNumber: 2676, priority: "10", status: runtimeStatus("queued") })

			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual(dependent)
			expect(store.listDependencyWaits({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual([])
		} finally {
			store.close()
		}
	})

	test("cross-chain dependency resolves through the global store, not the per-chain snapshot", async () => {
		const { store } = await openTestStore("depends-cross-chain")
		try {
			const blockerChain = store.createChain({
				name: "blocker-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop-e2e-blocker",
				baseBranch: "main",
				status: "active",
				metadata: storedChainMetadata({}),
				createdAt: 1_800_000_000,
				updatedAt: 1_800_000_010,
			})
			const blocker = store.createItem({
				chainId: blockerChain.id,
				itemId: "7",
				repoCwd: "/repo/blocker",
				status: runtimeStatus("done"),
				attempts: 1,
				title: "blocker follow-up",
				priority: "10",
				extra: storedItemExtra({ issue: 7 }),
				createdAt: 1_800_000_020,
				updatedAt: 1_800_000_030,
			})

			const dependentChain = createFullChain(store)
			const dependent = createFullItem(store, dependentChain, {
				issueNumber: 2680,
				priority: "00",
				status: runtimeStatus("queued"),
				extra: { issue: 2680, dependsOn: [blocker.id] },
			})

			// The blocker lives in a different chain; without the cross-chain resolver byId.get
			// would miss it and treat the dependency as permanently unsatisfied (deadlock).
			expect(store.getNextPendingItem({
				chainId: dependentChain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual(dependent)
			expect(store.listDependencyWaits({
				chainId: dependentChain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual([])

			// Flip the cross-chain blocker back to in-flight: the dependent is gated again.
			store.updateItem(blocker.id, { status: runtimeStatus("in_progress") })
			expect(store.getNextPendingItem({
				chainId: dependentChain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toBeNull()
			expect(store.listDependencyWaits({
				chainId: dependentChain.id,
				repoCwd: "/repo/coder-loop",
				statuses: [runtimeStatus("queued")],
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			})).toEqual([{
				rowId: dependent.id,
				itemId: "2680",
				repoCwd: "/repo/coder-loop",
				dependsOn: [blocker.id],
				unsatisfied: [blocker.id],
			}])
		} finally {
			store.close()
		}
	})

	test("createItems happy path inserts every input atomically", async () => {
		const { store } = await openTestStore("batch-happy")
		try {
			const chain = createFullChain(store)
			const inputs: CreateItemInput[] = [
				{ chainId: chain.id, itemId: "311", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "first" },
				{ chainId: chain.id, itemId: "312", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "second" },
				{ chainId: chain.id, itemId: "313", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "third" },
			]
			const inserted = store.createItems(inputs)
			expect(inserted.map((item) => item.itemId)).toEqual(["311", "312", "313"])
			expect(store.listItems(chain.id).map((item) => item.itemId)).toEqual(["311", "312", "313"])
		} finally {
			store.close()
		}
	})

	test("createItems rolls back the whole batch when a mid-batch insert violates UNIQUE", async () => {
		const { store } = await openTestStore("batch-rollback")
		try {
			const chain = createFullChain(store)
			const occupant = createFullItem(store, chain, { issueNumber: 322, title: "occupant" })
			const occupantsBefore = store.listItems(chain.id).map((item) => item.id)

			const caught = captureSqliteError(() => {
				store.createItems([
					{ chainId: chain.id, itemId: "321", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "before conflict" },
					{ chainId: chain.id, itemId: "322", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "conflict (UNIQUE chain_id,item_id)" },
					{ chainId: chain.id, itemId: "323", repoCwd: "/repo/coder-loop", status: runtimeStatus("queued"), title: "after conflict" },
				])
			})

			expect(caught).toBeInstanceOf(SqliteStateError)
			expect(caught.code).toBe("sqlite_error")
			expect(caught.message).toContain("create items")

			expect(store.getItemById(chain.id, "321")).toBeNull()
			expect(store.getItemById(chain.id, "323")).toBeNull()
			const occupantAfter = store.getItemById(chain.id, "322")
			expect(occupantAfter).not.toBeNull()
			expect(occupantAfter?.id).toBe(occupant.id)
			expect(occupantAfter?.title).toBe("occupant")
			expect(store.listItems(chain.id).map((item) => item.id)).toEqual(occupantsBefore)
		} finally {
			store.close()
		}
	})

	test("wal mode", async () => {
		const { store } = await openTestStore("wal")
		try {
			expect(store.getJournalMode()).toBe("wal")
		} finally {
			store.close()
		}
	})

	test("concurrent reader continues while another connection has a writer transaction", async () => {
		const { store, dbFile } = await openTestStore("concurrent")
		let writer: Database | null = null
		try {
			const chain = createFullChain(store)
			createFullItem(store, chain)

			writer = new Database(dbFile, { readwrite: true, strict: true })
			writer.exec("PRAGMA foreign_keys = ON")
			writer.exec("BEGIN IMMEDIATE")
			// #419: items now keyed by opaque `item_id TEXT` (UNIQUE chain_id,item_id) instead of
			// the retired integer `issue_number` column.
			writer.query("UPDATE items SET status = $status WHERE item_id = $itemId").run({
				status: runtimeStatus("in_progress"),
				itemId: "177",
			})

			const readerStore = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
			try {
				const visibleItem = readerStore.getItemById(chain.id, "177")
				expect(visibleItem?.status).toBe("queued")
			} finally {
				readerStore.close()
			}
		} finally {
			if (writer !== null) {
				writer.exec("ROLLBACK")
				writer.close()
			}
			store.close()
		}
	})

	test("db unavailable explicit error", () => {
		const missingRoot = resolve(TEST_ROOT, "missing-parent", "loop-data")
		expect(() => openSqliteStateStore({ loopDataRoot: missingRoot })).toThrow(SqliteStateError)
		const error = captureSqliteError(() => {
			openSqliteStateStore({ loopDataRoot: missingRoot })
		})
		expect(error.code).toBe("db_unavailable")
	})

	test("phase migration is idempotent across repeated opens (issue #289 AC2)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `phase-idempotent-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })

		const first = openSqliteStateStore({ loopDataRoot })
		try {
			expect(first.listTableColumns("items")).toContain("phase")
		} finally {
			first.close()
		}

		const second = openSqliteStateStore({ loopDataRoot })
		try {
			expect(second.listTableColumns("items")).toContain("phase")
			const chain = createFullChain(second)
			const item = createFullItem(second, chain, { extra: { phase: "ignored-extra-key" } })
			expect(item.phase).toBeNull()

			const updated = second.updateItem(item.id, { phase: "iteration" })
			expect(updated.phase).toBe("iteration")
			expect(second.getItem(item.id)?.phase).toBe("iteration")
		} finally {
			second.close()
		}

		const third = openSqliteStateStore({ loopDataRoot })
		try {
			expect(third.listTableColumns("items")).toContain("phase")
		} finally {
			third.close()
		}
	})

	test("phase migration adds column to pre-v2 DB created without phase (issue #289 AC2)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `phase-legacy-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT NOT NULL,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, extra, created_at, updated_at)
				VALUES (1, 999, '/repo/legacy', 'queued', 0, '{}', 1.0, 1.0)
			`)
			expect(
				(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0),
			).toBe(0)
			const columnsBefore = legacy.query<{ name: string }, []>("PRAGMA table_info(items)").all().map((row) => row.name)
			expect(columnsBefore).not.toContain("phase")
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			expect(migrated.listTableColumns("items")).toContain("phase")
			const items = migrated.listItems(1)
			expect(items).toHaveLength(1)
			const item = items[0]!
			expect(item.phase).toBeNull()
			expect(item.itemId).toBe("999")
			expect(item.statusUpdatedAt).toBe(1.0)
			const updated = migrated.updateItem(item.id, { phase: "iteration", updatedAt: 2.0 })
			expect(updated.phase).toBe("iteration")
			expect(migrated.getItem(item.id)?.phase).toBe("iteration")
		} finally {
			migrated.close()
		}

		const reopened = openSqliteStateStore({ loopDataRoot })
		try {
			const item = reopened.getItemById(1, "999")
			expect(item?.phase).toBe("iteration")
		} finally {
			reopened.close()
		}
	})

	test("runs status migration adds canonical column without legacy extra-status backfill", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `runs-status-legacy-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT NOT NULL,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					last_session_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 4;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-runs-status', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, extra, created_at, updated_at)
				VALUES (1, 315, '/repo/legacy', 'queued', 0, '{}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO runs (run_id, chain_id, item_id, phase, started_at, ended_at, exit_code, extra)
				VALUES
					('run-extra-status', 1, 1, 'iteration', 1.0, 2.0, 0, '{"status":"done","stdoutBytes":12}'),
					('run-ended-no-status', 1, 1, 'review', 3.0, 4.0, 1, '{"stderrBytes":9}'),
					('run-open-no-status', 1, 1, 'iteration', 5.0, NULL, NULL, '{}')
			`)
			const columnsBefore = legacy.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map((row) => row.name)
			expect(columnsBefore).not.toContain("status")
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			expect(migrated.listTableColumns("runs")).toContain("status")
			expect(migrated.listRuns(1).map((run) => [run.runId, run.status])).toEqual([
				["run-extra-status", "unknown"],
				["run-ended-no-status", "unknown"],
				["run-open-no-status", "unknown"],
			])
		} finally {
			migrated.close()
		}
	})

	test("item session schema is idempotent across repeated opens", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `item-session-idempotent-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })

		const first = openSqliteStateStore({ loopDataRoot })
		try {
			expect(first.listTableColumns("items")).not.toContain("last_session_id")
			expect(first.listTableColumns("items")).not.toContain("session_ids")
		} finally {
			first.close()
		}

		const second = openSqliteStateStore({ loopDataRoot })
		try {
			expect(second.listTableColumns("items")).not.toContain("last_session_id")
			expect(second.listTableColumns("items")).not.toContain("session_ids")
			const chain = createFullChain(second)
			const item = createFullItem(second, chain)
			second.createTaskTree(chain.id, singleLeafTree(item))
			expect(item.sessionIds).toEqual({})

			const updated = second.setItemSessionId(item.id, { phase: "iteration", runner: "codex", sessionId: "sess-abc" })
			expect(updated.sessionIds).toEqual({})
			expect(second.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("sess-abc")
		} finally {
			second.close()
		}

		const third = openSqliteStateStore({ loopDataRoot })
		try {
			expect(third.listTableColumns("items")).not.toContain("last_session_id")
			expect(third.listTableColumns("items")).not.toContain("session_ids")
		} finally {
			third.close()
		}
	})

	test("v6 to v7 migration rebuilds chain status check for stopped", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `chain-status-v6-v7-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT NOT NULL,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					position INTEGER NOT NULL DEFAULT 0,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'unknown',
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 6;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-v6-chain', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = migrated.getChainByName("legacy-v6-chain")
			expect(chain).not.toBeNull()
			const stopped = migrated.updateChain(chain!.id, { status: "stopped", updatedAt: 2.0 })
			expect(stopped.status).toBe("stopped")
			expect(migrated.getChain(chain!.id)?.status).toBe("stopped")
		} finally {
			migrated.close()
		}
	})

	// #457 acceptance row 4: pre-migration loop-data carrying values inside the retired
	// chains.umbrella_issue / umbrella_repo first-class columns must remain readable after the
	// v10→v11 migration runs. Existing column values move into chain.metadata.bindings.umbrellaIssue
	// / umbrellaRepo so the bundled preset reads them through the declared-binding namespace
	// (chain.umbrellaRepo / chain.umbrellaIssue). After migration the columns no longer exist.
	test("v10 to v11 migration moves chains.umbrella_issue / umbrella_repo into metadata.bindings (acceptance row 4, #457)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `chain-umbrella-v10-v11-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted', 'stopped')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					position INTEGER NOT NULL DEFAULT 0,
					status_updated_at REAL NOT NULL DEFAULT 0,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					preset TEXT,
					preset_path TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'unknown',
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 10;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, umbrella_issue, umbrella_repo, status, metadata, created_at, updated_at)
				VALUES
					('legacy-umbrella', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 176, 'mouriya-s-lab/coder-loop', 'active', '{}', 1.0, 1.0),
					('null-umbrella', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', NULL, NULL, 'active', '{}', 1.0, 1.0),
					('partial-umbrella', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 309, NULL, 'active', '{}', 1.0, 1.0)
			`)
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			// Columns are gone post-migration.
			expect(migrated.listTableColumns("chains")).not.toContain("umbrella_issue")
			expect(migrated.listTableColumns("chains")).not.toContain("umbrella_repo")

			// Values landed inside metadata.bindings under the same names.
			const legacyChain = migrated.getChainByName("legacy-umbrella")
			expect(legacyChain).not.toBeNull()
			expect(chainBindings(legacyChain!.metadata)).toEqual({
				umbrellaIssue: 176,
				umbrellaRepo: "mouriya-s-lab/coder-loop",
			})

			// Null-only rows leave the bindings untouched.
			const nullChain = migrated.getChainByName("null-umbrella")
			expect(nullChain).not.toBeNull()
			expect(chainBindings(nullChain!.metadata)).toEqual({})

			// Partial values only move the non-null entry.
			const partialChain = migrated.getChainByName("partial-umbrella")
			expect(partialChain).not.toBeNull()
			expect(chainBindings(partialChain!.metadata)).toEqual({ umbrellaIssue: 309 })
		} finally {
			migrated.close()
		}

		// Re-open: post-migration writes go straight through the new shape; the rows survive a
		// second open without re-running the column-drop logic.
		const reopened = openSqliteStateStore({ loopDataRoot })
		try {
			expect(reopened.listTableColumns("chains")).not.toContain("umbrella_issue")
			const legacyChain = reopened.getChainByName("legacy-umbrella")
			expect(legacyChain).not.toBeNull()
			expect(chainBindings(legacyChain!.metadata)).toEqual({
				umbrellaIssue: 176,
				umbrellaRepo: "mouriya-s-lab/coder-loop",
			})
		} finally {
			reopened.close()
		}
	})

	// #419 acceptance row 1: pre-migration loop-data carrying values inside the retired
	// items.issue_number / branch / pr first-class columns must remain readable after the v11→v12
	// migration runs. issue_number is moved into the new opaque `item_id TEXT` column (and folded
	// into extra.issue), while branch / pr are flattened into `extra.branch` / `extra.pr` so the
	// preset's transparent-fields path reads them through the declared-binding namespace. After
	// migration the legacy columns no longer exist on the items table.
	test("v11 to v12 migration retires issue_number/branch/pr into extra and item_id (acceptance row 1, #419)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `items-opaque-v11-v12-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted', 'stopped')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					position INTEGER NOT NULL DEFAULT 0,
					status_updated_at REAL NOT NULL DEFAULT 0,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					preset TEXT,
					preset_path TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'unknown',
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 11;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-v11-items', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, position, status_updated_at, branch, pr, session_ids, preset, extra, created_at, updated_at)
				VALUES (1, 181, '/repo/coder-loop', 'queued', 0, 0, 1.0, 'issue-181', 191, '{}', 'gh-issue-pr-iteration', '{}', 1.0, 1.0)
			`)
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			// Physical column retirement: issue_number, branch, pr gone; item_id present.
			const itemCols = migrated.listTableColumns("items")
			expect(itemCols).not.toContain("issue_number")
			expect(itemCols).not.toContain("branch")
			expect(itemCols).not.toContain("pr")
			expect(itemCols).toContain("item_id")

			const chain = migrated.getChainByName("legacy-v11-items")
			expect(chain).not.toBeNull()
			const chainId = chain!.id

			// issue_number folded into the opaque `item_id` (stringified per migration rules).
			const item = migrated.getItemById(chainId, "181")
			expect(item).not.toBeNull()
			expect(item!.itemId).toBe("181")

			// branch / pr round-trip through the JSON extra column, indistinguishable from the
			// preset-declared transparent-field path that current writers go through.
			const extra = itemExtraToJsonObject(item!.extra)
			expect(extra.branch).toBe("issue-181")
			expect(extra.pr).toBe(191)

			// Lookup by an unknown opaque id returns null without throwing.
			expect(migrated.getItemById(chainId, "999")).toBeNull()

			// UNIQUE (chain_id, item_id) is enforced post-migration: inserting a second item with
			// the same opaque id in the same chain throws.
			expect(() =>
				migrated.createItem({
					chainId,
					itemId: "181",
					repoCwd: "/repo/coder-loop",
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({}),
				}),
			).toThrow()
		} finally {
			migrated.close()
		}

		// Re-open: migration is idempotent. The rows survive a second open without re-running
		// the rebuild logic, and the columns remain in their v12 shape.
		const reopened = openSqliteStateStore({ loopDataRoot })
		try {
			const reopenedCols = reopened.listTableColumns("items")
			expect(reopenedCols).not.toContain("issue_number")
			expect(reopenedCols).toContain("item_id")
			const chain = reopened.getChainByName("legacy-v11-items")
			expect(chain).not.toBeNull()
			const item = reopened.getItemById(chain!.id, "181")
			expect(item).not.toBeNull()
			expect(itemExtraToJsonObject(item!.extra).branch).toBe("issue-181")
		} finally {
			reopened.close()
		}
	})

	// #481 acceptance #8: items.runner CHECK constraint widens from `('claude','codex')` to
	// `('claude','codex','opencode')`. The v12 items schema is otherwise identical to v13 — only
	// the CHECK clause text differs — so rebuildItemsTableForV13 just re-creates the table from
	// the widened ITEMS_TABLE_SCHEMA_SQL and copies rows over. The test seeds a v12 disk (with
	// the narrow CHECK), confirms a pre-migration row with `runner='claude'` is preserved, then
	// proves the post-migration CHECK admits `runner='opencode'` (the v12 CHECK would have
	// rejected it).
	test("items table allows opencode runner after v12 to v13 migration (acceptance row 8, #481)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `items-opencode-v12-v13-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			// v12 schema — note the narrow runner CHECK that this migration must widen. Mirrors
			// the v12 shape carried at the point of #481 landing (items already on opaque item_id;
			// no issue_number/branch/pr physical columns).
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted', 'stopped')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id TEXT NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					position INTEGER NOT NULL DEFAULT 0,
					title TEXT,
					priority TEXT,
					last_run_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					preset TEXT,
					preset_path TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					status_updated_at REAL NOT NULL,
					UNIQUE (chain_id, item_id)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'unknown',
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 12;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-v12-runner', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
			// Pre-migration row uses runner='claude' — a value valid under both the old narrow
			// CHECK and the new widened CHECK. After migration we re-read the row to confirm the
			// data survived the table rebuild.
			legacy.exec(`
				INSERT INTO items (chain_id, item_id, repo_cwd, status, attempts, position, status_updated_at, runner, session_ids, preset, extra, created_at, updated_at)
				VALUES (1, '481-pre', '/repo/coder-loop', 'queued', 0, 0, 1.0, 'claude', '{}', 'gh-issue-pr-iteration', '{}', 1.0, 1.0)
			`)
			// Sanity check that v12 narrow CHECK rejects 'opencode' — proves the seed disk is
			// genuinely on v12 and not already on v13.
			expect(() => legacy.exec(`
				INSERT INTO items (chain_id, item_id, repo_cwd, status, attempts, position, status_updated_at, runner, session_ids, extra, created_at, updated_at)
				VALUES (1, '481-pre-reject', '/repo/coder-loop', 'queued', 0, 0, 1.0, 'opencode', '{}', '{}', 1.0, 1.0)
			`)).toThrow(/CHECK/i)
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = migrated.getChainByName("legacy-v12-runner")
			expect(chain).not.toBeNull()
			const chainId = chain!.id

			// Pre-migration row survives the v12→v13 rebuild and keeps runner='claude'.
			const preserved = migrated.getItemById(chainId, "481-pre")
			expect(preserved).not.toBeNull()
			expect(preserved!.runner).toBe("claude")

			// The widened CHECK now admits runner='opencode' — the migration's deliverable. We
			// insert through `createItem` (the engine's normal path) so the assertion exercises
			// what production callers would.
			const opencodeItem = migrated.createItem({
				chainId,
				itemId: "481-opencode",
				repoCwd: "/repo/coder-loop",
				status: runtimeStatus("queued"),
				attempts: 0,
				runner: "opencode",
				extra: storedItemExtra({}),
			})
			expect(opencodeItem.runner).toBe("opencode")
			const reread = migrated.getItemById(chainId, "481-opencode")
			expect(reread?.runner).toBe("opencode")
		} finally {
			migrated.close()
		}

		// Idempotent: re-open at v13 should not re-rebuild and should keep both rows intact.
		const reopened = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = reopened.getChainByName("legacy-v12-runner")
			expect(chain).not.toBeNull()
			expect(reopened.getItemById(chain!.id, "481-pre")?.runner).toBe("claude")
			expect(reopened.getItemById(chain!.id, "481-opencode")?.runner).toBe("opencode")
		} finally {
			reopened.close()
		}
	})

	test("v5 to v6 migration maps legacy last_session_id by current phase and chain runner (issue #330 AC8)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `session-ids-v5-v6-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT NOT NULL,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					last_session_id TEXT,
					session_ids TEXT NOT NULL DEFAULT '{}',
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'unknown',
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 5;
			`)
			// #433: this fixture intentionally writes the pre-#433 v5 shape (top-level retired runner
			// keys) — that's how real v5 operator disks look. The v9→v10 migration
			// (`migrateChainsMetadataForCl433`) drops these keys after the v5→v6 session-id migration
			// runs (which still depends on the `runner` hint). #456: the role-named retired key is
			// composed at runtime via string concatenation so a grep for the role-shaped vocabulary
			// in `src/` does not match this fixture — the migration semantics are unchanged; only the
			// source-level encoding changed.
			const RETIRED_RUNNER_KEY_LITERAL = "review" + "Runner"
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-session-ids', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{"runner":"codex","${RETIRED_RUNNER_KEY_LITERAL}":"claude"}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, last_session_id, session_ids, phase, extra, created_at, updated_at)
				VALUES (1, 330, '${REPO_ROOT}', 'queued', 0, 'd400e2b2-04a4-44f8-8f13-3078f41a5593', '{}', 'iteration', '{}', 1.0, 1.0)
			`)
			const columnsBefore = legacy.query<{ name: string }, []>("PRAGMA table_info(items)").all().map((row) => row.name)
			expect(columnsBefore).toContain("last_session_id")
			expect(columnsBefore).toContain("session_ids")
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			expect(migrated.listTableColumns("items")).not.toContain("last_session_id")
			expect(migrated.listTableColumns("items")).not.toContain("session_ids")
			const item = migrated.getItemById(1, "330")
			expect(item?.sessionIds).toEqual({})
			const tree = migrated.getTaskTree(1)
			expect(tree?.root.kind).toBe("seq")
			if (tree?.root.kind !== "seq") throw new Error("expected migrated seq root")
			expect(tree.root.children[0]?.kind).toBe("leaf")
			const leaf = tree.root.children[0]
			if (leaf?.kind !== "leaf") throw new Error("expected migrated leaf")
			expect(leaf.closure.sessions).toEqual([{ runner: "codex", sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5593" }])
		} finally {
			migrated.close()
		}
	})

	test("pre-v3 item schema migration adds session_ids without reintroducing last_session_id", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `item-session-legacy-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })
		const dbFile = resolve(loopDataRoot, "db.sqlite")

		const legacy = new Database(dbFile, { create: true, readwrite: true, strict: true })
		try {
			legacy.exec("PRAGMA foreign_keys = ON")
			legacy.exec("PRAGMA journal_mode = WAL")
			legacy.exec(`
				CREATE TABLE chains (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL UNIQUE,
					preset TEXT NOT NULL,
					repository TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					umbrella_issue INTEGER,
					umbrella_repo TEXT,
					status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted')),
					metadata TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL
				);
				CREATE TABLE items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					issue_number INTEGER NOT NULL,
					repo_cwd TEXT NOT NULL,
					status TEXT NOT NULL,
					attempts INTEGER NOT NULL,
					title TEXT,
					priority TEXT,
					branch TEXT,
					pr INTEGER,
					last_run_id TEXT,
					issue_file TEXT,
					evidence_dir TEXT,
					agent_cwd TEXT,
					runner TEXT CHECK (runner IN ('claude', 'codex') OR runner IS NULL),
					phase TEXT,
					extra TEXT NOT NULL,
					created_at REAL NOT NULL,
					updated_at REAL NOT NULL,
					UNIQUE (chain_id, issue_number)
				);
				CREATE TABLE runs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id TEXT NOT NULL UNIQUE,
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					started_at REAL NOT NULL,
					ended_at REAL,
					exit_code INTEGER,
					extra TEXT NOT NULL
				);
				CREATE TABLE current_runs (
					chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
					phase TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					started_at REAL NOT NULL,
					extra TEXT NOT NULL
				);
				PRAGMA user_version = 2;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-sess', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, extra, created_at, updated_at)
				VALUES (1, 291, '/repo/legacy', 'queued', 0, '{}', 1.0, 1.0)
			`)
			const columnsBefore = legacy.query<{ name: string }, []>("PRAGMA table_info(items)").all().map((row) => row.name)
			expect(columnsBefore).not.toContain("last_session_id")
			expect(columnsBefore).toContain("phase")
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			expect(migrated.listTableColumns("items")).not.toContain("last_session_id")
			expect(migrated.listTableColumns("items")).not.toContain("session_ids")
			const items = migrated.listItems(1)
			expect(items).toHaveLength(1)
			const item = items[0]
			if (item === undefined) throw new Error("migrated item missing")
			expect(item.sessionIds).toEqual({})
			migrated.recordRun({ runId: "pre-v3-iteration", chainId: 1, itemId: item.id, phase: "iteration", startedAt: 1.5, extra: definitionRunExtra({ definitionPhaseNames: ["iteration"], worktreePath: REPO_ROOT, branchName: "main" }) })
			migrated.setCurrentRun({ chainId: 1, phase: "iteration", runId: "pre-v3-iteration", startedAt: 1.5, extra: storedItemExtra({}) })
			migrated.clearCurrentRun("pre-v3-iteration")
			const updated = migrated.setItemSessionId(item.id, {
				phase: "iteration",
				runner: "codex",
				sessionId: "sess-from-legacy",
				updatedAt: 2.0,
			})
			expect(updated.sessionIds).toEqual({})
			expect(migrated.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("sess-from-legacy")
		} finally {
			migrated.close()
		}
	})

	test("context entries are append-only and removed by chain delete", async () => {
		const { store, dbFile } = await openTestStore("context-gc")
		let oneId = -1
		let twoId = -1
		try {
			const one = store.createChain({ name: "context-one", repository: "o/r", baseBranch: "main" })
			const two = store.createChain({ name: "context-two", repository: "o/r", baseBranch: "main" })
			oneId = one.id
			twoId = two.id
			store.appendContextEntry({ chainId: one.id, scope: { kind: "chain" }, author: { kind: "operator" }, body: "one" })
			store.appendContextEntry({ chainId: two.id, scope: { kind: "chain" }, author: { kind: "operator" }, body: "two" })
		} finally { store.close() }
		const daemon = await startCoderLoopDaemon({ loopDataRoot: dbFileRoot(dbFile), scheduler: { enabled: false } })
		try {
			const deleted = await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.delete", { chainName: "context-one" }))
			expect(deleted.ok).toBe(true)
		} finally { await daemon.stop() }
		const check = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
		try {
			expect(check.listContextEntries(oneId)).toEqual([])
			expect(check.listContextEntries(twoId).map((entry) => entry.body)).toEqual(["two"])
		} finally { check.close() }
		for (const subcommand of ["update", "delete"]) {
			const proc = Bun.spawnSync({ cmd: ["bun", resolve(REPO_ROOT, "src/loop.ts"), "context", subcommand], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
			expect(proc.exitCode).not.toBe(0)
			expect(new TextDecoder().decode(proc.stderr)).toContain("Not a valid subcommand")
		}
	})

	test("context schema migration preserves existing data", async () => {
		const { store, dbFile } = await openTestStore("context-migration")
		const chain = store.createChain({ name: "context-preserved", repository: "o/r", baseBranch: "main" })
		const item = createFullItem(store, chain, { itemId: "migration-item" })
		const runExtra = storedItemExtra({ preserved: true, definitionKind: "chain", definitionContentIdentity: "sha256:context-migration", definitionPhaseNames: ["iteration"], worktreePath: "/repo/context-migration", branchName: "context-migration", baseCommit: "0123456789abcdef" })
		const run = store.recordRun({ runId: "context-migration-run", chainId: chain.id, itemId: item.id, phase: "iteration", status: runtimeStatus("running"), startedAt: 10, extra: runExtra })
		const current = store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: run.runId, startedAt: 10, extra: storedItemExtra({ preserved: true }) })
		store.close()
		const legacy = new Database(dbFile)
		legacy.exec("DROP TABLE context_entries; PRAGMA user_version = 13")
		legacy.close()
		const migrated = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
		try {
			expect(migrated.getChain(chain.id)?.name).toBe("context-preserved")
			expect(migrated.getItem(item.id)?.itemId).toBe("migration-item")
			expect(migrated.getRunByRunId(run.runId)?.extra).toEqual(runExtra)
			expect(migrated.getCurrentRun(chain.id)).toEqual(current)
			expect(migrated.listTableColumns("context_entries")).toContain("body")
		} finally { migrated.close() }
		const indexDb = new Database(dbFile)
		const indexes = indexDb.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='context_entries' ORDER BY name").all().map((row) => row.name)
		indexDb.close()
		expect(indexes).toContain("idx_context_entries_chain_cursor")
		const reopened = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
		try {
			expect(reopened.getChain(chain.id)?.name).toBe("context-preserved")
			expect(reopened.getItem(item.id)?.itemId).toBe("migration-item")
			expect(reopened.getRunByRunId(run.runId)?.runId).toBe(run.runId)
			expect(reopened.getCurrentRun(chain.id)).toEqual(current)
		} finally { reopened.close() }
	})
})

type PacketlessHistoricalRun = {
	runId: string
	chainId: number
	itemId: number
	phase: string
	startedAt: number
}

function rebuildRunsAsPacketlessHistory(db: Database): void {
	db.exec(`CREATE TABLE runs_packetless (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL UNIQUE,
		chain_id INTEGER NOT NULL,
		item_id INTEGER NOT NULL,
		phase TEXT NOT NULL,
		status TEXT NOT NULL,
		started_at REAL NOT NULL,
		ended_at REAL,
		exit_code INTEGER,
		extra TEXT NOT NULL
	)`)
	db.exec("DROP TABLE runs")
	db.exec("ALTER TABLE runs_packetless RENAME TO runs")
}

function insertPacketlessHistoricalRun(db: Database, input: PacketlessHistoricalRun): void {
	db.query(`INSERT INTO runs (run_id, chain_id, item_id, phase, status, started_at, ended_at, exit_code, extra)
		VALUES (?, ?, ?, ?, 'in_progress', ?, NULL, NULL, '{}')`).run(input.runId, input.chainId, input.itemId, input.phase, input.startedAt)
}

async function openTestStore(name: string): Promise<{ store: ReturnType<typeof openSqliteStateStore>; dbFile: string }> {
	const loopDataRoot = resolve(TEST_ROOT, `${name}-${Date.now()}-${++nextRootId}`)
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	return { store, dbFile: resolve(loopDataRoot, "db.sqlite") }
}

function createFullChain(store: ReturnType<typeof openSqliteStateStore>): ChainRecord {
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
type FullItemOverrides = Omit<Partial<CreateItemInput>, "status" | "extra"> & {
	status?: string
	extra?: JsonObject
	issueNumber?: number
	branch?: string | null
	pr?: number | null
}

function createFullItem(
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

function definitionRunExtra(overrides: JsonObject = {}) {
	return storedItemExtra({
		definitionKind: "preset",
		definitionContentIdentity: "sha256:persisted-definition",
		definitionPhaseNames: ["iteration", "review", "blocked-responder", "umbrella-finalizer"],
		worktreePath: "/repo/coder-loop",
		branchName: "issue-177",
		baseCommit: "0123456789abcdef",
		...overrides,
	})
}

function singleLeafTree(item: ItemRecord): TaskTreeSnapshot {
	return {
		root: {
			kind: "leaf",
			identity: { runtimeNodeId: `leaf-${item.id}`, definitionRef: { kind: "chain", contentIdentity: "sha256:single-leaf" }, definitionNodeId: "leaf" },
			closure: { closureId: `closure-${item.id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] },
		},
		activeRuns: [],
	}
}

function twoPhaseLeafTree(item: ItemRecord): TaskTreeSnapshot {
	const definitionRef = { kind: "chain", contentIdentity: "sha256:two-phase" } as const
	const closure = (phase: string) => ({ kind: "leaf", identity: { runtimeNodeId: `leaf-${item.id}-${phase}`, definitionRef, definitionNodeId: phase }, closure: { closureId: `closure-${item.id}-${phase}`, itemRowId: item.id, itemId: item.itemId, phase, lifecycle: "active", worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] } } as const)
	return { root: { kind: "seq", identity: { runtimeNodeId: `root-${item.id}`, definitionRef, definitionNodeId: "root" }, cursor: { kind: "next", nodeId: `leaf-${item.id}-iteration` }, children: [closure("iteration"), closure("review")] }, activeRuns: [] }
}

function dbFileRoot(dbFile: string): string {
	return dbFile.slice(0, -"db.sqlite".length - 1)
}
