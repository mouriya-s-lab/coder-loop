import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { type as arkType } from "arktype"
import { parseDaemonRequest } from "./daemon-protocol"

export type CliIo = {
	readonly stdout: (text: string) => void
	readonly stderr: (text: string) => void
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
	try {
		const invocation = await parseInvocation(argv)
		const parsed = parseDaemonRequest({ schemaVersion: 3, requestId: randomUUID(), caller: invocation.caller, command: invocation.command })
		if (parsed.kind === "rejected") throw new Error(parsed.rejection.issues.join("; "))
		const response = await requestDaemon(invocation.socket, parsed.request, 8 * 1024 * 1024)
		io.stdout(`${JSON.stringify(response.value, null, 2)}\n`)
		return response.outcomeKind === "success" ? 0 : 1
	} catch (error) {
		io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	}
}

type CliInvocation = {
	readonly socket: string
	readonly caller: unknown
	readonly command: unknown
}

const ResponseBoundary = arkType({ schemaVersion: "3", requestId: "string|null", outcome: { kind: "'success'|'rejected'|'failure'", "[string]": "unknown" }, "+": "reject" })

type ParsedResponse = {
	readonly outcomeKind: "success" | "rejected" | "failure"
	readonly value: typeof ResponseBoundary.infer
}

async function parseInvocation(argv: readonly string[]): Promise<CliInvocation> {
	const args = [...argv]
	const socket = takeOption(args, "--socket") ?? process.env.CODER_LOOP_SOCKET ?? null
	if (socket === null) throw new Error("--socket is required when CODER_LOOP_SOCKET is unset")
	const resource = args.shift()
	const action = args[0]?.startsWith("--") === false ? args.shift() : undefined
	if (resource === "definition" && action === "publish") {
		const definitionPath = requiredOption(args, "--definition")
		const assetMapPath = requiredOption(args, "--assets")
		assertNoArgs(args)
		const definition: unknown = JSON.parse(await readFile(definitionPath, "utf8"))
		const assetPaths: unknown = JSON.parse(await readFile(assetMapPath, "utf8"))
		const assetMap = arkType({ "[string]": "string" })(assetPaths)
		if (assetMap instanceof arkType.errors) throw new Error(assetMap.summary)
		const assets = Object.fromEntries(await Promise.all(Object.entries(assetMap).map(async ([name, path]) => [name, await readFile(path, "utf8")])))
		return { socket, caller: { kind: "operator" }, command: { kind: "definition-publish", definition, assets } }
	}
	if (resource === "chain" && action === "bootstrap") {
		const chain = requiredOption(args, "--chain")
		const definition = await readJsonOption(args, "--definition-ref")
		const basePin = requiredOption(args, "--base-pin")
		const input = await readJsonOption(args, "--input")
		const priorityText = requiredOption(args, "--priority")
		const priority = Number(priorityText)
		if (!Number.isInteger(priority)) throw new Error("--priority must be an integer")
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "chain-bootstrap", chain: { kind: "chain", value: chain }, definition, basePin, input, priority } }
	}
	if (resource === "status" && action === undefined) {
		const chain = requiredOption(args, "--chain")
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "status-read", chain: { kind: "chain", value: chain } } }
	}
	if (resource === "events" && action === undefined) {
		const chain = requiredOption(args, "--chain")
		const sinceText = requiredOption(args, "--since")
		const since = Number(sinceText)
		if (!Number.isFinite(since)) throw new Error("--since must be a finite number")
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "events-read", chain: { kind: "chain", value: chain }, since } }
	}
	if (resource === "audit" && action === undefined) {
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "audit-read" } }
	}
	if (resource === "task" && action === "admit") {
		const chain = requiredOption(args, "--chain")
		const request = await readJsonOption(args, "--file")
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "task-admit", chain: { kind: "chain", value: chain }, request } }
	}
	if (resource === "task" && action === "unhold") {
		const chain = requiredOption(args, "--chain")
		const task = requiredOption(args, "--task")
		const commandIdentity = requiredOption(args, "--identity")
		assertNoArgs(args)
		return { socket, caller: { kind: "operator" }, command: { kind: "task-unhold", task: { kind: "task", chain: { kind: "chain", value: chain }, value: task }, commandIdentity } }
	}
	if (resource === "agent" && action === "admit") {
		const authorityPath = takeOption(args, "--authority")
		const authority: unknown = authorityPath === null
			? parseEnvironmentJson("CODER_LOOP_AGENT_AUTHORITY")
			: JSON.parse(await readFile(authorityPath, "utf8"))
		const chain = requiredOption(args, "--chain")
		const request = await readJsonOption(args, "--file")
		assertNoArgs(args)
		return { socket, caller: { kind: "agent", authority }, command: { kind: "task-admit", chain: { kind: "chain", value: chain }, request } }
	}
	if (resource === "agent" && action === "await") {
		const authorityPath = takeOption(args, "--authority")
		const authority: unknown = authorityPath === null
			? parseEnvironmentJson("CODER_LOOP_AGENT_AUTHORITY")
			: JSON.parse(await readFile(authorityPath, "utf8"))
		const site = requiredOption(args, "--site")
		const sessionIdentity = requiredOption(args, "--session")
		const child = await readJsonOption(args, "--child")
		assertNoArgs(args)
		return { socket, caller: { kind: "agent", authority }, command: { kind: "agent-await", site, sessionIdentity, child } }
	}
	if (resource === "agent" && action === "submit") {
		const authorityPath = takeOption(args, "--authority")
		const authority: unknown = authorityPath === null
			? parseEnvironmentJson("CODER_LOOP_AGENT_AUTHORITY")
			: JSON.parse(await readFile(authorityPath, "utf8"))
		const values = await readJsonOption(args, "--values")
		assertNoArgs(args)
		return { socket, caller: { kind: "agent", authority }, command: { kind: "agent-submit", values } }
	}
	throw new Error("usage: coder-loop-v3 --socket PATH <definition publish|chain bootstrap|status|events|audit|task admit|task unhold|agent admit|agent await|agent submit> [options]")
}

function requestDaemon(socketPath: string, request: unknown, maxResponseBytes: number): Promise<ParsedResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<ParsedResponse>()
	const socket = createConnection(socketPath)
	let buffer = ""
	let settled = false
	const fail = (error: Error): void => {
		if (settled) return
		settled = true
		socket.destroy()
		reject(error)
	}
	socket.setEncoding("utf8")
	socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
	socket.on("data", (chunk: string) => {
		buffer += chunk
		if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) return fail(new Error("daemon response exceeds maximum size"))
		const newline = buffer.indexOf("\n")
		if (newline < 0) return
		let candidate: unknown
		try { candidate = JSON.parse(buffer.slice(0, newline)) }
		catch (error) { return fail(new Error(`daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)) }
		const parsed = ResponseBoundary(candidate)
		if (parsed instanceof arkType.errors) return fail(new Error(`daemon returned an invalid response: ${parsed.summary}`))
		settled = true
		socket.end()
		resolve({ outcomeKind: parsed.outcome.kind, value: parsed })
	})
	socket.once("error", fail)
	socket.once("end", () => { if (!settled) fail(new Error("daemon closed before returning a response")) })
	return promise
}

function parseEnvironmentJson(name: string): unknown {
	const raw = process.env[name]
	if (raw === undefined) throw new Error(`${name} is required when --authority is unset`)
	return JSON.parse(raw)
}

async function readJsonOption(args: string[], option: string): Promise<unknown> {
	return JSON.parse(await readFile(requiredOption(args, option), "utf8"))
}

function requiredOption(args: string[], name: string): string {
	const value = takeOption(args, name)
	if (value === null) throw new Error(`${name} is required`)
	return value
}

function takeOption(args: string[], name: string): string | null {
	const index = args.indexOf(name)
	if (index < 0) return null
	const value = args[index + 1]
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`)
	args.splice(index, 2)
	return value
}

function assertNoArgs(args: readonly string[]): void {
	if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(" ")}`)
}

const defaultIo: CliIo = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
}
