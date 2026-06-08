import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/db-main-loop-tests", String(process.pid))
const CHAIN_NAME = "db-main-loop"

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("db-backed v2 loop hard cut", () => {
	test("no-subcommand legacy loop entry prints usage and exits 1", async () => {
		const fixture = await createFixture()
		const result = runCli(["--target-cwd", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--once"])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toContain("Usage: coder-loop <command> [options]")
		expect(readItem(fixture.loopDataRoot).status).toBe("queued")
	})

	test("status command reads SQLite state without touching legacy state json", async () => {
		const fixture = await createFixture()
		const beforeText = await readFile(fixture.statePath, "utf-8")
		const beforeMtime = (await stat(fixture.statePath)).mtimeMs
		const result = runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME, "--json"])
		expect(result.exitCode).toBe(0)
		const snapshot = JSON.parse(result.stdout) as { queue: { selected: { id: string } | null } }
		expect(snapshot.queue.selected?.id).toBe("1")
		expect(await readFile(fixture.statePath, "utf-8")).toBe(beforeText)
		expect((await stat(fixture.statePath)).mtimeMs).toBe(beforeMtime)
	})

	test("queue unblock mutates SQLite only", async () => {
		const fixture = await createFixture({ initialStatus: "blocked", extra: { blockerRepo: "owner/dependency", blockerRef: "#267" } })
		const beforeText = await readFile(fixture.statePath, "utf-8")
		const result = runCli(["queue", "unblock", fixture.target, "--issue", "1", "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME])
		expect(result.exitCode).toBe(0)
		expect(readItem(fixture.loopDataRoot).status).toBe("queued")
		expect(readItem(fixture.loopDataRoot).extra.blockerRepo).toBeUndefined()
		expect(await readFile(fixture.statePath, "utf-8")).toBe(beforeText)
	})

	test("queue unblock restores preset-declared terminal status to preset entry", async () => {
		const fixture = await createFixture({
			initialStatus: "parked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
			customManualUnblockPreset: true,
		})

		const result = runCli(["queue", "unblock", fixture.target, "--issue", "1", "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME])

		expect(result.exitCode).toBe(0)
		const output = JSON.parse(result.stdout) as {
			mutation: { changed: boolean; beforeStatus: string; afterStatus: string }
			verification: { itemStatus: string }
		}
		expect(output.mutation).toMatchObject({ changed: true, beforeStatus: "parked", afterStatus: "ready" })
		expect(output.verification.itemStatus).toBe("ready")
		expect(readItem(fixture.loopDataRoot).status).toBe("ready")
		expect(readItem(fixture.loopDataRoot).extra.blockerRepo).toBeUndefined()
	})

	test("daemon start dry-run resolves the chain without per-target state writes", async () => {
		const fixture = await createFixture()
		const beforeText = await readFile(fixture.statePath, "utf-8")
		const result = runCli(["daemon", "start", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME, "--dry-run"])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain(`daemon start dry-run: chain=${CHAIN_NAME}`)
		expect(readItem(fixture.loopDataRoot).status).toBe("queued")
		expect(await readFile(fixture.statePath, "utf-8")).toBe(beforeText)
	})

	test("removed legacy state functions", async () => {
		const source = await readFile(LOOP_ENTRY, "utf-8")
		const removedNames = [
			"selectIssue",
			"markReviewStarted",
			"loadLoopStateFromDb",
			"saveLoopStateToDb",
			"loopStateFromDbRecords",
			"persistLoopStateToDb",
			"checkRuntime",
			"assertRuntimeValid",
			"serializeState",
			"parseLoopState",
			"itemRecordToQueueItem",
			"currentRecordToCurrentRun",
			"requeueBlockedItem",
			"findQueueItemById",
			"firstLastRunId",
			"makeFallbackItem",
		]
		for (const name of removedNames) {
			expect(source).not.toMatch(new RegExp(`function\\s+${name}\\b`))
			expect(source).not.toMatch(new RegExp(`\\b${name}\\s*\\(`))
		}
		expect(source).not.toContain("exists(options.stateFile)")
	})
})

type FixtureOptions = {
	initialStatus?: string
	extra?: Record<string, string>
	customManualUnblockPreset?: boolean
}

type Fixture = {
	target: string
	loopDataRoot: string
	statePath: string
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const target = resolve(root, "target")
	const runtime = resolve(target, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	const statePath = resolve(runtime, "state.json")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/1"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", CHAIN_NAME, "issues"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", CHAIN_NAME, "evidence"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", CHAIN_NAME, "runs"), { recursive: true })
	await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	await writeFile(resolve(loopDataRoot, "chains", CHAIN_NAME, "shared.md"), "# shared\n")
	await writeFile(statePath, `${JSON.stringify({ queue: [], recentRuns: [], current: null }, null, 2)}\n`)
	const presetPath = options.customManualUnblockPreset === true ? await createManualUnblockPreset(root) : null
	seedDb(loopDataRoot, target, options, presetPath)
	return { target, loopDataRoot, statePath }
}

async function createManualUnblockPreset(root: string): Promise<string> {
	const presetPath = resolve(root, "manual-unblock-preset")
	await mkdir(presetPath, { recursive: true })
	await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
	await writeFile(resolve(presetPath, "preset.toml"), `name = "manual-unblock-fixture"
version = 1
description = "Fixture preset for queue unblock custom statuses."

[item]
idField = "issue"

[statuses]
continuable = ["ready", "retry"]
terminal = ["parked", "finished"]
entry = "ready"
unblockable = ["parked"]

[[phases]]
name = "run"
prompt = "run.md"

  [phases.variables]
  ISSUE = "item.issue"

[agent]
binary = "echo"
extraArgs = []
attemptTimeoutSeconds = 3600
`)
	return presetPath
}

function seedDb(loopDataRoot: string, target: string, options: FixtureOptions, presetPath: string | null): void {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: CHAIN_NAME,
			preset: presetPath === null ? "gh-issue-pr-iteration" : "manual-unblock-fixture",
			repository: "fixture/repo",
			baseBranch: "main",
			metadata: presetPath === null ? {} : { presetPath },
		})
		store.createItem({
			chainId: chain.id,
			issueNumber: 1,
			repoCwd: target,
			status: options.initialStatus ?? "queued",
			issueFile: null,
			evidenceDir: null,
			extra: { issueKind: "code", ...(options.extra ?? {}) },
		})
	} finally {
		store.close()
	}
}

function runCli(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: proc.exitCode,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	}
}

function readItem(loopDataRoot: string) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.getChainByName(CHAIN_NAME)
		if (chain === null) throw new Error("missing chain")
		const item = store.getItemByIssue(chain.id, 1)
		if (item === null) throw new Error("missing item")
		return item
	} finally {
		store.close()
	}
}
