import {
	TEST_ROOT,
	PRESET_DIR,
	REPO_ROOT,
	buildCoderLoopStatusSnapshot,
	chmod,
	cp,
	describe,
	expect,
	expectOk,
	itemExtraToJsonObject,
	mkdir,
	numberValue,
	openSqliteStateStore,
	queryObservabilityEvents,
	readChainStatus,
	readCurrentRun,
	readFile,
	readItem,
	readRun,
	record,
	request,
	resolve,
	resolveLoopDataPaths,
	runtimeStatus,
	staleRecoveryRunExtra,
	startCoderLoopDaemon,
	startFixture,
	storedChainMetadata,
	storedItemExtra,
	test,
	waitFor,
	writeFile,
	type Fixture,
} from "./harness"
import { listActiveRuns, type SchedulerActiveRun } from "../../../src/scheduler"
import { withExternalTerminalLoss } from "../../../src/runtime-data"

let nextExternalFixtureId = 0

function modelControlledDaemonRunAsExternalTerminal(
  fixture: Fixture,
  run: SchedulerActiveRun,
  probeBinary: string,
): void {
  run.runner = { kind: "hapi", source: "iteration-default", binary: probeBinary, extraArgs: [], model: null }
  const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
  try {
    const current = store.getCurrentRun(run.chainId)
    const durable = store.getRunByRunId(run.runId)
    if (current === null || durable === null) throw new Error("controlled active run is not durable")
    const externalTerminalCurrent = {
      runner: "hapi" as const,
      binary: probeBinary,
      availability: { kind: "available" as const, checkedAt: new Date(run.startedAt * 1000).toISOString() },
    }
    store.updateRunExtra(run.runId, storedItemExtra({ ...itemExtraToJsonObject(durable.extra), externalTerminalCurrent }))
    store.setCurrentRun({ ...current, extra: storedItemExtra({ ...itemExtraToJsonObject(current.extra), externalTerminalCurrent }) })
  } finally {
    store.close()
  }
}

describe("daemon external-terminal lifecycle", () => {
test("preset-selected external terminal is held before add and batch-add return", async () => {
		const presetDir = resolve(TEST_ROOT, "preset-selected-external-terminal")
		const fakeBinary = resolve(TEST_ROOT, "preset-selected-external-terminal-binary")
		const probeLog = resolve(TEST_ROOT, "preset-selected-external-terminal-probes")
		await cp(PRESET_DIR, presetDir, { recursive: true })
		const presetToml = resolve(presetDir, "preset.toml")
		await writeFile(presetToml, (await readFile(presetToml, "utf-8")).replaceAll('runner = "codex"', 'runner = "hapi"').replaceAll('runner  = "codex"', 'runner  = "hapi"'))
		await writeFile(fakeBinary, `#!/bin/sh\nif [ "$1" = probe ]; then echo probe >> ${JSON.stringify(probeLog)}; exit 69; fi\nexit 0\n`)
		await chmod(fakeBinary, 0o755)
		const fixture = await startFixture("preset-selected-external-terminal", {
			schedulerEnabled: false,
			schedulerPresetDir: presetDir,
			schedulerUsePresetRunner: true,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "preset-hapi", repository: "fixture/repo", baseBranch: "main", preset: "gh-issue-pr-iteration", metadata: { hapi: { binary: fakeBinary } } })))
			const chainId = numberValue(record(chain.chain).id)
			expectOk(await request(fixture, "item.batchAdd", { chainId, items: [
				{ itemId: "602-batch-a", repoCwd: REPO_ROOT, presetPath: presetDir },
				{ itemId: "602-batch-b", repoCwd: REPO_ROOT, presetPath: presetDir },
			] }))
			let listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			if (!Array.isArray(listed.items)) throw new Error("item list missing")
			expect(listed.items).toHaveLength(2)
			for (const item of listed.items) expect(record(record(item).extra).externalTerminalHold).toBeDefined()
			const batchWarnings = fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")
			expect(batchWarnings).toHaveLength(1)
			expect(batchWarnings[0]).toMatchObject({
				type: "runner.external_terminal_unavailable",
				affected: [
					{ itemId: "602-batch-a", phase: "iteration" },
					{ itemId: "602-batch-b", phase: "iteration" },
				],
			})
			expectOk(await request(fixture, "item.add", { chainId, itemId: "602-add", repoCwd: REPO_ROOT, presetPath: presetDir }))
			listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			if (!Array.isArray(listed.items)) throw new Error("item list missing")
			expect(listed.items).toHaveLength(3)
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")).toHaveLength(1)
			const callsBeforeUpdate = (await readFile(probeLog, "utf-8")).trim().split("\n").length
			expectOk(await request(fixture, "item.update", { chainId, itemId: "602-add", fields: { runner: "codex" } }))
			listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			if (!Array.isArray(listed.items)) throw new Error("item list missing")
			const localUpdated = listed.items.map(record).find((item) => item.itemId === "602-add")
			if (localUpdated === undefined) throw new Error("local updated item missing")
			expect(record(localUpdated.extra).externalTerminalHold).toBeUndefined()
			expectOk(await request(fixture, "item.update", { chainId, itemId: "602-add", fields: { runner: null } }))
			const callsAfterUpdate = (await readFile(probeLog, "utf-8")).trim().split("\n").length
			expect(callsAfterUpdate).toBe(callsBeforeUpdate + 1)
			listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			if (!Array.isArray(listed.items)) throw new Error("item list missing")
			const updated = listed.items.map(record).find((item) => item.itemId === "602-add")
			if (updated === undefined) throw new Error("updated item missing")
			expect(record(record(updated.extra).externalTerminalHold).runner).toBe("hapi")
		} finally {
			await fixture.daemon.stop()
		}
	})

test("terminal update while an external terminal is unavailable clears the hold without probing again", async () => {
		const presetDir = resolve(TEST_ROOT, "terminal-update-clears-external-terminal-hold")
		const fakeBinary = resolve(TEST_ROOT, "terminal-update-clears-external-terminal-hold-binary")
		const probeLog = resolve(TEST_ROOT, "terminal-update-clears-external-terminal-hold-probes")
		await cp(PRESET_DIR, presetDir, { recursive: true })
		const presetToml = resolve(presetDir, "preset.toml")
		await writeFile(presetToml, (await readFile(presetToml, "utf-8")).replaceAll('runner = "codex"', 'runner = "hapi"').replaceAll('runner  = "codex"', 'runner  = "hapi"'))
		await writeFile(fakeBinary, `#!/bin/sh\nif [ "$1" = probe ]; then echo probe >> ${JSON.stringify(probeLog)}; exit 69; fi\nexit 0\n`)
		await chmod(fakeBinary, 0o755)
		const fixture = await startFixture("terminal-update-clears-external-terminal-hold", {
			schedulerEnabled: false,
			schedulerPresetDir: presetDir,
			schedulerUsePresetRunner: true,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "terminal-hapi", repository: "fixture/repo", baseBranch: "main", preset: "gh-issue-pr-iteration", metadata: { hapi: { binary: fakeBinary } } })))
			const chainId = numberValue(record(chain.chain).id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "602-terminal", repoCwd: REPO_ROOT, presetPath: presetDir }))
			const probesBeforeTerminal = (await readFile(probeLog, "utf-8")).trim().split("\n").length
			expectOk(await request(fixture, "item.update", { chainId, itemId: "602-terminal", fields: { status: "done" } }))
			const probesAfterTerminal = (await readFile(probeLog, "utf-8")).trim().split("\n").length
			expect(probesAfterTerminal).toBe(probesBeforeTerminal)
			const listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			if (!Array.isArray(listed.items)) throw new Error("item list missing")
			const terminal = listed.items.map(record).find((item) => item.itemId === "602-terminal")
			if (terminal === undefined) throw new Error("terminal item missing")
			expect(terminal.status).toBe("done")
			expect(record(terminal.extra).externalTerminalHold).toBeUndefined()
		} finally {
			await fixture.daemon.stop()
		}
	})

test("create and scheduler probe-failed race emits one availability transition", async () => {
		const presetDir = resolve(TEST_ROOT, "probe-failed-create-scheduler-race")
		const fakeBinary = resolve(TEST_ROOT, "probe-failed-create-scheduler-race-binary")
		await cp(PRESET_DIR, presetDir, { recursive: true })
		const presetToml = resolve(presetDir, "preset.toml")
		await writeFile(presetToml, (await readFile(presetToml, "utf-8")).replaceAll('runner = "codex"', 'runner = "hapi"').replaceAll('runner  = "codex"', 'runner  = "hapi"'))
		await writeFile(fakeBinary, "#!/bin/sh\nif [ \"$1\" = probe ]; then sleep 0.1; exit 2; fi\nexit 0\n")
		await chmod(fakeBinary, 0o755)
		const fixture = await startFixture("probe-failed-create-scheduler-race", {
			schedulerPresetDir: presetDir,
			schedulerUsePresetRunner: true,
			schedulerIntervalMs: 10,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "probe-failed-race", repository: "fixture/repo", baseBranch: "main", preset: "gh-issue-pr-iteration", metadata: { hapi: { binary: fakeBinary } } })))
			const chainId = numberValue(record(chain.chain).id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "602-probe-failed-race", repoCwd: REPO_ROOT, presetPath: presetDir }))
			await new Promise((resolveDone) => setTimeout(resolveDone, 250))
			const warnings = fixture.schedulerEvents.filter((event) => event.type === "runner.external_terminal_unavailable")
			expect(warnings).toHaveLength(1)
			expect(warnings[0]).toMatchObject({ availability: { kind: "probe-failed", reason: "unexpected-exit", exitCode: 2 } })
		} finally {
			await fixture.daemon.stop()
		}
	})

test("healthy active external terminal projects available current state", async () => {
		const presetDir = resolve(TEST_ROOT, "healthy-active-external-terminal")
		const fakeBinary = resolve(TEST_ROOT, "healthy-active-external-terminal-binary")
		await cp(PRESET_DIR, presetDir, { recursive: true })
		await writeFile(fakeBinary, "#!/bin/sh\nexit 0\n")
		await chmod(fakeBinary, 0o755)
		const fixture = await startFixture("healthy-active-external-terminal", {
			schedulerPresetDir: presetDir,
			schedulerIntervalMs: 60_000,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "healthy-hapi",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				preset: "gh-issue-pr-iteration",
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "602-current", repoCwd: REPO_ROOT, presetPath: presetDir, extra: { sleepMs: 10_000 } }))
			const active = await waitFor(
				async () => listActiveRuns(fixture.daemon.schedulerExecutionState()).find((run) => run.chainId === chainId) ?? null,
				(candidate) => candidate !== null,
			)
			if (active === null) throw new Error("expected controlled active run")
			modelControlledDaemonRunAsExternalTerminal(fixture, active, fakeBinary)
			const current = await waitFor(
				() => readCurrentRun(fixture.loopDataRoot, chainId),
				(candidate) => candidate?.extra.externalTerminalCurrent !== undefined,
			)
			expect(current?.extra.externalTerminalCurrent).toMatchObject({
				runner: "hapi",
				binary: fakeBinary,
				availability: { kind: "available", checkedAt: expect.any(String) },
			})
			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName: "healthy-hapi",
				output: "json",
			})
			expect(snapshot.current.run?.extra.externalTerminalCurrent).toMatchObject({ runner: "hapi" })
			expect(snapshot.current.externalTerminal).toEqual({
				availability: { kind: "available", checkedAt: expect.any(String) },
				loss: null,
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

test("status projects a latched per-run external-terminal loss before current cleanup", async () => {
		const presetDir = resolve(TEST_ROOT, "latched-loss-status-projection")
		const fakeBinary = resolve(TEST_ROOT, "latched-loss-status-projection-binary")
		await cp(PRESET_DIR, presetDir, { recursive: true })
		await writeFile(fakeBinary, "#!/bin/sh\nexit 0\n")
		await chmod(fakeBinary, 0o755)
		const fixture = await startFixture("latched-loss-status-projection", {
			schedulerPresetDir: presetDir,
			schedulerIntervalMs: 60_000,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "latched-loss-status",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				preset: "gh-issue-pr-iteration",
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "602-loss-status", repoCwd: REPO_ROOT, presetPath: presetDir, extra: { sleepMs: 10_000 } }))
			const active = await waitFor(
				async () => listActiveRuns(fixture.daemon.schedulerExecutionState()).find((run) => run.chainId === chainId) ?? null,
				(candidate) => candidate !== null,
			)
			if (active === null) throw new Error("expected controlled active run")
			modelControlledDaemonRunAsExternalTerminal(fixture, active, fakeBinary)
			const current = await waitFor(
				() => readCurrentRun(fixture.loopDataRoot, chainId),
				(candidate) => candidate?.extra.externalTerminalCurrent !== undefined,
			)
			if (current === null) throw new Error("expected active external-terminal run")
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const run = store.getRunByRunId(current.runId)
				if (run === null) throw new Error("expected durable run")
				store.updateRunExtra(current.runId, withExternalTerminalLoss(run.extra, {
					kind: "lost",
					detectedAt: "2026-07-15T00:00:02.000Z",
					reason: "endpoint-unavailable",
					terminationPhase: "term",
				}))
			} finally {
				store.close()
			}

			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName: "latched-loss-status",
				output: "json",
			})
			expect(snapshot.current.run?.runId).toBe(current.runId)
			expect(snapshot.current.externalTerminal?.loss).toEqual({
				kind: "lost",
				detectedAt: "2026-07-15T00:00:02.000Z",
				reason: "endpoint-unavailable",
				terminationPhase: "term",
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

test("mixed-preset status projects an active and lost chain-complete external terminal", async () => {
		let chainPresetDir = ""
		let itemPresetDir = ""
		let externalBinary = ""
		let ordinaryBinary = ""
		const fixture = await startFixture("mixed-preset-chain-complete-status-projection", {
			useDefaultChainCompleteTrigger: true,
			schedulerPresetDir: null,
			schedulerUsePresetRunner: true,
			schedulerIntervalMs: 20,
			beforeStart: async ({ root, fakeRunner }) => {
				chainPresetDir = resolve(root, "chain-preset")
				itemPresetDir = resolve(root, "item-preset")
				externalBinary = resolve(root, "external-terminal-finalizer")
				ordinaryBinary = resolve(root, "ordinary-runner")
				await cp(PRESET_DIR, chainPresetDir, { recursive: true })
				await cp(resolve(REPO_ROOT, "presets/single-phase-example"), itemPresetDir, { recursive: true })
				const presetToml = resolve(chainPresetDir, "preset.toml")
				await writeFile(presetToml, (await readFile(presetToml, "utf-8")).replace(
					'name    = "umbrella-finalizer"\nprompt  = "umbrella-finalizer-entry.md"\ntrigger = { on = "chain-complete" }\nrunner  = "codex"',
					'name    = "umbrella-finalizer"\nprompt  = "umbrella-finalizer-entry.md"\ntrigger = { on = "chain-complete" }\nrunner  = "opencode"',
				))
				const itemPresetToml = resolve(itemPresetDir, "preset.toml")
				await writeFile(itemPresetToml, (await readFile(itemPresetToml, "utf-8")).replace(
					'name   = "run"\nprompt = "run-entry.md"',
					'name   = "review"\nprompt = "run-entry.md"\nrunner = "claude"',
				))
				await writeFile(ordinaryBinary, `#!/bin/sh\nexec bun ${JSON.stringify(fakeRunner)} "$@"\n`)
				await writeFile(externalBinary, "#!/bin/sh\nif [ \"$1\" = probe ]; then exit 0; fi\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n")
				await chmod(ordinaryBinary, 0o755)
				await chmod(externalBinary, 0o755)
			},
		})
		try {
			const chainName = "mixed-preset-chain-complete-status-projection-chain"
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				preset: "gh-issue-pr-iteration",
				metadata: {
					presetPath: chainPresetDir,
					claude: { binary: ordinaryBinary },
					opencode: { binary: externalBinary },
				},
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "602-mixed-chain-complete-status",
				repoCwd: REPO_ROOT,
				presetPath: itemPresetDir,
				extra: { eventLog: fixture.eventLog, writeStatus: "done" },
			}))
			const active = await waitFor(
				async () => listActiveRuns(fixture.daemon.schedulerExecutionState()).find((run) => run.chainId === chainId && run.phase === "umbrella-finalizer") ?? null,
				(candidate) => candidate !== null,
				10_000,
			)
			if (active === null) throw new Error("expected controlled chain-complete run")
			modelControlledDaemonRunAsExternalTerminal(fixture, active, externalBinary)
			const current = await readCurrentRun(fixture.loopDataRoot, chainId)
			if (current === null) throw new Error("expected active chain-complete external-terminal run")
			const finalizerSpawn = await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "agent.spawn" && event.phase === "umbrella-finalizer") ?? null,
				(candidate) => candidate !== null,
			)
			expect(finalizerSpawn).toMatchObject({ type: "agent.spawn", phase: "umbrella-finalizer" })
			if (finalizerSpawn?.type !== "agent.spawn") throw new Error("expected chain-complete spawn event")
			expect(await readFile(resolve(finalizerSpawn.presetDir, "preset.toml"), "utf-8")).toContain(
				'name    = "umbrella-finalizer"\nprompt  = "umbrella-finalizer-entry.md"\ntrigger = { on = "chain-complete" }\nrunner  = "opencode"',
			)
			expect(finalizerSpawn.presetDir).not.toBe(itemPresetDir)

			const activeSnapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				output: "json",
			})
			expect(activeSnapshot.current.runner).toMatchObject({ kind: "opencode", binary: externalBinary })
			expect(activeSnapshot.current.externalTerminal).toEqual({
				availability: { kind: "available", checkedAt: expect.any(String) },
				loss: null,
			})

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const run = store.getRunByRunId(current.runId)
				if (run === null) throw new Error("expected durable chain-complete run")
				store.updateRunExtra(current.runId, withExternalTerminalLoss(run.extra, {
					kind: "lost",
					detectedAt: "2026-07-16T00:00:02.000Z",
					reason: "endpoint-unavailable",
					terminationPhase: "term",
				}))
			} finally {
				store.close()
			}

			const lostSnapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				output: "json",
			})
			expect(lostSnapshot.current.externalTerminal?.loss).toEqual({
				kind: "lost",
				detectedAt: "2026-07-16T00:00:02.000Z",
				reason: "endpoint-unavailable",
				terminationPhase: "term",
			})
		} finally {
			await fixture.daemon.stop()
		}
	}, 15_000)

test("daemon keeps ticking while a scheduler-managed chain-complete external terminal is lost and revokes its credential", async () => {
		let externalBinary = ""
		let probeState = ""
		let credentialCapture = ""
		let ordinaryRunner = ""
		let allowControlledFinalizerSpawn = true
		const fixture = await startFixture("chain-complete-external-terminal-loss-boundary", {
			useDefaultChainCompleteTrigger: true,
			schedulerIntervalMs: 20,
			beforeStart: async ({ root, fakeRunner }) => {
				externalBinary = resolve(root, "external-terminal-finalizer")
				probeState = resolve(root, "probe-state")
				credentialCapture = resolve(root, "credential.txt")
				ordinaryRunner = fakeRunner
				await writeFile(probeState, "0")
				await writeFile(externalBinary, `#!/bin/sh
if [ "$1" = probe ]; then
	[ "$(cat ${JSON.stringify(probeState)})" = 69 ] && exit 69
	exit 0
fi
printf '%s' "$CODER_LOOP_RUN_CRED" > ${JSON.stringify(credentialCapture)}
if [ "$(cat ${JSON.stringify(probeState)})" = complete ]; then
	echo "FINALIZER SUMMARY: decision=complete; reason=daemon-boundary"
	exit 0
fi
trap 'exit 0' TERM
while :; do sleep 1; done
`)
				await chmod(externalBinary, 0o755)
			},
			schedulerConfig: {
				phaseRunner: ({ phase }) => {
					if (phase !== "umbrella-finalizer") return { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [ordinaryRunner], model: null }
					if (allowControlledFinalizerSpawn) return { kind: "claude", source: "iteration-default", binary: externalBinary, extraArgs: [], model: null }
					return { kind: "hapi", source: "iteration-default", binary: externalBinary, extraArgs: [], model: null }
				},
				attemptKillMs: 100,
			},
		})
		try {
			const chainName = "chain-complete-external-terminal-loss-boundary-chain"
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "602-chain-complete-loss",
				repoCwd: REPO_ROOT,
				extra: { writeStatus: "done" },
			})).item)
			const itemId = numberValue(added.id)
			const credential = await waitFor(async () => {
				try { return (await readFile(credentialCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 10_000)
			const active = await waitFor(
				async () => listActiveRuns(fixture.daemon.schedulerExecutionState()).find((run) => run.chainId === chainId && run.phase === "umbrella-finalizer") ?? null,
				(candidate) => candidate !== null,
			)
			if (active === null) throw new Error("expected controlled chain-complete run")
			allowControlledFinalizerSpawn = false
			modelControlledDaemonRunAsExternalTerminal(fixture, active, externalBinary)
			const beforeLoss = await readCurrentRun(fixture.loopDataRoot, chainId)
			expect(beforeLoss).toMatchObject({ phase: "umbrella-finalizer", extra: { itemId } })

			await writeFile(probeState, "69")
			await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "runner.external_terminal_unavailable" && event.phase === "umbrella-finalizer") ?? null,
				(event) => event !== null,
				5_000,
			)
			await waitFor(() => readCurrentRun(fixture.loopDataRoot, chainId), (current) => current === null, 5_000)
			const storeAfterLoss = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const lostRun = storeAfterLoss.listRuns(chainId).find((run) => run.phase === "umbrella-finalizer")
				expect(lostRun?.extra.externalTerminalLoss).toMatchObject({ kind: "lost", reason: "endpoint-unavailable", terminationPhase: "closed" })
			} finally {
				storeAfterLoss.close()
			}
			const denied = await request(fixture, "item.update", {
				chainId,
				itemId: "602-chain-complete-loss",
				fields: { title: "must remain denied" },
				agentCredential: credential,
			})
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error).toMatchObject({ code: "invalid_caller" })
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("active")

			await writeFile(probeState, "complete")
			await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "runner.invocation_pending" && event.phase === "umbrella-finalizer") ?? null,
				(event) => event !== null,
				10_000,
			)
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("active")
			expect(await readCurrentRun(fixture.loopDataRoot, chainId)).toBeNull()
			expect(fixture.schedulerEvents.some((event) => event.type === "runner.external_terminal_unavailable" && event.phase === "umbrella-finalizer")).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	}, 15_000)

test("terminal-first chain-complete close does not leave a stale active-run read in the probing tick", async () => {
		let externalBinary = ""
		let probeState = ""
		let probeWaiting = ""
		let probeRelease = ""
		let finalizerStarted = ""
		let finalizerRelease = ""
		let ordinaryRunner = ""
		const fixture = await startFixture("chain-complete-terminal-first-probe-race", {
			useDefaultChainCompleteTrigger: true,
			schedulerIntervalMs: 20,
			beforeStart: async ({ root, fakeRunner }) => {
				externalBinary = resolve(root, "external-terminal-finalizer")
				probeState = resolve(root, "probe-state")
				probeWaiting = resolve(root, "probe-waiting")
				probeRelease = resolve(root, "probe-release")
				finalizerStarted = resolve(root, "finalizer-started")
				finalizerRelease = resolve(root, "finalizer-release")
				ordinaryRunner = fakeRunner
				await writeFile(probeState, "0")
				await writeFile(externalBinary, `#!/bin/sh
if [ "$1" = probe ]; then
	if [ "$(cat ${JSON.stringify(probeState)})" = wait-69 ]; then
		touch ${JSON.stringify(probeWaiting)}
		while [ ! -f ${JSON.stringify(probeRelease)} ]; do sleep 0.01; done
		exit 69
	fi
	exit 0
fi
touch ${JSON.stringify(finalizerStarted)}
while [ ! -f ${JSON.stringify(finalizerRelease)} ]; do sleep 0.01; done
echo "FINALIZER SUMMARY: decision=complete; reason=terminal-first"
exit 0
`)
				await chmod(externalBinary, 0o755)
			},
			schedulerConfig: {
				phaseRunner: ({ phase }) => phase === "umbrella-finalizer"
					? { kind: "claude", source: "iteration-default", binary: externalBinary, extraArgs: [], model: null }
					: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [ordinaryRunner], model: null },
			},
		})
		try {
			const chainName = "chain-complete-terminal-first-probe-race-chain"
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "602-chain-complete-terminal-first",
				repoCwd: REPO_ROOT,
				extra: { writeStatus: "done" },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(() => Bun.file(finalizerStarted).exists(), (exists) => exists, 10_000)
			const active = await waitFor(
				async () => listActiveRuns(fixture.daemon.schedulerExecutionState()).find((run) => run.chainId === chainId && run.phase === "umbrella-finalizer") ?? null,
				(candidate) => candidate !== null,
			)
			if (active === null) throw new Error("expected controlled chain-complete run")
			modelControlledDaemonRunAsExternalTerminal(fixture, active, externalBinary)

			await writeFile(probeState, "wait-69")
			await waitFor(() => Bun.file(probeWaiting).exists(), (exists) => exists, 5_000)
			await writeFile(finalizerRelease, "release")
			await waitFor(() => readCurrentRun(fixture.loopDataRoot, chainId), (current) => current === null, 5_000)
			await writeFile(probeRelease, "release")

			await waitFor(() => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
				type: "scheduler.tick_failed",
			})
			expect(events.events).toHaveLength(0)
			const terminalItem = await readItem(fixture.loopDataRoot, chainId, "602-chain-complete-terminal-first")
			expect(terminalItem).toMatchObject({ id: itemId, status: "done" })
		} finally {
			await fixture.daemon.stop()
		}
	})

test("daemon startup consumes a durable external-terminal loss latch and restores the pre-run tuple", async () => {
		const root = resolve(TEST_ROOT, `${++nextExternalFixtureId}-startup-external-terminal-loss`)
		const loopDataRoot = resolve(root, "ld")
		await mkdir(loopDataRoot, { recursive: true })
		const store = openSqliteStateStore({ loopDataRoot })
		let chainId = 0
		let itemRowId = 0
		try {
			const chain = store.createChain({ name: "startup-external-terminal-loss", preset: "gh-issue-pr-iteration", repository: "mouriya-s-lab/coder-loop", baseBranch: "main", status: "active", metadata: storedChainMetadata({}) })
			chainId = chain.id
			const item = store.createItem({
				chainId, itemId: "602-loss-crash", repoCwd: REPO_ROOT, status: runtimeStatus("in_progress"), attempts: 5,
				lastRunId: "run-loss-crash", phase: "iteration",
				extra: storedItemExtra({ schedulerBackoff: { failureCount: 2, nextRunAt: 1_900_000_000 }, externalTerminalHold: {
					kind: "external-terminal-unavailable", runner: "hapi", phase: "iteration", binary: "fake-hapi", probeArgv: ["probe"],
					availability: { kind: "unavailable", reason: "endpoint-unavailable", exitCode: 69, signal: null, checkedAt: "2026-07-15T00:00:00.000Z", since: "2026-07-15T00:00:00.000Z" },
				} }),
			})
			itemRowId = item.id
			const runExtra = staleRecoveryRunExtra(REPO_ROOT, {
				startStatus: "changes_requested", startStatusUpdatedAt: 1_900_000_000, startAttempts: 4,
				externalTerminalCurrent: { runner: "hapi", binary: "fake-hapi", availability: { kind: "available", checkedAt: "2026-07-15T00:00:01.000Z" } },
				externalTerminalLoss: { kind: "lost", detectedAt: "2026-07-15T00:00:02.000Z", reason: "endpoint-unavailable", terminationPhase: "term" },
			})
			store.recordRun({ runId: "run-loss-crash", chainId, itemId: item.id, phase: "iteration", status: runtimeStatus("running"), startedAt: 1_900_000_001, extra: runExtra })
			store.setCurrentRun({ chainId, phase: "iteration", runId: "run-loss-crash", startedAt: 1_900_000_001, extra: runExtra })
			store.setItemSessionId(item.id, { phase: "iteration", runner: "hapi", sessionId: "lost-session" })
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
		try {
			const recovered = await readItem(loopDataRoot, chainId, "602-loss-crash")
			expect(recovered).toMatchObject({ status: "changes_requested", statusUpdatedAt: 1_900_000_000, phase: null, attempts: 4 })
			const recoveredStore = openSqliteStateStore({ loopDataRoot })
			try {
				expect(recoveredStore.getItemSessionId(itemRowId, { phase: "iteration", runner: "hapi" })).toBeNull()
			} finally {
				recoveredStore.close()
			}
			expect(recovered?.extra.schedulerBackoff).toBeUndefined()
			expect(recovered?.extra.externalTerminalHold).toBeDefined()
			expect(await readCurrentRun(loopDataRoot, chainId)).toBeNull()
			const run = await readRun(loopDataRoot, "run-loss-crash")
			expect(run).toMatchObject({ itemId: itemRowId, status: "changes_requested", exitCode: -1 })
			expect(run?.extra.externalTerminalLoss).toMatchObject({ reason: "endpoint-unavailable", terminationPhase: "closed" })
			expect(run?.extra.schedulerBackoff).toBeUndefined()
		} finally {
			await daemon.stop()
		}
	})
})
