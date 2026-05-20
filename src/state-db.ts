import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import type { AgentRunnerKind, JsonObject, JsonValue } from "./loop"
import { loopDataRootPaths } from "./runtime-paths"

export const DEFAULT_STATE_DB_PATH = loopDataRootPaths().stateDbPath

export const DEFAULT_PENDING_ITEM_STATUSES = ["queued", "changes_requested"] as const
export const DEFAULT_TERMINAL_ITEM_STATUSES = ["done", "moot", "blocked", "merged", "skipped", "failed-permanent"] as const

export type ChainStatus = "active" | "completed" | "archived"

export type Chain = {
	id: number
	name: string
	preset: string
	repository: string | null
	baseBranch: string | null
	umbrellaIssue: number | null
	umbrellaRepo: string | null
	status: ChainStatus
	completedAt: string | null
	createdAt: string
	metadata: JsonObject
}

export type Item = {
	id: number
	chainId: number
	issue: number
	repoCwd: string
	status: string
	priority: string
	attempts: number
	title: string | null
	branch: string | null
	pr: number | null
	lastRunId: string | null
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string | null
	runner: AgentRunnerKind | null
	extra: JsonObject
	createdAt: string
	updatedAt: string
}

export type NewItem = {
	issue: number
	repoCwd: string
	status?: string
	priority?: string
	attempts?: number
	title?: string | null
	branch?: string | null
	pr?: number | null
	lastRunId?: string | null
	issueFile?: string | null
	evidenceDir?: string | null
	agentCwd?: string | null
	runner?: AgentRunnerKind | null
	extra?: JsonObject
}

export type ItemPatch = {
	status?: string
	priority?: string
	attempts?: number
	title?: string | null
	branch?: string | null
	pr?: number | null
	lastRunId?: string | null
	issueFile?: string | null
	evidenceDir?: string | null
	agentCwd?: string | null
	runner?: AgentRunnerKind | null
	extra?: JsonObject
}

export type RunRecord = {
	id: string
	chainId: number
	itemId: number
	phase: string
	runner: string
	startedAt: string
	finishedAt: string | null
	exitCode: number | null
	terminated: JsonObject | null
	logPath: string | null
	statusPath: string | null
}

export type NewRunRecord = {
	id: string
	chainId: number
	itemId: number
	phase: string
	runner: string
	startedAt?: string
	finishedAt?: string | null
	exitCode?: number | null
	terminated?: JsonObject | null
	logPath?: string | null
	statusPath?: string | null
}

export type FinishRunResult = {
	finishedAt?: string
	exitCode: number
	terminated?: JsonObject | null
}

export type StateStore = {
	readonly db: Database
	close: () => void
	createChain: (
		name: string,
		preset: string,
		repository?: string | null,
		baseBranch?: string | null,
		umbrellaIssue?: number | null,
		umbrellaRepo?: string | null,
		metadata?: JsonObject,
	) => Chain
	upsertChain: (
		name: string,
		preset: string,
		repository?: string | null,
		baseBranch?: string | null,
		umbrellaIssue?: number | null,
		umbrellaRepo?: string | null,
		metadata?: JsonObject,
	) => Chain
	getChain: (idOrName: number | string) => Chain | null
	listChains: () => Chain[]
	listActiveChains: () => Chain[]
	listRepoCwdsForChain: (chainId: number) => string[]
	listItems: (chainId: number, status?: string | null) => Item[]
	completeChain: (id: number) => Chain
	addItem: (chainId: number, item: NewItem) => Item
	getItem: (id: number) => Item | null
	updateItem: (id: number, patch: ItemPatch) => Item
	getNextPending: (chainId: number, repoCwd: string) => Item | null
	allItemsTerminal: (chainId: number, terminalStatuses?: readonly string[]) => boolean
	recordRun: (run: NewRunRecord) => RunRecord
	finishRun: (id: string, result: FinishRunResult) => RunRecord
}

type ChainRow = {
	id: number
	name: string
	preset: string
	repository: string | null
	base_branch: string | null
	umbrella_issue: number | null
	umbrella_repo: string | null
	status: string
	completed_at: string | null
	created_at: string
	metadata: string
}

type ItemRow = {
	id: number
	chain_id: number
	issue: number
	repo_cwd: string
	status: string
	priority: string
	attempts: number
	title: string | null
	branch: string | null
	pr: number | null
	last_run_id: string | null
	issue_file: string | null
	evidence_dir: string | null
	agent_cwd: string | null
	runner: string | null
	extra: string
	created_at: string
	updated_at: string
}

type RunRow = {
	id: string
	chain_id: number
	item_id: number
	phase: string
	runner: string
	started_at: string
	finished_at: string | null
	exit_code: number | null
	terminated: string | null
	log_path: string | null
	status_path: string | null
}

export function openStateDb(path: string = DEFAULT_STATE_DB_PATH): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
	const db = new Database(path, { create: true, strict: true })
	initializeStateDb(db)
	return db
}

export function openStateStore(path: string = DEFAULT_STATE_DB_PATH): StateStore {
	const db = openStateDb(path)
	return {
		db,
		close: () => db.close(),
		createChain: (...args) => createChain(db, ...args),
		upsertChain: (...args) => upsertChain(db, ...args),
		getChain: (idOrName) => getChain(db, idOrName),
		listChains: () => listChains(db),
		listActiveChains: () => listActiveChains(db),
		listRepoCwdsForChain: (chainId) => listRepoCwdsForChain(db, chainId),
		listItems: (chainId, status) => listItems(db, chainId, status),
		completeChain: (id) => completeChain(db, id),
		addItem: (chainId, item) => addItem(db, chainId, item),
		getItem: (id) => getItem(db, id),
		updateItem: (id, patch) => updateItem(db, id, patch),
		getNextPending: (chainId, repoCwd) => getNextPending(db, chainId, repoCwd),
		allItemsTerminal: (chainId, terminalStatuses) => allItemsTerminal(db, chainId, terminalStatuses),
		recordRun: (run) => recordRun(db, run),
		finishRun: (id, result) => finishRun(db, id, result),
	}
}

export function initializeStateDb(db: Database): void {
	db.exec("PRAGMA foreign_keys = ON")
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("PRAGMA busy_timeout = 5000")
	db.exec(`
		CREATE TABLE IF NOT EXISTS chains (
			id              INTEGER PRIMARY KEY,
			name            TEXT NOT NULL UNIQUE,
			preset          TEXT NOT NULL,
			repository      TEXT,
			base_branch     TEXT,
			umbrella_issue  INTEGER,
			umbrella_repo   TEXT,
			status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
			completed_at    TEXT,
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			metadata        TEXT NOT NULL DEFAULT '{}'
		);

		CREATE TABLE IF NOT EXISTS items (
			id            INTEGER PRIMARY KEY,
			chain_id      INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
			issue         INTEGER NOT NULL,
			repo_cwd      TEXT NOT NULL,
			status        TEXT NOT NULL DEFAULT 'queued',
			priority      TEXT NOT NULL DEFAULT 'medium',
			attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
			title         TEXT,
			branch        TEXT,
			pr            INTEGER,
			last_run_id   TEXT,
			issue_file    TEXT,
			evidence_dir  TEXT,
			agent_cwd     TEXT,
			runner        TEXT CHECK (runner IS NULL OR runner IN ('claude', 'codex')),
			extra         TEXT NOT NULL DEFAULT '{}',
			created_at    TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(chain_id, issue, repo_cwd)
		);

		CREATE TABLE IF NOT EXISTS runs (
			id          TEXT PRIMARY KEY,
			chain_id    INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
			item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
			phase       TEXT NOT NULL,
			runner      TEXT NOT NULL,
			started_at  TEXT NOT NULL,
			finished_at TEXT,
			exit_code   INTEGER,
			terminated  TEXT,
			log_path    TEXT,
			status_path TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_chains_status ON chains(status);
		CREATE INDEX IF NOT EXISTS idx_items_chain_status ON items(chain_id, status);
		CREATE INDEX IF NOT EXISTS idx_items_next_pending ON items(chain_id, repo_cwd, status, priority, id);
		CREATE INDEX IF NOT EXISTS idx_runs_item_phase ON runs(item_id, phase);
		CREATE INDEX IF NOT EXISTS idx_runs_chain_started_at ON runs(chain_id, started_at);
	`)
}

export function createChain(
	db: Database,
	name: string,
	preset: string,
	repository: string | null = null,
	baseBranch: string | null = null,
	umbrellaIssue: number | null = null,
	umbrellaRepo: string | null = null,
	metadata: JsonObject = {},
): Chain {
	return db.transaction(() => {
		const row = db.query(`
			INSERT INTO chains (name, preset, repository, base_branch, umbrella_issue, umbrella_repo, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			RETURNING *
		`).get(name, preset, repository, baseBranch, umbrellaIssue, umbrellaRepo, encodeJsonObject(metadata))
		return chainFromRow(expectRow<ChainRow>(row, "createChain"))
	})()
}

export function upsertChain(
	db: Database,
	name: string,
	preset: string,
	repository: string | null = null,
	baseBranch: string | null = null,
	umbrellaIssue: number | null = null,
	umbrellaRepo: string | null = null,
	metadata: JsonObject = {},
): Chain {
	return db.transaction(() => {
		const existing = getChain(db, name)
		if (existing === null) {
			return createChain(db, name, preset, repository, baseBranch, umbrellaIssue, umbrellaRepo, metadata)
		}
		const row = db.query(`
			UPDATE chains
			SET preset = ?, repository = ?, base_branch = ?, umbrella_issue = ?, umbrella_repo = ?, metadata = ?
			WHERE id = ?
			RETURNING *
		`).get(
			preset,
			repository,
			baseBranch,
			umbrellaIssue,
			umbrellaRepo,
			encodeJsonObject(metadata),
			existing.id,
		)
		return chainFromRow(expectRow<ChainRow>(row, "upsertChain"))
	})()
}

export function getChain(db: Database, idOrName: number | string): Chain | null {
	const row = typeof idOrName === "number"
		? db.query("SELECT * FROM chains WHERE id = ?").get(idOrName)
		: db.query("SELECT * FROM chains WHERE name = ?").get(idOrName)
	return row === null ? null : chainFromRow(expectRow<ChainRow>(row, "getChain"))
}

export function listChains(db: Database): Chain[] {
	const rows = db.query("SELECT * FROM chains ORDER BY id").all()
	return rows.map((row) => chainFromRow(expectRow<ChainRow>(row, "listChains")))
}

export function listActiveChains(db: Database): Chain[] {
	const rows = db.query("SELECT * FROM chains WHERE status = 'active' ORDER BY id").all()
	return rows.map((row) => chainFromRow(expectRow<ChainRow>(row, "listActiveChains")))
}

export function listRepoCwdsForChain(db: Database, chainId: number): string[] {
	const rows = db.query(`
		SELECT DISTINCT repo_cwd
		FROM items
		WHERE chain_id = ?
		ORDER BY repo_cwd
	`).all(chainId)
	return rows.map((row) => expectRow<{ repo_cwd: string }>(row, "listRepoCwdsForChain").repo_cwd)
}

export function listItems(db: Database, chainId: number, status: string | null = null): Item[] {
	const rows = status === null
		? db.query(`
			SELECT *
			FROM items
			WHERE chain_id = ?
			ORDER BY id
		`).all(chainId)
		: db.query(`
			SELECT *
			FROM items
			WHERE chain_id = ? AND status = ?
			ORDER BY id
		`).all(chainId, status)
	return rows.map((row) => itemFromRow(expectRow<ItemRow>(row, "listItems")))
}

export function completeChain(db: Database, id: number): Chain {
	return db.transaction(() => {
		const row = db.query(`
			UPDATE chains
			SET status = 'completed', completed_at = COALESCE(completed_at, datetime('now'))
			WHERE id = ?
			RETURNING *
		`).get(id)
		return chainFromRow(expectRow<ChainRow>(row, "completeChain"))
	})()
}

export function addItem(db: Database, chainId: number, item: NewItem): Item {
	return db.transaction(() => {
		const row = db.query(`
			INSERT INTO items (
				chain_id, issue, repo_cwd, status, priority, attempts, title, branch, pr,
				last_run_id, issue_file, evidence_dir, agent_cwd, runner, extra
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING *
		`).get(
			chainId,
			item.issue,
			item.repoCwd,
			item.status ?? "queued",
			item.priority ?? "medium",
			item.attempts ?? 0,
			item.title ?? null,
			item.branch ?? null,
			item.pr ?? null,
			item.lastRunId ?? null,
			item.issueFile ?? null,
			item.evidenceDir ?? null,
			item.agentCwd ?? null,
			item.runner ?? null,
			encodeJsonObject(item.extra ?? {}),
		)
		return itemFromRow(expectRow<ItemRow>(row, "addItem"))
	})()
}

export function getItem(db: Database, id: number): Item | null {
	const row = db.query("SELECT * FROM items WHERE id = ?").get(id)
	return row === null ? null : itemFromRow(expectRow<ItemRow>(row, "getItem"))
}

export function updateItem(db: Database, id: number, patch: ItemPatch): Item {
	return db.transaction(() => {
		if (Object.keys(patch).length === 0) {
			const existing = getItem(db, id)
			if (existing === null) throw new Error(`updateItem: item ${id} not found`)
			return existing
		}

		const updates: string[] = []
		const values: SQLQueryBindings[] = []
		pushUpdate(updates, values, "status", patch.status)
		pushUpdate(updates, values, "priority", patch.priority)
		pushUpdate(updates, values, "attempts", patch.attempts)
		pushUpdate(updates, values, "title", patch.title)
		pushUpdate(updates, values, "branch", patch.branch)
		pushUpdate(updates, values, "pr", patch.pr)
		pushUpdate(updates, values, "last_run_id", patch.lastRunId)
		pushUpdate(updates, values, "issue_file", patch.issueFile)
		pushUpdate(updates, values, "evidence_dir", patch.evidenceDir)
		pushUpdate(updates, values, "agent_cwd", patch.agentCwd)
		pushUpdate(updates, values, "runner", patch.runner)
		if (patch.extra !== undefined) {
			updates.push("extra = ?")
			values.push(encodeJsonObject(patch.extra))
		}
		updates.push("updated_at = datetime('now')")
		values.push(id)

		const row = db.query(`UPDATE items SET ${updates.join(", ")} WHERE id = ? RETURNING *`).get(...values)
		return itemFromRow(expectRow<ItemRow>(row, "updateItem"))
	})()
}

export function getNextPending(db: Database, chainId: number, repoCwd: string): Item | null {
	const placeholders = DEFAULT_PENDING_ITEM_STATUSES.map(() => "?").join(", ")
	const row = db.query(`
		SELECT *
		FROM items
		WHERE chain_id = ? AND repo_cwd = ? AND status IN (${placeholders})
		ORDER BY
			CASE priority
				WHEN 'high' THEN 0
				WHEN 'medium' THEN 1
				WHEN 'low' THEN 2
				ELSE 3
			END,
			attempts ASC,
			id ASC
		LIMIT 1
	`).get(chainId, repoCwd, ...DEFAULT_PENDING_ITEM_STATUSES)
	return row === null ? null : itemFromRow(expectRow<ItemRow>(row, "getNextPending"))
}

export function allItemsTerminal(
	db: Database,
	chainId: number,
	terminalStatuses: readonly string[] = DEFAULT_TERMINAL_ITEM_STATUSES,
): boolean {
	if (terminalStatuses.length === 0) throw new Error("allItemsTerminal: terminalStatuses must not be empty")
	const placeholders = terminalStatuses.map(() => "?").join(", ")
	const row = db.query(`
		SELECT COUNT(*) AS count
		FROM items
		WHERE chain_id = ? AND status NOT IN (${placeholders})
	`).get(chainId, ...terminalStatuses)
	return numericCount(row) === 0
}

export function recordRun(db: Database, run: NewRunRecord): RunRecord {
	return db.transaction(() => {
		const row = db.query(`
			INSERT INTO runs (
				id, chain_id, item_id, phase, runner, started_at, finished_at,
				exit_code, terminated, log_path, status_path
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING *
		`).get(
			run.id,
			run.chainId,
			run.itemId,
			run.phase,
			run.runner,
			run.startedAt ?? new Date().toISOString(),
			run.finishedAt ?? null,
			run.exitCode ?? null,
			run.terminated === undefined || run.terminated === null ? null : encodeJsonObject(run.terminated),
			run.logPath ?? null,
			run.statusPath ?? null,
		)
		return runFromRow(expectRow<RunRow>(row, "recordRun"))
	})()
}

export function finishRun(db: Database, id: string, result: FinishRunResult): RunRecord {
	return db.transaction(() => {
		const row = db.query(`
			UPDATE runs
			SET finished_at = ?, exit_code = ?, terminated = ?
			WHERE id = ?
			RETURNING *
		`).get(
			result.finishedAt ?? new Date().toISOString(),
			result.exitCode,
			result.terminated === undefined || result.terminated === null ? null : encodeJsonObject(result.terminated),
			id,
		)
		return runFromRow(expectRow<RunRow>(row, "finishRun"))
	})()
}

function pushUpdate(updates: string[], values: SQLQueryBindings[], column: string, value: SQLQueryBindings | undefined): void {
	if (value === undefined) return
	updates.push(`${column} = ?`)
	values.push(value)
}

function chainFromRow(row: ChainRow): Chain {
	if (!isChainStatus(row.status)) throw new Error(`chain ${row.id}: invalid status ${row.status}`)
	return {
		id: row.id,
		name: row.name,
		preset: row.preset,
		repository: row.repository,
		baseBranch: row.base_branch,
		umbrellaIssue: row.umbrella_issue,
		umbrellaRepo: row.umbrella_repo,
		status: row.status,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		metadata: decodeJsonObject(row.metadata, `chain ${row.id}.metadata`),
	}
}

function itemFromRow(row: ItemRow): Item {
	return {
		id: row.id,
		chainId: row.chain_id,
		issue: row.issue,
		repoCwd: row.repo_cwd,
		status: row.status,
		priority: row.priority,
		attempts: row.attempts,
		title: row.title,
		branch: row.branch,
		pr: row.pr,
		lastRunId: row.last_run_id,
		issueFile: row.issue_file,
		evidenceDir: row.evidence_dir,
		agentCwd: row.agent_cwd,
		runner: runnerFromSql(row.runner),
		extra: decodeJsonObject(row.extra, `item ${row.id}.extra`),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function runFromRow(row: RunRow): RunRecord {
	return {
		id: row.id,
		chainId: row.chain_id,
		itemId: row.item_id,
		phase: row.phase,
		runner: row.runner,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		exitCode: row.exit_code,
		terminated: row.terminated === null ? null : decodeJsonObject(row.terminated, `run ${row.id}.terminated`),
		logPath: row.log_path,
		statusPath: row.status_path,
	}
}

function runnerFromSql(value: string | null): AgentRunnerKind | null {
	if (value === null || value === "claude" || value === "codex") return value
	throw new Error(`invalid runner ${value}`)
}

function isChainStatus(value: string): value is ChainStatus {
	return value === "active" || value === "completed" || value === "archived"
}

function expectRow<T extends object>(row: unknown, label: string): T {
	if (row === null) throw new Error(`${label}: row not found`)
	if (!isObjectRecord(row)) throw new Error(`${label}: expected row object`)
	return row as T
}

function numericCount(row: unknown): number {
	const value = expectRow<{ count: unknown }>(row, "count").count
	if (typeof value !== "number") throw new Error("count: expected number")
	return value
}

function encodeJsonObject(value: JsonObject): string {
	return JSON.stringify(value)
}

function decodeJsonObject(raw: string, label: string): JsonObject {
	const parsed: unknown = JSON.parse(raw)
	if (!isJsonObject(parsed)) throw new Error(`${label}: expected JSON object`)
	return parsed
}

function isJsonObject(value: unknown): value is JsonObject {
	if (!isObjectRecord(value) || Array.isArray(value)) return false
	return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	const kind = typeof value
	if (kind === "string" || kind === "boolean") return true
	if (kind === "number") return Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJsonValue)
	return isJsonObject(value)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}
