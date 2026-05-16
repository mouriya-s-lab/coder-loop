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
		expect(stderr).toContain("queue total=2")
		expect(stderr).toContain("live processes total=")
	})
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
