#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { closeSync, existsSync, openSync } from "node:fs"
import { resolve } from "node:path"

import { type as arkType } from "arktype"

import { parseObservabilityEvent, type ObservabilityEvent } from "../src/observability"
import { resolveChainRuntimePaths, resolveLoopDataPaths } from "../src/runtime-paths"
import { openSqliteStateStore, type CurrentRunRecord, type ItemRecord, type RunRecord } from "../src/sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const HELP = `Usage: bun scripts/external-terminal-integration.ts

Runs one isolated real daemon/CLI/SQLite lifecycle and asserts:
  missing-binary  accepted item, durable hold, one warning, zero spawn artifacts
  endpoint-69     typed endpoint-unavailable hold with zero scheduling side effects
  restoration     hold clears once and reaches typed invocation-pending without HAPI spawn
  probe-failed    unexpected-exit, signal, and deadline-exceeded remain typed failures
  evidence        prints per-transition status/log/SQLite/process snapshots before teardown
`

const AvailabilityBoundary = arkType.or(
	{ kind: arkType.unit("available"), checkedAt: "string" },
	{ kind: arkType.unit("unavailable"), reason: arkType.or(arkType.unit("binary-missing"), arkType.unit("endpoint-unavailable")), exitCode: "number|null", signal: "string|null", checkedAt: "string", since: "string" },
	{ kind: arkType.unit("probe-failed"), reason: arkType.or(arkType.unit("unexpected-exit"), arkType.unit("signal"), arkType.unit("deadline-exceeded")), exitCode: "number|null", signal: "string|null", checkedAt: "string", since: "string" },
)
const HoldBoundary = arkType({
	kind: arkType.unit("external-terminal-unavailable"),
	chainId: "number",
	rowId: "number",
	itemId: "string",
	phase: "string",
	runner: arkType.unit("hapi"),
	availability: AvailabilityBoundary,
})
const StatusBoundary = arkType({
	queue: { holds: HoldBoundary.array() },
	current: { run: "object|null" },
	runs: { total: "number" },
})
const LogsBoundary = arkType({ events: "object[]" })

type StatusSnapshot = typeof StatusBoundary.infer

type CommandResult = { stdout: string; stderr: string; exitCode: number }
type DaemonHandle = {
	child: ChildProcess
	loopDataRoot: string
	socketPath: string
	stdoutPath: string
	stderrPath: string
	env: NodeJS.ProcessEnv
}

type Harness = {
	workDir: string
	fixtureCwd: string
	presetDir: string
	shimDir: string
	binaryPath: string
	probeStatePath: string
	probeLogPath: string
	terminalCommitPath: string
	terminalReleasePath: string
	daemon: DaemonHandle
	runnerPids: Set<number>
}

type RunnerScenario = {
	mode: "loss" | "terminal"
	chainName: string
	itemId: string
}


type TransitionSqliteEvidence = {
	item: ItemRecord | null
	runs: RunRecord[]
	current: CurrentRunRecord | null
}

type TransitionProcessEvidence = {
	daemon: { pid: number | null; alive: boolean }
	runners: { pid: number; alive: boolean }[]
}

type TransitionEvidence = {
	transition: string
	chainName: string
	status: StatusSnapshot
	logs: ObservabilityEvent[]
	sqlite: TransitionSqliteEvidence
	processes: TransitionProcessEvidence
}

function log(message: string): void {
	process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

function invariant(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function sanitizedEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...parent }
	delete env.CODER_LOOP_RUN_CRED
	delete env.CODER_LOOP_DATA_DIR
	return env
}

function command(cmd: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): CommandResult {
	const child = spawnSync(cmd[0]!, cmd.slice(1), {
		cwd: options.cwd ?? REPO_ROOT,
		env: options.env ?? sanitizedEnvironment(process.env),
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	})
	const result = { stdout: child.stdout ?? "", stderr: child.stderr ?? "", exitCode: child.status ?? 1 }
	if (result.exitCode !== 0 && options.allowFailure !== true) {
		throw new Error(`command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n${result.stderr || result.stdout}`)
	}
	return result
}

function cli(harness: Harness, args: readonly string[], allowFailure = false): CommandResult {
	return command(["bun", LOOP_ENTRY, ...args, "--loop-data-root", harness.daemon.loopDataRoot, "--json"], {
		env: harness.daemon.env,
		allowFailure,
	})
}

async function waitFor<T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let last = await read()
	while (Date.now() < deadline) {
		if (accept(last)) {
			log(`wait: ${label} ready`)
			return last
		}
		await Bun.sleep(100)
		last = await read()
	}
	throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`)
}

async function prepareFixture(workDir: string): Promise<string> {
	const fixtureCwd = resolve(workDir, "fixture")
	await mkdir(fixtureCwd, { recursive: true })
	command(["git", "init", "-b", "main"], { cwd: fixtureCwd })
	await writeFile(resolve(fixtureCwd, "README.md"), "external-terminal integration fixture\n")
	command(["git", "add", "README.md"], { cwd: fixtureCwd })
	command(["git", "-c", "user.name=external-terminal-integration", "-c", "user.email=harness@local.invalid", "commit", "-m", "chore: seed fixture"], { cwd: fixtureCwd })
	return fixtureCwd
}

async function preparePreset(workDir: string): Promise<string> {
	const presetDir = resolve(workDir, "preset")
	await mkdir(presetDir, { recursive: true })
	await writeFile(resolve(presetDir, "preset.toml"), `name = "external-terminal-integration"

[item]
idField = "id"

[statuses]
continuable = ["pending"]
terminal = ["done", "exhausted"]
success = ["done"]
exhausted = "exhausted"

[[phases]]
name = "iteration"
prompt = "iteration-entry.md"
runner = "hapi"

  [[phases.exits]]
  status = "done"
  when = "The deterministic fixture completes."

[agent]
attemptTimeoutSeconds = 120
`)
	await writeFile(resolve(presetDir, "iteration-entry.md"), "Exercise the deterministic external-terminal lifecycle.\n")
	return presetDir
}

async function prepareShim(workDir: string): Promise<{ shimDir: string; binaryPath: string }> {
	const shimDir = resolve(workDir, "bin")
	await mkdir(shimDir, { recursive: true })
	const coderLoop = resolve(shimDir, "coder-loop")
	await writeFile(coderLoop, `#!/bin/sh\nexec bun ${shellLiteral(LOOP_ENTRY)} "$@"\n`)
	await chmod(coderLoop, 0o755)
	return { shimDir, binaryPath: resolve(shimDir, "hapi-remote-session") }
}

function shellLiteral(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function writeRunner(harness: Harness, scenario: RunnerScenario): Promise<void> {
	const script = `#!/bin/sh
set -eu
PROBE_STATE=${shellLiteral(harness.probeStatePath)}
PROBE_LOG=${shellLiteral(harness.probeLogPath)}
TERMINAL_COMMIT=${shellLiteral(harness.terminalCommitPath)}
TERMINAL_RELEASE=${shellLiteral(harness.terminalReleasePath)}
MODE=${shellLiteral(scenario.mode)}
CHAIN=${shellLiteral(scenario.chainName)}
ITEM=${shellLiteral(scenario.itemId)}
INVOCATION_LOG=runner-invocations.log
POST_REVOKE=post-revoke.json
LOOP_ENTRY=${shellLiteral(LOOP_ENTRY)}
LOOP_ROOT=${shellLiteral(harness.daemon.loopDataRoot)}

if [ "\${1:-}" = probe ]; then
	state=$(cat "$PROBE_STATE")
	printf 'probe state=%s pid=%s\n' "$state" "$$" >> "$PROBE_LOG"
	case "$state" in
		0) exit 0 ;;
		69) exit 69 ;;
		2) exit 2 ;;
		signal) kill -TERM $$; sleep 1; exit 3 ;;
		deadline) sleep 60; exit 0 ;;
		*) exit 4 ;;
	esac
fi

printf 'spawn pid=%s credential_present=%s mode=%s\n' "$$" "\${CODER_LOOP_RUN_CRED:+true}" "$MODE" >> "$INVOCATION_LOG"
if [ "$MODE" = terminal ]; then
	while [ ! -f "$TERMINAL_COMMIT" ]; do sleep 0.1; done
	bun "$LOOP_ENTRY" item update "$CHAIN" --issue "$ITEM" --status done --loop-data-root "$LOOP_ROOT" --json >> "$INVOCATION_LOG" 2>&1
	while [ ! -f "$TERMINAL_RELEASE" ]; do sleep 0.1; done
	exit 0
fi
trap 'printf "term pid=%s\\n" "$$" >> "$INVOCATION_LOG"; bun "$LOOP_ENTRY" item update "$CHAIN" --issue "$ITEM" --status done --loop-data-root "$LOOP_ROOT" --json > "$POST_REVOKE" 2>&1 || true' TERM
while :; do sleep 1 || true; done
`
	await writeFile(harness.binaryPath, script)
	await chmod(harness.binaryPath, 0o755)
}


async function startDaemon(workDir: string, shimDir: string): Promise<DaemonHandle> {
	const loopDataRoot = resolve(workDir, "loop-data")
	await mkdir(loopDataRoot, { recursive: true })
	const stdoutPath = resolve(workDir, "daemon.stdout.log")
	const stderrPath = resolve(workDir, "daemon.stderr.log")
	const stdoutFd = openSync(stdoutPath, "a")
	const stderrFd = openSync(stderrPath, "a")
	const env = {
		...sanitizedEnvironment(process.env),
		PATH: `${shimDir}:${process.env.PATH ?? ""}`,
	}
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100", "--json"], {
		cwd: REPO_ROOT,
		env,
		stdio: ["ignore", stdoutFd, stderrFd],
	})
	closeSync(stdoutFd)
	closeSync(stderrFd)
	const socketPath = resolveLoopDataPaths({ loopDataRoot }).daemonSocket
	const daemon = { child, loopDataRoot, socketPath, stdoutPath, stderrPath, env }
	await waitFor("isolated daemon socket", () => existsSync(socketPath), Boolean, 15_000)
	log(`readiness: daemon pid=${child.pid ?? "unknown"} socket=${socketPath} loop-data=${loopDataRoot}`)
	return daemon
}

async function stopDaemon(daemon: DaemonHandle): Promise<void> {
	if (daemon.child.exitCode === null) {
		command(["bun", LOOP_ENTRY, "daemon", "down", "--loop-data-root", daemon.loopDataRoot, "--json"], { env: daemon.env, allowFailure: true })
		await waitFor("daemon process exit", () => daemon.child.exitCode, (code) => code !== null, 15_000).catch(() => null)
	}
	if (daemon.child.exitCode === null) {
		daemon.child.kill("SIGTERM")
		await Bun.sleep(1_000)
	}
	if (daemon.child.exitCode === null) daemon.child.kill("SIGKILL")
}

function readStatus(harness: Harness, chainName: string): StatusSnapshot {
	const result = cli(harness, ["status", harness.fixtureCwd, "--chain", chainName])
	return StatusBoundary.assert(JSON.parse(result.stdout))
}

function readEvents(harness: Harness, chainName: string): ObservabilityEvent[] {
	const result = cli(harness, ["logs", harness.fixtureCwd, "--chain", chainName])
	const envelope = LogsBoundary.assert(JSON.parse(result.stdout))
	return envelope.events.map((event) => parseObservabilityEvent(event))
}

function createChain(harness: Harness, chainName: string): void {
	cli(harness, [
		"chain", "create", chainName,
		"--config-json", JSON.stringify({ repository: "external-terminal/local", baseBranch: "main", presetPath: harness.presetDir }),
		"--preset", "single-phase-example",
		"--force",
	])
}

function addItem(harness: Harness, chainName: string, itemId: string): void {
	cli(harness, [
		"item", "add", chainName,
		"--issue", itemId,
		"--repo-cwd", harness.fixtureCwd,
		"--preset-path", harness.presetDir,
		"--runner", "hapi",
	])
}

function stopChain(harness: Harness, chainName: string): void {
	cli(harness, ["chain", "stop", chainName])
}

function storeRead<T>(harness: Harness, read: (store: ReturnType<typeof openSqliteStateStore>) => T): T {
	const store = openSqliteStateStore({ loopDataRoot: harness.daemon.loopDataRoot, createIfMissing: false })
	try {
		return read(store)
	} finally {
		store.close()
	}
}

function chainId(harness: Harness, chainName: string): number {
	const id = storeRead(harness, (store) => store.getChainByName(chainName)?.id ?? null)
	invariant(id !== null, `chain ${chainName} missing from SQLite`)
	return id
}

async function assertNoSpawnArtifacts(harness: Harness, chainName: string): Promise<void> {
	const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: harness.daemon.loopDataRoot })
	const worktreesDir = resolve(paths.chainRoot, "worktrees")
	const worktrees = existsSync(worktreesDir) ? await readdir(worktreesDir) : []
	const runArtifacts = existsSync(paths.runsDir) ? await readdir(paths.runsDir) : []
	invariant(worktrees.length === 0, `missing-binary created worktree artifacts: ${worktrees.join(",")}`)
	invariant(runArtifacts.length === 0, `missing-binary created run artifacts: ${runArtifacts.join(",")}`)
}

function externalWarnings(events: readonly ObservabilityEvent[]): Extract<ObservabilityEvent, { type: "daemon.warning" }>[] {
	return events.filter((event): event is Extract<ObservabilityEvent, { type: "daemon.warning" }> =>
		event.type === "daemon.warning" && "code" in event.payload && event.payload.code === "external_terminal_unavailable")
}

function restorationEvents(events: readonly ObservabilityEvent[]): Extract<ObservabilityEvent, { type: "runner.availability_restored" }>[] {
	return events.filter((event): event is Extract<ObservabilityEvent, { type: "runner.availability_restored" }> => event.type === "runner.availability_restored")
}

function hasBackoff(events: readonly ObservabilityEvent[]): boolean {
	return events.some((event) => event.type === "item.backoff" || event.type === "spawn.aborted")
}

function retainTransitionEvidence(harness: Harness, transition: string, chainName: string, itemId: string): void {
	const id = chainId(harness, chainName)
	const sqlite = storeRead(harness, (store): TransitionSqliteEvidence => ({
		item: store.getItemById(id, itemId),
		runs: store.listRuns(id),
		current: store.getCurrentRun(id),
	}))
	const daemonPid = harness.daemon.child.pid ?? null
	const evidence: TransitionEvidence = {
		transition,
		chainName,
		status: readStatus(harness, chainName),
		logs: readEvents(harness, chainName),
		sqlite,
		processes: {
			daemon: { pid: daemonPid, alive: daemonPid !== null && processExists(daemonPid) },
			runners: [...harness.runnerPids].map((pid) => ({ pid, alive: processExists(pid) })),
		},
	}
	log(`evidence ${JSON.stringify(evidence)}`)
}


async function scenarioProbeFailure(harness: Harness, scenario: "unexpected-exit" | "signal" | "deadline-exceeded"): Promise<void> {
	const state = scenario === "unexpected-exit" ? "2" : scenario === "signal" ? "signal" : "deadline"
	const chainName = `external-${scenario}-${randomUUID()}`
	const itemId = scenario
	await writeFile(harness.probeStatePath, state)
	createChain(harness, chainName)
	addItem(harness, chainName, itemId)
	const timeoutMs = scenario === "deadline-exceeded" ? 40_000 : 15_000
	const status = await waitFor(`${scenario} hold`, () => readStatus(harness, chainName), (value) => value.queue.holds.length === 1, timeoutMs)
	const hold = status.queue.holds[0]
	invariant(hold?.availability.kind === "probe-failed" && hold.availability.reason === scenario, `${scenario} decoded as ${JSON.stringify(hold?.availability)}`)
	invariant(status.runs.total === 0 && status.current.run === null, `${scenario} crossed the pre-run gate`)
	const id = chainId(harness, chainName)
	const item = storeRead(harness, (store) => store.getItemById(id, itemId))
	invariant(item !== null && item.attempts === 0 && item.lastRunId === null, `${scenario} changed attempts/run identity`)
	invariant(!hasBackoff(readEvents(harness, chainName)), `${scenario} emitted spawn-failure backoff`)
	await assertNoSpawnArtifacts(harness, chainName)
	retainTransitionEvidence(harness, `probe-failed/${scenario}`, chainName, itemId)
	log(`scenario probe-failed/${scenario}: typed hold, zero run/current/attempt/backoff passed`)
	stopChain(harness, chainName)
}

async function scenarioEndpointUnavailable(harness: Harness): Promise<void> {
	const chainName = `external-endpoint-unavailable-${randomUUID()}`
	const itemId = "endpoint-unavailable"
	await writeFile(harness.probeStatePath, "69")
	createChain(harness, chainName)
	addItem(harness, chainName, itemId)
	const status = await waitFor("endpoint-unavailable hold", () => readStatus(harness, chainName), (value) => value.queue.holds.length === 1)
	const hold = status.queue.holds[0]
	invariant(hold?.availability.kind === "unavailable" && hold.availability.reason === "endpoint-unavailable" && hold.availability.exitCode === 69, `exit 69 decoded as ${JSON.stringify(hold?.availability)}`)
	invariant(status.runs.total === 0 && status.current.run === null, "endpoint-unavailable crossed the pre-run gate")
	const id = chainId(harness, chainName)
	const item = storeRead(harness, (store) => store.getItemById(id, itemId))
	invariant(item !== null && item.attempts === 0 && item.lastRunId === null && item.agentCwd === null, `endpoint-unavailable changed scheduling identity: ${JSON.stringify(item)}`)
	const events = readEvents(harness, chainName)
	invariant(externalWarnings(events).length === 1 && !hasBackoff(events), "endpoint-unavailable warning/backoff mismatch")
	await assertNoSpawnArtifacts(harness, chainName)
	retainTransitionEvidence(harness, "endpoint-unavailable/exit-69", chainName, itemId)
	log("scenario endpoint-unavailable/exit-69: typed hold and warning with zero run/current/worktree/attempt/backoff/process side effects")
	stopChain(harness, chainName)
}

async function scenarioAvailabilityPending(harness: Harness): Promise<void> {
	const chainName = `external-pending-${randomUUID()}`
	const itemId = "invocation-pending"
	await rm(harness.binaryPath, { force: true })
	createChain(harness, chainName)
	addItem(harness, chainName, itemId)
	const id = chainId(harness, chainName)
	const missing = await waitFor("missing-binary hold", () => readStatus(harness, chainName), (status) => status.queue.holds.length === 1)
	invariant(missing.queue.holds[0]?.availability.kind === "unavailable" && missing.queue.holds[0]?.availability.reason === "binary-missing", `unexpected missing hold: ${JSON.stringify(missing.queue.holds)}`)
	invariant(missing.runs.total === 0 && missing.current.run === null, "missing-binary created run/current-run")
	await assertNoSpawnArtifacts(harness, chainName)
	const missingEvents = readEvents(harness, chainName)
	invariant(externalWarnings(missingEvents).length === 1 && !hasBackoff(missingEvents), "missing-binary warning/backoff mismatch")
	retainTransitionEvidence(harness, "missing-binary", chainName, itemId)
	log("scenario missing-binary: durable hold and one typed warning with zero scheduling side effects")

	await writeRunner(harness, { mode: "loss", chainName, itemId })
	await writeFile(harness.probeStatePath, "0")
	const pendingEvent = await waitFor("invocation-pending diagnostic", () => readEvents(harness, chainName), (events) => events.some((event) => event.type === "runner.invocation_pending"))
	invariant(pendingEvent !== null, "available endpoint did not reach invocation-pending gate")
	const restored = readStatus(harness, chainName)
	invariant(restored.queue.holds.length === 0, "restoration retained endpoint-absence hold")
	invariant(restorationEvents(readEvents(harness, chainName)).length === 1, "restoration transition count was not one")
	const item = storeRead(harness, (store) => store.getItemById(id, itemId))
	invariant(item !== null && item.attempts === 0 && item.lastRunId === null && item.agentCwd === null, `invocation-pending crossed a scheduling side effect: ${JSON.stringify(item)}`)
	invariant(storeRead(harness, (store) => store.listRuns(id).length) === 0 && storeRead(harness, (store) => store.getCurrentRun(id)) === null, "invocation-pending created run/current-run")
	await assertNoSpawnArtifacts(harness, chainName)
	retainTransitionEvidence(harness, "restoration/invocation-pending", chainName, itemId)
	log("scenario restoration/invocation-pending: hold cleared once; typed pending gate kept run/worktree/attempt/credential/session/artifact/process counts at zero")
	stopChain(harness, chainName)
}


function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH")
	}
}

async function assertCleanup(harness: Harness): Promise<void> {
	invariant(harness.daemon.child.exitCode !== null, "isolated daemon process remained alive")
	invariant(!existsSync(harness.daemon.socketPath), `isolated daemon socket remained: ${harness.daemon.socketPath}`)
	for (const pid of harness.runnerPids) invariant(!processExists(pid), `owned runner process remained alive: ${pid}`)
	const beforeCleanup = command(["git", "worktree", "list", "--porcelain"], { cwd: harness.fixtureCwd }).stdout
	for (const line of beforeCleanup.split("\n")) {
		if (!line.startsWith("worktree ")) continue
		const path = line.slice("worktree ".length)
		if (path === harness.fixtureCwd) continue
		command(["git", "worktree", "remove", "--force", path], { cwd: harness.fixtureCwd })
	}
	command(["git", "worktree", "prune"], { cwd: harness.fixtureCwd })
	const worktrees = command(["git", "worktree", "list", "--porcelain"], { cwd: harness.fixtureCwd }).stdout
	const registered = worktrees.split("\n\n").filter((block) => block.trim().startsWith("worktree "))
	invariant(registered.length === 1, `owned worktree registrations remained:\n${worktrees}`)
	log("cleanup: daemon/socket/runners/worktrees absent; run credentials were revoked before runner termination")
}

async function buildHarness(): Promise<Harness> {
	const workDir = resolve(REPO_ROOT, ".coder-loop/runtime/external-terminal-integration", randomUUID())
	await mkdir(workDir, { recursive: true })
	const fixtureCwd = await prepareFixture(workDir)
	const presetDir = await preparePreset(workDir)
	const shim = await prepareShim(workDir)
	const daemon = await startDaemon(workDir, shim.shimDir)
	return {
		workDir,
		fixtureCwd,
		presetDir,
		shimDir: shim.shimDir,
		binaryPath: shim.binaryPath,
		probeStatePath: resolve(workDir, "probe-state"),
		probeLogPath: resolve(workDir, "probe.log"),
		terminalCommitPath: resolve(workDir, "terminal-commit"),
		terminalReleasePath: resolve(workDir, "terminal-release"),
		daemon,
		runnerPids: new Set(),
	}
}

async function main(): Promise<void> {
	if (process.argv.slice(2).includes("--help")) {
		process.stdout.write(HELP)
		return
	}
	const harness = await buildHarness()
	let failed = true
	try {
		log(`external-terminal-integration: start root=${harness.workDir}`)
		await scenarioAvailabilityPending(harness)
		await scenarioEndpointUnavailable(harness)
		await scenarioProbeFailure(harness, "unexpected-exit")
		await scenarioProbeFailure(harness, "signal")
		await scenarioProbeFailure(harness, "deadline-exceeded")
		failed = false
	} finally {
		await stopDaemon(harness.daemon)
		try {
			await assertCleanup(harness)
		} finally {
			await rm(harness.workDir, { recursive: true, force: true })
		}
	}
	if (!failed) log("external-terminal-integration: PASS missing-binary endpoint-unavailable probe-failed restoration invocation-pending zero-hapi-spawn evidence-retained")
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		const message = error instanceof Error ? error.stack ?? error.message : String(error)
		process.stderr.write(`external-terminal-integration: FAIL\n${message}\n`)
		process.exit(1)
	}
}
