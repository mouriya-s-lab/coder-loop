import { afterAll, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

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

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
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
