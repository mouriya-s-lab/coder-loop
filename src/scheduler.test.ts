import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
	createSchedulerState,
	defaultSchedulerStatusFromExit,
	listActiveRuns,
	makeRunId,
	renderSchedulerSpawnPrompt,
	resumeDecisionForItem,
	reviewOnEmptyLockPathForChain,
	runSchedulerUntilIdle,
	schedulerSlotWorktreePath,
	schedulerTick,
	serializeSchedulerReviewOnEmptyLock,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerPhaseRunner,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { resolveSchedulerPresetPhasePrompt } from "./daemon"
import {
	buildRunnerInvocation,
	loadPreset,
	resolvePhaseRunnerFromChain,
	runPresetChainCompleteTriggerPhases,
	type AgentRunnerSelection,
	type JsonObject,
} from "./loop"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { type ChainRecord, type ItemRecord, openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests", String(process.pid))

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("scheduler", () => {
	test("single chain single repo serial", async () => {
		const fixture = await createFixture("serial")
		try {
			const chain = createChain(fixture.store, "serial-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a" })
			createItem(fixture.store, chain, { issueNumber: 181, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			const events = await readRunnerEvents(fixture.eventLog)
			expect(events.map((event) => `${event.type}:${event.issueNumber}`)).toEqual([
				"start:179",
				"end:179",
				"start:180",
				"end:180",
				"start:181",
				"end:181",
			])
			expect(maxConcurrentRunnerEvents(events)).toBe(1)
			expect(new Set(events.map((event) => event.cwd)).size).toBe(1)
			expect(fixture.worktreeCalls).toHaveLength(1)
			expect(fixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["done", "done", "done"])
		} finally {
			fixture.store.close()
		}
	})

	test("single chain multi repo concurrent", async () => {
		const fixture = await createFixture("multi-repo")
		try {
			const chain = createChain(fixture.store, "multi-repo-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/b", sleepMs: 80 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(listActiveRuns(fixture.state)).toHaveLength(2)
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))

			const events = await readRunnerEvents(fixture.eventLog)
			expect(maxConcurrentRunnerEvents(events)).toBe(2)
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			fixture.store.close()
		}
	})

	test("invalid chain names are ignored by scheduler ticks", async () => {
		const fixture = await createFixture("invalid-chain-skip")
		try {
			const invalid = createChain(fixture.store, "..")
			const valid = createChain(fixture.store, "valid-chain")
			createItem(fixture.store, invalid, { issueNumber: 178, repoCwd: "/repo/a" })
			createItem(fixture.store, valid, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemByIssue(invalid.id, 178)?.status).toBe("queued")
			expect(fixture.store.getItemByIssue(valid.id, 179)?.status).toBe("done")
			expect(fixture.worktreeCalls).toHaveLength(1)
			expect(fixture.worktreeCalls[0]).toContain("valid-chain")
		} finally {
			fixture.store.close()
		}
	})

	test("multi chain same repo worktree isolation", async () => {
		const fixture = await createFixture("multi-chain")
		try {
			const chainA = createChain(fixture.store, "chain-a")
			const chainB = createChain(fixture.store, "chain-b")
			createItem(fixture.store, chainA, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chainB, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 80 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(new Set(tick.spawnedRuns.map((run) => run.worktreePath)).size).toBe(2)
			expect(tick.spawnedRuns[0]?.worktreePath).not.toBe(tick.spawnedRuns[1]?.worktreePath)
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
		} finally {
			fixture.store.close()
		}
	})

	test("slot busy skip", async () => {
		const fixture = await createFixture("busy")
		try {
			const chain = createChain(fixture.store, "busy-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 80 })

			const firstTick = await schedulerTick(fixture.options())
			const secondTick = await schedulerTick(fixture.options())
			expect(firstTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)?.extra).toMatchObject({ itemId: firstTick.spawnedRuns[0]?.itemId, pid: firstTick.spawnedRuns[0]?.pid })
			expect(fixture.schedulerEvents.some((event) => event.type === "slot.busy")).toBe(true)
			expect(fixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["in_progress", "queued"])
			await firstTick.spawnedRuns[0]!.closed
		} finally {
			fixture.store.close()
		}
	})

	test("advance after terminal", async () => {
		const fixture = await createFixture("advance")
		try {
			const chain = createChain(fixture.store, "advance-chain")
			const first = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 10 })
			const second = createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 10 })

			const firstTick = await schedulerTick(fixture.options())
			await firstTick.spawnedRuns[0]!.closed
			const secondTick = await schedulerTick(fixture.options())

			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(first.id)?.status).toBe("done")
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed
		} finally {
			fixture.store.close()
		}
	})

	test("chain completion", async () => {
		const fixture = await createFixture("completion")
		try {
			const chain = createChain(fixture.store, "completion-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(true)
		} finally {
			fixture.store.close()
		}
	})

	test("chain-complete trigger runs before chain completion", async () => {
		const fixture = await createFixture("completion-trigger")
		try {
			const chain = createChain(fixture.store, "completion-trigger-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 2691, repoCwd: "/repo/a" })
			const observedChainStatuses: string[] = []

			await runSchedulerUntilIdle(fixture.options({
				chainCompleteTrigger: ({ chain: triggerChain }) => {
					observedChainStatuses.push(fixture.store.getChain(triggerChain.id)?.status ?? "missing")
					return { decision: "complete", reason: "fixture finalizer passed" }
				},
			}))

			expect(observedChainStatuses).toEqual(["active"])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents.map((event) => event.type)).toEqual([
				"agent.spawn",
				"phase.start",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.complete_trigger",
				"chain.completed",
			])
		} finally {
			fixture.store.close()
		}
	})

	test("chain-complete trigger does not run twice during overlapping completion ticks", async () => {
		const fixture = await createFixture("completion-trigger-overlap")
		try {
			const chain = createChain(fixture.store, "completion-trigger-overlap-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 2696, repoCwd: "/repo/a" })
			const triggerStarted = createDeferred()
			const releaseTrigger = createDeferred()
			let triggerCalls = 0
			const options = fixture.options({
				chainCompleteTrigger: async () => {
					triggerCalls += 1
					triggerStarted.resolve()
					await releaseTrigger.promise
					return { decision: "complete", reason: "fixture finalizer passed" }
				},
			})

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			const closed = firstTick.spawnedRuns[0]!.closed
			await triggerStarted.promise

			const overlappingTickPromise = schedulerTick(options)
			try {
				const settledBeforeRelease = await promiseSettledWithin(overlappingTickPromise, 100)
				expect(settledBeforeRelease).toBe(true)
				const overlappingTick = await overlappingTickPromise
				expect(overlappingTick.spawnedRuns).toHaveLength(0)
				expect(overlappingTick.completedChainIds).toEqual([])
				expect(triggerCalls).toBe(1)
			} finally {
				releaseTrigger.resolve()
				await Promise.allSettled([overlappingTickPromise, closed])
			}

			expect(triggerCalls).toBe(1)
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toHaveLength(1)
		} finally {
			fixture.store.close()
		}
	})

	test("chain-complete trigger can keep chain active", async () => {
		const fixture = await createFixture("completion-trigger-active")
		try {
			const chain = createChain(fixture.store, "completion-trigger-active-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			createItem(fixture.store, chain, { issueNumber: 2692, repoCwd: "/repo/a" })
			let triggerCalls = 0
			const options = fixture.options({
				chainCompleteTrigger: () => {
					triggerCalls += 1
					return { decision: "keep-active", reason: "fixture follow-up required" }
				},
			})

			const firstTick = await schedulerTick(options)
			await firstTick.spawnedRuns[0]!.closed

			expect(firstTick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(triggerCalls).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toHaveLength(1)
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "chain.complete_trigger",
				chainId: chain.id,
				chainName: chain.name,
				decision: "keep-active",
				reason: "fixture follow-up required",
			}))
			expect(fixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(false)

			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(0)
			expect(secondTick.completedChainIds).toEqual([])
			expect(triggerCalls).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toHaveLength(1)

			const followUp = createItem(fixture.store, chain, { issueNumber: 2696, repoCwd: "/repo/a" })
			fixture.store.updateItem(followUp.id, { status: "done", updatedAt: 1_800_000_999 })
			const thirdTick = await schedulerTick(options)
			expect(thirdTick.spawnedRuns).toHaveLength(0)
			expect(thirdTick.completedChainIds).toEqual([])
			expect(triggerCalls).toBe(2)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toHaveLength(2)
		} finally {
			fixture.store.close()
		}

		const followUpFixture = await createFixture("completion-trigger-follow-up")
		try {
			const chain = createChain(followUpFixture.store, "completion-trigger-follow-up-chain")
			preInstallReviewOnEmptyLock(chain, followUpFixture.loopDataRoot)
			createItem(followUpFixture.store, chain, { issueNumber: 2693, repoCwd: "/repo/a" })

			const tick = await schedulerTick(followUpFixture.options({
				chainCompleteTrigger: ({ chain: triggerChain }) => {
					createItem(followUpFixture.store, triggerChain, { issueNumber: 2694, repoCwd: "/repo/a" })
					return { decision: "complete", reason: "fixture follow-up inserted" }
				},
			}))
			await tick.spawnedRuns[0]!.closed

			expect(followUpFixture.store.getChain(chain.id)?.status).toBe("active")
			expect(followUpFixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["done", "queued"])
			expect(followUpFixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(false)
		} finally {
			followUpFixture.store.close()
		}

		const failingFixture = await createFixture("completion-trigger-failing")
		try {
			const chain = createChain(failingFixture.store, "completion-trigger-failing-chain")
			preInstallReviewOnEmptyLock(chain, failingFixture.loopDataRoot)
			createItem(failingFixture.store, chain, { issueNumber: 2695, repoCwd: "/repo/a" })

			const tick = await schedulerTick(failingFixture.options({
				chainCompleteTrigger: () => {
					throw new Error("fixture finalizer failed")
				},
			}))
			await tick.spawnedRuns[0]!.closed

			expect(failingFixture.store.getChain(chain.id)?.status).toBe("active")
			expect(failingFixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "chain.complete_trigger_failed",
				chainId: chain.id,
				chainName: chain.name,
				error: "fixture finalizer failed",
			}))
			expect(failingFixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(false)
		} finally {
			failingFixture.store.close()
		}
	})

	test("manual terminal item update completes chain on next tick", async () => {
		const fixture = await createFixture("manual-terminal-completion")
		try {
			const chain = createChain(fixture.store, "manual-terminal-completion-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 249, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: "done", updatedAt: 1_800_000_500 })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents).toContainEqual({ type: "chain.completed", chainId: chain.id, chainName: chain.name })
		} finally {
			fixture.store.close()
		}
	})

	test("terminated child preserves user terminal item status", async () => {
		const fixture = await createFixture("terminal-preserve")
		try {
			const chain = createChain(fixture.store, "terminal-preserve-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 5_000 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(item.id)?.status).toBe("in_progress")

			fixture.store.updateItem(item.id, { status: "done", updatedAt: 1_800_000_500 })
			const closed = await tick.spawnedRuns[0]!.terminate({ forceAfterMs: 200 })

			expect(closed.exitCode).toBe(1)
			expect(closed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(0)
		} finally {
			fixture.store.close()
		}
	})

	test("same-chain same-repo SIGTERM retry cycle does not starve untouched sibling item", async () => {
		const fixture = await createFixture("retry-fairness")
		try {
			const chain = createChain(fixture.store, "retry-fairness-chain")
			const first = createItem(fixture.store, chain, { issueNumber: 7001, repoCwd: "/repo/a", sleepMs: 5_000 })
			const second = createItem(fixture.store, chain, { issueNumber: 7002, repoCwd: "/repo/a" })

			const firstTick = await schedulerTick(fixture.options())
			expect(firstTick.spawnedRuns).toHaveLength(1)
			expect(firstTick.spawnedRuns[0]?.itemId).toBe(first.id)

			const terminated = await firstTick.spawnedRuns[0]!.terminate({ forceAfterMs: 200 })
			expect(terminated.status).toBe("changes_requested")
			expect(fixture.store.getItem(first.id)?.attempts).toBe(1)
			expect(fixture.store.getItem(second.id)?.attempts).toBe(0)

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItem(second.id)?.attempts).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn").map((event) => event.itemId)).toEqual([first.id, second.id])
		} finally {
			fixture.store.close()
		}
	})

	test("maxItemAttempts exhausts a continuable item before spawning and emits queue.terminal", async () => {
		const fixture = await createFixture("max-item-attempts-exhaust")
		try {
			const chain = createChain(fixture.store, "max-item-attempts-exhaust-chain", {
				metadata: { maxItemAttempts: 2 },
			})
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 7003, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: "changes_requested",
				attempts: 2,
				lastRunId: "run-prior-failure",
				extra: { ...item.extra, schedulerBackoff: { failureCount: 2, nextRunAt: 1_800_000_000 } },
				updatedAt: 1_800_000_500,
			})

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			const exhausted = fixture.store.getItem(item.id)
			expect(exhausted?.status).toBe("exhausted")
			expect(exhausted?.extra.schedulerBackoff).toBeUndefined()
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "queue.terminal",
				itemId: item.id,
				runId: "run-prior-failure",
				terminalStatus: "exhausted",
			}))
		} finally {
			fixture.store.close()
		}
	})

	test("failed spawns enter exponential backoff and a held item does not starve a sibling", async () => {
		const fixture = await createFixture("failure-backoff-sibling")
		try {
			let now = 1_800_010_000
			const chain = createChain(fixture.store, "failure-backoff-sibling-chain", {
				metadata: { maxItemAttempts: 10 },
			})
			const failing = createItem(fixture.store, chain, {
				issueNumber: 7004,
				repoCwd: "/repo/a",
				exitCode: 1,
				summary: null,
			})
			const sibling = createItem(fixture.store, chain, { issueNumber: 7005, repoCwd: "/repo/a" })
			const options = fixture.options({
				now: () => now,
				runIdFactory: ({ item }) => `run-backoff-${item.id}-${now}`,
			})

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			expect(firstTick.spawnedRuns[0]?.itemId).toBe(failing.id)
			await firstTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(failing.id)?.extra.schedulerBackoff).toEqual({
				failureCount: 1,
				nextRunAt: now + 1,
			})

			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(sibling.id)
			await secondTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(sibling.id)?.status).toBe("done")
		} finally {
			fixture.store.close()
		}
	})

	test("failed-spawn backoff persists across scheduler state restart", async () => {
		const fixture = await createFixture("failure-backoff-restart")
		try {
			let now = 1_800_020_000
			const chain = createChain(fixture.store, "failure-backoff-restart-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 7006,
				repoCwd: "/repo/a",
				exitCode: 1,
				summary: null,
			})
			const firstOptions = fixture.options({
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-restart-${selected.id}-${now}`,
			})
			const firstTick = await schedulerTick(firstOptions)
			await firstTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: 1,
				nextRunAt: now + 1,
			})

			const restartedState = createSchedulerState()
			const restartedOptions = fixture.options({
				state: restartedState,
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-restarted-${selected.id}-${now}`,
			})
			const heldTick = await schedulerTick(restartedOptions)
			expect(heldTick.spawnedRuns).toHaveLength(0)

			now += 1
			const retryTick = await schedulerTick(restartedOptions)
			expect(retryTick.spawnedRuns).toHaveLength(1)
			expect(retryTick.spawnedRuns[0]?.itemId).toBe(item.id)
			await retryTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: 2,
				nextRunAt: now + 2,
			})
		} finally {
			fixture.store.close()
		}
	})

	test("forced failure fixture does not spin at 1Hz: thirty seconds spawn at most five runs", async () => {
		const fixture = await createFixture("failure-backoff-30s")
		try {
			let now = 1_800_030_000
			const chain = createChain(fixture.store, "failure-backoff-30s-chain", {
				metadata: { maxItemAttempts: 50 },
			})
			const item = createItem(fixture.store, chain, {
				issueNumber: 7007,
				repoCwd: "/repo/a",
				exitCode: 1,
				summary: null,
			})
			const options = fixture.options({
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-30s-${selected.id}-${now}`,
			})

			let spawnCount = 0
			for (let second = 0; second < 30; second += 1) {
				now = 1_800_030_000 + second
				const tick = await schedulerTick(options)
				spawnCount += tick.spawnedRuns.length
				await Promise.all(tick.spawnedRuns.map((run) => run.closed))
			}

			expect(spawnCount).toBeLessThanOrEqual(5)
			expect(fixture.store.getItem(item.id)?.attempts).toBe(spawnCount)
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: spawnCount,
				nextRunAt: 1_800_030_031,
			})
		} finally {
			fixture.store.close()
		}
	})

	test("empty active chain remains active", async () => {
		const fixture = await createFixture("empty-active")
		try {
			const chain = createChain(fixture.store, "empty-active-chain")

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([])
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			fixture.store.close()
		}
	})

	test("completed chain skipped", async () => {
		const fixture = await createFixture("completed-skip")
		try {
			const chain = createChain(fixture.store, "completed-chain", { status: "completed" })
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.state.slots.size).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			fixture.store.close()
		}
	})

	test("deleted chain skipped", async () => {
		const fixture = await createFixture("deleted-skip")
		try {
			const chain = createChain(fixture.store, "deleted-chain", { status: "deleted" })
			const item = createItem(fixture.store, chain, { issueNumber: 226, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.state.slots.size).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			fixture.store.close()
		}
	})

	test("real subprocess spawn end-to-end", async () => {
		const fixture = await createFixture("subprocess")
		try {
			const chain = createChain(fixture.store, "subprocess-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(closed.exitCode).toBe(0)
			expect(closed.stdout).toContain(`done:${item.id}`)
			expect(fixture.store.getRunByRunId(closed.runId)?.exitCode).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect((await readRunnerEvents(fixture.eventLog)).map((event) => event.type)).toEqual(["start", "end"])
		} finally {
			fixture.store.close()
		}
	})

	test("scheduler run writes run-root artifacts", async () => {
		const fixture = await createFixture("run-artifacts")
		try {
			const chain = createChain(fixture.store, "run-artifacts-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 203, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			const runId = `run-${chain.id}-${item.id}`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as Record<string, unknown>
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = (await readFile(paths.runEventsFile(runId), "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string })

			expect(status).toMatchObject({
				runId,
				chainId: chain.id,
				chainName: chain.name,
				itemId: item.id,
				issueNumber: 203,
				phase: "iteration",
				exitCode: 0,
				status: "done",
			})
			expect(stdout).toContain(`done:${item.id}`)
			expect(stderr).toBe("")
			expect(events.map((event) => event.type)).toEqual([
				"agent.spawn",
				"phase.start",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.completed",
			])
		} finally {
			fixture.store.close()
		}
	})

	test("scheduler emits phase.start / phase.end / queue.terminal with the expected payload", async () => {
		const fixture = await createFixture("phase-events")
		try {
			const chain = createChain(fixture.store, "phase-events-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 286, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			const runId = `run-${chain.id}-${item.id}`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const persisted = (await readFile(paths.runEventsFile(runId), "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JsonObject)

			const phaseStartEvents = fixture.schedulerEvents.filter((event) => event.type === "phase.start")
			const phaseEndEvents = fixture.schedulerEvents.filter((event) => event.type === "phase.end")
			const queueTerminalEvents = fixture.schedulerEvents.filter((event) => event.type === "queue.terminal")

			expect(phaseStartEvents).toHaveLength(1)
			expect(phaseEndEvents).toHaveLength(1)
			expect(queueTerminalEvents).toHaveLength(1)

			const [phaseStart] = phaseStartEvents
			const [phaseEnd] = phaseEndEvents
			const [queueTerminal] = queueTerminalEvents
			if (phaseStart?.type !== "phase.start") throw new Error("expected phase.start")
			if (phaseEnd?.type !== "phase.end") throw new Error("expected phase.end")
			if (queueTerminal?.type !== "queue.terminal") throw new Error("expected queue.terminal")

			expect(phaseStart).toMatchObject({
				type: "phase.start",
				runId,
				chainId: chain.id,
				itemId: item.id,
				repoCwd: "/repo/a",
				phase: "iteration",
			})
			expect(typeof phaseStart.ts).toBe("string")
			expect(Number.isFinite(Date.parse(phaseStart.ts))).toBe(true)
			expect(phaseStart.pid).toEqual(expect.any(Number))

			expect(phaseEnd).toMatchObject({
				type: "phase.end",
				runId,
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				exitCode: 0,
				status: "done",
			})
			expect(typeof phaseEnd.ts).toBe("string")
			expect(Number.isFinite(Date.parse(phaseEnd.ts))).toBe(true)
			expect(phaseEnd.durationSeconds).toBeGreaterThanOrEqual(0)

			expect(queueTerminal).toMatchObject({
				type: "queue.terminal",
				runId,
				chainId: chain.id,
				itemId: item.id,
				terminalStatus: "done",
			})
			expect(typeof queueTerminal.ts).toBe("string")
			expect(Number.isFinite(Date.parse(queueTerminal.ts))).toBe(true)

			const persistedTypes = persisted.map((event) => event.type)
			expect(persistedTypes.filter((type) => type === "phase.start")).toHaveLength(1)
			expect(persistedTypes.filter((type) => type === "phase.end")).toHaveLength(1)
			expect(persistedTypes.filter((type) => type === "queue.terminal")).toHaveLength(1)
			expect(persistedTypes.indexOf("phase.start")).toBeGreaterThan(persistedTypes.indexOf("agent.spawn"))
			expect(persistedTypes.indexOf("phase.end")).toBeGreaterThan(persistedTypes.indexOf("agent.exit"))
			expect(persistedTypes.indexOf("queue.terminal")).toBeGreaterThan(persistedTypes.indexOf("phase.end"))
		} finally {
			fixture.store.close()
		}
	})

	test("non-terminal phase exit does not emit queue.terminal", async () => {
		const fixture = await createFixture("phase-events-non-terminal")
		try {
			const chain = createChain(fixture.store, "phase-events-non-terminal-chain")
			createItem(fixture.store, chain, { issueNumber: 286, repoCwd: "/repo/a", exitCode: 1, summary: null })

			const tick = await schedulerTick(fixture.options())
			await tick.spawnedRuns[0]!.closed

			const phaseEnd = fixture.schedulerEvents.filter((event) => event.type === "phase.end")
			const queueTerminal = fixture.schedulerEvents.filter((event) => event.type === "queue.terminal")

			expect(phaseEnd).toHaveLength(1)
			if (phaseEnd[0]?.type !== "phase.end") throw new Error("expected phase.end")
			expect(phaseEnd[0].status).toBe("changes_requested")
			expect(queueTerminal).toHaveLength(0)
		} finally {
			fixture.store.close()
		}
	})
})

describe("defaultSchedulerStatusFromExit", () => {
	test("exit code != 0 maps to changes_requested regardless of stdout", () => {
		expect(defaultSchedulerStatusFromExit({ exitCode: 1, stdout: "", phase: "iteration", runnerKind: "claude" })).toBe("changes_requested")
		expect(defaultSchedulerStatusFromExit({ exitCode: 137, stdout: "REVIEW SUMMARY: verdict=accepted; ignored", phase: "iteration", runnerKind: "claude" })).toBe("changes_requested")
	})

	test("exit 0 with no SUMMARY marker maps to changes_requested", () => {
		const stdout = "exploration log line\nanother line without summary\n"
		expect(defaultSchedulerStatusFromExit({ exitCode: 0, stdout, phase: "iteration", runnerKind: "claude" })).toBe("changes_requested")
	})

	test("exit 0 with REVIEW SUMMARY maps per parseReviewSummaryVerdict for every verdict", () => {
		const map: Array<[string, string]> = [
			["accepted", "done"],
			["stop", "done"],
			["skip", "moot"],
			["blocked", "blocked"],
			["retry", "changes_requested"],
		]
		for (const [verdict, expected] of map) {
			const stdout = `intermediate line\nREVIEW SUMMARY: verdict=${verdict}; issue=#1; reason=unit`
			expect(defaultSchedulerStatusFromExit({ exitCode: 0, stdout, phase: "iteration", runnerKind: "claude" })).toBe(expected)
		}
	})

	test("exit 0 with only ITERATION SUMMARY and phase=iteration maps to in_progress", () => {
		const stdout = "exploring\nITERATION SUMMARY: scope=unit; reason=fake"
		expect(defaultSchedulerStatusFromExit({ exitCode: 0, stdout, phase: "iteration", runnerKind: "claude" })).toBe("in_progress")
	})

	test("exit 0 with only ITERATION SUMMARY and phase!=iteration falls through to changes_requested", () => {
		const stdout = "exploring\nITERATION SUMMARY: scope=unit; reason=fake"
		expect(defaultSchedulerStatusFromExit({ exitCode: 0, stdout, phase: "review", runnerKind: "claude" })).toBe("changes_requested")
	})

	test("REVIEW SUMMARY wins over an earlier ITERATION SUMMARY", () => {
		const stdout = [
			"ITERATION SUMMARY: scope=phase-1",
			"middle log noise",
			"REVIEW SUMMARY: verdict=skip; issue=#2; reason=both markers present",
		].join("\n")
		expect(defaultSchedulerStatusFromExit({ exitCode: 0, stdout, phase: "iteration", runnerKind: "claude" })).toBe("moot")
	})
})

describe("scheduler default statusFromExit (end-to-end via fixture)", () => {
	test("exit 0 with no SUMMARY marker leaves item continuable (changes_requested) after one tick", async () => {
		const fixture = await createFixture("status-no-marker")
		try {
			const chain = createChain(fixture.store, "status-no-marker-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 5001, repoCwd: "/repo/a", summary: null })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("changes_requested")
			expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			fixture.store.close()
		}
	})

	test("exit 0 with REVIEW SUMMARY verdict=skip maps item to moot", async () => {
		const fixture = await createFixture("status-review-skip")
		try {
			const chain = createChain(fixture.store, "status-review-skip-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 5002,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=skip; issue=#5002; reason=unit",
			})

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("moot")
			expect(fixture.store.getItem(item.id)?.status).toBe("moot")
		} finally {
			fixture.store.close()
		}
	})

	test("exit 0 with only ITERATION SUMMARY in iteration phase keeps item in_progress (not terminal done)", async () => {
		const fixture = await createFixture("status-iter-summary")
		try {
			const chain = createChain(fixture.store, "status-iter-summary-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 5003,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=mid-phase",
			})

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("in_progress")
			expect(fixture.store.getItem(item.id)?.status).toBe("in_progress")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			fixture.store.close()
		}
	})

	test("daemon-bound default re-spawns the same item across ticks when each spawn exits 0 without SUMMARY marker", async () => {
		const fixture = await createFixture("status-respawn")
		try {
			const chain = createChain(fixture.store, "status-respawn-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 5004, repoCwd: "/repo/a", summary: null })

			let runCounter = 0
			const baseOptions = fixture.options()
			const options: SchedulerOptions = {
				...baseOptions,
				runIdFactory: () => `run-respawn-${++runCounter}`,
			}

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			await firstTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")

			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			await secondTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.attempts).toBe(2)
			expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler per-item phase advancement (issue #289)", () => {
	test("AC3: queued item → first tick spawns iter phase and writes phase=iteration / status=in_progress", async () => {
		const fixture = await createFixture("phase-ac3-queued-to-iter")
		try {
			const chain = createChain(fixture.store, "phase-ac3-queued-to-iter-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 28903,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=ac3",
			})

			const tick = await schedulerTick(fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}`,
			}))
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed
			expect(closed.exitCode).toBe(0)

			const updated = fixture.store.getItem(item.id)
			expect(updated?.phase).toBe("iteration")
			expect(updated?.status).toBe("in_progress")
			expect(updated?.attempts).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn")).toHaveLength(1)
			expect(fixture.schedulerEvents.find((event) => event.type === "agent.spawn" && event.itemId === item.id)).toBeDefined()
			expect(fixture.schedulerEvents.find((event) => event.type === "phase.start" && event.itemId === item.id && event.phase === "iteration")).toBeDefined()
		} finally {
			fixture.store.close()
		}
	})

	test("AC4: in_progress + phase=iteration → next tick spawns review (does not re-spawn iter) and writes phase=review", async () => {
		const fixture = await createFixture("phase-ac4-iter-to-review")
		try {
			const chain = createChain(fixture.store, "phase-ac4-iter-to-review-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 28904,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=ac4",
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}`,
			})

			const iterTick = await schedulerTick(baseOptions)
			expect(iterTick.spawnedRuns).toHaveLength(1)
			expect(iterTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-iteration`)
			const iterClosed = await iterTick.spawnedRuns[0]!.closed
			expect(iterClosed.status).toBe("in_progress")
			expect(fixture.store.getItem(item.id)?.phase).toBe("iteration")

			const reviewTick = await schedulerTick(baseOptions)
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			expect(reviewTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review`)

			const updatedAfterReviewSpawn = fixture.store.getItem(item.id)
			expect(updatedAfterReviewSpawn?.phase).toBe("review")
			expect(updatedAfterReviewSpawn?.status).toBe("in_progress")
			expect(updatedAfterReviewSpawn?.attempts).toBe(2)
			await reviewTick.spawnedRuns[0]!.closed

			const spawnEvents = fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)
			expect(spawnEvents).toHaveLength(2)
			const phases = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start" && event.itemId === item.id)
				.map((event) => event.phase)
			expect(phases).toEqual(["iteration", "review"])
		} finally {
			fixture.store.close()
		}
	})

	test("AC5: daemon restart (no current run) at phase boundary — next tick spawns review only, does NOT re-spawn iter", async () => {
		const fixture = await createFixture("phase-ac5-restart-resume")
		try {
			const chain = createChain(fixture.store, "phase-ac5-restart-resume-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 28905,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=ac5",
			})

			fixture.store.updateItem(item.id, {
				status: "in_progress",
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-pre-crash-iter",
				updatedAt: 1_800_001_000,
			})
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-resume`,
			})

			const tick = await schedulerTick(baseOptions)
			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review-resume`)

			const updated = fixture.store.getItem(item.id)
			expect(updated?.phase).toBe("review")
			expect(updated?.status).toBe("in_progress")
			expect(updated?.attempts).toBe(2)
			await tick.spawnedRuns[0]!.closed

			const spawnEvents = fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)
			expect(spawnEvents).toHaveLength(1)
			const startedPhases = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start" && event.itemId === item.id)
				.map((event) => event.phase)
			expect(startedPhases).toEqual(["review"])
		} finally {
			fixture.store.close()
		}
	})

	test("changes_requested + phase=review → next tick retries review, not iteration", async () => {
		const fixture = await createFixture("phase-review-retry")
		try {
			const chain = createChain(fixture.store, "phase-review-retry-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 31401,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=retry; issue=#31401; reason=review-retry",
			})
			fixture.store.updateItem(item.id, {
				status: "changes_requested",
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-review-retry",
				updatedAt: 1_800_002_500,
			})

			const tick = await schedulerTick(fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-retry`,
			}))

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review-retry`)
			const spawned = fixture.store.getItem(item.id)
			expect(spawned?.phase).toBe("review")
			expect(spawned?.status).toBe("in_progress")
			expect(spawned?.attempts).toBe(3)

			await tick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["review"])
		} finally {
			fixture.store.close()
		}
	})

	test("changes_requested + phase=iteration → next tick still retries iteration", async () => {
		const fixture = await createFixture("phase-iter-retry")
		try {
			const chain = createChain(fixture.store, "phase-iter-retry-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 31402,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=iter-retry",
			})
			fixture.store.updateItem(item.id, {
				status: "changes_requested",
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-pre-iter-retry",
				updatedAt: 1_800_002_600,
			})

			const tick = await schedulerTick(fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-retry`,
			}))

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-iteration-retry`)
			const spawned = fixture.store.getItem(item.id)
			expect(spawned?.phase).toBe("iteration")
			expect(spawned?.status).toBe("in_progress")
			expect(spawned?.attempts).toBe(2)

			await tick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration"])
		} finally {
			fixture.store.close()
		}
	})

	test("AC6: in_progress + phase=review + REVIEW SUMMARY verdict=accepted → item terminal=done, next tick does NOT spawn", async () => {
		const fixture = await createFixture("phase-ac6-review-terminal")
		try {
			const chain = createChain(fixture.store, "phase-ac6-review-terminal-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, {
				issueNumber: 28906,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=accepted; issue=#28906; reason=ac6",
			})
			fixture.store.updateItem(item.id, {
				status: "in_progress",
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-pre-review-iter",
				updatedAt: 1_800_002_000,
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-ac6`,
			})

			const reviewTick = await schedulerTick(baseOptions)
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			expect(reviewTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review-ac6`)
			const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
			expect(reviewClosed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.phase).toBe("review")

			const followUpTick = await schedulerTick(baseOptions)
			expect(followUpTick.spawnedRuns).toHaveLength(0)
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler item-level trigger phase advancement (issue #290)", () => {
	test("AC2: blocked + phase=review → next tick spawns blocked-responder trigger phase", async () => {
		const fixture = await createFixture("trigger-b3-blocked-spawn")
		try {
			const chain = createChain(fixture.store, "trigger-b3-blocked-spawn-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, {
				issueNumber: 29002,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=accepted; issue=#29002; reason=trigger-default",
			})
			fixture.store.updateItem(item.id, {
				status: "blocked",
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-blocked-review",
				updatedAt: 1_800_003_000,
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-b3`,
			})

			const triggerTick = await schedulerTick(baseOptions)
			expect(triggerTick.spawnedRuns).toHaveLength(1)
			expect(triggerTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-blocked-responder-b3`)

			const duringSpawn = fixture.store.getItem(item.id)
			expect(duringSpawn?.phase).toBe("blocked-responder")
			expect(duringSpawn?.status).toBe("in_progress")
			expect(duringSpawn?.attempts).toBe(3)

			await triggerTick.spawnedRuns[0]!.closed

			const spawnEvents = fixture.schedulerEvents.filter(
				(event) => event.type === "agent.spawn" && event.itemId === item.id,
			)
			expect(spawnEvents).toHaveLength(1)
			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["blocked-responder"])
		} finally {
			fixture.store.close()
		}
	})

	test("AC3: trigger phase exit with REVIEW SUMMARY verdict=retry → status=changes_requested; next tick spawns iter", async () => {
		const fixture = await createFixture("trigger-b3-unblock")
		try {
			const chain = createChain(fixture.store, "trigger-b3-unblock-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 29003,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=retry; issue=#29003; reason=unblock",
			})
			fixture.store.updateItem(item.id, {
				status: "blocked",
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-blocked-review",
				updatedAt: 1_800_004_000,
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-b3`,
			})

			const triggerTick = await schedulerTick(baseOptions)
			expect(triggerTick.spawnedRuns).toHaveLength(1)
			expect(triggerTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-blocked-responder-b3`)
			const triggerClosed = await triggerTick.spawnedRuns[0]!.closed
			expect(triggerClosed.status).toBe("changes_requested")

			const afterTrigger = fixture.store.getItem(item.id)
			expect(afterTrigger?.status).toBe("changes_requested")
			expect(afterTrigger?.phase).toBe("blocked-responder")

			// Configure the iter re-spawn so its REVIEW SUMMARY doesn't propagate "retry" again.
			fixture.store.updateItem(item.id, {
				extra: {
					...afterTrigger!.extra,
					summary: "ITERATION SUMMARY: scope=unit; reason=b3-resume",
				},
			})

			const followUpTick = await schedulerTick(baseOptions)
			expect(followUpTick.spawnedRuns).toHaveLength(1)
			expect(followUpTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-iteration-b3`)
			const followUpClosed = await followUpTick.spawnedRuns[0]!.closed
			expect(followUpClosed.status).toBe("in_progress")

			const afterIter = fixture.store.getItem(item.id)
			expect(afterIter?.phase).toBe("iteration")

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["blocked-responder", "iteration"])
		} finally {
			fixture.store.close()
		}
	})

	test("AC4: blocked + phase=iteration (no matching trigger phase) → no spawn, chain proceeds to completion", async () => {
		const fixture = await createFixture("trigger-b3-no-match")
		try {
			const chain = createChain(fixture.store, "trigger-b3-no-match-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 29004, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: "blocked",
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-pre-blocked-iter",
				updatedAt: 1_800_005_000,
			})

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(0)

			const after = fixture.store.getItem(item.id)
			expect(after?.status).toBe("blocked")
			expect(after?.phase).toBe("iteration")
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			fixture.store.close()
		}
	})

	test("race: review exit with verdict=blocked keeps chain active until item-level trigger spawns", async () => {
		const fixture = await createFixture("trigger-b3-race")
		try {
			const chain = createChain(fixture.store, "trigger-b3-race-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, {
				issueNumber: 29005,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=blocked; issue=#29005; reason=race-review",
			})
			fixture.store.updateItem(item.id, {
				status: "in_progress",
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-pre-race-iter",
				updatedAt: 1_800_006_000,
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-race`,
			})

			const reviewTick = await schedulerTick(baseOptions)
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			expect(reviewTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review-race`)
			const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
			expect(reviewClosed.status).toBe("blocked")

			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getItem(item.id)?.phase).toBe("review")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(fixture.schedulerEvents.some((event) => event.type === "chain.completed")).toBe(false)
			expect(reviewTick.completedChainIds).toEqual([])

			fixture.store.updateItem(item.id, {
				extra: {
					...fixture.store.getItem(item.id)!.extra,
					summary: "REVIEW SUMMARY: verdict=blocked; issue=#29005; reason=stay-blocked",
				},
			})
			const triggerTick = await schedulerTick(baseOptions)
			expect(triggerTick.spawnedRuns).toHaveLength(1)
			expect(triggerTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-blocked-responder-race`)
			await triggerTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItem(item.id)?.phase).toBe("blocked-responder")
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			fixture.store.close()
		}
	})

	test("integration: real subprocess spawn for blocked-responder trigger phase", async () => {
		const fixture = await createFixture("trigger-b3-real-spawn")
		try {
			const chain = createChain(fixture.store, "trigger-b3-real-spawn-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 29006,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=accepted; issue=#29006; reason=real-spawn-trigger",
			})
			fixture.store.updateItem(item.id, {
				status: "blocked",
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-real-spawn-review",
				updatedAt: 1_800_007_000,
			})

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed
			expect(closed.exitCode).toBe(0)
			expect(closed.stdout).toContain(`done:${item.id}`)
			expect(closed.stdout).toContain("REVIEW SUMMARY: verdict=accepted")

			const runs = (await readRunnerEvents(fixture.eventLog)).map((event) => event.type)
			expect(runs).toEqual(["start", "end"])

			const spawnEvents = fixture.schedulerEvents.filter(
				(event): event is Extract<SchedulerEvent, { type: "agent.spawn" }> =>
					event.type === "agent.spawn" && event.itemId === item.id,
			)
			expect(spawnEvents).toHaveLength(1)
			expect(spawnEvents[0]?.pid).not.toBeNull()

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["blocked-responder"])
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler kind-label gate", () => {
	test("missing kind:* label aborts spawn, marks item blocked, leaves no current run", async () => {
		const fixture = await createFixture("kind-gate-missing")
		try {
			const chain = createChain(fixture.store, "kind-gate-missing-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 9001, repoCwd: "/repo/a", issueKind: null })

			const warn = captureConsoleWarn()
			let tick
			try {
				tick = await schedulerTick(fixture.options({
					kindResolver: () => ({ ok: true, kind: null }),
				}))
			} finally {
				warn.restore()
			}

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.worktreeCalls).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(listActiveRuns(fixture.state)).toHaveLength(0)
			const aborted = fixture.schedulerEvents.find((event) => event.type === "spawn.aborted")
			expect(aborted).toMatchObject({
				type: "spawn.aborted",
				chainId: chain.id,
				itemId: item.id,
				issueNumber: 9001,
				toStatus: "blocked",
			})
			expect(warn.messages.some((line) => /kind label check failed/.test(line))).toBe(true)
			expect(warn.messages.some((line) => /expected exactly one kind:\* label, found 0/.test(line))).toBe(true)
		} finally {
			fixture.store.close()
		}
	})

	test("multiple kind:* labels abort spawn with 'expected exactly one kind' error", async () => {
		const fixture = await createFixture("kind-gate-multi")
		try {
			const chain = createChain(fixture.store, "kind-gate-multi-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 9002, repoCwd: "/repo/a" })

			const warn = captureConsoleWarn()
			let tick
			try {
				tick = await schedulerTick(fixture.options({
					kindResolver: () => ({ ok: false, error: "expected exactly one kind:* label, found 2: kind:code, kind:comment" }),
				}))
			} finally {
				warn.restore()
			}

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			const aborted = fixture.schedulerEvents.find((event) => event.type === "spawn.aborted")
			expect(aborted).toMatchObject({
				type: "spawn.aborted",
				chainId: chain.id,
				itemId: item.id,
				issueNumber: 9002,
			})
			expect(aborted?.type === "spawn.aborted" ? aborted.reason : null).toMatch(/expected exactly one kind/)
			expect(warn.messages.some((line) => /expected exactly one kind/.test(line))).toBe(true)
		} finally {
			fixture.store.close()
		}
	})

	test("unknown kind:* value aborts spawn with 'unknown kind label' error", async () => {
		const fixture = await createFixture("kind-gate-unknown")
		try {
			const chain = createChain(fixture.store, "kind-gate-unknown-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 9003, repoCwd: "/repo/a" })

			const warn = captureConsoleWarn()
			let tick
			try {
				tick = await schedulerTick(fixture.options({
					kindResolver: () => ({ ok: false, error: 'unknown kind label "kind:foo" (allowed: kind:code, kind:comment, kind:code-spike, kind:blocked)' }),
				}))
			} finally {
				warn.restore()
			}

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			const aborted = fixture.schedulerEvents.find((event) => event.type === "spawn.aborted")
			expect(aborted?.type === "spawn.aborted" ? aborted.reason : null).toMatch(/unknown kind label/)
			expect(warn.messages.some((line) => /unknown kind label/.test(line))).toBe(true)
		} finally {
			fixture.store.close()
		}
	})

	test("kind:code label from item.extra passes gate, default resolver does not call gh", async () => {
		const fixture = await createFixture("kind-gate-extra-pass")
		try {
			const chain = createChain(fixture.store, "kind-gate-extra-pass-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 9004, repoCwd: "/repo/a", issueKind: "code-spike" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.schedulerEvents.some((event) => event.type === "spawn.aborted")).toBe(false)
		} finally {
			fixture.store.close()
		}
	})

	test("blocked item is treated as terminal — chain completes when only aborted item remains", async () => {
		const fixture = await createFixture("kind-gate-chain-completes")
		try {
			const chain = createChain(fixture.store, "kind-gate-chain-completes-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 9005, repoCwd: "/repo/a", issueKind: null })

			const warn = captureConsoleWarn()
			let tick
			try {
				tick = await schedulerTick(fixture.options({
					kindResolver: () => ({ ok: true, kind: null }),
				}))
			} finally {
				warn.restore()
			}

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler per-chain review-on-empty (issue #292)", () => {
	test("chain drained + lock missing → next tick spawns review-on-empty once with phase=review", async () => {
		const fixture = await createFixture("review-on-empty-spawn")
		try {
			const chain = createChain(fixture.store, "review-on-empty-spawn-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 14001, repoCwd: "/repo/a" })

			const firstTick = await schedulerTick(fixture.options())
			expect(firstTick.spawnedRuns).toHaveLength(1)
			const iterClosed = await firstTick.spawnedRuns[0]!.closed
			expect(iterClosed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")

			const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot: fixture.loopDataRoot })
			expect(existsSync(lockPath)).toBe(false)

			const reviewTick = await schedulerTick(fixture.options())
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			expect(reviewTick.completedChainIds).toEqual([])

			const reviewRun = reviewTick.spawnedRuns[0]!
			expect(reviewRun.itemId).toBe(0)
			const phaseStartReview = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start")
				.find((event) => event.runId === reviewRun.runId)
			expect(phaseStartReview?.phase).toBe("review")
			expect(phaseStartReview?.itemId).toBe(0)

			await reviewRun.closed
		} finally {
			fixture.store.close()
		}
	})

	test("review-on-empty close writes lock file with runId + ISO acquiredAt", async () => {
		const fixture = await createFixture("review-on-empty-lock-write")
		try {
			const chain = createChain(fixture.store, "review-on-empty-lock-write-chain")
			createItem(fixture.store, chain, { issueNumber: 14002, repoCwd: "/repo/a" })

			const iterTick = await schedulerTick(fixture.options())
			await iterTick.spawnedRuns[0]!.closed

			const reviewTick = await schedulerTick(fixture.options())
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			const reviewRun = reviewTick.spawnedRuns[0]!
			await reviewRun.closed

			const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot: fixture.loopDataRoot })
			expect(existsSync(lockPath)).toBe(true)
			const lockPayload = JSON.parse(await readFile(lockPath, "utf-8")) as Record<string, unknown>
			expect(lockPayload.runId).toBe(reviewRun.runId)
			expect(typeof lockPayload.acquiredAt).toBe("string")
			expect(Number.isFinite(Date.parse(String(lockPayload.acquiredAt)))).toBe(true)
			expect(lockPayload.reason).toBe("chain-queue-drained")
		} finally {
			fixture.store.close()
		}
	})

	test("lock present + chain drained → next tick does NOT re-spawn review-on-empty", async () => {
		const fixture = await createFixture("review-on-empty-lock-respected")
		try {
			const chain = createChain(fixture.store, "review-on-empty-lock-respected-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot, "lock-pre-existing")
			const item = createItem(fixture.store, chain, { issueNumber: 14003, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: "done", updatedAt: 1_800_006_000 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")

			const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot: fixture.loopDataRoot })
			const lockPayload = JSON.parse(await readFile(lockPath, "utf-8")) as Record<string, unknown>
			expect(lockPayload.runId).toBe("lock-pre-existing")
		} finally {
			fixture.store.close()
		}
	})

	test("lock present + new queued item appears → next tick spawns iter for the queued item, not review-on-empty", async () => {
		const fixture = await createFixture("review-on-empty-lock-with-new-item")
		try {
			const chain = createChain(fixture.store, "review-on-empty-lock-with-new-item-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot, "lock-from-prior-drain")
			const done = createItem(fixture.store, chain, { issueNumber: 14004, repoCwd: "/repo/a" })
			fixture.store.updateItem(done.id, { status: "done", updatedAt: 1_800_007_000 })
			const fresh = createItem(fixture.store, chain, { issueNumber: 14005, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const spawnedRun = tick.spawnedRuns[0]!
			expect(spawnedRun.itemId).toBe(fresh.id)
			const phaseStart = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start")
				.find((event) => event.runId === spawnedRun.runId)
			expect(phaseStart?.phase).toBe("iteration")
			await spawnedRun.closed
		} finally {
			fixture.store.close()
		}
	})

	test("empty chain (no items) does not spawn review-on-empty", async () => {
		const fixture = await createFixture("review-on-empty-no-items")
		try {
			const chain = createChain(fixture.store, "review-on-empty-no-items-chain")

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([])
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot: fixture.loopDataRoot })
			expect(existsSync(lockPath)).toBe(false)
		} finally {
			fixture.store.close()
		}
	})
})

describe("resolveSchedulerPresetPhasePrompt", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("returns iteration entry markdown including '## Required procedure'", async () => {
		const prompt = await resolveSchedulerPresetPhasePrompt({ presetDir: PRESET_DIR, phase: "iteration" })
		expect(prompt).toContain("## Required procedure")
	})

	test("returns review entry markdown including '## Required procedure'", async () => {
		const prompt = await resolveSchedulerPresetPhasePrompt({ presetDir: PRESET_DIR, phase: "review" })
		expect(prompt).toContain("## Required procedure")
	})

	test("resolver output is byte-equal to readFile on the same phase.prompt path that the main loop reads", async () => {
		const preset = await loadPreset(PRESET_DIR)
		for (const phaseName of ["iteration", "review"] as const) {
			const phase = preset.phases.find((entry) => entry.name === phaseName)
			expect(phase).not.toBeUndefined()
			const mainLoopRaw = await readFile(phase!.prompt, "utf-8")
			const daemonRaw = await resolveSchedulerPresetPhasePrompt({ presetDir: PRESET_DIR, phase: phaseName })
			expect(daemonRaw).toBe(mainLoopRaw)
			expect(Buffer.byteLength(daemonRaw, "utf-8")).toBe(Buffer.byteLength(mainLoopRaw, "utf-8"))
		}
	})

	test("rejects unknown phase with an explicit error sentinel string", async () => {
		await expect(resolveSchedulerPresetPhasePrompt({ presetDir: PRESET_DIR, phase: "no-such-phase" })).rejects.toThrow(/phase_not_found_in_preset/)
	})

	test("scheduler spawn renders resolver output before subprocess (entry md prose preserved, {{KEY}} placeholders replaced)", async () => {
		const fixture = await createPresetPromptIntegrationFixture("integration-resolver")
		try {
			const chain = createChain(fixture.store, "integration-resolver-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 283, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.stdout).toContain("## Required procedure")
			expect(closed.stdout).toContain("## Non-negotiable iteration boundaries")

			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("## Required procedure")

			const preset = await loadPreset(PRESET_DIR)
			const iterPhase = preset.phases.find((entry) => entry.name === "iteration")!
			const mainLoopRaw = await readFile(iterPhase.prompt, "utf-8")
			const declaredKeys = new Set(iterPhase.variables.map(([key]) => key))
			const rawTokens = new Set(mainLoopRaw.match(/\{\{[A-Z_]+\}\}/g) ?? [])
			expect(rawTokens.size).toBeGreaterThan(0)
			for (const token of rawTokens) {
				const key = token.slice(2, -2)
				expect(declaredKeys.has(key)).toBe(true)
				expect(capturedStdout).not.toContain(token)
			}
			expect(capturedStdout).toContain("`mouriya-s-lab/coder-loop`")
			expect(capturedStdout).toContain("`/repo/a`")
			expect(capturedStdout).toContain("Current issue: `#283`")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler chain bindings (issue #288)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("preset.toml declares CHAIN_NAME / CHAIN_UMBRELLA_REPO / CHAIN_UMBRELLA_ISSUE / CHAIN_BASE_BRANCH / REPO_CWD in every actionable phase (AC4)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const expected = new Set([
			["CHAIN_NAME", "runtime", "chainName"],
			["CHAIN_UMBRELLA_REPO", "runtime", "chainUmbrellaRepo"],
			["CHAIN_UMBRELLA_ISSUE", "runtime", "chainUmbrellaIssue"],
			["CHAIN_BASE_BRANCH", "runtime", "chainBaseBranch"],
			["REPO_CWD", "runtime", "repoCwd"],
		].map((entry) => entry.join(" ")))
		for (const phase of preset.phases) {
			const bindings = new Set(
				phase.variables
					.filter(([, source]) => source.kind === "runtime")
					.map(([key, source]) => [key, source.kind, source.kind === "runtime" ? source.key : ""].join(" ")),
			)
			for (const entry of expected) {
				expect(bindings.has(entry)).toBe(true)
			}
		}
	})

	test("renderSchedulerSpawnPrompt against a template that references every declared iteration binding leaves zero residual {{[A-Z_]+}} tokens (AC2)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const iterPhase = preset.phases.find((entry) => entry.name === "iteration")!
		const declaredKeys = iterPhase.variables.map(([key]) => key)
		const template = declaredKeys.map((key) => `${key}={{${key}}}`).join("\n")
		const chain = makeChainFixture({ name: "render-zero-token-chain" })
		const item = makeItemFixture(chain, { issueNumber: 999_001, repoCwd: "/tmp/no-token-repo" })
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: template,
			presetDir: PRESET_DIR,
			phase: "iteration",
			chain,
			item,
			runId: "run-zero-token",
			worktreePath: "/tmp/render-zero-token-worktree",
			issueKind: "code",
		})
		const residual = rendered.match(/\{\{[A-Z_]+\}\}/g) ?? []
		expect(residual).toEqual([])
	})

	test("renderSchedulerSpawnPrompt with chain.name=my-chain umbrellaRepo=owner/repo umbrellaIssue=42 substitutes those literals (AC3)", async () => {
		const chain = makeChainFixture({
			name: "my-chain",
			umbrellaRepo: "owner/repo",
			umbrellaIssue: 42,
			baseBranch: "trunk",
			repository: "owner/repo",
		})
		const item = makeItemFixture(chain, { issueNumber: 999_002, repoCwd: "/tmp/chain-binding-repo" })
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: [
				"chain.name={{CHAIN_NAME}}",
				"umbrella.repo={{CHAIN_UMBRELLA_REPO}}",
				"umbrella.issue={{CHAIN_UMBRELLA_ISSUE}}",
				"chain.baseBranch={{CHAIN_BASE_BRANCH}}",
				"item.repoCwd={{REPO_CWD}}",
			].join("\n"),
			presetDir: PRESET_DIR,
			phase: "iteration",
			chain,
			item,
			runId: "run-chain-binding",
			worktreePath: "/tmp/chain-binding-worktree",
			issueKind: "code",
		})
		expect(rendered).toContain("chain.name=my-chain")
		expect(rendered).toContain("umbrella.repo=owner/repo")
		expect(rendered).toContain("umbrella.issue=42")
		expect(rendered).toContain("chain.baseBranch=trunk")
		expect(rendered).toContain("item.repoCwd=/tmp/chain-binding-repo")
	})

	test("renderSchedulerSpawnPrompt leaves chain.umbrellaRepo and chain.umbrellaIssue empty when chain has null umbrella (no crash, empty literals)", async () => {
		const chain = makeChainFixture({
			name: "no-umbrella-chain",
			umbrellaRepo: null,
			umbrellaIssue: null,
		})
		const item = makeItemFixture(chain, { issueNumber: 999_003, repoCwd: "/tmp/no-umbrella-repo" })
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "umb_repo=[{{CHAIN_UMBRELLA_REPO}}] umb_issue=[{{CHAIN_UMBRELLA_ISSUE}}]",
			presetDir: PRESET_DIR,
			phase: "iteration",
			chain,
			item,
			runId: "run-no-umbrella",
			worktreePath: "/tmp/no-umbrella-worktree",
			issueKind: "code",
		})
		expect(rendered).toBe("umb_repo=[] umb_issue=[]")
	})

	test("scheduler spawn end-to-end: chain literals reach agent stdout via echo runner (AC5 fixture-style integration)", async () => {
		const fixture = await createPresetPromptIntegrationFixture("chain-binding-integration")
		try {
			const chain = createChain(fixture.store, "chain-binding-integration-chain", {
				umbrellaRepo: "owner/umb-repo",
				umbrellaIssue: 777,
				baseBranch: "trunk",
			})
			const item = createItem(fixture.store, chain, { issueNumber: 288_001, repoCwd: "/tmp/chain-int-repo" })

			const customPrompt = [
				"=== chain bindings probe ===",
				"chain.name={{CHAIN_NAME}}",
				"chain.umbrellaRepo={{CHAIN_UMBRELLA_REPO}}",
				"chain.umbrellaIssue={{CHAIN_UMBRELLA_ISSUE}}",
				"chain.baseBranch={{CHAIN_BASE_BRANCH}}",
				"item.repoCwd={{REPO_CWD}}",
			].join("\n")
			const tick = await schedulerTick(fixture.options({ prompt: () => customPrompt }))
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("chain.name=chain-binding-integration-chain")
			expect(capturedStdout).toContain("chain.umbrellaRepo=owner/umb-repo")
			expect(capturedStdout).toContain("chain.umbrellaIssue=777")
			expect(capturedStdout).toContain("chain.baseBranch=trunk")
			expect(capturedStdout).toContain("item.repoCwd=/tmp/chain-int-repo")
			expect(capturedStdout.match(/\{\{[A-Z_]+\}\}/g) ?? []).toEqual([])
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler per-phase runner selection (issue #287)", () => {
	test("spawnSchedulerRun routes phase=iteration through phaseRunner and uses returned binary for spawn (AC2 iter)", async () => {
		const fixture = await createFixture("phase-runner-iter")
		try {
			const chain = createChain(fixture.store, "phase-runner-iter-chain")
			createItem(fixture.store, chain, { issueNumber: 287_101, repoCwd: "/repo/a" })

			const fakeIter = resolve(fixture.loopDataRoot, "..", "fake-iter-marker.ts")
			await writeBunMarkerRunner(fakeIter, "PER-PHASE:codex")

			const observedPhases: string[] = []
			const phaseRunner: SchedulerPhaseRunner = ({ phase }) => {
				observedPhases.push(phase)
				return {
					kind: "claude",
					source: "config",
					binary: "bun",
					extraArgs: [fakeIter],
					model: null,
				}
			}

			const baseOptions = fixture.options()
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner
			const tick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "iteration",
			})
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(observedPhases).toEqual(["iteration"])
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("PER-PHASE:codex")
			expect(capturedStdout).not.toContain("PER-PHASE:claude")
		} finally {
			fixture.store.close()
		}
	})

	test("spawnSchedulerRun routes phase=review through phaseRunner and uses returned binary for spawn (AC2 review)", async () => {
		const fixture = await createFixture("phase-runner-review")
		try {
			const chain = createChain(fixture.store, "phase-runner-review-chain")
			createItem(fixture.store, chain, { issueNumber: 287_102, repoCwd: "/repo/a" })

			const fakeIter = resolve(fixture.loopDataRoot, "..", "fake-codex-review.ts")
			const fakeReview = resolve(fixture.loopDataRoot, "..", "fake-claude-review.ts")
			await writeBunMarkerRunner(fakeIter, "PER-PHASE:codex")
			await writeBunMarkerRunner(fakeReview, "PER-PHASE:claude")

			const observedPhases: string[] = []
			const phaseRunner: SchedulerPhaseRunner = ({ phase }) => {
				observedPhases.push(phase)
				if (phase === "review") {
					return {
						kind: "claude",
						source: "review-default",
						binary: "bun",
						extraArgs: [fakeReview],
						model: "claude-opus-4-7",
					}
				}
				return {
					kind: "claude",
					source: "config",
					binary: "bun",
					extraArgs: [fakeIter],
					model: null,
				}
			}

			const baseOptions = fixture.options()
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner
			const tick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "review",
			})
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(observedPhases).toEqual(["review"])
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("PER-PHASE:claude")
			expect(capturedStdout).not.toContain("PER-PHASE:codex")
		} finally {
			fixture.store.close()
		}
	})

	test("falls back to options.runner when phaseRunner is not configured (backward compat)", async () => {
		const fixture = await createFixture("phase-runner-fallback")
		try {
			const chain = createChain(fixture.store, "phase-runner-fallback-chain")
			createItem(fixture.store, chain, { issueNumber: 287_103, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(fixture.store.getItem(fixture.store.listItems(chain.id)[0]!.id)?.status).toBe("done")
		} finally {
			fixture.store.close()
		}
	})

	test("throws SchedulerError when neither phaseRunner nor runner is configured", async () => {
		const fixture = await createFixture("phase-runner-missing")
		try {
			const chain = createChain(fixture.store, "phase-runner-missing-chain")
			createItem(fixture.store, chain, { issueNumber: 287_104, repoCwd: "/repo/a" })

			const baseOptions = fixture.options()
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner

			await expect(schedulerTick(baseOptions)).rejects.toThrow(/no runner configured/)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
		} finally {
			fixture.store.close()
		}
	})

	describe("resolvePhaseRunnerFromChain", () => {
		const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

		test("chain default → iteration phase returns codex with binary 'codex'", async () => {
			const chain = makeChainFixture({ metadata: {} })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "iteration",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.binary).toBe("codex")
			expect(runner.source).toBe("iteration-default")
		})

		test("chain default → review phase returns claude with model claude-opus-4-7", async () => {
			const chain = makeChainFixture({ metadata: {} })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("claude")
			expect(runner.binary).toBe("claude")
			expect(runner.model).toBe("claude-opus-4-7")
			expect(runner.source).toBe("review-default")
		})

		test("chain metadata reviewRunner='codex' overrides claude default → review phase runs codex (AC3)", async () => {
			const chain = makeChainFixture({ metadata: { reviewRunner: "codex" } })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.binary).toBe("codex")
			expect(runner.source).toBe("config")
		})

		test("chain metadata claude.model is force-replaced by claude-opus-4-7 for review phase (AC4)", async () => {
			const chain = makeChainFixture({
				metadata: {
					claude: { model: "claude-haiku-4-5" },
				},
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("claude")
			expect(runner.model).toBe("claude-opus-4-7")
			expect(runner.model).not.toBe("claude-haiku-4-5")
		})

		test("item.runner='claude' overrides codex iteration default for non-review phase", async () => {
			const chain = makeChainFixture({ metadata: {} })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "iteration",
				item: { runner: "claude" },
			})
			expect(runner.kind).toBe("claude")
			expect(runner.source).toBe("queue")
		})

		test("chain default → triggered/finalizer phase name (non-review) resolves to iteration default codex", async () => {
			const chain = makeChainFixture({ metadata: {} })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "umbrella-finalizer",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.source).toBe("iteration-default")
		})

		test("chain metadata claude.extraArgs '--model X' is stripped from review args by buildRunnerInvocation (AC4 transitive)", async () => {
			const chain = makeChainFixture({
				metadata: {
					claude: {
						model: "claude-haiku-4-5",
						extraArgs: ["--model", "claude-haiku-4-5", "--verbose"],
					},
				},
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("claude")
			expect(runner.model).toBe("claude-opus-4-7")
			const invocation = buildRunnerInvocation(runner, "p", { kind: "fresh" }, {
				targetCwd: "/repo/a",
				agentCwd: "/repo/a",
				presetDir: PRESET_DIR,
				loopDataRoot: "/lr",
			})
			const modelFlagIndex = invocation.args.indexOf("--model")
			expect(modelFlagIndex).toBeGreaterThanOrEqual(0)
			expect(invocation.args[modelFlagIndex + 1]).toBe("claude-opus-4-7")
			expect(invocation.args.filter((arg) => arg === "claude-haiku-4-5")).toEqual([])
		})
	})

	test("AC5 integration: chain-based phaseRunner picks codex binary for iter spawn and claude binary for review spawn", async () => {
		const fixture = await createFixture("ac5-integration")
		try {
			const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-marker.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-marker.sh")
			await writeShellMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellMarkerScript(fakeClaude, "BINARY:claude")

			const chain = createChain(fixture.store, "ac5-integration-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			createItem(fixture.store, chain, { issueNumber: 287_201, repoCwd: "/repo/a" })

			const preset = await loadPreset(PRESET_DIR)
			const phaseRunner: SchedulerPhaseRunner = ({ chain: c, phase, item }) =>
				resolvePhaseRunnerFromChain({
					chain: c,
					loopDataRoot: fixture.loopDataRoot,
					preset,
					phase,
					item,
				})

			let runSeq = 0
			const baseOptions = fixture.options({
				presetDir: PRESET_DIR,
				runIdFactory: ({ chain: c, item, phase }) => `run-${c.id}-${item.id}-${phase}-${++runSeq}`,
			})
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner

			const iterTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "iteration",
				prompt: "iter-prompt",
				statusFromExit: () => "in_progress",
			})
			expect(iterTick.spawnedRuns).toHaveLength(1)
			const iterClosed = await iterTick.spawnedRuns[0]!.closed
			expect(iterClosed.exitCode).toBe(0)
			const iterPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const iterStdout = await readFile(iterPaths.runStdoutFile(iterClosed.runId), "utf-8")
			expect(iterStdout).toContain("BINARY:codex")
			expect(iterStdout).not.toContain("BINARY:claude")

			fixture.store.updateItem(fixture.store.listItems(chain.id)[0]!.id, { status: "changes_requested" })

			const reviewTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "review",
				prompt: "review-prompt",
				statusFromExit: () => "done",
			})
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
			expect(reviewClosed.exitCode).toBe(0)
			const reviewStdout = await readFile(iterPaths.runStdoutFile(reviewClosed.runId), "utf-8")
			expect(reviewStdout).toContain("BINARY:claude")
			expect(reviewStdout).not.toContain("BINARY:codex")
		} finally {
			fixture.store.close()
		}
	})
})

describe("runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("default chain metadata → triggered phase 'umbrella-finalizer' (non-review) spawns iter-default codex via chain-derived selectRunnerForPhase, not hardcoded runner", async () => {
		const fixture = await createFixture("trigger-iter-default")
		try {
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-finalizer.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-finalizer.sh")
			await writeShellFinalizerMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellFinalizerMarkerScript(fakeClaude, "BINARY:claude")

			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-iter")
			await mkdir(targetCwd, { recursive: true })

			const chain = createChain(fixture.store, "trigger-iter-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			createItem(fixture.store, chain, { issueNumber: 287_801, repoCwd: targetCwd })
			const items = fixture.store.listItems(chain.id)

			const runId = `trigger-${chain.id}-default`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatuses: ["done", "moot", "blocked"],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
			})
			expect(decision).toEqual({ decision: "complete" })

			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(chainPaths.runPhaseStdoutFile(runId, "umbrella-finalizer"), "utf-8")
			expect(stdout).toContain("BINARY:codex")
			expect(stdout).not.toContain("BINARY:claude")
		} finally {
			fixture.store.close()
		}
	})

	test("chain metadata runner='claude' → triggered phase 'umbrella-finalizer' spawns claude (resolver honors chain default-runner override)", async () => {
		const fixture = await createFixture("trigger-claude-override")
		try {
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-finalizer.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-finalizer.sh")
			await writeShellFinalizerMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellFinalizerMarkerScript(fakeClaude, "BINARY:claude")

			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-claude")
			await mkdir(targetCwd, { recursive: true })

			const chain = createChain(fixture.store, "trigger-claude-chain", {
				metadata: {
					runner: "claude",
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			createItem(fixture.store, chain, { issueNumber: 287_802, repoCwd: targetCwd })
			const items = fixture.store.listItems(chain.id)

			const runId = `trigger-${chain.id}-claude`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatuses: ["done", "moot", "blocked"],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
			})
			expect(decision).toEqual({ decision: "complete" })

			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(chainPaths.runPhaseStdoutFile(runId, "umbrella-finalizer"), "utf-8")
			expect(stdout).toContain("BINARY:claude")
			expect(stdout).not.toContain("BINARY:codex")
		} finally {
			fixture.store.close()
		}
	})

	test("phaseRunner override input wins over chain-derived selection for the triggered phase spawn", async () => {
		const fixture = await createFixture("trigger-phaseRunner-override")
		try {
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-finalizer.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-finalizer.sh")
			await writeShellFinalizerMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellFinalizerMarkerScript(fakeClaude, "BINARY:claude")

			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-override")
			await mkdir(targetCwd, { recursive: true })

			const chain = createChain(fixture.store, "trigger-override-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			createItem(fixture.store, chain, { issueNumber: 287_803, repoCwd: targetCwd })
			const items = fixture.store.listItems(chain.id)

			const seenPhases: string[] = []
			const overrideRunner: AgentRunnerSelection = {
				kind: "claude",
				source: "iteration-default",
				binary: fakeClaude,
				extraArgs: [],
				model: null,
			}

			const runId = `trigger-${chain.id}-override`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatuses: ["done", "moot", "blocked"],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
				phaseRunner: (phase) => {
					seenPhases.push(phase)
					return overrideRunner
				},
			})
			expect(decision).toEqual({ decision: "complete" })
			expect(seenPhases).toEqual(["umbrella-finalizer"])

			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(chainPaths.runPhaseStdoutFile(runId, "umbrella-finalizer"), "utf-8")
			expect(stdout).toContain("BINARY:claude")
			expect(stdout).not.toContain("BINARY:codex")
		} finally {
			fixture.store.close()
		}
	})
})

describe("scheduler session-id resume (issue #291 / #311)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("first spawn (no session id for phase/runner): buildRunnerInvocation argv has no --resume; rendered prompt's RESUMED_SESSION_ID is empty (AC6)", async () => {
		const chain = makeChainFixture({ name: "first-spawn-chain" })
		const item = makeItemFixture(chain, { issueNumber: 291_001, repoCwd: "/repo/first-spawn-repo" })

		const decision = resumeDecisionForItem(item, "iteration", "claude")
		expect(decision).toEqual({ kind: "fresh" })

		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "iteration-default", binary: "claude", extraArgs: [], model: null },
			"prompt",
			decision,
			{ targetCwd: REPO_ROOT, agentCwd: REPO_ROOT, presetDir: PRESET_DIR, loopDataRoot: resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only") },
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			expect(invocation.args).not.toContain("--resume")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			presetDir: PRESET_DIR,
			phase: "iteration",
			chain,
			item,
			runId: "run-fresh",
			worktreePath: "/repo/fresh-worktree",
			issueKind: "code",
		})
		expect(rendered).toBe("RESUMED_SESSION_ID=[] RESUMED_FROM_PHASE=[] RUN_ID_GENERATION=[new]")
	})

	test("resume spawn (phase/runner session id set): buildRunnerInvocation argv contains --resume <id>; rendered prompt embeds the session id literal (AC4 / AC5)", async () => {
		const chain = makeChainFixture({ name: "resume-chain" })
		const item = makeItemFixture(chain, {
			issueNumber: 291_002,
			repoCwd: "/repo/resume-repo",
			sessionIds: { iteration: { claude: "sess-deadbeef-cafe" } },
			phase: "iteration",
		})

		const decision = resumeDecisionForItem(item, "iteration", "claude")
		expect(decision).toEqual({ kind: "resume", sessionId: "sess-deadbeef-cafe" })

		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "iteration-default", binary: "claude", extraArgs: [], model: null },
			"prompt",
			decision,
			{ targetCwd: REPO_ROOT, agentCwd: REPO_ROOT, presetDir: PRESET_DIR, loopDataRoot: resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only") },
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			const idx = invocation.args.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(invocation.args[idx + 1]).toBe("sess-deadbeef-cafe")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			presetDir: PRESET_DIR,
			phase: "iteration",
			chain,
			item,
			runId: "run-resume",
			worktreePath: "/repo/resume-worktree",
			issueKind: "code",
			resume: decision,
		})
		expect(rendered).toBe("RESUMED_SESSION_ID=[sess-deadbeef-cafe] RESUMED_FROM_PHASE=[iteration] RUN_ID_GENERATION=[resumed]")
	})

	test("codex resume spawn (phase/runner session id set): buildRunnerInvocation argv shape includes `resume <sessionId>` subcommand", async () => {
		const item = makeItemFixture(makeChainFixture(), {
			issueNumber: 291_003,
			repoCwd: "/repo/codex-resume-repo",
			sessionIds: { iteration: { codex: "thread-codex-1" } },
		})
		const decision = resumeDecisionForItem(item, "iteration", "codex")
		const invocation = buildRunnerInvocation(
			{ kind: "codex", source: "iteration-default", binary: "codex", extraArgs: [], model: null },
			"prompt",
			decision,
			{ targetCwd: REPO_ROOT, agentCwd: REPO_ROOT, presetDir: PRESET_DIR, loopDataRoot: resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only") },
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			const resumeIdx = invocation.args.indexOf("resume")
			expect(resumeIdx).toBeGreaterThanOrEqual(0)
			expect(invocation.args[resumeIdx + 1]).toBe("thread-codex-1")
		}
	})

	test("resumeDecisionForItem selects only the current phase/runner session id (issue #311 AC3 / AC4)", () => {
		const item = makeItemFixture(makeChainFixture(), {
			issueNumber: 311_003,
			repoCwd: "/repo/phase-runner-resume",
			sessionIds: {
				iteration: { codex: "thread-iteration-codex" },
				review: { claude: "sess-review-claude" },
			},
		})

		expect(resumeDecisionForItem(item, "iteration", "codex")).toEqual({ kind: "resume", sessionId: "thread-iteration-codex" })
		expect(resumeDecisionForItem(item, "review", "claude")).toEqual({ kind: "resume", sessionId: "sess-review-claude" })
		expect(resumeDecisionForItem(item, "iteration", "claude")).toEqual({ kind: "fresh" })
		expect(resumeDecisionForItem(item, "review", "codex")).toEqual({ kind: "fresh" })
	})

	test("end-to-end (claude runner): session-id parsed from stdout first line is persisted to the phase/runner slot (AC3)", async () => {
		const fixture = await createFixture("session-id-capture-claude")
		try {
			const chain = createChain(fixture.store, "session-id-capture-claude-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_010, repoCwd: "/repo/session-id" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-session.ts")
			await writeFakeClaudeSessionRunner(fakeRunner, "sess-captured-001")

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			})
			await runSchedulerUntilIdle(options)

			const refreshed = fixture.store.getItem(item.id)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-captured-001")
		} finally {
			fixture.store.close()
		}
	})

	test("end-to-end composition: seeded phase/runner session id reaches subprocess argv as --resume <id> (AC7 wire-level proxy)", async () => {
		const fixture = await createFixture("session-id-roundtrip-claude")
		try {
			const chain = createChain(fixture.store, "session-id-roundtrip-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_020, repoCwd: "/repo/session-roundtrip" })
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-seeded-200" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-argv-echo.ts")
			await writeFakeClaudeArgvEchoRunner(fakeRunner)

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			})
			await runSchedulerUntilIdle(options)

			const runId = `run-${chain.id}-${item.id}`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const argvLine = stdout.split("\n").find((line) => line.startsWith("{") && line.includes("\"argv\""))
			expect(argvLine).toBeDefined()
			const argv = JSON.parse(argvLine!) as { argv: string[] }
			const idx = argv.argv.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(argv.argv[idx + 1]).toBe("sess-seeded-200")
		} finally {
			fixture.store.close()
		}
	})

	test("end-to-end (codex runner): codex thread.started event id is persisted to the phase/runner slot after exit", async () => {
		const fixture = await createFixture("session-id-capture-codex")
		try {
			const chain = createChain(fixture.store, "session-id-capture-codex-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_011, repoCwd: "/repo/session-id-codex" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-codex-session.sh")
			await writeFakeCodexSessionShellRunner(fakeRunner, "thread-captured-002")

			const options = fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: fakeRunner, extraArgs: [], model: null },
			})
			await runSchedulerUntilIdle(options)

			const refreshed = fixture.store.getItem(item.id)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-captured-002")
		} finally {
			fixture.store.close()
		}
	})

	test("end-to-end two-phase run stores iteration/codex and review/claude session ids separately (issue #311 AC2 / AC3)", async () => {
		const fixture = await createFixture("session-id-capture-phase-runner")
		try {
			const chain = createChain(fixture.store, "session-id-capture-phase-runner-chain")
			preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
			const item = createItem(fixture.store, chain, { issueNumber: 311_010, repoCwd: "/repo/session-phase-runner" })
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-session.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-session.ts")
			await writeFakeCodexSessionShellRunner(fakeCodex, "thread-iteration-311")
			await writeFakeClaudeSessionRunner(fakeClaude, "sess-review-311")

			await runSchedulerUntilIdle(fixture.options({
				phaseRunner: ({ phase }) =>
					phase === "iteration"
						? { kind: "codex", source: "iteration-default", binary: fakeCodex, extraArgs: [], model: null }
						: { kind: "claude", source: "review-default", binary: "bun", extraArgs: [fakeClaude], model: null },
				runIdFactory: ({ chain, item, phase }) => `run-${chain.id}-${item.id}-${phase}`,
				statusFromExit: ({ phase }) => phase === "iteration" ? "in_progress" : "done",
			}))

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-iteration-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("sess-review-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "codex" })).toBeNull()
		} finally {
			fixture.store.close()
		}
	})

	test("session-id-invalid stderr clears the phase/runner slot and the next spawn is fresh (issue #312 AC3)", async () => {
		const fixture = await createFixture("session-id-invalid-fresh")
		try {
			const chain = createChain(fixture.store, "session-id-invalid-fresh-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 312_003, repoCwd: "/repo/session-id-invalid" })
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-stale-312" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-invalid-once.ts")
			const attemptFile = resolve(fixture.loopDataRoot, "..", "fake-claude-invalid-attempt.txt")
			await writeFakeClaudeInvalidOnceRunner(fakeRunner, attemptFile, "sess-fresh-312")
			let now = 1_800_312_000
			let runSequence = 0

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner, attemptFile], model: null },
				runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}-${++runSequence}`,
				statusFromExit: ({ exitCode }) => exitCode === 0 ? "done" : "changes_requested",
				now: () => now,
			})

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			const firstClosed = await firstTick.spawnedRuns[0]!.closed
			expect(firstClosed.exitCode).toBe(1)
			expect(firstClosed.stderr).toContain("No conversation found with session ID: sess-stale-312")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "session_id.invalidated",
				itemId: item.id,
				phase: "iteration",
				runner: "claude",
				previousSessionId: "sess-stale-312",
			}))

			now += 2
			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			const secondClosed = await secondTick.spawnedRuns[0]!.closed
			expect(secondClosed.exitCode).toBe(0)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-fresh-312")

			const argvEvents = await readArgvEvents(fixture.eventLog)
			expect(argvEvents).toHaveLength(2)
			expect(argvEvents[0]?.argv).toContain("--resume")
			expect(argvEvents[0]?.argv).toContain("sess-stale-312")
			expect(argvEvents[1]?.argv).not.toContain("--resume")
			expect(argvEvents[1]?.argv).not.toContain("sess-stale-312")
		} finally {
			fixture.store.close()
		}
	})

	test("normal non-invalid stderr updates the phase/runner session id instead of clearing it (issue #312 AC4)", async () => {
		const fixture = await createFixture("session-id-normal-update")
		try {
			const chain = createChain(fixture.store, "session-id-normal-update-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 312_004, repoCwd: "/repo/session-id-normal" })
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-old-312" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-normal-session.ts")
			await writeFakeClaudeNormalSessionRunner(fakeRunner, "sess-new-312")

			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				statusFromExit: () => "done",
			}))
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-new-312")
			expect(fixture.schedulerEvents.some((event) => event.type === "session_id.invalidated")).toBe(false)
		} finally {
			fixture.store.close()
		}
	})

	describe("makeRunId phase segment (issue #294)", () => {
		test("phase is embedded in the runId so iter and review spawns never collide on the same item", () => {
			const iterRunId = makeRunId(42, "iteration")
			const reviewRunId = makeRunId(42, "review")
			expect(iterRunId).toContain("iteration")
			expect(reviewRunId).toContain("review")
			expect(iterRunId).not.toBe(reviewRunId)
			expect(iterRunId).toMatch(/-item-42$/)
			expect(reviewRunId).toMatch(/-item-42$/)
		})

		test("omitted phase keeps the legacy run-<ts>-<seq>-item-<id> shape", () => {
			const runId = makeRunId(7)
			expect(runId).toMatch(/^run-\d+-\d+-item-7$/)
		})

		test("phase name with unsafe characters is sanitized into a path-safe segment", () => {
			const runId = makeRunId(9, "weird phase/name")
			expect(runId).toContain("weird-phase-name")
			expect(runId).toMatch(/^[A-Za-z0-9._-]+$/)
		})
	})
})

async function writeFakeClaudeSessionRunner(path: string, sessionId: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }))
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs ?? 5))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=fake-claude-session-runner" }] } }))
process.exitCode = 0
`,
		)
	}

async function writeFakeClaudeArgvEchoRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`console.log(JSON.stringify({ argv: Bun.argv }))
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=argv-echo" }] } }))
process.exitCode = 0
`,
		)
	}

async function writeFakeClaudeInvalidOnceRunner(path: string, attemptFile: string, freshSessionId: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`import { appendFile, readFile, writeFile } from "node:fs/promises"

const attemptFile = Bun.argv[2]
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "argv", argv: Bun.argv }) + "\\n")
let attempt = 0
try {
	attempt = Number(await readFile(attemptFile, "utf-8"))
} catch {}
if (attempt === 0) {
	await writeFile(attemptFile, "1")
	console.error("No conversation found with session ID: sess-stale-312")
	process.exitCode = 1
} else {
	console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(freshSessionId)} }))
	process.exitCode = 0
}
`,
	)
}

async function writeFakeClaudeNormalSessionRunner(path: string, sessionId: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`console.error("ordinary stderr warning")
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }))
process.exitCode = 0
`,
	)
}

async function writeFakeCodexSessionShellRunner(path: string, threadId: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`#!/bin/sh
# Fake codex CLI: ignore all argv (codex shapes don't matter for this test), emit fixed JSON stream.
printf '%s\\n' '{"type":"thread.started","thread_id":"${threadId}"}'
printf '%s\\n' '{"type":"agent_message","text":"REVIEW SUMMARY: verdict=accepted; issue=#0; reason=fake-codex-session-runner"}'
exit 0
`,
	)
	await chmod(path, 0o755)
}

async function readArgvEvents(path: string): Promise<Array<{ argv: string[] }>> {
	const text = await readFile(path, "utf-8")
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event): event is { argv: string[] } =>
			Array.isArray(event.argv) && event.argv.every((arg) => typeof arg === "string"),
		)
}

async function writeShellFinalizerMarkerScript(path: string, marker: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`#!/bin/sh
echo "${marker}"
echo "ITERATION SUMMARY: scope=test; reason=marker"
echo "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=marker"
echo "FINALIZER SUMMARY: decision=complete; reason=test"
exit 0
`,
	)
	await chmod(path, 0o755)
}

function makeChainFixture(overrides: Partial<ChainRecord> = {}): ChainRecord {
	return {
		id: 1,
		name: "phase-runner-fixture",
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		umbrellaIssue: 282,
		umbrellaRepo: "mouriya-s-lab/coder-loop",
		status: "active",
		metadata: {},
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_000,
		...overrides,
	}
}

function makeItemFixture(chain: ChainRecord, overrides: Partial<ItemRecord> & Pick<ItemRecord, "issueNumber" | "repoCwd">): ItemRecord {
	return {
		id: 1,
		chainId: chain.id,
		status: "queued",
		attempts: 0,
		title: null,
		priority: null,
		branch: null,
		pr: null,
		lastRunId: null,
		sessionIds: {},
		issueFile: null,
		evidenceDir: null,
		agentCwd: null,
		runner: null,
		phase: null,
		extra: {},
		createdAt: 1_800_000_001,
		updatedAt: 1_800_000_001,
		...overrides,
	}
}

async function writeBunMarkerRunner(path: string, marker: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`process.stdout.write(${JSON.stringify(marker)} + "\\n")
process.stdout.write("ITERATION SUMMARY: scope=test; reason=marker\\n")
process.stdout.write("REVIEW SUMMARY: verdict=accepted; issue=#0; reason=marker\\n")
process.exitCode = 0
`,
		)
	}

async function writeShellMarkerScript(path: string, marker: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`#!/bin/sh
echo "${marker}"
echo "ITERATION SUMMARY: scope=test; reason=marker"
echo "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=marker"
exit 0
`,
	)
	await chmod(path, 0o755)
}

type Fixture = {
	store: ReturnType<typeof openSqliteStateStore>
	state: ReturnType<typeof createSchedulerState>
	loopDataRoot: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
	worktreeCalls: string[]
	options: (overrides?: Partial<SchedulerOptions>) => SchedulerOptions
}

type RunnerEvent = {
	type: "start" | "end"
	itemId: number
	issueNumber: number
	runId: string
	cwd: string
}

async function createFixture(name: string): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${name}-${++nextFixtureId}`)
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "runner-events.jsonl")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFakeRunner(fakeRunner)

	const store = openSqliteStateStore({ loopDataRoot })
	const state = createSchedulerState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeCalls: string[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		worktreeCalls.push(worktreePath)
		return worktreePath
	}

	const options = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
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
		worktreeManager,
		loopDataRootOptions: { loopDataRoot },
		runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}`,
		prompt: ({ item, runId, worktreePath }) => {
			const payload: Record<string, unknown> = {
				itemId: item.id,
				issueNumber: item.issueNumber,
				runId,
				worktreePath,
				eventLog,
				sleepMs: typeof item.extra.sleepMs === "number" ? item.extra.sleepMs : 5,
				exitCode: typeof item.extra.exitCode === "number" ? item.extra.exitCode : 0,
			}
			if (Object.prototype.hasOwnProperty.call(item.extra, "summary")) payload.summary = item.extra.summary
			return JSON.stringify(payload)
		},
		onEvent: (event) => {
			schedulerEvents.push(event)
		},
		...overrides,
	})

	return { store, state, loopDataRoot, eventLog, schedulerEvents, worktreeCalls, options }
}

function createChain(
	store: ReturnType<typeof openSqliteStateStore>,
	name: string,
	overrides: Partial<Parameters<typeof store.createChain>[0]> = {},
): ChainRecord {
	return store.createChain({
		name,
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		umbrellaIssue: 176,
		umbrellaRepo: "mouriya-s-lab/coder-loop",
		status: "active",
		metadata: {},
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_000,
		...overrides,
	})
}

function preInstallReviewOnEmptyLock(chain: ChainRecord, loopDataRoot: string, runId = "test-pre-installed"): void {
	const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot })
	mkdirSync(resolve(lockPath, ".."), { recursive: true })
	writeFileSync(lockPath, serializeSchedulerReviewOnEmptyLock(runId, new Date(0)))
}

function createItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	input: { issueNumber: number; repoCwd: string; sleepMs?: number; exitCode?: number; summary?: string | null; issueKind?: string | null },
) {
	const extra: JsonObject = {
		sleepMs: input.sleepMs ?? 5,
		exitCode: input.exitCode ?? 0,
		issueKind: input.issueKind === undefined ? "code" : input.issueKind,
	}
	if (Object.prototype.hasOwnProperty.call(input, "summary")) extra.summary = input.summary ?? null
	return store.createItem({
		chainId: chain.id,
		issueNumber: input.issueNumber,
		repoCwd: input.repoCwd,
		status: "queued",
		attempts: 0,
		title: `issue ${input.issueNumber}`,
		extra,
		createdAt: 1_800_000_001 + input.issueNumber,
		updatedAt: 1_800_000_001 + input.issueNumber,
	})
}

async function writeFakeRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
console.log("done:" + input.itemId)
const summary = Object.prototype.hasOwnProperty.call(input, "summary") ? input.summary : "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=fake-runner default"
if (summary !== null) console.log(summary)
process.exit(input.exitCode)
`,
	)
}

async function readRunnerEvents(path: string): Promise<RunnerEvent[]> {
	const text = await readFile(path, "utf-8")
	return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunnerEvent)
}

function maxConcurrentRunnerEvents(events: RunnerEvent[]): number {
	let active = 0
	let max = 0
	for (const event of events) {
		if (event.type === "start") active += 1
		if (event.type === "end") active -= 1
		max = Math.max(max, active)
	}
	return max
}

function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
	let resolve: () => void = () => {}
	let reject: (reason?: unknown) => void = () => {}
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function captureConsoleWarn(): { messages: string[]; restore: () => void } {
	const original = console.warn
	const messages: string[] = []
	console.warn = (...args: unknown[]) => {
		messages.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
	}
	return {
		messages,
		restore: () => {
			console.warn = original
		},
	}
}

async function promiseSettledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | null = null
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs)
			}),
		])
	} finally {
		if (timeout !== null) clearTimeout(timeout)
	}
}

async function createPresetPromptIntegrationFixture(name: string): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${name}-${++nextFixtureId}`)
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "echo-prompt-runner.ts")
	const eventLog = resolve(root, "runner-events.jsonl")
	await mkdir(loopDataRoot, { recursive: true })
	await writeEchoPromptRunner(fakeRunner)

	const store = openSqliteStateStore({ loopDataRoot })
	const state = createSchedulerState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeCalls: string[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		worktreeCalls.push(worktreePath)
		return worktreePath
	}
	const presetDir = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	const options = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
		store,
		state,
		presetDir,
		runner: {
			kind: "claude",
			source: "iteration-default",
			binary: "bun",
			extraArgs: [fakeRunner],
			model: null,
		},
		worktreeManager,
		loopDataRootOptions: { loopDataRoot },
		runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}`,
		prompt: (ctx) => resolveSchedulerPresetPhasePrompt({ presetDir, phase: ctx.phase }),
		onEvent: (event) => {
			schedulerEvents.push(event)
		},
		...overrides,
	})

	return { store, state, loopDataRoot, eventLog, schedulerEvents, worktreeCalls, options }
}

async function writeEchoPromptRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`const promptIndex = Bun.argv.indexOf("-p")
	const prompt = promptIndex === -1 ? "" : Bun.argv[promptIndex + 1] ?? ""
process.stdout.write(prompt)
process.stdout.write("\\nREVIEW SUMMARY: verdict=accepted; issue=#0; reason=echo-prompt-runner default\\n")
process.exitCode = 0
`,
		)
	}
