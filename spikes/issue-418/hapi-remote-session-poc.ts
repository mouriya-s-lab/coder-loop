#!/usr/bin/env bun

import { resolve } from "node:path"
import { type as arkType } from "arktype"

const ArgsBoundary = arkType(["'run'", "string", "string", "string"]).or(["'archive'", "string"])
const EnvBoundary = arkType({ HOME: "string" })
const SettingsBoundary = arkType({
	apiUrl: "string",
	cliApiToken: "string",
	"machineId?": "string",
})
const AuthBoundary = arkType({
	token: "string",
	user: {
		id: "number",
		"username?": "string",
		"firstName?": "string",
		"lastName?": "string",
	},
})
const MachinesBoundary = arkType({
	machines: [{
		id: "string",
		active: "boolean",
		metadata: {
			"workspaceRoots?": "string[]",
		},
	}, "[]"],
})
const SpawnBoundary = arkType({
	type: "'success'",
	sessionId: "string",
}).or({
	type: "'error'",
	message: "string",
})
const SessionBoundary = arkType({
	session: {
		id: "string",
		active: "boolean",
		thinking: "boolean",
		activeAt: "number",
		thinkingAt: "number",
		updatedAt: "number",
		metadata: {
			path: "string",
			"machineId?": "string",
		},
	},
})
const SendBoundary = arkType({ ok: "true" })
const ArchiveBoundary = arkType({ ok: "true" })

type FailureKind = "configuration" | "transport" | "protocol" | "timeout"

class PocFailure extends Error {
	constructor(readonly kind: FailureKind, message: string) {
		super(message)
		this.name = "PocFailure"
	}
}

type HttpRequest =
	| { kind: "get"; path: string }
	| { kind: "post"; path: string; body: string }

type Client = Readonly<{
	apiUrl: string
	jwt: string
}>

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new PocFailure("protocol", `response is not JSON: ${detail}`)
	}
}

async function request(client: Client, input: HttpRequest): Promise<string> {
	let response: Response
	try {
		response = await fetch(`${client.apiUrl}${input.path}`, {
			method: input.kind === "get" ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${client.jwt}`,
				"content-type": "application/json",
				"user-agent": "hapi-remote-session-poc/issue-418",
			},
			...(input.kind === "post" ? { body: input.body } : {}),
		})
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new PocFailure("transport", detail)
	}
	const text = await response.text()
	if (!response.ok) throw new PocFailure("transport", `${input.path}: HTTP ${response.status}: ${text}`)
	return text
}

async function authenticate(apiUrl: string, accessToken: string): Promise<Client> {
	let response: Response
	try {
		response = await fetch(`${apiUrl}/api/auth`, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "hapi-remote-session-poc/issue-418" },
			body: JSON.stringify({ accessToken }),
		})
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new PocFailure("transport", detail)
	}
	const text = await response.text()
	if (!response.ok) throw new PocFailure("transport", `/api/auth: HTTP ${response.status}: ${text}`)
	const auth = AuthBoundary.assert(parseJson(text))
	return { apiUrl, jwt: auth.token }
}

function pathBelongsToRoot(cwd: string, root: string): boolean {
	const absoluteCwd = resolve(cwd)
	const absoluteRoot = resolve(root)
	return absoluteCwd === absoluteRoot || absoluteCwd.startsWith(`${absoluteRoot}/`)
}

async function chooseMachine(client: Client, cwd: string, preferredMachineId: string | undefined): Promise<string> {
	const parsed = MachinesBoundary.assert(parseJson(await request(client, { kind: "get", path: "/api/machines" })))
	const eligible = parsed.machines.filter((machine) =>
		machine.active && machine.metadata.workspaceRoots?.some((root) => pathBelongsToRoot(cwd, root)) === true,
	)
	const preferred = preferredMachineId === undefined
		? undefined
		: eligible.find((machine) => machine.id === preferredMachineId)
	const selected = preferred ?? eligible[0]
	if (selected === undefined) throw new PocFailure("configuration", `no active machine owns cwd ${cwd}`)
	return selected.id
}

async function getSession(client: Client, sessionId: string): Promise<typeof SessionBoundary.infer.session> {
	const text = await request(client, { kind: "get", path: `/api/sessions/${encodeURIComponent(sessionId)}` })
	return SessionBoundary.assert(parseJson(text)).session
}

async function waitUntilActive(client: Client, sessionId: string, deadline: number): Promise<typeof SessionBoundary.infer.session> {
	while (Date.now() < deadline) {
		const session = await getSession(client, sessionId)
		if (session.active) return session
		await Bun.sleep(500)
	}
	throw new PocFailure("timeout", `session ${sessionId} did not become active`)
}

async function waitUntilTurnComplete(client: Client, sessionId: string, baselineUpdatedAt: number, deadline: number): Promise<typeof SessionBoundary.infer.session> {
	while (Date.now() < deadline) {
		const session = await getSession(client, sessionId)
		if (!session.active) throw new PocFailure("transport", `session ${sessionId} became inactive while turn was pending`)
		if (!session.thinking && session.updatedAt > baselineUpdatedAt) return session
		await Bun.sleep(500)
	}
	throw new PocFailure("timeout", `session ${sessionId} did not finish the queued turn`)
}

async function run(): Promise<void> {
	const [, , ...rawArgs] = process.argv
	const args = ArgsBoundary.assert(rawArgs)
	const env = EnvBoundary.assert(process.env)
	const settingsText = await Bun.file(`${env.HOME}/.hapi/settings.json`).text()
	const settings = SettingsBoundary.assert(parseJson(settingsText))
	const client = await authenticate(settings.apiUrl.replace(/\/$/, ""), settings.cliApiToken)
	if (args[0] === "archive") {
		const archiveText = await request(client, {
			kind: "post",
			path: `/api/sessions/${encodeURIComponent(args[1])}/archive`,
			body: "{}",
		})
		ArchiveBoundary.assert(parseJson(archiveText))
		console.log(JSON.stringify({ type: "archived", sessionId: args[1] }))
		return
	}

	const [, cwdInput, prompt, resultFileInput] = args
	const cwd = resolve(cwdInput)
	const resultFile = resolve(resultFileInput)
	const machineId = await chooseMachine(client, cwd, settings.machineId)

	const spawnText = await request(client, {
		kind: "post",
		path: `/api/machines/${encodeURIComponent(machineId)}/spawn`,
		body: JSON.stringify({ directory: cwd, agent: "codex", yolo: true, sessionType: "simple" }),
	})
	const spawned = SpawnBoundary.assert(parseJson(spawnText))
	if (spawned.type === "error") throw new PocFailure("transport", `spawn failed: ${spawned.message}`)
	const session = await waitUntilActive(client, spawned.sessionId, Date.now() + 90_000)
	if (resolve(session.metadata.path) !== cwd) {
		throw new PocFailure("protocol", `HAPI bound session to ${session.metadata.path}, expected existing task worktree ${cwd}`)
	}

	const localId = `issue-418-${crypto.randomUUID()}`
	const sentText = await request(client, {
		kind: "post",
		path: `/api/sessions/${encodeURIComponent(spawned.sessionId)}/messages`,
		body: JSON.stringify({ text: prompt, localId }),
	})
	SendBoundary.assert(parseJson(sentText))
	const completed = await waitUntilTurnComplete(client, spawned.sessionId, session.updatedAt, Date.now() + 180_000)
	const result = await request(client, {
		kind: "get",
		path: `/api/sessions/${encodeURIComponent(spawned.sessionId)}/messages?limit=200`,
	})
	await Bun.write(resultFile, result)

	console.log(JSON.stringify({
		type: "completed",
		sessionId: spawned.sessionId,
		machineId,
		cwd,
		localId,
		active: completed.active,
		thinking: completed.thinking,
		resultFile,
	}))
}

try {
	await run()
} catch (error: unknown) {
	const failure = error instanceof PocFailure
		? error
		: new PocFailure("protocol", error instanceof Error ? error.message : String(error))
	console.error(JSON.stringify({ type: "failed", kind: failure.kind, message: failure.message }))
	process.exit(failure.kind === "configuration" ? 64 : failure.kind === "transport" ? 69 : failure.kind === "timeout" ? 75 : 70)
}
