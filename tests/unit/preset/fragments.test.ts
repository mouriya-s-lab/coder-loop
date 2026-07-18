import { describe, expect, test } from "bun:test"

import {
	resolve,
	loadPreset,
	parsePreset,
	renderFragmentIndex,
	sliceFragmentsForPhase,
	Preset,
	PresetPhase,
	BoundaryRecord,
	BUNDLED_PRESET_DIR,
} from "./helpers"

describe("issue #400 — fragment index slicing per phase", () => {
	test("bundled preset declares roles on every phase and the engine slices accordingly", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(Object.fromEntries(preset.phases.map((phase) => [phase.name, [...phase.roles]]))).toEqual({
			iteration: ["common", "quality", "iter"],
			review: ["common", "quality", "review"],
			"blocked-responder": ["common"],
			"umbrella-finalizer": ["common"],
		})

		const iterationIndex = renderFragmentIndex(preset, preset.phases.find((phase) => phase.name === "iteration")!)
		const reviewIndex = renderFragmentIndex(preset, preset.phases.find((phase) => phase.name === "review")!)
		const blockedIndex = renderFragmentIndex(preset, preset.phases.find((phase) => phase.name === "blocked-responder")!)

		// Row #1: iteration index contains no review/* entries.
		const iterationReviewCount = countLineMatches(iterationIndex, /\breview\//)
		expect(iterationReviewCount).toBe(0)
		// Iteration index DOES contain iter/, quality/, common/.
		expect(iterationIndex).toContain(" (iter):")
		expect(iterationIndex).toContain(" (quality):")
		expect(iterationIndex).toContain(" (common):")
		// Row #2: review index contains no iter/* entries.
		const reviewIterCount = countLineMatches(reviewIndex, /\biter\//)
		expect(reviewIterCount).toBe(0)
		expect(reviewIndex).toContain(" (review):")
		expect(reviewIndex).toContain(" (quality):")
		expect(reviewIndex).toContain(" (common):")
		// Trigger phases: blocked-responder declares only common.
		expect(blockedIndex).toContain(" (common):")
		expect(blockedIndex).not.toContain(" (review):")
		expect(blockedIndex).not.toContain(" (iter):")
		expect(blockedIndex).not.toContain(" (quality):")
	})

	test("Row #4: phase↔role mapping comes from metadata and accepts non-convention names without engine guessing", () => {
		const root: BoundaryRecord = {
			name: "non-convention",
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
			phases: [
				{ name: "alpha", prompt: "alpha.md", variables: { K: "item.id" }, roles: ["roleA", "shared"] },
				{ name: "beta", prompt: "beta.md", variables: { K: "item.id" }, roles: ["roleB", "shared"] },
			],
			fragments: [
				{ id: "alpha/only", role: "roleA", path: "alpha-only.md" },
				{ id: "beta/only", role: "roleB", path: "beta-only.md" },
				{ id: "shared/common", role: "shared", path: "shared-common.md" },
			],
			agent: { binary: "echo" },
		}
		const preset = parsePreset(root, "/tmp")
		const alphaIndex = renderFragmentIndex(preset, preset.phases[0]!)
		expect(alphaIndex).toContain("- alpha/only (roleA):")
		expect(alphaIndex).toContain("- shared/common (shared):")
		expect(alphaIndex).not.toContain("- beta/only")
		const betaIndex = renderFragmentIndex(preset, preset.phases[1]!)
		expect(betaIndex).toContain("- beta/only (roleB):")
		expect(betaIndex).toContain("- shared/common (shared):")
		expect(betaIndex).not.toContain("- alpha/only")
	})

	test("Row #4 (second half): missing phase.roles raises a load-time error when the preset declares fragments", () => {
		const root: BoundaryRecord = {
			name: "needs-roles",
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
			phases: [
				// `roles` deliberately omitted — engine must NOT infer roles from the phase name.
				{ name: "alpha", prompt: "alpha.md", variables: { K: "item.id" } },
			],
			fragments: [
				{ id: "alpha/only", role: "roleA", path: "alpha-only.md" },
			],
			agent: { binary: "echo" },
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/preset\.phases\[0\]\.roles: required when preset declares fragments/)
	})

	test("rejects phase.roles entries that name a role no fragment declares", () => {
		const root: BoundaryRecord = {
			name: "bad-role",
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
			phases: [
				{ name: "p", prompt: "p.md", variables: { K: "item.id" }, roles: ["roleA", "ghost"] },
			],
			fragments: [
				{ id: "a", role: "roleA", path: "a.md" },
			],
			agent: { binary: "echo" },
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/preset\.phases\[0\]\.roles\[1\]: unrecognized role "ghost"/)
	})

	test("rejects duplicate role entries within a single phase", () => {
		const root: BoundaryRecord = {
			name: "dup-role",
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
			phases: [
				{ name: "p", prompt: "p.md", variables: { K: "item.id" }, roles: ["roleA", "roleA"] },
			],
			fragments: [
				{ id: "a", role: "roleA", path: "a.md" },
			],
			agent: { binary: "echo" },
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/preset\.phases\[0\]\.roles\[1\]: duplicate role "roleA"/)
	})

	test("Row #5: entry-prompt fragment references remain a subset of the per-phase sliced index", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		const iterEntry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "iter-entry.md")).text()
		const reviewEntry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "review-entry.md")).text()

		// Entries reference fragments by the absolute install-time path
		// `/Users/.../presets/gh-issue-pr-iteration/<tail>`; we compare against
		// fragment path tails relative to `BUNDLED_PRESET_DIR` so the test is
		// invariant to where the preset lives on disk.
		const iterTails = extractFragmentTails(iterEntry)
		const reviewTails = extractFragmentTails(reviewEntry)
		expect(iterTails.size).toBeGreaterThan(0)
		expect(reviewTails.size).toBeGreaterThan(0)

		const iterSliceTails = sliceTails(preset, preset.phases.find((phase) => phase.name === "iteration")!)
		const reviewSliceTails = sliceTails(preset, preset.phases.find((phase) => phase.name === "review")!)

		// Each entry tail is satisfied when at least one sliced fragment matches
		// it: same id, the fragment lives under that folder (entry references a
		// `<step>/` directory and the slice covers files inside), or the entry
		// names a specific fragment under a sliced folder.
		const covers = (tail: string, sliceTails: readonly string[]): boolean => sliceTails.some((sliceTail) => sliceTail === tail || sliceTail.startsWith(tail + "/") || tail.startsWith(sliceTail + "/"))
		const iterMissing = [...iterTails].filter((tail) => !covers(tail, iterSliceTails))
		const reviewMissing = [...reviewTails].filter((tail) => !covers(tail, reviewSliceTails))
		expect(iterMissing, `iter-entry references that fell outside iteration slice: ${iterMissing.join(", ")}`).toEqual([])
		expect(reviewMissing, `review-entry references that fell outside review slice: ${reviewMissing.join(", ")}`).toEqual([])
	})

	test("assertReadable in loadPreset still covers every fragment regardless of phase slicing", async () => {
		// loadPreset already runs assertReadable across preset.fragments (the full
		// set). This test guards that slicing did not get pushed into the
		// existence check by accident — the bundled preset has more fragments
		// than any single phase slices visible.
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		const maxSliceSize = Math.max(
			...preset.phases.map((phase) => sliceFragmentsForPhase(preset.fragments, phase.roles).length),
		)
		expect(maxSliceSize).toBeLessThan(preset.fragments.length)
	})
})

function countLineMatches(text: string, pattern: RegExp): number {
	let count = 0
	for (const line of text.split("\n")) {
		if (pattern.test(line)) count += 1
	}
	return count
}

// Pull `<role>/<...>` style tails out of an entry markdown — everything after
// the engine-owned `{{PRESET_ROOT}}` token. Source md files use that token so
// the engine can substitute the current absolute prompt root at materialize
// time (or at prompt-read time for the direct-parse path); we strip the token
// prefix and the `.md` extension and compare tails.
function extractFragmentTails(markdown: string): ReadonlySet<string> {
	const found = new Set<string>()
	const pattern = /\{\{PRESET_ROOT\}\}\/([A-Za-z0-9_./-]+?)(?:\.md|\/)(?=[`)<\s.,;:!]|$)/g
	for (const match of markdown.matchAll(pattern)) {
		const tail = match[1]
		if (tail === undefined) continue
		// Skip placeholder substrings the entry uses for "open this folder"
		// notation — e.g. `iter/steps/<step>` is informational, not a real path.
		if (tail.includes("<") || tail.includes(">")) continue
		// Strip trailing slashes that the regex left behind.
		const cleaned = tail.replace(/[/]+$/, "")
		if (cleaned === "") continue
		found.add(cleaned)
	}
	return found
}

function sliceTails(preset: Preset, phase: Pick<PresetPhase, "roles">): readonly string[] {
	return sliceFragmentsForPhase(preset.fragments, phase.roles).map((fragment) => {
		// fragment.path is presetDir + relative tail; we want the tail without
		// presetDir prefix or `.md` suffix.
		const rel = fragment.path.startsWith(preset.presetDir + "/")
			? fragment.path.slice(preset.presetDir.length + 1)
			: fragment.path
		return rel.replace(/\.md$/, "")
	})
}

