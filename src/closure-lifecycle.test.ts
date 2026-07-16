import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import {
	closureBranchName,
	closureBranchPrefix,
	closureWorktreePath,
	computeClosureReachability,
	createRepositoryGitCoordinator,
	persistedParPin,
	type ClosureReachabilityModel,
} from "./closure-lifecycle"

const TEST_ROOT = resolve(import.meta.dir, "../.coder-loop/runtime/evidence/closure-lifecycle-tests", String(process.pid))

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
})

test("closure resource identity is per closure and stays in the engine namespace", () => {
	const root = resolve(TEST_ROOT, "identity")
	const iteration = closureWorktreePath(root, "chain", "/repo", "closure:1:iteration")
	const review = closureWorktreePath(root, "chain", "/repo", "closure:1:review")
	expect(iteration).not.toBe(review)
	expect(closureBranchName("chain", "closure:1:iteration")).not.toBe(closureBranchName("chain", "closure:1:review"))
	expect(closureBranchName("chain", "closure:1:iteration")).toStartWith(closureBranchPrefix("chain"))
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
