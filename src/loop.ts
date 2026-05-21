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
import { createWriteStream, existsSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { cliMain, parseArgs } from "./cli"
import { type as arkType } from "arktype"
import { chainRuntimePaths, defaultChainNameForTarget, loopDataRootPaths, runRuntimePaths, type ChainRuntimePaths } from "./runtime-paths"
import {
	formatRateLimitNotice,
	type RateLimitReset,
} from "./rate-limit"
import {
	assertArk,
	errorMessage,
	exists,
	fail,
	formatMaxIterations,
	getLogStream,
	isIsoDateTime,
	isJsonObject,
	isJsonValue,
	isNodeError,
	isObjectRecord,
	isWithin,
	log,
	makeRunId,
	removeLoopFile,
	resolveFrom,
	resolveIdleSleepMs,
	setLogStream,
	shellQuote,
	sleep,
	type JsonObject,
	type JsonValue,
} from "./util"

import {
	agentSessionsPath,
	AgentRunnerKindBoundary,
	AgentRunStatusBoundary,
	appendSessionEntry,
	attemptTimeoutConfigForPreset,
	buildRunnerInvocation,
	CLAUDE_REVIEW_MODEL,
	classifyTermination,
	cleanupStaleWorktrees,
	codexSummaryTextFromJsonLine,
	createSummaryWatchdog,
	createSummaryWatchdogStdoutObserver,
	decideResume,
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	ensureWorktreeForItem,
	extractErrorCode,
	isTransient5xx,
	nextBackoffSeconds,
	parseCodexThreadIdFromStream,
	parseReviewSummaryVerdict,
	parseSessionIdFromRunnerStream,
	parseSessionIdFromStream,
	readLastSessionEntry,
	removeWorktreeForItem,
	reviewOnEmptyLockPath,
	runAgentWithBackoff,
	serializeReviewOnEmptyLock,
	SessionEntryBoundary,
	spawnOneAttempt,
	summaryWatchdogConfigForPrompt,
	TerminatedBoundary,
	validateWorktreePrerequisites,
	worktreeBasePath,
	worktreePathForItem,
	agentClaudeArgs,
	agentCodexArgs,
	type AgentRunStatus,
	type AgentRunStatusInput,
	type AttemptOutcome,
	type AttemptTimeoutConfig,
	type ClassifyInput,
	type ResumeDecision,
	type ReviewSummaryVerdict,
	type RunnerInvocation,
	type RunnerInvocationPaths,
	type RunWithBackoffDeps,
	type SessionEntry,
	type SpawnOneAttemptInput,
	type SummaryWatchdog,
	type SummaryWatchdogConfig,
	type SummaryWatchdogDeps,
	type SummaryWatchdogState,
	type SummaryWatchdogTimerHandle,
	type Terminated,
} from "./agent"

export { extractRateLimitReset, formatRateLimitNotice, parseRateLimitNoticeLine } from "./rate-limit"
export { type JsonValue, type JsonObject, resolveIdleSleepMs } from "./util"
export {
	agentSessionsPath,
	appendSessionEntry,
	ATTEMPT_TIMEOUT_KILL_MS,
	attemptTimeoutConfigForPreset,
	BACKOFF_BUDGET_SECONDS,
	buildRunnerInvocation,
	CLAUDE_REVIEW_MODEL,
	classifyTermination,
	cleanupStaleWorktrees,
	codexSummaryTextFromJsonLine,
	createSummaryWatchdog,
	createSummaryWatchdogStdoutObserver,
	decideResume,
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	ensureWorktreeForItem,
	extractErrorCode,
	isTransient5xx,
	nextBackoffSeconds,
	parseCodexThreadIdFromStream,
	parseReviewSummaryVerdict,
	parseSessionIdFromRunnerStream,
	parseSessionIdFromStream,
	readLastSessionEntry,
	removeWorktreeForItem,
	RESUME_CONTINUE_PROMPT,
	REVIEW_SUMMARY_WATCHDOG_MARKER,
	reviewOnEmptyLockPath,
	runAgentWithBackoff,
	serializeReviewOnEmptyLock,
	spawnOneAttempt,
	SUMMARY_WATCHDOG_MARKER,
	SUMMARY_WATCHDOG_KILL_MS,
	SUMMARY_WATCHDOG_TERM_MS,
	summaryWatchdogConfigForPrompt,
	validateWorktreePrerequisites,
	worktreeBasePath,
	worktreePathForItem,
	agentClaudeArgs,
	agentCodexArgs,
	type AgentRunStatus,
	type AgentRunStatusInput,
	type AttemptOutcome,
	type AttemptTimeoutConfig,
	type ClassifyInput,
	type ResumeDecision,
	type ReviewSummaryVerdict,
	type RunnerInvocation,
	type RunnerInvocationPaths,
	type RunWithBackoffDeps,
	type SessionEntry,
	type SpawnOneAttemptInput,
	type SummaryWatchdog,
	type SummaryWatchdogConfig,
	type SummaryWatchdogDeps,
	type SummaryWatchdogState,
	type SummaryWatchdogTimerHandle,
	type Terminated,
} from "./agent"
import {
	buildCoderLoopStatusSnapshot,
	findOwnedLiveProcess,
	readAgentPhaseStatus,
	readRuntimeState,
	StatusConfigBoundary,
	StatusStateBoundary,
	loopConfigFromStatusInput,
	type CoderLoopStatusSnapshot,
	type StatusTargetSnapshot,
	type StatusResourceSnapshot,
	type StatusRunnerSelectionSnapshot,
	type StatusRunnerDefaultsSnapshot,
	type StatusStateKind,
	type StatusStateSnapshot,
	type StatusSelectedIssue,
	type StatusQueueSnapshot,
	type StatusPhaseStatusSnapshot,
	type StatusCurrentSnapshot,
	type StatusEventsSnapshot,
	type StatusLoopFileSnapshot,
	type StatusProcessInfo,
	type StatusProcessSnapshot,
} from "./status"

export {
	buildCoderLoopStatusSnapshot,
	findOwnedLiveProcess,
	type CoderLoopStatusSnapshot,
	type StatusTargetSnapshot,
	type StatusResourceSnapshot,
	type StatusRunnerSelectionSnapshot,
	type StatusRunnerDefaultsSnapshot,
	type StatusStateKind,
	type StatusStateSnapshot,
	type StatusSelectedIssue,
	type StatusQueueSnapshot,
	type StatusPhaseStatusSnapshot,
	type StatusCurrentSnapshot,
	type StatusEventsSnapshot,
	type StatusLoopFileSnapshot,
	type StatusProcessInfo,
	type StatusProcessSnapshot,
} from "./status"

export {
	buildDaemonStartPlan,
	normalizeQueueIssueId,
	requeueBlockedItem,
	runDaemonStartCommand,
	runDaemonStopCommand,
	runDaemonRestartCommand,
	runDaemonTargetStatusCommand,
	runQueueUnblockCommand,
	waitForPidExit,
	type DaemonStartPlan,
	type QueueUnblockMutationOutcome,
} from "./daemon-client"

export { cliMain, parseArgs } from "./cli"

const PKG_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const PRESET_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const DEFAULT_CONFIG_FILE = ".coder-loop/runtime/config.json"
const DEFAULT_CONFIG_FILE_TOML = ".coder-loop/runtime/config.toml"
const DEFAULT_WORKFLOW_FILE = ".coder-loop/workflow.md"
const DEFAULT_SHARED_FILE = ".coder-loop/runtime/shared.md"
export const DEFAULT_STATE_FILE = ".coder-loop/runtime/state.json"
const DEFAULT_ISSUE_DIR = ".coder-loop/runtime/issues"
const DEFAULT_EVIDENCE_DIR = ".coder-loop/runtime/evidence"
const DEFAULT_ITERATION_RUNNER: AgentRunnerKind = "codex"

const EXCLUDE_ENTRIES = [".coder-loop/runtime"]

type AgentLabel = string

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

export type RuntimeStateReadResult =
	| { kind: "ok"; value: LoopState; source: RuntimeStateSource }
	| { kind: "missing"; message: string; statePath: string }
	| { kind: "invalid"; message: string; statePath: string }

export type RawArgs = {
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

export type DaemonTargetIpcOptions = {
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

export type LoopConfig = {
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

// CLI subcommand definitions and handlers are in ./cli.ts

async function main() {
	if (await cliMain()) return

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

	setLogStream(createWriteStream(options.logFile, { flags: "a" }))
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
	getLogStream()?.end()
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

export function buildOptions(targetCwd: string, configPath: string, raw: RawArgs, config: LoopConfig, preset: Preset): LoopOptions {
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

export async function resolveConfigPath(targetCwd: string, override: string | null): Promise<string> {
	if (override !== null) return resolveFrom(targetCwd, override)
	const jsonPath = resolveFrom(targetCwd, DEFAULT_CONFIG_FILE)
	if (await exists(jsonPath)) return jsonPath
	const tomlPath = resolveFrom(targetCwd, DEFAULT_CONFIG_FILE_TOML)
	if (await exists(tomlPath)) return tomlPath
	return jsonPath
}

export async function loadConfig(path: string): Promise<LoopConfig> {
	const raw = await readFile(path, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null
		}
		throw error
	})
	if (raw === null) return defaultLoopConfig()
	return parseConfigText(raw, path)
}

export function defaultLoopConfig(): LoopConfig {
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

export function parseConfigText(raw: string, path: string): LoopConfig {
	const format = configFormatForPath(path)
	const parsed: unknown = format === "toml" ? Bun.TOML.parse(raw) : JSON.parse(raw)
	const input = assertArk(StatusConfigBoundary, parsed, "config")
	return loopConfigFromStatusInput(input)
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

function selectRunnerForItem(item: QueueItem, options: LoopOptions): AgentRunnerSelection {
	if (item.runner === null) return options.defaultRunner
	return { ...options.runnerCommands[item.runner], source: "queue" }
}

export function selectRunnerForPhase(phase: string, item: QueueItem, options: LoopOptions): AgentRunnerSelection {
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

export async function loadState(path: string): Promise<LoopState> {
	const raw = await readFile(path, "utf-8")
	return parseStateText(raw)
}

export function parseStateText(raw: string): LoopState {
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

export async function saveState(path: string, state: LoopState): Promise<void> {
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

export function agentOutputPath(options: LoopOptions, runId: string, label: AgentLabel): string {
	return runRuntimePaths(options.logDir, runId).phasePaths(label).latestPath
}

export function agentStatusPath(outputPath: string): string {
	return runPhaseSibling(outputPath, "status.json")
}

function runPhaseSibling(outputPath: string, filename: string): string {
	return resolve(dirname(outputPath), filename)
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

if (import.meta.main) {
	main().catch((error: unknown) => {
		const message = errorMessage(error)
		if (getLogStream() === null) console.error(message)
		else log(`Fatal: ${message}`)
		getLogStream()?.end()
		process.exit(1)
	})
}
