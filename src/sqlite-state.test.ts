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
				"last_session_id",
				"session_ids",
				"issue_file",
				"evidence_dir",
				"agent_cwd",
				"runner",
				"phase",
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

	test("item session id helpers isolate values by phase and runner", async () => {
		const { store } = await openTestStore("item-session-ids")
		try {
			const chain = createFullChain(store)
			const item = createFullItem(store, chain)

			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBeNull()

			const withIteration = store.setItemSessionId(item.id, {
				phase: "iteration",
				runner: "codex",
				sessionId: "thread-codex-123",
				updatedAt: 1_800_000_040,
			})
			expect(withIteration.sessionIds).toEqual({ iteration: { codex: "thread-codex-123" } })
			expect(withIteration.lastSessionId).toBeNull()

			const withReview = store.setItemSessionId(item.id, {
				phase: "review",
				runner: "claude",
				sessionId: "thread-claude-456",
				updatedAt: 1_800_000_041,
			})
			expect(withReview.sessionIds).toEqual({
				iteration: { codex: "thread-codex-123" },
				review: { claude: "thread-claude-456" },
			})
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-codex-123")
			expect(store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("thread-claude-456")
			expect(store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()

			const cleared = store.setItemSessionId(item.id, {
				phase: "iteration",
				runner: "codex",
				sessionId: null,
				updatedAt: 1_800_000_042,
			})
			expect(cleared.sessionIds).toEqual({ review: { claude: "thread-claude-456" } })
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

	test("createItems happy path inserts every input atomically", async () => {
		const { store } = await openTestStore("batch-happy")
		try {
			const chain = createFullChain(store)
			const inputs: CreateItemInput[] = [
				{ chainId: chain.id, issueNumber: 311, repoCwd: "/repo/coder-loop", status: "queued", title: "first" },
				{ chainId: chain.id, issueNumber: 312, repoCwd: "/repo/coder-loop", status: "queued", title: "second" },
				{ chainId: chain.id, issueNumber: 313, repoCwd: "/repo/coder-loop", status: "queued", title: "third" },
			]
			const inserted = store.createItems(inputs)
			expect(inserted.map((item) => item.issueNumber)).toEqual([311, 312, 313])
			expect(store.listItems(chain.id).map((item) => item.issueNumber)).toEqual([311, 312, 313])
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

			let caught: unknown = null
			try {
				store.createItems([
					{ chainId: chain.id, issueNumber: 321, repoCwd: "/repo/coder-loop", status: "queued", title: "before conflict" },
					{ chainId: chain.id, issueNumber: 322, repoCwd: "/repo/coder-loop", status: "queued", title: "conflict (UNIQUE chain_id,issue_number)" },
					{ chainId: chain.id, issueNumber: 323, repoCwd: "/repo/coder-loop", status: "queued", title: "after conflict" },
				])
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(SqliteStateError)
			expect((caught as SqliteStateError).code).toBe("sqlite_error")
			expect((caught as SqliteStateError).message).toContain("create items")

			expect(store.getItemByIssue(chain.id, 321)).toBeNull()
			expect(store.getItemByIssue(chain.id, 323)).toBeNull()
			const occupantAfter = store.getItemByIssue(chain.id, 322)
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
			expect(item.issueNumber).toBe(999)
			const updated = migrated.updateItem(item.id, { phase: "iteration", updatedAt: 2.0 })
			expect(updated.phase).toBe("iteration")
			expect(migrated.getItem(item.id)?.phase).toBe("iteration")
		} finally {
			migrated.close()
		}

		const reopened = openSqliteStateStore({ loopDataRoot })
		try {
			const item = reopened.getItemByIssue(1, 999)
			expect(item?.phase).toBe("iteration")
		} finally {
			reopened.close()
		}
	})

	test("lastSessionId migration is idempotent across repeated opens (issue #291 AC2)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `last-session-id-idempotent-${Date.now()}-${++nextRootId}`)
		await mkdir(loopDataRoot, { recursive: true })

		const first = openSqliteStateStore({ loopDataRoot })
		try {
			expect(first.listTableColumns("items")).toContain("last_session_id")
			expect(first.listTableColumns("items")).toContain("session_ids")
		} finally {
			first.close()
		}

		const second = openSqliteStateStore({ loopDataRoot })
		try {
			expect(second.listTableColumns("items")).toContain("last_session_id")
			expect(second.listTableColumns("items")).toContain("session_ids")
			const chain = createFullChain(second)
			const item = createFullItem(second, chain)
			expect(item.lastSessionId).toBeNull()
			expect(item.sessionIds).toEqual({})

			const updated = second.updateItem(item.id, { lastSessionId: "sess-abc" })
			expect(updated.lastSessionId).toBe("sess-abc")
			expect(second.getItem(item.id)?.lastSessionId).toBe("sess-abc")
		} finally {
			second.close()
		}

		const third = openSqliteStateStore({ loopDataRoot })
		try {
			expect(third.listTableColumns("items")).toContain("last_session_id")
			expect(third.listTableColumns("items")).toContain("session_ids")
		} finally {
			third.close()
		}
	})

	test("sessionIds migration maps legacy last_session_id by current phase and chain runner (issue #310 AC3)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `session-ids-legacy-${Date.now()}-${++nextRootId}`)
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
				PRAGMA user_version = 3;
			`)
			legacy.exec(`
				INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
				VALUES ('legacy-session-ids', 'gh-issue-pr-iteration', 'mouriya-s-lab/coder-loop', 'main', 'active', '{"runner":"codex","reviewRunner":"claude"}', 1.0, 1.0)
			`)
			legacy.exec(`
				INSERT INTO items (chain_id, issue_number, repo_cwd, status, attempts, last_session_id, phase, extra, created_at, updated_at)
				VALUES (1, 310, '/repo/legacy', 'queued', 0, 'd400e2b2-04a4-44f8-8f13-3078f41a5593', 'iteration', '{}', 1.0, 1.0)
			`)
			const columnsBefore = legacy.query<{ name: string }, []>("PRAGMA table_info(items)").all().map((row) => row.name)
			expect(columnsBefore).toContain("last_session_id")
			expect(columnsBefore).not.toContain("session_ids")
		} finally {
			legacy.close()
		}

		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			expect(migrated.listTableColumns("items")).toContain("session_ids")
			const item = migrated.getItemByIssue(1, 310)
			expect(item?.lastSessionId).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
			expect(item?.sessionIds).toEqual({
				iteration: { codex: "d400e2b2-04a4-44f8-8f13-3078f41a5593" },
			})
			expect(migrated.getItemSessionId(item!.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
		} finally {
			migrated.close()
		}
	})

	test("lastSessionId migration adds column to pre-v3 DB created without last_session_id (issue #291 AC2)", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `last-session-id-legacy-${Date.now()}-${++nextRootId}`)
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
			expect(migrated.listTableColumns("items")).toContain("last_session_id")
			expect(migrated.listTableColumns("items")).toContain("session_ids")
			const items = migrated.listItems(1)
			expect(items).toHaveLength(1)
			const item = items[0]!
			expect(item.lastSessionId).toBeNull()
			expect(item.sessionIds).toEqual({})
			const updated = migrated.updateItem(item.id, { lastSessionId: "sess-from-legacy", updatedAt: 2.0 })
			expect(updated.lastSessionId).toBe("sess-from-legacy")
			expect(migrated.getItem(item.id)?.lastSessionId).toBe("sess-from-legacy")
		} finally {
			migrated.close()
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
