import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { HookRuntime, makeHookRuntimeLive, type HookDeclaration } from "../../../src/v3/hooks"

test("concurrent executions retain independent durable outcomes", async () => {
	const base = join(process.cwd(), ".test-runs")
	await mkdir(base, { recursive: true })
	const root = await mkdtemp(join(base, "v3-hook-concurrent-audit-"))
	const log = join(root, "executions.log")
	const declaration: HookDeclaration = {
		id: "race",
		anchors: ["function-entry"],
		executable: "/bin/sh",
		argv: ["-c", `printf x >> "${log}"; sleep 0.1`],
		cwd: root,
		env: {},
		sandbox: { filesystem: "unrestricted", network: "unrestricted", resources: [] },
		launcher: { kind: "direct" },
		timeoutMs: 2_000,
		termGraceMs: 100,
		maxOutputBytes: 4_096,
	}
	const projection = { anchor: "function-entry" as const, occurrenceIdentity: "same-occurrence", observedAt: 1, facts: { case: "concurrent-audit" } }
	const layers = Array.from({ length: 8 }, () => makeHookRuntimeLive(root, [declaration], 1_000))
	try {
		await Promise.all(layers.map((layer) => Effect.runPromise(Effect.gen(function*() {
			return yield* (yield* HookRuntime).trigger(projection)
		}).pipe(Effect.provide(layer)))))
		const auditLayer = layers[0]
		if (auditLayer === undefined) throw new Error("audit layer missing")
		const audit = await Effect.runPromise(Effect.gen(function*() {
			return yield* (yield* HookRuntime).listAudit
		}).pipe(Effect.provide(auditLayer)))
		const executions = audit[0]?.executions ?? []
		expect((await readFile(log, "utf8")).length).toBe(8)
		expect(executions).toHaveLength(8)
		expect(executions.every((execution) => execution.kind === "closed")).toBe(true)
		expect(new Set(executions.map((execution) => execution.identity)).size).toBe(8)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
