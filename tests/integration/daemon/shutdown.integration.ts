import { REPO_ROOT, describe, expect, expectOk, isPidAlive, numberValue, openSqliteStateStore, pathExists, queryObservabilityEvents, readChainStatus, readCurrentRun, readItem, readRun, record, request, resolveLoopDataPaths, runtimeStatus, startCoderLoopDaemon, startFixture, stringValue, test, waitFor } from "./harness"

describe("daemon", () => {
	test("daemon shutdown cleans runtime files and records the terminated run (#467)", async () => {
		const fixture = await startFixture("graceful-shutdown")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 400, exitCode: 0 },
			})
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			expect(await pathExists(fixture.socketPath)).toBe(false)
			expect(await pathExists(fixture.pidFile)).toBe(false)
			// #467: down terminates the active run instead of waiting for natural
			// completion — even a nearly-done agent is cut short. The item keeps its
			// entry status and resumes on the next daemon up.
			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			expect(item?.status).toBe("queued")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(1)
			expect(await readCurrentRun(fixture.loopDataRoot, chainId)).toBeNull()

			const phaseEnd = fixture.schedulerEvents.find((event) => event.type === "phase.end")
			expect(phaseEnd).toBeDefined()
			if (phaseEnd?.type !== "phase.end") throw new Error("expected phase.end event")
			expect(phaseEnd.status).toBe("queued")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("shutdown completes after scheduler tick rejection", async () => {
		let rejectSchedulerEvent = false
		let reportTickEntered: () => void = () => {}
		const tickEntered = new Promise<void>((resolveEntered) => {
			reportTickEntered = resolveEntered
		})
		let releaseTick: () => void = () => {}
		const tickReleased = new Promise<void>((resolveReleased) => {
			releaseTick = resolveReleased
		})
		const fixture = await startFixture("shutdown-tick-rejection", {
			schedulerIntervalMs: 100,
			schedulerConfig: {
				onEvent: async (event) => {
					if (!rejectSchedulerEvent || event.type !== "slot.busy") return
					reportTickEntered()
					await tickReleased
					throw new Error("injected scheduler tick rejection")
				},
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-tick-rejection-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "536",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 30_000, exitCode: 0 },
			})
			const activeRuns = await waitFor(
				async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns,
				(runs) => Array.isArray(runs) && runs.length === 1,
			)
			if (!Array.isArray(activeRuns)) throw new Error("expected one active run")
			const activeRun = record(activeRuns[0])
			const runId = stringValue(activeRun.runId)

			rejectSchedulerEvent = true
			await tickEntered
			const stopping = fixture.daemon.stop()
			rejectSchedulerEvent = false
			await new Promise((resolveWait) => setTimeout(resolveWait, 50))
			releaseTick()
			await expect(stopping).resolves.toBeUndefined()

			expect(await pathExists(fixture.socketPath)).toBe(false)
			expect(await pathExists(fixture.pidFile)).toBe(false)
			expect(isPidAlive(numberValue(activeRun.pid))).toBe(false)
			const run = await readRun(fixture.loopDataRoot, runId)
			expect(run?.exitCode).toBe(1)
			expect(await readCurrentRun(fixture.loopDataRoot, chainId)).toBeNull()

			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
				type: "scheduler.tick_failed",
			})
			expect(events.events.some((event) =>
				event.type === "scheduler.tick_failed"
				&& event.payload.error.includes("injected scheduler tick rejection"),
			)).toBe(true)

			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, scheduler: { enabled: false } })
			await restarted.stop()
		} finally {
			releaseTick()
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown terminates active runs with bounded grace and reports them (#467)", async () => {
		const fixture = await startFixture("graceful-shutdown-timing")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-timing-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			// 30s sleep: pre-#467 shutdown waited for natural completion, so a bounded
			// shutdown below proves termination rather than waiting.
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "181",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 30_000, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			const activeRuns = await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			if (!Array.isArray(activeRuns)) throw new Error("expected activeRuns array")
			const firstActiveRun = record(activeRuns[0])
			const agentPid: number | undefined = typeof firstActiveRun.pid === "number" ? firstActiveRun.pid : undefined

			const downStartedAt = Date.now()
			const down = expectOk(await request(fixture, "daemon.down"))
			await fixture.daemon.closed
			expect(Date.now() - downStartedAt).toBeLessThan(10_000)

			// The down response names the run it cut short; the force-killed agent never
			// wrote its own status, so the item keeps its entry status and is resumable.
			expect(down).toMatchObject({
				shutdown: true,
				terminatedRuns: [{ chainId, itemId, exitCode: 1, status: runtimeStatus("queued") }],
			})
			const item = await readItem(fixture.loopDataRoot, chainId, 181)
			expect(item?.status).toBe("queued")
			// No orphan agent survives the daemon (signal 0 probes liveness).
			if (typeof agentPid === "number") {
				expect(() => process.kill(agentPid, 0)).toThrow()
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown waits for pending scheduler close handlers before closing db", async () => {
		let triggerStarted = false
		let releaseTrigger: () => void = () => {}
		const triggerReleased = new Promise<void>((resolveRelease) => {
			releaseTrigger = resolveRelease
		})
		const fixture = await startFixture("shutdown-pending-close-handler", {
			schedulerIntervalMs: 30,
			chainCompleteTriggerForChain: async () => {
				triggerStarted = true
				await triggerReleased
				return { decision: "complete" }
			},
		})
		try {
			const chainName = "shutdown-pending-close-handler-chain"
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "317",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})
			await waitFor(async () => triggerStarted, (started) => started)

			let closed = false
			void fixture.daemon.closed.then(() => {
				closed = true
			})
			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await new Promise((resolveWait) => setTimeout(resolveWait, 50))
			expect(closed).toBe(false)

			releaseTrigger()
			await fixture.daemon.closed
			expect(closed).toBe(true)
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("completed")
		} finally {
			releaseTrigger()
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown preserves user terminal item status", async () => {
		const fixture = await startFixture("terminal-shutdown")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "terminal-shutdown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 500, exitCode: 0 },
			})).item)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(numberValue(added.id), { phase: "review", updatedAt: 1_800_020_300 })
			} finally {
				store.close()
			}

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: runtimeStatus("done") },
			})).item)
			expect(updated.status).toBe("done")

			// Wait for the run to finish naturally before shutdown (item.update no longer kills it).
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			expect(item?.status).toBe("done")
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #508: daemon recovery is a process-layer concern only. It clears the orphan `current_runs`
	// row and kills the stale process group, but it MUST NOT rewrite `items.status` /
	// `items.phase` / `items.sessionIds`. The interrupted item is re-scheduled by the scheduler
	// on the next tick because `gh-issue-pr-iteration` lists `in_progress` in `continuable`.
})
