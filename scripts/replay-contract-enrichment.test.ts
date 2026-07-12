import { describe, expect, test } from "bun:test"
import { classifyReplay, flattenPages } from "./replay-contract-enrichment"

describe("contract enrichment historical replay classification", () => {
	test("flattens every paginated REST page without a fixed ceiling", () => {
		expect(flattenPages([[{ id: 1 }], [], [{ id: 2 }, { id: 3 }]], "pages")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
	})
	test("keeps intent gaps, preset drift, reviewer discretion, and environment failures as sourced variants", () => {
		const result = classifyReplay({
			number: 549,
			url: "https://github.com/mouriya-s-lab/coder-loop/issues/549",
			body: "Implement the change. live issue body executable. Script E2E is required.",
			comments: [],
			labels: [{ name: "kind:code" }],
		}, [{
			number: 652,
			url: "https://github.com/mouriya-s-lab/coder-loop/pull/652",
			body: "Closes #549",
			comments: [],
			closingIssueNumbers: [549],
			reviews: [{
				url: "https://github.com/mouriya-s-lab/coder-loop/pull/652#pullrequestreview-1",
				state: "CHANGES_REQUESTED",
				body: "Scope mapping and failure path evidence are missing because the environment credential is unreachable.",
			}],
		}])
		expect(result.contract.kind).toBe("cannot-generate")
		expect(new Set(result.findings.map((finding) => finding.kind))).toEqual(new Set([
			"intent-gap", "preset-drift", "reviewer-discretion", "environment-failure",
		]))
		expect(result.findings.every((finding) => finding.sourceUrl.startsWith("https://github.com/"))).toBe(true)
	})

	test("derives explicit deliverable and contract hints without treating missing author detail as implementation failure", () => {
		const result = classifyReplay({
			number: 550,
			url: "https://github.com/mouriya-s-lab/coder-loop/issues/550",
			body: "## 验收标准\n| 1 | environment | browser | `open /` | visible |\nRun the real browser E2E. Whole-tree Pattern. Test delta forbidden.",
			comments: [],
			labels: [{ name: "kind:spike" }],
		}, [])
		expect(result.contract.kind).toBe("generated")
		if (result.contract.kind === "generated") {
			expect(result.contract.packet.deliverable).toBe("spike-comment")
			expect(result.contract.packet.patternScope.kind).toBe("whole-tree")
			expect(result.contract.packet.checks[0]?.kind).toBe("browser")
		}
		expect(result.findings.some((finding) => finding.kind === "intent-gap")).toBe(false)
	})
})
