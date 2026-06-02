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

	test("runtime show lists preset phases with role-md runner selections", async () => {
		const fixture = await createTarget("runtime-show")
		const snapshot = expectJsonOk(runCli(["runtime", "show", fixture.target, "--json"]))
		expect(snapshot.preset.name).toBe("gh-issue-pr-iteration")
		expect(snapshot.defaults.claudeModel).toBeNull()
		expect(snapshot.defaults.codexModel).toBeNull()
		const phaseNames = snapshot.phases.map((p: { phase: string }) => p.phase)
		expect(phaseNames).toEqual(["iteration", "review", "blocked-responder", "umbrella-finalizer"])
		const review = snapshot.phases.find((p: { phase: string }) => p.phase === "review")
		expect(review.role).toBe("review")
		expect(review.runner.kind).toBe("claude")
		expect(review.runner.source).toBe("role-md")
		expect(review.runner.model).toBeNull()
		const iter = snapshot.phases.find((p: { phase: string }) => p.phase === "iteration")
		expect(iter.runner.kind).toBe("codex")
		expect(iter.runner.source).toBe("role-md")
	})

	test("runtime set writes [1m]-suffixed Claude model and gpt-5.5 codex model into config.json", async () => {
		const fixture = await createTarget("runtime-set")
		const set = expectJsonOk(runCli([
			"runtime", "set", fixture.target,
			"--claude-model", "opus-4-8",
			"--codex-model", "gpt-5.5",
			"--json",
		]))
		expect(set.wrote).toBe(true)
		expect(set.changed["claude.model"].to).toBe("claude-opus-4-8[1m]")
		expect(set.changed["codex.model"].to).toBe("gpt-5.5")
		const configPath = resolve(fixture.target, ".coder-loop/runtime/config.json")
		const config = JSON.parse(await readFile(configPath, "utf-8"))
		expect(config.claude.model).toBe("claude-opus-4-8[1m]")
		expect(config.codex.model).toBe("gpt-5.5")
		expect(config.loopDataRoot).toBe(fixture.loopDataRoot)
		expect(config.runner).toBeUndefined()
		expect(config.reviewRunner).toBeUndefined()

		const snapshot = expectJsonOk(runCli(["runtime", "show", fixture.target, "--json"]))
		expect(snapshot.defaults.claudeModel).toBe("claude-opus-4-8[1m]")
		expect(snapshot.defaults.codexModel).toBe("gpt-5.5")
		const review = snapshot.phases.find((p: { phase: string }) => p.phase === "review")
		expect(review.runner.kind).toBe("claude")
		expect(review.runner.model).toBe("claude-opus-4-8[1m]")
		const iter = snapshot.phases.find((p: { phase: string }) => p.phase === "iteration")
		expect(iter.runner.kind).toBe("codex")
		expect(iter.runner.model).toBe("gpt-5.5")
	})

	test("runtime set rejects unknown enum values and no-op invocations", () => {
		const bad = runCli(["runtime", "set", "/tmp/cl-rt-bad", "--claude-model", "sonnet-4-5"])
		expect(bad.exitCode).toBe(1)
		expect(bad.stderr).toContain("--claude-model must be one of opus-4-7|opus-4-8")
		const empty = runCli(["runtime", "set", "/tmp/cl-rt-bad"])
		expect(empty.exitCode).toBe(1)
		expect(empty.stderr).toContain("pass at least one of")
		const noRunnerFlag = runCli(["runtime", "set", "/tmp/cl-rt-bad", "--iteration-runner", "claude"])
		expect(noRunnerFlag.exitCode).toBe(1)
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
	await mkdir(resolve(loopDataRoot, "chains", chainName, "issues"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", chainName, "evidence"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", chainName, "runs"), { recursive: true })
	await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
	await writeFile(resolve(loopDataRoot, "chains", chainName, "shared.md"), "# shared\n")
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
