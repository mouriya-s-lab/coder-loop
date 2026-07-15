import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, relative, resolve } from "node:path"

import {
	agentCodexArgs,
	agentOpencodeArgs,
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
	agentSessionsPath,
	buildCentralRuntimeBindingPaths,
	buildRenderBindings,
	buildDaemonStartPlan,
	buildRuntimeBindings,
	phaseDeclaredRuntimeBindingPaths,
	createSummaryWatchdog,
	createSummaryWatchdogStdoutObserver,
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
	spawnOneAttempt,
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
import { createStreamTextState } from "./runner-output"

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
			"-c",
			"shell_environment_policy.inherit=all",
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
		// `opencode 1.17.10` accepts — `opencode run --pure --format json --dangerously-skip-permissions
		// --dir <cwd> -m <model> [-s <sessionID>] <prompt>` — and must preserve user-supplied extra args
		// while stripping any user-supplied `-m`/`--model` so the engine's resolved model wins.

		// Fresh start: no resume, default model fallback (`opencode-go/glm-5.2` from
		// DEFAULT_OPENCODE_MODEL when caller passes null).
		expect(agentOpencodeArgs([], "do thing", { kind: "fresh" }, null, "/repo")).toEqual([
			"run",
			"--pure",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"--dir",
			"/repo",
			"-m",
			"opencode-go/glm-5.2",
			"do thing",
		])

		// Resume: `-s <sessionId>` appended after model and before prompt.
		expect(agentOpencodeArgs([], "continue", { kind: "resume", sessionId: "ses_abc" }, "opencode-go/glm-5.2", "/repo")).toEqual([
			"run",
			"--pure",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"--dir",
			"/repo",
			"-m",
			"opencode-go/glm-5.2",
			"-s",
			"ses_abc",
			"continue",
		])

		// User-supplied `-m` is stripped (engine model wins); other extra args are preserved
		// verbatim. We feed `--quiet` so the test exercises both behaviors at once.
		expect(agentOpencodeArgs(["-m", "other/model", "--quiet"], "hi", { kind: "fresh" }, "opencode-go/glm-5.2", "/repo")).toEqual([
			"run",
			"--pure",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"--dir",
			"/repo",
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
	test("runner filesystem grants project one declared surface model across runners", () => {
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/loop-data",
			agentCwd: "/runtime/loop-data/chains/c/worktrees/i",
			presetDir: "/runtime/loop-data/preset-materialized/p",
			sharedContextPath: "/runtime/loop-data/chains/c/shared.md",
			currentIssueFile: "/runtime/loop-data/chains/c/issues/1.md",
			evidenceDir: "/runtime/loop-data/chains/c/evidence/1",
			evidenceRootDir: "/runtime/loop-data/chains/c/evidence",
			issueDir: "/runtime/loop-data/chains/c/issues",
			logDir: "/runtime/loop-data/chains/c/runs",
			daemonSocketPath: "/runtime/loop-data/daemon.sock",
			declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
		})
		expect(authorization.surfaces).toContainEqual({ kind: "read-only-directory", channel: "preset", path: "/runtime/loop-data/preset-materialized/p" })
		expect(authorization.surfaces).toContainEqual({ kind: "system-device", channel: "null", path: "/dev/null" })
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ path: "/runtime/loop-data" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ path: "/dev" }))
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `session-${kind}` }] as const) {
				const plan = buildRunnerInvocation({ kind, binary: kind, extraArgs: [], model: null, source: "engine-builtin" }, "prompt", resume, authorization)
				const runnerScratch = resolve("/runtime/loop-data/chains/c/worktrees/i", ".coder-loop-runner", "tmp")
				const outerSandboxProfile = plan.args[1]
				if (outerSandboxProfile === undefined) throw new Error("runner invocation must include an outer sandbox profile")
				expect(plan.binary).toBe("/usr/bin/sandbox-exec")
				expect(plan.authorizationEvidence.outerSandboxProfile).toBe(outerSandboxProfile)
				expect(plan.authorizationEvidence.runner).toBe(kind)
				expect(plan.authorizationEvidence.surfaces).toContainEqual(expect.objectContaining({ kind: kind === "codex" ? "runner-runtime-file" : "runner-runtime-directory", runner: kind }))
				expect(plan.args[2]).toBe(kind)
				expect(plan.args.slice(2)).not.toContain("/runtime/loop-data")
				expect(plan.args).not.toContain("danger-full-access")
				expect(plan.args[1]).toContain("/runtime/loop-data/chains/c/evidence/1")
				expect(plan.args[1]).toContain(runnerScratch)
				expect(plan.args[1]).toContain('(literal "/dev/null")')
				expect(plan.args[1]).toContain('(subpath "/runtime/loop-data/daemon.sock")')
				expect(plan.args[1]).toContain('(allow file-read-metadata (literal "/runtime/loop-data/chains") (literal "/runtime/loop-data/chains/c") (literal "/runtime/loop-data/chains/c/worktrees"))')
				expect(plan.args[1]).not.toContain('(subpath "/dev")')
				expect(plan.args.slice(2)).not.toContain("/dev/null")
				expect(plan.args[1]).not.toContain("/private/tmp/claude-")
				expect(plan.environment.TMPDIR).toBe(runnerScratch)
				expect(plan.environment.TMP).toBe(runnerScratch)
				expect(plan.environment.TEMP).toBe(runnerScratch)
				expect(plan.environment.CLAUDE_CODE_TMPDIR).toBe(kind === "claude" ? runnerScratch : undefined)
				expect(plan.runtimeDirectories).toEqual([runnerScratch])
				if (resume.kind === "resume") expect(plan.args).toContain(`session-${kind}`)
				if (kind === "claude") {
					expect(plan.args[1]).toContain(resolve(homedir(), ".claude/projects"))
				}
				if (kind === "codex") {
					expect(plan.args).not.toContain("--sandbox")
					expect(plan.args).toContain("shell_environment_policy.inherit=all")
					for (const filename of [
						"installation_id",
						"models_cache.json",
						"logs_2.sqlite", "logs_2.sqlite-shm", "logs_2.sqlite-wal",
						"goals_1.sqlite", "goals_1.sqlite-shm", "goals_1.sqlite-wal",
						"memories_1.sqlite", "memories_1.sqlite-shm", "memories_1.sqlite-wal",
					]) {
						expect(plan.args[1]).toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), filename))
					}
					expect(plan.args[1]).toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "cache"))
					expect(plan.args[1]).not.toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "plugins"))
					expect(plan.args[1]).toContain("(allow system-socket)")
				}
				if (kind === "opencode") {
					expect(plan.args).toContain("--pure")
					const dirIndex = plan.args.indexOf("--dir")
					expect(dirIndex).toBeGreaterThan(-1)
					expect(plan.args[dirIndex + 1]).toBe("/runtime/loop-data/chains/c/worktrees/i")
					expect(plan.args[1]).toContain(resolve(homedir(), ".local/share/opencode"))
					expect(plan.args[1]).toContain(resolve(homedir(), ".local/state/opencode"))
				}
			}
		}
	})

	test("runner filesystem grants reject equal-root and ancestor tree grants while retaining literal cwd traversal", () => {
		const input = {
			loopDataRoot: "/runtime/loop-data",
			agentCwd: "/runtime/loop-data/chains/c/worktrees/i",
			presetDir: "/runtime/loop-data/preset-materialized/p",
			sharedContextPath: "/runtime/loop-data/chains/c/shared.md",
			currentIssueFile: "",
			evidenceDir: "/runtime/loop-data/chains/c/evidence/1",
			evidenceRootDir: "/runtime/loop-data/chains/c/evidence",
			issueDir: "/runtime/loop-data/chains/c/issues",
			logDir: "/runtime/loop-data/chains/c/runs",
			daemonSocketPath: "/runtime/loop-data/daemon.sock",
			declaredRuntimeBindingPaths: [] as const,
		}
		expect(() => buildRunnerFilesystemAuthorization({ ...input, presetDir: input.loopDataRoot })).toThrow("may not grant the loop-data root")
		expect(() => buildRunnerFilesystemAuthorization({ ...input, presetDir: "/runtime" })).toThrow("may not grant an ancestor of the loop-data root")
		const authorization = buildRunnerFilesystemAuthorization(input)
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: "/runtime/loop-data/chains" })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "metadata", path: "/runtime/loop-data/chains/c/worktrees" })
	})

	test("runner git metadata authorizes a real commit from a linked worktree", async () => {
		const root = resolve(TEST_ROOT, "runner-linked-worktree-git")
		const repository = resolve(root, "repository")
		const worktree = resolve(root, "worktree")
		const loopDataRoot = resolve(root, "loop-data")
		await rm(root, { recursive: true, force: true })
		await mkdir(repository, { recursive: true })
		const git = (cwd: string, args: readonly string[]) => Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
		expect(git(repository, ["init", "-b", "main"]).exitCode).toBe(0)
		await writeFile(resolve(repository, "README.md"), "base\n")
		expect(git(repository, ["add", "README.md"]).exitCode).toBe(0)
		expect(git(repository, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]).exitCode).toBe(0)
		expect(git(repository, ["worktree", "add", "-b", "linked", worktree]).exitCode).toBe(0)
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd: worktree, presetDir: resolve(root, "preset"), sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"),
			currentIssueFile: "", evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"), evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"),
			issueDir: resolve(loopDataRoot, "chains/c/issues"), logDir: resolve(loopDataRoot, "chains/c/runs"), daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
			declaredRuntimeBindingPaths: [],
		})
		expect(authorization.surfaces).toContainEqual(expect.objectContaining({ kind: "writable-directory", channel: "git-worktree-metadata" }))
		expect(authorization.surfaces).toContainEqual(expect.objectContaining({ kind: "writable-directory", channel: "git-common-dir" }))
		const plan = buildRunnerInvocation({ kind: "claude", binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", { kind: "fresh" }, authorization)
		const commit = Bun.spawnSync({
			cmd: ["/usr/bin/sandbox-exec", "-p", plan.authorizationEvidence.outerSandboxProfile, "/bin/sh", "-c", "printf linked > linked.txt && git add linked.txt && git -c user.name=fixture -c user.email=fixture@example.invalid commit -m linked"],
			cwd: worktree, stdout: "pipe", stderr: "pipe",
		})
		expect(commit.exitCode, new TextDecoder().decode(commit.stderr)).toBe(0)
		expect(git(worktree, ["rev-parse", "--verify", "HEAD"]).exitCode).toBe(0)
	})

	test("runner filesystem grants let Bun discover a nested task cwd without broad parent authority", async () => {
		const root = resolve(TEST_ROOT, "runner-bun-cwd-discovery")
		const loopDataRoot = resolve(root, "loop-data")
		const agentCwd = resolve(loopDataRoot, "chains", "c", "worktrees", "i")
		const presetDir = resolve(loopDataRoot, "preset-materialized", "p")
		const undeclared = resolve(loopDataRoot, "chains", "c", "undeclared.txt")
		await rm(root, { recursive: true, force: true })
		await Promise.all([agentCwd, presetDir].map((path) => mkdir(path, { recursive: true })))
		await writeFile(resolve(agentCwd, "package.json"), `${JSON.stringify({ scripts: { check: "node -e \"process.stdout.write('cwd-ok')\"" } })}\n`)
		await writeFile(undeclared, "private\n")
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd, presetDir, sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"),
			currentIssueFile: "", evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"), evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"),
			issueDir: resolve(loopDataRoot, "chains/c/issues"), logDir: resolve(loopDataRoot, "chains/c/runs"), daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
			declaredRuntimeBindingPaths: [],
		})
		const plan = buildRunnerInvocation({ kind: "codex", binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", { kind: "fresh" }, authorization)
		const profile = plan.authorizationEvidence.outerSandboxProfile
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: resolve(loopDataRoot, "chains") })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: resolve(loopDataRoot, "chains", "c") })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "metadata", path: resolve(loopDataRoot, "chains", "c", "worktrees") })
		const bun = Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "run", "check"], cwd: agentCwd, stdout: "pipe", stderr: "pipe" })
		expect(bun.exitCode, new TextDecoder().decode(bun.stderr)).toBe(0)
		expect(new TextDecoder().decode(bun.stdout)).toContain("cwd-ok")
		expect(profile).toContain(`(allow file-read-data (literal "${resolve(loopDataRoot, "chains")}") (literal "${resolve(loopDataRoot, "chains", "c")}"))`)
		expect(profile).not.toContain(`(subpath "${resolve(loopDataRoot, "chains")}")`)
		expect(profile).not.toContain(`(subpath "${resolve(loopDataRoot, "chains", "c")}")`)
		const denied = Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/cat", undeclared], stdout: "pipe", stderr: "pipe" })
		expect(denied.exitCode).not.toBe(0)
	})

	test("runner filesystem grants deny undeclared writes and preserve every declared writable channel", async () => {
		const root = resolve(TEST_ROOT, "runner-filesystem-explicit-writes")
		const loopDataRoot = resolve(root, "loop-data")
		const agentCwd = resolve(root, "agent")
		const presetDir = resolve(root, "preset")
		const evidenceDir = resolve(loopDataRoot, "chains/c/evidence/1")
		const evidenceRootDir = resolve(loopDataRoot, "chains/c/evidence")
		const issueDir = resolve(loopDataRoot, "chains/c/issues")
		const logDir = resolve(loopDataRoot, "chains/c/runs")
		const sharedContextPath = resolve(loopDataRoot, "chains/c/shared.md")
		const currentIssueFile = resolve(issueDir, "1.md")
		const daemonSocketPath = resolve(loopDataRoot, "daemon.sock")
		const undeclared = resolve(root, "undeclared.txt")
		const undeclaredSameChain = resolve(loopDataRoot, "chains/c/undeclared.txt")
		const undeclaredOtherChain = resolve(loopDataRoot, "chains/other/private.txt")
		const undeclaredRoot = resolve(loopDataRoot, "central.sqlite")
		await rm(root, { recursive: true, force: true })
		await Promise.all([agentCwd, presetDir, evidenceDir, evidenceRootDir, issueDir, logDir].map((path) => mkdir(path, { recursive: true })))
		await mkdir(dirname(undeclaredOtherChain), { recursive: true })
		await Promise.all([sharedContextPath, currentIssueFile, daemonSocketPath, undeclared, undeclaredSameChain, undeclaredOtherChain, undeclaredRoot].map((path) => writeFile(path, "initial\n")))
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd, presetDir, sharedContextPath, currentIssueFile,
			evidenceDir, evidenceRootDir, issueDir, logDir, daemonSocketPath,
			declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
		})
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				const plan = buildRunnerInvocation({ kind, binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", resume, authorization)
				const profile = plan.args[1]!
				const writeProbe = (path: string) => Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `printf allowed >> ${JSON.stringify(path)}`], stdout: "pipe", stderr: "pipe" })
				const readProbe = (path: string) => Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `cat ${JSON.stringify(path)}`], stdout: "pipe", stderr: "pipe" })
				for (const path of [
					resolve(agentCwd, `${kind}-${resume.kind}-agent.txt`), resolve(evidenceDir, `${kind}-${resume.kind}-evidence.txt`), resolve(evidenceRootDir, `${kind}-${resume.kind}-root.txt`),
					resolve(issueDir, `${kind}-${resume.kind}-issue.txt`), resolve(logDir, `${kind}-${resume.kind}-log.txt`), sharedContextPath, currentIssueFile, daemonSocketPath,
				]) expect(writeProbe(path).exitCode, `${kind}/${resume.kind}: ${path}`).toBe(0)
				expect(writeProbe("/dev/null").exitCode, `${kind}/${resume.kind}: /dev/null`).toBe(0)
				expect(writeProbe("/dev/zero").exitCode, `${kind}/${resume.kind}: /dev sibling`).not.toBe(0)
				expect(writeProbe(resolve(presetDir, `${kind}-${resume.kind}-forbidden.txt`)).exitCode, `${kind}/${resume.kind}: preset`).not.toBe(0)
				expect(writeProbe(undeclared).exitCode, `${kind}/${resume.kind}: undeclared`).not.toBe(0)
				for (const path of [undeclaredSameChain, undeclaredOtherChain, undeclaredRoot]) {
					expect(readProbe(path).exitCode, `${kind}/${resume.kind}: undeclared read ${path}`).not.toBe(0)
					expect(writeProbe(path).exitCode, `${kind}/${resume.kind}: undeclared write ${path}`).not.toBe(0)
				}
			}
		}
	})

	test("phase-scoped runner surfaces include only actually declared runtime binding paths", () => {
		const phase = makeOptions().preset.phases[0]!
		const declared = phaseDeclaredRuntimeBindingPaths({
			...phase,
			variables: [
				{ key: "EVIDENCE", source: { kind: "runtime", key: "evidenceDir" }, doc: null },
				{ key: "TRACE", source: { kind: "runtime", key: "traceFile" }, doc: null },
				{ key: "STATUS", source: { kind: "runtime", key: "statusVocabularyDoc" }, doc: null },
			],
		})
		expect(declared).toEqual(["evidenceDir", "logDir"])
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/root", agentCwd: "/repo", presetDir: "/preset", sharedContextPath: "/runtime/root/chains/c/shared.md",
			currentIssueFile: "/runtime/root/chains/c/issues/1.md", evidenceDir: "/runtime/root/chains/c/evidence/1", evidenceRootDir: "/runtime/root/chains/c/evidence",
			issueDir: "/runtime/root/chains/c/issues", logDir: "/runtime/root/chains/c/runs", daemonSocketPath: "/runtime/root/daemon.sock",
			declaredRuntimeBindingPaths: declared,
		})
		expect(authorization.surfaces).toContainEqual({ kind: "writable-directory", channel: "evidence", path: "/runtime/root/chains/c/evidence/1" })
		expect(authorization.surfaces).toContainEqual({ kind: "writable-directory", channel: "logs", path: "/runtime/root/chains/c/runs" })
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "shared-context" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "current-issue" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "issues" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "evidence-root" }))
	})

	test("runner authorization metadata cannot widen projections", () => {
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/root", agentCwd: "/repo", presetDir: "/preset", sharedContextPath: "/runtime/root/chains/c/shared.md",
			currentIssueFile: "", evidenceDir: "/runtime/root/chains/c/evidence/1", evidenceRootDir: "/runtime/root/chains/c/evidence",
			issueDir: "/runtime/root/chains/c/issues", logDir: "/runtime/root/chains/c/runs", daemonSocketPath: "/runtime/root/daemon.sock",
			declaredRuntimeBindingPaths: ["evidenceDir"],
		})
		const bypasses = [
			["--add-dir", "/runtime/root"], ["--add-dir=/runtime/root"], ["--sandbox", "danger-full-access"], ["--sandbox=danger-full-access"],
			["-s", "danger-full-access"], ["-sdanger-full-access"], ["--cd", "/runtime/root"], ["--cd=/runtime/root"], ["-C", "/runtime/root"], ["-C/runtime/root"],
			["--dir", "/runtime/root"], ["--dir=/runtime/root"], ["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"],
			["--dangerously-skip-permissions"], ["--dangerously-bypass-approvals-and-sandbox"],
		]
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				for (const extraArgs of bypasses) {
					expect(() => buildRunnerInvocation({ kind, binary: kind, extraArgs, model: null, source: "engine-builtin" }, "prompt", resume, authorization), `${kind}/${resume.kind}: ${extraArgs.join(" ")}`).toThrow("runner authorization metadata")
				}
			}
		}
	})

	test("runner projections reach the chain-complete spawn path for every runner and resume mode", async () => {
		const root = resolve(TEST_ROOT, "runner-chain-complete-projections")
		const options = makeOptions()
		const currentIssueFile = resolve(options.issueDir, "333.md")
		const unrelatedIssueFile = resolve(options.issueDir, "999.md")
		const evidenceDir = resolve(options.evidenceRootDir, "333")
		const unrelatedEvidenceDir = resolve(options.evidenceRootDir, "999")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				const capture = resolve(root, `${kind}-${resume.kind}.argv`)
				const runner = resolve(root, `${kind}-${resume.kind}.sh`)
				await writeFile(runner, `#!/bin/sh\nset -e\nprintf probe > /dev/null\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\n`)
				await chmod(runner, 0o755)
				const outputPath = resolve(root, `${kind}-${resume.kind}`, "phase", "stdout.jsonl")
				const outcome = await spawnOneAttempt({
					options, label: "phase", prompt: "projection-prompt", outputPath,
					sessionsPath: agentSessionsPath(outputPath), resume, agentCwd: root,
					runner: { kind, source: "preset", binary: runner, extraArgs: [], model: null }, watchdog: null,
					authorizationPaths: { currentIssueFile, evidenceDir },
					authorizationPhase: {
						variables: [
							{ key: "CURRENT_ISSUE", source: { kind: "runtime", key: "currentIssueFile" }, doc: null },
							{ key: "EVIDENCE", source: { kind: "runtime", key: "evidenceDir" }, doc: null },
						],
					},
				})
				expect(outcome.exitCode).toBe(0)
				const argv = await readFile(capture, "utf8")
				const authorization = await readFile(resolve(dirname(outputPath), "runner-authorization.json"), "utf8")
				expect(argv).toContain(resume.kind === "resume" ? `resume-${kind}` : "projection-prompt")
				expect(argv.split("\n")).not.toContain(TEST_ROOT)
				expect(authorization).toContain(`"channel":"current-issue","path":"${currentIssueFile}"`)
				expect(authorization).toContain(`"channel":"evidence","path":"${evidenceDir}"`)
				expect(authorization).not.toContain('"channel":"evidence-root"')
				expect(authorization).not.toContain('"path":"' + options.evidenceRootDir + '"')
				expect(authorization).not.toContain(unrelatedIssueFile)
				expect(authorization).not.toContain(unrelatedEvidenceDir)
				if (kind === "claude") {
					expect(argv).toContain(root)
					expect(argv).toContain(options.preset.presetDir)
					expect(argv).toContain(evidenceDir)
					expect(argv.split("\n")).not.toContain(options.evidenceRootDir)
					expect(argv).not.toContain(options.issueDir)
					expect(argv).not.toContain(options.logDir)
				}
				if (kind === "codex" && resume.kind === "fresh") {
					expect(argv).toContain(root)
					expect(argv).toContain(evidenceDir)
					expect(argv.split("\n")).not.toContain(options.evidenceRootDir)
					expect(argv).not.toContain(options.issueDir)
					expect(argv).not.toContain(options.logDir)
					expect(argv).not.toContain(options.preset.presetDir)
				}
			}
		}
		await rm(root, { recursive: true, force: true })
	})

	test("reports ordered chain-complete status persistence failure", async () => {
		const root = resolve(TEST_ROOT, "status-persistence-intermediate")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		const runner = resolve(root, "runner.sh")
		await writeFile(runner, "#!/bin/sh\necho intermediate\nsleep 0.05\necho 'FINALIZER SUMMARY: decision=complete; reason=test'\n")
		await chmod(runner, 0o755)
		const options = makeOptions()
		const failures: import("./loop").RunnerStatusPersistenceFailure[] = []
		options.onStatusPersistenceFailure = (failure) => failures.push(failure)
		let writes = 0
		const outputPath = resolve(root, "run-635", "umbrella-finalizer", "stdout.jsonl")
		await expect(spawnOneAttempt({
			options,
			label: "umbrella-finalizer",
			prompt: "test",
			outputPath,
			sessionsPath: resolve(root, "run-635", "umbrella-finalizer", "sessions.jsonl"),
			resume: { kind: "fresh" },
			agentCwd: root,
			runner: { kind: "claude", source: "preset", binary: runner, extraArgs: [], model: null },
			watchdog: null,
			statusWriter: async (path, payload) => {
				writes += 1
				if (writes === 2) {
					await rm(path, { force: true })
					await mkdir(path)
				}
				await writeFile(path, payload)
			},
		})).rejects.toThrow(/chain-complete status-artifact persistence failed/)
		expect(writes).toBe(2)
		expect(failures).toHaveLength(1)
		expect(failures[0]).toMatchObject({ path: "chain-complete", stage: "status-artifact", runId: "run-635", phase: "umbrella-finalizer" })
	})

	test("rejects successful chain-complete decision when terminal status persistence fails", async () => {
		const root = resolve(TEST_ROOT, "status-persistence-terminal")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		const runner = resolve(root, "runner.sh")
		await writeFile(runner, "#!/bin/sh\nprintf 'FINALIZER SUMMARY: decision=complete; reason=test'\n")
		await chmod(runner, 0o755)
		const options = makeOptions()
		let writes = 0
		const outputPath = resolve(root, "run-635-terminal", "umbrella-finalizer", "stdout.jsonl")
		await expect(spawnOneAttempt({
			options,
			label: "umbrella-finalizer",
			prompt: "test",
			outputPath,
			sessionsPath: resolve(root, "run-635-terminal", "umbrella-finalizer", "sessions.jsonl"),
			resume: { kind: "fresh" },
			agentCwd: root,
			runner: { kind: "claude", source: "preset", binary: runner, extraArgs: [], model: null },
			watchdog: null,
			statusWriter: async (path, payload) => {
				writes += 1
				if (writes === 3) {
					await rm(path, { force: true })
					await mkdir(path)
				}
				await writeFile(path, payload)
			},
		})).rejects.toThrow(/chain-complete status-artifact persistence failed/)
		expect(writes).toBe(3)
	})
	test("detects session id across streamed chunk boundaries", () => {
		const observed: { sessionId: string | null } = { sessionId: null }
		const state = createStreamTextState((line) => {
			observed.sessionId ??= parseSessionIdFromRunnerStream("codex", `${line}\n`)
		})
		for (const chunk of ["{\"type\":\"thread.star", "ted\",\"thread_", "id\":\"thread-streamed\"}\n"]) {
			state.observe(Buffer.from(chunk))
		}
		state.finish()
		expect(observed.sessionId).toBe("thread-streamed")
	})

	test("streams chain-complete runner output without retaining full history", () => {
		const observed: { finalizerSummary: string | null } = { finalizerSummary: null }
		const state = createStreamTextState((line) => {
			if (line.startsWith("FINALIZER SUMMARY:")) observed.finalizerSummary = line
		})
		const payload = Buffer.from(`${"runner output\n".repeat(200_000)}FINALIZER SUMMARY: decision=complete; reason=streamed\n`)
		for (let offset = 0; offset < payload.byteLength; offset += 8191) state.observe(payload.subarray(offset, offset + 8191))
		state.finish()
		expect(state.bytes()).toBe(payload.byteLength)
		expect(observed.finalizerSummary).toBe("FINALIZER SUMMARY: decision=complete; reason=streamed")
		expect(Object.keys(state).sort()).toEqual(["bytes", "finish", "observe", "pendingChars"])
	})

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

	test("detects chain-complete summary in a large valid runner event", () => {
		const watchdog = createSummaryWatchdog({
			config: { marker: "FINALIZER SUMMARY:", termMs: 1, killMs: 1 },
			setTimer: () => null,
			clearTimer: () => {},
			onTerm: () => {},
			onKill: () => {},
			log: () => {},
		})
		const observer = createSummaryWatchdogStdoutObserver("codex", "FINALIZER SUMMARY:", watchdog)
		const event = `${JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text: `${"x".repeat(1_000_001)}\nFINALIZER SUMMARY: decision=complete; reason=large-event` },
		})}\n`
		observer.observeStdout(Buffer.from(event))
		observer.finish()

		expect(observer.error()).toBeNull()
		expect(watchdog.state()).toEqual({ kind: "armed" })
	})

	test("preserves chain-complete summary verdict across event chunking", () => {
		const event = Buffer.from(`${JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text: `${"界".repeat(400_000)}\nFINALIZER SUMMARY: decision=keep-active; reason=chunk-invariant` },
		})}\n`)
		const observe = (chunkSizes: readonly number[]) => {
			const watchdog = createSummaryWatchdog({
				config: { marker: "FINALIZER SUMMARY:", termMs: 1, killMs: 1 },
				setTimer: () => null,
				clearTimer: () => {},
				onTerm: () => {},
				onKill: () => {},
				log: () => {},
			})
			const observer = createSummaryWatchdogStdoutObserver("codex", "FINALIZER SUMMARY:", watchdog)
			let offset = 0
			for (const size of chunkSizes) {
				observer.observeStdout(event.subarray(offset, offset + size))
				offset += size
			}
			if (offset < event.byteLength) observer.observeStdout(event.subarray(offset))
			observer.finish()
			return { state: watchdog.state(), error: observer.error() }
		}

		expect(observe([event.byteLength])).toEqual(observe([1, 2, 3, 8191, 65_537]))
		expect(observe([1, 1, 1, 1, 1, 1, 1])).toEqual({ state: { kind: "armed" }, error: null })
	})

	test("rejects invalid oversized chain-complete runner event explicitly", () => {
		const watchdog = createSummaryWatchdog({
			config: { marker: "FINALIZER SUMMARY:", termMs: 1, killMs: 1 },
			setTimer: () => null,
			clearTimer: () => {},
			onTerm: () => {},
			onKill: () => {},
			log: () => {},
		})
		const observer = createSummaryWatchdogStdoutObserver("codex", "FINALIZER SUMMARY:", watchdog)
		observer.observeStdout(Buffer.from(`{"type":"item.completed","padding":"${"x".repeat(1_000_001)}"\n`))
		observer.finish()

		expect(observer.error()).toMatchObject({
			kind: "invalid-runner-event",
			runner: "codex",
		})
		expect(observer.error()?.frameChars).toBeGreaterThan(1_000_000)
		expect(observer.error()?.message).toContain("invalid codex JSONL runner event")
		expect(watchdog.state()).toEqual({ kind: "idle" })
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
