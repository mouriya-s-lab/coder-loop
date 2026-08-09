import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type as arkType } from "arktype"
import { Context, Effect, Layer } from "effect"
import type { JsonValue } from "./definition"
import { parseDeclaredValue } from "./definition"
import { runSubprocess, type SandboxDeclaration, type SubprocessOutcome, type SubprocessSpec } from "./subprocess"

export type HookAnchor =
	| "function-entry"
	| "pre-map"
	| "prompt-frozen"
	| "agent-start"
	| "post-map"
	| "routing"
	| "function-exit"
	| "committed-transition"

export type HookDeclaration = {
	readonly id: string
	readonly anchors: readonly HookAnchor[]
	readonly executable: string
	readonly argv: readonly string[]
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
	readonly sandbox: SandboxDeclaration
	readonly launcher:
		| { readonly kind: "direct" }
		| { readonly kind: "sandbox-exec"; readonly executable: "/usr/bin/sandbox-exec"; readonly profile: string }
	readonly timeoutMs: number
	readonly termGraceMs: number
	readonly maxOutputBytes: number
}

export type HookProjection = {
	readonly anchor: HookAnchor
	readonly occurrenceIdentity: string
	readonly observedAt: number
	readonly facts: JsonValue
}

export type HookExecutionOutcome =
	| { readonly kind: "success"; readonly exitCode: 0 }
	| { readonly kind: "nonzero"; readonly exitCode: number }
	| { readonly kind: "timeout"; readonly signal: "SIGTERM" | "SIGKILL" }
	| { readonly kind: "signal"; readonly signal: string }
	| { readonly kind: "spawn-failure"; readonly message: string }

export type HookExecutionAudit =
	| {
			readonly kind: "started"
			readonly identity: string
			readonly deliveryIdentity: string
			readonly startedAt: number
		}
	| {
			readonly kind: "closed"
			readonly identity: string
			readonly deliveryIdentity: string
			readonly startedAt: number
			readonly closedAt: number
			readonly outcome: HookExecutionOutcome
		}

export type HookDeliveryAudit = {
	readonly identity: string
	readonly hookId: string
	readonly projection: HookProjection
	readonly status: "pending" | "completed"
	readonly executions: readonly HookExecutionAudit[]
}

export type HookRuntimeError = {
	readonly kind: "hook-runtime-error"
	readonly operation: string
	readonly message: string
}

export type HookRuntimeService = {
	readonly trigger: (projection: HookProjection) => Effect.Effect<readonly HookDeliveryAudit[], HookRuntimeError>
	readonly recover: Effect.Effect<readonly HookDeliveryAudit[], HookRuntimeError>
	readonly listAudit: Effect.Effect<readonly HookDeliveryAudit[], HookRuntimeError>
	readonly shutdown: Effect.Effect<void, HookRuntimeError>
}

export class HookRuntime extends Context.Tag("coder-loop/v3/HookRuntime")<HookRuntime, HookRuntimeService>() {}

type RunningExecution = {
	readonly controller: AbortController
	readonly completion: Promise<HookDeliveryAudit>
}

type HookRuntimeState = {
	accepting: boolean
	shutdown: Promise<void> | null
	readonly operations: Set<Promise<readonly HookDeliveryAudit[]>>
	readonly running: Map<string, RunningExecution>
}

export function makeHookRuntimeLive(root: string, declarations: readonly HookDeclaration[], shutdownWaitMs: number): Layer.Layer<HookRuntime> {
	validateDeclarations(declarations)
	if (!Number.isInteger(shutdownWaitMs) || shutdownWaitMs <= 0) throw new Error("hook shutdownWaitMs must be a positive integer")
	const state: HookRuntimeState = { accepting: true, shutdown: null, operations: new Set(), running: new Map() }
	const service: HookRuntimeService = {
		trigger: (projection) => hookEffect("trigger", () => trackOperation(state, async () => {
			if (!state.accepting) throw new Error("hook runtime is shutting down")
			const matching = declarations.filter((declaration) => declaration.anchors.includes(projection.anchor))
			return Promise.all(matching.map((declaration) => deliver(root, declaration, projection, state)))
		})),
		recover: hookEffect("recover", () => trackOperation(state, async () => {
			if (!state.accepting) throw new Error("hook runtime is shutting down")
			const pending = (await listDeliveries(root)).filter((delivery) => delivery.status === "pending")
			const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]))
			return Promise.all(pending.map((delivery) => {
				const declaration = byId.get(delivery.hookId)
				if (declaration === undefined) throw new Error(`hook declaration ${delivery.hookId} is unavailable for pending delivery ${delivery.identity}`)
				return executeDelivery(root, declaration, delivery, state)
			}))
		})),
		listAudit: hookEffect("list-audit", () => listDeliveries(root)),
		shutdown: hookEffect("shutdown", () => shutdownRuntime(state, shutdownWaitMs)),
	}
	return Layer.scoped(HookRuntime, Effect.acquireRelease(Effect.succeed(service), (runtime) => Effect.orDie(runtime.shutdown)))
}

async function deliver(root: string, declaration: HookDeclaration, projection: HookProjection, state: HookRuntimeState): Promise<HookDeliveryAudit> {
	const identity = deliveryIdentity(declaration.id, projection)
	const path = deliveryPath(root, identity)
	let delivery = await readDelivery(path)
	if (delivery === null) {
		delivery = { identity, hookId: declaration.id, projection, status: "pending", executions: [] }
		await atomicWrite(path, delivery)
	}
	if (delivery.status === "completed") return delivery
	return executeDelivery(root, declaration, delivery, state)
}

async function executeDelivery(root: string, declaration: HookDeclaration, delivery: HookDeliveryAudit, state: HookRuntimeState): Promise<HookDeliveryAudit> {
	const started: HookExecutionAudit = {
		kind: "started",
		identity: randomUUID(),
		deliveryIdentity: delivery.identity,
		startedAt: Date.now(),
	}
	const running: HookDeliveryAudit = { ...delivery, executions: [...delivery.executions, started] }
	await atomicWrite(deliveryPath(root, delivery.identity), running)
	const controller = new AbortController()
	const completion = closeExecution(root, declaration, running, started, controller.signal)
	state.running.set(started.identity, { controller, completion })
	try {
		return await completion
	} finally {
		state.running.delete(started.identity)
	}
}

async function closeExecution(root: string, declaration: HookDeclaration, running: HookDeliveryAudit, started: HookExecutionAudit & { readonly kind: "started" }, abortSignal: AbortSignal): Promise<HookDeliveryAudit> {
	const outcome = await Effect.runPromise(runSubprocess({ ...hookSubprocessSpec(declaration, running.projection), abortSignal }))
	const closed: HookExecutionAudit = {
		...started,
		kind: "closed",
		closedAt: outcome.closedAt,
		outcome: hookOutcome(outcome),
	}
	const completed: HookDeliveryAudit = {
		...running,
		status: "completed",
		executions: running.executions.map((execution) => execution.identity === started.identity ? closed : execution),
	}
	await atomicWrite(deliveryPath(root, running.identity), completed)
	return completed
}

async function trackOperation(state: HookRuntimeState, work: () => Promise<readonly HookDeliveryAudit[]>): Promise<readonly HookDeliveryAudit[]> {
	const operation = work()
	state.operations.add(operation)
	try {
		return await operation
	} finally {
		state.operations.delete(operation)
	}
}

function shutdownRuntime(state: HookRuntimeState, shutdownWaitMs: number): Promise<void> {
	if (state.shutdown !== null) return state.shutdown
	state.accepting = false
	state.shutdown = (async () => {
		if (state.operations.size === 0) return
		await Promise.race([Promise.allSettled([...state.operations]), delay(shutdownWaitMs)])
		for (const execution of state.running.values()) execution.controller.abort()
		const settled = await Promise.allSettled([...state.operations])
		const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failed !== undefined) throw failed.reason
	})()
	return state.shutdown
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function hookSubprocessSpec(declaration: HookDeclaration, projection: HookProjection): SubprocessSpec {
	const executable = declaration.launcher.kind === "direct" ? declaration.executable : declaration.launcher.executable
	const nativeArgv = [...declaration.argv]
	const argv = declaration.launcher.kind === "direct"
		? nativeArgv
		: ["-p", declaration.launcher.profile, declaration.executable, ...nativeArgv]
	return {
		executable,
		argv,
		cwd: declaration.cwd,
		env: declaration.env,
		stdin: JSON.stringify(projection),
		timeoutMs: declaration.timeoutMs,
		termGraceMs: declaration.termGraceMs,
		maxOutputBytes: declaration.maxOutputBytes,
		sandbox: declaration.sandbox,
	}
}

function hookOutcome(outcome: SubprocessOutcome): HookExecutionOutcome {
	switch (outcome.kind) {
		case "success": return { kind: "success", exitCode: 0 }
		case "nonzero": return { kind: "nonzero", exitCode: outcome.exitCode }
		case "timeout": return { kind: "timeout", signal: outcome.signal }
		case "signal": return { kind: "signal", signal: outcome.signal }
		case "spawn-failure": return { kind: "spawn-failure", message: outcome.message }
	}
}

async function listDeliveries(root: string): Promise<HookDeliveryAudit[]> {
	const directory = join(root, "hook-deliveries")
	let entries: string[]
	try {
		entries = await readdir(directory)
	} catch (error) {
		if (isFsCode(error, "ENOENT")) return []
		throw error
	}
	const deliveries = await Promise.all(entries.filter((entry) => !entry.includes(".candidate.")).map((entry) => readDelivery(join(directory, entry))))
	return deliveries.filter((delivery): delivery is HookDeliveryAudit => delivery !== null).sort((left, right) => left.identity.localeCompare(right.identity))
}

async function readDelivery(path: string): Promise<HookDeliveryAudit | null> {
	let candidate: unknown
	try {
		candidate = JSON.parse(await readFile(path, "utf8"))
	} catch (error) {
		if (isFsCode(error, "ENOENT")) return null
		throw error
	}
	const parsed = HookDeliveryBoundary(candidate)
	if (parsed instanceof arkType.errors) throw new Error(parsed.summary)
	const facts = parseDeclaredValue({ kind: "json" }, parsed.projection.facts)
	if (facts.kind === "rejected") throw new Error("invalid hook projection facts")
	return { ...parsed, projection: { ...parsed.projection, facts: facts.value } }
}

const HookAnchorBoundary = arkType("'function-entry' | 'pre-map' | 'prompt-frozen' | 'agent-start' | 'post-map' | 'routing' | 'function-exit' | 'committed-transition'")
const HookOutcomeBoundary = arkType.or(
	{ kind: "'success'", exitCode: "0" },
	{ kind: "'nonzero'", exitCode: "number.integer" },
	{ kind: "'timeout'", signal: "'SIGTERM' | 'SIGKILL'" },
	{ kind: "'signal'", signal: "string" },
	{ kind: "'spawn-failure'", message: "string" },
)
const HookExecutionBoundary = arkType.or(
	{ kind: "'started'", identity: "string", deliveryIdentity: "string", startedAt: "number" },
	{ kind: "'closed'", identity: "string", deliveryIdentity: "string", startedAt: "number", closedAt: "number", outcome: HookOutcomeBoundary },
)
const HookDeliveryBoundary = arkType({
	identity: "string",
	hookId: "string",
	projection: { anchor: HookAnchorBoundary, occurrenceIdentity: "string", observedAt: "number", facts: "unknown" },
	status: "'pending' | 'completed'",
	executions: HookExecutionBoundary.array(),
	"+": "reject",
})

async function atomicWrite(path: string, value: HookDeliveryAudit): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const candidate = `${path}.candidate.${randomUUID()}`
	const handle = await open(candidate, "wx")
	try {
		await handle.writeFile(JSON.stringify(value))
		await handle.sync()
	} finally {
		await handle.close()
	}
	try {
		await rename(candidate, path)
		const directory = await open(dirname(path), "r")
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	} finally {
		await rm(candidate, { force: true })
	}
}

function deliveryIdentity(hookId: string, projection: HookProjection): string {
	return createHash("sha256").update(`${hookId}\0${projection.anchor}\0${projection.occurrenceIdentity}`).digest("hex")
}

function deliveryPath(root: string, identity: string): string {
	return join(root, "hook-deliveries", `${identity}.json`)
}

function validateDeclarations(declarations: readonly HookDeclaration[]): void {
	const seen = new Set<string>()
	for (const declaration of declarations) {
		if (declaration.id === "" || seen.has(declaration.id)) throw new Error(`duplicate or empty hook id: ${declaration.id}`)
		seen.add(declaration.id)
		if (declaration.launcher.kind === "direct" && (declaration.sandbox.filesystem !== "unrestricted" || declaration.sandbox.network !== "unrestricted")) throw new Error(`hook ${declaration.id} requires an enforcing launcher`)
		if (declaration.timeoutMs <= 0 || declaration.termGraceMs <= 0 || declaration.maxOutputBytes <= 0) throw new Error(`hook ${declaration.id} limits must be positive`)
	}
}

function hookEffect<A>(operation: string, work: () => Promise<A>): Effect.Effect<A, HookRuntimeError> {
	return Effect.tryPromise({ try: work, catch: (error) => ({ kind: "hook-runtime-error", operation, message: error instanceof Error ? error.message : String(error) }) })
}

function isFsCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code
}
