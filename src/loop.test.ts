import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
	buildConfigBindings,
	buildRuntimeBindings,
	checkRuntime,
	getCurrentId,
	getItemId,
	loadPreset,
	makeIssueRunContext,
	markIterationStarted,
	markReviewStarted,
	renderFragmentIndex,
	renderPrompt,
	resolveBinding,
	selectIssue,
	type ConfigBindings,
	type CurrentRun,
	type IssueRunContext,
	type LoopOptions,
	type LoopState,
	type Preset,
	type QueueItem,
	type ResolveContext,
	type RuntimeBindings,
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
		issue: overrides.issue,
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
		requireBrowserEvidence: false,
		claudeBinary: "claude",
		claudeExtraArgs: [],
		maxIterations: 1,
		dryRun: false,
		checkRuntime: false,
		preset,
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
		delete broken.issue
		expect(() => getItemId(broken, preset)).toThrow()
	})

	test("getCurrentId reads preset.item.idField from state.current (number → string)", async () => {
		const preset = await bundledPreset()
		const current: CurrentRun = { phase: "iteration", runId: "r1", startedAt: new Date().toISOString(), issue: 42 }
		expect(getCurrentId(current, preset)).toBe("42")
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
			current: { phase: "iteration", runId: "r1", startedAt: new Date().toISOString(), issue: 200 },
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
})

describe("markIterationStarted / markReviewStarted", () => {
	test("markIterationStarted sets queue item status, increments attempts when fresh, writes state.current.phase to first phase", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 55, status: "queued", attempts: 0 })
		const state = makeState({ queue: [item] })
		markIterationStarted(state, item, preset, "run-X", true)
		expect(state.queue[0]!.status).toBe("in_progress")
		expect(state.queue[0]!.attempts).toBe(1)
		expect(state.queue[0]!.lastRunId).toBe("run-X")
		expect(state.current).not.toBeNull()
		expect(state.current!.phase).toBe(preset.phases[0]!.name)
		expect(state.current!.runId).toBe("run-X")
		expect(state.current![preset.item.idField]).toBe(55)
	})

	test("markIterationStarted does not increment attempts when countAttempt=false (resume)", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 55, status: "in_progress", attempts: 3 })
		const state = makeState({ queue: [item] })
		markIterationStarted(state, item, preset, "run-Y", false)
		expect(state.queue[0]!.attempts).toBe(3)
		expect(state.queue[0]!.lastRunId).toBe("run-Y")
	})

	test("markReviewStarted writes state.current.phase to last phase, preserving id field type", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 99, status: "in_progress" })
		const state = makeState({ queue: [item] })
		markReviewStarted(state, item, preset, "run-Z")
		expect(state.current).not.toBeNull()
		expect(state.current!.phase).toBe(preset.phases[preset.phases.length - 1]!.name)
		expect(state.current!.runId).toBe("run-Z")
		expect(state.current![preset.item.idField]).toBe(99)
	})
})

describe("makeIssueRunContext", () => {
	test("fresh mode when no current and status is queued", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 1, status: "queued" })
		const ctx = makeIssueRunContext(item, null, preset)
		expect(ctx.mode).toBe("fresh")
		expect(ctx.previousRunId).toBeNull()
	})

	test("retry mode when status is changes_requested and no current", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 1, status: "changes_requested", lastRunId: "run-old" })
		const ctx = makeIssueRunContext(item, null, preset)
		expect(ctx.mode).toBe("retry")
		expect(ctx.previousRunId).toBe("run-old")
	})

	test("resume-iteration when current.phase is the first phase", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 1, status: "in_progress" })
		const current: CurrentRun = {
			phase: preset.phases[0]!.name,
			runId: "run-resume",
			startedAt: "2026-01-01T00:00:00Z",
			issue: 1,
		}
		const ctx = makeIssueRunContext(item, current, preset)
		expect(ctx.mode).toBe("resume-iteration")
		expect(ctx.previousRunId).toBe("run-resume")
	})

	test("resume-review when current.phase is the last phase", async () => {
		const preset = await bundledPreset()
		const item = makeItem({ issue: 1, status: "in_progress" })
		const current: CurrentRun = {
			phase: preset.phases[preset.phases.length - 1]!.name,
			runId: "run-resume",
			startedAt: "2026-01-01T00:00:00Z",
			issue: 1,
		}
		const ctx = makeIssueRunContext(item, current, preset)
		expect(ctx.mode).toBe("resume-review")
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
			current: { phase: "garbage", runId: "r", startedAt: "2026-01-01T00:00:00Z", issue: 1 },
		})
		const errors = await checkRuntime(options, state)
		expect(errors.some((e) => e.path === "state.current.phase" && e.message.includes("garbage"))).toBe(true)
	})

	test("queue item missing the id field declared by preset.item.idField produces an error", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const broken = makeItem({ issue: 1, status: "queued" })
		delete broken.issue
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
})

function makeFixtureRuntime(overrides: Partial<RuntimeBindings> = {}): RuntimeBindings {
	return {
		runId: "run-fixture",
		targetCwd: "/tmp/fixture-cwd",
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
		issueRunMode: "fresh",
		recoveryMode: "fresh",
		previousRunId: "",
		recoveryStartedAt: "",
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
		;(item as Record<string, unknown>).weird = { nested: true }
		const ctx: ResolveContext = { item, config: makeFixtureConfig(), runtime: makeFixtureRuntime() }
		expect(() => resolveBinding({ kind: "item", field: "weird" }, ctx)).toThrow(/item\.weird/)
	})
})

describe("renderPrompt with bundled preset", () => {
	test("substitutes all 25 KEY placeholders in a synthetic template (byte-equal expected output)", async () => {
		const preset = await bundledPreset()
		const phase = preset.phases[0]!
		const item = makeItem({
			issue: 131,
			status: "in_progress",
			branch: "feature/test",
			pr: 99,
		})
		const runtime = makeFixtureRuntime({
			runId: "run-2026-05-10-12-00-00-issue-131",
			fragmentIndex: "- frag1 (common): /tmp/fixture-preset/frag1.md\n- frag2 (review): /tmp/fixture-preset/frag2.md",
			issueRunMode: "resume-iteration",
			recoveryMode: "resume-iteration",
			previousRunId: "run-prev",
			recoveryStartedAt: "2026-05-10T11:50:00Z",
		})
		const config = makeFixtureConfig({ requireBrowserEvidence: true })
		const ctx: ResolveContext = { item, config, runtime }

		const keys = phase.variables.map(([k]) => k)
		const template = keys.map((k) => `${k}={{${k}}}`).join("\n")
		const rendered = renderPrompt(template, phase, ctx)

		const expectedLines: string[] = [
			`TARGET_CWD=${runtime.targetCwd}`,
			`REPO=${config.repository}`,
			`BASE_BRANCH=${config.baseBranch}`,
			`RUN_ID=${runtime.runId}`,
			`ISSUE=${item.issue}`,
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
			`ISSUE_RUN_MODE=${runtime.issueRunMode}`,
			`RECOVERY_MODE=${runtime.recoveryMode}`,
			`PREVIOUS_RUN_ID=${runtime.previousRunId}`,
			`RECOVERY_STARTED_AT=${runtime.recoveryStartedAt}`,
			`ISSUE_BRANCH=${item.branch}`,
			`ISSUE_PR=${item.pr}`,
			`ISSUE_STATUS=${item.status}`,
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
		const item = makeItem({ issue: 131, status: "in_progress", branch: "feature/x", pr: 99 })
		const ctx: ResolveContext = {
			item,
			config: makeFixtureConfig(),
			runtime: makeFixtureRuntime({ issueRunMode: "resume-review", recoveryMode: "resume-review" }),
		}
		const template = await readFile(phase.prompt, "utf-8")
		const rendered = renderPrompt(template, phase, ctx)
		const leftover = rendered.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g)
		expect(leftover).toBeNull()
	})
})

describe("buildRuntimeBindings / buildConfigBindings / renderFragmentIndex", () => {
	test("buildRuntimeBindings exposes all whitelisted runtime keys", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const issueRun: IssueRunContext = { mode: "fresh", previousRunId: null, startedAt: null, branch: null, pr: null, status: null }
		const runtime = buildRuntimeBindings({
			options,
			runId: "run-1",
			currentIssueFile: "/tmp/issue.md",
			evidenceDir: "/tmp/evidence",
			issueRun,
		})
		expect(runtime.runId).toBe("run-1")
		expect(runtime.targetCwd).toBe(options.targetCwd)
		expect(runtime.presetDir).toBe(preset.presetDir)
		expect(runtime.previousRunId).toBe("")
		expect(runtime.recoveryStartedAt).toBe("")
		expect(runtime.issueRunMode).toBe("fresh")
		expect(runtime.recoveryMode).toBe("fresh")
	})

	test("buildConfigBindings reads repository / baseBranch / requireBrowserEvidence from options", async () => {
		const preset = await bundledPreset()
		const options = await makeFixtureOptions(preset)
		const config = buildConfigBindings(options)
		expect(config.repository).toBe(options.repository)
		expect(config.baseBranch).toBe(options.baseBranch)
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
