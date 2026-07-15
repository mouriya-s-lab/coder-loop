#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import { queryObservabilityEvents } from "../src/observability"
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
	const runnerPidFile = resolve(root, "runner.pid")
	mkdirSync(dir, { recursive: true })
	writeFileSync(resolve(dir, "coder-loop"), `#!/bin/sh\nexec bun ${LOOP_ENTRY} "$@"\n`)
	writeFileSync(resolve(dir, "codex"), `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(runnerPidFile)}\nprintf 'deterministic issue-558 runner\\n'\ntrap 'exit 0' TERM INT\nsleep 30 & wait $!\n`)
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

const CANONICAL_V13_SCHEMA_SQL = `
CREATE TABLE chains (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	preset TEXT,
	repository TEXT NOT NULL,
	base_branch TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'deleted', 'stopped')),
	metadata TEXT NOT NULL,
	created_at REAL NOT NULL,
	updated_at REAL NOT NULL
);
CREATE TABLE items (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	item_id TEXT NOT NULL,
	repo_cwd TEXT NOT NULL,
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	title TEXT,
	priority TEXT,
	last_run_id TEXT,
	session_ids TEXT NOT NULL DEFAULT '{}',
	issue_file TEXT,
	evidence_dir TEXT,
	agent_cwd TEXT,
	runner TEXT CHECK (runner IN ('claude', 'codex', 'opencode') OR runner IS NULL),
	phase TEXT,
	preset TEXT,
	preset_path TEXT,
	extra TEXT NOT NULL,
	created_at REAL NOT NULL,
	updated_at REAL NOT NULL,
	status_updated_at REAL NOT NULL,
	UNIQUE (chain_id, item_id)
);
CREATE TABLE runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL UNIQUE,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	status TEXT NOT NULL,
	started_at REAL NOT NULL,
	ended_at REAL,
	exit_code INTEGER,
	extra TEXT NOT NULL
);
CREATE TABLE current_runs (
	chain_id INTEGER PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
	phase TEXT NOT NULL,
	run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
	started_at REAL NOT NULL,
	extra TEXT NOT NULL
);
CREATE INDEX idx_items_chain_status ON items(chain_id, status);
CREATE INDEX idx_runs_chain_item ON runs(chain_id, item_id);
CREATE INDEX idx_items_next_pending ON items(chain_id, repo_cwd, status, position, id);
CREATE INDEX idx_runs_chain_phase_status ON runs(chain_id, phase, status);
`

const CANONICAL_V14_CONTEXT_SCHEMA_SQL = `
CREATE TABLE context_entries (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
	created_at REAL NOT NULL,
	scope_kind TEXT NOT NULL CHECK (scope_kind IN ('chain','item','group')),
	scope_key TEXT,
	author TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX idx_context_entries_chain_cursor ON context_entries(chain_id, created_at, id);
`

type ForeignKeyRow = { table: string; from: string; to: string; on_delete: string }

function assertCanonicalHistoricalSchema(loopDataRoot: string, schemaVersion: 13 | 14): void {
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true, strict: true })
	try {
		const runForeignKeys = db.query<ForeignKeyRow, []>("PRAGMA foreign_key_list(runs)").all()
		const currentRunForeignKeys = db.query<ForeignKeyRow, []>("PRAGMA foreign_key_list(current_runs)").all()
		if (!runForeignKeys.some((row) => row.table === "chains" && row.from === "chain_id" && row.to === "id" && row.on_delete === "CASCADE")) fail(`v${schemaVersion} runs.chain_id is not the canonical cascading FK`)
		if (!runForeignKeys.some((row) => row.table === "items" && row.from === "item_id" && row.to === "id" && row.on_delete === "CASCADE")) fail(`v${schemaVersion} runs.item_id is not the canonical cascading FK`)
		if (!currentRunForeignKeys.some((row) => row.table === "chains" && row.from === "chain_id" && row.to === "id" && row.on_delete === "CASCADE")) fail(`v${schemaVersion} current_runs.chain_id is not the canonical cascading FK`)
		if (!currentRunForeignKeys.some((row) => row.table === "runs" && row.from === "run_id" && row.to === "run_id" && row.on_delete === "CASCADE")) fail(`v${schemaVersion} current_runs.run_id is not the canonical cascading FK`)
		const contextCount = db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='context_entries'").get()?.count ?? 0
		if (contextCount !== (schemaVersion === 14 ? 1 : 0)) fail(`v${schemaVersion} context table does not match canonical version fact`)
	} finally { db.close() }
}

function seedHistoricalRuntime(loopDataRoot: string, repo: string, schemaVersion: 13 | 14): HistoricalSeed {
	mkdirSync(loopDataRoot, { recursive: true })
	const chainName = `issue-558-v${schemaVersion}-${randomUUID()}`
	const runId = `historical-v${schemaVersion}-run`
	const sessionId = `historical-v${schemaVersion}-session`
	const db = new Database(resolve(loopDataRoot, "db.sqlite"), { create: true, readwrite: true, strict: true })
	try {
		db.exec("PRAGMA foreign_keys = ON")
		db.exec(CANONICAL_V13_SCHEMA_SQL)
		if (schemaVersion === 14) db.exec(CANONICAL_V14_CONTEXT_SCHEMA_SQL)
		db.query<never, { chainName: string; repo: string }>(`INSERT INTO chains (id, name, preset, repository, base_branch, status, metadata, created_at, updated_at)
			VALUES (1, $chainName, 'single-phase-example', $repo, 'main', 'active', '{}', 1800000000, 1800000000)`).run({ chainName, repo })
		db.query<never, { itemId: string; repo: string; sessions: string; agentCwd: string; extra: string }>(`INSERT INTO items (
			id, chain_id, item_id, repo_cwd, status, attempts, position, title, priority, last_run_id, session_ids,
			issue_file, evidence_dir, agent_cwd, runner, phase, preset, preset_path, extra, created_at, updated_at, status_updated_at
		) VALUES (
			1, 1, $itemId, $repo, 'done', 1, 0, 'historical migration item', NULL, $runId, $sessions,
			NULL, NULL, $agentCwd, NULL, 'iteration', 'gh-issue-pr-iteration', NULL, $extra, 1800000000, 1800000000, 1800000000
		)`).run({ itemId: `historical-v${schemaVersion}`, repo, runId, sessions: JSON.stringify({ iteration: { codex: sessionId } }), agentCwd: REPO_ROOT, extra: JSON.stringify({ id: `historical-v${schemaVersion}` }) })
		db.query<never, { runId: string }>("INSERT INTO runs (id, run_id, chain_id, item_id, phase, status, started_at, ended_at, exit_code, extra) VALUES (1, $runId, 1, 1, 'iteration', 'in_progress', 1800000500, NULL, NULL, '{}')").run({ runId })
		db.query<never, { runId: string }>("INSERT INTO current_runs (chain_id, phase, run_id, started_at, extra) VALUES (1, 'iteration', $runId, 1800000500, '{}')").run({ runId })
		if (schemaVersion === 14) db.exec(`INSERT INTO context_entries (id, chain_id, created_at, scope_kind, scope_key, author, body)
			VALUES ('historical-v14-context', 1, 1800000600, 'chain', NULL, '{"kind":"operator"}', 'current-main-v14-context')`)
		db.exec(`PRAGMA user_version = ${schemaVersion}`)
	} finally { db.close() }
	return { chainName, runId, sessionId }
}

function seedFinalRuntime(loopDataRoot: string, repo: string): { chainName: string; auditItemRowId: number } {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chainName = `issue-558-${randomUUID()}`
		const chain = store.createChain({ name: chainName, preset: "single-phase-example", repository: repo, baseBranch: "main", status: "active" })
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
		const auditItem = store.createItem({
			chainId: chain.id,
			itemId: "audit-item",
			repoCwd: repo,
			status: runtimeStatus("pending"),
			preset: "single-phase-example",
			agentCwd: REPO_ROOT,
			extra: storedItemExtra({ id: "audit-item" }),
		})
		return { chainName, auditItemRowId: auditItem.id }
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

function removeOwnedWorktrees(repo: string, loopDataRoot: string): void {
	const ownedRoot = resolve(loopDataRoot, "chains")
	const worktrees = command(["git", "worktree", "list", "--porcelain"], { cwd: repo })
	for (const line of worktrees.split("\n")) {
		if (!line.startsWith("worktree ")) continue
		const path = line.slice("worktree ".length)
		if (path.startsWith(`${ownedRoot}/`)) command(["git", "worktree", "remove", "--force", path], { cwd: repo })
	}
	command(["git", "worktree", "prune"], { cwd: repo })
}

async function migrateHistoricalRuntime(root: string, loopDataRoot: string, repo: string, schemaVersion: 13 | 14, env: NodeJS.ProcessEnv): Promise<void> {
	const seed = seedHistoricalRuntime(loopDataRoot, repo, schemaVersion)
	assertCanonicalHistoricalSchema(loopDataRoot, schemaVersion)
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

async function waitForDaemonOwnedIdentityEvent(loopDataRoot: string, chainName: string, itemRowId: number): Promise<{ runId: string; identity: TaskNodeIdentity; runnerPid: number }> {
	const deadline = Date.now() + 15_000
	const eventsFile = resolve(loopDataRoot, "events", "events.jsonl")
	while (Date.now() < deadline) {
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.getChainByName(chainName)
			if (chain === null) fail("fixture chain disappeared")
			const run = store.listRuns(chain.id).find((candidate) => candidate.itemId === itemRowId)
			if (run !== undefined) {
				const events = await queryObservabilityEvents(eventsFile, { run: run.runId })
				const event = events.events.find((candidate) => candidate.type === "phase.start")
				if (event !== undefined && event.runtimeNodeId !== undefined && event.definitionRef !== undefined && event.definitionNodeId !== undefined) {
					const pid = event.payload.pid
					if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) fail("daemon phase.start event omitted runner pid")
					return {
						runId: run.runId,
						identity: { runtimeNodeId: event.runtimeNodeId, definitionRef: event.definitionRef, definitionNodeId: event.definitionNodeId },
						runnerPid: pid,
					}
				}
			}
		} finally { store.close() }
		await Bun.sleep(50)
	}
	fail("daemon did not emit an identity-bearing phase.start event")
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
		const emitted = await waitForDaemonOwnedIdentityEvent(loopDataRoot, seeded.chainName, seeded.auditItemRowId)
		if (emitted.identity.definitionNodeId !== "task:run") fail(`daemon event used non-canonical definition node ${emitted.identity.definitionNodeId}`)
		const statusText = command(["bun", LOOP_ENTRY, "status", repo, "--json", "--loop-data-root", loopDataRoot, "--chain", seeded.chainName], { env: shims.env })
		const status = StatusBoundary.assert(JSON.parse(statusText))
		const rootNode = status.taskTree.root
		if (rootNode.kind !== "seq" || rootNode.children[1]?.kind !== "par") fail("status did not preserve seq(leaf, par(leaf, leaf))")
		const lifecycles = JSON.stringify(status.taskTree).match(/active|suspended|consumed/g) ?? []
		if (!lifecycles.includes("active") || !lifecycles.includes("suspended") || !lifecycles.includes("consumed")) fail("status omitted a closure lifecycle")
		const auditLeaf = rootNode.children.find((node) => node.kind === "leaf" && node.closure.itemRowId === seeded.auditItemRowId)
		if (auditLeaf?.kind !== "leaf") fail("status omitted daemon-spawned audit closure")
		if (JSON.stringify(auditLeaf.identity) !== JSON.stringify(emitted.identity)) fail("daemon event identity does not match persisted/status identity")
		if (!existsSync(resolve(root, "runner.pid"))) fail("daemon-owned runner did not execute PATH shim")
		if (emitted.runnerPid === process.pid || emitted.runnerPid === daemon.pid) fail("runner pid was not a daemon child")
		log("observed=recursive-status,sibling-active-runs,conflict-rejection,consumed-rejection,durable-run-identity,event-identity")
	} finally {
		await stopDaemon(daemon, loopDataRoot, shims.env)
		removeOwnedWorktrees(repo, loopDataRoot)
		const runnerPidText = existsSync(resolve(root, "runner.pid")) ? readFileSync(resolve(root, "runner.pid"), "utf8").trim() : ""
		const runnerPid = Number.parseInt(runnerPidText, 10)
		if (Number.isInteger(runnerPid)) {
			try { process.kill(runnerPid, 0); fail(`runner process remained after teardown: ${runnerPid}`) } catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
			}
		}
		const worktrees = command(["git", "worktree", "list", "--porcelain"], { cwd: repo })
		if (worktrees.includes(resolve(loopDataRoot, "chains"))) fail("temporary worktree registration remained")
		rmSync(root, { recursive: true, force: true })
	}
	log("cleanup=daemon,runner,socket,worktrees removed")
}

if (import.meta.main) main().catch((error: unknown) => { process.stderr.write(`issue-558-integration: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) })
