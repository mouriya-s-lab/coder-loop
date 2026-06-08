import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"

import { DEFAULT_ATTEMPT_TIMEOUT_SECONDS, chainCompleteTriggerPhases, lastNonTriggerPhaseForPreset, loadPreset, parsePreset, triggeredPhasesAfter, type Preset, type PresetVariableSource } from "./loop"

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
	{ id: "plan/business-frame", role: "plan", relPath: "plan/business-frame.md" },
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
	{ id: "iter/resolve-blocker", role: "iter", relPath: "iter/resolve-blocker.md" },
	{ id: "iter/implement", role: "iter", relPath: "iter/implement.md" },
	{ id: "iter/spike-comment", role: "iter", relPath: "iter/spike-comment.md" },
	{ id: "iter/source-writing-spike", role: "iter", relPath: "iter/source-writing-spike.md" },
	{ id: "iter/verify-evidence", role: "iter", relPath: "iter/verify-evidence.md" },
	{ id: "iter/commit-pr", role: "iter", relPath: "iter/commit-pr.md" },
	{ id: "iter/handoff", role: "iter", relPath: "iter/handoff.md" },
	{ id: "iter/final", role: "iter", relPath: "iter/final.md" },
	{ id: "review/index", role: "review", relPath: "review/index.md" },
	{ id: "review/read-evidence", role: "review", relPath: "review/read-evidence.md" },
	{ id: "review/trace-honesty", role: "review", relPath: "review/trace-honesty.md" },
	{ id: "review/pr-protocol", role: "review", relPath: "review/pr-protocol.md" },
	{ id: "review/source-writing-spike-gate", role: "review", relPath: "review/source-writing-spike-gate.md" },
	{ id: "review/title-intent-gate", role: "review", relPath: "review/title-intent-gate.md" },
	{ id: "review/evidence-gate", role: "review", relPath: "review/evidence-gate.md" },
	{ id: "review/caveat-honesty-gate", role: "review", relPath: "review/caveat-honesty-gate.md" },
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
	"ISSUE",
	"RUN_ID",
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
	"RUNTIME_INPUTS_DOC",
	"PHASE_EXITS_DOC",
	"ISSUE_KIND_DOC",
	"REQUIRE_BROWSER_EVIDENCE",
	"ISSUE_BRANCH",
	"ISSUE_PR",
	"ISSUE_STATUS",
	"ISSUE_LAST_RUN_ID",
	"ISSUE_KIND",
	"RUN_ID_GENERATION",
	"RESUMED_FROM_PHASE",
	"RESUMED_STARTED_AT",
	"RESUMED_SESSION_ID",
	"CHAIN_NAME",
	"CHAIN_UMBRELLA_REPO",
	"CHAIN_UMBRELLA_ISSUE",
	"CHAIN_BASE_BRANCH",
	"REPO_CWD",
] as const

describe("loadPreset (bundled gh-issue-pr-iteration)", () => {
	test("loads name, version, item.idField, agent.binary, statuses sets", async () => {
		const preset: Preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.name).toBe("gh-issue-pr-iteration")
		expect(preset.version).toBe(1)
		expect(preset.item.idField).toBe("issue")
		expect(Object.fromEntries(preset.item.fields)).toEqual({
			branch: { type: "string" },
			pr: { type: "number" },
			lastRunId: { type: "string" },
		})
		expect(preset.agent.binary).toBe("claude")
		expect([...preset.agent.extraArgs]).toEqual([])
		expect(preset.agent.attemptTimeoutSeconds).toBe(DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
		expect([...preset.statuses.continuable]).toEqual(["queued", "in_progress", "changes_requested"])
		expect([...preset.statuses.terminal]).toEqual(["blocked", "moot", "done", "exhausted"])
		expect(preset.phases.find((phase) => phase.name === "iteration")?.exits).toEqual([])
		expect(preset.phases.find((phase) => phase.name === "review")?.exits.map((exit) => exit.status)).toEqual(["changes_requested", "blocked", "moot", "done", "exhausted"])
	})

	test("phases include iteration, review, blocked responder, and umbrella finalizer triggers", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.phases.map((p) => p.name)).toEqual(["iteration", "review", "blocked-responder", "umbrella-finalizer"])
		expect(Object.fromEntries(preset.phases.map((phase) => [phase.name, phase.defaultRunner]))).toEqual({
			iteration: "codex",
			review: "claude",
			"blocked-responder": "codex",
			"umbrella-finalizer": "codex",
		})
		expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
		expect(triggeredPhasesAfter(preset, "review", "blocked").map((phase) => phase.name)).toEqual(["blocked-responder"])
		expect(chainCompleteTriggerPhases(preset).map((phase) => phase.name)).toEqual(["umbrella-finalizer"])
		for (const phase of preset.phases) {
			expect(phase.prompt.startsWith(BUNDLED_PRESET_DIR)).toBe(true)
			const info = await stat(phase.prompt)
			expect(info.isFile()).toBe(true)
		}
	})

	test("each phase declares the shared variable bindings with parsed sources", async () => {
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

	test("blocked responder prompt carries the required cross-repo side effects", async () => {
		const prompt = await Bun.file(resolve(BUNDLED_PRESET_DIR, "blocked-responder-entry.md")).text()
		expect(prompt).toContain("gh")
		expect(prompt).toContain("kind:blocked")
		expect(prompt).toContain("Unblocks: {{REPO}}#{{ISSUE}}")
		expect(prompt).toContain("central state DB")
		expect(prompt).toContain("coder-loop daemon start <targetRepoPath> --require-browser-evidence")
		expect(prompt).toContain("Do not change the current repository's blocked item")
		expect(prompt).toContain("ITERATION SUMMARY: blocked_responder=")
	})

	test("umbrella finalizer prompt carries the required chain-complete assessment contract", async () => {
		const prompt = await Bun.file(resolve(BUNDLED_PRESET_DIR, "umbrella-finalizer-entry.md")).text()
		expect(prompt).toContain("chain-complete trigger agent")
		expect(prompt).toContain("umbrella issue, sub-issues, closing PRs")
		expect(prompt).toContain("This finalizer does not replace per-issue PR review gates")
		expect(prompt).toContain("Child closure table")
		expect(prompt).toContain("decision=<complete|keep-active>")
		expect(prompt).toContain("decision=keep-active")
		expect(prompt).toContain("Do not merge PRs")
	})
})

describe("parsePreset schema validation", () => {
	const minimalRoot = () => ({
		name: "x",
		version: Number("1"),
		item: { idField: "id" },
		statuses: { continuable: ["a"], terminal: ["b"] },
		phases: [
			{ name: "p", prompt: "p.md", variables: { K: "item.id" } },
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
			{ name: "p", prompt: "p1.md", variables: { K: "item.id" } },
			{ name: "p", prompt: "p2.md", variables: { K: "item.id" } },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate name "p"/)
	})

	test("accepts trigger phases and keeps review as the last non-trigger phase", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked", "done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

		expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: "blocked" })
		expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
		expect(triggeredPhasesAfter(preset, "review", "blocked").map((phase) => phase.name)).toEqual(["responder"])
		expect(triggeredPhasesAfter(preset, "review", "done")).toEqual([])
	})

	test("accepts per-phase exit declarations", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.statuses = { continuable: ["queued", "in_progress"], terminal: ["done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", runner: "claude", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

		expect(preset.phases.map((phase) => phase.exits.map((exit) => exit.status))).toEqual([["in_progress"], ["done"]])
		expect(preset.phases[1]!.defaultRunner).toBe("claude")
	})

	test("rejects per-phase exit declarations outside preset statuses", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "missing", when: "bad" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: unknown status "missing"/)
	})

	test("rejects duplicate per-phase exit declarations", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "a", when: "one" }, { status: "a", when: "two" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: duplicate status "a"/)
	})

	test("rejects legacy statusWrites declarations", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", statusWrites: ["a"], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/statusWrites: use \[\[phases\.exits\]\]/)
	})

	test("accepts chain-complete trigger phases", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked", "done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
			{ name: "finalizer", prompt: "finalizer.md", trigger: { on: "chain-complete" }, variables: { K: "runtime.runId" } },
		]

		const preset = parsePreset(root, "/tmp")

		expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: "blocked" })
		expect(preset.phases[3]!.trigger).toEqual({ on: "chain-complete" })
		expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
		expect(triggeredPhasesAfter(preset, "review", "blocked").map((phase) => phase.name)).toEqual(["responder"])
		expect(chainCompleteTriggerPhases(preset).map((phase) => phase.name)).toEqual(["finalizer"])
	})

	test("rejects trigger afterPhase that does not name a declared phase", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.afterPhase: unknown phase "review"/)
	})

	test("rejects trigger whenStatus outside preset statuses", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "iteration", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.whenStatus: unknown status "blocked"/)
	})

	test("rejects duplicate fragment id", () => {
		const root = minimalRoot()
		root.fragments = [
			{ id: "f", role: "x", path: "f1.md" },
			{ id: "f", role: "x", path: "f2.md" },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate id "f"/)
	})

	test("rejects misspelled item field reference (e.g. item.stauts instead of item.status)", () => {
		const root: Record<string, unknown> = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.stauts" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unknown item field "stauts"/)
	})

	test("accepts item.idField reference in variables", () => {
		const root: Record<string, unknown> = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.id" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual(["X", { kind: "item", field: "id" }])
	})

	test("accepts known base item field reference in variables", () => {
		const root: Record<string, unknown> = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.status" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual(["X", { kind: "item", field: "status" }])
	})

	test("accepts declared transparent item fields", () => {
		const root: Record<string, unknown> = {
			...minimalRoot(),
			item: { idField: "id", fields: { branch: "string", pr: { type: "number" } } },
			phases: [{ name: "p", prompt: "p.md", variables: { BRANCH: "item.branch", PR: "item.pr" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(Object.fromEntries(preset.item.fields)).toEqual({ branch: { type: "string" }, pr: { type: "number" } })
		expect(preset.phases[0]!.variables).toEqual([
			["BRANCH", { kind: "item", field: "branch" }],
			["PR", { kind: "item", field: "pr" }],
		])
	})

	test("accepts minimal valid preset and produces normalized shape", () => {
		const preset = parsePreset(minimalRoot(), "/tmp")
		expect(preset.name).toBe("x")
		expect(preset.item.idField).toBe("id")
		expect(Object.fromEntries(preset.item.fields)).toEqual({})
		expect(preset.phases[0]!.variables[0]).toEqual(["K", { kind: "item", field: "id" }])
		expect(preset.fragments[0]!.path).toBe("/tmp/f.md")
		expect(preset.agent.attemptTimeoutSeconds).toBe(DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
	})

	test("accepts agent attemptTimeoutSeconds override", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 120 }
		const preset = parsePreset(root, "/tmp")
		expect(preset.agent.attemptTimeoutSeconds).toBe(120)
	})

	test("rejects non-positive agent attemptTimeoutSeconds", () => {
		const root: Record<string, unknown> = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 0 }
		expect(() => parsePreset(root, "/tmp")).toThrow(/attemptTimeoutSeconds/)
	})
})
