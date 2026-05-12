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
import { createWriteStream, type WriteStream } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
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

const EXCLUDE_ENTRIES = [".dev-loop", ".dev-trace.txt", ".coder-loop/runtime"]

let logStream: WriteStream | null = null

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
	[key: string]: unknown
}

export type CurrentRun = {
	phase: string
	runId: string
	startedAt: string
	[key: string]: unknown
}

export type LoopState = {
	version: number
	queue: QueueItem[]
	repository: string | null
	baseBranch: string | null
	recentRuns: unknown[]
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
	claudeBinary: string | null
	claudeExtraArgs: string[]
	preset: string | null
	presetPath: string | null
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
	repository: string | null
	baseBranch: string | null
	requireBrowserEvidence: boolean
	claudeBinary: string
	claudeExtraArgs: string[]
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

type RuntimeCheckError = {
	path: string
	message: string
}

type AgentRunStatus = {
	label: AgentLabel
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

export type Terminated =
	| { kind: "clean" }
	| { kind: "signal"; name: string }
	| { kind: "error"; code: string }
	| { kind: "watchdog"; phase: "term" | "kill"; afterSummarySeconds: number }

export type SessionEntry = {
	attempt: string
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
export const SUMMARY_WATCHDOG_TERM_MS = 5 * 60 * 1000
export const SUMMARY_WATCHDOG_KILL_MS = 5 * 1000

export type SelectedIssue = {
	item: QueueItem
	issueFile: string | null
	evidenceDir: string | null
}

export type IssueRunContext = {
	runIdGeneration: "new" | "resumed"
	resumedFromPhase: string | null
	resumedStartedAt: string | null
}

export type IssueKind = "code" | "comment" | null

const RUNTIME_BINDING_KEYS = [
	"runId",
	"targetCwd",
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

export type RuntimeBindings = Record<RuntimeBindingKey, string>

export type ConfigBindings = {
	repository: string | null
	baseBranch: string | null
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

async function main() {
	const firstArg = process.argv[2]
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
			const kindResult = await fetchIssueKind(options.repository, getItemId(selected.item, options.preset))
			if (!kindResult.ok) {
				console.error(`Dry run: issue kind label check failed: ${kindResult.error}`)
				process.exit(1)
			}
			console.error(`Dry run: kind=${kindResult.kind ?? "<none>"}`)
		}
		return
	}

	logStream = createWriteStream(options.logFile, { flags: "a" })
	log(`=== coder-loop started (pid=${process.pid}, cwd=${options.targetCwd}) ===`)
	log(`Config: maxIterations=${formatMaxIterations(options.maxIterations)}`)
	log(`Repo=${options.repository}`)
	log(`Preset dir: ${options.preset.presetDir}`)
	for (const phase of options.preset.phases) log(`Phase ${phase.name} prompt: ${phase.prompt}`)
	log(`Workflow=${options.workflowPath}`)
	log(`State=${options.statePath}`)

	await ensureGitExclude(options.targetCwd)
	await writeFile(
		options.loopFile,
		`started: ${new Date().toISOString()}\npid: ${process.pid}\nlog: ${options.logFile}\ncwd: ${options.targetCwd}\nstate: ${options.statePath}\n`,
	)
	log("Loop file created. Delete .dev-loop to stop.")

	let iteration = 0

	while ((await exists(options.loopFile)) && iteration < options.maxIterations) {
		iteration++
		log(`--- Iteration ${iteration} ---`)

		const state = await loadState(options.statePath)
		await assertRuntimeValid(options, state)
		const selected = selectIssue(state, options)

		if (!selected) {
			await writeFile(options.traceFile, "No actionable issue found in .coder-loop/runtime/state.json. Review must assess whether to stop.\n")
			log("No actionable issue selected; running review for global state assessment.")
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
					issueRun: fallbackIssueRun,
					issueKind: null,
				}),
			}
			await runReview(options, fallbackRunId, fallbackCtx)
			if (!(await exists(options.loopFile))) {
				log("Review agent stopped the loop.")
				break
			}
			log("Review left loop running even though no actionable issue was selected; stopping to avoid a tight loop.")
			break
		}

		const selectedId = getItemId(selected.item, options.preset)
		const current = state.current && getCurrentId(state.current, options.preset) === selectedId ? state.current : null
		const issueRun = makeIssueRunContext(current)
		const runId = current?.runId ?? makeRunId(selectedId)
		const phases = options.preset.phases
		const iterPhase = phases[0]
		const reviewPhase = phases[phases.length - 1]
		if (!iterPhase || !reviewPhase) fail("preset must define at least one phase")
		const kindResult = await fetchIssueKind(options.repository, selectedId)
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

			const stateForReview = await loadState(options.statePath)
			markReviewStarted(stateForReview, selected.item, options.preset, runId)
			await saveState(options.statePath, stateForReview)
					} else {
			log(`Resuming ${reviewPhase.name} agent for issue #${selectedId} without rerunning iteration...`)
		}

		const reviewCode = await runReview(options, runId, ctx, { emit, ...baseEvent })
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

		log(`Iteration ${iteration} complete.`)
	}

	if (iteration >= options.maxIterations) {
		log(`Reached ${formatMaxIterations(options.maxIterations)} iterations.`)
	}

	log("=== Loop ended. ===")
	logStream?.end()
}

async function runReview(
	options: LoopOptions,
	runId: string,
	ctx: ResolveContext,
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
		claudeBinary: config.claudeBinary ?? "claude",
		claudeExtraArgs: config.claudeExtraArgs,
		maxIterations,
		dryRun: raw.dryRun,
		checkRuntime: raw.checkRuntime,
		preset,
	}
}

export async function loadPreset(presetDir: string): Promise<Preset> {
	const tomlPath = resolve(presetDir, "preset.toml")
	const raw = await readFile(tomlPath, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") fail(`Missing preset file: ${tomlPath}`)
		throw error
	})
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
	const root = expectRecord(value, "preset")
	const name = requiredString(root, "name")
	const version = requiredNumber(root, "version")
	const description = optionalString(root, "description") ?? ""

	const itemRaw = expectRecord(root.item, "preset.item")
	const idField = requiredString(itemRaw, "idField")

	const statusesRaw = expectRecord(root.statuses, "preset.statuses")
	const continuable = requiredStringArray(statusesRaw, "continuable")
	const terminal = requiredStringArray(statusesRaw, "terminal")
	for (const status of continuable) {
		if (terminal.includes(status)) presetError(`preset.statuses: "${status}" appears in both continuable and terminal`)
	}

	const phasesRaw = root.phases
	if (!Array.isArray(phasesRaw)) presetError("preset.phases must be an array")
	const phaseNames = new Set<string>()
	const phases: PresetPhase[] = []
	for (const [index, entry] of phasesRaw.entries()) {
		const phaseRecord = expectRecord(entry, `preset.phases[${index}]`)
		const phaseName = requiredString(phaseRecord, "name")
		if (phaseNames.has(phaseName)) presetError(`preset.phases[${index}].name: duplicate name "${phaseName}"`)
		phaseNames.add(phaseName)
		const phasePromptRel = requiredString(phaseRecord, "prompt")
		const phasePrompt = resolve(presetDir, phasePromptRel)
		const variablesRaw = phaseRecord.variables === undefined
			? {}
			: expectRecord(phaseRecord.variables, `preset.phases[${index}].variables`)
		const variables: Array<readonly [string, PresetVariableSource]> = []
		for (const [key, val] of Object.entries(variablesRaw)) {
			if (typeof val !== "string") presetError(`preset.phases[${index}].variables.${key}: must be a string`)
			variables.push([key, parseVariableSource(val, `preset.phases[${index}].variables.${key}`)] as const)
		}
		phases.push({ name: phaseName, prompt: phasePrompt, variables })
	}

	const fragmentsRaw = root.fragments ?? []
	if (!Array.isArray(fragmentsRaw)) presetError("preset.fragments must be an array")
	const fragmentIds = new Set<string>()
	const fragments: PresetFragment[] = []
	for (const [index, entry] of fragmentsRaw.entries()) {
		const fragmentRecord = expectRecord(entry, `preset.fragments[${index}]`)
		const id = requiredString(fragmentRecord, "id")
		if (fragmentIds.has(id)) presetError(`preset.fragments[${index}].id: duplicate id "${id}"`)
		fragmentIds.add(id)
		const role = requiredString(fragmentRecord, "role")
		const fragmentPathRel = requiredString(fragmentRecord, "path")
		fragments.push({ id, role, path: resolve(presetDir, fragmentPathRel) })
	}

	const agentRaw = expectRecord(root.agent, "preset.agent")
	const agent = {
		binary: requiredString(agentRaw, "binary"),
		extraArgs: optionalStringArray(agentRaw, "extraArgs") ?? [],
	}

	return {
		name,
		version,
		description,
		presetDir,
		item: { idField },
		statuses: { continuable, terminal },
		phases,
		fragments,
		agent,
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

function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key]
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value
	presetError(`${key} must be a string array`)
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
	const format = configFormatForPath(path)
	const parsed: unknown = format === "toml" ? Bun.TOML.parse(raw) : JSON.parse(raw)
	const root = expectRecord(parsed, "config")
	const evidence = optionalRecord(root, "evidence")
	const claude = optionalRecord(root, "claude")

	return {
		repository: optionalString(root, "repository"),
		baseBranch: optionalString(root, "baseBranch"),
		workflowFile: optionalString(root, "workflowFile"),
		sharedContextFile: optionalString(root, "sharedContextFile"),
		stateFile: optionalString(root, "stateFile"),
		issueDir: optionalString(root, "issueDir"),
		evidenceDir: optionalString(root, "evidenceDir"),
		logDir: optionalString(root, "logDir"),
		requireAgentBrowserScreenshots: evidence ? optionalBoolean(evidence, "requireAgentBrowserScreenshots") : null,
		claudeBinary: claude ? optionalString(claude, "binary") : null,
		claudeExtraArgs: claude ? (optionalStringArray(claude, "extraArgs") ?? []) : [],
		preset: readPresetName(root),
		presetPath: optionalString(root, "presetPath"),
	}
}

function readPresetName(root: Record<string, unknown>): string | null {
	const value = root.preset
	if (value === undefined || value === null) return null
	if (typeof value === "string") return value
	if (typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>
		const name = obj.name
		if (typeof name !== "string") fail("config.preset.name must be a string when preset is an object")
		return name
	}
	fail(`config.preset must be a string or { name, version } object`)
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
		const idValue = item[idField]
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
	}

	if (state.current) {
		const currentIdValue = state.current[idField]
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
				const value = item[idField]
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
	const parsed: unknown = JSON.parse(raw)
	const root = expectRecord(parsed, "state")
	const queueValue = root.queue
	if (!Array.isArray(queueValue)) fail("state.queue must be an array")

	return {
		version: requiredNumber(root, "version"),
		queue: queueValue.map((item, index) => parseQueueItem(item, `state.queue[${index}]`)),
		repository: optionalString(root, "repository"),
		baseBranch: optionalString(root, "baseBranch"),
		recentRuns: Array.isArray(root.recentRuns) ? root.recentRuns : [],
		current: parseCurrent(root.current),
	}
}

function parseQueueItem(value: unknown, label: string): QueueItem {
	const record = expectRecord(value, label)
	return {
		...record,
		status: requiredString(record, "status"),
		attempts: optionalNumber(record, "attempts"),
		title: optionalString(record, "title"),
		priority: optionalString(record, "priority"),
		branch: optionalString(record, "branch"),
		pr: optionalNumber(record, "pr"),
		lastRunId: optionalString(record, "lastRunId"),
		issueFile: optionalString(record, "issueFile"),
		evidenceDir: optionalString(record, "evidenceDir"),
	}
}

function parseCurrent(value: unknown): CurrentRun | null {
	if (value === undefined || value === null) return null
	const record = expectRecord(value, "state.current")
	return {
		...record,
		phase: requiredString(record, "phase"),
		runId: requiredString(record, "runId"),
		startedAt: requiredString(record, "startedAt"),
	}
}

async function saveState(path: string, state: LoopState): Promise<void> {
	await writeFile(path, `${JSON.stringify(state, null, "\t")}\n`)
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

	return { item: selected, issueFile, evidenceDir }
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
	state.current = {
		[preset.item.idField]: queueItem[preset.item.idField],
		phase: iterPhase.name,
		runId,
		startedAt: new Date().toISOString(),
	}
}

export function markReviewStarted(state: LoopState, item: QueueItem, preset: Preset, runId: string): void {
	const phases = preset.phases
	const reviewPhase = phases[phases.length - 1]
	if (!reviewPhase) fail("preset must define at least one phase")
	state.current = {
		[preset.item.idField]: item[preset.item.idField],
		phase: reviewPhase.name,
		runId,
		startedAt: new Date().toISOString(),
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
	const value = item[preset.item.idField]
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	throw new Error(`queue item is missing required id field "${preset.item.idField}"`)
}

export function getCurrentId(current: CurrentRun, preset: Preset): string {
	const value = current[preset.item.idField]
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

export function resolveBinding(source: PresetVariableSource, ctx: ResolveContext): string {
	if (source.kind === "item") {
		const value = ctx.item[source.field]
		return stringifyBindingValue(value, `item.${source.field}`)
	}
	if (source.kind === "config") {
		const record = ctx.config as unknown as Record<string, unknown>
		if (!(source.field in record)) throw new Error(`config.${source.field}: not in known config bindings`)
		const value = record[source.field]
		if (value === null || value === undefined) throw new Error(`config.${source.field}: must not be null or undefined`)
		return stringifyBindingValue(value, `config.${source.field}`)
	}
	if (!RUNTIME_BINDING_KEYS.includes(source.key as RuntimeBindingKey)) {
		throw new Error(`runtime.${source.key}: not in runtime binding whitelist`)
	}
	return ctx.runtime[source.key as RuntimeBindingKey]
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
	issueRun: IssueRunContext
	issueKind: IssueKind
}): RuntimeBindings {
	return {
		runId: input.runId,
		targetCwd: input.options.targetCwd,
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

export function parseKindFromLabels(labelNames: readonly string[]): ParsedIssueKind {
	const kindLabels = labelNames.filter((name) => name.startsWith("kind:"))
	if (kindLabels.length === 0) return { ok: true, kind: null }
	if (kindLabels.length > 1) {
		return { ok: false, error: `expected exactly one kind:* label, found ${kindLabels.length}: ${kindLabels.join(", ")}` }
	}
	const value = kindLabels[0]!.slice("kind:".length)
	if (value !== "code" && value !== "comment") {
		return { ok: false, error: `unknown kind label "kind:${value}" (allowed: kind:code, kind:comment)` }
	}
	return { ok: true, kind: value }
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
		repository: options.repository,
		baseBranch: options.baseBranch,
		requireBrowserEvidence: options.requireBrowserEvidence,
	}
}

async function runAgent(
	options: LoopOptions,
	label: AgentLabel,
	prompt: string,
	outputPath: string,
	eventContext?: LoopEventContext,
): Promise<{ output: string; code: number }> {
	const sessionsPath = agentSessionsPath(outputPath)
	const lastEntry = await readLastSessionEntry(sessionsPath)
	const initialResume = decideResume(lastEntry)
	if (initialResume.kind === "resume") {
		log(`Agent [${label}] cross-tick resume: sessionId=${initialResume.sessionId} (last terminated=${lastEntry?.terminated.kind ?? "?"})`)
	}

	const result = await runAgentWithBackoff({
		spawnAttempt: ({ resume }) => {
			const baseInput: SpawnOneAttemptInput = { options, label, prompt, outputPath, sessionsPath, resume }
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

export type SpawnOneAttemptInput = {
	options: LoopOptions
	label: AgentLabel
	prompt: string
	outputPath: string
	sessionsPath: string
	resume: ResumeDecision
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

export type SummaryWatchdogTimerHandle = unknown

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
		const claudeArgs = agentClaudeArgs(options.claudeExtraArgs, effectivePrompt, resume)
		const status: AgentRunStatus = {
			label,
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
		const writeStatus = (): void => {
			void writeFile(statusPath, `${JSON.stringify(status, null, "\t")}\n`).catch((error: unknown) => {
				log(`Agent [${label}] status write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}
		const writeLatestIndex = (): void => {
			const lines = [
				`# Agent [${label}] latest attempt`,
				`startedAt: ${status.startedAt}`,
				`pid: ${status.pid ?? ""}`,
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
		const watchdogConfig = input.watchdog ?? DEFAULT_SUMMARY_WATCHDOG
		const child = spawn(options.claudeBinary, claudeArgs, {
			cwd: options.targetCwd,
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
				if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>)
			},
			onTerm: () => {
				log(`Agent [${label}] forced-terminate after ITERATION SUMMARY+${Math.round(watchdogConfig.termMs / 1000)}s; sending SIGTERM (pid=${child.pid ?? "?"})`)
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

		const recordChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			status.lastStream = stream
			status.lastEventAt = new Date().toISOString()
			status.bytesWritten += chunk.byteLength
			if (stream === "stdout") {
				out.push(chunk)
				streamOutFile.write(chunk)
				if (status.sessionId === null) {
					const accumulated = Buffer.concat(out).toString("utf-8")
					const detected = parseSessionIdFromStream(accumulated)
					if (detected !== null) {
						status.sessionId = detected
					}
				}
				watchdog.observeStdout(chunk.toString("utf-8"))
			} else {
				err.push(chunk)
				stderrOutFile.write(chunk)
			}
			writeStatus()
		}

		status.pid = child.pid ?? null
		writeStatus()
		writeLatestIndex()

		log(`Agent [${label}] spawned: pid=${child.pid}, stream=${attemptStreamPath}, stderr=${attemptStderrPath}, status=${statusPath}, resume=${resume.kind === "resume" ? resume.sessionId : "none"}`)

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
			writeStatus()
			log(`Agent [${label}] spawn error: ${error.message}`)
			streamOutFile.end()
			stderrOutFile.end(`\nspawn error: ${error.message}\n`)
			void settle({ kind: "error", code: "spawn_error" }, `spawn error: ${error.message}`, 1, null)
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
			writeStatus()
			if (signal) log(`Agent [${label}] killed by signal ${signal}`)
			streamOutFile.end()
			stderrOutFile.end()
			const terminatedDetail =
				terminated.kind === "error"
					? `(${terminated.code})`
					: terminated.kind === "signal"
						? `(${terminated.name})`
						: terminated.kind === "watchdog"
							? `(forced-terminate after ITERATION SUMMARY+${terminated.afterSummarySeconds}s, phase=${terminated.phase})`
							: ""
			log(`Agent [${label}] attempt closed: exit=${exitCode}, signal=${signalName ?? "none"}, terminated=${terminated.kind}${terminatedDetail}, sessionId=${status.sessionId ?? "<none>"}`)
			void settle(terminated, stdout + "\n" + stderr, exitCode, signalName)
		})
	})
}

export function agentClaudeArgs(extraArgs: readonly string[], prompt: string, resume: ResumeDecision): string[] {
	const args = [...extraArgs]
	if (!args.includes("--output-format")) args.push("--output-format", "stream-json")
	if (!args.includes("--verbose")) args.push("--verbose")
	if (resume.kind === "resume") args.push("--resume", resume.sessionId)
	args.push("-p", prompt)
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
		const event = JSON.parse(firstLine) as { session_id?: unknown }
		if (typeof event.session_id === "string" && event.session_id !== "") return event.session_id
		return null
	} catch {
		return null
	}
}

export function extractErrorCode(stdoutText: string, stderrText: string): string {
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const event = JSON.parse(line) as Record<string, unknown>
			const isError = event["is_error"] === true || event["type"] === "error"
			if (!isError) continue
			const errorObj = event["error"] as { type?: unknown; code?: unknown; message?: unknown } | undefined
			if (errorObj && typeof errorObj === "object") {
				if (typeof errorObj.type === "string" && errorObj.type !== "") return errorObj.type
				if (typeof errorObj.code === "string" && errorObj.code !== "") return errorObj.code
				if (typeof errorObj.message === "string" && errorObj.message !== "") return errorObj.message.slice(0, 200)
			}
			if (typeof event["message"] === "string" && event["message"] !== "") return (event["message"] as string).slice(0, 200)
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
			const parsed = JSON.parse(line) as unknown
			if (!isValidSessionEntry(parsed)) continue
			return parsed
		} catch {
			continue
		}
	}
	return null
}

function isValidSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false
	const v = value as Record<string, unknown>
	if (typeof v["attempt"] !== "string") return false
	if (v["sessionId"] !== null && typeof v["sessionId"] !== "string") return false
	if (v["exitCode"] !== null && typeof v["exitCode"] !== "number") return false
	if (v["signal"] !== null && typeof v["signal"] !== "string") return false
	if (typeof v["log"] !== "string") return false
	const terminated = v["terminated"] as { kind?: unknown } | null
	if (typeof terminated !== "object" || terminated === null) return false
	const kind = terminated.kind
	if (kind === "clean") return true
	if (kind === "signal" && typeof (terminated as { name?: unknown }).name === "string") return true
	if (kind === "error" && typeof (terminated as { code?: unknown }).code === "string") return true
	if (kind === "watchdog") {
		const w = terminated as { phase?: unknown; afterSummarySeconds?: unknown }
		if ((w.phase === "term" || w.phase === "kill") && typeof w.afterSummarySeconds === "number") return true
	}
	return false
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
			deps.log(`post-summary watchdog terminated attempt (phase=${outcome.terminated.phase}); treating as success so review can proceed`)
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
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	return id === null ? `run-${timestamp}-no-issue` : `run-${timestamp}-issue-${id}`
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

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
	fail(`${label} must be an object`)
}

function optionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key]
	if (value === undefined || value === null) return null
	return expectRecord(value, key)
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key]
	if (typeof value === "string") return value
	fail(`${key} must be a string`)
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key]
	if (value === undefined || value === null) return null
	if (typeof value === "string") return value
	fail(`${key} must be a string when provided`)
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key]
	if (value === null) return null
	if (typeof value === "string") return value
	fail(`${key} must be a string or null`)
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key]
	if (typeof value === "number" && Number.isFinite(value)) return value
	fail(`${key} must be a finite number`)
}

function nullableNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key]
	if (value === null) return null
	if (typeof value === "number" && Number.isFinite(value)) return value
	fail(`${key} must be a finite number or null`)
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key]
	if (value === undefined || value === null) return null
	if (typeof value === "number" && Number.isFinite(value)) return value
	fail(`${key} must be a finite number when provided`)
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | null {
	const value = record[key]
	if (value === undefined || value === null) return null
	if (typeof value === "boolean") return value
	fail(`${key} must be a boolean when provided`)
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | null {
	const value = record[key]
	if (value === undefined || value === null) return null
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value
	fail(`${key} must be a string array when provided`)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
		log(`Fatal: ${message}`)
		logStream?.end()
		process.exit(1)
	})
}
