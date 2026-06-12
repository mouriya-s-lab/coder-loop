#!/usr/bin/env bun
/**
 * 真实 e2e harness（issue #464）。
 *
 * 单命令驱动一轮完整真实 loop：
 *   reset fixture → 脚本建 seed issue → 隔离 loop-data 起中央 daemon →
 *   install + item add → 真实 runner 跑 iter→review→PR→merge→issue close →
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
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const SEED_LABEL = "e2e-seed"
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
	}
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i]
		const value = argv[i + 1]
		if (flag === undefined) break
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
	process.stderr.write(`real-e2e: ${message}\n`)
	process.exit(1)
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
	log("preflight: gh / runner CLI / fixture repo / fixture checkout")
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

// ------------------------------------------------------------------- reset

function resetFixture(options: HarnessOptions): void {
	log("reset: fixture checkout 回 origin/main")
	sh(["git", "fetch", "origin", "main"], { cwd: options.fixtureCwd })
	sh(["git", "switch", "main"], { cwd: options.fixtureCwd })
	sh(["git", "reset", "--hard", "origin/main"], { cwd: options.fixtureCwd })
	sh(["git", "clean", "-fd"], { cwd: options.fixtureCwd })

	// 被杀的 daemon（tripwire / SIGKILL）会在 fixture 的 git 里留下已注册的
	// scheduler worktree；同名注册存在时新 run 的 worktree 创建被 git 拒绝，
	// scheduler 每 tick 失败且 status API 不可见——item 永远 queued。
	log("reset: 清理残留 scheduler worktree 注册")
	const worktrees = sh(["git", "worktree", "list", "--porcelain"], { cwd: options.fixtureCwd }).stdout
	for (const line of worktrees.split("\n")) {
		if (!line.startsWith("worktree ")) continue
		const path = line.slice("worktree ".length).trim()
		if (resolve(path) === resolve(options.fixtureCwd)) continue
		log(`reset: git worktree remove --force ${path}`)
		sh(["git", "worktree", "remove", "--force", path], { cwd: options.fixtureCwd, allowFail: true })
	}
	sh(["git", "worktree", "prune"], { cwd: options.fixtureCwd })

	log("reset: 关残留 open PR（fixture repo 专用于 e2e，open PR 一律视为上轮残留）")
	const openPrs = ghJson<Array<{ number: number }>>([
		"pr", "list", "-R", options.fixtureRepo, "--state", "open", "--json", "number",
	])
	for (const pr of openPrs) {
		sh(["gh", "pr", "close", String(pr.number), "-R", options.fixtureRepo, "--delete-branch",
			"--comment", "e2e harness reset: 上轮残留，自动关闭"], { allowFail: true })
	}

	log(`reset: 关残留 ${SEED_LABEL} open issue`)
	sh(["gh", "label", "create", SEED_LABEL, "-R", options.fixtureRepo,
		"--description", "real-e2e harness 生成的 seed issue", "--color", "ededed"], { allowFail: true })
	const openSeeds = ghJson<Array<{ number: number }>>([
		"issue", "list", "-R", options.fixtureRepo, "--state", "open", "--label", SEED_LABEL, "--json", "number",
	])
	for (const issue of openSeeds) {
		sh(["gh", "issue", "close", String(issue.number), "-R", options.fixtureRepo,
			"--reason", "not planned", "--comment", "e2e harness reset: 上轮残留 seed，自动关闭"], { allowFail: true })
	}

	const messagePath = resolve(options.fixtureCwd, "message.txt")
	const current = readFileSync(messagePath, "utf-8").trim()
	if (current !== "status: pending") {
		log(`reset: message.txt 当前为 ${JSON.stringify(current)}，翻回 pending 并 push main`)
		writeFileSync(messagePath, "status: pending\n")
		sh(["git", "add", "message.txt"], { cwd: options.fixtureCwd })
		sh(["git", "commit", "-m", "chore(e2e): reset message.txt to pending"], { cwd: options.fixtureCwd })
		sh(["git", "push", "origin", "main"], { cwd: options.fixtureCwd })
	} else {
		log("reset: message.txt 已是 pending，无需翻转")
	}
}

// -------------------------------------------------------------------- seed

function seedIssueBody(): string {
	return `## 目标

把 \`message.txt\` 的内容从 \`status: pending\` 改为 \`status: complete\`，使 \`bun run check\` 通过。

## 上下文

- **Repo**: \`mouriya-s-lab/coder-loop-e2e-fixture\`
- **Design source**: coder-loop 真实 e2e harness（mouriya-s-lab/coder-loop#464）自动生成的 seed 任务。

## 问题

\`message.txt\` 当前内容是 \`status: pending\`，\`bun run check\`（\`scripts/check-message.mjs\`）因此失败。

## 预期结果

\`message.txt\` 内容为 \`status: complete\`，\`bun run check\` 通过。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | message.txt 内容为 complete | \`cat message.txt\` | local | 输出 \`status: complete\` |
| 2 | function | fixture check 通过 | \`bun run check\` | local | exit 0，输出 \`message fixture check passed\` |

## 依赖关系

- 不 depend on 其它 issue。
- 不 block 其它 issue。
`
}

function createSeedIssue(options: HarnessOptions): number {
	log("seed: 创建 seed issue")
	const result = sh(["gh", "issue", "create", "-R", options.fixtureRepo,
		"--title", "把 message.txt 标记为 complete",
		"--label", "kind:code", "--label", SEED_LABEL,
		"--body", seedIssueBody()])
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
}

function startDaemon(workDir: string): DaemonHandle {
	const loopDataRoot = resolve(workDir, "loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const stdoutPath = resolve(workDir, "daemon.stdout.log")
	const stderrPath = resolve(workDir, "daemon.stderr.log")
	log(`daemon: 隔离 loop-data-root 起中央 daemon: ${loopDataRoot}`)
	const stdoutFd = openSync(stdoutPath, "a")
	const stderrFd = openSync(stderrPath, "a")
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], {
		cwd: REPO_ROOT,
		stdio: ["ignore", stdoutFd, stderrFd],
	})
	closeSync(stdoutFd)
	closeSync(stderrFd)
	return { child, loopDataRoot, stdoutPath, stderrPath }
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

function readStatus(options: HarnessOptions, loopDataRoot: string, chainName: string): StatusSnapshot {
	const result = sh(["bun", LOOP_ENTRY, "status", options.fixtureCwd,
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
		const snapshot = readStatus(options, loopDataRoot, chainName)
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

function assertGitHubOutcome(options: HarnessOptions, issueNumber: number, durationSeconds: number): EvidenceSummary {
	log("assert: GitHub 终态")
	const issue = ghJson<{
		state: string
		url: string
		closedByPullRequestsReferences: Array<{ number: number; url: string }>
	}>(["issue", "view", String(issueNumber), "-R", options.fixtureRepo,
		"--json", "state,url,closedByPullRequestsReferences"])
	if (issue.state !== "CLOSED") fail(`seed issue #${issueNumber} 未关闭 (state=${issue.state})`)
	const closingPr = issue.closedByPullRequestsReferences[0]
	if (closingPr === undefined) fail(`seed issue #${issueNumber} 已关闭但没有 closing PR reference`)
	const pr = ghJson<{ state: string; url: string; mergeCommit: { oid: string } | null }>([
		"pr", "view", String(closingPr.number), "-R", options.fixtureRepo,
		"--json", "state,url,mergeCommit"])
	if (pr.state !== "MERGED") fail(`PR #${closingPr.number} 未 merge (state=${pr.state})`)

	log("assert: fixture main 实际内容 + 真实 check")
	sh(["git", "fetch", "origin", "main"], { cwd: options.fixtureCwd })
	sh(["git", "reset", "--hard", "origin/main"], { cwd: options.fixtureCwd })
	const message = readFileSync(resolve(options.fixtureCwd, "message.txt"), "utf-8").trim()
	if (message !== "status: complete") fail(`merge 后 message.txt 为 ${JSON.stringify(message)}，预期 status: complete`)
	const check = sh(["bun", "run", "check"], { cwd: options.fixtureCwd, allowFail: true })
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

function dumpDiagnosis(options: HarnessOptions, daemon: DaemonHandle, chainName: string, reason: string): void {
	process.stderr.write(`\nreal-e2e: 失败/止血: ${reason}\n`)
	process.stderr.write(`诊断材料:\n`)
	process.stderr.write(`  loop-data root: ${daemon.loopDataRoot}\n`)
	process.stderr.write(`  daemon stdout : ${daemon.stdoutPath}\n`)
	process.stderr.write(`  daemon stderr : ${daemon.stderrPath}\n`)
	const snapshot = sh(["bun", LOOP_ENTRY, "status", options.fixtureCwd,
		"--json", "--loop-data-root", daemon.loopDataRoot, "--chain", chainName], { allowFail: true })
	process.stderr.write(`  status --json :\n${snapshot.stdout}\n`)
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2))
	const startedAt = Date.now()
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	const workDir = resolve(REPO_ROOT, ".coder-loop/runtime/real-e2e", stamp)
	mkdirSync(workDir, { recursive: true })
	const chainName = options.fixtureRepo.split("/")[1]!

	preflight(options)
	resetFixture(options)

	const daemon = startDaemon(workDir)
	let exitCode = 1
	try {
		exitCode = await runScenario(options, daemon, chainName, startedAt)
	} finally {
		await stopDaemon(daemon)
	}
	process.exit(exitCode)
}

async function runScenario(
	options: HarnessOptions,
	daemon: DaemonHandle,
	chainName: string,
	startedAt: number,
): Promise<number> {
	await waitForDaemonSocket(daemon, 15)

	log("install: bootstrap fixture target + central chain")
	const install = sh(["bun", LOOP_ENTRY, "install", options.fixtureCwd,
		"--repo", options.fixtureRepo, "--preset", options.preset,
		"--loop-data-root", daemon.loopDataRoot], { allowFail: true })
	if (install.exitCode !== 0) {
		dumpDiagnosis(options, daemon, chainName, `install 失败:\n${install.stdout}\n${install.stderr}`)
		return 1
	}

	const issueNumber = createSeedIssue(options)

	log(`item: 入队 issue #${issueNumber} → chain ${chainName}`)
	sh(["bun", LOOP_ENTRY, "item", "add", chainName,
		"--issue", String(issueNumber),
		"--repo-cwd", options.fixtureCwd,
		"--loop-data-root", daemon.loopDataRoot])

	const verdict = await watch(options, daemon.loopDataRoot, chainName)
	if (verdict.kind !== "success") {
		const reason = verdict.kind === "tripwire"
			? `tripwire: ${verdict.reason}`
			: `item 落入失败终态 ${verdict.status}`
		dumpDiagnosis(options, daemon, chainName, reason)
		return 1
	}

	const durationSeconds = Math.floor((Date.now() - startedAt) / 1000)
	const evidence = assertGitHubOutcome(options, issueNumber, durationSeconds)
	log("")
	log("===== real-e2e evidence =====")
	log(`seed issue : ${evidence.issueUrl} (CLOSED)`)
	log(`PR         : ${evidence.prUrl} (MERGED, ${evidence.mergeCommit})`)
	log(`duration   : ${evidence.durationSeconds}s`)
	log(`loop-data  : ${daemon.loopDataRoot}`)
	log("=============================")
	return 0
}

await main()
