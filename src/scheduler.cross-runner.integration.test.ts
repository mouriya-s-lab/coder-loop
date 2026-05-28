import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import {
	createSchedulerState,
	reviewOnEmptyLockPathForChain,
	schedulerSlotWorktreePath,
	schedulerTick,
	serializeSchedulerReviewOnEmptyLock,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerPhaseRunner,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { type ChainRecord, openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const FAKE_RUNNER = resolve(REPO_ROOT, "tests/fixtures/cross-runner-fake.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-cross-runner-integration-tests", String(process.pid))

let nextFixtureId = 0

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
			stdout: ["REVIEW SUMMARY: verdict=accepted; issue=#31601; reason=review-complete"],
		},
	])
	try {
		const chain = createChain(fixture.store, "cross-runner-happy-chain")
		await preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
		const item = createItem(fixture.store, chain, 316_001)
		const options = fixture.options()

		const iterTick = await schedulerTick(options)
		expect(iterTick.spawnedRuns).toHaveLength(1)
		const iterClosed = await iterTick.spawnedRuns[0]!.closed
		expect(iterClosed.status).toBe("in_progress")
		expect(fixture.store.getItem(item.id)?.phase).toBe("iteration")

		const reviewTick = await schedulerTick(options)
		expect(reviewTick.spawnedRuns).toHaveLength(1)
		const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
		expect(reviewClosed.status).toBe("done")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("done")

		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("019e6cf2-5b39-7b83-9bc5-8c8b96122682")
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "codex" })).toBeNull()

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}:${event.resumedSessionId ?? "fresh"}`)).toEqual([
			"codex:iteration:fresh",
			"claude:review:fresh",
		])
		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review"])
	} finally {
		fixture.store.close()
	}
})

test("review retry verdict retries review phase without returning to iteration", async () => {
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
			stdout: ["REVIEW SUMMARY: verdict=retry; issue=#31602; reason=review-wants-changes"],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: "019e6cf2-5b39-7b83-9bc5-8c8b96122683",
			stdout: ["REVIEW SUMMARY: verdict=accepted; issue=#31602; reason=review-retry-complete"],
		},
	])
	try {
		const chain = createChain(fixture.store, "cross-runner-review-retry-chain")
		await preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
		const item = createItem(fixture.store, chain, 316_002)
		const options = fixture.options()

		await closeOnlySpawn(await schedulerTick(options))
		const retryReviewTick = await schedulerTick(options)
		expect(retryReviewTick.spawnedRuns).toHaveLength(1)
		const retryReviewClosed = await retryReviewTick.spawnedRuns[0]!.closed
		expect(retryReviewClosed.status).toBe("changes_requested")
		expect(fixture.store.getItem(item.id)?.phase).toBe("review")
		expect(fixture.store.getItem(item.id)?.status).toBe("changes_requested")

		const acceptedReviewTick = await schedulerTick(options)
		expect(acceptedReviewTick.spawnedRuns).toHaveLength(1)
		const acceptedReviewClosed = await acceptedReviewTick.spawnedRuns[0]!.closed
		expect(acceptedReviewClosed.status).toBe("done")
		expect(fixture.store.getItem(item.id)?.status).toBe("done")

		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review", "review"])
		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}`)).toEqual([
			"codex:iteration",
			"claude:review",
			"claude:review",
		])
		expect(fakeEvents[2]?.resumedSessionId).toBe("019e6cf2-5b39-7b83-9bc5-8c8b96122682")
	} finally {
		fixture.store.close()
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
			stderr: [`No conversation found with session ID: ${staleReviewSessionId}`],
		},
		{
			runner: "claude",
			phase: "review",
			sessionId: freshReviewSessionId,
			stdout: ["REVIEW SUMMARY: verdict=accepted; issue=#31603; reason=fresh-review-complete"],
		},
	])
	try {
		let now = 1_800_316_000
		const chain = createChain(fixture.store, "cross-runner-invalid-session-chain")
		await preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
		const item = createItem(fixture.store, chain, 316_003)
		const options = fixture.options({ now: () => now })

		await closeOnlySpawn(await schedulerTick(options))
		fixture.store.setItemSessionId(item.id, {
			phase: "review",
			runner: "claude",
			sessionId: staleReviewSessionId,
			updatedAt: now,
		})

		const invalidReviewTick = await schedulerTick(options)
		expect(invalidReviewTick.spawnedRuns).toHaveLength(1)
		const invalidReviewClosed = await invalidReviewTick.spawnedRuns[0]!.closed
		expect(invalidReviewClosed.exitCode).toBe(1)
		expect(invalidReviewClosed.status).toBe("changes_requested")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBeNull()
		expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("d400e2b2-04a4-44f8-8f13-3078f41a5593")
		expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
			type: "session_id.invalidated",
			itemId: item.id,
			phase: "review",
			runner: "claude",
			previousSessionId: staleReviewSessionId,
		}))

		now += 1
		const freshReviewTick = await schedulerTick(options)
		expect(freshReviewTick.spawnedRuns).toHaveLength(1)
		const freshReviewClosed = await freshReviewTick.spawnedRuns[0]!.closed
		expect(freshReviewClosed.status).toBe("done")
		expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe(freshReviewSessionId)

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}:${event.resumedSessionId ?? "fresh"}`)).toEqual([
			"codex:iteration:fresh",
			`claude:review:${staleReviewSessionId}`,
			"claude:review:fresh",
		])
		expect(phaseStarts(fixture.schedulerEvents, item.id)).toEqual(["iteration", "review", "review"])
	} finally {
		fixture.store.close()
	}
})

test("continuous fake runner failures exhaust at maxItemAttempts without another spawn", async () => {
	const fixture = await createCrossRunnerFixture("max-attempts", [
		{ runner: "codex", phase: "iteration", exitCode: 1, stderr: ["forced failure 1"] },
		{ runner: "codex", phase: "iteration", exitCode: 1, stderr: ["forced failure 2"] },
	])
	try {
		let now = 1_800_317_000
		const chain = createChain(fixture.store, "cross-runner-max-attempts-chain", {
			metadata: { maxItemAttempts: 2 },
		})
		await preInstallReviewOnEmptyLock(chain, fixture.loopDataRoot)
		const item = createItem(fixture.store, chain, 316_004)
		const options = fixture.options({ now: () => now })

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
			itemId: item.id,
			terminalStatus: "exhausted",
		}))

		const fakeEvents = await readFakeRunnerEvents(fixture.eventLog)
		expect(fakeEvents.map((event) => `${event.runner}:${event.phase}`)).toEqual([
			"codex:iteration",
			"codex:iteration",
		])
	} finally {
		fixture.store.close()
	}
})

type RunnerKind = "claude" | "codex"

type FakeRunnerResponse = {
	runner: RunnerKind
	phase: string
	exitCode?: number
	sessionId?: string | null
	stdout?: string[]
	stderr?: string[]
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
	state: ReturnType<typeof createSchedulerState>
	loopDataRoot: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
	options: (overrides?: Partial<SchedulerOptions>) => SchedulerOptions
}

async function createCrossRunnerFixture(name: string, responses: FakeRunnerResponse[]): Promise<CrossRunnerFixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "loop-data")
	const eventLog = resolve(root, "cross-runner-events.jsonl")
	const planPath = resolve(root, "cross-runner-plan.json")
	const codexWrapper = resolve(root, "fake-codex.sh")
	const claudeWrapper = resolve(root, "fake-claude.sh")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(planPath, JSON.stringify({ responses }, null, 2))
	await writeRunnerWrapper(codexWrapper, planPath, eventLog, "codex")
	await writeRunnerWrapper(claudeWrapper, planPath, eventLog, "claude")

	const store = openSqliteStateStore({ loopDataRoot })
	const state = createSchedulerState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
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
		presetDir: PRESET_DIR,
		phaseRunner,
		worktreeManager,
		loopDataRootOptions: { loopDataRoot },
		kindResolver: () => ({ ok: true, kind: "code" }),
		runIdFactory: ({ chain, item, phase }) => `run-${chain.id}-${item.id}-${phase}-${++runSequence}`,
		prompt: ({ item, runId, phase }) => JSON.stringify({
			itemId: item.id,
			issueNumber: item.issueNumber,
			runId,
			phase,
		}),
		onEvent: (event) => {
			schedulerEvents.push(event)
		},
		...overrides,
	})

	return { store, state, loopDataRoot, eventLog, schedulerEvents, options }
}

async function writeRunnerWrapper(path: string, planPath: string, eventLog: string, runner: RunnerKind): Promise<void> {
	await writeFile(
		path,
		[
			"#!/bin/sh",
			`exec bun ${shellQuote(FAKE_RUNNER)} ${shellQuote(planPath)} ${shellQuote(eventLog)} ${runner} "$@"`,
			"",
		].join("\n"),
	)
	await chmod(path, 0o755)
}

function createChain(
	store: ReturnType<typeof openSqliteStateStore>,
	name: string,
	overrides: Partial<Parameters<typeof store.createChain>[0]> = {},
): ChainRecord {
	return store.createChain({
		name,
		preset: "gh-issue-pr-iteration",
		repository: "mouriya-s-lab/coder-loop",
		baseBranch: "main",
		umbrellaIssue: 309,
		umbrellaRepo: "mouriya-s-lab/coder-loop",
		status: "active",
		metadata: {},
		createdAt: 1_800_316_000,
		updatedAt: 1_800_316_000,
		...overrides,
	})
}

function createItem(store: ReturnType<typeof openSqliteStateStore>, chain: ChainRecord, issueNumber: number) {
	return store.createItem({
		chainId: chain.id,
		issueNumber,
		repoCwd: REPO_ROOT,
		status: "queued",
		attempts: 0,
		title: `issue ${issueNumber}`,
		extra: { issueKind: "code" },
		createdAt: 1_800_316_001 + issueNumber,
		updatedAt: 1_800_316_001 + issueNumber,
	})
}

async function preInstallReviewOnEmptyLock(chain: ChainRecord, loopDataRoot: string): Promise<void> {
	const lockPath = reviewOnEmptyLockPathForChain(chain, { loopDataRoot })
	await mkdir(dirname(lockPath), { recursive: true })
	await writeFile(lockPath, serializeSchedulerReviewOnEmptyLock("test-review-on-empty-preinstalled", new Date(0)))
}

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
