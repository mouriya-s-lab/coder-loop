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
		// item-status (retry_*/done/blocked/moot) or the `stop` chain-action. The
		// scheduler exhausts the item on a clean-exit trap; review-entry.md documents
		// that contract. If a completed edge is later added here, review-entry.md must
		// match it (moat-experiment-preset "review-entry.md ... clean-exit" assertions).
		const review = preset.phases.find((phase) => phase.name === "review")
		expect(review).toBeDefined()
		expect(review!.next.some((candidate) => candidate.kind === "completed")).toBe(false)
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
		// #753 audit finding: `blocked-responder-entry.md:5` had `{{{RUNTIME_INPUTS_DOC}}}`
		// (triple-brace on each side). The renderer's placeholder regex is `\{\{KEY\}\}`,
		// so a triple-brace matches the inner `{{KEY}}` and leaves a literal `{`/`}` on each
		// side of the substituted value — visible in the agent's prompt. Existing single-brace
		// guard above didn't catch it because the inner `{KEY}` is preceded by `{`, failing
		// the `(?<!\{)` lookbehind. Guard the shape directly.
		expect(allMarkdown).not.toMatch(/\{\{\{[A-Za-z_]/)
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
		// and forbidding clean-exit — both must survive edits.
		expect(reviewEntry).toContain("declares no `on = \"completed\"` next edge and no chain-action exit")
		expect(reviewEntry).toContain("Never clean-exit without writing a routed status")
		expect(reviewEntry).not.toContain("For the completed edge, exit cleanly without writing a status.")
		// #753 follow-up (audit finding): review-entry.md must not reference the
		// `stop` chain-action or the `review/actions/stop` fragment. moat-experiment-loop's
		// preset.toml declares chainAction = "stop" only on the `restore` phase — review
		// has no such exit. An earlier iteration of this PR wrote both into the entry doc,
		// which would let agents invoke `item exit-action --action stop` on review and get
		// a daemon default-deny (`review` phase has no chain-action exits declared).
		expect(reviewEntry).not.toContain("review/actions/stop")
		expect(reviewEntry).not.toContain("item exit-action --action stop")
		// #753 follow-up: `preset.toml` still declares the `review/actions/stop` fragment,
		// but only the review phase referenced it and review no longer does. Also verify
		// that no `chainAction` exit is declared on review (defense-in-depth against a
		// future edit that would revive the mismatch).
		const reviewPhase = preset.phases.find((phase) => phase.name === "review")
		expect(reviewPhase).toBeDefined()
		expect(reviewPhase!.exits.some((exit) => exit.kind === "chain-action")).toBe(false)
		expect(fs.readFileSync(path.join(presetDir, "umbrella-finalizer-entry.md"), "utf8")).toContain(
			"FINALIZER SUMMARY: decision=<complete|keep-active>",
		)
	})
})
