import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
	createGitWorktreeManager,
	createSchedulerState,
	reconcileClosureResources,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
} from "./scheduler"
import { closureWorktreePath } from "./closure-lifecycle"
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

function makeItem(store: ReturnType<typeof openSqliteStateStore>, chain: ReturnType<typeof makeChain>, itemId: string, repoCwd = REPO_ROOT) {
	return store.createItem({ chainId: chain.id, itemId, repoCwd, status: runtimeStatus("queued"), attempts: 0, extra: storedItemExtra({}) })
}

test("different closures retain different worktrees and branches across loop-data roots", async () => {
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
		const itemA = makeItem(storeA, chainA, "a")
		const managerA = createGitWorktreeManager({ loopDataRoot: rootA })
		const resourceA = await managerA({ chain: chainA, item: itemA, phase: "iteration", closureId: "closure:a:iteration", repoCwd, slotKey: "slot-a", existing: null })
		if (typeof resourceA === "string") throw new Error("expected closure resources")
		expect(existsSync(resourceA.worktreePath)).toBe(true)

		const chainB = makeChain(storeB, "wedge-chain")
		const itemB = makeItem(storeB, chainB, "b")
		const managerB = createGitWorktreeManager({ loopDataRoot: rootB })
		const resourceB = await managerB({ chain: chainB, item: itemB, phase: "review", closureId: "closure:b:review", repoCwd, slotKey: "slot-b", existing: null })
		if (typeof resourceB === "string") throw new Error("expected closure resources")
		expect(resourceB.worktreePath).toBe(closureWorktreePath(rootB, chainB.name, repoCwd, "closure:b:review"))
		expect(resourceB.worktreePath).not.toBe(resourceA.worktreePath)
		expect(resourceB.branchName).not.toBe(resourceA.branchName)
		expect(existsSync(resourceB.worktreePath)).toBe(true)
		const list = git(repoCwd, ["worktree", "list", "--porcelain"]).stdout
		expect(list).toContain(resourceA.worktreePath)
		expect(list).toContain(resourceB.worktreePath)
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
		const item = makeItem(store, chain, "missing")
		const manager = createGitWorktreeManager({ loopDataRoot })
		const resource = await manager({ chain, item, phase: "iteration", closureId: "closure:missing:iteration", repoCwd, slotKey: "slot", existing: null })
		if (typeof resource === "string") throw new Error("expected closure resources")
		await rm(resource.worktreePath, { recursive: true, force: true })
		// Registration survives the directory deletion; pre-fix the early-return handed back
		// a nonexistent path.
		const existing = { closureId: "closure:missing:iteration", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: resource.worktreePath, branchName: resource.branchName, baseCommit: resource.baseCommit, sourceParNodeId: null, sessions: [] } as const
		const recreated = await manager({ chain, item, phase: "iteration", closureId: existing.closureId, repoCwd, slotKey: "slot", existing })
		if (typeof recreated === "string") throw new Error("expected closure resources")
		expect(recreated.worktreePath).toBe(resource.worktreePath)
		expect(existsSync(recreated.worktreePath)).toBe(true)
	} finally {
		store.close()
	}
})

test("startup reconciliation audits missing resources and repairs only orphaned engine namespace", async () => {
	const root = resolve(TEST_ROOT, "reconcile")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "reconcile-chain")
		const item = makeItem(store, chain, "reconcile", repoCwd)
		const manager = createGitWorktreeManager({ loopDataRoot })
		const resources = await manager({ chain, item, phase: "iteration", closureId: "closure:reconcile:iteration", repoCwd, slotKey: "slot", existing: null })
		if (typeof resources === "string") throw new Error("expected closure resources")
		const definitionRef = { kind: "chain", contentIdentity: "sha256:reconcile" } as const
		store.createTaskTree(chain.id, { root: { kind: "leaf", identity: { runtimeNodeId: "leaf-reconcile", definitionRef, definitionNodeId: "iteration" }, closure: { closureId: "closure:reconcile:iteration", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: resources.worktreePath, branchName: resources.branchName, baseCommit: resources.baseCommit, sourceParNodeId: null, sessions: [] } }, activeRuns: [] })
		expect(git(repoCwd, ["worktree", "remove", "--force", resources.worktreePath]).exitCode).toBe(0)
		expect(git(repoCwd, ["update-ref", "-d", resources.branchName]).exitCode).toBe(0)
		const orphanPath = resolve(loopDataRoot, "chains", chain.name, "worktrees", "orphan")
		await mkdir(orphanPath, { recursive: true })
		const orphanBranch = `coder-loop/closures/${chain.name}/orphan`
		expect(git(repoCwd, ["branch", orphanBranch, "main"]).exitCode).toBe(0)
		expect(git(repoCwd, ["config", "core.hooksPath", ".unexpected-hooks"]).exitCode).toBe(0)
		const findings = await reconcileClosureResources({ chain, items: [item], tree: store.getTaskTree(chain.id)?.root ?? null, loopDataRootOptions: { loopDataRoot } })
		expect(findings.map((finding) => finding.mismatch.kind).sort()).toEqual(["hooks-drift", "missing-branch", "missing-directory", "orphan-branch", "orphan-directory"])
		expect(existsSync(orphanPath)).toBe(false)
		expect(git(repoCwd, ["show-ref", "--verify", `refs/heads/${orphanBranch}`]).exitCode).not.toBe(0)
		expect(store.getTaskTree(chain.id)?.root).toMatchObject({ closure: { lifecycle: "active" } })
	} finally { store.close() }
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
