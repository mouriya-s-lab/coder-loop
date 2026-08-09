import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeProviderFactStoreLive, makeRunnerProviderLive, ProviderFactStore, RunnerProvider, type ProviderFact, type RunnerConfig } from "../../../src/v3/provider"

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

describe("provider fact store", () => {
	test("lists each durable winner with its committed identity", async () => {
		const root = await providerRoot()
		try {
			const fact: ProviderFact = {
				kind: "terminal-winner",
				endpoint: { kind: "runner-endpoint", digest: "endpoint-a" },
				run: {
					kind: "run",
					closure: { kind: "closure", task: { kind: "task", chain: { kind: "chain", value: "chain-a" }, value: "task-a" }, attempt: 0 },
					value: "run-a",
				},
				payload: { ok: true },
				sessionIdentity: null,
				observedAt: 1,
			}
			const identities = ["chain-a/task-a/0/run-a/step-alpha", "chain-a/task-a/0/run-a/step-beta"] as const
			const records = await Effect.runPromise(Effect.gen(function*() {
				const store = yield* ProviderFactStore
				for (const identity of identities) yield* store.commit(identity, fact)
				return yield* store.list
			}).pipe(Effect.provide(makeProviderFactStoreLive(root))))
			expect(records).toEqual(identities.map((identity) => ({ identity, fact })))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
