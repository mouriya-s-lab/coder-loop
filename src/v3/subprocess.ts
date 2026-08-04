import { Effect } from "effect"

export type SandboxDeclaration = {
	readonly filesystem: "closure-only" | "read-only" | "unrestricted"
	readonly network: "none" | "declared-endpoints" | "unrestricted"
	readonly resources: readonly string[]
}

export type SubprocessSpec = {
	readonly executable: string
	readonly argv: readonly string[]
	readonly cwd: string
	readonly env: Readonly<Record<string, string>>
	readonly stdin: string | Uint8Array | null
	readonly timeoutMs: number
	readonly termGraceMs: number
	readonly maxOutputBytes: number
	readonly sandbox: SandboxDeclaration
}

export type SubprocessOutcome =
	| { readonly kind: "success"; readonly exitCode: 0; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly startedAt: number; readonly closedAt: number }
	| { readonly kind: "nonzero"; readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly startedAt: number; readonly closedAt: number }
	| { readonly kind: "timeout"; readonly signal: "SIGTERM" | "SIGKILL"; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly startedAt: number; readonly closedAt: number }
	| { readonly kind: "signal"; readonly signal: string; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly startedAt: number; readonly closedAt: number }
	| { readonly kind: "spawn-failure"; readonly message: string; readonly startedAt: number; readonly closedAt: number }

export function runSubprocess(spec: SubprocessSpec): Effect.Effect<SubprocessOutcome> {
	return Effect.promise(() => executeSubprocess(spec))
}

async function executeSubprocess(spec: SubprocessSpec): Promise<SubprocessOutcome> {
	const startedAt = Date.now()
	const stdin: Bun.SpawnOptions.Writable = spec.stdin === null
		? "ignore"
		: typeof spec.stdin === "string"
			? new TextEncoder().encode(spec.stdin)
			: Uint8Array.from(spec.stdin)
	let processHandle: Bun.Subprocess<Bun.SpawnOptions.Writable, "pipe", "pipe">
	try {
		processHandle = Bun.spawn([spec.executable, ...spec.argv], {
			cwd: spec.cwd,
			env: { ...spec.env },
			stdin,
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
			maxBuffer: spec.maxOutputBytes,
		})
	} catch (error) {
		return { kind: "spawn-failure", message: error instanceof Error ? error.message : String(error), startedAt, closedAt: Date.now() }
	}
	const stdoutPromise = readStream(processHandle.stdout)
	const stderrPromise = readStream(processHandle.stderr)
	let timedOut = false
	let escalated = false
	let killTimer: Timer | undefined
	const timeout = setTimeout(() => {
		timedOut = true
		signalProcessGroup(processHandle.pid, "SIGTERM")
		killTimer = setTimeout(() => {
			escalated = true
			signalProcessGroup(processHandle.pid, "SIGKILL")
		}, spec.termGraceMs)
	}, spec.timeoutMs)
	const exitCode = await processHandle.exited
	clearTimeout(timeout)
	clearTimeout(killTimer)
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
	const closedAt = Date.now()
	if (timedOut) return { kind: "timeout", signal: escalated ? "SIGKILL" : "SIGTERM", stdout, stderr, startedAt, closedAt }
	if (processHandle.signalCode !== null) return { kind: "signal", signal: processHandle.signalCode, stdout, stderr, startedAt, closedAt }
	if (exitCode === 0) return { kind: "success", exitCode: 0, stdout, stderr, startedAt, closedAt }
	return { kind: "nonzero", exitCode, stdout, stderr, startedAt, closedAt }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(-pid, signal)
	} catch {
		try {
			process.kill(pid, signal)
		} catch {
			return
		}
	}
}
