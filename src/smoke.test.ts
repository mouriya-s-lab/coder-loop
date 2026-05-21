import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { openStateStore } from "./state-db"
import { chainRuntimePaths, defaultChainNameForTarget, ensureChainRuntimeSkeleton } from "./runtime-paths"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const SMOKE_LOOP_DATA_ROOT = resolve(REPO_ROOT, ".cache/smoke-loop-data")

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
	env.CODER_LOOP_DATA_ROOT = SMOKE_LOOP_DATA_ROOT
	delete env["CODEX_SHELL"]
	delete env["CODEX_THREAD_ID"]
	delete env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]
	return env
}

function loopControlPathForTarget(target: string, root = SMOKE_LOOP_DATA_ROOT): string {
	return resolve(chainRuntimePaths(root, defaultChainNameForTarget(target)).chainDir, "loop-control")
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

async function makeGhIssuePrTarget(kind: string, issue: number): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-gh-issue-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, `evidence/issue-${issue}`), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# gh issue fixture workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# shared\n\nNo durable facts.\n")
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({ preset: "gh-issue-pr-iteration" }, null, 2))
	await writeFile(resolve(runtime, `issues/${issue}.md`), [
		`# Issue ${issue}`,
		"",
		"Unblocks: owner/repo#9000",
		"",
		`Fixture handoff for kind:${kind}.`,
		"",
	].join("\n"))
	await writeFile(resolve(runtime, "state.json"), JSON.stringify({
		version: 1,
		queue: [{
			issue,
			status: "queued",
			attempts: 0,
			title: `Fixture kind:${kind}`,
			priority: "high",
			branch: null,
			pr: null,
			lastRunId: null,
			issueFile: `.coder-loop/runtime/issues/${issue}.md`,
			evidenceDir: `.coder-loop/runtime/evidence/issue-${issue}`,
			agentCwd: null,
			runner: null,
			kind,
		}],
		repository: null,
		baseBranch: "main",
		recentRuns: [],
		current: null,
	}, null, 2))
	return dir
}

async function makePolicyOnlyGhIssuePrTarget(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-gh-policy-only-"))
	await mkdir(resolve(dir, ".coder-loop"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# gh issue fixture workflow\n")
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}: expected object`)
	return value as Record<string, unknown>
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label}: expected array`)
	return value
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
	test("--check-runtime and --dry-run pass from SQLite chain metadata without target runtime", async () => {
		const target = await mkdtemp(resolve(tmpdir(), "coder-loop-db-runtime-"))
		const root = resolve(target, "loop-data")
		await mkdir(resolve(target, ".coder-loop"), { recursive: true })
		await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
		const chainName = defaultChainNameForTarget(target)
		const chainPaths = chainRuntimePaths(root, chainName)
		await ensureChainRuntimeSkeleton(chainPaths)
		const store = openStateStore(resolve(root, "state.db"))
		try {
			store.upsertChain(chainName, "gh-issue-pr-iteration", "owner/repo", "main", null, null, { targetCwd: target })
		} finally {
			store.close()
		}
		const env = { ...process.env, CODER_LOOP_DATA_ROOT: root }

		const check = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env,
		})
		const checkStderr = new TextDecoder().decode(check.stderr)
		expect(check.exitCode).toBe(0)
		expect(checkStderr).toContain(`Runtime check passed: state=${resolve(root, "state.db")} (chain=${chainName})`)
		expect(checkStderr).toContain("Runtime check passed: queue=0, selected=none")
		expect(await Bun.file(resolve(target, ".coder-loop/runtime")).exists()).toBe(false)

		const dryRun = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env,
		})
		const dryRunStderr = new TextDecoder().decode(dryRun.stderr)
		expect(dryRun.exitCode).toBe(0)
		expect(dryRunStderr).toContain(`Dry run: state=${resolve(root, "state.db")} (chain=${chainName})`)
		expect(dryRunStderr).toContain("Dry run: selected=none")
		expect(await Bun.file(resolve(target, ".coder-loop/runtime")).exists()).toBe(false)
	})

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

	test("--dry-run selects the blocked resolver route for fixture", async () => {
		const target = await makeGhIssuePrTarget("blocked", 9002)
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: selected=9002")
		expect(stderr).toContain("Dry run: kind=blocked")
		expect(stderr).toContain("Dry run: iterationRoute=iter/resolve-blocker")
		expect(stderr).not.toContain("Dry run: noMerge=true")
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

	test("daemon status <target> --json emits parseable central daemon snapshot when socket is down", async () => {
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
		const snapshot = asRecord(JSON.parse(stdout), "daemon status")
		expect(snapshot.target).toBe(target)
		expect(asRecord(snapshot.daemon, "daemon").ok).toBe(false)
		expect(snapshot.chain).toBeNull()
		expect(asArray(snapshot.items, "items")).toEqual([])
		expect(asArray(snapshot.slots, "slots")).toEqual([])
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
		expect(stdout).toContain("daemon start dry-run: daemon-up-command=")
		expect(stdout).toContain("daemon start dry-run: socket=")
		expect(stdout).toContain("require-browser-evidence=true")
		expect(stdout).toContain("spawn-agents=true")
	})

	test("daemon start/status/stop <target> import and pause target items through central socket", async () => {
		const target = await makeGhIssuePrTarget("code", 9300)
		const root = resolve(REPO_ROOT, ".cache", `smoke-daemon-compat-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const socket = resolve(root, "daemon.sock")
		const pid = resolve(root, "daemon.pid")
		const db = resolve(root, "state.db")
		const daemonFlags = [
			"--root", root,
			"--socket", socket,
			"--pid", pid,
			"--db", db,
			"--scheduler-interval-ms", "600000",
			"--no-spawn-agents",
		]
		try {
			const startDown = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "start", target, ...daemonFlags],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			const startDownStdout = new TextDecoder().decode(startDown.stdout)
			expect(new TextDecoder().decode(startDown.stderr)).toBe("")
			expect(startDown.exitCode).toBe(0)
			const startDownJson = asRecord(JSON.parse(startDownStdout), "start down")
			expect(asRecord(startDownJson.daemon, "start down daemon").started).toBe(true)
			const importResult = asRecord(startDownJson.import, "start down import")
			expect(importResult.imported).toBe(1)
			expect(asArray(asRecord(startDownJson.status, "start down status").items, "start down items")[0]).toMatchObject({
				issue: 9300,
				status: "queued",
				repoCwd: target,
			})
			const rootEntries = await readdir(root)
			expect(rootEntries).toContain("chains")
			expect(rootEntries).not.toContain("logs")
			expect(rootEntries).not.toContain("events")
			expect(rootEntries.some((entry) => entry.startsWith("daemon-up-"))).toBe(false)
			const chainEntries = await readdir(resolve(root, "chains", String(importResult.chainName)))
			expect(chainEntries).toEqual(expect.arrayContaining(["daemon", "evidence", "issues", "runs", "shared.md"]))

			const stop = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "stop", target, "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(stop.stderr)).toBe("")
			expect(stop.exitCode).toBe(0)
			const stopJson = asRecord(JSON.parse(new TextDecoder().decode(stop.stdout)), "stop")
			expect(stopJson.updated).toBe(1)
			expect(asArray(stopJson.items, "stopped items")[0]).toMatchObject({ issue: 9300, status: "paused" })

			const startUp = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "start", target, ...daemonFlags],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(startUp.stderr)).toBe("")
			expect(startUp.exitCode).toBe(0)
			const startUpJson = asRecord(JSON.parse(new TextDecoder().decode(startUp.stdout)), "start up")
			expect(asRecord(startUpJson.daemon, "start up daemon").started).toBe(false)
			expect(asRecord(startUpJson.import, "start up import").updated).toBe(1)
			expect(asArray(asRecord(startUpJson.status, "start up status").items, "start up items")[0]).toMatchObject({
				issue: 9300,
				status: "queued",
			})

			const status = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "status", target, "--socket", socket, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(status.stderr)).toBe("")
			expect(status.exitCode).toBe(0)
			const statusJson = asRecord(JSON.parse(new TextDecoder().decode(status.stdout)), "status")
			expect(asRecord(statusJson.daemon, "status daemon").ok).toBe(true)
			expect(asRecord(statusJson.chain, "status chain").name).toBeTruthy()
			expect(asArray(statusJson.items, "status items")[0]).toMatchObject({ issue: 9300, status: "queued" })
			expect(asArray(statusJson.slots, "status slots")).toEqual([])
		} finally {
			Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "down", "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			await rm(root, { recursive: true, force: true })
		}
	})

	test("daemon start/status/stop <target> works without target runtime directory", async () => {
		const target = await makePolicyOnlyGhIssuePrTarget()
		const root = resolve(REPO_ROOT, ".cache", `smoke-daemon-db-native-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const socket = resolve(root, "daemon.sock")
		const pid = resolve(root, "daemon.pid")
		const db = resolve(root, "state.db")
		const daemonFlags = [
			"--root", root,
			"--socket", socket,
			"--pid", pid,
			"--db", db,
			"--scheduler-interval-ms", "600000",
			"--no-spawn-agents",
		]
		try {
			const start = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "start", target, "--repo", "owner/repo", ...daemonFlags],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(start.stderr)).toBe("")
			expect(start.exitCode).toBe(0)
			const startJson = asRecord(JSON.parse(new TextDecoder().decode(start.stdout)), "start")
			expect(asRecord(startJson.daemon, "start daemon").started).toBe(true)
			const importResult = asRecord(startJson.import, "start import")
			expect(importResult.legacyStateFound).toBe(false)
			expect(importResult.itemsSeen).toBe(0)
			expect(importResult.imported).toBe(0)
			expect(asRecord(importResult.chain, "import chain")).toMatchObject({
				name: defaultChainNameForTarget(target),
				repository: "owner/repo",
			})

			const status = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "status", target, "--socket", socket, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(status.stderr)).toBe("")
			expect(status.exitCode).toBe(0)
			const statusJson = asRecord(JSON.parse(new TextDecoder().decode(status.stdout)), "status")
			expect(asRecord(statusJson.daemon, "status daemon").ok).toBe(true)
			expect(asRecord(statusJson.chain, "status chain").name).toBe(defaultChainNameForTarget(target))
			expect(asArray(statusJson.items, "status items")).toEqual([])

			const stop = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "stop", target, "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(stop.stderr)).toBe("")
			expect(stop.exitCode).toBe(0)
			const stopJson = asRecord(JSON.parse(new TextDecoder().decode(stop.stdout)), "stop")
			expect(stopJson.updated).toBe(0)
			expect(asArray(stopJson.items, "stopped items")).toEqual([])
		} finally {
			Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "down", "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			await rm(root, { recursive: true, force: true })
		}
	})

	test("chain and item CLI manage DB-native work and report completion", async () => {
		const root = resolve(REPO_ROOT, ".cache", `smoke-chain-item-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const target = resolve(root, "target-repo")
		await mkdir(target, { recursive: true })
		try {
			const create = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "create", "release", "--preset", "gh-issue-pr-iteration", "--repo", "owner/repo", "--base-branch", "main", "--umbrella", "owner/repo#42", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(create.stderr)).toBe("")
			expect(create.exitCode).toBe(0)
			const created = asRecord(JSON.parse(new TextDecoder().decode(create.stdout)), "created chain")
			expect(created).toMatchObject({ name: "release", status: "active", umbrellaRepo: "owner/repo", umbrellaIssue: 42 })

			const listed = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "list", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(listed.exitCode).toBe(0)
			expect(asArray(JSON.parse(new TextDecoder().decode(listed.stdout)), "chains")).toHaveLength(1)

			const add = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "item", "add", "release", "--issue", "42", "--repo-cwd", target, "--priority", "high", "--extra", "{\"kind\":\"code\"}", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(add.stderr)).toBe("")
			expect(add.exitCode).toBe(0)
			const item = asRecord(JSON.parse(new TextDecoder().decode(add.stdout)), "created item")
			expect(item).toMatchObject({ issue: 42, repoCwd: target, status: "queued", priority: "high" })
			const itemId = Number(item.id)

			const queued = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "item", "list", "release", "--status", "queued", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(queued.exitCode).toBe(0)
			expect(asArray(JSON.parse(new TextDecoder().decode(queued.stdout)), "queued items")).toHaveLength(1)

			const update = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "item", "update", String(itemId), "--status", "done", "--extra", "{\"reviewed\":true}", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(update.stderr)).toBe("")
			expect(update.exitCode).toBe(0)
			expect(asRecord(JSON.parse(new TextDecoder().decode(update.stdout)), "updated item")).toMatchObject({
				id: itemId,
				status: "done",
				extra: { kind: "code", reviewed: true },
			})

			const status = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "status", "release", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(status.stderr)).toBe("")
			expect(status.exitCode).toBe(0)
			const report = asRecord(JSON.parse(new TextDecoder().decode(status.stdout)), "chain status")
			expect(asRecord(report.chain, "status chain")).toMatchObject({ status: "completed", umbrellaRepo: "owner/repo", umbrellaIssue: 42 })
			expect(asRecord(asRecord(report.items, "items").byStatus, "byStatus").done).toBe(1)
			expect(typeof asRecord(report.chain, "status chain").completedAt).toBe("string")

			const statusHuman = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "status", "release", "--root", root],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			const statusHumanStdout = new TextDecoder().decode(statusHuman.stdout)
			expect(statusHuman.exitCode).toBe(0)
			expect(statusHumanStdout).toContain("Status: completed")
			expect(statusHumanStdout).toContain("Umbrella: owner/repo#42")
			expect(statusHumanStdout).toContain("done=1")

			const deleted = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "delete", "release", "--root", root, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(deleted.exitCode).toBe(0)
			expect(asRecord(JSON.parse(new TextDecoder().decode(deleted.stdout)), "delete result")).toMatchObject({ deleted: true, chain: "release" })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("legacy daemon --target-cwd commands resolve a non-default chain by repo_cwd", async () => {
		const root = resolve(REPO_ROOT, ".cache", `smoke-daemon-target-cwd-chain-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const target = resolve(root, "repo")
		const socket = resolve(root, "daemon.sock")
		const pid = resolve(root, "daemon.pid")
		const db = resolve(root, "state.db")
		await mkdir(target, { recursive: true })
		try {
			const create = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "chain", "create", "custom-chain", "--preset", "gh-issue-pr-iteration", "--repo", "owner/repo", "--root", root],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(create.exitCode).toBe(0)
			const add = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "item", "add", "custom-chain", "--issue", "9301", "--repo-cwd", target, "--root", root],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(add.exitCode).toBe(0)

			const daemonFlags = [
				"--root", root,
				"--socket", socket,
				"--pid", pid,
				"--db", db,
				"--scheduler-interval-ms", "600000",
				"--no-spawn-agents",
			]
			const start = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "start", "--target-cwd", target, ...daemonFlags],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(start.stderr)).toBe("")
			expect(start.exitCode).toBe(0)
			const startJson = asRecord(JSON.parse(new TextDecoder().decode(start.stdout)), "start")
			expect(asRecord(startJson.import, "import").chainName).toBe("custom-chain")
			expect(asRecord(startJson.status, "status").chainName).toBe("custom-chain")
			expect(asRecord(asRecord(startJson.import, "import").chain, "import chain").repository).toBe("owner/repo")

			const status = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "status", "--target-cwd", target, "--socket", socket, "--json"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(status.stderr)).toBe("")
			expect(status.exitCode).toBe(0)
			const statusJson = asRecord(JSON.parse(new TextDecoder().decode(status.stdout)), "daemon status")
			expect(statusJson.chainName).toBe("custom-chain")
			expect(asArray(statusJson.items, "status items")[0]).toMatchObject({ issue: 9301, repoCwd: target })

			const stop = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "stop", "--target-cwd", target, "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			expect(new TextDecoder().decode(stop.stderr)).toBe("")
			expect(stop.exitCode).toBe(0)
			const stopJson = asRecord(JSON.parse(new TextDecoder().decode(stop.stdout)), "stop")
			expect(stopJson.chainName).toBe("custom-chain")
			expect(asArray(stopJson.items, "stopped items")[0]).toMatchObject({ issue: 9301, status: "paused" })
		} finally {
			Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "daemon", "down", "--socket", socket],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			})
			await rm(root, { recursive: true, force: true })
		}
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

	test("bundled blocked-responder trigger uses the blocked item's target agentCwd", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-bundled-responder-"))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const targetRepo = resolve(dir, "dependency-repo")
		const responderCwdLog = resolve(runtime, "blocked-responder-cwd.txt")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/issue-9100"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(targetRepo, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# bundled responder fixture workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# shared\n")

		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`prompt="$*"`,
			`if [[ "$prompt" == *"blocked-responder agent"* ]]; then pwd > ${JSON.stringify(responderCwdLog)}; fi`,
			`echo '{"type":"thread.started","thread_id":"thread-bundled-responder"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			`node -e 'const fs = require("fs"); const [path, agentCwd] = process.argv.slice(1); const state = JSON.parse(fs.readFileSync(path, "utf8")); state.queue[0].status = "blocked"; state.queue[0].blockerRepo = "owner/dependency"; state.queue[0].blockerRef = "#267"; state.queue[0].agentCwd = agentCwd; state.current = null; fs.writeFileSync(path, JSON.stringify(state, null, "\\t") + "\\n");' ${JSON.stringify(resolve(runtime, "state.json"))} ${JSON.stringify(targetRepo)}`,
			`echo 'REVIEW SUMMARY: verdict=blocked; issue=#9100; actionable=1; reason=fixture cross-repo blocker'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			preset: "gh-issue-pr-iteration",
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		await writeFile(resolve(runtime, "state.json"), JSON.stringify({
			version: 1,
			queue: [{
				issue: 9100,
				kind: "code",
				status: "queued",
				attempts: 0,
				title: "Fixture bundled blocked responder",
				priority: "medium",
				branch: null,
				pr: null,
				lastRunId: null,
				issueFile: null,
				evidenceDir: ".coder-loop/runtime/evidence/issue-9100",
				agentCwd: null,
				runner: null,
			}],
			repository: null,
			baseBranch: null,
			recentRuns: [],
			current: null,
		}, null, 2))

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Starting trigger phase blocked-responder after review")
		expect((await readFile(responderCwdLog, "utf-8")).trim()).toBe(await realpath(targetRepo))
		const state = JSON.parse(await readFile(resolve(runtime, "state.json"), "utf-8"))
		expect(state.queue[0].status).toBe("blocked")
		expect(state.queue[0].agentCwd).toBe(targetRepo)
	})
})

describe("smoke: queue unblock CLI", () => {
	test("requeues a blocked item and clears blocker metadata without touching unrelated fields", async () => {
		const issue = 9200
		const dir = await makeGhIssuePrTarget("blocked", issue)
		const statePath = resolve(dir, ".coder-loop/runtime/state.json")
		const state = JSON.parse(await readFile(statePath, "utf-8"))
		state.queue[0].status = "blocked"
		state.queue[0].blockerRepo = "owner/dependency"
		state.queue[0].blockerRef = "#267"
		state.current = { phase: "review", runId: "r1", startedAt: "2026-05-20T00:00:00.000Z", issue }
		await writeFile(statePath, JSON.stringify(state, null, "\t") + "\n")

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "queue", "unblock", dir, "--issue", "owner/source#9200"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const result = JSON.parse(stdout)
		expect(result.mutation.changed).toBe(true)
		expect(result.mutation.clearedBlockerRepo).toBe(true)
		expect(result.mutation.clearedBlockerRef).toBe(true)
		expect(result.daemon.skipped).toBe(true)
		expect(result.verification.itemStatus).toBe("queued")
		expect(result.verification.blockerRepoPresent).toBe(false)
		expect(result.verification.blockerRefPresent).toBe(false)

		const updated = JSON.parse(await readFile(statePath, "utf-8"))
		expect(updated.queue[0].status).toBe("queued")
		expect(updated.queue[0].blockerRepo).toBeUndefined()
		expect(updated.queue[0].blockerRef).toBeUndefined()
		expect(updated.current).toBeNull()
	})

	test("dry-run reports daemon start plan without writing state", async () => {
		const issue = 9201
		const dir = await makeGhIssuePrTarget("blocked", issue)
		const statePath = resolve(dir, ".coder-loop/runtime/state.json")
		const state = JSON.parse(await readFile(statePath, "utf-8"))
		state.queue[0].status = "blocked"
		state.queue[0].blockerRepo = "owner/dependency"
		state.queue[0].blockerRef = "#267"
		await writeFile(statePath, JSON.stringify(state, null, "\t") + "\n")

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "queue", "unblock", dir, "--issue", "#9201", "--start-daemon", "--require-browser-evidence", "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(proc.exitCode).toBe(0)
		const result = JSON.parse(stdout)
		expect(result.dryRun).toBe(true)
		expect(result.daemon.requested).toBe(true)
		expect(result.daemon.plan.requireBrowserEvidence).toBe(true)
		expect(result.daemon.plan.command).toContain("daemon")
		expect(result.daemon.plan.command).toContain("up")

		const updated = JSON.parse(await readFile(statePath, "utf-8"))
		expect(updated.queue[0].status).toBe("blocked")
		expect(updated.queue[0].blockerRepo).toBe("owner/dependency")
		expect(updated.queue[0].blockerRef).toBe("#267")
	})
})

describe("smoke: phase runner selection", () => {
	test("per-run layout writes events and phase artifacts under chain runs", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-per-run-layout-"))
		const root = resolve(REPO_ROOT, ".cache", `smoke-per-run-layout-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const runtime = resolve(dir, ".coder-loop/runtime")
		const presetDir = resolve(dir, ".coder-loop/per-run-layout-preset")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

		await writeFile(resolve(presetDir, "preset.toml"), [
			`name = "per-run-layout-smoke"`,
			`version = 1`,
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
			`echo '{"type":"thread.started","thread_id":"thread-layout-smoke"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			`node -e 'const fs = require("fs"); const path = process.argv[1]; const state = JSON.parse(fs.readFileSync(path, "utf8")); state.queue[0].status = "done"; state.current = null; fs.writeFileSync(path, JSON.stringify(state, null, "\\t") + "\\n");' ${JSON.stringify(resolve(runtime, "state.json"))}`,
			`echo 'REVIEW SUMMARY: verdict=accepted; issue=#alpha; actionable=0; reason=fixture'`,
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

		try {
			const proc = Bun.spawnSync({
				cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...claudeHostEnv(), CODER_LOOP_DATA_ROOT: root },
			})
			expect(new TextDecoder().decode(proc.stderr)).toContain("Iteration 1 (work) complete.")
			expect(proc.exitCode).toBe(0)
			const state = JSON.parse(await readFile(resolve(runtime, "state.json"), "utf-8"))
			const runId = state.queue[0].lastRunId
			expect(typeof runId).toBe("string")
			const rootEntries = await readdir(root)
			expect(rootEntries).toContain("chains")
			expect(rootEntries).not.toContain("logs")
			expect(rootEntries).not.toContain("events")
			const runDir = resolve(root, "chains", defaultChainNameForTarget(dir), "runs", runId)
			expect(await pathExists(resolve(runDir, "events.jsonl"))).toBe(true)
			for (const phase of ["iteration", "review"]) {
				expect(await pathExists(resolve(runDir, phase, "stdout.jsonl"))).toBe(true)
				expect(await pathExists(resolve(runDir, phase, "stderr.txt"))).toBe(true)
				expect(await pathExists(resolve(runDir, phase, "status.json"))).toBe(true)
				expect(await pathExists(resolve(runDir, phase, "sessions.jsonl"))).toBe(true)
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 15_000)

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

	test("review verdict=stop removes loop-control even when the review runner cannot remove it", async () => {
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
		expect(await Bun.file(loopControlPathForTarget(dir)).exists()).toBe(false)
		expect(stderr).toContain("review agent requested loop stop via REVIEW SUMMARY; removing loop control file.")
		expect(stderr).toContain("Review agent stopped the loop.")
	}, 15_000)

	test("quoted old review stop summary does not remove loop-control without a final stop verdict", async () => {
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
		expect(await Bun.file(loopControlPathForTarget(dir)).exists()).toBe(true)
		expect(stderr).not.toContain("review agent requested loop stop via REVIEW SUMMARY; removing loop control file.")
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
		devLoopPath: loopControlPathForTarget(dir),
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
			env: { ...process.env, CODER_LOOP_DATA_ROOT: SMOKE_LOOP_DATA_ROOT, CODER_LOOP_IDLE_SLEEP_MS: "50" },
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
			env: { ...process.env, CODER_LOOP_DATA_ROOT: SMOKE_LOOP_DATA_ROOT, CODER_LOOP_IDLE_SLEEP_MS: "50" },
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
			env: { ...process.env, CODER_LOOP_DATA_ROOT: SMOKE_LOOP_DATA_ROOT, CODER_LOOP_IDLE_SLEEP_MS: "50" },
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
