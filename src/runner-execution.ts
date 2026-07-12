import { spawn } from "node:child_process"

import type { AgentRunnerKind, AgentRunnerSelection } from "./loop"

export type ExternalTerminalProbe = {
	binary: string
	argv: readonly ["probe"]
	deadlineMs: number
	killGraceMs: number
}

export type RunnerExecutionDomain =
	| { kind: "local-process" }
	| { kind: "external-terminal"; probe: ExternalTerminalProbe }

export type ExternalTerminalAvailability =
	| { kind: "available"; checkedAt: string }
	| {
		kind: "unavailable"
		checkedAt: string
		reason: "binary-missing" | "endpoint-unavailable"
		exitCode: number | null
		signal: string | null
	}
	| { kind: "probe-failed"; checkedAt: string; exitCode: number | null; signal: string | null }

export type ExternalTerminalProbeProcess =
	| { kind: "exit"; exitCode: number | null; signal: string | null }
	| { kind: "binary-missing" }

export type ExternalTerminalProbeRunner = (probe: ExternalTerminalProbe) => Promise<ExternalTerminalProbeProcess>

export const EXTERNAL_TERMINAL_PROBE_DEADLINE_MS = 30_000
export const EXTERNAL_TERMINAL_PROBE_KILL_GRACE_MS = 5_000

export function runnerExecutionDomain(runner: AgentRunnerSelection): RunnerExecutionDomain {
	switch (runner.kind) {
		case "claude":
		case "codex":
		case "opencode":
			return { kind: "local-process" }
		case "hapi":
			return {
				kind: "external-terminal",
				probe: {
					binary: runner.binary,
					argv: ["probe"],
					deadlineMs: EXTERNAL_TERMINAL_PROBE_DEADLINE_MS,
					killGraceMs: EXTERNAL_TERMINAL_PROBE_KILL_GRACE_MS,
				},
			}
		default:
			return assertNever(runner.kind)
	}
}

export function externalTerminalEndpointKey(runner: AgentRunnerKind, probe: ExternalTerminalProbe): string {
	return `${runner}\u0000${probe.binary}\u0000${JSON.stringify(probe.argv)}`
}

export async function probeExternalTerminal(
	probe: ExternalTerminalProbe,
	run: ExternalTerminalProbeRunner = (input) => runExternalTerminalProbeProcess(input),
	now: () => string = () => new Date().toISOString(),
): Promise<ExternalTerminalAvailability> {
	const result = await run(probe)
	const checkedAt = now()
	switch (result.kind) {
		case "binary-missing":
			return { kind: "unavailable", checkedAt, reason: "binary-missing", exitCode: null, signal: null }
		case "exit":
			if (result.exitCode === 0) return { kind: "available", checkedAt }
			if (result.exitCode === 69) {
				return { kind: "unavailable", checkedAt, reason: "endpoint-unavailable", exitCode: 69, signal: null }
			}
			return { kind: "probe-failed", checkedAt, exitCode: result.exitCode, signal: result.signal }
		default:
			return assertNever(result)
	}
}

export async function runExternalTerminalProbeProcess(
	probe: ExternalTerminalProbe,
): Promise<ExternalTerminalProbeProcess> {
	return await new Promise((resolveResult, rejectResult) => {
		const child = spawn(probe.binary, [...probe.argv], {
			stdio: "ignore",
			detached: true,
		})
		let settled = false
		let killTimer: ReturnType<typeof setTimeout> | null = null
		const settle = (result: ExternalTerminalProbeProcess): void => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			if (killTimer !== null) clearTimeout(killTimer)
			resolveResult(result)
		}
		const deadline = setTimeout(() => {
			const pid = child.pid
			if (pid === undefined) return
			signalProbeProcessGroup(pid, "SIGTERM")
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) signalProbeProcessGroup(pid, "SIGKILL")
			}, probe.killGraceMs)
		}, probe.deadlineMs)
		child.once("error", (error) => {
			if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "EACCES")) {
				settle({ kind: "binary-missing" })
				return
			}
			clearTimeout(deadline)
			rejectResult(error)
		})
		child.once("close", (exitCode, signal) => settle({ kind: "exit", exitCode, signal }))
	})
}

function signalProbeProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal)
	} catch (error) {
		if (isNodeErrorWithCode(error, "ESRCH")) return
		throw error
	}
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code
}

function assertNever(value: never): never {
	throw new Error(`unhandled runner execution variant: ${JSON.stringify(value)}`)
}
