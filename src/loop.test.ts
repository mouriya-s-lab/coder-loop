import { describe, expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import {
	agentCodexArgs,
	agentOpencodeArgs,
	agentSessionsPath,
	buildCentralRuntimeBindingPaths,
	buildRenderBindings,
	buildDaemonStartPlan,
	buildRuntimeBindings,
	createSummaryWatchdog,
	decideResume,
	detectHostRunner,
	extractErrorCode,
	isTransient5xx,
	extractPromptPlaceholders,
	getItemId,
	makeIssueRunContext,
	normalizeQueueIssueId,
	parsePreset,
	parseSessionIdFromRunnerStream,
	renderFragmentIndex,
	renderPrompt,
	ENGINE_RUNTIME_BINDING_KEYS,
	stripRoleEntryFrontmatter,
	resolveBinding,
	selectRunnerForPhase,
	summaryWatchdogConfigForPhase,
	validatePresetPhaseTemplate,
	type RenderBindings,
	type IssueRunContext,
	type JsonObject,
	type LoopOptions,
	type Preset,
	type PresetPhase,
	type ResolveContext,
	type RuntimeBindings,
	type StatusCurrentRunSnapshot,
} from "./loop"
import { parseInternalStatus, storedItemExtra } from "./runtime-data"
import type { ItemRecord } from "./sqlite-state"
import type { BoundaryRecord } from "./boundary-types"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/loop-tests")

// #419: ItemRecord retired top-level `issueNumber` / `branch` / `pr`. Tests still want the
// legibility of passing those names — accept them as shim aliases and fold into `itemId` /
// `extra` for the actual record shape.
type MakeItemOverrides = Omit<Partial<ItemRecord>, "extra"> & {
	extra?: JsonObject
	issueNumber?: number
	branch?: string | null
	pr?: number | null
}

function itemSessionIdsToJsonObject(value: ItemRecord["sessionIds"]): JsonObject {
	// Structural narrowing for the test fixture: walk the typed `Record<string, Partial<Record<runner, string>>>`
	// and emit a JsonObject with only the present runner strings. Avoids `as JsonObject` (the #419 review's
	// C1 red-line on real casts). Empty runner maps are still emitted as empty objects to match the
	// underlying ItemRecord shape — tests don't currently exercise that branch but the helper stays honest.
	const result: JsonObject = {}
	for (const [phase, runners] of Object.entries(value)) {
		const runnerMap: JsonObject = {}
		for (const [runner, sessionId] of Object.entries(runners)) {
			if (typeof sessionId === "string") runnerMap[runner] = sessionId
		}
		result[phase] = runnerMap
	}
	return result
}

function makeItem(overrides: MakeItemOverrides = {}): ItemRecord {
	const { extra, issueNumber, branch, pr, ...rest } = overrides
	const extraWithLegacy: JsonObject = { ...(extra ?? {}) }
	// #419: bundled preset's idField is `issue` and reads from `extra.issue` via the
	// preset-declared transparent-field path. Tests that pass `issueNumber:` as a shim alias
	// also want the value visible there (resolveBinding({kind:"item", field:"issue"}) reads
	// `extra.issue`). Don't overwrite when the caller already supplied a custom value.
	if (issueNumber !== undefined && extraWithLegacy.issue === undefined) extraWithLegacy.issue = issueNumber
	// Caller-supplied `extra.branch` / `extra.pr` win over the shim alias — mirrors the
	// engine semantics where a preset-declared transparent field already in extra is
	// authoritative against any legacy top-level passthrough.
	if (branch !== undefined && branch !== null && extraWithLegacy.branch === undefined) extraWithLegacy.branch = branch
	if (pr !== undefined && pr !== null && extraWithLegacy.pr === undefined) extraWithLegacy.pr = pr
	// #419: `lookupItemRootField` only resolves engine fields (id/status/agentCwd/runner/phase)
	// from physical columns. Every other preset-readable field — including `title` and
	// `sessionIds` — is read from `extra`. Mirror the engine path so test fixtures don't
	// silently desync between physical and preset-visible state.
	if (rest.title !== undefined && rest.title !== null && extraWithLegacy.title === undefined) extraWithLegacy.title = rest.title
	// #419 review C1: structural narrowing instead of `as JsonObject` so the test honors the
	// red-line on real `as` casts. `ItemSessionIds = Record<string, Partial<Record<runner, string>>>`
	// is structurally JsonObject-compatible at runtime (no `undefined` values after normalize), but
	// the TS-level `Partial<...>` widens runner values to `string | undefined` which JsonValue rejects.
	// `itemSessionIdsToJsonObject` walks the typed structure, skipping `undefined` runner entries.
	if (rest.sessionIds !== undefined && extraWithLegacy.sessionIds === undefined) extraWithLegacy.sessionIds = itemSessionIdsToJsonObject(rest.sessionIds)
	return {
		id: rest.id ?? 1,
		chainId: rest.chainId ?? 10,
		itemId: rest.itemId ?? (issueNumber !== undefined ? String(issueNumber) : ""),
		repoCwd: rest.repoCwd ?? REPO_ROOT,
		status: rest.status ?? parseInternalStatus("queued", "test.status"),
		attempts: rest.attempts ?? 0,
		position: rest.position ?? 0,
		title: rest.title ?? "test item",
		priority: rest.priority ?? null,
		lastRunId: rest.lastRunId ?? null,
		sessionIds: rest.sessionIds ?? {},
		issueFile: rest.issueFile ?? null,
		evidenceDir: rest.evidenceDir ?? null,
		agentCwd: rest.agentCwd ?? null,
		runner: rest.runner ?? null,
		phase: rest.phase ?? null,
		// #412: per-item preset declaration. Tests default to null (legacy item; resolves via
		// chain.preset fallback) unless the caller overrides.
		preset: rest.preset ?? null,
		presetPath: rest.presetPath ?? null,
		extra: storedItemExtra(extraWithLegacy),
		createdAt: rest.createdAt ?? 1,
		updatedAt: rest.updatedAt ?? 1,
		statusUpdatedAt: rest.statusUpdatedAt ?? rest.updatedAt ?? 1,
	}
}

function minimalPresetRoot(overrides: BoundaryRecord = {}): BoundaryRecord {
	return {
		name: "fixture",
		item: { idField: "issue" },
		statuses: { continuable: ["queued", "changes_requested"], terminal: ["done", "blocked"], exhausted: "blocked" },
		phases: [
			{
				name: "iteration",
				prompt: "iteration.md",
				variables: { ISSUE: "item.issue" },
			},
			{
				name: "review",
				prompt: "review.md",
				variables: { ISSUE: "item.issue" },
			},
		],
		...overrides,
	}
}

function makePreset(overrides: BoundaryRecord = {}): Preset {
	return parsePreset(minimalPresetRoot(overrides), resolve(REPO_ROOT, "presets/fixture"))
}

function makeChainBindings(overrides: Partial<RenderBindings> = {}): RenderBindings {
	return {
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		requireBrowserEvidence: false,
		...overrides,
	}
}

function makeRuntime(overrides: Partial<RuntimeBindings> = {}): RuntimeBindings {
	return {
		runId: "run-fixture",
		targetCwd: REPO_ROOT,
		agentCwd: REPO_ROOT,
		sharedContextPath: resolve(TEST_ROOT, "chains/fixture/shared.md"),
		stateFile: "the central state DB",
		currentIssueFile: resolve(TEST_ROOT, "chains/fixture/issues/333.md"),
		issueDir: resolve(TEST_ROOT, "chains/fixture/issues"),
		evidenceDir: resolve(TEST_ROOT, "chains/fixture/evidence/333"),
		evidenceRootDir: resolve(TEST_ROOT, "chains/fixture/evidence"),
		logDir: resolve(TEST_ROOT, "chains/fixture/runs"),
		traceFile: `${resolve(TEST_ROOT, "chains/fixture/runs")}/run-fixture/<phase>/stdout.jsonl`,
		loopFile: "central daemon scheduling state",
		presetDir: resolve(REPO_ROOT, "presets/fixture"),
		fragmentIndex: "- iter/index (iter): iter/index.md",
		runtimeInputsDoc: "",
		phaseExitsDoc: "",
		// #404: placeholder slots — actual values come from the per-phase doc
		// builders called by `resolvePhaseBinding`. The runtime record only
		// carries empty strings to satisfy the Record<EngineRuntimeBindingKey, string> type.
		statusVocabularyDoc: "",
		triggerStatusDoc: "",
		terminalStatusesDoc: "",
		retryStatusDoc: "",
		runIdGeneration: "new",
		resumedFromPhase: "",
		resumedStartedAt: "",
		resumedSessionId: "",
		chainName: "fixture",
		repoCwd: REPO_ROOT,
		...overrides,
	}
}

function makeOptions(preset = makePreset()): LoopOptions {
	const claudeRunner = { kind: "claude" as const, binary: "claude", extraArgs: [], model: null }
	const codexRunner = { kind: "codex" as const, binary: "codex", extraArgs: [], model: null }
	const opencodeRunner = { kind: "opencode" as const, binary: "opencode", extraArgs: [], model: null }
	return {
		targetCwd: REPO_ROOT,
		sharedContextPath: resolve(TEST_ROOT, "shared.md"),
		stateDbPath: resolve(TEST_ROOT, "db.sqlite"),
		issueDir: resolve(TEST_ROOT, "issues"),
		evidenceRootDir: resolve(TEST_ROOT, "evidence"),
		logDir: resolve(TEST_ROOT, "runs"),
		loopDataRoot: TEST_ROOT,
		logFile: resolve(TEST_ROOT, "runs/test.log"),
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		bindings: makeChainBindings(),
		chainName: "fixture",
		worktree: false,
		hostRunner: "codex",
		defaultRunner: { ...codexRunner, source: "engine-builtin" },
		runnerCommands: { claude: claudeRunner, codex: codexRunner, opencode: opencodeRunner },
		dryRun: false,
		preset,
	}
}

const ENGINE_RUNTIME_KEY_BLOCK_START = "<!-- engine-runtime-binding-keys:start -->"
const ENGINE_RUNTIME_KEY_BLOCK_END = "<!-- engine-runtime-binding-keys:end -->"
const ENGINE_RUNTIME_KEY_COUNT_PATTERN = /Engine runtime fact key count:\s*(\d+)/g

function documentedEngineRuntimeBindingCount(markdown: string, label: string): number {
	const matches = [...markdown.matchAll(ENGINE_RUNTIME_KEY_COUNT_PATTERN)]
	expect(matches.length, `${label} should declare exactly one engine runtime binding key count`).toBe(1)
	const rawCount = matches[0]?.[1]
	expect(rawCount).toBeDefined()
	return Number(rawCount)
}

function documentedEngineRuntimeBindingKeys(markdown: string): string[] {
	const start = markdown.indexOf(ENGINE_RUNTIME_KEY_BLOCK_START)
	const end = markdown.indexOf(ENGINE_RUNTIME_KEY_BLOCK_END)
	expect(start).toBeGreaterThanOrEqual(0)
	expect(end).toBeGreaterThan(start)
	const block = markdown.slice(start + ENGINE_RUNTIME_KEY_BLOCK_START.length, end)
	return [...block.matchAll(/runtime\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((match) => {
		const key = match[1]
		expect(key).toBeDefined()
		return key as string
	})
}

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

describe("runtime binding helpers", () => {
	test("documentation keeps engine runtime binding count and list aligned with source", async () => {
		const presetAuthoring = await readFile(resolve(REPO_ROOT, "docs/preset-authoring.md"), "utf8")
		const claude = await readFile(resolve(REPO_ROOT, "CLAUDE.md"), "utf8")

		expect(documentedEngineRuntimeBindingCount(presetAuthoring, "docs/preset-authoring.md")).toBe(ENGINE_RUNTIME_BINDING_KEYS.length)
		expect(documentedEngineRuntimeBindingCount(claude, "CLAUDE.md")).toBe(ENGINE_RUNTIME_BINDING_KEYS.length)
		expect(documentedEngineRuntimeBindingKeys(presetAuthoring)).toEqual([...ENGINE_RUNTIME_BINDING_KEYS])
	})

	test("reserved string registry includes engine-parsed summary enums (verdict words retired per #405)", async () => {
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
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { CUSTOM: "runtime.customBusiness" } },
				{ name: "review", prompt: "review.md", variables: { RUN_ID: "runtime.runId" } },
			],
		})
		const phase = preset.phases[0]!
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
				phases: [
					{ name: "iteration", prompt: "iteration.md", variables: { CUSTOM: "runtime.customBusiness" } },
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
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { AUDIT_DEMO: "runtime.auditDemo" } },
			],
		})
		const phase = preset.phases[0]!
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
		const phase = options.preset.phases[0]!
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
		const phase = options.preset.phases[0]!
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
			phases: [
				{ name: "iteration", prompt: "iteration.md", roles: ["common", "iter"], variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", roles: ["common", "review"], variables: { ISSUE: "item.issue" } },
			],
			fragments: [
				{ id: "common/runtime-contract", role: "common", path: "common/runtime-contract.md" },
				{ id: "iter/steps/implement", role: "iter", path: "iter/steps/implement.md" },
				{ id: "review/actions/retry", role: "review", path: "review/actions/retry.md" },
			],
		})
		const [iterPhase, reviewPhase] = preset.phases
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
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", variables: { ISSUE: "item.issue" } },
			],
		})
		expect(preset.phases[0]!.roles).toEqual([])
		expect(renderFragmentIndex(preset, preset.phases[0]!)).toBe("")
	})
})

describe("runner and daemon helpers", () => {
	// #456: item.runner override now applies uniformly to every non-trigger phase — the engine no
	// longer special-cases "the last non-trigger phase" (review under the bundled preset). Both
	// phases pick up the item override; phase-name-based gating belongs to preset declaration only.
	test("selectRunnerForPhase honors queue override on every non-trigger phase, regardless of phase name", () => {
		const base = makePreset()
		const preset: Preset = {
			...base,
			phases: base.phases.map((phase) =>
				phase.name === "iteration"
					? { ...phase, defaultRunner: "codex" as const }
					: { ...phase, defaultRunner: "claude" as const },
			),
		}
		const options = makeOptions(preset)
		const item = makeItem({ runner: "claude" })

		expect(selectRunnerForPhase("iteration", item, options).kind).toBe("claude")
		// The second phase in the fixture preset is named "review"; the engine no longer reads its
		// name — the queue override flows through because `trigger === null` is the only gate.
		expect(selectRunnerForPhase("review", item, options).kind).toBe("claude")
		expect(selectRunnerForPhase("review", item, options).source).toBe("queue")
		expect(selectRunnerForPhase("review", item, options).model).toBeNull()
	})

	test("selectRunnerForPhase uses engine-builtin fallback when role md omits defaultRunner", () => {
		const preset = makePreset()
		const options = makeOptions(preset)
		const item = makeItem()
		const runner = selectRunnerForPhase("iteration", item, options)

		expect(runner.kind).toBe("codex")
		expect(runner.source).toBe("engine-builtin")
	})

	test("parsePreset reads phase model and rejects blank values", () => {
		const preset = makePreset({
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", runner: "codex", model: "gpt-5.5", variables: { ISSUE: "item.issue" } },
			],
		})
		expect(preset.phases[0]?.defaultModel).toBeNull()
		expect(preset.phases[1]?.defaultModel).toBe("gpt-5.5")

		expect(() =>
			makePreset({
				phases: [
					{ name: "iteration", prompt: "iteration.md", model: "  ", variables: { ISSUE: "item.issue" } },
					{ name: "review", prompt: "review.md", variables: { ISSUE: "item.issue" } },
				],
			}),
		).toThrow(/preset\.phases\[0\]\.model: must be a non-empty string/)
	})

	test("selectRunnerForPhase resolves the preset phase model when config declares none", () => {
		const preset = makePreset({
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", runner: "codex", model: "gpt-5.5", variables: { ISSUE: "item.issue" } },
			],
		})
		const options = makeOptions(preset)
		const review = selectRunnerForPhase("review", makeItem(), options)

		expect(review.kind).toBe("codex")
		expect(review.source).toBe("preset")
		expect(review.model).toBe("gpt-5.5")
	})

	test("explicit config model overrides the preset phase model", () => {
		const preset = makePreset({
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", runner: "codex", model: "gpt-5.5", variables: { ISSUE: "item.issue" } },
			],
		})
		const options = makeOptions(preset)
		options.runnerCommands = { ...options.runnerCommands, codex: { ...options.runnerCommands.codex, model: "gpt-5.5-codex" } }

		expect(selectRunnerForPhase("review", makeItem(), options).model).toBe("gpt-5.5-codex")
	})

	test("item runner override to a different kind does not inherit the preset phase model", () => {
		const preset = makePreset({
			phases: [
				{ name: "iteration", prompt: "iteration.md", runner: "codex", model: "gpt-5.5", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", variables: { ISSUE: "item.issue" } },
			],
		})
		const options = makeOptions(preset)

		const sameKind = selectRunnerForPhase("iteration", makeItem({ runner: "codex" }), options)
		expect(sameKind.source).toBe("queue")
		expect(sameKind.model).toBe("gpt-5.5")

		const otherKind = selectRunnerForPhase("iteration", makeItem({ runner: "claude" }), options)
		expect(otherKind.kind).toBe("claude")
		expect(otherKind.model).toBeNull()
	})

	test("stripRoleEntryFrontmatter removes leading frontmatter so prompts never start with --", () => {
		expect(stripRoleEntryFrontmatter("---\ndefaultRunner: claude\n---\n# role\nbody")).toBe("# role\nbody")
		// trailing blank line(s) after the closing fence are collapsed
		expect(stripRoleEntryFrontmatter("---\ndefaultRunner: codex\n---\n\n# role")).toBe("# role")
		// no frontmatter -> untouched
		expect(stripRoleEntryFrontmatter("# role\nbody")).toBe("# role\nbody")
		// a bare leading --- with no closing fence is left intact (not frontmatter)
		expect(stripRoleEntryFrontmatter("--- not frontmatter")).toBe("--- not frontmatter")
		// CRLF frontmatter is stripped too
		expect(stripRoleEntryFrontmatter("---\r\ndefaultRunner: claude\r\n---\r\n# role")).toBe("# role")
	})

	test("buildDaemonStartPlan starts the central daemon without legacy loop flags", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const plan = buildDaemonStartPlan({
			action: "start",
			targetCwd: REPO_ROOT,
			loopDataRoot: TEST_ROOT,
			chainName: "fixture",
			dryRun: true,
			worktree: false,
			json: false,
		})

		expect(plan.command).toEqual([process.argv[0] ?? "bun", resolve(import.meta.dir, "loop.ts"), "daemon", "up", "--loop-data-root", TEST_ROOT])
		expect(plan.commandLine).not.toContain("--target-cwd")
		expect(plan.commandLine).not.toContain("--require-browser-evidence")
		// The central daemon is global: its stdout/stderr land under loop-data/daemon, never
		// pinned to a chains/<chain> directory or the legacy target-local .coder-loop/runtime/logs.
		expect(plan.stdoutPath.startsWith(resolve(TEST_ROOT, "daemon") + "/")).toBe(true)
		expect(plan.stderrPath.startsWith(resolve(TEST_ROOT, "daemon") + "/")).toBe(true)
		const daemonStdoutPath = relative(TEST_ROOT, plan.stdoutPath)
		expect(daemonStdoutPath.split("/")).not.toContain("chains")
		expect(daemonStdoutPath.includes("runtime/logs")).toBe(false)
	})

	test("daemon rejects retired max-iterations option", () => {
		const retiredOption = ["--max", "iterations"].join("-")
		for (const action of ["start", "restart"]) {
			const proc = Bun.spawnSync({
				cmd: ["bun", resolve(import.meta.dir, "loop.ts"), "daemon", action, REPO_ROOT, retiredOption, "1"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			const stderr = new TextDecoder().decode(proc.stderr)
			expect(proc.exitCode).toBe(1)
			expect(stderr).toContain("Unknown arguments")
			expect(stderr).not.toContain("SQLite state DB")
		}
	})

	test("agentCodexArgs and session path helpers keep runner plumbing stable", () => {
		expect(agentCodexArgs(["--json"], "prompt", { kind: "resume", sessionId: "thread-1" }, REPO_ROOT)).toEqual([
			"--ask-for-approval",
			"never",
			"exec",
			"resume",
			"thread-1",
			"--json",
			"--ignore-rules",
			"prompt",
		])
		expect(agentSessionsPath("/repo/runs/run-1/iteration/stdout.jsonl")).toBe("/repo/runs/run-1/iteration/sessions.jsonl")
	})

	test("agentOpencodeArgs renders run subcommand with json format model dir and optional resume", () => {
		// #481 acceptance #4: opencode invocation must match what the operator's local
		// `opencode 1.17.5` accepts — `opencode run --format json --dangerously-skip-permissions
		// -m <model> [-s <sessionID>] <prompt>` — and must preserve user-supplied extra args
		// while stripping any user-supplied `-m`/`--model` so the engine's resolved model wins.

		// Fresh start: no resume, default model fallback (`opencode-go/glm-5.2` from
		// DEFAULT_OPENCODE_MODEL when caller passes null).
		expect(agentOpencodeArgs([], "do thing", { kind: "fresh" }, null)).toEqual([
			"run",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"-m",
			"opencode-go/glm-5.2",
			"do thing",
		])

		// Resume: `-s <sessionId>` appended after model and before prompt.
		expect(agentOpencodeArgs([], "continue", { kind: "resume", sessionId: "ses_abc" }, "opencode-go/glm-5.2")).toEqual([
			"run",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"-m",
			"opencode-go/glm-5.2",
			"-s",
			"ses_abc",
			"continue",
		])

		// User-supplied `-m` is stripped (engine model wins); other extra args are preserved
		// verbatim. We feed `--quiet` so the test exercises both behaviors at once.
		expect(agentOpencodeArgs(["-m", "other/model", "--quiet"], "hi", { kind: "fresh" }, "opencode-go/glm-5.2")).toEqual([
			"run",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"--quiet",
			"-m",
			"opencode-go/glm-5.2",
			"hi",
		])
	})

	test("parseSessionIdFromRunnerStream extracts opencode sessionID from JSONL first line", () => {
		// #481: the engine consumes opencode's JSONL stdout and reads `sessionID` off the first
		// event. This shape is what `opencode run --format json -m … "…"` actually writes — the
		// `step_start` event arrives first and already carries `sessionID`.
		const stdout = `{"type":"step_start","timestamp":1781852083376,"sessionID":"ses_12156f631ffekbejfp2hbSJNs5","part":{"id":"prt_x"}}\n{"type":"text","sessionID":"ses_12156f631ffekbejfp2hbSJNs5"}\n`
		expect(parseSessionIdFromRunnerStream("opencode", stdout)).toBe("ses_12156f631ffekbejfp2hbSJNs5")
		expect(parseSessionIdFromRunnerStream("opencode", "")).toBe(null)
		expect(parseSessionIdFromRunnerStream("opencode", "not json\n")).toBe(null)
	})
})

describe("small parsers", () => {
	test("detectHostRunner defaults to Codex inside Codex env and Claude otherwise", () => {
		expect(detectHostRunner({ CODEX_SHELL: "1" })).toBe("codex")
		expect(detectHostRunner({ CODEX_THREAD_ID: "thread" })).toBe("codex")
		expect(detectHostRunner({ CLAUDECODE: "1" })).toBe("claude")
		expect(detectHostRunner({})).toBe("claude")
	})

	test("normalizeQueueIssueId accepts local and cross-repo forms", () => {
		expect(normalizeQueueIssueId("#333")).toBe("333")
		expect(normalizeQueueIssueId("mouriya-s-lab/coder-loop#333")).toBe("333")
	})

	test("runner stream parsers extract sessions (verdict parser retired per #405)", () => {
		expect(parseSessionIdFromRunnerStream("claude", "{\"type\":\"system\",\"session_id\":\"sess-1\"}\n")).toBe("sess-1")
		expect(parseSessionIdFromRunnerStream("codex", "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}")).toBe("thread-1")
	})

	// #478 acceptance row 1: extractErrorCode must recognize account-level rate limit on
	// stdout JSONL (api_error_status:429 / error:rate_limit / "hit your session limit"
	// result text). Before #478 the W3 chain 35/37/38 incident saw extractErrorCode fall
	// through to stderr (which is empty on rate-limit) → returned "unclassified" →
	// decideResume went `fresh` → wasted the stored sessionId.
	test("extractErrorCode detects 429 in stdout JSONL (W3 fixture shape)", () => {
		const w3Stream = [
			`{"type":"system","session_id":"sess-1"}`,
			`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781713800,"rateLimitType":"five_hour"}}`,
			`{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 1:30am (Asia/Tokyo)"}`,
		].join("\n")
		expect(extractErrorCode(w3Stream, "")).toMatch(/rate_limit/)
		// Synthetic assistant-shape (error:"rate_limit") also classified, not falling through to "unclassified".
		expect(extractErrorCode(`{"is_error":true,"error":"rate_limit"}`, "")).toMatch(/rate_limit/)
		// Non-rate-limit JSONL preserves the legacy path: extracts error.type from is_error events.
		expect(extractErrorCode(`{"type":"result","is_error":true,"error":{"type":"timeout"}}`, "")).toBe("timeout")
	})

	// #478 acceptance row 2: the rate-limit code returned above must pass isTransient5xx,
	// so decideResume routes the rejected run to `resume` with the stored sessionId
	// (not `fresh`, which would have wasted the conversation continuity).
	test("isTransient5xx accepts the rate-limit error code", () => {
		expect(isTransient5xx("rate_limit_429")).toBe(true)
		expect(isTransient5xx("RateLimited")).toBe(true)
		expect(isTransient5xx("500_http")).toBe(true)
		expect(isTransient5xx("unclassified")).toBe(false)
	})

	// #456: `summaryWatchdogConfigForPhase` is preserved as a typed hook for #452's pending
	// summary-injection redesign, but the role-shaped marker field on `PresetPhase` was retired
	// together with the rest of the role taxonomy. The function now reports "no marker
	// configured" for every phase regardless of its name or declaration. The test pins that
	// terminal behavior so #452 can lift it intentionally rather than accidentally.
	test("summary watchdog config returns null for every phase until #452 lands a DSL-declared injection point", () => {
		const preset = makePreset()
		for (const phase of preset.phases) {
			expect(summaryWatchdogConfigForPhase(phase)).toBeNull()
		}
	})

	test("summary watchdog observes only the declared phase marker", () => {
		const timers: Array<() => void> = []
		let termCalls = 0
		let killCalls = 0
		const watchdog = createSummaryWatchdog({
			config: { marker: "PHASE DONE:", termMs: 1, killMs: 1 },
			setTimer: (cb) => {
				timers.push(cb)
				return null
			},
			clearTimer: () => {},
			onTerm: () => { termCalls++ },
			onKill: () => { killCalls++ },
			log: () => {},
		})

		watchdog.observeStdout("other summary marker\n")
		expect(watchdog.state()).toEqual({ kind: "idle" })
		expect(timers.length).toBe(0)

		watchdog.observeStdout("PHASE DONE: ok\n")
		expect(watchdog.state()).toEqual({ kind: "armed" })
		expect(timers.length).toBe(1)
		timers[0]!()
		expect(watchdog.state()).toEqual({ kind: "term-sent" })
		expect(termCalls).toBe(1)
		expect(timers.length).toBe(2)
		timers[1]!()
		expect(watchdog.state()).toEqual({ kind: "kill-sent" })
		expect(killCalls).toBe(1)
	})

	test("decideResume resumes interrupted or transient prior sessions only", () => {
		expect(decideResume(null)).toEqual({ kind: "fresh" })
		expect(decideResume({
			attempt: "a",
			runner: "codex",
			model: null,
			sessionId: "thread-clean",
			exitCode: 0,
			signal: null,
			terminated: { kind: "clean" },
			log: "stdout.jsonl",
		})).toEqual({ kind: "fresh" })
		expect(decideResume({
			attempt: "a",
			runner: "codex",
			model: null,
			sessionId: "thread-ok",
			exitCode: null,
			signal: "SIGTERM",
			terminated: { kind: "signal", name: "SIGTERM" },
			log: "stdout.jsonl",
		})).toEqual({ kind: "resume", sessionId: "thread-ok" })
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
