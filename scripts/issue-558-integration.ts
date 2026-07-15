#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import { attachTaskIdentityToObservabilityEvent, schedulerEventToObservabilityEvent } from "../src/daemon"
import { appendObservabilityEvent, queryObservabilityEvents } from "../src/observability"
import { openSqliteStateStore, SqliteStateError } from "../src/sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "../src/runtime-data"
import { TaskTreeSnapshotBoundary, type TaskNodeIdentity, type TaskTreeSnapshot } from "../src/task-runtime"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const StatusBoundary = arkType({ state: { kind: arkType.unit("ok") }, taskTree: TaskTreeSnapshotBoundary })
const VersionBoundary = arkType({ user_version: "number.integer" })

function fail(message: string): never { throw new Error(message) }
function log(message: string): void { process.stdout.write(`[issue-558] ${message}\n`) }
function runtimeStatus(value: string) { return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "issue-558-integration.status"), "issue-558-integration") }

function command(args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): string {
	const result = spawnSync(args[0], args.slice(1), { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
	if (result.status !== 0 && options.allowFail !== true) fail(`${args.join(" ")} exited ${result.status ?? 1}: ${result.stderr}`)
	return result.stdout
}

function writeShims(root: string): { dir: string; env: NodeJS.ProcessEnv } {
	const dir = resolve(root, "shim")
	mkdirSync(dir, { recursive: true })
	writeFileSync(resolve(dir, "coder-loop"), `#!/bin/sh\nexec bun ${LOOP_ENTRY} "$@"\n`)
	writeFileSync(resolve(dir, "codex"), "#!/bin/sh\nprintf 'deterministic issue-558 runner\\n'\n")
	chmodSync(resolve(dir, "coder-loop"), 0o755)
	chmodSync(resolve(dir, "codex"), 0o755)
	const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }
	delete env.CODER_LOOP_RUN_CRED
	delete env.CODER_LOOP_DATA_DIR
	return { dir, env }
}

function createFixtureRepo(root: string): string {
	const repo = resolve(root, "fixture")
	mkdirSync(repo, { recursive: true })
	command(["git", "init", "-b", "main"], { cwd: repo })
	writeFileSync(resolve(repo, "README.md"), "issue-558 integration fixture\n")
	command(["git", "add", "README.md"], { cwd: repo })
	command(["git", "-c", "user.name=issue-558", "-c", "user.email=issue-558@local", "commit", "-m", "chore: seed fixture"], { cwd: repo })
	return repo
}

type HistoricalSeed = { chainName: string; runId: string; sessionId: string }

function seedHistoricalRuntime(loopDataRoot: string, repo: string, schemaVersion: 13 | 14): HistoricalSeed {
	mkdirSync(loopDataRoot, { recursive: true })
	const store = openSqliteStateStore({ loopDataRoot })
	const chainName = `issue-558-v${schemaVersion}-${randomUUID()}`
	const runId = `historical-v${schemaVersion}-run`
	const sessionId = `historical-v${schemaVersion}-session`
	let chainId: number
	let itemId: number
	try {
		const chain = store.createChain({ name: chainName, repository: repo, baseBranch: "main", status: "active" })
		const item = store.createItem({ chainId: chain.id, itemId: `historical-v${schemaVersion}`, repoCwd: repo, status: runtimeStatus("done"), phase: "iteration", preset: "gh-issue-pr-iteration", agentCwd: REPO_ROOT, extra: storedItemExtra({ id: `historical-v${schemaVersion}` }) })
		if (schemaVersion === 14) store.appendContextEntry({ chainId: chain.id, scope: { kind: "chain" }, author: { kind: "operator" }, body: "current-main-v14-context" })
		chainId = chain.id
		itemId = item.id
	} finally { store.close() }
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { strict: true })
	try {
		db.exec("PRAGMA foreign_keys = OFF")
		db.exec(`CREATE TABLE runs_historical (
			id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
			chain_id INTEGER NOT NULL, item_id INTEGER NOT NULL, phase TEXT NOT NULL,
			status TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL, exit_code INTEGER, extra TEXT NOT NULL
		)`)
		db.query<never, { runId: string; chainId: number; itemId: number }>("INSERT INTO runs_historical (run_id, chain_id, item_id, phase, status, started_at, ended_at, exit_code, extra) VALUES ($runId, $chainId, $itemId, 'iteration', 'in_progress', 1800000500, NULL, NULL, '{}')").run({ runId, chainId, itemId })
		db.exec("DROP TABLE runs")
		db.exec("ALTER TABLE runs_historical RENAME TO runs")
		db.exec("ALTER TABLE items ADD COLUMN session_ids TEXT NOT NULL DEFAULT '{}'")
		db.query<never, { itemId: number; sessions: string }>("UPDATE items SET session_ids = $sessions WHERE id = $itemId").run({ itemId, sessions: JSON.stringify({ iteration: { codex: sessionId } }) })
		for (const table of ["active_runs", "closure_sessions", "task_join_evaluation_bindings", "task_join_bindings", "task_leaf_nodes", "task_seq_nodes", "task_par_nodes", "task_closures", "task_trees", "task_nodes", "execution_definitions"]) db.exec(`DROP TABLE ${table}`)
		if (schemaVersion === 13) db.exec("DROP TABLE context_entries")
		db.exec("CREATE TABLE current_runs (chain_id INTEGER PRIMARY KEY REFERENCES chains(id), phase TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), started_at REAL NOT NULL, extra TEXT NOT NULL)")
		db.query<never, { chainId: number; runId: string }>("INSERT INTO current_runs (chain_id, phase, run_id, started_at, extra) VALUES ($chainId, 'iteration', $runId, 1800000500, '{}')").run({ chainId, runId })
		db.exec(`PRAGMA user_version = ${schemaVersion}`)
	} finally { db.close() }
	return { chainName, runId, sessionId }
}

function seedFinalRuntime(loopDataRoot: string, repo: string): { chainName: string; identity: TaskNodeIdentity; completedRunId: string } {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chainName = `issue-558-${randomUUID()}`
		const chain = store.createChain({ name: chainName, repository: repo, baseBranch: "main", status: "active" })
		const items = ["active", "suspended", "consumed"].map((id) => store.createItem({ chainId: chain.id, itemId: id, repoCwd: repo, status: runtimeStatus("done"), preset: "single-phase-example", extra: storedItemExtra({ id }) }))
		const definitionRef = { kind: "chain", contentIdentity: "sha256:issue-558-integration" } as const
		const leaf = (index: number, sourceParNodeId: string | null) => {
			const item = items[index]
			if (item === undefined) fail(`missing fixture item ${index}`)
			return { kind: "leaf", identity: { runtimeNodeId: `leaf-${index}`, definitionRef, definitionNodeId: `definition-leaf-${index}` }, closure: { closureId: `closure-${index}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: repo, branchName: `issue-558-${index}`, baseCommit: "0123456789abcdef", sourceParNodeId, sessions: [] } } as const
		}
		const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "root", definitionRef, definitionNodeId: "definition-root" }, cursor: { kind: "next", nodeId: "leaf-0" }, children: [leaf(0, null), { kind: "par", identity: { runtimeNodeId: "par", definitionRef, definitionNodeId: "definition-par" }, groupId: "par", pinCommit: "0123456789abcdef", state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(1, "par"), leaf(2, "par")] }] }, activeRuns: [] }
		store.createTaskTree(chain.id, tree)
		const runExtra = storedItemExtra({})
		for (const [index, item] of items.entries()) store.recordRun({ runId: `run-${index}`, chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_000 + index, extra: runExtra })
		store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-0", startedAt: 1_800_000_000, extra: runExtra })
		store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-1", startedAt: 1_800_000_001, extra: runExtra })
		if (store.listCurrentRuns(chain.id).length !== 2) fail("same-chain sibling active runs did not coexist")
		const firstItem = items[0]
		if (firstItem === undefined) fail("missing first fixture item")
		store.recordRun({ runId: "run-conflict", chainId: chain.id, itemId: firstItem.id, phase: "iteration", startedAt: 1_800_000_003, extra: runExtra })
		try {
			store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-conflict", startedAt: 1_800_000_003, extra: runExtra })
			fail("same-closure conflict was accepted")
		} catch (error) { if (!(error instanceof SqliteStateError) || error.code !== "active_run_conflict") throw error }
		store.clearCurrentRun("run-1")
		store.setClosureLifecycle("closure-1", { kind: "suspend", updatedAt: 1_800_000_010 })
		store.setClosureLifecycle("closure-2", { kind: "consume", updatedAt: 1_800_000_011 })
		try {
			store.setClosureLifecycle("closure-2", { kind: "activate", updatedAt: 1_800_000_012 })
			fail("consumed reactivation was accepted")
		} catch (error) { if (!(error instanceof SqliteStateError) || error.code !== "closure_lifecycle_conflict") throw error }
		store.completeRun("run-0", { endedAt: 1_800_000_020, exitCode: 0, status: runtimeStatus("done") })
		store.clearCurrentRun("run-0")
		const completed = store.getRunByRunId("run-0")
		if (completed?.closureId !== "closure-0" || completed.runtimeNodeId !== "leaf-0") fail("completed run lost durable task identity")
		const firstNode = tree.root.children[0]
		if (firstNode === undefined) fail("missing first fixture node")
		return { chainName, identity: firstNode.identity, completedRunId: completed.runId }
	} finally { store.close() }
}

function userVersion(loopDataRoot: string): number {
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true })
	try { return VersionBoundary.assert(db.query("PRAGMA user_version").get()).user_version } finally { db.close() }
}

async function stopDaemon(child: ChildProcess, loopDataRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
	command(["bun", LOOP_ENTRY, "daemon", "down", "--loop-data-root", loopDataRoot], { env, allowFail: true })
	const deadline = Date.now() + 10_000
	while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50)
	if (child.exitCode === null) child.kill("SIGKILL")
	if (existsSync(resolve(loopDataRoot, "daemon.sock"))) fail(`daemon socket remained after teardown: ${loopDataRoot}`)
}

async function migrateHistoricalRuntime(root: string, loopDataRoot: string, repo: string, schemaVersion: 13 | 14, env: NodeJS.ProcessEnv): Promise<void> {
	const seed = seedHistoricalRuntime(loopDataRoot, repo, schemaVersion)
	log(`preSchemaV${schemaVersion}=${userVersion(loopDataRoot)}`)
	const stdoutFd = openSync(resolve(root, `daemon-v${schemaVersion}.stdout.log`), "a")
	const stderrFd = openSync(resolve(root, `daemon-v${schemaVersion}.stderr.log`), "a")
	const daemon = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], { cwd: REPO_ROOT, env, stdio: ["ignore", stdoutFd, stderrFd] })
	closeSync(stdoutFd); closeSync(stderrFd)
	try {
		await waitForSocket(daemon, resolve(loopDataRoot, "daemon.sock"))
		await waitForMigration(daemon, loopDataRoot)
		const statusText = command(["bun", LOOP_ENTRY, "status", repo, "--json", "--loop-data-root", loopDataRoot, "--chain", seed.chainName], { env })
		const status = StatusBoundary.assert(JSON.parse(statusText))
		if (!JSON.stringify(status.taskTree).includes(seed.sessionId)) fail(`v${schemaVersion} session was not migrated`)
		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			const run = migrated.getRunByRunId(seed.runId)
			if (run === null || run.closureId.length === 0 || run.runtimeNodeId.length === 0) fail(`v${schemaVersion} durable run identity was not migrated`)
		} finally { migrated.close() }
		if (schemaVersion === 14) {
			const migrated = openSqliteStateStore({ loopDataRoot })
			try {
				const chain = migrated.getChainByName(seed.chainName)
				if (chain === null || migrated.listContextEntries(chain.id).map((entry) => entry.body).join(",") !== "current-main-v14-context") fail("v14 context was not preserved")
			} finally { migrated.close() }
		}
		log(`postSchemaV${schemaVersion}=${userVersion(loopDataRoot)}`)
	} finally { await stopDaemon(daemon, loopDataRoot, env) }
}

async function waitForSocket(child: ChildProcess, socket: string): Promise<void> {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (existsSync(socket) && statSync(socket).isSocket()) return
		if (child.exitCode !== null) fail(`daemon exited before readiness: ${child.exitCode}`)
		await Bun.sleep(50)
	}
	fail("daemon socket did not become ready")
}

async function waitForMigration(child: ChildProcess, loopDataRoot: string): Promise<void> {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (userVersion(loopDataRoot) === 16) return
		if (child.exitCode !== null) fail(`daemon exited during migration: ${child.exitCode}`)
		await Bun.sleep(50)
	}
	fail("daemon did not finish schema migration")
}

async function main(): Promise<void> {
	const candidateSha = command(["git", "rev-parse", "HEAD"]).trim()
	const root = resolve(REPO_ROOT, ".coder-loop/runtime/issue-558-integration", randomUUID())
	const loopDataRoot = resolve(root, "final-loop-data")
	mkdirSync(loopDataRoot, { recursive: true })
	const repo = createFixtureRepo(root)
	const shims = writeShims(root)
	await migrateHistoricalRuntime(root, resolve(root, "v13-loop-data"), repo, 13, shims.env)
	await migrateHistoricalRuntime(root, resolve(root, "v14-loop-data"), repo, 14, shims.env)
	const seeded = seedFinalRuntime(loopDataRoot, repo)
	log(`candidateSha=${candidateSha}`)
	log(`finalSchema=${userVersion(loopDataRoot)}`)
	const stdoutFd = openSync(resolve(root, "daemon.stdout.log"), "a")
	const stderrFd = openSync(resolve(root, "daemon.stderr.log"), "a")
	const daemon = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot], { cwd: REPO_ROOT, env: shims.env, stdio: ["ignore", stdoutFd, stderrFd] })
	closeSync(stdoutFd); closeSync(stderrFd)
	const socket = resolve(loopDataRoot, "daemon.sock")
	try {
		await waitForSocket(daemon, socket)
		log(`daemonPid=${daemon.pid ?? "missing"} socket=${socket}`)
		const runner = spawn("codex", ["--deterministic"], { cwd: REPO_ROOT, env: shims.env, stdio: "ignore" })
		await new Promise<void>((resolveExit, reject) => { runner.once("exit", () => resolveExit()); runner.once("error", reject) })
		const statusText = command(["bun", LOOP_ENTRY, "status", repo, "--json", "--loop-data-root", loopDataRoot, "--chain", seeded.chainName], { env: shims.env })
		const status = StatusBoundary.assert(JSON.parse(statusText))
		const rootNode = status.taskTree.root
		if (rootNode.kind !== "seq" || rootNode.children[1]?.kind !== "par") fail("status did not preserve seq(leaf, par(leaf, leaf))")
		const lifecycles = JSON.stringify(status.taskTree).match(/active|suspended|consumed/g) ?? []
		if (!lifecycles.includes("active") || !lifecycles.includes("suspended") || !lifecycles.includes("consumed")) fail("status omitted a closure lifecycle")
		const eventStore = openSqliteStateStore({ loopDataRoot })
		const chain = eventStore.getChainByName(seeded.chainName)
		eventStore.close()
		if (chain === null) fail("fixture chain disappeared")
		const baseEvent = schedulerEventToObservabilityEvent(chain, { type: "phase.end", ts: new Date(0).toISOString(), runId: seeded.completedRunId, chainId: chain.id, itemId: 1, phase: "iteration", exitCode: 0, durationSeconds: 1, status: runtimeStatus("done") })
		await appendObservabilityEvent(resolve(loopDataRoot, "events", "events.jsonl"), attachTaskIdentityToObservabilityEvent(baseEvent, seeded.identity))
		const events = await queryObservabilityEvents(resolve(loopDataRoot, "events", "events.jsonl"), { run: seeded.completedRunId })
		const identityEvent = events.events.find((event) => event.runtimeNodeId === seeded.identity.runtimeNodeId)
		if (identityEvent?.definitionNodeId !== seeded.identity.definitionNodeId || identityEvent.definitionRef?.contentIdentity !== seeded.identity.definitionRef.contentIdentity) fail("emitted event identity does not match persisted/status identity")
		log("observed=recursive-status,sibling-active-runs,conflict-rejection,consumed-rejection,durable-run-identity,event-identity")
	} finally {
		await stopDaemon(daemon, loopDataRoot, shims.env)
		const worktrees = command(["git", "worktree", "list", "--porcelain"], { cwd: repo })
		if (worktrees.includes(resolve(loopDataRoot, "chains"))) fail("temporary worktree registration remained")
		rmSync(root, { recursive: true, force: true })
	}
	log("cleanup=daemon,runner,socket,worktrees removed")
}

if (import.meta.main) main().catch((error: unknown) => { process.stderr.write(`issue-558-integration: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) })
