import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import {
	buildPhaseRunnerSelectionFromChain,
	loadPreset,
	runPresetChainCompleteTriggerPhases,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type JsonObject,
	type JsonValue,
} from "./loop"
import {
	cleanupSchedulerChainWorktrees,
	createSchedulerState,
	defaultSchedulerStatusFromExit,
	listActiveRuns,
	listPendingCloseHandlers,
	schedulerTick,
	type SchedulerCompletedRun,
	type SchedulerOptions,
	type SchedulerSpawnContext,
	type SchedulerState,
} from "./scheduler"
import {
	type ChainRecord,
	type CreateChainInput,
	type CreateItemInput,
	type DependencyWaitReason,
	type ItemRecord,
	listDependencyWaitReasons,
	openSqliteStateStore,
	type RunRecord,
	type SqliteStateStore,
	type UpdateItemInput,
} from "./sqlite-state"
import {
	type LoopDataRootOptions,
	RuntimePathError,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	sanitizeChainName,
} from "./runtime-paths"

export type DaemonCommandName =
	| "chain.create"
	| "chain.list"
	| "chain.status"
	| "chain.delete"
	| "item.add"
	| "item.batchAdd"
	| "item.list"
	| "item.update"
	| "daemon.status"
	| "daemon.down"

export type DaemonRequest = {
	id: string
	command: string
	args: JsonObject
}

export type DaemonResponse =
	| { id: string; ok: true; result: JsonObject }
	| { id: string; ok: false; error: DaemonResponseError }

export type DaemonResponseError = {
	code: string
	message: string
	details?: JsonObject
}

export type CoderLoopDaemonSchedulerConfig = Partial<Omit<SchedulerOptions, "store" | "state">> & {
	enabled?: boolean
	intervalMs?: number
}

export type StartCoderLoopDaemonOptions = LoopDataRootOptions & {
	scheduler?: CoderLoopDaemonSchedulerConfig
	shutdownGraceMs?: number
}

export type CoderLoopDaemonSnapshot = {
	pid: number
	socketPath: string
	pidFile: string
	running: boolean
	shuttingDown: boolean
	schedulerEnabled: boolean
	activeRuns: JsonObject[]
}

type DaemonState = "starting" | "running" | "shutting_down" | "exited"
type UnknownRecord = Record<string, unknown>

const FALLBACK_PENDING_STATUSES = ["queued", "changes_requested"] as const
const FALLBACK_TERMINAL_STATUSES = ["blocked", "moot", "done"] as const
const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const BUNDLED_PRESETS_DIR = resolve(import.meta.dir, "../presets")
const MAX_DAEMON_REQUEST_BYTES = 1_048_576
const MAX_CHAIN_METADATA_BYTES = 16_384
const MAX_CHAIN_METADATA_DEPTH = 8
const MAX_ITEM_EXTRA_BYTES = 16_384
const MAX_ITEM_EXTRA_DEPTH = 8
const MAX_ITEM_TITLE_LENGTH = 1024
const MAX_REPO_CWD_LENGTH = 4096
const MAX_REPOSITORY_REF_LENGTH = 200
const STALE_RECOVERY_FORCE_AFTER_MS = 1_000
const ORPHAN_CHAIN_DIR_PREFIX = ".orphan-"
const RESERVED_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"])
const ITEM_PRIORITY_VALUES = ["low", "medium", "high", "critical"] as const
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const REPOSITORY_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const CHAIN_CREATE_ARG_KEYS = [
	"name",
	"preset",
	"repository",
	"baseBranch",
	"metadata",
	"umbrellaIssue",
	"umbrellaRepo",
	"force",
] as const
const ITEM_ADD_ARG_KEYS = [
	"chainId",
	"chainName",
	"name",
	"issueNumber",
	"repoCwd",
	"title",
	"priority",
	"branch",
	"pr",
	"issueFile",
	"evidenceDir",
	"runner",
	"extra",
	"dependsOn",
] as const
const ITEM_BATCH_ADD_ARG_KEYS = ["chainId", "chainName", "name", "items"] as const
const ITEM_BATCH_ADD_ITEM_KEYS = ITEM_ADD_ARG_KEYS.filter((key) => key !== "chainId" && key !== "chainName" && key !== "name")
const ITEM_UPDATE_SELECTOR_KEYS = ["itemId", "chainId", "chainName", "name", "issueNumber"] as const
const ITEM_UPDATE_FIELD_KEYS = [
	"repoCwd",
	"status",
	"title",
	"priority",
	"branch",
	"pr",
	"issueFile",
	"evidenceDir",
	"runner",
	"extra",
	"dependsOn",
] as const
const ITEM_UPDATE_ARG_KEYS = [...ITEM_UPDATE_SELECTOR_KEYS, "fields", ...ITEM_UPDATE_FIELD_KEYS] as const

export class DaemonError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details: JsonObject = {},
	) {
		super(message)
		this.name = "DaemonError"
	}
}

export class CoderLoopDaemon {
	private readonly paths: ReturnType<typeof resolveLoopDataPaths>
	private readonly schedulerState: SchedulerState = createSchedulerState()
	private readonly sockets = new Set<Socket>()
	private readonly shutdownGraceMs: number
	private server: Server | null = null
	private store: SqliteStateStore | null = null
	private state: DaemonState = "starting"
	private schedulerTimer: ReturnType<typeof setInterval> | null = null
	private schedulerTickInFlight: Promise<void> | null = null
	private schedulerTickRequested = false
	private schedulerPauseDepth = 0
	private ownsDaemonSocket = false
	private ownsDaemonPid = false
	private resolveClosed: (() => void) | null = null
	private readonly daemonBatchTimestamp = formatDaemonBatchTimestamp(new Date())
	readonly closed: Promise<void>

	constructor(private readonly options: StartCoderLoopDaemonOptions = {}) {
		this.paths = resolveLoopDataPaths(options)
		this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000
		this.closed = new Promise((resolveClosed) => {
			this.resolveClosed = resolveClosed
		})
	}

	async start(): Promise<this> {
		if (this.state !== "starting") throw new DaemonError("invalid_state", `daemon cannot start from state ${this.state}`)
		await this.prepareRuntimeDirectory()

		try {
			await removeStaleSocket(this.paths.daemonSocket)
			const server = createServer((socket) => this.acceptConnection(socket))
			this.server = server
			await listenOrReportSocketInUse(server, this.paths.daemonSocket)
			this.ownsDaemonSocket = true
			const store = openSqliteStateStore(this.options)
			this.store = store
			await this.quarantineOrphanChainDirectories()
			await this.ensureRuntimeLayoutForExistingChains()
			await this.recoverStaleSchedulerState()
			await writeFile(this.paths.daemonPid, `${process.pid}\n`)
			this.ownsDaemonPid = true
			this.state = "running"
			await this.appendDaemonLogForAllChains({ type: "daemon.start", pid: process.pid, socketPath: this.paths.daemonSocket })
			this.startSchedulerLoop()
			this.queueSchedulerTick()
			return this
		} catch (error) {
			await this.stopAfterStartFailure()
			throw translateDaemonStartError(error, { socketPath: this.paths.daemonSocket, pidFile: this.paths.daemonPid })
		}
	}

	snapshot(): CoderLoopDaemonSnapshot {
		return {
			pid: process.pid,
			socketPath: this.paths.daemonSocket,
			pidFile: this.paths.daemonPid,
			running: this.state === "running",
			shuttingDown: this.state === "shutting_down",
			schedulerEnabled: this.schedulerEnabled(),
			activeRuns: listActiveRuns(this.schedulerState).map((run) => ({
				runId: run.runId,
				pid: run.pid,
				itemId: run.itemId,
				chainId: run.chainId,
				repoCwd: run.repoCwd,
				worktreePath: run.worktreePath,
				startedAt: run.startedAt,
			})),
		}
	}

	async stop(): Promise<void> {
		if (this.state === "exited") return
		if (this.state !== "shutting_down") this.state = "shutting_down"
		// Pause scheduler tick: clears the interval timer, awaits any in-flight
		// tick, and bumps schedulerPauseDepth so requestSchedulerTick is gated
		// out for the remainder of shutdown. The resume callback would no-op
		// because state is now "shutting_down", so we deliberately discard it.
		await this.pauseSchedulerForMutation()

		// Wait for active children plus pending close handlers to finish before
		// closing SQLite. attachRunCloseHandler may null activeRun before
		// completeChainIfReady finishes so the chain can complete.
		await this.waitForSchedulerQuiescence()

		for (const socket of this.sockets) socket.end()
		if (this.server !== null) {
			await closeServer(this.server)
			this.server = null
		}
		this.store?.close()
		this.store = null
		await this.removeOwnedRuntimeFiles()
		this.state = "exited"
		this.resolveClosed?.()
	}

	private async prepareRuntimeDirectory(): Promise<void> {
		try {
			await mkdir(this.paths.root, { recursive: true })
			await mkdir(this.paths.chainsDir, { recursive: true })
		} catch (error) {
			throw new DaemonError("db_unavailable", `unable to prepare loop-data directory at ${this.paths.root}: ${errorMessage(error)}`, {
				loopDataRoot: this.paths.root,
			})
		}
	}

	private async stopAfterStartFailure(): Promise<void> {
		for (const socket of this.sockets) socket.destroy()
		if (this.server !== null) {
			await closeServer(this.server).catch(() => undefined)
			this.server = null
		}
		this.store?.close()
		this.store = null
		await this.removeOwnedRuntimeFiles()
		this.state = "exited"
		this.resolveClosed?.()
	}

	private async waitForSchedulerQuiescence(): Promise<void> {
		while (true) {
			const activeRuns = listActiveRuns(this.schedulerState)
			const pendingCloseHandlers = listPendingCloseHandlers(this.schedulerState)
			if (activeRuns.length === 0 && pendingCloseHandlers.length === 0) return
			await Promise.all([
				...activeRuns.map((run) => run.closed.catch(() => undefined)),
				...pendingCloseHandlers.map((pendingCloseHandler) => pendingCloseHandler.catch(() => undefined)),
			])
		}
	}

	private async removeOwnedRuntimeFiles(): Promise<void> {
		if (this.ownsDaemonSocket) {
			await unlinkIfExists(this.paths.daemonSocket)
			this.ownsDaemonSocket = false
		}
		if (this.ownsDaemonPid) {
			await unlinkIfExists(this.paths.daemonPid)
			this.ownsDaemonPid = false
		}
	}

	private acceptConnection(socket: Socket): void {
		this.sockets.add(socket)
		socket.setEncoding("utf-8")
		let buffer = ""
		let oversizedRequestRejected = false
		socket.on("data", (chunk: string) => {
			if (oversizedRequestRejected) return
			buffer += chunk
			let newlineIndex = buffer.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				if (line.trim() !== "") void this.handleLine(socket, line)
				newlineIndex = buffer.indexOf("\n")
			}
			if (byteLength(buffer) > MAX_DAEMON_REQUEST_BYTES) {
				oversizedRequestRejected = true
				const actualBytes = byteLength(buffer)
				buffer = ""
				writeOversizedRequestResponse(socket, actualBytes)
			}
		})
		socket.on("close", () => {
			this.sockets.delete(socket)
		})
		socket.on("error", () => {
			this.sockets.delete(socket)
		})
	}

	private async handleLine(socket: Socket, line: string): Promise<void> {
		const response = await this.responseForLine(line)
		socket.write(`${JSON.stringify(response)}\n`)
		if (response.ok && response.result.shutdown === true) {
			socket.end()
			setTimeout(() => {
				void this.stop()
			}, 0)
		}
	}

	private async responseForLine(line: string): Promise<DaemonResponse> {
		let requestId = "unknown"
		try {
			validateRequestLineSize(line)
			const request = parseDaemonRequest(line)
			requestId = request.id
			if (this.state === "starting") {
				throw new DaemonError("daemon_starting", "daemon is still starting; retry after startup recovery completes", {
					state: this.state,
					command: request.command,
				})
			}
			const result = await this.handleRequest(request)
			return { id: request.id, ok: true, result }
		} catch (error) {
			return { id: requestId, ok: false, error: responseError(error) }
		}
	}

	private async handleRequest(request: DaemonRequest): Promise<JsonObject> {
		switch (request.command) {
			case "chain.create":
				return await this.handleChainCreate(request.args)
			case "chain.list":
				return this.handleChainList()
			case "chain.status":
				return await this.handleChainStatus(request.args)
			case "chain.delete":
				return await this.handleChainDelete(request.args)
			case "item.add":
				return await this.handleItemAdd(request.args)
			case "item.batchAdd":
				return await this.handleItemBatchAdd(request.args)
			case "item.list":
				return this.handleItemList(request.args)
			case "item.update":
				return await this.handleItemUpdate(request.args)
			case "daemon.status":
				return { daemon: this.snapshot() as unknown as JsonObject }
			case "daemon.down":
				return { shutdown: true, daemon: this.snapshot() as unknown as JsonObject }
			default:
				throw new DaemonError("unknown_command", `unknown daemon command: ${request.command}`, { command: request.command })
		}
	}

	private async handleChainCreate(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "chain.create args", CHAIN_CREATE_ARG_KEYS)
		const input: CreateChainInput = {
			name: validateChainNameForRequest(requiredString(args, "name")),
			preset: await validateBundledPresetForRequest(optionalString(args, "preset") ?? DEFAULT_PRESET_NAME),
			repository: validateRepositoryForRequest(requiredString(args, "repository")),
			baseBranch: validateBaseBranchForRequest(optionalString(args, "baseBranch") ?? "main"),
			status: "active",
			metadata: validateChainMetadata(sizedJsonObject(args, "metadata", MAX_CHAIN_METADATA_BYTES) ?? {}),
		}
		const umbrellaIssue = validateUmbrellaIssueForRequest(optionalIntegerOrNull(args, "umbrellaIssue"))
		if (umbrellaIssue !== undefined) input.umbrellaIssue = umbrellaIssue
		const umbrellaRepo = optionalStringOrNull(args, "umbrellaRepo")
		if (umbrellaRepo !== undefined) input.umbrellaRepo = umbrellaRepo === null ? null : validateRepositoryRefForRequest(umbrellaRepo, "umbrellaRepo")
		const store = this.requireStore()
		const existing = store.getChainByName(input.name)
		const force = optionalBoolean(args, "force") ?? false
		let chain: ChainRecord
		if (existing === null) {
			chain = store.createChain(input)
		} else {
			if (existing.status === "deleted") {
				if (!force) {
					throw new DaemonError("chain_deleted", `chain ${input.name} is deleted; pass force=true to recreate it`, {
						chainId: existing.id,
						chainName: existing.name,
						status: existing.status,
					})
				}
				store.deleteChain(existing.id)
				chain = store.createChain(input)
			} else {
				const conflicts = chainCreateConflicts(existing, input)
				if (conflicts.length > 0) {
					throw new DaemonError("conflict", `chain ${input.name} already exists with different fields`, {
						chainName: input.name,
						conflicts,
					})
				}
				chain = existing
			}
		}
		await this.ensureChainRuntimeLayout(chain.name)
		await this.appendDaemonLog(chain.name, { type: "chain.layout", chainId: chain.id, chainName: chain.name, state: this.state })
		return { chain: chainToJson(chain) }
	}

	private async ensureChainRuntimeLayout(chainName: string): Promise<void> {
		const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: this.paths.root })
		await mkdir(paths.issuesDir, { recursive: true })
		await mkdir(paths.evidenceDir, { recursive: true })
		await mkdir(paths.runsDir, { recursive: true })
		await mkdir(paths.daemonDir, { recursive: true })
		await mkdir(paths.daemonBatchDir(this.daemonBatchTimestamp), { recursive: true })
		await writeFile(paths.daemonLogFile(this.daemonBatchTimestamp), "", { flag: "a" })
		await writeFile(paths.sharedFile, "# Shared durable context\n\n", { flag: "wx" }).catch((error: unknown) => {
			if (isNodeError(error) && error.code === "EEXIST") return
			throw error
		})
	}

	private async ensureRuntimeLayoutForExistingChains(): Promise<void> {
		for (const chain of this.requireStore().listChains()) {
			if (chain.status === "deleted") continue
			try {
				await this.ensureChainRuntimeLayout(chain.name)
			} catch (error) {
				if (isInvalidChainNameError(error)) {
					this.warnSkippedInvalidChain(chain, error, "startup runtime layout")
					continue
				}
				throw error
			}
		}
	}

	private async quarantineOrphanChainDirectories(): Promise<void> {
		const knownNames = new Set(this.requireStore().listChains().filter((chain) => chain.status !== "deleted").map((chain) => chain.name))
		const orphanRoot = resolve(this.paths.chainsDir, `${ORPHAN_CHAIN_DIR_PREFIX}${this.daemonBatchTimestamp}`)
		let orphanRootCreated = false
		const entries = await readdir(this.paths.chainsDir, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (entry.name.startsWith(ORPHAN_CHAIN_DIR_PREFIX)) continue
			if (knownNames.has(entry.name)) continue
			const source = resolve(this.paths.chainsDir, entry.name)
			const destination = resolve(orphanRoot, entry.name)
			try {
				if (!orphanRootCreated) {
					await mkdir(orphanRoot, { recursive: true })
					orphanRootCreated = true
				}
				await rename(source, destination)
				console.warn(`coder-loop daemon warning: moved orphan chain directory ${entry.name} to ${destination}`)
			} catch (error) {
				console.warn(`coder-loop daemon warning: unable to move orphan chain directory ${entry.name}: ${errorMessage(error)}`)
			}
		}
	}

	private async appendDaemonLogForAllChains(event: JsonObject): Promise<void> {
		for (const chain of this.requireStore().listChains()) {
			await this.appendDaemonLogIfChainNameIsValid(chain, event)
		}
	}

	private async appendDaemonLogForChainId(chainId: number, event: JsonObject): Promise<void> {
		const chain = this.requireStore().getChain(chainId)
		if (chain === null) return
		await this.appendDaemonLogIfChainNameIsValid(chain, event)
	}

	private async appendDaemonLogIfChainNameIsValid(chain: ChainRecord, event: JsonObject): Promise<void> {
		if (chain.status === "deleted") return
		try {
			await this.appendDaemonLog(chain.name, event)
		} catch (error) {
			if (isInvalidChainNameError(error)) return
			throw error
		}
	}

	private async appendDaemonLog(chainName: string, event: JsonObject): Promise<void> {
		const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: this.paths.root })
		await mkdir(paths.daemonBatchDir(this.daemonBatchTimestamp), { recursive: true })
		await appendFile(paths.daemonLogFile(this.daemonBatchTimestamp), `${JSON.stringify({
			...event,
			recordedAt: new Date().toISOString(),
		})}\n`)
	}

	private async recoverStaleSchedulerState(): Promise<void> {
		const store = this.requireStore()
		for (const chain of store.listChains()) {
			if (chain.status === "deleted") continue
			const currentRun = store.getCurrentRun(chain.id)
			if (currentRun === null) continue

			const stalePid = await this.readCurrentRunProcessGroupPid(chain, currentRun.runId, currentRun.extra)
			if (stalePid !== null) await terminateStaleProcessGroup(stalePid, Math.min(this.shutdownGraceMs, STALE_RECOVERY_FORCE_AFTER_MS))

			const midFlightItemId = optionalPositiveInteger(currentRun.extra.itemId)
			const midFlightItem = midFlightItemId !== null ? store.getItem(midFlightItemId) : null
			const itemsToRecover = midFlightItem !== null && midFlightItem.status === "in_progress" ? [midFlightItem] : []

			store.clearCurrentRun(chain.id)
			const recoveredAt = unixSeconds()
			for (const item of itemsToRecover) {
				store.updateItem(item.id, { status: "changes_requested", phase: null, updatedAt: recoveredAt })
			}
			await this.appendDaemonLogIfChainNameIsValid(chain, {
				type: "scheduler.recovery",
				reason: "stale_in_progress",
				chainId: chain.id,
				runId: currentRun.runId,
				pid: stalePid,
				recoveredItems: itemsToRecover.map((item) => ({
					itemId: item.id,
					issueNumber: item.issueNumber,
					fromStatus: "in_progress",
					toStatus: "changes_requested",
				})),
			})
		}
	}

	private async readCurrentRunProcessGroupPid(chain: ChainRecord, runId: string, extra: JsonObject): Promise<number | null> {
		const extraPid = optionalPositiveInteger(extra.pid)
		if (extraPid !== null && extra.processGroupLeader === true) return extraPid
		try {
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: this.paths.root })
			const raw = await readFile(paths.runStatusFile(runId), "utf-8")
			const parsed = parseJsonRecord(raw)
			const statusPid = optionalPositiveInteger(parsed.pid)
			return statusPid !== null && parsed.processGroupLeader === true ? statusPid : null
		} catch {
			return null
		}
	}

	private handleChainList(): JsonObject {
		return { chains: this.requireStore().listChains().map(chainToJson) }
	}

	private async handleChainStatus(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		const items = this.requireStore().listItems(chain.id)
		const activeRuns = listActiveRuns(this.schedulerState).filter((run) => run.chainId === chain.id)
		const pendingStatusSet = await this.continuableItemStatuses(chain)
		const terminalStatusSet = await this.terminalItemStatuses(chain)
		const pendingStatuses = [...pendingStatusSet]
		const terminalStatuses = [...terminalStatusSet]
		const dependencyWaits = listDependencyWaitReasons(items, { statuses: pendingStatuses, terminalStatuses })
		const dependencyWaitsByItemId = new Map(dependencyWaits.map((wait) => [wait.itemId, wait]))
		return {
			chain: chainToJson(chain),
			summary: chainStatusSummary(chain, items, activeRuns, dependencyWaits),
			items: items.map((item) => itemToJson(item, dependencyWaitsByItemId.get(item.id) ?? null)),
			activeRuns: activeRuns.map(activeRunToJson),
		}
	}

	private async handleChainDelete(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		if (chain.status === "deleted") return { chain: chainToJson(chain), alreadyDeleted: true }
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const terminatedRuns = await this.terminateActiveRunsForChain(chain.id)
			const cleanup = await this.cleanupChainRuntime(chain)
			const updated = this.requireStore().updateChain(chain.id, { status: "deleted" })
			return {
				chain: chainToJson(updated),
				alreadyDeleted: false,
				terminatedRuns: terminatedRuns.map(completedRunToJson),
				cleanup,
			}
		} finally {
			resumeScheduler()
		}
	}

	private async terminateActiveRunsForChain(chainId: number): Promise<SchedulerCompletedRun[]> {
		const activeRuns = listActiveRuns(this.schedulerState).filter((run) => run.chainId === chainId)
		return await Promise.all(activeRuns.map((run) => run.terminate({ forceAfterMs: this.shutdownGraceMs })))
	}

	private async terminateActiveRunsForItem(itemId: number): Promise<SchedulerCompletedRun[]> {
		const activeRuns = listActiveRuns(this.schedulerState).filter((run) => run.itemId === itemId)
		return await Promise.all(activeRuns.map((run) => run.terminate({ forceAfterMs: this.shutdownGraceMs })))
	}

	private async cleanupChainRuntime(chain: ChainRecord): Promise<JsonObject> {
		const store = this.requireStore()
		const repoCwds = store.listItems(chain.id).map((item) => item.repoCwd)
		const worktrees = cleanupSchedulerChainWorktrees(chain, repoCwds, { loopDataRoot: this.paths.root })
		try {
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: this.paths.root })
			await rm(paths.chainRoot, { recursive: true, force: true })
			return { chainRoot: paths.chainRoot, chainRootRemoved: true, worktrees: worktrees as unknown as JsonValue }
		} catch (error) {
			if (isInvalidChainNameError(error)) {
				return {
					chainRoot: null,
					chainRootRemoved: false,
					worktrees: worktrees as unknown as JsonValue,
					error: errorMessage(error),
				}
			}
			throw error
		}
	}

	private async handleItemAdd(args: JsonObject): Promise<JsonObject> {
		validateItemAddRequest(args)
		const chain = this.resolveChain(args)
		assertChainAllowsItemMutation(chain, "item.add")
		const store = this.requireStore()
		const existingItems = store.listItems(chain.id)
		const input = await this.buildCreateItemInput(chain, args, existingItems, "item.add")
		const existing = store.getItemByIssue(chain.id, input.issueNumber)
		if (existing !== null) throw duplicateItemAddError(chain, input.issueNumber, existing)
		let item: ItemRecord
		try {
			item = store.createItem(input)
		} catch (error) {
			throw this.translateCreateItemFailure(chain, input.issueNumber, error)
		}
		this.queueSchedulerTick()
		return { item: itemToJson(item) }
	}

	private async handleItemBatchAdd(args: JsonObject): Promise<JsonObject> {
		validateItemBatchAddRequest(args)
		const chain = this.resolveChain(args)
		assertChainAllowsItemMutation(chain, "item.batchAdd")
		const store = this.requireStore()
		const rawItems = requiredJsonObjectArray(args, "items")
		if (rawItems.length === 0) throw new DaemonError("invalid_request", "item.batchAdd requires at least one item", { field: "items" })
		const existingItems = store.listItems(chain.id)
		const inputs: CreateItemInput[] = []
		const requestedIssues = new Set<number>()
		for (const [index, rawItem] of rawItems.entries()) {
			validateKnownKeys(rawItem, `item.batchAdd items[${index}]`, ITEM_BATCH_ADD_ITEM_KEYS)
			const input = await this.buildCreateItemInput(chain, rawItem, existingItems, `items[${index}]`)
			if (requestedIssues.has(input.issueNumber)) {
				throw new DaemonError("conflict", `batch contains duplicate issueNumber ${input.issueNumber}`, { chainId: chain.id, chainName: chain.name, issueNumber: input.issueNumber })
			}
			requestedIssues.add(input.issueNumber)
			const existing = store.getItemByIssue(chain.id, input.issueNumber)
			if (existing !== null) throw duplicateItemAddError(chain, input.issueNumber, existing)
			inputs.push(input)
		}
		let items: ItemRecord[]
		try {
			items = store.createItems(inputs)
		} catch (error) {
			const firstDuplicate = inputs.map((input) => [input.issueNumber, store.getItemByIssue(chain.id, input.issueNumber)] as const).find(([, existing]) => existing !== null)
			if (firstDuplicate !== undefined && firstDuplicate[1] !== null) throw duplicateItemAddError(chain, firstDuplicate[0], firstDuplicate[1])
			throw error
		}
		this.queueSchedulerTick()
		return { items: items.map((item) => itemToJson(item)) }
	}

	private async buildCreateItemInput(chain: ChainRecord, args: JsonObject, existingItems: readonly ItemRecord[], label: string): Promise<CreateItemInput> {
		const rawExtra = sizedJsonObject(args, "extra", MAX_ITEM_EXTRA_BYTES) ?? {}
		const topLevelDependsOn = optionalDependsOn(args, "dependsOn")
		const extraDependsOn = topLevelDependsOn === undefined ? optionalDependsOn(rawExtra, "dependsOn") : undefined
		const dependsOn = topLevelDependsOn === undefined ? extraDependsOn : topLevelDependsOn
		if (dependsOn !== undefined) validateDependsOnGraph(existingItems, null, dependsOn)
		const input: CreateItemInput = {
			chainId: chain.id,
			issueNumber: requiredPositiveInteger(args, "issueNumber"),
			repoCwd: await validateRepoCwdForRequest(requiredString(args, "repoCwd")),
			status: await this.defaultItemStatusForRequest(chain),
			extra: validateItemExtra(withDependsOn(rawExtra, dependsOn)),
		}
		assignOptional(input, "title", validateItemTitleForRequest(optionalStringOrNull(args, "title")))
		assignOptional(input, "priority", validateItemPriorityForRequest(optionalStringOrNull(args, "priority")))
		assignOptional(input, "branch", validateItemBranchForRequest(optionalStringOrNull(args, "branch")))
		assignOptional(input, "pr", validateItemPrForRequest(optionalIntegerOrNull(args, "pr")))
		assignOptional(input, "issueFile", validateRelativeItemPathForRequest(optionalStringOrNull(args, "issueFile"), "issueFile"))
		assignOptional(input, "evidenceDir", validateEvidenceDirForRequest(optionalStringOrNull(args, "evidenceDir"), chain, this.paths.root))
		assignOptional(input, "runner", optionalRunner(args, "runner"))
		return input
	}

	private translateCreateItemFailure(chain: ChainRecord, issueNumber: number, error: unknown): never {
		try {
			const existingAfterFailure = this.requireStore().getItemByIssue(chain.id, issueNumber)
			if (existingAfterFailure !== null) throw duplicateItemAddError(chain, issueNumber, existingAfterFailure)
		} catch (lookupError) {
			if (lookupError instanceof DaemonError) throw lookupError
		}
		throw error
	}

	private handleItemList(args: JsonObject): JsonObject {
		const chain = this.resolveChain(args)
		return { items: this.requireStore().listItems(chain.id).map((item) => itemToJson(item)) }
	}

	private async handleItemUpdate(args: JsonObject): Promise<JsonObject> {
		validateItemUpdateRequest(args)
		const item = this.resolveItem(args)
		const fields = itemUpdateFields(args)
		const store = this.requireStore()
		const chain = store.getChain(item.chainId)
		if (chain === null) throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
		assertChainAllowsItemMutation(chain, "item.update")
		const input: UpdateItemInput = {}
		const repoCwd = optionalString(fields, "repoCwd")
		if (repoCwd !== null) assignOptional(input, "repoCwd", await validateRepoCwdForRequest(repoCwd))
		const status = optionalString(fields, "status")
		if (status !== null) {
			assignOptional(input, "status", await this.validateItemStatusForRequest(chain, status))
		}
		assignOptional(input, "title", validateItemTitleForRequest(optionalStringOrNull(fields, "title")))
		assignOptional(input, "priority", validateItemPriorityForRequest(optionalStringOrNull(fields, "priority")))
		assignOptional(input, "branch", validateItemBranchForRequest(optionalStringOrNull(fields, "branch")))
		assignOptional(input, "pr", validateItemPrForRequest(optionalIntegerOrNull(fields, "pr")))
		assignOptional(input, "issueFile", validateRelativeItemPathForRequest(optionalStringOrNull(fields, "issueFile"), "issueFile"))
		assignOptional(input, "evidenceDir", validateEvidenceDirForRequest(optionalStringOrNull(fields, "evidenceDir"), chain, this.paths.root))
		assignOptional(input, "runner", optionalRunner(fields, "runner"))
		const rawExtra = sizedJsonObject(fields, "extra", MAX_ITEM_EXTRA_BYTES)
		const topLevelDependsOn = optionalDependsOn(fields, "dependsOn")
		const extraDependsOn = topLevelDependsOn === undefined && rawExtra !== undefined ? optionalDependsOn(rawExtra, "dependsOn") : undefined
		const dependsOn = topLevelDependsOn === undefined ? extraDependsOn : topLevelDependsOn
		if (dependsOn !== undefined) {
			validateDependsOnGraph(store.listItems(item.chainId), item.id, dependsOn)
			input.extra = validateItemExtra(withDependsOn(rawExtra ?? item.extra, dependsOn))
		} else {
			assignOptional(input, "extra", rawExtra === undefined ? undefined : validateItemExtra(rawExtra))
		}
		const terminalStatuses = await this.terminalItemStatuses(chain)
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const updated = store.updateItem(item.id, input)
			if (input.status !== undefined && terminalStatuses.has(input.status)) {
				await this.terminateActiveRunsForItem(updated.id)
			}
			return { item: itemToJson(updated) }
		} finally {
			resumeScheduler()
		}
	}

	private resolveChain(args: JsonObject): ChainRecord {
		const store = this.requireStore()
		const chainId = optionalInteger(args, "chainId")
		const chainName = requestedChainName(args)
		if (chainId !== null) {
			const chain = store.getChain(chainId)
			if (chain === null) throw new DaemonError("not_found", `chain ${chainId} was not found`, { chainId })
			if (chainName !== null) {
				const chainByName = store.getChainByName(chainName)
				if (chainByName === null) throw new DaemonError("not_found", `chain ${chainName} was not found`, { chainName })
				if (chainByName.id !== chain.id) {
					throw new DaemonError("invalid_request", "chainId and chainName both provided but point to different chains", {
						chainId,
						chainName,
						chainIdResolvesTo: chain.name,
						chainNameResolvesTo: chainByName.id,
					})
				}
			}
			return chain
		}
		if (chainName !== null) {
			const chain = store.getChainByName(chainName)
			if (chain === null) throw new DaemonError("not_found", `chain ${chainName} was not found`, { chainName })
			return chain
		}
		throw new DaemonError("invalid_request", "request requires chainId or chainName")
	}

	private resolveItem(args: JsonObject): ItemRecord {
		const itemId = optionalInteger(args, "itemId")
		if (itemId !== null) {
			const item = this.requireStore().getItem(itemId)
			if (item === null) throw new DaemonError("not_found", `item ${itemId} was not found`, { itemId })
			return item
		}
		const chain = this.resolveChain(args)
		const issueNumber = requiredPositiveInteger(args, "issueNumber")
		const item = this.requireStore().getItemByIssue(chain.id, issueNumber)
		if (item === null) throw new DaemonError("not_found", `item for issue ${issueNumber} was not found`, { chainId: chain.id, issueNumber })
		return item
	}

	private requireStore(): SqliteStateStore {
		if (this.store === null) throw new DaemonError("daemon_not_running", "daemon store is not open")
		return this.store
	}

	private schedulerEnabled(): boolean {
		return this.options.scheduler?.enabled !== false
	}

	private startSchedulerLoop(): void {
		if (!this.schedulerEnabled()) return
		const intervalMs = this.options.scheduler?.intervalMs ?? 1_000
		this.schedulerTimer = setInterval(() => {
			this.queueSchedulerTick()
		}, intervalMs)
	}

	private async requestSchedulerTick(): Promise<void> {
		if (!this.schedulerEnabled() || this.state !== "running" || this.schedulerPauseDepth > 0) return
		if (this.schedulerTickInFlight !== null) {
			this.schedulerTickRequested = true
			return await this.schedulerTickInFlight
		}
		this.schedulerTickInFlight = this.runSchedulerTicks()
		try {
			await this.schedulerTickInFlight
		} finally {
			this.schedulerTickInFlight = null
		}
	}

	private queueSchedulerTick(): void {
		void this.requestSchedulerTick().catch((error: unknown) => {
			console.warn(`coder-loop daemon warning: scheduler tick failed after IPC ack: ${errorMessage(error)}`)
		})
	}

	private async pauseSchedulerForMutation(): Promise<() => void> {
		this.schedulerPauseDepth += 1
		if (this.schedulerTimer !== null) {
			clearInterval(this.schedulerTimer)
			this.schedulerTimer = null
		}
		await this.schedulerTickInFlight
		let resumed = false
		return () => {
			if (resumed) return
			resumed = true
			this.schedulerPauseDepth -= 1
			if (this.schedulerPauseDepth === 0 && this.state === "running") {
				this.startSchedulerLoop()
				this.queueSchedulerTick()
			}
		}
	}

	private async runSchedulerTicks(): Promise<void> {
		do {
			this.schedulerTickRequested = false
			await schedulerTick(this.buildSchedulerOptions())
		} while (this.schedulerTickRequested && this.state === "running")
	}

	private buildSchedulerOptions(): SchedulerOptions {
		const scheduler = this.options.scheduler ?? {}
		const externalOnEvent = scheduler.onEvent
		const schedulerPresetDir = scheduler.presetDir
		const presetDirForChain = scheduler.presetDirForChain ?? ((chain: ChainRecord) => schedulerPresetDir ?? bundledPresetDirForScheduler(chain))
		const presetPromptResolver = (ctx: SchedulerSpawnContext): Promise<string> =>
			resolveSchedulerPresetPhasePrompt({ presetDir: presetDirForChain(ctx.chain), phase: ctx.phase })
		const fallbackRunner = scheduler.runner ?? defaultDaemonRunner()
		const phaseRunnerSelectionForChain: SchedulerOptions["phaseRunnerSelectionForChain"] = scheduler.phaseRunnerSelectionForChain
			?? (scheduler.phaseRunner !== undefined || scheduler.runner !== undefined
				? undefined
				: async (chain) => {
					const preset = await loadPreset(presetDirForChain(chain))
					return buildPhaseRunnerSelectionFromChain({
						chain,
						loopDataRoot: this.paths.root,
						preset,
					})
				})
		const options: SchedulerOptions = {
			store: this.requireStore(),
			state: this.schedulerState,
			runner: fallbackRunner,
			presetDir: schedulerPresetDir ?? bundledPresetDir(DEFAULT_PRESET_NAME),
			prompt: scheduler.prompt ?? presetPromptResolver,
			onEvent: async (event) => {
				await this.appendDaemonLogForChainId(event.chainId, { type: "scheduler.event", event: event as unknown as JsonObject })
				await externalOnEvent?.(event)
			},
		}
		if (scheduler.phaseRunner !== undefined) options.phaseRunner = scheduler.phaseRunner
		if (phaseRunnerSelectionForChain !== undefined) options.phaseRunnerSelectionForChain = phaseRunnerSelectionForChain
		if (scheduler.phase !== undefined) options.phase = scheduler.phase
		if (scheduler.presetDirForChain !== undefined) {
			options.presetDirForChain = scheduler.presetDirForChain
		} else if (schedulerPresetDir === undefined) {
			options.presetDirForChain = (chain) => bundledPresetDirForScheduler(chain)
		}
		if (scheduler.worktreeManager !== undefined) options.worktreeManager = scheduler.worktreeManager
		if (scheduler.kindResolver !== undefined) options.kindResolver = scheduler.kindResolver
		options.loopDataRootOptions = this.options
		if (scheduler.pendingStatuses !== undefined) options.pendingStatuses = scheduler.pendingStatuses
		if (scheduler.terminalStatuses !== undefined) options.terminalStatuses = scheduler.terminalStatuses
		options.statusesForChain = scheduler.statusesForChain ?? (async (chain) => {
			const pendingStatuses = await this.continuableItemStatuses(chain)
			const terminalStatuses = await this.terminalItemStatuses(chain)
			return {
				pending: [...pendingStatuses],
				terminal: [...terminalStatuses],
			}
		})
		if (scheduler.now !== undefined) options.now = scheduler.now
		if (scheduler.runIdFactory !== undefined) options.runIdFactory = scheduler.runIdFactory
		options.statusFromExit = scheduler.statusFromExit
			?? ((context) => defaultSchedulerStatusFromExit({
				exitCode: context.exitCode,
				stdout: context.stdout,
				phase: context.phase,
				runnerKind: context.runner.kind,
			}))
		if (scheduler.chainCompleteTrigger !== undefined) options.chainCompleteTrigger = scheduler.chainCompleteTrigger
		else if (scheduler.chainCompleteTriggerForChain !== undefined) options.chainCompleteTriggerForChain = scheduler.chainCompleteTriggerForChain
		else {
			const explicitRunnerOverride = scheduler.runner !== undefined ? fallbackRunner : null
			options.chainCompleteTriggerForChain = async (context) =>
				await runPresetChainCompleteTriggerPhases({
					...context,
					loopDataRoot: this.paths.root,
					presetDir: presetDirForChain(context.chain),
					...(explicitRunnerOverride === null ? {} : { phaseRunner: () => explicitRunnerOverride }),
				})
		}
		return options
	}

	private warnSkippedInvalidChain(chain: ChainRecord, error: RuntimePathError, context: string): void {
		console.warn(`coder-loop daemon warning: skipped ${context} for invalid chain ${chain.id} (${JSON.stringify(chain.name)}): ${error.message}`)
	}

	private async validateItemStatusForRequest(chain: ChainRecord, status: string): Promise<string> {
		const allowed = await this.allowedItemStatuses(chain)
		if (!allowed.has(status)) {
			throw new DaemonError("invalid_request", `item status must be one of: ${[...allowed].sort().join(", ")}`, { status })
		}
		return status
	}

	private async defaultItemStatusForRequest(chain: ChainRecord): Promise<string> {
		return await this.validateItemStatusForRequest(chain, "queued")
	}

	private async allowedItemStatuses(chain: ChainRecord): Promise<Set<string>> {
		const scheduler = this.options.scheduler ?? {}
		if (scheduler.pendingStatuses === undefined && scheduler.terminalStatuses === undefined) {
			const presetStatuses = await readBundledPresetStatuses(chain.preset)
			if (presetStatuses !== null) return new Set([...presetStatuses.continuable, ...presetStatuses.terminal, "queued", "in_progress"])
		}
		return new Set([
			...(scheduler.pendingStatuses ?? FALLBACK_PENDING_STATUSES),
			...(scheduler.terminalStatuses ?? FALLBACK_TERMINAL_STATUSES),
			"queued",
			"in_progress",
		])
	}

	private async continuableItemStatuses(chain: ChainRecord): Promise<Set<string>> {
		const scheduler = this.options.scheduler ?? {}
		if (scheduler.pendingStatuses !== undefined) return new Set(scheduler.pendingStatuses)
		if (scheduler.terminalStatuses === undefined) {
			const presetStatuses = await readBundledPresetStatuses(chain.preset)
			if (presetStatuses !== null) return new Set([...presetStatuses.continuable, "queued"])
		}
		return new Set(FALLBACK_PENDING_STATUSES)
	}

	private async terminalItemStatuses(chain: ChainRecord): Promise<Set<string>> {
		const scheduler = this.options.scheduler ?? {}
		if (scheduler.terminalStatuses !== undefined) return new Set(scheduler.terminalStatuses)
		if (scheduler.pendingStatuses === undefined) {
			const presetStatuses = await readBundledPresetStatuses(chain.preset)
			if (presetStatuses !== null) return new Set(presetStatuses.terminal)
		}
		return new Set(FALLBACK_TERMINAL_STATUSES)
	}
}

export async function startCoderLoopDaemon(options: StartCoderLoopDaemonOptions = {}): Promise<CoderLoopDaemon> {
	return await new CoderLoopDaemon(options).start()
}

export async function sendDaemonRequest(socketPath: string, request: Omit<DaemonRequest, "args"> & { args?: JsonObject }): Promise<DaemonResponse> {
	return await new Promise((resolveResponse, reject) => {
		const socket = createConnection(socketPath)
		let buffer = ""
		const cleanup = () => {
			socket.removeAllListeners()
			socket.destroy()
		}
		socket.setEncoding("utf-8")
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ ...request, args: request.args ?? {} })}\n`)
		})
		socket.on("data", (chunk: string) => {
			buffer += chunk
			const newlineIndex = buffer.indexOf("\n")
			if (newlineIndex === -1) return
			const line = buffer.slice(0, newlineIndex)
			try {
				const response = parseDaemonResponse(line)
				cleanup()
				resolveResponse(response)
			} catch (error) {
				cleanup()
				reject(error)
			}
		})
		socket.on("error", (error) => {
			cleanup()
			reject(error)
		})
	})
}

export function daemonRequest(command: DaemonCommandName, args: JsonObject = {}): DaemonRequest {
	return { id: randomUUID(), command, args }
}

function defaultDaemonRunner(): AgentRunnerSelection {
	return {
		kind: "codex",
		source: "iteration-default",
		binary: "codex",
		extraArgs: [],
		model: null,
	}
}

function defaultDaemonPrompt(details: { reason: string; preset?: string; phase?: string; presetDir?: string } = { reason: "missing_configured_prompt" }): string {
	const fields = [
		`reason=${details.reason}`,
		details.preset !== undefined ? `preset=${details.preset}` : null,
		details.phase !== undefined ? `phase=${details.phase}` : null,
		details.presetDir !== undefined ? `presetDir=${details.presetDir}` : null,
	].filter((entry): entry is string => entry !== null)
	return `coder-loop daemon scheduler prompt resolver failed (${fields.join(", ")}); investigate scheduler configuration or preset.`
}

export async function resolveSchedulerPresetPhasePrompt(input: { presetDir: string; phase: string }): Promise<string> {
	const preset = await loadPreset(input.presetDir)
	const phase = preset.phases.find((entry) => entry.name === input.phase)
	if (phase === undefined) {
		throw new Error(defaultDaemonPrompt({ reason: "phase_not_found_in_preset", preset: preset.name, phase: input.phase, presetDir: input.presetDir }))
	}
	return await readFile(phase.prompt, "utf-8")
}

function validateChainNameForRequest(input: string): string {
	try {
		const sanitized = sanitizeChainName(input)
		if (sanitized.startsWith("-")) {
			throw new DaemonError("invalid_request", "chain name must not start with hyphen", { reason: "leading_hyphen", input })
		}
		return sanitized
	} catch (error) {
		if (isInvalidChainNameError(error)) {
			throw new DaemonError("invalid_request", error.message, { reason: error.code, input: error.input })
		}
		throw error
	}
}

function isInvalidChainNameError(error: unknown): error is RuntimePathError {
	return error instanceof RuntimePathError && error.code === "invalid_chain_name"
}

type RepositoryRefField = "repository" | "umbrellaRepo"

function validateRepositoryForRequest(input: string): string {
	return validateRepositoryRefForRequest(input, "repository")
}

function validateRepositoryRefForRequest(input: string, field: RepositoryRefField): string {
	const details: JsonObject = { [field]: input }
	if (input.length > MAX_REPOSITORY_REF_LENGTH) {
		throw new DaemonError("invalid_request", `${field} must be ${MAX_REPOSITORY_REF_LENGTH} characters or fewer`, details)
	}
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, details)
	}
	if (!REPOSITORY_REF_PATTERN.test(input)) {
		throw new DaemonError("invalid_request", `${field} must use owner/repo format`, details)
	}
	const repoName = input.slice(input.indexOf("/") + 1)
	if (repoName === "." || repoName === "..") {
		throw new DaemonError("invalid_request", `${field} name must not be a reserved path segment`, details)
	}
	return input
}

function validateBaseBranchForRequest(input: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", "baseBranch must not contain control characters", { baseBranch: input })
	}
	if (input.includes("@{")) {
		throw new DaemonError("invalid_request", "baseBranch must be a literal branch name, not checkout shorthand", { baseBranch: input })
	}

	const check = Bun.spawnSync({ cmd: ["git", "check-ref-format", "--branch", input], stdout: "pipe", stderr: "pipe" })
	if (check.exitCode !== 0) {
		throw new DaemonError("invalid_request", "baseBranch must be a valid git branch name", { baseBranch: input })
	}
	return input
}

function validateItemTitleForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	if (value.length > MAX_ITEM_TITLE_LENGTH) {
		throw new DaemonError("invalid_request", `title must be ${MAX_ITEM_TITLE_LENGTH} characters or fewer`, { title: value })
	}
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw new DaemonError("invalid_request", "title must not contain control characters", { title: value })
	}
	return value
}

function validateItemPriorityForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	if (!(ITEM_PRIORITY_VALUES as readonly string[]).includes(value)) {
		throw new DaemonError("invalid_request", `priority must be one of: ${ITEM_PRIORITY_VALUES.join(", ")}, or null`, { priority: value })
	}
	return value
}

function validateItemBranchForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	validateGitBranchNameForRequest(value, "branch")
	return value
}

function validateGitBranchNameForRequest(input: string, field: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, { [field]: input })
	}
	if (input.includes("@{")) {
		throw new DaemonError("invalid_request", `${field} must be a literal branch name, not checkout shorthand`, { [field]: input })
	}

	const check = Bun.spawnSync({ cmd: ["git", "check-ref-format", "--branch", input], stdout: "pipe", stderr: "pipe" })
	if (check.exitCode !== 0) {
		throw new DaemonError("invalid_request", `${field} must be a valid git branch name`, { [field]: input })
	}
	return input
}

function validateItemPrForRequest(value: number | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value
	if (value < 1) {
		throw new DaemonError("invalid_request", "pr must be a positive integer or null", { pr: value })
	}
	return value
}

function validateRelativeItemPathForRequest(value: string | null | undefined, field: "issueFile" | "evidenceDir"): string | null | undefined {
	if (value === undefined || value === null) return value
	validateItemPathText(value, field)
	if (isAbsolute(value)) throw new DaemonError("invalid_request", `${field} must be a relative path`, { [field]: value })
	if (hasParentPathSegment(value)) throw new DaemonError("invalid_request", `${field} must not contain parent path segments`, { [field]: value })
	return value
}

function validateEvidenceDirForRequest(value: string | null | undefined, chain: ChainRecord, loopDataRoot: string): string | null | undefined {
	if (value === undefined || value === null) return value
	validateItemPathText(value, "evidenceDir")
	if (!isAbsolute(value)) return validateRelativeItemPathForRequest(value, "evidenceDir")

	const chainRoot = resolveChainRuntimePaths(chain.name, { loopDataRoot }).chainRoot
	const resolved = resolve(value)
	if (!isPathInsideOrEqual(chainRoot, resolved)) {
		throw new DaemonError("invalid_request", "evidenceDir absolute path must stay under the chain root", {
			evidenceDir: value,
			chainRoot,
		})
	}
	return value
}

function validateItemPathText(value: string, field: "issueFile" | "evidenceDir"): void {
	if (value === "") throw new DaemonError("invalid_request", `${field} must not be empty`, { [field]: value })
	if (value.length > MAX_REPO_CWD_LENGTH) {
		throw new DaemonError("invalid_request", `${field} must be ${MAX_REPO_CWD_LENGTH} characters or fewer`, { [field]: value })
	}
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, { [field]: value })
	}
}

function hasParentPathSegment(value: string): boolean {
	return value.split(/[\\/]+/u).some((segment) => segment === "..")
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate)
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function validateUmbrellaIssueForRequest(value: number | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value
	if (value < 1) {
		throw new DaemonError("invalid_request", "umbrellaIssue must be a positive integer or null", { umbrellaIssue: value })
	}
	return value
}

function formatDaemonBatchTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace(/[T:]/g, "-")
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

async function terminateStaleProcessGroup(pid: number, forceAfterMs: number): Promise<void> {
	if (pid === process.pid) return
	const termSent = sendSignalToPidOrGroup(pid, "SIGTERM")
	if (!termSent) return
	await delay(forceAfterMs)
	if (isPidOrGroupAlive(pid)) sendSignalToPidOrGroup(pid, "SIGKILL")
}

function sendSignalToPidOrGroup(pid: number, signal: NodeJS.Signals): boolean {
	if (process.platform !== "win32") {
		if (canSignalStoredProcessGroup(pid)) {
			try {
				process.kill(-pid, signal)
				return true
			} catch (error) {
				if (!isNoSuchProcessError(error)) return true
			}
		}
	}
	try {
		process.kill(pid, signal)
		return true
	} catch (error) {
		return !isNoSuchProcessError(error)
	}
}

function canSignalStoredProcessGroup(pid: number): boolean {
	const currentGroup = readProcessGroupId(process.pid)
	const targetGroup = readProcessGroupId(pid)
	if (currentGroup !== null && currentGroup === pid) return false
	if (targetGroup !== null && targetGroup !== pid) return false
	if (currentGroup !== null && targetGroup !== null && currentGroup === targetGroup) return false
	return true
}

function readProcessGroupId(pid: number): number | null {
	const result = Bun.spawnSync({ cmd: ["ps", "-o", "pgid=", "-p", String(pid)], stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0) return null
	const raw = new TextDecoder().decode(result.stdout).trim()
	const value = Number(raw)
	return Number.isSafeInteger(value) && value > 0 ? value : null
}

function isPidOrGroupAlive(pid: number): boolean {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, 0)
			return true
		} catch (error) {
			if (!isNoSuchProcessError(error)) return true
		}
	}
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !isNoSuchProcessError(error)
	}
}

function isNoSuchProcessError(error: unknown): boolean {
	return isNodeError(error) && error.code === "ESRCH"
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeOversizedRequestResponse(socket: Socket, actualBytes: number): void {
	const response: DaemonResponse = {
		id: "unknown",
		ok: false,
		error: {
			code: "request_too_large",
			message: `request line must be ${MAX_DAEMON_REQUEST_BYTES} bytes or fewer`,
			details: {
				limitBytes: MAX_DAEMON_REQUEST_BYTES,
				actualBytes,
			},
		},
	}
	socket.write(`${JSON.stringify(response)}\n`, () => {
		socket.end()
	})
}

function validateRequestLineSize(line: string): void {
	const actualBytes = byteLength(line)
	if (actualBytes > MAX_DAEMON_REQUEST_BYTES) {
		throw new DaemonError("request_too_large", `request line must be ${MAX_DAEMON_REQUEST_BYTES} bytes or fewer`, {
			limitBytes: MAX_DAEMON_REQUEST_BYTES,
			actualBytes,
		})
	}
}

function byteLength(input: string): number {
	return Buffer.byteLength(input, "utf8")
}

function parseDaemonRequest(line: string): DaemonRequest {
	const parsed = parseJsonRecord(line)
	const id = requiredString(parsed, "id")
	const command = requiredString(parsed, "command")
	const args = optionalJsonObject(parsed, "args") ?? {}
	return { id, command, args }
}

function parseDaemonResponse(line: string): DaemonResponse {
	const parsed = parseJsonRecord(line)
	const id = requiredString(parsed, "id")
	const ok = requiredBoolean(parsed, "ok")
	if (ok) return { id, ok: true, result: optionalJsonObject(parsed, "result") ?? {} }
	const errorRecord = requiredRecord(parsed, "error")
	const error: DaemonResponseError = {
		code: requiredString(errorRecord, "code"),
		message: requiredString(errorRecord, "message"),
	}
	const details = optionalJsonObject(errorRecord, "details")
	if (details !== undefined) error.details = details
	return {
		id,
		ok: false,
		error,
	}
}

function parseJsonRecord(line: string): UnknownRecord {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new DaemonError("invalid_json", `invalid JSON request: ${errorMessage(error)}`)
	}
	if (!isRecord(parsed)) throw new DaemonError("invalid_request", "message must be a JSON object")
	return parsed
}

function responseError(error: unknown): DaemonResponseError {
	if (error instanceof DaemonError) return { code: error.code, message: error.message, details: error.details }
	return { code: "internal_error", message: errorMessage(error) }
}

function requiredString(record: UnknownRecord, key: string): string {
	const value = record[key]
	if (typeof value !== "string" || value === "") throw new DaemonError("invalid_request", `${key} must be a non-empty string`)
	return value
}

function optionalString(record: UnknownRecord, key: string): string | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "string" || value === "") throw new DaemonError("invalid_request", `${key} must be a non-empty string when provided`)
	return value
}

function optionalStringOrNull(record: UnknownRecord, key: string): string | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (typeof value !== "string") throw new DaemonError("invalid_request", `${key} must be a string or null when provided`)
	return value
}

function requiredInteger(record: UnknownRecord, key: string): number {
	const value = record[key]
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer`)
	return value
}

function requiredPositiveInteger(record: UnknownRecord, key: string): number {
	const value = requiredInteger(record, key)
	if (value < 1) throw new DaemonError("invalid_request", `${key} must be a positive integer`)
	return value
}

function optionalInteger(record: UnknownRecord, key: string): number | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer when provided`)
	return value
}

function optionalPositiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function optionalIntegerOrNull(record: UnknownRecord, key: string): number | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer or null when provided`)
	return value
}

function requiredBoolean(record: UnknownRecord, key: string): boolean {
	const value = record[key]
	if (typeof value !== "boolean") throw new DaemonError("invalid_request", `${key} must be a boolean`)
	return value
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "boolean") throw new DaemonError("invalid_request", `${key} must be a boolean when provided`)
	return value
}

function requiredRecord(record: UnknownRecord, key: string): UnknownRecord {
	const value = record[key]
	if (!isRecord(value)) throw new DaemonError("invalid_request", `${key} must be a JSON object`)
	return value
}

function optionalJsonObject(record: UnknownRecord, key: string): JsonObject | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (!isRecord(value) || !isJsonObject(value)) throw new DaemonError("invalid_request", `${key} must be a JSON object when provided`)
	return value
}

function sizedJsonObject(record: UnknownRecord, key: string, limitBytes: number): JsonObject | undefined {
	const value = optionalJsonObject(record, key)
	if (value === undefined) return undefined
	const actualBytes = byteLength(JSON.stringify(value))
	if (actualBytes > limitBytes) {
		throw new DaemonError("request_too_large", `${key} must be ${limitBytes} bytes or fewer`, {
			field: key,
			limitBytes,
			actualBytes,
		})
	}
	return value
}

function validateChainMetadata(metadata: JsonObject): JsonObject {
	validateJsonObjectSafety(metadata, "metadata", MAX_CHAIN_METADATA_DEPTH, "metadata")
	return metadata
}

function validateItemExtra(extra: JsonObject): JsonObject {
	validateJsonObjectSafety(extra, "extra", MAX_ITEM_EXTRA_DEPTH, "extra")
	return extra
}

function validateJsonObjectSafety(value: JsonValue, path: string, maxDepth: number, label: string, depth = 0): void {
	if (depth > maxDepth) {
		throw new DaemonError("invalid_request", `${label} nesting depth must be ${maxDepth} or fewer`, {
			field: path,
			maxDepth,
			actualDepth: depth,
		})
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => validateJsonObjectSafety(item, `${path}[${index}]`, maxDepth, label, depth + 1))
		return
	}
	if (!isRecord(value)) return

	for (const [key, child] of Object.entries(value)) {
		const field = key === "" ? `${path}.<empty>` : `${path}.${key}`
		if (key === "") {
			throw new DaemonError("invalid_request", `${label} key must not be empty string`, { field })
		}
		if (RESERVED_METADATA_KEYS.has(key)) {
			throw new DaemonError("invalid_request", `${label} key not allowed: ${key}`, { field })
		}
		validateJsonObjectSafety(child as JsonValue, field, maxDepth, label, depth + 1)
	}
}

function validateKnownKeys(record: UnknownRecord, label: string, allowedKeys: readonly string[]): void {
	const allowed = new Set(allowedKeys)
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) {
			throw new DaemonError("invalid_request", `${label} contains unsupported field: ${key}`, {
				field: key,
				allowed: [...allowedKeys],
			})
		}
	}
}

function validateItemAddRequest(args: JsonObject): void {
	validateKnownKeys(args, "item.add args", ITEM_ADD_ARG_KEYS)
}

function validateItemBatchAddRequest(args: JsonObject): void {
	validateKnownKeys(args, "item.batchAdd args", ITEM_BATCH_ADD_ARG_KEYS)
}

function validateItemUpdateRequest(args: JsonObject): void {
	validateKnownKeys(args, "item.update args", ITEM_UPDATE_ARG_KEYS)
	validateItemUpdateSelector(args)
	const nestedFields = optionalJsonObject(args, "fields")
	if (nestedFields !== undefined) {
		validateKnownKeys(nestedFields, "item.update fields", ITEM_UPDATE_FIELD_KEYS)
		for (const key of ITEM_UPDATE_FIELD_KEYS) {
			if (Object.hasOwn(args, key)) {
				throw new DaemonError("invalid_request", `item.update args cannot mix top-level update field with fields object: ${key}`, { field: key })
			}
		}
	}
	const fields = itemUpdateFields(args)
	if (Object.keys(fields).length === 0) throw new DaemonError("invalid_request", "item.update requires at least one field to update")
}

function validateItemUpdateSelector(args: JsonObject): void {
	const itemId = optionalInteger(args, "itemId")
	if (itemId === null) return
	for (const key of ["chainId", "chainName", "name", "issueNumber"] as const) {
		if (Object.hasOwn(args, key)) {
			throw new DaemonError("invalid_request", `item.update with itemId must not include selector field ${key}`, { field: key })
		}
	}
}

function itemUpdateFields(args: JsonObject): JsonObject {
	const nestedFields = optionalJsonObject(args, "fields")
	if (nestedFields !== undefined) return nestedFields
	const fields: JsonObject = {}
	for (const key of ITEM_UPDATE_FIELD_KEYS) {
		if (Object.hasOwn(args, key)) fields[key] = args[key] as JsonValue
	}
	return fields
}

function requestedChainName(args: JsonObject): string | null {
	const chainName = optionalString(args, "chainName")
	const name = optionalString(args, "name")
	if (chainName !== null && name !== null && chainName !== name) {
		throw new DaemonError("invalid_request", "chainName and name both provided but differ", { chainName, name })
	}
	return chainName ?? name
}

function requiredJsonObjectArray(record: UnknownRecord, key: string): JsonObject[] {
	const value = record[key]
	if (!Array.isArray(value)) throw new DaemonError("invalid_request", `${key} must be an array of item objects`, { field: key })
	return value.map((entry, index) => {
		if (!isRecord(entry) || Array.isArray(entry)) throw new DaemonError("invalid_request", `${key}[${index}] must be an item object`, { field: `${key}[${index}]` })
		return entry as JsonObject
	})
}

function optionalDependsOn(record: UnknownRecord, key: string): number[] | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (!Array.isArray(value)) throw new DaemonError("invalid_request", `${key} must be an array of positive item ids or null when provided`)
	return value.map((entry, index) => {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
			throw new DaemonError("invalid_request", `${key}[${index}] must be a positive item id`, { index, value: toJsonValue(entry) })
		}
		return entry
	})
}

function optionalRunner(record: UnknownRecord, key: string): AgentRunnerKind | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (value !== "claude" && value !== "codex") throw new DaemonError("invalid_request", `${key} must be claude, codex, or null`)
	return value
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) target[key] = value
}

async function validateRepoCwdForRequest(input: string): Promise<string> {
	if (input.length > MAX_REPO_CWD_LENGTH) throw new DaemonError("invalid_request", `repoCwd must be ${MAX_REPO_CWD_LENGTH} characters or fewer`)
	if (!isAbsolute(input)) throw new DaemonError("invalid_request", "repoCwd must be an absolute path", { repoCwd: input })
	if (/[\u0000-\u001f\u007f]/u.test(input)) throw new DaemonError("invalid_request", "repoCwd must not contain control characters", { repoCwd: input })
	let pathStat: Awaited<ReturnType<typeof stat>>
	try {
		pathStat = await stat(input)
	} catch (error) {
		throw new DaemonError("invalid_request", `repoCwd must exist and be a directory: ${errorMessage(error)}`, { repoCwd: input })
	}
	if (!pathStat.isDirectory()) throw new DaemonError("invalid_request", "repoCwd must be a directory", { repoCwd: input })
	return input
}

async function readBundledPresetStatuses(presetName: string): Promise<{ continuable: string[]; terminal: string[] } | null> {
	if (!PRESET_NAME_PATTERN.test(presetName)) return null
	try {
		const raw = await readFile(resolve(bundledPresetDir(presetName), "preset.toml"), "utf-8")
		const parsed = Bun.TOML.parse(raw) as unknown
		if (!isRecord(parsed) || !isRecord(parsed.statuses)) return null
		const continuable = parsed.statuses.continuable
		const terminal = parsed.statuses.terminal
		if (!Array.isArray(continuable) || !continuable.every((status) => typeof status === "string")) return null
		if (!Array.isArray(terminal) || !terminal.every((status) => typeof status === "string")) return null
		return { continuable, terminal }
	} catch {
		return null
	}
}

async function validateBundledPresetForRequest(input: string): Promise<string> {
	if (!PRESET_NAME_PATTERN.test(input)) {
		throw new DaemonError("invalid_request", `preset must match ${PRESET_NAME_PATTERN.source}`, { preset: input })
	}
	const presetFile = resolve(bundledPresetDir(input), "preset.toml")
	try {
		const presetStat = await stat(presetFile)
		if (!presetStat.isFile()) {
			throw new DaemonError("invalid_request", `unknown preset: ${input}`, { preset: input })
		}
	} catch (error) {
		if (error instanceof DaemonError) throw error
		throw new DaemonError("invalid_request", `unknown preset: ${input}`, { preset: input })
	}
	return input
}

function bundledPresetDir(presetName: string): string {
	return resolve(BUNDLED_PRESETS_DIR, presetName)
}

function bundledPresetDirForScheduler(chain: ChainRecord): string {
	const fallback = bundledPresetDir(DEFAULT_PRESET_NAME)
	if (!PRESET_NAME_PATTERN.test(chain.preset)) {
		console.warn(`coder-loop daemon warning: chain ${chain.id} has invalid preset ${JSON.stringify(chain.preset)}; using ${DEFAULT_PRESET_NAME}`)
		return fallback
	}
	const dir = bundledPresetDir(chain.preset)
	if (!existsSync(resolve(dir, "preset.toml"))) {
		console.warn(`coder-loop daemon warning: chain ${chain.id} references unknown preset ${JSON.stringify(chain.preset)}; using ${DEFAULT_PRESET_NAME}`)
		return fallback
	}
	return dir
}

function validateDependsOnGraph(items: readonly ItemRecord[], itemId: number | null, dependsOn: readonly number[] | null): void {
	if (dependsOn === null) return
	const byId = new Map(items.map((item) => [item.id, item]))
	for (const dependencyId of dependsOn) {
		if (!byId.has(dependencyId)) throw new DaemonError("invalid_request", `dependsOn references unknown item ${dependencyId}`, { itemId: itemId ?? null, dependsOn: [...dependsOn] })
	}
	if (itemId === null) return

	const visit = (candidateId: number, path: number[]): void => {
		if (candidateId === itemId) {
			throw new DaemonError("invalid_request", `dependsOn would create a dependency cycle through item ${itemId}`, { itemId, path: [...path, candidateId] })
		}
		if (path.includes(candidateId)) return
		const candidate = byId.get(candidateId)
		if (candidate === undefined) return
		for (const nextId of dependsOnFromStoredExtra(candidate.extra)) visit(nextId, [...path, candidateId])
	}

	for (const dependencyId of dependsOn) visit(dependencyId, [])
}

function dependsOnFromStoredExtra(extra: JsonObject): number[] {
	const raw = extra.dependsOn
	if (!Array.isArray(raw)) return []
	return raw.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1)
}

function withDependsOn(extra: JsonObject, dependsOn: readonly number[] | null | undefined): JsonObject {
	if (dependsOn === undefined) return extra
	const next: JsonObject = { ...extra }
	if (dependsOn === null) {
		delete next.dependsOn
	} else {
		next.dependsOn = [...dependsOn]
	}
	return next
}

function toJsonValue(value: unknown): JsonValue {
	return isJsonValue(value) ? value : String(value)
}

function chainCreateConflicts(existing: ChainRecord, requested: CreateChainInput): JsonObject[] {
	const conflicts: JsonObject[] = []
	const addConflict = (field: string, existingValue: JsonValue, requestedValue: JsonValue): void => {
		if (jsonValuesEqual(existingValue, requestedValue)) return
		conflicts.push({ field, existing: existingValue, requested: requestedValue })
	}

	addConflict("preset", existing.preset, requested.preset)
	addConflict("repository", existing.repository, requested.repository)
	addConflict("baseBranch", existing.baseBranch, requested.baseBranch)
	addConflict("status", existing.status, requested.status ?? "active")
	addConflict("umbrellaIssue", existing.umbrellaIssue, requested.umbrellaIssue ?? null)
	addConflict("umbrellaRepo", existing.umbrellaRepo, requested.umbrellaRepo ?? null)

	for (const [key, requestedValue] of Object.entries(requested.metadata ?? {})) {
		const existingHasKey = Object.hasOwn(existing.metadata, key)
		const existingValue = existing.metadata[key]
		if (existingHasKey && jsonValuesEqual(existingValue, requestedValue)) continue
		conflicts.push({
			field: `metadata.${key}`,
			existing: existingHasKey && existingValue !== undefined ? existingValue : null,
			existingPresent: existingHasKey,
			requested: requestedValue,
		})
	}

	return conflicts
}

function duplicateItemAddError(chain: ChainRecord, issueNumber: number, existing: ItemRecord): DaemonError {
	return new DaemonError("conflict", `item with issueNumber ${issueNumber} already exists in chain ${chain.name}`, {
		chainId: chain.id,
		chainName: chain.name,
		issueNumber,
		existingItemId: existing.id,
	})
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((value, index) => jsonValuesEqual(value, right[index]))
	}
	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) return false
		const leftKeys = Object.keys(left).sort()
		const rightKeys = Object.keys(right).sort()
		if (leftKeys.length !== rightKeys.length) return false
		return leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key] as JsonValue | undefined, right[key] as JsonValue | undefined))
	}
	return false
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(value: UnknownRecord): value is JsonObject {
	return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (isRecord(value)) return Object.values(value).every(isJsonValue)
	return false
}

function chainToJson(chain: ChainRecord): JsonObject {
	return {
		id: chain.id,
		name: chain.name,
		preset: chain.preset,
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		umbrellaIssue: chain.umbrellaIssue,
		umbrellaRepo: chain.umbrellaRepo,
		status: chain.status,
		metadata: chain.metadata,
		createdAt: chain.createdAt,
		updatedAt: chain.updatedAt,
	}
}

function itemToJson(item: ItemRecord, dependencyWait?: DependencyWaitReason | null): JsonObject {
	const result: JsonObject = {
		id: item.id,
		chainId: item.chainId,
		issueNumber: item.issueNumber,
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
		extra: item.extra,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	}
	if (dependencyWait !== undefined) result.waiting = dependencyWait === null ? null : dependencyWaitToJson(dependencyWait)
	return result
}

function assertChainAllowsItemMutation(chain: ChainRecord, operation: string): void {
	if (chain.status !== "deleted") return
	throw new DaemonError("chain_deleted", `${operation} cannot mutate deleted chain ${chain.name}`, {
		chainId: chain.id,
		chainName: chain.name,
		status: chain.status,
	})
}

function chainStatusSummary(
	chain: ChainRecord,
	items: ItemRecord[],
	activeRuns: ReturnType<typeof listActiveRuns>,
	dependencyWaits: readonly DependencyWaitReason[],
): JsonObject {
	const byStatus: Record<string, number> = {}
	for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const activeItemIds = new Set(activeRuns.map((run) => run.itemId))
	const staleInProgressItems = items
		.filter((item) => item.status === "in_progress" && !activeItemIds.has(item.id))
		.map((item) => ({
			itemId: item.id,
			issueNumber: item.issueNumber,
			runId: item.lastRunId,
			repoCwd: item.repoCwd,
			agentCwd: item.agentCwd,
		}))
	return {
		completion: {
			state: chain.status,
			completedAt: chain.status === "completed" ? chain.updatedAt : null,
		},
		umbrella: {
			repo: chain.umbrellaRepo,
			issue: chain.umbrellaIssue,
		},
		items: {
			total: items.length,
			byStatus,
		},
		activeSlots: activeRuns.map((run) => ({
			chainId: run.chainId,
			repoCwd: run.repoCwd,
			itemId: run.itemId,
			runId: run.runId,
			pid: run.pid,
			worktreePath: run.worktreePath,
			startedAt: run.startedAt,
		})),
		recovery: {
			needed: staleInProgressItems.length > 0,
			staleInProgressItems,
		},
		waiting: {
			dependency: dependencyWaits.map(dependencyWaitToJson),
		},
	}
}

function dependencyWaitToJson(wait: DependencyWaitReason): JsonObject {
	return {
		reason: "blocked-by-dependency",
		itemId: wait.itemId,
		issueNumber: wait.issueNumber,
		repoCwd: wait.repoCwd,
		dependsOn: wait.dependsOn,
		unsatisfied: wait.unsatisfied,
	}
}

function activeRunToJson(run: ReturnType<typeof listActiveRuns>[number]): JsonObject {
	return {
		runId: run.runId,
		pid: run.pid,
		itemId: run.itemId,
		chainId: run.chainId,
		repoCwd: run.repoCwd,
		worktreePath: run.worktreePath,
		startedAt: run.startedAt,
	}
}

function completedRunToJson(run: SchedulerCompletedRun): JsonObject {
	return {
		runId: run.runId,
		itemId: run.itemId,
		chainId: run.chainId,
		repoCwd: run.repoCwd,
		exitCode: run.exitCode,
		status: run.status,
		stdoutBytes: run.stdout.length,
		stderrBytes: run.stderr.length,
	}
}

export function runToJson(run: RunRecord): JsonObject {
	return {
		id: run.id,
		runId: run.runId,
		chainId: run.chainId,
		itemId: run.itemId,
		phase: run.phase,
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		exitCode: run.exitCode,
		extra: run.extra,
	}
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	if (!await pathExists(socketPath)) return
	if (await canConnect(socketPath)) {
		throw new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${socketPath}`, { socketPath })
	}
	await unlinkIfExists(socketPath)
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function canConnect(socketPath: string): Promise<boolean> {
	return await new Promise((resolveConnect) => {
		const socket = createConnection(socketPath)
		const done = (value: boolean) => {
			socket.removeAllListeners()
			socket.destroy()
			resolveConnect(value)
		}
		socket.on("connect", () => done(true))
		socket.on("error", () => done(false))
		socket.setTimeout(100, () => done(false))
	})
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path)
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error
	}
}

async function listen(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolveListen, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening)
			reject(error)
		}
		const onListening = () => {
			server.off("error", onError)
			resolveListen()
		}
		server.once("error", onError)
		server.once("listening", onListening)
		server.listen(socketPath)
	})
}

async function listenOrReportSocketInUse(server: Server, socketPath: string): Promise<void> {
	try {
		await listen(server, socketPath)
	} catch (error) {
		if (await pathExists(socketPath) && await canConnect(socketPath)) {
			throw new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${socketPath}`, { socketPath })
		}
		throw error
	}
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => {
			if (error) reject(error)
			else resolveClose()
		})
	})
}

function translateDaemonStartError(error: unknown, details: JsonObject): DaemonError {
	if (error instanceof DaemonError) return error
	if (isNodeError(error) && error.code === "EADDRINUSE" && typeof details.socketPath === "string") {
		return new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${details.socketPath}`, {
			socketPath: details.socketPath,
		})
	}
	return new DaemonError("daemon_start_failed", `unable to start coder-loop daemon: ${errorMessage(error)}`, details)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
