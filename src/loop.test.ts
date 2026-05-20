import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import * as fs from "node:fs/promises"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"

import {
	agentClaudeArgs,
	agentCodexArgs,
	agentSessionsPath,
	appendLoopEvent,
	appendSessionEntry,
	BACKOFF_BUDGET_SECONDS,
	buildCoderLoopStatusSnapshot,
	buildConfigBindings,
	buildDaemonStartPlan,
	buildRuntimeBindings,
	buildRunnerInvocation,
	checkRuntime,
	CLAUDE_REVIEW_MODEL,
	classifyTermination,
	codexSummaryTextFromJsonLine,
	createSummaryWatchdog,
	createSummaryWatchdogStdoutObserver,
	decideResume,
	detectHostRunner,
	extractErrorCode,
	formatLoopEventLine,
	getCurrentId,
	getItemId,
	iterationRouteForIssueKind,
	isTransient5xx,
	LOOP_EVENT_TYPES,
	loadPreset,
	loopEventsPath,
	makeIssueRunContext,
	makeLoopEventEmitter,
	markIterationStarted,
	markReviewStarted,
	normalizeQueueIssueId,
	reconcileStateAfterIter,
	requeueBlockedItem,
	resolveIdleSleepMs,
	reviewOnEmptyLockPath,
	serializeReviewOnEmptyLock,
	serializeState,
	nextBackoffSeconds,
	parseKindFromLabels,
	parseCodexThreadIdFromStream,
	parseReviewSummaryVerdict,
	parseSessionIdFromRunnerStream,
	parseSessionIdFromStream,
	readLastSessionEntry,
	renderFragmentIndex,
	renderPrompt,
	resolveBinding,
	resolveIssueKind,
	resolvePresetDir,
	RESUME_CONTINUE_PROMPT,
	REVIEW_SUMMARY_WATCHDOG_MARKER,
	reviewPhaseForPreset,
	runAgentWithBackoff,
	selectIssue,
	spawnOneAttempt,
	SUMMARY_WATCHDOG_MARKER,
	summaryWatchdogConfigForPrompt,
	type AttemptOutcome,
	type ConfigBindings,
	type CurrentRun,
	type IssueRunContext,
	type LoopEvent,
	type LoopEventContext,
	type LoopOptions,
	type LoopState,
	type Preset,
	type QueueItem,
	type ResolveContext,
	type ResumeDecision,
	type RuntimeBindings,
	type SessionEntry,
	type SummaryWatchdogTimerHandle,
	type Terminated,
	worktreeBasePath,
	worktreePathForItem,
	validateWorktreePrerequisites,
	ensureWorktreeForItem,
	removeWorktreeForItem,
	cleanupStaleWorktrees,
} from "./loop"

const REPO_ROOT = resolve(import.meta.dir, "..")
const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

async function bundledPreset(): Promise<Preset> {
	return loadPreset(BUNDLED_PRESET_DIR)
}

function makeItem(overrides: Partial<QueueItem> & { issue: number; status: string }): QueueItem {
	return {
		status: overrides.status,
		attempts: overrides.attempts ?? 0,
		title: overrides.title ?? "test item",
		priority: overrides.priority ?? "medium",
		branch: overrides.branch ?? null,
		pr: overrides.pr ?? null,
		lastRunId: overrides.lastRunId ?? null,
		issueFile: overrides.issueFile ?? `.coder-loop/runtime/issues/${overrides.issue}.md`,
		evidenceDir: overrides.evidenceDir ?? `.coder-loop/runtime/evidence/${overrides.issue}`,
		agentCwd: overrides.agentCwd ?? null,
		runner: overrides.runner ?? null,
		extra: { issue: overrides.issue, ...(overrides.extra ?? {}) },
	}
}

function makeState(overrides: Partial<LoopState> & { queue: QueueItem[] }): LoopState {
	return {
		version: 1,
		repository: overrides.repository ?? "Mouriya-Emma/test",
		baseBranch: overrides.baseBranch ?? "main",
		recentRuns: overrides.recentRuns ?? [],
		queue: overrides.queue,
		current: overrides.current ?? null,
	}
}

async function makeFixtureOptions(preset: Preset): Promise<LoopOptions> {
	const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-test-"))
	const issueDir = resolve(cwd, ".coder-loop/runtime/issues")
	const evidenceRootDir = resolve(cwd, ".coder-loop/runtime/evidence")
	const logDir = resolve(cwd, ".coder-loop/runtime/logs")
	const runtimeDir = resolve(cwd, ".coder-loop/runtime")
	const configPath = resolve(runtimeDir, "config.json")
	const sharedContextPath = resolve(runtimeDir, "shared.md")
	const statePath = resolve(runtimeDir, "state.json")
	const workflowPath = resolve(cwd, ".coder-loop/workflow.md")
	await mkdir(issueDir, { recursive: true })
	await mkdir(evidenceRootDir, { recursive: true })
	await mkdir(logDir, { recursive: true })
	await mkdir(resolve(cwd, ".coder-loop"), { recursive: true })
	await writeFile(configPath, "{}")
	await writeFile(sharedContextPath, "")
	await writeFile(statePath, "{}")
	await writeFile(workflowPath, "")
	const claudeRunner = { kind: "claude" as const, binary: "claude", extraArgs: [], model: null }
	const codexRunner = { kind: "codex" as const, binary: "codex", extraArgs: [], model: null }
	return {
		targetCwd: cwd,
		configPath,
		workflowPath,
		sharedContextPath,
		statePath,
		issueDir,
		evidenceRootDir,
		logDir,
		loopFile: resolve(cwd, ".dev-loop"),
		traceFile: resolve(cwd, ".dev-trace.txt"),
		logFile: resolve(logDir, "test.log"),
		repository: "Mouriya-Emma/test",
		baseBranch: "main",
		worktree: false,
		requireBrowserEvidence: false,
		hostRunner: "claude",
		defaultRunner: { ...codexRunner, source: "iteration-default" as const },
		reviewRunner: { ...claudeRunner, source: "review-default" as const },
		runnerCommands: { claude: claudeRunner, codex: codexRunner },
		maxIterations: 1,
		dryRun: false,
		checkRuntime: false,
		preset,
	}
}

async function makeStatusTarget(presetName = "single-phase-example"): Promise<string> {
	const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-status-"))
	const runtimeDir = resolve(cwd, ".coder-loop/runtime")
	await mkdir(resolve(runtimeDir, "issues"), { recursive: true })
	await mkdir(resolve(runtimeDir, "evidence"), { recursive: true })
	await mkdir(resolve(runtimeDir, "logs"), { recursive: true })
	await writeFile(resolve(cwd, ".coder-loop/workflow.md"), "# workflow\n")
	await writeFile(resolve(runtimeDir, "shared.md"), "# shared\n")
	await writeFile(resolve(runtimeDir, "config.json"), JSON.stringify({ preset: presetName }, null, "\t"))
	await writeFile(
		resolve(runtimeDir, "state.json"),
		JSON.stringify({
			version: 1,
			queue: [
				{ id: "alpha", status: "pending", lastRunId: "run-alpha" },
				{ id: "beta", status: "done" },
			],
			recentRuns: ["preset-owned-note"],
			current: null,
		}, null, "\t"),
	)
	return cwd
}

async function withHostEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const keys = ["CODEX_SHELL", "CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAUDECODE", "CLAUDE_CODE", "CLAUDE_SESSION_ID", "CLAUDE_PROJECT_DIR"]
	const previous = new Map(keys.map((key) => [key, process.env[key]]))
	try {
		for (const key of keys) delete process.env[key]
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		return await fn()
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

describe("getItemId / getCurrentId", () => {
	test("getItemId reads preset.item.idField from a queue item (number → string)", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 131, status: "queued" })
		expect(getItemId(item, preset)).toBe("131")
	})

	test("getItemId throws when the id field is missing", async () => {
		const preset = await bundledPreset()
		const broken = makeItem({ issue: 1, status: "queued" })
		delete broken.extra.issue
		expect(() => getItemId(broken, preset)).toThrow()
	})

	test("getCurrentId reads preset.item.idField from state.current (number → string)", async () => {
		const preset = await bundledPreset()
		const current: CurrentRun = { phase: "iteration", runId: "r1", startedAt: new Date().toISOString(), extra: { issue: 42 } }
		expect(getCurrentId(current, preset)).toBe("42")
	})
})

describe("reserved strings registry", () => {
	test("docs list the current summary watchdog markers", async () => {
		const registry = await readFile(resolve(REPO_ROOT, "docs/reserved-strings.md"), "utf-8")

		expect(registry).toContain(SUMMARY_WATCHDOG_MARKER)
		expect(registry).toContain(REVIEW_SUMMARY_WATCHDOG_MARKER)
		expect(registry).toContain("SUMMARY_WATCHDOG_MARKER")
		expect(registry).toContain("REVIEW_SUMMARY_WATCHDOG_MARKER")
	})
})

describe("buildCoderLoopStatusSnapshot", () => {
	test("detectHostRunner defaults to Codex inside Codex env and Claude otherwise", () => {
		expect(detectHostRunner({ CODEX_SHELL: "1" })).toBe("codex")
		expect(detectHostRunner({ CODEX_THREAD_ID: "thread" })).toBe("codex")
		expect(detectHostRunner({ CLAUDECODE: "1" })).toBe("claude")
		expect(detectHostRunner({})).toBe("claude")
	})

	test("default iteration runner uses Codex when config omits runner", async () => {
		await withHostEnv({ CLAUDECODE: "1" }, async () => {
			const target = await makeStatusTarget()
			const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

			expect(snapshot.state.kind).toBe("ok")
			expect(snapshot.target.runner.hostDefault).toBe("claude")
			expect(snapshot.target.runner.default).toEqual({
				kind: "codex",
				source: "iteration-default",
				binary: "codex",
				extraArgs: [],
				model: null,
			})
			expect(snapshot.queue.selected?.runner).toEqual(snapshot.target.runner.default)
		})
	})

	test("returns a read-only ok snapshot with target/state/queue/current/events/processes", async () => {
		const target = await makeStatusTarget()
		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.target.cwd).toBe(target)
		expect(snapshot.target.config.kind).toBe("loaded")
		expect(snapshot.target.preset?.name).toBe("single-phase-example")
		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.state.ok).toBe(true)
		expect(snapshot.state.loaded).toBe(true)
		expect(snapshot.queue.selected?.item.lastRunId).toBe("run-alpha")
		expect(snapshot.queue.total).toBe(2)
		expect(snapshot.queue.byStatus.pending).toBe(1)
		expect(snapshot.queue.byStatus.done).toBe(1)
		expect(snapshot.queue.continuable).toBe(1)
		expect(snapshot.queue.terminal).toBe(1)
		expect(snapshot.queue.selected?.id).toBe("alpha")
		expect(snapshot.queue.selected?.runner.kind).toBe(snapshot.target.runner.default.kind)
		expect(snapshot.target.runner.reviewDefault).toEqual({
			kind: "claude",
			source: "review-default",
			binary: "claude",
			extraArgs: [],
			model: "claude-opus-4-7",
		})
		expect(snapshot.queue.selected?.reviewRunner).toEqual(snapshot.target.runner.reviewDefault)
		expect(snapshot.current.run).toBeNull()
		expect(snapshot.events.runId).toBe("run-alpha")
		expect(snapshot.processes.loopFile.exists).toBe(false)
	})

	test("configured iteration runner still overrides default", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "claude",
				claude: { binary: "/tmp/fake-claude", extraArgs: ["--max-turns", "3"], model: "sonnet" },
			}, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.target.runner.default).toEqual({
			kind: "claude",
			source: "config",
			binary: "/tmp/fake-claude",
			extraArgs: ["--max-turns", "3"],
			model: "sonnet",
		})
		expect(snapshot.queue.selected?.runner).toEqual(snapshot.target.runner.default)
		expect(snapshot.queue.selected?.reviewRunner).toEqual(snapshot.target.runner.reviewDefault)
		expect(snapshot.target.runner.reviewDefault.kind).toBe("claude")
	})

	test("config reviewRunner overrides the Claude review default in status JSON", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "claude",
				reviewRunner: "codex",
				codex: { binary: "/tmp/fake-codex-review", extraArgs: ["--json"], model: "gpt-5.4-high" },
			}, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.target.runner.default.kind).toBe("claude")
		expect(snapshot.target.runner.reviewDefault).toEqual({
			kind: "codex",
			source: "config",
			binary: "/tmp/fake-codex-review",
			extraArgs: ["--json"],
			model: "gpt-5.4-high",
		})
		expect(snapshot.queue.selected?.reviewRunner).toEqual(snapshot.target.runner.reviewDefault)
	})

	test("runner model config is exposed while Claude review model is forced", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "claude",
				reviewRunner: "claude",
				claude: { binary: "/tmp/fake-claude", extraArgs: ["--model", "sonnet"], model: "sonnet" },
			}, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.target.runner.default).toEqual({
			kind: "claude",
			source: "config",
			binary: "/tmp/fake-claude",
			extraArgs: ["--model", "sonnet"],
			model: "sonnet",
		})
		expect(snapshot.target.runner.reviewDefault).toEqual({
			kind: "claude",
			source: "config",
			binary: "/tmp/fake-claude",
			extraArgs: ["--model", "sonnet"],
			model: CLAUDE_REVIEW_MODEL,
		})
		expect(snapshot.queue.selected?.runner.model).toBe("sonnet")
		expect(snapshot.queue.selected?.reviewRunner.model).toBe(CLAUDE_REVIEW_MODEL)
	})

	test("queue item runner still overrides default iteration runner", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "codex",
				claude: { binary: "/tmp/fake-claude", extraArgs: ["--max-turns", "3"] },
			}, null, "\t"),
		)
		await writeFile(
			resolve(target, ".coder-loop/runtime/state.json"),
			JSON.stringify({
				version: 1,
				queue: [
					{ id: "alpha", status: "pending", runner: "claude" },
					{ id: "beta", status: "done" },
				],
				recentRuns: [],
				current: null,
			}, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.target.runner.default.kind).toBe("codex")
		expect(snapshot.queue.selected?.runner).toEqual({
			kind: "claude",
			source: "queue",
			binary: "/tmp/fake-claude",
			extraArgs: ["--max-turns", "3"],
			model: null,
		})
		expect(snapshot.queue.selected?.reviewRunner).toEqual(snapshot.target.runner.reviewDefault)
		expect(snapshot.queue.selected?.reviewRunner.kind).toBe("claude")
	})

	test("invalid config runner is reported as an invalid-config status snapshot", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({ preset: "single-phase-example", runner: "ollama" }, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("invalid-config")
		expect(snapshot.state.ok).toBe(false)
		expect(snapshot.state.errors[0]?.path).toBe("config")
		expect(snapshot.state.errors[0]?.message).toContain("runner")
	})

	test("invalid config reviewRunner is reported as an invalid-config status snapshot", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({ preset: "single-phase-example", reviewRunner: "ollama" }, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("invalid-config")
		expect(snapshot.state.ok).toBe(false)
		expect(snapshot.state.errors[0]?.path).toBe("config")
		expect(snapshot.state.errors[0]?.message).toContain("reviewRunner")
	})

	test("invalid queue item runner is reported as an invalid-state status snapshot", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/state.json"),
			JSON.stringify({
				version: 1,
				queue: [{ id: "alpha", status: "pending", runner: "ollama" }],
				recentRuns: [],
				current: null,
			}, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("invalid-state")
		expect(snapshot.state.ok).toBe(false)
		expect(snapshot.state.errors[0]?.message).toContain("runner")
	})

	test("distinguishes missing state from missing or invalid config", async () => {
		const target = await makeStatusTarget()
		await fs.rm(resolve(target, ".coder-loop/runtime/state.json"))

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.target.config.kind).toBe("loaded")
		expect(snapshot.state.kind).toBe("missing-state")
		expect(snapshot.state.ok).toBe(false)
		expect(snapshot.state.loaded).toBe(false)
		expect(snapshot.state.errors[0]?.path).toBe("state")
	})

	test("reports runtime validation errors without hiding the loaded queue", async () => {
		const target = await makeStatusTarget()
		await writeFile(
			resolve(target, ".coder-loop/runtime/state.json"),
			JSON.stringify({ version: 1, queue: [{ id: "alpha", status: "garbage" }], recentRuns: [], current: null }, null, "\t"),
		)

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })

		expect(snapshot.state.kind).toBe("invalid-runtime")
		expect(snapshot.state.loaded).toBe(true)
		expect(snapshot.queue.total).toBe(1)
		expect(snapshot.state.errors.some((error) => error.path.endsWith(".status") && error.message.includes("garbage"))).toBe(true)
	})
})

describe("buildDaemonStartPlan", () => {
	test("renders the detached loop command with --require-browser-evidence when requested", async () => {
		const target = await makeStatusTarget()
		const plan = buildDaemonStartPlan({
			action: "start",
			targetCwd: target,
			configPath: null,
			repository: "Mouriya-Emma/coder-loop-fixture",
			requireBrowserEvidence: true,
			maxIterations: 10,
			dryRun: true,
			worktree: false,
			baseBranch: null,
		})

		expect(plan.targetCwd).toBe(target)
		expect(plan.command).toContain("--target-cwd")
		expect(plan.command).toContain(target)
		expect(plan.command).toContain("--repo")
		expect(plan.command).toContain("Mouriya-Emma/coder-loop-fixture")
		expect(plan.command).toContain("--require-browser-evidence")
		expect(plan.command).toContain("10")
		expect(plan.commandLine).toContain("--require-browser-evidence")
		expect(plan.requireBrowserEvidence).toBe(true)
	})
})

describe("selectIssue", () => {
	test("prefers state.current's item if its status is in preset.statuses.continuable", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [
				makeItem({ issue: 100, status: "queued" }),
				makeItem({ issue: 200, status: "in_progress" }),
			],
			current: { phase: "iteration", runId: "r1", startedAt: new Date().toISOString(), extra: { issue: 200 } },
		})
		const selected = selectIssue(state, options)
		expect(selected).not.toBeNull()
		expect(getItemId(selected!.item, preset)).toBe("200")
	})

	test("falls back to first continuable item when state.current is null", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [
				makeItem({ issue: 100, status: "done" }),
				makeItem({ issue: 200, status: "blocked" }),
				makeItem({ issue: 300, status: "queued" }),
			],
		})
		const selected = selectIssue(state, options)
		expect(selected).not.toBeNull()
		expect(getItemId(selected!.item, preset)).toBe("300")
	})

	test("returns null when no item has continuable status", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [
				makeItem({ issue: 100, status: "done" }),
				makeItem({ issue: 200, status: "blocked" }),
			],
		})
		expect(selectIssue(state, options)).toBeNull()
	})

	test("treats changes_requested as continuable (matches preset)", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 7, status: "changes_requested" })],
		})
		const selected = selectIssue(state, options)
		expect(selected).not.toBeNull()
		expect(getItemId(selected!.item, preset)).toBe("7")
	})

	test("agentCwd defaults to options.targetCwd when the queue item omits it", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 11, status: "queued" })],
		})
		const selected = selectIssue(state, options)
		expect(selected).not.toBeNull()
		expect(selected!.agentCwd).toBe(options.targetCwd)
	})

	test("agentCwd echoes the queue item's absolute agentCwd when set (cross-repo iteration)", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 12, status: "queued", agentCwd: "/abs/other-repo" })],
		})
		const selected = selectIssue(state, options)
		expect(selected).not.toBeNull()
		expect(selected!.agentCwd).toBe("/abs/other-repo")
	})

})

describe("markIterationStarted / markReviewStarted", () => {
	test("markIterationStarted preserves queue item status, increments attempts when fresh, writes state.current.phase to first phase", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 55, status: "queued", attempts: 0 })
		const state = makeState({ queue: [item] })
		markIterationStarted(state, item, preset, "run-X", true)
		expect(state.queue[0]!.status).toBe("queued")
		expect(state.queue[0]!.attempts).toBe(1)
		expect(state.queue[0]!.lastRunId).toBe("run-X")
		expect(state.current).not.toBeNull()
		expect(state.current!.phase).toBe(preset.phases[0]!.name)
		expect(state.current!.runId).toBe("run-X")
		expect(state.current!.extra[preset.item.idField]).toBe(55)
	})

	test("markIterationStarted preserves changes_requested status on retry", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 55, status: "changes_requested", attempts: 2, lastRunId: "run-prev" })
		const state = makeState({ queue: [item] })
		markIterationStarted(state, item, preset, "run-X", true)
		expect(state.queue[0]!.status).toBe("changes_requested")
		expect(state.queue[0]!.attempts).toBe(3)
		expect(state.queue[0]!.lastRunId).toBe("run-X")
	})

	test("markIterationStarted does not increment attempts when countAttempt=false (resume)", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 55, status: "queued", attempts: 3 })
		const state = makeState({ queue: [item] })
		markIterationStarted(state, item, preset, "run-Y", false)
		expect(state.queue[0]!.attempts).toBe(3)
		expect(state.queue[0]!.lastRunId).toBe("run-Y")
	})

	test("markReviewStarted writes state.current.phase to review phase, preserving id field type", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 99, status: "queued" })
		const state = makeState({ queue: [item] })
		markReviewStarted(state, item, preset, "run-Z")
		expect(state.current).not.toBeNull()
		expect(state.current!.phase).toBe(reviewPhaseForPreset(preset).name)
		expect(state.current!.runId).toBe("run-Z")
		expect(state.current!.extra[preset.item.idField]).toBe(99)
	})
})

describe("reconcileStateAfterIter — recovers state.json wiped or reverted by iter's git ops (issue #67)", () => {
	async function setupSnapshot(): Promise<{ statePath: string; snapshot: string; runtimeDir: string }> {
		const cwd = await mkdtemp(resolve(tmpdir(), "coder-loop-reconcile-"))
		const runtimeDir = resolve(cwd, ".coder-loop/runtime")
		await mkdir(runtimeDir, { recursive: true })
		const statePath = resolve(runtimeDir, "state.json")
		const state: LoopState = {
			version: 1,
			repository: "Mouriya-Emma/test",
			baseBranch: "main",
			recentRuns: [],
			queue: [
				{
					status: "queued",
					attempts: 1,
					title: "t",
					priority: "medium",
					branch: null,
					pr: null,
					lastRunId: "run-A",
					issueFile: ".coder-loop/runtime/issues/1.md",
					evidenceDir: ".coder-loop/runtime/evidence/1",
					agentCwd: null,
					runner: null,
					extra: { issue: 1 },
				},
			],
			current: { phase: "iteration", runId: "run-A", startedAt: "2026-01-01T00:00:00Z", extra: { issue: 1 } },
		}
		const snapshot = serializeState(state)
		await writeFile(statePath, snapshot)
		return { statePath, snapshot, runtimeDir }
	}

	test("no-op when on-disk state.json matches the in-memory snapshot", async () => {
		const { statePath, snapshot } = await setupSnapshot()
		const logs: string[] = []
		const outcome = await reconcileStateAfterIter(statePath, snapshot, (m) => logs.push(m))
		expect(outcome.restored).toBe(false)
		expect(logs).toEqual([])
		expect(await readFile(statePath, "utf-8")).toBe(snapshot)
	})

	test("restores from snapshot when iter wiped state.json (git merge deleted the tracked file)", async () => {
		const { statePath, snapshot } = await setupSnapshot()
		await fs.rm(statePath)
		const logs: string[] = []
		const outcome = await reconcileStateAfterIter(statePath, snapshot, (m) => logs.push(m))
		expect(outcome).toEqual({ restored: true, reason: "missing" })
		expect(await readFile(statePath, "utf-8")).toBe(snapshot)
		expect(logs.length).toBe(1)
		expect(logs[0]).toMatch(/missing after iteration/)
	})

	test("restores from snapshot when iter reverted state.json content (git reset --hard to broken bootstrap)", async () => {
		const { statePath, snapshot } = await setupSnapshot()
		await writeFile(statePath, '{ "queue": [238] }\n')
		const logs: string[] = []
		const outcome = await reconcileStateAfterIter(statePath, snapshot, (m) => logs.push(m))
		expect(outcome).toEqual({ restored: true, reason: "modified" })
		expect(await readFile(statePath, "utf-8")).toBe(snapshot)
		expect(logs.length).toBe(1)
		expect(logs[0]).toMatch(/modified during iteration/)
	})

	test("recreates parent runtime directory if iter removed it entirely", async () => {
		const { statePath, snapshot, runtimeDir } = await setupSnapshot()
		await fs.rm(runtimeDir, { recursive: true })
		const logs: string[] = []
		const outcome = await reconcileStateAfterIter(statePath, snapshot, (m) => logs.push(m))
		expect(outcome).toEqual({ restored: true, reason: "missing" })
		expect(await readFile(statePath, "utf-8")).toBe(snapshot)
	})
})

describe("review-on-empty lock helpers (issue #69)", () => {
	test("reviewOnEmptyLockPath derives a sibling of state.json named review-on-empty.lock", () => {
		const lockPath = reviewOnEmptyLockPath("/tmp/foo/.coder-loop/runtime/state.json")
		expect(lockPath).toBe("/tmp/foo/.coder-loop/runtime/review-on-empty.lock")
	})

	test("reviewOnEmptyLockPath handles arbitrary state.json locations (no .coder-loop assumption)", () => {
		const lockPath = reviewOnEmptyLockPath("/var/lib/cl/state.json")
		expect(lockPath).toBe("/var/lib/cl/review-on-empty.lock")
	})

	test("serializeReviewOnEmptyLock writes acquiredAt / runId / reason as JSON with trailing newline", () => {
		const payload = serializeReviewOnEmptyLock("run-2026-05-14-10-00-00-no-issue", new Date("2026-05-14T10:00:01.234Z"))
		expect(payload.endsWith("\n")).toBe(true)
		const parsed = JSON.parse(payload)
		expect(parsed).toEqual({
			acquiredAt: "2026-05-14T10:00:01.234Z",
			runId: "run-2026-05-14-10-00-00-no-issue",
			reason: "queue-drained",
		})
	})
})

describe("resolveIdleSleepMs — env override for idle sleep (issue #69)", () => {
	test("defaults to 60000ms when CODER_LOOP_IDLE_SLEEP_MS is unset", () => {
		expect(resolveIdleSleepMs({})).toBe(60_000)
	})

	test("honors CODER_LOOP_IDLE_SLEEP_MS when set to a non-negative number", () => {
		expect(resolveIdleSleepMs({ CODER_LOOP_IDLE_SLEEP_MS: "150" })).toBe(150)
		expect(resolveIdleSleepMs({ CODER_LOOP_IDLE_SLEEP_MS: "0" })).toBe(0)
	})

	test("treats empty string as unset and falls back to default", () => {
		expect(resolveIdleSleepMs({ CODER_LOOP_IDLE_SLEEP_MS: "" })).toBe(60_000)
	})

	test("rejects negative or non-numeric values", () => {
		expect(() => resolveIdleSleepMs({ CODER_LOOP_IDLE_SLEEP_MS: "-1" })).toThrow(/CODER_LOOP_IDLE_SLEEP_MS/)
		expect(() => resolveIdleSleepMs({ CODER_LOOP_IDLE_SLEEP_MS: "abc" })).toThrow(/CODER_LOOP_IDLE_SLEEP_MS/)
	})
})

describe("makeIssueRunContext", () => {
	test("runIdGeneration=new when no current run, regardless of item status", async () => {
		const ctx = makeIssueRunContext(null)
		expect(ctx.runIdGeneration).toBe("new")
		expect(ctx.resumedFromPhase).toBeNull()
		expect(ctx.resumedStartedAt).toBeNull()
	})

	test("runIdGeneration=resumed exposes current.phase and current.startedAt", async () => {
		const preset = await bundledPreset()
		const current: CurrentRun = {
			phase: preset.phases[0]!.name,
			runId: "run-resume",
			startedAt: "2026-01-01T00:00:00Z",
			extra: { issue: 1 },
		}
		const ctx = makeIssueRunContext(current)
		expect(ctx.runIdGeneration).toBe("resumed")
		expect(ctx.resumedFromPhase).toBe(preset.phases[0]!.name)
		expect(ctx.resumedStartedAt).toBe("2026-01-01T00:00:00Z")
	})

	test("runIdGeneration=resumed when current.phase is the last phase exposes that phase verbatim", async () => {
		const preset = await bundledPreset()
		const last = preset.phases[preset.phases.length - 1]!.name
		const current: CurrentRun = {
			phase: last,
			runId: "run-resume",
			startedAt: "2026-01-01T00:00:00Z",
			extra: { issue: 1 },
		}
		const ctx = makeIssueRunContext(current)
		expect(ctx.runIdGeneration).toBe("resumed")
		expect(ctx.resumedFromPhase).toBe(last)
	})
})

describe("checkRuntime preset-driven validation", () => {
	test("queue item with status not in preset.statuses produces an error mentioning the status", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 1, status: "garbage" })],
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path.endsWith(".status") && e.message.includes("garbage"))).toBe(true)
	})

	test("state.current.phase not declared in preset.phases produces an error mentioning the phase", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 1, status: "queued" })],
			current: { phase: "garbage", runId: "r", startedAt: "2026-01-01T00:00:00Z", extra: { issue: 1 } },
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "state.current.phase" && e.message.includes("garbage"))).toBe(true)
	})

	test("queue item missing the id field declared by preset.item.idField produces an error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const broken = makeItem({ issue: 1, status: "queued" })
		delete broken.extra.issue
		const state = makeState({ queue: [broken] })
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === `state.queue[0].${preset.item.idField}`)).toBe(true)
	})

	test("two queue items sharing the same id produce a duplicate error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [
				makeItem({ issue: 1, status: "queued" }),
				makeItem({ issue: 1, status: "in_progress" }),
			],
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.message.includes("duplicate id"))).toBe(true)
	})

	test("queue item with a relative agentCwd produces an absolute-path error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 21, status: "queued", agentCwd: "relative/repo" })],
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "state.queue[0].agentCwd" && /absolute/.test(e.message))).toBe(true)
	})

	test("queue item with an agentCwd pointing at a missing directory produces a not-a-directory error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const state = makeState({
			queue: [makeItem({ issue: 22, status: "queued", agentCwd: "/abs/does-not-exist-coder-loop-test" })],
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "state.queue[0].agentCwd")).toBe(true)
	})

	test("queue item with an existing absolute agentCwd directory passes (cross-repo case)", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const otherRepo = await mkdtemp(resolve(tmpdir(), "coder-loop-otherrepo-"))
		const state = makeState({
			queue: [makeItem({ issue: 23, status: "queued", agentCwd: otherRepo })],
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "state.queue[0].agentCwd")).toBe(false)
	})
})

function makeFixtureRuntime(overrides: Partial<RuntimeBindings> = {}): RuntimeBindings {
	return {
		runId: "run-fixture",
		targetCwd: "/tmp/fixture-cwd",
		agentCwd: "/tmp/fixture-cwd",
		workflowPath: "/tmp/fixture-cwd/.coder-loop/workflow.md",
		sharedContextPath: "/tmp/fixture-cwd/.coder-loop/runtime/shared.md",
		statePath: "/tmp/fixture-cwd/.coder-loop/runtime/state.json",
		currentIssueFile: "/tmp/fixture-cwd/.coder-loop/runtime/issues/131.md",
		issueDir: "/tmp/fixture-cwd/.coder-loop/runtime/issues",
		evidenceDir: "/tmp/fixture-cwd/.coder-loop/runtime/evidence/131",
		evidenceRootDir: "/tmp/fixture-cwd/.coder-loop/runtime/evidence",
		logDir: "/tmp/fixture-cwd/.coder-loop/runtime/logs",
		traceFile: "/tmp/fixture-cwd/.dev-trace.txt",
		loopFile: "/tmp/fixture-cwd/.dev-loop",
		presetDir: "/tmp/fixture-preset",
		fragmentIndex: "- f1 (common): /tmp/fixture-preset/f1.md",
		runIdGeneration: "new",
		resumedFromPhase: "",
		resumedStartedAt: "",
		issueKind: "",
		...overrides,
	}
}

function makeFixtureConfig(overrides: Partial<ConfigBindings> = {}): ConfigBindings {
	return {
		repository: "Mouriya-Emma/test",
		baseBranch: "main",
		requireBrowserEvidence: false,
		...overrides,
	}
}

describe("resolveBinding", () => {
	test("item.<f> reads from ctx.item and stringifies number / string / boolean", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 131, status: "queued", branch: "feature/x", pr: 42 })
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(resolveBinding({ kind: "item", field: "issue" }, ctx)).toBe("131")
		expect(resolveBinding({ kind: "item", field: "status" }, ctx)).toBe("queued")
		expect(resolveBinding({ kind: "item", field: "branch" }, ctx)).toBe("feature/x")
		expect(resolveBinding({ kind: "item", field: "pr" }, ctx)).toBe("42")
		expect(preset.item.idField).toBe("issue")
	})

	test("item.<f> returns empty string for null / undefined", async () => {
		const item = makeItem({ issue: 1, status: "queued", branch: null, pr: null })
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(resolveBinding({ kind: "item", field: "branch" }, ctx)).toBe("")
		expect(resolveBinding({ kind: "item", field: "pr" }, ctx)).toBe("")
		expect(resolveBinding({ kind: "item", field: "missingField" }, ctx)).toBe("")
	})

	test("config.<f> reads from ctx.config and stringifies boolean", () => {
		const item = makeItem({ issue: 1, status: "queued" })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig({ requireBrowserEvidence: true }),
			runtime: makeFixtureRuntime(),
		}
		expect(resolveBinding({ kind: "config", field: "repository" }, ctx)).toBe("Mouriya-Emma/test")
		expect(resolveBinding({ kind: "config", field: "baseBranch" }, ctx)).toBe("main")
		expect(resolveBinding({ kind: "config", field: "requireBrowserEvidence" }, ctx)).toBe("true")
	})

	test("config.<f> with unknown field throws", () => {
		const item = makeItem({ issue: 1, status: "queued" })
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(() => resolveBinding({ kind: "config", field: "noSuchField" }, ctx)).toThrow(/config\.noSuchField/)
	})

	test("runtime.<k> reads from ctx.runtime when key is in whitelist", () => {
		const item = makeItem({ issue: 1, status: "queued" })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig(),
			runtime: makeFixtureRuntime({ runId: "run-special" }),
		}
		expect(resolveBinding({ kind: "runtime", key: "runId" }, ctx)).toBe("run-special")
		expect(resolveBinding({ kind: "runtime", key: "presetDir" }, ctx)).toBe("/tmp/fixture-preset")
	})

	test("runtime.<k> with unknown key throws (whitelist enforced)", () => {
		const item = makeItem({ issue: 1, status: "queued" })
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(() => resolveBinding({ kind: "runtime", key: "notWhitelisted" }, ctx)).toThrow(/runtime\.notWhitelisted/)
	})

	test("item.<f> with non-stringifiable value (e.g. nested object) throws", () => {
		const item = makeItem({ issue: 1, status: "queued" })
		item.extra.weird = { nested: true }
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(() => resolveBinding({ kind: "item", field: "weird" }, ctx)).toThrow(/item\.weird/)
	})

})

describe("renderPrompt with bundled preset", () => {
	test("substitutes all KEY placeholders in a synthetic template (byte-equal expected output)", async () => {
		const preset = await bundledPreset()
		const phase = preset.phases[0]!
		const item = makeItem({
			issue: 131,
			status: "changes_requested",
			branch: "feature/test",
			pr: 99,
			lastRunId: "run-prev",
		})
		const runtime = makeFixtureRuntime({
			runId: "run-2026-05-10-12-00-00-issue-131",
			fragmentIndex: "- frag1 (common): /tmp/fixture-preset/frag1.md\n- frag2 (review): /tmp/fixture-preset/frag2.md",
			runIdGeneration: "resumed",
			resumedFromPhase: preset.phases[0]!.name,
			resumedStartedAt: "2026-05-10T11:50:00Z",
			issueKind: "code",
		})
		const config = makeFixtureConfig({ requireBrowserEvidence: true })
		const ctx: ResolveContext = { item, config, runtime }

		const keys = phase.variables.map(([k]) => k)
		const template = keys.map((k) => `${k}={{${k}}}`).join("\n")
		const rendered = renderPrompt(template, phase, ctx)

		const expectedLines: string[] = [
			`TARGET_CWD=${runtime.targetCwd}`,
			`AGENT_CWD=${runtime.agentCwd}`,
			`REPO=${config.repository}`,
			`BASE_BRANCH=${config.baseBranch}`,
			`RUN_ID=${runtime.runId}`,
			`ISSUE=${item.extra.issue}`,
			`WORKFLOW_FILE=${runtime.workflowPath}`,
			`SHARED_CONTEXT_FILE=${runtime.sharedContextPath}`,
			`STATE_FILE=${runtime.statePath}`,
			`CURRENT_ISSUE_FILE=${runtime.currentIssueFile}`,
			`ISSUE_DIR=${runtime.issueDir}`,
			`EVIDENCE_DIR=${runtime.evidenceDir}`,
			`EVIDENCE_ROOT_DIR=${runtime.evidenceRootDir}`,
			`LOG_DIR=${runtime.logDir}`,
			`TRACE_FILE=${runtime.traceFile}`,
			`LOOP_FILE=${runtime.loopFile}`,
			`PROMPT_ROOT=${runtime.presetDir}`,
			`PROMPT_FRAGMENT_INDEX=${runtime.fragmentIndex}`,
			`REQUIRE_BROWSER_EVIDENCE=${String(config.requireBrowserEvidence)}`,
			`RUN_ID_GENERATION=${runtime.runIdGeneration}`,
			`RESUMED_FROM_PHASE=${runtime.resumedFromPhase}`,
			`RESUMED_STARTED_AT=${runtime.resumedStartedAt}`,
			`ISSUE_BRANCH=${item.branch}`,
			`ISSUE_PR=${item.pr}`,
			`ISSUE_STATUS=${item.status}`,
			`ISSUE_LAST_RUN_ID=${item.lastRunId}`,
			`ISSUE_KIND=${runtime.issueKind}`,
		]
		expect(rendered).toBe(expectedLines.join("\n"))
	})

	test("null item.branch / item.pr → empty string in rendered output", async () => {
		const preset = await bundledPreset()
		const phase = preset.phases[0]!
		const item = makeItem({ issue: 1, status: "queued", branch: null, pr: null })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig(),
			runtime: makeFixtureRuntime(),
		}
		const rendered = renderPrompt("branch=[{{ISSUE_BRANCH}}] pr=[{{ISSUE_PR}}]", phase, ctx)
		expect(rendered).toBe("branch=[] pr=[]")
	})

	test("smoke: render real iter-entry.md leaves no {{[A-Z_]+}} placeholders", async () => {
		const preset = await bundledPreset()
		const phase = preset.phases[0]!
		const item = makeItem({ issue: 131, status: "queued", branch: null, pr: null })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig(),
			runtime: makeFixtureRuntime(),
		}
		const template = await readFile(phase.prompt, "utf-8")
		const rendered = renderPrompt(template, phase, ctx)
		const leftover = rendered.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g)
		expect(leftover).toBeNull()
	})

	test("smoke: render real review-entry.md leaves no {{[A-Z_]+}} placeholders", async () => {
		const preset = await bundledPreset()
		const phase = preset.phases[preset.phases.length - 1]!
		const item = makeItem({ issue: 131, status: "queued", branch: "feature/x", pr: 99, lastRunId: "run-prev" })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig(),
			runtime: makeFixtureRuntime({ runIdGeneration: "resumed", resumedFromPhase: phase.name, resumedStartedAt: "2026-05-10T11:50:00Z" }),
		}
		const template = await readFile(phase.prompt, "utf-8")
		const rendered = renderPrompt(template, phase, ctx)
		const leftover = rendered.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g)
		expect(leftover).toBeNull()
	})

	test("source-writing spike iteration fragment allows source writes and forbids PR/merge/closure", async () => {
		const body = await readFile(resolve(BUNDLED_PRESET_DIR, "iter/source-writing-spike.md"), "utf-8")
		expect(body).toContain("create, edit, and delete PoC/source files")
		expect(body).toContain("Do not open an implementation PR")
		expect(body).toContain("merge a PR or branch")
		expect(body).toContain("close the issue")
		expect(body).toContain("write final local state")
		expect(body).not.toContain("gh pr merge")
	})

	test("blocked iteration route narrows scope before implementation", async () => {
		const readContext = await readFile(resolve(BUNDLED_PRESET_DIR, "iter/read-context.md"), "utf-8")
		const resolveBlocker = await readFile(resolve(BUNDLED_PRESET_DIR, "iter/resolve-blocker.md"), "utf-8")
		expect(readContext).toContain("`ISSUE_KIND` is `blocked` → read `iter/resolve-blocker`")
		expect(resolveBlocker).toContain("Use only when `ISSUE_KIND` is `blocked`")
		expect(resolveBlocker).toContain("the `Unblocks: owner/repo#N` back-link")
		expect(resolveBlocker).toContain("replays the blocked path")
		expect(resolveBlocker).toContain("`needs_implementation` -> read `iter/implement`")
	})

	test("comment spike fragment remains no-code", async () => {
		const body = await readFile(resolve(BUNDLED_PRESET_DIR, "iter/spike-comment.md"), "utf-8")
		expect(body).toContain("Do not write code files")
	})

	test("source-writing spike review gate is no-merge while accepted PR still merges", async () => {
		const sourceSpikeGate = await readFile(resolve(BUNDLED_PRESET_DIR, "review/source-writing-spike-gate.md"), "utf-8")
		const acceptPr = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-accept-pr.md"), "utf-8")
		expect(sourceSpikeGate).toContain("must not merge a PR")
		expect(sourceSpikeGate).toContain("no implementation PR exists")
		expect(sourceSpikeGate).not.toContain("gh pr merge")
		expect(acceptPr).toContain("gh pr merge <PR_NUMBER>")
	})

	test("blocked review path requires e2e unblock evidence and downstream side effect", async () => {
		const evidenceGate = await readFile(resolve(BUNDLED_PRESET_DIR, "review/evidence-gate.md"), "utf-8")
		const acceptPr = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-accept-pr.md"), "utf-8")
		const acceptNoPr = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-accept-no-pr.md"), "utf-8")
		expect(evidenceGate).toContain("For `ISSUE_KIND` = `blocked`")
		expect(evidenceGate).toContain("replays the blocked path")
		expect(evidenceGate).toContain("unit test, typecheck, diff review")
		expect(acceptPr).toContain("parse the `Unblocks: owner/repo#N` back-link")
		expect(acceptPr).toContain("re-queue the blocked item")
		expect(acceptPr).toContain("coder-loop queue unblock <SOURCE_TARGET_CWD>")
		expect(acceptPr).toContain("coder-loop status <SOURCE_TARGET_CWD> --json --repo <SOURCE_REPO>")
		expect(acceptPr).toContain("skip-no-cross-repo-back-link")
		expect(acceptPr).toContain("without invoking `coder-loop queue unblock`")
		expect(acceptNoPr).toContain("coder-loop queue unblock <SOURCE_TARGET_CWD>")
		expect(acceptNoPr).toContain("skip-no-cross-repo-back-link")
		expect(acceptNoPr).toContain("without invoking `coder-loop queue unblock`")
		expect(acceptNoPr).toContain("A no-PR accepted unblock issue without the downstream re-queue/start side effect is not complete")
	})

	test("requeueBlockedItem moves blocked item to queued and clears blocker metadata", async () => {
		const preset = await bundledPreset()
		const item = makeItem({
			issue: 9000,
			status: "blocked",
			extra: {
				blockerRepo: "owner/dependency",
				blockerRef: "#267",
			},
		})
		const state = makeState({
			queue: [item],
			current: { phase: "review", runId: "r1", startedAt: "2026-05-20T00:00:00.000Z", extra: { issue: 9000 } },
		})

		const result = requeueBlockedItem(state, preset, "9000")

		expect(result).toEqual({
			changed: true,
			issue: "9000",
			beforeStatus: "blocked",
			afterStatus: "queued",
			clearedBlockerRepo: true,
			clearedBlockerRef: true,
			clearedCurrent: true,
		})
		expect(state.queue[0]!.status).toBe("queued")
		expect(state.queue[0]!.extra.blockerRepo).toBeUndefined()
		expect(state.queue[0]!.extra.blockerRef).toBeUndefined()
		expect(state.current).toBeNull()
	})

	test("requeueBlockedItem skips items that are already actionable", async () => {
		const preset = await bundledPreset()
		const item = makeItem({
			issue: 9000,
			status: "queued",
			extra: {
				blockerRepo: "owner/dependency",
				blockerRef: "#267",
			},
		})
		const state = makeState({ queue: [item] })

		const result = requeueBlockedItem(state, preset, "9000")

		expect(result).toEqual({ changed: false, issue: "9000", reason: "not_blocked", status: "queued" })
		expect(state.queue[0]!.status).toBe("queued")
		expect(state.queue[0]!.extra.blockerRepo).toBe("owner/dependency")
		expect(state.queue[0]!.extra.blockerRef).toBe("#267")
	})

	test("normalizeQueueIssueId accepts issue numbers, #numbers, and owner/repo back-links", () => {
		expect(normalizeQueueIssueId("9000")).toBe("9000")
		expect(normalizeQueueIssueId("#9000")).toBe("9000")
		expect(normalizeQueueIssueId("owner/repo#9000")).toBe("9000")
	})

	test("accepted PR GitHub side-effect approval failures stop instead of retrying the same accepted PR", async () => {
		const acceptPr = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-accept-pr.md"), "utf-8")
		const actionStop = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-stop.md"), "utf-8")
		expect(acceptPr).toContain("This command requires approval")
		expect(acceptPr).toContain("noninteractive approval/permission boundary")
		expect(acceptPr).toContain("read `review/action-stop`")
		expect(acceptPr).not.toContain("`accept_pr_failed` → read `review/action-retry`")
		expect(actionStop).toContain("accepted PR or accepted no-PR GitHub side effect failure")
		expect(actionStop).toContain("failed command")
		expect(actionStop).toContain("Remove `.dev-loop`")
		expect(actionStop).toContain("Do not mark the selected issue `done`")
	})

	test("accepted no-PR GitHub side-effect approval failures stop instead of retrying the same accepted issue", async () => {
		const acceptNoPr = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-accept-no-pr.md"), "utf-8")
		const actionStop = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-stop.md"), "utf-8")
		expect(acceptNoPr).toContain("This command requires approval")
		expect(acceptNoPr).toContain("noninteractive approval/permission boundary")
		expect(acceptNoPr).toContain("accepted_no_pr")
		expect(acceptNoPr).toContain("read `review/action-stop`")
		expect(acceptNoPr).not.toContain("`accept_no_pr_failed` → read `review/action-retry`")
		expect(acceptNoPr).toContain("`accept_no_pr_retry_needed` → read `review/action-retry`")
		expect(actionStop).toContain("accepted PR or accepted no-PR GitHub side effect failure")
		expect(actionStop).toContain("failed command")
		expect(actionStop).toContain("Remove `.dev-loop`")
		expect(actionStop).toContain("Do not mark the selected issue `done`")
	})

	test("blocked review path requires structured blocker metadata", async () => {
		const actionBlocked = await readFile(resolve(BUNDLED_PRESET_DIR, "review/action-blocked.md"), "utf-8")
		const updateState = await readFile(resolve(BUNDLED_PRESET_DIR, "review/update-state.md"), "utf-8")

		expect(actionBlocked).toContain("Standard blocker metadata")
		expect(actionBlocked).toContain("blockerRepo: owner/repo")
		expect(actionBlocked).toContain("blockerRef: #123")
		expect(updateState).toContain("Only the `blocked` transition writes blocker metadata")
		expect(updateState).toContain("top-level JSON fields on each queue item")
		expect(updateState).toContain("do not create a literal nested `extra` object")
		expect(updateState).toContain("set the selected queue item's top-level `agentCwd`")
		expect(updateState).toContain("post-review `blocked-responder` trigger spawns in the blocking repository")
		expect(updateState).toContain("do not add `blockerRepo` or `blockerRef`")
	})

	test("review summary parser extracts stop verdict from raw and stream-json runner output", () => {
		expect(parseReviewSummaryVerdict("REVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken")).toBe("stop")
		expect(parseReviewSummaryVerdict(JSON.stringify({
			type: "assistant",
			message: {
				content: [{
					type: "text",
					text: "gh issue comment failed: This command requires approval\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken",
				}],
			},
		}))).toBe("stop")
		expect(parseReviewSummaryVerdict("REVIEW SUMMARY: verdict=retry; issue=#114; actionable=1; reason=changes requested")).toBe("retry")
		expect(parseReviewSummaryVerdict("REVIEW SUMMARY: noop")).toBeNull()
	})

	test("review summary parser ignores quoted old stop summaries outside the final agent summary", () => {
		const staleCommandOutput = JSON.stringify({
			type: "item.completed",
			item: {
				type: "command_execution",
				aggregated_output: "old log:\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken",
			},
		})
		const codexNoFinalSummary = JSON.stringify({
			type: "item.completed",
			item: {
				type: "agent_message",
				text: "I found an old stop summary in logs, but I am still checking it.",
			},
		})
		const codexEarlierAgentSummary = JSON.stringify({
			type: "item.completed",
			item: {
				type: "agent_message",
				text: "Interim note.\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken",
			},
		})
		const codexLaterAgentMessage = JSON.stringify({
			type: "item.completed",
			item: {
				type: "agent_message",
				text: "I continued after the interim note and did not emit a final summary.",
			},
		})
		const claudeQuotedSummary = JSON.stringify({
			type: "assistant",
			message: {
				content: [{
					type: "text",
					text: "The old trace contained:\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken\nContinuing without a final stop verdict.",
				}],
			},
		})

		expect(parseReviewSummaryVerdict(`${staleCommandOutput}\n${codexNoFinalSummary}`, "codex")).toBeNull()
		expect(parseReviewSummaryVerdict(`${codexEarlierAgentSummary}\n${codexLaterAgentMessage}`, "codex")).toBeNull()
		expect(parseReviewSummaryVerdict(claudeQuotedSummary, "claude")).toBeNull()
		expect(parseReviewSummaryVerdict("old log:\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken\nreview still running")).toBeNull()
	})

	test("review summary parser accepts final runner agent summary lines", () => {
		const codexFinalSummary = JSON.stringify({
			type: "item.completed",
			item: {
				type: "agent_message",
				text: "Review stopped.\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken",
			},
		})
		const claudeFinalSummary = JSON.stringify({
			type: "assistant",
			message: {
				content: [{
					type: "text",
					text: "Review stopped.\nREVIEW SUMMARY: verdict=stop; issue=#114; actionable=1; reason=review infrastructure broken",
				}],
			},
		})

		expect(parseReviewSummaryVerdict(codexFinalSummary, "codex")).toBe("stop")
		expect(parseReviewSummaryVerdict(claudeFinalSummary, "claude")).toBe("stop")
	})
})

describe("resolvePresetDir", () => {
	const PKG_ROOT = "/repo/coder-loop"
	const TARGET_CWD = "/some/target"

	test("default fallback (preset and presetPath both null) → bundled gh-issue-pr-iteration under pkgRoot", () => {
		const dir = resolvePresetDir({ preset: null, presetPath: null }, PKG_ROOT, TARGET_CWD)
		expect(dir).toBe("/repo/coder-loop/presets/gh-issue-pr-iteration")
	})

	test("config.preset = name → bundled lookup under pkgRoot/presets/<name>", () => {
		const dir = resolvePresetDir({ preset: "single-phase-example", presetPath: null }, PKG_ROOT, TARGET_CWD)
		expect(dir).toBe("/repo/coder-loop/presets/single-phase-example")
	})

	test("config.presetPath absolute → returned verbatim", () => {
		const dir = resolvePresetDir({ preset: null, presetPath: "/abs/path/my-preset" }, PKG_ROOT, TARGET_CWD)
		expect(dir).toBe("/abs/path/my-preset")
	})

	test("config.presetPath relative → resolved against targetCwd", () => {
		const dir = resolvePresetDir({ preset: null, presetPath: ".coder-loop/local-preset" }, PKG_ROOT, TARGET_CWD)
		expect(dir).toBe("/some/target/.coder-loop/local-preset")
	})

	test("config.preset and config.presetPath both set → throws (mutually exclusive)", () => {
		expect(() => resolvePresetDir({ preset: "x", presetPath: "/y" }, PKG_ROOT, TARGET_CWD)).toThrow(/mutually exclusive/)
	})

	test("config.preset with path traversal name (..) → throws", () => {
		expect(() => resolvePresetDir({ preset: "..", presetPath: null }, PKG_ROOT, TARGET_CWD)).toThrow(/invalid name/)
	})

	test("config.preset with slash → throws", () => {
		expect(() => resolvePresetDir({ preset: "evil/sub", presetPath: null }, PKG_ROOT, TARGET_CWD)).toThrow(/invalid name/)
	})

	test("config.preset starting with digit → throws (must start with letter)", () => {
		expect(() => resolvePresetDir({ preset: "1bad", presetPath: null }, PKG_ROOT, TARGET_CWD)).toThrow(/invalid name/)
	})
})

describe("preset selection integration (synthetic target)", () => {
	test("target config preset='gh-issue-pr-iteration' makes --check-runtime path emit `preset=gh-issue-pr-iteration`", async () => {
		const targetCwd = await mkdtemp(resolve(tmpdir(), "coder-loop-pr5-"))
		const runtimeDir = resolve(targetCwd, ".coder-loop/runtime")
		const issueDir = resolve(runtimeDir, "issues")
		const evidenceDir = resolve(runtimeDir, "evidence")
		const logDir = resolve(runtimeDir, "logs")
		await mkdir(issueDir, { recursive: true })
		await mkdir(evidenceDir, { recursive: true })
		await mkdir(logDir, { recursive: true })
		await writeFile(resolve(targetCwd, ".coder-loop/workflow.md"), "# workflow\n")
		await writeFile(resolve(runtimeDir, "shared.md"), "# shared\n")
		await writeFile(resolve(runtimeDir, "config.json"), JSON.stringify({
			repository: "Mouriya-Emma/synthetic",
			baseBranch: "main",
			preset: "gh-issue-pr-iteration",
		}))
		await writeFile(resolve(runtimeDir, "state.json"), JSON.stringify({
			version: 1,
			queue: [],
			repository: "Mouriya-Emma/synthetic",
			baseBranch: "main",
			recentRuns: [],
			current: null,
		}))

		const proc = Bun.spawnSync({
			cmd: ["bun", "src/loop.ts", "--target-cwd", targetCwd, "--check-runtime"],
			cwd: REPO_ROOT,
			stderr: "pipe",
			stdout: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("preset=gh-issue-pr-iteration")
		expect(stderr).toContain("Runtime check passed: target=")
	})
})

describe("buildRuntimeBindings / buildConfigBindings / renderFragmentIndex", () => {
	test("buildRuntimeBindings exposes all whitelisted runtime keys", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-1",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: null,
		})
		expect(runtime.runId).toBe("run-1")
		expect(runtime.targetCwd).toBe(options.targetCwd)
		expect(runtime.agentCwd).toBe(options.targetCwd)
		expect(runtime.presetDir).toBe(preset.presetDir)
		expect(runtime.runIdGeneration).toBe("new")
		expect(runtime.resumedFromPhase).toBe("")
		expect(runtime.resumedStartedAt).toBe("")
		expect(runtime.issueKind).toBe("")
	})

	test("buildRuntimeBindings forwards a per-item agentCwd distinct from targetCwd", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-cross-repo",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: "/abs/other-repo",
			issueRun,
			issueKind: null,
		})
		expect(runtime.agentCwd).toBe("/abs/other-repo")
		expect(runtime.targetCwd).toBe(options.targetCwd)
	})

	test("buildRuntimeBindings exposes resumed values when issueRun.runIdGeneration === 'resumed'", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = {
			runIdGeneration: "resumed",
			resumedFromPhase: preset.phases[0]!.name,
			resumedStartedAt: "2026-05-10T11:50:00Z",
		}
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-2",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: "code",
		})
		expect(runtime.runIdGeneration).toBe("resumed")
		expect(runtime.resumedFromPhase).toBe(preset.phases[0]!.name)
		expect(runtime.resumedStartedAt).toBe("2026-05-10T11:50:00Z")
		expect(runtime.issueKind).toBe("code")
	})

	test("buildRuntimeBindings maps issueKind null to empty string", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-3",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: null,
		})
		expect(runtime.issueKind).toBe("")
	})

	test("buildRuntimeBindings passes through 'comment' kind unchanged", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-4",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: "comment",
		})
		expect(runtime.issueKind).toBe("comment")
	})

	test("buildRuntimeBindings passes through 'code-spike' kind unchanged", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-5",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: "code-spike",
		})
		expect(runtime.issueKind).toBe("code-spike")
	})

	test("buildRuntimeBindings passes through 'blocked' kind unchanged", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-6",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			agentCwd: options.targetCwd,
			issueRun,
			issueKind: "blocked",
		})
		expect(runtime.issueKind).toBe("blocked")
	})

	test("buildConfigBindings reads repository / baseBranch / requireBrowserEvidence from options", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const config = buildConfigBindings(options)
		expect(config.repository).toBe(options.repository ?? "")
		expect(config.baseBranch).toBe(options.baseBranch ?? "")
		expect(config.requireBrowserEvidence).toBe(options.requireBrowserEvidence)
	})

	test("renderFragmentIndex enumerates preset.fragments with absolute paths", async () => {
		const preset = await bundledPreset()
		const index = renderFragmentIndex(preset)
		expect(index.split("\n").length).toBe(preset.fragments.length)
		expect(index.startsWith(`- ${preset.fragments[0]!.id} (${preset.fragments[0]!.role}): `)).toBe(true)
		expect(index.includes(preset.fragments[0]!.path)).toBe(true)
	})
})

describe("parseKindFromLabels", () => {
	test("returns kind=null when no kind:* label is present (legacy issue path)", () => {
		const result = parseKindFromLabels(["bug", "good first issue"])
		expect(result).toEqual({ ok: true, kind: null })
	})

	test("returns kind=null when label list is empty", () => {
		expect(parseKindFromLabels([])).toEqual({ ok: true, kind: null })
	})

	test("returns kind='code' for a single kind:code label", () => {
		const result = parseKindFromLabels(["kind:code", "priority:high"])
		expect(result).toEqual({ ok: true, kind: "code" })
	})

	test("returns kind='comment' for a single kind:comment label", () => {
		const result = parseKindFromLabels(["kind:comment"])
		expect(result).toEqual({ ok: true, kind: "comment" })
	})

	test("returns kind='code-spike' for a single kind:code-spike label", () => {
		const result = parseKindFromLabels(["kind:code-spike"])
		expect(result).toEqual({ ok: true, kind: "code-spike" })
	})

	test("returns kind='blocked' for a single kind:blocked label", () => {
		const result = parseKindFromLabels(["kind:blocked"])
		expect(result).toEqual({ ok: true, kind: "blocked" })
	})

	test("routes issue kinds to their iteration fragments", () => {
		expect(iterationRouteForIssueKind("code")).toBe("iter/classify-scope")
		expect(iterationRouteForIssueKind(null)).toBe("iter/classify-scope")
		expect(iterationRouteForIssueKind("comment")).toBe("iter/spike-comment")
		expect(iterationRouteForIssueKind("code-spike")).toBe("iter/source-writing-spike")
		expect(iterationRouteForIssueKind("blocked")).toBe("iter/resolve-blocker")
	})

	test("returns ok=false when multiple kind labels are present", () => {
		const result = parseKindFromLabels(["kind:code", "kind:comment", "kind:code-spike", "kind:blocked"])
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/expected exactly one kind:\* label, found 4/)
	})

	test("returns ok=false for unknown kind:* values", () => {
		const result = parseKindFromLabels(["kind:spike"])
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/unknown kind label "kind:spike"/)
	})

	test("returns ok=false for empty kind: prefix value (kind: with nothing after)", () => {
		const result = parseKindFromLabels(["kind:"])
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/unknown kind label "kind:"/)
	})

	test("resolveIssueKind reads local queue kind when repository is not configured", async () => {
		const item = makeItem({ issue: 44, status: "queued" })
		item.extra.kind = "code-spike"
		expect(await resolveIssueKind(null, "44", item)).toEqual({ ok: true, kind: "code-spike" })
	})

	test("resolveIssueKind reads local queue blocked kind when repository is not configured", async () => {
		const item = makeItem({ issue: 45, status: "queued" })
		item.extra.kind = "blocked"
		expect(await resolveIssueKind(null, "45", item)).toEqual({ ok: true, kind: "blocked" })
	})
})

describe("parseSessionIdFromStream — captures session_id from claude --output-format stream-json --verbose", () => {
	test("first system/init event with session_id yields the uuid string", () => {
		const text = `{"type":"system","subtype":"init","session_id":"abc-123","cwd":"/tmp"}\n{"type":"assistant","session_id":"abc-123"}\n`
		expect(parseSessionIdFromStream(text)).toBe("abc-123")
	})

	test("returns null when first line has no session_id", () => {
		const text = `{"type":"system","subtype":"init","cwd":"/tmp"}\n`
		expect(parseSessionIdFromStream(text)).toBeNull()
	})

	test("returns null when stream is empty", () => {
		expect(parseSessionIdFromStream("")).toBeNull()
	})

	test("returns null when stream has no terminating newline yet (partial chunk)", () => {
		expect(parseSessionIdFromStream(`{"type":"system","session_id":"x"`)).toBeNull()
	})

	test("returns null when first line is not valid JSON", () => {
		expect(parseSessionIdFromStream("not-json\n{\"session_id\":\"x\"}\n")).toBeNull()
	})
})

describe("parseCodexThreadIdFromStream", () => {
	test("captures thread_id from Codex thread.started JSONL", () => {
		const text = [
			`{"type":"thread.started","thread_id":"thread-123"}`,
			`{"type":"turn.started"}`,
			`{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
		].join("\n")
		expect(parseCodexThreadIdFromStream(text)).toBe("thread-123")
		expect(parseSessionIdFromRunnerStream("codex", text)).toBe("thread-123")
	})

	test("skips non-json lines and returns null when no thread.started event exists", () => {
		const text = `not-json\n{"type":"turn.started"}\n{"type":"thread.started","thread_id":""}\n`
		expect(parseCodexThreadIdFromStream(text)).toBeNull()
	})
})

describe("extractErrorCode — pulls error code from stream-json error events or stderr HTTP status", () => {
	test("uses error.type from last is_error event in stdout", () => {
		const stdout = `{"type":"assistant","is_error":false}\n{"type":"result","is_error":true,"error":{"type":"overloaded_error","message":"API overloaded"}}\n`
		expect(extractErrorCode(stdout, "")).toBe("overloaded_error")
	})

	test("falls back to error.code when error.type is missing", () => {
		const stdout = `{"is_error":true,"error":{"code":"529"}}\n`
		expect(extractErrorCode(stdout, "")).toBe("529")
	})

	test("falls back to error.message (truncated) when type and code missing", () => {
		const stdout = `{"is_error":true,"error":{"message":"Service Unavailable"}}\n`
		expect(extractErrorCode(stdout, "")).toBe("Service Unavailable")
	})

	test("falls back to stderr HTTP 5xx when stdout has no usable event", () => {
		expect(extractErrorCode("", "HTTP/1.1 503 Service Unavailable")).toBe("503_http")
	})

	test("falls back to stderr keyword overloaded when no 5xx and no events", () => {
		expect(extractErrorCode("", "Anthropic API: overloaded, retry later")).toBe("overloaded")
	})

	test("returns 'unknown' when neither stdout events nor stderr patterns match", () => {
		expect(extractErrorCode("plain text\n", "syntax error")).toBe("unknown")
	})
})

describe("classifyTermination — tagged union from exit code + signal + output", () => {
	test("signal != null wins over exitCode and yields {kind:'signal'}", () => {
		const t = classifyTermination({ exitCode: 1, signal: "SIGTERM", stdoutText: "", stderrText: "" })
		expect(t).toEqual({ kind: "signal", name: "SIGTERM" })
	})

	test("exit 0 with no signal yields {kind:'clean'}", () => {
		expect(classifyTermination({ exitCode: 0, signal: null, stdoutText: "", stderrText: "" })).toEqual({ kind: "clean" })
	})

	test("non-zero exit with 5xx error event yields {kind:'error', code:<type>}", () => {
		const stdout = `{"is_error":true,"error":{"type":"overloaded_error"}}\n`
		const t = classifyTermination({ exitCode: 1, signal: null, stdoutText: stdout, stderrText: "" })
		expect(t).toEqual({ kind: "error", code: "overloaded_error" })
	})

	test("non-zero exit with HTTP 503 in stderr yields {kind:'error', code:'503_http'}", () => {
		const t = classifyTermination({ exitCode: 1, signal: null, stdoutText: "", stderrText: "HTTP 503 from upstream" })
		expect(t).toEqual({ kind: "error", code: "503_http" })
	})

	test("non-zero exit with no parseable error yields {kind:'error', code:'unknown'}", () => {
		const t = classifyTermination({ exitCode: 1, signal: null, stdoutText: "blah\n", stderrText: "fatal: oops" })
		expect(t).toEqual({ kind: "error", code: "unknown" })
	})

	test("empty signal string treated as no signal (uses exit code path)", () => {
		expect(classifyTermination({ exitCode: 0, signal: "", stdoutText: "", stderrText: "" })).toEqual({ kind: "clean" })
	})
})

describe("isTransient5xx — recognizes claude API transient overload signals", () => {
	test.each([
		["529_overloaded", true],
		["overloaded_error", true],
		["503_http", true],
		["overloaded", true],
		["rate_limit_error", true],
		["rate-limit", true],
		["service_unavailable", true],
		["service-unavailable", true],
		["OVERLOADED", true],
		["unknown", false],
		["401_unauthorized", false],
		["invalid_request_error", false],
		["spawn_error", false],
		["", false],
	])("isTransient5xx(%p) === %p", (code, expected) => {
		expect(isTransient5xx(code as string)).toBe(expected)
	})
})

describe("decideResume — resume policy from last sessions.jsonl entry", () => {
	const baseEntry: SessionEntry = {
		attempt: "2026-05-11T00:00:00Z",
		sessionId: "sess-1",
		exitCode: 0,
		signal: null,
		terminated: { kind: "clean" },
		log: "/tmp/log.jsonl",
	}

	test("null entry → fresh", () => {
		expect(decideResume(null)).toEqual({ kind: "fresh" })
	})

	test("missing sessionId → fresh (even if terminated says resume-eligible)", () => {
		const entry: SessionEntry = { ...baseEntry, sessionId: null, terminated: { kind: "signal", name: "SIGTERM" } }
		expect(decideResume(entry)).toEqual({ kind: "fresh" })
	})

	test("clean termination → fresh", () => {
		expect(decideResume(baseEntry)).toEqual({ kind: "fresh" })
	})

	test("signal termination + sessionId → resume", () => {
		const entry: SessionEntry = { ...baseEntry, terminated: { kind: "signal", name: "SIGTERM" } }
		expect(decideResume(entry)).toEqual({ kind: "resume", sessionId: "sess-1" })
	})

	test("error with 5xx code + sessionId → resume", () => {
		const entry: SessionEntry = { ...baseEntry, terminated: { kind: "error", code: "529_overloaded" } }
		expect(decideResume(entry)).toEqual({ kind: "resume", sessionId: "sess-1" })
	})

	test("error with non-5xx code → fresh", () => {
		const entry: SessionEntry = { ...baseEntry, terminated: { kind: "error", code: "401_unauthorized" } }
		expect(decideResume(entry)).toEqual({ kind: "fresh" })
	})

	test("absolute attempt timeout → fresh", () => {
		const entry: SessionEntry = { ...baseEntry, terminated: { kind: "timeout", phase: "term", attemptSeconds: 60 } }
		expect(decideResume(entry)).toEqual({ kind: "fresh" })
	})
})

describe("nextBackoffSeconds — capped exponential", () => {
	test.each([
		[0, 4],
		[1, 8],
		[2, 16],
		[3, 32],
		[4, 64],
		[5, 128],
		[6, 256],
		[7, 512],
		[8, 600],
		[9, 600],
		[20, 600],
	])("nextBackoffSeconds(%i) === %i", (n, expected) => {
		expect(nextBackoffSeconds(n)).toBe(expected)
	})
})

describe("agentClaudeArgs — composes claude CLI args including --resume", () => {
	test("fresh resume: no --resume flag, -p prompt at end", () => {
		const args = agentClaudeArgs([], "hello", { kind: "fresh" }, [])
		expect(args).toContain("--output-format")
		expect(args).toContain("stream-json")
		expect(args).toContain("--verbose")
		expect(args).not.toContain("--resume")
		expect(args).not.toContain("--add-dir")
		expect(args[args.length - 2]).toBe("-p")
		expect(args[args.length - 1]).toBe("hello")
	})

	test("resume decision injects --resume <sessionId> before -p", () => {
		const args = agentClaudeArgs([], RESUME_CONTINUE_PROMPT, { kind: "resume", sessionId: "sess-xyz" }, [])
		const resumeIdx = args.indexOf("--resume")
		const promptIdx = args.indexOf("-p")
		expect(resumeIdx).toBeGreaterThanOrEqual(0)
		expect(args[resumeIdx + 1]).toBe("sess-xyz")
		expect(promptIdx).toBeGreaterThan(resumeIdx)
		expect(args[promptIdx + 1]).toBe(RESUME_CONTINUE_PROMPT)
	})

	test("preserves caller's extraArgs and skips duplicate --output-format / --verbose", () => {
		const args = agentClaudeArgs(["--output-format", "stream-json", "--verbose", "--max-turns", "5"], "prompt", { kind: "fresh" }, [])
		expect(args.filter((a) => a === "--output-format").length).toBe(1)
		expect(args.filter((a) => a === "--verbose").length).toBe(1)
		expect(args).toContain("--max-turns")
		expect(args).toContain("5")
	})

	test("runner model replaces caller-provided Claude --model args", () => {
		const args = agentClaudeArgs(["--model", "sonnet", "--max-turns", "5"], "prompt", { kind: "fresh" }, [], CLAUDE_REVIEW_MODEL)
		const modelIdx = args.indexOf("--model")
		expect(args.filter((a) => a === "--model").length).toBe(1)
		expect(args).not.toContain("sonnet")
		expect(args[modelIdx + 1]).toBe(CLAUDE_REVIEW_MODEL)
		expect(args).toContain("--max-turns")
		expect(args).toContain("5")
	})

	test("additionalDirs injects a single --add-dir followed by every dir, before -p", () => {
		const args = agentClaudeArgs([], "p", { kind: "fresh" }, ["/x/preset", "/x/target"])
		const idx = args.indexOf("--add-dir")
		expect(args.filter((a) => a === "--add-dir").length).toBe(1)
		expect(args[idx + 1]).toBe("/x/preset")
		expect(args[idx + 2]).toBe("/x/target")
		expect(idx).toBeLessThan(args.indexOf("-p"))
	})

	test("caller-provided --add-dir in extraArgs takes precedence; additionalDirs is skipped", () => {
		const args = agentClaudeArgs(["--add-dir", "/caller/path"], "p", { kind: "fresh" }, ["/x/preset"])
		expect(args.filter((a) => a === "--add-dir").length).toBe(1)
		expect(args).toContain("/caller/path")
		expect(args).not.toContain("/x/preset")
	})
})

describe("agentCodexArgs", () => {
	test("fresh invocation uses Codex exec JSON mode with cwd and full sandbox for real loop work", () => {
		const args = agentCodexArgs([], "hello", { kind: "fresh" }, "/tmp/target")
		expect(args).toEqual([
			"--ask-for-approval",
			"never",
			"exec",
			"--json",
			"--cd",
			"/tmp/target",
			"--sandbox",
			"danger-full-access",
			"hello",
		])
	})

	test("fresh invocation preserves caller-provided sandbox override", () => {
		const args = agentCodexArgs(["--sandbox", "workspace-write"], "hello", { kind: "fresh" }, "/tmp/target")
		expect(args).toEqual([
			"--ask-for-approval",
			"never",
			"exec",
			"--sandbox",
			"workspace-write",
			"--json",
			"--cd",
			"/tmp/target",
			"hello",
		])
	})

	test("runner model replaces caller-provided Codex --model args", () => {
		const args = agentCodexArgs(["-m", "gpt-5.3", "--sandbox", "workspace-write"], "hello", { kind: "fresh" }, "/tmp/target", "gpt-5.4")
		expect(args).toEqual([
			"--ask-for-approval",
			"never",
			"exec",
			"--sandbox",
			"workspace-write",
			"--model",
			"gpt-5.4",
			"--json",
			"--cd",
			"/tmp/target",
			"hello",
		])
	})

	test("resume invocation uses Codex exec resume with JSON and ignore-rules", () => {
		const args = agentCodexArgs(["--model", "gpt-5.4"], "继续", { kind: "resume", sessionId: "thread-123" }, "/tmp/target")
		expect(args).toEqual([
			"--ask-for-approval",
			"never",
			"exec",
			"resume",
			"thread-123",
			"--model",
			"gpt-5.4",
			"--json",
			"--ignore-rules",
			"继续",
		])
	})
})

describe("buildRunnerInvocation", () => {
	test("Claude runner maps to the existing claude stream-json invocation and exposes presetDir via --add-dir", () => {
		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "config", binary: "/tmp/claude", extraArgs: ["--max-turns", "5"], model: null },
			"hello",
			{ kind: "fresh" },
			{ agentCwd: "/tmp/target", targetCwd: "/tmp/target", presetDir: "/tmp/preset" },
		)

		expect(invocation.binary).toBe("/tmp/claude")
		expect(invocation.args).toContain("--output-format")
		expect(invocation.args).toContain("stream-json")
		expect(invocation.args).toContain("--max-turns")
		expect(invocation.args).toContain("--add-dir")
		expect(invocation.args).toContain("/tmp/preset")
		expect(invocation.args[invocation.args.length - 1]).toBe("hello")
	})

	test("Claude runner with cross-repo agentCwd adds both presetDir and targetCwd to --add-dir", () => {
		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "config", binary: "/tmp/claude", extraArgs: [], model: null },
			"hello",
			{ kind: "fresh" },
			{ agentCwd: "/tmp/agent-repo", targetCwd: "/tmp/target", presetDir: "/tmp/preset" },
		)

		const idx = invocation.args.indexOf("--add-dir")
		expect(idx).toBeGreaterThanOrEqual(0)
		expect(invocation.args[idx + 1]).toBe("/tmp/preset")
		expect(invocation.args[idx + 2]).toBe("/tmp/target")
	})

	test("runner model reaches Claude invocation and overrides extraArgs model", () => {
		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "config", binary: "/tmp/claude", extraArgs: ["--model", "sonnet"], model: CLAUDE_REVIEW_MODEL },
			"hello",
			{ kind: "fresh" },
			{ agentCwd: "/tmp/target", targetCwd: "/tmp/target", presetDir: "/tmp/preset" },
		)

		const idx = invocation.args.indexOf("--model")
		expect(invocation.args.filter((a) => a === "--model").length).toBe(1)
		expect(invocation.args[idx + 1]).toBe(CLAUDE_REVIEW_MODEL)
		expect(invocation.args).not.toContain("sonnet")
	})

	test("Codex runner maps to codex exec invocation (uses agentCwd; --add-dir not applicable)", () => {
		const invocation = buildRunnerInvocation(
			{ kind: "codex", source: "queue", binary: "codex", extraArgs: [], model: null },
			"hello",
			{ kind: "fresh" },
			{ agentCwd: "/tmp/target", targetCwd: "/tmp/target", presetDir: "/tmp/preset" },
		)

		expect(invocation).toEqual({
			kind: "spawn",
			binary: "codex",
			args: ["--ask-for-approval", "never", "exec", "--json", "--cd", "/tmp/target", "--sandbox", "danger-full-access", "hello"],
		})
	})
})

describe("sessions.jsonl appends each attempt — I/O roundtrip", () => {
	async function freshSessionsPath(): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "sessions-jsonl-"))
		const latest = resolve(dir, "run-1.iter.txt")
		return agentSessionsPath(latest)
	}

	test("agentSessionsPath rewrites .txt → .sessions.jsonl", () => {
		expect(agentSessionsPath("/tmp/logs/run-X.iter.txt")).toBe("/tmp/logs/run-X.iter.sessions.jsonl")
	})

	test("sessions.jsonl appends each attempt as one JSON line with required fields", async () => {
		const path = await freshSessionsPath()
		const entries: SessionEntry[] = [
			{ attempt: "2026-05-11T00:00:00Z", sessionId: "s1", exitCode: 1, signal: null, terminated: { kind: "error", code: "529_overloaded" }, log: "/tmp/a1.jsonl" },
			{ attempt: "2026-05-11T00:05:00Z", sessionId: "s1", exitCode: 0, signal: null, terminated: { kind: "clean" }, log: "/tmp/a2.jsonl" },
			{ attempt: "2026-05-11T00:10:00Z", sessionId: "s1", exitCode: 143, signal: "SIGTERM", terminated: { kind: "signal", name: "SIGTERM" }, log: "/tmp/a3.jsonl" },
			{ attempt: "2026-05-11T00:15:00Z", sessionId: null, exitCode: 143, signal: "SIGTERM", terminated: { kind: "timeout", phase: "term", attemptSeconds: 60 }, log: "/tmp/a4.jsonl" },
		]
		for (const entry of entries) await appendSessionEntry(path, entry)
		const raw = await readFile(path, "utf-8")
		const lines = raw.split("\n").filter((l) => l.trim() !== "")
		expect(lines.length).toBe(4)
		for (const line of lines) {
			const parsed = JSON.parse(line) as Record<string, unknown>
			expect(parsed).toHaveProperty("attempt")
			expect(parsed).toHaveProperty("sessionId")
			expect(parsed).toHaveProperty("exitCode")
			expect(parsed).toHaveProperty("signal")
			expect(parsed).toHaveProperty("terminated")
			expect(parsed).toHaveProperty("log")
			const terminated = parsed["terminated"] as { kind?: unknown }
			expect(["clean", "signal", "error", "timeout"]).toContain(terminated.kind as string)
		}
		const last = await readLastSessionEntry(path)
		expect(last).not.toBeNull()
		expect(last!.attempt).toBe("2026-05-11T00:15:00Z")
		expect(last!.terminated).toEqual({ kind: "timeout", phase: "term", attemptSeconds: 60 })
	})
})

describe("sessions.jsonl missing or corrupt falls back to fresh — degrade-not-crash", () => {
	async function freshSessionsPath(): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "sessions-jsonl-corrupt-"))
		const latest = resolve(dir, "run-1.iter.txt")
		return agentSessionsPath(latest)
	}

	test("missing sessions.jsonl → readLastSessionEntry returns null (fresh spawn at top of runAgent)", async () => {
		const path = await freshSessionsPath()
		expect(await readLastSessionEntry(path)).toBeNull()
		expect(decideResume(await readLastSessionEntry(path))).toEqual({ kind: "fresh" })
	})

	test("trailing corrupt line falls back to prior valid entry, doesn't crash", async () => {
		const path = await freshSessionsPath()
		const good: SessionEntry = { attempt: "2026-05-11T00:00:00Z", sessionId: "s1", exitCode: 1, signal: null, terminated: { kind: "signal", name: "SIGTERM" }, log: "/tmp/a1.jsonl" }
		await appendSessionEntry(path, good)
		await writeFile(path, (await readFile(path, "utf-8")) + "{not valid json\n")
		const last = await readLastSessionEntry(path)
		expect(last).not.toBeNull()
		expect(last!.attempt).toBe("2026-05-11T00:00:00Z")
	})

	test("entries with wrong shape are skipped (missing required fields → not a SessionEntry)", async () => {
		const path = await freshSessionsPath()
		await writeFile(path, `{"attempt":"x"}\n{"attempt":"y","sessionId":null,"exitCode":0,"signal":null,"terminated":{"kind":"clean"},"log":"/tmp/x"}\n{"garbage":true}\n`)
		const last = await readLastSessionEntry(path)
		expect(last).not.toBeNull()
		expect(last!.attempt).toBe("y")
	})

	test("every line corrupt → readLastSessionEntry returns null → decideResume yields fresh", async () => {
		const path = await freshSessionsPath()
		await writeFile(path, `{"garbage":1}\n!!!not json!!!\n{"attempt":"missing-terminated","sessionId":null,"exitCode":0,"signal":null,"log":"/tmp/x"}\n`)
		const last = await readLastSessionEntry(path)
		expect(last).toBeNull()
		expect(decideResume(last)).toEqual({ kind: "fresh" })
	})
})

describe("runAgentWithBackoff — orchestrates retries and budget across in-process attempts", () => {
	function makeOutcome(overrides: Partial<AttemptOutcome>): AttemptOutcome {
		return {
			output: "out",
			exitCode: 0,
			signal: null,
			sessionId: "sess-1",
			terminated: { kind: "clean" },
			...overrides,
		}
	}

	function makeSleepRecorder(): { sleep: (s: number) => Promise<void>; calls: number[] } {
		const calls: number[] = []
		return {
			calls,
			sleep: async (seconds: number) => {
				calls.push(seconds)
			},
		}
	}

	test("clean outcome returns after exactly 1 attempt, no sleeps", async () => {
		const { sleep, calls } = makeSleepRecorder()
		let spawns = 0
		const result = await runAgentWithBackoff({
			spawnAttempt: async () => {
				spawns++
				return makeOutcome({ terminated: { kind: "clean" }, exitCode: 0 })
			},
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(spawns).toBe(1)
		expect(result.attempts).toBe(1)
		expect(result.code).toBe(0)
		expect(calls).toEqual([])
	})

	test("non-5xx error returns to outer after 1 attempt without retry", async () => {
		const { sleep, calls } = makeSleepRecorder()
		const result = await runAgentWithBackoff({
			spawnAttempt: async () => makeOutcome({ terminated: { kind: "error", code: "401_unauthorized" }, exitCode: 1 }),
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(result.attempts).toBe(1)
		expect(result.code).toBe(1)
		expect(calls).toEqual([])
	})

	test("signal outcome returns to outer immediately (signal is cross-tick resume, not in-process)", async () => {
		const { sleep, calls } = makeSleepRecorder()
		const result = await runAgentWithBackoff({
			spawnAttempt: async () => makeOutcome({ terminated: { kind: "signal", name: "SIGTERM" }, exitCode: 143 }),
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(result.attempts).toBe(1)
		expect(calls).toEqual([])
	})

	test("transient-5xx retries with min(4*2^n, 600) backoff and stops on success", async () => {
		const { sleep, calls } = makeSleepRecorder()
		const seq: AttemptOutcome[] = [
			makeOutcome({ terminated: { kind: "error", code: "529_overloaded" }, exitCode: 1 }),
			makeOutcome({ terminated: { kind: "error", code: "overloaded" }, exitCode: 1 }),
			makeOutcome({ terminated: { kind: "error", code: "503_http" }, exitCode: 1 }),
			makeOutcome({ terminated: { kind: "clean" }, exitCode: 0 }),
		]
		let i = 0
		const result = await runAgentWithBackoff({
			spawnAttempt: async ({ resume }) => {
				if (i > 0) expect(resume).toEqual({ kind: "resume", sessionId: "sess-1" })
				return seq[i++]!
			},
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(result.attempts).toBe(4)
		expect(result.code).toBe(0)
		expect(calls).toEqual([4, 8, 16])
	})

	test("transient-5xx without sessionId aborts to outer (no resume possible)", async () => {
		const { sleep, calls } = makeSleepRecorder()
		const result = await runAgentWithBackoff({
			spawnAttempt: async () => makeOutcome({ terminated: { kind: "error", code: "overloaded" }, exitCode: 1, sessionId: null }),
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(result.attempts).toBe(1)
		expect(calls).toEqual([])
	})

	test("transient-5xx in-process backoff budget 2h: 8 fast retries then 600s plateau, exhausts budget", async () => {
		const { sleep, calls } = makeSleepRecorder()
		let spawns = 0
		const result = await runAgentWithBackoff({
			spawnAttempt: async () => {
				spawns++
				return makeOutcome({ terminated: { kind: "error", code: "overloaded" }, exitCode: 1 })
			},
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		// Schedule: 4,8,16,32,64,128,256,512,600,600,...; cumulative sum until exceeding 7200.
		// 4+8+16+32+64+128+256+512 = 1020. Then 600*N until 1020 + 600*N > 7200 → N=11 → 1020+6600=7620 (>7200). N=10 → 1020+6000=7020 (≤7200, allow), N=11 → 7620 (deny).
		// So allowed sleeps: 8 fast + 10 plateau = 18. Last sleep is 600 (the 18th). Then 19th spawn yields next-600 candidate which would push elapsed to 7620 > 7200; abort.
		// attempts: 19 (initial + 18 retries after sleeps).
		expect(calls.length).toBe(18)
		expect(calls.slice(0, 8)).toEqual([4, 8, 16, 32, 64, 128, 256, 512])
		expect(calls.slice(8)).toEqual(Array(10).fill(600))
		const total = calls.reduce((a, b) => a + b, 0)
		expect(total).toBeLessThanOrEqual(BACKOFF_BUDGET_SECONDS)
		expect(total + 600).toBeGreaterThan(BACKOFF_BUDGET_SECONDS)
		expect(spawns).toBe(19)
		expect(result.attempts).toBe(19)
		expect(result.code).toBe(1)
	})

	test("initial resume=resume sends --resume on first attempt (cross-tick recovery)", async () => {
		const { sleep } = makeSleepRecorder()
		const seen: ResumeDecision[] = []
		await runAgentWithBackoff({
			spawnAttempt: async ({ resume }) => {
				seen.push(resume)
				return makeOutcome({ terminated: { kind: "clean" }, exitCode: 0 })
			},
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "resume", sessionId: "from-disk" },
		})
		expect(seen[0]).toEqual({ kind: "resume", sessionId: "from-disk" })
	})

	test("watchdog-terminated outcome maps to code=0 so orchestrator advances to review", async () => {
		const { sleep, calls } = makeSleepRecorder()
		const result = await runAgentWithBackoff({
			spawnAttempt: async () =>
				makeOutcome({
					terminated: { kind: "watchdog", phase: "term", afterSummarySeconds: 300 },
					exitCode: 143,
					sessionId: "sess-watch",
				}),
			sleep,
			log: () => {},
			now: () => 0,
			initialResume: { kind: "fresh" },
		})
		expect(result.attempts).toBe(1)
		expect(result.code).toBe(0)
		expect(calls).toEqual([])
	})
})

describe("decideResume — watchdog termination disqualifies in-process resume", () => {
	test("watchdog termination yields fresh even with sessionId present", () => {
		const entry: SessionEntry = {
			attempt: "2026-05-12T00:00:00.000Z",
			sessionId: "sess-watch",
			exitCode: 143,
			signal: "SIGTERM",
			terminated: { kind: "watchdog", phase: "term", afterSummarySeconds: 300 },
			log: "/tmp/x",
		}
		expect(decideResume(entry)).toEqual({ kind: "fresh" })
	})
})

describe("createSummaryWatchdog — summary watchdog timer state machine", () => {
	type TimerEntry = { id: number; cb: () => void; ms: number; cancelled: boolean }

	function makeFakeTimers(): {
		setTimer: (cb: () => void, ms: number) => SummaryWatchdogTimerHandle
		clearTimer: (h: SummaryWatchdogTimerHandle) => void
		timers: TimerEntry[]
		fire: (id: number) => void
	} {
		const timers: TimerEntry[] = []
		let nextId = 1
		return {
			timers,
			setTimer: (cb, ms) => {
				const entry: TimerEntry = { id: nextId++, cb, ms, cancelled: false }
				timers.push(entry)
				return entry.id as unknown as SummaryWatchdogTimerHandle
			},
			clearTimer: (h) => {
				const id = h as unknown as number
				const entry = timers.find((t) => t.id === id)
				if (entry) entry.cancelled = true
			},
			fire: (id: number) => {
				const entry = timers.find((t) => t.id === id)
				if (!entry || entry.cancelled) throw new Error(`timer ${id} not pending`)
				entry.cb()
			},
		}
	}

	test("summary watchdog: stdout containing ITERATION SUMMARY arms 5min timer; firing it sends SIGTERM then 5s SIGKILL", () => {
		const fake = makeFakeTimers()
		const calls: string[] = []
		const wd = createSummaryWatchdog({
			config: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => calls.push("term"),
			onKill: () => calls.push("kill"),
			log: () => {},
		})

		wd.observeStdout(`{"event":"text"}\n`)
		expect(fake.timers.length).toBe(0)
		expect(wd.state()).toEqual({ kind: "idle" })

		wd.observeStdout(`prefix ITERATION SUMMARY: done suffix\n`)
		expect(fake.timers.length).toBe(1)
		expect(fake.timers[0]!.ms).toBe(300_000)
		expect(wd.state()).toEqual({ kind: "armed" })

		fake.fire(fake.timers[0]!.id)
		expect(calls).toEqual(["term"])
		expect(wd.state()).toEqual({ kind: "term-sent" })
		expect(fake.timers.length).toBe(2)
		expect(fake.timers[1]!.ms).toBe(5_000)

		fake.fire(fake.timers[1]!.id)
		expect(calls).toEqual(["term", "kill"])
		expect(wd.state()).toEqual({ kind: "kill-sent" })
	})

	test("summary watchdog: marker straddling two stdout chunks still arms exactly once", () => {
		const fake = makeFakeTimers()
		const calls: string[] = []
		const wd = createSummaryWatchdog({
			config: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => calls.push("term"),
			onKill: () => calls.push("kill"),
			log: () => {},
		})

		wd.observeStdout("blah ITERATION SUMM")
		expect(wd.state()).toEqual({ kind: "idle" })
		wd.observeStdout("ARY: rest of line\n")
		expect(wd.state()).toEqual({ kind: "armed" })
		expect(fake.timers.length).toBe(1)

		// Further stdout after arming must not arm a second time
		wd.observeStdout("ITERATION SUMMARY: again\n")
		expect(fake.timers.length).toBe(1)
	})

	test("summary watchdog: review marker ignores historical iteration summaries", () => {
		const fake = makeFakeTimers()
		const calls: string[] = []
		const wd = createSummaryWatchdog({
			config: { marker: REVIEW_SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => calls.push("term"),
			onKill: () => calls.push("kill"),
			log: () => {},
		})

		wd.observeStdout("trace excerpt: ITERATION SUMMARY: issue #54 retry completed\n")
		expect(fake.timers.length).toBe(0)
		expect(wd.state()).toEqual({ kind: "idle" })

		wd.observeStdout("REVIEW SUMMARY: verdict=accepted; issue=#54; actionable=0; reason=ok\n")
		expect(fake.timers.length).toBe(1)
		expect(wd.state()).toEqual({ kind: "armed" })
		expect(calls).toEqual([])
	})

	test("summary watchdog: prompt marker selection prefers review summaries for review prompts", () => {
		expect(summaryWatchdogConfigForPrompt("Before exiting, print REVIEW SUMMARY: verdict=<...>").marker).toBe(REVIEW_SUMMARY_WATCHDOG_MARKER)
		expect(summaryWatchdogConfigForPrompt("Before exiting, read review/final and print its required REVIEW SUMMARY line.").marker).toBe(REVIEW_SUMMARY_WATCHDOG_MARKER)
		expect(summaryWatchdogConfigForPrompt("Before exiting, print ITERATION SUMMARY: <...>").marker).toBe(SUMMARY_WATCHDOG_MARKER)
	})

	test("summary watchdog: codex JSONL ignores command output that quotes review summary contract", () => {
		const fake = makeFakeTimers()
		const wd = createSummaryWatchdog({
			config: { marker: REVIEW_SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => {},
			onKill: () => {},
			log: () => {},
		})
		const observer = createSummaryWatchdogStdoutObserver("codex", REVIEW_SUMMARY_WATCHDOG_MARKER, wd)
		const commandEvent = {
			type: "item.completed",
			item: {
				type: "command_execution",
				aggregated_output: "# Fragment: review/final\nREVIEW SUMMARY: verdict=<retry|accepted|skip|blocked|stop>\n",
			},
		}

		observer.observeStdout(`${JSON.stringify(commandEvent)}\n`)

		expect(fake.timers.length).toBe(0)
		expect(wd.state()).toEqual({ kind: "idle" })
	})

	test("summary watchdog: codex JSONL arms on agent message summary line", () => {
		const fake = makeFakeTimers()
		const wd = createSummaryWatchdog({
			config: { marker: REVIEW_SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => {},
			onKill: () => {},
			log: () => {},
		})
		const observer = createSummaryWatchdogStdoutObserver("codex", REVIEW_SUMMARY_WATCHDOG_MARKER, wd)
		const agentEvent = {
			type: "item.completed",
			item: {
				type: "agent_message",
				text: "Review finished.\nREVIEW SUMMARY: verdict=accepted; issue=#54; actionable=0; reason=ok\n",
			},
		}
		const line = `${JSON.stringify(agentEvent)}\n`

		observer.observeStdout(line.slice(0, 24))
		expect(wd.state()).toEqual({ kind: "idle" })
		observer.observeStdout(line.slice(24))

		expect(fake.timers.length).toBe(1)
		expect(wd.state()).toEqual({ kind: "armed" })
	})

	test("codex summary extractor only accepts real agent summary lines", () => {
		const commandLine = JSON.stringify({
			type: "item.completed",
			item: { type: "command_execution", aggregated_output: "REVIEW SUMMARY: verdict=<...>" },
		})
		const proseLine = JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text: "I will print REVIEW SUMMARY: after finishing." },
		})
		const summaryLine = JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text: "REVIEW SUMMARY: verdict=accepted; issue=#54; actionable=0; reason=ok" },
		})

		expect(codexSummaryTextFromJsonLine(commandLine, REVIEW_SUMMARY_WATCHDOG_MARKER)).toBeNull()
		expect(codexSummaryTextFromJsonLine(proseLine, REVIEW_SUMMARY_WATCHDOG_MARKER)).toBeNull()
		expect(codexSummaryTextFromJsonLine(summaryLine, REVIEW_SUMMARY_WATCHDOG_MARKER)).toContain("verdict=accepted")
	})

	test("summary watchdog: cancel before SIGTERM timer fires prevents both SIGTERM and SIGKILL (clean child exit case)", () => {
		const fake = makeFakeTimers()
		const calls: string[] = []
		const wd = createSummaryWatchdog({
			config: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => calls.push("term"),
			onKill: () => calls.push("kill"),
			log: () => {},
		})

		wd.observeStdout("ITERATION SUMMARY: about to exit\n")
		expect(fake.timers.length).toBe(1)
		expect(fake.timers[0]!.cancelled).toBe(false)

		// Simulate child.on("close") firing before the 300s elapse
		wd.cancel()
		expect(fake.timers[0]!.cancelled).toBe(true)
		expect(calls).toEqual([])
		expect(wd.state()).toEqual({ kind: "cancelled" })
	})

	test("summary watchdog: stdout never contains ITERATION SUMMARY → no timers scheduled, no signals sent (mid-work crash path)", () => {
		const fake = makeFakeTimers()
		const calls: string[] = []
		const wd = createSummaryWatchdog({
			config: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 300_000, killMs: 5_000 },
			setTimer: fake.setTimer,
			clearTimer: fake.clearTimer,
			onTerm: () => calls.push("term"),
			onKill: () => calls.push("kill"),
			log: () => {},
		})

		wd.observeStdout(`{"event":"build"}\n`)
		wd.observeStdout(`{"event":"test"}\n`)
		wd.observeStdout(`partial line without the marker word`)
		expect(fake.timers.length).toBe(0)
		expect(wd.state()).toEqual({ kind: "idle" })

		// Cancel after a non-armed run is also a no-op (no kill calls)
		wd.cancel()
		expect(calls).toEqual([])
	})
})

describe("summary watchdog e2e — spawnOneAttempt with a fake claudeBinary", () => {
	async function makeFakeClaudeBinary(scriptBody: string): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-fakebin-"))
		const path = resolve(dir, "fake-claude.sh")
		await writeFile(path, `#!/bin/bash\n${scriptBody}\n`, { mode: 0o755 })
		return path
	}

	async function fixtureOptions(claudeBinary: string): Promise<LoopOptions> {
		const preset = await bundledPreset()
		const opts = await makeFixtureOptions(preset)
		const claudeRunner = { kind: "claude" as const, binary: claudeBinary, extraArgs: [], model: null }
		return {
			...opts,
			defaultRunner: { ...claudeRunner, source: "config" as const },
			runnerCommands: { ...opts.runnerCommands, claude: claudeRunner },
		}
	}

	test("summary watchdog e2e: fake binary prints SUMMARY then sleeps; watchdog SIGTERM closes attempt, terminated=watchdog", async () => {
		const fake = await makeFakeClaudeBinary(
			[
				`echo '{"event":"prelude"}'`,
				// Print SUMMARY then sleep way longer than the watchdog window
				`echo 'ITERATION SUMMARY: pretending to be done'`,
				// Use sleep loop so SIGTERM actually has work to interrupt
				`sleep 30`,
			].join("\n"),
		)
		const options = await fixtureOptions(fake)
		const outputPath = resolve(options.logDir, `wd-e2e.iteration.txt`)
		const sessionsPath = agentSessionsPath(outputPath)

		const start = Date.now()
		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored by fake binary",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			watchdog: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 800, killMs: 200 },
			attemptTimeout: { termMs: 500, killMs: 200, attemptSeconds: 0.5 },
		})
		const elapsedMs = Date.now() - start

		expect(outcome.terminated.kind).toBe("watchdog")
		if (outcome.terminated.kind === "watchdog") {
			expect(outcome.terminated.phase === "term" || outcome.terminated.phase === "kill").toBe(true)
		}
		// 800ms term + <=200ms kill + bash spawn overhead — must finish well under 10s
		expect(elapsedMs).toBeLessThan(10_000)

		// sessions.jsonl must persist the watchdog termination so a re-read decides fresh next tick
		const last = await readLastSessionEntry(sessionsPath)
		expect(last?.terminated.kind).toBe("watchdog")
	}, 15_000)

	test("absolute attempt timeout e2e: fake binary never prints SUMMARY; timeout SIGTERM closes attempt", async () => {
		const fake = await makeFakeClaudeBinary(`sleep 30`)
		const baseOptions = await fixtureOptions(fake)
		const options: LoopOptions = {
			...baseOptions,
			preset: {
				...baseOptions.preset,
				agent: { ...baseOptions.preset.agent, attemptTimeoutSeconds: 0.3 },
			},
		}
		const outputPath = resolve(options.logDir, `attempt-timeout.iteration.txt`)
		const sessionsPath = agentSessionsPath(outputPath)

		const start = Date.now()
		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored by fake binary",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			watchdog: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 5_000, killMs: 1_000 },
		})
		const elapsedMs = Date.now() - start

		expect(outcome.terminated.kind).toBe("timeout")
		if (outcome.terminated.kind === "timeout") {
			expect(outcome.terminated.phase === "term" || outcome.terminated.phase === "kill").toBe(true)
			expect(outcome.terminated.attemptSeconds).toBe(0.3)
		}
		expect(outcome.exitCode).not.toBe(0)
		expect(elapsedMs).toBeLessThan(10_000)

		const last = await readLastSessionEntry(sessionsPath)
		expect(last?.terminated.kind).toBe("timeout")
		if (last?.terminated.kind === "timeout") {
			expect(last.terminated.attemptSeconds).toBe(0.3)
		}
		const status = JSON.parse(await readFile(outputPath.replace(/\.txt$/, ".status.json"), "utf-8")) as { terminated?: { kind?: string } }
		expect(status.terminated?.kind).toBe("timeout")
	}, 15_000)

	test("spawnOneAttempt uses input.agentCwd as the child cwd, not options.targetCwd", async () => {
		// Fake claude prints `pwd -P` so we get the real path even when mkdtemp returns a symlinked /var/folders/... on macOS.
		const fake = await makeFakeClaudeBinary(`echo "PWD=$(pwd -P)"`)
		const options = await fixtureOptions(fake)
		const otherRepo = await fs.realpath(await mkdtemp(resolve(tmpdir(), "coder-loop-otherrepo-")))
		const targetReal = await fs.realpath(options.targetCwd)
		const outputPath = resolve(options.logDir, "agentcwd.iteration.txt")
		const sessionsPath = agentSessionsPath(outputPath)

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: otherRepo,
		})

		expect(outcome.exitCode).toBe(0)
		expect(outcome.output).toContain(`PWD=${otherRepo}`)
		expect(outcome.output).not.toContain(`PWD=${targetReal}`)
	}, 10_000)

	test("summary watchdog e2e: fake binary prints SUMMARY then exits cleanly within window → no SIGTERM, terminated=clean", async () => {
		const fake = await makeFakeClaudeBinary(
			[
				`echo '{"event":"prelude"}'`,
				`echo 'ITERATION SUMMARY: done'`,
				`exit 0`,
			].join("\n"),
		)
		const options = await fixtureOptions(fake)
		const outputPath = resolve(options.logDir, `wd-e2e-clean.iteration.txt`)
		const sessionsPath = agentSessionsPath(outputPath)

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			watchdog: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 5_000, killMs: 1_000 },
		})

		expect(outcome.terminated.kind).toBe("clean")
		expect(outcome.exitCode).toBe(0)
	}, 10_000)

	test("spawnOneAttempt supports Codex JSONL thread ids and records runner model in status", async () => {
		const fake = await makeFakeClaudeBinary(
			[
				`echo '{"type":"thread.started","thread_id":"thread-codex-123"}'`,
				`echo '{"type":"turn.started"}'`,
				`echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'`,
				`exit 0`,
			].join("\n"),
		)
		const options = await fixtureOptions("claude")
		const outputPath = resolve(options.logDir, `codex.iteration.txt`)
		const sessionsPath = agentSessionsPath(outputPath)
		const runner = { kind: "codex" as const, source: "queue" as const, binary: fake, extraArgs: [], model: "gpt-5.4" }

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			runner,
		})

		expect(outcome.exitCode).toBe(0)
		expect(outcome.sessionId).toBe("thread-codex-123")
		const last = await readLastSessionEntry(sessionsPath)
		expect(last?.sessionId).toBe("thread-codex-123")
		expect(last?.runner).toBe("codex")
		expect(last?.model).toBe("gpt-5.4")
		const status = JSON.parse(await readFile(outputPath.replace(/\.txt$/, ".status.json"), "utf-8")) as { runner?: string; model?: string; sessionId?: string }
		expect(status.runner).toBe("codex")
		expect(status.model).toBe("gpt-5.4")
		expect(status.sessionId).toBe("thread-codex-123")
	}, 10_000)
})

describe("events jsonl — per-run NDJSON event stream", () => {
	async function freshTargetCwd(): Promise<string> {
		return mkdtemp(resolve(tmpdir(), "coder-loop-events-"))
	}

	async function readEvents(path: string): Promise<LoopEvent[]> {
		const raw = await readFile(path, "utf-8")
		return raw
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as LoopEvent)
	}

	async function emitSequence(targetCwd: string, runId: string, events: LoopEvent[]): Promise<string> {
		const emit = makeLoopEventEmitter(targetCwd, runId, () => {})
		for (const event of events) await emit(event)
		return loopEventsPath(targetCwd, runId)
	}

	const sampleBase = (overrides: Partial<LoopEvent> = {}): { runId: string; issueId: string; pr: number | null; branch: string | null } => ({
		runId: overrides.runId ?? "run-2026-05-12-issue-99",
		issueId: overrides.issueId ?? "99",
		pr: (overrides as { pr?: number | null }).pr ?? null,
		branch: (overrides as { branch?: string | null }).branch ?? null,
	})

	test("events jsonl: writes per-runId file with controlled type strings in chronological order", async () => {
		const targetCwd = await freshTargetCwd()
		const runId = "run-2026-05-12-issue-99"
		const sequence: LoopEvent[] = [
			{ type: "queue.select", ts: "2026-05-12T00:00:00.000Z", ...sampleBase(), status: "queued" },
			{ type: "phase.start", ts: "2026-05-12T00:00:01.000Z", ...sampleBase(), phase: "iteration" },
			{
				type: "attempt.start",
				ts: "2026-05-12T00:00:02.000Z",
				...sampleBase(),
				phase: "iteration",
				attemptStartedAt: "2026-05-12T00:00:02.000Z",
				pid: 12345,
				resume: "fresh",
			},
			{
				type: "attempt.close",
				ts: "2026-05-12T00:00:03.000Z",
				...sampleBase(),
				phase: "iteration",
				attemptStartedAt: "2026-05-12T00:00:02.000Z",
				exitCode: 0,
				signal: null,
				terminated: { kind: "clean" },
				sessionId: "sess-abc",
			},
			{
				type: "phase.end",
				ts: "2026-05-12T00:00:04.000Z",
				...sampleBase(),
				phase: "iteration",
				exitCode: 0,
				durationSeconds: 3,
			},
			{ type: "phase.start", ts: "2026-05-12T00:00:05.000Z", ...sampleBase({ pr: 137 }), phase: "review" },
			{
				type: "phase.end",
				ts: "2026-05-12T00:00:06.000Z",
				...sampleBase({ pr: 137 }),
				phase: "review",
				exitCode: 0,
				durationSeconds: 1,
			},
			{
				type: "queue.terminal",
				ts: "2026-05-12T00:00:07.000Z",
				...sampleBase({ pr: 137 }),
				terminalStatus: "merged",
			},
		]
		const path = await emitSequence(targetCwd, runId, sequence)
		const events = await readEvents(path)

		expect(path.endsWith(`/.coder-loop/runtime/events/${runId}.jsonl`)).toBe(true)
		expect(events.length).toBe(sequence.length)
		for (const e of events) expect(LOOP_EVENT_TYPES).toContain(e.type)
		const timestamps = events.map((e) => e.ts)
		expect([...timestamps].sort()).toEqual(timestamps)
	})

	test("events jsonl fields: pr/branch reflect QueueItem state including null and concrete values", async () => {
		const targetCwd = await freshTargetCwd()
		const runId = "run-fields-test"
		const sequence: LoopEvent[] = [
			{ type: "queue.select", ts: "2026-05-12T00:00:00.000Z", runId, issueId: "100", pr: null, branch: null, status: "queued" },
			{
				type: "phase.start",
				ts: "2026-05-12T00:00:01.000Z",
				runId,
				issueId: "100",
				pr: 200,
				branch: "issue-100-feat",
				phase: "review",
			},
		]
		const path = await emitSequence(targetCwd, runId, sequence)
		const events = await readEvents(path)
		expect(events[0]?.pr).toBeNull()
		expect(events[0]?.branch).toBeNull()
		expect(events[1]?.pr).toBe(200)
		expect(events[1]?.branch).toBe("issue-100-feat")
		// Every non-loop-level event must carry runId + issueId + ts (criterion #2)
		for (const e of events) {
			expect(e.runId).toBe(runId)
			expect(e.issueId).toBe("100")
			expect(typeof e.ts).toBe("string")
		}
	})

	test("events jsonl watchdog: spawnOneAttempt with eventContext writes attempt.start, watchdog.fire, attempt.close", async () => {
		const targetCwd = await freshTargetCwd()
		const fake = await mkdtemp(resolve(tmpdir(), "coder-loop-fakebin-"))
		const fakePath = resolve(fake, "fake-claude.sh")
		await writeFile(fakePath, `#!/bin/bash\necho 'ITERATION SUMMARY: stuck path'\nsleep 30\n`, { mode: 0o755 })

		const preset = await bundledPreset()
		const baseOpts = await makeFixtureOptions(preset)
		const claudeRunner = { kind: "claude" as const, binary: fakePath, extraArgs: [], model: null }
		const options: LoopOptions = {
			...baseOpts,
			targetCwd,
			defaultRunner: { ...claudeRunner, source: "config" as const },
			runnerCommands: { ...baseOpts.runnerCommands, claude: claudeRunner },
		}
		const runId = "run-wd-events"
		const outputPath = resolve(options.logDir, "wd-events.iteration.txt")
		const sessionsPath = agentSessionsPath(outputPath)
		const eventsPath = loopEventsPath(targetCwd, runId)

		const eventContext: LoopEventContext = {
			emit: makeLoopEventEmitter(targetCwd, runId, () => {}),
			runId,
			issueId: "135",
			pr: 137,
			branch: "issue-135-fix",
			phase: "iteration",
		}

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			watchdog: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 300, killMs: 200 },
			eventContext,
		})
		expect(outcome.terminated.kind).toBe("watchdog")

		const events = await readEvents(eventsPath)
		const types = events.map((e) => e.type)
		expect(types).toContain("attempt.start")
		expect(types).toContain("watchdog.fire")
		expect(types).toContain("attempt.close")
		// Order: attempt.start before watchdog.fire before attempt.close
		const startIdx = types.indexOf("attempt.start")
		const fireIdx = types.indexOf("watchdog.fire")
		const closeIdx = types.indexOf("attempt.close")
		expect(startIdx).toBeLessThan(fireIdx)
		expect(fireIdx).toBeLessThan(closeIdx)
		// attempt.close terminated.kind must be "watchdog"
		const closeEvent = events.find((e) => e.type === "attempt.close")
		expect(closeEvent?.type === "attempt.close" && closeEvent.terminated.kind).toBe("watchdog")
		// Every event carries the issue/pr/branch context
		for (const e of events) {
			expect(e.issueId).toBe("135")
			expect(e.pr).toBe(137)
			expect(e.branch).toBe("issue-135-fix")
		}
	}, 15_000)

	test("events jsonl absolute timeout: spawnOneAttempt writes attempt.timeout before attempt.close", async () => {
		const targetCwd = await freshTargetCwd()
		const fake = await mkdtemp(resolve(tmpdir(), "coder-loop-fakebin-"))
		const fakePath = resolve(fake, "fake-claude.sh")
		await writeFile(fakePath, `#!/bin/bash\nsleep 30\n`, { mode: 0o755 })

		const preset = await bundledPreset()
		const baseOpts = await makeFixtureOptions(preset)
		const claudeRunner = { kind: "claude" as const, binary: fakePath, extraArgs: [], model: null }
		const options: LoopOptions = {
			...baseOpts,
			targetCwd,
			defaultRunner: { ...claudeRunner, source: "config" as const },
			runnerCommands: { ...baseOpts.runnerCommands, claude: claudeRunner },
		}
		const runId = "run-timeout-events"
		const outputPath = resolve(options.logDir, "timeout-events.iteration.txt")
		const sessionsPath = agentSessionsPath(outputPath)
		const eventsPath = loopEventsPath(targetCwd, runId)

		const eventContext: LoopEventContext = {
			emit: makeLoopEventEmitter(targetCwd, runId, () => {}),
			runId,
			issueId: "117",
			pr: null,
			branch: "issue-117-timeout",
			phase: "iteration",
		}

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			watchdog: { marker: SUMMARY_WATCHDOG_MARKER, termMs: 5_000, killMs: 1_000 },
			attemptTimeout: { termMs: 300, killMs: 200, attemptSeconds: 0.3 },
			eventContext,
		})
		expect(outcome.terminated.kind).toBe("timeout")

		const events = await readEvents(eventsPath)
		const types = events.map((e) => e.type)
		expect(types).toContain("attempt.start")
		expect(types).toContain("attempt.timeout")
		expect(types).toContain("attempt.close")
		expect(types).not.toContain("watchdog.fire")
		const startIdx = types.indexOf("attempt.start")
		const timeoutIdx = types.indexOf("attempt.timeout")
		const closeIdx = types.indexOf("attempt.close")
		expect(startIdx).toBeLessThan(timeoutIdx)
		expect(timeoutIdx).toBeLessThan(closeIdx)
		const closeEvent = events.find((e) => e.type === "attempt.close")
		expect(closeEvent?.type === "attempt.close" && closeEvent.terminated.kind).toBe("timeout")
	}, 15_000)

	test("events jsonl no-watchdog clean exit: only attempt.start + attempt.close, no watchdog.fire", async () => {
		const targetCwd = await freshTargetCwd()
		const fake = await mkdtemp(resolve(tmpdir(), "coder-loop-fakebin-"))
		const fakePath = resolve(fake, "fake-claude.sh")
		await writeFile(fakePath, `#!/bin/bash\necho '{"event":"work"}'\nexit 0\n`, { mode: 0o755 })

		const preset = await bundledPreset()
		const baseOpts = await makeFixtureOptions(preset)
		const claudeRunner = { kind: "claude" as const, binary: fakePath, extraArgs: [], model: null }
		const options: LoopOptions = {
			...baseOpts,
			targetCwd,
			defaultRunner: { ...claudeRunner, source: "config" as const },
			runnerCommands: { ...baseOpts.runnerCommands, claude: claudeRunner },
		}
		const runId = "run-clean-events"
		const outputPath = resolve(options.logDir, "clean-events.iteration.txt")
		const sessionsPath = agentSessionsPath(outputPath)
		const eventsPath = loopEventsPath(targetCwd, runId)

		const eventContext: LoopEventContext = {
			emit: makeLoopEventEmitter(targetCwd, runId, () => {}),
			runId,
			issueId: "200",
			pr: null,
			branch: null,
			phase: "iteration",
		}

		const outcome = await spawnOneAttempt({
			options,
			label: "iteration",
			prompt: "ignored",
			outputPath,
			sessionsPath,
			resume: { kind: "fresh" },
			agentCwd: options.targetCwd,
			eventContext,
		})
		expect(outcome.terminated.kind).toBe("clean")

		const events = await readEvents(eventsPath)
		const types = events.map((e) => e.type)
		expect(types).toEqual(["attempt.start", "attempt.close"])
	}, 10_000)

	test("events jsonl best-effort: appendLoopEvent failure (parent path is a file) only logs warn and resolves", async () => {
		const targetCwd = await freshTargetCwd()
		// Make the events directory's parent a file so mkdir(recursive) cannot create the path
		const sabotage = resolve(targetCwd, ".coder-loop/runtime/events")
		await mkdir(resolve(targetCwd, ".coder-loop/runtime"), { recursive: true })
		await writeFile(sabotage, "this-is-a-file-not-a-directory")
		const logs: string[] = []
		const path = loopEventsPath(targetCwd, "run-fail")
		await expect(
			appendLoopEvent(
				path,
				{
					type: "queue.select",
					ts: "2026-05-12T00:00:00.000Z",
					runId: "run-fail",
					issueId: "1",
					pr: null,
					branch: null,
					status: "queued",
				},
				(m) => logs.push(m),
			),
		).resolves.toBeUndefined()
		expect(logs.some((m) => m.includes("events.jsonl append failed"))).toBe(true)
	})

	test("events jsonl format: formatLoopEventLine produces single-line compact JSON terminated by \\n (jq -c compatible)", () => {
		const event: LoopEvent = {
			type: "queue.terminal",
			ts: "2026-05-12T00:00:00.000Z",
			runId: "r",
			issueId: "1",
			pr: 2,
			branch: "b",
			terminalStatus: "merged",
		}
		const line = formatLoopEventLine(event)
		expect(line.endsWith("\n")).toBe(true)
		expect(line.indexOf("\n")).toBe(line.length - 1)
		expect(JSON.parse(line.slice(0, -1))).toEqual(event)
	})

	test("events jsonl tail e2e: tail -n +1 + jq filters phase.start rows showing issue/phase/pr per line", async () => {
		const targetCwd = await freshTargetCwd()
		const runId = "run-jq-e2e"
		const sequence: LoopEvent[] = [
			{ type: "queue.select", ts: "2026-05-12T00:00:00.000Z", runId, issueId: "135", pr: null, branch: null, status: "queued" },
			{ type: "phase.start", ts: "2026-05-12T00:00:01.000Z", runId, issueId: "135", pr: null, branch: "issue-135-fix", phase: "iteration" },
			{ type: "phase.end", ts: "2026-05-12T00:00:10.000Z", runId, issueId: "135", pr: null, branch: "issue-135-fix", phase: "iteration", exitCode: 0, durationSeconds: 9 },
			{ type: "phase.start", ts: "2026-05-12T00:00:11.000Z", runId, issueId: "135", pr: 137, branch: "issue-135-fix", phase: "review" },
			{ type: "phase.end", ts: "2026-05-12T00:00:14.000Z", runId, issueId: "135", pr: 137, branch: "issue-135-fix", phase: "review", exitCode: 0, durationSeconds: 3 },
		]
		const path = await emitSequence(targetCwd, runId, sequence)
		const proc = Bun.spawnSync({
			cmd: [
				"bash",
				"-c",
				`tail -n +1 "${path}" | jq -r 'select(.type=="phase.start") | "\\(.issueId) \\(.phase) pr=\\(.pr // "null")"'`,
			],
		})
		const stdout = new TextDecoder().decode(proc.stdout).trim()
		const lines = stdout.split("\n")
		expect(lines).toEqual(["135 iteration pr=null", "135 review pr=137"])
	})
})

// --- worktree ---

describe("worktreeBasePath / worktreePathForItem", () => {
	test("worktreeBasePath places worktrees one level up from targetCwd under .coder-loop-worktrees/<basename>", () => {
		const target = "/home/dev/projects/my-app"
		const result = worktreeBasePath(target)
		expect(result).toBe(resolve("/home/dev/projects", ".coder-loop-worktrees", "my-app"))
	})

	test("worktreePathForItem sanitizes special characters in itemId", () => {
		const target = "/repo/target"
		const result = worktreePathForItem(target, "feat/fix#123")
		expect(basename(result)).toBe("feat_fix_123")
		expect(result.startsWith(worktreeBasePath(target))).toBe(true)
	})

	test("worktreePathForItem preserves already-safe itemId characters", () => {
		const target = "/repo/target"
		expect(basename(worktreePathForItem(target, "42"))).toBe("42")
		expect(basename(worktreePathForItem(target, "my-item_01"))).toBe("my-item_01")
	})
})

describe("buildDaemonStartPlan with worktree flags", () => {
	test("--worktree and --base-branch appear in daemon start command when set", async () => {
		const target = await makeStatusTarget()
		const plan = buildDaemonStartPlan({
			action: "start",
			targetCwd: target,
			configPath: null,
			repository: "owner/repo",
			requireBrowserEvidence: false,
			maxIterations: 5,
			dryRun: false,
			worktree: true,
			baseBranch: "develop",
		})

		expect(plan.command).toContain("--worktree")
		expect(plan.command).toContain("--base-branch")
		expect(plan.command).toContain("develop")
		expect(plan.commandLine).toContain("--worktree")
		expect(plan.commandLine).toContain("--base-branch")
		expect(plan.commandLine).toContain("develop")
	})

	test("--worktree and --base-branch are absent when worktree is false", async () => {
		const target = await makeStatusTarget()
		const plan = buildDaemonStartPlan({
			action: "start",
			targetCwd: target,
			configPath: null,
			repository: "owner/repo",
			requireBrowserEvidence: false,
			maxIterations: 3,
			dryRun: false,
			worktree: false,
			baseBranch: null,
		})

		expect(plan.command).not.toContain("--worktree")
		expect(plan.command).not.toContain("--base-branch")
	})
})

describe("checkRuntime worktree validation", () => {
	test("worktree mode with empty baseBranch produces an error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		options.worktree = true
		;(options as Record<string, unknown>).baseBranch = ""
		const state = makeState({ queue: [makeItem({ issue: 1, status: "queued" })] })
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "worktree" && /baseBranch/.test(e.message))).toBe(true)
	})

	test("worktree mode with null baseBranch produces an error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		options.worktree = true
		;(options as Record<string, unknown>).baseBranch = null
		const state = makeState({ queue: [makeItem({ issue: 1, status: "queued" })] })
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "worktree" && /baseBranch/.test(e.message))).toBe(true)
	})
})

// --- worktree git integration tests ---

async function makeGitFixture(): Promise<{ remote: string; clone: string }> {
	const base = await mkdtemp(resolve(tmpdir(), "coder-loop-wt-"))
	const remote = resolve(base, "remote.git")
	const clone = resolve(base, "clone")

	const run = (cwd: string, cmd: string[]) => {
		const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
		if (proc.exitCode !== 0) {
			throw new Error(`git command failed: ${cmd.join(" ")} in ${cwd}: ${new TextDecoder().decode(proc.stderr)}`)
		}
		return new TextDecoder().decode(proc.stdout).trim()
	}

	run(base, ["git", "init", "--bare", "-b", "main", remote])
	run(base, ["git", "clone", remote, clone])
	run(clone, ["git", "config", "user.email", "test@test.com"])
	run(clone, ["git", "config", "user.name", "Test"])
	await writeFile(resolve(clone, "README.md"), "# fixture\n")
	run(clone, ["git", "add", "README.md"])
	run(clone, ["git", "commit", "-m", "initial"])
	run(clone, ["git", "push", "origin", "main"])

	return { remote, clone }
}

describe("worktree git integration", () => {
	test("validateWorktreePrerequisites succeeds when origin/<baseBranch> exists", async () => {
		const { clone } = await makeGitFixture()
		expect(() => validateWorktreePrerequisites(clone, "main")).not.toThrow()
	})

	test("validateWorktreePrerequisites throws when baseBranch does not exist on remote", async () => {
		const { clone } = await makeGitFixture()
		expect(() => validateWorktreePrerequisites(clone, "nonexistent-branch")).toThrow(/does not exist/)
	})

	test("ensureWorktreeForItem creates a worktree visible in git worktree list", async () => {
		const { clone } = await makeGitFixture()
		const wtPath = ensureWorktreeForItem(clone, "main", "42", null)

		expect(wtPath).toBe(worktreePathForItem(clone, "42"))

		const proc = Bun.spawnSync({ cmd: ["git", "worktree", "list", "--porcelain"], cwd: clone, stdout: "pipe" })
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(stdout).toContain(basename(wtPath))
	})

	test("ensureWorktreeForItem reuses existing worktree on second call", async () => {
		const { clone } = await makeGitFixture()
		const first = ensureWorktreeForItem(clone, "main", "42", null)
		const second = ensureWorktreeForItem(clone, "main", "42", first)
		expect(second).toBe(first)
	})

	test("removeWorktreeForItem removes the worktree", async () => {
		const { clone } = await makeGitFixture()
		ensureWorktreeForItem(clone, "main", "99", null)

		const logs: string[] = []
		removeWorktreeForItem(clone, "99", (m) => logs.push(m))

		const proc = Bun.spawnSync({ cmd: ["git", "worktree", "list", "--porcelain"], cwd: clone, stdout: "pipe" })
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(stdout).not.toContain("coder-loop/99")
	})

	test("cleanupStaleWorktrees removes worktrees not in the active set", async () => {
		const { clone } = await makeGitFixture()
		ensureWorktreeForItem(clone, "main", "active-1", null)
		ensureWorktreeForItem(clone, "main", "stale-1", null)

		const logs: string[] = []
		cleanupStaleWorktrees(clone, new Set(["active-1"]), (m) => logs.push(m))

		const proc = Bun.spawnSync({ cmd: ["git", "worktree", "list", "--porcelain"], cwd: clone, stdout: "pipe" })
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(stdout).toContain("active-1")
		expect(stdout).not.toContain("stale-1")
		expect(logs.some((l) => l.includes("stale-1"))).toBe(true)
	})

	test("worktree branch is named coder-loop/<sanitized-id>", async () => {
		const { clone } = await makeGitFixture()
		const wtPath = ensureWorktreeForItem(clone, "main", "77", null)

		const proc = Bun.spawnSync({ cmd: ["git", "branch", "--list", "coder-loop/77"], cwd: clone, stdout: "pipe" })
		const stdout = new TextDecoder().decode(proc.stdout).trim()
		expect(stdout).toContain("coder-loop/77")
	})

	test("worktree directory contains the repo files", async () => {
		const { clone } = await makeGitFixture()
		const wtPath = ensureWorktreeForItem(clone, "main", "55", null)

		const readmePath = resolve(wtPath, "README.md")
		const content = await readFile(readmePath, "utf-8")
		expect(content).toBe("# fixture\n")
	})

	test("AC#2: item.agentCwd persists worktree path through serializeState round-trip", async () => {
		const { clone } = await makeGitFixture()
		const wtPath = ensureWorktreeForItem(clone, "main", "42", null)

		const item = makeItem({ issue: 42, status: "in_progress" })
		item.agentCwd = wtPath
		const state = makeState({ queue: [item] })

		const serialized = serializeState(state)
		const parsed = JSON.parse(serialized)
		expect(parsed.queue[0].agentCwd).toBe(wtPath)
	})
})
