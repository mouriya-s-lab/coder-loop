import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { startCoderLoopDaemon } from "./daemon"
import { openSqliteStateStore } from "./sqlite-state"
import { engineLifecycleAdmittedItemStatus, itemExtraToJsonObject, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"
import { operatorFixtureEnvironment } from "./test-process-env"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/db-main-loop-tests", String(process.pid))
const CHAIN_NAME = "db-main-loop"

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

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
		// #409: queue.unblock daemonizes. Start an in-process daemon so the CLI subprocess can
		// reach it via Unix socket; operator-path call (no env credential) flows through the
		// daemon's hard-deny gate as `kind: "operator"` and the existing assertion that the
		// item moves blocked→queued holds without per-test mutation.
		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const result = await runCliAsync(["queue", "unblock", fixture.target, "--issue", "1", "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME])
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
			expect(readItem(fixture.loopDataRoot).status).toBe("queued")
			// #457: queue unblock no longer clears preset-owned blocker keys — the engine has no
			// concept of "blocker" any more, so any keys the preset wrote into extra remain in place.
			// The keys live in `runtimeRemainder` because they are no longer engine-typed ItemExtra fields.
			expect(itemExtraToJsonObject(readItem(fixture.loopDataRoot).extra).blockerRepo).toBe("owner/dependency")
			expect(await readFile(fixture.statePath, "utf-8")).toBe(beforeText)
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	test("queue unblock restores preset-declared terminal status to preset entry", async () => {
		const fixture = await createFixture({
			initialStatus: "parked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
			customManualUnblockPreset: true,
		})

		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const result = await runCliAsync(["queue", "unblock", fixture.target, "--issue", "1", "--loop-data-root", fixture.loopDataRoot, "--chain", CHAIN_NAME])

			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
			// #409 retry: drop the `as { … }` anonymous-shape cast — assert structurally via
			// toMatchObject so the test no longer relies on a real `as` cast (代码红线 from
			// issue #409 `## 约束`: 禁止真 `as` 断言（`as const` 除外）+ 不引入匿名形状).
			expect(JSON.parse(result.stdout)).toMatchObject({
				mutation: { changed: true, beforeStatus: "parked", afterStatus: "ready" },
				verification: { itemStatus: "ready" },
			})
			expect(readItem(fixture.loopDataRoot).status).toBe("ready")
			// #457: preset-owned blocker keys survive queue unblock (see test above).
			expect(itemExtraToJsonObject(readItem(fixture.loopDataRoot).extra).blockerRepo).toBe("owner/dependency")
		} finally {
			await daemon.stop()
		}
	}, 30_000)

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

[item]
idField = "issue"

[statuses]
continuable = ["ready", "retry"]
terminal = ["parked", "finished"]
entry = "ready"
unblockable = ["parked"]
exhausted = "parked"

[[phases]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edges so R2 passes for both continuable statuses.
  # The manual-unblock test surface is unchanged — these exits are inert from
  # the test's perspective (the test drives status directly through the store).
  [[phases.exits]]
  status = "finished"
  when = "Run finished and the item should land in the success-terminal vocabulary."

  [[phases.exits]]
  status = "parked"
  when = "Run failed structurally and the item should park for manual unblock."

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
			metadata: storedChainMetadata(presetPath === null ? {} : { presetPath }),
		})
		store.createItem({
			chainId: chain.id,
			itemId: "1",
			repoCwd: target,
			status: runtimeStatus(options.initialStatus ?? "queued"),
			issueFile: null,
			evidenceDir: null,
			extra: storedItemExtra(options.extra ?? {}),
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
		env: operatorFixtureEnvironment(),
	})
	return {
		exitCode: proc.exitCode,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	}
}

// #409: async variant required when the CLI talks to an in-process daemon in the same Bun
// runtime. `Bun.spawnSync` blocks the event loop, which deadlocks the daemon (it cannot accept
// connections while spawnSync waits on the subprocess that is trying to connect).
async function runCliAsync(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: operatorFixtureEnvironment(),
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { exitCode, stdout, stderr }
}

function readItem(loopDataRoot: string) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.getChainByName(CHAIN_NAME)
		if (chain === null) throw new Error("missing chain")
		const item = store.getItemById(chain.id, "1")
		if (item === null) throw new Error("missing item")
		return item
	} finally {
		store.close()
	}
}
