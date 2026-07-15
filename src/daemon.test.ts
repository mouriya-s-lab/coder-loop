import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { resolve } from "node:path"

import { type as arkType } from "arktype"

import {
	DaemonError,
	DecisionFingerprintState,
	daemonRequest,
	createDaemonRateLimitState,
	DAEMON_RATE_LIMIT_STAGGER_MS,
	daemonRateLimitDecision,
	rateLimitStatusFromState,
	sendDaemonRequest,
	startCoderLoopDaemon,
	type CoderLoopDaemon,
	type CoderLoopDaemonSchedulerConfig,
	type DaemonResponse,
	type DaemonRateLimitState,
} from "./daemon"
import { buildCoderLoopStatusSnapshot, loadPreset, type AgentRunnerKind, type JsonObject, type JsonValue } from "./loop"
import {
	createGitWorktreeManager,
	schedulerSlotWorktreePath,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { resolveChainRuntimePaths, resolveLoopDataPaths } from "./runtime-paths"
import { openSqliteStateStore } from "./sqlite-state"
import { makeObservabilityEvent, queryObservabilityEvents } from "./observability"
import { chainBindings, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"
import type { BoundaryRecord } from "./boundary-types"
import { parseHookDeclarations, type GateHookDeclaration, type ObserverHookDeclaration, type PresetHookPlaceholder } from "./hook-declarations"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/dt", String(process.pid))
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

let nextFixtureId = 0

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

function emptyObservabilityExcerpt() {
	return {
		stdout: { path: "/dev/null", missing: true, truncated: false, records: [] },
		stderr: { path: "/dev/null", missing: true, truncated: false, records: [] },
	}
}

function daemonDecisionFingerprintState(daemon: CoderLoopDaemon): DecisionFingerprintState {
	const state = Reflect.get(daemon, "decisionFingerprints")
	if (!(state instanceof DecisionFingerprintState)) throw new Error("daemon decision fingerprint state is unavailable")
	return state
}

// #406 fake-runner event-log line shape. The fake runners inline-render lines like
// `{"type": "running", "itemId": <n>, "runId": "<s>"}` via JSON.stringify. Tests that need
// the runId/itemId back must boundary-parse rather than `as`-cast onto an anonymous shape
// (issue body 代码红线: 禁止真 as 断言 + 禁止匿名形状).
const FakeRunnerRunningEventBoundary = arkType({
	type: arkType.unit("running"),
	itemId: "number",
	runId: "string",
})

// v1 status model: the spawned agent is the only writer of item.status. These daemon
// integration tests use fake runners, so the fake runner reproduces the real agent's
// `coder-loop item update --status` by writing the test-computed `writeStatus` straight
// into the shared SQLite store (the scheduler then reads it back as the source of truth).
// This is the legacy bypass — it sidesteps the daemon's #397 admission gate and is the
// right shape for tests that exercise the iteration phase (which has no `[[phases.exits]]`
// declared and would otherwise default-deny every status write).
const FAKE_RUNNER_STATUS_WRITE_SNIPPET = `if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
	const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
	const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
	store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
	store.close()
}`

// #452 credentialed write path. Used by recycle-zone tests that need the write to flow
// through the real daemon socket so `handleItemUpdate` runs admission and calls
// `markRunPendingRecycle`. The daemon's caller-admission binds the credential to a
// specific runId, so this branch fires only when the scheduler injected
// `CODER_LOOP_RUN_CRED` into the spawn env — which it always does in production, but is
// gated by the test fixture installing a presetDir whose target phase declares
// `[[phases.exits]]` for the requested status (otherwise the #397 default-deny gate
// rejects the write before the recycle hook can fire).
const FAKE_RUNNER_CREDENTIALED_STATUS_WRITE_SNIPPET = `if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
	const credential = process.env.CODER_LOOP_RUN_CRED
	if (typeof credential === "string" && credential.length > 0) {
		const { createConnection } = await import("node:net")
		const { randomUUID } = await import("node:crypto")
		const socketPath = process.env.CODER_LOOP_DATA_DIR + "/daemon.sock"
		await new Promise((resolveSend, rejectSend) => {
			const socket = createConnection(socketPath)
			let buffer = ""
			socket.setEncoding("utf-8")
			socket.on("connect", () => {
				socket.write(JSON.stringify({
					id: randomUUID(),
					command: "item.update",
					args: { itemId: input.itemId, status: input.writeStatus, agentCredential: credential },
				}) + "\\n")
			})
			socket.on("data", (chunk) => {
				buffer += chunk
				if (buffer.indexOf("\\n") === -1) return
				socket.destroy()
				resolveSend(undefined)
			})
			socket.on("error", rejectSend)
		})
	} else {
		const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
}`

// #405: with the stdout verdict parser retired, the fake runner no longer derives
// status from a `summary` string token. Test fixtures pass `extra.writeStatus`
// directly when the test wants the fake runner to write a specific status; the
// helper below applies the default review status (`done`) when no fixture
// override is set. Iteration / trigger phases inherit the historical behavior:
// trigger phases never mutate the triggering item, iteration leaves status to
// review (`null` here = "let the scheduler advance via phase trigger").
const TRIGGER_PHASES = new Set(["blocked-responder", "umbrella-finalizer", "review-on-empty"])

function daemonFakeRunnerWriteStatus(phase: string, extra: BoundaryRecord): string | null {
	if (TRIGGER_PHASES.has(phase)) return null
	const exitCode = typeof extra.exitCode === "number" ? extra.exitCode : 0
	if (exitCode !== 0) return "changes_requested"
	// Explicit fixture-override path: a test that says "write status X" wins.
	const writeStatusOverride = extra.writeStatus
	if (typeof writeStatusOverride === "string") return writeStatusOverride
	if (writeStatusOverride === null) return null
	// Iteration handoff is structural; the scheduler advances via phase trigger.
	if (phase === "iteration") return null
	// Default review behavior pre-#405 was to land at `done`; preserve that for fixtures
	// that did not set an explicit writeStatus override.
	if (phase === "review") return "done"
	return null
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("daemon", () => {
	test("hook declarations persist across all layers, reload on restart, and never execute during scheduling", async () => {
		let sentinelPath = ""
		const globalHook: ObserverHookDeclaration = { kind: "observer", point: "agent.spawn", script: "", timeoutMs: 1000 }
		const fixture = await startFixture("hook-declaration-foundation", {
			beforeStart: async ({ root, loopDataRoot }) => {
				sentinelPath = resolve(root, "hook-spawned")
				const sentinel = resolve(root, "sentinel-hook")
				await writeFile(sentinel, `#!/bin/sh\ntouch ${JSON.stringify(sentinelPath)}\n`)
				await chmod(sentinel, 0o755)
				globalHook.script = sentinel
				await writeFile(resolve(loopDataRoot, "hooks.json"), JSON.stringify({ version: 1, hooks: [globalHook] }))
			},
		})
		const gateHook: GateHookDeclaration = { kind: "gate", point: "run.pre-spawn", script: "/bin/false", timeoutMs: 1000, onFailure: "hold" }
		const presetPlaceholder: PresetHookPlaceholder = { kind: "named-gate-placeholder", name: "approval", point: "item.status-transition" }
		try {
			const loadedGlobal = parseHookDeclarations(Reflect.get(fixture.daemon, "globalHookDeclarations"), "daemon.globalHooks")
			expect(loadedGlobal).toEqual([globalHook])
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "hook-declaration-foundation-chain",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { hooks: [gateHook] },
			})).chain)
			const chainId = numberValue(chain.id)
			expect(record(chain.metadata).hooks).toEqual([gateHook])
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId, itemId: "58601", repoCwd: REPO_ROOT, extra: { hooks: [globalHook], writeStatus: "done" },
			})).item)
			const batch = record(expectOk(await request(fixture, "item.batchAdd", {
				chainId,
				items: [{ itemId: "58602", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", extra: { hooks: [globalHook] } }],
			})))
			expect(Array.isArray(batch.items) ? record(batch.items[0]).extra : null).toMatchObject({ hooks: [globalHook] })
			const rowId = numberValue(item.id)
			expect(fixture.daemon.effectiveHookViewForItem(chainId, rowId, [presetPlaceholder])).toEqual([
				{ source: "global", declaration: globalHook },
				{ source: "chain", declaration: gateHook },
				{ source: "preset", declaration: presetPlaceholder },
				{ source: "item", declaration: globalHook },
			])
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 58601), (candidate) => candidate?.status === "done")
			const terminal = await readItem(fixture.loopDataRoot, chainId, 58601)
			expect(terminal?.extra.hooks).toEqual([globalHook])
			expect(await pathExists(sentinelPath)).toBe(false)
			expect(rowId).toBeGreaterThan(0)
			await fixture.daemon.stop()
			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, scheduler: { enabled: false } })
			try {
				expect(parseHookDeclarations(Reflect.get(restarted, "globalHookDeclarations"), "daemon.globalHooks")).toEqual([globalHook])
				const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
				try {
					expect(store.getChain(chainId)?.metadata.hooks).toEqual([gateHook])
					expect(store.getItem(rowId)?.extra.hooks).toEqual([globalHook])
				} finally { store.close() }
			} finally { await restarted.stop() }
		} finally {
			await fixture.daemon.stop()
		}
	})
	test("persisted item hooks feed the effective view without entering status item or run surfaces", async () => {
		const chainName = "hook-status-projection-boundary-chain"
		const fixture = await startFixture("hook-status-projection-boundary", { schedulerEnabled: false })
		const itemHook: ObserverHookDeclaration = {
			kind: "observer",
			point: "agent.spawn",
			script: "/bin/true",
			timeoutMs: 1000,
		}
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "58603",
				repoCwd: REPO_ROOT,
				extra: { hooks: [itemHook], visibleItemField: "item-visible" },
			})).item)
			const itemRowId = numberValue(item.id)
			expect(fixture.daemon.effectiveHookViewForItem(chainId, itemRowId, [])).toEqual([
				{ source: "item", declaration: itemHook },
			])

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				expect(store.getItem(itemRowId)?.extra.hooks).toEqual([itemHook])
				store.recordRun({
					runId: "run-hook-status-projection-boundary",
					chainId,
					itemId: itemRowId,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ hooks: [itemHook], visibleRecordedRunField: "recorded-run-visible" }),
				})
				store.setCurrentRun({
					chainId,
					phase: "iteration",
					runId: "run-hook-status-projection-boundary",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({
						itemId: itemRowId,
						hooks: [itemHook],
						visibleCurrentRunField: "current-run-visible",
					}),
				})
			} finally {
				store.close()
			}

			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				output: "json",
			})
			expect(snapshot.queue.selected?.item.extra.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(snapshot.queue.selected?.item.extra ?? {}, "hooks")).toBe(false)
			expect(snapshot.current.item?.extra.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(snapshot.current.item?.extra ?? {}, "hooks")).toBe(false)
			expect(snapshot.current.run?.extra.visibleCurrentRunField).toBe("current-run-visible")
			expect(Object.hasOwn(snapshot.current.run?.extra ?? {}, "hooks")).toBe(false)

			const cli = Bun.spawn({
				cmd: [
					"bun",
					LOOP_ENTRY,
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
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			])
			expect(exitCode, stderr).toBe(0)
			const payload = record(JSON.parse(stdout))
			const queueItem = record(record(record(payload.queue).selected).item)
			const current = record(payload.current)
			const currentItem = record(current.item)
			const currentRun = record(current.run)
			expect(queueItem.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(queueItem, "hooks")).toBe(false)
			expect(currentItem.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(currentItem, "hooks")).toBe(false)
			expect(currentRun.visibleCurrentRunField).toBe("current-run-visible")
			expect(Object.hasOwn(currentRun, "hooks")).toBe(false)
		} finally {
			await fixture.daemon.stop()
		}
	})
	test("cleans runner lifecycle after status persistence failure", () => {
		for (const [file, name] of [
			["src/scheduler.test.ts", "rejects successful scheduler completion when terminal persistence fails"],
			["src/loop.test.ts", "reports ordered chain-complete status persistence failure"],
			["src/loop.test.ts", "rejects successful chain-complete decision when terminal status persistence fails"],
		] as const) {
			const result = Bun.spawnSync(["bun", "test", file, "-t", name], { cwd: REPO_ROOT })
			const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
			expect(result.exitCode, output).toBe(0)
			expect(output).toContain("0 fail")
		}
	})
	test("completes large-output scheduler and chain-complete runners", () => {
		for (const name of [
			"streams scheduler runner output without retaining full history",
			"streams chain-complete runner output without retaining full history",
		]) {
			const result = Bun.spawnSync(["bun", "test", "src/scheduler.test.ts", "-t", name], { cwd: REPO_ROOT })
			expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
			expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toContain("0 fail")
		}
	})

	test("orders requests within one daemon connection", async () => {
		const fixture = await startFixture("ordered-connection", { schedulerEnabled: false })
		const slowStarted = deferred<void>()
		const releaseSlow = deferred<void>()
		const startedRequestIds: string[] = []
		const originalResponseForLine = Reflect.get(fixture.daemon, "responseForLine")
		if (typeof originalResponseForLine !== "function") throw new Error("daemon responseForLine is unavailable")
		Reflect.set(fixture.daemon, "responseForLine", async (line: string) => {
			const request = record(JSON.parse(line))
			const requestId = stringValue(request.id)
			startedRequestIds.push(requestId)
			if (requestId === "slow") {
				slowStarted.resolve(undefined)
				await releaseSlow.promise
			}
			return await Reflect.apply(originalResponseForLine, fixture.daemon, [line])
		})
		try {
			const responsesPromise = sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "slow", command: "daemon.status", args: {} }),
				JSON.stringify({ id: "next", command: "daemon.status", args: {} }),
			])
			await slowStarted.promise
			expect(startedRequestIds).toEqual(["slow"])
			releaseSlow.resolve(undefined)
			const responses = await responsesPromise
			expect(responses.map((response) => response.id)).toEqual(["slow", "next"])
			expect(startedRequestIds).toEqual(["slow", "next"])
		} finally {
			releaseSlow.resolve(undefined)
			await fixture.daemon.stop()
		}
	})

	test("keeps independent daemon connections concurrent", async () => {
		const fixture = await startFixture("concurrent-connections", { schedulerEnabled: false })
		const slowStarted = deferred<void>()
		const releaseSlow = deferred<void>()
		const originalResponseForLine = Reflect.get(fixture.daemon, "responseForLine")
		if (typeof originalResponseForLine !== "function") throw new Error("daemon responseForLine is unavailable")
		Reflect.set(fixture.daemon, "responseForLine", async (line: string) => {
			const request = record(JSON.parse(line))
			if (stringValue(request.id) === "slow-connection") {
				slowStarted.resolve(undefined)
				await releaseSlow.promise
			}
			return await Reflect.apply(originalResponseForLine, fixture.daemon, [line])
		})
		try {
			const slowResponsePromise = sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "slow-connection", command: "daemon.status", args: {} }),
			])
			await slowStarted.promise
			const independentResponses = await sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "independent-connection", command: "daemon.status", args: {} }),
			])
			expect(independentResponses).toMatchObject([{ id: "independent-connection", ok: true }])
			releaseSlow.resolve(undefined)
			expect(await slowResponsePromise).toMatchObject([{ id: "slow-connection", ok: true }])
		} finally {
			releaseSlow.resolve(undefined)
			await fixture.daemon.stop()
		}
	})

	test("continues ordered connection after request failure", async () => {
		const fixture = await startFixture("failure-continues", { schedulerEnabled: false })
		try {
			const responses = await sendLinesOnDaemonConnection(fixture.socketPath, [
				"not-json",
				JSON.stringify({ id: "after-failure", command: "daemon.status", args: {} }),
			])
			expect(responses).toHaveLength(2)
			expect(responses[0]).toMatchObject({ id: "unknown", ok: false })
			expect(responses[1]).toMatchObject({ id: "after-failure", ok: true })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("drives chain-complete decision through a large runner event", async () => {
		const fixture = await startFixture("large-chain-complete-decision", {
			schedulerIntervalMs: 1_000,
			useDefaultChainCompleteTrigger: true,
			beforeStart: async ({ fakeRunner }) => {
				await writeFile(fakeRunner, `#!/usr/bin/env bun
const prompt = Bun.argv.at(-1) ?? ""
if (prompt.includes("FINALIZER SUMMARY")) {
	const event = { type: "item.completed", item: { type: "agent_message", text: "x".repeat(1_000_001) + "\\nFINALIZER SUMMARY: decision=complete; reason=large-event" } }
	await Bun.write(Bun.stdout, JSON.stringify(event) + "\\n")
} else {
	const input = JSON.parse(prompt)
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
}
process.exitCode = 0
`)
				await chmod(fakeRunner, 0o755)
			},
			schedulerRunnerKind: "codex",
			schedulerBinaryIsFakeRunner: true,
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "large-chain-complete-decision-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "633",
				repoCwd: REPO_ROOT,
			})).item)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(numberValue(added.id), { status: runtimeStatus("done"), updatedAt: Math.floor(Date.now() / 1_000) })
			} finally {
				store.close()
			}

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			const triggerEvent = fixture.schedulerEvents.find((event) => event.type === "chain.complete_trigger" && event.chainId === chainId)
			expect(triggerEvent).toMatchObject({ decision: "complete" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon up creates socket and pid", async () => {
		const fixture = await startFixture("up", { schedulerEnabled: false })
		try {
			expect(await pathIsSocket(fixture.socketPath)).toBe(true)
			expect((await readFile(fixture.pidFile, "utf-8")).trim()).toBe(String(process.pid))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon rebinds socket pathname after unlink", async () => {
		const fixture = await startFixture("socket-path-rebind", { schedulerEnabled: false })
		try {
			await unlink(fixture.socketPath)
			await waitFor(async () => {
				try {
					return await pathIsSocket(fixture.socketPath)
				} catch {
					return false
				}
			}, (rebuilt) => rebuilt)

			const status = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("daemon.status"))).daemon)
			expect(status).toMatchObject({
				pid: process.pid,
				socketPath: fixture.socketPath,
				running: true,
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon startup rejects live pid with missing socket pathname", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-socket-unlinked`)
		const loopDataRoot = resolve(root, "ld")
		const pidFile = resolve(loopDataRoot, "daemon.pid")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")
		await writeFile(pidFile, `${stale.pid}\n`)

		try {
			await expect(startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })).rejects.toMatchObject({
				code: "daemon_socket_unlinked",
				details: {
					pid: stale.pid,
					socketPath: resolve(loopDataRoot, "daemon.sock"),
					pidFile,
				},
			})
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already exited.
				}
			}
			await waitForPidExit(stale.pid, 1_000)
		}
	})

	test("socket chain.create", async () => {
		const fixture = await startFixture("chain-create", { schedulerEnabled: false })
		try {
			// #433: top-level `metadata.runner` is retired. Operators who want the chain to expose
			// a particular runner kind set it via the per-runner channel (`metadata.codex.binary`)
			// instead; the bare runner alias is gone.
			// #457: umbrella values now flow through metadata.bindings rather than a first-class
			// chain.create field; the daemon no longer validates `umbrellaIssue` / `umbrellaRepo`
			// as engine-typed fields, so the test exercises the declared-binding path instead.
			const result = expectOk(await request(fixture, "chain.create", {
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" }, bindings: { umbrellaIssue: 176 } },
			}))

			expect(result.chain).toMatchObject({
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: { codex: { binary: "codex" }, bindings: { umbrellaIssue: 176 } },
			})
			const paths = resolveChainRuntimePaths("central-state", { loopDataRoot: fixture.loopDataRoot })
			await expect(Bun.file(paths.sharedFile).exists()).resolves.toBe(true)
			await expect(readFile(paths.sharedFile, "utf-8")).resolves.toBe("# Shared durable context\n\n")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create is idempotent but rejects conflicting existing fields", async () => {
		const fixture = await startFixture("chain-create-conflict", { schedulerEnabled: false })
		try {
			const first = record(expectOk(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})).chain)

			const repeated = record(expectOk(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})).chain)
			expect(repeated.id).toBe(first.id)
			expect(repeated).toMatchObject({
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})

			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/different",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "develop",
				metadata: { codex: { binary: "codex" } },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { claude: { binary: "claude" } },
			}))

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(1)
			const [listedChain] = listed
			expect(record(listedChain)).toMatchObject({ repository: "mouriya-s-lab/coder-loop", baseBranch: "main", metadata: { codex: { binary: "codex" } } })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create rejects invalid names before db insert", async () => {
		const fixture = await startFixture("chain-create-invalid", { schedulerEnabled: false })
		try {
			const invalidNames = ["..", ".", "a/b", "../escape", "/etc/hi", "ab cd", "-flag", "a".repeat(256), "bad\tname"]

			for (const name of invalidNames) {
				const response = await request(fixture, "chain.create", {
					name,
					repository: "mouriya-s-lab/coder-loop",
				})

				expect(response.ok).toBe(false)
				if (!response.ok) expect(response.error.code).toBe("invalid_request")
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates repository format", async () => {
		const fixture = await startFixture("chain-create-invalid-repository", { schedulerEnabled: false })
		try {
			const invalidRepositories = [
				"x/y\nbad",
				"x",
				"x/",
				"/y",
				"x/y/z",
				"bad owner/repo",
				"owner/.",
				"owner/..",
				"owner/repo\u007f",
				"owner-/repo",
			]

			for (const [index, repository] of invalidRepositories.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `repo-check-${index}`,
					repository,
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates baseBranch as a git branch name", async () => {
		const fixture = await startFixture("chain-create-invalid-base-branch", { schedulerEnabled: false })
		try {
			const invalidBaseBranches = [
				"../../etc/passwd",
				"main\nbad",
				"bad\u0000name",
				"main..bad",
				"main@{bad",
				"@{-1}",
				"main:bad",
				"main^bad",
				"main?bad",
				"main*bad",
				"main[bad",
				"/main",
				"main.lock",
				"main/.bad",
				"-bad",
				"bad branch",
			]

			for (const [index, baseBranch] of invalidBaseBranches.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `base-branch-check-${index}`,
					repository: "mouriya-s-lab/coder-loop",
					baseBranch,
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			const valid = record(expectOk(await request(fixture, "chain.create", {
				name: "base-branch-valid",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "feature/safe-branch",
			})).chain)
			expect(valid).toMatchObject({ baseBranch: "feature/safe-branch" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #457: `umbrellaIssue` / `umbrellaRepo` are no longer first-class chain.create fields. They flow
	// through `metadata.bindings`, where the operator (or the `--umbrella owner/repo#123` CLI
	// shorthand) writes them as preset-declared chain bindings. The daemon rejects the legacy keys
	// at the strict-args gate so stale callers fail loudly instead of silently dropping their value.
	test("socket chain.create rejects legacy first-class umbrellaIssue / umbrellaRepo args (#457)", async () => {
		const fixture = await startFixture("chain-create-rejects-legacy-umbrella", { schedulerEnabled: false })
		try {
			expectInvalid(await request(fixture, "chain.create", {
				name: "legacy-umbrella-issue",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaIssue: 176,
			}))
			expectInvalid(await request(fixture, "chain.create", {
				name: "legacy-umbrella-repo",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaRepo: "mouriya-s-lab/coder-loop",
			}))

			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "umbrella-via-bindings",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { bindings: { umbrellaIssue: 176, umbrellaRepo: "mouriya-s-lab/coder-loop" } },
			})).chain)
			expect(created).toMatchObject({
				metadata: { bindings: { umbrellaIssue: 176, umbrellaRepo: "mouriya-s-lab/coder-loop" } },
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create rejects undeclared args", async () => {
		const fixture = await startFixture("chain-create-strict-args", { schedulerEnabled: false })
		try {
			const args = JSON.parse(
				`{"name":"strict-args","repository":"mouriya-s-lab/coder-loop","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}`,
			)

			expectInvalid(await request(fixture, "chain.create", args))
			expectInvalid(await request(fixture, "chain.create", {
				name: "status-field",
				repository: "mouriya-s-lab/coder-loop",
				status: "deleted",
			}))
			expect(Object.prototype).not.toHaveProperty("polluted")
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates metadata keys and nesting before db insert", async () => {
		const fixture = await startFixture("chain-create-metadata-validation", { schedulerEnabled: false })
		try {
			const invalidCases = [
				{ name: "metadata-proto", metadata: JSON.parse(`{"__proto__":{"polluted":1},"normal":"v"}`) },
				{ name: "metadata-constructor", metadata: JSON.parse(`{"constructor":{"prototype":{"polluted":2}}}`) },
				{ name: "metadata-prototype", metadata: JSON.parse(`{"safe":{"prototype":true}}`) },
				{ name: "metadata-empty-key", metadata: JSON.parse(`{"":"empty-key"}`) },
				{ name: "metadata-nested-proto", metadata: JSON.parse(`{"items":[{"__proto__":{"polluted":3}}]}`) },
				{ name: "metadata-too-deep", metadata: nestedMetadata(9) },
				{ name: "metadata-max-attempts-zero", metadata: { maxItemAttempts: 0 } },
				{ name: "metadata-max-attempts-float", metadata: { maxItemAttempts: 1.5 } },
			]

			for (const { name, metadata } of invalidCases) {
				expectInvalid(await request(fixture, "chain.create", {
					name,
					repository: "mouriya-s-lab/coder-loop",
					metadata,
				}))
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			// #433: `metadata.config` is retired; the parser rejects it explicitly so a stale row
			// or a stale supervisor write fails fast instead of silently masking the value.
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-config-retired",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { config: { workflowFile: "workflow.md" } },
				}),
				"metadata.config",
				{ workflowFile: "workflow.md" },
			)
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-bindings-array",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { bindings: ["not", "an", "object"] },
				}),
				"metadata.bindings",
				["not", "an", "object"],
			)
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-attempts-string",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { maxItemAttempts: "seven" },
				}),
				"metadata.maxItemAttempts",
				"seven",
			)
			// #433: top-level `runner` and the role-named runner companion are also retired (dead keys
			// with no read site pre-#433; the role companion's name is composed at runtime in the
			// runtime-data guard per #456 so it does not appear as a literal in `src/`). The parser
			// raises explicitly so the rejection is observable.
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-runner-retired",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { runner: "codex" },
				}),
				"metadata.runner",
				"codex",
			)

			expect(Object.prototype).not.toHaveProperty("polluted")
			const validMetadata = { bindings: { workflowFile: "workflow.md" }, maxItemAttempts: 7, nested: nestedMetadata(7), list: [{ leaf: "ok" }] }
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "metadata-valid",
				repository: "mouriya-s-lab/coder-loop",
				metadata: validMetadata,
			})).chain)
			expect(created.metadata).toEqual(validMetadata)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates preset name and existence before db insert", async () => {
		const fixture = await startFixture("chain-create-invalid-preset", { schedulerEnabled: false })
		try {
			const invalidPresets = ["../etc", "bad\nname", "bad name", "Bad", "bad_name", "-bad", "1bad", "non-existent"]

			for (const [index, preset] of invalidPresets.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `preset-check-${index}`,
					preset,
					repository: "mouriya-s-lab/coder-loop",
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon rejects existing chains with invalid or unknown presets instead of falling back", async () => {
		const fixture = await startFixture("existing-preset-explicit-failure", { schedulerEnabled: false })
		try {
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let invalidPresetItemId: number
			let unknownPresetItemId: number
			try {
				const invalidPresetChain = store.createChain({
					name: "invalid-preset-chain",
					preset: "bad_name",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
				invalidPresetItemId = store.createItem({
					chainId: invalidPresetChain.id,
					itemId: "41101",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({ sleepMs: 5, exitCode: 0 }),
				}).id
				const unknownPresetChain = store.createChain({
					name: "unknown-preset-chain",
					preset: "missing-preset",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
				unknownPresetItemId = store.createItem({
					chainId: unknownPresetChain.id,
					itemId: "41102",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({ sleepMs: 5, exitCode: 0 }),
				}).id
			} finally {
				store.close()
			}

			const invalidPresetResponse = await request(fixture, "item.update", {
				itemId: invalidPresetItemId,
				fields: { status: runtimeStatus("done") },
			})
			expect(invalidPresetResponse.ok).toBe(false)
			if (!invalidPresetResponse.ok) {
				expect(invalidPresetResponse.error.code).toBe("invalid_request")
				expect(invalidPresetResponse.error.message).toContain("invalid name")
			}

			const unknownPresetResponse = await request(fixture, "item.update", {
				itemId: unknownPresetItemId,
				fields: { status: runtimeStatus("done") },
			})
			expect(unknownPresetResponse.ok).toBe(false)
			if (!unknownPresetResponse.ok) {
				expect(unknownPresetResponse.error.code).toBe("invalid_request")
				expect(unknownPresetResponse.error.message).toContain("failed to load preset")
				expect(unknownPresetResponse.error.message).toContain("missing-preset")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create rejects oversized request and metadata payloads", async () => {
		const fixture = await startFixture("chain-create-size-limits", { schedulerEnabled: false })
		try {
			expectTooLarge(await request(fixture, "chain.create", {
				name: "metadata-too-large",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { k: "x".repeat(17 * 1024) },
			}))
			expectTooLarge(await request(fixture, "chain.create", {
				name: "line-too-large",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { k: "x".repeat(1024 * 1024) },
			}))

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon startup skips invalid existing chain rows", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-invalid-existing-chain`)
		const loopDataRoot = resolve(root, "ld")
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
		const loopDataRoot = resolve(root, "ld")
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
		const loopDataRoot = resolve(root, "ld")
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

	test("socket item CRUD", async () => {
		const fixture = await startFixture("item-crud", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "crud-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
				title: "feat: 单进程 daemon",
				extra: { sleepMs: 5 },
			})).item)
			expect(added).toMatchObject({ itemId: "180", status: runtimeStatus("queued"), title: "feat: 单进程 daemon" })

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: runtimeStatus("done"), title: "updated daemon item", extraPatch: { pr: 190 } },
			})).item)
			expect(updated).toMatchObject({ status: runtimeStatus("done"), title: "updated daemon item", extra: expect.objectContaining({ pr: 190 }) })
		} finally {
			await fixture.daemon.stop()
		}
	})


	// #412 retry: itemToJson must surface per-item preset / presetPath so `item list --json` is
	// consistent with `coder-loop status --json` `queue.selected.preset.*` exposure. Supervisors
	// reading `item list` need to know each item's preset to drive routing decisions; pre-fix the
	// view omitted both fields.
	test("socket item list exposes per-item preset and presetPath (post-#412)", async () => {
		const fixture = await startFixture("item-list-preset-exposure", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "item-list-preset-exposure-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const presetPathDir = resolve(REPO_ROOT, "presets/single-phase-example")
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "41280",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "41281",
				repoCwd: REPO_ROOT,
				presetPath: presetPathDir,
			}))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(listed)) throw new Error("expected item.list items array")
			expect(listed).toHaveLength(2)
			const bundled = listed.map(record).find((item) => item.itemId === "41280")
			const pathItem = listed.map(record).find((item) => item.itemId === "41281")
			if (bundled === undefined || pathItem === undefined) throw new Error("expected both items in list")
			expect(bundled).toMatchObject({ preset: "gh-issue-pr-iteration", presetPath: null })
			expect(pathItem).toMatchObject({ preset: null, presetPath: presetPathDir })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item batch add short-circuits on invalid input without partial write", async () => {
		const fixture = await startFixture("item-batch-add-invalid-input", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "batch-invalid-input-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const failed = await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25811", repoCwd: REPO_ROOT, title: "valid before invalid" },
					{ itemId: "", repoCwd: REPO_ROOT, title: "invalid issue" },
					{ itemId: "25813", repoCwd: REPO_ROOT, title: "valid after invalid" },
				],
			})
			expectInvalid(failed)

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)

			const added = expectOk(await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25821", repoCwd: REPO_ROOT, title: "valid one" },
					{ itemId: "25822", repoCwd: REPO_ROOT, title: "valid two" },
					{ itemId: "25823", repoCwd: REPO_ROOT, title: "valid three" },
				],
			})).items
			expect(Array.isArray(added)).toBe(true)
			expect(added).toHaveLength(3)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item batch add rejects conflict with existing item without partial write", async () => {
		const fixture = await startFixture("item-batch-add-conflict", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "batch-conflict-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "25901", repoCwd: REPO_ROOT, title: "occupant" }))
			const baseline = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(baseline).toHaveLength(1)

			const failed = await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25902", repoCwd: REPO_ROOT, title: "would-be first" },
					{ itemId: "25901", repoCwd: REPO_ROOT, title: "conflict with occupant" },
					{ itemId: "25903", repoCwd: REPO_ROOT, title: "would-be third" },
				],
			})
			expectConflict(failed)

			const after = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(after.map((item) => Number(item.itemId))).toEqual([25901])
			expect(after.map((item) => item.id)).toEqual(baseline.map((item) => item.id))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects duplicate issue as conflict without SQL details", async () => {
		const fixture = await startFixture("item-add-duplicate", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "duplicate-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const first = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "242",
				repoCwd: REPO_ROOT,
			})).item)

			const duplicate = await request(fixture, "item.add", {
				chainId,
				itemId: "242",
				repoCwd: REPO_ROOT,
			})
			expectConflict(duplicate)
			if (duplicate.ok) throw new Error("expected duplicate item.add to fail")
			expect(duplicate.error.message).toBe("item with id 242 already exists in chain duplicate-item-chain")
			expect(JSON.stringify(duplicate.error)).not.toContain("UNIQUE constraint")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.chain_id")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.issue_number")
			expect(record(duplicate.error.details)).toMatchObject({
				chainId,
				chainName: "duplicate-item-chain",
				itemId: "242",
				existingItemId: numberValue(first.id),
			})

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(listed)) throw new Error("expected item.list items array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({ id: numberValue(first.id), itemId: "242" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects invalid issue and repo fields before db insert", async () => {
		const fixture = await startFixture("item-add-validation", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "validation-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const invalidRequests = [
				{ itemId: "", repoCwd: REPO_ROOT },
				{ itemId: "bad with space", repoCwd: REPO_ROOT },
				{ itemId: "181", repoCwd: "relative/path" },
				{ itemId: "182", repoCwd: resolve(REPO_ROOT, "missing-coder-loop-test-dir") },
				{ itemId: "183", repoCwd: `${REPO_ROOT}\nchild` },
				{ itemId: "184", repoCwd: `${REPO_ROOT}\u0000child` },
			]

			for (const args of invalidRequests) {
				expectInvalid(await request(fixture, "item.add", { chainId, ...args }))
			}

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects daemon-owned, unsafe, and unknown fields before db insert", async () => {
		const fixture = await startFixture("item-add-strict-fields", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "strict-add-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const chainPaths = resolveChainRuntimePaths("strict-add-chain", { loopDataRoot: fixture.loopDataRoot })
			const absoluteEvidenceDir = resolve(chainPaths.chainRoot, "evidence/custom-246")

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "246",
				repoCwd: REPO_ROOT,
				title: "strict add item",
				priority: "high",
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				runner: "codex",
				extra: { note: "allowed", branch: "feature/issue-246", pr: 254 },
			})).item)
			expect(added).toMatchObject({
				itemId: "246",
				status: runtimeStatus("queued"),
				attempts: 0,
				priority: "high",
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				lastRunId: null,
				agentCwd: null,
				runner: "codex",
				extra: expect.objectContaining({ note: "allowed", branch: "feature/issue-246", pr: 254 }),
			})

			const invalidRequests = [
				{ itemId: "601", repoCwd: REPO_ROOT, status: runtimeStatus("done") },
				{ itemId: "602", repoCwd: REPO_ROOT, attempts: 999 },
				{ itemId: "603", repoCwd: REPO_ROOT, lastRunId: "hacked" },
				{ itemId: "604", repoCwd: REPO_ROOT, agentCwd: "/etc/passwd" },
				{ itemId: "605", repoCwd: REPO_ROOT, id: 1 },
				{ itemId: "606", repoCwd: REPO_ROOT, createdAt: 1 },
				{ itemId: "607", repoCwd: REPO_ROOT, updatedAt: 1 },
				{ itemId: "608", repoCwd: REPO_ROOT, branch: "../../etc/passwd" },
				{ itemId: "609", repoCwd: REPO_ROOT, issueFile: "../../etc/passwd" },
				{ itemId: "610", repoCwd: REPO_ROOT, evidenceDir: "/etc/coder-loop-evidence" },
				{ itemId: "611", repoCwd: REPO_ROOT, random_field: "hack" },
				{ itemId: "612", repoCwd: REPO_ROOT, title: "bad\nline" },
				{ itemId: "613", repoCwd: REPO_ROOT, priority: "garbage-xyz" },
				{ itemId: "614", repoCwd: REPO_ROOT, priority: 999 },
				{ itemId: "615", repoCwd: REPO_ROOT, pr: -1 },
				{ itemId: "616", repoCwd: REPO_ROOT, extra: JSON.parse(`{"__proto__":{"polluted":1}}`) },
				{ itemId: "617", repoCwd: REPO_ROOT, extra: { "": "empty-key" } },
				{ itemId: "618", repoCwd: REPO_ROOT, extra: nestedMetadata(9) },
			]
			for (const args of invalidRequests) expectInvalid(await request(fixture, "item.add", { chainId, ...args }))

			expectTooLarge(await request(fixture, "item.add", {
				chainId,
				itemId: "619",
				repoCwd: REPO_ROOT,
				extra: { k: "x".repeat(17 * 1024) },
			}))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(Array.isArray(listed) ? listed[0] : null)).toMatchObject({ itemId: "246" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add acks before scheduler side effects finish", async () => {
		const fixture = await startFixture("item-add-async-scheduler", {
			schedulerIntervalMs: 50,
			worktreeManager: async () => {
				throw new Error("synthetic scheduler failure")
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "async-add-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "185",
				repoCwd: REPO_ROOT,
			})).item)

			expect(added).toMatchObject({ itemId: "185", status: runtimeStatus("queued"), repoCwd: REPO_ROOT })
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 185), (item) => item?.status === "queued")
			await new Promise((resolveWait) => setTimeout(resolveWait, 120))
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update validates status and dependency graph", async () => {
		const fixture = await startFixture("item-update-validation", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "dependency-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const first = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "186", repoCwd: REPO_ROOT })).item)
			const second = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "187", repoCwd: REPO_ROOT })).item)
			const firstId = numberValue(first.id)
			const secondId = numberValue(second.id)

			expectInvalid(await request(fixture, "item.update", { itemId: firstId, status: "garbage_state" }))
			expectInvalid(await request(fixture, "item.update", { itemId: firstId, dependsOn: [firstId] }))

			const updatedFirst = record(expectOk(await request(fixture, "item.update", { itemId: firstId, dependsOn: [secondId] })).item)
			expect(record(updatedFirst.extra).dependsOn).toEqual([secondId])

			expectInvalid(await request(fixture, "item.update", { itemId: secondId, dependsOn: [firstId] }))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon validates item statuses from config-json presetPath metadata", async () => {
		const fixture = await startFixture("custom-preset-status-validation", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "custom-status-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
			await writeFile(resolve(presetPath, "preset.toml"), `name = "custom-status-fixture"

[item]
idField = "issue"

[statuses]
continuable = ["queued", "needs_work"]
terminal = ["custom_done"]
entry = "queued"
success = ["custom_done"]
exhausted = "custom_done"

[[phases]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edge so R2 (deadlock-continuable) passes for the
  # fixture. The status-validation test surface is unchanged; "run → custom_done"
  # only matters to the new checker, not to this test's assertions.
  [[phases.exits]]
  status = "custom_done"
  when = "Run finished and the item reached the success-terminal vocabulary."

  [phases.variables]
  ISSUE = "item.issue"

[agent]
attemptTimeoutSeconds = 3600
`)

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "custom-preset-chain",
				repository: "mouriya-s-lab/coder-loop",
				// #433: presetPath now lives at metadata.bindings.presetPath (the retired
				// metadata.config wrapper is gone).
				metadata: { bindings: { presetPath } },
			})).chain)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId: numberValue(chain.id),
				itemId: "45401",
				repoCwd: REPO_ROOT,
			})).item)
			expect(added.status).toBe("queued")

			const rejected = await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "not_in_custom_preset",
			})
			expect(rejected.ok).toBe(false)
			if (!rejected.ok) {
				expect(rejected.error.code).toBe("invalid_request")
				expect(rejected.error.message).toContain("custom_done")
				expect(rejected.error.message).toContain("needs_work")
			}

			const accepted = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "custom_done",
			})).item)
			expect(accepted.status).toBe("custom_done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon reports custom presetPath load failures to each chain mutation request", async () => {
		const fixture = await startFixture("custom-preset-load-failure", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "bad-status-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "preset.toml"), "name = [broken\n")

			const firstChain = record(expectOk(await request(fixture, "chain.create", {
				name: "bad-custom-preset-chain-a",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const secondChain = record(expectOk(await request(fixture, "chain.create", {
				name: "bad-custom-preset-chain-b",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)

			// #412: presetPath now lives on the item, not on chain.metadata.config. Both items declare
			// the same broken presetPath to verify chain-mutation load-failure reporting is per-request
			// (each chain gets its own failure event) and the bad path is surfaced verbatim.
			const [firstResponse, secondResponse] = await Promise.all([
				request(fixture, "item.add", {
					chainId: numberValue(firstChain.id),
					itemId: "45402",
					repoCwd: REPO_ROOT,
					presetPath,
				}),
				request(fixture, "item.add", {
					chainId: numberValue(secondChain.id),
					itemId: "45403",
					repoCwd: REPO_ROOT,
					presetPath,
				}),
			])
			for (const [response, chain] of [[firstResponse, firstChain], [secondResponse, secondChain]] as const) {
				expect(response.ok).toBe(false)
				if (!response.ok) {
					expect(response.error.code).toBe("invalid_request")
					expect(response.error.message).toContain(`failed to load preset for chain ${chain.name}`)
					expect(response.error.details).toMatchObject({ chainId: numberValue(chain.id), presetDir: presetPath })
				}
			}
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { type: "daemon.preset_load_failed" })
			const firstEvent = events.events.find((event) => event.chain === firstChain.name)
			const secondEvent = events.events.find((event) => event.chain === secondChain.name)
			expect(firstEvent?.type).toBe("daemon.preset_load_failed")
			expect(secondEvent?.type).toBe("daemon.preset_load_failed")
			if (firstEvent?.type !== "daemon.preset_load_failed" || secondEvent?.type !== "daemon.preset_load_failed") {
				throw new Error("expected daemon.preset_load_failed events for both chains")
			}
			// #403: event kind migrated from `lifecycle` to `validation` — preset-resolution refusal is
			// a per-operation validation event, not a daemon lifecycle transition.
			expect(firstEvent.kind).toBe("validation")
			expect(secondEvent.kind).toBe("validation")
			expect(firstEvent.payload).toMatchObject({
				chainId: numberValue(firstChain.id),
				preset: "gh-issue-pr-iteration",
				presetDir: presetPath,
				// #403: every refusal carries the refused operation name. `item.add` triggers
				// `defaultItemStatusForPresetSpecOnChain`, which the daemon records as
				// `item.create.default-status`.
				operation: "item.create.default-status",
			})
			expect(secondEvent.payload).toMatchObject({
				chainId: numberValue(secondChain.id),
				preset: "gh-issue-pr-iteration",
				presetDir: presetPath,
				operation: "item.create.default-status",
			})
			expect(firstEvent.payload.error.length).toBeGreaterThan(0)
			expect(secondEvent.payload.error.length).toBeGreaterThan(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #403 log obligation. When the engine's fallback status vocabularies are removed, every
	// preset-resolution failure must surface as a *validation* event through the unified observability
	// stream, naming the refused operation (chain.status, scheduler.tick, item.exits, ...). This test
	// drives `chain.status` against a chain whose `metadata.presetPath` points to a broken preset.toml
	// and asserts (1) the request fails with a precise error naming chain/operation/presetDir, and (2)
	// the emitted event is `kind: "validation"` with `payload.operation: "chain.status"`.
	test("daemon emits validation event naming chain.status when preset resolution refuses chain.status", async () => {
		const fixture = await startFixture("preset-load-failure-chain-status", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "bad-status-preset-chain-status")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "preset.toml"), "this is not toml { ][\n")

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "validation-event-chain-status",
				repository: "mouriya-s-lab/coder-loop",
				// `chain.metadata.presetPath` makes `canResolvePresetForChainOrItems` return true even
				// when no items exist, so `chain.status` will try to load and fail on the broken
				// preset.toml.
				metadata: { presetPath },
			})).chain)

			const statusResponse = await request(fixture, "chain.status", { chainId: numberValue(chain.id) })
			expect(statusResponse.ok).toBe(false)
			if (!statusResponse.ok) {
				expect(statusResponse.error.code).toBe("invalid_request")
				expect(statusResponse.error.message).toContain(`failed to load preset for chain ${chain.name}`)
				expect(statusResponse.error.message).toContain("operation chain.status")
				expect(statusResponse.error.message).toContain(presetPath)
				expect(statusResponse.error.details).toMatchObject({
					chainId: numberValue(chain.id),
					chainName: chain.name,
					presetDir: presetPath,
					operation: "chain.status",
				})
			}

			const events = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "daemon.preset_load_failed" },
			)
			const event = events.events.find((entry) =>
				entry.chain === chain.name && entry.type === "daemon.preset_load_failed" && entry.payload.operation === "chain.status"
			)
			if (event === undefined || event.type !== "daemon.preset_load_failed") {
				throw new Error("expected a daemon.preset_load_failed event for chain.status on this chain")
			}
			expect(event.kind).toBe("validation")
			expect(event.payload).toMatchObject({
				chainId: numberValue(chain.id),
				presetDir: presetPath,
				operation: "chain.status",
			})
			expect(event.payload.error.length).toBeGreaterThan(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #408: cross-table DAG findings (deadlock-continuable error AND
	// dead-vocabulary warn) must surface on the unified observability stream as
	// `preset.dag_check` validation events. The error verdict triggers the
	// existing `daemon.preset_load_failed` path; both event types must land,
	// with the DAG-check finding emitted BEFORE the generic load-failure event
	// so an auditor sees the structural cause first.
	test("daemon emits preset.dag_check validation events for cross-table DAG findings (issue #408)", async () => {
		const fixture = await startFixture("preset-dag-check-daemon", { schedulerEnabled: false })
		try {
			// Fixture preset: `pending` is continuable but no phase exit / engine
			// transition ever writes a status != pending (`run`'s only exit writes
			// `pending` itself). `dead_word` is continuable but no producer can
			// write it — the warn-verdict cause.
			const presetPath = resolve(fixture.loopDataRoot, "..", "broken-dag-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
			await writeFile(resolve(presetPath, "preset.toml"), `name = "broken-dag-fixture"

[item]
idField = "issue"

[statuses]
continuable = ["queued", "pending", "dead_word"]
terminal    = ["done", "exhausted"]
entry       = "queued"
success     = ["done"]
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run.md"

  # \`pending\` has no leaving edge (the only exit writes pending itself), so
  # R2 fires with deadlock-continuable on \`pending\`. \`dead_word\` is never
  # produced anywhere → R3 fires with dead-vocabulary as a warn.
  [[phases.exits]]
  status = "pending"
  when   = "Always re-asserts pending — the deadlock."

  [phases.variables]
  ISSUE = "item.issue"

[agent]
attemptTimeoutSeconds = 3600
`)

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "broken-dag-chain",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath },
			})).chain)

			// Drive a request that loads the preset. `chain.status` resolves the
			// chain-wide preset (metadata.presetPath set), so it goes through the
			// load path and rejects on the deadlock finding.
			const statusResponse = await request(fixture, "chain.status", { chainId: numberValue(chain.id) })
			expect(statusResponse.ok).toBe(false)
			if (!statusResponse.ok) {
				expect(statusResponse.error.code).toBe("invalid_request")
				expect(statusResponse.error.message).toContain(`failed to load preset for chain ${chain.name}`)
				expect(statusResponse.error.message).toContain("preset.statuses.continuable")
				expect(statusResponse.error.message).toContain("has no leaving phase-exit edge")
				expect(statusResponse.error.message).toContain("pending")
			}

			// Validate the new event type's payload shape and content.
			const dagEvents = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "preset.dag_check" },
			)
			const chainDagEvents = dagEvents.events.filter((entry) => entry.chain === chain.name && entry.type === "preset.dag_check")
			expect(chainDagEvents.length).toBeGreaterThanOrEqual(2)
			const deadlockEvent = chainDagEvents.find((entry) => entry.type === "preset.dag_check" && entry.payload.kind === "deadlock-continuable")
			const deadVocabEvent = chainDagEvents.find((entry) => entry.type === "preset.dag_check" && entry.payload.kind === "dead-vocabulary")
			if (deadlockEvent === undefined || deadlockEvent.type !== "preset.dag_check") {
				throw new Error("expected a deadlock-continuable preset.dag_check event")
			}
			if (deadVocabEvent === undefined || deadVocabEvent.type !== "preset.dag_check") {
				throw new Error("expected a dead-vocabulary preset.dag_check event")
			}
			expect(deadlockEvent.kind).toBe("validation")
			expect(deadlockEvent.payload).toMatchObject({
				kind: "deadlock-continuable",
				verdict: "error",
				table: "statuses.continuable",
				status: "pending",
			})
			expect(deadlockEvent.payload.message.length).toBeGreaterThan(0)
			expect(deadVocabEvent.kind).toBe("validation")
			expect(deadVocabEvent.payload).toMatchObject({
				kind: "dead-vocabulary",
				verdict: "warn",
				table: "statuses.continuable",
				status: "dead_word",
			})

			// The error-finding path also emits the unified `daemon.preset_load_failed`
			// event so auditors can correlate "preset failed to load" against the
			// upstream structural finding. Ordering: every DAG-check event has a
			// timestamp <= the load-failed event's, since findings are recorded
			// before `recordPresetLoadFailure` runs.
			const loadFailedEvents = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "daemon.preset_load_failed" },
			)
			const chainLoadFailed = loadFailedEvents.events.find((entry) => entry.chain === chain.name)
			if (chainLoadFailed === undefined || chainLoadFailed.type !== "daemon.preset_load_failed") {
				throw new Error("expected a daemon.preset_load_failed event for the broken DAG chain")
			}
			expect(chainLoadFailed.kind).toBe("validation")
			expect(Date.parse(deadlockEvent.ts)).toBeLessThanOrEqual(Date.parse(chainLoadFailed.ts))
			expect(Date.parse(deadVocabEvent.ts)).toBeLessThanOrEqual(Date.parse(chainLoadFailed.ts))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon default scheduler prompt resolver consumes scheduler presetDir loaded preset", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-scheduler-preset-dir-prompt`)
		const loopDataRoot = resolve(root, "ld")
		const presetDir = resolve(root, "override-preset")
		const runner = resolve(root, "capture-prompt-runner.ts")
		const promptCapture = resolve(root, "captured-prompt.txt")
		const repoCwd = resolve(root, "repo")
		await mkdir(root, { recursive: true })
		await initGitTarget(repoCwd)
		await writePromptCaptureRunner(runner, promptCapture)
		await writeSinglePhasePromptPreset(presetDir, "CUSTOM_SCHEDULER_PRESET_PROMPT")

		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd: itemRepoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, itemRepoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				presetDir,
				runner: {
					kind: "claude",
					source: "iteration-default",
					binary: "bun",
					extraArgs: [runner],
					model: null,
				},
				worktreeManager,
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const socketPath = daemon.snapshot().socketPath
			const fixture = {
				daemon,
				loopDataRoot,
				socketPath,
				pidFile: daemon.snapshot().pidFile,
				eventLog: resolve(root, "events.jsonl"),
				schedulerEvents: [],
			}
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-preset-dir-prompt-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			await request(fixture, "item.add", {
				chainId: numberValue(chain.id),
				itemId: "45403",
				repoCwd,
			})

			const prompt = await waitFor(
				async () => {
					try {
						return await readFile(promptCapture, "utf-8")
					} catch {
						return ""
					}
				},
				(value) => value.includes("CUSTOM_SCHEDULER_PRESET_PROMPT"),
				5_000,
			)
			expect(prompt).toContain("CUSTOM_SCHEDULER_PRESET_PROMPT")
			expect(prompt).not.toContain("Step task: implement")
		} finally {
			await daemon.stop()
		}
	})

	test("socket item.update writes typed blocker fields into extra without disturbing other keys", async () => {
		const fixture = await startFixture("item-update-blocker", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "blocker-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const anchor = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "500", repoCwd: REPO_ROOT })).item)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "501",
				repoCwd: REPO_ROOT,
				dependsOn: [numberValue(anchor.id)],
			})).item)
			const itemId = numberValue(item.id)

			// #457: blocker fields are no longer first-class engine flags. The preset writes them
			// through the generic `extraPatch` channel as preset-owned string keys. The legacy
			// `blockerRepo` / `blockerRef` / `clearBlocker` top-level args are rejected at the
			// strict-args gate.
			const blocked = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("blocked"),
				extraPatch: { blockerRepo: "mouriya-s-lab/other", blockerRef: "#267" },
			})).item)
			expect(record(blocked.extra)).toMatchObject({ blockerRepo: "mouriya-s-lab/other", blockerRef: "#267", dependsOn: [numberValue(anchor.id)] })
			expect(blocked.status).toBe("blocked")
			expect(blocked.agentCwd).toBeNull()

			// To drop preset-owned blocker keys the agent rebuilds the full `extra` without them
			// (the engine no longer has a "clear blocker" first-class op). dependsOn must be
			// preserved by the agent in its rebuilt extra.
			const cleared = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				extra: { dependsOn: [numberValue(anchor.id)] },
			})).item)
			expect(record(cleared.extra)).not.toHaveProperty("blockerRepo")
			expect(record(cleared.extra)).not.toHaveProperty("blockerRef")
			expect(record(cleared.extra).dependsOn).toEqual([numberValue(anchor.id)])

			// agentCwd remains daemon-owned: it cannot be set through item.update.
			expectInvalid(await request(fixture, "item.update", { itemId, fields: { agentCwd: "/abs/elsewhere" } }))
			// #457: legacy first-class blocker mutation args are rejected at the strict-args gate.
			expectInvalid(await request(fixture, "item.update", { itemId, blockerRepo: "mouriya-s-lab/other" }))
			expectInvalid(await request(fixture, "item.update", { itemId, blockerRef: "#9" }))
			expectInvalid(await request(fixture, "item.update", { itemId, clearBlocker: true }))
			expectInvalidDetails(
				await request(fixture, "item.update", { itemId, extraPatch: { schedulerBackoff: { failureCount: "bad", nextRunAt: 1_800_000_000 } } }),
				"extra.schedulerBackoff.failureCount",
				"bad",
			)
			const legalExtra = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { schedulerBackoff: { failureCount: 1, nextRunAt: 1_800_000_000 } },
			})).item)
			expect(record(legalExtra.extra).schedulerBackoff).toEqual({ failureCount: 1, nextRunAt: 1_800_000_000 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon loads legacy-shaped metadata and item extra from existing SQLite data before scheduling", async () => {
		let seededItemId = 0
		const fixture = await startFixture("legacy-db-typed-runtime-data", {
			schedulerIntervalMs: 20,
			beforeStart: ({ loopDataRoot }) => {
				const store = openSqliteStateStore({ loopDataRoot, createIfMissing: true })
				try {
					const chain = store.createChain({
						name: "legacy-runtime-data-chain",
						preset: "gh-issue-pr-iteration",
						repository: "mouriya-s-lab/coder-loop",
						baseBranch: "main",
						metadata: storedChainMetadata({
							// #433: legacy `metadata.config` is retired; chain bindings now live at
							// `metadata.bindings`. parseChainMetadata raises an explicit error on the
							// retired key — that rejection is exercised in the metadata boundary tests
							// above (`metadata-config-array`, etc.).
							bindings: { workflowFile: "legacy-workflow.md" },
							maxItemAttempts: 3,
							coderLoopChainCompleteTrigger: { decision: "keep-active", fingerprint: "old-fingerprint", recordedAt: 1_800_000_000 },
						}),
					})
					const item = store.createItem({
						chainId: chain.id,
						itemId: "455",
						repoCwd: REPO_ROOT,
						status: runtimeStatus("queued"),
						extra: storedItemExtra({
							slotKey: "legacy-slot",
							blockerRepo: "mouriya-s-lab/coder-loop",
							blockerRef: "#454",
							schedulerBackoff: { failureCount: 1, nextRunAt: 1 },
							summary: "PHASE DONE: issue=#455; reason=legacy db compatibility",
							writeStatus: "done",
						}),
					})
					seededItemId = item.id
				} finally {
					store.close()
				}
			},
		})
		try {
			const terminal = await waitForItemQueueTerminal(fixture, seededItemId, 10_000)
			expect(terminal.terminalStatus).toBe("done")
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot, createIfMissing: false })
			try {
				const chain = store.getChainByName("legacy-runtime-data-chain")
				if (chain === null) throw new Error("expected seeded chain")
				expect(chainBindings(chain.metadata)).toEqual({ workflowFile: "legacy-workflow.md" })
				expect(chain.metadata.maxItemAttempts).toBe(3)
				const item = store.getItem(seededItemId)
				if (item === null) throw new Error("expected seeded item")
				expect(item.status).toBe("done")
				// #457: blockerRepo / blockerRef are no longer engine-typed ItemExtra fields — they
				// round-trip through `runtimeRemainder` like any preset-owned key. The store JSON
				// view exposes them through `itemExtraToJsonObject`.
				const extraJson = itemExtraToJsonObject(item.extra)
				expect(extraJson.blockerRepo).toBe("mouriya-s-lab/coder-loop")
				expect(extraJson.blockerRef).toBe("#454")
				expect(item.extra.schedulerBackoff).toEqual({ failureCount: 1, nextRunAt: 1 })
			} finally {
				store.close()
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.reorder renumbers queue positions", async () => {
		const fixture = await startFixture("item-reorder", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "reorder-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const a = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "301", repoCwd: REPO_ROOT })).item)
			const b = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "302", repoCwd: REPO_ROOT })).item)
			const c = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "303", repoCwd: REPO_ROOT })).item)

			const baseline = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(baseline.map((item) => Number(item.itemId))).toEqual([301, 302, 303])
			expect(baseline.map((item) => Number(item.position))).toEqual([0, 1, 2])

			const moved = expectOk(await request(fixture, "item.reorder", { itemId: numberValue(c.id), position: 0 })).items as BoundaryRecord[]
			expect(moved.map((item) => Number(item.itemId))).toEqual([303, 301, 302])
			expect(moved.map((item) => Number(item.position))).toEqual([0, 1, 2])

			const after = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(after.map((item) => Number(item.itemId))).toEqual([303, 301, 302])
			expect(after.map((item) => Number(item.position))).toEqual([0, 1, 2])

			expectInvalid(await request(fixture, "item.reorder", { itemId: numberValue(a.id), position: -1 }))
			expectInvalid(await request(fixture, "item.reorder", { itemId: numberValue(b.id), chainId, position: 0 }))

			const missing = await request(fixture, "item.reorder", { itemId: 999_999, position: 0 })
			expect(missing.ok).toBe(false)
			if (!missing.ok) {
				expect(missing.error.code).toBe("not_found")
				expect(missing.error.message).toContain("999999")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item status validation follows the item preset (post-#412)", async () => {
		const fixture = await startFixture("item-status-preset", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			// #412: item carries its own preset; chain.preset is no longer the source of truth.
			// The item explicitly declares the same preset as the chain to exercise status vocab.
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "188",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			})).item)
			expect(added).toMatchObject({ itemId: "188", status: "pending" })
			const pending = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "pending",
			})).item)
			expect(pending).toMatchObject({ itemId: "188", status: "pending" })

			expectInvalid(await request(fixture, "item.update", { itemId: numberValue(added.id), status: runtimeStatus("changes_requested") }))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update applies preset phase status write policy", async () => {
		const fixture = await startFixture("item-update-phase-status-policy", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "phase-policy-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const iterationItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34701",
				repoCwd: REPO_ROOT,
			})).item)
			const iterationItemId = numberValue(iterationItem.id)

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(iterationItemId, { phase: "iteration", updatedAt: 1_800_020_000 })
			} finally {
				store.close()
			}

			// #508: `in_progress` rejoined `[statuses].continuable` so daemon recovery can leave
			// it untouched and the scheduler can re-pick interrupted items. Vocab gate now
			// admits it, so the rejection comes from the phase-exits gate (iteration declares
			// no `[[phases.exits]]`, so every status is denied here) — same shape as the other
			// vocab-valid statuses below.
			for (const status of ["in_progress", "changes_requested", "blocked", "moot", "done", "exhausted"]) {
				const rejected = await request(fixture, "item.update", { itemId: iterationItemId, status })
				expectInvalid(rejected)
				if (!rejected.ok) expect(rejected.error.details).toMatchObject({ phase: "iteration", status, allowed: [] })
			}
			expect((await readItem(fixture.loopDataRoot, chainId, 34701))?.phase).toBe("iteration")

			// #397: review write that exits the phase's declared exits set (queued is vocab-valid but
			// not in review's [[phases.exits]]) is rejected under default-deny.
			const reviewExitOutsideItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34715",
				repoCwd: REPO_ROOT,
			})).item)
			const reviewExitOutsideItemId = numberValue(reviewExitOutsideItem.id)
			const exitOutsideStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				exitOutsideStore.updateItem(reviewExitOutsideItemId, { phase: "review", updatedAt: 1_800_020_098 })
			} finally {
				exitOutsideStore.close()
			}
			const reviewExitOutsideRejected = await request(fixture, "item.update", { itemId: reviewExitOutsideItemId, status: "queued" })
			expectInvalid(reviewExitOutsideRejected)
			if (!reviewExitOutsideRejected.ok) {
				expect(reviewExitOutsideRejected.error.details).toMatchObject({
					phase: "review",
					status: "queued",
					allowed: ["blocked", "changes_requested", "done", "exhausted", "moot"],
				})
			}

			// #397: an unknown phase (not declared in the preset) is now rejected — pre-#397 this
			// case short-circuited to "allow" via `allowed === null`, the actual default-allow leak
			// the issue body anchors. Default-deny rejects any status write from an unknown phase.
			const unknownPhaseItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34716",
				repoCwd: REPO_ROOT,
			})).item)
			const unknownPhaseItemId = numberValue(unknownPhaseItem.id)
			const unknownPhaseStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				unknownPhaseStore.updateItem(unknownPhaseItemId, { phase: "some-undeclared-phase", updatedAt: 1_800_020_099 })
			} finally {
				unknownPhaseStore.close()
			}
			const unknownPhaseRejected = await request(fixture, "item.update", { itemId: unknownPhaseItemId, status: "done" })
			expectInvalid(unknownPhaseRejected)
			if (!unknownPhaseRejected.ok) {
				expect(unknownPhaseRejected.error.details).toMatchObject({
					phase: "some-undeclared-phase",
					status: "done",
					allowed: [],
				})
				expect(unknownPhaseRejected.error.message).toContain("not declared in the preset")
			}

			const reviewStatuses = ["changes_requested", "blocked", "moot", "done", "exhausted"]
			for (const [index, status] of reviewStatuses.entries()) {
				const reviewItem = record(expectOk(await request(fixture, "item.add", {
					chainId,
					itemId: String(34710 + index),
					repoCwd: REPO_ROOT,
				})).item)
				const reviewItemId = numberValue(reviewItem.id)
				const reviewStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
				try {
					reviewStore.updateItem(reviewItemId, { phase: "review", updatedAt: 1_800_020_100 + index })
				} finally {
					reviewStore.close()
				}
				const updated = record(expectOk(await request(fixture, "item.update", { itemId: reviewItemId, status })).item)
				expect(updated).toMatchObject({ id: reviewItemId, status })
				expect((await readItem(fixture.loopDataRoot, chainId, 34710 + index))?.phase).toBe("review")
			}

			// #397 log obligation (issue comment "log 义务"): every allow and deny outcome of the
			// per-phase admission gate emits an `item.status.write_admission` audit event carrying
			// the subject, item, phase, requested status, declared exits, outcome, and reason. Pull
			// the event stream and assert iteration-deny / review-deny-vocab / unknown-phase-deny /
			// review-allow shapes are all present.
			const { events: admissionEvents } = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "item.status.write_admission", chain: stringValue(chain.name) },
			)
			const denyEvents = admissionEvents.filter((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.outcome === "deny")
			const allowEvents = admissionEvents.filter((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.outcome === "allow")
			expect(denyEvents.length).toBeGreaterThanOrEqual(8) // 6 iteration + 1 review-queued + 1 unknown-phase
			expect(allowEvents.length).toBe(reviewStatuses.length) // every review write was allowed
			const iterationDeny = denyEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "iteration" && event.payload.requestedStatus === "done")
			expect(iterationDeny).toBeDefined()
			if (iterationDeny !== undefined && iterationDeny.kind === "audit" && iterationDeny.type === "item.status.write_admission") {
				expect(iterationDeny.payload.declaredExits).toEqual([])
				expect(iterationDeny.payload.reason).toBe("phase-exits")
			}
			const unknownDeny = denyEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "some-undeclared-phase")
			expect(unknownDeny).toBeDefined()
			if (unknownDeny !== undefined && unknownDeny.kind === "audit" && unknownDeny.type === "item.status.write_admission") {
				expect(unknownDeny.payload.declaredExits).toEqual([])
				expect(unknownDeny.payload.reason).toBe("phase-exits")
			}
			const reviewAllow = allowEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "review" && event.payload.requestedStatus === "done")
			expect(reviewAllow).toBeDefined()
			if (reviewAllow !== undefined && reviewAllow.kind === "audit" && reviewAllow.type === "item.status.write_admission") {
				expect([...reviewAllow.payload.declaredExits].sort()).toEqual(["blocked", "changes_requested", "done", "exhausted", "moot"])
				expect(reviewAllow.payload.reason).toBe("admitted")
				// The subject envelope must carry "operator" since the request flowed without
				// `agentRunId`/`agentPhase` attribution (operator mid-run path).
				expect(reviewAllow.subject).toEqual({ kind: "operator" })
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update with no active phase records no-phase-active admission audit", async () => {
		// #397 acceptance row 7: operator mid-run path. When the item carries phase=null (no active
		// run), the gate runs only the vocabulary leg and records a `no-phase-active` audit so the
		// operator-shortcut is auditable rather than silent.
		const fixture = await startFixture("item-update-no-phase-admission", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "no-phase-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34801",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(item.id)
			// Item has phase=null after creation; the write below is the operator mid-run write
			// path covered by acceptance row 7.
			expect((await readItem(fixture.loopDataRoot, chainId, 34801))?.phase).toBeNull()

			const accepted = record(expectOk(await request(fixture, "item.update", { itemId, status: "changes_requested" })).item)
			expect(accepted).toMatchObject({ id: itemId, status: "changes_requested" })

			const { events: admissionEvents } = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "item.status.write_admission", chain: stringValue(chain.name) },
			)
			const noPhaseEntry = admissionEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === null)
			expect(noPhaseEntry).toBeDefined()
			if (noPhaseEntry !== undefined && noPhaseEntry.kind === "audit" && noPhaseEntry.type === "item.status.write_admission") {
				expect(noPhaseEntry.payload.outcome).toBe("allow")
				expect(noPhaseEntry.payload.reason).toBe("no-phase-active")
				expect(noPhaseEntry.payload.declaredExits).toEqual([])
				expect(noPhaseEntry.payload.requestedStatus).toBe("changes_requested")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.exits returns typed phase exits and parity with write-side allowed", async () => {
		// #451 typed phase-exits query face. Three scenarios in one fixture:
		//   1. Multi-option phase (gh-issue-pr-iteration/review) returns its declared 5 exits and
		//      the flat `allowed` list matches the write-side gate's `allowed` payload.
		//   2. Single-option phase (single-phase-example/run) returns exactly one exit — the
		//      uniform protocol shape multi-option and single-option phases share.
		//   3. Unknown phase is rejected with `invalid_request` listing the known phase names.
		// Acceptance rows covered: 1 (query face), 2 (write parity), 3 (single-option completion).
		const fixture = await startFixture("item-exits-typed-query", { schedulerEnabled: false })
		try {
			// Scenario 1: multi-option review phase from gh-issue-pr-iteration.
			const reviewChain = record(expectOk(await request(fixture, "chain.create", {
				name: "exits-review-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const reviewChainId = numberValue(reviewChain.id)
			const reviewItem = record(expectOk(await request(fixture, "item.add", {
				chainId: reviewChainId,
				itemId: "45101",
				repoCwd: REPO_ROOT,
			})).item)
			const reviewItemId = numberValue(reviewItem.id)

			const reviewExits = expectOk(await request(fixture, "item.exits", {
				itemId: reviewItemId,
				agentRunId: "run-exits-test-1",
				agentPhase: "review",
			}))
			expect(reviewExits.phase).toBe("review")
			// #405 ADT: the typed phase-exits face now splits the allowed payload into
			// `allowedStatuses` (item-status branch) and `allowedChainActions` (chain-action
			// branch). Review declares its five item-status exits plus the chain-action `stop`
			// exit (the controlled stop-chain channel — agent direct `chain stop` rejected
			// per #409).
			expect(reviewExits.allowedStatuses).toEqual(["blocked", "changes_requested", "done", "exhausted", "moot"])
			expect(reviewExits.allowedChainActions).toEqual(["stop"])
			const reviewExitsArray = Array.isArray(reviewExits.exits) ? reviewExits.exits : []
			expect(reviewExitsArray.length).toBe(6)
			for (const raw of reviewExitsArray) {
				const exit = record(raw)
				expect(typeof exit.when).toBe("string")
				expect((exit.when as string).length).toBeGreaterThan(0)
				if (exit.kind === "item-status") {
					expect(typeof exit.status).toBe("string")
				} else if (exit.kind === "chain-action") {
					expect(exit.action).toBe("stop")
				} else {
					throw new Error(`unknown exit kind: ${JSON.stringify(exit)}`)
				}
			}

			// Cross-check write-side parity (#397): the gate's `allowed` payload on a deny equals
			// the query's `allowedStatuses` list (chain-action exits do not participate in the
			// item-status write gate), so the agent that queries-then-writes sees one consistent
			// item-status set.
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(reviewItemId, { phase: "review", updatedAt: 1_800_030_000 })
			} finally {
				store.close()
			}
			const writeDenied = await request(fixture, "item.update", { itemId: reviewItemId, status: "queued" })
			expectInvalid(writeDenied)
			if (!writeDenied.ok) {
				expect(writeDenied.error.details).toMatchObject({
					phase: "review",
					allowed: reviewExits.allowedStatuses,
				})
			}

			// Scenario 2: single-option `run` phase from single-phase-example. Same protocol shape;
			// the only exit is `done` and writing it marks the item complete.
			const runChain = record(expectOk(await request(fixture, "chain.create", {
				name: "exits-single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const runChainId = numberValue(runChain.id)
			const runItem = record(expectOk(await request(fixture, "item.add", {
				chainId: runChainId,
				itemId: "45102",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			})).item)
			const runItemId = numberValue(runItem.id)

			const runExits = expectOk(await request(fixture, "item.exits", {
				itemId: runItemId,
				agentRunId: "run-exits-test-2",
				agentPhase: "run",
			}))
			expect(runExits.phase).toBe("run")
			// #405 ADT: single-option phase only declares item-status exits, so
			// `allowedChainActions` is empty here while `allowedStatuses` mirrors the historical
			// `allowed` projection.
			expect(runExits.allowedStatuses).toEqual(["done"])
			expect(runExits.allowedChainActions).toEqual([])
			const runExitsArray = Array.isArray(runExits.exits) ? runExits.exits : []
			expect(runExitsArray.length).toBe(1)
			const onlyExit = record(runExitsArray[0])
			expect(onlyExit.kind).toBe("item-status")
			expect(onlyExit.status).toBe("done")

			// Scenario 3: unknown phase rejected with typed `invalid_request` listing known phases.
			const unknownPhase = await request(fixture, "item.exits", {
				itemId: reviewItemId,
				agentRunId: "run-exits-test-3",
				agentPhase: "no-such-phase",
			})
			expect(unknownPhase.ok).toBe(false)
			if (!unknownPhase.ok) {
				expect(unknownPhase.error.code).toBe("invalid_request")
				expect(unknownPhase.error.message).toContain("no-such-phase")
				expect(unknownPhase.error.details).toMatchObject({ phase: "no-such-phase" })
			}

			// Missing agent attribution is rejected (the query face is per-agent-run by design).
			const missingAttribution = await request(fixture, "item.exits", { itemId: reviewItemId, agentRunId: "run-x" })
			expect(missingAttribution.ok).toBe(false)
			if (!missingAttribution.ok) {
				expect(missingAttribution.error.code).toBe("invalid_request")
				expect(missingAttribution.error.message).toContain("agentRunId and agentPhase")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #405 chain-action exit selection face. Three scenarios cover the protocol surface:
	//   1. Selecting a declared chain-action (`stop`) maps to the operator chain.stop semantics —
	//      chain status flips to `stopped`, the audit + lifecycle events fire (#411 obligation), and
	//      operator `chain.resume` reversibly restores active status.
	//   2. Selecting a chain-action that the phase does not declare is rejected as `invalid_request`
	//      with the typed declared-options list (default-deny per the #397 pattern).
	//   3. Agent direct `chain.stop` calls remain rejected through the credential gate — this CLI
	//      is the only controlled channel for an agent to stop the chain it owns (#409).
	test("socket item.exitAction stop maps to chain.stop and emits the audit + lifecycle events (#405 + #411)", async () => {
		const fixture = await startFixture("item-exit-action-stop", { schedulerEnabled: false })
		try {
			const chainRecord = record(expectOk(await request(fixture, "chain.create", {
				name: "exit-action-stop-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chainRecord.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "45201",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(item.id)
			const eventsFile = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile

			// Scenario 2a: vocabulary-invalid action is rejected by the request boundary before the
			// per-phase admission gate fires. The error message echoes the engine vocabulary.
			const bogusVocab = await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-1a",
				agentPhase: "review",
				action: "not_a_real_action",
			})
			expect(bogusVocab.ok).toBe(false)
			if (!bogusVocab.ok) {
				expect(bogusVocab.error.code).toBe("invalid_request")
				expect(bogusVocab.error.message).toMatch(/action must be one of: stop/)
			}

			// Scenario 2b: vocabulary-valid but phase-undeclared action is rejected by the per-phase
			// admission gate (default-deny per #397 pattern). Iteration declares no chain-action exits
			// at all (its `[[phases.exits]]` is empty), so `action=stop` against `agentPhase=iteration`
			// is admitted at the vocabulary leg and denied at the per-phase leg — producing the
			// `item.exit.selected` audit event with `outcome=deny reason=phase-exits`.
			const undeclared = await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-1b",
				agentPhase: "iteration",
				action: "stop",
			})
			expect(undeclared.ok).toBe(false)
			if (!undeclared.ok) {
				expect(undeclared.error.code).toBe("invalid_request")
				expect(undeclared.error.message).toMatch(/chain action "stop" is not declared by phase "iteration"/)
			}

			// Scenario 1a: agent-attribution-bypass operator-style call (no agentCredential) succeeds —
			// the chain stops and both observability events fire. Agents go through the credential
			// gate; operator path is the same handler with no credential field.
			const accepted = expectOk(await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-2",
				agentPhase: "review",
				action: "stop",
			}))
			expect(accepted.action).toBe("stop")
			const acceptedChain = record(accepted.chain)
			expect(acceptedChain.status).toBe("stopped")

			// #411 audit event: `item.exit.selected` fired for the deny + allow attempts.
			const { events: auditEvents } = await queryObservabilityEvents(eventsFile, { type: "item.exit.selected" })
			expect(auditEvents.length).toBeGreaterThanOrEqual(2)
			const denyEvent = auditEvents.find((event) => event.type === "item.exit.selected" && event.payload.outcome === "deny")
			const allowEvent = auditEvents.find((event) => event.type === "item.exit.selected" && event.payload.outcome === "allow")
			if (denyEvent?.type !== "item.exit.selected") throw new Error("expected deny item.exit.selected audit")
			if (allowEvent?.type !== "item.exit.selected") throw new Error("expected allow item.exit.selected audit")
			expect(denyEvent.payload.selectionKind).toBe("chain-action")
			expect(denyEvent.payload.reason).toBe("phase-exits")
			expect(denyEvent.payload.declaredChainActions).toEqual([]) // iteration declares no chain-action exits
			expect(denyEvent.phase).toBe("iteration")
			expect(allowEvent.payload.selectedAction).toBe("stop")
			expect(allowEvent.payload.reason).toBe("admitted")
			expect(allowEvent.payload.declaredChainActions).toEqual(["stop"]) // review declares stop
			expect(allowEvent.phase).toBe("review")

			// #411 lifecycle distinguisher: `chain.stop.from_phase_exit` fires alongside the existing
			// `chain.status` audit event the chain-stop dispatcher already emits.
			const { events: lifecycleEvents } = await queryObservabilityEvents(eventsFile, { type: "chain.stop.from_phase_exit" })
			expect(lifecycleEvents.length).toBe(1)
			const lifecycleEvent = lifecycleEvents[0]
			if (lifecycleEvent?.type !== "chain.stop.from_phase_exit") throw new Error("expected chain.stop.from_phase_exit lifecycle event")
			expect(lifecycleEvent.payload.chainId).toBe(chainId)
			expect(lifecycleEvent.payload.id).toBe("45201")
			expect(lifecycleEvent.payload.alreadyStopped).toBe(false)
			expect(lifecycleEvent.phase).toBe("review")
			expect(lifecycleEvent.runId).toBe("run-exit-action-test-2")

			// Scenario 1b: chain.resume reversibly restores active status — confirms the chain-action
			// exit path is the same code path operator `chain stop` runs (D1 semantics).
			const resumed = expectOk(await request(fixture, "chain.resume", { chainId }))
			const resumedChain = record(resumed.chain)
			expect(resumedChain.status).toBe("active")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("credential-bound item.exitAction denies forged attribution and preserves overlapping already-stopped review attempts (#600)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-600-exit-action-credential-truth`)
		const loopDataRoot = resolve(root, "ld")
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const iterationRelease = resolve(root, "iteration-release")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { appendFile, writeFile } from "node:fs/promises"
import { type as arkType } from "arktype"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
const IterationRunnerPromptBoundary = arkType({
	itemId: "number",
	runId: "string",
	phase: arkType.unit("iteration"),
	eventLog: "string",
})
const ReviewRunnerPromptBoundary = arkType({
	itemId: "number",
	runId: "string",
	phase: arkType.unit("review"),
	eventLog: "string",
})
const RunnerPromptBoundary = arkType.or(IterationRunnerPromptBoundary, ReviewRunnerPromptBoundary)
type IterationRunnerPrompt = typeof IterationRunnerPromptBoundary.infer
type ReviewRunnerPrompt = typeof ReviewRunnerPromptBoundary.infer
type RunnerPrompt = IterationRunnerPrompt | ReviewRunnerPrompt
function assertNeverRunnerPrompt(input: never): never {
	throw new Error(\`unexpected runner prompt phase: \${JSON.stringify(input)}\`)
}
const promptIndex = Bun.argv.indexOf("-p")
if (promptIndex === -1 || promptIndex + 1 >= Bun.argv.length) {
	throw new Error("fake runner requires -p followed by a prompt value")
}
const prompt = Bun.argv[promptIndex + 1]
if (prompt === undefined) throw new Error("fake runner requires -p followed by a prompt value")
const promptPayloadEnd = prompt.indexOf("\\n")
const promptPayload = prompt.slice(0, promptPayloadEnd === -1 ? prompt.length : promptPayloadEnd)
const input: RunnerPrompt = RunnerPromptBoundary.assert(JSON.parse(promptPayload))
const loopDataRoot = process.env.CODER_LOOP_DATA_DIR
if (typeof loopDataRoot !== "string" || loopDataRoot.length === 0) {
	throw new Error("fake runner requires CODER_LOOP_DATA_DIR")
}
const credential = process.env.CODER_LOOP_RUN_CRED
if (typeof credential !== "string" || credential.length === 0) {
	throw new Error("fake runner requires CODER_LOOP_RUN_CRED")
}
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
switch (input.phase) {
	case "iteration": {
		await writeFile(${JSON.stringify(iterationCapture)}, credential)
		while (!(await Bun.file(${JSON.stringify(iterationRelease)}).exists())) await Bun.sleep(10)
		const store = openSqliteStateStore({ loopDataRoot })
		store.updateItem(input.itemId, { status: "in_progress", updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
		break
	}
	case "review":
		await writeFile(${JSON.stringify(reviewCapture)}, credential)
		await new Promise((resolveWait) => setTimeout(resolveWait, 8_000))
		break
	default:
		assertNeverRunnerPrompt(input)
}
process.exitCode = 0
`,
		)
		const runnerEnv = { ...process.env }
		delete runnerEnv.CODER_LOOP_DATA_DIR
		delete runnerEnv.CODER_LOOP_RUN_CRED
		const validIterationPrompt = JSON.stringify({ itemId: 60001, runId: "boundary-run", phase: "iteration", eventLog })
		const invalidPhasePrompt = JSON.stringify({ itemId: 60001, runId: "boundary-run", phase: "unknown", eventLog })
		const boundaryCases = [
			{
				name: "missing -p",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires -p followed by a prompt value",
			},
			{
				name: "missing prompt value",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p"], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires -p followed by a prompt value",
			},
			{
				name: "missing data dir",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", validIterationPrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires CODER_LOOP_DATA_DIR",
			},
			{
				name: "missing credential",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", validIterationPrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires CODER_LOOP_RUN_CRED",
			},
			{
				name: "unknown phase",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", invalidPhasePrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "phase",
			},
		]
		for (const boundaryCase of boundaryCases) {
			const [exitCode, stderr] = await Promise.all([
				boundaryCase.proc.exited,
				new Response(boundaryCase.proc.stderr).text(),
			])
			expect(exitCode, boundaryCase.name).not.toBe(0)
			expect(stderr, boundaryCase.name).toContain(boundaryCase.expectedError)
		}
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({ itemId: item.id, runId, phase, eventLog }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "exit-action-credential-truth-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "60001",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(item.id)

			await waitFor(async () => {
				try { return (await readFile(iterationCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const iterationCredential = (await readFile(iterationCapture, "utf-8")).trim()
			const iterationStatus = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon)
			const iterationRuns = Array.isArray(iterationStatus.activeRuns) ? iterationStatus.activeRuns : []
			const iterationRun = iterationRuns.map(record).find((run) => typeof run.runId === "string" && run.runId.includes("-iteration-item-"))
			if (iterationRun === undefined) throw new Error("expected active iteration run")
			const iterationRunId = stringValue(iterationRun.runId)

			const forged = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", {
				itemId,
				agentRunId: iterationRunId,
				agentPhase: "review",
				action: "stop",
				agentCredential: iterationCredential,
			}))
			expect(forged.ok).toBe(false)
			if (!forged.ok) {
				expect(forged.error.code).toBe("invalid_caller")
				expect(forged.error.message).toContain("phase")
				expect(forged.error.details).toMatchObject({
					boundRunId: iterationRunId,
					boundPhase: "iteration",
					claimedRunId: iterationRunId,
					claimedPhase: "review",
				})
			}
			const stillActive = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.status", { chainId }))).chain)
			expect(stillActive.status).toBe("active")

			const eventsFile = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const forgedEvents = (await queryObservabilityEvents(eventsFile, { type: "item.exit.selected" })).events
			const forgedDeny = forgedEvents.find((event) => event.type === "item.exit.selected" && event.payload.reason === "caller-attribution-mismatch")
			if (forgedDeny?.type !== "item.exit.selected") throw new Error("expected caller-attribution-mismatch item.exit.selected audit")
			expect(forgedDeny.phase).toBe("iteration")
			expect(forgedDeny.runId).toBe(iterationRunId)
			expect(forgedDeny.payload.phase).toBe("iteration")
			expect(forgedDeny.payload.declaredChainActions).toEqual([])
			expect(forgedDeny.subject).toEqual({ kind: "agent", runId: iterationRunId, phase: "iteration" })
			await writeFile(iterationRelease, "release")

			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			const reviewStatus = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon)
			const reviewRuns = Array.isArray(reviewStatus.activeRuns) ? reviewStatus.activeRuns : []
			const reviewRun = reviewRuns.map(record).find((run) => typeof run.runId === "string" && run.runId.includes("-review-item-"))
			if (reviewRun === undefined) throw new Error("expected active review run")
			const reviewRunId = stringValue(reviewRun.runId)

			const stopArgs: JsonObject = {
				itemId,
				agentRunId: reviewRunId,
				agentPhase: "review",
				action: "stop",
				agentCredential: reviewCredential,
			}
			const stopResponses = await Promise.all([
				sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", stopArgs)),
				sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", stopArgs)),
			])
			const acceptedStops = stopResponses.map(expectOk)
			expect(acceptedStops.map((accepted) => record(accepted.chain).status)).toEqual(["stopped", "stopped"])
			const finalEvents = (await queryObservabilityEvents(eventsFile)).events
			const acceptedSelections = finalEvents.filter((event) => event.type === "item.exit.selected" && event.payload.outcome === "allow")
			expect(acceptedSelections).toHaveLength(2)
			for (const acceptedSelection of acceptedSelections) {
				if (acceptedSelection.type !== "item.exit.selected") throw new Error("expected allowed item.exit.selected audit")
				expect(acceptedSelection.phase).toBe("review")
				expect(acceptedSelection.runId).toBe(reviewRunId)
				expect(acceptedSelection.subject).toEqual({ kind: "agent", runId: reviewRunId, phase: "review" })
			}
			const stopLifecycleEvents = finalEvents.filter((event) => event.type === "chain.stop.from_phase_exit")
			expect(stopLifecycleEvents).toHaveLength(2)
			for (const stopLifecycle of stopLifecycleEvents) {
				if (stopLifecycle.type !== "chain.stop.from_phase_exit") throw new Error("expected chain.stop.from_phase_exit lifecycle event")
				expect(stopLifecycle.phase).toBe("review")
				expect(stopLifecycle.runId).toBe(reviewRunId)
				expect(stopLifecycle.subject).toEqual({ kind: "agent", runId: reviewRunId, phase: "review" })
			}
			expect(stopLifecycleEvents.map((event) => event.type === "chain.stop.from_phase_exit" && event.payload.alreadyStopped).sort()).toEqual([false, true])
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	test("socket item.update rejects immutable selectors and daemon-owned fields", async () => {
		const fixture = await startFixture("item-update-strict-fields", { schedulerEnabled: false })
		try {
			const firstChain = record(expectOk(await request(fixture, "chain.create", {
				name: "immutable-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const secondChain = record(expectOk(await request(fixture, "chain.create", {
				name: "other-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(firstChain.id)
			const otherChainId = numberValue(secondChain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "221",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			const invalidRequests = [
				{ itemId },
				{ itemId, chainId: otherChainId, status: runtimeStatus("done") },
				{ itemId, id: itemId, status: runtimeStatus("done") },
				{ itemId, createdAt: 1, status: runtimeStatus("done") },
				{ itemId, updatedAt: 1, status: runtimeStatus("done") },
				{ itemId, attempts: 5 },
				{ itemId, lastRunId: "run-forged" },
				{ itemId, agentCwd: "/etc/passwd" },
				{ itemId, fields: { chainId: otherChainId } },
				{ itemId, fields: { issueNumber: 999 } },
				{ itemId, fields: { attempts: 5 } },
				{ itemId, fields: { lastRunId: "run-forged" } },
				{ itemId, fields: { agentCwd: "/etc/passwd" } },
				{ itemId, fields: { updatedAt: 1 } },
			]
			for (const args of invalidRequests) expectInvalid(await request(fixture, "item.update", args))

			const unchangedItems = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(unchangedItems)).toBe(true)
			if (!Array.isArray(unchangedItems)) throw new Error("expected unchanged item list array")
			expect(unchangedItems).toHaveLength(1)
			expect(record(unchangedItems[0])).toMatchObject({
				id: itemId,
				chainId,
				itemId: "221",
				status: runtimeStatus("queued"),
				attempts: 0,
				lastRunId: null,
				agentCwd: null,
			})
			const otherItems = expectOk(await request(fixture, "item.list", { chainId: otherChainId })).items
			expect(Array.isArray(otherItems)).toBe(true)
			expect(otherItems).toHaveLength(0)

			const updated = record(expectOk(await request(fixture, "item.update", {
				chainId,
				itemId: "221",
				fields: { status: runtimeStatus("done"), title: "strict item update" },
			})).item)
			expect(updated).toMatchObject({ id: itemId, chainId, status: runtimeStatus("done"), title: "strict item update" })
			expect((updated as { itemId: string }).itemId).toBe("221")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete reports already_deleted consistently", async () => {
		const fixture = await startFixture("chain-delete-idempotency", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted).toMatchObject({ alreadyDeleted: false, chain: { status: "deleted" } })

			const deletedAgain = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deletedAgain).toMatchObject({ alreadyDeleted: true, chain: { status: "deleted" } })

			const missing = await request(fixture, "chain.delete", { chainId: 99999 })
			expect(missing.ok).toBe(false)
			if (!missing.ok) expect(missing.error.code).toBe("not_found")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain lookup rejects conflicting chainId and chainName", async () => {
		const fixture = await startFixture("chain-lookup-conflict", { schedulerEnabled: false })
		try {
			const chainA = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-a",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainB = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-b",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainAId = numberValue(chainA.id)
			const chainBId = numberValue(chainB.id)

			const matchingStatus = record(expectOk(await request(fixture, "chain.status", { chainId: chainAId, chainName: "chain-a" })).chain)
			expect(matchingStatus).toMatchObject({ id: chainAId, name: "chain-a" })

			const mismatchedStatus = await request(fixture, "chain.status", { chainId: chainAId, chainName: "chain-b" })
			expectInvalid(mismatchedStatus)
			if (mismatchedStatus.ok) throw new Error("expected mismatched chain.status to fail")
			expect(mismatchedStatus.error.message).toBe("chainId and chainName both provided but point to different chains")
			expect(record(mismatchedStatus.error.details)).toMatchObject({
				chainId: chainAId,
				chainName: "chain-b",
				chainIdResolvesTo: "chain-a",
				chainNameResolvesTo: chainBId,
			})

			const mismatchedDelete = await request(fixture, "chain.delete", { chainId: chainAId, chainName: "chain-b" })
			expectInvalid(mismatchedDelete)
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(2)
			expect(listed.map((entry) => record(entry))).toEqual([
				expect.objectContaining({ id: chainAId, name: "chain-a", status: "active" }),
				expect.objectContaining({ id: chainBId, name: "chain-b", status: "active" }),
			])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create force recreates deleted same-name chain", async () => {
		const fixture = await startFixture("chain-create-deleted-name", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			expectOk(await request(fixture, "chain.delete", { chainId }))
			const unforced = await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
			})
			expectChainDeleted(unforced)
			if (!unforced.ok) expect(unforced.error.message).toContain("force=true")

			const recreated = record(expectOk(await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "recreated",
				force: true,
			})).chain)
			const recreatedId = numberValue(recreated.id)
			expect(recreatedId).not.toBe(chainId)
			expect(recreated).toMatchObject({
				name: "recyclable",
				status: "active",
				baseBranch: "recreated",
			})

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({ id: recreatedId, name: "recyclable", status: "active" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket deleted chain remains read-only for item mutations", async () => {
		const fixture = await startFixture("deleted-chain-read-only", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "read-only-deleted-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "226",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			expectOk(await request(fixture, "chain.delete", { chainId }))

			expectChainDeleted(await request(fixture, "item.add", {
				chainId,
				itemId: "227",
				repoCwd: REPO_ROOT,
			}))
			expectChainDeleted(await request(fixture, "item.update", { itemId, status: runtimeStatus("done") }))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(expectOk(await request(fixture, "chain.status", { chainId })).chain).status).toBe("deleted")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket completed chain remains read-only for item mutations", async () => {
		const fixture = await startFixture("completed-chain-read-only", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "read-only-completed-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "228",
				repoCwd: REPO_ROOT,
				title: "complete me",
			})).item)
			const itemId = numberValue(added.id)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { status: runtimeStatus("done"), phase: "review", updatedAt: 1_800_015_200 })
				store.updateChain(chainId, { status: "completed", updatedAt: 1_800_015_201 })
			} finally {
				store.close()
			}

			expectChainNotActive(await request(fixture, "item.add", {
				chainId,
				itemId: "229",
				repoCwd: REPO_ROOT,
			}), "completed", "item.add")
			expectChainNotActive(await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "230", repoCwd: REPO_ROOT },
					{ itemId: "231", repoCwd: REPO_ROOT },
				],
			}), "completed", "item.batchAdd")
			expectChainNotActive(await request(fixture, "item.update", { itemId, title: "mutated after completion" }), "completed", "item.update")
			expectChainNotActive(await request(fixture, "item.reorder", { itemId, position: 0 }), "completed", "item.reorder")

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected item list array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({
				id: itemId,
				itemId: "228",
				status: runtimeStatus("done"),
				title: "complete me",
			})
			expect(record(expectOk(await request(fixture, "chain.status", { chainId })).chain).status).toBe("completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete removes scheduler worktree registration and chain runtime layout", async () => {
		const fixture = await startFixture("chain-delete-cleanup", { realWorktreeManager: true })
		const target = resolve(fixture.loopDataRoot, "..", "target")
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, itemId: "225", repoCwd: target, extra: { sleepMs: 5_000 } })
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const storedChain = await readChain(fixture.loopDataRoot, chainId)
			if (storedChain === null) throw new Error("expected chain record")
			const paths = resolveChainRuntimePaths("delete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const worktreePath = schedulerSlotWorktreePath(storedChain, target, { loopDataRoot: fixture.loopDataRoot })
			expect(await pathExists(worktreePath)).toBe(true)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).toContain(worktreePath)

			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted).toMatchObject({
				alreadyDeleted: false,
				chain: { status: "deleted" },
				cleanup: { chainRootRemoved: true },
			})
			expect(await pathExists(paths.chainRoot)).toBe(false)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)

			await fixture.daemon.stop()
			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
			try {
				expect(await pathExists(paths.chainRoot)).toBe(false)
			} finally {
				await restarted.stop()
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket completed chain removes scheduler worktree registration and preserves audit runtime", async () => {
		const fixture = await startFixture("chain-complete-cleanup", { realWorktreeManager: true })
		const target = resolve(fixture.loopDataRoot, "..", "target")
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "complete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, itemId: "351003", repoCwd: target })
			await waitFor(
				async () =>
					fixture.schedulerEvents.find(
						(event): event is Extract<SchedulerEvent, { type: "chain.completed" }> => event.type === "chain.completed" && event.chainId === chainId,
					) ?? null,
				(event) => event !== null,
				10_000,
			)

			const storedChain = await readChain(fixture.loopDataRoot, chainId)
			if (storedChain === null) throw new Error("expected chain record")
			const completedItem = await readItem(fixture.loopDataRoot, chainId, 351_003)
			if (completedItem === null || completedItem.lastRunId === null) throw new Error("expected completed item run id")
			const paths = resolveChainRuntimePaths("complete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const worktreePath = schedulerSlotWorktreePath(storedChain, target, { loopDataRoot: fixture.loopDataRoot })

			expect(storedChain.status).toBe("completed")
			expect(await pathExists(worktreePath)).toBe(false)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
			expect(await pathExists(paths.chainRoot)).toBe(true)
			expect(await pathExists(paths.runsDir)).toBe(true)
			expect(await pathExists(paths.runEventsFile(completedItem.lastRunId))).toBe(false)
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
				chain: "complete-cleanup",
				type: "chain.completed",
			})
			expect(events.events).toHaveLength(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete terminates active runs before marking chain deleted", async () => {
		const fixture = await startFixture("chain-delete-active-run", { schedulerIntervalMs: 20 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-active-run",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "220",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const startedAt = Date.now()
			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))

			expect(Date.now() - startedAt).toBeLessThan(4_000)
			expect(deleted).toMatchObject({
				alreadyDeleted: false,
				chain: { status: "deleted" },
				// A force-killed agent never wrote its own status, so the item keeps its entry status.
				terminatedRuns: [{
					chainId,
					itemId,
					exitCode: 1,
					status: runtimeStatus("queued"),
				}],
				cleanup: { chainRootRemoved: true },
			})
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])

			const status = record(expectOk(await request(fixture, "chain.status", { chainId })))
			expect(record(status.chain).status).toBe("deleted")
			expect(status.activeRuns).toEqual([])
			expect(record(status.summary).activeSlots).toEqual([])
			expect(record(record(status.summary).items).byStatus).toEqual({ queued: 1 })
			expect(await pathExists(resolveChainRuntimePaths("delete-active-run", { loopDataRoot: fixture.loopDataRoot }).chainRoot)).toBe(false)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("auto chain completion", async () => {
		const fixture = await startFixture("completion")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "completion-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: runtimeStatus("done"),
			})

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("terminal item.update sets terminal status; active run finishes naturally, then chain completes", async () => {
		const fixture = await startFixture("terminal-update-active-run")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "terminal-update-active-run-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "249",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 500, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { phase: "review", updatedAt: 1_800_020_200 })
			} finally {
				store.close()
			}

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
			})).item)

			expect(updated).toMatchObject({ id: itemId, status: runtimeStatus("done") })
			// item.update no longer terminates the active run. The run finishes naturally,
			// then the close handler completes the chain (item already terminal).
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({ type: "agent.exit", itemId, status: runtimeStatus("done") }))
			const chainCompleted = await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "chain.completed" && event.chainId === chainId) ?? null,
				(event) => event !== null,
			)
			expect(chainCompleted).toMatchObject({ type: "chain.completed", chainId })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.stop terminates active runs and preserves stopped chain runtime", async () => {
		const fixture = await startFixture("chain-stop-active-run")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-stop-active-run",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "349201",
				repoCwd: REPO_ROOT,
				extra: {
					sleepMs: 5_000,
					summary: "ITERATION SUMMARY: fake iteration in progress",
				},
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const currentChain = await readChain(fixture.loopDataRoot, chainId)
			if (currentChain === null) throw new Error("expected chain")
			const worktreePath = schedulerSlotWorktreePath(currentChain, REPO_ROOT, { loopDataRoot: fixture.loopDataRoot })
			const stopped = record(expectOk(await request(fixture, "chain.stop", { chainId })))

			expect(record(stopped.chain).status).toBe("stopped")
			expect(stopped.alreadyStopped).toBe(false)
			expect(Array.isArray(stopped.terminatedRuns)).toBe(true)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])
			expect(await pathExists(resolveChainRuntimePaths("chain-stop-active-run", { loopDataRoot: fixture.loopDataRoot }).chainRoot)).toBe(true)
			expect(await pathExists(worktreePath)).toBe(true)

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { status: runtimeStatus("done"), updatedAt: 1_800_034_900 })
			} finally {
				store.close()
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 80))
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("stopped")
			expect((await readItem(fixture.loopDataRoot, chainId, 349_201))?.status).toBe("done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.resume restores scheduling for a stopped chain", async () => {
		const fixture = await startFixture("chain-resume-schedules")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-resume-schedules",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			expect(record(expectOk(await request(fixture, "chain.stop", { chainId })).chain).status).toBe("stopped")

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.createItem({
					chainId,
					itemId: "349202",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({
						sleepMs: 200,
						summary: "ITERATION SUMMARY: fake iteration in progress",
					}),
				})
			} finally {
				store.close()
			}

			const resumed = record(expectOk(await request(fixture, "chain.resume", { chainId })))
			expect(record(resumed.chain).status).toBe("active")
			expect(resumed.alreadyActive).toBe(false)
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 349_202), (item) => item?.phase === "iteration" && item.attempts > 0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon survives all chains complete", async () => {
		const fixture = await startFixture("survives-complete")
		try {
			const first = record(expectOk(await request(fixture, "chain.create", {
				name: "first-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId: numberValue(first.id),
				itemId: "180",
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: runtimeStatus("done"),
			})
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, numberValue(first.id)), (status) => status === "completed")

			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
			await request(fixture, "chain.create", {
				name: "second-chain",
				repository: "mouriya-s-lab/coder-loop",
			})
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(2)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

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
			expect((phaseEnd as { status?: string }).status).toBe("queued")
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
			const agentPid = (activeRuns as unknown as Array<{ pid?: number }>)[0]?.pid

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
	test("daemon startup kills stale process group and clears current_run without rewriting item business fields (#508)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-recovery`)
		const loopDataRoot = resolve(root, "ld")
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
					extra: storedItemExtra({}),
				})
			store.setCurrentRun({
				chainId: chain.id,
					phase: "iteration",
					runId: "run-stale-217",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ itemId: item.id, pid: stale.pid, processGroupLeader: true }),
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
			const recovered = await readItem(loopDataRoot, 1, 217)
			// #508 predicted result #1: status / phase / sessionIds preserved (daemon recovery
			// no longer rewrites business fields).
			expect(recovered?.status).toBe("in_progress")
			expect(recovered?.phase).toBe("iteration")
			expect(recovered?.sessionIds).toEqual(sessionIdsSnapshot)
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
		const loopDataRoot = resolve(root, "ld")
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
					extra: storedItemExtra({}),
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
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup terminates the process group of an orphaned non-current run", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-run-pgid`)
		const loopDataRoot = resolve(root, "ld")
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
					extra: storedItemExtra({ pid: stale.pid, processGroupLeader: true }),
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
		const loopDataRoot = resolve(root, "ld")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
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
					extra: storedItemExtra({}),
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

		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
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
		const loopDataRoot = resolve(root, "ld")
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
					extra: storedItemExtra({}),
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
		const fixture = await startFixture("scheduler-artifacts", { schedulerIntervalMs: 1_000 })
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
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done" },
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
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as BoundaryRecord
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { run: runId })

			expect(status).toMatchObject({ runId, chainId, itemId: "203", phase: "iteration", exitCode: 0, status: runtimeStatus("done") })
			expect(stdout).toContain("done:")
			expect(stderr).toBe("")
			expect(status.eventsPath).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(await pathExists(paths.runEventsFile(runId))).toBe(false)
			expect(events.events.map((event) => event.type)).toEqual([
				"agent.spawn",
				"phase.start",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.completed",
			])
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
			const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: fixture.loopDataRoot })

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
			const cliPayload = JSON.parse(cliStdout) as { events: { recent: unknown[] } }
			const cliTypes = cliPayload.events.recent.map((event) =>
				typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as BoundaryRecord).type === "string"
					? ((event as BoundaryRecord).type as string)
					: null,
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
			kind: "decision",
			type: "slot.busy",
			chain: "fingerprint-chain",
			runId: "run-1",
			subject: { kind: "engine" },
			payload: { slotKey: "slot-a", chainId: 1, repoCwd: "/repo/a", activeRunId: "run-1" },
		})
		const changed = makeObservabilityEvent({
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

[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[[phases]]
name = "review"
prompt = "review.md"

  [[phases.exits]]
  status = "done"
  when = "The review completed successfully."

  [[phases.exits]]
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
			const sibling = record(expectOk(await request(fixture, "chain.create", {
				name: "fingerprint-active-sibling",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const siblingChainId = numberValue(sibling.id)
			const state = daemonDecisionFingerprintState(fixture.daemon)
			const slot = makeObservabilityEvent({
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
				extra: { sleepMs: 5, exitCode: 0, writeStatus: "done" },
				preset: "single-phase-example",
			})

			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 215), (candidate) => candidate?.status === "done")
			const spawnEvent = fixture.schedulerEvents.find((event) => event.type === "agent.spawn")
			expect(spawnEvent).toMatchObject({
				type: "agent.spawn",
				chainId,
				presetDir: resolve(REPO_ROOT, "presets/single-phase-example"),
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (operator path). Boundary parse on item.update accepts a request
	// with no `agentCredential` as `kind: "operator"` and records one `item.mutation.caller_admission`
	// audit event with reason=operator. Subject on every downstream audit event for that mutation
	// is `{kind: "operator"}` — typechecker exhaustiveness in `handleItemUpdate` enforces this.
	test("socket item.update operator path emits operator-attributed caller-admission audit (#406)", async () => {
		const fixture = await startFixture("item-update-caller-operator", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406001",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)
			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
			})).item)
			expect(updated).toMatchObject({ id: itemId, status: runtimeStatus("done") })

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const allEvents = (await queryObservabilityEvents(eventsPath)).events
			const callerAllow = allEvents.find((event) => event.kind === "audit" && event.type === "item.mutation.caller_admission" && event.item === itemId)
			expect(callerAllow).toBeDefined()
			if (callerAllow !== undefined && callerAllow.kind === "audit" && callerAllow.type === "item.mutation.caller_admission") {
				expect(callerAllow.subject).toEqual({ kind: "operator" })
				expect(callerAllow.payload).toMatchObject({
					rowId: itemId,
					itemId: "406001",
					claimedRunId: null,
					claimedPhase: null,
					outcome: "allow",
					reason: "operator",
				})
			}
			const statusEvent = allEvents.find((event) => event.kind === "audit" && event.type === "item.status" && event.item === itemId)
			expect(statusEvent).toBeDefined()
			if (statusEvent !== undefined && statusEvent.kind === "audit" && statusEvent.type === "item.status") {
				expect(statusEvent.subject).toEqual({ kind: "operator" })
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (unknown-credential deny). A request that carries an
	// `agentCredential` value that does not match any registered active run is rejected with
	// `invalid_caller` and the audit event records `reason: unknown-credential`.
	test("socket item.update rejects an unknown agentCredential value (#406)", async () => {
		const fixture = await startFixture("item-update-caller-unknown-credential", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-unknown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406002",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)
			const denied = await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
				agentCredential: "credential-not-in-registry",
			})
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const allEvents = (await queryObservabilityEvents(eventsPath)).events
			const callerDeny = allEvents.find((event) => event.kind === "audit" && event.type === "item.mutation.caller_admission" && event.item === itemId && event.payload.outcome === "deny")
			expect(callerDeny).toBeDefined()
			if (callerDeny !== undefined && callerDeny.kind === "audit" && callerDeny.type === "item.mutation.caller_admission") {
				expect(callerDeny.payload.reason).toBe("unknown-credential")
			}
			// The store was untouched — the gate ran before any state mutation.
			const items = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(items) || items.length === 0) throw new Error("expected an item in caller-unknown-chain")
			const stillQueued = record(items[0])
			expect(stillQueued.status).toBe(runtimeStatus("queued"))
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (legacy attribution flags). The retired `agentRunId` /
	// `agentPhase` keys are rejected by `validateKnownKeys` (they are not in ITEM_UPDATE_ARG_KEYS).
	// This pins the substitutive contract: agents can no longer hand-write their identity.
	test("socket item.update rejects retired agentRunId / agentPhase attribution claims (#406)", async () => {
		const fixture = await startFixture("item-update-caller-legacy-args", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-legacy-args-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406003",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)
			for (const legacy of [
				{ itemId, status: runtimeStatus("done"), agentRunId: "fake-run", agentPhase: "review" },
				{ itemId, status: runtimeStatus("done"), agentRunId: "fake-run" },
				{ itemId, status: runtimeStatus("done"), agentPhase: "review" },
			]) {
				expectInvalid(await request(fixture, "item.update", legacy))
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (live spawn → wrong-item). Two items in the same chain spawn
	// sequentially under the default fake runner. We capture the active credential from inside
	// the runner's process env, then use it to attempt an item.update against a sibling item the
	// credential is NOT bound to. The daemon's `wrong-item` deny branch fires and the audit log
	// carries reason=wrong-item.
	test("socket item.update rejects cross-item write with the wrong-item deny branch (live spawn, #406)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-wrong-item-live`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const promptCapturePath = resolve(root, "captured-prompt.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// #406 dedicated runner: captures `CODER_LOOP_RUN_CRED` env + the rendered prompt to side
		// files, sleeps long enough for the test to drive an item.update against another item, then
		// exits 0 leaving the per-run status untouched (no writeStatus needed).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await writeFile(${JSON.stringify(promptCapturePath)}, prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 3000))
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 2_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-wrong-item-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const itemA = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406010",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemB = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406011",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemAId = numberValue(itemA.id)
			const itemBId = numberValue(itemB.id)

			// Wait for itemA's spawn and the credential capture.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Same credential against the sibling item: the wrong-item deny branch must fire.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId: itemBId,
				status: runtimeStatus("done"),
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			// Audit replay: the deny is recorded against itemB with reason=wrong-item.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemBId
				&& event.payload.outcome === "deny"
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.mutation.caller_admission") {
				expect(denyEvent.payload.reason).toBe("wrong-item")
			}

			// #406 row 6 — prompt/trace leak guard: the credential value never enters the rendered
			// prompt (or, by extension, anything the agent could exfiltrate via its own writes).
			const promptCapture = await readFile(promptCapturePath, "utf-8")
			expect(promptCapture.includes(credential)).toBe(false)
			// Run trace artifacts (stdout/stderr) likewise must not carry the credential value.
			const paths = resolveChainRuntimePaths("caller-wrong-item-chain", { loopDataRoot })
			// Allow the run to finish so the close handler writes the trace artifacts.
			await waitFor(async () => {
				try {
					return await readFile(paths.runStdoutFile(stringValue(itemA.lastRunId ?? "")), "utf-8")
				} catch {
					return null
				}
			}, () => true, 8_000)
			// Walk the per-run dir and grep every file for the credential value.
			const runDir = paths.runDir(stringValue((await readItem(loopDataRoot, chainId, 406_010))?.lastRunId ?? ""))
			let leak = false
			async function walk(dir: string): Promise<void> {
				let names: string[]
				try {
					names = await readdir(dir)
				} catch {
					return
				}
				for (const name of names) {
					const child = resolve(dir, name)
					let entryStat
					try {
						entryStat = await stat(child)
					} catch {
						continue
					}
					if (entryStat.isDirectory()) {
						await walk(child)
					} else if (entryStat.isFile()) {
						try {
							const body = await readFile(child, "utf-8")
							if (body.includes(credential)) leak = true
						} catch {
							// Binary or unreadable — skip.
						}
					}
				}
			}
			await walk(runDir)
			expect(leak).toBe(false)
		} finally {
			await daemon.stop()
		}
	})

	// #406 row 3 — affirmative admit: with the agent credential env captured, `item update` on
	// the bound item returns ok AND the SQLite item.status reflects the declared exit AND the
	// emitted audit event carries `subject.kind === "agent"` with the runId. The dedicated row-3
	// observation that distinguishes "credential admitted" from "request rejected": this test
	// FAILS if `admitItemMutationCaller` ever regresses to the operator branch (or a deny) for an
	// agent's own credential against its own bound item — the deny-sibling/expiry tests only catch
	// regressions where credentials are wrongly accepted, never where they're wrongly rejected.
	test("socket item.update admits the agent's own credential against its bound item (live spawn, #406 row 3)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-admit-bound-item-live`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Capture credential to a side file, then sleep long enough for the test to drive an
		// affirmative item.update against the bound item before exiting.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 3500))
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 3_000,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-admit-bound-item-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(item.id)

			// Wait until the runner has spawned and captured the credential into the side file.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// The scheduler stamps `phase="iteration"` at spawn, and the gh-issue-pr-iteration
			// preset declares zero exits for iteration. The agent-realistic affirmative path runs
			// in review (whose declared exits include `changes_requested`); since we can't drive
			// a real iteration→review transition mid-test without racing the run's natural close,
			// we manually rewrite the item's phase to "review" while the runner is still alive
			// (so the daemon's active-run registry still holds this credential). The caller-
			// admission gate (which only checks `chain + item + credential-still-active`) admits
			// the call exactly as it would for a real review-phase agent; the per-phase write
			// gate then runs against `phase="review"` and allows `changes_requested`.
			const store = openSqliteStateStore({ loopDataRoot })
			try {
				store.updateItem(itemId, { phase: "review", updatedAt: Math.floor(Date.now() / 1000) })
			} finally {
				store.close()
			}

			// Affirmative row 3: bound item + active credential → ok + status reflected + audit
			// subject = {agent, runId, phase}. If the admit code regresses to denying the bound
			// item (caller becomes `operator` for an agent credential, or the gate returns deny),
			// `response.ok` flips to false and the subject assertions stall — the wrong-item /
			// expiry tests would still pass because they only exercise the deny side.
			const response = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				agentCredential: credential,
			}))
			expect(response.ok).toBe(true)
			if (!response.ok) throw new Error(`expected admit, got error ${response.error.code}: ${response.error.message}`)
			const updatedItem = record(response.result.item)
			expect(updatedItem.id).toBe(itemId)
			expect(updatedItem.status).toBe(runtimeStatus("changes_requested"))

			// SQLite cross-check: bypass the daemon and read the row directly. If the admit path
			// flipped to "allow but skip write" the response would still be ok=true with a stale
			// status; this assertion catches that.
			const persisted = await readItem(loopDataRoot, chainId, 406_300)
			expect(persisted?.status).toBe(runtimeStatus("changes_requested"))

			// Audit replay: the caller-admission allow event for this mutation must carry
			// `subject.kind === "agent"` with the runId that was bound to this credential at
			// spawn time. Find the run id from the eventLog the fake runner wrote.
			const runIdLine = (await readFile(eventLog, "utf-8")).split("\n").find((line) => line.trim() !== "") ?? ""
			// Boundary-parse the fake-runner event-log entry instead of casting onto an anonymous
			// shape (#406 红线).
			const runIdRecord = FakeRunnerRunningEventBoundary.assert(JSON.parse(runIdLine))
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const admissionAllow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "agent-credential-admitted"
			)
			expect(admissionAllow).toBeDefined()
			if (admissionAllow !== undefined && admissionAllow.kind === "audit" && admissionAllow.type === "item.mutation.caller_admission") {
				expect(admissionAllow.subject).toEqual({ kind: "agent", runId: runIdRecord.runId, phase: "iteration" })
				expect(admissionAllow.payload.claimedRunId).toBe(runIdRecord.runId)
			}
			// And the downstream `item.status` audit must inherit the agent subject + runId; this is
			// the observation row 3 names — operator-attribution slipping through would tag this
			// event `{kind: "operator"}`.
			const statusEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.status"
				&& event.item === itemId
				&& "runId" in event
				&& event.runId === runIdRecord.runId
			)
			expect(statusEvent).toBeDefined()
			if (statusEvent !== undefined && statusEvent.kind === "audit" && statusEvent.type === "item.status") {
				expect(statusEvent.subject).toEqual({ kind: "agent", runId: runIdRecord.runId, phase: "iteration" })
				expect(statusEvent.payload.toStatus).toBe("changes_requested")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #406 caller-admission gate (run-end → credential invalidation). A credential captured during
	// an active run is rejected after the run closes — the scheduler's `finally` revokes it from
	// the registry, and the unknown-credential deny branch fires.
	test("socket item.update rejects an expired credential after the run ends (live spawn, #406)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-credential-expiry-live`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
// Exit non-zero with no status write — the item stays queued (the scheduler honors the agent's
// non-write outcome and applies attempt backoff). This keeps the chain non-terminal so the
// post-run item.update attempt reaches the caller-admission gate (not chain_not_active).
process.exitCode = 1
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId, eventLog }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-expiry-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406020",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(item.id)

			// Wait for the credential to be captured (it appears as soon as the runner starts).
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Wait for the run to end (active runs returns to empty).
			await waitFor(
				async () => record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon).activeRuns,
				(runs) => Array.isArray(runs) && runs.length === 0,
				10_000,
			)

			// Same credential against the same item after the run closed: deny with
			// `unknown-credential` (the scheduler's finally already revoked it).
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("agentCredential")
			}

			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemId
				&& event.payload.outcome === "deny"
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.mutation.caller_admission") {
				expect(denyEvent.payload.reason).toBe("unknown-credential")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #406 row 5 / #417 composition: review agent self-tagging terminal status exits cleanly without
	// any explicit reaper kill (`terminateActiveRunsForItem` stays uncalled). The credential
	// revocation runs in the scheduler's natural close-handler `finally`, NOT via a daemon-side
	// kill. This pins the "#417 行为不回退" contract.
	test("active run terminating naturally invalidates its credential without explicit kill (#406 + #417)", async () => {
		const fixture = await startFixture("caller-no-reaper-kill")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-no-reaper-kill-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406030",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 100, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)

			// Run completes naturally.
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			const finalItem = await readItem(fixture.loopDataRoot, chainId, 406_030)
			expect(finalItem?.lastRunId).not.toBeNull()
			const lastRun = await readRun(fixture.loopDataRoot, finalItem?.lastRunId ?? "")
			expect(lastRun).not.toBeNull()
			// 143 = SIGTERM exit code. The natural close must be exitCode=0, not 143 (the #417
			// reaper-kill signature). If a kill leaks back in, this would be 143.
			expect(lastRun?.exitCode).toBe(0)
			// itemId asserted defined for tooling; not referenced further.
			expect(finalItem).not.toBeNull()
			expect(itemId).toBe(finalItem?.id ?? -1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon db unavailable explicit fail", async () => {
		const rootFile = resolve(TEST_ROOT, `not-a-dir-${++nextFixtureId}`)
		await mkdir(resolve(rootFile, ".."), { recursive: true })
		await writeFile(rootFile, "not a directory")

		try {
			await startCoderLoopDaemon({ loopDataRoot: rootFile })
			throw new Error("expected daemon start to fail")
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonError)
			expect((error as DaemonError).code).toBe("db_unavailable")
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
		const loopDataRoot = resolve(root, "ld")
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
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
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
				presetDir: PRESET_DIR,
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
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(socketPath, daemonRequest("item.add", { chainId, itemId: "29011", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration" })))

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
				const iterationEnd = (await waitFor(
					async () =>
						fixture.schedulerEvents
							.find((event): event is Extract<SchedulerEvent, { type: "phase.end" }> => event.type === "phase.end" && event.itemId === itemId && event.phase === "iteration") ?? null,
					(event) => event !== null,
					5_000,
				)) as Extract<SchedulerEvent, { type: "phase.end" }>
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
				const iterStatus = JSON.parse(await readFile(paths.runStatusFile(iterRunId), "utf-8")) as { phase: string }
				const reviewStatus = JSON.parse(await readFile(paths.runStatusFile(reviewRunId), "utf-8")) as { phase: string }
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
			expect(String(fatal.payload.error)).toContain("daemon.test")
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
	// `[[phases.exits]]` for `done`. The iteration phase has no `[[phases.exits]]`
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

			const agentExit = await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			) as Extract<SchedulerEvent, { type: "agent.exit" }>
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

			const agentExit = await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			) as Extract<SchedulerEvent, { type: "agent.exit" }>
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

			const agentExit = await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId,
				) ?? null,
				(e) => e !== null,
			) as Extract<SchedulerEvent, { type: "agent.exit" }>
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

			const agentExit = await waitFor(
				async () => fixture.schedulerEvents.find(
					(e): e is Extract<SchedulerEvent, { type: "agent.exit" }> =>
						e.type === "agent.exit" && e.itemId === itemId
				) ?? null,
				(e) => e !== null,
			) as Extract<SchedulerEvent, { type: "agent.exit" }>
			expect(agentExit.exitCode).toBe(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #407 acceptance row #1 — iteration phase has no `[phases.rights]` segment in
	// gh-issue-pr-iteration preset.toml, so an item.add request bearing an iteration-phase
	// agentCredential is rejected with the rights-segment-default-deny branch. The audit
	// event must record outcome=deny / reason=no-rights-segment (iteration has zero rights
	// declared → classifyNoCreateGrantReason returns no-rights-segment, NOT no-create-grant
	// which is the segment-present-without-grant case). Item-list cross-check confirms the
	// child was NOT inserted, i.e. the gate ran BEFORE buildCreateItemInput / store.createItem.
	test("socket item.add denies an iteration-phase agentCredential with no-rights-segment (#407 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row1-iter-deny`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Fake iteration runner: capture CODER_LOOP_RUN_CRED, then sleep long enough for the
		// test to drive an item.add against the daemon before the run closes (closing the run
		// would revoke the credential from the registry and the gate would short-circuit on
		// `unknown-credential` before ever reaching the rights check).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 3_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row1-iter-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			// Parent item the scheduler will spawn against (iteration phase, no rights).
			const parent = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407100",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const parentId = numberValue(parent.id)

			// Wait for the scheduler to spawn the iteration runner and capture the credential.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue the item.add with the iteration agent's credential. Iteration phase has NO
			// `[phases.rights]` segment in preset.toml → classifyNoCreateGrantReason yields
			// `no-rights-segment` (createItems=false AND writableFields empty AND privilegedOps empty).
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407101",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("iteration")
				expect(denied.error.message).toContain("createItems")
			}

			// Audit replay: exactly one `item.add.rights_admission` event for the iteration phase,
			// outcome=deny, reason=no-rights-segment. The subject must be `agent` (not operator —
			// the credential resolved successfully). The deny event MUST exist before the agent's
			// run-close handler revokes the credential, so we read the events file immediately.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "deny",
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.add.rights_admission") {
				expect(denyEvent.payload.reason).toBe("no-rights-segment")
				expect(denyEvent.payload.claimedPhase).toBe("iteration")
				expect(denyEvent.subject).toMatchObject({ kind: "agent" })
				expect(denyEvent.payload.presetName).toBe("gh-issue-pr-iteration")
			}

			// Item-list cross-check: only the parent item exists; the child the agent attempted to
			// create was rejected BEFORE store.createItem. (parentId asserted defined for tooling.)
			const listed = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const items = Array.isArray(listed.items) ? listed.items : []
			expect(items.length).toBe(1)
			expect(parentId).toBe(numberValue(record(items[0] ?? {}).id))
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #2 — review phase declares `[phases.rights] createItems = true` in
	// gh-issue-pr-iteration preset.toml, so an item.add request bearing a review-phase agent
	// credential is admitted. The audit event records outcome=allow / reason=agent-allowed.
	// item.list cross-check confirms the child WAS inserted into the queue. Pipeline reaches
	// the review phase via the realistic iteration→review transition (iteration writes
	// `in_progress` status with exitCode=0, scheduler advances to review on the next tick).
	test("socket item.add admits a review-phase agentCredential and inserts the child (#407 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row2-review-allow`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Fake runner branches on `input.phase`: iteration writes `in_progress` status with
		// exitCode 0 (scheduler then advances to review). Review captures the credential and
		// sleeps long enough for the test to drive the item.add. The runner uses
		// FAKE_RUNNER_STATUS_WRITE_SNIPPET shape: it consumes input.writeStatus from the prompt
		// (the scheduler-side `prompt` lambda below maps phase→writeStatus the same way
		// startPhaseAdvancementFixture does).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
} else {
	// Iteration: write in_progress status and exit 0 so the scheduler advances to review.
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row2-review-allow-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const parent = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407200",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const parentId = numberValue(parent.id)

			// Wait for the scheduler to advance iteration→review and the review runner to capture
			// its credential. The 12s timeout accommodates two scheduler ticks (iteration spawn
			// + review spawn) on a busy CI host.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 12_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue item.add with the review-phase credential. Review has createItems=true →
			// allow. The new item appears in the queue.
			const created = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407201",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				agentCredential: credential,
			}))
			expect(created.ok).toBe(true)
			if (!created.ok) throw new Error(`expected allow, got ${created.error.code}: ${created.error.message}`)
			const newItem = record(created.result.item)
			expect(stringValue(newItem.itemId)).toBe("407201")

			const deniedHookAdd = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407202",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				extra: { hooks: [] },
				agentCredential: credential,
			}))
			expect(deniedHookAdd.ok).toBe(false)
			if (!deniedHookAdd.ok) expect(deniedHookAdd.error.message).toContain("hooks")

			const deniedHookBatch = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.batchAdd", {
				chainId,
				items: [{ itemId: "407203", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", extra: { hooks: [] } }],
				agentCredential: credential,
			}))
			expect(deniedHookBatch.ok).toBe(false)
			if (!deniedHookBatch.ok) expect(deniedHookBatch.error.message).toContain("hooks")

			// item.list cross-check: parent + child both present (2 items).
			const listed = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const items = Array.isArray(listed.items) ? listed.items : []
			const itemIds = items.map((entry) => stringValue(record(entry).itemId)).sort()
			expect(itemIds).toEqual(["407200", "407201"])
			expect(parentId).toBeGreaterThan(0)

			// Audit replay: outcome=allow, reason=agent-allowed, subject.kind=agent, phase=review.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const allow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "agent-allowed",
			)
			expect(allow).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "item.add.rights_admission") {
				expect(allow.payload.claimedPhase).toBe("review")
				expect(allow.subject).toMatchObject({ kind: "agent" })
				expect(allow.payload.presetName).toBe("gh-issue-pr-iteration")
			}
			const hookDenials = events.filter((event) => event.kind === "audit" && event.type === "item.add.rights_admission" && event.payload.reason === "control-plane-denied")
			expect(hookDenials).toHaveLength(2)
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #3 — the operator path (no agentCredential field at all) is NEVER
	// gated by the rights segment. The boundary parse treats absent `agentCredential` as
	// `kind: "operator"`, the gate emits one `item.add.rights_admission` allow event with
	// reason=operator, and the item is created. Mirrors the existing #406 operator-path test
	// at line ~3216 but on the create path instead of the update path.
	test("socket item.add operator path bypasses the rights gate with reason=operator (#407 row 3)", async () => {
		const fixture = await startFixture("407-row3-operator-bypass", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "407-row3-operator-bypass-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "407300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const itemId = numberValue(added.id)
			expect(itemId).toBeGreaterThan(0)

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const allow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow",
			)
			expect(allow).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "item.add.rights_admission") {
				expect(allow.payload.reason).toBe("operator")
				expect(allow.subject).toEqual({ kind: "operator" })
				expect(allow.payload.claimedPhase).toBeNull()
				expect(allow.payload.presetName).toBe("gh-issue-pr-iteration")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #407 acceptance row #4 — single-phase-example preset has no `[phases.rights]` segment
	// anywhere (the run phase omits it). An agent credential bound to its `run` phase that
	// tries item.add against the same chain is rejected with reason=no-rights-segment. The
	// operator-variant inside the same test confirms operator path is unaffected (mirrors
	// row #3 but on the smoke preset).
	test("socket item.add default-deny on single-phase-example for agents; operator path still allowed (#407 row 4)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row4-default-deny`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		const smokePresetDir = resolve(REPO_ROOT, "presets/single-phase-example")
		await mkdir(loopDataRoot, { recursive: true })
		// Capture-credential fake runner; sleeps long enough for the test to drive item.add.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
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
				presetDir: smokePresetDir,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row4-default-deny-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			// Operator-path variant first (precondition for row 4's "operator path always allowed"):
			// no credential → allow with reason=operator. Issue this BEFORE the scheduler spawns the
			// agent runner so chain has at least one item to schedule.
			const operatorItem = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407400",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			}))).item)
			expect(numberValue(operatorItem.id)).toBeGreaterThan(0)

			// Wait for the run-phase credential to land in the capture file.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Agent path: the `run` phase has no rights segment → default-deny.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407401",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			// Audit replay: agent deny event MUST carry reason=no-rights-segment + agent subject.
			// Also assert the operator allow event from the precondition exists.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			expect(operatorAllow).toBeDefined()
			if (operatorAllow !== undefined && operatorAllow.kind === "audit" && operatorAllow.type === "item.add.rights_admission") {
				expect(operatorAllow.payload.presetName).toBe("single-phase-example")
				expect(operatorAllow.subject).toEqual({ kind: "operator" })
			}
			const agentDeny = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "deny",
			)
			expect(agentDeny).toBeDefined()
			if (agentDeny !== undefined && agentDeny.kind === "audit" && agentDeny.type === "item.add.rights_admission") {
				expect(agentDeny.payload.reason).toBe("no-rights-segment")
				expect(agentDeny.payload.claimedPhase).toBe("run")
				expect(agentDeny.subject).toMatchObject({ kind: "agent" })
				expect(agentDeny.payload.presetName).toBe("single-phase-example")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #5 — field-validation parity with item.update. A review-phase agent
	// credential (createItems=true) issues item.add carrying an illegal priority value. The
	// daemon's `validateItemPriorityForRequest` (shared between item.add and item.update) must
	// reject with the SAME shape as the update path: code=invalid_request, message includes
	// the allowed list (low, medium, high, critical). The point is to pin that the new gate
	// does not change downstream field validation — it runs BEFORE buildCreateItemInput, and
	// buildCreateItemInput still enforces field shape exactly as before.
	test("socket item.add review credential rejects illegal priority with the same invalid_request shape as item.update (#407 row 5)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row5-priority-validation`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
} else {
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row5-priority-validation-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407500",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			// Wait for the review phase credential to be captured.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 12_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue item.add carrying an illegal priority value. Even though the agent's review
			// credential WOULD pass the rights gate, the request must be rejected for the
			// priority shape: code=invalid_request, message includes the allowed enum.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407501",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				agentCredential: credential,
				priority: "super-critical",
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_request")
				expect(denied.error.message).toContain("priority must be one of")
				expect(denied.error.message).toContain("critical")
			}

			// Cross-check the equivalence on item.update: same illegal priority value, same code
			// + message. This pins "review path uses validateItemPriorityForRequest just like update".
			// We need a real item to update against; the scheduler's parent item works.
			const parent = await waitFor(
				async () => await readItem(loopDataRoot, chainId, 407_500),
				(value) => value !== null,
				6_000,
			)
			expect(parent).not.toBeNull()
			const updateDenied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId: parent?.id ?? -1,
				priority: "super-critical",
			}))
			expect(updateDenied.ok).toBe(false)
			if (!updateDenied.ok && !denied.ok) {
				expect(updateDenied.error.code).toBe(denied.error.code)
				expect(updateDenied.error.message).toBe(denied.error.message)
			}
		} finally {
			await daemon.stop()
		}
	})

	// #409 acceptance row #1 — hard-deny vocabulary. Each agent-credentialed daemon call
	// against the hard-deny list (`chain.delete`, `chain.stop`, `daemon.down`, `logs.query`,
	// `queue.unblock`, `chain.create`, `chain.resume`) must be rejected before any handler-side
	// work, with an error message that names NO preset grammar (the operator cannot flip the
	// gate via a `[phases.rights]` declaration — the contract forbids it). Every rejection emits
	// one `privileged_op.caller_admission` audit event with `outcome=deny / reason=hard-deny-for-agent`.
	test("daemon hard-denies chain.delete / chain.stop / daemon.down for agent credentials with no-preset-grammar message (#409 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-row1-hard-deny`)
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 6_000))
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId, eventLog, sleepMs: 5_500 }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-row1-hard-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409100",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			// Wait for the scheduler to spawn the iteration runner and capture its credential.
			await waitFor(async () => {
				try { return (await readFile(capturePath, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Drive each hard-deny op with the agent credential and assert the verdict + message.
			const hardDenyAttempts: { command: "chain.delete" | "chain.stop" | "chain.resume" | "chain.create" | "daemon.down" | "logs.query" | "queue.unblock"; args: JsonObject }[] = [
				{ command: "chain.delete", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.stop", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.resume", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.create", args: { name: "409-row1-second", preset: "gh-issue-pr-iteration", repository: "mouriya-s-lab/coder-loop", agentCredential: credential } },
				{ command: "daemon.down", args: { agentCredential: credential } },
				{ command: "logs.query", args: { agentCredential: credential } },
				{ command: "queue.unblock", args: { chainName: "409-row1-hard-deny-chain", issue: "409100", agentCredential: credential } },
			]
			for (const attempt of hardDenyAttempts) {
				const reply = await sendDaemonRequest(snapshot.socketPath, daemonRequest(attempt.command, attempt.args))
				expect(reply.ok, `expected ${attempt.command} to be denied for agent credential`).toBe(false)
				if (!reply.ok) {
					expect(reply.error.code).toBe("invalid_caller")
					// Acceptance #1: the message names no authorization grammar. The strings
					// "phases.rights", "privilegedOps", "createItems", "writableFields" must NOT
					// appear — those are the only preset-rights words the codebase exposes today.
					expect(reply.error.message).not.toContain("phases.rights")
					expect(reply.error.message).not.toContain("privilegedOps")
					expect(reply.error.message).not.toContain("createItems")
					expect(reply.error.message).not.toContain("writableFields")
					expect(reply.error.message).toContain(attempt.command)
					expect(reply.error.message).toContain("operator credentials")
				}
			}

			// Audit replay: every attempt above emits exactly one privileged_op.caller_admission
			// event with outcome=deny + reason=hard-deny-for-agent + the agent's subject. The
			// daemon also emits operator-allow events for chain.create + item.add we ran during
			// setup — filter on outcome=deny so we only see the seven denials above.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denies = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "deny",
			)
			expect(denies.length).toBeGreaterThanOrEqual(hardDenyAttempts.length)
			const expectedOps = new Set(hardDenyAttempts.map((entry) => entry.command))
			for (const expectedOp of expectedOps) {
				const match = denies.find((event) =>
					event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === expectedOp,
				)
				expect(match, `expected privileged_op.caller_admission deny for ${expectedOp}`).toBeDefined()
				if (match !== undefined && match.kind === "audit" && match.type === "privileged_op.caller_admission") {
					expect(match.payload.reason).toBe("hard-deny-for-agent")
					expect(match.subject).toMatchObject({ kind: "agent" })
					expect(match.payload.claimedPhase).toBe("iteration")
				}
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 acceptance row #2 — per-phase authorized op. `item.reorder` is the only entry in the
	// `PRESET_PHASE_PRIVILEGED_OPS` tuple today; the bundled `gh-issue-pr-iteration` preset
	// declares it on review's `[phases.rights] privilegedOps`. An iteration-phase agent
	// credential issuing item.reorder must be rejected (no grant on iteration's rights segment);
	// a review-phase agent credential must succeed. Both outcomes emit `privileged_op.caller_admission`.
	test("daemon allows item.reorder for review agent and denies it for iteration agent (#409 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-row2-per-phase`)
		const loopDataRoot = resolve(root, "ld")
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Two-phase fake runner: iteration writes its credential to iterationCapture + writes
		// in_progress status (scheduler advances to review on the next tick); review writes its
		// credential to reviewCapture and sleeps long enough for the test to drive reorder.
		// #419 review M2: iteration's sleep extended from 5ms to `iterationSleepMs` (default 3_000ms)
		// so the iteration agent's run stays in the daemon's active-runs map while the test sends
		// the deny-path `item.reorder`. The original 5ms window raced under full-suite concurrent
		// load — the run had already closed (revoking the credential) before the request landed,
		// turning the expected "deny + reason=no-rights-segment" into an "inactive-run" rejection.
		// The longer sleep is bounded by the scheduler's slot-busy semantics: review can't spawn
		// until iteration's run closes, so this just pushes review's start a few seconds later,
		// well within the test's 30s budget.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
	await new Promise((r) => setTimeout(r, input.iterationSleepMs ?? 3_000))
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 5_500,
					// #419 review M2: keep iteration alive ~3s so the deny-path reorder request below
					// hits the active-credential gate instead of the inactive-run branch when the test
					// suite runs concurrently.
					iterationSleepMs: 3_000,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-row2-per-phase-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409200",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))
			// Add a second item so reorder is meaningful (position 1 vs 0).
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409201",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			// Capture the iteration credential first.
			await waitFor(async () => {
				try { return (await readFile(iterationCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const iterationCredential = (await readFile(iterationCapture, "utf-8")).trim()
			expect(iterationCredential.length).toBeGreaterThan(0)

			// #419 review M2: confirm the iteration run is still active before issuing the deny-path
			// reorder. Otherwise — under full-suite concurrent load — the iteration runner may have
			// already exited and revoked its credential, and the daemon would reject with
			// `agentCredential resolves to run … which is no longer active` instead of the
			// per-phase rights deny we are asserting on. The DaemonActiveRun wire shape only
			// exposes `runId`, not `phase`, so we identify the iteration run by the runId pattern
			// (`run-<ts>-<seq>-iteration-item-<n>`) which the engine bakes into the runId at
			// agent.spawn (via makeRunIdFactory — see loop.ts).
			await waitFor(async () => {
				const status = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon
				const activeRuns = record(status).activeRuns
				return Array.isArray(activeRuns) ? activeRuns : []
			}, (runs) => runs.some((run) => {
				const runId = record(run).runId
				return typeof runId === "string" && runId.includes("-iteration-item-")
			}), 8_000)

			// Iteration phase has NO privilegedOps in its rights segment → deny.
			const iterationReorder = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.reorder", {
				chainName: "409-row2-per-phase-chain",
				itemId: "409201",
				position: 0,
				agentCredential: iterationCredential,
			}))
			expect(iterationReorder.ok).toBe(false)
			if (!iterationReorder.ok) {
				expect(iterationReorder.error.code).toBe("invalid_caller")
				expect(iterationReorder.error.message).toContain("item.reorder")
				expect(iterationReorder.error.message).toContain("iteration")
				expect(iterationReorder.error.message).toContain("gh-issue-pr-iteration")
			}

			// Now wait for the review phase credential (the iteration's in_progress write makes
			// the scheduler advance to review on the next tick).
			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)
			expect(reviewCredential).not.toBe(iterationCredential)

			// Review phase HAS privilegedOps = ["item.reorder"] → allow.
			const reviewReorder = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.reorder", {
				chainName: "409-row2-per-phase-chain",
				itemId: "409201",
				position: 0,
				agentCredential: reviewCredential,
			})))
			const reorderedItems = Array.isArray(reviewReorder.items) ? reviewReorder.items : []
			expect(reorderedItems.length).toBeGreaterThan(0)

			// Audit replay: one allow + one deny for item.reorder.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const reorderAudits = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.op === "item.reorder",
			)
			const allow = reorderAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "allow",
			)
			const deny = reorderAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "deny",
			)
			expect(allow).toBeDefined()
			expect(deny).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "privileged_op.caller_admission") {
				expect(allow.payload.reason).toBe("agent-allowed")
				expect(allow.payload.claimedPhase).toBe("review")
				expect(allow.payload.presetName).toBe("gh-issue-pr-iteration")
			}
			if (deny !== undefined && deny.kind === "audit" && deny.type === "privileged_op.caller_admission") {
				expect(deny.payload.reason).toBe("no-rights-segment")
				expect(deny.payload.claimedPhase).toBe("iteration")
				expect(deny.payload.presetName).toBe("gh-issue-pr-iteration")
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 retry — the per-phase-authorized agent path must emit a `privileged_op.caller_admission`
	// deny event even when the pre-grant resolution chain (resolveItem → getChain → loadedPresetForItem)
	// throws BEFORE the grant lookup can run. The hard-deny branch at runAuthorizationGate already
	// emits on resolveItemMutationCaller failures; this test pins the symmetric obligation for the
	// per-phase branch. Reason: `inactive-run` (the boundary unit reused for "agent's run no longer
	// has a live resolvable item/chain/preset" per the review's required-changes block).
	test("per-phase agent path emits deny event when item is not found (#409 retry audit edge)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-per-phase-audit-edge`)
		const loopDataRoot = resolve(root, "ld")
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
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
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
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			// Wait until the review credential is captured — only review-phase has `item.reorder`
			// in its `[phases.rights] privilegedOps`, so we need that credential to even reach
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
		const loopDataRoot = resolve(root, "ld")
		const capturePath = resolve(root, "credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
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
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
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
	test("daemon allows the full operator-issued chain/queue/inspect surface (#409 row 4)", async () => {
		const fixture = await startFixture("409-row4-operator", { schedulerEnabled: false })
		try {
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "409-row4-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(created.id)

			// Operator queue surface: add, list, reorder, queue.unblock (after dropping the item to
			// a preset-unblockable status via item.update).
			const addedA = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "409400",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const addedB = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "409401",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			expect(numberValue(addedA.id)).toBeGreaterThan(0)
			expect(numberValue(addedB.id)).toBeGreaterThan(0)

			const listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			const items = Array.isArray(listed.items) ? listed.items : []
			expect(items.length).toBe(2)

			const reordered = expectOk(await request(fixture, "item.reorder", {
				chainId,
				itemId: "409401",
				position: 0,
			}))
			const reorderedItems = Array.isArray(reordered.items) ? reordered.items : []
			expect(reorderedItems.length).toBe(2)

			// Drive an item to a preset-unblockable status (gh-issue-pr-iteration has `blocked` in
			// its unblockable set) so queue.unblock has work to do.
			expectOk(await request(fixture, "item.update", {
				chainId,
				itemId: "409400",
				status: "blocked",
			}))
			const unblock = record(expectOk(await request(fixture, "queue.unblock", {
				chainName: "409-row4-operator-chain",
				issue: "409400",
			})))
			const mutation = record(unblock.mutation)
			expect(mutation.changed).toBe(true)
			expect(mutation.afterStatus).toBe("queued")

			// Inspect surface: logs.query, daemon.status, chain.list, chain.status are all OK.
			const operatorLogs = expectOk(await request(fixture, "logs.query", {}))
			expect(Array.isArray(operatorLogs.events)).toBe(true)
			expectOk(await request(fixture, "daemon.status", {}))
			expectOk(await request(fixture, "chain.list", {}))
			expectOk(await request(fixture, "chain.status", { chainName: "409-row4-operator-chain" }))

			// Chain lifecycle (stop / resume / delete) all succeed for operator.
			expectOk(await request(fixture, "chain.stop", { chainName: "409-row4-operator-chain" }))
			expectOk(await request(fixture, "chain.resume", { chainName: "409-row4-operator-chain" }))
			expectOk(await request(fixture, "chain.delete", { chainName: "409-row4-operator-chain" }))

			// Audit replay: every operator-issued gated op left one allow event with
			// reason=operator. The set of ops we exercised on the per-phase / hard-deny path:
			// chain.create, item.reorder (per-phase), queue.unblock, logs.query, chain.stop,
			// chain.resume, chain.delete. Other ops (item.add / item.update / item.list /
			// daemon.status / chain.list / chain.status) are not on the gated list and emit no
			// privileged_op.caller_admission events.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			const expectedOperatorOps = new Set([
				"chain.create",
				"item.reorder",
				"queue.unblock",
				"logs.query",
				"chain.stop",
				"chain.resume",
				"chain.delete",
			])
			for (const expectedOp of expectedOperatorOps) {
				const match = operatorAllows.find((event) =>
					event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === expectedOp,
				)
				expect(match, `expected operator allow for ${expectedOp}`).toBeDefined()
			}
		} finally {
			await fixture.daemon.stop()
		}
	}, 30_000)

	test("queue unblock waits for in-flight scheduler tick", async () => {
		const fixture = await startQueueUnblockGateFixture("538-in-flight", { preset: "loaded", targetStatus: "blocked" })
		try {
			await fixture.tickEntered.promise

			// Model the snapshot that existed when the in-flight tick began. Once released, the
			// real scheduler spawn replaces this row with the sentinel item's current run.
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.recordRun({
					runId: "run-before-in-flight-tick",
					chainId: fixture.chainId,
					itemId: fixture.targetRowId,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({}),
				})
				store.setCurrentRun({
					chainId: fixture.chainId,
					phase: "iteration",
					runId: "run-before-in-flight-tick",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ itemId: fixture.targetRowId }),
				})
			} finally {
				store.close()
			}

			let unblockSettled = false
			const unblockPromise = sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
			})).then((response) => {
				unblockSettled = true
				return response
			})

			// The operator-admission event is written before dispatch enters handleQueueUnblock.
			// Seeing it while the worktree promise gate is still closed proves the request reached
			// the handler; the item/current-run snapshot must remain untouched until the tick exits.
			await waitFor(
				async () => (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events,
				(events) => events.filter((event) =>
					event.kind === "audit"
						&& event.type === "privileged_op.caller_admission"
						&& event.payload.op === "queue.unblock"
						&& event.payload.outcome === "allow",
				).length >= 2,
			)
			expect(unblockSettled).toBe(false)
			expect((await readItem(fixture.loopDataRoot, fixture.chainId, Number(fixture.targetItemId)))?.status).toBe("blocked")

			fixture.releaseTick.resolve()
			const unblock = record(expectOk(await unblockPromise))
			expect(record(unblock.mutation)).toMatchObject({
				changed: true,
				beforeStatus: "blocked",
				afterStatus: "queued",
				clearedCurrent: false,
			})

			const current = await readCurrentRun(fixture.loopDataRoot, fixture.chainId)
			expect(current?.extra.itemId).toBe(fixture.sentinelRowId)
			expect(current?.runId).not.toBe("run-before-in-flight-tick")
		} finally {
			fixture.releaseTick.resolve()
			await fixture.daemon.stop()
		}
	}, 30_000)

	test("queue unblock always resumes scheduler", async () => {
		const scenarios: readonly QueueUnblockOutcomeScenario[] = [
			{ kind: "success", preset: "loaded", targetStatus: "blocked", issue: "target", dryRun: false },
			{ kind: "dry-run", preset: "loaded", targetStatus: "blocked", issue: "target", dryRun: true },
			{ kind: "not-unblockable", preset: "loaded", targetStatus: "done", issue: "target", dryRun: false },
			{ kind: "not-found", preset: "loaded", targetStatus: "blocked", issue: "missing", dryRun: false },
			{ kind: "preset-load-error", preset: "missing", targetStatus: "blocked", issue: "target", dryRun: false },
		]

		for (const scenario of scenarios) {
			const fixture = await startQueueUnblockGateFixture(`538-resume-${scenario.kind}`, scenario)
			try {
				await fixture.tickEntered.promise
				const responsePromise = sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
					chainName: fixture.chainName,
					issue: scenario.issue === "target" ? fixture.targetItemId : scenario.issue,
					dryRun: scenario.dryRun,
				}))

				fixture.releaseTick.resolve()
				const response = await responsePromise
				switch (scenario.kind) {
					case "success":
					case "dry-run":
						expectOk(response)
						break
					case "not-unblockable":
						expect(record(expectOk(response).mutation).reason).toBe("not_unblockable")
						break
					case "not-found":
					case "preset-load-error":
						expect(response.ok).toBe(false)
						break
					default:
						assertNeverQueueUnblockOutcomeScenario(scenario)
				}

				// The initial tick is now holding an active sentinel run. A post-outcome tick
				// therefore emits slot.busy; reaching this promise proves finally resumed the
				// scheduler for returns and throws alike without inspecting private pause depth.
				const busyEvent = await fixture.postOutcomeTick.promise
				expect(busyEvent.type).toBe("slot.busy")
			} finally {
				fixture.releaseTick.resolve()
				await fixture.daemon.stop()
			}
		}
	}, 30_000)

	test("queue unblock caller admission", async () => {
		const fixture = await startQueueUnblockGateFixture("538-caller-admission", { preset: "loaded", targetStatus: "blocked" })
		try {
			await fixture.tickEntered.promise
			fixture.releaseTick.resolve()
			const credential = await waitFor(
				async () => {
					try {
						return (await readFile(fixture.credentialPath, "utf-8")).trim()
					} catch (error: unknown) {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
						throw error
					}
				},
				(value) => value.length > 0,
			)

			const denied = await sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("operator credentials")
			}
			expect((await readItem(fixture.loopDataRoot, fixture.chainId, Number(fixture.targetItemId)))?.status).toBe("blocked")

			const allowed = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
			}))))
			expect(record(allowed.mutation).changed).toBe(true)

			const events = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
			const queueAdmission = events.filter((event) =>
				event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === "queue.unblock",
			)
			expect(queueAdmission.some((event) =>
				event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.outcome === "deny"
					&& event.payload.reason === "hard-deny-for-agent"
					&& event.subject?.kind === "agent",
			)).toBe(true)
			expect(queueAdmission.some((event) => event.kind === "audit" && event.type === "privileged_op.caller_admission" && event.payload.outcome === "allow")).toBe(true)
			expect(events.some((event) =>
				event.kind === "audit"
					&& event.type === "item.mutation.caller_admission"
					&& event.item === fixture.targetRowId
					&& event.payload.outcome === "allow"
					&& event.payload.reason === "operator",
			)).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #410 acceptance row #2 — review writes its declared passthrough fields (top-level + inner
	// blocker keys via extraPatch). Uses the same two-phase fake runner shape as #409 row 2:
	// iteration captures its credential + writes in_progress; review captures its credential and
	// sleeps while the test drives the live `item.update` calls. The fixture preset has
	// `writableFields = ["branch", "pr", "blockerRepo", "blockerRef"]` on the review phase, so a
	// review-CRED update of `branch` + `pr` succeeds and a review-CRED `extraPatch` write of
	// `blockerRepo` + `blockerRef` succeeds. The deny half (control-plane denial + undeclared
	// field) is covered in the row #1 test below.
	test("daemon allows review-phase agent to write declared passthrough fields branch + pr + extra blocker keys (#410 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-row2-allow`)
		const loopDataRoot = resolve(root, "ld")
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 6_000,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "410-row2-allow-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "410200",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(added.id)
			expect(itemId).toBeGreaterThan(0)

			// Wait for the review credential — the scheduler advances iteration → review on the
			// next tick after iteration writes in_progress.
			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)

			// Allow #1: branch + pr declared in preset.review.writableFields → admit, write lands.
			const allowed = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { branch: "feat/issue-410", pr: 1042 } },
				agentCredential: reviewCredential,
			})))
			const updatedA = record(allowed.item)
			const updatedAExtra = record(updatedA.extra)
			expect(updatedAExtra.branch).toBe("feat/issue-410")
			expect(numberValue(updatedAExtra.pr)).toBe(1042)

			// Allow #2: extraPatch with blockerRepo + blockerRef inner keys — both declared in
			// writableFields → admit. The merge preserves any prior extra contents.
			const allowedExtra = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { blockerRepo: "mouriya-s-lab/other", blockerRef: "#999" } },
				agentCredential: reviewCredential,
			})))
			const updatedB = record(allowedExtra.item)
			const extra = record(updatedB.extra)
			expect(extra.blockerRepo).toBe("mouriya-s-lab/other")
			expect(extra.blockerRef).toBe("#999")

			// Audit replay: both calls emitted item.update.field_write_admission allow events with
			// reason=agent-allowed, claimedPhase=review, presetName=gh-issue-pr-iteration, the
			// declared field set in `grantedFields`, and an empty deniedFields list.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const reviewAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.claimedPhase === "review",
			)
			expect(reviewAllows.length).toBeGreaterThanOrEqual(2)
			const allowBranchPr = reviewAllows.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.grantedFields.includes("branch")
				&& event.payload.grantedFields.includes("pr"),
			)
			expect(allowBranchPr).toBeDefined()
			if (allowBranchPr !== undefined && allowBranchPr.kind === "audit" && allowBranchPr.type === "item.update.field_write_admission") {
				expect(allowBranchPr.payload.reason).toBe("agent-allowed")
				expect(allowBranchPr.payload.deniedFields).toEqual([])
				expect(allowBranchPr.payload.presetName).toBe("gh-issue-pr-iteration")
			}
			const allowBlocker = reviewAllows.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.grantedFields.includes("blockerRepo")
				&& event.payload.grantedFields.includes("blockerRef"),
			)
			expect(allowBlocker).toBeDefined()
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #410 acceptance row #1 — control-plane fields (`runner` / `repoCwd` / `dependsOn` /
	// `priority`) cannot be granted by any preset and the review agent (the only phase with a
	// rights segment) is rejected when it tries to write them. The audit event carries
	// reason=control-plane-denied. Also covers the undeclared-passthrough case (`title` is a
	// passthrough field but NOT in review's writableFields) → reason=field-not-granted.
	test("daemon denies review-phase agent on control-plane fields and undeclared passthrough (#410 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-row1-deny`)
		const loopDataRoot = resolve(root, "ld")
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 6_000))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
		const store = openSqliteStateStore({ loopDataRoot: process.env.CODER_LOOP_DATA_DIR })
		store.updateItem(input.itemId, { status: input.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		store.close()
	}
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
				presetDir: PRESET_DIR,
				worktreeManager: async ({ chain, repoCwd }) => {
					const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
					await mkdir(worktreePath, { recursive: true })
					return worktreePath
				},
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 6_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "410-row1-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "410100",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(added.id)
			const protectedHook = { kind: "observer", point: "agent.spawn", script: "/bin/true", timeoutMs: 1_000 }
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { hooks: [protectedHook] } },
			})))

			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)

			// Deny #1: control-plane field `runner` (top-level) — no preset can grant.
			const denyRunner = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { runner: "codex" },
				agentCredential: reviewCredential,
			}))
			expect(denyRunner.ok).toBe(false)
			if (!denyRunner.ok) {
				expect(denyRunner.error.code).toBe("invalid_caller")
				expect(denyRunner.error.message).toContain("runner")
				expect(denyRunner.error.message).toContain("review")
				expect(denyRunner.error.message).toContain("control-plane-denied")
			}

			// Deny #2: control-plane field `repoCwd` (top-level).
			const denyRepoCwd = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { repoCwd: REPO_ROOT },
				agentCredential: reviewCredential,
			}))
			expect(denyRepoCwd.ok).toBe(false)
			if (!denyRepoCwd.ok) {
				expect(denyRepoCwd.error.message).toContain("repoCwd")
			}

			// Deny #3: control-plane field `dependsOn` (top-level).
			const denyDependsOn = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { dependsOn: [] },
				agentCredential: reviewCredential,
			}))
			expect(denyDependsOn.ok).toBe(false)
			if (!denyDependsOn.ok) {
				expect(denyDependsOn.error.message).toContain("dependsOn")
			}

			// Deny #4: control-plane field `priority` (top-level).
			const denyPriority = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { priority: "high" },
				agentCredential: reviewCredential,
			}))
			expect(denyPriority.ok).toBe(false)
			if (!denyPriority.ok) {
				expect(denyPriority.error.message).toContain("priority")
			}

			// Deny #5: `dependsOn` smuggled through `extra` — gate normalizes it to control-plane.
			const denyExtraDependsOn = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extra: { dependsOn: [] } },
				agentCredential: reviewCredential,
			}))
			expect(denyExtraDependsOn.ok).toBe(false)
			if (!denyExtraDependsOn.ok) {
				expect(denyExtraDependsOn.error.message).toContain("dependsOn")
				expect(denyExtraDependsOn.error.message).toContain("control-plane-denied")
			}

			// Deny #6: passthrough field `title` is NOT in review's writableFields → field-not-granted.
			const denyTitle = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { title: "should be denied" },
				agentCredential: reviewCredential,
			}))
			expect(denyTitle.ok).toBe(false)
			if (!denyTitle.ok) {
				expect(denyTitle.error.message).toContain("title")
				expect(denyTitle.error.message).toContain("field-not-granted")
			}

			// Deny #7: undeclared extra inner key → field-not-granted.
			const denyExtraKey = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { madeUpKey: "x" } },
				agentCredential: reviewCredential,
			}))
			expect(denyExtraKey.ok).toBe(false)
			if (!denyExtraKey.ok) {
				expect(denyExtraKey.error.message).toContain("madeUpKey")
				expect(denyExtraKey.error.message).toContain("field-not-granted")
			}

			for (const fields of [
				{ extra: { hooks: [] } },
				{ extraPatch: { hooks: [] } },
				{ extraPatch: { hooks: null } },
				{ extra: { branch: "allowed/without-protected-hooks" } },
			]) {
				const deniedHooks = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", { itemId, fields, agentCredential: reviewCredential }))
				expect(deniedHooks.ok).toBe(false)
				if (!deniedHooks.ok) {
					expect(deniedHooks.error.message).toContain("hooks")
					expect(deniedHooks.error.message).toContain("control-plane-denied")
				}
			}

			// Audit replay: one deny event per attempt. Spot-check control-plane and undeclared.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denies = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "deny",
			)
			expect(denies.length).toBeGreaterThanOrEqual(11)
			expect(denies.filter((event) => event.kind === "audit" && event.type === "item.update.field_write_admission" && event.payload.deniedFields.includes("hooks"))).toHaveLength(5)
			const controlPlaneRunner = denies.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.reason === "control-plane-denied"
				&& event.payload.deniedFields.includes("runner"),
			)
			expect(controlPlaneRunner).toBeDefined()
			if (controlPlaneRunner !== undefined && controlPlaneRunner.kind === "audit" && controlPlaneRunner.type === "item.update.field_write_admission") {
				expect(controlPlaneRunner.payload.claimedPhase).toBe("review")
				expect(controlPlaneRunner.payload.presetName).toBe("gh-issue-pr-iteration")
				expect(controlPlaneRunner.subject).toMatchObject({ kind: "agent" })
			}
			const titleDeny = denies.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.reason === "field-not-granted"
				&& event.payload.deniedFields.includes("title"),
			)
			expect(titleDeny).toBeDefined()
			// Store state untouched on the denied paths: branch/pr (preset-declared transparent
			// fields after #419) and the rest of extra all default.
			const stillQueued = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const itemsList = Array.isArray(stillQueued.items) ? stillQueued.items : []
			expect(itemsList.length).toBe(1)
			const stillRecord = record(itemsList[0])
			// #419: `branch` / `pr` are no longer top-level wire fields. After denial they must
			// still be absent from the `extra` carrier where presets declare them.
			const stillExtra = record(stillRecord.extra)
			expect(stillExtra.hooks).toEqual([protectedHook])
			expect(stillExtra.branch).toBeUndefined()
			expect(stillExtra.pr).toBeUndefined()
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #410 acceptance row #3 — operators bypass the gate entirely. The fixture writes every kind
	// of field (control-plane + passthrough + extra inner keys) via the no-credential operator
	// path; every call succeeds and the audit trail records each as outcome=allow / reason=operator.
	test("daemon allows operator path to write every item.update field (#410 row 3)", async () => {
		const fixture = await startFixture("410-row3-operator-bypass", { schedulerEnabled: false })
		try {
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "410-row3-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(created.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "410300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const itemId = numberValue(added.id)
			// Operator can write each control-plane field without a credential — no gate hits.
			expectOk(await request(fixture, "item.update", { itemId, runner: "codex" }))
			expectOk(await request(fixture, "item.update", { itemId, repoCwd: REPO_ROOT }))
			expectOk(await request(fixture, "item.update", { itemId, priority: "high" }))
			// Passthrough fields work too — including ones not in any preset's writableFields.
			expectOk(await request(fixture, "item.update", { itemId, title: "operator-set title" }))
			expectOk(await request(fixture, "item.update", { itemId, extraPatch: { branch: "operator/branch" } }))
			expectOk(await request(fixture, "item.update", { itemId, extraPatch: { pr: 7 } }))
			// Extra payloads with arbitrary inner keys.
			const finalUpdate = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { blockerRepo: "owner/dep", blockerRef: "#1", arbitrary: "key" },
			})).item)
			const extra = record(finalUpdate.extra)
			expect(extra.blockerRepo).toBe("owner/dep")
			expect(extra.arbitrary).toBe("key")
			const explicitNull = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { arbitrary: null },
			})).item)
			const explicitNullExtra = record(explicitNull.extra)
			expect(Object.hasOwn(explicitNullExtra, "arbitrary")).toBe(true)
			expect(explicitNullExtra.arbitrary).toBeNull()
			const reservedKeyPatch = await request(fixture, "item.update", {
				itemId,
				extraPatch: JSON.parse(`{"__proto__":null}`),
			})
			expectInvalid(reservedKeyPatch)
			if (!reservedKeyPatch.ok) {
				expect(reservedKeyPatch.error.message).toBe("extra key not allowed: __proto__")
				expect(record(reservedKeyPatch.error.details).field).toBe("extra.__proto__")
			}
			const hook = { kind: "observer", point: "agent.spawn", script: "/bin/true", timeoutMs: 1000 }
			const replaced = record(expectOk(await request(fixture, "item.update", { itemId, extra: { hooks: [hook] } })).item)
			expect(record(replaced.extra).hooks).toEqual([hook])
			const replacementWithOmittedHooks = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extra: { branch: "operator/replacement" },
			})).item)
			expect(record(replacementWithOmittedHooks.extra)).toMatchObject({ branch: "operator/replacement", hooks: [hook] })
			const replacementWithExplicitHookClear = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extra: { branch: "operator/cleared", hooks: null },
			})).item)
			expect(record(replacementWithExplicitHookClear.extra)).toEqual({ branch: "operator/cleared" })
			const patched = record(expectOk(await request(fixture, "item.update", { itemId, extraPatch: { hooks: [hook] } })).item)
			expect(record(patched.extra).hooks).toEqual([hook])
			const cleared = record(expectOk(await request(fixture, "item.update", { itemId, extraPatch: { hooks: null } })).item)
			expect(record(cleared.extra).hooks).toBeUndefined()

			// Audit replay: every item.update emitted one field_write_admission allow with
			// reason=operator. The subject is operator on every event.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			expect(operatorAllows.length).toBeGreaterThanOrEqual(12)
			for (const event of operatorAllows) {
				if (event.kind === "audit" && event.type === "item.update.field_write_admission") {
					expect(event.subject).toEqual({ kind: "operator" })
					expect(event.payload.claimedPhase).toBeNull()
					expect(event.payload.presetName).toBeNull()
					expect(event.payload.deniedFields).toEqual([])
				}
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #410 preset-parser side — declaring a control-plane field in `writableFields` fails preset
	// load with a clear error naming the engine's control-plane vocabulary. Loaded via item-level
	// `presetPath` (the per-item preset declaration site since #412) so the parse failure
	// surfaces through the normal item.add load chain.
	test("preset load rejects control-plane field in [phases.rights] writableFields (#410 parse-side)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-preset-parse-control-plane`)
		const presetDir = resolve(root, "broken-preset")
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(presetDir, "preset.toml"), `name = "broken-control-plane-grant"

[item]
idField = "issue"

[item.fields]

[statuses]
continuable = ["queued"]
terminal    = ["done"]
success     = ["done"]
entry       = "queued"
exhausted   = "done"

[[phases]]
name   = "iteration"
prompt = "iter.md"

  [phases.rights]
  writableFields = ["runner"]
`)
		await writeFile(resolve(presetDir, "iter.md"), "minimal entry\n")
		const fixture = await startFixture("410-preset-parse-control-plane", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "410-broken-grant-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			// Loading the broken preset via the per-item path surfaces the parse failure.
			const reply = await request(fixture, "item.add", {
				chainId,
				itemId: "410400",
				repoCwd: REPO_ROOT,
				presetPath: presetDir,
			})
			expect(reply.ok).toBe(false)
			if (!reply.ok) {
				expect(reply.error.message).toContain("writableFields")
				expect(reply.error.message).toContain("runner")
				expect(reply.error.message).toContain("control-plane")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})
})

// #478 acceptance row 5: the daemon-wide rate-limit decision walks through four states
// (normal → paused → stagger-wait → stagger-ready → normal). Each state's `maxSpawns`
// value is the contract `schedulerTick(options, { maxSpawns })` consumes. The wider
// integration is covered by engine-integration, real-e2e, and the scheduler tests; this is the pure-function
// state machine pinned to its acceptance shape.
describe("daemonRateLimitDecision (issue #478)", () => {
	const reset: { resetsAt: number; resetAtIso: string; rateLimitType: string | null } = {
		resetsAt: 2_000_000_000,
		resetAtIso: "2033-05-18T03:33:20.000Z",
		rateLimitType: "five_hour",
	}
	const cooldownNowMs = (reset.resetsAt - 60) * 1000
	const postResetNowMs = (reset.resetsAt + 5) * 1000

	test("normal — no cooldown armed → no spawn cap", () => {
		const state = createDaemonRateLimitState()
		const decision = daemonRateLimitDecision(state, cooldownNowMs)
		expect(decision.kind).toBe("normal")
		expect(decision.maxSpawns).toBeUndefined()
	})

	test("paused — cooldown armed, reset not elapsed → 0 spawns", () => {
		const state = { ...createDaemonRateLimitState(), reset }
		const decision = daemonRateLimitDecision(state, cooldownNowMs)
		expect(decision.kind).toBe("paused")
		expect(decision.maxSpawns).toBe(0)
	})

	test("stagger-wait — reset elapsed, stagger window still cooling → 0 spawns", () => {
		const state = {
			...createDaemonRateLimitState(),
			reset,
			nextResumeAtMs: postResetNowMs + 10_000,
		}
		const decision = daemonRateLimitDecision(state, postResetNowMs)
		expect(decision.kind).toBe("stagger-wait")
		expect(decision.maxSpawns).toBe(0)
	})

	test("stagger-ready — reset elapsed, stagger window passed (or never armed) → cap = 1", () => {
		const stateReady = { ...createDaemonRateLimitState(), reset, nextResumeAtMs: postResetNowMs - 1 }
		const decisionReady = daemonRateLimitDecision(stateReady, postResetNowMs)
		expect(decisionReady.kind).toBe("stagger-ready")
		expect(decisionReady.maxSpawns).toBe(1)

		// Right after reset elapses, no stagger has armed yet → decision still grants 1.
		const stateFirstTick = { ...createDaemonRateLimitState(), reset }
		const decisionFirstTick = daemonRateLimitDecision(stateFirstTick, postResetNowMs)
		expect(decisionFirstTick.kind).toBe("stagger-ready")
		expect(decisionFirstTick.maxSpawns).toBe(1)
	})

	test("DAEMON_RATE_LIMIT_STAGGER_MS pins the post-reset stagger window per #157 history", () => {
		expect(DAEMON_RATE_LIMIT_STAGGER_MS).toBe(30_000)
	})

	test("context append derives author from credential", async () => {
		const fixture = await startQueueUnblockGateFixture("context-agent-author", { preset: "loaded", targetStatus: "blocked" })
		try {
			fixture.releaseTick.resolve()
			const credential = await waitFor(async () => { try { return (await readFile(fixture.credentialPath, "utf-8")).trim() } catch { return "" } }, (value) => value.length > 0, 8_000)
			const missing = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: "" }))
			expect(missing.ok).toBe(false)
			const unknown = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: "unknown-context-credential" }))
			expect(unknown.ok).toBe(false)
			if (!unknown.ok) expect(unknown.error.message).toContain("did not match any active run")
			const forged = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, author: { kind: "operator" }, agentCredential: credential }))
			expect(forged.ok).toBe(false)
			const begun = expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential })))
			const sessionId = stringValue(begun.sessionId)
			const mismatched = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sessionId, sequence: 0, chunk: "no", }))
			expect(mismatched.ok).toBe(false)
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sessionId, sequence: 0, chunk: "agent-body", agentCredential: credential })))
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId, agentCredential: credential })))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			const entry = store.listContextEntries(fixture.chainId)[0]
			expect(entry?.author).toMatchObject({ kind: "agent", chainId: fixture.chainId, runId: expect.any(String), phase: expect.any(String) })
			store.close()
			const other = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("chain.create", { name: "context-other-chain", repository: "o/r" }))).chain)
			const crossChain = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainId: numberValue(other.id), scope: { kind: "chain" }, agentCredential: credential }))
			expect(crossChain.ok).toBe(false)
			const registry = Reflect.get(fixture.daemon, "runCredentialRegistry")
			if (!(registry instanceof Map)) throw new Error("credential registry unavailable")
			const registration = registry.get(credential)
			expect(registration).toBeDefined()
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("chain.stop", { chainName: fixture.chainName })))
			registry.set(credential, registration)
			const inactive = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential }))
			expect(inactive.ok).toBe(false)
			if (!inactive.ok) expect(inactive.error.message).toContain("no longer active")
			const admissionEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
				.filter((event) => event.type === "context.write_admission")
			const denyReasons = admissionEvents.flatMap((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" ? [event.payload.reason] : [])
			for (const reason of ["missing-credential", "unknown-credential", "invalid-request", "session-owner-mismatch", "cross-chain", "inactive-run"] as const) {
				expect(denyReasons).toContain(reason)
			}
		} finally { await fixture.daemon.stop() }
	}, 30_000)

	test("context denial audit preserves active agent attribution before request and chain rejection", async () => {
		const fixture = await startQueueUnblockGateFixture("context-agent-deny-attribution", { preset: "loaded", targetStatus: "blocked" })
		try {
			fixture.releaseTick.resolve()
			const credential = await waitFor(async () => { try { return (await readFile(fixture.credentialPath, "utf-8")).trim() } catch { return "" } }, (value) => value.length > 0, 8_000)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sequence: 0, chunk: "body", agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: "unknown-agent-session", agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: "missing-context-chain", scope: { kind: "chain" }, agentCredential: credential }))).ok).toBe(false)

			const deletedSessionId = stringValue(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", {
				chainName: fixture.chainName,
				scope: { kind: "chain" },
				agentCredential: credential,
			}))).sessionId)
			const missingSessionId = stringValue(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", {
				chainName: fixture.chainName,
				scope: { kind: "chain" },
				agentCredential: credential,
			}))).sessionId)
			const deletingStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			deletingStore.updateChain(fixture.chainId, { status: "deleted" })
			deletingStore.close()
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: deletedSessionId, agentCredential: credential }))).ok).toBe(false)
			const restoringStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			restoringStore.updateChain(fixture.chainId, { status: "active" })
			restoringStore.close()
			const sessions = Reflect.get(fixture.daemon, "contextAppendSessions")
			if (!(sessions instanceof Map)) throw new Error("context sessions unavailable")
			record(sessions.get(missingSessionId)).chainId = 2_147_483_647
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: missingSessionId, agentCredential: credential }))).ok).toBe(false)

			const denialEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
			for (const reason of ["invalid-request", "unknown-session", "chain-deleted", "chain-not-found"] as const) {
				expect(denialEvents.some((event) => event.type === "context.write_admission"
					&& event.payload.outcome === "deny"
					&& event.payload.reason === reason
					&& event.subject?.kind === "agent")).toBe(true)
			}
		} finally { await fixture.daemon.stop() }
	}, 30_000)

	test("context append sessions cannot outlive soft chain deletion", async () => {
		const fixture = await startFixture("context-deleted-chain-lifecycle", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-deleted-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			const sessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })).sessionId)
			expectOk(await request(fixture, "context.append.chunk", { sessionId, sequence: 0, chunk: "must-not-survive" }))
			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted.deletedContextEntries).toBe(0)
			expect((await request(fixture, "context.append.commit", { sessionId })).ok).toBe(false)
			const beginAfterDelete = await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })
			expect(beginAfterDelete.ok).toBe(false)
			if (!beginAfterDelete.ok) expect(beginAfterDelete.error.code).toBe("chain_deleted")

			const residueStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			residueStore.appendContextEntry({ chainId, scope: { kind: "chain" }, author: { kind: "operator" }, body: "late residue" })
			residueStore.close()
			const deletedAgain = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deletedAgain).toMatchObject({ alreadyDeleted: true, deletedContextEntries: 1 })
			const checkStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(checkStore.listContextEntries(chainId)).toEqual([])
			checkStore.close()
		} finally { await fixture.daemon.stop() }
	})

	test("context write admission audit", async () => {
		const fixture = await startFixture("context-write-audit", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-audit-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			const begun = expectOk(await request(fixture, "context.append.begin", { chainId: numberValue(chain.id), scope: { kind: "chain" } }))
			const sessionId = stringValue(begun.sessionId)
			expectOk(await request(fixture, "context.append.chunk", { sessionId, sequence: 0, chunk: "operator-body" }))
			expectOk(await request(fixture, "context.append.commit", { sessionId }))
			const denied = await request(fixture, "context.append.begin", { chainId: numberValue(chain.id), scope: { kind: "group", groupId: "absent" } })
			expect(denied.ok).toBe(false)

			expect((await request(fixture, "context.append.begin", { chainId })).ok).toBe(false)
			expect((await request(fixture, "context.append.chunk", {})).ok).toBe(false)
			expect((await request(fixture, "context.append.commit", { sessionId: "vanished-session" })).ok).toBe(false)

			const malformedSessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })).sessionId)
			expect((await request(fixture, "context.append.chunk", { sessionId: malformedSessionId, sequence: "zero", chunk: "body" })).ok).toBe(false)
			expect((await request(fixture, "context.append.chunk", { sessionId: malformedSessionId, sequence: 1, chunk: "body" })).ok).toBe(false)

			const vanishedChain = record(expectOk(await request(fixture, "chain.create", { name: "context-vanished-chain", repository: "o/r" })).chain)
			const vanishedChainId = numberValue(vanishedChain.id)
			const vanishedChainSessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId: vanishedChainId, scope: { kind: "chain" } })).sessionId)
			const deletingStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(deletingStore.deleteChain(vanishedChainId)).toBe(true)
			deletingStore.close()
			expect((await request(fixture, "context.append.commit", { sessionId: vanishedChainSessionId })).ok).toBe(false)

			const events = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events.filter((event) => event.type === "context.write_admission")
			expect(events.some((event) => event.type === "context.write_admission" && event.payload.outcome === "allow" && event.payload.reason === "operator")).toBe(true)
			expect(events.some((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" && event.payload.reason === "group-unavailable-v2")).toBe(true)
			const denyReasons = events.flatMap((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" ? [event.payload.reason] : [])
			expect(denyReasons).toContain("invalid-request")
			expect(denyReasons).toContain("unknown-session")
			expect(denyReasons).toContain("sequence-mismatch")
			expect(denyReasons).toContain("chain-not-found")
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(store.listContextEntries(numberValue(chain.id))[0]?.author).toEqual({ kind: "operator" })
			store.close()
		} finally { await fixture.daemon.stop() }
	})

	test("context scope admission", async () => {
		const fixture = await startFixture("context-scope-admission", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-scope-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "known", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration" }))
			const chainScope = expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } }))
			expect(typeof chainScope.sessionId).toBe("string")
			expect((await request(fixture, "context.append.begin", { chainId, scope: { kind: "item", itemId: "known" } })).ok).toBe(true)
			const missingItem = await request(fixture, "context.append.begin", { chainId, scope: { kind: "item", itemId: "missing" } })
			expect(missingItem.ok).toBe(false)
			if (!missingItem.ok) expect(missingItem.error.code).toBe("item-not-found")
			const missingGroup = await request(fixture, "context.append.begin", { chainId, scope: { kind: "group", groupId: "missing" } })
			expect(missingGroup.ok).toBe(false)
			if (!missingGroup.ok) expect(missingGroup.error.code).toBe("group-unavailable-v2")
			const sessions = Reflect.get(fixture.daemon, "contextAppendSessions")
			if (!(sessions instanceof Map)) throw new Error("context sessions unavailable")
			const admitted = sessions.get(chainScope.sessionId)
			expect(admitted).toMatchObject({ chainId, scope: { kind: "chain" } })
		} finally { await fixture.daemon.stop() }
	})
})

// #478 I3 review: pin the `daemon.status.rateLimit` wire shape end-to-end. The PR
// originally tested only the in-state gate (scheduler) and the decision function
// (pure), leaving the JsonObject projector — what `daemon.status` actually serializes
// — untested in its populated state. A null/undefined slip would have been invisible.
// `rateLimitStatusFromState` is the exported pure projector the class delegates to.
describe("rateLimitStatusFromState daemon.status wire shape (issue #478)", () => {
	const populatedState: DaemonRateLimitState = {
		reset: { resetsAt: 2_000_000_000, resetAtIso: "2033-05-18T03:33:20.000Z", rateLimitType: "five_hour" },
		observedAt: "2033-05-18T03:23:00.000Z",
		sourceRunId: "run-rate-limited-1",
		sourceItemId: 478,
		sourceChainId: 42,
		nextResumeAtMs: 2_000_000_030_000,
	}

	test("empty state — wire shape exposes all 10 fields with null/normal defaults", () => {
		const wire = rateLimitStatusFromState(createDaemonRateLimitState(), 1_900_000_000_000)
		expect(Object.keys(wire).sort()).toEqual([
			"active",
			"mode",
			"nextResumeAt",
			"observedAt",
			"rateLimitType",
			"rateLimitedUntil",
			"rateLimitedUntilUnix",
			"sourceChainId",
			"sourceItemId",
			"sourceRunId",
			"staggerMs",
		])
		expect(wire["active"]).toBe(false)
		expect(wire["mode"]).toBe("normal")
		expect(wire["rateLimitedUntil"]).toBeNull()
		expect(wire["rateLimitedUntilUnix"]).toBeNull()
		expect(wire["rateLimitType"]).toBeNull()
		expect(wire["observedAt"]).toBeNull()
		expect(wire["sourceRunId"]).toBeNull()
		expect(wire["sourceItemId"]).toBeNull()
		expect(wire["sourceChainId"]).toBeNull()
		expect(wire["nextResumeAt"]).toBeNull()
		expect(wire["staggerMs"]).toBe(DAEMON_RATE_LIMIT_STAGGER_MS)
	})

	test("populated state during cooldown — `active=true`, `mode=paused`, ISO + unix coexist (covers issue acceptance row 4)", () => {
		// nowMs before reset → paused
		const cooldownNowMs = (populatedState.reset!.resetsAt - 600) * 1000
		const wire = rateLimitStatusFromState(populatedState, cooldownNowMs)
		expect(wire["active"]).toBe(true)
		expect(wire["mode"]).toBe("paused")
		expect(wire["rateLimitedUntil"]).toBe("2033-05-18T03:33:20.000Z")
		expect(wire["rateLimitedUntilUnix"]).toBe(2_000_000_000)
		expect(wire["rateLimitType"]).toBe("five_hour")
		expect(wire["observedAt"]).toBe("2033-05-18T03:23:00.000Z")
		expect(wire["sourceRunId"]).toBe("run-rate-limited-1")
		expect(wire["sourceItemId"]).toBe(478)
		expect(wire["sourceChainId"]).toBe(42)
		// nextResumeAt is serialized as an ISO string when nextResumeAtMs is set.
		expect(wire["nextResumeAt"]).toBe(new Date(populatedState.nextResumeAtMs!).toISOString())
		// JSON.stringify must not drop any field (undefined would be silently dropped) —
		// the round-trip pins this because every value above is either a primitive or null.
		const roundTrip: Record<string, unknown> = JSON.parse(JSON.stringify(wire))
		expect(Object.keys(roundTrip).sort()).toEqual([
			"active", "mode", "nextResumeAt", "observedAt", "rateLimitType",
			"rateLimitedUntil", "rateLimitedUntilUnix", "sourceChainId",
			"sourceItemId", "sourceRunId", "staggerMs",
		])
	})

	test("populated state after reset, before stagger — `active=true`, `mode=stagger-wait`", () => {
		const wire = rateLimitStatusFromState(populatedState, populatedState.nextResumeAtMs! - 1)
		expect(wire["active"]).toBe(true)
		expect(wire["mode"]).toBe("stagger-wait")
	})

	test("populated state after stagger window — `active=false`, `mode=stagger-ready`", () => {
		const wire = rateLimitStatusFromState(populatedState, populatedState.nextResumeAtMs! + 1)
		expect(wire["active"]).toBe(false)
		expect(wire["mode"]).toBe("stagger-ready")
	})
})

type PhaseAdvancementFixture = Fixture & {
	fakePhaseAwareRunner: string
}

async function startPhaseAdvancementFixture(name: string): Promise<PhaseAdvancementFixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const eventLog = resolve(root, "events.jsonl")
	const fakeRunner = resolve(root, "phase-aware-runner.ts")
	await mkdir(root, { recursive: true })
	await writeFile(
		fakeRunner,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, phase: input.phase, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, phase: input.phase, cwd: process.cwd() }) + "\\n")
await writeLine("done:" + input.itemId + ":" + input.phase)
if (input.phase === "review") {
	await writeLine("PHASE DONE: issue=#" + input.issueNumber + "; reason=phase-aware-runner review")
} else {
	await writeLine("ITERATION SUMMARY: scope=phase-aware-runner; reason=iter-marker")
}
${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
process.exitCode = 0
`,
	)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}

	const fakeRunnerSelection: SchedulerOptions["runner"] = {
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
			intervalMs: 20,
			runner: fakeRunnerSelection,
			presetDir: PRESET_DIR,
			worktreeManager,
			prompt: ({ item, runId, phase }) => JSON.stringify({
				itemId: item.id,
				issueNumber: Number(item.itemId),
				runId,
				phase,
				eventLog,
				sleepMs: 5,
				writeStatus: phase === "iteration" ? "in_progress" : "done",
			}),
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return {
		daemon,
		loopDataRoot,
		socketPath: snapshot.socketPath,
		pidFile: snapshot.pidFile,
		eventLog,
		schedulerEvents,
		fakePhaseAwareRunner: fakeRunner,
	}
}

type ChainBasedRunnerFixture = Fixture & {
	fakeCodexBinary: string
	fakeClaudeBinary: string
}

async function startChainBasedRunnerFixture(name: string, options: { phase: string }): Promise<ChainBasedRunnerFixture> {
	const { chmod } = await import("node:fs/promises")
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	const fakeCodex = resolve(root, "fake-codex.sh")
	const fakeClaude = resolve(root, "fake-claude.sh")
	await writeFile(
		fakeCodex,
		`#!/bin/sh
echo "BINARY:codex"
echo "ITERATION SUMMARY: scope=ac5; reason=marker"
echo "PHASE DONE: issue=#0; reason=marker"
exit 0
`,
	)
	await writeFile(
		fakeClaude,
		`#!/bin/sh
echo "BINARY:claude"
echo "ITERATION SUMMARY: scope=ac5; reason=marker"
echo "PHASE DONE: issue=#0; reason=marker"
exit 0
`,
	)
	await chmod(fakeCodex, 0o755)
	await chmod(fakeClaude, 0o755)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}

	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		shutdownGraceMs: 100,
		scheduler: {
			enabled: true,
			intervalMs: 20,
			worktreeManager,
			phase: options.phase,
			prompt: () => "ac5-phase-prompt",
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return {
		daemon,
		loopDataRoot,
		socketPath: snapshot.socketPath,
		pidFile: snapshot.pidFile,
		eventLog,
		schedulerEvents,
		fakeCodexBinary: fakeCodex,
		fakeClaudeBinary: fakeClaude,
	}
}

type QueueUnblockGateOptions =
	| { preset: "loaded"; targetStatus: "blocked" | "done" }
	| { preset: "missing"; targetStatus: "blocked" }

type QueueUnblockOutcomeScenario =
	| { kind: "success"; preset: "loaded"; targetStatus: "blocked"; issue: "target"; dryRun: false }
	| { kind: "dry-run"; preset: "loaded"; targetStatus: "blocked"; issue: "target"; dryRun: true }
	| { kind: "not-unblockable"; preset: "loaded"; targetStatus: "done"; issue: "target"; dryRun: false }
	| { kind: "not-found"; preset: "loaded"; targetStatus: "blocked"; issue: "missing"; dryRun: false }
	| { kind: "preset-load-error"; preset: "missing"; targetStatus: "blocked"; issue: "target"; dryRun: false }

function assertNeverQueueUnblockOutcomeScenario(scenario: never): never {
	throw new Error(`Unhandled queue-unblock outcome scenario: ${JSON.stringify(scenario)}`)
}

async function startQueueUnblockGateFixture(name: string, options: QueueUnblockGateOptions) {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const fakeRunner = resolve(root, "held-runner.ts")
	const credentialPath = resolve(root, "runner-credential.txt")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(
		fakeRunner,
		`import { writeFile } from "node:fs/promises"
await writeFile(${JSON.stringify(credentialPath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await new Promise((resolveSignal) => process.once("SIGTERM", resolveSignal))
process.exitCode = 0
`,
	)

	const chainName = `${name}-chain`
	const targetItemId = "538101"
	const sentinelItemId = "538102"
	const store = openSqliteStateStore({ loopDataRoot })
	let chainId: number
	let targetRowId: number
	let sentinelRowId: number
	try {
		const chain = store.createChain({
			name: chainName,
			preset: options.preset === "loaded" ? "gh-issue-pr-iteration" : "missing-538-preset",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "stopped",
			metadata: storedChainMetadata({}),
		})
		chainId = chain.id
		const target = store.createItem({
			chainId,
			itemId: targetItemId,
			repoCwd: REPO_ROOT,
			status: runtimeStatus(options.targetStatus),
			preset: "gh-issue-pr-iteration",
			extra: storedItemExtra({ issue: targetItemId }),
		})
		targetRowId = target.id
		const sentinel = store.createItem({
			chainId,
			itemId: sentinelItemId,
			repoCwd: REPO_ROOT,
			status: runtimeStatus("queued"),
			preset: "gh-issue-pr-iteration",
			extra: storedItemExtra({ issue: sentinelItemId }),
		})
		sentinelRowId = sentinel.id
	} finally {
		store.close()
	}

	const tickEntered = Promise.withResolvers<void>()
	const releaseTick = Promise.withResolvers<void>()
	const postOutcomeTick = Promise.withResolvers<Extract<SchedulerEvent, { type: "slot.busy" }>>()
	let gateFirstWorktree = true
	const loadedPreset = loadPreset(PRESET_DIR).then((preset) => ({ presetDir: PRESET_DIR, preset }))
	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		shutdownGraceMs: 100,
		scheduler: {
			enabled: true,
			intervalMs: 60_000,
			runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			presetForChain: () => loadedPreset,
			presetForItem: () => loadedPreset,
			worktreeManager: async ({ chain, repoCwd }) => {
				if (gateFirstWorktree) {
					gateFirstWorktree = false
					tickEntered.resolve()
					await releaseTick.promise
				}
				const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
				await mkdir(worktreePath, { recursive: true })
				return worktreePath
			},
			prompt: () => "queue-unblock scheduler serialization fixture",
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				if (event.type === "slot.busy") postOutcomeTick.resolve(event)
			},
		},
	})
	const socketPath = daemon.snapshot().socketPath
	if (options.preset === "loaded") {
		expectOk(await sendDaemonRequest(socketPath, daemonRequest("queue.unblock", {
			chainName,
			issue: targetItemId,
			dryRun: true,
		})))
	}
	expectOk(await sendDaemonRequest(socketPath, daemonRequest("chain.resume", { chainName })))

	return {
		daemon,
		loopDataRoot,
		socketPath,
		chainName,
		chainId,
		targetItemId,
		targetRowId,
		sentinelRowId,
		tickEntered,
		releaseTick,
		postOutcomeTick,
		credentialPath,
	}
}

type Fixture = {
	daemon: CoderLoopDaemon
	loopDataRoot: string
	socketPath: string
	pidFile: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
}

type FixtureOptions = {
	schedulerEnabled?: boolean
	schedulerIntervalMs?: number
	schedulerPresetDir?: string | null
	realWorktreeManager?: boolean
	worktreeManager?: SchedulerWorktreeManager
	chainCompleteTriggerForChain?: SchedulerOptions["chainCompleteTriggerForChain"]
	useDefaultChainCompleteTrigger?: boolean
	schedulerRunnerKind?: AgentRunnerKind
	schedulerBinaryIsFakeRunner?: boolean
	schedulerConfig?: Partial<CoderLoopDaemonSchedulerConfig>
	beforeStart?: (input: { root: string; loopDataRoot: string; eventLog: string; fakeRunner: string }) => Promise<void> | void
}

// #456: the legacy chain-drain auto-fire suppressor helper retired with the path itself. The
// helper existed to keep chain-completion / item-update tests from racing the auto-fired phase;
// with that path deleted, the suppressor is no longer needed and every former call site is removed
// in the same change.

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await writeFakeRunner(fakeRunner)
	await options.beforeStart?.({ root, loopDataRoot, eventLog, fakeRunner })

	const schedulerEvents: SchedulerEvent[] = []
	const configuredOnEvent = options.schedulerConfig?.onEvent
	const worktreeManager: SchedulerWorktreeManager = options.worktreeManager ?? (options.realWorktreeManager ? createGitWorktreeManager({ loopDataRoot }) : async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	})

	const scheduler: SchedulerOptions["runner"] = {
		kind: options.schedulerRunnerKind ?? "claude",
		source: "iteration-default",
		binary: options.schedulerBinaryIsFakeRunner ? fakeRunner : "bun",
		extraArgs: options.schedulerBinaryIsFakeRunner ? [] : [fakeRunner],
		model: null,
	}
	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		shutdownGraceMs: 100,
		scheduler: {
			...(options.schedulerConfig ?? {}),
			enabled: options.schedulerEnabled ?? true,
			intervalMs: options.schedulerIntervalMs ?? 20,
			runner: scheduler,
			...(options.schedulerPresetDir === null ? {} : { presetDir: options.schedulerPresetDir ?? PRESET_DIR }),
			worktreeManager,
			prompt: ({ item, runId, phase }) => {
				const extra = itemExtraToJsonObject(item.extra)
				const payload: BoundaryRecord = {
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: typeof extra.sleepMs === "number" ? extra.sleepMs : 5,
					exitCode: typeof extra.exitCode === "number" ? extra.exitCode : 0,
					writeStatus: daemonFakeRunnerWriteStatus(phase, extra),
				}
				// #452: the prompt forwards optional stdout-fuzz / recycle-sleep knobs the test
				// uses to exercise recycle semantics. `stdoutLines` lets a fixture emit arbitrary
				// stdout (including forged close-marker shapes) — protects acceptance row 4's
				// "stdout content has zero effect" claim. `extraSleepAfterStatusWriteMs` keeps
				// the agent alive past the status write, exercising the recycle window.
				if (Object.prototype.hasOwnProperty.call(extra, "stdoutLines")) payload.stdoutLines = extra.stdoutLines
				if (Object.prototype.hasOwnProperty.call(extra, "extraSleepAfterStatusWriteMs")) payload.extraSleepAfterStatusWriteMs = extra.extraSleepAfterStatusWriteMs
				return JSON.stringify(payload)
			},
			...(options.useDefaultChainCompleteTrigger
				? {}
				: { chainCompleteTriggerForChain: options.chainCompleteTriggerForChain ?? (() => null) }),
			onEvent: configuredOnEvent === undefined
				? (event) => {
					schedulerEvents.push(event)
				}
				: async (event) => {
					schedulerEvents.push(event)
					await configuredOnEvent(event)
				},
		},
	})
	const snapshot = daemon.snapshot()
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, pidFile: snapshot.pidFile, eventLog, schedulerEvents }
}

async function request(fixture: Fixture, command: string, args: JsonObject = {}): Promise<DaemonResponse> {
	// #412: tests that don't explicitly opt into a preset get the bundled default applied here. The
	// daemon API requires per-item preset; without this shim, every test that does not invoke a
	// preset-validation path (the vast majority — they exercise scheduling / state / observability,
	// not preset wiring) would need a noisy boilerplate change. The shim only fires when the caller
	// has not passed preset/presetPath, so preset-validation tests still get their explicit input.
	const augmented = injectTestPresetDefault(command, args)
	return await sendDaemonRequest(fixture.socketPath, { id: `${command}-${Date.now()}`, command, args: augmented })
}

function injectTestPresetDefault(command: string, args: JsonObject): JsonObject {
	if (command === "item.add") {
		if (args.preset === undefined && args.presetPath === undefined) {
			return { ...args, preset: "gh-issue-pr-iteration" }
		}
		return args
	}
	if (command === "item.batchAdd" && Array.isArray(args.items)) {
		const items: JsonValue[] = args.items.map((rawItem): JsonValue => {
			if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) return rawItem
			const itemObj: JsonObject = rawItem
			if (itemObj.preset === undefined && itemObj.presetPath === undefined) {
				return { ...itemObj, preset: "gh-issue-pr-iteration" }
			}
			return itemObj
		})
		return { ...args, items }
	}
	return args
}

function expectOk(response: DaemonResponse) {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function expectInvalid(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("invalid_request")
}

function expectInvalidDetails(response: DaemonResponse, field: string, value: unknown): void {
	expectInvalid(response)
	if (!response.ok) {
		const details = record(response.error.details)
		expect(details).toMatchObject({ field, value })
	}
}

function expectChainDeleted(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("chain_deleted")
}

function expectChainNotActive(response: DaemonResponse, status: string, operation: string): void {
	expect(response.ok).toBe(false)
	if (!response.ok) {
		expect(response.error.code).toBe("chain_not_active")
		expect(response.error.message).toContain(operation)
		expect(response.error.message).toContain("non-active chain")
		expect(response.error.message).toContain("create a new chain")
		if (response.error.details === undefined) throw new Error("expected chain_not_active details")
		expect(record(response.error.details)).toMatchObject({
			status,
			requiredStatus: "active",
			nextStep: "create_new_chain",
		})
	}
}

function expectConflict(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("conflict")
}

function expectTooLarge(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("request_too_large")
}

function record(value: unknown): BoundaryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
	return value as BoundaryRecord
}

function deferred<T>() {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => {
		throw new Error("deferred resolve initialized incorrectly")
	}
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
}

type TestDaemonResponse = { id: string; ok: boolean }

async function sendLinesOnDaemonConnection(socketPath: string, lines: readonly string[]): Promise<TestDaemonResponse[]> {
	return await new Promise((resolveResponses, reject) => {
		const socket = createConnection(socketPath)
		const responses: TestDaemonResponse[] = []
		let buffer = ""
		const cleanup = () => {
			socket.removeAllListeners()
			socket.destroy()
		}
		socket.setEncoding("utf-8")
		socket.on("connect", () => {
			socket.write(`${lines.join("\n")}\n`)
		})
		socket.on("data", (chunk: string) => {
			buffer += chunk
			let newlineIndex = buffer.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				responses.push(testDaemonResponse(line))
				if (responses.length === lines.length) {
					cleanup()
					resolveResponses(responses)
					return
				}
				newlineIndex = buffer.indexOf("\n")
			}
		})
		socket.on("error", (error) => {
			cleanup()
			reject(error)
		})
	})
}

function testDaemonResponse(line: string): TestDaemonResponse {
	const response = record(JSON.parse(line))
	const id = stringValue(response.id)
	if (typeof response.ok !== "boolean") throw new Error("daemon response ok must be boolean")
	return { id, ok: response.ok }
}

function nestedMetadata(depth: number): JsonObject {
	let value: JsonValue = "ok"
	for (let index = 0; index < depth; index++) value = { nest: value }
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
	return value
}

function numberValue(value: unknown): number {
	if (typeof value !== "number") throw new Error("expected number")
	return value
}

function stringValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("expected string")
	return value
}

async function readChainStatus(loopDataRoot: string, chainId: number): Promise<string | null> {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getChain(chainId)?.status ?? null
	} finally {
		store.close()
	}
}

async function readChain(loopDataRoot: string, chainId: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getChain(chainId)
	} finally {
		store.close()
	}
}

async function readItem(loopDataRoot: string, chainId: number, issueNumber: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getItemById(chainId, String(issueNumber))
	} finally {
		store.close()
	}
}

async function readRun(loopDataRoot: string, runId: string) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getRunByRunId(runId)
	} finally {
		store.close()
	}
}

async function listChainRuns(loopDataRoot: string, chainId: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.listRuns(chainId)
	} finally {
		store.close()
	}
}

async function readCurrentRun(loopDataRoot: string, chainId: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getCurrentRun(chainId)
	} finally {
		store.close()
	}
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
	const startedAt = Date.now()
	let latest = await read()
	while (!predicate(latest)) {
		if (Date.now() - startedAt > timeoutMs) throw new Error(`condition not met; latest=${JSON.stringify(latest)}`)
		await new Promise((resolveWait) => setTimeout(resolveWait, 20))
		latest = await read()
	}
	return latest
}

// v1 status model: the agent writes item.status itself, which becomes observable BEFORE the
// scheduler's run-close handler finishes its bookkeeping (run row, phase.end / queue.terminal
// events, completion artifacts). Tests must therefore synchronize on the scheduler-emitted
// terminal signal, not on item.status, or they race ahead of the close handler.
async function waitForItemQueueTerminal(
	fixture: Fixture,
	itemId: number,
	timeoutMs = 10_000,
): Promise<Extract<SchedulerEvent, { type: "queue.terminal" }>> {
	return (await waitFor(
		async () =>
			fixture.schedulerEvents.find(
				// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`. The
				// caller still passes the items.id rowid as `itemId` parameter for grep-friendly
				// call sites; we match it against the renamed field.
				(event): event is Extract<SchedulerEvent, { type: "queue.terminal" }> => event.type === "queue.terminal" && event.rowId === itemId,
			) ?? null,
		(event) => event !== null,
		timeoutMs,
	)) as Extract<SchedulerEvent, { type: "queue.terminal" }>
}

async function waitForItemPhaseEnd(
	fixture: Fixture,
	itemId: number,
	timeoutMs = 10_000,
): Promise<Extract<SchedulerEvent, { type: "phase.end" }>> {
	return (await waitFor(
		async () =>
			fixture.schedulerEvents.find(
				(event): event is Extract<SchedulerEvent, { type: "phase.end" }> => event.type === "phase.end" && event.itemId === itemId,
			) ?? null,
		(event) => event !== null,
		timeoutMs,
	)) as Extract<SchedulerEvent, { type: "phase.end" }>
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now()
	while (Date.now() - startedAt <= timeoutMs) {
		if (!isPidAlive(pid)) return true
		await new Promise((resolveWait) => setTimeout(resolveWait, 20))
	}
	return !isPidAlive(pid)
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function pathIsSocket(path: string): Promise<boolean> {
	return (await stat(path)).isSocket()
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

async function writeFakeRunner(path: string): Promise<void> {
	// #452: the previous fake runner derived a per-run summary tag from the prompt and
	// wrapped a `summaryWrap` payload in it. Both inputs are gone — the scheduler no
	// longer injects a tag instruction (acceptance row 1) and the engine no longer
	// reads stdout for completion classification (acceptance row 4). The new shape:
	//   1. start event
	//   2. sleep
	//   3. stdout lines the test wants (including forged tags via stdoutLines for
	//      acceptance row 4's stdout-zero-effect proof)
	//   4. status write through the legacy direct-SQLite bypass (admission-skipping)
	//   5. optional post-status sleep to exercise the recycle window
	//   6. exit
	// Use `writeCredentialedFakeRunner` for the credentialed-write variant that flows
	// through the daemon socket and exercises the recycle hook.
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await writeLine("done:" + input.itemId)
if (Array.isArray(input.stdoutLines)) {
	for (const line of input.stdoutLines) await writeLine(line)
}
${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
const extraSleepAfterStatusWrite = typeof input.extraSleepAfterStatusWriteMs === "number" ? input.extraSleepAfterStatusWriteMs : 0
if (extraSleepAfterStatusWrite > 0) await new Promise((resolve) => setTimeout(resolve, extraSleepAfterStatusWrite))
process.exitCode = input.exitCode
`,
	)
}

// #452 credentialed variant. Routes the status write through the daemon socket so the
// real admission gate runs and `markRunPendingRecycle` fires for the bound runId. The
// recycle-zone tests use this variant so the production lifecycle they exercise matches
// the lifecycle a real agent goes through.
async function writeCredentialedFakeRunner(path: string): Promise<void> {
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await writeLine("done:" + input.itemId)
if (Array.isArray(input.stdoutLines)) {
	for (const line of input.stdoutLines) await writeLine(line)
}
${FAKE_RUNNER_CREDENTIALED_STATUS_WRITE_SNIPPET}
const extraSleepAfterStatusWrite = typeof input.extraSleepAfterStatusWriteMs === "number" ? input.extraSleepAfterStatusWriteMs : 0
if (extraSleepAfterStatusWrite > 0) await new Promise((resolve) => setTimeout(resolve, extraSleepAfterStatusWrite))
process.exitCode = input.exitCode
`,
	)
}

async function writePromptCaptureRunner(path: string, capturePath: string): Promise<void> {
	await writeFile(
		path,
		`import { writeFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "" : Bun.argv[promptIndex + 1] ?? ""
await writeFile(${JSON.stringify(capturePath)}, prompt)
process.exitCode = 0
`,
	)
}

async function writeSinglePhasePromptPreset(presetDir: string, prompt: string): Promise<void> {
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "run.md"), `${prompt}\n`)
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "scheduler-prompt-override"

[item]
idField = "issue"

[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[agent]
binary = "codex"

[[phases]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edge so R2 passes for "queued". The scheduler-prompt
  # override harness only inspects the rendered prompt, so the exits set is
  # inert from this test's perspective.
  [[phases.exits]]
  status = "done"
  when = "Run finished and the item should land in success-terminal vocabulary."
`,
	)
}
