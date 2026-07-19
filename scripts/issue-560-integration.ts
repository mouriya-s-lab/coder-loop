#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"

import { closureBranchPrefix, createRepositoryGitCoordinator, type OriginFreshness } from "../src/closure-lifecycle"
import { cleanupSchedulerChainWorktrees, createGitWorktreeManager, consumeSchedulerClosure, reconcileClosureResources, sampleClosureConsumptionObservation } from "../src/scheduler"
import type { JsonObject } from "../src/loop"
import { openSqliteStateStore, type ChainRecord, type ItemRecord } from "../src/sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "../src/runtime-data"
import type { TaskNodeSnapshot, TaskTreeSnapshot } from "../src/task-runtime"

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
function runtimeStatus(value: string) { return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "issue-560.status"), "test") }
function record(value: unknown, label: string): Record<string, unknown> {
	assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`)
	return Object.fromEntries(Object.entries(value))
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
function event(type: string, payload: JsonObject = {}): void {
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
	const runner = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
const argv=process.argv.slice(2),p=argv[argv.lastIndexOf("-p")+1]??""
const f=Object.fromEntries(p.split("\\n").map(x=>x.match(/^(PHASE|CHAIN|ITEM|RUN)=(.+)$/)).filter(Boolean).map(x=>[x[1].toLowerCase(),x[2]]))
const c=resolve(process.cwd(),".issue560-"+f.phase+".count"),attempt=existsSync(c)?Number(readFileSync(c,"utf8"))+1:1
writeFileSync(c,String(attempt))
const branch=spawnSync(process.env.ISSUE560_REAL_GIT!,["symbolic-ref","-q","HEAD"],{encoding:"utf8"}).stdout.trim(),sessionId="issue560-"+f.chain+"-"+f.phase
appendFileSync(resolve(process.cwd(),".issue560-runner.jsonl"),JSON.stringify({chain:f.chain,phase:f.phase,cwd:process.cwd(),branch,argv,attempt,sessionId})+"\\n")
process.stdout.write(JSON.stringify({type:"system",session_id:sessionId})+"\\n")
if(f.chain.includes("blocked")&&f.phase==="review"){
  writeFileSync(resolve(process.cwd(),".issue560-blocked-review-entered"),"ready\\n")
  while(!existsSync(resolve(process.cwd(),".issue560-blocked-review-release"))) await Bun.sleep(25)
}
if(f.chain.includes("lifecycle")&&f.phase==="iteration"&&attempt===1){
  writeFileSync(resolve(process.cwd(),".gitignore"),"ignored.txt\\n")
  writeFileSync(resolve(process.cwd(),"tracked-wip.txt"),"tracked\\n")
  spawnSync(process.env.ISSUE560_REAL_GIT!,["add",".gitignore","tracked-wip.txt"],{stdio:"inherit"})
  writeFileSync(resolve(process.cwd(),"untracked.txt"),"untracked\\n")
  writeFileSync(resolve(process.cwd(),"ignored.txt"),"ignored\\n")
  writeFileSync(resolve(process.cwd(),".issue560-scratch"),"scratch bytes survive lifecycle transitions\\n")
}
if(f.chain.includes("lifecycle")&&f.phase==="iteration"&&attempt>1){
  writeFileSync(resolve(process.cwd(),".issue560-lifecycle-entered"),String(attempt)+"\\n")
  while(!existsSync(resolve(process.cwd(),".issue560-lifecycle-release"))) await Bun.sleep(25)
}
if(f.chain.includes("registration")&&f.phase==="iteration"){
  writeFileSync(resolve(process.cwd(),".issue560-registration-entered"),"ready\\n")
  while(!existsSync(resolve(process.cwd(),".issue560-registration-release"))) await Bun.sleep(25)
}
if(f.chain.includes("lifecycle")&&f.phase==="review"&&attempt===1){
  const u=spawnSync("coder-loop",["item","update",f.chain,"--issue",f.item,"--status","changes_requested","--json"],{stdio:"inherit"})
  process.exit(u.status??1)
}
if(f.phase==="review"){
  const u=spawnSync("coder-loop",["item","update",f.chain,"--issue",f.item,"--status","done","--json"],{stdio:"inherit"})
  process.exit(u.status??1)
}
`
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

function chainStatus(root: string, chain: string): string | null {
	const db = new Database(resolve(root, "db.sqlite"), { readonly: true })
	try {
		const row = db.query<{ status: string }, { $chain: string }>("SELECT status FROM chains WHERE name=$chain").get({ $chain: chain })
		return row?.status ?? null
	} finally { db.close() }
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

async function runPersistedReachabilityCases(runtime: string, repoCwd: string): Promise<JsonObject[]> {
	const loopDataRoot = resolve(runtime, "c05-persisted")
	mkdirSync(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	const manager = createGitWorktreeManager({ loopDataRoot })
	const results: JsonObject[] = []
	type CaseKind = "materialized-seq-suffix" | "open-par-epoch" | "decided-reopen" | "decided-unrelated-sibling" | "next-epoch-candidate" | "sealed-newer-binding" | "open-append" | "sealed-seq"
	const cases: readonly { kind: CaseKind; itemStatus: "queued" | "done"; expected: "retained" | "consumed" }[] = [
		{ kind: "materialized-seq-suffix", itemStatus: "queued", expected: "retained" },
		{ kind: "open-par-epoch", itemStatus: "done", expected: "retained" },
		{ kind: "decided-reopen", itemStatus: "done", expected: "retained" },
		{ kind: "decided-unrelated-sibling", itemStatus: "done", expected: "consumed" },
		{ kind: "next-epoch-candidate", itemStatus: "done", expected: "retained" },
		{ kind: "sealed-newer-binding", itemStatus: "done", expected: "consumed" },
		{ kind: "open-append", itemStatus: "done", expected: "retained" },
		{ kind: "sealed-seq", itemStatus: "done", expected: "consumed" },
	]
	try {
		for (let index = 0; index < cases.length; index += 1) {
			const spec = cases[index]!
			const chain = store.createChain({ name: `issue560-c05-${index}-${spec.kind}`, preset: PRESET, repository: "issue-560/fixture", baseBranch: "main", metadata: storedChainMetadata({}) })
			const item = store.createItem({ chainId: chain.id, itemId: `c05-${index}`, repoCwd, status: runtimeStatus(spec.itemStatus), preset: PRESET, extra: storedItemExtra({}) })
			const phase = "iteration", closureId = `closure:c05:${index}:${phase}`
			const resource = await manager({ chain, item, phase, closureId, repoCwd, slotKey: `c05-${index}`, existing: null })
			assert(typeof resource !== "string", `C05 ${spec.kind} resource creation failed`)
			const definitionRef = { kind: "chain", contentIdentity: `sha256:c05-${index}` } as const
			const parCase = spec.kind === "open-par-epoch" || spec.kind === "decided-reopen" || spec.kind === "decided-unrelated-sibling" || spec.kind === "next-epoch-candidate" || spec.kind === "sealed-newer-binding"
			const closure = { closureId, itemRowId: item.id, itemId: item.itemId, phase, lifecycle: "suspended", worktreePath: resource.worktreePath, branchName: resource.branchName, baseCommit: resource.baseCommit, sourceParNodeId: parCase ? `par-c05-${index}` : null, sessions: [] } as const
			const leaf = { kind: "leaf", identity: { runtimeNodeId: `leaf-c05-${index}`, definitionRef, definitionNodeId: phase }, closure } as const
			let tree: TaskTreeSnapshot
			if (parCase) {
				const evaluation = spec.kind === "open-par-epoch" ? { kind: "not-evaluating" } as const : { kind: "decided", epoch: 1, bindingVersion: 1 } as const
				tree = { root: { kind: "par", identity: { runtimeNodeId: `par-c05-${index}`, definitionRef, definitionNodeId: `par-c05-${index}` }, groupId: `par-c05-${index}`, pinCommit: resource.baseCommit, state: spec.kind === "open-par-epoch" ? "open" : "completed", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation }, children: [leaf] }, activeRuns: [] }
			} else {
				tree = { root: { kind: "seq", identity: { runtimeNodeId: `seq-c05-${index}`, definitionRef, definitionNodeId: `seq-c05-${index}` }, cursor: spec.kind === "sealed-seq" ? { kind: "complete" } : { kind: "next", nodeId: leaf.identity.runtimeNodeId }, children: [leaf] }, activeRuns: [] }
			}
			store.createTaskTree(chain.id, tree)
			if (spec.kind === "open-append") {
				const db = new Database(resolve(loopDataRoot, "db.sqlite"))
				try {
					db.query("INSERT INTO closure_reachability_seeds (chain_id,closure_id,kind) VALUES ($chain,$closure,'open-append')").run({ $chain: chain.id, $closure: closureId })
				} finally { db.close() }
			}
			if (spec.kind === "decided-reopen" || spec.kind === "next-epoch-candidate") {
				const db = new Database(resolve(loopDataRoot, "db.sqlite"))
				try {
					db.query("INSERT INTO closure_reachability_seeds (chain_id,closure_id,kind) VALUES ($chain,$closure,$kind)").run({ $chain: chain.id, $closure: closureId, $kind: spec.kind })
				} finally { db.close() }
			}
			if (spec.kind === "next-epoch-candidate" || spec.kind === "sealed-newer-binding") {
				const db = new Database(resolve(loopDataRoot, "db.sqlite"))
				try {
					db.query("INSERT INTO task_join_bindings (par_node_id,version,join_kind,candidate_definition_kind,candidate_definition_content_identity,candidate_id,author_kind,author_id,authority_class,effective_from_epoch,created_at) VALUES ($par,2,'drain',NULL,NULL,NULL,'engine','issue-560','runtime',2,2)").run({ $par: `par-c05-${index}` })
				} finally { db.close() }
			}
			const events: JsonObject[] = []
			const observed = await consumeSchedulerClosure({ chainId: chain.id, chainName: chain.name, baseBranch: chain.baseBranch, repoCwd, closure, authority: { kind: "outer-completion", chainId: chain.id, terminalStatuses: [runtimeStatus("done")] }, updatedAt: 2_000_000_000 + index, loopDataRootOptions: { loopDataRoot }, store, emit: (value) => { events.push(value) } })
			assert(observed.decision.kind === spec.expected, `C05 ${spec.kind} expected ${spec.expected}, observed ${observed.decision.kind}`)
			results.push({ kind: spec.kind, decision: observed.decision.kind, reason: observed.decision.kind === "retained" ? observed.decision.reason : null, events })
			if (observed.decision.kind === "retained") {
				const cleanup = await consumeSchedulerClosure({ chainId: chain.id, chainName: chain.name, baseBranch: chain.baseBranch, repoCwd, closure, authority: { kind: "chain-deletion", chainId: chain.id }, updatedAt: 2_000_000_100 + index, loopDataRootOptions: { loopDataRoot }, store, emit: () => {} })
				assert(cleanup.decision.kind === "consumed", `C05 ${spec.kind} cleanup did not consume`)
			}
		}
		return results
	} finally { store.close() }
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
	const retainedRunnerObservations: RunnerObservation[] = []
	let completed = false
	try {
		await ready(daemon); event("ready", { id, sourceSha, pid: daemon.child.pid ?? 0, socket: resolve(daemon.root, "daemon.sock") })

		// C01-C03/C08: block the daemon's real fetch child while its socket remains responsive.
		const blocked = `issue560-blocked-${id}`; chains.push(blocked); writeFileSync(shims.gate, "fetch\n"); createChain(daemon, blocked, repos.target)
		await until(() => existsSync(resolve(runtime, "shim-state/fetch-entered")), Boolean, "blocked git fetch")
		const latencies = await daemonStatusLatenciesWhileGitBlocked(daemon, 4)
		writeFileSync(resolve(runtime, "shim-state/fetch-release"), "release\n"); rmSync(shims.gate, { force: true })
		const blockedReview = await until(() => observations(shims.runnerLog).find((row) => row.chain === blocked && row.phase === "review") ?? null, (row) => row !== null && existsSync(resolve(row.cwd, ".issue560-blocked-review-entered")), "blocked review readiness")
		assert(blockedReview !== null, "blocked review observation missing")
		const rows = closureRows(daemon.root, blocked).filter((row) => row.phase === "iteration" || row.phase === "review")
		assert(rows.length === 2 && new Set(rows.map((row) => row.worktree_path)).size === 2 && new Set(rows.map((row) => row.branch_name)).size === 2, "C01 closure resources are not distinct")
		assert(rows.every((row) => row.base_commit === repos.advanced && row.branch_name?.startsWith(closureBranchPrefix(blocked))), "C02/C03 fetched base or branch identity mismatch")
		const blockedObservations = observations(shims.runnerLog).filter((row) => row.chain === blocked)
		retainedRunnerObservations.push(...blockedObservations)
		assert(blockedObservations.length === 2, "C01 runner observations missing")
		for (const row of rows) {
			const runner = blockedObservations.find((observation) => observation.phase === row.phase)
			assert(runner !== undefined && runner.cwd === row.worktree_path && runner.branch === row.branch_name, `C01/C03 pre-spawn resource identity mismatch for ${row.phase}`)
		}
		const blockedLifecycleLog = command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--chain", blocked, "--loop-data-root", daemon.root], { env }).stdout
		assert(blockedLifecycleLog.indexOf("closure.resource_prepared") >= 0 && blockedLifecycleLog.indexOf("closure.resource_prepared") < blockedLifecycleLog.indexOf("agent.spawn"), "C01/C03 resources were not durably observed before runner spawn")
		const fetchCount = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").split("\n").filter((line) => line.includes('"event":"fetch"')).length
		assert(fetchCount === 2, `C02 expected one fresh-base fetch per first-open phase closure, observed ${fetchCount}`)
		writeFileSync(resolve(blockedReview.cwd, ".issue560-blocked-review-release"), "release\n")
		await until(() => statusDone(daemon, blocked, repos.target), Boolean, "blocked chain completion")
		await until(() => closureRows(daemon.root, blocked).every((row) => row.lifecycle === "consumed"), Boolean, "blocked closure consumption")
		event("C01-C03.C08.pass", { rows, runner: blockedObservations, latencies, fetchCount })

		// C02 negative cases: no-origin is admitted; origin fetch failure is typed/audited.
		const noOrigin = `issue560-no-origin-${id}`; chains.push(noOrigin); createChain(daemon, noOrigin, repos.noOrigin); await until(() => statusDone(daemon, noOrigin, repos.noOrigin), Boolean, "no-origin completion"); const noOriginRows = closureRows(daemon.root, noOrigin); assert(noOriginRows.length >= 2, "no-origin chain did not run")
		const bad = `issue560-bad-${id}`; chains.push(bad); createChain(daemon, bad, repos.badRemote)
		await until(() => command(["bun", LOOP_ENTRY, "logs", repos.badRemote, "--json", "--type", "closure.git_failed", "--chain", bad, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout.includes("base_fetch_failed"), Boolean, "typed fetch failure")
		const coordinator = createRepositoryGitCoordinator()
		const manager = createGitWorktreeManager({ loopDataRoot: daemon.root }, coordinator)
		const directChain: ChainRecord = { id: 999_560, name: `issue560-direct-${id}`, preset: PRESET, repository: "issue-560/fixture", baseBranch: "main", status: "active", metadata: storedChainMetadata({}), createdAt: 0, updatedAt: 0 }
		const directItem: ItemRecord = { id: 999_561, chainId: directChain.id, itemId: "direct", repoCwd: repos.target, status: runtimeStatus("queued"), phase: null, runner: null, attempts: 0, lastRunId: null, agentCwd: null, extra: storedItemExtra({}), position: 0, title: null, priority: null, sessionIds: {}, issueFile: null, evidenceDir: null, preset: null, presetPath: null, createdAt: 0, updatedAt: 0, statusUpdatedAt: 0 }
		const gitLogBeforeSingleflight = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8")
		const singleflightContexts = ["singleflight-a", "singleflight-b"].map((phase, index) => ({ chain: directChain, item: { ...directItem, id: directItem.id + index }, phase, closureId: `closure:direct:${phase}`, repoCwd: repos.target, slotKey: `slot-${phase}`, existing: null }))
		const singleflightResources = await Promise.all(singleflightContexts.map((context) => manager(context)))
		const gitLogAfterSingleflight = readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").slice(gitLogBeforeSingleflight.length)
		const concurrentFetchCount = gitLogAfterSingleflight.split("\n").filter((line) => line.includes('"event":"fetch"')).length
		assert(concurrentFetchCount === 1, `C02 concurrent closure opens executed ${concurrentFetchCount} fetches`)
		for (let index = 0; index < singleflightResources.length; index += 1) {
			const resource = singleflightResources[index]; assert(resource !== undefined && typeof resource !== "string", "C02 singleflight resources missing")
			await cleanupSchedulerChainWorktrees([{ chainName: directChain.name, repoCwd: repos.target, closure: { closureId: singleflightContexts[index]!.closureId, itemRowId: singleflightContexts[index]!.item.id, itemId: "direct", phase: singleflightContexts[index]!.phase, lifecycle: "consumed", worktreePath: resource.worktreePath, branchName: resource.branchName, baseCommit: resource.baseCommit, sourceParNodeId: null, sessions: [] }, loopDataRootOptions: { loopDataRoot: daemon.root } }])
		}
		event("C02.pass", { noOrigin: noOriginRows.map((row) => row.base_commit), badRemote: "base_fetch_failed", concurrentFetchCount })

		// C04/C09: real phase control suspends iteration, enters review, then a
		// changes_requested retry reopens the original iteration closure.
		const lifecycle = `issue560-lifecycle-${id}`; chains.push(lifecycle); createChain(daemon, lifecycle, repos.target)
		await until(() => observations(shims.runnerLog).some((row) => row.chain === lifecycle && row.phase === "iteration" && row.attempt === 2 && existsSync(resolve(row.cwd, ".issue560-lifecycle-entered"))), Boolean, "reopened lifecycle attempt", 90_000)
		const lifecycleObservations = observations(shims.runnerLog).filter((row) => row.chain === lifecycle)
		retainedRunnerObservations.push(...lifecycleObservations)
		const first = lifecycleObservations.find((row) => row.phase === "iteration" && row.attempt === 1)
		const second = lifecycleObservations.find((row) => row.phase === "iteration" && row.attempt === 2)
		assert(first !== undefined && second !== undefined, "C04 lifecycle iteration attempts missing")
		assert(second.cwd === first.cwd && second.branch === first.branch && second.argv.includes("--resume") && second.argv.includes(first.sessionId), "C04 retry did not reopen the original closure/session")
		const lifecycleRows = closureRows(daemon.root, lifecycle)
		const lifecycleIteration = lifecycleRows.find((row) => row.phase === "iteration")
		const lifecycleReview = lifecycleRows.find((row) => row.phase === "review")
		assert(lifecycleIteration?.lifecycle === "active" && lifecycleIteration.worktree_path !== null && lifecycleReview?.lifecycle === "suspended" && lifecycleReview.worktree_path !== null, "C04 scheduler lifecycle state mismatch after reopen")
		const continuityBefore = closureSnapshot(daemon.root, lifecycleIteration.closure_id, lifecycleIteration.worktree_path)
		assert(continuityBefore.includes("scratch bytes survive lifecycle transitions") && continuityBefore.includes(first.sessionId), "C04 reopened closure lost WIP, scratch, or session state")
		const lifecycleLog = readFileSync(daemon.stderr, "utf8").split("\n").filter((line) => line.includes(`chain=${lifecycle}`)).join("\n")
		assert(lifecycleLog.includes("closure.lifecycle_changed") && lifecycleLog.includes("reason=phase-left") && lifecycleLog.includes("reason=phase-entered"), "C04 scheduler lifecycle audit events missing")
		event("C04.pass", { closureId: lifecycleIteration.closure_id, worktree: lifecycleIteration.worktree_path, sessionId: first.sessionId, reopenedAttempt: second.attempt })

		// C07: restart reconciliation reports all contradiction kinds and repairs only orphans.
		const registration = `issue560-registration-${id}`
		createChain(daemon, registration, repos.target)
		const registrationObservation = await until(() => observations(shims.runnerLog).find((row) => row.chain === registration && row.phase === "iteration") ?? null, (row) => row !== null && existsSync(resolve(row.cwd, ".issue560-registration-entered")), "registration mismatch fixture readiness")
		assert(registrationObservation !== null, "C07 registration fixture observation missing")
		command(["bun", LOOP_ENTRY, "chain", "stop", registration, "--loop-data-root", daemon.root, "--json"], { env })
		const registrationRow = closureRows(daemon.root, registration).find((row) => row.phase === "iteration")
		assert(registrationRow?.worktree_path !== null && registrationRow?.worktree_path !== undefined && registrationRow.branch_name !== null, "C07 registration fixture resources missing")
		writeFileSync(resolve(registrationRow.worktree_path, ".issue560-registration-wip"), "registration mismatch survives\n")
		const foreignRegistrationBranch = `issue560-foreign-registration-${id}`
		command([REAL_GIT, "switch", "-q", "-c", foreignRegistrationBranch], { cwd: registrationRow.worktree_path })
		await stopDaemon(daemon)
		const missingDir = lifecycleReview.worktree_path, missingBranch = lifecycleReview.branch_name; assert(missingBranch !== null, "C07 review branch missing"); rmSync(missingDir, { recursive: true, force: true }); command([REAL_GIT, "update-ref", "-d", missingBranch], { cwd: repos.target })
		const orphanDir = resolve(daemon.root, "chains", lifecycle, "worktrees", "orphan"); mkdirSync(orphanDir, { recursive: true }); const orphanBranch = `${closureBranchPrefix(lifecycle)}orphan`; command([REAL_GIT, "branch", orphanBranch.replace("refs/heads/", ""), "main"], { cwd: repos.target }); command([REAL_GIT, "config", "core.hooksPath", ".issue560-hooks"], { cwd: repos.target }); command([REAL_GIT, "config", "extensions.worktreeConfig", "true"], { cwd: repos.target })
		daemon = startDaemon(runtime, env); await ready(daemon)
		const reconcileKinds = ["missing-directory", "missing-branch", "orphan-directory", "orphan-branch", "hooks-drift", "repo-config-drift"]
		const reconcile = await until(() => command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--type", "closure.reconciled", "--chain", lifecycle, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout, (text) => reconcileKinds.every((kind) => text.includes(kind)), "reconciliation events")
		const registrationReconcile = await until(() => command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--type", "closure.reconciled", "--chain", registration, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout, (text) => text.includes("registration-mismatch") && text.includes(registrationRow.closure_id), "registration mismatch reconciliation event")
		assert(command([REAL_GIT, "symbolic-ref", "HEAD"], { cwd: registrationRow.worktree_path }).stdout.trim() === `refs/heads/${foreignRegistrationBranch}`, "C07 reconciliation changed the mismatched worktree branch")
		assert(readFileSync(resolve(registrationRow.worktree_path, ".issue560-registration-wip"), "utf8") === "registration mismatch survives\n", "C07 reconciliation changed mismatched worktree WIP")
		command([REAL_GIT, "switch", "-q", registrationRow.branch_name.replace(/^refs\/heads\//, "")], { cwd: registrationRow.worktree_path })
		command([REAL_GIT, "branch", "-D", foreignRegistrationBranch], { cwd: repos.target })
		command(["bun", LOOP_ENTRY, "chain", "resume", registration, "--loop-data-root", daemon.root, "--json"], { env })
		const resumedRegistration = await until(() => observations(shims.runnerLog).find((row) => row.chain === registration && row.phase === "iteration" && row.attempt >= 2) ?? null, (row) => row !== null, "active deletion fixture resume", 90_000)
		assert(resumedRegistration !== null, "C05 active deletion fixture did not resume")
		assert(!existsSync(orphanDir) && command([REAL_GIT, "show-ref", "--verify", orphanBranch], { cwd: repos.target, allowFail: true }).exitCode !== 0, "C07 orphan repair failed"); command([REAL_GIT, "config", "--unset", "core.hooksPath"], { cwd: repos.target }); command([REAL_GIT, "config", "--unset", "extensions.worktreeConfig"], { cwd: repos.target })
		assert(lifecycleRows.every((row) => closureRows(daemon.root, lifecycle).find((current) => current.closure_id === row.closure_id)?.lifecycle === row.lifecycle), "C07 reconciliation silently changed lifecycle")
		event("C07.pass", { eventKinds: [...reconcileKinds, "registration-mismatch"], bytes: reconcile.length + registrationReconcile.length, registrationClosureId: registrationRow.closure_id })

		// C05: future-writer states not yet produced by the runtime are seeded into a
		// separate persisted store, then consumed through the production store/scheduler/Git path.
		// The live daemon chain below independently proves ordinary outer-completion consumption.
		const persistedReachabilityCases = await runPersistedReachabilityCases(runtime, repos.target)
		const resumedBeforeRelease = await until(() => observations(shims.runnerLog).filter((row) => row.chain === lifecycle && row.phase === "iteration" && row.attempt >= 3).at(-1) ?? null, (row) => row !== null && existsSync(resolve(row.cwd, ".issue560-lifecycle-entered")), "post-reconciliation resumed lifecycle attempt", 90_000)
		assert(resumedBeforeRelease !== null, "C09 resumed lifecycle observation missing")
		writeFileSync(resolve(resumedBeforeRelease.cwd, ".issue560-lifecycle-release"), "release\n")
		await until(() => statusDone(daemon, lifecycle, repos.target), Boolean, "lifecycle chain item completion", 90_000)
		const consumedRows = await until(
			() => closureRows(daemon.root, lifecycle),
			(current) => current.length === 2 && current.every((row) => row.lifecycle === "consumed" && row.worktree_path === null && row.branch_name === null),
			"normal chain closure consumption",
			90_000,
		)
		assert(consumedRows.every((row) => row.worktree_path === null && row.branch_name === null), "C05 normal consume retained resource identities")
		for (const row of lifecycleRows) {
			assert(row.worktree_path !== null && row.branch_name !== null, "C05 pre-consume resource identity missing")
			assert(!existsSync(row.worktree_path) && command([REAL_GIT, "show-ref", "--verify", row.branch_name], { cwd: repos.target, allowFail: true }).exitCode !== 0, `C05 resource survived normal consume for ${row.phase}`)
		}
		const consumedLog = readFileSync(daemon.stderr, "utf8").split("\n").filter((line) => line.includes(`chain=${lifecycle}`) && line.includes("closure.consumed")).join("\n")
		assert(consumedLog.includes("evidence=no-work") && consumedLog.includes("freshness=fetched"), "C05 normal consumption did not sample branch publication and origin freshness")
		const resumed = resumedBeforeRelease
		retainedRunnerObservations.push(resumed)
		assert(resumed.attempt >= 3 && resumed.cwd === first.cwd && resumed.branch === first.branch && resumed.argv.includes(first.sessionId), "C09 daemon restart did not resume the same closure/session")
		event("C05.pass", { persistedReachabilityCases, consumed: consumedRows, observedEvidence: "no-work", observedFreshness: "fetched" })
		event("C09.pass", { first, reopened: second, resumed })

		// C06/C10: direct production manager exercise for persisted par pin and concurrent repo coordination.
		const gitEntered = resolve(runtime, "shim-state/fetch-entered"), gitRelease = resolve(runtime, "shim-state/fetch-release")
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
		const publicationResource = directResources[1]
		if (publicationResource === undefined || typeof publicationResource === "string") fail("expected publication resource")
		const publishedObservation = await sampleClosureConsumptionObservation({ repoCwd: repos.target, baseBranch: "main", branchName: publicationResource.branchName, baseCommit: publicationResource.baseCommit })
		assert(publishedObservation.evidence === "published", "C05 live origin branch publication evidence missing")
		command([REAL_GIT, "--git-dir", repos.origin, "update-ref", "-d", publicationResource.branchName])
		assert(command([REAL_GIT, "show-ref", "--verify", publicationResource.branchName.replace("refs/heads/", "refs/remotes/origin/")], { cwd: repos.target }).exitCode === 0, "C05 stale tracking fixture was not retained locally before sampling")
		const deletedPublicationObservation = await sampleClosureConsumptionObservation({ repoCwd: repos.target, baseBranch: "main", branchName: publicationResource.branchName, baseCommit: publicationResource.baseCommit })
		assert(deletedPublicationObservation.evidence === "unpublished-discarded", "C05 deleted live origin branch remained a published witness")
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
		const detachedResource = directResources[0]
		if (detachedResource === undefined || typeof detachedResource === "string") fail("expected detached cleanup resource")
		command([REAL_GIT, "switch", "-q", "--detach"], { cwd: detachedResource.worktreePath })
		writeFileSync(resolve(detachedResource.worktreePath, ".issue560-detached-wip"), "detached cleanup must preserve this file\n")
		const [detachedCleanup] = await cleanupSchedulerChainWorktrees([{ chainName: directChain.name, repoCwd: repos.target, closure: { ...contexts[0]!.existing, lifecycle: "consumed", worktreePath: detachedResource.worktreePath, branchName: detachedResource.branchName }, loopDataRootOptions: { loopDataRoot: daemon.root } }])
		assert(detachedCleanup?.error?.includes("is detached instead of registered to expected branch") === true, "C05 detached registration cleanup was not rejected")
		assert(existsSync(resolve(detachedResource.worktreePath, ".issue560-detached-wip")), "C05 detached registration cleanup removed WIP")
		assert(command([REAL_GIT, "show-ref", "--verify", detachedResource.branchName], { cwd: repos.target, allowFail: true }).exitCode === 0, "C05 detached registration cleanup removed the expected branch")
		command([REAL_GIT, "switch", "-q", detachedResource.branchName.replace(/^refs\/heads\//, "")], { cwd: detachedResource.worktreePath })
		for (let index = 0; index < directResources.length; index += 1) {
			const resource = directResources[index]!; if (typeof resource === "string") fail("expected typed direct resources")
			await cleanupSchedulerChainWorktrees([{ chainName: directChain.name, repoCwd: repos.target, closure: { ...contexts[index]!.existing, lifecycle: "consumed", worktreePath: resource.worktreePath, branchName: resource.branchName }, loopDataRootOptions: { loopDataRoot: daemon.root } }])
		}
		assert(!readFileSync(resolve(runtime, "shim-state/git.jsonl"), "utf8").includes("gc"), "C10 explicit gc observed")
		event("C05.C06.C10.pass", { pin, nestedPin, resources: directResources, addLatencies, trackingCommit, freshness: { kind: "fetched", remote: "origin", commit: trackingCommit, observedAt: new Date().toISOString() } satisfies OriginFreshness, publicationEvidence: [publishedObservation.evidence, deletedPublicationObservation.evidence], driftKinds: driftFindings.map((finding) => finding.mismatch.kind), detachedCleanupRejected: true, resourceStates: resourceStatesAfter })

		// C05/C07 cleanup recovery: deletion first seals the active chain against
		// resume, then an unavailable repository leaves only runtime cleanup retryable.
		const unavailableTarget = `${repos.target}-unavailable`
		const registrationChainRoot = resolve(daemon.root, "chains", registration)
		const registrationAttemptsBeforeDelete = observations(shims.runnerLog).filter((row) => row.chain === registration).length
		renameSync(repos.target, unavailableTarget)
		try {
			const incompleteDelete = command(["bun", LOOP_ENTRY, "chain", "delete", registration, "--loop-data-root", daemon.root, "--json"], { env, allowFail: true })
			assert(incompleteDelete.exitCode !== 0 && `${incompleteDelete.stdout}\n${incompleteDelete.stderr}`.includes("runtime_cleanup_incomplete"), "C05/C07 unavailable-repository delete did not return runtime_cleanup_incomplete")
			assert(chainStatus(daemon.root, registration) === "stopped", "C05/C07 incomplete delete did not leave the chain stopped for startup recovery")
			assert(existsSync(registrationChainRoot) && existsSync(registrationRow.worktree_path), "C05/C07 incomplete delete destroyed recovery state")
			const retainedRegistration = closureRows(daemon.root, registration).find((row) => row.closure_id === registrationRow.closure_id)
			assert(retainedRegistration?.lifecycle === "consumed" && retainedRegistration.worktree_path === registrationRow.worktree_path && retainedRegistration.branch_name === registrationRow.branch_name, "C05/C07 incomplete delete lost consumed resource identity")
			for (let index = 0; index < 3; index += 1) command(["bun", LOOP_ENTRY, "daemon", "status", repos.target, "--json", "--loop-data-root", daemon.root], { env, allowFail: true })
			assert(observations(shims.runnerLog).filter((row) => row.chain === registration).length === registrationAttemptsBeforeDelete, "C05 incomplete delete respawned the deleted chain")
		} finally {
			if (existsSync(unavailableTarget) && !existsSync(repos.target)) renameSync(unavailableTarget, repos.target)
		}
		await stopDaemon(daemon)
		daemon = startDaemon(runtime, env); await ready(daemon)
		const deletionReconcile = await until(
			() => command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--type", "closure.reconciled", "--chain", registration, "--loop-data-root", daemon.root], { env, allowFail: true }).stdout,
			(text) => text.includes("orphan-directory") && text.includes("orphan-branch"),
			"incomplete deletion restart reconciliation",
		)
		assert(!existsSync(registrationRow.worktree_path) && command([REAL_GIT, "show-ref", "--verify", "--quiet", registrationRow.branch_name], { cwd: repos.target, allowFail: true }).exitCode === 1, "C05/C07 restart reconciliation retained consumed Git residue")
		const retriedDelete = command(["bun", LOOP_ENTRY, "chain", "delete", registration, "--loop-data-root", daemon.root, "--json"], { env })
		const retriedDeleteBody = record(JSON.parse(retriedDelete.stdout), "retried chain deletion")
		assert(retriedDeleteBody.alreadyDeleted === false, "C05/C07 cleanup retry did not finalize the stopped chain")
		const consumptionLog = record(JSON.parse(command(["bun", LOOP_ENTRY, "logs", repos.target, "--json", "--type", "closure.consumed", "--chain", registration, "--loop-data-root", daemon.root], { env }).stdout), "cleanup retry consumption log")
		const consumptionRows = consumptionLog.events
		assert(Array.isArray(consumptionRows), "C05 cleanup retry consumption log did not contain an event array")
		assert(consumptionRows.length === 1, `C05 cleanup retry emitted ${consumptionRows.length} closure.consumed events instead of exactly one`)
		const consumption = record(consumptionRows[0], "cleanup retry consumption event")
		const consumptionPayload = record(consumption.payload, "cleanup retry consumption payload")
		const consumptionFreshness = record(consumptionPayload.freshness, "cleanup retry consumption freshness")
		assert(consumption.type === "closure.consumed" && consumption.chain === registration, "C05 cleanup retry emitted the wrong consumption event identity")
		assert(consumptionPayload.evidence === "unevaluable", "C05 cleanup retry did not preserve unevaluable evidence")
		assert(consumptionFreshness.kind === "no-origin" && consumptionFreshness.availability === "unavailable" && consumptionFreshness.commit === registrationRow.base_commit, "C05 cleanup retry did not preserve no-origin freshness")
		assert(chainStatus(daemon.root, registration) === "deleted" && !existsSync(registrationChainRoot), "C05/C07 delete retry did not remove the restored runtime")
		assert(command([REAL_GIT, "show-ref", "--verify", "--quiet", registrationRow.branch_name], { cwd: repos.target, allowFail: true }).exitCode === 1, "C05/C07 delete retry retained the closure branch")
		event("C05.C07.delete-retry.pass", { chain: registration, firstError: "runtime_cleanup_incomplete", firstStatus: "stopped", restartReconciliationBytes: deletionReconcile.length, retryAlreadyDeleted: false, consumptionEvents: consumptionRows.length, consumptionEvidence: "unevaluable", consumptionFreshness: { kind: "no-origin", availability: "unavailable", commit: registrationRow.base_commit }, chainRootRemoved: true })

		for (const chain of chains) deleteChain(daemon, chain)
		await stopDaemon(daemon)
		for (const repo of [repos.target, repos.noOrigin, repos.badRemote]) { const refs = command([REAL_GIT, "for-each-ref", "--format=%(refname)", "refs/heads/coder-loop/closures"], { cwd: repo }).stdout.trim(); assert(refs === "", `engine refs remain in ${repo}: ${refs}`) }
		assert(!existsSync(resolve(daemon.root, "daemon.sock")), "daemon socket remains")
		writeFileSync(resolve(evidence, "observations.json"), JSON.stringify({ id, sourceSha, runner: retainedRunnerObservations, daemon: { stdout: daemon.stdout, stderr: daemon.stderr } }, null, 2))
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
