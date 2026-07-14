#!/usr/bin/env bun
/**
 * 进程级引擎集成验收 harness（issue #681）。不是 e2e——runner 是确定性 stub、
 * 业务负载是合成的；它证明引擎的真实进程面，真实 e2e 由生产 dogfood loop 承担。
 *
 * 单命令驱动一轮完整、本地、确定性的引擎进程级验收：
 *   本地 git fixture → 隔离 loop-data 起真实中央 daemon → chain create + item add →
 *   引擎按 preset phase 顺序真实 spawn 子进程 stub runner（PATH shim 把 `claude`
 *   解析到 scripts/engine-integration-stub-runner.ts）→ iteration 在 slot worktree 真实
 *   commit → review 经 daemon socket 凭据准入（#397 gate）写终态 → 断言 SQLite
 *   runs / 审计事件 / worktree 回收 / 无孤儿 → teardown。
 *
 * 无 LLM、无 GitHub、无网络；不持有任何跨运行共享资源——多个实例可并发运行
 * （#681 并发前提）。预算：单次 60 秒内。
 *
 * 用法：
 *   bun scripts/engine-integration.ts [--max-wall-seconds N] [--max-runs N]
 *     [--poll-seconds N] [--keep-work-dir]
 *
 * 退出码：0 = 全链路成功且断言通过；1 = 失败 / tripwire / 断言失败。
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const STUB_RUNNER = resolve(REPO_ROOT, "scripts/engine-integration-stub-runner.ts")
const PRESET_NAME = "engine-integration"
const ITEM_KEY = "itg-item-1"
const TERMINAL_SUCCESS = "done"
const TERMINAL_FAILURE = ["exhausted"] as const

type HarnessOptions = {
	maxWallSeconds: number
	maxRuns: number
	pollSeconds: number
	keepWorkDir: boolean
}

function parseArgs(argv: readonly string[]): HarnessOptions {
	const options: HarnessOptions = {
		maxWallSeconds: 60,
		maxRuns: 6,
		pollSeconds: 1,
		keepWorkDir: false,
	}
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i]
		if (flag === undefined) break
		if (flag === "--keep-work-dir") {
			options.keepWorkDir = true
			i -= 1
			continue
		}
		const value = argv[i + 1]
		if (value === undefined) fail(`flag ${flag} 缺少值`)
		switch (flag) {
			case "--max-wall-seconds":
				options.maxWallSeconds = parsePositiveInt(flag, value)
				break
			case "--max-runs":
				options.maxRuns = parsePositiveInt(flag, value)
				break
			case "--poll-seconds":
				options.pollSeconds = parsePositiveInt(flag, value)
				break
			default:
				fail(`未知 flag: ${flag}`)
		}
	}
	return options
}

function parsePositiveInt(flag: string, value: string): number {
	const parsed = Number.parseInt(value, 10)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} 需要正整数，得到 ${value}`)
	return parsed
}

function fail(message: string): never {
	throw new Error(message)
}

function log(message: string): void {
	// 完整 ISO 时间戳：并发验收（issue #681 row 3）用它比对两个 run 的有效窗口重叠。
	process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

// dogfood 场景下 harness 可能由 coder-loop agent 启动：外层 run 的凭据与 loop-data
// 指针不得泄漏进本轮验收的 daemon / agent 环境（#615 同源约束）。
export function sanitizedSubprocessEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...parentEnvironment }
	delete environment.CODER_LOOP_RUN_CRED
	delete environment.CODER_LOOP_DATA_DIR
	return environment
}

type ShResult = { stdout: string; stderr: string; exitCode: number }

function sh(cmd: readonly string[], opts?: { cwd?: string; allowFail?: boolean; env?: NodeJS.ProcessEnv }): ShResult {
	const proc = spawnSync(cmd[0]!, cmd.slice(1), {
		cwd: opts?.cwd ?? REPO_ROOT,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: opts?.env ?? sanitizedSubprocessEnvironment(process.env),
	})
	const result = { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? 1 }
	if (result.exitCode !== 0 && opts?.allowFail !== true) {
		fail(`命令失败 (exit ${result.exitCode}): ${cmd.join(" ")}\n${result.stderr}`)
	}
	return result
}

// ----------------------------------------------------------------- fixture

function prepareLocalFixture(workDir: string): string {
	const fixtureCwd = resolve(workDir, "fixture")
	mkdirSync(fixtureCwd, { recursive: true })
	log(`fixture: 本地 git repo ${fixtureCwd}`)
	sh(["git", "init", "-b", "main"], { cwd: fixtureCwd })
	writeFileSync(resolve(fixtureCwd, "README.md"), "engine-integration local fixture\n")
	sh(["git", "add", "README.md"], { cwd: fixtureCwd })
	sh(["git", "-c", "user.name=engine-integration", "-c", "user.email=harness@engine-integration.local",
		"commit", "-m", "chore: seed engine-integration fixture"], { cwd: fixtureCwd })
	return fixtureCwd
}

// ------------------------------------------------------------------ daemon

type DaemonHandle = {
	child: ChildProcess
	loopDataRoot: string
	stdoutPath: string
	stderrPath: string
	shimDir: string
	shimmedEnv: NodeJS.ProcessEnv
}

// 引擎解析 runner binary 的唯一面是 PATH 上的 kind 名（docs/preset-authoring.md
// `[agent]`）。shim 目录同时提供：
//   coder-loop → 当前 checkout 的 src/loop.ts（agent 面 CLI 回到被测代码）
//   claude     → 确定性 stub runner（engine-integration preset 两个 phase 都声明 runner="claude"）
function writeShims(workDir: string): string {
	const shimDir = resolve(workDir, "cli-shim")
	mkdirSync(shimDir, { recursive: true })
	const shims: Record<string, string> = {
		"coder-loop": `#!/bin/sh\nexec bun ${LOOP_ENTRY} "$@"\n`,
		claude: `#!/bin/sh\nexec bun ${STUB_RUNNER} "$@"\n`,
	}
	for (const [name, script] of Object.entries(shims)) {
		const shimPath = resolve(shimDir, name)
		writeFileSync(shimPath, script)
		chmodSync(shimPath, 0o755)
	}
	return shimDir
}

function startDaemon(workDir: string): DaemonHandle {
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const stdoutPath = resolve(workDir, "daemon.stdout.log")
	const stderrPath = resolve(workDir, "daemon.stderr.log")
	const shimDir = writeShims(workDir)
	const shimmedEnv: NodeJS.ProcessEnv = {
		...sanitizedSubprocessEnvironment(process.env),
		PATH: `${shimDir}:${process.env.PATH ?? ""}`,
	}
	log(`daemon: 隔离 loop-data-root 起中央 daemon: ${loopDataRoot}`)
	log(`daemon: PATH 前置 shim: ${shimDir} (coder-loop → src/loop.ts, claude → stub runner)`)
	const stdoutFd = openSync(stdoutPath, "a")
	const stderrFd = openSync(stderrPath, "a")
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], {
		cwd: REPO_ROOT,
		stdio: ["ignore", stdoutFd, stderrFd],
		env: shimmedEnv,
	})
	closeSync(stdoutFd)
	closeSync(stderrFd)
	return { child, loopDataRoot, stdoutPath, stderrPath, shimDir, shimmedEnv }
}

async function waitForDaemonSocket(daemon: DaemonHandle, timeoutSeconds: number): Promise<void> {
	const socketPath = resolve(daemon.loopDataRoot, "daemon.sock")
	const deadline = Date.now() + timeoutSeconds * 1000
	while (Date.now() < deadline) {
		if (existsSync(socketPath)) {
			log(`daemon: socket 就绪 ${socketPath}`)
			return
		}
		if (daemon.child.exitCode !== null) {
			fail(`daemon 进程提前退出 (exit ${daemon.child.exitCode})，stderr 见 ${daemon.stderrPath}`)
		}
		await Bun.sleep(100)
	}
	fail(`daemon socket ${timeoutSeconds}s 内未就绪，stderr 见 ${daemon.stderrPath}`)
}

async function stopDaemon(daemon: DaemonHandle): Promise<void> {
	log("daemon: down")
	const down = sh(["bun", LOOP_ENTRY, "daemon", "down", "--loop-data-root", daemon.loopDataRoot], { allowFail: true })
	if (down.exitCode !== 0) {
		log(`daemon: down 命令 exit ${down.exitCode}: ${down.stderr.trim() || down.stdout.trim()}`)
	}
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline && daemon.child.exitCode === null) {
		await Bun.sleep(100)
	}
	if (daemon.child.exitCode === null) {
		log("daemon: down 超时，SIGTERM 收尾")
		daemon.child.kill("SIGTERM")
		await Bun.sleep(1000)
		if (daemon.child.exitCode === null) daemon.child.kill("SIGKILL")
	}
	killOrphanProcesses(daemon.loopDataRoot)
}

// teardown 不能留任何以本轮 loop-data root 为标识的进程（stub runner 或 daemon 残骸）。
function killOrphanProcesses(loopDataRoot: string): void {
	const result = sh(["pgrep", "-f", loopDataRoot], { allowFail: true })
	for (const line of result.stdout.split("\n")) {
		const pid = Number.parseInt(line.trim(), 10)
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
		log(`teardown: 强杀残留进程 pid=${pid}`)
		try {
			process.kill(-pid, "SIGKILL")
		} catch {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				// already gone
			}
		}
	}
}

// ------------------------------------------------------------------- watch

type StatusSnapshot = {
	queue?: {
		byStatus?: Record<string, number>
	}
}

function readStatus(fixtureCwd: string, loopDataRoot: string, chainName: string): StatusSnapshot {
	const result = sh(["bun", LOOP_ENTRY, "status", fixtureCwd,
		"--json", "--loop-data-root", loopDataRoot, "--chain", chainName], { allowFail: true })
	if (result.exitCode !== 0) return {}
	try {
		return JSON.parse(result.stdout) as StatusSnapshot
	} catch {
		return {}
	}
}

function countRuns(loopDataRoot: string): number {
	const dbPath = resolve(loopDataRoot, "db.sqlite")
	if (!existsSync(dbPath)) return 0
	try {
		const db = new Database(dbPath, { readonly: true })
		try {
			const row = db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
			return row.n
		} finally {
			db.close()
		}
	} catch {
		return 0
	}
}

type WatchVerdict =
	| { kind: "success" }
	| { kind: "terminal-failure"; status: string }
	| { kind: "tripwire"; reason: string }

async function watch(options: HarnessOptions, fixtureCwd: string, loopDataRoot: string, chainName: string): Promise<WatchVerdict> {
	const startedAt = Date.now()
	let lastSummary = ""
	for (;;) {
		const elapsedSeconds = (Date.now() - startedAt) / 1000
		if (elapsedSeconds > options.maxWallSeconds) {
			return { kind: "tripwire", reason: `wall-time ${elapsedSeconds.toFixed(1)}s 超过上界 ${options.maxWallSeconds}s` }
		}
		const runs = countRuns(loopDataRoot)
		if (runs > options.maxRuns) {
			return { kind: "tripwire", reason: `runs 数 ${runs} 超过上界 ${options.maxRuns}（spin 信号）` }
		}
		const snapshot = readStatus(fixtureCwd, loopDataRoot, chainName)
		const byStatus = snapshot.queue?.byStatus ?? {}
		const summary = `byStatus=${JSON.stringify(byStatus)} runs=${runs}`
		if (summary !== lastSummary) {
			log(`watch: ${summary} elapsed=${elapsedSeconds.toFixed(1)}s`)
			lastSummary = summary
		}
		if ((byStatus[TERMINAL_SUCCESS] ?? 0) >= 1) return { kind: "success" }
		for (const status of TERMINAL_FAILURE) {
			if ((byStatus[status] ?? 0) >= 1) return { kind: "terminal-failure", status }
		}
		await Bun.sleep(options.pollSeconds * 1000)
	}
}

// ------------------------------------------------------------------ assert

type RunRow = { phase: string; status: string }

function readRunRows(loopDataRoot: string): RunRow[] {
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true })
	try {
		return db.query("SELECT phase, status FROM runs ORDER BY started_at").all() as RunRow[]
	} finally {
		db.close()
	}
}

function countAdmissionEvents(fixtureCwd: string, loopDataRoot: string, chainName: string): number {
	const result = sh(["bun", LOOP_ENTRY, "logs", fixtureCwd, "--json",
		"--type", "item.status.write_admission",
		"--chain", chainName,
		"--loop-data-root", loopDataRoot])
	const parsed = JSON.parse(result.stdout) as { events?: unknown[] }
	return Array.isArray(parsed.events) ? parsed.events.length : 0
}

type Evidence = {
	runRows: RunRow[]
	admissionEvents: number
	markerCommit: string
	durationSeconds: number
}

async function assertEngineOutcome(
	fixtureCwd: string,
	daemon: DaemonHandle,
	chainName: string,
	startedAt: number,
): Promise<Evidence> {
	log("assert: SQLite runs 记录（≥2 phase，含 iteration 与 review）")
	const runRows = readRunRows(daemon.loopDataRoot)
	const phases = new Set(runRows.map((row) => row.phase))
	if (runRows.length < 2 || !phases.has("iteration") || !phases.has("review")) {
		fail(`runs 记录不含完整 phase 序列: ${JSON.stringify(runRows)}`)
	}

	log("assert: item.status.write_admission 审计事件（status 写走 daemon 凭据准入）")
	const admissionEvents = countAdmissionEvents(fixtureCwd, daemon.loopDataRoot, chainName)
	if (admissionEvents < 1) fail(`未观察到 item.status.write_admission 审计事件`)

	log("assert: stub runner 的 marker commit 真实落在 fixture 的 git 对象库")
	const markerLog = sh(["git", "log", "--all", "--oneline", "--grep", "engine-integration: marker"], { cwd: fixtureCwd })
	const markerCommit = markerLog.stdout.trim().split("\n")[0] ?? ""
	if (markerCommit === "") fail("fixture git log 中找不到 stub runner 的 marker commit")

	return {
		runRows,
		admissionEvents,
		markerCommit,
		durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
	}
}

// chain 完成（唯一 item 落 done）时引擎调用 cleanupSchedulerChainWorktrees 回收
// slot worktree（src/scheduler.ts chain-completion 路径）；teardown 后这里断言回收结果。
async function assertWorktreesRecycled(fixtureCwd: string, loopDataRoot: string, chainName: string): Promise<void> {
	log("assert: 引擎 slot worktree 已回收")
	const worktreesDir = resolve(loopDataRoot, "chains", chainName, "worktrees")
	if (existsSync(worktreesDir)) {
		const leftovers = await readdir(worktreesDir)
		if (leftovers.length > 0) fail(`引擎 worktree 未回收: ${worktreesDir} → ${leftovers.join(", ")}`)
	}
	const registered = sh(["git", "worktree", "list", "--porcelain"], { cwd: fixtureCwd }).stdout
	const entries = registered.split("\n\n").filter((block) => block.trim().startsWith("worktree "))
	if (entries.length > 1) fail(`fixture 仍注册着引擎 worktree:\n${registered}`)
}

function assertNoOrphans(loopDataRoot: string): void {
	log("assert: 无孤儿进程")
	const result = sh(["pgrep", "-f", loopDataRoot], { allowFail: true })
	const orphans = result.stdout.split("\n")
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
	if (orphans.length > 0) fail(`teardown 后仍有孤儿进程: ${orphans.join(", ")}`)
}

// ----------------------------------------------------------------- diagnose

function dumpDiagnosis(fixtureCwd: string, daemon: DaemonHandle, chainName: string, reason: string): void {
	process.stderr.write(`\nengine-integration: 失败/止血: ${reason}\n`)
	process.stderr.write(`诊断材料:\n`)
	process.stderr.write(`  loop-data root: ${daemon.loopDataRoot}\n`)
	process.stderr.write(`  daemon stdout : ${daemon.stdoutPath}\n`)
	process.stderr.write(`  daemon stderr : ${daemon.stderrPath}\n`)
	const snapshot = sh(["bun", LOOP_ENTRY, "status", fixtureCwd,
		"--json", "--loop-data-root", daemon.loopDataRoot, "--chain", chainName], { allowFail: true })
	process.stderr.write(`  status --json :\n${snapshot.stdout}\n`)
}

// -------------------------------------------------------------------- main

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2))
	const startedAt = Date.now()
	const runKey = randomUUID()
	const workDir = resolve(REPO_ROOT, ".coder-loop/runtime/engine-integration", runKey)
	mkdirSync(workDir, { recursive: true })
	log(`engine-integration: run ${runKey} 开始（并发安全：无跨运行共享资源）`)
	const fixtureCwd = prepareLocalFixture(workDir)
	const chainName = `engine-integration-${runKey}`
	const daemon = startDaemon(workDir)
	let exitCode = 1
	try {
		await waitForDaemonSocket(daemon, 15)

		log(`chain create: ${chainName} (preset=${PRESET_NAME})`)
		sh(["bun", LOOP_ENTRY, "chain", "create", chainName,
			"--config-json", JSON.stringify({ repository: "engine-integration/local-fixture", baseBranch: "main" }),
			"--preset", PRESET_NAME,
			"--force",
			"--loop-data-root", daemon.loopDataRoot])

		log(`item add: ${ITEM_KEY} → chain ${chainName}`)
		sh(["bun", LOOP_ENTRY, "item", "add", chainName,
			"--issue", ITEM_KEY,
			"--repo-cwd", fixtureCwd,
			"--preset", PRESET_NAME,
			"--loop-data-root", daemon.loopDataRoot])

		const verdict = await watch(options, fixtureCwd, daemon.loopDataRoot, chainName)
		if (verdict.kind !== "success") {
			const reason = verdict.kind === "tripwire" ? `tripwire: ${verdict.reason}` : `item 落入失败终态 ${verdict.status}`
			dumpDiagnosis(fixtureCwd, daemon, chainName, reason)
			return 1
		}

		const evidence = await assertEngineOutcome(fixtureCwd, daemon, chainName, startedAt)
		await stopDaemon(daemon)
		await assertWorktreesRecycled(fixtureCwd, daemon.loopDataRoot, chainName)
		assertNoOrphans(daemon.loopDataRoot)

		log("")
		log("===== engine-integration evidence =====")
		log(`terminal   : item ${ITEM_KEY} → done`)
		log(`phases     : ${evidence.runRows.map((row) => `${row.phase}(${row.status})`).join(" → ")}`)
		log(`admission  : ${evidence.admissionEvents} item.status.write_admission event(s) via daemon socket`)
		log(`marker     : ${evidence.markerCommit}`)
		log(`duration   : ${evidence.durationSeconds}s (budget ${options.maxWallSeconds}s)`)
		log(`loop-data  : ${daemon.loopDataRoot}${options.keepWorkDir ? " (kept)" : " (removed in teardown)"}`)
		log("===============================")
		exitCode = 0
		return 0
	} finally {
		if (daemon.child.exitCode === null) await stopDaemon(daemon)
		if (exitCode === 0 && !options.keepWorkDir) {
			rmSync(workDir, { recursive: true, force: true })
		} else if (exitCode !== 0) {
			log(`诊断保留: ${workDir}`)
		}
	}
}

if (import.meta.main) {
	try {
		process.exit(await main())
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`engine-integration: ${message}\n`)
		process.exit(1)
	}
}
