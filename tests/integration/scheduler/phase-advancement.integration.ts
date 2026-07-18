import { describe, expect, test } from "bun:test"
import {
	createChain, createFixture, createItem, historicalRunExtra, itemExtraToJsonObject, loadedPresetFromDir,
	readFile, readRunnerEvents, resolve, resolveChainRuntimePaths, runSchedulerUntilIdle, runtimeStatus,
	schedulerTick, stopFixture, storedItemExtra, writeFile, writeThreeStepPreset, type SchedulerEvent,
} from "./harness"

describe("scheduler", () => {
	test("active-child final trigger preparation abort remains retryable", async () => {
		const fixture = await createFixture("active-child-final-trigger-retry")
		try {
			const chain = createChain(fixture.store, "active-child-final-trigger-retry-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 535_401, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("blocked"),
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-blocked-review",
				updatedAt: 1_900_535_400,
			})
			const activeChildRunner = resolve(fixture.loopDataRoot, "final-trigger-active-child-runner.ts")
			await writeFile(activeChildRunner, "await new Promise((resolve) => setTimeout(resolve, 60_000))\n")
			let now = 1_900_535_401
			let spawnCount = 0
			let runSequence = 0
			const preAttemptStatusUpdatedAt = fixture.store.getItem(item.id)?.statusUpdatedAt
			const options = fixture.options({
				now: () => now,
				runIdFactory: () => `active-child-final-trigger-${++runSequence}`,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [activeChildRunner], model: null },
				onEvent: async (event: SchedulerEvent) => {
					fixture.schedulerEvents.push(event)
					if (event.type === "agent.spawn" && ++spawnCount === 1) {
						// The child already has its run credential here. Model the daemon-authorized
						// item.update that can race the still-awaited preparation observability hook.
						fixture.store.updateItem(item.id, {
							status: runtimeStatus("done"),
							updatedAt: now,
						})
						throw new Error("final trigger spawn observability failed")
					}
				},
			})

			const failedTick = await schedulerTick(options)
			expect(failedTick.spawnedRuns).toHaveLength(0)
			const failedRun = fixture.store.getRunByRunId("active-child-final-trigger-1")
			expect(failedRun?.endedAt).toBe(now)
			expect(failedRun?.exitCode).toBe(1)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			const failedItem = fixture.store.getItem(item.id)
			expect(failedItem?.status).toBe("blocked")
			expect(failedItem?.statusUpdatedAt).toBe(preAttemptStatusUpdatedAt)
			expect(failedItem?.phase).toBe("review")
			expect(failedItem?.extra.schedulerSpawnError).toMatchObject({
				attribution: { kind: "phase", phase: "blocked-responder" },
				message: "final trigger spawn observability failed",
			})
			expect(failedItem?.extra.schedulerBackoff).toMatchObject({ failureCount: 1, nextRunAt: now + 60 })
			expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted")).toHaveLength(1)

			await writeFile(activeChildRunner, "process.exit(0)\n")
			now += 60
			const retryTick = await schedulerTick(options)
			expect(retryTick.spawnedRuns).toHaveLength(1)
			expect(retryTick.spawnedRuns[0]?.runId).toBe("active-child-final-trigger-2")
			expect(fixture.store.getItem(item.id)?.phase).toBe("blocked-responder")
			await retryTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

})
describe("scheduler per-item phase advancement (issue #289)", () => {
	test("AC3: queued item → first tick spawns iter phase and leaves item status unchanged", async () => {
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
			expect(updated?.status).toBe("queued")
			expect(updated?.attempts).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn")).toHaveLength(1)
			expect(fixture.schedulerEvents.find((event) => event.type === "agent.spawn" && event.itemId === item.id)).toBeDefined()
			expect(fixture.schedulerEvents.find((event) => event.type === "phase.start" && event.itemId === item.id && event.phase === "iteration")).toBeDefined()
		} finally {
			await stopFixture(fixture)
		}
	})

	test("unfinished current phase run blocks first-phase re-selection without a status lock", async () => {
		const fixture = await createFixture("phase-running-ledger-blocks-pending")
		try {
			const chain = createChain(fixture.store, "phase-running-ledger-blocks-pending-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 371_002,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=running-ledger",
			})
			fixture.store.recordRun({
				runId: "run-active-iteration-ledger",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				status: runtimeStatus("running"),
				startedAt: 1_800_000_700,
				endedAt: null,
				exitCode: null,
				extra: historicalRunExtra({ startStatus: "queued" }),
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("in_progress"),
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-active-iteration-ledger",
				updatedAt: 1_800_000_710,
			})

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)).toMatchObject({
				status: runtimeStatus("in_progress"),
				phase: "iteration",
				attempts: 1,
				lastRunId: "run-active-iteration-ledger",
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("AC4: completed iteration run → next tick spawns review without status-literal handoff", async () => {
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
			expect(iterClosed.status).toBe("queued")
			expect(fixture.store.getItem(item.id)?.phase).toBe("iteration")

			const reviewTick = await schedulerTick(baseOptions)
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			expect(reviewTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review`)

			const updatedAfterReviewSpawn = fixture.store.getItem(item.id)
			expect(updatedAfterReviewSpawn?.phase).toBe("review")
			expect(updatedAfterReviewSpawn?.status).toBe("queued")
			expect(updatedAfterReviewSpawn?.attempts).toBe(1)
			await reviewTick.spawnedRuns[0]!.closed

			const spawnEvents = fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)
			expect(spawnEvents).toHaveLength(2)
			const phases = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start" && event.itemId === item.id)
				.map((event) => event.phase)
			expect(phases).toEqual(["iteration", "review"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("custom three-step preset advances through the middle non-trigger phase", async () => {
		const fixture = await createFixture("phase-order-three-step")
		const presetDir = resolve(fixture.loopDataRoot, "..", "three-step-preset")
		await writeThreeStepPreset(presetDir)
		try {
			const chain = createChain(fixture.store, "phase-order-three-step-chain", { preset: "three-step" })
			const item = createItem(fixture.store, chain, { issueNumber: 371_001, repoCwd: "/repo/a", summary: null })
			const baseOptions = fixture.options({
				loadedPreset: await loadedPresetFromDir(presetDir),
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}`,
				prompt: ({ chain: c, item: i, runId, worktreePath, phase }) =>
					JSON.stringify({
						itemId: i.id,
						issueNumber: Number(i.itemId),
						chainName: c.name,
						runId,
						worktreePath,
						eventLog: fixture.eventLogForChain(c.name),
						sleepMs: 5,
						exitCode: 0,
						summary: `PHASE SUMMARY: ${phase}`,
						writeStatus: phase === "gamma" ? "done" : null,
					}),
			})

			const alphaTick = await schedulerTick(baseOptions)
			expect(alphaTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-alpha`)
			await alphaTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: runtimeStatus("queued"), phase: "alpha", attempts: 1 })

			const betaTick = await schedulerTick(baseOptions)
			expect(betaTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-beta`)
			await betaTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: runtimeStatus("queued"), phase: "beta", attempts: 1 })

			const gammaTick = await schedulerTick(baseOptions)
			expect(gammaTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-gamma`)
			await gammaTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: runtimeStatus("done"), phase: "gamma", attempts: 1 })

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["alpha", "beta", "gamma"])
		} finally {
			await stopFixture(fixture)
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

			fixture.store.recordRun({
				runId: "run-pre-crash-iter",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				status: runtimeStatus("queued"),
				startedAt: 1_800_000_900,
				endedAt: 1_800_000_950,
				exitCode: 0,
				extra: historicalRunExtra({ startStatus: "queued" }),
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("queued"),
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
			expect(updated?.status).toBe("queued")
			expect(updated?.attempts).toBe(1)
			await tick.spawnedRuns[0]!.closed

			const spawnEvents = fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)
			expect(spawnEvents).toHaveLength(1)
			const startedPhases = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start" && event.itemId === item.id)
				.map((event) => event.phase)
			expect(startedPhases).toEqual(["review"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("no-status review exit retries review for the same item", async () => {
		const fixture = await createFixture("phase-review-incomplete")
		try {
			const chain = createChain(fixture.store, "phase-review-incomplete-chain")
			const item = fixture.store.updateItem(createItem(fixture.store, chain, {
				issueNumber: 34601,
				repoCwd: "/repo/a",
				summary: null,
			}).id, { updatedAt: 1_800_002_200, statusUpdatedAt: 1_800_002_200 })
			fixture.store.recordRun({
				runId: "run-pre-review-incomplete",
				chainId: chain.id,
				itemId: item.id,
				phase: "review",
				status: runtimeStatus("queued"),
				startedAt: 1_800_002_300,
				endedAt: 1_800_002_350,
				exitCode: 0,
				extra: historicalRunExtra({ startStatus: "queued", startStatusUpdatedAt: item.statusUpdatedAt }),
			})
			fixture.store.updateItem(item.id, {
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-review-incomplete",
				updatedAt: 1_800_002_400,
			})

			const tick = await schedulerTick(fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-retry`,
			}))

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-review-retry`)
			const spawned = fixture.store.getItem(item.id)
			expect(spawned?.phase).toBe("review")
			expect(spawned?.status).toBe("queued")
			expect(spawned?.attempts).toBe(2)

			await tick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["review"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("changes_requested + phase=review → next tick retries iteration, not review", async () => {
		const fixture = await createFixture("phase-review-verdict-retry")
		try {
			const chain = createChain(fixture.store, "phase-review-verdict-retry-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 31401,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=retry; issue=#31401; reason=review-retry",
			})
			const beforeReview = fixture.store.updateItem(item.id, {
				status: runtimeStatus("changes_requested"),
				phase: "review",
				attempts: 1,
				updatedAt: 1_800_002_300,
				statusUpdatedAt: 1_800_002_300,
			})
			fixture.store.recordRun({
				runId: "run-pre-review-retry",
				chainId: chain.id,
				itemId: item.id,
				phase: "review",
				status: runtimeStatus("changes_requested"),
				startedAt: 1_800_002_350,
				endedAt: 1_800_002_450,
				exitCode: 0,
				extra: historicalRunExtra({ startStatus: "changes_requested", startStatusUpdatedAt: beforeReview.statusUpdatedAt }),
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("changes_requested"),
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-review-retry",
				updatedAt: 1_800_002_500,
				statusUpdatedAt: 1_800_002_500,
			})

			const tick = await schedulerTick(fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-retry`,
			}))

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-iteration-retry`)
			const spawned = fixture.store.getItem(item.id)
			expect(spawned?.phase).toBe("iteration")
			expect(spawned?.status).toBe("changes_requested")
			expect(spawned?.attempts).toBe(3)

			await tick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration"])
		} finally {
			await stopFixture(fixture)
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
				status: runtimeStatus("changes_requested"),
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
			expect(spawned?.status).toBe("changes_requested")
			expect(spawned?.attempts).toBe(2)

			await tick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("AC6: completed iteration run followed by review accepted → item terminal=done, next tick does NOT spawn", async () => {
		const fixture = await createFixture("phase-ac6-review-terminal")
		try {
			const chain = createChain(fixture.store, "phase-ac6-review-terminal-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 28906,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=accepted; issue=#28906; reason=ac6",
			})
			fixture.store.recordRun({
				runId: "run-pre-review-iter",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				status: runtimeStatus("queued"),
				startedAt: 1_800_001_900,
				endedAt: 1_800_001_950,
				exitCode: 0,
				extra: historicalRunExtra({ startStatus: "queued" }),
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("queued"),
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
			await stopFixture(fixture)
		}
	})
})

describe("scheduler item-level trigger phase advancement (issue #290)", () => {
	test("AC2: blocked + phase=review → next tick spawns blocked-responder trigger phase", async () => {
		const fixture = await createFixture("trigger-b3-blocked-spawn")
		try {
			const chain = createChain(fixture.store, "trigger-b3-blocked-spawn-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 29002,
				repoCwd: "/repo/a",
				summary: "REVIEW SUMMARY: verdict=accepted; issue=#29002; reason=trigger-default",
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("blocked"),
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
			// A trigger phase running on an already-terminal item keeps that terminal status
			// persisted across spawn; it is not flipped to a continuable in_progress.
			expect(duringSpawn?.status).toBe("blocked")
			expect(duringSpawn?.attempts).toBe(2)

			await triggerTick.spawnedRuns[0]!.closed

			const afterClose = fixture.store.getItem(item.id)
			expect(afterClose?.status).toBe("blocked")
			expect(afterClose?.phase).toBe("blocked-responder")

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
			await stopFixture(fixture)
		}
	})

	test("trigger phase terminal: blocked item triggered, phase exit 0 keeps terminal status and is not pulled back into iteration", async () => {
		const fixture = await createFixture("trigger-b3-unblock")
		try {
			const chain = createChain(fixture.store, "trigger-b3-unblock-chain")
			// The production blocked-responder ends with an ITERATION-shaped marker on a non-iteration
			// phase. Under the old fall-through this mapped to changes_requested and pulled the
			// terminal item back into iteration → review. The fix keeps the pre-trigger terminal status.
			const item = createItem(fixture.store, chain, {
				issueNumber: 29003,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: blocked_responder=created; issue=#29003; blockerRepo=mouriya-s-lab/coder-loop-e2e-blocker; followup=https://example/1; queue=injected; daemon=started; reason=unblock",
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("blocked"),
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
			// AC1: run-close writes back the pre-trigger terminal status, not changes_requested.
			expect(triggerClosed.status).toBe("blocked")

			const afterTrigger = fixture.store.getItem(item.id)
			expect(afterTrigger?.status).toBe("blocked")
			expect(afterTrigger?.phase).toBe("blocked-responder")
			// The chain has no actionable item left and completes in the run-close handler.
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")

			// AC2: the next tick does NOT re-spawn iteration/review for the terminal item.
			const followUpTick = await schedulerTick(baseOptions)
			expect(followUpTick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getItem(item.id)?.phase).toBe("blocked-responder")

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === item.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["blocked-responder"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("AC4: blocked + phase=iteration (no matching trigger phase) → no spawn, chain proceeds to completion", async () => {
		const fixture = await createFixture("trigger-b3-no-match")
		try {
			const chain = createChain(fixture.store, "trigger-b3-no-match-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 29004, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("blocked"),
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
			await stopFixture(fixture)
		}
	})

	test("dependsOn unblock: terminal item with all deps in success terminal is restored to actionable, next tick selects iteration", async () => {
		const fixture = await createFixture("depends-unblock-success")
		try {
			// Blocker lives in a different chain (cross-repo); item ids are globally unique so the
			// dependent's dependsOn can point across chains. The blocker chain is held non-active so
			// this test only exercises the dependent chain's unblock pass — the unblock/guard logic
			// resolves the blocker via store.getItem(id) regardless of the blocker chain's status.
			const blockerChain = createChain(fixture.store, "depends-unblock-blocker-chain", {
				repository: "mouriya-s-lab/coder-loop-e2e-blocker",
				status: "completed",
			})
			const blocker = createItem(fixture.store, blockerChain, { issueNumber: 7, repoCwd: "/repo/blocker", summary: null })
			fixture.store.updateItem(blocker.id, { status: runtimeStatus("done"), phase: "review", updatedAt: 1_800_010_000 })

			const dependentChain = createChain(fixture.store, "depends-unblock-dependent-chain")
			const dependent = createItem(fixture.store, dependentChain, { issueNumber: 29010, repoCwd: "/repo/a", summary: null })
			// Lifecycle: blocked-responder already ran (phase=blocked-responder) and declared the
			// cross-chain dependency; the item is parked in the stable blocked terminal state.
			fixture.store.updateItem(dependent.id, {
				status: runtimeStatus("blocked"),
				phase: "blocked-responder",
				attempts: 3,
				extra: storedItemExtra({ ...itemExtraToJsonObject(dependent.extra), dependsOn: [blocker.id] }),
				updatedAt: 1_800_010_100,
			})

			const baseOptions = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-dep`,
			})

			// Tick 1: the unblock pass restores the item to the entry status; nothing spawns and the
			// chain is NOT completed because an item just became actionable.
			const unblockTick = await schedulerTick(baseOptions)
			expect(unblockTick.spawnedRuns).toHaveLength(0)
			expect(unblockTick.completedChainIds).toEqual([])

			const afterUnblock = fixture.store.getItem(dependent.id)
			expect(afterUnblock?.status).toBe("queued")
			expect(afterUnblock?.extra.dependsOn).toBeUndefined()
			expect(fixture.store.getChain(dependentChain.id)?.status).toBe("active")

			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			const unblockedEvents = fixture.schedulerEvents.filter(
				(event): event is Extract<SchedulerEvent, { type: "item.dependency_unblocked" }> =>
					event.type === "item.dependency_unblocked" && event.rowId === dependent.id,
			)
			expect(unblockedEvents).toHaveLength(1)
			expect(unblockedEvents[0]?.fromStatus).toBe("blocked")
			expect(unblockedEvents[0]?.toStatus).toBe("queued")
			expect(unblockedEvents[0]?.dependsOn).toEqual([blocker.id])

			// Tick 2: the now-actionable item is selected into iteration.
			const selectTick = await schedulerTick(baseOptions)
			expect(selectTick.spawnedRuns).toHaveLength(1)
			expect(selectTick.spawnedRuns[0]?.runId).toBe(`run-${dependentChain.id}-${dependent.id}-iteration-dep`)
			await selectTick.spawnedRuns[0]!.closed

			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === dependent.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("dependsOn unblock: item is NOT awakened when a dep is in-flight or ends in a non-success terminal status", async () => {
		const fixture = await createFixture("depends-unblock-negative")
		try {
			// Non-active blocker chain: this test exercises only the dependent chain's unblock pass,
			// which reads the blocker through store.getItem(id) independent of the blocker chain status.
			const blockerChain = createChain(fixture.store, "depends-unblock-neg-blocker-chain", {
				repository: "mouriya-s-lab/coder-loop-e2e-blocker",
				status: "completed",
			})
			const blocker = createItem(fixture.store, blockerChain, { issueNumber: 8, repoCwd: "/repo/blocker", summary: null })
			fixture.store.updateItem(blocker.id, { status: runtimeStatus("in_progress"), phase: "iteration", updatedAt: 1_800_011_000 })

			const dependentChain = createChain(fixture.store, "depends-unblock-neg-dependent-chain")
			const dependent = createItem(fixture.store, dependentChain, { issueNumber: 29011, repoCwd: "/repo/a", summary: null })
			fixture.store.updateItem(dependent.id, {
				status: runtimeStatus("blocked"),
				phase: "blocked-responder",
				attempts: 3,
				extra: storedItemExtra({ ...itemExtraToJsonObject(dependent.extra), dependsOn: [blocker.id] }),
				updatedAt: 1_800_011_100,
			})

			// Dep in-flight → no awakening, item stays blocked.
			const inflightTick = await schedulerTick(fixture.options())
			expect(inflightTick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(dependent.id)?.status).toBe("blocked")
			expect(fixture.store.getItem(dependent.id)?.extra.dependsOn).toEqual([blocker.id])

			// Dep ends in a non-success terminal status (exhausted) → still no awakening.
			fixture.store.updateItem(blocker.id, { status: runtimeStatus("exhausted"), updatedAt: 1_800_011_200 })
			await schedulerTick(fixture.options())
			expect(fixture.store.getItem(dependent.id)?.status).toBe("blocked")
			expect(fixture.store.getItem(dependent.id)?.extra.dependsOn).toEqual([blocker.id])

			const phaseStarts = fixture.schedulerEvents.filter(
				(event) => event.type === "phase.start" && event.itemId === dependent.id,
			)
			expect(phaseStarts).toHaveLength(0)
			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			const unblockedEvents = fixture.schedulerEvents.filter(
				(event) => event.type === "item.dependency_unblocked" && event.rowId === dependent.id,
			)
			expect(unblockedEvents).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("dependsOn unblock: chain with an item whose dep is still in-flight is not completed", async () => {
		const fixture = await createFixture("depends-unblock-completion-guard")
		try {
			// Non-active blocker chain: the completion guard resolves the blocker through
			// store.getItem(id), so the blocker chain need not be ticked for this test.
			const blockerChain = createChain(fixture.store, "depends-guard-blocker-chain", {
				repository: "mouriya-s-lab/coder-loop-e2e-blocker",
				status: "completed",
			})
			const blocker = createItem(fixture.store, blockerChain, { issueNumber: 9, repoCwd: "/repo/blocker", summary: null })
			fixture.store.updateItem(blocker.id, { status: runtimeStatus("in_progress"), phase: "iteration", updatedAt: 1_800_012_000 })

			const dependentChain = createChain(fixture.store, "depends-guard-dependent-chain")
			const dependent = createItem(fixture.store, dependentChain, { issueNumber: 29012, repoCwd: "/repo/a", summary: null })
			fixture.store.updateItem(dependent.id, {
				status: runtimeStatus("blocked"),
				phase: "blocked-responder",
				attempts: 3,
				extra: storedItemExtra({ ...itemExtraToJsonObject(dependent.extra), dependsOn: [blocker.id] }),
				updatedAt: 1_800_012_100,
			})

			// All chain items are terminal, so completion would normally fire — but the in-flight
			// cross-chain dep keeps the chain active. #456: the legacy review-on-empty lock
			// prerequisite is gone; chain-complete is now gated solely on terminal-status uniformity
			// and the declared chain-complete trigger phases (none in this fixture).
			const guardedTick = await schedulerTick(fixture.options())
			expect(guardedTick.completedChainIds).toEqual([])
			expect(fixture.store.getChain(dependentChain.id)?.status).toBe("active")

			// Once the dep reaches success terminal, the same chain unblocks then proceeds normally.
			fixture.store.updateItem(blocker.id, { status: runtimeStatus("done"), updatedAt: 1_800_012_200 })
			const unblockTick = await schedulerTick(fixture.options())
			expect(unblockTick.completedChainIds).toEqual([])
			expect(fixture.store.getItem(dependent.id)?.status).toBe("queued")
			expect(fixture.store.getChain(dependentChain.id)?.status).toBe("active")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("dependsOn unblock e2e: blocker chain reaching done auto-recovers the cross-chain blocked item to done with no manual intervention", async () => {
		const fixture = await createFixture("depends-unblock-e2e")
		try {
			// Two ACTIVE chains in the same central DB — the realistic cross-repo shape. The whole
			// run is driven by the real fake runner over many ticks; the only state we set by hand is
			// the blocked-responder postcondition (item parked blocked with a cross-chain dependsOn).
			const blockerChain = createChain(fixture.store, "depends-e2e-blocker-chain", {
				repository: "mouriya-s-lab/coder-loop-e2e-blocker",
			})
			const blocker = createItem(fixture.store, blockerChain, { issueNumber: 41, repoCwd: "/repo/blocker", writeStatus: "done" })

			const dependentChain = createChain(fixture.store, "depends-e2e-dependent-chain")
			const dependent = createItem(fixture.store, dependentChain, { issueNumber: 29013, repoCwd: "/repo/a", writeStatus: "done" })
			fixture.store.updateItem(dependent.id, {
				status: runtimeStatus("blocked"),
				phase: "blocked-responder",
				attempts: 3,
				extra: storedItemExtra({ ...itemExtraToJsonObject(dependent.extra), dependsOn: [blocker.id] }),
				updatedAt: 1_800_013_000,
			})

			const opts = fixture.options({
				runIdFactory: ({ chain: c, item: i, phase }) => `run-${c.id}-${i.id}-${phase}-e2e`,
			})

			// Drive like the daemon: keep ticking past idle. The tick that unblocks the dependent
			// emits no spawn (restore happens after selection), so a single until-idle pass would stop
			// one tick early; loop until both chains complete. Each pass also drains pending close
			// handlers, so the store closes cleanly.
			for (let pass = 0; pass < 6; pass += 1) {
				await runSchedulerUntilIdle(opts)
				const blockerDone = fixture.store.getChain(blockerChain.id)?.status === "completed"
				const dependentDone = fixture.store.getChain(dependentChain.id)?.status === "completed"
				if (blockerDone && dependentDone) break
			}

			// Blocker ran to success terminal on its own chain.
			expect(fixture.store.getItem(blocker.id)?.status).toBe("done")
			// Engine restored the dependent off the back of the blocker — no manual status change —
			// then it ran iteration→review to done and its chain completed.
			expect(fixture.store.getItem(dependent.id)?.status).toBe("done")
			expect(fixture.store.getItem(dependent.id)?.extra.dependsOn).toBeUndefined()
			expect(fixture.store.getChain(blockerChain.id)?.status).toBe("completed")
			expect(fixture.store.getChain(dependentChain.id)?.status).toBe("completed")

			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			const unblockedEvents = fixture.schedulerEvents.filter(
				(event): event is Extract<SchedulerEvent, { type: "item.dependency_unblocked" }> =>
					event.type === "item.dependency_unblocked" && event.rowId === dependent.id,
			)
			expect(unblockedEvents).toHaveLength(1)
			expect(unblockedEvents[0]?.fromStatus).toBe("blocked")
			expect(unblockedEvents[0]?.toStatus).toBe("queued")
			expect(unblockedEvents[0]?.dependsOn).toEqual([blocker.id])

			// The dependent's real work phase only ran AFTER recovery, never while blocked. The fake
			// runner emits verdict=accepted on its single iteration run, so the item reaches done in
			// one phase (scheduler.ts maps exit 0 + accepted → done regardless of phase).
			const phaseStarts = fixture.schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === dependent.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("race: review writes blocked, chain stays active until item-level trigger spawns", async () => {
		const fixture = await createFixture("trigger-b3-race")
		try {
			const chain = createChain(fixture.store, "trigger-b3-race-chain")
			// #405: agent's blocked-status decision now comes through `extra.writeStatus`
			// (mirror of `coder-loop item update --status blocked`), not a `REVIEW SUMMARY:
			// verdict=blocked` stdout token.
			const item = createItem(fixture.store, chain, {
				issueNumber: 29005,
				repoCwd: "/repo/a",
				writeStatus: "blocked",
			})
			fixture.store.recordRun({
				runId: "run-pre-race-iter",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				status: runtimeStatus("queued"),
				startedAt: 1_800_005_900,
				endedAt: 1_800_005_950,
				exitCode: 0,
				extra: historicalRunExtra({ startStatus: "queued" }),
			})
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("queued"),
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
				extra: storedItemExtra({
					...itemExtraToJsonObject(fixture.store.getItem(item.id)!.extra),
					// #405: the second-tick `blocked-responder` trigger phase is a side-effect run
					// and never writes status (TRIGGER_PHASES set). Preserve the existing
					// writeStatus so the fake runner's status mirror stays self-consistent.
					writeStatus: "blocked",
				}),
			})
			const triggerTick = await schedulerTick(baseOptions)
			expect(triggerTick.spawnedRuns).toHaveLength(1)
			expect(triggerTick.spawnedRuns[0]?.runId).toBe(`run-${chain.id}-${item.id}-blocked-responder-race`)
			await triggerTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItem(item.id)?.phase).toBe("blocked-responder")
			expect(fixture.store.getItem(item.id)?.status).toBe("blocked")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			await stopFixture(fixture)
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
				status: runtimeStatus("blocked"),
				phase: "review",
				attempts: 2,
				lastRunId: "run-pre-real-spawn-review",
				updatedAt: 1_800_007_000,
			})

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed
			expect(closed.exitCode).toBe(0)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(closed.runId), "utf-8")).toContain(`done:${item.id}`)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(closed.runId), "utf-8")).toContain("REVIEW SUMMARY: verdict=accepted")

			const runs = (await readRunnerEvents(fixture.eventLogForChain(chain.name))).map((event) => event.type)
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
			await stopFixture(fixture)
		}
	})
})
