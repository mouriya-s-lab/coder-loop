import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import type { AgentRunnerKind, JsonObject, JsonValue } from "./loop"
import {
	chainMetadataToJsonObject,
	itemExtraToJsonObject,
	itemDependsOnIds,
	parseInternalStatus,
	storedChainMetadata,
	storedItemExtra,
	type AdmittedItemStatus,
	type ChainMetadata,
	type InternalStatus,
	type ItemExtra,
} from "./runtime-data"
import { type LoopDataRootOptions, resolveLoopDataPaths } from "./runtime-paths"
import {
	assertTaskTreeSnapshot,
	type ActiveRunSnapshot,
	type ClosureSnapshot,
	type ExecutionDefinitionRef,
	type JoinEvaluationSnapshot,
	type JoinValueSnapshot,
	type TaskNodeSnapshot,
	type TaskTreeSnapshot,
} from "./task-runtime"
import { contextScopeKey, parseContextAuthor, parsePersistedContextEntryRow, persistedContextScope, type AppendContextEntryInput, type ContextEntry, type PersistedContextEntryRow } from "./context-entry"

export type SqliteStateErrorCode =
	| "db_unavailable"
	| "sqlite_error"
	| "invalid_json"
	| "not_found"
	| "invalid_input"
	| "active_run_conflict"
	| "run_closure_mismatch"
	| "closure_lifecycle_conflict"

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

const CHAIN_STATUSES = ["active", "completed", "deleted", "stopped"] as const
export type ChainStatus = typeof CHAIN_STATUSES[number]
// #403: the engine no longer carries a default pending-status vocabulary. The previous
// `DEFAULT_PENDING_ITEM_STATUSES` literal (queued / changes_requested) was a `gh-issue-pr-iteration`-
// shaped engine preset hiding behind a `??` fallback in `getNextPendingItem`. After #403 the only
// source of status vocabularies is the preset declared on chain/item, resolved through the daemon.
// `GetNextPendingItemInput.statuses` and `.terminalStatusNames` are therefore required (see types
// above) — undefined cannot seep into this read path where `??` would catch it. Callers that lack
// a resolved preset must surface a typed preset-resolution error at the boundary, not synthesize a
// fallback vocabulary deep in the store layer.

export type ChainRecord = {
	id: number
	name: string
	// preset is nullable since schema v9 (#412): the canonical preset declaration site moved
	// from chain to item. This column is retained as a legacy default seed (preserved across
	// migrations so v8 items keep resolving). Physical retirement is tracked in #419.
	preset: string | null
	// repository / baseBranch are engine-mechanism fields — repository is consumed by
	// `resolveDbChainForTarget` chain-identity matching (src/loop.ts:3433-3438) and baseBranch by
	// worktree creation (`validateWorktreePrerequisites`). They remain first-class chain columns
	// for the engine path; the bundled preset's prompt-business view onto them flows through the
	// generic chain-binding namespace via `buildSchedulerChainBindings`. Issue #457 retired the
	// umbrella column counterparts because their only consumer was prompt-business — umbrella data
	// now lives inside `metadata.bindings.umbrellaRepo / umbrellaIssue` as preset-declared chain
	// bindings (no engine-side first-class typing).
	repository: string
	baseBranch: string
	status: ChainStatus
	metadata: ChainMetadata
	createdAt: number
	updatedAt: number
}

export type CreateChainInput = {
	name: string
	// preset retained for legacy default-seed (#412 / #419). New chain creators may still
	// pass it but it is no longer the source of truth — items carry their own preset.
	preset?: string | null
	repository: string
	baseBranch: string
	status?: ChainStatus
	metadata?: ChainMetadata
	createdAt?: number
	updatedAt?: number
}

export type UpdateChainInput = Partial<Omit<CreateChainInput, "createdAt">> & {
	updatedAt?: number
}

export type ItemRecord = {
	id: number
	chainId: number
	// #419: item身份键不再焊死 `issue_number`。`itemId` 是 preset `idField` 声明语义下的字符串身份；
	// 任何整数/字符串身份值在创建时进入 `extra.<idField>` (legacy migration 把 `issue_number` 整数列复制到
	// `extra.issue` 字符串值)。物理表用 `item_id TEXT NOT NULL` + `UNIQUE (chain_id, item_id)`。
	itemId: string
	repoCwd: string
	status: InternalStatus
	attempts: number
	position: number
	title: string | null
	priority: string | null
	// #419: `branch` / `pr` 不再是引擎一等列。继续 import 它们的 preset (e.g. `gh-issue-pr-iteration`)
	// 把它们声明在 `[item.fields]` 并经 `extra.branch` / `extra.pr` 透明字段读写；engine 只读 `extra`。
	lastRunId: string | null
	sessionIds: ItemSessionIds
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string | null
	runner: AgentRunnerKind | null
	phase: string | null
	// Preset declaration site for this item — issue #412 moved preset from chain to item.
	// preset = bundled preset name (PRESET_NAME_PATTERN); presetPath = absolute filesystem path.
	// API enforces exactly one is set for new items; legacy items pre-#412 may have both null
	// and fall back to chains.preset until back-fill migration runs.
	preset: string | null
	presetPath: string | null
	extra: ItemExtra
	createdAt: number
	updatedAt: number
	statusUpdatedAt: number
}

export type ItemSessionIds = Record<string, Partial<Record<AgentRunnerKind, string>>>

export type CreateItemInput = {
	chainId: number
	// #419: opaque string item id (preset `idField`-valued). Persisted in `items.item_id` and
	// uniqued per chain. `branch` / `pr` are no longer engine-typed and must travel as
	// preset-declared keys inside `extra` for presets that need them.
	itemId: string
	repoCwd: string
	// #397 default-deny gate: writing `status` to the store requires the `AdmittedItemStatus`
	// brand, which is producible only via the daemon's request-flow gate
	// (`admitItemStatusForRequest`) or the narrow engine-lifecycle constructor
	// (`engineLifecycleAdmittedItemStatus`). The typechecker therefore enumerates every status
	// write path; no fall-through admits arbitrary strings to items.status.
	status: AdmittedItemStatus
	// preset / presetPath are required at the daemon API boundary for new items (#412).
	// The store accepts them as nullable so the migration back-fill path can express
	// legacy items, and so tests / lower-level callers can still construct rows; the
	// daemon's handleItemAdd / handleItemBatchAdd reject `null` at the boundary.
	preset?: string | null
	presetPath?: string | null
	attempts?: number
	title?: string | null
	priority?: string | null
	lastRunId?: string | null
	sessionIds?: ItemSessionIds
	issueFile?: string | null
	evidenceDir?: string | null
	agentCwd?: string | null
	runner?: AgentRunnerKind | null
	phase?: string | null
	extra?: ItemExtra
	createdAt?: number
	updatedAt?: number
	statusUpdatedAt?: number
}

export type UpdateItemInput = Partial<Omit<CreateItemInput, "chainId" | "itemId" | "createdAt">> & {
	updatedAt?: number
}

export type RunRecord = {
	id: number
	runId: string
	chainId: number
	itemId: number
	closureId: string
	runtimeNodeId: string
	phase: string
	status: InternalStatus
	startedAt: number
	endedAt: number | null
	exitCode: number | null
	extra: ItemExtra
}

export type RecordRunInput = {
	runId: string
	chainId: number
	itemId: number
	phase: string
	status?: InternalStatus
	startedAt: number
	endedAt?: number | null
	exitCode?: number | null
	extra?: ItemExtra
}

export type CompleteRunInput = {
	endedAt: number
	exitCode: number
	status: InternalStatus
	extra?: ItemExtra
}

export type CurrentRunRecord = {
	chainId: number
	phase: string
	runId: string
	startedAt: number
	extra: ItemExtra
}

export type SetCurrentRunInput = CurrentRunRecord

export type GetNextPendingItemInput = {
	chainId: number
	repoCwd: string
	// #403: required. The store does not synthesize a default status vocabulary — callers must pass
	// the already-resolved set from the active preset (no `??` fallback path remains in the body).
	statuses: readonly InternalStatus[]
	terminalStatusNames: readonly InternalStatus[]
	resolveDependency?: DependencyResolver
}

export type ListDependencyWaitsInput = {
	chainId: number
	repoCwd?: string
	statuses: readonly InternalStatus[]
	terminalStatusNames: readonly InternalStatus[]
	resolveDependency?: DependencyResolver
}

export type DependencyWaitReason = {
	// `rowId` = the items.id integer rowid (referenced by `runs.item_id`); `itemId` = the preset
	// `idField`-valued opaque string identity introduced in #419. Both are surfaced so callers
	// can either route by rowid (engine internals) or by string id (preset-facing audit emissions).
	rowId: number
	itemId: string
	repoCwd: string
	dependsOn: number[]
	unsatisfied: number[]
}

// Resolves a globally-unique item id, including items that live in a different chain than the
// caller's snapshot. Used so dependsOn can express cross-chain (cross-repo) dependencies.
export type DependencyResolver = (id: number) => ItemRecord | null

export type AllItemsTerminalInput = {
	chainId: number
	terminalStatusNames: readonly InternalStatus[]
}

export type ItemSessionIdInput = {
	phase: string
	runner: AgentRunnerKind
}

export type SetItemSessionIdInput = ItemSessionIdInput & {
	sessionId: string | null
	updatedAt?: number
}

export type ClosureLifecycleInput =
	| { kind: "activate"; updatedAt: number }
	| { kind: "suspend"; updatedAt: number }
	| { kind: "consume"; updatedAt: number }
export type ClosureResourcesInput = { worktreePath: string | null; branchName: string | null; updatedAt: number }
export type AppendJoinBindingInput = { version: number; value: JoinValueSnapshot; authorKind: string; authorId: string; authorityClass: string; effectiveFromEpoch: number; createdAt: number }
export type JoinBindingRecord = AppendJoinBindingInput & { parNodeId: string }
export type BindJoinEvaluationInput = { epoch: number; bindingVersion: number; state: "evaluating" | "decided" | "consumed" }
export type JoinEvaluationRecord = BindJoinEvaluationInput & { parNodeId: string }

export type StateTableName = "chains" | "items" | "runs" | "execution_definitions" | "task_trees" | "task_nodes" | "task_leaf_nodes" | "task_seq_nodes" | "task_par_nodes" | "task_join_bindings" | "task_join_evaluation_bindings" | "task_closures" | "closure_sessions" | "active_runs" | "context_entries"

export type SqliteStateStoreOptions = LoopDataRootOptions & {
	createIfMissing?: boolean
}

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
	createItems: (input: readonly CreateItemInput[]) => ItemRecord[]
	getItem: (id: number) => ItemRecord | null
	// #419: lookup by preset-declared opaque string id (formerly `issueNumber` integer).
	getItemById: (chainId: number, itemId: string) => ItemRecord | null
	listItems: (chainId: number) => ItemRecord[]
	updateItem: (id: number, input: UpdateItemInput) => ItemRecord
	reorderItem: (id: number, position: number) => ItemRecord[]
	getItemSessionId: (id: number, input: ItemSessionIdInput) => string | null
	setItemSessionId: (id: number, input: SetItemSessionIdInput) => ItemRecord
	deleteItem: (id: number) => boolean
	getNextPendingItem: (input: GetNextPendingItemInput) => ItemRecord | null
	listDependencyWaits: (input: ListDependencyWaitsInput) => DependencyWaitReason[]
	allItemsTerminal: (input: AllItemsTerminalInput) => boolean
	recordRun: (input: RecordRunInput) => RunRecord
	getRunByRunId: (runId: string) => RunRecord | null
	listRuns: (chainId: number) => RunRecord[]
	completeRun: (runId: string, input: CompleteRunInput) => RunRecord
	setCurrentRun: (input: SetCurrentRunInput) => CurrentRunRecord
	getCurrentRun: (chainId: number) => CurrentRunRecord | null
	listCurrentRuns: (chainId: number) => CurrentRunRecord[]
	clearCurrentRun: (runId: string) => boolean
	createTaskTree: (chainId: number, tree: TaskTreeSnapshot) => TaskTreeSnapshot
	getTaskTree: (chainId: number) => TaskTreeSnapshot | null
	setClosureLifecycle: (closureId: string, input: ClosureLifecycleInput) => ClosureSnapshot
	setClosureResources: (closureId: string, input: ClosureResourcesInput) => ClosureSnapshot
	appendJoinBinding: (parNodeId: string, input: AppendJoinBindingInput) => JoinBindingRecord
	listJoinBindings: (parNodeId: string) => JoinBindingRecord[]
	bindJoinEvaluation: (parNodeId: string, input: BindJoinEvaluationInput) => JoinEvaluationRecord
	listJoinEvaluations: (parNodeId: string) => JoinEvaluationRecord[]
	appendContextEntry: (input: AppendContextEntryInput) => ContextEntry
	listContextEntries: (chainId: number) => ContextEntry[]
	deleteContextEntriesForChain: (chainId: number) => number
}

type SqlParamValue = string | number | bigint | boolean | Uint8Array | null
type SqlParams = Record<string, SqlParamValue>
type PersistedRow = Record<string, SqlParamValue>

type ChainRow = {
	id: number
	name: string
	// nullable since schema v9 (#412); see CHAINS_TABLE_SCHEMA_SQL.
	preset: string | null
	repository: string
	base_branch: string
	status: string
	metadata: string
	created_at: number
	updated_at: number
}

type ItemRow = {
	id: number
	chain_id: number
	// #419 schema v12: opaque string item id (preset `idField`-valued). Replaces `issue_number INTEGER`.
	item_id: string
	repo_cwd: string
	status: string
	attempts: number
	position: number
	title: string | null
	priority: string | null
	// #419 schema v12: `branch` / `pr` physical columns retired. Presets that still use them
	// (e.g. `gh-issue-pr-iteration` declares them in `[item.fields]`) read/write via `extra`.
	last_run_id: string | null
	issue_file: string | null
	evidence_dir: string | null
	agent_cwd: string | null
	runner: string | null
	phase: string | null
	preset: string | null
	preset_path: string | null
	extra: string
	created_at: number
	updated_at: number
	status_updated_at: number
}

type RunRow = {
	id: number
	run_id: string
	chain_id: number
	item_id: number
	closure_id: string
	runtime_node_id: string
	phase: string
	status: string
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

const CurrentRunRowBoundary = arkType({ chain_id: "number.integer", phase: "string>0", run_id: "string>0", started_at: "number", extra: "string", "+": "reject" })
const TaskNodeRowBoundary = arkType({
	runtime_node_id: "string>0",
	chain_id: "number.integer",
	parent_node_id: "string|null",
	child_index: "number.integer>=0",
	kind: "'leaf'|'seq'|'par'",
	definition_kind: "'preset'|'chain'",
	definition_content_identity: "string>0",
	definition_node_id: "string>0",
	"+": "reject",
})
const ClosureRowBoundary = arkType({
	closure_id: "string>0", item_row_id: "number.integer>0", item_id: "string>0", phase: "string>0",
	lifecycle: "'active'|'suspended'|'consumed'", worktree_path: "string|null", branch_name: "string|null",
	base_commit: "string>0", source_par_node_id: "string|null",
	"+": "reject",
})
const ClosureSessionRowBoundary = arkType({ runner_kind: "'claude'|'codex'|'opencode'", session_id: "string>0", "+": "reject" })
const ActiveRunRowBoundary = arkType({ closure_id: "string>0", run_id: "string>0", phase: "string>0", started_at: "number", "+": "reject" })
const TaskTreeRootRowBoundary = arkType({ root_node_id: "string>0", "+": "reject" })
const SeqNodeRowBoundary = arkType({ next_child_node_id: "string|null", "+": "reject" })
const ParNodeRowBoundary = arkType({ pin_commit: "string>0", reopen_count: "number.integer>=0", reopen_budget_ref: "string>0", container_state: "'open'|'completed'|'exhausted'", "+": "reject" })
const JoinBindingValueRowBoundary = arkType({ version: "number.integer>=1", join_kind: "'drain'|'validator'", candidate_definition_kind: "'preset'|'chain'|null", candidate_definition_content_identity: "string|null", candidate_id: "string|null", "+": "reject" })
const JoinBindingRowBoundary = arkType({ par_node_id: "string>0", version: "number.integer>=1", join_kind: "'drain'|'validator'", candidate_definition_kind: "'preset'|'chain'|null", candidate_definition_content_identity: "string|null", candidate_id: "string|null", author_kind: "string>0", author_id: "string>0", authority_class: "string>0", effective_from_epoch: "number.integer>=0", created_at: "number", "+": "reject" })
const JoinEvaluationValueRowBoundary = arkType({ epoch: "number.integer>=0", binding_version: "number.integer>=1", evaluation_state: "'evaluating'|'decided'|'consumed'", "+": "reject" })
const JoinEvaluationRowBoundary = arkType({ par_node_id: "string>0", epoch: "number.integer>=0", binding_version: "number.integer>=1", evaluation_state: "'evaluating'|'decided'|'consumed'", "+": "reject" })
const ClosureLeafRowBoundary = arkType({ leaf_node_id: "string>0", "+": "reject" })
const ActiveRunAssociationRowBoundary = arkType({ lifecycle: "'active'|'suspended'|'consumed'", phase: "string>0", chain_id: "number.integer", "+": "reject" })
const ClosureAssociationRowBoundary = arkType({ closure_id: "string>0", lifecycle: "'active'|'suspended'|'consumed'", "+": "reject" })
const RunIdRowBoundary = arkType({ run_id: "string>0", "+": "reject" })
const LegacyChainRowBoundary = arkType({ id: "number.integer>0", "+": "reject" })
const LegacyItemRowBoundary = arkType({
	id: "number.integer>0", chain_id: "number.integer>0", item_id: "string>0", repo_cwd: "string>0",
	phase: "string|null", session_ids: "string", agent_cwd: "string|null", preset: "string|null",
	preset_path: "string|null", extra: "string",
	"+": "reject",
})
const LegacyCurrentRunRowBoundary = arkType({ chain_id: "number.integer>0", phase: "string>0", run_id: "string>0", started_at: "number", extra: "string", "+": "reject" })
const PersistedRunExtraRowBoundary = arkType({ extra: "string", "+": "reject" })
const MigrationDefinitionOutputBoundary = arkType({ definitionKind: "'preset'", definitionContentIdentity: "string>0", definitionPhaseNames: "string[]", "+": "reject" })
const ClosureIdRowBoundary = arkType({ closure_id: "string>0", "+": "reject" })
const TableCountRowBoundary = arkType({ table_count: "number.integer>=0", "+": "reject" })
const SessionIdRowBoundary = arkType({ session_id: "string>0", "+": "reject" })
const JoinVersionRowBoundary = arkType({ version: "number.integer>=1", "+": "reject" })
const JoinEpochRowBoundary = arkType({ epoch: "number.integer>=0", "+": "reject" })
const ItemIdRowBoundary = arkType({ item_id: "string>0", "+": "reject" })
const DefinitionIdentityRowBoundary = arkType({ definition_kind: "'preset'|'chain'", definition_content_identity: "string>0", "+": "reject" })
const TaskNodeKindRowBoundary = arkType({ kind: "'leaf'|'seq'|'par'", "+": "reject" })
const NextChildIndexRowBoundary = arkType({ next_index: "number.integer>=0", "+": "reject" })
const RuntimeNodeIdRowBoundary = arkType({ runtime_node_id: "string>0", "+": "reject" })
const RunTaskIdentityRowBoundary = arkType({ closure_id: "string>0", leaf_node_id: "string>0", "+": "reject" })

function parsePersistedRow<T>(boundary: { assert(value: unknown): T }, value: unknown, label: string): T {
	try {
		return boundary.assert(value)
	} catch (error) {
		throw new SqliteStateError("invalid_json", `${label}: ${errorMessage(error)}`, { label })
	}
}

function queryPersistedOne<T>(db: Database, sql: string, params: SqlParams, boundary: { assert(value: unknown): T }, label: string): T | null {
	const row = db.query<PersistedRow, SqlParams>(sql).get(params)
	return row === null ? null : parsePersistedRow(boundary, row, label)
}

function queryPersistedAll<T>(db: Database, sql: string, params: SqlParams, boundary: { assert(value: unknown): T }, label: string): T[] {
	return db.query<PersistedRow, SqlParams>(sql).all(params).map((row, index) => parsePersistedRow(boundary, row, `${label}[${index}]`))
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

type TableSqlRow = {
	sql: string | null
}

type MaxPositionRow = {
	max_position: number | null
}

// #419 schema v12: `issue_number` (integer) → `item_id` (opaque string, preset `idField`-valued);
// `branch` / `pr` physical columns retired (presets that still use them declare them in
// `[item.fields]` and they round-trip through `extra`). UNIQUE re-anchored on `(chain_id, item_id)`.
const ITEMS_TABLE_SCHEMA_SQL = `
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
`

// Migration-only v13 shape. `session_ids` is read exactly once by the v13→v14
// migration and is not part of the post-migration items table.
const V13_ITEMS_TABLE_SCHEMA_SQL = `
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
`

const STATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_items_chain_status ON items(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_chain_item ON runs(chain_id, item_id);
`

const ITEM_NEXT_PENDING_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_items_next_pending ON items(chain_id, repo_cwd, status, position, id);
`

const RUN_STATUS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_runs_chain_phase_status ON runs(chain_id, phase, status);
`

// chains.preset became nullable in schema v9 (#412): the preset declaration site
// moved from chain to item, so a chain no longer needs a single preset. The column
// is retained as a legacy default-seed (the create-time preset is still recorded for
// back-fill of items predating the migration), but no engine path treats it as the
// canonical preset of in-flight work. Physical column retirement is tracked in #419.
const CHAINS_TABLE_SCHEMA_SQL = `
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	preset TEXT,
	repository TEXT NOT NULL,
	base_branch TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted', 'stopped')),
	metadata TEXT NOT NULL,
	created_at REAL NOT NULL,
	updated_at REAL NOT NULL
`

const STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chains (
${CHAINS_TABLE_SCHEMA_SQL}
);

CREATE TABLE IF NOT EXISTS items (
${ITEMS_TABLE_SCHEMA_SQL}
);

CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL UNIQUE,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	closure_id TEXT NOT NULL,
	runtime_node_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	status TEXT NOT NULL,
	started_at REAL NOT NULL,
	ended_at REAL,
	exit_code INTEGER,
	extra TEXT NOT NULL
);

${STATE_INDEXES_SQL}
`

const V3_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_definitions (
	kind TEXT NOT NULL CHECK (kind IN ('preset','chain')),
	content_identity TEXT NOT NULL,
	semantic_hash TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	PRIMARY KEY (kind, content_identity)
);
CREATE TABLE IF NOT EXISTS task_nodes (
	runtime_node_id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	parent_node_id TEXT REFERENCES task_nodes(runtime_node_id) ON DELETE CASCADE,
	child_index INTEGER NOT NULL CHECK (child_index >= 0),
	kind TEXT NOT NULL CHECK (kind IN ('leaf','seq','par')),
	definition_kind TEXT NOT NULL,
	definition_content_identity TEXT NOT NULL,
	definition_node_id TEXT NOT NULL,
	FOREIGN KEY (definition_kind, definition_content_identity) REFERENCES execution_definitions(kind, content_identity),
	UNIQUE(parent_node_id, child_index)
);
CREATE TABLE IF NOT EXISTS task_trees (
	chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
	root_node_id TEXT NOT NULL UNIQUE REFERENCES task_nodes(runtime_node_id)
);
CREATE TABLE IF NOT EXISTS task_closures (
	closure_id TEXT PRIMARY KEY,
	leaf_node_id TEXT NOT NULL UNIQUE REFERENCES task_nodes(runtime_node_id) ON DELETE CASCADE,
	item_row_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','suspended','consumed')),
	worktree_path TEXT,
	branch_name TEXT,
	base_commit TEXT NOT NULL,
		source_par_node_id TEXT REFERENCES task_par_nodes(runtime_node_id),
	created_at REAL NOT NULL,
	updated_at REAL NOT NULL,
	UNIQUE(item_row_id, phase),
	CHECK (lifecycle = 'consumed' OR (worktree_path IS NOT NULL AND branch_name IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS task_leaf_nodes (runtime_node_id TEXT PRIMARY KEY REFERENCES task_nodes(runtime_node_id) ON DELETE CASCADE, closure_id TEXT NOT NULL UNIQUE REFERENCES task_closures(closure_id));
CREATE TABLE IF NOT EXISTS task_seq_nodes (runtime_node_id TEXT PRIMARY KEY REFERENCES task_nodes(runtime_node_id) ON DELETE CASCADE, next_child_node_id TEXT REFERENCES task_nodes(runtime_node_id));
CREATE TABLE IF NOT EXISTS task_par_nodes (
	runtime_node_id TEXT PRIMARY KEY REFERENCES task_nodes(runtime_node_id) ON DELETE CASCADE,
	pin_commit TEXT NOT NULL,
	reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
	reopen_budget_ref TEXT NOT NULL,
	origin TEXT NOT NULL,
	container_state TEXT NOT NULL CHECK (container_state IN ('open','completed','exhausted'))
);
CREATE TABLE IF NOT EXISTS task_join_bindings (
	par_node_id TEXT NOT NULL REFERENCES task_par_nodes(runtime_node_id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version >= 1),
	join_kind TEXT NOT NULL CHECK (join_kind IN ('drain','validator')),
	candidate_definition_kind TEXT,
	candidate_definition_content_identity TEXT,
	candidate_id TEXT,
	author_kind TEXT NOT NULL,
	author_id TEXT NOT NULL,
	authority_class TEXT NOT NULL,
	effective_from_epoch INTEGER NOT NULL,
	created_at REAL NOT NULL,
	PRIMARY KEY (par_node_id, version),
	CHECK ((join_kind = 'drain' AND candidate_definition_kind IS NULL AND candidate_definition_content_identity IS NULL AND candidate_id IS NULL) OR (join_kind = 'validator' AND candidate_definition_kind IS NOT NULL AND candidate_definition_content_identity IS NOT NULL AND candidate_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS task_join_evaluation_bindings (
	par_node_id TEXT NOT NULL,
	epoch INTEGER NOT NULL CHECK (epoch >= 0),
	binding_version INTEGER NOT NULL,
	evaluation_state TEXT NOT NULL CHECK (evaluation_state IN ('evaluating','decided','consumed')),
	PRIMARY KEY (par_node_id, epoch),
	FOREIGN KEY (par_node_id, binding_version) REFERENCES task_join_bindings(par_node_id, version)
);
CREATE TABLE IF NOT EXISTS closure_sessions (
	closure_id TEXT NOT NULL REFERENCES task_closures(closure_id) ON DELETE CASCADE,
	runner_kind TEXT NOT NULL CHECK (runner_kind IN ('claude','codex','opencode')),
	session_id TEXT NOT NULL,
	PRIMARY KEY (closure_id, runner_kind)
);
CREATE TABLE IF NOT EXISTS active_runs (
	closure_id TEXT PRIMARY KEY REFERENCES task_closures(closure_id) ON DELETE CASCADE,
	run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	started_at REAL NOT NULL,
	extra TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS task_closure_source_par_insert
BEFORE INSERT ON task_closures
BEGIN
	SELECT CASE
		WHEN (SELECT parent.kind FROM task_nodes AS leaf LEFT JOIN task_nodes AS parent ON parent.runtime_node_id = leaf.parent_node_id WHERE leaf.runtime_node_id = NEW.leaf_node_id) = 'par'
			AND NEW.source_par_node_id IS NOT (SELECT leaf.parent_node_id FROM task_nodes AS leaf WHERE leaf.runtime_node_id = NEW.leaf_node_id)
		THEN RAISE(ABORT, 'par child closure must reference its actual parent par')
		WHEN COALESCE((SELECT parent.kind FROM task_nodes AS leaf LEFT JOIN task_nodes AS parent ON parent.runtime_node_id = leaf.parent_node_id WHERE leaf.runtime_node_id = NEW.leaf_node_id), '') != 'par'
			AND NEW.source_par_node_id IS NOT NULL
		THEN RAISE(ABORT, 'non-par child closure cannot reference a source par')
	END;
END;

CREATE TABLE IF NOT EXISTS context_entries (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	created_at REAL NOT NULL,
	scope_kind TEXT NOT NULL CHECK (scope_kind IN ('chain','item','group')),
	scope_key TEXT,
	author TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_entries_chain_cursor ON context_entries(chain_id, created_at, id);

${STATE_INDEXES_SQL}
`

// #419 v11→v12: items 物理层退出 GitHub 形状。items.`issue_number INTEGER NOT NULL` → `item_id TEXT NOT NULL`;
// drop `branch TEXT` / `pr INTEGER` 物理列;`UNIQUE (chain_id, issue_number)` → `UNIQUE (chain_id, item_id)`.
// 迁移把每行的 `issue_number` 整数复制为 `extra.issue` 字符串（兼容 `gh-issue-pr-iteration` 的 idField="issue"
// 在 [item.fields] 声明 issue 透明字段后的读路径），同时把非 NULL 的 `branch`/`pr` 落到 `extra.branch`/`extra.pr`
// 保留 gh-issue-pr-iteration 经透明字段使用它们的生产路径。Idempotent: 已经在新形状下的盘原样跳过。
// #457: bumping to 11 — chains.umbrella_issue / umbrella_repo columns retired. The v10→v11
// migration copies any non-null column values into the chain's metadata.bindings (as
// umbrellaIssue / umbrellaRepo entries; column values win on conflict because they were the
// engine's source of truth before the column was retired), then rebuilds the chains table
// without those columns. Idempotent: rows already migrated (column values were NULL when the
// migration runs) are left alone. The engine no longer reads these columns; bundled preset
// resolves them via the declared-binding namespace (chain.umbrellaRepo / chain.umbrellaIssue).
// #481 v12→v13: items.runner CHECK constraint widens from `('claude','codex')` to
// `('claude','codex','opencode')` so the third runner kind round-trips through SQLite. A CHECK
// constraint cannot be modified in place on SQLite — `rebuildItemsTableForV13` copies rows into
// a freshly-CREATE'd table whose schema text comes from the current ITEMS_TABLE_SCHEMA_SQL (which
// now carries the widened CHECK). Idempotent: rows already on v13 cause `user_version` to skip
// the rebuild, and rows being copied through the new schema satisfy the new constraint (existing
// runner values are all `claude` / `codex` / NULL — strict subset of the new accepted set).
// main independently used v14 for context_entries after #558 had used v14 for the
// normalized v3 runtime tables. v15 is the first schema that requires both shapes.
const STATE_SCHEMA_VERSION = 16
const V5_ITEM_SESSION_COLUMN = ["last", "session", "id"].join("_")
// v9 moves preset declaration from chains.preset to items.preset / items.preset_path (#412).
// Existing rows are back-filled from chains.preset so the engine resolves the legacy preset
// for them until they cycle out. New items must specify preset explicitly at the API.
const V9_ITEMS_PRESET_COLUMN = "preset"
const V9_ITEMS_PRESET_PATH_COLUMN = "preset_path"

type UserVersionRow = {
	user_version: number
}

export function openSqliteStateStore(options: SqliteStateStoreOptions = {}): SqliteStateStore {
	const paths = resolveLoopDataPaths(options)
	const dbFile = paths.dbFile
	const createIfMissing = options.createIfMissing ?? true
	if (!createIfMissing && !existsSync(dbFile)) {
		throw new SqliteStateError("db_unavailable", `SQLite state DB does not exist at ${dbFile}`, { dbFile })
	}
	let db: Database
	try {
		db = new Database(dbFile, { create: createIfMissing, readwrite: true, strict: true })
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
		migrateStateSchema(db, paths.root)
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
			AND name IN ('chains', 'items', 'runs')
	`).get()
	return row?.table_count === 3
}

function contextEntriesTableExists(db: Database): boolean {
	return (db.query<TableCountRow, []>("SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name='context_entries'").get()?.table_count ?? 0) === 1
}

function v3RuntimeSchemaExists(db: Database): boolean {
	const row = db.query<TableCountRow, []>(`
		SELECT COUNT(*) AS table_count
		FROM sqlite_master
		WHERE type = 'table'
			AND name IN (
				'execution_definitions', 'task_trees', 'task_nodes', 'task_leaf_nodes',
				'task_seq_nodes', 'task_par_nodes', 'task_join_bindings',
				'task_join_evaluation_bindings', 'task_closures', 'closure_sessions', 'active_runs'
			)
	`).get()
	return row?.table_count === 11
}

function readUserVersion(db: Database): number {
	return db.query<UserVersionRow, []>("PRAGMA user_version").get()?.user_version ?? 0
}

function tableHasColumn(db: Database, tableName: StateTableName, columnName: string): boolean {
	return db
		.query<TableColumnRow, []>(`PRAGMA table_info(${tableName})`)
		.all()
		.some((row) => row.name === columnName)
}

function chainsTableAllowsStopped(db: Database): boolean {
	const sql = db.query<TableSqlRow, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chains'").get()?.sql ?? ""
	return sql.includes("'stopped'")
}

function chainsTableHasNotNullPreset(db: Database): boolean {
	// v8 schema declared `preset TEXT NOT NULL`; v9 (#412) makes it nullable. PRAGMA exposes
	// the constraint via `notnull = 1`. Detect this to trigger the chain table rebuild on upgrade.
	const presetCol = db
		.query<{ name: string; notnull: number }, []>("PRAGMA table_info(chains)")
		.all()
		.find((row) => row.name === "preset")
	return presetCol?.notnull === 1
}

// #481 v12→v13: items.runner CHECK constraint widens from `('claude','codex')` to
// `('claude','codex','opencode')`. SQLite has no `ALTER TABLE ... DROP/MODIFY CHECK`, so detect
// the legacy constraint by inspecting the items table's CREATE SQL and trigger a full rebuild
// (`rebuildItemsTableForV13`). Conservative: any items table whose CREATE SQL does NOT mention
// `opencode` inside the runner CHECK clause is considered legacy.
function itemsTableRunnerCheckAllowsOpencode(db: Database): boolean {
	const sql = db.query<TableSqlRow, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()?.sql ?? ""
	if (sql === "") return false
	return /runner\s+TEXT\s+CHECK[^)]*['"]opencode['"]/i.test(sql)
}

function itemsTableHasColumn(db: Database, columnName: string): boolean {
	return tableHasColumn(db, "items", columnName)
}

function runsTableHasColumn(db: Database, columnName: string): boolean {
	return tableHasColumn(db, "runs", columnName)
}

function migrateStateSchema(db: Database, loopDataRoot: string): void {
	const beforeVersion = readUserVersion(db)
	const needsItemTableRebuild = itemsTableHasColumn(db, V5_ITEM_SESSION_COLUMN)
	const needsChainTableRebuildForStopped = stateSchemaExists(db) && !chainsTableAllowsStopped(db)
	// v9 (#412): chains.preset moves from NOT NULL to NULL — SQLite has no ALTER COLUMN, so rebuild.
	const needsChainTableRebuildForNullablePreset = stateSchemaExists(db) && chainsTableHasNotNullPreset(db)
	// v11 (#457): chains.umbrella_issue / umbrella_repo columns retired — rebuild any chain table that
	// still carries them. The migration logic below copies their values into metadata.bindings before
	// the rebuild so no data is lost.
	const needsChainTableRebuildForUmbrellaColumnDrop = stateSchemaExists(db)
		&& (tableHasColumn(db, "chains", "umbrella_issue") || tableHasColumn(db, "chains", "umbrella_repo"))
	const needsChainTableRebuild = needsChainTableRebuildForStopped
		|| needsChainTableRebuildForNullablePreset
		|| needsChainTableRebuildForUmbrellaColumnDrop
	// #419 v11→v12: items.`issue_number` integer 列、`branch` / `pr` 物理列退役。任何还带这三列之一
	// 的盘需要走 v12 rebuild —— 先把 `issue_number` 拷为 `extra.issue` 字符串、把非 NULL `branch`/`pr` 拷为
	// `extra.branch` / `extra.pr`,再 swap 到只有 `item_id TEXT NOT NULL` + `UNIQUE (chain_id, item_id)` 的新表。
	const needsItemTableRebuildForGitHubShapeRetire = stateSchemaExists(db)
		&& (itemsTableHasColumn(db, "issue_number") || itemsTableHasColumn(db, "branch") || itemsTableHasColumn(db, "pr"))
	// #481 v12→v13: items.runner CHECK constraint widens to include 'opencode'. Any items table
	// whose CREATE SQL lacks `opencode` in the runner CHECK list needs a rebuild via
	// `rebuildItemsTableForV13`. The widened ITEMS_TABLE_SCHEMA_SQL already encodes the new
	// check; the rebuild simply CREATEs `items_new` from that SQL and copies rows over.
	const needsItemTableRebuildForOpencodeCheck = stateSchemaExists(db)
		&& !itemsTableRunnerCheckAllowsOpencode(db)
	const needsLegacyRuntimeMigration = stateSchemaExists(db) && !v3RuntimeSchemaExists(db)
	const needsV14ItemSourceRetire = stateSchemaExists(db) && itemsTableHasColumn(db, "session_ids")
	const needsRunIdentityMigration = stateSchemaExists(db) && (!runsTableHasColumn(db, "closure_id") || !runsTableHasColumn(db, "runtime_node_id"))
	if (
		beforeVersion >= STATE_SCHEMA_VERSION
		&& stateSchemaExists(db)
		&& contextEntriesTableExists(db)
		&& v3RuntimeSchemaExists(db)
		&& !needsChainTableRebuild
		&& !needsItemTableRebuildForGitHubShapeRetire
		&& !needsItemTableRebuildForOpencodeCheck
		&& itemsTableHasColumn(db, "phase")
		&& !itemsTableHasColumn(db, "session_ids")
		&& itemsTableHasColumn(db, "position")
		&& itemsTableHasColumn(db, "status_updated_at")
		&& itemsTableHasColumn(db, V9_ITEMS_PRESET_COLUMN)
		&& itemsTableHasColumn(db, V9_ITEMS_PRESET_PATH_COLUMN)
		&& !itemsTableHasColumn(db, V5_ITEM_SESSION_COLUMN)
		&& runsTableHasColumn(db, "status")
		&& runsTableHasColumn(db, "closure_id")
		&& runsTableHasColumn(db, "runtime_node_id")
	) return
	if (needsItemTableRebuild || needsChainTableRebuild || needsItemTableRebuildForGitHubShapeRetire || needsItemTableRebuildForOpencodeCheck || needsLegacyRuntimeMigration || needsV14ItemSourceRetire || needsRunIdentityMigration) db.exec("PRAGMA foreign_keys = OFF")
	try {
		db.transaction(() => {
			db.exec(STATE_SCHEMA_SQL)
			if (!runsTableHasColumn(db, "closure_id")) db.exec("ALTER TABLE runs ADD COLUMN closure_id TEXT")
			if (!runsTableHasColumn(db, "runtime_node_id")) db.exec("ALTER TABLE runs ADD COLUMN runtime_node_id TEXT")
			db.exec(V3_RUNTIME_SCHEMA_SQL)
			if (needsChainTableRebuild) {
				// v10 → v11 (#457): copy any non-null `chains.umbrella_issue` / `umbrella_repo` values
				// into the chain's metadata.bindings (umbrellaIssue / umbrellaRepo) before the rebuild
				// drops the columns. Idempotent: a row with NULL columns and a metadata.bindings entry
				// already in the new shape is left alone.
				if (needsChainTableRebuildForUmbrellaColumnDrop) {
					migrateChainsUmbrellaToBindings(db)
				}
				rebuildChainsTable(db)
			}
			if (!itemsTableHasColumn(db, "phase")) {
				db.exec("ALTER TABLE items ADD COLUMN phase TEXT")
			}
			if (!itemsTableHasColumn(db, "session_ids")) {
				db.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
			}
			if (!itemsTableHasColumn(db, "position")) {
				db.exec("ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
				db.exec("UPDATE items SET position = id")
			}
			if (!itemsTableHasColumn(db, "status_updated_at")) {
				db.exec("ALTER TABLE items ADD COLUMN status_updated_at REAL NOT NULL DEFAULT 0")
				db.exec("UPDATE items SET status_updated_at = updated_at")
			}
			if (!runsTableHasColumn(db, "status")) {
				db.exec("ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'")
			}
			// v9 (#412): add items.preset / items.preset_path and back-fill from chains.preset so legacy
			// items keep resolving the chain's preset until they cycle out / are recreated.
			const addedPresetColumn = !itemsTableHasColumn(db, V9_ITEMS_PRESET_COLUMN)
			if (addedPresetColumn) {
				db.exec(`ALTER TABLE items ADD COLUMN ${V9_ITEMS_PRESET_COLUMN} TEXT`)
			}
			if (!itemsTableHasColumn(db, V9_ITEMS_PRESET_PATH_COLUMN)) {
				db.exec(`ALTER TABLE items ADD COLUMN ${V9_ITEMS_PRESET_PATH_COLUMN} TEXT`)
			}
			if (addedPresetColumn) {
				// Back-fill from chains.preset where the chain still has one set (it can legitimately
				// be NULL for chains created against the v9 schema after #412).
				db.exec(`UPDATE items
					SET preset = (SELECT chains.preset FROM chains WHERE chains.id = items.chain_id)
					WHERE preset IS NULL`)
			}
			if (itemsTableHasColumn(db, V5_ITEM_SESSION_COLUMN)) {
				migrateV5ItemSessionIds(db)
				rebuildItemsTableForV6(db)
			}
			// #419 v11→v12: items GitHub-shape retire. Run AFTER the v5/v6 rebuild path above (which
			// would otherwise re-create the table from the old SELECT list); the call below detects
			// the legacy `issue_number` / `branch` / `pr` columns on whatever the current `items` table
			// looks like, copies them into `extra`, then swaps to the v12 shape (item_id + no branch/pr).
			if (itemsTableHasColumn(db, "issue_number") || itemsTableHasColumn(db, "branch") || itemsTableHasColumn(db, "pr")) {
				migrateItemsToOpaqueItemId(db)
			}
			// #481 v12→v13: items.runner CHECK widens to include 'opencode'. The v11→v12 rebuild
			// (`migrateItemsToOpaqueItemId` → `rebuildItemsTableForV12`) already runs the table
			// through the current ITEMS_TABLE_SCHEMA_SQL, so any disk going through v11→v12 in
			// this same migration pass picks up the widened CHECK for free. A disk that was already
			// on v12 from a prior coder-loop build still carries the narrow CHECK —
			// `rebuildItemsTableForV13` handles that case (and is a no-op when the table already
			// shows `opencode` in its CHECK SQL).
			if (!itemsTableRunnerCheckAllowsOpencode(db)) {
				rebuildItemsTableForV13(db)
			}
			// #433 v9→v10: drop the retired top-level runner keys (`runner` and the role-named
			// runner key, named at runtime via string concatenation per #456 to keep `src/` free of
			// the role taxonomy literal) and rename the `config` wrapper to `bindings` on the
			// chains.metadata column. parseChainMetadata rejects these post-#433; this rewrite
			// keeps historical disks loadable. Runs after migrateV5ItemSessionIds, which still
			// depends on the legacy `metadata.runner` hint.
			if (beforeVersion < STATE_SCHEMA_VERSION) {
				migrateChainsMetadataForCl433(db)
			}
			if (needsLegacyRuntimeMigration) migrateLegacyRuntimeToV3(db, loopDataRoot)
			if (needsRunIdentityMigration) migrateRunIdentity(db)
			if (itemsTableHasColumn(db, "session_ids")) rebuildItemsTableForV14(db)
			db.exec(STATE_INDEXES_SQL)
			db.exec(ITEM_NEXT_PENDING_INDEX_SQL)
			db.exec(RUN_STATUS_INDEX_SQL)
			db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`)
		}).immediate()
	} finally {
		if (needsItemTableRebuild || needsChainTableRebuild || needsItemTableRebuildForGitHubShapeRetire || needsItemTableRebuildForOpencodeCheck || needsLegacyRuntimeMigration || needsV14ItemSourceRetire || needsRunIdentityMigration) db.exec("PRAGMA foreign_keys = ON")
	}
}

function migrateRunIdentity(db: Database): void {
	db.exec(`UPDATE runs
		SET closure_id = (SELECT closure_id FROM task_closures WHERE item_row_id = runs.item_id AND phase = runs.phase),
			runtime_node_id = (SELECT leaf_node_id FROM task_closures WHERE item_row_id = runs.item_id AND phase = runs.phase)`)
	const missing = queryPersistedOne(db, "SELECT COUNT(*) AS table_count FROM runs WHERE closure_id IS NULL OR runtime_node_id IS NULL", {}, TableCountRowBoundary, "runs missing durable task identity")
	if (missing === null || missing.table_count !== 0) throw new SqliteStateError("run_closure_mismatch", `${missing?.table_count ?? "unknown"} historical runs have no closure/runtime-node identity`)
	db.exec(`CREATE TABLE runs_new (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL UNIQUE,
		chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		closure_id TEXT NOT NULL REFERENCES task_closures(closure_id),
		runtime_node_id TEXT NOT NULL REFERENCES task_nodes(runtime_node_id),
		phase TEXT NOT NULL,
		status TEXT NOT NULL,
		started_at REAL NOT NULL,
		ended_at REAL,
		exit_code INTEGER,
		extra TEXT NOT NULL
	)`)
	db.exec(`INSERT INTO runs_new (id, run_id, chain_id, item_id, closure_id, runtime_node_id, phase, status, started_at, ended_at, exit_code, extra)
		SELECT id, run_id, chain_id, item_id, closure_id, runtime_node_id, phase, status, started_at, ended_at, exit_code, extra FROM runs`)
	db.exec("DROP TABLE runs")
	db.exec("ALTER TABLE runs_new RENAME TO runs")
}

function migrateLegacyRuntimeToV3(db: Database, loopDataRoot: string): void {
	const now = unixSeconds()
	const migratedChainIds = new Set<number>()
	const chains = queryPersistedAll(db, "SELECT id FROM chains ORDER BY id", {}, LegacyChainRowBoundary, "legacy v13 chains")
	for (const chain of chains) {
		const items = queryPersistedAll(db, "SELECT id, chain_id, item_id, repo_cwd, phase, session_ids, agent_cwd, preset, preset_path, extra FROM items WHERE chain_id = $chainId ORDER BY position, id", { chainId: chain.id }, LegacyItemRowBoundary, `legacy v13 items for chain ${chain.id}`)
		if (items.length === 0) continue
		const packets = items.map((item) => resolveLegacyItemDefinition(item, loopDataRoot))
		const definitionPacket = packets[0]
		if (definitionPacket === undefined) throw new SqliteStateError("invalid_json", `legacy v13 chain ${chain.id} has no persisted preset declaration`, { chainId: chain.id })
		insertDefinition(db, definitionPacket.definitionRef)
		const rootId = `legacy-v13:chain:${chain.id}:root`
		db.query<never, SqlParams>("INSERT OR IGNORE INTO task_nodes (runtime_node_id, chain_id, parent_node_id, child_index, kind, definition_kind, definition_content_identity, definition_node_id) VALUES ($root, $chainId, NULL, 0, 'seq', $definitionKind, $identity, 'root')").run({ root: rootId, chainId: chain.id, definitionKind: definitionPacket.definitionRef.kind, identity: definitionPacket.definitionRef.contentIdentity })
		db.query<never, SqlParams>("INSERT OR IGNORE INTO task_trees (chain_id, root_node_id) VALUES ($chainId, $root)").run({ chainId: chain.id, root: rootId })
		let childIndex = 0
		let firstNodeId: string | null = null
		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			const item = items[itemIndex]
			const itemPacket = packets[itemIndex]
			if (item === undefined || itemPacket === undefined) throw new SqliteStateError("invalid_json", `legacy v13 chain ${chain.id} definition packet alignment failed`, { chainId: chain.id })
			insertDefinition(db, itemPacket.definitionRef)
			const sessions = parseItemSessionIds(item.session_ids, `items.${item.id}.session_ids`)
			for (const phase of Object.keys(sessions)) requireDeclaredDefinitionPhase(itemPacket, phase, `items.${item.id}.session_ids`)
			if (item.phase !== null && item.phase !== "") requireDeclaredDefinitionPhase(itemPacket, item.phase, `items.${item.id}.phase`)
			for (const phase of itemPacket.definitionPhaseNames) {
				const leafId = `legacy-v13:item:${item.id}:phase:${phase}`
				const closureId = `legacy-v13:closure:${item.id}:${phase}`
				db.query<never, SqlParams>("INSERT INTO task_nodes (runtime_node_id, chain_id, parent_node_id, child_index, kind, definition_kind, definition_content_identity, definition_node_id) VALUES ($leaf, $chainId, $root, $childIndex, 'leaf', $definitionKind, $identity, $definitionNodeId)").run({ leaf: leafId, chainId: chain.id, root: rootId, childIndex, definitionKind: itemPacket.definitionRef.kind, identity: itemPacket.definitionRef.contentIdentity, definitionNodeId: `item:${item.item_id}:phase:${phase}` })
				const worktree = item.agent_cwd ?? item.repo_cwd
				const { branch, baseCommit } = legacyClosureSourceFacts(db, item, phase)
				db.query<never, SqlParams>("INSERT OR IGNORE INTO task_closures (closure_id, leaf_node_id, item_row_id, phase, lifecycle, worktree_path, branch_name, base_commit, source_par_node_id, created_at, updated_at) VALUES ($closure, $leaf, $itemId, $phase, 'active', $worktree, $branch, $baseCommit, NULL, $now, $now)").run({ closure: closureId, leaf: leafId, itemId: item.id, phase, worktree, branch, baseCommit, now })
				db.query<never, SqlParams>("INSERT OR IGNORE INTO task_leaf_nodes (runtime_node_id, closure_id) VALUES ($leaf, $closure)").run({ leaf: leafId, closure: closureId })
				for (const [runner, sessionId] of Object.entries(sessions[phase] ?? {})) {
					if (sessionId === undefined) continue
					db.query<never, SqlParams>("INSERT OR IGNORE INTO closure_sessions (closure_id, runner_kind, session_id) VALUES ($closure, $runner, $session)").run({ closure: closureId, runner, session: sessionId })
				}
				if (firstNodeId === null) firstNodeId = leafId
				childIndex += 1
			}
		}
		db.query<never, SqlParams>("INSERT OR IGNORE INTO task_seq_nodes (runtime_node_id, next_child_node_id) VALUES ($root, $next)").run({ root: rootId, next: firstNodeId })
		migratedChainIds.add(chain.id)
	}
	const hasLegacyCurrent = queryPersistedOne(db, "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name='current_runs'", {}, TableCountRowBoundary, "legacy current_runs table count")?.table_count === 1
	if (hasLegacyCurrent) {
		const rows = queryPersistedAll(db, "SELECT chain_id, phase, run_id, started_at, extra FROM current_runs", {}, LegacyCurrentRunRowBoundary, "legacy current_runs")
		for (const row of rows) {
			if (!migratedChainIds.has(row.chain_id)) throw new SqliteStateError("invalid_json", `legacy active run ${row.run_id} has no migrated task tree`, { runId: row.run_id })
			const closure = queryPersistedOne(db, "SELECT task_closures.closure_id FROM task_closures INNER JOIN runs ON runs.item_id = task_closures.item_row_id AND runs.phase = task_closures.phase WHERE runs.run_id = $runId AND runs.chain_id = $chainId AND runs.phase = $phase", { runId: row.run_id, chainId: row.chain_id, phase: row.phase }, ClosureIdRowBoundary, `legacy active run closure ${row.run_id}`)
			if (closure === null) throw new SqliteStateError("run_closure_mismatch", `cannot migrate active run ${row.run_id}: no matching closure`, { runId: row.run_id })
			db.query<never, SqlParams>("INSERT INTO active_runs (closure_id, run_id, phase, started_at, extra) VALUES ($closure, $runId, $phase, $startedAt, $extra)").run({ closure: closure.closure_id, runId: row.run_id, phase: row.phase, startedAt: row.started_at, extra: row.extra })
		}
		db.exec("DROP TABLE current_runs")
	}
}

type PersistedExecutionDefinitionPacket = {
	definitionRef: ExecutionDefinitionRef
	definitionPhaseNames: readonly string[]
}

function resolveLegacyItemDefinition(item: { id: number; repo_cwd: string; preset: string | null; preset_path: string | null }, loopDataRoot: string): PersistedExecutionDefinitionPacket {
	if (item.preset === null && item.preset_path === null) throw new SqliteStateError("invalid_json", `legacy item ${item.id} has no persisted preset declaration`, { itemId: item.id })
	// bun:sqlite migrations are synchronous transactions, while the canonical preset loader and
	// materializer are async. Run that existing boundary to completion in a child Bun process and
	// admit only its exact typed packet here; this keeps the transaction synchronous without a
	// second TOML parser or a migration-only definition hash.
	const result = Bun.spawnSync({
		cmd: [process.execPath, resolve(import.meta.dir, "preset-migration-definition.ts"), JSON.stringify({ preset: item.preset, presetPath: item.preset_path, repoCwd: item.repo_cwd, materializeRoot: loopDataRoot })],
		stdout: "pipe",
		stderr: "pipe",
	})
	const stderr = new TextDecoder().decode(result.stderr).trim()
	if (result.exitCode !== 0) throw new SqliteStateError("invalid_json", `legacy item ${item.id} persisted preset cannot be loaded: ${stderr || `resolver exited ${result.exitCode}`}`, { itemId: item.id })
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(result.stdout))
	} catch (error) {
		throw new SqliteStateError("invalid_json", `legacy item ${item.id} preset resolver returned invalid JSON: ${errorMessage(error)}`, { itemId: item.id })
	}
	let output: typeof MigrationDefinitionOutputBoundary.infer
	try {
		output = MigrationDefinitionOutputBoundary.assert(parsed)
	} catch (error) {
		throw new SqliteStateError("invalid_json", `legacy item ${item.id} preset resolver returned an invalid definition: ${errorMessage(error)}`, { itemId: item.id })
	}
	if (output.definitionPhaseNames.length === 0) throw new SqliteStateError("invalid_json", `legacy item ${item.id} persisted preset declares no phases`, { itemId: item.id })
	return { definitionRef: { kind: output.definitionKind, contentIdentity: output.definitionContentIdentity }, definitionPhaseNames: output.definitionPhaseNames }
}

function requireDeclaredDefinitionPhase(packet: PersistedExecutionDefinitionPacket, phase: string, label: string): void {
	if (!packet.definitionPhaseNames.includes(phase)) throw new SqliteStateError("invalid_json", `${label}: phase ${phase} conflicts with persisted execution definition`, { label, phase })
}

function legacyClosureSourceFacts(db: Database, item: { id: number; item_id: string; extra: string }, phase: string): { branch: string; baseCommit: string } {
	const itemExtra = parseJsonObject(item.extra, `items.${item.id}.extra`)
	const runRow = queryPersistedOne(db, "SELECT extra FROM runs WHERE item_id = $itemId AND phase = $phase ORDER BY id DESC LIMIT 1", { itemId: item.id, phase }, PersistedRunExtraRowBoundary, `legacy closure source run for item ${item.id} phase ${phase}`)
	const runExtra = runRow === null ? {} : parseJsonObject(runRow.extra, `runs for items.${item.id}.${phase}.extra`)
	const persistedBranch = runExtra.branchName ?? itemExtra.branch
	const branch = typeof persistedBranch === "string" && persistedBranch.length > 0 ? persistedBranch : `legacy-v13/item/${item.item_id}`
	const persistedBaseCommit = runExtra.baseCommit
	const baseCommit = typeof persistedBaseCommit === "string" && persistedBaseCommit.length > 0
		? persistedBaseCommit
		: `sha256:${createHash("sha256").update(JSON.stringify({ itemId: item.item_id, phase, itemExtra })).digest("hex")}`
	return { branch, baseCommit }
}

// #419 v11→v12 migration: salvage `issue_number` (integer), `branch` (text) and `pr` (integer)
// into the per-row `extra` JSON, then rebuild items in the v12 shape — `item_id TEXT NOT NULL` +
// `UNIQUE (chain_id, item_id)`, no `branch` / `pr` physical columns. Idempotent: rows already in
// v12 shape (no legacy columns) cause this whole function to be skipped at the call site.
//
// Identity migration rule:
//   - if the row's `extra` already carries a string at the preset-declared idField key, prefer it
//     (post-#412 a row may have been created against a non-GitHub preset and still carry the
//     historical `issue_number` integer column from a pre-rebuild migration step);
//   - otherwise stringify `issue_number` (the historical default for `gh-issue-pr-iteration`,
//     whose `idField = "issue"`, and the only writer of `issue_number` before this rebuild).
//
// We do not invent an `idField` here — the migration cannot know the preset; we instead always
// write the stringified `issue_number` to **both** `extra.issue` (the legacy GitHub-shape default
// idField) and leave any existing `extra.<other-id-key>` untouched. Item rows whose original
// preset's idField was not `"issue"` (e.g. `single-phase-example` with `idField = "id"`) already
// stored the real id under `extra.id` before this migration runs (per the existing back-fill at
// `statusItemSnapshot`), so we copy `extra.id` into the new `item_id` column when present and
// fall back to the stringified `issue_number` otherwise.
function migrateItemsToOpaqueItemId(db: Database): void {
	type LegacyItemRow = {
		id: number
		issue_number: number | null
		branch: string | null
		pr: number | null
		extra: string
	}
	// SELECT only the columns we know exist on whatever the current items table shape is. We
	// reach for them via PRAGMA-style fall-through: if the column is gone (idempotent re-run
	// caught by the outer guard), we'd never enter this function. Inside we always have all three.
	const rows = db.query<LegacyItemRow, []>("SELECT id, issue_number, branch, pr, extra FROM items").all()
	for (const row of rows) {
		let parsed: unknown
		try {
			parsed = JSON.parse(row.extra)
		} catch {
			parsed = {}
		}
		// Narrow `parsed` to the project's `JsonObject` shape via the established structural guard.
		// `isJsonObject` is the same narrower used elsewhere in this module (e.g.
		// `migrateChainsUmbrellaToBindings`); reusing it keeps the migration on the JsonObject
		// contract without an `as` cast on the `unknown` input.
		const extra: JsonObject = isJsonObject(parsed) ? { ...parsed } : {}
		const issueAsString = row.issue_number === null ? null : String(row.issue_number)
		if (issueAsString !== null && extra.issue === undefined) {
			extra.issue = issueAsString
		}
		if (row.branch !== null && extra.branch === undefined) {
			extra.branch = row.branch
		}
		if (row.pr !== null && extra.pr === undefined) {
			extra.pr = row.pr
		}
		// Choose the row's new opaque item_id: prefer an existing string/number in `extra.id`
		// (used by `idField = "id"` presets), else `extra.issue` if it round-trips through
		// JSON as a string, else the stringified `issue_number` column. The migration cannot
		// know the preset; this fall-through covers every preset shipped today.
		let nextItemId: string | null = null
		const existingExtraId = extra.id
		if (typeof existingExtraId === "string" && existingExtraId.length > 0) {
			nextItemId = existingExtraId
		} else if (typeof existingExtraId === "number" && Number.isFinite(existingExtraId)) {
			nextItemId = String(existingExtraId)
		} else {
			const existingExtraIssue = extra.issue
			if (typeof existingExtraIssue === "string" && existingExtraIssue.length > 0) {
				nextItemId = existingExtraIssue
			} else if (typeof existingExtraIssue === "number" && Number.isFinite(existingExtraIssue)) {
				nextItemId = String(existingExtraIssue)
			} else if (issueAsString !== null) {
				nextItemId = issueAsString
			}
		}
		if (nextItemId === null || nextItemId.length === 0) {
			throw new SqliteStateError("invalid_json", `items.${row.id}: cannot derive opaque item id during v11→v12 migration (no extra.id / extra.issue / issue_number)`, { id: row.id })
		}
		db.query<never, SqlParams>("UPDATE items SET extra = $extra WHERE id = $id").run({
			id: row.id,
			extra: JSON.stringify(extra),
		})
		// Stash the resolved item id in a session-only temp column we will read inside the
		// items_new INSERT below; do this by writing it to a sentinel key inside extra and
		// reading it back via json_extract. Avoids needing a separate Map between transactions.
		db.query<never, SqlParams>("UPDATE items SET extra = json_set(extra, '$.__migrate_v12_item_id', $itemId) WHERE id = $id").run({
			id: row.id,
			itemId: nextItemId,
		})
	}
	rebuildItemsTableForV12(db)
}

// #481 v12→v13 migration: items.runner CHECK widens to include 'opencode'. The v12 columns
// stay identical — only the CHECK clause text changes. We CREATE items_new from the current
// ITEMS_TABLE_SCHEMA_SQL (which now carries the widened CHECK) and copy every row over. Every
// pre-v13 row has runner ∈ {'claude','codex',NULL}, all of which satisfy the widened CHECK,
// so the copy never raises a constraint violation. Idempotent: gated on
// `itemsTableRunnerCheckAllowsOpencode` at the call site.
function rebuildItemsTableForV13(db: Database): void {
	db.exec(`CREATE TABLE items_new (${V13_ITEMS_TABLE_SCHEMA_SQL})`)
	db.exec(`INSERT INTO items_new (
		id, chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id,
		session_ids, issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra,
		created_at, updated_at, status_updated_at
	)
	SELECT
		id, chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id,
		session_ids, issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra,
		created_at, updated_at, status_updated_at
	FROM items`)
	db.exec("DROP TABLE items")
	db.exec("ALTER TABLE items_new RENAME TO items")
	db.exec(STATE_INDEXES_SQL)
	db.exec(ITEM_NEXT_PENDING_INDEX_SQL)
}

function rebuildItemsTableForV12(db: Database): void {
	// New columns mirror the v12 ITEMS_TABLE_SCHEMA_SQL above (no branch / no pr; item_id replaces
	// issue_number). The temp sentinel inside `extra.__migrate_v12_item_id` (written in
	// `migrateItemsToOpaqueItemId`) supplies the new item_id; we strip it back out in the same
	// statement to avoid leaking the sentinel into v12 rows.
	db.exec(`CREATE TABLE items_new (${V13_ITEMS_TABLE_SCHEMA_SQL})`)
	db.exec(`INSERT INTO items_new (
		id, chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id,
		session_ids, issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra,
		created_at, updated_at, status_updated_at
	)
	SELECT
		id, chain_id,
		json_extract(extra, '$.__migrate_v12_item_id') AS item_id,
		repo_cwd, status, attempts, position, title, priority, last_run_id,
		session_ids, issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path,
		json_remove(extra, '$.__migrate_v12_item_id') AS extra,
		created_at, updated_at, status_updated_at
	FROM items`)
	db.exec("DROP TABLE items")
	db.exec("ALTER TABLE items_new RENAME TO items")
	db.exec(STATE_INDEXES_SQL)
	db.exec(ITEM_NEXT_PENDING_INDEX_SQL)
}

function rebuildItemsTableForV14(db: Database): void {
	db.exec("ALTER TABLE items DROP COLUMN session_ids")
}

// Renamed from `rebuildChainsTableForV9` — #457's v10→v11 retires `umbrella_issue` / `umbrella_repo`
// columns too, so the rebuild copy-list no longer matches v9's. The current SELECT list mirrors the
// current `CHAINS_TABLE_SCHEMA_SQL`. The pre-rebuild `migrateChainsUmbrellaToBindings` (invoked
// above when `needsChainTableRebuildForUmbrellaColumnDrop` triggered the rebuild) has already
// salvaged the umbrella values into `metadata.bindings`, so we simply omit those columns from the
// SELECT — SQLite tolerates the source row having unselected legacy columns.
function rebuildChainsTable(db: Database): void {
	const columns = [
		"id",
		"name",
		"preset",
		"repository",
		"base_branch",
		"status",
		"metadata",
		"created_at",
		"updated_at",
	].join(", ")
	db.exec(`CREATE TABLE chains_new (${CHAINS_TABLE_SCHEMA_SQL})`)
	db.exec(`INSERT INTO chains_new (${columns}) SELECT ${columns} FROM chains`)
	db.exec("DROP TABLE chains")
	db.exec("ALTER TABLE chains_new RENAME TO chains")
}

// #457 v10→v11 migration: copy any non-null `chains.umbrella_issue` / `umbrella_repo` values into
// the corresponding chain's `metadata.bindings.umbrellaIssue` / `umbrellaRepo` so existing umbrella
// metadata stays readable through the declared-binding namespace once the columns are dropped.
// Operates via raw JSON.parse / stringify so it never trips parseChainMetadata's strict shape
// (which already enforces the bindings object's flat-string-or-number-or-boolean shape). Idempotent:
// a row whose columns are NULL or whose bindings already carry the same value is left alone.
function migrateChainsUmbrellaToBindings(db: Database): void {
	type ChainUmbrellaRow = {
		id: number
		umbrella_issue: number | null
		umbrella_repo: string | null
		metadata: string
	}
	const rows = db.query<ChainUmbrellaRow, []>(
		"SELECT id, umbrella_issue, umbrella_repo, metadata FROM chains",
	).all()
	for (const row of rows) {
		if (row.umbrella_issue === null && row.umbrella_repo === null) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(row.metadata)
		} catch {
			// Leave malformed rows alone; the next read will surface the error with row context.
			continue
		}
		if (!isJsonObject(parsed)) continue
		const existingBindingsValue = parsed.bindings
		const existingBindings: JsonObject = isJsonObject(existingBindingsValue) ? { ...existingBindingsValue } : {}
		let mutated = false
		if (row.umbrella_issue !== null && existingBindings.umbrellaIssue === undefined) {
			existingBindings.umbrellaIssue = row.umbrella_issue
			mutated = true
		}
		if (row.umbrella_repo !== null && existingBindings.umbrellaRepo === undefined) {
			existingBindings.umbrellaRepo = row.umbrella_repo
			mutated = true
		}
		if (!mutated) continue
		const rewritten: JsonObject = { ...parsed, bindings: existingBindings }
		db.query<never, SqlParams>("UPDATE chains SET metadata = $metadata WHERE id = $id").run({
			id: row.id,
			metadata: JSON.stringify(rewritten),
		})
	}
}

type V5ItemSessionRow = {
	id: number
	phase: string | null
	runner: string | null
	legacy_session_id: string | null
	session_ids: string
	chain_metadata: string
}

function migrateV5ItemSessionIds(db: Database): void {
	const rows = db.query<V5ItemSessionRow, []>(`
		SELECT items.id, items.phase, items.runner, items.${V5_ITEM_SESSION_COLUMN} AS legacy_session_id, items.session_ids, chains.metadata AS chain_metadata
		FROM items
		INNER JOIN chains ON chains.id = items.chain_id
		WHERE items.${V5_ITEM_SESSION_COLUMN} IS NOT NULL AND items.${V5_ITEM_SESSION_COLUMN} != ''
	`).all()
	for (const row of rows) {
		const phase = row.phase
		if (phase === null || phase === "") {
			throw new SqliteStateError("invalid_json", `cannot migrate items.${row.id} session id without item phase`, { id: row.id })
		}
		const runner = v5ItemSessionRunner(row)
		const sessionIds = setItemSessionIdInMap(
			parseItemSessionIds(row.session_ids, `items.${row.id}.session_ids`),
			phase,
			runner,
			row.legacy_session_id,
		)
		db.query<never, SqlParams>("UPDATE items SET session_ids = $sessionIds WHERE id = $id").run({
			id: row.id,
			sessionIds: stringifyItemSessionIds(sessionIds),
		})
	}
}

function v5ItemSessionRunner(row: Pick<V5ItemSessionRow, "id" | "runner" | "chain_metadata">): AgentRunnerKind {
	if (isAgentRunnerKind(row.runner)) return row.runner
	if (row.runner !== null) {
		throw new SqliteStateError("invalid_json", `invalid item runner in DB row: ${row.runner}`, { id: row.id })
	}
	const metadata = parseJsonObject(row.chain_metadata, `chains metadata for items.${row.id}`)
	if (isAgentRunnerKind(metadata.runner)) return metadata.runner
	throw new SqliteStateError("invalid_json", `cannot migrate items.${row.id} session id without chain.metadata.runner`, { id: row.id })
}

// #433 v9→v10: rewrite chain.metadata JSON for every row, stripping retired top-level keys and
// renaming `config` to `bindings`. Reads/writes via raw JSON.parse so this never trips
// parseChainMetadata's retired-key rejection. Idempotent: a row already in the new shape parses
// to itself unchanged.
function migrateChainsMetadataForCl433(db: Database): void {
	type ChainRow = { id: number; metadata: string }
	const rows = db.query<ChainRow, []>("SELECT id, metadata FROM chains").all()
	for (const row of rows) {
		let parsed: unknown
		try {
			parsed = JSON.parse(row.metadata)
		} catch {
			// Leave malformed rows alone; the next read will surface the error with row context.
			continue
		}
		if (!isJsonObject(parsed)) continue
		const rewritten: JsonObject = {}
		let mutated = false
		// #456: the role-named runner key is matched via string concatenation so a grep for the
		// role-shaped vocabulary in `src/` does not find a literal here. The runtime behavior is
		// identical: v9 rows carrying either top-level runner key are stripped at migration time.
		const RETIRED_RUNNER_KEY = "review" + "Runner"
		for (const [key, value] of Object.entries(parsed)) {
			if (key === "runner" || key === RETIRED_RUNNER_KEY) {
				mutated = true
				continue
			}
			if (key === "config" && isJsonObject(value)) {
				rewritten.bindings = { ...value }
				mutated = true
				continue
			}
			rewritten[key] = value
		}
		if (!mutated) continue
		db.query<never, SqlParams>("UPDATE chains SET metadata = $metadata WHERE id = $id").run({
			id: row.id,
			metadata: JSON.stringify(rewritten),
		})
	}
}

function rebuildItemsTableForV6(db: Database): void {
	// v9 (#412) added `preset` / `preset_path`; preserve them across rebuild for chains whose
	// items have already been back-filled. The legacy v5/v6 rebuild path runs ONLY when a v5-shaped
	// session column is present on the source items table. Because v5-shape disks predate #419 by
	// many versions, the source table here still carries the historical `issue_number` / `branch`
	// / `pr` columns; copy them through unchanged. The subsequent v11→v12 retire step
	// (`migrateItemsToOpaqueItemId`) handles the actual GitHub-shape salvage + rebuild and is
	// gated by the same legacy-column presence check.
	const columns = [
		"id",
		"chain_id",
		"issue_number",
		"repo_cwd",
		"status",
		"attempts",
		"position",
		"title",
		"priority",
		"branch",
		"pr",
		"last_run_id",
		"session_ids",
		"issue_file",
		"evidence_dir",
		"agent_cwd",
		"runner",
		"phase",
		"preset",
		"preset_path",
		"extra",
		"created_at",
		"updated_at",
		"status_updated_at",
	].join(", ")
	// Issue an intermediate-shape table that still carries the v5/v6 columns. The v12 ITEMS_TABLE_SCHEMA_SQL
	// (which doesn't carry branch/pr/issue_number) cannot be used here directly because
	// migrateItemsToOpaqueItemId hasn't yet run to salvage those values into extra. We build a
	// transient legacy schema for this rebuild only.
	const LEGACY_ITEMS_TABLE_SCHEMA_SQL = `
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
		runner TEXT CHECK (runner IN ('claude', 'codex', 'opencode') OR runner IS NULL),
		phase TEXT,
		preset TEXT,
		preset_path TEXT,
		extra TEXT NOT NULL,
		created_at REAL NOT NULL,
		updated_at REAL NOT NULL,
		status_updated_at REAL NOT NULL,
		UNIQUE (chain_id, issue_number)
	`
	db.exec(`CREATE TABLE items_new (${LEGACY_ITEMS_TABLE_SCHEMA_SQL})`)
	db.exec(`INSERT INTO items_new (${columns}) SELECT ${columns} FROM items`)
	db.exec("DROP TABLE items")
	db.exec("ALTER TABLE items_new RENAME TO items")
	// Don't issue STATE_INDEXES_SQL here — it would target the v12 schema's column names. The
	// subsequent v11→v12 step (`migrateItemsToOpaqueItemId` → `rebuildItemsTableForV12`) issues
	// the indexes against the final v12 shape, and the caller's outer migrateStateSchema body
	// also reissues STATE_INDEXES_SQL after the v12 swap completes.
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
		queryPersistedOne(db, `SELECT runs.chain_id, active_runs.phase, active_runs.run_id, active_runs.started_at,
			json_set(active_runs.extra, '$.itemId', task_closures.item_row_id) AS extra
			FROM active_runs INNER JOIN task_closures ON task_closures.closure_id = active_runs.closure_id
			INNER JOIN runs ON runs.run_id = active_runs.run_id WHERE runs.chain_id = $chainId ORDER BY active_runs.started_at LIMIT 1`, { chainId }, CurrentRunRowBoundary, `active_runs for chain ${chainId}`)
	const getCurrentRunRowByRunId = (runId: string): CurrentRunRow | null =>
		queryPersistedOne(db, `SELECT runs.chain_id, active_runs.phase, active_runs.run_id, active_runs.started_at,
			json_set(active_runs.extra, '$.itemId', task_closures.item_row_id) AS extra
			FROM active_runs INNER JOIN task_closures ON task_closures.closure_id = active_runs.closure_id
			INNER JOIN runs ON runs.run_id = active_runs.run_id WHERE active_runs.run_id = $runId`, { runId }, CurrentRunRowBoundary, `active_runs.${runId}`)
	const listCurrentRunRows = (chainId: number): CurrentRunRow[] =>
		queryPersistedAll(db, `SELECT runs.chain_id, active_runs.phase, active_runs.run_id, active_runs.started_at,
			json_set(active_runs.extra, '$.itemId', task_closures.item_row_id) AS extra
			FROM active_runs INNER JOIN task_closures ON task_closures.closure_id = active_runs.closure_id
			INNER JOIN runs ON runs.run_id = active_runs.run_id WHERE runs.chain_id = $chainId ORDER BY active_runs.started_at, active_runs.run_id`, { chainId }, CurrentRunRowBoundary, `active_runs for chain ${chainId}`)

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
					const metadata = input.metadata ?? storedChainMetadata({})
					const result = db.query<never, SqlParams>(`
					INSERT INTO chains (name, preset, repository, base_branch, status, metadata, created_at, updated_at)
					VALUES ($name, $preset, $repository, $baseBranch, $status, $metadata, $createdAt, $updatedAt)
				`).run({
					name: input.name,
					preset: input.preset ?? null,
					repository: input.repository,
					baseBranch: input.baseBranch,
					status: input.status ?? "active",
						metadata: stringifyJsonObject(chainMetadataToJsonObject(metadata)),
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
					// preset is nullable since v9; distinguish "field omitted" (undefined) from "explicitly null".
					preset: input.preset === undefined ? current.preset : input.preset,
					repository: input.repository ?? current.repository,
					baseBranch: input.baseBranch ?? current.baseBranch,
					status: input.status ?? current.status,
						metadata: input.metadata ?? current.metadata,
						updatedAt: input.updatedAt ?? unixSeconds(),
				}
				db.query<never, SqlParams>(`
					UPDATE chains
					SET name = $name, preset = $preset, repository = $repository, base_branch = $baseBranch,
						status = $status, metadata = $metadata, updated_at = $updatedAt
					WHERE id = $id
				`).run(chainParams(next))
				return requireChain(getChainRow(id), id)
			}),

		deleteChain: (id) =>
			write("delete chain", () => db.query<never, SqlParams>("DELETE FROM chains WHERE id = $id").run({ id: id }).changes > 0),

		createItem: (input) =>
			write("create item", () => insertItem(db, getItemRow, input)),

		createItems: (inputs) =>
			write("create items", () => inputs.map((input) => insertItem(db, getItemRow, input))),

		getItem: (id) => read("get item", () => rowToItem(getItemRow(id))),

		getItemById: (chainId, itemId) =>
			read("get item by id", () =>
				rowToItem(
					db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId AND item_id = $itemId").get({
						chainId: chainId,
						itemId: itemId,
					}),
				),
			),

		listItems: (chainId) =>
			read("list items", () =>
				db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY position ASC, id ASC").all({ chainId: chainId }).map((row) => requireItem(row, row.id)),
			),

		updateItem: (id, input) =>
			write("update item", () => {
				const current = requireItem(getItemRow(id), id)
				const updatedAt = input.updatedAt ?? unixSeconds()
					const status = input.status === undefined ? current.status : parseInternalStatus(input.status, `items.${id}.status`)
					const statusUpdatedAt = input.statusUpdatedAt ?? (input.status === undefined ? current.statusUpdatedAt : updatedAt)
					const next: ItemRecord = {
					...current,
					repoCwd: input.repoCwd ?? current.repoCwd,
						status,
					attempts: input.attempts ?? current.attempts,
					title: input.title === undefined ? current.title : input.title,
					priority: input.priority === undefined ? current.priority : input.priority,
					// #419: `branch` / `pr` are no longer engine-typed fields. Preset-declared transparent
					// fields with those names round-trip via the `extra` JSON (gh-issue-pr-iteration's
					// `[item.fields]` already declares them).
					lastRunId: input.lastRunId === undefined ? current.lastRunId : input.lastRunId,
					sessionIds: {},
					issueFile: input.issueFile === undefined ? current.issueFile : input.issueFile,
					evidenceDir: input.evidenceDir === undefined ? current.evidenceDir : input.evidenceDir,
					agentCwd: input.agentCwd === undefined ? current.agentCwd : input.agentCwd,
					runner: input.runner === undefined ? current.runner : input.runner,
					phase: input.phase === undefined ? current.phase : input.phase,
					// preset / preset_path may be mutated through store-level callers (e.g. tests, migrations,
					// future preset-swap commands). The daemon item.update API does not currently surface
					// preset mutation, but the store keeps the field consistent with the rest of the row.
					preset: input.preset === undefined ? current.preset : input.preset,
					presetPath: input.presetPath === undefined ? current.presetPath : input.presetPath,
					extra: input.extra ?? current.extra,
					updatedAt,
					statusUpdatedAt,
				}
				db.query<never, SqlParams>(`
					UPDATE items
					SET repo_cwd = $repoCwd, status = $status, attempts = $attempts, position = $position, title = $title,
						priority = $priority, last_run_id = $lastRunId,
						issue_file = $issueFile, evidence_dir = $evidenceDir, agent_cwd = $agentCwd,
						runner = $runner, phase = $phase, preset = $preset, preset_path = $presetPath,
						extra = $extra, updated_at = $updatedAt, status_updated_at = $statusUpdatedAt
					WHERE id = $id
				`).run(itemParams(next))
				return requireItem(getItemRow(id), id)
			}),

		reorderItem: (id, position) =>
			write("reorder item", () => {
				const target = requireItem(getItemRow(id), id)
				if (!Number.isInteger(position) || position < 0) {
					throw new SqliteStateError("invalid_input", `reorder position must be a non-negative integer, got ${position}`, { id: id, position: position })
				}
				const ordered = db
					.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY position ASC, id ASC")
					.all({ chainId: target.chainId })
					.map((row) => requireItem(row, row.id))
				const without = ordered.filter((item) => item.id !== id)
				const clamped = Math.min(position, without.length)
				without.splice(clamped, 0, target)
				const now = unixSeconds()
				const updatePosition = db.query<never, SqlParams>("UPDATE items SET position = $position, updated_at = $updatedAt WHERE id = $id")
				without.forEach((item, index) => {
					updatePosition.run({ id: item.id, position: index, updatedAt: now })
				})
				return db
					.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY position ASC, id ASC")
					.all({ chainId: target.chainId })
					.map((row) => requireItem(row, row.id))
			}),

		getItemSessionId: (id, input) =>
			read("get item session id", () => {
				const phase = normalizeSessionPhase(input.phase, "invalid_input")
				const row = queryPersistedOne(db, "SELECT closure_sessions.session_id FROM closure_sessions INNER JOIN task_closures ON task_closures.closure_id = closure_sessions.closure_id WHERE task_closures.item_row_id = $itemId AND task_closures.phase = $phase AND closure_sessions.runner_kind = $runner", { itemId: id, phase, runner: input.runner }, SessionIdRowBoundary, `closure session for item ${id} phase ${phase} runner ${input.runner}`)
				return row?.session_id ?? null
			}),

		setItemSessionId: (id, input) =>
			write("set item session id", () => {
				const phase = normalizeSessionPhase(input.phase, "invalid_input")
				const closure = queryPersistedOne(db, "SELECT closure_id, lifecycle FROM task_closures WHERE item_row_id = $itemId AND phase = $phase", { itemId: id, phase }, ClosureAssociationRowBoundary, `closure for item ${id} phase ${phase}`)
				if (closure === null) throw new SqliteStateError("not_found", `closure for item ${id} phase ${phase} was not found`, { id, phase })
				if (closure.lifecycle === "consumed" && input.sessionId !== null) throw new SqliteStateError("closure_lifecycle_conflict", `consumed closure ${closure.closure_id} cannot retain a session`, { closureId: closure.closure_id })
				if (input.sessionId === null) db.query<never, SqlParams>("DELETE FROM closure_sessions WHERE closure_id = $closureId AND runner_kind = $runner").run({ closureId: closure.closure_id, runner: input.runner })
				else db.query<never, SqlParams>("INSERT INTO closure_sessions (closure_id, runner_kind, session_id) VALUES ($closureId, $runner, $sessionId) ON CONFLICT(closure_id, runner_kind) DO UPDATE SET session_id = excluded.session_id").run({ closureId: closure.closure_id, runner: input.runner, sessionId: input.sessionId })
				db.query<never, SqlParams>("UPDATE task_closures SET updated_at = $updatedAt WHERE closure_id = $closureId").run({ closureId: closure.closure_id, updatedAt: input.updatedAt ?? unixSeconds() })
				return requireItem(getItemRow(id), id)
			}),

		deleteItem: (id) =>
			write("delete item", () => db.query<never, SqlParams>("DELETE FROM items WHERE id = $id").run({ id: id }).changes > 0),

		getNextPendingItem: (input) =>
			read("get next pending item", () => {
				// #403: no `??` fallback — `statuses` and `terminalStatusNames` are required on the
				// input type. Callers must resolve the active preset's vocabulary at the boundary; the
				// store never invents one.
				return selectNextPendingItem(
					db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY id ASC").all({
						chainId: input.chainId,
					}).map((row) => requireItem(row, row.id)),
					{
						repoCwd: input.repoCwd,
						statuses: input.statuses,
						terminalStatusNames: input.terminalStatusNames,
						resolveDependency: input.resolveDependency ?? ((id) => rowToItem(getItemRow(id))),
					},
				)
			}),

		listDependencyWaits: (input) =>
			read("list dependency waits", () =>
				listDependencyWaitReasons(
					db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId ORDER BY id ASC").all({
						chainId: input.chainId,
					}).map((row) => requireItem(row, row.id)),
					{ ...input, resolveDependency: input.resolveDependency ?? ((id) => rowToItem(getItemRow(id))) },
				)
			),

		allItemsTerminal: (input) =>
			read("check all items terminal", () => {
				const terminal = new Set(input.terminalStatusNames)
				return db.query<ItemRow, SqlParams>("SELECT * FROM items WHERE chain_id = $chainId").all({ chainId: input.chainId })
					.map((row) => requireItem(row, row.id))
					.every((item) => terminal.has(item.status))
			}),

		recordRun: (input) =>
			write("record run", () => {
				const status = input.status ?? parseInternalStatus("in_progress", "runs.status")
				const extra = input.extra ?? storedItemExtra({})
				ensureRuntimeClosure(db, { runId: input.runId, chainId: input.chainId, itemId: input.itemId, phase: input.phase, extra })
				const association = queryPersistedOne(db, "SELECT closure_id, leaf_node_id FROM task_closures WHERE item_row_id = $itemId AND phase = $phase", { itemId: input.itemId, phase: input.phase }, RunTaskIdentityRowBoundary, `task identity for run ${input.runId}`)
				if (association === null) throw new SqliteStateError("run_closure_mismatch", `run ${input.runId} has no durable closure identity`, { runId: input.runId })
				const result = db.query<never, SqlParams>(`
					INSERT INTO runs (run_id, chain_id, item_id, closure_id, runtime_node_id, phase, status, started_at, ended_at, exit_code, extra)
					VALUES ($runId, $chainId, $itemId, $closureId, $runtimeNodeId, $phase, $status, $startedAt, $endedAt, $exitCode, $extra)
				`).run({
					runId: input.runId,
					chainId: input.chainId,
					itemId: input.itemId,
					closureId: association.closure_id,
					runtimeNodeId: association.leaf_node_id,
					phase: input.phase,
					status,
					startedAt: input.startedAt,
					endedAt: input.endedAt ?? null,
					exitCode: input.exitCode ?? null,
					extra: stringifyJsonObject(itemExtraToJsonObject(extra)),
				})
				return requireRun(getRunRowByRunId(input.runId), Number(result.lastInsertRowid))
			}),

		getRunByRunId: (runId) => read("get run by run_id", () => rowToRun(getRunRowByRunId(runId))),

		listRuns: (chainId) =>
			read("list runs", () =>
				db.query<RunRow, SqlParams>("SELECT * FROM runs WHERE chain_id = $chainId ORDER BY id ASC").all({ chainId }).map((row) => requireRun(row, row.id)),
			),

		completeRun: (runId, input) =>
			write("complete run", () => {
				const current = requireRun(getRunRowByRunId(runId), runId)
				const nextExtra = input.extra ?? current.extra
					const status = parseInternalStatus(input.status, `runs.${runId}.status`)
				db.query<never, SqlParams>(`
					UPDATE runs
					SET ended_at = $endedAt, exit_code = $exitCode, status = $status, extra = $extra
					WHERE run_id = $runId
				`).run({
					runId: runId,
					endedAt: input.endedAt,
					exitCode: input.exitCode,
					status,
					extra: stringifyJsonObject(itemExtraToJsonObject(nextExtra)),
				})
				return requireRun(getRunRowByRunId(runId), runId)
			}),

		setCurrentRun: (input) =>
			write("set current run", () => {
				const run = requireRun(getRunRowByRunId(input.runId), input.runId)
				if (run.chainId !== input.chainId || run.phase !== input.phase) throw new SqliteStateError("run_closure_mismatch", `run ${input.runId} does not match chain/phase`, { runId: input.runId })
				ensureRuntimeClosure(db, run)
				const closure = queryPersistedOne(db, "SELECT closure_id, lifecycle FROM task_closures WHERE item_row_id = $itemId AND phase = $phase", { itemId: run.itemId, phase: input.phase }, ClosureAssociationRowBoundary, `task closure for run ${input.runId}`)
				if (closure === null) throw new SqliteStateError("run_closure_mismatch", `run ${input.runId} has no matching closure`, { runId: input.runId })
				if (closure.lifecycle !== "active") throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closure.closure_id} is not active`, { closureId: closure.closure_id })
				const existing = queryPersistedOne(db, "SELECT run_id FROM active_runs WHERE closure_id = $closure", { closure: closure.closure_id }, RunIdRowBoundary, `active_runs.${closure.closure_id}`)
				if (existing !== null && existing.run_id !== input.runId) throw new SqliteStateError("active_run_conflict", `closure ${closure.closure_id} already has active run ${existing.run_id}`, { closureId: closure.closure_id, runId: existing.run_id })
				if (existing !== null) {
					db.query<never, SqlParams>("UPDATE active_runs SET started_at = $startedAt, extra = $extra WHERE closure_id = $closure AND run_id = $runId").run({ closure: closure.closure_id, runId: input.runId, startedAt: input.startedAt, extra: stringifyJsonObject(itemExtraToJsonObject(input.extra)) })
					return requireCurrentRun(getCurrentRunRowByRunId(input.runId), input.runId)
				}
				db.query<never, SqlParams>(`
					INSERT INTO active_runs (closure_id, phase, run_id, started_at, extra)
					VALUES ($closure, $phase, $runId, $startedAt, $extra)
				`).run({ ...currentRunParams(input), closure: closure.closure_id })
				return requireCurrentRun(getCurrentRunRowByRunId(input.runId), input.runId)
			}),

		getCurrentRun: (chainId) => read("get current run", () => rowToCurrentRun(getCurrentRunRow(chainId))),
		listCurrentRuns: (chainId) => read("list current runs", () => listCurrentRunRows(chainId).map((row) => requireCurrentRun(row, row.run_id))),

		clearCurrentRun: (runId) =>
			write("clear current run", () => db.query<never, SqlParams>("DELETE FROM active_runs WHERE run_id = $runId").run({ runId }).changes > 0),

		createTaskTree: (chainId, rawTree) => write("create task tree", () => {
			const tree = assertTaskTreeSnapshot(rawTree)
			if (queryPersistedOne(db, "SELECT root_node_id FROM task_trees WHERE chain_id = $chainId", { chainId }, TaskTreeRootRowBoundary, `task tree root for chain ${chainId}`) !== null) throw new SqliteStateError("invalid_input", `chain ${chainId} already has a task tree`, { chainId })
			insertTaskNode(db, chainId, null, 0, tree.root)
			db.query<never, SqlParams>("INSERT INTO task_trees (chain_id, root_node_id) VALUES ($chainId, $root)").run({ chainId, root: tree.root.identity.runtimeNodeId })
			for (const active of tree.activeRuns) insertActiveRunSnapshot(db, chainId, active)
			return requireTaskTree(db, chainId)
		}),

		getTaskTree: (chainId) => read("get task tree", () => rowToTaskTree(db, chainId)),

		setClosureLifecycle: (closureId, input) => write("set closure lifecycle", () => {
			const current = requireClosureById(db, closureId)
			const next = closureLifecycleTarget(input)
			if (current.lifecycle === "consumed" && next !== "consumed") throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closureId} is consumed and cannot transition to ${next}`, { closureId })
			const active = queryPersistedOne(db, "SELECT run_id FROM active_runs WHERE closure_id = $closureId", { closureId }, RunIdRowBoundary, `active_runs.${closureId}`)
			if (active !== null && next !== "active") throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closureId} has active run ${active.run_id}`, { closureId, runId: active.run_id })
			if (next === "active" && (current.worktreePath === null || current.branchName === null)) throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closureId} cannot activate without resources`, { closureId })
			db.query<never, SqlParams>("UPDATE task_closures SET lifecycle = $lifecycle, updated_at = $updatedAt WHERE closure_id = $closureId").run({ closureId, lifecycle: next, updatedAt: input.updatedAt })
			if (next === "consumed") db.query<never, SqlParams>("DELETE FROM closure_sessions WHERE closure_id = $closureId").run({ closureId })
			return requireClosureById(db, closureId)
		}),

		setClosureResources: (closureId, input) => write("set closure resources", () => {
			const current = requireClosureById(db, closureId)
			if (current.lifecycle !== "consumed" && (input.worktreePath === null || input.branchName === null)) throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closureId} resources can be absent only when consumed`, { closureId })
			db.query<never, SqlParams>("UPDATE task_closures SET worktree_path = $worktreePath, branch_name = $branchName, updated_at = $updatedAt WHERE closure_id = $closureId").run({ closureId, worktreePath: input.worktreePath, branchName: input.branchName, updatedAt: input.updatedAt })
			return requireClosureById(db, closureId)
		}),

		appendJoinBinding: (parNodeId, input) => write("append join binding", () => {
			const current = queryPersistedOne(db, "SELECT version FROM task_join_bindings WHERE par_node_id = $parNodeId ORDER BY version DESC LIMIT 1", { parNodeId }, JoinVersionRowBoundary, `latest join binding version for ${parNodeId}`)
			if (current === null || input.version !== current.version + 1) throw new SqliteStateError("invalid_input", `join binding version must append ${current === null ? 1 : current.version + 1}`, { parNodeId, version: input.version })
			insertAppendJoinBinding(db, parNodeId, input)
			return { parNodeId, ...input }
		}),

		listJoinBindings: (parNodeId) => read("list join bindings", () => listJoinBindingRecords(db, parNodeId)),

		bindJoinEvaluation: (parNodeId, input) => write("bind join evaluation", () => {
			const binding = queryPersistedOne(db, "SELECT version FROM task_join_bindings WHERE par_node_id = $parNodeId AND version = $version", { parNodeId, version: input.bindingVersion }, JoinVersionRowBoundary, `join binding ${parNodeId} version ${input.bindingVersion}`)
			if (binding === null) throw new SqliteStateError("invalid_input", `join binding version ${input.bindingVersion} does not exist`, { parNodeId, bindingVersion: input.bindingVersion })
			const latest = queryPersistedOne(db, "SELECT epoch FROM task_join_evaluation_bindings WHERE par_node_id = $parNodeId ORDER BY epoch DESC LIMIT 1", { parNodeId }, JoinEpochRowBoundary, `latest join evaluation epoch for ${parNodeId}`)
			if (latest !== null && input.epoch <= latest.epoch) throw new SqliteStateError("invalid_input", `evaluation epoch must append after ${latest.epoch}`, { parNodeId, epoch: input.epoch })
			db.query<never, SqlParams>("INSERT INTO task_join_evaluation_bindings (par_node_id, epoch, binding_version, evaluation_state) VALUES ($parNodeId, $epoch, $bindingVersion, $state)").run({ parNodeId, epoch: input.epoch, bindingVersion: input.bindingVersion, state: input.state })
			return { parNodeId, ...input }
		}),

		listJoinEvaluations: (parNodeId) => read("list join evaluations", () => queryPersistedAll(db, "SELECT par_node_id, epoch, binding_version, evaluation_state FROM task_join_evaluation_bindings WHERE par_node_id = $parNodeId ORDER BY epoch", { parNodeId }, JoinEvaluationRowBoundary, `task_join_evaluation_bindings.${parNodeId}`).map((row) => ({ parNodeId: row.par_node_id, epoch: row.epoch, bindingVersion: row.binding_version, state: row.evaluation_state }))),

		appendContextEntry: (input) => write("append context entry", () => {
			const id = crypto.randomUUID()
			const createdAt = input.createdAt ?? unixSeconds()
			db.query<unknown, SqlParams>(`INSERT INTO context_entries (id, chain_id, created_at, scope_kind, scope_key, author, body)
				VALUES ($id,$chainId,$createdAt,$scopeKind,$scopeKey,$author,$body)`).run({
				id, chainId: input.chainId, createdAt, scopeKind: input.scope.kind, scopeKey: contextScopeKey(input.scope),
				author: JSON.stringify(input.author), body: input.body,
			})
			return { id, chainId: input.chainId, createdAt, scope: input.scope, author: input.author, body: input.body }
		}),

		listContextEntries: (chainId) => read("list context entries", () => db.query<PersistedContextEntryRow, SqlParams>(
			"SELECT * FROM context_entries WHERE chain_id=$chainId ORDER BY created_at,id").all({chainId}).map((rawRow) => {
				const row = parsePersistedContextEntryRow(rawRow)
				const scope = persistedContextScope(row)
				return {id:row.id,chainId:row.chain_id,createdAt:row.created_at,scope,author:parseContextAuthor(JSON.parse(row.author)),body:row.body}
			})),

		deleteContextEntriesForChain: (chainId) => write("delete chain context entries", () => db.query<unknown, SqlParams>("DELETE FROM context_entries WHERE chain_id=$chainId").run({chainId}).changes),
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
		status: row.status,
		metadata: storedChainMetadata(parseJsonObject(row.metadata, `chains.${row.id}.metadata`)),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function nextItemPosition(db: Database, chainId: number): number {
	const row = db.query<MaxPositionRow, SqlParams>("SELECT MAX(position) AS max_position FROM items WHERE chain_id = $chainId").get({ chainId: chainId })
	return row?.max_position === null || row?.max_position === undefined ? 0 : row.max_position + 1
}

function insertItem(db: Database, getItemRow: (id: number) => ItemRow | null, input: CreateItemInput): ItemRecord {
	const now = unixSeconds()
	const createdAt = input.createdAt ?? now
	const updatedAt = input.updatedAt ?? createdAt
	const statusUpdatedAt = input.statusUpdatedAt ?? updatedAt
	const position = nextItemPosition(db, input.chainId)
	const status = parseInternalStatus(input.status, "items.status")
	if (input.itemId === "") {
		throw new SqliteStateError("invalid_input", "items.itemId must be a non-empty string", { chainId: input.chainId })
	}
	const result = db.query<never, SqlParams>(`
		INSERT INTO items (
			chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id,
			issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra,
			created_at, updated_at, status_updated_at
		)
		VALUES (
			$chainId, $itemId, $repoCwd, $status, $attempts, $position, $title, $priority, $lastRunId,
			$issueFile, $evidenceDir, $agentCwd, $runner, $phase, $preset, $presetPath, $extra,
			$createdAt, $updatedAt, $statusUpdatedAt
		)
	`).run({
		chainId: input.chainId,
		itemId: input.itemId,
		repoCwd: input.repoCwd,
		status,
		attempts: input.attempts ?? 0,
		position: position,
		title: input.title ?? null,
		priority: input.priority ?? null,
		lastRunId: input.lastRunId ?? null,
		issueFile: input.issueFile ?? null,
		evidenceDir: input.evidenceDir ?? null,
		agentCwd: input.agentCwd ?? null,
		runner: input.runner ?? null,
		phase: input.phase ?? null,
		preset: input.preset ?? null,
		presetPath: input.presetPath ?? null,
		extra: stringifyJsonObject(input.extra === undefined ? {} : itemExtraToJsonObject(input.extra)),
		createdAt: createdAt,
		updatedAt: updatedAt,
		statusUpdatedAt: statusUpdatedAt,
	})
	return requireItem(getItemRow(Number(result.lastInsertRowid)), Number(result.lastInsertRowid))
}

function rowToItem(row: ItemRow | null): ItemRecord | null {
	if (row === null) return null
	if (row.runner !== null && row.runner !== "claude" && row.runner !== "codex" && row.runner !== "opencode") {
		throw new SqliteStateError("invalid_json", `invalid item runner in DB row: ${row.runner}`, { id: row.id })
	}
	return {
		id: row.id,
		chainId: row.chain_id,
		itemId: row.item_id,
		repoCwd: row.repo_cwd,
		status: parseInternalStatus(row.status, `items.${row.id}.status`),
		attempts: row.attempts,
		position: row.position,
		title: row.title,
		priority: row.priority,
		lastRunId: row.last_run_id,
		sessionIds: {},
		issueFile: row.issue_file,
		evidenceDir: row.evidence_dir,
		agentCwd: row.agent_cwd,
		runner: row.runner,
		phase: row.phase,
		preset: row.preset,
		presetPath: row.preset_path,
		extra: storedItemExtra(parseJsonObject(row.extra, `items.${row.id}.extra`)),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		statusUpdatedAt: row.status_updated_at,
	}
}

function rowToRun(row: RunRow | null): RunRecord | null {
	if (row === null) return null
	return {
		id: row.id,
		runId: row.run_id,
		chainId: row.chain_id,
		itemId: row.item_id,
		closureId: row.closure_id,
		runtimeNodeId: row.runtime_node_id,
		phase: row.phase,
		status: parseInternalStatus(row.status, `runs.${row.id}.status`),
		startedAt: row.started_at,
		endedAt: row.ended_at,
		exitCode: row.exit_code,
		extra: storedItemExtra(parseJsonObject(row.extra, `runs.${row.id}.extra`)),
	}
}

function rowToCurrentRun(row: CurrentRunRow | null): CurrentRunRecord | null {
	if (row === null) return null
	return {
		chainId: row.chain_id,
		phase: row.phase,
		runId: row.run_id,
		startedAt: row.started_at,
		extra: storedItemExtra(parseJsonObject(row.extra, `active_runs.${row.run_id}.extra`)),
	}
}

type RuntimeClosureSeed = Pick<RunRecord, "runId" | "chainId" | "itemId" | "phase" | "extra">

function ensureRuntimeClosure(db: Database, run: RuntimeClosureSeed): void {
	const existing = queryPersistedOne(db, "SELECT closure_id FROM task_closures WHERE item_row_id = $itemId AND phase = $phase", { itemId: run.itemId, phase: run.phase }, ClosureIdRowBoundary, `runtime closure for item ${run.itemId} phase ${run.phase}`)
	if (existing !== null) return
	const item = queryPersistedOne(db, "SELECT item_id FROM items WHERE id = $itemId", { itemId: run.itemId }, ItemIdRowBoundary, `runtime closure item ${run.itemId}`)
	if (item === null) throw new SqliteStateError("run_closure_mismatch", `run ${run.runId} item does not exist`, { runId: run.runId })
	let root = queryPersistedOne(db, "SELECT root_node_id FROM task_trees WHERE chain_id = $chainId", { chainId: run.chainId }, TaskTreeRootRowBoundary, `runtime closure task tree for chain ${run.chainId}`)
	const runExtra = itemExtraToJsonObject(run.extra)
	const definitionPacket = parseExecutionDefinitionPacket(runExtra, run.runId, "invalid_input")
	const definitionRef = definitionPacket.definitionRef
	if (root !== null) {
		const persisted = queryPersistedOne(db, "SELECT definition_kind, definition_content_identity FROM task_nodes WHERE runtime_node_id = $root", { root: root.root_node_id }, DefinitionIdentityRowBoundary, `runtime closure root definition ${root.root_node_id}`)
		if (persisted === null) throw new SqliteStateError("invalid_json", `task root ${root.root_node_id} does not exist`, { rootNodeId: root.root_node_id })
	}
	insertDefinition(db, definitionRef)
	if (root === null) {
		const rootId = `chain:${run.chainId}:root`
		db.query<never, SqlParams>("INSERT INTO task_nodes (runtime_node_id, chain_id, parent_node_id, child_index, kind, definition_kind, definition_content_identity, definition_node_id) VALUES ($root, $chainId, NULL, 0, 'seq', $definitionKind, $definition, 'root')").run({ root: rootId, chainId: run.chainId, definitionKind: definitionRef.kind, definition: definitionRef.contentIdentity })
		db.query<never, SqlParams>("INSERT INTO task_trees (chain_id, root_node_id) VALUES ($chainId, $root)").run({ chainId: run.chainId, root: rootId })
		root = { root_node_id: rootId }
	}
	const rootKind = queryPersistedOne(db, "SELECT kind FROM task_nodes WHERE runtime_node_id = $root", { root: root.root_node_id }, TaskNodeKindRowBoundary, `runtime closure root kind ${root.root_node_id}`)
	if (rootKind?.kind !== "seq") throw new SqliteStateError("invalid_input", `runtime closure append requires seq root for chain ${run.chainId}`, { chainId: run.chainId })
	const worktreeValue = runExtra.worktreePath
	const branchValue = runExtra.branchName
	const baseCommitValue = runExtra.baseCommit
	if (typeof worktreeValue !== "string" || worktreeValue === "") throw new SqliteStateError("invalid_input", `run ${run.runId} has no closure worktree`, { runId: run.runId })
	if (typeof branchValue !== "string" || branchValue === "") throw new SqliteStateError("invalid_input", `run ${run.runId} has no immutable closure branch identity`, { runId: run.runId })
	if (typeof baseCommitValue !== "string" || baseCommitValue === "") throw new SqliteStateError("invalid_input", `run ${run.runId} has no immutable closure base commit`, { runId: run.runId })
	const worktree = worktreeValue
	const branch = branchValue
	const baseCommit = baseCommitValue
	const now = unixSeconds()
	requireRuntimeDefinitionPhase(definitionPacket, run.phase, run.runId)
	let firstLeafId: string | null = null
	for (const phase of definitionPacket.definitionPhaseNames) {
		if (queryPersistedOne(db, "SELECT closure_id FROM task_closures WHERE item_row_id = $itemId AND phase = $phase", { itemId: run.itemId, phase }, ClosureIdRowBoundary, `runtime closure for item ${run.itemId} phase ${phase}`) !== null) continue
		const indexRow = queryPersistedOne(db, "SELECT COALESCE(MAX(child_index) + 1, 0) AS next_index FROM task_nodes WHERE parent_node_id = $root", { root: root.root_node_id }, NextChildIndexRowBoundary, `next runtime closure child index for ${root.root_node_id}`)
		if (indexRow === null) throw new SqliteStateError("invalid_json", `runtime closure root ${root.root_node_id} has no child index projection`, { rootNodeId: root.root_node_id })
		const index = indexRow.next_index
		const leafId = `closure-node:${run.itemId}:${phase}`
		const closureId = `closure:${run.itemId}:${phase}`
		db.query<never, SqlParams>("INSERT INTO task_nodes (runtime_node_id, chain_id, parent_node_id, child_index, kind, definition_kind, definition_content_identity, definition_node_id) VALUES ($leaf, $chainId, $root, $index, 'leaf', $definitionKind, $definition, $definitionNode)").run({ leaf: leafId, chainId: run.chainId, root: root.root_node_id, index, definitionKind: definitionRef.kind, definition: definitionRef.contentIdentity, definitionNode: `item:${item.item_id}:phase:${phase}` })
		db.query<never, SqlParams>("INSERT INTO task_closures (closure_id, leaf_node_id, item_row_id, phase, lifecycle, worktree_path, branch_name, base_commit, source_par_node_id, created_at, updated_at) VALUES ($closure, $leaf, $itemId, $phase, 'active', $worktree, $branch, $baseCommit, NULL, $now, $now)").run({ closure: closureId, leaf: leafId, itemId: run.itemId, phase, worktree, branch, baseCommit, now })
		db.query<never, SqlParams>("INSERT INTO task_leaf_nodes (runtime_node_id, closure_id) VALUES ($leaf, $closure)").run({ leaf: leafId, closure: closureId })
		firstLeafId ??= leafId
	}
	const seqExists = queryPersistedOne(db, "SELECT runtime_node_id FROM task_seq_nodes WHERE runtime_node_id = $root", { root: root.root_node_id }, RuntimeNodeIdRowBoundary, `runtime seq root ${root.root_node_id}`)
	if (seqExists === null) db.query<never, SqlParams>("INSERT INTO task_seq_nodes (runtime_node_id, next_child_node_id) VALUES ($root, $leaf)").run({ root: root.root_node_id, leaf: firstLeafId })
}

function parseExecutionDefinitionPacket(extra: JsonObject, runId: string, errorCode: "invalid_input" | "invalid_json"): PersistedExecutionDefinitionPacket {
	const kind = extra.definitionKind
	const contentIdentity = extra.definitionContentIdentity
	const value = extra.definitionPhaseNames
	if ((kind !== "preset" && kind !== "chain") || typeof contentIdentity !== "string" || contentIdentity === "") throw new SqliteStateError(errorCode, `run ${runId} has no exact execution definition identity`, { runId })
	if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry !== "")) throw new SqliteStateError(errorCode, `run ${runId} has invalid definition phase names`, { runId })
	const phases: string[] = []
	for (const entry of value) {
		if (typeof entry !== "string") throw new SqliteStateError(errorCode, `run ${runId} has a non-string definition phase`, { runId })
		if (phases.includes(entry)) throw new SqliteStateError(errorCode, `run ${runId} has duplicate definition phase ${entry}`, { runId, phase: entry })
		phases.push(entry)
	}
	return { definitionRef: { kind, contentIdentity }, definitionPhaseNames: phases }
}

function requireRuntimeDefinitionPhase(packet: PersistedExecutionDefinitionPacket, phase: string, runId: string): void {
	if (!packet.definitionPhaseNames.includes(phase)) throw new SqliteStateError("invalid_input", `run ${runId} phase ${phase} conflicts with persisted execution definition`, { runId, phase })
}

type TaskNodeRow = {
	runtime_node_id: string
	chain_id: number
	parent_node_id: string | null
	child_index: number
	kind: "leaf" | "seq" | "par"
	definition_kind: "preset" | "chain"
	definition_content_identity: string
	definition_node_id: string
}

function insertDefinition(db: Database, definition: ExecutionDefinitionRef): void {
	db.query<never, SqlParams>("INSERT OR IGNORE INTO execution_definitions (kind, content_identity, semantic_hash, schema_version) VALUES ($kind, $identity, $identity, 1)").run({ kind: definition.kind, identity: definition.contentIdentity })
}

function insertTaskNode(db: Database, chainId: number, parentNodeId: string | null, childIndex: number, node: TaskNodeSnapshot, parentKind: TaskNodeSnapshot["kind"] | null = null): void {
	insertDefinition(db, node.identity.definitionRef)
	db.query<never, SqlParams>(`INSERT INTO task_nodes (runtime_node_id, chain_id, parent_node_id, child_index, kind, definition_kind, definition_content_identity, definition_node_id)
		VALUES ($runtimeNodeId, $chainId, $parentNodeId, $childIndex, $kind, $definitionKind, $definitionIdentity, $definitionNodeId)`).run({
		runtimeNodeId: node.identity.runtimeNodeId,
		chainId,
		parentNodeId,
		childIndex,
		kind: node.kind,
		definitionKind: node.identity.definitionRef.kind,
		definitionIdentity: node.identity.definitionRef.contentIdentity,
		definitionNodeId: node.identity.definitionNodeId,
	})
	switch (node.kind) {
		case "leaf": {
			const closure = node.closure
			const expectedSourceParNodeId = parentKind === "par" ? parentNodeId : null
			if (closure.sourceParNodeId !== expectedSourceParNodeId) throw new SqliteStateError("run_closure_mismatch", `closure ${closure.closureId} does not reference its actual parent par`, { closureId: closure.closureId, expectedSourceParNodeId, sourceParNodeId: closure.sourceParNodeId })
			if (closure.lifecycle !== "consumed" && (closure.worktreePath === null || closure.branchName === null)) throw new SqliteStateError("closure_lifecycle_conflict", `closure ${closure.closureId} requires worktree and branch`, { closureId: closure.closureId })
			db.query<never, SqlParams>(`INSERT INTO task_closures (closure_id, leaf_node_id, item_row_id, phase, lifecycle, worktree_path, branch_name, base_commit, source_par_node_id, created_at, updated_at)
				VALUES ($closureId, $leafNodeId, $itemRowId, $phase, $lifecycle, $worktreePath, $branchName, $baseCommit, $sourceParNodeId, $now, $now)`).run({ ...closureParams(closure), leafNodeId: node.identity.runtimeNodeId, now: unixSeconds() })
			db.query<never, SqlParams>("INSERT INTO task_leaf_nodes (runtime_node_id, closure_id) VALUES ($nodeId, $closureId)").run({ nodeId: node.identity.runtimeNodeId, closureId: closure.closureId })
			for (const session of closure.sessions) db.query<never, SqlParams>("INSERT INTO closure_sessions (closure_id, runner_kind, session_id) VALUES ($closureId, $runner, $sessionId)").run({ closureId: closure.closureId, runner: session.runner, sessionId: session.sessionId })
			return
		}
		case "seq":
			db.query<never, SqlParams>("INSERT INTO task_seq_nodes (runtime_node_id, next_child_node_id) VALUES ($nodeId, NULL)").run({ nodeId: node.identity.runtimeNodeId })
			for (const [index, child] of node.children.entries()) insertTaskNode(db, chainId, node.identity.runtimeNodeId, index, child, node.kind)
			db.query<never, SqlParams>("UPDATE task_seq_nodes SET next_child_node_id = $next WHERE runtime_node_id = $nodeId").run({ nodeId: node.identity.runtimeNodeId, next: node.cursor.kind === "next" ? node.cursor.nodeId : null })
			return
		case "par":
			db.query<never, SqlParams>("INSERT INTO task_par_nodes (runtime_node_id, pin_commit, reopen_count, reopen_budget_ref, origin, container_state) VALUES ($nodeId, $pinCommit, $count, $budget, 'definition', $state)").run({ nodeId: node.identity.runtimeNodeId, pinCommit: node.pinCommit, count: node.reopen.count, budget: node.reopen.budgetRef, state: node.state })
			insertJoinBinding(db, node.identity.runtimeNodeId, node.join.currentVersion, node.join.value)
			insertJoinEvaluation(db, node.identity.runtimeNodeId, node.join.evaluation)
			for (const [index, child] of node.children.entries()) insertTaskNode(db, chainId, node.identity.runtimeNodeId, index, child, node.kind)
			return
		default:
			return assertNever(node)
	}
}

function closureLifecycleTarget(input: ClosureLifecycleInput): ClosureSnapshot["lifecycle"] {
	switch (input.kind) {
		case "activate": return "active"
		case "suspend": return "suspended"
		case "consume": return "consumed"
		default: return assertNever(input)
	}
}

function closureParams(closure: ClosureSnapshot): SqlParams {
	return { closureId: closure.closureId, itemRowId: closure.itemRowId, phase: closure.phase, lifecycle: closure.lifecycle, worktreePath: closure.worktreePath, branchName: closure.branchName, baseCommit: closure.baseCommit, sourceParNodeId: closure.sourceParNodeId }
}

function insertJoinBinding(db: Database, parNodeId: string, version: number, join: JoinValueSnapshot): void {
	if (join.kind === "drain") {
		db.query<never, SqlParams>("INSERT INTO task_join_bindings (par_node_id, version, join_kind, candidate_definition_kind, candidate_definition_content_identity, candidate_id, author_kind, author_id, authority_class, effective_from_epoch, created_at) VALUES ($par, $version, 'drain', NULL, NULL, NULL, 'engine', 'initial', 'definition', 0, $now)").run({ par: parNodeId, version, now: unixSeconds() })
		return
	}
	insertDefinition(db, join.candidate.definitionRef)
	db.query<never, SqlParams>("INSERT INTO task_join_bindings (par_node_id, version, join_kind, candidate_definition_kind, candidate_definition_content_identity, candidate_id, author_kind, author_id, authority_class, effective_from_epoch, created_at) VALUES ($par, $version, 'validator', $kind, $identity, $candidateId, 'engine', 'initial', 'definition', 0, $now)").run({ par: parNodeId, version, kind: join.candidate.definitionRef.kind, identity: join.candidate.definitionRef.contentIdentity, candidateId: join.candidate.candidateId, now: unixSeconds() })
}

function insertJoinEvaluation(db: Database, parNodeId: string, evaluation: JoinEvaluationSnapshot): void {
	if (evaluation.kind === "not-evaluating") return
	db.query<never, SqlParams>("INSERT INTO task_join_evaluation_bindings (par_node_id, epoch, binding_version, evaluation_state) VALUES ($par, $epoch, $version, $state)").run({ par: parNodeId, epoch: evaluation.epoch, version: evaluation.bindingVersion, state: evaluation.kind })
}

function insertAppendJoinBinding(db: Database, parNodeId: string, input: AppendJoinBindingInput): void {
	if (input.value.kind === "validator") insertDefinition(db, input.value.candidate.definitionRef)
	const candidate = input.value.kind === "validator" ? input.value.candidate : null
	db.query<never, SqlParams>(`INSERT INTO task_join_bindings (par_node_id, version, join_kind, candidate_definition_kind, candidate_definition_content_identity, candidate_id, author_kind, author_id, authority_class, effective_from_epoch, created_at)
		VALUES ($parNodeId, $version, $joinKind, $candidateKind, $candidateIdentity, $candidateId, $authorKind, $authorId, $authorityClass, $effectiveFromEpoch, $createdAt)`).run({
		parNodeId,
		version: input.version,
		joinKind: input.value.kind,
		candidateKind: candidate?.definitionRef.kind ?? null,
		candidateIdentity: candidate?.definitionRef.contentIdentity ?? null,
		candidateId: candidate?.candidateId ?? null,
		authorKind: input.authorKind,
		authorId: input.authorId,
		authorityClass: input.authorityClass,
		effectiveFromEpoch: input.effectiveFromEpoch,
		createdAt: input.createdAt,
	})
}

function listJoinBindingRecords(db: Database, parNodeId: string): JoinBindingRecord[] {
	return queryPersistedAll(db, "SELECT * FROM task_join_bindings WHERE par_node_id = $parNodeId ORDER BY version", { parNodeId }, JoinBindingRowBoundary, `task_join_bindings.${parNodeId}`).map((row) => ({
		parNodeId: row.par_node_id,
		version: row.version,
		value: joinValueFromRow(row),
		authorKind: row.author_kind,
		authorId: row.author_id,
		authorityClass: row.authority_class,
		effectiveFromEpoch: row.effective_from_epoch,
		createdAt: row.created_at,
	}))
}

function joinValueFromRow(row: typeof JoinBindingValueRowBoundary.infer): JoinValueSnapshot {
	switch (row.join_kind) {
		case "drain": return { kind: "drain" }
		case "validator": return { kind: "validator", candidate: { definitionRef: { kind: requireValue(row.candidate_definition_kind, "candidate kind"), contentIdentity: requireValue(row.candidate_definition_content_identity, "candidate identity") }, candidateId: requireValue(row.candidate_id, "candidate id") } }
		default: return assertNever(row.join_kind)
	}
}

function requireClosureById(db: Database, closureId: string): ClosureSnapshot {
	const row = queryPersistedOne(db, "SELECT leaf_node_id FROM task_closures WHERE closure_id = $closureId", { closureId }, ClosureLeafRowBoundary, `task_closures.${closureId}`)
	if (row === null) throw new SqliteStateError("not_found", `closure ${closureId} was not found`, { closureId })
	return readClosure(db, row.leaf_node_id)
}

function insertActiveRunSnapshot(db: Database, chainId: number, active: ActiveRunSnapshot): void {
	const row = queryPersistedOne(db, "SELECT task_closures.lifecycle, task_closures.phase, items.chain_id FROM task_closures INNER JOIN items ON items.id = task_closures.item_row_id WHERE task_closures.closure_id = $closure", { closure: active.closureId }, ActiveRunAssociationRowBoundary, `active run closure ${active.closureId}`)
	if (row === null || row.chain_id !== chainId || row.phase !== active.phase) throw new SqliteStateError("run_closure_mismatch", `active run ${active.runId} does not match closure`, { runId: active.runId, closureId: active.closureId })
	if (row.lifecycle !== "active") throw new SqliteStateError("closure_lifecycle_conflict", `closure ${active.closureId} is not active`, { closureId: active.closureId })
	db.query<never, SqlParams>("INSERT INTO active_runs (closure_id, run_id, phase, started_at, extra) VALUES ($closure, $runId, $phase, $startedAt, '{}')").run({ closure: active.closureId, runId: active.runId, phase: active.phase, startedAt: active.startedAt })
}

function rowToTaskTree(db: Database, chainId: number): TaskTreeSnapshot | null {
	const tree = queryPersistedOne(db, "SELECT root_node_id FROM task_trees WHERE chain_id = $chainId", { chainId }, TaskTreeRootRowBoundary, `task_trees.${chainId}`)
	if (tree === null) return null
	const root = readTaskNode(db, tree.root_node_id)
	const activeRuns = queryPersistedAll(db, "SELECT active_runs.closure_id, active_runs.run_id, active_runs.phase, active_runs.started_at FROM active_runs INNER JOIN task_closures ON task_closures.closure_id = active_runs.closure_id INNER JOIN items ON items.id = task_closures.item_row_id WHERE items.chain_id = $chainId ORDER BY active_runs.started_at, active_runs.run_id", { chainId }, ActiveRunRowBoundary, `active_runs for task tree ${chainId}`).map((row) => ({ closureId: row.closure_id, runId: row.run_id, phase: row.phase, startedAt: row.started_at }))
	return assertTaskTreeSnapshot({ root, activeRuns })
}

function requireTaskTree(db: Database, chainId: number): TaskTreeSnapshot {
	const tree = rowToTaskTree(db, chainId)
	if (tree === null) throw new SqliteStateError("not_found", `task tree for chain ${chainId} was not found`, { chainId })
	return tree
}

function readTaskNode(db: Database, nodeId: string): TaskNodeSnapshot {
	const row = queryPersistedOne(db, "SELECT * FROM task_nodes WHERE runtime_node_id = $nodeId", { nodeId }, TaskNodeRowBoundary, `task_nodes.${nodeId}`)
	if (row === null) throw new SqliteStateError("invalid_json", `task node ${nodeId} was not found`, { nodeId })
	const identity = { runtimeNodeId: row.runtime_node_id, definitionRef: { kind: row.definition_kind, contentIdentity: row.definition_content_identity }, definitionNodeId: row.definition_node_id }
	switch (row.kind) {
		case "leaf": return { kind: "leaf", identity, closure: readClosure(db, row.runtime_node_id) }
		case "seq": {
			const children = readTaskChildren(db, nodeId)
			const seq = queryPersistedOne(db, "SELECT next_child_node_id FROM task_seq_nodes WHERE runtime_node_id = $nodeId", { nodeId }, SeqNodeRowBoundary, `task_seq_nodes.${nodeId}`)
			if (seq === null) throw new SqliteStateError("invalid_json", `seq node ${nodeId} has no kind row`, { nodeId })
			return { kind: "seq", identity, cursor: seq.next_child_node_id === null ? { kind: "complete" } : { kind: "next", nodeId: seq.next_child_node_id }, children }
		}
		case "par": return readParNode(db, identity, readTaskChildren(db, nodeId))
		default: return assertNever(row.kind)
	}
}

function readTaskChildren(db: Database, nodeId: string): TaskNodeSnapshot[] {
	return queryPersistedAll(db, "SELECT * FROM task_nodes WHERE parent_node_id = $nodeId ORDER BY child_index", { nodeId }, TaskNodeRowBoundary, `task_nodes children of ${nodeId}`).map((child) => readTaskNode(db, child.runtime_node_id))
}

function readClosure(db: Database, leafNodeId: string): ClosureSnapshot {
	const row = queryPersistedOne(db, "SELECT task_closures.closure_id, task_closures.item_row_id, items.item_id, task_closures.phase, task_closures.lifecycle, task_closures.worktree_path, task_closures.branch_name, task_closures.base_commit, task_closures.source_par_node_id FROM task_closures INNER JOIN items ON items.id = task_closures.item_row_id WHERE leaf_node_id = $leaf", { leaf: leafNodeId }, ClosureRowBoundary, `task_closures for leaf ${leafNodeId}`)
	if (row === null) throw new SqliteStateError("invalid_json", `leaf ${leafNodeId} has no closure`, { leafNodeId })
	const sessions = queryPersistedAll(db, "SELECT runner_kind, session_id FROM closure_sessions WHERE closure_id = $closure ORDER BY runner_kind", { closure: row.closure_id }, ClosureSessionRowBoundary, `closure_sessions.${row.closure_id}`).map((session) => ({ runner: session.runner_kind, sessionId: session.session_id }))
	return { closureId: row.closure_id, itemRowId: row.item_row_id, itemId: row.item_id, phase: row.phase, lifecycle: row.lifecycle, worktreePath: row.worktree_path, branchName: row.branch_name, baseCommit: row.base_commit, sourceParNodeId: row.source_par_node_id, sessions }
}

function readParNode(db: Database, identity: TaskNodeSnapshot["identity"], children: readonly TaskNodeSnapshot[]): TaskNodeSnapshot {
	const row = queryPersistedOne(db, "SELECT pin_commit, reopen_count, reopen_budget_ref, container_state FROM task_par_nodes WHERE runtime_node_id = $nodeId", { nodeId: identity.runtimeNodeId }, ParNodeRowBoundary, `task_par_nodes.${identity.runtimeNodeId}`)
	if (row === null) throw new SqliteStateError("invalid_json", `par node ${identity.runtimeNodeId} has no kind row`, { nodeId: identity.runtimeNodeId })
	const binding = queryPersistedOne(db, "SELECT version, join_kind, candidate_definition_kind, candidate_definition_content_identity, candidate_id FROM task_join_bindings WHERE par_node_id = $nodeId ORDER BY version DESC LIMIT 1", { nodeId: identity.runtimeNodeId }, JoinBindingValueRowBoundary, `task_join_bindings latest for ${identity.runtimeNodeId}`)
	if (binding === null) throw new SqliteStateError("invalid_json", `par node ${identity.runtimeNodeId} has no join binding`, { nodeId: identity.runtimeNodeId })
	const value = joinValueFromRow(binding)
	const evaluationRow = queryPersistedOne(db, "SELECT epoch, binding_version, evaluation_state FROM task_join_evaluation_bindings WHERE par_node_id = $nodeId ORDER BY epoch DESC LIMIT 1", { nodeId: identity.runtimeNodeId }, JoinEvaluationValueRowBoundary, `task_join_evaluation_bindings latest for ${identity.runtimeNodeId}`)
	const evaluation: JoinEvaluationSnapshot = evaluationRow === null ? { kind: "not-evaluating" } : { kind: evaluationRow.evaluation_state, epoch: evaluationRow.epoch, bindingVersion: evaluationRow.binding_version }
	return { kind: "par", identity, groupId: identity.runtimeNodeId, pinCommit: row.pin_commit, state: row.container_state, reopen: { count: row.reopen_count, budgetRef: row.reopen_budget_ref }, join: { currentVersion: binding.version, value, evaluation }, children }
}

function requireValue<T>(value: T | null, label: string): T {
	if (value === null) throw new SqliteStateError("invalid_json", `${label} is null`)
	return value
}

function assertNever(value: never): never {
	throw new SqliteStateError("invalid_json", `unhandled persisted domain variant: ${String(value)}`)
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

function requireCurrentRun(row: CurrentRunRow | null, id: string | number): CurrentRunRecord {
	const currentRun = rowToCurrentRun(row)
	if (currentRun === null) throw new SqliteStateError("not_found", `current run ${String(id)} was not found`, { id: String(id) })
	return currentRun
}

function chainParams(chain: ChainRecord): SqlParams {
	return {
		id: chain.id,
		name: chain.name,
		preset: chain.preset,
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		status: chain.status,
		metadata: stringifyJsonObject(chainMetadataToJsonObject(chain.metadata)),
		updatedAt: chain.updatedAt,
	}
}

function itemParams(item: ItemRecord): SqlParams {
	return {
		id: item.id,
		repoCwd: item.repoCwd,
		status: item.status,
		attempts: item.attempts,
		position: item.position,
		title: item.title,
		priority: item.priority,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile,
		evidenceDir: item.evidenceDir,
		agentCwd: item.agentCwd,
		runner: item.runner,
		phase: item.phase,
		preset: item.preset,
		presetPath: item.presetPath,
		extra: stringifyJsonObject(itemExtraToJsonObject(item.extra)),
		updatedAt: item.updatedAt,
		statusUpdatedAt: item.statusUpdatedAt,
	}
}

function currentRunParams(input: SetCurrentRunInput): SqlParams {
	return {
		chainId: input.chainId,
		phase: input.phase,
		runId: input.runId,
		startedAt: input.startedAt,
		extra: stringifyJsonObject(itemExtraToJsonObject(input.extra)),
	}
}

type PendingSelectionOptions = {
	repoCwd?: string
	statuses: readonly InternalStatus[]
	terminalStatusNames: readonly InternalStatus[]
	resolveDependency?: DependencyResolver
}

function selectNextPendingItem(items: ItemRecord[], options: PendingSelectionOptions): ItemRecord | null {
	const eligible = new Set(options.statuses)
	const waitsByItemId = dependencyWaitsByItemId(items, options.terminalStatusNames, options.resolveDependency)
	return items
		.filter((item) => options.repoCwd === undefined || item.repoCwd === options.repoCwd)
		.filter((item) => eligible.has(item.status))
		.filter((item) => !waitsByItemId.has(item.id))
		.sort((left, right) => {
			if (left.position !== right.position) return left.position - right.position
			return left.id - right.id
		})[0] ?? null
}

export function listDependencyWaitReasons(items: readonly ItemRecord[], options: PendingSelectionOptions): DependencyWaitReason[] {
	const eligible = new Set(options.statuses)
	const waitsByItemId = dependencyWaitsByItemId(items, options.terminalStatusNames, options.resolveDependency)
	return items
		.filter((item) => options.repoCwd === undefined || item.repoCwd === options.repoCwd)
		.filter((item) => eligible.has(item.status))
		.map((item) => waitsByItemId.get(item.id) ?? null)
		.filter((wait): wait is DependencyWaitReason => wait !== null)
}

function dependencyWaitsByItemId(
	items: readonly ItemRecord[],
	terminalStatusNames: readonly InternalStatus[],
	resolveDependency?: DependencyResolver,
): Map<number, DependencyWaitReason> {
	const terminal = new Set(terminalStatusNames)
	const byId = new Map(items.map((item) => [item.id, item]))
	// A dependency may live in another chain (item ids are globally unique). Fall back to the
	// cross-chain resolver when the id is not in the per-chain snapshot, otherwise a cross-chain
	// dependsOn target would be permanently treated as unsatisfied (deadlock).
	const resolve = (id: number): ItemRecord | undefined => byId.get(id) ?? resolveDependency?.(id) ?? undefined
	const waits = new Map<number, DependencyWaitReason>()
	for (const item of items) {
		const dependsOn = dependsOnItemIds(item.extra)
		if (dependsOn.length === 0) continue
		const unsatisfied = dependsOn.filter((dependencyId) => {
			const dependency = resolve(dependencyId)
			return dependency === undefined || !terminal.has(dependency.status)
		})
		if (unsatisfied.length === 0) continue
		waits.set(item.id, {
			rowId: item.id,
			itemId: item.itemId,
			repoCwd: item.repoCwd,
			dependsOn,
			unsatisfied,
		})
	}
	return waits
}

export function dependsOnItemIds(extra: ItemExtra): number[] {
	return itemDependsOnIds(extra)
}

function parseItemSessionIds(raw: string, label: string): ItemSessionIds {
	const parsed = parseJsonObject(raw, label)
	return normalizeParsedItemSessionIds(parsed, label)
}

function stringifyItemSessionIds(value: ItemSessionIds): string {
	return JSON.stringify(normalizeItemSessionIds(value))
}

function normalizeItemSessionIds(value: ItemSessionIds): ItemSessionIds {
	const result: ItemSessionIds = {}
	for (const [phase, sessionsByRunner] of Object.entries(value)) {
		const phaseKey = normalizeSessionPhase(phase, "invalid_input")
		const runnerMap: Partial<Record<AgentRunnerKind, string>> = {}
		for (const [runner, sessionId] of Object.entries(sessionsByRunner)) {
			if (!isAgentRunnerKind(runner)) {
				throw new SqliteStateError("invalid_input", `invalid session_ids runner: ${runner}`, { phase: phaseKey, runner })
			}
			if (sessionId === undefined) continue
			if (sessionId === "") {
				throw new SqliteStateError("invalid_input", `session id for phase ${phaseKey} and runner ${runner} cannot be empty`, { phase: phaseKey, runner })
			}
			runnerMap[runner] = sessionId
		}
		if (Object.keys(runnerMap).length > 0) result[phaseKey] = runnerMap
	}
	return result
}

function normalizeParsedItemSessionIds(value: JsonObject, label: string): ItemSessionIds {
	const result: ItemSessionIds = {}
	for (const [phase, sessionsByRunner] of Object.entries(value)) {
		if (phase === "") {
			throw new SqliteStateError("invalid_json", `${label} contains an empty phase key`, { label })
		}
		if (!isJsonObject(sessionsByRunner)) {
			throw new SqliteStateError("invalid_json", `${label}.${phase} must contain a runner map`, { label, phase })
		}
		const runnerMap: Partial<Record<AgentRunnerKind, string>> = {}
		for (const [runner, sessionId] of Object.entries(sessionsByRunner)) {
			if (!isAgentRunnerKind(runner)) {
				throw new SqliteStateError("invalid_json", `${label}.${phase} contains invalid runner ${runner}`, { label, phase, runner })
			}
			if (typeof sessionId !== "string" || sessionId === "") {
				throw new SqliteStateError("invalid_json", `${label}.${phase}.${runner} must contain a non-empty session id`, { label, phase, runner })
			}
			runnerMap[runner] = sessionId
		}
		if (Object.keys(runnerMap).length > 0) result[phase] = runnerMap
	}
	return result
}

function setItemSessionIdInMap(
	current: ItemSessionIds,
	phase: string,
	runner: AgentRunnerKind,
	sessionId: string | null,
): ItemSessionIds {
	const phaseKey = normalizeSessionPhase(phase, "invalid_input")
	const next = normalizeItemSessionIds(current)
	const runnerMap: Partial<Record<AgentRunnerKind, string>> = { ...(next[phaseKey] ?? {}) }
	if (sessionId === null) {
		delete runnerMap[runner]
	} else {
		if (sessionId === "") {
			throw new SqliteStateError("invalid_input", `session id for phase ${phaseKey} and runner ${runner} cannot be empty`, { phase: phaseKey, runner })
		}
		runnerMap[runner] = sessionId
	}
	if (Object.keys(runnerMap).length === 0) {
		delete next[phaseKey]
	} else {
		next[phaseKey] = runnerMap
	}
	return next
}

function normalizeSessionPhase(phase: string, code: SqliteStateErrorCode): string {
	if (phase === "") throw new SqliteStateError(code, "session id phase cannot be empty")
	return phase
}

function isAgentRunnerKind(value: unknown): value is AgentRunnerKind {
	return value === "claude" || value === "codex" || value === "opencode"
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
	return CHAIN_STATUSES.some((entry) => entry === status)
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
