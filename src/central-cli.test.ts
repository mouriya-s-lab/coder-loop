import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"
import { LOOP_DATA_ROOT_ENV } from "./runtime-paths"
import { reviewOnEmptyLockPathForChainName, serializeSchedulerReviewOnEmptyLock } from "./scheduler"
import { openSqliteStateStore } from "./sqlite-state"

function preInstallReviewOnEmptyLockByName(chainName: string, loopDataRoot: string, runId = "test-pre-installed"): void {
	const lockPath = reviewOnEmptyLockPathForChainName(chainName, { loopDataRoot })
	mkdirSync(resolve(lockPath, ".."), { recursive: true })
	writeFileSync(lockPath, serializeSchedulerReviewOnEmptyLock(runId, new Date(0)))
}

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/central-cli-tests", String(process.pid))
const DEFAULT_CHAIN_CONFIG = chainConfig("mouriya-s-lab/coder-loop")
const FIXTURE_CHAIN_CONFIG = chainConfig("fixture/repo")

let nextFixtureId = 0

function chainConfig(repository: string, baseBranch?: string): string {
	return JSON.stringify(baseBranch === undefined ? { repository } : { repository, baseBranch })
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("central chain/item CLI", () => {
	test("chain CRUD CLI", async () => {
		const fixture = await startFixture("chain-crud")
		try {
			const created = expectJsonOk(await runCli(["chain", "create", "crud-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
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

			const stopped = expectJsonOk(await runCli(["chain", "stop", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(stopped.chain).toMatchObject({ name: "crud-chain", status: "stopped" })
			expect(stopped.alreadyStopped).toBe(false)

			const stoppedStatus = expectJsonOk(await runCli(["chain", "status", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(stoppedStatus.chain).toMatchObject({ name: "crud-chain", status: "stopped" })
			expect(stoppedStatus.summary).toMatchObject({ completion: { state: "stopped", completedAt: null } })

			const resumed = expectJsonOk(await runCli(["chain", "resume", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(resumed.chain).toMatchObject({ name: "crud-chain", status: "active" })
			expect(resumed.alreadyActive).toBe(false)

			const deleted = expectJsonOk(await runCli(["chain", "delete", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(deleted.chain).toMatchObject({ name: "crud-chain", status: "deleted" })

			const unforcedRecreate = await runCli(["chain", "create", "crud-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"])
			expect(unforcedRecreate.exitCode).toBe(1)
			expect(unforcedRecreate.stderr).toContain("chain_deleted")
			expect(unforcedRecreate.stderr).toContain("force=true")

			const recreated = expectJsonOk(await runCli(["chain", "create", "crud-chain", "--config-json", chainConfig("mouriya-s-lab/coder-loop", "recreated"), "--force", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(recreated.chain).toMatchObject({
				name: "crud-chain",
				status: "active",
				baseBranch: "recreated",
			})
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
				"--config-json",
				DEFAULT_CHAIN_CONFIG,
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
			expectJsonOk(await runCli(["chain", "create", "items-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
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

			const updated = expectJsonOk(await runCli(["item", "update", "items-chain", "--issue", "181", "--status", "done", "--field-json", "{\"pr\":191}", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(updated.item).toMatchObject({ issueNumber: 181, status: "done", extra: { pr: 191 } })
		} finally {
			await fixture.daemon.stop()
		}
	})


	test("item reorder CLI", async () => {
		const fixture = await startFixture("item-reorder-cli")
		try {
			expectJsonOk(await runCli(["chain", "create", "reorder-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const itemsJson = JSON.stringify([
				{ issueNumber: 401, repoCwd: REPO_ROOT, title: "first" },
				{ issueNumber: 402, repoCwd: REPO_ROOT, title: "second" },
				{ issueNumber: 403, repoCwd: REPO_ROOT, title: "third" },
			])
			expectJsonOk(await runCli(["item", "batch-add", "reorder-chain", "--items-json", itemsJson, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const moved = expectJsonOk(await runCli(["item", "reorder", "reorder-chain", "--issue", "403", "--position", "0", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(moved.items.map((item: Record<string, unknown>) => item.issueNumber)).toEqual([403, 401, 402])
			expect(moved.items.map((item: Record<string, unknown>) => item.position)).toEqual([0, 1, 2])

			const listed = expectJsonOk(await runCli(["item", "list", "reorder-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items.map((item: Record<string, unknown>) => item.issueNumber)).toEqual([403, 401, 402])
			expect(listed.items.map((item: Record<string, unknown>) => item.position)).toEqual([0, 1, 2])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("batch item add", async () => {
		const fixture = await startFixture("batch-item-add")
		try {
			expectJsonOk(await runCli(["chain", "create", "batch-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const itemsJson = JSON.stringify([
				{ issueNumber: 25801, repoCwd: REPO_ROOT, title: "first batch item" },
				{ issueNumber: 25802, repoCwd: REPO_ROOT, priority: "high" },
				{ issueNumber: 25803, repoCwd: REPO_ROOT, runner: "codex" },
			])
			const added = expectJsonOk(await runCli(["item", "batch-add", "batch-chain", "--items-json", itemsJson, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(added.items).toHaveLength(3)
			expect(added.items.map((item: Record<string, unknown>) => item.issueNumber)).toEqual([25801, 25802, 25803])

			const listed = expectJsonOk(await runCli(["item", "list", "batch-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items).toHaveLength(3)
			expect(listed.items.map((item: Record<string, unknown>) => item.issueNumber)).toEqual([25801, 25802, 25803])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("batch item add matches daemon", async () => {
		const fixture = await startFixture("batch-item-add-matches-daemon")
		try {
			expectJsonOk(await runCli(["chain", "create", "batch-cli-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["chain", "create", "batch-daemon-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const batch = [
				{ issueNumber: 25901, repoCwd: REPO_ROOT, title: "same first", priority: "medium" },
				{ issueNumber: 25902, repoCwd: REPO_ROOT, title: "same second", runner: "codex" },
			]
			const cli = expectJsonOk(await runCli(["item", "batch-add", "batch-cli-chain", "--items-json", JSON.stringify(batch), "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const daemon = expectJsonOk(await runCli(["item", "batch-add", "batch-daemon-chain", "--items-json", JSON.stringify(batch), "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const comparable = (items: Record<string, unknown>[]) => items.map((item) => ({
				issueNumber: item.issueNumber,
				repoCwd: item.repoCwd,
				status: item.status,
				title: item.title,
				priority: item.priority,
				runner: item.runner,
			}))
			expect(comparable(cli.items)).toEqual(comparable(daemon.items))

			const cliListed = expectJsonOk(await runCli(["item", "list", "batch-cli-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const daemonListed = expectJsonOk(await runCli(["item", "list", "batch-daemon-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(comparable(cliListed.items)).toEqual(comparable(daemonListed.items))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain status completion", async () => {
		const fixture = await startFixture("completion", { schedulerEnabled: true })
		try {
			expectJsonOk(await runCli(["chain", "create", "done-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "single-phase-example", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			preInstallReviewOnEmptyLockByName("done-chain", fixture.loopDataRoot)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const chain = store.getChainByName("done-chain")
				if (chain === null) throw new Error("expected done-chain")
				store.createItem({ chainId: chain.id, issueNumber: 181, repoCwd: REPO_ROOT, status: "done" })
			} finally {
				store.close()
			}
			const status = await waitForJson(() => runCli(["chain", "status", "done-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]), (value) => value.chain?.status === "completed")
			expect(status.summary.completion.state).toBe("completed")
			expect(typeof status.summary.completion.completedAt).toBe("number")
			expect(status.summary.items.byStatus).toEqual({ done: 1 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain status reports dependency waiting reason", async () => {
		const fixture = await startFixture("dependency-wait-status")
		try {
			expectJsonOk(await runCli(["chain", "create", "dependency-wait-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let prerequisiteId = 0
			let dependentId = 0
			try {
				const chain = store.getChainByName("dependency-wait-chain")
				if (chain === null) throw new Error("expected dependency-wait-chain")
				const prerequisite = store.createItem({ chainId: chain.id, issueNumber: 2671, repoCwd: REPO_ROOT, status: "queued", priority: "10" })
				const dependent = store.createItem({
					chainId: chain.id,
					issueNumber: 2672,
					repoCwd: REPO_ROOT,
					status: "queued",
					priority: "00",
					extra: { dependsOn: [prerequisite.id] },
				})
				prerequisiteId = prerequisite.id
				dependentId = dependent.id
			} finally {
				store.close()
			}

			const status = expectJsonOk(await runCli(["chain", "status", "dependency-wait-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const dependentStatus = status.items.find((item: Record<string, unknown>) => item.id === dependentId)
			expect(dependentStatus?.waiting).toEqual({
				reason: "blocked-by-dependency",
				itemId: dependentId,
				issueNumber: 2672,
				repoCwd: REPO_ROOT,
				dependsOn: [prerequisiteId],
				unsatisfied: [prerequisiteId],
			})
			expect(status.summary.waiting.dependency).toEqual([dependentStatus?.waiting])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon up down", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-down")
		const daemonProcess = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100", "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		try {
			await waitFor(async () => {
				const socketStat = await stat(resolve(loopDataRoot, "daemon.sock"))
				return socketStat.isSocket() ? true : null
			}, 5_000)
			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot, "--json"])
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

	test("daemon up ignores reload/debug signals and SIGQUIT shuts down gracefully", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-signal-policy")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const daemonPid = Number((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim())

			for (const signal of ["SIGUSR1", "SIGHUP", "SIGPIPE", "SIGUSR2"] as const) {
				process.kill(daemonPid, signal)
				await sleep(100)
				expect(isPidAlive(daemonPid), `${signal} should not stop daemon up`).toBe(true)
				expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))
			}

			process.kill(daemonPid, "SIGQUIT")
			expect(await daemonProcess.exited).toBe(0)
			await waitForDaemonSocketRemoval(loopDataRoot)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}

		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			const shutdownLoopDataRoot = await makeLoopDataRoot(`daemon-${signal.toLowerCase()}-policy`)
			const shutdownProcess = spawnDaemonUp(shutdownLoopDataRoot)
			try {
				await waitForDaemonFiles(shutdownLoopDataRoot)
				const shutdownPid = Number((await readFile(resolve(shutdownLoopDataRoot, "daemon.pid"), "utf-8")).trim())
				process.kill(shutdownPid, signal)
				expect(await shutdownProcess.exited).toBe(0)
				await waitForDaemonSocketRemoval(shutdownLoopDataRoot)
			} finally {
				shutdownProcess.kill()
				await shutdownProcess.exited.catch(() => undefined)
			}
		}
	})

	test("daemon down emits human text without json flag", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-down-text")
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
			expect(down.stdout).toContain("daemon down: shutdown=true")
			expect(down.stdout).toContain(`socket=${resolve(loopDataRoot, "daemon.sock")}`)
			expect(await daemonProcess.exited).toBe(0)
			const stdout = await new Response(daemonProcess.stdout).text()
			expect(stdout).toContain("daemon up: pid=")
			expect(stdout).toContain(`socket=${resolve(loopDataRoot, "daemon.sock")}`)
		} finally {
			try {
				daemonProcess.kill()
			} catch {
				// Process may already have exited after daemon down.
			}
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("daemon commands expose json flag in help", async () => {
		for (const action of ["up", "status", "start", "stop", "restart", "down"]) {
			const help = await runCli(["daemon", action, "--help"])
			expect(help.exitCode).toBe(0)
			expect(help.stdout).toContain("--json")
		}
	})

	test("second daemon up fails without orphaning first daemon", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-duplicate")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const firstPid = (await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim()

			const duplicate = await runCli(["daemon", "up", "--loop-data-root", loopDataRoot])
			expect(duplicate.exitCode).toBe(1)
			expect(duplicate.stderr).toContain("daemon socket is already accepting connections")

			await waitForDaemonFiles(loopDataRoot)
			expect((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim()).toBe(firstPid)
			expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await daemonProcess.exited).toBe(0)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("concurrent daemon up race leaves one usable daemon", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-race")
		const first = spawnDaemonUp(loopDataRoot)
		const second = spawnDaemonUp(loopDataRoot)
		try {
			const loser = await waitForFirstExit([
				{ name: "first", proc: first },
				{ name: "second", proc: second },
			])
			const winner = loser.name === "first" ? second : first
			expect(loser.exitCode).toBe(1)
			expect(loser.stderr).toContain("daemon socket is already accepting connections")

			await waitForDaemonFiles(loopDataRoot)
			expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await winner.exited).toBe(0)
		} finally {
			first.kill()
			second.kill()
			await Promise.all([first.exited.catch(() => undefined), second.exited.catch(() => undefined)])
		}
	})

	test("daemon not running explicit error", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `not-running-${++nextFixtureId}`)
		const result = await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("central daemon is not running")
		expect(result.stderr).toContain("coder-loop daemon up --loop-data-root")
	})

	test("daemon status and down --json emit JSON when central daemon is not running", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `daemon-dead-json-${++nextFixtureId}`)
		await mkdir(loopDataRoot, { recursive: true })

		for (const action of ["status", "down"] as const) {
			const result = await runCli(["daemon", action, "--loop-data-root", loopDataRoot, "--json"])
			const parsed = expectJsonError(result)
			expect(result.stderr).toBe("")
			expect(parsed.error).toMatchObject({
				code: "daemon_not_running",
				details: {
					loopDataRoot,
					socketPath: resolve(loopDataRoot, "daemon.sock"),
					causeCode: "ENOENT",
				},
			})
			expect(parsed.error.message).toContain("central daemon is not running")
			expect(parsed.error.message).toContain("coder-loop daemon up --loop-data-root")
		}
	})

	test("daemon status --json reports live pid with missing socket pathname", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-socket-unlinked-json")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = Bun.spawn({
			cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		if (stale.pid === undefined) throw new Error("expected stale process pid")
		await writeFile(resolve(loopDataRoot, "daemon.pid"), `${stale.pid}\n`)

		try {
			const result = await runCli(["daemon", "status", "--loop-data-root", loopDataRoot, "--json"])
			const parsed = expectJsonError(result)
			expect(parsed.error.code).toBe("daemon_socket_unlinked")
			expect(parsed.error.details).toMatchObject({
				pid: stale.pid,
				socketPath: resolve(loopDataRoot, "daemon.sock"),
				pidFile: resolve(loopDataRoot, "daemon.pid"),
				causeCode: "ENOENT",
			})
		} finally {
			stale.kill()
			await stale.exited.catch(() => undefined)
		}
	})

	test("daemon up --json emits JSON when loop-data root cannot be prepared", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const parentFile = resolve(TEST_ROOT, `not-a-directory-${++nextFixtureId}`)
		await writeFile(parentFile, "not a directory\n")
		const loopDataRoot = resolve(parentFile, "child")

		const result = await runCli(["daemon", "up", "--loop-data-root", loopDataRoot, "--json"])
		const parsed = expectJsonError(result)
		expect(result.stderr).toBe("")
		expect(parsed.error).toMatchObject({
			code: "db_unavailable",
			details: { loopDataRoot },
		})
		expect(parsed.error.message).toContain("unable to prepare loop-data directory")
	})

	test("daemon status target reports chain-only daemon from loop-data socket", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-status-chain-only")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const daemonPid = Number((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim())

			const status = expectJsonOk(await runCli(["daemon", "status", REPO_ROOT, "--loop-data-root", loopDataRoot, "--json"]))
			const liveDaemon = status.processes.live.find((entry: Record<string, unknown>) => entry.pid === daemonPid)
			expect(liveDaemon).toMatchObject({
				pid: daemonPid,
				source: "daemon-socket",
				alive: true,
				matchesTarget: true,
			})

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await daemonProcess.exited).toBe(0)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("json output schema stable", async () => {
		const fixture = await startFixture("json-schema")
		try {
			expectJsonOk(await runCli(["chain", "create", "schema-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--umbrella", "mouriya-s-lab/coder-loop#176", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "schema-chain", "--issue", "181", "--repo-cwd", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const status = expectJsonOk(await runCli(["chain", "status", "schema-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			expect(Object.keys(status).sort()).toEqual(["activeRuns", "chain", "items", "summary"])
			expect(Object.keys(status.summary).sort()).toEqual(["activeSlots", "completion", "items", "recovery", "umbrella", "waiting"])
			expect(status.summary.recovery).toEqual({ needed: false, staleInProgressItems: [] })
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

	test("daemon start chain resolve", async () => {
		const fixture = await startFixture("target-cwd")
		try {
			expectJsonOk(await runCli(["chain", "create", "target-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "target-chain", "--issue", "184", "--repo-cwd", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const start = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(start.exitCode).toBe(0)
			expect(start.stdout).toContain(`daemon start dry-run: target=${REPO_ROOT}`)
			expect(start.stdout).toContain("daemon start dry-run: chain=target-chain")
			expect(start.stdout).not.toContain("command=")

			const startJson = expectJsonOk(await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(startJson).toMatchObject({ action: "start", target: REPO_ROOT, chain: "target-chain", dryRun: true })

			const stopJson = expectJsonOk(await runCli(["daemon", "stop", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(stopJson).toMatchObject({ action: "stop", target: REPO_ROOT, chain: "target-chain", dryRun: true })

			const restartJson = expectJsonOk(await runCli(["daemon", "restart", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(restartJson).toMatchObject({ action: "restart", target: REPO_ROOT, chain: "target-chain", dryRun: true, centralDaemon: "required" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon start ignores target-local legacy loop-data when loop-data root is omitted", async () => {
		const target = await makeTarget("target-cwd-legacy-local")
		const globalLoopDataRoot = await makeLoopDataRoot("target-cwd-global")
		const targetLocalLoopDataRoot = resolve(target, ".coder-loop/runtime/loop-data")
		await mkdir(globalLoopDataRoot, { recursive: true })
		await mkdir(targetLocalLoopDataRoot, { recursive: true })
		await writeFile(resolve(target, ".coder-loop/runtime/config.json"), "{}\n")

		const globalStore = openSqliteStateStore({ loopDataRoot: globalLoopDataRoot })
		try {
			globalStore.createChain({
				name: "global-chain",
				preset: "gh-issue-pr-iteration",
				repository: "fixture/repo",
				baseBranch: "main",
			})
		} finally {
			globalStore.close()
		}

		const legacyStore = openSqliteStateStore({ loopDataRoot: targetLocalLoopDataRoot })
		try {
			legacyStore.createChain({
				name: "legacy-local-chain",
				preset: "gh-issue-pr-iteration",
				repository: "fixture/repo",
				baseBranch: "main",
			})
		} finally {
			legacyStore.close()
		}

		const result = await runCli(
			["daemon", "start", target, "--dry-run", "--json"],
			{ [LOOP_DATA_ROOT_ENV]: globalLoopDataRoot },
		)
		const parsed = expectJsonOk(result)
		expect(parsed).toMatchObject({ action: "start", target, chain: "global-chain", dryRun: true })
	})

	test("daemon target-cwd fails explicitly when no chain matches", async () => {
		const fixture = await startFixture("target-cwd-missing")
		try {
			const start = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(start.exitCode).toBe(1)
			expect(start.stderr).toContain("SQLite state DB has no active chain")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon start ambiguous chain", async () => {
		const fixture = await startFixture("target-cwd-ambiguous")
		try {
			for (const chain of ["first-chain", "second-chain"]) {
				expectJsonOk(await runCli(["chain", "create", chain, "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
				expectJsonOk(await runCli(["item", "add", chain, "--issue", chain === "first-chain" ? "184" : "185", "--repo-cwd", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			}

			const ambiguous = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(ambiguous.exitCode).toBe(1)
			expect(ambiguous.stderr).toContain("matches multiple active chains")
			expect(ambiguous.stderr).toContain("--chain")

			const selected = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "second-chain", "--dry-run"])
			expect(selected.exitCode).toBe(0)
			expect(selected.stdout).toContain("chain=second-chain")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("status json reports DB snapshot and live process scan", async () => {
		const fixture = await startFixture("status-json")
		try {
			const target = await makeTarget("status-json-target")
			expectJsonOk(await runCli(["chain", "create", "status-json-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "status-json-chain", "--issue", "184", "--repo-cwd", target, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const status = expectJsonOk(await runCli(["status", target, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.state).toMatchObject({ kind: "ok", ok: true, path: resolve(fixture.loopDataRoot, "db.sqlite") })
			expect(status.queue.selected.id).toBe("184")
			expect(Array.isArray(status.processes.live)).toBe(true)
			expect(status.processes.scanError === null || typeof status.processes.scanError === "string").toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("install no runtime dir; install writes workflow; install creates chain row", async () => {
		const fixture = await startFixture("install-chain")
		try {
			const env = await fakeCliEnv("install-chain")
			const target = await makeGitTarget("install-chain-target")
			const result = await runCli(["install", target, "--repo", "fixture/repo", "--loop-data-root", fixture.loopDataRoot], env)
			expect(result.exitCode, result.stderr).toBe(0)
			await expect(Bun.file(resolve(target, ".coder-loop/workflow.md")).exists()).resolves.toBe(true)
			await expect(Bun.file(resolve(target, ".coder-loop/runtime")).exists()).resolves.toBe(false)
			const status = expectJsonOk(await runCli(["chain", "status", "repo", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.chain).toMatchObject({ name: "repo", repository: "fixture/repo", preset: "gh-issue-pr-iteration", status: "active" })
			expect(status.chain.metadata).toMatchObject({ config: { workflowFile: resolve(target, ".coder-loop/workflow.md") } })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("install rejects non-git target before writing workflow", async () => {
		const env = await fakeCliEnv("install-non-git")
		const target = await makeEmptyTarget("install-non-git-target")
		const result = await runCli(["install", target, "--dry-run"], env)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("target is not a git repository")
		expect(result.stderr).not.toContain("[Layer A]")
		await expect(Bun.file(resolve(target, ".coder-loop/workflow.md")).exists()).resolves.toBe(false)
	})

	test("install rejects malformed repo slugs before chain creation", async () => {
		const env = await fakeCliEnv("install-invalid-repo")
		const target = await makeGitTarget("install-invalid-repo-target")
		for (const repo of ["a/b/c", "no-slash", "x/y\nbad", ""]) {
			const result = await runCli(["install", target, "--repo", repo, "--dry-run"], env)
			expect(result.exitCode, `repo=${JSON.stringify(repo)} stderr=${result.stderr}`).toBe(1)
			expect(result.stderr).toContain("invalid repo slug")
			expect(result.stderr).not.toContain("[Central] DB chain")
		}
	})

	test("install daemon offline explicit fail", async () => {
		const env = await fakeCliEnv("install-offline")
		const target = await makeGitTarget("install-offline-target")
		const loopDataRoot = resolve(TEST_ROOT, `${++nextFixtureId}-offline-loop-data`)
		await mkdir(loopDataRoot, { recursive: true })
		const result = await runCli(["install", target, "--repo", "fixture/repo", "--loop-data-root", loopDataRoot], env)
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("central daemon is not running")
		expect(result.stderr).toContain("coder-loop daemon up --loop-data-root")
		expect(result.stderr).not.toContain("[Layer A]")
		await expect(Bun.file(resolve(target, ".coder-loop/workflow.md")).exists()).resolves.toBe(false)
		await expect(Bun.file(resolve(target, ".coder-loop/runtime")).exists()).resolves.toBe(false)
	})

	test("doctor passes without runtime dir", async () => {
		const fixture = await startFixture("doctor-chain")
		try {
			const env = await fakeCliEnv("doctor-chain")
			const target = await makeTarget("doctor-target")
			expectJsonOk(await runCli(["chain", "create", "doctor-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const result = await runCli(["doctor", target, "--repo", "fixture/repo", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-chain"], env)
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stderr).toContain("OK: .coder-loop/workflow.md")
			expect(result.stderr).not.toContain("legacy local runtime")
			expect(result.stderr).not.toContain(".coder-loop/runtime absent")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("doctor does not warn when runtime dir exists", async () => {
		const fixture = await startFixture("doctor-runtime-dir")
		try {
			const env = await fakeCliEnv("doctor-runtime-dir")
			const target = await makeTarget("doctor-runtime-target")
			await mkdir(resolve(target, ".coder-loop/runtime"), { recursive: true })
			expectJsonOk(await runCli(["chain", "create", "doctor-runtime-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const result = await runCli(["doctor", target, "--repo", "fixture/repo", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-runtime-chain"], env)
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stderr).toContain("OK: .coder-loop/workflow.md")
			expect(result.stderr).not.toContain("legacy local runtime")
			expect(result.stderr).not.toContain("WARN: .coder-loop/runtime")
		} finally {
			await fixture.daemon.stop()
		}
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
			chainCompleteTriggerForChain: () => null,
		},
	})
	return { daemon, loopDataRoot }
}

async function makeLoopDataRoot(name: string): Promise<string> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(root, { recursive: true })
	return resolve(root, "loop-data")
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
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

function spawnDaemonUp(loopDataRoot: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"],
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
}

async function waitForDaemonFiles(loopDataRoot: string): Promise<void> {
	const socketPath = resolve(loopDataRoot, "daemon.sock")
	const pidFile = resolve(loopDataRoot, "daemon.pid")
	await waitFor(async () => {
		const [socketStat, pidStat] = await Promise.all([stat(socketPath), stat(pidFile)])
		return socketStat.isSocket() && pidStat.isFile() ? true : null
	}, 5_000)
}

async function waitForDaemonSocketRemoval(loopDataRoot: string): Promise<void> {
	await waitFor(async () => {
		try {
			await stat(resolve(loopDataRoot, "daemon.sock"))
			return null
		} catch {
			return true
		}
	}, 5_000)
}

type NamedDaemonProcess = {
	name: string
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">
}

async function waitForFirstExit(processes: NamedDaemonProcess[]): Promise<{ name: string; exitCode: number | null; stderr: string }> {
	return await Promise.race(processes.map(async ({ name, proc }) => ({
		name,
		exitCode: await proc.exited,
		stderr: await new Response(proc.stderr).text(),
	})))
}

async function makeTarget(name: string): Promise<string> {
	const target = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(resolve(target, ".coder-loop"), { recursive: true })
	await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	return target
}

async function makeEmptyTarget(name: string): Promise<string> {
	const target = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(target, { recursive: true })
	return target
}

async function makeGitTarget(name: string, options: { workflow?: boolean } = {}): Promise<string> {
	const target = await makeEmptyTarget(name)
	const init = Bun.spawnSync({
		cmd: ["git", "init"],
		cwd: target,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (init.exitCode !== 0) throw new Error(new TextDecoder().decode(init.stderr))
	if (options.workflow === true) {
		await mkdir(resolve(target, ".coder-loop"), { recursive: true })
		await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	}
	return target
}

async function fakeCliEnv(name: string): Promise<Record<string, string>> {
	const bin = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-bin`)
	const home = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-home`)
	await mkdir(bin, { recursive: true })
	await mkdir(home, { recursive: true })
	await writeExecutable(resolve(bin, "gh"), [
		"#!/usr/bin/env bash",
		`if [ "$1" = "auth" ]; then exit 0; fi`,
		"exit 0",
		"",
	].join("\n"))
	for (const name of ["codex", "claude", "coder-loop"]) {
		await writeExecutable(resolve(bin, name), "#!/usr/bin/env bash\nexit 0\n")
	}
	return { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }
}

async function writeExecutable(path: string, content: string): Promise<void> {
	await writeFile(path, content, { mode: 0o755 })
}

function expectJsonOk(result: { exitCode: number | null; stdout: string; stderr: string }) {
	expect(result.exitCode, result.stderr).toBe(0)
	return JSON.parse(result.stdout)
}

function expectJsonError(result: { exitCode: number | null; stdout: string; stderr: string }): { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {
	expect(result.exitCode, result.stderr).toBe(1)
	const parsed = JSON.parse(result.stdout)
	expect(parsed.ok).toBe(false)
	expect(typeof parsed.error?.code).toBe("string")
	expect(typeof parsed.error?.message).toBe("string")
	return parsed
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

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveWait) => setTimeout(resolveWait, ms))
}
