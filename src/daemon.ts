import { spawn, type ChildProcess } from "node:child_process"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { homedir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { createWriteStream, existsSync, type WriteStream } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

import {
	DEFAULT_STATE_DB_PATH,
	type Chain,
	type Item,
	type ItemPatch,
	type NewItem,
	openStateStore,
	type StateStore,
} from "./state-db"
import {
	clearSchedulerRun,
	createSchedulerState,
	runSchedulerTick,
	type SchedulerRun,
	type SchedulerState,
	type SchedulerTickResult,
} from "./scheduler"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export const DEFAULT_DAEMON_ROOT = resolve(homedir(), "Ext/loop-data")
export const DEFAULT_DAEMON_SOCKET_PATH = resolve(DEFAULT_DAEMON_ROOT, "daemon.sock")
export const DEFAULT_DAEMON_PID_PATH = resolve(DEFAULT_DAEMON_ROOT, "daemon.pid")
export const DEFAULT_DAEMON_SCHEDULER_INTERVAL_MS = 5_000
export const DAEMON_CHILD_GRACE_MS = 5_000

export type DaemonRequest =
	| {
			cmd: "chain.create"
			name: string
			preset: string
			repo?: string
			baseBranch?: string
			umbrellaIssue?: number
			umbrellaRepo?: string
	  }
	| { cmd: "chain.list" }
	| { cmd: "chain.get"; chain: string | number }
	| { cmd: "chain.complete"; chain: string | number }
	| { cmd: "item.add"; chain: string | number; issue: number; repoCwd: string; priority?: string; extra?: JsonObject }
	| { cmd: "item.update"; itemId: number; patch: ItemPatch }
	| { cmd: "item.list"; chain: string | number; status?: string }
	| { cmd: "slot.list" }
	| { cmd: "daemon.status" }
	| { cmd: "daemon.shutdown" }

export type DaemonResponse =
	| { ok: true; data: JsonValue }
	| { ok: false; error: string }

export type DaemonServerOptions = {
	socketPath?: string
	pidPath?: string
	dbPath?: string
	rootDir?: string
	schedulerIntervalMs?: number
	spawnAgents?: boolean
	processArgs?: string[]
}

export type DaemonServerHandle = {
	socketPath: string
	pidPath: string
	dbPath: string
	startedAt: string
	ready: Promise<void>
	shutdown: () => Promise<void>
}

type DaemonRuntime = {
	socketPath: string
	pidPath: string
	dbPath: string
	rootDir: string
	startedAt: string
	server: Server
	store: StateStore
	schedulerState: SchedulerState
	children: Map<string, ChildProcess>
	engineLog: WriteStream
	stdoutLog: WriteStream
	stderrLog: WriteStream
	schedulerIntervalMs: number
	spawnAgents: boolean
	processArgs: string[]
	schedulerTimer: NodeJS.Timeout | null
	lastTick: SchedulerTickResult | null
	shuttingDown: boolean
}

export function daemonDefaults(options: DaemonServerOptions = {}): Required<Pick<DaemonServerOptions, "socketPath" | "pidPath" | "dbPath" | "rootDir" | "schedulerIntervalMs" | "spawnAgents">> {
	const rootDir = resolve(options.rootDir ?? DEFAULT_DAEMON_ROOT)
	return {
		rootDir,
		socketPath: resolve(options.socketPath ?? resolve(rootDir, "daemon.sock")),
		pidPath: resolve(options.pidPath ?? resolve(rootDir, "daemon.pid")),
		dbPath: resolve(options.dbPath ?? DEFAULT_STATE_DB_PATH),
		schedulerIntervalMs: options.schedulerIntervalMs ?? DEFAULT_DAEMON_SCHEDULER_INTERVAL_MS,
		spawnAgents: options.spawnAgents ?? true,
	}
}

export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerHandle> {
	const defaults = daemonDefaults(options)
	await mkdir(defaults.rootDir, { recursive: true })
	await removeStaleSocket(defaults.socketPath)
	const logDir = await prepareDaemonLogDir(defaults.rootDir, defaults.dbPath)
	const engineLog = createWriteStream(resolve(logDir, "engine.log"), { flags: "a" })
	const stdoutLog = createWriteStream(resolve(logDir, "stdout.log"), { flags: "a" })
	const stderrLog = createWriteStream(resolve(logDir, "stderr.log"), { flags: "a" })
	const runtime: DaemonRuntime = {
		...defaults,
		startedAt: new Date().toISOString(),
		server: createServer(),
		store: openStateStore(defaults.dbPath),
		schedulerState: createSchedulerState(),
		children: new Map(),
		engineLog,
		stdoutLog,
		stderrLog,
		schedulerTimer: null,
		lastTick: null,
		shuttingDown: false,
		processArgs: options.processArgs ?? [process.argv[0] ?? "bun", resolve(import.meta.dir, "loop.ts")],
	}

	runtime.server.on("connection", (socket) => handleSocket(runtime, socket))
	runtime.server.on("error", (error) => logEngine(runtime, `server error: ${errorMessage(error)}`))

	await new Promise<void>((resolveReady, rejectReady) => {
		runtime.server.once("error", rejectReady)
		runtime.server.listen(runtime.socketPath, () => {
			runtime.server.off("error", rejectReady)
			resolveReady()
		})
	})
	await writeFile(runtime.pidPath, `${process.pid}\n`)
	logEngine(runtime, `daemon started pid=${process.pid} socket=${runtime.socketPath} db=${runtime.dbPath}`)
	startScheduler(runtime)

	const shutdown = () => shutdownDaemon(runtime)
	process.once("SIGTERM", () => {
		void shutdown().then(() => process.exit(0))
	})
	process.once("SIGINT", () => {
		void shutdown().then(() => process.exit(0))
	})

	return {
		socketPath: runtime.socketPath,
		pidPath: runtime.pidPath,
		dbPath: runtime.dbPath,
		startedAt: runtime.startedAt,
		ready: Promise.resolve(),
		shutdown,
	}
}

export async function sendDaemonRequest(socketPath: string, request: DaemonRequest, timeoutMs = 5_000): Promise<DaemonResponse> {
	return await new Promise<DaemonResponse>((resolveResponse, rejectResponse) => {
		const socket = createConnection(socketPath)
		let buffer = ""
		const timer = setTimeout(() => {
			socket.destroy()
			rejectResponse(new Error(`daemon request timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`))
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8")
			const newline = buffer.indexOf("\n")
			if (newline === -1) return
			const line = buffer.slice(0, newline)
			clearTimeout(timer)
			socket.end()
			resolveResponse(parseDaemonResponse(line))
		})
		socket.on("error", (error) => {
			clearTimeout(timer)
			rejectResponse(error)
		})
		socket.on("end", () => {
			if (buffer.trim() === "") {
				clearTimeout(timer)
				rejectResponse(new Error("daemon closed connection without response"))
			}
		})
	})
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) return
	try {
		await sendDaemonRequest(socketPath, { cmd: "daemon.status" }, 500)
		throw new Error(`daemon is already listening on ${socketPath}`)
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("daemon is already listening")) throw error
		await rm(socketPath, { force: true })
	}
}

async function prepareDaemonLogDir(rootDir: string, dbPath: string): Promise<string> {
	const store = openStateStore(dbPath)
	try {
		const chains = store.listActiveChains()
		const chainName = chains[0]?.name ?? "_global"
		const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
		const dir = resolve(rootDir, "chains", sanitizePathSegment(chainName), "daemon", timestamp)
		await mkdir(dir, { recursive: true })
		await writeFile(resolve(dir, "stdout.log"), "", { flag: "a" })
		await writeFile(resolve(dir, "stderr.log"), "", { flag: "a" })
		await writeFile(resolve(dir, "engine.log"), "", { flag: "a" })
		return dir
	} finally {
		store.close()
	}
}

function handleSocket(runtime: DaemonRuntime, socket: Socket): void {
	let buffer = ""
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf-8")
		let newline = buffer.indexOf("\n")
		while (newline !== -1) {
			const line = buffer.slice(0, newline)
			buffer = buffer.slice(newline + 1)
			void handleRequestLine(runtime, socket, line)
			newline = buffer.indexOf("\n")
		}
	})
	socket.on("error", (error) => logEngine(runtime, `socket error: ${errorMessage(error)}`))
}

async function handleRequestLine(runtime: DaemonRuntime, socket: Socket, line: string): Promise<void> {
	const response = await processDaemonRequest(runtime, line)
	socket.write(`${JSON.stringify(response)}\n`, () => {
		if (isShutdownRequest(line)) void shutdownDaemon(runtime)
	})
}

export async function processDaemonRequest(runtime: Pick<DaemonRuntime, "store" | "schedulerState" | "children" | "socketPath" | "pidPath" | "dbPath" | "startedAt" | "schedulerIntervalMs" | "spawnAgents" | "lastTick" | "shuttingDown">, line: string): Promise<DaemonResponse> {
	try {
		const request = parseDaemonRequest(line)
		switch (request.cmd) {
			case "chain.create":
				return ok(upsertChain(runtime.store, request))
			case "chain.list":
				return ok(runtime.store.listChains())
			case "chain.get":
				return ok(requireChain(runtime.store, request.chain))
			case "chain.complete":
				return ok(runtime.store.completeChain(requireChain(runtime.store, request.chain).id))
			case "item.add":
				return ok(runtime.store.addItem(requireChain(runtime.store, request.chain).id, newItemFromRequest(request)))
			case "item.update":
				return ok(runtime.store.updateItem(request.itemId, request.patch))
			case "item.list":
				return ok(runtime.store.listItems(requireChain(runtime.store, request.chain).id, request.status ?? null))
			case "slot.list":
				return ok([...runtime.schedulerState.slots.values()])
			case "daemon.status":
				return ok(daemonStatus(runtime))
			case "daemon.shutdown":
				return ok({ shuttingDown: true })
		}
	} catch (error) {
		return { ok: false, error: errorMessage(error) }
	}
}

function upsertChain(store: StateStore, request: Extract<DaemonRequest, { cmd: "chain.create" }>): Chain {
	const existing = store.getChain(request.name)
	if (existing !== null) return existing
	return store.createChain(
		request.name,
		request.preset,
		request.repo ?? null,
		request.baseBranch ?? null,
		request.umbrellaIssue ?? null,
		request.umbrellaRepo ?? null,
	)
}

function newItemFromRequest(request: Extract<DaemonRequest, { cmd: "item.add" }>): NewItem {
	return {
		issue: request.issue,
		repoCwd: request.repoCwd,
		priority: request.priority ?? "medium",
		extra: request.extra ?? {},
	}
}

function daemonStatus(runtime: Pick<DaemonRuntime, "socketPath" | "pidPath" | "dbPath" | "startedAt" | "schedulerIntervalMs" | "spawnAgents" | "lastTick" | "shuttingDown" | "schedulerState" | "children">): JsonObject {
	return {
		pid: process.pid,
		socketPath: runtime.socketPath,
		pidPath: runtime.pidPath,
		dbPath: runtime.dbPath,
		startedAt: runtime.startedAt,
		schedulerIntervalMs: runtime.schedulerIntervalMs,
		spawnAgents: runtime.spawnAgents,
		shuttingDown: runtime.shuttingDown,
		activeChildren: runtime.children.size,
		slots: [...runtime.schedulerState.slots.values()] as unknown as JsonValue,
		lastTick: runtime.lastTick === null ? null : {
			activeChains: runtime.lastTick.activeChains,
			spawned: runtime.lastTick.spawned.length,
			completedChains: runtime.lastTick.completedChains.map((chain) => chain.name),
			skippedBusySlots: runtime.lastTick.skippedBusySlots.length,
		},
	}
}

function requireChain(store: StateStore, idOrName: number | string): Chain {
	const chain = store.getChain(idOrName)
	if (chain === null) throw new Error(`chain not found: ${String(idOrName)}`)
	return chain
}

function startScheduler(runtime: DaemonRuntime): void {
	const tick = async () => {
		if (runtime.shuttingDown) return
		try {
			runtime.lastTick = await runSchedulerTick({
				store: runtime.store,
				state: runtime.schedulerState,
				spawnAgent: (input): SchedulerRun => spawnAgentForItem(runtime, input.item),
			})
			for (const chain of runtime.lastTick.completedChains) logEngine(runtime, `chain completed: ${chain.name}`)
		} catch (error) {
			logEngine(runtime, `scheduler tick failed: ${errorMessage(error)}`)
		}
	}
	runtime.schedulerTimer = setInterval(() => void tick(), runtime.schedulerIntervalMs)
}

function spawnAgentForItem(runtime: DaemonRuntime, item: Item): SchedulerRun {
	if (!runtime.spawnAgents) throw new Error("scheduler spawn requested while spawnAgents=false")
	const runId = `daemon-${item.id}-${Date.now()}`
	const child = spawn(runtime.processArgs[0]!, [
		...runtime.processArgs.slice(1),
		"--target-cwd",
		item.repoCwd,
		"--once",
	], {
		cwd: item.repoCwd,
		stdio: ["ignore", "pipe", "pipe"],
	})
	runtime.children.set(runId, child)
	child.stdout?.on("data", (chunk) => runtime.stdoutLog.write(chunk))
	child.stderr?.on("data", (chunk) => runtime.stderrLog.write(chunk))
	child.once("exit", (code, signal) => {
		runtime.children.delete(runId)
		clearSchedulerRun(runtime.schedulerState, runId)
		logEngine(runtime, `agent exited run=${runId} item=${item.id} code=${code ?? "<null>"} signal=${signal ?? "<null>"}`)
	})
	logEngine(runtime, `agent spawned run=${runId} item=${item.id} repo=${item.repoCwd} pid=${child.pid ?? "<null>"}`)
	return { runId, pid: child.pid ?? -1, itemId: item.id }
}

async function shutdownDaemon(runtime: DaemonRuntime): Promise<void> {
	if (runtime.shuttingDown) return
	runtime.shuttingDown = true
	logEngine(runtime, "daemon shutdown requested")
	if (runtime.schedulerTimer !== null) clearInterval(runtime.schedulerTimer)
	for (const [runId, child] of runtime.children) {
		logEngine(runtime, `sending SIGTERM to child run=${runId} pid=${child.pid ?? "<null>"}`)
		child.kill("SIGTERM")
	}
	await waitForChildren(runtime.children, DAEMON_CHILD_GRACE_MS)
	for (const [runId, child] of runtime.children) {
		logEngine(runtime, `sending SIGKILL to child run=${runId} pid=${child.pid ?? "<null>"}`)
		child.kill("SIGKILL")
	}
	await new Promise<void>((resolveClose) => runtime.server.close(() => resolveClose()))
	runtime.store.close()
	await rm(runtime.socketPath, { force: true })
	await rm(runtime.pidPath, { force: true })
	logEngine(runtime, "daemon shutdown complete")
	runtime.engineLog.end()
	runtime.stdoutLog.end()
	runtime.stderrLog.end()
}

async function waitForChildren(children: Map<string, ChildProcess>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (children.size > 0 && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 50))
	}
}

function parseDaemonRequest(line: string): DaemonRequest {
	const parsed: unknown = JSON.parse(line)
	if (!isObjectRecord(parsed)) throw new Error("request must be a JSON object")
	const cmd = readString(parsed, "cmd")
	switch (cmd) {
		case "chain.create":
			return withOptionalFields({
				cmd,
				name: readString(parsed, "name"),
				preset: readString(parsed, "preset"),
			}, {
				repo: readOptionalString(parsed, "repo"),
				baseBranch: readOptionalString(parsed, "baseBranch"),
				umbrellaIssue: readOptionalInteger(parsed, "umbrellaIssue"),
				umbrellaRepo: readOptionalString(parsed, "umbrellaRepo"),
			}) as DaemonRequest
		case "chain.list":
			return { cmd }
		case "chain.get":
		case "chain.complete":
			return { cmd, chain: readStringOrInteger(parsed, "chain") }
		case "item.add":
			return withOptionalFields({
				cmd,
				chain: readStringOrInteger(parsed, "chain"),
				issue: readInteger(parsed, "issue"),
				repoCwd: readString(parsed, "repoCwd"),
			}, {
				priority: readOptionalString(parsed, "priority"),
				extra: readOptionalJsonObject(parsed, "extra"),
			}) as DaemonRequest
		case "item.update":
			return { cmd, itemId: readInteger(parsed, "itemId"), patch: readItemPatch(parsed, "patch") }
		case "item.list":
			return withOptionalFields({
				cmd,
				chain: readStringOrInteger(parsed, "chain"),
			}, {
				status: readOptionalString(parsed, "status"),
			}) as DaemonRequest
		case "slot.list":
		case "daemon.status":
		case "daemon.shutdown":
			return { cmd }
		default:
			throw new Error(`unknown daemon command: ${cmd}`)
	}
}

function parseDaemonResponse(line: string): DaemonResponse {
	const parsed: unknown = JSON.parse(line)
	if (!isObjectRecord(parsed)) throw new Error("daemon response must be a JSON object")
	if (parsed.ok === true) return { ok: true, data: isJsonValue(parsed.data) ? parsed.data : null }
	if (parsed.ok === false && typeof parsed.error === "string") return { ok: false, error: parsed.error }
	throw new Error("daemon response must be {ok:true,data} or {ok:false,error}")
}

function readItemPatch(value: Record<string, unknown>, key: string): ItemPatch {
	const raw = value[key]
	if (!isObjectRecord(raw)) throw new Error(`${key}: expected object`)
	const patch: ItemPatch = {}
	for (const [patchKey, patchValue] of Object.entries(raw)) {
		switch (patchKey) {
			case "status":
				if (typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string`)
				patch.status = patchValue
				break
			case "priority":
				if (typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string`)
				patch.priority = patchValue
				break
			case "title":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.title = patchValue
				break
			case "branch":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.branch = patchValue
				break
			case "lastRunId":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.lastRunId = patchValue
				break
			case "issueFile":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.issueFile = patchValue
				break
			case "evidenceDir":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.evidenceDir = patchValue
				break
			case "agentCwd":
				if (patchValue !== null && typeof patchValue !== "string") throw new Error(`patch.${patchKey}: expected string or null`)
				patch.agentCwd = patchValue
				break
			case "attempts":
				if (typeof patchValue !== "number" || !Number.isInteger(patchValue)) throw new Error(`patch.${patchKey}: expected integer`)
				patch.attempts = patchValue
				break
			case "pr":
				if (patchValue !== null && (!Number.isInteger(patchValue) || typeof patchValue !== "number")) throw new Error(`patch.${patchKey}: expected integer or null`)
				patch.pr = patchValue
				break
			case "runner":
				if (patchValue !== null && patchValue !== "claude" && patchValue !== "codex") throw new Error("patch.runner: expected claude, codex, or null")
				patch.runner = patchValue
				break
			case "extra":
				if (!isJsonObject(patchValue)) throw new Error("patch.extra: expected JSON object")
				patch.extra = patchValue
				break
			default:
				throw new Error(`unsupported item patch field: ${patchKey}`)
		}
	}
	return patch
}

function withOptionalFields<T extends Record<string, unknown>, U extends Record<string, unknown>>(
	required: T,
	optional: U,
): T & Partial<U> {
	const out: Record<string, unknown> = { ...required }
	for (const [key, value] of Object.entries(optional)) {
		if (value !== undefined) out[key] = value
	}
	return out as T & Partial<U>
}

function isShutdownRequest(line: string): boolean {
	try {
		const parsed: unknown = JSON.parse(line)
		return isObjectRecord(parsed) && parsed.cmd === "daemon.shutdown"
	} catch {
		return false
	}
}

function ok(data: JsonValue): DaemonResponse {
	return { ok: true, data }
}

function readString(value: Record<string, unknown>, key: string): string {
	const raw = value[key]
	if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${key}: expected non-empty string`)
	return raw
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	const raw = value[key]
	if (raw === undefined) return undefined
	if (typeof raw !== "string") throw new Error(`${key}: expected string`)
	return raw
}

function readInteger(value: Record<string, unknown>, key: string): number {
	const raw = value[key]
	if (typeof raw !== "number" || !Number.isInteger(raw)) throw new Error(`${key}: expected integer`)
	return raw
}

function readOptionalInteger(value: Record<string, unknown>, key: string): number | undefined {
	const raw = value[key]
	if (raw === undefined) return undefined
	if (typeof raw !== "number" || !Number.isInteger(raw)) throw new Error(`${key}: expected integer`)
	return raw
}

function readStringOrInteger(value: Record<string, unknown>, key: string): string | number {
	const raw = value[key]
	if (typeof raw === "string" && raw.trim() !== "") return raw
	if (typeof raw === "number" && Number.isInteger(raw)) return raw
	throw new Error(`${key}: expected string or integer`)
}

function readOptionalJsonObject(value: Record<string, unknown>, key: string): JsonObject | undefined {
	const raw = value[key]
	if (raw === undefined) return undefined
	if (!isJsonObject(raw)) throw new Error(`${key}: expected JSON object`)
	return raw
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

function logEngine(runtime: Pick<DaemonRuntime, "engineLog">, message: string): void {
	runtime.engineLog.write(`${new Date().toISOString()} ${message}\n`)
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^\.+|\.+$/g, "") || "unnamed"
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function defaultChainNameForTarget(targetCwd: string): string {
	return basename(resolve(targetCwd)) || "default"
}

export async function importTargetStateIntoStore(store: StateStore, targetCwd: string, preset: string, repository: string | null, baseBranch: string | null): Promise<{ chain: Chain; itemsImported: number }> {
	const statePath = resolve(targetCwd, ".coder-loop/runtime/state.json")
	const raw = await readFile(statePath, "utf-8")
	const parsed: unknown = JSON.parse(raw)
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.queue)) throw new Error(`${statePath}: expected state object with queue array`)
	const chainRequest = withOptionalFields({
		cmd: "chain.create",
		name: defaultChainNameForTarget(targetCwd),
		preset,
	}, {
		repo: repository ?? undefined,
		baseBranch: baseBranch ?? undefined,
	}) as Extract<DaemonRequest, { cmd: "chain.create" }>
	const chain = upsertChain(store, chainRequest)
	let itemsImported = 0
	for (const entry of parsed.queue) {
		if (!isObjectRecord(entry) || typeof entry.issue !== "number") continue
		try {
			store.addItem(chain.id, {
				issue: entry.issue,
				repoCwd: targetCwd,
				status: typeof entry.status === "string" ? entry.status : "queued",
				priority: typeof entry.priority === "string" ? entry.priority : "medium",
				attempts: typeof entry.attempts === "number" ? entry.attempts : 0,
				title: typeof entry.title === "string" ? entry.title : null,
				branch: typeof entry.branch === "string" ? entry.branch : null,
				pr: typeof entry.pr === "number" ? entry.pr : null,
				lastRunId: typeof entry.lastRunId === "string" ? entry.lastRunId : null,
				issueFile: typeof entry.issueFile === "string" ? entry.issueFile : null,
				evidenceDir: typeof entry.evidenceDir === "string" ? entry.evidenceDir : null,
				agentCwd: typeof entry.agentCwd === "string" ? entry.agentCwd : null,
				runner: entry.runner === "claude" || entry.runner === "codex" ? entry.runner : null,
				extra: {},
			})
			itemsImported++
		} catch (error) {
			if (!errorMessage(error).includes("UNIQUE constraint failed")) throw error
		}
	}
	return { chain, itemsImported }
}
