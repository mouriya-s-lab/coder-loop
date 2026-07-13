import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { compilePreset, loadPreset, projectCompiledPreset } from "./loop"

const ROOT = resolve(import.meta.dir, "..")

describe("preset compiler", () => {
	test("returns closed compiled and rejected variants", async () => {
		const compiled = await compilePreset(resolve(ROOT, "presets/single-phase-example"))
		expect(compiled.kind).toBe("compiled")
		const rejected = await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/invalid"))
		expect(rejected.kind).toBe("rejected")
		if (rejected.kind === "rejected") expect(rejected.diagnostics.length).toBeGreaterThan(0)
	})

	test("projection is deterministic and copies canonical semantic identities", async () => {
		const model = await loadPreset(resolve(ROOT, "presets/single-phase-example"))
		const first = projectCompiledPreset(model, [])
		const second = projectCompiledPreset(model, [])
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
		for (const task of model.tasks) expect(JSON.stringify(first)).toContain(`\"identity\":\"${task.identity}\"`)
		expect(new Set(model.tasks.map((task) => task.identity)).size).toBe(model.tasks.length)
	})

	test("preserves all warnings", async () => {
		const result = await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/warning"))
		expect(result.kind).toBe("compiled")
		if (result.kind === "compiled") expect(result.warnings).toContainEqual(expect.objectContaining({ verdict: "warn", rule: "dead-vocabulary" }))
	})

	test("direct and materialized compilation project identical source semantics", async () => {
		const source = resolve(ROOT, "presets/single-phase-example")
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-"))
		try {
			const direct = await compilePreset(source)
			const materialized = await compilePreset(source, { materialize: { root } })
			expect(direct.kind).toBe("compiled")
			expect(materialized.kind).toBe("compiled")
			if (direct.kind === "compiled" && materialized.kind === "compiled") {
				expect(JSON.stringify(projectCompiledPreset(direct.model, direct.warnings))).toBe(JSON.stringify(projectCompiledPreset(materialized.model, materialized.warnings)))
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("non-ENOENT source failures stay in the typed rejection channel", async () => {
		const result = await compilePreset(resolve(ROOT, "package.json"))
		expect(result.kind).toBe("rejected")
		if (result.kind === "rejected") expect(result.diagnostics[0].message).toContain("ENOTDIR")
	})

	test("malformed compile CLI shape is rejected", () => {
		const result = Bun.spawnSync({ cmd: [process.execPath, resolve(ROOT, "src/loop.ts"), "preset", "compile", "single-phase-example"], stderr: "pipe" })
		expect(result.exitCode).not.toBe(0)
		expect(new TextDecoder().decode(result.stderr)).toContain("Usage: coder-loop preset compile <name|path> --json")
	})
})
