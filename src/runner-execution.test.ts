import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runnerExecutionDomain, runnerInvocationCapability, decodeExternalTerminalProbeResult, probeExternalTerminal } from "./runner-execution"

const TEST_ROOT = resolve(import.meta.dir, "../.coder-loop/runtime/evidence/runner-execution-tests")

describe("runner execution domain", () => {
	test("exhaustively classifies local and external terminal runners", () => {
		expect(runnerExecutionDomain("claude")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("codex")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("opencode")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("hapi")).toEqual({
			kind: "external-terminal",
			probe: { argv: ["probe"], deadlineMs: 30_000, killGraceMs: 1_000 },
		})
	})

	test("exhaustively classifies invocation capability before execution side effects", () => {
		expect(runnerInvocationCapability("claude")).toEqual({ kind: "invocable" })
		expect(runnerInvocationCapability("codex")).toEqual({ kind: "invocable" })
		expect(runnerInvocationCapability("opencode")).toEqual({ kind: "invocable" })
		expect(runnerInvocationCapability("hapi")).toEqual({ kind: "probe-only", outcome: "invocation-pending" })
	})

	test("daemon refresh preserves the execution-domain ADT without a boolean projection", async () => {
		const daemonSource = await readFile(resolve(import.meta.dir, "daemon.ts"), "utf-8")
		expect(daemonSource).not.toContain("external: boolean")
		expect(daemonSource).toContain("RunnerExecutionDomain")
	})

	test("decodes the complete binary probe wire", () => {
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 0 })).toEqual({ kind: "available" })
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 69 })).toEqual({ kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null })
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 2 })).toEqual({ kind: "probe-failed", reason: "unexpected-exit", exitCode: 2, signal: null })
		expect(decodeExternalTerminalProbeResult({ kind: "signaled", signal: "SIGTERM" })).toEqual({ kind: "probe-failed", reason: "signal", exitCode: null, signal: "SIGTERM" })
		expect(decodeExternalTerminalProbeResult({ kind: "executable-missing" })).toEqual({ kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null })
		expect(decodeExternalTerminalProbeResult({ kind: "deadline-exceeded" })).toEqual({ kind: "probe-failed", reason: "deadline-exceeded", exitCode: null, signal: "SIGTERM" })
	})

	test("executes the literal probe wire against a fake binary", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const available = resolve(TEST_ROOT, "available")
		const unavailable = resolve(TEST_ROOT, "unavailable")
		await writeFile(available, "#!/bin/sh\ntest \"$1\" = probe || exit 64\nexit 0\n")
		await writeFile(unavailable, "#!/bin/sh\ntest \"$1\" = probe || exit 64\nexit 69\n")
		await chmod(available, 0o755)
		await chmod(unavailable, 0o755)
		expect(await probeExternalTerminal(available, ["probe"])).toEqual({ kind: "available" })
		expect(await probeExternalTerminal(unavailable, ["probe"])).toEqual({ kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null })
		expect(await probeExternalTerminal(resolve(TEST_ROOT, "missing"), ["probe"])).toEqual({ kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null })
	})

	test("classifies every executable launch failure and bounds a stuck probe", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const notExecutable = resolve(TEST_ROOT, "not-executable")
		const stuck = resolve(TEST_ROOT, "stuck")
		await writeFile(notExecutable, "#!/bin/sh\nexit 0\n")
		await chmod(notExecutable, 0o644)
		await writeFile(stuck, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n")
		await chmod(stuck, 0o755)
		expect(await probeExternalTerminal(notExecutable, ["probe"], { deadlineMs: 100, killGraceMs: 20 })).toEqual({ kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null })
		expect(await probeExternalTerminal(stuck, ["probe"], { deadlineMs: 20, killGraceMs: 100 })).toEqual({ kind: "probe-failed", reason: "deadline-exceeded", exitCode: null, signal: "SIGTERM" })
	})
})
