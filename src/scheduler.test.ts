import { afterAll, describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
	cleanupSchedulerChainWorktrees,
	createGitWorktreeManager,
	createSchedulerState,
	DEFAULT_MAX_ITEM_ATTEMPTS,
	listActiveRuns,
	listPendingCloseHandlers,
	makeRunId,
	markRunPendingRecycle,
	renderSchedulerSpawnPrompt,
	refreshExternalTerminalAvailabilityForItem,
	resumeDecisionForItem,
	runSchedulerUntilIdle,
	schedulerSlotWorktreePath,
	schedulerTick,
	selectNextPendingItemFromSnapshot,
	type SchedulerEvent,
	type SchedulerLifecycleEventPersistenceFailure,
	type SchedulerLoadedPreset,
	type SchedulerOptions,
	type SchedulerPhaseRunner,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { schedulerEventToObservabilityEvent, startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"
import {
	buildPhaseRunnerSelectionFromChain,
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
	loadPreset,
	resolvePhaseRunnerFromChain,
	runPresetChainCompleteTriggerPhases,
	substitutePresetRootToken,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type JsonObject,
} from "./loop"
import { resolveChainRuntimePaths, resolveLoopDataPaths } from "./runtime-paths"
import { type ChainRecord, type ItemRecord, openSqliteStateStore } from "./sqlite-state"
import { appendObservabilityEvent, queryObservabilityEvents } from "./observability"
import { chainMetadataToJsonObject, engineLifecycleAdmittedItemStatus, itemExtraJsonValue, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"
import type { BoundaryRecord } from "./boundary-types"

const REPO_ROOT = resolve(import.meta.dir, "..")
type PromptSessionRunnerKind = Exclude<AgentRunnerKind, "hapi">

function runnerAuthorizationForTest(agentCwd: string, presetDir: string, loopDataRoot: string) {
	return buildRunnerFilesystemAuthorization({
		agentCwd, presetDir, loopDataRoot,
		sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"), currentIssueFile: "",
		issueDir: resolve(loopDataRoot, "chains/c/issues"), evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"),
		evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"), logDir: resolve(loopDataRoot, "chains/c/runs"),
		daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
		declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
	})
}
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests", String(process.pid))

let nextFixtureId = 0
const fixtureDaemons = new Set<CoderLoopDaemon>()
const fixturePresetDirs = new WeakMap<ReturnType<typeof openSqliteStateStore>, string>()
const fixtureCaptureRoots = new WeakMap<ReturnType<typeof openSqliteStateStore>, string>()

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

afterAll(async () => {
	await Promise.all([...fixtureDaemons].map((daemon) => daemon.stop()))
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("scheduler", () => {
	test("runner projections reach scheduler fresh and resume paths for every runner", async () => {
		for (const kind of ["claude", "codex", "opencode"] as const satisfies readonly PromptSessionRunnerKind[]) {
			for (const resume of [false, true]) {
				const fixture = await createFixture(`runner-projection-${kind}-${resume ? "resume" : "fresh"}`)
				try {
					const chain = createChain(fixture.store, `runner-projection-${kind}-${resume ? "resume" : "fresh"}-chain`)
					const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
					await mkdir(chainPaths.evidenceDir, { recursive: true })
					const captureArgv = resolve(chainPaths.evidenceDir, `${kind}-${resume ? "resume" : "fresh"}.argv.json`)
					const item = createItem(fixture.store, chain, { issueNumber: 601_000 + (resume ? 1 : 0), repoCwd: "/repo/a", runner: kind, captureArgv, probeNullDevice: true })
					if (resume) fixture.store.updateItem(item.id, { sessionIds: { iteration: { [kind]: `scheduler-resume-${kind}` } } })
					const tick = await schedulerTick(fixture.options({
						runner: { kind, source: "queue", binary: fixture.fakeRunner, extraArgs: [], model: null },
					}))
					expect(tick.spawnedRuns).toHaveLength(1)
					expect((await tick.spawnedRuns[0]!.closed).exitCode).toBe(0)
					const argv = await readFile(captureArgv, "utf8")
					expect(argv).toContain(resume ? `scheduler-resume-${kind}` : "601000")
					const projected: unknown = JSON.parse(argv)
					if (!Array.isArray(projected) || !projected.every((value) => typeof value === "string")) throw new Error("captured scheduler argv must be a string array")
					const fixturePresetDir = fixturePresetDirs.get(fixture.store)
					if (fixturePresetDir === undefined) throw new Error("scheduler fixture must retain its preset directory")
					expect(projected).not.toContain(fixture.loopDataRoot)
					expect(projected).not.toContain("/dev/null")
					const authorizationEvidencePath = resolve(chainPaths.runPhaseDir(tick.spawnedRuns[0]!.runId, "iteration"), "runner-authorization.json")
					const authorizationEvidence = await readFile(authorizationEvidencePath, "utf8")
					expect(authorizationEvidence).toContain('"outerSandboxProfile"')
					expect(authorizationEvidence).toContain(`"runner":"${kind}"`)
					expect(authorizationEvidence).toContain(`(require-not (subpath \\"${fixture.loopDataRoot}\\"))`)
					expect(authorizationEvidence).not.toContain(`"path":"${fixture.loopDataRoot}"`)
					if (kind === "claude") {
						expect(projected).toContain(fixturePresetDir)
						expect(projected).toContain(chainPaths.evidenceDir)
					}
					if (kind === "codex" && !resume) {
						expect(projected).toContain(chainPaths.evidenceDir)
						expect(projected).toContain(chainPaths.issuesDir)
						expect(projected).toContain(chainPaths.runsDir)
						expect(projected).not.toContain(fixturePresetDir)
					}
				} finally {
					await stopFixture(fixture)
				}
			}
		}
	})

	test("rejects successful scheduler completion when terminal persistence fails", async () => {
		const fixture = await createFixture("terminal-persistence-failure")
		try {
			const chain = createChain(fixture.store, "terminal-persistence-failure-chain")
			createItem(fixture.store, chain, { issueNumber: 6352, repoCwd: "/repo/a", sleepMs: 200, writeStatus: "done" })
			const failures: import("./loop").RunnerStatusPersistenceFailure[] = []
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
	test("legacy scheduler spawn diagnostic shape is rejected", () => {
		expect(() => storedItemExtra({
			schedulerSpawnError: {
				at: 1_900_535_000,
				phase: "iteration",
				message: "legacy diagnostic",
			},
		})).toThrow(/schedulerSpawnError\.attribution/)
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
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80, writeStatus: "done" })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/b", sleepMs: 80, writeStatus: "done" })

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
						runner: { kind: "claude", source: "iteration-default", binary: resolve(fixture.loopDataRoot, "missing-runner"), extraArgs: [], model: null } as AgentRunnerSelection,
					} : {}),
					...(stage === "active-child" ? {
						runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [activeChildRunner], model: null } as AgentRunnerSelection,
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
					const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as BoundaryRecord
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

	test("external-terminal chain-complete trigger is probed before trigger side effects", async () => {
		const fixture = await createFixture("external-terminal-chain-complete-gate")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "69")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const chain = createChain(fixture.store, "external-terminal-chain-complete-gate-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_003, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_500 })
			let triggerCalls = 0
			const tick = await schedulerTick(fixture.options({
				phaseRunner: () => ({ kind: "hapi", source: "preset", binary, extraArgs: [], model: null }),
				chainCompleteTrigger: () => { triggerCalls += 1; return { decision: "complete" } },
			}))
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(triggerCalls).toBe(0)
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(fixture.worktreeCalls).toHaveLength(0)
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "runner.external_terminal_unavailable", phase: "umbrella-finalizer", runner: "hapi", rowId: item.id,
			}))
			await schedulerTick(fixture.options({
				phaseRunner: () => ({ kind: "hapi", source: "preset", binary, extraArgs: [], model: null }),
				chainCompleteTrigger: () => { triggerCalls += 1; return { decision: "complete" } },
			}))
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")).toHaveLength(1)
			await writeFile(probeState, "0")
			await schedulerTick(fixture.options({
				phaseRunner: () => ({ kind: "hapi", source: "preset", binary, extraArgs: [], model: null }),
				chainCompleteTrigger: () => { triggerCalls += 1; return { decision: "complete" } },
			}))
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.availability_restored")).toHaveLength(1)
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(triggerCalls).toBe(1)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("endpoint restoration clears stopped-chain holds before a new loss transition", async () => {
		const fixture = await createFixture("external-terminal-cross-chain-hold-epoch")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "69")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const stoppedChain = createChain(fixture.store, "external-terminal-stopped-held-chain")
			const activeChain = createChain(fixture.store, "external-terminal-active-held-chain")
			const stoppedItem = createItem(fixture.store, stoppedChain, { issueNumber: 602_017, repoCwd: "/repo/stopped" })
			const activeItem = createItem(fixture.store, activeChain, { issueNumber: 602_018, repoCwd: "/repo/active" })
			const options = fixture.options({ runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null } })

			expect(await refreshExternalTerminalAvailabilityForItem(options, stoppedChain, stoppedItem, "iteration")).toBe(false)
			expect(await refreshExternalTerminalAvailabilityForItem(options, activeChain, activeItem, "iteration")).toBe(false)
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")).toHaveLength(1)
			fixture.store.updateChain(stoppedChain.id, { status: "stopped", updatedAt: 1_900_602_017 })

			await writeFile(probeState, "0")
			expect(await refreshExternalTerminalAvailabilityForItem(options, activeChain, activeItem, "iteration")).toBe(true)
			expect(fixture.store.getItem(stoppedItem.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.store.getItem(activeItem.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.availability_restored")).toHaveLength(1)

			await writeFile(probeState, "69")
			expect(await refreshExternalTerminalAvailabilityForItem(options, activeChain, activeItem, "iteration")).toBe(false)
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")).toHaveLength(2)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("mixed presets gate an external-terminal chain-complete runner even when the representative item preset is local", async () => {
		const fixture = await createFixture("mixed-preset-chain-complete-chain-external")
		try {
			const missingBinary = resolve(fixture.loopDataRoot, "..", "missing-external-terminal")
			const chain = createChain(fixture.store, "mixed-preset-chain-complete-chain-external-chain", {
				metadata: { hapi: { binary: missingBinary } },
			})
			const item = createItem(fixture.store, chain, { issueNumber: 602_004, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_500 })
			const base = fixture.options()
			const { runner: _fixtureRunner, ...baseWithoutRunner } = base
			const loadedPreset = await base.presetForChain(chain)
			const chainPreset: SchedulerLoadedPreset = {
				...loadedPreset,
				preset: {
					...loadedPreset.preset,
					name: "chain-external-terminal",
					phases: loadedPreset.preset.phases.map((phase) => phase.trigger !== null && "on" in phase.trigger
						? { ...phase, defaultRunner: "hapi" }
						: phase),
				},
			}
			const itemPreset: SchedulerLoadedPreset = {
				...loadedPreset,
				preset: { ...loadedPreset.preset, name: "item-local-process" },
			}
			let triggerCalls = 0
			await schedulerTick({
				...baseWithoutRunner,
				presetForChain: () => chainPreset,
				presetForItem: () => itemPreset,
				phaseRunnerSelectionForChain: () => buildPhaseRunnerSelectionFromChain({ chain, loopDataRoot: fixture.loopDataRoot, preset: chainPreset.preset }),
				phaseRunnerSelectionForItem: () => buildPhaseRunnerSelectionFromChain({ chain, loopDataRoot: fixture.loopDataRoot, preset: itemPreset.preset }),
				chainCompleteTrigger: () => { triggerCalls += 1; return { decision: "complete" } },
			})

			expect(triggerCalls).toBe(0)
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toMatchObject({ runner: "hapi", phase: "umbrella-finalizer" })
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "runner.external_terminal_unavailable", runner: "hapi", rowId: item.id,
			}))
		} finally {
			await stopFixture(fixture)
		}
	})

	test("mixed presets do not hold a local chain-complete runner for the representative item's external terminal", async () => {
		const fixture = await createFixture("mixed-preset-chain-complete-chain-local")
		try {
			const missingBinary = resolve(fixture.loopDataRoot, "..", "missing-external-terminal")
			const chain = createChain(fixture.store, "mixed-preset-chain-complete-chain-local-chain", {
				metadata: { hapi: { binary: missingBinary } },
			})
			const item = createItem(fixture.store, chain, { issueNumber: 602_005, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_500 })
			const base = fixture.options()
			const { runner: _fixtureRunner, ...baseWithoutRunner } = base
			const loadedPreset = await base.presetForChain(chain)
			const chainPreset: SchedulerLoadedPreset = {
				...loadedPreset,
				preset: { ...loadedPreset.preset, name: "chain-local-process" },
			}
			const itemPreset: SchedulerLoadedPreset = {
				...loadedPreset,
				preset: {
					...loadedPreset.preset,
					name: "item-external-terminal",
					phases: loadedPreset.preset.phases.map((phase) => phase.trigger !== null && "on" in phase.trigger
						? { ...phase, defaultRunner: "hapi" }
						: phase),
				},
			}
			let triggerCalls = 0
			await schedulerTick({
				...baseWithoutRunner,
				presetForChain: () => chainPreset,
				presetForItem: () => itemPreset,
				phaseRunnerSelectionForChain: () => buildPhaseRunnerSelectionFromChain({ chain, loopDataRoot: fixture.loopDataRoot, preset: chainPreset.preset }),
				phaseRunnerSelectionForItem: () => buildPhaseRunnerSelectionFromChain({ chain, loopDataRoot: fixture.loopDataRoot, preset: itemPreset.preset }),
				chainCompleteTrigger: () => { triggerCalls += 1; return { decision: "complete" } },
			})

			expect(triggerCalls).toBe(1)
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.schedulerEvents.some((event) => event.type === "runner.external_terminal_unavailable")).toBe(false)
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
			// SIGTERM kills the agent mid-run, so it never writes a status; the item keeps its entry status.
			expect(terminated.status).toBe("queued")
			expect(fixture.store.getItem(first.id)?.attempts).toBe(1)
			expect(fixture.store.getItem(second.id)?.attempts).toBe(0)

			// Model the daemon's stale-recovery: a killed item is reset to a backoff-gated continuable
			// status so the untouched sibling gets the next turn.
			// Omit `extra` to preserve the spawn-failure backoff applied on termination.
			fixture.store.updateItem(first.id, { status: runtimeStatus("changes_requested"), phase: null, updatedAt: 1_800_000_700 })

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItem(second.id)?.attempts).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn").map((event) => event.itemId)).toEqual([first.id, second.id])
		} finally {
			await stopFixture(fixture)
		}
	})

	test("default maxItemAttempts exhausts a continuable item at twenty attempts before spawning", async () => {
		const fixture = await createFixture("default-max-item-attempts-exhaust")
		try {
			expect(DEFAULT_MAX_ITEM_ATTEMPTS).toBe(20)
			const chain = createChain(fixture.store, "default-max-item-attempts-exhaust-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 7008, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("changes_requested"),
				attempts: DEFAULT_MAX_ITEM_ATTEMPTS,
				lastRunId: "run-prior-default-failure",
				extra: storedItemExtra({ ...itemExtraToJsonObject(item.extra), schedulerBackoff: { failureCount: DEFAULT_MAX_ITEM_ATTEMPTS, nextRunAt: 1_800_000_000 } }),
				updatedAt: 1_800_000_500,
			})

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			const exhausted = fixture.store.getItem(item.id)
			expect(exhausted?.status).toBe("exhausted")
			expect(exhausted?.extra.schedulerBackoff).toBeUndefined()
			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "queue.terminal",
				rowId: item.id,
				runId: "run-prior-default-failure",
				terminalStatus: "exhausted",
			}))
		} finally {
			await stopFixture(fixture)
		}
	})

	test("maxItemAttempts metadata override exhausts a continuable item before spawning and emits queue.terminal", async () => {
			const fixture = await createFixture("max-item-attempts-exhaust")
			try {
				const chain = createChain(fixture.store, "max-item-attempts-exhaust-chain", {
					metadata: { maxItemAttempts: 2 },
				})
			const item = createItem(fixture.store, chain, { issueNumber: 7003, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("changes_requested"),
				attempts: 2,
				lastRunId: "run-prior-failure",
				extra: storedItemExtra({ ...itemExtraToJsonObject(item.extra), schedulerBackoff: { failureCount: 2, nextRunAt: 1_800_000_000 } }),
				updatedAt: 1_800_000_500,
			})

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			const exhausted = fixture.store.getItem(item.id)
			expect(exhausted?.status).toBe("exhausted")
			expect(exhausted?.extra.schedulerBackoff).toBeUndefined()
			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "queue.terminal",
				rowId: item.id,
				runId: "run-prior-failure",
				terminalStatus: "exhausted",
			}))
		} finally {
			await stopFixture(fixture)
		}
	})

	// #402: the engine no longer owns the "exhausted" literal. The exhausted落点 status comes
	// from the preset metadata (`statuses.exhausted`), so a preset declaring a different terminal
	// label as its exhausted落点 must see that label written, not the legacy engine value. The
	// daemon's schedulerEventToObservabilityEvent mapping classifies the emitted queue.terminal
	// event as kind=audit / subject={kind:"engine"} per #411 — asserted alongside so the wire
	// shape stays explicit.
	test("attempts-exhausted落点 status comes from the preset and emits an audit/engine event (#402, #411)", async () => {
		const fixture = await createFixture("custom-exhausted-from-preset")
		const presetDir = resolve(fixture.loopDataRoot, "..", "custom-exhausted-preset")
		await writeCustomExhaustedPreset(presetDir)
		try {
			const chain = createChain(fixture.store, "custom-exhausted-chain", {
				preset: "custom-exhausted",
				metadata: { maxItemAttempts: 1 },
			})
			const item = createItem(fixture.store, chain, { issueNumber: 710_004, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("queued"),
				attempts: 1,
				lastRunId: "run-prior-custom-failure",
				extra: storedItemExtra({ ...itemExtraToJsonObject(item.extra), schedulerBackoff: { failureCount: 1, nextRunAt: 1_800_900_000 } }),
				updatedAt: 1_800_900_500,
			})

			const tick = await schedulerTick(fixture.options({
				loadedPreset: await loadedPresetFromDir(presetDir),
			}))

			expect(tick.spawnedRuns).toHaveLength(0)
			const stored = fixture.store.getItem(item.id)
			// The落点 comes from preset.statuses.exhausted ("custom_exhausted"), not the retired
			// engine literal "exhausted" — the engine no longer holds a literal.
			expect(stored?.status).toBe("custom_exhausted")
			expect(stored?.extra.schedulerBackoff).toBeUndefined()

			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId` to free
			// `itemId` for the opaque string identity convention used on split-shape `item.*` events.
			const queueTerminal = fixture.schedulerEvents.find((event) => event.type === "queue.terminal" && event.rowId === item.id)
			expect(queueTerminal).toBeDefined()
			expect(queueTerminal).toMatchObject({
				type: "queue.terminal",
				rowId: item.id,
				runId: "run-prior-custom-failure",
				terminalStatus: "custom_exhausted",
			})

			// #411: the unified observability envelope must classify the engine-driven exhaustion
			// transition as kind=audit / subject={kind:"engine"} per the event classification table.
			const observabilityEvent = schedulerEventToObservabilityEvent(chain, queueTerminal!)
			expect(observabilityEvent.kind).toBe("audit")
			expect(observabilityEvent.type).toBe("queue.terminal")
			expect(observabilityEvent.subject).toEqual({ kind: "engine" })
			if (observabilityEvent.type === "queue.terminal") {
				expect(observabilityEvent.payload.terminalStatus).toBe("custom_exhausted")
			}
		} finally {
			await stopFixture(fixture)
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
			const sibling = createItem(fixture.store, chain, { issueNumber: 7005, repoCwd: "/repo/a", writeStatus: "done" })
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
				nextRunAt: now + 60,
			})

			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(sibling.id)
			await secondTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(sibling.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
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
				nextRunAt: now + 60,
			})

			const restartedState = createSchedulerState()
			const restartedOptions = fixture.options({
				state: restartedState,
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-restarted-${selected.id}-${now}`,
			})
			const heldTick = await schedulerTick(restartedOptions)
			expect(heldTick.spawnedRuns).toHaveLength(0)

			now += 60
			const retryTick = await schedulerTick(restartedOptions)
			expect(retryTick.spawnedRuns).toHaveLength(1)
			expect(retryTick.spawnedRuns[0]?.itemId).toBe(item.id)
			await retryTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: 2,
				nextRunAt: now + 120,
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("failed-spawn default backoff sequence is 60, 120, 240, 480, then capped at 480 seconds", async () => {
		const fixture = await createFixture("failure-backoff-default-sequence")
		try {
			let now = 1_800_025_000
			const chain = createChain(fixture.store, "failure-backoff-default-sequence-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 7009,
				repoCwd: "/repo/a",
				exitCode: 1,
				summary: null,
			})
			const options = fixture.options({
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-default-backoff-${selected.id}-${now}`,
			})
			const expectedDelays = [60, 120, 240, 480, 480]

			for (const [index, expectedDelay] of expectedDelays.entries()) {
				const tick = await schedulerTick(options)
				expect(tick.spawnedRuns).toHaveLength(1)
				expect(tick.spawnedRuns[0]?.itemId).toBe(item.id)
				await tick.spawnedRuns[0]!.closed
				expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
					failureCount: index + 1,
					nextRunAt: now + expectedDelay,
				})
				now += expectedDelay
			}
		} finally {
			await stopFixture(fixture)
		}
	})

	test("failed-spawn backoff option override preserves a custom cadence", async () => {
		const fixture = await createFixture("failure-backoff-option-override")
		try {
			let now = 1_800_026_000
			const chain = createChain(fixture.store, "failure-backoff-option-override-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 7010,
				repoCwd: "/repo/a",
				exitCode: 1,
				summary: null,
			})
			const options = fixture.options({
				now: () => now,
				runIdFactory: ({ item: selected }) => `run-option-backoff-${selected.id}-${now}`,
				spawnFailureBackoff: { initialSeconds: 5, maxSeconds: 8 },
			})

			const firstTick = await schedulerTick(options)
			await firstTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: 1,
				nextRunAt: now + 5,
			})

			now += 5
			const secondTick = await schedulerTick(options)
			await secondTick.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: 2,
				nextRunAt: now + 8,
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("forced failure fixture does not spin at 1Hz: thirty seconds spawn once before sixty-second backoff", async () => {
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

			expect(spawnCount).toBe(1)
			expect(fixture.store.getItem(item.id)?.attempts).toBe(spawnCount)
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toMatchObject({
				failureCount: spawnCount,
				nextRunAt: 1_800_030_060,
			})
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
	test("loadPreset rejects a preset that omits statuses.exhausted (#402: required, no opt-out)", async () => {
		const fixture = await createFixture("missing-exhausted-declaration")
		const presetDir = resolve(fixture.loopDataRoot, "..", "missing-exhausted-preset")
		await writeMissingExhaustedDeclarationPreset(presetDir)
		try {
			let error: unknown = null
			try {
				await loadPreset(presetDir)
			} catch (caught) {
				error = caught
			}
			expect(error).toBeInstanceOf(Error)
			const message = error instanceof Error ? error.message : String(error)
			// The arktype boundary surfaces the missing field path; the engine wraps it in a presetError.
			expect(message).toContain("exhausted")
		} finally {
			await stopFixture(fixture)
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
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as BoundaryRecord
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
	test("zero-output runner is killed at the startup idle threshold and keeps retry semantics", async () => {
		const fixture = await createFixture("startup-idle-kill")
		try {
			const chain = createChain(fixture.store, "startup-idle-kill-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 462, repoCwd: "/repo/a" })
			const silentRunner = resolve(fixture.loopDataRoot, "..", "silent-runner.sh")
			await writeFile(silentRunner, "#!/bin/sh\nsleep 30\n")
			await chmod(silentRunner, 0o755)

			const startedAt = Date.now()
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: silentRunner, extraArgs: [], model: null },
				startupIdleTimeoutMs: 400,
				startupIdleKillMs: 100,
				attemptTimeoutMs: 60_000,
			}))
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed
			const elapsedMs = Date.now() - startedAt

			// Reclaimed at the idle threshold, far before the 60s attempt timeout.
			expect(elapsedMs).toBeLessThan(5_000)
			expect(closed.exitCode).not.toBe(0)
			// Killed before any status write: the item keeps its entry status and the attempt is
			// counted — identical retry semantics to an attempt-timeout kill.
			expect(closed.status).toBe(runtimeStatus("queued"))
			expect(fixture.store.getItem(item.id)?.attempts).toBe(1)
			const idleEvents = fixture.schedulerEvents.filter((event) => event.type === "run.startup_idle_kill")
			expect(idleEvents).toHaveLength(1)
			const idleEvent = idleEvents[0]
			if (idleEvent?.type !== "run.startup_idle_kill") throw new Error("expected run.startup_idle_kill")
			expect(idleEvent.itemId).toBe(item.id)
			expect(idleEvent.idleTimeoutMs).toBe(400)
			expect(idleEvent.stdoutBytes).toBe(0)
			// `attempt.timeout` must not also fire — the watchdog beat the absolute floor.
			expect(fixture.schedulerEvents.filter((event) => event.type === "attempt.timeout")).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
		}
	})

	// #478 acceptance rows 4/4b/7: a rate-limit exit arms the in-state cooldown gate
	// synchronously, fires the `scheduler.rate_limited` event, calls the daemon-side
	// `onRateLimitObserved` callback with the parsed reset, and (critically) does not
	// consume an attempt slot — the spawn-time `attempts +1` is rolled back so the
	// rate-limited item retries fresh after cooldown without burning its budget.
	test("rate-limit exit arms cooldown, emits event, fires callback, and does not consume an attempt", async () => {
		const fixture = await createFixture("rate-limit-exit")
		try {
			const chain = createChain(fixture.store, "rate-limit-exit-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 4780, repoCwd: "/repo/a" })
			const root = resolve(fixture.loopDataRoot, "..")
			const resetsAt = 1_900_000_000
			const rateLimitRunner = resolve(root, "rate-limit-runner.sh")
			// Real W3 fixture stdout shape (chain 35/37/38, 2026-06-17 22:56 JST).
			const w3Lines = [
				`{"type":"system","session_id":"sess-rl-1"}`,
				`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt},"rateLimitType":"five_hour"}}`,
				`{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit"}`,
			]
			await writeFile(rateLimitRunner, `#!/bin/sh\n${w3Lines.map((line) => `echo '${line}'`).join("\n")}\nexit 1\n`)
			await chmod(rateLimitRunner, 0o755)

			const observed: Array<{ runId: string; resetsAt: number }> = []
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: rateLimitRunner, extraArgs: [], model: null },
				onRateLimitObserved: (info) => { observed.push({ runId: info.runId, resetsAt: info.reset.resetsAt }) },
			}))
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed

			// AC7: attempts unchanged after rate-limit exit (spawn-time +1 rolled back).
			expect(fixture.store.getItem(item.id)?.attempts).toBe(0)
			// AC4 prereq: in-state cooldown gate armed synchronously.
			expect(fixture.state.rateLimitedUntilMs).toBe(resetsAt * 1000)
			// AC4 wire shape: `scheduler.rate_limited` event emitted with the parsed reset.
			const rateLimitEvents = fixture.schedulerEvents.filter((event) => event.type === "scheduler.rate_limited")
			expect(rateLimitEvents).toHaveLength(1)
			const event = rateLimitEvents[0]
			if (event?.type !== "scheduler.rate_limited") throw new Error("expected scheduler.rate_limited")
			expect(event.resetsAt).toBe(resetsAt)
			expect(event.rateLimitType).toBe("five_hour")
			expect(event.itemId).toBe(item.id)
			// Daemon-side callback receives the same reset and the originating runId.
			expect(observed).toHaveLength(1)
			expect(observed[0]?.resetsAt).toBe(resetsAt)
		} finally {
			await stopFixture(fixture)
		}
	})

	// #462: once cumulative stdout crosses STARTUP_IDLE_PROGRESS_BYTES the watchdog must
	// disarm permanently. Orchestrator wait_agent silences up to 1800s are legitimate, so
	// re-arming would inevitably mis-fire on healthy long runs. A runner that emits 300 B
	// of stdout up front and then sleeps past the idle window must exit on its own terms.
	test("runner that crosses the startup progress threshold outlives the idle window", async () => {
		const fixture = await createFixture("startup-idle-progress")
		try {
			const chain = createChain(fixture.store, "startup-idle-progress-chain")
			createItem(fixture.store, chain, { issueNumber: 463, repoCwd: "/repo/a" })
			const noisyRunner = resolve(fixture.loopDataRoot, "..", "noisy-runner.sh")
			await writeFile(noisyRunner, "#!/bin/sh\nprintf '%0300d\\n' 0\nsleep 1.2\nexit 0\n")
			await chmod(noisyRunner, 0o755)

			const startedAt = Date.now()
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: noisyRunner, extraArgs: [], model: null },
				startupIdleTimeoutMs: 400,
				startupIdleKillMs: 100,
				attemptTimeoutMs: 60_000,
			}))
			expect(tick.spawnedRuns).toHaveLength(1)
			const closed = await tick.spawnedRuns[0]!.closed
			const elapsedMs = Date.now() - startedAt

			// 300 bytes of stdout disarm the watchdog; the run lives ~3x past the idle window
			// (1.2 s sleep vs. 400 ms threshold) and exits on its own terms.
			expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
			expect(closed.exitCode).toBe(0)
			expect(fixture.schedulerEvents.filter((event) => event.type === "run.startup_idle_kill")).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
		}
	})

	// #478 acceptance row 4b: while the in-state cooldown is armed (rateLimitedUntilMs >
	// nowMs), the scheduler tick must not spawn anything — even a fresh sibling item
	// queued in the same chain stays at `queued` with no attempt consumed. This proves
	// the tick-boundary gate plugs the pre-#478 race where the next 1 s tick re-spawned
	// the rate-limited item before the daemon-side persist landed.
	test("cooldown-armed state pauses tick spawn until reset elapses", async () => {
		const fixture = await createFixture("rate-limit-gate")
		try {
			const chain = createChain(fixture.store, "rate-limit-gate-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 4781, repoCwd: "/repo/a", writeStatus: "done" })
			// Arm the gate manually to the future, simulating a prior run having just
			// observed the rate-limit signal. Use the fixture's injected `now` clock so
			// the in-tick comparison is deterministic.
			const fixtureNowSeconds = 1_800_000_100
			const futureCooldownMs = (fixtureNowSeconds + 600) * 1000
			fixture.state.rateLimitedUntilMs = futureCooldownMs

			const tick = await schedulerTick(fixture.options({ now: () => fixtureNowSeconds }))
			expect(tick.spawnedRuns).toHaveLength(0)
			// Item stays at queued with no attempts burned.
			expect(fixture.store.getItem(item.id)?.attempts).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe(runtimeStatus("queued"))

			// Advance the clock past the cooldown and the same tick spawns normally.
			const tickAfter = await schedulerTick(fixture.options({ now: () => fixtureNowSeconds + 700 }))
			expect(tickAfter.spawnedRuns).toHaveLength(1)
			await tickAfter.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	// #463: codex spawns inherit a default `RUST_LOG=info` so the codex CLI's internal
	// module diagnostics land on the per-run `stderr.log` artifact (codex only writes
	// them when RUST_LOG is set). `CODER_LOOP_CODEX_RUST_LOG` overrides the default
	// (empty string disables). claude-kind spawns must not get the injection — claude's
	// process does not consume RUST_LOG and the variable would only add noise.
	test("codex spawns inherit a default RUST_LOG while claude spawns do not", async () => {
		const fixture = await createFixture("rust-log-injection")
		const savedRustLog = process.env["RUST_LOG"]
		const savedOverride = process.env["CODER_LOOP_CODEX_RUST_LOG"]
		delete process.env["RUST_LOG"]
		delete process.env["CODER_LOOP_CODEX_RUST_LOG"]
		try {
			const chain = createChain(fixture.store, "rust-log-injection-chain")
			const codexItem = createItem(fixture.store, chain, { issueNumber: 4631, repoCwd: "/repo/a", writeStatus: "done" })
			const root = resolve(fixture.loopDataRoot, "..")
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const codexDump = resolve(evidenceDir, "codex-env.txt")
			const claudeDump = resolve(evidenceDir, "claude-env.txt")
			const makeEnvDumpRunner = async (path: string, dump: string): Promise<void> => {
				await writeFile(path, `#!/bin/sh\necho "rust_log=\${RUST_LOG-unset}" > ${dump}\nexit 0\n`)
				await chmod(path, 0o755)
			}
			const codexRunner = resolve(root, "codex-env-runner.sh")
			await makeEnvDumpRunner(codexRunner, codexDump)

			const codexTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: codexRunner, extraArgs: [], model: null },
			}))
			expect(codexTick.spawnedRuns).toHaveLength(1)
			await codexTick.spawnedRuns[0]!.closed
			expect((await readFile(codexDump, "utf-8")).trim()).toBe("rust_log=info")

			// Same chain, second item through a claude-kind runner: no injection.
			fixture.store.updateItem(codexItem.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_900 })
			createItem(fixture.store, chain, { issueNumber: 4632, repoCwd: "/repo/b", writeStatus: "done" })
			const claudeRunner = resolve(root, "claude-env-runner.sh")
			await makeEnvDumpRunner(claudeRunner, claudeDump)
			const claudeTick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: claudeRunner, extraArgs: [], model: null },
			}))
			expect(claudeTick.spawnedRuns).toHaveLength(1)
			await claudeTick.spawnedRuns[0]!.closed
			expect((await readFile(claudeDump, "utf-8")).trim()).toBe("rust_log=unset")
		} finally {
			if (savedRustLog !== undefined) process.env["RUST_LOG"] = savedRustLog
			if (savedOverride !== undefined) process.env["CODER_LOOP_CODEX_RUST_LOG"] = savedOverride
			await stopFixture(fixture)
		}
	})

	// #463: operator-supplied overrides take precedence over the engine default. An
	// explicit `CODER_LOOP_CODEX_RUST_LOG=trace` is forwarded verbatim; an explicit
	// empty value disables the injection entirely (codex stderr stays bare). The
	// engine documents the precedence in one place: the code comment above the env
	// construction in `spawnSchedulerRun`.
	test("CODER_LOOP_CODEX_RUST_LOG override controls or disables the codex RUST_LOG injection", async () => {
		const fixture = await createFixture("rust-log-override")
		const savedRustLog = process.env["RUST_LOG"]
		const savedOverride = process.env["CODER_LOOP_CODEX_RUST_LOG"]
		delete process.env["RUST_LOG"]
		try {
			const chain = createChain(fixture.store, "rust-log-override-chain")
			const firstItem = createItem(fixture.store, chain, { issueNumber: 4633, repoCwd: "/repo/a", writeStatus: "done" })
			const root = resolve(fixture.loopDataRoot, "..")
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const traceDump = resolve(evidenceDir, "trace-env.txt")
			const disabledDump = resolve(evidenceDir, "disabled-env.txt")
			const makeEnvDumpRunner = async (path: string, dump: string): Promise<void> => {
				await writeFile(path, `#!/bin/sh\necho "rust_log=\${RUST_LOG-unset}" > ${dump}\nexit 0\n`)
				await chmod(path, 0o755)
			}
			const traceRunner = resolve(root, "trace-runner.sh")
			await makeEnvDumpRunner(traceRunner, traceDump)

			process.env["CODER_LOOP_CODEX_RUST_LOG"] = "trace"
			const traceTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: traceRunner, extraArgs: [], model: null },
			}))
			await traceTick.spawnedRuns[0]!.closed
			expect((await readFile(traceDump, "utf-8")).trim()).toBe("rust_log=trace")

			fixture.store.updateItem(firstItem.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_910 })
			createItem(fixture.store, chain, { issueNumber: 4634, repoCwd: "/repo/b", writeStatus: "done" })
			const disabledRunner = resolve(root, "disabled-runner.sh")
			await makeEnvDumpRunner(disabledRunner, disabledDump)

			process.env["CODER_LOOP_CODEX_RUST_LOG"] = ""
			const disabledTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: disabledRunner, extraArgs: [], model: null },
			}))
			await disabledTick.spawnedRuns[0]!.closed
			expect((await readFile(disabledDump, "utf-8")).trim()).toBe("rust_log=unset")
		} finally {
			if (savedRustLog !== undefined) process.env["RUST_LOG"] = savedRustLog
			else delete process.env["RUST_LOG"]
			if (savedOverride !== undefined) process.env["CODER_LOOP_CODEX_RUST_LOG"] = savedOverride
			else delete process.env["CODER_LOOP_CODEX_RUST_LOG"]
			await stopFixture(fixture)
		}
	})

	// #478 acceptance row 6 + I4 review: a rate-limit exit must NOT lose the conversation —
	// the next spawn for the same item must invoke the runner with `--resume <sessionId>`
	// continuing from the sessionId the rate-limited run published. Pre-#478 the run
	// classified as `unclassified` → decideResume returned `fresh`, throwing away the
	// stored sessionId. The PR's rate-limit-exit branch goes through `clearItemSchedulerBackoff`
	// instead of `extraAfterRunCompletion`, which (today) preserves sessionIds; this test
	// pins the invariant so a future refactor cannot silently regress it.
	test("rate-limit exit preserves the sessionId and the next spawn resumes from it", async () => {
		const fixture = await createFixture("rate-limit-resume")
		try {
			const chain = createChain(fixture.store, "rate-limit-resume-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 4782, repoCwd: "/repo/a" })
			const root = resolve(fixture.loopDataRoot, "..")
			const sessionId = "sess-rl-resume-test"
			const resetsAt = 1_900_000_500
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const argvDump = resolve(evidenceDir, "argv-dump.txt")
			// Single runner script with two branches:
			//   1st run (no --resume): emit session_id + W3 rate-limit lines + exit 1 →
			//      scheduler stores sessionId AND arms the cooldown gate.
			//   2nd run (--resume <sessionId> present): dump the full argv to disk + exit 0 →
			//      the test reads back the dump to assert the resume sessionId reached the runner.
			const runner = resolve(root, "rate-limit-resume-runner.sh")
			await writeFile(runner, [
				`#!/bin/sh`,
				`# always overwrite the argv dump so the last invocation wins`,
				`printf '%s\\n' "$*" > ${JSON.stringify(argvDump)}`,
				`case "$*" in`,
				`*--resume*)`,
				`    exit 0`,
				`    ;;`,
				`*)`,
				`    echo '{"type":"system","session_id":"${sessionId}"}'`,
				`    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt},"rateLimitType":"five_hour"}}'`,
				`    echo '{"type":"result","is_error":true,"api_error_status":429,"result":"hit your session limit"}'`,
				`    exit 1`,
				`    ;;`,
				`esac`,
				``,
			].join("\n"))
			await chmod(runner, 0o755)

			// Shared runIdFactory across both ticks — the fixture default constructs a
			// fresh attempt-counter Map per `fixture.options()` call, which would collide
			// on the second tick (UNIQUE runs.run_id) because rate-limit rolled attempts
			// back to the pre-spawn value. A shared per-test factory mimics production
			// runId monotonicity.
			let runSequence = 0
			const sharedRunIdFactory: SchedulerOptions["runIdFactory"] = ({ chain: c, item: it, phase }) => {
				runSequence += 1
				return `run-${c.id}-${it.id}-${phase}-${runSequence}`
			}

			const cooldownStart = 1_800_000_400
			const tick1 = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: runner, extraArgs: [], model: null },
				now: () => cooldownStart,
				runIdFactory: sharedRunIdFactory,
			}))
			expect(tick1.spawnedRuns).toHaveLength(1)
			await tick1.spawnedRuns[0]!.closed

			// sessionId stored: scheduler parsed it from stdout and wrote it via setItemSessionId.
			const itemAfterTick1 = fixture.store.getItem(item.id)
			expect(itemAfterTick1?.sessionIds["iteration"]?.["claude"]).toBe(sessionId)
			// In-state cooldown gate armed; attempts unchanged (PR acceptance row 7).
			expect(fixture.state.rateLimitedUntilMs).toBe(resetsAt * 1000)
			expect(itemAfterTick1?.attempts).toBe(0)

			// Tick 2 with the now() clock advanced past the cooldown → scheduler resumes the
			// rate-limited item; runner argv must include `--resume <sessionId>`.
			const tick2 = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: runner, extraArgs: [], model: null },
				now: () => resetsAt + 5,
				runIdFactory: sharedRunIdFactory,
			}))
			expect(tick2.spawnedRuns).toHaveLength(1)
			await tick2.spawnedRuns[0]!.closed
			const argv = (await readFile(argvDump, "utf-8")).trim()
			expect(argv).toMatch(/--resume +sess-rl-resume-test\b/)
		} finally {
			await stopFixture(fixture)
		}
	})
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
				extra: storedItemExtra({ startStatus: "queued" }),
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
				extra: storedItemExtra({ startStatus: "queued" }),
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
				extra: storedItemExtra({ startStatus: "queued", startStatusUpdatedAt: item.statusUpdatedAt }),
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
				extra: storedItemExtra({ startStatus: "changes_requested", startStatusUpdatedAt: beforeReview.statusUpdatedAt }),
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
				extra: storedItemExtra({ startStatus: "queued" }),
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
			const exhaustedTick = await schedulerTick(fixture.options())
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
				extra: storedItemExtra({ startStatus: "queued" }),
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

describe("scheduler loaded preset prompt rendering", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("scheduler spawn renders loaded preset prompt before subprocess (entry md prose preserved, {{KEY}} placeholders replaced)", async () => {
		const fixture = await createPresetPromptIntegrationFixture("integration-resolver")
		try {
			const chain = createChain(fixture.store, "integration-resolver-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 283, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(closed.runId), "utf-8")).toContain("## Workflow")
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(closed.runId), "utf-8")).toContain("## Boundaries (apply to you and every subagent)")

			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("## Workflow")

			const preset = await loadPreset(PRESET_DIR)
			const iterPhase = preset.phases.find((entry) => entry.name === "iteration")!
			const mainLoopRaw = await readFile(iterPhase.prompt, "utf-8")
			const declaredKeys = new Set(iterPhase.variables.map((variable) => variable.key))
			const rawTokens = new Set(mainLoopRaw.match(/\{\{[A-Z_]+\}\}/g) ?? [])
			expect(rawTokens.size).toBeGreaterThan(0)
			for (const token of rawTokens) {
				const key = token.slice(2, -2)
				// `{{PRESET_ROOT}}` is an engine-owned reserved token substituted by
				// the materialization layer (or by `substitutePresetRootToken` on the
				// direct-parse path). It's not declared in [phases.variables]; the
				// materialization/read pipeline replaces it before render.
				if (key === "PRESET_ROOT") {
					expect(capturedStdout).not.toContain(token)
					continue
				}
				expect(declaredKeys.has(key)).toBe(true)
				expect(capturedStdout).not.toContain(token)
			}
			expect(capturedStdout).toContain("`mouriya-s-lab/coder-loop`")
			expect(capturedStdout).toContain("`/repo/a`")
			expect(capturedStdout).toContain("Current issue: `#283`")
			// The echo-prompt runner is a render probe: it never calls `coder-loop item update`, so the
			// item keeps its entry status. The scheduler does not infer a terminal status from stdout.
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			await stopFixture(fixture)
		}
	})
})

describe("scheduler chain bindings (issue #288)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	// #457: CHAIN_UMBRELLA_REPO / CHAIN_UMBRELLA_ISSUE moved from `runtime.chainUmbrella*` (engine
	// fact) to `chain.umbrella*` (declared chain binding via metadata.bindings). CHAIN_BASE_BRANCH
	// retired entirely; BASE_BRANCH at chain.baseBranch covers the prompt-business need. The
	// remaining engine-runtime chain facts (CHAIN_NAME, REPO_CWD) are unchanged.
	test("preset.toml declares CHAIN_NAME / CHAIN_UMBRELLA_REPO / CHAIN_UMBRELLA_ISSUE / REPO_CWD in every actionable phase (AC4, post-#457)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const expectedRuntime = new Set([
			["CHAIN_NAME", "chainName"],
			["REPO_CWD", "repoCwd"],
		].map((entry) => entry.join(" ")))
		const expectedChain = new Set([
			["CHAIN_UMBRELLA_REPO", "umbrellaRepo"],
			["CHAIN_UMBRELLA_ISSUE", "umbrellaIssue"],
		].map((entry) => entry.join(" ")))
		for (const phase of preset.phases) {
			const runtimeBindings = new Set(
				phase.variables
					.filter((variable) => variable.source.kind === "runtime")
					.map((variable) => [variable.key, variable.source.kind === "runtime" ? variable.source.key : ""].join(" ")),
			)
			const chainBindings = new Set(
				phase.variables
					.filter((variable) => variable.source.kind === "chain")
					.map((variable) => [variable.key, variable.source.kind === "chain" ? variable.source.field : ""].join(" ")),
			)
			for (const entry of expectedRuntime) {
				expect(runtimeBindings.has(entry)).toBe(true)
			}
			for (const entry of expectedChain) {
				expect(chainBindings.has(entry)).toBe(true)
			}
		}
	})

	test("renderSchedulerSpawnPrompt against a template that references every declared iteration binding leaves zero residual {{[A-Z_]+}} tokens (AC2)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const iterPhase = preset.phases.find((entry) => entry.name === "iteration")!
		const declaredKeys = iterPhase.variables.map((variable) => variable.key)
		const template = declaredKeys.map((key) => `${key}={{${key}}}`).join("\n")
		const chain = makeChainFixture({ name: "render-zero-token-chain" })
		const item = makeItemFixture(chain, { issueNumber: 999_001, repoCwd: "/tmp/no-token-repo" })
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: template,
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-zero-token",
			worktreePath: "/tmp/render-zero-token-worktree",
		})
		const residual = rendered.match(/\{\{[A-Z_]+\}\}/g) ?? []
		expect(residual).toEqual([])
	})

	// #457: umbrella values now arrive via `chain.umbrellaRepo` / `chain.umbrellaIssue`. The
	// `--config-json` / `--umbrella` CLI surface writes them to `metadata.bindings`, where
	// `chainBindings()` exposes them through the declared chain-binding namespace. The bundled
	// preset retired `CHAIN_BASE_BRANCH` since BASE_BRANCH (chain.baseBranch) already covers
	// the same prompt-business need.
	test("renderSchedulerSpawnPrompt with chain.name=my-chain umbrellaRepo=owner/repo umbrellaIssue=42 substitutes those literals (AC3, post-#457)", async () => {
		const preset = await loadPreset(PRESET_DIR)
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
				"chain.baseBranch={{BASE_BRANCH}}",
				"item.repoCwd={{REPO_CWD}}",
			].join("\n"),
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-chain-binding",
			worktreePath: "/tmp/chain-binding-worktree",
		})
		expect(rendered).toContain("chain.name=my-chain")
		expect(rendered).toContain("umbrella.repo=owner/repo")
		expect(rendered).toContain("umbrella.issue=42")
		expect(rendered).toContain("chain.baseBranch=trunk")
		expect(rendered).toContain("item.repoCwd=/tmp/chain-binding-repo")
	})

	// #457: when metadata.bindings has no umbrella entries, the declared `chain.umbrellaRepo` /
	// `chain.umbrellaIssue` bindings fall back to `default = ""` (per the bundled preset's
	// variable spec) so the render emits empty literals instead of crashing.
	test("renderSchedulerSpawnPrompt leaves chain.umbrellaRepo and chain.umbrellaIssue empty when metadata.bindings has no umbrella entries", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const chain = makeChainFixture({
			name: "no-umbrella-chain",
			metadata: storedChainMetadata({}),
		})
		const item = makeItemFixture(chain, { issueNumber: 999_003, repoCwd: "/tmp/no-umbrella-repo" })
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "umb_repo=[{{CHAIN_UMBRELLA_REPO}}] umb_issue=[{{CHAIN_UMBRELLA_ISSUE}}]",
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-no-umbrella",
			worktreePath: "/tmp/no-umbrella-worktree",
		})
		expect(rendered).toBe("umb_repo=[] umb_issue=[]")
	})

	// #434: `WORKFLOW_FILE` retired; the per-target `.coder-loop/workflow.md` file is no
	// longer an engine concept. Project commands / PR conventions live in the target repo's
	// own `CLAUDE.md` / `AGENTS.md`, read directly by preset prompts. The two tests that
	// used to verify the WORKFLOW_FILE binding resolution path were deleted along with the
	// concept.

	test("scheduler spawn end-to-end: chain literals reach agent stdout via echo runner (AC5 fixture-style integration)", async () => {
		const fixture = await createPresetPromptIntegrationFixture("chain-binding-integration")
		try {
			const chain = createChain(fixture.store, "chain-binding-integration-chain", {
				umbrellaRepo: "owner/umb-repo",
				umbrellaIssue: 777,
				baseBranch: "trunk",
			})
			const item = createItem(fixture.store, chain, { issueNumber: 288_001, repoCwd: "/tmp/chain-int-repo" })

			// #457: chain.baseBranch is read via the BASE_BRANCH binding (preset declares it as
			// `chain.baseBranch`); the engine-fact `CHAIN_BASE_BRANCH` runtime key is retired.
			const customPrompt = [
				"=== chain bindings probe ===",
				"chain.name={{CHAIN_NAME}}",
				"chain.umbrellaRepo={{CHAIN_UMBRELLA_REPO}}",
				"chain.umbrellaIssue={{CHAIN_UMBRELLA_ISSUE}}",
				"chain.baseBranch={{BASE_BRANCH}}",
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
			// Render probe (echo-prompt runner) writes no status, so the item keeps its entry status.
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			await stopFixture(fixture)
		}
	})
})

describe("scheduler per-phase runner selection (issue #287)", () => {
	test("external-terminal unavailability gates before worktree and attempt side effects", async () => {
		const fixture = await createFixture("external-terminal-pre-worktree-gate")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "69")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const chain = createChain(fixture.store, "external-terminal-pre-worktree-gate-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_001, repoCwd: "/repo/a" })
			let credentialMints = 0
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				runCredentials: {
					mint: () => { credentialMints += 1; return { value: "must-not-be-minted" } },
					revoke: () => {},
				},
			}))

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(await readFile(externalEvents, "utf-8")).toBe("probe\n")
			expect(fixture.worktreeCalls).toHaveLength(0)
			expect(credentialMints).toBe(0)
			expect(fixture.store.listRuns(chain.id)).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			expect(existsSync(paths.runsDir)).toBe(false)
			expect(existsSync(schedulerSlotWorktreePath(chain, item.repoCwd, { loopDataRoot: fixture.loopDataRoot }))).toBe(false)
			expect(fixture.store.getItem(item.id)?.attempts).toBe(0)
			expect(itemExtraToJsonObject(fixture.store.getItem(item.id)!.extra).externalTerminalHold).toMatchObject({
				kind: "external-terminal-unavailable",
				runner: "hapi",
				phase: "iteration",
				binary,
				probeArgv: ["probe"],
				availability: { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69 },
			})
			expect(fixture.schedulerEvents).toContainEqual({
				type: "runner.external_terminal_unavailable",
				chainId: chain.id,
				rowId: item.id,
				itemId: item.itemId,
				phase: "iteration",
				runner: "hapi",
				binary,
				probeArgv: ["probe"],
				availability: { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null },
				affected: [{ chainId: chain.id, rowId: item.id, itemId: item.itemId, phase: "iteration" }],
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("local-process runners do not consult the external-terminal probe", async () => {
		const fixture = await createFixture("local-runner-skips-external-probe")
		try {
			const chain = createChain(fixture.store, "local-runner-skips-external-probe-chain")
			createItem(fixture.store, chain, { issueNumber: 602_002, repoCwd: "/repo/a" })
			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("held candidate releases its repo slot to a later runnable local item", async () => {
		const fixture = await createFixture("external-terminal-held-candidate-starvation")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "69")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const chain = createChain(fixture.store, "external-terminal-held-candidate-starvation-chain")
			const held = createItem(fixture.store, chain, { issueNumber: 602_008, repoCwd: "/repo/shared", runner: "hapi" })
			const runnable = createItem(fixture.store, chain, { issueNumber: 602_009, repoCwd: "/repo/shared", runner: "codex" })
			const tick = await schedulerTick(fixture.options({
				phaseRunner: ({ item }) => item.runner === "hapi"
					? { kind: "hapi", source: "queue", binary, extraArgs: [], model: null }
					: { kind: "codex", source: "queue", binary: "bun", extraArgs: [fixture.fakeRunner], model: null },
			}))
			expect(tick.spawnedRuns).toHaveLength(1)
			expect(tick.spawnedRuns[0]?.itemId).toBe(runnable.id)
			expect(fixture.store.getItem(held.id)?.attempts).toBe(0)
			expect(fixture.store.getItem(held.id)?.extra.externalTerminalHold).toBeDefined()
			await tick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("held external-terminal item automatically spawns after availability restoration", async () => {
		const fixture = await createFixture("external-terminal-restoration")
		try {
			const chain = createChain(fixture.store, "external-terminal-restoration-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_005, repoCwd: "/repo/a" })
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			const spawnEvents = resolve(schedulerSlotWorktreePath(chain, item.repoCwd, { loopDataRoot: fixture.loopDataRoot }), "external-events")
			await writeFile(probeState, "69")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1, spawnEvents)
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
			})
			expect((await schedulerTick(options)).spawnedRuns).toHaveLength(0)
			await writeFile(probeState, "0")
			const restored = await schedulerTick(options)
			expect(restored.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.availability_restored")).toHaveLength(1)
			await new Promise((resolveDone) => setTimeout(resolveDone, 20))
			expect(await readFile(externalEvents, "utf-8")).toBe("probe\nprobe\n")
			expect(await readFile(spawnEvents, "utf-8")).toBe("spawn\n")
			await restored.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("in-flight external-terminal loss revokes, terminates, and restores the pre-run attempt", async () => {
		const fixture = await createFixture("external-terminal-in-flight-loss")
		try {
			const chain = createChain(fixture.store, "external-terminal-in-flight-loss-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_004, repoCwd: "/repo/a", sleepMs: 10_000 })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("changes_requested"),
				attempts: 4,
				phase: null,
				updatedAt: 1_900_602_004,
			})
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const activeCredentials = new Set<string>()
			const credentialIdentity = "external-loss-credential"
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				runCredentials: {
					mint: () => { activeCredentials.add(credentialIdentity); return { value: credentialIdentity } },
					revoke: (credential) => { activeCredentials.delete(credential.value) },
				},
				attemptKillMs: 100,
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			expect(activeCredentials).toEqual(new Set([credentialIdentity]))
			expect(fixture.store.getItem(item.id)?.attempts).toBe(5)
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "hapi", sessionId: "lost-session", updatedAt: 1_900_602_005 })
			expect(fixture.store.getItem(item.id)?.sessionIds.iteration?.hapi).toBe("lost-session")
			await writeFile(probeState, "69")
			await schedulerTick(options)
			expect(fixture.store.getRunByRunId(spawned.spawnedRuns[0]!.runId)?.extra.externalTerminalLoss).toMatchObject({ terminationPhase: "term" })
			const closed = await spawned.spawnedRuns[0]!.closed
			expect(activeCredentials.size).toBe(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: "changes_requested", phase: null, attempts: 4 })
			expect(fixture.store.getItem(item.id)?.sessionIds.iteration?.hapi).toBeUndefined()
			expect([...fixture.state.slots.values()].every((slot) => slot.activeRun === null)).toBe(true)
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toBeUndefined()
			expect(itemExtraToJsonObject(fixture.store.getItem(item.id)!.extra).externalTerminalHold).toMatchObject({ availability: { reason: "endpoint-unavailable" } })
			expect(closed.result).toEqual({
				kind: "external-terminal-lost",
				loss: expect.objectContaining({ reason: "endpoint-unavailable", terminationPhase: "closed" }),
			})
			expect(fixture.store.getRunByRunId(closed.runId)?.extra.externalTerminalLoss).toMatchObject({
				kind: "lost",
				reason: "endpoint-unavailable",
				terminationPhase: "closed",
			})
		} finally {
			await stopFixture(fixture)
		}
	})

	test("same-chain repo-slot external-terminal losses keep independent durable run latches", async () => {
		const fixture = await createFixture("external-terminal-same-chain-independent-loss")
		try {
			const chain = createChain(fixture.store, "external-terminal-same-chain-independent-loss-chain")
			const first = createItem(fixture.store, chain, { issueNumber: 602_017, repoCwd: "/repo/a", sleepMs: 10_000 })
			const second = createItem(fixture.store, chain, { issueNumber: 602_018, repoCwd: "/repo/b", sleepMs: 10_000 })
			fixture.store.updateItem(first.id, {
				status: runtimeStatus("changes_requested"),
				attempts: 4,
				phase: null,
				updatedAt: 1_900_602_017,
			})
			fixture.store.updateItem(second.id, {
				status: runtimeStatus("queued"),
				attempts: 2,
				phase: null,
				updatedAt: 1_900_602_018,
			})
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const activeCredentials = new Set<string>()
			const revokedCredentials: string[] = []
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				runCredentials: {
					mint: ({ runId }) => { activeCredentials.add(runId); return { value: runId } },
					revoke: (credential) => { activeCredentials.delete(credential.value); revokedCredentials.push(credential.value) },
				},
				attemptKillMs: 100,
			})

			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(2)
			expect(activeCredentials.size).toBe(2)
			fixture.store.setItemSessionId(first.id, { phase: "iteration", runner: "hapi", sessionId: "first-session" })
			fixture.store.setItemSessionId(second.id, { phase: "iteration", runner: "hapi", sessionId: "second-session" })

			await writeFile(probeState, "69")
			await schedulerTick(options)
			const closed = await Promise.all(spawned.spawnedRuns.map((run) => run.closed))

			expect(closed.map((run) => run.result.kind)).toEqual(["external-terminal-lost", "external-terminal-lost"])
			expect(activeCredentials.size).toBe(0)
			expect(new Set(revokedCredentials)).toEqual(new Set(spawned.spawnedRuns.map((run) => run.runId)))
			expect(fixture.store.getItem(first.id)).toMatchObject({ status: "changes_requested", phase: null, attempts: 4 })
			expect(fixture.store.getItem(second.id)).toMatchObject({ status: "queued", phase: null, attempts: 2 })
			expect(fixture.store.getItem(first.id)?.sessionIds.iteration?.hapi).toBeUndefined()
			expect(fixture.store.getItem(second.id)?.sessionIds.iteration?.hapi).toBeUndefined()
			expect(fixture.store.getItem(first.id)?.extra.schedulerBackoff).toBeUndefined()
			expect(fixture.store.getItem(second.id)?.extra.schedulerBackoff).toBeUndefined()
			for (const run of spawned.spawnedRuns) {
				expect(fixture.store.getRunByRunId(run.runId)?.extra.externalTerminalLoss).toMatchObject({
					kind: "lost",
					reason: "endpoint-unavailable",
					terminationPhase: "closed",
				})
			}
			expect([...fixture.state.slots.values()].every((slot) => slot.activeRun === null)).toBe(true)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("scheduler-managed external-terminal chain-complete run loses through the ordinary lifecycle and preserves its terminal anchor", async () => {
		const fixture = await createFixture("external-terminal-chain-complete-loss")
		try {
			const chain = createChain(fixture.store, "external-terminal-chain-complete-loss-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_015, repoCwd: "/repo/chain-complete" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("done"),
				phase: "review",
				attempts: 4,
				updatedAt: 1_900_602_015,
			})
			fixture.store.setItemSessionId(item.id, { phase: "umbrella-finalizer", runner: "hapi", sessionId: "chain-complete-session", updatedAt: 1_900_602_016 })
			const binary = resolve(fixture.loopDataRoot, "..", "chain-complete-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "chain-complete-probe-state")
			await writeFile(probeState, "0")
			await writeFile(binary, `#!/bin/sh
if [ "$1" = probe ]; then
	state=$(cat ${JSON.stringify(probeState)})
	[ "$state" = 69 ] && exit 69
	exit 0
fi
if [ "$(cat ${JSON.stringify(probeState)})" = complete ]; then
	echo "FINALIZER SUMMARY: decision=complete; reason=test"
	exit 0
fi
trap 'exit 0' TERM
while :; do sleep 1; done
`)
			await chmod(binary, 0o755)
			const activeCredentials = new Set<string>()
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				chainCompleteExecution: { kind: "scheduler-managed" },
				runCredentials: {
					mint: ({ runId }) => { const value = `credential-${runId}`; activeCredentials.add(value); return { value } },
					revoke: (credential) => { activeCredentials.delete(credential.value) },
				},
				attemptKillMs: 100,
			})

			const started = await schedulerTick(options)
			expect(started.spawnedRuns).toHaveLength(1)
			expect(started.spawnedRuns[0]?.phase).toBe("umbrella-finalizer")
			expect(activeCredentials.size).toBe(1)
			expect(fixture.store.getCurrentRun(chain.id)?.runId).toBe(started.spawnedRuns[0]?.runId)
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: "done", phase: "review", attempts: 4 })

			await writeFile(probeState, "69")
			await schedulerTick(options)
			const lost = await started.spawnedRuns[0]!.closed
			expect(lost.result.kind).toBe("external-terminal-lost")
			expect(activeCredentials.size).toBe(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: "done", phase: "review", attempts: 4 })
			expect(fixture.store.getItem(item.id)?.sessionIds["umbrella-finalizer"]?.hapi).toBeUndefined()

			await writeFile(probeState, "complete")
			const restored = await schedulerTick(options)
			expect(restored.spawnedRuns).toHaveLength(1)
			expect((await restored.spawnedRuns[0]!.closed).exitCode).toBe(0)
			await Promise.all(listPendingCloseHandlers(fixture.state))
			const completed = await schedulerTick(options)
			expect(completed.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("scheduler-managed chain-complete preparation failure preserves its terminal anchor and retries", async () => {
		const fixture = await createFixture("chain-complete-preparation-failure")
		try {
			const chain = createChain(fixture.store, "chain-complete-preparation-failure-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_016, repoCwd: "/repo/chain-complete" })
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("done"),
				phase: "review",
				attempts: 4,
				lastRunId: "terminal-anchor-run",
				updatedAt: 1_900_602_016,
			})
			const terminalAnchor = fixture.store.getItem(item.id)
			const finalizerRunner = resolve(fixture.loopDataRoot, "..", "chain-complete-finalizer")
			await writeShellFinalizerMarkerScript(finalizerRunner, "chain-complete-preparation-retry")
			let failPreparation = true
			const options = fixture.options({
				chainCompleteExecution: { kind: "scheduler-managed" },
				runner: { kind: "codex", source: "iteration-default", binary: finalizerRunner, extraArgs: [], model: null },
				prompt: () => {
					if (failPreparation) throw new Error("chain-complete prompt preparation failed")
					return "finalize"
				},
			})

			const failed = await schedulerTick(options)
			expect(failed.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)).toEqual(terminalAnchor)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(fixture.state.chainCompleteExecutions.has(chain.id)).toBe(false)
			expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted")).toHaveLength(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "chain.complete_trigger_failed")).toHaveLength(1)

			failPreparation = false
			const retried = await schedulerTick(options)
			expect(retried.spawnedRuns).toHaveLength(1)
			await retried.spawnedRuns[0]!.closed
			await Promise.all(listPendingCloseHandlers(fixture.state))
			const completed = await schedulerTick(options)
			expect(completed.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getItem(item.id)).toEqual(terminalAnchor)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("terminal status committed before an in-flight probe wins over loss attribution", async () => {
		const fixture = await createFixture("external-terminal-terminal-wins")
		try {
			const chain = createChain(fixture.store, "external-terminal-terminal-wins-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_006, repoCwd: "/repo/a", sleepMs: 10_000 })
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			await writeFile(probeState, "wait-69")
			const lossTick = schedulerTick(options)
			await waitForFileText(externalEvents, "probe-waiting")
			fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_900_602_006 })
			await writeFile(`${probeState}.release`, "release")
			await lossTick
			expect(fixture.store.getRunByRunId(spawned.spawnedRuns[0]!.runId)?.extra.externalTerminalLoss).toBeUndefined()
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
			await spawned.spawnedRuns[0]!.terminate({ forceAfterMs: 100 })
			await spawned.spawnedRuns[0]!.closed
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("in-flight loss latches before awaited warning persistence", async () => {
		const fixture = await createFixture("external-terminal-loss-latch-before-warning")
		try {
			const chain = createChain(fixture.store, "external-terminal-loss-latch-before-warning-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_012, repoCwd: "/repo/a", sleepMs: 10_000 })
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				attemptKillMs: 100,
				onEvent: async (event) => {
					fixture.schedulerEvents.push(event)
					if (event.type !== "runner.external_terminal_unavailable") return
					const activeRun = fixture.store.listRuns(chain.id).find((run) => run.endedAt === null)
					expect(activeRun?.extra.externalTerminalLoss).toMatchObject({ terminationPhase: "term" })
					fixture.store.updateItem(item.id, { status: runtimeStatus("done"), updatedAt: 1_900_602_012 })
				},
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			await writeFile(probeState, "69")
			await schedulerTick(options)
			const closed = await spawned.spawnedRuns[0]!.closed
			expect(closed.result).toMatchObject({ kind: "external-terminal-lost" })
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("normal terminal close clears a stale external-terminal hold", async () => {
		const fixture = await createFixture("external-terminal-terminal-close-clears-hold")
		try {
			const chain = createChain(fixture.store, "external-terminal-terminal-close-clears-hold-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_013, repoCwd: "/repo/a", sleepMs: 10_000 })
			createItem(fixture.store, chain, { issueNumber: 602_014, repoCwd: "/repo/a", runner: "codex" })
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const options = fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
				onEvent: (event) => {
					fixture.schedulerEvents.push(event)
					if (event.type !== "agent.exit") return
					const terminal = fixture.store.getItem(item.id)
					if (terminal === null) throw new Error("terminal item missing during close")
					fixture.store.updateItem(item.id, {
						extra: storedItemExtra({ ...itemExtraToJsonObject(terminal.extra), externalTerminalHold: {
							kind: "external-terminal-unavailable", runner: "hapi", phase: "iteration", binary, probeArgv: ["probe"],
							availability: { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null, checkedAt: "2026-07-15T00:00:00.000Z", since: "2026-07-15T00:00:00.000Z" },
						} }),
						updatedAt: 1_900_602_014,
					})
				},
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			fixture.store.updateItem(item.id, {
				status: runtimeStatus("done"),
				updatedAt: 1_900_602_013,
			})
			await spawned.spawnedRuns[0]!.terminate({ forceAfterMs: 100 })
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
		} finally {
			await stopFixture(fixture)
		}
	})

	test("same-endpoint active loss emits one transition with every affected run", async () => {
		const fixture = await createFixture("external-terminal-active-loss-aggregation")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 10)
			const firstChain = createChain(fixture.store, "external-terminal-active-loss-a")
			const secondChain = createChain(fixture.store, "external-terminal-active-loss-b")
			const first = createItem(fixture.store, firstChain, { issueNumber: 602_010, repoCwd: "/repo/a" })
			const second = createItem(fixture.store, secondChain, { issueNumber: 602_011, repoCwd: "/repo/b" })
			const options = fixture.options({ runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null }, attemptKillMs: 100 })
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(2)
			await writeFile(probeState, "69")
			await schedulerTick(options)
			const warnings = fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).toMatchObject({ affected: [
				{ chainId: firstChain.id, rowId: first.id, itemId: first.itemId, phase: "iteration" },
				{ chainId: secondChain.id, rowId: second.id, itemId: second.itemId, phase: "iteration" },
			] })
			await Promise.all(spawned.spawnedRuns.map((run) => run.closed))
		} finally {
			await stopFixture(fixture)
		}
	})

	test("non-69 external-terminal probe exit is held as typed probe-failed", async () => {
		const fixture = await createFixture("external-terminal-probe-failed")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "17")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const chain = createChain(fixture.store, "external-terminal-probe-failed-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_007, repoCwd: "/repo/a" })
			const tick = await schedulerTick(fixture.options({
				runner: { kind: "hapi", source: "iteration-default", binary, extraArgs: [], model: null },
			}))
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold?.availability).toMatchObject({
				kind: "probe-failed", reason: "unexpected-exit", exitCode: 17, signal: null,
			})
			expect(fixture.store.listRuns(chain.id)).toHaveLength(0)
			expect(fixture.worktreeCalls).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
		}
	})

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
					// #433: "config" source value is retired (no target-side preferences file
					// left). Iteration phases now stamp the "iteration-default" source label.
					source: "iteration-default",
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
			await stopFixture(fixture)
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
					// #433: same retirement as above — non-review fallback path is "iteration-default".
					source: "iteration-default",
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
			await stopFixture(fixture)
		}
	})

	test("falls back to options.runner when phaseRunner is not configured (backward compat)", async () => {
		const fixture = await createFixture("phase-runner-fallback")
		try {
			const chain = createChain(fixture.store, "phase-runner-fallback-chain")
			createItem(fixture.store, chain, { issueNumber: 287_103, repoCwd: "/repo/a", writeStatus: "done" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(fixture.store.getItem(fixture.store.listItems(chain.id)[0]!.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("contains missing runner failure with diagnostic, backoff, and spawn.aborted", async () => {
		const fixture = await createFixture("phase-runner-missing")
		try {
			const chain = createChain(fixture.store, "phase-runner-missing-chain")
			createItem(fixture.store, chain, { issueNumber: 287_104, repoCwd: "/repo/a" })

			const baseOptions = fixture.options()
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner

			const tick = await schedulerTick(baseOptions)
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			const failedItem = fixture.store.listItems(chain.id)[0]
			expect(failedItem?.extra.schedulerSpawnError).toMatchObject({
				attribution: { kind: "phase", phase: "iteration" },
				message: expect.stringContaining("no runner configured"),
			})
			expect(failedItem?.extra.schedulerBackoff).toMatchObject({ failureCount: 1 })
			expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted")).toHaveLength(1)
		} finally {
			await stopFixture(fixture)
		}
	})

	describe("resolvePhaseRunnerFromChain", () => {
		const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

		test("chain default → iteration phase returns codex with binary 'codex'", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
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
			expect(runner.source).toBe("preset")
		})

		test("chain default → review phase returns codex with the preset-declared model", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
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
			expect(runner.model).toBe("gpt-5.6-sol")
			expect(runner.source).toBe("preset")
		})

		// #433: the legacy `metadata.reviewRunner` top-level field is retired. Parsing chain
		// metadata that carries it must now fail loudly (no silent-ignore fallback), so the
		// preset's declared review runner remains the single source of truth for that phase.
		test("chain metadata reviewRunner='claude' is retired and rejected at parse time (#433)", () => {
			expect(() => storedChainMetadata({ reviewRunner: "claude" })).toThrow(/reviewRunner is retired \(#433\)/)
		})

		test("chain metadata codex.model overrides the preset-declared review model", async () => {
			const chain = makeChainFixture({
				metadata: storedChainMetadata({
					codex: { model: "gpt-5.6-terra" },
				}),
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.model).toBe("gpt-5.6-terra")
		})

		test("item.runner='claude' overrides codex iteration default for non-review phase", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
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

		test("chain default → triggered/finalizer phase resolves to its preset codex runner", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "umbrella-finalizer",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.source).toBe("preset")
		})

		test("preset-declared review model flows into review args via buildRunnerInvocation", async () => {
			const chain = makeChainFixture({
				metadata: storedChainMetadata({
					codex: {
						extraArgs: ["--model", "gpt-stale"],
					},
				}),
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.model).toBe("gpt-5.6-sol")
			const invocation = buildRunnerInvocation(runner, "p", { kind: "fresh" }, runnerAuthorizationForTest("/repo/a", PRESET_DIR, "/lr"))
			const modelFlagIndex = invocation.args.indexOf("--model")
			expect(modelFlagIndex).toBeGreaterThanOrEqual(0)
			expect(invocation.args[modelFlagIndex + 1]).toBe("gpt-5.6-sol")
			expect(invocation.args.filter((arg) => arg === "claude-stale")).toEqual([])
		})
	})

	// #456: item.runner override now applies uniformly to every non-trigger phase. The bundled
	// preset's `review` phase has `trigger === null`, so an item-level `runner: "claude"` flows
	// through both `iteration` and `review` — there is no engine-side carve-out keeping `review`
	// on its preset default once the item declares an override. The previous assertion that review
	// stayed on `BINARY:codex` encoded the retired role-name carve-out (`selectReviewRunner` /
	// `lastNonTriggerPhaseForPreset`); after #456's policy unification, every non-trigger phase
	// honors the same override. Phase-name-based gating, when a preset wants it, belongs to preset
	// declaration (e.g., setting `[[phases]].runner` on `review` makes the preset default explicit
	// — but item override still wins because `trigger === null`).
	test("AC5 integration: chain-based phaseRunner honors item claude override on every non-trigger phase (iteration + review), regardless of phase name", async () => {
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
			createItem(fixture.store, chain, { issueNumber: 287_201, repoCwd: "/repo/a", runner: "claude" })

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
				loadedPreset: { presetDir: PRESET_DIR, preset },
				runIdFactory: ({ chain: c, item, phase }) => `run-${c.id}-${item.id}-${phase}-${++runSeq}`,
			})
			delete (baseOptions as { runner?: AgentRunnerSelection }).runner

			const iterTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "iteration",
				prompt: "iter-prompt",
			})
			expect(iterTick.spawnedRuns).toHaveLength(1)
			const iterClosed = await iterTick.spawnedRuns[0]!.closed
			expect(iterClosed.exitCode).toBe(0)
			const iterPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const iterStdout = await readFile(iterPaths.runStdoutFile(iterClosed.runId), "utf-8")
			expect(iterStdout).toContain("BINARY:claude")
			expect(iterStdout).not.toContain("BINARY:codex")

			fixture.store.updateItem(fixture.store.listItems(chain.id)[0]!.id, { status: runtimeStatus("changes_requested") })

			const reviewTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "review",
				prompt: "review-prompt",
			})
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
			expect(reviewClosed.exitCode).toBe(0)
			const reviewStdout = await readFile(iterPaths.runStdoutFile(reviewClosed.runId), "utf-8")
			// Unified policy: item.runner = "claude" propagates to every non-trigger phase, including
			// review under the bundled preset (which has `trigger === null`). The role-named carve-out
			// is gone, so review emits the same `BINARY:claude` as iteration.
			expect(reviewStdout).toContain("BINARY:claude")
			expect(reviewStdout).not.toContain("BINARY:codex")
		} finally {
			await stopFixture(fixture)
		}
	})
})

describe("runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("gates the exported external-terminal path before artifacts and retries after restoration", async () => {
		const fixture = await createFixture("trigger-exported-external-terminal-gate")
		try {
			const root = resolve(fixture.loopDataRoot, "..")
			const binary = resolve(root, "missing-hapi-remote-session")
			const targetCwd = resolve(root, "target")
			const invocationLog = resolve(targetCwd, "invocation.log")
			await mkdir(targetCwd, { recursive: true })
			const chain = createChain(fixture.store, "trigger-exported-external-terminal-gate-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 602_006, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const runId = `trigger-${chain.id}-external-gate`
			const input = {
				chain,
				items: fixture.store.listItems(chain.id),
				runId,
				terminalStatusNames: [runtimeStatus("done")],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
				phaseRunner: () => ({ kind: "hapi", source: "preset", binary, extraArgs: [], model: null } as const),
			}

			const unavailable = await runPresetChainCompleteTriggerPhases(input)
			expect(unavailable).toEqual({
				decision: "keep-active",
				reason: "external terminal hapi unavailable: binary-missing",
			})
			const outputPath = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
				.runPhaseStdoutFile(runId, "umbrella-finalizer")
			expect(existsSync(outputPath)).toBe(false)
			expect(existsSync(invocationLog)).toBe(false)

			await writeFile(binary, `#!/bin/sh
if [ "$1" = probe ]; then exit 0; fi
echo invocation >> ${JSON.stringify(invocationLog)}
echo 'FINALIZER SUMMARY: decision=complete; reason=restored'
`)
			await chmod(binary, 0o755)
			await expect(runPresetChainCompleteTriggerPhases(input)).resolves.toEqual({ decision: "complete" })
			expect(await readFile(invocationLog, "utf-8")).toBe("invocation\n")
			expect(await readFile(outputPath, "utf-8")).toContain("FINALIZER SUMMARY: decision=complete; reason=restored")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("streams chain-complete runner output without retaining full history", async () => {
		const fixture = await createFixture("trigger-large-output")
		try {
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-large-finalizer.sh")
			await writeFile(fakeClaude, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 200000 ]; do echo "trigger-$i"; i=$((i + 1)); done\necho "FINALIZER SUMMARY: decision=complete; reason=large-output"\n`)
			await chmod(fakeClaude, 0o755)
			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-large")
			await mkdir(targetCwd, { recursive: true })
			const chain = createChain(fixture.store, "trigger-large-output-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 630_002, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const runId = `trigger-${chain.id}-large`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items: fixture.store.listItems(chain.id),
				runId,
				terminalStatusNames: [runtimeStatus("done")],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
				phaseRunner: () => ({ kind: "claude", source: "iteration-default", binary: fakeClaude, extraArgs: [], model: null }),
			})
			expect(decision).toEqual({ decision: "complete" })
			const path = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runPhaseStdoutFile(runId, "umbrella-finalizer")
			const output = await readFile(path, "utf-8")
			expect(output).toContain("trigger-199999")
			expect(output.endsWith("FINALIZER SUMMARY: decision=complete; reason=large-output\n")).toBe(true)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("default chain metadata → triggered phase 'umbrella-finalizer' spawns preset codex via chain-derived selectRunnerForPhase", async () => {
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
			const item = createItem(fixture.store, chain, { issueNumber: 287_801, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const items = fixture.store.listItems(chain.id)

			const runId = `trigger-${chain.id}-default`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
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
			await stopFixture(fixture)
		}
	})

	// #433: the legacy `metadata.runner` top-level field is retired. The retirement is enforced at
	// parse time (createChain → parseChainMetadata), so the chain never makes it to the trigger
	// phase code. This locks in the "no silent-ignore" stance: operators who try the old shape get
	// a loud error pointing at the new bindings/per-runner channels.
	test("chain metadata runner='claude' is retired and rejected at chain.create time (#433)", async () => {
		const fixture = await createFixture("trigger-claude-retired")
		try {
			expect(() =>
				createChain(fixture.store, "trigger-claude-retired-chain", {
					metadata: {
						runner: "claude",
						claude: { binary: "fake-claude" },
						codex: { binary: "fake-codex" },
					},
				}),
			).toThrow(/runner is retired \(#433\)/)
		} finally {
			await stopFixture(fixture)
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
			const item = createItem(fixture.store, chain, { issueNumber: 287_803, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
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
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
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
			await stopFixture(fixture)
		}
	})
})

describe("scheduler session-id resume (issue #291 / #311)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("first spawn (no session id for phase/runner): buildRunnerInvocation argv has no --resume; rendered prompt's RESUMED_SESSION_ID is empty (AC6)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const chain = makeChainFixture({ name: "first-spawn-chain" })
		const item = makeItemFixture(chain, { issueNumber: 291_001, repoCwd: "/repo/first-spawn-repo" })

		const decision = resumeDecisionForItem(item, "iteration", "claude")
		expect(decision).toEqual({ kind: "fresh" })

		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "iteration-default", binary: "claude", extraArgs: [], model: null },
			"prompt",
			decision,
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			expect(invocation.args).not.toContain("--resume")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-fresh",
			worktreePath: "/repo/fresh-worktree",
		})
		expect(rendered).toBe("RESUMED_SESSION_ID=[] RESUMED_FROM_PHASE=[] RUN_ID_GENERATION=[new]")
	})

	test("resume spawn (phase/runner session id set): buildRunnerInvocation argv contains --resume <id>; rendered prompt embeds the session id literal (AC4 / AC5)", async () => {
		const preset = await loadPreset(PRESET_DIR)
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
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			const idx = invocation.args.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(invocation.args[idx + 1]).toBe("sess-deadbeef-cafe")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-resume",
			worktreePath: "/repo/resume-worktree",
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
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
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
			// Single iteration spawn: the fake session runner writes no status, so drive exactly one
			// tick rather than run-until-idle (which would auto-advance to review and reuse the runId).
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			const refreshed = fixture.store.getItem(item.id)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-captured-001")
		} finally {
			await stopFixture(fixture)
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
			// Single iteration spawn (see note above): one tick captures the seeded session id on argv.
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			// #405: phase-aware runIdFactory — single iteration tick yields the iteration phase's
			// first attempt.
			const runId = `run-${chain.id}-${item.id}-iteration-1`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const argvLine = stdout.split("\n").find((line) => line.startsWith("{") && line.includes("\"argv\""))
			expect(argvLine).toBeDefined()
			const argv = JSON.parse(argvLine!) as { argv: string[] }
			const idx = argv.argv.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(argv.argv[idx + 1]).toBe("sess-seeded-200")
		} finally {
			await stopFixture(fixture)
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
			// Single iteration spawn (see note above): one tick captures the codex thread id after exit.
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			const refreshed = fixture.store.getItem(item.id)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-captured-002")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("end-to-end two-phase run stores iteration/codex and review/claude session ids separately (issue #311 AC2 / AC3)", async () => {
		const fixture = await createFixture("session-id-capture-phase-runner")
		try {
			const chain = createChain(fixture.store, "session-id-capture-phase-runner-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 311_010, repoCwd: "/repo/session-phase-runner" })
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-session.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-session.ts")
			await writeFakeCodexSessionShellRunner(fakeCodex, "thread-iteration-311")
			await writeFakeClaudeSessionRunner(fakeClaude, "sess-review-311")

			const sessionOptions = fixture.options({
				phaseRunner: ({ phase }) =>
					phase === "iteration"
						? { kind: "codex", source: "iteration-default", binary: fakeCodex, extraArgs: [], model: null }
						: { kind: "claude", source: "review-default", binary: "bun", extraArgs: [fakeClaude], model: null },
				runIdFactory: ({ chain, item, phase }) => `run-${chain.id}-${item.id}-${phase}`,
			})
			// Drive the two phases explicitly: the fake session runners write no status, so
			// run-until-idle would auto-advance iteration→review reusing the runId. Between ticks,
			// set the item to a pending-eligible status so the explicit review tick selects it.
			const iterTick = await schedulerTick({ ...sessionOptions, phase: "iteration" })
			await iterTick.spawnedRuns[0]!.closed
			fixture.store.updateItem(item.id, { status: runtimeStatus("changes_requested"), updatedAt: 1_800_000_500 })
			const reviewTick = await schedulerTick({ ...sessionOptions, phase: "review" })
			await reviewTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-iteration-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("sess-review-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "codex" })).toBeNull()
		} finally {
			await stopFixture(fixture)
		}
	})

	test("session-id-invalid stderr clears the phase/runner slot and the next spawn is fresh (issue #312 AC3)", async () => {
		const fixture = await createFixture("session-id-invalid-fresh")
		try {
			const chain = createChain(fixture.store, "session-id-invalid-fresh-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 312_003, repoCwd: "/repo/session-id-invalid" })
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-stale-312" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-invalid-once.ts")
			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			await mkdir(chainPaths.evidenceDir, { recursive: true })
			const attemptFile = resolve(chainPaths.evidenceDir, "fake-claude-invalid-attempt.txt")
			await writeFakeClaudeInvalidOnceRunner(fakeRunner, attemptFile, "sess-fresh-312")
			let now = 1_800_312_000
			let runSequence = 0

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner, attemptFile], model: null },
				runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}-${++runSequence}`,
				now: () => now,
				spawnFailureBackoff: { initialSeconds: 1, maxSeconds: 2 },
			})

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			const firstClosed = await firstTick.spawnedRuns[0]!.closed
			expect(firstClosed.exitCode).toBe(1)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStderrFile(firstClosed.runId), "utf-8")).toContain("No conversation found with session ID: sess-stale-312")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "session_id.invalidated",
				itemId: item.id,
				phase: "iteration",
				runner: "claude",
				previousSessionId: "sess-stale-312",
			}))

			// The agent exited non-zero without writing a status, so the spawn-set in_progress
			// remains; model the daemon recovery back to a continuable status so the next tick
			// re-selects a fresh iteration spawn rather than advancing to review.
			fixture.store.updateItem(item.id, { status: runtimeStatus("changes_requested"), phase: null, updatedAt: now })

			now += 2
			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			const secondClosed = await secondTick.spawnedRuns[0]!.closed
			expect(secondClosed.exitCode).toBe(0)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-fresh-312")

			const argvEvents = await readArgvEvents(fixture.eventLogForChain(chain.name))
			expect(argvEvents).toHaveLength(2)
			expect(argvEvents[0]?.argv).toContain("--resume")
			expect(argvEvents[0]?.argv).toContain("sess-stale-312")
			expect(argvEvents[1]?.argv).not.toContain("--resume")
			expect(argvEvents[1]?.argv).not.toContain("sess-stale-312")
		} finally {
			await stopFixture(fixture)
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
			}))
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-new-312")
			expect(fixture.schedulerEvents.some((event) => event.type === "session_id.invalidated")).toBe(false)
		} finally {
			await stopFixture(fixture)
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
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
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
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
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
		.map((line) => JSON.parse(line) as BoundaryRecord)
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

// #457: chain umbrella values now live inside `metadata.bindings`. `makeChainFixture` accepts
// `umbrellaIssue` / `umbrellaRepo` as shorthand overrides and folds them into the metadata so the
// large number of existing call sites do not have to be touched. The shorthand is fixture-only;
// engine code never sees it as a ChainRecord first-class field.
type ChainFixtureOverrides = Partial<ChainRecord> & {
	umbrellaIssue?: number | null
	umbrellaRepo?: string | null
}

function makeChainFixture(overrides: ChainFixtureOverrides = {}): ChainRecord {
	const { umbrellaIssue, umbrellaRepo, metadata, ...rest } = overrides
	const explicitMetadata = metadata !== undefined
	const bindingsOverride: JsonObject = {}
	if (umbrellaIssue !== undefined && umbrellaIssue !== null) bindingsOverride.umbrellaIssue = umbrellaIssue
	if (umbrellaRepo !== undefined && umbrellaRepo !== null) bindingsOverride.umbrellaRepo = umbrellaRepo
	const resolvedMetadata = explicitMetadata
		? metadata
		: storedChainMetadata(Object.keys(bindingsOverride).length > 0
			? { bindings: { umbrellaIssue: 282, umbrellaRepo: "mouriya-s-lab/coder-loop", ...bindingsOverride } }
			: { bindings: { umbrellaIssue: 282, umbrellaRepo: "mouriya-s-lab/coder-loop" } })
	return {
		id: 1,
		name: "phase-runner-fixture",
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		status: "active",
		metadata: resolvedMetadata,
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_000,
		...rest,
	}
}

// #419: ItemRecord lost top-level `issueNumber` / `branch` / `pr`. Shim params for fixture
// callers; fold them into `itemId` / `extra` so the call sites stay legible.
type MakeItemFixtureOverrides = Partial<Omit<ItemRecord, "extra">> & {
	extra?: ItemRecord["extra"]
	issueNumber?: number
	branch?: string | null
	pr?: number | null
	repoCwd: string
}

function makeItemFixture(chain: ChainRecord, overrides: MakeItemFixtureOverrides): ItemRecord {
	const { extra, issueNumber, branch, pr, ...rest } = overrides
	let resolvedExtra = extra ?? storedItemExtra({})
	if (branch !== undefined || pr !== undefined) {
		const flat = itemExtraToJsonObject(resolvedExtra)
		if (branch !== undefined && branch !== null) flat.branch = branch
		if (pr !== undefined && pr !== null) flat.pr = pr
		resolvedExtra = storedItemExtra(flat)
	}
	return {
		id: 1,
		chainId: chain.id,
		itemId: rest.itemId ?? String(issueNumber ?? 0),
		status: parseInternalStatus("queued", "test.status"),
		attempts: 0,
		position: 0,
		title: null,
		priority: null,
		lastRunId: null,
		sessionIds: {},
		issueFile: null,
		evidenceDir: null,
		agentCwd: null,
		runner: null,
		phase: null,
		// #412: per-item preset declaration; default null in fixtures so chain.preset fallback applies.
		preset: null,
		presetPath: null,
		extra: resolvedExtra,
		createdAt: 1_800_000_001,
		updatedAt: 1_800_000_001,
		statusUpdatedAt: 1_800_000_001,
		...rest,
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

async function initGitTarget(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
	gitOutput(path, ["init", "-q"])
	gitOutput(path, ["config", "user.email", "test@example.invalid"])
	gitOutput(path, ["config", "user.name", "Test User"])
	await writeFile(resolve(path, "README.md"), "test\n")
	gitOutput(path, ["add", "README.md"])
	gitOutput(path, ["commit", "-qm", "init"])
}

function gitOutput(cwd: string, args: readonly string[]): string {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	const stdout = new TextDecoder().decode(proc.stdout).trim()
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim()
		throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${proc.exitCode}): ${stderr}`)
	}
	return stdout
}

type Fixture = {
	store: ReturnType<typeof openSqliteStateStore>
	daemon?: CoderLoopDaemon
	state: ReturnType<typeof createSchedulerState>
	loopDataRoot: string
	eventLogForChain: (chainName: string) => string
	schedulerEvents: SchedulerEvent[]
	worktreeCalls: string[]
	fakeRunner: string
	options: (overrides?: SchedulerFixtureOverrides) => SchedulerOptions
}

async function stopFixture(fixture: Fixture): Promise<void> {
	if (fixture.daemon !== undefined) {
		await fixture.daemon.stop()
		fixtureDaemons.delete(fixture.daemon)
	}
	fixture.store.close()
}

type SchedulerFixtureOverrides = Partial<Omit<SchedulerOptions, "presetForChain">> & {
	loadedPreset?: SchedulerLoadedPreset
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
	const eventLogForChain = (chainName: string): string => resolve(resolveChainRuntimePaths(chainName, { loopDataRoot }).runsDir, "runner-events.jsonl")
	const fixturePresetDir = resolve(root, "preset")
	const fixtureEvidenceDir = resolve(loopDataRoot, "fixture-evidence")
	await mkdir(fixtureEvidenceDir, { recursive: true })
	await writeFakeRunner(fakeRunner)
	await cp(resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"), fixturePresetDir, { recursive: true })
	const presetTomlPath = resolve(fixturePresetDir, "preset.toml")
	const presetToml = await readFile(presetTomlPath, "utf-8")
	const iterationHeader = 'roles  = ["common", "quality", "iter"]'
	const fixtureExits = ["changes_requested", "blocked", "moot", "done", "exhausted"]
		.map((status) => `\n  [[phases.exits]]\n  status = "${status}"\n  when = "scheduler fixture status"\n`)
		.join("")
	await writeFile(presetTomlPath, presetToml.replace(iterationHeader, iterationHeader + fixtureExits))

	const store = openSqliteStateStore({ loopDataRoot })
	fixturePresetDirs.set(store, fixturePresetDir)
	fixtureCaptureRoots.set(store, fixtureEvidenceDir)
	const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
	fixtureDaemons.add(daemon)
	const state = daemon.schedulerExecutionState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeCalls: string[] = []
	const defaultPresetDir = fixturePresetDir
	const defaultLoadedPreset = await loadedPresetFromDir(defaultPresetDir)
	if (defaultLoadedPreset.preset.phases.find((phase) => phase.name === "iteration")?.exits.length === 0) throw new Error("scheduler fixture preset did not declare iteration exits")
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		worktreeCalls.push(worktreePath)
		return worktreePath
	}

	const options = (overrides: SchedulerFixtureOverrides = {}): SchedulerOptions => {
		const { loadedPreset = defaultLoadedPreset, ...schedulerOverrides } = overrides
		if (overrides.loadedPreset !== undefined) {
			for (const chain of store.listChains()) {
				const metadata = chainMetadataToJsonObject(chain.metadata)
				metadata.presetPath = loadedPreset.presetDir
				store.updateChain(chain.id, { metadata: storedChainMetadata(metadata) })
				for (const item of store.listItems(chain.id)) store.updateItem(item.id, { presetPath: loadedPreset.presetDir })
			}
		}
		return {
			store,
			state,
			presetForChain: () => loadedPreset,
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runCredentials: daemon.buildSchedulerRunCredentialIssuer(),
			runIdFactory: makeAttemptTrackingRunIdFactory(),
			prompt: ({ chain, item, runId, worktreePath, phase }) => {
			const extra = itemExtraToJsonObject(item.extra)
			const payload: BoundaryRecord = {
				itemId: item.id,
				issueNumber: Number(item.itemId),
				chainName: chain.name,
				runId,
				worktreePath,
				eventLog: eventLogForChain(chain.name),
				sleepMs: typeof extra.sleepMs === "number" ? extra.sleepMs : 5,
				exitCode: typeof extra.exitCode === "number" ? extra.exitCode : 0,
				// v1 status model: the fake runner writes this status to the store itself, simulating the
				// real agent's `coder-loop item update --status`. The scheduler only reads item.status; it
				// never derives status from the runner's stdout or exit code.
				writeStatus: fakeRunnerWriteStatus(phase, extra),
			}
			if (Object.prototype.hasOwnProperty.call(extra, "summary")) payload.summary = extra.summary
			if (typeof extra.captureArgv === "string") payload.captureArgv = extra.captureArgv
			if (typeof extra.probeNullDevice === "boolean") payload.probeNullDevice = extra.probeNullDevice
			return JSON.stringify(payload)
		},
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
			...schedulerOverrides,
		}
	}

	return { store, daemon, state, loopDataRoot, eventLogForChain, schedulerEvents, worktreeCalls, fakeRunner, options }
}

function persistedObservabilityOptions(fixture: Fixture, overrides: SchedulerFixtureOverrides = {}): SchedulerOptions {
	const options = fixture.options(overrides)
	const baseOnEvent = options.onEvent
	return {
		...options,
		onEvent: async (event) => {
			await baseOnEvent?.(event)
			await appendPersistedSchedulerEvent(fixture, event)
		},
	}
}

async function appendPersistedSchedulerEvent(fixture: Fixture, event: SchedulerEvent): Promise<void> {
	const chain = fixture.store.getChain(event.chainId)
	if (chain === null) throw new Error(`missing chain ${event.chainId} for scheduler event ${event.type}`)
	await appendObservabilityEvent(
		resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
		schedulerEventToObservabilityEvent(chain, event),
	)
}

async function loadedPresetFromDir(presetDir: string): Promise<SchedulerLoadedPreset> {
	return { presetDir, preset: await loadPreset(presetDir) }
}

// #457: chain umbrella values now flow through `metadata.bindings.umbrellaIssue / umbrellaRepo`.
// Fixture helper accepts `umbrellaIssue` / `umbrellaRepo` as shorthand overrides and folds them into
// metadata so call sites do not have to change shape. Engine code never sees the shorthand.
type CreateChainShorthandOverrides = Omit<Partial<Parameters<ReturnType<typeof openSqliteStateStore>["createChain"]>[0]>, "metadata"> & {
	metadata?: JsonObject
	umbrellaIssue?: number | null
	umbrellaRepo?: string | null
}

function createChain(
	store: ReturnType<typeof openSqliteStateStore>,
	name: string,
	overrides: CreateChainShorthandOverrides = {},
): ChainRecord {
	const { metadata, umbrellaIssue, umbrellaRepo, ...rest } = overrides
	const baseBindings: JsonObject = {
		umbrellaIssue: umbrellaIssue ?? 176,
		umbrellaRepo: umbrellaRepo ?? "mouriya-s-lab/coder-loop",
	}
	const baseMetadata: JsonObject = metadata !== undefined && Object.hasOwn(metadata, "bindings")
		? { ...metadata }
		: { ...(metadata ?? {}), bindings: baseBindings }
	const fixturePresetDir = fixturePresetDirs.get(store)
	if (fixturePresetDir !== undefined) baseMetadata.presetPath = fixturePresetDir
	return store.createChain({
		name,
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		status: "active",
		metadata: storedChainMetadata(baseMetadata),
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_000,
		...rest,
	})
}

// #456: `preInstallReviewOnEmptyLock` helper retired with the review-on-empty path. The helper
// existed only to suppress that legacy auto-fired phase during tests of chain completion; once the
// path is gone, every former call site became deletable noise (no behavior change to delete).

function createItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	input: { issueNumber: number; repoCwd: string; sleepMs?: number; exitCode?: number; summary?: string | null; runner?: AgentRunnerKind | null; writeStatus?: string | null; captureArgv?: string; probeNullDevice?: boolean },
) {
	const extra: JsonObject = {
		// #419: the bundled preset's `idField` is `issue` and reads from `extra.issue` via the
		// preset-declared transparent-field path. Carry the value into extra so `{{ISSUE}}`
		// renders in the spawn prompt (where the engine's `lookupItemField("issue")` resolves
		// to `extra.issue`).
		issue: input.issueNumber,
		sleepMs: input.sleepMs ?? 5,
		exitCode: input.exitCode ?? 0,
	}
	if (Object.prototype.hasOwnProperty.call(input, "summary")) extra.summary = input.summary ?? null
	// #405: tests can pin the fake-runner's status-write decision directly via `extra.writeStatus`,
	// mirroring the real agent's `coder-loop item update --status` call. When omitted the
	// fake runner falls back to the phase-aware default (see fakeRunnerWriteStatus).
	if (Object.prototype.hasOwnProperty.call(input, "writeStatus")) extra.writeStatus = input.writeStatus ?? null
	if (input.captureArgv !== undefined) extra.captureArgv = input.captureArgv
	if (input.probeNullDevice !== undefined) extra.probeNullDevice = input.probeNullDevice
	const item = store.createItem({
		chainId: chain.id,
		itemId: String(input.issueNumber),
		repoCwd: input.repoCwd,
		runner: input.runner ?? null,
		status: runtimeStatus("queued"),
		presetPath: fixturePresetDirs.get(store) ?? null,
		evidenceDir: fixtureCaptureRoots.get(store) ?? null,
		attempts: 0,
		title: `issue ${input.issueNumber}`,
		extra: storedItemExtra(extra),
		createdAt: 1_800_000_001 + input.issueNumber,
		updatedAt: 1_800_000_001 + input.issueNumber,
	})
	if (item.presetPath !== (fixturePresetDirs.get(store) ?? null)) throw new Error("scheduler fixture item lost its declared preset path")
	return item
}

async function writeFakeRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	const loopEntry = resolve(REPO_ROOT, "src/loop.ts")
	await writeFile(
		path,
		`#!/usr/bin/env bun
import { appendFile, writeFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? Bun.argv.at(-1) ?? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
if (typeof input.captureArgv === "string") await writeFile(input.captureArgv, JSON.stringify(Bun.argv.slice(2)))
if (input.probeNullDevice === true) await writeFile("/dev/null", "probe")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
console.log("done:" + input.itemId)
const summary = Object.prototype.hasOwnProperty.call(input, "summary") ? input.summary : "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=fake-runner default"
if (summary !== null) console.log(summary)
// v1 status model: the agent owns its item status. Write it through the same SQLite store the
// scheduler reads (the daemon's loop-data-root is passed via CODER_LOOP_DATA_DIR), mirroring a real
// agent's \`coder-loop item update --status\`. A null writeStatus means the agent wrote nothing, so the
// item keeps the entry status it had at spawn (continuable).
if (typeof input.writeStatus === "string" && input.itemId > 0) {
	const update = Bun.spawnSync({ cmd: ["bun", ${JSON.stringify(loopEntry)}, "item", "update", input.chainName, "--issue", String(input.issueNumber), "--status", input.writeStatus], stdout: "pipe", stderr: "pipe" })
	if (update.exitCode !== 0) {
		process.stderr.write(new TextDecoder().decode(update.stderr))
		process.exit(update.exitCode)
	}
}
process.exit(input.exitCode)
`,
		)
	await chmod(path, 0o755)
	}

async function writeFakeExternalTerminalBinary(
	path: string,
	probeStatePath: string,
	eventLogPath: string,
	invocationSeconds: number,
	spawnEventLogPath: string = eventLogPath,
): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(path, [
		"#!/bin/sh",
		`if [ "$1" = "probe" ]; then state="$(cat ${JSON.stringify(probeStatePath)})"; echo probe >> ${JSON.stringify(eventLogPath)}; if [ "$state" = "wait-69" ]; then echo probe-waiting >> ${JSON.stringify(eventLogPath)}; while [ ! -f ${JSON.stringify(`${probeStatePath}.release`)} ]; do sleep 0.01; done; exit 69; fi; exit "$state"; fi`,
		`echo spawn >> ${JSON.stringify(spawnEventLogPath)}`,
		"trap 'exit 0' TERM",
		`sleep ${invocationSeconds}`,
	].join("\n") + "\n")
	await chmod(path, 0o755)
}

async function waitForFileText(path: string, expected: string): Promise<void> {
	while (!(await readFile(path, "utf-8")).includes(expected)) {
		await new Promise((resolveDone) => setTimeout(resolveDone, 5))
	}
}

async function writeThreeStepPreset(presetDir: string): Promise<void> {
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "alpha.md"), "# alpha\n")
	await writeFile(resolve(presetDir, "beta.md"), "# beta\n")
	await writeFile(resolve(presetDir, "gamma.md"), "# gamma\n")
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "three-step"
version = 1
description = "Three non-trigger phase fixture."

[item]
idField = "issue"

[statuses]
continuable = ["queued", "changes_requested"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[agent]
binary = "codex"

	[[phases]]
	name = "alpha"
	prompt = "alpha.md"

	  [phases.variables]
	  ISSUE = "item.issue"
	  LOG_DIR = "runtime.logDir"

	[[phases]]
	name = "beta"
	prompt = "beta.md"

	  [phases.variables]
	  ISSUE = "item.issue"
	  LOG_DIR = "runtime.logDir"

	[[phases]]
	name = "gamma"
	prompt = "gamma.md"

	  [[phases.exits]]
	  status = "done"
	  when = "gamma accepted"

	  [phases.variables]
	  ISSUE = "item.issue"
	  LOG_DIR = "runtime.logDir"
`,
	)
}

async function writeEmptySuccessPreset(presetDir: string): Promise<void> {
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "run.md"), "# run\n")
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "empty-success"
version = 1
description = "Fixture preset with no success terminal statuses."

[item]
idField = "issue"

[statuses]
continuable = ["queued"]
terminal = ["blocked", "done", "exhausted"]
success = []
entry = "queued"
exhausted = "exhausted"

[agent]
binary = "codex"

[[phases]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edge so R2 passes for "queued". The empty-success
  # test asserts dependency-unblock semantics; the exit set is inert from the
  # test's perspective.
  [[phases.exits]]
  status = "done"
  when = "Run finished cleanly; item lands in a terminal status."
	`,
	)
}

// #402: fixture preset whose `statuses.exhausted` declaration points at a non-default
// terminal label, so the scheduler test can assert the落点 status flows from preset metadata
// rather than the retired engine literal "exhausted".
async function writeCustomExhaustedPreset(presetDir: string): Promise<void> {
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "run.md"), "# run\n")
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "custom-exhausted"
version = 1
description = "Fixture preset whose attempts-exhausted落点 is a non-default terminal label."

[item]
idField = "issue"

[statuses]
continuable = ["queued"]
terminal = ["done", "custom_exhausted"]
success = ["done"]
entry = "queued"
exhausted = "custom_exhausted"

[agent]
binary = "codex"

[[phases]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edge so R2 passes for "queued". The scheduler
  # attempts-exhausted test only cares about the engine writing
  # custom_exhausted via the retry-budget sink, which is independent of this
  # preset-declared phase exit.
  [[phases.exits]]
  status = "done"
  when = "Run finished cleanly; item lands in success-terminal vocabulary."
`,
	)
}

// #402: fixture preset that omits the required `statuses.exhausted` declaration so the
// loader rejects it. The previous shape (terminal vocab without "exhausted") used to silently
// disable the engine's attempts-exhausted transition; the D2 verdict retired that opt-out, so
// the new test asserts the load-time error instead.
async function writeMissingExhaustedDeclarationPreset(presetDir: string): Promise<void> {
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "run.md"), "# run\n")
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "missing-exhausted-declaration"
version = 1
description = "Fixture preset that omits the required statuses.exhausted declaration (#402)."

[item]
idField = "issue"

[statuses]
continuable = ["queued"]
terminal = ["done"]
success = ["done"]
entry = "queued"

[agent]
binary = "codex"

[[phases]]
name = "run"
prompt = "run.md"
`,
	)
}

// #405: fake-runner status decision no longer parses a stdout verdict marker. Tests
// drive the desired status via `extra.writeStatus` (the mirror of the real agent's
// `coder-loop item update --status` write). Defaults preserve historical behavior:
// trigger phases write nothing, iteration leaves status to the next phase via the
// trigger DAG, review defaults to `done` when no explicit writeStatus is set.
// #456: `review-on-empty` removed from this fake-runner trigger set together with the path
// itself. Only the preset-declared item-trigger / chain-complete-trigger phases remain.
const TRIGGER_PHASES = new Set(["blocked-responder", "umbrella-finalizer"])

function fakeRunnerWriteStatus(phase: string, extra: JsonObject): string | null {
	if (TRIGGER_PHASES.has(phase)) return null
	const exitCode = typeof extra.exitCode === "number" ? extra.exitCode : 0
	if (exitCode !== 0) return "changes_requested"
	const writeStatusOverride = extra.writeStatus
	if (typeof writeStatusOverride === "string") return writeStatusOverride
	if (writeStatusOverride === null) return null
	if (phase === "iteration") return null
	if (phase === "review") return "done"
	return null
}

// #405: per-(chain,item,phase) attempt-tracking runIdFactory. The retired
// verdict mapper used to mask multi-phase progression by mapping any
// "REVIEW SUMMARY" stdout line to "done" even when the spawned phase was
// iteration — items therefore landed terminal on a single iteration run and
// the deterministic factory `run-${chain.id}-${item.id}` never collided. With
// the verdict mapper gone, items legitimately spawn iteration then review then
// (on retry) iteration again; the runId must be unique per spawn or the
// scheduler trips a `runs.run_id` UNIQUE constraint. A per-(chain,item,phase)
// counter keeps the runId deterministic enough for assertions while guaranteeing
// uniqueness across spawns.
function makeAttemptTrackingRunIdFactory(): (context: { chain: { id: number }; item: { id: number }; phase: string }) => string {
	const attempts = new Map<string, number>()
	return ({ chain, item, phase }) => {
		const key = `${chain.id}-${item.id}-${phase}`
		const next = (attempts.get(key) ?? 0) + 1
		attempts.set(key, next)
		return `run-${chain.id}-${item.id}-${phase}-${next}`
	}
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
	const eventLogForChain = (chainName: string): string => resolve(resolveChainRuntimePaths(chainName, { loopDataRoot }).runsDir, "runner-events.jsonl")
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
	const loadedPreset = await loadedPresetFromDir(presetDir)

	const options = (overrides: SchedulerFixtureOverrides = {}): SchedulerOptions => {
		const { loadedPreset: overrideLoadedPreset = loadedPreset, ...schedulerOverrides } = overrides
		return {
			store,
			state,
			presetForChain: () => overrideLoadedPreset,
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			runIdFactory: makeAttemptTrackingRunIdFactory(),
			prompt: async (ctx) => {
				const phase = ctx.loadedPreset.preset.phases.find((entry) => entry.name === ctx.phase)
				if (phase === undefined) throw new Error(`fixture preset ${ctx.loadedPreset.preset.name} does not define phase ${ctx.phase}`)
				const raw = await readFile(phase.prompt, "utf-8")
				return substitutePresetRootToken(raw, ctx.loadedPreset.preset.presetDir)
			},
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
			...schedulerOverrides,
		}
	}

	return { store, state, loopDataRoot, eventLogForChain, schedulerEvents, worktreeCalls, fakeRunner, options }
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

describe("per-run summary tag", () => {
	// #452: `makeRunSummaryTag` / `extractSummaryValue` and their per-run nonce-tag
	// contract were retired together with the summary-injection prompt path and the
	// stdout-driven completion watchdog. The two tests this block used to host (unique
	// nonce per call, foreign tags ignored) had no production consumer left after the
	// retirement — both surfaces only mattered for the stdout-summary completion signal.
	// The successor surface, recycle-zone semantics, is exercised in `daemon.test.ts`
	// against the real daemon+scheduler integration (acceptance rows #1–#4 there).

	// #448: preset-supplied business key literals must flow through the real
	// spawn render path (renderSchedulerSpawnPrompt -> buildSchedulerResolveContext
	// -> renderPrompt). The bundled fixture preset uses the path / key / variable
	// / expected value pinned by issue #448's acceptance contract.
	test("renderSchedulerSpawnPrompt resolves business-key-example fixture preset's preset-supplied literal", async () => {
		const preset = await loadPreset(resolve(REPO_ROOT, "presets/business-key-example"))
		const phase = preset.phases.find((entry) => entry.name === "audit")
		expect(phase).toBeDefined()
		const chain: ChainRecord = {
			id: 1,
			name: "business-key-example-test-chain",
			preset: null,
			repository: "owner/repo",
			baseBranch: "main",
			status: "active",
			metadata: storedChainMetadata({}),
			createdAt: 0,
			updatedAt: 0,
		}
		const item: ItemRecord = {
			id: 1,
			chainId: 1,
			itemId: "1",
			repoCwd: "/fake",
			status: parseInternalStatus("pending", "test.status"),
			attempts: 0,
			position: 0,
			title: null,
			priority: null,
			lastRunId: null,
			sessionIds: {},
			issueFile: null,
			evidenceDir: null,
			agentCwd: null,
			runner: null,
			phase: null,
			preset: null,
			presetPath: null,
			extra: storedItemExtra({}),
			createdAt: 0,
			updatedAt: 0,
			statusUpdatedAt: 0,
		}
		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "{{AUDIT_DEMO}}",
			preset,
			phase: "audit",
			chain,
			item,
			runId: "run-bk-fixture",
			worktreePath: "/fake",
			resume: { kind: "fresh" },
		})
		expect(rendered).toBe("business-key-e2e-ok")
	})
})
