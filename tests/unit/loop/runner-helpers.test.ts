import { describe, expect, test } from "bun:test"

import {
	mkdir,
	relative,
	resolve,
	agentCodexArgs,
	agentOpencodeArgs,
	agentSessionsPath,
	buildDaemonStartPlan,
	parseSessionIdFromRunnerStream,
	stripRoleEntryFrontmatter,
	selectRunnerForPhase,
	Preset,
	REPO_ROOT,
	TEST_ROOT,
	makeItem,
	makePreset,
	makeOptions,
} from "./helpers"

describe("runner and daemon helpers", () => {
	// #456: item.runner override now applies uniformly to every non-trigger phase — the engine no
	// longer special-cases "the last non-trigger phase" (review under the bundled preset). Both
	// phases pick up the item override; phase-name-based gating belongs to preset declaration only.
	test("selectRunnerForPhase honors queue override on every non-trigger phase, regardless of phase name", () => {
		const base = makePreset()
		const preset: Preset = {
			...base,
			steps: base.steps.map((phase) =>
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
			steps: [
				{ name: "iteration", prompt: "iteration.md", variables: { ISSUE: "item.issue" } },
				{ name: "review", prompt: "review.md", runner: "codex", model: "gpt-5.5", variables: { ISSUE: "item.issue" } },
			],
		})
		expect(preset.steps[0]?.defaultModel).toBeNull()
		expect(preset.steps[1]?.defaultModel).toBe("gpt-5.5")

		expect(() =>
			makePreset({
				steps: [
					{ name: "iteration", prompt: "iteration.md", model: "  ", variables: { ISSUE: "item.issue" } },
					{ name: "review", prompt: "review.md", variables: { ISSUE: "item.issue" } },
				],
			}),
		).toThrow(/preset\.steps\[0\]\.model: must be a non-empty string/)
	})

	test("selectRunnerForPhase resolves the preset phase model when config declares none", () => {
		const preset = makePreset({
			steps: [
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
			steps: [
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
			steps: [
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

	test("buildDaemonStartPlan emits the central daemon command", async () => {
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

		expect(plan.command).toEqual([process.argv[0] ?? "bun", resolve(import.meta.dir, "../../../src/loop.ts"), "daemon", "up", "--loop-data-root", TEST_ROOT])
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
