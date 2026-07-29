import { describe, expect, test } from "bun:test"

import {
	resolve,
	readFile,
	stat,
	chainCompleteTriggerPhases,
	loadPreset,
	renderRuntimeInputsDoc,
	resolveBinding,
	triggeredPhasesAfter,
	storedItemExtra,
	Preset,
	PresetVariableSource,
	ResolveContext,
	BUNDLED_PRESET_DIR,
	REAL_E2E_MINIMAL_PRESET_DIR,
	status,
	makeMinimalRuntimeBindings,
	makeItemRecord,
	EXPECTED_FRAGMENTS,
	EXPECTED_VARIABLE_KEYS,
} from "./helpers"

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
			item: makeItemRecord(),
			chain: { umbrellaRepo: "mouriya-s-lab/coder-loop", umbrellaIssue: 457, repository: "x", baseBranch: "main" },
			runtime: makeMinimalRuntimeBindings(),
			preset,
		}
		expect(resolveBinding(umbrellaRepoVar!.source, populated)).toBe("mouriya-s-lab/coder-loop")
		expect(resolveBinding(umbrellaIssueVar!.source, populated)).toBe("457")
		// Empty metadata.bindings: declared fallback emits "" rather than crashing.
		const empty: ResolveContext = {
			item: makeItemRecord(),
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

