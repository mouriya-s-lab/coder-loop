import { LOOP_ENTRY, PRESET_DIR, REPO_ROOT, TEST_ROOT, daemonRequest, describe, expect, expectOk, isPidAlive, itemExtraToJsonObject, listChainRuns, mkdir, numberValue, openSqliteStateStore, pathExists, pathIsSocket, queryObservabilityEvents, readCurrentRun, readFile, readItem, readRun, readdir, record, request, resolve, resolveChainRuntimePaths, resolveLoopDataPaths, rm, runtimeStatus, sendDaemonRequest, spawn, staleRecoveryRunExtra, startCoderLoopDaemon, startFixture, storedChainMetadata, storedItemExtra, test, unlink, waitFor, waitForPidExit, writeFakeRunner } from "./harness"
import type { SchedulerEvent, SchedulerWorktreeManager } from "./harness"
let nextFixtureId = 0

describe("daemon", () => {
	test("daemon startup skips invalid existing chain rows", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-invalid-existing-chain`)
		const loopDataRoot = root + "-loop-data"
		await mkdir(loopDataRoot, { recursive: true })
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			store.createChain({
				name: "..",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: storedChainMetadata({}),
			})
			store.createChain({
				name: "valid-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: storedChainMetadata({}),
			})
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			expect(daemon.snapshot().running).toBe(true)
			const listed = expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.list"))).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(2)
			expect(await pathExists(resolveChainRuntimePaths("valid-chain", { loopDataRoot }).sharedFile)).toBe(true)
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup repairs missing chain shared handoff file", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-repair-shared-handoff`)
		const loopDataRoot = root + "-loop-data"
		await mkdir(loopDataRoot, { recursive: true })
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			store.createChain({
				name: "repair-shared-handoff",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: storedChainMetadata({}),
			})
		} finally {
			store.close()
		}

		const paths = resolveChainRuntimePaths("repair-shared-handoff", { loopDataRoot })
		await mkdir(paths.issuesDir, { recursive: true })
		await mkdir(paths.evidenceDir, { recursive: true })
		await mkdir(paths.runsDir, { recursive: true })
		await rm(paths.sharedFile, { force: true })

		const daemon = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			expect(daemon.snapshot().running).toBe(true)
			await expect(Bun.file(paths.sharedFile).exists()).resolves.toBe(true)
			await expect(readFile(paths.sharedFile, "utf-8")).resolves.toBe("# Shared durable context\n\n")
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup quarantines chain directories missing from DB", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-chain-directory`)
		const loopDataRoot = root + "-loop-data"
		const orphanPath = resolve(loopDataRoot, "chains", "Z", "issues")
		await mkdir(orphanPath, { recursive: true })

		const daemon = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			expect(daemon.snapshot().running).toBe(true)
			expect(await pathExists(resolve(loopDataRoot, "chains", "Z"))).toBe(false)
			const entries = await readdir(resolve(loopDataRoot, "chains"))
			const orphanDir = entries.find((entry) => entry.startsWith(".orphan-"))
			expect(orphanDir).toBeDefined()
			if (orphanDir === undefined) throw new Error("expected orphan quarantine directory")
			expect(await pathExists(resolve(loopDataRoot, "chains", orphanDir, "Z", "issues"))).toBe(true)
			const listed = expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.list"))).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await daemon.stop()
		}
	})

	test("socket repair failure does not kill daemon", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `${++nextFixtureId}-socket-repair-failure-process`)
		const socketPath = resolve(loopDataRoot, "daemon.sock")
		const pidFile = resolve(loopDataRoot, "daemon.pid")
		await mkdir(loopDataRoot, { recursive: true })
		const daemonProcess = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100", "--json"],
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_RUN_CRED: undefined },
		})
		try {
			await waitFor(
				async () => await pathExists(socketPath) && await pathIsSocket(socketPath) && await pathExists(pidFile),
				Boolean,
				5_000,
			)
			const daemonPid = Number((await readFile(pidFile, "utf-8")).trim())

			await unlink(socketPath)
			await mkdir(socketPath)
			await new Promise((resolveWait) => setTimeout(resolveWait, 600))
			expect(isPidAlive(daemonPid)).toBe(true)

			await rm(socketPath, { recursive: true })
			await waitFor(async () => await pathExists(socketPath) && await pathIsSocket(socketPath), Boolean, 5_000)
			expect(expectOk(await sendDaemonRequest(socketPath, daemonRequest("daemon.down"))).shutdown).toBe(true)
			expect(await daemonProcess.exited).toBe(0)
			expect(await pathExists(socketPath)).toBe(false)
			expect(await pathExists(pidFile)).toBe(false)
			const stderr = await new Response(daemonProcess.stderr).text()
			expect(stderr).toContain("coder-loop daemon socket repair failed:")
			expect(stderr).toContain(socketPath)
		} finally {
			await rm(socketPath, { recursive: true, force: true })
			daemonProcess.kill()
			await daemonProcess.exited
		}
	})

	test("daemon startup kills stale process group and clears current_run without rewriting item business fields (#508)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-recovery`)
		const loopDataRoot = root + "-loop-data"
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")

		const sessionIdsSnapshot = { iteration: { claude: "session-iter-217" } }
		const agentCwdSnapshot = resolve(root, "worktree")
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "startup-recovery-chain",
				preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
			const item = store.createItem({
				chainId: chain.id,
				itemId: "217",
				repoCwd: REPO_ROOT,
				status: runtimeStatus("in_progress"),
				attempts: 1,
					lastRunId: "run-stale-217",
					phase: "iteration",
					agentCwd: agentCwdSnapshot,
					title: "stale item",
					sessionIds: sessionIdsSnapshot,
					extra: storedItemExtra({}),
				})
			store.recordRun({
				runId: "run-stale-217",
				chainId: chain.id,
					itemId: item.id,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(agentCwdSnapshot),
				})
			store.setCurrentRun({
				chainId: chain.id,
					phase: "iteration",
					runId: "run-stale-217",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ itemId: item.id, pid: stale.pid, processGroupLeader: true }),
				})
			store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "session-iter-217" })
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 50,
			scheduler: { enabled: false },
		})
		try {
			expect(await waitForPidExit(stale.pid, 1_000)).toBe(true)
			const recovered = await readItem(loopDataRoot, 1, 217)
			// #508 predicted result #1: status / phase / sessionIds preserved (daemon recovery
			// no longer rewrites business fields).
			expect(recovered?.status).toBe("in_progress")
			expect(recovered?.phase).toBe("iteration")
			expect(recovered?.sessionIds).toEqual({})
			const recoveredStore = openSqliteStateStore({ loopDataRoot })
			try {
				expect(recoveredStore.getItemSessionId(recovered?.id ?? 0, { phase: "iteration", runner: "claude" })).toBe(sessionIdsSnapshot.iteration.claude)
			} finally {
				recoveredStore.close()
			}
			expect(recovered?.attempts).toBe(1)
			// Process-layer cleanup still happens: the orphan `current_runs` row is gone.
			expect(await readCurrentRun(loopDataRoot, 1)).toBeNull()
			// #508 predicted result #3: chain summary surfaces the interrupted in_progress item
			// as a stale candidate (current_runs cleared → no active run for this rowid) so the
			// scheduler will re-spawn it on the next tick.
			const status = record(expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.status", { chainName: "startup-recovery-chain" }))))
			const recoverySummary = record(record(status.summary).recovery)
			expect(recoverySummary.needed).toBe(true)
			expect(recoverySummary.staleInProgressItems).toEqual([{
				rowId: recovered?.id ?? null,
				itemId: "217",
				runId: "run-stale-217",
				repoCwd: REPO_ROOT,
				agentCwd: agentCwdSnapshot,
			}])
			const recoveryEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot }).eventsFile, { type: "scheduler.recovery", run: "run-stale-217" })).events
			expect(recoveryEvents).toHaveLength(1)
			expect(recoveryEvents[0]).toMatchObject({
				runId: "run-stale-217",
				runtimeNodeId: "closure-node:1:iteration",
				definitionRef: { kind: "preset", contentIdentity: "sha256:daemon-recovery-fixture" },
				definitionNodeId: "task:iteration",
			})
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already reaped by daemon startup recovery.
				}
			}
			await daemon.stop()
		}
	})

	test("daemon startup reconciles an orphan run on a terminal non-current item", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-run-recovery`)
		const loopDataRoot = root + "-loop-data"
		await mkdir(loopDataRoot, { recursive: true })

		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "orphan-run-chain",
				preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
			const terminal = store.createItem({
				chainId: chain.id,
				itemId: "307",
				repoCwd: REPO_ROOT,
				status: runtimeStatus("done"),
				attempts: 1,
				phase: "iteration",
					lastRunId: "run-orphan-307",
					title: "terminal item with orphaned run",
					extra: storedItemExtra({}),
				})
			store.recordRun({
				runId: "run-orphan-307",
				chainId: chain.id,
					itemId: terminal.id,
					phase: "iteration",
					startedAt: 1_700_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
			store.createItem({
				chainId: chain.id,
				itemId: "308",
				repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					title: "pending item gated by the orphan",
					extra: storedItemExtra({}),
				})
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 50,
			scheduler: { enabled: false },
		})
		try {
			const orphan = await readRun(loopDataRoot, "run-orphan-307")
			expect(orphan?.endedAt).not.toBeNull()
			expect(orphan?.exitCode).toBe(-1)
			expect(orphan?.status).toBe("orphaned")
				const orphanExtra = orphan === null ? null : itemExtraToJsonObject(orphan.extra)
				expect(orphanExtra?.reconciledBy).toBe("daemon_startup")
				expect(typeof orphanExtra?.reconciledAt).toBe("number")

			const terminalItem = await readItem(loopDataRoot, 1, 307)
			expect(terminalItem?.status).toBe("done")
			expect(terminalItem?.phase).toBe("iteration")
			expect((await listChainRuns(loopDataRoot, 1)).filter((run) => run.endedAt === null)).toEqual([])
			const recoveryEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot }).eventsFile, { type: "scheduler.recovery" })).events
			expect(recoveryEvents).toHaveLength(1)
			expect(recoveryEvents[0]?.type === "scheduler.recovery" ? recoveryEvents[0].payload.reconciledRuns : []).toEqual([{
				runId: "run-orphan-307",
				itemId: 1,
				phase: "iteration",
				pid: null,
				runtimeNodeId: "closure-node:1:iteration",
				definitionRef: { kind: "preset", contentIdentity: "sha256:daemon-recovery-fixture" },
				definitionNodeId: "task:iteration",
			}])
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup terminates the process group of an orphaned non-current run", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-run-pgid`)
		const loopDataRoot = root + "-loop-data"
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")

		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "orphan-run-pgid-chain",
				preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
			const item = store.createItem({
				chainId: chain.id,
				itemId: "309",
				repoCwd: REPO_ROOT,
				status: runtimeStatus("done"),
				attempts: 1,
				phase: "iteration",
					lastRunId: "run-orphan-309",
					title: "terminal item with live orphaned run",
					extra: storedItemExtra({}),
				})
			store.recordRun({
				runId: "run-orphan-309",
				chainId: chain.id,
					itemId: item.id,
					phase: "iteration",
					startedAt: 1_700_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT, { pid: stale.pid, processGroupLeader: true }),
				})
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 50,
			scheduler: { enabled: false },
		})
		try {
			expect(await waitForPidExit(stale.pid, 1_000)).toBe(true)
			const orphan = await readRun(loopDataRoot, "run-orphan-309")
			expect(orphan?.endedAt).not.toBeNull()
			expect(orphan?.status).toBe("orphaned")
		} finally {
			try {
				process.kill(-stale.pid, "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already reaped by daemon startup recovery.
				}
			}
			await daemon.stop()
		}
	})

	test("daemon startup reconciles an orphaned run before scheduler selection", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-run-scheduler-unblock`)
		const loopDataRoot = root + "-loop-data"
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		await writeFakeRunner(fakeRunner)

		const schedulerEvents: SchedulerEvent[] = []
		const store = openSqliteStateStore({ loopDataRoot })
		let queuedItemId = 0
		try {
			const chain = store.createChain({
				name: "orphan-run-scheduler-unblock-chain",
				preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
			const terminal = store.createItem({
				chainId: chain.id,
				itemId: "307",
				repoCwd: REPO_ROOT,
				status: runtimeStatus("done"),
				attempts: 1,
				phase: "iteration",
					lastRunId: "run-orphan-307",
					title: "terminal item with orphaned run",
					extra: storedItemExtra({}),
				})
			store.recordRun({
				runId: "run-orphan-307",
				chainId: chain.id,
					itemId: terminal.id,
					phase: "iteration",
					startedAt: 1_700_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
			queuedItemId = store.createItem({
				chainId: chain.id,
				itemId: "308",
				repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					title: "pending item gated by the orphan",
					extra: storedItemExtra({ sleepMs: 5 }),
				}).id
		} finally {
			store.close()
		}

		const worktreeManager: SchedulerWorktreeManager = async () => root
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 50,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: {
					kind: "claude",
					source: "iteration-default",
					binary: "bun",
					extraArgs: [fakeRunner],
					model: null,
				},
				presetDir: PRESET_DIR,
				worktreeManager,
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 5,
					exitCode: 0,
					writeStatus: "done",
				}),
				chainCompleteTriggerForChain: () => null,
				onEvent: (event) => {
					schedulerEvents.push(event)
				},
			},
		})
		try {
			const phaseStart = await waitFor(
				async () =>
					schedulerEvents.find(
						(event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
							event.type === "phase.start" && event.itemId === queuedItemId && event.phase === "iteration",
					) ?? null,
				(event) => event !== null,
				10_000,
			)
			if (phaseStart === null) throw new Error("expected queued item phase.start event")
			expect(phaseStart.itemId).toBe(queuedItemId)
			expect((await readItem(loopDataRoot, 1, 308))?.id).toBe(queuedItemId)
			const orphan = await readRun(loopDataRoot, "run-orphan-307")
			expect(orphan?.status).toBe("orphaned")
			expect(orphan?.endedAt).not.toBeNull()
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup rejects socket commands before stale recovery finishes", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-recovery-socket`)
		const loopDataRoot = root + "-loop-data"
		const socketPath = resolve(loopDataRoot, "daemon.sock")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")

		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "startup-recovery-socket-chain",
				preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
			const item = store.createItem({
				chainId: chain.id,
				itemId: "238",
				repoCwd: REPO_ROOT,
				status: runtimeStatus("in_progress"),
				attempts: 1,
					lastRunId: "run-stale-238",
					agentCwd: resolve(root, "worktree"),
					title: "stale item",
					extra: storedItemExtra({}),
				})
			store.recordRun({
				runId: "run-stale-238",
				chainId: chain.id,
					itemId: item.id,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
			store.setCurrentRun({
				chainId: chain.id,
					phase: "iteration",
					runId: "run-stale-238",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ itemId: item.id, pid: stale.pid, processGroupLeader: true }),
				})
		} finally {
			store.close()
		}

		const startPromise = startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 500,
			scheduler: { enabled: false },
		})
		await new Promise((resolveWait) => setTimeout(resolveWait, 100))
		expect(await pathIsSocket(socketPath)).toBe(true)
		const earlyResponse = await sendDaemonRequest(socketPath, daemonRequest("daemon.down", {}))
		expect(earlyResponse.ok).toBe(false)
		if (!earlyResponse.ok) expect(earlyResponse.error.code).toBe("daemon_starting")

		const daemon = await startPromise
		try {
			expect(await pathIsSocket(socketPath)).toBe(true)
			expect(await waitForPidExit(stale.pid, 1_000)).toBe(true)
			// #508: daemon recovery preserves the item's business status (in_progress) and only
			// clears the orphan `current_runs` row + kills the stale process group.
			expect((await readItem(loopDataRoot, 1, 238))?.status).toBe("in_progress")
			expect(await readCurrentRun(loopDataRoot, 1)).toBeNull()
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already reaped by daemon startup recovery.
				}
			}
			await daemon.stop()
		}
	})

	test("chain status marks stale in_progress rows without active slots", async () => {
		const fixture = await startFixture("status-recovery-marker", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "status-recovery-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "217",
				repoCwd: REPO_ROOT,
			})).item)
			// #404: the bundled preset retired `in_progress` from its continuable vocabulary, so the
			// daemon's request-flow vocabulary gate now rejects `item.update --status in_progress`.
			// The stale-detection branch under test exists precisely to surface items wedged at the
			// legacy `in_progress` sentinel (left over from older databases / crash recovery).
			// Reproduce that wedged-state by writing the sentinel through the SQLite store, which
			// does not gate vocabulary — bypassing the request layer the way a crash or migration
			// from an older preset would.
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(numberValue(added.id), { status: runtimeStatus("in_progress") })
			} finally {
				store.close()
			}

			const status = record(expectOk(await request(fixture, "chain.status", { chainId })))
			expect(record(status.summary).activeSlots).toEqual([])
			expect(record(record(status.summary).items).byStatus).toEqual({ in_progress: 1 })
			expect(record(status.summary).recovery).toMatchObject({
				needed: true,
				staleInProgressItems: [{ itemId: "217", repoCwd: REPO_ROOT }],
			})
		} finally {
			await fixture.daemon.stop()
		}
	})
})
