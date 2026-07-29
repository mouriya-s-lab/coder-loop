import { describe, expect, test } from "bun:test"

import {
	Database,
	resolve,
	SqliteStateError,
	openSqliteStateStore,
	itemExtraToJsonObject,
	storedChainMetadata,
	storedItemExtra,
	CreateItemInput,
	TEST_ROOT,
	runtimeStatus,
	captureSqliteError,
	openTestStore,
	createFullChain,
	createFullItem,
	definitionRunExtra,
	singleLeafTree,
	twoPhaseLeafTree,
	dbFileRoot,
} from "./helpers"

describe("sqlite state store", () => {
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

	test("deleteItem removes normalized leaf ownership and run history", async () => {
		const { store } = await openTestStore("delete-normalized-item")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.createTaskTree(chain.id, singleLeafTree(item))
			const run = store.recordRun({
				runId: "delete-normalized-run",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_320,
			})
			store.completeRun(run.runId, { endedAt: 1_800_000_321, exitCode: 0, status: runtimeStatus("done") })

			expect(store.deleteItem(item.id)).toBe(true)
			expect(store.getItem(item.id)).toBeNull()
			expect(store.getRunByRunId(run.runId)).toBeNull()
			expect(store.getTaskTree(chain.id)).toBeNull()
		} finally { store.close() }
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

})

