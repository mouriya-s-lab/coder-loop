/**
 * Status snapshot building for coder-loop.
 *
 * Constructs a read-only runtime snapshot (CoderLoopStatusSnapshot) from
 * target config, preset, state (DB or legacy file), events, and process info.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import {
	AgentRunnerKindBoundary,
	AgentRunStatusBoundary,
	type AgentRunStatus,
	type AgentRunStatusInput,
} from "./agent"

import {
	chainRuntimePaths,
	defaultChainNameForTarget,
	loopDataRootPaths,
	type ChainRuntimePaths,
} from "./runtime-paths"

import {
	openStateStore,
	type Chain,
	type Item,
	type StateStore,
} from "./state-db"

import {
	assertArk,
	errorMessage,
	isJsonObject,
	isJsonValue,
	isNodeError,
	isObjectRecord,
	resolveFrom,
	type JsonObject,
	type JsonValue,
} from "./util"

import {
	buildOptions,
	checkRuntime,
	configFormatForPath,
	defaultLoopConfig,
	detectHostRunner,
	getItemId,
	getCurrentId,
	loadPreset,
	loopEventsPath,
	parseConfigText,
	parseStateText,
	resolveConfigPath,
	resolvePresetDir,
	selectIssue,
	selectRunnerForPhase,
	buildAgentRunnerCommands,
	selectDefaultRunner,
	selectReviewRunner,
	agentOutputPath,
	agentStatusPath,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type AgentRunnerSource,
	type ConfigFormat,
	type CurrentRun,
	type LoopConfig,
	type LoopOptions,
	type LoopState,
	type Preset,
	type QueueItem,
	type RawArgs,
	type RuntimeCheckError,
	type RuntimeStateReadResult,
	type SelectedIssue,
	type StatusCommandArgs,
} from "./loop"

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export type CoderLoopStatusSnapshot = {
	target: StatusTargetSnapshot
	state: StatusStateSnapshot
	queue: StatusQueueSnapshot
	current: StatusCurrentSnapshot
	events: StatusEventsSnapshot
	processes: StatusProcessSnapshot
}

export type StatusTargetSnapshot = {
	cwd: string
	configPath: string
	configFormat: ConfigFormat
	config: StatusResourceSnapshot
	workflowPath: string
	sharedContextPath: string
	statePath: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	traceFile: string
	loopFile: string
	repository: string | null
	baseBranch: string | null
	worktree: boolean
	runner: StatusRunnerDefaultsSnapshot
	preset: {
		name: string
		version: number
		description: string
		presetDir: string
	} | null
}

export type StatusResourceSnapshot =
	| { kind: "loaded"; error: null }
	| { kind: "missing"; error: string }
	| { kind: "invalid"; error: string }

export type StatusRunnerSelectionSnapshot = {
	kind: AgentRunnerKind
	source: AgentRunnerSource
	binary: string
	extraArgs: string[]
	model: string | null
}

export type StatusRunnerDefaultsSnapshot = {
	hostDefault: AgentRunnerKind
	default: StatusRunnerSelectionSnapshot
	reviewDefault: StatusRunnerSelectionSnapshot
}

export type StatusStateKind =
	| "ok"
	| "missing-config"
	| "invalid-config"
	| "missing-preset"
	| "invalid-preset"
	| "missing-state"
	| "invalid-state"
	| "invalid-runtime"

export type StatusStateSnapshot = {
	kind: StatusStateKind
	ok: boolean
	loaded: boolean
	path: string
	version: number | null
	repository: string | null
	baseBranch: string | null
	errors: RuntimeCheckError[]
	error: string | null
}

export type StatusSelectedIssue = {
	id: string
	item: QueueItem
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	runner: StatusRunnerSelectionSnapshot
	reviewRunner: StatusRunnerSelectionSnapshot
}

export type StatusQueueSnapshot = {
	total: number
	byStatus: Record<string, number>
	continuable: number
	terminal: number
	selected: StatusSelectedIssue | null
}

export type StatusPhaseStatusSnapshot = {
	path: string
	exists: boolean
	value: AgentRunStatus | null
	error: string | null
}

export type StatusCurrentSnapshot = {
	run: CurrentRun | null
	id: string | null
	item: QueueItem | null
	runner: StatusRunnerSelectionSnapshot | null
	phaseStatus: StatusPhaseStatusSnapshot | null
}

export type StatusEventsSnapshot = {
	runId: string | null
	path: string | null
	exists: boolean
	recent: JsonValue[]
	latest: JsonValue | null
	error: string | null
}

export type StatusLoopFileSnapshot = {
	path: string
	exists: boolean
	startedAt: string | null
	pid: number | null
	pidAlive: boolean | null
	log: string | null
	cwd: string | null
	statePath: string | null
	command: string | null
	requireBrowserEvidence: boolean | null
	raw: string | null
}

export type StatusProcessInfo = {
	pid: number
	ppid: number | null
	command: string | null
	cwd: string | null
	matchesTarget: boolean
	alive: boolean
	source: "loopFile" | "ps"
}

export type StatusProcessSnapshot = {
	loopFile: StatusLoopFileSnapshot
	live: StatusProcessInfo[]
	scanError: string | null
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type StatusReadResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "missing"; message: string }
	| { kind: "invalid"; message: string }

type StatusConfigInput = typeof StatusConfigBoundary.infer

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

export const StatusConfigBoundary = arkType({
	"repository?": "string|null",
	"baseBranch?": "string|null",
	"worktree?": "boolean|null",
	"workflowFile?": "string|null",
	"sharedContextFile?": "string|null",
	"stateFile?": "string|null",
	"issueDir?": "string|null",
	"evidenceDir?": "string|null",
	"logDir?": "string|null",
	"evidence?": {
		"requireAgentBrowserScreenshots?": "boolean|null",
	},
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"reviewRunner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"claude?": {
		"binary?": "string|null",
		"extraArgs?": "string[]",
		"model?": "string|null",
	},
	"codex?": {
		"binary?": "string|null",
		"extraArgs?": "string[]",
		"model?": "string|null",
	},
	"preset?": arkType.or("string", { name: "string" }, "null"),
	"presetPath?": "string|null",
})

export const StatusStateBoundary = arkType({
	version: "number",
	queue: "object[]",
	"repository?": "string|null",
	"baseBranch?": "string|null",
	"recentRuns?": "unknown[]",
	"current?": "object|null",
})

export const StatusSnapshotBoundary = arkType({
	target: "object",
	state: "object",
	queue: "object",
	current: "object",
	events: "object",
	processes: "object",
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_FILE = ".coder-loop/workflow.md"
const DEFAULT_STATE_FILE = ".coder-loop/runtime/state.json"

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildCoderLoopStatusSnapshot(args: StatusCommandArgs): Promise<CoderLoopStatusSnapshot> {
	const targetCwd = resolve(args.targetCwd)
	const configPath = await resolveConfigPath(targetCwd, args.configPath)
	const baseTarget = makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: "loaded", error: null })

	const configResult = await readStatusConfig(configPath)
	if (configResult.kind === "invalid") {
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: "invalid", error: configResult.message }),
			stateKind: "invalid-config",
			statePath: baseTarget.statePath,
			errorPath: "config",
			errorMessage: configResult.message,
		})
	}
	const configValue = configResult.kind === "ok" ? configResult.value : defaultLoopConfig()
	const configSnapshot: StatusResourceSnapshot = configResult.kind === "ok"
		? { kind: "loaded", error: null }
		: { kind: "missing", error: configResult.message }

	const presetResult = await readStatusPreset(configValue, targetCwd)
	if (presetResult.kind !== "ok") {
		const stateKind: StatusStateKind = presetResult.kind === "missing" ? "missing-preset" : "invalid-preset"
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, configSnapshot),
			stateKind,
			statePath: baseTarget.statePath,
			errorPath: "preset",
			errorMessage: presetResult.message,
		})
	}

	const raw = makeStatusRawArgs(args)
	const options = buildOptions(targetCwd, configPath, raw, configValue, presetResult.value)
	const target = makeStatusTargetSnapshot(targetCwd, configPath, args.repository, options, configSnapshot)
	const stateResult = await readRuntimeState(options)
	if (stateResult.kind !== "ok") {
		const stateKind: StatusStateKind = stateResult.kind === "missing" ? "missing-state" : "invalid-state"
		return makeUnavailableStatusSnapshot({
			target,
			stateKind,
			statePath: options.statePath,
			errorPath: "state",
			errorMessage: stateResult.message,
		})
	}

	const selected = selectIssue(stateResult.value, options)
	const runtimeErrors = await checkRuntime(options, stateResult.value, stateResult.source)
	const currentSnapshot = await buildStatusCurrentSnapshot(options, stateResult.value)
	const events = await buildStatusEventsSnapshot(options, stateResult.value, selected)
	const processes = await buildStatusProcessSnapshot(options)
	const snapshot: CoderLoopStatusSnapshot = {
		target,
		state: {
			kind: runtimeErrors.length === 0 ? "ok" : "invalid-runtime",
			ok: runtimeErrors.length === 0,
			loaded: true,
			path: stateResult.source.kind === "chain-db" ? stateResult.source.dbPath : stateResult.source.statePath,
			version: stateResult.value.version,
			repository: stateResult.value.repository,
			baseBranch: stateResult.value.baseBranch,
			errors: runtimeErrors,
			error: null,
		},
		queue: buildStatusQueueSnapshot(options, stateResult.value, selected),
		current: currentSnapshot,
		events,
		processes,
	}
	StatusSnapshotBoundary.assert(snapshot)
	return snapshot
}

// ---------------------------------------------------------------------------
// Config / preset / state readers
// ---------------------------------------------------------------------------

async function readStatusConfig(path: string): Promise<StatusReadResult<LoopConfig>> {
	try {
		const raw = await readFile(path, "utf-8")
		return { kind: "ok", value: parseConfigText(raw, path) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing optional config file: ${path}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

async function readStatusPreset(config: LoopConfig, targetCwd: string): Promise<StatusReadResult<Preset>> {
	const PKG_ROOT = resolve(import.meta.dir, "..")
	let presetDir: string
	try {
		presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	} catch (error) {
		return { kind: "invalid", message: errorMessage(error) }
	}
	try {
		return { kind: "ok", value: await loadPreset(presetDir) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing preset file: ${resolve(presetDir, "preset.toml")}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

async function readStatusState(path: string): Promise<StatusReadResult<LoopState>> {
	try {
		const raw = await readFile(path, "utf-8")
		return { kind: "ok", value: parseStateText(raw) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing state file: ${path}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

// ---------------------------------------------------------------------------
// Runtime state resolution (chain DB + legacy file fallback)
// ---------------------------------------------------------------------------

export async function readRuntimeState(options: LoopOptions): Promise<RuntimeStateReadResult> {
	const chainState = await readChainRuntimeState(options)
	if (chainState !== null) return chainState
	const fileState = await readStatusState(options.statePath)
	if (fileState.kind === "ok") {
		return { kind: "ok", value: fileState.value, source: { kind: "file", statePath: options.statePath } }
	}
	const legacyStatePath = resolve(options.targetCwd, DEFAULT_STATE_FILE)
	if (legacyStatePath !== options.statePath) {
		const legacyState = await readStatusState(legacyStatePath)
		if (legacyState.kind === "ok") {
			return { kind: "ok", value: legacyState.value, source: { kind: "file", statePath: legacyStatePath } }
		}
	}
	return {
		kind: fileState.kind,
		message: `${fileState.message}; no chain row "${defaultChainNameForTarget(options.targetCwd)}" in ${loopDataRootPaths().stateDbPath}`,
		statePath: options.statePath,
	}
}

async function readChainRuntimeState(options: LoopOptions): Promise<Extract<RuntimeStateReadResult, { kind: "ok" }> | null> {
	const root = loopDataRootPaths()
	const store = openStateStore(root.stateDbPath)
	try {
		const chainName = options.chainNameExplicit
			? options.chainName
			: resolveChainNameForTarget(store, options.targetCwd, defaultChainNameForTarget(options.targetCwd))
		const chainPaths = chainRuntimePaths(root.rootDir, chainName)
		const chain = store.getChain(chainName)
		if (chain === null) return null
		const queue = store.listItems(chain.id).map((item) => dbItemToQueueItem(item, chainPaths))
		return {
			kind: "ok",
			value: {
				version: 1,
				queue,
				repository: chain.repository,
				baseBranch: chain.baseBranch,
				recentRuns: [],
				current: null,
			},
			source: { kind: "chain-db", dbPath: root.stateDbPath, chainName, chainPaths },
		}
	} finally {
		store.close()
	}
}

function resolveChainNameForTarget(store: StateStore, targetCwdInput: string, fallbackName: string): string {
	const targetCwd = resolve(targetCwdInput)
	const matches: Chain[] = []
	for (const chain of store.listChains()) {
		if (chainTargetsRepoCwd(store, chain, targetCwd)) matches.push(chain)
	}
	if (matches.length === 1) return matches[0]!.name
	if (matches.length > 1) {
		throw new Error(`target-cwd ${targetCwd} belongs to multiple chains: ${matches.map((chain) => chain.name).join(", ")}; specify --chain`)
	}
	return fallbackName
}

function chainTargetsRepoCwd(store: StateStore, chain: Chain, targetCwd: string): boolean {
	const metadataTarget = chain.metadata.targetCwd
	if (typeof metadataTarget === "string" && resolve(metadataTarget) === targetCwd) return true
	return store.listItems(chain.id).some((item) => resolve(item.repoCwd) === targetCwd)
}

function dbItemToQueueItem(item: Item, chainPaths: ChainRuntimePaths): QueueItem {
	return {
		status: item.status,
		attempts: item.attempts,
		title: item.title,
		priority: item.priority,
		branch: item.branch,
		pr: item.pr,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile === null ? null : resolveFrom(chainPaths.chainDir, item.issueFile),
		evidenceDir: item.evidenceDir === null ? null : resolveFrom(chainPaths.chainDir, item.evidenceDir),
		agentCwd: item.agentCwd,
		runner: item.runner,
		extra: { ...item.extra, issue: item.issue },
	}
}

// ---------------------------------------------------------------------------
// Raw args construction
// ---------------------------------------------------------------------------

export function makeStatusRawArgs(args: StatusCommandArgs): RawArgs {
	return {
		maxIterations: null,
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		workflowPath: null,
		statePath: null,
		repository: args.repository,
		chainName: null,
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
		worktree: false,
		baseBranch: null,
	}
}

// ---------------------------------------------------------------------------
// Target snapshot
// ---------------------------------------------------------------------------

function makeStatusTargetSnapshot(
	targetCwd: string,
	configPath: string,
	repositoryOverride: string | null,
	options: LoopOptions | null,
	config: StatusResourceSnapshot,
): StatusTargetSnapshot {
	const runtimeRoot = resolve(targetCwd, ".coder-loop/runtime")
	const chainPaths = chainRuntimePaths(null, defaultChainNameForTarget(targetCwd))
	const defaultLogDir = chainPaths.runsDir
	const preset = options === null ? null : {
		name: options.preset.name,
		version: options.preset.version,
		description: options.preset.description,
		presetDir: options.preset.presetDir,
	}
	return {
		cwd: targetCwd,
		configPath,
		configFormat: configFormatForPath(configPath),
		config,
		workflowPath: options?.workflowPath ?? resolve(targetCwd, DEFAULT_WORKFLOW_FILE),
		sharedContextPath: options?.sharedContextPath ?? resolve(runtimeRoot, "shared.md"),
		statePath: options?.statePath ?? resolve(runtimeRoot, "state.json"),
		issueDir: options?.issueDir ?? resolve(runtimeRoot, "issues"),
		evidenceRootDir: options?.evidenceRootDir ?? resolve(runtimeRoot, "evidence"),
		logDir: options?.logDir ?? defaultLogDir,
		traceFile: options?.traceFile ?? resolve(defaultLogDir, "legacy-trace.txt"),
		loopFile: options?.loopFile ?? resolve(chainPaths.chainDir, "loop-control"),
		repository: options?.repository ?? repositoryOverride,
		baseBranch: options?.baseBranch ?? null,
		worktree: options?.worktree ?? false,
		runner: buildStatusRunnerDefaultsSnapshot(options),
		preset,
	}
}

// ---------------------------------------------------------------------------
// Runner defaults snapshot
// ---------------------------------------------------------------------------

function buildStatusRunnerDefaultsSnapshot(options: LoopOptions | null): StatusRunnerDefaultsSnapshot {
	if (options !== null) {
		return {
			hostDefault: options.hostRunner,
			default: statusRunnerSelection(options.defaultRunner),
			reviewDefault: statusRunnerSelection(options.reviewRunner),
		}
	}
	const hostRunner = detectHostRunner(process.env)
	const config: LoopConfig = {
		repository: null,
		baseBranch: null,
		worktree: null,
		workflowFile: null,
		sharedContextFile: null,
		stateFile: null,
		issueDir: null,
		evidenceDir: null,
		logDir: null,
		requireAgentBrowserScreenshots: null,
		defaultRunner: null,
		reviewRunner: null,
		claudeBinary: null,
		claudeExtraArgs: [],
		claudeModel: null,
		codexBinary: null,
		codexExtraArgs: [],
		codexModel: null,
		preset: null,
		presetPath: null,
	}
	return {
		hostDefault: hostRunner,
		default: statusRunnerSelection(selectDefaultRunner(null, buildAgentRunnerCommands(config))),
		reviewDefault: statusRunnerSelection(selectReviewRunner(null, buildAgentRunnerCommands(config))),
	}
}

// ---------------------------------------------------------------------------
// Unavailable snapshot (error fallback)
// ---------------------------------------------------------------------------

function makeUnavailableStatusSnapshot(input: {
	target: StatusTargetSnapshot
	stateKind: StatusStateKind
	statePath: string
	errorPath: string
	errorMessage: string
}): CoderLoopStatusSnapshot {
	return {
		target: input.target,
		state: {
			kind: input.stateKind,
			ok: false,
			loaded: false,
			path: input.statePath,
			version: null,
			repository: null,
			baseBranch: null,
			errors: [{ path: input.errorPath, message: input.errorMessage }],
			error: input.errorMessage,
		},
		queue: { total: 0, byStatus: {}, continuable: 0, terminal: 0, selected: null },
		current: { run: null, id: null, item: null, runner: null, phaseStatus: null },
		events: { runId: null, path: null, exists: false, recent: [], latest: null, error: null },
		processes: {
			loopFile: {
				path: input.target.loopFile,
				exists: false,
				startedAt: null,
				pid: null,
				pidAlive: null,
				log: null,
				cwd: null,
				statePath: null,
				command: null,
				requireBrowserEvidence: null,
				raw: null,
			},
			live: [],
			scanError: null,
		},
	}
}

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

function flattenExtraReplacer(_key: string, value: unknown): unknown {
	if (!isObjectRecord(value) || !("extra" in value) || !isJsonObject(value.extra)) return value
	const extra = value.extra
	const rest: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value)) {
		if (k !== "extra") rest[k] = v
	}
	return { ...extra, ...rest }
}

export function stringifyStatusSnapshot(snapshot: CoderLoopStatusSnapshot): string {
	return JSON.stringify(snapshot, flattenExtraReplacer, "\t")
}

// ---------------------------------------------------------------------------
// Queue snapshot
// ---------------------------------------------------------------------------

function buildStatusQueueSnapshot(options: LoopOptions, state: LoopState, selected: SelectedIssue | null): StatusQueueSnapshot {
	const byStatus: Record<string, number> = {}
	for (const item of state.queue) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const continuableStatuses = new Set(options.preset.statuses.continuable)
	const terminalStatuses = new Set(options.preset.statuses.terminal)
	return {
		total: state.queue.length,
		byStatus,
		continuable: state.queue.filter((item) => continuableStatuses.has(item.status)).length,
		terminal: state.queue.filter((item) => terminalStatuses.has(item.status)).length,
		selected: selected === null ? null : {
			id: getItemId(selected.item, options.preset),
			item: selected.item,
			issueFile: selected.issueFile,
			evidenceDir: selected.evidenceDir,
			agentCwd: selected.agentCwd,
			runner: statusRunnerSelection(selected.runner),
			reviewRunner: statusRunnerSelection(selected.reviewRunner),
		},
	}
}

// ---------------------------------------------------------------------------
// Current run snapshot
// ---------------------------------------------------------------------------

async function buildStatusCurrentSnapshot(options: LoopOptions, state: LoopState): Promise<StatusCurrentSnapshot> {
	if (state.current === null) return { run: null, id: null, item: null, runner: null, phaseStatus: null }
	let id: string | null = null
	let item: QueueItem | null = null
	try {
		id = getCurrentId(state.current, options.preset)
		item = state.queue.find((entry) => getItemId(entry, options.preset) === id) ?? null
	} catch {
		id = null
	}
	const outputPath = agentOutputPath(options, state.current.runId, state.current.phase)
	return {
		run: state.current,
		id,
		item,
		runner: item === null ? null : statusRunnerSelection(selectRunnerForPhase(state.current.phase, item, options)),
		phaseStatus: await readAgentPhaseStatus(agentStatusPath(outputPath)),
	}
}

// ---------------------------------------------------------------------------
// Runner selection snapshot
// ---------------------------------------------------------------------------

function statusRunnerSelection(selection: AgentRunnerSelection): StatusRunnerSelectionSnapshot {
	return {
		kind: selection.kind,
		source: selection.source,
		binary: selection.binary,
		extraArgs: [...selection.extraArgs],
		model: selection.model,
	}
}

// ---------------------------------------------------------------------------
// Agent phase status (exported — used by readAgentStatusRunner / readAgentStatusModel in loop.ts)
// ---------------------------------------------------------------------------

export async function readAgentPhaseStatus(path: string): Promise<StatusPhaseStatusSnapshot> {
	try {
		const raw = await readFile(path, "utf-8")
		const parsed: unknown = JSON.parse(raw)
		const status = agentStatusFromInput(assertArk(AgentRunStatusBoundary, parsed, "agent status"))
		return { path, exists: true, value: status, error: null }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { path, exists: false, value: null, error: null }
		return { path, exists: true, value: null, error: errorMessage(error) }
	}
}

export function agentStatusFromInput(input: AgentRunStatusInput): AgentRunStatus {
	return {
		label: input.label,
		runner: input.runner ?? null,
		model: input.model ?? null,
		pid: input.pid,
		startedAt: input.startedAt,
		lastEventAt: input.lastEventAt,
		outputPath: input.outputPath,
		statusPath: input.statusPath,
		bytesWritten: input.bytesWritten,
		promptChars: input.promptChars,
		lastStream: input.lastStream,
		exitCode: input.exitCode,
		signal: input.signal,
		error: input.error,
		sessionId: input.sessionId,
		terminated: input.terminated,
	}
}

// ---------------------------------------------------------------------------
// Events snapshot
// ---------------------------------------------------------------------------

async function buildStatusEventsSnapshot(options: LoopOptions, state: LoopState, selected: SelectedIssue | null): Promise<StatusEventsSnapshot> {
	const runId = state.current?.runId ?? selected?.item.lastRunId ?? firstLastRunId(state)
	if (runId === null) return { runId: null, path: null, exists: false, recent: [], latest: null, error: null }
	const path = loopEventsPath(options.logDir, runId)
	try {
		const raw = await readFile(path, "utf-8")
		const recent = parseRecentJsonLines(raw, 20)
		return {
			runId,
			path,
			exists: true,
			recent,
			latest: recent[recent.length - 1] ?? null,
			error: null,
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { runId, path, exists: false, recent: [], latest: null, error: null }
		return { runId, path, exists: true, recent: [], latest: null, error: errorMessage(error) }
	}
}

function firstLastRunId(state: LoopState): string | null {
	for (const item of state.queue) {
		if (item.lastRunId !== null) return item.lastRunId
	}
	return null
}

function parseRecentJsonLines(raw: string, limit: number): JsonValue[] {
	const lines = raw.split("\n").filter((line) => line.trim() !== "")
	const recent = lines.slice(-limit)
	return recent.map((line) => {
		const parsed: unknown = JSON.parse(line)
		if (!isJsonValue(parsed)) throw new Error("event line is not JSON data")
		return parsed
	})
}

// ---------------------------------------------------------------------------
// Process snapshot
// ---------------------------------------------------------------------------

async function buildStatusProcessSnapshot(options: LoopOptions): Promise<StatusProcessSnapshot> {
	const loopFile = await readStatusLoopFile(options.loopFile)
	const live: StatusProcessInfo[] = []
	if (loopFile.pid !== null) {
		live.push({
			pid: loopFile.pid,
			ppid: null,
			command: null,
			cwd: loopFile.cwd,
			matchesTarget: loopFile.cwd === options.targetCwd,
			alive: loopFile.pidAlive === true,
			source: "loopFile",
		})
	}
	const scan = scanLoopProcesses(options.targetCwd)
	return {
		loopFile,
		live: mergeProcessSnapshots(live, scan.kind === "ok" ? scan.value : []),
		scanError: scan.kind === "ok" ? null : scan.message,
	}
}

async function readStatusLoopFile(path: string): Promise<StatusLoopFileSnapshot> {
	try {
		const raw = await readFile(path, "utf-8")
		const parsed = parseLoopFile(raw)
		const pidAlive = parsed.pid === null ? null : isPidAlive(parsed.pid)
		return { path, exists: true, ...parsed, pidAlive, raw }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { path, exists: false, startedAt: null, pid: null, pidAlive: null, log: null, cwd: null, statePath: null, command: null, requireBrowserEvidence: null, raw: null }
		}
		return { path, exists: true, startedAt: null, pid: null, pidAlive: null, log: null, cwd: null, statePath: null, command: null, requireBrowserEvidence: null, raw: null }
	}
}

function parseLoopFile(raw: string): Omit<StatusLoopFileSnapshot, "path" | "exists" | "pidAlive" | "raw"> {
	const fields: Record<string, string> = {}
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":")
		if (separator <= 0) continue
		fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
	}
	const pid = fields.pid === undefined || fields.pid === "" ? null : Number(fields.pid)
	return {
		startedAt: fields.started ?? null,
		pid: pid === null || Number.isInteger(pid) ? pid : null,
		log: fields.log ?? null,
		cwd: fields.cwd ?? null,
		statePath: fields.state ?? null,
		command: fields.command ?? null,
		requireBrowserEvidence: parseLoopFileBoolean(fields.requireBrowserEvidence),
	}
}

function parseLoopFileBoolean(value: string | undefined): boolean | null {
	if (value === undefined) return null
	if (value === "true") return true
	if (value === "false") return false
	return null
}

function scanLoopProcesses(targetCwd: string): StatusReadResult<StatusProcessInfo[]> {
	const proc = Bun.spawnSync({
		cmd: ["ps", "-axo", "pid=,ppid=,command="],
		stdout: "pipe",
		stderr: "pipe",
	})
	if (proc.exitCode !== 0) return { kind: "invalid", message: new TextDecoder().decode(proc.stderr).trim() || "ps scan failed" }
	const stdout = new TextDecoder().decode(proc.stdout)
	const live: StatusProcessInfo[] = []
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		const ppid = Number(match[2])
		const commandText = match[3] ?? ""
		const invokesLoop = commandText.includes("src/loop.ts") || /(^|\s)coder-loop(\s|$)/.test(commandText)
		const looksLikeLoop = invokesLoop && !/(^|\s)(status|daemon|install|uninstall|doctor)(\s|$)/.test(commandText)
		const matchesTarget = commandText.includes(targetCwd)
		if (!looksLikeLoop) continue
		live.push({
			pid,
			ppid: Number.isInteger(ppid) ? ppid : null,
			command: commandText,
			cwd: null,
			matchesTarget,
			alive: true,
			source: "ps",
		})
	}
	return { kind: "ok", value: live }
}

function mergeProcessSnapshots(left: StatusProcessInfo[], right: StatusProcessInfo[]): StatusProcessInfo[] {
	const byKey = new Map<string, StatusProcessInfo>()
	for (const entry of [...left, ...right]) byKey.set(`${entry.source}:${entry.pid}`, entry)
	return [...byKey.values()]
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loopConfigFromStatusInput(input: StatusConfigInput): LoopConfig {
	return {
		repository: input.repository ?? null,
		baseBranch: input.baseBranch ?? null,
		worktree: input.worktree ?? null,
		workflowFile: input.workflowFile ?? null,
		sharedContextFile: input.sharedContextFile ?? null,
		stateFile: input.stateFile ?? null,
		issueDir: input.issueDir ?? null,
		evidenceDir: input.evidenceDir ?? null,
		logDir: input.logDir ?? null,
		requireAgentBrowserScreenshots: input.evidence?.requireAgentBrowserScreenshots ?? null,
		defaultRunner: input.runner ?? null,
		reviewRunner: input.reviewRunner ?? null,
		claudeBinary: input.claude?.binary ?? null,
		claudeExtraArgs: input.claude?.extraArgs ?? [],
		claudeModel: input.claude?.model ?? null,
		codexBinary: input.codex?.binary ?? null,
		codexExtraArgs: input.codex?.extraArgs ?? [],
		codexModel: input.codex?.model ?? null,
		preset: readPresetNameFromStatusInput(input.preset),
		presetPath: input.presetPath ?? null,
	}
}

function readPresetNameFromStatusInput(value: StatusConfigInput["preset"]): string | null {
	if (value === undefined || value === null) return null
	if (typeof value === "string") return value
	return value.name
}

// ---------------------------------------------------------------------------
// Live process finder (used by daemon-client code)
// ---------------------------------------------------------------------------

export function findOwnedLiveProcess(snapshot: CoderLoopStatusSnapshot): StatusProcessInfo | null {
	return snapshot.processes.live.find((entry) => entry.alive && entry.matchesTarget) ?? null
}
