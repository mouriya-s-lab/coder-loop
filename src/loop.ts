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
}

export type SelectedIssue = {
	item: QueueItem
	issueFile: string | null
	evidenceDir: string | null
}

export type IssueRunContext = {
	mode: "fresh" | "retry" | "resume-iteration" | "resume-review"
	previousRunId: string | null
	startedAt: string | null
	branch: string | null
	pr: number | null
	status: string | null
}

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
	"issueRunMode",
	"recoveryMode",
	"previousRunId",
	"recoveryStartedAt",
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
			const fallbackIssueRun: IssueRunContext = { mode: "fresh", previousRunId: null, startedAt: null, branch: null, pr: null, status: null }
			const fallbackCtx: ResolveContext = {
				item: fallbackItem,
				config: buildConfigBindings(options),
				runtime: buildRuntimeBindings({
					options,
					runId: fallbackRunId,
					currentIssueFile: "",
					evidenceDir: options.evidenceRootDir,
					issueRun: fallbackIssueRun,
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
		const issueRun = makeIssueRunContext(selected.item, current, options.preset)
		const runId = current?.runId ?? makeRunId(selectedId)
		const phases = options.preset.phases
		const iterPhase = phases[0]
		const reviewPhase = phases[phases.length - 1]
		if (!iterPhase || !reviewPhase) fail("preset must define at least one phase")
		const ctx: ResolveContext = {
			item: selected.item,
			config: buildConfigBindings(options),
			runtime: buildRuntimeBindings({
				options,
				runId,
				currentIssueFile: selected.issueFile,
				evidenceDir: selected.evidenceDir,
				issueRun,
			}),
		}

		if (current?.phase !== reviewPhase.name) {
			const stateForIteration = await loadState(options.statePath)
			markIterationStarted(stateForIteration, selected.item, options.preset, runId, current === null)
			await saveState(options.statePath, stateForIteration)

			log(`${current ? "Resuming" : "Starting"} ${iterPhase.name} agent for issue #${selectedId}...`)
			const iterStart = Date.now()
			const iterPromptRaw = await readFile(iterPhase.prompt, "utf-8")
			const iterPrompt = renderPrompt(iterPromptRaw, iterPhase, ctx)
			const iterOutputPath = agentOutputPath(options, runId, iterPhase.name)
			const { output: iterTrace, code: iterCode } = await runAgent(options, iterPhase.name, iterPrompt, iterOutputPath)
			const iterDuration = ((Date.now() - iterStart) / 1000).toFixed(0)
			await writeFile(options.traceFile, iterTrace)

			log(`${iterPhase.name} agent finished: issue=#${selectedId}, exit=${iterCode}, duration=${iterDuration}s, trace=${options.traceFile}, output=${iterOutputPath} (${iterTrace.length} bytes)`)

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

		const reviewCode = await runReview(options, runId, ctx)
		if (reviewCode !== 0) {
			log(`Review agent crashed (exit ${reviewCode}). Stopping.`)
			await removeLoopFile(options.loopFile)
			break
		}

		if (!(await exists(options.loopFile))) {
			log("Review agent stopped the loop.")
			break
		}

		log(`Iteration ${iteration} complete.`)
	}

	if (iteration >= options.maxIterations) {
		log(`Reached ${formatMaxIterations(options.maxIterations)} iterations.`)
	}

	log("=== Loop ended. ===")
	logStream?.end()
}

async function runReview(options: LoopOptions, runId: string, ctx: ResolveContext): Promise<number> {
	const phases = options.preset.phases
	const reviewPhase = phases[phases.length - 1]
	if (!reviewPhase) fail("preset must define at least one phase")
	log(`Starting ${reviewPhase.name} agent...`)
	const reviewStart = Date.now()
	const reviewPromptRaw = await readFile(reviewPhase.prompt, "utf-8")
	const reviewPrompt = renderPrompt(reviewPromptRaw, reviewPhase, ctx)
	const reviewOutputPath = agentOutputPath(options, runId, reviewPhase.name)
	const { output: reviewTrace, code: reviewCode } = await runAgent(options, reviewPhase.name, reviewPrompt, reviewOutputPath)
	const reviewDuration = ((Date.now() - reviewStart) / 1000).toFixed(0)

	log(`${reviewPhase.name} agent finished: exit=${reviewCode}, duration=${reviewDuration}s, output=${reviewOutputPath} (${reviewTrace.length} bytes)`)
	if (reviewTrace.trim().length > 0) {
		await appendFile(options.logFile, `\n--- ${reviewPhase.name} output ${new Date().toISOString()} ---\n${reviewTrace}\n`)
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
		preset: optionalString(root, "preset"),
		presetPath: optionalString(root, "presetPath"),
	}
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
	queueItem.status = "in_progress"
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

export function makeIssueRunContext(item: QueueItem, current: CurrentRun | null, preset: Preset): IssueRunContext {
	if (current) {
		const phases = preset.phases
		const reviewPhase = phases[phases.length - 1]
		const isReviewResume = reviewPhase !== undefined && current.phase === reviewPhase.name
		return {
			mode: isReviewResume ? "resume-review" : "resume-iteration",
			previousRunId: current.runId,
			startedAt: current.startedAt,
			branch: item.branch,
			pr: item.pr,
			status: item.status,
		}
	}

	return {
		mode: item.status === "changes_requested" ? "retry" : "fresh",
		previousRunId: item.lastRunId,
		startedAt: null,
		branch: item.branch,
		pr: item.pr,
		status: item.status,
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
		issueRunMode: input.issueRun.mode,
		recoveryMode: input.issueRun.mode,
		previousRunId: input.issueRun.previousRunId ?? "",
		recoveryStartedAt: input.issueRun.startedAt ?? "",
	}
}

export function buildConfigBindings(options: LoopOptions): ConfigBindings {
	return {
		repository: options.repository,
		baseBranch: options.baseBranch,
		requireBrowserEvidence: options.requireBrowserEvidence,
	}
}

async function runAgent(options: LoopOptions, label: AgentLabel, prompt: string, outputPath: string): Promise<{ output: string; code: number }> {
	return new Promise((resolveResult) => {
		const out: Buffer[] = []
		const err: Buffer[] = []
		let settled = false

		const startedAt = new Date().toISOString()
		const attemptPath = agentAttemptOutputPath(outputPath, startedAt)
		const statusPath = agentStatusPath(outputPath)
		const outputStream = createWriteStream(attemptPath, { flags: "wx" })
		const claudeArgs = agentClaudeArgs(options.claudeExtraArgs, prompt)
		const status: AgentRunStatus = {
			label,
			pid: null,
			startedAt,
			lastEventAt: startedAt,
			outputPath: attemptPath,
			statusPath,
			bytesWritten: 0,
			promptChars: prompt.length,
			lastStream: null,
			exitCode: null,
			signal: null,
			error: null,
		}
		const writeStatus = (): void => {
			void writeFile(statusPath, `${JSON.stringify(status, null, "\t")}\n`).catch((error: unknown) => {
				log(`Agent [${label}] status write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}
		const writeLatestIndex = (): void => {
			const index = [
				`# Agent [${label}] latest attempt`,
				`startedAt: ${status.startedAt}`,
				`pid: ${status.pid ?? ""}`,
				`status: ${statusPath}`,
				`output: ${attemptPath}`,
				`promptChars: ${prompt.length}`,
				"",
			].join("\n")
			void writeFile(outputPath, index).catch((error: unknown) => {
				log(`Agent [${label}] latest index write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}
		const recordChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			status.lastStream = stream
			status.lastEventAt = new Date().toISOString()
			status.bytesWritten += chunk.byteLength
			if (stream === "stdout") out.push(chunk)
			else err.push(chunk)
			outputStream.write(chunk)
			writeStatus()
		}

		const child = spawn(options.claudeBinary, claudeArgs, {
			cwd: options.targetCwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		})
		status.pid = child.pid ?? null
		writeStatus()
		writeLatestIndex()

		log(`Agent [${label}] spawned: pid=${child.pid}, output=${attemptPath}, latest=${outputPath}, status=${statusPath}`)
		outputStream.write(`# Agent [${label}] started at ${startedAt}\n`)
		outputStream.write(`# Command: ${options.claudeBinary} ${claudeArgs.map(shellQuote).join(" ")}\n\n`)

		child.stdout.on("data", (chunk: Buffer) => recordChunk("stdout", chunk))
		child.stderr.on("data", (chunk: Buffer) => recordChunk("stderr", chunk))

		child.on("error", (error) => {
			if (settled) return
			settled = true
			status.error = error.message
			status.lastEventAt = new Date().toISOString()
			writeStatus()
			log(`Agent [${label}] spawn error: ${error.message}`)
			outputStream.end(`\nspawn error: ${error.message}\n`)
			resolveResult({ output: `spawn error: ${error.message}`, code: 1 })
		})

		child.on("close", (code, signal) => {
			if (settled) return
			settled = true
			const stdout = Buffer.concat(out).toString("utf-8")
			const stderr = Buffer.concat(err).toString("utf-8")
			status.exitCode = code ?? 1
			status.signal = signal
			status.lastEventAt = new Date().toISOString()
			writeStatus()
			if (signal) log(`Agent [${label}] killed by signal ${signal}`)
			outputStream.end(`\n# Agent [${label}] exited at ${status.lastEventAt} code=${code ?? 1}${signal ? ` signal=${signal}` : ""}\n`)
			resolveResult({ output: stdout + "\n" + stderr, code: code ?? 1 })
		})
	})
}

function agentClaudeArgs(extraArgs: string[], prompt: string): string[] {
	const args = [...extraArgs]
	if (!args.includes("--output-format")) args.push("--output-format", "stream-json")
	if (!args.includes("--verbose")) args.push("--verbose")
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

function agentAttemptOutputPath(outputPath: string, startedAt: string): string {
	const suffix = startedAt.slice(0, 19).replace(/[T:]/g, "-")
	return outputPath.replace(/\.txt$/, `.attempt-${suffix}.${process.pid}.txt`)
}

function agentStatusPath(outputPath: string): string {
	return outputPath.replace(/\.txt$/, `.status.json`)
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
