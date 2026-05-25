import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { startCoderLoopDaemon } from "./daemon"
import { openSqliteStateStore } from "./sqlite-state"
import { resolveChainRuntimePaths } from "./runtime-paths"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const FIXTURE_CHAIN_NAME = "fixture-chain"
const SQLITE_STATE_MODULE = resolve(REPO_ROOT, "src/sqlite-state.ts")
const FORMER_LOOP_SENTINEL = `.${"dev-loop"}`
const FORMER_TRACE_ARTIFACT = `.${"dev-trace"}.txt`

type ConfigShape = "json" | "toml"
type StatusSmokeSnapshot = {
	target?: { cwd?: string }
	state?: { kind?: string; ok?: boolean }
	queue?: { total?: number; selected?: { id?: string } | null }
	current?: object
	events?: object
	processes?: object
}

type FixtureQueueItem = {
	id?: string
	issue?: number
	status: string
	attempts?: number
	title?: string | null
	priority?: string | null
	branch?: string | null
	pr?: number | null
	lastRunId?: string | null
	issueFile?: string | null
	evidenceDir?: string | null
	agentCwd?: string | null
	runner?: "claude" | "codex" | null
	[key: string]: unknown
}

type FixtureState = {
	queue: FixtureQueueItem[]
	recentRuns?: unknown[]
	current?: Record<string, unknown> | null
	repository?: string | null
	baseBranch?: string | null
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

function claudeHostEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env }
	env.CLAUDECODE = "1"
	delete env["CODEX_SHELL"]
	delete env["CODEX_THREAD_ID"]
	delete env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]
	return env
}

async function seedLoopDb(target: string, preset: string, state: FixtureState): Promise<string> {
	const loopDataRoot = resolve(target, ".coder-loop/runtime/loop-data")
	await rm(loopDataRoot, { recursive: true, force: true })
	await mkdir(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: FIXTURE_CHAIN_NAME,
			preset,
			repository: state.repository ?? "fixture/repo",
			baseBranch: state.baseBranch ?? "main",
			metadata: { recentRuns: Array.isArray(state.recentRuns) ? state.recentRuns.filter(isJsonValue) : [] },
		})
		await seedChainRuntimeLayout(loopDataRoot, chain.name, state)
		state.queue.forEach((entry, index) => {
			const issueNumber = typeof entry.issue === "number" ? entry.issue : index + 1
			store.createItem({
				chainId: chain.id,
				issueNumber,
				repoCwd: target,
				status: entry.status,
				attempts: entry.attempts ?? 0,
				title: entry.title ?? null,
				priority: entry.priority ?? null,
				branch: entry.branch ?? null,
				pr: entry.pr ?? null,
				lastRunId: entry.lastRunId ?? null,
				issueFile: entry.issueFile ?? null,
				evidenceDir: entry.evidenceDir ?? null,
				agentCwd: entry.agentCwd ?? null,
				runner: entry.runner ?? null,
				extra: queueItemExtra(entry),
			})
		})
		if (state.current) {
			const currentIssue = typeof state.current.issue === "number" ? state.current.issue : 1
			const item = store.getItemByIssue(chain.id, currentIssue) ?? store.listItems(chain.id)[0]
			if (item !== undefined) {
				const runId = typeof state.current.runId === "string" ? state.current.runId : "run-current"
				const phase = typeof state.current.phase === "string" ? state.current.phase : "iteration"
				const startedAtRaw = typeof state.current.startedAt === "string" ? Date.parse(state.current.startedAt) / 1000 : Date.now() / 1000
				const startedAt = Number.isFinite(startedAtRaw) ? startedAtRaw : Date.now() / 1000
				const extra = queueItemExtra(state.current)
				if (extra.issue === undefined) extra.issue = item.issueNumber
				store.recordRun({ runId, chainId: chain.id, itemId: item.id, phase, startedAt, extra })
				store.setCurrentRun({ chainId: chain.id, phase, runId, startedAt, extra })
			}
		}
	} finally {
		store.close()
	}
	return loopDataRoot
}

async function seedChainRuntimeLayout(loopDataRoot: string, chainName: string, state: FixtureState): Promise<void> {
	const paths = resolveChainRuntimePaths(chainName, { loopDataRoot })
	await mkdir(paths.issuesDir, { recursive: true })
	await mkdir(paths.evidenceDir, { recursive: true })
	await mkdir(paths.runsDir, { recursive: true })
	await writeFile(paths.sharedFile, "# placeholder shared context\n")
	for (const [index, entry] of state.queue.entries()) {
		const issueNumber = typeof entry.issue === "number" ? entry.issue : index + 1
		const itemId = typeof entry.id === "string" || typeof entry.id === "number"
			? String(entry.id)
			: typeof entry.issue === "number"
				? String(entry.issue)
				: String(issueNumber)
		const issueFile = typeof entry.issueFile === "string"
			? resolve(paths.chainRoot, entry.issueFile)
			: paths.issueFile(itemId)
		await mkdir(dirname(issueFile), { recursive: true })
		await writeFile(issueFile, `# ${itemId}\n`)
		const evidenceDir = typeof entry.evidenceDir === "string"
			? resolve(paths.chainRoot, entry.evidenceDir)
			: paths.issueEvidenceDir(itemId)
		await mkdir(evidenceDir, { recursive: true })
	}
}

function queueItemExtra(entry: Record<string, unknown>): JsonObject {
	const base = new Set(["status", "attempts", "title", "priority", "branch", "pr", "lastRunId", "issueFile", "evidenceDir", "agentCwd", "runner"])
	const extra: JsonObject = {}
	for (const [key, value] of Object.entries(entry)) {
		if (!base.has(key) && isJsonValue(value)) extra[key] = value
	}
	return extra
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue)
	return false
}

function dbUpdateCommand(loopDataRoot: string, issueNumber: number): string {
	const script = [
		`import { openSqliteStateStore } from ${JSON.stringify(SQLITE_STATE_MODULE)}`,
		`const [loopDataRoot, issue, status, blockerRepo, blockerRef, agentCwd] = Bun.argv.slice(1)`,
		`const store = openSqliteStateStore({ loopDataRoot })`,
		`const chain = store.getChainByName(${JSON.stringify(FIXTURE_CHAIN_NAME)})`,
		`if (chain === null) throw new Error("missing fixture chain")`,
		`const item = store.getItemByIssue(chain.id, Number(issue))`,
		`if (item === null) throw new Error("missing fixture item")`,
		`const extra = { ...item.extra }`,
		`if (blockerRepo) extra.blockerRepo = blockerRepo; else delete extra.blockerRepo`,
		`if (blockerRef) extra.blockerRef = blockerRef; else delete extra.blockerRef`,
		`store.updateItem(item.id, { status, extra, agentCwd: agentCwd || item.agentCwd })`,
		`store.clearCurrentRun(chain.id)`,
		`store.close()`,
	].join("; ")
	return `bun -e ${JSON.stringify(script)} ${JSON.stringify(loopDataRoot)} ${issueNumber}`
}

function readDbItem(target: string, issueNumber: number) {
	const loopDataRoot = resolve(target, ".coder-loop/runtime/loop-data")
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.getChainByName(FIXTURE_CHAIN_NAME)
		if (chain === null) throw new Error("missing fixture chain")
		const item = store.getItemByIssue(chain.id, issueNumber)
		if (item === null) throw new Error("missing fixture item")
		return item
	} finally {
		store.close()
	}
}

function updateDbItem(target: string, issueNumber: number, update: { status?: string; extra?: JsonObject; currentPhase?: string; runId?: string }): void {
	const loopDataRoot = resolve(target, ".coder-loop/runtime/loop-data")
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.getChainByName(FIXTURE_CHAIN_NAME)
		if (chain === null) throw new Error("missing fixture chain")
		const item = store.getItemByIssue(chain.id, issueNumber)
		if (item === null) throw new Error("missing fixture item")
		const updated = store.updateItem(item.id, {
			status: update.status ?? item.status,
			extra: update.extra === undefined ? item.extra : { ...item.extra, ...update.extra },
		})
		if (update.currentPhase !== undefined) {
			const runId = update.runId ?? "run-current"
			const startedAt = Date.now() / 1000
			if (store.getRunByRunId(runId) === null) store.recordRun({ runId, chainId: chain.id, itemId: updated.id, phase: update.currentPhase, startedAt, extra: updated.extra })
			store.setCurrentRun({ chainId: chain.id, phase: update.currentPhase, runId, startedAt, extra: updated.extra })
		}
	} finally {
		store.close()
	}
}

async function makeMinimalTarget(presetName: string, configShape: ConfigShape = "json"): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-smoke-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")
	if (configShape === "toml") {
		await writeFile(resolve(runtime, "config.toml"), `preset = "${presetName}"\nloopDataRoot = "${loopDataRoot}"\n`)
	} else {
		await writeFile(
			resolve(runtime, "config.json"),
			JSON.stringify({ preset: presetName, loopDataRoot }, null, 2),
		)
	}
	const state = {
		version: 1,
		queue: [
			{ id: "alpha", status: "pending" },
			{ id: "beta", status: "pending" },
		],
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	await seedLoopDb(dir, presetName, state)
	return dir
}

async function makeGhIssuePrTarget(kind: string, issue: number): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-gh-issue-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, `evidence/issue-${issue}`), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# gh issue fixture workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# shared\n\nNo durable facts.\n")
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({ preset: "gh-issue-pr-iteration", loopDataRoot }, null, 2))
	await writeFile(resolve(runtime, `issues/${issue}.md`), [
		`# Issue ${issue}`,
		"",
		"Unblocks: owner/repo#9000",
		"",
		`Fixture handoff for kind:${kind}.`,
		"",
	].join("\n"))
	const state = {
		version: 1,
		queue: [{
			issue,
			status: "queued",
			attempts: 0,
			title: `Fixture kind:${kind}`,
			priority: "high",
			branch: null,
			pr: null,
			lastRunId: null,
			issueFile: `issues/${issue}.md`,
			evidenceDir: `evidence/issue-${issue}`,
			agentCwd: null,
			runner: null,
			kind,
		}],
		repository: null,
		baseBranch: "main",
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	await seedLoopDb(dir, "gh-issue-pr-iteration", state)
	return dir
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await readFile(path)
		return true
	} catch {
		return false
	}
}

async function makePostReviewTriggerTarget(reviewStatus: "blocked" | "done"): Promise<{ dir: string; responderLog: string }> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-trigger-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	const presetDir = resolve(dir, ".coder-loop/post-review-trigger-preset")
	const responderLog = resolve(runtime, "responder-called.txt")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

	await writeFile(resolve(presetDir, "preset.toml"), [
		`name = "post-review-trigger-smoke"`,
		`version = 1`,
		`description = "Post-review trigger smoke preset."`,
		``,
		`[item]`,
		`idField = "id"`,
		``,
		`[statuses]`,
		`continuable = ["pending"]`,
		`terminal = ["blocked", "done"]`,
		``,
		`[[phases]]`,
		`name = "iteration"`,
		`prompt = "iter-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[[phases]]`,
		`name = "review"`,
		`prompt = "review-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[[phases]]`,
		`name = "responder"`,
		`prompt = "responder-entry.md"`,
		`trigger = { afterPhase = "review", whenStatus = "blocked" }`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[agent]`,
		`binary = "claude"`,
		`extraArgs = []`,
		``,
	].join("\n"))
	await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
	await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")
	await writeFile(resolve(presetDir, "responder-entry.md"), "RESPONDER {{ITEM_ID}} {{RUN_ID}}\n")

	const fakeCodex = resolve(dir, "fake-codex.sh")
	const fakeClaude = resolve(dir, "fake-claude.sh")
	await writeFile(fakeCodex, [
		`#!/usr/bin/env bash`,
		`if [[ "$*" == *RESPONDER* ]]; then printf 'responder\\n' >> ${JSON.stringify(responderLog)}; fi`,
		`echo '{"type":"thread.started","thread_id":"thread-trigger-smoke"}'`,
		`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })
	await writeFile(fakeClaude, [
		`#!/usr/bin/env bash`,
		`${dbUpdateCommand(loopDataRoot, 1)} ${JSON.stringify(reviewStatus)} ${reviewStatus === "blocked" ? JSON.stringify("owner/dependency") : "''"} ${reviewStatus === "blocked" ? JSON.stringify("#267") : "''"}`,
		`echo 'REVIEW SUMMARY: verdict=${reviewStatus === "blocked" ? "blocked" : "accepted"}; issue=#alpha; actionable=0; reason=fixture'`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })

	await writeFile(resolve(runtime, "config.json"), JSON.stringify({
		presetPath: presetDir,
		loopDataRoot,
		codex: { binary: fakeCodex, extraArgs: [] },
		claude: { binary: fakeClaude, extraArgs: [] },
	}, null, 2))
	const state = {
		version: 1,
		queue: [{
			id: "alpha",
			status: "pending",
			issueFile: "issues/alpha.md",
			evidenceDir: "evidence/alpha",
		}],
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	await seedLoopDb(dir, "post-review-trigger-smoke", state)
	await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")
	return { dir, responderLog }
}

describe("smoke: single-phase-example preset", () => {
	test("--check-runtime passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Runtime check passed: target=")
		expect(stderr).toContain("Runtime check passed: repo=fixture/repo")
		expect(stderr).toContain("Runtime check passed: preset=single-phase-example")
		expect(stderr).toContain("queue=2, selected=alpha")
	})

	test("--dry-run passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: target=")
		expect(stderr).toContain("Dry run: repo=fixture/repo")
		expect(stderr).toContain("Dry run: selected=alpha")
	})

	test("--dry-run selects the source-writing no-merge route for fixture", async () => {
		const target = resolve(REPO_ROOT, "test-fixtures/no-merge-code-spike-target")
		const state = JSON.parse(await readFile(resolve(target, ".coder-loop/runtime", "state.json"), "utf-8")) as FixtureState
		const loopDataRoot = await seedLoopDb(target, "gh-issue-pr-iteration", state)
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--loop-data-root", loopDataRoot, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: selected=9001")
		expect(stderr).toContain("Dry run: kind=code-spike")
		expect(stderr).toContain("Dry run: iterationRoute=iter/source-writing-spike")
		expect(stderr).toContain("Dry run: noMerge=true")
		expect(stderr).not.toContain("gh pr merge")
	})

	test("--dry-run selects the blocked resolver route for fixture", async () => {
		const target = await makeGhIssuePrTarget("blocked", 9002)
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: selected=9002")
		expect(stderr).toContain("Dry run: kind=blocked")
		expect(stderr).toContain("Dry run: iterationRoute=iter/resolve-blocker")
		expect(stderr).not.toContain("Dry run: noMerge=true")
	})

	test("--check-runtime passes with config.toml only", async () => {
		const target = await makeMinimalTarget("single-phase-example", "toml")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Runtime check passed: preset=single-phase-example")
		expect(stderr).toContain("queue=2, selected=alpha")
		expect(stderr).toMatch(/config=.*db\.sqlite \(json\)/)
	})

	test("status <target> --json emits parseable supervisor snapshot", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.target?.cwd).toBe(target)
		expect(snapshot.state?.kind).toBe("ok")
		expect(snapshot.state?.ok).toBe(true)
		expect(snapshot.queue?.total).toBe(2)
		expect(snapshot.queue?.selected?.id).toBe("alpha")
		expect(snapshot.current).toBeDefined()
		expect(snapshot.events).toBeDefined()
		expect(snapshot.processes).toBeDefined()
	})

	test("status <target> --json reports missing state as JSON instead of throwing", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		await rm(resolve(target, ".coder-loop/runtime/loop-data"), { recursive: true, force: true })
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(proc.exitCode).toBe(0)
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.state?.kind).toBe("missing-state")
		expect(snapshot.state?.ok).toBe(false)
	})

	test("daemon status <target> --json emits parseable process snapshot", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "daemon", "status", target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const snapshot = JSON.parse(stdout) as StatusSmokeSnapshot
		expect(snapshot.target?.cwd).toBe(target)
		expect(snapshot.processes).toBeDefined()
	})

	test("daemon start <target> --require-browser-evidence --dry-run shows the launch command", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "daemon", "start", target, "--require-browser-evidence", "--max-iterations", "10", "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		expect(stdout).toContain("daemon start dry-run: chain=fixture-chain")
		expect(stdout).toContain("daemon start dry-run: central-daemon=required")
		expect(stdout).toContain("require-browser-evidence=true")
		expect(stdout).not.toContain("command=")
	})

	test("doctor <target> emits live runtime health section", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "doctor", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("[Live Runtime] coder-loop runtime health")
		expect(stderr).toContain("OK: state ok")
		expect(stderr).toContain("runner hostDefault=")
		expect(stderr).toContain("target default runner=")
		expect(stderr).toContain("queue total=2")
		expect(stderr).toContain("live processes total=")
	})

	test("doctor <target> checks the configured runner binary", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		await writeFile(
			resolve(target, ".coder-loop/runtime/config.json"),
			JSON.stringify({
				preset: "single-phase-example",
				runner: "codex",
				codex: { binary: "missing-codex-for-doctor-test" },
			}, null, 2),
		)
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "doctor", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(1)
		expect(stderr).toContain("INFO: target default runner=codex (config, binary=missing-codex-for-doctor-test, model=<default>)")
		expect(stderr).toContain("INFO: review default runner=claude (review-default, binary=claude, model=claude-opus-4-7)")
		expect(stderr).toContain("FAIL: codex runner CLI (missing-codex-for-doctor-test) 未在 PATH 中")
	})
})

describe("smoke: post-review phase triggers", () => {
	test("runs a trigger phase when review changes the item to the matching status", async () => {
		const { dir, responderLog } = await makePostReviewTriggerTarget("blocked")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Starting trigger phase responder after review")
		expect(await readFile(responderLog, "utf-8")).toBe("responder\n")
		const item = readDbItem(dir, 1)
		expect(item.extra.blockerRepo).toBe("owner/dependency")
		expect(item.extra.blockerRef).toBe("#267")
	})

	test("skips a trigger phase when review changes the item to a different status", async () => {
		const { dir, responderLog } = await makePostReviewTriggerTarget("done")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Skipping trigger phase responder: status=done, wanted=blocked")
		expect(await pathExists(responderLog)).toBe(false)
		const item = readDbItem(dir, 1)
		expect(item.extra.blockerRepo).toBeUndefined()
		expect(item.extra.blockerRef).toBeUndefined()
	})

	test("bundled blocked-responder trigger uses the blocked item's target agentCwd", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-bundled-responder-"))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const loopDataRoot = resolve(runtime, "loop-data")
		const targetRepo = resolve(dir, "dependency-repo")
		const responderCwdLog = resolve(runtime, "blocked-responder-cwd.txt")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/issue-9100"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(targetRepo, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# bundled responder fixture workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# shared\n")

		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`prompt="$*"`,
			`if [[ "$prompt" == *"blocked-responder agent"* ]]; then pwd > ${JSON.stringify(responderCwdLog)}; fi`,
			`echo '{"type":"thread.started","thread_id":"thread-bundled-responder"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			`${dbUpdateCommand(loopDataRoot, 9100)} blocked owner/dependency '#267' ${JSON.stringify(targetRepo)}`,
			`echo 'REVIEW SUMMARY: verdict=blocked; issue=#9100; actionable=1; reason=fixture cross-repo blocker'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			preset: "gh-issue-pr-iteration",
			loopDataRoot,
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		const state = {
			version: 1,
			queue: [{
				issue: 9100,
				kind: "code",
				status: "queued",
				attempts: 0,
				title: "Fixture bundled blocked responder",
				priority: "medium",
				branch: null,
				pr: null,
				lastRunId: null,
				issueFile: null,
				evidenceDir: "evidence/issue-9100",
				agentCwd: null,
				runner: null,
			}],
			repository: null,
			baseBranch: null,
			recentRuns: [],
			current: null,
		}
		await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
		await seedLoopDb(dir, "gh-issue-pr-iteration", state)

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Starting trigger phase blocked-responder after review")
		expect((await readFile(responderCwdLog, "utf-8")).trim()).toBe(await realpath(targetRepo))
		const item = readDbItem(dir, 9100)
		expect(item.status).toBe("blocked")
		expect(item.agentCwd).toBe(targetRepo)
	})
})

describe("smoke: queue unblock CLI", () => {
	test("requeues a blocked item and clears blocker metadata without touching unrelated fields", async () => {
		const issue = 9200
		const dir = await makeGhIssuePrTarget("blocked", issue)
		const stateFile = resolve(dir, ".coder-loop/runtime", "state.json")
		const beforeState = await readFile(stateFile, "utf-8")
		updateDbItem(dir, issue, {
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
			currentPhase: "review",
			runId: "r1",
		})

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "queue", "unblock", dir, "--issue", "owner/source#9200"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toBe("")
		const result = JSON.parse(stdout)
		expect(result.mutation.changed).toBe(true)
		expect(result.mutation.clearedBlockerRepo).toBe(true)
		expect(result.mutation.clearedBlockerRef).toBe(true)
		expect(result.daemon.skipped).toBe(true)
		expect(result.verification.itemStatus).toBe("queued")
		expect(result.verification.blockerRepoPresent).toBe(false)
		expect(result.verification.blockerRefPresent).toBe(false)

		expect(await readFile(stateFile, "utf-8")).toBe(beforeState)
		const updated = readDbItem(dir, issue)
		expect(updated.status).toBe("queued")
		expect(updated.extra.blockerRepo).toBeUndefined()
		expect(updated.extra.blockerRef).toBeUndefined()
	})

	test("dry-run reports daemon start plan without writing state", async () => {
		const issue = 9201
		const dir = await makeGhIssuePrTarget("blocked", issue)
		const stateFile = resolve(dir, ".coder-loop/runtime", "state.json")
		const beforeState = await readFile(stateFile, "utf-8")
		updateDbItem(dir, issue, {
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
		})

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "queue", "unblock", dir, "--issue", "#9201", "--start-daemon", "--require-browser-evidence", "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = new TextDecoder().decode(proc.stdout)
		expect(proc.exitCode).toBe(0)
		const result = JSON.parse(stdout)
		expect(result.dryRun).toBe(true)
		expect(result.daemon.requested).toBe(true)
		expect(result.daemon.plan.command).toContain("--require-browser-evidence")

		expect(await readFile(stateFile, "utf-8")).toBe(beforeState)
		const updated = readDbItem(dir, issue)
		expect(updated.status).toBe("blocked")
		expect(updated.extra.blockerRepo).toBe("owner/dependency")
		expect(updated.extra.blockerRef).toBe("#267")
	})
})

describe("smoke: dependency-aware scheduler selection", () => {
	test("scheduler skips items with unmet dependsOn", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-dependency-scheduler-"))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const loopDataRoot = resolve(runtime, "loop-data")
		const runnerLog = resolve(runtime, "dependency-scheduler-runner.jsonl")
		const fakeRunner = resolve(dir, "fake-runner.ts")
		await mkdir(runtime, { recursive: true })
		await writeFile(fakeRunner, [
			`import { appendFile } from "node:fs/promises"`,
			`const promptIndex = Bun.argv.indexOf("-p")`,
			`const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"`,
			`const input = JSON.parse(prompt)`,
			`await appendFile(input.runnerLog, JSON.stringify({ issueNumber: input.issueNumber, itemId: input.itemId }) + "\\n")`,
			`console.log("done:" + input.issueNumber)`,
			``,
		].join("\n"))
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: {
					kind: "claude",
					source: "iteration-default",
					binary: "bun",
					extraArgs: [fakeRunner],
					model: null,
				},
				worktreeManager: async ({ repoCwd }) => repoCwd,
				runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}`,
				prompt: ({ item }) => JSON.stringify({ runnerLog, issueNumber: item.issueNumber, itemId: item.id }),
			},
		})
		try {
			const store = openSqliteStateStore({ loopDataRoot })
			try {
				const chain = store.createChain({
					name: "dependency-scheduler",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
				})
				const prerequisite = store.createItem({ chainId: chain.id, issueNumber: 2671, repoCwd: dir, status: "queued", priority: "10" })
				store.createItem({
					chainId: chain.id,
					issueNumber: 2672,
					repoCwd: dir,
					status: "queued",
					priority: "00",
					extra: { dependsOn: [prerequisite.id] },
				})
			} finally {
				store.close()
			}

			const completed = await waitFor(async () => (await fileLineCount(runnerLog)) >= 2, 5_000)
			expect(completed).toBe(true)
			const events = (await readFile(runnerLog, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { issueNumber: number })
			expect(events.map((event) => event.issueNumber)).toEqual([2671, 2672])
			const finalized = await waitFor(async () => {
				const store = openSqliteStateStore({ loopDataRoot })
				try {
					const chain = store.getChainByName("dependency-scheduler")
					if (chain === null || chain.status !== "completed") return false
					const items = store.listItems(chain.id)
					return items.length === 2 && items.every((item) => item.status === "done")
				} finally {
					store.close()
				}
			}, 5_000)
			expect(finalized).toBe(true)
		} finally {
			await daemon.stop()
		}
	})
})

describe("smoke: phase runner selection", () => {
	test("default iteration runner uses Codex while review stays Claude", async () => {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-review-runner-"))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const loopDataRoot = resolve(runtime, "loop-data")
		const presetDir = resolve(dir, ".coder-loop/two-phase-preset")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

		await writeFile(resolve(presetDir, "preset.toml"), [
			`name = "two-phase-smoke"`,
			`version = 1`,
			`description = "Two phase smoke preset."`,
			``,
			`[item]`,
			`idField = "id"`,
			``,
			`[statuses]`,
			`continuable = ["pending"]`,
			`terminal = ["done"]`,
			``,
			`[[phases]]`,
			`name = "iteration"`,
			`prompt = "iter-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[[phases]]`,
			`name = "review"`,
			`prompt = "review-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[agent]`,
			`binary = "claude"`,
			`extraArgs = []`,
			``,
		].join("\n"))
		await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
		await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")

		const callsPath = resolve(dir, "runner-calls.log")
		const claudeArgsPath = resolve(dir, "claude-args.log")
		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`echo codex >> "${callsPath}"`,
			`echo '{"type":"thread.started","thread_id":"thread-codex-smoke"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			`echo claude >> "${callsPath}"`,
			`printf '%s\\n' "$@" > "${claudeArgsPath}"`,
			`echo 'REVIEW SUMMARY: done'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			presetPath: presetDir,
			loopDataRoot,
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		const state = {
			version: 1,
			queue: [{
				id: "alpha",
				status: "pending",
				issueFile: "issues/alpha.md",
				evidenceDir: "evidence/alpha",
			}],
			recentRuns: [],
			current: null,
		}
		await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
		await seedLoopDb(dir, "two-phase-smoke", state)
		await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")

		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Selected runner: codex (iteration-default")
		expect(stderr).toContain("Review runner: claude (review-default")
		expect(stderr).toContain("model=claude-opus-4-7")
		expect((await readFile(callsPath, "utf-8")).trim().split("\n")).toEqual(["codex", "claude"])
		const claudeArgs = (await readFile(claudeArgsPath, "utf-8")).trim().split("\n")
		const modelIdx = claudeArgs.indexOf("--model")
		expect(modelIdx).toBeGreaterThanOrEqual(0)
		expect(claudeArgs[modelIdx + 1]).toBe("claude-opus-4-7")
	}, 15_000)

	async function makeTwoPhaseReviewTarget(reviewScript: readonly string[], prefix: string): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), prefix))
		const runtime = resolve(dir, ".coder-loop/runtime")
		const loopDataRoot = resolve(runtime, "loop-data")
		const presetDir = resolve(dir, ".coder-loop/two-phase-stop-preset")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
		await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

		await writeFile(resolve(presetDir, "preset.toml"), [
			`name = "two-phase-stop-smoke"`,
			`version = 1`,
			`description = "Two phase stop smoke preset."`,
			``,
			`[item]`,
			`idField = "id"`,
			``,
			`[statuses]`,
			`continuable = ["pending"]`,
			`terminal = ["done"]`,
			``,
			`[[phases]]`,
			`name = "iteration"`,
			`prompt = "iter-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[[phases]]`,
			`name = "review"`,
			`prompt = "review-entry.md"`,
			`  [phases.variables]`,
			`  ITEM_ID = "item.id"`,
			`  RUN_ID = "runtime.runId"`,
			``,
			`[agent]`,
			`binary = "claude"`,
			`extraArgs = []`,
			``,
		].join("\n"))
		await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
		await writeFile(resolve(presetDir, "review-entry.md"), "REVIEW {{ITEM_ID}} {{RUN_ID}}\n")

		const fakeCodex = resolve(dir, "fake-codex.sh")
		const fakeClaude = resolve(dir, "fake-claude.sh")
		await writeFile(fakeCodex, [
			`#!/usr/bin/env bash`,
			`echo '{"type":"thread.started","thread_id":"thread-stop-smoke"}'`,
			`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })
		await writeFile(fakeClaude, [
			`#!/usr/bin/env bash`,
			...reviewScript,
			`exit 0`,
			``,
		].join("\n"), { mode: 0o755 })

		await writeFile(resolve(runtime, "config.json"), JSON.stringify({
			presetPath: presetDir,
			loopDataRoot,
			codex: { binary: fakeCodex, extraArgs: [] },
			claude: { binary: fakeClaude, extraArgs: [] },
		}, null, 2))
		const state = {
			version: 1,
			queue: [{
				id: "alpha",
				status: "pending",
				issueFile: "issues/alpha.md",
				evidenceDir: "evidence/alpha",
			}],
			recentRuns: [],
			current: null,
		}
		await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
		await seedLoopDb(dir, "two-phase-stop-smoke", state)
		await writeFile(resolve(runtime, "issues/alpha.md"), "# alpha\n")
		return dir
	}

	test("review verdict=stop exits without target-local sentinel signaling", async () => {
		const dir = await makeTwoPhaseReviewTarget([
			`echo 'gh issue comment failed: This command requires approval'`,
			`echo 'REVIEW SUMMARY: verdict=stop; issue=#alpha; actionable=1; reason=review infrastructure broken'`,
		], "coder-loop-review-stop-")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(await Bun.file(resolve(dir, FORMER_LOOP_SENTINEL)).exists()).toBe(false)
		expect(stderr).toContain("review agent requested loop stop via REVIEW SUMMARY.")
		expect(stderr).toContain("Review agent requested loop stop.")
	}, 15_000)

	test("quoted old review stop summary does not request stop without a final stop verdict", async () => {
		const dir = await makeTwoPhaseReviewTarget([
			`echo 'old review log:'`,
			`echo 'REVIEW SUMMARY: verdict=stop; issue=#alpha; actionable=1; reason=review infrastructure broken'`,
			`echo 'review output ended without a final stop summary'`,
		], "coder-loop-review-stale-stop-")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(await Bun.file(resolve(dir, FORMER_LOOP_SENTINEL)).exists()).toBe(false)
		expect(stderr).not.toContain("review agent requested loop stop via REVIEW SUMMARY.")
		expect(stderr).not.toContain("Review agent requested loop stop.")
	}, 15_000)
})

type Issue185Fixture = {
	target: string
	loopDataRoot: string
	runId: string
	runDir: string
}

async function makeIssue185ArtifactFixture(options: { reviewReadsTrace?: boolean } = {}): Promise<Issue185Fixture> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-issue-185-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	const presetDir = resolve(dir, ".coder-loop/issue-185-preset")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/alpha"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")
	await writeFile(resolve(presetDir, "preset.toml"), [
		`name = "issue-185-artifact-smoke"`,
		`version = 1`,
		`description = "Issue 185 artifact layout smoke preset."`,
		``,
		`[item]`,
		`idField = "id"`,
		``,
		`[statuses]`,
		`continuable = ["pending"]`,
		`terminal = ["done"]`,
		``,
		`[[phases]]`,
		`name = "iteration"`,
		`prompt = "iter-entry.md"`,
		`  [phases.variables]`,
		`  ITEM_ID = "item.id"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[[phases]]`,
		`name = "review"`,
		`prompt = "review-entry.md"`,
		`  [phases.variables]`,
		`  LOG_DIR = "runtime.logDir"`,
		`  RUN_ID = "runtime.runId"`,
		``,
		`[agent]`,
		`binary = "claude"`,
		`extraArgs = []`,
		``,
	].join("\n"))
	await writeFile(resolve(presetDir, "iter-entry.md"), "ITER {{ITEM_ID}} {{RUN_ID}}\n")
	await writeFile(resolve(presetDir, "review-entry.md"), "TRACE={{LOG_DIR}}/{{RUN_ID}}/iteration/stdout.jsonl\nRUN={{RUN_ID}}\n")

	const traceEvidence = resolve(dir, "review-trace-path.txt")
	const fakeCodex = resolve(dir, "fake-codex.sh")
	const fakeClaude = resolve(dir, "fake-claude.sh")
	await writeFile(fakeCodex, [
		`#!/usr/bin/env bash`,
		`echo '{"type":"thread.started","thread_id":"thread-issue-185"}'`,
		`echo '{"type":"item.completed","item":{"type":"agent_message","text":"ITERATION SUMMARY: done"}}'`,
		`exit 0`,
		``,
	].join("\n"), { mode: 0o755 })
	const reviewScript = options.reviewReadsTrace
		? [
				`prompt=""`,
				`prev=""`,
				`for arg in "$@"; do if [ "$prev" = "-p" ]; then prompt="$arg"; fi; prev="$arg"; done`,
				`trace="$(printf '%s\\n' "$prompt" | sed -n 's/^TRACE=//p' | head -n 1)"`,
				`test -f "$trace"`,
				`grep -q 'ITERATION SUMMARY' "$trace"`,
				`printf '%s\\n' "$trace" > "${traceEvidence}"`,
				`echo 'REVIEW SUMMARY: verdict=accepted; issue=#alpha; reason=trace-read'`,
			]
		: [`echo 'REVIEW SUMMARY: done'`]
	await writeFile(fakeClaude, [`#!/usr/bin/env bash`, ...reviewScript, `exit 0`, ``].join("\n"), { mode: 0o755 })
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({
		presetPath: presetDir,
		loopDataRoot,
		codex: { binary: fakeCodex, extraArgs: [] },
		claude: { binary: fakeClaude, extraArgs: [] },
	}, null, 2))
	const state = {
		version: 1,
		queue: [{ id: "alpha", issue: 1, status: "pending", issueFile: "issues/alpha.md", evidenceDir: "evidence/alpha" }],
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	await seedLoopDb(dir, "issue-185-artifact-smoke", state)
	const proc = Bun.spawnSync({
		cmd: ["bun", LOOP_ENTRY, "--target-cwd", dir, "--once"],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: claudeHostEnv(),
	})
	if (proc.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(proc.stderr))
	}
	const item = readDbItem(dir, 1)
	if (item.lastRunId === null) throw new Error("missing lastRunId")
	const paths = resolveChainRuntimePaths(FIXTURE_CHAIN_NAME, { loopDataRoot })
	return { target: dir, loopDataRoot, runId: item.lastRunId, runDir: paths.runDir(item.lastRunId) }
}

describe("issue #185 chain artifact layout", () => {
	test("iteration run artifacts per chain", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		expect(await Bun.file(resolve(fixture.runDir, "iteration/stdout.jsonl")).exists()).toBe(true)
		expect(fixture.runDir).toContain(`/loop-data/chains/${FIXTURE_CHAIN_NAME}/runs/${fixture.runId}`)
	})

	test("per-run files complete", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		for (const phase of ["iteration", "review"]) {
			for (const file of ["stdout.jsonl", "stderr.txt", "status.json", "sessions.jsonl"]) {
				expect(await Bun.file(resolve(fixture.runDir, phase, file)).exists()).toBe(true)
			}
		}
		expect(await Bun.file(resolve(fixture.runDir, "events.jsonl")).exists()).toBe(true)
	})

	test("daemon log per chain", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		const daemonDir = resolve(fixture.loopDataRoot, "chains", FIXTURE_CHAIN_NAME, "daemon")
		const batches = await readdir(daemonDir)
		expect(batches.length).toBeGreaterThan(0)
		expect(await Bun.file(resolve(daemonDir, batches[0]!, "daemon.log")).exists()).toBe(true)
	})

	test("no top-level logs or events", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		const topLevel = await readdir(fixture.loopDataRoot)
		expect(topLevel).not.toContain("logs")
		expect(topLevel).not.toContain("events")
	})

	test("main loop leaves target-local sentinels absent", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		expect(await Bun.file(resolve(fixture.target, FORMER_LOOP_SENTINEL)).exists()).toBe(false)
		expect(await Bun.file(resolve(fixture.target, FORMER_TRACE_ARTIFACT)).exists()).toBe(false)
	})

	test("review reads stdout jsonl", async () => {
		const fixture = await makeIssue185ArtifactFixture({ reviewReadsTrace: true })
		const trace = (await readFile(resolve(fixture.target, "review-trace-path.txt"), "utf-8")).trim()
		expect(trace).toBe(resolve(fixture.runDir, "iteration/stdout.jsonl"))
		expect(await readFile(trace, "utf-8")).toContain("ITERATION SUMMARY")
	})

	test("status doctor reports chain paths", async () => {
		const fixture = await makeIssue185ArtifactFixture()
		const status = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "status", fixture.target, "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		expect(status.exitCode).toBe(0)
		const snapshot = JSON.parse(new TextDecoder().decode(status.stdout)) as { target: { logDir: string }; events: { path: string | null } }
		expect(snapshot.target.logDir).toContain(`/loop-data/chains/${FIXTURE_CHAIN_NAME}/runs`)
		expect(snapshot.events.path).toBe(resolve(fixture.runDir, "events.jsonl"))

		const checkRuntime = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", fixture.target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: claudeHostEnv(),
		})
		expect(checkRuntime.exitCode).toBe(0)
		expect(new TextDecoder().decode(checkRuntime.stderr)).toContain(`Runtime check passed: chain=${FIXTURE_CHAIN_NAME}`)
	})
})

async function makeIdleTarget(): Promise<{ target: string; counterPath: string; lockPath: string }> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-idle-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	const loopDataRoot = resolve(runtime, "loop-data")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")

	const counterPath = resolve(dir, "fake-agent-calls.log")
	const fakeAgent = resolve(dir, "fake-agent.sh")
	await writeFile(
		fakeAgent,
		`#!/usr/bin/env bash
date "+%H:%M:%S.%N invocation" >> "${counterPath}"
echo "REVIEW SUMMARY: noop"
exit 0
`,
	)
	await Bun.spawnSync({ cmd: ["chmod", "+x", fakeAgent] })

	await writeFile(
		resolve(runtime, "config.json"),
		JSON.stringify({
			preset: "single-phase-example",
			loopDataRoot,
			runner: "claude",
			claude: { binary: fakeAgent, extraArgs: [] },
		}, null, 2),
	)
	const state = { version: 1, queue: [], recentRuns: [], current: null }
	await writeFile(
		resolve(runtime, "state.json"),
		JSON.stringify(state, null, 2),
	)
	await seedLoopDb(dir, "single-phase-example", state)
	return {
		target: dir,
		counterPath,
		lockPath: resolve(loopDataRoot, "review-on-empty.lock"),
	}
}

async function fileLineCount(path: string): Promise<number> {
	try {
		const text = await readFile(path, "utf-8")
		return text.length === 0 ? 0 : text.split("\n").filter((line) => line.length > 0).length
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return true
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
	return false
}

describe("daemon idle behavior — review-on-empty lock + idle ticks (issue #69)", () => {
	test("main loop lifecycle via signal", async () => {
		const { target, counterPath } = await makeIdleTarget()
		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})
		const started = await waitFor(async () => (await fileLineCount(counterPath)) >= 1, 5000)
		expect(started).toBe(true)
		expect(await Bun.file(resolve(target, FORMER_LOOP_SENTINEL)).exists()).toBe(false)
		proc.kill("SIGTERM")
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)
		const stderr = await new Response(proc.stderr).text()
		expect(stderr).toContain("Stop requested by SIGTERM")
	})

	test("empty queue: runs review-on-empty once, writes lock, subsequent idle ticks skip review until lock removed", async () => {
		const { target, counterPath, lockPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		const lockAppeared = await waitFor(async () => (await fileLineCount(counterPath)) >= 1 && (await Bun.file(lockPath).exists()), 5000)
		expect(lockAppeared).toBe(true)
		const callsAfterFirstReview = await fileLineCount(counterPath)
		expect(callsAfterFirstReview).toBe(1)

		await new Promise((resolve) => setTimeout(resolve, 500))
		const callsAfterIdleTicks = await fileLineCount(counterPath)
		expect(callsAfterIdleTicks).toBe(1)

		proc.kill("SIGTERM")
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)

		const stderr = await new Response(proc.stderr).text()
		expect(stderr).toContain("Empty queue: running review-on-empty for global state assessment.")
		expect(stderr).toContain("review-on-empty lock written:")
		const idleCount = (stderr.match(/Idle: empty queue \+ review-on-empty lock present\. Sleeping 50ms\./g) ?? []).length
		expect(idleCount).toBeGreaterThanOrEqual(2)

		const lockContent = JSON.parse(await readFile(lockPath, "utf-8"))
		expect(lockContent.reason).toBe("queue-drained")
		expect(typeof lockContent.runId).toBe("string")
		expect(lockContent.runId).toMatch(/^run-/)
	}, 15_000)

	test("removing the lock externally triggers a fresh review-on-empty on the next idle tick", async () => {
		const { target, counterPath, lockPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		const firstLockSeen = await waitFor(async () => (await fileLineCount(counterPath)) >= 1 && (await Bun.file(lockPath).exists()), 5000)
		expect(firstLockSeen).toBe(true)

		await rm(lockPath, { force: true })

		const secondLockSeen = await waitFor(async () => {
			const calls = await fileLineCount(counterPath)
			const lockBack = await Bun.file(lockPath).exists()
			return calls >= 2 && lockBack
		}, 5000)
		expect(secondLockSeen).toBe(true)
		expect(await fileLineCount(counterPath)).toBe(2)

		proc.kill("SIGTERM")
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)
	}, 15_000)

	test("idle ticks do not burn --max-iterations budget; daemon stays alive with --max-iterations=1 until removed", async () => {
		const { target, counterPath } = await makeIdleTarget()

		const proc = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "1"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODER_LOOP_IDLE_SLEEP_MS: "50" },
		})

		await waitFor(async () => (await fileLineCount(counterPath)) >= 1, 5000)
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(proc.exitCode).toBeNull()
		expect(await fileLineCount(counterPath)).toBe(1)

		proc.kill("SIGTERM")
		const exitCode = await proc.exited
		expect(exitCode).toBe(0)

		const stderr = await new Response(proc.stderr).text()
		expect(stderr).not.toContain("Reached 1 work iterations")
	}, 15_000)
})
