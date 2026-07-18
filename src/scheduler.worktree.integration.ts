import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
	createGitWorktreeManager,
	createSchedulerState,
	schedulerSlotWorktreePath,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
} from "./scheduler"
import { openSqliteStateStore } from "./sqlite-state"
import { loadPreset } from "./loop"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const LOADED_PRESET = loadPreset(PRESET_DIR).then((preset) => ({ presetDir: PRESET_DIR, preset }))
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-worktree-tests", String(process.pid))

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const proc = spawnSync("git", args, { cwd, encoding: "utf-8" })
	return { exitCode: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" }
}

async function initGitRepo(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
	for (const args of [
		["init", "--initial-branch", "main"],
		["config", "user.email", "test@example.invalid"],
		["config", "user.name", "scheduler-worktree-test"],
	]) {
		const result = git(path, args)
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
	}
	await writeFile(resolve(path, "README.md"), "# worktree fixture\n")
	git(path, ["add", "README.md"])
	const commit = git(path, ["commit", "-m", "init"])
	if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`)
}

function makeChain(store: ReturnType<typeof openSqliteStateStore>, name: string) {
	return store.createChain({
		name,
		preset: "gh-issue-pr-iteration",
		repository: "fixture/worktree",
		baseBranch: "main",
		status: "active",
		metadata: storedChainMetadata({}),
	})
}

test("killed-run slot worktree holding the slot branch is self-healed from a new loop-data root", async () => {
	const root = resolve(TEST_ROOT, "stale-slot-branch")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const rootA = resolve(root, "loop-data-a")
	const rootB = resolve(root, "loop-data-b")
	await mkdir(rootA, { recursive: true })
	await mkdir(rootB, { recursive: true })

	const storeA = openSqliteStateStore({ loopDataRoot: rootA })
	const storeB = openSqliteStateStore({ loopDataRoot: rootB })
	try {
		const chainA = makeChain(storeA, "wedge-chain")
		const managerA = createGitWorktreeManager({ loopDataRoot: rootA })
		const pathA = await managerA({ chain: chainA, repoCwd, slotKey: "slot-a" })
		// Simulate the daemon being killed mid-run: the worktree stays registered and
		// checked out on the engine-owned slot branch — nothing switches it away.
		expect(existsSync(pathA)).toBe(true)

		const chainB = makeChain(storeB, "wedge-chain")
		const managerB = createGitWorktreeManager({ loopDataRoot: rootB })
		// Pre-fix this threw worktree_create_failed: the slot branch was "already used by
		// worktree at <pathA>".
		const pathB = await managerB({ chain: chainB, repoCwd, slotKey: "slot-b" })
		expect(pathB).toBe(schedulerSlotWorktreePath(chainB, repoCwd, { loopDataRoot: rootB }))
		expect(existsSync(pathB)).toBe(true)
		// The stale registration was removed, the new one is live.
		const list = git(repoCwd, ["worktree", "list", "--porcelain"]).stdout
		expect(list).toContain(pathB)
		expect(list).not.toContain(pathA)
	} finally {
		storeA.close()
		storeB.close()
	}
})

test("worktree registered but directory missing is pruned and recreated", async () => {
	const root = resolve(TEST_ROOT, "registered-missing-dir")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "missing-dir-chain")
		const manager = createGitWorktreeManager({ loopDataRoot })
		const path = await manager({ chain, repoCwd, slotKey: "slot" })
		await rm(path, { recursive: true, force: true })
		// Registration survives the directory deletion; pre-fix the early-return handed back
		// a nonexistent path.
		const recreated = await manager({ chain, repoCwd, slotKey: "slot" })
		expect(recreated).toBe(path)
		expect(existsSync(recreated)).toBe(true)
	} finally {
		store.close()
	}
})

test("worktree create failure is contained: backoff + schedulerSpawnError in extra, cleared on next successful spawn", async () => {
	const root = resolve(TEST_ROOT, "containment")
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const okRunner = resolve(root, "ok-runner.ts")
	await writeFile(okRunner, "process.exit(0)\n")

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "containment-chain")
		const item = store.createItem({
			chainId: chain.id,
			itemId: "466001",
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			attempts: 0,
			extra: storedItemExtra({}),
		})
		const state = createSchedulerState()
		const events: SchedulerEvent[] = []
		let worktreeCalls = 0
		let failWorktree = true
		let now = 1_900_000_000
		const worktreePath = resolve(root, "fake-worktree")
		await mkdir(worktreePath, { recursive: true })
		const options: SchedulerOptions = {
			store,
			state,
			presetForChain: () => LOADED_PRESET,
			phase: "iteration",
			runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [okRunner], model: null },
			worktreeManager: async () => {
				worktreeCalls += 1
				if (failWorktree) throw new Error("synthetic worktree create failure")
				return worktreePath
			},
			loopDataRootOptions: { loopDataRoot },
			now: () => now,
			runIdFactory: ({ item: selected }) => `run-containment-${selected.id}-${now}`,
			prompt: () => "containment-test-prompt",
			onEvent: (event) => {
				events.push(event)
			},
		}

		const tick1 = await schedulerTick(options)
		expect(tick1.spawnedRuns).toHaveLength(0)
		const afterFailure = store.getItem(item.id)
		expect(afterFailure?.status).toBe("queued")
		expect(afterFailure?.attempts).toBe(0)
		expect(afterFailure?.extra.schedulerSpawnError).toMatchObject({
			at: now,
			attribution: { kind: "phase", phase: "iteration" },
			message: "synthetic worktree create failure",
		})
		expect(afterFailure?.extra.schedulerBackoff).toMatchObject({ failureCount: 1 })
		expect(events.filter((event) => event.type === "spawn.aborted")).toHaveLength(1)

		// Within the backoff window the scheduler must not hammer the worktree manager again
		// (pre-fix it retried at tick cadence, 1Hz, forever).
		now += 1
		await schedulerTick(options)
		expect(worktreeCalls).toBe(1)

		// Past the backoff window the spawn succeeds and the error record is cleared.
		failWorktree = false
		now += 3600
		const tick3 = await schedulerTick(options)
		expect(tick3.spawnedRuns).toHaveLength(1)
		await Promise.all(tick3.spawnedRuns.map((run) => run.closed))
		const afterSuccess = store.getItem(item.id)
		expect(afterSuccess?.attempts).toBe(1)
		expect(afterSuccess?.extra.schedulerSpawnError).toBeUndefined()
	} finally {
		store.close()
	}
})
