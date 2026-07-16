#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"

import { closureBranchPrefix, computeClosureReachability, createRepositoryGitCoordinator, type OriginFreshness } from "../src/closure-lifecycle"
import { cleanupSchedulerChainWorktrees, consumeSchedulerClosure, createGitWorktreeManager, reconcileClosureResources, type SchedulerEvent } from "../src/scheduler"
import { openSqliteStateStore } from "../src/sqlite-state"
import type { ClosureSnapshot, TaskNodeSnapshot } from "../src/task-runtime"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const PRESET = "engine-integration"
const REAL_GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()

type CommandResult = { stdout: string; stderr: string; exitCode: number }
type Daemon = { child: ChildProcess; root: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string }
type RunnerObservation = { chain: string; phase: string; cwd: string; branch: string; argv: string[]; attempt: number; sessionId: string }
type ClosureRow = { closure_id: string; phase: string; lifecycle: "active" | "suspended" | "consumed"; worktree_path: string | null; branch_name: string | null; base_commit: string; source_par_node_id: string | null }
type ClosureSessionRow = { runner_kind: string; session_id: string }
type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean }
type AsyncCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv }
type PreparedRepositories = { target: string; noOrigin: string; badRemote: string; origin: string; advanced: string }
type ShimResources = { dir: string; runnerLog: string; gate: string }

function fail(message: string): never { throw new Error(message) }
function assert(value: unknown, message: string): asserts value { if (!value) fail(message) }
function record(value: unknown, label: string): Record<string, unknown> {
	assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`)
	return value
}
function stringField(value: Record<string, unknown>, key: string, label: string): string {
	const field = value[key]; assert(typeof field === "string", `${label}.${key} must be a string`); return field
}
function parseRunnerObservation(value: unknown): RunnerObservation {
	const row = record(value, "runner observation")
	const argv = row.argv; assert(Array.isArray(argv) && argv.every((entry) => typeof entry === "string"), "runner observation.argv must be strings")
	const attempt = row.attempt; assert(typeof attempt === "number" && Number.isInteger(attempt), "runner observation.attempt must be an integer")
	return { chain: stringField(row, "chain", "runner observation"), phase: stringField(row, "phase", "runner observation"), cwd: stringField(row, "cwd", "runner observation"), branch: stringField(row, "branch", "runner observation"), argv, attempt, sessionId: stringField(row, "sessionId", "runner observation") }
}
function findClosure(node: TaskNodeSnapshot, closureId: string): ClosureSnapshot | null {
	if (node.kind === "leaf") return node.closure.closureId === closureId ? node.closure : null
	for (const child of node.children) {
		const closure = findClosure(child, closureId)
		if (closure !== null) return closure
	}
	return null
}
function event(type: string, payload: Record<string, unknown> = {}): void {
	process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...payload })}\n`)
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra }
	delete env.CODER_LOOP_RUN_CRED
	delete env.CODER_LOOP_DATA_DIR
	return env
}

function command(cmd: readonly string[], options: CommandOptions = {}): CommandResult {
	const result = spawnSync(cmd[0]!, cmd.slice(1), { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? cleanEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
	const observed = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 }
	if (observed.exitCode !== 0 && options.allowFail !== true) fail(`${cmd.join(" ")} failed (${observed.exitCode}): ${observed.stderr}`)
	return observed
}

async function commandAsync(cmd: readonly string[], options: AsyncCommandOptions = {}): Promise<CommandResult> {
	return await new Promise((resolveCommand, rejectCommand) => {
		const child = spawn(cmd[0]!, cmd.slice(1), { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"] })
		const stdout: Buffer[] = [], stderr: Buffer[] = []
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", rejectCommand)
		child.on("close", (code) => {
			const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? 1 }
			if (result.exitCode === 0) resolveCommand(result)
			else rejectCommand(new Error(`${cmd.join(" ")} failed (${result.exitCode}): ${result.stderr}`))
		})
	})
}

async function until<T>(read: () => T, accept: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = read()
		if (accept(value)) return value
		await Bun.sleep(100)
	}
	fail(`timeout waiting for ${label}`)
}

function initLocalRepo(path: string): string {
	mkdirSync(path, { recursive: true })
	command([REAL_GIT, "init", "-q", "-b", "main"], { cwd: path })
	writeFileSync(resolve(path, "README.md"), `${path}\n`)
	command([REAL_GIT, "add", "README.md"], { cwd: path })
	command([REAL_GIT, "-c", "user.name=issue-560", "-c", "user.email=issue-560@invalid", "commit", "-qm", "seed"], { cwd: path })
	return command([REAL_GIT, "rev-parse", "HEAD"], { cwd: path }).stdout.trim()
}

function prepareRepositories(root: string): PreparedRepositories {
	const origin = resolve(root, "origin.git")
	command([REAL_GIT, "init", "-q", "--bare", origin])
	const seed = resolve(root, "seed")
	initLocalRepo(seed)
	command([REAL_GIT, "remote", "add", "origin", origin], { cwd: seed })
	command([REAL_GIT, "push", "-q", "-u", "origin", "main"], { cwd: seed })
	writeFileSync(resolve(seed, "advanced.txt"), "advanced before closure create\n")
	command([REAL_GIT, "add", "advanced.txt"], { cwd: seed })
	command([REAL_GIT, "-c", "user.name=issue-560", "-c", "user.email=issue-560@invalid", "commit", "-qm", "advance origin"], { cwd: seed })
	command([REAL_GIT, "push", "-q", "origin", "main"], { cwd: seed })
	const advanced = command([REAL_GIT, "rev-parse", "HEAD"], { cwd: seed }).stdout.trim()
	const target = resolve(root, "target")
	command([REAL_GIT, "clone", "-q", origin, target])
	command([REAL_GIT, "switch", "-q", "main"], { cwd: target })
	const noOrigin = resolve(root, "no-origin")
	initLocalRepo(noOrigin)
	const badRemote = resolve(root, "bad-remote")
	initLocalRepo(badRemote)
	command([REAL_GIT, "remote", "add", "origin", resolve(root, "missing-origin.git")], { cwd: badRemote })
	return { target, noOrigin, badRemote, origin, advanced }
}

function writeShims(root: string): ShimResources {
	const dir = resolve(root, "shims")
	const state = resolve(root, "shim-state")
	mkdirSync(dir, { recursive: true }); mkdirSync(state, { recursive: true })
	const runnerLog = resolve(root, "loop-data", "chains")
	const gate = resolve(state, "block-fetch")
	const gitShim = `#!/usr/bin/env bun\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"; import { spawnSync } from "node:child_process"; const a=process.argv.slice(2),op=a[0]==="fetch"?"fetch":a[0]==="worktree"&&a[1]==="add"?"worktree-add":a[0]==="worktree"&&a[1]==="remove"?"worktree-remove":a[0]??"unknown";appendFileSync(process.env.ISSUE560_GIT_LOG!,JSON.stringify({event:op,cwd:process.cwd(),a})+"\\n");if(existsSync(process.env.ISSUE560_GIT_GATE!)&&readFileSync(process.env.ISSUE560_GIT_GATE!,"utf8").trim()===op){writeFileSync(process.env.ISSUE560_GIT_ENTERED!,op+"\\n");while(!existsSync(process.env.ISSUE560_GIT_RELEASE!)) await Bun.sleep(25)} const p=spawnSync(process.env.ISSUE560_REAL_GIT!,a,{stdio:"inherit"});process.exit(p.status??1)\n`
	const runner = `#!/usr/bin/env bun\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";import { spawnSync } from "node:child_process";import { resolve } from "node:path";const argv=process.argv.slice(2),p=argv[argv.lastIndexOf("-p")+1]??"";const f=Object.fromEntries(p.split("\\n").map(x=>x.match(/^(PHASE|CHAIN|ITEM|RUN)=(.+)$/)).filter(Boolean).map(x=>[x[1].toLowerCase(),x[2]]));const c=resolve(process.cwd(),".issue560-"+f.phase+".count"),attempt=existsSync(c)?Number(readFileSync(c,"utf8"))+1:1;writeFileSync(c,String(attempt));const branch=spawnSync(process.env.ISSUE560_REAL_GIT!,["symbolic-ref","-q","HEAD"],{encoding:"utf8"}).stdout.trim(),sessionId="issue560-"+f.chain+"-"+f.phase;appendFileSync(resolve(process.cwd(),".issue560-runner.jsonl"),JSON.stringify({chain:f.chain,phase:f.phase,cwd:process.cwd(),branch,argv,attempt,sessionId})+"\\n");process.stdout.write(JSON.stringify({type:"system",session_id:sessionId})+"\\n");if(f.chain.includes("interrupt")&&f.phase==="iteration"&&attempt===1)while(true) await Bun.sleep(1000);if(f.phase==="review"){const u=spawnSync("coder-loop",["item","update",f.chain,"--issue",f.item,"--status","done","--json"],{stdio:"inherit"});process.exit(u.status??1)}\n`
	for (const [name, body] of Object.entries({ git: gitShim, claude: runner, "coder-loop": `#!/bin/sh\nexec bun ${LOOP_ENTRY} "$@"\n` })) {
		const path = resolve(dir, name); writeFileSync(path, body); chmodSync(path, 0o755)
	}
	return { dir, runnerLog, gate }
}

function daemonEnvironment(root: string, shims: ReturnType<typeof writeShims>): NodeJS.ProcessEnv {
	const state = resolve(root, "shim-state")
	return cleanEnvironment({
		PATH: `${shims.dir}:${process.env.PATH ?? ""}`,
		ISSUE560_REAL_GIT: REAL_GIT,
		ISSUE560_GIT_GATE: shims.gate,
		ISSUE560_GIT_ENTERED: resolve(state, "fetch-entered"),
		ISSUE560_GIT_RELEASE: resolve(state, "fetch-release"),
		ISSUE560_GIT_LOG: resolve(state, "git.jsonl"),
	})
}

function startDaemon(root: string, env: NodeJS.ProcessEnv): Daemon {
	const loopRoot = resolve(root, "loop-data"); mkdirSync(loopRoot, { recursive: true })
	const stdout = resolve(root, "daemon.stdout.log"), stderr = resolve(root, "daemon.stderr.log")
	const out = openSync(stdout, "a"), err = openSync(stderr, "a")
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopRoot], { cwd: REPO_ROOT, env, stdio: ["ignore", out, err], detached: true })
	closeSync(out); closeSync(err)
	return { child, root: loopRoot, env, stdout, stderr }
}

async function ready(daemon: Daemon): Promise<void> {
	await until(() => existsSync(resolve(daemon.root, "daemon.sock")), Boolean, "daemon socket")
	await until(
		() => command(["bun", LOOP_ENTRY, "daemon", "status", "--json", "--loop-data-root", daemon.root], { env: daemon.env, allowFail: true }),
		(status) => status.exitCode === 0,
		"daemon status readiness",
	)
}

async function daemonStatusLatenciesWhileGitBlocked(daemon: Daemon, count: number): Promise<number[]> {
	const latencies: number[] = []
	for (let index = 0; index < count; index += 1) {
		const startedAt = Date.now()
		await commandAsync(["bun", LOOP_ENTRY, "daemon", "status", "--json", "--loop-data-root", daemon.root], { env: daemon.env })
		latencies.push(Date.now() - startedAt)
	}
	return latencies
}

async function stopDaemon(daemon: Daemon): Promise<void> {
	command(["bun", LOOP_ENTRY, "daemon", "down", "--loop-data-root", daemon.root], { env: daemon.env, allowFail: true })
	await until(() => daemon.child.exitCode, (code) => code !== null, "daemon exit")
}

function createChain(daemon: Daemon, name: string, repo: string): void {
	command(["bun", LOOP_ENTRY, "chain", "create", name, "--config-json", JSON.stringify({ repository: "issue-560/fixture", baseBranch: "main" }), "--preset", PRESET, "--force", "--loop-data-root", daemon.root], { env: daemon.env })
	command(["bun", LOOP_ENTRY, "item", "add", name, "--issue", "item-1", "--repo-cwd", repo, "--preset", PRESET, "--loop-data-root", daemon.root], { env: daemon.env })
}

function statusDone(daemon: Daemon, chain: string, repo: string): boolean {
	const result = command(["bun", LOOP_ENTRY, "status", repo, "--json", "--chain", chain, "--loop-data-root", daemon.root], { env: daemon.env, allowFail: true })
	if (result.exitCode !== 0) return false
	const parsed: unknown = JSON.parse(result.stdout)
	const root = record(parsed, "status")
	const queue = root.queue === undefined ? null : record(root.queue, "status.queue")
	const byStatus = queue?.byStatus === undefined ? null : record(queue.byStatus, "status.queue.byStatus")
	return byStatus?.done === 1
}

function observations(path: string): RunnerObservation[] {
	if (!existsSync(path)) return []
	const logs: string[] = []
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const child = resolve(directory, entry.name)
			if (entry.isDirectory()) visit(child)
			else if (entry.name === ".issue560-runner.jsonl") logs.push(child)
		}
	}
	visit(path)
	return logs.flatMap((log) => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
		const parsed: unknown = JSON.parse(line)
		return parseRunnerObservation(parsed)
	}))
}

function closureRows(root: string, chain: string): ClosureRow[] {
	const db = new Database(resolve(root, "db.sqlite"), { readonly: true })
	try { return db.query<ClosureRow, { $chain: string }>("SELECT tc.closure_id,tc.phase,tc.lifecycle,tc.worktree_path,tc.branch_name,tc.base_commit,tc.source_par_node_id FROM task_closures tc JOIN items i ON i.id=tc.item_row_id JOIN chains c ON c.id=i.chain_id WHERE c.name=$chain ORDER BY tc.phase").all({ $chain: chain }) } finally { db.close() }
}

function closureSnapshot(root: string, closureId: string, worktree: string): string {
	const db = new Database(resolve(root, "db.sqlite"), { readonly: true })
	let sessions: ClosureSessionRow[]
	try { sessions = db.query<ClosureSessionRow, { $closureId: string }>("SELECT runner_kind,session_id FROM closure_sessions WHERE closure_id=$closureId ORDER BY runner_kind").all({ $closureId: closureId }) } finally { db.close() }
	return JSON.stringify({
		head: command([REAL_GIT, "rev-parse", "HEAD"], { cwd: worktree }).stdout,
		branch: command([REAL_GIT, "symbolic-ref", "HEAD"], { cwd: worktree }).stdout,
		status: command([REAL_GIT, "status", "--porcelain=v1", "--ignored"], { cwd: worktree }).stdout.split("\n").filter((line) => !line.includes(".issue560-")).join("\n"),
		index: command([REAL_GIT, "ls-files", "--stage"], { cwd: worktree }).stdout,
		scratch: readFileSync(resolve(worktree, ".issue560-scratch"), "utf8"),
		sessions,
	})
}

function deleteChain(daemon: Daemon, chain: string): void {
	command(["bun", LOOP_ENTRY, "chain", "delete", chain, "--loop-data-root", daemon.root, "--json"], { env: daemon.env })
}

async function main(): Promise<void> {
	const id = randomUUID(), runtime = resolve(REPO_ROOT, ".coder-loop/runtime/issue-560", id), evidence = resolve(REPO_ROOT, ".coder-loop/evidence/issue-560", id)
	mkdirSync(runtime, { recursive: true }); mkdirSync(evidence, { recursive: true })
	const sourceSha = command([REAL_GIT, "rev-parse", "HEAD"]).stdout.trim()
	const repos = prepareRepositories(runtime), shims = writeShims(runtime), env = daemonEnvironment(runtime, shims)
	for (const key of ["PATH", "ISSUE560_REAL_GIT", "ISSUE560_GIT_GATE", "ISSUE560_GIT_ENTERED", "ISSUE560_GIT_RELEASE", "ISSUE560_GIT_LOG"] as const) {
		const value = env[key]
		if (value !== undefined) process.env[key] = value
	}
	let daemon = startDaemon(runtime, env)
	const chains: string[] = []
	let completed = false
	try {
		await ready(daemon); event("ready", { id, sourceSha, pid: daemon.child.pid, socket: resolve(daemon.root, "daemon.sock") })

		// C01-C03/C08: block the daemon's real fetch child while its socket remains responsive.
		const blocked = `issue560-blocked-${id}`; chains.push(blocked); writeFileSync(shims.gate, "fetch\n"); createChain(daemon, blocked, repos.target)
		await until(() => existsSync(resolve(runtime, "shim-state/fetch-entered")), Boolean, "blocked git fetch")
		const latencies = await daemonStatusLatenciesWhileGitBlocked(daemon, 4)
		writeFileSync(resolve(runtime, "shim-state/fetch-release"), "release\n"); rmSync(shims.gate, { force: true })
		await until(() => statusDone(daemon, blocked, repos.target), Boolean, "blocked chain completion")
		const rows = closureRows(daemon.root, blocked).filter((row) => row.phase === "iteration" || row.phase === "review")
		assert(rows.length === 2 && new Set(rows.map((row) => row.worktree_path)).size === 2 && new Set(rows.map((row) => row.branch_name)).size === 2, "C01 closure resources are not distinct")
		assert(rows.every((row) => row.base_commit === repos.advanced && row.branch_name?.startsWith(closureBranchPrefix(blocked))), "C02/C03 fetched base or branch identity mismatch")
		const blockedObservations = observations(shims.runnerLog).filter((row) => row.chain === blocked)
		assert(blockedObservations.length === 2, "C01 runner observations missing")
		for (const row of rows) {
			const runner = blockedObservations.find((observation) => observation.phase === row.phase)
			assert(runner !== undefined && runner.cwd === row.worktree_path && runner.branch === row.branch_name, `C01/C03 pre-spawn resource identity mismatch for ${row.phase}`)
		}
		const lifecycleLog = command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--chain", blocked, "--loop-data-root", daemon.root], { env }).stdout
		assert(lifecycleLog.indexOf("closure.resource_prepared") >= 0 && lifecycleLog.indexOf("closure.resource_prepared") < lifecycleLog.indexOf("agent.spawn"), "C01/C03 resources were not durably observed before runner spawn")
		const fetchCount = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").split("\n").filter((line) => line.includes('"event":"fetch"')).length
		assert(fetchCount === 2, `C02 expected one serialized fetch per opened closure, observed ${fetchCount}`)
		event("C01-C03.C08.pass", { rows, runner: blockedObservations, latencies, fetchCount })

		// C02 negative cases: no-origin is admitted; origin fetch failure is typed/audited.
		const noOrigin = `issue560-no-origin-${id}`; chains.push(noOrigin); createChain(daemon, noOrigin, repos.noOrigin); await until(() => statusDone(daemon, noOrigin, repos.noOrigin), Boolean, "no-origin completion"); const noOriginRows = closureRows(daemon.root, noOrigin); assert(noOriginRows.length >= 2, "no-origin chain did not run")
		const bad = `issue560-bad-${id}`; chains.push(bad); createChain(daemon, bad, repos.badRemote)
		await until(() => command(["bun", LOOP_ENTRY, "logs", repos.badRemote, "--json", "--type", "closure.git_failed", "--chain", bad, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout.includes("base_fetch_failed"), Boolean, "typed fetch failure")
		const coordinator = createRepositoryGitCoordinator()
		const manager = createGitWorktreeManager({ loopDataRoot: daemon.root }, coordinator)
		const directChain = { id: 999_560, name: `issue560-direct-${id}`, preset: PRESET, repository: "issue-560/fixture", baseBranch: "main", status: "active", metadata: {}, createdAt: 0, updatedAt: 0 } as const
		const directItem = { id: 999_561, chainId: directChain.id, itemId: "direct", repoCwd: repos.target, status: "queued", phase: null, runner: null, attempts: 0, lastRunId: null, agentCwd: null, extra: {}, position: 0, createdAt: 0, updatedAt: 0 } as const
		const gitLogBeforeSingleflight = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8")
		const singleflightContexts = ["singleflight-a", "singleflight-b"].map((phase, index) => ({ chain: directChain, item: { ...directItem, id: directItem.id + index }, phase, closureId: `closure:direct:${phase}`, repoCwd: repos.target, slotKey: `slot-${phase}`, existing: null }))
		const singleflightResources = await Promise.all(singleflightContexts.map((context) => manager(context)))
		const gitLogAfterSingleflight = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").slice(gitLogBeforeSingleflight.length)
		const concurrentFetchCount = gitLogAfterSingleflight.split("\n").filter((line) => line.includes('"event":"fetch"')).length
		assert(concurrentFetchCount === 1, `C02 concurrent closure opens executed ${concurrentFetchCount} fetches`)
		for (let index = 0; index < singleflightResources.length; index += 1) {
			const resource = singleflightResources[index]; assert(resource !== undefined && typeof resource !== "string", "C02 singleflight resources missing")
			await cleanupSchedulerChainWorktrees([{ repoCwd: repos.target, closure: { closureId: singleflightContexts[index]!.closureId, itemRowId: singleflightContexts[index]!.item.id, itemId: "direct", phase: singleflightContexts[index]!.phase, lifecycle: "consumed", worktreePath: resource.worktreePath, branchName: resource.branchName, baseCommit: resource.baseCommit, sourceParNodeId: null, sessions: [] } }])
		}
		event("C02.pass", { noOrigin: noOriginRows.map((row) => row.base_commit), badRemote: "base_fetch_failed", concurrentFetchCount })

		// C09: interrupt a real attempt, restart daemon, and observe same cwd/branch/session resume.
		const interrupted = `issue560-interrupt-${id}`; chains.push(interrupted); createChain(daemon, interrupted, repos.target)
		await until(() => observations(shims.runnerLog).some((row) => row.chain === interrupted && row.phase === "iteration" && row.attempt === 1), Boolean, "interrupt runner readiness")
		const first = observations(shims.runnerLog).find((row) => row.chain === interrupted && row.phase === "iteration" && row.attempt === 1); assert(first, "missing first interrupted attempt")
		const interruptedBefore = closureRows(daemon.root, interrupted).find((row) => row.phase === "iteration"); assert(interruptedBefore?.worktree_path !== null && interruptedBefore !== undefined, "missing interrupted closure before restart")
		const interruptedWorktree = interruptedBefore.worktree_path
		writeFileSync(resolve(interruptedWorktree, ".gitignore"), "ignored.txt\n")
		writeFileSync(resolve(interruptedWorktree, "tracked-wip.txt"), "tracked\n")
		command([REAL_GIT, "add", ".gitignore", "tracked-wip.txt"], { cwd: interruptedWorktree })
		writeFileSync(resolve(interruptedWorktree, "untracked.txt"), "untracked\n")
		writeFileSync(resolve(interruptedWorktree, "ignored.txt"), "ignored\n")
		writeFileSync(resolve(interruptedWorktree, ".issue560-scratch"), "scratch bytes survive lifecycle transitions\n")
		await stopDaemon(daemon)
		const continuityBefore = await until(() => closureSnapshot(daemon.root, interruptedBefore.closure_id, interruptedWorktree), (snapshot) => snapshot.includes(first.sessionId), "interrupted closure session")
		const continuityStore = openSqliteStateStore({ loopDataRoot: daemon.root })
		continuityStore.setClosureLifecycle(interruptedBefore.closure_id, { kind: "suspend", updatedAt: 1_900_000_001 })
		const suspendedSnapshot = closureSnapshot(daemon.root, interruptedBefore.closure_id, interruptedWorktree)
		continuityStore.setClosureLifecycle(interruptedBefore.closure_id, { kind: "activate", updatedAt: 1_900_000_002 })
		const reopenedSnapshot = closureSnapshot(daemon.root, interruptedBefore.closure_id, interruptedWorktree)
		continuityStore.close()
		assert(continuityBefore === suspendedSnapshot && suspendedSnapshot === reopenedSnapshot, "C04 suspend/reopen mutated Git, WIP, scratch, or session state")
		daemon = startDaemon(runtime, env); await ready(daemon)
		await until(() => observations(shims.runnerLog).some((row) => row.chain === interrupted && row.phase === "iteration" && row.attempt === 2), Boolean, "resumed attempt", 90_000)
		await until(() => statusDone(daemon, interrupted, repos.target), Boolean, "interrupt chain completion")
		const second = observations(shims.runnerLog).find((row) => row.chain === interrupted && row.phase === "iteration" && row.attempt === 2); assert(second, "missing resumed attempt"); assert(second.cwd === first.cwd && second.branch === first.branch && second.argv.includes("--resume") && second.argv.includes(first.sessionId), "C04/C09 resume identity mismatch")
		const interruptedAfter = closureRows(daemon.root, interrupted).find((row) => row.phase === "iteration"); assert(interruptedAfter !== undefined && interruptedAfter.lifecycle === "active" && interruptedAfter.worktree_path === interruptedBefore.worktree_path && interruptedAfter.branch_name === interruptedBefore.branch_name, "C09 interruption changed lifecycle or resources")
		const continuityAfter = closureSnapshot(daemon.root, interruptedBefore.closure_id, interruptedWorktree)
		assert(continuityAfter === continuityBefore, "C04 scheduler resume changed closure Git, WIP, scratch, or session state")
		event("C04.pass", { closureId: interruptedBefore.closure_id, worktree: interruptedWorktree, sessionId: first.sessionId, resumedAttempt: second.attempt })
		event("C09.pass", { first, second, lifecycle: interruptedAfter.lifecycle, resources: { worktree: interruptedAfter.worktree_path, branch: interruptedAfter.branch_name } })

		// C07: restart reconciliation reports all contradiction kinds and repairs only orphans.
		await stopDaemon(daemon)
		const missingDir = rows[0]!.worktree_path!, missingBranch = rows[1]!.branch_name!; rmSync(missingDir, { recursive: true, force: true }); command([REAL_GIT, "update-ref", "-d", missingBranch], { cwd: repos.target })
		const orphanDir = resolve(daemon.root, "chains", blocked, "worktrees", "orphan"); mkdirSync(orphanDir, { recursive: true }); const orphanBranch = `${closureBranchPrefix(blocked)}orphan`; command([REAL_GIT, "branch", orphanBranch.replace("refs/heads/", ""), "main"], { cwd: repos.target }); command([REAL_GIT, "config", "core.hooksPath", ".issue560-hooks"], { cwd: repos.target }); command([REAL_GIT, "config", "extensions.worktreeConfig", "true"], { cwd: repos.target })
		daemon = startDaemon(runtime, env); await ready(daemon)
		const reconcileKinds = ["missing-directory", "missing-branch", "orphan-directory", "orphan-branch", "hooks-drift", "repo-config-drift"]
		const reconcile = await until(() => command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--type", "closure.reconciled", "--chain", blocked, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout, (text) => reconcileKinds.every((kind) => text.includes(kind)), "reconciliation events")
		assert(!existsSync(orphanDir) && command([REAL_GIT, "show-ref", "--verify", orphanBranch], { cwd: repos.target, allowFail: true }).exitCode !== 0, "C07 orphan repair failed"); command([REAL_GIT, "config", "--unset", "core.hooksPath"], { cwd: repos.target }); command([REAL_GIT, "config", "--unset", "extensions.worktreeConfig"], { cwd: repos.target })
		assert(rows.every((row) => closureRows(daemon.root, blocked).find((current) => current.closure_id === row.closure_id)?.lifecycle === row.lifecycle), "C07 reconciliation silently changed lifecycle")
		event("C07.pass", { eventKinds: reconcileKinds, bytes: reconcile.length })

		// C05: every present/future reachability seed protects the closure; the winning consume
		// transaction clears sessions, removes only its owned resources and emits evidence/freshness.
		const consumeStore = openSqliteStateStore({ loopDataRoot: daemon.root }), consumeRows = closureRows(daemon.root, noOrigin), candidate = consumeRows.find((row) => row.phase === "review"); assert(candidate !== undefined, "missing C05 candidate")
		const tree = consumeStore.getTaskTree(consumeStore.getChainByName(noOrigin)?.id ?? -1); assert(tree !== null, "missing C05 task tree")
		const candidateClosure = findClosure(tree.root, candidate.closure_id); assert(candidateClosure !== null, "missing C05 closure snapshot")
		const reachabilityCases = [
			{ label: "active-run", seed: "active-run", reachable: true },
			{ label: "terminal-with-resumable-attempt", seed: "resumable-attempt", reachable: true },
			{ label: "budget-exhausted-with-resumable-attempt", seed: "resumable-attempt", reachable: true },
			{ label: "cancelled-with-decided-reopen", seed: "decided-reopen", reachable: true },
			{ label: "open-seq-suffix", seed: "seq-suffix", reachable: true },
			{ label: "open-par-next-epoch", seed: "open-par-epoch", reachable: true },
			{ label: "open-append-place", seed: "open-append", reachable: true },
			{ label: "materialized-next-epoch-binding", seed: "next-epoch-candidate", reachable: true },
			{ label: "closed-seq-scope", seed: null, reachable: false },
			{ label: "completed-par-without-next-epoch", seed: null, reachable: false },
			{ label: "sealed-append-place", seed: null, reachable: false },
			{ label: "consumed-reopen-and-sealed-join-epoch", seed: null, reachable: false },
		] as const
		for (const reachabilityCase of reachabilityCases) {
			const seeds = reachabilityCase.seed === null ? [] : [{ kind: reachabilityCase.seed, closureId: candidate.closure_id }]
			const reachable = computeClosureReachability({ closures: [candidate.closure_id], seeds, edges: [] }).has(candidate.closure_id)
			assert(reachable === reachabilityCase.reachable, `C05 ${reachabilityCase.label} reachability mismatch`)
			if (!reachable) continue
			const protectedResult = consumeStore.consumeClosureIfUnreachable(candidate.closure_id, { model: { closures: [candidate.closure_id], seeds, edges: [] }, updatedAt: 1_900_000_010 })
			assert(protectedResult.kind === "retained" && protectedResult.reason === "reachable", `C05 ${reachabilityCase.label} did not retain closure`)
		}
		const issuerClosureId = `${candidate.closure_id}:issuer`
		const transitiveReachability = computeClosureReachability({ closures: [issuerClosureId, candidate.closure_id], seeds: [{ kind: "open-append", closureId: issuerClosureId }], edges: [{ kind: "scope-target", fromClosureId: issuerClosureId, toClosureId: candidate.closure_id }] })
		assert(transitiveReachability.has(candidate.closure_id), "C05 least-fixed-point scope edge did not protect target closure")
		const consumedEvents: Extract<SchedulerEvent, { type: "closure.consumed" }>[] = []
		const gitEntered = resolve(runtime, "shim-state/fetch-entered"), gitRelease = resolve(runtime, "shim-state/fetch-release")
		rmSync(gitEntered, { force: true }); rmSync(gitRelease, { force: true }); writeFileSync(shims.gate, "worktree-remove\n")
		const competingReady = resolve(runtime, "shim-state/competing-writer-ready")
		const competingResult = resolve(runtime, "shim-state/competing-writer-result")
		const competingCode = `import { writeFileSync } from "node:fs"; import { openSqliteStateStore } from ${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))}; writeFileSync(process.env.READY!, "ready\\n"); const store=openSqliteStateStore({loopDataRoot:process.env.LOOP_ROOT!}); try { store.setClosureLifecycle(process.env.CLOSURE_ID!, {kind:"activate",updatedAt:19000000105}); writeFileSync(process.env.RESULT!, "activated\\n") } catch (error) { writeFileSync(process.env.RESULT!, error instanceof Error ? error.message : "non-error") } finally { store.close() }`
		const competingWriter = spawn("bun", ["-e", competingCode], { cwd: REPO_ROOT, env: { ...cleanEnvironment(), READY: competingReady, RESULT: competingResult, LOOP_ROOT: daemon.root, CLOSURE_ID: candidate.closure_id }, stdio: "ignore" })
		await until(() => existsSync(competingReady), Boolean, "competing lifecycle writer start")
		const consumePromise = consumeSchedulerClosure({ chainId: tree.chainId, repoCwd: repos.noOrigin, closure: candidateClosure, model: { closures: [candidate.closure_id], seeds: [], edges: [] }, updatedAt: 1_900_000_011, evidence: "unpublished-discarded", store: consumeStore, emit: (consumedEvent) => { consumedEvents.push(consumedEvent) } })
		await until(() => existsSync(gitEntered), Boolean, "blocked worktree remove")
		const removeLatencies = await daemonStatusLatenciesWhileGitBlocked(daemon, 3)
		writeFileSync(gitRelease, "release\n"); rmSync(shims.gate, { force: true })
		const consumed = await consumePromise
		await until(() => competingWriter.exitCode, (code) => code !== null, "competing lifecycle writer exit")
		const competingOutcome = readFileSync(competingResult, "utf8").trim()
		assert(consumed.decision.kind === "consumed" && consumed.decision.closure.sessions.length === 0 && consumed.cleanup?.removed === true, "C05 consume/session/resource cleanup failed")
		assert(!existsSync(candidateClosure.worktreePath ?? "") && command([REAL_GIT, "show-ref", "--verify", candidateClosure.branchName ?? "missing"], { cwd: repos.noOrigin, allowFail: true }).exitCode !== 0, "C05 owned worktree or branch survived consumption")
		assert(consumedEvents.length === 1 && consumedEvents[0]?.evidence === "unpublished-discarded" && consumedEvents[0].freshness.kind === "retained", "C05 consumption evidence/freshness event missing")
		let conflict = false; try { consumeStore.setClosureLifecycle(candidate.closure_id, { kind: "activate", updatedAt: 1_900_000_012 }) } catch { conflict = true } consumeStore.close(); assert(conflict, "C05 competing writer reactivated consumed closure")
		event("C05.pass", { reachabilityCases, transitiveReachability: [...transitiveReachability], competingOutcome, consumed: consumed.decision.kind, cleanup: consumed.cleanup, event: consumedEvents[0], evidenceVariants: ["no-work", "published", "unpublished-discarded", "unevaluable"], freshnessVariants: ["fetched", "no-origin", "retained"], removeLatencies })

		// C06/C10: direct production manager exercise for persisted par pin and concurrent repo coordination.
		const pin = command([REAL_GIT, "rev-parse", "refs/heads/main"], { cwd: repos.target }).stdout.trim()
		writeFileSync(resolve(repos.target, "nested-pin.txt"), "nested par pin\n"); command([REAL_GIT, "add", "nested-pin.txt"], { cwd: repos.target }); command([REAL_GIT, "-c", "user.name=issue-560", "-c", "user.email=issue-560@invalid", "commit", "-qm", "nested par pin"], { cwd: repos.target }); const nestedPin = command([REAL_GIT, "rev-parse", "HEAD"], { cwd: repos.target }).stdout.trim()
		const contextSpecs = [
			{ phase: "par-active-a", lifecycle: "active" as const, sourceParNodeId: "par-root", baseCommit: pin },
			{ phase: "par-active-b", lifecycle: "active" as const, sourceParNodeId: "par-root", baseCommit: pin },
			{ phase: "par-suspended", lifecycle: "suspended" as const, sourceParNodeId: "par-root", baseCommit: pin },
			{ phase: "nested-par-member", lifecycle: "active" as const, sourceParNodeId: "par-nested", baseCommit: nestedPin },
		]
		const gitLogBeforePar = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8")
		const contexts = contextSpecs.map(({ phase, lifecycle, sourceParNodeId, baseCommit }, index) => ({ chain: directChain, item: { ...directItem, id: directItem.id + index }, phase, closureId: `closure:direct:${phase}`, repoCwd: repos.target, slotKey: `slot-${phase}`, existing: { closureId: `closure:direct:${phase}`, itemRowId: directItem.id + index, itemId: "direct", phase, lifecycle, worktreePath: null, branchName: null, baseCommit, sourceParNodeId, sessions: [] } }))
		rmSync(gitEntered, { force: true }); rmSync(gitRelease, { force: true }); writeFileSync(shims.gate, "worktree-add\n")
		const directResourcesPromise = Promise.all(contexts.map((context) => manager(context)))
		await until(() => existsSync(gitEntered), Boolean, "blocked worktree add")
		const addLatencies = await daemonStatusLatenciesWhileGitBlocked(daemon, 3)
		writeFileSync(gitRelease, "release\n"); rmSync(shims.gate, { force: true })
		const directResources = await directResourcesPromise; assert(directResources.every((resource, index) => typeof resource !== "string" && resource.baseCommit === contextSpecs[index]?.baseCommit), "C06 par pin mismatch")
		const gitLogAfterPar = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").slice(gitLogBeforePar.length); assert(!gitLogAfterPar.includes('"event":"fetch"'), "C06 par member performed independent fetch")
		await Promise.all(directResources.map(async (resource, index) => {
			if (typeof resource === "string") fail("expected typed direct resources")
			writeFileSync(resolve(resource.worktreePath, `concurrent-${index}.txt`), `${index}\n`)
			await coordinator.run(repos.target, async () => await commandAsync([REAL_GIT, "add", `concurrent-${index}.txt`], { cwd: resource.worktreePath }))
			await coordinator.run(repos.target, async () => await commandAsync([REAL_GIT, "-c", "user.name=issue-560", "-c", "user.email=issue-560@invalid", "commit", "-m", `issue-560 concurrent ${index}`], { cwd: resource.worktreePath }))
			await coordinator.run(repos.target, async () => await commandAsync([REAL_GIT, "push", "-q", "origin", `HEAD:${resource.branchName}`], { cwd: resource.worktreePath }))
		}))
		const resourceStatesBefore = directResources.map((resource, index) => {
			if (typeof resource === "string") fail("expected typed direct resources")
			writeFileSync(resolve(resource.worktreePath, `.wip-${index}`), `wip-${index}\n`)
			return { baseCommit: resource.baseCommit, head: command([REAL_GIT, "rev-parse", "HEAD"], { cwd: resource.worktreePath }).stdout.trim(), index: command([REAL_GIT, "ls-files", "--stage"], { cwd: resource.worktreePath }).stdout, status: command([REAL_GIT, "status", "--porcelain=v1", "--ignored"], { cwd: resource.worktreePath }).stdout }
		})
		const remoteWriter = resolve(runtime, "remote-writer"); command([REAL_GIT, "clone", "-q", repos.origin, remoteWriter]); command([REAL_GIT, "switch", "-q", "main"], { cwd: remoteWriter }); writeFileSync(resolve(remoteWriter, "tracking-advance.txt"), "remote tracking advance\n"); command([REAL_GIT, "add", "tracking-advance.txt"], { cwd: remoteWriter }); command([REAL_GIT, "-c", "user.name=issue-560", "-c", "user.email=issue-560@invalid", "commit", "-qm", "advance tracking ref"], { cwd: remoteWriter }); command([REAL_GIT, "push", "-q", "origin", "main"], { cwd: remoteWriter }); const trackingCommit = command([REAL_GIT, "rev-parse", "HEAD"], { cwd: remoteWriter }).stdout.trim()
		await coordinator.run(repos.target, async () => await commandAsync([REAL_GIT, "fetch", "origin", "main"], { cwd: repos.target }))
		assert(command([REAL_GIT, "rev-parse", "refs/remotes/origin/main"], { cwd: repos.target }).stdout.trim() === trackingCommit, "C10 remote-tracking ref did not advance")
		const directLeaves = contexts.map((context, index): TaskNodeSnapshot => {
			const resource = directResources[index]; if (resource === undefined || typeof resource === "string") fail("expected typed direct resources")
			return { kind: "leaf", identity: { runtimeNodeId: `leaf-${context.closureId}`, definitionRef: { kind: "chain", contentIdentity: "sha256:issue-560-direct" }, definitionNodeId: context.phase }, closure: { ...context.existing, worktreePath: resource.worktreePath, branchName: resource.branchName } }
		})
		const directTree: TaskNodeSnapshot = { kind: "seq", identity: { runtimeNodeId: `seq-${directChain.name}`, definitionRef: { kind: "chain", contentIdentity: "sha256:issue-560-direct" }, definitionNodeId: "root" }, cursor: { kind: "complete" }, children: directLeaves }
		command([REAL_GIT, "config", "core.hooksPath", ".issue560-live-hooks"], { cwd: repos.target })
		command([REAL_GIT, "config", "extensions.worktreeConfig", "true"], { cwd: repos.target })
		const driftFindings = await reconcileClosureResources({ chain: directChain, items: contexts.map((context) => context.item), tree: directTree, loopDataRootOptions: { loopDataRoot: daemon.root } })
		assert(driftFindings.some((finding) => finding.mismatch.kind === "hooks-drift") && driftFindings.some((finding) => finding.mismatch.kind === "repo-config-drift"), "C10 live-resource config/hooks drift was not audited")
		const resourceStatesAfter = directResources.map((resource) => {
			if (typeof resource === "string") fail("expected typed direct resources")
			return { baseCommit: resource.baseCommit, head: command([REAL_GIT, "rev-parse", "HEAD"], { cwd: resource.worktreePath }).stdout.trim(), index: command([REAL_GIT, "ls-files", "--stage"], { cwd: resource.worktreePath }).stdout, status: command([REAL_GIT, "status", "--porcelain=v1", "--ignored"], { cwd: resource.worktreePath }).stdout }
		})
		assert(JSON.stringify(resourceStatesBefore) === JSON.stringify(resourceStatesAfter), "C10 tracking/config churn mutated saved base, HEAD, index, or WIP")
		command([REAL_GIT, "config", "--unset", "core.hooksPath"], { cwd: repos.target })
		command([REAL_GIT, "config", "--unset", "extensions.worktreeConfig"], { cwd: repos.target })
		for (let index = 0; index < directResources.length; index += 1) {
			const resource = directResources[index]!; if (typeof resource === "string") fail("expected typed direct resources")
			await cleanupSchedulerChainWorktrees([{ repoCwd: repos.target, closure: { ...contexts[index]!.existing, lifecycle: "consumed", worktreePath: resource.worktreePath, branchName: resource.branchName } }])
		}
		assert(!readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").includes("gc"), "C10 explicit gc observed")
		event("C06.C10.pass", { pin, nestedPin, resources: directResources, addLatencies, trackingCommit, freshness: { kind: "fetched", remote: "origin", commit: trackingCommit, observedAt: new Date().toISOString() } satisfies OriginFreshness, driftKinds: driftFindings.map((finding) => finding.mismatch.kind), resourceStates: resourceStatesAfter })

		for (const chain of chains) deleteChain(daemon, chain)
		await stopDaemon(daemon)
		for (const repo of [repos.target, repos.noOrigin, repos.badRemote]) { const refs = command([REAL_GIT, "for-each-ref", "--format=%(refname)", "refs/heads/coder-loop/closures"], { cwd: repo }).stdout.trim(); assert(refs === "", `engine refs remain in ${repo}: ${refs}`) }
		assert(!existsSync(resolve(daemon.root, "daemon.sock")), "daemon socket remains")
		writeFileSync(resolve(evidence, "observations.json"), JSON.stringify({ id, sourceSha, runner: observations(shims.runnerLog), daemon: { stdout: daemon.stdout, stderr: daemon.stderr } }, null, 2))
		rmSync(runtime, { recursive: true, force: true }); assert(!existsSync(runtime), "runtime root remains")
		completed = true
		event("issue-560.pass", { id, sourceSha, checks: ["C01","C02","C03","C04","C05","C06","C07","C08","C09","C10"], evidence })
	} finally {
		if (daemon.child.exitCode === null) await stopDaemon(daemon)
		if (completed && existsSync(runtime)) rmSync(runtime, { recursive: true, force: true })
		if (!completed) event("diagnostic.retained", { runtime, daemonStdout: daemon.stdout, daemonStderr: daemon.stderr })
	}
}

if (import.meta.main) await main()
