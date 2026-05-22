import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	DaemonError,
	daemonRequest,
	sendDaemonRequest,
	startCoderLoopDaemon,
	type CoderLoopDaemon,
	type DaemonResponse,
} from "./daemon"
import { schedulerSlotWorktreePath, type SchedulerEvent, type SchedulerOptions, type SchedulerWorktreeManager } from "./scheduler"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/dt", String(process.pid))
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("daemon", () => {
	test("daemon up creates socket and pid", async () => {
		const fixture = await startFixture("up", { schedulerEnabled: false })
		try {
			expect(await pathIsSocket(fixture.socketPath)).toBe(true)
			expect((await readFile(fixture.pidFile, "utf-8")).trim()).toBe(String(process.pid))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create", async () => {
		const fixture = await startFixture("chain-create", { schedulerEnabled: false })
		try {
			const result = expectOk(await request(fixture, "chain.create", {
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				umbrellaIssue: 176,
				metadata: { runner: "codex" },
			}))

			expect(result.chain).toMatchObject({
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: { runner: "codex" },
			})
		} finally {
			await fixture.daemon.stop()
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
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				title: "feat: 单进程 daemon",
				extra: { sleepMs: 5 },
			})).item)
			expect(added).toMatchObject({ issueNumber: 180, status: "queued", title: "feat: 单进程 daemon" })

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: "done", pr: 190, title: "updated daemon item" },
			})).item)
			expect(updated).toMatchObject({ status: "done", pr: 190, title: "updated daemon item" })
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
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				status: "done",
			})

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed")
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
			await request(fixture, "item.add", {
				chainId: numberValue(first.id),
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				status: "done",
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

	test("daemon graceful shutdown", async () => {
		const fixture = await startFixture("graceful-shutdown")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			expect(await pathExists(fixture.socketPath)).toBe(false)
			expect(await pathExists(fixture.pidFile)).toBe(false)
			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			expect(item?.status).toBe("changes_requested")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("subprocess exit callback writes db", async () => {
		const fixture = await startFixture("exit-callback")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "exit-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 7 },
			})

			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 180), (candidate) => candidate?.status === "changes_requested")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(7)
			expect(typeof run?.endedAt).toBe("number")
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
})

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
}

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
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
			enabled: options.schedulerEnabled ?? true,
			intervalMs: 20,
			runner: scheduler,
			presetDir: PRESET_DIR,
			worktreeManager,
			prompt: ({ item, runId }) =>
				JSON.stringify({
					itemId: item.id,
					issueNumber: item.issueNumber,
					runId,
					eventLog,
					sleepMs: typeof item.extra.sleepMs === "number" ? item.extra.sleepMs : 5,
					exitCode: typeof item.extra.exitCode === "number" ? item.extra.exitCode : 0,
				}),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, pidFile: snapshot.pidFile, eventLog, schedulerEvents }
}

async function request(fixture: Fixture, command: string, args = {}): Promise<DaemonResponse> {
	return await sendDaemonRequest(fixture.socketPath, { id: `${command}-${Date.now()}`, command, args })
}

function expectOk(response: DaemonResponse) {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
	return value as Record<string, unknown>
}

function numberValue(value: unknown): number {
	if (typeof value !== "number") throw new Error("expected number")
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

async function readItem(loopDataRoot: string, chainId: number, issueNumber: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getItemByIssue(chainId, issueNumber)
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

async function writeFakeRunner(path: string): Promise<void> {
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
