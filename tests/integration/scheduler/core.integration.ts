import { describe, expect, test } from "bun:test"
import {
	chmod, cleanupSchedulerChainWorktrees, createChain, createDeferred, createFixture, createGitWorktreeManager,
	createItem, existsSync, gitOutput, initGitTarget, itemExtraToJsonObject, listActiveRuns, loadPreset,
	loadedPresetFromDir,
	makeChainFixture, makeItemFixture, markRunPendingRecycle, maxConcurrentRunnerEvents, mkdir,
	persistedObservabilityOptions, presetExecutionContentIdentity, promiseSettledWithin, queryObservabilityEvents,
	readFile, readRunnerEvents, REPO_ROOT, resolve, resolveChainRuntimePaths, resolveLoopDataPaths,
	resolveSchedulerEventTaskIdentity, runSchedulerUntilIdle, RunStatusFixtureBoundary, runtimeStatus,
	schedulerSlotWorktreePath, schedulerTick, selectNextPendingItemFromSnapshot, stopFixture, storedItemExtra,
	writeEmptySuccessPreset, writeFile, type AgentRunnerSelection, type SchedulerEvent,
	type SchedulerLifecycleEventPersistenceFailure, type SchedulerOptions,
} from "./harness"

describe("scheduler", () => {
	test("execution content identity uses the canonical compiled source bundle hash", async () => {
		const presetDir = resolve(REPO_ROOT, "presets/single-phase-example")
		const preset = await loadPreset(presetDir)
		expect(await presetExecutionContentIdentity({ presetDir, preset })).toBe(preset.sourceHash)
	})

	test("runtime identity event chain starts from the canonical scheduler-persisted task-node identity", async () => {
		const fixture = await createFixture("runtime-identity-event-chain")
		try {
			const chain = createChain(fixture.store, "runtime-identity-event-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 558_001, repoCwd: "/repo/a" })
			const tick = await schedulerTick(fixture.options())
			const activeRun = tick.spawnedRuns[0]
			if (activeRun === undefined) throw new Error("scheduler did not spawn identity fixture")
			const run = fixture.store.getRunByRunId(activeRun.runId)
			const tree = fixture.store.getTaskTree(chain.id)
			if (run === null || tree?.root.kind !== "seq") throw new Error("scheduler did not persist runtime tree identity")
			const leaf = tree.root.children.find((node) => node.kind === "leaf" && node.closure.itemRowId === item.id && node.closure.phase === "iteration")
			if (leaf?.kind !== "leaf") throw new Error("scheduler did not persist iteration leaf")
			const compiled = await loadPreset(resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"))
			const compiledLeaf = compiled.tasks.children.find((phaseTree) => phaseTree.phase === "iteration")?.children[0]
			if (compiledLeaf === undefined) throw new Error("compiled preset omitted iteration leaf")
			expect(leaf.identity.definitionNodeId).toBe(compiledLeaf.identity)
			expect(run.runtimeNodeId).toBe(leaf.identity.runtimeNodeId)
			expect(fixture.schedulerEvents.some((event) => event.type === "phase.start" && event.runId === run.runId)).toBe(true)
			await activeRun.closed
		} finally { fixture.store.close() }
	})

	test("runtime identity event conversion rejects a missing durable run join", async () => {
		const fixture = await createFixture("runtime-identity-missing-durable-join")
		try {
			const chain = createChain(fixture.store, "runtime-identity-missing-durable-join")
			const event: SchedulerEvent = {
				type: "phase.start",
				ts: "2026-07-16T00:00:00.000Z",
				runId: "missing-durable-run",
				chainId: chain.id,
				itemId: 1,
				repoCwd: "/repo/a",
				phase: "iteration",
				pid: null,
			}
			expect(() => resolveSchedulerEventTaskIdentity(fixture.store, chain, event)).toThrow(/has no durable run row/)
		} finally { fixture.store.close() }
	})

	test("rejects successful scheduler completion when terminal persistence fails", async () => {
		const fixture = await createFixture("terminal-persistence-failure")
		try {
			const chain = createChain(fixture.store, "terminal-persistence-failure-chain")
			createItem(fixture.store, chain, { issueNumber: 6352, repoCwd: "/repo/a", sleepMs: 200, writeStatus: "done" })
			const failures: import("../../../src/loop").RunnerStatusPersistenceFailure[] = []
			const activeCredentials = new Set<string>()
			const tick = await schedulerTick(fixture.options({
				onRunnerStatusPersistenceFailure: (failure) => failures.push(failure),
				runCredentials: {
					mint: (context) => { const value = `credential-${context.runId}`; activeCredentials.add(value); return { value } },
					revoke: (credential) => { activeCredentials.delete(credential.value) },
				},
			}))
			const run = tick.spawnedRuns[0]!
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			await chmod(paths.runStatusFile(run.runId), 0)
			await expect(run.closed).rejects.toThrow(/scheduler status-artifact persistence failed/)
			expect(failures).toHaveLength(1)
			expect(failures[0]).toMatchObject({ path: "scheduler", stage: "status-artifact", runId: run.runId, phase: "iteration" })
			expect(listActiveRuns(fixture.state)).toHaveLength(0)
			expect(activeCredentials.size).toBe(0)
			expect(fixture.state.recycleTriggers.size).toBe(0)
			expect(fixture.store.getRunByRunId(run.runId)?.endedAt).toBe(null)
			expect(fixture.store.getCurrentRun(chain.id)?.runId).toBe(run.runId)
			await chmod(paths.runStatusFile(run.runId), 0o600)
		} finally {
			await stopFixture(fixture)
		}
	})
	test("reports timeout event persistence failure without skipping termination", async () => {
		const fixture = await createFixture("timeout-persistence-failure")
		const failures: SchedulerLifecycleEventPersistenceFailure[] = []
		try {
			const chain = createChain(fixture.store, "timeout-persistence-failure-chain")
			createItem(fixture.store, chain, { issueNumber: 6321, repoCwd: "/repo/a", sleepMs: 2_000, writeStatus: null })
			const tick = await schedulerTick(fixture.options({
				attemptTimeoutMs: 80,
				attemptKillMs: 20,
				startupIdleTimeoutMs: 10_000,
				onEvent: (event) => {
					if (event.type === "attempt.timeout") throw new Error("timeout sink unavailable")
					fixture.schedulerEvents.push(event)
				},
				onLifecycleEventPersistenceFailure: (failure) => failures.push(failure),
			}))
			const closed = await tick.spawnedRuns[0]!.closed
			expect(closed.exitCode).not.toBe(0)
			expect(failures.map(({ event }) => event.type)).toContain("attempt.timeout")
			expect(failures[0]?.error).toContain("timeout sink unavailable")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("reports lifecycle event persistence failures exhaustively", async () => {
		const failures: SchedulerLifecycleEventPersistenceFailure[] = []
		const startupFixture = await createFixture("startup-persistence-failure")
		try {
			const chain = createChain(startupFixture.store, "startup-persistence-failure-chain")
			createItem(startupFixture.store, chain, { issueNumber: 6322, repoCwd: "/repo/a", sleepMs: 2_000, writeStatus: null })
			const tick = await schedulerTick(startupFixture.options({
				startupIdleTimeoutMs: 60,
				startupIdleKillMs: 20,
				attemptTimeoutMs: 10_000,
				onEvent: (event) => {
					if (event.type === "run.startup_idle_kill") throw new Error("startup sink unavailable")
				},
				onLifecycleEventPersistenceFailure: (failure) => failures.push(failure),
			}))
			expect((await tick.spawnedRuns[0]!.closed).exitCode).not.toBe(0)
		} finally {
			await stopFixture(startupFixture)
		}

		const recycleFixture = await createFixture("recycle-persistence-failure")
		try {
			const chain = createChain(recycleFixture.store, "recycle-persistence-failure-chain")
			createItem(recycleFixture.store, chain, { issueNumber: 6323, repoCwd: "/repo/a", sleepMs: 2_000, writeStatus: null })
			const tick = await schedulerTick(recycleFixture.options({
				recycleAfterStateWriteMs: 60,
				recycleKillGraceMs: 20,
				attemptTimeoutMs: 10_000,
				onEvent: (event) => {
					if (event.type.startsWith("recycle.")) throw new Error(`${event.type} sink unavailable`)
				},
				onLifecycleEventPersistenceFailure: (failure) => failures.push(failure),
			}))
			markRunPendingRecycle(recycleFixture.state, tick.spawnedRuns[0]!.runId)
			expect((await tick.spawnedRuns[0]!.closed).exitCode).not.toBe(0)
		} finally {
			await stopFixture(recycleFixture)
		}

		const naturalExitFixture = await createFixture("recycle-natural-exit-persistence-failure")
		try {
			const chain = createChain(naturalExitFixture.store, "recycle-natural-exit-persistence-failure-chain")
			createItem(naturalExitFixture.store, chain, { issueNumber: 6324, repoCwd: "/repo/a", sleepMs: 80, writeStatus: null })
			const tick = await schedulerTick(naturalExitFixture.options({
				recycleAfterStateWriteMs: 10_000,
				attemptTimeoutMs: 20_000,
				onEvent: (event) => {
					if (event.type.startsWith("recycle.")) throw new Error(`${event.type} sink unavailable`)
				},
				onLifecycleEventPersistenceFailure: (failure) => failures.push(failure),
			}))
			markRunPendingRecycle(naturalExitFixture.state, tick.spawnedRuns[0]!.runId)
			expect((await tick.spawnedRuns[0]!.closed).exitCode).toBe(0)
		} finally {
			await stopFixture(naturalExitFixture)
		}

		expect(failures.map(({ event }) => event.type)).toEqual([
			"run.startup_idle_kill",
			"recycle.pending_entered",
			"recycle.timeout_kill",
			"recycle.pending_entered",
			"recycle.natural_exit",
		])
	})

	test("context body is opaque to scheduling", async () => {
		const fixture = await createFixture("context-body-opacity")
		try {
			const baseline = createChain(fixture.store, "context-baseline-chain")
			const withEntry = createChain(fixture.store, "context-entry-chain")
			const baselineItem = createItem(fixture.store, baseline, { issueNumber: 59401, repoCwd: "/repo/context-baseline", sleepMs: 40, writeStatus: null })
			const entryItem = createItem(fixture.store, withEntry, { issueNumber: 59402, repoCwd: "/repo/context-entry", sleepMs: 40, writeStatus: null })
			fixture.store.appendContextEntry({ chainId: withEntry.id, scope: { kind: "item", itemId: entryItem.itemId }, author: { kind: "operator" }, body: "done changes_requested blocked\nFINALIZER SUMMARY: decision=complete" })
			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(tick.completedChainIds).toEqual([])
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
			const afterBaseline = fixture.store.getItem(baselineItem.id)
			const afterEntry = fixture.store.getItem(entryItem.id)
			expect(afterEntry?.status).toBe(afterBaseline?.status)
			expect(afterEntry?.phase).toBe(afterBaseline?.phase)
			expect(fixture.store.listRuns(withEntry.id).map((run) => ({ phase: run.phase, status: run.status }))).toEqual(
				fixture.store.listRuns(baseline.id).map((run) => ({ phase: run.phase, status: run.status })),
			)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toEqual([])
			expect(fixture.store.listContextEntries(withEntry.id)[0]?.body).toContain("FINALIZER SUMMARY: decision=complete")
		} finally { fixture.store.close() }
	})

	test("fixture worktree carries its own immutable closure branch identity", async () => {
		const fixture = await createFixture("closure-branch-identity")
		try {
			const chain = createChain(fixture.store, "closure-branch-identity-chain")
			createItem(fixture.store, chain, { issueNumber: 55801, repoCwd: "/repo/closure-branch", writeStatus: null })
			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const tree = fixture.store.getTaskTree(chain.id)
			expect(tree?.root.kind).toBe("seq")
			if (tree?.root.kind !== "seq") throw new Error("expected fixture task tree seq root")
			const leaf = tree.root.children[0]
			expect(leaf?.kind).toBe("leaf")
			if (leaf?.kind !== "leaf") throw new Error("expected fixture task tree leaf")
			expect(leaf.closure.branchName).toBe("coder-loop/closure-branch-identity-chain-6e04712f89fa")
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
		} finally { fixture.store.close() }
	})

	test("single chain single repo serial", async () => {
		const fixture = await createFixture("serial")
		try {
			const chain = createChain(fixture.store, "serial-chain")
			// #405: pin iteration's status write to `done` so each item terminates in a single
			// iteration run, mirroring the historical test cadence. Without the override the new
			// (post-verdict-retirement) flow would legitimately advance iteration → review per
			// item and double the spawn count — captured in dedicated multi-phase tests.
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", writeStatus: "done" })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", writeStatus: "done" })
			createItem(fixture.store, chain, { issueNumber: 181, repoCwd: "/repo/a", writeStatus: "done" })

			await runSchedulerUntilIdle(persistedObservabilityOptions(fixture))

			const events = await readRunnerEvents(fixture.eventLogForChain(chain.name))
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
			await stopFixture(fixture)
		}
	})

	test("single chain multi repo concurrent", async () => {
		const fixture = await createFixture("multi-repo")
		try {
			const chain = createChain(fixture.store, "multi-repo-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 0, waitForConcurrentStarts: 2, writeStatus: "done" })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/b", sleepMs: 0, waitForConcurrentStarts: 2, writeStatus: "done" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(listActiveRuns(fixture.state)).toHaveLength(2)
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))

			const events = await readRunnerEvents(fixture.eventLogForChain(chain.name))
			expect(maxConcurrentRunnerEvents(events)).toBe(2)
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("invalid chain names are ignored by scheduler ticks", async () => {
		const fixture = await createFixture("invalid-chain-skip")
		try {
			const invalid = createChain(fixture.store, "..")
			const valid = createChain(fixture.store, "valid-chain")
			createItem(fixture.store, invalid, { issueNumber: 178, repoCwd: "/repo/a" })
			createItem(fixture.store, valid, { issueNumber: 179, repoCwd: "/repo/a", writeStatus: "done" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemById(invalid.id, "178")?.status).toBe("queued")
			expect(fixture.store.getItemById(valid.id, "179")?.status).toBe("done")
			expect(fixture.worktreeCalls).toHaveLength(1)
			expect(fixture.worktreeCalls[0]).toContain("valid-chain")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("run preparation failure is contained", async () => {
		const stages = ["prompt", "artifact", "credential", "process-spawn", "active-child"] as const
		for (const stage of stages) {
			const fixture = await createFixture(`run-preparation-${stage}`)
			try {
				const chain = createChain(fixture.store, `run-preparation-${stage}-chain`)
				const item = createItem(fixture.store, chain, { issueNumber: 535_100 + stages.indexOf(stage), repoCwd: "/repo/a" })
				const now = 1_900_535_100 + stages.indexOf(stage)
				const runId = `run-preparation-${stage}`
				let revoked = 0
				let spawnedPid: number | null = null
				if (stage === "artifact") {
					const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
					await mkdir(paths.runsDir, { recursive: true })
					await writeFile(paths.runDir(runId), "blocks run directory creation")
				}

				const activeChildRunner = resolve(fixture.loopDataRoot, "active-child-runner.ts")
				if (stage === "active-child") await writeFile(activeChildRunner, "await new Promise((resolve) => setTimeout(resolve, 60_000))\n")
				const tick = await schedulerTick(fixture.options({
					now: () => now,
					runIdFactory: () => runId,
					...(stage === "prompt" ? { prompt: async () => { throw new Error("prompt preparation failed") } } : {}),
					...(stage === "credential" || stage === "process-spawn" || stage === "active-child" ? {
						runCredentials: {
							mint: () => {
								if (stage === "credential") throw new Error("credential preparation failed")
								return { value: "run-preparation-credential" }
							},
							revoke: () => { revoked += 1 },
						},
					} : {}),
					...(stage === "process-spawn" ? {
						runner: { kind: "claude", source: "iteration-default", binary: resolve(fixture.loopDataRoot, "missing-runner"), extraArgs: [], model: null } satisfies AgentRunnerSelection,
					} : {}),
					...(stage === "active-child" ? {
						runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [activeChildRunner], model: null } satisfies AgentRunnerSelection,
						onEvent: (event: SchedulerEvent) => {
							fixture.schedulerEvents.push(event)
							if (event.type === "agent.spawn") {
								spawnedPid = event.pid
								throw new Error("spawn observability failed")
							}
						},
					} : {}),
				}))

				expect(tick.spawnedRuns, stage).toHaveLength(0)
				const run = fixture.store.getRunByRunId(runId)
				expect(run?.endedAt, stage).toBe(now)
				expect(run?.exitCode, stage).toBe(1)
				if (stage !== "artifact") {
					const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
					const status = RunStatusFixtureBoundary.assert(JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")))
					expect(status.endedAt, stage).toBe(now)
					expect(status.exitCode, stage).toBe(1)
					expect(status.status, stage).toBe("queued")
				}
				expect(fixture.store.getCurrentRun(chain.id), stage).toBeNull()
				expect(fixture.state.slots.get(`${chain.id}\u0000/repo/a`)?.activeRun, stage).toBeNull()
				const failedItem = fixture.store.getItem(item.id)
				expect(failedItem?.extra.schedulerSpawnError, stage).toMatchObject({
					at: now,
					attribution: { kind: "phase", phase: "iteration" },
				})
				expect(failedItem?.extra.schedulerBackoff, stage).toMatchObject({ failureCount: 1, nextRunAt: now + 60 })
				expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted"), stage).toHaveLength(1)
				if (stage === "process-spawn") expect(revoked).toBe(1)
				if (stage === "active-child") {
					expect(revoked).toBeGreaterThan(0)
					expect(spawnedPid).not.toBeNull()
					if (spawnedPid !== null) expect(() => process.kill(spawnedPid!, 0)).toThrow()
				}
			} finally {
				await stopFixture(fixture)
			}
		}
	})

	test("chain preparation failure does not starve sibling chain", async () => {
		const fixture = await createFixture("chain-preparation-containment")
		try {
			const presetFailureChain = createChain(fixture.store, "chain-plan-failure")
			const runnerFailureChain = createChain(fixture.store, "chain-runner-failure")
			const healthyChain = createChain(fixture.store, "chain-healthy")
			const presetFailureItem = createItem(fixture.store, presetFailureChain, { issueNumber: 535_201, repoCwd: "/repo/a" })
			const runnerFailureItem = createItem(fixture.store, runnerFailureChain, { issueNumber: 535_202, repoCwd: "/repo/b" })
			const healthyItem = createItem(fixture.store, healthyChain, { issueNumber: 535_203, repoCwd: "/repo/c", writeStatus: "done" })
			const base = fixture.options({ now: () => 1_900_535_200 })
			const tick = await schedulerTick({
				...base,
				presetForChain: (chain) => {
					if (chain.id === presetFailureChain.id) throw new Error("chain preset parse failed")
					return base.presetForChain(chain)
				},
				phaseRunner: ({ chain }) => {
					if (chain.id === runnerFailureChain.id) throw new Error("chain runner parse failed")
					if (base.runner === undefined) throw new Error("fixture runner missing")
					return base.runner
				},
			})

			expect(tick.spawnedRuns.map((run) => run.itemId)).toEqual([healthyItem.id])
			await tick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(presetFailureItem.id)?.extra.schedulerSpawnError).toMatchObject({
				attribution: { kind: "chain-plan" },
				message: "chain preset parse failed",
			})
			expect(fixture.store.getItem(runnerFailureItem.id)?.extra.schedulerSpawnError).toMatchObject({
				attribution: { kind: "phase", phase: "iteration" },
				message: "chain runner parse failed",
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("contained spawn failure releases repo scheduling", async () => {
		const fixture = await createFixture("contained-spawn-releases-repo")
		try {
			const chain = createChain(fixture.store, "contained-spawn-releases-repo-chain")
			const failed = createItem(fixture.store, chain, { issueNumber: 535_301, repoCwd: "/repo/a" })
			const sibling = createItem(fixture.store, chain, { issueNumber: 535_302, repoCwd: "/repo/a", writeStatus: "done" })
			const base = fixture.options({
				now: () => 1_900_535_300,
				prompt: (context) => {
					if (context.item.id === failed.id) throw new Error("first sibling prompt failed")
					return "{}"
				},
			})

			const failedTick = await schedulerTick(base)
			expect(failedTick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.state.slots.get(`${chain.id}\u0000/repo/a`)?.activeRun).toBeNull()
			expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted" && event.itemId === failed.id)).toHaveLength(1)

			const siblingTick = await schedulerTick(base)
			expect(siblingTick.spawnedRuns.map((run) => run.itemId)).toEqual([sibling.id])
			await siblingTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
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
			await stopFixture(fixture)
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
			const current = fixture.store.getCurrentRun(chain.id)
			expect(current?.extra).toMatchObject({
				itemId: firstTick.spawnedRuns[0]?.itemId,
				pid: firstTick.spawnedRuns[0]?.pid,
				startStatus: "queued",
				startAttempts: 0,
			})
			expect(fixture.store.getRunByRunId(firstTick.spawnedRuns[0]!.runId)?.extra).toMatchObject({ startStatus: "queued", startAttempts: 0 })
			expect(fixture.schedulerEvents.some((event) => event.type === "slot.busy")).toBe(true)
			expect(fixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["queued", "queued"])
			await firstTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("advance after terminal", async () => {
		const fixture = await createFixture("advance")
		try {
			const chain = createChain(fixture.store, "advance-chain")
			const first = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 10, writeStatus: "done" })
			const second = createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 10, writeStatus: "done" })

			const firstTick = await schedulerTick(fixture.options())
			await firstTick.spawnedRuns[0]!.closed
			const secondTick = await schedulerTick(fixture.options())

			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(first.id)?.status).toBe("done")
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("chain completion", async () => {
		const fixture = await createFixture("completion")
		try {
			const chain = createChain(fixture.store, "completion-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", writeStatus: "done" })

			await runSchedulerUntilIdle(persistedObservabilityOptions(fixture))

			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(true)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("completed chain worktree cleanup is idempotent after prior removal", async () => {
		const fixture = await createFixture("completion-cleanup-idempotent")
		const target = resolve(fixture.loopDataRoot, "..", "target")
		await initGitTarget(target)
		try {
			const chain = createChain(fixture.store, "completion-cleanup-idempotent-chain")
			createItem(fixture.store, chain, { issueNumber: 351_001, repoCwd: target, writeStatus: "done" })

			await runSchedulerUntilIdle(fixture.options({
				worktreeManager: createGitWorktreeManager({ loopDataRoot: fixture.loopDataRoot }),
			}))

			const completed = fixture.store.getChain(chain.id)
			if (completed === null) throw new Error("expected completed chain")
			const worktreePath = schedulerSlotWorktreePath(completed, target, { loopDataRoot: fixture.loopDataRoot })
			expect(completed.status).toBe("completed")
			expect(existsSync(worktreePath)).toBe(false)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)

			const repeated = cleanupSchedulerChainWorktrees(completed, [target], { loopDataRoot: fixture.loopDataRoot })
			expect(repeated).toHaveLength(1)
			expect(repeated[0]).toMatchObject({
				repoCwd: target,
				worktreePath,
				registered: false,
				removed: false,
				pruned: true,
				error: null,
			})
			expect(existsSync(worktreePath)).toBe(false)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("chain-complete trigger runs before chain completion", async () => {
		const fixture = await createFixture("completion-trigger")
		try {
			const chain = createChain(fixture.store, "completion-trigger-chain")
			createItem(fixture.store, chain, { issueNumber: 2691, repoCwd: "/repo/a", writeStatus: "done" })
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
				"recycle.pending_entered",
				"recycle.natural_exit",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.complete_trigger",
				"chain.completed",
			])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("chain-complete trigger does not run twice during overlapping completion ticks", async () => {
		const fixture = await createFixture("completion-trigger-overlap")
		try {
			const chain = createChain(fixture.store, "completion-trigger-overlap-chain")
			createItem(fixture.store, chain, { issueNumber: 2696, repoCwd: "/repo/a", writeStatus: "done" })
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
			await stopFixture(fixture)
		}
	})

	test("chain-complete trigger can keep chain active", async () => {
		const fixture = await createFixture("completion-trigger-active")
		try {
			const chain = createChain(fixture.store, "completion-trigger-active-chain")
			createItem(fixture.store, chain, { issueNumber: 2692, repoCwd: "/repo/a", writeStatus: "done" })
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
			fixture.store.updateItem(followUp.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_999 })
			const thirdTick = await schedulerTick(options)
			expect(thirdTick.spawnedRuns).toHaveLength(0)
			expect(thirdTick.completedChainIds).toEqual([])
			expect(triggerCalls).toBe(2)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger")).toHaveLength(2)
		} finally {
			await stopFixture(fixture)
		}

		const followUpFixture = await createFixture("completion-trigger-follow-up")
		try {
			const chain = createChain(followUpFixture.store, "completion-trigger-follow-up-chain")
			createItem(followUpFixture.store, chain, { issueNumber: 2693, repoCwd: "/repo/a", writeStatus: "done" })

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
			await stopFixture(followUpFixture)
		}

		const failingFixture = await createFixture("completion-trigger-failing")
		try {
			const chain = createChain(failingFixture.store, "completion-trigger-failing-chain")
			createItem(failingFixture.store, chain, { issueNumber: 2695, repoCwd: "/repo/a", writeStatus: "done" })

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
			await stopFixture(failingFixture)
		}
	})

	test("manual terminal item update completes chain on next tick", async () => {
		const fixture = await createFixture("manual-terminal-completion")
		try {
			const chain = createChain(fixture.store, "manual-terminal-completion-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 249, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_500 })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents).toContainEqual({ type: "chain.completed", chainId: chain.id, chainName: chain.name })
		} finally {
			await stopFixture(fixture)
		}
	})

	test("terminated child preserves user terminal item status", async () => {
		const fixture = await createFixture("terminal-preserve")
		try {
			const chain = createChain(fixture.store, "terminal-preserve-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 5_000 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")

			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_500 })
			const closed = await tick.spawnedRuns[0]!.terminate({ forceAfterMs: 200 })

			expect(closed.exitCode).toBe(1)
			expect(closed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
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
			await stopFixture(fixture)
		}
	})

	test("empty preset success statuses do not fall back to done for dependency unblock", async () => {
		const fixture = await createFixture("empty-success-statuses")
		const presetDir = resolve(fixture.loopDataRoot, "..", "empty-success-preset")
		await writeEmptySuccessPreset(presetDir)
		try {
			const chain = createChain(fixture.store, "empty-success-statuses-chain", { preset: "empty-success" })
			const target = createItem(fixture.store, chain, { issueNumber: 710_001, repoCwd: "/repo/a" })
			const dependent = createItem(fixture.store, chain, { issueNumber: 710_002, repoCwd: "/repo/a" })
			fixture.store.updateItem(target.id, { status: runtimeStatus("done"), updatedAt: 1_800_710_001 })
			fixture.store.updateItem(dependent.id, {
				status: runtimeStatus("blocked"),
				extra: storedItemExtra({ ...itemExtraToJsonObject(dependent.extra), dependsOn: [target.id] }),
				updatedAt: 1_800_710_002,
			})

			const tick = await schedulerTick(fixture.options({ loadedPreset: await loadedPresetFromDir(presetDir) }))

			expect(tick.spawnedRuns).toHaveLength(0)
			const unchanged = fixture.store.getItem(dependent.id)
			expect(unchanged?.status).toBe("blocked")
			expect(unchanged?.extra.dependsOn).toEqual([target.id])
			expect(fixture.schedulerEvents.find((event) => event.type === "item.dependency_unblocked")).toBeUndefined()
		} finally {
			await stopFixture(fixture)
		}
	})

	// #402: replaces "maxItemAttempts does not write exhausted unless the preset declares it terminal".
	// That assertion pinned the OLD opt-out behavior (preset terminal vocabulary omits "exhausted" →
	// engine silently disables the transition). D2 verdict retired the opt-out: a preset that does not
	// declare `statuses.exhausted` must fail to load with an explicit error.
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
			await stopFixture(fixture)
		}
	})

	test("stopped chain skipped", async () => {
		const fixture = await createFixture("stopped-skip")
		try {
			const chain = createChain(fixture.store, "stopped-chain", { status: "stopped" })
			const item = createItem(fixture.store, chain, { issueNumber: 349_001, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([])
			expect(fixture.state.slots.size).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
			expect(fixture.store.getChain(chain.id)?.status).toBe("stopped")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("resumed stopped chain is schedulable again", async () => {
		const fixture = await createFixture("stopped-resume")
		try {
			const chain = createChain(fixture.store, "stopped-resume-chain", { status: "stopped" })
			const item = createItem(fixture.store, chain, { issueNumber: 349_002, repoCwd: "/repo/a" })

			const stoppedTick = await schedulerTick(fixture.options())
			expect(stoppedTick.spawnedRuns).toHaveLength(0)

			fixture.store.updateChain(chain.id, { status: "active", updatedAt: 1_800_034_900 })
			const resumedTick = await schedulerTick(fixture.options())

			expect(resumedTick.spawnedRuns).toHaveLength(1)
			expect(resumedTick.spawnedRuns[0]?.itemId).toBe(item.id)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
			await resumedTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
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
			await stopFixture(fixture)
		}
	})

	test("real subprocess spawn end-to-end", async () => {
		const fixture = await createFixture("subprocess")
		try {
			const chain = createChain(fixture.store, "subprocess-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", writeStatus: "done" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(closed.exitCode).toBe(0)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(closed.runId), "utf-8")).toContain(`done:${item.id}`)
			expect(fixture.store.getRunByRunId(closed.runId)?.exitCode).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect((await readRunnerEvents(fixture.eventLogForChain(chain.name))).map((event) => event.type)).toEqual(["start", "end"])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("streams scheduler runner output without retaining full history", async () => {
		const fixture = await createFixture("streamed-runner-output")
		try {
			const runnerPath = resolve(fixture.loopDataRoot, "..", "large-output-runner.ts")
			await writeFile(runnerPath, [
				'process.stdout.write(JSON.stringify({ type: "system", session_id: "session-large" }) + "\\n")',
				'for (let i = 0; i < 200_000; i++) process.stdout.write(`stdout-${i}\\n`)',
				'for (let i = 0; i < 100_000; i++) process.stderr.write(`stderr-${i}\\n`)',
			].join("\n"))
			const chain = createChain(fixture.store, "streamed-runner-output-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 630_001, repoCwd: "/repo/a" })
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [runnerPath], model: null },
			}))
			const closed = await tick.spawnedRuns[0]!.closed
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(paths.runStdoutFile(closed.runId))
			const stderr = await readFile(paths.runStderrFile(closed.runId))
			expect(closed.stdoutBytes).toBe(stdout.byteLength)
			expect(closed.stderrBytes).toBe(stderr.byteLength)
			expect(stdout.toString()).toContain("stdout-199999")
			expect(stderr.toString()).toContain("stderr-99999")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("session-large")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("scheduler run writes run-root artifacts", async () => {
		const fixture = await createFixture("run-artifacts")
		try {
			const chain = createChain(fixture.store, "run-artifacts-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 203, repoCwd: "/repo/a", writeStatus: "done" })

			await runSchedulerUntilIdle(persistedObservabilityOptions(fixture))

			// #405: runIdFactory is now phase-aware (`run-<chainId>-<itemId>-<phase>-<attempt>`)
			// so a single iteration run on a fresh item yields attempt 1 of the iteration phase.
			const runId = `run-${chain.id}-${item.id}-iteration-1`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const status = RunStatusFixtureBoundary.assert(JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")))
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const phaseStdout = await readFile(paths.runPhaseStdoutFile(runId, "iteration"), "utf-8")
			const phaseStderr = await readFile(paths.runPhaseStderrFile(runId, "iteration"), "utf-8")
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: runId })

			expect(status).toMatchObject({
				runId,
				chainId: chain.id,
				chainName: chain.name,
				// #419: split rowid (`rowId`) and opaque preset id (`itemId`). Was `itemId: rowid`
				// and `issueNumber: int` pre-#419.
				rowId: item.id,
				itemId: "203",
				phase: "iteration",
				exitCode: 0,
				status: runtimeStatus("done"),
			})
			expect(stdout).toContain(`done:${item.id}`)
			expect(stderr).toBe("")
			expect(phaseStdout).toContain(`done:${item.id}`)
			expect(phaseStderr).toBe("")
			expect(status.eventsPath).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(existsSync(paths.runEventsFile(runId))).toBe(false)
			expect(events.events.map((event) => event.type)).toEqual([
				"agent.spawn",
				"phase.start",
				"item.mutation.caller_admission",
				"item.update.field_write_admission",
				"item.status",
				"recycle.pending_entered",
				"recycle.natural_exit",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.completed",
			])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("scheduler emits phase.start / phase.end / queue.terminal with the expected payload", async () => {
		const fixture = await createFixture("phase-events")
		try {
			const chain = createChain(fixture.store, "phase-events-chain")
			// #405: pin iteration's write to `done` so the test's "single phase event run"
			// assertion stays single. Previously the retired verdict mapper coincidentally
			// landed iteration at done via the default REVIEW SUMMARY token; explicitly
			// requesting it via `writeStatus` is the principled mirror under the new model.
			const item = createItem(fixture.store, chain, { issueNumber: 286, repoCwd: "/repo/a", writeStatus: "done" })

			await runSchedulerUntilIdle(persistedObservabilityOptions(fixture))

			const runId = `run-${chain.id}-${item.id}-iteration-1`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			expect(existsSync(paths.runEventsFile(runId))).toBe(false)
			const persisted = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: runId })
			const persistedTypes = persisted.events.map((event) => event.type)

			const phaseStartEvents = persisted.events.filter((event) => event.type === "phase.start")
			const phaseEndEvents = persisted.events.filter((event) => event.type === "phase.end")
			const queueTerminalEvents = persisted.events.filter((event) => event.type === "queue.terminal")

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
				chain: chain.name,
				item: item.id,
				phase: "iteration",
				payload: { repoCwd: "/repo/a" },
			})
			expect(typeof phaseStart.ts).toBe("string")
			expect(Number.isFinite(Date.parse(phaseStart.ts))).toBe(true)
			expect(phaseStart.payload.pid).toEqual(expect.any(Number))

			expect(phaseEnd).toMatchObject({
				type: "phase.end",
				runId,
				chain: chain.name,
				item: item.id,
				phase: "iteration",
				payload: { exitCode: 0, status: runtimeStatus("done") },
			})
			expect(typeof phaseEnd.ts).toBe("string")
			expect(Number.isFinite(Date.parse(phaseEnd.ts))).toBe(true)
			expect(phaseEnd.payload.durationSeconds).toBeGreaterThanOrEqual(0)

			expect(queueTerminal).toMatchObject({
				type: "queue.terminal",
				runId,
				chain: chain.name,
				item: item.id,
				payload: { terminalStatus: "done" },
			})
			expect(typeof queueTerminal.ts).toBe("string")
			expect(Number.isFinite(Date.parse(queueTerminal.ts))).toBe(true)

			expect(persistedTypes.filter((type) => type === "phase.start")).toHaveLength(1)
			expect(persistedTypes.filter((type) => type === "phase.end")).toHaveLength(1)
			expect(persistedTypes.filter((type) => type === "queue.terminal")).toHaveLength(1)
			expect(persistedTypes.indexOf("phase.start")).toBeGreaterThan(persistedTypes.indexOf("agent.spawn"))
			expect(persistedTypes.indexOf("phase.end")).toBeGreaterThan(persistedTypes.indexOf("agent.exit"))
			expect(persistedTypes.indexOf("queue.terminal")).toBeGreaterThan(persistedTypes.indexOf("phase.end"))
		} finally {
			await stopFixture(fixture)
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
			await stopFixture(fixture)
		}
	})

	// #462: a runner that never writes to stdout (the run-1781258195574-6 zero-output hang
	// shape) must be reclaimed at the startup idle threshold, well before the absolute
	// attempt-timeout floor would burn the rest of the budget. The kill keeps the existing
	// "attempt counted, item stays at entry status" retry semantics so the scheduler can
	// respawn on the next tick without operator intervention.
})
describe("scheduler reads the agent-written item status (v1 status model)", () => {
	test("a terminal status the agent writes is recorded as the item's truth", async () => {
		const fixture = await createFixture("status-agent-terminal")
		try {
			const chain = createChain(fixture.store, "status-agent-terminal-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 5002,
				repoCwd: "/repo/a",
				// #405: previously the test drove the agent's status decision via a
				// `REVIEW SUMMARY: verdict=skip` stdout token parsed by the retired
				// `parseReviewSummaryVerdict` consumer. The fake runner now writes the
				// status directly via `extra.writeStatus`, mirroring the real agent's
				// `coder-loop item update --status` write through the typed phase-exits face.
				writeStatus: "moot",
			})

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("moot")
			expect(fixture.store.getItem(item.id)?.status).toBe("moot")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("an iteration summary leaves the item continuable through phase order", async () => {
		const fixture = await createFixture("status-agent-in-progress")
		try {
			const chain = createChain(fixture.store, "status-agent-in-progress-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 5003,
				repoCwd: "/repo/a",
				summary: "ITERATION SUMMARY: scope=unit; reason=mid-phase",
			})

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("queued")
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("when the agent writes no status the item keeps its entry status", async () => {
		const fixture = await createFixture("status-agent-silent")
		try {
			const chain = createChain(fixture.store, "status-agent-silent-chain")
			// summary:null makes the fake runner write nothing, modelling an agent that exits without
			// calling `coder-loop item update`. The scheduler must not invent a terminal status.
			const item = createItem(fixture.store, chain, { issueNumber: 5001, repoCwd: "/repo/a", summary: null })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("queued")
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("the scheduler records the written status even when stdout carries a different SUMMARY verdict", async () => {
		const fixture = await createFixture("status-agent-over-stdout")
		try {
			const chain = createChain(fixture.store, "status-agent-over-stdout-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 5005, repoCwd: "/repo/a" })

			// The agent prints a verdict=retry SUMMARY line (which the deleted v2 inference would have
			// mapped to changes_requested) but writes `done` to the store. v1 reads the written status.
			const tick = await schedulerTick(fixture.options({
				prompt: ({ chain: c, item: i, runId, worktreePath }) =>
					JSON.stringify({
						itemId: i.id,
						issueNumber: Number(i.itemId),
						chainName: c.name,
						runId,
						worktreePath,
						eventLog: fixture.eventLogForChain(c.name),
						sleepMs: 5,
						exitCode: 0,
						summary: "REVIEW SUMMARY: verdict=retry; issue=#5005; reason=stdout-would-retry",
						writeStatus: "done",
					}),
			}))
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(closed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("an item the agent keeps marking changes_requested is re-spawned across ticks", async () => {
		const fixture = await createFixture("status-respawn")
		try {
			const chain = createChain(fixture.store, "status-respawn-chain")
			// #405: the agent writes changes_requested each run, so the item stays pending and is
			// re-selected for iteration on the next tick (no exit-code backoff gate, since exit is 0).
			// Previously the test drove this via a `REVIEW SUMMARY: verdict=retry` stdout token; the
			// fake runner now writes the status directly via `extra.writeStatus`.
			const item = createItem(fixture.store, chain, {
				issueNumber: 5004,
				repoCwd: "/repo/a",
				writeStatus: "changes_requested",
			})

			let runCounter = 0
			const options: SchedulerOptions = {
				...fixture.options(),
				runIdFactory: () => `run-respawn-${++runCounter}`,
			}

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			await firstTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")

			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			await secondTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.attempts).toBe(1)
			expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")
		} finally {
			await stopFixture(fixture)
		}
	})
})


describe("scheduler session-id resume (issue #291 / #311)", () => {
	test("selectNextPendingItemFromSnapshot ignores priority, follows queue position (issue #339 AC1)", () => {
		const chain = makeChainFixture()
		const firstNoPriority = makeItemFixture(chain, { id: 1, issueNumber: 339_001, repoCwd: "/repo/order", position: 0, priority: null })
		const laterCritical = makeItemFixture(chain, { id: 2, issueNumber: 339_002, repoCwd: "/repo/order", position: 1, priority: "critical" })
		const selected = selectNextPendingItemFromSnapshot({
			items: [laterCritical, firstNoPriority],
			repoCwd: "/repo/order",
			statuses: [runtimeStatus("queued")],
			terminalStatuses: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			now: 1_800_000_100,
		})
		expect(selected?.id).toBe(firstNoPriority.id)
	})

	test("selectNextPendingItemFromSnapshot returns the item reordered to position 0 (issue #339 AC3)", () => {
		const chain = makeChainFixture()
		const formerHead = makeItemFixture(chain, { id: 1, issueNumber: 339_011, repoCwd: "/repo/reorder", position: 1 })
		const reorderedToHead = makeItemFixture(chain, { id: 3, issueNumber: 339_013, repoCwd: "/repo/reorder", position: 0 })
		const middle = makeItemFixture(chain, { id: 2, issueNumber: 339_012, repoCwd: "/repo/reorder", position: 2 })
		const selected = selectNextPendingItemFromSnapshot({
			items: [formerHead, reorderedToHead, middle],
			repoCwd: "/repo/reorder",
			statuses: [runtimeStatus("queued")],
			terminalStatuses: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
			now: 1_800_000_100,
		})
		expect(selected?.id).toBe(reorderedToHead.id)
	})

})
