import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
	PresetCompileProjectionBoundary,
	PresetCompilePublicResultBoundary,
	compilePreset,
	projectCompiledPreset,
	projectPresetCompileResult,
} from "../../../src/loop"

const ROOT = resolve(import.meta.dir, "../../..")

describe("preset definition compiler", () => {
	test("returns exhaustive compiled and rejected envelopes", async () => {
		const compiled = projectPresetCompileResult(await compilePreset(resolve(ROOT, "presets/single-phase-example")))
		expect(compiled.kind).toBe("compiled")
		if (compiled.kind === "compiled") {
			expect(JSON.stringify(PresetCompileProjectionBoundary.assert(JSON.parse(JSON.stringify(compiled))))).toBe(JSON.stringify(compiled))
			expect(compiled.definition.root.children[0]).toMatchObject({ kind: "step", name: "run" })
		}

		const rejected = projectPresetCompileResult(await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/invalid")))
		expect(rejected.kind).toBe("rejected")
		if (rejected.kind === "rejected") expect(rejected.diagnostics.length).toBeGreaterThan(0)
		expect(JSON.stringify(PresetCompilePublicResultBoundary.assert(JSON.parse(JSON.stringify(rejected))))).toBe(JSON.stringify(rejected))
	})

	test("canonical projection is deterministic and carries separated identities", async () => {
		const result = await compilePreset(resolve(ROOT, "presets/single-phase-example"))
		expect(result.kind).toBe("compiled")
		if (result.kind !== "compiled") return
		const first = projectCompiledPreset(result.model, result.warnings)
		const second = projectCompiledPreset(result.model, result.warnings)
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
		expect(new Set([first.envelopeIdentity, first.productIdentity, first.definitionContentIdentity]).size).toBe(3)
		expect(first.definition.root.children.map((step) => step.identity)).toEqual(result.envelope.definition.root.children.map((step) => step.identity))
	})

	test("definition content identity covers prompt fragment template and auxiliary assets", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-content-identity-"))
		try {
			await mkdir(resolve(source, "templates"))
			await writeDefinition(source)
			await writeFile(resolve(source, "common.md"), "fragment-v1\n")
			await writeFile(resolve(source, "templates", "agent.md"), "template-v1\n")
			await writeFile(resolve(source, "auxiliary.json"), '{"version":1}\n')
			const baseline = await compilePreset(source)
			expect(baseline.kind).toBe("compiled")
			if (baseline.kind !== "compiled") return

			for (const [path, content] of [
				["common.md", "fragment-v2\n"],
				["run.md", "changed id={{ID}}\n"],
				["auxiliary.json", '{"version":2}\n'],
			] as const) {
				const original = await Bun.file(resolve(source, path)).text()
				await writeFile(resolve(source, path), content)
				const changed = await compilePreset(source)
				expect(changed.kind).toBe("compiled")
				if (changed.kind === "compiled") expect(changed.envelope.definitionContentIdentity).not.toBe(baseline.envelope.definitionContentIdentity)
				await writeFile(resolve(source, path), original)
			}
		} finally {
			await rm(source, { recursive: true, force: true })
		}
	})

	test("definition-store compilation preserves source semantics and selects bundle assets", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-definition-source-"))
		const store = await mkdtemp(resolve(tmpdir(), "coder-loop-definition-store-"))
		try {
			await writeDefinition(source)
			await writeFile(resolve(source, "common.md"), "fragment\n")
			const direct = await compilePreset(source)
			const pinned = await compilePreset(source, { definitionStore: { root: store } })
			expect(direct.kind).toBe("compiled")
			expect(pinned.kind).toBe("compiled")
			if (direct.kind === "compiled" && pinned.kind === "compiled") {
				expect(pinned.envelope).toEqual(direct.envelope)
				expect(pinned.model.presetDir).toContain(resolve(store, "definitions"))
				expect(pinned.model.steps[0]?.prompt).toContain(resolve(store, "definitions"))
			}
		} finally {
			await rm(source, { recursive: true, force: true })
			await rm(store, { recursive: true, force: true })
		}
	})

	test("missing sources and invalid routing stay in typed rejection", async () => {
		const missing = await compilePreset(resolve(ROOT, "package.json"))
		expect(missing.kind).toBe("rejected")
		if (missing.kind === "rejected") expect(missing.diagnostics[0]?.rule).toBe("preset-source")

		const invalid = await compilePreset(resolve(ROOT, "test-fixtures/preset-definition/recursive-invalid"))
		expect(invalid.kind).toBe("rejected")
		if (invalid.kind === "rejected") expect(invalid.diagnostics).toEqual([expect.objectContaining({ verdict: "error", rule: "preset-structure" })])
	})

	test("one-shot CLI emits exactly one public envelope", async () => {
		const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-relative-"))
		const source = resolve(cwd, "custom-preset")
		try {
			await mkdir(source)
			await writeDefinition(source)
			await writeFile(resolve(source, "common.md"), "fragment\n")
			const result = Bun.spawnSync({
				cmd: [process.execPath, resolve(ROOT, "src/loop.ts"), "preset", "compile", "custom-preset", "--json"],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(result.stderr)).toBe("")
			const envelope = PresetCompileProjectionBoundary.assert(JSON.parse(new TextDecoder().decode(result.stdout)))
			expect(envelope.definition.name).toBe("fixture-definition")
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})
})

async function writeDefinition(source: string): Promise<void> {
	await writeFile(resolve(source, "preset.toml"), `name = "fixture-definition"
[item]
idField = "id"
[item.fields]
id = "string"
[routing]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
[[steps]]
name = "run"
prompt = "run.md"
roles = ["common"]
[[steps.handoffs]]
status = "done"
when = "complete"
[steps.values]
ID = "item.id"
[[fragments]]
id = "common"
role = "common"
path = "common.md"
`)
	await writeFile(resolve(source, "run.md"), "id={{ID}}\n")
}
