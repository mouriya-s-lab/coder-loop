import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	createSchedulerState,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerPhaseRunner,
	type SchedulerWorktreeManager,
} from "../../../src/scheduler"
import { closureWorktreePath } from "../../../src/closure-lifecycle"
import { loadPreset, type JsonObject } from "../../../src/loop"
import { startCoderLoopDaemon, type CoderLoopDaemon } from "../../../src/daemon"
import { type ChainRecord, openSqliteStateStore } from "../../../src/sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../../../src/runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const LOADED_PRESET = loadPreset(PRESET_DIR).then((preset) => ({ presetDir: PRESET_DIR, preset }))
const FAKE_RUNNER = resolve(import.meta.dir, "cross-runner.integration.fake.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-cross-runner-integration-tests", String(process.pid))

let nextFixtureId = 0

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

test("cross-runner happy path stores iteration/codex and review/claude session ids independently", async () => {
	const fixture = await createCrossRunnerFixture("happy-path", [
		{
			runner: "codex",
			phase: "iteration",
			sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5593",
			stdout: ["ITERATION SUMMARY: scope=cross-runner; reason=iteration-complete"],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: "019e6cf2-5b39-7b83-9bc5-8c8b96122682",
			stdout: ["PHASE DONE: issue=#31601; reason=review-complete"],
			writeStatus: "done",
		},
	])
	try {
		const chain = createChain(fixture.store, "cross-runner-happy-chain")
		const item = createItem(fixture.store, chain, 316_001)
		const options = fixture.options()

		const iterTick = await schedulerTick(options)
		expect(iterTick.spawnedRuns).toHaveLength(1)
		const iterClosed = await iterTick.spawnedRuns[0]!.closed
		expect(iterClosed.status).toBe("queued")
		expect(fixture.store.getItem(item.id)?.phase).toBe("iteration")
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")

		const reviewTick = await schedulerTick(options)
		expect(reviewTick.spawnedRuns).toHaveLength(1)
		const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
		expect(reviewClosed.status).toBe("done")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("done")

		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "codex" })).toBeNull()

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}:${event.resumedSessionId ?? "fresh"}`)).toEqual([
			"codex:iteration:fresh",
			"claude:review:fresh",
		])
		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review"])
	} finally {
		await stopCrossRunnerFixture(fixture)
	}
})

test("review writing changes_requested returns to iteration before review runs again", async () => {
	const fixture = await createCrossRunnerFixture("review-retry", [
		{
			runner: "codex",
			phase: "iteration",
			sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5593",
			stdout: ["ITERATION SUMMARY: scope=cross-runner; reason=iteration-complete"],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: "019e6cf2-5b39-7b83-9bc5-8c8b96122682",
			stdout: ["PHASE DONE: issue=#31602; reason=review-wants-changes"],
			writeStatus: "changes_requested",
		},
		{
			runner: "codex",
			phase: "iteration",
			sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5594",
			stdout: ["ITERATION SUMMARY: scope=cross-runner; reason=retry-iteration-complete"],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: "019e6cf2-5b39-7b83-9bc5-8c8b96122683",
			stdout: ["PHASE DONE: issue=#31602; reason=review-retry-complete"],
			writeStatus: "done",
		},
	])
	try {
		const chain = createChain(fixture.store, "cross-runner-review-retry-chain")
		const item = createItem(fixture.store, chain, 316_002)
		const options = fixture.options()

		await closeOnlySpawn(await schedulerTick(options))
		const retryReviewTick = await schedulerTick(options)
		expect(retryReviewTick.spawnedRuns).toHaveLength(1)
		const retryReviewClosed = await retryReviewTick.spawnedRuns[0]!.closed
		expect(retryReviewClosed.status).toBe("changes_requested")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")

		const retryIterationTick = await schedulerTick(options)
		expect(retryIterationTick.spawnedRuns).toHaveLength(1)
		const retryIterationClosed = await retryIterationTick.spawnedRuns[0]!.closed
		expect(retryIterationClosed.status).toBe("changes_requested")
		expect(fixture.store.getItem(item.id)?.phase).toBe("iteration")
		expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")

		const acceptedReviewTick = await schedulerTick(options)
		expect(acceptedReviewTick.spawnedRuns).toHaveLength(1)
		const acceptedReviewClosed = await acceptedReviewTick.spawnedRuns[0]!.closed
		expect(acceptedReviewClosed.status).toBe("done")
		expect(fixture.store.getItem(item.id)?.status).toBe("done")

		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review", "iteration", "review"])
		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}`)).toEqual([
			"codex:iteration",
			"claude:review",
			"codex:iteration",
			"claude:review",
		])
		expect(fakeEvents[2]?.resumedSessionId).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
		expect(fakeEvents[3]?.resumedSessionId).toBe("019e6cf2-5b39-7b83-9bc5-8c8b96122682")
	} finally {
		await stopCrossRunnerFixture(fixture)
	}
})

test("invalid review session id clears only review/claude and the next review spawn is fresh", async () => {
	const staleReviewSessionId = "019e6cf2-5b39-7b83-9bc5-8c8b96122684"
	const freshReviewSessionId = "019e6cf2-5b39-7b83-9bc5-8c8b96122685"
	const fixture = await createCrossRunnerFixture("review-session-invalid", [
		{
			runner: "codex",
			phase: "iteration",
			sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5593",
			stdout: ["ITERATION SUMMARY: scope=cross-runner; reason=iteration-complete"],
		},
		{
			runner: "claude",
			phase: "review",
			exitCode: 1,
			sessionId: staleReviewSessionId,
			stderr: ["transient review failure"],
		},
		{
			runner: "claude",
			phase: "review",
			exitCode: 1,
			stderr: [`No conversation found with session ID: ${staleReviewSessionId}`],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: freshReviewSessionId,
			stdout: ["PHASE DONE: issue=#31603; reason=fresh-review-complete"],
			writeStatus: "done",
		},
	])
	try {
		let now = 1_800_316_000
		const chain = createChain(fixture.store, "cross-runner-invalid-session-chain")
		const item = createItem(fixture.store, chain, 316_003)
		const options = fixture.options({
			now: () => now,
			spawnFailureBackoff: { initialSeconds: 1, maxSeconds: 2 },
		})

		await closeOnlySpawn(await schedulerTick(options))
		await closeOnlySpawn(await schedulerTick(options))
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe(staleReviewSessionId)

		now += 1
		const invalidReviewTick = await schedulerTick(options)
		expect(invalidReviewTick.spawnedRuns).toHaveLength(1)
		const invalidReviewClosed = await invalidReviewTick.spawnedRuns[0]!.closed
		expect(invalidReviewClosed.exitCode).toBe(1)
		expect(invalidReviewClosed.status).toBe("queued")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
		expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
			type: "session_id.invalidated",
			itemId: item.id,
			phase: "review",
			runner: "claude",
			previousSessionId: staleReviewSessionId,
		}))

		now += 2
		const freshReviewTick = await schedulerTick(options)
		expect(freshReviewTick.spawnedRuns).toHaveLength(1)
		const freshReviewClosed = await freshReviewTick.spawnedRuns[0]!.closed
		expect(freshReviewClosed.status).toBe("done")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBeNull()

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}:${event.resumedSessionId ?? "fresh"}`)).toEqual([
			"codex:iteration:fresh",
			"claude:review:fresh",
			`claude:review:${staleReviewSessionId}`,
			"claude:review:fresh",
		])
		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review", "review", "review"])
	} finally {
		await stopCrossRunnerFixture(fixture)
	}
})

// #528: binary-independent lock for opencode's invalid-session path. The existing claude-side
// test above covers the equivalent shape for claude/review; opencode has no equivalent until
// now, so a regression in `OPENCODE_SESSION_ID_INVALID` or in scheduler's opencode-stderr
// handling would only surface through real-binary e2e (issue #481 / #526 acceptance row 6).
// The scheduler/runner integration here mirrors the claude case so that the detector → emit
// `session_id.invalidated` → clear `session_ids` chain is verified entirely from source —
// the stderr fixture uses the **exact byte shape** produced by `opencode 1.17.5` (ANSI CSI
// SGR red/bold wrapping `Error: ` and a `\x1b[0m` reset before `Session not found`), which
// the operator captured via a `opencode run -s <fake> noop` probe on 2026-06-28 (see
// PR body Layer 1 of #528).
test("invalid review session id on opencode clears only review/opencode and the next review spawn is fresh", async () => {
	const staleReviewSessionId = "ses_FAKE_INVALID_REVIEW_OPENCODE_AAA"
	const freshReviewSessionId = "ses_b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2"
	// Exact ANSI byte shape captured from `opencode run -s ses_FAKE_INVALID_DOES_NOT_EXIST_XYZ "noop"`
	// (opencode 1.17.5 on macOS, 2026-06-28). The detector strips CSI before matching so the regex
	// must still succeed on this exact wrapping; if the binary later changes the prefix or the
	// reset position, this test stays valid because the detector is stripping ANSI, not the test.
	const opencodeInvalidStderr = "\x1b[91m\x1b[1mError: \x1b[0mSession not found\n"
	const fixture = await createCrossRunnerFixture("review-session-invalid-opencode", [
		{
			runner: "codex",
			phase: "iteration",
			sessionId: "d400e2b2-04a4-44f8-8f13-3078f41a5594",
			stdout: ["ITERATION SUMMARY: scope=cross-runner; reason=iteration-complete"],
		},
		{
			runner: "opencode",
			phase: "review",
			exitCode: 1,
			sessionId: staleReviewSessionId,
			stderr: ["transient review failure"],
		},
		{
			runner: "opencode",
			phase: "review",
			exitCode: 1,
			stderr: [opencodeInvalidStderr],
		},
		{
			runner: "opencode",
			phase: "review",
			sessionId: freshReviewSessionId,
			stdout: ["PHASE DONE: issue=#31604; reason=fresh-review-complete"],
			writeStatus: "done",
		},
	])
	try {
		let now = 1_800_316_500
		const chain = createChain(fixture.store, "cross-runner-invalid-session-chain-opencode")
		const item = createItem(fixture.store, chain, 316_004)
		const options = fixture.options({
			now: () => now,
			spawnFailureBackoff: { initialSeconds: 1, maxSeconds: 2 },
			phaseRunner: ({ phase }) =>
				phase === "review"
					? { kind: "opencode", source: "preset", binary: fixture.wrappers.opencode, extraArgs: [], model: null }
					: { kind: "codex", source: "iteration-default", binary: fixture.wrappers.codex, extraArgs: [], model: null },
		})

		await closeOnlySpawn(await schedulerTick(options))
		await closeOnlySpawn(await schedulerTick(options))
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "opencode" })).toBe(staleReviewSessionId)

		now += 1
		const invalidReviewTick = await schedulerTick(options)
		expect(invalidReviewTick.spawnedRuns).toHaveLength(1)
		const invalidReviewClosed = await invalidReviewTick.spawnedRuns[0]!.closed
		expect(invalidReviewClosed.exitCode).toBe(1)
		expect(invalidReviewClosed.status).toBe("queued")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		// Only review/opencode was cleared; iteration/codex must remain.
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "opencode" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5594")
		expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
			type: "session_id.invalidated",
			itemId: item.id,
			phase: "review",
			runner: "opencode",
			previousSessionId: staleReviewSessionId,
			reason: "runner_session_id_invalid",
		}))

		now += 2
		const freshReviewTick = await schedulerTick(options)
		expect(freshReviewTick.spawnedRuns).toHaveLength(1)
		const freshReviewClosed = await freshReviewTick.spawnedRuns[0]!.closed
		expect(freshReviewClosed.status).toBe("done")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "opencode" })).toBeNull()

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}:${event.resumedSessionId ?? "fresh"}`)).toEqual([
			"codex:iteration:fresh",
			"opencode:review:fresh",
			`opencode:review:${staleReviewSessionId}`,
			"opencode:review:fresh",
		])
		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review", "review", "review"])
	} finally {
		await stopCrossRunnerFixture(fixture)
	}
})

test("exhausts on the declared attempt budget", async () => {
	// Neither failing agent writes a status. A failed iteration run does not structurally advance to the
	// next phase; it retries iteration after the persisted backoff and exhausts at the attempt cap.
	const fixture = await createCrossRunnerFixture("max-attempts", [
		{ runner: "codex", phase: "iteration", exitCode: 1, stderr: ["forced failure 1"] },
		{ runner: "claude", phase: "review", exitCode: 1, stderr: ["forced failure 2"] },
	])
	try {
		let now = 1_800_317_000
		const chain = createChain(fixture.store, "cross-runner-max-attempts-chain", {
			metadata: { maxItemAttempts: 2 },
		})
		const item = createItem(fixture.store, chain, 316_004)
		const options = fixture.options({
			now: () => now,
			spawnFailureBackoff: { initialSeconds: 1, maxSeconds: 2 },
		})

		const firstTick = await schedulerTick(options)
		expect(firstTick.spawnedRuns).toHaveLength(1)
		await firstTick.spawnedRuns[0]!.closed
		expect(fixture.store.getItem(item.id)?.attempts).toBe(1)

		now += 1
		const secondTick = await schedulerTick(options)
		expect(secondTick.spawnedRuns).toHaveLength(1)
		await secondTick.spawnedRuns[0]!.closed
		expect(fixture.store.getItem(item.id)?.attempts).toBe(2)

		now += 2
		const exhaustedTick = await schedulerTick(options)
		expect(exhaustedTick.spawnedRuns).toHaveLength(0)
		expect(fixture.store.getItem(item.id)?.status).toBe("exhausted")
		expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toBeUndefined()
		expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)).toHaveLength(2)
		expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
			type: "queue.terminal",
			// #419 review I2: scheduler event field renamed `itemId` (rowid) → `rowId`.
			rowId: item.id,
			terminalStatus: "exhausted",
		}))

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}`)).toEqual([
			"codex:iteration",
			"codex:iteration",
		])
	} finally {
		await stopCrossRunnerFixture(fixture)
	}
})

type RunnerKind = "claude" | "codex" | "opencode"

type FakeRunnerResponse = {
	runner: RunnerKind
	phase: string
	exitCode?: number
	sessionId?: string | null
	stdout?: string[]
	stderr?: string[]
	// v1 status model: the fake agent writes this status to the shared store before exiting, mirroring
	// `coder-loop item update --status`. The scheduler reads it as the single source of truth.
	writeStatus?: string
}

type FakeRunnerEvent = {
	type: "spawn"
	responseIndex: number
	runner: RunnerKind
	phase: string
	runId: string
	issueNumber: number | null
	resumedSessionId: string | null
	argv: string[]
}

type CrossRunnerFixture = {
	store: ReturnType<typeof openSqliteStateStore>
	daemon: CoderLoopDaemon
	state: ReturnType<typeof createSchedulerState>
	loopDataRoot: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
	// #528: tests that need to swap a phase off the default claude/codex pairing reach into the
	// wrappers directly (e.g., to put opencode on iteration). The fixture exposes them so each
	// test can build its own `phaseRunner` override without re-deriving paths.
	wrappers: { codex: string; claude: string; opencode: string }
	options: (overrides?: Partial<SchedulerOptions>) => SchedulerOptions
}

const crossRunnerCaptureRoots = new WeakMap<ReturnType<typeof openSqliteStateStore>, string>()

async function stopCrossRunnerFixture(fixture: CrossRunnerFixture): Promise<void> {
	await fixture.daemon.stop()
	fixture.store.close()
}

async function createCrossRunnerFixture(name: string, responses: FakeRunnerResponse[]): Promise<CrossRunnerFixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "loop-data")
	const evidenceDir = resolve(loopDataRoot, "fixture-evidence")
	const eventLog = resolve(evidenceDir, "cross-runner-events.jsonl")
	const planPath = resolve(evidenceDir, "cross-runner-plan.json")
	const codexWrapper = resolve(root, "fake-codex.sh")
	const claudeWrapper = resolve(root, "fake-claude.sh")
	const opencodeWrapper = resolve(root, "fake-opencode.sh")
	await mkdir(evidenceDir, { recursive: true })
	await writeFile(planPath, JSON.stringify({ responses }, null, 2))
	await writeRunnerWrapper(codexWrapper, planPath, eventLog, "codex", loopDataRoot)
	await writeRunnerWrapper(claudeWrapper, planPath, eventLog, "claude", loopDataRoot)
	await writeRunnerWrapper(opencodeWrapper, planPath, eventLog, "opencode", loopDataRoot)

	const store = openSqliteStateStore({ loopDataRoot })
	crossRunnerCaptureRoots.set(store, evidenceDir)
	const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
	const state = daemon.schedulerExecutionState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd, closureId }) => {
		const worktreePath = closureWorktreePath(loopDataRoot, chain.name, repoCwd, closureId)
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}
	const phaseRunner: SchedulerPhaseRunner = ({ phase }) =>
		phase === "review"
			? { kind: "claude", source: "review-default", binary: claudeWrapper, extraArgs: [], model: null }
			: { kind: "codex", source: "iteration-default", binary: codexWrapper, extraArgs: [], model: null }
	let runSequence = 0

	const options = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
		store,
		state,
		presetForChain: () => LOADED_PRESET,
		phaseRunner,
		worktreeManager,
		loopDataRootOptions: { loopDataRoot },
		runCredentials: daemon.buildSchedulerRunCredentialIssuer(),
		runIdFactory: ({ chain, item, phase }) => `run-${chain.id}-${item.id}-${phase}-${++runSequence}`,
		prompt: ({ chain, item, runId, phase }) => JSON.stringify({
			itemId: item.id,
			issueNumber: Number(item.itemId),
			chainName: chain.name,
			runId,
			phase,
		}),
		onEvent: (event) => {
			schedulerEvents.push(event)
		},
		...overrides,
	})

	return {
		store,
		daemon,
		state,
		loopDataRoot,
		eventLog,
		schedulerEvents,
		wrappers: { codex: codexWrapper, claude: claudeWrapper, opencode: opencodeWrapper },
		options,
	}
}

async function writeRunnerWrapper(path: string, planPath: string, eventLog: string, runner: RunnerKind, loopDataRoot: string): Promise<void> {
	await writeFile(
		path,
		[
			"#!/bin/sh",
			`exec bun ${shellQuote(FAKE_RUNNER)} ${shellQuote(planPath)} ${shellQuote(eventLog)} ${runner} ${shellQuote(loopDataRoot)} "$@"`,
			"",
		].join("\n"),
	)
	await chmod(path, 0o755)
}

function createChain(
	store: ReturnType<typeof openSqliteStateStore>,
	name: string,
	overrides: Omit<Partial<Parameters<typeof store.createChain>[0]>, "metadata"> & { metadata?: JsonObject } = {},
): ChainRecord {
	const { metadata, ...rest } = overrides
	// #457: umbrella values now flow through metadata.bindings rather than first-class chain columns.
	const resolvedMetadata = metadata !== undefined && Object.hasOwn(metadata, "bindings")
		? metadata
		: { ...(metadata ?? {}), bindings: { umbrellaIssue: 309, umbrellaRepo: "mouriya-s-lab/coder-loop" } }
	return store.createChain({
		name,
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		status: "active",
		metadata: storedChainMetadata(resolvedMetadata),
		createdAt: 1_800_316_000,
		updatedAt: 1_800_316_000,
		...rest,
	})
}

function createItem(store: ReturnType<typeof openSqliteStateStore>, chain: ChainRecord, issueNumber: number) {
	return store.createItem({
		chainId: chain.id,
		itemId: String(issueNumber),
		repoCwd: REPO_ROOT,
		evidenceDir: crossRunnerCaptureRoots.get(store) ?? null,
		status: runtimeStatus("queued"),
		attempts: 0,
		title: `issue ${issueNumber}`,
		extra: storedItemExtra({}),
		createdAt: 1_800_316_001 + issueNumber,
		updatedAt: 1_800_316_001 + issueNumber,
	})
}

// #456: the legacy chain-drain auto-fire suppressor helper retired with the path itself; the
// cross-runner integration tests now rely on the DSL chain-complete trigger driver only.

async function closeOnlySpawn(tick: { spawnedRuns: Array<{ closed: Promise<unknown> }> }): Promise<void> {
	expect(tick.spawnedRuns).toHaveLength(1)
	await tick.spawnedRuns[0]!.closed
}

async function readFakeRunnerEvents(path: string): Promise<FakeRunnerEvent[]> {
	const text = await readFile(path, "utf-8")
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as FakeRunnerEvent)
}

function phaseStarts(events: SchedulerEvent[], itemId: number): string[] {
	return events
		.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
			event.type === "phase.start" && event.itemId === itemId,
		)
		.map((event) => event.phase)
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}
