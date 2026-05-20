import { describe, expect, test } from "bun:test"

import { openStateStore, type StateStore } from "./state-db"
import {
	clearSchedulerRun,
	createSchedulerState,
	runSchedulerTick,
	schedulerSlotKey,
	schedulerWorktreeBranchName,
	schedulerWorktreePath,
	type SchedulerRun,
	type SchedulerStore,
} from "./scheduler"

async function withStore<T>(fn: (store: StateStore) => T | Promise<T>): Promise<T> {
	const store = openStateStore(":memory:")
	try {
		return await fn(store)
	} finally {
		store.close()
	}
}

describe("scheduler", () => {
	test("serializes one chain/repo slot, skips duplicate spawn while busy, then advances after terminal item", async () => {
		await withStore(async (store) => {
			const chain = store.createChain("release-chain", "gh-issue-pr-iteration")
			const first = store.addItem(chain.id, { issue: 1, repoCwd: "/repo/a" })
			const second = store.addItem(chain.id, { issue: 2, repoCwd: "/repo/a" })
			store.addItem(chain.id, { issue: 3, repoCwd: "/repo/a" })
			const schedulerState = createSchedulerState()
			const spawnedIssues: number[] = []
			const worktrees: string[] = []
			let ensureWorktreeCalls = 0

			const spawnAgent = ({ item }: { item: { id: number; issue: number } }): SchedulerRun => {
				spawnedIssues.push(item.issue)
				return { runId: `run-${item.issue}`, pid: 1000 + item.issue, itemId: item.id }
			}

			const firstTick = await runSchedulerTick({
				store,
				state: schedulerState,
				ensureWorktree: ({ chain, slot }) => {
					ensureWorktreeCalls++
					const path = schedulerWorktreePath("/worktrees", chain, slot.repoCwd)
					worktrees.push(path)
					return path
				},
				spawnAgent,
			})

			expect(firstTick.spawned.map((record) => record.item.id)).toEqual([first.id])
			expect(spawnedIssues).toEqual([1])
			expect(ensureWorktreeCalls).toBe(1)
			expect(schedulerState.slots.get(schedulerSlotKey(chain.id, "/repo/a"))?.currentRun?.runId).toBe("run-1")

			const busyTick = await runSchedulerTick({ store, state: schedulerState, spawnAgent })
			expect(busyTick.spawned).toEqual([])
			expect(busyTick.skippedBusySlots.map((slot) => slot.repoCwd)).toEqual(["/repo/a"])
			expect(spawnedIssues).toEqual([1])

			store.updateItem(first.id, { status: "done" })
			expect(clearSchedulerRun(schedulerState, "run-1")?.repoCwd).toBe("/repo/a")

			const nextTick = await runSchedulerTick({
				store,
				state: schedulerState,
				ensureWorktree: () => {
					throw new Error("same slot must reuse its existing worktree")
				},
				spawnAgent,
			})

			expect(nextTick.spawned.map((record) => record.item.id)).toEqual([second.id])
			expect(nextTick.spawned[0]?.worktreePath).toBe(worktrees[0])
			expect(spawnedIssues).toEqual([1, 2])
		})
	})

	test("spawns different repos in one chain and the same repo in different chains concurrently", async () => {
		await withStore(async (store) => {
			const chainA = store.createChain("chain-a", "gh-issue-pr-iteration")
			const chainB = store.createChain("chain-b", "gh-issue-pr-iteration")
			store.addItem(chainA.id, { issue: 10, repoCwd: "/repo/a" })
			store.addItem(chainA.id, { issue: 11, repoCwd: "/repo/b" })
			store.addItem(chainB.id, { issue: 20, repoCwd: "/repo/a" })
			const schedulerState = createSchedulerState()

			const tick = await runSchedulerTick({
				store,
				state: schedulerState,
				spawnAgent: ({ item }) => ({ runId: `run-${item.issue}`, pid: 2000 + item.issue, itemId: item.id }),
			})

			expect(tick.spawned.map((record) => [record.chain.id, record.item.repoCwd, record.item.issue])).toEqual([
				[chainA.id, "/repo/a", 10],
				[chainA.id, "/repo/b", 11],
				[chainB.id, "/repo/a", 20],
			])
			expect([...schedulerState.slots.keys()].sort()).toEqual([
				schedulerSlotKey(chainA.id, "/repo/a"),
				schedulerSlotKey(chainA.id, "/repo/b"),
				schedulerSlotKey(chainB.id, "/repo/a"),
			].sort())
		})
	})

	test("completes terminal chains and skips completed chains on later ticks", async () => {
		await withStore(async (store) => {
			const chain = store.createChain("done-chain", "gh-issue-pr-iteration")
			store.addItem(chain.id, { issue: 30, repoCwd: "/repo/a", status: "done" })
			const schedulerState = createSchedulerState()

			const completeTick = await runSchedulerTick({
				store,
				state: schedulerState,
				spawnAgent: ({ item }) => ({ runId: `run-${item.issue}`, pid: 3000 + item.issue, itemId: item.id }),
			})

			expect(completeTick.spawned).toEqual([])
			expect(completeTick.completedChains.map((completed) => completed.id)).toEqual([chain.id])
			expect(store.getChain(chain.id)?.status).toBe("completed")
			expect(schedulerState.slots.size).toBe(0)

			const laterTick = await runSchedulerTick({
				store,
				state: schedulerState,
				spawnAgent: ({ item }) => ({ runId: `run-${item.issue}`, pid: 4000 + item.issue, itemId: item.id }),
			})
			expect(laterTick.activeChains).toBe(0)
			expect(laterTick.spawned).toEqual([])
		})
	})

	test("does not query repo slots when no active chains are returned", async () => {
		const schedulerState = createSchedulerState()
		const store: SchedulerStore = {
			listActiveChains: () => [],
			listRepoCwdsForChain: () => {
				throw new Error("completed chains must not be expanded into slots")
			},
			getNextPending: () => {
				throw new Error("completed chains must not query pending items")
			},
			allItemsTerminal: () => {
				throw new Error("completed chains must not run terminal checks")
			},
			completeChain: () => {
				throw new Error("completed chains must not be completed again")
			},
		}

		const tick = await runSchedulerTick({
			store,
			state: schedulerState,
			spawnAgent: ({ item }) => ({ runId: `run-${item.issue}`, pid: item.issue, itemId: item.id }),
		})

		expect(tick).toEqual({ activeChains: 0, spawned: [], completedChains: [], skippedBusySlots: [] })
		expect(schedulerState.slots.size).toBe(0)
	})

	test("derives stable slot worktree names and issue branch names", async () => {
		await withStore(async (store) => {
			const chain = store.createChain("release/train", "gh-issue-pr-iteration")

			expect(schedulerWorktreeBranchName(chain.name, 126)).toBe("coder-loop/release-train/126")
			expect(schedulerWorktreePath("/worktrees", chain, "/Users/mouriya/code/coder-loop")).toMatch(
				/^\/worktrees\/release-train\/coder-loop-[0-9a-f]{10}$/,
			)
		})
	})
})
