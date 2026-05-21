#!/usr/bin/env bun
/**
 * coder-loop — stateful issue queue, stateless agents.
 *
 * The orchestrator owns scheduling only:
 *   state queue → fresh iteration agent → trace → fresh review agent → repeat
 *
 * Review is mandatory after every iteration and owns acceptance/retry/stop.
 */

import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { closeSync, createWriteStream, existsSync, openSync, realpathSync, type WriteStream } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { command, flag, option, optional, positional, run as runCmd, string as cmdString, subcommands } from "cmd-ts"
import { type as arkType } from "arktype"
import {
	daemonDefaults,
	sendDaemonRequest,
	startDaemonServer,
	type DaemonRequest,
	type DaemonResponse,
	type DaemonServerOptions,
} from "./daemon"
import { dispatchSubcommand } from "./install-commands"
import { chainRuntimePaths, defaultChainNameForTarget, ensureChainRuntimeSkeleton, loopDataRootPaths, runRuntimePaths, type ChainRuntimePaths } from "./runtime-paths"
import { defaultMigratedChainName, migrateStateJson, type StateJsonMigrationResult } from "./state-migration"
import { openStateDb, openStateStore, type Chain, type Item, type ItemPatch, type NewItem, type StateStore } from "./state-db"
import {
	extractRateLimitErrorCodeFromEvent,
	extractRateLimitReset,
	formatRateLimitNotice,
	isRateLimitErrorCode,
	type RateLimitReset,
} from "./rate-limit"

export { extractRateLimitReset, formatRateLimitNotice, parseRateLimitNoticeLine } from "./rate-limit"

const PKG_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const PRESET_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const DEFAULT_CONFIG_FILE = ".coder-loop/runtime/config.json"
const DEFAULT_CONFIG_FILE_TOML = ".coder-loop/runtime/config.toml"
const DEFAULT_WORKFLOW_FILE = ".coder-loop/workflow.md"
const DEFAULT_SHARED_FILE = ".coder-loop/runtime/shared.md"
const DEFAULT_STATE_FILE = ".coder-loop/runtime/state.json"
const DEFAULT_ISSUE_DIR = ".coder-loop/runtime/issues"
const DEFAULT_EVIDENCE_DIR = ".coder-loop/runtime/evidence"
const REVIEW_ON_EMPTY_LOCK_FILE = "review-on-empty.lock"
const DEFAULT_IDLE_SLEEP_MS = 60_000
const DEFAULT_ITERATION_RUNNER: AgentRunnerKind = "codex"
export const CLAUDE_REVIEW_MODEL = "claude-opus-4-7"
export const DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 60 * 60
export const ATTEMPT_TIMEOUT_KILL_MS = 5 * 1000

const EXCLUDE_ENTRIES = [".coder-loop/runtime"]

let logStream: WriteStream | null = null

type AgentLabel = string
class CoderLoopError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CoderLoopError"
	}
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type QueueItem = {
	status: string
	attempts: number | null
	title: string | null
	priority: string | null
	branch: string | null
	pr: number | null
	lastRunId: string | null
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string | null
	runner: AgentRunnerKind | null
	extra: JsonObject
}

export type CurrentRun = {
	phase: string
	runId: string
	startedAt: string
	extra: JsonObject
}

export type LoopState = {
	version: number
	queue: QueueItem[]
	repository: string | null
	baseBranch: string | null
	recentRuns: JsonValue[]
	current: CurrentRun | null
}

export type RuntimeStateSource =
	| { kind: "file"; statePath: string }
	| { kind: "chain-db"; dbPath: string; chainName: string; chainPaths: ChainRuntimePaths }

type RuntimeStateReadResult =
	| { kind: "ok"; value: LoopState; source: RuntimeStateSource }
	| { kind: "missing"; message: string; statePath: string }
	| { kind: "invalid"; message: string; statePath: string }

type RawArgs = {
	maxIterations: number | null
	targetCwd: string | null
	configPath: string | null
	workflowPath: string | null
	statePath: string | null
	repository: string | null
	chainName: string | null
	requireBrowserEvidence: boolean | null
	once: boolean
	dryRun: boolean
	checkRuntime: boolean
	worktree: boolean
	baseBranch: string | null
}

export type StatusCommandArgs = {
	targetCwd: string
	configPath: string | null
	repository: string | null
	output: "json"
}

type DaemonTargetIpcOptions = {
	socketPath: string | null
	pidPath: string | null
	dbPath: string | null
	rootDir: string | null
	schedulerIntervalMs: number | null
	spawnAgents: boolean
}

export type DaemonCommandArgs =
	| {
			action: "status"
			targetCwd: string
			configPath: string | null
			repository: string | null
			output: "json"
			ipc: DaemonTargetIpcOptions
		}
	| {
			action: "start"
			targetCwd: string
			configPath: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
			worktree: boolean
			baseBranch: string | null
			ipc: DaemonTargetIpcOptions
		}
	| {
			action: "stop"
			targetCwd: string
			configPath: string | null
			repository: string | null
			dryRun: boolean
			ipc: DaemonTargetIpcOptions
		}
	| {
			action: "restart"
			targetCwd: string
			configPath: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
			worktree: boolean
			baseBranch: string | null
			ipc: DaemonTargetIpcOptions
		}

export type QueueUnblockCommandArgs = {
	targetCwd: string
	configPath: string | null
	repository: string | null
	issue: string
	startDaemon: boolean
	requireBrowserEvidence: boolean
	dryRun: boolean
}

type LoopConfig = {
	repository: string | null
	baseBranch: string | null
	worktree: boolean | null
	workflowFile: string | null
	sharedContextFile: string | null
	stateFile: string | null
	issueDir: string | null
	evidenceDir: string | null
	logDir: string | null
	requireAgentBrowserScreenshots: boolean | null
	defaultRunner: AgentRunnerKind | null
	reviewRunner: AgentRunnerKind | null
	claudeBinary: string | null
	claudeExtraArgs: string[]
	claudeModel: string | null
	codexBinary: string | null
	codexExtraArgs: string[]
	codexModel: string | null
	preset: string | null
	presetPath: string | null
}

const AgentRunnerKindBoundary = arkType.or(arkType.unit("claude"), arkType.unit("codex"))

const StatusConfigBoundary = arkType({
	"repository?": "string|null",
	"baseBranch?": "string|null",
	"worktree?": "boolean|null",
	"workflowFile?": "string|null",
	"sharedContextFile?": "string|null",
	"stateFile?": "string|null",
	"issueDir?": "string|null",
	"evidenceDir?": "string|null",
	"logDir?": "string|null",
	"evidence?": {
		"requireAgentBrowserScreenshots?": "boolean|null",
	},
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"reviewRunner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"claude?": {
		"binary?": "string|null",
		"extraArgs?": "string[]",
		"model?": "string|null",
	},
	"codex?": {
		"binary?": "string|null",
		"extraArgs?": "string[]",
		"model?": "string|null",
	},
	"preset?": arkType.or("string", { name: "string" }, "null"),
	"presetPath?": "string|null",
})

type StatusConfigInput = typeof StatusConfigBoundary.infer

const StatusStateBoundary = arkType({
	version: "number",
	queue: "object[]",
	"repository?": "string|null",
	"baseBranch?": "string|null",
	"recentRuns?": "unknown[]",
	"current?": "object|null",
})

const RateLimitResetBoundary = arkType({
	resetsAt: "number",
	resetAtIso: "string",
	"rateLimitType": "string|null",
})

const TerminatedBoundary = arkType.or(
	{ kind: arkType.unit("clean") },
	{ kind: arkType.unit("signal"), name: "string" },
	{ kind: arkType.unit("error"), code: "string", "rateLimit?": RateLimitResetBoundary },
	{ kind: arkType.unit("watchdog"), phase: arkType.or(arkType.unit("term"), arkType.unit("kill")), afterSummarySeconds: "number" },
	{ kind: arkType.unit("timeout"), phase: arkType.or(arkType.unit("term"), arkType.unit("kill")), attemptSeconds: "number" },
)

const AgentRunStatusBoundary = arkType({
	label: "string",
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"model?": "string|null",
	"pid": "number|null",
	startedAt: "string",
	lastEventAt: "string",
	outputPath: "string",
	statusPath: "string",
	bytesWritten: "number",
	promptChars: "number",
	"lastStream": arkType.or(arkType.unit("stdout"), arkType.unit("stderr"), "null"),
	"exitCode": "number|null",
	"signal": "string|null",
	"error": "string|null",
	"sessionId": "string|null",
	"terminated": arkType.or(TerminatedBoundary, "null"),
})

type AgentRunStatusInput = typeof AgentRunStatusBoundary.infer

const SessionEntryBoundary = arkType({
	attempt: "string",
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"model?": "string|null",
	sessionId: "string|null",
	exitCode: "number|null",
	signal: "string|null",
	terminated: TerminatedBoundary,
	log: "string",
})

const QueueItemBaseBoundary = arkType({
	status: "string",
	"attempts?": "number|null",
	"title?": "string|null",
	"priority?": "string|null",
	"branch?": "string|null",
	"pr?": "number|null",
	"lastRunId?": "string|null",
	"issueFile?": "string|null",
	"evidenceDir?": "string|null",
	"agentCwd?": "string|null",
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
})

const QUEUE_ITEM_BASE_KEYS = new Set([
	"status", "attempts", "title", "priority", "branch", "pr",
	"lastRunId", "issueFile", "evidenceDir", "agentCwd", "runner",
])

const CurrentRunBaseBoundary = arkType({
	phase: "string",
	runId: "string",
	startedAt: "string",
})

const CURRENT_RUN_BASE_KEYS = new Set(["phase", "runId", "startedAt"])

const PresetPhaseTriggerBoundary = arkType({
	afterPhase: "string",
	whenStatus: "string",
})

const PresetPhaseBoundary = arkType({
	name: "string",
	prompt: "string",
	"variables?": "object",
	"trigger?": PresetPhaseTriggerBoundary,
})

const PresetFragmentBoundary = arkType({
	id: "string",
	role: "string",
	path: "string",
})

const PresetTomlBoundary = arkType({
	name: "string",
	version: "number",
	"description?": "string",
	item: { idField: "string" },
	statuses: { continuable: "string[]", terminal: "string[]" },
	phases: PresetPhaseBoundary.array(),
	"fragments?": PresetFragmentBoundary.array(),
	agent: { binary: "string", "extraArgs?": "string[]", "attemptTimeoutSeconds?": "number" },
})

const CONFIG_BINDING_FIELDS = ["repository", "baseBranch", "requireBrowserEvidence"] as const
type ConfigBindingField = typeof CONFIG_BINDING_FIELDS[number]

function isConfigBindingField(field: string): field is ConfigBindingField {
	return (CONFIG_BINDING_FIELDS as readonly string[]).includes(field)
}

const StatusSnapshotBoundary = arkType({
	target: "object",
	state: "object",
	queue: "object",
	current: "object",
	events: "object",
	processes: "object",
})

export type LoopOptions = {
	targetCwd: string
	configPath: string
	workflowPath: string
	sharedContextPath: string
	statePath: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	loopFile: string
	traceFile: string
	logFile: string
	chainName: string
	chainNameExplicit: boolean
	repository: string | null
	baseBranch: string | null
	worktree: boolean
	requireBrowserEvidence: boolean
	hostRunner: AgentRunnerKind
	defaultRunner: AgentRunnerSelection
	reviewRunner: AgentRunnerSelection
	runnerCommands: AgentRunnerCommands
	maxIterations: number
	dryRun: boolean
	checkRuntime: boolean
	preset: Preset
}

export type PresetVariableSource =
	| { kind: "item"; field: string }
	| { kind: "config"; field: string }
	| { kind: "runtime"; key: string }

export type PresetPhase = {
	name: string
	prompt: string
	variables: ReadonlyArray<readonly [string, PresetVariableSource]>
	trigger: PresetPhaseTrigger | null
}

export type PresetFragment = {
	id: string
	role: string
	path: string
}

export type Preset = {
	name: string
	version: number
	description: string
	presetDir: string
	item: { idField: string }
	statuses: {
		continuable: readonly string[]
		terminal: readonly string[]
	}
	phases: readonly PresetPhase[]
	fragments: readonly PresetFragment[]
	agent: {
		binary: string
		extraArgs: readonly string[]
		attemptTimeoutSeconds: number
	}
}

export type PresetPhaseTrigger = {
	afterPhase: string
	whenStatus: string
}

export type AgentRunnerKind = "claude" | "codex"

export type AgentRunnerSource = "iteration-default" | "config" | "queue" | "review-default"

export type AgentRunnerCommand = {
	kind: AgentRunnerKind
	binary: string
	extraArgs: readonly string[]
	model: string | null
}

export type AgentRunnerSelection = AgentRunnerCommand & {
	source: AgentRunnerSource
}

export type AgentRunnerCommands = {
	claude: AgentRunnerCommand
	codex: AgentRunnerCommand
}

export type RuntimeCheckError = {
	path: string
	message: string
}

export type AgentRunStatus = {
	label: AgentLabel
	runner: AgentRunnerKind | null
	model: string | null
	pid: number | null
	startedAt: string
	lastEventAt: string
	outputPath: string
	statusPath: string
	bytesWritten: number
	promptChars: number
	lastStream: "stdout" | "stderr" | null
	exitCode: number | null
	signal: string | null
	error: string | null
	sessionId: string | null
	terminated: Terminated | null
}

export type CoderLoopStatusSnapshot = {
	target: StatusTargetSnapshot
	state: StatusStateSnapshot
	queue: StatusQueueSnapshot
	current: StatusCurrentSnapshot
	events: StatusEventsSnapshot
	processes: StatusProcessSnapshot
}

export type StatusTargetSnapshot = {
	cwd: string
	configPath: string
	configFormat: ConfigFormat
	config: StatusResourceSnapshot
	workflowPath: string
	sharedContextPath: string
	statePath: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	traceFile: string
	loopFile: string
	repository: string | null
	baseBranch: string | null
	worktree: boolean
	runner: StatusRunnerDefaultsSnapshot
	preset: {
		name: string
		version: number
		description: string
		presetDir: string
	} | null
}

export type StatusResourceSnapshot =
	| { kind: "loaded"; error: null }
	| { kind: "missing"; error: string }
	| { kind: "invalid"; error: string }

export type StatusRunnerSelectionSnapshot = {
	kind: AgentRunnerKind
	source: AgentRunnerSource
	binary: string
	extraArgs: string[]
	model: string | null
}

export type StatusRunnerDefaultsSnapshot = {
	hostDefault: AgentRunnerKind
	default: StatusRunnerSelectionSnapshot
	reviewDefault: StatusRunnerSelectionSnapshot
}

export type StatusStateKind =
	| "ok"
	| "missing-config"
	| "invalid-config"
	| "missing-preset"
	| "invalid-preset"
	| "missing-state"
	| "invalid-state"
	| "invalid-runtime"

export type StatusStateSnapshot = {
	kind: StatusStateKind
	ok: boolean
	loaded: boolean
	path: string
	version: number | null
	repository: string | null
	baseBranch: string | null
	errors: RuntimeCheckError[]
	error: string | null
}

export type StatusSelectedIssue = {
	id: string
	item: QueueItem
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	runner: StatusRunnerSelectionSnapshot
	reviewRunner: StatusRunnerSelectionSnapshot
}

export type StatusQueueSnapshot = {
	total: number
	byStatus: Record<string, number>
	continuable: number
	terminal: number
	selected: StatusSelectedIssue | null
}

export type StatusPhaseStatusSnapshot = {
	path: string
	exists: boolean
	value: AgentRunStatus | null
	error: string | null
}

export type StatusCurrentSnapshot = {
	run: CurrentRun | null
	id: string | null
	item: QueueItem | null
	runner: StatusRunnerSelectionSnapshot | null
	phaseStatus: StatusPhaseStatusSnapshot | null
}

export type StatusEventsSnapshot = {
	runId: string | null
	path: string | null
	exists: boolean
	recent: JsonValue[]
	latest: JsonValue | null
	error: string | null
}

export type StatusLoopFileSnapshot = {
	path: string
	exists: boolean
	startedAt: string | null
	pid: number | null
	pidAlive: boolean | null
	log: string | null
	cwd: string | null
	statePath: string | null
	command: string | null
	requireBrowserEvidence: boolean | null
	raw: string | null
}

export type StatusProcessInfo = {
	pid: number
	ppid: number | null
	command: string | null
	cwd: string | null
	matchesTarget: boolean
	alive: boolean
	source: "loopFile" | "ps"
}

export type StatusProcessSnapshot = {
	loopFile: StatusLoopFileSnapshot
	live: StatusProcessInfo[]
	scanError: string | null
}

export type Terminated =
	| { kind: "clean" }
	| { kind: "signal"; name: string }
	| { kind: "error"; code: string; rateLimit?: RateLimitReset }
	| { kind: "watchdog"; phase: "term" | "kill"; afterSummarySeconds: number }
	| { kind: "timeout"; phase: "term" | "kill"; attemptSeconds: number }

export type SessionEntry = {
	attempt: string
	runner?: AgentRunnerKind | null
	model?: string | null
	sessionId: string | null
	exitCode: number | null
	signal: string | null
	terminated: Terminated
	log: string
}

export type ResumeDecision =
	| { kind: "fresh" }
	| { kind: "resume"; sessionId: string }

export type LoopEventBase = {
	ts: string
	runId: string
	issueId: string
	pr: number | null
	branch: string | null
}

export type LoopEvent =
	| (LoopEventBase & { type: "queue.select"; status: string })
	| (LoopEventBase & { type: "phase.start"; phase: string })
	| (LoopEventBase & { type: "phase.end"; phase: string; exitCode: number; durationSeconds: number })
	| (LoopEventBase & {
			type: "attempt.start"
			phase: string
			attemptStartedAt: string
			pid: number | null
			resume: "fresh" | "resume"
		})
	| (LoopEventBase & {
			type: "attempt.close"
			phase: string
			attemptStartedAt: string
			exitCode: number
			signal: string | null
			terminated: Terminated
			sessionId: string | null
		})
	| (LoopEventBase & {
			type: "watchdog.fire"
			phase: string
			attemptStartedAt: string
			signal: "SIGTERM" | "SIGKILL"
		})
	| (LoopEventBase & {
			type: "attempt.timeout"
			phase: string
			attemptStartedAt: string
			signal: "SIGTERM" | "SIGKILL"
			attemptSeconds: number
		})
	| (LoopEventBase & { type: "queue.terminal"; terminalStatus: string })

export type LoopEventType = LoopEvent["type"]

export const LOOP_EVENT_TYPES = [
	"queue.select",
	"phase.start",
	"phase.end",
	"attempt.start",
	"attempt.timeout",
	"attempt.close",
	"watchdog.fire",
	"queue.terminal",
] as const satisfies readonly LoopEventType[]

export type LoopEventEmit = (event: LoopEvent) => Promise<void>

export type LoopEventContext = {
	emit: LoopEventEmit
	runId: string
	issueId: string
	pr: number | null
	branch: string | null
	phase: string
}

export function loopEventsPath(runsDir: string, runId: string): string {
	return runRuntimePaths(runsDir, runId).eventsPath
}

export function formatLoopEventLine(event: LoopEvent): string {
	return `${JSON.stringify(event)}\n`
}

export async function appendLoopEvent(
	path: string,
	event: LoopEvent,
	logFn: (message: string) => void,
): Promise<void> {
	const line = formatLoopEventLine(event)
	try {
		await mkdir(resolve(path, ".."), { recursive: true })
		await appendFile(path, line)
	} catch (error) {
		logFn(`events.jsonl append failed (${path}): ${error instanceof Error ? error.message : String(error)}`)
	}
}

export function makeLoopEventEmitter(
	runsDir: string,
	runId: string,
	logFn: (message: string) => void,
): LoopEventEmit {
	const path = loopEventsPath(runsDir, runId)
	return (event) => appendLoopEvent(path, event, logFn)
}

export const RESUME_CONTINUE_PROMPT = "继续"
export const BACKOFF_BUDGET_SECONDS = 7200
const BACKOFF_INITIAL_SECONDS = 4
const BACKOFF_MAX_INTERVAL_SECONDS = 600

export const SUMMARY_WATCHDOG_MARKER = "ITERATION SUMMARY:"
export const REVIEW_SUMMARY_WATCHDOG_MARKER = "REVIEW SUMMARY:"
export type ReviewSummaryVerdict = "retry" | "accepted" | "skip" | "blocked" | "stop"
export const SUMMARY_WATCHDOG_TERM_MS = 5 * 60 * 1000
export const SUMMARY_WATCHDOG_KILL_MS = 5 * 1000

export type SelectedIssue = {
	item: QueueItem
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	runner: AgentRunnerSelection
	reviewRunner: AgentRunnerSelection
}

export type IssueRunContext = {
	runIdGeneration: "new" | "resumed"
	resumedFromPhase: string | null
	resumedStartedAt: string | null
}

const ISSUE_KIND_VALUES = ["code", "comment", "code-spike", "blocked"] as const
export type IssueKindValue = (typeof ISSUE_KIND_VALUES)[number]
export type IssueKind = IssueKindValue | null

const RUNTIME_BINDING_KEYS = [
	"runId",
	"targetCwd",
	"agentCwd",
	"workflowPath",
	"sharedContextPath",
	"stateDbPath",
	"currentIssueFile",
	"issueDir",
	"evidenceDir",
	"evidenceRootDir",
	"logDir",
	"loopDataRoot",
	"chainName",
	"chainDir",
	"runDir",
	"eventsFile",
	"iterationStdoutFile",
	"presetDir",
	"fragmentIndex",
	"runIdGeneration",
	"resumedFromPhase",
	"resumedStartedAt",
	"issueKind",
] as const

type RuntimeBindingKey = (typeof RUNTIME_BINDING_KEYS)[number]

function isRuntimeBindingKey(key: string): key is RuntimeBindingKey {
	return (RUNTIME_BINDING_KEYS as readonly string[]).includes(key)
}

export type RuntimeBindings = Record<RuntimeBindingKey, string>

export type ConfigBindings = {
	repository: string
	baseBranch: string
	requireBrowserEvidence: boolean
}

export type ResolveContext = {
	item: QueueItem
	config: ConfigBindings
	runtime: RuntimeBindings
}

function parseArgs(): RawArgs {
	const raw: RawArgs = {
		maxIterations: null,
		targetCwd: null,
		configPath: null,
		workflowPath: null,
		statePath: null,
		repository: null,
		chainName: null,
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
		worktree: false,
		baseBranch: null,
	}

	const args = process.argv.slice(2)
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing argument at index ${index}`)
		if (/^\d+$/.test(arg)) {
			raw.maxIterations = parseInt(arg, 10)
			continue
		}

		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--target-cwd":
				raw.targetCwd = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--config":
				raw.configPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--workflow":
				raw.workflowPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--state":
				raw.statePath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--repo":
				raw.repository = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--chain":
				raw.chainName = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--require-browser-evidence":
				rejectInlineValue(inlineValue, name)
				raw.requireBrowserEvidence = true
				break
			case "--once":
				rejectInlineValue(inlineValue, name)
				raw.once = true
				break
			case "--dry-run":
				rejectInlineValue(inlineValue, name)
				raw.dryRun = true
				break
			case "--check-runtime":
				rejectInlineValue(inlineValue, name)
				raw.checkRuntime = true
				break
			case "--worktree":
				rejectInlineValue(inlineValue, name)
				raw.worktree = true
				break
			case "--base-branch":
				raw.baseBranch = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			default:
				fail(`Unknown argument: ${arg}`)
		}
	}

	return raw
}

type CliCommand =
	| { kind: "status"; args: StatusCommandArgs }
	| { kind: "daemon"; args: DaemonCommandArgs }
	| { kind: "queue"; args: QueueUnblockCommandArgs }

const statusCliCommand = command({
	name: "status",
	description: "Emit a read-only coder-loop runtime snapshot.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("status: only --json output is supported for now. Usage: coder-loop status <target> --json")
		return {
			kind: "status",
			args: {
				targetCwd: args.target,
				configPath: args.config ?? null,
				repository: args.repo ?? null,
				output: "json",
			},
		}
	},
})

const daemonStatusCliCommand = command({
	name: "status",
	description: "Emit daemon ownership and runtime status for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("daemon status: only --json output is supported for now. Usage: coder-loop daemon status <target> --json")
		return {
			kind: "daemon",
			args: {
				action: "status",
				targetCwd: args.target,
				configPath: args.config ?? null,
				repository: args.repo ?? null,
				output: "json",
				ipc: daemonIpcOptionsFromArgs(args),
			},
		}
	},
})

const daemonStartCliCommand = command({
	name: "start",
	description: "Start coder-loop as a detached daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
		pid: option({ long: "pid", type: optional(cmdString) }),
		db: option({ long: "db", type: optional(cmdString) }),
		root: option({ long: "root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		noSpawnAgents: flag({ long: "no-spawn-agents" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "start",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonStopCliCommand = command({
	name: "stop",
	description: "Stop the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		socket: option({ long: "socket", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "stop",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			dryRun: args.dryRun,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonRestartCliCommand = command({
	name: "restart",
	description: "Restart the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		socket: option({ long: "socket", type: optional(cmdString) }),
		pid: option({ long: "pid", type: optional(cmdString) }),
		db: option({ long: "db", type: optional(cmdString) }),
		root: option({ long: "root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		noSpawnAgents: flag({ long: "no-spawn-agents" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "restart",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			ipc: daemonIpcOptionsFromArgs(args),
		},
	}),
})

const daemonCliCommand = subcommands({
	name: "daemon",
	description: "Manage coder-loop daemon processes.",
	cmds: {
		status: daemonStatusCliCommand,
		start: daemonStartCliCommand,
		stop: daemonStopCliCommand,
		restart: daemonRestartCliCommand,
	},
})

const queueUnblockCliCommand = command({
	name: "unblock",
	description: "Requeue one blocked item and clear its blocker metadata.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		startDaemon: flag({ long: "start-daemon" }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		dryRun: flag({ long: "dry-run" }),
	},
	handler: (args): CliCommand => ({
		kind: "queue",
		args: {
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			issue: args.issue,
			startDaemon: args.startDaemon,
			requireBrowserEvidence: args.requireBrowserEvidence,
			dryRun: args.dryRun,
		},
	}),
})

const queueCliCommand = subcommands({
	name: "queue",
	description: "Operate on coder-loop queue state through checked runtime APIs.",
	cmds: {
		unblock: queueUnblockCliCommand,
	},
})

type StoreCliOptions = {
	json: boolean
	rootDir: string | null
	dbPath: string | null
	socketPath: string | null
}

type ResolvedStoreCliOptions = {
	json: boolean
	rootDir: string
	dbPath: string
	socketPath: string
}

type ChainStatusReport = {
	chain: Chain
	items: {
		total: number
		byStatus: Record<string, number>
	}
	slots: JsonValue[]
	daemon: { ok: boolean; error: string | null }
}

async function runChainCommand(args: string[]): Promise<void> {
	const subcommand = args[0]
	if (subcommand === "create") {
		await runChainCreateCommand(args.slice(1))
		return
	}
	if (subcommand === "list") {
		await runChainListCommand(args.slice(1))
		return
	}
	if (subcommand === "status") {
		await runChainStatusCommand(args.slice(1))
		return
	}
	if (subcommand === "delete") {
		await runChainDeleteCommand(args.slice(1))
		return
	}
	fail(`chain: unknown subcommand "${subcommand ?? ""}". Usage: coder-loop chain create|list|status|delete`)
}

async function runItemCommand(args: string[]): Promise<void> {
	const subcommand = args[0]
	if (subcommand === "add") {
		await runItemAddCommand(args.slice(1))
		return
	}
	if (subcommand === "list") {
		await runItemListCommand(args.slice(1))
		return
	}
	if (subcommand === "update") {
		await runItemUpdateCommand(args.slice(1))
		return
	}
	fail(`item: unknown subcommand "${subcommand ?? ""}". Usage: coder-loop item add|list|update`)
}

type MigrateCliOptions = {
	targetCwd: string
	json: boolean
	rootDir: string | null
	dbPath: string | null
	configPath: string | null
	statePath: string | null
	chainName: string | null
	repository: string | null
	baseBranch: string | null
	allowMissingState: boolean
}

async function runMigrateCommand(args: string[]): Promise<void> {
	const options = parseMigrateCliArgs(args)
	const root = loopDataRootPaths(options.rootDir)
	const dbPath = resolve(options.dbPath ?? root.stateDbPath)
	const db = openStateDb(dbPath)
	try {
		const result = await migrateStateJson(options.targetCwd, db, {
			rootDir: root.rootDir,
			statePath: options.statePath,
			configPath: options.configPath,
			chainName: options.chainName,
			repository: options.repository,
			baseBranch: options.baseBranch,
			allowMissingState: options.allowMissingState,
			onDuplicate: "skip",
			backupState: true,
		})
		if (options.json) {
			writeJson(migrationResultJson(result, dbPath))
		} else {
			process.stdout.write([
				`Migrated legacy state: ${result.legacyStatePath}`,
				`Chain: ${result.chain.name} (${result.chain.status})`,
				`DB: ${dbPath}`,
				`Items: seen=${result.itemsSeen}, inserted=${result.itemsInserted}, updated=${result.itemsUpdated}, skipped=${result.skipped.length}`,
				`Runs: seen=${result.runsSeen}, inserted=${result.runsInserted}`,
				`Shared copied: ${result.copied.shared}`,
				`State backup: ${result.backupPath ?? "<none>"}`,
				"",
			].join("\n"))
		}
	} finally {
		db.close()
	}
}

function parseMigrateCliArgs(args: string[]): MigrateCliOptions {
	let targetCwd: string | null = null
	const options: Omit<MigrateCliOptions, "targetCwd"> = {
		json: false,
		rootDir: null,
		dbPath: null,
		configPath: null,
		statePath: null,
		chainName: null,
		repository: null,
		baseBranch: null,
		allowMissingState: false,
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing migrate argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		switch (flagName) {
			case "--json":
				rejectInlineValue(inlineValue, flagName)
				options.json = true
				break
			case "--root":
				options.rootDir = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--db":
				options.dbPath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--config":
				options.configPath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--state":
				options.statePath = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--chain":
				options.chainName = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--repo":
				options.repository = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--base-branch":
				options.baseBranch = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--allow-missing-state":
				rejectInlineValue(inlineValue, flagName)
				options.allowMissingState = true
				break
			default:
				if (arg.startsWith("--")) fail(`migrate: unknown argument ${arg}`)
				if (targetCwd !== null) fail(`migrate: extra target "${arg}"`)
				targetCwd = arg
		}
	}
	if (targetCwd === null) fail("migrate: missing target. Usage: coder-loop migrate <target> [--json] [--root <path>] [--db <path>] [--repo <owner/repo>] [--base-branch <branch>]")
	return { targetCwd: resolve(targetCwd), ...options }
}

async function runChainCreateCommand(args: string[]): Promise<void> {
	let name: string | null = null
	let preset: string | null = null
	let repository: string | null = null
	let baseBranch: string | null = null
	let umbrellaRepo: string | null = null
	let umbrellaIssue: number | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain create argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--preset":
				preset = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--repo":
				repository = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--base-branch":
				baseBranch = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--umbrella": {
				const parsed = parseUmbrellaRef(readFlagValue(args, index, inlineValue, flagName))
				umbrellaRepo = parsed.repo
				umbrellaIssue = parsed.issue
				if (inlineValue === null) index++
				break
			}
			default:
				if (arg.startsWith("--")) fail(`chain create: unknown argument ${arg}`)
				if (name !== null) fail(`chain create: extra chain name "${arg}"`)
				name = arg
		}
	}
	if (name === null) fail("chain create: missing name. Usage: coder-loop chain create <name> --preset <preset> [--repo <owner/repo>] [--base-branch <branch>] [--umbrella <owner/repo#N>]")
	if (preset === null) fail("chain create: missing --preset")
	const resolved = resolveStoreCliOptions(options)
	const chainPaths = chainRuntimePaths(resolved.rootDir, name)
	await ensureChainRuntimeSkeleton(chainPaths)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.upsertChain(name, preset, repository, baseBranch, umbrellaIssue, umbrellaRepo)
		if (resolved.json) writeJson(chain)
		else process.stdout.write(`Chain ${chain.name} created: preset=${chain.preset}, status=${chain.status}, db=${resolved.dbPath}\n`)
	} finally {
		store.close()
	}
}

async function runChainListCommand(args: string[]): Promise<void> {
	const options = parseStoreCliOnlyArgs("chain list", args)
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chains = store.listChains()
		if (resolved.json) writeJson(chains)
		else process.stdout.write(chains.length === 0 ? "No chains.\n" : chains.map(formatChainListLine).join("\n") + "\n")
	} finally {
		store.close()
	}
}

async function runChainStatusCommand(args: string[]): Promise<void> {
	let name: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain status argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (arg.startsWith("--")) fail(`chain status: unknown argument ${arg}`)
		if (name !== null) fail(`chain status: extra chain name "${arg}"`)
		name = arg
	}
	if (name === null) fail("chain status: missing name. Usage: coder-loop chain status <name> [--json]")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(name)
		if (chain === null) fail(`chain status: chain not found: ${name}`)
		const refreshed = chain.status === "active" && store.allItemsTerminal(chain.id)
			? store.completeChain(chain.id)
			: chain
		const report = await buildChainStatusReport(store, refreshed, resolved.socketPath)
		if (resolved.json) writeJson(report)
		else process.stdout.write(formatChainStatusReport(report))
	} finally {
		store.close()
	}
}

async function runChainDeleteCommand(args: string[]): Promise<void> {
	let name: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing chain delete argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (arg.startsWith("--")) fail(`chain delete: unknown argument ${arg}`)
		if (name !== null) fail(`chain delete: extra chain name "${arg}"`)
		name = arg
	}
	if (name === null) fail("chain delete: missing name. Usage: coder-loop chain delete <name>")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	let chain: Chain | null = null
	try {
		chain = store.getChain(name)
		if (chain === null) fail(`chain delete: chain not found: ${name}`)
		store.deleteChain(chain.id)
	} finally {
		store.close()
	}
	await rm(chainRuntimePaths(resolved.rootDir, name).chainDir, { recursive: true, force: true })
	if (resolved.json) writeJson({ deleted: true, chain: name })
	else process.stdout.write(`Chain ${name} deleted.\n`)
}

async function runItemAddCommand(args: string[]): Promise<void> {
	let chainName: string | null = null
	let issue: number | null = null
	let repoCwd: string | null = null
	let status: string | undefined
	let priority: string | undefined
	let extra: JsonObject | undefined
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item add argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--issue":
				issue = parsePositiveInteger(readFlagValue(args, index, inlineValue, flagName), "--issue")
				if (inlineValue === null) index++
				break
			case "--repo-cwd":
				repoCwd = resolve(readFlagValue(args, index, inlineValue, flagName))
				if (inlineValue === null) index++
				break
			case "--status":
				status = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--priority":
				priority = parsePriority(readFlagValue(args, index, inlineValue, flagName))
				if (inlineValue === null) index++
				break
			case "--extra":
				extra = parseJsonObjectFlag(readFlagValue(args, index, inlineValue, flagName), "--extra")
				if (inlineValue === null) index++
				break
			default:
				if (arg.startsWith("--")) fail(`item add: unknown argument ${arg}`)
				if (chainName !== null) fail(`item add: extra chain name "${arg}"`)
				chainName = arg
		}
	}
	if (chainName === null) fail("item add: missing chain. Usage: coder-loop item add <chain> --issue <N> --repo-cwd <path>")
	if (issue === null) fail("item add: missing --issue")
	if (repoCwd === null) fail("item add: missing --repo-cwd")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(chainName)
		if (chain === null) fail(`item add: chain not found: ${chainName}`)
		const newItem: NewItem = { issue, repoCwd }
		if (status !== undefined) newItem.status = status
		if (priority !== undefined) newItem.priority = priority
		if (extra !== undefined) newItem.extra = extra
		const item = store.addItem(chain.id, newItem)
		if (resolved.json) writeJson(item)
		else process.stdout.write(`Item ${item.id} added: chain=${chainName}, issue=${item.issue}, status=${item.status}, repoCwd=${item.repoCwd}\n`)
	} finally {
		store.close()
	}
}

async function runItemListCommand(args: string[]): Promise<void> {
	let chainName: string | null = null
	let status: string | null = null
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item list argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		if (flagName === "--status") {
			status = readFlagValue(args, index, inlineValue, flagName)
			if (inlineValue === null) index++
			continue
		}
		if (arg.startsWith("--")) fail(`item list: unknown argument ${arg}`)
		if (chainName !== null) fail(`item list: extra chain name "${arg}"`)
		chainName = arg
	}
	if (chainName === null) fail("item list: missing chain. Usage: coder-loop item list <chain> [--status <status>] [--json]")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const chain = store.getChain(chainName)
		if (chain === null) fail(`item list: chain not found: ${chainName}`)
		const items = store.listItems(chain.id, status)
		if (resolved.json) writeJson(items)
		else process.stdout.write(items.length === 0 ? "No items.\n" : items.map(formatItemListLine).join("\n") + "\n")
	} finally {
		store.close()
	}
}

async function runItemUpdateCommand(args: string[]): Promise<void> {
	let itemId: number | null = null
	let status: string | undefined
	let extra: JsonObject | undefined
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing item update argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (readStoreCliFlag(options, args, index, flagName, inlineValue)) {
			if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
			continue
		}
		switch (flagName) {
			case "--status":
				status = readFlagValue(args, index, inlineValue, flagName)
				if (inlineValue === null) index++
				break
			case "--extra":
				extra = parseJsonObjectFlag(readFlagValue(args, index, inlineValue, flagName), "--extra")
				if (inlineValue === null) index++
				break
			default:
				if (arg.startsWith("--")) fail(`item update: unknown argument ${arg}`)
				if (itemId !== null) fail(`item update: extra item id "${arg}"`)
				itemId = parsePositiveInteger(arg, "item-id")
		}
	}
	if (itemId === null) fail("item update: missing item-id. Usage: coder-loop item update <item-id> --status <status> [--extra '{...}']")
	if (status === undefined && extra === undefined) fail("item update: specify --status and/or --extra")
	const resolved = resolveStoreCliOptions(options)
	const store = openStateStore(resolved.dbPath)
	try {
		const existing = store.getItem(itemId)
		if (existing === null) fail(`item update: item not found: ${itemId}`)
		const patch: ItemPatch = {}
		if (status !== undefined) patch.status = status
		if (extra !== undefined) patch.extra = { ...existing.extra, ...extra }
		const item = store.updateItem(itemId, patch)
		if (resolved.json) writeJson(item)
		else process.stdout.write(`Item ${item.id} updated: issue=${item.issue}, status=${item.status}\n`)
	} finally {
		store.close()
	}
}

function defaultStoreCliOptions(): StoreCliOptions {
	return { json: false, rootDir: null, dbPath: null, socketPath: null }
}

function parseStoreCliOnlyArgs(label: string, args: string[]): StoreCliOptions {
	const options = defaultStoreCliOptions()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing ${label} argument at index ${index}`)
		const [flagName, inlineValue] = splitFlag(arg)
		if (!readStoreCliFlag(options, args, index, flagName, inlineValue)) fail(`${label}: unknown argument ${arg}`)
		if (inlineValue === null && storeCliFlagNeedsValue(flagName)) index++
	}
	return options
}

function readStoreCliFlag(options: StoreCliOptions, args: string[], index: number, name: string, inlineValue: string | null): boolean {
	switch (name) {
		case "--json":
			rejectInlineValue(inlineValue, name)
			options.json = true
			return true
		case "--root":
			options.rootDir = readFlagValue(args, index, inlineValue, name)
			return true
		case "--db":
			options.dbPath = readFlagValue(args, index, inlineValue, name)
			return true
		case "--socket":
			options.socketPath = readFlagValue(args, index, inlineValue, name)
			return true
		default:
			return false
	}
}

function storeCliFlagNeedsValue(name: string): boolean {
	return name === "--root" || name === "--db" || name === "--socket"
}

function resolveStoreCliOptions(options: StoreCliOptions): ResolvedStoreCliOptions {
	const root = loopDataRootPaths(options.rootDir)
	return {
		json: options.json,
		rootDir: root.rootDir,
		dbPath: resolve(options.dbPath ?? root.stateDbPath),
		socketPath: resolve(options.socketPath ?? root.daemonSocketPath),
	}
}

function parseUmbrellaRef(value: string): { repo: string; issue: number } {
	const match = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(value)
	if (match === null) fail(`--umbrella must be <owner/repo#N>, got: ${value}`)
	return { repo: match[1]!, issue: parsePositiveInteger(match[2]!, "--umbrella issue") }
}

function parsePositiveInteger(value: string, label: string): number {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer, got: ${value}`)
	return parsed
}

function parsePriority(value: string): string {
	if (value !== "high" && value !== "medium" && value !== "low") fail(`--priority must be high, medium, or low, got: ${value}`)
	return value
}

function parseJsonObjectFlag(value: string, label: string): JsonObject {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch (error) {
		fail(`${label} must be a JSON object: ${errorMessage(error)}`)
	}
	if (!isJsonObject(parsed)) fail(`${label} must be a JSON object`)
	return parsed
}

async function buildChainStatusReport(store: StateStore, chain: Chain, socketPath: string): Promise<ChainStatusReport> {
	const items = store.listItems(chain.id)
	const byStatus: Record<string, number> = {}
	for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const daemon = await readDaemonSlotsForChain(socketPath, chain.id)
	return {
		chain,
		items: { total: items.length, byStatus },
		slots: daemon.slots,
		daemon: { ok: daemon.ok, error: daemon.error },
	}
}

async function readDaemonSlotsForChain(socketPath: string, chainId: number): Promise<{ ok: boolean; error: string | null; slots: JsonValue[] }> {
	try {
		const response = await sendDaemonRequest(socketPath, { cmd: "daemon.status" }, 500)
		if (!response.ok) return { ok: false, error: response.error, slots: [] }
		if (!isObjectRecord(response.data)) return { ok: false, error: "daemon.status returned non-object data", slots: [] }
		const slots = Array.isArray(response.data.slots)
			? response.data.slots.filter((slot) => isObjectRecord(slot) && slot.chainId === chainId)
			: []
		return { ok: true, error: null, slots }
	} catch (error) {
		return { ok: false, error: errorMessage(error), slots: [] }
	}
}

function formatChainListLine(chain: Chain): string {
	const umbrella = chain.umbrellaRepo === null || chain.umbrellaIssue === null ? "" : ` umbrella=${chain.umbrellaRepo}#${chain.umbrellaIssue}`
	return `${chain.name}\tstatus=${chain.status}\tpreset=${chain.preset}\trepo=${chain.repository ?? "<none>"}${umbrella}`
}

function formatChainStatusReport(report: ChainStatusReport): string {
	const chain = report.chain
	const stats = Object.keys(report.items.byStatus).sort().map((status) => `${status}=${report.items.byStatus[status]}`).join(", ") || "none"
	return [
		`Chain: ${chain.name}`,
		`Preset: ${chain.preset}`,
		`Repository: ${chain.repository ?? "<none>"}`,
		`Status: ${chain.status}`,
		`Completed at: ${chain.completedAt ?? "<none>"}`,
		`Umbrella: ${chain.umbrellaRepo === null || chain.umbrellaIssue === null ? "<none>" : `${chain.umbrellaRepo}#${chain.umbrellaIssue}`}`,
		`Items: total=${report.items.total}${stats === "none" ? "" : `, ${stats}`}`,
		`Active slots: ${report.slots.length === 0 ? "none" : String(report.slots.length)}`,
		"",
	].join("\n")
}

function formatItemListLine(item: Item): string {
	return `${item.id}\tissue=${item.issue}\tstatus=${item.status}\tpriority=${item.priority}\trepoCwd=${item.repoCwd}`
}

function migrationResultJson(result: StateJsonMigrationResult, dbPath: string): JsonObject {
	return {
		chain: result.chain as unknown as JsonObject,
		items: result.items as unknown as JsonValue[],
		runs: result.runs as unknown as JsonValue[],
		skipped: result.skipped as unknown as JsonValue[],
		dbPath,
		legacyStatePath: result.legacyStatePath,
		legacyStateFound: result.legacyStateFound,
		legacyConfigPath: result.legacyConfigPath,
		legacySharedPath: result.legacySharedPath,
		backupPath: result.backupPath,
		chainDir: result.chainDir,
		itemsSeen: result.itemsSeen,
		itemsInserted: result.itemsInserted,
		itemsUpdated: result.itemsUpdated,
		runsSeen: result.runsSeen,
		runsInserted: result.runsInserted,
		copied: result.copied,
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(JSON.stringify(value, null, "\t") + "\n")
}

function splitFlag(arg: string): [string, string | null] {
	const equalsIndex = arg.indexOf("=")
	if (equalsIndex === -1) return [arg, null]
	return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)]
}

function readFlagValue(args: string[], index: number, inlineValue: string | null, name: string): string {
	if (inlineValue !== null) return inlineValue
	const value = args[index + 1]
	if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`)
	return value
}

function rejectInlineValue(value: string | null, name: string): void {
	if (value !== null) fail(`${name} does not accept a value`)
}

function parseDaemonMaxIterations(value: string | null): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`--max-iterations must be a positive integer, got: ${value}`)
	return parsed
}

function parseDaemonSchedulerIntervalMs(value: string | null): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`--scheduler-interval-ms must be a positive integer, got: ${value}`)
	return parsed
}

function daemonIpcOptionsFromArgs(args: {
	socket?: string | undefined
	pid?: string | undefined
	db?: string | undefined
	root?: string | undefined
	schedulerIntervalMs?: string | undefined
	noSpawnAgents?: boolean | undefined
}): DaemonTargetIpcOptions {
	return {
		socketPath: args.socket ?? null,
		pidPath: args.pid ?? null,
		dbPath: args.db ?? null,
		rootDir: args.root ?? null,
		schedulerIntervalMs: parseDaemonSchedulerIntervalMs(args.schedulerIntervalMs ?? null),
		spawnAgents: args.noSpawnAgents === true ? false : true,
	}
}

function defaultDaemonIpcOptions(): DaemonTargetIpcOptions {
	return {
		socketPath: null,
		pidPath: null,
		dbPath: null,
		rootDir: null,
		schedulerIntervalMs: null,
		spawnAgents: true,
	}
}

async function runStatusCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(statusCliCommand, args)
	if (parsed.kind !== "status") return
	const snapshot = await buildCoderLoopStatusSnapshot(parsed.args)
	StatusSnapshotBoundary.assert(snapshot)
	process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
}

async function runDaemonCommand(args: string[]): Promise<void> {
	const normalizedArgs = normalizeDaemonTargetCwdArgs(args)
	if (normalizedArgs[0] === "up") {
		await runDaemonUpCommand(normalizedArgs.slice(1))
		return
	}
	if (normalizedArgs[0] === "down") {
		await runDaemonDownCommand(normalizedArgs.slice(1))
		return
	}
	if (normalizedArgs[0] === "status" && !daemonStatusArgsIncludeTarget(normalizedArgs.slice(1))) {
		await runGlobalDaemonStatusCommand(normalizedArgs.slice(1))
		return
	}
	const parsed = await runCmd(daemonCliCommand, normalizedArgs)
	if (parsed.value.kind !== "daemon") return
	const daemonArgs = parsed.value.args
	if (daemonArgs.action === "status") {
		await runDaemonTargetStatusCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "start") {
		await runDaemonStartCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "stop") {
		await runDaemonStopCommand(daemonArgs)
		return
	}
	await runDaemonRestartCommand(daemonArgs)
}

function normalizeDaemonTargetCwdArgs(args: string[]): string[] {
	const subcommand = args[0]
	if (subcommand !== "start" && subcommand !== "stop" && subcommand !== "restart" && subcommand !== "status") return args
	let target: string | null = null
	const rest: string[] = []
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		if (name !== "--target-cwd") {
			rest.push(arg)
			continue
		}
		if (target !== null) fail(`daemon ${subcommand}: duplicate --target-cwd`)
		target = readFlagValue(args, index, inlineValue, name)
		if (inlineValue === null) index++
	}
	if (target === null) return args
	if (daemonArgsHavePositionalTarget(rest)) fail(`daemon ${subcommand}: use either positional target or --target-cwd, not both`)
	return [subcommand, target, ...rest]
}

function daemonArgsHavePositionalTarget(args: string[]): boolean {
	const flagsWithValues = new Set(["--config", "--repo", "--socket", "--pid", "--db", "--root", "--scheduler-interval-ms", "--max-iterations", "--base-branch"])
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		const [name, inlineValue] = splitFlag(arg)
		if (name.startsWith("--")) {
			if (inlineValue === null && flagsWithValues.has(name)) index++
			continue
		}
		return true
	}
	return false
}

type DaemonClientArgs = {
	socketPath: string
	json: boolean
}

async function runDaemonUpCommand(args: string[]): Promise<void> {
	const options = parseDaemonUpArgs(args)
	const defaults = daemonDefaults(options)
	const handle = await startDaemonServer(options)
	process.stdout.write(JSON.stringify({
		ok: true,
		data: {
			pid: process.pid,
			socketPath: defaults.socketPath,
			pidPath: defaults.pidPath,
			dbPath: defaults.dbPath,
			startedAt: handle.startedAt,
		},
	}, null, "\t") + "\n")
}

async function runGlobalDaemonStatusCommand(args: string[]): Promise<void> {
	const parsed = parseDaemonClientArgs(args)
	if (!parsed.json) fail("daemon status: global daemon status requires --json")
	await writeDaemonClientResponse(await sendDaemonRequest(parsed.socketPath, { cmd: "daemon.status" }))
}

async function runDaemonDownCommand(args: string[]): Promise<void> {
	const parsed = parseDaemonClientArgs(args)
	await writeDaemonClientResponse(await sendDaemonRequest(parsed.socketPath, { cmd: "daemon.shutdown" }))
}

async function writeDaemonClientResponse(response: DaemonResponse): Promise<void> {
	process.stdout.write(JSON.stringify(response, null, "\t") + "\n")
	if (!response.ok) process.exitCode = 1
}

function parseDaemonUpArgs(args: string[]): DaemonServerOptions {
	const options: DaemonServerOptions = {}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon up argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--socket":
				options.socketPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--pid":
				options.pidPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--db":
				options.dbPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--root":
				options.rootDir = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--log-chain":
				options.logChainName = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--scheduler-interval-ms": {
				const value = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				const parsed = Number(value)
				if (!Number.isInteger(parsed) || parsed <= 0) fail(`--scheduler-interval-ms must be a positive integer, got: ${value}`)
				options.schedulerIntervalMs = parsed
				break
			}
			case "--no-spawn-agents":
				rejectInlineValue(inlineValue, name)
				options.spawnAgents = false
				break
			default:
				fail(`daemon up: unknown argument ${arg}`)
		}
	}
	return options
}

function parseDaemonClientArgs(args: string[]): DaemonClientArgs {
	const defaults = daemonDefaults()
	const parsed: DaemonClientArgs = { socketPath: defaults.socketPath, json: false }
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`Missing daemon client argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--socket":
				parsed.socketPath = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--json":
				rejectInlineValue(inlineValue, name)
				parsed.json = true
				break
			default:
				fail(`daemon: unknown argument ${arg}`)
		}
	}
	return parsed
}

function daemonStatusArgsIncludeTarget(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		const [name, inlineValue] = splitFlag(arg)
		if (name === "--json") continue
		if (name === "--socket") {
			if (inlineValue === null) index++
			continue
		}
		if (arg.startsWith("--")) continue
		return true
	}
	return false
}

async function runQueueCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(queueCliCommand, args)
	if (parsed.value.kind !== "queue") return
	await runQueueUnblockCommand(parsed.value.args)
}

async function main() {
	const firstArg = process.argv[2]
	if (firstArg === "chain") {
		await runChainCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "item") {
		await runItemCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "migrate") {
		await runMigrateCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "status") {
		await runStatusCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "daemon") {
		await runDaemonCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "queue") {
		await runQueueCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "install" || firstArg === "uninstall" || firstArg === "doctor") {
		const handled = await dispatchSubcommand(firstArg, process.argv.slice(3))
		if (handled) return
	}
	const rawArgs = parseArgs()
	const targetCwd = resolve(rawArgs.targetCwd ?? process.cwd())
	const configPath = await resolveConfigPath(targetCwd, rawArgs.configPath)
	const config = await loadConfig(configPath)
	const presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	const options = buildOptions(targetCwd, configPath, rawArgs, config, preset)

	if (options.checkRuntime) {
		const stateResult = await readRuntimeState(options)
		if (stateResult.kind !== "ok") fail(stateResult.message)
		const state = stateResult.value
		const selected = selectIssue(state, options)
		const errors = await checkRuntime(options, state, stateResult.source)
		if (errors.length > 0) {
			console.error(`Runtime check failed: ${errors.length} error(s)`)
			for (const error of errors) console.error(`- ${error.path}: ${error.message}`)
			process.exit(1)
		}
		console.error(`Runtime check passed: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Runtime check passed: repo=${options.repository}`)
		console.error(`Runtime check passed: config=${options.configPath} (${configFormatForPath(options.configPath)})`)
		if (stateResult.source.kind === "chain-db") {
			console.error(`Runtime check passed: state=${stateResult.source.dbPath} (chain=${stateResult.source.chainName})`)
		} else {
			console.error(`Runtime check passed: state=${stateResult.source.statePath}`)
		}
		console.error(`Runtime check passed: queue=${state.queue.length}, selected=${selected ? getItemId(selected.item, options.preset) : "none"}`)
		console.error(`Runtime check passed: preset=${options.preset.name}`)
		return
	}

	if (options.dryRun) {
		const stateResult = await readRuntimeState(options)
		if (stateResult.kind !== "ok") fail(stateResult.message)
		const state = stateResult.value
		const selected = selectIssue(state, options)
		const errors = await checkRuntime(options, state, stateResult.source)
		if (errors.length > 0) {
			console.error(`Dry run failed runtime validation: ${errors.length} error(s)`)
			for (const error of errors) console.error(`- ${error.path}: ${error.message}`)
			process.exit(1)
		}
		console.error(`Dry run: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Dry run: repo=${options.repository}`)
		console.error(`Dry run: workflow=${options.workflowPath}`)
		if (stateResult.source.kind === "chain-db") {
			console.error(`Dry run: state=${stateResult.source.dbPath} (chain=${stateResult.source.chainName})`)
		} else {
			console.error(`Dry run: state=${stateResult.source.statePath}`)
		}
		console.error(`Dry run: selected=${selected ? getItemId(selected.item, options.preset) : "none"}`)
		if (selected) {
			const kindResult = await resolveIssueKind(options.repository, getItemId(selected.item, options.preset), selected.item)
			if (!kindResult.ok) {
				console.error(`Dry run: issue kind label check failed: ${kindResult.error}`)
				process.exit(1)
			}
			console.error(`Dry run: kind=${kindResult.kind ?? "<none>"}`)
			console.error(`Dry run: iterationRoute=${iterationRouteForIssueKind(kindResult.kind)}`)
			if (kindResult.kind === "code-spike") console.error("Dry run: noMerge=true")
		}
		return
	}

	await ensureRuntime(options)
	await assertRuntimeValid(options)

	if (options.worktree) {
		if (options.baseBranch === null || options.baseBranch.trim() === "") {
			fail("worktree mode requires a non-empty baseBranch (set in config or via --base-branch)")
		}
		validateWorktreePrerequisites(options.targetCwd, options.baseBranch)
	}

	logStream = createWriteStream(options.logFile, { flags: "a" })
	log(`=== coder-loop started (pid=${process.pid}, cwd=${options.targetCwd}) ===`)
	log(`Config: maxIterations=${formatMaxIterations(options.maxIterations)}`)
	log(`Repo=${options.repository}`)
	log(`Preset dir: ${options.preset.presetDir}`)
	log(`Default runner: ${options.defaultRunner.kind} (${options.defaultRunner.source}, binary=${options.defaultRunner.binary}, model=${options.defaultRunner.model ?? "<default>"})`)
	for (const phase of options.preset.phases) log(`Phase ${phase.name} prompt: ${phase.prompt}`)
	log(`Workflow=${options.workflowPath}`)
	log(`State=${options.statePath}`)
	if (options.worktree) {
		log(`Worktree mode: baseBranch=origin/${options.baseBranch}`)
		const startupState = await loadState(options.statePath)
		const activeIds = new Set<string>()
		for (const item of startupState.queue) {
			if (options.preset.statuses.continuable.includes(item.status)) {
				activeIds.add(getItemId(item, options.preset).replace(/[^a-zA-Z0-9_-]/g, "_"))
			}
		}
		cleanupStaleWorktrees(options.targetCwd, activeIds, log)
	}

	await ensureGitExclude(options.targetCwd)
	await mkdir(dirname(options.loopFile), { recursive: true })
	await writeFile(
		options.loopFile,
		[
			`started: ${new Date().toISOString()}`,
			`pid: ${process.pid}`,
			`log: ${options.logFile}`,
			`cwd: ${options.targetCwd}`,
			`state: ${options.statePath}`,
			`command: ${process.argv.map(shellQuote).join(" ")}`,
			`requireBrowserEvidence: ${options.requireBrowserEvidence}`,
			"",
		].join("\n"),
	)
	log(`Loop control file created. Delete it to stop: ${options.loopFile}`)

	let workIteration = 0
	const idleSleepMs = resolveIdleSleepMs()
	const lockPath = reviewOnEmptyLockPath(options.statePath)
	log(`Idle sleep: ${idleSleepMs}ms (override via CODER_LOOP_IDLE_SLEEP_MS)`)
	log(`Review-on-empty lock: ${lockPath}`)

	while ((await exists(options.loopFile)) && workIteration < options.maxIterations) {
		const state = await loadState(options.statePath)
		await assertRuntimeValid(options, state)
		let selected = selectIssue(state, options)

		if (options.worktree && selected && selected.item.agentCwd === null) {
			const selectedId = getItemId(selected.item, options.preset)
			const wtPath = ensureWorktreeForItem(
				options.targetCwd,
				options.baseBranch ?? "main",
				selectedId,
				selected.item.agentCwd,
			)
			selected.item.agentCwd = wtPath
			await saveState(options.statePath, state)
			selected = { ...selected, agentCwd: wtPath }
			log(`worktree: created ${wtPath} for item #${selectedId}`)
		}

		if (!selected) {
			if (!(await exists(lockPath))) {
				log("Empty queue: running review-on-empty for global state assessment.")
				const fallbackItem = makeFallbackItem()
				const fallbackRunId = makeRunId(null)
				const fallbackTrace = runRuntimePaths(options.logDir, fallbackRunId).phasePaths(options.preset.phases[0]?.name ?? "iteration").stdoutPath
				await mkdir(dirname(fallbackTrace), { recursive: true })
				await writeFile(fallbackTrace, "No actionable issue found in runtime state. Review must assess whether to stop.\n")
				const fallbackIssueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null }
				const fallbackCtx: ResolveContext = {
					item: fallbackItem,
					config: buildConfigBindings(options),
					runtime: buildRuntimeBindings({
						options,
						runId: fallbackRunId,
						currentIssueFile: "",
						evidenceDir: options.evidenceRootDir,
						agentCwd: options.targetCwd,
						issueRun: fallbackIssueRun,
						issueKind: null,
					}),
				}
				await runReview(options, fallbackRunId, fallbackCtx, options.targetCwd, options.reviewRunner)
				if (!(await exists(options.loopFile))) {
					log("Review agent stopped the loop.")
					break
				}
				await writeFile(lockPath, serializeReviewOnEmptyLock(fallbackRunId, new Date()))
				log(`review-on-empty lock written: ${lockPath} (runId=${fallbackRunId})`)
			} else {
				log(`Idle: empty queue + review-on-empty lock present. Sleeping ${idleSleepMs}ms.`)
			}
			await sleep(idleSleepMs)
			continue
		}

		workIteration++
		log(`--- Iteration ${workIteration} (work) ---`)

		const selectedId = getItemId(selected.item, options.preset)
		log(`Selected runner: ${selected.runner.kind} (${selected.runner.source}, binary=${selected.runner.binary}, model=${selected.runner.model ?? "<default>"})`)
		log(`Review runner: ${selected.reviewRunner.kind} (${selected.reviewRunner.source}, binary=${selected.reviewRunner.binary}, model=${selected.reviewRunner.model ?? "<default>"})`)
		const current = state.current && getCurrentId(state.current, options.preset) === selectedId ? state.current : null
		const issueRun = makeIssueRunContext(current)
		const runId = current?.runId ?? makeRunId(selectedId)
		const phases = options.preset.phases
		const iterPhase = phases[0]
		if (!iterPhase) fail("preset must define at least one phase")
		const reviewPhase = reviewPhaseForPreset(options.preset)
		const kindResult = await resolveIssueKind(options.repository, selectedId, selected.item)
		if (!kindResult.ok) fail(`Issue kind label check failed: ${kindResult.error}`)
		log(`Issue #${selectedId} kind=${kindResult.kind ?? "<none>"}`)
		const ctx: ResolveContext = {
			item: selected.item,
			config: buildConfigBindings(options),
			runtime: buildRuntimeBindings({
				options,
				runId,
				currentIssueFile: selected.issueFile,
				evidenceDir: selected.evidenceDir,
				agentCwd: selected.agentCwd,
				issueRun,
				issueKind: kindResult.kind,
			}),
		}

		const emit = makeLoopEventEmitter(options.logDir, runId, log)
		const baseEvent = {
			runId,
			issueId: selectedId,
			pr: selected.item.pr,
			branch: selected.item.branch,
		}
		await emit({
			type: "queue.select",
			ts: new Date().toISOString(),
			...baseEvent,
			status: selected.item.status,
		})

		if (current?.phase !== reviewPhase.name) {
			const stateForIteration = await loadState(options.statePath)
			markIterationStarted(stateForIteration, selected.item, options.preset, runId, current === null)
			await saveState(options.statePath, stateForIteration)
			const preIterSnapshot = serializeState(stateForIteration)

			log(`${current ? "Resuming" : "Starting"} ${iterPhase.name} agent for issue #${selectedId}...`)
			const iterStart = Date.now()
			const iterPromptRaw = await readFile(iterPhase.prompt, "utf-8")
			const iterPrompt = renderPrompt(iterPromptRaw, iterPhase, ctx)
			const iterOutputPath = agentOutputPath(options, runId, iterPhase.name)
			await emit({
				type: "phase.start",
				ts: new Date().toISOString(),
				...baseEvent,
				phase: iterPhase.name,
			})
			const iterEventContext: LoopEventContext = { emit, ...baseEvent, phase: iterPhase.name }
			const { output: iterTrace, code: iterCode } = await runAgent(
				options,
				iterPhase.name,
				iterPrompt,
				iterOutputPath,
				selected.agentCwd,
				selected.runner,
				iterEventContext,
			)
			const iterDurationSeconds = (Date.now() - iterStart) / 1000

			log(`${iterPhase.name} agent finished: issue=#${selectedId}, exit=${iterCode}, duration=${iterDurationSeconds.toFixed(0)}s, output=${iterOutputPath} (${iterTrace.length} bytes)`)
			await emit({
				type: "phase.end",
				ts: new Date().toISOString(),
				...baseEvent,
				phase: iterPhase.name,
				exitCode: iterCode,
				durationSeconds: Math.round(iterDurationSeconds),
			})

			if (iterCode !== 0) {
				log(`${iterPhase.name} agent failed (exit ${iterCode}). Stopping without review or state judgment.`)
				await removeLoopFile(options.loopFile)
				break
			}

			if (!(await exists(options.loopFile))) {
				log("Loop file removed during iteration. Stopping before review.")
				break
			}

			await reconcileStateAfterIter(options.statePath, preIterSnapshot, log)
			markReviewStarted(stateForIteration, selected.item, options.preset, runId)
			await saveState(options.statePath, stateForIteration)
					} else {
			log(`Resuming ${reviewPhase.name} agent for issue #${selectedId} without rerunning iteration...`)
		}

		const reviewCode = await runReview(options, runId, ctx, selected.agentCwd, selected.reviewRunner, { emit, ...baseEvent })
		if (reviewCode !== 0) {
			log(`Review agent crashed (exit ${reviewCode}). Stopping.`)
			await removeLoopFile(options.loopFile)
			break
		}

		if (!(await exists(options.loopFile))) {
			log("Review agent stopped the loop.")
			break
		}

		const triggerCode = await runTriggeredPhasesAfter(
			options,
			runId,
			selectedId,
			reviewPhase.name,
			kindResult.kind,
			emit,
		)
		if (triggerCode !== 0) {
			log(`Post-${reviewPhase.name} trigger agent crashed (exit ${triggerCode}). Stopping.`)
			await removeLoopFile(options.loopFile)
			break
		}

		if (!(await exists(options.loopFile))) {
			log(`Post-${reviewPhase.name} trigger agent stopped the loop.`)
			break
		}

		const stateAfterReviewTriggers = await loadState(options.statePath)
		const itemAfterReviewTriggers = stateAfterReviewTriggers.queue.find((q) => getItemId(q, options.preset) === selectedId)
		if (itemAfterReviewTriggers && options.preset.statuses.terminal.includes(itemAfterReviewTriggers.status)) {
			await emit({
				type: "queue.terminal",
				ts: new Date().toISOString(),
				runId,
				issueId: selectedId,
				pr: itemAfterReviewTriggers.pr,
				branch: itemAfterReviewTriggers.branch,
				terminalStatus: itemAfterReviewTriggers.status,
			})
			if (options.worktree && itemAfterReviewTriggers.agentCwd !== null) {
				removeWorktreeForItem(options.targetCwd, selectedId, log)
				log(`worktree: removed worktree for terminal item #${selectedId}`)
			}
		}

		log(`Iteration ${workIteration} (work) complete.`)
	}

	if (workIteration >= options.maxIterations) {
		log(`Reached ${formatMaxIterations(options.maxIterations)} work iterations.`)
	}

	log("=== Loop ended. ===")
	logStream?.end()
}

async function runTriggeredPhasesAfter(
	options: LoopOptions,
	runId: string,
	selectedId: string,
	afterPhase: string,
	issueKind: IssueKind,
	emit: LoopEventEmit,
): Promise<number> {
	for (const phase of options.preset.phases.filter((candidate) => candidate.trigger?.afterPhase === afterPhase)) {
		const state = await loadState(options.statePath)
		const item = state.queue.find((queueItem) => getItemId(queueItem, options.preset) === selectedId)
		if (!item) {
			log(`Skipping trigger phase ${phase.name}: issue #${selectedId} no longer exists in queue.`)
			continue
		}
		if (phase.trigger?.whenStatus !== item.status) {
			log(`Skipping trigger phase ${phase.name}: status=${item.status}, wanted=${phase.trigger?.whenStatus ?? "<none>"}.`)
			continue
		}

		const issueFile = item.issueFile === null ? null : resolveFrom(options.targetCwd, item.issueFile)
		const evidenceDir = item.evidenceDir === null ? null : resolveFrom(options.targetCwd, item.evidenceDir)
		if (issueFile !== null && !isWithin(options.issueDir, issueFile)) fail(`Triggered issue file must resolve inside issueDir: ${item.issueFile}`)
		if (evidenceDir !== null && !isWithin(options.evidenceRootDir, evidenceDir)) fail(`Triggered evidence directory must resolve inside evidenceDir: ${item.evidenceDir}`)

		const agentCwd = item.agentCwd ?? options.targetCwd
		const runner = selectRunnerForPhase(phase.name, item, options)
		const ctx: ResolveContext = {
			item,
			config: buildConfigBindings(options),
			runtime: buildRuntimeBindings({
				options,
				runId,
				currentIssueFile: issueFile,
				evidenceDir,
				agentCwd,
				issueRun: { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null },
				issueKind,
			}),
		}
		const eventContext: LoopEventContext = {
			emit,
			runId,
			issueId: selectedId,
			pr: item.pr,
			branch: item.branch,
			phase: phase.name,
		}

		log(`Starting trigger phase ${phase.name} after ${afterPhase} for issue #${selectedId} (status=${item.status})...`)
		const phaseStart = Date.now()
		const promptRaw = await readFile(phase.prompt, "utf-8")
		const prompt = renderPrompt(promptRaw, phase, ctx)
		const outputPath = agentOutputPath(options, runId, phase.name)
		await emit({
			type: "phase.start",
			ts: new Date().toISOString(),
			runId,
			issueId: selectedId,
			pr: item.pr,
			branch: item.branch,
			phase: phase.name,
		})
		const { output, code } = await runAgent(options, phase.name, prompt, outputPath, agentCwd, runner, eventContext)
		const durationSeconds = (Date.now() - phaseStart) / 1000

		log(`Trigger phase ${phase.name} finished: issue=#${selectedId}, exit=${code}, duration=${durationSeconds.toFixed(0)}s, output=${outputPath} (${output.length} bytes)`)
		if (output.trim().length > 0) {
			await appendFile(options.logFile, `\n--- ${phase.name} output ${new Date().toISOString()} ---\n${output}\n`)
		}
		await emit({
			type: "phase.end",
			ts: new Date().toISOString(),
			runId,
			issueId: selectedId,
			pr: item.pr,
			branch: item.branch,
			phase: phase.name,
			exitCode: code,
			durationSeconds: Math.round(durationSeconds),
		})
		if (code !== 0) return code
		if (!(await exists(options.loopFile))) return 0
	}
	return 0
}

async function runReview(
	options: LoopOptions,
	runId: string,
	ctx: ResolveContext,
	agentCwd: string,
	runner: AgentRunnerSelection,
	eventContext?: Omit<LoopEventContext, "phase">,
): Promise<number> {
	const reviewPhase = reviewPhaseForPreset(options.preset)
	log(`Starting ${reviewPhase.name} agent...`)
	const reviewStart = Date.now()
	const reviewPromptRaw = await readFile(reviewPhase.prompt, "utf-8")
	const reviewPrompt = renderPrompt(reviewPromptRaw, reviewPhase, ctx)
	const reviewOutputPath = agentOutputPath(options, runId, reviewPhase.name)
	const phaseEventContext: LoopEventContext | undefined = eventContext
		? { ...eventContext, phase: reviewPhase.name }
		: undefined
	if (phaseEventContext) {
		await phaseEventContext.emit({
			type: "phase.start",
			ts: new Date().toISOString(),
			runId: phaseEventContext.runId,
			issueId: phaseEventContext.issueId,
			pr: phaseEventContext.pr,
			branch: phaseEventContext.branch,
			phase: reviewPhase.name,
		})
	}
	const { output: reviewTrace, code: reviewCode } = await runAgent(
		options,
		reviewPhase.name,
		reviewPrompt,
		reviewOutputPath,
		agentCwd,
		runner,
		phaseEventContext,
	)
	const reviewDuration = (Date.now() - reviewStart) / 1000

	log(`${reviewPhase.name} agent finished: exit=${reviewCode}, duration=${reviewDuration.toFixed(0)}s, output=${reviewOutputPath} (${reviewTrace.length} bytes)`)
	if (reviewTrace.trim().length > 0) {
		await appendFile(options.logFile, `\n--- ${reviewPhase.name} output ${new Date().toISOString()} ---\n${reviewTrace}\n`)
	}
	if (phaseEventContext) {
		await phaseEventContext.emit({
			type: "phase.end",
			ts: new Date().toISOString(),
			runId: phaseEventContext.runId,
			issueId: phaseEventContext.issueId,
			pr: phaseEventContext.pr,
			branch: phaseEventContext.branch,
			phase: reviewPhase.name,
			exitCode: reviewCode,
			durationSeconds: Math.round(reviewDuration),
		})
	}
	if (reviewCode === 0 && parseReviewSummaryVerdict(reviewTrace, runner.kind) === "stop") {
		log(`${reviewPhase.name} agent requested loop stop via REVIEW SUMMARY; removing loop control file.`)
		await removeLoopFile(options.loopFile)
	}
	return reviewCode
}

function buildOptions(targetCwd: string, configPath: string, raw: RawArgs, config: LoopConfig, preset: Preset): LoopOptions {
	const chainName = raw.chainName ?? defaultChainNameForTarget(targetCwd)
	const chainPaths = chainRuntimePaths(null, chainName)
	const useLegacyRuntimeDefaults = existsSync(configPath)
	const defaultSharedPath = useLegacyRuntimeDefaults ? DEFAULT_SHARED_FILE : chainPaths.sharedPath
	const defaultStatePath = useLegacyRuntimeDefaults ? DEFAULT_STATE_FILE : loopDataRootPaths().stateDbPath
	const defaultIssueDir = useLegacyRuntimeDefaults ? DEFAULT_ISSUE_DIR : chainPaths.issuesDir
	const defaultEvidenceDir = useLegacyRuntimeDefaults ? DEFAULT_EVIDENCE_DIR : chainPaths.evidenceDir
	const defaultLogDir = chainPaths.runsDir
	const workflowPath = resolveFrom(targetCwd, raw.workflowPath ?? config.workflowFile ?? DEFAULT_WORKFLOW_FILE)
	const sharedContextPath = resolveFrom(targetCwd, config.sharedContextFile ?? defaultSharedPath)
	const statePath = resolveFrom(targetCwd, raw.statePath ?? config.stateFile ?? defaultStatePath)
	const issueDir = resolveFrom(targetCwd, config.issueDir ?? defaultIssueDir)
	const evidenceRootDir = resolveFrom(targetCwd, config.evidenceDir ?? defaultEvidenceDir)
	const logDir = resolveFrom(targetCwd, config.logDir ?? defaultLogDir)
	const repository = raw.repository ?? config.repository
	const maxIterations = raw.once ? 1 : (raw.maxIterations ?? Number.POSITIVE_INFINITY)
	const requireBrowserEvidence = raw.requireBrowserEvidence ?? config.requireAgentBrowserScreenshots ?? false
	const worktree = raw.worktree || config.worktree === true
	const baseBranch = raw.baseBranch ?? config.baseBranch ?? (worktree ? "main" : null)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const hostRunner = detectHostRunner(process.env)
	const runnerCommands = buildAgentRunnerCommands(config)
	const defaultRunner = selectDefaultRunner(config.defaultRunner, runnerCommands)
	const reviewRunner = selectReviewRunner(config.reviewRunner, runnerCommands)

	return {
		targetCwd,
		configPath,
		workflowPath,
		sharedContextPath,
		statePath,
		issueDir,
		evidenceRootDir,
		logDir,
		loopFile: resolve(chainPaths.chainDir, "loop-control"),
		traceFile: resolve(logDir, "legacy-trace.txt"),
		logFile: resolve(logDir, `coder-loop-${process.pid}.${timestamp}.log`),
		chainName,
		chainNameExplicit: raw.chainName !== null,
		repository,
		baseBranch,
		worktree,
		requireBrowserEvidence,
		hostRunner,
		defaultRunner,
		reviewRunner,
		runnerCommands,
		maxIterations,
		dryRun: raw.dryRun,
		checkRuntime: raw.checkRuntime,
		preset,
	}
}

export async function buildCoderLoopStatusSnapshot(args: StatusCommandArgs): Promise<CoderLoopStatusSnapshot> {
	const targetCwd = resolve(args.targetCwd)
	const configPath = await resolveConfigPath(targetCwd, args.configPath)
	const baseTarget = makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: "loaded", error: null })

	const configResult = await readStatusConfig(configPath)
	if (configResult.kind === "invalid") {
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: "invalid", error: configResult.message }),
			stateKind: "invalid-config",
			statePath: baseTarget.statePath,
			errorPath: "config",
			errorMessage: configResult.message,
		})
	}
	const configValue = configResult.kind === "ok" ? configResult.value : defaultLoopConfig()
	const configSnapshot: StatusResourceSnapshot = configResult.kind === "ok"
		? { kind: "loaded", error: null }
		: { kind: "missing", error: configResult.message }

	const presetResult = await readStatusPreset(configValue, targetCwd)
	if (presetResult.kind !== "ok") {
		const stateKind: StatusStateKind = presetResult.kind === "missing" ? "missing-preset" : "invalid-preset"
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, configSnapshot),
			stateKind,
			statePath: baseTarget.statePath,
			errorPath: "preset",
			errorMessage: presetResult.message,
		})
	}

	const raw = makeStatusRawArgs(args)
	const options = buildOptions(targetCwd, configPath, raw, configValue, presetResult.value)
	const target = makeStatusTargetSnapshot(targetCwd, configPath, args.repository, options, configSnapshot)
	const stateResult = await readRuntimeState(options)
	if (stateResult.kind !== "ok") {
		const stateKind: StatusStateKind = stateResult.kind === "missing" ? "missing-state" : "invalid-state"
		return makeUnavailableStatusSnapshot({
			target,
			stateKind,
			statePath: options.statePath,
			errorPath: "state",
			errorMessage: stateResult.message,
		})
	}

	const selected = selectIssue(stateResult.value, options)
	const runtimeErrors = await checkRuntime(options, stateResult.value, stateResult.source)
	const currentSnapshot = await buildStatusCurrentSnapshot(options, stateResult.value)
	const events = await buildStatusEventsSnapshot(options, stateResult.value, selected)
	const processes = await buildStatusProcessSnapshot(options)
	const snapshot: CoderLoopStatusSnapshot = {
		target,
		state: {
			kind: runtimeErrors.length === 0 ? "ok" : "invalid-runtime",
			ok: runtimeErrors.length === 0,
			loaded: true,
			path: stateResult.source.kind === "chain-db" ? stateResult.source.dbPath : stateResult.source.statePath,
			version: stateResult.value.version,
			repository: stateResult.value.repository,
			baseBranch: stateResult.value.baseBranch,
			errors: runtimeErrors,
			error: null,
		},
		queue: buildStatusQueueSnapshot(options, stateResult.value, selected),
		current: currentSnapshot,
		events,
		processes,
	}
	StatusSnapshotBoundary.assert(snapshot)
	return snapshot
}

type StatusReadResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "missing"; message: string }
	| { kind: "invalid"; message: string }

async function readStatusConfig(path: string): Promise<StatusReadResult<LoopConfig>> {
	try {
		const raw = await readFile(path, "utf-8")
		return { kind: "ok", value: parseConfigText(raw, path) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing optional config file: ${path}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

async function readStatusPreset(config: LoopConfig, targetCwd: string): Promise<StatusReadResult<Preset>> {
	let presetDir: string
	try {
		presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	} catch (error) {
		return { kind: "invalid", message: errorMessage(error) }
	}
	try {
		return { kind: "ok", value: await loadPreset(presetDir) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing preset file: ${resolve(presetDir, "preset.toml")}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

async function readStatusState(path: string): Promise<StatusReadResult<LoopState>> {
	try {
		const raw = await readFile(path, "utf-8")
		return { kind: "ok", value: parseStateText(raw) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing state file: ${path}` }
		return { kind: "invalid", message: errorMessage(error) }
	}
}

async function readRuntimeState(options: LoopOptions): Promise<RuntimeStateReadResult> {
	const chainState = await readChainRuntimeState(options)
	if (chainState !== null) return chainState
	const fileState = await readStatusState(options.statePath)
	if (fileState.kind === "ok") {
		return { kind: "ok", value: fileState.value, source: { kind: "file", statePath: options.statePath } }
	}
	const legacyStatePath = resolve(options.targetCwd, DEFAULT_STATE_FILE)
	if (legacyStatePath !== options.statePath) {
		const legacyState = await readStatusState(legacyStatePath)
		if (legacyState.kind === "ok") {
			return { kind: "ok", value: legacyState.value, source: { kind: "file", statePath: legacyStatePath } }
		}
	}
	return {
		kind: fileState.kind,
		message: `${fileState.message}; no chain row "${defaultChainNameForTarget(options.targetCwd)}" in ${loopDataRootPaths().stateDbPath}`,
		statePath: options.statePath,
	}
}

async function readChainRuntimeState(options: LoopOptions): Promise<Extract<RuntimeStateReadResult, { kind: "ok" }> | null> {
	const root = loopDataRootPaths()
	const store = openStateStore(root.stateDbPath)
	try {
		const chainName = options.chainNameExplicit
			? options.chainName
			: resolveChainNameForTarget(store, options.targetCwd, defaultChainNameForTarget(options.targetCwd))
		const chainPaths = chainRuntimePaths(root.rootDir, chainName)
		const chain = store.getChain(chainName)
		if (chain === null) return null
		const queue = store.listItems(chain.id).map((item) => dbItemToQueueItem(item, chainPaths))
		return {
			kind: "ok",
			value: {
				version: 1,
				queue,
				repository: chain.repository,
				baseBranch: chain.baseBranch,
				recentRuns: [],
				current: null,
			},
			source: { kind: "chain-db", dbPath: root.stateDbPath, chainName, chainPaths },
		}
	} finally {
		store.close()
	}
}

function resolveChainNameForTarget(store: StateStore, targetCwdInput: string, fallbackName: string): string {
	const targetCwd = resolve(targetCwdInput)
	const matches: Chain[] = []
	for (const chain of store.listChains()) {
		if (chainTargetsRepoCwd(store, chain, targetCwd)) matches.push(chain)
	}
	if (matches.length === 1) return matches[0]!.name
	if (matches.length > 1) {
		throw new Error(`target-cwd ${targetCwd} belongs to multiple chains: ${matches.map((chain) => chain.name).join(", ")}; specify --chain`)
	}
	return fallbackName
}

function chainTargetsRepoCwd(store: StateStore, chain: Chain, targetCwd: string): boolean {
	const metadataTarget = chain.metadata.targetCwd
	if (typeof metadataTarget === "string" && resolve(metadataTarget) === targetCwd) return true
	return store.listItems(chain.id).some((item) => resolve(item.repoCwd) === targetCwd)
}

function dbItemToQueueItem(item: Item, chainPaths: ChainRuntimePaths): QueueItem {
	return {
		status: item.status,
		attempts: item.attempts,
		title: item.title,
		priority: item.priority,
		branch: item.branch,
		pr: item.pr,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile === null ? null : resolveFrom(chainPaths.chainDir, item.issueFile),
		evidenceDir: item.evidenceDir === null ? null : resolveFrom(chainPaths.chainDir, item.evidenceDir),
		agentCwd: item.agentCwd,
		runner: item.runner,
		extra: { ...item.extra, issue: item.issue },
	}
}

function makeStatusRawArgs(args: StatusCommandArgs): RawArgs {
	return {
		maxIterations: null,
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		workflowPath: null,
		statePath: null,
		repository: args.repository,
		chainName: null,
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
		worktree: false,
		baseBranch: null,
	}
}

function makeStatusTargetSnapshot(
	targetCwd: string,
	configPath: string,
	repositoryOverride: string | null,
	options: LoopOptions | null,
	config: StatusResourceSnapshot,
): StatusTargetSnapshot {
	const runtimeRoot = resolve(targetCwd, ".coder-loop/runtime")
	const chainPaths = chainRuntimePaths(null, defaultChainNameForTarget(targetCwd))
	const defaultLogDir = chainPaths.runsDir
	const preset = options === null ? null : {
		name: options.preset.name,
		version: options.preset.version,
		description: options.preset.description,
		presetDir: options.preset.presetDir,
	}
	return {
		cwd: targetCwd,
		configPath,
		configFormat: configFormatForPath(configPath),
		config,
		workflowPath: options?.workflowPath ?? resolve(targetCwd, DEFAULT_WORKFLOW_FILE),
		sharedContextPath: options?.sharedContextPath ?? resolve(runtimeRoot, "shared.md"),
		statePath: options?.statePath ?? resolve(runtimeRoot, "state.json"),
		issueDir: options?.issueDir ?? resolve(runtimeRoot, "issues"),
		evidenceRootDir: options?.evidenceRootDir ?? resolve(runtimeRoot, "evidence"),
		logDir: options?.logDir ?? defaultLogDir,
		traceFile: options?.traceFile ?? resolve(defaultLogDir, "legacy-trace.txt"),
		loopFile: options?.loopFile ?? resolve(chainPaths.chainDir, "loop-control"),
		repository: options?.repository ?? repositoryOverride,
		baseBranch: options?.baseBranch ?? null,
		worktree: options?.worktree ?? false,
		runner: buildStatusRunnerDefaultsSnapshot(options),
		preset,
	}
}

function buildStatusRunnerDefaultsSnapshot(options: LoopOptions | null): StatusRunnerDefaultsSnapshot {
	if (options !== null) {
		return {
			hostDefault: options.hostRunner,
			default: statusRunnerSelection(options.defaultRunner),
			reviewDefault: statusRunnerSelection(options.reviewRunner),
		}
	}
	const hostRunner = detectHostRunner(process.env)
	const config: LoopConfig = {
		repository: null,
		baseBranch: null,
		worktree: null,
		workflowFile: null,
		sharedContextFile: null,
		stateFile: null,
		issueDir: null,
		evidenceDir: null,
		logDir: null,
		requireAgentBrowserScreenshots: null,
		defaultRunner: null,
		reviewRunner: null,
		claudeBinary: null,
		claudeExtraArgs: [],
		claudeModel: null,
		codexBinary: null,
		codexExtraArgs: [],
		codexModel: null,
		preset: null,
		presetPath: null,
	}
	return {
		hostDefault: hostRunner,
		default: statusRunnerSelection(selectDefaultRunner(null, buildAgentRunnerCommands(config))),
		reviewDefault: statusRunnerSelection(selectReviewRunner(null, buildAgentRunnerCommands(config))),
	}
}

function makeUnavailableStatusSnapshot(input: {
	target: StatusTargetSnapshot
	stateKind: StatusStateKind
	statePath: string
	errorPath: string
	errorMessage: string
}): CoderLoopStatusSnapshot {
	return {
		target: input.target,
		state: {
			kind: input.stateKind,
			ok: false,
			loaded: false,
			path: input.statePath,
			version: null,
			repository: null,
			baseBranch: null,
			errors: [{ path: input.errorPath, message: input.errorMessage }],
			error: input.errorMessage,
		},
		queue: { total: 0, byStatus: {}, continuable: 0, terminal: 0, selected: null },
		current: { run: null, id: null, item: null, runner: null, phaseStatus: null },
		events: { runId: null, path: null, exists: false, recent: [], latest: null, error: null },
		processes: {
			loopFile: {
				path: input.target.loopFile,
				exists: false,
				startedAt: null,
				pid: null,
				pidAlive: null,
				log: null,
				cwd: null,
				statePath: null,
				command: null,
				requireBrowserEvidence: null,
				raw: null,
			},
			live: [],
			scanError: null,
		},
	}
}

function flattenExtraReplacer(_key: string, value: unknown): unknown {
	if (!isObjectRecord(value) || !("extra" in value) || !isJsonObject(value.extra)) return value
	const extra = value.extra
	const rest: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value)) {
		if (k !== "extra") rest[k] = v
	}
	return { ...extra, ...rest }
}

function stringifyStatusSnapshot(snapshot: CoderLoopStatusSnapshot): string {
	return JSON.stringify(snapshot, flattenExtraReplacer, "\t")
}

function buildStatusQueueSnapshot(options: LoopOptions, state: LoopState, selected: SelectedIssue | null): StatusQueueSnapshot {
	const byStatus: Record<string, number> = {}
	for (const item of state.queue) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const continuableStatuses = new Set(options.preset.statuses.continuable)
	const terminalStatuses = new Set(options.preset.statuses.terminal)
	return {
		total: state.queue.length,
		byStatus,
		continuable: state.queue.filter((item) => continuableStatuses.has(item.status)).length,
		terminal: state.queue.filter((item) => terminalStatuses.has(item.status)).length,
		selected: selected === null ? null : {
			id: getItemId(selected.item, options.preset),
			item: selected.item,
			issueFile: selected.issueFile,
			evidenceDir: selected.evidenceDir,
			agentCwd: selected.agentCwd,
			runner: statusRunnerSelection(selected.runner),
			reviewRunner: statusRunnerSelection(selected.reviewRunner),
		},
	}
}

async function buildStatusCurrentSnapshot(options: LoopOptions, state: LoopState): Promise<StatusCurrentSnapshot> {
	if (state.current === null) return { run: null, id: null, item: null, runner: null, phaseStatus: null }
	let id: string | null = null
	let item: QueueItem | null = null
	try {
		id = getCurrentId(state.current, options.preset)
		item = state.queue.find((entry) => getItemId(entry, options.preset) === id) ?? null
	} catch {
		id = null
	}
	const outputPath = agentOutputPath(options, state.current.runId, state.current.phase)
	return {
		run: state.current,
		id,
		item,
		runner: item === null ? null : statusRunnerSelection(selectRunnerForPhase(state.current.phase, item, options)),
		phaseStatus: await readAgentPhaseStatus(agentStatusPath(outputPath)),
	}
}

function statusRunnerSelection(selection: AgentRunnerSelection): StatusRunnerSelectionSnapshot {
	return {
		kind: selection.kind,
		source: selection.source,
		binary: selection.binary,
		extraArgs: [...selection.extraArgs],
		model: selection.model,
	}
}

async function readAgentPhaseStatus(path: string): Promise<StatusPhaseStatusSnapshot> {
	try {
		const raw = await readFile(path, "utf-8")
		const parsed: unknown = JSON.parse(raw)
		const status = agentStatusFromInput(assertArk(AgentRunStatusBoundary, parsed, "agent status"))
		return { path, exists: true, value: status, error: null }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { path, exists: false, value: null, error: null }
		return { path, exists: true, value: null, error: errorMessage(error) }
	}
}

function agentStatusFromInput(input: AgentRunStatusInput): AgentRunStatus {
	return {
		label: input.label,
		runner: input.runner ?? null,
		model: input.model ?? null,
		pid: input.pid,
		startedAt: input.startedAt,
		lastEventAt: input.lastEventAt,
		outputPath: input.outputPath,
		statusPath: input.statusPath,
		bytesWritten: input.bytesWritten,
		promptChars: input.promptChars,
		lastStream: input.lastStream,
		exitCode: input.exitCode,
		signal: input.signal,
		error: input.error,
		sessionId: input.sessionId,
		terminated: input.terminated,
	}
}


async function buildStatusEventsSnapshot(options: LoopOptions, state: LoopState, selected: SelectedIssue | null): Promise<StatusEventsSnapshot> {
	const runId = state.current?.runId ?? selected?.item.lastRunId ?? firstLastRunId(state)
	if (runId === null) return { runId: null, path: null, exists: false, recent: [], latest: null, error: null }
	const path = loopEventsPath(options.logDir, runId)
	try {
		const raw = await readFile(path, "utf-8")
		const recent = parseRecentJsonLines(raw, 20)
		return {
			runId,
			path,
			exists: true,
			recent,
			latest: recent[recent.length - 1] ?? null,
			error: null,
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { runId, path, exists: false, recent: [], latest: null, error: null }
		return { runId, path, exists: true, recent: [], latest: null, error: errorMessage(error) }
	}
}

function firstLastRunId(state: LoopState): string | null {
	for (const item of state.queue) {
		if (item.lastRunId !== null) return item.lastRunId
	}
	return null
}

function parseRecentJsonLines(raw: string, limit: number): JsonValue[] {
	const lines = raw.split("\n").filter((line) => line.trim() !== "")
	const recent = lines.slice(-limit)
	return recent.map((line) => {
		const parsed: unknown = JSON.parse(line)
		if (!isJsonValue(parsed)) throw new Error("event line is not JSON data")
		return parsed
	})
}

async function buildStatusProcessSnapshot(options: LoopOptions): Promise<StatusProcessSnapshot> {
	const loopFile = await readStatusLoopFile(options.loopFile)
	const live: StatusProcessInfo[] = []
	if (loopFile.pid !== null) {
		live.push({
			pid: loopFile.pid,
			ppid: null,
			command: null,
			cwd: loopFile.cwd,
			matchesTarget: loopFile.cwd === options.targetCwd,
			alive: loopFile.pidAlive === true,
			source: "loopFile",
		})
	}
	const scan = scanLoopProcesses(options.targetCwd)
	return {
		loopFile,
		live: mergeProcessSnapshots(live, scan.kind === "ok" ? scan.value : []),
		scanError: scan.kind === "ok" ? null : scan.message,
	}
}

async function readStatusLoopFile(path: string): Promise<StatusLoopFileSnapshot> {
	try {
		const raw = await readFile(path, "utf-8")
		const parsed = parseLoopFile(raw)
		const pidAlive = parsed.pid === null ? null : isPidAlive(parsed.pid)
		return { path, exists: true, ...parsed, pidAlive, raw }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { path, exists: false, startedAt: null, pid: null, pidAlive: null, log: null, cwd: null, statePath: null, command: null, requireBrowserEvidence: null, raw: null }
		}
		return { path, exists: true, startedAt: null, pid: null, pidAlive: null, log: null, cwd: null, statePath: null, command: null, requireBrowserEvidence: null, raw: null }
	}
}

function parseLoopFile(raw: string): Omit<StatusLoopFileSnapshot, "path" | "exists" | "pidAlive" | "raw"> {
	const fields: Record<string, string> = {}
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":")
		if (separator <= 0) continue
		fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
	}
	const pid = fields.pid === undefined || fields.pid === "" ? null : Number(fields.pid)
	return {
		startedAt: fields.started ?? null,
		pid: pid === null || Number.isInteger(pid) ? pid : null,
		log: fields.log ?? null,
		cwd: fields.cwd ?? null,
		statePath: fields.state ?? null,
		command: fields.command ?? null,
		requireBrowserEvidence: parseLoopFileBoolean(fields.requireBrowserEvidence),
	}
}

function parseLoopFileBoolean(value: string | undefined): boolean | null {
	if (value === undefined) return null
	if (value === "true") return true
	if (value === "false") return false
	return null
}

function scanLoopProcesses(targetCwd: string): StatusReadResult<StatusProcessInfo[]> {
	const proc = Bun.spawnSync({
		cmd: ["ps", "-axo", "pid=,ppid=,command="],
		stdout: "pipe",
		stderr: "pipe",
	})
	if (proc.exitCode !== 0) return { kind: "invalid", message: new TextDecoder().decode(proc.stderr).trim() || "ps scan failed" }
	const stdout = new TextDecoder().decode(proc.stdout)
	const live: StatusProcessInfo[] = []
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		const ppid = Number(match[2])
		const commandText = match[3] ?? ""
		const invokesLoop = commandText.includes("src/loop.ts") || /(^|\s)coder-loop(\s|$)/.test(commandText)
		const looksLikeLoop = invokesLoop && !/(^|\s)(status|daemon|install|uninstall|doctor)(\s|$)/.test(commandText)
		const matchesTarget = commandText.includes(targetCwd)
		if (!looksLikeLoop) continue
		live.push({
			pid,
			ppid: Number.isInteger(ppid) ? ppid : null,
			command: commandText,
			cwd: null,
			matchesTarget,
			alive: true,
			source: "ps",
		})
	}
	return { kind: "ok", value: live }
}

function mergeProcessSnapshots(left: StatusProcessInfo[], right: StatusProcessInfo[]): StatusProcessInfo[] {
	const byKey = new Map<string, StatusProcessInfo>()
	for (const entry of [...left, ...right]) byKey.set(`${entry.source}:${entry.pid}`, entry)
	return [...byKey.values()]
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export type DaemonStartPlan = {
	targetCwd: string
	chainName: string
	socketPath: string
	pidPath: string
	dbPath: string
	rootDir: string
	schedulerIntervalMs: number
	spawnAgents: boolean
	command: string[]
	commandLine: string
	stdoutPath: string
	stderrPath: string
	requireBrowserEvidence: boolean
}

type DaemonTargetImportTrace = {
	cmd: string
	issue?: number
	ok: boolean
	error?: string
}

type DaemonTargetImportResult = {
	chainName: string
	chain: JsonObject
	legacyStatePath: string
	legacyStateFound: boolean
	itemsSeen: number
	imported: number
	updated: number
	skipped: number
	trace: DaemonTargetImportTrace[]
}

type DaemonTargetStatusResult = {
	action: "status"
	target: string
	socketPath: string
	chainName: string
	daemon: DaemonResponse
	chain: JsonObject | null
	chainError: string | null
	items: JsonValue[]
	slots: JsonValue[]
}

type DaemonStartResult = {
	action: "start"
	target: string
	socketPath: string
	pidPath: string
	dbPath: string
	daemon: {
		started: boolean
		pid: number | null
		command: string[]
		stdoutPath: string
		stderrPath: string
		spawnAgents: boolean
	}
	import: DaemonTargetImportResult
	status: DaemonTargetStatusResult
	requireBrowserEvidence: boolean
}

type DaemonStopPlan = {
	action: "stop"
	target: string
	socketPath: string
	chainName: string
}

type DaemonStopResult = DaemonStopPlan & {
	stopped: true
	updated: number
	items: JsonValue[]
	daemon: DaemonResponse
}

export function buildDaemonStartPlan(args: Extract<DaemonCommandArgs, { action: "start" }>): DaemonStartPlan {
	const targetCwd = resolve(args.targetCwd)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const options = daemonServerOptionsFromIpc(args.ipc)
	const defaults = daemonDefaults(options)
	const chainName = defaultMigratedChainName(targetCwd, args.repository)
	const daemonUpDir = chainRuntimePaths(defaults.rootDir, chainName).daemonRunDir(timestamp)
	const stdoutPath = resolve(daemonUpDir, "up.stdout.log")
	const stderrPath = resolve(daemonUpDir, "up.stderr.log")
	const command = [
		process.argv[0] ?? "bun",
		resolve(import.meta.dir, "loop.ts"),
		"daemon",
		"up",
	]
	command.push("--root", defaults.rootDir)
	command.push("--socket", defaults.socketPath)
	command.push("--pid", defaults.pidPath)
	command.push("--db", defaults.dbPath)
	command.push("--log-chain", chainName)
	command.push("--scheduler-interval-ms", String(defaults.schedulerIntervalMs))
	if (!defaults.spawnAgents) command.push("--no-spawn-agents")
	return {
		targetCwd,
		chainName,
		socketPath: defaults.socketPath,
		pidPath: defaults.pidPath,
		dbPath: defaults.dbPath,
		rootDir: defaults.rootDir,
		schedulerIntervalMs: defaults.schedulerIntervalMs,
		spawnAgents: defaults.spawnAgents,
		command,
		commandLine: command.map(shellQuote).join(" "),
		stdoutPath,
		stderrPath,
		requireBrowserEvidence: args.requireBrowserEvidence,
	}
}

async function runDaemonStartCommand(args: Extract<DaemonCommandArgs, { action: "start" }>): Promise<void> {
	const plan = buildDaemonStartPlan(args)
	if (args.dryRun) {
		process.stdout.write([
			`daemon start dry-run: target=${plan.targetCwd}`,
			`daemon start dry-run: socket=${plan.socketPath}`,
			`daemon start dry-run: daemon-up-command=${plan.commandLine}`,
			`daemon start dry-run: require-browser-evidence=${plan.requireBrowserEvidence}`,
			`daemon start dry-run: spawn-agents=${plan.spawnAgents}`,
			`daemon start dry-run: stdout=${plan.stdoutPath}`,
			`daemon start dry-run: stderr=${plan.stderrPath}`,
			"",
		].join("\n"))
		return
	}
	const result = await executeDaemonStart(args, plan)
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

async function executeDaemonStart(args: Extract<DaemonCommandArgs, { action: "start" }>, plan = buildDaemonStartPlan(args)): Promise<DaemonStartResult> {
	const probe = await probeDaemon(plan.socketPath)
	let started = false
	let pid: number | null = null
	if (!probe.reachable) {
		pid = await startDetachedDaemon(plan)
		started = true
		await waitForDaemonReady(plan.socketPath)
	}
	const imported = await importTargetStateViaDaemon(args, plan.socketPath)
	const status = await buildDaemonTargetStatus({
		action: "status",
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		repository: args.repository,
		output: "json",
		ipc: args.ipc,
	})
	return {
		action: "start",
		target: plan.targetCwd,
		socketPath: plan.socketPath,
		pidPath: plan.pidPath,
		dbPath: plan.dbPath,
		daemon: {
			started,
			pid,
			command: plan.command,
			stdoutPath: plan.stdoutPath,
			stderrPath: plan.stderrPath,
			spawnAgents: plan.spawnAgents,
		},
		import: imported,
		status,
		requireBrowserEvidence: plan.requireBrowserEvidence,
	}
}

async function runDaemonStopCommand(args: Extract<DaemonCommandArgs, { action: "stop" }>): Promise<void> {
	const plan = buildDaemonStopPlan(args)
	if (args.dryRun) {
		process.stdout.write(JSON.stringify({ ...plan, dryRun: true }, null, "\t") + "\n")
		return
	}
	const result = await executeDaemonStop(plan)
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function buildDaemonStopPlan(args: Extract<DaemonCommandArgs, { action: "stop" }>): DaemonStopPlan {
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const targetCwd = resolve(args.targetCwd)
	return {
		action: "stop",
		target: targetCwd,
		socketPath: defaults.socketPath,
		chainName: defaultChainNameForTarget(targetCwd),
	}
}

async function executeDaemonStop(plan: DaemonStopPlan): Promise<DaemonStopResult> {
	const daemon = await sendDaemonRequest(plan.socketPath, { cmd: "daemon.status" })
	const chainName = await resolveDaemonChainNameForTarget(plan.socketPath, plan.target, plan.chainName)
	const chainResponse = await sendDaemonRequest(plan.socketPath, { cmd: "chain.get", chain: chainName })
	if (!chainResponse.ok) return { ...plan, chainName, stopped: true, updated: 0, items: [], daemon }
	const items = await listDaemonItemsForTarget(plan.socketPath, chainName, plan.target)
	let updated = 0
	const stoppedItems: JsonValue[] = []
	for (const item of items) {
		if (!isObjectRecord(item) || typeof item.id !== "number") continue
		const response = await sendDaemonRequest(plan.socketPath, {
			cmd: "item.update",
			itemId: item.id,
			patch: { status: "paused" },
		})
		if (!response.ok) throw new Error(`item.update ${item.id}: ${response.error}`)
		updated++
		stoppedItems.push(response.data)
	}
	return { ...plan, chainName, stopped: true, updated, items: stoppedItems, daemon }
}

async function runDaemonRestartCommand(args: Extract<DaemonCommandArgs, { action: "restart" }>): Promise<void> {
	const requireBrowserEvidence = args.requireBrowserEvidence
	if (args.dryRun) {
		const startPlan = buildDaemonStartPlan({ ...args, action: "start", requireBrowserEvidence })
		process.stdout.write(JSON.stringify({
			action: "restart",
			target: startPlan.targetCwd,
			dryRun: true,
			stop: buildDaemonStopPlan({ ...args, action: "stop" }),
			start: { command: startPlan.command, commandLine: startPlan.commandLine },
		}, null, "\t") + "\n")
		return
	}
	const stopped = await executeDaemonStop(buildDaemonStopPlan({ ...args, action: "stop" }))
	const started = await executeDaemonStart({ ...args, action: "start", requireBrowserEvidence, maxIterations: args.maxIterations, dryRun: false })
	process.stdout.write(JSON.stringify({
		action: "restart",
		target: resolve(args.targetCwd),
		stopped,
		started,
	}, null, "\t") + "\n")
}

async function runDaemonTargetStatusCommand(args: Extract<DaemonCommandArgs, { action: "status" }>): Promise<void> {
	const status = await buildDaemonTargetStatus(args)
	process.stdout.write(JSON.stringify(status, null, "\t") + "\n")
}

async function buildDaemonTargetStatus(args: Extract<DaemonCommandArgs, { action: "status" }>): Promise<DaemonTargetStatusResult> {
	const target = resolve(args.targetCwd)
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const fallbackChainName = defaultChainNameForTarget(target)
	const daemonProbe = await probeDaemon(defaults.socketPath)
	if (!daemonProbe.reachable) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName: fallbackChainName,
			daemon: { ok: false, error: daemonProbe.error },
			chain: null,
			chainError: daemonProbe.error,
			items: [],
			slots: [],
		}
	}
	const daemon = daemonProbe.response
	let chainName = fallbackChainName
	try {
		chainName = await resolveDaemonChainNameForTarget(defaults.socketPath, target, fallbackChainName)
	} catch (error) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName: fallbackChainName,
			daemon,
			chain: null,
			chainError: errorMessage(error),
			items: [],
			slots: [],
		}
	}
	const chainResponse = await sendDaemonRequest(defaults.socketPath, { cmd: "chain.get", chain: chainName })
	if (!chainResponse.ok) {
		return {
			action: "status",
			target,
			socketPath: defaults.socketPath,
			chainName,
			daemon,
			chain: null,
			chainError: chainResponse.error,
			items: [],
			slots: [],
		}
	}
	const chain = requireJsonObject(chainResponse.data, "chain.get")
	const items = await listDaemonItemsForTarget(defaults.socketPath, chainName, target)
	const slotResponse = await sendDaemonRequest(defaults.socketPath, { cmd: "slot.list" })
	const allSlots = slotResponse.ok && Array.isArray(slotResponse.data) ? slotResponse.data : []
	const slots = allSlots.filter((slot) => daemonSlotMatchesTarget(slot, chain, target))
	return {
		action: "status",
		target,
		socketPath: defaults.socketPath,
		chainName,
		daemon,
		chain,
		chainError: null,
		items,
		slots,
	}
}

function daemonServerOptionsFromIpc(ipc: DaemonTargetIpcOptions): DaemonServerOptions {
	const options: DaemonServerOptions = { spawnAgents: ipc.spawnAgents }
	if (ipc.socketPath !== null) options.socketPath = ipc.socketPath
	if (ipc.pidPath !== null) options.pidPath = ipc.pidPath
	if (ipc.dbPath !== null) options.dbPath = ipc.dbPath
	if (ipc.rootDir !== null) options.rootDir = ipc.rootDir
	if (ipc.schedulerIntervalMs !== null) options.schedulerIntervalMs = ipc.schedulerIntervalMs
	return options
}

async function probeDaemon(socketPath: string): Promise<{ reachable: true; response: DaemonResponse } | { reachable: false; error: string }> {
	try {
		return { reachable: true, response: await sendDaemonRequest(socketPath, { cmd: "daemon.status" }, 1_000) }
	} catch (error) {
		return { reachable: false, error: errorMessage(error) }
	}
}

async function startDetachedDaemon(plan: DaemonStartPlan): Promise<number | null> {
	await mkdir(plan.rootDir, { recursive: true })
	await mkdir(dirname(plan.stdoutPath), { recursive: true })
	await mkdir(dirname(plan.stderrPath), { recursive: true })
	const stdoutFd = openSync(plan.stdoutPath, "a")
	const stderrFd = openSync(plan.stderrPath, "a")
	try {
		const child = spawn(plan.command[0]!, plan.command.slice(1), {
			cwd: plan.targetCwd,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		})
		child.unref()
		return child.pid ?? null
	} finally {
		closeSync(stdoutFd)
		closeSync(stderrFd)
	}
}

async function waitForDaemonReady(socketPath: string): Promise<void> {
	const deadline = Date.now() + 5_000
	let lastError = "daemon did not become ready"
	while (Date.now() < deadline) {
		const probe = await probeDaemon(socketPath)
		if (probe.reachable) return
		lastError = probe.error
		await sleep(100)
	}
	throw new Error(`daemon start timed out waiting for ${socketPath}: ${lastError}`)
}

async function importTargetStateViaDaemon(args: Extract<DaemonCommandArgs, { action: "start" }>, socketPath: string): Promise<DaemonTargetImportResult> {
	const options = await loadLoopOptionsForTarget(args.targetCwd, args.configPath, args.repository)
	const targetCwd = options.targetCwd
	const defaults = daemonDefaults(daemonServerOptionsFromIpc(args.ipc))
	const chainName = await resolveDaemonChainNameForTarget(
		socketPath,
		targetCwd,
		defaultMigratedChainName(targetCwd, options.repository),
	)
	const trace: DaemonTargetImportTrace[] = []
	const db = openStateDb(defaults.dbPath)
	try {
		const result = await migrateStateJson(targetCwd, db, {
			rootDir: defaults.rootDir,
			statePath: legacyStatePathForDaemonImport(options),
			chainName,
			preset: options.preset.name,
			repository: options.repository,
			baseBranch: options.baseBranch,
			allowMissingState: true,
			onDuplicate: "update",
			backupState: true,
		})
		trace.push({ cmd: "chain.upsert", ok: true })
		for (const item of result.items) trace.push({ cmd: result.itemsUpdated > 0 ? "item.upsert" : "item.add", issue: item.issue, ok: true })
		for (const skipped of result.skipped) {
			const entry: DaemonTargetImportTrace = { cmd: "item.skip", ok: true }
			if (skipped.issue !== null) entry.issue = skipped.issue
			trace.push(entry)
		}
		return {
			chainName: result.chain.name,
			chain: result.chain as unknown as JsonObject,
			legacyStatePath: result.legacyStatePath,
			legacyStateFound: result.legacyStateFound,
			itemsSeen: result.itemsSeen,
			imported: result.itemsInserted,
			updated: result.itemsUpdated,
			skipped: result.skipped.length,
			trace,
		}
	} finally {
		db.close()
	}
}

async function readDaemonChainIfExists(socketPath: string, chainName: string): Promise<JsonObject | null> {
	const response = await sendDaemonRequest(socketPath, { cmd: "chain.get", chain: chainName })
	if (!response.ok) return null
	return isJsonObject(response.data) ? response.data : null
}

function optionalStringFromJsonObject(value: JsonObject | null, key: string): string | null {
	if (value === null) return null
	const raw = value[key]
	return typeof raw === "string" ? raw : null
}

function optionalNumberFromJsonObject(value: JsonObject | null, key: string): number | null {
	if (value === null) return null
	const raw = value[key]
	return typeof raw === "number" && Number.isInteger(raw) ? raw : null
}

function legacyStatePathForDaemonImport(options: LoopOptions): string {
	return existsSync(options.configPath)
		? options.statePath
		: resolve(options.targetCwd, DEFAULT_STATE_FILE)
}

async function readLegacyTargetQueue(statePath: string): Promise<{ found: boolean; queue: unknown[] }> {
	const raw = await readFile(statePath, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	})
	if (raw === null) return { found: false, queue: [] }
	const parsed: unknown = JSON.parse(raw)
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.queue)) throw new Error(`${statePath}: expected state object with queue array`)
	return { found: true, queue: parsed.queue }
}

function daemonImportTrace(cmd: string, issue: number | undefined, response: DaemonResponse): DaemonTargetImportTrace {
	const entry: DaemonTargetImportTrace = { cmd, ok: response.ok }
	if (issue !== undefined) entry.issue = issue
	if (!response.ok) entry.error = response.error
	return entry
}

function itemAddRequestFromQueueEntry(entry: unknown, chainName: string, targetCwd: string): Extract<DaemonRequest, { cmd: "item.add" }> | null {
	if (!isObjectRecord(entry) || typeof entry.issue !== "number" || !Number.isInteger(entry.issue)) return null
	const request: Extract<DaemonRequest, { cmd: "item.add" }> = {
		cmd: "item.add",
		chain: chainName,
		issue: entry.issue,
		repoCwd: targetCwd,
		extra: importExtraFromQueueEntry(entry),
	}
	if (typeof entry.status === "string") request.status = entry.status
	if (typeof entry.priority === "string") request.priority = entry.priority
	if (typeof entry.attempts === "number" && Number.isInteger(entry.attempts)) request.attempts = entry.attempts
	const title = nullableStringFromEntry(entry.title)
	if (title !== undefined) request.title = title
	const branch = nullableStringFromEntry(entry.branch)
	if (branch !== undefined) request.branch = branch
	const pr = nullableIntegerFromEntry(entry.pr)
	if (pr !== undefined) request.pr = pr
	const lastRunId = nullableStringFromEntry(entry.lastRunId)
	if (lastRunId !== undefined) request.lastRunId = lastRunId
	const issueFile = nullableStringFromEntry(entry.issueFile)
	if (issueFile !== undefined) request.issueFile = issueFile
	const evidenceDir = nullableStringFromEntry(entry.evidenceDir)
	if (evidenceDir !== undefined) request.evidenceDir = evidenceDir
	const agentCwd = nullableStringFromEntry(entry.agentCwd)
	if (agentCwd !== undefined) request.agentCwd = agentCwd
	if (entry.runner === "claude" || entry.runner === "codex" || entry.runner === null) request.runner = entry.runner
	return request
}

function nullableStringFromEntry(value: unknown): string | null | undefined {
	if (typeof value === "string") return value
	if (value === null) return null
	return undefined
}

function nullableIntegerFromEntry(value: unknown): number | null | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value
	if (value === null) return null
	return undefined
}

const DAEMON_IMPORT_BASE_KEYS = new Set([
	"issue",
	"status",
	"attempts",
	"title",
	"priority",
	"branch",
	"pr",
	"lastRunId",
	"issueFile",
	"evidenceDir",
	"agentCwd",
	"runner",
	"extra",
])

function importExtraFromQueueEntry(entry: Record<string, unknown>): JsonObject {
	const extra: JsonObject = isJsonObject(entry.extra) ? { ...entry.extra } : {}
	for (const [key, value] of Object.entries(entry)) {
		if (DAEMON_IMPORT_BASE_KEYS.has(key)) continue
		if (isJsonValue(value)) extra[key] = value
	}
	return extra
}

async function updateDuplicateDaemonItem(
	socketPath: string,
	chainName: string,
	request: Extract<DaemonRequest, { cmd: "item.add" }>,
	trace: DaemonTargetImportTrace[],
): Promise<void> {
	const existing = await findDaemonItem(socketPath, chainName, request.issue, request.repoCwd)
	if (existing === null || typeof existing.id !== "number") throw new Error(`item.add ${request.issue}: duplicate row was not found by item.list`)
	const response = await sendDaemonRequest(socketPath, {
		cmd: "item.update",
		itemId: existing.id,
		patch: itemPatchFromImportRequest(request),
	})
	trace.push(daemonImportTrace("item.update", request.issue, response))
	if (!response.ok) throw new Error(`item.update ${existing.id}: ${response.error}`)
}

async function findDaemonItem(socketPath: string, chainName: string, issue: number, repoCwd: string): Promise<JsonObject | null> {
	const items = await listDaemonItemsForTarget(socketPath, chainName, repoCwd)
	for (const item of items) {
		if (!isObjectRecord(item) || Array.isArray(item)) continue
		if (item.issue === issue && item.repoCwd === repoCwd) return item as JsonObject
	}
	return null
}

function itemPatchFromImportRequest(request: Extract<DaemonRequest, { cmd: "item.add" }>): Extract<DaemonRequest, { cmd: "item.update" }>["patch"] {
	const patch: Extract<DaemonRequest, { cmd: "item.update" }>["patch"] = {}
	if (request.status !== undefined) patch.status = request.status
	if (request.priority !== undefined) patch.priority = request.priority
	if (request.attempts !== undefined) patch.attempts = request.attempts
	if (request.title !== undefined) patch.title = request.title
	if (request.branch !== undefined) patch.branch = request.branch
	if (request.pr !== undefined) patch.pr = request.pr
	if (request.lastRunId !== undefined) patch.lastRunId = request.lastRunId
	if (request.issueFile !== undefined) patch.issueFile = request.issueFile
	if (request.evidenceDir !== undefined) patch.evidenceDir = request.evidenceDir
	if (request.agentCwd !== undefined) patch.agentCwd = request.agentCwd
	if (request.runner !== undefined) patch.runner = request.runner
	if (request.extra !== undefined) patch.extra = request.extra
	return patch
}

async function listDaemonItemsForTarget(socketPath: string, chainName: string, targetCwd: string): Promise<JsonValue[]> {
	const response = await sendDaemonRequest(socketPath, { cmd: "item.list", chain: chainName })
	if (!response.ok) throw new Error(`item.list ${chainName}: ${response.error}`)
	if (!Array.isArray(response.data)) throw new Error(`item.list ${chainName}: expected array`)
	return response.data.filter((item) => isObjectRecord(item) && item.repoCwd === targetCwd)
}

function daemonSlotMatchesTarget(slot: JsonValue, chain: JsonObject, targetCwd: string): boolean {
	return isObjectRecord(slot)
		&& slot.chainId === chain.id
		&& slot.repoCwd === targetCwd
}

async function resolveDaemonChainNameForTarget(socketPath: string, targetCwdInput: string, fallbackName: string): Promise<string> {
	const targetCwd = resolve(targetCwdInput)
	const listResponse = await sendDaemonRequest(socketPath, { cmd: "chain.list" })
	if (!listResponse.ok) throw new Error(`chain.list: ${listResponse.error}`)
	if (!Array.isArray(listResponse.data)) throw new Error("chain.list: expected array")
	const matches: string[] = []
	for (const entry of listResponse.data) {
		if (!isObjectRecord(entry) || typeof entry.name !== "string" || typeof entry.id !== "number") continue
		const metadata = isObjectRecord(entry.metadata) ? entry.metadata : {}
		if (typeof metadata.targetCwd === "string" && resolve(metadata.targetCwd) === targetCwd) {
			matches.push(entry.name)
			continue
		}
		const itemResponse = await sendDaemonRequest(socketPath, { cmd: "item.list", chain: entry.name })
		if (!itemResponse.ok || !Array.isArray(itemResponse.data)) continue
		if (itemResponse.data.some((item) => isObjectRecord(item) && typeof item.repoCwd === "string" && resolve(item.repoCwd) === targetCwd)) {
			matches.push(entry.name)
		}
	}
	if (matches.length === 1) return matches[0]!
	if (matches.length > 1) throw new Error(`target-cwd ${targetCwd} belongs to multiple chains: ${matches.join(", ")}`)
	return fallbackName
}

function requireJsonObject(value: JsonValue, label: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${label}: expected object response`)
	return value
}

export type QueueUnblockMutationOutcome =
	| {
			changed: true
			issue: string
			beforeStatus: "blocked"
			afterStatus: "queued"
			clearedBlockerRepo: boolean
			clearedBlockerRef: boolean
			clearedCurrent: boolean
	  }
	| {
			changed: false
			issue: string
			reason: "not_found"
	  }
	| {
			changed: false
			issue: string
			reason: "not_blocked"
			status: string
	  }

type QueueUnblockCommandResult = {
	action: "queue.unblock"
	target: string
	repository: string | null
	statePath: string
	issue: string
	dryRun: boolean
	mutation: QueueUnblockMutationOutcome
	daemon:
		| { requested: false; skipped: true; reason: "not_requested" | "no_requeue_needed" }
		| { requested: true; dryRun: true; plan: DaemonStartPlan }
		| { requested: true; dryRun: false; result: DaemonStartResult }
	verification: {
		itemStatus: string | null
		blockerRepoPresent: boolean | null
		blockerRefPresent: boolean | null
		stateKind: StatusStateKind
		daemonRunning: boolean
	}
}

async function runQueueUnblockCommand(args: QueueUnblockCommandArgs): Promise<void> {
	const options = await loadLoopOptionsForTarget(args.targetCwd, args.configPath, args.repository)
	assertQueueUnblockSupported(options.preset)
	const issue = normalizeQueueIssueId(args.issue)
	const state = await loadState(options.statePath)
	const mutation = requeueBlockedItem(state, options.preset, issue)
	if (!mutation.changed && mutation.reason === "not_found") {
		fail(`queue unblock: issue ${issue} not found in ${options.statePath}`)
	}

	let daemon: QueueUnblockCommandResult["daemon"]
	if (!mutation.changed) {
		daemon = { requested: false, skipped: true, reason: "no_requeue_needed" }
	} else if (!args.startDaemon) {
		daemon = { requested: false, skipped: true, reason: "not_requested" }
	} else if (args.dryRun) {
		daemon = {
			requested: true,
			dryRun: true,
			plan: buildDaemonStartPlan({
				action: "start",
				targetCwd: options.targetCwd,
				configPath: args.configPath,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: true,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				ipc: defaultDaemonIpcOptions(),
			}),
		}
	} else {
		await saveState(options.statePath, state)
		daemon = {
			requested: true,
			dryRun: false,
			result: await executeDaemonStart({
				action: "start",
				targetCwd: options.targetCwd,
				configPath: args.configPath,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: false,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				ipc: defaultDaemonIpcOptions(),
			}),
		}
	}

	if (mutation.changed && !args.dryRun && !args.startDaemon) {
		await saveState(options.statePath, state)
	}

	const verificationState = args.dryRun ? state : await loadState(options.statePath)
	const item = findQueueItemById(verificationState, options.preset, issue)
	const statusSnapshot = await buildCoderLoopStatusSnapshot({
		targetCwd: options.targetCwd,
		configPath: args.configPath,
		repository: options.repository,
		output: "json",
	})
	const daemonRunning = daemonResultIndicatesRunning(daemon) || findOwnedLiveProcess(statusSnapshot) !== null
	const result: QueueUnblockCommandResult = {
		action: "queue.unblock",
		target: options.targetCwd,
		repository: options.repository,
		statePath: options.statePath,
		issue,
		dryRun: args.dryRun,
		mutation,
		daemon,
		verification: {
			itemStatus: item?.status ?? null,
			blockerRepoPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRepo"),
			blockerRefPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRef"),
			stateKind: statusSnapshot.state.kind,
			daemonRunning,
		},
	}
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function daemonResultIndicatesRunning(daemon: QueueUnblockCommandResult["daemon"]): boolean {
	if (!daemon.requested) return false
	if (daemon.dryRun) return false
	return daemon.result.status.daemon.ok
}

async function loadLoopOptionsForTarget(targetCwdInput: string, configPathInput: string | null, repository: string | null): Promise<LoopOptions> {
	const targetCwd = resolve(targetCwdInput)
	const configPath = await resolveConfigPath(targetCwd, configPathInput)
	const config = await loadConfig(configPath)
	const presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	return buildOptions(targetCwd, configPath, makeStatusRawArgs({
		targetCwd,
		configPath: configPathInput,
		repository,
		output: "json",
	}), config, preset)
}

function assertQueueUnblockSupported(preset: Preset): void {
	if (!preset.statuses.terminal.includes("blocked") || !preset.statuses.continuable.includes("queued")) {
		fail(`queue unblock: preset "${preset.name}" must declare terminal status "blocked" and continuable status "queued"`)
	}
}

export function normalizeQueueIssueId(raw: string): string {
	const trimmed = raw.trim()
	if (trimmed === "") fail("queue unblock: --issue must not be empty")
	if (/\s/.test(trimmed)) fail(`queue unblock: --issue must not contain whitespace: ${raw}`)
	const crossRepoMatch = /^[^/\s]+\/[^#\s]+#(.+)$/.exec(trimmed)
	const value = crossRepoMatch ? crossRepoMatch[1]! : trimmed
	const normalized = value.startsWith("#") ? value.slice(1) : value
	if (normalized.trim() === "") fail(`queue unblock: --issue did not include an issue id: ${raw}`)
	return normalized
}

export function requeueBlockedItem(state: LoopState, preset: Preset, issue: string): QueueUnblockMutationOutcome {
	const item = findQueueItemById(state, preset, issue)
	if (item === null) return { changed: false, issue, reason: "not_found" }
	if (item.status !== "blocked") return { changed: false, issue, reason: "not_blocked", status: item.status }

	const clearedBlockerRepo = hasOwnJsonKey(item.extra, "blockerRepo")
	const clearedBlockerRef = hasOwnJsonKey(item.extra, "blockerRef")
	item.status = "queued"
	delete item.extra.blockerRepo
	delete item.extra.blockerRef

	let clearedCurrent = false
	if (state.current !== null) {
		try {
			if (getCurrentId(state.current, preset) === issue) {
				state.current = null
				clearedCurrent = true
			}
		} catch {
			// Leave unrelated malformed current state for the runtime checker to report.
		}
	}

	return {
		changed: true,
		issue,
		beforeStatus: "blocked",
		afterStatus: "queued",
		clearedBlockerRepo,
		clearedBlockerRef,
		clearedCurrent,
	}
}

function findQueueItemById(state: LoopState, preset: Preset, issue: string): QueueItem | null {
	return state.queue.find((item) => getItemId(item, preset) === issue) ?? null
}

function hasOwnJsonKey(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function findOwnedLiveProcess(snapshot: CoderLoopStatusSnapshot): StatusProcessInfo | null {
	return snapshot.processes.live.find((entry) => entry.alive && entry.matchesTarget) ?? null
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true
		await sleep(50)
	}
	return !isPidAlive(pid)
}

export async function loadPreset(presetDir: string): Promise<Preset> {
	const tomlPath = resolve(presetDir, "preset.toml")
	const raw = await readFile(tomlPath, "utf-8")
	const parsed: unknown = Bun.TOML.parse(raw)
	const preset = parsePreset(parsed, presetDir)
	for (const phase of preset.phases) {
		await assertReadable(phase.prompt, `preset phase "${phase.name}" prompt`)
	}
	for (const fragment of preset.fragments) {
		await assertReadable(fragment.path, `preset fragment "${fragment.id}"`)
	}
	return preset
}

export function parsePreset(value: unknown, presetDir: string): Preset {
	const root = assertArk(PresetTomlBoundary, value, "preset")

	for (const status of root.statuses.continuable) {
		if (root.statuses.terminal.includes(status)) presetError(`preset.statuses: "${status}" appears in both continuable and terminal`)
	}
	const attemptTimeoutSeconds = root.agent.attemptTimeoutSeconds ?? DEFAULT_ATTEMPT_TIMEOUT_SECONDS
	if (!Number.isFinite(attemptTimeoutSeconds) || attemptTimeoutSeconds <= 0) {
		presetError("preset.agent.attemptTimeoutSeconds: must be a finite positive number")
	}

	const phaseNames = new Set<string>()
	const phases: PresetPhase[] = []
	for (const [index, entry] of root.phases.entries()) {
		if (phaseNames.has(entry.name)) presetError(`preset.phases[${index}].name: duplicate name "${entry.name}"`)
		phaseNames.add(entry.name)
		const variablesRaw = entry.variables ?? {}
		if (!isObjectRecord(variablesRaw)) presetError(`preset.phases[${index}].variables: must be an object`)
		const variables: Array<readonly [string, PresetVariableSource]> = []
		for (const [key, val] of Object.entries(variablesRaw)) {
			if (typeof val !== "string") presetError(`preset.phases[${index}].variables.${key}: must be a string`)
			const source = parseVariableSource(val, `preset.phases[${index}].variables.${key}`)
			if (source.kind === "item" && !QUEUE_ITEM_BASE_KEYS.has(source.field) && source.field !== root.item.idField) {
				presetError(`preset.phases[${index}].variables.${key}: unknown item field "${source.field}" (known base fields: ${[...QUEUE_ITEM_BASE_KEYS].join(", ")}; idField: ${root.item.idField})`)
			}
			variables.push([key, source] as const)
		}
		const trigger = entry.trigger
			? { afterPhase: entry.trigger.afterPhase, whenStatus: entry.trigger.whenStatus }
			: null
		phases.push({ name: entry.name, prompt: resolve(presetDir, entry.prompt), variables, trigger })
	}
	if (!phases.some((phase) => phase.trigger === null)) presetError("preset.phases: must include at least one non-trigger phase")

	const statuses = new Set<string>([...root.statuses.continuable, ...root.statuses.terminal])
	for (const [index, phase] of phases.entries()) {
		if (phase.trigger === null) continue
		if (!phaseNames.has(phase.trigger.afterPhase)) {
			presetError(`preset.phases[${index}].trigger.afterPhase: unknown phase "${phase.trigger.afterPhase}"`)
		}
		if (!statuses.has(phase.trigger.whenStatus)) {
			presetError(`preset.phases[${index}].trigger.whenStatus: unknown status "${phase.trigger.whenStatus}"`)
		}
	}

	const fragmentIds = new Set<string>()
	const fragments: PresetFragment[] = []
	for (const [index, entry] of (root.fragments ?? []).entries()) {
		if (fragmentIds.has(entry.id)) presetError(`preset.fragments[${index}].id: duplicate id "${entry.id}"`)
		fragmentIds.add(entry.id)
		fragments.push({ id: entry.id, role: entry.role, path: resolve(presetDir, entry.path) })
	}

	return {
		name: root.name,
		version: root.version,
		description: root.description ?? "",
		presetDir,
		item: { idField: root.item.idField },
		statuses: { continuable: root.statuses.continuable, terminal: root.statuses.terminal },
		phases,
		fragments,
		agent: { binary: root.agent.binary, extraArgs: root.agent.extraArgs ?? [], attemptTimeoutSeconds },
	}
}

function parseVariableSource(value: string, label: string): PresetVariableSource {
	const match = /^(item|config|runtime)\.([a-zA-Z][a-zA-Z0-9_]*)$/.exec(value)
	if (!match) presetError(`${label}: invalid variable source "${value}" (expected item.<f> | config.<f> | runtime.<k>)`)
	const kind = match[1] as "item" | "config" | "runtime"
	const fieldOrKey = match[2]!
	return kind === "runtime" ? { kind, key: fieldOrKey } : { kind, field: fieldOrKey }
}

function presetError(message: string): never {
	throw new Error(message)
}


export type ConfigFormat = "json" | "toml"

export function configFormatForPath(path: string): ConfigFormat {
	if (path.endsWith(".toml")) return "toml"
	return "json"
}

async function resolveConfigPath(targetCwd: string, override: string | null): Promise<string> {
	if (override !== null) return resolveFrom(targetCwd, override)
	const jsonPath = resolveFrom(targetCwd, DEFAULT_CONFIG_FILE)
	if (await exists(jsonPath)) return jsonPath
	const tomlPath = resolveFrom(targetCwd, DEFAULT_CONFIG_FILE_TOML)
	if (await exists(tomlPath)) return tomlPath
	return jsonPath
}

async function loadConfig(path: string): Promise<LoopConfig> {
	const raw = await readFile(path, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null
		}
		throw error
	})
	if (raw === null) return defaultLoopConfig()
	return parseConfigText(raw, path)
}

function defaultLoopConfig(): LoopConfig {
	return {
		repository: null,
		baseBranch: null,
		worktree: null,
		workflowFile: null,
		sharedContextFile: null,
		stateFile: null,
		issueDir: null,
		evidenceDir: null,
		logDir: null,
		requireAgentBrowserScreenshots: null,
		defaultRunner: null,
		reviewRunner: null,
		claudeBinary: null,
		claudeExtraArgs: [],
		claudeModel: null,
		codexBinary: null,
		codexExtraArgs: [],
		codexModel: null,
		preset: null,
		presetPath: null,
	}
}

function parseConfigText(raw: string, path: string): LoopConfig {
	const format = configFormatForPath(path)
	const parsed: unknown = format === "toml" ? Bun.TOML.parse(raw) : JSON.parse(raw)
	const input = assertArk(StatusConfigBoundary, parsed, "config")
	return loopConfigFromStatusInput(input)
}

function loopConfigFromStatusInput(input: StatusConfigInput): LoopConfig {
	return {
		repository: input.repository ?? null,
		baseBranch: input.baseBranch ?? null,
		worktree: input.worktree ?? null,
		workflowFile: input.workflowFile ?? null,
		sharedContextFile: input.sharedContextFile ?? null,
		stateFile: input.stateFile ?? null,
		issueDir: input.issueDir ?? null,
		evidenceDir: input.evidenceDir ?? null,
		logDir: input.logDir ?? null,
		requireAgentBrowserScreenshots: input.evidence?.requireAgentBrowserScreenshots ?? null,
		defaultRunner: input.runner ?? null,
		reviewRunner: input.reviewRunner ?? null,
		claudeBinary: input.claude?.binary ?? null,
		claudeExtraArgs: input.claude?.extraArgs ?? [],
		claudeModel: input.claude?.model ?? null,
		codexBinary: input.codex?.binary ?? null,
		codexExtraArgs: input.codex?.extraArgs ?? [],
		codexModel: input.codex?.model ?? null,
		preset: readPresetNameFromStatusInput(input.preset),
		presetPath: input.presetPath ?? null,
	}
}

export function detectHostRunner(env: Record<string, string | undefined>): AgentRunnerKind {
	if (env.CODEX_SHELL === "1" || env.CODEX_THREAD_ID !== undefined || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.toLowerCase().includes("codex") === true) return "codex"
	if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE !== undefined || env.CLAUDE_SESSION_ID !== undefined || env.CLAUDE_PROJECT_DIR !== undefined) return "claude"
	return "claude"
}

function buildAgentRunnerCommands(config: LoopConfig): AgentRunnerCommands {
	return {
		claude: {
			kind: "claude",
			binary: config.claudeBinary ?? "claude",
			extraArgs: config.claudeExtraArgs,
			model: config.claudeModel,
		},
		codex: {
			kind: "codex",
			binary: config.codexBinary ?? "codex",
			extraArgs: config.codexExtraArgs,
			model: config.codexModel,
		},
	}
}

function selectDefaultRunner(configuredRunner: AgentRunnerKind | null, commands: AgentRunnerCommands): AgentRunnerSelection {
	const kind = configuredRunner ?? DEFAULT_ITERATION_RUNNER
	return { ...commands[kind], source: configuredRunner === null ? "iteration-default" : "config" }
}

function selectReviewRunner(configuredRunner: AgentRunnerKind | null, commands: AgentRunnerCommands): AgentRunnerSelection {
	const kind = configuredRunner ?? "claude"
	const command = commands[kind]
	const model = command.kind === "claude" ? CLAUDE_REVIEW_MODEL : command.model
	return { ...command, model, source: configuredRunner === null ? "review-default" : "config" }
}

function selectRunnerForItem(item: QueueItem, options: LoopOptions): AgentRunnerSelection {
	if (item.runner === null) return options.defaultRunner
	return { ...options.runnerCommands[item.runner], source: "queue" }
}

function selectRunnerForPhase(phase: string, item: QueueItem, options: LoopOptions): AgentRunnerSelection {
	const reviewPhase = reviewPhaseForPreset(options.preset)
	if (phase === reviewPhase.name) return options.reviewRunner
	return selectRunnerForItem(item, options)
}

export function reviewPhaseForPreset(preset: Preset): PresetPhase {
	for (let index = preset.phases.length - 1; index >= 0; index--) {
		const phase = preset.phases[index]!
		if (phase.trigger === null) return phase
	}
	fail("preset must define at least one non-trigger phase")
}

export function triggeredPhasesAfter(preset: Preset, afterPhase: string, status: string): readonly PresetPhase[] {
	return preset.phases.filter((phase) => phase.trigger?.afterPhase === afterPhase && phase.trigger.whenStatus === status)
}

function readPresetNameFromStatusInput(value: StatusConfigInput["preset"]): string | null {
	if (value === undefined || value === null) return null
	if (typeof value === "string") return value
	return value.name
}

export function resolvePresetDir(
	config: { preset: string | null; presetPath: string | null },
	pkgRoot: string,
	targetCwd: string,
): string {
	if (config.preset !== null && config.presetPath !== null) {
		throw new Error(`config: "preset" and "presetPath" are mutually exclusive (got preset="${config.preset}", presetPath="${config.presetPath}")`)
	}
	if (config.presetPath !== null) {
		return isAbsolute(config.presetPath) ? config.presetPath : resolve(targetCwd, config.presetPath)
	}
	const name = config.preset ?? DEFAULT_PRESET_NAME
	if (!PRESET_NAME_PATTERN.test(name)) {
		throw new Error(`config.preset: invalid name "${name}" (must match ${PRESET_NAME_PATTERN.source})`)
	}
	return resolve(pkgRoot, "presets", name)
}

async function ensureRuntime(options: LoopOptions): Promise<void> {
	await assertReadable(options.workflowPath, "workflow")
	await assertReadable(options.sharedContextPath, "shared context")
	await assertReadable(options.statePath, "state")
	await mkdir(options.logDir, { recursive: true })
}

async function assertRuntimeValid(options: LoopOptions, state?: LoopState): Promise<void> {
	const runtimeState = state ?? await loadState(options.statePath)
	const errors = await checkRuntime(options, runtimeState)
	if (errors.length === 0) return

	const details = errors.map((error) => `- ${error.path}: ${error.message}`).join("\n")
	fail(`Runtime validation failed:\n${details}`)
}

export async function checkRuntime(
	options: LoopOptions,
	state: LoopState,
	source: RuntimeStateSource = { kind: "file", statePath: options.statePath },
): Promise<RuntimeCheckError[]> {
	const errors: RuntimeCheckError[] = []
	const seenIds = new Set<string>()
	const preset = options.preset
	const idField = preset.item.idField
	const allowedStatuses = new Set<string>([...preset.statuses.continuable, ...preset.statuses.terminal])
	const allowedPhases = new Set<string>(preset.phases.map((phase) => phase.name))

	if (state.version !== 1) pushCheckError(errors, "state.version", "must be 1")
	if (options.repository !== null && state.repository !== options.repository) pushCheckError(errors, "state.repository", `must match configured repository ${options.repository}`)
	if (options.baseBranch !== null && state.baseBranch !== options.baseBranch) pushCheckError(errors, "state.baseBranch", `must match configured baseBranch ${options.baseBranch}`)
	if (options.worktree && (options.baseBranch === null || options.baseBranch.trim() === "")) pushCheckError(errors, "worktree", "worktree mode requires a non-empty baseBranch")

	await checkDirectory(options.targetCwd, "targetCwd", errors)
	await checkFile(options.workflowPath, "workflow", errors)
	if (source.kind === "file") {
		await checkFile(options.configPath, "config", errors)
		await checkFile(options.sharedContextPath, "shared context", errors)
		await checkFile(options.statePath, "state", errors)
		await checkDirectory(options.issueDir, "issueDir", errors)
		await checkDirectory(options.evidenceRootDir, "evidenceDir", errors)
		const runtimeRoot = resolve(options.targetCwd, ".coder-loop/runtime")
		checkInside(options.targetCwd, options.configPath, "config", errors)
		checkInside(options.targetCwd, options.workflowPath, "workflow", errors)
		checkInside(options.targetCwd, options.sharedContextPath, "shared context", errors)
		checkInside(options.targetCwd, options.statePath, "state", errors)
		checkInside(options.targetCwd, options.issueDir, "issueDir", errors)
		checkInside(options.targetCwd, options.evidenceRootDir, "evidenceDir", errors)
		checkInside(runtimeRoot, options.configPath, "config", errors)
		checkInside(runtimeRoot, options.sharedContextPath, "shared context", errors)
		checkInside(runtimeRoot, options.statePath, "state", errors)
		checkInside(runtimeRoot, options.issueDir, "issueDir", errors)
		checkInside(runtimeRoot, options.evidenceRootDir, "evidenceDir", errors)
		if (isWithin(runtimeRoot, options.workflowPath)) pushCheckError(errors, "workflow", "must be project policy outside .coder-loop/runtime")
	} else {
		await checkFile(source.dbPath, "state db", errors)
		await checkDirectory(source.chainPaths.chainDir, "chainDir", errors)
		await checkFile(source.chainPaths.sharedPath, "shared context", errors)
		await checkDirectory(source.chainPaths.issuesDir, "issueDir", errors)
		await checkDirectory(source.chainPaths.evidenceDir, "evidenceDir", errors)
		await checkDirectory(source.chainPaths.runsDir, "runsDir", errors)
		await checkDirectory(source.chainPaths.daemonDir, "daemonDir", errors)
		if (isWithin(source.chainPaths.chainDir, options.workflowPath)) pushCheckError(errors, "workflow", "must be project policy outside loop-data chain runtime")
	}

	for (const [index, item] of state.queue.entries()) {
		const label = `state.queue[${index}]`
		const idValue = item.extra[idField]
		const idLabel = `${label}.${idField}`
		const idAsString = typeof idValue === "string" && idValue.length > 0
			? idValue
			: typeof idValue === "number" && Number.isFinite(idValue)
				? String(idValue)
				: null
		if (idAsString === null) pushCheckError(errors, idLabel, `must be a non-empty string or finite number (preset.item.idField="${idField}")`)
		else {
			if (seenIds.has(idAsString)) pushCheckError(errors, idLabel, `duplicate id "${idAsString}"`)
			seenIds.add(idAsString)
		}
		if (!allowedStatuses.has(item.status)) pushCheckError(errors, `${label}.status`, `status "${item.status}" is not in preset.statuses (continuable + terminal)`)
		if (item.attempts !== null && (!Number.isInteger(item.attempts) || item.attempts < 0)) pushCheckError(errors, `${label}.attempts`, "must be null or a non-negative integer")
		if (item.title !== null && item.title.trim() === "") pushCheckError(errors, `${label}.title`, "must be null or non-empty")
		if (item.priority !== null && item.priority.trim() === "") pushCheckError(errors, `${label}.priority`, "must be null or non-empty")
		if (item.branch !== null && item.branch.trim() === "") pushCheckError(errors, `${label}.branch`, "must be null or non-empty")
		if (item.pr !== null && (!Number.isInteger(item.pr) || item.pr <= 0)) pushCheckError(errors, `${label}.pr`, "must be null or a positive integer")
		if (item.lastRunId !== null && item.lastRunId.trim() === "") pushCheckError(errors, `${label}.lastRunId`, "must be null or non-empty")

		if (item.issueFile !== null) {
			const issueFile = resolveRuntimePath(options, source, item.issueFile, `${label}.issueFile`, source.kind === "chain-db" ? source.chainPaths.issuesDir : options.issueDir, errors)
			if (issueFile) await checkFile(issueFile, `${label}.issueFile`, errors)
		}
		if (item.evidenceDir !== null) {
			const evidenceDir = resolveRuntimePath(options, source, item.evidenceDir, `${label}.evidenceDir`, source.kind === "chain-db" ? source.chainPaths.evidenceDir : options.evidenceRootDir, errors)
			if (evidenceDir) await checkDirectory(evidenceDir, `${label}.evidenceDir`, errors)
		}
		if (item.agentCwd !== null) {
			if (!isAbsolute(item.agentCwd)) {
				pushCheckError(errors, `${label}.agentCwd`, `must be an absolute path (got "${item.agentCwd}")`)
			} else {
				await checkDirectory(item.agentCwd, `${label}.agentCwd`, errors)
			}
		}
	}

	if (state.current) {
		const currentIdValue = state.current.extra[idField]
		const currentIdLabel = `state.current.${idField}`
		const currentIdAsString = typeof currentIdValue === "string" && currentIdValue.length > 0
			? currentIdValue
			: typeof currentIdValue === "number" && Number.isFinite(currentIdValue)
				? String(currentIdValue)
				: null
		if (currentIdAsString === null) {
			pushCheckError(errors, currentIdLabel, `must be a non-empty string or finite number (preset.item.idField="${idField}")`)
		} else {
			const currentItem = state.queue.find((item) => {
				const value = item.extra[idField]
				if (typeof value === "string") return value === currentIdAsString
				if (typeof value === "number") return String(value) === currentIdAsString
				return false
			})
			if (!currentItem) pushCheckError(errors, currentIdLabel, `id "${currentIdAsString}" is not present in queue`)
			else if (!preset.statuses.continuable.includes(currentItem.status)) pushCheckError(errors, currentIdLabel, `id "${currentIdAsString}" has non-continuable status ${currentItem.status}`)
		}
		if (!allowedPhases.has(state.current.phase)) pushCheckError(errors, "state.current.phase", `phase "${state.current.phase}" is not declared in preset.phases`)
		if (state.current.runId.trim() === "") pushCheckError(errors, "state.current.runId", "must not be empty")
		if (!isIsoDateTime(state.current.startedAt)) pushCheckError(errors, "state.current.startedAt", "must be an ISO date string")
	}

	return errors
}

function makeFallbackItem(): QueueItem {
	return {
		status: "",
		attempts: null,
		title: null,
		priority: null,
		branch: null,
		pr: null,
		lastRunId: null,
		issueFile: null,
		evidenceDir: null,
		agentCwd: null,
		runner: null,
		extra: {},
	}
}

async function assertReadable(path: string, label: string): Promise<void> {
	try {
		await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") fail(`Missing ${label} file: ${path}`)
		throw error
	}
}

async function loadState(path: string): Promise<LoopState> {
	const raw = await readFile(path, "utf-8")
	return parseStateText(raw)
}

function parseStateText(raw: string): LoopState {
	const parsed: unknown = JSON.parse(raw)
	const root = assertArk(StatusStateBoundary, parsed, "state")
	return {
		version: root.version,
		queue: root.queue.map((item, index) => parseQueueItem(item, `state.queue[${index}]`)),
		repository: root.repository ?? null,
		baseBranch: root.baseBranch ?? null,
		recentRuns: (root.recentRuns ?? []).filter((entry): entry is JsonValue => isJsonValue(entry)),
		current: parseCurrent(root.current),
	}
}

function parseQueueItem(value: object, label: string): QueueItem {
	const validated = assertArk(QueueItemBaseBoundary, value, label)
	const extra: JsonObject = {}
	if (isObjectRecord(value)) {
		for (const [key, val] of Object.entries(value)) {
			if (!QUEUE_ITEM_BASE_KEYS.has(key) && isJsonValue(val)) {
				extra[key] = val
			}
		}
	}
	const runner = validated.runner ?? null
	return {
		status: validated.status,
		attempts: validated.attempts ?? null,
		title: validated.title ?? null,
		priority: validated.priority ?? null,
		branch: validated.branch ?? null,
		pr: validated.pr ?? null,
		lastRunId: validated.lastRunId ?? null,
		issueFile: validated.issueFile ?? null,
		evidenceDir: validated.evidenceDir ?? null,
		agentCwd: validated.agentCwd ?? null,
		runner: runner === "claude" || runner === "codex" ? runner : null,
		extra,
	}
}

function parseCurrent(value: object | null | undefined): CurrentRun | null {
	if (value === undefined || value === null) return null
	const validated = assertArk(CurrentRunBaseBoundary, value, "state.current")
	const extra: JsonObject = {}
	if (isObjectRecord(value)) {
		for (const [key, val] of Object.entries(value)) {
			if (!CURRENT_RUN_BASE_KEYS.has(key) && isJsonValue(val)) {
				extra[key] = val
			}
		}
	}
	return {
		phase: validated.phase,
		runId: validated.runId,
		startedAt: validated.startedAt,
		extra,
	}
}

function flattenQueueItem(item: QueueItem): JsonObject {
	const result: JsonObject = { ...item.extra }
	result.status = item.status
	result.attempts = item.attempts
	result.title = item.title
	result.priority = item.priority
	result.branch = item.branch
	result.pr = item.pr
	result.lastRunId = item.lastRunId
	result.issueFile = item.issueFile
	result.evidenceDir = item.evidenceDir
	result.agentCwd = item.agentCwd
	result.runner = item.runner
	return result
}

function flattenCurrentRun(run: CurrentRun): JsonObject {
	const result: JsonObject = { ...run.extra }
	result.phase = run.phase
	result.runId = run.runId
	result.startedAt = run.startedAt
	return result
}

export function serializeState(state: LoopState): string {
	const serializable = {
		...state,
		queue: state.queue.map(flattenQueueItem),
		current: state.current ? flattenCurrentRun(state.current) : null,
	}
	return `${JSON.stringify(serializable, null, "\t")}\n`
}

async function saveState(path: string, state: LoopState): Promise<void> {
	await writeFile(path, serializeState(state))
}

export type ReconcileStateOutcome =
	| { restored: false }
	| { restored: true; reason: "missing" | "modified" }

export async function reconcileStateAfterIter(
	path: string,
	expectedSerialized: string,
	logFn: (message: string) => void = log,
): Promise<ReconcileStateOutcome> {
	let onDisk: string
	try {
		onDisk = await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			logFn(`WARN: state.json missing after iteration (iter likely did 'git reset --hard' / 'git merge' that wiped runtime). Restoring from in-memory snapshot: ${path}`)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, expectedSerialized)
			return { restored: true, reason: "missing" }
		}
		throw error
	}
	if (onDisk !== expectedSerialized) {
		logFn(`WARN: state.json was modified during iteration (iter likely did 'git reset --hard' / 'git merge' that reverted runtime). Restoring from in-memory snapshot: ${path}`)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, expectedSerialized)
		return { restored: true, reason: "modified" }
	}
	return { restored: false }
}

export function selectIssue(state: LoopState, options: LoopOptions): SelectedIssue | null {
	const preset = options.preset
	const continuable = preset.statuses.continuable
	const currentItem = state.current
		? state.queue.find((item) => getItemId(item, preset) === getCurrentId(state.current!, preset))
		: undefined
	const selected = currentItem && continuable.includes(currentItem.status)
		? currentItem
		: state.queue.find((item) => continuable.includes(item.status))
	if (!selected) return null

	const issueFile = selected.issueFile === null ? null : resolveFrom(options.targetCwd, selected.issueFile)
	const evidenceDir = selected.evidenceDir === null ? null : resolveFrom(options.targetCwd, selected.evidenceDir)
	if (issueFile !== null && !isWithin(options.issueDir, issueFile)) fail(`Selected issue file must resolve inside issueDir: ${selected.issueFile}`)
	if (evidenceDir !== null && !isWithin(options.evidenceRootDir, evidenceDir)) fail(`Selected evidence directory must resolve inside evidenceDir: ${selected.evidenceDir}`)

	// agentCwd validity (absolute + existing directory) is enforced upstream by checkRuntime.
	const agentCwd = selected.agentCwd ?? options.targetCwd
	const runner = selectRunnerForItem(selected, options)
	const reviewRunner = options.reviewRunner

	return { item: selected, issueFile, evidenceDir, agentCwd, runner, reviewRunner }
}

export function markIterationStarted(
	state: LoopState,
	item: QueueItem,
	preset: Preset,
	runId: string,
	countAttempt: boolean,
): void {
	const id = getItemId(item, preset)
	const queueItem = state.queue.find((entry) => getItemId(entry, preset) === id)
	if (!queueItem) fail(`Selected item "${id}" not found in state queue`)
	if (countAttempt) queueItem.attempts = (queueItem.attempts ?? 0) + 1
	queueItem.lastRunId = runId
	const phases = preset.phases
	const iterPhase = phases[0]
	if (!iterPhase) fail("preset must define at least one phase")
	const currentIdValue = queueItem.extra[preset.item.idField]
	if (currentIdValue === undefined) fail(`Selected item "${id}" is missing id field "${preset.item.idField}"`)
	state.current = {
		phase: iterPhase.name,
		runId,
		startedAt: new Date().toISOString(),
		extra: { [preset.item.idField]: currentIdValue },
	}
}

export function markReviewStarted(state: LoopState, item: QueueItem, preset: Preset, runId: string): void {
	const reviewPhase = reviewPhaseForPreset(preset)
	const currentIdValue = item.extra[preset.item.idField]
	if (currentIdValue === undefined) fail(`Selected item is missing id field "${preset.item.idField}"`)
	state.current = {
		phase: reviewPhase.name,
		runId,
		startedAt: new Date().toISOString(),
		extra: { [preset.item.idField]: currentIdValue },
	}
}

export function makeIssueRunContext(current: CurrentRun | null): IssueRunContext {
	if (current) {
		return {
			runIdGeneration: "resumed",
			resumedFromPhase: current.phase,
			resumedStartedAt: current.startedAt,
		}
	}

	return {
		runIdGeneration: "new",
		resumedFromPhase: null,
		resumedStartedAt: null,
	}
}

export function getItemId(item: QueueItem, preset: Preset): string {
	const value = item.extra[preset.item.idField]
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	throw new Error(`queue item is missing required id field "${preset.item.idField}"`)
}

export function getCurrentId(current: CurrentRun, preset: Preset): string {
	const value = current.extra[preset.item.idField]
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	throw new Error(`state.current is missing required id field "${preset.item.idField}"`)
}

export function renderPrompt(template: string, phase: PresetPhase, ctx: ResolveContext): string {
	let result = template
	for (const [key, source] of phase.variables) {
		const value = resolveBinding(source, ctx)
		result = result.replaceAll(`{{${key}}}`, value)
	}
	return result
}

function lookupItemField(item: QueueItem, field: string): unknown {
	switch (field) {
		case "status": return item.status
		case "attempts": return item.attempts
		case "title": return item.title
		case "priority": return item.priority
		case "branch": return item.branch
		case "pr": return item.pr
		case "lastRunId": return item.lastRunId
		case "issueFile": return item.issueFile
		case "evidenceDir": return item.evidenceDir
		case "agentCwd": return item.agentCwd
		case "runner": return item.runner
		default: return item.extra[field]
	}
}

export function resolveBinding(source: PresetVariableSource, ctx: ResolveContext): string {
	if (source.kind === "item") {
		const value = lookupItemField(ctx.item, source.field)
		return stringifyBindingValue(value, `item.${source.field}`)
	}
	if (source.kind === "config") {
		if (!isConfigBindingField(source.field)) throw new Error(`config.${source.field}: not in known config bindings`)
		const value = ctx.config[source.field]
		return stringifyBindingValue(value, `config.${source.field}`)
	}
	if (!isRuntimeBindingKey(source.key)) {
		throw new Error(`runtime.${source.key}: not in runtime binding whitelist`)
	}
	return ctx.runtime[source.key]
}

function stringifyBindingValue(value: unknown, label: string): string {
	if (value === null || value === undefined) return ""
	if (typeof value === "string") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	if (typeof value === "boolean") return String(value)
	throw new Error(`${label}: cannot stringify value of type ${typeof value}`)
}

export function renderFragmentIndex(preset: Preset): string {
	return preset.fragments
		.map((fragment) => `- ${fragment.id} (${fragment.role}): ${fragment.path}`)
		.join("\n")
}

export function buildRuntimeBindings(input: {
	options: LoopOptions
	runId: string
	currentIssueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	issueRun: IssueRunContext
	issueKind: IssueKind
}): RuntimeBindings {
	const root = loopDataRootPaths()
	const chainPaths = chainRuntimePaths(root.rootDir, input.options.chainName)
	const runPaths = runRuntimePaths(chainPaths.runsDir, input.runId)
	const iterationPhase = input.options.preset.phases[0]?.name ?? "iteration"
	return {
		runId: input.runId,
		targetCwd: input.options.targetCwd,
		agentCwd: input.agentCwd,
		workflowPath: input.options.workflowPath,
		sharedContextPath: chainPaths.sharedPath,
		stateDbPath: root.stateDbPath,
		currentIssueFile: runtimeArtifactPath(chainPaths.issuesDir, input.currentIssueFile),
		issueDir: chainPaths.issuesDir,
		evidenceDir: input.evidenceDir === null
			? chainPaths.evidenceDir
			: runtimeArtifactPath(chainPaths.evidenceDir, input.evidenceDir),
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
		loopDataRoot: root.rootDir,
		chainName: chainPaths.chainName,
		chainDir: chainPaths.chainDir,
		runDir: runPaths.runDir,
		eventsFile: runPaths.eventsPath,
		iterationStdoutFile: runPaths.phasePaths(iterationPhase).stdoutPath,
		presetDir: input.options.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.options.preset),
		runIdGeneration: input.issueRun.runIdGeneration,
		resumedFromPhase: input.issueRun.resumedFromPhase ?? "",
		resumedStartedAt: input.issueRun.resumedStartedAt ?? "",
		issueKind: input.issueKind ?? "",
	}
}

function runtimeArtifactPath(directory: string, path: string | null): string {
	if (path === null || path.trim() === "") return ""
	return resolve(directory, basename(path))
}

export type ParsedIssueKind =
	| { ok: true; kind: IssueKind }
	| { ok: false; error: string }

export function iterationRouteForIssueKind(kind: IssueKind): string {
	if (kind === "comment") return "iter/spike-comment"
	if (kind === "code-spike") return "iter/source-writing-spike"
	if (kind === "blocked") return "iter/resolve-blocker"
	return "iter/classify-scope"
}

export function parseKindFromLabels(labelNames: readonly string[]): ParsedIssueKind {
	const kindLabels = labelNames.filter((name) => name.startsWith("kind:"))
	if (kindLabels.length === 0) return { ok: true, kind: null }
	if (kindLabels.length > 1) {
		return { ok: false, error: `expected exactly one kind:* label, found ${kindLabels.length}: ${kindLabels.join(", ")}` }
	}
	const value = kindLabels[0]!.slice("kind:".length)
	if (!isIssueKindValue(value)) {
		return { ok: false, error: `unknown kind label "kind:${value}" (allowed: ${ISSUE_KIND_VALUES.map((kind) => `kind:${kind}`).join(", ")})` }
	}
	return { ok: true, kind: value }
}

function isIssueKindValue(value: string): value is IssueKindValue {
	return ISSUE_KIND_VALUES.includes(value as IssueKindValue)
}

function parseIssueKindFromQueueItem(item: QueueItem): ParsedIssueKind {
	const raw = item.extra.issueKind ?? item.extra.kind
	if (raw === null || raw === undefined || raw === "") return { ok: true, kind: null }
	if (typeof raw !== "string") return { ok: false, error: `queue item issue kind must be a string when repository is not configured` }
	const label = raw.startsWith("kind:") ? raw : `kind:${raw}`
	return parseKindFromLabels([label])
}

export async function resolveIssueKind(repository: string | null, issueId: string, item: QueueItem): Promise<ParsedIssueKind> {
	if (repository !== null) return fetchIssueKind(repository, issueId)
	return parseIssueKindFromQueueItem(item)
}

export async function fetchIssueKind(repository: string | null, issueId: string): Promise<ParsedIssueKind> {
	if (repository === null) return { ok: true, kind: null }
	return new Promise((resolveResult) => {
		const child = spawn("gh", ["issue", "view", issueId, "--repo", repository, "--json", "labels", "--jq", "[.labels[].name]"], {
			stdio: ["ignore", "pipe", "pipe"],
		})
		const out: Buffer[] = []
		const err: Buffer[] = []
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
		child.on("error", (error) => {
			resolveResult({ ok: false, error: `gh issue view failed to spawn: ${error.message}` })
		})
		child.on("close", (code) => {
			if (code !== 0) {
				const stderr = Buffer.concat(err).toString("utf-8").trim()
				resolveResult({ ok: false, error: `gh issue view exited ${code} for ${repository}#${issueId}: ${stderr}` })
				return
			}
			const stdout = Buffer.concat(out).toString("utf-8").trim()
			try {
				const parsed: unknown = JSON.parse(stdout)
				if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
					resolveResult({ ok: false, error: `gh issue view returned non-string-array labels for ${repository}#${issueId}: ${stdout}` })
					return
				}
				resolveResult(parseKindFromLabels(parsed))
			} catch (parseError) {
				const message = parseError instanceof Error ? parseError.message : String(parseError)
				resolveResult({ ok: false, error: `gh issue view returned invalid JSON for ${repository}#${issueId}: ${message}` })
			}
		})
	})
}

export function buildConfigBindings(options: LoopOptions): ConfigBindings {
	return {
		repository: options.repository ?? "",
		baseBranch: options.baseBranch ?? "",
		requireBrowserEvidence: options.requireBrowserEvidence,
	}
}

async function runAgent(
	options: LoopOptions,
	label: AgentLabel,
	prompt: string,
	outputPath: string,
	agentCwd: string,
	runner: AgentRunnerSelection,
	eventContext?: LoopEventContext,
): Promise<{ output: string; code: number; rateLimit: RateLimitReset | null }> {
	const sessionsPath = agentSessionsPath(outputPath)
	const lastEntry = await readLastSessionEntry(sessionsPath)
	const compatibleLastEntry = await selectResumeEntryForRunner(lastEntry, runner, outputPath, label)
	const initialResume = decideResume(compatibleLastEntry)
	if (initialResume.kind === "resume") {
		log(`Agent [${label}] cross-tick resume: sessionId=${initialResume.sessionId} (last terminated=${compatibleLastEntry?.terminated.kind ?? "?"})`)
	}

	const result = await runAgentWithBackoff({
		spawnAttempt: ({ resume }) => {
			const baseInput: SpawnOneAttemptInput = { options, label, prompt, outputPath, sessionsPath, resume, agentCwd, runner }
			return spawnOneAttempt(eventContext ? { ...baseInput, eventContext } : baseInput)
		},
		sleep: (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
		log,
		now: () => Date.now(),
		initialResume,
	})

	if (result.rateLimit !== null) log(formatRateLimitNotice(result.rateLimit))
	log(`Agent [${label}] finished after ${result.attempts} attempt(s); code=${result.code}`)
	return { output: result.output, code: result.code, rateLimit: result.rateLimit }
}

async function selectResumeEntryForRunner(
	entry: SessionEntry | null,
	runner: AgentRunnerSelection,
	outputPath: string,
	label: AgentLabel,
): Promise<SessionEntry | null> {
	if (entry === null) return null
	const lastRunner = entry.runner ?? await readAgentStatusRunner(agentStatusPath(outputPath))
	if (lastRunner !== null && lastRunner !== runner.kind) {
		log(`Agent [${label}] not resuming previous ${lastRunner} session with ${runner.kind} runner.`)
		return null
	}
	const lastModel = entry.model ?? await readAgentStatusModel(agentStatusPath(outputPath))
	if (lastModel !== runner.model) {
		log(`Agent [${label}] not resuming previous ${lastModel ?? "<default>"} model session with ${runner.model ?? "<default>"} model.`)
		return null
	}
	return entry
}

async function readAgentStatusRunner(statusPath: string): Promise<AgentRunnerKind | null> {
	const phaseStatus = await readAgentPhaseStatus(statusPath)
	return phaseStatus.value?.runner ?? null
}

async function readAgentStatusModel(statusPath: string): Promise<string | null> {
	const phaseStatus = await readAgentPhaseStatus(statusPath)
	return phaseStatus.value?.model ?? null
}

export type SpawnOneAttemptInput = {
	options: LoopOptions
	label: AgentLabel
	prompt: string
	outputPath: string
	sessionsPath: string
	resume: ResumeDecision
	agentCwd: string
	runner?: AgentRunnerSelection
	watchdog?: SummaryWatchdogConfig
	attemptTimeout?: AttemptTimeoutConfig | null
	eventContext?: LoopEventContext
}

export type SummaryWatchdogConfig = {
	marker: string
	termMs: number
	killMs: number
}

export type AttemptTimeoutConfig = {
	termMs: number
	killMs: number
	attemptSeconds: number
}

const DEFAULT_SUMMARY_WATCHDOG: SummaryWatchdogConfig = {
	marker: SUMMARY_WATCHDOG_MARKER,
	termMs: SUMMARY_WATCHDOG_TERM_MS,
	killMs: SUMMARY_WATCHDOG_KILL_MS,
}

export function attemptTimeoutConfigForPreset(preset: Preset): AttemptTimeoutConfig {
	return {
		termMs: preset.agent.attemptTimeoutSeconds * 1000,
		killMs: ATTEMPT_TIMEOUT_KILL_MS,
		attemptSeconds: preset.agent.attemptTimeoutSeconds,
	}
}

export function summaryWatchdogConfigForPrompt(prompt: string): SummaryWatchdogConfig {
	const marker = prompt.includes("REVIEW SUMMARY") ? REVIEW_SUMMARY_WATCHDOG_MARKER : SUMMARY_WATCHDOG_MARKER
	return {
		...DEFAULT_SUMMARY_WATCHDOG,
		marker,
	}
}

export type SummaryWatchdogTimerHandle = ReturnType<typeof setTimeout> | null

export type SummaryWatchdogDeps = {
	config: SummaryWatchdogConfig
	setTimer: (cb: () => void, ms: number) => SummaryWatchdogTimerHandle
	clearTimer: (handle: SummaryWatchdogTimerHandle) => void
	onTerm: () => void
	onKill: () => void
	log: (message: string) => void
}

export type SummaryWatchdogState =
	| { kind: "idle" }
	| { kind: "armed" }
	| { kind: "term-sent" }
	| { kind: "kill-sent" }
	| { kind: "cancelled" }

export type SummaryWatchdog = {
	observeStdout: (chunk: string) => void
	cancel: () => void
	state: () => SummaryWatchdogState
}

type SummaryWatchdogStdoutObserver = {
	observeStdout: (chunk: string) => void
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function codexAgentMessageText(event: unknown): string | null {
	if (!isObjectRecord(event)) return null
	if (event.type === "agent_message" && typeof event.text === "string") return event.text
	if (event.type !== "item.completed" || !isObjectRecord(event.item)) return null
	return event.item.type === "agent_message" && typeof event.item.text === "string" ? event.item.text : null
}

function claudeAgentMessageText(event: unknown): string | null {
	if (!isObjectRecord(event) || event.type !== "assistant" || !isObjectRecord(event.message)) return null
	const content = event.message.content
	if (!Array.isArray(content)) return null
	const textParts = content.flatMap((part): string[] => {
		if (!isObjectRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
		return [part.text]
	})
	return textParts.length === 0 ? null : textParts.join("\n")
}

function containsSummaryMarkerLine(text: string, marker: string): boolean {
	return text.split(/\r?\n/).some((line) => line.trimStart().startsWith(marker))
}

export function codexSummaryTextFromJsonLine(line: string, marker: string): string | null {
	const trimmed = line.trim()
	if (trimmed === "") return null
	try {
		const text = codexAgentMessageText(JSON.parse(trimmed))
		if (text === null || !containsSummaryMarkerLine(text, marker)) return null
		return text
	} catch {
		return null
	}
}

function finalSummaryLine(text: string, marker: string): string | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
	const lastLine = lines.at(-1)
	return lastLine?.startsWith(marker) ? lastLine : null
}

function parseReviewSummaryVerdictFromText(text: string): ReviewSummaryVerdict | null {
	const summaryLine = finalSummaryLine(text, REVIEW_SUMMARY_WATCHDOG_MARKER)
	if (summaryLine === null) return null
	const match = summaryLine.match(/^REVIEW SUMMARY:\s*verdict=(retry|accepted|skip|blocked|stop)\s*;/)
	return match === null ? null : match[1] as ReviewSummaryVerdict
}

function runnerAgentTextFromJsonLine(line: string, runner: AgentRunnerKind): { parsedRunnerEvent: boolean; text: string | null } {
	const trimmed = line.trim()
	if (trimmed === "" || !trimmed.startsWith("{")) return { parsedRunnerEvent: false, text: null }
	try {
		const event: unknown = JSON.parse(trimmed)
		if (!isObjectRecord(event) || typeof event.type !== "string") return { parsedRunnerEvent: false, text: null }
		const text = runner === "codex" ? codexAgentMessageText(event) : claudeAgentMessageText(event)
		return { parsedRunnerEvent: true, text }
	} catch {
		return { parsedRunnerEvent: false, text: null }
	}
}

export function parseReviewSummaryVerdict(output: string, runner: AgentRunnerKind = "claude"): ReviewSummaryVerdict | null {
	let sawRunnerJson = false
	let verdict: ReviewSummaryVerdict | null = null
	for (const line of output.split(/\r?\n/)) {
		const parsed = runnerAgentTextFromJsonLine(line, runner)
		sawRunnerJson = sawRunnerJson || parsed.parsedRunnerEvent
		if (parsed.text === null) continue
		verdict = parseReviewSummaryVerdictFromText(parsed.text)
	}
	return sawRunnerJson ? verdict : parseReviewSummaryVerdictFromText(output)
}

export function createSummaryWatchdogStdoutObserver(runner: AgentRunnerKind, marker: string, watchdog: SummaryWatchdog): SummaryWatchdogStdoutObserver {
	if (runner !== "codex") {
		return {
			observeStdout: (chunk) => watchdog.observeStdout(chunk),
		}
	}

	let bufferedLine = ""
	const maxBufferedLineChars = 1_000_000
	return {
		observeStdout: (chunk) => {
			bufferedLine += chunk
			let newlineIndex = bufferedLine.indexOf("\n")
			while (newlineIndex >= 0) {
				const line = bufferedLine.slice(0, newlineIndex)
				bufferedLine = bufferedLine.slice(newlineIndex + 1)
				const summaryText = codexSummaryTextFromJsonLine(line, marker)
				if (summaryText !== null) watchdog.observeStdout(summaryText)
				newlineIndex = bufferedLine.indexOf("\n")
			}
			if (bufferedLine.length > maxBufferedLineChars) {
				bufferedLine = bufferedLine.slice(-maxBufferedLineChars)
			}
		},
	}
}

export function createSummaryWatchdog(deps: SummaryWatchdogDeps): SummaryWatchdog {
	let state: SummaryWatchdogState = { kind: "idle" }
	let tail = ""
	let termTimer: SummaryWatchdogTimerHandle = null
	let killTimer: SummaryWatchdogTimerHandle = null
	const tailLimit = Math.max(deps.config.marker.length - 1, 0)

	const arm = (): void => {
		if (state.kind !== "idle") return
		state = { kind: "armed" }
		deps.log(`summary watchdog armed: SIGTERM scheduled in ${Math.round(deps.config.termMs / 1000)}s after observing "${deps.config.marker}"`)
		termTimer = deps.setTimer(() => {
			termTimer = null
			if (state.kind !== "armed") return
			state = { kind: "term-sent" }
			deps.log(`summary watchdog firing SIGTERM`)
			deps.onTerm()
			killTimer = deps.setTimer(() => {
				killTimer = null
				if (state.kind !== "term-sent") return
				state = { kind: "kill-sent" }
				deps.log(`summary watchdog firing SIGKILL`)
				deps.onKill()
			}, deps.config.killMs)
		}, deps.config.termMs)
	}

	return {
		observeStdout: (chunk: string) => {
			if (state.kind !== "idle") return
			const search = tail + chunk
			if (search.includes(deps.config.marker)) {
				tail = ""
				arm()
				return
			}
			tail = tailLimit === 0 ? "" : search.slice(-tailLimit)
		},
		cancel: () => {
			if (termTimer !== null) {
				deps.clearTimer(termTimer)
				termTimer = null
			}
			if (killTimer !== null) {
				deps.clearTimer(killTimer)
				killTimer = null
			}
			state = { kind: "cancelled" }
		},
		state: () => state,
	}
}

export async function spawnOneAttempt(input: SpawnOneAttemptInput): Promise<AttemptOutcome> {
	const { options, label, prompt: basePrompt, outputPath, sessionsPath, resume } = input
	const effectivePrompt = resume.kind === "resume" ? RESUME_CONTINUE_PROMPT : basePrompt
	const selectedRunner = input.runner ?? options.defaultRunner
	await mkdir(dirname(outputPath), { recursive: true })
	return new Promise((resolveResult) => {
		const out: Buffer[] = []
		const err: Buffer[] = []
		let settled = false

		const startedAt = new Date().toISOString()
		const attemptStreamPath = agentAttemptStreamPath(outputPath, startedAt)
		const attemptStderrPath = agentAttemptStderrPath(outputPath, startedAt)
		const statusPath = agentStatusPath(outputPath)
		const streamOutFile = createWriteStream(attemptStreamPath, { flags: "a" })
		const stderrOutFile = createWriteStream(attemptStderrPath, { flags: "a" })
		const runnerPlan = buildRunnerInvocation(selectedRunner, effectivePrompt, resume, {
			agentCwd: input.agentCwd,
			targetCwd: options.targetCwd,
			presetDir: options.preset.presetDir,
			loopDataRoot: loopDataRootPaths().rootDir,
		})
		const status: AgentRunStatus = {
			label,
			runner: selectedRunner.kind,
			model: selectedRunner.model,
			pid: null,
			startedAt,
			lastEventAt: startedAt,
			outputPath: attemptStreamPath,
			statusPath,
			bytesWritten: 0,
			promptChars: effectivePrompt.length,
			lastStream: null,
			exitCode: null,
			signal: null,
			error: null,
			sessionId: null,
			terminated: null,
		}
		let statusWriteChain = Promise.resolve()
		const writeStatus = (): Promise<void> => {
			const payload = `${JSON.stringify(status, null, "\t")}\n`
			statusWriteChain = statusWriteChain.then(() => writeFile(statusPath, payload)).catch((error: unknown) => {
				log(`Agent [${label}] status write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
			return statusWriteChain
		}
		const writeLatestIndex = (): void => {
			const lines = [
				`# Agent [${label}] latest attempt`,
				`startedAt: ${status.startedAt}`,
				`pid: ${status.pid ?? ""}`,
				`runner: ${selectedRunner.kind}`,
				`model: ${selectedRunner.model ?? ""}`,
				`status: ${statusPath}`,
				`stream: ${attemptStreamPath}`,
				`stderr: ${attemptStderrPath}`,
				`sessions: ${sessionsPath}`,
				`promptChars: ${effectivePrompt.length}`,
				`resume: ${resume.kind === "resume" ? resume.sessionId : "none"}`,
				"",
			]
			void writeFile(outputPath, lines.join("\n")).catch((error: unknown) => {
				log(`Agent [${label}] latest index write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}
		const watchdogConfig = input.watchdog ?? summaryWatchdogConfigForPrompt(basePrompt)
		const attemptTimeoutConfig = input.attemptTimeout ?? attemptTimeoutConfigForPreset(options.preset)
		const child = spawn(runnerPlan.binary, runnerPlan.args, {
			cwd: input.agentCwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		})
		const sendSignalToGroup = (sig: NodeJS.Signals): void => {
			const pid = child.pid
			if (pid === undefined) return
			// `detached: true` makes the child a process-group leader; signalling -pid
			// reaches the whole tree (bash + sleep + agent-browser + …) which is what we
			// need when the iter agent is wedged with live subprocesses holding stdio open.
			try {
				process.kill(-pid, sig)
				return
			} catch (error) {
				log(`Agent [${label}] ${sig} group kill failed (${error instanceof Error ? error.message : String(error)}); falling back to leader-only kill`)
			}
			try {
				child.kill(sig)
			} catch (error) {
				log(`Agent [${label}] ${sig} leader kill failed: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		type AttemptTimeoutState = "idle" | "term-sent" | "kill-sent" | "cancelled"
		let attemptTimeoutState: AttemptTimeoutState = "idle"
		let attemptTermTimer: ReturnType<typeof setTimeout> | null = null
		let attemptKillTimer: ReturnType<typeof setTimeout> | null = null

		const clearAttemptTimeoutTimers = (): void => {
			if (attemptTermTimer !== null) {
				clearTimeout(attemptTermTimer)
				attemptTermTimer = null
			}
			if (attemptKillTimer !== null) {
				clearTimeout(attemptKillTimer)
				attemptKillTimer = null
			}
		}

		const cancelAttemptTimeout = (): void => {
			clearAttemptTimeoutTimers()
			if (attemptTimeoutState === "idle") attemptTimeoutState = "cancelled"
		}

		const emitWatchdogFire = (sig: "SIGTERM" | "SIGKILL"): void => {
			const ec = input.eventContext
			if (!ec) return
			void ec.emit({
				type: "watchdog.fire",
				ts: new Date().toISOString(),
				runId: ec.runId,
				issueId: ec.issueId,
				pr: ec.pr,
				branch: ec.branch,
				phase: ec.phase,
				attemptStartedAt: startedAt,
				signal: sig,
			})
		}

		const emitAttemptTimeoutFire = (sig: "SIGTERM" | "SIGKILL"): void => {
			const ec = input.eventContext
			if (!ec) return
			void ec.emit({
				type: "attempt.timeout",
				ts: new Date().toISOString(),
				runId: ec.runId,
				issueId: ec.issueId,
				pr: ec.pr,
				branch: ec.branch,
				phase: ec.phase,
				attemptStartedAt: startedAt,
				signal: sig,
				attemptSeconds: attemptTimeoutConfig.attemptSeconds,
			})
		}

		let watchdog: SummaryWatchdog
		const armAttemptTimeout = (): void => {
			attemptTermTimer = setTimeout(() => {
				attemptTermTimer = null
				if (settled || attemptTimeoutState !== "idle") return
				if (watchdog.state().kind !== "idle") {
					attemptTimeoutState = "cancelled"
					return
				}
				attemptTimeoutState = "term-sent"
				log(`Agent [${label}] absolute attempt timeout after ${attemptTimeoutConfig.attemptSeconds}s before summary; sending SIGTERM (pid=${child.pid ?? "?"})`)
				emitAttemptTimeoutFire("SIGTERM")
				sendSignalToGroup("SIGTERM")
				attemptKillTimer = setTimeout(() => {
					attemptKillTimer = null
					if (settled || attemptTimeoutState !== "term-sent") return
					attemptTimeoutState = "kill-sent"
					log(`Agent [${label}] absolute attempt timeout SIGTERM+${Math.round(attemptTimeoutConfig.killMs / 1000)}s elapsed; sending SIGKILL (pid=${child.pid ?? "?"})`)
					emitAttemptTimeoutFire("SIGKILL")
					sendSignalToGroup("SIGKILL")
				}, attemptTimeoutConfig.killMs)
			}, attemptTimeoutConfig.termMs)
		}

		watchdog = createSummaryWatchdog({
			config: watchdogConfig,
			setTimer: (cb, ms) => setTimeout(cb, ms),
			clearTimer: (handle) => {
				if (handle !== null) clearTimeout(handle)
			},
			onTerm: () => {
				log(`Agent [${label}] forced-terminate after "${watchdogConfig.marker}" + ${Math.round(watchdogConfig.termMs / 1000)}s; sending SIGTERM (pid=${child.pid ?? "?"})`)
				emitWatchdogFire("SIGTERM")
				sendSignalToGroup("SIGTERM")
			},
			onKill: () => {
				log(`Agent [${label}] forced-terminate SIGTERM+${Math.round(watchdogConfig.killMs / 1000)}s elapsed; sending SIGKILL (pid=${child.pid ?? "?"})`)
				emitWatchdogFire("SIGKILL")
				sendSignalToGroup("SIGKILL")
			},
			log,
		})
		const watchdogStdout = createSummaryWatchdogStdoutObserver(selectedRunner.kind, watchdogConfig.marker, watchdog)
		armAttemptTimeout()

		const recordChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			status.lastStream = stream
			status.lastEventAt = new Date().toISOString()
			status.bytesWritten += chunk.byteLength
			if (stream === "stdout") {
				out.push(chunk)
				streamOutFile.write(chunk)
				if (status.sessionId === null) {
					const accumulated = Buffer.concat(out).toString("utf-8")
					const detected = parseSessionIdFromRunnerStream(selectedRunner.kind, accumulated)
					if (detected !== null) {
						status.sessionId = detected
					}
				}
				const watchdogStateBefore = watchdog.state().kind
				watchdogStdout.observeStdout(chunk.toString("utf-8"))
				if (watchdogStateBefore === "idle" && watchdog.state().kind !== "idle") {
					cancelAttemptTimeout()
				}
			} else {
				err.push(chunk)
				stderrOutFile.write(chunk)
			}
			void writeStatus()
		}

		status.pid = child.pid ?? null
		void writeStatus()
		writeLatestIndex()

		log(`Agent [${label}] spawned: runner=${selectedRunner.kind}, model=${selectedRunner.model ?? "<default>"}, pid=${child.pid}, stream=${attemptStreamPath}, stderr=${attemptStderrPath}, status=${statusPath}, resume=${resume.kind === "resume" ? resume.sessionId : "none"}, attemptTimeout=${attemptTimeoutConfig.attemptSeconds}s`)

		if (input.eventContext) {
			const ec = input.eventContext
			void ec.emit({
				type: "attempt.start",
				ts: new Date().toISOString(),
				runId: ec.runId,
				issueId: ec.issueId,
				pr: ec.pr,
				branch: ec.branch,
				phase: ec.phase,
				attemptStartedAt: startedAt,
				pid: child.pid ?? null,
				resume: resume.kind === "resume" ? "resume" : "fresh",
			})
		}

		child.stdout.on("data", (chunk: Buffer) => recordChunk("stdout", chunk))
		child.stderr.on("data", (chunk: Buffer) => recordChunk("stderr", chunk))

		const settle = async (terminated: Terminated, output: string, exitCode: number, signal: string | null): Promise<void> => {
			const entry: SessionEntry = {
				attempt: startedAt,
				runner: selectedRunner.kind,
				model: selectedRunner.model,
				sessionId: status.sessionId,
				exitCode,
				signal,
				terminated,
				log: attemptStreamPath,
			}
			try {
				await appendSessionEntry(sessionsPath, entry)
			} catch (error) {
				log(`Agent [${label}] sessions.jsonl append failed: ${error instanceof Error ? error.message : String(error)}`)
			}
			if (input.eventContext) {
				const ec = input.eventContext
				await ec.emit({
					type: "attempt.close",
					ts: new Date().toISOString(),
					runId: ec.runId,
					issueId: ec.issueId,
					pr: ec.pr,
					branch: ec.branch,
					phase: ec.phase,
					attemptStartedAt: startedAt,
					exitCode,
					signal,
					terminated,
					sessionId: status.sessionId,
				})
			}
			resolveResult({
				output,
				exitCode,
				signal,
				sessionId: status.sessionId,
				terminated,
				rateLimit: terminated.kind === "error" ? terminated.rateLimit ?? null : null,
			})
		}

		child.on("error", (error) => {
			if (settled) return
			settled = true
			watchdog.cancel()
			cancelAttemptTimeout()
			status.error = error.message
			status.lastEventAt = new Date().toISOString()
			status.exitCode = 1
			status.terminated = { kind: "error", code: "spawn_error" }
			void (async () => {
				await writeStatus()
				log(`Agent [${label}] spawn error: ${error.message}`)
				streamOutFile.end()
				stderrOutFile.end(`\nspawn error: ${error.message}\n`)
				await settle({ kind: "error", code: "spawn_error" }, `spawn error: ${error.message}`, 1, null)
			})()
		})

		child.on("close", (code, signal) => {
			if (settled) return
			settled = true
			const watchdogStateAtClose = watchdog.state()
			const attemptTimeoutStateAtClose = attemptTimeoutState
			watchdog.cancel()
			cancelAttemptTimeout()
			const stdout = Buffer.concat(out).toString("utf-8")
			const stderr = Buffer.concat(err).toString("utf-8")
			const exitCode = code ?? 1
			const signalName = signal ?? null
			const terminated: Terminated =
				attemptTimeoutStateAtClose === "term-sent" || attemptTimeoutStateAtClose === "kill-sent"
					? {
							kind: "timeout",
							phase: attemptTimeoutStateAtClose === "kill-sent" ? "kill" : "term",
							attemptSeconds: attemptTimeoutConfig.attemptSeconds,
						}
					: watchdogStateAtClose.kind === "term-sent" || watchdogStateAtClose.kind === "kill-sent"
					? {
							kind: "watchdog",
							phase: watchdogStateAtClose.kind === "kill-sent" ? "kill" : "term",
							afterSummarySeconds: Math.round(watchdogConfig.termMs / 1000),
						}
					: classifyTermination({ exitCode, signal: signalName, stdoutText: stdout, stderrText: stderr })
			status.exitCode = exitCode
			status.signal = signalName
			status.terminated = terminated
			status.lastEventAt = new Date().toISOString()
			const terminatedDetail =
				terminated.kind === "error"
					? `(${terminated.code})`
					: terminated.kind === "signal"
						? `(${terminated.name})`
						: terminated.kind === "watchdog"
							? `(forced-terminate after "${watchdogConfig.marker}" + ${terminated.afterSummarySeconds}s, phase=${terminated.phase})`
							: terminated.kind === "timeout"
								? `(absolute attempt timeout after ${terminated.attemptSeconds}s, phase=${terminated.phase})`
							: ""
			void (async () => {
				await writeStatus()
				if (signal) log(`Agent [${label}] killed by signal ${signal}`)
				streamOutFile.end()
				stderrOutFile.end()
				log(`Agent [${label}] attempt closed: exit=${exitCode}, signal=${signalName ?? "none"}, terminated=${terminated.kind}${terminatedDetail}, sessionId=${status.sessionId ?? "<none>"}`)
				await settle(terminated, stdout + "\n" + stderr, exitCode, signalName)
			})()
		})
	})
}

function stripModelArgs(extraArgs: readonly string[], flags: readonly string[]): string[] {
	const stripped: string[] = []
	for (let i = 0; i < extraArgs.length; i++) {
		const arg = extraArgs[i]!
		if (flags.includes(arg)) {
			i++
			continue
		}
		if (flags.some((flag) => arg.startsWith(`${flag}=`))) continue
		stripped.push(arg)
	}
	return stripped
}

export function agentClaudeArgs(extraArgs: readonly string[], prompt: string, resume: ResumeDecision, additionalDirs: readonly string[], model: string | null = null): string[] {
	const args = model === null ? [...extraArgs] : stripModelArgs(extraArgs, ["--model"])
	if (model !== null) args.push("--model", model)
	if (!args.includes("--output-format")) args.push("--output-format", "stream-json")
	if (!args.includes("--verbose")) args.push("--verbose")
	if (additionalDirs.length > 0 && !args.includes("--add-dir")) {
		args.push("--add-dir", ...additionalDirs)
	}
	if (resume.kind === "resume") args.push("--resume", resume.sessionId)
	args.push("-p", prompt)
	return args
}

export type RunnerInvocation =
	| { kind: "spawn"; binary: string; args: string[] }

// --- git worktree management ---

type GitExecResult = { stdout: string; stderr: string; exitCode: number }

function gitExec(cwd: string, args: readonly string[]): GitExecResult {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	return {
		stdout: new TextDecoder().decode(proc.stdout).trim(),
		stderr: new TextDecoder().decode(proc.stderr).trim(),
		exitCode: proc.exitCode,
	}
}

export function worktreeBasePath(targetCwd: string): string {
	return resolve(targetCwd, "..", ".coder-loop-worktrees", basename(targetCwd))
}

export function worktreePathForItem(targetCwd: string, itemId: string): string {
	const safeId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_")
	return resolve(worktreeBasePath(targetCwd), safeId)
}

export function validateWorktreePrerequisites(targetCwd: string, baseBranch: string): void {
	const fetchResult = gitExec(targetCwd, ["fetch", "origin"])
	if (fetchResult.exitCode !== 0) {
		throw new CoderLoopError(`worktree: git fetch origin failed (exit ${fetchResult.exitCode}) in ${targetCwd}: ${fetchResult.stderr}`)
	}
	const revResult = gitExec(targetCwd, ["rev-parse", "--verify", `origin/${baseBranch}`])
	if (revResult.exitCode !== 0) {
		throw new CoderLoopError(`worktree: remote branch origin/${baseBranch} does not exist`)
	}
}

export function ensureWorktreeForItem(
	targetCwd: string,
	baseBranch: string,
	itemId: string,
	existingAgentCwd: string | null,
): string {
	const wtPath = worktreePathForItem(targetCwd, itemId)

	if (existingAgentCwd === wtPath) {
		const check = gitExec(targetCwd, ["worktree", "list", "--porcelain"])
		if (check.stdout.includes(wtPath)) return wtPath
	}

	const branchName = `coder-loop/${itemId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
	const result = gitExec(targetCwd, ["worktree", "add", "-b", branchName, wtPath, `origin/${baseBranch}`])
	if (result.exitCode === 0) return wtPath

	const retry = gitExec(targetCwd, ["worktree", "add", wtPath, branchName])
	if (retry.exitCode === 0) return wtPath

	throw new CoderLoopError(
		`worktree: failed to create worktree at ${wtPath} for item ${itemId} (exit ${retry.exitCode}): ${retry.stderr}`,
	)
}

export function removeWorktreeForItem(
	targetCwd: string,
	itemId: string,
	logFn: (message: string) => void,
): void {
	const wtPath = worktreePathForItem(targetCwd, itemId)
	const result = gitExec(targetCwd, ["worktree", "remove", "--force", wtPath])
	if (result.exitCode !== 0) {
		logFn(`worktree: removal of ${wtPath} failed (exit ${result.exitCode}): ${result.stderr}; continuing`)
	}
}

export function cleanupStaleWorktrees(
	targetCwd: string,
	activeItemIds: Set<string>,
	logFn: (message: string) => void,
): void {
	gitExec(targetCwd, ["worktree", "prune"])

	const base = worktreeBasePath(targetCwd)
	let realBase: string
	try { realBase = realpathSync(base) } catch { realBase = base }
	const listResult = gitExec(targetCwd, ["worktree", "list", "--porcelain"])
	if (listResult.exitCode !== 0) return

	const worktreePaths = listResult.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path.startsWith(realBase))

	for (const wtPath of worktreePaths) {
		const itemDir = basename(wtPath)
		if (!activeItemIds.has(itemDir)) {
			logFn(`worktree: cleaning stale worktree ${wtPath}`)
			gitExec(targetCwd, ["worktree", "remove", "--force", wtPath])
		}
	}
}

// --- runner invocation ---

export type RunnerInvocationPaths = {
	agentCwd: string
	targetCwd: string
	presetDir: string
	loopDataRoot: string
}

export function buildRunnerInvocation(runner: AgentRunnerSelection, prompt: string, resume: ResumeDecision, paths: RunnerInvocationPaths): RunnerInvocation {
	const additionalDirs = [paths.presetDir, paths.loopDataRoot]
	if (paths.targetCwd !== paths.agentCwd) additionalDirs.push(paths.targetCwd)
	if (runner.kind === "claude") {
		return {
			kind: "spawn",
			binary: runner.binary,
			args: agentClaudeArgs(runner.extraArgs, prompt, resume, additionalDirs, runner.model),
		}
	}
	return {
		kind: "spawn",
		binary: runner.binary,
		args: agentCodexArgs(runner.extraArgs, prompt, resume, paths.agentCwd, runner.model, additionalDirs),
	}
}

export function agentCodexArgs(
	extraArgs: readonly string[],
	prompt: string,
	resume: ResumeDecision,
	agentCwd: string,
	model: string | null = null,
	additionalDirs: readonly string[] = [],
): string[] {
	const topLevelArgs = ["--ask-for-approval", "never", "exec"]
	const runnerArgs = model === null ? [...extraArgs] : stripModelArgs(extraArgs, ["--model", "-m"])
	if (resume.kind === "resume") {
		const args = [...topLevelArgs, "resume", resume.sessionId, ...runnerArgs]
		if (model !== null) args.push("--model", model)
		if (!args.includes("--json")) args.push("--json")
		if (!args.includes("--ignore-rules")) args.push("--ignore-rules")
		args.push(prompt)
		return args
	}
	const args = [...topLevelArgs, ...runnerArgs]
	if (model !== null) args.push("--model", model)
	if (!args.includes("--json")) args.push("--json")
	if (!args.includes("--cd")) args.push("--cd", agentCwd)
	if (additionalDirs.length > 0 && !args.includes("--add-dir")) {
		for (const dir of additionalDirs) args.push("--add-dir", dir)
	}
	if (!args.includes("--sandbox")) args.push("--sandbox", "danger-full-access")
	args.push(prompt)
	return args
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

async function ensureGitExclude(cwd: string): Promise<void> {
	const excludePath = resolve(cwd, ".git", "info", "exclude")
	try {
		const content = await readFile(excludePath, "utf-8")
		const lines = content.split("\n")
		const missing = EXCLUDE_ENTRIES.filter((entry) => !lines.includes(entry))
		if (missing.length > 0) await appendFile(excludePath, "\n" + missing.join("\n") + "\n")
	} catch {
		// No .git/info/exclude available; non-git targets can still run.
	}
}

function agentOutputPath(options: LoopOptions, runId: string, label: AgentLabel): string {
	return runRuntimePaths(options.logDir, runId).phasePaths(label).latestPath
}

function agentStatusPath(outputPath: string): string {
	return runPhaseSibling(outputPath, "status.json")
}

export function agentSessionsPath(outputPath: string): string {
	return runPhaseSibling(outputPath, "sessions.jsonl")
}

function agentAttemptStderrPath(outputPath: string, startedAt: string): string {
	void startedAt
	return runPhaseSibling(outputPath, "stderr.txt")
}

function agentAttemptStreamPath(outputPath: string, startedAt: string): string {
	void startedAt
	return runPhaseSibling(outputPath, "stdout.jsonl")
}

function runPhaseSibling(outputPath: string, filename: string): string {
	return resolve(dirname(outputPath), filename)
}

export function parseSessionIdFromStream(text: string): string | null {
	const newlineIdx = text.indexOf("\n")
	if (newlineIdx === -1) return null
	const firstLine = text.slice(0, newlineIdx).trim()
	if (firstLine === "") return null
	try {
		const event: unknown = JSON.parse(firstLine)
		if (isObjectRecord(event) && typeof event.session_id === "string" && event.session_id !== "") return event.session_id
		return null
	} catch {
		return null
	}
}

export function parseCodexThreadIdFromStream(text: string): string | null {
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "") continue
		try {
			const event: unknown = JSON.parse(trimmed)
			if (isObjectRecord(event) && event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id !== "") return event.thread_id
		} catch {
			continue
		}
	}
	return null
}

export function parseSessionIdFromRunnerStream(runner: AgentRunnerKind, text: string): string | null {
	return runner === "codex" ? parseCodexThreadIdFromStream(text) : parseSessionIdFromStream(text)
}

export function extractErrorCode(stdoutText: string, stderrText: string): string {
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: unknown = JSON.parse(line)
			if (!isObjectRecord(parsed)) continue
			const rateLimitCode = extractRateLimitErrorCodeFromEvent(parsed)
			if (rateLimitCode !== null) return rateLimitCode
			const isError = parsed["is_error"] === true || parsed["type"] === "error"
			if (!isError) continue
			const errorObj = parsed["error"]
			if (isObjectRecord(errorObj)) {
				if (typeof errorObj.type === "string" && errorObj.type !== "") return errorObj.type
				if (typeof errorObj.code === "string" && errorObj.code !== "") return errorObj.code
				if (typeof errorObj.message === "string" && errorObj.message !== "") return errorObj.message.slice(0, 200)
			}
			if (typeof parsed["message"] === "string" && parsed["message"] !== "") return parsed["message"].slice(0, 200)
		} catch {
			continue
		}
	}
	const httpMatch = stderrText.match(/\b(5\d\d)\b/)
	if (httpMatch) return `${httpMatch[1]}_http`
	const keywordMatch = stderrText.toLowerCase().match(/overloaded|rate[\s_-]?limit|service[\s_-]?unavailable/)
	if (keywordMatch) return keywordMatch[0]
	return "unknown"
}

export type ClassifyInput = {
	exitCode: number
	signal: string | null
	stdoutText: string
	stderrText: string
}

export function classifyTermination(input: ClassifyInput): Terminated {
	if (input.signal !== null && input.signal !== "") return { kind: "signal", name: input.signal }
	if (input.exitCode === 0) return { kind: "clean" }
	const code = extractErrorCode(input.stdoutText, input.stderrText)
	const rateLimit = isRateLimitErrorCode(code) ? extractRateLimitReset(input.stdoutText) : null
	return rateLimit === null ? { kind: "error", code } : { kind: "error", code, rateLimit }
}

export function isTransient5xx(code: string): boolean {
	const lower = code.toLowerCase()
	if (/(^|[^\d])5\d\d($|[^\d])/.test(lower)) return true
	if (lower.includes("overloaded")) return true
	if (isRateLimitErrorCode(lower)) return true
	if (lower.includes("service_unavailable") || lower.includes("service-unavailable")) return true
	return false
}

export function decideResume(entry: SessionEntry | null): ResumeDecision {
	if (entry === null) return { kind: "fresh" }
	if (entry.sessionId === null || entry.sessionId === "") return { kind: "fresh" }
	switch (entry.terminated.kind) {
		case "clean":
			return { kind: "fresh" }
		case "signal":
			return { kind: "resume", sessionId: entry.sessionId }
		case "error":
			return isTransient5xx(entry.terminated.code) ? { kind: "resume", sessionId: entry.sessionId } : { kind: "fresh" }
		case "watchdog":
			return { kind: "fresh" }
		case "timeout":
			return { kind: "fresh" }
	}
}

export function nextBackoffSeconds(retryIndex: number): number {
	if (retryIndex < 0) return BACKOFF_INITIAL_SECONDS
	const exponential = BACKOFF_INITIAL_SECONDS * Math.pow(2, retryIndex)
	return Math.min(exponential, BACKOFF_MAX_INTERVAL_SECONDS)
}

export async function readLastSessionEntry(sessionsPath: string): Promise<SessionEntry | null> {
	let raw: string
	try {
		raw = await readFile(sessionsPath, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	}
	const lines = raw.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: unknown = JSON.parse(line)
			const result = SessionEntryBoundary(parsed)
			if (result instanceof arkType.errors) continue
			return result
		} catch {
			continue
		}
	}
	return null
}


export async function appendSessionEntry(sessionsPath: string, entry: SessionEntry): Promise<void> {
	const line = JSON.stringify(entry) + "\n"
	await appendFile(sessionsPath, line)
}

export type AttemptOutcome = {
	output: string
	exitCode: number
	signal: string | null
	sessionId: string | null
	terminated: Terminated
	rateLimit: RateLimitReset | null
}

export type RunWithBackoffDeps = {
	spawnAttempt: (params: { resume: ResumeDecision }) => Promise<AttemptOutcome>
	sleep: (seconds: number) => Promise<void>
	log: (message: string) => void
	now: () => number
	initialResume: ResumeDecision
}

export async function runAgentWithBackoff(deps: RunWithBackoffDeps): Promise<{ output: string; code: number; attempts: number; rateLimit: RateLimitReset | null }> {
	let resume = deps.initialResume
	let retryIndex = 0
	let elapsedBackoffSeconds = 0
	let attempts = 0
	while (true) {
		attempts++
		const outcome = await deps.spawnAttempt({ resume })
		if (outcome.terminated.kind === "watchdog") {
			deps.log(`post-summary watchdog terminated attempt (phase=${outcome.terminated.phase}); treating as success because the phase printed its mandatory summary`)
			return { output: outcome.output, code: 0, attempts, rateLimit: null }
		}
		if (outcome.terminated.kind === "error" && isTransient5xx(outcome.terminated.code)) {
			if (outcome.rateLimit !== null) {
				deps.log(`account rate limit detected (until ${outcome.rateLimit.resetAtIso}); returning to outer loop for daemon-level cooldown`)
				return { output: outcome.output, code: outcome.exitCode, attempts, rateLimit: outcome.rateLimit }
			}
			if (outcome.sessionId === null) {
				deps.log(`backoff abort: transient-5xx without sessionId; returning to outer loop`)
				return { output: outcome.output, code: outcome.exitCode, attempts, rateLimit: null }
			}
			const sleepSeconds = nextBackoffSeconds(retryIndex)
			if (elapsedBackoffSeconds + sleepSeconds > BACKOFF_BUDGET_SECONDS) {
				deps.log(`backoff budget exhausted: elapsed=${elapsedBackoffSeconds}s, next=${sleepSeconds}s, budget=${BACKOFF_BUDGET_SECONDS}s; returning to outer loop`)
				return { output: outcome.output, code: outcome.exitCode, attempts, rateLimit: null }
			}
			deps.log(`transient-5xx detected (code=${outcome.terminated.code}); sleeping ${sleepSeconds}s before resume #${retryIndex + 1}`)
			await deps.sleep(sleepSeconds)
			elapsedBackoffSeconds += sleepSeconds
			retryIndex++
			resume = { kind: "resume", sessionId: outcome.sessionId }
			continue
		}
		return { output: outcome.output, code: outcome.exitCode, attempts, rateLimit: outcome.rateLimit }
	}
}

function resolveFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path)
}

function resolveRuntimePath(options: LoopOptions, source: RuntimeStateSource, path: string, label: string, root: string, errors: RuntimeCheckError[]): string | null {
	if (path.trim() === "") {
		pushCheckError(errors, label, "must not be empty")
		return null
	}
	const resolved = resolveFrom(source.kind === "chain-db" ? source.chainPaths.chainDir : options.targetCwd, path)
	if (source.kind === "file") checkInside(options.targetCwd, resolved, label, errors)
	else checkInside(source.chainPaths.chainDir, resolved, label, errors)
	checkInside(root, resolved, label, errors)
	return resolved
}

function checkInside(root: string, path: string, label: string, errors: RuntimeCheckError[]): void {
	if (!isWithin(root, path)) pushCheckError(errors, label, `must resolve inside ${root}: ${path}`)
}

function isWithin(base: string, path: string): boolean {
	const rel = relative(base, path)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

async function checkFile(path: string, label: string, errors: RuntimeCheckError[]): Promise<void> {
	try {
		const info = await stat(path)
		if (!info.isFile()) pushCheckError(errors, label, "must be a file")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") pushCheckError(errors, label, `missing file: ${path}`)
		else throw error
	}
}

async function checkDirectory(path: string, label: string, errors: RuntimeCheckError[]): Promise<void> {
	try {
		const info = await stat(path)
		if (!info.isDirectory()) pushCheckError(errors, label, "must be a directory")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") pushCheckError(errors, label, `missing directory: ${path}`)
		else throw error
	}
}

function pushCheckError(errors: RuntimeCheckError[], path: string, message: string): void {
	errors.push({ path, message })
}

function isIsoDateTime(value: string): boolean {
	return !Number.isNaN(Date.parse(value))
}

function makeRunId(id: string | null): string {
	const timestamp = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, "-")
	return id === null ? `run-${timestamp}-no-issue` : `run-${timestamp}-issue-${id}`
}

export function reviewOnEmptyLockPath(statePath: string): string {
	return resolve(dirname(statePath), REVIEW_ON_EMPTY_LOCK_FILE)
}

export function serializeReviewOnEmptyLock(runId: string, acquiredAt: Date): string {
	return `${JSON.stringify({ acquiredAt: acquiredAt.toISOString(), runId, reason: "queue-drained" }, null, "\t")}\n`
}

export function resolveIdleSleepMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.CODER_LOOP_IDLE_SLEEP_MS
	if (raw === undefined || raw === "") return DEFAULT_IDLE_SLEEP_MS
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`CODER_LOOP_IDLE_SLEEP_MS must be a non-negative number, got: ${raw}`)
	return parsed
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists()
}

async function removeLoopFile(path: string): Promise<void> {
	try {
		await Bun.file(path).delete()
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
}

function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`
	console.error(line)
	logStream?.write(line + "\n")
}

function formatMaxIterations(value: number): string {
	return value === Number.POSITIVE_INFINITY ? "Infinity" : String(value)
}

type ArkAssertable<T> = {
	assert(data: unknown): T
}

function assertArk<T>(schema: ArkAssertable<T>, data: unknown, label: string): T {
	try {
		return schema.assert(data)
	} catch (error) {
		throw new Error(`${label}: ${errorMessage(error)}`)
	}
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	const kind = typeof value
	if (kind === "string" || kind === "number" || kind === "boolean") return kind !== "number" || Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (kind !== "object") return false
	return isJsonObject(value)
}

function isJsonObject(value: unknown): value is JsonObject {
	if (!isObjectRecord(value) || Array.isArray(value)) return false
	return Object.values(value).every(isJsonValue)
}


function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

function fail(message: string): never {
	throw new CoderLoopError(message)
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		const message = errorMessage(error)
		if (logStream === null) console.error(message)
		else log(`Fatal: ${message}`)
		logStream?.end()
		process.exit(1)
	})
}
