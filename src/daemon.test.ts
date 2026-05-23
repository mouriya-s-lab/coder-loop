import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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
import { resolveChainRuntimePaths } from "./runtime-paths"
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

	test("socket chain.create rejects undeclared args", async () => {
		const fixture = await startFixture("chain-create-strict-args", { schedulerEnabled: false })
		try {
			const args = JSON.parse(
				`{"name":"strict-args","repository":"mouriya-s-lab/coder-loop","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}`,
			)

			expectInvalid(await request(fixture, "chain.create", args))
			expect(Object.prototype).not.toHaveProperty("polluted")
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
				metadata: {},
			})
			store.createChain({
				name: "valid-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: {},
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

	test("socket item.add rejects invalid issue and repo fields before db insert", async () => {
		const fixture = await startFixture("item-add-validation", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "validation-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const invalidRequests = [
				{ issueNumber: 0, repoCwd: REPO_ROOT },
				{ issueNumber: -1, repoCwd: REPO_ROOT },
				{ issueNumber: 181, repoCwd: "relative/path" },
				{ issueNumber: 182, repoCwd: resolve(REPO_ROOT, "missing-coder-loop-test-dir") },
				{ issueNumber: 183, repoCwd: `${REPO_ROOT}\nchild` },
				{ issueNumber: 184, repoCwd: `${REPO_ROOT}\u0000child` },
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
				issueNumber: 185,
				repoCwd: REPO_ROOT,
			})).item)

			expect(added).toMatchObject({ issueNumber: 185, status: "queued", repoCwd: REPO_ROOT })
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
			const first = record(expectOk(await request(fixture, "item.add", { chainId, issueNumber: 186, repoCwd: REPO_ROOT })).item)
			const second = record(expectOk(await request(fixture, "item.add", { chainId, issueNumber: 187, repoCwd: REPO_ROOT })).item)
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

	test("socket item status validation follows the chain preset", async () => {
		const fixture = await startFixture("item-status-preset", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				issueNumber: 188,
				repoCwd: REPO_ROOT,
				status: "pending",
			})).item)
			expect(added).toMatchObject({ issueNumber: 188, status: "pending" })

			expectInvalid(await request(fixture, "item.update", { itemId: numberValue(added.id), status: "changes_requested" }))
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
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})).item)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: "done" },
			})).item)
			expect(updated.status).toBe("done")

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

	test("subprocess exit callback writes db", async () => {
		const fixture = await startFixture("exit-callback", { schedulerIntervalMs: 1_000 })
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

	test("daemon scheduler writes run artifacts and per-chain daemon log", async () => {
		const fixture = await startFixture("scheduler-artifacts", { schedulerIntervalMs: 1_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-artifacts-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 203,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})

			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 203), (candidate) => candidate?.status === "done")
			const runId = item?.lastRunId ?? ""
			const paths = resolveChainRuntimePaths("scheduler-artifacts-chain", { loopDataRoot: fixture.loopDataRoot })
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as Record<string, unknown>
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = (await readFile(paths.runEventsFile(runId), "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string })
			const daemonBatches = await readdir(paths.daemonDir)
			const daemonLog = await readFile(paths.daemonLogFile(daemonBatches[0]!), "utf-8")

			expect(status).toMatchObject({ runId, chainId, issueNumber: 203, phase: "iteration", exitCode: 0, status: "done" })
			expect(stdout).toContain("done:")
			expect(stderr).toBe("")
			expect(events.map((event) => event.type)).toEqual(["agent.spawn", "agent.exit", "chain.completed"])
			expect(daemonLog).toContain("scheduler.event")
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
	schedulerIntervalMs?: number
	worktreeManager?: SchedulerWorktreeManager
}

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	await writeFakeRunner(fakeRunner)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = options.worktreeManager ?? (async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	})

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
			intervalMs: options.schedulerIntervalMs ?? 20,
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

function expectInvalid(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("invalid_request")
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
