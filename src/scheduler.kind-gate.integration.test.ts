import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	sendDaemonRequest,
	startCoderLoopDaemon,
	type CoderLoopDaemon,
	type DaemonResponse,
} from "./daemon"
import { resolveChainRuntimePaths } from "./runtime-paths"
import {
	reviewOnEmptyLockPathForChainName,
	schedulerSlotWorktreePath,
	serializeSchedulerReviewOnEmptyLock,
	type SchedulerEvent,
	type SchedulerKindResolver,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/kind-gate-tests", String(process.pid))
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const KIND_GATE_LIVE_POLL_TIMEOUT_MS = 10_000
const KIND_GATE_LIVE_TEST_TIMEOUT_MS = 15_000

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("scheduler kind gate live integration", () => {
	test("daemon scheduler aborts spawn when kind gate reports missing label (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver("kind-gate-missing-label-live", () => ({ ok: true, kind: null }))
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-missing-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName("kind-gate-missing-label-live-chain", fixture.loopDataRoot)
			await request(fixture, "item.add", { chainId, issueNumber: 9101, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9101),
				(candidate) => candidate?.status === "blocked",
				KIND_GATE_LIVE_POLL_TIMEOUT_MS,
			)
			expect(item?.status).toBe("blocked")
			expect(item?.lastRunId).toBeNull()
			expect(fixture.schedulerEvents.some((event) => event.type === "agent.spawn" && event.itemId === item!.id)).toBe(false)
			const aborted = await waitForSpawnAbortedEvent(fixture.schedulerEvents, item!.id)
			expect(aborted).toMatchObject({ type: "spawn.aborted", chainId, itemId: item!.id, issueNumber: 9101, toStatus: "blocked" })
			expect(warnings.some((line) => line.includes("kind label check failed") && line.includes("expected exactly one kind"))).toBe(true)

			const paths = resolveChainRuntimePaths("kind-gate-missing-label-live-chain", { loopDataRoot: fixture.loopDataRoot })
			const daemonBatches = await readdir(paths.daemonDir)
			const daemonLog = await readFile(paths.daemonLogFile(daemonBatches[0]!), "utf-8")
			expect(daemonLog).toContain("spawn.aborted")
			expect(daemonLog).toContain("expected exactly one kind")
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	}, KIND_GATE_LIVE_TEST_TIMEOUT_MS)

	test("daemon scheduler aborts spawn when kind gate reports multiple labels (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver(
			"kind-gate-multi-label-live",
			() => ({ ok: false, error: "expected exactly one kind:* label, found 2: kind:code, kind:comment" }),
		)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-multi-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName("kind-gate-multi-label-live-chain", fixture.loopDataRoot)
			await request(fixture, "item.add", { chainId, issueNumber: 9102, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9102),
				(candidate) => candidate?.status === "blocked",
				KIND_GATE_LIVE_POLL_TIMEOUT_MS,
			)
			expect(item?.status).toBe("blocked")
			const aborted = await waitForSpawnAbortedEvent(fixture.schedulerEvents, item!.id)
			expect(aborted.reason).toContain("expected exactly one kind:* label, found 2")
			expect(warnings.some((line) => line.includes("expected exactly one kind:* label, found 2"))).toBe(true)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	}, KIND_GATE_LIVE_TEST_TIMEOUT_MS)

	test("daemon scheduler aborts spawn when kind gate reports unknown label (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver(
			"kind-gate-unknown-label-live",
			() => ({ ok: false, error: 'unknown kind label "kind:foo" (allowed: kind:code, kind:comment, kind:code-spike, kind:blocked)' }),
		)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-unknown-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName("kind-gate-unknown-label-live-chain", fixture.loopDataRoot)
			await request(fixture, "item.add", { chainId, issueNumber: 9103, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9103),
				(candidate) => candidate?.status === "blocked",
				KIND_GATE_LIVE_POLL_TIMEOUT_MS,
			)
			expect(item?.status).toBe("blocked")
			const aborted = await waitForSpawnAbortedEvent(fixture.schedulerEvents, item!.id)
			expect(aborted.reason).toContain('unknown kind label "kind:foo"')
			expect(warnings.some((line) => line.includes('unknown kind label "kind:foo"'))).toBe(true)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	}, KIND_GATE_LIVE_TEST_TIMEOUT_MS)
})

type Fixture = {
	daemon: CoderLoopDaemon
	loopDataRoot: string
	socketPath: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
}

type SchedulerSpawnAbortedEvent = Extract<SchedulerEvent, { type: "spawn.aborted" }>

function preInstallReviewOnEmptyLockByName(chainName: string, loopDataRoot: string, runId = "test-pre-installed"): void {
	const lockPath = reviewOnEmptyLockPathForChainName(chainName, { loopDataRoot })
	mkdirSync(resolve(lockPath, ".."), { recursive: true })
	writeFileSync(lockPath, serializeSchedulerReviewOnEmptyLock(runId, new Date(0)))
}

async function startFixtureWithKindResolver(name: string, kindResolver: SchedulerKindResolver): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	await writeFakeRunner(fakeRunner)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}

	const scheduler: SchedulerOptions["runner"] = {
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
			runner: scheduler,
			presetDir: PRESET_DIR,
			worktreeManager,
			kindResolver,
			prompt: ({ item, runId }) => JSON.stringify({
				itemId: item.id,
				issueNumber: item.issueNumber,
				runId,
				eventLog,
				sleepMs: 5,
				exitCode: 0,
			}),
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, eventLog, schedulerEvents }
}

async function waitForSpawnAbortedEvent(schedulerEvents: SchedulerEvent[], itemId: number): Promise<SchedulerSpawnAbortedEvent> {
	const aborted = await waitFor<SchedulerSpawnAbortedEvent | null>(
		async () => schedulerEvents.find((event): event is SchedulerSpawnAbortedEvent =>
			event.type === "spawn.aborted" && event.itemId === itemId,
		) ?? null,
		(event) => event !== null,
		KIND_GATE_LIVE_POLL_TIMEOUT_MS,
	)
	if (aborted === null) throw new Error(`missing spawn.aborted event for item ${itemId}`)
	return aborted
}

async function readItem(loopDataRoot: string, chainId: number, issueNumber: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getItemByIssue(chainId, issueNumber)
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

async function request(fixture: Fixture, command: string, args = {}): Promise<DaemonResponse> {
	return await sendDaemonRequest(fixture.socketPath, { id: `${command}-${Date.now()}`, command, args })
}

function expectOk(response: DaemonResponse) {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected object, got ${JSON.stringify(value)}`)
	return value as Record<string, unknown>
}

function numberValue(value: unknown): number {
	if (typeof value !== "number") throw new Error(`expected number, got ${JSON.stringify(value)}`)
	return value
}

async function writeFakeRunner(path: string): Promise<void> {
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "unexpected-spawn", issueNumber: input.issueNumber, runId: input.runId }) + "\\n")
console.log("ITERATION SUMMARY: scope=kind-gate-live; reason=unexpected-spawn")
process.exit(0)
`,
	)
}
