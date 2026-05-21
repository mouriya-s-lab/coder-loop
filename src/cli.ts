/**
 * CLI subcommand handlers for coder-loop.
 *
 * Handles all user-facing CLI dispatch: chain, item, migrate, status, daemon,
 * queue, and install/doctor subcommands.  The engine loop itself stays in
 * loop.ts — this module only owns the CLI surface.
 */

import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { command, flag, option, optional, positional, run as runCmd, string as cmdString, subcommands } from "cmd-ts"

import {
	daemonDefaults,
	sendDaemonRequest,
	startDaemonServer,
	type DaemonResponse,
	type DaemonServerOptions,
} from "./daemon"

import { dispatchSubcommand } from "./install-commands"

import {
	chainRuntimePaths,
	defaultChainNameForTarget,
	ensureChainRuntimeSkeleton,
	loopDataRootPaths,
} from "./runtime-paths"

import { defaultMigratedChainName, migrateStateJson, type StateJsonMigrationResult } from "./state-migration"

import { openStateDb, openStateStore, type Chain, type Item, type ItemPatch, type NewItem, type StateStore } from "./state-db"

import {
	buildCoderLoopStatusSnapshot,
	readRuntimeState,
	stringifyStatusSnapshot,
	StatusSnapshotBoundary,
	type StatusStateKind,
} from "./status"

import {
	buildDaemonStartPlan,
	runDaemonRestartCommand,
	runDaemonStartCommand,
	runDaemonStopCommand,
	runDaemonTargetStatusCommand,
	runQueueUnblockCommand,
	type DaemonStartPlan,
} from "./daemon-client"

import {
	errorMessage,
	fail,
	isJsonObject,
	isJsonValue,
	isObjectRecord,
	type JsonObject,
	type JsonValue,
} from "./util"

import type {
	DaemonCommandArgs,
	DaemonTargetIpcOptions,
	QueueUnblockCommandArgs,
	RawArgs,
	StatusCommandArgs,
} from "./loop"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CliCommand =
	| { kind: "status"; args: StatusCommandArgs }
	| { kind: "daemon"; args: DaemonCommandArgs }
	| { kind: "queue"; args: QueueUnblockCommandArgs }

type StoreCliOptions = {
	json: boolean
	rootDir: string | null
	dbPath: string | null
	socketPath: string | null
}

type ResolvedStoreCliOptions = {
	json: boolean
	rootDir: string
	dbPath: string
	socketPath: string
}

type ChainStatusReport = {
	chain: Chain
	items: {
		total: number
		byStatus: Record<string, number>
	}
	slots: JsonValue[]
	daemon: { ok: boolean; error: string | null }
}

type MigrateCliOptions = {
	targetCwd: string
	json: boolean
	rootDir: string | null
	dbPath: string | null
	configPath: string | null
	statePath: string | null
	chainName: string | null
	repository: string | null
	baseBranch: string | null
	allowMissingState: boolean
}

type DaemonClientArgs = {
	socketPath: string
	json: boolean
}

// ---------------------------------------------------------------------------
// Flag parsing helpers
// ---------------------------------------------------------------------------

function splitFlag(arg: string): [string, string | null] {
	const equalsIndex = arg.indexOf("=")
	if (equalsIndex === -1) return [arg, null]
	return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)]
}

function readFlagValue(args: string[], index: number, inlineValue: string | null, name: string): string {
	if (inlineValue !== null) return inlineValue
	const value = args[index + 1]
	if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`)
	return value
}

function rejectInlineValue(value: string | null, name: string): void {
	if (value !== null) fail(`${name} does not accept a value`)
}

// ---------------------------------------------------------------------------
// parseArgs — engine raw argument parser
// ---------------------------------------------------------------------------

export function parseArgs(): RawArgs {
	const raw: RawArgs = {
		maxIterations: null,
		targetCwd: null,
		configPath: null,
		workflowPath: null,
		statePath: null,
		repository: null,
		chainName: null,
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
		worktree: false,
		baseBranch: null,
	}

	const args = process.argv.slice(2)
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing argument at index ${index}`)
		if (/^\d+$/.test(arg)) {
			raw.maxIterations = parseInt(arg, 10)
			continue
		}

		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--target-cwd":
				raw.targetCwd = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--config":
				raw.configPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--workflow":
				raw.workflowPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--state":
				raw.statePath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--repo":
				raw.repository = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--chain":
				raw.chainName = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--require-browser-evidence":
				rejectInlineValue(inlineValue, name)
				raw.requireBrowserEvidence = true
				break
			case "--once":
				rejectInlineValue(inlineValue, name)
				raw.once = true
				break
			case "--dry-run":
				rejectInlineValue(inlineValue, name)
				raw.dryRun = true
				break
			case "--check-runtime":
				rejectInlineValue(inlineValue, name)
				raw.checkRuntime = true
				break
			case "--worktree":
				rejectInlineValue(inlineValue, name)
				raw.worktree = true
				break
			case "--base-branch":
				raw.baseBranch = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			default:
				fail(`Unknown argument: ${arg}`)
		}
	}

	return raw
}

// ---------------------------------------------------------------------------
// cmd-ts command definitions
// ---------------------------------------------------------------------------

const statusCliCommand = command({
	name: "status",
	description: "Emit a read-only coder-loop runtime snapshot.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("status: only --json output is supported for now. Usage: coder-loop status <target> --json")
		return {
			kind: "status",
			args: {
				targetCwd: args.target,
				configPath: args.config ?? null,
				repository: args.repo ?? null,
				output: "json",
			},
		}
	},
})

const daemonStatusCliCommand = command({
	name: "status",
	description: "Emit daemon ownership and runtime status for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("daemon status: only --json output is supported for now. Usage: coder-loop daemon status <target> --json")
		return {
			kind: "daemon",
			args: {
				action: "status",
				targetCwd: args.target,
				configPath: args.config ?? null,
				repository: args.repo ?? null,
				output: "json",
				ipc: daemonIpcOptionsFromArgs(args),
			},
		}
	},
})

const daemonStartCliCommand = command({
	name: "start",
	description: "Start coder-loop as a detached daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
		pid: option({ long: "pid", type: optional(cmdString) }),
		db: option({ long: "db", type: optional(cmdString) }),
		root: option({ long: "root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		noSpawnAgents: flag({ long: "no-spawn-agents" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "start",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonStopCliCommand = command({
	name: "stop",
	description: "Stop the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		socket: option({ long: "socket", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "stop",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			dryRun: args.dryRun,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonRestartCliCommand = command({
	name: "restart",
	description: "Restart the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
		pid: option({ long: "pid", type: optional(cmdString) }),
		db: option({ long: "db", type: optional(cmdString) }),
		root: option({ long: "root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		noSpawnAgents: flag({ long: "no-spawn-agents" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "restart",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonCliCommand = subcommands({
	name: "daemon",
	description: "Manage coder-loop daemon processes.",
	cmds: {
		status: daemonStatusCliCommand,
		start: daemonStartCliCommand,
		stop: daemonStopCliCommand,
		restart: daemonRestartCliCommand,
	},
})

const queueUnblockCliCommand = command({
	name: "unblock",
	description: "Requeue one blocked item and clear its blocker metadata.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		startDaemon: flag({ long: "start-daemon" }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		dryRun: flag({ long: "dry-run" }),
	},
	handler: (args): CliCommand => ({
		kind: "queue",
		args: {
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			issue: args.issue,
			startDaemon: args.startDaemon,
			requireBrowserEvidence: args.requireBrowserEvidence,
			dryRun: args.dryRun,
		},
	}),
})

const queueCliCommand = subcommands({
	name: "queue",
	description: "Operate on coder-loop queue state through checked runtime APIs.",
	cmds: {
		unblock: queueUnblockCliCommand,
	},
})

// ---------------------------------------------------------------------------
// Store CLI helpers
// ---------------------------------------------------------------------------

function defaultStoreCliOptions(): StoreCliOptions {
	return { json: false, rootDir: null, dbPath: null, socketPath: null }
}

function parseStoreCliOnlyArgs(label: string, args: string[]): StoreCliOptions {
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing ${label} argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (!readStoreCliFlag(options, args, index, flagName, inlineValue)) fail(`${label}: unknown argument ${arg}`)
		if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
	}
	return options
}

function readStoreCliFlag(options: StoreCliOptions, args: string[], index: number, name: string, inlineValue: string | null): boolean {
	switch (name) {
		case "--json":
			rejectInlineValue(inlineValue, name)
			options.json = true
			return true
		case "--root":
			options.rootDir = readFlagValue(args, index, inlineValue, name)
			return true
		case "--db":
			options.dbPath = readFlagValue(args, index, inlineValue, name)
			return true
		case "--socket":
			options.socketPath = readFlagValue(args, index, inlineValue, name)
			return true
		default:
			return false
	}
}

function storeCliFlagNeedsValue(name: string): boolean {
	return name === "--root" || name === "--db" || name === "--socket"
}

function resolveStoreCliOptions(options: StoreCliOptions): ResolvedStoreCliOptions {
	const root = loopDataRootPaths(options.rootDir)
	return {
		json: options.json,
		rootDir: root.rootDir,
		dbPath: resolve(options.dbPath ?? root.stateDbPath),
		socketPath: resolve(options.socketPath ?? root.daemonSocketPath),
	}
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

function parseUmbrellaRef(value: string): { repo: string; issue: number } {
	const match = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(value)
	if (match === null) fail(`--umbrella must be <owner/repo#N>, got: ${value}`)
	return { repo: match[1]!, issue: parsePositiveInteger(match[2]!, "--umbrella issue") }
}

function parsePositiveInteger(value: string, label: string): number {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer, got: ${value}`)
	return parsed
}

function parsePriority(value: string): string {
	if (value !== "high" && value !== "medium" && value !== "low") fail(`--priority must be high, medium, or low, got: ${value}`)
	return value
}

function parseJsonObjectFlag(value: string, label: string): JsonObject {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch (error) {
		fail(`${label} must be a JSON object: ${errorMessage(error)}`)
	}
	if (!isJsonObject(parsed)) fail(`${label} must be a JSON object`)
	return parsed
}

function parseDaemonMaxIterations(value: string | null): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`--max-iterations must be a positive integer, got: ${value}`)
	return parsed
}

function parseDaemonSchedulerIntervalMs(value: string | null): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`--scheduler-interval-ms must be a positive integer, got: ${value}`)
	return parsed
}

function daemonIpcOptionsFromArgs(args: {
	socket?: string | undefined
	pid?: string | undefined
	db?: string | undefined
	root?: string | undefined
	schedulerIntervalMs?: string | undefined
	noSpawnAgents?: boolean | undefined
}): DaemonTargetIpcOptions {
	return {
		socketPath: args.socket ?? null,
		pidPath: args.pid ?? null,
		dbPath: args.db ?? null,
		rootDir: args.root ?? null,
		schedulerIntervalMs: parseDaemonSchedulerIntervalMs(args.schedulerIntervalMs ?? null),
		spawnAgents: args.noSpawnAgents === true ? false : true,
	}
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function writeJson(value: unknown): void {
	process.stdout.write(JSON.stringify(value, null, "\t") + "\n")
}

function formatChainListLine(chain: Chain): string {
	const umbrella = chain.umbrellaRepo === null || chain.umbrellaIssue === null ? "" : ` umbrella=${chain.umbrellaRepo}#${chain.umbrellaIssue}`
	return `${chain.name}\tstatus=${chain.status}\tpreset=${chain.preset}\trepo=${chain.repository ?? "<none>"}${umbrella}`
}

function formatChainStatusReport(report: ChainStatusReport): string {
	const chain = report.chain
	const stats = Object.keys(report.items.byStatus).sort().map((status) => `${status}=${report.items.byStatus[status]}`).join(", ") || "none"
	return [
		`Chain: ${chain.name}`,
		`Preset: ${chain.preset}`,
		`Repository: ${chain.repository ?? "<none>"}`,
		`Status: ${chain.status}`,
		`Completed at: ${chain.completedAt ?? "<none>"}`,
		`Umbrella: ${chain.umbrellaRepo === null || chain.umbrellaIssue === null ? "<none>" : `${chain.umbrellaRepo}#${chain.umbrellaIssue}`}`,
		`Items: total=${report.items.total}${stats === "none" ? "" : `, ${stats}`}`,
		`Active slots: ${report.slots.length === 0 ? "none" : String(report.slots.length)}`,
		"",
	].join("\n")
}

function formatItemListLine(item: Item): string {
	return `${item.id}\tissue=${item.issue}\tstatus=${item.status}\tpriority=${item.priority}\trepoCwd=${item.repoCwd}`
}

function migrationResultJson(result: StateJsonMigrationResult, dbPath: string): JsonObject {
	return {
		chain: result.chain as unknown as JsonObject,
		items: result.items as unknown as JsonValue[],
		runs: result.runs as unknown as JsonValue[],
		skipped: result.skipped as unknown as JsonValue[],
		dbPath,
		legacyStatePath: result.legacyStatePath,
		legacyStateFound: result.legacyStateFound,
		legacyConfigPath: result.legacyConfigPath,
		legacySharedPath: result.legacySharedPath,
		backupPath: result.backupPath,
		chainDir: result.chainDir,
		itemsSeen: result.itemsSeen,
		itemsInserted: result.itemsInserted,
		itemsUpdated: result.itemsUpdated,
		runsSeen: result.runsSeen,
		runsInserted: result.runsInserted,
		copied: result.copied,
	}
}

// ---------------------------------------------------------------------------
// Chain status report builder
// ---------------------------------------------------------------------------

async function buildChainStatusReport(store: StateStore, chain: Chain, socketPath: string): Promise<ChainStatusReport> {
	const items = store.listItems(chain.id)
	const byStatus: Record<string, number> = {}
	for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const daemon = await readDaemonSlotsForChain(socketPath, chain.id)
	return {
		chain,
		items: { total: items.length, byStatus },
		slots: daemon.slots,
		daemon: { ok: daemon.ok, error: daemon.error },
	}
}

async function readDaemonSlotsForChain(socketPath: string, chainId: number): Promise<{ ok: boolean; error: string | null; slots: JsonValue[] }> {
	try {
		const response = await sendDaemonRequest(socketPath, { cmd: "daemon.status" }, 500)
		if (!response.ok) return { ok: false, error: response.error, slots: [] }
		if (!isObjectRecord(response.data)) return { ok: false, error: "daemon.status returned non-object data", slots: [] }
		const slots = Array.isArray(response.data.slots)
			? response.data.slots.filter((slot) => isObjectRecord(slot) && slot.chainId === chainId)
			: []
		return { ok: true, error: null, slots }
	} catch (error) {
		return { ok: false, error: errorMessage(error), slots: [] }
	}
}

// ---------------------------------------------------------------------------
// Chain subcommand handlers
// ---------------------------------------------------------------------------

async function runChainCommand(args: string[]): Promise<void> {
	const subcommand = args[0]
	if (subcommand === "create") {
		await runChainCreateCommand(args.slice(1))
		return
	}
	if (subcommand === "list") {
		await runChainListCommand(args.slice(1))
		return
	}
	if (subcommand === "status") {
		await runChainStatusCommand(args.slice(1))
		return
	}
	if (subcommand === "delete") {
		await runChainDeleteCommand(args.slice(1))
		return
	}
	fail(`chain: unknown subcommand "${subcommand ?? ""}". Usage: coder-loop chain create|list|status|delete`)
}

async function runChainCreateCommand(args: string[]): Promise<void> {
	let name: string | null = null
	let preset: string | null = null
	let repository: string | null = null
	let baseBranch: string | null = null
	let umbrellaRepo: string | null = null
	let umbrellaIssue: number | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain create argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--preset":
				preset = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--repo":
				repository = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--base-branch":
				baseBranch = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--umbrella": {
				const parsed = parseUmbrellaRef(readFlagValue(args, index, inlineValue, flagName))
				umbrellaRepo = parsed.repo
				umbrellaIssue = parsed.issue
				if (inlineValue === null) index++
				break
			}
			default:
				if (arg.startsWith("--")) fail(`chain create: unknown argument ${arg}`)
				if (name !== null) fail(`chain create: extra chain name "${arg}"`)
				name = arg
		}
	}
	if (name === null) fail("chain create: missing name. Usage: coder-loop chain create <name> --preset <preset> [--repo <owner/repo>] [--base-branch <branch>] [--umbrella <owner/repo#N>]")
	if (preset === null) fail("chain create: missing --preset")
	const resolved = resolveStoreCliOptions(options)
	const chainPaths = chainRuntimePaths(resolved.rootDir, name)
	await ensureChainRuntimeSkeleton(chainPaths)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.upsertChain(name, preset, repository, baseBranch, umbrellaIssue, umbrellaRepo)
		if (resolved.json) writeJson(chain)
		else process.stdout.write(`Chain ${chain.name} created: preset=${chain.preset}, status=${chain.status}, db=${resolved.dbPath}\n`)
	} finally {
		store.close()
	}
}

async function runChainListCommand(args: string[]): Promise<void> {
	const options = parseStoreCliOnlyArgs("chain list", args)
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chains = store.listChains()
		if (resolved.json) writeJson(chains)
		else process.stdout.write(chains.length === 0 ? "No chains.\n" : chains.map(formatChainListLine).join("\n") + "\n")
	} finally {
		store.close()
	}
}

async function runChainStatusCommand(args: string[]): Promise<void> {
	let name: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain status argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (arg.startsWith("--")) fail(`chain status: unknown argument ${arg}`)
		if (name !== null) fail(`chain status: extra chain name "${arg}"`)
		name = arg
	}
	if (name === null) fail("chain status: missing name. Usage: coder-loop chain status <name> [--json]")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(name)
		if (chain === null) fail(`chain status: chain not found: ${name}`)
		const refreshed = chain.status === "active" && store.allItemsTerminal(chain.id)
			? store.completeChain(chain.id)
			: chain
		const report = await buildChainStatusReport(store, refreshed, resolved.socketPath)
		if (resolved.json) writeJson(report)
		else process.stdout.write(formatChainStatusReport(report))
	} finally {
		store.close()
	}
}

async function runChainDeleteCommand(args: string[]): Promise<void> {
	let name: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain delete argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (arg.startsWith("--")) fail(`chain delete: unknown argument ${arg}`)
		if (name !== null) fail(`chain delete: extra chain name "${arg}"`)
		name = arg
	}
	if (name === null) fail("chain delete: missing name. Usage: coder-loop chain delete <name>")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	let chain: Chain | null = null
	try {
		chain = store.getChain(name)
		if (chain === null) fail(`chain delete: chain not found: ${name}`)
		store.deleteChain(chain.id)
	} finally {
		store.close()
	}
	await rm(chainRuntimePaths(resolved.rootDir, name).chainDir, { recursive: true, force: true })
	if (resolved.json) writeJson({ deleted: true, chain: name })
	else process.stdout.write(`Chain ${name} deleted.\n`)
}

// ---------------------------------------------------------------------------
// Item subcommand handlers
// ---------------------------------------------------------------------------

async function runItemCommand(args: string[]): Promise<void> {
	const subcommand = args[0]
	if (subcommand === "add") {
		await runItemAddCommand(args.slice(1))
		return
	}
	if (subcommand === "list") {
		await runItemListCommand(args.slice(1))
		return
	}
	if (subcommand === "update") {
		await runItemUpdateCommand(args.slice(1))
		return
	}
	fail(`item: unknown subcommand "${subcommand ?? ""}". Usage: coder-loop item add|list|update`)
}

async function runItemAddCommand(args: string[]): Promise<void> {
	let chainName: string | null = null
	let issue: number | null = null
	let repoCwd: string | null = null
	let status: string | undefined
	let priority: string | undefined
	let extra: JsonObject | undefined
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item add argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--issue":
				issue = parsePositiveInteger(readFlagValue(args, index, inlineValue, flagName), "--issue")
				if (inlineValue === null) index++
				break
			case "--repo-cwd":
				repoCwd = resolve(readFlagValue(args, index, inlineValue, flagName))
				if (inlineValue === null) index++
				break
			case "--status":
				status = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--priority":
				priority = parsePriority(readFlagValue(args, index, inlineValue, flagName))
				if (inlineValue === null) index++
				break
			case "--extra":
				extra = parseJsonObjectFlag(readFlagValue(args, index, inlineValue, flagName), "--extra")
				if (inlineValue === null) index++
				break
			default:
				if (arg.startsWith("--")) fail(`item add: unknown argument ${arg}`)
				if (chainName !== null) fail(`item add: extra chain name "${arg}"`)
				chainName = arg
		}
	}
	if (chainName === null) fail("item add: missing chain. Usage: coder-loop item add <chain> --issue <N> --repo-cwd <path>")
	if (issue === null) fail("item add: missing --issue")
	if (repoCwd === null) fail("item add: missing --repo-cwd")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(chainName)
		if (chain === null) fail(`item add: chain not found: ${chainName}`)
		const newItem: NewItem = { issue, repoCwd }
		if (status !== undefined) newItem.status = status
		if (priority !== undefined) newItem.priority = priority
		if (extra !== undefined) newItem.extra = extra
		const item = store.addItem(chain.id, newItem)
		if (resolved.json) writeJson(item)
		else process.stdout.write(`Item ${item.id} added: chain=${chainName}, issue=${item.issue}, status=${item.status}, repoCwd=${item.repoCwd}\n`)
	} finally {
		store.close()
	}
}

async function runItemListCommand(args: string[]): Promise<void> {
	let chainName: string | null = null
	let status: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item list argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (flagName === "--status") {
			status = readFlagValue(args, index, inlineValue, flagName)
			if (inlineValue === null) index++
			continue
		}
		if (arg.startsWith("--")) fail(`item list: unknown argument ${arg}`)
		if (chainName !== null) fail(`item list: extra chain name "${arg}"`)
		chainName = arg
	}
	if (chainName === null) fail("item list: missing chain. Usage: coder-loop item list <chain> [--status <status>] [--json]")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(chainName)
		if (chain === null) fail(`item list: chain not found: ${chainName}`)
		const items = store.listItems(chain.id, status)
		if (resolved.json) writeJson(items)
		else process.stdout.write(items.length === 0 ? "No items.\n" : items.map(formatItemListLine).join("\n") + "\n")
	} finally {
		store.close()
	}
}

async function runItemUpdateCommand(args: string[]): Promise<void> {
	let itemId: number | null = null
	let status: string | undefined
	let extra: JsonObject | undefined
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item update argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--status":
				status = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--extra":
				extra = parseJsonObjectFlag(readFlagValue(args, index, inlineValue, flagName), "--extra")
				if (inlineValue === null) index++
				break
			default:
				if (arg.startsWith("--")) fail(`item update: unknown argument ${arg}`)
				if (itemId !== null) fail(`item update: extra item id "${arg}"`)
				itemId = parsePositiveInteger(arg, "item-id")
		}
	}
	if (itemId === null) fail("item update: missing item-id. Usage: coder-loop item update <item-id> --status <status> [--extra '{...}']")
	if (status === undefined && extra === undefined) fail("item update: specify --status and/or --extra")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const existing = store.getItem(itemId)
		if (existing === null) fail(`item update: item not found: ${itemId}`)
		const patch: ItemPatch = {}
		if (status !== undefined) patch.status = status
		if (extra !== undefined) patch.extra = { ...existing.extra, ...extra }
		const item = store.updateItem(itemId, patch)
		if (resolved.json) writeJson(item)
		else process.stdout.write(`Item ${item.id} updated: issue=${item.issue}, status=${item.status}\n`)
	} finally {
		store.close()
	}
}

// ---------------------------------------------------------------------------
// Migrate subcommand handler
// ---------------------------------------------------------------------------

async function runMigrateCommand(args: string[]): Promise<void> {
	const options = parseMigrateCliArgs(args)
	const root = loopDataRootPaths(options.rootDir)
	const dbPath = resolve(options.dbPath ?? root.stateDbPath)
	const db = openStateDb(dbPath)
	try {
		const result = await migrateStateJson(options.targetCwd, db, {
			rootDir: root.rootDir,
			statePath: options.statePath,
			configPath: options.configPath,
			chainName: options.chainName,
			repository: options.repository,
			baseBranch: options.baseBranch,
			allowMissingState: options.allowMissingState,
			onDuplicate: "skip",
			backupState: true,
		})
		if (options.json) {
			writeJson(migrationResultJson(result, dbPath))
		} else {
			process.stdout.write([
				`Migrated legacy state: ${result.legacyStatePath}`,
				`Chain: ${result.chain.name} (${result.chain.status})`,
				`DB: ${dbPath}`,
				`Items: seen=${result.itemsSeen}, inserted=${result.itemsInserted}, updated=${result.itemsUpdated}, skipped=${result.skipped.length}`,
				`Runs: seen=${result.runsSeen}, inserted=${result.runsInserted}`,
				`Shared copied: ${result.copied.shared}`,
				`State backup: ${result.backupPath ?? "<none>"}`,
				"",
			].join("\n"))
		}
	} finally {
		db.close()
	}
}

function parseMigrateCliArgs(args: string[]): MigrateCliOptions {
	let targetCwd: string | null = null
	const options: Omit<MigrateCliOptions, "targetCwd"> = {
		json: false,
		rootDir: null,
		dbPath: null,
		configPath: null,
		statePath: null,
		chainName: null,
		repository: null,
		baseBranch: null,
		allowMissingState: false,
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing migrate argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		switch (flagName) {
			case "--json":
				rejectInlineValue(inlineValue, flagName)
				options.json = true
				break
			case "--root":
				options.rootDir = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--db":
				options.dbPath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--config":
				options.configPath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--state":
				options.statePath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--chain":
				options.chainName = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--repo":
				options.repository = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--base-branch":
				options.baseBranch = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--allow-missing-state":
				rejectInlineValue(inlineValue, flagName)
				options.allowMissingState = true
				break
			default:
				if (arg.startsWith("--")) fail(`migrate: unknown argument ${arg}`)
				if (targetCwd !== null) fail(`migrate: extra target "${arg}"`)
				targetCwd = arg
		}
	}
	if (targetCwd === null) fail("migrate: missing target. Usage: coder-loop migrate <target> [--json] [--root <path>] [--db <path>] [--repo <owner/repo>] [--base-branch <branch>]")
	return { targetCwd: resolve(targetCwd), ...options }
}

// ---------------------------------------------------------------------------
// Status subcommand handler
// ---------------------------------------------------------------------------

async function runStatusCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(statusCliCommand, args)
	if (parsed.kind !== "status") return
	const snapshot = await buildCoderLoopStatusSnapshot(parsed.args)
	StatusSnapshotBoundary.assert(snapshot)
	process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
}

// ---------------------------------------------------------------------------
// Daemon subcommand handlers
// ---------------------------------------------------------------------------

async function runDaemonCommand(args: string[]): Promise<void> {
	const normalizedArgs = normalizeDaemonTargetCwdArgs(args)
	if (normalizedArgs[0] === "up") {
		await runDaemonUpCommand(normalizedArgs.slice(1))
		return
	}
	if (normalizedArgs[0] === "down") {
		await runDaemonDownCommand(normalizedArgs.slice(1))
		return
	}
	if (normalizedArgs[0] === "status" && !daemonStatusArgsIncludeTarget(normalizedArgs.slice(1))) {
		await runGlobalDaemonStatusCommand(normalizedArgs.slice(1))
		return
	}
	const parsed = await runCmd(daemonCliCommand, normalizedArgs)
	if (parsed.value.kind !== "daemon") return
	const daemonArgs = parsed.value.args
	if (daemonArgs.action === "status") {
		await runDaemonTargetStatusCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "start") {
		await runDaemonStartCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "stop") {
		await runDaemonStopCommand(daemonArgs)
		return
	}
	await runDaemonRestartCommand(daemonArgs)
}

function normalizeDaemonTargetCwdArgs(args: string[]): string[] {
	const subcommand = args[0]
	if (subcommand !== "start" && subcommand !== "stop" && subcommand !== "restart" && subcommand !== "status") return args
	let target: string | null = null
	const rest: string[] = []
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		if (name !== "--target-cwd") {
			rest.push(arg)
			continue
		}
		if (target !== null) fail(`daemon ${subcommand}: duplicate --target-cwd`)
		target = readFlagValue(args, index, inlineValue, name)
		if (inlineValue === null) index++
	}
	if (target === null) return args
	if (daemonArgsHavePositionalTarget(rest)) fail(`daemon ${subcommand}: use either positional target or --target-cwd, not both`)
	return [subcommand, target, ...rest]
}

function daemonArgsHavePositionalTarget(args: string[]): boolean {
	const flagsWithValues = new Set(["--config", "--repo", "--socket", "--pid", "--db", "--root", "--scheduler-interval-ms", "--max-iterations", "--base-branch"])
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		const [name, inlineValue] = splitFlag(arg)
		if (name.startsWith("--")) {
			if (inlineValue === null && flagsWithValues.has(name)) index++
			continue
		}
		return true
	}
	return false
}

async function runDaemonUpCommand(args: string[]): Promise<void> {
	const options = parseDaemonUpArgs(args)
	const defaults = daemonDefaults(options)
	const handle = await startDaemonServer(options)
	process.stdout.write(JSON.stringify({
		ok: true,
		data: {
			pid: process.pid,
			socketPath: defaults.socketPath,
			pidPath: defaults.pidPath,
			dbPath: defaults.dbPath,
			startedAt: handle.startedAt,
		},
	}, null, "\t") + "\n")
}

async function runGlobalDaemonStatusCommand(args: string[]): Promise<void> {
	const parsed = parseDaemonClientArgs(args)
	if (!parsed.json) fail("daemon status: global daemon status requires --json")
	await writeDaemonClientResponse(await sendDaemonRequest(parsed.socketPath, { cmd: "daemon.status" }))
}

async function runDaemonDownCommand(args: string[]): Promise<void> {
	const parsed = parseDaemonClientArgs(args)
	await writeDaemonClientResponse(await sendDaemonRequest(parsed.socketPath, { cmd: "daemon.shutdown" }))
}

async function writeDaemonClientResponse(response: DaemonResponse): Promise<void> {
	process.stdout.write(JSON.stringify(response, null, "\t") + "\n")
	if (!response.ok) process.exitCode = 1
}

function parseDaemonUpArgs(args: string[]): DaemonServerOptions {
	const options: DaemonServerOptions = {}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon up argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--socket":
				options.socketPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--pid":
				options.pidPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--db":
				options.dbPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--root":
				options.rootDir = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--log-chain":
				options.logChainName = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--scheduler-interval-ms": {
				const value = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				const parsed = Number(value)
				if (!Number.isInteger(parsed) || parsed <= 0) fail(`--scheduler-interval-ms must be a positive integer, got: ${value}`)
				options.schedulerIntervalMs = parsed
				break
			}
			case "--no-spawn-agents":
				rejectInlineValue(inlineValue, name)
				options.spawnAgents = false
				break
			default:
				fail(`daemon up: unknown argument ${arg}`)
		}
	}
	return options
}

function parseDaemonClientArgs(args: string[]): DaemonClientArgs {
	const defaults = daemonDefaults()
	const parsed: DaemonClientArgs = { socketPath: defaults.socketPath, json: false }
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon client argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--socket":
				parsed.socketPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--json":
				rejectInlineValue(inlineValue, name)
				parsed.json = true
				break
			default:
				fail(`daemon: unknown argument ${arg}`)
		}
	}
	return parsed
}

function daemonStatusArgsIncludeTarget(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		const [name, inlineValue] = splitFlag(arg)
		if (name === "--json") continue
		if (name === "--socket") {
			if (inlineValue === null) index++
			continue
		}
		if (arg.startsWith("--")) continue
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Queue subcommand handler
// ---------------------------------------------------------------------------

async function runQueueCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(queueCliCommand, args)
	if (parsed.value.kind !== "queue") return
	await runQueueUnblockCommand(parsed.value.args)
}

// ---------------------------------------------------------------------------
// CLI main — dispatches subcommands, returns true if handled
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<boolean> {
	const firstArg = process.argv[2]
	if (firstArg === "chain") {
		await runChainCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "item") {
		await runItemCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "migrate") {
		await runMigrateCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "status") {
		await runStatusCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "daemon") {
		await runDaemonCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "queue") {
		await runQueueCommand(process.argv.slice(3))
		return true
	}
	if (firstArg === "install" || firstArg === "uninstall" || firstArg === "doctor") {
		const handled = await dispatchSubcommand(firstArg, process.argv.slice(3))
		if (handled) return true
	}
	return false
}
