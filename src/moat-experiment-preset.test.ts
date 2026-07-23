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
		// #753: review is the terminal routed-verdict phase — every exit is a routed
		// item-status (retry_*/done/blocked/moot). Review declares no chain-action;
		// only restore does. The scheduler exhausts the item on a clean-exit trap;
		// review-entry.md documents that contract. If a completed edge or chain-action
		// is later added here, review-entry.md must match it (moat-experiment-preset
		// "review-entry.md ... clean-exit" assertions).
		const review = preset.phases.find((phase) => phase.name === "review")
		expect(review).toBeDefined()
		expect(review!.next.some((candidate) => candidate.kind === "completed")).toBe(false)
		expect(review!.exits.some((exit) => exit.kind === "chain-action")).toBe(false)
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
		const reviewEntry = fs.readFileSync(path.join(presetDir, "review-entry.md"), "utf8")
		expect(reviewEntry).toContain("two occurrences per identical gap")
		// #753: review-entry.md was previously copied from other phase templates that
		// legitimately advance on a completed edge; review, being the final routed-verdict
		// phase, must not tell the agent to clean-exit. The completion protocol asserts
		// preset↔entry-doc consistency by declaring "no `on = \"completed\"` next edge"
		// and forbidding clean-exit — both must survive edits. The stop chain-action
		// belongs to restore, not review, so the doc must not tell reviewers to invoke it.
		expect(reviewEntry).toContain("declares no `on = \"completed\"` next edge and no chain-action exit")
		expect(reviewEntry).toContain("Never clean-exit without writing a routed status")
		expect(reviewEntry).not.toContain("For the completed edge, exit cleanly without writing a status.")
		// The doc must not tell reviewers to invoke a chain-action (which review does not declare).
		expect(reviewEntry).not.toMatch(/item exit-action[^\n]*--action stop/)
		expect(reviewEntry).not.toContain("`stop` chain-action")
		// Orthogonal budget: phase-local retry (three self-entries) and review-visible
		// identical-gap cap (two) are complementary and must both be documented in review-entry.md.
		expect(reviewEntry).toContain("orthogonal to each producer's own phase-local retry budget")
		// #Finding4: restore is the sole chain-action holder; its entry doc must invoke
		// stop via `item exit-action --action stop`, and stages/stop must ship.
		const restoreEntry = fs.readFileSync(path.join(presetDir, "restore-entry.md"), "utf8")
		expect(restoreEntry).toContain("stages/stop")
		expect(restoreEntry).toContain("item exit-action")
		expect(restoreEntry).toContain("--action stop")
		expect(fs.existsSync(path.join(presetDir, "stages", "stop.md"))).toBe(true)
		expect(fs.existsSync(path.join(presetDir, "review", "actions", "stop.md"))).toBe(false)
		expect(fs.readFileSync(path.join(presetDir, "umbrella-finalizer-entry.md"), "utf8")).toContain(
			"FINALIZER SUMMARY: decision=<complete|keep-active>",
		)
	})
})
