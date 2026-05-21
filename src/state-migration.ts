import { type Database } from "bun:sqlite"
import { cp, copyFile, mkdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import type { AgentRunnerKind, JsonObject, JsonValue } from "./loop"
import {
	addItem,
	getChain,
	listItems,
	recordRun,
	updateItem,
	upsertChain,
	type Chain,
	type Item,
	type RunRecord,
} from "./state-db"
import { chainRuntimePaths, defaultChainNameForTarget, ensureChainRuntimeSkeleton, type ChainRuntimePaths } from "./runtime-paths"

const LEGACY_RUNTIME_DIR = ".coder-loop/runtime"
const LEGACY_STATE_REL = `${LEGACY_RUNTIME_DIR}/state.json`
const LEGACY_CONFIG_JSON_REL = `${LEGACY_RUNTIME_DIR}/config.json`
const LEGACY_CONFIG_TOML_REL = `${LEGACY_RUNTIME_DIR}/config.toml`
const LEGACY_SHARED_REL = `${LEGACY_RUNTIME_DIR}/shared.md`
const LEGACY_ISSUES_REL = `${LEGACY_RUNTIME_DIR}/issues`
const LEGACY_EVIDENCE_REL = `${LEGACY_RUNTIME_DIR}/evidence`
const STATE_BACKUP_SUFFIX = ".pre-sqlite-migration"
const DEFAULT_PRESET = "gh-issue-pr-iteration"

const LEGACY_QUEUE_BASE_KEYS = new Set([
	"issue",
	"status",
	"attempts",
	"title",
	"priority",
	"branch",
	"pr",
	"lastRunId",
	"issueFile",
	"evidenceDir",
	"agentCwd",
	"runner",
	"extra",
])

export type StateJsonMigrationSkipped = {
	issue: number | null
	reason: string
}

export type StateJsonMigrationOptions = {
	rootDir?: string | null
	statePath?: string | null
	configPath?: string | null
	chainName?: string | null
	preset?: string | null
	repository?: string | null
	baseBranch?: string | null
	allowMissingState?: boolean
	onDuplicate?: "skip" | "update"
	backupState?: boolean
}

export type StateJsonMigrationResult = {
	chain: Chain
	items: Item[]
	runs: RunRecord[]
	skipped: StateJsonMigrationSkipped[]
	legacyStatePath: string
	legacyStateFound: boolean
	legacyConfigPath: string | null
	legacySharedPath: string
	backupPath: string | null
	chainDir: string
	chainPaths: ChainRuntimePaths
	itemsSeen: number
	itemsInserted: number
	itemsUpdated: number
	runsSeen: number
	runsInserted: number
	copied: {
		shared: boolean
		issues: boolean
		evidence: boolean
	}
}

type LegacyState = {
	repository: string | null
	baseBranch: string | null
	queue: unknown[]
	recentRuns: unknown[]
}

type LegacyConfig = {
	preset: string | null
	repository: string | null
	baseBranch: string | null
}

type MigratedItemInput = {
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
}

type LegacyRunInput = {
	id: string
	issue: number
	phase: string
	runner: string
	startedAt: string | null
	finishedAt: string | null
	exitCode: number | null
	terminated: JsonObject | null
	logPath: string | null
	statusPath: string | null
}

export async function migrateStateJson(
	targetCwd: string,
	db: Database,
	options: StateJsonMigrationOptions = {},
): Promise<StateJsonMigrationResult> {
	const target = resolve(targetCwd)
	const statePath = resolve(target, options.statePath ?? LEGACY_STATE_REL)
	const configPath = await resolveLegacyConfigPath(target, options.configPath ?? null)
	const legacyState = await readLegacyState(statePath, options.allowMissingState === true)
	const legacyConfig = configPath === null ? emptyLegacyConfig() : await readLegacyConfig(configPath)
	const preset = options.preset ?? legacyConfig.preset ?? DEFAULT_PRESET
	const requestedRepository = options.repository ?? legacyConfig.repository ?? legacyState?.repository ?? null
	const chainName = options.chainName ?? defaultMigratedChainName(target, requestedRepository)
	const existingChain = getChain(db, chainName)
	const repository = requestedRepository ?? existingChain?.repository ?? null
	const baseBranch = options.baseBranch ?? legacyConfig.baseBranch ?? legacyState?.baseBranch ?? existingChain?.baseBranch ?? "main"
	const chainPaths = chainRuntimePaths(options.rootDir ?? null, chainName)
	const onDuplicate = options.onDuplicate ?? "skip"
	const backupState = options.backupState ?? true

	await ensureChainRuntimeSkeleton(chainPaths)
	const chain = upsertChain(db, chainName, preset, repository, baseBranch, null, null, { targetCwd: target })
	const copied = await copyLegacyArtifacts(target, chainPaths)
	const backupPath = legacyState === null || !backupState ? null : await backupLegacyStateFile(statePath)

	const skipped: StateJsonMigrationSkipped[] = []
	const items: Item[] = []
	let itemsSeen = 0
	let itemsInserted = 0
	let itemsUpdated = 0
	const itemIdByIssue = new Map<number, number>()

	for (const entry of legacyState?.queue ?? []) {
		itemsSeen++
		const item = legacyQueueEntryToItem(entry, target)
		if (item === null) {
			skipped.push({ issue: issueFromUnknownEntry(entry), reason: "invalid legacy queue item" })
			continue
		}
		const migrated = await migrateLegacyItemArtifacts(item, target, chainPaths)
		const existing = findExistingItem(db, chain.id, migrated.issue, migrated.repoCwd)
		if (existing !== null) {
			if (onDuplicate === "update") {
				const updated = updateItem(db, existing.id, migrated)
				itemIdByIssue.set(updated.issue, updated.id)
				items.push(updated)
				itemsUpdated++
			} else {
				itemIdByIssue.set(existing.issue, existing.id)
				skipped.push({ issue: migrated.issue, reason: "item already exists in migrated chain" })
			}
			continue
		}
		const inserted = addItem(db, chain.id, migrated)
		itemIdByIssue.set(inserted.issue, inserted.id)
		items.push(inserted)
		itemsInserted++
	}

	for (const existing of listItems(db, chain.id)) {
		if (!itemIdByIssue.has(existing.issue)) itemIdByIssue.set(existing.issue, existing.id)
	}

	const runs: RunRecord[] = []
	let runsSeen = 0
	let runsInserted = 0
	for (const entry of legacyState?.recentRuns ?? []) {
		runsSeen++
		const run = legacyRunEntryToRun(entry)
		if (run === null) {
			skipped.push({ issue: issueFromUnknownEntry(entry), reason: "invalid legacy run entry" })
			continue
		}
		const itemId = itemIdByIssue.get(run.issue)
		if (itemId === undefined) {
			skipped.push({ issue: run.issue, reason: "legacy run references an item that was not migrated" })
			continue
		}
		try {
			const runRecord = {
				id: run.id,
				chainId: chain.id,
				itemId,
				phase: run.phase,
				runner: run.runner,
				finishedAt: run.finishedAt,
				exitCode: run.exitCode,
				terminated: run.terminated,
				logPath: run.logPath,
				statusPath: run.statusPath,
			}
			if (run.startedAt !== null) {
				Object.assign(runRecord, { startedAt: run.startedAt })
			}
			const inserted = recordRun(db, runRecord)
			runs.push(inserted)
			runsInserted++
		} catch (error) {
			if (!errorMessage(error).includes("UNIQUE constraint failed")) throw error
			skipped.push({ issue: run.issue, reason: `run already exists: ${run.id}` })
		}
	}

	return {
		chain,
		items,
		runs,
		skipped,
		legacyStatePath: statePath,
		legacyStateFound: legacyState !== null,
		legacyConfigPath: configPath,
		legacySharedPath: resolve(target, LEGACY_SHARED_REL),
		backupPath,
		chainDir: chainPaths.chainDir,
		chainPaths,
		itemsSeen,
		itemsInserted,
		itemsUpdated,
		runsSeen,
		runsInserted,
		copied,
	}
}

export function defaultMigratedChainName(targetCwd: string, repository: string | null): string {
	const repoName = repository?.split("/").filter(Boolean).at(-1)
	return repoName === undefined ? defaultChainNameForTarget(targetCwd) : defaultChainNameForTarget(repoName)
}

async function resolveLegacyConfigPath(target: string, explicit: string | null): Promise<string | null> {
	if (explicit !== null) return resolve(target, explicit)
	const jsonPath = resolve(target, LEGACY_CONFIG_JSON_REL)
	if (await exists(jsonPath)) return jsonPath
	const tomlPath = resolve(target, LEGACY_CONFIG_TOML_REL)
	if (await exists(tomlPath)) return tomlPath
	return null
}

async function readLegacyState(path: string, allowMissing: boolean): Promise<LegacyState | null> {
	const raw = await readIfExists(path)
	if (raw === null) {
		if (allowMissing) return null
		throw new Error(`${path}: legacy state.json not found`)
	}
	const parsed = parseJsonObject(raw, path)
	return {
		repository: typeof parsed.repository === "string" ? parsed.repository : null,
		baseBranch: typeof parsed.baseBranch === "string" ? parsed.baseBranch : null,
		queue: Array.isArray(parsed.queue) ? parsed.queue : [],
		recentRuns: Array.isArray(parsed.recentRuns) ? parsed.recentRuns : [],
	}
}

async function readLegacyConfig(path: string): Promise<LegacyConfig> {
	const raw = await readFile(path, "utf-8")
	const parsed = path.endsWith(".toml") ? Bun.TOML.parse(raw) : JSON.parse(raw)
	if (!isObjectRecord(parsed)) throw new Error(`${path}: legacy config must be an object`)
	return {
		preset: presetNameFromConfig(parsed.preset),
		repository: typeof parsed.repository === "string" ? parsed.repository : null,
		baseBranch: typeof parsed.baseBranch === "string" ? parsed.baseBranch : null,
	}
}

function emptyLegacyConfig(): LegacyConfig {
	return { preset: null, repository: null, baseBranch: null }
}

async function copyLegacyArtifacts(target: string, chainPaths: ChainRuntimePaths): Promise<StateJsonMigrationResult["copied"]> {
	const legacyShared = resolve(target, LEGACY_SHARED_REL)
	const legacyIssues = resolve(target, LEGACY_ISSUES_REL)
	const legacyEvidence = resolve(target, LEGACY_EVIDENCE_REL)
	let shared = false
	let issues = false
	let evidence = false
	if (await exists(legacyShared)) {
		await mkdir(dirname(chainPaths.sharedPath), { recursive: true })
		await copyFile(legacyShared, chainPaths.sharedPath)
		shared = true
	}
	if (await isDirectory(legacyIssues)) {
		await cp(legacyIssues, chainPaths.issuesDir, { recursive: true, force: true })
		issues = true
	}
	if (await isDirectory(legacyEvidence)) {
		await cp(legacyEvidence, chainPaths.evidenceDir, { recursive: true, force: true })
		evidence = true
	}
	return { shared, issues, evidence }
}

async function backupLegacyStateFile(statePath: string): Promise<string> {
	const backupPath = `${statePath}${STATE_BACKUP_SUFFIX}`
	if (!(await exists(backupPath))) {
		await copyFile(statePath, backupPath)
	}
	return backupPath
}

async function migrateLegacyItemArtifacts(
	item: MigratedItemInput,
	target: string,
	chainPaths: ChainRuntimePaths,
): Promise<MigratedItemInput> {
	const migrated = { ...item }
	if (migrated.issueFile !== null) {
		const source = resolve(target, migrated.issueFile)
		const destName = basename(migrated.issueFile) || `${migrated.issue}.md`
		const dest = resolve(chainPaths.issuesDir, destName)
		if (await exists(source)) {
			await mkdir(dirname(dest), { recursive: true })
			await copyFile(source, dest)
		}
		migrated.issueFile = `issues/${destName}`
	}
	if (migrated.evidenceDir !== null) {
		const source = resolve(target, migrated.evidenceDir)
		const destName = basename(migrated.evidenceDir) || `issue-${migrated.issue}`
		const dest = resolve(chainPaths.evidenceDir, destName)
		if (await isDirectory(source)) await cp(source, dest, { recursive: true, force: true })
		else await mkdir(dest, { recursive: true })
		migrated.evidenceDir = `evidence/${destName}`
	}
	return migrated
}

function legacyQueueEntryToItem(entry: unknown, target: string): MigratedItemInput | null {
	if (!isObjectRecord(entry)) return null
	if (typeof entry.issue !== "number" || !Number.isInteger(entry.issue)) return null
	const agentCwd = nullableString(entry.agentCwd) ?? null
	return {
		issue: entry.issue,
		repoCwd: agentCwd ?? target,
		status: typeof entry.status === "string" ? entry.status : "queued",
		priority: typeof entry.priority === "string" ? entry.priority : "medium",
		attempts: typeof entry.attempts === "number" && Number.isInteger(entry.attempts) ? entry.attempts : 0,
		title: nullableString(entry.title) ?? null,
		branch: nullableString(entry.branch) ?? null,
		pr: nullableInteger(entry.pr) ?? null,
		lastRunId: nullableString(entry.lastRunId) ?? null,
		issueFile: nullableString(entry.issueFile) ?? null,
		evidenceDir: nullableString(entry.evidenceDir) ?? null,
		agentCwd,
		runner: entry.runner === "claude" || entry.runner === "codex" ? entry.runner : null,
		extra: legacyExtraFromQueueEntry(entry),
	}
}

function legacyExtraFromQueueEntry(entry: Record<string, unknown>): JsonObject {
	const extra: JsonObject = isJsonObject(entry.extra) ? { ...entry.extra } : {}
	for (const [key, value] of Object.entries(entry)) {
		if (LEGACY_QUEUE_BASE_KEYS.has(key)) continue
		if (isJsonValue(value)) extra[key] = value
	}
	return extra
}

function legacyRunEntryToRun(entry: unknown): LegacyRunInput | null {
	if (!isObjectRecord(entry)) return null
	const id = firstString(entry, ["id", "runId"])
	const issue = firstInteger(entry, ["issue", "issueId"])
	const phase = firstString(entry, ["phase"])
	const runner = firstString(entry, ["runner"])
	if (id === null || issue === null || phase === null || runner === null) return null
	return {
		id,
		issue,
		phase,
		runner,
		startedAt: firstString(entry, ["startedAt", "started_at"]),
		finishedAt: firstString(entry, ["finishedAt", "finished_at"]),
		exitCode: firstNullableInteger(entry, ["exitCode", "exit_code"]),
		terminated: jsonObjectOrNull(entry.terminated),
		logPath: firstString(entry, ["logPath", "log_path"]),
		statusPath: firstString(entry, ["statusPath", "status_path"]),
	}
}

function findExistingItem(db: Database, chainId: number, issue: number, repoCwd: string): Item | null {
	return listItems(db, chainId).find((item) => item.issue === issue && item.repoCwd === repoCwd) ?? null
}

function issueFromUnknownEntry(entry: unknown): number | null {
	if (!isObjectRecord(entry)) return null
	return typeof entry.issue === "number" && Number.isInteger(entry.issue) ? entry.issue : null
}

function presetNameFromConfig(value: unknown): string | null {
	if (typeof value === "string") return value
	if (isObjectRecord(value) && typeof value.name === "string") return value.name
	return null
}

function firstString(entry: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = entry[key]
		if (typeof value === "string" && value.trim() !== "") return value
	}
	return null
}

function firstInteger(entry: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = entry[key]
		if (typeof value === "number" && Number.isInteger(value)) return value
	}
	return null
}

function firstNullableInteger(entry: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = entry[key]
		if (value === null) return null
		if (typeof value === "number" && Number.isInteger(value)) return value
	}
	return null
}

function nullableString(value: unknown): string | null | undefined {
	if (typeof value === "string") return value
	if (value === null) return null
	return undefined
}

function nullableInteger(value: unknown): number | null | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value
	if (value === null) return null
	return undefined
}

function jsonObjectOrNull(value: unknown): JsonObject | null {
	if (value === null || value === undefined) return null
	return isJsonObject(value) ? value : null
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false
		throw error
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false
		throw error
	}
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(raw)
	if (!isObjectRecord(parsed)) throw new Error(`${path}: expected JSON object`)
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
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
