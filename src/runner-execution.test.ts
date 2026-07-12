import { describe, expect, test } from "bun:test"

import {
	externalTerminalEndpointKey,
	probeExternalTerminal,
	runnerExecutionDomain,
	type ExternalTerminalProbeProcess,
} from "./runner-execution"
import type { AgentRunnerSelection } from "./loop"

const selection = (kind: AgentRunnerSelection["kind"], binary: string = kind): AgentRunnerSelection => ({
	kind,
	binary,
	extraArgs: [],
	model: null,
	source: "queue",
})

describe("runner execution domains", () => {
	test("classifies every runner kind without kind-name checks in scheduler consumers", () => {
		expect(runnerExecutionDomain(selection("claude"))).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain(selection("codex"))).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain(selection("opencode"))).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain(selection("hapi", "/opt/bin/hapi"))).toEqual({
			kind: "external-terminal",
			probe: { binary: "/opt/bin/hapi", argv: ["probe"], deadlineMs: 30_000, killGraceMs: 5_000 },
		})
	})

	test("endpoint identity includes runner, binary, and probe argv", () => {
		const domain = runnerExecutionDomain(selection("hapi", "/opt/bin/hapi"))
		if (domain.kind !== "external-terminal") throw new Error("expected external-terminal")
		expect(externalTerminalEndpointKey("hapi", domain.probe)).toBe('hapi\u0000/opt/bin/hapi\u0000["probe"]')
	})

	test("carries the process deadline and termination grace as explicit probe contract", () => {
		const domain = runnerExecutionDomain(selection("hapi"))
		if (domain.kind !== "external-terminal") throw new Error("expected external-terminal")
		expect(domain.probe.deadlineMs).toBe(30_000)
		expect(domain.probe.killGraceMs).toBe(5_000)
	})
})

describe("external terminal binary probe wire", () => {
	const probe = { binary: "hapi", argv: ["probe"], deadlineMs: 30_000, killGraceMs: 5_000 } as const
	const checkedAt = "2026-07-12T00:00:00.000Z"
	const run = async (result: ExternalTerminalProbeProcess): Promise<ExternalTerminalProbeProcess> => result

	test("maps exit 0 to available and EX_UNAVAILABLE to typed endpoint absence", async () => {
		expect(await probeExternalTerminal(probe, () => run({ kind: "exit", exitCode: 0, signal: null }), () => checkedAt)).toEqual({
			kind: "available",
			checkedAt,
		})
		expect(await probeExternalTerminal(probe, () => run({ kind: "exit", exitCode: 69, signal: null }), () => checkedAt)).toEqual({
			kind: "unavailable",
			checkedAt,
			reason: "endpoint-unavailable",
			exitCode: 69,
			signal: null,
		})
	})

	test("distinguishes binary-missing from a broken probe", async () => {
		expect(await probeExternalTerminal(probe, () => run({ kind: "binary-missing" }), () => checkedAt)).toEqual({
			kind: "unavailable",
			checkedAt,
			reason: "binary-missing",
			exitCode: null,
			signal: null,
		})
		expect(await probeExternalTerminal(probe, () => run({ kind: "exit", exitCode: 2, signal: null }), () => checkedAt)).toEqual({
			kind: "probe-failed",
			checkedAt,
			exitCode: 2,
			signal: null,
		})
	})

	test("the real process seam classifies an unexecutable PATH target as binary-missing", async () => {
		const result = await probeExternalTerminal({ binary: "/coder-loop-fixtures/definitely-missing-hapi", argv: ["probe"], deadlineMs: 30_000, killGraceMs: 5_000 })
		expect(result).toMatchObject({ kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null })
	})
})
