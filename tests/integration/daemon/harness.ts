import { afterAll, describe, expect as bunExpect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, cp, link, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { basename, resolve } from "node:path"

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
} from "../../../src/daemon"
import { buildCoderLoopStatusSnapshot, loadPreset, type AgentRunnerKind, type JsonObject, type JsonValue } from "../../../src/loop"
import {
	createGitWorktreeManager,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "../../../src/scheduler"
import { closureWorktreePath } from "../../../src/closure-lifecycle"
import { resolveChainRuntimePaths, resolveLoopDataPaths } from "../../../src/runtime-paths"
import { openSqliteStateStore } from "../../../src/sqlite-state"
import { makeObservabilityEvent, ObservabilityEventBoundary, queryObservabilityEvents } from "../../../src/observability"
import { chainBindings, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"
import type { BoundaryRecord, BoundaryValue } from "../../../src/boundary-types"
import { parseHookDeclarations, type GateHookDeclaration, type ObserverHookDeclaration, type PresetHookPlaceholder } from "../../../src/hook-declarations"

// Moving fixtures behind a module boundary preserves branded runtime statuses in inferred
// return types. Keep Bun's runtime matcher and static helpers while accepting wire literals.
const expect = Object.assign((value: unknown) => bunExpect(value), bunExpect)

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/dt", String(process.pid))
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const runnerWritableFixtureArtifacts = new Set<string>()

let nextFixtureId = 0

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

function observabilityTaskIdentity(runId: string) {
	return {
		runtimeNodeId: `runtime:${runId}`,
		definitionRef: { kind: "chain", contentIdentity: "sha256:daemon-observability-test" },
		definitionNodeId: `definition:${runId}`,
	} as const
}

function staleRecoveryRunExtra(worktreePath: string, overrides: JsonObject = {}) {
	return storedItemExtra({
		worktreePath,
		branchName: "main",
		baseCommit: "0123456789abcdef",
		definitionKind: "preset",
		definitionContentIdentity: "sha256:daemon-recovery-fixture",
		definitionPhases: [
			{ phase: "iteration", definitionNodeId: "task:iteration" },
			{ phase: "review", definitionNodeId: "task:review" },
			{ phase: "blocked-responder", definitionNodeId: "task:blocked-responder" },
			{ phase: "umbrella-finalizer", definitionNodeId: "task:umbrella-finalizer" },
		],
		...overrides,
	})
}

async function writeCredentialedFixturePreset(root: string): Promise<string> {
	const presetDir = resolve(root, "credentialed-fixture-preset")
	await cp(PRESET_DIR, presetDir, { recursive: true })
	const presetTomlPath = resolve(presetDir, "preset.toml")
	const presetToml = await readFile(presetTomlPath, "utf-8")
	const iterationHeader = 'roles  = ["common", "quality", "iter"]'
	const exits = ["changes_requested", "blocked", "moot", "done", "exhausted", "in_progress"]
		.map((status) => `\n  [[phases.exits]]\n  status = "${status}"\n  when = "daemon credentialed fixture status"\n`)
		.join("")
	await writeFile(presetTomlPath, presetToml.replace(iterationHeader, iterationHeader + exits))
	return presetDir
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
const StatusArtifactBoundary = arkType({ phase: "string" })
const StatusSnapshotBoundary = arkType({ events: { recent: ObservabilityEventBoundary.array() } })

// The spawned agent is the only writer of item.status. Fake runners use the same
// run-scoped credential and daemon admission path as a real `coder-loop item update`.
const FAKE_RUNNER_STATUS_WRITE_SNIPPET = `if (typeof input.writeStatus === "string" && input.itemId > 0 && process.env.CODER_LOOP_DATA_DIR) {
	const credential = process.env.CODER_LOOP_RUN_CRED
	if (typeof credential !== "string" || credential.length === 0) throw new Error("fake runner requires CODER_LOOP_RUN_CRED")
	const { createConnection } = await import("node:net")
	const { randomUUID } = await import("node:crypto")
	const socketPath = process.env.CODER_LOOP_DATA_DIR + "/daemon.sock"
	const response = await new Promise((resolveSend, rejectSend) => {
		const socket = createConnection(socketPath)
		let buffer = ""
		socket.setEncoding("utf-8")
		socket.on("connect", () => {
			socket.write(JSON.stringify({ id: randomUUID(), command: "item.update", args: { itemId: input.itemId, status: input.writeStatus, agentCredential: credential } }) + "\\n")
		})
		socket.on("data", (chunk) => {
			buffer += chunk
			const newline = buffer.indexOf("\\n")
			if (newline === -1) return
			socket.destroy()
			resolveSend(JSON.parse(buffer.slice(0, newline)))
		})
		socket.on("error", rejectSend)
	})
	if (response.ok !== true) throw new Error("credentialed fake-runner status write failed: " + JSON.stringify(response))
}`

// #452 credentialed write path. Used by recycle-zone tests that need the write to flow
// through the real daemon socket so `handleItemUpdate` runs admission and calls
// `markRunPendingRecycle`. The daemon's caller-admission binds the credential to a
// specific runId, so this branch fires only when the scheduler injected
// `CODER_LOOP_RUN_CRED` into the spawn env — which it always does in production, but is
// gated by the test fixture installing a presetDir whose target phase declares
// `[[phases.exits]]` for the requested status (otherwise the #397 default-deny gate
// rejects the write before the recycle hook can fire).
const FAKE_RUNNER_CREDENTIALED_STATUS_WRITE_SNIPPET = FAKE_RUNNER_STATUS_WRITE_SNIPPET

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
	runnerWritableFixtureArtifacts.clear()
})


type PhaseAdvancementFixture = Fixture & {
	fakePhaseAwareRunner: string
}

async function startPhaseAdvancementFixture(name: string): Promise<PhaseAdvancementFixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = root + "-loop-data"
	const credentialedPresetDir = await writeCredentialedFixturePreset(root)
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
	const worktreeManager: SchedulerWorktreeManager = async () => root

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
			presetDir: credentialedPresetDir,
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
		defaultItemPresetPath: credentialedPresetDir,
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
	const loopDataRoot = root + "-loop-data"
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
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd, closureId }) => {
		const worktreePath = closureWorktreePath(loopDataRoot, chain.name, repoCwd, closureId)
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
	const loopDataRoot = root + "-loop-data"
	const fakeRunner = resolve(root, "held-runner.ts")
	const credentialPath = resolve(root, "runner-credential.txt")
	await mkdir(root, { recursive: true })
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
			worktreeManager: async () => {
				if (gateFirstWorktree) {
					gateFirstWorktree = false
					tickEntered.resolve()
					await releaseTick.promise
				}
				return root
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
	defaultItemPresetPath?: string | null
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
	beforeStart?: (input: { root: string; loopDataRoot: string; eventLog: string; fakeRunner: string; defaultItemPresetPath: string | null }) => Promise<void> | void
}

// #456: the legacy chain-drain auto-fire suppressor helper retired with the path itself. The
// helper existed to keep chain-completion / item-update tests from racing the auto-fired phase;
// with that path deleted, the suppressor is no longer needed and every former call site is removed
// in the same change.

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = root + "-loop-data"
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(eventLog, "")
	runnerWritableFixtureArtifacts.add(eventLog)
	await writeFakeRunner(fakeRunner)
	const schedulerEnabled = options.schedulerEnabled ?? true
	const defaultItemPresetPath = schedulerEnabled && options.schedulerPresetDir !== null
		? options.schedulerPresetDir ?? await writeCredentialedFixturePreset(root)
		: null
	await options.beforeStart?.({ root, loopDataRoot, eventLog, fakeRunner, defaultItemPresetPath })

	const schedulerEvents: SchedulerEvent[] = []
	const configuredOnEvent = options.schedulerConfig?.onEvent
	const worktreeManager: SchedulerWorktreeManager = options.worktreeManager ?? (options.realWorktreeManager ? createGitWorktreeManager({ loopDataRoot }) : async ({ chain, repoCwd, closureId }) => {
		const worktreePath = closureWorktreePath(loopDataRoot, chain.name, repoCwd, closureId)
		await mkdir(worktreePath, { recursive: true })
		for (const artifactPath of runnerWritableFixtureArtifacts) {
			if (!artifactPath.startsWith(`${root}/`)) continue
			try {
				await link(artifactPath, resolve(worktreePath, basename(artifactPath)))
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
			}
		}
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
			enabled: schedulerEnabled,
			intervalMs: options.schedulerIntervalMs ?? 20,
			runner: scheduler,
			...(options.schedulerPresetDir === null ? {} : { presetDir: defaultItemPresetPath ?? PRESET_DIR }),
			worktreeManager,
			prompt: ({ item, runId, phase }) => {
				const extra = itemExtraToJsonObject(item.extra)
				const payload: BoundaryRecord = {
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog: basename(eventLog),
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
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, pidFile: snapshot.pidFile, eventLog, schedulerEvents, defaultItemPresetPath }
}

async function request(fixture: Fixture, command: string, args: JsonObject = {}): Promise<DaemonResponse> {
	// #412: tests that don't explicitly opt into a preset get the bundled default applied here. The
	// daemon API requires per-item preset; without this shim, every test that does not invoke a
	// preset-validation path (the vast majority — they exercise scheduling / state / observability,
	// not preset wiring) would need a noisy boilerplate change. The shim only fires when the caller
	// has not passed preset/presetPath, so preset-validation tests still get their explicit input.
	const augmented = injectTestPresetDefault(command, args, fixture.defaultItemPresetPath ?? null)
	return await sendDaemonRequest(fixture.socketPath, { id: `${command}-${Date.now()}`, command, args: augmented })
}

function injectTestPresetDefault(command: string, args: JsonObject, defaultItemPresetPath: string | null): JsonObject {
	if (command === "chain.create" && defaultItemPresetPath !== null) {
		const metadata = typeof args.metadata === "object" && args.metadata !== null && !Array.isArray(args.metadata)
			? args.metadata
			: {}
		return { ...args, metadata: { ...metadata, presetPath: defaultItemPresetPath } }
	}
	if (command === "item.add") {
		if (args.preset === undefined && args.presetPath === undefined) {
			return defaultItemPresetPath === null ? { ...args, preset: "gh-issue-pr-iteration" } : { ...args, presetPath: defaultItemPresetPath }
		}
		return args
	}
	if (command === "item.batchAdd" && Array.isArray(args.items)) {
		const items: JsonValue[] = args.items.map((rawItem): JsonValue => {
			if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) return rawItem
			const itemObj: JsonObject = rawItem
			if (itemObj.preset === undefined && itemObj.presetPath === undefined) {
				return defaultItemPresetPath === null ? { ...itemObj, preset: "gh-issue-pr-iteration" } : { ...itemObj, presetPath: defaultItemPresetPath }
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

function numberValue(value: BoundaryValue): number {
	if (typeof value !== "number") throw new Error("expected number")
	return value
}

function stringValue(value: BoundaryValue): string {
	if (typeof value !== "string") throw new Error("expected string")
	return value
}

function present<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected value")
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
	return present(await waitFor(
		async () =>
			fixture.schedulerEvents.find(
				// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`. The
				// caller still passes the items.id rowid as `itemId` parameter for grep-friendly
				// call sites; we match it against the renamed field.
				(event): event is Extract<SchedulerEvent, { type: "queue.terminal" }> => event.type === "queue.terminal" && event.rowId === itemId,
			) ?? null,
		(event) => event !== null,
		timeoutMs,
	))
}

async function waitForItemPhaseEnd(
	fixture: Fixture,
	itemId: number,
	timeoutMs = 10_000,
): Promise<Extract<SchedulerEvent, { type: "phase.end" }>> {
	return present(await waitFor(
		async () =>
			fixture.schedulerEvents.find(
				(event): event is Extract<SchedulerEvent, { type: "phase.end" }> => event.type === "phase.end" && event.itemId === itemId,
			) ?? null,
		(event) => event !== null,
		timeoutMs,
	))
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
	gitOutput(path, ["init", "-q", "-b", "main"])
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
	await writeFile(capturePath, "")
	runnerWritableFixtureArtifacts.add(capturePath)
	await writeFile(
		path,
		`import { writeFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "" : Bun.argv[promptIndex + 1] ?? ""
await writeFile(${JSON.stringify(basename(capturePath))}, prompt)
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


export {
	describe,
	expect,
	test,
	spawn,
	chmod,
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
	createConnection,
	resolve,
	arkType,
	DaemonError,
	DecisionFingerprintState,
	daemonRequest,
	createDaemonRateLimitState,
	DAEMON_RATE_LIMIT_STAGGER_MS,
	daemonRateLimitDecision,
	rateLimitStatusFromState,
	sendDaemonRequest,
	startCoderLoopDaemon,
	buildCoderLoopStatusSnapshot,
	loadPreset,
	createGitWorktreeManager,
	closureWorktreePath,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	openSqliteStateStore,
	makeObservabilityEvent,
	ObservabilityEventBoundary,
	queryObservabilityEvents,
	chainBindings,
	engineLifecycleAdmittedItemStatus,
	itemExtraToJsonObject,
	parseInternalStatus,
	storedChainMetadata,
	storedItemExtra,
	parseHookDeclarations,
	REPO_ROOT,
	LOOP_ENTRY,
	TEST_ROOT,
	PRESET_DIR,
	runtimeStatus,
	observabilityTaskIdentity,
	staleRecoveryRunExtra,
	writeCredentialedFixturePreset,
	emptyObservabilityExcerpt,
	daemonDecisionFingerprintState,
	FakeRunnerRunningEventBoundary,
	StatusArtifactBoundary,
	StatusSnapshotBoundary,
	FAKE_RUNNER_STATUS_WRITE_SNIPPET,
	FAKE_RUNNER_CREDENTIALED_STATUS_WRITE_SNIPPET,
	startPhaseAdvancementFixture,
	startChainBasedRunnerFixture,
	assertNeverQueueUnblockOutcomeScenario,
	startQueueUnblockGateFixture,
	startFixture,
	request,
	injectTestPresetDefault,
	expectOk,
	expectInvalid,
	expectInvalidDetails,
	expectChainDeleted,
	expectChainNotActive,
	expectConflict,
	expectTooLarge,
	record,
	deferred,
	sendLinesOnDaemonConnection,
	testDaemonResponse,
	nestedMetadata,
	numberValue,
	stringValue,
	present,
	readChainStatus,
	readChain,
	readItem,
	readRun,
	listChainRuns,
	readCurrentRun,
	waitFor,
	waitForItemQueueTerminal,
	waitForItemPhaseEnd,
	waitForPidExit,
	isPidAlive,
	pathExists,
	pathIsSocket,
	initGitTarget,
	gitOutput,
	writeFakeRunner,
	writeCredentialedFakeRunner,
	writePromptCaptureRunner,
	writeSinglePhasePromptPreset,
}

export type {
	CoderLoopDaemon,
	CoderLoopDaemonSchedulerConfig,
	DaemonResponse,
	DaemonRateLimitState,
	AgentRunnerKind,
	JsonObject,
	JsonValue,
	SchedulerEvent,
	SchedulerOptions,
	SchedulerWorktreeManager,
	BoundaryRecord,
	BoundaryValue,
	GateHookDeclaration,
	ObserverHookDeclaration,
	PresetHookPlaceholder,
	PhaseAdvancementFixture,
	ChainBasedRunnerFixture,
	QueueUnblockGateOptions,
	QueueUnblockOutcomeScenario,
	Fixture,
	FixtureOptions,
	TestDaemonResponse,
}
