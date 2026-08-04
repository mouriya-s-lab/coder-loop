import { DaemonError, DecisionFingerprintState, FAKE_RUNNER_STATUS_WRITE_SNIPPET, PRESET_DIR, REPO_ROOT, StatusArtifactBoundary, StatusSnapshotBoundary, TEST_ROOT, buildCoderLoopStatusSnapshot, daemonDecisionFingerprintState, daemonRequest, describe, emptyObservabilityExcerpt, expect, expectOk, itemExtraToJsonObject, makeObservabilityEvent, mkdir, numberValue, observabilityTaskIdentity, openSqliteStateStore, pathExists, present, queryObservabilityEvents, readFile, readItem, readRun, readdir, record, rename, request, resolve, resolveChainRuntimePaths, resolveLoopDataPaths, rm, runtimeStatus, sendDaemonRequest, staleRecoveryRunExtra, startChainBasedRunnerFixture, startCoderLoopDaemon, startFixture, startPhaseAdvancementFixture, symlink, test, waitFor, waitForItemPhaseEnd, waitForItemQueueTerminal, writeCredentialedFakeRunner, writeCredentialedFixturePreset, writeFile, writePromptCaptureRunner } from "./harness"
import type { SchedulerEvent, SchedulerOptions, SchedulerWorktreeManager } from "./harness"
let nextFixtureId = 0

describe("daemon", () => {
	test("subprocess exit callback writes db", async () => {
		const fixture = await startFixture("exit-callback", { schedulerIntervalMs: 1_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "exit-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 7 },
			})).item)
			const itemId = numberValue(added.id)

			// Synchronize on the scheduler's phase.end for the first run, then on the persisted run row.
			// item.status flips to changes_requested when the agent writes it, which is before the close
			// handler persists the run row, so waiting on status alone would read the row too early.
			const phaseEnd = await waitForItemPhaseEnd(fixture, itemId)
			expect(phaseEnd.status).toBe("changes_requested")
			expect(phaseEnd.exitCode).toBe(7)
			const run = await waitFor(
				async () => readRun(fixture.loopDataRoot, phaseEnd.runId),
				(candidate) => typeof candidate?.endedAt === "number",
			)
			expect(run?.exitCode).toBe(7)
			expect(typeof run?.endedAt).toBe("number")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler writes run artifacts and unified observability events", async () => {
		// Item/status requests explicitly request scheduler ticks. Keep the periodic timer
		// outside this short fixture so it cannot race the credentialed status-write tick and
		// reorder the exact unified event sequence under load.
		const fixture = await startFixture("scheduler-artifacts", { schedulerIntervalMs: 60_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-artifacts-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "203",
				repoCwd: REPO_ROOT,
				// #405: pin the iteration write so the test's single-phase event assertion stays
				// single-phase (previously the retired stdout verdict mapper coincidentally landed
				// iteration at done via the default REVIEW SUMMARY token).
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done", extraSleepAfterStatusWriteMs: 500 },
			})

			// The run's events file must end with chain.completed, which the scheduler appends last.
			// Observing the in-memory chain.completed event guarantees every prior artifact write
			// (run status file, run row, phase.end / queue.terminal lines) has already landed.
			await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "chain.completed" && event.chainId === chainId) ?? null,
				(event) => event !== null,
				10_000,
			)
			const item = await readItem(fixture.loopDataRoot, chainId, 203)
			const runId = item?.lastRunId ?? ""
			const paths = resolveChainRuntimePaths("scheduler-artifacts-chain", { loopDataRoot: fixture.loopDataRoot })
			const status = record(JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")))
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: runId })

			expect(status).toMatchObject({ runId, chainId, itemId: "203", phase: "iteration", exitCode: 0, status: runtimeStatus("done") })
			expect(stdout).toContain("done:")
			expect(stderr).toBe("")
			expect(status.eventsPath).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(await pathExists(paths.runEventsFile(runId))).toBe(false)
			const eventTypes = events.events.map((event) => event.type)
			const expectedEventTypes: typeof eventTypes = [
				"agent.spawn",
				"phase.start",
				"item.mutation.caller_admission",
				"item.update.field_write_admission",
				"item.status",
				"recycle.pending_entered",
				"slot.busy",
				"recycle.natural_exit",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.completed",
			]
			expect([...eventTypes].sort()).toEqual([...expectedEventTypes].sort())
			// The credentialed status mutation arms recycle and resumes the scheduler in
			// parallel. Preserve both causal chains without inventing an order between the
			// timer-owned pending-event persist and the resumed tick's slot observation.
			expect(eventTypes.filter((type) => type !== "slot.busy")).toEqual([
				"agent.spawn", "phase.start", "item.mutation.caller_admission", "item.update.field_write_admission",
				"item.status", "recycle.pending_entered", "recycle.natural_exit", "agent.exit", "phase.end",
				"queue.terminal", "chain.completed",
			])
			expect(eventTypes.indexOf("slot.busy")).toBeGreaterThan(eventTypes.indexOf("item.status"))
			expect(eventTypes.indexOf("slot.busy")).toBeLessThan(eventTypes.indexOf("agent.exit"))
			const exitEvent = events.events.find((event) => event.type === "agent.exit")
			if (exitEvent?.type !== "agent.exit") throw new Error("expected agent.exit event")
			expect(exitEvent.payload.excerpt.stdout.path).toBe(paths.runPhaseStdoutFile(runId, "iteration"))
			// #452: the fake runner's only stdout line (other than test-provided
			// `stdoutLines`) is now `done:<itemId>`. The retired "PHASE DONE:" line was
			// part of the stdout-summary contract that #452 removed wholesale — the engine
			// stopped reading stdout for completion classification, so the fake runner
			// stopped emitting completion-marker lines too.
			expect(exitEvent.payload.excerpt.stdout.records.at(-1)).toContain("done:")
			expect(exitEvent.payload.excerpt.stderr.path).toBe(paths.runPhaseStderrFile(runId, "iteration"))
			expect(exitEvent.payload.excerpt.stderr.records).toEqual([])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("status snapshot recent events include scheduler phase.start / phase.end / queue.terminal", async () => {
		const chainName = "scheduler-status-events-chain"
		// Use a long scheduler interval so the second item stays queued (chain stays active)
		// while we snapshot status after the first item reaches terminal.
		const fixture = await startFixture("scheduler-status-events", { schedulerIntervalMs: 60_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "304",
				repoCwd: REPO_ROOT,
				// #405: pin iteration writes — see note on the prior test.
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done" },
			})
			await request(fixture, "item.add", {
				chainId,
				itemId: "305",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done" },
			})
			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 304), (candidate) => candidate?.status === "done")
			expect(item?.lastRunId).not.toBeNull()
			// The agent writes status="done" before the scheduler appends queue.terminal to the
			// events file. Synchronize on the in-memory queue.terminal event so the events-file
			// assertions below see the fully flushed run.
			await waitForItemQueueTerminal(fixture, item!.id)
			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				output: "json",
			})

			expect(snapshot.state.kind).toBe("ok")
			expect(snapshot.events.runId).toBe(item?.lastRunId ?? null)
			expect(snapshot.events.exists).toBe(true)
			expect(snapshot.events.path).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(snapshot.events.error).toBeNull()
			const eventTypes = snapshot.events.recent.map((event) =>
				typeof event === "object" && event !== null && !Array.isArray(event) && typeof event.type === "string" ? event.type : null,
			)
			expect(eventTypes).toContain("phase.start")
			expect(eventTypes).toContain("phase.end")
			expect(eventTypes).toContain("queue.terminal")

			const cli = Bun.spawn({
				cmd: [
					"bun",
					resolve(REPO_ROOT, "src/loop.ts"),
					"status",
					REPO_ROOT,
					"--chain",
					chainName,
					"--loop-data-root",
					fixture.loopDataRoot,
					"--json",
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CODER_LOOP_RUN_CRED: undefined, CODER_LOOP_DATA_DIR: fixture.loopDataRoot },
			})
			const [cliStdout, cliStderr, cliExit] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			])
			if (cliExit !== 0) {
				console.error("CLI_STDERR", cliStderr)
				console.error("CLI_STDOUT", cliStdout)
			}
			expect(cliExit).toBe(0)
			const cliPayload = StatusSnapshotBoundary.assert(JSON.parse(cliStdout))
			const cliTypes = cliPayload.events.recent.map((event) =>
				typeof event.type === "string" ? event.type : null,
			)
			expect(cliTypes).toContain("phase.start")
			expect(cliTypes).toContain("phase.end")
			expect(cliTypes).toContain("queue.terminal")

			const logsSince = new Date(Date.now() - 60_000).toISOString()
			const logsCli = Bun.spawn({
				cmd: [
					"bun",
					resolve(REPO_ROOT, "src/loop.ts"),
					"logs",
					REPO_ROOT,
					"--chain",
					chainName,
					"--loop-data-root",
					fixture.loopDataRoot,
					"--json",
					"--kind",
					"lifecycle",
					"--since",
					logsSince,
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CODER_LOOP_RUN_CRED: undefined, CODER_LOOP_DATA_DIR: fixture.loopDataRoot },
			})
			const [logsStdout, logsStderr, logsExit] = await Promise.all([
				new Response(logsCli.stdout).text(),
				new Response(logsCli.stderr).text(),
				logsCli.exited,
			])
			if (logsExit !== 0) throw new Error(`logs CLI failed: stdout=${logsStdout} stderr=${logsStderr}`)
			expect(logsExit).toBe(0)
			const logsPayload = record(JSON.parse(logsStdout))
			expect(logsPayload.path).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			const logsEvents = logsPayload.events
			if (!Array.isArray(logsEvents)) throw new Error("expected logs events array")
			expect(logsEvents.length).toBeGreaterThan(0)
			for (const event of logsEvents) {
				const eventRecord = record(event)
				expect(eventRecord.kind).toBe("lifecycle")
				expect(Date.parse(String(eventRecord.ts))).toBeGreaterThanOrEqual(Date.parse(logsSince))
			}
		} finally {
			await fixture.daemon.stop()
		}
	}, 30_000)

	test("daemon suppresses repeated decision events while a slot remains busy", async () => {
		const fixture = await startFixture("decision-edge-suppression", { schedulerIntervalMs: 20 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "decision-edge-suppression-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				itemId: "9411",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 500, exitCode: 0 },
			})
			await request(fixture, "item.add", {
				chainId,
				itemId: "9412",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})
			const eventsFile = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const initial = await waitFor(
				async () =>
					await queryObservabilityEvents(eventsFile, {
						kind: "decision",
						type: "slot.busy",
						chain: "decision-edge-suppression-chain",
					}),
				(result) => result.events.length === 1,
				5_000,
			)
			await new Promise((resolveWait) => setTimeout(resolveWait, 150))
			const afterIdleTicks = await queryObservabilityEvents(eventsFile, {
				kind: "decision",
				type: "slot.busy",
				chain: "decision-edge-suppression-chain",
			})
			expect(afterIdleTicks.events).toHaveLength(initial.events.length)
		} finally {
			await fixture.daemon.stop()
		}
	}, 10_000)

	test("decision fingerprint suppresses only consecutive duplicates", () => {
		const state = new DecisionFingerprintState()
		const first = makeObservabilityEvent({
			...observabilityTaskIdentity("run-1"),
			kind: "decision",
			type: "slot.busy",
			chain: "fingerprint-chain",
			runId: "run-1",
			subject: { kind: "engine" },
			payload: { slotKey: "slot-a", chainId: 1, repoCwd: "/repo/a", activeRunId: "run-1" },
		})
		const changed = makeObservabilityEvent({
			...observabilityTaskIdentity("run-2"),
			kind: "decision",
			type: "slot.busy",
			chain: "fingerprint-chain",
			runId: "run-2",
			subject: { kind: "engine" },
			payload: { slotKey: "slot-a", chainId: 1, repoCwd: "/repo/a", activeRunId: "run-2" },
		})

		expect(state.observe(1, first)).toBe(false)
		expect(state.observe(1, first)).toBe(true)
		expect(state.observe(1, changed)).toBe(false)
		expect(state.observe(1, changed)).toBe(true)
		state.release({ kind: "slot", chainId: 1, slotKey: "slot-a" })
		expect(state.observe(1, changed)).toBe(false)
	})

	test("decision fingerprint state follows active lifecycle", async () => {
		let stopPresetDir = ""
		const fixture = await startFixture("decision-fingerprint-lifecycle", {
			schedulerEnabled: false,
			beforeStart: async ({ root }) => {
				stopPresetDir = resolve(root, "stop-preset")
				await mkdir(stopPresetDir, { recursive: true })
				await writeFile(resolve(stopPresetDir, "review.md"), "Review the item.\n")
				await writeFile(resolve(stopPresetDir, "preset.toml"), `name = "decision-fingerprint-lifecycle"

[item]
idField = "issue"

[routing]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[[steps]]
name = "review"
prompt = "review.md"

  [[steps.handoffs]]
  status = "done"
  when = "The review completed successfully."

  [[steps.handoffs]]
  chainAction = "stop"
  when = "The chain must leave the active scheduling lifecycle."
`)
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "fingerprint-stop-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "54101",
				repoCwd: REPO_ROOT,
				presetPath: stopPresetDir,
			})).item)
			const itemId = numberValue(item.id)
			const durableStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const durablePhaseExitRun = durableStore.recordRun({
					runId: "run-phase-exit-stop",
					chainId,
					itemId,
					phase: "review",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
				expect(durablePhaseExitRun.runtimeNodeId.length).toBeGreaterThan(0)
			} finally { durableStore.close() }
			const sibling = record(expectOk(await request(fixture, "chain.create", {
				name: "fingerprint-active-sibling",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const siblingChainId = numberValue(sibling.id)
			const state = daemonDecisionFingerprintState(fixture.daemon)
			const slot = makeObservabilityEvent({
				...observabilityTaskIdentity("run-slot"),
				kind: "decision",
				type: "slot.busy",
				chain: "fingerprint-stop-chain",
				runId: "run-slot",
				subject: { kind: "engine" },
				payload: { slotKey: "slot-a", chainId, repoCwd: "/repo/a", activeRunId: "run-slot" },
			})
			const terminalItem = makeObservabilityEvent({
				kind: "decision",
				type: "item.backoff",
				chain: "fingerprint-stop-chain",
				item: itemId,
				subject: { kind: "engine" },
				payload: { rowId: itemId, failureCount: 1, nextRunAt: 1_800_000_000 },
			})
			const completedChain = makeObservabilityEvent({
				...observabilityTaskIdentity("run-complete"),
				kind: "decision",
				type: "chain.complete_trigger",
				chain: "fingerprint-stop-chain",
				runId: "run-complete",
				subject: { kind: "engine" },
				payload: { chainId, decision: "keep-active", reason: "waiting" },
			})
			const activeSibling = makeObservabilityEvent({
				kind: "decision",
				type: "item.dependency_wait",
				chain: "fingerprint-active-sibling",
				item: 21,
				subject: { kind: "engine" },
				payload: { rowId: 21, dependsOn: [11], unsatisfied: [11] },
			})
			const seedStoppedChainScopes = (): void => {
				expect(state.observe(chainId, slot)).toBe(false)
				expect(state.observe(chainId, terminalItem)).toBe(false)
				expect(state.observe(chainId, completedChain)).toBe(false)
			}

			expect(state.observe(siblingChainId, activeSibling)).toBe(false)
			seedStoppedChainScopes()
			expect(state.size).toBe(4)

			const operatorStopped = record(expectOk(await request(fixture, "chain.stop", { chainId })).chain)
			expect(operatorStopped.status).toBe("stopped")
			expect(state.size).toBe(1)
			expect(state.observe(siblingChainId, activeSibling)).toBe(true)
			expect(record(expectOk(await request(fixture, "chain.resume", { chainId })).chain).status).toBe("active")
			seedStoppedChainScopes()
			expect(state.size).toBe(4)

			const phaseExitStopped = expectOk(await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-phase-exit-stop",
				agentPhase: "review",
				action: "stop",
			}))
			expect(record(phaseExitStopped.chain).status).toBe("stopped")
			expect(state.size).toBe(1)
			expect(state.observe(siblingChainId, activeSibling)).toBe(true)
			expect(record(expectOk(await request(fixture, "chain.resume", { chainId })).chain).status).toBe("active")
			seedStoppedChainScopes()
			expect(state.size).toBe(4)

			state.releaseForSchedulerEvent({
				type: "agent.exit",
				slotKey: "slot-a",
				chainId,
				itemId,
				runId: "run-slot",
				phase: "iteration",
				exitCode: 0,
				status: runtimeStatus("done"),
				excerpt: emptyObservabilityExcerpt(),
			})
			expect(state.size).toBe(3)
			state.releaseForSchedulerEvent({
				type: "queue.terminal",
				ts: "2026-07-10T00:00:00.000Z",
				runId: "run-slot",
				chainId,
				rowId: itemId,
				terminalStatus: runtimeStatus("done"),
			})
			expect(state.size).toBe(2)
			expect(state.observe(siblingChainId, activeSibling)).toBe(true)
			state.releaseForSchedulerEvent({ type: "chain.completed", chainId, chainName: "fingerprint-stop-chain", runId: "run-complete" })
			expect(state.size).toBe(1)
			expect(state.observe(siblingChainId, activeSibling)).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("decision fingerprint churn returns to active-set baseline", () => {
		const survivingChainChurn = (generations: number): number => {
			const state = new DecisionFingerprintState()
			const keepActive = (runId: string, reason: string) => makeObservabilityEvent({
				...observabilityTaskIdentity(runId),
				kind: "decision",
				type: "chain.complete_trigger",
				chain: "surviving-chain",
				runId,
				subject: { kind: "engine" },
				payload: { chainId: 1, decision: "keep-active", reason },
			})

			for (let generation = 0; generation < generations; generation += 1) {
				const runId = `surviving-run-${generation}`
				expect(state.observe(1, keepActive(runId, "waiting"))).toBe(false)
				expect(state.observe(1, keepActive(runId, "waiting"))).toBe(true)
				expect(state.observe(1, keepActive(runId, "changed"))).toBe(false)
				expect(state.observe(1, keepActive(runId, "changed"))).toBe(true)
			}

			return state.size
		}

		const churn = (rounds: number): number => {
			const state = new DecisionFingerprintState()
			const active = makeObservabilityEvent({
				kind: "decision",
				type: "item.dependency_wait",
				chain: "active-baseline",
				item: 1,
				subject: { kind: "engine" },
				payload: { rowId: 1, dependsOn: [99], unsatisfied: [99] },
			})
			expect(state.observe(1, active)).toBe(false)

			for (let index = 0; index < rounds; index += 1) {
				const chainId = index + 2
				const slotKey = `slot-${chainId}`
				const rowId = chainId * 10
				const chainName = `churn-${chainId}`
				const runId = `run-${chainId}`
				const slot = makeObservabilityEvent({
					...observabilityTaskIdentity(runId),
					kind: "decision",
					type: "slot.busy",
					chain: chainName,
					runId,
					subject: { kind: "engine" },
					payload: { slotKey, chainId, repoCwd: `/repo/${chainId}`, activeRunId: runId },
				})
				const item = makeObservabilityEvent({
					kind: "decision",
					type: "item.backoff",
					chain: chainName,
					item: rowId,
					subject: { kind: "engine" },
					payload: { rowId, failureCount: 1, nextRunAt: 1_800_000_000 + index },
				})
				const keepActive = (reason: string, triggerRunId: string) => makeObservabilityEvent({
					...observabilityTaskIdentity(triggerRunId),
					kind: "decision",
					type: "chain.complete_trigger",
					chain: chainName,
					runId: triggerRunId,
					subject: { kind: "engine" },
					payload: { chainId, decision: "keep-active", reason },
				})

				expect(state.observe(chainId, slot)).toBe(false)
				expect(state.observe(chainId, item)).toBe(false)
				expect(state.observe(chainId, keepActive("waiting", `${runId}-a`))).toBe(false)
				expect(state.observe(chainId, keepActive("waiting", `${runId}-b`))).toBe(false)
				expect(state.observe(chainId, keepActive("waiting", `${runId}-b`))).toBe(true)
				expect(state.observe(chainId, keepActive("changed", `${runId}-c`))).toBe(false)
				expect(state.size).toBe(4)

				state.releaseForSchedulerEvent({
					type: "agent.exit",
					slotKey,
					chainId,
					itemId: rowId,
					runId,
					phase: "iteration",
					exitCode: 0,
					status: runtimeStatus("done"),
					excerpt: emptyObservabilityExcerpt(),
				})
				state.releaseForSchedulerEvent({
					type: "queue.terminal",
					ts: "2026-07-10T00:00:00.000Z",
					runId,
					chainId,
					rowId,
					terminalStatus: runtimeStatus("done"),
				})
				state.releaseForSchedulerEvent({ type: "chain.completed", chainId, chainName, runId })
				expect(state.size).toBe(1)
			}

			expect(state.observe(1, active)).toBe(true)
			return state.size
		}

		expect(churn(3)).toBe(1)
		expect(churn(30)).toBe(1)
		expect(survivingChainChurn(3)).toBe(1)
		expect(survivingChainChurn(30)).toBe(1)
	})

	test("daemon scheduler uses bundled preset directory declared on the item (post-#412)", async () => {
		const fixture = await startFixture("scheduler-chain-preset", { schedulerIntervalMs: 1_000, schedulerPresetDir: null })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-chain-preset",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			// #412: the item declares its preset; the scheduler resolves the preset directory from
			// item.preset (not chain.preset). Explicit `single-phase-example` matches the chain seed
			// so the spawn-event presetDir assertion below remains the bundled single-phase preset.
			await request(fixture, "item.add", {
				chainId,
				itemId: "215",
				repoCwd: REPO_ROOT,
				// #405: single-phase-example's `run` phase isn't review, so the
				// fakeRunner default returns null (no write). Pin the write explicitly.
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done", eventLog: fixture.eventLog },
				preset: "single-phase-example",
			})

			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 215), (candidate) => candidate?.status === "done")
			const spawnEvent = fixture.schedulerEvents.find((event) => event.type === "agent.spawn")
			if (spawnEvent?.type !== "agent.spawn") throw new Error("expected agent.spawn event")
			expect(spawnEvent.chainId).toBe(chainId)
			expect(spawnEvent.presetDir.startsWith(resolve(fixture.loopDataRoot, "definitions") + "/")).toBe(true)
			expect(spawnEvent.presetDir.split("/").at(-1)).toBe("assets")
			const manifest = record(JSON.parse(await readFile(resolve(spawnEvent.presetDir, "..", "manifest.json"), "utf8")))
			expect(record(record(manifest.envelope).definition).name).toBe("single-phase-example")
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (operator path). Boundary parse on item.update accepts a request
	// with no `agentCredential` as `kind: "operator"` and records one `item.mutation.caller_admission`
	// audit event with reason=operator. Subject on every downstream audit event for that mutation
	// is `{kind: "operator"}` — typechecker exhaustiveness in `handleItemUpdate` enforces this.

	test("daemon db unavailable explicit fail", async () => {
		const rootFile = resolve(TEST_ROOT, `not-a-dir-${++nextFixtureId}`)
		await mkdir(resolve(rootFile, ".."), { recursive: true })
		await writeFile(rootFile, "not a directory")

		try {
			await startCoderLoopDaemon({ loopDataRoot: rootFile })
			throw new Error("expected daemon start to fail")
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonError)
			if (!(error instanceof DaemonError)) throw error
			expect(error.code).toBe("db_unavailable")
		}
	})

	test("unknown command rejected", async () => {
		const fixture = await startFixture("unknown-command", { schedulerEnabled: false })
		try {
			const response = await sendDaemonRequest(fixture.socketPath, { id: "unknown", command: "chain.archive", args: {} })
			expect(response.ok).toBe(false)
			if (!response.ok) expect(response.error.code).toBe("unknown_command")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler spawns blocked-responder trigger phase after review exits blocked (live integration, issue #290)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-b3-blocked-responder-live`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const fakeRunner = resolve(root, "fake-phase-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", phase: input.phase, runId: input.runId }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", phase: input.phase, runId: input.runId }) + "\\n")
if (input.phase === "iteration") await writeLine("ITERATION SUMMARY: scope=b3-live; reason=iter-marker")
else if (input.phase === "review") await writeLine("PHASE DONE: phase=review reason=b3-live-blocked")
else if (input.phase === "blocked-responder") await writeLine("PHASE DONE: phase=blocked-responder reason=b3-live-unblock-accepted")
${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
process.exitCode = 0
`,
		)

		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async () => root
		const runnerSelection: SchedulerOptions["runner"] = {
			kind: "claude",
			source: "iteration-default",
			binary: "bun",
			extraArgs: [fakeRunner],
			model: null,
		}
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 30,
				runner: runnerSelection,
				presetDir: credentialedPresetDir,
				worktreeManager,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 5,
					// blocked-responder writes nothing so the terminal blocked status is preserved (#338).
					writeStatus: phase === "iteration" ? "in_progress" : phase === "review" ? "blocked" : null,
				}),
				chainCompleteTriggerForChain: () => null,
				onEvent: (event) => {
					schedulerEvents.push(event)
				},
			},
		})
		const socketPath = daemon.snapshot().socketPath
		try {
			const chain = record(expectOk(await sendDaemonRequest(socketPath, daemonRequest("chain.create", {
				name: "b3-blocked-responder-live-chain",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(socketPath, daemonRequest("item.add", { chainId, itemId: "29011", repoCwd: REPO_ROOT, presetPath: credentialedPresetDir })))

			// A trigger phase running on an already-terminal (blocked) item must not change that
			// terminal status. The blocked-responder fake runner writes no status, and the engine
			// preserves the pre-trigger terminal status at spawn (issue #338), so the item stays
			// blocked at the blocked-responder phase. The item reaches its final (blocked /
			// blocked-responder) state at spawn time, so wait on the blocked-responder phase.start
			// event rather than a status change.
			await waitFor(
				async () =>
					schedulerEvents
						.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> => event.type === "phase.start")
						.map((event) => event.phase),
				(phases) => phases?.includes("blocked-responder") ?? false,
				10_000,
			)
			const finalItem = await readItem(loopDataRoot, chainId, 29011)
			expect(finalItem?.phase).toBe("blocked-responder")
			expect(finalItem?.status).toBe("blocked")

			const phaseStarts = schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === finalItem!.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration", "review", "blocked-responder"])

			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot }).eventsFile, {
				kind: "lifecycle",
				type: "phase.start",
				chain: "b3-blocked-responder-live-chain",
				phase: "blocked-responder",
			})
			expect(events.events).toHaveLength(1)
		} finally {
			await daemon.stop()
		}
	})

	test("daemon re-spawns item after agent exits 0 without SUMMARY marker (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixture("scheduler-respawn-no-summary", { schedulerIntervalMs: 30 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-respawn-no-summary-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "7284",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0, summary: null },
			})).item)
			const itemId = numberValue(added.id)

			// The scheduler writes the incremented `attempts` to the DB at spawn-start, but emits the
			// agent.spawn event (streamed over IPC into fixture.schedulerEvents) later in the same spawn.
			// Gating on the DB `attempts` would race ahead of the IPC event delivery and observe attempts>=2
			// while only one spawn event had arrived. Gate on the same source the assertion reads — the
			// agent.spawn event stream — so the two are synchronized.
			await waitFor(
				async () => fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === itemId).length,
				(count) => (count ?? 0) >= 2,
				5_000,
			)

			const finalItem = await readItem(fixture.loopDataRoot, chainId, 7284)
			expect(finalItem?.attempts).toBe(1)
			// summary:null → the agent writes no status, so the item keeps the spawn-preset continuable
			// in_progress (the scheduler never invents a terminal status). It is therefore re-selected
			// across ticks: iteration → review, driving attempts to >=2 with >=2 spawns.
			expect(["queued", "in_progress", "changes_requested"]).toContain(finalItem?.status ?? "")
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === itemId).length).toBeGreaterThanOrEqual(2)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	})

	describe("per-phase runner selection (issue #287 AC5)", () => {
		test("live daemon with chain metadata claude/codex.binary spawns codex script for iter phase", async () => {
			const fixture = await startChainBasedRunnerFixture("ac5-iter", { phase: "iteration" })
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac5-iter-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					metadata: {
						claude: { binary: fixture.fakeClaudeBinary },
						codex: { binary: fixture.fakeCodexBinary },
					},
				})).chain
				const chainId = numberValue(record(result).id)
				const added = record(expectOk(await request(fixture, "item.add", {
					chainId,
					itemId: "287301",
					repoCwd: REPO_ROOT,
					extra: {},
				})).item)
				const itemId = numberValue(added.id)

				// The fake shell runner writes no terminal status, so the item can be respawned immediately.
				// Read the run id from the completed phase.end event instead of racing item.lastRunId.
				const iterationEnd = present(await waitFor(
					async () =>
						fixture.schedulerEvents
							.find((event): event is Extract<SchedulerEvent, { type: "phase.end" }> => event.type === "phase.end" && event.itemId === itemId && event.phase === "iteration") ?? null,
					(event) => event !== null,
					5_000,
				))
				const runId = iterationEnd.runId
				const stdoutPath = resolveChainRuntimePaths(`ac5-iter-chain`, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(runId)
				const stdout = await readFile(stdoutPath, "utf-8")
				expect(stdout).toContain("BINARY:codex")
				expect(stdout).not.toContain("BINARY:claude")
			} finally {
				await fixture.daemon.stop()
			}
		})

		test("live daemon with chain metadata claude/codex.binary spawns codex script for review phase", async () => {
			const fixture = await startChainBasedRunnerFixture("ac5-review", { phase: "review" })
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac5-review-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					metadata: {
						claude: { binary: fixture.fakeClaudeBinary },
						codex: { binary: fixture.fakeCodexBinary },
					},
				})).chain
				const chainId = numberValue(record(result).id)
				await request(fixture, "item.add", {
					chainId,
					itemId: "287302",
					repoCwd: REPO_ROOT,
					extra: {},
				})

				// The fake shell runner writes no status (it only proves which binary spawned), so under v1
				// the item never reaches a terminal status. gh-issue-pr-iteration runs iteration before
				// review (both codex by preset), so gate on the review phase.end specifically — that
				// guarantees the review run closed and its stdout was flushed — then read its captured
				// binary marker.
				const reviewRunId = await waitFor(
					async () =>
						fixture.schedulerEvents
							.filter((event): event is Extract<SchedulerEvent, { type: "phase.end" }> => event.type === "phase.end" && event.phase === "review")
							.map((event) => event.runId)
							.at(-1) ?? null,
					(runId) => runId !== null,
					5_000,
				)
				const stdoutPath = resolveChainRuntimePaths(`ac5-review-chain`, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(reviewRunId!)
				const stdout = await readFile(stdoutPath, "utf-8")
				expect(stdout).toContain("BINARY:codex")
				expect(stdout).not.toContain("BINARY:claude")
			} finally {
				await fixture.daemon.stop()
			}
		})
	})

	describe("per-item phase advancement (issue #289 AC7)", () => {
		test("live daemon drives one item through iter → review in two distinct spawns (not one synchronous spawn-then-review)", async () => {
			const fixture = await startPhaseAdvancementFixture("ac7-iter-then-review")
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac7-iter-then-review-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
				})).chain
				const chainId = numberValue(record(result).id)
				await request(fixture, "item.add", {
					chainId,
					itemId: "289001",
					repoCwd: REPO_ROOT,
					extra: {},
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 289_001),
					(candidate) => candidate !== null && candidate.status === "done",
					10_000,
				)
				expect(item).not.toBeNull()
				expect(item!.attempts).toBe(1)
				expect(item!.phase).toBe("review")

				// The agent writes status="done" before the scheduler emits phase.end / queue.terminal
				// for the review run. queue.terminal is the last per-item scheduler event, so observing
				// it guarantees both phase.end events (iteration + review) have already been recorded.
				const terminalEvent = await waitForItemQueueTerminal(fixture, item!.id)
				expect(terminalEvent.terminalStatus).toBe("done")

				const phaseStartEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
						event.type === "phase.start" && event.itemId === item!.id && ["iteration", "review"].includes(event.phase),
				)
				const startedPhases = phaseStartEvents.map((event) => event.phase)
				expect(startedPhases).toEqual(["iteration", "review"])
				const workPhaseRunIds = new Set(phaseStartEvents.map((event) => event.runId))
				const spawnEvents = fixture.schedulerEvents.filter(
					(event) => event.type === "agent.spawn" && event.itemId === item!.id && workPhaseRunIds.has(event.runId),
				)
				expect(spawnEvents).toHaveLength(2)

				const phaseEndEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.end" }> =>
						event.type === "phase.end" && event.itemId === item!.id && workPhaseRunIds.has(event.runId),
				)
				const endedPhases = phaseEndEvents.map((event) => event.phase)
				expect(endedPhases).toEqual(["iteration", "review"])

				const persistedSpawnEvents = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
					kind: "lifecycle",
					type: "agent.spawn",
					chain: "ac7-iter-then-review-chain",
					item: item!.id,
				})
				expect(persistedSpawnEvents.events).toHaveLength(2)
			} finally {
				await fixture.daemon.stop()
			}
		})
	})

	describe("per-(item, phase) runId + artifact directory (issue #294)", () => {
		test("iter and review spawns produce distinct phase-tagged runIds with isolated artifact subdirs and SQLite runs rows", async () => {
			const fixture = await startPhaseAdvancementFixture("phase-runid-artifact")
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "phase-runid-artifact-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
				})).chain
				const chain = record(result)
				const chainId = numberValue(chain.id)
				await request(fixture, "item.add", {
					chainId,
					itemId: "294001",
					repoCwd: REPO_ROOT,
					extra: {},
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 294_001),
					(candidate) => candidate !== null && candidate.status === "done",
					10_000,
				)
				expect(item).not.toBeNull()

				// The agent writes status="done" before the scheduler emits phase.end / queue.terminal and
				// finalizes the per-run rows + events files. queue.terminal is the last per-item scheduler
				// event, so observing it guarantees both runs' artifacts and run rows have already landed.
				await waitForItemQueueTerminal(fixture, item!.id)

				const phaseStartEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
						event.type === "phase.start" && event.itemId === item!.id,
				)
				expect(phaseStartEvents.map((event) => event.phase)).toEqual(["iteration", "review"])
				const runIdByPhase = new Map<string, string>(phaseStartEvents.map((event) => [event.phase, event.runId]))
				const iterRunId = runIdByPhase.get("iteration")!
				const reviewRunId = runIdByPhase.get("review")!
				expect(iterRunId).toBeTruthy()
				expect(reviewRunId).toBeTruthy()
				expect(iterRunId).not.toBe(reviewRunId)
				expect(iterRunId).toContain("iteration")
				expect(reviewRunId).toContain("review")

				const paths = resolveChainRuntimePaths("phase-runid-artifact-chain", { loopDataRoot: fixture.loopDataRoot })
				for (const runId of [iterRunId, reviewRunId]) {
					const runDirEntries = await readdir(paths.runDir(runId))
					const expectedPhaseDir = runId === iterRunId ? "iteration" : "review"
					expect(runDirEntries.sort()).toEqual([expectedPhaseDir, "status.json", "stderr.log", "stdout.log"])
				}
				const iterStatus = StatusArtifactBoundary.assert(JSON.parse(await readFile(paths.runStatusFile(iterRunId), "utf-8")))
				const reviewStatus = StatusArtifactBoundary.assert(JSON.parse(await readFile(paths.runStatusFile(reviewRunId), "utf-8")))
				expect(iterStatus.phase).toBe("iteration")
				expect(reviewStatus.phase).toBe("review")

				const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot, createIfMissing: false })
				try {
					const iterRow = store.getRunByRunId(iterRunId)
					const reviewRow = store.getRunByRunId(reviewRunId)
					expect(iterRow?.phase).toBe("iteration")
					expect(reviewRow?.phase).toBe("review")
					expect(iterRow?.status).toBe("in_progress")
					expect(reviewRow?.status).toBe("done")
					expect(iterRow?.itemId).toBe(item!.id)
					expect(reviewRow?.itemId).toBe(item!.id)
				} finally {
					store.close()
				}

				const iterEventLines = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: iterRunId })
				const reviewEventLines = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: reviewRunId })
				const iterPhaseEnd = iterEventLines.events.find((event) => event.type === "phase.end")
				const reviewPhaseEnd = reviewEventLines.events.find((event) => event.type === "phase.end")
				expect(iterPhaseEnd?.phase).toBe("iteration")
				expect(reviewPhaseEnd?.phase).toBe("review")
			} finally {
				await fixture.daemon.stop()
			}
		})
	})

	test("recordFatalSync durably writes the uncaught stack to the unified event stream", async () => {
		const fixture = await startFixture("record-fatal-sync", { schedulerEnabled: false })
		try {
			fixture.daemon.recordFatalSync("unhandledRejection", new Error("BOOM-observability"))
			const paths = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot })
			const records = await queryObservabilityEvents(paths.eventsFile, { kind: "lifecycle", type: "daemon.fatal" })
			const fatal = records.events[0]
			expect(fatal).toBeTruthy()
			if (fatal?.type !== "daemon.fatal") throw new Error("expected daemon.fatal event")
			expect(fatal.payload.fatalKind).toBe("unhandledRejection")
			// the durable record must carry the stack, not the message
			expect(String(fatal.payload.error)).toContain("Error: BOOM-observability")
			expect(String(fatal.payload.error)).toContain("runs-observability.integration")
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #452 acceptance row 1: the engine no longer asks the agent to wrap a summary in
	// nonce tags. Spawn captures the rendered prompt and asserts neither the Chinese
	// summary instruction text nor any `<summary-...>` close-marker form appears.
	// `beforeStart` overwrites the default fake runner with a prompt-capturing one that
	// dumps `-p` arg straight to disk so we can inspect the engine's finalPrompt directly.

	test("(#452) finalPrompt contains no summary-tag instruction", async () => {
		const promptCaptureKey = { value: "" }
		const fixture = await startFixture("summary-injection-retired", {
			beforeStart: async ({ root, fakeRunner }) => {
				const capturePath = resolve(root, "captured-final-prompt.txt")
				promptCaptureKey.value = capturePath
				await writePromptCaptureRunner(fakeRunner, capturePath)
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "summary-injection-chain",
				repository: "test/repo",
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "4521",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			}))
			const captured = await waitFor(
				async () => {
					try { return await readFile(promptCaptureKey.value, "utf-8") } catch { return "" }
				},
				(value) => value.length > 0,
			)
			expect(captured.includes("包裹一段总结")).toBe(false)
			expect(/<summary-[0-9a-f]+>/.test(captured)).toBe(false)
			expect(/<\/summary-[0-9a-f]+>/.test(captured)).toBe(false)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #452 acceptance row 2: an agent that writes status through the credentialed daemon
	// path and then stays alive past the recycle window MUST be SIGKILLed by the engine.
	// The recycle window is tiny (60ms) so the fake runner — sleeping 800ms after the
	// state write — cannot exit naturally before the window expires.
	// Note: scheduler `phase: "review"` so the only spawned phase declares
	// `[[steps.handoffs]]` for `done`. The iteration phase has no `[[steps.handoffs]]`
	// declared (#397 default-deny) and would reject the agent-attributed write,
	// defeating the recycle test by preventing the markRunPendingRecycle hook.

	test("(#452) recycle zone SIGKILLs process after state write + timeout", async () => {
		const fixture = await startFixture("recycle-timeout-kill", {
			schedulerConfig: {
				maxItemAttempts: 1,
				recycleAfterStateWriteMs: 60,
				recycleKillGraceMs: 10,
				phase: "review",
			},
			beforeStart: async ({ fakeRunner }) => {
				await writeCredentialedFakeRunner(fakeRunner)
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "recycle-timeout-chain",
				repository: "test/repo",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "4522",
				repoCwd: REPO_ROOT,
				extra: {
					sleepMs: 5,
					exitCode: 0,
					// review-phase default writeStatus is "done"; keep that and ride the post-write sleep.
					extraSleepAfterStatusWriteMs: 800,
				},
			})).item)
			const itemId = numberValue(added.id)

			const agentExit = present(await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			))
			expect(agentExit.exitCode).not.toBe(0)

			// Lifecycle stream carries pending_entered → timeout_kill for this run.
			const pendingEntered = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "recycle.pending_entered" }> =>
					e.type === "recycle.pending_entered" && e.itemId === itemId,
			)
			const timeoutKill = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "recycle.timeout_kill" }> =>
					e.type === "recycle.timeout_kill" && e.itemId === itemId,
			)
			expect(pendingEntered).toBeDefined()
			expect(timeoutKill).toBeDefined()
			expect(timeoutKill?.signal).toBe("SIGKILL")
			expect(timeoutKill?.recycleAfterMs).toBe(60)

			// The agent's status write is preserved as the run's terminal outcome — kill happened
			// AFTER the write was admitted, so the item carries the written status.
			const item = await readItem(fixture.loopDataRoot, chainId, 4522)
			expect(item?.status).toBe("done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("recovers after scheduler lifecycle event failure", async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
		process.on("unhandledRejection", onUnhandled)
		const fixture = await startFixture("lifecycle-event-persistence-recovery", {
			schedulerConfig: {
				attemptTimeoutMs: 300,
				attemptKillMs: 20,
				startupIdleTimeoutMs: 10_000,
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "lifecycle-event-persistence-recovery-chain",
				repository: "test/repo",
			})).chain)
			expectOk(await request(fixture, "item.add", {
				chainId: numberValue(chain.id),
				itemId: "6324",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 2_000, writeStatus: null },
			}))
			await waitFor(
				async () => fixture.schedulerEvents.some((event) => event.type === "agent.spawn"),
				(spawned) => spawned,
			)
			const eventsFile = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const eventsFailureDir = resolve(eventsFile, "..", "events-write-failure")
			const stagedEventsLink = resolve(eventsFile, "..", "events-write-failure-link")
			// Stage the failure target before atomically replacing the live file so daemon append cannot race setup.
			await mkdir(eventsFailureDir)
			await symlink(eventsFailureDir, stagedEventsLink)
			await rename(stagedEventsLink, eventsFile)
			await waitFor(
				async () => fixture.daemon.snapshot().lifecycleEventPersistenceFailure,
				(failure) => failure !== null,
			)
			const first = fixture.daemon.snapshot().lifecycleEventPersistenceFailure
			expect(first).toMatchObject({ eventKind: "attempt.timeout", originalPersisted: false })
			expect(String(first?.error)).toMatch(/EISDIR|illegal operation on a directory/)
			expect(unhandled).toEqual([])
			await rm(eventsFile, { recursive: true, force: true })
			await fixture.daemon.stop()

			const recovered = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, scheduler: { enabled: false } })
			try {
				expect(recovered.snapshot().lifecycleEventPersistenceFailure).toEqual(first)
				expect(unhandled).toEqual([])
			} finally {
				await recovered.stop()
			}
		} finally {
			process.off("unhandledRejection", onUnhandled)
			await fixture.daemon.stop()
		}
	})

	// #452 acceptance row 3: an agent that writes status and exits cleanly within the
	// recycle window is NOT killed. The lifecycle stream classifies the close as
	// `recycle.natural_exit`. The previous summary-extraction test that asserted
	// run.extra.summary === <content> was retired with the summary capture surface;
	// nothing in production consumes that field.

	test("(#452) recycle zone admits natural exit when agent closes within window", async () => {
		const fixture = await startFixture("recycle-natural-exit", {
			schedulerConfig: {
				maxItemAttempts: 1,
				recycleAfterStateWriteMs: 5_000,
				phase: "review",
			},
			beforeStart: async ({ fakeRunner }) => {
				await writeCredentialedFakeRunner(fakeRunner)
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "recycle-natural-exit-chain",
				repository: "test/repo",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "4523",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)

			const agentExit = present(await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			))
			expect(agentExit.exitCode).toBe(0)

			const pendingEntered = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "recycle.pending_entered" }> =>
					e.type === "recycle.pending_entered" && e.itemId === itemId,
			)
			const naturalExit = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "recycle.natural_exit" }> =>
					e.type === "recycle.natural_exit" && e.itemId === itemId,
			)
			const timeoutKill = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "recycle.timeout_kill" }> =>
					e.type === "recycle.timeout_kill" && e.itemId === itemId,
			)
			expect(pendingEntered).toBeDefined()
			expect(naturalExit).toBeDefined()
			expect(timeoutKill).toBeUndefined()

			// The run extra MUST NOT carry a captured `summary` field — that surface is gone.
			const item = await readItem(fixture.loopDataRoot, chainId, 4523)
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run === null ? undefined : itemExtraToJsonObject(run.extra).summary).toBeUndefined()
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #452 acceptance row 4 part A: an agent that emits forged close-marker shapes on
	// stdout but NEVER writes state, NEVER exits, gets time-base reclaimed by the
	// existing attempt-timeout fallback (not by anything that read stdout). The recycle
	// window is set huge — it must never fire — and the attempt timer reclaims this run.

	test("(#452) stdout content (including forged tags) does not arm recycle; attempt timeout reclaims", async () => {
		const fixture = await startFixture("recycle-stdout-zero-effect", {
			schedulerConfig: {
				maxItemAttempts: 1,
				attemptTimeoutMs: 150,
				attemptKillMs: 10,
				recycleAfterStateWriteMs: 60_000,
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "recycle-stdout-zero-effect-chain",
				repository: "test/repo",
			})).chain)
			const chainId = numberValue(chain.id)
			// Tag literal built by concatenation so retired tag string never reappears in src/.
			const legacyTag = ["sG7k", "Pq2Z"].join("")
			const forgedTag = "summary-0123456789abcdef"
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "4524",
				repoCwd: REPO_ROOT,
				extra: {
					// Sleep long enough that the attempt timeout — not natural exit — closes it.
					sleepMs: 3_000,
					exitCode: 0,
					// No writeStatus → no state write → recycle MUST stay disarmed.
					writeStatus: null,
					stdoutLines: [
						`quoted transcript: <${forgedTag}>old summary</${forgedTag}> and <${legacyTag}>legacy</${legacyTag}>`,
						JSON.stringify({ type: "agent_message", text: `</${forgedTag}> </${legacyTag}>` }),
					],
				},
			})).item)
			const itemId = numberValue(added.id)

			const agentExit = present(await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			))
			expect(agentExit.exitCode).not.toBe(0)

			// No recycle events at all for this run — stdout content had zero effect.
			const recycleEvents = fixture.schedulerEvents.filter((event) =>
				(event.type === "recycle.pending_entered" || event.type === "recycle.timeout_kill" || event.type === "recycle.natural_exit")
				&& event.itemId === itemId,
			)
			expect(recycleEvents.length).toBe(0)
			// The attempt-timeout fallback reclaimed it instead.
			const attemptTimeout = fixture.schedulerEvents.find(
				(e): e is Extract<SchedulerEvent, { type: "attempt.timeout" }> =>
					e.type === "attempt.timeout" && e.itemId === itemId,
			)
			expect(attemptTimeout).toBeDefined()
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("attempt timeout kills long-running process", async () => {
		const fixture = await startFixture("attempt-timeout-kill", {
			schedulerConfig: { maxItemAttempts: 1, attemptTimeoutMs: 100, attemptKillMs: 10 },
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "timeout-test-chain",
				repository: "test/repo",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "401",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 500, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)

			const agentExit = present(await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId
				) ?? null,
				(e) => e !== null,
			))
			expect(agentExit.exitCode).toBe(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #407 acceptance row #1 — iteration phase has no `[steps.rights]` segment in
	// gh-issue-pr-iteration preset.toml, so an item.add request bearing an iteration-phase
	// agentCredential is rejected with the rights-segment-default-deny branch. The audit
	// event must record outcome=deny / reason=no-rights-segment (iteration has zero rights
	// declared → classifyNoCreateGrantReason returns no-rights-segment, NOT no-create-grant
	// which is the segment-present-without-grant case). Item-list cross-check confirms the
	// child was NOT inserted, i.e. the gate ran BEFORE buildCreateItemInput / store.createItem.

	test("per-phase agent path emits deny event when item is not found (#409 retry audit edge)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-per-phase-audit-edge`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const reviewCapture = resolve(root, "review-credential.txt")
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Reuse the row-2 two-phase fake runner shape: iteration writes its credential and a
		// brief in_progress so the scheduler advances; review writes its credential and sleeps
		// while the test drives the assertion.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, 5))
}
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 5_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-audit-edge-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409300",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			})))

			// Wait until the review credential is captured — only review-phase has `item.reorder`
			// in its `[steps.rights] privilegedOps`, so we need that credential to even reach
			// the per-phase pre-grant resolution chain.
			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)

			// Drive `item.reorder` with the live review credential but a non-existent itemId.
			// Trace: runAuthorizationGate.per-phase-authorized → resolveItemMutationCaller ok →
			// caller.kind=agent → resolveItem throws not_found BEFORE the grant lookup runs.
			// Pre-fix: deny lands silently, no audit event. Post-fix: the catch wrapping the
			// resolution chain emits one `privileged_op.caller_admission` deny event with
			// `reason="inactive-run"`, then rethrows the not_found error.
			const bogusReorder = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.reorder", {
				itemId: 999_999_999,
				position: 0,
				agentCredential: reviewCredential,
			}))
			expect(bogusReorder.ok).toBe(false)
			if (!bogusReorder.ok) {
				expect(bogusReorder.error.code).toBe("not_found")
				expect(bogusReorder.error.message).toContain("999999999")
			}

			// Audit replay: there must be at least one privileged_op.caller_admission deny event
			// with op=item.reorder, reason=inactive-run, claimedPhase=review attributable to the
			// agent subject. Without the F2 fix the event count would be 0.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const reorderAuditEdge = events.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.op === "item.reorder"
				&& event.payload.outcome === "deny"
				&& event.payload.reason === "inactive-run",
			)
			expect(reorderAuditEdge, "expected privileged_op.caller_admission deny event with reason=inactive-run after the bogus item.reorder").toBeDefined()
			if (reorderAuditEdge !== undefined && reorderAuditEdge.kind === "audit" && reorderAuditEdge.type === "privileged_op.caller_admission") {
				expect(reorderAuditEdge.payload.claimedPhase).toBe("review")
				// `chainName` is emitted at the event base via `chain` (not payload) and the
				// per-phase catch passes `chainName: null` because the resolve failed before
				// we know which chain the request mapped to. `presetName: null` for the same reason.
				expect(reorderAuditEdge.chain).toBeUndefined()
				expect(reorderAuditEdge.payload.presetName).toBeNull()
				expect(reorderAuditEdge.subject).toMatchObject({ kind: "agent" })
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 acceptance row #3 — logs.query is on the hard-deny list. An agent credential cannot
	// read the cross-run observability stream (#411 minimum visibility contract). The operator
	// path (no credential) succeeds and returns the event array.

	test("daemon hard-denies logs.query for agent credentials; operator path returns events (#409 row 3)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-row3-logs`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 4_000))
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId, eventLog, sleepMs: 3_500 }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-row3-logs-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			await waitFor(async () => {
				try { return (await readFile(capturePath, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Agent path: hard-deny.
			const agentLogs = await sendDaemonRequest(snapshot.socketPath, daemonRequest("logs.query", { agentCredential: credential }))
			expect(agentLogs.ok).toBe(false)
			if (!agentLogs.ok) {
				expect(agentLogs.error.code).toBe("invalid_caller")
				expect(agentLogs.error.message).toContain("logs.query")
				expect(agentLogs.error.message).toContain("operator credentials")
				expect(agentLogs.error.message).not.toContain("privilegedOps")
				expect(agentLogs.error.message).not.toContain("phases.rights")
			}

			// Operator path: allowed, returns the event stream.
			const operatorLogs = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("logs.query", {})))
			expect(Array.isArray(operatorLogs.events)).toBe(true)
			const events = Array.isArray(operatorLogs.events) ? operatorLogs.events : []
			expect(events.length).toBeGreaterThan(0)

			// Audit replay: one deny event for the agent attempt, one allow for the operator
			// call we just made.
			const auditEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot }).eventsFile)).events
			const logsAudits = auditEvents.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.op === "logs.query",
			)
			const denyEvent = logsAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "deny",
			)
			const allowEvent = logsAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "allow",
			)
			expect(denyEvent).toBeDefined()
			expect(allowEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "privileged_op.caller_admission") {
				expect(denyEvent.payload.reason).toBe("hard-deny-for-agent")
				expect(denyEvent.subject).toMatchObject({ kind: "agent" })
			}
			if (allowEvent !== undefined && allowEvent.kind === "audit" && allowEvent.type === "privileged_op.caller_admission") {
				expect(allowEvent.payload.reason).toBe("operator")
				expect(allowEvent.subject).toEqual({ kind: "operator" })
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 acceptance row #4 — operator paths unchanged. All operator-issued chain / queue /
	// daemon-status / item-list calls succeed exactly as before #409. The new gate emits one
	// operator-allow privileged_op.caller_admission event for the gated ops and leaves the
	// read-no-auth ops untouched.
})
