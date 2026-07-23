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
	storedChainMetadata,
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

	test("prepared closure resources and run history commit atomically", async () => {
		const { store } = await openTestStore("prepared-resources-run")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			const closureId = `closure-${item.id}`
			store.createTaskTree(chain.id, singleLeafTree(item))
			store.recordRun({ runId: "existing-run", chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_001 })
			const prepared = {
				closureId,
				worktreePath: "/worktrees/prepared",
				branchName: "coder-loop/closures/prepared",
				baseCommit: "1234567890abcdef1234567890abcdef12345678",
				updatedAt: 1_800_000_002,
			} as const

			expect(() => store.recordRunWithClosureResources({
				runId: "existing-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_002,
			}, prepared)).toThrow(SqliteStateError)
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({ closure: {
				closureId,
				worktreePath: "/repo/coder-loop",
				branchName: "issue-177",
				baseCommit: "0123456789abcdef",
			} })

			const run = store.recordRunWithClosureResources({
				runId: "prepared-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_003,
			}, prepared)
			expect(run.closureId).toBe(closureId)
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({ closure: {
				closureId,
				worktreePath: prepared.worktreePath,
				branchName: prepared.branchName,
				baseCommit: prepared.baseCommit,
			} })
		} finally {
			store.close()
		}
	})

	test("v16 reachability seeds migrate to explicit future-writer target variants", async () => {
		const fixture = await openTestStore("v16-reachability-seeds")
		const chain = createFullChain(fixture.store)
		const item = createFullItem(fixture.store, chain)
		fixture.store.createTaskTree(chain.id, singleLeafTree(item))
		const tree = fixture.store.getTaskTree(chain.id)
		if (tree?.root.kind !== "leaf") throw new Error("expected single migrated leaf")
		const closureId = tree.root.closure.closureId
		fixture.store.close()

		const legacy = new Database(fixture.dbFile)
		try {
			legacy.exec("PRAGMA foreign_keys=OFF")
			legacy.exec(`
				DROP TABLE closure_consumption_intents;
				CREATE TABLE closure_reachability_seeds_v16 (
					chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
					closure_id TEXT NOT NULL REFERENCES task_closures(closure_id) ON DELETE CASCADE,
					kind TEXT NOT NULL CHECK (kind IN ('open-append')),
					PRIMARY KEY (chain_id, closure_id, kind)
				);
				INSERT INTO closure_reachability_seeds_v16 (chain_id, closure_id, kind)
					VALUES (${chain.id}, '${closureId}', 'open-append');
				DROP TABLE closure_reachability_seeds;
				ALTER TABLE closure_reachability_seeds_v16 RENAME TO closure_reachability_seeds;
				PRAGMA user_version=16;
			`)
		} finally { legacy.close() }

		openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) }).close()
		const migrated = new Database(fixture.dbFile)
		try {
			expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(17)
			expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='closure_consumption_intents'").get()?.name).toBe("closure_consumption_intents")
			migrated.query("INSERT INTO closure_reachability_seeds (chain_id,closure_id,kind) VALUES ($chain,$closure,'decided-reopen'),($chain,$closure,'next-epoch-candidate')").run({ $chain: chain.id, $closure: closureId })
			expect(migrated.query<{ kind: string }, []>("SELECT kind FROM closure_reachability_seeds ORDER BY kind").all().map((row) => row.kind)).toEqual([
				"decided-reopen",
				"next-epoch-candidate",
				"open-append",
			])
		} finally { migrated.close() }
	})

	test("run recording rejects lazy task-tree materialization", async () => {
		const { store } = await openTestStore("run-requires-precreated-closure")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			expectSqliteCode(() => store.recordRun({
				runId: "missing-runtime-identity",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_205,
				extra: definitionRunExtra(),
			}), "run_closure_mismatch")
			expect(store.getTaskTree(chain.id)).toBeNull()
		} finally { store.close() }
	})

	test("exact task-transition replay returns the committed record while conflicting replay is rejected", async () => {
		const { store } = await openTestStore("transition-idempotency")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, twoPhaseLeafTree(item))
			store.recordRun({
				runId: "transition-idempotency-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_205,
			})
			const input = {
				sourceRunId: "transition-idempotency-run",
				sourceClosureId: `closure-${item.id}-iteration`,
				targetRuntimeNodeId: `leaf-${item.id}-review`,
				pathId: "advance",
				exitPayload: { result: "ok" },
				resolvedBindings: { RESULT: "ok" },
				createdAt: 1_800_000_206,
				itemUpdate: { kind: "none" } as const,
			}
			const committed = store.commitTaskTransition(input)
			expect(store.commitTaskTransition({ ...input, createdAt: 1_800_000_207 })).toEqual(committed)
			expect(store.listTaskTransitions(chain.id)).toEqual([committed])
			expectSqliteCode(() => store.commitTaskTransition({
				...input,
				exitPayload: { result: "different" },
				resolvedBindings: { RESULT: "different" },
				createdAt: 1_800_000_208,
			}), "invalid_input")
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "seq",
				cursor: { kind: "next", nodeId: `leaf-${item.id}-review` },
				children: [
					{ state: "completed" },
					{ state: "pending" },
				],
			})
		} finally {
			store.close()
		}
	})

	test("legacy final-phase retry resets only its direct seq and keeps per-run transition history replay-safe", async () => {
		const { store } = await openTestStore("legacy-retry-transition-history")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.appendItemTaskTree(chain.id, twoPhaseLeafTree(item, `chain:${chain.id}:tasks`).root)
			store.setItemSessionId(item.id, { phase: "iteration", runner: "codex", sessionId: "iteration-session", updatedAt: 1_800_000_210 })
			store.setItemSessionId(item.id, { phase: "review", runner: "claude", sessionId: "review-session", updatedAt: 1_800_000_211 })

			store.recordRun({
				runId: "legacy-iteration-1",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_212,
			})
			const iterationInput = {
				sourceRunId: "legacy-iteration-1",
				sourceClosureId: `closure-${item.id}-iteration`,
				targetRuntimeNodeId: `leaf-${item.id}-review`,
				pathId: "legacy-run-success:iteration",
				exitPayload: {},
				resolvedBindings: {},
				createdAt: 1_800_000_213,
				itemUpdate: { kind: "none" } as const,
			}
			const iterationOne = store.commitTaskTransition(iterationInput)
			store.setClosureLifecycle(`closure-${item.id}-iteration`, { kind: "suspend", updatedAt: 1_800_000_214 })

			store.recordRun({
				runId: "legacy-review-1",
				chainId: chain.id,
				itemId: item.id,
				phase: "review",
				startedAt: 1_800_000_215,
			})
			const retryInput = {
				sourceRunId: "legacy-review-1",
				sourceClosureId: `closure-${item.id}-review`,
				targetRuntimeNodeId: `leaf-${item.id}-iteration`,
				pathId: "legacy-status:review:changes_requested",
				exitPayload: { status: "changes_requested" },
				resolvedBindings: {},
				createdAt: 1_800_000_216,
				itemId: item.id,
				itemUpdate: {
					status: runtimeStatus("changes_requested"),
					phase: "review",
					updatedAt: 1_800_000_216,
				},
			}
			const retry = store.commitLegacyTaskRetry(retryInput)
			expect(store.commitLegacyTaskRetry({ ...retryInput, createdAt: 1_800_000_217 })).toEqual(retry)
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "par",
				children: [{
					kind: "seq",
					cursor: { kind: "next", nodeId: `leaf-${item.id}-iteration` },
					children: [{ state: "pending" }, { state: "pending" }],
				}],
			})

			expect(store.commitTaskTransition({ ...iterationInput, createdAt: 1_800_000_218 })).toEqual(iterationOne)
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "par",
				children: [{
					kind: "seq",
					cursor: { kind: "next", nodeId: `leaf-${item.id}-iteration` },
				}],
			})

			store.setClosureLifecycle(`closure-${item.id}-iteration`, { kind: "activate", updatedAt: 1_800_000_219 })
			store.updateItem(item.id, { phase: "iteration", updatedAt: 1_800_000_219 })
			store.recordRun({
				runId: "legacy-iteration-2",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_220,
			})
			store.commitTaskTransition({
				...iterationInput,
				sourceRunId: "legacy-iteration-2",
				createdAt: 1_800_000_221,
			})
			expect(store.commitLegacyTaskRetry({ ...retryInput, createdAt: 1_800_000_222 })).toEqual(retry)
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "par",
				children: [{
					kind: "seq",
					cursor: { kind: "next", nodeId: `leaf-${item.id}-review` },
					children: [{ state: "completed" }, { state: "pending" }],
				}],
			})
			expect(store.getItem(item.id)?.phase).toBe("iteration")
			expectSqliteCode(() => store.commitLegacyTaskRetry({
				...retryInput,
				exitPayload: { status: "different" },
				createdAt: 1_800_000_223,
			}), "invalid_input")

			store.updateItem(item.id, { phase: "review", updatedAt: 1_800_000_224 })
			store.recordRun({
				runId: "legacy-review-2",
				chainId: chain.id,
				itemId: item.id,
				phase: "review",
				startedAt: 1_800_000_225,
			})
			store.commitTaskTransition({
				sourceRunId: "legacy-review-2",
				sourceClosureId: `closure-${item.id}-review`,
				targetRuntimeNodeId: null,
				pathId: "legacy-status:review:done",
				exitPayload: { status: "done" },
				resolvedBindings: {},
				createdAt: 1_800_000_226,
				itemUpdate: {
					kind: "always",
					itemId: item.id,
					update: { status: runtimeStatus("done"), phase: "review", updatedAt: 1_800_000_226 },
				},
			})

			expect(store.listTaskTransitions(chain.id).map((transition) => ({
				runId: transition.sourceRunId,
				path: transition.pathId,
			}))).toEqual([
				{ runId: "legacy-iteration-1", path: "legacy-run-success:iteration" },
				{ runId: "legacy-review-1", path: "legacy-status:review:changes_requested" },
				{ runId: "legacy-iteration-2", path: "legacy-run-success:iteration" },
				{ runId: "legacy-review-2", path: "legacy-status:review:done" },
			])
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "par",
				children: [{
					kind: "seq",
					cursor: { kind: "complete" },
					children: [{ state: "completed" }, { state: "completed" }],
				}],
			})
			expect(store.getItem(item.id)).toMatchObject({ status: "done", phase: "review", attempts: 1 })
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("iteration-session")
			expect(store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("review-session")
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				children: [{
					children: [
						{ closure: { worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, lifecycle: "active" } },
						{ closure: { worktreePath: "/repo/coder-loop", branchName: `issue-${item.itemId}`, lifecycle: "active" } },
					],
				}],
			})
		} finally {
			store.close()
		}
	})

	test("legacy item trigger atomically completes its source, appends its exact durable target, replays once, and drains after trigger success", async () => {
		const { store } = await openTestStore("legacy-item-trigger-commit")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			const chainRootNodeId = `chain:${chain.id}:tasks`
			store.appendItemTaskTree(chain.id, twoPhaseLeafTree(item, chainRootNodeId).root)
			store.recordRun({
				runId: "legacy-trigger-iteration",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_230,
			})
			store.commitTaskTransition({
				sourceRunId: "legacy-trigger-iteration",
				sourceClosureId: `closure-${item.id}-iteration`,
				targetRuntimeNodeId: `leaf-${item.id}-review`,
				pathId: "legacy-run-success:iteration",
				exitPayload: {},
				resolvedBindings: {},
				createdAt: 1_800_000_231,
				itemUpdate: { kind: "none" },
			})
			store.recordRun({
				runId: "legacy-trigger-review",
				chainId: chain.id,
				itemId: item.id,
				phase: "review",
				startedAt: 1_800_000_232,
			})

			const triggerRuntimeNodeId = `legacy-trigger:${item.id}:blocked-responder`
			const triggerClosureId = `legacy-trigger-closure:${item.id}:blocked-responder`
			const triggerLeaf = {
				kind: "leaf",
				identity: {
					runtimeNodeId: triggerRuntimeNodeId,
					definitionRef: { kind: "chain", contentIdentity: "sha256:two-phase" },
					definitionNodeId: "legacy-trigger:blocked-responder",
				},
				state: "pending",
				closure: {
					closureId: triggerClosureId,
					itemRowId: item.id,
					itemId: item.itemId,
					phase: "blocked-responder",
					lifecycle: "active",
					worktreePath: "/repo/coder-loop",
					branchName: `issue-${item.itemId}`,
					baseCommit: "0123456789abcdef",
					sourceParNodeId: chainRootNodeId,
					sessions: [],
				},
			} as const
			const input = {
				sourceRunId: "legacy-trigger-review",
				sourceClosureId: `closure-${item.id}-review`,
				pathId: "legacy-status:review:blocked",
				exitPayload: { status: "blocked" },
				resolvedBindings: { TRIGGER: "blocked-responder" },
				createdAt: 1_800_000_233,
				itemId: item.id,
				triggerLeaf,
				itemUpdate: {
					status: runtimeStatus("blocked"),
					phase: "blocked-responder",
					updatedAt: 1_800_000_233,
				},
			}

			const committed = store.commitLegacyItemTrigger(input)
			expect(committed).toMatchObject({
				sourceRunId: input.sourceRunId,
				sourceClosureId: input.sourceClosureId,
				sourceRuntimeNodeId: `leaf-${item.id}-review`,
				targetRuntimeNodeId: triggerRuntimeNodeId,
				pathId: input.pathId,
				exitPayload: input.exitPayload,
				resolvedBindings: input.resolvedBindings,
				createdAt: input.createdAt,
			})
			expect(store.getItem(item.id)).toMatchObject({
				status: "blocked",
				phase: "blocked-responder",
				updatedAt: input.itemUpdate.updatedAt,
			})
			const committedTree = store.getTaskTree(chain.id)
			if (committedTree?.root.kind !== "par") throw new Error("expected chain par after legacy trigger commit")
			expect(committedTree.root.state).toBe("open")
			expect(committedTree.root.children.map((node) => node.identity.runtimeNodeId)).toEqual([
				`root-${item.id}`,
				triggerRuntimeNodeId,
			])
			expect(committedTree.root.children).toMatchObject([
				{
					kind: "seq",
					cursor: { kind: "complete" },
					children: [{ state: "completed" }, { state: "completed" }],
				},
				{
					kind: "leaf",
					identity: triggerLeaf.identity,
					state: "pending",
					closure: triggerLeaf.closure,
				},
			])

			expect(store.commitLegacyItemTrigger({ ...input, createdAt: 1_800_000_234 })).toEqual(committed)
			expect(store.listTaskTransitions(chain.id).filter((transition) => transition.sourceRunId === input.sourceRunId)).toEqual([committed])
			const replayedTree = store.getTaskTree(chain.id)
			if (replayedTree?.root.kind !== "par") throw new Error("expected chain par after legacy trigger replay")
			expect(replayedTree.root.children.map((node) => node.identity.runtimeNodeId)).toEqual([
				`root-${item.id}`,
				triggerRuntimeNodeId,
			])

			store.recordRun({
				runId: "legacy-trigger-responder",
				chainId: chain.id,
				itemId: item.id,
				phase: "blocked-responder",
				startedAt: 1_800_000_235,
			})
			store.commitTaskTransition({
				sourceRunId: "legacy-trigger-responder",
				sourceClosureId: triggerClosureId,
				targetRuntimeNodeId: null,
				pathId: "legacy-status:blocked-responder:done",
				exitPayload: { status: "done" },
				resolvedBindings: {},
				createdAt: 1_800_000_236,
				itemUpdate: {
					kind: "always",
					itemId: item.id,
					update: {
						status: runtimeStatus("done"),
						phase: "blocked-responder",
						updatedAt: 1_800_000_236,
					},
				},
			})
			expect(store.getTaskTree(chain.id)?.root).toMatchObject({
				kind: "par",
				state: "completed",
				children: [
					{ kind: "seq", cursor: { kind: "complete" } },
					{ kind: "leaf", identity: { runtimeNodeId: triggerRuntimeNodeId }, state: "completed" },
				],
			})
		} finally {
			store.close()
		}
	})

	test("legacy item trigger rejects a foreign-owned leaf without partially changing the tree, transition history, or items", async () => {
		const { store } = await openTestStore("legacy-item-trigger-owner-rollback")
		try {
			const chain = createFullChain(store)
			const sourceItem = createFullItem(store, chain)
			const foreignItem = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const chainRootNodeId = `chain:${chain.id}:tasks`
			store.appendItemTaskTree(chain.id, twoPhaseLeafTree(sourceItem, chainRootNodeId).root)
			store.recordRun({
				runId: "legacy-trigger-owner-iteration",
				chainId: chain.id,
				itemId: sourceItem.id,
				phase: "iteration",
				startedAt: 1_800_000_240,
			})
			store.commitTaskTransition({
				sourceRunId: "legacy-trigger-owner-iteration",
				sourceClosureId: `closure-${sourceItem.id}-iteration`,
				targetRuntimeNodeId: `leaf-${sourceItem.id}-review`,
				pathId: "legacy-run-success:iteration",
				exitPayload: {},
				resolvedBindings: {},
				createdAt: 1_800_000_241,
				itemUpdate: { kind: "none" },
			})
			store.recordRun({
				runId: "legacy-trigger-owner-review",
				chainId: chain.id,
				itemId: sourceItem.id,
				phase: "review",
				startedAt: 1_800_000_242,
			})
			const beforeTree = store.getTaskTree(chain.id)
			const beforeTransitions = store.listTaskTransitions(chain.id)
			const beforeSourceItem = store.getItem(sourceItem.id)
			const beforeForeignItem = store.getItem(foreignItem.id)

			expectSqliteCode(() => store.commitLegacyItemTrigger({
				sourceRunId: "legacy-trigger-owner-review",
				sourceClosureId: `closure-${sourceItem.id}-review`,
				pathId: "legacy-status:review:blocked",
				exitPayload: { status: "blocked" },
				resolvedBindings: {},
				createdAt: 1_800_000_243,
				itemId: sourceItem.id,
				triggerLeaf: {
					kind: "leaf",
					identity: {
						runtimeNodeId: `legacy-trigger:${sourceItem.id}:foreign`,
						definitionRef: { kind: "chain", contentIdentity: "sha256:two-phase" },
						definitionNodeId: "legacy-trigger:foreign",
					},
					state: "pending",
					closure: {
						closureId: `legacy-trigger-closure:${sourceItem.id}:foreign`,
						itemRowId: foreignItem.id,
						itemId: foreignItem.itemId,
						phase: "blocked-responder",
						lifecycle: "active",
						worktreePath: "/repo/coder-loop",
						branchName: `issue-${sourceItem.itemId}`,
						baseCommit: "0123456789abcdef",
						sourceParNodeId: chainRootNodeId,
						sessions: [],
					},
				},
				itemUpdate: {
					status: runtimeStatus("blocked"),
					phase: "blocked-responder",
					updatedAt: 1_800_000_243,
				},
			}), "run_closure_mismatch")

			expect(store.getTaskTree(chain.id)).toEqual(beforeTree)
			expect(store.listTaskTransitions(chain.id)).toEqual(beforeTransitions)
			expect(store.getItem(sourceItem.id)).toEqual(beforeSourceItem)
			expect(store.getItem(foreignItem.id)).toEqual(beforeForeignItem)
		} finally {
			store.close()
		}
	})

	test("nested task tree round-trip", async () => {
		const { store } = await openTestStore("nested-task-tree")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const third = createFullItem(store, chain, { issueNumber: 179, itemId: "179" })
			const definitionRef = { kind: "chain", contentIdentity: "sha256:definition" } as const
			const leaf = (item: ItemRecord, id: string) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: `definition-${id}` }, state: "pending", closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: id === "leaf-one" ? null : "par-one", sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "root", definitionRef, definitionNodeId: "definition-root" }, cursor: { kind: "next", nodeId: "leaf-one" }, children: [leaf(first, "leaf-one"), { kind: "par", identity: { runtimeNodeId: "par-one", definitionRef, definitionNodeId: "definition-par" }, groupId: "par-one", pinCommit: "0123456789abcdef", maxConcurrency: null, state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(second, "leaf-two"), leaf(third, "leaf-three")] }] }, activeRuns: [] }
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
			const leaf = { kind: "leaf", identity: { runtimeNodeId: "par-child", definitionRef, definitionNodeId: "leaf" }, state: "pending", closure: { closureId: "closure-par-child", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: "/worktrees/par-child", branchName: "issue-par-child", baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] } } as const
			const tree: TaskTreeSnapshot = { root: { kind: "par", identity: { runtimeNodeId: "actual-par", definitionRef, definitionNodeId: "par" }, groupId: "actual-par", pinCommit: "0123456789abcdef", maxConcurrency: null, state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf] }, activeRuns: [] }
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
			const leaf = (item: ItemRecord, id: string, sourceParNodeId: string | null) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id }, state: "pending", closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `branch-${id}`, baseCommit: "0123456789abcdef", sourceParNodeId, sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "seq-root", definitionRef, definitionNodeId: "root" }, cursor: { kind: "next", nodeId: "nested-leaf" }, children: [leaf(first, "direct-leaf", null), { kind: "par", identity: { runtimeNodeId: "nested-par", definitionRef, definitionNodeId: "par" }, groupId: "nested-par", pinCommit: "0123456789abcdef", maxConcurrency: null, state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(second, "nested-leaf", "nested-par")] }] }, activeRuns: [] }
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

	test("closure consumption intent survives reopen and is emitted once", async () => {
		const fixture = await openTestStore("closure-consumption-intent")
		const chain = createFullChain(fixture.store)
		const item = createFullItem(fixture.store, chain)
		const closureId = `closure-${item.id}`
		fixture.store.createTaskTree(chain.id, singleLeafTree(item))
		const authority = { kind: "chain-deletion", chainId: chain.id } as const
		const observation = {
			evidence: "unevaluable",
			freshness: { kind: "no-origin", availability: "unavailable", commit: "0123456789abcdef" },
		} as const
		expect(fixture.store.consumeClosureIfUnreachable(closureId, { authority, observation, updatedAt: 1_800_000_105 })).toMatchObject({
			kind: "consumed",
			intent: { status: "pending", observation },
		})
		fixture.store.close()

		const reopened = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			expect(reopened.assessClosureConsumption(closureId, authority)).toMatchObject({
				kind: "already-consumed",
				intent: { status: "pending", observation },
			})
			expect(reopened.markClosureConsumptionIntentEmitted(closureId, 1_800_000_106)).toEqual({ status: "emitted", observation })
			expect(reopened.markClosureConsumptionIntentEmitted(closureId, 1_800_000_107)).toEqual({ status: "emitted", observation })
		} finally { reopened.close() }

		const verified = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			expect(verified.assessClosureConsumption(closureId, authority)).toMatchObject({
				kind: "already-consumed",
				intent: { status: "emitted", observation },
			})
		} finally { verified.close() }
	})

	test("typed reachability facts keep closures retained and reject foreign chains", async () => {
		const { store } = await openTestStore("typed-reachability-facts")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain, { status: "done" })
			store.createTaskTree(chain.id, twoPhaseLeafTree(item))
			const iterationClosure = `closure-${item.id}-iteration`
			const reviewClosure = `closure-${item.id}-review`
			const authority = { kind: "outer-completion", chainId: chain.id, terminalStatuses: [runtimeStatus("done")] } as const

			expect(store.assessClosureConsumption(iterationClosure, authority)).toMatchObject({ kind: "consumable" })
			expect(store.assessClosureConsumption(reviewClosure, authority)).toMatchObject({ kind: "consumable" })

			store.addClosureReachabilityFact(chain.id, { kind: "seed", closureId: iterationClosure, seed: "decided-reopen" })
			store.addClosureReachabilityFact(chain.id, { kind: "seed", closureId: iterationClosure, seed: "decided-reopen" })
			store.addClosureReachabilityFact(chain.id, { kind: "edge", edge: { kind: "scope-target", fromClosureId: iterationClosure, toClosureId: reviewClosure } })

			expect(store.assessClosureConsumption(iterationClosure, authority)).toMatchObject({ kind: "retained", reason: "reachable" })
			expect(store.assessClosureConsumption(reviewClosure, authority)).toMatchObject({ kind: "retained", reason: "reachable" })

			const foreignChain = store.createChain({ name: "foreign-facts", preset: null, repository: "mouriya-s-lab/coder-loop", baseBranch: "main", status: "active", metadata: storedChainMetadata({}), createdAt: 1_800_000_000, updatedAt: 1_800_000_000 })
			expectSqliteCode(() => store.addClosureReachabilityFact(foreignChain.id, { kind: "seed", closureId: iterationClosure, seed: "open-append" }), "run_closure_mismatch")
			expectSqliteCode(() => store.addClosureReachabilityFact(chain.id, { kind: "seed", closureId: "closure-missing", seed: "next-epoch-candidate" }), "not_found")
		} finally { store.close() }
	})

	test("run closure identity survives active relation cleanup", async () => {
		const { store } = await openTestStore("run-closure-identity")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
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
			expect(active?.closureId).toBe(`closure-${item.id}`)
			expect(active?.runtimeNodeId).toBe(`leaf-${item.id}`)
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
			const leaf = (item: ItemRecord) => ({ kind: "leaf", identity: { runtimeNodeId: `leaf-${item.id}`, definitionRef, definitionNodeId: `item-${item.id}` }, state: "pending", closure: { closureId: `closure-${item.id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${item.id}`, branchName: `issue-${item.itemId}`, baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] } } as const)
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
			const leaf = (item: ItemRecord, id: string) => ({ kind: "leaf", identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id }, state: "pending", closure: { closureId: `closure-${id}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: `/worktrees/${id}`, branchName: `branch-${id}`, baseCommit: "0123456789abcdef", sourceParNodeId: "par-history", sessions: [] } } as const)
			const tree: TaskTreeSnapshot = { root: { kind: "par", identity: { runtimeNodeId: "par-history", definitionRef, definitionNodeId: "par" }, groupId: "par-history", pinCommit: "0123456789abcdef", maxConcurrency: null, state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 2, value: { kind: "validator", candidate: { definitionRef, candidateId: "validator" } }, evaluation: { kind: "evaluating", epoch: 2, bindingVersion: 2 } }, children: [leaf(first, "join-leaf-one"), leaf(second, "join-leaf-two")] }, activeRuns: [] }
			expect(store.createTaskTree(chain.id, tree)).toEqual(tree)
			expect(store.getTaskTree(chain.id)).toEqual(tree)
		} finally { store.close() }
	})

	test("durable run SQLite ingress rejects undeclared columns", async () => {
		const { store, dbFile } = await openTestStore("run-row-exact-ingress")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
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

	test("item creation rolls back its row when task-tree instantiation fails", async () => {
		const { store } = await openTestStore("atomic-item-tree-factory-failure")
		try {
			const chain = createFullChain(store)
			expectSqliteCode(() => store.createItemsWithTaskTrees([{
				chainId: chain.id,
				itemId: "atomic-single",
				repoCwd: "/repo/coder-loop",
				status: runtimeStatus("queued"),
				preset: "single-phase-example",
				extra: storedItemExtra({ issue: "atomic-single" }),
			}], () => {
				throw new Error("synthetic task-tree factory failure")
			}), "sqlite_error")

			expect(store.listItems(chain.id)).toEqual([])
			expect(store.getTaskTree(chain.id)).toBeNull()
		} finally {
			store.close()
		}
	})

	test("batch item creation rolls back every row and prior tree write when a later root is invalid", async () => {
		const { store, dbFile } = await openTestStore("atomic-item-tree-batch-failure")
		try {
			const chain = createFullChain(store)
			const inputs = ["atomic-first", "atomic-invalid", "atomic-unvisited"].map((itemId) => ({
				chainId: chain.id,
				itemId,
				repoCwd: "/repo/coder-loop",
				status: runtimeStatus("queued"),
				preset: "single-phase-example",
				extra: storedItemExtra({ issue: itemId }),
			}))
			const visited: number[] = []

			expectSqliteCode(() => store.createItemsWithTaskTrees(inputs, (item, index) => {
				visited.push(index)
				if (index === 1) return singleLeafTree(item).root
				return twoPhaseLeafTree(item, `chain:${chain.id}:tasks`).root
			}), "invalid_input")

			expect(visited).toEqual([0, 1])
			expect(store.listItems(chain.id)).toEqual([])
			expect(store.getTaskTree(chain.id)).toBeNull()

			const db = new Database(dbFile)
			try {
				for (const table of ["items", "task_trees", "task_nodes", "task_closures", "execution_definitions"] as const) {
					const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count
					expect(count).toBe(0)
				}
			} finally {
				db.close()
			}
		} finally {
			store.close()
		}
	})

	test("appending multiple item roots preserves the actual chain-root par identity", async () => {
		const { store } = await openTestStore("append-multiple-item-roots")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain)
			const second = createFullItem(store, chain, { issueNumber: 178, itemId: "178" })
			const definitionRef = { kind: "preset", contentIdentity: "sha256:append-items" } as const
			const itemRoot = (item: ItemRecord) => ({
				kind: "seq",
				identity: { runtimeNodeId: `item-${item.id}-root`, definitionRef, definitionNodeId: "root" },
				cursor: { kind: "next", nodeId: `item-${item.id}-leaf` },
				children: [{
					kind: "leaf",
					identity: { runtimeNodeId: `item-${item.id}-leaf`, definitionRef, definitionNodeId: "phase" },
					state: "pending",
					closure: {
						closureId: `item-${item.id}-closure`,
						itemRowId: item.id,
						itemId: item.itemId,
						phase: "phase",
						lifecycle: "active",
						worktreePath: `/worktrees/${item.id}`,
						branchName: `branch-${item.id}`,
						baseCommit: "0123456789abcdef",
						sourceParNodeId: `chain:${chain.id}:tasks`,
						sessions: [],
					},
				}],
			} as const)

				store.appendItemTaskTree(chain.id, itemRoot(first))
				store.recordRun({
					runId: "append-first-transition-run",
					chainId: chain.id,
					itemId: first.id,
					phase: "phase",
					startedAt: 1_800_000_089,
				})
				store.commitTaskTransition({
					sourceRunId: "append-first-transition-run",
					sourceClosureId: `item-${first.id}-closure`,
					targetRuntimeNodeId: null,
					pathId: "finish-first",
					exitPayload: {},
					resolvedBindings: {},
					createdAt: 1_800_000_090,
					itemUpdate: { kind: "none" },
				})
				expect(store.getTaskTree(chain.id)?.root).toMatchObject({ kind: "par", state: "completed" })
				const appended = store.appendItemTaskTree(chain.id, itemRoot(second))

				expect(appended.root).toMatchObject({
					kind: "par",
					state: "open",
					identity: { runtimeNodeId: `chain:${chain.id}:tasks` },
					children: [
						{ identity: { runtimeNodeId: `item-${first.id}-root` }, cursor: { kind: "complete" } },
						{ identity: { runtimeNodeId: `item-${second.id}-root` }, cursor: { kind: "next", nodeId: `item-${second.id}-leaf` } },
					],
				})
		} finally {
			store.close()
		}
	})

	test("leaf exhaustion is contained to one par member and drains only after successful siblings finish", async () => {
		const { store } = await openTestStore("leaf-exhaustion-containment")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			const definitionRef = { kind: "preset", contentIdentity: "sha256:leaf-exhaustion" } as const
			const leaf = (id: string) => ({
				kind: "leaf",
				identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id },
				state: "pending",
				closure: {
					closureId: `closure-${id}`,
					itemRowId: item.id,
					itemId: item.itemId,
					phase: id,
					lifecycle: "active",
					worktreePath: `/worktrees/${id}`,
					branchName: `branch-${id}`,
					baseCommit: "0123456789abcdef",
					sourceParNodeId: "failure-par",
					sessions: [],
				},
			} as const)
			store.createTaskTree(chain.id, {
				root: {
					kind: "par",
					identity: { runtimeNodeId: "failure-par", definitionRef, definitionNodeId: "failure-par" },
					groupId: "failure-par",
					pinCommit: "0123456789abcdef",
					maxConcurrency: null,
					state: "open",
					reopen: { count: 0, budgetRef: "task.failure-par.reopenBudget:0" },
					join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
					children: [leaf("failed"), leaf("successful-one"), leaf("successful-two")],
				},
				activeRuns: [],
			})
			for (const id of ["successful-one", "successful-two"]) {
				const sourceRunId = `leaf-exhaustion-${id}-run`
				store.recordRun({
					runId: sourceRunId,
					chainId: chain.id,
					itemId: item.id,
					phase: id,
					startedAt: 1_800_000_099,
				})
				store.commitTaskTransition({
					sourceRunId,
					sourceClosureId: `closure-${id}`,
					targetRuntimeNodeId: null,
					pathId: `finish-${id}`,
					exitPayload: {},
					resolvedBindings: {},
					createdAt: 1_800_000_100,
					itemUpdate: { kind: "none" },
				})
			}

			const exhausted = store.exhaustTaskLeaf({
				itemId: item.id,
				runtimeNodeId: "failed",
				status: runtimeStatus("exhausted"),
				extra: storedItemExtra({ fixtureId: item.itemId }),
				updatedAt: 1_800_000_101,
			})

			expect(exhausted).toMatchObject({ runtimeNodeId: "failed", itemTerminal: true, item: { status: "exhausted" } })
			const tree = store.getTaskTree(chain.id)
			expect(tree?.root).toMatchObject({
				kind: "par",
				state: "completed",
				children: [
					{ identity: { runtimeNodeId: "failed" }, state: "exhausted" },
					{ identity: { runtimeNodeId: "successful-one" }, state: "completed" },
					{ identity: { runtimeNodeId: "successful-two" }, state: "completed" },
				],
			})
		} finally {
			store.close()
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
