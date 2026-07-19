import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import {
	closureBranchName,
	closureBranchPrefix,
	closureResourcesBelongToEngine,
	closureWorktreePath,
	classifyClosureResourceOwnership,
	computeClosureReachability,
	createRepositoryGitCoordinator,
	persistedClosureReachabilityModel,
	persistedParPin,
	type ClosureReachabilityModel,
} from "../../../src/closure-lifecycle"
import type { TaskNodeSnapshot, TaskTreeSnapshot } from "../../../src/task-runtime"

const TEST_ROOT = resolve(import.meta.dir, "../../../.coder-loop/runtime/evidence/closure-lifecycle-tests", String(process.pid))

describe("closure reachability fixed point", () => {
	test("transitively protects seeded closures and leaves unrelated closures consumable", () => {
		const model: ClosureReachabilityModel = {
			closures: ["attempt", "ancestor", "future", "sealed"],
			seeds: [
				{ kind: "active-run", closureId: "attempt" },
				{ kind: "decided-reopen", closureId: "ancestor" },
			],
			edges: [
				{ kind: "scope-target", fromClosureId: "ancestor", toClosureId: "future" },
				{ kind: "resume", fromClosureId: "future", toClosureId: "attempt" },
			],
		}
		expect([...computeClosureReachability(model)].sort()).toEqual(["ancestor", "attempt", "future"])
	})

	test("open append and next-epoch candidates are explicit seeds without producer APIs", () => {
		const model: ClosureReachabilityModel = {
			closures: ["append-target", "join-target", "closed"],
			seeds: [
				{ kind: "open-append", closureId: "append-target" },
				{ kind: "next-epoch-candidate", closureId: "join-target" },
			],
			edges: [],
		}
		expect(computeClosureReachability(model)).toEqual(new Set(["append-target", "join-target"]))
	})

	test("completed par decisions and newer bindings do not seed every descendant", () => {
		const definitionRef = { kind: "chain", contentIdentity: "sha256:targeted-par" } as const
		const leaf = (id: string): TaskNodeSnapshot => ({
			kind: "leaf",
			identity: { runtimeNodeId: `leaf-${id}`, definitionRef, definitionNodeId: id },
			closure: {
				closureId: `closure-${id}`,
				itemRowId: id === "target" ? 1 : 2,
				itemId: id,
				phase: "iteration",
				lifecycle: "suspended",
				worktreePath: `/worktrees/${id}`,
				branchName: `refs/heads/${id}`,
				baseCommit: "0123456789abcdef",
				sourceParNodeId: "par-targeted",
				sessions: [],
			},
		})
		const tree: TaskTreeSnapshot = {
			root: {
				kind: "par",
				identity: { runtimeNodeId: "par-targeted", definitionRef, definitionNodeId: "par" },
				groupId: "par-targeted",
				pinCommit: "0123456789abcdef",
				state: "completed",
				reopen: { count: 1, budgetRef: "chain.maxReopens" },
				join: { currentVersion: 2, value: { kind: "drain" }, evaluation: { kind: "decided", epoch: 1, bindingVersion: 1 } },
				children: [leaf("target"), leaf("sibling")],
			},
			activeRuns: [],
		}

		const model = persistedClosureReachabilityModel(tree, new Set([1, 2]))

		expect(model.seeds).toEqual([])
		expect(computeClosureReachability(model)).toEqual(new Set())
	})

	test("open par structure still protects every live descendant", () => {
		const definitionRef = { kind: "chain", contentIdentity: "sha256:open-par" } as const
		const closure = {
			closureId: "closure-open",
			itemRowId: 1,
			itemId: "open",
			phase: "iteration",
			lifecycle: "suspended",
			worktreePath: "/worktrees/open",
			branchName: "refs/heads/open",
			baseCommit: "0123456789abcdef",
			sourceParNodeId: "par-open",
			sessions: [],
		} as const
		const tree: TaskTreeSnapshot = {
			root: {
				kind: "par",
				identity: { runtimeNodeId: "par-open", definitionRef, definitionNodeId: "par" },
				groupId: "par-open",
				pinCommit: closure.baseCommit,
				state: "open",
				reopen: { count: 0, budgetRef: "chain.maxReopens" },
				join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
				children: [{ kind: "leaf", identity: { runtimeNodeId: "leaf-open", definitionRef, definitionNodeId: "open" }, closure }],
			},
			activeRuns: [],
		}

		expect(persistedClosureReachabilityModel(tree, new Set([1])).seeds).toEqual([
			{ kind: "open-par-epoch", closureId: closure.closureId },
		])
	})
})

test("closure resource identity is per closure and stays in the engine namespace", () => {
	const root = resolve(TEST_ROOT, "identity")
	const closureId = "closure:1:iteration"
	const iteration = closureWorktreePath(root, "chain", "/repo", closureId)
	const review = closureWorktreePath(root, "chain", "/repo", "closure:1:review")
	expect(iteration).not.toBe(review)
	const branch = closureBranchName("chain", closureId)
	expect(branch).not.toBe(closureBranchName("chain", "closure:1:review"))
	expect(branch).toStartWith(closureBranchPrefix("chain"))
	expect(closureResourcesBelongToEngine(root, "chain", "/repo", closureId, iteration, branch)).toBe(true)
	const outsideRoot = closureWorktreePath(resolve(TEST_ROOT, "outside-engine-root"), "chain", "/repo", closureId)
	expect(closureResourcesBelongToEngine(root, "chain", "/repo", closureId, outsideRoot, branch)).toBe(false)
})

test("v13 migration provenance distinguishes an ambiguous historical tuple from arbitrary foreign state", () => {
	expect(classifyClosureResourceOwnership({
		loopDataRoot: "/loop-data",
		chainName: "chain",
		repoCwd: "/repo",
		closureId: "legacy-v13:closure:12:iteration",
		worktreePath: "/repo",
		branchName: "historical-pr-branch",
	})).toEqual({ kind: "migrated-legacy", worktree: { kind: "foreign" }, branchRef: "refs/heads/historical-pr-branch" })
	expect(classifyClosureResourceOwnership({
		loopDataRoot: "/loop-data",
		chainName: "chain",
		repoCwd: "/repo",
		closureId: "closure:12:iteration",
		worktreePath: "/repo",
		branchName: "historical-pr-branch",
	})).toEqual({ kind: "foreign" })
})

test("par members derive their first-open base only from the persisted containing pin", () => {
	expect(persistedParPin({ sourceParNodeId: "par-outer", baseCommit: "outer-pin" })).toBe("outer-pin")
	expect(persistedParPin({ sourceParNodeId: "par-nested", baseCommit: "nested-pin" })).toBe("nested-pin")
	expect(persistedParPin({ sourceParNodeId: null, baseCommit: "ordinary-base" })).toBeNull()
})

test("repository Git coordinator serializes operations for one repo but not another", async () => {
	const coordinator = createRepositoryGitCoordinator()
	const order: string[] = []
	let releaseFirst!: () => void
	const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate })
	const first = coordinator.run("/repo-a", async () => {
		order.push("a1-start")
		await firstGate
		order.push("a1-end")
	})
	const second = coordinator.run("/repo-a", async () => { order.push("a2") })
	const other = coordinator.run("/repo-b", async () => { order.push("b1") })
	await other
	expect(order).toEqual(["a1-start", "b1"])
	releaseFirst()
	await Promise.all([first, second])
	expect(order).toEqual(["a1-start", "b1", "a1-end", "a2"])
	await rm(TEST_ROOT, { recursive: true, force: true })
})

test("repository Git coordinator singleflights one keyed fetch per repo", async () => {
	const coordinator = createRepositoryGitCoordinator()
	let calls = 0
	let release!: () => void
	const gate = new Promise<void>((resolveGate) => { release = resolveGate })
	const fetched = { commit: "fetched-base", freshness: { kind: "fetched", remote: "origin", commit: "fetched-base", observedAt: "2026-07-16T00:00:00.000Z" } } as const
	const operation = async () => {
		calls += 1
		await gate
		return fetched
	}
	const first = coordinator.singleflight("/repo-a", "fetch:main", operation)
	const second = coordinator.singleflight("/repo-a", "fetch:main", operation)
	const releaseBase = { commit: "release-base", freshness: { kind: "retained", commit: "release-base" } } as const
	const otherKey = coordinator.singleflight("/repo-a", "fetch:release", async () => releaseBase)
	expect(calls).toBe(1)
	expect(await otherKey).toEqual(releaseBase)
	release()
	expect(await Promise.all([first, second])).toEqual([fetched, fetched])
	expect(calls).toBe(1)
})
