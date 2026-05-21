import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	daemonRateLimitDecision,
	sendDaemonRequest,
	startDaemonServer,
	type DaemonRateLimitState,
} from "./daemon"
import { defaultChainNameForTarget } from "./runtime-paths"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DAEMON_TEST_ROOT = resolve(REPO_ROOT, ".cache/daemon-tests")

async function withDaemonPaths<T>(name: string, fn: (paths: { root: string; db: string; socket: string; pid: string }) => Promise<T>): Promise<T> {
	const root = resolve(DAEMON_TEST_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	await mkdir(root, { recursive: true })
	const paths = {
		root,
		db: resolve(root, "state.db"),
		socket: resolve(root, "daemon.sock"),
		pid: resolve(root, "daemon.pid"),
	}
	try {
		return await fn(paths)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

async function readDaemonStdoutLogs(root: string): Promise<string> {
	let combined = ""
	async function visit(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const path = resolve(dir, entry.name)
			if (entry.isDirectory()) {
				await visit(path)
			} else if (entry.isFile() && entry.name === "stdout.log") {
				combined += await readFile(path, "utf-8")
			}
		}
	}
	await visit(resolve(root, "chains"))
	return combined
}

async function waitForDaemonStdout(root: string, pattern: string): Promise<string> {
	const deadline = Date.now() + 2_000
	let text = ""
	while (Date.now() < deadline) {
		text = await readDaemonStdoutLogs(root)
		if (text.includes(pattern)) return text
		await Bun.sleep(50)
	}
	return text
}

describe("daemon socket IPC", () => {
	test("rate limit scheduling decision pauses until reset and then staggers one slot", () => {
		const state: DaemonRateLimitState = {
			reset: { resetsAt: 200, resetAtIso: "1970-01-01T00:03:20.000Z", rateLimitType: "five_hour" },
			observedAt: "1970-01-01T00:00:00.000Z",
			sourceRunId: "daemon-1",
			sourceItemId: 1,
			nextResumeAtMs: null,
		}
		expect(daemonRateLimitDecision(state, 199_000)).toEqual({ kind: "paused", waitMs: 1_000, maxSpawns: 0 })
		expect(daemonRateLimitDecision(state, 200_000)).toEqual({ kind: "stagger-ready", maxSpawns: 1 })
		state.nextResumeAtMs = 230_000
		expect(daemonRateLimitDecision(state, 210_000)).toEqual({ kind: "stagger-wait", waitMs: 20_000, maxSpawns: 0 })
	})

	test("serves chain, item, slot, status, and shutdown requests over JSON lines", async () => {
		await withDaemonPaths("ipc", async (paths) => {
			await startDaemonServer({
				rootDir: paths.root,
				dbPath: paths.db,
				socketPath: paths.socket,
				pidPath: paths.pid,
				schedulerIntervalMs: 600_000,
				spawnAgents: false,
			})

			expect(existsSync(paths.socket)).toBe(true)
			expect(existsSync(paths.pid)).toBe(true)

			const created = await sendDaemonRequest(paths.socket, {
				cmd: "chain.create",
				name: "daemon-test-chain",
				preset: "gh-issue-pr-iteration",
				repo: "owner/repo",
				baseBranch: "main",
				umbrellaIssue: 127,
				umbrellaRepo: "owner/repo",
			})
			expect(created.ok).toBe(true)
			if (!created.ok || typeof created.data !== "object" || created.data === null || Array.isArray(created.data)) throw new Error("expected chain object")
			expect(created.data.name).toBe("daemon-test-chain")
			expect(created.data.umbrellaIssue).toBe(127)

			const added = await sendDaemonRequest(paths.socket, {
				cmd: "item.add",
				chain: "daemon-test-chain",
				issue: 127,
				repoCwd: REPO_ROOT,
				priority: "high",
				extra: { issueKind: "code" },
			})
			expect(added.ok).toBe(true)
			if (!added.ok || typeof added.data !== "object" || added.data === null || Array.isArray(added.data)) throw new Error("expected item object")
			expect(added.data.issue).toBe(127)
			expect(added.data.priority).toBe("high")
			const itemId = Number(added.data.id)

			const listed = await sendDaemonRequest(paths.socket, { cmd: "item.list", chain: "daemon-test-chain" })
			expect(listed.ok).toBe(true)
			if (!listed.ok || !Array.isArray(listed.data)) throw new Error("expected item list")
			expect(listed.data).toHaveLength(1)

			const updated = await sendDaemonRequest(paths.socket, {
				cmd: "item.update",
				itemId,
				patch: { status: "done", pr: 144 },
			})
			expect(updated.ok).toBe(true)
			if (!updated.ok || typeof updated.data !== "object" || updated.data === null || Array.isArray(updated.data)) throw new Error("expected updated item")
			expect(updated.data.status).toBe("done")
			expect(updated.data.pr).toBe(144)

			const completed = await sendDaemonRequest(paths.socket, { cmd: "chain.complete", chain: "daemon-test-chain" })
			expect(completed.ok).toBe(true)
			if (!completed.ok || typeof completed.data !== "object" || completed.data === null || Array.isArray(completed.data)) throw new Error("expected completed chain")
			expect(completed.data.status).toBe("completed")

			const slots = await sendDaemonRequest(paths.socket, { cmd: "slot.list" })
			expect(slots.ok).toBe(true)
			if (!slots.ok || !Array.isArray(slots.data)) throw new Error("expected slot list")
			expect(slots.data).toEqual([])

			const status = await sendDaemonRequest(paths.socket, { cmd: "daemon.status" })
			expect(status.ok).toBe(true)
			if (!status.ok || typeof status.data !== "object" || status.data === null || Array.isArray(status.data)) throw new Error("expected daemon status")
			expect(status.data.socketPath).toBe(paths.socket)
			expect(status.data.activeChildren).toBe(0)

			const shutdown = await sendDaemonRequest(paths.socket, { cmd: "daemon.shutdown" })
			expect(shutdown.ok).toBe(true)

			await Bun.sleep(100)
			expect(existsSync(paths.socket)).toBe(false)
			expect(existsSync(paths.pid)).toBe(false)
		})
	})

	test("scheduler spawns queued DB items without target runtime state", async () => {
		await withDaemonPaths("spawn-db-native", async (paths) => {
			const target = resolve(paths.root, "policy-only-target")
			await mkdir(resolve(target, ".coder-loop"), { recursive: true })
			await writeFile(resolve(target, ".coder-loop/workflow.md"), "# policy only\n")
			const script = "console.log(JSON.stringify({root:process.env.CODER_LOOP_DATA_ROOT,cwd:process.cwd(),args:process.argv.slice(2)}))"
			const handle = await startDaemonServer({
				rootDir: paths.root,
				dbPath: paths.db,
				socketPath: paths.socket,
				pidPath: paths.pid,
				schedulerIntervalMs: 50,
				spawnAgents: true,
				processArgs: ["bun", "-e", script],
			})
			try {
				const chainName = defaultChainNameForTarget(target)
				const created = await sendDaemonRequest(paths.socket, {
					cmd: "chain.create",
					name: chainName,
					preset: "gh-issue-pr-iteration",
					repo: "owner/repo",
					baseBranch: "main",
				})
				expect(created.ok).toBe(true)
				const added = await sendDaemonRequest(paths.socket, {
					cmd: "item.add",
					chain: chainName,
					issue: 147,
					repoCwd: target,
				})
				expect(added.ok).toBe(true)

				const stdout = await waitForDaemonStdout(paths.root, `"root":"${paths.root}"`)
				expect(stdout).toContain(`"cwd":"${target}"`)
				expect(stdout).toContain(target)
				expect(existsSync(resolve(target, ".coder-loop/runtime/state.json"))).toBe(false)
			} finally {
				await handle.shutdown()
			}
		})
	})

	test("daemon-wide rate limit notice pauses later slot dispatch", async () => {
		await withDaemonPaths("rate-limit-pause", async (paths) => {
			const firstTarget = resolve(paths.root, "first-target")
			const secondTarget = resolve(paths.root, "second-target")
			await mkdir(resolve(firstTarget, ".coder-loop"), { recursive: true })
			await mkdir(resolve(secondTarget, ".coder-loop"), { recursive: true })
			await writeFile(resolve(firstTarget, ".coder-loop/workflow.md"), "# policy only\n")
			await writeFile(resolve(secondTarget, ".coder-loop/workflow.md"), "# policy only\n")
			const resetsAt = Math.floor(Date.now() / 1000) + 120
			const script = [
				`console.error('CODER_LOOP_RATE_LIMIT ${JSON.stringify({ resetsAt, resetAtIso: new Date(resetsAt * 1000).toISOString(), rateLimitType: "five_hour" })}')`,
				`console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))`,
				"process.exit(1)",
			].join(";")
			const handle = await startDaemonServer({
				rootDir: paths.root,
				dbPath: paths.db,
				socketPath: paths.socket,
				pidPath: paths.pid,
				schedulerIntervalMs: 50,
				spawnAgents: true,
				processArgs: ["bun", "-e", script],
			})
			try {
				const chainName = "rate-limit-chain"
				expect((await sendDaemonRequest(paths.socket, {
					cmd: "chain.create",
					name: chainName,
					preset: "gh-issue-pr-iteration",
					repo: "owner/repo",
					baseBranch: "main",
				})).ok).toBe(true)
				expect((await sendDaemonRequest(paths.socket, {
					cmd: "item.add",
					chain: chainName,
					issue: 137,
					repoCwd: firstTarget,
				})).ok).toBe(true)

				await waitForDaemonStdout(paths.root, `"cwd":"${firstTarget}"`)
				let status = await sendDaemonRequest(paths.socket, { cmd: "daemon.status" })
				expect(status.ok).toBe(true)
				if (!status.ok || typeof status.data !== "object" || status.data === null || Array.isArray(status.data)) throw new Error("expected daemon status")
				expect(status.data.rateLimit).toMatchObject({
					active: true,
					rateLimitedUntilUnix: resetsAt,
					rateLimitType: "five_hour",
				})

				expect((await sendDaemonRequest(paths.socket, {
					cmd: "item.add",
					chain: chainName,
					issue: 138,
					repoCwd: secondTarget,
				})).ok).toBe(true)
				await Bun.sleep(200)
				const stdout = await readDaemonStdoutLogs(paths.root)
				expect(stdout).toContain(`"cwd":"${firstTarget}"`)
				expect(stdout).not.toContain(`"cwd":"${secondTarget}"`)
			} finally {
				await handle.shutdown()
			}
		})
	})
})
