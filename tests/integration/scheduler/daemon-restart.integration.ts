import { afterAll, expect, test } from "bun:test"
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { daemonRequest, sendDaemonRequest, startCoderLoopDaemon, type CoderLoopDaemon } from "../../../src/daemon"
import {
	createGitWorktreeManager,
	createSchedulerState,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "../../../src/scheduler"
import { closureWorktreePath } from "../../../src/closure-lifecycle"
import { resolveChainRuntimePaths } from "../../../src/runtime-paths"
import { openSqliteStateStore } from "../../../src/sqlite-state"
import { loadPreset } from "../../../src/loop"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"
import type { BoundaryRecord } from "../../../src/boundary-types"
import { appendFixtureItemTaskTree } from "./harness"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const LOADED_PRESET = loadPreset(PRESET_DIR).then((preset) => ({ presetDir: PRESET_DIR, preset }))
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-integration-tests", String(process.pid))

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

async function startCredentialedSchedulerRuntime(root: string, loopDataRoot: string): Promise<{
	daemon: CoderLoopDaemon
	loadedPreset: Awaited<typeof LOADED_PRESET>
	presetDir: string
}> {
	const presetDir = resolve(root, "preset")
	await cp(PRESET_DIR, presetDir, { recursive: true })
	const presetTomlPath = resolve(presetDir, "preset.toml")
	const presetToml = await readFile(presetTomlPath, "utf-8")
	const iterationHeader = 'roles  = ["common", "quality", "iter"]'
	const exits = ["changes_requested", "blocked", "moot", "done", "exhausted"]
		.map((status) => `\n  [[phases.exits]]\n  status = "${status}"\n  when = "scheduler integration fixture status"\n`)
		.join("")
	await writeFile(presetTomlPath, presetToml.replace(iterationHeader, iterationHeader + exits))
	const loadedPreset = await loadPreset(presetDir).then((preset) => ({ presetDir, preset }))
	const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
	return { daemon, loadedPreset, presetDir }
}

const CREDENTIALED_STATUS_WRITE_SNIPPET = `if (typeof status === "string" && typeof input.itemId === "number") {
	const credential = process.env.CODER_LOOP_RUN_CRED
	const loopDataRoot = process.env.CODER_LOOP_DATA_DIR
	if (typeof credential !== "string" || credential.length === 0) throw new Error("scheduler integration runner requires CODER_LOOP_RUN_CRED")
	if (typeof loopDataRoot !== "string" || loopDataRoot.length === 0) throw new Error("scheduler integration runner requires CODER_LOOP_DATA_DIR")
	const { createConnection } = await import("node:net")
	const { randomUUID } = await import("node:crypto")
	const response = await new Promise((resolveSend, rejectSend) => {
		const socket = createConnection(loopDataRoot + "/daemon.sock")
		let buffer = ""
		socket.setEncoding("utf-8")
		socket.on("connect", () => socket.write(JSON.stringify({ id: randomUUID(), command: "item.update", args: { itemId: input.itemId, status, agentCredential: credential } }) + "\\n"))
		socket.on("data", (chunk) => {
			buffer += chunk
			const newline = buffer.indexOf("\\n")
			if (newline === -1) return
			socket.destroy()
			resolveSend(JSON.parse(buffer.slice(0, newline)))
		})
		socket.on("error", rejectSend)
	})
	if (response.ok !== true) throw new Error("credentialed scheduler integration status write failed: " + JSON.stringify(response))
}`

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
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
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
			metadata: storedChainMetadata({ maxItemAttempts: 50 }),
		})
		const item = store.createItem({
			chainId: chain.id,
			itemId: "313001",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			attempts: 0,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(store, chain, item, ["iteration"])
		const state = createSchedulerState()
		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd, closureId }) => {
			const worktreePath = closureWorktreePath(loopDataRoot, chain.name, repoCwd, closureId)
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		let now = 1_800_040_000
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => LOADED_PRESET,
			// Drive a single explicit phase so the iteration->review trigger (covered elsewhere) does not
			// interleave un-backed-off review spawns into this backoff measurement.
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
			now: () => now,
			runIdFactory: ({ item: selected }) => `run-forced-failure-${selected.id}-${now}`,
			prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId }),
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
	const agentCwd = root + "-agent"
	const fakeRunner = resolve(root, "prompt-capture-runner.ts")
	const promptCapture = resolve(agentCwd, "prompt.txt")
	await mkdir(agentCwd, { recursive: true })
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
			metadata: storedChainMetadata({}),
		})
		const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot })
		await mkdir(paths.chainRoot, { recursive: true })
		await writeFile(paths.sharedFile, "# Shared durable context\n\n")
		const item = store.createItem({
			chainId: chain.id,
			itemId: "357001",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			attempts: 0,
			issueFile: null,
			evidenceDir: null,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(store, chain, item, ["iteration"])
		const state = createSchedulerState()
		const worktreeManager: SchedulerWorktreeManager = async () => agentCwd
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => LOADED_PRESET,
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
		}

		const tick = await schedulerTick(options)
		expect(tick.spawnedRuns).toHaveLength(1)
		await tick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.lastRunId).toBe(`run-optional-handoff-${item.id}`)
		const rendered = await readFile(promptCapture, "utf-8")
		expect(rendered).toContain(`shared=${paths.sharedFile}`)
		expect(rendered).toContain("current=\n")
		expect(rendered).toContain(`evidence=${paths.issueEvidenceDir(item.itemId)}`)
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
			metadata: storedChainMetadata({}),
		})
		const active = store.createChain({
			name: "active-sibling-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: storedChainMetadata({}),
		})
		const stoppedItem = store.createItem({
			chainId: stopped.id,
			itemId: "349101",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			attempts: 0,
			extra: storedItemExtra({}),
		})
		const activeItem = store.createItem({
			chainId: active.id,
			itemId: "349102",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			attempts: 0,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(store, stopped, stoppedItem, ["iteration"])
		appendFixtureItemTaskTree(store, active, activeItem, ["iteration"])
		const state = createSchedulerState()
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd, closureId }) => {
			const worktreePath = closureWorktreePath(loopDataRoot, chain.name, repoCwd, closureId)
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => LOADED_PRESET,
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
			runIdFactory: ({ chain, item }) => `run-stopped-sibling-${chain.id}-${item.id}`,
			prompt: ({ item }) => JSON.stringify({ itemId: item.id }),
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
		`
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const status = "done"
${CREDENTIALED_STATUS_WRITE_SNIPPET}
console.log("done:" + input.itemId)
`,
	)

	const runtime = await startCredentialedSchedulerRuntime(root, loopDataRoot)
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "completed-worktree-cleanup-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: storedChainMetadata({ presetPath: runtime.presetDir }),
		})
		const item = store.createItem({
			chainId: chain.id,
			itemId: "351002",
			repoCwd: target,
			status: runtimeStatus("queued"),
			presetPath: runtime.presetDir,
			attempts: 0,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(store, chain, item, ["review"], gitOutput(target, ["rev-parse", "HEAD"]))
		// #456: previously this also pre-installed a `review-on-empty.lock` file via
		// `reviewOnEmptyLockPathForChainName` to suppress the legacy auto-fired phase. The
		// review-on-empty path is retired, so the suppressor is no longer needed.

		const state = runtime.daemon.schedulerExecutionState()
		const schedulerEvents: SchedulerEvent[] = []
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => runtime.loadedPreset,
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager: createGitWorktreeManager({ loopDataRoot }),
			loopDataRootOptions: { loopDataRoot },
			runCredentials: runtime.daemon.buildSchedulerRunCredentialIssuer(),
			runIdFactory: ({ item: selected }) => `run-complete-cleanup-${selected.id}`,
			prompt: ({ item: selected }) => JSON.stringify({ itemId: selected.id, issueNumber: Number(selected.itemId) }),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		const tick = await schedulerTick(options)
		expect(tick.spawnedRuns).toHaveLength(1)
		await tick.spawnedRuns[0]!.closed

		const completed = store.getChain(chain.id)
		if (completed === null) throw new Error("expected completed chain")
		const worktreePath = closureWorktreePath(loopDataRoot, completed.name, target, `closure:${chain.id}:${item.id}:review`)
		expect(store.getItem(item.id)?.status).toBe("done")
		expect(completed.status).toBe("completed")
		expect(schedulerEvents).toContainEqual(expect.objectContaining({ type: "chain.completed", chainId: chain.id }))
		const completedRoot = store.getTaskTree(chain.id)?.root
		if (completedRoot?.kind !== "par") throw new Error("expected completed chain task par")
		expect(completedRoot.children.flatMap((itemRoot) =>
			itemRoot.kind === "leaf"
				? [itemRoot.closure]
				: itemRoot.children.flatMap((node) => node.kind === "leaf" ? [node.closure] : []),
		)).toEqual(expect.arrayContaining([
			expect.objectContaining({ phase: "review", lifecycle: "consumed", worktreePath: null, branchName: null, sessions: [] }),
		]))
		expect(await pathExists(worktreePath)).toBe(false)
		expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
	} finally {
		await runtime.daemon.stop()
		store.close()
	}
})

test("counts one retry cycle in the declared attempt unit", async () => {
	const root = resolve(TEST_ROOT, "review-retry-to-iteration")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "review-retry-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(
		fakeRunner,
		`
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const status = input.phase === "review" ? "changes_requested" : null
${CREDENTIALED_STATUS_WRITE_SNIPPET}
console.log(input.phase + ":" + status)
`,
	)

	const runtime = await startCredentialedSchedulerRuntime(root, loopDataRoot)
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "review-retry-to-iteration-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: storedChainMetadata({ presetPath: runtime.presetDir }),
		})
		const item = store.createItem({
			chainId: chain.id,
			itemId: "346001",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			presetPath: runtime.presetDir,
			attempts: 0,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(
			store,
			chain,
			item,
			["iteration", "review"],
			undefined,
			`sha256:${runtime.loadedPreset.preset.sourceHash}`,
		)
		const state = runtime.daemon.schedulerExecutionState()
		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain: selectedChain, repoCwd, closureId }) => {
			const worktreePath = closureWorktreePath(loopDataRoot, selectedChain.name, repoCwd, closureId)
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		let runSequence = 0
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => runtime.loadedPreset,
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runCredentials: runtime.daemon.buildSchedulerRunCredentialIssuer(),
			runIdFactory: ({ phase }) => `run-review-retry-${++runSequence}-${phase}`,
			prompt: ({ item: selected, runId, phase }) => JSON.stringify({
				itemId: selected.id,
				issueNumber: Number(selected.itemId),
				runId,
				phase,
			}),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		const iterTick = await schedulerTick(options)
		expect(iterTick.spawnedRuns).toHaveLength(1)
		await iterTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("iteration")
		expect(store.getItem(item.id)?.status).toBe("queued")
		expect(store.getItem(item.id)?.attempts).toBe(1)

		const reviewTick = await schedulerTick(options)
		expect(reviewTick.spawnedRuns).toHaveLength(1)
		await reviewTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("review")
		expect(store.getItem(item.id)?.status).toBe("changes_requested")
		expect(store.getItem(item.id)?.attempts).toBe(1)

		const retryIterTick = await schedulerTick(options)
		expect(retryIterTick.spawnedRuns).toHaveLength(1)
		await retryIterTick.spawnedRuns[0]!.closed
		expect(store.getItem(item.id)?.phase).toBe("iteration")
		expect(store.getItem(item.id)?.status).toBe("changes_requested")
		expect(store.getItem(item.id)?.attempts).toBe(2)

		expect(schedulerEvents
			.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
				event.type === "phase.start" && event.itemId === item.id,
			)
			.map((event) => event.phase)).toEqual(["iteration", "review", "iteration"])
	} finally {
		await runtime.daemon.stop()
		store.close()
	}
})

test("daemon restart after crash recovers in-flight item through observable socket status", async () => {
	const root = resolve(TEST_ROOT, "daemon-crash-restart-resume")
	const loopDataRoot = resolve(root, "loop-data")
	const bin = resolve(root, "bin")
	const target = resolve(root, "target")
	const eventLog = resolve(root, "runner-events.jsonl")
	const fakeCodex = resolve(bin, "codex")
	await mkdir(bin, { recursive: true })
	await writeFile(
		fakeCodex,
		`#!/usr/bin/env bash
printf '{"pid":%s}\\n' "$$" >> ${JSON.stringify(eventLog)}
while [[ ! -e ${JSON.stringify(resolve(root, "release-runner"))} ]]; do
	sleep 0.05
done
echo "ITERATION SUMMARY: scope=daemon-crash-restart; reason=fake-codex"
`,
	)
	await chmod(fakeCodex, 0o755)
	await mkdir(loopDataRoot, { recursive: true })
	await initGitTarget(target)

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
			metadata: storedChainMetadata({}),
		})
		const item = store.createItem({
			chainId: chain.id,
			itemId: "359001",
			repoCwd: target,
			status: runtimeStatus("queued"),
			attempts: 0,
			extra: storedItemExtra({}),
		})
		appendFixtureItemTaskTree(store, chain, item, ["iteration"], gitOutput(target, ["rev-parse", "HEAD"]))

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
		expect(store.getItem(item.id)?.status).toBe("queued")
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

async function daemonStatus(socketPath: string): Promise<BoundaryRecord> {
	const response = await sendDaemonRequest(socketPath, daemonRequest("daemon.status"))
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function isRecord(value: unknown): value is BoundaryRecord {
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
	gitOutput(path, ["init", "-q", "-b", "main"])
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
