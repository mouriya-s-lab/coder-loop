import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import type { JsonObject } from "./loop"

export type HistoricalSchemaVersion = 13 | 14

export type HistoricalRunSeed = {
	runId: string
	phase: string
	status: string
	startedAt: number
	extra: JsonObject
	currentExtra?: JsonObject
}

export type HistoricalItemSeed = {
	itemId: string
	repoCwd: string
	status: string
	phase: string | null
	preset: string | null
	presetPath: string | null
	agentCwd: string | null
	sessionIds: JsonObject
	extra: JsonObject
	run?: HistoricalRunSeed
}

export type HistoricalContextEntrySeed = {
	id: string
	body: string
}

export type CanonicalHistoricalRuntimeSeed = {
	loopDataRoot: string
	schemaVersion: HistoricalSchemaVersion
	chain: {
		name: string
		repository: string
		preset: string | null
	}
	items: readonly HistoricalItemSeed[]
	contextEntries: readonly HistoricalContextEntrySeed[]
}

export type HistoricalSchemaFacts = {
	runForeignKeys: string[]
	currentRunForeignKeys: string[]
	hasContextEntries: boolean
}

export type CanonicalHistoricalRuntime = {
	dbFile: string
	chain: { id: number; name: string }
	items: { id: number; itemId: string }[]
	schemaFacts: HistoricalSchemaFacts
}

const CANONICAL_V13_SCHEMA_SQL = `
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
	runner TEXT CHECK (runner IN ('claude', 'codex', 'opencode') OR runner IS NULL),
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
	status TEXT NOT NULL,
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
CREATE INDEX idx_items_chain_status ON items(chain_id, status);
CREATE INDEX idx_runs_chain_item ON runs(chain_id, item_id);
CREATE INDEX idx_items_next_pending ON items(chain_id, repo_cwd, status, position, id);
CREATE INDEX idx_runs_chain_phase_status ON runs(chain_id, phase, status);
`

const CANONICAL_V14_CONTEXT_SCHEMA_SQL = `
CREATE TABLE context_entries (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	created_at REAL NOT NULL,
	scope_kind TEXT NOT NULL CHECK (scope_kind IN ('chain','item','group')),
	scope_key TEXT,
	author TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX idx_context_entries_chain_cursor ON context_entries(chain_id, created_at, id);
`

type ForeignKeyRow = {
	table: string
	from: string
	to: string
	on_delete: string
}

function foreignKeyFacts(db: Database, table: "runs" | "current_runs"): string[] {
	return db.query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${table})`).all()
		.map((row) => `${row.from}->${row.table}.${row.to}:${row.on_delete}`)
		.sort()
}

function readHistoricalSchemaFacts(db: Database): HistoricalSchemaFacts {
	return {
		runForeignKeys: foreignKeyFacts(db, "runs"),
		currentRunForeignKeys: foreignKeyFacts(db, "current_runs"),
		hasContextEntries: (db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='context_entries'").get()?.count ?? 0) === 1,
	}
}

export function seedCanonicalHistoricalRuntime(input: CanonicalHistoricalRuntimeSeed): CanonicalHistoricalRuntime {
	mkdirSync(input.loopDataRoot, { recursive: true })
	const dbFile = resolve(input.loopDataRoot, "db.sqlite")
	const db = new Database(dbFile, { create: true, readwrite: true, strict: true })
	const items: { id: number; itemId: string }[] = []
	try {
		db.exec("PRAGMA foreign_keys = ON")
		db.exec(CANONICAL_V13_SCHEMA_SQL)
		if (input.schemaVersion === 14) db.exec(CANONICAL_V14_CONTEXT_SCHEMA_SQL)
		db.query<never, { name: string; preset: string | null; repository: string }>(`INSERT INTO chains (
			id, name, preset, repository, base_branch, status, metadata, created_at, updated_at
		) VALUES (1, $name, $preset, $repository, 'main', 'active', '{}', 1800000000, 1800000000)`).run(input.chain)

		for (const [index, item] of input.items.entries()) {
			const id = index + 1
			const lastRunId = item.run?.runId ?? null
			db.query<never, {
				id: number
				itemId: string
				repoCwd: string
				status: string
				lastRunId: string | null
				sessionIds: string
				agentCwd: string | null
				phase: string | null
				preset: string | null
				presetPath: string | null
				extra: string
			}>(`INSERT INTO items (
				id, chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id, session_ids,
				issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra, created_at, updated_at, status_updated_at
			) VALUES (
				$id, 1, $itemId, $repoCwd, $status, 1, $id, $itemId, NULL, $lastRunId, $sessionIds,
				NULL, NULL, $agentCwd, NULL, $phase, $preset, $presetPath, $extra, 1800000000, 1800000000, 1800000000
			)`).run({ id, itemId: item.itemId, repoCwd: item.repoCwd, status: item.status, lastRunId, sessionIds: JSON.stringify(item.sessionIds), agentCwd: item.agentCwd, phase: item.phase, preset: item.preset, presetPath: item.presetPath, extra: JSON.stringify(item.extra) })
			items.push({ id, itemId: item.itemId })
			if (item.run !== undefined) {
				db.query<never, { runId: string; itemId: number; phase: string; status: string; startedAt: number; extra: string }>(`INSERT INTO runs (
					run_id, chain_id, item_id, phase, status, started_at, ended_at, exit_code, extra
				) VALUES ($runId, 1, $itemId, $phase, $status, $startedAt, NULL, NULL, $extra)`).run({ runId: item.run.runId, itemId: id, phase: item.run.phase, status: item.run.status, startedAt: item.run.startedAt, extra: JSON.stringify(item.run.extra) })
				db.query<never, { phase: string; runId: string; startedAt: number; extra: string }>(`INSERT INTO current_runs (
					chain_id, phase, run_id, started_at, extra
				) VALUES (1, $phase, $runId, $startedAt, $extra)`).run({ phase: item.run.phase, runId: item.run.runId, startedAt: item.run.startedAt, extra: JSON.stringify(item.run.currentExtra ?? {}) })
			}
		}

		if (input.schemaVersion === 13 && input.contextEntries.length > 0) throw new Error("v13 historical fixture cannot contain context entries")
		for (const [index, context] of input.contextEntries.entries()) {
			db.query<never, { id: string; createdAt: number; body: string }>(`INSERT INTO context_entries (
				id, chain_id, created_at, scope_kind, scope_key, author, body
			) VALUES ($id, 1, $createdAt, 'chain', NULL, '{"kind":"operator"}', $body)`).run({ id: context.id, createdAt: 1_800_000_100 + index, body: context.body })
		}
		db.exec(`PRAGMA user_version = ${input.schemaVersion}`)
		return { dbFile, chain: { id: 1, name: input.chain.name }, items, schemaFacts: readHistoricalSchemaFacts(db) }
	} finally {
		db.close()
	}
}
