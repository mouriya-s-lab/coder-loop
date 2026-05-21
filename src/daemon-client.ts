/**
 * Daemon client-side commands for coder-loop.
 *
 * Handles daemon start/stop/restart, target status, daemon state import,
 * daemon probing, and queue unblock.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile } from "node:fs/promises"
import { closeSync, existsSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"

import {
	daemonDefaults,
	sendDaemonRequest,
	type DaemonRequest,
	type DaemonResponse,
	type DaemonServerOptions,
} from "./daemon"

import {
	chainRuntimePaths,
	defaultChainNameForTarget,
} from "./runtime-paths"

import { defaultMigratedChainName, migrateStateJson } from "./state-migration"

import { openStateDb } from "./state-db"

import {
	buildCoderLoopStatusSnapshot,
	findOwnedLiveProcess,
	makeStatusRawArgs,
	type StatusStateKind,
} from "./status"

import {
	errorMessage,
	fail,
	isJsonObject,
	isJsonValue,
	isNodeError,
	isObjectRecord,
	shellQuote,
	sleep,
	type JsonObject,
	type JsonValue,
} from "./util"

import {
	buildOptions,
	configFormatForPath,
	defaultLoopConfig,
	getCurrentId,
	getItemId,
	loadConfig,
	loadPreset,
	loadState,
	parseConfigText,
	resolveConfigPath,
	resolvePresetDir,
	saveState,
	serializeState,
	DEFAULT_STATE_FILE,
	type AgentRunnerKind,
	type DaemonCommandArgs,
	type DaemonTargetIpcOptions,
	type LoopConfig,
	type LoopOptions,
	type LoopState,
	type Preset,
	type QueueItem,
	type QueueUnblockCommandArgs,
} from "./loop"

// ---------------------------------------------------------------------------
// Re-export types that external consumers (tests, CLI) import via ./loop
// ---------------------------------------------------------------------------

export type { DaemonCommandArgs, DaemonTargetIpcOptions, QueueUnblockCommandArgs } from "./loop"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PKG_ROOT = resolve(import.meta.dir, "..")

const DAEMON_IMPORT_BASE_KEYS = new Set([
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonStartPlan = {
	targetCwd: string
	chainName: string
	socketPath: string
	pidPath: string
	dbPath: string
	rootDir: string
	schedulerIntervalMs: number
	spawnAgents: boolean
	command: string[]
	commandLine: string
	stdoutPath: string
	stderrPath: string
	requireBrowserEvidence: boolean
}

type DaemonTargetImportTrace = {
	cmd: string
	issue?: number
	ok: boolean
	error?: string
}

type DaemonTargetImportResult = {
	chainName: string
	chain: JsonObject
	legacyStatePath: string
	legacyStateFound: boolean
	itemsSeen: number
	imported: number
	updated: number
	skipped: number
	trace: DaemonTargetImportTrace[]
}

type DaemonTargetStatusResult = {
	action: "status"
	target: string
	socketPath: string
	chainName: string
	daemon: DaemonResponse
	chain: JsonObject | null
	chainError: string | null
	items: JsonValue[]
	slots: JsonValue[]
}

type DaemonStartResult = {
	action: "start"
	target: string
	socketPath: string
	pidPath: string
	dbPath: string
	daemon: {
		started: boolean
		pid: number | null
		command: string[]
		stdoutPath: string
		stderrPath: string
		spawnAgents: boolean
	}
	import: DaemonTargetImportResult
	status: DaemonTargetStatusResult
	requireBrowserEvidence: boolean
}

type DaemonStopPlan = {
	action: "stop"
	target: string
	socketPath: string
	chainName: string
}

type DaemonStopResult = DaemonStopPlan & {
	stopped: true
	updated: number
	items: JsonValue[]
	daemon: DaemonResponse
}

export type QueueUnblockMutationOutcome =
	| {
			changed: true
			issue: string
			beforeStatus: "blocked"
			afterStatus: "queued"
			clearedBlockerRepo: boolean
			clearedBlockerRef: boolean
			clearedCurrent: boolean
	  }
	| {
			changed: false
			issue: string
			reason: "not_found"
	  }
	| {
			changed: false
			issue: string
			reason: "not_blocked"
			status: string
	  }

type QueueUnblockCommandResult = {
	action: "queue.unblock"
	target: string
	repository: string | null
	statePath: string
	issue: string
	dryRun: boolean
	mutation: QueueUnblockMutationOutcome
	daemon:
		| { requested: false; skipped: true; reason: "not_requested" | "no_requeue_needed" }
		| { requested: true; dryRun: true; plan: DaemonStartPlan }
		| { requested: true; dryRun: false; result: DaemonStartResult }
	verification: {
		itemStatus: string | null
		blockerRepoPresent: boolean | null
		blockerRefPresent: boolean | null
		stateKind: StatusStateKind
		daemonRunning: boolean
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true
		await sleep(50)
	}
	return !isPidAlive(pid)
}

function defaultDaemonIpcOptions(): DaemonTargetIpcOptions {
	return {
		socketPath: null,
		pidPath: null,
		dbPath: null,
		rootDir: null,
		schedulerIntervalMs: null,
		spawnAgents: true,
	}
}

function daemonServerOptionsFromIpc(ipc: DaemonTargetIpcOptions): DaemonServerOptions {
	const options: DaemonServerOptions = { spawnAgents: ipc.spawnAgents }
	if (ipc.socketPath !== null) options.socketPath = ipc.socketPath
	if (ipc.pidPath !== null) options.pidPath = ipc.pidPath
	if (ipc.dbPath !== null) options.dbPath = ipc.dbPath
	if (ipc.rootDir !== null) options.rootDir = ipc.rootDir
	if (ipc.schedulerIntervalMs !== null) options.schedulerIntervalMs = ipc.schedulerIntervalMs
	return options
}

async function probeDaemon(socketPath: string): Promise<{ reachable: true; response: DaemonResponse } | { reachable: false; error: string }> {
	try {
		return { reachable: true, response: await sendDaemonRequest(socketPath, { cmd: "daemon.status" }, 1_000) }
	} catch (error) {
		return { reachable: false, error: errorMessage(error) }
	}
}

async function startDetachedDaemon(plan: DaemonStartPlan): Promise<number | null> {
	await mkdir(plan.rootDir, { recursive: true })
	await mkdir(dirname(plan.stdoutPath), { recursive: true })
	await mkdir(dirname(plan.stderrPath), { recursive: true })
	const stdoutFd = openSync(plan.stdoutPath, "a")
	const stderrFd = openSync(plan.stderrPath, "a")
	try {
		const child = spawn(plan.command[0]!, plan.command.slice(1), {
			cwd: plan.targetCwd,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		})
		child.unref()
		return child.pid ?? null
	} finally {
		closeSync(stdoutFd)
		closeSync(stderrFd)
	}
}

async function waitForDaemonReady(socketPath: string): Promise<void> {
	const deadline = Date.now() + 5_000
	let lastError = "daemon did not become ready"
	while (Date.now() < deadline) {
		const probe = await probeDaemon(socketPath)
		if (probe.reachable) return
		lastError = probe.error
		await sleep(100)
	}
	throw new Error(`daemon start timed out waiting for ${socketPath}: ${lastError}`)
}

function optionalStringFromJsonObject(value: JsonObject | null, key: string): string | null {
	if (value === null) return null
	const raw = value[key]
	return typeof raw === "string" ? raw : null
}

function optionalNumberFromJsonObject(value: JsonObject | null, key: string): number | null {
	if (value === null) return null
	const raw = value[key]
	return typeof raw === "number" && Number.isInteger(raw) ? raw : null
}

function legacyStatePathForDaemonImport(options: LoopOptions): string {
	return existsSync(options.configPath)
		? options.statePath
		: resolve(options.targetCwd, DEFAULT_STATE_FILE)
}

async function readLegacyTargetQueue(statePath: string): Promise<{ found: boolean; queue: unknown[] }> {
	const raw = await readFile(statePath, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	})
	if (raw === null) return { found: false, queue: [] }
	const parsed: unknown = JSON.parse(raw)
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.queue)) throw new Error(`${statePath}: expected state object with queue array`)
	return { found: true, queue: parsed.queue }
}

function daemonImportTrace(cmd: string, issue: number | undefined, response: DaemonResponse): DaemonTargetImportTrace {
	const entry: DaemonTargetImportTrace = { cmd, ok: response.ok }
	if (issue !== undefined) entry.issue = issue
	if (!response.ok) entry.error = response.error
	return entry
}

function itemAddRequestFromQueueEntry(entry: unknown, chainName: string, targetCwd: string): Extract<DaemonRequest, { cmd: "item.add" }> | null {
	if (!isObjectRecord(entry) || typeof entry.issue !== "number" || !Number.isInteger(entry.issue)) return null
	const request: Extract<DaemonRequest, { cmd: "item.add" }> = {
		cmd: "item.add",
		chain: chainName,
		issue: entry.issue,
		repoCwd: targetCwd,
		extra: importExtraFromQueueEntry(entry),
	}
	if (typeof entry.status === "string") request.status = entry.status
	if (typeof entry.priority === "string") request.priority = entry.priority
	if (typeof entry.attempts === "number" && Number.isInteger(entry.attempts)) request.attempts = entry.attempts
	const title = nullableStringFromEntry(entry.title)
	if (title !== undefined) request.title = title
	const branch = nullableStringFromEntry(entry.branch)
	if (branch !== undefined) request.branch = branch
	const pr = nullableIntegerFromEntry(entry.pr)
	if (pr !== undefined) request.pr = pr
	const lastRunId = nullableStringFromEntry(entry.lastRunId)
	if (lastRunId !== undefined) request.lastRunId = lastRunId
	const issueFile = nullableStringFromEntry(entry.issueFile)
	if (issueFile !== undefined) request.issueFile = issueFile
	const evidenceDir = nullableStringFromEntry(entry.evidenceDir)
	if (evidenceDir !== undefined) request.evidenceDir = evidenceDir
	const agentCwd = nullableStringFromEntry(entry.agentCwd)
	if (agentCwd !== undefined) request.agentCwd = agentCwd
	if (entry.runner === "claude" || entry.runner === "codex" || entry.runner === null) request.runner = entry.runner
	return request
}

function nullableStringFromEntry(value: unknown): string | null | undefined {
	if (typeof value === "string") return value
	if (value === null) return null
	return undefined
}

function nullableIntegerFromEntry(value: unknown): number | null | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value
	if (value === null) return null
	return undefined
}

function importExtraFromQueueEntry(entry: Record<string, unknown>): JsonObject {
	const extra: JsonObject = isJsonObject(entry.extra) ? { ...entry.extra } : {}
	for (const [key, value] of Object.entries(entry)) {
		if (DAEMON_IMPORT_BASE_KEYS.has(key)) continue
		if (isJsonValue(value)) extra[key] = value
	}
	return extra
}

async function updateDuplicateDaemonItem(
	socketPath: string,
	chainName: string,
	request: Extract<DaemonRequest, { cmd: "item.add" }>,
	trace: DaemonTargetImportTrace[],
): Promise<void> {
	const existing = await findDaemonItem(socketPath, chainName, request.issue, request.repoCwd)
	if (existing === null || typeof existing.id !== "number") throw new Error(`item.add ${request.issue}: duplicate row was not found by item.list`)
	const response = await sendDaemonRequest(socketPath, {
		cmd: "item.update",
		itemId: existing.id,
		patch: itemPatchFromImportRequest(request),
	})
	trace.push(daemonImportTrace("item.update", request.issue, response))
	if (!response.ok) throw new Error(`item.update ${existing.id}: ${response.error}`)
}

async function findDaemonItem(socketPath: string, chainName: string, issue: number, repoCwd: string): Promise<JsonObject | null> {
	const items = await listDaemonItemsForTarget(socketPath, chainName, repoCwd)
	for (const item of items) {
		if (!isObjectRecord(item) || Array.isArray(item)) continue
		if (item.issue === issue && item.repoCwd === repoCwd) return item as JsonObject
	}
	return null
}

function itemPatchFromImportRequest(request: Extract<DaemonRequest, { cmd: "item.add" }>): Extract<DaemonRequest, { cmd: "item.update" }>["patch"] {
	const patch: Extract<DaemonRequest, { cmd: "item.update" }>["patch"] = {}
	if (request.status !== undefined) patch.status = request.status
	if (request.priority !== undefined) patch.priority = request.priority
	if (request.attempts !== undefined) patch.attempts = request.attempts
	if (request.title !== undefined) patch.title = request.title
	if (request.branch !== undefined) patch.branch = request.branch
	if (request.pr !== undefined) patch.pr = request.pr
	if (request.lastRunId !== undefined) patch.lastRunId = request.lastRunId
	if (request.issueFile !== undefined) patch.issueFile = request.issueFile
	if (request.evidenceDir !== undefined) patch.evidenceDir = request.evidenceDir
	if (request.agentCwd !== undefined) patch.agentCwd = request.agentCwd
	if (request.runner !== undefined) patch.runner = request.runner
	if (request.extra !== undefined) patch.extra = request.extra
	return patch
}

async function listDaemonItemsForTarget(socketPath: string, chainName: string, targetCwd: string): Promise<JsonValue[]> {
	const response = await sendDaemonRequest(socketPath, { cmd: "item.list", chain: chainName })
	if (!response.ok) throw new Error(`item.list ${chainName}: ${response.error}`)
	if (!Array.isArray(response.data)) throw new Error(`item.list ${chainName}: expected array`)
	return response.data.filter((item) => isObjectRecord(item) && item.repoCwd === targetCwd)
}

function daemonSlotMatchesTarget(slot: JsonValue, chain: JsonObject, targetCwd: string): boolean {
	return isObjectRecord(slot)
		&& slot.chainId === chain.id
		&& slot.repoCwd === targetCwd
}

async function resolveDaemonChainNameForTarget(socketPath: string, targetCwdInput: string, fallbackName: string): Promise<string> {
	const targetCwd = resolve(targetCwdInput)
	const listResponse = await sendDaemonRequest(socketPath, { cmd: "chain.list" })
	if (!listResponse.ok) throw new Error(`chain.list: ${listResponse.error}`)
	if (!Array.isArray(listResponse.data)) throw new Error("chain.list: expected array")
	const matches: string[] = []
	for (const entry of listResponse.data) {
		if (!isObjectRecord(entry) || typeof entry.name !== "string" || typeof entry.id !== "number") continue
		const metadata = isObjectRecord(entry.metadata) ? entry.metadata : {}
		if (typeof metadata.targetCwd === "string" && resolve(metadata.targetCwd) === targetCwd) {
			matches.push(entry.name)
			continue
		}
		const itemResponse = await sendDaemonRequest(socketPath, { cmd: "item.list", chain: entry.name })
		if (!itemResponse.ok || !Array.isArray(itemResponse.data)) continue
		if (itemResponse.data.some((item) => isObjectRecord(item) && typeof item.repoCwd === "string" && resolve(item.repoCwd) === targetCwd)) {
			matches.push(entry.name)
		}
	}
	if (matches.length === 1) return matches[0]!
	if (matches.length > 1) throw new Error(`target-cwd ${targetCwd} belongs to multiple chains: ${matches.join(", ")}`)
	return fallbackName
}

function requireJsonObject(value: JsonValue, label: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${label}: expected object response`)
	return value
}

function hasOwnJsonKey(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function findQueueItemById(state: LoopState, preset: Preset, issue: string): QueueItem | null {
	return state.queue.find((item) => getItemId(item, preset) === issue) ?? null
}

// ---------------------------------------------------------------------------
// Daemon start
// ---------------------------------------------------------------------------

export function buildDaemonStartPlan(args: Extract<DaemonCommandArgs, { action: "start" }>): DaemonStartPlan {
	const targetCwd = resolve(args.targetCwd)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const options = daemonServerOptionsFromIpc(args.ipc)
	const defaults = daemonDefaults(options)
	const chainName = defaultMigratedChainName(targetCwd, args.repository)
	const daemonUpDir = chainRuntimePaths(defaults.rootDir, chainName).daemonRunDir(timestamp)
	const stdoutPath = resolve(daemonUpDir, "up.stdout.log")
	const stderrPath = resolve(daemonUpDir, "up.stderr.log")
	const command = [
		process.argv[0] ?? "bun",
		resolve(import.meta.dir, "loop.ts"),
		"daemon",
		"up",
	]
	command.push("--root", defaults.rootDir)
	command.push("--socket", defaults.socketPath)
	command.push("--pid", defaults.pidPath)
	command.push("--db", defaults.dbPath)
	command.push("--log-chain", chainName)
	command.push("--scheduler-interval-ms", String(defaults.schedulerIntervalMs))
	if (!defaults.spawnAgents) command.push("--no-spawn-agents")
	return {
		targetCwd,
		chainName,
		socketPath: defaults.socketPath,
		pidPath: defaults.pidPath,
		dbPath: defaults.dbPath,
		rootDir: defaults.rootDir,
		schedulerIntervalMs: defaults.schedulerIntervalMs,
		spawnAgents: defaults.spawnAgents,
		command,
		commandLine: command.map(shellQuote).join(" "),
		stdoutPath,
		stderrPath,
		requireBrowserEvidence: args.requireBrowserEvidence,
	}
}

export async function runDaemonStartCommand(args: Extract<DaemonCommandArgs, { action: "start" }>): Promise<void> {
	const plan = buildDaemonStartPlan(args)
	if (args.dryRun) {
		process.stdout.write([
			`daemon start dry-run: target=${plan.targetCwd}`,
			`daemon start dry-run: socket=${plan.socketPath}`,
			`daemon start dry-run: daemon-up-command=${plan.commandLine}`,
			`daemon start dry-run: require-browser-evidence=${plan.requireBrowserEvidence}`,
			`daemon start dry-run: spawn-agents=${plan.spawnAgents}`,
			`daemon start dry-run: stdout=${plan.stdoutPath}`,
			`daemon start dry-run: stderr=${plan.stderrPath}`,
			"",
		].join("\n"))
		return
	}
	const result = await executeDaemonStart(args, plan)
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

async function executeDaemonStart(args: Extract<DaemonCommandArgs, { action: "start" }>, plan = buildDaemonStartPlan(args)): Promise<DaemonStartResult> {
	const probe = await probeDaemon(plan.socketPath)
	let started = false
	let pid: number | null = null
	if (!probe.reachable) {
		pid = await startDetachedDaemon(plan)
		started = true
		await waitForDaemonReady(plan.socketPath)
	}
	const imported = await importTargetStateViaDaemon(args, plan.socketPath)
	const status = await buildDaemonTargetStatus({
		action: "status",
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		repository: args.repository,
		output: "json",
		ipc: args.ipc,
	})
	return {
		action: "start",
		target: plan.targetCwd,
		socketPath: plan.socketPath,
		pidPath: plan.pidPath,
		dbPath: plan.dbPath,
		daemon: {
			started,
			pid,
			command: plan.command,
			stdoutPath: plan.stdoutPath,
			stderrPath: plan.stderrPath,
			spawnAgents: plan.spawnAgents,
		},
		import: imported,
		status,
		requireBrowserEvidence: plan.requireBrowserEvidence,
	}
}

// ---------------------------------------------------------------------------
// Daemon stop
// ---------------------------------------------------------------------------

export async function runDaemonStopCommand(args: Extract<DaemonCommandArgs, { action: "stop" }>): Promise<void> {
	const plan = buildDaemonStopPlan(args)
	if (args.dryRun) {
		process.stdout.write(JSON.stringify({ ...plan, dryRun: true }, null, "\t") + "\n")
		return
	}
	const result = await executeDaemonStop(plan)
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function buildDaemonStopPlan(args: Extract<DaemonCommandArgs, { action: "stop" }>): DaemonStopPlan {
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const targetCwd = resolve(args.targetCwd)
	return {
		action: "stop",
		target: targetCwd,
		socketPath: defaults.socketPath,
		chainName: defaultChainNameForTarget(targetCwd),
	}
}

async function executeDaemonStop(plan: DaemonStopPlan): Promise<DaemonStopResult> {
	const daemon = await sendDaemonRequest(plan.socketPath, { cmd: "daemon.status" })
	const chainName = await resolveDaemonChainNameForTarget(plan.socketPath, plan.target, plan.chainName)
	const chainResponse = await sendDaemonRequest(plan.socketPath, { cmd: "chain.get", chain: chainName })
	if (!chainResponse.ok) return { ...plan, chainName, stopped: true, updated: 0, items: [], daemon }
	const items = await listDaemonItemsForTarget(plan.socketPath, chainName, plan.target)
	let updated = 0
	const stoppedItems: JsonValue[] = []
	for (const item of items) {
		if (!isObjectRecord(item) || typeof item.id !== "number") continue
		const response = await sendDaemonRequest(plan.socketPath, {
			cmd: "item.update",
			itemId: item.id,
			patch: { status: "paused" },
		})
		if (!response.ok) throw new Error(`item.update ${item.id}: ${response.error}`)
		updated++
		stoppedItems.push(response.data)
	}
	return { ...plan, chainName, stopped: true, updated, items: stoppedItems, daemon }
}

// ---------------------------------------------------------------------------
// Daemon restart
// ---------------------------------------------------------------------------

export async function runDaemonRestartCommand(args: Extract<DaemonCommandArgs, { action: "restart" }>): Promise<void> {
	const requireBrowserEvidence = args.requireBrowserEvidence
	if (args.dryRun) {
		const startPlan = buildDaemonStartPlan({ ...args, action: "start", requireBrowserEvidence })
		process.stdout.write(JSON.stringify({
			action: "restart",
			target: startPlan.targetCwd,
			dryRun: true,
			stop: buildDaemonStopPlan({ ...args, action: "stop" }),
			start: { command: startPlan.command, commandLine: startPlan.commandLine },
		}, null, "\t") + "\n")
		return
	}
	const stopped = await executeDaemonStop(buildDaemonStopPlan({ ...args, action: "stop" }))
	const started = await executeDaemonStart({ ...args, action: "start", requireBrowserEvidence, maxIterations: args.maxIterations, dryRun: false })
	process.stdout.write(JSON.stringify({
		action: "restart",
		target: resolve(args.targetCwd),
		stopped,
		started,
	}, null, "\t") + "\n")
}

// ---------------------------------------------------------------------------
// Daemon target status
// ---------------------------------------------------------------------------

export async function runDaemonTargetStatusCommand(args: Extract<DaemonCommandArgs, { action: "status" }>): Promise<void> {
	const status = await buildDaemonTargetStatus(args)
	process.stdout.write(JSON.stringify(status, null, "\t") + "\n")
}

async function buildDaemonTargetStatus(args: Extract<DaemonCommandArgs, { action: "status" }>): Promise<DaemonTargetStatusResult> {
	const target = resolve(args.targetCwd)
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const fallbackChainName = defaultChainNameForTarget(target)
	const daemonProbe = await probeDaemon(defaults.socketPath)
	if (!daemonProbe.reachable) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName: fallbackChainName,
			daemon: { ok: false, error: daemonProbe.error },
			chain: null,
			chainError: daemonProbe.error,
			items: [],
			slots: [],
		}
	}
	const daemon = daemonProbe.response
	let chainName = fallbackChainName
	try {
		chainName = await resolveDaemonChainNameForTarget(defaults.socketPath, target, fallbackChainName)
	} catch (error) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName: fallbackChainName,
			daemon,
			chain: null,
			chainError: errorMessage(error),
			items: [],
			slots: [],
		}
	}
	const chainResponse = await sendDaemonRequest(defaults.socketPath, { cmd: "chain.get", chain: chainName })
	if (!chainResponse.ok) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName,
			daemon,
			chain: null,
			chainError: chainResponse.error,
			items: [],
			slots: [],
		}
	}
	const chain = requireJsonObject(chainResponse.data, "chain.get")
	const items = await listDaemonItemsForTarget(defaults.socketPath, chainName, target)
	const slotResponse = await sendDaemonRequest(defaults.socketPath, { cmd: "slot.list" })
	const allSlots = slotResponse.ok && Array.isArray(slotResponse.data) ? slotResponse.data : []
	const slots = allSlots.filter((slot) => daemonSlotMatchesTarget(slot, chain, target))
	return {
		action: "status",
		target,
		socketPath: defaults.socketPath,
		chainName,
		daemon,
		chain,
		chainError: null,
		items,
		slots,
	}
}

// ---------------------------------------------------------------------------
// Daemon state import
// ---------------------------------------------------------------------------

async function importTargetStateViaDaemon(args: Extract<DaemonCommandArgs, { action: "start" }>, socketPath: string): Promise<DaemonTargetImportResult> {
	const options = await loadLoopOptionsForTarget(args.targetCwd, args.configPath, args.repository)
	const targetCwd = options.targetCwd
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const chainName = await resolveDaemonChainNameForTarget(
		socketPath,
		targetCwd,
		defaultMigratedChainName(targetCwd, options.repository),
	)
	const trace: DaemonTargetImportTrace[] = []
	const db = openStateDb(defaults.dbPath)
	try {
		const result = await migrateStateJson(targetCwd, db, {
			rootDir: defaults.rootDir,
			statePath: legacyStatePathForDaemonImport(options),
			chainName,
			preset: options.preset.name,
			repository: options.repository,
			baseBranch: options.baseBranch,
			allowMissingState: true,
			onDuplicate: "update",
			backupState: true,
		})
		trace.push({ cmd: "chain.upsert", ok: true })
		for (const item of result.items) trace.push({ cmd: result.itemsUpdated > 0 ? "item.upsert" : "item.add", issue: item.issue, ok: true })
		for (const skipped of result.skipped) {
			const entry: DaemonTargetImportTrace = { cmd: "item.skip", ok: true }
			if (skipped.issue !== null) entry.issue = skipped.issue
			trace.push(entry)
		}
		return {
			chainName: result.chain.name,
			chain: result.chain as unknown as JsonObject,
			legacyStatePath: result.legacyStatePath,
			legacyStateFound: result.legacyStateFound,
			itemsSeen: result.itemsSeen,
			imported: result.itemsInserted,
			updated: result.itemsUpdated,
			skipped: result.skipped.length,
			trace,
		}
	} finally {
		db.close()
	}
}

async function readDaemonChainIfExists(socketPath: string, chainName: string): Promise<JsonObject | null> {
	const response = await sendDaemonRequest(socketPath, { cmd: "chain.get", chain: chainName })
	if (!response.ok) return null
	return isJsonObject(response.data) ? response.data : null
}

// ---------------------------------------------------------------------------
// Queue unblock
// ---------------------------------------------------------------------------

export async function runQueueUnblockCommand(args: QueueUnblockCommandArgs): Promise<void> {
	const options = await loadLoopOptionsForTarget(args.targetCwd, args.configPath, args.repository)
	assertQueueUnblockSupported(options.preset)
	const issue = normalizeQueueIssueId(args.issue)
	const state = await loadState(options.statePath)
	const mutation = requeueBlockedItem(state, options.preset, issue)
	if (!mutation.changed && mutation.reason === "not_found") {
		fail(`queue unblock: issue ${issue} not found in ${options.statePath}`)
	}

	let daemon: QueueUnblockCommandResult["daemon"]
	if (!mutation.changed) {
		daemon = { requested: false, skipped: true, reason: "no_requeue_needed" }
	} else if (!args.startDaemon) {
		daemon = { requested: false, skipped: true, reason: "not_requested" }
	} else if (args.dryRun) {
		daemon = {
			requested: true,
			dryRun: true,
			plan: buildDaemonStartPlan({
				action: "start",
				targetCwd: options.targetCwd,
				configPath: args.configPath,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: true,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				ipc: defaultDaemonIpcOptions(),
			}),
		}
	} else {
		await saveState(options.statePath, state)
		daemon = {
			requested: true,
			dryRun: false,
			result: await executeDaemonStart({
				action: "start",
				targetCwd: options.targetCwd,
				configPath: args.configPath,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: false,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				ipc: defaultDaemonIpcOptions(),
			}),
		}
	}

	if (mutation.changed && !args.dryRun && !args.startDaemon) {
		await saveState(options.statePath, state)
	}

	const verificationState = args.dryRun ? state : await loadState(options.statePath)
	const item = findQueueItemById(verificationState, options.preset, issue)
	const statusSnapshot = await buildCoderLoopStatusSnapshot({
		targetCwd: options.targetCwd,
		configPath: args.configPath,
		repository: options.repository,
		output: "json",
	})
	const daemonRunning = daemonResultIndicatesRunning(daemon) || findOwnedLiveProcess(statusSnapshot) !== null
	const result: QueueUnblockCommandResult = {
		action: "queue.unblock",
		target: options.targetCwd,
		repository: options.repository,
		statePath: options.statePath,
		issue,
		dryRun: args.dryRun,
		mutation,
		daemon,
		verification: {
			itemStatus: item?.status ?? null,
			blockerRepoPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRepo"),
			blockerRefPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRef"),
			stateKind: statusSnapshot.state.kind,
			daemonRunning,
		},
	}
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function daemonResultIndicatesRunning(daemon: QueueUnblockCommandResult["daemon"]): boolean {
	if (!daemon.requested) return false
	if (daemon.dryRun) return false
	return daemon.result.status.daemon.ok
}

export function normalizeQueueIssueId(raw: string): string {
	const trimmed = raw.trim()
	if (trimmed === "") fail("queue unblock: --issue must not be empty")
	if (/\s/.test(trimmed)) fail(`queue unblock: --issue must not contain whitespace: ${raw}`)
	const crossRepoMatch = /^[^/\s]+\/[^#\s]+#(.+)$/.exec(trimmed)
	const value = crossRepoMatch ? crossRepoMatch[1]! : trimmed
	const normalized = value.startsWith("#") ? value.slice(1) : value
	if (normalized.trim() === "") fail(`queue unblock: --issue did not include an issue id: ${raw}`)
	return normalized
}

export function requeueBlockedItem(state: LoopState, preset: Preset, issue: string): QueueUnblockMutationOutcome {
	const item = findQueueItemById(state, preset, issue)
	if (item === null) return { changed: false, issue, reason: "not_found" }
	if (item.status !== "blocked") return { changed: false, issue, reason: "not_blocked", status: item.status }

	const clearedBlockerRepo = hasOwnJsonKey(item.extra, "blockerRepo")
	const clearedBlockerRef = hasOwnJsonKey(item.extra, "blockerRef")
	item.status = "queued"
	delete item.extra.blockerRepo
	delete item.extra.blockerRef

	let clearedCurrent = false
	if (state.current !== null) {
		try {
			if (getCurrentId(state.current, preset) === issue) {
				state.current = null
				clearedCurrent = true
			}
		} catch {
			// Leave unrelated malformed current state for the runtime checker to report.
		}
	}

	return {
		changed: true,
		issue,
		beforeStatus: "blocked",
		afterStatus: "queued",
		clearedBlockerRepo,
		clearedBlockerRef,
		clearedCurrent,
	}
}

// ---------------------------------------------------------------------------
// loadLoopOptionsForTarget
// ---------------------------------------------------------------------------

async function loadLoopOptionsForTarget(targetCwdInput: string, configPathInput: string | null, repository: string | null): Promise<LoopOptions> {
	const targetCwd = resolve(targetCwdInput)
	const configPath = await resolveConfigPath(targetCwd, configPathInput)
	const config = await loadConfig(configPath)
	const presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	return buildOptions(targetCwd, configPath, makeStatusRawArgs({
		targetCwd,
		configPath: configPathInput,
		repository,
		output: "json",
	}), config, preset)
}

function assertQueueUnblockSupported(preset: Preset): void {
	if (!preset.statuses.terminal.includes("blocked") || !preset.statuses.continuable.includes("queued")) {
		fail(`queue unblock: preset "${preset.name}" must declare terminal status "blocked" and continuable status "queued"`)
	}
}
