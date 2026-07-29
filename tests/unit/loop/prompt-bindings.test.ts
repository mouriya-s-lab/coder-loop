import { describe, expect, test } from "bun:test"

import {
	extractPromptPlaceholders,
	getItemId,
	parsePreset,
	renderPrompt,
	resolveBinding,
	validatePresetPhaseTemplate,
	parseInternalStatus,
	PresetPhase,
	ResolveContext,
	makeItem,
	makePreset,
	makeChainBindings,
	makeRuntime,
} from "./helpers"

describe("ItemRecord prompt bindings", () => {
	test("getItemId reads issueNumber when the preset idField is issue", () => {
		const preset = makePreset()
		expect(getItemId(makeItem({ issueNumber: 333 }), preset)).toBe("333")
	})

	test("getItemId still honors explicit extra id fields", () => {
		const preset = makePreset({
			item: { idField: "slug" },
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.slug" } },
				{ name: "review", prompt: "review.md", variables: { ISSUE: "item.slug" } },
			],
		})
		expect(getItemId(makeItem({ extra: { slug: "custom-id" } }), preset)).toBe("custom-id")
	})

	test("renderPrompt resolves ItemRecord phase and nested sessionIds", () => {
		const phase: PresetPhase = {
			name: "iteration",
			prompt: "iteration.md",
			exits: [],
			variables: [
				{ key: "ISSUE", source: { kind: "item", field: "issue" }, doc: null },
				{ key: "PHASE", source: { kind: "item", field: "phase" }, doc: null },
				{ key: "CODEX_SESSION", source: { kind: "item", field: "sessionIds.iteration.codex" }, doc: null },
			],
			trigger: null,
			defaultRunner: null,
			defaultModel: null,
			roles: [],
			rights: { createItems: false, writableFields: new Set(), privilegedOps: new Set() },
		}
		const item = makeItem({
			issueNumber: 333,
			phase: "iteration",
			sessionIds: { iteration: { codex: "thread-123" } },
		})
		const ctx: ResolveContext = { item, chain: makeChainBindings(), runtime: makeRuntime(), preset: makePreset() }

		expect(renderPrompt("#{{ISSUE}} {{PHASE}} {{CODEX_SESSION}}", phase, ctx)).toBe("#333 iteration thread-123")
	})

	test("renderPrompt injects runtime inputs and phase exits docs from phase metadata", () => {
		const phase: PresetPhase = {
			name: "review",
			prompt: "review.md",
			exits: [{ kind: "item-status", status: parseInternalStatus("done", "test.status"), when: "review accepted the result" }],
			variables: [
				{ key: "RUNTIME_INPUTS_DOC", source: { kind: "runtime", key: "runtimeInputsDoc" }, doc: null },
				{ key: "PHASE_EXITS_DOC", source: { kind: "runtime", key: "phaseExitsDoc" }, doc: null },
				{ key: "TARGET_CWD", source: { kind: "runtime", key: "targetCwd" }, doc: { label: "Target working directory", prefix: "", suffix: "", style: "code", blankBefore: false } },
			],
			trigger: null,
			defaultRunner: "claude",
			defaultModel: null,
			roles: [],
			rights: { createItems: false, writableFields: new Set(), privilegedOps: new Set() },
		}
		const ctx: ResolveContext = { item: makeItem(), chain: makeChainBindings(), runtime: makeRuntime({ targetCwd: "/repo" }), preset: makePreset() }

		const prompt = renderPrompt("{{RUNTIME_INPUTS_DOC}}\n\n{{PHASE_EXITS_DOC}}", phase, ctx)

		expect(prompt).toContain("- Target working directory: `/repo`")
		// #405 ADT: phase-exits doc renders the branch discriminator ("status" for the
		// item-status branch, "chain-action" for the chain-action branch) so a CLI reader
		// distinguishes a status write from a chain-side action without guessing.
		expect(prompt).toContain("- status `done`: review accepted the result")
	})

	test("resolveBinding keeps old item.issue and chain.requireBrowserEvidence compatibility", () => {
		const ctx: ResolveContext = {
			item: makeItem({ issueNumber: 184, branch: "issue-184", pr: 191 }),
			chain: makeChainBindings({ requireBrowserEvidence: true }),
			runtime: makeRuntime(),
			preset: makePreset(),
		}

		expect(resolveBinding({ kind: "item", field: "issue" }, ctx)).toBe("184")
		expect(resolveBinding({ kind: "item", field: "branch" }, ctx)).toBe("issue-184")
		expect(resolveBinding({ kind: "item", field: "pr" }, ctx)).toBe("191")
		expect(resolveBinding({ kind: "item", field: "branch" }, { ...ctx, item: makeItem({ branch: "legacy", extra: { branch: "extra" } }) })).toBe("extra")
		expect(resolveBinding({ kind: "chain", field: "requireBrowserEvidence", fallback: { kind: "none" } }, ctx)).toBe("true")
		expect(resolveBinding({ kind: "chain", field: "missingFlag", fallback: { kind: "value", value: false } }, ctx)).toBe("false")
	})

	test("parsePreset accepts nested ItemRecord fields but rejects unknown roots", () => {
		const preset = makePreset({
			item: { idField: "issue", fields: { sessionIds: "json" } },
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { SESSION: "item.sessionIds.iteration.codex" } },
				{ name: "review", prompt: "review.md", variables: { PHASE: "item.phase" } },
			],
		})
		expect(preset.phases[0]?.variables[0]).toEqual({ key: "SESSION", source: { kind: "item", field: "sessionIds.iteration.codex" }, doc: null })

		expect(() =>
			makePreset({
				phases: [{ name: "iteration", prompt: "iteration.md", variables: { BAD: "item.notARecordField.value" } }],
			}),
		).toThrow(/unrecognized item field/)
	})
})


describe("renderPrompt placeholder validation (issue #399)", () => {
	function makePhase(variables: ReadonlyArray<readonly [string, ReturnType<typeof parsePreset>["phases"][number]["variables"][number]["source"]]>): PresetPhase {
		return {
			name: "iteration",
			prompt: "iteration.md",
			exits: [],
			variables: variables.map(([key, source]) => ({ key, source, doc: null })),
			trigger: null,
			defaultRunner: null,
			defaultModel: null,
			roles: [],
			rights: { createItems: false, writableFields: new Set(), privilegedOps: new Set() },
		}
	}

	test("extractPromptPlaceholders finds positional matches and distinguishes escapes", () => {
		const template = "head {{A}} mid \\{{B}} {{A}} tail"
		const matches = extractPromptPlaceholders(template)
		expect(matches.length).toBe(3)
		expect(matches[0]).toMatchObject({ kind: "placeholder", key: "A" })
		expect(matches[1]).toMatchObject({ kind: "escape", key: "B" })
		expect(matches[2]).toMatchObject({ kind: "placeholder", key: "A" })
	})

	test("validatePresetPhaseTemplate flags template-undeclared as error and declared-unused as warn", () => {
		const phase = makePhase([
			["DECLARED", { kind: "item", field: "issue" }],
			["UNUSED", { kind: "item", field: "branch" }],
		])
		const findings = validatePresetPhaseTemplate("Hello {{DECLARED}} {{TYPO}}", phase, "/tmp/iter-entry.md")
		expect(findings).toEqual([
			{ file: "/tmp/iter-entry.md", key: "TYPO", direction: "template-undeclared", verdict: "error" },
			{ file: "/tmp/iter-entry.md", key: "UNUSED", direction: "declared-unused", verdict: "warn" },
		])
	})

	test("validatePresetPhaseTemplate skips escaped literals when checking template-undeclared", () => {
		const phase = makePhase([
			["KEY", { kind: "item", field: "issue" }],
		])
		// `\{{DOC}}` is the documentation-escape form; must not count as undeclared.
		const findings = validatePresetPhaseTemplate("Use \\{{DOC}} as a literal; {{KEY}} resolves", phase, "/tmp/x.md")
		expect(findings).toEqual([])
	})

	test("renderPrompt does positional substitution so values containing `{{` are not flagged as residue", () => {
		const phase = makePhase([
			["QUOTED", { kind: "item", field: "title" }],
		])
		const item = makeItem({ title: "literal {{NOT_A_KEY}} content" })
		const ctx: ResolveContext = { item, chain: makeChainBindings(), runtime: makeRuntime(), preset: makePreset() }
		const out = renderPrompt("before {{QUOTED}} after", phase, ctx)
		expect(out).toBe("before literal {{NOT_A_KEY}} content after")
	})

	test("renderPrompt renders escape `\\{{KEY}}` as literal `{{KEY}}`", () => {
		const phase = makePhase([
			["KEY", { kind: "item", field: "issue" }],
		])
		const item = makeItem({ issueNumber: 42 })
		const ctx: ResolveContext = { item, chain: makeChainBindings(), runtime: makeRuntime(), preset: makePreset() }
		const out = renderPrompt("doc: \\{{KEY}} live: {{KEY}}", phase, ctx)
		expect(out).toBe("doc: {{KEY}} live: 42")
	})

	test("renderPrompt throws on undeclared placeholder (defense-in-depth — loadPreset normally catches this earlier)", () => {
		const phase = makePhase([
			["DECLARED", { kind: "item", field: "issue" }],
		])
		const ctx: ResolveContext = { item: makeItem(), chain: makeChainBindings(), runtime: makeRuntime(), preset: makePreset() }
		expect(() => renderPrompt("text {{UNDECLARED}}", phase, ctx)).toThrow(/undeclared placeholder \{\{UNDECLARED\}\}/)
	})
})
