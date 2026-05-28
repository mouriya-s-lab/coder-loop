import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/smoke-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("smoke: v2 central chain CLI", () => {
	test("no-subcommand invocation is usage-only and does not enter a loop", () => {
		const result = runCli([])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toContain("Usage: coder-loop <command> [options]")
		expect(result.stdout).toContain("daemon <up|down|status|start|stop|restart>")
	})

	test("status and queue unblock use SQLite state", async () => {
		const fixture = await createTarget("chain-smoke")
		seedChain(fixture, {
			issueNumber: 333,
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
		})
		const beforeState = await readFile(fixture.legacyStatePath, "utf-8")
		const beforeMtime = (await stat(fixture.legacyStatePath)).mtimeMs

		const unblocked = expectJsonOk(runCli(["queue", "unblock", fixture.target, "--issue", "333", "--chain", fixture.chainName]))
		expect(unblocked.mutation.changed).toBe(true)
		expect(unblocked.verification.itemStatus).toBe("queued")

		const snapshot = expectJsonOk(runCli(["status", fixture.target, "--chain", fixture.chainName, "--json"]))
		expect(snapshot.state.kind).toBe("ok")
		expect(snapshot.queue.total).toBe(1)
		expect(snapshot.queue.selected.id).toBe("333")
		expect(await readFile(fixture.legacyStatePath, "utf-8")).toBe(beforeState)
		expect((await stat(fixture.legacyStatePath)).mtimeMs).toBe(beforeMtime)
	})

	test("daemon start dry-run resolves a chain and emits central-daemon plan", async () => {
		const fixture = await createTarget("daemon-smoke")
		seedChain(fixture, { issueNumber: 184, status: "queued", extra: { issueKind: "code" } })

		const result = runCli(["daemon", "start", fixture.target, "--chain", fixture.chainName, "--dry-run", "--require-browser-evidence"])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain(`daemon start dry-run: chain=${fixture.chainName}`)
		expect(result.stdout).toContain("daemon start dry-run: central-daemon=required")
		expect(result.stdout).toContain("daemon start dry-run: require-browser-evidence=true")
	})
})

type Fixture = {
	target: string
	loopDataRoot: string
	chainName: string
	legacyStatePath: string
}

type SeedOptions = {
	issueNumber: number
	status: string
	extra?: Record<string, string>
}

async function createTarget(name: string): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const target = resolve(root, "target")
	const runtime = resolve(target, ".coder-loop/runtime")
	const loopDataRoot = resolve(root, "loop-data")
	const chainName = `${name}-chain`
	await mkdir(resolve(target, ".coder-loop"), { recursive: true })
	await mkdir(runtime, { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# shared\n")
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({ loopDataRoot }, null, 2))
	const legacyStatePath = resolve(runtime, "state.json")
	await writeFile(legacyStatePath, `${JSON.stringify({ queue: [], recentRuns: [], current: null }, null, 2)}\n`)
	return { target, loopDataRoot, chainName, legacyStatePath }
}

function seedChain(fixture: Fixture, options: SeedOptions): void {
	const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
	try {
		const chain = store.createChain({
			name: fixture.chainName,
			preset: "gh-issue-pr-iteration",
			repository: "fixture/repo",
			baseBranch: "main",
			metadata: {},
		})
		store.createItem({
			chainId: chain.id,
			issueNumber: options.issueNumber,
			repoCwd: fixture.target,
			status: options.status,
			issueFile: null,
			evidenceDir: null,
			extra: options.extra ?? {},
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

function expectJsonOk(result: { exitCode: number | null; stdout: string; stderr: string }): any {
	expect(result.exitCode, result.stderr).toBe(0)
	return JSON.parse(result.stdout)
}
