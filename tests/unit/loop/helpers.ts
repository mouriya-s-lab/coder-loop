import { expect } from "bun:test"
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
} from "../../../src/loop"
import { parseInternalStatus, storedItemExtra } from "../../../src/runtime-data"
import type { ItemRecord } from "../../../src/sqlite-state"
import type { BoundaryRecord } from "../../../src/boundary-types"
import { createStreamTextState } from "../../../src/runner-output"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
export const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/loop-tests")

// #419: ItemRecord retired top-level `issueNumber` / `branch` / `pr`. Tests still want the
// legibility of passing those names — accept them as shim aliases and fold into `itemId` /
// `extra` for the actual record shape.
export type MakeItemOverrides = Omit<Partial<ItemRecord>, "extra"> & {
	extra?: JsonObject
	issueNumber?: number
	branch?: string | null
	pr?: number | null
}

export function itemSessionIdsToJsonObject(value: ItemRecord["sessionIds"]): JsonObject {
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

export function makeItem(overrides: MakeItemOverrides = {}): ItemRecord {
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

export function minimalPresetRoot(overrides: BoundaryRecord = {}): BoundaryRecord {
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

export function makePreset(overrides: BoundaryRecord = {}): Preset {
	return parsePreset(minimalPresetRoot(overrides), resolve(REPO_ROOT, "presets/fixture"))
}

export function makeChainBindings(overrides: Partial<RenderBindings> = {}): RenderBindings {
	return {
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		requireBrowserEvidence: false,
		...overrides,
	}
}

export function makeRuntime(overrides: Partial<RuntimeBindings> = {}): RuntimeBindings {
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

export function makeOptions(preset = makePreset()): LoopOptions {
	const claudeRunner = { kind: "claude" as const, binary: "claude", extraArgs: [], model: null }
	const codexRunner = { kind: "codex" as const, binary: "codex", extraArgs: [], model: null }
	const opencodeRunner = { kind: "opencode" as const, binary: "opencode", extraArgs: [], model: null }
	const hapiRunner = { kind: "hapi" as const, binary: "hapi-remote-session", extraArgs: [], model: null }
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
		runnerCommands: { claude: claudeRunner, codex: codexRunner, opencode: opencodeRunner, hapi: hapiRunner },
		dryRun: false,
		preset,
	}
}

export const ENGINE_RUNTIME_KEY_BLOCK_START = "<!-- engine-runtime-binding-keys:start -->"
export const ENGINE_RUNTIME_KEY_BLOCK_END = "<!-- engine-runtime-binding-keys:end -->"
export const ENGINE_RUNTIME_KEY_COUNT_PATTERN = /Engine runtime fact key count:\s*(\d+)/g

export function documentedEngineRuntimeBindingCount(markdown: string, label: string): number {
	const matches = [...markdown.matchAll(ENGINE_RUNTIME_KEY_COUNT_PATTERN)]
	expect(matches.length, `${label} should declare exactly one engine runtime binding key count`).toBe(1)
	const rawCount = matches[0]?.[1]
	expect(rawCount).toBeDefined()
	return Number(rawCount)
}

export function documentedEngineRuntimeBindingKeys(markdown: string): string[] {
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

export { chmod, mkdir, readFile, rm, writeFile, homedir, dirname, relative, resolve, agentCodexArgs, agentOpencodeArgs, buildRunnerFilesystemAuthorization, buildRunnerInvocation, agentSessionsPath, buildCentralRuntimeBindingPaths, buildRenderBindings, buildDaemonStartPlan, buildRuntimeBindings, phaseDeclaredRuntimeBindingPaths, decideResume, detectHostRunner, extractErrorCode, isTransient5xx, extractPromptPlaceholders, getItemId, makeIssueRunContext, normalizeQueueIssueId, parsePreset, parseSessionIdFromRunnerStream, renderFragmentIndex, renderPrompt, ENGINE_RUNTIME_BINDING_KEYS, stripRoleEntryFrontmatter, resolveBinding, selectRunnerForPhase, spawnOneAttempt, validatePresetPhaseTemplate, parseInternalStatus, storedItemExtra, createStreamTextState }
export type { RenderBindings, IssueRunContext, JsonObject, LoopOptions, Preset, PresetPhase, ResolveContext, RuntimeBindings, StatusCurrentRunSnapshot, ItemRecord, BoundaryRecord }

