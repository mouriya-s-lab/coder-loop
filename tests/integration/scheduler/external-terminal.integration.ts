import { describe, expect, test } from "bun:test"

import {
	REPO_ROOT,
	chmod,
	controlledLocalRunner,
	createChain,
	createFixture,
	createItem,
	existsSync,
	itemExtraToJsonObject,
	listPendingCloseHandlers,
	mkdir,
	modelControlledExternalTerminalRun,
	readFile,
	refreshExternalTerminalAvailabilityForItem,
	resolve,
	resolveChainRuntimePaths,
	runPresetChainCompleteTriggerPhases,
	runtimeStatus,
	schedulerSlotWorktreePath,
	schedulerTick,
	stopFixture,
	storedItemExtra,
	waitForFileText,
	writeFakeExternalTerminalBinary,
	writeFile,
	writeShellFinalizerMarkerScript,
	type SchedulerLoadedPreset,
} from "./harness"
import { buildPhaseRunnerSelectionFromChain } from "../../../src/loop"

const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

describe("scheduler external-terminal lifecycle", () => {
test("invocation-pending external terminal releases the repo slot before side effects", async () => {
		const fixture = await createFixture("external-terminal-invocation-pending-slot-release")
		try {
			const binary = resolve(fixture.loopDataRoot, "..", "fake-external-terminal")
			const probeState = resolve(fixture.loopDataRoot, "..", "probe-state")
			const externalEvents = resolve(fixture.loopDataRoot, "..", "external-events")
			await writeFile(probeState, "0")
			await writeFakeExternalTerminalBinary(binary, probeState, externalEvents, 1)
			const chain = createChain(fixture.store, "external-terminal-invocation-pending-slot-release-chain")
			const pending = createItem(fixture.store, chain, { issueNumber: 602_901, repoCwd: "/repo/a" })
			const sibling = createItem(fixture.store, chain, { issueNumber: 602_902, repoCwd: "/repo/a", writeStatus: "done" })
			const base = fixture.options()
			const tick = await schedulerTick({
				...base,
				phaseRunner: ({ item }) => item.id === pending.id
					? { kind: "hapi", source: "preset", binary, extraArgs: [], model: null }
					: base.runner!,
			})

			expect(tick.spawnedRuns.map((run) => run.itemId)).toEqual([sibling.id])
			expect(fixture.store.getItem(pending.id)).toMatchObject({ attempts: 0, lastRunId: null, agentCwd: null })
			expect(fixture.store.listRuns(chain.id).every((run) => run.itemId !== pending.id)).toBe(true)
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "runner.invocation_pending", rowId: pending.id, runner: "hapi",
			}))
			await tick.spawnedRuns[0]!.closed
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
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
			expect(triggerCalls).toBe(0)
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "runner.invocation_pending", phase: "umbrella-finalizer", runner: "hapi", rowId: item.id,
			}))
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
			expect(restored.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getItem(item.id)?.extra.externalTerminalHold).toBeUndefined()
			expect(fixture.schedulerEvents.filter((event) => event.type === "runner.availability_restored")).toHaveLength(1)
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({ type: "runner.invocation_pending", rowId: item.id }))
			await new Promise((resolveDone) => setTimeout(resolveDone, 20))
			expect(await readFile(externalEvents, "utf-8")).toBe("probe\nprobe\n")
			expect(existsSync(spawnEvents)).toBe(false)
			expect(fixture.store.listRuns(chain.id)).toHaveLength(0)
			expect(fixture.worktreeCalls).toHaveLength(0)
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
			await writeFile(externalEvents, "")
			const activeCredentials = new Set<string>()
			const credentialIdentity = "external-loss-credential"
			const options = fixture.options({
				runner: controlledLocalRunner(fixture, 10_000),
				runCredentials: {
					mint: () => { activeCredentials.add(credentialIdentity); return { value: credentialIdentity } },
					revoke: (credential) => { activeCredentials.delete(credential.value) },
				},
				attemptKillMs: 100,
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			modelControlledExternalTerminalRun(spawned.spawnedRuns[0]!, binary)
			expect(activeCredentials).toEqual(new Set([credentialIdentity]))
			expect(fixture.store.getItem(item.id)?.attempts).toBe(5)
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "hapi", sessionId: "lost-session", updatedAt: 1_900_602_005 })
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "hapi" })).toBe("lost-session")
			await writeFile(probeState, "69")
			await schedulerTick(options)
			expect(fixture.store.getRunByRunId(spawned.spawnedRuns[0]!.runId)?.extra.externalTerminalLoss).toMatchObject({ terminationPhase: "term" })
			const closed = await spawned.spawnedRuns[0]!.closed
			expect(activeCredentials.size).toBe(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			expect(fixture.store.getItem(item.id)).toMatchObject({ status: "changes_requested", phase: null, attempts: 4 })
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "hapi" })).toBeNull()
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
				runner: controlledLocalRunner(fixture, 10_000),
				runCredentials: {
					mint: ({ runId }) => { activeCredentials.add(runId); return { value: runId } },
					revoke: (credential) => { activeCredentials.delete(credential.value); revokedCredentials.push(credential.value) },
				},
				attemptKillMs: 100,
			})

			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(2)
			for (const run of spawned.spawnedRuns) modelControlledExternalTerminalRun(run, binary)
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
			expect(fixture.store.getItemSessionId(first.id, { phase: "iteration", runner: "hapi" })).toBeNull()
			expect(fixture.store.getItemSessionId(second.id, { phase: "iteration", runner: "hapi" })).toBeNull()
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
				runner: { kind: "claude", source: "iteration-default", binary, extraArgs: [], model: null },
				chainCompleteExecution: { kind: "scheduler-managed" },
				runCredentials: {
					mint: ({ runId }) => { const value = `credential-${runId}`; activeCredentials.add(value); return { value } },
					revoke: (credential) => { activeCredentials.delete(credential.value) },
				},
				attemptKillMs: 100,
			})

			const started = await schedulerTick(options)
			expect(started.spawnedRuns).toHaveLength(1)
			modelControlledExternalTerminalRun(started.spawnedRuns[0]!, binary)
			expect(started.spawnedRuns[0]?.phase).toBe("umbrella-finalizer")
			fixture.store.setItemSessionId(item.id, { phase: "umbrella-finalizer", runner: "hapi", sessionId: "chain-complete-session", updatedAt: 1_900_602_016 })
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
			expect(fixture.store.getItemSessionId(item.id, { phase: "umbrella-finalizer", runner: "hapi" })).toBeNull()

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
			await writeFile(externalEvents, "")
			const options = fixture.options({
				runner: controlledLocalRunner(fixture, 10_000),
			})
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(1)
			modelControlledExternalTerminalRun(spawned.spawnedRuns[0]!, binary)
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
				runner: controlledLocalRunner(fixture, 10_000),
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
			modelControlledExternalTerminalRun(spawned.spawnedRuns[0]!, binary)
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
				runner: controlledLocalRunner(fixture, 10_000),
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
			modelControlledExternalTerminalRun(spawned.spawnedRuns[0]!, binary)
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
			const first = createItem(fixture.store, firstChain, { issueNumber: 602_010, repoCwd: "/repo/a", sleepMs: 10_000 })
			const second = createItem(fixture.store, secondChain, { issueNumber: 602_011, repoCwd: "/repo/b", sleepMs: 10_000 })
			const options = fixture.options({ runner: controlledLocalRunner(fixture, 10_000), attemptKillMs: 100 })
			const spawned = await schedulerTick(options)
			expect(spawned.spawnedRuns).toHaveLength(2)
			for (const run of spawned.spawnedRuns) modelControlledExternalTerminalRun(run, binary)
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
			await expect(runPresetChainCompleteTriggerPhases(input)).resolves.toEqual({
				decision: "keep-active",
				reason: "runner hapi invocation pending: invocation-pending",
			})
			expect(existsSync(invocationLog)).toBe(false)
			expect(existsSync(outputPath)).toBe(false)
		} finally {
			await stopFixture(fixture)
		}
	})
})
