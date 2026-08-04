import { describe, expect, test } from "bun:test"
import {
	chmod, createChain, createFixture, createItem, createSchedulerState, DEFAULT_MAX_ITEM_ATTEMPTS,
	itemExtraToJsonObject, loadPreset, loadedPresetFromDir, resolve, runtimeStatus, schedulerTick, stopFixture,
	schedulerEventToObservabilityEvent, storedItemExtra, writeCustomExhaustedPreset, writeFile,
	writeMissingExhaustedDeclarationPreset,
} from "./harness"

describe("scheduler", () => {
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
			const observabilityEvent = schedulerEventToObservabilityEvent(chain, queueTerminal!, {
				runtimeNodeId: "custom-exhausted-runtime",
				definitionRef: { kind: "preset", contentIdentity: "sha256:custom-exhausted" },
				definitionNodeId: "custom-exhausted-definition",
			})
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
})
