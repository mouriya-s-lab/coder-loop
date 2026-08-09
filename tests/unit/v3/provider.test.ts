import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeProviderFactStoreLive, makeRunnerProviderLive, RunnerProvider, type RunnerConfig } from "../../../src/v3/provider"

describe("RunnerProvider endpoint probe", () => {
	test("does not report a remote descriptor ready from its local executable", async () => {
		const root = await providerRoot()
		try {
			const config = runnerConfig({
				transport: "remote-api",
				server: "https://127.0.0.1:1",
				principal: "missing-principal",
				machine: "missing-machine",
				profile: "missing-profile",
			})
			const probe = await runProbe(config, root)
			expect(probe.kind).toBe("unknown")
			expect(probe.evidence.detail).toContain('"transport":"remote-api"')
			expect(probe.evidence.detail).toContain('"principal":"missing-principal"')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("reports ready only for a fully local descriptor", async () => {
		const root = await providerRoot()
		try {
			const probe = await runProbe(runnerConfig({ transport: "local-process", server: "", principal: "", machine: "", profile: "" }), root)
			expect(probe.kind).toBe("ready")
			expect(probe.evidence.detail).toContain('"transport":"local-process"')
			expect(probe.evidence.detail).toContain(`executable:${process.execPath}`)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("reports an absent executable with the complete descriptor", async () => {
		const root = await providerRoot()
		try {
			const config = { ...runnerConfig({ transport: "local-process", server: "", principal: "", machine: "", profile: "" }), executable: join(root, "missing-runner") }
			const probe = await runProbe(config, root)
			expect(probe.kind).toBe("absent")
			expect(probe.evidence.detail).toContain('"transport":"local-process"')
			expect(probe.evidence.detail).toContain("ENOENT")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

async function providerRoot(): Promise<string> {
	await mkdir(join(process.cwd(), ".test-runs"), { recursive: true })
	return mkdtemp(join(process.cwd(), ".test-runs", "v3-provider-"))
}

async function runProbe(config: RunnerConfig, root: string) {
	const provider = makeRunnerProviderLive(config).pipe(Layer.provide(makeProviderFactStoreLive(root)))
	return Effect.runPromise(Effect.gen(function*() {
		return yield* (yield* RunnerProvider).probe
	}).pipe(Effect.provide(provider)))
}

function runnerConfig(endpoint: RunnerConfig["endpoint"]): RunnerConfig {
	return {
		kind: "codex",
		executable: process.execPath,
		model: "contract-test",
		endpoint,
		env: {},
		sandbox: { filesystem: "closure-only", network: "declared-endpoints", resources: [] },
		launcher: { kind: "sandbox-exec", executable: "/usr/bin/sandbox-exec" },
		timeoutMs: 1_000,
		termGraceMs: 100,
		maxOutputBytes: 1_024,
	}
}
