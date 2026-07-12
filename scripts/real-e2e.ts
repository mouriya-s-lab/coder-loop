#!/usr/bin/env bun
/**
 * 真实 e2e harness（issue #464）。
 *
 * 单命令驱动一轮完整真实 loop：
 *   reset fixture → 脚本建 seed issue → 隔离 loop-data 起中央 daemon →
 *   chain create + item add → 真实 runner 跑 iter→review→PR→merge→issue close →
 *   tripwire 盯防 → 终态断言 → evidence 摘要。
 *
 * 不用任何 mock：runner 是真实 claude/codex CLI，GitHub 路径是真实 issue/PR
 * （#90 约束）。隔离靠 --loop-data-root，绝不触碰 ~/.coder-loop 生产 daemon。
 *
 * 用法：
 *   bun scripts/real-e2e.ts [--fixture-cwd <path>] [--fixture-repo <owner/repo>]
 *     [--max-wall-seconds N] [--max-attempts N] [--max-runs N] [--poll-seconds N]
 *
 * 退出码：0 = 全流程成功且断言通过；1 = 终态失败 / tripwire 触发 / 断言失败。
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { operatorSubprocessEnvironment } from "./real-e2e-environment"
import { acquireRealE2eGlobalMutex } from "./real-e2e-global-mutex"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const SEED_LABEL = "e2e-seed"
const FIXTURE_INITIAL_CONTENT = "status: pending\n"
const TERMINAL_SUCCESS = "done"
const TERMINAL_FAILURE = ["blocked", "moot", "exhausted"] as const

type HarnessOptions = {
	fixtureCwd: string
	fixtureRepo: string
	preset: string
	maxWallSeconds: number
	maxAttempts: number
	maxRuns: number
	pollSeconds: number
	keepStaleWorktrees: boolean
}

type FixtureRun = {
	cwd: string
	repository: string
	baseBranch: string
	runKey: string
	fixturePath: string
}

type WatchVerdict =
	| { kind: "success" }
	| { kind: "terminal-failure"; status: string }
	| { kind: "tripwire"; reason: string }

function parseArgs(argv: readonly string[]): HarnessOptions {
	const options: HarnessOptions = {
		fixtureCwd: resolve(REPO_ROOT, "../coder-loop-e2e-fixture"),
		fixtureRepo: "mouriya-s-lab/coder-loop-e2e-fixture",
		// 默认走最小 preset：e2e 的目的是验证引擎全链路（spawn/phase 推进/PR/merge/终态），
		// 不是 agent 编排质量；gh-issue-pr-iteration 的 orchestrator 开销（单 iter ~16min）
		// 用 --preset gh-issue-pr-iteration 按需选跑。
		preset: "real-e2e-minimal",
		maxWallSeconds: 2700,
		maxAttempts: 5,
		maxRuns: 20,
		pollSeconds: 15,
		keepStaleWorktrees: false,
	}
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i]
		if (flag === undefined) break
		if (flag === "--keep-stale-worktrees") {
			// 布尔 flag：保留陈尸 scheduler worktree，让引擎的自愈路径（#466）被真实
			// 触发——仅用于该路径的 e2e 验证。
			options.keepStaleWorktrees = true
			i -= 1
			continue
		}
		const value = argv[i + 1]
		if (value === undefined) fail(`flag ${flag} 缺少值`)
		switch (flag) {
			case "--fixture-cwd":
				options.fixtureCwd = resolve(value)
				break
			case "--fixture-repo":
				options.fixtureRepo = value
				break
			case "--preset":
				options.preset = value
				break
			case "--max-wall-seconds":
				options.maxWallSeconds = parsePositiveInt(flag, value)
				break
			case "--max-attempts":
				options.maxAttempts = parsePositiveInt(flag, value)
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
	const stamp = new Date().toISOString().slice(11, 19)
	process.stdout.write(`[${stamp}] ${message}\n`)
}

type ShResult = { stdout: string; stderr: string; exitCode: number }

function sh(cmd: readonly string[], opts?: { cwd?: string; allowFail?: boolean }): ShResult {
	const proc = spawnSync(cmd[0]!, cmd.slice(1), {
		cwd: opts?.cwd ?? REPO_ROOT,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: operatorSubprocessEnvironment(process.env),
	})
	const result = { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? 1 }
	if (result.exitCode !== 0 && opts?.allowFail !== true) {
		fail(`命令失败 (exit ${result.exitCode}): ${cmd.join(" ")}\n${result.stderr}`)
	}
	return result
}

function ghJson<T>(args: readonly string[]): T {
	const result = sh(["gh", ...args])
	return JSON.parse(result.stdout) as T
}

// ---------------------------------------------------------------- preflight

function preflight(options: HarnessOptions): void {
	log("preflight: gh / runner CLI / fixture repo / fixture source checkout")
	sh(["gh", "auth", "status"])
	for (const binary of ["codex", "claude"]) {
		sh(["which", binary])
	}
	const repo = ghJson<{ nameWithOwner: string; visibility: string }>([
		"repo", "view", options.fixtureRepo, "--json", "nameWithOwner,visibility",
	])
	if (repo.nameWithOwner.toLowerCase() !== options.fixtureRepo.toLowerCase()) {
		fail(`fixture repo 解析到 ${repo.nameWithOwner}，预期 ${options.fixtureRepo}`)
	}
	if (!existsSync(resolve(options.fixtureCwd, ".git"))) {
		fail(`fixture checkout 不存在或不是 git repo: ${options.fixtureCwd}（先 git clone ${options.fixtureRepo}）`)
	}
	const origin = sh(["git", "remote", "get-url", "origin"], { cwd: options.fixtureCwd }).stdout.trim()
	if (!origin.includes(options.fixtureRepo)) {
		fail(`fixture checkout origin (${origin}) 与 --fixture-repo (${options.fixtureRepo}) 不一致`)
	}
}

// --------------------------------------------------------- per-run fixture

const FIXTURE_MUTATION_LOCK = resolve(REPO_ROOT, ".coder-loop/runtime/real-e2e-fixture-mutation.lock")

async function withFixtureMutationLock<T>(operation: () => T): Promise<T> {
	for (;;) {
		const lock = sh(["shlock", "-f", FIXTURE_MUTATION_LOCK, "-p", String(process.pid)], { allowFail: true })
		if (lock.exitCode === 0) break
		await Bun.sleep(100)
	}
	try {
		return operation()
	} finally {
		rmSync(FIXTURE_MUTATION_LOCK)
	}
}

async function prepareFixture(options: HarnessOptions, workDir: string, runKey: string): Promise<FixtureRun> {
	const cwd = resolve(workDir, "fixture")
	const baseBranch = "main"
	const fixturePath = `runs/${runKey}.txt`
	const origin = sh(["git", "remote", "get-url", "origin"], { cwd: options.fixtureCwd }).stdout.trim()
	log(`fixture: 在 default branch 创建本 run 独占文件 ${fixturePath}`)
	await withFixtureMutationLock(() => sh([
		"gh", "api", "--method", "PUT", `repos/${options.fixtureRepo}/contents/${fixturePath}`,
		"-f", `message=chore(e2e): initialize ${runKey}`,
		"-f", `content=${Buffer.from(FIXTURE_INITIAL_CONTENT).toString("base64")}`,
		"-f", `branch=${baseBranch}`,
	]))
	log(`fixture: clone 独立 checkout ${cwd}`)
	sh(["git", "clone", "--branch", "main", "--single-branch", origin, cwd])

	sh(["gh", "label", "create", SEED_LABEL, "-R", options.fixtureRepo,
		"--description", "real-e2e harness 生成的 seed issue", "--color", "ededed"], { allowFail: true })
	return { cwd, repository: options.fixtureRepo, baseBranch, runKey, fixturePath }
}

// -------------------------------------------------------------------- seed

function seedIssueBody(fixture: FixtureRun): string {
	return `## 目标

把本轮独占文件 \`${fixture.fixturePath}\` 的内容从 \`status: pending\` 改为 \`status: complete\`。

## 上下文

- **Repo**: \`${fixture.repository}\`
- **Base branch**: \`${fixture.baseBranch}\`
- **Run-owned fixture**: \`${fixture.fixturePath}\`
- **Design source**: coder-loop 真实 e2e harness（mouriya-s-lab/coder-loop#464）自动生成的 seed 任务。

## 问题

\`${fixture.fixturePath}\` 是本 run 在 default branch 上预建的独占 fixture，当前内容是 \`status: pending\`。其他并发 run 使用不同路径。

## 预期结果

\`${fixture.fixturePath}\` 内容为 \`status: complete\`；不改 \`message.txt\` 或其他 run 的 \`runs/*.txt\`。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | 本轮 fixture 内容为 complete | \`cat ${fixture.fixturePath}\` | local | 输出 \`status: complete\` |
| 2 | scope | 只修改本轮 fixture | \`git diff --name-only ${fixture.baseBranch}...HEAD\` | local | 只输出 \`${fixture.fixturePath}\` |

## 依赖关系

- 不 depend on 其它 issue。
- 不 block 其它 issue。
`
}

function createSeedIssue(fixture: FixtureRun): number {
	log("seed: 创建 seed issue")
	const result = sh(["gh", "issue", "create", "-R", fixture.repository,
		"--title", `把本轮 fixture 标记为 complete (${fixture.runKey})`,
		"--label", "kind:code", "--label", SEED_LABEL,
		"--body", seedIssueBody(fixture)])
	const url = result.stdout.trim()
	const match = url.match(/\/issues\/(\d+)\s*$/)
	if (match === null) fail(`无法从 gh issue create 输出解析 issue 号: ${url}`)
	const issueNumber = Number.parseInt(match[1]!, 10)
	log(`seed: issue 已建 ${url}`)
	return issueNumber
}

// ------------------------------------------------------------------ daemon

type DaemonHandle = {
	child: ChildProcess
	loopDataRoot: string
	stdoutPath: string
	stderrPath: string
	shimDir: string
}

// real-e2e must exercise the CODE tree end-to-end. PATH's `coder-loop` wrapper
// on the host machine forwards to `/Users/mouriya/Ext/app/coder-loop` — the
// production install — so when a running agent runs `coder-loop item exits ...`
// it silently talks to app-side CLI code instead of the code-side CLI under
// test. The shim below is written into a per-run temp dir and prepended to
// PATH before the daemon spawn; the daemon inherits PATH, and its
// `spawn(..., { env: { ...process.env, ... }})` at scheduler.ts passes it
// through to every agent — so every `coder-loop ...` invocation in the loop
// resolves to `bun <REPO_ROOT>/src/loop.ts`.
function writeCoderLoopCliShim(workDir: string): string {
	const shimDir = resolve(workDir, "cli-shim")
	mkdirSync(shimDir, { recursive: true })
	const shimPath = resolve(shimDir, "coder-loop")
	const script = `#!/bin/sh\nexec bun ${LOOP_ENTRY} "$@"\n`
	writeFileSync(shimPath, script)
	chmodSync(shimPath, 0o755)
	return shimDir
}

function startDaemon(workDir: string): DaemonHandle {
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const stdoutPath = resolve(workDir, "daemon.stdout.log")
	const stderrPath = resolve(workDir, "daemon.stderr.log")
	const shimDir = writeCoderLoopCliShim(workDir)
	const shimmedPath = `${shimDir}:${process.env.PATH ?? ""}`
	log(`daemon: 隔离 loop-data-root 起中央 daemon: ${loopDataRoot}`)
	log(`daemon: PATH 前置 coder-loop CLI shim: ${shimDir} → ${LOOP_ENTRY}`)
	const stdoutFd = openSync(stdoutPath, "a")
	const stderrFd = openSync(stderrPath, "a")
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], {
		cwd: REPO_ROOT,
		stdio: ["ignore", stdoutFd, stderrFd],
		env: { ...operatorSubprocessEnvironment(process.env), PATH: shimmedPath },
	})
	closeSync(stdoutFd)
	closeSync(stderrFd)
	return { child, loopDataRoot, stdoutPath, stderrPath, shimDir }
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
		await Bun.sleep(250)
	}
	fail(`daemon socket ${timeoutSeconds}s 内未就绪，stderr 见 ${daemon.stderrPath}`)
}

async function stopDaemon(daemon: DaemonHandle): Promise<void> {
	log("daemon: down")
	const down = sh(["bun", LOOP_ENTRY, "daemon", "down", "--loop-data-root", daemon.loopDataRoot], { allowFail: true })
	if (down.exitCode !== 0) {
		log(`daemon: down 命令 exit ${down.exitCode}: ${down.stderr.trim() || down.stdout.trim()}`)
	}
	const deadline = Date.now() + 20_000
	while (Date.now() < deadline && daemon.child.exitCode === null) {
		await Bun.sleep(250)
	}
	if (daemon.child.exitCode === null) {
		log("daemon: down 超时，SIGTERM 收尾")
		daemon.child.kill("SIGTERM")
		await Bun.sleep(2000)
		if (daemon.child.exitCode === null) daemon.child.kill("SIGKILL")
	}
	killOrphanAgents(daemon.loopDataRoot)
	// 清 CLI shim。work-dir 会被外层 teardown 一起清，这里显式 rm 让 shim
	// 目录在 daemon 生命周期结束的同一瞬间就消失，即便外层 teardown 被中断
	// 也不会残留一个 exec 到当前 checkout 的 fake binary。
	try {
		rmSync(daemon.shimDir, { recursive: true, force: true })
	} catch {
		// ignore — teardown 的 workDir rm 会兜底
	}
}

// daemon down 在有 active run 时等待而非终止 agent（#467）；teardown 不能留孤儿
// codex/claude 在 daemon 死后继续推进 GitHub 状态。agent 的命令行携带本次
// loop-data root（--cd/--add-dir/--loop-data-root），按此匹配强杀；agent 是
// process-group leader，先连组杀再单杀。kill 失败 = 进程已不在，忽略。
function killOrphanAgents(loopDataRoot: string): void {
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
	state?: { kind?: string }
	queue?: {
		total?: number
		byStatus?: Record<string, number>
		selected?: { attempts?: number | null } | null
	}
	current?: { run?: unknown }
}

function readStatus(fixture: FixtureRun, loopDataRoot: string, chainName: string): StatusSnapshot {
	const result = sh(["bun", LOOP_ENTRY, "status", fixture.cwd,
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

async function watch(
	options: HarnessOptions,
	fixture: FixtureRun,
	loopDataRoot: string,
	chainName: string,
): Promise<WatchVerdict> {
	const startedAt = Date.now()
	let lastSummary = ""
	for (;;) {
		const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
		if (elapsedSeconds > options.maxWallSeconds) {
			return { kind: "tripwire", reason: `wall-time ${elapsedSeconds}s 超过上界 ${options.maxWallSeconds}s` }
		}
		const runs = countRuns(loopDataRoot)
		if (runs > options.maxRuns) {
			return { kind: "tripwire", reason: `runs 数 ${runs} 超过上界 ${options.maxRuns}（#309 式 spin 信号）` }
		}
		const snapshot = readStatus(fixture, loopDataRoot, chainName)
		const byStatus = snapshot.queue?.byStatus ?? {}
		const attempts = snapshot.queue?.selected?.attempts ?? null
		if (attempts !== null && attempts > options.maxAttempts) {
			return { kind: "tripwire", reason: `attempts ${attempts} 超过上界 ${options.maxAttempts}` }
		}
		const summary = `byStatus=${JSON.stringify(byStatus)} attempts=${attempts ?? "-"} runs=${runs}`
		if (summary !== lastSummary) {
			log(`watch: ${summary} elapsed=${elapsedSeconds}s`)
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

type EvidenceSummary = {
	issueNumber: number
	issueUrl: string
	prNumber: number
	prUrl: string
	mergeCommit: string
	durationSeconds: number
}

type ScenarioResult =
	| { kind: "success"; issueNumber: number }
	| { kind: "failure"; issueNumber?: number }

function assertGitHubOutcome(fixture: FixtureRun, issueNumber: number, durationSeconds: number): EvidenceSummary {
	log("assert: GitHub 终态")
	const issue = ghJson<{
		state: string
		url: string
		closedByPullRequestsReferences: Array<{ number: number; url: string }>
	}>(["issue", "view", String(issueNumber), "-R", fixture.repository,
		"--json", "state,url,closedByPullRequestsReferences"])
	if (issue.state !== "CLOSED") fail(`seed issue #${issueNumber} 未关闭 (state=${issue.state})`)
	const closingPr = issue.closedByPullRequestsReferences[0]
	if (closingPr === undefined) fail(`seed issue #${issueNumber} 已关闭但没有 closing PR reference`)
	const pr = ghJson<{ state: string; url: string; mergeCommit: { oid: string } | null }>([
		"pr", "view", String(closingPr.number), "-R", fixture.repository,
		"--json", "state,url,mergeCommit"])
	if (pr.state !== "MERGED") fail(`PR #${closingPr.number} 未 merge (state=${pr.state})`)

	log(`assert: fixture ${fixture.fixturePath} 实际内容 + 真实 check`)
	sh(["git", "fetch", "origin", fixture.baseBranch], { cwd: fixture.cwd })
	sh(["git", "reset", "--hard", `origin/${fixture.baseBranch}`], { cwd: fixture.cwd })
	const message = readFileSync(resolve(fixture.cwd, fixture.fixturePath), "utf-8").trim()
	if (message !== "status: complete") fail(`merge后 ${fixture.fixturePath} 为 ${JSON.stringify(message)}，预期 status: complete`)
	const check = sh(["bun", "-e", `const value = await Bun.file(${JSON.stringify(fixture.fixturePath)}).text(); if (value.trim() !== "status: complete") process.exit(1)`], { cwd: fixture.cwd, allowFail: true })
	if (check.exitCode !== 0) fail(`merge 后 bun run check 失败:\n${check.stderr}`)

	return {
		issueNumber,
		issueUrl: issue.url,
		prNumber: closingPr.number,
		prUrl: pr.url,
		mergeCommit: pr.mergeCommit?.oid ?? "",
		durationSeconds,
	}
}

// ----------------------------------------------------------------- diagnose

function dumpDiagnosis(fixture: FixtureRun, daemon: DaemonHandle, chainName: string, reason: string): void {
	process.stderr.write(`\nreal-e2e: 失败/止血: ${reason}\n`)
	process.stderr.write(`诊断材料:\n`)
	process.stderr.write(`  loop-data root: ${daemon.loopDataRoot}\n`)
	process.stderr.write(`  daemon stdout : ${daemon.stdoutPath}\n`)
	process.stderr.write(`  daemon stderr : ${daemon.stderrPath}\n`)
	const snapshot = sh(["bun", LOOP_ENTRY, "status", fixture.cwd,
		"--json", "--loop-data-root", daemon.loopDataRoot, "--chain", chainName], { allowFail: true })
	process.stderr.write(`  status --json :\n${snapshot.stdout}\n`)
}

// -------------------------------------------------------------------- main

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2))
	const startedAt = Date.now()
	const runKey = randomUUID()
	preflight(options)
	const mutexDomain = `${options.fixtureRepo.toLowerCase()}@main`
	const mutex = await acquireRealE2eGlobalMutex({
		domain: mutexDomain,
		onWait: (ownerPid) => log(`mutex: 等待资源域 ${mutexDomain}，当前 owner pid=${ownerPid ?? "unknown"}`),
	})
	log(`mutex: 已获得资源域 ${mutex.domain}，owner pid=${mutex.ownerPid}，lock=${mutex.lockPath}`)
	try {
		const workDir = resolve(REPO_ROOT, ".coder-loop/runtime/real-e2e", runKey)
		mkdirSync(workDir, { recursive: true })
		const fixture = await prepareFixture(options, workDir, runKey)
		const chainName = `${options.fixtureRepo.split("/")[1]!}-${runKey}`
		const daemon = startDaemon(workDir)
		let exitCode = 1
		let issueNumber: number | undefined
		try {
			const result = await runScenario(options, fixture, daemon, chainName, startedAt)
			issueNumber = result.issueNumber
			exitCode = result.kind === "success" ? 0 : 1
		} finally {
			await stopDaemon(daemon)
			if (exitCode !== 0 && issueNumber !== undefined) cleanupOwnedGitHubResources(fixture, issueNumber)
			await deleteRunFixture(fixture)
		}
		return exitCode
	} finally {
		mutex.release()
		log(`mutex: 已释放资源域 ${mutex.domain}，owner pid=${mutex.ownerPid}`)
	}
}

async function runScenario(
	options: HarnessOptions,
	fixture: FixtureRun,
	daemon: DaemonHandle,
	chainName: string,
	startedAt: number,
): Promise<ScenarioResult> {
	await waitForDaemonSocket(daemon, 15)

	// #436: install/uninstall subcommands retired. The five-layer bootstrap reduced to a single
	// `chain create` on the central daemon socket. Target directory needs no bootstrap files —
	// CLAUDE.md / AGENTS.md ride in the fixture repo itself, preset's planning agent ensures
	// GitHub label assets on first issue creation.
	log(`chain create: ${chainName} → ${fixture.repository}@${fixture.baseBranch} (preset=${options.preset})`)
	const chainCreate = sh(["bun", LOOP_ENTRY, "chain", "create", chainName,
		"--config-json", JSON.stringify({ repository: fixture.repository, baseBranch: fixture.baseBranch }),
		"--preset", options.preset,
		"--force",
		"--loop-data-root", daemon.loopDataRoot], { allowFail: true })
	if (chainCreate.exitCode !== 0) {
		dumpDiagnosis(fixture, daemon, chainName, `chain create 失败:\n${chainCreate.stdout}\n${chainCreate.stderr}`)
		return { kind: "failure" }
	}

	const issueNumber = createSeedIssue(fixture)

	log(`item: 入队 issue #${issueNumber} → chain ${chainName} (preset=${options.preset})`)
	// #412: preset is required per-item; pass the same bundled preset the harness installed with so the
	// engine renders against the same preset for spawn / iteration / review.
	sh(["bun", LOOP_ENTRY, "item", "add", chainName,
		"--issue", String(issueNumber),
		"--repo-cwd", fixture.cwd,
		"--preset", options.preset,
		"--loop-data-root", daemon.loopDataRoot])

	const verdict = await watch(options, fixture, daemon.loopDataRoot, chainName)
	if (verdict.kind !== "success") {
		const reason = verdict.kind === "tripwire"
			? `tripwire: ${verdict.reason}`
			: `item 落入失败终态 ${verdict.status}`
		dumpDiagnosis(fixture, daemon, chainName, reason)
		return { kind: "failure", issueNumber }
	}

	const durationSeconds = Math.floor((Date.now() - startedAt) / 1000)
	const evidence = assertGitHubOutcome(fixture, issueNumber, durationSeconds)
	log("")
	log("===== real-e2e evidence =====")
	log(`seed issue : ${evidence.issueUrl} (CLOSED)`)
	log(`PR         : ${evidence.prUrl} (MERGED, ${evidence.mergeCommit})`)
	log(`duration   : ${evidence.durationSeconds}s`)
	log(`loop-data  : ${daemon.loopDataRoot}`)
	log(`fixture    : ${fixture.fixturePath} (deleted after teardown)`)
	log("=============================")
	return { kind: "success", issueNumber }
}

function cleanupOwnedGitHubResources(fixture: FixtureRun, issueNumber: number): void {
	log(`teardown: 只清理本 run 的 GitHub 资源 (issue #${issueNumber})`)
	const prs = ghJson<Array<{ number: number; body: string }>>([
		"pr", "list", "-R", fixture.repository, "--state", "open", "--json", "number,body",
	])
	for (const pr of prs) {
		if (pr.body.split("\n", 1)[0] !== `Closes #${issueNumber}`) continue
		sh(["gh", "pr", "close", String(pr.number), "-R", fixture.repository, "--delete-branch",
			"--comment", `real-e2e ${fixture.runKey}: 本 run 失败，清理自己的 PR`], { allowFail: true })
	}
	sh(["gh", "issue", "close", String(issueNumber), "-R", fixture.repository,
		"--reason", "not planned", "--comment", `real-e2e ${fixture.runKey}: 本 run 失败，清理自己的 seed`], { allowFail: true })
}

async function deleteRunFixture(fixture: FixtureRun): Promise<void> {
	log(`teardown: 删除本 run 独占 fixture ${fixture.fixturePath}`)
	await withFixtureMutationLock(() => {
		const sha = sh(["gh", "api", "--method", "GET", `repos/${fixture.repository}/contents/${fixture.fixturePath}`,
			"-f", `ref=${fixture.baseBranch}`, "--jq", ".sha"], { allowFail: true }).stdout.trim()
		if (sha === "") return
		sh(["gh", "api", "--method", "DELETE", `repos/${fixture.repository}/contents/${fixture.fixturePath}`,
			"-f", `message=chore(e2e): cleanup ${fixture.runKey}`,
			"-f", `sha=${sha}`, "-f", `branch=${fixture.baseBranch}`], { allowFail: true })
	})
}

try {
	process.exit(await main())
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`real-e2e: ${message}\n`)
	process.exit(1)
}
