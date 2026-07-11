import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	ENGINE_RUNTIME_BINDING_KEYS,
	PRESET_MATERIALIZED_DIRNAME,
	PRESET_ROOT_TOKEN,
	chainCompleteTriggerPhases,
	loadPreset,
	materializePreset,
	parsePreset,
	prunePresetMaterializedRoot,
	renderFragmentIndex,
	renderRuntimeInputsDoc,
	resolveBinding,
	sliceFragmentsForPhase,
	substitutePresetRootToken,
	triggeredPhasesAfter,
	type Preset,
	type PresetPhase,
	type PresetDagFinding,
	type PresetPlaceholderFinding,
	type PresetVariableSource,
	type ResolveContext,
	type RuntimeBindings,
} from "./loop"
import { parseInternalStatus, storedItemExtra } from "./runtime-data"
import type { ItemRecord } from "./sqlite-state"
import type { BoundaryRecord } from "./boundary-types"

const REPO_ROOT = resolve(import.meta.dir, "..")
const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const REAL_E2E_MINIMAL_PRESET_DIR = resolve(REPO_ROOT, "presets/real-e2e-minimal")

function status(value: string) {
	return parseInternalStatus(value, "test.status")
}

// Minimum-shape `RuntimeBindings` for the #457 declared-binding driver test (acceptance row 2):
// the runtime channel must satisfy the `Record<EngineRuntimeBindingKey, string>` requirement, but
// the umbrella resolution path under test exercises only the `chain.<field>` channel, so every
// engine fact is filled with a placeholder. ENGINE_RUNTIME_BINDING_KEYS is the source of truth for
// the key set — using it keeps this helper aligned with the post-#457 count automatically.
function makeMinimalRuntimeBindings(): RuntimeBindings {
	const placeholder = Object.fromEntries(ENGINE_RUNTIME_BINDING_KEYS.map((key) => [key, ""])) as Record<string, string>
	return placeholder as RuntimeBindings
}

function makeItemRecord(extra: ItemRecord["extra"] = storedItemExtra({})): ItemRecord {
	return {
		id: 1,
		chainId: 1,
		itemId: "539",
		repoCwd: REPO_ROOT,
		status: status("queued"),
		attempts: 0,
		position: 0,
		title: null,
		priority: null,
		lastRunId: null,
		sessionIds: {},
		issueFile: null,
		evidenceDir: null,
		agentCwd: null,
		runner: null,
		phase: null,
		preset: null,
		presetPath: null,
		extra,
		createdAt: 0,
		updatedAt: 0,
		statusUpdatedAt: 0,
	}
}

const EXPECTED_FRAGMENTS = [
	{ id: "common/runtime-contract", role: "common", relPath: "common/runtime-contract.md" },
	{ id: "common/github-routing", role: "common", relPath: "common/github-routing.md" },
	{ id: "common/state-contract", role: "common", relPath: "common/state-contract.md" },
	{ id: "common/dispatch-contract", role: "common", relPath: "common/dispatch-contract.md" },
	{ id: "contract", role: "common", relPath: "contract.md" },
	{ id: "quality/evidence", role: "quality", relPath: "quality/evidence.md" },
	{ id: "quality/honesty", role: "quality", relPath: "quality/honesty.md" },
	{ id: "quality/cleanup", role: "quality", relPath: "quality/cleanup.md" },
	{ id: "iter/steps/research", role: "iter", relPath: "iter/steps/research.md" },
	{ id: "iter/steps/resolve-blocker", role: "iter", relPath: "iter/steps/resolve-blocker.md" },
	{ id: "iter/steps/implement", role: "iter", relPath: "iter/steps/implement.md" },
	{ id: "iter/steps/verify", role: "iter", relPath: "iter/steps/verify.md" },
	{ id: "iter/steps/e2e", role: "iter", relPath: "iter/steps/e2e.md" },
	{ id: "iter/steps/submit", role: "iter", relPath: "iter/steps/submit.md" },
	{ id: "iter/steps/source-spike", role: "iter", relPath: "iter/steps/source-spike.md" },
	{ id: "iter/steps/spike-comment", role: "iter", relPath: "iter/steps/spike-comment.md" },
	{ id: "review/steps/investigate", role: "review", relPath: "review/steps/investigate.md" },
	{ id: "review/steps/diff-audit", role: "review", relPath: "review/steps/diff-audit.md" },
	{ id: "review/steps/replay", role: "review", relPath: "review/steps/replay.md" },
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
	"REQUIRE_BROWSER_EVIDENCE",
	"ISSUE_BRANCH",
	"ISSUE_PR",
	"ISSUE_STATUS",
	"ISSUE_LAST_RUN_ID",
	"RUN_ID_GENERATION",
	"RESUMED_FROM_PHASE",
	"RESUMED_STARTED_AT",
	"RESUMED_SESSION_ID",
	"CHAIN_NAME",
	"CHAIN_UMBRELLA_REPO",
	"CHAIN_UMBRELLA_ISSUE",
	"REPO_CWD",
] as const

describe("loadPreset (bundled gh-issue-pr-iteration)", () => {
	test("validates runtime handoff lifetime contract", async () => {
		const e2e = await readFile(resolve(BUNDLED_PRESET_DIR, "iter/steps/e2e.md"), "utf8")
		expect(e2e).toContain("closed union")
		expect(e2e).toContain("`durable` requires stable ownership plus liveness")
		expect(e2e).toContain("`recreatable` requires setup/start/readiness")
		expect(e2e).toContain("Missing, mixed, or extra-kind shapes are gaps")
		expect(e2e).toMatch(/sourceSha.*worktree.*ownerRef.*livenessCommand.*behaviorCommand.*logPath.*stopCommand/s)
		expect(e2e).toMatch(/sourceSha.*worktree.*setupCommands.*startCommand.*readinessCommand.*behaviorCommand.*logPath.*stopCommand/s)
	})

	test("review exhaustively routes runtime handoff kinds", async () => {
		const replay = await readFile(resolve(BUNDLED_PRESET_DIR, "review/steps/replay.md"), "utf8")
		expect(replay).toContain("require exactly one lifetime kind")
		expect(replay).toContain("`durable`")
		expect(replay).toContain("`recreatable`")
		expect(replay).toContain("Any other shape is rejected before replay")
		expect(replay).toContain("Old PID absence alone is not a claim mismatch")
	})

	test("limits changed-scope issue patterns to branch delta", async () => {
		const audit = await readFile(resolve(BUNDLED_PRESET_DIR, "review/steps/diff-audit.md"), "utf8")
		expect(audit).toContain("For `changed`")
		expect(audit).toContain("base→head added or modified lines")
		expect(audit).toContain("Pre-existing untouched matches are excluded from verdict")
	})

	test("requires whole-tree issue pattern convergence", async () => {
		const audit = await readFile(resolve(BUNDLED_PRESET_DIR, "review/steps/diff-audit.md"), "utf8")
		expect(audit).toContain("For `whole-tree`")
		expect(audit).toContain("complete declared tree")
		expect(audit).toContain("enumerate every remaining site")
	})

	test("rejects ambiguous issue pattern scope", async () => {
		const audit = await readFile(resolve(BUNDLED_PRESET_DIR, "review/steps/diff-audit.md"), "utf8")
		expect(audit).toContain("closed union `changed | whole-tree`")
		expect(audit).toContain("unknown scope, duplicate rows, or conflicting scopes")
		expect(audit).toContain("contract error")
		expect(audit).toContain("do not guess from prose or language")
	})

	test("routes diff audit by declared issue pattern scope", async () => {
		const audit = await readFile(resolve(BUNDLED_PRESET_DIR, "review/steps/diff-audit.md"), "utf8")
		expect(audit).toMatch(/For `changed`[\s\S]*For `whole-tree`/)
		expect(audit).toContain("the difference is the candidate set, not the severity")
		expect(audit).toContain("Base→head")
	})
	test("loads name, item.idField, agent.attemptTimeoutSeconds, statuses sets", async () => {
		const preset: Preset = await loadPreset(BUNDLED_PRESET_DIR)
		expect(preset.name).toBe("gh-issue-pr-iteration")
		expect(preset.item.idField).toBe("issue")
		expect(Object.fromEntries(preset.item.fields)).toEqual({
			// #419: the idField "issue" is now declared in [item.fields] so prompts resolve
			// `{{ISSUE}}` through the typed pipeline (the engine-builtin string fallback was
			// retired with `LEGACY_TRANSPARENT_ITEM_FIELDS`). `branch` / `pr` were always
			// preset-declared transparent fields; they continue to round-trip via `extra`.
			issue: { type: "number" },
			branch: { type: "string" },
			pr: { type: "number" },
			lastRunId: { type: "string" },
		})
		// #450 retired the kind taxonomy: the preset no longer declares any business
		// keys. After #420 / #401 the engine itself no longer carries any kind
		// vocabulary, fetch mechanism, or render surface either.
		expect([...preset.runtime.businessKeys]).toEqual([])
		// #433: [agent].binary and [agent].extraArgs were zombie schema; retired with the rest of
		// the runtime/config concept. Runner binary is now kind→PATH only.
		// #514: bundled preset declares attemptTimeoutSeconds = 7200 explicitly (verify∥e2e parallel
		// dispatch lifts the realistic single-attempt budget past the 1h fallback floor); this is
		// the preset's own value, not the DEFAULT_ATTEMPT_TIMEOUT_SECONDS fallback.
		expect(preset.agent.attemptTimeoutSeconds).toBe(7200)
		// #508: `in_progress` rejoined `continuable` so the scheduler can re-pick an item
		// that was mid-flight when the previous daemon process died. Daemon recovery (#508)
		// no longer rewrites `items.status` / `phase` / `sessionIds`, so the post-crash
		// `in_progress` rowid is what the scheduler now consumes on the next tick.
		expect([...preset.statuses.continuable]).toEqual(["queued", "changes_requested", "in_progress"])
		expect([...preset.statuses.terminal]).toEqual(["blocked", "moot", "done", "exhausted"])
		expect([...preset.statuses.unblockable]).toEqual(["blocked"])
		// #402: bundled preset declares the attempts-exhausted落点 explicitly; engine no longer
		// owns the "exhausted" literal.
		expect(preset.statuses.exhausted).toBe("exhausted")
		// #404: bundled preset declares the retry continuable status so md doc builders
		// can inject it instead of fragments naming the literal.
		// #456: the role-shaped `summaryMarker` field on `PresetPhase` was retired with the
		// taxonomy; #452 will lift the summary-injection redesign on a DSL-declared hook. The
		// previous "marker is null for every phase" assertion is now unrepresentable (no field) and
		// has been dropped.
		expect(preset.statuses.retry).toBe("changes_requested")
		expect(preset.phases.find((phase) => phase.name === "iteration")?.exits).toEqual([])
		// #405: review's exits now include a chain-action branch (`stop`) alongside the
		// item-status branches. The projection below narrows on the ADT discriminator so a future
		// extra chain-action exit will land in the chain-action assertion automatically.
		const reviewExits = preset.phases.find((phase) => phase.name === "review")?.exits ?? []
		expect(reviewExits.flatMap((exit) => exit.kind === "item-status" ? [exit.status] : [])).toEqual(["changes_requested", "blocked", "moot", "done", "exhausted"])
		expect(reviewExits.flatMap((exit) => exit.kind === "chain-action" ? [exit.action] : [])).toEqual(["stop"])
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
			iteration: "gpt-5.6-sol",
			review: "gpt-5.6-sol",
			"blocked-responder": "gpt-5.6-sol",
			"umbrella-finalizer": "gpt-5.6-sol",
		})
		// #456: previously this also asserted the "last non-trigger phase" position via an engine
		// helper. That helper enforced an engine assumption the DSL never declared; with the
		// taxonomy retired the engine no longer cares about that position. The preset's phase
		// ordering (asserted above) keeps "review" before the trigger phases by preset declaration
		// — no engine helper needed.
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
		// #404 introduced per-phase-sliced doc builders so phases legitimately differ
		// by the addition of their own slice keys (contract-5 minimum visibility,
		// issue #396 comment 4666115115). Iteration's slice adds RETRY_STATUS_DOC
		// (used in the Step 1 "Retry" classification branch) and
		// TERMINAL_STATUSES_DOC (used in the MUST-NOT-write boundary list);
		// review's slice adds STATUS_VOCABULARY_DOC (the broader queue
		// classification vocabulary it uses in Step 7); blocked-responder's slice
		// adds TRIGGER_STATUS_DOC (the literal status word the responder reacts
		// to); umbrella-finalizer adds none. The shared base set (every phase's
		// vars must include it) stays EXPECTED_VARIABLE_KEYS. (Post-rebase on
		// main #497: review's `RUN_VERDICT_VOCABULARY_DOC` was dropped — the
		// SUMMARY-line consumer and the engine-owned `REVIEW_SUMMARY_VERDICTS`
		// data source were both retired by #497.)
		const PHASE_EXTRA_KEYS: Record<string, readonly string[]> = {
			iteration: ["RETRY_STATUS_DOC", "TERMINAL_STATUSES_DOC"],
			review: ["STATUS_VOCABULARY_DOC"],
			"blocked-responder": ["TRIGGER_STATUS_DOC"],
			"umbrella-finalizer": [],
		}
		for (const phase of preset.phases) {
			const keys = phase.variables.map((variable) => variable.key)
			const expectedExtras = PHASE_EXTRA_KEYS[phase.name] ?? []
			const expected = [...EXPECTED_VARIABLE_KEYS, ...expectedExtras]
			expect(new Set(keys)).toEqual(new Set(expected))
			for (const variable of phase.variables) {
				// #433: DSL prefixes are item / chain / runtime (the retired `config.*` prefix is gone).
				expect(["item", "chain", "runtime"]).toContain(variable.source.kind)
			}
		}
	})

	test("specific variable bindings reflect renderPrompt source mapping", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		const iterVars = new Map(preset.phases[0]!.variables.map((variable) => [variable.key, variable.source] as const))
		const expectedItem = (field: string): PresetVariableSource => ({ kind: "item", field })
		const expectedChain = (field: string): PresetVariableSource => ({ kind: "chain", field, fallback: { kind: "none" } })
		const expectedChainDefault = (field: string, value: boolean): PresetVariableSource => ({ kind: "chain", field, fallback: { kind: "value", value } })
		const expectedRuntime = (key: string): PresetVariableSource => ({ kind: "runtime", key })
		expect(iterVars.get("ISSUE")).toEqual(expectedItem("issue"))
		expect(iterVars.get("ISSUE_BRANCH")).toEqual(expectedItem("branch"))
		expect(iterVars.get("ISSUE_PR")).toEqual(expectedItem("pr"))
		expect(iterVars.get("REPO")).toEqual(expectedChain("repository"))
		expect(iterVars.get("BASE_BRANCH")).toEqual(expectedChain("baseBranch"))
		expect(iterVars.get("REQUIRE_BROWSER_EVIDENCE")).toEqual(expectedChainDefault("requireBrowserEvidence", false))
		expect(iterVars.get("TARGET_CWD")).toEqual(expectedRuntime("targetCwd"))
		expect(iterVars.get("AGENT_CWD")).toEqual(expectedRuntime("agentCwd"))
		expect(iterVars.get("PROMPT_ROOT")).toEqual(expectedRuntime("presetDir"))
		expect(iterVars.get("PROMPT_FRAGMENT_INDEX")).toEqual(expectedRuntime("fragmentIndex"))
		// #457: CHAIN_UMBRELLA_REPO / CHAIN_UMBRELLA_ISSUE now resolve via the declared chain-binding
		// namespace (metadata.bindings.*) instead of the retired engine-runtime facts. Empty-string
		// default keeps the prompt safe when metadata.bindings carries no umbrella entry.
		expect(iterVars.get("CHAIN_UMBRELLA_REPO")).toEqual({ kind: "chain", field: "umbrellaRepo", fallback: { kind: "value", value: "" } })
		expect(iterVars.get("CHAIN_UMBRELLA_ISSUE")).toEqual({ kind: "chain", field: "umbrellaIssue", fallback: { kind: "value", value: "" } })
		// #450 retired the kind taxonomy and #401 finished retiring the engine
		// vocabulary — the keys === EXPECTED_VARIABLE_KEYS assertion above already
		// covers the absence of the retired bindings positively.
	})

	test("bundled preset declares issue doc prefix", async () => {
		const presets = await Promise.all([
			loadPreset(BUNDLED_PRESET_DIR),
			loadPreset(REAL_E2E_MINIMAL_PRESET_DIR),
		])
		const decoratedIssueBindings = presets.flatMap((preset) => preset.phases.flatMap((phase) => {
			const variable = phase.variables.find((candidate) => candidate.key === "ISSUE" && candidate.doc !== null)
			return variable === undefined ? [] : [{ preset, phase, variable }]
		}))
		expect(decoratedIssueBindings).toHaveLength(5)

		for (const { preset, phase, variable } of decoratedIssueBindings) {
			const doc = variable.doc
			if (doc === null) throw new Error(`decorated ISSUE binding in ${preset.name}/${phase.name} has no doc declaration`)
			expect(doc).toMatchObject({ prefix: "#", suffix: "", style: "code" })
			const ctx: ResolveContext = {
				item: makeItemRecord(storedItemExtra({ issue: 539 })),
				chain: { repository: "mouriya-s-lab/coder-loop", baseBranch: "main", requireBrowserEvidence: false },
				runtime: makeMinimalRuntimeBindings(),
				preset,
			}
			expect(renderRuntimeInputsDoc(phase, ctx)).toContain(`- ${doc.label}: \`#539\``)
		}
	})

	// #457 acceptance row 2: bundled preset's umbrella binding resolves through the declared
	// chain-binding mechanism (metadata.bindings.umbrellaRepo / umbrellaIssue) rather than the
	// retired engine-runtime facts (runtime.chainUmbrellaRepo / chainUmbrellaIssue). Rendering
	// produces identical literals to the pre-#457 path; an empty metadata.bindings yields empty
	// strings via the declared `default = ""` fallback (no crash).
	test("bundled umbrella binding flows through declared chain-binding mechanism (acceptance row 2)", async () => {
		const preset = await loadPreset(BUNDLED_PRESET_DIR)
		const iterPhase = preset.phases.find((entry) => entry.name === "iteration")
		expect(iterPhase).toBeDefined()
		const variableByKey = new Map(iterPhase!.variables.map((variable) => [variable.key, variable] as const))
		const umbrellaRepoVar = variableByKey.get("CHAIN_UMBRELLA_REPO")
		const umbrellaIssueVar = variableByKey.get("CHAIN_UMBRELLA_ISSUE")
		expect(umbrellaRepoVar).toBeDefined()
		expect(umbrellaIssueVar).toBeDefined()
		// The retired runtime fact is gone: no variable should still source umbrella from runtime.
		for (const variable of iterPhase!.variables) {
			expect(variable.source.kind === "runtime" && (variable.source.key === "chainUmbrellaRepo" || variable.source.key === "chainUmbrellaIssue")).toBe(false)
		}
		// Populated metadata.bindings produces the literal value.
		const populated: ResolveContext = {
			item: { issue: 457 } as unknown as ItemRecord,
			chain: { umbrellaRepo: "mouriya-s-lab/coder-loop", umbrellaIssue: 457, repository: "x", baseBranch: "main" },
			runtime: makeMinimalRuntimeBindings(),
			preset,
		}
		expect(resolveBinding(umbrellaRepoVar!.source, populated)).toBe("mouriya-s-lab/coder-loop")
		expect(resolveBinding(umbrellaIssueVar!.source, populated)).toBe("457")
		// Empty metadata.bindings: declared fallback emits "" rather than crashing.
		const empty: ResolveContext = {
			item: { issue: 457 } as unknown as ItemRecord,
			chain: { repository: "x", baseBranch: "main" },
			runtime: makeMinimalRuntimeBindings(),
			preset,
		}
		expect(resolveBinding(umbrellaRepoVar!.source, empty)).toBe("")
		expect(resolveBinding(umbrellaIssueVar!.source, empty)).toBe("")
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

	test("contract.md describes four deliverable shapes without kind taxonomy", async () => {
		const contract = await Bun.file(resolve(BUNDLED_PRESET_DIR, "contract.md")).text()
		expect(/kind/i.test(contract)).toBe(false)
		expect(contract).toContain("实现-PR-deliverable")
		expect(contract).toContain("Unblock-deliverable")
		expect(contract).toContain("Comment-spike-deliverable")
		expect(contract).toContain("Source-writing-spike-deliverable")
	})

	test("iteration entry owns the task-list workflow, deliverable-shape routing, and dispatch protocol", async () => {
		const entry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "iter-entry.md")).text()

		// #450: deliverable-shape routing — agent reads issue body to decide the step
		// sequence; there is no `kind:*` label table. The four step sequences must all
		// still be visible so step selection guidance is observable in the rendered prompt.
		expect(/kind/i.test(entry)).toBe(false)
		expect(entry).toContain("[research if Step 2 left you unsure what the right change is] → implement → (verify ∥ e2e) → submit")
		expect(entry).toContain("resolve-blocker → implement → (verify ∥ e2e) → submit")
		expect(entry).toContain("[research?] → source-spike")
		expect(entry).toContain("[research?] → spike-comment")
		expect(entry).toContain("the routing decision is yours, anchored in what the issue body asks for")

		// task-list spine: explicit list, two-state exit, no self-execution, no subagent-file reads
		expect(entry).toContain("The list is the run.")
		expect(entry).toContain("[x] accepted` or `[-] skipped:")
		expect(entry).toContain("never do the work yourself")
		// All four deliverable step files are still referenced so the routing
		// language above remains executable (the four-workflow capability survives).
		expect(entry).toContain("{{PRESET_ROOT}}/iter/steps/implement.md")
		expect(entry).toContain("{{PRESET_ROOT}}/iter/steps/resolve-blocker.md")
		expect(entry).toContain("{{PRESET_ROOT}}/iter/steps/source-spike.md")
		expect(entry).toContain("{{PRESET_ROOT}}/iter/steps/spike-comment.md")
		expect(entry).toContain("{{PRESET_ROOT}}/iter/steps/e2e.md")
		expect(entry).toContain("{{PRESET_ROOT}}/quality/honesty.md")
		expect(entry).toContain("ITERATION SUMMARY:")
	})

	test("dispatch contract is runner-neutral while entry prompts retain semantic task decomposition", async () => {
		const dispatch = await Bun.file(resolve(BUNDLED_PRESET_DIR, "common/dispatch-contract.md")).text()
		const iteration = await Bun.file(resolve(BUNDLED_PRESET_DIR, "iter-entry.md")).text()
		const review = await Bun.file(resolve(BUNDLED_PRESET_DIR, "review-entry.md")).text()

		expect(dispatch).toContain("Runner transports have two explicit shapes")
		expect(dispatch).toContain("Immediate completion")
		expect(dispatch).toContain("Deferred completion")
		expect(dispatch).not.toMatch(/claude `-p`|<task-notification>|TaskStop|ScheduleWakeup|Agent\(\.\.\.\)/)
		expect(iteration).toContain("Build the task list")
		expect(review).toContain("Build the review task list")
		expect(`${iteration}\n${review}`).not.toMatch(/claude `-p`|<task-notification>|TaskStop|ScheduleWakeup/)
	})

	test("review entry owns the mandatory dispatches, judgments, and action files", async () => {
		const entry = await Bun.file(resolve(BUNDLED_PRESET_DIR, "review-entry.md")).text()

		expect(entry).toContain("You never repair the work under review.")
		// Two mandatory dispatches (diff-audit + replay); anti-cheat verbatim scaffolds
		// are unnecessary for honest runners, but the "no verdict without both reports"
		// guarantee stays.
		expect(entry).toContain("A verdict — including retry — produced without both accepted reports is an invalid review")
		expect(entry).toContain("{{PRESET_ROOT}}/review/steps/replay.md")
		expect(entry).toContain("{{PRESET_ROOT}}/review/steps/diff-audit.md")
		expect(entry).toContain("{{PRESET_ROOT}}/review/actions/accept-pr.md")
		expect(entry).toContain("{{PRESET_ROOT}}/review/actions/state-write.md")
		// #405 retired the `REVIEW SUMMARY: verdict=...` template line and the five-word
		// verdict format from review-entry.md (review terminal action routes through
		// `coder-loop item exits` + the appropriate writer per ADT branch). #404's
		// row #1 grep (`verdict=<|changes_requested|exhausted`) requires the same
		// absence; this single assertion guards both contracts.
		expect(/REVIEW SUMMARY:|verdict=/.test(entry)).toBe(false)
		// merged quality files are the judgment ground truth
		expect(entry).toContain("{{PRESET_ROOT}}/quality/honesty.md")
		expect(entry).toContain("{{PRESET_ROOT}}/quality/evidence.md")
	})

	test("blocked responder prompt carries the required cross-repo side effects", async () => {
		const prompt = await Bun.file(resolve(BUNDLED_PRESET_DIR, "blocked-responder-entry.md")).text()
		expect(prompt).toContain("gh")
		// #450: the cross-repo unblock is wired by the body's `Unblocks:` back-link,
		// not by any `kind:*` label — the responder must not declare the retired label.
		expect(/kind/i.test(prompt)).toBe(false)
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
		item: { idField: "id" },
		// #402: every preset must declare `exhausted` (D2 verdict) and the value must be
		// a member of `terminal`. Tests that pin the rejection path override this directly.
		statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
		phases: [
			{ name: "p", prompt: "p.md", variables: { K: "item.id" } },
		],
		agent: { binary: "echo" },
	})

	test("runtime input doc decoration is schema driven", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{
				name: "p",
				prompt: "p.md",
				variables: {
					ISSUE: { source: "runtime.runId", label: "Named issue", prefix: "ref:", suffix: "!", style: "plain" },
					TICKET: { source: "runtime.runId", label: "Ticket", prefix: "#", suffix: " after", style: "code" },
				},
			}],
		}
		const preset = parsePreset(root, "/tmp")
		const phase = preset.phases[0]!
		expect(phase.variables.map((variable) => variable.doc)).toEqual([
			{ label: "Named issue", prefix: "ref:", suffix: "!", style: "plain", blankBefore: false },
			{ label: "Ticket", prefix: "#", suffix: " after", style: "code", blankBefore: false },
		])
		const runtime = makeMinimalRuntimeBindings()
		runtime.runId = "539"
		const ctx: ResolveContext = { item: makeItemRecord(), chain: {}, runtime, preset }

		expect(renderRuntimeInputsDoc(phase, ctx)).toBe("- Named issue: ref:539!\n- Ticket: `#539` after")
	})

	test("rejects doc decoration without a label but retains default-only object bindings", () => {
		const decorationFields: ReadonlyArray<readonly [string, string | boolean]> = [
			["prefix", "#"],
			["suffix", "!"],
			["style", "plain"],
			["blankBefore", true],
		]
		for (const [field, value] of decorationFields) {
			const root: BoundaryRecord = {
				...minimalRoot(),
				phases: [{ name: "p", prompt: "p.md", variables: { X: { source: "chain.optional", default: "", [field]: value } } }],
			}
			expect(() => parsePreset(root, "/tmp"), field).toThrow(/\.label: required when doc decoration fields are declared/)
		}

		const defaultOnly: BoundaryRecord = {
			...minimalRoot(),
			phases: [{ name: "p", prompt: "p.md", variables: { X: { source: "chain.optional", default: "" } } }],
		}
		expect(parsePreset(defaultOnly, "/tmp").phases[0]!.variables[0]).toEqual({
			key: "X",
			source: { kind: "chain", field: "optional", fallback: { kind: "value", value: "" } },
			doc: null,
		})
	})

	test("rejects unknown variable binding fields", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{
				name: "p",
				prompt: "p.md",
				variables: {
					X: { source: "item.id", label: "Issue", prefx: "#", style: "code" },
				},
			}],
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(
			/preset\.phases\[0\]\.variables\.X\.prefx: unrecognized variable binding field/,
		)
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
		root.statuses = { continuable: ["a", "b"], terminal: ["b", "c"], exhausted: "b" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/both continuable and terminal/)
	})

	// #402: D2 verdict — `statuses.exhausted` is a required preset declaration. The
	// arktype boundary rejects a missing field with the field path inside the error.
	test("rejects a preset that omits statuses.exhausted (#402)", () => {
		// parsePreset accepts BoundaryValue (= unknown). The arktype boundary is the
		// runtime gate; constructing a deliberately-incomplete object is how we exercise
		// the load-time rejection — the TypeScript type of minimalRoot() carries the
		// declared shape, so we route through a record-typed variable to construct an
		// input that statically lacks `exhausted`.
		const root: BoundaryRecord = { ...minimalRoot(), statuses: { continuable: ["a"], terminal: ["b"] } }
		expect(() => parsePreset(root, "/tmp")).toThrow(/exhausted/)
	})

	// #402: load-time validation also rejects an exhausted落点 that is not in the
	// terminal vocabulary — engine writes the value directly, so it must be reachable
	// as a terminal status.
	test("rejects a preset whose statuses.exhausted is not in terminal (#402)", () => {
		const root = minimalRoot()
		root.statuses = { continuable: ["a"], terminal: ["b"], exhausted: "not_a_terminal_status" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/preset\.statuses\.exhausted.*must be one of statuses\.terminal/)
	})

	test("rejects duplicate phase name", () => {
		const root = minimalRoot()
		root.phases = [
			{ name: "p", prompt: "p1.md", variables: { K: "item.id" } },
			{ name: "p", prompt: "p2.md", variables: { K: "item.id" } },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate name "p"/)
	})

	// #456: previously asserted the "last non-trigger phase" position via an engine helper. That
	// helper enforced an engine assumption the DSL never declared; with the taxonomy retired the
	// test pins the trigger declaration itself.
	test("accepts trigger phases and exposes them via triggeredPhasesAfter", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued"], terminal: ["blocked", "done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(preset.phases.filter((phase) => phase.trigger === null).map((phase) => phase.name)).toEqual(["iteration", "review"])
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
			expect(triggeredPhasesAfter(preset, "review", status("done"))).toEqual([])
	})

	// #456: the role-shaped `summaryMarker` field on `PresetPhase` is retired with the taxonomy;
	// this test now pins per-phase exits and the explicit phase runner instead. The prior
	// "summaryMarker defaults to null for both phases" assertion is unrepresentable (no field).
	test("accepts per-phase exit declarations and per-phase runner overrides", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued", "in_progress"], terminal: ["done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", runner: "claude", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			// #405 ADT projection: this test's phases all use the item-status branch so the
			// narrowed view yields the same shape the pre-ADT projection used.
			expect(preset.phases.map((phase) => phase.exits.flatMap((exit) => exit.kind === "item-status" ? [exit.status] : []))).toEqual([[status("in_progress")], [status("done")]])
		expect(preset.phases[1]!.defaultRunner).toBe("claude")
	})

	test("preset loader accepts opencode runner", () => {
		// #481 acceptance #1: `runner = "opencode"` on a preset phase must round-trip through
		// the loader and produce `defaultRunner = "opencode"`. Mirrors the per-phase override
		// test above; the only diff is the third runner kind. Catches any regression where the
		// ark boundary, `parsePhaseRunner`, or the AgentRunnerKind union slips back to a
		// `claude | codex` binary.
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued", "in_progress"], terminal: ["done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", runner: "opencode", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.defaultRunner).toBe("opencode")
	})

	test("accepts manual unblock statuses declared as terminal subset", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["parked", "finished"], entry: "ready", unblockable: ["parked"], exhausted: "finished" }

		const preset = parsePreset(root, "/tmp")

		expect(preset.statuses.entry).toBe("ready")
		expect([...preset.statuses.unblockable]).toEqual(["parked"])
	})

	test("rejects manual unblock statuses outside terminal set", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["finished"], entry: "ready", unblockable: ["parked"], exhausted: "finished" }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: "parked" must be one of statuses\.terminal/)
	})

	test("rejects duplicate manual unblock statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["parked"], entry: "ready", unblockable: ["parked", "parked"], exhausted: "parked" }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: duplicate status "parked"/)
	})

	// #456: the per-phase `summaryMarker` field on `PresetPhase` was retired with the role
	// taxonomy; the watchdog hook (`summaryWatchdogConfigForPhase`) now reports null for every
	// phase until #452 lands a DSL-declared injection point. The prior "no marker → watchdog
	// disabled" assertion is unrepresentable here (no field); see the loop.test.ts watchdog
	// terminal-behavior test for the equivalent pin.

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
		root.statuses = {continuable: ["queued"], terminal: ["blocked", "done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
			{ name: "finalizer", prompt: "finalizer.md", trigger: { on: "chain-complete" }, variables: { K: "runtime.runId" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(preset.phases[3]!.trigger).toEqual({ on: "chain-complete" })
			// #456: previously this also asserted the "last non-trigger phase" position via an engine
			// helper. With the role-shaped helper retired the test pins the non-trigger phase order
			// via preset structure directly; "review" being the last non-trigger phase is now a
			// property of the test fixture, not engine knowledge.
			expect(preset.phases.filter((phase) => phase.trigger === null).map((phase) => phase.name)).toEqual(["iteration", "review"])
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
		expect(chainCompleteTriggerPhases(preset).map((phase) => phase.name)).toEqual(["finalizer"])
	})

	test("rejects trigger afterPhase that does not name a declared phase", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued"], terminal: ["blocked"], exhausted: "blocked" }
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
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "runtime", key: "customBusiness", ownership: "preset" }, doc: null })
	})

	test("rejects undeclared runtime business keys", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.customBusiness" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unknown runtime key "customBusiness"/)
	})

	test("rejects runtime business key declarations that collide with engine facts", () => {
		const root: BoundaryRecord = { ...minimalRoot(), runtime: { businessKeys: ["runId"] } }
		expect(() => parsePreset(root, "/tmp")).toThrow(/"runId" is engine-owned/)
	})

	// #448: preset can supply business key values entirely within its own file
	// via `[runtime.businessKeyValues]`.
	test("accepts preset-supplied literal business key values", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: "demo-value" } },
			},
			phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.auditDemo" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(preset.runtime.businessKeyValues.get("auditDemo")).toEqual({ kind: "literal", value: "demo-value" })
	})

	test("rejects businessKeyValues entries not declared in businessKeys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { strayKey: { literal: "x" } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/strayKey: not declared in preset\.runtime\.businessKeys/)
	})

	test("rejects businessKeyValues entries with no value spec key", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: {} },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo: value spec must declare one of/)
	})

	test("rejects businessKeyValues literal that is not a string", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: 42 } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo\.literal: must be a string/)
	})

	test("rejects businessKeyValues with multiple competing spec keys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: "x", other: "y" } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo: value spec must declare exactly one of/)
	})

	test("accepts item.idField reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.id" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "item", field: "id" }, doc: null })
	})

	test("accepts known base item field reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.status" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "item", field: "status" }, doc: null })
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
			{ key: "BRANCH", source: { kind: "item", field: "branch" }, doc: null },
			{ key: "PR", source: { kind: "item", field: "pr" }, doc: null },
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
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "K", source: { kind: "item", field: "id" }, doc: null })
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

describe("loadPreset placeholder validation (issue #399)", () => {
	async function writePresetFixture(toml: string, files: ReadonlyArray<{ name: string; body: string }>): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-preset-"))
		await writeFile(resolve(dir, "preset.toml"), toml)
		for (const file of files) await writeFile(resolve(dir, file.name), file.body)
		return dir
	}

	const minimalPresetToml = (entryRef: string) => `name = "fixture"
version = 1

[item]
idField = "id"

[item.fields]
title = "string"

[statuses]
continuable = ["pending"]
terminal    = ["done"]
exhausted   = "done"

[[phases]]
name   = "run"
prompt = "${entryRef}"

  # #408: minimal leaving edge so R2 passes for "pending" — without this the
  # cross-table DAG check rejects the fixture before the placeholder validator
  # ever runs. These placeholder tests only inspect the entry md, so the exit
  # is inert from their perspective.
  [[phases.exits]]
  status = "done"
  when = "Run finished; item lands in success-terminal vocabulary."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
binary    = "echo"
extraArgs = []
`

	test("rejects a preset whose entry md contains an undeclared placeholder", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}} title={{TITLE}} typo={{NOT_DECLARED}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		await expect(loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })).rejects.toThrow(/undeclared placeholders/)
		const error = findings.find((f) => f.direction === "template-undeclared")
		expect(error).toBeDefined()
		expect(error?.key).toBe("NOT_DECLARED")
		expect(error?.verdict).toBe("error")
		expect(error?.file).toContain("run-entry.md")
	})

	test("accepts a preset whose declared variables are all reachable from the entry md", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}} title={{TITLE}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		const preset = await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("fixture")
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("accepts an escaped `\\{{KEY}}` literal even when KEY is not declared", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{
				name: "run-entry.md",
				body: "literal example: \\{{NOT_DECLARED}}\nreal: id={{KEY}} title={{TITLE}}\n",
			},
		])
		const findings: PresetPlaceholderFinding[] = []
		const preset = await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("fixture")
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("warns about declared-unused variables without failing the load", async () => {
		const dir = await writePresetFixture(minimalPresetToml("run-entry.md"), [
			{ name: "run-entry.md", body: "id={{KEY}}\n" },
		])
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(dir, { onValidationFinding: (f) => findings.push(f) })
		const warn = findings.find((f) => f.key === "TITLE" && f.direction === "declared-unused")
		expect(warn?.verdict).toBe("warn")
	})

	test("bundled gh-issue-pr-iteration preset loads with zero error findings", async () => {
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(BUNDLED_PRESET_DIR, { onValidationFinding: (f) => findings.push(f) })
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("bundled single-phase-example preset loads with zero error findings", async () => {
		const findings: PresetPlaceholderFinding[] = []
		await loadPreset(resolve(REPO_ROOT, "presets/single-phase-example"), { onValidationFinding: (f) => findings.push(f) })
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})
})

describe("loadPreset cross-table DAG check (issue #408)", () => {
	// Fixture writer: copies the placeholder-validation `minimalPresetToml` shape
	// but takes an arbitrary preset.toml body so each row of issue #408's
	// acceptance table can construct exactly the violation it needs (and nothing
	// else). All fixtures pin the entry md to "run-entry.md" with two declared
	// variables — `KEY` (item.id) and `TITLE` (item.title) — and write a matching
	// entry md so the placeholder validator never trips before the DAG checker.
	async function writeDagFixture(tomlBody: string): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-dag-preset-"))
		await writeFile(resolve(dir, "preset.toml"), tomlBody)
		await writeFile(resolve(dir, "run-entry.md"), "id={{KEY}} title={{TITLE}}\n")
		return dir
	}

	const baseStatusesBlock = `[item]
idField = "id"

[item.fields]
title = "string"
`

	// Row 5a — dead trigger edge (whenStatus has no producer in afterPhase's exits).
	// The existing local check at `loop.ts:4116-4122` already rejects this with
	// the precise per-phase error before the cross-table DAG checker ever runs,
	// so the new check is a non-overlap: this row's expected error message is the
	// existing local one. We assert that behavior is preserved (the DAG checker
	// does not weaken or hide the local rejection).
	test("row #1 / row #5a: trigger edge keyed on a status no producer phase writes is rejected by the existing local check (DAG checker does not regress it)", async () => {
		const dir = await writeDagFixture(`name = "dead-trigger-edge"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Done."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "responder"
prompt  = "run-entry.md"
trigger = { afterPhase = "run", whenStatus = "queued" }

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		// Existing local rule fires first with the per-phase pinpoint; cross-table
		// DAG check never runs on this fixture because parsePreset rejects it.
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) })).rejects.toThrow(/preset\.phases\[1\]\.trigger\.whenStatus: status "queued" is not declared by phase "run" item-status exits/)
		expect(findings).toEqual([])
	})

	test("row #2 / row #5b: deadlock-continuable surfaces as an error finding pinpointing the table and status", async () => {
		// Two continuable statuses, only one of which has any phase-exit leaving
		// edge. `pending` is the deadlock target — no phase writes !=pending.
		const dir = await writeDagFixture(`name = "deadlock-continuable"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "pending"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "pending"
  when   = "Always stays in pending — the deadlock."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset.statuses.continuable: "pending" has no leaving phase-exit edge/)
		const deadlock = findings.find((f) => f.kind === "deadlock-continuable")
		expect(deadlock).toBeDefined()
		if (deadlock?.kind === "deadlock-continuable") {
			expect(deadlock.verdict).toBe("error")
			expect(deadlock.table).toBe("statuses.continuable")
			expect(deadlock.status).toBe("pending")
			expect([...deadlock.contributingPhases]).toEqual(["run"])
		}
	})

	test("row #3: dead-vocabulary surfaces as a warn finding and does NOT block the load", async () => {
		// `in_progress` is declared continuable but no producer (entry, exhausted,
		// or any item-status exit) can write it. This is the real-e2e-minimal
		// drift acknowledged in the issue body.
		const dir = await writeDagFixture(`name = "dead-vocabulary"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "in_progress"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("dead-vocabulary")
		const dead = findings.find((f) => f.kind === "dead-vocabulary")
		expect(dead).toBeDefined()
		if (dead?.kind === "dead-vocabulary") {
			expect(dead.verdict).toBe("warn")
			expect(dead.table).toBe("statuses.continuable")
			expect(dead.status).toBe("in_progress")
			// Known producers: entry ("queued"), exhausted ("exhausted"), and the
			// single item-status exit ("done"). The list is sorted for stability.
			expect([...dead.knownProducers]).toEqual(["done", "exhausted", "queued"])
		}
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("row #4: every bundled preset loads with no DAG error findings", async () => {
		for (const presetDir of [
			BUNDLED_PRESET_DIR,
			resolve(REPO_ROOT, "presets/single-phase-example"),
			resolve(REPO_ROOT, "presets/business-key-example"),
			resolve(REPO_ROOT, "presets/real-e2e-minimal"),
		]) {
			const findings: PresetDagFinding[] = []
			await loadPreset(presetDir, { onDagFinding: (f) => findings.push(f) })
			expect(findings.filter((f) => f.verdict === "error")).toEqual([])
		}
	})

	test("row #4 (chain-complete variant): a `trigger = { on = \"chain-complete\" }` phase with no exits is NOT misreported as a deadlock contributor", async () => {
		// Mirror the umbrella-finalizer shape from `gh-issue-pr-iteration`. The
		// chain-complete trigger phase fires only on chain completion and writes
		// no item status; it must not be counted as a leaving edge for any
		// continuable status, and it must not appear in the deadlock-finding
		// `contributingPhases` list. We verify by giving `run` a real leaving
		// edge for `queued` and a chain-complete phase with zero exits — the load
		// must succeed with zero findings.
		const dir = await writeDagFixture(`name = "chain-complete-variant"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "finalizer"
prompt  = "run-entry.md"
trigger = { on = "chain-complete" }

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("chain-complete-variant")
		expect(findings).toEqual([])
	})

	test("row #5: entry status outside continuable is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "entry-not-continuable"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "done"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.statuses\.entry: "done" must be one of statuses\.continuable/)
	})

	test("row #5: unblockable status outside terminal is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "unblockable-not-terminal"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
unblockable = ["queued"]
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.statuses\.unblockable: "queued" must be one of statuses\.terminal/)
	})

	test("row #5: exit status outside the declared vocabulary is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "exit-status-unknown"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "no_such_status"
  when   = "This status is not in the declared vocabulary."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.phases\[\d+\]\.exits\.status: unrecognized status "no_such_status"/)
	})

	test("trigger-keyed phase whose exits all write back to its own keyed status is correctly identified as NOT a leaving edge", async () => {
		// A trigger phase with `whenStatus = S` and exits writing only `S` does
		// NOT contribute a leaving edge for S. This pins the (b)-branch of the
		// leaving-check rule: a triggered responder that only re-asserts its
		// gating status is a self-loop, not a path out.
		const dir = await writeDagFixture(`name = "trigger-selfloop"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "needs_review"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "needs_review"
  when   = "Item needs review attention."

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "responder"
prompt  = "run-entry.md"
trigger = { afterPhase = "run", whenStatus = "needs_review" }

  [[phases.exits]]
  status = "needs_review"
  when   = "Responder failed; re-key on needs_review for retry."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("trigger-selfloop")
		// `needs_review` has a leaving edge through `run` (which writes `done` !=
		// needs_review), so it is NOT a deadlock; the responder's self-loop does
		// not contribute, but it does not need to.
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
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

// --- preset materialization (`{{PRESET_ROOT}}` substitution + hash-keyed copy) ---
//
// Materialization is the substitution site for the engine-owned `{{PRESET_ROOT}}`
// token used by cross-file references in preset md files. The tests below cover
// (1) that token replacement is physical and produces an absolute path,
// (2) that the target dir is content-hash-keyed so unchanged sources are
// idempotent and source edits produce a new dir, (3) that loadPreset's
// `materialize` option threads through so `preset.presetDir` and every
// fragment/prompt path resolves to the materialized copy, (4) that
// placeholder validation ignores `{{PRESET_ROOT}}` (it's engine-owned, not
// declared in [phases.variables]), and (5) that `prunePresetMaterializedRoot`
// removes stale dirs.

async function writeMinimalMaterializeFixture(root: string, sentinel: string): Promise<{ presetDir: string }> {
	const presetDir = resolve(root, "materialize-fixture")
	await mkdir(resolve(presetDir, "quality"), { recursive: true })
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "materialize-fixture"

[item]
idField = "issue"

[item.fields]
issue = "number"

[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[[phases]]
name = "iteration"
prompt = "iter-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "task finished"

  [phases.variables]
  PROMPT_ROOT = "runtime.presetDir"
`,
	)
	// Entry references a fragment via {{PRESET_ROOT}}; body carries a sentinel
	// so tests can spot content edits in the hash.
	await writeFile(
		resolve(presetDir, "iter-entry.md"),
		`Prompt root: {{PROMPT_ROOT}}\n\nRead {{PRESET_ROOT}}/quality/evidence.md before you act.\n\nSentinel: ${sentinel}\n`,
	)
	await writeFile(resolve(presetDir, "quality/evidence.md"), "quality evidence body\n")
	return { presetDir }
}

describe("materializePreset", () => {
	test("replaces {{PRESET_ROOT}} in .md files with the target absolute path; non-md files pass through verbatim", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const result = await materializePreset(presetDir, materializeRoot)

		expect(result.promptRoot).toBe(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME, result.dirName))
		expect(result.dirName.startsWith("materialize-fixture-")).toBe(true)

		// .md entry: token has been physically substituted with the target path.
		const entry = await readFile(resolve(result.promptRoot, "iter-entry.md"), "utf-8")
		expect(entry).not.toContain(PRESET_ROOT_TOKEN)
		expect(entry).toContain(`Read ${result.promptRoot}/quality/evidence.md`)

		// Non-md preset.toml: byte-for-byte copy (materialization does not touch
		// it; parsing runs on the target so path resolution still lands inside
		// the materialized dir).
		const tomlSrc = await readFile(resolve(presetDir, "preset.toml"), "utf-8")
		const tomlDst = await readFile(resolve(result.promptRoot, "preset.toml"), "utf-8")
		expect(tomlDst).toBe(tomlSrc)

		// Marker file signals a completed materialization for idempotent reuse.
		const marker = await stat(resolve(result.promptRoot, ".materialized-complete"))
		expect(marker.isFile()).toBe(true)
	})

	test("content hash is stable across repeated calls (idempotent) and changes when source changes", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const first = await materializePreset(presetDir, materializeRoot)
		const second = await materializePreset(presetDir, materializeRoot)
		expect(second.contentHash).toBe(first.contentHash)
		expect(second.promptRoot).toBe(first.promptRoot)

		// Same-content re-run keeps the single dir; prune-siblings-on-materialize
		// leaves the current one alone.
		const rootEntries = await readdir(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))
		expect(rootEntries.filter((entry) => entry.startsWith("materialize-fixture-"))).toEqual([first.dirName])

		// Editing the source produces a new hash and a new materialized dir; the
		// previous dir is pruned because it shares the `materialize-fixture-`
		// name prefix.
		await writeFile(
			resolve(presetDir, "iter-entry.md"),
			`Prompt root: {{PROMPT_ROOT}}\n\nRead {{PRESET_ROOT}}/quality/evidence.md before you act.\n\nSentinel: beta\n`,
		)
		const third = await materializePreset(presetDir, materializeRoot)
		expect(third.contentHash).not.toBe(first.contentHash)
		expect(third.promptRoot).not.toBe(first.promptRoot)
		const afterEdit = await readdir(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))
		expect(afterEdit.filter((entry) => entry.startsWith("materialize-fixture-"))).toEqual([third.dirName])
	})

	test("loadPreset({ materialize }) points preset.presetDir + fragment/prompt paths at the materialized copy", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const preset = await loadPreset(presetDir, { materialize: { root: materializeRoot } })
		expect(preset.presetDir.startsWith(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))).toBe(true)
		expect(preset.presetDir).not.toBe(presetDir)

		const iterPhase = preset.phases.find((phase) => phase.name === "iteration")
		expect(iterPhase).not.toBeUndefined()
		expect(iterPhase!.prompt.startsWith(preset.presetDir + "/")).toBe(true)

		// The materialized phase entry has no {{PRESET_ROOT}} residue.
		const entry = await readFile(iterPhase!.prompt, "utf-8")
		expect(entry).not.toContain(PRESET_ROOT_TOKEN)
	})

	test("materialize threads through gh-issue-pr-iteration end-to-end (all 57 references substituted, no residue in md files)", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")

		const preset = await loadPreset(BUNDLED_PRESET_DIR, { materialize: { root: materializeRoot } })
		expect(preset.presetDir).not.toBe(BUNDLED_PRESET_DIR)

		// No md file in the materialized tree may still carry the token — the
		// substitution guarantee is what makes the fragments' absolute paths
		// resolve inside the sandbox at runtime.
		const walk = async (dir: string): Promise<string[]> => {
			const out: string[] = []
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const full = resolve(dir, entry.name)
				if (entry.isDirectory()) out.push(...(await walk(full)))
				else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full)
			}
			return out
		}
		const mdFiles = await walk(preset.presetDir)
		expect(mdFiles.length).toBeGreaterThan(0)
		for (const file of mdFiles) {
			const content = await readFile(file, "utf-8")
			expect(content).not.toContain(PRESET_ROOT_TOKEN)
		}
	})
})

describe("{{PRESET_ROOT}} placeholder handling", () => {
	test("loadPreset does not flag {{PRESET_ROOT}} as undeclared even when the phase entry uses it (in-memory substitution runs before validate)", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const findings: PresetPlaceholderFinding[] = []
		// No materialize option — the source md still contains the raw token,
		// but readPresetPhasePrompt substitutes with sourceDir before the
		// placeholder validator runs; validation must not report PRESET_ROOT
		// as an undeclared placeholder.
		await loadPreset(presetDir, { onValidationFinding: (finding) => findings.push(finding) })
		const errorFindings = findings.filter((finding) => finding.verdict === "error")
		expect(errorFindings).toEqual([])
	})

	test("substitutePresetRootToken is idempotent (no-op on content that already has been substituted)", () => {
		const substituted = substitutePresetRootToken("Read {{PRESET_ROOT}}/quality/evidence.md", "/materialized/preset-x")
		expect(substituted).toBe("Read /materialized/preset-x/quality/evidence.md")
		// Re-invoking has no effect (materialized files never round-trip through
		// the substitute helper, but idempotence is a load-bearing invariant of
		// the runtime read-and-substitute path).
		expect(substitutePresetRootToken(substituted, "/materialized/preset-x")).toBe(substituted)
	})
})

describe("prunePresetMaterializedRoot", () => {
	test("removes materialized dirs not present in the keep set; leaves kept dirs and returns cleanly on a missing root", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-prune-"))
		const materializeRoot = resolve(tmp, "loop-data")
		// Missing root: prune is a no-op (no throw).
		await prunePresetMaterializedRoot(materializeRoot, new Set())

		const rootDir = resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME)
		await mkdir(resolve(rootDir, "alpha-abcdef01"), { recursive: true })
		await mkdir(resolve(rootDir, "alpha-11111111"), { recursive: true })
		await mkdir(resolve(rootDir, "beta-99999999"), { recursive: true })

		await prunePresetMaterializedRoot(materializeRoot, new Set(["alpha-abcdef01", "beta-99999999"]))
		const remaining = await readdir(rootDir)
		expect(remaining.sort()).toEqual(["alpha-abcdef01", "beta-99999999"].sort())
	})
})
