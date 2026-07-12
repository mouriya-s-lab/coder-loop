import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
	CompileProjectionBoundary,
	CompileRejectedProjectionBoundary,
	compilePreset,
	projectCompiledTaskModel,
	stringifyCompileProjection,
} from "./loop"

const REPO_ROOT = resolve(import.meta.dir, "..")
const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

async function fixture(toml: string, prompt = "id={{ID}}\n"): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-"))
	await writeFile(resolve(dir, "preset.toml"), toml)
	await writeFile(resolve(dir, "entry.md"), prompt)
	return dir
}

function validToml(extraContinuable = ""): string {
	return `name = "compile-fixture"
[item]
idField = "id"
[item.fields]
id = "string"
[statuses]
continuable = ["queued"${extraContinuable}]
terminal = ["done", "exhausted"]
entry = "queued"
exhausted = "exhausted"
[[phases]]
name = "run"
prompt = "entry.md"
  [[phases.exits]]
  status = "done"
  when = "complete"
  [phases.variables]
  ID = "item.id"
`
}

describe("issue #549 compiled preset contract", () => {
	test("compiled model retains validated source bytes and projects the deterministic six-block contract", async () => {
		const result = await compilePreset(BUNDLED_PRESET_DIR)
		expect(result.kind).toBe("compiled")
		if (result.kind !== "compiled") return

		expect(result.model.phases.every((phase) => phase.promptContent.length > 0)).toBe(true)
		expect(result.model.fragments.every((fragment) => fragment.content.length > 0)).toBe(true)
		const projection = projectCompiledTaskModel(result.model, result.warnings)
		expect(Object.keys(projection)).toEqual([
			"schemaVersion", "preset", "statuses", "stateGraph", "phases", "tools", "fragments", "findings",
		])
		expect(projection.schemaVersion).toBe(1)
		expect(projection.stateGraph.edges.length).toBeGreaterThan(0)
		expect(projection.phases[0]!.variables[0]!.type).toBe("string")
		expect(projection.tools).toEqual([])
		const treeIds = projection.phases.flatMap((phase) => [phase.taskTree.id, ...phase.taskTree.children.map((child) => child.id)])
		expect(new Set(treeIds).size).toBe(treeIds.length)
		expect(treeIds.every((id) => !id.startsWith("/") && !id.includes(BUNDLED_PRESET_DIR))).toBe(true)
		CompileProjectionBoundary.assert(projection)
		const roundTripped = CompileProjectionBoundary.assert(JSON.parse(stringifyCompileProjection(projection)))
		expect(roundTripped.phases.flatMap((phase) => [phase.taskTree.id, ...phase.taskTree.children.map((child) => child.id)])).toEqual(treeIds)
		expect(stringifyCompileProjection(projection)).toBe(stringifyCompileProjection(projectCompiledTaskModel(result.model, result.warnings)))
	})

	test("rejected compilation is a closed structured ADT with non-empty diagnostics", async () => {
		const dir = await fixture(validToml().replace('status = "done"', 'status = "unknown"'))
		const result = await compilePreset(dir)
		expect(result.kind).toBe("rejected")
		if (result.kind !== "rejected") return
		expect(result.diagnostics.length).toBeGreaterThan(0)
		expect(result.diagnostics[0]!.verdict).toBe("error")
		expect(result.diagnostics[0]!.rule).toBe("preset-structure")
		CompileRejectedProjectionBoundary.assert(result)
	})

	test("direct and materialized compilation produce byte-identical public projections", async () => {
		const direct = await compilePreset(BUNDLED_PRESET_DIR)
		const materializeRoot = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-materialized-"))
		const materialized = await compilePreset(BUNDLED_PRESET_DIR, { materialize: { root: materializeRoot } })
		expect(direct.kind).toBe("compiled")
		expect(materialized.kind).toBe("compiled")
		if (direct.kind !== "compiled" || materialized.kind !== "compiled") return
		expect(stringifyCompileProjection(projectCompiledTaskModel(direct.model, direct.warnings)))
			.toBe(stringifyCompileProjection(projectCompiledTaskModel(materialized.model, materialized.warnings)))
	})

	test("warn compilation succeeds and lists every warning", async () => {
		const dir = await fixture(validToml(', "unused"'))
		const result = await compilePreset(dir)
		expect(result.kind).toBe("compiled")
		if (result.kind !== "compiled") return
		expect(result.warnings.map((finding) => finding.rule)).toContain("dead-vocabulary")
		const projection = projectCompiledTaskModel(result.model, result.warnings)
		expect(projection.findings).toEqual([...result.warnings])

		const cli = Bun.spawn(["bun", "src/loop.ts", "preset", "compile", dir, "--json"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
		expect(await cli.exited).toBe(0)
		const cliJson = CompileProjectionBoundary.assert(JSON.parse(await new Response(cli.stdout).text()))
		expect(cliJson.findings.map((finding) => finding.rule)).toContain("dead-vocabulary")
	})

	test("CLI emits projection on stdout and rejected diagnostics on stderr with matching exit codes", async () => {
		const success = Bun.spawn(["bun", "src/loop.ts", "preset", "compile", BUNDLED_PRESET_DIR, "--json"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
		expect(await success.exited).toBe(0)
		const successJson = CompileProjectionBoundary.assert(JSON.parse(await new Response(success.stdout).text()))
		expect(successJson.schemaVersion).toBe(1)

		const invalidDir = await fixture(validToml().replace('status = "done"', 'status = "unknown"'))
		const rejected = Bun.spawn(["bun", "src/loop.ts", "preset", "compile", invalidDir, "--json"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
		expect(await rejected.exited).not.toBe(0)
		const rejectedJson = CompileRejectedProjectionBoundary.assert(JSON.parse(await new Response(rejected.stderr).text()))
		expect(rejectedJson.kind).toBe("rejected")
		expect(rejectedJson.diagnostics[0]?.rule).toBe("preset-structure")
	})
})
