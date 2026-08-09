import { createHash, randomUUID } from "node:crypto"
import { access, constants, link, mkdir, open, readFile, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type as arkType } from "arktype"
import { Context, Effect, Layer } from "effect"
import { isBoundaryRecord } from "../boundary-types"
import type { JsonValue } from "./definition"
import { parseDeclaredValue } from "./definition"
import type { RunIdentity } from "./object-domain"
import { runSubprocess, type SandboxDeclaration, type SubprocessOutcome, type SubprocessSpec } from "./subprocess"

export type RunnerKind = "claude" | "codex" | "opencode"

export type EndpointIdentity = {
	readonly kind: "runner-endpoint"
	readonly digest: string
}

export type EndpointDescriptor = {
	readonly transport: "local-process" | "remote-api" | "session"
	readonly server: string
	readonly principal: string
	readonly machine: string
	readonly profile: string
}

export type RunnerConfig = {
	readonly kind: RunnerKind
	readonly executable: string
	readonly model: string
	readonly endpoint: EndpointDescriptor
	readonly env: Readonly<Record<string, string>>
	readonly sandbox: SandboxDeclaration
	readonly launcher:
		| { readonly kind: "direct" }
		| { readonly kind: "sandbox-exec"; readonly executable: "/usr/bin/sandbox-exec" }
	readonly timeoutMs: number
	readonly termGraceMs: number
	readonly maxOutputBytes: number
}

export type RunnerInvocation = {
	readonly attemptIdentity: string
	readonly factIdentity: string
	readonly run: RunIdentity
	readonly prompt: string
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
	readonly continuation: { readonly kind: "fresh" } | { readonly kind: "resume"; readonly sessionIdentity: string }
	readonly allowedSocketPath: string
}

export type ProbeEvidence = {
	readonly observedAt: number
	readonly detail: string
}

export type EndpointProbe =
	| { readonly kind: "ready"; readonly endpoint: EndpointIdentity; readonly evidence: ProbeEvidence }
	| { readonly kind: "absent"; readonly endpoint: EndpointIdentity; readonly evidence: ProbeEvidence }
	| { readonly kind: "unknown"; readonly endpoint: EndpointIdentity; readonly evidence: ProbeEvidence }

export type ProviderFact =
	| { readonly kind: "pre-spawn-absence"; readonly endpoint: EndpointIdentity; readonly attemptIdentity: string; readonly evidence: ProbeEvidence }
	| { readonly kind: "terminal-winner"; readonly endpoint: EndpointIdentity; readonly run: RunIdentity; readonly payload: JsonValue; readonly sessionIdentity: string | null; readonly observedAt: number }
	| { readonly kind: "active-loss"; readonly endpoint: EndpointIdentity; readonly run: RunIdentity; readonly reason: "nonzero" | "timeout" | "signal"; readonly detail: string; readonly observedAt: number }
	| { readonly kind: "unknown-effect"; readonly endpoint: EndpointIdentity; readonly run: RunIdentity; readonly detail: string; readonly observedAt: number }

export type ProviderFactRecord = {
	readonly identity: string
	readonly fact: ProviderFact
}

export type ProviderFactStoreError = {
	readonly kind: "provider-fact-store-error"
	readonly operation: string
	readonly message: string
}

export type ProviderFactStoreService = {
	readonly commit: (identity: string, fact: ProviderFact) => Effect.Effect<ProviderFact, ProviderFactStoreError>
	readonly read: (identity: string) => Effect.Effect<ProviderFact | null, ProviderFactStoreError>
	readonly list: Effect.Effect<readonly ProviderFactRecord[], ProviderFactStoreError>
}

export class ProviderFactStore extends Context.Tag("coder-loop/v3/ProviderFactStore")<ProviderFactStore, ProviderFactStoreService>() {}

export function makeProviderFactStoreLive(root: string): Layer.Layer<ProviderFactStore> {
	return Layer.succeed(ProviderFactStore, {
		commit: (identity, fact) => Effect.tryPromise({ try: () => commitProviderFact(root, identity, fact), catch: (error) => factStoreError("commit", error) }),
		read: (identity) => Effect.tryPromise({ try: () => readProviderFact(root, identity), catch: (error) => factStoreError("read", error) }),
		list: Effect.tryPromise({ try: () => listProviderFacts(root), catch: (error) => factStoreError("list", error) }),
	})
}

export type RunnerProviderService = {
	readonly endpoint: EndpointIdentity
	readonly probe: Effect.Effect<EndpointProbe>
	readonly recordAbsence: (attemptIdentity: string, evidence: ProbeEvidence) => Effect.Effect<ProviderFact, ProviderFactStoreError>
	readonly invoke: (invocation: RunnerInvocation) => Effect.Effect<ProviderFact, ProviderFactStoreError>
}

export class RunnerProvider extends Context.Tag("coder-loop/v3/RunnerProvider")<RunnerProvider, RunnerProviderService>() {}

export function makeRunnerProviderLive(config: RunnerConfig): Layer.Layer<RunnerProvider, never, ProviderFactStore> {
	validateRunnerConfig(config)
	return Layer.effect(RunnerProvider, Effect.gen(function*() {
		const facts = yield* ProviderFactStore
		const endpoint = endpointIdentity(config)
		return {
			endpoint,
			probe: probeEndpoint(config, endpoint),
			recordAbsence: (attemptIdentity, evidence) => facts.commit(`absence/${endpoint.digest}/${attemptIdentity}`, {
				kind: "pre-spawn-absence",
				endpoint,
				attemptIdentity,
				evidence,
			}),
			invoke: (invocation) => Effect.flatMap(
				runSubprocess(buildSubprocessSpec(config, invocation)),
				(outcome) => facts.commit(invocation.factIdentity, providerFactFromOutcome(endpoint, invocation.run, config.kind, outcome)),
			),
		}
	}))
}

export function endpointIdentity(config: RunnerConfig): EndpointIdentity {
	const canonical = JSON.stringify({ kind: config.kind, executable: config.executable, model: config.model, endpoint: config.endpoint, launcher: config.launcher })
	return { kind: "runner-endpoint", digest: createHash("sha256").update(canonical).digest("hex") }
}

export function buildRunnerArgv(config: RunnerConfig, invocation: RunnerInvocation): readonly string[] {
	const resume = invocation.continuation.kind === "resume" ? invocation.continuation.sessionIdentity : null
	switch (config.kind) {
		case "claude": return ["--model", config.model, "--output-format", "stream-json", "--verbose", ...(resume === null ? [] : ["--resume", resume]), "-p", invocation.prompt]
		case "codex": return ["--ask-for-approval", "never", "exec", ...(resume === null ? [] : ["resume", resume]), "--model", config.model, "--json", "--ignore-rules", "--cd", invocation.cwd, invocation.prompt]
		case "opencode": return ["run", "--pure", "--format", "json", "--dir", invocation.cwd, "--model", config.model, ...(resume === null ? [] : ["--session", resume]), invocation.prompt]
	}
}

function probeEndpoint(config: RunnerConfig, endpoint: EndpointIdentity): Effect.Effect<EndpointProbe> {
	return Effect.promise(async () => {
		const observedAt = Date.now()
		const descriptor = endpointDescriptorDetail(config.endpoint)
		try {
			const executable = Bun.which(config.executable) ?? config.executable
			await access(executable, constants.X_OK)
			switch (config.endpoint.transport) {
				case "local-process":
					return hasExternalEndpointLocator(config.endpoint)
						? { kind: "unknown", endpoint, evidence: { observedAt, detail: `no-side-effect-probe-contract:${descriptor};executable:${executable}` } }
						: { kind: "ready", endpoint, evidence: { observedAt, detail: `endpoint:${descriptor};executable:${executable}` } }
				case "remote-api":
				case "session":
					return { kind: "unknown", endpoint, evidence: { observedAt, detail: `no-side-effect-probe-contract:${descriptor};executable:${executable}` } }
			}
		} catch (error) {
			const code = isBoundaryRecord(error) && typeof error.code === "string" ? error.code : "unknown"
			return code === "ENOENT" || code === "EACCES"
				? { kind: "absent", endpoint, evidence: { observedAt, detail: `${code}:${config.executable};endpoint:${descriptor}` } }
				: { kind: "unknown", endpoint, evidence: { observedAt, detail: `${code}:${config.executable};endpoint:${descriptor}` } }
		}
	})
}

function hasExternalEndpointLocator(endpoint: EndpointDescriptor): boolean {
	return endpoint.server !== "" || endpoint.principal !== "" || endpoint.machine !== "" || endpoint.profile !== ""
}

function endpointDescriptorDetail(endpoint: EndpointDescriptor): string {
	return JSON.stringify(endpoint)
}

function buildSubprocessSpec(config: RunnerConfig, invocation: RunnerInvocation): SubprocessSpec {
	const runnerArgv = buildRunnerArgv(config, invocation)
	const executable = config.launcher.kind === "direct" ? config.executable : config.launcher.executable
	const argv = config.launcher.kind === "direct"
		? runnerArgv
		: ["-p", runnerSandboxProfile(invocation.cwd, invocation.allowedSocketPath, config.executable, config.sandbox.resources), config.executable, ...runnerArgv]
	return {
		executable,
		argv,
		cwd: invocation.cwd,
		env: { ...config.env, ...invocation.env },
		stdin: null,
		timeoutMs: config.timeoutMs,
		termGraceMs: config.termGraceMs,
		maxOutputBytes: config.maxOutputBytes,
		sandbox: config.sandbox,
	}
}

export function runnerSandboxProfile(cwd: string, allowedSocketPath: string, executable: string, resources: readonly string[]): string {
	const readPaths = [...new Set([cwd, executable, dirname(executable), ...resources])]
	const readFilters = readPaths.flatMap((path) => [`(literal ${sandboxLiteral(path)})`, `(subpath ${sandboxLiteral(path)})`])
	return [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow file-read* (require-not (subpath \"/Users\")))",
		`(allow file-read* (require-any ${readFilters.join(" ")}))`,
		`(allow file-write* (subpath ${sandboxLiteral(cwd)}))`,
		`(allow network-outbound (remote unix-socket (path ${sandboxLiteral(allowedSocketPath)})))`,
	].join("\n")
}

function sandboxLiteral(value: string): string {
	return JSON.stringify(value)
}

function providerFactFromOutcome(endpoint: EndpointIdentity, run: RunIdentity, runner: RunnerKind, outcome: SubprocessOutcome): ProviderFact {
	switch (outcome.kind) {
		case "success": {
			const result = readRunnerResult(runner, new TextDecoder().decode(outcome.stdout))
			return result.kind === "accepted"
				? { kind: "terminal-winner", endpoint, run, payload: result.payload, sessionIdentity: result.sessionIdentity, observedAt: outcome.closedAt }
				: { kind: "unknown-effect", endpoint, run, detail: result.message, observedAt: outcome.closedAt }
		}
		case "nonzero": return { kind: "active-loss", endpoint, run, reason: "nonzero", detail: `exit:${outcome.exitCode}:${outputDetail(outcome.stderr)}`, observedAt: outcome.closedAt }
		case "timeout": return { kind: "active-loss", endpoint, run, reason: "timeout", detail: outcome.signal, observedAt: outcome.closedAt }
		case "signal": return { kind: "active-loss", endpoint, run, reason: "signal", detail: `${outcome.signal}:${outputDetail(outcome.stderr)}`, observedAt: outcome.closedAt }
		case "spawn-failure": return { kind: "unknown-effect", endpoint, run, detail: outcome.message, observedAt: outcome.closedAt }
	}
}
function outputDetail(bytes: Uint8Array): string {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim()
	return text === "" ? "no-stderr" : text
}


type RunnerReadResult =
	| { readonly kind: "accepted"; readonly payload: JsonValue; readonly sessionIdentity: string | null }
	| { readonly kind: "rejected"; readonly message: string }

function readRunnerResult(runner: RunnerKind, stdout: string): RunnerReadResult {
	let latestText: string | null = null
	let sessionIdentity: string | null = null
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue
		let event: unknown
		try {
			event = JSON.parse(line)
		} catch {
			continue
		}
		if (!isBoundaryRecord(event)) continue
		if (runner === "claude") {
			if (sessionIdentity === null && typeof event.session_id === "string" && event.session_id !== "") sessionIdentity = event.session_id
			const text = claudeMessageText(event)
			if (text !== null) latestText = text
		} else if (runner === "codex") {
			if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id !== "") sessionIdentity = event.thread_id
			const text = codexMessageText(event)
			if (text !== null) latestText = text
		} else {
			if (sessionIdentity === null && typeof event.sessionID === "string" && event.sessionID !== "") sessionIdentity = event.sessionID
			const text = opencodeMessageText(event)
			if (text !== null) latestText = text
		}
	}
	if (latestText === null) return { kind: "rejected", message: "runner stream contained no terminal agent text" }
	const parsed = parseDeclaredValue({ kind: "json" }, latestText)
	return parsed.kind === "accepted"
		? { kind: "accepted", payload: parsed.value, sessionIdentity }
		: { kind: "accepted", payload: latestText, sessionIdentity }
}

function claudeMessageText(event: Readonly<Record<string, unknown>>): string | null {
	if (event.type === "result" && typeof event.result === "string") return event.result
	if (event.type !== "assistant" || !isBoundaryRecord(event.message) || !Array.isArray(event.message.content)) return null
	const text = event.message.content.flatMap((part): string[] => isBoundaryRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
	return text.length === 0 ? null : text.join("\n")
}

function codexMessageText(event: Readonly<Record<string, unknown>>): string | null {
	if (event.type === "agent_message" && typeof event.text === "string") return event.text
	if (event.type !== "item.completed" || !isBoundaryRecord(event.item)) return null
	return event.item.type === "agent_message" && typeof event.item.text === "string" ? event.item.text : null
}

function opencodeMessageText(event: Readonly<Record<string, unknown>>): string | null {
	if (typeof event.text === "string") return event.text
	if (!isBoundaryRecord(event.part) || event.part.type !== "text" || typeof event.part.text !== "string") return null
	return event.part.text
}

export function runProviderFactIdentity(run: RunIdentity): string {
	return `${run.closure.task.chain.value}/${run.closure.task.value}/${run.closure.attempt}/${run.value}`
}

async function commitProviderFact(root: string, identity: string, fact: ProviderFact): Promise<ProviderFact> {
	const winnerPath = factPath(root, identity)
	await mkdir(dirname(winnerPath), { recursive: true })
	const candidatePath = `${winnerPath}.${randomUUID()}.candidate`
	const candidate = await open(candidatePath, "wx")
	try {
		await candidate.writeFile(JSON.stringify({ identity, fact } satisfies ProviderFactRecord))
		await candidate.sync()
	} finally {
		await candidate.close()
	}
	try {
		await link(candidatePath, winnerPath)
		await syncDirectory(dirname(winnerPath))
		return fact
	} catch (error) {
		if (!isBoundaryRecord(error) || error.code !== "EEXIST") throw error
		const existing = await readProviderFact(root, identity)
		if (existing === null) throw new Error("winner disappeared after EEXIST")
		return existing
	} finally {
		await rm(candidatePath, { force: true })
	}
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r")
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

async function readProviderFact(root: string, identity: string): Promise<ProviderFact | null> {
	let raw: string
	try {
		raw = await readFile(factPath(root, identity), "utf8")
	} catch (error) {
		if (isBoundaryRecord(error) && error.code === "ENOENT") return null
		throw error
	}
	const record = parseProviderFactRecord(JSON.parse(raw))
	if (record.identity !== identity) throw new Error("persisted provider fact identity does not match its winner path")
	return record.fact
}

async function listProviderFacts(root: string): Promise<readonly ProviderFactRecord[]> {
	const directory = join(root, "provider-facts")
	let entries: string[]
	try {
		entries = await readdir(directory)
	} catch (error) {
		if (isBoundaryRecord(error) && error.code === "ENOENT") return []
		throw error
	}
	const facts = await Promise.all(entries.sort().map(async (entry) => {
		const raw = await readFile(join(directory, entry, "winner.json"), "utf8")
		const record = parseProviderFactRecord(JSON.parse(raw))
		if (entry !== factDirectoryKey(record.identity)) throw new Error("persisted provider fact identity does not match its winner directory")
		return record
	}))
	return facts.sort((left, right) => left.identity.localeCompare(right.identity))
}

function parseProviderFactRecord(candidate: unknown): ProviderFactRecord {
	const boundary = ProviderFactRecordBoundary(candidate)
	if (boundary instanceof arkType.errors) throw new Error(boundary.summary)
	return { identity: boundary.identity, fact: parseProviderFact(boundary.fact) }
}

const ProviderFactRecordBoundary = arkType({ identity: "string > 0", fact: "unknown", "+": "reject" })

function parseProviderFact(candidate: unknown): ProviderFact {
	if (!isBoundaryRecord(candidate) || typeof candidate.kind !== "string") throw new Error("invalid persisted provider fact")
	if (candidate.kind === "terminal-winner") {
		const parsed = parseDeclaredValue({ kind: "json" }, candidate.payload)
		if (parsed.kind === "rejected") throw new Error("invalid terminal payload")
		const boundary = arkType({ kind: "'terminal-winner'", endpoint: { kind: "'runner-endpoint'", digest: "string" }, run: "object", payload: "unknown", sessionIdentity: "string | null", observedAt: "number", "+": "reject" })(candidate)
		if (boundary instanceof arkType.errors) throw new Error(boundary.summary)
		const run = parseRunIdentity(boundary.run)
		return { ...boundary, run, payload: parsed.value }
	}
	const boundary = NonTerminalFactBoundary(candidate)
	if (boundary instanceof arkType.errors) throw new Error(boundary.summary)
	return boundary
}

const RunIdentityBoundary = arkType({ kind: "'run'", closure: { kind: "'closure'", task: { kind: "'task'", chain: { kind: "'chain'", value: "string" }, value: "string" }, attempt: "number.integer >= 0" }, value: "string" })
const NonTerminalFactBoundary = arkType.or(
	{ kind: "'pre-spawn-absence'", endpoint: { kind: "'runner-endpoint'", digest: "string" }, attemptIdentity: "string", evidence: { observedAt: "number", detail: "string" } },
	{ kind: "'active-loss'", endpoint: { kind: "'runner-endpoint'", digest: "string" }, run: RunIdentityBoundary, reason: "'nonzero' | 'timeout' | 'signal'", detail: "string", observedAt: "number" },
	{ kind: "'unknown-effect'", endpoint: { kind: "'runner-endpoint'", digest: "string" }, run: RunIdentityBoundary, detail: "string", observedAt: "number" },
)

function parseRunIdentity(candidate: unknown): RunIdentity {
	const parsed = RunIdentityBoundary(candidate)
	if (parsed instanceof arkType.errors) throw new Error(parsed.summary)
	return parsed
}

function factPath(root: string, identity: string): string {
	return join(root, "provider-facts", factDirectoryKey(identity), "winner.json")
}

function factDirectoryKey(identity: string): string {
	return createHash("sha256").update(identity).digest("hex")
}

function validateRunnerConfig(config: RunnerConfig): void {
	if (config.model === "") throw new Error("runner model must be explicit")
	if (config.sandbox.filesystem !== "closure-only") throw new Error("runner filesystem must be closure-only so agent code cannot reach the operator socket")
	if (config.launcher.kind !== "sandbox-exec") throw new Error("runner requires an enforcing sandbox-exec launcher")
	if (config.timeoutMs <= 0 || config.termGraceMs <= 0 || config.maxOutputBytes <= 0) throw new Error("runner limits must be positive")
}

function factStoreError(operation: string, error: unknown): ProviderFactStoreError {
	return { kind: "provider-fact-store-error", operation, message: error instanceof Error ? error.message : String(error) }
}
