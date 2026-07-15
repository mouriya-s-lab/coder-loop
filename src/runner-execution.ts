import type { AgentRunnerKind } from "./loop"
import { spawn } from "node:child_process"

export type RunnerExecutionDomain =
	| { kind: "local-process" }
	| {
		kind: "external-terminal"
		probe: { argv: readonly ["probe"]; deadlineMs: number; killGraceMs: number }
	}

export function runnerExecutionDomain(runner: AgentRunnerKind): RunnerExecutionDomain {
	switch (runner) {
		case "claude": case "codex": case "opencode": return { kind: "local-process" }
		case "hapi": return {
			kind: "external-terminal",
			probe: { argv: ["probe"], deadlineMs: 30_000, killGraceMs: 1_000 },
		}
	}
}

export type ExternalTerminalProbeWire =
	| { kind: "exited"; exitCode: number }
	| { kind: "signaled"; signal: string }
	| { kind: "executable-missing" }
	| { kind: "deadline-exceeded" }

export type ExternalTerminalAvailability =
	| { kind: "available" }
	| { kind: "unavailable"; reason: "binary-missing" | "endpoint-unavailable"; exitCode: number | null; signal: string | null }
	| { kind: "probe-failed"; reason: "unexpected-exit" | "signal" | "deadline-exceeded"; exitCode: number | null; signal: string | null }

export type RunnerAvailabilityGate =
	| { kind: "local-process" }
	| { kind: "available"; domain: Extract<RunnerExecutionDomain, { kind: "external-terminal" }> }
	| {
		kind: "unavailable"
		domain: Extract<RunnerExecutionDomain, { kind: "external-terminal" }>
		availability: Exclude<ExternalTerminalAvailability, { kind: "available" }>
	}

export function decodeExternalTerminalProbeResult(result: ExternalTerminalProbeWire): ExternalTerminalAvailability {
	switch (result.kind) {
		case "executable-missing": return { kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null }
		case "deadline-exceeded": return { kind: "probe-failed", reason: "deadline-exceeded", exitCode: null, signal: "SIGTERM" }
		case "signaled": return { kind: "probe-failed", reason: "signal", exitCode: null, signal: result.signal }
		case "exited":
			if (result.exitCode === 0) return { kind: "available" }
			if (result.exitCode === 69) return { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null }
			return { kind: "probe-failed", reason: "unexpected-exit", exitCode: result.exitCode, signal: null }
	}
}

export type ExternalTerminalProbeTermination = {
	deadlineMs: number
	killGraceMs: number
}

function terminateProbeProcessGroup(child: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
	if (child.pid === undefined) return
	try {
		process.kill(-child.pid, signal)
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return
		throw error
	}
}

export async function probeExternalTerminal(
	binary: string,
	probeArgv: readonly ["probe"],
	termination: ExternalTerminalProbeTermination = { deadlineMs: 30_000, killGraceMs: 1_000 },
): Promise<ExternalTerminalAvailability> {
	const wire = await new Promise<ExternalTerminalProbeWire>((resolve) => {
		const child = spawn(binary, [...probeArgv], { stdio: "ignore", detached: true })
		let deadlineExceeded = false
		let killTimer: ReturnType<typeof setTimeout> | null = null
		const deadlineTimer = setTimeout(() => {
			deadlineExceeded = true
			terminateProbeProcessGroup(child, "SIGTERM")
			killTimer = setTimeout(() => terminateProbeProcessGroup(child, "SIGKILL"), termination.killGraceMs)
		}, termination.deadlineMs)
		child.once("error", () => {
			clearTimeout(deadlineTimer)
			if (killTimer !== null) clearTimeout(killTimer)
			resolve({ kind: "executable-missing" })
		})
		child.once("close", (exitCode, signal) => {
			clearTimeout(deadlineTimer)
			if (killTimer !== null) clearTimeout(killTimer)
			if (deadlineExceeded) resolve({ kind: "deadline-exceeded" })
			else if (signal !== null) resolve({ kind: "signaled", signal })
			else resolve({ kind: "exited", exitCode: exitCode ?? 1 })
		})
	})
	return decodeExternalTerminalProbeResult(wire)
}

export async function probeResolvedExternalTerminal(
	runner: { binary: string },
	domain: Extract<RunnerExecutionDomain, { kind: "external-terminal" }>,
): Promise<ExternalTerminalAvailability> {
	return await probeExternalTerminal(runner.binary, domain.probe.argv, {
		deadlineMs: domain.probe.deadlineMs,
		killGraceMs: domain.probe.killGraceMs,
	})
}

export async function gateResolvedRunnerAvailability(
	runner: { kind: AgentRunnerKind; binary: string },
): Promise<RunnerAvailabilityGate> {
	const domain = runnerExecutionDomain(runner.kind)
	if (domain.kind === "local-process") return domain
	const availability = await probeResolvedExternalTerminal(runner, domain)
	return availability.kind === "available"
		? { kind: "available", domain }
		: { kind: "unavailable", domain, availability }
}
