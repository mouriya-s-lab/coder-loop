import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
	cleanupSchedulerChainWorktrees,
	createGitWorktreeManager,
	createSchedulerState,
	consumeSchedulerClosure,
	reconcileClosureResources,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
} from "../../../src/scheduler"
import { closureWorktreePath, createRepositoryGitCoordinator, type RepositoryGitCoordinator } from "../../../src/closure-lifecycle"
import { openSqliteStateStore } from "../../../src/sqlite-state"
import { loadPreset } from "../../../src/loop"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
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

async function initOriginBackedRepo(root: string): Promise<string> {
	const source = resolve(root, "source")
	const origin = resolve(root, "origin.git")
	const target = resolve(root, "target")
	await initGitRepo(source)
	const initOrigin = git(root, ["init", "--bare", origin])
	if (initOrigin.exitCode !== 0) throw new Error(`git init --bare failed: ${initOrigin.stderr}`)
	const addOrigin = git(source, ["remote", "add", "origin", origin])
	if (addOrigin.exitCode !== 0) throw new Error(`git remote add failed: ${addOrigin.stderr}`)
	const push = git(source, ["push", "-u", "origin", "main"])
	if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`)
	const clone = git(root, ["clone", origin, target])
	if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr}`)
	return target
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

test("concurrent closure opens share the scheduler's origin fetch", async () => {
	const root = resolve(TEST_ROOT, "fetch-singleflight")
	await mkdir(root, { recursive: true })
	const repoCwd = await initOriginBackedRepo(root)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "singleflight-chain")
		const firstItem = makeItem(store, chain, "first", repoCwd)
		const secondItem = makeItem(store, chain, "second", repoCwd)
		const underlying = createRepositoryGitCoordinator()
		let fetchExecutions = 0
		const coordinator: RepositoryGitCoordinator = {
			run: underlying.run,
			singleflight: (coordinatedRepo, operationKey, operation) => underlying.singleflight(coordinatedRepo, operationKey, async () => {
				fetchExecutions += 1
				return await operation()
			}),
		}
		const manager = createGitWorktreeManager({ loopDataRoot }, coordinator)
		const [first, second] = await Promise.all([
			manager({ chain, item: firstItem, phase: "iteration", closureId: "closure:first:iteration", repoCwd, slotKey: "slot", existing: null }),
			manager({ chain, item: secondItem, phase: "iteration", closureId: "closure:second:iteration", repoCwd, slotKey: "slot", existing: null }),
		])
		if (typeof first === "string" || typeof second === "string") throw new Error("expected closure resources")
		expect(fetchExecutions).toBe(1)
		expect(first.baseCommit).toBe(second.baseCommit)
	} finally {
		store.close()
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
		expect(git(repoCwd, ["config", "extensions.worktreeConfig", "true"]).exitCode).toBe(0)
		const findings = await reconcileClosureResources({ chain, items: [item], tree: store.getTaskTree(chain.id)?.root ?? null, loopDataRootOptions: { loopDataRoot } })
		expect(findings.map((finding) => finding.mismatch.kind).sort()).toEqual(["hooks-drift", "missing-branch", "missing-directory", "orphan-branch", "orphan-directory", "repo-config-drift"])
		expect(existsSync(orphanPath)).toBe(false)
		expect(git(repoCwd, ["show-ref", "--verify", `refs/heads/${orphanBranch}`]).exitCode).not.toBe(0)
		expect(store.getTaskTree(chain.id)?.root).toMatchObject({ closure: { lifecycle: "active" } })
	} finally { store.close() }
})

test("startup reconciliation removes consumed worktree registrations and branches left by an interrupted cleanup", async () => {
	const root = resolve(TEST_ROOT, "reconcile-consumed-residue")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "reconcile-consumed-residue-chain")
		const item = makeItem(store, chain, "reconcile-consumed", repoCwd)
		const manager = createGitWorktreeManager({ loopDataRoot })
		const resources = await manager({ chain, item, phase: "iteration", closureId: "closure:reconcile-consumed:iteration", repoCwd, slotKey: "slot", existing: null })
		if (typeof resources === "string") throw new Error("expected closure resources")
		const definitionRef = { kind: "chain", contentIdentity: "sha256:reconcile-consumed" } as const
		store.createTaskTree(chain.id, { root: { kind: "leaf", identity: { runtimeNodeId: "leaf-reconcile-consumed", definitionRef, definitionNodeId: "iteration" }, closure: { closureId: "closure:reconcile-consumed:iteration", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: resources.worktreePath, branchName: resources.branchName, baseCommit: resources.baseCommit, sourceParNodeId: null, sessions: [] } }, activeRuns: [] })
		store.setClosureLifecycle("closure:reconcile-consumed:iteration", { kind: "consume", updatedAt: 1_900_000_200 })

		const findings = await reconcileClosureResources({ chain, items: [item], tree: store.getTaskTree(chain.id)?.root ?? null, loopDataRootOptions: { loopDataRoot } })
		expect(findings.map((finding) => finding.mismatch.kind).filter((kind) => kind.startsWith("orphan-")).sort()).toEqual(["orphan-branch", "orphan-directory"])
		expect(existsSync(resources.worktreePath)).toBe(false)
		expect(git(repoCwd, ["worktree", "list", "--porcelain"]).stdout).not.toContain(resources.worktreePath)
		expect(git(repoCwd, ["show-ref", "--verify", resources.branchName]).exitCode).not.toBe(0)
	} finally { store.close() }
})

test("startup reconciliation preserves orphan directories when repository scans fail and reports the failure", async () => {
	const root = resolve(tmpdir(), `coder-loop-reconcile-scan-failure-${process.pid}-${Date.now()}`)
	const repoCwd = resolve(root, "not-a-git-repository")
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(repoCwd, { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "reconcile-scan-failure-chain")
		const item = makeItem(store, chain, "reconcile-scan-failure", repoCwd)
		const orphanPath = resolve(loopDataRoot, "chains", chain.name, "worktrees", "orphan")
		await mkdir(orphanPath, { recursive: true })
		const findings = await reconcileClosureResources({ chain, items: [item], tree: null, loopDataRootOptions: { loopDataRoot } })
		expect(findings).toContainEqual({
			closureId: null,
			repoCwd,
			mismatch: expect.objectContaining({ kind: "repository-scan-failed", surface: "branches", repaired: false }),
		})
		expect(findings).toContainEqual({
			closureId: null,
			repoCwd,
			mismatch: expect.objectContaining({ kind: "repository-scan-failed", surface: "worktrees", repaired: false }),
		})
		expect(existsSync(orphanPath)).toBe(true)
	} finally {
		store.close()
		await rm(root, { recursive: true, force: true })
	}
})

test("startup reconciliation attributes a registered orphan worktree to its owning repository", async () => {
	const root = resolve(TEST_ROOT, "reconcile-multi-repo")
	const firstRepo = resolve(root, "first-repo")
	const secondRepo = resolve(root, "second-repo")
	await initGitRepo(firstRepo)
	await initGitRepo(secondRepo)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "reconcile-multi-repo-chain")
		const firstItem = makeItem(store, chain, "reconcile-first", firstRepo)
		const secondItem = makeItem(store, chain, "reconcile-second", secondRepo)
		const orphanPath = resolve(loopDataRoot, "chains", chain.name, "worktrees", "second-repo-orphan")
		expect(git(secondRepo, ["worktree", "add", "-b", `coder-loop/closures/${chain.name}/orphan`, orphanPath, "main"]).exitCode).toBe(0)
		const findings = await reconcileClosureResources({ chain, items: [firstItem, secondItem], tree: null, loopDataRootOptions: { loopDataRoot } })
		const orphan = findings.find((finding) => finding.mismatch.kind === "orphan-directory" && finding.mismatch.path === orphanPath)
		expect(orphan?.repoCwd).toBe(secondRepo)
		expect(orphan?.mismatch.repaired).toBe(true)
	} finally { store.close() }
})

test("startup reconciliation reports failed orphan branch and worktree repairs without deleting residue", async () => {
	const root = resolve(TEST_ROOT, "reconcile-repair-failure")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "reconcile-repair-failure-chain")
		const item = makeItem(store, chain, "reconcile-repair-failure", repoCwd)
		const orphanPath = resolve(loopDataRoot, "chains", chain.name, "worktrees", "locked-orphan")
		const orphanBranch = `coder-loop/closures/${chain.name}/locked-orphan`
		const lockedBranch = `coder-loop/closures/${chain.name}/locked-ref`
		expect(git(repoCwd, ["worktree", "add", "-b", orphanBranch, orphanPath, "main"]).exitCode).toBe(0)
		expect(git(repoCwd, ["worktree", "lock", orphanPath]).exitCode).toBe(0)
		expect(git(repoCwd, ["branch", lockedBranch, "main"]).exitCode).toBe(0)
		const lockedRef = resolve(repoCwd, ".git", "refs", "heads", ...lockedBranch.split("/"))
		await writeFile(`${lockedRef}.lock`, "lock update-ref for the failure-path assertion\n")
		const findings = await reconcileClosureResources({ chain, items: [item], tree: null, loopDataRootOptions: { loopDataRoot } })
		expect(findings).toContainEqual({
			closureId: null,
			repoCwd,
			mismatch: expect.objectContaining({ kind: "orphan-directory", path: orphanPath, repaired: false, error: expect.stringContaining("worktree remove failed (exit") }),
		})
		expect(findings).toContainEqual({
			closureId: null,
			repoCwd,
			mismatch: expect.objectContaining({ kind: "orphan-branch", branchName: `refs/heads/${lockedBranch}`, repaired: false, error: expect.stringContaining("update-ref -d failed (exit") }),
		})
		expect(existsSync(orphanPath)).toBe(true)
		expect(git(repoCwd, ["show-ref", "--verify", `refs/heads/${lockedBranch}`]).exitCode).toBe(0)
	} finally { store.close() }
})

test("consumed cleanup rejects persisted resources outside the closure-derived engine namespace", async () => {
	const root = resolve(TEST_ROOT, "cleanup-foreign-resources")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const foreignPath = resolve(root, "foreign-worktree")
	await mkdir(foreignPath, { recursive: true })
	await writeFile(resolve(foreignPath, "keep.txt"), "must survive\n")
	expect(git(repoCwd, ["branch", "foreign-branch", "main"]).exitCode).toBe(0)
	const closure = { closureId: "closure:foreign:iteration", itemRowId: 1, itemId: "foreign", phase: "iteration", lifecycle: "consumed", worktreePath: foreignPath, branchName: "refs/heads/foreign-branch", baseCommit: git(repoCwd, ["rev-parse", "main"]).stdout, sourceParNodeId: null, sessions: [] } as const

	const [result] = await cleanupSchedulerChainWorktrees([{ chainName: "cleanup-foreign-resources", repoCwd, closure, loopDataRootOptions: { loopDataRoot: root } }])
	expect(result).toMatchObject({ removed: false, directoryRemoved: false, pruned: false })
	expect(result?.error).toContain("outside engine closure namespace")
	expect(existsSync(resolve(foreignPath, "keep.txt"))).toBe(true)
	expect(git(repoCwd, ["show-ref", "--verify", "refs/heads/foreign-branch"]).exitCode).toBe(0)
})

test("serialized closure consumption removes only owned resources and emits evidence with freshness", async () => {
	const root = resolve(TEST_ROOT, "consume-resources")
	const repoCwd = resolve(root, "repo")
	await initGitRepo(repoCwd)
	const loopDataRoot = resolve(root, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = makeChain(store, "consume-resources-chain")
		const item = makeItem(store, chain, "consume", repoCwd)
		const manager = createGitWorktreeManager({ loopDataRoot })
		const resources = await manager({ chain, item, phase: "iteration", closureId: "closure:consume:iteration", repoCwd, slotKey: "slot", existing: null })
		if (typeof resources === "string") throw new Error("expected closure resources")
		const closure = { closureId: "closure:consume:iteration", itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: resources.worktreePath, branchName: resources.branchName, baseCommit: resources.baseCommit, sourceParNodeId: null, sessions: [] } as const
		store.createTaskTree(chain.id, { root: { kind: "leaf", identity: { runtimeNodeId: "leaf-consume", definitionRef: { kind: "chain", contentIdentity: "sha256:consume" }, definitionNodeId: "iteration" }, closure }, activeRuns: [] })
		const events: SchedulerEvent[] = []
		store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_900_000_099 })
		const result = await consumeSchedulerClosure({ chainId: chain.id, chainName: chain.name, baseBranch: chain.baseBranch, repoCwd, closure, authority: { kind: "outer-completion", chainId: chain.id, terminalStatuses: [runtimeStatus("done")] }, updatedAt: 1_900_000_100, loopDataRootOptions: { loopDataRoot }, store, emit: (event) => { events.push(event) } })
		expect(result.decision.kind).toBe("consumed")
		expect(result.cleanup).toMatchObject({ registered: true, removed: true, error: null })
		expect(existsSync(resources.worktreePath)).toBe(false)
		expect(store.getTaskTree(chain.id)?.root).toMatchObject({ closure: { lifecycle: "consumed", worktreePath: null, branchName: null, sessions: [] } })
		expect(events).toEqual([{ type: "closure.consumed", chainId: chain.id, closureId: closure.closureId, evidence: "no-work", freshness: { kind: "no-origin", availability: "unavailable", commit: resources.baseCommit } }])
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
