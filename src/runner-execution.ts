import type { AgentRunnerKind } from "./loop"
import { spawn } from "node:child_process"

export type RunnerExecutionDomain =
	| { kind: "local-process" }
	| { kind: "external-terminal"; probeArgv: readonly ["probe"] }

export function runnerExecutionDomain(runner: AgentRunnerKind): RunnerExecutionDomain {
	switch (runner) {
		case "claude": case "codex": case "opencode": return { kind: "local-process" }
		case "hapi": return { kind: "external-terminal", probeArgv: ["probe"] }
	}
}

export type ExternalTerminalProbeWire =
	| { kind: "exited"; exitCode: number }
	| { kind: "signaled"; signal: string }
	| { kind: "executable-missing" }

export type ExternalTerminalAvailability =
	| { kind: "available" }
	| { kind: "unavailable"; reason: "binary-missing" | "endpoint-unavailable"; exitCode: number | null; signal: string | null }
	| { kind: "probe-failed"; reason: "unexpected-exit" | "signal"; exitCode: number | null; signal: string | null }

export function decodeExternalTerminalProbeResult(result: ExternalTerminalProbeWire): ExternalTerminalAvailability {
	switch (result.kind) {
		case "executable-missing": return { kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null }
		case "signaled": return { kind: "probe-failed", reason: "signal", exitCode: null, signal: result.signal }
		case "exited":
			if (result.exitCode === 0) return { kind: "available" }
			if (result.exitCode === 69) return { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null }
			return { kind: "probe-failed", reason: "unexpected-exit", exitCode: result.exitCode, signal: null }
	}
}

function executableMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false
	return error.code === "ENOENT"
}

export async function probeExternalTerminal(
	binary: string,
	probeArgv: readonly ["probe"],
): Promise<ExternalTerminalAvailability> {
	const wire = await new Promise<ExternalTerminalProbeWire>((resolve, reject) => {
		const child = spawn(binary, [...probeArgv], { stdio: "ignore" })
		child.once("error", (error) => {
			if (executableMissing(error)) resolve({ kind: "executable-missing" })
			else reject(error)
		})
		child.once("close", (exitCode, signal) => {
			if (signal !== null) resolve({ kind: "signaled", signal })
			else resolve({ kind: "exited", exitCode: exitCode ?? 1 })
		})
	})
	return decodeExternalTerminalProbeResult(wire)
}
