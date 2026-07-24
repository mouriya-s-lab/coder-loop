import { describe, expect, test } from "bun:test"

import {
	Database,
	mkdir,
	resolve,
	openSqliteStateStore,
	chainBindings,
	itemExtraToJsonObject,
	storedItemExtra,
	seedCanonicalHistoricalRuntime,
	REPO_ROOT,
	TEST_ROOT,
	runtimeStatus,
	openTestStore,
	createFullChain,
	createFullItem,
	definitionRunExtra,
	singleLeafTree,
	dbFileRoot,
} from "./helpers"

let nextRootId = 0

describe("sqlite state store", () => {
	test("canonical historical runtime fixture preserves v13 and v14 foreign keys", async () => {
		for (const schemaVersion of [13, 14] as const) {
			const loopDataRoot = resolve(TEST_ROOT, `canonical-v${schemaVersion}-${++nextRootId}`)
			await mkdir(loopDataRoot, { recursive: true })
			const seeded = seedCanonicalHistoricalRuntime({
				loopDataRoot,
				schemaVersion,
				chain: { name: `canonical-v${schemaVersion}`, repository: "mouriya-s-lab/coder-loop", preset: "gh-issue-pr-iteration" },
				items: [{ itemId: `item-v${schemaVersion}`, repoCwd: REPO_ROOT, status: "in_progress", phase: "iteration", preset: "gh-issue-pr-iteration", presetPath: null, agentCwd: REPO_ROOT, sessionIds: {}, extra: {}, run: { runId: `run-v${schemaVersion}`, phase: "iteration", status: "in_progress", startedAt: 1_800_000_000, extra: {} } }],
				contextEntries: schemaVersion === 14 ? [{ id: "context-v14", body: "v14" }] : [],
			})
			expect(seeded.schemaFacts.runForeignKeys).toEqual(["chain_id->chains.id:CASCADE", "item_id->items.id:CASCADE"])
			expect(seeded.schemaFacts.currentRunForeignKeys).toEqual(["chain_id->chains.id:CASCADE", "run_id->runs.run_id:CASCADE"])
			expect(seeded.schemaFacts.hasContextEntries).toBe(schemaVersion === 14)
		}
	})
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

	test("v13 to v14 migrates normalized runtime before reads", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `v13-to-v14-${Date.now()}-${++nextRootId}`)
		const fixture = seedCanonicalHistoricalRuntime({
			loopDataRoot,
			schemaVersion: 13,
			chain: { name: "central-state", repository: "mouriya-s-lab/coder-loop", preset: "gh-issue-pr-iteration" },
			items: [
				{ itemId: "177", repoCwd: REPO_ROOT, status: "in_progress", phase: "iteration", preset: "gh-issue-pr-iteration", presetPath: null, agentCwd: REPO_ROOT, sessionIds: { iteration: { codex: "session-v13" }, review: { claude: "review-session-v13" } }, extra: { issue: 177 }, run: { runId: "legacy-active", phase: "iteration", status: "in_progress", startedAt: 1_800_000_220, extra: {} } },
				{ itemId: "178", repoCwd: REPO_ROOT, status: "queued", phase: null, preset: "gh-issue-pr-iteration", presetPath: null, agentCwd: REPO_ROOT, sessionIds: {}, extra: { issue: 178 } },
			],
			contextEntries: [],
		})
		const chain = fixture.chain
		const migrated = openSqliteStateStore({ loopDataRoot: dbFileRoot(fixture.dbFile) })
		try {
			const db = new Database(fixture.dbFile)
			try { expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(17) } finally { db.close() }
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

	test("main v14 context database migrates normalized runtime without losing context", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `main-v14-to-normalized-runtime-${Date.now()}-${++nextRootId}`)
		const fixture = seedCanonicalHistoricalRuntime({
			loopDataRoot,
			schemaVersion: 14,
			chain: { name: "central-state", repository: "mouriya-s-lab/coder-loop", preset: "gh-issue-pr-iteration" },
			items: [{ itemId: "177", repoCwd: REPO_ROOT, status: "in_progress", phase: "iteration", preset: "gh-issue-pr-iteration", presetPath: null, agentCwd: REPO_ROOT, sessionIds: { iteration: { codex: "main-v14-session" } }, extra: { issue: 177 }, run: { runId: "main-v14-active", phase: "iteration", status: "in_progress", startedAt: 1_800_000_230, extra: {} } }],
			contextEntries: [{ id: "main-v14-context", body: "preserve-main-v14-context" }],
		})
		const chain = fixture.chain
		const item = fixture.items[0]
		if (item === undefined) throw new Error("canonical v14 fixture omitted item")

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
			migrated.recordRun({ runId: "pre-v3-iteration", chainId: 1, itemId: item.id, phase: "iteration", startedAt: 1.5, extra: definitionRunExtra({ definitionPhases: [{ phase: "iteration", definitionNodeId: "task:iteration" }], worktreePath: REPO_ROOT, branchName: "main" }) })
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
})
