import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import {
	sendDaemonRequest,
	startDaemonServer,
} from "./daemon"

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

describe("daemon socket IPC", () => {
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
})
