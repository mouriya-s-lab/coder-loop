import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
	PresetCompilePublicResultBoundary,
	PresetCompileProjectionBoundary,
	buildCompiledTaskTree,
	compilePreset,
	loadPreset,
	projectCompiledPreset,
	projectPresetCompileResult,
} from "./loop"
import type { CompileResult } from "./loop"

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
		const roundTripped = PresetCompileProjectionBoundary.assert(JSON.parse(JSON.stringify(first)))
		expect(first.phases.map((phase) => phase.identity)).toEqual(model.tasks.children.map((tree) => tree.identity))
		expect(first.phases.map((phase) => phase.taskTree.identity)).toEqual(model.tasks.children.map((tree) => tree.identity))
		expect(first.phases.flatMap((phase) => phase.taskTree.children.map((task) => task.identity)))
			.toEqual(model.tasks.children.flatMap((tree) => tree.children.map((task) => task.identity)))
		expect(roundTripped.phases.map((phase) => phase.identity)).toEqual(model.tasks.children.map((tree) => tree.identity))
		expect(roundTripped.phases.flatMap((phase) => [phase.taskTree.identity, ...phase.taskTree.children.map((task) => task.identity)]))
			.toEqual(model.tasks.children.flatMap((tree) => [tree.identity, ...tree.children.map((task) => task.identity)]))
		expect(new Set(model.tasks.children.flatMap((tree) => [tree.identity, ...tree.children.map((task) => task.identity)])).size)
			.toBe(model.tasks.children.length * 2)

		const inserted = { ...model.phases[0]!, name: "inserted" }
		const reordered = [model.phases[1]!, inserted, model.phases[0]!].filter(Boolean)
		const tree = buildCompiledTaskTree(reordered)
		expect(tree.children.map((task) => task.identity)).toEqual(["phase:inserted", `phase:${model.phases[0]!.name}`])
		expect(tree.children.find((task) => task.phase === model.phases[0]!.name)?.identity).toBe(model.tasks.children[0]!.identity)
	})

	test("execution content identity covers referenced fragments templates and auxiliary sources", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-execution-content-identity-"))
		try {
			await mkdir(resolve(source, "templates"))
			await writeFile(resolve(source, "preset.toml"), `name = "content-identity"
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
roles = ["common"]
[[phases.exits]]
status = "done"
when = "complete"
[phases.variables]
ID = "item.id"
[[fragments]]
id = "common"
role = "common"
path = "common.md"
`)
			await writeFile(resolve(source, "run.md"), "id={{ID}}\n")
			await writeFile(resolve(source, "common.md"), "fragment-v1\n")
			await writeFile(resolve(source, "templates", "agent.md"), "template-v1\n")
			await writeFile(resolve(source, "auxiliary.json"), '{"version":1}\n')

			const baseline = await loadPreset(source)
			const identical = await loadPreset(source)
			expect(identical.sourceHash).toBe(baseline.sourceHash)

			await writeFile(resolve(source, "common.md"), "fragment-v2\n")
			const fragmentChanged = await loadPreset(source)
			expect(fragmentChanged.sourceHash).not.toBe(baseline.sourceHash)
			await writeFile(resolve(source, "common.md"), "fragment-v1\n")

			await writeFile(resolve(source, "run.md"), "template-v2 id={{ID}}\n")
			const templateChanged = await loadPreset(source)
			expect(templateChanged.sourceHash).not.toBe(baseline.sourceHash)
			await writeFile(resolve(source, "run.md"), "id={{ID}}\n")

			await writeFile(resolve(source, "auxiliary.json"), '{"version":2}\n')
			const auxiliaryChanged = await loadPreset(source)
			expect(auxiliaryChanged.sourceHash).not.toBe(baseline.sourceHash)
		} finally {
			await rm(source, { recursive: true, force: true })
		}
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
			projection.preset.taskTree.identity,
			...projection.phases.flatMap((phase) => [phase.taskTree.identity, ...phase.taskTree.children.map((task) => task.identity)]),
		]

		expect(new Set(canonicalIdentities).size).toBe(canonicalIdentities.length)
		expect(projectedIdentities).toEqual(canonicalIdentities)
		expect(PresetCompileProjectionBoundary.assert(JSON.parse(JSON.stringify(projection))).preset.taskTree.identity)
			.toBe(tasks.identity)
	})

	test("preserves all warnings", async () => {
		const result = await compilePreset(resolve(ROOT, "test-fixtures/preset-compile/warning"))
		expect(result.kind).toBe("compiled")
		if (result.kind === "compiled") expect(result.warnings).toContainEqual(expect.objectContaining({ verdict: "warn", rule: "dead-vocabulary" }))
	})

	test("preserves declared-unused placeholder warnings in compiled and public findings", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-unused-variable-"))
		try {
			await writeFile(resolve(source, "preset.toml"), `name = "unused-variable"
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
UNUSED = "item.id"
`)
			await writeFile(resolve(source, "run.md"), "No placeholders here.\n")
			const result = await compilePreset(source)
			expect(result.kind).toBe("compiled")
			if (result.kind === "compiled") {
				const warning = {
					verdict: "warn",
					rule: "declared-unused",
					message: `${resolve(source, "run.md")}: {{UNUSED}} (declared-unused)`,
				} as const
				expect(result.warnings).toContainEqual(warning)
				expect(projectCompiledPreset(result.model, result.warnings).findings).toContainEqual(warning)
			}
		} finally {
			await rm(source, { recursive: true, force: true })
		}
	})

	test("rejected diagnostics are non-empty and error-only at type and public boundaries", async () => {
		const errorDiagnostic = { verdict: "error", rule: "preset-source", message: "missing source" } as const
		const rejected: CompileResult = { kind: "rejected", diagnostics: [errorDiagnostic] }
		expect(PresetCompilePublicResultBoundary.assert(projectPresetCompileResult(rejected))).toEqual({
			kind: "rejected",
			schemaVersion: 1,
			diagnostics: [errorDiagnostic],
		})

		const warnDiagnostic = { verdict: "warn", rule: "declared-unused", message: "unused" } as const
		// @ts-expect-error rejected compile results cannot contain warning diagnostics
		const impossibleRejected: CompileResult = { kind: "rejected", diagnostics: [warnDiagnostic] }
		expect(impossibleRejected.kind).toBe("rejected")
		expect(() => PresetCompilePublicResultBoundary.assert({
			kind: "rejected",
			schemaVersion: 1,
			diagnostics: [warnDiagnostic],
		})).toThrow()

		const model = await loadPreset(resolve(ROOT, "presets/single-phase-example"))
		// @ts-expect-error compiled results cannot carry error findings
		const impossibleCompiled: CompileResult = { kind: "compiled", model, warnings: [errorDiagnostic] }
		expect(impossibleCompiled.kind).toBe("compiled")
		const projection = projectCompiledPreset(model, [])
		expect(() => PresetCompileProjectionBoundary.assert({
			...projection,
			findings: [errorDiagnostic],
		})).toThrow()
	})

	test("direct and materialized compilation project identical source semantics", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-literal-"))
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-"))
		try {
			await writeFile(resolve(source, "preset.toml"), `name = "literal-path"\n[item]\nidField = "id"\n[item.fields]\nid = "string"\n[statuses]\ncontinuable = ["queued"]\nterminal = ["done", "exhausted"]\nentry = "queued"\nexhausted = "exhausted"\n[[phases]]\nname = "run"\nprompt = "run.md"\n[[phases.exits]]\nstatus = "done"\nwhen = "complete"\n[phases.variables]\nID = "item.id"\nUNUSED = "item.id"\n`)
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

	test("non-ENOENT compile source resolution failures emit structured rejections", async () => {
		const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-source-resolution-"))
		const source = resolve(cwd, "recursive-link")
		try {
			await symlink("recursive-link", source)
			const result = Bun.spawnSync({
				cmd: [process.execPath, resolve(ROOT, "src/loop.ts"), "preset", "compile", source, "--json"],
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(result.exitCode).not.toBe(0)
			expect(new TextDecoder().decode(result.stdout)).toBe("")
			const rejection = PresetCompilePublicResultBoundary.assert(JSON.parse(new TextDecoder().decode(result.stderr)))
			expect(rejection.kind).toBe("rejected")
			if (rejection.kind === "rejected") {
				expect(rejection.diagnostics).toEqual([expect.objectContaining({ verdict: "error", rule: "preset-source" })])
			}
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})

	test("empty statuses are rejected at the preset parse boundary", async () => {
		const source = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-empty-status-"))
		try {
			await writeFile(resolve(source, "preset.toml"), `name = "empty-status"
[item]
idField = "id"
[item.fields]
id = "string"
[statuses]
continuable = [""]
terminal = ["done", "exhausted"]
entry = ""
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
			await writeFile(resolve(source, "run.md"), "id={{ID}}\n")
			const result = await compilePreset(source)
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected") {
				expect(result.diagnostics).toEqual([{
					verdict: "error",
					rule: "preset-structure",
					message: "preset.statuses.continuable[0] must be a non-empty status",
				}])
			}
		} finally {
			await rm(source, { recursive: true, force: true })
		}
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

	test("bare cwd-relative preset directories win before bundled-name fallback", async () => {
		const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-compile-relative-"))
		const source = resolve(cwd, "custom-preset")
		try {
			await mkdir(source)
			await writeFile(resolve(source, "preset.toml"), `name = "cwd-relative"
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
			await writeFile(resolve(source, "run.md"), "id={{ID}}\n")
			const result = Bun.spawnSync({
				cmd: [process.execPath, resolve(ROOT, "src/loop.ts"), "preset", "compile", "custom-preset", "--json"],
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(result.stderr)).toBe("")
			const projection = PresetCompileProjectionBoundary.assert(JSON.parse(new TextDecoder().decode(result.stdout)))
			expect(projection.preset.name).toBe("cwd-relative")
			expect(projection.preset.dir).toBe(await realpath(source))
		} finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})
})
