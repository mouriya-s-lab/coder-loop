import { randomUUID } from "node:crypto"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { AgentRunnerKind, AgentRunnerSelection, JsonObject, JsonValue } from "./loop"
import {
	createSchedulerState,
	listActiveRuns,
	schedulerTick,
	type SchedulerOptions,
	type SchedulerState,
} from "./scheduler"
import {
	type ChainRecord,
	type CreateChainInput,
	type CreateItemInput,
	type ItemRecord,
	openSqliteStateStore,
	type RunRecord,
	type SqliteStateStore,
	type UpdateItemInput,
} from "./sqlite-state"
import { type LoopDataRootOptions, resolveLoopDataPaths } from "./runtime-paths"

export type DaemonCommandName =
	| "chain.create"
	| "chain.list"
	| "chain.status"
	| "chain.delete"
	| "item.add"
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
	private resolveClosed: (() => void) | null = null
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
		const store = openSqliteStateStore(this.options)
		this.store = store

		try {
			await removeStaleSocket(this.paths.daemonSocket)
			const server = createServer((socket) => this.acceptConnection(socket))
			this.server = server
			await listen(server, this.paths.daemonSocket)
			await writeFile(this.paths.daemonPid, `${process.pid}\n`)
			this.state = "running"
			this.startSchedulerLoop()
			this.requestSchedulerTick()
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
		if (this.schedulerTimer !== null) {
			clearInterval(this.schedulerTimer)
			this.schedulerTimer = null
		}
		await this.schedulerTickInFlight

		const activeRuns = listActiveRuns(this.schedulerState)
		await Promise.all(activeRuns.map((run) => run.terminate({ forceAfterMs: this.shutdownGraceMs })))

		for (const socket of this.sockets) socket.end()
		if (this.server !== null) {
			await closeServer(this.server)
			this.server = null
		}
		this.store?.close()
		this.store = null
		await unlinkIfExists(this.paths.daemonSocket)
		await unlinkIfExists(this.paths.daemonPid)
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
		await unlinkIfExists(this.paths.daemonSocket)
		await unlinkIfExists(this.paths.daemonPid)
		this.state = "exited"
		this.resolveClosed?.()
	}

	private acceptConnection(socket: Socket): void {
		this.sockets.add(socket)
		socket.setEncoding("utf-8")
		let buffer = ""
		socket.on("data", (chunk: string) => {
			buffer += chunk
			let newlineIndex = buffer.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				if (line.trim() !== "") void this.handleLine(socket, line)
				newlineIndex = buffer.indexOf("\n")
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
			const request = parseDaemonRequest(line)
			requestId = request.id
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
				return this.handleChainStatus(request.args)
			case "chain.delete":
				return await this.handleChainDelete(request.args)
			case "item.add":
				return await this.handleItemAdd(request.args)
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
		const input: CreateChainInput = {
			name: requiredString(args, "name"),
			preset: optionalString(args, "preset") ?? "gh-issue-pr-iteration",
			repository: requiredString(args, "repository"),
			baseBranch: optionalString(args, "baseBranch") ?? "main",
			status: "active",
			metadata: optionalJsonObject(args, "metadata") ?? {},
		}
		const umbrellaIssue = optionalIntegerOrNull(args, "umbrellaIssue")
		if (umbrellaIssue !== undefined) input.umbrellaIssue = umbrellaIssue
		const umbrellaRepo = optionalStringOrNull(args, "umbrellaRepo")
		if (umbrellaRepo !== undefined) input.umbrellaRepo = umbrellaRepo
		const chain = this.requireStore().createChain(input)
		return { chain: chainToJson(chain) }
	}

	private handleChainList(): JsonObject {
		return { chains: this.requireStore().listChains().map(chainToJson) }
	}

	private handleChainStatus(args: JsonObject): JsonObject {
		const chain = this.resolveChain(args)
		return {
			chain: chainToJson(chain),
			items: this.requireStore().listItems(chain.id).map(itemToJson),
		}
	}

	private async handleChainDelete(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		const updated = this.requireStore().updateChain(chain.id, { status: "deleted" })
		await this.requestSchedulerTick()
		return { chain: chainToJson(updated) }
	}

	private async handleItemAdd(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		const input: CreateItemInput = {
			chainId: chain.id,
			issueNumber: requiredInteger(args, "issueNumber"),
			repoCwd: requiredString(args, "repoCwd"),
			status: optionalString(args, "status") ?? "queued",
			attempts: optionalInteger(args, "attempts") ?? 0,
			extra: optionalJsonObject(args, "extra") ?? {},
		}
		assignOptional(input, "title", optionalStringOrNull(args, "title"))
		assignOptional(input, "priority", optionalStringOrNull(args, "priority"))
		assignOptional(input, "branch", optionalStringOrNull(args, "branch"))
		assignOptional(input, "pr", optionalIntegerOrNull(args, "pr"))
		assignOptional(input, "lastRunId", optionalStringOrNull(args, "lastRunId"))
		assignOptional(input, "issueFile", optionalStringOrNull(args, "issueFile"))
		assignOptional(input, "evidenceDir", optionalStringOrNull(args, "evidenceDir"))
		assignOptional(input, "agentCwd", optionalStringOrNull(args, "agentCwd"))
		assignOptional(input, "runner", optionalRunner(args, "runner"))
		const item = this.requireStore().createItem(input)
		await this.requestSchedulerTick()
		return { item: itemToJson(item) }
	}

	private handleItemList(args: JsonObject): JsonObject {
		const chain = this.resolveChain(args)
		return { items: this.requireStore().listItems(chain.id).map(itemToJson) }
	}

	private async handleItemUpdate(args: JsonObject): Promise<JsonObject> {
		const item = this.resolveItem(args)
		const fields = optionalJsonObject(args, "fields") ?? args
		const input: UpdateItemInput = {}
		assignOptional(input, "repoCwd", optionalString(fields, "repoCwd") ?? undefined)
		assignOptional(input, "status", optionalString(fields, "status") ?? undefined)
		assignOptional(input, "attempts", optionalInteger(fields, "attempts") ?? undefined)
		assignOptional(input, "title", optionalStringOrNull(fields, "title"))
		assignOptional(input, "priority", optionalStringOrNull(fields, "priority"))
		assignOptional(input, "branch", optionalStringOrNull(fields, "branch"))
		assignOptional(input, "pr", optionalIntegerOrNull(fields, "pr"))
		assignOptional(input, "lastRunId", optionalStringOrNull(fields, "lastRunId"))
		assignOptional(input, "issueFile", optionalStringOrNull(fields, "issueFile"))
		assignOptional(input, "evidenceDir", optionalStringOrNull(fields, "evidenceDir"))
		assignOptional(input, "agentCwd", optionalStringOrNull(fields, "agentCwd"))
		assignOptional(input, "runner", optionalRunner(fields, "runner"))
		assignOptional(input, "extra", optionalJsonObject(fields, "extra"))
		const updated = this.requireStore().updateItem(item.id, input)
		await this.requestSchedulerTick()
		return { item: itemToJson(updated) }
	}

	private resolveChain(args: JsonObject): ChainRecord {
		const store = this.requireStore()
		const chainId = optionalInteger(args, "chainId")
		if (chainId !== null) {
			const chain = store.getChain(chainId)
			if (chain === null) throw new DaemonError("not_found", `chain ${chainId} was not found`, { chainId })
			return chain
		}
		const chainName = optionalString(args, "chainName") ?? optionalString(args, "name")
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
		const issueNumber = requiredInteger(args, "issueNumber")
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
			this.requestSchedulerTick()
		}, intervalMs)
	}

	private async requestSchedulerTick(): Promise<void> {
		if (!this.schedulerEnabled() || this.state !== "running") return
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

	private async runSchedulerTicks(): Promise<void> {
		do {
			this.schedulerTickRequested = false
			await schedulerTick(this.buildSchedulerOptions())
		} while (this.schedulerTickRequested && this.state === "running")
	}

	private buildSchedulerOptions(): SchedulerOptions {
		const scheduler = this.options.scheduler ?? {}
		const options: SchedulerOptions = {
			store: this.requireStore(),
			state: this.schedulerState,
			runner: scheduler.runner ?? defaultDaemonRunner(),
			presetDir: scheduler.presetDir ?? resolve(import.meta.dir, "../presets/gh-issue-pr-iteration"),
			prompt: scheduler.prompt ?? defaultDaemonPrompt,
		}
		if (scheduler.phase !== undefined) options.phase = scheduler.phase
		if (scheduler.worktreeManager !== undefined) options.worktreeManager = scheduler.worktreeManager
		options.loopDataRootOptions = this.options
		if (scheduler.pendingStatuses !== undefined) options.pendingStatuses = scheduler.pendingStatuses
		if (scheduler.terminalStatuses !== undefined) options.terminalStatuses = scheduler.terminalStatuses
		if (scheduler.now !== undefined) options.now = scheduler.now
		if (scheduler.runIdFactory !== undefined) options.runIdFactory = scheduler.runIdFactory
		if (scheduler.statusFromExit !== undefined) options.statusFromExit = scheduler.statusFromExit
		if (scheduler.onEvent !== undefined) options.onEvent = scheduler.onEvent
		return options
	}
}

export async function startCoderLoopDaemon(options: StartCoderLoopDaemonOptions = {}): Promise<CoderLoopDaemon> {
	return await new CoderLoopDaemon(options).start()
}

export async function sendDaemonRequest(socketPath: string, request: Omit<DaemonRequest, "args"> & { args?: JsonObject }): Promise<DaemonResponse> {
	return await new Promise((resolveResponse, reject) => {
		const socket = createConnection(socketPath)
		let buffer = ""
		socket.setEncoding("utf-8")
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ ...request, args: request.args ?? {} })}\n`)
		})
		socket.on("data", (chunk: string) => {
			buffer += chunk
			const newlineIndex = buffer.indexOf("\n")
			if (newlineIndex === -1) return
			const line = buffer.slice(0, newlineIndex)
			socket.end()
			try {
				resolveResponse(parseDaemonResponse(line))
			} catch (error) {
				reject(error)
			}
		})
		socket.on("error", reject)
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

function defaultDaemonPrompt(): string {
	return "coder-loop daemon scheduler placeholder; full prompt binding is owned by later central-state migration issues."
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

function optionalInteger(record: UnknownRecord, key: string): number | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer when provided`)
	return value
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

function itemToJson(item: ItemRecord): JsonObject {
	return {
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
}

export function runToJson(run: RunRecord): JsonObject {
	return {
		id: run.id,
		runId: run.runId,
		chainId: run.chainId,
		itemId: run.itemId,
		phase: run.phase,
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
	return new DaemonError("daemon_start_failed", `unable to start coder-loop daemon: ${errorMessage(error)}`, details)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
