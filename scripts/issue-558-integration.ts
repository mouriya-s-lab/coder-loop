#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type as arkType } from "arktype"

import { queryObservabilityEvents } from "../src/observability"
import { resolveChainRuntimePaths } from "../src/runtime-paths"
import { openSqliteStateStore, SqliteStateError } from "../src/sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "../src/runtime-data"
import { TaskTreeSnapshotBoundary, type TaskNodeIdentity, type TaskTreeSnapshot } from "../src/task-runtime"
import { seedCanonicalHistoricalRuntime } from "../src/issue-558-historical-fixture"

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
	writeFileSync(resolve(dir, "codex"), `#!/bin/sh\nprintf 'deterministic issue-558 runner pid=%s\\n' "$$"\ntrap 'exit 0' TERM INT\nsleep 30 & wait $!\n`)
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

type HistoricalSeed = {
	chainName: string
	chainRowId: number
	runId: string
	sessionId: string
	selectedItemRowId: number
	survivingNodeId: string
}

type IntegrationRejectionRecord = {
	operation: "same-closure-active-run" | "consumed-reactivation"
	code: SqliteStateError["code"]
	message: string
}

type IntegrationRunIdentityRecord = {
	runId: string
	closureId: string
	runtimeNodeId: string
}

type IntegrationLifecycleRecord = {
	closureId: string
	lifecycle: "active" | "suspended" | "consumed"
}

type FinalRuntimeSeed = {
	chainName: string
	auditItemRowId: number
	lifecycleRows: IntegrationLifecycleRecord[]
	siblingActiveRuns: IntegrationRunIdentityRecord[]
	conflictRejection: IntegrationRejectionRecord
	consumedRejection: IntegrationRejectionRecord
	completedRunIdentity: IntegrationRunIdentityRecord
}

function seedHistoricalRuntime(loopDataRoot: string, repo: string, schemaVersion: 13 | 14): HistoricalSeed {
	const chainName = `issue-558-v${schemaVersion}-${randomUUID()}`
	const runId = `historical-v${schemaVersion}-run`
	const sessionId = `historical-v${schemaVersion}-session`
	const seeded = seedCanonicalHistoricalRuntime({
		loopDataRoot,
		schemaVersion,
		chain: { name: chainName, repository: repo, preset: "single-phase-example" },
		items: [
			{ itemId: `historical-v${schemaVersion}`, repoCwd: repo, status: "done", phase: "iteration", preset: "gh-issue-pr-iteration", presetPath: null, agentCwd: REPO_ROOT, sessionIds: { iteration: { codex: sessionId } }, extra: { id: `historical-v${schemaVersion}` }, run: { runId, phase: "iteration", status: "in_progress", startedAt: 1_800_000_500, extra: {} } },
			{ itemId: `historical-v${schemaVersion}-survivor`, repoCwd: repo, status: "done", phase: "run", preset: "single-phase-example", presetPath: null, agentCwd: REPO_ROOT, sessionIds: {}, extra: { id: `historical-v${schemaVersion}-survivor` } },
		],
		contextEntries: schemaVersion === 14 ? [{ id: "historical-v14-context", body: "current-main-v14-context" }] : [],
	})
	if (seeded.schemaFacts.runForeignKeys.join(",") !== "chain_id->chains.id:CASCADE,item_id->items.id:CASCADE") fail(`v${schemaVersion} runs foreign keys are not canonical`)
	if (seeded.schemaFacts.currentRunForeignKeys.join(",") !== "chain_id->chains.id:CASCADE,run_id->runs.run_id:CASCADE") fail(`v${schemaVersion} current_runs foreign keys are not canonical`)
	if (seeded.schemaFacts.hasContextEntries !== (schemaVersion === 14)) fail(`v${schemaVersion} context table does not match canonical version fact`)
	const selectedItem = seeded.items[0]
	const survivingItem = seeded.items[1]
	if (selectedItem === undefined || survivingItem === undefined) fail(`v${schemaVersion} historical delete fixture omitted an item`)
	return {
		chainName,
		chainRowId: seeded.chain.id,
		runId,
		sessionId,
		selectedItemRowId: selectedItem.id,
		survivingNodeId: `legacy-v13:item:${survivingItem.id}:phase:run`,
	}
}

function seedFinalRuntime(loopDataRoot: string, repo: string): FinalRuntimeSeed {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chainName = `issue-558-${randomUUID()}`
		const chain = store.createChain({ name: chainName, preset: "single-phase-example", repository: repo, baseBranch: "main", status: "active" })
		const items = ["active", "suspended", "consumed"].map((id) => store.createItem({ chainId: chain.id, itemId: id, repoCwd: repo, status: runtimeStatus("done"), preset: "single-phase-example", extra: storedItemExtra({ id }) }))
		const definitionRef = { kind: "chain", contentIdentity: "sha256:issue-558-integration" } as const
		const leaf = (index: number, sourceParNodeId: string | null) => {
			const item = items[index]
			if (item === undefined) fail(`missing fixture item ${index}`)
			return { kind: "leaf", identity: { runtimeNodeId: `leaf-${index}`, definitionRef, definitionNodeId: `definition-leaf-${index}` }, state: "pending", closure: { closureId: `closure-${index}`, itemRowId: item.id, itemId: item.itemId, phase: "iteration", lifecycle: "active", worktreePath: repo, branchName: `issue-558-${index}`, baseCommit: "0123456789abcdef", sourceParNodeId, sessions: [] } } as const
		}
		const tree: TaskTreeSnapshot = { root: { kind: "seq", identity: { runtimeNodeId: "root", definitionRef, definitionNodeId: "definition-root" }, cursor: { kind: "next", nodeId: "leaf-0" }, children: [leaf(0, null), { kind: "par", identity: { runtimeNodeId: "par", definitionRef, definitionNodeId: "definition-par" }, groupId: "par", pinCommit: "0123456789abcdef", maxConcurrency: null, state: "open", reopen: { count: 0, budgetRef: "chain.maxReopens" }, join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } }, children: [leaf(1, "par"), leaf(2, "par")] }] }, activeRuns: [] }
		store.createTaskTree(chain.id, tree)
		const runExtra = storedItemExtra({})
		for (const [index, item] of items.entries()) store.recordRun({ runId: `run-${index}`, chainId: chain.id, itemId: item.id, phase: "iteration", startedAt: 1_800_000_000 + index, extra: runExtra })
		store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-0", startedAt: 1_800_000_000, extra: runExtra })
		store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-1", startedAt: 1_800_000_001, extra: runExtra })
		const siblingActiveRuns = store.listCurrentRuns(chain.id).map((active) => {
			const run = store.getRunByRunId(active.runId)
			if (run === null) fail(`active run ${active.runId} lost its durable row`)
			return { runId: run.runId, closureId: run.closureId, runtimeNodeId: run.runtimeNodeId }
		})
		if (siblingActiveRuns.length !== 2) fail("same-chain sibling active runs did not coexist")
		const firstItem = items[0]
		if (firstItem === undefined) fail("missing first fixture item")
		store.recordRun({ runId: "run-conflict", chainId: chain.id, itemId: firstItem.id, phase: "iteration", startedAt: 1_800_000_003, extra: runExtra })
		let conflictRejection: IntegrationRejectionRecord | null = null
		try {
			store.setCurrentRun({ chainId: chain.id, phase: "iteration", runId: "run-conflict", startedAt: 1_800_000_003, extra: runExtra })
			fail("same-closure conflict was accepted")
		} catch (error) {
			if (!(error instanceof SqliteStateError) || error.code !== "active_run_conflict") throw error
			conflictRejection = { operation: "same-closure-active-run", code: error.code, message: error.message }
		}
		if (conflictRejection === null) fail("same-closure rejection record was not captured")
		store.clearCurrentRun("run-1")
		store.setClosureLifecycle("closure-1", { kind: "suspend", updatedAt: 1_800_000_010 })
		store.setClosureLifecycle("closure-2", { kind: "consume", updatedAt: 1_800_000_011 })
		let consumedRejection: IntegrationRejectionRecord | null = null
		try {
			store.setClosureLifecycle("closure-2", { kind: "activate", updatedAt: 1_800_000_012 })
			fail("consumed reactivation was accepted")
		} catch (error) {
			if (!(error instanceof SqliteStateError) || error.code !== "closure_lifecycle_conflict") throw error
			consumedRejection = { operation: "consumed-reactivation", code: error.code, message: error.message }
		}
		if (consumedRejection === null) fail("consumed reactivation rejection record was not captured")
		store.completeRun("run-0", { endedAt: 1_800_000_020, exitCode: 0, status: runtimeStatus("done") })
		store.clearCurrentRun("run-0")
		const completed = store.getRunByRunId("run-0")
		if (completed?.closureId !== "closure-0" || completed.runtimeNodeId !== "leaf-0") fail("completed run lost durable task identity")
		const completedRunIdentity = { runId: completed.runId, closureId: completed.closureId, runtimeNodeId: completed.runtimeNodeId }
		const lifecycleTree = store.getTaskTree(chain.id)
		if (lifecycleTree?.root.kind !== "seq") fail("final runtime tree lost seq root")
		const lifecycleRows = lifecycleTree.root.children.flatMap((node) => node.kind === "leaf"
			? [{ closureId: node.closure.closureId, lifecycle: node.closure.lifecycle }]
			: node.children.map((child) => ({ closureId: child.closure.closureId, lifecycle: child.closure.lifecycle })))
		const auditItem = store.createItem({
			chainId: chain.id,
			itemId: "audit-item",
			repoCwd: repo,
			status: runtimeStatus("pending"),
			preset: "single-phase-example",
			agentCwd: REPO_ROOT,
			extra: storedItemExtra({ id: "audit-item" }),
		})
		return { chainName, auditItemRowId: auditItem.id, lifecycleRows, siblingActiveRuns, conflictRejection, consumedRejection, completedRunIdentity }
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
		let persistedDeleteCursor: string | null = null
		const migrated = openSqliteStateStore({ loopDataRoot })
		try {
			const run = migrated.getRunByRunId(seed.runId)
			if (run === null || run.closureId.length === 0 || run.runtimeNodeId.length === 0) fail(`v${schemaVersion} durable run identity was not migrated`)
			if (schemaVersion === 13) {
				const selectedTree = migrated.getTaskTree(seed.chainRowId)
				if (selectedTree?.root.kind !== "seq" || selectedTree.root.cursor.kind !== "next") fail("v13 migrated delete fixture omitted its selected seq child")
				if (!migrated.deleteItem(seed.selectedItemRowId)) fail("v13 selected migrated item was not deleted")
				const persistedTree = migrated.getTaskTree(seed.chainRowId)
				if (persistedTree?.root.kind !== "seq") fail("v13 persisted tree disappeared after selected-child delete")
				if (persistedTree.root.cursor.kind !== "next" || persistedTree.root.cursor.nodeId !== seed.survivingNodeId) fail(`v13 persisted cursor did not advance to ${seed.survivingNodeId}`)
				persistedDeleteCursor = persistedTree.root.cursor.nodeId
			}
		} finally { migrated.close() }
		if (schemaVersion === 13) {
			const advancedStatusText = command(["bun", LOOP_ENTRY, "status", repo, "--json", "--loop-data-root", loopDataRoot, "--chain", seed.chainName], { env })
			const advancedStatus = StatusBoundary.assert(JSON.parse(advancedStatusText))
			const advancedRoot = advancedStatus.taskTree.root
			if (advancedRoot.kind !== "seq" || advancedRoot.cursor.kind !== "next" || advancedRoot.cursor.nodeId !== seed.survivingNodeId) fail(`v13 status cursor did not advance to ${seed.survivingNodeId}`)
			if (advancedRoot.children.length !== 1 || advancedRoot.children[0]?.identity.runtimeNodeId !== seed.survivingNodeId) fail("v13 status retained deleted children or lost its survivor")
			log(`migratedDeleteCursor=${JSON.stringify({ schemaVersion, deletedItemRowId: seed.selectedItemRowId, survivingNodeId: seed.survivingNodeId, persistedCursor: persistedDeleteCursor, statusCursor: advancedRoot.cursor.nodeId })}`)
		}
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
	let observedRunnerPid: number | null = null
	try {
		await waitForSocket(daemon, socket)
		log(`daemonPid=${daemon.pid ?? "missing"} socket=${socket}`)
		const emitted = await waitForDaemonOwnedIdentityEvent(loopDataRoot, seeded.chainName, seeded.auditItemRowId)
		observedRunnerPid = emitted.runnerPid
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
		const runnerOutput = readFileSync(resolveChainRuntimePaths(seeded.chainName, { loopDataRoot }).runStdoutFile(emitted.runId), "utf8")
		if (!runnerOutput.includes(`deterministic issue-558 runner pid=${emitted.runnerPid}`)) fail("daemon-owned runner did not execute PATH shim")
		if (emitted.runnerPid === process.pid || emitted.runnerPid === daemon.pid) fail("runner pid was not a daemon child")
		log(`status.taskTree=${JSON.stringify(status.taskTree)}`)
		log(`lifecycleRows=${JSON.stringify(seeded.lifecycleRows)}`)
		log(`siblingActiveRuns=${JSON.stringify(seeded.siblingActiveRuns)}`)
		log(`sameClosureRejection=${JSON.stringify(seeded.conflictRejection)}`)
		log(`consumedReactivationRejection=${JSON.stringify(seeded.consumedRejection)}`)
		log(`completedRunIdentity=${JSON.stringify(seeded.completedRunIdentity)}`)
		log(`emittedIdentity=${JSON.stringify({ runId: emitted.runId, runtimeNodeId: emitted.identity.runtimeNodeId, definitionRef: emitted.identity.definitionRef, definitionNodeId: emitted.identity.definitionNodeId })}`)
		log("observed=migrated-delete-cursor,recursive-status,sibling-active-runs,conflict-rejection,consumed-rejection,durable-run-identity,event-identity")
	} finally {
		await stopDaemon(daemon, loopDataRoot, shims.env)
		removeOwnedWorktrees(repo, loopDataRoot)
		if (observedRunnerPid !== null) {
			try { process.kill(observedRunnerPid, 0); fail(`runner process remained after teardown: ${observedRunnerPid}`) } catch (error) {
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
