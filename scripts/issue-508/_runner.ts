#!/usr/bin/env bun
/**
 * #508 acceptance driver dispatcher.
 *
 * Each of the 5 sibling `.sh` scripts in `scripts/issue-508/` invokes this runner
 * with a mode name, builds a real fixture (real `bun src/loop.ts daemon up`
 * subprocess + real `openSqliteStateStore` seed + real `setInterval`-keepalive
 * child process representing the pre-crash agent), then asserts the corresponding
 * row from the issue body's «验收标准» table. No mocks — verification mirrors what
 * a v9 → v11 daemon crash actually looks like on disk.
 *
 * Modes (one per acceptance row):
 *   - preserve-item-fields        (row #1)
 *   - no-item-status-event        (row #2)
 *   - scheduler-rescheds          (row #3)
 *   - no-recovered-items-payload  (row #4)
 *   - kill-orphan-pg              (row #5)
 *
 * Exit 0 on success, non-zero with diagnostic on failure.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { openSqliteStateStore } from "../../src/sqlite-state.ts"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../src/runtime-data.ts"

function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "issue-508.status"), "issue-508")
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")

function log(msg: string): void {
	console.log(`[issue-508] ${msg}`)
}

function fail(msg: string): never {
	console.error(`[issue-508] FAIL: ${msg}`)
	process.exit(1)
}

type DaemonHandle = {
	child: ChildProcess
	loopDataRoot: string
	stderrPath: string
}

function startDaemon(workDir: string, fastScheduler: boolean): DaemonHandle {
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const stderrPath = resolve(workDir, "daemon.stderr.log")
	const stdoutFd = openSync(resolve(workDir, "daemon.stdout.log"), "a")
	const stderrFd = openSync(stderrPath, "a")
	// Drivers #1/#2/#4/#5 quiet the scheduler by setting an effectively infinite interval so the
	// only scheduler activity is the synchronous recovery pass at startup. Driver #3 needs the
	// scheduler to actually fire so it can observe the re-spawn — it passes fastScheduler=true.
	const intervalMs = fastScheduler ? 250 : 86_400_000
	const args = [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", String(intervalMs)]
	const child = spawn("bun", args, {
		cwd: REPO_ROOT,
		stdio: ["ignore", stdoutFd, stderrFd],
		detached: true,
	})
	closeSync(stdoutFd)
	closeSync(stderrFd)
	return { child, loopDataRoot, stderrPath }
}

async function waitForSocket(daemon: DaemonHandle, timeoutMs: number): Promise<void> {
	const socketPath = resolve(daemon.loopDataRoot, "daemon.sock")
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (existsSync(socketPath)) {
			try {
				if (statSync(socketPath).isSocket()) return
			} catch {
				// keep waiting
			}
		}
		if (daemon.child.exitCode !== null) {
			fail(`daemon 进程提前退出 (exit ${daemon.child.exitCode}); stderr=${daemon.stderrPath}`)
		}
		await Bun.sleep(100)
	}
	fail(`daemon socket ${timeoutMs}ms 内未就绪; stderr=${daemon.stderrPath}`)
}

function sigkill(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// already gone
		}
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return true
		}
		await Bun.sleep(50)
	}
	return false
}

type Fixture = {
	workDir: string
	loopDataRoot: string
	chainId: number
	chainName: string
	itemRowId: number
	itemId: string
	stalePid: number
	staleChild: ChildProcess
	staleRunId: string
	agentCwd: string
	sessionIds: { iteration: { claude: string } }
}

function buildFixture(scope: string): Fixture {
	const workDir = mkdtempSync(resolve(tmpdir(), `issue-508-${scope}-`))
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })

	// 模拟 pre-crash agent：长生命周期子进程，pid 写进 current_runs.extra
	const staleChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	})
	staleChild.unref()
	if (staleChild.pid === undefined) fail("无法 spawn stale child")
	const stalePid = staleChild.pid

	const chainName = `issue-508-${scope}`
	const staleRunId = `run-stale-${scope}`
	const agentCwd = resolve(workDir, "worktree")
	const sessionIds = { iteration: { claude: `session-${scope}-claude` } }

	const store = openSqliteStateStore({ loopDataRoot })
	let chainId = 0
	let itemRowId = 0
	const itemId = "508"
	try {
		const chain = store.createChain({
			name: chainName,
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: storedChainMetadata({}),
		})
		chainId = chain.id
		const item = store.createItem({
			chainId: chain.id,
			itemId,
			repoCwd: REPO_ROOT,
			status: runtimeStatus("in_progress"),
			attempts: 1,
			lastRunId: staleRunId,
			phase: "iteration",
			agentCwd,
			title: "stale item under #508 acceptance",
			sessionIds,
			extra: storedItemExtra({}),
		})
		itemRowId = item.id
		store.recordRun({
			runId: staleRunId,
			chainId: chain.id,
			itemId: item.id,
			phase: "iteration",
			startedAt: 1_800_000_000,
			extra: storedItemExtra({}),
		})
		store.setCurrentRun({
			chainId: chain.id,
			phase: "iteration",
			runId: staleRunId,
			startedAt: 1_800_000_000,
			extra: storedItemExtra({ itemId: item.id, pid: stalePid, processGroupLeader: true }),
		})
	} finally {
		store.close()
	}

	return {
		workDir,
		loopDataRoot,
		chainId,
		chainName,
		itemRowId,
		itemId,
		stalePid,
		staleChild,
		staleRunId,
		agentCwd,
		sessionIds,
	}
}

async function snapshotItem(fixture: Fixture): Promise<{ status: string; phase: string | null; sessionIds: unknown }> {
	const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
	try {
		const item = store.getItem(fixture.itemRowId)
		if (item === null) fail("item row 消失")
		return { status: item.status, phase: item.phase, sessionIds: item.sessionIds }
	} finally {
		store.close()
	}
}

async function snapshotCurrentRunNull(fixture: Fixture): Promise<boolean> {
	const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
	try {
		return store.getCurrentRun(fixture.chainId) === null
	} finally {
		store.close()
	}
}

async function snapshotActiveRuns(fixture: Fixture): Promise<{ runId: string; itemId: number; endedAt: number | null }[]> {
	const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
	try {
		return store.listRuns(fixture.chainId).map((run) => ({ runId: run.runId, itemId: run.itemId, endedAt: run.endedAt }))
	} finally {
		store.close()
	}
}

async function stopDaemonHard(fixture: Fixture, daemon: DaemonHandle): Promise<void> {
	const pid = daemon.child.pid
	if (pid === undefined) return
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// gone already
		}
	}
	await Bun.sleep(200)
}

async function stopDaemonClean(daemon: DaemonHandle): Promise<void> {
	const down = spawnSync("bun", [LOOP_ENTRY, "daemon", "down", "--loop-data-root", daemon.loopDataRoot], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	})
	if (down.status !== 0) {
		log(`daemon down exit ${down.status}: ${down.stderr.trim() || down.stdout.trim()}`)
	}
	const deadline = Date.now() + 8_000
	while (Date.now() < deadline && daemon.child.exitCode === null) {
		await Bun.sleep(100)
	}
	if (daemon.child.exitCode === null) {
		log("daemon down 超时，SIGKILL 收尾")
		try {
			daemon.child.kill("SIGKILL")
		} catch {
			// noop
		}
	}
}

async function teardown(fixture: Fixture): Promise<void> {
	sigkill(fixture.stalePid)
	try {
		rmSync(fixture.workDir, { recursive: true, force: true })
	} catch {
		// noop
	}
}

function readStderr(daemon: DaemonHandle): string {
	try {
		return readFileSync(daemon.stderrPath, "utf-8")
	} catch {
		return ""
	}
}

type Mode =
	| "preserve-item-fields"
	| "no-item-status-event"
	| "scheduler-rescheds"
	| "no-recovered-items-payload"
	| "kill-orphan-pg"

async function runPreserveItemFields(): Promise<void> {
	const fixture = buildFixture("preserve-fields")
	const daemon1 = startDaemon(fixture.workDir, false)
	try {
		await waitForSocket(daemon1, 8_000)
		const pre = await snapshotItem(fixture)

		await stopDaemonHard(fixture, daemon1)

		const daemon2 = startDaemon(fixture.workDir, false)
		try {
			await waitForSocket(daemon2, 8_000)
			await Bun.sleep(500)
			const post = await snapshotItem(fixture)
			if (post.status !== pre.status) fail(`status drift: pre=${pre.status} post=${post.status} (expected unchanged)`)
			if (post.phase !== pre.phase) fail(`phase drift: pre=${pre.phase} post=${post.phase} (expected unchanged)`)
			const preSession = JSON.stringify(pre.sessionIds)
			const postSession = JSON.stringify(post.sessionIds)
			if (postSession !== preSession) fail(`sessionIds drift: pre=${preSession} post=${postSession}`)
			log(`row #1 OK: status=${post.status} phase=${post.phase} sessionIds=${postSession}`)
		} finally {
			await stopDaemonClean(daemon2)
		}
	} finally {
		await teardown(fixture)
	}
}

async function runNoItemStatusEvent(): Promise<void> {
	const fixture = buildFixture("no-item-status-event")
	const daemon1 = startDaemon(fixture.workDir, false)
	try {
		await waitForSocket(daemon1, 8_000)
		await stopDaemonHard(fixture, daemon1)

		const daemon2 = startDaemon(fixture.workDir, false)
		try {
			await waitForSocket(daemon2, 8_000)
			await Bun.sleep(500)
			const stderr = readStderr(daemon2)
			const offending = stderr.split("\n").filter((line) => line.includes("item.status") && line.includes("stale_current_run_recovery"))
			if (offending.length !== 0) fail(`expected 0 item.status events with reason=stale_current_run_recovery, got ${offending.length}: ${offending.join(" | ")}`)
			log(`row #2 OK: 0 stale_current_run_recovery item.status events emitted`)
		} finally {
			await stopDaemonClean(daemon2)
		}
	} finally {
		await teardown(fixture)
	}
}

async function runSchedulerRescheds(): Promise<void> {
	const fixture = buildFixture("scheduler-rescheds")
	const daemon1 = startDaemon(fixture.workDir, false)
	try {
		await waitForSocket(daemon1, 8_000)
		await stopDaemonHard(fixture, daemon1)

		const daemon2 = startDaemon(fixture.workDir, true)
		try {
			await waitForSocket(daemon2, 8_000)
			// 允许 scheduler tick 跑一段时间。scheduler 默认间隔几秒，多等几次便能看见新 run 行。
			const deadline = Date.now() + 30_000
			let item = await snapshotItem(fixture)
			let runs = await snapshotActiveRuns(fixture)
			while (Date.now() < deadline) {
				item = await snapshotItem(fixture)
				runs = await snapshotActiveRuns(fixture)
				const newRun = runs.find((run) => run.runId !== fixture.staleRunId && run.itemId === fixture.itemRowId)
				if (newRun !== undefined) {
					if (item.status !== "in_progress") {
						fail(`scheduler resched 后 items.status 应保持 in_progress（业务字段不被 daemon 改），实际=${item.status}`)
					}
					log(`row #3 OK: scheduler 重新 spawn run=${newRun.runId} item=${fixture.itemRowId} 且 items.status 维持 in_progress`)
					return
				}
				await Bun.sleep(500)
			}
			fail(`30s 内未观察到 scheduler 为 itemRowId=${fixture.itemRowId} 重新 spawn 新 run；runs=${JSON.stringify(runs)} itemStatus=${item.status}`)
		} finally {
			await stopDaemonClean(daemon2)
		}
	} finally {
		await teardown(fixture)
	}
}

async function runNoRecoveredItemsPayload(): Promise<void> {
	const fixture = buildFixture("no-recovered-payload")
	const daemon1 = startDaemon(fixture.workDir, false)
	try {
		await waitForSocket(daemon1, 8_000)
		await stopDaemonHard(fixture, daemon1)

		const daemon2 = startDaemon(fixture.workDir, false)
		try {
			await waitForSocket(daemon2, 8_000)
			await Bun.sleep(500)
			const stderr = readStderr(daemon2)
			const recoveryLines = stderr.split("\n").filter((line) => line.includes("scheduler.recovery"))
			if (recoveryLines.length === 0) fail(`expected at least one scheduler.recovery event line in daemon stderr; saw none`)
			for (const line of recoveryLines) {
				if (line.includes("recoveredItems")) fail(`scheduler.recovery payload still mentions recoveredItems: ${line}`)
			}
			log(`row #4 OK: ${recoveryLines.length} scheduler.recovery lines, none carry recoveredItems`)
		} finally {
			await stopDaemonClean(daemon2)
		}
	} finally {
		await teardown(fixture)
	}
}

async function runKillOrphanPg(): Promise<void> {
	const fixture = buildFixture("kill-orphan-pg")
	const daemon1 = startDaemon(fixture.workDir, false)
	try {
		await waitForSocket(daemon1, 8_000)
		await stopDaemonHard(fixture, daemon1)

		const daemon2 = startDaemon(fixture.workDir, false)
		try {
			await waitForSocket(daemon2, 8_000)
			const exited = await waitForPidExit(fixture.stalePid, 3_000)
			if (!exited) fail(`stale pid ${fixture.stalePid} 仍存活，daemon recovery 未杀掉孤儿进程组`)
			log(`row #5 OK: stale pid ${fixture.stalePid} 已被 daemon recovery 杀掉`)
		} finally {
			await stopDaemonClean(daemon2)
		}
	} finally {
		await teardown(fixture)
	}
}

async function main(): Promise<void> {
	const mode = (process.argv[2] ?? "") as Mode | string
	switch (mode) {
		case "preserve-item-fields":
			await runPreserveItemFields()
			break
		case "no-item-status-event":
			await runNoItemStatusEvent()
			break
		case "scheduler-rescheds":
			await runSchedulerRescheds()
			break
		case "no-recovered-items-payload":
			await runNoRecoveredItemsPayload()
			break
		case "kill-orphan-pg":
			await runKillOrphanPg()
			break
		default:
			console.error(`unknown mode: ${mode}; expected one of preserve-item-fields|no-item-status-event|scheduler-rescheds|no-recovered-items-payload|kill-orphan-pg`)
			process.exit(2)
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(`[issue-508] unhandled error: ${err instanceof Error ? err.stack : String(err)}`)
	process.exit(1)
})
