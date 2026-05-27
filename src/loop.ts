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
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { closeSync, createWriteStream, openSync, realpathSync, type WriteStream } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { command, flag, option, optional, positional, run as runCmd, string as cmdString, subcommands } from "cmd-ts"
import { type as arkType } from "arktype"
import { CoderLoopDaemon, DaemonError, daemonRequest, sendDaemonRequest, type DaemonCommandName, type DaemonResponse } from "./daemon"
import { dispatchSubcommand } from "./install-commands"
import { RuntimePathError, resolveChainRuntimePaths, resolveLoopDataPaths } from "./runtime-paths"
import {
	type ChainRecord,
	type CurrentRunRecord,
	type ItemRecord,
	openSqliteStateStore,
	type SqliteStateStore,
} from "./sqlite-state"

const PKG_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

const DEFAULT_CONFIG_FILE = ".coder-loop/runtime/config.json"
const DEFAULT_CONFIG_FILE_TOML = ".coder-loop/runtime/config.toml"
const DEFAULT_WORKFLOW_FILE = ".coder-loop/workflow.md"
const DEFAULT_SHARED_FILE = ".coder-loop/runtime/shared.md"
const DEFAULT_ISSUE_DIR = ".coder-loop/runtime/issues"
const DEFAULT_EVIDENCE_DIR = ".coder-loop/runtime/evidence"
const DEFAULT_LOG_DIR = ".coder-loop/runtime/logs"
const REVIEW_ON_EMPTY_LOCK_FILE = "review-on-empty.lock"
const DEFAULT_IDLE_SLEEP_MS = 60_000
const DEFAULT_ITERATION_RUNNER: AgentRunnerKind = "codex"
export const CLAUDE_REVIEW_MODEL = "claude-opus-4-7"
export const DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 60 * 60
export const ATTEMPT_TIMEOUT_KILL_MS = 5 * 1000

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

type DbLoopStateSnapshot = {
	chain: ChainRecord
	state: LoopState
}

type DbLoopStateContext = DbLoopStateSnapshot & {
	store: SqliteStateStore
}

type RawArgs = {
	maxIterations: number | null
	targetCwd: string | null
	configPath: string | null
	workflowPath: string | null
	stateFile: string | null
	loopDataRoot: string | null
	chainName: string | null
	repository: string | null
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
	loopDataRoot?: string | null
	chainName?: string | null
	repository: string | null
	output: "json"
}

export type DaemonCommandArgs =
	| {
			action: "up"
			loopDataRoot: string | null
			schedulerIntervalMs: number | null
			json: boolean
	  }
	| {
			action: "status"
			targetCwd: string
			configPath: string | null
			loopDataRoot?: string | null
			chainName?: string | null
			repository: string | null
			output: "json"
		}
	| {
			action: "start"
			targetCwd: string
			configPath: string | null
			loopDataRoot?: string | null
			chainName?: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
			worktree: boolean
			baseBranch: string | null
			json: boolean
		}
	| {
			action: "stop"
			targetCwd: string
			configPath: string | null
			loopDataRoot?: string | null
			chainName?: string | null
			repository: string | null
			dryRun: boolean
			json: boolean
		}
	| {
			action: "restart"
			targetCwd: string
			configPath: string | null
			loopDataRoot?: string | null
			chainName?: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
			worktree: boolean
			baseBranch: string | null
			json: boolean
	  }
	| {
			action: "down"
			loopDataRoot: string | null
			json: boolean
	  }

export type ChainCommandArgs =
	| {
			action: "create"
			name: string
			repository: string
			preset: string | null
			baseBranch: string | null
			umbrella: string | null
			force: boolean
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "list"
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "status"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "delete"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }

export type ItemCommandArgs =
	| {
			action: "add"
			chainName: string
			issueNumber: number
			repoCwd: string
			status: string | null
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
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "batch-add"
			chainName: string
			items: JsonObject[]
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "list"
			chainName: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "update"
			chainName: string
			issueNumber: number
			repoCwd: string | null
			status: string | null
			title: string | null
			priority: string | null
			branch: string | null
			pr: number | null
			issueFile: string | null
			evidenceDir: string | null
			runner: AgentRunnerKind | null
			loopDataRoot: string | null
			json: boolean
	  }

export type QueueUnblockCommandArgs = {
	targetCwd: string
	configPath: string | null
	loopDataRoot: string | null
	chainName: string | null
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
	loopDataRoot: string | null
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
	"loopDataRoot?": "string|null",
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

const TerminatedBoundary = arkType.or(
	{ kind: arkType.unit("clean") },
	{ kind: arkType.unit("signal"), name: "string" },
	{ kind: arkType.unit("error"), code: "string" },
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

const QUEUE_ITEM_BASE_KEYS = new Set([
	"status", "attempts", "title", "priority", "branch", "pr",
	"lastRunId", "issueFile", "evidenceDir", "agentCwd", "runner",
])

const PresetPhaseTriggerBoundary = arkType({
	"afterPhase?": "string",
	"whenStatus?": "string",
	"on?": "string",
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
	stateFile: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	loopDataRoot: string | null
	logFile: string
	repository: string | null
	baseBranch: string | null
	chainName?: string | null
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

export type PresetPhaseTrigger =
	| { afterPhase: string; whenStatus: string }
	| { on: "chain-complete" }

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
	stateFile: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
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

export type StatusProcessInfo = {
	pid: number
	ppid: number | null
	command: string | null
	cwd: string | null
	matchesTarget: boolean
	alive: boolean
	source: "ps" | "daemon-socket"
}

export type StatusProcessSnapshot = {
	live: StatusProcessInfo[]
	scanError: string | null
}

export type Terminated =
	| { kind: "clean" }
	| { kind: "signal"; name: string }
	| { kind: "error"; code: string }
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

export function loopEventsPath(logDir: string, runId: string): string {
	return resolve(logDir, runId, "events.jsonl")
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
	logDir: string,
	runId: string,
	logFn: (message: string) => void,
): LoopEventEmit {
	const path = loopEventsPath(logDir, runId)
	return (event) => appendLoopEvent(path, event, logFn)
}

export const RESUME_CONTINUE_PROMPT = "继续"
export const BACKOFF_BUDGET_SECONDS = 7200
const BACKOFF_INITIAL_SECONDS = 4
const BACKOFF_MAX_INTERVAL_SECONDS = 600

export const SUMMARY_WATCHDOG_MARKER = "ITERATION SUMMARY:"
export const REVIEW_SUMMARY_WATCHDOG_MARKER = "REVIEW SUMMARY:"
export type ReviewSummaryVerdict = "retry" | "accepted" | "skip" | "blocked" | "stop"
export const SUMMARY_WATCHDOG_TERM_MS = Infinity
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
	resumedSessionId: string | null
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
	"currentIssueFile",
	"issueDir",
	"evidenceDir",
	"evidenceRootDir",
	"logDir",
	"presetDir",
	"fragmentIndex",
	"runIdGeneration",
	"resumedFromPhase",
	"resumedStartedAt",
	"resumedSessionId",
	"issueKind",
	"chainName",
	"chainUmbrellaRepo",
	"chainUmbrellaIssue",
	"chainBaseBranch",
	"repoCwd",
] as const

type RuntimeBindingKey = (typeof RUNTIME_BINDING_KEYS)[number]

function isRuntimeBindingKey(key: string): key is RuntimeBindingKey {
	return (RUNTIME_BINDING_KEYS as readonly string[]).includes(key)
}

export type RuntimeBindings = Record<RuntimeBindingKey, string>

export type RuntimeBindingPaths = {
	sharedContextPath: string
	currentIssueFile: string
	issueDir: string
	evidenceDir: string
	evidenceRootDir: string
	logDir: string
}

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
		stateFile: null,
		loopDataRoot: null,
		chainName: null,
		repository: null,
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
				raw.stateFile = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--loop-data-root":
				raw.loopDataRoot = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--chain":
				raw.chainName = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--repo":
				raw.repository = readFlagValue(args, index, inlineValue, name)
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
	| { kind: "chain"; args: ChainCommandArgs }
	| { kind: "item"; args: ItemCommandArgs }
	| { kind: "queue"; args: QueueUnblockCommandArgs }

const statusCliCommand = command({
	name: "status",
	description: "Emit a read-only coder-loop runtime snapshot.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		config: option({ long: "config", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("status: only --json output is supported for now. Usage: coder-loop status <target> --json")
		return {
			kind: "status",
			args: {
				targetCwd: args.target,
				configPath: args.config ?? null,
				loopDataRoot: args.loopDataRoot ?? null,
				chainName: args.chain ?? null,
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
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("daemon status: only --json output is supported for now. Usage: coder-loop daemon status <target> --json")
		return {
			kind: "daemon",
			args: {
				action: "status",
				targetCwd: args.target,
				configPath: args.config ?? null,
				loopDataRoot: args.loopDataRoot ?? null,
				chainName: args.chain ?? null,
				repository: args.repo ?? null,
				output: "json",
			},
		}
	},
})

const daemonUpCliCommand = command({
	name: "up",
	description: "Run the centralized coder-loop daemon process.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "up",
			loopDataRoot: args.loopDataRoot ?? null,
			schedulerIntervalMs: parseOptionalPositiveInteger(args.schedulerIntervalMs ?? null, "--scheduler-interval-ms"),
			json: args.json,
		},
	}),
})

const daemonStartCliCommand = command({
	name: "start",
	description: "Start coder-loop as a detached daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "start",
			targetCwd: args.target,
			configPath: args.config ?? null,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			json: args.json,
		},
	}),
})

const daemonStopCliCommand = command({
	name: "stop",
	description: "Stop the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "stop",
			targetCwd: args.target,
			configPath: args.config ?? null,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			repository: args.repo ?? null,
			dryRun: args.dryRun,
			json: args.json,
		},
	}),
})

const daemonRestartCliCommand = command({
	name: "restart",
	description: "Restart the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		repo: option({ long: "repo", type: optional(cmdString) }),
		requireBrowserEvidence: flag({ long: "require-browser-evidence" }),
		maxIterations: option({ long: "max-iterations", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "restart",
			targetCwd: args.target,
			configPath: args.config ?? null,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			repository: args.repo ?? null,
			requireBrowserEvidence: args.requireBrowserEvidence,
			maxIterations: parseDaemonMaxIterations(args.maxIterations ?? null),
			dryRun: args.dryRun,
			worktree: args.worktree,
			baseBranch: args.baseBranch ?? null,
			json: args.json,
		},
	}),
})

const daemonDownCliCommand = command({
	name: "down",
	description: "Ask the centralized coder-loop daemon to shut down through its Unix socket.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "down",
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const daemonCliCommand = subcommands({
	name: "daemon",
	description: "Manage coder-loop daemon processes.",
	cmds: {
		up: daemonUpCliCommand,
		status: daemonStatusCliCommand,
		start: daemonStartCliCommand,
		stop: daemonStopCliCommand,
		restart: daemonRestartCliCommand,
		down: daemonDownCliCommand,
	},
})

const chainCreateCliCommand = command({
	name: "create",
	description: "Create a centralized coder-loop chain through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		repo: option({ long: "repo", type: cmdString }),
		preset: option({ long: "preset", type: optional(cmdString) }),
		baseBranch: option({ long: "base-branch", type: optional(cmdString) }),
		umbrella: option({ long: "umbrella", type: optional(cmdString) }),
		force: flag({ long: "force" }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "create",
			name: args.name,
			repository: args.repo,
			preset: args.preset ?? null,
			baseBranch: args.baseBranch ?? null,
			umbrella: args.umbrella ?? null,
			force: args.force,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainListCliCommand = command({
	name: "list",
	description: "List centralized coder-loop chains through the daemon socket.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "list",
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainStatusCliCommand = command({
	name: "status",
	description: "Show one centralized coder-loop chain through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "status",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainDeleteCliCommand = command({
	name: "delete",
	description: "Mark one centralized coder-loop chain as deleted through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "delete",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainCliCommand = subcommands({
	name: "chain",
	description: "Operate centralized coder-loop chains through the daemon socket.",
	cmds: {
		create: chainCreateCliCommand,
		list: chainListCliCommand,
		status: chainStatusCliCommand,
		delete: chainDeleteCliCommand,
	},
})

const itemAddCliCommand = command({
	name: "add",
	description: "Add an item to a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		repoCwd: option({ long: "repo-cwd", type: cmdString }),
		status: option({ long: "status", type: optional(cmdString) }),
		attempts: option({ long: "attempts", type: optional(cmdString) }),
		title: option({ long: "title", type: optional(cmdString) }),
		priority: option({ long: "priority", type: optional(cmdString) }),
		branch: option({ long: "branch", type: optional(cmdString) }),
		pr: option({ long: "pr", type: optional(cmdString) }),
		lastRunId: option({ long: "last-run-id", type: optional(cmdString) }),
		issueFile: option({ long: "issue-file", type: optional(cmdString) }),
		evidenceDir: option({ long: "evidence-dir", type: optional(cmdString) }),
		agentCwd: option({ long: "agent-cwd", type: optional(cmdString) }),
		runner: option({ long: "runner", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "add",
			chainName: args.chain,
			issueNumber: parseRequiredPositiveInteger(args.issue, "--issue"),
			repoCwd: resolve(args.repoCwd),
			status: args.status ?? null,
			attempts: parseOptionalNonNegativeInteger(args.attempts ?? null, "--attempts"),
			title: args.title ?? null,
			priority: args.priority ?? null,
			branch: args.branch ?? null,
			pr: parseOptionalPositiveInteger(args.pr ?? null, "--pr"),
			lastRunId: args.lastRunId ?? null,
			issueFile: args.issueFile ?? null,
			evidenceDir: args.evidenceDir ?? null,
			agentCwd: args.agentCwd === undefined ? null : resolve(args.agentCwd),
			runner: parseOptionalRunner(args.runner ?? null, "--runner"),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemBatchAddCliCommand = command({
	name: "batch-add",
	description: "Add multiple items to one centralized coder-loop chain atomically through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		itemsJson: option({ long: "items-json", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "batch-add",
			chainName: args.chain,
			items: parseBatchItemsJson(args.itemsJson),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemListCliCommand = command({
	name: "list",
	description: "List items in a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "list",
			chainName: args.chain,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemUpdateCliCommand = command({
	name: "update",
	description: "Update an item in a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		repoCwd: option({ long: "repo-cwd", type: optional(cmdString) }),
		status: option({ long: "status", type: optional(cmdString) }),
		title: option({ long: "title", type: optional(cmdString) }),
		priority: option({ long: "priority", type: optional(cmdString) }),
		branch: option({ long: "branch", type: optional(cmdString) }),
		pr: option({ long: "pr", type: optional(cmdString) }),
		issueFile: option({ long: "issue-file", type: optional(cmdString) }),
		evidenceDir: option({ long: "evidence-dir", type: optional(cmdString) }),
		runner: option({ long: "runner", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "update",
			chainName: args.chain,
			issueNumber: parseRequiredPositiveInteger(args.issue, "--issue"),
			repoCwd: args.repoCwd === undefined ? null : resolve(args.repoCwd),
			status: args.status ?? null,
			title: args.title ?? null,
			priority: args.priority ?? null,
			branch: args.branch ?? null,
			pr: parseOptionalPositiveInteger(args.pr ?? null, "--pr"),
			issueFile: args.issueFile ?? null,
			evidenceDir: args.evidenceDir ?? null,
			runner: parseOptionalRunner(args.runner ?? null, "--runner"),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemCliCommand = subcommands({
	name: "item",
	description: "Operate centralized coder-loop chain items through the daemon socket.",
	cmds: {
		add: itemAddCliCommand,
		"batch-add": itemBatchAddCliCommand,
		list: itemListCliCommand,
		update: itemUpdateCliCommand,
	},
})

const queueUnblockCliCommand = command({
	name: "unblock",
	description: "Requeue one blocked item and clear its blocker metadata.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		config: option({ long: "config", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
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
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
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
	return parseOptionalPositiveInteger(value, "--max-iterations")
}

function parseOptionalPositiveInteger(value: string | null, flagName: string): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flagName} must be a positive integer, got: ${value}`)
	return parsed
}

function parseRequiredPositiveInteger(value: string, flagName: string): number {
	const parsed = parseOptionalPositiveInteger(value, flagName)
	if (parsed === null) fail(`${flagName} is required`)
	return parsed
}

function parseOptionalNonNegativeInteger(value: string | null, flagName: string): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) fail(`${flagName} must be a non-negative integer, got: ${value}`)
	return parsed
}

function parseOptionalRunner(value: string | null, flagName: string): AgentRunnerKind | null {
	if (value === null) return null
	if (value === "claude" || value === "codex") return value
	fail(`${flagName} must be claude or codex, got: ${value}`)
}

async function runStatusCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(statusCliCommand, args)
	if (parsed.kind !== "status") return
	const snapshot = await buildCoderLoopStatusSnapshot(parsed.args)
	StatusSnapshotBoundary.assert(snapshot)
	process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
}

async function runChainCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(chainCliCommand, args)
	if (parsed.value.kind !== "chain") return
	const chainArgs = parsed.value.args
	if (chainArgs.action === "create") {
		const requestArgs: JsonObject = {
			name: chainArgs.name,
			repository: chainArgs.repository,
		}
		if (chainArgs.preset !== null) requestArgs.preset = chainArgs.preset
		if (chainArgs.baseBranch !== null) requestArgs.baseBranch = chainArgs.baseBranch
		if (chainArgs.umbrella !== null) Object.assign(requestArgs, parseUmbrellaRef(chainArgs.umbrella, chainArgs.repository))
		if (chainArgs.force) requestArgs.force = true
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.create", requestArgs)
		writeCommandResult(result, chainArgs.json, formatChainCreateResult)
		return
	}
	if (chainArgs.action === "list") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.list")
		writeCommandResult(result, chainArgs.json, formatChainListResult)
		return
	}
	if (chainArgs.action === "status") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.status", { chainName: chainArgs.name })
		writeCommandResult(result, chainArgs.json, formatChainStatusResult)
		return
	}
	const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.delete", { chainName: chainArgs.name })
	writeCommandResult(result, chainArgs.json, formatChainDeleteResult)
}

async function runItemCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(itemCliCommand, args)
	if (parsed.value.kind !== "item") return
	const itemArgs = parsed.value.args
	if (itemArgs.action === "add") {
		const requestArgs: JsonObject = {
			chainName: itemArgs.chainName,
			issueNumber: itemArgs.issueNumber,
			repoCwd: itemArgs.repoCwd,
		}
		assignCliOptional(requestArgs, "status", itemArgs.status)
		assignCliOptional(requestArgs, "attempts", itemArgs.attempts)
		assignCliOptional(requestArgs, "title", itemArgs.title)
		assignCliOptional(requestArgs, "priority", itemArgs.priority)
		assignCliOptional(requestArgs, "branch", itemArgs.branch)
		assignCliOptional(requestArgs, "pr", itemArgs.pr)
		assignCliOptional(requestArgs, "lastRunId", itemArgs.lastRunId)
		assignCliOptional(requestArgs, "issueFile", itemArgs.issueFile)
		assignCliOptional(requestArgs, "evidenceDir", itemArgs.evidenceDir)
		assignCliOptional(requestArgs, "agentCwd", itemArgs.agentCwd)
		assignCliOptional(requestArgs, "runner", itemArgs.runner)
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.add", requestArgs)
		writeCommandResult(result, itemArgs.json, formatItemMutationResult)
		return
	}
	if (itemArgs.action === "batch-add") {
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.batchAdd", { chainName: itemArgs.chainName, items: itemArgs.items })
		writeCommandResult(result, itemArgs.json, formatItemBatchAddResult)
		return
	}
	if (itemArgs.action === "list") {
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.list", { chainName: itemArgs.chainName })
		writeCommandResult(result, itemArgs.json, formatItemListResult)
		return
	}
	const requestArgs: JsonObject = {
		chainName: itemArgs.chainName,
		issueNumber: itemArgs.issueNumber,
		fields: {},
	}
	const fields = requestArgs.fields as JsonObject
	assignCliOptional(fields, "repoCwd", itemArgs.repoCwd)
	assignCliOptional(fields, "status", itemArgs.status)
	assignCliOptional(fields, "title", itemArgs.title)
	assignCliOptional(fields, "priority", itemArgs.priority)
	assignCliOptional(fields, "branch", itemArgs.branch)
	assignCliOptional(fields, "pr", itemArgs.pr)
	assignCliOptional(fields, "issueFile", itemArgs.issueFile)
	assignCliOptional(fields, "evidenceDir", itemArgs.evidenceDir)
	assignCliOptional(fields, "runner", itemArgs.runner)
	if (Object.keys(fields).length === 0) fail("item update requires at least one field to update")
	const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.update", requestArgs)
	writeCommandResult(result, itemArgs.json, formatItemMutationResult)
}

function assignCliOptional(target: JsonObject, key: string, value: JsonValue | undefined): void {
	if (value !== undefined && value !== null) target[key] = value
}

function isJsonObjectRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBatchItemsJson(raw: string): JsonObject[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		fail(`--items-json must be a JSON array: ${errorMessage(error)}`)
	}
	if (!Array.isArray(parsed)) fail("--items-json must be a JSON array")
	return parsed.map((entry, index) => {
		if (!isJsonObjectRecord(entry)) fail(`--items-json[${index}] must be an object`)
		const item = { ...entry } as JsonObject
		if (typeof item.issue === "number" && item.issueNumber === undefined) {
			item.issueNumber = item.issue
			delete item.issue
		}
		if (typeof item.repoCwd === "string") item.repoCwd = resolve(item.repoCwd)
		return item
	})
}

function parseUmbrellaRef(raw: string, defaultRepo: string): JsonObject {
	const trimmed = raw.trim()
	const match = /^(?:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<issue>[1-9][0-9]*)$/.exec(trimmed)
	if (match === null) fail(`--umbrella must look like owner/repo#123 or #123, got: ${raw}`)
	const issue = Number(match.groups?.issue)
	const repo = match.groups?.repo ?? defaultRepo
	return {
		umbrellaRepo: repo,
		umbrellaIssue: issue,
	}
}

async function runCentralDaemonStatusCommand(args: string[]): Promise<void> {
	const options = parseCentralDaemonSocketOptions(args, "daemon status")
	const result = await requestDaemonResultForDaemonCommand(options.loopDataRoot, "daemon.status", {}, options.json)
	if (result === null) return
	writeCommandResult(result, options.json, formatDaemonStatusResult)
}

function isCentralDaemonStatusInvocation(args: string[]): boolean {
	if (args[0] !== "status") return false
	if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) return false
	return !hasPositionalArgument(args.slice(1))
}

function hasPositionalArgument(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		if (!arg.startsWith("-")) return true
		const [name, inlineValue] = splitFlag(arg)
		if (inlineValue !== null) continue
		if (name === "--loop-data-root") index++
	}
	return false
}

function parseCentralDaemonSocketOptions(args: string[], usage: string): { loopDataRoot: string | null; json: boolean } {
	let loopDataRoot: string | null = null
	let json = false
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`${usage}: missing argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--loop-data-root":
				loopDataRoot = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--json":
				rejectInlineValue(inlineValue, name)
				json = true
				break
			default:
				fail(`${usage}: unknown argument ${arg}`)
		}
	}
	return { loopDataRoot, json }
}

async function requestDaemonResult(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject = {}): Promise<JsonObject> {
	const pathOptions = loopDataRoot === null ? {} : { loopDataRoot }
	const socketPath = resolveLoopDataPaths(pathOptions).daemonSocket
	let response: Awaited<ReturnType<typeof sendDaemonRequest>>
	try {
		response = await sendDaemonRequest(socketPath, daemonRequest(command, args))
	} catch (error) {
		fail(centralDaemonNotRunningMessage(loopDataRoot, socketPath, error))
	}
	if (!response.ok) fail(`${response.error.code}: ${response.error.message}`)
	return response.result
}

async function requestDaemonResultForDaemonCommand(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject, json: boolean): Promise<JsonObject | null> {
	const response = await sendDaemonRequestForDaemonCommand(loopDataRoot, command, args, json)
	if (response === null) return null
	if (!response.ok) {
		if (json) {
			writeDaemonErrorResponse(daemonErrorResponse(response.error.code, response.error.message, response.error.details ?? {}))
			return null
		}
		fail(`${response.error.code}: ${response.error.message}`)
	}
	return response.result
}

async function sendDaemonRequestForDaemonCommand(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject, json: boolean): Promise<DaemonResponse | null> {
	let socketPath: string
	try {
		socketPath = resolveLoopDataPaths(loopDataRoot === null ? {} : { loopDataRoot }).daemonSocket
	} catch (error) {
		if (json) {
			writeDaemonErrorResponse(daemonCliErrorResponse(error, "invalid_loop_data_root"))
			return null
		}
		throw error
	}

	try {
		return await sendDaemonRequest(socketPath, daemonRequest(command, args))
	} catch (error) {
		if (json) {
			writeDaemonErrorResponse(daemonNotRunningErrorResponse(loopDataRoot, socketPath, error))
			return null
		}
		fail(centralDaemonNotRunningMessage(loopDataRoot, socketPath, error))
	}
}

function centralDaemonNotRunningMessage(loopDataRoot: string | null, socketPath: string, error: unknown): string {
	const hint = loopDataRoot === null ? "coder-loop daemon up" : `coder-loop daemon up --loop-data-root ${loopDataRoot}`
	const detail = isNodeError(error) && typeof error.code === "string" ? `${error.code}: ${errorMessage(error)}` : errorMessage(error)
	return `central daemon is not running at ${socketPath}; start it with \`${hint}\`. ${detail}`
}

function daemonNotRunningErrorResponse(loopDataRoot: string | null, socketPath: string, error: unknown): JsonObject {
	const details: JsonObject = { socketPath }
	if (loopDataRoot !== null) details.loopDataRoot = loopDataRoot
	if (isNodeError(error) && typeof error.code === "string") details.causeCode = error.code
	return daemonErrorResponse("daemon_not_running", centralDaemonNotRunningMessage(loopDataRoot, socketPath, error), details)
}

function daemonCliErrorResponse(error: unknown, fallbackCode: string): JsonObject {
	if (error instanceof DaemonError) return daemonErrorResponse(error.code, error.message, error.details)
	if (error instanceof RuntimePathError) {
		return daemonErrorResponse(error.code, error.message, { input: error.input })
	}
	return daemonErrorResponse(fallbackCode, errorMessage(error))
}

function daemonErrorResponse(code: string, message: string, details: JsonObject = {}): JsonObject {
	const error: JsonObject = { code, message }
	if (Object.keys(details).length > 0) error.details = details
	return { ok: false, error }
}

function writeDaemonErrorResponse(response: JsonObject): void {
	process.stdout.write(`${JSON.stringify(response, null, "\t")}\n`)
	process.exitCode = 1
}

function writeCommandResult(result: JsonObject, json: boolean, formatText: (result: JsonObject) => string): void {
	writeJsonOrText(result, json, formatText)
}

function writeJsonOrText(result: JsonObject, json: boolean, formatText: (result: JsonObject) => string): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`)
		return
	}
	process.stdout.write(formatText(result))
}

function formatChainCreateResult(result: JsonObject): string {
	const chain = result.chain as JsonObject | undefined
	return `created chain ${String(chain?.name ?? "")}\n`
}

function formatChainListResult(result: JsonObject): string {
	const chains = Array.isArray(result.chains) ? result.chains : []
	if (chains.length === 0) return "no chains\n"
	return chains.map((raw) => {
		const chain = raw as JsonObject
		return `${String(chain.name)}\t${String(chain.status)}\t${String(chain.repository)}\n`
	}).join("")
}

function formatChainStatusResult(result: JsonObject): string {
	const chain = result.chain as JsonObject | undefined
	const summary = result.summary as JsonObject | undefined
	const items = summary?.items as JsonObject | undefined
	const total = typeof items?.total === "number" ? items.total : 0
	const activeSlots = Array.isArray(summary?.activeSlots) ? summary.activeSlots.length : 0
	return [
		`chain: ${String(chain?.name ?? "")}`,
		`status: ${String(chain?.status ?? "")}`,
		`repository: ${String(chain?.repository ?? "")}`,
		`items: ${total}`,
		`activeSlots: ${activeSlots}`,
		"",
	].join("\n")
}

function formatChainDeleteResult(result: JsonObject): string {
	const chain = result.chain as JsonObject | undefined
	return `deleted chain ${String(chain?.name ?? "")}\n`
}

function formatItemMutationResult(result: JsonObject): string {
	const item = result.item as JsonObject | undefined
	return `item ${String(item?.issueNumber ?? "")}: ${String(item?.status ?? "")}\n`
}

function formatItemBatchAddResult(result: JsonObject): string {
	const items = Array.isArray(result.items) ? result.items : []
	return `added ${items.length} item(s)\n`
}

function formatItemListResult(result: JsonObject): string {
	const items = Array.isArray(result.items) ? result.items : []
	if (items.length === 0) return "no items\n"
	return items.map((raw) => {
		const item = raw as JsonObject
		return `${String(item.issueNumber)}\t${String(item.status)}\t${String(item.repoCwd)}\n`
	}).join("")
}

function formatDaemonStatusResult(result: JsonObject): string {
	const daemon = result.daemon as JsonObject | undefined
	const activeRuns = Array.isArray(daemon?.activeRuns) ? daemon.activeRuns.length : 0
	return [
		`pid: ${String(daemon?.pid ?? "")}`,
		`running: ${String(daemon?.running ?? "")}`,
		`socket: ${String(daemon?.socketPath ?? "")}`,
		`activeRuns: ${activeRuns}`,
		"",
	].join("\n")
}

function formatDaemonUpResult(result: JsonObject): string {
	return `daemon up: pid=${String(result.pid ?? "")} socket=${String(result.socketPath ?? "")}\n`
}

function formatDaemonDownResult(result: JsonObject): string {
	const daemon = result.daemon as JsonObject | undefined
	return `daemon down: shutdown=${String(result.shutdown ?? false)} pid=${String(daemon?.pid ?? "")} socket=${String(daemon?.socketPath ?? "")}\n`
}

function formatDaemonStartResult(result: JsonObject): string {
	if (result.dryRun === true) {
		return [
			`daemon start dry-run: target=${String(result.target ?? "")}`,
			`daemon start dry-run: chain=${String(result.chain ?? "")}`,
			`daemon start dry-run: central-daemon=${String(result.centralDaemon ?? "required")}`,
			`daemon start dry-run: require-browser-evidence=${String(result.requireBrowserEvidence ?? false)}`,
			"",
		].join("\n")
	}
	const daemon = result.daemon as JsonObject | undefined
	return `daemon start: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} already-running=${String(result.alreadyRunning ?? false)} pid=${String(daemon?.pid ?? "")}\n`
}

function formatDaemonStopResult(result: JsonObject): string {
	if (result.dryRun === true) return `daemon stop dry-run: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")}\n`
	const mutation = result.result as JsonObject | undefined
	const chain = mutation?.chain as JsonObject | undefined
	return `daemon stop: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} status=${String(chain?.status ?? "")}\n`
}

function formatDaemonRestartResult(result: JsonObject): string {
	if (result.dryRun === true) {
		return `daemon restart dry-run: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} central-daemon=${String(result.centralDaemon ?? "required")}\n`
	}
	const daemon = result.daemon as JsonObject | undefined
	return `daemon restart: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} restarted=${String(result.restarted ?? false)} pid=${String(daemon?.pid ?? "")}\n`
}

async function runDaemonCommand(args: string[]): Promise<void> {
	if (isCentralDaemonStatusInvocation(args)) {
		await runCentralDaemonStatusCommand(args)
		return
	}
	const parsed = await runCmd(daemonCliCommand, args)
	if (parsed.value.kind !== "daemon") return
	const daemonArgs = parsed.value.args
	if (daemonArgs.action === "up") {
		await runDaemonUpCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "down") {
		await runDaemonDownCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "status") {
		const snapshot = await buildCoderLoopStatusSnapshot({
			targetCwd: daemonArgs.targetCwd,
			configPath: daemonArgs.configPath,
			loopDataRoot: daemonArgs.loopDataRoot ?? null,
			chainName: daemonArgs.chainName ?? null,
			repository: daemonArgs.repository,
			output: "json",
		})
		StatusSnapshotBoundary.assert(snapshot)
		process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
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

async function runQueueCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(queueCliCommand, args)
	if (parsed.value.kind !== "queue") return
	await runQueueUnblockCommand(parsed.value.args)
}

async function main() {
	const firstArg = process.argv[2]
	if (firstArg === "status") {
		await runStatusCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "daemon") {
		await runDaemonCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "chain") {
		await runChainCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "item") {
		await runItemCommand(process.argv.slice(3))
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
	const loadedRuntime = await loadTargetRuntime({
		targetCwd: rawArgs.targetCwd ?? process.cwd(),
		configPath: rawArgs.configPath,
		loopDataRoot: rawArgs.loopDataRoot,
		chainName: rawArgs.chainName,
		repository: rawArgs.repository,
		baseBranch: rawArgs.baseBranch,
		requireBrowserEvidence: rawArgs.requireBrowserEvidence,
		once: rawArgs.once,
		dryRun: rawArgs.dryRun,
		checkRuntime: rawArgs.checkRuntime,
		worktree: rawArgs.worktree,
		maxIterations: rawArgs.maxIterations,
		workflowPath: rawArgs.workflowPath,
		stateFile: rawArgs.stateFile,
	})
	const options = loadedRuntime.options

	if (options.checkRuntime) {
		const selected = selectIssue(loadedRuntime.state, options, loadedRuntime.chain)
		const errors = await checkRuntime(options, loadedRuntime.state, loadedRuntime.chain)
		if (errors.length > 0) {
			console.error(`Runtime check failed: ${errors.length} error(s)`)
			for (const error of errors) console.error(`- ${error.path}: ${error.message}`)
			process.exit(1)
		}
		console.error(`Runtime check passed: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Runtime check passed: repo=${options.repository}`)
		console.error(`Runtime check passed: config=${options.configPath} (${configFormatForPath(options.configPath)})`)
		console.error(`Runtime check passed: state=${resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile}`)
		console.error(`Runtime check passed: chain=${loadedRuntime.chain.name}`)
		console.error(`Runtime check passed: queue=${loadedRuntime.state.queue.length}, selected=${selected ? getItemId(selected.item, options.preset) : "none"}`)
		console.error(`Runtime check passed: preset=${options.preset.name}`)
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

	if (options.dryRun) {
		const { chain, state } = await loadLoopStateFromDb(options)
		const selected = selectIssue(state, options, chain)
		console.error(`Dry run: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Dry run: repo=${options.repository}`)
		console.error(`Dry run: workflow=${options.workflowPath}`)
		console.error(`Dry run: state=${resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile}`)
		console.error(`Dry run: selected=${selected ? getItemId(selected.item, options.preset) : "none"}`)
		if (selected) {
			const kindResult = await resolveIssueKind(options.repository, getItemId(selected.item, options.preset), selected.item.extra)
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

	logStream = createWriteStream(options.logFile, { flags: "a" })
	log(`=== coder-loop started (pid=${process.pid}, cwd=${options.targetCwd}) ===`)
	log(`Config: maxIterations=${formatMaxIterations(options.maxIterations)}`)
	log(`Repo=${options.repository}`)
	log(`Preset dir: ${options.preset.presetDir}`)
	log(`Default runner: ${options.defaultRunner.kind} (${options.defaultRunner.source}, binary=${options.defaultRunner.binary}, model=${options.defaultRunner.model ?? "<default>"})`)
	for (const phase of options.preset.phases) log(`Phase ${phase.name} prompt: ${phase.prompt}`)
	log(`Workflow=${options.workflowPath}`)
	log(`State=${resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile}`)
	if (options.worktree) {
		log(`Worktree mode: baseBranch=origin/${options.baseBranch}`)
		const { state: startupState } = await loadLoopStateFromDb(options)
		const activeIds = new Set<string>()
		for (const item of startupState.queue) {
			if (options.preset.statuses.continuable.includes(item.status)) {
				activeIds.add(getItemId(item, options.preset).replace(/[^a-zA-Z0-9_-]/g, "_"))
			}
		}
		cleanupStaleWorktrees(options.targetCwd, activeIds, log)
	}

	let stopRequested = false
	const requestStop = (signal: NodeJS.Signals): void => {
		stopRequested = true
		log(`Stop requested by ${signal}; loop will exit after the current safe point.`)
	}
	process.once("SIGTERM", requestStop)
	process.once("SIGINT", requestStop)

	let workIteration = 0
	const idleSleepMs = resolveIdleSleepMs()
	const lockPath = reviewOnEmptyLockPath(options.stateFile)
	log(`Idle sleep: ${idleSleepMs}ms (override via CODER_LOOP_IDLE_SLEEP_MS)`)
	log(`Review-on-empty lock: ${lockPath}`)

	while (!stopRequested && workIteration < options.maxIterations) {
		const dbSnapshot = await loadLoopStateFromDb(options)
		const state = dbSnapshot.state
		await assertRuntimeValid(options, state, dbSnapshot.chain)
		let selected = selectIssue(state, options, dbSnapshot.chain)

		if (options.worktree && selected && selected.item.agentCwd === null) {
			const selectedId = getItemId(selected.item, options.preset)
			const wtPath = ensureWorktreeForItem(
				options.targetCwd,
				options.baseBranch ?? "main",
				selectedId,
				selected.item.agentCwd,
			)
			selected.item.agentCwd = wtPath
			await saveLoopStateToDb(options, dbSnapshot.chain, state)
			selected = { ...selected, agentCwd: wtPath }
			log(`worktree: created ${wtPath} for item #${selectedId}`)
		}

		if (!selected) {
			if (!(await exists(lockPath))) {
				log("Empty queue: running review-on-empty for global state assessment.")
				const fallbackItem = makeFallbackItem()
				const fallbackRunId = makeRunId(null)
				const fallbackIssueRun: IssueRunContext = { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null, resumedSessionId: null }
				const fallbackCtx: ResolveContext = {
					item: fallbackItem,
					config: buildConfigBindings(options),
					runtime: buildRuntimeBindings({
						options,
						runId: fallbackRunId,
						currentIssueFile: "",
						evidenceDir: null,
						agentCwd: options.targetCwd,
						issueRun: fallbackIssueRun,
						issueKind: null,
						paths: buildCentralRuntimeBindingPaths({
							options,
							chain: dbSnapshot.chain,
							runId: fallbackRunId,
							currentIssueFile: "",
							evidenceDir: null,
						}),
					}),
				}
				const fallbackReview = await runReview(options, fallbackRunId, fallbackCtx, options.targetCwd, options.reviewRunner)
				if (fallbackReview.stopRequested) {
					log("Review agent requested loop stop.")
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
		const kindResult = await resolveIssueKind(options.repository, selectedId, selected.item.extra)
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
				paths: buildCentralRuntimeBindingPaths({
					options,
					chain: dbSnapshot.chain,
					runId,
					currentIssueFile: selected.issueFile,
					evidenceDir: selected.evidenceDir,
				}),
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
			const iterationSnapshot = await loadLoopStateFromDb(options)
			const stateForIteration = iterationSnapshot.state
			markIterationStarted(stateForIteration, selected.item, options.preset, runId, current === null)
			await saveLoopStateToDb(options, iterationSnapshot.chain, stateForIteration)

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
				break
			}

			if (stopRequested) {
				log("Stop requested during iteration. Stopping before review.")
				break
			}

			markReviewStarted(stateForIteration, selected.item, options.preset, runId)
			await saveLoopStateToDb(options, iterationSnapshot.chain, stateForIteration)
		} else {
			log(`Resuming ${reviewPhase.name} agent for issue #${selectedId} without rerunning iteration...`)
		}

		const reviewResult = await runReview(options, runId, ctx, selected.agentCwd, selected.reviewRunner, { emit, ...baseEvent })
		if (reviewResult.code !== 0) {
			log(`Review agent crashed (exit ${reviewResult.code}). Stopping.`)
			break
		}

		if (reviewResult.stopRequested) {
			log("Review agent requested loop stop.")
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
			break
		}

		if (stopRequested) {
			log(`Stop requested after post-${reviewPhase.name} trigger.`)
			break
		}

		const { state: stateAfterReviewTriggers } = await loadLoopStateFromDb(options)
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
	for (const phase of options.preset.phases.filter((candidate) => candidate.trigger !== null && !isChainCompleteTrigger(candidate.trigger) && candidate.trigger.afterPhase === afterPhase)) {
		const trigger = phase.trigger
		if (trigger === null || isChainCompleteTrigger(trigger)) continue
		const { chain, state } = await loadLoopStateFromDb(options)
		const item = state.queue.find((queueItem) => getItemId(queueItem, options.preset) === selectedId)
		if (!item) {
			log(`Skipping trigger phase ${phase.name}: issue #${selectedId} no longer exists in queue.`)
			continue
		}
		if (trigger.whenStatus !== item.status) {
			log(`Skipping trigger phase ${phase.name}: status=${item.status}, wanted=${trigger.whenStatus}.`)
			continue
		}

		const issueFile = resolveChainIssueFile(options, chain, item, selectedId, "Triggered issue file")
		const evidenceDir = resolveChainEvidenceDir(options, chain, item, selectedId, "Triggered evidence directory")

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
				issueRun: { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null, resumedSessionId: null },
				issueKind,
				paths: buildCentralRuntimeBindingPaths({
					options,
					chain,
					runId,
					currentIssueFile: issueFile,
					evidenceDir,
				}),
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
): Promise<{ code: number; stopRequested: boolean }> {
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
	const stopRequested = reviewCode === 0 && parseReviewSummaryVerdict(reviewTrace, runner.kind) === "stop"
	if (stopRequested) log(`${reviewPhase.name} agent requested loop stop via REVIEW SUMMARY.`)
	return { code: reviewCode, stopRequested }
}

function buildOptions(targetCwd: string, configPath: string, raw: RawArgs, config: LoopConfig, preset: Preset): LoopOptions {
	const workflowPath = resolveFrom(targetCwd, raw.workflowPath ?? config.workflowFile ?? DEFAULT_WORKFLOW_FILE)
	const sharedContextPath = resolveFrom(targetCwd, config.sharedContextFile ?? DEFAULT_SHARED_FILE)
	const loopDataRoot = raw.loopDataRoot ?? config.loopDataRoot
	const stateFile = resolveFrom(targetCwd, raw.stateFile ?? config.stateFile ?? resolveLoopDataPaths(loopDataRootOption(loopDataRoot)).dbFile)
	const issueDir = resolveFrom(targetCwd, config.issueDir ?? DEFAULT_ISSUE_DIR)
	const evidenceRootDir = resolveFrom(targetCwd, config.evidenceDir ?? DEFAULT_EVIDENCE_DIR)
	const logDir = resolveFrom(targetCwd, config.logDir ?? DEFAULT_LOG_DIR)
	const repository = raw.repository ?? config.repository
	const maxIterations = raw.once ? 1 : (raw.maxIterations ?? Number.POSITIVE_INFINITY)
	const requireBrowserEvidence = raw.requireBrowserEvidence ?? config.requireAgentBrowserScreenshots ?? false
	const worktree = raw.worktree || config.worktree === true
	const baseBranch = raw.baseBranch ?? config.baseBranch ?? (worktree ? "main" : null)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const chainPaths = raw.chainName === null ? null : resolveChainRuntimePaths(raw.chainName, loopDataRootOption(loopDataRoot))
	const hostRunner = detectHostRunner(process.env)
	const runnerCommands = buildAgentRunnerCommands(config)
	const defaultRunner = selectDefaultRunner(config.defaultRunner, runnerCommands)
	const reviewRunner = selectReviewRunner(config.reviewRunner, runnerCommands)

	return {
		targetCwd,
		configPath,
		workflowPath,
		sharedContextPath,
		stateFile,
		issueDir,
		evidenceRootDir,
		logDir,
		loopDataRoot,
		logFile: chainPaths === null ? resolve(logDir, `coder-loop-${process.pid}.${timestamp}.log`) : chainPaths.daemonLogFile(timestamp),
		repository,
		baseBranch,
		chainName: raw.chainName,
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
	let loaded: LoadedTargetRuntime
	try {
		loaded = await loadTargetRuntime({
			targetCwd: args.targetCwd,
			configPath: args.configPath,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chainName ?? null,
			repository: args.repository,
			baseBranch: null,
			requireBrowserEvidence: null,
			once: false,
			dryRun: false,
			checkRuntime: false,
			worktree: false,
			maxIterations: null,
			workflowPath: null,
			stateFile: null,
		})
	} catch (error) {
		const targetCwd = resolve(args.targetCwd)
		const dbFile = resolveLoopDataPaths(loopDataRootOption(args.loopDataRoot ?? null)).dbFile
		const processes = await buildCentralStatusProcessSnapshot({
			targetCwd,
			loopDataRoot: args.loopDataRoot ?? null,
		})
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, dbFile, args.repository, null, { kind: "missing", error: errorMessage(error) }),
			stateKind: "missing-state",
			stateFile: dbFile,
			errorPath: "chain",
			errorMessage: errorMessage(error),
			processes,
		})
	}
	const options = loaded.options
	const target = makeStatusTargetSnapshot(options.targetCwd, options.configPath, args.repository, options, { kind: "loaded", error: null })
	const selected = selectIssue(loaded.state, options, loaded.chain)
	const runtimeErrors = await checkRuntime(options, loaded.state, loaded.chain)
	const currentSnapshot = await buildStatusCurrentSnapshot(options, loaded.state)
	const events = await buildStatusEventsSnapshot(options, loaded.state, selected)
	const processes = await buildCentralStatusProcessSnapshot(options)
	const snapshot: CoderLoopStatusSnapshot = {
		target,
		state: {
			kind: runtimeErrors.length === 0 ? "ok" : "invalid-runtime",
			ok: runtimeErrors.length === 0,
			loaded: true,
			path: resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile,
			version: loaded.state.version,
			repository: loaded.state.repository,
			baseBranch: loaded.state.baseBranch,
			errors: runtimeErrors,
			error: null,
		},
		queue: buildStatusQueueSnapshot(options, loaded.state, selected),
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
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing config file: ${path}` }
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

function makeStatusTargetSnapshot(
	targetCwd: string,
	configPath: string,
	repositoryOverride: string | null,
	options: LoopOptions | null,
	config: StatusResourceSnapshot,
): StatusTargetSnapshot {
	const runtimeRoot = resolve(targetCwd, ".coder-loop/runtime")
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
		stateFile: options?.stateFile ?? resolve(runtimeRoot, "state.json"),
		issueDir: options?.issueDir ?? resolve(runtimeRoot, "issues"),
		evidenceRootDir: options?.evidenceRootDir ?? resolve(runtimeRoot, "evidence"),
		logDir: options?.logDir ?? resolve(runtimeRoot, "logs"),
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
		loopDataRoot: null,
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
	stateFile: string
	errorPath: string
	errorMessage: string
	processes?: StatusProcessSnapshot
}): CoderLoopStatusSnapshot {
	return {
		target: input.target,
		state: {
			kind: input.stateKind,
			ok: false,
			loaded: false,
			path: input.stateFile,
			version: null,
			repository: null,
			baseBranch: null,
			errors: [{ path: input.errorPath, message: input.errorMessage }],
			error: input.errorMessage,
		},
		queue: { total: 0, byStatus: {}, continuable: 0, terminal: 0, selected: null },
		current: { run: null, id: null, item: null, runner: null, phaseStatus: null },
		events: { runId: null, path: null, exists: false, recent: [], latest: null, error: null },
		processes: input.processes ?? { live: [], scanError: null },
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

async function buildCentralStatusProcessSnapshot(options: Pick<LoopOptions, "targetCwd" | "loopDataRoot">): Promise<StatusProcessSnapshot> {
	const scan = scanLoopProcesses(options.targetCwd)
	const live = scan.kind === "ok" ? [...scan.value] : []
	const scanErrors = scan.kind === "ok" ? [] : [scan.message]
	const daemon = await readCentralDaemonProcessInfo(options.loopDataRoot)
	if (daemon.kind === "ok" && daemon.value !== null) {
		const daemonInfo = daemon.value
		if (live.every((entry) => entry.pid !== daemonInfo.pid)) live.push(daemonInfo)
	} else if (daemon.kind === "invalid") {
		scanErrors.push(daemon.message)
	}
	return {
		live,
		scanError: scanErrors.length === 0 ? null : scanErrors.join("; "),
	}
}

async function readCentralDaemonProcessInfo(loopDataRoot: string | null): Promise<StatusReadResult<StatusProcessInfo | null>> {
	const socketPath = resolveLoopDataPaths(loopDataRootOption(loopDataRoot)).daemonSocket
	let response: DaemonResponse
	try {
		response = await sendDaemonRequest(socketPath, daemonRequest("daemon.status"))
	} catch (error) {
		return { kind: "missing", message: centralDaemonNotRunningMessage(loopDataRoot, socketPath, error) }
	}
	if (!response.ok) return { kind: "invalid", message: `${response.error.code}: ${response.error.message}` }
	const processInfo = centralDaemonStatusToProcessInfo(response.result)
	if (processInfo === null) return { kind: "invalid", message: "daemon.status response did not include daemon process metadata" }
	return { kind: "ok", value: processInfo }
}

function centralDaemonStatusToProcessInfo(result: JsonObject): StatusProcessInfo | null {
	const daemon = result.daemon
	if (!isObjectRecord(daemon)) return null
	if (typeof daemon.pid !== "number" || !Number.isInteger(daemon.pid)) return null
	return {
		pid: daemon.pid,
		ppid: null,
		command: null,
		cwd: null,
		matchesTarget: true,
		alive: daemon.running !== false && isPidAlive(daemon.pid),
		source: "daemon-socket",
	}
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
	command: string[]
	commandLine: string
	stdoutPath: string
	stderrPath: string
	requireBrowserEvidence: boolean
}

type DaemonStartResult =
	| {
			action: "start"
			target: string
			pid: number | null
			command: string[]
			stdoutPath: string
			stderrPath: string
			requireBrowserEvidence: boolean
	  }
		| {
				action: "start"
				target: string
				alreadyRunning: true
				pid: number
				source: StatusProcessInfo["source"]
		  }

const DAEMON_SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const
const DAEMON_IGNORED_SIGNALS = ["SIGHUP", "SIGUSR1", "SIGUSR2", "SIGPIPE"] as const

export function buildDaemonStartPlan(args: Extract<DaemonCommandArgs, { action: "start" }>): DaemonStartPlan {
	const targetCwd = resolve(args.targetCwd)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const chainName = args.chainName ?? null
	const chainPaths = chainName === null ? null : resolveChainRuntimePaths(chainName, loopDataRootOption(args.loopDataRoot ?? null))
	const logDir = chainPaths === null ? resolve(targetCwd, DEFAULT_LOG_DIR) : chainPaths.daemonBatchDir(timestamp)
	const stdoutPath = resolve(logDir, "stdout.log")
	const stderrPath = resolve(logDir, "stderr.log")
	const command = [
		process.argv[0] ?? "bun",
		resolve(import.meta.dir, "loop.ts"),
		"--target-cwd",
		targetCwd,
	]
	if (args.configPath !== null) command.push("--config", args.configPath)
	if (chainName !== null) command.push("--chain", chainName)
	if (args.repository !== null) command.push("--repo", args.repository)
	if (args.requireBrowserEvidence) command.push("--require-browser-evidence")
	if (args.worktree) command.push("--worktree")
	if (args.baseBranch !== null) command.push("--base-branch", args.baseBranch)
	if (args.maxIterations !== null) command.push(String(args.maxIterations))
	return {
		targetCwd,
		command,
		commandLine: command.map(shellQuote).join(" "),
		stdoutPath,
		stderrPath,
		requireBrowserEvidence: args.requireBrowserEvidence,
	}
}

async function runDaemonUpCommand(args: Extract<DaemonCommandArgs, { action: "up" }>): Promise<void> {
	const scheduler = args.schedulerIntervalMs === null ? {} : { intervalMs: args.schedulerIntervalMs }
	let daemon: CoderLoopDaemon | null = null
	let shutdownStarted = false
	const shutdown = () => {
		if (shutdownStarted) return
		shutdownStarted = true
		if (daemon === null) {
			process.exit(0)
			return
		}
		void daemon.stop().then(() => process.exit(0))
	}
	const ignoreSignal = () => undefined
	let signalsRegistered = false
	let started = false
	try {
		daemon = new CoderLoopDaemon({
			...(args.loopDataRoot === null ? {} : { loopDataRoot: args.loopDataRoot }),
			scheduler,
		})
		for (const signal of DAEMON_SHUTDOWN_SIGNALS) process.once(signal, shutdown)
		for (const signal of DAEMON_IGNORED_SIGNALS) process.on(signal, ignoreSignal)
		signalsRegistered = true
		await daemon.start()
		started = true
		const result = {
			action: "up",
			pid: process.pid,
			socketPath: daemon.snapshot().socketPath,
			pidFile: daemon.snapshot().pidFile,
		}
		writeJsonOrText(result, args.json, formatDaemonUpResult)
		await daemon.closed
	} catch (error) {
		if (args.json && !started) {
			writeDaemonErrorResponse(daemonCliErrorResponse(error, "daemon_start_failed"))
			return
		}
		throw error
	} finally {
		if (signalsRegistered) {
			for (const signal of DAEMON_SHUTDOWN_SIGNALS) process.off(signal, shutdown)
			for (const signal of DAEMON_IGNORED_SIGNALS) process.off(signal, ignoreSignal)
		}
	}
}

async function runDaemonDownCommand(args: Extract<DaemonCommandArgs, { action: "down" }>): Promise<void> {
	const response = await sendDaemonRequestForDaemonCommand(args.loopDataRoot, "daemon.down", {}, args.json)
	if (response === null) return
	if (args.json) {
		process.stdout.write(`${JSON.stringify(response, null, "\t")}\n`)
		if (!response.ok) process.exitCode = 1
		return
	}
	if (!response.ok) {
		process.stderr.write(`daemon down failed: ${response.error.code}: ${response.error.message}\n`)
		process.exitCode = 1
		return
	}
	process.stdout.write(formatDaemonDownResult(response.result))
}

async function runDaemonStartCommand(args: Extract<DaemonCommandArgs, { action: "start" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "start",
			target: runtime.options.targetCwd,
			chain: runtime.chain.name,
			dryRun: true,
			centralDaemon: "required",
			requireBrowserEvidence: runtime.options.requireBrowserEvidence,
		}, args.json, formatDaemonStartResult)
		return
	}
	const daemon = await requestDaemonResult(args.loopDataRoot ?? null, "daemon.status")
	writeJsonOrText({
		action: "start",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		alreadyRunning: true,
		daemon: daemon.daemon ?? null,
	}, args.json, formatDaemonStartResult)
}

async function executeDaemonStart(args: Extract<DaemonCommandArgs, { action: "start" }>, plan = buildDaemonStartPlan(args)): Promise<DaemonStartResult> {
	const current = await buildCoderLoopStatusSnapshot({
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		loopDataRoot: args.loopDataRoot ?? null,
		chainName: args.chainName ?? null,
		repository: args.repository,
		output: "json",
	})
	const live = findOwnedLiveProcess(current)
	if (live !== null) {
			return {
				action: "start",
				target: plan.targetCwd,
				alreadyRunning: true,
				pid: live.pid,
				source: live.source,
			}
		}

	await mkdir(dirname(plan.stdoutPath), { recursive: true })
	const stdoutFd = openSync(plan.stdoutPath, "a")
	const stderrFd = openSync(plan.stderrPath, "a")
	try {
		const child = spawn(plan.command[0]!, plan.command.slice(1), {
			cwd: plan.targetCwd,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		})
		child.unref()
		return {
			action: "start",
			target: plan.targetCwd,
			pid: child.pid ?? null,
			command: plan.command,
			stdoutPath: plan.stdoutPath,
			stderrPath: plan.stderrPath,
			requireBrowserEvidence: plan.requireBrowserEvidence,
		}
	} finally {
		closeSync(stdoutFd)
		closeSync(stderrFd)
	}
}

async function runDaemonStopCommand(args: Extract<DaemonCommandArgs, { action: "stop" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "stop",
			target: runtime.options.targetCwd,
			chain: runtime.chain.name,
			dryRun: true,
		}, args.json, formatDaemonStopResult)
		return
	}
	const result = await requestDaemonResult(args.loopDataRoot ?? null, "chain.delete", { chainName: runtime.chain.name })
	writeJsonOrText({
		action: "stop",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		result,
	}, args.json, formatDaemonStopResult)
}

async function runDaemonRestartCommand(args: Extract<DaemonCommandArgs, { action: "restart" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "restart",
			target: runtime.options.targetCwd,
			chain: runtime.chain.name,
			dryRun: true,
			centralDaemon: "required",
		}, args.json, formatDaemonRestartResult)
		return
	}
	const daemon = await requestDaemonResult(args.loopDataRoot ?? null, "daemon.status")
	writeJsonOrText({
		action: "restart",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		restarted: false,
		reason: "central daemon is global; target restart resolves the chain and verifies daemon availability",
		daemon: daemon.daemon ?? null,
	}, args.json, formatDaemonRestartResult)
}

function daemonCommandToTargetLookupArgs(args: Extract<DaemonCommandArgs, { action: "start" | "stop" | "restart" }>): TargetChainLookupArgs {
	return {
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		loopDataRoot: args.loopDataRoot ?? null,
		chainName: args.chainName ?? null,
		repository: args.repository,
		baseBranch: "baseBranch" in args ? args.baseBranch : null,
		requireBrowserEvidence: "requireBrowserEvidence" in args ? args.requireBrowserEvidence : null,
		once: false,
		dryRun: args.dryRun,
		checkRuntime: false,
		worktree: "worktree" in args ? args.worktree : false,
		maxIterations: "maxIterations" in args ? args.maxIterations : null,
		workflowPath: null,
		stateFile: null,
	}
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
	stateFile: string
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
	const options = await loadLoopOptionsForTarget(args.targetCwd, args.configPath, args.repository, {
		loopDataRoot: args.loopDataRoot,
		chainName: args.chainName,
	})
	assertQueueUnblockSupported(options.preset)
	const issue = normalizeQueueIssueId(args.issue)
	const dbSnapshot = await loadLoopStateFromDb(options)
	const state = dbSnapshot.state
	const mutation = requeueBlockedItem(state, options.preset, issue)
	if (!mutation.changed && mutation.reason === "not_found") {
		fail(`queue unblock: issue ${issue} not found in SQLite state DB`)
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
				loopDataRoot: options.loopDataRoot,
				chainName: options.chainName ?? null,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: true,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				json: false,
			}),
		}
	} else {
		await saveLoopStateToDb(options, dbSnapshot.chain, state)
		daemon = {
			requested: true,
			dryRun: false,
			result: await executeDaemonStart({
				action: "start",
				targetCwd: options.targetCwd,
				configPath: args.configPath,
				loopDataRoot: options.loopDataRoot,
				chainName: options.chainName ?? null,
				repository: options.repository,
				requireBrowserEvidence: args.requireBrowserEvidence,
				maxIterations: null,
				dryRun: false,
				worktree: options.worktree,
				baseBranch: options.baseBranch,
				json: false,
			}),
		}
	}

	if (mutation.changed && !args.dryRun && !args.startDaemon) {
		await saveLoopStateToDb(options, dbSnapshot.chain, state)
	}

	const verificationState = args.dryRun ? state : (await loadLoopStateFromDb(options)).state
	const item = findQueueItemById(verificationState, options.preset, issue)
	const daemonRunning = daemonResultIndicatesRunning(daemon)
	const result: QueueUnblockCommandResult = {
		action: "queue.unblock",
		target: options.targetCwd,
		repository: options.repository,
		stateFile: options.stateFile,
		issue,
		dryRun: args.dryRun,
		mutation,
		daemon,
		verification: {
			itemStatus: item?.status ?? null,
			blockerRepoPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRepo"),
			blockerRefPresent: item === null ? null : hasOwnJsonKey(item.extra, "blockerRef"),
			stateKind: "ok",
			daemonRunning,
		},
	}
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function daemonResultIndicatesRunning(daemon: QueueUnblockCommandResult["daemon"]): boolean {
	if (!daemon.requested) return false
	if (daemon.dryRun) return false
	if ("alreadyRunning" in daemon.result) return daemon.result.alreadyRunning === true
	return daemon.result.pid !== null
}

type TargetChainLookupArgs = {
	targetCwd: string
	configPath: string | null
	loopDataRoot: string | null
	chainName: string | null
	repository: string | null
	baseBranch: string | null
	requireBrowserEvidence: boolean | null
	once: boolean
	dryRun: boolean
	checkRuntime: boolean
	worktree: boolean
	maxIterations: number | null
	workflowPath: string | null
	stateFile: string | null
}

type LoadedTargetRuntime = {
	options: LoopOptions
	chain: ChainRecord
	state: LoopState
}

async function loadTargetRuntime(args: TargetChainLookupArgs): Promise<LoadedTargetRuntime> {
	const targetCwd = resolve(args.targetCwd)
	const discoveredConfig = await discoverLegacyConfigForTarget(targetCwd, args)
	const effectiveLoopDataRoot = args.loopDataRoot ?? discoveredConfig?.config.loopDataRoot ?? null
	const chain = await resolveDbChainForTarget({ ...args, loopDataRoot: effectiveLoopDataRoot })
	const explicitConfig = args.configPath === null ? discoveredConfig?.config ?? null : await loadConfig(resolveFrom(targetCwd, args.configPath))
	const config = loopConfigFromChain(chain, effectiveLoopDataRoot, explicitConfig)
	const presetDir = resolvePresetDir(config, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	const configPath = args.configPath === null ? resolveLoopDataPaths(loopDataRootOption(effectiveLoopDataRoot)).dbFile : resolveFrom(targetCwd, args.configPath)
	const options = buildOptions(targetCwd, configPath, {
		maxIterations: args.maxIterations,
		targetCwd,
		configPath: args.configPath,
		workflowPath: args.workflowPath,
		stateFile: args.stateFile,
		loopDataRoot: effectiveLoopDataRoot,
		chainName: chain.name,
		repository: args.repository,
		requireBrowserEvidence: args.requireBrowserEvidence,
		once: args.once,
		dryRun: args.dryRun,
		checkRuntime: args.checkRuntime,
		worktree: args.worktree,
		baseBranch: args.baseBranch,
	}, config, preset)
	const state = loopStateFromDbRecords(chain, readDbItemsForChain(effectiveLoopDataRoot, chain.id), readDbCurrentRun(effectiveLoopDataRoot, chain.id), preset)
	return { options, chain, state }
}

async function discoverLegacyConfigForTarget(targetCwd: string, args: TargetChainLookupArgs): Promise<{ path: string; config: LoopConfig } | null> {
	if (args.configPath !== null || args.loopDataRoot !== null) return null
	const path = await resolveConfigPath(targetCwd, null)
	const result = await readStatusConfig(path)
	if (result.kind !== "ok") return null
	if (result.value.loopDataRoot !== null) return { path, config: result.value }
	const legacyLoopDataRoot = resolve(targetCwd, ".coder-loop/runtime/loop-data")
	if (await exists(resolve(legacyLoopDataRoot, "db.sqlite"))) {
		return { path, config: { ...result.value, loopDataRoot: legacyLoopDataRoot } }
	}
	return { path, config: result.value }
}

async function loadLoopOptionsForTarget(
	targetCwdInput: string,
	configPathInput: string | null,
	repository: string | null,
	extra: Partial<TargetChainLookupArgs> = {},
): Promise<LoopOptions> {
	const loaded = await loadTargetRuntime({
		targetCwd: targetCwdInput,
		configPath: configPathInput,
		loopDataRoot: extra.loopDataRoot ?? null,
		chainName: extra.chainName ?? null,
		repository,
		baseBranch: extra.baseBranch ?? null,
		requireBrowserEvidence: extra.requireBrowserEvidence ?? null,
		once: extra.once ?? false,
		dryRun: extra.dryRun ?? false,
		checkRuntime: extra.checkRuntime ?? false,
		worktree: extra.worktree ?? false,
		maxIterations: extra.maxIterations ?? null,
		workflowPath: extra.workflowPath ?? null,
		stateFile: extra.stateFile ?? null,
	})
	return loaded.options
}

async function resolveDbChainForTarget(args: TargetChainLookupArgs): Promise<ChainRecord> {
	const loopDataRoot = args.loopDataRoot
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		const requestedRepo = args.repository ?? await inferRepositoryFromGit(args.targetCwd)
		const requestedBase = args.baseBranch
		if (args.chainName !== null) {
			const chain = store.getChainByName(args.chainName)
			if (chain === null) throw new CoderLoopError(`SQLite state DB has no chain named "${args.chainName}"`)
			if (chain.status !== "active") throw new CoderLoopError(`SQLite chain "${chain.name}" is ${chain.status}, expected active`)
			if (requestedRepo !== null && chain.repository !== requestedRepo) {
				throw new CoderLoopError(`SQLite chain "${chain.name}" repository is ${chain.repository}, expected ${requestedRepo}`)
			}
			if (requestedBase !== null && chain.baseBranch !== requestedBase) {
				throw new CoderLoopError(`SQLite chain "${chain.name}" base branch is ${chain.baseBranch}, expected ${requestedBase}`)
			}
			return chain
		}

		const targetCwd = resolve(args.targetCwd)
		const active = store.listChains().filter((chain) =>
			chain.status === "active"
			&& (requestedRepo === null || chain.repository === requestedRepo)
			&& (requestedBase === null || chain.baseBranch === requestedBase)
		)
		const matchingByRepoCwd = active.filter((chain) =>
			store.listItems(chain.id).some((item) => samePath(item.repoCwd, targetCwd)),
		)
		if (matchingByRepoCwd.length === 1) return matchingByRepoCwd[0]!
		if (matchingByRepoCwd.length > 1) {
			throw new CoderLoopError(`target ${targetCwd} matches multiple active chains by repo_cwd: ${matchingByRepoCwd.map((chain) => chain.name).join(", ")}; pass --chain <name>`)
		}
		if (active.length === 1) return active[0]!
		if (active.length === 0) {
			const repoLabel = requestedRepo === null ? "any repository" : `repository ${requestedRepo}`
			throw new CoderLoopError(`SQLite state DB has no active chain for ${repoLabel} and target ${targetCwd}`)
		}
		throw new CoderLoopError(`target ${targetCwd} is ambiguous across active chains: ${active.map((chain) => chain.name).join(", ")}; pass --chain <name>`)
	} finally {
		store.close()
	}
}

function readDbItemsForChain(loopDataRoot: string | null, chainId: number): ItemRecord[] {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.listItems(chainId)
	} finally {
		store.close()
	}
}

function readDbCurrentRun(loopDataRoot: string | null, chainId: number): CurrentRunRecord | null {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.getCurrentRun(chainId)
	} finally {
		store.close()
	}
}

function loopConfigFromChain(chain: ChainRecord, loopDataRoot: string | null, explicitConfig: LoopConfig | null): LoopConfig {
	const metadata = chain.metadata
	const presetPath = stringMetadata(metadata, "presetPath") ?? explicitConfig?.presetPath ?? null
	const config: LoopConfig = {
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		worktree: booleanMetadata(metadata, "worktree") ?? explicitConfig?.worktree ?? null,
		workflowFile: stringMetadata(metadata, "workflowFile") ?? explicitConfig?.workflowFile ?? null,
		sharedContextFile: stringMetadata(metadata, "sharedContextFile") ?? explicitConfig?.sharedContextFile ?? chainRuntimePathForConfig(chain.name, loopDataRoot, "shared"),
		stateFile: stringMetadata(metadata, "stateFile") ?? explicitConfig?.stateFile ?? resolveLoopDataPaths(loopDataRootOption(loopDataRoot)).dbFile,
		issueDir: stringMetadata(metadata, "issueDir") ?? explicitConfig?.issueDir ?? chainRuntimePathForConfig(chain.name, loopDataRoot, "issues"),
		evidenceDir: stringMetadata(metadata, "evidenceDir") ?? explicitConfig?.evidenceDir ?? chainRuntimePathForConfig(chain.name, loopDataRoot, "evidence"),
		logDir: stringMetadata(metadata, "logDir") ?? explicitConfig?.logDir ?? chainRuntimePathForConfig(chain.name, loopDataRoot, "runs"),
		loopDataRoot,
		requireAgentBrowserScreenshots: booleanMetadata(metadata, "requireAgentBrowserScreenshots") ?? explicitConfig?.requireAgentBrowserScreenshots ?? null,
		defaultRunner: runnerMetadata(metadata, "runner") ?? explicitConfig?.defaultRunner ?? null,
		reviewRunner: runnerMetadata(metadata, "reviewRunner") ?? explicitConfig?.reviewRunner ?? null,
		claudeBinary: nestedStringMetadata(metadata, "claude", "binary") ?? explicitConfig?.claudeBinary ?? null,
		claudeExtraArgs: nestedStringArrayMetadata(metadata, "claude", "extraArgs") ?? explicitConfig?.claudeExtraArgs ?? [],
		claudeModel: nestedStringMetadata(metadata, "claude", "model") ?? explicitConfig?.claudeModel ?? null,
		codexBinary: nestedStringMetadata(metadata, "codex", "binary") ?? explicitConfig?.codexBinary ?? null,
		codexExtraArgs: nestedStringArrayMetadata(metadata, "codex", "extraArgs") ?? explicitConfig?.codexExtraArgs ?? [],
		codexModel: nestedStringMetadata(metadata, "codex", "model") ?? explicitConfig?.codexModel ?? null,
		preset: presetPath === null ? chain.preset : null,
		presetPath,
	}
	return config
}

function chainRuntimePathForConfig(chainName: string, loopDataRoot: string | null, kind: "shared" | "issues" | "evidence" | "runs"): string {
	const paths = resolveChainRuntimePaths(chainName, loopDataRootOption(loopDataRoot))
	if (kind === "shared") return paths.sharedFile
	if (kind === "issues") return paths.issuesDir
	if (kind === "evidence") return paths.evidenceDir
	return paths.runsDir
}

function stringMetadata(metadata: JsonObject, key: string): string | null {
	const value = metadata[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

function booleanMetadata(metadata: JsonObject, key: string): boolean | null {
	const value = metadata[key]
	return typeof value === "boolean" ? value : null
}

function runnerMetadata(metadata: JsonObject, key: string): AgentRunnerKind | null {
	const value = metadata[key]
	return value === "claude" || value === "codex" ? value : null
}

function nestedStringMetadata(metadata: JsonObject, objectKey: string, key: string): string | null {
	const object = metadata[objectKey]
	if (!isObjectRecord(object)) return null
	const value = object[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

function nestedStringArrayMetadata(metadata: JsonObject, objectKey: string, key: string): string[] | null {
	const object = metadata[objectKey]
	if (!isObjectRecord(object)) return null
	const value = object[key]
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null
}

async function inferRepositoryFromGit(targetCwd: string): Promise<string | null> {
	const rootResult = Bun.spawnSync({
		cmd: ["git", "-C", resolve(targetCwd), "rev-parse", "--show-toplevel"],
		stdout: "pipe",
		stderr: "ignore",
	})
	if (rootResult.exitCode !== 0) return null
	const gitRoot = new TextDecoder().decode(rootResult.stdout).trim()
	if (!samePath(gitRoot, targetCwd)) return null
	const result = Bun.spawnSync({
		cmd: ["git", "-C", resolve(targetCwd), "remote", "get-url", "origin"],
		stdout: "pipe",
		stderr: "ignore",
	})
	if (result.exitCode !== 0) return null
	const url = new TextDecoder().decode(result.stdout).trim()
	const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
	if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`
	const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
	if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`
	return null
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
		const trigger = parsePresetPhaseTrigger(entry.trigger ?? null, `preset.phases[${index}].trigger`)
		phases.push({ name: entry.name, prompt: resolve(presetDir, entry.prompt), variables, trigger })
	}
	if (!phases.some((phase) => phase.trigger === null)) presetError("preset.phases: must include at least one non-trigger phase")

	const statuses = new Set<string>([...root.statuses.continuable, ...root.statuses.terminal])
	for (const [index, phase] of phases.entries()) {
		if (phase.trigger === null) continue
		if (isChainCompleteTrigger(phase.trigger)) continue
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

function parsePresetPhaseTrigger(value: typeof PresetPhaseTriggerBoundary.infer | null, label: string): PresetPhaseTrigger | null {
	if (value === null) return null
	const hasAfterPhase = value.afterPhase !== undefined
	const hasWhenStatus = value.whenStatus !== undefined
	const hasOn = value.on !== undefined
	if (hasOn) {
		if (value.on !== "chain-complete") presetError(`${label}.on: unsupported trigger event "${value.on}"`)
		if (hasAfterPhase || hasWhenStatus) presetError(`${label}: chain-complete trigger cannot also declare afterPhase/whenStatus`)
		return { on: "chain-complete" }
	}
	if (hasAfterPhase && hasWhenStatus) return { afterPhase: value.afterPhase!, whenStatus: value.whenStatus! }
	presetError(`${label}: trigger must declare either afterPhase + whenStatus or on = "chain-complete"`)
}

function isChainCompleteTrigger(trigger: PresetPhaseTrigger): trigger is { on: "chain-complete" } {
	return "on" in trigger
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
			fail(`Missing config file: ${path}`)
		}
		throw error
	})
	return parseConfigText(raw, path)
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
		loopDataRoot: input.loopDataRoot ?? null,
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

export function buildAgentRunnerCommands(config: LoopConfig): AgentRunnerCommands {
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

export function selectDefaultRunner(configuredRunner: AgentRunnerKind | null, commands: AgentRunnerCommands): AgentRunnerSelection {
	const kind = configuredRunner ?? DEFAULT_ITERATION_RUNNER
	return { ...commands[kind], source: configuredRunner === null ? "iteration-default" : "config" }
}

export function selectReviewRunner(configuredRunner: AgentRunnerKind | null, commands: AgentRunnerCommands): AgentRunnerSelection {
	const kind = configuredRunner ?? "claude"
	const command = commands[kind]
	const model = command.kind === "claude" ? CLAUDE_REVIEW_MODEL : command.model
	return { ...command, model, source: configuredRunner === null ? "review-default" : "config" }
}

export type PhaseRunnerSelectionInput = {
	preset: Preset
	defaultRunner: AgentRunnerSelection
	reviewRunner: AgentRunnerSelection
	runnerCommands: AgentRunnerCommands
}

function selectRunnerForItem(item: Pick<QueueItem, "runner">, input: Pick<PhaseRunnerSelectionInput, "defaultRunner" | "runnerCommands">): AgentRunnerSelection {
	if (item.runner === null) return input.defaultRunner
	return { ...input.runnerCommands[item.runner], source: "queue" }
}

export function selectRunnerForPhase(phase: string, item: Pick<QueueItem, "runner">, input: PhaseRunnerSelectionInput): AgentRunnerSelection {
	const reviewPhase = reviewPhaseForPreset(input.preset)
	if (phase === reviewPhase.name) return input.reviewRunner
	return selectRunnerForItem(item, input)
}

export type BuildPhaseRunnerSelectionFromChainInput = {
	chain: ChainRecord
	loopDataRoot: string | null
	preset: Preset
}

export function buildPhaseRunnerSelectionFromChain(input: BuildPhaseRunnerSelectionFromChainInput): PhaseRunnerSelectionInput {
	const config = loopConfigFromChain(input.chain, input.loopDataRoot, null)
	const runnerCommands = buildAgentRunnerCommands(config)
	const defaultRunner = selectDefaultRunner(config.defaultRunner, runnerCommands)
	const reviewRunner = selectReviewRunner(config.reviewRunner, runnerCommands)
	return { preset: input.preset, defaultRunner, reviewRunner, runnerCommands }
}

export type ResolvePhaseRunnerFromChainInput = BuildPhaseRunnerSelectionFromChainInput & {
	phase: string
	item: Pick<QueueItem, "runner">
}

export function resolvePhaseRunnerFromChain(input: ResolvePhaseRunnerFromChainInput): AgentRunnerSelection {
	const selection = buildPhaseRunnerSelectionFromChain(input)
	return selectRunnerForPhase(input.phase, input.item, selection)
}

export function reviewPhaseForPreset(preset: Preset): PresetPhase {
	for (let index = preset.phases.length - 1; index >= 0; index--) {
		const phase = preset.phases[index]!
		if (phase.trigger === null) return phase
	}
	fail("preset must define at least one non-trigger phase")
}

export function triggeredPhasesAfter(preset: Preset, afterPhase: string, status: string): readonly PresetPhase[] {
	return preset.phases.filter((phase) => phase.trigger !== null && !isChainCompleteTrigger(phase.trigger) && phase.trigger.afterPhase === afterPhase && phase.trigger.whenStatus === status)
}

export function chainCompleteTriggerPhases(preset: Preset): readonly PresetPhase[] {
	return preset.phases.filter((phase) => phase.trigger !== null && isChainCompleteTrigger(phase.trigger))
}

export type PresetChainCompleteDecision =
	| { decision: "complete"; reason?: string }
	| { decision: "keep-active"; reason?: string }

export type RunPresetChainCompleteTriggerPhasesPhaseRunner = (phase: string) => AgentRunnerSelection | Promise<AgentRunnerSelection>

export type RunPresetChainCompleteTriggerPhasesInput = {
	chain: ChainRecord
	items: readonly ItemRecord[]
	runId?: string
	terminalStatuses: readonly string[]
	loopDataRoot: string | null
	phaseRunner?: RunPresetChainCompleteTriggerPhasesPhaseRunner
	presetDir?: string
	targetCwd?: string | null
}

export async function runPresetChainCompleteTriggerPhases(input: RunPresetChainCompleteTriggerPhasesInput): Promise<PresetChainCompleteDecision | null> {
	const rawTargetCwd = input.targetCwd ?? input.items[0]?.repoCwd
	if (rawTargetCwd === undefined || rawTargetCwd.trim() === "") throw new Error(`chain ${input.chain.id} has no item repoCwd for chain-complete trigger`)
	const targetCwd = resolve(rawTargetCwd)
	const config = loopConfigFromChain(input.chain, input.loopDataRoot, null)
	const presetDir = input.presetDir ?? resolvePresetDir(config, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	const phases = chainCompleteTriggerPhases(preset)
	if (phases.length === 0) return null

	const configPath = resolveLoopDataPaths(loopDataRootOption(input.loopDataRoot)).dbFile
	const options = buildOptions(targetCwd, configPath, {
		maxIterations: null,
		targetCwd,
		configPath: null,
		workflowPath: null,
		stateFile: null,
		loopDataRoot: input.loopDataRoot,
		chainName: input.chain.name,
		repository: input.chain.repository,
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
		worktree: false,
		baseBranch: input.chain.baseBranch,
	}, config, preset)
	const anchorRecord = selectFinalizerAnchorItem(input.items, input.runId)
	const anchorItem = itemRecordToQueueItem(anchorRecord, preset)
	const anchorId = getItemId(anchorItem, preset)
	const currentIssueFile = resolveChainIssueFile(options, input.chain, anchorItem, anchorId, "Chain-complete trigger issue file")
	const evidenceDir = resolveChainEvidenceDir(options, input.chain, anchorItem, anchorId, "Chain-complete trigger evidence directory")
	const finalizerRunId = input.runId ?? makeRunId(`chain-${input.chain.id}`)

	const phaseSelection = buildPhaseRunnerSelectionFromChain({ chain: input.chain, loopDataRoot: input.loopDataRoot, preset })
	const resolvePhaseRunner = async (phase: string): Promise<AgentRunnerSelection> => {
		if (input.phaseRunner !== undefined) return await input.phaseRunner(phase)
		return selectRunnerForPhase(phase, anchorItem, phaseSelection)
	}

	for (const phase of phases) {
		const ctx: ResolveContext = {
			item: anchorItem,
			config: buildConfigBindings(options),
			runtime: buildRuntimeBindings({
				options,
				runId: finalizerRunId,
				currentIssueFile,
				evidenceDir,
				agentCwd: targetCwd,
				issueRun: { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null, resumedSessionId: null },
				issueKind: null,
				paths: buildCentralRuntimeBindingPaths({
					options,
					chain: input.chain,
					runId: finalizerRunId,
					currentIssueFile,
					evidenceDir,
				}),
			}),
		}
		const promptRaw = await readFile(phase.prompt, "utf-8")
		const prompt = renderPrompt(promptRaw, phase, ctx)
		const outputPath = agentOutputPath(options, finalizerRunId, phase.name)
		const resolvedRunner = await resolvePhaseRunner(phase.name)
		log(`Starting chain-complete trigger phase ${phase.name} for chain ${input.chain.name} (runner=${resolvedRunner.kind})...`)
		const { output, code } = await runAgent(options, phase.name, prompt, outputPath, targetCwd, resolvedRunner)
		log(`Chain-complete trigger phase ${phase.name} finished: exit=${code}, output=${outputPath} (${output.length} bytes)`)
		if (code !== 0) throw new Error(`chain-complete trigger phase ${phase.name} exited ${code}`)
		const decision = parseFinalizerSummaryDecision(output, resolvedRunner.kind)
		if (decision === null) throw new Error(`chain-complete trigger phase ${phase.name} did not print a valid FINALIZER SUMMARY`)
		if (decision.decision !== "complete") return decision
	}

	return { decision: "complete" }
}

function selectFinalizerAnchorItem(items: readonly ItemRecord[], runId: string | undefined): ItemRecord {
	const byRunId = runId === undefined ? undefined : items.find((item) => item.lastRunId === runId)
	const item = byRunId ?? items[0]
	if (item === undefined) throw new Error("chain-complete trigger requires at least one chain item")
	return item
}

function parseFinalizerSummaryDecision(output: string, runner: AgentRunnerKind): PresetChainCompleteDecision | null {
	let sawRunnerJson = false
	let decision: PresetChainCompleteDecision | null = null
	for (const line of output.split(/\r?\n/)) {
		const parsed = runnerAgentTextFromJsonLine(line, runner)
		sawRunnerJson = sawRunnerJson || parsed.parsedRunnerEvent
		if (parsed.text === null) continue
		decision = parseFinalizerSummaryDecisionFromText(parsed.text)
	}
	return sawRunnerJson ? decision : parseFinalizerSummaryDecisionFromText(output)
}

function parseFinalizerSummaryDecisionFromText(text: string): PresetChainCompleteDecision | null {
	const summaryLine = finalSummaryLine(text, "FINALIZER SUMMARY:")
	if (summaryLine === null) return null
	const match = summaryLine.match(/^FINALIZER SUMMARY:\s*decision=(complete|keep-active)\s*;(.*)$/)
	if (match === null) return null
	const tail = match[2] ?? ""
	const reasonMatch = tail.match(/(?:^|;)\s*reason=([^;]*)/)
	const reason = reasonMatch?.[1]?.trim()
	return reason === undefined || reason === ""
		? { decision: match[1] as "complete" | "keep-active" }
		: { decision: match[1] as "complete" | "keep-active", reason }
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
	await loadLoopStateFromDb(options)
	await mkdir(options.logDir, { recursive: true })
	await mkdir(dirname(options.logFile), { recursive: true })
}

async function assertRuntimeValid(options: LoopOptions, state?: LoopState, chain?: ChainRecord): Promise<void> {
	const snapshot = state === undefined || chain === undefined ? await loadLoopStateFromDb(options) : null
	const runtimeState = state ?? snapshot!.state
	const runtimeChain = chain ?? snapshot!.chain
	const errors = await checkRuntime(options, runtimeState, runtimeChain)
	if (errors.length === 0) return

	const details = errors.map((error) => `- ${error.path}: ${error.message}`).join("\n")
	fail(`Runtime validation failed:\n${details}`)
}

export async function checkRuntime(options: LoopOptions, state: LoopState, chain?: ChainRecord): Promise<RuntimeCheckError[]> {
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
	const runtimeRoot = resolve(options.targetCwd, ".coder-loop/runtime")
	checkInside(options.targetCwd, options.workflowPath, "workflow", errors)
	if (isWithin(runtimeRoot, options.workflowPath)) pushCheckError(errors, "workflow", "must be project policy outside .coder-loop/runtime")
	if (chain === undefined) {
		await checkFile(options.configPath, "config", errors)
		checkInside(options.targetCwd, options.configPath, "config", errors)
		checkInside(runtimeRoot, options.configPath, "config", errors)
		await checkFile(options.sharedContextPath, "shared context", errors)
		await checkDirectory(options.issueDir, "issueDir", errors)
		await checkDirectory(options.evidenceRootDir, "evidenceDir", errors)
		await checkDirectory(options.logDir, "logDir", errors)
		checkInside(options.targetCwd, options.sharedContextPath, "shared context", errors)
		checkInside(options.targetCwd, options.issueDir, "issueDir", errors)
		checkInside(options.targetCwd, options.evidenceRootDir, "evidenceDir", errors)
		checkInside(options.targetCwd, options.logDir, "logDir", errors)
		checkInside(runtimeRoot, options.sharedContextPath, "shared context", errors)
		checkInside(runtimeRoot, options.issueDir, "issueDir", errors)
		checkInside(runtimeRoot, options.evidenceRootDir, "evidenceDir", errors)
		checkInside(runtimeRoot, options.logDir, "logDir", errors)
	} else {
		if (chain.status !== "active") pushCheckError(errors, "chain.status", `must be active (got ${chain.status})`)
		checkCentralRuntimeLayout(options, chain, errors)
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
			if (chain === undefined) {
				const issueFile = resolveRuntimePath(options, item.issueFile, `${label}.issueFile`, options.issueDir, errors)
				if (issueFile) await checkFile(issueFile, `${label}.issueFile`, errors)
			} else {
				checkChainItemPath(options, chain, item.issueFile, `${label}.issueFile`, "issues", errors)
			}
		}
		if (item.evidenceDir !== null) {
			if (chain === undefined) {
				const evidenceDir = resolveRuntimePath(options, item.evidenceDir, `${label}.evidenceDir`, options.evidenceRootDir, errors)
				if (evidenceDir) await checkDirectory(evidenceDir, `${label}.evidenceDir`, errors)
			} else {
				checkChainItemPath(options, chain, item.evidenceDir, `${label}.evidenceDir`, "evidence", errors)
			}
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

async function loadLoopStateFromDb(options: LoopOptions): Promise<DbLoopStateSnapshot> {
	return await withDbLoopState(options, (ctx) => ({ chain: ctx.chain, state: ctx.state }))
}

async function withDbLoopState<T>(options: LoopOptions, fn: (ctx: DbLoopStateContext) => T | Promise<T>): Promise<T> {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(options.loopDataRoot) })
	try {
		const chain = selectDbChainForOptions(store, options)
		const state = loopStateFromDbRecords(chain, store.listItems(chain.id), store.getCurrentRun(chain.id), options.preset)
		return await fn({ store, chain, state })
	} finally {
		store.close()
	}
}

async function saveLoopStateToDb(options: LoopOptions, chain: ChainRecord, state: LoopState): Promise<void> {
	await withDbLoopState(options, ({ store }) => {
		persistLoopStateToDb(store, chain, state, options.preset)
	})
}

function loopDataRootOption(loopDataRoot: string | null): { loopDataRoot?: string } {
	return loopDataRoot === null ? {} : { loopDataRoot }
}

function selectDbChainForOptions(store: SqliteStateStore, options: LoopOptions): ChainRecord {
	if (options.chainName !== undefined && options.chainName !== null) {
		const chain = store.getChainByName(options.chainName)
		if (chain === null) fail(`SQLite state DB has no chain named "${options.chainName}"`)
		if (chain.status !== "active") fail(`SQLite chain "${chain.name}" is ${chain.status}, expected active`)
		return chain
	}
	const activeChains = store.listChains().filter((chain) =>
		chain.status === "active"
		&& (options.repository === null || chain.repository === options.repository)
		&& chain.preset === options.preset.name
		&& (options.baseBranch === null || chain.baseBranch === options.baseBranch)
	)
	const matchingByRepoCwd = activeChains.filter((chain) =>
		store.listItems(chain.id).some((item) => samePath(item.repoCwd, options.targetCwd)),
	)
	const candidates = matchingByRepoCwd.length > 0 ? matchingByRepoCwd : activeChains
	if (candidates.length === 1) return candidates[0]!
	const dbFile = resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile
	if (candidates.length === 0) {
		const repoLabel = options.repository === null ? "any repo" : `repo ${options.repository}`
		fail(`SQLite state DB has no active chain for ${repoLabel} at ${dbFile}`)
	}
	const repoLabel = options.repository === null ? "this target" : `repo ${options.repository}`
	fail(`SQLite state DB has multiple active chains for ${repoLabel}; select one by repo_cwd or complete/delete stale chains`)
}

function loopStateFromDbRecords(
	chain: ChainRecord,
	items: ItemRecord[],
	current: CurrentRunRecord | null,
	preset: Preset,
): LoopState {
	return {
		version: 1,
		queue: items.map((item) => itemRecordToQueueItem(item, preset)),
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		recentRuns: jsonArray(chain.metadata.recentRuns),
		current: currentRecordToCurrentRun(current, items, preset),
	}
}

function itemRecordToQueueItem(item: ItemRecord, preset: Preset): QueueItem {
	const extra = { ...item.extra }
	if (extra[preset.item.idField] === undefined) extra[preset.item.idField] = item.issueNumber
	return {
		status: item.status,
		attempts: item.attempts,
		title: item.title,
		priority: item.priority,
		branch: item.branch,
		pr: item.pr,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile,
		evidenceDir: item.evidenceDir,
		agentCwd: item.agentCwd,
		runner: item.runner,
		extra,
	}
}

function currentRecordToCurrentRun(
	current: CurrentRunRecord | null,
	items: ItemRecord[],
	preset: Preset,
): CurrentRun | null {
	if (current === null) return null
	const extra = { ...current.extra }
	const currentItem = items.find((item) => item.id === extra.itemId) ?? items.find((item) => item.lastRunId === current.runId)
	if (currentItem !== undefined && extra[preset.item.idField] === undefined) extra[preset.item.idField] = currentItem.issueNumber
	return {
		phase: current.phase,
		runId: current.runId,
		startedAt: new Date(current.startedAt * 1000).toISOString(),
		extra,
	}
}

function persistLoopStateToDb(store: SqliteStateStore, chain: ChainRecord, state: LoopState, preset: Preset): void {
	const itemsByIssue = new Map(store.listItems(chain.id).map((item) => [getItemId(itemRecordToQueueItem(item, preset), preset), item]))
	for (const item of state.queue) {
		const issue = getItemId(item, preset)
		const record = itemsByIssue.get(issue)
		if (record === undefined) fail(`SQLite state DB item ${issue} was not found in chain ${chain.name}`)
		store.updateItem(record.id, {
			status: item.status,
			attempts: item.attempts ?? 0,
			title: item.title,
			priority: item.priority,
			branch: item.branch,
			pr: item.pr,
			lastRunId: item.lastRunId,
			issueFile: item.issueFile,
			evidenceDir: item.evidenceDir,
			agentCwd: item.agentCwd,
			runner: item.runner,
			extra: item.extra,
			updatedAt: unixSeconds(),
		})
	}

	if (Array.isArray(state.recentRuns)) {
		store.updateChain(chain.id, {
			metadata: { ...chain.metadata, recentRuns: state.recentRuns },
			updatedAt: unixSeconds(),
		})
	}

	if (state.current === null) {
		store.clearCurrentRun(chain.id)
		return
	}
	const currentIssue = getCurrentId(state.current, preset)
	const currentItem = itemsByIssue.get(currentIssue)
	if (currentItem === undefined) fail(`SQLite state DB current item ${currentIssue} was not found in chain ${chain.name}`)
	const startedAt = unixSecondsFromIso(state.current.startedAt)
	if (store.getRunByRunId(state.current.runId) === null) {
		store.recordRun({
			runId: state.current.runId,
			chainId: chain.id,
			itemId: currentItem.id,
			phase: state.current.phase,
			startedAt,
			extra: state.current.extra,
		})
	}
	store.setCurrentRun({
		chainId: chain.id,
		phase: state.current.phase,
		runId: state.current.runId,
		startedAt,
		extra: state.current.extra,
	})
}

function jsonArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value.filter((entry): entry is JsonValue => isJsonValue(entry)) : []
}

function unixSecondsFromIso(value: string): number {
	const time = Date.parse(value)
	if (!Number.isFinite(time)) fail(`invalid ISO timestamp for DB current_runs.started_at: ${value}`)
	return time / 1000
}

function unixSeconds(): number {
	return Date.now() / 1000
}

function samePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right)
}

function resolveChainIssueFile(options: LoopOptions, chain: ChainRecord, item: QueueItem, itemId: string, label: string): string {
	const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
	if (item.issueFile === null) return chainPaths.issueFile(itemId)
	return resolveChainScopedPath(chainPaths.chainRoot, chainPaths.issuesDir, item.issueFile, label)
}

function resolveChainEvidenceDir(options: LoopOptions, chain: ChainRecord, item: QueueItem, itemId: string, label: string): string {
	const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
	if (item.evidenceDir === null) return chainPaths.issueEvidenceDir(itemId)
	return resolveChainScopedPath(chainPaths.chainRoot, chainPaths.evidenceDir, item.evidenceDir, label)
}

function resolveLegacyIssueFile(options: LoopOptions, item: QueueItem): string | null {
	const issueFile = item.issueFile === null ? null : resolveFrom(options.targetCwd, item.issueFile)
	if (issueFile !== null && !isWithin(options.issueDir, issueFile)) fail(`Selected issue file must resolve inside issueDir: ${item.issueFile}`)
	return issueFile
}

function resolveLegacyEvidenceDir(options: LoopOptions, item: QueueItem): string | null {
	const evidenceDir = item.evidenceDir === null ? null : resolveFrom(options.targetCwd, item.evidenceDir)
	if (evidenceDir !== null && !isWithin(options.evidenceRootDir, evidenceDir)) fail(`Selected evidence directory must resolve inside evidenceDir: ${item.evidenceDir}`)
	return evidenceDir
}

function resolveChainScopedPath(chainRoot: string, expectedRoot: string, path: string, label: string): string {
	if (path.trim() === "") fail(`${label} must not be empty`)
	if (isAbsolute(path)) fail(`${label} must be relative to the chain root, got absolute path: ${path}`)
	const resolved = resolve(chainRoot, path)
	if (!isWithin(expectedRoot, resolved)) fail(`${label} must resolve inside ${expectedRoot}: ${path}`)
	return resolved
}

export function selectIssue(state: LoopState, options: LoopOptions, chain?: ChainRecord): SelectedIssue | null {
	const preset = options.preset
	const continuable = preset.statuses.continuable
	const currentItem = state.current
		? state.queue.find((item) => getItemId(item, preset) === getCurrentId(state.current!, preset))
		: undefined
	const selected = currentItem && continuable.includes(currentItem.status)
		? currentItem
		: state.queue.find((item) => continuable.includes(item.status))
	if (!selected) return null

	const selectedId = getItemId(selected, preset)
	const issueFile = chain === undefined ? resolveLegacyIssueFile(options, selected) : resolveChainIssueFile(options, chain, selected, selectedId, "Selected issue file")
	const evidenceDir = chain === undefined ? resolveLegacyEvidenceDir(options, selected) : resolveChainEvidenceDir(options, chain, selected, selectedId, "Selected evidence directory")

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
			resumedSessionId: null,
		}
	}

	return {
		runIdGeneration: "new",
		resumedFromPhase: null,
		resumedStartedAt: null,
		resumedSessionId: null,
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

export function buildCentralRuntimeBindingPaths(input: {
	options: LoopOptions
	chain: Pick<ChainRecord, "name">
	runId: string
	currentIssueFile: string | null
	evidenceDir: string | null
}): RuntimeBindingPaths {
	const rootOptions = loopDataRootOption(input.options.loopDataRoot)
	const chainPaths = resolveChainRuntimePaths(input.chain.name, rootOptions)
	return {
		sharedContextPath: chainPaths.sharedFile,
		currentIssueFile: input.currentIssueFile ?? "",
		issueDir: chainPaths.issuesDir,
		evidenceDir: input.evidenceDir ?? chainPaths.evidenceDir,
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
	}
}

export type ChainRuntimeBinding = {
	name: string
	umbrellaRepo: string | null
	umbrellaIssue: number | null
	baseBranch: string
}

export function buildRuntimeBindings(input: {
	options: LoopOptions
	runId: string
	currentIssueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	issueRun: IssueRunContext
	issueKind: IssueKind
	paths?: RuntimeBindingPaths
	chain?: ChainRuntimeBinding
	repoCwd?: string
}): RuntimeBindings {
	const paths = input.paths ?? {
		sharedContextPath: input.options.sharedContextPath,
		currentIssueFile: input.currentIssueFile ?? "",
		issueDir: input.options.issueDir,
		evidenceDir: input.evidenceDir ?? input.options.evidenceRootDir,
		evidenceRootDir: input.options.evidenceRootDir,
		logDir: input.options.logDir,
	}
	return {
		runId: input.runId,
		targetCwd: input.options.targetCwd,
		agentCwd: input.agentCwd,
		workflowPath: input.options.workflowPath,
		sharedContextPath: paths.sharedContextPath,
		currentIssueFile: paths.currentIssueFile,
		issueDir: paths.issueDir,
		evidenceDir: paths.evidenceDir,
		evidenceRootDir: paths.evidenceRootDir,
		logDir: paths.logDir,
		presetDir: input.options.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.options.preset),
		runIdGeneration: input.issueRun.runIdGeneration,
		resumedFromPhase: input.issueRun.resumedFromPhase ?? "",
		resumedStartedAt: input.issueRun.resumedStartedAt ?? "",
		resumedSessionId: input.issueRun.resumedSessionId ?? "",
		issueKind: input.issueKind ?? "",
		chainName: input.chain?.name ?? "",
		chainUmbrellaRepo: input.chain?.umbrellaRepo ?? "",
		chainUmbrellaIssue: input.chain?.umbrellaIssue !== undefined && input.chain.umbrellaIssue !== null ? String(input.chain.umbrellaIssue) : "",
		chainBaseBranch: input.chain?.baseBranch ?? "",
		repoCwd: input.repoCwd ?? "",
	}
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

function parseIssueKindFromExtra(extra: JsonObject): ParsedIssueKind {
	const raw = extra.issueKind ?? extra.kind
	if (raw === null || raw === undefined || raw === "") return { ok: true, kind: null }
	if (typeof raw !== "string") return { ok: false, error: `queue item issue kind must be a string when repository is not configured` }
	const label = raw.startsWith("kind:") ? raw : `kind:${raw}`
	return parseKindFromLabels([label])
}

export async function resolveIssueKind(repository: string | null, issueId: string, extra: JsonObject): Promise<ParsedIssueKind> {
	const itemKind = parseIssueKindFromExtra(extra)
	if (!itemKind.ok || itemKind.kind !== null) return itemKind
	if (repository !== null && /^\d+$/.test(issueId)) return fetchIssueKind(repository, issueId)
	return itemKind
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

export type ConfigBindingsInput = Pick<LoopOptions, "repository" | "baseBranch" | "requireBrowserEvidence">

export function buildConfigBindings(options: ConfigBindingsInput): ConfigBindings {
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
): Promise<{ output: string; code: number }> {
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

	log(`Agent [${label}] finished after ${result.attempts} attempt(s); code=${result.code}`)
	return { output: result.output, code: result.code }
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

function hasIterationSummaryLineInText(text: string): boolean {
	return finalSummaryLine(text, SUMMARY_WATCHDOG_MARKER) !== null
}

export function hasIterationSummaryMarker(output: string, runner: AgentRunnerKind = "claude"): boolean {
	let sawRunnerJson = false
	let lastTextHadMarker = false
	for (const line of output.split(/\r?\n/)) {
		const parsed = runnerAgentTextFromJsonLine(line, runner)
		sawRunnerJson = sawRunnerJson || parsed.parsedRunnerEvent
		if (parsed.text === null) continue
		lastTextHadMarker = hasIterationSummaryLineInText(parsed.text)
	}
	return sawRunnerJson ? lastTextHadMarker : hasIterationSummaryLineInText(output)
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
		if (!Number.isFinite(deps.config.termMs) || deps.config.termMs <= 0) return
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
		const streamOutFile = createWriteStream(attemptStreamPath, { flags: "w" })
		const stderrOutFile = createWriteStream(attemptStderrPath, { flags: "w" })
		const runnerPlan = buildRunnerInvocation(selectedRunner, effectivePrompt, resume, {
			agentCwd: input.agentCwd,
			targetCwd: options.targetCwd,
			presetDir: options.preset.presetDir,
			loopDataRoot: resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).root,
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

function realpathForComparison(path: string): string {
	try { return realpathSync(path) } catch { return path }
}

function gitWorktreeListIncludesPath(stdout: string, expectedPath: string): boolean {
	const expectedRealPath = realpathForComparison(expectedPath)
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.some((listedPath) => listedPath === expectedPath || realpathForComparison(listedPath) === expectedRealPath)
}

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
		if (check.exitCode === 0 && gitWorktreeListIncludesPath(check.stdout, wtPath)) return wtPath
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
	const additionalDirs = runnerAdditionalDirs(paths)
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

export function runnerAdditionalDirs(paths: RunnerInvocationPaths): string[] {
	return distinctPaths([paths.presetDir, paths.loopDataRoot, paths.agentCwd])
}

function distinctPaths(paths: readonly string[]): string[] {
	const result: string[] = []
	for (const path of paths) {
		if (!result.some((existing) => samePath(existing, path))) result.push(path)
	}
	return result
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

function agentOutputPath(options: LoopOptions, runId: string, label: AgentLabel): string {
	return resolve(options.logDir, runId, label, "stdout.jsonl")
}

function agentStatusPath(outputPath: string): string {
	return resolve(dirname(outputPath), "status.json")
}

export function agentSessionsPath(outputPath: string): string {
	return resolve(dirname(outputPath), "sessions.jsonl")
}

function agentAttemptStderrPath(outputPath: string, startedAt: string): string {
	void startedAt
	return resolve(dirname(outputPath), "stderr.txt")
}

function agentAttemptStreamPath(outputPath: string, startedAt: string): string {
	void startedAt
	return outputPath
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
	return { kind: "error", code: extractErrorCode(input.stdoutText, input.stderrText) }
}

export function isTransient5xx(code: string): boolean {
	const lower = code.toLowerCase()
	if (/(^|[^\d])5\d\d($|[^\d])/.test(lower)) return true
	if (lower.includes("overloaded")) return true
	if (lower.includes("rate_limit") || lower.includes("rate-limit") || lower.includes("ratelimit")) return true
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
}

export type RunWithBackoffDeps = {
	spawnAttempt: (params: { resume: ResumeDecision }) => Promise<AttemptOutcome>
	sleep: (seconds: number) => Promise<void>
	log: (message: string) => void
	now: () => number
	initialResume: ResumeDecision
}

export async function runAgentWithBackoff(deps: RunWithBackoffDeps): Promise<{ output: string; code: number; attempts: number }> {
	let resume = deps.initialResume
	let retryIndex = 0
	let elapsedBackoffSeconds = 0
	let attempts = 0
	while (true) {
		attempts++
		const outcome = await deps.spawnAttempt({ resume })
		if (outcome.terminated.kind === "watchdog") {
			deps.log(`post-summary watchdog terminated attempt (phase=${outcome.terminated.phase}); treating as success because the phase printed its mandatory summary`)
			return { output: outcome.output, code: 0, attempts }
		}
		if (outcome.terminated.kind === "error" && isTransient5xx(outcome.terminated.code)) {
			if (outcome.sessionId === null) {
				deps.log(`backoff abort: transient-5xx without sessionId; returning to outer loop`)
				return { output: outcome.output, code: outcome.exitCode, attempts }
			}
			const sleepSeconds = nextBackoffSeconds(retryIndex)
			if (elapsedBackoffSeconds + sleepSeconds > BACKOFF_BUDGET_SECONDS) {
				deps.log(`backoff budget exhausted: elapsed=${elapsedBackoffSeconds}s, next=${sleepSeconds}s, budget=${BACKOFF_BUDGET_SECONDS}s; returning to outer loop`)
				return { output: outcome.output, code: outcome.exitCode, attempts }
			}
			deps.log(`transient-5xx detected (code=${outcome.terminated.code}); sleeping ${sleepSeconds}s before resume #${retryIndex + 1}`)
			await deps.sleep(sleepSeconds)
			elapsedBackoffSeconds += sleepSeconds
			retryIndex++
			resume = { kind: "resume", sessionId: outcome.sessionId }
			continue
		}
		return { output: outcome.output, code: outcome.exitCode, attempts }
	}
}

function resolveFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path)
}

function checkCentralRuntimeLayout(options: LoopOptions, chain: ChainRecord, errors: RuntimeCheckError[]): void {
	try {
		const rootOptions = loopDataRootOption(options.loopDataRoot)
		const loopData = resolveLoopDataPaths(rootOptions)
		const chainPaths = resolveChainRuntimePaths(chain.name, rootOptions)
		checkInside(loopData.root, chainPaths.sharedFile, "shared context", errors)
		checkInside(loopData.root, chainPaths.issuesDir, "issueDir", errors)
		checkInside(loopData.root, chainPaths.evidenceDir, "evidenceDir", errors)
		checkInside(loopData.root, chainPaths.runsDir, "logDir", errors)
	} catch (error) {
		pushCheckError(errors, "loopDataRoot", errorMessage(error))
	}
}

function checkChainItemPath(
	options: LoopOptions,
	chain: ChainRecord,
	path: string,
	label: string,
	kind: "issues" | "evidence",
	errors: RuntimeCheckError[],
): void {
	try {
		const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
		const root = kind === "issues" ? chainPaths.issuesDir : chainPaths.evidenceDir
		resolveChainScopedPath(chainPaths.chainRoot, root, path, label)
	} catch (error) {
		pushCheckError(errors, label, errorMessage(error))
	}
}

function resolveRuntimePath(options: LoopOptions, path: string, label: string, root: string, errors: RuntimeCheckError[]): string | null {
	if (path.trim() === "") {
		pushCheckError(errors, label, "must not be empty")
		return null
	}
	const resolved = resolveFrom(options.targetCwd, path)
	checkInside(options.targetCwd, resolved, label, errors)
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

export function reviewOnEmptyLockPath(stateFile: string): string {
	return resolve(dirname(stateFile), REVIEW_ON_EMPTY_LOCK_FILE)
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
