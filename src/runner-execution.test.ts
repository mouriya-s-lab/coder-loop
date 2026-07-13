import { describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runnerExecutionDomain, decodeExternalTerminalProbeResult, probeExternalTerminal } from "./runner-execution"

const TEST_ROOT = resolve(import.meta.dir, "../.coder-loop/runtime/evidence/runner-execution-tests")

describe("runner execution domain", () => {
	test("exhaustively classifies local and external terminal runners", () => {
		expect(runnerExecutionDomain("claude")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("codex")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("opencode")).toEqual({ kind: "local-process" })
		expect(runnerExecutionDomain("hapi")).toEqual({ kind: "external-terminal", probeArgv: ["probe"] })
	})

	test("decodes the complete binary probe wire", () => {
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 0 })).toEqual({ kind: "available" })
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 69 })).toEqual({ kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null })
		expect(decodeExternalTerminalProbeResult({ kind: "exited", exitCode: 2 })).toEqual({ kind: "probe-failed", reason: "unexpected-exit", exitCode: 2, signal: null })
		expect(decodeExternalTerminalProbeResult({ kind: "signaled", signal: "SIGTERM" })).toEqual({ kind: "probe-failed", reason: "signal", exitCode: null, signal: "SIGTERM" })
		expect(decodeExternalTerminalProbeResult({ kind: "executable-missing" })).toEqual({ kind: "unavailable", reason: "binary-missing", exitCode: null, signal: null })
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
})
