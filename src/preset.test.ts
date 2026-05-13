import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"

import { loadPreset, parsePreset, type Preset, type PresetVariableSource } from "./loop"

const REPO_ROOT = resolve(import.meta.dir, "..")
const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

const EXPECTED_FRAGMENTS = [
	{ id: "common/runtime-contract", role: "common", relPath: "common/runtime-contract.md" },
	{ id: "common/github-routing", role: "common", relPath: "common/github-routing.md" },
	{ id: "common/state-contract", role: "common", relPath: "common/state-contract.md" },
	{ id: "contract", role: "common", relPath: "contract.md" },
	{ id: "plan/index", role: "plan", relPath: "plan/index.md" },
	{ id: "plan/intake", role: "plan", relPath: "plan/intake.md" },
	{ id: "plan/classify", role: "plan", relPath: "plan/classify.md" },
	{ id: "plan/triage-existing", role: "plan", relPath: "plan/triage-existing.md" },
	{ id: "plan/decompose", role: "plan", relPath: "plan/decompose.md" },
	{ id: "plan/checkpoint-author", role: "plan", relPath: "plan/checkpoint-author.md" },
	{ id: "plan/adversarial-validate", role: "plan", relPath: "plan/adversarial-validate.md" },
	{ id: "plan/create-issues", role: "plan", relPath: "plan/create-issues.md" },
	{ id: "plan/init-queue", role: "plan", relPath: "plan/init-queue.md" },
	{ id: "plan/handoff", role: "plan", relPath: "plan/handoff.md" },
	{ id: "plan/final", role: "plan", relPath: "plan/final.md" },
	{ id: "iter/index", role: "iter", relPath: "iter/index.md" },
	{ id: "iter/read-context", role: "iter", relPath: "iter/read-context.md" },
	{ id: "iter/classify-scope", role: "iter", relPath: "iter/classify-scope.md" },
	{ id: "iter/implement", role: "iter", relPath: "iter/implement.md" },
	{ id: "iter/spike-comment", role: "iter", relPath: "iter/spike-comment.md" },
	{ id: "iter/verify-evidence", role: "iter", relPath: "iter/verify-evidence.md" },
	{ id: "iter/commit-pr", role: "iter", relPath: "iter/commit-pr.md" },
	{ id: "iter/handoff", role: "iter", relPath: "iter/handoff.md" },
	{ id: "iter/final", role: "iter", relPath: "iter/final.md" },
	{ id: "review/index", role: "review", relPath: "review/index.md" },
	{ id: "review/read-evidence", role: "review", relPath: "review/read-evidence.md" },
	{ id: "review/trace-honesty", role: "review", relPath: "review/trace-honesty.md" },
	{ id: "review/pr-protocol", role: "review", relPath: "review/pr-protocol.md" },
	{ id: "review/title-intent-gate", role: "review", relPath: "review/title-intent-gate.md" },
	{ id: "review/evidence-gate", role: "review", relPath: "review/evidence-gate.md" },
	{ id: "review/commitment-gate", role: "review", relPath: "review/commitment-gate.md" },
	{ id: "review/spike-followup-gate", role: "review", relPath: "review/spike-followup-gate.md" },
	{ id: "review/code-gate", role: "review", relPath: "review/code-gate.md" },
	{ id: "review/issue-closure-gate", role: "review", relPath: "review/issue-closure-gate.md" },
	{ id: "review/action-retry", role: "review", relPath: "review/action-retry.md" },
	{ id: "review/action-expand-parent", role: "review", relPath: "review/action-expand-parent.md" },
	{ id: "review/action-accept-pr", role: "review", relPath: "review/action-accept-pr.md" },
	{ id: "review/action-accept-no-pr", role: "review", relPath: "review/action-accept-no-pr.md" },
	{ id: "review/action-skip", role: "review", relPath: "review/action-skip.md" },
	{ id: "review/action-blocked", role: "review", relPath: "review/action-blocked.md" },
	{ id: "review/action-stop", role: "review", relPath: "review/action-stop.md" },
	{ id: "review/update-state", role: "review", relPath: "review/update-state.md" },
	{ id: "review/global-assessment", role: "review", relPath: "review/global-assessment.md" },
	{ id: "review/final", role: "review", relPath: "review/final.md" },
] as const

const EXPECTED_VARIABLE_KEYS = [
	"TARGET_CWD",
	"AGENT_CWD",
	"REPO",
	"BASE_BRANCH",
	"RUN_ID",
	"ISSUE",
	"WORKFLOW_FILE",
	"SHARED_CONTEXT_FILE",
	"STATE_FILE",
	"CURRENT_ISSUE_FILE",
	"ISSUE_DIR",
	"EVIDENCE_DIR",
	"EVIDENCE_ROOT_DIR",
	"LOG_DIR",
	"TRACE_FILE",
	"LOOP_FILE",
	"PROMPT_ROOT",
	"PROMPT_FRAGMENT_INDEX",
	"REQUIRE_BROWSER_EVIDENCE",
	"RUN_ID_GENERATION",
	"RESUMED_FROM_PHASE",
	"RESUMED_STARTED_AT",
	"ISSUE_BRANCH",
	"ISSUE_PR",
	"ISSUE_STATUS",
	"ISSUE_LAST_RUN_ID",
	"ISSUE_KIND",
] as const

describe("loadPreset (bundled gh-issue-pr-iteration)", () => {
	test("loads name, version, item.idField, agent.binary, statuses sets", async () => {
		const preset: Preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.name).toBe("gh-issue-pr-iteration")
		expect(preset.version).toBe(1)
		expect(preset.item.idField).toBe("issue")
		expect(preset.agent.binary).toBe("claude")
		expect([...preset.agent.extraArgs]).toEqual([])
		expect([...preset.statuses.continuable]).toEqual(["queued", "in_progress", "changes_requested"])
		expect([...preset.statuses.terminal]).toEqual(["blocked", "moot", "done"])
	})

	test("phases match the two hardcoded LoopPhase literals and prompt files exist", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.phases.map((p) => p.name)).toEqual(["iteration", "review"])
		for (const phase of preset.phases) {
			expect(phase.prompt.startsWith(BUNDLED_PRESET_DIR)).toBe(true)
			const info = await stat(phase.prompt)
			expect(info.isFile()).toBe(true)
		}
	})

	test("each phase declares all 27 variable bindings with parsed sources", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		for (const phase of preset.phases) {
			const keys = phase.variables.map(([key]) => key)
			expect(keys).toEqual([...EXPECTED_VARIABLE_KEYS])
			for (const [, source] of phase.variables) {
				expect(["item", "config", "runtime"]).toContain(source.kind)
			}
		}
	})

	test("specific variable bindings reflect renderPrompt source mapping", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		const iterVars = new Map(preset.phases[0]!.variables)
		const expectedItem = (field: string): PresetVariableSource => ({ kind: "item", field })
		const expectedConfig = (field: string): PresetVariableSource => ({ kind: "config", field })
		const expectedRuntime = (key: string): PresetVariableSource => ({ kind: "runtime", key })
		expect(iterVars.get("ISSUE")).toEqual(expectedItem("issue"))
		expect(iterVars.get("ISSUE_BRANCH")).toEqual(expectedItem("branch"))
		expect(iterVars.get("ISSUE_PR")).toEqual(expectedItem("pr"))
		expect(iterVars.get("REPO")).toEqual(expectedConfig("repository"))
		expect(iterVars.get("BASE_BRANCH")).toEqual(expectedConfig("baseBranch"))
		expect(iterVars.get("REQUIRE_BROWSER_EVIDENCE")).toEqual(expectedConfig("requireBrowserEvidence"))
		expect(iterVars.get("TARGET_CWD")).toEqual(expectedRuntime("targetCwd"))
		expect(iterVars.get("AGENT_CWD")).toEqual(expectedRuntime("agentCwd"))
		expect(iterVars.get("PROMPT_ROOT")).toEqual(expectedRuntime("presetDir"))
		expect(iterVars.get("PROMPT_FRAGMENT_INDEX")).toEqual(expectedRuntime("fragmentIndex"))
	})

	test("fragments match PROMPT_FRAGMENTS 1:1 by id+role+path and files exist", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.fragments.length).toBe(EXPECTED_FRAGMENTS.length)
		for (const [index, expected] of EXPECTED_FRAGMENTS.entries()) {
			const actual = preset.fragments[index]!
			expect(actual.id).toBe(expected.id)
			expect(actual.role).toBe(expected.role)
			expect(actual.path).toBe(resolve(BUNDLED_PRESET_DIR, expected.relPath))
			const info = await stat(actual.path)
			expect(info.isFile()).toBe(true)
		}
	})
})

describe("parsePreset schema validation", () => {
	const minimalRoot = () => ({
		name: "x",
		version: 1,
		item: { idField: "id" },
		statuses: { continuable: ["a"], terminal: ["b"] },
		phases: [
			{ name: "p", prompt: "p.md", variables: { K: "item.x" } },
		],
		fragments: [
			{ id: "f", role: "x", path: "f.md" },
		],
		agent: { binary: "echo" },
	})

	test("rejects bogus variable prefix", () => {
		const root = minimalRoot()
		root.phases[0]!.variables = { K: "bogus.x" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/bogus\.x/)
	})

	test("rejects bare name (no dot) variable source", () => {
		const root = minimalRoot()
		root.phases[0]!.variables = { K: "noDot" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/noDot/)
	})

	test("rejects continuable / terminal overlap", () => {
		const root = minimalRoot()
		root.statuses = { continuable: ["a", "b"], terminal: ["b", "c"] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/both continuable and terminal/)
	})

	test("rejects duplicate phase name", () => {
		const root = minimalRoot()
		root.phases = [
			{ name: "p", prompt: "p1.md", variables: { K: "item.x" } },
			{ name: "p", prompt: "p2.md", variables: { K: "item.y" } },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate name "p"/)
	})

	test("rejects duplicate fragment id", () => {
		const root = minimalRoot()
		root.fragments = [
			{ id: "f", role: "x", path: "f1.md" },
			{ id: "f", role: "x", path: "f2.md" },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate id "f"/)
	})

	test("accepts minimal valid preset and produces normalized shape", () => {
		const preset = parsePreset(minimalRoot(), "/tmp")
		expect(preset.name).toBe("x")
		expect(preset.item.idField).toBe("id")
		expect(preset.phases[0]!.variables[0]).toEqual(["K", { kind: "item", field: "x" }])
		expect(preset.fragments[0]!.path).toBe("/tmp/f.md")
	})
})
