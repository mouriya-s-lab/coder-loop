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
import { closeSync, createWriteStream, openSync, type WriteStream } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { command, flag, option, optional, positional, run as runCmd, string as cmdString, subcommands } from "cmd-ts"
import { type as arkType } from "arktype"
import { dispatchSubcommand } from "./install-commands"

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
const DEFAULT_LOG_DIR = ".coder-loop/runtime/logs"
const REVIEW_ON_EMPTY_LOCK_FILE = "review-on-empty.lock"
const DEFAULT_IDLE_SLEEP_MS = 60_000
const DEFAULT_ITERATION_RUNNER: AgentRunnerKind = "codex"
export const CLAUDE_REVIEW_MODEL = "claude-opus-4-7"

const EXCLUDE_ENTRIES = [".dev-loop", ".dev-trace.txt", ".coder-loop/runtime"]

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

type RawArgs = {
	maxIterations: number | null
	targetCwd: string | null
	configPath: string | null
	workflowPath: string | null
	statePath: string | null
	repository: string | null
	requireBrowserEvidence: boolean | null
	once: boolean
	dryRun: boolean
	checkRuntime: boolean
}

export type StatusCommandArgs = {
	targetCwd: string
	configPath: string | null
	repository: string | null
	output: "json"
}

export type DaemonCommandArgs =
	| {
			action: "status"
			targetCwd: string
			configPath: string | null
			repository: string | null
			output: "json"
		}
	| {
			action: "start"
			targetCwd: string
			configPath: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
		}
	| {
			action: "stop"
			targetCwd: string
			configPath: string | null
			repository: string | null
			dryRun: boolean
		}
	| {
			action: "restart"
			targetCwd: string
			configPath: string | null
			repository: string | null
			requireBrowserEvidence: boolean
			maxIterations: number | null
			dryRun: boolean
		}

type LoopConfig = {
	repository: string | null
	baseBranch: string | null
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

const TerminatedBoundary = arkType.or(
	{ kind: arkType.unit("clean") },
	{ kind: arkType.unit("signal"), name: "string" },
	{ kind: arkType.unit("error"), code: "string" },
	{ kind: arkType.unit("watchdog"), phase: arkType.or(arkType.unit("term"), arkType.unit("kill")), afterSummarySeconds: "number" },
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

const PresetPhaseBoundary = arkType({
	name: "string",
	prompt: "string",
	"variables?": "object",
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
	agent: { binary: "string", "extraArgs?": "string[]" },
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
	repository: string | null
	baseBranch: string | null
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
	}
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
	| { kind: "error"; code: string }
	| { kind: "watchdog"; phase: "term" | "kill"; afterSummarySeconds: number }

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
	| (LoopEventBase & { type: "queue.terminal"; terminalStatus: string })

export type LoopEventType = LoopEvent["type"]

export const LOOP_EVENT_TYPES = [
	"queue.select",
	"phase.start",
	"phase.end",
	"attempt.start",
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

export function loopEventsPath(targetCwd: string, runId: string): string {
	return resolve(targetCwd, ".coder-loop/runtime/events", `${runId}.jsonl`)
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
	targetCwd: string,
	runId: string,
	logFn: (message: string) => void,
): LoopEventEmit {
	const path = loopEventsPath(targetCwd, runId)
	return (event) => appendLoopEvent(path, event, logFn)
}

export const RESUME_CONTINUE_PROMPT = "继续"
export const BACKOFF_BUDGET_SECONDS = 7200
const BACKOFF_INITIAL_SECONDS = 4
const BACKOFF_MAX_INTERVAL_SECONDS = 600

export const SUMMARY_WATCHDOG_MARKER = "ITERATION SUMMARY:"
export const REVIEW_SUMMARY_WATCHDOG_MARKER = "REVIEW SUMMARY:"
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

export type IssueKind = "code" | "comment" | "code-spike" | null

const RUNTIME_BINDING_KEYS = [
	"runId",
	"targetCwd",
	"agentCwd",
	"workflowPath",
	"sharedContextPath",
	"statePath",
	"currentIssueFile",
	"issueDir",
	"evidenceDir",
	"evidenceRootDir",
	"logDir",
	"traceFile",
	"loopFile",
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
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
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
			default:
				fail(`Unknown argument: ${arg}`)
		}
	}

	return raw
}

type CliCommand =
	| { kind: "status"; args: StatusCommandArgs }
	| { kind: "daemon"; args: DaemonCommandArgs }

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
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "stop",
			targetCwd: args.target,
			configPath: args.config ?? null,
			repository: args.repo ?? null,
			dryRun: args.dryRun,
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

async function runStatusCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(statusCliCommand, args)
	if (parsed.kind !== "status") return
	const snapshot = await buildCoderLoopStatusSnapshot(parsed.args)
	StatusSnapshotBoundary.assert(snapshot)
	process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
}

async function runDaemonCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(daemonCliCommand, args)
	if (parsed.value.kind !== "daemon") return
	const daemonArgs = parsed.value.args
	if (daemonArgs.action === "status") {
		const snapshot = await buildCoderLoopStatusSnapshot({
			targetCwd: daemonArgs.targetCwd,
			configPath: daemonArgs.configPath,
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
		const state = await loadState(options.statePath)
		const selected = selectIssue(state, options)
		const errors = await checkRuntime(options, state)
		if (errors.length > 0) {
			console.error(`Runtime check failed: ${errors.length} error(s)`)
			for (const error of errors) console.error(`- ${error.path}: ${error.message}`)
			process.exit(1)
		}
		console.error(`Runtime check passed: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Runtime check passed: repo=${options.repository}`)
		console.error(`Runtime check passed: config=${options.configPath} (${configFormatForPath(options.configPath)})`)
		console.error(`Runtime check passed: state=${options.statePath}`)
		console.error(`Runtime check passed: queue=${state.queue.length}, selected=${selected ? getItemId(selected.item, options.preset) : "none"}`)
		console.error(`Runtime check passed: preset=${options.preset.name}`)
		return
	}

	await ensureRuntime(options)
	await assertRuntimeValid(options)

	if (options.dryRun) {
		const state = await loadState(options.statePath)
		const selected = selectIssue(state, options)
		console.error(`Dry run: target=${options.targetCwd}`)
		if (options.repository !== null) console.error(`Dry run: repo=${options.repository}`)
		console.error(`Dry run: workflow=${options.workflowPath}`)
		console.error(`Dry run: state=${options.statePath}`)
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

	logStream = createWriteStream(options.logFile, { flags: "a" })
	log(`=== coder-loop started (pid=${process.pid}, cwd=${options.targetCwd}) ===`)
	log(`Config: maxIterations=${formatMaxIterations(options.maxIterations)}`)
	log(`Repo=${options.repository}`)
	log(`Preset dir: ${options.preset.presetDir}`)
	log(`Default runner: ${options.defaultRunner.kind} (${options.defaultRunner.source}, binary=${options.defaultRunner.binary}, model=${options.defaultRunner.model ?? "<default>"})`)
	for (const phase of options.preset.phases) log(`Phase ${phase.name} prompt: ${phase.prompt}`)
	log(`Workflow=${options.workflowPath}`)
	log(`State=${options.statePath}`)

	await ensureGitExclude(options.targetCwd)
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
	log("Loop file created. Delete .dev-loop to stop.")

	let workIteration = 0
	const idleSleepMs = resolveIdleSleepMs()
	const lockPath = reviewOnEmptyLockPath(options.statePath)
	log(`Idle sleep: ${idleSleepMs}ms (override via CODER_LOOP_IDLE_SLEEP_MS)`)
	log(`Review-on-empty lock: ${lockPath}`)

	while ((await exists(options.loopFile)) && workIteration < options.maxIterations) {
		const state = await loadState(options.statePath)
		await assertRuntimeValid(options, state)
		const selected = selectIssue(state, options)

		if (!selected) {
			if (!(await exists(lockPath))) {
				await writeFile(options.traceFile, "No actionable issue found in .coder-loop/runtime/state.json. Review must assess whether to stop.\n")
				log("Empty queue: running review-on-empty for global state assessment.")
				const fallbackItem = makeFallbackItem()
				const fallbackRunId = makeRunId(null)
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
		const reviewPhase = phases[phases.length - 1]
		if (!iterPhase || !reviewPhase) fail("preset must define at least one phase")
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

		const emit = makeLoopEventEmitter(options.targetCwd, runId, log)
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
			await writeFile(options.traceFile, iterTrace)

			log(`${iterPhase.name} agent finished: issue=#${selectedId}, exit=${iterCode}, duration=${iterDurationSeconds.toFixed(0)}s, trace=${options.traceFile}, output=${iterOutputPath} (${iterTrace.length} bytes)`)
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

		const stateAfterReview = await loadState(options.statePath)
		const itemAfterReview = stateAfterReview.queue.find((q) => getItemId(q, options.preset) === selectedId)
		if (itemAfterReview && options.preset.statuses.terminal.includes(itemAfterReview.status)) {
			await emit({
				type: "queue.terminal",
				ts: new Date().toISOString(),
				runId,
				issueId: selectedId,
				pr: itemAfterReview.pr,
				branch: itemAfterReview.branch,
				terminalStatus: itemAfterReview.status,
			})
		}

		log(`Iteration ${workIteration} (work) complete.`)
	}

	if (workIteration >= options.maxIterations) {
		log(`Reached ${formatMaxIterations(options.maxIterations)} work iterations.`)
	}

	log("=== Loop ended. ===")
	logStream?.end()
}

async function runReview(
	options: LoopOptions,
	runId: string,
	ctx: ResolveContext,
	agentCwd: string,
	runner: AgentRunnerSelection,
	eventContext?: Omit<LoopEventContext, "phase">,
): Promise<number> {
	const phases = options.preset.phases
	const reviewPhase = phases[phases.length - 1]
	if (!reviewPhase) fail("preset must define at least one phase")
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
	return reviewCode
}

function buildOptions(targetCwd: string, configPath: string, raw: RawArgs, config: LoopConfig, preset: Preset): LoopOptions {
	const workflowPath = resolveFrom(targetCwd, raw.workflowPath ?? config.workflowFile ?? DEFAULT_WORKFLOW_FILE)
	const sharedContextPath = resolveFrom(targetCwd, config.sharedContextFile ?? DEFAULT_SHARED_FILE)
	const statePath = resolveFrom(targetCwd, raw.statePath ?? config.stateFile ?? DEFAULT_STATE_FILE)
	const issueDir = resolveFrom(targetCwd, config.issueDir ?? DEFAULT_ISSUE_DIR)
	const evidenceRootDir = resolveFrom(targetCwd, config.evidenceDir ?? DEFAULT_EVIDENCE_DIR)
	const logDir = resolveFrom(targetCwd, config.logDir ?? DEFAULT_LOG_DIR)
	const repository = raw.repository ?? config.repository
	const maxIterations = raw.once ? 1 : (raw.maxIterations ?? Number.POSITIVE_INFINITY)
	const requireBrowserEvidence = raw.requireBrowserEvidence ?? config.requireAgentBrowserScreenshots ?? false
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
		loopFile: resolve(targetCwd, ".dev-loop"),
		traceFile: resolve(targetCwd, ".dev-trace.txt"),
		logFile: resolve(logDir, `coder-loop-${process.pid}.${timestamp}.log`),
		repository,
		baseBranch: config.baseBranch,
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
	if (configResult.kind !== "ok") {
		const stateKind: StatusStateKind = configResult.kind === "missing" ? "missing-config" : "invalid-config"
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: configResult.kind, error: configResult.message }),
			stateKind,
			statePath: baseTarget.statePath,
			errorPath: "config",
			errorMessage: configResult.message,
		})
	}

	const presetResult = await readStatusPreset(configResult.value, targetCwd)
	if (presetResult.kind !== "ok") {
		const stateKind: StatusStateKind = presetResult.kind === "missing" ? "missing-preset" : "invalid-preset"
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, configPath, args.repository, null, { kind: "loaded", error: null }),
			stateKind,
			statePath: baseTarget.statePath,
			errorPath: "preset",
			errorMessage: presetResult.message,
		})
	}

	const raw = makeStatusRawArgs(args)
	const options = buildOptions(targetCwd, configPath, raw, configResult.value, presetResult.value)
	const target = makeStatusTargetSnapshot(targetCwd, configPath, args.repository, options, { kind: "loaded", error: null })
	const stateResult = await readStatusState(options.statePath)
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
	const runtimeErrors = await checkRuntime(options, stateResult.value)
	const currentSnapshot = await buildStatusCurrentSnapshot(options, stateResult.value)
	const events = await buildStatusEventsSnapshot(options, stateResult.value, selected)
	const processes = await buildStatusProcessSnapshot(options)
	const snapshot: CoderLoopStatusSnapshot = {
		target,
		state: {
			kind: runtimeErrors.length === 0 ? "ok" : "invalid-runtime",
			ok: runtimeErrors.length === 0,
			loaded: true,
			path: options.statePath,
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

async function readStatusState(path: string): Promise<StatusReadResult<LoopState>> {
	try {
		const raw = await readFile(path, "utf-8")
		return { kind: "ok", value: parseStateText(raw) }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", message: `missing state file: ${path}` }
		return { kind: "invalid", message: errorMessage(error) }
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
		requireBrowserEvidence: null,
		once: false,
		dryRun: false,
		checkRuntime: false,
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
		statePath: options?.statePath ?? resolve(runtimeRoot, "state.json"),
		issueDir: options?.issueDir ?? resolve(runtimeRoot, "issues"),
		evidenceRootDir: options?.evidenceRootDir ?? resolve(runtimeRoot, "evidence"),
		logDir: options?.logDir ?? resolve(runtimeRoot, "logs"),
		traceFile: options?.traceFile ?? resolve(targetCwd, ".dev-trace.txt"),
		loopFile: options?.loopFile ?? resolve(targetCwd, ".dev-loop"),
		repository: options?.repository ?? repositoryOverride,
		baseBranch: options?.baseBranch ?? null,
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
	const path = loopEventsPath(options.targetCwd, runId)
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
			loopFile: StatusLoopFileSnapshot
			command: string | null
			requireBrowserEvidence: boolean | null
	  }

type DaemonStopPlan = {
	action: "stop"
	target: string
	loopFile: string
	loopFileExists: boolean
	pid: number | null
	pidAlive: boolean | null
}

type DaemonStopResult = DaemonStopPlan & {
	stopped: true
	pidExited: boolean | null
}

export function buildDaemonStartPlan(args: Extract<DaemonCommandArgs, { action: "start" }>): DaemonStartPlan {
	const targetCwd = resolve(args.targetCwd)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const logDir = resolve(targetCwd, DEFAULT_LOG_DIR)
	const stdoutPath = resolve(logDir, `coder-loop-daemon-${timestamp}.stdout.log`)
	const stderrPath = resolve(logDir, `coder-loop-daemon-${timestamp}.stderr.log`)
	const command = [
		process.argv[0] ?? "bun",
		resolve(import.meta.dir, "loop.ts"),
		"--target-cwd",
		targetCwd,
	]
	if (args.configPath !== null) command.push("--config", args.configPath)
	if (args.repository !== null) command.push("--repo", args.repository)
	if (args.requireBrowserEvidence) command.push("--require-browser-evidence")
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

async function runDaemonStartCommand(args: Extract<DaemonCommandArgs, { action: "start" }>): Promise<void> {
	const plan = buildDaemonStartPlan(args)
	if (args.dryRun) {
		process.stdout.write([
			`daemon start dry-run: target=${plan.targetCwd}`,
			`daemon start dry-run: command=${plan.commandLine}`,
			`daemon start dry-run: require-browser-evidence=${plan.requireBrowserEvidence}`,
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
	const current = await buildCoderLoopStatusSnapshot({
		targetCwd: args.targetCwd,
		configPath: args.configPath,
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
			loopFile: current.processes.loopFile,
			command: current.processes.loopFile.command,
			requireBrowserEvidence: current.processes.loopFile.requireBrowserEvidence,
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
	const snapshot = await buildCoderLoopStatusSnapshot({
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		repository: args.repository,
		output: "json",
	})
	const plan = buildDaemonStopPlan(snapshot)
	if (args.dryRun) {
		process.stdout.write(JSON.stringify({ ...plan, dryRun: true }, null, "\t") + "\n")
		return
	}
	const result = await executeDaemonStop(plan)
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

function buildDaemonStopPlan(snapshot: CoderLoopStatusSnapshot): DaemonStopPlan {
	const loopFile = snapshot.processes.loopFile
	return {
		action: "stop",
		target: snapshot.target.cwd,
		loopFile: loopFile.path,
		loopFileExists: loopFile.exists,
		pid: loopFile.pid,
		pidAlive: loopFile.pidAlive,
	}
}

async function executeDaemonStop(plan: DaemonStopPlan): Promise<DaemonStopResult> {
	if (plan.loopFileExists) await removeLoopFile(plan.loopFile)
	let pidExited: boolean | null = null
	if (plan.pid !== null && plan.pidAlive === true) {
		try {
			process.kill(plan.pid, "SIGTERM")
			pidExited = await waitForPidExit(plan.pid, 5_000)
		} catch {
			// The loop may have exited after status was read; removing the loop file is the durable stop signal.
			pidExited = true
		}
	}
	return { ...plan, stopped: true, pidExited }
}

async function runDaemonRestartCommand(args: Extract<DaemonCommandArgs, { action: "restart" }>): Promise<void> {
	const current = await buildCoderLoopStatusSnapshot({
		targetCwd: args.targetCwd,
		configPath: args.configPath,
		repository: args.repository,
		output: "json",
	})
	const requireBrowserEvidence = args.requireBrowserEvidence || current.processes.loopFile.requireBrowserEvidence === true
	if (args.dryRun) {
		const startPlan = buildDaemonStartPlan({ ...args, action: "start", requireBrowserEvidence })
		process.stdout.write(JSON.stringify({
			action: "restart",
			target: startPlan.targetCwd,
			dryRun: true,
			stop: { targetCwd: args.targetCwd, configPath: args.configPath, repository: args.repository },
			start: { command: startPlan.command, commandLine: startPlan.commandLine },
		}, null, "\t") + "\n")
		return
	}
	const stopped = await executeDaemonStop(buildDaemonStopPlan(current))
	const started = await executeDaemonStart({ ...args, action: "start", requireBrowserEvidence, maxIterations: args.maxIterations, dryRun: false })
	process.stdout.write(JSON.stringify({
		action: "restart",
		target: current.target.cwd,
		stopped,
		started,
	}, null, "\t") + "\n")
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
		phases.push({ name: entry.name, prompt: resolve(presetDir, entry.prompt), variables })
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
		agent: { binary: root.agent.binary, extraArgs: root.agent.extraArgs ?? [] },
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
	const reviewPhase = options.preset.phases[options.preset.phases.length - 1]
	if (reviewPhase && phase === reviewPhase.name) return options.reviewRunner
	return selectRunnerForItem(item, options)
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

export async function checkRuntime(options: LoopOptions, state: LoopState): Promise<RuntimeCheckError[]> {
	const errors: RuntimeCheckError[] = []
	const seenIds = new Set<string>()
	const preset = options.preset
	const idField = preset.item.idField
	const allowedStatuses = new Set<string>([...preset.statuses.continuable, ...preset.statuses.terminal])
	const allowedPhases = new Set<string>(preset.phases.map((phase) => phase.name))

	if (state.version !== 1) pushCheckError(errors, "state.version", "must be 1")
	if (options.repository !== null && state.repository !== options.repository) pushCheckError(errors, "state.repository", `must match configured repository ${options.repository}`)
	if (options.baseBranch !== null && state.baseBranch !== options.baseBranch) pushCheckError(errors, "state.baseBranch", `must match configured baseBranch ${options.baseBranch}`)

	await checkDirectory(options.targetCwd, "targetCwd", errors)
	await checkFile(options.configPath, "config", errors)
	await checkFile(options.workflowPath, "workflow", errors)
	await checkFile(options.sharedContextPath, "shared context", errors)
	await checkFile(options.statePath, "state", errors)
	await checkDirectory(options.issueDir, "issueDir", errors)
	await checkDirectory(options.evidenceRootDir, "evidenceDir", errors)
	await checkDirectory(options.logDir, "logDir", errors)
	const runtimeRoot = resolve(options.targetCwd, ".coder-loop/runtime")
	checkInside(options.targetCwd, options.configPath, "config", errors)
	checkInside(options.targetCwd, options.workflowPath, "workflow", errors)
	checkInside(options.targetCwd, options.sharedContextPath, "shared context", errors)
	checkInside(options.targetCwd, options.statePath, "state", errors)
	checkInside(options.targetCwd, options.issueDir, "issueDir", errors)
	checkInside(options.targetCwd, options.evidenceRootDir, "evidenceDir", errors)
	checkInside(options.targetCwd, options.logDir, "logDir", errors)
	checkInside(runtimeRoot, options.configPath, "config", errors)
	checkInside(runtimeRoot, options.sharedContextPath, "shared context", errors)
	checkInside(runtimeRoot, options.statePath, "state", errors)
	checkInside(runtimeRoot, options.issueDir, "issueDir", errors)
	checkInside(runtimeRoot, options.evidenceRootDir, "evidenceDir", errors)
	checkInside(runtimeRoot, options.logDir, "logDir", errors)
	if (isWithin(runtimeRoot, options.workflowPath)) pushCheckError(errors, "workflow", "must be project policy outside .coder-loop/runtime")

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
			const issueFile = resolveRuntimePath(options, item.issueFile, `${label}.issueFile`, options.issueDir, errors)
			if (issueFile) await checkFile(issueFile, `${label}.issueFile`, errors)
		}
		if (item.evidenceDir !== null) {
			const evidenceDir = resolveRuntimePath(options, item.evidenceDir, `${label}.evidenceDir`, options.evidenceRootDir, errors)
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
	const phases = preset.phases
	const reviewPhase = phases[phases.length - 1]
	if (!reviewPhase) fail("preset must define at least one phase")
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
	return {
		runId: input.runId,
		targetCwd: input.options.targetCwd,
		agentCwd: input.agentCwd,
		workflowPath: input.options.workflowPath,
		sharedContextPath: input.options.sharedContextPath,
		statePath: input.options.statePath,
		currentIssueFile: input.currentIssueFile ?? "",
		issueDir: input.options.issueDir,
		evidenceDir: input.evidenceDir ?? input.options.evidenceRootDir,
		evidenceRootDir: input.options.evidenceRootDir,
		logDir: input.options.logDir,
		traceFile: input.options.traceFile,
		loopFile: input.options.loopFile,
		presetDir: input.options.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.options.preset),
		runIdGeneration: input.issueRun.runIdGeneration,
		resumedFromPhase: input.issueRun.resumedFromPhase ?? "",
		resumedStartedAt: input.issueRun.resumedStartedAt ?? "",
		issueKind: input.issueKind ?? "",
	}
}

export type ParsedIssueKind =
	| { ok: true; kind: IssueKind }
	| { ok: false; error: string }

export function iterationRouteForIssueKind(kind: IssueKind): string {
	if (kind === "comment") return "iter/spike-comment"
	if (kind === "code-spike") return "iter/source-writing-spike"
	return "iter/classify-scope"
}

export function parseKindFromLabels(labelNames: readonly string[]): ParsedIssueKind {
	const kindLabels = labelNames.filter((name) => name.startsWith("kind:"))
	if (kindLabels.length === 0) return { ok: true, kind: null }
	if (kindLabels.length > 1) {
		return { ok: false, error: `expected exactly one kind:* label, found ${kindLabels.length}: ${kindLabels.join(", ")}` }
	}
	const value = kindLabels[0]!.slice("kind:".length)
	if (value !== "code" && value !== "comment" && value !== "code-spike") {
		return { ok: false, error: `unknown kind label "kind:${value}" (allowed: kind:code, kind:comment, kind:code-spike)` }
	}
	return { ok: true, kind: value }
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
	eventContext?: LoopEventContext
}

export type SummaryWatchdogConfig = {
	marker: string
	termMs: number
	killMs: number
}

const DEFAULT_SUMMARY_WATCHDOG: SummaryWatchdogConfig = {
	marker: SUMMARY_WATCHDOG_MARKER,
	termMs: SUMMARY_WATCHDOG_TERM_MS,
	killMs: SUMMARY_WATCHDOG_KILL_MS,
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
	return new Promise((resolveResult) => {
		const out: Buffer[] = []
		const err: Buffer[] = []
		let settled = false

		const startedAt = new Date().toISOString()
		const attemptStreamPath = agentAttemptStreamPath(outputPath, startedAt)
		const attemptStderrPath = agentAttemptStderrPath(outputPath, startedAt)
		const statusPath = agentStatusPath(outputPath)
		const streamOutFile = createWriteStream(attemptStreamPath, { flags: "wx" })
		const stderrOutFile = createWriteStream(attemptStderrPath, { flags: "wx" })
		const runnerPlan = buildRunnerInvocation(selectedRunner, effectivePrompt, resume, {
			agentCwd: input.agentCwd,
			targetCwd: options.targetCwd,
			presetDir: options.preset.presetDir,
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

		const watchdog = createSummaryWatchdog({
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
				watchdogStdout.observeStdout(chunk.toString("utf-8"))
			} else {
				err.push(chunk)
				stderrOutFile.write(chunk)
			}
			void writeStatus()
		}

		status.pid = child.pid ?? null
		void writeStatus()
		writeLatestIndex()

		log(`Agent [${label}] spawned: runner=${selectedRunner.kind}, model=${selectedRunner.model ?? "<default>"}, pid=${child.pid}, stream=${attemptStreamPath}, stderr=${attemptStderrPath}, status=${statusPath}, resume=${resume.kind === "resume" ? resume.sessionId : "none"}`)

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
			watchdog.cancel()
			const stdout = Buffer.concat(out).toString("utf-8")
			const stderr = Buffer.concat(err).toString("utf-8")
			const exitCode = code ?? 1
			const signalName = signal ?? null
			const terminated: Terminated =
				watchdogStateAtClose.kind === "term-sent" || watchdogStateAtClose.kind === "kill-sent"
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

export type RunnerInvocationPaths = {
	agentCwd: string
	targetCwd: string
	presetDir: string
}

export function buildRunnerInvocation(runner: AgentRunnerSelection, prompt: string, resume: ResumeDecision, paths: RunnerInvocationPaths): RunnerInvocation {
	if (runner.kind === "claude") {
		const dirs = [paths.presetDir]
		if (paths.targetCwd !== paths.agentCwd) dirs.push(paths.targetCwd)
		return {
			kind: "spawn",
			binary: runner.binary,
			args: agentClaudeArgs(runner.extraArgs, prompt, resume, dirs, runner.model),
		}
	}
	return {
		kind: "spawn",
		binary: runner.binary,
		args: agentCodexArgs(runner.extraArgs, prompt, resume, paths.agentCwd, runner.model),
	}
}

export function agentCodexArgs(extraArgs: readonly string[], prompt: string, resume: ResumeDecision, agentCwd: string, model: string | null = null): string[] {
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
	return resolve(options.logDir, `${runId}.${label}.txt`)
}

function agentStatusPath(outputPath: string): string {
	return outputPath.replace(/\.txt$/, `.status.json`)
}

export function agentSessionsPath(outputPath: string): string {
	return outputPath.replace(/\.txt$/, `.sessions.jsonl`)
}

function agentAttemptStderrPath(outputPath: string, startedAt: string): string {
	const suffix = startedAt.slice(0, 19).replace(/[T:]/g, "-")
	return outputPath.replace(/\.txt$/, `.attempt-${suffix}.${process.pid}.stderr.txt`)
}

function agentAttemptStreamPath(outputPath: string, startedAt: string): string {
	const suffix = startedAt.slice(0, 19).replace(/[T:]/g, "-")
	return outputPath.replace(/\.txt$/, `.attempt-${suffix}.${process.pid}.jsonl`)
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
