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

	test("refuses to fabricate source-derived executable facts even when issue hints look complete", () => {
		const result = classifyReplay({
			number: 550,
			url: "https://github.com/mouriya-s-lab/coder-loop/issues/550",
			body: "## 验收标准\n| 1 | environment | browser | `open /` | visible |\nRun the real browser E2E. Whole-tree Pattern. Test delta forbidden.",
			comments: [],
			labels: [{ name: "kind:spike" }],
		}, [])
		expect(result.contract.kind).toBe("cannot-generate")
		if (result.contract.kind === "cannot-generate") expect(result.contract.reasons.join(" ")).toContain("cannot verify source-derived")
		expect(result.findings.some((finding) => finding.kind === "intent-gap")).toBe(false)
	})

	test("attributes preset drift to the review comment that contains the obsolete rule", () => {
		const reviewUrl = "https://github.com/mouriya-s-lab/coder-loop/pull/652#issuecomment-1"
		const result = classifyReplay({ number: 550, url: "https://github.com/mouriya-s-lab/coder-loop/issues/550", body: "plain intent", comments: [], labels: [] }, [{
			number: 652, url: "https://github.com/mouriya-s-lab/coder-loop/pull/652", body: "Closes #550", closingIssueNumbers: [550], reviews: [],
			comments: [{ url: reviewUrl, body: "script/harness E2E is always absent" }],
		}])
		const drift = result.findings.find((finding) => finding.kind === "preset-drift")
		expect(drift?.sourceUrl).toBe(reviewUrl)
		expect(drift?.excerpt).toContain("script/harness")
	})
})
