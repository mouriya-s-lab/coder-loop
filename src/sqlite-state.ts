import { Database } from "bun:sqlite"

import type { AgentRunnerKind, JsonObject, JsonValue } from "./loop"
import { type LoopDataRootOptions, resolveLoopDataPaths } from "./runtime-paths"

export type SqliteStateErrorCode =
	| "db_unavailable"
	| "sqlite_error"
	| "invalid_json"
	| "not_found"
	| "invalid_input"

export class SqliteStateError extends Error {
	constructor(
		readonly code: SqliteStateErrorCode,
		message: string,
		readonly details: JsonObject = {},
	) {
		super(message)
		this.name = "SqliteStateError"
	}
}

export type ChainStatus = "active" | "completed" | "deleted"

export type ChainRecord = {
	id: number
	name: string
	preset: string
	repository: string
	baseBranch: string
	umbrellaIssue: number | null
	umbrellaRepo: string | null
	status: ChainStatus
	metadata: JsonObject
	createdAt: number
	updatedAt: number
}

export type CreateChainInput = {
	name: string
	preset: string
	repository: string
	baseBranch: string
	umbrellaIssue?: number | null
	umbrellaRepo?: string | null
	status?: ChainStatus
	metadata?: JsonObject
	createdAt?: number
	updatedAt?: number
}

export type UpdateChainInput = Partial<Omit<CreateChainInput, "createdAt">> & {
	updatedAt?: number
}

export type ItemRecord = {
	id: number
	chainId: number
	issueNumber: number
	repoCwd: string
	status: string
	attempts: number
	title: string | null
	priority: string | null
	branch: string | null
	pr: number | null
	lastRunId: string | null
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string | null
	runner: AgentRunnerKind | null
	extra: JsonObject
	createdAt: number
	updatedAt: number
}

export type CreateItemInput = {
	chainId: number
	issueNumber: number
	repoCwd: string
	status: string
	attempts?: number
	title?: string | null
	priority?: string | null
	branch?: string | null
	pr?: number | null
	lastRunId?: string | null
	issueFile?: string | null
	evidenceDir?: string | null
	agentCwd?: string | null
	runner?: AgentRunnerKind | null
	extra?: JsonObject
	createdAt?: number
	updatedAt?: number
}

export type UpdateItemInput = Partial<Omit<CreateItemInput, "chainId" | "issueNumber" | "createdAt">> & {
	updatedAt?: number
}

export type RunRecord = {
	id: number
	runId: string
	chainId: number
	itemId: number
	phase: string
	startedAt: number
	endedAt: number | null
	exitCode: number | null
	extra: JsonObject
}

export type RecordRunInput = {
	runId: string
	chainId: number
	itemId: number
	phase: string
	startedAt: number
	endedAt?: number | null
	exitCode?: number | null
	extra?: JsonObject
}

export type CompleteRunInput = {
	endedAt: number
	exitCode: number
	extra?: JsonObject
}

export type CurrentRunRecord = {
	chainId: number
	phase: string
	runId: string
	startedAt: number
	extra: JsonObject
}

export type SetCurrentRunInput = CurrentRunRecord

export type GetNextPendingItemInput = {
	chainId: number
	repoCwd: string
	statuses?: readonly string[]
}

export type AllItemsTerminalInput = {
	chainId: number
	terminalStatuses: readonly string[]
}

export type StateTableName = "chains" | "items" | "runs" | "current_runs"

export type SqliteStateStoreOptions = LoopDataRootOptions

export type SqliteStateStore = {
	close: () => void
	getJournalMode: () => string
	listTableColumns: (table: StateTableName) => string[]
	createChain: (input: CreateChainInput) => ChainRecord
	getChain: (id: number) => ChainRecord | null
	getChainByName: (name: string) => ChainRecord | null
	listChains: () => ChainRecord[]
	updateChain: (id: number, input: UpdateChainInput) => ChainRecord
	deleteChain: (id: number) => boolean
	createItem: (input: CreateItemInput) => ItemRecord
	getItem: (id: number) => ItemRecord | null
	getItemByIssue: (chainId: number, issueNumber: number) => ItemRecord | null
	listItems: (chainId: number) => ItemRecord[]
	updateItem: (id: number, input: UpdateItemInput) => ItemRecord
	deleteItem: (id: number) => boolean
	getNextPendingItem: (input: GetNextPendingItemInput) => ItemRecord | null
	allItemsTerminal: (input: AllItemsTerminalInput) => boolean
	recordRun: (input: RecordRunInput) => RunRecord
	getRunByRunId: (runId: string) => RunRecord | null
	completeRun: (runId: string, input: CompleteRunInput) => RunRecord
	setCurrentRun: (input: SetCurrentRunInput) => CurrentRunRecord
	getCurrentRun: (chainId: number) => CurrentRunRecord | null
	clearCurrentRun: (chainId: number) => boolean
}

type SqlParamValue = string | number | bigint | boolean | Uint8Array | null
type SqlParams = Record<string, SqlParamValue>

type ChainRow = {
	id: number
	name: string
	preset: string
	repository: string
	base_branch: string
	umbrella_issue: number | null
	umbrella_repo: string | null
	status: string
	metadata: string
	created_at: number
	updated_at: number
}

type ItemRow = {
	id: number
	chain_id: number
	issue_number: number
	repo_cwd: string
	status: string
	attempts: number
	title: string | null
	priority: string | null
	branch: string | null
	pr: number | null
	last_run_id: string | null
	issue_file: string | null
	evidence_dir: string | null
	agent_cwd: string | null
	runner: string | null
	extra: string
	created_at: number
	updated_at: number
}

type RunRow = {
	id: number
	run_id: string
	chain_id: number
	item_id: number
	phase: string
	started_at: number
	ended_at: number | null
	exit_code: number | null
	extra: string
}

type CurrentRunRow = {
	chain_id: number
	phase: string
	run_id: string
	started_at: number
	extra: string
}

type JournalModeRow = {
	journal_mode: string
}

type TableColumnRow = {
	name: string
}

type TableCountRow = {
	table_count: number
}

const STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chains (
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

CREATE TABLE IF NOT EXISTS items (
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

CREATE TABLE IF NOT EXISTS runs (
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

CREATE TABLE IF NOT EXISTS current_runs (
	chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
	started_at REAL NOT NULL,
	extra TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_next_pending ON items(chain_id, repo_cwd, status, priority, id);
CREATE INDEX IF NOT EXISTS idx_items_chain_status ON items(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_chain_item ON runs(chain_id, item_id);
`

export function openSqliteStateStore(options: SqliteStateStoreOptions = {}): SqliteStateStore {
	const dbFile = resolveLoopDataPaths(options).dbFile
	let db: Database
	try {
		db = new Database(dbFile, { create: true, readwrite: true, strict: true })
	} catch (error) {
		throw new SqliteStateError("db_unavailable", `unable to open SQLite state DB at ${dbFile}: ${errorMessage(error)}`, {
			dbFile,
		})
	}

	try {
		db.exec("PRAGMA foreign_keys = ON")
		db.exec("PRAGMA busy_timeout = 5000")
		const currentJournal = db.query<JournalModeRow, []>("PRAGMA journal_mode").get()?.journal_mode.toLowerCase()
		if (currentJournal !== "wal") {
			const journal = db.query<JournalModeRow, []>("PRAGMA journal_mode = WAL").get()
			if (journal?.journal_mode.toLowerCase() !== "wal") {
				throw new SqliteStateError("sqlite_error", `expected WAL journal mode, got ${journal?.journal_mode ?? "unknown"}`, {
					dbFile,
				})
			}
		}
		if (!stateSchemaExists(db)) {
			db.transaction(() => {
				db.exec(STATE_SCHEMA_SQL)
			}).immediate()
		}
	} catch (error) {
		db.close()
		throw translateSqliteError(error, "initialize state schema", { dbFile })
	}

	return createSqliteStateStore(db)
}

function stateSchemaExists(db: Database): boolean {
	const row = db.query<TableCountRow, []>(`
		SELECT COUNT(*) AS table_count
		FROM sqlite_master
		WHERE type = 'table'
			AND name IN ('chains', 'items', 'runs', 'current_runs')
	`).get()
	return row?.table_count === 4
}

function createSqliteStateStore(db: Database): SqliteStateStore {
	const write = <T>(operation: string, fn: () => T): T => {
		try {
			return db.transaction(fn).immediate()
		} catch (error) {
			throw translateSqliteError(error, operation)
		}
	}

	const read = <T>(operation: string, fn: () => T): T => {
		try {
			return fn()
		} catch (error) {
			throw translateSqliteError(error, operation)
		}
	}

	const getChainRow = (id: number): ChainRow | null =>
		db.query<ChainRow, SqlParams>("SELECT * FROM chains WHERE id = $id").get({ id: id })
	const getItemRow = (id: number): ItemRow | null =>
		db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE id = $id").get({ id: id })
	const getRunRowByRunId = (runId: string): RunRow | null =>
		db.query<RunRow, SqlParams>("SELECT * FROM runs WHERE run_id = $runId").get({ runId: runId })
	const getCurrentRunRow = (chainId: number): CurrentRunRow | null =>
		db.query<CurrentRunRow, SqlParams>("SELECT * FROM current_runs WHERE chain_id = $chainId").get({ chainId: chainId })

	return {
		close: () => db.close(),

		getJournalMode: () =>
			read("read journal mode", () => db.query<JournalModeRow, []>("PRAGMA journal_mode").get()?.journal_mode ?? "unknown"),

		listTableColumns: (table) =>
			read("list schema columns", () => db.query<TableColumnRow, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name)),

		createChain: (input) =>
			write("create chain", () => {
				const now = unixSeconds()
				const createdAt = input.createdAt ?? now
				const updatedAt = input.updatedAt ?? createdAt
				const result = db.query<unknown, SqlParams>(`
					INSERT INTO chains (name, preset, repository, base_branch, umbrella_issue, umbrella_repo, status, metadata, created_at, updated_at)
					VALUES ($name, $preset, $repository, $baseBranch, $umbrellaIssue, $umbrellaRepo, $status, $metadata, $createdAt, $updatedAt)
				`).run({
					name: input.name,
					preset: input.preset,
					repository: input.repository,
					baseBranch: input.baseBranch,
					umbrellaIssue: input.umbrellaIssue ?? null,
					umbrellaRepo: input.umbrellaRepo ?? null,
					status: input.status ?? "active",
					metadata: stringifyJsonObject(input.metadata ?? {}),
					createdAt: createdAt,
					updatedAt: updatedAt,
				})
				return requireChain(getChainRow(Number(result.lastInsertRowid)), Number(result.lastInsertRowid))
			}),

		getChain: (id) => read("get chain", () => rowToChain(getChainRow(id))),

		getChainByName: (name) =>
			read("get chain by name", () => rowToChain(db.query<ChainRow, SqlParams>("SELECT * FROM chains WHERE name = $name").get({ name: name }))),

		listChains: () =>
			read("list chains", () => db.query<ChainRow, []>("SELECT * FROM chains ORDER BY id ASC").all().map((row) => requireChain(row, row.id))),

		updateChain: (id, input) =>
			write("update chain", () => {
				const current = requireChain(getChainRow(id), id)
				const next: ChainRecord = {
					...current,
					name: input.name ?? current.name,
					preset: input.preset ?? current.preset,
					repository: input.repository ?? current.repository,
					baseBranch: input.baseBranch ?? current.baseBranch,
					umbrellaIssue: input.umbrellaIssue === undefined ? current.umbrellaIssue : input.umbrellaIssue,
					umbrellaRepo: input.umbrellaRepo === undefined ? current.umbrellaRepo : input.umbrellaRepo,
					status: input.status ?? current.status,
					metadata: input.metadata ?? current.metadata,
					updatedAt: input.updatedAt ?? unixSeconds(),
				}
				db.query<unknown, SqlParams>(`
					UPDATE chains
					SET name = $name, preset = $preset, repository = $repository, base_branch = $baseBranch,
						umbrella_issue = $umbrellaIssue, umbrella_repo = $umbrellaRepo, status = $status,
						metadata = $metadata, updated_at = $updatedAt
					WHERE id = $id
				`).run(chainParams(next))
				return requireChain(getChainRow(id), id)
			}),

		deleteChain: (id) =>
			write("delete chain", () => db.query<unknown, SqlParams>("DELETE FROM chains WHERE id = $id").run({ id: id }).changes > 0),

		createItem: (input) =>
			write("create item", () => {
				const now = unixSeconds()
				const createdAt = input.createdAt ?? now
				const updatedAt = input.updatedAt ?? createdAt
				const result = db.query<unknown, SqlParams>(`
					INSERT INTO items (
						chain_id, issue_number, repo_cwd, status, attempts, title, priority, branch, pr, last_run_id,
						issue_file, evidence_dir, agent_cwd, runner, extra, created_at, updated_at
					)
					VALUES (
						$chainId, $issueNumber, $repoCwd, $status, $attempts, $title, $priority, $branch, $pr, $lastRunId,
						$issueFile, $evidenceDir, $agentCwd, $runner, $extra, $createdAt, $updatedAt
					)
				`).run({
					chainId: input.chainId,
					issueNumber: input.issueNumber,
					repoCwd: input.repoCwd,
					status: input.status,
					attempts: input.attempts ?? 0,
					title: input.title ?? null,
					priority: input.priority ?? null,
					branch: input.branch ?? null,
					pr: input.pr ?? null,
					lastRunId: input.lastRunId ?? null,
					issueFile: input.issueFile ?? null,
					evidenceDir: input.evidenceDir ?? null,
					agentCwd: input.agentCwd ?? null,
					runner: input.runner ?? null,
					extra: stringifyJsonObject(input.extra ?? {}),
					createdAt: createdAt,
					updatedAt: updatedAt,
				})
				return requireItem(getItemRow(Number(result.lastInsertRowid)), Number(result.lastInsertRowid))
			}),

		getItem: (id) => read("get item", () => rowToItem(getItemRow(id))),

		getItemByIssue: (chainId, issueNumber) =>
			read("get item by issue", () =>
				rowToItem(
					db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId AND issue_number = $issueNumber").get({
						chainId: chainId,
						issueNumber: issueNumber,
					}),
				),
			),

		listItems: (chainId) =>
			read("list items", () =>
				db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY id ASC").all({ chainId: chainId }).map((row) => requireItem(row, row.id)),
			),

		updateItem: (id, input) =>
			write("update item", () => {
				const current = requireItem(getItemRow(id), id)
				const next: ItemRecord = {
					...current,
					repoCwd: input.repoCwd ?? current.repoCwd,
					status: input.status ?? current.status,
					attempts: input.attempts ?? current.attempts,
					title: input.title === undefined ? current.title : input.title,
					priority: input.priority === undefined ? current.priority : input.priority,
					branch: input.branch === undefined ? current.branch : input.branch,
					pr: input.pr === undefined ? current.pr : input.pr,
					lastRunId: input.lastRunId === undefined ? current.lastRunId : input.lastRunId,
					issueFile: input.issueFile === undefined ? current.issueFile : input.issueFile,
					evidenceDir: input.evidenceDir === undefined ? current.evidenceDir : input.evidenceDir,
					agentCwd: input.agentCwd === undefined ? current.agentCwd : input.agentCwd,
					runner: input.runner === undefined ? current.runner : input.runner,
					extra: input.extra ?? current.extra,
					updatedAt: input.updatedAt ?? unixSeconds(),
				}
				db.query<unknown, SqlParams>(`
					UPDATE items
					SET repo_cwd = $repoCwd, status = $status, attempts = $attempts, title = $title,
						priority = $priority, branch = $branch, pr = $pr, last_run_id = $lastRunId,
						issue_file = $issueFile, evidence_dir = $evidenceDir, agent_cwd = $agentCwd,
						runner = $runner, extra = $extra, updated_at = $updatedAt
					WHERE id = $id
				`).run(itemParams(next))
				return requireItem(getItemRow(id), id)
			}),

		deleteItem: (id) =>
			write("delete item", () => db.query<unknown, SqlParams>("DELETE FROM items WHERE id = $id").run({ id: id }).changes > 0),

		getNextPendingItem: (input) =>
			read("get next pending item", () => {
				const statuses = input.statuses ?? ["queued", "changes_requested"]
				return selectNextPendingItem(
					db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId AND repo_cwd = $repoCwd ORDER BY id ASC").all({
						chainId: input.chainId,
						repoCwd: input.repoCwd,
					}).map((row) => requireItem(row, row.id)),
					statuses,
				)
			}),

		allItemsTerminal: (input) =>
			read("check all items terminal", () => {
				const terminal = new Set(input.terminalStatuses)
				return db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId").all({ chainId: input.chainId }).every((row) => terminal.has(row.status))
			}),

		recordRun: (input) =>
			write("record run", () => {
				const result = db.query<unknown, SqlParams>(`
					INSERT INTO runs (run_id, chain_id, item_id, phase, started_at, ended_at, exit_code, extra)
					VALUES ($runId, $chainId, $itemId, $phase, $startedAt, $endedAt, $exitCode, $extra)
				`).run({
					runId: input.runId,
					chainId: input.chainId,
					itemId: input.itemId,
					phase: input.phase,
					startedAt: input.startedAt,
					endedAt: input.endedAt ?? null,
					exitCode: input.exitCode ?? null,
					extra: stringifyJsonObject(input.extra ?? {}),
				})
				return requireRun(getRunRowByRunId(input.runId), Number(result.lastInsertRowid))
			}),

		getRunByRunId: (runId) => read("get run by run_id", () => rowToRun(getRunRowByRunId(runId))),

		completeRun: (runId, input) =>
			write("complete run", () => {
				const current = requireRun(getRunRowByRunId(runId), runId)
				const nextExtra = input.extra ?? current.extra
				db.query<unknown, SqlParams>(`
					UPDATE runs
					SET ended_at = $endedAt, exit_code = $exitCode, extra = $extra
					WHERE run_id = $runId
				`).run({
					runId: runId,
					endedAt: input.endedAt,
					exitCode: input.exitCode,
					extra: stringifyJsonObject(nextExtra),
				})
				return requireRun(getRunRowByRunId(runId), runId)
			}),

		setCurrentRun: (input) =>
			write("set current run", () => {
				db.query<unknown, SqlParams>(`
					INSERT INTO current_runs (chain_id, phase, run_id, started_at, extra)
					VALUES ($chainId, $phase, $runId, $startedAt, $extra)
					ON CONFLICT(chain_id) DO UPDATE SET
						phase = excluded.phase,
						run_id = excluded.run_id,
						started_at = excluded.started_at,
						extra = excluded.extra
				`).run(currentRunParams(input))
				return requireCurrentRun(getCurrentRunRow(input.chainId), input.chainId)
			}),

		getCurrentRun: (chainId) => read("get current run", () => rowToCurrentRun(getCurrentRunRow(chainId))),

		clearCurrentRun: (chainId) =>
			write("clear current run", () => db.query<unknown, SqlParams>("DELETE FROM current_runs WHERE chain_id = $chainId").run({ chainId: chainId }).changes > 0),
	}
}

function rowToChain(row: ChainRow | null): ChainRecord | null {
	if (row === null) return null
	if (!isChainStatus(row.status)) {
		throw new SqliteStateError("invalid_json", `invalid chain status in DB row: ${row.status}`, { id: row.id })
	}
	return {
		id: row.id,
		name: row.name,
		preset: row.preset,
		repository: row.repository,
		baseBranch: row.base_branch,
		umbrellaIssue: row.umbrella_issue,
		umbrellaRepo: row.umbrella_repo,
		status: row.status,
		metadata: parseJsonObject(row.metadata, `chains.${row.id}.metadata`),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function rowToItem(row: ItemRow | null): ItemRecord | null {
	if (row === null) return null
	if (row.runner !== null && row.runner !== "claude" && row.runner !== "codex") {
		throw new SqliteStateError("invalid_json", `invalid item runner in DB row: ${row.runner}`, { id: row.id })
	}
	return {
		id: row.id,
		chainId: row.chain_id,
		issueNumber: row.issue_number,
		repoCwd: row.repo_cwd,
		status: row.status,
		attempts: row.attempts,
		title: row.title,
		priority: row.priority,
		branch: row.branch,
		pr: row.pr,
		lastRunId: row.last_run_id,
		issueFile: row.issue_file,
		evidenceDir: row.evidence_dir,
		agentCwd: row.agent_cwd,
		runner: row.runner,
		extra: parseJsonObject(row.extra, `items.${row.id}.extra`),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function rowToRun(row: RunRow | null): RunRecord | null {
	if (row === null) return null
	return {
		id: row.id,
		runId: row.run_id,
		chainId: row.chain_id,
		itemId: row.item_id,
		phase: row.phase,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		exitCode: row.exit_code,
		extra: parseJsonObject(row.extra, `runs.${row.id}.extra`),
	}
}

function rowToCurrentRun(row: CurrentRunRow | null): CurrentRunRecord | null {
	if (row === null) return null
	return {
		chainId: row.chain_id,
		phase: row.phase,
		runId: row.run_id,
		startedAt: row.started_at,
		extra: parseJsonObject(row.extra, `current_runs.${row.chain_id}.extra`),
	}
}

function requireChain(row: ChainRow | null, id: number): ChainRecord {
	const chain = rowToChain(row)
	if (chain === null) throw new SqliteStateError("not_found", `chain ${id} was not found`, { id })
	return chain
}

function requireItem(row: ItemRow | null, id: number): ItemRecord {
	const item = rowToItem(row)
	if (item === null) throw new SqliteStateError("not_found", `item ${id} was not found`, { id })
	return item
}

function requireRun(row: RunRow | null, id: string | number): RunRecord {
	const run = rowToRun(row)
	if (run === null) throw new SqliteStateError("not_found", `run ${String(id)} was not found`, { id: String(id) })
	return run
}

function requireCurrentRun(row: CurrentRunRow | null, chainId: number): CurrentRunRecord {
	const currentRun = rowToCurrentRun(row)
	if (currentRun === null) throw new SqliteStateError("not_found", `current run for chain ${chainId} was not found`, { chainId })
	return currentRun
}

function chainParams(chain: ChainRecord): SqlParams {
	return {
		id: chain.id,
		name: chain.name,
		preset: chain.preset,
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		umbrellaIssue: chain.umbrellaIssue,
		umbrellaRepo: chain.umbrellaRepo,
		status: chain.status,
		metadata: stringifyJsonObject(chain.metadata),
		updatedAt: chain.updatedAt,
	}
}

function itemParams(item: ItemRecord): SqlParams {
	return {
		id: item.id,
		repoCwd: item.repoCwd,
		status: item.status,
		attempts: item.attempts,
		title: item.title,
		priority: item.priority,
		branch: item.branch,
		pr: item.pr,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile,
		evidenceDir: item.evidenceDir,
		agentCwd: item.agentCwd,
		runner: item.runner,
		extra: stringifyJsonObject(item.extra),
		updatedAt: item.updatedAt,
	}
}

function currentRunParams(input: SetCurrentRunInput): SqlParams {
	return {
		chainId: input.chainId,
		phase: input.phase,
		runId: input.runId,
		startedAt: input.startedAt,
		extra: stringifyJsonObject(input.extra),
	}
}

function selectNextPendingItem(items: ItemRecord[], statuses: readonly string[]): ItemRecord | null {
	const eligible = new Set(statuses)
	return items
		.filter((item) => eligible.has(item.status))
		.sort((left, right) => {
			if (left.priority === null && right.priority !== null) return 1
			if (left.priority !== null && right.priority === null) return -1
			if (left.priority !== right.priority) return String(left.priority).localeCompare(String(right.priority))
			return left.id - right.id
		})[0] ?? null
}

function stringifyJsonObject(value: JsonObject): string {
	return JSON.stringify(value)
}

function parseJsonObject(raw: string, label: string): JsonObject {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch (error) {
		throw new SqliteStateError("invalid_json", `invalid JSON in ${label}: ${errorMessage(error)}`, { label })
	}
	if (!isJsonObject(value)) {
		throw new SqliteStateError("invalid_json", `${label} must contain a JSON object`, { label })
	}
	return value
}

function isJsonObject(value: unknown): value is JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	return isJsonObject(value)
}

function isChainStatus(status: string): status is ChainStatus {
	return status === "active" || status === "completed" || status === "deleted"
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

function translateSqliteError(error: unknown, operation: string, details: JsonObject = {}): Error {
	if (error instanceof SqliteStateError) return error
	return new SqliteStateError("sqlite_error", `${operation} failed: ${errorMessage(error)}`, details)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
