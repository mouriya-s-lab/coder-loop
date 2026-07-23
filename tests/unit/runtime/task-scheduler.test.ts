import { describe, expect, test } from "bun:test"

import { selectAttemptExhaustionLeaf } from "../../../src/scheduler"
import { parseInternalStatus, storedItemExtra } from "../../../src/runtime-data"
import type { RunRecord } from "../../../src/sqlite-state"
import { collectReadyTaskLeaves, decideClosureDispatch } from "../../../src/task-runtime"
import type { ClosureSnapshot, TaskNodeSnapshot } from "../../../src/task-runtime"

const definitionRef = { kind: "preset", contentIdentity: "sha256:test" } as const

function leaf(id: string, state: "pending" | "completed" | "exhausted" = "pending"): Extract<TaskNodeSnapshot, { kind: "leaf" }> {
	return {
		kind: "leaf",
		identity: { runtimeNodeId: id, definitionRef, definitionNodeId: id },
		state,
		closure: {
			closureId: `closure:${id}`,
			itemRowId: 1,
			itemId: "item",
			phase: id,
			lifecycle: "active",
			worktreePath: `/worktrees/${id}`,
			branchName: `branch-${id}`,
			baseCommit: "0123456789abcdef",
			sourceParNodeId: id.startsWith("p-") ? "par" : null,
			sessions: [],
		},
	}
}

describe("recursive scheduler readiness", () => {
	test("decides every closure lifecycle and live-run combination explicitly", () => {
		const active = leaf("a").closure
		const suspended: ClosureSnapshot = { ...active, lifecycle: "suspended" }
		const consumed: ClosureSnapshot = { ...active, lifecycle: "consumed" }

		expect(decideClosureDispatch(null, false)).toEqual({ kind: "create" })
		expect(decideClosureDispatch(suspended, false)).toEqual({ kind: "reopen", closureId: active.closureId })
		expect(decideClosureDispatch(active, false)).toEqual({ kind: "resume", closureId: active.closureId })
		expect(decideClosureDispatch(active, true)).toEqual({ kind: "deny-active-live", closureId: active.closureId })
		expect(decideClosureDispatch(consumed, false)).toEqual({ kind: "never-spawn", closureId: active.closureId, reason: "consumed" })
	})

	test("walks only the seq cursor while opening all par members up to the declared limit", () => {
		const root: TaskNodeSnapshot = {
			kind: "seq",
			identity: { runtimeNodeId: "root", definitionRef, definitionNodeId: "root" },
			cursor: { kind: "next", nodeId: "par" },
			children: [{
				kind: "par",
				identity: { runtimeNodeId: "par", definitionRef, definitionNodeId: "par" },
				groupId: "par",
				pinCommit: "0123456789abcdef",
				maxConcurrency: 2,
				state: "open",
				reopen: { count: 0, budgetRef: "chain.maxReopens" },
				join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
				children: [leaf("p-a"), leaf("p-b"), leaf("p-c")],
			}, leaf("after")],
		}
		expect(collectReadyTaskLeaves(root, new Set())).toEqual(["p-a", "p-b"])
		expect(collectReadyTaskLeaves(root, new Set(["closure:p-a"]))).toEqual(["p-b"])
	})

	test("completed and exhausted leaves both satisfy structural drain", () => {
		const root: TaskNodeSnapshot = {
			kind: "par",
			identity: { runtimeNodeId: "par", definitionRef, definitionNodeId: "par" },
			groupId: "par",
			pinCommit: "0123456789abcdef",
			maxConcurrency: null,
			state: "open",
			reopen: { count: 0, budgetRef: "chain.maxReopens" },
			join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
			children: [leaf("p-a", "completed"), leaf("p-b", "exhausted")],
		}
		expect(collectReadyTaskLeaves(root, new Set())).toEqual([])
	})

	test("attributes an exhausted shared attempt to the failed leaf instead of successful par siblings", () => {
		const root: TaskNodeSnapshot = {
			kind: "par",
			identity: { runtimeNodeId: "par", definitionRef, definitionNodeId: "par" },
			groupId: "par",
			pinCommit: "0123456789abcdef",
			maxConcurrency: null,
			state: "open",
			reopen: { count: 0, budgetRef: "chain.maxReopens" },
			join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
			children: [leaf("p-failed"), leaf("p-success-one", "completed"), leaf("p-success-two", "completed")],
		}
		const run = (id: number, runtimeNodeId: string, exitCode: number): RunRecord => ({
			id,
			runId: `run-${id}`,
			chainId: 1,
			itemId: 1,
			closureId: `closure:${runtimeNodeId}`,
			runtimeNodeId,
			phase: runtimeNodeId,
			status: parseInternalStatus("queued", "test.run.status"),
			startedAt: 100 + id,
			endedAt: 200 + id,
			exitCode,
			extra: storedItemExtra({}),
		})

		expect(selectAttemptExhaustionLeaf(root, { id: 1 }, [
			run(1, "p-failed", 1),
			run(2, "p-success-one", 0),
			run(3, "p-success-two", 0),
		])).toEqual({
			runtimeNodeId: "p-failed",
			runId: "run-1",
			reason: "failed-run",
		})

		const afterFailure: TaskNodeSnapshot = {
			...root,
			children: [leaf("p-failed", "exhausted"), leaf("p-unattempted"), leaf("p-success-two", "completed")],
		}
		expect(collectReadyTaskLeaves(afterFailure, new Set())).toEqual(["p-unattempted"])
		expect(selectAttemptExhaustionLeaf(afterFailure, { id: 1 }, [
			run(1, "p-failed", 1),
		])).toBeNull()
		expect(selectAttemptExhaustionLeaf(root, { id: 1 }, [])).toBeNull()
	})
})
