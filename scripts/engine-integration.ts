#!/usr/bin/env bun
/**
 * 进程级引擎集成验收 harness（issue #681）。不是 e2e——runner 是确定性 stub、
 * 业务负载是合成的；它证明引擎的真实进程面，真实 e2e 由生产 dogfood loop 承担。
 *
 * 单命令驱动一轮完整、本地、确定性的引擎进程级验收：
 *   本地 git fixture → 隔离 loop-data 起真实中央 daemon → chain create + item add →
 *   引擎按 preset phase 顺序真实 spawn 子进程 stub runner（PATH shim 把 `claude`
 *   解析到 scripts/engine-integration-stub-runner.ts）→ iteration 在 closure worktree 真实
 *   commit → review 经 daemon socket 凭据准入（#397 gate）写终态 → 断言 SQLite
 *   runs / 审计事件 / successful-chain closure 消费回收 / 无孤儿 → teardown。
 *
 * 无 LLM、无 GitHub、无网络；不持有任何跨运行共享资源——多个实例可并发运行
 * （#681 并发前提）。预算：单次 60 秒内。
 *
 * 用法：
 *   bun scripts/engine-integration.ts --log-file <path> [--foreground]
 *     [--max-wall-seconds N] [--max-runs N] [--poll-seconds N] [--keep-work-dir]
 *
 * 默认 detached 后台运行；--foreground 阻塞等待。退出码：0 = 全链路成功且断言通过；
 * 1 = 失败 / tripwire / 断言失败；2 = 缺少必填的 --log-file。
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const STUB_RUNNER = resolve(REPO_ROOT, "scripts/engine-integration-stub-runner.ts")
const PRESET_NAME = "engine-integration"
const ITEM_KEY = "itg-item-1"
const TERMINAL_SUCCESS = "done"
const TERMINAL_FAILURE = ["exhausted"] as const
const BACKGROUND_CHILD_ENV = "CODER_LOOP_ENGINE_INTEGRATION_BACKGROUND_CHILD"
const USAGE = "bun scripts/engine-integration.ts --log-file <path> [--foreground] [--max-wall-seconds N] [--max-runs N] [--poll-seconds N] [--keep-work-dir]"

type HarnessOptions = {
	maxWallSeconds: number
	maxRuns: number
	pollSeconds: number
	keepWorkDir: boolean
	logFile: string
	foreground: boolean
}

function parseArgs(argv: readonly string[]): HarnessOptions {
	const options: HarnessOptions = {
		maxWallSeconds: 60,
		maxRuns: 6,
		pollSeconds: 1,
		keepWorkDir: false,
		logFile: "",
		foreground: false,
	}
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i]
		if (flag === undefined) break
		if (flag === "--keep-work-dir") {
			options.keepWorkDir = true
			continue
		}
		if (flag === "--foreground") {
			options.foreground = true
			continue
		}
		const value = argv[i + 1]
		if (value === undefined || value.startsWith("--")) fail(`flag ${flag} 缺少值`)
		switch (flag) {
			case "--log-file":
				options.logFile = resolve(process.cwd(), value)
				break
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
		i += 1
	}
	if (options.logFile === "") fail("--log-file <path> 必填")
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

type LogSink = { fd: number; path: string }

let activeLogSink: LogSink | null = null

function writeLog(text: string): void {
	if (activeLogSink === null) throw new Error("engine-integration log sink 尚未初始化")
	writeSync(activeLogSink.fd, text)
}

function log(message: string): void {
	// 完整 ISO 时间戳：并发验收（issue #681 row 3）用它比对两个 run 的有效窗口重叠。
	writeLog(`[${new Date().toISOString()}] ${message}\n`)
}

// dogfood 场景下 harness 可能由 coder-loop agent 启动：外层 run 的凭据与 loop-data
// 指针不得泄漏进本轮验收的 daemon / agent 环境（#615 同源约束）。
export function sanitizedSubprocessEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...parentEnvironment }
	delete environment.CODER_LOOP_RUN_CRED
	delete environment.CODER_LOOP_DATA_DIR
	delete environment[BACKGROUND_CHILD_ENV]
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
	if (activeLogSink === null) fail("daemon 启动前日志未初始化")
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const shimDir = writeShims(workDir)
	const shimmedEnv: NodeJS.ProcessEnv = {
		...sanitizedSubprocessEnvironment(process.env),
		PATH: `${shimDir}:${process.env.PATH ?? ""}`,
	}
	log(`daemon: 隔离 loop-data-root 起中央 daemon: ${loopDataRoot}`)
	log(`daemon: PATH 前置 shim: ${shimDir} (coder-loop → src/loop.ts, claude → stub runner)`)
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], {
		cwd: REPO_ROOT,
		stdio: ["ignore", activeLogSink.fd, activeLogSink.fd],
		env: shimmedEnv,
	})
	return { child, loopDataRoot, shimDir, shimmedEnv }
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
			fail(`daemon 进程提前退出 (exit ${daemon.child.exitCode})，输出见 ${activeLogSink?.path ?? "run log"}`)
		}
		await Bun.sleep(100)
	}
	fail(`daemon socket ${timeoutSeconds}s 内未就绪，输出见 ${activeLogSink?.path ?? "run log"}`)
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

type RunRow = { runId: string; phase: string; status: string }

function readRunRows(loopDataRoot: string): RunRow[] {
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true })
	try {
		return db.query("SELECT run_id AS runId, phase, status FROM runs ORDER BY started_at").all() as RunRow[]
	} finally {
		db.close()
	}
}

function logCapturedRunnerOutput(loopDataRoot: string, chainName: string, runRows: readonly RunRow[]): void {
	for (const row of runRows) {
		const phaseDir = resolve(loopDataRoot, "chains", chainName, "runs", row.runId, row.phase)
		for (const [stream, filename] of [["stdout", "stdout.jsonl"], ["stderr", "stderr.txt"]] as const) {
			const path = resolve(phaseDir, filename)
			if (!existsSync(path)) continue
			const output = readFileSync(path, "utf-8")
			log(`runner ${row.phase} ${stream}: ${path}`)
			if (output !== "") writeLog(output.endsWith("\n") ? output : `${output}\n`)
		}
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
	const unreachable = sh(["git", "fsck", "--no-reflogs", "--unreachable", "--no-progress"], { cwd: fixtureCwd })
	let markerCommit = ""
	for (const line of unreachable.stdout.split("\n")) {
		const match = /^unreachable commit ([0-9a-f]+)$/.exec(line.trim())
		if (match === null) continue
		const sha = match[1]!
		const subject = sh(["git", "show", "-s", "--format=%s", sha], { cwd: fixtureCwd }).stdout.trim()
		if (subject.includes("engine-integration: marker")) { markerCommit = `${sha.slice(0, 12)} ${subject}`; break }
	}
	if (markerCommit === "") fail("fixture git log 中找不到 stub runner 的 marker commit")

	return {
		runRows,
		admissionEvents,
		markerCommit,
		durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
	}
}

type ClosureStateRow = { lifecycle: string; worktree_path: string | null; branch_name: string | null }

async function assertSuccessfulChainClosuresConsumed(fixtureCwd: string, loopDataRoot: string, chainName: string): Promise<void> {
	log("assert: successful chain completion 消费 closure 并回收 worktree")
	const deadline = Date.now() + 10_000
	let rows: ClosureStateRow[] = []
	while (Date.now() < deadline) {
		const db = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true })
		try {
			rows = db.query<ClosureStateRow, { $chain: string }>("SELECT tc.lifecycle,tc.worktree_path,tc.branch_name FROM task_closures tc JOIN items i ON i.id=tc.item_row_id JOIN chains c ON c.id=i.chain_id WHERE c.name=$chain").all({ $chain: chainName })
		} finally { db.close() }
		if (rows.length >= 2 && rows.every((row) => row.lifecycle === "consumed" && row.worktree_path === null && row.branch_name === null)) break
		await Bun.sleep(100)
	}
	if (rows.length < 2 || rows.some((row) => row.lifecycle !== "consumed" || row.worktree_path !== null || row.branch_name !== null)) fail(`successful chain closures 未消费: ${JSON.stringify(rows)}`)
	const worktreesDir = resolve(loopDataRoot, "chains", chainName, "worktrees")
	const leftovers = existsSync(worktreesDir) ? await readdir(worktreesDir) : []
	if (leftovers.length > 0) fail(`successful chain closure worktree 未回收: ${worktreesDir} → ${leftovers.join(", ")}`)
	const registered = sh(["git", "worktree", "list", "--porcelain"], { cwd: fixtureCwd }).stdout
	const entries = registered.split("\n\n").filter((block) => block.trim().startsWith("worktree "))
	if (entries.length > 1) fail(`successful chain 仍注册 closure worktree:\n${registered}`)
}

function deleteChain(daemon: DaemonHandle, chainName: string): void {
	log("chain delete: 删除已消费 chain 的运行记录")
	sh(["bun", LOOP_ENTRY, "chain", "delete", chainName, "--loop-data-root", daemon.loopDataRoot, "--json"], { env: daemon.shimmedEnv })
}

// Explicit chain deletion consumes the retained closures and owns their final cleanup.
async function assertWorktreesRecycled(fixtureCwd: string, loopDataRoot: string, chainName: string): Promise<void> {
	log("assert: 显式 chain delete 后 closure worktree 已回收")
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
	writeLog(`\nengine-integration: 失败/止血: ${reason}\n`)
	writeLog("诊断材料:\n")
	writeLog(`  loop-data root: ${daemon.loopDataRoot}\n`)
	writeLog(`  run log       : ${activeLogSink?.path ?? "unknown"}\n`)
	const snapshot = sh(["bun", LOOP_ENTRY, "status", fixtureCwd,
		"--json", "--loop-data-root", daemon.loopDataRoot, "--chain", chainName], { allowFail: true })
	writeLog(`  status --json :\n${snapshot.stdout}\n`)
}

// -------------------------------------------------------------------- main

async function runHarness(options: HarnessOptions): Promise<number> {
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
		await assertSuccessfulChainClosuresConsumed(fixtureCwd, daemon.loopDataRoot, chainName)
		deleteChain(daemon, chainName)
		await assertWorktreesRecycled(fixtureCwd, daemon.loopDataRoot, chainName)
		await stopDaemon(daemon)
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
		try {
			logCapturedRunnerOutput(daemon.loopDataRoot, chainName, readRunRows(daemon.loopDataRoot))
		} catch (error) {
			log(`runner output 读取失败: ${error instanceof Error ? error.message : String(error)}`)
		}
		if (exitCode === 0 && !options.keepWorkDir) {
			rmSync(workDir, { recursive: true, force: true })
		} else if (exitCode !== 0) {
			log(`诊断保留: ${workDir}`)
		}
	}
}

function requiredLogFileArgument(argv: readonly string[]): string | null {
	const flagIndex = argv.indexOf("--log-file")
	if (flagIndex === -1) return null
	const value = argv[flagIndex + 1]
	return value === undefined || value.startsWith("--") ? null : value
}

function prepareBackgroundLog(logFile: string): number {
	mkdirSync(dirname(logFile), { recursive: true })
	writeFileSync(logFile, "")
	return openSync(logFile, "a")
}

function startBackground(argv: readonly string[], logFile: string): number {
	const logFd = prepareBackgroundLog(logFile)
	try {
		const scriptPath = process.argv[1] ?? resolve(REPO_ROOT, "scripts/engine-integration.ts")
		const child = spawn(process.execPath, [scriptPath, ...argv, "--foreground"], {
			cwd: process.cwd(),
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: { ...process.env, [BACKGROUND_CHILD_ENV]: "1" },
		})
		if (child.pid === undefined) fail("后台子进程未返回 pid")
		child.unref()
		process.stdout.write(`engine-integration: pid=${child.pid} log=${logFile}\n`)
		return 0
	} finally {
		closeSync(logFd)
	}
}

async function runForeground(argv: readonly string[], logFile: string): Promise<number> {
	const backgroundChild = process.env[BACKGROUND_CHILD_ENV] === "1"
	mkdirSync(dirname(logFile), { recursive: true })
	const logFd = openSync(logFile, backgroundChild ? "a" : "w")
	activeLogSink = { fd: logFd, path: logFile }
	let exitCode = 1
	try {
		try {
			const options = parseArgs(argv)
			if (options.logFile !== logFile) fail(`--log-file 解析不一致: ${options.logFile}`)
			exitCode = await runHarness(options)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log(`engine-integration: ${message}`)
			exitCode = 1
		}
		const summary = `engine-integration: exit=${exitCode} log=${logFile}`
		log(summary)
		if (!backgroundChild) process.stdout.write(`${summary}\n`)
		writeLog(`FINAL exit=${exitCode}\n`)
		return exitCode
	} finally {
		activeLogSink = null
		closeSync(logFd)
	}
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2)
	const rawLogFile = requiredLogFileArgument(argv)
	if (rawLogFile === null) {
		process.stderr.write(`engine-integration: --log-file <path> 必填；用法: ${USAGE}\n`)
		return 2
	}
	const logFile = resolve(process.cwd(), rawLogFile)
	return argv.includes("--foreground")
		? runForeground(argv, logFile)
		: startBackground(argv, logFile)
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
