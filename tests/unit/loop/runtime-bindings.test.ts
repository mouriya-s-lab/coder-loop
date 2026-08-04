import { describe, expect, test } from "bun:test"

import {
	readFile,
	resolve,
	buildCentralRuntimeBindingPaths,
	buildRenderBindings,
	buildRuntimeBindings,
	makeIssueRunContext,
	renderFragmentIndex,
	renderPrompt,
	ENGINE_RUNTIME_BINDING_KEYS,
	IssueRunContext,
	ResolveContext,
	StatusCurrentRunSnapshot,
	REPO_ROOT,
	TEST_ROOT,
	makeItem,
	makePreset,
	makeChainBindings,
	makeRuntime,
	makeOptions,
	documentedEngineRuntimeBindingCount,
	documentedEngineRuntimeBindingKeys,
} from "./helpers"

describe("runtime binding helpers", () => {
	test("documentation keeps engine runtime binding count and list aligned with source", async () => {
		const presetAuthoring = await readFile(resolve(REPO_ROOT, "docs/preset-authoring.md"), "utf8")
		const claude = await readFile(resolve(REPO_ROOT, "CLAUDE.md"), "utf8")

		expect(documentedEngineRuntimeBindingCount(presetAuthoring, "docs/preset-authoring.md")).toBe(ENGINE_RUNTIME_BINDING_KEYS.length)
		expect(documentedEngineRuntimeBindingCount(claude, "CLAUDE.md")).toBe(ENGINE_RUNTIME_BINDING_KEYS.length)
		expect(documentedEngineRuntimeBindingKeys(presetAuthoring)).toEqual([...ENGINE_RUNTIME_BINDING_KEYS])
	})

	test("reserved string registry includes engine-parsed summary enums", async () => {
		const registry = await readFile(resolve(REPO_ROOT, "docs/reserved-strings.md"), "utf8")

		// FINALIZER SUMMARY / decision=* survive — they feed `parseFinalizerSummaryDecisionFromText`
		// in the chain-complete trigger phase, which is out of scope for #405.
		for (const token of [
			"`FINALIZER SUMMARY:`",
			"`decision=complete`",
			"`decision=keep-active`",
		]) {
			expect(registry).toContain(token)
		}
		// #405: the review-summary five-word vocabulary is retired alongside the stdout parser
		// family. The registry must NOT carry any `verdict=...` entry as a reserved string — the
		// only "stop"-shaped flow signal goes through the typed phase-exits selection face.
		expect(registry).not.toContain("`verdict=retry`")
		expect(registry).not.toContain("`verdict=accepted`")
		expect(registry).not.toContain("`verdict=skip`")
		expect(registry).not.toContain("`verdict=blocked`")
		expect(registry).not.toContain("`verdict=stop`")
		expect(registry).not.toContain("`ITERATION SUMMARY:`")
		expect(registry).not.toContain("`REVIEW SUMMARY:`")
	})

	test("buildRenderBindings returns transparent chain data", () => {
		const options = makeOptions()
		const bindings = buildRenderBindings({ ...options, bindings: { ...options.bindings, customField: "custom" } })
		expect(bindings.repository).toBe("mouriya-s-lab/coder-loop")
		expect(bindings.baseBranch).toBe("main")
		expect(bindings.requireBrowserEvidence).toBe(false)
		expect(bindings.customField).toBe("custom")
	})

	test("preset-declared runtime business keys render without engine whitelist changes", () => {
		const preset = makePreset({
			runtime: { businessKeys: ["customBusiness"] },
			steps: [
				{ name: "iteration", prompt: "iteration.md", values: { CUSTOM: "runtime.customBusiness" } },
				{ name: "review", prompt: "review.md", values: { RUN_ID: "runtime.runId" } },
			],
		})
		const phase = preset.steps[0]!
		const ctx: ResolveContext = {
			item: makeItem(),
			chain: makeChainBindings(),
			runtime: makeRuntime({ customBusiness: "preset-owned-value" }),
			preset,
		}

		expect(phase.variables[0]).toEqual({ key: "CUSTOM", source: { kind: "runtime", key: "customBusiness", ownership: "preset" }, doc: null })
		expect(renderPrompt("{{CUSTOM}}", phase, ctx)).toBe("preset-owned-value")
		expect([...ENGINE_RUNTIME_BINDING_KEYS]).not.toContain("customBusiness")
	})

	test("parsePreset rejects undeclared runtime business keys", () => {
		expect(() =>
			makePreset({
				steps: [
					{ name: "iteration", prompt: "iteration.md", values: { CUSTOM: "runtime.customBusiness" } },
				],
			}),
		).toThrow(/unknown runtime key "customBusiness"/)
	})

	// #448: preset-supplied business key literals flow into RuntimeBindings via
	// buildRuntimeBindings so renderPrompt can resolve them with no engine
	// changes.
	test("buildRuntimeBindings merges preset-supplied businessKeyValues literals", () => {
		const preset = makePreset({
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: "preset-literal-ok" } },
			},
			steps: [
				{ name: "iteration", prompt: "iteration.md", values: { AUDIT_DEMO: "runtime.auditDemo" } },
			],
		})
		const phase = preset.steps[0]!
		const options = { ...makeOptions(), preset }
		const issueRun: IssueRunContext = {
			runIdGeneration: "new",
			resumedFromPhase: null,
			resumedStartedAt: null,
			resumedSessionId: null,
		}
		const runtime = buildRuntimeBindings({
			options,
			phase,
			runId: "run-bk",
			currentIssueFile: null,
			evidenceDir: null,
			agentCwd: REPO_ROOT,
			issueRun,
		})
		expect(runtime.auditDemo).toBe("preset-literal-ok")
		const ctx: ResolveContext = { item: makeItem(), chain: makeChainBindings(), runtime, preset }
		expect(renderPrompt("{{AUDIT_DEMO}}", phase, ctx)).toBe("preset-literal-ok")
	})

	test("buildRuntimeBindings maps issue run context into strings", () => {
		const options = makeOptions()
		const phase = options.preset.steps[0]!
		const issueRun: IssueRunContext = {
			runIdGeneration: "resumed",
			resumedFromPhase: "iteration",
			resumedStartedAt: "2026-05-28T00:00:00Z",
			resumedSessionId: "thread-resume",
		}
		const runtime = buildRuntimeBindings({
			options,
			phase,
			runId: "run-333",
			currentIssueFile: "/repo/issues/333.md",
			evidenceDir: "/repo/evidence/333",
			agentCwd: REPO_ROOT,
			issueRun,
		})
		expect(runtime.runIdGeneration).toBe("resumed")
		expect(runtime.resumedFromPhase).toBe("iteration")
		expect(runtime.resumedSessionId).toBe("thread-resume")
	})

	test("runtime bindings keep per-issue handoff optional", () => {
		const options = makeOptions()
		const phase = options.preset.steps[0]!
		const issueRun: IssueRunContext = {
			runIdGeneration: "new",
			resumedFromPhase: null,
			resumedStartedAt: null,
			resumedSessionId: null,
		}
		const runtime = buildRuntimeBindings({
			options,
			phase,
			runId: "run-357",
			currentIssueFile: null,
			evidenceDir: null,
			agentCwd: REPO_ROOT,
			issueRun,
		})
		expect(runtime.sharedContextPath).toBe(options.sharedContextPath)
		expect(runtime.currentIssueFile).toBe("")

		const centralPaths = buildCentralRuntimeBindingPaths({
			options,
			chain: { name: "fixture" },
			runId: "run-357",
			currentIssueFile: null,
			evidenceDir: null,
		})
		expect(centralPaths.sharedContextPath).toBe(resolve(TEST_ROOT, "chains/fixture/shared.md"))
		expect(centralPaths.currentIssueFile).toBe("")
	})

	test("makeIssueRunContext exposes current record data without LoopState", () => {
		const current: StatusCurrentRunSnapshot = {
			phase: "review",
			runId: "run-current",
			startedAt: "2026-05-28T00:00:00Z",
			extra: {},
		}
		expect(makeIssueRunContext(current)).toEqual({
			runIdGeneration: "resumed",
			resumedFromPhase: "review",
			resumedStartedAt: "2026-05-28T00:00:00Z",
			resumedSessionId: null,
		})
		expect(makeIssueRunContext(null).runIdGeneration).toBe("new")
	})

	test("renderFragmentIndex slices fragments to roles declared by the phase (issue #400)", () => {
		const preset = makePreset({
			steps: [
				{ name: "iteration", prompt: "iteration.md", roles: ["common", "iter"], values: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", roles: ["common", "review"], values: { ISSUE: "item.issue" } },
			],
			fragments: [
				{ id: "common/runtime-contract", role: "common", path: "common/runtime-contract.md" },
				{ id: "iter/steps/implement", role: "iter", path: "iter/steps/implement.md" },
				{ id: "review/actions/retry", role: "review", path: "review/actions/retry.md" },
			],
		})
		const [iterPhase, reviewPhase] = preset.steps
		const iter = renderFragmentIndex(preset, iterPhase!)
		expect(iter).toContain("- common/runtime-contract (common):")
		expect(iter).toContain("- iter/steps/implement (iter):")
		expect(iter).not.toContain("review/")
		const review = renderFragmentIndex(preset, reviewPhase!)
		expect(review).toContain("- common/runtime-contract (common):")
		expect(review).toContain("- review/actions/retry (review):")
		expect(review).not.toContain("iter/")
	})

	test("renderFragmentIndex returns empty string when the phase declares no roles", () => {
		const preset = makePreset({
			steps: [
				{ name: "iteration", prompt: "iteration.md", values: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", values: { ISSUE: "item.issue" } },
			],
		})
		expect(preset.steps[0]!.roles).toEqual([])
		expect(renderFragmentIndex(preset, preset.steps[0]!)).toBe("")
	})
})

