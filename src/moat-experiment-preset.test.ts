import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { loadPreset } from "./loop"

const presetDir = path.join(import.meta.dir, "..", "presets", "moat-experiment-loop")

describe("bundled moat-experiment-loop preset", () => {
	test("loads the designed phase graph and status vocabulary", async () => {
		const preset = await loadPreset(presetDir)

		expect(preset.name).toBe("moat-experiment-loop")
		expect(preset.phases.map((phase) => phase.name)).toEqual([
			"contract-enrichment",
			"prepare",
			"deploy",
			"experiment",
			"export",
			"restore",
			"writeback",
			"review",
			"blocked-responder",
			"umbrella-finalizer",
		])
		expect(preset.statuses.continuable).not.toContain("in_progress")
		expect(preset.statuses.terminal).toEqual(["done", "blocked", "moot", "exhausted"])
		expect(preset.phases.find((phase) => phase.name === "prepare")?.startsAttempt).toBe(true)
		expect(preset.phases.find((phase) => phase.name === "restore")?.exits).toContainEqual({
			kind: "chain-action",
			action: "stop",
			when: "Restore cannot complete automatically; publish exact recovery instructions and stop the chain without claiming cleanup.",
		})
	})

	test("ships every declared prompt fragment and hard-codes the retry budgets", async () => {
		const preset = await loadPreset(presetDir)
		for (const fragment of preset.fragments) expect(fs.existsSync(fragment.path)).toBe(true)

		const allMarkdown = fs
			.readdirSync(presetDir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
			.join("\n")
		expect(allMarkdown).not.toContain("in_progress")
		expect(allMarkdown).not.toMatch(/(?<!\{)\{(?:REPO|ISSUE|RUNTIME_INPUTS_DOC|PROMPT_FRAGMENT_INDEX|CHAIN_NAME|RUN_ID)\}(?!\})/)
		for (const phase of ["prepare", "deploy", "experiment", "export", "restore", "writeback"]) {
			const entry = fs.readFileSync(path.join(presetDir, `${phase}-entry.md`), "utf8")
			expect(entry).toContain("three")
			expect(entry).toContain("does not list the completed edge")
		}
		expect(fs.readFileSync(path.join(presetDir, "contract-enrichment-entry.md"), "utf8")).toContain(
			"never use it merely because the incoming packet needed enrichment",
		)
		expect(fs.readFileSync(path.join(presetDir, "review-entry.md"), "utf8")).toContain(
			"two occurrences per identical gap",
		)
		expect(fs.readFileSync(path.join(presetDir, "umbrella-finalizer-entry.md"), "utf8")).toContain(
			"FINALIZER SUMMARY: decision=<complete|keep-active>",
		)
	})
})
