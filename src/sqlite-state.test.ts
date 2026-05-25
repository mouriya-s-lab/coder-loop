import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import {
	SqliteStateError,
	type ChainRecord,
	type CreateItemInput,
	type ItemRecord,
	openSqliteStateStore,
} from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/sqlite-state-tests", String(process.pid))

let nextRootId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("sqlite state store", () => {
	test("schema covers umbrella contract", async () => {
		const { store } = await openTestStore("schema")
		try {
			expect(store.listTableColumns("chains")).toEqual([
				"id",
				"name",
				"preset",
				"repository",
				"base_branch",
				"umbrella_issue",
				"umbrella_repo",
				"status",
				"metadata",
				"created_at",
				"updated_at",
			])
			expect(store.listTableColumns("items")).toEqual([
				"id",
				"chain_id",
				"issue_number",
				"repo_cwd",
				"status",
				"attempts",
				"title",
				"priority",
				"branch",
				"pr",
				"last_run_id",
				"issue_file",
				"evidence_dir",
				"agent_cwd",
				"runner",
				"extra",
				"created_at",
				"updated_at",
			])
			expect(store.listTableColumns("runs")).toEqual([
				"id",
				"run_id",
				"chain_id",
				"item_id",
				"phase",
				"started_at",
				"ended_at",
				"exit_code",
				"extra",
			])
			expect(store.listTableColumns("current_runs")).toEqual(["chain_id", "phase", "run_id", "started_at", "extra"])
		} finally {
			store.close()
		}
	})

	test("current_runs round-trip", async () => {
		const { store } = await openTestStore("current")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			store.recordRun({
				runId: "run-current",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_001,
				extra: { issue: 177 },
			})

			const expected = {
				chainId: chain.id,
				phase: "iteration",
				runId: "run-current",
				startedAt: 1_800_000_001,
				extra: { issue: 177, nested: { resumed: false } },
			}
			expect(store.setCurrentRun(expected)).toEqual(expected)
			expect(store.getCurrentRun(chain.id)).toEqual(expected)
			expect(store.clearCurrentRun(chain.id)).toBe(true)
			expect(store.getCurrentRun(chain.id)).toBeNull()
		} finally {
			store.close()
		}
	})

	test("items round-trip", async () => {
		const { store } = await openTestStore("item")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)
			expect(store.getItem(item.id)).toEqual(item)
			expect(store.getItemByIssue(chain.id, 177)).toEqual(item)
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

	test("data access CRUD next pending and terminal status", async () => {
		const { store } = await openTestStore("access")
		try {
			const chain = createFullChain(store)
			const first = createFullItem(store, chain, { issueNumber: 177, priority: "20", status: "queued" })
			const second = createFullItem(store, chain, { issueNumber: 179, priority: "10", status: "queued" })
			const otherRepo = createFullItem(store, chain, { issueNumber: 180, repoCwd: "/repo/other", status: "queued" })

			expect(store.getNextPendingItem({ chainId: chain.id, repoCwd: "/repo/coder-loop" })).toEqual(second)
			expect(store.allItemsTerminal({ chainId: chain.id, terminalStatuses: ["done", "moot", "blocked"] })).toBe(false)

			const updatedFirst = store.updateItem(first.id, { status: "done", attempts: 2, branch: "issue-177", pr: 188, updatedAt: 1_800_000_101 })
			expect(updatedFirst.status).toBe("done")
			expect(updatedFirst.branch).toBe("issue-177")
			expect(updatedFirst.pr).toBe(188)
			expect(store.updateItem(second.id, { status: "moot", updatedAt: 1_800_000_102 }).status).toBe("moot")
			expect(store.updateItem(otherRepo.id, { status: "blocked", updatedAt: 1_800_000_103 }).status).toBe("blocked")
			expect(store.allItemsTerminal({ chainId: chain.id, terminalStatuses: ["done", "moot", "blocked"] })).toBe(true)

			const run = store.recordRun({
				runId: "run-data-access",
				chainId: chain.id,
				itemId: first.id,
				phase: "iteration",
				startedAt: 1_800_000_200,
				extra: { issue: 177 },
			})
			expect(store.getRunByRunId("run-data-access")).toEqual(run)
			expect(store.completeRun("run-data-access", { endedAt: 1_800_000_260, exitCode: 0 }).endedAt).toBe(1_800_000_260)

			expect(store.deleteItem(second.id)).toBe(true)
			expect(store.getItem(second.id)).toBeNull()
			expect(store.updateChain(chain.id, { status: "completed", updatedAt: 1_800_000_300 }).status).toBe("completed")
			expect(store.deleteChain(chain.id)).toBe(true)
			expect(store.getChain(chain.id)).toBeNull()
		} finally {
			store.close()
		}
	})

	test("next pending prefers fewer attempts within a priority group", async () => {
		const { store } = await openTestStore("attempt-priority")
		try {
			const chain = createFullChain(store)
			const retried = createFullItem(store, chain, {
				issueNumber: 177,
				status: "changes_requested",
				priority: null,
				attempts: 3,
			})
			const untouched = createFullItem(store, chain, {
				issueNumber: 179,
				status: "queued",
				priority: null,
				attempts: 0,
			})

			expect(retried.id).toBeLessThan(untouched.id)
			expect(store.getNextPendingItem({ chainId: chain.id, repoCwd: "/repo/coder-loop" })).toEqual(untouched)
		} finally {
			store.close()
		}
	})

	test("dependsOn gates pending item selection", async () => {
		const { store } = await openTestStore("depends-gates")
		try {
			const chain = createFullChain(store)
			const prerequisite = createFullItem(store, chain, { issueNumber: 2671, priority: "10", status: "queued" })
			const dependent = createFullItem(store, chain, {
				issueNumber: 2672,
				priority: "00",
				status: "queued",
				extra: { issue: 2672, dependsOn: [prerequisite.id] },
			})
			const fallback = createFullItem(store, chain, { issueNumber: 2673, priority: "20", status: "queued" })

			expect(dependent.id).toBeGreaterThan(prerequisite.id)
			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: ["queued"],
				terminalStatuses: ["done", "moot", "blocked"],
			})).toEqual(prerequisite)
			expect(store.listDependencyWaits({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: ["queued"],
				terminalStatuses: ["done", "moot", "blocked"],
			})).toEqual([{
				itemId: dependent.id,
				issueNumber: 2672,
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
			const prerequisite = createFullItem(store, chain, { issueNumber: 2674, priority: "99", status: "done" })
			const dependent = createFullItem(store, chain, {
				issueNumber: 2675,
				priority: "00",
				status: "queued",
				extra: { issue: 2675, dependsOn: [prerequisite.id] },
			})
			createFullItem(store, chain, { issueNumber: 2676, priority: "10", status: "queued" })

			expect(store.getNextPendingItem({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: ["queued"],
				terminalStatuses: ["done", "moot", "blocked"],
			})).toEqual(dependent)
			expect(store.listDependencyWaits({
				chainId: chain.id,
				repoCwd: "/repo/coder-loop",
				statuses: ["queued"],
				terminalStatuses: ["done", "moot", "blocked"],
			})).toEqual([])
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
			writer.query("UPDATE items SET status = $status WHERE issue_number = $issueNumber").run({
				status: "in_progress",
				issueNumber: 177,
			})

			const readerStore = openSqliteStateStore({ loopDataRoot: dbFileRoot(dbFile) })
			try {
				const visibleItem = readerStore.getItemByIssue(chain.id, 177)
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
		try {
			openSqliteStateStore({ loopDataRoot: missingRoot })
			throw new Error("expected DB open to fail")
		} catch (error) {
			expect(error).toBeInstanceOf(SqliteStateError)
			expect((error as SqliteStateError).code).toBe("db_unavailable")
		}
	})
})

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
		umbrellaIssue: 176,
		umbrellaRepo: "mouriya-s-lab/coder-loop",
		status: "active",
		metadata: { runner: "codex", reviewRunner: "claude", nested: { enabled: true } },
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_010,
	})
}

function createFullItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	overrides: Partial<CreateItemInput> = {},
): ItemRecord {
	return store.createItem({
		chainId: chain.id,
		issueNumber: 177,
		repoCwd: "/repo/coder-loop",
		status: "queued",
		attempts: 1,
		title: "feat: SQLite 状态存储与 LoopState 完整映射",
		priority: "10",
		branch: "issue-177",
		pr: 188,
		lastRunId: "run-177",
		issueFile: "issues/177.md",
		evidenceDir: "evidence/177",
		agentCwd: "/repo/coder-loop",
		runner: "codex",
		extra: { issue: 177, phase: "A", nested: { db: true } },
		createdAt: 1_800_000_020,
		updatedAt: 1_800_000_030,
		...overrides,
	})
}

function dbFileRoot(dbFile: string): string {
	return dbFile.slice(0, -"db.sqlite".length - 1)
}
