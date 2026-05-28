import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import {
	agentCodexArgs,
	agentSessionsPath,
	buildConfigBindings,
	buildDaemonStartPlan,
	buildRuntimeBindings,
	CLAUDE_REVIEW_MODEL,
	decideResume,
	detectHostRunner,
	getItemId,
	makeIssueRunContext,
	normalizeQueueIssueId,
	parseKindFromLabels,
	parsePreset,
	parseReviewSummaryVerdict,
	parseSessionIdFromRunnerStream,
	renderFragmentIndex,
	renderPrompt,
	resolveBinding,
	reviewPhaseForPreset,
	selectRunnerForPhase,
	type ConfigBindings,
	type IssueRunContext,
	type JsonObject,
	type LoopOptions,
	type Preset,
	type PresetPhase,
	type ResolveContext,
	type RuntimeBindings,
	type StatusCurrentRunSnapshot,
} from "./loop"
import type { ItemRecord } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/loop-tests")

function makeItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
	return {
		id: overrides.id ?? 1,
		chainId: overrides.chainId ?? 10,
		issueNumber: overrides.issueNumber ?? 333,
		repoCwd: overrides.repoCwd ?? REPO_ROOT,
		status: overrides.status ?? "queued",
		attempts: overrides.attempts ?? 0,
		title: overrides.title ?? "test item",
		priority: overrides.priority ?? null,
		branch: overrides.branch ?? null,
		pr: overrides.pr ?? null,
		lastRunId: overrides.lastRunId ?? null,
		sessionIds: overrides.sessionIds ?? {},
		issueFile: overrides.issueFile ?? null,
		evidenceDir: overrides.evidenceDir ?? null,
		agentCwd: overrides.agentCwd ?? null,
		runner: overrides.runner ?? null,
		phase: overrides.phase ?? null,
		extra: overrides.extra ?? {},
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 1,
	}
}

function minimalPresetRoot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "fixture",
		version: Number("1"),
		item: { idField: "issue" },
		statuses: { continuable: ["queued", "changes_requested"], terminal: ["done", "blocked"] },
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
		agent: { binary: "claude" },
		...overrides,
	}
}

function makePreset(overrides: Record<string, unknown> = {}): Preset {
	return parsePreset(minimalPresetRoot(overrides), resolve(REPO_ROOT, "presets/fixture"))
}

function makeConfig(overrides: Partial<ConfigBindings> = {}): ConfigBindings {
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
		workflowPath: resolve(REPO_ROOT, ".coder-loop/workflow.md"),
		sharedContextPath: resolve(TEST_ROOT, "chains/fixture/shared.md"),
		currentIssueFile: resolve(TEST_ROOT, "chains/fixture/issues/333.md"),
		issueDir: resolve(TEST_ROOT, "chains/fixture/issues"),
		evidenceDir: resolve(TEST_ROOT, "chains/fixture/evidence/333"),
		evidenceRootDir: resolve(TEST_ROOT, "chains/fixture/evidence"),
		logDir: resolve(TEST_ROOT, "chains/fixture/runs"),
		presetDir: resolve(REPO_ROOT, "presets/fixture"),
		fragmentIndex: "- iter/index (iter): iter/index.md",
		runIdGeneration: "new",
		resumedFromPhase: "",
		resumedStartedAt: "",
		resumedSessionId: "",
		issueKind: "code",
		chainName: "fixture",
		chainUmbrellaRepo: "",
		chainUmbrellaIssue: "",
		chainBaseBranch: "main",
		repoCwd: REPO_ROOT,
		...overrides,
	}
}

function makeOptions(preset = makePreset()): LoopOptions {
	const claudeRunner = { kind: "claude" as const, binary: "claude", extraArgs: [], model: null }
	const codexRunner = { kind: "codex" as const, binary: "codex", extraArgs: [], model: null }
	return {
		targetCwd: REPO_ROOT,
		configPath: resolve(TEST_ROOT, "config.json"),
		workflowPath: resolve(REPO_ROOT, ".coder-loop/workflow.md"),
		sharedContextPath: resolve(TEST_ROOT, "shared.md"),
		stateDbPath: resolve(TEST_ROOT, "db.sqlite"),
		issueDir: resolve(TEST_ROOT, "issues"),
		evidenceRootDir: resolve(TEST_ROOT, "evidence"),
		logDir: resolve(TEST_ROOT, "runs"),
		loopDataRoot: TEST_ROOT,
		logFile: resolve(TEST_ROOT, "runs/test.log"),
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		chainName: "fixture",
		worktree: false,
		browserEvidenceRequired: false,
		hostRunner: "codex",
		defaultRunner: { ...codexRunner, source: "iteration-default" },
		reviewRunner: { ...claudeRunner, source: "review-default", model: CLAUDE_REVIEW_MODEL },
		runnerCommands: { claude: claudeRunner, codex: codexRunner },
		dryRun: false,
		preset,
	}
}

describe("ItemRecord prompt bindings", () => {
	test("getItemId reads issueNumber when the preset idField is issue", () => {
		const preset = makePreset()
		expect(getItemId(makeItem({ issueNumber: 333 }), preset)).toBe("333")
	})

	test("getItemId still honors explicit extra id fields", () => {
		const preset = makePreset({ item: { idField: "slug" } })
		expect(getItemId(makeItem({ extra: { slug: "custom-id" } }), preset)).toBe("custom-id")
	})

	test("renderPrompt resolves ItemRecord phase and nested sessionIds", () => {
		const phase: PresetPhase = {
			name: "iteration",
			prompt: "iteration.md",
			variables: [
				["ISSUE", { kind: "item", field: "issue" }],
				["PHASE", { kind: "item", field: "phase" }],
				["CODEX_SESSION", { kind: "item", field: "sessionIds.iteration.codex" }],
			],
			trigger: null,
		}
		const item = makeItem({
			issueNumber: 333,
			phase: "iteration",
			sessionIds: { iteration: { codex: "thread-123" } },
		})
		const ctx: ResolveContext = { item, config: makeConfig(), runtime: makeRuntime() }

		expect(renderPrompt("#{{ISSUE}} {{PHASE}} {{CODEX_SESSION}}", phase, ctx)).toBe("#333 iteration thread-123")
	})

	test("resolveBinding keeps old item.issue and config.requireBrowserEvidence compatibility", () => {
		const ctx: ResolveContext = {
			item: makeItem({ issueNumber: 184, branch: "issue-184", pr: 191 }),
			config: makeConfig({ requireBrowserEvidence: true }),
			runtime: makeRuntime(),
		}

		expect(resolveBinding({ kind: "item", field: "issue" }, ctx)).toBe("184")
		expect(resolveBinding({ kind: "item", field: "branch" }, ctx)).toBe("issue-184")
		expect(resolveBinding({ kind: "item", field: "pr" }, ctx)).toBe("191")
		expect(resolveBinding({ kind: "config", field: "requireBrowserEvidence" }, ctx)).toBe("true")
	})

	test("parsePreset accepts nested ItemRecord fields but rejects unknown roots", () => {
		const preset = makePreset({
			phases: [
				{ name: "iteration", prompt: "iteration.md", variables: { SESSION: "item.sessionIds.iteration.codex" } },
				{ name: "review", prompt: "review.md", variables: { PHASE: "item.phase" } },
			],
		})
		expect(preset.phases[0]?.variables[0]).toEqual(["SESSION", { kind: "item", field: "sessionIds.iteration.codex" }])

		expect(() =>
			makePreset({
				phases: [{ name: "iteration", prompt: "iteration.md", variables: { BAD: "item.notARecordField.value" } }],
			}),
		).toThrow(/unknown item field/)
	})
})

describe("runtime binding helpers", () => {
	test("buildConfigBindings reads repository, baseBranch, and browser evidence flag", () => {
		const options = makeOptions()
		const config = buildConfigBindings({ ...options, browserEvidenceRequired: true })
		expect(config.repository).toBe("mouriya-s-lab/coder-loop")
		expect(config.baseBranch).toBe("main")
		expect(config.requireBrowserEvidence).toBe(true)
	})

	test("buildRuntimeBindings maps issue run context into strings", () => {
		const options = makeOptions()
		const issueRun: IssueRunContext = {
			runIdGeneration: "resumed",
			resumedFromPhase: "iteration",
			resumedStartedAt: "2026-05-28T00:00:00Z",
			resumedSessionId: "thread-resume",
		}
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-333",
			currentIssueFile: "/repo/issues/333.md",
			evidenceDir: "/repo/evidence/333",
			agentCwd: REPO_ROOT,
			issueRun,
			issueKind: "code",
		})
		expect(runtime.runIdGeneration).toBe("resumed")
		expect(runtime.resumedFromPhase).toBe("iteration")
		expect(runtime.resumedSessionId).toBe("thread-resume")
		expect(runtime.issueKind).toBe("code")
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

	test("renderFragmentIndex enumerates preset fragments", () => {
		const preset = makePreset({ fragments: [{ id: "iter/index", role: "iter", path: "iter/index.md" }] })
		expect(renderFragmentIndex(preset)).toContain("- iter/index (iter):")
	})
})

describe("runner and daemon helpers", () => {
	test("selectRunnerForPhase uses review runner only for the preset review phase", () => {
		const preset = makePreset()
		const options = makeOptions(preset)
		const item = makeItem({ runner: "claude" })

		expect(selectRunnerForPhase("iteration", item, options).kind).toBe("claude")
		expect(selectRunnerForPhase(reviewPhaseForPreset(preset).name, item, options).kind).toBe("claude")
		expect(selectRunnerForPhase(reviewPhaseForPreset(preset).name, item, options).model).toBe(CLAUDE_REVIEW_MODEL)
	})

	test("buildDaemonStartPlan starts the central daemon without legacy loop flags", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const plan = buildDaemonStartPlan({
			action: "start",
			targetCwd: REPO_ROOT,
			configPath: null,
			loopDataRoot: TEST_ROOT,
			chainName: "fixture",
			repository: "mouriya-s-lab/coder-loop",
			browserEvidenceRequired: true,
			iterationLimit: null,
			dryRun: true,
			worktree: false,
			baseBranch: "main",
			json: false,
		})

		expect(plan.command).toEqual([process.argv[0] ?? "bun", resolve(import.meta.dir, "loop.ts"), "daemon", "up", "--loop-data-root", TEST_ROOT])
		expect(plan.commandLine).not.toContain("--target-cwd")
		expect(plan.commandLine).not.toContain("--max-iterations")
		expect(plan.browserEvidenceRequired).toBe(true)
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

	test("parseKindFromLabels recognizes the four issue kinds", () => {
		const code = parseKindFromLabels(["kind:code"])
		const comment = parseKindFromLabels(["kind:comment"])
		const spike = parseKindFromLabels(["kind:code-spike"])
		const blocked = parseKindFromLabels(["kind:blocked"])
		expect(code.ok && code.kind).toBe("code")
		expect(comment.ok && comment.kind).toBe("comment")
		expect(spike.ok && spike.kind).toBe("code-spike")
		expect(blocked.ok && blocked.kind).toBe("blocked")
	})

	test("runner stream parsers extract review verdicts and sessions", () => {
		expect(parseReviewSummaryVerdict("REVIEW SUMMARY: verdict=retry; issue=#333; reason=x")).toBe("retry")
		expect(parseSessionIdFromRunnerStream("claude", "{\"type\":\"system\",\"session_id\":\"sess-1\"}\n")).toBe("sess-1")
		expect(parseSessionIdFromRunnerStream("codex", "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}")).toBe("thread-1")
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
