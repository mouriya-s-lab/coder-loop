import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { resolve } from "node:path"

import { startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/central-cli-tests", String(process.pid))

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("central chain/item CLI", () => {
	test("chain CRUD CLI", async () => {
		const fixture = await startFixture("chain-crud")
		try {
			const created = expectJsonOk(await runCli(["chain", "create", "crud-chain", "--repo", "mouriya-s-lab/coder-loop", "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(created.chain).toMatchObject({
				name: "crud-chain",
				repository: "mouriya-s-lab/coder-loop",
				preset: "gh-issue-pr-iteration",
				status: "active",
			})

			const listed = expectJsonOk(await runCli(["chain", "list", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.chains).toHaveLength(1)
			expect(listed.chains[0]).toMatchObject({ name: "crud-chain", status: "active" })

			const status = expectJsonOk(await runCli(["chain", "status", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.chain).toMatchObject({ name: "crud-chain", status: "active" })
			expect(status.summary).toMatchObject({ completion: { state: "active", completedAt: null }, items: { total: 0, byStatus: {} } })

			const deleted = expectJsonOk(await runCli(["chain", "delete", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(deleted.chain).toMatchObject({ name: "crud-chain", status: "deleted" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain umbrella parsing", async () => {
		const fixture = await startFixture("umbrella")
		try {
			const created = expectJsonOk(await runCli([
				"chain",
				"create",
				"umbrella-chain",
				"--repo",
				"mouriya-s-lab/coder-loop",
				"--umbrella",
				"mouriya-s-lab/coder-loop#176",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			]))
			expect(created.chain).toMatchObject({
				umbrellaRepo: "mouriya-s-lab/coder-loop",
				umbrellaIssue: 176,
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("item CRUD CLI", async () => {
		const fixture = await startFixture("item-crud")
		try {
			expectJsonOk(await runCli(["chain", "create", "items-chain", "--repo", "mouriya-s-lab/coder-loop", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const added = expectJsonOk(await runCli([
				"item",
				"add",
				"items-chain",
				"--issue",
				"181",
				"--repo-cwd",
				REPO_ROOT,
				"--title",
				"feat: 引入 chain-item-daemon CLI 命令族",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			]))
			expect(added.item).toMatchObject({
				issueNumber: 181,
				repoCwd: REPO_ROOT,
				status: "queued",
				title: "feat: 引入 chain-item-daemon CLI 命令族",
			})

			const listed = expectJsonOk(await runCli(["item", "list", "items-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items).toHaveLength(1)
			expect(listed.items[0]).toMatchObject({ issueNumber: 181, status: "queued" })

			const updated = expectJsonOk(await runCli(["item", "update", "items-chain", "--issue", "181", "--status", "done", "--pr", "191", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(updated.item).toMatchObject({ issueNumber: 181, status: "done", pr: 191 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain status completion", async () => {
		const fixture = await startFixture("completion", { schedulerEnabled: true })
		try {
			expectJsonOk(await runCli(["chain", "create", "done-chain", "--repo", "mouriya-s-lab/coder-loop", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "done-chain", "--issue", "181", "--repo-cwd", REPO_ROOT, "--status", "done", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const status = await waitForJson(() => runCli(["chain", "status", "done-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]), (value) => value.chain?.status === "completed")
			expect(status.summary.completion.state).toBe("completed")
			expect(typeof status.summary.completion.completedAt).toBe("number")
			expect(status.summary.items.byStatus).toEqual({ done: 1 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon up down", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-down")
		const daemonProcess = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		try {
			await waitFor(async () => {
				const socketStat = await stat(resolve(loopDataRoot, "daemon.sock"))
				return socketStat.isSocket() ? true : null
			}, 5_000)
			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(JSON.parse(down.stdout)).toMatchObject({ ok: true, result: { shutdown: true } })
			expect(await daemonProcess.exited).toBe(0)
			const stdout = await new Response(daemonProcess.stdout).text()
			expect(JSON.parse(stdout)).toMatchObject({ action: "up", socketPath: resolve(loopDataRoot, "daemon.sock") })
		} finally {
			try {
				daemonProcess.kill()
			} catch {
				// Process may already have exited after daemon down.
			}
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("daemon not running explicit error", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `not-running-${++nextFixtureId}`)
		const result = await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("central daemon is not running")
		expect(result.stderr).toContain("coder-loop daemon up --loop-data-root")
	})

	test("json output schema stable", async () => {
		const fixture = await startFixture("json-schema")
		try {
			expectJsonOk(await runCli(["chain", "create", "schema-chain", "--repo", "mouriya-s-lab/coder-loop", "--umbrella", "mouriya-s-lab/coder-loop#176", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "schema-chain", "--issue", "181", "--repo-cwd", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const status = expectJsonOk(await runCli(["chain", "status", "schema-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			expect(Object.keys(status).sort()).toEqual(["activeRuns", "chain", "items", "summary"])
			expect(Object.keys(status.summary).sort()).toEqual(["activeSlots", "completion", "items", "umbrella"])
			expect(status.chain).toMatchObject({
				name: "schema-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaRepo: "mouriya-s-lab/coder-loop",
				umbrellaIssue: 176,
			})
			expect(status.items[0]).toMatchObject({ issueNumber: 181, status: "queued", repoCwd: REPO_ROOT })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("legacy daemon target-cwd unchanged", async () => {
		const start = await runCli(["daemon", "start", REPO_ROOT, "--dry-run", "--require-browser-evidence"])
		expect(start.exitCode).toBe(0)
		expect(start.stdout).toContain(`daemon start dry-run: target=${REPO_ROOT}`)
		expect(start.stdout).toContain("daemon start dry-run: require-browser-evidence=true")

		const stop = await runCli(["daemon", "stop", REPO_ROOT, "--dry-run"])
		expect(stop.exitCode).toBe(0)
		expect(stop.stdout).toContain("\"action\": \"stop\"")
		expect(stop.stdout).toContain(`\"target\": \"${REPO_ROOT}\"`)
	})
})

type Fixture = {
	daemon: CoderLoopDaemon
	loopDataRoot: string
}

type FixtureOptions = {
	schedulerEnabled?: boolean
}

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const loopDataRoot = await makeLoopDataRoot(name)
	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		scheduler: {
			enabled: options.schedulerEnabled ?? false,
			intervalMs: 20,
		},
	})
	return { daemon, loopDataRoot }
}

async function makeLoopDataRoot(name: string): Promise<string> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(root, { recursive: true })
	return resolve(root, "loop-data")
}

async function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return {
		exitCode,
		stdout,
		stderr,
	}
}

function expectJsonOk(result: { exitCode: number | null; stdout: string; stderr: string }) {
	expect(result.exitCode, result.stderr).toBe(0)
	return JSON.parse(result.stdout)
}

async function waitForJson(
	read: () => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
	predicate: (value: ReturnType<typeof expectJsonOk>) => boolean,
	timeoutMs = 2_000,
): Promise<ReturnType<typeof expectJsonOk>> {
	return await waitFor(async () => {
		const result = expectJsonOk(await read())
		return predicate(result) ? result : null
	}, timeoutMs)
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number, intervalMs = 20): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let latest: T | null = await read().catch(() => null)
	while (latest === null) {
		if (Date.now() > deadline) throw new Error("condition not met before timeout")
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
		latest = await read().catch(() => null)
	}
	return latest
}
