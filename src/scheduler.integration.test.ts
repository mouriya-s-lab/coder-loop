import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { daemonRequest, sendDaemonRequest } from "./daemon"
import {
	createGitWorktreeManager,
	createSchedulerState,
	reviewOnEmptyLockPathForChainName,
	schedulerSlotWorktreePath,
	schedulerTick,
	serializeSchedulerReviewOnEmptyLock,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-integration-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

test("forced spawn failures over thirty scheduler seconds are capped by persisted exponential backoff", async () => {
	const root = resolve(TEST_ROOT, "forced-failure-30s")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "forced-failure-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	// v1 status model: the runner exits non-zero and writes NO status of its own. The item therefore
	// stays in its continuable status (in_progress) and is re-spawned on the backoff cadence — proving
	// both "agent exits without terminal status -> continuable" and "repeated non-zero exits are capped
	// by persisted exponential backoff" without relying on any scheduler-side exit-code inference.
	await writeFile(
		fakeRunner,
		`const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
console.error("forced failure for item " + input.itemId)
process.exit(1)
`,
	)

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "forced-failure-30s-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: { maxItemAttempts: 50 },
		})
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 313_001,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const state = createSchedulerState()
		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		let now = 1_800_040_000
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			// Drive a single explicit phase so the iteration->review trigger (covered elsewhere) does not
			// interleave un-backed-off review spawns into this backoff measurement. in_progress is declared
			// continuable here, mirroring gh-issue-pr-iteration's real `continuable` set, so the no-status
			// failing item keeps being re-selected through the pending path on each backoff window.
			phase: "iteration",
			pendingStatuses: ["queued", "in_progress"],
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			now: () => now,
			runIdFactory: ({ item: selected }) => `run-forced-failure-${selected.id}-${now}`,
			prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: item.issueNumber, runId }),
			kindResolver: () => ({ ok: true, kind: "code" }),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		let spawnCount = 0
		for (let second = 0; second < 30; second += 1) {
			now = 1_800_040_000 + second
			const tick = await schedulerTick(options)
			spawnCount += tick.spawnedRuns.length
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
		}

		const updated = store.getItem(item.id)
		expect(spawnCount).toBe(1)
		expect(schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)).toHaveLength(spawnCount)
		expect(updated?.attempts).toBe(spawnCount)
		expect(updated?.extra.schedulerBackoff).toMatchObject({
			failureCount: spawnCount,
			nextRunAt: 1_800_040_060,
		})
	} finally {
		store.close()
	}
})

test("item without per-issue handoff binds shared handoff and empty current issue file", async () => {
	const root = resolve(TEST_ROOT, "optional-issue-handoff")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "prompt-capture-runner.ts")
	const promptCapture = resolve(root, "prompt.txt")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(
		fakeRunner,
		`const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "" : Bun.argv[promptIndex + 1] ?? ""
await Bun.write(${JSON.stringify(promptCapture)}, prompt)
`,
	)

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "optional-issue-handoff-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: {},
		})
		const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot })
		await mkdir(paths.chainRoot, { recursive: true })
		await writeFile(paths.sharedFile, "# Shared durable context\n\n")
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 357_001,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			issueFile: null,
			evidenceDir: null,
			extra: { issueKind: "code" },
		})
		const state = createSchedulerState()
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			phase: "iteration",
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runIdFactory: ({ item: selected }) => `run-optional-handoff-${selected.id}`,
			prompt: "shared={{SHARED_CONTEXT_FILE}}\ncurrent={{CURRENT_ISSUE_FILE}}\nevidence={{EVIDENCE_DIR}}\n",
			kindResolver: () => ({ ok: true, kind: "code" }),
		}

		const tick = await schedulerTick(options)
		expect(tick.spawnedRuns).toHaveLength(1)
		await tick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.lastRunId).toBe(`run-optional-handoff-${item.id}`)
		const rendered = await readFile(promptCapture, "utf-8")
		expect(rendered).toContain(`shared=${paths.sharedFile}`)
		expect(rendered).toContain("current=\n")
		expect(rendered).toContain(`evidence=${paths.issueEvidenceDir(item.issueNumber)}`)
	} finally {
		store.close()
	}
})

test("stopped chain does not block another active chain in the same scheduler tick", async () => {
	const root = resolve(TEST_ROOT, "stopped-chain-sibling-active")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "sibling-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(fakeRunner, "console.log('active sibling ran')\n")

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const stopped = store.createChain({
			name: "stopped-sibling-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "stopped",
			metadata: {},
		})
		const active = store.createChain({
			name: "active-sibling-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: {},
		})
		const stoppedItem = store.createItem({
			chainId: stopped.id,
			issueNumber: 349_101,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const activeItem = store.createItem({
			chainId: active.id,
			issueNumber: 349_102,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const state = createSchedulerState()
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			phase: "iteration",
			pendingStatuses: ["queued"],
			terminalStatuses: ["done"],
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runIdFactory: ({ chain, item }) => `run-stopped-sibling-${chain.id}-${item.id}`,
			prompt: ({ item }) => JSON.stringify({ itemId: item.id }),
			kindResolver: () => ({ ok: true, kind: "code" }),
		}

		const tick = await schedulerTick(options)

		expect(tick.spawnedRuns).toHaveLength(1)
		expect(tick.spawnedRuns[0]?.chainId).toBe(active.id)
		expect(tick.spawnedRuns[0]?.itemId).toBe(activeItem.id)
		expect(store.getItem(stoppedItem.id)?.status).toBe("queued")
		expect(store.getChain(stopped.id)?.status).toBe("stopped")
		await tick.spawnedRuns[0]!.closed
	} finally {
		store.close()
	}
})

test("completed chain removes its real git worktree registration and local directory", async () => {
	const root = resolve(TEST_ROOT, "completed-worktree-cleanup")
	const loopDataRoot = resolve(root, "loop-data")
	const target = resolve(root, "target")
	const fakeRunner = resolve(root, "complete-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	await initGitTarget(target)
	await writeFile(
		fakeRunner,
		`import { openSqliteStateStore } from ${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))}

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
const loopDataRoot = process.env.CODER_LOOP_DATA_DIR
if (typeof loopDataRoot === "string" && typeof input.itemId === "number") {
	const store = openSqliteStateStore({ loopDataRoot })
	store.updateItem(input.itemId, { status: "done", updatedAt: Math.floor(Date.now() / 1000) })
	store.close()
}
console.log("done:" + input.itemId)
`,
	)

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "completed-worktree-cleanup-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: {},
		})
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 351_002,
			repoCwd: target,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const lockPath = reviewOnEmptyLockPathForChainName(chain.name, { loopDataRoot })
		await mkdir(dirname(lockPath), { recursive: true })
		await writeFile(lockPath, serializeSchedulerReviewOnEmptyLock("test-pre-installed", new Date(0)))

		const state = createSchedulerState()
		const schedulerEvents: SchedulerEvent[] = []
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager: createGitWorktreeManager({ loopDataRoot }),
			loopDataRootOptions: { loopDataRoot },
			runIdFactory: ({ item: selected }) => `run-complete-cleanup-${selected.id}`,
			prompt: ({ item: selected }) => JSON.stringify({ itemId: selected.id, issueNumber: selected.issueNumber }),
			kindResolver: () => ({ ok: true, kind: "code" }),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		const tick = await schedulerTick(options)
		expect(tick.spawnedRuns).toHaveLength(1)
		await tick.spawnedRuns[0]!.closed

		const completed = store.getChain(chain.id)
		if (completed === null) throw new Error("expected completed chain")
		const worktreePath = schedulerSlotWorktreePath(completed, target, { loopDataRoot })
		expect(store.getItem(item.id)?.status).toBe("done")
		expect(completed.status).toBe("completed")
		expect(schedulerEvents).toContainEqual(expect.objectContaining({ type: "chain.completed", chainId: chain.id }))
		expect(await pathExists(worktreePath)).toBe(false)
		expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
	} finally {
		store.close()
	}
})

test("single item review retry verdict routes back through iteration before review", async () => {
	const root = resolve(TEST_ROOT, "review-retry-to-iteration")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "review-retry-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(
		fakeRunner,
		`import { openSqliteStateStore } from ${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))}

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
const status = input.phase === "review" ? "changes_requested" : "in_progress"
const loopDataRoot = process.env.CODER_LOOP_DATA_DIR
if (typeof loopDataRoot === "string" && typeof input.itemId === "number") {
	const store = openSqliteStateStore({ loopDataRoot })
	store.updateItem(input.itemId, { status, updatedAt: Math.floor(Date.now() / 1000) })
	store.close()
}
console.log(input.phase + ":" + status)
`,
	)

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "review-retry-to-iteration-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: {},
		})
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 346_001,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const state = createSchedulerState()
		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain: selectedChain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(selectedChain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		let runSequence = 0
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			statusesForChain: () => ({
				pending: ["queued", "in_progress", "changes_requested"],
				terminal: ["blocked", "moot", "done"],
				success: ["done"],
				entry: "queued",
			}),
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runIdFactory: ({ phase }) => `run-review-retry-${++runSequence}-${phase}`,
			prompt: ({ item: selected, runId, phase }) => JSON.stringify({
				itemId: selected.id,
				issueNumber: selected.issueNumber,
				runId,
				phase,
			}),
			kindResolver: () => ({ ok: true, kind: "code" }),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		const iterTick = await schedulerTick(options)
		expect(iterTick.spawnedRuns).toHaveLength(1)
		await iterTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("iteration")
		expect(store.getItem(item.id)?.status).toBe("in_progress")

		const reviewTick = await schedulerTick(options)
		expect(reviewTick.spawnedRuns).toHaveLength(1)
		await reviewTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("review")
		expect(store.getItem(item.id)?.status).toBe("changes_requested")

		const retryIterTick = await schedulerTick(options)
		expect(retryIterTick.spawnedRuns).toHaveLength(1)
		await retryIterTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("iteration")
		expect(store.getItem(item.id)?.status).toBe("in_progress")

		expect(schedulerEvents
			.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
				event.type === "phase.start" && event.itemId === item.id,
			)
			.map((event) => event.phase)).toEqual(["iteration", "review", "iteration"])
	} finally {
		store.close()
	}
})

test("daemon restart after crash recovers in-flight item through observable socket status", async () => {
	const root = resolve(TEST_ROOT, "daemon-crash-restart-resume")
	const loopDataRoot = resolve(root, "loop-data")
	const bin = resolve(root, "bin")
	const eventLog = resolve(root, "runner-events.jsonl")
	const fakeCodex = resolve(bin, "codex")
	await mkdir(bin, { recursive: true })
	await writeFile(
		fakeCodex,
		`#!/usr/bin/env bash
printf '{"pid":%s}\\n' "$$" >> ${JSON.stringify(eventLog)}
sleep 30
echo "ITERATION SUMMARY: scope=daemon-crash-restart; reason=fake-codex"
`,
	)
	await chmod(fakeCodex, 0o755)
	await mkdir(loopDataRoot, { recursive: true })

	const store = openSqliteStateStore({ loopDataRoot })
	let firstDaemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
	let secondDaemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
	const observedRunPids = new Set<number>()
	try {
		const chain = store.createChain({
			name: "daemon-crash-restart-resume-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: {},
		})
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 359_001,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})

		const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
		const socketPath = resolve(loopDataRoot, "daemon.sock")
		firstDaemon = spawnDaemonUp(loopDataRoot, env)
		await waitForSocket(socketPath)
		const firstRun = await waitForActiveRun(socketPath, item.id, null)
		if (typeof firstRun.pid === "number") observedRunPids.add(firstRun.pid)

		firstDaemon.kill("SIGKILL")
		await firstDaemon.exited.catch(() => undefined)

		secondDaemon = spawnDaemonUp(loopDataRoot, env)
		await waitForSocket(socketPath)
		const secondRun = await waitForActiveRun(socketPath, item.id, firstRun.runId)
		if (typeof secondRun.pid === "number") observedRunPids.add(secondRun.pid)

		const status = await daemonStatus(socketPath)
		expect(status.daemon).toMatchObject({
			socketPath,
			running: true,
		})
		expect(secondRun.runId).not.toBe(firstRun.runId)
		expect(store.getItem(item.id)?.status).toBe("in_progress")
	} finally {
		store.close()
		for (const pid of observedRunPids) killPidOrGroup(pid)
		if (secondDaemon !== null) {
			secondDaemon.kill("SIGKILL")
			await secondDaemon.exited.catch(() => undefined)
		}
		if (firstDaemon !== null) {
			firstDaemon.kill("SIGKILL")
			await firstDaemon.exited.catch(() => undefined)
		}
	}
})

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

function spawnDaemonUp(loopDataRoot: string, env: Record<string, string | undefined>): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "20", "--json"],
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	})
}

async function waitForSocket(socketPath: string): Promise<void> {
	await waitFor(async () => {
		try {
			return (await stat(socketPath)).isSocket() ? true : null
		} catch {
			return null
		}
	}, 5_000)
}

type DaemonActiveRun = {
	runId: string
	itemId: number
	pid?: number
}

async function waitForActiveRun(socketPath: string, itemId: number, excludedRunId: string | null): Promise<DaemonActiveRun> {
	return await waitFor(async () => {
		const status = await daemonStatus(socketPath)
		const daemon = status.daemon
		if (!isRecord(daemon) || !Array.isArray(daemon.activeRuns)) return null
		const activeRun = daemon.activeRuns
			.filter(isRecord)
			.find((run) =>
				run.itemId === itemId
				&& typeof run.runId === "string"
				&& run.runId !== excludedRunId,
			)
		if (activeRun === undefined) return null
		return {
			runId: activeRun.runId as string,
			itemId,
			...(typeof activeRun.pid === "number" ? { pid: activeRun.pid } : {}),
		}
	}, 5_000)
}

async function daemonStatus(socketPath: string): Promise<Record<string, unknown>> {
	const response = await sendDaemonRequest(socketPath, daemonRequest("daemon.status"))
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
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

function killPidOrGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL")
		return
	} catch {
		// Fall back to the individual process for runners that are not process-group leaders.
	}
	try {
		process.kill(pid, "SIGKILL")
	} catch {
		// Already exited.
	}
}

async function initGitTarget(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
	gitOutput(path, ["init", "-q"])
	gitOutput(path, ["config", "user.email", "test@example.invalid"])
	gitOutput(path, ["config", "user.name", "Test User"])
	await writeFile(resolve(path, "README.md"), "test\n")
	gitOutput(path, ["add", "README.md"])
	gitOutput(path, ["commit", "-qm", "init"])
}

function gitOutput(cwd: string, args: readonly string[]): string {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	const stdout = new TextDecoder().decode(proc.stdout).trim()
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim()
		throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${proc.exitCode}): ${stderr}`)
	}
	return stdout
}
