import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

export const LOOP_DATA_ROOT_ENV = "CODER_LOOP_DATA_DIR"
export const LOOP_DATA_DIRNAME = "loop-data"
export const LOOP_DATA_DB_FILENAME = "db.sqlite"
export const LOOP_DATA_DAEMON_SOCKET_FILENAME = "daemon.sock"
export const LOOP_DATA_DAEMON_PID_FILENAME = "daemon.pid"
export const LOOP_DATA_CHAINS_DIRNAME = "chains"

export const CHAIN_SHARED_FILENAME = "shared.md"
export const CHAIN_ISSUES_DIRNAME = "issues"
export const CHAIN_EVIDENCE_DIRNAME = "evidence"
export const CHAIN_RUNS_DIRNAME = "runs"
export const CHAIN_DAEMON_DIRNAME = "daemon"
export const RUN_EVENTS_FILENAME = "events.jsonl"
export const RUN_STDOUT_FILENAME = "stdout.log"
export const RUN_STDERR_FILENAME = "stderr.log"
export const RUN_STATUS_FILENAME = "status.json"
export const PHASE_STDOUT_FILENAME = "stdout.jsonl"
export const PHASE_STDERR_FILENAME = "stderr.txt"
export const PHASE_STATUS_FILENAME = "status.json"
export const PHASE_SESSIONS_FILENAME = "sessions.jsonl"
export const DAEMON_LOG_FILENAME = "daemon.log"
const MAX_PATH_COMPONENT_LENGTH = 255

export type RuntimePathErrorCode = "invalid_loop_data_root" | "invalid_chain_name" | "invalid_path_component"

export class RuntimePathError extends Error {
	constructor(
		readonly code: RuntimePathErrorCode,
		message: string,
		readonly input: string,
	) {
		super(message)
		this.name = "RuntimePathError"
	}
}

export type LoopDataRootOptions = {
	loopDataRoot?: string | null
	env?: Record<string, string | undefined>
	homeDir?: string
}

export type LoopDataPaths = {
	root: string
	dbFile: string
	daemonSocket: string
	daemonPid: string
	chainsDir: string
}

export type ChainRuntimePaths = {
	chainName: string
	chainRoot: string
	sharedFile: string
	issuesDir: string
	evidenceDir: string
	runsDir: string
	daemonDir: string
	issueFile: (issueNumber: number | string) => string
	issueEvidenceDir: (issueNumber: number | string) => string
	runDir: (runId: string) => string
	runEventsFile: (runId: string) => string
	runStdoutFile: (runId: string) => string
	runStderrFile: (runId: string) => string
	runStatusFile: (runId: string) => string
	runPhaseDir: (runId: string, phase: string) => string
	runPhaseStdoutFile: (runId: string, phase: string) => string
	runPhaseStderrFile: (runId: string, phase: string) => string
	runPhaseStatusFile: (runId: string, phase: string) => string
	runPhaseSessionsFile: (runId: string, phase: string) => string
	daemonBatchDir: (timestamp: string) => string
	daemonLogFile: (timestamp: string) => string
}

export function defaultLoopDataRoot(home = homedir()): string {
	return resolve(home, ".coder-loop", LOOP_DATA_DIRNAME)
}

export function resolveLoopDataRoot(options: LoopDataRootOptions = {}): string {
	const env = options.env ?? process.env
	const rawRoot = options.loopDataRoot ?? env[LOOP_DATA_ROOT_ENV] ?? defaultLoopDataRoot(options.homeDir)
	const root = rawRoot.trim()

	if (root === "") {
		throw new RuntimePathError("invalid_loop_data_root", "loop-data root must not be empty", rawRoot)
	}
	if (!isAbsolute(root)) {
		throw new RuntimePathError("invalid_loop_data_root", `loop-data root must be an absolute path: ${root}`, rawRoot)
	}

	return root
}

export function resolveLoopDataPaths(options: LoopDataRootOptions = {}): LoopDataPaths {
	const root = resolveLoopDataRoot(options)
	return {
		root,
		dbFile: resolve(root, LOOP_DATA_DB_FILENAME),
		daemonSocket: resolve(root, LOOP_DATA_DAEMON_SOCKET_FILENAME),
		daemonPid: resolve(root, LOOP_DATA_DAEMON_PID_FILENAME),
		chainsDir: resolve(root, LOOP_DATA_CHAINS_DIRNAME),
	}
}

export function sanitizeChainName(input: string): string {
	if (input.trim() === "") {
		throw new RuntimePathError("invalid_chain_name", "chain name must not be empty", input)
	}
	if (input.length > MAX_PATH_COMPONENT_LENGTH) {
		throw new RuntimePathError("invalid_chain_name", `chain name must be at most ${MAX_PATH_COMPONENT_LENGTH} characters`, input)
	}
	if (input === "." || input.includes("..")) {
		throw new RuntimePathError("invalid_chain_name", `chain name must not be a reserved path segment: ${input}`, input)
	}
	if (isAbsolute(input)) {
		throw new RuntimePathError("invalid_chain_name", `chain name must not be an absolute path: ${input}`, input)
	}
	if (!/^[A-Za-z0-9._-]+$/.test(input)) {
		throw new RuntimePathError(
			"invalid_chain_name",
			"chain name may only contain ASCII letters, digits, dot, hyphen, and underscore",
			input,
		)
	}
	return input
}

export function resolveChainRuntimePaths(chainName: string, options: LoopDataRootOptions = {}): ChainRuntimePaths {
	const loopData = resolveLoopDataPaths(options)
	const sanitizedName = sanitizeChainName(chainName)
	const chainRoot = resolve(loopData.chainsDir, sanitizedName)
	const issuesDir = resolve(chainRoot, CHAIN_ISSUES_DIRNAME)
	const evidenceDir = resolve(chainRoot, CHAIN_EVIDENCE_DIRNAME)
	const runsDir = resolve(chainRoot, CHAIN_RUNS_DIRNAME)
	const daemonDir = resolve(chainRoot, CHAIN_DAEMON_DIRNAME)

	const runDir = (runId: string) => resolve(runsDir, sanitizePathComponent(runId, "run id"))
	const runPhaseDir = (runId: string, phase: string) => resolve(runDir(runId), sanitizePathComponent(phase, "phase"))

	return {
		chainName: sanitizedName,
		chainRoot,
		sharedFile: resolve(chainRoot, CHAIN_SHARED_FILENAME),
		issuesDir,
		evidenceDir,
		runsDir,
		daemonDir,
		issueFile: (issueNumber) => resolve(issuesDir, `${sanitizePathComponent(String(issueNumber), "issue number")}.md`),
		issueEvidenceDir: (issueNumber) => resolve(evidenceDir, sanitizePathComponent(String(issueNumber), "issue number")),
		runDir,
		runEventsFile: (runId) => resolve(runDir(runId), RUN_EVENTS_FILENAME),
		runStdoutFile: (runId) => resolve(runDir(runId), RUN_STDOUT_FILENAME),
		runStderrFile: (runId) => resolve(runDir(runId), RUN_STDERR_FILENAME),
		runStatusFile: (runId) => resolve(runDir(runId), RUN_STATUS_FILENAME),
		runPhaseDir,
		runPhaseStdoutFile: (runId, phase) => resolve(runPhaseDir(runId, phase), PHASE_STDOUT_FILENAME),
		runPhaseStderrFile: (runId, phase) => resolve(runPhaseDir(runId, phase), PHASE_STDERR_FILENAME),
		runPhaseStatusFile: (runId, phase) => resolve(runPhaseDir(runId, phase), PHASE_STATUS_FILENAME),
		runPhaseSessionsFile: (runId, phase) => resolve(runPhaseDir(runId, phase), PHASE_SESSIONS_FILENAME),
		daemonBatchDir: (timestamp) => resolve(daemonDir, sanitizePathComponent(timestamp, "daemon timestamp")),
		daemonLogFile: (timestamp) => resolve(daemonDir, sanitizePathComponent(timestamp, "daemon timestamp"), DAEMON_LOG_FILENAME),
	}
}

function sanitizePathComponent(input: string, label: string): string {
	if (input.length > MAX_PATH_COMPONENT_LENGTH) {
		throw new RuntimePathError("invalid_path_component", `${label} must be at most ${MAX_PATH_COMPONENT_LENGTH} characters`, input)
	}
	if (input.trim() === "" || input === "." || input.includes("..") || isAbsolute(input) || !/^[A-Za-z0-9._-]+$/.test(input)) {
		throw new RuntimePathError("invalid_path_component", `${label} is not a safe path component: ${input}`, input)
	}
	return input
}
