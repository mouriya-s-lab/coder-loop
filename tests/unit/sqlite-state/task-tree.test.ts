import { describe, expect, test } from "bun:test"

import {
	Database,
	cp,
	mkdir,
	rm,
	writeFile,
	resolve,
	SqliteStateError,
	openSqliteStateStore,
	storedItemExtra,
	seedCanonicalHistoricalRuntime,
	ItemRecord,
	TaskTreeSnapshot,
	REPO_ROOT,
	TEST_ROOT,
	runtimeStatus,
	expectSqliteCode,
	openTestStore,
	createFullChain,
	createFullItem,
	definitionRunExtra,
	singleLeafTree,
	twoPhaseLeafTree,
	dbFileRoot,
} from "./helpers"

let nextRootId = 0

describe("sqlite state store", () => {
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
		const secondDefinition = {
			definitionContentIdentity: "sha256:second-definition",
			definitionPhases: [
				{ phase: "review", definitionNodeId: "task:review" },
				{ phase: "finalize", definitionNodeId: "task:finalize" },
			],
		}
		const secondRun = store.recordRun({ runId: "second-definition-run", chainId: chain.id, itemId: second.id, phase: "review", startedAt: 1_800_000_206, extra: definitionRunExtra({ ...secondDefinition, worktreePath: "/worktrees/second", branchName: "issue-second" }) })
		store.setCurrentRun({ chainId: chain.id, phase: "review", runId: secondRun.runId, startedAt: secondRun.startedAt, extra: storedItemExtra({}) })
		const definitionRef = { kind: "preset", contentIdentity: "sha256:second-definition" } as const
		const reviewIdentity = {
			runtimeNodeId: `closure-node:${second.id}:review`,
			definitionRef,
			definitionNodeId: "task:review",
		}
		const expectedSecondIdentities = ["review", "finalize"].map((phase) => ({
			runtimeNodeId: `closure-node:${second.id}:${phase}`,
			definitionRef,
			definitionNodeId: `task:${phase}`,
		}))
		try {
			const tree = store.getTaskTree(chain.id)
			if (tree?.root.kind !== "seq") throw new Error("expected seq root")
			const firstOpenLeaves = tree.root.children.flatMap((node) => node.kind === "leaf" && node.closure.itemRowId === second.id ? [node] : [])
			expect(firstOpenLeaves.map((node) => node.identity)).toEqual([reviewIdentity])
			const finalizeRun = store.recordRun({ runId: "second-finalize-run", chainId: chain.id, itemId: second.id, phase: "finalize", startedAt: 1_800_000_207, extra: definitionRunExtra({ ...secondDefinition, worktreePath: "/worktrees/finalize", branchName: "issue-finalize" }) })
			store.setCurrentRun({ chainId: chain.id, phase: "finalize", runId: finalizeRun.runId, startedAt: finalizeRun.startedAt, extra: storedItemExtra({}) })
			const openedTree = store.getTaskTree(chain.id)
			if (openedTree?.root.kind !== "seq") throw new Error("expected opened seq root")
			const secondLeaves = openedTree.root.children.flatMap((node) => node.kind === "leaf" && node.closure.itemRowId === second.id ? [node] : [])
			expect(secondLeaves.map((node) => node.identity)).toEqual(expectedSecondIdentities)
			expect(new Set(secondLeaves.map((node) => node.closure.worktreePath)).size).toBe(secondLeaves.length)
			expect(new Set(secondLeaves.map((node) => node.closure.branchName)).size).toBe(secondLeaves.length)
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

	test("normalized runtime delete advances a migrated seq cursor to the surviving direct child", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `migrated-delete-cursor-${Date.now()}-${++nextRootId}`)
		const fixture = seedCanonicalHistoricalRuntime({
			loopDataRoot,
			schemaVersion: 13,
			chain: { name: "migrated-delete-cursor", repository: "mouriya-s-lab/coder-loop", preset: "single-phase-example" },
			items: [
				{ itemId: "A", repoCwd: REPO_ROOT, status: "pending", phase: "run", preset: "single-phase-example", presetPath: null, agentCwd: REPO_ROOT, sessionIds: {}, extra: {} },
				{ itemId: "B", repoCwd: REPO_ROOT, status: "pending", phase: "run", preset: "single-phase-example", presetPath: null, agentCwd: REPO_ROOT, sessionIds: {}, extra: {} },
			],
			contextEntries: [],
		})
		const store = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			const first = fixture.items[0]
			if (first === undefined) throw new Error("historical fixture omitted first item")
			const selected = store.getTaskTree(fixture.chain.id)
			if (selected?.root.kind !== "seq") throw new Error("expected migrated seq")
			expect(selected.root.cursor).toEqual({ kind: "next", nodeId: "legacy-v13:item:1:phase:run" })

			expect(store.deleteItem(first.id)).toBe(true)

			const advanced = store.getTaskTree(fixture.chain.id)
			if (advanced?.root.kind !== "seq") throw new Error("expected migrated seq after delete")
			expect(advanced.root.children.map((node) => node.identity.runtimeNodeId)).toEqual(["legacy-v13:item:2:phase:run"])
			expect(advanced.root.cursor).toEqual({ kind: "next", nodeId: "legacy-v13:item:2:phase:run" })
		} finally { store.close() }
	})

	test("normalized runtime migration resolves persisted preset once and survives source removal", async () => {
		const presetPath = resolve(TEST_ROOT, "mutable-checkout-preset")
		await cp(resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"), presetPath, { recursive: true })
		const loopDataRoot = resolve(TEST_ROOT, `checkout-independent-${Date.now()}-${++nextRootId}`)
		const fixture = seedCanonicalHistoricalRuntime({
			loopDataRoot,
			schemaVersion: 13,
			chain: { name: "central-state", repository: "mouriya-s-lab/coder-loop", preset: "gh-issue-pr-iteration" },
			items: [{ itemId: "177", repoCwd: REPO_ROOT, status: "in_progress", phase: "iteration", preset: null, presetPath, agentCwd: REPO_ROOT, sessionIds: {}, extra: { issue: 177 }, run: { runId: "packet-less-history", phase: "iteration", status: "in_progress", startedAt: 1_800_000_221, extra: {} } }],
			contextEntries: [],
		})
		const chain = fixture.chain
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
			const presetPath = resolve(TEST_ROOT, `definition-source-${scenario}`)
			if (scenario === "unreadable") await mkdir(presetPath, { recursive: true })
			if (scenario === "invalid") {
				await mkdir(presetPath, { recursive: true })
				await writeFile(resolve(presetPath, "preset.toml"), "not = [valid", "utf8")
			}
			const loopDataRoot = resolve(TEST_ROOT, `definition-facts-${scenario}-${Date.now()}-${++nextRootId}`)
			const fixture = seedCanonicalHistoricalRuntime({
				loopDataRoot,
				schemaVersion: 13,
				chain: { name: "central-state", repository: "mouriya-s-lab/coder-loop", preset: "gh-issue-pr-iteration" },
				items: [{ itemId: "177", repoCwd: REPO_ROOT, status: "in_progress", phase: "iteration", preset: null, presetPath: scenario === "missing" ? null : presetPath, agentCwd: REPO_ROOT, sessionIds: {}, extra: { issue: 177 } }],
				contextEntries: [],
			})
			expectSqliteCode(() => openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) }), "invalid_json")
		}
	})

	test("closure active run rejects completed run reactivation", async () => {
		const { store } = await openTestStore("completed-run-reactivation")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
			const run = store.recordRun({
				runId: "completed-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_110,
			})
			store.completeRun(run.runId, { endedAt: 1_800_000_111, exitCode: 0, status: runtimeStatus("done") })

			expectSqliteCode(
				() => store.setCurrentRun({ chainId: chain.id, phase: run.phase, runId: run.runId, startedAt: run.startedAt, extra: storedItemExtra({}) }),
				"invalid_input",
			)
			expect(store.listCurrentRuns(chain.id)).toEqual([])
		} finally { store.close() }
	})

})
