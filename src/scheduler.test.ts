import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	createSchedulerState,
	listActiveRuns,
	runSchedulerUntilIdle,
	schedulerSlotWorktreePath,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { type ChainRecord, openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests", String(process.pid))

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("scheduler", () => {
	test("single chain single repo serial", async () => {
		const fixture = await createFixture("serial")
		try {
			const chain = createChain(fixture.store, "serial-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a" })
			createItem(fixture.store, chain, { issueNumber: 181, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			const events = await readRunnerEvents(fixture.eventLog)
			expect(events.map((event) => `${event.type}:${event.issueNumber}`)).toEqual([
				"start:179",
				"end:179",
				"start:180",
				"end:180",
				"start:181",
				"end:181",
			])
			expect(maxConcurrentRunnerEvents(events)).toBe(1)
			expect(new Set(events.map((event) => event.cwd)).size).toBe(1)
			expect(fixture.worktreeCalls).toHaveLength(1)
			expect(fixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["done", "done", "done"])
		} finally {
			fixture.store.close()
		}
	})

	test("single chain multi repo concurrent", async () => {
		const fixture = await createFixture("multi-repo")
		try {
			const chain = createChain(fixture.store, "multi-repo-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/b", sleepMs: 80 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(listActiveRuns(fixture.state)).toHaveLength(2)
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))

			const events = await readRunnerEvents(fixture.eventLog)
			expect(maxConcurrentRunnerEvents(events)).toBe(2)
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
		} finally {
			fixture.store.close()
		}
	})

	test("invalid chain names are ignored by scheduler ticks", async () => {
		const fixture = await createFixture("invalid-chain-skip")
		try {
			const invalid = createChain(fixture.store, "..")
			const valid = createChain(fixture.store, "valid-chain")
			createItem(fixture.store, invalid, { issueNumber: 178, repoCwd: "/repo/a" })
			createItem(fixture.store, valid, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemByIssue(invalid.id, 178)?.status).toBe("queued")
			expect(fixture.store.getItemByIssue(valid.id, 179)?.status).toBe("done")
			expect(fixture.worktreeCalls).toHaveLength(1)
			expect(fixture.worktreeCalls[0]).toContain("valid-chain")
		} finally {
			fixture.store.close()
		}
	})

	test("multi chain same repo worktree isolation", async () => {
		const fixture = await createFixture("multi-chain")
		try {
			const chainA = createChain(fixture.store, "chain-a")
			const chainB = createChain(fixture.store, "chain-b")
			createItem(fixture.store, chainA, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chainB, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 80 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(2)
			expect(new Set(tick.spawnedRuns.map((run) => run.worktreePath)).size).toBe(2)
			expect(tick.spawnedRuns[0]?.worktreePath).not.toBe(tick.spawnedRuns[1]?.worktreePath)
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
		} finally {
			fixture.store.close()
		}
	})

	test("slot busy skip", async () => {
		const fixture = await createFixture("busy")
		try {
			const chain = createChain(fixture.store, "busy-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 80 })
			createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 80 })

			const firstTick = await schedulerTick(fixture.options())
			const secondTick = await schedulerTick(fixture.options())
			expect(firstTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)?.extra).toMatchObject({ itemId: firstTick.spawnedRuns[0]?.itemId, pid: firstTick.spawnedRuns[0]?.pid })
			expect(fixture.schedulerEvents.some((event) => event.type === "slot.busy")).toBe(true)
			expect(fixture.store.listItems(chain.id).map((item) => item.status)).toEqual(["in_progress", "queued"])
			await firstTick.spawnedRuns[0]!.closed
		} finally {
			fixture.store.close()
		}
	})

	test("advance after terminal", async () => {
		const fixture = await createFixture("advance")
		try {
			const chain = createChain(fixture.store, "advance-chain")
			const first = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 10 })
			const second = createItem(fixture.store, chain, { issueNumber: 180, repoCwd: "/repo/a", sleepMs: 10 })

			const firstTick = await schedulerTick(fixture.options())
			await firstTick.spawnedRuns[0]!.closed
			const secondTick = await schedulerTick(fixture.options())

			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(first.id)?.status).toBe("done")
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed
		} finally {
			fixture.store.close()
		}
	})

	test("chain completion", async () => {
		const fixture = await createFixture("completion")
		try {
			const chain = createChain(fixture.store, "completion-chain")
			createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents.some((event) => event.type === "chain.completed" && event.chainId === chain.id)).toBe(true)
		} finally {
			fixture.store.close()
		}
	})

	test("manual terminal item update completes chain on next tick", async () => {
		const fixture = await createFixture("manual-terminal-completion")
		try {
			const chain = createChain(fixture.store, "manual-terminal-completion-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 249, repoCwd: "/repo/a" })
			fixture.store.updateItem(item.id, { status: "done", updatedAt: 1_800_000_500 })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([chain.id])
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")
			expect(fixture.schedulerEvents).toContainEqual({ type: "chain.completed", chainId: chain.id, chainName: chain.name })
		} finally {
			fixture.store.close()
		}
	})

	test("terminated child preserves user terminal item status", async () => {
		const fixture = await createFixture("terminal-preserve")
		try {
			const chain = createChain(fixture.store, "terminal-preserve-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a", sleepMs: 5_000 })

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns).toHaveLength(1)
			expect(fixture.store.getItem(item.id)?.status).toBe("in_progress")

			fixture.store.updateItem(item.id, { status: "done", updatedAt: 1_800_000_500 })
			const closed = await tick.spawnedRuns[0]!.terminate({ forceAfterMs: 200 })

			expect(closed.exitCode).toBe(1)
			expect(closed.status).toBe("done")
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect(fixture.store.getChain(chain.id)?.status).toBe("completed")

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(0)
		} finally {
			fixture.store.close()
		}
	})

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
			expect(terminated.status).toBe("changes_requested")
			expect(fixture.store.getItem(first.id)?.attempts).toBe(1)
			expect(fixture.store.getItem(second.id)?.attempts).toBe(0)

			const secondTick = await schedulerTick(fixture.options())
			expect(secondTick.spawnedRuns).toHaveLength(1)
			expect(secondTick.spawnedRuns[0]?.itemId).toBe(second.id)
			await secondTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItem(second.id)?.attempts).toBe(1)
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn").map((event) => event.itemId)).toEqual([first.id, second.id])
		} finally {
			fixture.store.close()
		}
	})

	test("empty active chain remains active", async () => {
		const fixture = await createFixture("empty-active")
		try {
			const chain = createChain(fixture.store, "empty-active-chain")

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(tick.completedChainIds).toEqual([])
			expect(fixture.store.getChain(chain.id)?.status).toBe("active")
		} finally {
			fixture.store.close()
		}
	})

	test("completed chain skipped", async () => {
		const fixture = await createFixture("completed-skip")
		try {
			const chain = createChain(fixture.store, "completed-chain", { status: "completed" })
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.state.slots.size).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			fixture.store.close()
		}
	})

	test("deleted chain skipped", async () => {
		const fixture = await createFixture("deleted-skip")
		try {
			const chain = createChain(fixture.store, "deleted-chain", { status: "deleted" })
			const item = createItem(fixture.store, chain, { issueNumber: 226, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())

			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.state.slots.size).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("queued")
		} finally {
			fixture.store.close()
		}
	})

	test("real subprocess spawn end-to-end", async () => {
		const fixture = await createFixture("subprocess")
		try {
			const chain = createChain(fixture.store, "subprocess-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 179, repoCwd: "/repo/a" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(tick.spawnedRuns).toHaveLength(1)
			expect(closed.exitCode).toBe(0)
			expect(closed.stdout).toContain(`done:${item.id}`)
			expect(fixture.store.getRunByRunId(closed.runId)?.exitCode).toBe(0)
			expect(fixture.store.getItem(item.id)?.status).toBe("done")
			expect((await readRunnerEvents(fixture.eventLog)).map((event) => event.type)).toEqual(["start", "end"])
		} finally {
			fixture.store.close()
		}
	})

	test("scheduler run writes run-root artifacts", async () => {
		const fixture = await createFixture("run-artifacts")
		try {
			const chain = createChain(fixture.store, "run-artifacts-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 203, repoCwd: "/repo/a" })

			await runSchedulerUntilIdle(fixture.options())

			const runId = `run-${chain.id}-${item.id}`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as Record<string, unknown>
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = (await readFile(paths.runEventsFile(runId), "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string })

			expect(status).toMatchObject({
				runId,
				chainId: chain.id,
				chainName: chain.name,
				itemId: item.id,
				issueNumber: 203,
				phase: "iteration",
				exitCode: 0,
				status: "done",
			})
			expect(stdout).toContain(`done:${item.id}`)
			expect(stderr).toBe("")
			expect(events.map((event) => event.type)).toEqual(["agent.spawn", "agent.exit", "chain.completed"])
		} finally {
			fixture.store.close()
		}
	})
})

type Fixture = {
	store: ReturnType<typeof openSqliteStateStore>
	state: ReturnType<typeof createSchedulerState>
	loopDataRoot: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
	worktreeCalls: string[]
	options: (overrides?: Partial<SchedulerOptions>) => SchedulerOptions
}

type RunnerEvent = {
	type: "start" | "end"
	itemId: number
	issueNumber: number
	runId: string
	cwd: string
}

async function createFixture(name: string): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${name}-${++nextFixtureId}`)
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "runner-events.jsonl")
	await mkdir(loopDataRoot, { recursive: true })
	await writeFakeRunner(fakeRunner)

	const store = openSqliteStateStore({ loopDataRoot })
	const state = createSchedulerState()
	const schedulerEvents: SchedulerEvent[] = []
	const worktreeCalls: string[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		worktreeCalls.push(worktreePath)
		return worktreePath
	}

	const options = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
		store,
		state,
		presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
		runner: {
			kind: "claude",
			source: "iteration-default",
			binary: "bun",
			extraArgs: [fakeRunner],
			model: null,
		},
		worktreeManager,
		loopDataRootOptions: { loopDataRoot },
		runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}`,
		prompt: ({ item, runId, worktreePath }) =>
			JSON.stringify({
				itemId: item.id,
				issueNumber: item.issueNumber,
				runId,
				worktreePath,
				eventLog,
				sleepMs: typeof item.extra.sleepMs === "number" ? item.extra.sleepMs : 5,
				exitCode: typeof item.extra.exitCode === "number" ? item.extra.exitCode : 0,
			}),
		onEvent: (event) => {
			schedulerEvents.push(event)
		},
		...overrides,
	})

	return { store, state, loopDataRoot, eventLog, schedulerEvents, worktreeCalls, options }
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
		umbrellaIssue: 176,
		umbrellaRepo: "mouriya-s-lab/coder-loop",
		status: "active",
		metadata: {},
		createdAt: 1_800_000_000,
		updatedAt: 1_800_000_000,
		...overrides,
	})
}

function createItem(
	store: ReturnType<typeof openSqliteStateStore>,
	chain: ChainRecord,
	input: { issueNumber: number; repoCwd: string; sleepMs?: number; exitCode?: number },
) {
	return store.createItem({
		chainId: chain.id,
		issueNumber: input.issueNumber,
		repoCwd: input.repoCwd,
		status: "queued",
		attempts: 0,
		title: `issue ${input.issueNumber}`,
		extra: {
			sleepMs: input.sleepMs ?? 5,
			exitCode: input.exitCode ?? 0,
		},
		createdAt: 1_800_000_001 + input.issueNumber,
		updatedAt: 1_800_000_001 + input.issueNumber,
	})
}

async function writeFakeRunner(path: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true })
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
console.log("done:" + input.itemId)
process.exit(input.exitCode)
`,
	)
}

async function readRunnerEvents(path: string): Promise<RunnerEvent[]> {
	const text = await readFile(path, "utf-8")
	return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunnerEvent)
}

function maxConcurrentRunnerEvents(events: RunnerEvent[]): number {
	let active = 0
	let max = 0
	for (const event of events) {
		if (event.type === "start") active += 1
		if (event.type === "end") active -= 1
		max = Math.max(max, active)
	}
	return max
}
