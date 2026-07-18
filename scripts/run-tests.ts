import { mkdir, open, readdir, rename, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SCRIPT_PATH = resolve(import.meta.path)
const RUNS_ROOT = resolve(REPO_ROOT, ".test-runs")
const BATCH_NAMES = ["unit", "integration-cli", "integration-scheduler", "integration-daemon"] as const
const INTEGRATION_BATCH_NAMES = BATCH_NAMES.slice(1)

type BatchName = (typeof BATCH_NAMES)[number]
type BatchStatus = "pending" | "running" | "passed" | "failed" | "skipped"
type RunConclusion = "running" | "passed" | "failed"

type BatchDefinition =
	| { name: "unit"; kind: "unit"; directory: "tests/unit" }
	| { name: Exclude<BatchName, "unit">; kind: "integration"; directory: string }

interface BatchState {
	name: BatchName
	status: BatchStatus
	pass: number
	fail: number
	durationMs: number | null
	files: string[]
}

interface RunState {
	runId: string
	pid: number
	mode: "foreground" | "background"
	startedAt: string
	finishedAt: string | null
	conclusion: RunConclusion
	batches: BatchState[]
}

type Command =
	| { kind: "status"; runId: string | null }
	| { kind: "run"; batches: BatchName[]; foreground: boolean; logPath: string | null }

interface TestCommandResult {
	exitCode: number
	pass: number
	fail: number
}

const BATCH_DEFINITIONS: readonly BatchDefinition[] = [
	{ name: "unit", kind: "unit", directory: "tests/unit" },
	{ name: "integration-cli", kind: "integration", directory: "tests/integration/cli" },
	{ name: "integration-scheduler", kind: "integration", directory: "tests/integration/scheduler" },
	{ name: "integration-daemon", kind: "integration", directory: "tests/integration/daemon" },
]

class BatchReporter {
	private writeChain: Promise<void> = Promise.resolve()

	private constructor(private readonly writer: FileHandle | null) {}

	static async create(logPath: string | null): Promise<BatchReporter> {
		return new BatchReporter(logPath === null ? null : await open(logPath, "a"))
	}

	write(chunk: string | Uint8Array, channel: "stdout" | "stderr" = "stdout"): Promise<void> {
		if (this.writer === null) {
			if (channel === "stderr") process.stderr.write(chunk)
			else process.stdout.write(chunk)
			return Promise.resolve()
		}
		this.writeChain = this.writeChain.then(async () => {
			if (typeof chunk === "string") await this.writer?.write(chunk)
			else await this.writer?.write(chunk)
		})
		return this.writeChain
	}

	async close(): Promise<void> {
		await this.writeChain
		await this.writer?.close()
	}
}

class UsageError extends Error {}

function usage(): string {
	return [
		"Usage:",
		"  bun scripts/run-tests.ts --batch unit [--log-file <path>] [--foreground]",
		"  bun scripts/run-tests.ts [--integration | --batch <integration-cli|integration-scheduler|integration-daemon>] --log-file <path> [--foreground]",
		"  bun scripts/run-tests.ts --status [runId]",
	].join("\n")
}

function isBatchName(value: string): value is BatchName {
	return BATCH_NAMES.some((name) => name === value)
}

function parseArguments(args: string[]): Command {
	if (args[0] === "--status") {
		if (args.length > 2) throw new UsageError(`--status accepts at most one runId\n${usage()}`)
		return { kind: "status", runId: args[1] ?? null }
	}

	let foreground = false
	let logPath: string | null = null
	let selectedBatch: BatchName | null = null
	let integrationOnly = false
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (argument === "--foreground") {
			if (foreground) throw new UsageError(`--foreground may only be provided once\n${usage()}`)
			foreground = true
			continue
		}
		if (argument === "--log-file") {
			const value = args[index + 1]
			if (value === undefined || value.length === 0 || value.startsWith("--")) {
				throw new UsageError(`Missing path after --log-file\n${usage()}`)
			}
			if (logPath !== null) throw new UsageError(`--log-file may only be provided once\n${usage()}`)
			logPath = resolve(process.cwd(), value)
			index++
			continue
		}
		if (argument === "--integration") {
			if (integrationOnly) throw new UsageError(`--integration may only be provided once\n${usage()}`)
			integrationOnly = true
			continue
		}
		if (argument === "--batch") {
			const value = args[index + 1]
			if (value === undefined || !isBatchName(value)) throw new UsageError(`Unknown or missing batch name after --batch\n${usage()}`)
			if (selectedBatch !== null) throw new UsageError(`--batch may only be provided once\n${usage()}`)
			selectedBatch = value
			index++
			continue
		}
		throw new UsageError(`Unknown argument: ${argument}\n${usage()}`)
	}
	if (integrationOnly && selectedBatch !== null) throw new UsageError(`--integration and --batch cannot be combined\n${usage()}`)
	return {
		kind: "run",
		batches: selectedBatch === null ? (integrationOnly ? [...INTEGRATION_BATCH_NAMES] : [...BATCH_NAMES]) : [selectedBatch],
		foreground,
		logPath,
	}
}

function definitionFor(name: BatchName): BatchDefinition {
	const definition = BATCH_DEFINITIONS.find((candidate) => candidate.name === name)
	if (definition === undefined) throw new Error(`Missing batch definition for ${name}`)
	return definition
}

function makeInitialState(runId: string, pid: number, mode: RunState["mode"], batches: readonly BatchName[]): RunState {
	return {
		runId,
		pid,
		mode,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		conclusion: "running",
		batches: batches.map((name) => ({ name, status: "pending", pass: 0, fail: 0, durationMs: null, files: [] })),
	}
}

function statePath(runDir: string): string {
	return resolve(runDir, "state.json")
}

async function writeState(runDir: string, state: RunState): Promise<void> {
	const path = statePath(runDir)
	const temporaryPath = `${path}.tmp-${process.pid}`
	await Bun.write(temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
	await rename(temporaryPath, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBatchStatus(value: unknown): value is BatchStatus {
	return value === "pending" || value === "running" || value === "passed" || value === "failed" || value === "skipped"
}

function isRunConclusion(value: unknown): value is RunConclusion {
	return value === "running" || value === "passed" || value === "failed"
}

function parseBatchState(value: unknown): BatchState {
	if (!isRecord(value)) throw new Error("Invalid batch state: expected object")
	const { name, status, pass, fail, durationMs, files } = value
	if (typeof name !== "string" || !isBatchName(name)) throw new Error("Invalid batch state name")
	if (!isBatchStatus(status)) throw new Error(`Invalid batch status for ${name}`)
	if (typeof pass !== "number" || typeof fail !== "number") throw new Error(`Invalid batch counts for ${name}`)
	if (durationMs !== null && typeof durationMs !== "number") throw new Error(`Invalid batch duration for ${name}`)
	if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) throw new Error(`Invalid batch files for ${name}`)
	return { name, status, pass, fail, durationMs, files }
}

function parseRunState(value: unknown): RunState {
	if (!isRecord(value)) throw new Error("Invalid run state: expected object")
	const { runId, pid, mode, startedAt, finishedAt, conclusion, batches } = value
	if (typeof runId !== "string" || typeof pid !== "number") throw new Error("Invalid run identity")
	if (mode !== "foreground" && mode !== "background") throw new Error("Invalid run mode")
	if (typeof startedAt !== "string" || (finishedAt !== null && typeof finishedAt !== "string")) throw new Error("Invalid run timestamps")
	if (!isRunConclusion(conclusion)) throw new Error("Invalid run conclusion")
	if (!Array.isArray(batches)) throw new Error("Invalid run batches")
	return { runId, pid, mode, startedAt, finishedAt, conclusion, batches: batches.map(parseBatchState) }
}

async function readState(runDir: string): Promise<RunState> {
	const value: unknown = JSON.parse(await Bun.file(statePath(runDir)).text())
	return parseRunState(value)
}

function mutableBatch(state: RunState, name: BatchName): BatchState {
	const batch = state.batches.find((candidate) => candidate.name === name)
	if (batch === undefined) throw new Error(`Run state does not contain batch ${name}`)
	return batch
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

async function discoverFiles(definition: BatchDefinition): Promise<string[]> {
	const directory = resolve(REPO_ROOT, definition.directory)
	if (!(await directoryExists(directory))) return []
	const pattern = definition.kind === "unit" ? "**/*.test.ts" : "*.integration.ts"
	const files: string[] = []
	for await (const file of new Bun.Glob(pattern).scan({ cwd: directory, onlyFiles: true })) files.push(resolve(directory, file))
	return files.sort((left, right) => left.localeCompare(right))
}

function countsFromOutput(output: string, exitCode: number): { pass: number; fail: number } {
	const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
	let pass = 0
	let fail = 0
	for (const match of plain.matchAll(/(?:^|\s)(\d+) pass\b/gm)) pass += Number.parseInt(match[1] ?? "0", 10)
	for (const match of plain.matchAll(/(?:^|\s)(\d+) fail\b/gm)) fail += Number.parseInt(match[1] ?? "0", 10)
	if (exitCode !== 0 && fail === 0) fail = 1
	return { pass, fail }
}

async function consumeStream(stream: ReadableStream<Uint8Array>, reporter: BatchReporter, channel: "stdout" | "stderr"): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let output = ""
	while (true) {
		const result = await reader.read()
		if (result.done) break
		output += decoder.decode(result.value, { stream: true })
		await reporter.write(result.value, channel)
	}
	output += decoder.decode()
	return output
}

async function runTestCommand(command: string[], reporter: BatchReporter): Promise<TestCommandResult> {
	const env = { ...process.env }
	delete env.CODER_LOOP_RUN_TESTS_RUN_ID
	const child = Bun.spawn(command, {
		cwd: REPO_ROOT,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const stdoutPromise = consumeStream(child.stdout, reporter, "stdout")
	const stderrPromise = consumeStream(child.stderr, reporter, "stderr")
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutPromise, stderrPromise])
	return { exitCode, ...countsFromOutput(`${stdout}\n${stderr}`, exitCode) }
}

async function runBatch(state: RunState, name: BatchName, runDir: string | null, reporter: BatchReporter): Promise<boolean> {
	const definition = definitionFor(name)
	const batch = mutableBatch(state, name)
	const startedAt = Date.now()
	try {
		await reporter.write(`\n[test-runner] batch ${name}\n`)
		const files = await discoverFiles(definition)
		batch.files = files.map((file) => file.slice(REPO_ROOT.length + 1))
		if (files.length === 0) {
			batch.status = "skipped"
			batch.durationMs = Date.now() - startedAt
			await reporter.write(`[test-runner] warning: ${definition.directory} is missing or has no matching test files; ${name} skipped\n`, "stderr")
			if (runDir !== null) await writeState(runDir, state)
			return true
		}

		batch.status = "running"
		if (runDir !== null) await writeState(runDir, state)
		const commands = definition.kind === "unit"
			? [[process.execPath, "test", definition.directory]]
			: files.map((file) => [process.execPath, "test", "--timeout", "30000", file])
		for (const command of commands) {
			await reporter.write(`[test-runner] command: ${command.map((part) => basename(part) === "bun" ? "bun" : part).join(" ")}\n`)
			const result = await runTestCommand(command, reporter)
			batch.pass += result.pass
			batch.fail += result.fail
			batch.durationMs = Date.now() - startedAt
			if (result.exitCode !== 0) {
				batch.status = "failed"
				if (runDir !== null) await writeState(runDir, state)
				await reporter.write(`[test-runner] batch ${name} failed (exit ${result.exitCode})\n`, "stderr")
				return false
			}
			if (runDir !== null) await writeState(runDir, state)
		}
		batch.status = "passed"
		batch.durationMs = Date.now() - startedAt
		if (runDir !== null) await writeState(runDir, state)
		await reporter.write(`[test-runner] batch ${name} passed\n`)
		return true
	} catch (error) {
		batch.status = "failed"
		batch.fail = Math.max(batch.fail, 1)
		batch.durationMs = Date.now() - startedAt
		await reporter.write(`[test-runner] batch ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`, "stderr")
		if (runDir !== null) await writeState(runDir, state)
		return false
	}
}

function formatDuration(durationMs: number | null): string {
	return durationMs === null ? "-" : `${(durationMs / 1000).toFixed(2)}s`
}

function printSummary(state: RunState): void {
	console.log("\nTest batch summary")
	for (const batch of state.batches) {
		console.log(`${batch.name}: ${batch.status}; pass=${batch.pass}; fail=${batch.fail}; duration=${formatDuration(batch.durationMs)}`)
	}
	console.log(`Overall: ${state.conclusion}`)
}

async function executeRun(state: RunState, runDir: string | null): Promise<number> {
	const reporter = await BatchReporter.create(null)
	try {
		return await executeRunWithReporter(state, runDir, reporter)
	} finally {
		await reporter.close()
	}
}

async function executeRunWithReporter(state: RunState, runDir: string | null, reporter: BatchReporter): Promise<number> {
	for (const batch of state.batches) {
		if (!(await runBatch(state, batch.name, runDir, reporter))) {
			state.conclusion = "failed"
			state.finishedAt = new Date().toISOString()
			if (runDir !== null) await writeState(runDir, state)
			if (runDir === null) printSummary(state)
			return 1
		}
	}
	state.conclusion = "passed"
	state.finishedAt = new Date().toISOString()
	if (runDir !== null) await writeState(runDir, state)
	if (runDir === null) printSummary(state)
	return 0
}

function timestampRunId(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").replace(".", "-")}-${process.pid}`
}

async function prepareLogFile(logPath: string): Promise<void> {
	await mkdir(dirname(logPath), { recursive: true })
	await Bun.write(logPath, "")
}

async function launchBackground(command: Extract<Command, { kind: "run" }>, args: string[]): Promise<number> {
	if (command.logPath === null) throw new Error("Background run is missing its log file")
	const runId = timestampRunId()
	const runDir = resolve(RUNS_ROOT, runId)
	await mkdir(RUNS_ROOT, { recursive: true })
	await mkdir(runDir, { recursive: false })
	await prepareLogFile(command.logPath)
	const logHandle = await open(command.logPath, "a")
	let child: Bun.Subprocess
	try {
		child = Bun.spawn([process.execPath, SCRIPT_PATH, ...args, "--foreground"], {
			cwd: process.cwd(),
			env: { ...process.env, CODER_LOOP_RUN_TESTS_RUN_ID: runId },
			stdin: "ignore",
			stdout: logHandle.fd,
			stderr: logHandle.fd,
			detached: true,
		})
	} finally {
		await logHandle.close()
	}
	child.unref()
	await writeState(runDir, makeInitialState(runId, child.pid, "background", command.batches))
	console.log(`pid=${child.pid} log=${command.logPath}`)
	return 0
}

async function readBackgroundState(runId: string): Promise<{ runDir: string; state: RunState }> {
	const runDir = resolveRunDirectory(runId)
	const deadline = Date.now() + 5_000
	while (!(await Bun.file(statePath(runDir)).exists())) {
		if (Date.now() >= deadline) throw new Error(`Background state was not initialized: ${statePath(runDir)}`)
		await Bun.sleep(10)
	}
	return { runDir, state: await readState(runDir) }
}

function resolveRunDirectory(runId: string): string {
	if (runId.length === 0 || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
		throw new Error(`Invalid runId: ${runId}`)
	}
	const runDir = resolve(RUNS_ROOT, runId)
	if (dirname(runDir) !== RUNS_ROOT) throw new Error(`Invalid runId: ${runId}`)
	return runDir
}

async function latestRunId(): Promise<string> {
	let entries
	try {
		entries = await readdir(RUNS_ROOT, { withFileTypes: true })
	} catch {
		throw new Error(`No background test runs found under ${RUNS_ROOT}`)
	}
	const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((left, right) => right.localeCompare(left))
	const latest = runIds[0]
	if (latest === undefined) throw new Error(`No background test runs found under ${RUNS_ROOT}`)
	return latest
}

async function showStatus(requestedRunId: string | null): Promise<number> {
	const runId = requestedRunId ?? await latestRunId()
	const state = await readState(resolveRunDirectory(runId))
	console.log(`Run ${state.runId} (pid ${state.pid}): ${state.conclusion}`)
	for (const batch of state.batches) {
		console.log(`${batch.name}: ${batch.status}; pass=${batch.pass}; fail=${batch.fail}; duration=${formatDuration(batch.durationMs)}`)
	}
	return 0
}

function summaryLine(state: RunState, logPath: string): string {
	const pass = state.batches.reduce((total, batch) => total + batch.pass, 0)
	const fail = state.batches.reduce((total, batch) => total + batch.fail, 0)
	return `Test summary: ${state.conclusion}; pass=${pass}; fail=${fail}; log=${logPath}`
}

async function initializeForegroundState(batches: readonly BatchName[]): Promise<{ runDir: string; state: RunState }> {
	const runId = timestampRunId()
	const runDir = resolve(RUNS_ROOT, runId)
	await mkdir(RUNS_ROOT, { recursive: true })
	await mkdir(runDir, { recursive: false })
	const state = makeInitialState(runId, process.pid, "foreground", batches)
	await writeState(runDir, state)
	return { runDir, state }
}

async function runLoggedForeground(command: Extract<Command, { kind: "run" }>): Promise<number> {
	if (command.logPath === null) throw new Error("Foreground logged run is missing its log file")
	const backgroundRunId = process.env.CODER_LOOP_RUN_TESTS_RUN_ID ?? null
	if (backgroundRunId === null) await prepareLogFile(command.logPath)
	const reporter = await BatchReporter.create(command.logPath)
	let state: RunState | null = null
	let runDir: string | null = null
	let exitCode = 1
	try {
		const initialized = backgroundRunId === null
			? await initializeForegroundState(command.batches)
			: await readBackgroundState(backgroundRunId)
		state = initialized.state
		runDir = initialized.runDir
		await reporter.write(`[test-runner] run ${state.runId}; mode=${state.mode}; log=${command.logPath}\n`)
		exitCode = await executeRunWithReporter(state, runDir, reporter)
		const summary = summaryLine(state, command.logPath)
		await reporter.write(`${summary}\n`)
		if (backgroundRunId === null) console.log(summary)
	} catch (error) {
		exitCode = 1
		const message = error instanceof Error ? error.message : String(error)
		await reporter.write(`[test-runner] failed: ${message}\n`, "stderr")
		if (state !== null) {
			state.conclusion = "failed"
			state.finishedAt = new Date().toISOString()
			if (runDir !== null) {
				try {
					await writeState(runDir, state)
				} catch (stateError) {
					await reporter.write(`[test-runner] failed to update state: ${stateError instanceof Error ? stateError.message : String(stateError)}\n`, "stderr")
				}
			}
		}
		const summary = state === null
			? `Test summary: failed; pass=0; fail=1; log=${command.logPath}`
			: summaryLine(state, command.logPath)
		await reporter.write(`${summary}\n`)
		if (backgroundRunId === null) console.log(summary)
	} finally {
		await reporter.write(`FINAL exit=${exitCode}\n`)
		await reporter.close()
	}
	return exitCode
}

async function main(): Promise<number> {
	const args = process.argv.slice(2)
	const command = parseArguments(args)
	if (command.kind === "status") return showStatus(command.runId)
	if (command.logPath === null && command.batches.some((batch) => batch !== "unit")) {
		throw new UsageError(`--log-file <path> is required for any run containing integration batches.\n${usage()}`)
	}
	if (command.logPath === null) {
		return executeRun(makeInitialState("foreground", process.pid, "foreground", command.batches), null)
	}
	if (!command.foreground) return launchBackground(command, args)
	return runLoggedForeground(command)
}

try {
	process.exitCode = await main()
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = error instanceof UsageError ? 2 : 1
}
