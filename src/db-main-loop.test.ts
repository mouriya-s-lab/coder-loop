import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/db-main-loop-tests", String(process.pid))
const SQLITE_STATE_MODULE = resolve(REPO_ROOT, "src/sqlite-state.ts")
const CHAIN_NAME = "db-main-loop"

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("db-backed main loop hard cut", () => {
	test("main loop phase advances db status", async () => {
		const fixture = await createFixture({ reviewDbUpdate: "done" })
		const result = runLoop(fixture)
		expect(result.exitCode).toBe(0)
		expect(readItem(fixture.loopDataRoot).status).toBe("done")
	})

	test("main loop writes current_runs", async () => {
		const fixture = await createFixture()
		const result = runLoop(fixture)
		expect(result.exitCode).toBe(0)
		const current = readCurrentRun(fixture.loopDataRoot)
		expect(current?.phase).toBe("review")
		expect(current?.extra.id).toBe("alpha")
	})

	test("main loop does not touch state json", async () => {
		const fixture = await createFixture({ reviewDbUpdate: "done" })
		const beforeText = await readFile(fixture.stateFile, "utf-8")
		const beforeMtime = (await stat(fixture.stateFile)).mtimeMs
		const result = runLoop(fixture)
		expect(result.exitCode).toBe(0)
		expect(await readFile(fixture.stateFile, "utf-8")).toBe(beforeText)
		expect((await stat(fixture.stateFile)).mtimeMs).toBe(beforeMtime)
	})

	test("main loop db unavailable explicit fail", async () => {
		const fixture = await createFixture({ seedDb: false })
		const result = runCli(["--target-cwd", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--check-runtime"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("SQLite state DB does not exist")
		expect(result.stderr).not.toContain("state.json")
	})

	test("queue unblock db only", async () => {
		const fixture = await createFixture({ initialStatus: "blocked", extra: { blockerRepo: "owner/dependency", blockerRef: "#267" } })
		const beforeText = await readFile(fixture.stateFile, "utf-8")
		const result = runCli(["queue", "unblock", fixture.target, "--issue", "alpha", "--loop-data-root", fixture.loopDataRoot])
		expect(result.exitCode).toBe(0)
		expect(readItem(fixture.loopDataRoot).status).toBe("queued")
		expect(readItem(fixture.loopDataRoot).extra.blockerRepo).toBeUndefined()
		expect(await readFile(fixture.stateFile, "utf-8")).toBe(beforeText)
	})

	test("check-runtime db only", async () => {
		const fixture = await createFixture()
		await rm(fixture.stateFile)
		const result = runCli(["--target-cwd", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--check-runtime"])
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toContain("Runtime check passed: queue=1, selected=alpha")
	})

	test("daemon start target-cwd resolves chain without per-target state writes", async () => {
		const fixture = await createFixture({ reviewDbUpdate: "done" })
		const beforeText = await readFile(fixture.stateFile, "utf-8")
		const result = runCli(["daemon", "start", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain(`daemon start dry-run: chain=${CHAIN_NAME}`)
		expect(readItem(fixture.loopDataRoot).status).toBe("pending")
		expect(await readFile(fixture.stateFile, "utf-8")).toBe(beforeText)
	})

	test("removed legacy state functions", async () => {
		const source = await readFile(LOOP_ENTRY, "utf-8")
		for (const name of [`load${"State"}`, `save${"State"}`, `reconcile${"State"}AfterIter`]) {
			expect(source).not.toContain(`function ${name}`)
			expect(source).not.toContain(`${name}(`)
		}
		expect(source).not.toContain("exists(options.stateFile)")
	})
})

type FixtureOptions = {
	seedDb?: boolean
	initialStatus?: string
	reviewDbUpdate?: string
	extra?: Record<string, string>
}

type Fixture = {
	target: string
	loopDataRoot: string
	stateFile: string
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const target = resolve(root, "target")
	const runtime = resolve(target, ".coder-loop/runtime")
	const presetDir = resolve(target, ".coder-loop/db-preset")
	const loopDataRoot = resolve(runtime, "loop-data")
	const stateFile = resolve(runtime, "state.json")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", CHAIN_NAME), { recursive: true })
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# shared\n")
	await writeFile(resolve(loopDataRoot, "chains", CHAIN_NAME, "shared.md"), "# shared\n")
	await writePreset(presetDir)
	await writeRunner(resolve(target, "fake-iter.sh"), "ITERATION SUMMARY: ok")
	await writeRunner(resolve(target, "fake-review.sh"), "REVIEW SUMMARY: ok", options.reviewDbUpdate, loopDataRoot)
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({
		presetPath: presetDir,
		loopDataRoot,
		codex: { binary: resolve(target, "fake-iter.sh"), extraArgs: [] },
		claude: { binary: resolve(target, "fake-review.sh"), extraArgs: [] },
	}, null, 2))
	const state = {
		version: 1,
		queue: [{
			id: "alpha",
			status: options.initialStatus ?? "pending",
			issueFile: "issues/alpha.md",
			evidenceDir: "evidence/alpha",
		}],
		recentRuns: [],
		current: null,
	}
	await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)
	await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")
	if (options.seedDb !== false) seedDb(loopDataRoot, target, options)
	return { target, loopDataRoot, stateFile }
}

async function writePreset(presetDir: string): Promise<void> {
	await writeFile(resolve(presetDir, "preset.toml"), [
		`name = "db-main-loop-test"`,
		`version = 1`,
		`description = "DB main loop fixture."`,
		``,
		`[item]`,
		`idField = "id"`,
		``,
		`[statuses]`,
		`continuable = ["pending", "queued", "in_progress"]`,
		`terminal = ["done", "blocked"]`,
		``,
		`[[phases]]`,
		`name = "iteration"`,
		`prompt = "iter-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		``,
		`[[phases]]`,
		`name = "review"`,
		`prompt = "review-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		``,
		`[agent]`,
		`binary = "codex"`,
		`extraArgs = []`,
		``,
	].join("\n"))
	await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}}\n")
	await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}}\n")
}

async function writeRunner(path: string, summary: string, reviewDbUpdate?: string, loopDataRoot?: string): Promise<void> {
	const update = reviewDbUpdate === undefined
		? []
		: [`bun -e ${JSON.stringify(dbUpdateScript)} ${JSON.stringify(loopDataRoot)} ${JSON.stringify(reviewDbUpdate)}`]
	await writeFile(path, [
		`#!/usr/bin/env bash`,
		...update,
		`echo ${JSON.stringify(summary)}`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })
}

const dbUpdateScript = [
	`import { openSqliteStateStore } from ${JSON.stringify(SQLITE_STATE_MODULE)}`,
	`const [loopDataRoot, status] = Bun.argv.slice(1)`,
	`const store = openSqliteStateStore({ loopDataRoot })`,
	`const chain = store.getChainByName(${JSON.stringify(CHAIN_NAME)})`,
	`if (chain === null) throw new Error("missing chain")`,
	`const item = store.getItemByIssue(chain.id, 1)`,
	`if (item === null) throw new Error("missing item")`,
	`store.updateItem(item.id, { status })`,
	`store.clearCurrentRun(chain.id)`,
	`store.close()`,
].join("; ")

function seedDb(loopDataRoot: string, target: string, options: FixtureOptions): void {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: CHAIN_NAME,
			preset: "db-main-loop-test",
			repository: "fixture/repo",
			baseBranch: "main",
			metadata: {
				runner: "codex",
				reviewRunner: "claude",
				presetPath: presetDirForTarget(target),
				codex: { binary: resolve(target, "fake-iter.sh"), extraArgs: [] },
				claude: { binary: resolve(target, "fake-review.sh"), extraArgs: [] },
			},
		})
		store.createItem({
			chainId: chain.id,
			issueNumber: 1,
			repoCwd: target,
			status: options.initialStatus ?? "pending",
			issueFile: "issues/alpha.md",
			evidenceDir: "evidence/alpha",
			extra: { id: "alpha", issueKind: "code", ...(options.extra ?? {}) },
		})
	} finally {
		store.close()
	}
}

function presetDirForTarget(target: string): string {
	return resolve(target, ".coder-loop/db-preset")
}

function runLoop(fixture: Fixture): { exitCode: number | null; stderr: string } {
	return runCli(["--target-cwd", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--once"])
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

function readCurrentRun(loopDataRoot: string) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.getChainByName(CHAIN_NAME)
		if (chain === null) throw new Error("missing chain")
		return store.getCurrentRun(chain.id)
	} finally {
		store.close()
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const startedAt = Date.now()
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition not met")
		await new Promise((resolveWait) => setTimeout(resolveWait, 25))
	}
}
