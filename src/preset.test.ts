import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"

import {
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	chainCompleteTriggerPhases,
	lastNonTriggerPhaseForPreset,
	loadPreset,
	parsePreset,
	renderFragmentIndex,
	sliceFragmentsForPhase,
	triggeredPhasesAfter,
	type Preset,
	type PresetPhase,
	type PresetVariableSource,
} from "./loop"
import { parseInternalStatus } from "./runtime-data"
import type { BoundaryRecord } from "./boundary-types"

const REPO_ROOT = resolve(import.meta.dir, "..")
const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

function status(value: string) {
	return parseInternalStatus(value, "test.status")
}

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
	{ id: "quality/evidence-execute", role: "quality", relPath: "quality/evidence-execute.md" },
	{ id: "quality/evidence-judge", role: "quality", relPath: "quality/evidence-judge.md" },
	{ id: "quality/honesty-execute", role: "quality", relPath: "quality/honesty-execute.md" },
	{ id: "quality/honesty-judge", role: "quality", relPath: "quality/honesty-judge.md" },
	{ id: "quality/cleanup-execute", role: "quality", relPath: "quality/cleanup-execute.md" },
	{ id: "quality/cleanup-judge", role: "quality", relPath: "quality/cleanup-judge.md" },
	{ id: "iter/steps/research/task", role: "iter", relPath: "iter/steps/research/task.md" },
	{ id: "iter/steps/research/report", role: "iter", relPath: "iter/steps/research/report.md" },
	{ id: "iter/steps/research/accept", role: "iter", relPath: "iter/steps/research/accept.md" },
	{ id: "iter/steps/resolve-blocker/task", role: "iter", relPath: "iter/steps/resolve-blocker/task.md" },
	{ id: "iter/steps/resolve-blocker/report", role: "iter", relPath: "iter/steps/resolve-blocker/report.md" },
	{ id: "iter/steps/resolve-blocker/accept", role: "iter", relPath: "iter/steps/resolve-blocker/accept.md" },
	{ id: "iter/steps/implement/task", role: "iter", relPath: "iter/steps/implement/task.md" },
	{ id: "iter/steps/implement/report", role: "iter", relPath: "iter/steps/implement/report.md" },
	{ id: "iter/steps/implement/accept", role: "iter", relPath: "iter/steps/implement/accept.md" },
	{ id: "iter/steps/verify/task", role: "iter", relPath: "iter/steps/verify/task.md" },
	{ id: "iter/steps/verify/report", role: "iter", relPath: "iter/steps/verify/report.md" },
	{ id: "iter/steps/verify/accept", role: "iter", relPath: "iter/steps/verify/accept.md" },
	{ id: "iter/steps/e2e/task", role: "iter", relPath: "iter/steps/e2e/task.md" },
	{ id: "iter/steps/e2e/report", role: "iter", relPath: "iter/steps/e2e/report.md" },
	{ id: "iter/steps/e2e/accept", role: "iter", relPath: "iter/steps/e2e/accept.md" },
	{ id: "iter/steps/submit/task", role: "iter", relPath: "iter/steps/submit/task.md" },
	{ id: "iter/steps/submit/report", role: "iter", relPath: "iter/steps/submit/report.md" },
	{ id: "iter/steps/submit/accept", role: "iter", relPath: "iter/steps/submit/accept.md" },
	{ id: "iter/steps/source-spike/task", role: "iter", relPath: "iter/steps/source-spike/task.md" },
	{ id: "iter/steps/source-spike/report", role: "iter", relPath: "iter/steps/source-spike/report.md" },
	{ id: "iter/steps/source-spike/accept", role: "iter", relPath: "iter/steps/source-spike/accept.md" },
	{ id: "iter/steps/spike-comment/task", role: "iter", relPath: "iter/steps/spike-comment/task.md" },
	{ id: "iter/steps/spike-comment/report", role: "iter", relPath: "iter/steps/spike-comment/report.md" },
	{ id: "iter/steps/spike-comment/accept", role: "iter", relPath: "iter/steps/spike-comment/accept.md" },
	{ id: "review/steps/investigate/task", role: "review", relPath: "review/steps/investigate/task.md" },
	{ id: "review/steps/investigate/report", role: "review", relPath: "review/steps/investigate/report.md" },
	{ id: "review/steps/investigate/accept", role: "review", relPath: "review/steps/investigate/accept.md" },
	{ id: "review/steps/replay/task", role: "review", relPath: "review/steps/replay/task.md" },
	{ id: "review/steps/replay/report", role: "review", relPath: "review/steps/replay/report.md" },
	{ id: "review/steps/replay/accept", role: "review", relPath: "review/steps/replay/accept.md" },
	{ id: "review/steps/diff-audit/task", role: "review", relPath: "review/steps/diff-audit/task.md" },
	{ id: "review/steps/diff-audit/report", role: "review", relPath: "review/steps/diff-audit/report.md" },
	{ id: "review/steps/diff-audit/accept", role: "review", relPath: "review/steps/diff-audit/accept.md" },
	{ id: "review/steps/test-integrity/task", role: "review", relPath: "review/steps/test-integrity/task.md" },
	{ id: "review/steps/test-integrity/report", role: "review", relPath: "review/steps/test-integrity/report.md" },
	{ id: "review/steps/test-integrity/accept", role: "review", relPath: "review/steps/test-integrity/accept.md" },
	{ id: "review/steps/e2e-replay/task", role: "review", relPath: "review/steps/e2e-replay/task.md" },
	{ id: "review/steps/e2e-replay/report", role: "review", relPath: "review/steps/e2e-replay/report.md" },
	{ id: "review/steps/e2e-replay/accept", role: "review", relPath: "review/steps/e2e-replay/accept.md" },
	{ id: "review/spike-followup", role: "review", relPath: "review/spike-followup.md" },
	{ id: "review/source-spike-audit", role: "review", relPath: "review/source-spike-audit.md" },
	{ id: "review/actions/accept-pr", role: "review", relPath: "review/actions/accept-pr.md" },
	{ id: "review/actions/accept-no-pr", role: "review", relPath: "review/actions/accept-no-pr.md" },
	{ id: "review/actions/retry", role: "review", relPath: "review/actions/retry.md" },
	{ id: "review/actions/expand-parent", role: "review", relPath: "review/actions/expand-parent.md" },
	{ id: "review/actions/skip", role: "review", relPath: "review/actions/skip.md" },
	{ id: "review/actions/blocked", role: "review", relPath: "review/actions/blocked.md" },
	{ id: "review/actions/stop", role: "review", relPath: "review/actions/stop.md" },
	{ id: "review/actions/state-write", role: "review", relPath: "review/actions/state-write.md" },
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
		expect([...preset.runtime.businessKeys]).toEqual(["issueKind", "issueKindDoc"])
		expect(preset.agent.binary).toBe("claude")
		expect([...preset.agent.extraArgs]).toEqual([])
		expect(preset.agent.attemptTimeoutSeconds).toBe(DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
		expect([...preset.statuses.continuable]).toEqual(["queued", "in_progress", "changes_requested"])
		expect([...preset.statuses.terminal]).toEqual(["blocked", "moot", "done", "exhausted"])
		expect([...preset.statuses.unblockable]).toEqual(["blocked"])
		expect(Object.fromEntries(preset.phases.map((phase) => [phase.name, phase.summaryMarker]))).toEqual({
			iteration: null,
			review: "REVIEW SUMMARY:",
			"blocked-responder": null,
			"umbrella-finalizer": null,
		})
		expect(preset.phases.find((phase) => phase.name === "iteration")?.exits).toEqual([])
		expect(preset.phases.find((phase) => phase.name === "review")?.exits.map((exit) => exit.status)).toEqual(["changes_requested", "blocked", "moot", "done", "exhausted"])
	})

	test("phases include iteration, review, blocked responder, and umbrella finalizer triggers", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.phases.map((p) => p.name)).toEqual(["iteration", "review", "blocked-responder", "umbrella-finalizer"])
		expect(Object.fromEntries(preset.phases.map((phase) => [phase.name, phase.defaultRunner]))).toEqual({
			iteration: "codex",
			review: "codex",
			"blocked-responder": "codex",
			"umbrella-finalizer": "codex",
		})
		expect(Object.fromEntries(preset.phases.map((phase) => [phase.name, phase.defaultModel]))).toEqual({
			iteration: null,
			review: "gpt-5.5",
			"blocked-responder": null,
			"umbrella-finalizer": null,
		})
		expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["blocked-responder"])
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
		const expectedConfig = (field: string): PresetVariableSource => ({ kind: "config", field, fallback: { kind: "none" } })
		const expectedConfigDefault = (field: string, value: boolean): PresetVariableSource => ({ kind: "config", field, fallback: { kind: "value", value } })
		const expectedRuntime = (key: string): PresetVariableSource => ({ kind: "runtime", key })
		expect(iterVars.get("ISSUE")).toEqual(expectedItem("issue"))
		expect(iterVars.get("ISSUE_BRANCH")).toEqual(expectedItem("branch"))
		expect(iterVars.get("ISSUE_PR")).toEqual(expectedItem("pr"))
		expect(iterVars.get("REPO")).toEqual(expectedConfig("repository"))
		expect(iterVars.get("BASE_BRANCH")).toEqual(expectedConfig("baseBranch"))
		expect(iterVars.get("WORKFLOW_FILE")).toEqual(expectedConfig("workflowFile"))
		expect(iterVars.get("REQUIRE_BROWSER_EVIDENCE")).toEqual(expectedConfigDefault("requireBrowserEvidence", false))
		expect(iterVars.get("TARGET_CWD")).toEqual(expectedRuntime("targetCwd"))
		expect(iterVars.get("AGENT_CWD")).toEqual(expectedRuntime("agentCwd"))
		expect(iterVars.get("PROMPT_ROOT")).toEqual(expectedRuntime("presetDir"))
		expect(iterVars.get("PROMPT_FRAGMENT_INDEX")).toEqual(expectedRuntime("fragmentIndex"))
		expect(iterVars.get("ISSUE_KIND")).toEqual({ kind: "runtime", key: "issueKind", ownership: "preset" })
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

	test("planning prompt converges declared kind label metadata", async () => {
		const createIssues = await Bun.file(resolve(BUNDLED_PRESET_DIR, "plan/create-issues.md")).text()
		const contract = await Bun.file(resolve(BUNDLED_PRESET_DIR, "contract.md")).text()
		const devPlan = await Bun.file(resolve(REPO_ROOT, ".claude/commands/dev-plan.md")).text()

		expect(createIssues).toContain("gh label list --repo <owner>/<repo> --search kind: --json name,color,description")
		expect(createIssues).toContain("For each missing declared label, create exactly that label with its declared color and description.")
		expect(createIssues).toContain("For each existing declared label whose color or description differs from the declaration, edit that label")
		expect(createIssues).toContain("For each existing declared label that already matches the declaration, take no action.")
		expect(createIssues).toContain("Do not create, edit, or delete labels that are not declared by this preset.")
		expect(createIssues).toContain('gh label edit kind:code --repo <owner>/<repo> --color 1f883d --description "Issue 的 deliverable 是代码 PR"')
		expect(createIssues).toContain('gh label edit kind:comment --repo <owner>/<repo> --color 0969da --description "Issue 的 deliverable 是 PR comment / review reply"')
		expect(createIssues).toContain('gh label edit kind:code-spike --repo <owner>/<repo> --color fbca04 --description "Issue 的 deliverable 是 source-writing spike evidence；不走 PR merge"')
		expect(createIssues).toContain('gh label edit kind:blocked --repo <owner>/<repo> --color b60205 --description "Issue 的 deliverable 是解除具体阻塞条件并恢复被阻塞 loop"')
		const staleCreateOnlyInstruction = ["For each existing declared label", ["skip", "creation."].join(" ")].join(", ")
		expect(createIssues).not.toContain(staleCreateOnlyInstruction)
		expect(contract).toContain("已存在但 color / description 与声明不一致的 label 更新到声明值")
		expect(devPlan).toContain("updates declared labels whose color or description differs before posting issues")
	})

	test("iteration entry owns the task-list workflow, kind routing, and dispatch protocol", async () => {
		const entry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "iter-entry.md")).text()

		// kind → step sequence table
		expect(entry).toContain("→ implement → verify → e2e → submit |")
		expect(entry).toContain("| `blocked` | resolve-blocker → implement → verify → e2e → submit |")
		expect(entry).toContain("| `code-spike` | [research?] → source-spike |")
		expect(entry).toContain("| `comment` | [research?] → spike-comment |")
		// task-list spine: explicit list, two-state exit, no self-execution, no subagent-file reads
		expect(entry).toContain("The list is the run.")
		expect(entry).toContain("[x] accepted` or `[-] skipped:")
		expect(entry).toContain("Dispatch it; never do it yourself")
		expect(entry).toContain("you may open **only** `accept.md` files")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/iter/steps/implement/")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/iter/steps/e2e/")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md")
		expect(entry).toContain("ITERATION SUMMARY:")
	})

	test("review entry owns the mandatory dispatches, judgments, and action files", async () => {
		const entry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "review-entry.md")).text()

		expect(entry).toContain("You never repair the work under review.")
		expect(entry).toContain("a verdict — including retry — produced without all four accepted reports is an invalid review")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/steps/replay/")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/steps/diff-audit/")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/steps/test-integrity/")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/steps/e2e-replay/")
		expect(entry).toContain("userContentEdits")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/accept-pr.md")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md")
		expect(entry).toContain("REVIEW SUMMARY: verdict=<retry|accepted|skip|blocked|stop>")
		// judge-side quality criteria are the judgment ground truth
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/honesty-judge.md")
		expect(entry).toContain("/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-judge.md")
	})

	test("blocked responder prompt carries the required cross-repo side effects", async () => {
		const prompt = await Bun.file(resolve(BUNDLED_PRESET_DIR, "blocked-responder-entry.md")).text()
		expect(prompt).toContain("gh")
		expect(prompt).toContain("kind:blocked")
		expect(prompt).toContain("Unblocks: {{REPO}}#{{ISSUE}}")
		expect(prompt).toContain("central state DB")
		expect(prompt).toContain("coder-loop daemon start <targetRepoPath>")
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
	// `fragments` is omitted by default so most tests do not have to declare a
	// matching `roles` array on every phase. Tests that exercise fragment-
	// related contracts (duplicate id, fragment path, accepts-minimal) add their
	// own `fragments` + `roles`.
	const minimalRoot = () => ({
		name: "x",
		version: Number("1"),
		item: { idField: "id" },
		statuses: { continuable: ["a"], terminal: ["b"] },
		phases: [
			{ name: "p", prompt: "p.md", variables: { K: "item.id" } },
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
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked", "done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
			expect(triggeredPhasesAfter(preset, "review", status("done"))).toEqual([])
	})

	test("accepts per-phase exit declarations and computes summaryMarker defaults", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued", "in_progress"], terminal: ["done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", runner: "claude", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases.map((phase) => phase.exits.map((exit) => exit.status))).toEqual([[status("in_progress")], [status("done")]])
		expect(preset.phases[1]!.defaultRunner).toBe("claude")
		expect(preset.phases.map((phase) => phase.summaryMarker)).toEqual([null, "REVIEW SUMMARY:"])
	})

	test("accepts manual unblock statuses declared as terminal subset", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["ready"], terminal: ["parked", "finished"], entry: "ready", unblockable: ["parked"] }

		const preset = parsePreset(root, "/tmp")

		expect(preset.statuses.entry).toBe("ready")
		expect([...preset.statuses.unblockable]).toEqual(["parked"])
	})

	test("rejects manual unblock statuses outside terminal set", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["ready"], terminal: ["finished"], entry: "ready", unblockable: ["parked"] }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: "parked" must be one of statuses\.terminal/)
	})

	test("rejects duplicate manual unblock statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["ready"], terminal: ["parked"], entry: "ready", unblockable: ["parked", "parked"] }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: duplicate status "parked"/)
	})

	test("phases without summaryMarker disable the post-summary watchdog", () => {
		const preset = parsePreset(minimalRoot(), "/tmp")

		expect(preset.phases.map((phase) => phase.summaryMarker)).toEqual([null])
	})

	test("rejects per-phase exit declarations outside preset statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "missing", when: "bad" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: unrecognized status "missing"/)
	})

	test("rejects duplicate per-phase exit declarations", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "a", when: "one" }, { status: "a", when: "two" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: duplicate status "a"/)
	})

	test("rejects legacy statusWrites declarations", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", statusWrites: ["a"], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/statusWrites: use \[\[phases\.exits\]\]/)
	})

	test("accepts chain-complete trigger phases", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked", "done"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
			{ name: "finalizer", prompt: "finalizer.md", trigger: { on: "chain-complete" }, variables: { K: "runtime.runId" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(preset.phases[3]!.trigger).toEqual({ on: "chain-complete" })
			expect(lastNonTriggerPhaseForPreset(preset).name).toBe("review")
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
		expect(chainCompleteTriggerPhases(preset).map((phase) => phase.name)).toEqual(["finalizer"])
	})

	test("rejects trigger afterPhase that does not name a declared phase", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued"], terminal: ["blocked"] }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.afterPhase: unrecognized phase "review"/)
	})

	test("rejects trigger whenStatus outside preset statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "iteration", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.whenStatus: unrecognized status "blocked"/)
	})

	test("rejects duplicate fragment id", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			fragments: [
				{ id: "f", role: "x", path: "f1.md" },
				{ id: "f", role: "x", path: "f2.md" },
			],
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate id "f"/)
	})

	test("rejects misspelled item field reference (e.g. item.stauts instead of item.status)", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.stauts" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unrecognized item field "stauts"/)
	})

	test("accepts declared runtime business keys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: { businessKeys: ["customBusiness"] },
			phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.customBusiness" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect([...preset.runtime.businessKeys]).toEqual(["customBusiness"])
		expect(preset.phases[0]!.variables[0]).toEqual(["X", { kind: "runtime", key: "customBusiness", ownership: "preset" }])
	})

	test("rejects undeclared runtime business keys", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.customBusiness" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unrecognized runtime key "customBusiness"/)
	})

	test("rejects runtime business key declarations that collide with engine facts", () => {
		const root: BoundaryRecord = { ...minimalRoot(), runtime: { businessKeys: ["runId"] } }
		expect(() => parsePreset(root, "/tmp")).toThrow(/"runId" is engine-owned/)
	})

	test("accepts item.idField reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.id" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual(["X", { kind: "item", field: "id" }])
	})

	test("accepts known base item field reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.status" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual(["X", { kind: "item", field: "status" }])
	})

	test("accepts declared transparent item fields", () => {
		const root: BoundaryRecord = {
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
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{ name: "p", prompt: "p.md", variables: { K: "item.id" }, roles: ["x"] }],
			fragments: [{ id: "f", role: "x", path: "f.md" }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(preset.name).toBe("x")
		expect(preset.item.idField).toBe("id")
		expect(Object.fromEntries(preset.item.fields)).toEqual({})
		expect(preset.phases[0]!.variables[0]).toEqual(["K", { kind: "item", field: "id" }])
		expect(preset.phases[0]!.roles).toEqual(["x"])
		expect(preset.fragments[0]!.path).toBe("/tmp/f.md")
		expect(preset.agent.attemptTimeoutSeconds).toBe(DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
	})

	test("accepts agent attemptTimeoutSeconds override", () => {
		const root: BoundaryRecord = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 120 }
		const preset = parsePreset(root, "/tmp")
		expect(preset.agent.attemptTimeoutSeconds).toBe(120)
	})

	test("rejects non-positive agent attemptTimeoutSeconds", () => {
		const root: BoundaryRecord = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 0 }
		expect(() => parsePreset(root, "/tmp")).toThrow(/attemptTimeoutSeconds/)
	})
})

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
			version: Number("1"),
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"] },
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
			version: Number("1"),
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"] },
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
			version: Number("1"),
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"] },
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
			version: Number("1"),
			item: { idField: "id" },
			statuses: { continuable: ["a"], terminal: ["b"] },
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
// `presets/gh-issue-pr-iteration/`. References inside the entry use the
// install-time absolute prefix (`/Users/.../presets/gh-issue-pr-iteration/`)
// independent of where the worktree happens to live, so we strip both prefixes
// and the `.md` extension and compare tails.
function extractFragmentTails(markdown: string): ReadonlySet<string> {
	const found = new Set<string>()
	const pattern = /presets\/gh-issue-pr-iteration\/([A-Za-z0-9_./-]+?)(?:\.md|\/)(?=[`)<\s.,;:!]|$)/g
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
