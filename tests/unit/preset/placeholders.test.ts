import { describe, expect, test } from "bun:test"

import {
	resolve,
	mkdtemp,
	writeFile,
	tmpdir,
	loadPreset,
	PresetPlaceholderFinding,
	REPO_ROOT,
	BUNDLED_PRESET_DIR,
} from "./helpers"

describe("loadPreset placeholder validation (issue #399)", () => {
	async function writePresetFixture(toml: string, files: ReadonlyArray<{ name: string; body: string }>): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-preset-"))
		await writeFile(resolve(dir, "preset.toml"), toml)
		for (const file of files) await writeFile(resolve(dir, file.name), file.body)
		return dir
	}

	const minimalPresetToml = (entryRef: string) => `name = "fixture"
version = 1

[item]
idField = "id"

[item.fields]
title = "string"

[statuses]
continuable = ["pending"]
terminal    = ["done"]
exhausted   = "done"

[[phases]]
name   = "run"
prompt = "${entryRef}"

  # #408: minimal leaving edge so R2 passes for "pending" — without this the
  # cross-table DAG check rejects the fixture before the placeholder validator
  # ever runs. These placeholder tests only inspect the entry md, so the exit
  # is inert from their perspective.
  [[phases.exits]]
  status = "done"
  when = "Run finished; item lands in success-terminal vocabulary."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
binary    = "echo"
extraArgs = []
`

	test("rejects a preset whose entry md contains an undeclared placeholder", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}} title={{TITLE}} typo={{NOT_DECLARED}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		await expect(loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })).rejects.toThrow(
			/run-entry\.md: \{\{NOT_DECLARED\}\} \(template-undeclared\)$/,
		)
		const error = findings.find((f) => f.direction === "template-undeclared")
		expect(error).toBeDefined()
		expect(error?.key).toBe("NOT_DECLARED")
		expect(error?.verdict).toBe("error")
		expect(error?.file).toContain("run-entry.md")
	})

	test("accepts a preset whose declared variables are all reachable from the entry md", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}} title={{TITLE}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		const preset = await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("fixture")
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("accepts an escaped `\\{{KEY}}` literal even when KEY is not declared", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{
				name: "run-entry.md",
				body: "literal example: \\{{NOT_DECLARED}}\nreal: id={{KEY}} title={{TITLE}}\n",
			},
		])
		const findings: PresetPlaceholderFinding[] = []
		const preset = await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("fixture")
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("warns about declared-unused variables without failing the load", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		const warn = findings.find((f) => f.key === "TITLE" && f.direction === "declared-unused")
		expect(warn?.verdict).toBe("warn")
	})

	test("bundled gh-issue-pr-iteration preset loads with zero error findings", async () => {
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(BUNDLED_PRESET_DIR, { onValidationFinding: (f) => findings.push(f) })
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("bundled single-phase-example preset loads with zero error findings", async () => {
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(resolve(REPO_ROOT, "presets/single-phase-example"), { onValidationFinding: (f) => findings.push(f) })
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})
})

