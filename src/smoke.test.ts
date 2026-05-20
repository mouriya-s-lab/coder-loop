import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")

type ConfigShape = "json" | "toml"
type StatusSmokeSnapshot = {
	target?: { cwd?: string }
	state?: { kind?: string; ok?: boolean }
	queue?: { total?: number; selected?: { id?: string } | null }
	current?: object
	events?: object
	processes?: object
}

function claudeHostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env }
	env.CLAUDECODE = "1"
	delete env["CODEX_SHELL"]
	delete env["CODEX_THREAD_ID"]
	delete env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]
	return env
}

async function makeMinimalTarget(presetName: string, configShape: ConfigShape = "json"): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-smoke-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")
	if (configShape === "toml") {
		await writeFile(resolve(runtime, "config.toml"), `preset = "${presetName}"\n`)
	} else {
		await writeFile(
			resolve(runtime, "config.json"),
			JSON.stringify({ preset: presetName }, null, 2),
		)
	}
	const state = {
		version: 1,
		queue: [
			{ id: "alpha", status: "pending" },
			{ id: "beta", status: "pending" },
		],
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	return dir
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await readFile(path)
		return true
	} catch {
		return false
	}
}

async function makePostReviewTriggerTarget(reviewStatus: "blocked" | "done"): Promise<{ dir: string; responderLog: string }> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-trigger-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const presetDir = resolve(dir, ".coder-loop/post-review-trigger-preset")
	const responderLog = resolve(runtime, "responder-called.txt")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

	await writeFile(resolve(presetDir, "preset.toml"), [
		`name = "post-review-trigger-smoke"`,
		`version = 1`,
		`description = "Post-review trigger smoke preset."`,
		``,
		`[item]`,
		`idField = "id"`,
		``,
		`[statuses]`,
		`continuable = ["pending"]`,
		`terminal = ["blocked", "done"]`,
		``,
		`[[phases]]`,
		`name = "iteration"`,
		`prompt = "iter-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[[phases]]`,
		`name = "review"`,
		`prompt = "review-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[[phases]]`,
		`name = "responder"`,
		`prompt = "responder-entry.md"`,
		`trigger = { afterPhase = "review", whenStatus = "blocked" }`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[agent]`,
		`binary = "claude"`,
		`extraArgs = []`,
		``,
	].join("\n"))
	await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
	await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")
	await writeFile(resolve(presetDir, "responder-entry.md"), "RESPONDER {{ITEM_ID}} {{RUN_ID}}\n")

	const fakeCodex = resolve(dir, "fake-codex.sh")
	const fakeClaude = resolve(dir, "fake-claude.sh")
	await writeFile(fakeCodex, [
		`#!/usr/bin/env bash`,
		`if [[ "$*" == *RESPONDER* ]]; then printf 'responder\\n' >> ${JSON.stringify(responderLog)}; fi`,
		`echo '{"type":"thread.started","thread_id":"thread-trigger-smoke"}'`,
		`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })
	await writeFile(fakeClaude, [
		`#!/usr/bin/env bash`,
		`node -e 'const fs = require("fs"); const [path, status] = process.argv.slice(1); const state = JSON.parse(fs.readFileSync(path, "utf8")); state.queue[0].status = status; if (status === "blocked") { state.queue[0].blockerRepo = "owner/dependency"; state.queue[0].blockerRef = "#267"; } else { delete state.queue[0].blockerRepo; delete state.queue[0].blockerRef; } state.current = null; fs.writeFileSync(path, JSON.stringify(state, null, "\\t") + "\\n");' ${JSON.stringify(resolve(runtime, "state.json"))} ${JSON.stringify(reviewStatus)}`,
		`echo 'REVIEW SUMMARY: verdict=${reviewStatus === "blocked" ? "blocked" : "accepted"}; issue=#alpha; actionable=0; reason=fixture'`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })

	await writeFile(resolve(runtime, "config.json"), JSON.stringify({
		presetPath: presetDir,
		codex: { binary: fakeCodex, extraArgs: [] },
		claude: { binary: fakeClaude, extraArgs: [] },
	}, null, 2))
	await writeFile(resolve(runtime, "state.json"), JSON.stringify({
		version: 1,
		queue: [{
			id: "alpha",
			status: "pending",
			issueFile: ".coder-loop/runtime/issues/alpha.md",
			evidenceDir: ".coder-loop/runtime/evidence/alpha",
		}],
		recentRuns: [],
		current: null,
	}, null, 2))
	await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")
	return { dir, responderLog }
}

describe("smoke: single-phase-example preset", () => {
	test("--check-runtime passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Runtime check passed: target=")
		expect(stderr).toContain("Runtime check passed: preset=single-phase-example")
		expect(stderr).toContain("queue=2, selected=alpha")
		expect(stderr).not.toContain("repo=")
	})

	test("--dry-run passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: target=")
		expect(stderr).toContain("Dry run: selected=alpha")
		expect(stderr).not.toContain("repo=")
	})

	test("--dry-run selects the source-writing no-merge route for fixture", async () => {
		const target = resolve(REPO_ROOT, "test-fixtures/no-merge-code-spike-target")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: selected=9001")
		expect(stderr).toContain("Dry run: kind=code-spike")
		expect(stderr).toContain("Dry run: iterationRoute=iter/source-writing-spike")
		expect(stderr).toContain("Dry run: noMerge=true")
		expect(stderr).not.toContain("gh pr merge")
	})

	test("--check-runtime passes with config.toml only", async () => {
		const target = await makeMinimalTarget("single-phase-example", "toml")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Runtime check passed: preset=single-phase-example")
		expect(stderr).toContain("queue=2, selected=alpha")
		expect(stderr).toMatch(/config=.*config\.toml \(toml\)/)
	})

	test("status <target> --json emits parseable supervisor snapshot", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.target?.cwd).toBe(target)
		expect(snapshot.state?.kind).toBe("ok")
		expect(snapshot.state?.ok).toBe(true)
		expect(snapshot.queue?.total).toBe(2)
		expect(snapshot.queue?.selected?.id).toBe("alpha")
		expect(snapshot.current).toBeDefined()
		expect(snapshot.events).toBeDefined()
		expect(snapshot.processes).toBeDefined()
	})

	test("status <target> --json reports missing state as JSON instead of throwing", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		await rm(resolve(target, ".coder-loop/runtime/state.json"))
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(proc.exitCode).toBe(0)
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.state?.kind).toBe("missing-state")
		expect(snapshot.state?.ok).toBe(false)
	})

	test("daemon status <target> --json emits parseable process snapshot", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "daemon", "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.target?.cwd).toBe(target)
		expect(snapshot.processes).toBeDefined()
	})

	test("daemon start <target> --require-browser-evidence --dry-run shows the launch command", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "daemon", "start", target, "--require-browser-evidence", "--max-iterations", "10", "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		expect(stdout).toContain("daemon start dry-run: command=")
		expect(stdout).toContain("--require-browser-evidence")
		expect(stdout).toContain("require-browser-evidence=true")
		expect(stdout).toContain("'10'")
	})

	test("doctor <target> emits live runtime health section", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "doctor", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("[Live Runtime] coder-loop runtime health")
		expect(stderr).toContain("OK: state ok")
		expect(stderr).toContain("runner hostDefault=")
		expect(stderr).toContain("target default runner=")
		expect(stderr).toContain("queue total=2")
		expect(stderr).toContain("live processes total=")
	})

	test("doctor <target> checks the configured runner binary", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "codex",
				codex: { binary: "missing-codex-for-doctor-test" },
			}, null, 2),
		)
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "doctor", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("INFO: target default runner=codex (config, binary=missing-codex-for-doctor-test, model=<default>)")
		expect(stderr).toContain("INFO: review default runner=claude (review-default, binary=claude, model=claude-opus-4-7)")
		expect(stderr).toContain("FAIL: codex runner CLI (missing-codex-for-doctor-test) 未在 PATH 中")
	})
})

describe("smoke: post-review phase triggers", () => {
	test("runs a trigger phase when review changes the item to the matching status", async () => {
		const { dir, responderLog } = await makePostReviewTriggerTarget("blocked")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Starting trigger phase responder after review")
		expect(await readFile(responderLog, "utf-8")).toBe("responder\n")
		const state = JSON.parse(await readFile(resolve(dir, ".coder-loop/runtime/state.json"), "utf-8"))
		expect(state.queue[0].blockerRepo).toBe("owner/dependency")
		expect(state.queue[0].blockerRef).toBe("#267")
	})

	test("skips a trigger phase when review changes the item to a different status", async () => {
		const { dir, responderLog } = await makePostReviewTriggerTarget("done")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Skipping trigger phase responder: status=done, wanted=blocked")
		expect(await pathExists(responderLog)).toBe(false)
		const state = JSON.parse(await readFile(resolve(dir, ".coder-loop/runtime/state.json"), "utf-8"))
		expect(state.queue[0].blockerRepo).toBeUndefined()
		expect(state.queue[0].blockerRef).toBeUndefined()
	})
})

describe("smoke: phase runner selection", () => {
	test("default iteration runner uses Codex while review stays Claude", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-review-runner-"))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const presetDir = resolve(dir, ".coder-loop/two-phase-preset")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

		await writeFile(resolve(presetDir, "preset.toml"), [
			`name = "two-phase-smoke"`,
			`version = 1`,
			`description = "Two phase smoke preset."`,
			``,
			`[item]`,
			`idField = "id"`,
			``,
			`[statuses]`,
			`continuable = ["pending"]`,
			`terminal = ["done"]`,
			``,
			`[[phases]]`,
			`name = "iteration"`,
			`prompt = "iter-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[[phases]]`,
			`name = "review"`,
			`prompt = "review-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[agent]`,
			`binary = "claude"`,
			`extraArgs = []`,
			``,
		].join("\n"))
		await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
		await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")

		const callsPath = resolve(dir, "runner-calls.log")
		const claudeArgsPath = resolve(dir, "claude-args.log")
		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`echo codex >> "${callsPath}"`,
			`echo '{"type":"thread.started","thread_id":"thread-codex-smoke"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			`echo claude >> "${callsPath}"`,
			`printf '%s\\n' "$@" > "${claudeArgsPath}"`,
			`echo 'REVIEW SUMMARY: done'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			presetPath: presetDir,
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		await writeFile(resolve(runtime, "state.json"), JSON.stringify({
			version: 1,
			queue: [{
				id: "alpha",
				status: "pending",
				issueFile: ".coder-loop/runtime/issues/alpha.md",
				evidenceDir: ".coder-loop/runtime/evidence/alpha",
			}],
			recentRuns: [],
			current: null,
		}, null, 2))
		await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Selected runner: codex (iteration-default")
		expect(stderr).toContain("Review runner: claude (review-default")
		expect(stderr).toContain("model=claude-opus-4-7")
		expect((await readFile(callsPath, "utf-8")).trim().split("\n")).toEqual(["codex", "claude"])
		const claudeArgs = (await readFile(claudeArgsPath, "utf-8")).trim().split("\n")
		const modelIdx = claudeArgs.indexOf("--model")
		expect(modelIdx).toBeGreaterThanOrEqual(0)
		expect(claudeArgs[modelIdx + 1]).toBe("claude-opus-4-7")
	}, 15_000)

	async function makeTwoPhaseReviewTarget(reviewScript: readonly string[], prefix: string): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), prefix))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const presetDir = resolve(dir, ".coder-loop/two-phase-stop-preset")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

		await writeFile(resolve(presetDir, "preset.toml"), [
			`name = "two-phase-stop-smoke"`,
			`version = 1`,
			`description = "Two phase stop smoke preset."`,
			``,
			`[item]`,
			`idField = "id"`,
			``,
			`[statuses]`,
			`continuable = ["pending"]`,
			`terminal = ["done"]`,
			``,
			`[[phases]]`,
			`name = "iteration"`,
			`prompt = "iter-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[[phases]]`,
			`name = "review"`,
			`prompt = "review-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[agent]`,
			`binary = "claude"`,
			`extraArgs = []`,
			``,
		].join("\n"))
		await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
		await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")

		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`echo '{"type":"thread.started","thread_id":"thread-stop-smoke"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			...reviewScript,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			presetPath: presetDir,
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		await writeFile(resolve(runtime, "state.json"), JSON.stringify({
			version: 1,
			queue: [{
				id: "alpha",
				status: "pending",
				issueFile: ".coder-loop/runtime/issues/alpha.md",
				evidenceDir: ".coder-loop/runtime/evidence/alpha",
			}],
			recentRuns: [],
			current: null,
		}, null, 2))
		await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")
		return dir
	}

	test("review verdict=stop removes .dev-loop even when the review runner cannot remove it", async () => {
		const dir = await makeTwoPhaseReviewTarget([
			`echo 'gh issue comment failed: This command requires approval'`,
			`echo 'REVIEW SUMMARY: verdict=stop; issue=#alpha; actionable=1; reason=review infrastructure broken'`,
		], "coder-loop-review-stop-")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(await Bun.file(resolve(dir, ".dev-loop")).exists()).toBe(false)
		expect(stderr).toContain("review agent requested loop stop via REVIEW SUMMARY; removing .dev-loop.")
		expect(stderr).toContain("Review agent stopped the loop.")
	}, 15_000)

	test("quoted old review stop summary does not remove .dev-loop without a final stop verdict", async () => {
		const dir = await makeTwoPhaseReviewTarget([
			`echo 'old review log:'`,
			`echo 'REVIEW SUMMARY: verdict=stop; issue=#alpha; actionable=1; reason=review infrastructure broken'`,
			`echo 'review output ended without a final stop summary'`,
		], "coder-loop-review-stale-stop-")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(await Bun.file(resolve(dir, ".dev-loop")).exists()).toBe(true)
		expect(stderr).not.toContain("review agent requested loop stop via REVIEW SUMMARY; removing .dev-loop.")
		expect(stderr).not.toContain("Review agent stopped the loop.")
	}, 15_000)
})

async function makeIdleTarget(): Promise<{ target: string; counterPath: string; lockPath: string; devLoopPath: string }> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-idle-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

	const counterPath = resolve(dir, "fake-agent-calls.log")
	const fakeAgent = resolve(dir, "fake-agent.sh")
	await writeFile(
		fakeAgent,
		`#!/usr/bin/env bash
date "+%H:%M:%S.%N invocation" >> "${counterPath}"
echo "REVIEW SUMMARY: noop"
exit 0
`,
	)
	await Bun.spawnSync({ cmd: ["chmod", "+x", fakeAgent] })

	await writeFile(
		resolve(runtime, "config.json"),
		JSON.stringify({
			preset: "single-phase-example",
			runner: "claude",
			claude: { binary: fakeAgent, extraArgs: [] },
		}, null, 2),
	)
	await writeFile(
		resolve(runtime, "state.json"),
		JSON.stringify({ version: 1, queue: [], recentRuns: [], current: null }, null, 2),
	)
	return {
		target: dir,
		counterPath,
		lockPath: resolve(runtime, "review-on-empty.lock"),
		devLoopPath: resolve(dir, ".dev-loop"),
	}
}

async function fileLineCount(path: string): Promise<number> {
	try {
		const text = await readFile(path, "utf-8")
		return text.length === 0 ? 0 : text.split("\n").filter((line) => line.length > 0).length
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return true
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
	return false
}

describe("daemon idle behavior — review-on-empty lock + idle ticks (issue #69)", () => {
	test("empty queue: runs review-on-empty once, writes lock, subsequent idle ticks skip review until lock removed", async () => {
		const { target, counterPath, lockPath, devLoopPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		const lockAppeared = await waitFor(async () => (await fileLineCount(counterPath)) >= 1 && (await Bun.file(lockPath).exists()), 5000)
		expect(lockAppeared).toBe(true)
		const callsAfterFirstReview = await fileLineCount(counterPath)
		expect(callsAfterFirstReview).toBe(1)

		await new Promise((resolve) => setTimeout(resolve, 500))
		const callsAfterIdleTicks = await fileLineCount(counterPath)
		expect(callsAfterIdleTicks).toBe(1)

		await rm(devLoopPath, { force: true })
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)

		const stderr = await new Response(proc.stderr).text()
		expect(stderr).toContain("Empty queue: running review-on-empty for global state assessment.")
		expect(stderr).toContain("review-on-empty lock written:")
		const idleCount = (stderr.match(/Idle: empty queue \+ review-on-empty lock present\. Sleeping 50ms\./g) ?? []).length
		expect(idleCount).toBeGreaterThanOrEqual(2)

		const lockContent = JSON.parse(await readFile(lockPath, "utf-8"))
		expect(lockContent.reason).toBe("queue-drained")
		expect(typeof lockContent.runId).toBe("string")
		expect(lockContent.runId).toMatch(/^run-/)
	}, 15_000)

	test("removing the lock externally triggers a fresh review-on-empty on the next idle tick", async () => {
		const { target, counterPath, lockPath, devLoopPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		const firstLockSeen = await waitFor(async () => (await fileLineCount(counterPath)) >= 1 && (await Bun.file(lockPath).exists()), 5000)
		expect(firstLockSeen).toBe(true)

		await rm(lockPath, { force: true })

		const secondLockSeen = await waitFor(async () => {
			const calls = await fileLineCount(counterPath)
			const lockBack = await Bun.file(lockPath).exists()
			return calls >= 2 && lockBack
		}, 5000)
		expect(secondLockSeen).toBe(true)
		expect(await fileLineCount(counterPath)).toBe(2)

		await rm(devLoopPath, { force: true })
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)
	}, 15_000)

	test("idle ticks do not burn --max-iterations budget; daemon stays alive with --max-iterations=1 until removed", async () => {
		const { target, counterPath, devLoopPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "1"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		await waitFor(async () => (await fileLineCount(counterPath)) >= 1, 5000)
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(proc.exitCode).toBeNull()
		expect(await fileLineCount(counterPath)).toBe(1)

		await rm(devLoopPath, { force: true })
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)

		const stderr = await new Response(proc.stderr).text()
		expect(stderr).not.toContain("Reached 1 work iterations")
	}, 15_000)
})
