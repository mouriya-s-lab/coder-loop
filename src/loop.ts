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
const PRESET_DIR = resolve(PKG_ROOT, "presets/gh-issue-pr-iteration")
const ITERATION_PROMPT = resolve(PRESET_DIR, "iter-entry.md")
const REVIEW_PROMPT = resolve(PRESET_DIR, "review-entry.md")
const PROMPT_ROOT = PRESET_DIR

const DEFAULT_CONFIG_FILE = ".coder-loop/runtime/config.json"
const DEFAULT_WORKFLOW_FILE = ".coder-loop/workflow.md"
const DEFAULT_SHARED_FILE = ".coder-loop/runtime/shared.md"
const DEFAULT_STATE_FILE = ".coder-loop/runtime/state.json"
const DEFAULT_ISSUE_DIR = ".coder-loop/runtime/issues"
const DEFAULT_EVIDENCE_DIR = ".coder-loop/runtime/evidence"
const DEFAULT_LOG_DIR = ".coder-loop/runtime/logs"

const EXCLUDE_ENTRIES = [".dev-loop", ".dev-trace.txt", ".coder-loop/runtime"]
const QUEUE_STATUSES = [
	"queued",
	"in_progress",
	"changes_requested",
	"blocked",
	"moot",
	"done",
] as const
const ACTIONABLE_STATUSES = ["queued", "in_progress", "changes_requested"] as const
const PROMPT_FRAGMENTS = [
	{ id: "common/runtime-contract", role: "common", path: "common/runtime-contract.md" },
	{ id: "common/github-routing", role: "common", path: "common/github-routing.md" },
	{ id: "common/state-contract", role: "common", path: "common/state-contract.md" },
	{ id: "iter/index", role: "iter", path: "iter/index.md" },
	{ id: "iter/read-context", role: "iter", path: "iter/read-context.md" },
	{ id: "iter/classify-scope", role: "iter", path: "iter/classify-scope.md" },
	{ id: "iter/implement", role: "iter", path: "iter/implement.md" },
	{ id: "iter/verify-evidence", role: "iter", path: "iter/verify-evidence.md" },
	{ id: "iter/commit-pr", role: "iter", path: "iter/commit-pr.md" },
	{ id: "iter/handoff", role: "iter", path: "iter/handoff.md" },
	{ id: "iter/final", role: "iter", path: "iter/final.md" },
	{ id: "review/index", role: "review", path: "review/index.md" },
	{ id: "review/read-evidence", role: "review", path: "review/read-evidence.md" },
	{ id: "review/trace-honesty", role: "review", path: "review/trace-honesty.md" },
	{ id: "review/pr-protocol", role: "review", path: "review/pr-protocol.md" },
	{ id: "review/evidence-gate", role: "review", path: "review/evidence-gate.md" },
	{ id: "review/code-gate", role: "review", path: "review/code-gate.md" },
	{ id: "review/issue-closure-gate", role: "review", path: "review/issue-closure-gate.md" },
	{ id: "review/action-retry", role: "review", path: "review/action-retry.md" },
	{ id: "review/action-expand-parent", role: "review", path: "review/action-expand-parent.md" },
	{ id: "review/action-accept-pr", role: "review", path: "review/action-accept-pr.md" },
	{ id: "review/action-accept-no-pr", role: "review", path: "review/action-accept-no-pr.md" },
	{ id: "review/action-skip", role: "review", path: "review/action-skip.md" },
	{ id: "review/action-blocked", role: "review", path: "review/action-blocked.md" },
	{ id: "review/action-stop", role: "review", path: "review/action-stop.md" },
	{ id: "review/update-state", role: "review", path: "review/update-state.md" },
	{ id: "review/global-assessment", role: "review", path: "review/global-assessment.md" },
	{ id: "review/final", role: "review", path: "review/final.md" },
] as const satisfies readonly PromptFragment[]

let logStream: WriteStream | null = null

type QueueStatus = (typeof QUEUE_STATUSES)[number]
type ActionableStatus = (typeof ACTIONABLE_STATUSES)[number]
type LoopPhase = "iteration" | "review"
type AgentLabel = "iter" | "review"
type PromptFragmentRole = "common" | "iter" | "review"

type PromptFragment = {
	id: string
	role: PromptFragmentRole
	path: string
}

type QueueItem = {
	issue: number
	status: QueueStatus
	attempts: number
	title: string
	priority: string
	branch: string | null
	pr: number | null
	lastRunId: string | null
	issueFile: string
	evidenceDir: string
}

type CurrentRun = {
	issue: number
	phase: LoopPhase
	runId: string
	startedAt: string
}

type LoopState = {
	version: number
	queue: QueueItem[]
	repository: string
	baseBranch: string
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
}

type LoopOptions = {
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
	repository: string
	baseBranch: string
	requireBrowserEvidence: boolean
	claudeBinary: string
	claudeExtraArgs: string[]
	maxIterations: number
	dryRun: boolean
	checkRuntime: boolean
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

type SelectedIssue = {
	item: QueueItem
	issueFile: string
	evidenceDir: string
}

type IssueRunContext = {
	mode: "fresh" | "retry" | "resume-iteration" | "resume-review"
	previousRunId: string | null
	startedAt: string | null
	branch: string | null
	pr: number | null
	status: QueueStatus | null
}

type RenderContext = {
	issue: string
	runId: string
	currentIssueFile: string
	evidenceDir: string
	issueRun: IssueRunContext
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
	const configPath = resolveFrom(targetCwd, rawArgs.configPath ?? DEFAULT_CONFIG_FILE)
	const config = await loadConfig(configPath)
	const options = buildOptions(targetCwd, configPath, rawArgs, config)

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
		console.error(`Runtime check passed: repo=${options.repository}`)
		console.error(`Runtime check passed: state=${options.statePath}`)
		console.error(`Runtime check passed: queue=${state.queue.length}, selected=${selected ? `#${selected.item.issue}` : "none"}`)
		return
	}

	await ensureRuntime(options)
	await assertRuntimeValid(options)

	if (options.dryRun) {
		const state = await loadState(options.statePath)
		const selected = selectIssue(state, options)
		console.error(`Dry run: target=${options.targetCwd}`)
		console.error(`Dry run: repo=${options.repository}`)
		console.error(`Dry run: workflow=${options.workflowPath}`)
		console.error(`Dry run: state=${options.statePath}`)
		console.error(`Dry run: selected=${selected ? `#${selected.item.issue}` : "none"}`)
		return
	}

	logStream = createWriteStream(options.logFile, { flags: "a" })
	log(`=== coder-loop started (pid=${process.pid}, cwd=${options.targetCwd}) ===`)
	log(`Config: maxIterations=${formatMaxIterations(options.maxIterations)}`)
	log(`Repo=${options.repository}`)
	log(`Prompt files: iter=${ITERATION_PROMPT}, review=${REVIEW_PROMPT}, fragments=${PROMPT_ROOT}`)
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
			await runReview(options, {
				issue: "",
				runId: makeRunId(null),
				currentIssueFile: "",
				evidenceDir: options.evidenceRootDir,
				issueRun: { mode: "fresh", previousRunId: null, startedAt: null, branch: null, pr: null, status: null },
			})
			if (!(await exists(options.loopFile))) {
				log("Review agent stopped the loop.")
				break
			}
			log("Review left loop running even though no actionable issue was selected; stopping to avoid a tight loop.")
			break
		}

		const current = state.current?.issue === selected.item.issue ? state.current : null
		const issueRun = makeIssueRunContext(selected.item, current)
		const runId = current?.runId ?? makeRunId(selected.item.issue)
		let context: RenderContext = {
			issue: String(selected.item.issue),
			runId,
			currentIssueFile: selected.issueFile,
			evidenceDir: selected.evidenceDir,
			issueRun,
		}

		if (current?.phase !== "review") {
			const stateForIteration = await loadState(options.statePath)
			markIterationStarted(stateForIteration, selected.item.issue, runId, current === null)
			await saveState(options.statePath, stateForIteration)

			log(`${current ? "Resuming" : "Starting"} iteration agent for issue #${selected.item.issue}...`)
			const iterStart = Date.now()
			const iterPromptRaw = await readFile(ITERATION_PROMPT, "utf-8")
			const iterPrompt = renderPrompt(iterPromptRaw, options, context)
			const iterOutputPath = agentOutputPath(options, runId, "iter")
			const { output: iterTrace, code: iterCode } = await runAgent(options, "iter", iterPrompt, iterOutputPath)
			const iterDuration = ((Date.now() - iterStart) / 1000).toFixed(0)
			await writeFile(options.traceFile, iterTrace)

			log(`Iteration agent finished: issue=#${selected.item.issue}, exit=${iterCode}, duration=${iterDuration}s, trace=${options.traceFile}, output=${iterOutputPath} (${iterTrace.length} bytes)`)

			if (iterCode !== 0) {
				log(`Iteration agent failed (exit ${iterCode}). Stopping without review or state judgment.`)
				await removeLoopFile(options.loopFile)
				break
			}

			if (!(await exists(options.loopFile))) {
				log("Loop file removed during iteration. Stopping before review.")
				break
			}

			const stateForReview = await loadState(options.statePath)
			markReviewStarted(stateForReview, selected.item.issue, runId)
			await saveState(options.statePath, stateForReview)
					} else {
			log(`Resuming review agent for issue #${selected.item.issue} without rerunning iteration...`)
		}

		const reviewCode = await runReview(options, context)
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

async function runReview(options: LoopOptions, context: RenderContext): Promise<number> {
	log("Starting review agent...")
	const reviewStart = Date.now()
	const reviewPromptRaw = await readFile(REVIEW_PROMPT, "utf-8")
	const reviewPrompt = renderPrompt(reviewPromptRaw, options, context)
	const reviewOutputPath = agentOutputPath(options, context.runId, "review")
	const { output: reviewTrace, code: reviewCode } = await runAgent(options, "review", reviewPrompt, reviewOutputPath)
	const reviewDuration = ((Date.now() - reviewStart) / 1000).toFixed(0)

	log(`Review agent finished: exit=${reviewCode}, duration=${reviewDuration}s, output=${reviewOutputPath} (${reviewTrace.length} bytes)`)
	if (reviewTrace.trim().length > 0) {
		await appendFile(options.logFile, `\n--- review output ${new Date().toISOString()} ---\n${reviewTrace}\n`)
	}
	return reviewCode
}

function buildOptions(targetCwd: string, configPath: string, raw: RawArgs, config: LoopConfig): LoopOptions {
	const workflowPath = resolveFrom(targetCwd, raw.workflowPath ?? config.workflowFile ?? DEFAULT_WORKFLOW_FILE)
	const sharedContextPath = resolveFrom(targetCwd, config.sharedContextFile ?? DEFAULT_SHARED_FILE)
	const statePath = resolveFrom(targetCwd, raw.statePath ?? config.stateFile ?? DEFAULT_STATE_FILE)
	const issueDir = resolveFrom(targetCwd, config.issueDir ?? DEFAULT_ISSUE_DIR)
	const evidenceRootDir = resolveFrom(targetCwd, config.evidenceDir ?? DEFAULT_EVIDENCE_DIR)
	const logDir = resolveFrom(targetCwd, config.logDir ?? DEFAULT_LOG_DIR)
	const repository = raw.repository ?? config.repository
	if (!repository) fail("Repository is required. Set --repo or .coder-loop/runtime/config.json repository.")

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
		baseBranch: config.baseBranch ?? "main",
		requireBrowserEvidence,
		claudeBinary: config.claudeBinary ?? "claude",
		claudeExtraArgs: config.claudeExtraArgs,
		maxIterations,
		dryRun: raw.dryRun,
		checkRuntime: raw.checkRuntime,
	}
}

async function loadConfig(path: string): Promise<LoopConfig> {
	const raw = await readFile(path, "utf-8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") {
			fail(`Missing config file: ${path}`)
		}
		throw error
	})
	const parsed: unknown = JSON.parse(raw)
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
	}
}

async function ensureRuntime(options: LoopOptions): Promise<void> {
	await assertReadable(options.workflowPath, "workflow")
	await assertReadable(options.sharedContextPath, "shared context")
	await assertReadable(options.statePath, "state")
	await assertPromptFragmentsReadable()
	await mkdir(options.logDir, { recursive: true })
}

async function assertRuntimeValid(options: LoopOptions, state?: LoopState): Promise<void> {
	const runtimeState = state ?? await loadState(options.statePath)
	const errors = await checkRuntime(options, runtimeState)
	if (errors.length === 0) return

	const details = errors.map((error) => `- ${error.path}: ${error.message}`).join("\n")
	fail(`Runtime validation failed:\n${details}`)
}

async function checkRuntime(options: LoopOptions, state: LoopState): Promise<RuntimeCheckError[]> {
	const errors: RuntimeCheckError[] = []
	const seenIssues = new Set<number>()

	if (state.version !== 1) pushCheckError(errors, "state.version", "must be 1")
	if (state.repository !== options.repository) pushCheckError(errors, "state.repository", `must match configured repository ${options.repository}`)
	if (state.baseBranch !== options.baseBranch) pushCheckError(errors, "state.baseBranch", `must match configured baseBranch ${options.baseBranch}`)

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
		if (seenIssues.has(item.issue)) pushCheckError(errors, `${label}.issue`, `duplicate issue #${item.issue}`)
		seenIssues.add(item.issue)
		if (!Number.isInteger(item.issue) || item.issue <= 0) pushCheckError(errors, `${label}.issue`, "must be a positive integer")
		if (!Number.isInteger(item.attempts) || item.attempts < 0) pushCheckError(errors, `${label}.attempts`, "must be a non-negative integer")
		if (item.title.trim() === "") pushCheckError(errors, `${label}.title`, "must not be empty")
		if (item.priority.trim() === "") pushCheckError(errors, `${label}.priority`, "must not be empty")
		if (item.branch !== null && item.branch.trim() === "") pushCheckError(errors, `${label}.branch`, "must be null or non-empty")
		if (item.pr !== null && (!Number.isInteger(item.pr) || item.pr <= 0)) pushCheckError(errors, `${label}.pr`, "must be null or a positive integer")
		if (item.lastRunId !== null && item.lastRunId.trim() === "") pushCheckError(errors, `${label}.lastRunId`, "must be null or non-empty")

		const issueFile = resolveRuntimePath(options, item.issueFile, `${label}.issueFile`, options.issueDir, errors)
		const evidenceDir = resolveRuntimePath(options, item.evidenceDir, `${label}.evidenceDir`, options.evidenceRootDir, errors)
		if (issueFile) await checkFile(issueFile, `${label}.issueFile`, errors)
		if (evidenceDir) await checkDirectory(evidenceDir, `${label}.evidenceDir`, errors)
	}

	if (state.current) {
		const currentItem = state.queue.find((item) => item.issue === state.current?.issue)
		if (!currentItem) pushCheckError(errors, "state.current.issue", `issue #${state.current.issue} is not present in queue`)
		else if (!isActionableStatus(currentItem.status)) pushCheckError(errors, "state.current.issue", `issue #${state.current.issue} has non-actionable status ${currentItem.status}`)
		if (state.current.runId.trim() === "") pushCheckError(errors, "state.current.runId", "must not be empty")
		if (!isIsoDateTime(state.current.startedAt)) pushCheckError(errors, "state.current.startedAt", "must be an ISO date string")
	}

	return errors
}

async function assertPromptFragmentsReadable(): Promise<void> {
	await Promise.all(PROMPT_FRAGMENTS.map((fragment) => assertReadable(resolve(PROMPT_ROOT, fragment.path), `prompt fragment ${fragment.id}`)))
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
		repository: optionalString(root, "repository") ?? "",
		baseBranch: optionalString(root, "baseBranch") ?? "main",
		recentRuns: Array.isArray(root.recentRuns) ? root.recentRuns : [],
		current: parseCurrent(root.current),
	}
}

function parseQueueItem(value: unknown, label: string): QueueItem {
	const record = expectRecord(value, label)
	return {
		issue: requiredNumber(record, "issue"),
		status: requiredQueueStatus(record, "status"),
		attempts: requiredNumber(record, "attempts"),
		title: requiredString(record, "title"),
		priority: requiredString(record, "priority"),
		branch: nullableString(record, "branch"),
		pr: nullableNumber(record, "pr"),
		lastRunId: nullableString(record, "lastRunId"),
		issueFile: requiredString(record, "issueFile"),
		evidenceDir: requiredString(record, "evidenceDir"),
	}
}

function parseCurrent(value: unknown): CurrentRun | null {
	if (value === undefined || value === null) return null
	const record = expectRecord(value, "state.current")
	return {
		issue: requiredNumber(record, "issue"),
		phase: requiredLoopPhase(record, "phase"),
		runId: requiredString(record, "runId"),
		startedAt: requiredString(record, "startedAt"),
	}
}

async function saveState(path: string, state: LoopState): Promise<void> {
	await writeFile(path, `${JSON.stringify(state, null, "\t")}\n`)
}

function selectIssue(state: LoopState, options: LoopOptions): SelectedIssue | null {
	const currentItem = state.current ? state.queue.find((item) => item.issue === state.current?.issue) : undefined
	const selected = currentItem && isActionableStatus(currentItem.status)
		? currentItem
		: state.queue.find((item) => isActionableStatus(item.status))
	if (!selected) return null

	const issueFile = resolveFrom(options.targetCwd, selected.issueFile)
	const evidenceDir = resolveFrom(options.targetCwd, selected.evidenceDir)
	if (!isWithin(options.issueDir, issueFile)) fail(`Selected issue file must resolve inside issueDir: ${selected.issueFile}`)
	if (!isWithin(options.evidenceRootDir, evidenceDir)) fail(`Selected evidence directory must resolve inside evidenceDir: ${selected.evidenceDir}`)

	return { item: selected, issueFile, evidenceDir }
}

function markIterationStarted(state: LoopState, issue: number, runId: string, countAttempt: boolean): void {
	const item = state.queue.find((entry) => entry.issue === issue)
	if (!item) fail(`Selected issue #${issue} not found in state queue`)
	item.status = "in_progress"
	if (countAttempt) item.attempts += 1
	item.lastRunId = runId
	state.current = { issue, phase: "iteration", runId, startedAt: new Date().toISOString() }
}

function markReviewStarted(state: LoopState, issue: number, runId: string): void {
	state.current = { issue, phase: "review", runId, startedAt: new Date().toISOString() }
}

function makeIssueRunContext(item: QueueItem, current: CurrentRun | null): IssueRunContext {
	if (current) {
		return {
			mode: current.phase === "review" ? "resume-review" : "resume-iteration",
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

function renderPrompt(template: string, options: LoopOptions, context: RenderContext): string {
	const replacements: Array<[string, string]> = [
		["{{TARGET_CWD}}", options.targetCwd],
		["{{REPO}}", options.repository],
		["{{BASE_BRANCH}}", options.baseBranch],
		["{{RUN_ID}}", context.runId],
		["{{ISSUE}}", context.issue],
		["{{WORKFLOW_FILE}}", options.workflowPath],
		["{{SHARED_CONTEXT_FILE}}", options.sharedContextPath],
		["{{STATE_FILE}}", options.statePath],
		["{{CURRENT_ISSUE_FILE}}", context.currentIssueFile],
		["{{ISSUE_DIR}}", options.issueDir],
		["{{EVIDENCE_DIR}}", context.evidenceDir],
		["{{EVIDENCE_ROOT_DIR}}", options.evidenceRootDir],
		["{{LOG_DIR}}", options.logDir],
		["{{TRACE_FILE}}", options.traceFile],
		["{{LOOP_FILE}}", options.loopFile],
		["{{PROMPT_ROOT}}", PROMPT_ROOT],
		["{{PROMPT_FRAGMENT_INDEX}}", renderPromptFragmentIndex()],
		["{{REQUIRE_BROWSER_EVIDENCE}}", String(options.requireBrowserEvidence)],
		["{{ISSUE_RUN_MODE}}", context.issueRun.mode],
		["{{RECOVERY_MODE}}", context.issueRun.mode],
		["{{PREVIOUS_RUN_ID}}", context.issueRun.previousRunId ?? ""],
		["{{RECOVERY_STARTED_AT}}", context.issueRun.startedAt ?? ""],
		["{{ISSUE_BRANCH}}", context.issueRun.branch ?? ""],
		["{{ISSUE_PR}}", context.issueRun.pr === null ? "" : String(context.issueRun.pr)],
		["{{ISSUE_STATUS}}", context.issueRun.status ?? ""],
	]

	return replacements.reduce((prompt, [placeholder, value]) => prompt.replaceAll(placeholder, value), template)
}

function renderPromptFragmentIndex(): string {
	return PROMPT_FRAGMENTS
		.map((fragment) => `- ${fragment.id} (${fragment.role}): ${resolve(PROMPT_ROOT, fragment.path)}`)
		.join("\n")
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

function makeRunId(issue: number | null): string {
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	return issue === null ? `run-${timestamp}-no-issue` : `run-${timestamp}-issue-${issue}`
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

function isActionableStatus(status: QueueStatus): status is ActionableStatus {
	return ACTIONABLE_STATUSES.includes(status as ActionableStatus)
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

function requiredQueueStatus(record: Record<string, unknown>, key: string): QueueStatus {
	const value = requiredString(record, key)
	if (QUEUE_STATUSES.includes(value as QueueStatus)) return value as QueueStatus
	fail(`${key} has invalid queue status: ${value}`)
}

function requiredLoopPhase(record: Record<string, unknown>, key: string): LoopPhase {
	const value = requiredString(record, key)
	if (value === "iteration" || value === "review") return value
	fail(`${key} must be "iteration" or "review"`)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
	log(`Fatal: ${message}`)
	logStream?.end()
	process.exit(1)
})
