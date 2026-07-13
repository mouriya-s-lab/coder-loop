import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
	PresetCompilePublicResultBoundary,
	buildCompiledTaskTree,
	compilePreset,
	loadPreset,
	projectCompiledPreset,
	projectPresetCompileResult,
} from "./loop"

const ROOT = resolve(import.meta.dir, "..")

describe("preset compiler", () => {
	test("returns closed compiled and rejected variants", async () => {
		const compiled = await compilePreset(resolve(ROOT, "presets/single-phase-example"))
		expect(compiled.kind).toBe("compiled")
		const rejected = await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/invalid"))
		expect(rejected.kind).toBe("rejected")
		if (compiled.kind === "compiled") {
			const publicResult = PresetCompilePublicResultBoundary.assert(projectPresetCompileResult(compiled))
			expect(publicResult.kind).toBe("compiled")
			if (publicResult.kind === "compiled") {
				const classification: "continuable" | "terminal" = publicResult.projection.stateGraph.nodes[0]!.classification
				const sourceKind: "item" | "chain" | "runtime" = publicResult.projection.phases[0]!.variables[0]!.sourceKind
				expect(classification).toBe("continuable")
				expect(sourceKind).toBe("item")
			}
		}
		if (rejected.kind === "rejected") {
			expect(rejected.diagnostics.length).toBeGreaterThan(0)
			const publicResult = PresetCompilePublicResultBoundary.assert(projectPresetCompileResult(rejected))
			expect(publicResult.kind).toBe("rejected")
		}
	})

	test("projection is deterministic and copies canonical semantic identities", async () => {
		const model = await loadPreset(resolve(ROOT, "presets/single-phase-example"))
		const first = projectCompiledPreset(model, [])
		const second = projectCompiledPreset(model, [])
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
		expect(first.phases.map((phase) => phase.identity)).toEqual(model.tasks.children.map((tree) => tree.identity))
		expect(first.phases.map((phase) => phase.taskTree.identity)).toEqual(model.tasks.children.map((tree) => tree.identity))
		expect(first.phases.flatMap((phase) => phase.taskTree.children.map((task) => task.identity)))
			.toEqual(model.tasks.children.flatMap((tree) => tree.children.map((task) => task.identity)))
		expect(new Set(model.tasks.children.flatMap((tree) => [tree.identity, ...tree.children.map((task) => task.identity)])).size)
			.toBe(model.tasks.children.length * 2)

		const inserted = { ...model.phases[0]!, name: "inserted" }
		const reordered = [model.phases[1]!, inserted, model.phases[0]!].filter(Boolean)
		const tree = buildCompiledTaskTree(reordered)
		expect(tree.children.map((task) => task.identity)).toEqual(["phase:inserted", `phase:${model.phases[0]!.name}`])
		expect(tree.children.find((task) => task.phase === model.phases[0]!.name)?.identity).toBe(model.tasks.children[0]!.identity)
	})

	test("canonical identities remain unique for delimiter-bearing legal phase names", async () => {
		const model = await loadPreset(resolve(ROOT, "presets/single-phase-example"))
		const template = model.phases[0]!
		const phases = [{ ...template, name: "x" }, { ...template, name: "x:task" }]
		const tasks = buildCompiledTaskTree(phases)
		const collisionModel = { ...model, phases, tasks }
		const projection = projectCompiledPreset(collisionModel, [])
		const canonicalIdentities = [
			tasks.identity,
			...tasks.children.flatMap((phase) => [phase.identity, ...phase.children.map((task) => task.identity)]),
		]
		const projectedIdentities = [
			...projection.phases.flatMap((phase) => [phase.taskTree.identity, ...phase.taskTree.children.map((task) => task.identity)]),
		]

		expect(new Set(canonicalIdentities).size).toBe(canonicalIdentities.length)
		expect(projectedIdentities).toEqual(canonicalIdentities.slice(1))
	})

	test("preserves all warnings", async () => {
		const result = await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/warning"))
		expect(result.kind).toBe("compiled")
		if (result.kind === "compiled") expect(result.warnings).toContainEqual(expect.objectContaining({ verdict: "warn", rule: "dead-vocabulary" }))
	})

	test("direct and materialized compilation project identical source semantics", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-literal-"))
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-"))
		try {
			await writeFile(resolve(source, "preset.toml"), `name = "literal-path"\n[item]\nidField = "id"\n[item.fields]\nid = "string"\n[statuses]\ncontinuable = ["queued"]\nterminal = ["done", "exhausted"]\nentry = "queued"\nexhausted = "exhausted"\n[[phases]]\nname = "run"\nprompt = "run.md"\n[[phases.exits]]\nstatus = "done"\nwhen = "complete"\n[phases.variables]\nID = "item.id"\n`)
			await writeFile(resolve(source, "run.md"), `literal path: ${source}\nid={{ID}}\n`)
			const direct = await compilePreset(source)
			const materialized = await compilePreset(source, { materialize: { root } })
			expect(direct.kind).toBe("compiled")
			expect(materialized.kind).toBe("compiled")
			if (direct.kind === "compiled" && materialized.kind === "compiled") {
				expect(JSON.stringify(projectCompiledPreset(direct.model, direct.warnings))).toBe(JSON.stringify(projectCompiledPreset(materialized.model, materialized.warnings)))
			}
		} finally {
			await rm(root, { recursive: true, force: true })
			await rm(source, { recursive: true, force: true })
		}
	})

	test("non-ENOENT source failures stay in the typed rejection channel", async () => {
		const result = await compilePreset(resolve(ROOT, "package.json"))
		expect(result.kind).toBe("rejected")
		if (result.kind === "rejected") expect(result.diagnostics[0].message).toContain("ENOTDIR")
	})

	test("missing declared prompt and fragment sources return typed rejections", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-missing-source-"))
		const preset = `name = "missing-source"\n[item]\nidField = "id"\n[item.fields]\nid = "string"\n[statuses]\ncontinuable = ["queued"]\nterminal = ["done", "exhausted"]\nentry = "queued"\nexhausted = "exhausted"\n[[phases]]\nname = "run"\nprompt = "missing-prompt.md"\nroles = ["common"]\n[[phases.exits]]\nstatus = "done"\nwhen = "complete"\n[phases.variables]\nID = "item.id"\n[[fragments]]\nid = "missing"\nrole = "common"\npath = "missing-fragment.md"\n`
		try {
			await writeFile(resolve(source, "preset.toml"), preset)
			const missingPrompt = await compilePreset(source)
			expect(missingPrompt.kind).toBe("rejected")
			if (missingPrompt.kind === "rejected") {
				expect(missingPrompt.diagnostics).toEqual([{
					verdict: "error",
					rule: "preset-source",
					message: `Missing preset phase "run" prompt file: ${resolve(source, "missing-prompt.md")}`,
				}])
			}

			await writeFile(resolve(source, "missing-prompt.md"), "id={{ID}}\n")
			const missingFragment = await compilePreset(source)
			expect(missingFragment.kind).toBe("rejected")
			if (missingFragment.kind === "rejected") {
				expect(missingFragment.diagnostics).toEqual([{
					verdict: "error",
					rule: "preset-source",
					message: `Missing preset fragment "missing" file: ${resolve(source, "missing-fragment.md")}`,
				}])
			}
		} finally {
			await rm(source, { recursive: true, force: true })
		}
	})

	test("validation and DAG callback failures escape the compile-result channel", async () => {
		const dagCallbackFailure = new SyntaxError("DAG callback infrastructure failed")
		await expect(compilePreset(resolve(ROOT, "test-fixtures/preset-compile/warning"), {
			onDagFinding: () => { throw dagCallbackFailure },
		})).rejects.toBe(dagCallbackFailure)

		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-callback-"))
		const validationCallbackFailure = Object.assign(new Error("validation callback infrastructure failed"), { code: "EIO" })
		try {
			await writeFile(resolve(source, "preset.toml"), `name = "callback"
[item]
idField = "id"
[item.fields]
id = "string"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
entry = "queued"
exhausted = "exhausted"
[[phases]]
name = "run"
prompt = "run.md"
[[phases.exits]]
status = "done"
when = "complete"
[phases.variables]
ID = "item.id"
`)
			await writeFile(resolve(source, "run.md"), "id={{ID}} typo={{TYPO}}\n")
			await expect(compilePreset(source, {
				onValidationFinding: () => { throw validationCallbackFailure },
			})).rejects.toBe(validationCallbackFailure)
		} finally {
			await rm(source, { recursive: true, force: true })
		}
	})

	test("malformed compile CLI shape is rejected", () => {
		const result = Bun.spawnSync({ cmd: [process.execPath, resolve(ROOT, "src/loop.ts"), "preset", "compile", "single-phase-example"], stderr: "pipe" })
		expect(result.exitCode).not.toBe(0)
		expect(new TextDecoder().decode(result.stderr)).toContain("Usage: coder-loop preset compile <name|path> --json")
	})
})
