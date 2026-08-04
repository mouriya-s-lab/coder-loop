import { chmod, mkdir, open, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer } from "effect"
import { DaemonProtocol, type DaemonProtocolService } from "./daemon-handler"

export type DaemonTransportError = {
	readonly kind: "daemon-transport-error"
	readonly operation: "listen" | "frame" | "socket"
	readonly message: string
}

export type DaemonSocketConfig = {
	readonly operatorPath: string
	readonly agentPath: string
	readonly maxFrameBytes: number
	readonly maxResponseBytes: number
	readonly onError: (error: DaemonTransportError) => void
}

export type DaemonSocketService = {
	readonly operatorPath: string
	readonly agentPath: string
	readonly stop: Effect.Effect<void>
}

export class DaemonSocket extends Context.Tag("coder-loop/v3/DaemonSocket")<DaemonSocket, DaemonSocketService>() {}

type CallerKind = "operator" | "agent"
type PendingWrite = {
	readonly bytes: Uint8Array
	offset: number
	readonly resolve: () => void
	readonly reject: (error: Error) => void
}

type SocketState = {
	readonly decoder: TextDecoder
	buffer: string
	receivedBytes: number
	acceptedFrame: boolean
	pendingWrite: PendingWrite | null
}

type BoundListener = {
	readonly path: string
	readonly listener: Bun.UnixSocketListener<SocketState>
}
type BoundSocketSet = {
	readonly listeners: readonly BoundListener[]
	readonly lockPath: string
}

export function makeDaemonSocketLive(config: DaemonSocketConfig): Layer.Layer<DaemonSocket, DaemonTransportError, DaemonProtocol> {
	if (!Number.isInteger(config.maxFrameBytes) || config.maxFrameBytes <= 0) throw new Error("maxFrameBytes must be a positive integer")
	if (!Number.isInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0) throw new Error("maxResponseBytes must be a positive integer")
	if (config.operatorPath === config.agentPath) throw new Error("operator and agent sockets must use different paths")
	return Layer.scoped(DaemonSocket, Effect.gen(function*() {
		const protocol = yield* DaemonProtocol
		const listeners = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () => bindAll(config, protocol),
				catch: (error): DaemonTransportError => ({ kind: "daemon-transport-error", operation: "listen", message: describeError(error) }),
			}),
			(bound) => stopAll(bound),
		)
		return {
			operatorPath: config.operatorPath,
			agentPath: config.agentPath,
			stop: stopAll(listeners),
		}
	}))
}

async function bindAll(config: DaemonSocketConfig, protocol: DaemonProtocolService): Promise<BoundSocketSet> {
	await mkdir(dirname(config.operatorPath), { recursive: true })
	await mkdir(dirname(config.agentPath), { recursive: true })
	const lockPath = `${config.operatorPath}.lock`
	await acquireDaemonLock(lockPath)
	try {
		await Promise.all([rm(config.operatorPath, { force: true }), rm(config.agentPath, { force: true })])
		const operator = bind(config, protocol, config.operatorPath, "operator")
		try {
			const agent = bind(config, protocol, config.agentPath, "agent")
			await Promise.all([chmod(config.operatorPath, 0o600), chmod(config.agentPath, 0o600)])
			return { listeners: [{ path: config.operatorPath, listener: operator }, { path: config.agentPath, listener: agent }], lockPath }
		} catch (error) {
			operator.stop(true)
			throw error
		}
	} catch (error) {
		await Promise.all([rm(config.operatorPath, { force: true }), rm(config.agentPath, { force: true }), rm(lockPath, { force: true })])
		throw error
	}
}

async function acquireDaemonLock(path: string): Promise<void> {
	const handle = await open(path, "wx", 0o600).catch(async (error) => {
		if (!isFsCode(error, "EEXIST")) throw error
		const owner = Number((await readFile(path, "utf8").catch(() => "")).trim())
		if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
			throw new Error(`daemon socket is already owned by live process ${owner}`)
		}
		await rm(path, { force: true })
		return open(path, "wx", 0o600)
	})
	try {
		await handle.writeFile(`${process.pid}\n`)
	} finally {
		await handle.close()
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !isFsCode(error, "ESRCH")
	}
}

function isFsCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function bind(config: DaemonSocketConfig, protocol: DaemonProtocolService, path: string, allowedCaller: CallerKind): Bun.UnixSocketListener<SocketState> {
	return Bun.listen<SocketState>({
		unix: path,
		socket: {
			open: (socket) => {
				socket.data = { decoder: new TextDecoder("utf-8", { fatal: true }), buffer: "", receivedBytes: 0, acceptedFrame: false, pendingWrite: null }
			},
			data: (socket, chunk) => {
				if (socket.data.acceptedFrame) {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: "connection accepts exactly one request frame" })
					socket.end()
					return
				}
				socket.data.receivedBytes += chunk.byteLength
				if (socket.data.receivedBytes > config.maxFrameBytes + 1) {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: "request frame exceeds maxFrameBytes" })
					socket.end()
					return
				}
				try {
					socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true })
				} catch (error) {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: describeError(error) })
					socket.end()
					return
				}
				const frameEnd = socket.data.buffer.indexOf("\n")
				if (frameEnd < 0) {
					if (Buffer.byteLength(socket.data.buffer, "utf8") > config.maxFrameBytes) {
						config.onError({ kind: "daemon-transport-error", operation: "frame", message: "request frame exceeds maxFrameBytes" })
						socket.end()
					}
					return
				}
				const frame = socket.data.buffer.slice(0, frameEnd)
				const backlog = socket.data.buffer.slice(frameEnd + 1)
				socket.data.buffer = ""
				if (Buffer.byteLength(frame, "utf8") > config.maxFrameBytes) {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: "request frame exceeds maxFrameBytes" })
					socket.end()
					return
				}
				if (backlog !== "") {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: "connection queued more than one request frame" })
					socket.end()
					return
				}
				socket.data.acceptedFrame = true
				socket.pause()
				processFrame(protocol, socket, frame, allowedCaller, config.maxResponseBytes).then(
					() => socket.end(),
					(error) => {
						config.onError({ kind: "daemon-transport-error", operation: "socket", message: describeError(error) })
						socket.end()
					},
				)
			},
			drain: (socket) => flushPendingWrite(socket),
			close: (socket) => {
				socket.data.pendingWrite?.reject(new Error("socket closed before the response was fully written"))
				socket.data.pendingWrite = null
				try {
					const tail = socket.data.decoder.decode()
					if (tail !== "" || socket.data.buffer !== "") config.onError({ kind: "daemon-transport-error", operation: "frame", message: "connection closed with an incomplete request frame" })
				} catch (error) {
					config.onError({ kind: "daemon-transport-error", operation: "frame", message: describeError(error) })
				}
			},
			error: (socket, error) => {
				socket.data.pendingWrite?.reject(error)
				socket.data.pendingWrite = null
				config.onError({ kind: "daemon-transport-error", operation: "socket", message: error.message })
			},
		},
	})
}

async function processFrame(protocol: DaemonProtocolService, socket: Bun.Socket<SocketState>, frame: string, allowedCaller: CallerKind, maxResponseBytes: number): Promise<void> {
	let candidate: unknown
	try {
		candidate = JSON.parse(frame)
	} catch {
		candidate = null
	}
	const response = await Effect.runPromise(protocol.handle(restrictCaller(candidate, allowedCaller)))
	await writeAll(socket, `${JSON.stringify(response)}\n`, maxResponseBytes)
}

function writeAll(socket: Bun.Socket<SocketState>, payload: string, maxResponseBytes: number): Promise<void> {
	if (socket.data.pendingWrite !== null) return Promise.reject(new Error("socket already has a pending response write"))
	if (Buffer.byteLength(payload, "utf8") > maxResponseBytes) return Promise.reject(new Error("daemon response exceeds maxResponseBytes"))
	const bytes = Buffer.from(payload)
	const { promise, resolve, reject } = Promise.withResolvers<void>()
	socket.data.pendingWrite = { bytes, offset: 0, resolve, reject }
	flushPendingWrite(socket)
	return promise
}

function flushPendingWrite(socket: Bun.Socket<SocketState>): void {
	const pending = socket.data.pendingWrite
	if (pending === null) return
	try {
		while (pending.offset < pending.bytes.byteLength) {
			const written = socket.write(pending.bytes.subarray(pending.offset))
			if (written <= 0) return
			pending.offset += written
			if (pending.offset < pending.bytes.byteLength) return
		}
		socket.data.pendingWrite = null
		pending.resolve()
	} catch (error) {
		socket.data.pendingWrite = null
		pending.reject(error instanceof Error ? error : new Error(String(error)))
	}
}

function restrictCaller(candidate: unknown, allowedCaller: CallerKind): unknown {
	if (typeof candidate !== "object" || candidate === null || !("caller" in candidate)) return candidate
	const caller = candidate.caller
	if (typeof caller === "object" && caller !== null && "kind" in caller && caller.kind === allowedCaller) return candidate
	return { ...candidate, caller: null }
}

function stopAll(bound: BoundSocketSet): Effect.Effect<void> {
	return Effect.promise(async () => {
		for (const { listener } of bound.listeners) listener.stop(true)
		await Promise.all([...bound.listeners.map(({ path }) => rm(path, { force: true })), rm(bound.lockPath, { force: true })])
	})
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
