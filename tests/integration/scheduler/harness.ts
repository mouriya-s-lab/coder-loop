import { afterAll } from "bun:test"
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import {
	cleanupSchedulerChainWorktrees,
	createGitWorktreeManager,
	createSchedulerState,
	DEFAULT_MAX_ITEM_ATTEMPTS,
	listActiveRuns,
	makeRunId,
	markRunPendingRecycle,
	presetExecutionContentIdentity,
	renderSchedulerSpawnPrompt,
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
} from "../../../src/scheduler"
import { resolveSchedulerEventTaskIdentity, schedulerEventToObservabilityEvent, startCoderLoopDaemon, type CoderLoopDaemon } from "../../../src/daemon"
import {
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
	loadPreset,
	resolvePhaseRunnerFromChain,
	runPresetChainCompleteTriggerPhases,
	substitutePresetRootToken,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type JsonObject,
} from "../../../src/loop"
import { resolveChainRuntimePaths, resolveLoopDataPaths } from "../../../src/runtime-paths"
import { type ChainRecord, type ItemRecord, openSqliteStateStore } from "../../../src/sqlite-state"
import { appendObservabilityEvent, queryObservabilityEvents } from "../../../src/observability"
import { chainMetadataToJsonObject, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")

export function runnerAuthorizationForTest(agentCwd: string, presetDir: string, loopDataRoot: string) {
	return buildRunnerFilesystemAuthorization({
		agentCwd, presetDir, loopDataRoot,
		sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"), currentIssueFile: "",
		issueDir: resolve(loopDataRoot, "chains/c/issues"), evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"),
		evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"), logDir: resolve(loopDataRoot, "chains/c/runs"),
		daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
		declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
	})
}
export const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests", String(process.pid))
export const RunStatusFixtureBoundary = arkType({
	"runId?": "string",
	"chainId?": "number",
	"chainName?": "string",
	"rowId?": "number",
	"itemId?": "string",
	"phase?": "string",
	status: "string",
	exitCode: "number",
	endedAt: "number",
	"eventsPath?": "string",
})
export const ArgvEventBoundary = arkType({ argv: "string[]" })

export function optionsWithoutRunner(options: SchedulerOptions): SchedulerOptions {
	const { runner: _runner, ...withoutRunner } = options
	return withoutRunner
}

export let nextFixtureId = 0
export const fixtureDaemons = new Set<CoderLoopDaemon>()
export const fixturePresetDirs = new WeakMap<ReturnType<typeof openSqliteStateStore>, string>()
export const fixtureCaptureRoots = new WeakMap<ReturnType<typeof openSqliteStateStore>, string>()

// #397 test brand helper — see install-commands.test.ts for rationale.
export function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

export function historicalRunExtra(extra: JsonObject = {}) {
	return storedItemExtra({
		definitionKind: "chain",
		definitionContentIdentity: "sha256:scheduler-history-fixture",
		definitionPhases: [
			{ phase: "iteration", definitionNodeId: "task:iteration" },
			{ phase: "review", definitionNodeId: "task:review" },
		],
		worktreePath: REPO_ROOT,
		branchName: "scheduler-history-fixture",
		baseCommit: "0123456789abcdef",
		...extra,
	})
}

export function seedSessionClosure(store: ReturnType<typeof openSqliteStateStore>, chain: ChainRecord, item: ItemRecord, phase: string): void {
	const definitionRef = { kind: "chain", contentIdentity: "sha256:session-fixture" } as const
	store.createTaskTree(chain.id, {
		root: {
			kind: "leaf",
			identity: { runtimeNodeId: `session-leaf-${item.id}`, definitionRef, definitionNodeId: phase },
			closure: { closureId: `session-closure-${item.id}`, itemRowId: item.id, itemId: item.itemId, phase, lifecycle: "active", worktreePath: REPO_ROOT, branchName: "main", baseCommit: "0123456789abcdef", sourceParNodeId: null, sessions: [] },
		},
		activeRuns: [],
	})
}

afterAll(async () => {
	await Promise.all([...fixtureDaemons].map((daemon) => daemon.stop()))
	await rm(TEST_ROOT, { recursive: true, force: true })
})

export async function writeFakeClaudeSessionRunner(path: string, sessionId: string): Promise<void> {
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

export async function writeFakeClaudeArgvEchoRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`console.log(JSON.stringify({ argv: Bun.argv }))
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=argv-echo" }] } }))
process.exitCode = 0
`,
		)
	}

export async function writeFakeClaudeInvalidOnceRunner(path: string, freshSessionId: string): Promise<void> {
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

export async function writeFakeClaudeNormalSessionRunner(path: string, sessionId: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`console.error("ordinary stderr warning")
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }))
process.exitCode = 0
`,
	)
}

export async function writeFakeCodexSessionShellRunner(path: string, threadId: string): Promise<void> {
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

export async function readArgvEvents(path: string): Promise<Array<{ argv: string[] }>> {
	const text = await readFile(path, "utf-8")
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => ArgvEventBoundary.assert(JSON.parse(line)))
}

export async function writeShellFinalizerMarkerScript(path: string, marker: string): Promise<void> {
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
export type ChainFixtureOverrides = Partial<ChainRecord> & {
	umbrellaIssue?: number | null
	umbrellaRepo?: string | null
}

export function makeChainFixture(overrides: ChainFixtureOverrides = {}): ChainRecord {
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
export type MakeItemFixtureOverrides = Partial<Omit<ItemRecord, "extra">> & {
	extra?: ItemRecord["extra"]
	issueNumber?: number
	branch?: string | null
	pr?: number | null
	repoCwd: string
}

export function makeItemFixture(chain: ChainRecord, overrides: MakeItemFixtureOverrides): ItemRecord {
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

export async function writeBunMarkerRunner(path: string, marker: string): Promise<void> {
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

export async function writeShellMarkerScript(path: string, marker: string): Promise<void> {
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

export async function initGitTarget(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
	gitOutput(path, ["init", "-q"])
	gitOutput(path, ["config", "user.email", "test@example.invalid"])
	gitOutput(path, ["config", "user.name", "Test User"])
	await writeFile(resolve(path, "README.md"), "test\n")
	gitOutput(path, ["add", "README.md"])
	gitOutput(path, ["commit", "-qm", "init"])
}

export function gitOutput(cwd: string, args: readonly string[]): string {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	const stdout = new TextDecoder().decode(proc.stdout).trim()
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim()
		throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${proc.exitCode}): ${stderr}`)
	}
	return stdout
}

export type Fixture = {
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

export async function stopFixture(fixture: Fixture): Promise<void> {
	if (fixture.daemon !== undefined) {
		await fixture.daemon.stop()
		fixtureDaemons.delete(fixture.daemon)
	}
	fixture.store.close()
}

export type SchedulerFixtureOverrides = Partial<Omit<SchedulerOptions, "presetForChain">> & {
	loadedPreset?: SchedulerLoadedPreset
}

export type RunnerEvent = {
	type: "start" | "end"
	itemId: number
	issueNumber: number
	runId: string
	cwd: string
}
export const RunnerEventBoundary = arkType({
	type: "'start'|'end'",
	itemId: "number",
	issueNumber: "number",
	runId: "string",
	cwd: "string",
})

export async function createFixture(name: string): Promise<Fixture> {
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
		initializeFixtureGitWorktree(worktreePath)
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
			const writeStatus = fakeRunnerWriteStatus(phase, extra)
			const payload: JsonObject = {
				itemId: item.id,
				issueNumber: Number(item.itemId),
				chainName: chain.name,
				runId,
				worktreePath,
				eventLog: eventLogForChain(chain.name),
				sleepMs: typeof extra.sleepMs === "number" ? extra.sleepMs : 5,
				...(typeof extra.waitForConcurrentStarts === "number" ? { waitForConcurrentStarts: extra.waitForConcurrentStarts } : {}),
				exitCode: typeof extra.exitCode === "number" ? extra.exitCode : 0,
				// v1 status model: the fake runner writes this status to the store itself, simulating the
				// real agent's `coder-loop item update --status`. The scheduler only reads item.status; it
				// never derives status from the runner's stdout or exit code.
				...(writeStatus === undefined ? {} : { writeStatus }),
			}
			if (extra.summary !== undefined) payload.summary = extra.summary
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

export function persistedObservabilityOptions(fixture: Fixture, overrides: SchedulerFixtureOverrides = {}): SchedulerOptions {
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

export async function appendPersistedSchedulerEvent(fixture: Fixture, event: SchedulerEvent): Promise<void> {
	const chain = fixture.store.getChain(event.chainId)
	if (chain === null) throw new Error(`missing chain ${event.chainId} for scheduler event ${event.type}`)
	const identity = resolveSchedulerEventTaskIdentity(fixture.store, chain, event)
	await appendObservabilityEvent(
		resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
		schedulerEventToObservabilityEvent(chain, event, identity),
	)
}

export async function loadedPresetFromDir(presetDir: string): Promise<SchedulerLoadedPreset> {
	return { presetDir, preset: await loadPreset(presetDir) }
}

// #457: chain umbrella values now flow through `metadata.bindings.umbrellaIssue / umbrellaRepo`.
// Fixture helper accepts `umbrellaIssue` / `umbrellaRepo` as shorthand overrides and folds them into
// metadata so call sites do not have to change shape. Engine code never sees the shorthand.
export type CreateChainShorthandOverrides = Omit<Partial<Parameters<ReturnType<typeof openSqliteStateStore>["createChain"]>[0]>, "metadata"> & {
	metadata?: JsonObject
	umbrellaIssue?: number | null
	umbrellaRepo?: string | null
}

export function createChain(
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

export function createItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	input: { issueNumber: number; repoCwd: string; sleepMs?: number; waitForConcurrentStarts?: number; exitCode?: number; summary?: string | null; runner?: AgentRunnerKind | null; writeStatus?: string | null; captureArgv?: string; probeNullDevice?: boolean },
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
	if (input.waitForConcurrentStarts !== undefined) extra.waitForConcurrentStarts = input.waitForConcurrentStarts
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

export async function writeFakeRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	const loopEntry = resolve(REPO_ROOT, "src/loop.ts")
	await writeFile(
		path,
		`#!/usr/bin/env bun
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { type as arkType } from "arktype"

const FakeRunnerInputBoundary = arkType({
	itemId: "number",
	issueNumber: "number",
	chainName: "string",
	runId: "string",
	worktreePath: "string",
	eventLog: "string",
	sleepMs: "number",
	"waitForConcurrentStarts?": "number",
	exitCode: "number",
	"writeStatus?": arkType.or("string", "null"),
	"summary?": arkType.or("string", "null"),
	"captureArgv?": "string",
	"probeNullDevice?": "boolean",
	"+": "reject",
})
const FakeRunnerEventBoundary = arkType({
	type: "'start'|'end'",
	itemId: "number",
	issueNumber: "number",
	runId: "string",
	cwd: "string",
	"+": "reject",
})
function parseFakeRunnerInput(serialized: string) {
	return FakeRunnerInputBoundary.assert(JSON.parse(serialized))
}
function parseFakeRunnerEvent(line: string) {
	return FakeRunnerEventBoundary.assert(JSON.parse(line))
}

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? Bun.argv.at(-1) ?? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = parseFakeRunnerInput(prompt.split("\\n")[0] ?? prompt)
if (typeof input.captureArgv === "string") await writeFile(input.captureArgv, JSON.stringify(Bun.argv.slice(2)))
if (input.probeNullDevice === true) await writeFile("/dev/null", "probe")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
if (typeof input.waitForConcurrentStarts === "number") {
	const deadline = Date.now() + 5_000
	while (true) {
		const events = (await readFile(input.eventLog, "utf-8")).trim().split("\\n").filter(Boolean).map(parseFakeRunnerEvent)
		if (events.filter((event) => event.type === "start").length >= input.waitForConcurrentStarts) break
		if (Date.now() >= deadline) throw new Error("timed out waiting for concurrent runner starts")
		await Bun.sleep(5)
	}
}
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

export async function writeThreeStepPreset(presetDir: string): Promise<void> {
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

export async function writeEmptySuccessPreset(presetDir: string): Promise<void> {
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
export async function writeCustomExhaustedPreset(presetDir: string): Promise<void> {
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
export async function writeMissingExhaustedDeclarationPreset(presetDir: string): Promise<void> {
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
export const TRIGGER_PHASES = new Set(["blocked-responder", "umbrella-finalizer"])

export function fakeRunnerWriteStatus(phase: string, extra: JsonObject): string | null {
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
export function makeAttemptTrackingRunIdFactory(): (context: { chain: { id: number }; item: { id: number }; phase: string }) => string {
	const attempts = new Map<string, number>()
	return ({ chain, item, phase }) => {
		const key = `${chain.id}-${item.id}-${phase}`
		const next = (attempts.get(key) ?? 0) + 1
		attempts.set(key, next)
		return `run-${chain.id}-${item.id}-${phase}-${next}`
	}
}

export async function readRunnerEvents(path: string): Promise<RunnerEvent[]> {
	const text = await readFile(path, "utf-8")
	return text.trim().split("\n").filter(Boolean).map((line) => RunnerEventBoundary.assert(JSON.parse(line)))
}

export function maxConcurrentRunnerEvents(events: RunnerEvent[]): number {
	let active = 0
	let max = 0
	for (const event of events) {
		if (event.type === "start") active += 1
		if (event.type === "end") active -= 1
		max = Math.max(max, active)
	}
	return max
}

export function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
	let resolve: () => void = () => {}
	let reject: (reason?: unknown) => void = () => {}
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

export async function promiseSettledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
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

export async function createPresetPromptIntegrationFixture(name: string): Promise<Fixture> {
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
		initializeFixtureGitWorktree(worktreePath)
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

export function initializeFixtureGitWorktree(worktreePath: string): void {
	if (existsSync(resolve(worktreePath, ".git"))) return
	for (const command of [
		["git", "init", "-b", "main"],
		["git", "config", "user.email", "fixture@example.invalid"],
		["git", "config", "user.name", "coder-loop fixture"],
		["git", "commit", "--allow-empty", "-m", "fixture base"],
	]) {
		const result = Bun.spawnSync({ cmd: command, cwd: worktreePath, stdout: "ignore", stderr: "pipe" })
		if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
	}
}

export async function writeEchoPromptRunner(path: string): Promise<void> {
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


export {
	chmod, cp, mkdir, readFile, rm, writeFile, existsSync, resolve, arkType,
	cleanupSchedulerChainWorktrees, createGitWorktreeManager, createSchedulerState, DEFAULT_MAX_ITEM_ATTEMPTS,
	listActiveRuns, makeRunId, markRunPendingRecycle, presetExecutionContentIdentity, renderSchedulerSpawnPrompt,
	resumeDecisionForItem, runSchedulerUntilIdle, schedulerSlotWorktreePath, schedulerTick,
	selectNextPendingItemFromSnapshot,
	resolveSchedulerEventTaskIdentity, schedulerEventToObservabilityEvent, startCoderLoopDaemon,
	buildRunnerFilesystemAuthorization, buildRunnerInvocation, loadPreset, resolvePhaseRunnerFromChain,
	runPresetChainCompleteTriggerPhases, substitutePresetRootToken,
	resolveChainRuntimePaths, resolveLoopDataPaths, openSqliteStateStore,
	appendObservabilityEvent, queryObservabilityEvents,
	chainMetadataToJsonObject, engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus,
	storedChainMetadata, storedItemExtra,
}
export type {
	SchedulerEvent, SchedulerLifecycleEventPersistenceFailure, SchedulerLoadedPreset, SchedulerOptions,
	SchedulerPhaseRunner, SchedulerWorktreeManager, CoderLoopDaemon, AgentRunnerKind, AgentRunnerSelection,
	JsonObject, ChainRecord, ItemRecord,
}
