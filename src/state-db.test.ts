import { describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import {
	addItem,
	allItemsTerminal,
	completeChain,
	createChain,
	finishRun,
	getChain,
	getItem,
	getNextPending,
	listActiveChains,
	listChains,
	listRepoCwdsForChain,
	openStateDb,
	openStateStore,
	recordRun,
	updateItem,
} from "./state-db"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DB_TEST_ROOT = resolve(REPO_ROOT, ".cache/state-db-tests")

async function withStateDb<T>(name: string, fn: (db: Database, path: string) => T | Promise<T>): Promise<T> {
	await mkdir(DB_TEST_ROOT, { recursive: true })
	const path = resolve(DB_TEST_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
	const db = openStateDb(path)
	try {
		return await fn(db, path)
	} finally {
		db.close()
		await rm(path, { force: true })
		await rm(`${path}-shm`, { force: true })
		await rm(`${path}-wal`, { force: true })
	}
}

describe("state-db", () => {
	test("creates the core schema and enables WAL mode", async () => {
		await withStateDb("schema", (db) => {
			const tables = db.query(`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table'
				ORDER BY name
			`).all() as Array<{ name: string }>
			const indexes = db.query(`
				SELECT name
				FROM sqlite_master
				WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
				ORDER BY name
			`).all() as Array<{ name: string }>
			const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string }

			expect(tables.map((row) => row.name)).toEqual(["chains", "items", "runs"])
			expect(indexes.map((row) => row.name)).toEqual([
				"idx_chains_status",
				"idx_items_chain_status",
				"idx_items_next_pending",
				"idx_runs_chain_started_at",
				"idx_runs_item_phase",
			])
			expect(journalMode.journal_mode).toBe("wal")
		})
	})

	test("stores chains with umbrella fields and JSON metadata", async () => {
		await withStateDb("chains", (db) => {
			const created = createChain(
				db,
				"umbrella-123",
				"gh-issue-pr-iteration",
				"mouriya-s-lab/coder-loop",
				"main",
				123,
				"mouriya-s-lab/coder-loop",
				{ source: "test", retry: false },
			)

			expect(created.status).toBe("active")
			expect(created.umbrellaIssue).toBe(123)
			expect(created.umbrellaRepo).toBe("mouriya-s-lab/coder-loop")
			expect(created.metadata).toEqual({ source: "test", retry: false })
			expect(getChain(db, created.id)).toEqual(created)
			expect(getChain(db, "umbrella-123")).toEqual(created)
			expect(listChains(db)).toEqual([created])
			expect(listActiveChains(db)).toEqual([created])

			const completed = completeChain(db, created.id)
			expect(completed.status).toBe("completed")
			expect(completed.completedAt).toEqual(expect.any(String))
			expect(listActiveChains(db)).toEqual([])
		})
	})

	test("provides a store wrapper with direct access methods", async () => {
		await mkdir(DB_TEST_ROOT, { recursive: true })
		const path = resolve(DB_TEST_ROOT, `store-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
		const store = openStateStore(path)
		try {
			const chain = store.createChain("store-chain", "preset")
			const item = store.addItem(chain.id, { issue: 9, repoCwd: "/repo" })
			store.recordRun({ id: "run-store", chainId: chain.id, itemId: item.id, phase: "iteration", runner: "codex" })

			expect(store.getChain("store-chain")?.id).toBe(chain.id)
			expect(store.getNextPending(chain.id, "/repo")?.issue).toBe(9)
			expect(store.finishRun("run-store", { exitCode: 0, terminated: { kind: "clean" } }).exitCode).toBe(0)
		} finally {
			store.close()
			await rm(path, { force: true })
			await rm(`${path}-shm`, { force: true })
			await rm(`${path}-wal`, { force: true })
		}
	})

	test("adds, updates, and selects queue items by chain and repo slot", async () => {
		await withStateDb("items", (db) => {
			const chain = createChain(db, "chain", "preset")
			const low = addItem(db, chain.id, {
				issue: 1,
				repoCwd: "/repo/a",
				priority: "low",
				title: "low priority",
				extra: { issueKind: "code" },
			})
			const high = addItem(db, chain.id, {
				issue: 2,
				repoCwd: "/repo/a",
				priority: "high",
				title: "high priority",
				runner: "codex",
			})
			const retry = addItem(db, chain.id, {
				issue: 4,
				repoCwd: "/repo/a",
				status: "changes_requested",
				priority: "high",
				title: "retry priority",
			})
			addItem(db, chain.id, { issue: 3, repoCwd: "/repo/b", priority: "high" })

			expect(getItem(db, low.id)?.extra).toEqual({ issueKind: "code" })
			expect(listRepoCwdsForChain(db, chain.id)).toEqual(["/repo/a", "/repo/b"])
			expect(getNextPending(db, chain.id, "/repo/a")?.id).toBe(high.id)
			expect(getNextPending(db, chain.id, "/repo/b")?.issue).toBe(3)

			const updated = updateItem(db, high.id, {
				status: "done",
				attempts: 1,
				branch: "issue-2",
				pr: 10,
				lastRunId: "run-2",
				issueFile: ".coder-loop/runtime/issues/2.md",
				evidenceDir: ".coder-loop/runtime/evidence/issue-2",
				agentCwd: "/repo/a",
				extra: { reviewed: true },
			})

			expect(updated.status).toBe("done")
			expect(updated.runner).toBe("codex")
			expect(updated.extra).toEqual({ reviewed: true })
			expect(getNextPending(db, chain.id, "/repo/a")?.id).toBe(retry.id)
			expect(allItemsTerminal(db, chain.id, ["done"])).toBe(false)
			updateItem(db, retry.id, { status: "done" })
			updateItem(db, low.id, { status: "done" })
			updateItem(db, getNextPending(db, chain.id, "/repo/b")?.id ?? 0, { status: "done" })
			expect(allItemsTerminal(db, chain.id, ["done"])).toBe(true)
		})
	})

	test("records and finishes agent runs", async () => {
		await withStateDb("runs", (db) => {
			const chain = createChain(db, "chain", "preset")
			const item = addItem(db, chain.id, { issue: 1, repoCwd: "/repo" })
			const recorded = recordRun(db, {
				id: "run-1",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				runner: "codex",
				startedAt: "2026-05-20T00:00:00.000Z",
				logPath: ".coder-loop/runtime/logs/run-1.jsonl",
				statusPath: ".coder-loop/runtime/logs/run-1.status.json",
			})

			expect(recorded.finishedAt).toBeNull()
			expect(recorded.exitCode).toBeNull()

			const finished = finishRun(db, "run-1", {
				finishedAt: "2026-05-20T00:01:00.000Z",
				exitCode: 0,
				terminated: { kind: "clean" },
			})

			expect(finished.finishedAt).toBe("2026-05-20T00:01:00.000Z")
			expect(finished.exitCode).toBe(0)
			expect(finished.terminated).toEqual({ kind: "clean" })
		})
	})

	test("allows a reader query while another connection holds an uncommitted write transaction", async () => {
		await withStateDb("wal-reader", async (writerDb, path) => {
			const readerDb = openStateDb(path)
			try {
				const readDuringWrite = writerDb.transaction(() => {
					writerDb.query("INSERT INTO chains (name, preset) VALUES (?, ?)").run("pending", "preset")
					const row = readerDb.query("SELECT COUNT(*) AS count FROM chains").get() as { count: number }
					return row.count
				})

				expect(readDuringWrite()).toBe(0)
				const afterCommit = readerDb.query("SELECT COUNT(*) AS count FROM chains").get() as { count: number }
				expect(afterCommit.count).toBe(1)
			} finally {
				readerDb.close()
			}
		})
	})
})
