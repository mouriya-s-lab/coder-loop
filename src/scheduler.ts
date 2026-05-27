import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import {
	buildConfigBindings,
	buildRunnerInvocation,
	hasIterationSummaryMarker,
	loadPreset,
	parseReviewSummaryVerdict,
	renderFragmentIndex,
	renderPrompt,
	resolveIssueKind,
	reviewPhaseForPreset,
	selectRunnerForPhase,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type IssueKind,
	type JsonObject,
	type JsonValue,
	type ParsedIssueKind,
	type Preset,
	type PresetPhase,
	type PhaseRunnerSelectionInput,
	type QueueItem,
	type ResolveContext,
	type ResumeDecision,
	type RunnerInvocationPaths,
	type RuntimeBindings,
} from "./loop"
import { type ChainRecord, type ItemRecord, type SqliteStateStore } from "./sqlite-state"
import {
	type LoopDataRootOptions,
	RuntimePathError,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	sanitizeChainName,
} from "./runtime-paths"

export type SchedulerActiveRun = {
	runId: string
	pid: number | null
	itemId: number
	chainId: number
	repoCwd: string
	worktreePath: string
	startedAt: number
	closed: Promise<SchedulerCompletedRun>
	terminate: (options?: SchedulerRunTerminateOptions) => Promise<SchedulerCompletedRun>
}

export type SchedulerRunTerminateOptions = {
	forceAfterMs?: number
}

export type SchedulerCompletedRun = {
	runId: string
	itemId: number
	chainId: number
	repoCwd: string
	exitCode: number
	stdout: string
	stderr: string
	status: string
}

export type SchedulerSlot = {
	key: string
	chainId: number
	chainName: string
	repoCwd: string
	worktreePath: string | null
	activeRun: SchedulerActiveRun | null
}

export type SchedulerState = {
	slots: Map<string, SchedulerSlot>
	finalizingItemStatuses: Map<number, string>
	finalizingChainIds: Set<number>
}

export type SchedulerStore = Pick<
	SqliteStateStore,
	| "listChains"
	| "listItems"
	| "getNextPendingItem"
	| "updateChain"
	| "getItem"
	| "updateItem"
	| "recordRun"
	| "completeRun"
	| "setCurrentRun"
	| "getCurrentRun"
	| "clearCurrentRun"
>

export type SchedulerSpawnContext = {
	chain: ChainRecord
	item: ItemRecord
	slot: SchedulerSlot
	runId: string
	worktreePath: string
	presetDir: string
	phase: string
}

export type SchedulerWorktreeContext = {
	chain: ChainRecord
	repoCwd: string
	slotKey: string
}

export type SchedulerWorktreeManager = (context: SchedulerWorktreeContext) => Promise<string>

export type SchedulerEvent =
	| { type: "slot.busy"; slotKey: string; chainId: number; repoCwd: string; activeRunId: string }
	| { type: "agent.spawn"; slotKey: string; chainId: number; itemId: number; runId: string; pid: number | null; worktreePath: string; presetDir: string }
	| { type: "agent.exit"; slotKey: string; chainId: number; itemId: number; runId: string; exitCode: number; status: string }
	| { type: "spawn.aborted"; slotKey: string; chainId: number; chainName: string; itemId: number; issueNumber: number; reason: string; toStatus: string }
	| { type: "chain.complete_trigger"; chainId: number; chainName: string; runId?: string; decision: SchedulerChainCompleteDecision["decision"]; reason?: string }
	| { type: "chain.complete_trigger_failed"; chainId: number; chainName: string; runId?: string; error: string }
	| { type: "chain.completed"; chainId: number; chainName: string; runId?: string }
	| { type: "phase.start"; ts: string; runId: string; chainId: number; itemId: number; repoCwd: string; phase: string; pid: number | null }
	| { type: "phase.end"; ts: string; runId: string; chainId: number; itemId: number; phase: string; exitCode: number; durationSeconds: number; status: string }
	| { type: "queue.terminal"; ts: string; runId: string; chainId: number; itemId: number; terminalStatus: string }

export type SchedulerChainCompleteTriggerContext = {
	chain: ChainRecord
	items: readonly ItemRecord[]
	runId?: string
	terminalStatuses: readonly string[]
}

export type SchedulerChainCompleteDecision =
	| { decision: "complete"; reason?: string }
	| { decision: "keep-active"; reason?: string }

export type SchedulerChainCompleteTrigger = (context: SchedulerChainCompleteTriggerContext) => Promise<SchedulerChainCompleteDecision> | SchedulerChainCompleteDecision
export type SchedulerChainCompleteTriggerForChain = (context: SchedulerChainCompleteTriggerContext) => Promise<SchedulerChainCompleteDecision | null> | SchedulerChainCompleteDecision | null

export type SchedulerKindResolver = (context: {
	chain: ChainRecord
	item: ItemRecord
}) => Promise<ParsedIssueKind> | ParsedIssueKind

export type SchedulerPhaseRunnerInput = {
	chain: ChainRecord
	item: ItemRecord
	phase: string
}

export type SchedulerPhaseRunner = (input: SchedulerPhaseRunnerInput) => AgentRunnerSelection | Promise<AgentRunnerSelection>

export type SchedulerPhaseRunnerSelectionResolver = (chain: ChainRecord) => PhaseRunnerSelectionInput | Promise<PhaseRunnerSelectionInput>

export type SchedulerOptions = {
	store: SchedulerStore
	state: SchedulerState
	runner?: AgentRunnerSelection
	phaseRunner?: SchedulerPhaseRunner
	phaseRunnerSelectionForChain?: SchedulerPhaseRunnerSelectionResolver
	presetDir: string
	presetDirForChain?: (chain: ChainRecord) => string
	phase?: string
	prompt:
		| string
		| ((context: SchedulerSpawnContext) => string | Promise<string>)
	worktreeManager?: SchedulerWorktreeManager
	loopDataRootOptions?: LoopDataRootOptions
	pendingStatuses?: readonly string[]
	terminalStatuses?: readonly string[]
	statusesForChain?: (chain: ChainRecord) => SchedulerChainStatuses | Promise<SchedulerChainStatuses>
	now?: () => number
	runIdFactory?: (context: { chain: ChainRecord; item: ItemRecord; phase: string }) => string
	statusFromExit?: (context: SchedulerStatusFromExitContext) => string
	kindResolver?: SchedulerKindResolver
	chainCompleteTrigger?: SchedulerChainCompleteTrigger
	chainCompleteTriggerForChain?: SchedulerChainCompleteTriggerForChain
	onEvent?: (event: SchedulerEvent) => void | Promise<void>
}

export type SchedulerChainStatuses = {
	pending: readonly string[]
	terminal: readonly string[]
}

export type SchedulerStatusFromExitContext = {
	exitCode: number
	stdout: string
	stderr: string
	item: ItemRecord
	chain: ChainRecord
	phase: string
	runner: AgentRunnerSelection
}

export type DefaultSchedulerStatusFromExitInput = {
	exitCode: number
	stdout: string
	phase: string
	runnerKind: AgentRunnerKind
}

const ITERATION_PHASE_NAME = "iteration"

export function defaultSchedulerStatusFromExit(input: DefaultSchedulerStatusFromExitInput): string {
	if (input.exitCode !== 0) return "changes_requested"
	const reviewVerdict = parseReviewSummaryVerdict(input.stdout, input.runnerKind)
	if (reviewVerdict !== null) {
		switch (reviewVerdict) {
			case "accepted":
			case "stop":
				return "done"
			case "skip":
				return "moot"
			case "blocked":
				return "blocked"
			case "retry":
				return "changes_requested"
		}
	}
	if (input.phase === ITERATION_PHASE_NAME && hasIterationSummaryMarker(input.stdout, input.runnerKind)) {
		return "in_progress"
	}
	console.warn(`coder-loop scheduler: phase ${input.phase} exit 0 without SUMMARY marker, retry`)
	return "changes_requested"
}

export type SchedulerTickResult = {
	spawnedRuns: SchedulerActiveRun[]
	completedChainIds: number[]
}

const DEFAULT_PHASE = "iteration"
const DEFAULT_PENDING_STATUSES = ["queued", "changes_requested"] as const
const DEFAULT_TERMINAL_STATUSES = ["done", "moot", "blocked"] as const
const CHAIN_COMPLETE_TRIGGER_STATE_METADATA_KEY = "coderLoopChainCompleteTrigger"

let fallbackRunSequence = 0

export function createSchedulerState(): SchedulerState {
	return { slots: new Map(), finalizingItemStatuses: new Map(), finalizingChainIds: new Set() }
}

export async function schedulerTick(options: SchedulerOptions): Promise<SchedulerTickResult> {
	const activeChains = options.store
		.listChains()
		.filter((chain) => chain.status === "active" && hasValidChainName(chain.name))
	const activeChainIds = new Set(activeChains.map((chain) => chain.id))
	const spawnedRuns: SchedulerActiveRun[] = []
	const completedChainIds: number[] = []

	removeIdleSlotsForInactiveChains(options.state, activeChainIds)

	for (const chain of activeChains) {
		const chainStatuses = await schedulerStatusesForChain(options, chain)
		const items = options.store.listItems(chain.id)
		const repoCwds = distinct(items.map((item) => item.repoCwd))
		const phasePlan = await resolvePhasePlanForChain(options, chain)

		for (const repoCwd of repoCwds) {
			const slot = getOrCreateSlot(options.state, chain, repoCwd)
			if (slot.activeRun !== null) {
				await emit(options, {
					type: "slot.busy",
					slotKey: slot.key,
					chainId: chain.id,
					repoCwd,
					activeRunId: slot.activeRun.runId,
				})
				continue
			}
			if (hasFinalizingItemForRepo(options.state, items, repoCwd)) continue

			const next = selectNextItemAndPhase({
				store: options.store,
				chainId: chain.id,
				repoCwd,
				items,
				chainStatuses,
				phasePlan,
				explicitPhase: options.phase,
			})
			if (next === null) continue

			const activeRun = await spawnSchedulerRun(options, chain, next.item, slot, next.phase)
			if (activeRun !== null) spawnedRuns.push(activeRun)
		}

		if (await completeChainIfReady(options, chain, undefined, chainStatuses.terminal)) completedChainIds.push(chain.id)
	}

	return { spawnedRuns, completedChainIds }
}

type SchedulerItemTriggerPhase = {
	name: string
	afterPhase: string
	whenStatus: string
}

type SchedulerPhasePlan = {
	iterPhase: string
	reviewPhase: string
	itemTriggerPhases: readonly SchedulerItemTriggerPhase[]
}

async function resolvePhasePlanForChain(options: SchedulerOptions, chain: ChainRecord): Promise<SchedulerPhasePlan> {
	if (options.phase !== undefined) return { iterPhase: options.phase, reviewPhase: options.phase, itemTriggerPhases: [] }
	try {
		const preset = await loadPreset(schedulerPresetDir(options, chain))
		const iterPhase = preset.phases.find((phase) => phase.trigger === null)?.name ?? DEFAULT_PHASE
		const reviewPhase = reviewPhaseForPreset(preset).name
		const itemTriggerPhases = preset.phases.flatMap((phase): SchedulerItemTriggerPhase[] => {
			const trigger = phase.trigger
			if (trigger === null) return []
			if (!("afterPhase" in trigger)) return []
			return [{ name: phase.name, afterPhase: trigger.afterPhase, whenStatus: trigger.whenStatus }]
		})
		return { iterPhase, reviewPhase, itemTriggerPhases }
	} catch {
		return { iterPhase: DEFAULT_PHASE, reviewPhase: DEFAULT_PHASE, itemTriggerPhases: [] }
	}
}

type SelectNextItemAndPhaseInput = {
	store: SchedulerStore
	chainId: number
	repoCwd: string
	items: readonly ItemRecord[]
	chainStatuses: SchedulerChainStatuses
	phasePlan: SchedulerPhasePlan
	explicitPhase: string | undefined
}

function selectNextItemAndPhase(input: SelectNextItemAndPhaseInput): { item: ItemRecord; phase: string } | null {
	if (input.explicitPhase !== undefined) {
		const pending = input.store.getNextPendingItem({
			chainId: input.chainId,
			repoCwd: input.repoCwd,
			statuses: input.chainStatuses.pending,
			terminalStatuses: input.chainStatuses.terminal,
		})
		return pending === null ? null : { item: pending, phase: input.explicitPhase }
	}

	const repoItems = input.items.filter((item) => item.repoCwd === input.repoCwd)
	const iterDone = repoItems.find((item) =>
		item.status === "in_progress" && item.phase === input.phasePlan.iterPhase,
	)
	if (iterDone !== undefined && input.phasePlan.iterPhase !== input.phasePlan.reviewPhase) {
		return { item: iterDone, phase: input.phasePlan.reviewPhase }
	}

	for (const triggerPhase of input.phasePlan.itemTriggerPhases) {
		const triggered = repoItems.find((item) =>
			item.phase === triggerPhase.afterPhase &&
			item.status === triggerPhase.whenStatus &&
			item.phase !== triggerPhase.name,
		)
		if (triggered !== undefined) return { item: triggered, phase: triggerPhase.name }
	}

	const pending = input.store.getNextPendingItem({
		chainId: input.chainId,
		repoCwd: input.repoCwd,
		statuses: input.chainStatuses.pending,
		terminalStatuses: input.chainStatuses.terminal,
	})
	return pending === null ? null : { item: pending, phase: input.phasePlan.iterPhase }
}

export async function runSchedulerUntilIdle(options: SchedulerOptions, maxTicks = 100): Promise<SchedulerActiveRun[]> {
	const allSpawned: SchedulerActiveRun[] = []
	for (let tick = 0; tick < maxTicks; tick++) {
		const result = await schedulerTick(options)
		allSpawned.push(...result.spawnedRuns)
		const activeRuns = listActiveRuns(options.state)
		if (result.spawnedRuns.length === 0 && activeRuns.length === 0) return allSpawned
		if (activeRuns.length > 0) await Promise.race(activeRuns.map((run) => run.closed))
	}
	throw new SchedulerError("max_ticks_exceeded", `scheduler did not become idle after ${maxTicks} ticks`)
}

export function schedulerSlotKey(chainId: number, repoCwd: string): string {
	return `${chainId}\u0000${repoCwd}`
}

export function schedulerSlotWorktreePath(chain: ChainRecord, repoCwd: string, options: LoopDataRootOptions = {}): string {
	const chainPaths = resolveChainRuntimePaths(chain.name, options)
	const repoLabel = safePathComponent(basename(repoCwd) || "repo")
	const repoHash = createHash("sha256").update(repoCwd).digest("hex").slice(0, 16)
	return resolve(chainPaths.chainRoot, "worktrees", `${repoLabel}-${repoHash}`)
}

export function createGitWorktreeManager(options: LoopDataRootOptions = {}): SchedulerWorktreeManager {
	return async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, options)
		await mkdir(dirname(worktreePath), { recursive: true })
		if (gitWorktreeListIncludesPath(repoCwd, worktreePath)) return worktreePath

		const branchName = `coder-loop/${safeGitRefComponent(chain.name)}-${createHash("sha256").update(repoCwd).digest("hex").slice(0, 12)}`
		const startRef = chooseWorktreeStartRef(repoCwd, chain.baseBranch)
		const result = git(repoCwd, ["worktree", "add", "-B", branchName, worktreePath, startRef])
		if (result.exitCode !== 0) {
			throw new SchedulerError("worktree_create_failed", `failed to create scheduler worktree at ${worktreePath}: ${result.stderr}`)
		}
		return worktreePath
	}
}

export type SchedulerChainWorktreeCleanup = {
	repoCwd: string
	worktreePath: string
	registered: boolean
	removed: boolean
	pruned: boolean
	error: string | null
}

export function cleanupSchedulerChainWorktrees(
	chain: ChainRecord,
	repoCwds: readonly string[],
	options: LoopDataRootOptions = {},
): SchedulerChainWorktreeCleanup[] {
	const cleaned: SchedulerChainWorktreeCleanup[] = []
	for (const repoCwd of distinct(repoCwds)) {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, options)
		const listResult = git(repoCwd, ["worktree", "list", "--porcelain"])
		if (listResult.exitCode !== 0) {
			cleaned.push({
				repoCwd,
				worktreePath,
				registered: false,
				removed: false,
				pruned: false,
				error: `git worktree list failed (exit ${listResult.exitCode}): ${listResult.stderr}`,
			})
			continue
		}

		const registered = gitWorktreeListOutputIncludesPath(listResult.stdout, worktreePath)
		let removed = false
		let error: string | null = null
		if (registered && existsSync(worktreePath)) {
			const removeResult = git(repoCwd, ["worktree", "remove", "--force", worktreePath])
			removed = removeResult.exitCode === 0
			if (!removed) error = `git worktree remove failed (exit ${removeResult.exitCode}): ${removeResult.stderr}`
		}

		const pruneResult = git(repoCwd, ["worktree", "prune"])
		const pruned = pruneResult.exitCode === 0
		if (!pruned) {
			const pruneError = `git worktree prune failed (exit ${pruneResult.exitCode}): ${pruneResult.stderr}`
			error = error === null ? pruneError : `${error}; ${pruneError}`
		}

		cleaned.push({ repoCwd, worktreePath, registered, removed, pruned, error })
	}
	return cleaned
}

export function listActiveRuns(state: SchedulerState): SchedulerActiveRun[] {
	return [...state.slots.values()].flatMap((slot) => (slot.activeRun === null ? [] : [slot.activeRun]))
}

export class SchedulerError extends Error {
	constructor(
		readonly code: "max_ticks_exceeded" | "worktree_create_failed" | "spawn_failed",
		message: string,
	) {
		super(message)
		this.name = "SchedulerError"
	}
}

async function spawnSchedulerRun(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	slot: SchedulerSlot,
	phase: string,
): Promise<SchedulerActiveRun | null> {
	const kindResolver = options.kindResolver ?? defaultSchedulerKindResolver
	const kindResult = await kindResolver({ chain, item })
	if (!kindResult.ok || kindResult.kind === null) {
		const reason = kindResult.ok
			? `expected exactly one kind:* label, found 0 on ${chain.repository || "<unconfigured>"}#${item.issueNumber}`
			: kindResult.error
		const abortedAt = nowSeconds(options)
		options.store.updateItem(item.id, { status: "blocked", updatedAt: abortedAt })
		console.warn(`coder-loop scheduler: kind label check failed for chain=${chain.name} item=${item.id} issue=#${item.issueNumber}: ${reason}`)
		await emit(options, {
			type: "spawn.aborted",
			slotKey: slot.key,
			chainId: chain.id,
			chainName: chain.name,
			itemId: item.id,
			issueNumber: item.issueNumber,
			reason,
			toStatus: "blocked",
		})
		return null
	}

	const worktreeManager = options.worktreeManager ?? createGitWorktreeManager(options.loopDataRootOptions)
	const worktreePath = slot.worktreePath ?? await worktreeManager({ chain, repoCwd: item.repoCwd, slotKey: slot.key })
	slot.worktreePath = worktreePath

	const runner = await resolvePhaseRunner(options, { chain, item, phase })
	const runId = options.runIdFactory?.({ chain, item, phase }) ?? makeRunId(item.id)
	const startedAt = nowSeconds(options)
	options.store.recordRun({
		runId,
		chainId: chain.id,
		itemId: item.id,
		phase,
		startedAt,
		extra: { slotKey: slot.key, repoCwd: item.repoCwd, worktreePath },
	})
	options.store.setCurrentRun({
		chainId: chain.id,
		phase,
		runId,
		startedAt,
		extra: { slotKey: slot.key, itemId: item.id, repoCwd: item.repoCwd },
	})
	options.store.updateItem(item.id, {
		status: "in_progress",
		attempts: item.attempts + 1,
		lastRunId: runId,
		agentCwd: worktreePath,
		phase,
		updatedAt: startedAt,
	})

	const presetDir = schedulerPresetDir(options, chain)
	const context: SchedulerSpawnContext = { chain, item, slot, runId, worktreePath, presetDir, phase }
	const rawPrompt = typeof options.prompt === "string" ? options.prompt : await options.prompt(context)
	const renderedPrompt = await renderSchedulerSpawnPrompt({
		rawPrompt,
		presetDir,
		phase,
		chain,
		item,
		runId,
		worktreePath,
		issueKind: kindResult.kind,
		loopDataRootOptions: options.loopDataRootOptions,
	})
	const runnerPlan = buildRunnerInvocation(
		runner,
		renderedPrompt,
		freshResume(),
		invocationPaths(item.repoCwd, worktreePath, presetDir, resolveLoopDataPaths(options.loopDataRootOptions).root),
	)
	await initializeSchedulerRunArtifacts(options, chain, item, runId, phase, startedAt, worktreePath)
	const child = spawn(runnerPlan.binary, runnerPlan.args, {
		cwd: worktreePath,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	})
	const activeRun = attachRunCloseHandler(options, chain, item, slot, runId, worktreePath, startedAt, phase, child, runner)
	options.store.setCurrentRun({
		chainId: chain.id,
		phase,
		runId,
		startedAt,
		extra: { slotKey: slot.key, itemId: item.id, repoCwd: item.repoCwd, worktreePath, pid: activeRun.pid, processGroupLeader: true },
	})
	await writeSchedulerRunStatus(options, {
		runId,
		chain,
		item,
		phase,
		startedAt,
		endedAt: null,
		exitCode: null,
		status: "in_progress",
		pid: activeRun.pid,
		worktreePath,
		stdoutBytes: 0,
		stderrBytes: 0,
	})
	slot.activeRun = activeRun
	await emit(options, {
		type: "agent.spawn",
		slotKey: slot.key,
		chainId: chain.id,
		itemId: item.id,
		runId,
		pid: activeRun.pid,
		worktreePath,
		presetDir,
	})
	await emit(options, {
		type: "phase.start",
		ts: nowIso(options),
		runId,
		chainId: chain.id,
		itemId: item.id,
		repoCwd: item.repoCwd,
		phase,
		pid: activeRun.pid,
	})
	return activeRun
}

function attachRunCloseHandler(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	slot: SchedulerSlot,
	runId: string,
	worktreePath: string,
	startedAt: number,
	phase: string,
	child: ReturnType<typeof spawn>,
	runner: AgentRunnerSelection,
): SchedulerActiveRun {
	const stdout: Buffer[] = []
	const stderr: Buffer[] = []
	const closed = new Promise<SchedulerCompletedRun>((resolveClosed) => {
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", (error) => {
			stderr.push(Buffer.from(error.message))
		})
		child.on("close", (code) => {
			void (async () => {
				const exitCode = code ?? 1
				const stdoutText = Buffer.concat(stdout).toString("utf-8")
				const stderrText = Buffer.concat(stderr).toString("utf-8")
				const statusFromExit = options.statusFromExit?.({ exitCode, stdout: stdoutText, stderr: stderrText, item, chain, phase, runner })
					?? defaultSchedulerStatusFromExit({ exitCode, stdout: stdoutText, phase, runnerKind: runner.kind })
				const terminalStatuses = new Set((await schedulerStatusesForChain(options, chain)).terminal)
				const currentItem = options.store.getItem(item.id)
				const status = currentItem !== null && terminalStatuses.has(currentItem.status) ? currentItem.status : statusFromExit
				const endedAt = nowSeconds(options)
				const itemTransitionedToTerminal = (currentItem === null || !terminalStatuses.has(currentItem.status)) && terminalStatuses.has(status)
				options.state.finalizingItemStatuses.set(item.id, status)
				try {
					await writeSchedulerRunCompletionArtifacts(options, {
						runId,
						chain,
						item,
						phase,
						startedAt,
						endedAt,
						exitCode,
						status,
						pid: child.pid ?? null,
						worktreePath,
						stdoutText,
						stderrText,
					})

					const currentRun = options.store.getCurrentRun(chain.id)
					if (currentRun?.runId === runId) options.store.clearCurrentRun(chain.id)

					if (slot.activeRun?.runId === runId) slot.activeRun = null
					await emit(options, { type: "agent.exit", slotKey: slot.key, chainId: chain.id, itemId: item.id, runId, exitCode, status })
					await emit(options, {
						type: "phase.end",
						ts: nowIso(options),
						runId,
						chainId: chain.id,
						itemId: item.id,
						phase,
						exitCode,
						durationSeconds: Math.max(0, endedAt - startedAt),
						status,
					})
					options.store.completeRun(runId, { endedAt, exitCode, extra: { stdoutBytes: stdoutText.length, stderrBytes: stderrText.length } })
					if (currentItem === null || !terminalStatuses.has(currentItem.status)) {
						options.store.updateItem(item.id, { status, lastRunId: runId, agentCwd: worktreePath, updatedAt: endedAt })
					}
					if (itemTransitionedToTerminal) {
						await emit(options, {
							type: "queue.terminal",
							ts: nowIso(options),
							runId,
							chainId: chain.id,
							itemId: item.id,
							terminalStatus: status,
						})
					}
					await completeChainIfReady(options, chain, runId, [...terminalStatuses])
					resolveClosed({ runId, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, exitCode, stdout: stdoutText, stderr: stderrText, status })
				} finally {
					options.state.finalizingItemStatuses.delete(item.id)
				}
			})()
		})
	})
	const terminate = createRunTerminator(child, closed)
	return { runId, pid: child.pid ?? null, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, worktreePath, startedAt, closed, terminate }
}

function createRunTerminator(
	child: ReturnType<typeof spawn>,
	closed: Promise<SchedulerCompletedRun>,
): (options?: SchedulerRunTerminateOptions) => Promise<SchedulerCompletedRun> {
	let requested = false
	return async (options = {}) => {
		if (!requested && child.exitCode === null && child.signalCode === null) {
			requested = true
			sendSignalToChildProcessGroup(child, "SIGTERM")
			const closedBeforeForce = await promiseSettledWithin(closed, options.forceAfterMs ?? 5_000)
			if (!closedBeforeForce && child.exitCode === null && child.signalCode === null) sendSignalToChildProcessGroup(child, "SIGKILL")
		}
		return await closed
	}
}

function sendSignalToChildProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	const pid = child.pid
	if (pid === undefined) return
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal)
			return
		} catch {
			// Fall through to leader-only signalling for old non-detached children or ESRCH.
		}
	}
	try {
		child.kill(signal)
	} catch {
		// The process may have exited between the liveness check and signal delivery.
	}
}

async function promiseSettledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | null = null
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs)
			}),
		])
	} finally {
		if (timeout !== null) clearTimeout(timeout)
	}
}

async function completeChainIfReady(options: SchedulerOptions, chain: ChainRecord, runId?: string, terminalStatuses?: readonly string[]): Promise<boolean> {
	if (hasActiveSlotForChain(options.state, chain.id)) return false
	const effectiveTerminalStatuses = terminalStatuses ?? (await schedulerStatusesForChain(options, chain)).terminal
	const current = options.store.listChains().find((candidate) => candidate.id === chain.id)
	if (current?.status !== "active") return false
	const items = options.store.listItems(chain.id)
	if (items.length === 0) return false
	if (runId === undefined && hasFinalizingItemForChain(options.state, items)) return false
	if (!allItemsTerminalIncludingFinalizing(options, chain.id, effectiveTerminalStatuses)) return false
	if (options.state.finalizingChainIds.has(chain.id)) return false
	const phasePlan = await resolvePhasePlanForChain(options, chain)
	if (hasPendingItemLevelTrigger(options, chain.id, phasePlan)) return false
	options.state.finalizingChainIds.add(chain.id)
	try {
		if (!await chainCompletionTriggerAllowsCompletion(options, current, runId, effectiveTerminalStatuses)) return false
		const refreshed = options.store.listChains().find((candidate) => candidate.id === chain.id)
		if (refreshed?.status !== "active") return false
		if (options.store.listItems(chain.id).length === 0) return false
		if (!allItemsTerminalIncludingFinalizing(options, chain.id, effectiveTerminalStatuses)) return false
		const updated = options.store.updateChain(chain.id, { status: "completed", updatedAt: nowSeconds(options) })
		await emit(options, { type: "chain.completed", chainId: updated.id, chainName: updated.name, ...(runId === undefined ? {} : { runId }) })
		return true
	} finally {
		options.state.finalizingChainIds.delete(chain.id)
	}
}

async function chainCompletionTriggerAllowsCompletion(options: SchedulerOptions, chain: ChainRecord, runId: string | undefined, terminalStatuses: readonly string[]): Promise<boolean> {
	try {
		const items = listItemsIncludingFinalizing(options, chain.id)
		const fingerprint = chainCompletionFingerprint(chain, items, terminalStatuses)
		if (keepActiveTriggerStateApplies(chain, fingerprint)) return false

		const context: SchedulerChainCompleteTriggerContext = {
			chain,
			items,
			...(runId === undefined ? {} : { runId }),
			terminalStatuses,
		}
		const decision = options.chainCompleteTrigger !== undefined
			? await options.chainCompleteTrigger(context)
			: await options.chainCompleteTriggerForChain?.(context) ?? null
		if (decision === null) return true
		await emit(options, {
			type: "chain.complete_trigger",
			chainId: chain.id,
			chainName: chain.name,
			...(runId === undefined ? {} : { runId }),
			decision: decision.decision,
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
		})
		if (decision.decision === "keep-active") {
			persistKeepActiveTriggerState(options, chain, fingerprint, decision, runId)
			return false
		}
		return decision.decision === "complete"
	} catch (error) {
		await emit(options, {
			type: "chain.complete_trigger_failed",
			chainId: chain.id,
			chainName: chain.name,
			...(runId === undefined ? {} : { runId }),
			error: errorMessage(error),
		})
		return false
	}
}

function keepActiveTriggerStateApplies(chain: ChainRecord, fingerprint: string): boolean {
	const state = jsonObject(chain.metadata[CHAIN_COMPLETE_TRIGGER_STATE_METADATA_KEY])
	return state?.decision === "keep-active" && state.fingerprint === fingerprint
}

function persistKeepActiveTriggerState(
	options: SchedulerOptions,
	chain: ChainRecord,
	fingerprint: string,
	decision: Extract<SchedulerChainCompleteDecision, { decision: "keep-active" }>,
	runId: string | undefined,
): void {
	const recordedAt = nowSeconds(options)
	const state: JsonObject = {
		decision: decision.decision,
		fingerprint,
		recordedAt,
	}
	if (decision.reason !== undefined) state.reason = decision.reason
	if (runId !== undefined) state.runId = runId
	options.store.updateChain(chain.id, {
		metadata: {
			...chain.metadata,
			[CHAIN_COMPLETE_TRIGGER_STATE_METADATA_KEY]: state,
		},
		updatedAt: recordedAt,
	})
}

function chainCompletionFingerprint(chain: ChainRecord, items: readonly ItemRecord[], terminalStatuses: readonly string[]): string {
	const payload: JsonObject = {
		chain: {
			id: chain.id,
			name: chain.name,
			preset: chain.preset,
			repository: chain.repository,
			baseBranch: chain.baseBranch,
			umbrellaIssue: chain.umbrellaIssue,
			umbrellaRepo: chain.umbrellaRepo,
			metadata: chainMetadataForFingerprint(chain.metadata),
		},
		terminalStatuses: [...terminalStatuses].sort(),
		items: items
			.map((item) => ({
				id: item.id,
				issueNumber: item.issueNumber,
				repoCwd: item.repoCwd,
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
				phase: item.phase,
				extra: item.extra,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			}))
			.sort((a, b) => a.id - b.id),
	}
	return createHash("sha256").update(stableJsonStringify(payload)).digest("hex")
}

function chainMetadataForFingerprint(metadata: JsonObject): JsonObject {
	const result: JsonObject = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (key === CHAIN_COMPLETE_TRIGGER_STATE_METADATA_KEY) continue
		result[key] = value
	}
	return result
}

function stableJsonStringify(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key]!)}`)
			.join(",")}}`
	}
	return JSON.stringify(value)
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
	if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") return null
	return value
}

async function schedulerStatusesForChain(options: SchedulerOptions, chain: ChainRecord): Promise<SchedulerChainStatuses> {
	const resolved = await options.statusesForChain?.(chain)
	return {
		pending: resolved?.pending ?? options.pendingStatuses ?? DEFAULT_PENDING_STATUSES,
		terminal: resolved?.terminal ?? options.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES,
	}
}

function allItemsTerminalIncludingFinalizing(options: SchedulerOptions, chainId: number, terminalStatuses: readonly string[]): boolean {
	const terminal = new Set(terminalStatuses)
	return listItemsIncludingFinalizing(options, chainId).every((item) => terminal.has(item.status))
}

function hasPendingItemLevelTrigger(options: SchedulerOptions, chainId: number, phasePlan: SchedulerPhasePlan): boolean {
	if (phasePlan.itemTriggerPhases.length === 0) return false
	const items = listItemsIncludingFinalizing(options, chainId)
	for (const item of items) {
		for (const triggerPhase of phasePlan.itemTriggerPhases) {
			if (
				item.phase === triggerPhase.afterPhase &&
				item.status === triggerPhase.whenStatus &&
				item.phase !== triggerPhase.name
			) return true
		}
	}
	return false
}

function listItemsIncludingFinalizing(options: SchedulerOptions, chainId: number): ItemRecord[] {
	return options.store.listItems(chainId).map((item) => {
		const finalizingStatus = options.state.finalizingItemStatuses.get(item.id)
		return finalizingStatus === undefined ? item : { ...item, status: finalizingStatus }
	})
}

function getOrCreateSlot(state: SchedulerState, chain: ChainRecord, repoCwd: string): SchedulerSlot {
	const key = schedulerSlotKey(chain.id, repoCwd)
	const existing = state.slots.get(key)
	if (existing) return existing
	const slot: SchedulerSlot = {
		key,
		chainId: chain.id,
		chainName: chain.name,
		repoCwd,
		worktreePath: null,
		activeRun: null,
	}
	state.slots.set(key, slot)
	return slot
}

function hasActiveSlotForChain(state: SchedulerState, chainId: number): boolean {
	return [...state.slots.values()].some((slot) => slot.chainId === chainId && slot.activeRun !== null)
}

function hasFinalizingItemForRepo(state: SchedulerState, items: readonly ItemRecord[], repoCwd: string): boolean {
	return items.some((item) => item.repoCwd === repoCwd && state.finalizingItemStatuses.has(item.id))
}

function hasFinalizingItemForChain(state: SchedulerState, items: readonly ItemRecord[]): boolean {
	return items.some((item) => state.finalizingItemStatuses.has(item.id))
}

function removeIdleSlotsForInactiveChains(state: SchedulerState, activeChainIds: Set<number>): void {
	for (const [key, slot] of state.slots.entries()) {
		if (!activeChainIds.has(slot.chainId) && slot.activeRun === null) state.slots.delete(key)
	}
}

function distinct(values: readonly string[]): string[] {
	return [...new Set(values)]
}

function nowSeconds(options: SchedulerOptions): number {
	return options.now?.() ?? Math.floor(Date.now() / 1000)
}

function nowIso(options: SchedulerOptions): string {
	return new Date(nowSeconds(options) * 1000).toISOString()
}

function makeRunId(itemId: number): string {
	return `run-${Date.now()}-${++fallbackRunSequence}-item-${itemId}`
}

function freshResume(): ResumeDecision {
	return { kind: "fresh" }
}

export async function defaultSchedulerKindResolver(context: { chain: ChainRecord; item: ItemRecord }): Promise<ParsedIssueKind> {
	const repository = context.chain.repository === "" ? null : context.chain.repository
	return await resolveIssueKind(repository, String(context.item.issueNumber), context.item.extra)
}

async function resolvePhaseRunner(
	options: SchedulerOptions,
	input: SchedulerPhaseRunnerInput,
): Promise<AgentRunnerSelection> {
	if (options.phaseRunner !== undefined) return await options.phaseRunner(input)
	if (options.phaseRunnerSelectionForChain !== undefined) {
		const selection = await options.phaseRunnerSelectionForChain(input.chain)
		return selectRunnerForPhase(input.phase, input.item, selection)
	}
	if (options.runner !== undefined) return options.runner
	throw new SchedulerError(
		"spawn_failed",
		`scheduler: no runner configured for chain=${input.chain.name} item=${input.item.id} phase=${input.phase}; set SchedulerOptions.phaseRunner, .phaseRunnerSelectionForChain, or .runner`,
	)
}

function invocationPaths(targetCwd: string, agentCwd: string, presetDir: string, loopDataRoot: string): RunnerInvocationPaths {
	return { targetCwd, agentCwd, presetDir, loopDataRoot }
}

export type SchedulerPromptRenderInput = {
	rawPrompt: string
	presetDir: string
	phase: string
	chain: ChainRecord
	item: ItemRecord
	runId: string
	worktreePath: string
	issueKind: IssueKind
	loopDataRootOptions?: LoopDataRootOptions | undefined
}

export async function renderSchedulerSpawnPrompt(input: SchedulerPromptRenderInput): Promise<string> {
	const preset = await loadPreset(input.presetDir)
	const presetPhase = preset.phases.find((entry) => entry.name === input.phase)
	if (presetPhase === undefined) return input.rawPrompt
	const ctx = buildSchedulerResolveContext({
		preset,
		phase: presetPhase,
		chain: input.chain,
		item: input.item,
		runId: input.runId,
		worktreePath: input.worktreePath,
		issueKind: input.issueKind,
		loopDataRootOptions: input.loopDataRootOptions,
	})
	return renderPrompt(input.rawPrompt, presetPhase, ctx)
}

export function buildSchedulerResolveContext(input: {
	preset: Preset
	phase: PresetPhase
	chain: ChainRecord
	item: ItemRecord
	runId: string
	worktreePath: string
	issueKind: IssueKind
	loopDataRootOptions?: LoopDataRootOptions | undefined
}): ResolveContext {
	const chainPaths = resolveChainRuntimePaths(input.chain.name, input.loopDataRootOptions)
	const evidenceDir = resolveItemEvidenceDir(input.item, chainPaths.issueEvidenceDir(input.item.issueNumber))
	const currentIssueFile = resolveItemIssueFile(input.item, chainPaths.issueFile(input.item.issueNumber))
	const runtime: RuntimeBindings = {
		runId: input.runId,
		targetCwd: input.item.repoCwd,
		agentCwd: input.worktreePath,
		workflowPath: resolveRepoWorkflowPath(input.item.repoCwd),
		sharedContextPath: chainPaths.sharedFile,
		currentIssueFile,
		issueDir: chainPaths.issuesDir,
		evidenceDir,
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
		presetDir: input.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.preset),
		runIdGeneration: "new",
		resumedFromPhase: "",
		resumedStartedAt: "",
		issueKind: input.issueKind ?? "",
		chainName: input.chain.name,
		chainUmbrellaRepo: input.chain.umbrellaRepo ?? "",
		chainUmbrellaIssue: input.chain.umbrellaIssue === null ? "" : String(input.chain.umbrellaIssue),
		chainBaseBranch: input.chain.baseBranch,
		repoCwd: input.item.repoCwd,
	}
	const config = buildConfigBindings({
		repository: input.chain.repository,
		baseBranch: input.chain.baseBranch,
		requireBrowserEvidence: false,
	})
	const item: QueueItem = itemRecordToQueueItem(input.item, input.preset)
	return { item, config, runtime }
}

function itemRecordToQueueItem(item: ItemRecord, preset: Preset): QueueItem {
	const idField = preset.item.idField
	const extra: JsonObject = { ...item.extra }
	if (extra[idField] === undefined) extra[idField] = item.issueNumber
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

function resolveItemEvidenceDir(item: ItemRecord, fallback: string): string {
	if (item.evidenceDir === null || item.evidenceDir === "") return fallback
	return item.evidenceDir
}

function resolveItemIssueFile(item: ItemRecord, fallback: string): string {
	if (item.issueFile === null || item.issueFile === "") return fallback
	return item.issueFile
}

function resolveRepoWorkflowPath(repoCwd: string): string {
	return resolve(repoCwd, ".coder-loop/workflow.md")
}

function schedulerPresetDir(options: SchedulerOptions, chain: ChainRecord): string {
	return options.presetDirForChain?.(chain) ?? options.presetDir
}

async function emit(options: SchedulerOptions, event: SchedulerEvent): Promise<void> {
	await appendSchedulerRunEvent(options, event)
	await options.onEvent?.(event)
}

async function initializeSchedulerRunArtifacts(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	runId: string,
	phase: string,
	startedAt: number,
	worktreePath: string,
): Promise<void> {
	const paths = resolveChainRuntimePaths(chain.name, options.loopDataRootOptions)
	await mkdir(paths.runDir(runId), { recursive: true })
	await Promise.all([
		writeFile(paths.runStdoutFile(runId), ""),
		writeFile(paths.runStderrFile(runId), ""),
		writeFile(paths.runEventsFile(runId), ""),
		writeSchedulerRunStatus(options, {
			runId,
			chain,
			item,
			phase,
			startedAt,
			endedAt: null,
			exitCode: null,
			status: "in_progress",
			pid: null,
			worktreePath,
			stdoutBytes: 0,
			stderrBytes: 0,
		}),
	])
}

async function writeSchedulerRunCompletionArtifacts(
	options: SchedulerOptions,
	input: {
		runId: string
		chain: ChainRecord
		item: ItemRecord
		phase: string
		startedAt: number
		endedAt: number
		exitCode: number
		status: string
		pid: number | null
		worktreePath: string
		stdoutText: string
		stderrText: string
	},
): Promise<void> {
	const paths = resolveChainRuntimePaths(input.chain.name, options.loopDataRootOptions)
	await mkdir(paths.runDir(input.runId), { recursive: true })
	await Promise.all([
		writeFile(paths.runStdoutFile(input.runId), input.stdoutText),
		writeFile(paths.runStderrFile(input.runId), input.stderrText),
		writeSchedulerRunStatus(options, {
			runId: input.runId,
			chain: input.chain,
			item: input.item,
			phase: input.phase,
			startedAt: input.startedAt,
			endedAt: input.endedAt,
			exitCode: input.exitCode,
			status: input.status,
			pid: input.pid,
			worktreePath: input.worktreePath,
			stdoutBytes: Buffer.byteLength(input.stdoutText),
			stderrBytes: Buffer.byteLength(input.stderrText),
		}),
	])
}

async function writeSchedulerRunStatus(
	options: SchedulerOptions,
	input: {
		runId: string
		chain: ChainRecord
		item: ItemRecord
		phase: string
		startedAt: number
		endedAt: number | null
		exitCode: number | null
		status: string
		pid: number | null
		worktreePath: string
		stdoutBytes: number
		stderrBytes: number
	},
): Promise<void> {
	const paths = resolveChainRuntimePaths(input.chain.name, options.loopDataRootOptions)
	await mkdir(paths.runDir(input.runId), { recursive: true })
	await writeFile(paths.runStatusFile(input.runId), `${JSON.stringify({
		runId: input.runId,
		chainId: input.chain.id,
		chainName: input.chain.name,
		itemId: input.item.id,
		issueNumber: input.item.issueNumber,
		phase: input.phase,
		pid: input.pid,
		processGroupLeader: input.pid !== null,
		repoCwd: input.item.repoCwd,
		worktreePath: input.worktreePath,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		exitCode: input.exitCode,
		status: input.status,
		stdoutBytes: input.stdoutBytes,
		stderrBytes: input.stderrBytes,
		stdoutPath: paths.runStdoutFile(input.runId),
		stderrPath: paths.runStderrFile(input.runId),
		eventsPath: paths.runEventsFile(input.runId),
	}, null, "\t")}\n`)
}

async function appendSchedulerRunEvent(options: SchedulerOptions, event: SchedulerEvent): Promise<void> {
	const runId = schedulerEventRunId(event)
	if (runId === null) return
	const chainName = schedulerEventChainName(options, event.chainId)
	if (chainName === null) return
	const paths = resolveChainRuntimePaths(chainName, options.loopDataRootOptions)
	await mkdir(paths.runDir(runId), { recursive: true })
	await appendFile(paths.runEventsFile(runId), `${JSON.stringify({
		...event,
		recordedAt: nowSeconds(options),
	})}\n`)
}

function schedulerEventRunId(event: SchedulerEvent): string | null {
	if (event.type === "slot.busy") return event.activeRunId
	if (event.type === "spawn.aborted") return null
	if (event.type === "chain.completed") return event.runId ?? null
	if (event.type === "chain.complete_trigger") return event.runId ?? null
	if (event.type === "chain.complete_trigger_failed") return event.runId ?? null
	return event.runId
}

function schedulerEventChainName(options: SchedulerOptions, chainId: number): string | null {
	return options.store.listChains().find((chain) => chain.id === chainId)?.name ?? null
}

function safePathComponent(input: string): string {
	const sanitized = input.replace(/[^A-Za-z0-9._-]/g, "_")
	return sanitized === "" || sanitized === "." || sanitized.includes("..") ? "repo" : sanitized
}

function safeGitRefComponent(input: string): string {
	return input.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+/g, ".").replace(/^\.+|\.+$/g, "") || "chain"
}

function chooseWorktreeStartRef(repoCwd: string, baseBranch: string): string {
	for (const candidate of [`origin/${baseBranch}`, baseBranch, "HEAD"]) {
		if (git(repoCwd, ["rev-parse", "--verify", candidate]).exitCode === 0) return candidate
	}
	return "HEAD"
}

function gitWorktreeListIncludesPath(repoCwd: string, expectedPath: string): boolean {
	if (!existsSync(expectedPath)) return false
	const result = git(repoCwd, ["worktree", "list", "--porcelain"])
	if (result.exitCode !== 0) return false
	return gitWorktreeListOutputIncludesPath(result.stdout, expectedPath)
}

function gitWorktreeListOutputIncludesPath(stdout: string, expectedPath: string): boolean {
	const expectedRealPath = realpathForComparison(expectedPath)
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.some((listedPath) => listedPath === expectedPath || realpathForComparison(listedPath) === expectedRealPath)
}

function realpathForComparison(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

function hasValidChainName(chainName: string): boolean {
	try {
		sanitizeChainName(chainName)
		return true
	} catch (error) {
		if (error instanceof RuntimePathError && error.code === "invalid_chain_name") return false
		throw error
	}
}

function git(cwd: string, args: readonly string[]): { stdout: string; stderr: string; exitCode: number } {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	return {
		stdout: new TextDecoder().decode(proc.stdout).trim(),
		stderr: new TextDecoder().decode(proc.stderr).trim(),
		exitCode: proc.exitCode,
	}
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
