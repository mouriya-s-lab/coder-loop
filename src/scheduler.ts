import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createWriteStream, existsSync, realpathSync, rmSync, type WriteStream } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

import {
	buildRenderBindings,
	buildRunnerInvocation,
	parseSessionIdFromRunnerStream,
	renderFragmentIndex,
	renderPrompt,
	resolvePresetBusinessKeyValues,
	selectRunnerForPhase,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type IssueKind,
	type JsonObject,
	type JsonValue,
	type Preset,
	type PresetPhase,
	type PhaseRunnerSelectionInput,
	type ResolveContext,
	type ResumeDecision,
	type RunnerInvocationPaths,
	type RuntimeBindings,
} from "./loop"
import {
	chainCompleteTriggerState,
	chainBindings as metadataBindings,
	chainMetadataToJsonObject,
	clearSchedulerBackoff as clearItemSchedulerBackoff,
	clearSchedulerSpawnError as clearItemSchedulerSpawnError,
	itemSchedulerBackoff,
	itemExtraToJsonObject,
	itemExtraWithoutKeys,
	parseInternalStatus,
	storedItemExtra,
	withChainCompleteTriggerState,
	withoutChainCompleteTriggerState,
	withSchedulerBackoff,
	withSchedulerSpawnError as withItemSchedulerSpawnError,
	type InternalStatus,
	type SchedulerBackoffState,
	type SchedulerSpawnError,
} from "./runtime-data"
import { detectsSessionIdInvalid } from "./runners/session-id"
import { type ChainRecord, dependsOnItemIds, type ItemRecord, listDependencyWaitReasons, type RunRecord, type SqliteStateStore } from "./sqlite-state"
import {
	LOOP_DATA_ROOT_ENV,
	type LoopDataRootOptions,
	RuntimePathError,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	sanitizeChainName,
} from "./runtime-paths"
import { collectObservabilityExcerpt, type ObservabilityExcerpt } from "./observability"

// Per-run nonce tag (#430): the summary tag is generated at spawn time, so no text that
// existed before the run — engine source, old transcripts, issue/PR bodies — can contain
// the close marker this run's watchdog matches. Cross-run diagnostics that don't hold a
// nonce match the `summary-<hex>` family pattern instead of any shared literal.
const SUMMARY_TAG_PREFIX = "summary-"
const SUMMARY_NONCE_BYTES = 8
const WATCHDOG_GRACE_MS = 10 * 60 * 1000
const WATCHDOG_KILL_MS = 5 * 1000
const ATTEMPT_TIMEOUT_MS = 60 * 60 * 1000
const ATTEMPT_KILL_MS = 5 * 1000

export function makeRunSummaryTag(): string {
	return `${SUMMARY_TAG_PREFIX}${randomBytes(SUMMARY_NONCE_BYTES).toString("hex")}`
}

export function summaryOpenMarker(tag: string): string {
	return `<${tag}>`
}

export function summaryCloseMarker(tag: string): string {
	return `</${tag}>`
}

function summaryInstructionFor(tag: string): string {
	const open = summaryOpenMarker(tag)
	const close = summaryCloseMarker(tag)
	return `\n\n当你完成所有工作后，用 ${open} 和 ${close} 包裹一段总结，描述你做了什么。\n例如：\n${open}\n- 修复了登录页的 bug\n- 添加了单元测试\n${close}`
}

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
	status: InternalStatus
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
	finalizingItemStatuses: Map<number, InternalStatus>
	finalizingChainIds: Set<number>
	pendingCloseHandlers: Set<Promise<unknown>>
}

export type SchedulerStore = Pick<
	SqliteStateStore,
	| "listChains"
	| "listItems"
	| "listRuns"
	| "getNextPendingItem"
	| "updateChain"
	| "getItem"
	| "updateItem"
	| "setItemSessionId"
	| "recordRun"
	| "getRunByRunId"
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
	loadedPreset: SchedulerLoadedPreset
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
	| { type: "item.dependency_wait"; chainId: number; itemId: number; dependsOn: readonly number[]; unsatisfied: readonly number[] }
	| { type: "item.backoff"; chainId: number; itemId: number; failureCount: number; nextRunAt: number }
	| { type: "agent.spawn"; slotKey: string; chainId: number; itemId: number; runId: string; phase: string; pid: number | null; worktreePath: string; presetDir: string }
	| { type: "agent.exit"; slotKey: string; chainId: number; itemId: number; runId: string; phase: string; exitCode: number; status: InternalStatus; excerpt: ObservabilityExcerpt }
	| { type: "session_id.invalidated"; ts: string; runId: string; chainId: number; itemId: number; phase: string; runner: AgentRunnerKind; previousSessionId: string | null; reason: "runner_session_id_invalid" }
	| { type: "spawn.aborted"; slotKey: string; chainId: number; chainName: string; itemId: number; issueNumber: number; reason: string; toStatus: InternalStatus }
	| { type: "chain.complete_trigger"; chainId: number; chainName: string; runId?: string; decision: SchedulerChainCompleteDecision["decision"]; reason?: string }
	| { type: "chain.complete_trigger_failed"; chainId: number; chainName: string; runId?: string; error: string }
	| { type: "chain.completed"; chainId: number; chainName: string; runId?: string }
	| { type: "phase.start"; ts: string; runId: string; chainId: number; itemId: number; repoCwd: string; phase: string; pid: number | null }
	| { type: "phase.end"; ts: string; runId: string; chainId: number; itemId: number; phase: string; exitCode: number; durationSeconds: number; status: InternalStatus }
	| { type: "attempt.timeout"; ts: string; runId: string; chainId: number; itemId: number; phase: string; signal: "SIGTERM" | "SIGKILL"; attemptMs: number; excerpt: ObservabilityExcerpt }
	| { type: "watchdog.armed"; ts: string; runId: string; chainId: number; itemId: number; phase: string; marker: string; graceMs: number }
	| { type: "watchdog.fire"; ts: string; runId: string; chainId: number; itemId: number; phase: string; signal: "SIGTERM" | "SIGKILL"; graceMs: number; excerpt: ObservabilityExcerpt }
	| { type: "queue.terminal"; ts: string; runId: string; chainId: number; itemId: number; terminalStatus: InternalStatus }
	| { type: "item.dependency_unblocked"; chainId: number; itemId: number; fromStatus: InternalStatus; toStatus: InternalStatus; dependsOn: readonly number[] }

export type SchedulerChainCompleteTriggerContext = {
	chain: ChainRecord
	items: readonly ItemRecord[]
	runId?: string
	terminalStatusNames: readonly InternalStatus[]
}

export type SchedulerChainCompleteDecision =
	| { decision: "complete"; reason?: string }
	| { decision: "keep-active"; reason?: string }

export type SchedulerChainCompleteTrigger = (context: SchedulerChainCompleteTriggerContext) => Promise<SchedulerChainCompleteDecision> | SchedulerChainCompleteDecision
export type SchedulerChainCompleteTriggerForChain = (context: SchedulerChainCompleteTriggerContext) => Promise<SchedulerChainCompleteDecision | null> | SchedulerChainCompleteDecision | null

export type SchedulerPhaseRunnerInput = {
	chain: ChainRecord
	item: ItemRecord
	phase: string
}

export type SchedulerPhaseRunner = (input: SchedulerPhaseRunnerInput) => AgentRunnerSelection | Promise<AgentRunnerSelection>

export type SchedulerPhaseRunnerSelectionResolver = (chain: ChainRecord) => PhaseRunnerSelectionInput | Promise<PhaseRunnerSelectionInput>

// #412: per-item phase runner selection. Mixed-preset chains need to resolve runner (preset,
// defaultRunner, reviewRunner, runnerCommands) against the item's own preset — not the chain
// seed — because the phase being spawned belongs to the item's preset's phase plan. If the
// caller wires `phaseRunnerSelectionForItem`, the scheduler prefers it over the chain-wide form.
// The chain-wide form is preserved for callers that only have a chain in hand (chain-complete
// trigger phase evaluation) and for single-preset compatibility.
export type SchedulerPhaseRunnerSelectionForItemResolver = (chain: ChainRecord, item: ItemRecord) => PhaseRunnerSelectionInput | Promise<PhaseRunnerSelectionInput>

export type SchedulerLoadedPreset = {
	presetDir: string
	preset: Preset
}

export type SchedulerPresetResolver = (chain: ChainRecord) => SchedulerLoadedPreset | Promise<SchedulerLoadedPreset>
// #412: per-item preset resolution. The scheduler reaches for this whenever it has an item in hand
// (spawn paths, review-on-empty using the representative item, status snapshots). Chain-wide checks
// without an item context (chain-complete trigger eval, vocabulary lookups for an empty chain) keep
// using `presetForChain`. Daemon supplies a default that delegates per-item when items carry the
// new preset/presetPath columns and falls back to chain-level otherwise.
export type SchedulerPresetItemResolver = (chain: ChainRecord, item: ItemRecord) => SchedulerLoadedPreset | Promise<SchedulerLoadedPreset>

export type SchedulerSpawnFailureBackoffConfig = {
	initialSeconds: number
	maxSeconds: number
}

export type SchedulerOptions = {
	store: SchedulerStore
	state: SchedulerState
	runner?: AgentRunnerSelection
	phaseRunner?: SchedulerPhaseRunner
	phaseRunnerSelectionForChain?: SchedulerPhaseRunnerSelectionResolver
	// #412: per-item phase runner resolver. When set, `resolvePhaseRunner` prefers it over
	// `phaseRunnerSelectionForChain` so mixed-preset chains pick the runner from the item's own
	// preset rather than the chain seed.
	phaseRunnerSelectionForItem?: SchedulerPhaseRunnerSelectionForItemResolver
	presetForChain: SchedulerPresetResolver
	// Optional per-item resolver — #412. If unset, the scheduler treats `presetForChain` as both
	// chain-wide and per-item, which preserves pre-#412 single-preset-per-chain behavior.
	presetForItem?: SchedulerPresetItemResolver
	phase?: string
	prompt:
		| string
		| ((context: SchedulerSpawnContext) => string | Promise<string>)
	worktreeManager?: SchedulerWorktreeManager
	loopDataRootOptions?: LoopDataRootOptions
	now?: () => number
	runIdFactory?: (context: { chain: ChainRecord; item: ItemRecord; phase: string }) => string
	maxItemAttempts?: number
	maxItemAttemptsForChain?: (chain: ChainRecord) => number
	spawnFailureBackoff?: SchedulerSpawnFailureBackoffConfig
	spawnFailureBackoffForChain?: (chain: ChainRecord) => SchedulerSpawnFailureBackoffConfig
	chainCompleteTrigger?: SchedulerChainCompleteTrigger
	chainCompleteTriggerForChain?: SchedulerChainCompleteTriggerForChain
	onEvent?: (event: SchedulerEvent) => void | Promise<void>
	attemptTimeoutMs?: number
	attemptKillMs?: number
	watchdogGraceMs?: number
	watchdogKillMs?: number
}

export type SchedulerChainStatuses = {
	pending: readonly InternalStatus[]
	terminal: readonly InternalStatus[]
	// success: subset of terminal that means an item succeeded. Drives cross-chain dependsOn
	// unblock — a terminal item is restored to `entry` only when all its dependsOn targets
	// reached a success-terminal status.
	success: readonly InternalStatus[]
	// entry: the actionable status a dependency-unblocked item is restored to.
	entry: InternalStatus
	// exhausted: the status the scheduler writes when the per-item attempts budget is spent
	// without a terminal verdict. #402 moved this from an engine literal to a required preset
	// declaration; load-time validation guarantees membership in `terminal`, so the scheduler
	// writes it without re-checking the vocabulary on each transition.
	exhausted: InternalStatus
}

export const DEFAULT_MAX_ITEM_ATTEMPTS = 20
const RUNNING_RUN_STATUS = parseInternalStatus("running", "scheduler.runningRunStatus")
const REVIEW_ON_EMPTY_STATUS = parseInternalStatus("review-on-empty", "scheduler.reviewOnEmptyStatus")

export type SchedulerTickResult = {
	spawnedRuns: SchedulerActiveRun[]
	completedChainIds: number[]
}

const DEFAULT_SPAWN_FAILURE_BACKOFF: SchedulerSpawnFailureBackoffConfig = { initialSeconds: 60, maxSeconds: 480 }
const REVIEW_ON_EMPTY_LOCK_FILENAME = "review-on-empty.lock"
const REVIEW_ON_EMPTY_LOCK_REASON = "chain-queue-drained"
const REVIEW_ON_EMPTY_FALLBACK_ITEM_ID = 0

let fallbackRunSequence = 0

export function createSchedulerState(): SchedulerState {
	return { slots: new Map(), finalizingItemStatuses: new Map(), finalizingChainIds: new Set(), pendingCloseHandlers: new Set() }
}

export function maxItemAttemptsFromChainMetadata(metadata: ChainRecord["metadata"]): number {
	const value = metadata.maxItemAttempts
	if (isPositiveInteger(value)) return value
	return DEFAULT_MAX_ITEM_ATTEMPTS
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
		let items = options.store.listItems(chain.id)
		// #412: an empty chain with no chain-level preset has nothing to drive — skip cleanly instead
		// of crashing chain-wide preset resolution. The chain becomes actionable as soon as the first
		// item (with its own preset) is added.
		if (items.length === 0 && chain.preset === null) continue
		const chainStatuses = await schedulerStatusesForChainWithItems(options, chain, items)
		const runs = options.store.listRuns(chain.id)
		const repoCwds = distinct(items.map((item) => item.repoCwd))
		const phasePlan = await resolvePhasePlanForChainWithItems(options, chain, items)

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

			items = await exhaustItemsOverAttemptLimitForRepo(options, chain, repoCwd, items, chainStatuses)
			const now = nowSeconds(options)
			await emitRepoWaitingDecisions(options, chain, repoCwd, items, chainStatuses, now)
			const next = selectNextItemAndPhase({
				repoCwd,
				items,
				runs,
				chainStatuses,
				phasePlan,
				explicitPhase: options.phase,
				now,
			})
			if (next === null) continue

			const activeRun = await spawnSchedulerRun(options, chain, next.item, slot, next.phase)
			if (activeRun !== null) spawnedRuns.push(activeRun)
		}

		// Restore dependency-unblocked terminal items AFTER selection so a freshly-unblocked item is
		// not also selected in the same tick — it becomes actionable now and is picked up on the next
		// tick. Running it before review-on-empty / completion keeps the chain from draining or
		// completing while an item has just become actionable again.
		items = await unblockDependencySatisfiedItems(options, chain, items, chainStatuses)

		if (shouldRunReviewOnEmpty(options, chain, items, chainStatuses.terminal)) {
			const reviewOnEmptyRun = await spawnSchedulerReviewOnEmptyRun(options, chain, items)
			if (reviewOnEmptyRun !== null) {
				spawnedRuns.push(reviewOnEmptyRun)
				continue
			}
		}

		if (await completeChainIfReady(options, chain, undefined, chainStatuses.terminal)) completedChainIds.push(chain.id)
	}

	return { spawnedRuns, completedChainIds }
}

type SchedulerItemTriggerPhase = {
	name: string
	afterPhase: string
	whenStatus: InternalStatus
}

type SchedulerPhasePlan = {
	firstPhase: string
	lastPhase: string
	nonTriggerPhases: readonly string[]
	itemTriggerPhases: readonly SchedulerItemTriggerPhase[]
}

// #412: phase plan resolution always flows from a representative item's preset. The earlier
// chain-only variant (`resolvePhasePlanForChain`) was removed once mixed-preset chains became
// legal — when chain.preset != items[0].preset, the chain-seed phase plan disagreed with the
// per-item preset load and rendered runs failed with `phase_not_found_in_preset`.
async function resolvePhasePlanForChainWithItems(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
): Promise<SchedulerPhasePlan> {
	if (options.phase !== undefined) return { firstPhase: options.phase, lastPhase: options.phase, nonTriggerPhases: [options.phase], itemTriggerPhases: [] }
	const { preset } = await schedulerLoadedPresetForChainItems(options, chain, items)
	return buildPhasePlanFromPreset(preset)
}

function buildPhasePlanFromPreset(preset: SchedulerLoadedPreset["preset"]): SchedulerPhasePlan {
	const nonTriggerPhases = preset.phases.flatMap((phase) => phase.trigger === null ? [phase.name] : [])
	const firstPhase = nonTriggerPhases[0]
	if (firstPhase === undefined) throw new Error(`preset ${preset.name} has no non-trigger phases`)
	const lastPhase = nonTriggerPhases[nonTriggerPhases.length - 1] ?? firstPhase
	const itemTriggerPhases = preset.phases.flatMap((phase): SchedulerItemTriggerPhase[] => {
		const trigger = phase.trigger
		if (trigger === null) return []
		if (!("afterPhase" in trigger)) return []
		return [{ name: phase.name, afterPhase: trigger.afterPhase, whenStatus: trigger.whenStatus }]
	})
	return { firstPhase, lastPhase, nonTriggerPhases, itemTriggerPhases }
}

type SelectNextItemAndPhaseInput = {
	repoCwd: string
	items: readonly ItemRecord[]
	runs: readonly RunRecord[]
	chainStatuses: SchedulerChainStatuses
	phasePlan: SchedulerPhasePlan
	explicitPhase: string | undefined
	now: number
}

function selectNextItemAndPhase(input: SelectNextItemAndPhaseInput): { item: ItemRecord; phase: string } | null {
	if (input.explicitPhase !== undefined) {
		const pending = selectNextPendingItemFromSnapshot({
			items: input.items,
			repoCwd: input.repoCwd,
			statuses: input.chainStatuses.pending,
			terminalStatuses: input.chainStatuses.terminal,
			now: input.now,
		})
		return pending === null ? null : { item: pending, phase: input.explicitPhase }
	}

	const repoItems = input.items.filter((item) => item.repoCwd === input.repoCwd)
	const runsById = new Map(input.runs.map((run) => [run.runId, run]))
	for (const triggerPhase of input.phasePlan.itemTriggerPhases) {
		const triggered = repoItems.find((item) =>
			item.phase === triggerPhase.afterPhase &&
			item.status === triggerPhase.whenStatus &&
			item.phase !== triggerPhase.name,
		)
		if (triggered !== undefined) return { item: triggered, phase: triggerPhase.name }
	}

	if (repoItems.some((item) => hasUnfinishedCurrentPhaseRun(item, runsById))) return null

	const phaseContinuation = repoItems
		.flatMap((item) => {
			const nextPhase = nextNonTriggerPhaseForItem({
				item,
				runsById,
				phasePlan: input.phasePlan,
				pendingStatuses: input.chainStatuses.pending,
				terminalStatuses: input.chainStatuses.terminal,
				now: input.now,
			})
			return nextPhase === null ? [] : [{ item, phase: nextPhase }]
		})
		.sort((left, right) => comparePendingItems(left.item, right.item))[0]
	if (phaseContinuation !== undefined) return phaseContinuation

	const pending = selectNextPendingItemFromSnapshot({
		items: input.items,
		repoCwd: input.repoCwd,
		statuses: input.chainStatuses.pending,
		terminalStatuses: input.chainStatuses.terminal,
		now: input.now,
	})
	return pending === null ? null : { item: pending, phase: input.phasePlan.firstPhase }
}

function nextNonTriggerPhaseForItem(input: {
	item: ItemRecord
	runsById: ReadonlyMap<string, RunRecord>
		phasePlan: SchedulerPhasePlan
		pendingStatuses: readonly InternalStatus[]
		terminalStatuses: readonly InternalStatus[]
		now: number
	}): string | null {
	if (!itemBackoffReady(input.item, input.now)) return null
	if (input.item.phase === null || input.item.lastRunId === null) return null
	if (input.terminalStatuses.includes(input.item.status)) return null
	const latestRun = input.runsById.get(input.item.lastRunId)
	if (latestRun === undefined) return null
	if (latestRun.itemId !== input.item.id) return null
	if (latestRun.phase !== input.item.phase) return null
	if (latestRun.endedAt === null) return null
	const currentPhaseIndex = input.phasePlan.nonTriggerPhases.indexOf(input.item.phase)
	if (currentPhaseIndex < 0) return null
	if (currentPhaseIndex === input.phasePlan.nonTriggerPhases.length - 1) {
		const startStatus = latestRun.extra.startStatus ?? null
		const startStatusUpdatedAt = typeof latestRun.extra.startStatusUpdatedAt === "number" ? latestRun.extra.startStatusUpdatedAt : null
		const statusWrittenAfterRunStart = startStatusUpdatedAt !== null
			&& input.item.statusUpdatedAt !== startStatusUpdatedAt
			&& input.item.statusUpdatedAt >= latestRun.startedAt
		if (startStatus === input.item.status && !statusWrittenAfterRunStart && input.pendingStatuses.includes(input.item.status)) return input.item.phase
	}
	if (latestRun.exitCode !== 0) return null
	return input.phasePlan.nonTriggerPhases[currentPhaseIndex + 1] ?? null
}

function hasUnfinishedCurrentPhaseRun(item: ItemRecord, runsById: ReadonlyMap<string, RunRecord>): boolean {
	if (item.phase === null || item.lastRunId === null) return false
	const latestRun = runsById.get(item.lastRunId)
	return latestRun !== undefined
		&& latestRun.itemId === item.id
		&& latestRun.phase === item.phase
		&& latestRun.endedAt === null
}

export type SchedulerPendingSelectionInput = {
	items: readonly ItemRecord[]
	repoCwd: string
	statuses: readonly InternalStatus[]
	terminalStatuses: readonly InternalStatus[]
	now: number
}

export function selectNextPendingItemFromSnapshot(input: SchedulerPendingSelectionInput): ItemRecord | null {
	const eligible = new Set(input.statuses)
	const waitsByItemId = new Set(
		listDependencyWaitReasons(input.items, {
			repoCwd: input.repoCwd,
			statuses: input.statuses,
			terminalStatusNames: input.terminalStatuses,
		}).map((wait) => wait.itemId),
	)
	return input.items
		.filter((item) => item.repoCwd === input.repoCwd)
		.filter((item) => eligible.has(item.status))
		.filter((item) => !waitsByItemId.has(item.id))
		.filter((item) => itemBackoffReady(item, input.now))
		.sort(comparePendingItems)
		[0] ?? null
}

async function emitRepoWaitingDecisions(
	options: SchedulerOptions,
	chain: ChainRecord,
	repoCwd: string,
	items: readonly ItemRecord[],
	chainStatuses: SchedulerChainStatuses,
	now: number,
): Promise<void> {
	for (const wait of listDependencyWaitReasons(items, {
		repoCwd,
		statuses: chainStatuses.pending,
		terminalStatusNames: chainStatuses.terminal,
		resolveDependency: (id) => options.store.getItem(id),
	})) {
		await emit(options, {
			type: "item.dependency_wait",
			chainId: chain.id,
			itemId: wait.itemId,
			dependsOn: wait.dependsOn,
			unsatisfied: wait.unsatisfied,
		})
	}
	const pending = new Set(chainStatuses.pending)
	for (const item of items) {
		if (item.repoCwd !== repoCwd || !pending.has(item.status)) continue
			const backoff = itemSchedulerBackoff(item.extra)
		if (backoff === null || backoff.nextRunAt <= now) continue
		await emit(options, {
			type: "item.backoff",
			chainId: chain.id,
			itemId: item.id,
			failureCount: backoff.failureCount,
			nextRunAt: backoff.nextRunAt,
		})
	}
}

function comparePendingItems(left: ItemRecord, right: ItemRecord): number {
	if (left.position !== right.position) return left.position - right.position
	return left.id - right.id
}

async function exhaustItemsOverAttemptLimitForRepo(
	options: SchedulerOptions,
	chain: ChainRecord,
	repoCwd: string,
	items: readonly ItemRecord[],
	chainStatuses: SchedulerChainStatuses,
): Promise<ItemRecord[]> {
	const maxItemAttempts = maxItemAttemptsForChain(options, chain)
	const terminalStatuses = new Set(chainStatuses.terminal)
	const pendingStatuses = new Set(chainStatuses.pending)
	// #402: exhausted落点 status now comes from the preset; loadPreset has already validated it
	// is a member of `statuses.terminal`, so the engine no longer guards against the preset
	// vocabulary missing it. No more engine-side terminal-set injection.
	const exhaustedStatus = chainStatuses.exhausted
	let changed = false
	for (const item of items) {
		if (item.repoCwd !== repoCwd) continue
		if (terminalStatuses.has(item.status)) continue
		if (!pendingStatuses.has(item.status)) continue
		if (item.attempts < maxItemAttempts) continue

		const exhaustedAt = nowSeconds(options)
			const extra = clearItemSchedulerBackoff(item.extra)
		options.store.updateItem(item.id, {
			status: exhaustedStatus,
			extra,
			updatedAt: exhaustedAt,
		})
		changed = true
		// #402 / #411: engine-driven transitions emit an audit-classified event under the unified
		// observability stream (daemon mapping in schedulerEventToObservabilityEvent: queue.terminal
		// → kind=audit, subject={kind:"engine"}). The transition source is implied by the run-id
		// shape returned by makeAttemptLimitRunId when no prior run was recorded.
		await emit(options, {
			type: "queue.terminal",
			ts: nowIso(options),
			runId: item.lastRunId ?? makeAttemptLimitRunId(chain, item, exhaustedAt),
			chainId: chain.id,
			itemId: item.id,
			terminalStatus: exhaustedStatus,
		})
	}
	return changed ? options.store.listItems(chain.id) : [...items]
}

function makeAttemptLimitRunId(chain: ChainRecord, item: ItemRecord, exhaustedAt: number): string {
	return `run-${exhaustedAt}-max-attempts-chain-${chain.id}-item-${item.id}`
}

export async function runSchedulerUntilIdle(options: SchedulerOptions, maxTicks = 100): Promise<SchedulerActiveRun[]> {
	const allSpawned: SchedulerActiveRun[] = []
	for (let tick = 0; tick < maxTicks; tick++) {
		const result = await schedulerTick(options)
		allSpawned.push(...result.spawnedRuns)
		const activeRuns = listActiveRuns(options.state)
		const pendingCloseHandlers = listPendingCloseHandlers(options.state)
		if (result.spawnedRuns.length === 0 && activeRuns.length === 0 && pendingCloseHandlers.length === 0) return allSpawned
		if (activeRuns.length > 0 || pendingCloseHandlers.length > 0) {
			await Promise.race([
				...activeRuns.map((run) => run.closed),
				...pendingCloseHandlers,
			])
		}
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
		if (gitWorktreeListIncludesPath(repoCwd, worktreePath)) {
			if (existsSync(worktreePath)) return worktreePath
			// Registered but the directory is gone (deleted loop-data root): clear the corpse
			// registration so the add below can recreate the worktree.
			git(repoCwd, ["worktree", "prune"])
		}

		const branchName = `coder-loop/${safeGitRefComponent(chain.name)}-${createHash("sha256").update(repoCwd).digest("hex").slice(0, 12)}`
		const startRef = chooseWorktreeStartRef(repoCwd, chain.baseBranch)
		let result = git(repoCwd, ["worktree", "add", "-B", branchName, worktreePath, startRef])
		if (result.exitCode !== 0 && removeStaleSlotBranchWorktree(repoCwd, result.stderr)) {
			result = git(repoCwd, ["worktree", "add", "-B", branchName, worktreePath, startRef])
		}
		if (result.exitCode !== 0) {
			throw new SchedulerError("worktree_create_failed", `failed to create scheduler worktree at ${worktreePath}: ${result.stderr}`)
		}
		return worktreePath
	}
}

// A daemon killed mid-run leaves its slot worktree checked out on the engine-owned
// `coder-loop/...` slot branch; git then refuses `worktree add -B` for that branch
// ("already used by worktree at <path>") from any future loop-data root, permanently
// wedging every later chain on the same repository. The slot branch name proves the
// conflicting worktree is engine-created scrap, so force-remove the stale registration
// and let the caller retry the add once.
function removeStaleSlotBranchWorktree(repoCwd: string, stderr: string): boolean {
	const match = stderr.match(/already used by worktree at '([^']+)'/)
	if (match === null) return false
	const removeResult = git(repoCwd, ["worktree", "remove", "--force", match[1]!])
	if (removeResult.exitCode !== 0) git(repoCwd, ["worktree", "prune"])
	return true
}

export type SchedulerChainWorktreeCleanup = {
	repoCwd: string
	worktreePath: string
	registered: boolean
	removed: boolean
	directoryRemoved: boolean
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
				directoryRemoved: false,
				pruned: false,
				error: `git worktree list failed (exit ${listResult.exitCode}): ${listResult.stderr}`,
			})
			continue
		}

		const registered = gitWorktreeListOutputIncludesPath(listResult.stdout, worktreePath)
		let removed = false
		let directoryRemoved = false
		let error: string | null = null
		if (registered && existsSync(worktreePath)) {
			const removeResult = git(repoCwd, ["worktree", "remove", "--force", worktreePath])
			removed = removeResult.exitCode === 0
			if (!removed) error = `git worktree remove failed (exit ${removeResult.exitCode}): ${removeResult.stderr}`
		}
		if ((removed || !registered) && existsSync(worktreePath)) {
			try {
				rmSync(worktreePath, { recursive: true, force: true })
				directoryRemoved = true
			} catch (cleanupError) {
				const directoryError = `worktree directory remove failed: ${errorMessage(cleanupError)}`
				error = error === null ? directoryError : `${error}; ${directoryError}`
			}
		}

		const pruneResult = git(repoCwd, ["worktree", "prune"])
		const pruned = pruneResult.exitCode === 0
		if (!pruned) {
			const pruneError = `git worktree prune failed (exit ${pruneResult.exitCode}): ${pruneResult.stderr}`
			error = error === null ? pruneError : `${error}; ${pruneError}`
		}

		cleaned.push({ repoCwd, worktreePath, registered, removed, directoryRemoved, pruned, error })
	}
	return cleaned
}

export function listActiveRuns(state: SchedulerState): SchedulerActiveRun[] {
	return [...state.slots.values()].flatMap((slot) => (slot.activeRun === null ? [] : [slot.activeRun]))
}

export function listPendingCloseHandlers(state: SchedulerState): Promise<unknown>[] {
	return [...state.pendingCloseHandlers]
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
	// #420 retired the engine's kind取值 mechanism: `gh issue view` is no longer spawned and
	// the resolver pipe is gone. The renderer's `issueKind` parameter is held over until #401
	// finishes retiring `runtime.issueKind` / `renderIssueKindDoc`; every spawn now passes the
	// empty-kind path (null → "") to the prompt renderer.
	const resolvedIssueKind: IssueKind = null

	const worktreeManager = options.worktreeManager ?? createGitWorktreeManager(options.loopDataRootOptions)
	let worktreePath: string
	try {
		worktreePath = slot.worktreePath ?? await worktreeManager({ chain, repoCwd: item.repoCwd, slotKey: slot.key })
	} catch (error) {
		// A worktree failure used to escape the tick entirely: no backoff, no item trace, only
		// a daemon stderr warning — the item sat actionable while the scheduler retried at tick
		// cadence forever. Contain it with a persisted backoff plus an extra record so
		// `status --json` shows why nothing spawns.
		const failedAt = nowSeconds(options)
		const message = errorMessage(error)
		options.store.updateItem(item.id, {
			extra: withSchedulerSpawnError(
					withNextSchedulerBackoff(item.extra, failedAt, spawnFailureBackoffForChain(options, chain)),
				failedAt,
				phase,
				message,
			),
			updatedAt: failedAt,
		})
		console.warn(`coder-loop scheduler: worktree create failed for chain=${chain.name} item=${item.id} issue=#${item.issueNumber}: ${message}`)
		await emit(options, {
			type: "spawn.aborted",
			slotKey: slot.key,
			chainId: chain.id,
			chainName: chain.name,
			itemId: item.id,
			issueNumber: item.issueNumber,
			reason: message,
			toStatus: item.status,
		})
		return null
	}
	slot.worktreePath = worktreePath

	const runner = await resolvePhaseRunner(options, { chain, item, phase })
	const runId = options.runIdFactory?.({ chain, item, phase }) ?? makeRunId(item.id, phase)
	const startedAt = nowSeconds(options)
		options.store.recordRun({
		runId,
		chainId: chain.id,
		itemId: item.id,
		phase,
		status: RUNNING_RUN_STATUS,
		startedAt,
			extra: storedItemExtra({
				slotKey: slot.key,
				repoCwd: item.repoCwd,
				worktreePath,
				startStatus: item.status,
				startStatusUpdatedAt: item.statusUpdatedAt,
				...(item.phase === null ? {} : { startPhase: item.phase }),
			}),
		})
	options.store.setCurrentRun({
		chainId: chain.id,
		phase,
		runId,
		startedAt,
		extra: storedItemExtra({ slotKey: slot.key, itemId: item.id, repoCwd: item.repoCwd }),
	})
	const spawnUpdate: Parameters<typeof options.store.updateItem>[1] = {
		attempts: item.attempts + 1,
		lastRunId: runId,
		agentCwd: worktreePath,
		phase,
		updatedAt: startedAt,
	}
		const extraWithoutSpawnError = clearItemSchedulerSpawnError(item.extra)
	if (extraWithoutSpawnError !== item.extra) spawnUpdate.extra = extraWithoutSpawnError
	// Spawn records only run/phase metadata. The agent owns status writes; trigger phases on terminal
	// items therefore keep their terminal status, and normal phases keep their entry status until the
	// agent writes a new one.
	options.store.updateItem(item.id, spawnUpdate)

	// #412: spawn resolves the item's own preset rather than the chain's default seed so multi-preset
	// chains render the right phase prompts. `schedulerLoadedPresetForItem` falls back to chain-level
	// resolution when the caller hasn't wired `presetForItem` (preserves single-preset behavior).
	const loadedPreset = await schedulerLoadedPresetForItem(options, chain, item)
	const presetDir = loadedPreset.presetDir
	const context: SchedulerSpawnContext = { chain, item, slot, runId, worktreePath, presetDir, loadedPreset, phase }
	const rawPrompt = typeof options.prompt === "string" ? options.prompt : await options.prompt(context)
	const resumeDecision = resumeDecisionForItem(item, phase, runner.kind)
	const renderedPrompt = await renderSchedulerSpawnPrompt({
		rawPrompt,
		preset: loadedPreset.preset,
		phase,
		chain,
		item,
		runId,
		worktreePath,
		issueKind: resolvedIssueKind,
		loopDataRootOptions: options.loopDataRootOptions,
		resume: resumeDecision,
		runner: runner.kind,
	})
	const summaryTag = makeRunSummaryTag()
	const finalPrompt = renderedPrompt + summaryInstructionFor(summaryTag)
	const runnerPlan = buildRunnerInvocation(
		runner,
		finalPrompt,
		resumeDecision,
		invocationPaths(item.repoCwd, worktreePath, presetDir, resolveLoopDataPaths(options.loopDataRootOptions).root),
	)
	await initializeSchedulerRunArtifacts(options, chain, item, runId, phase, startedAt, worktreePath)
	const child = spawn(runnerPlan.binary, runnerPlan.args, {
		cwd: worktreePath,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		// The agent writes its own item status via `coder-loop item update`, which must reach
		// the daemon that owns this loop-data-root. Pass it through so the CLI resolves the same store.
		env: { ...process.env, [LOOP_DATA_ROOT_ENV]: resolveLoopDataPaths(options.loopDataRootOptions).root },
	})
	const activeRun = attachRunCloseHandler(options, chain, item, slot, runId, worktreePath, startedAt, phase, child, runner, summaryTag)
	slot.activeRun = activeRun
	options.store.setCurrentRun({
		chainId: chain.id,
		phase,
		runId,
		startedAt,
			extra: storedItemExtra({
				slotKey: slot.key,
				itemId: item.id,
				repoCwd: item.repoCwd,
				worktreePath,
				...(activeRun.pid === null ? {} : { pid: activeRun.pid }),
				processGroupLeader: true,
			}),
	})
	await writeSchedulerRunStatus(options, {
		runId,
		chain,
		item,
		phase,
		startedAt,
		endedAt: null,
		exitCode: null,
		status: RUNNING_RUN_STATUS,
		pid: activeRun.pid,
		worktreePath,
		stdoutBytes: 0,
		stderrBytes: 0,
	})
	await emit(options, {
		type: "agent.spawn",
		slotKey: slot.key,
		chainId: chain.id,
		itemId: item.id,
		runId,
		phase,
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
	summaryTag: string,
): SchedulerActiveRun {
	const stdout: Buffer[] = []
	const stderr: Buffer[] = []
	const outputPaths = schedulerPhaseOutputPaths(options, chain, runId, phase)
	const outputWriters = createSchedulerPhaseOutputWriters(outputPaths)
	let lifecycleGc: SchedulerRunLifecycleGc | null = null
	let terminatorCleanup: (() => void) | null = null

	const closed = new Promise<SchedulerCompletedRun>((resolveClosed, rejectClosed) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.push(chunk)
			outputWriters.stdout.write(chunk)
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk)
			outputWriters.stderr.write(chunk)
		})
		child.on("error", (error) => {
			const chunk = Buffer.from(error.message)
			stderr.push(chunk)
			outputWriters.stderr.write(chunk)
		})

		const installedGc = installSchedulerRunLifecycleGc(options, child, summaryTag, {
			chain,
			item,
			runId,
			phase,
			stdoutPath: outputPaths.stdoutPath,
			stderrPath: outputPaths.stderrPath,
		})
		lifecycleGc = installedGc
		terminatorCleanup = installedGc.terminatorCleanup

		child.on("close", (code) => {
			lifecycleGc?.cleanup()

			const pendingCloseHandler = (async (): Promise<SchedulerCompletedRun> => {
				const exitCode = code ?? 1
				const stdoutText = Buffer.concat(stdout).toString("utf-8")
				const stderrText = Buffer.concat(stderr).toString("utf-8")
				const terminalStatuses = new Set((await schedulerStatusesForChain(options, chain)).terminal)
				const currentItem = options.store.getItem(item.id)
				const status = (currentItem ?? item).status
				const endedAt = nowSeconds(options)
				const itemTransitionedToTerminal = !terminalStatuses.has(item.status) && terminalStatuses.has(status)
				options.state.finalizingItemStatuses.set(item.id, status)
				try {
					await closeSchedulerPhaseOutputWriters(outputWriters)
					const summary = extractSummaryValue(stdoutText, summaryTag)
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
					const completedRun = options.store.getRunByRunId(runId)
					options.store.completeRun(runId, {
						endedAt,
						exitCode,
						status,
						extra: storedItemExtra({
							...(completedRun === null ? {} : itemExtraToJsonObject(completedRun.extra)),
							stdoutBytes: stdoutText.length,
							stderrBytes: stderrText.length,
							...(summary !== null ? { summary } : {}),
						}),
					})

					const currentRun = options.store.getCurrentRun(chain.id)
					if (currentRun?.runId === runId) options.store.clearCurrentRun(chain.id)

					if (slot.activeRun?.runId === runId) slot.activeRun = null
					const excerpt = await collectObservabilityExcerpt({
						stdoutPath: outputPaths.stdoutPath,
						stderrPath: outputPaths.stderrPath,
					})
					await emit(options, { type: "agent.exit", slotKey: slot.key, chainId: chain.id, itemId: item.id, runId, phase, exitCode, status, excerpt })
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
					const parsedSessionId = parseSessionIdFromRunnerStream(runner.kind, stdoutText)
					const sessionIdInvalid = detectsSessionIdInvalid(runner.kind, stderrText)
					const previousSessionId = (currentItem ?? item).sessionIds[phase]?.[runner.kind] ?? null
					if (currentItem === null || !terminalStatuses.has(currentItem.status)) {
						const itemForBackoff = currentItem ?? item
						const statusWasWrittenDuringRun = currentItem !== null && currentItem.statusUpdatedAt !== item.statusUpdatedAt && currentItem.statusUpdatedAt >= startedAt
						const update: Parameters<typeof options.store.updateItem>[1] = {
							...(statusWasWrittenDuringRun ? { status } : {}),
							lastRunId: runId,
							agentCwd: worktreePath,
							extra: extraAfterRunCompletion(options, chain, itemForBackoff, exitCode, status, terminalStatuses, endedAt),
							updatedAt: endedAt,
						}
						options.store.updateItem(item.id, update)
					}
					if (sessionIdInvalid) {
						options.store.setItemSessionId(item.id, { phase, runner: runner.kind, sessionId: null, updatedAt: endedAt })
						await emit(options, {
							type: "session_id.invalidated",
							ts: nowIso(options),
							runId,
							chainId: chain.id,
							itemId: item.id,
							phase,
							runner: runner.kind,
							previousSessionId,
							reason: "runner_session_id_invalid",
						})
					} else if (parsedSessionId !== null) {
						options.store.setItemSessionId(item.id, { phase, runner: runner.kind, sessionId: parsedSessionId, updatedAt: endedAt })
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
			return { runId, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, exitCode, stdout: stdoutText, stderr: stderrText, status }
				} catch (error) {
					if (slot.activeRun?.runId === runId) slot.activeRun = null
					throw error
				} finally {
					options.state.finalizingItemStatuses.delete(item.id)
				}
			})()
			options.state.pendingCloseHandlers.add(pendingCloseHandler)
			void pendingCloseHandler
				.then(resolveClosed, rejectClosed)
				.finally(() => {
					options.state.pendingCloseHandlers.delete(pendingCloseHandler)
				})
				.catch(() => undefined)
		})
	})
	const terminate = createRunTerminator(child, closed, terminatorCleanup)
	return { runId, pid: child.pid ?? null, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, worktreePath, startedAt, closed, terminate }
}

type SchedulerPhaseOutputPaths = {
	stdoutPath: string
	stderrPath: string
}

type SchedulerPhaseOutputWriters = {
	stdout: WriteStream
	stderr: WriteStream
}

function schedulerPhaseOutputPaths(
	options: SchedulerOptions,
	chain: ChainRecord,
	runId: string,
	phase: string,
): SchedulerPhaseOutputPaths {
	const paths = resolveChainRuntimePaths(chain.name, options.loopDataRootOptions)
	return {
		stdoutPath: paths.runPhaseStdoutFile(runId, phase),
		stderrPath: paths.runPhaseStderrFile(runId, phase),
	}
}

function createSchedulerPhaseOutputWriters(paths: SchedulerPhaseOutputPaths): SchedulerPhaseOutputWriters {
	return {
		stdout: createWriteStream(paths.stdoutPath, { flags: "a" }),
		stderr: createWriteStream(paths.stderrPath, { flags: "a" }),
	}
}

async function closeSchedulerPhaseOutputWriters(writers: SchedulerPhaseOutputWriters): Promise<void> {
	await Promise.all([
		closeWriteStream(writers.stdout),
		closeWriteStream(writers.stderr),
	])
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
	if (stream.destroyed || stream.closed) return
	await new Promise<void>((resolveClosed, rejectClosed) => {
		const onError = (error: Error): void => {
			stream.off("error", onError)
			rejectClosed(error)
		}
		stream.once("error", onError)
		stream.end(() => {
			stream.off("error", onError)
			resolveClosed()
		})
	})
}

export function extractSummaryValue(stdoutText: string, summaryTag: string): string | null {
	const open = summaryOpenMarker(summaryTag)
	const start = stdoutText.lastIndexOf(open)
	if (start === -1) return null
	const contentStart = start + open.length
	const end = stdoutText.indexOf(summaryCloseMarker(summaryTag), contentStart)
	if (end === -1) return null
	return stdoutText.slice(contentStart, end).trim()
}

function combineCleanup(existing: (() => void) | null, next: () => void): () => void {
	return () => {
		if (existing !== null) existing()
		next()
	}
}

type SchedulerRunLifecycleGc = {
	cleanup: () => void
	terminatorCleanup: (() => void) | null
}

function installSchedulerRunLifecycleGc(
	options: SchedulerOptions,
	child: ReturnType<typeof spawn>,
	summaryTag: string,
	context: {
		chain: ChainRecord
		item: ItemRecord
		runId: string
		phase: string
		stdoutPath: string
		stderrPath: string
	},
): SchedulerRunLifecycleGc {
	const summaryClose = summaryCloseMarker(summaryTag)
	const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS
	const attemptKillMs = options.attemptKillMs ?? ATTEMPT_KILL_MS
	const watchdogGraceMs = options.watchdogGraceMs ?? WATCHDOG_GRACE_MS
	const watchdogKillMs = options.watchdogKillMs ?? WATCHDOG_KILL_MS
	let lifecycleCleanup: (() => void) | null = null
	const addLifecycleCleanup = (cleanup: () => void): void => {
		lifecycleCleanup = combineCleanup(lifecycleCleanup, cleanup)
	}

	// Attempt timeout
	let attemptTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		attemptTimer = null
		if (child.exitCode !== null || child.signalCode !== null) return
		void emitSchedulerTimeoutEvent(options, context, "SIGTERM", attemptTimeoutMs).catch(() => undefined)
		sendSignalToChildProcessGroup(child, "SIGTERM")
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				void emitSchedulerTimeoutEvent(options, context, "SIGKILL", attemptTimeoutMs).catch(() => undefined)
				sendSignalToChildProcessGroup(child, "SIGKILL")
			}
		}, attemptKillMs)
		addLifecycleCleanup(() => clearTimeout(killTimer))
	}, attemptTimeoutMs)

	// Summary watchdog: observe accumulated stdout for this run's nonce close marker
	let watchdogArmed = false
	let watchdogAccumulated = ""
	let watchdogGraceTimer: ReturnType<typeof setTimeout> | null = null
	child.stdout?.on("data", (chunk: Buffer) => {
		if (watchdogArmed) return
		watchdogAccumulated += chunk.toString("utf-8")
		if (watchdogAccumulated.includes(summaryClose)) {
			watchdogArmed = true
			if (attemptTimer !== null) { clearTimeout(attemptTimer); attemptTimer = null }
			void emit(options, {
				type: "watchdog.armed",
				ts: nowIso(options),
				runId: context.runId,
				chainId: context.chain.id,
				itemId: context.item.id,
				phase: context.phase,
				marker: summaryClose,
				graceMs: watchdogGraceMs,
			}).catch(() => undefined)
			watchdogGraceTimer = setTimeout(() => {
				watchdogGraceTimer = null
				if (child.exitCode !== null || child.signalCode !== null) return
				void emitSchedulerWatchdogFireEvent(options, context, "SIGTERM", watchdogGraceMs).catch(() => undefined)
				sendSignalToChildProcessGroup(child, "SIGTERM")
				const killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						void emitSchedulerWatchdogFireEvent(options, context, "SIGKILL", watchdogGraceMs).catch(() => undefined)
						sendSignalToChildProcessGroup(child, "SIGKILL")
					}
				}, watchdogKillMs)
				addLifecycleCleanup(() => clearTimeout(killTimer))
			}, watchdogGraceMs)
			addLifecycleCleanup(() => { if (watchdogGraceTimer !== null) { clearTimeout(watchdogGraceTimer); watchdogGraceTimer = null } })
		}
	})

	addLifecycleCleanup(() => { if (attemptTimer !== null) { clearTimeout(attemptTimer); attemptTimer = null } })

	const cleanup = (): void => {
		if (lifecycleCleanup !== null) { lifecycleCleanup(); lifecycleCleanup = null }
	}
	return { cleanup, terminatorCleanup: lifecycleCleanup }
}

async function emitSchedulerTimeoutEvent(
	options: SchedulerOptions,
	context: {
		chain: ChainRecord
		item: ItemRecord
		runId: string
		phase: string
		stdoutPath: string
		stderrPath: string
	},
	signal: "SIGTERM" | "SIGKILL",
	attemptMs: number,
): Promise<void> {
	await emit(options, {
		type: "attempt.timeout",
		ts: nowIso(options),
		runId: context.runId,
		chainId: context.chain.id,
		itemId: context.item.id,
		phase: context.phase,
		signal,
		attemptMs,
		excerpt: await collectObservabilityExcerpt({
			stdoutPath: context.stdoutPath,
			stderrPath: context.stderrPath,
		}),
	})
}

async function emitSchedulerWatchdogFireEvent(
	options: SchedulerOptions,
	context: {
		chain: ChainRecord
		item: ItemRecord
		runId: string
		phase: string
		stdoutPath: string
		stderrPath: string
	},
	signal: "SIGTERM" | "SIGKILL",
	graceMs: number,
): Promise<void> {
	await emit(options, {
		type: "watchdog.fire",
		ts: nowIso(options),
		runId: context.runId,
		chainId: context.chain.id,
		itemId: context.item.id,
		phase: context.phase,
		signal,
		graceMs,
		excerpt: await collectObservabilityExcerpt({
			stdoutPath: context.stdoutPath,
			stderrPath: context.stderrPath,
		}),
	})
}

function createRunTerminator(
	child: ReturnType<typeof spawn>,
	closed: Promise<SchedulerCompletedRun>,
	cleanup?: (() => void) | null,
): (options?: SchedulerRunTerminateOptions) => Promise<SchedulerCompletedRun> {
	let requested = false
	return async (options = {}) => {
		if (!requested && child.exitCode === null && child.signalCode === null) {
			requested = true
			if (cleanup !== null && cleanup !== undefined) cleanup()
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

// Engine-level cross-chain unblock: a terminal item carrying a dependsOn record is restored to
// the chain's `entry` status once ALL its dependsOn targets reached a success-terminal status.
// dependsOn targets may live in another chain (item ids are globally unique), so they are
// resolved through the store rather than the per-chain snapshot. Targets that are missing
// (dangling) or in a non-success terminal status (e.g. exhausted/moot) do NOT unblock the item.
async function unblockDependencySatisfiedItems(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: ItemRecord[],
	chainStatuses: SchedulerChainStatuses,
): Promise<ItemRecord[]> {
	const success = new Set(chainStatuses.success)
	if (success.size === 0) return items
	const terminal = new Set(chainStatuses.terminal)
	let changed = false
	for (const item of items) {
		if (!terminal.has(item.status)) continue
		const dependsOn = dependsOnItemIds(item.extra)
		if (dependsOn.length === 0) continue
		const allSuccess = dependsOn.every((id) => {
			const target = options.store.getItem(id)
			return target !== null && success.has(target.status)
		})
		if (!allSuccess) continue
		// Clear the now-satisfied dependsOn record. The snapshot selection path
		// (selectNextPendingItemFromSnapshot) resolves deps only within the per-chain snapshot, so
		// leaving a cross-chain dependsOn on the restored item would re-gate it and it would never
		// be selected into iteration. The dependency is fulfilled, so the record has served its job.
		const nextExtra = itemExtraWithoutKeys(item.extra, ["dependsOn"])
		options.store.updateItem(item.id, { status: chainStatuses.entry, extra: nextExtra, updatedAt: nowSeconds(options) })
		await emit(options, {
			type: "item.dependency_unblocked",
			chainId: chain.id,
			itemId: item.id,
			fromStatus: item.status,
			toStatus: chainStatuses.entry,
			dependsOn,
		})
		changed = true
	}
	return changed ? options.store.listItems(chain.id) : items
}

// True when some item in the chain still has a dependsOn target that exists and is not yet
// terminal — i.e. an in-flight dependency that could still resolve to success and unblock the
// item. Used to keep the chain active so the daemon keeps ticking until the dependency settles.
// Dangling (missing) targets do not count: they can never resolve, so they must not pin the
// chain open forever.
function hasInflightDependency(options: SchedulerOptions, items: readonly ItemRecord[], terminalStatuses: readonly InternalStatus[]): boolean {
	const terminal = new Set(terminalStatuses)
	return items.some((item) =>
		dependsOnItemIds(item.extra).some((id) => {
			const target = options.store.getItem(id)
			return target !== null && !terminal.has(target.status)
		})
	)
}

async function completeChainIfReady(options: SchedulerOptions, chain: ChainRecord, runId?: string, terminalStatuses?: readonly InternalStatus[]): Promise<boolean> {
	if (hasActiveSlotForChain(options.state, chain.id, runId)) return false
	const effectiveTerminalStatuses = terminalStatuses ?? (await schedulerStatusesForChain(options, chain)).terminal
	const current = options.store.listChains().find((candidate) => candidate.id === chain.id)
	if (current?.status !== "active") return false
	const items = options.store.listItems(chain.id)
	if (items.length === 0) return false
	if (runId === undefined && hasFinalizingItemForChain(options.state, items)) return false
	if (hasInflightDependency(options, items, effectiveTerminalStatuses)) return false
	if (!allItemsTerminalIncludingFinalizing(options, chain.id, effectiveTerminalStatuses)) return false
	if (options.state.finalizingChainIds.has(chain.id)) return false
	if (!reviewOnEmptyLockExistsForChain(chain, options.loopDataRootOptions)) return false
	options.state.finalizingChainIds.add(chain.id)
	try {
		// #412 mixed-preset chain: phase plan must come from a representative item's preset (matching
		// the tick loop at L326), not the chain's seed. Without this, `hasPendingItemLevelTrigger` reads
		// item-trigger phases from the wrong preset and either gates completion incorrectly or misses a
		// pending trigger phase from the real preset.
		const phasePlan = await resolvePhasePlanForChainWithItems(options, chain, items)
		if (hasPendingItemLevelTrigger(options, chain.id, phasePlan)) return false
		if (!await chainCompletionTriggerAllowsCompletion(options, current, runId, effectiveTerminalStatuses)) return false
		const refreshed = options.store.listChains().find((candidate) => candidate.id === chain.id)
		if (refreshed?.status !== "active") return false
		const completionItems = options.store.listItems(chain.id)
		if (completionItems.length === 0) return false
		if (!allItemsTerminalIncludingFinalizing(options, chain.id, effectiveTerminalStatuses)) return false
		const updated = options.store.updateChain(chain.id, { status: "completed", updatedAt: nowSeconds(options) })
		await emit(options, { type: "chain.completed", chainId: current.id, chainName: current.name, ...(runId === undefined ? {} : { runId }) })
		cleanupSchedulerChainWorktrees(updated, completionItems.map((item) => item.repoCwd), options.loopDataRootOptions)
		return true
	} finally {
		options.state.finalizingChainIds.delete(chain.id)
	}
}

async function chainCompletionTriggerAllowsCompletion(options: SchedulerOptions, chain: ChainRecord, runId: string | undefined, terminalStatuses: readonly InternalStatus[]): Promise<boolean> {
	try {
		const items = listItemsIncludingFinalizing(options, chain.id)
		const fingerprint = chainCompletionFingerprint(chain, items, terminalStatuses)
		if (keepActiveTriggerStateApplies(chain, fingerprint)) return false

		const context: SchedulerChainCompleteTriggerContext = {
			chain,
			items,
			...(runId === undefined ? {} : { runId }),
			terminalStatusNames: terminalStatuses,
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
	const state = chainCompleteTriggerState(chain.metadata)
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
	const state: { decision: "keep-active"; fingerprint: string; recordedAt: number; reason?: string; runId?: string } = {
		decision: decision.decision,
		fingerprint,
		recordedAt,
	}
	if (decision.reason !== undefined) state.reason = decision.reason
	if (runId !== undefined) state.runId = runId
	options.store.updateChain(chain.id, {
		metadata: withChainCompleteTriggerState(chain.metadata, state),
		updatedAt: recordedAt,
	})
}

function chainCompletionFingerprint(chain: ChainRecord, items: readonly ItemRecord[], terminalStatuses: readonly InternalStatus[]): string {
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
				sessionIds: item.sessionIds,
				issueFile: item.issueFile,
				evidenceDir: item.evidenceDir,
				agentCwd: item.agentCwd,
				runner: item.runner,
				phase: item.phase,
				extra: itemExtraToJsonObject(item.extra),
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			}))
			.sort((a, b) => a.id - b.id),
	}
	return createHash("sha256").update(stableJsonStringify(payload)).digest("hex")
}

function chainMetadataForFingerprint(metadata: ChainRecord["metadata"]): JsonObject {
	return chainMetadataToJsonObject(withoutChainCompleteTriggerState(metadata))
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
	const { preset } = await schedulerLoadedPreset(options, chain)
	return statusesFromPreset(preset)
}

// #412 variant that prefers the representative item's preset over the chain's legacy default seed.
async function schedulerStatusesForChainWithItems(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
): Promise<SchedulerChainStatuses> {
	const { preset } = await schedulerLoadedPresetForChainItems(options, chain, items)
	return statusesFromPreset(preset)
}

function statusesFromPreset(preset: SchedulerLoadedPreset["preset"]): SchedulerChainStatuses {
	return {
		pending: preset.statuses.continuable,
		terminal: preset.statuses.terminal,
		success: preset.statuses.success,
		entry: preset.statuses.entry,
		// #402: exhausted落点 flows from the preset declaration. Membership in `terminal` is
		// load-time-checked, so consumers can use this value directly as a write target.
		exhausted: preset.statuses.exhausted,
	}
}

function maxItemAttemptsForChain(options: SchedulerOptions, chain: ChainRecord): number {
	const configured = options.maxItemAttemptsForChain?.(chain) ?? options.maxItemAttempts ?? maxItemAttemptsFromChainMetadata(chain.metadata)
	return isPositiveInteger(configured) ? configured : DEFAULT_MAX_ITEM_ATTEMPTS
}

function spawnFailureBackoffForChain(options: SchedulerOptions, chain: ChainRecord): SchedulerSpawnFailureBackoffConfig {
	const configured = options.spawnFailureBackoffForChain?.(chain) ?? options.spawnFailureBackoff ?? DEFAULT_SPAWN_FAILURE_BACKOFF
	return normalizeBackoffConfig(configured)
}

function normalizeBackoffConfig(config: SchedulerSpawnFailureBackoffConfig): SchedulerSpawnFailureBackoffConfig {
	const initialSeconds = isPositiveInteger(config.initialSeconds) ? config.initialSeconds : DEFAULT_SPAWN_FAILURE_BACKOFF.initialSeconds
	const maxSeconds = isPositiveInteger(config.maxSeconds) ? config.maxSeconds : DEFAULT_SPAWN_FAILURE_BACKOFF.maxSeconds
	return { initialSeconds, maxSeconds: Math.max(initialSeconds, maxSeconds) }
}

function extraAfterRunCompletion(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	exitCode: number,
	status: InternalStatus,
	terminalStatuses: ReadonlySet<InternalStatus>,
	endedAt: number,
): ItemRecord["extra"] {
	if (exitCode !== 0 && !terminalStatuses.has(status)) {
		return withNextSchedulerBackoff(item.extra, endedAt, spawnFailureBackoffForChain(options, chain))
	}
	return clearItemSchedulerBackoff(item.extra)
}

function itemBackoffReady(item: ItemRecord, now: number): boolean {
	const backoff = itemSchedulerBackoff(item.extra)
	return backoff === null || backoff.nextRunAt <= now
}

function withNextSchedulerBackoff(
	extra: ItemRecord["extra"],
	endedAt: number,
	config: SchedulerSpawnFailureBackoffConfig,
): ItemRecord["extra"] {
	const current = itemSchedulerBackoff(extra)
	const failureCount = (current?.failureCount ?? 0) + 1
	const exponent = Math.min(failureCount - 1, 30)
	const delaySeconds = Math.min(config.maxSeconds, config.initialSeconds * (2 ** exponent))
	const state: SchedulerBackoffState = {
		failureCount,
		nextRunAt: endedAt + delaySeconds,
	}
	return withSchedulerBackoff(extra, state)
}

function withSchedulerSpawnError(extra: ItemRecord["extra"], failedAt: number, phase: string, message: string): ItemRecord["extra"] {
	const error: SchedulerSpawnError = { at: failedAt, phase, message }
	return withItemSchedulerSpawnError(extra, error)
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function allItemsTerminalIncludingFinalizing(options: SchedulerOptions, chainId: number, terminalStatuses: readonly InternalStatus[]): boolean {
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

function hasActiveSlotForChain(state: SchedulerState, chainId: number, ignoreRunId?: string): boolean {
	return [...state.slots.values()].some((slot) =>
		slot.chainId === chainId
		&& slot.activeRun !== null
		&& slot.activeRun.runId !== ignoreRunId,
	)
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

export function makeRunId(itemId: number, phase?: string): string {
	const phaseSegment = phase === undefined ? "" : `-${sanitizeRunIdPhaseSegment(phase)}`
	return `run-${Date.now()}-${++fallbackRunSequence}${phaseSegment}-item-${itemId}`
}

function sanitizeRunIdPhaseSegment(phase: string): string {
	const replaced = phase.replace(/[^A-Za-z0-9._-]/g, "-")
	return replaced === "" ? "phase" : replaced
}

function makeReviewOnEmptyRunId(chain: ChainRecord): string {
	return `run-${Date.now()}-${++fallbackRunSequence}-chain-${chain.id}-review-on-empty`
}

export function reviewOnEmptyLockPathForChainName(chainName: string, options: LoopDataRootOptions | undefined): string {
	const chainPaths = resolveChainRuntimePaths(chainName, options ?? {})
	return resolve(chainPaths.chainRoot, REVIEW_ON_EMPTY_LOCK_FILENAME)
}

export function reviewOnEmptyLockPathForChain(chain: ChainRecord, options: LoopDataRootOptions | undefined): string {
	return reviewOnEmptyLockPathForChainName(chain.name, options)
}

function reviewOnEmptyLockExistsForChain(chain: ChainRecord, options: LoopDataRootOptions | undefined): boolean {
	return existsSync(reviewOnEmptyLockPathForChain(chain, options))
}

export function serializeSchedulerReviewOnEmptyLock(runId: string, acquiredAt: Date): string {
	return `${JSON.stringify({ acquiredAt: acquiredAt.toISOString(), runId, reason: REVIEW_ON_EMPTY_LOCK_REASON }, null, "\t")}\n`
}

function shouldRunReviewOnEmpty(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
	terminalStatuses: readonly InternalStatus[],
): boolean {
	if (items.length === 0) return false
	if (hasActiveSlotForChain(options.state, chain.id)) return false
	if (!allItemsTerminalIncludingFinalizing(options, chain.id, terminalStatuses)) return false
	if (options.state.finalizingChainIds.has(chain.id)) return false
	if (reviewOnEmptyLockExistsForChain(chain, options.loopDataRootOptions)) return false
	return true
}

function pickReviewOnEmptyRepresentativeItem(items: readonly ItemRecord[]): ItemRecord {
	const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
	const first = sorted[0]
	if (first === undefined) throw new Error("scheduler: review-on-empty representative item requested from empty queue")
	return first
}

function makeReviewOnEmptyFallbackItem(chain: ChainRecord, representative: ItemRecord, reviewPhase: string): ItemRecord {
	return {
		id: REVIEW_ON_EMPTY_FALLBACK_ITEM_ID,
		chainId: chain.id,
		issueNumber: 0,
		repoCwd: representative.repoCwd,
		status: REVIEW_ON_EMPTY_STATUS,
		attempts: 0,
		position: 0,
		title: null,
		priority: null,
		branch: null,
		pr: null,
		lastRunId: null,
		sessionIds: {},
		issueFile: null,
		evidenceDir: null,
		agentCwd: representative.agentCwd,
		runner: null,
		phase: reviewPhase,
		// #412: engine-derived items must inherit the source (representative) item's preset; they may
		// not silently fall back to the chain's seed preset because the chain may carry items with
		// different presets.
		preset: representative.preset,
		presetPath: representative.presetPath,
		extra: storedItemExtra({}),
		createdAt: representative.createdAt,
		updatedAt: representative.updatedAt,
		statusUpdatedAt: representative.statusUpdatedAt,
	}
}

async function spawnSchedulerReviewOnEmptyRun(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
): Promise<SchedulerActiveRun | null> {
	if (items.length === 0) return null
	const representative = pickReviewOnEmptyRepresentativeItem(items)
	const slot = getOrCreateSlot(options.state, chain, representative.repoCwd)
	if (slot.activeRun !== null) return null

	// #412 mixed-preset chain bug: phase plan and preset load must come from the same source. Earlier
	// shape called resolvePhasePlanForChain(chain) here while the preset was loaded via the representative
	// item below, so when chain.preset != items[0].preset the rendered run picked phase names from
	// chain.preset and the preset directory of item.preset — `phase_not_found_in_preset` at spawn. Load
	// the representative item's preset first, then derive the phase plan from it.
	const loadedPreset = await schedulerLoadedPresetForItem(options, chain, representative)
	const phasePlan = options.phase !== undefined
		? { firstPhase: options.phase, lastPhase: options.phase, nonTriggerPhases: [options.phase], itemTriggerPhases: [] }
		: buildPhasePlanFromPreset(loadedPreset.preset)
	const reviewPhase = phasePlan.lastPhase
	const fallbackItem = makeReviewOnEmptyFallbackItem(chain, representative, reviewPhase)
	const worktreeManager = options.worktreeManager ?? createGitWorktreeManager(options.loopDataRootOptions)
	const worktreePath = slot.worktreePath ?? await worktreeManager({ chain, repoCwd: representative.repoCwd, slotKey: slot.key })
	slot.worktreePath = worktreePath

	const runner = await resolvePhaseRunner(options, { chain, item: fallbackItem, phase: reviewPhase })
	const runId = options.runIdFactory?.({ chain, item: fallbackItem, phase: reviewPhase }) ?? makeReviewOnEmptyRunId(chain)
	const startedAt = nowSeconds(options)
	const presetDir = loadedPreset.presetDir
	const context: SchedulerSpawnContext = { chain, item: fallbackItem, slot, runId, worktreePath, presetDir, loadedPreset, phase: reviewPhase }
	const rawPrompt = typeof options.prompt === "string" ? options.prompt : await options.prompt(context)
	const renderedPrompt = await renderSchedulerSpawnPrompt({
		rawPrompt,
		preset: loadedPreset.preset,
		phase: reviewPhase,
		chain,
		item: fallbackItem,
		runId,
		worktreePath,
		issueKind: null,
		loopDataRootOptions: options.loopDataRootOptions,
		resume: freshResume(),
	})
	const summaryTag = makeRunSummaryTag()
	const runnerPlan = buildRunnerInvocation(
		runner,
		renderedPrompt + summaryInstructionFor(summaryTag),
		freshResume(),
		invocationPaths(representative.repoCwd, worktreePath, presetDir, resolveLoopDataPaths(options.loopDataRootOptions).root),
	)
	await initializeSchedulerRunArtifacts(options, chain, fallbackItem, runId, reviewPhase, startedAt, worktreePath)
	const child = spawn(runnerPlan.binary, runnerPlan.args, {
		cwd: worktreePath,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		// Same loop-data-root passthrough as the per-item spawn so the agent's `item update` reaches this daemon.
		env: { ...process.env, [LOOP_DATA_ROOT_ENV]: resolveLoopDataPaths(options.loopDataRootOptions).root },
	})
	const activeRun = attachReviewOnEmptyCloseHandler(
		options,
		chain,
		fallbackItem,
		slot,
		runId,
		worktreePath,
		startedAt,
		reviewPhase,
		child,
		runner,
		representative.repoCwd,
		summaryTag,
	)
	slot.activeRun = activeRun
	await emit(options, {
		type: "agent.spawn",
		slotKey: slot.key,
		chainId: chain.id,
		itemId: fallbackItem.id,
		runId,
		phase: reviewPhase,
		pid: activeRun.pid,
		worktreePath,
		presetDir,
	})
	await emit(options, {
		type: "phase.start",
		ts: nowIso(options),
		runId,
		chainId: chain.id,
		itemId: fallbackItem.id,
		repoCwd: representative.repoCwd,
		phase: reviewPhase,
		pid: activeRun.pid,
	})
	return activeRun
}

function attachReviewOnEmptyCloseHandler(
	options: SchedulerOptions,
	chain: ChainRecord,
	fallbackItem: ItemRecord,
	slot: SchedulerSlot,
	runId: string,
	worktreePath: string,
	startedAt: number,
	phase: string,
	child: ReturnType<typeof spawn>,
	runner: AgentRunnerSelection,
	repoCwd: string,
	summaryTag: string,
): SchedulerActiveRun {
	const stdout: Buffer[] = []
	const stderr: Buffer[] = []
	const outputPaths = schedulerPhaseOutputPaths(options, chain, runId, phase)
	const outputWriters = createSchedulerPhaseOutputWriters(outputPaths)
	let lifecycleGc: SchedulerRunLifecycleGc | null = null
	const closed = new Promise<SchedulerCompletedRun>((resolveClosed, rejectClosed) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.push(chunk)
			outputWriters.stdout.write(chunk)
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk)
			outputWriters.stderr.write(chunk)
		})
		child.on("error", (error) => {
			const chunk = Buffer.from(error.message)
			stderr.push(chunk)
			outputWriters.stderr.write(chunk)
		})

		lifecycleGc = installSchedulerRunLifecycleGc(options, child, summaryTag, {
			chain,
			item: fallbackItem,
			runId,
			phase,
			stdoutPath: outputPaths.stdoutPath,
			stderrPath: outputPaths.stderrPath,
		})

		child.on("close", (code) => {
			lifecycleGc?.cleanup()
			const pendingCloseHandler = (async (): Promise<SchedulerCompletedRun> => {
				const exitCode = code ?? 1
				const stdoutText = Buffer.concat(stdout).toString("utf-8")
				const stderrText = Buffer.concat(stderr).toString("utf-8")
				const chainStatuses = await schedulerStatusesForChain(options, chain)
				// Synthetic review-on-empty / chain-complete trigger run: there is no real item whose status
				// the agent owns, so the run outcome is recorded from the exit code using the chain's own
				// status vocabulary (no stdout parsing, no hardcoded literal). This run mutates no item.
				const status = exitCode === 0 ? (chainStatuses.success[0] ?? chainStatuses.entry) : chainStatuses.entry
				const endedAt = nowSeconds(options)
				try {
					await closeSchedulerPhaseOutputWriters(outputWriters)
					await writeSchedulerRunCompletionArtifacts(options, {
						runId,
						chain,
						item: fallbackItem,
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

					const lockPath = reviewOnEmptyLockPathForChain(chain, options.loopDataRootOptions)
					await mkdir(dirname(lockPath), { recursive: true })
					await writeFile(lockPath, serializeSchedulerReviewOnEmptyLock(runId, new Date()))

					if (slot.activeRun?.runId === runId) slot.activeRun = null
					const excerpt = await collectObservabilityExcerpt({
						stdoutPath: outputPaths.stdoutPath,
						stderrPath: outputPaths.stderrPath,
					})
					await emit(options, {
						type: "agent.exit",
						slotKey: slot.key,
						chainId: chain.id,
						itemId: fallbackItem.id,
						runId,
						phase,
						exitCode,
						status,
						excerpt,
					})
					await emit(options, {
						type: "phase.end",
						ts: nowIso(options),
						runId,
						chainId: chain.id,
						itemId: fallbackItem.id,
						phase,
						exitCode,
						durationSeconds: Math.max(0, endedAt - startedAt),
						status,
					})
					await completeChainIfReady(options, chain, runId, [...chainStatuses.terminal])
					return { runId, itemId: fallbackItem.id, chainId: chain.id, repoCwd, exitCode, stdout: stdoutText, stderr: stderrText, status }
				} catch (error) {
					if (slot.activeRun?.runId === runId) slot.activeRun = null
					throw error
				}
			})()
			options.state.pendingCloseHandlers.add(pendingCloseHandler)
			void pendingCloseHandler
				.then(resolveClosed, rejectClosed)
				.finally(() => {
					options.state.pendingCloseHandlers.delete(pendingCloseHandler)
				})
				.catch(() => undefined)
		})
	})
	const terminate = createRunTerminator(child, closed)
	return {
		runId,
		pid: child.pid ?? null,
		itemId: fallbackItem.id,
		chainId: chain.id,
		repoCwd,
		worktreePath,
		startedAt,
		closed,
		terminate,
	}
}

function freshResume(): ResumeDecision {
	return { kind: "fresh" }
}

export function resumeDecisionForItem(item: ItemRecord, phase: string, runner: AgentRunnerKind): ResumeDecision {
	const sessionId = item.sessionIds[phase]?.[runner] ?? null
	if (sessionId === null || sessionId === "") return freshResume()
	return { kind: "resume", sessionId }
}

async function resolvePhaseRunner(
	options: SchedulerOptions,
	input: SchedulerPhaseRunnerInput,
): Promise<AgentRunnerSelection> {
	if (options.phaseRunner !== undefined) return await options.phaseRunner(input)
	// #412: prefer the per-item resolver. In mixed-preset chains the chain seed's preset declares a
	// different phase plan than the item's, so resolving runner against the chain seed throws
	// `preset X does not define phase "<phase from item.preset>"`. The per-item resolver loads
	// the item's preset and supplies `PhaseRunnerSelectionInput` aligned with that preset.
	if (options.phaseRunnerSelectionForItem !== undefined) {
		const selection = await options.phaseRunnerSelectionForItem(input.chain, input.item)
		return selectRunnerForPhase(input.phase, input.item, selection)
	}
	if (options.phaseRunnerSelectionForChain !== undefined) {
		const selection = await options.phaseRunnerSelectionForChain(input.chain)
		return selectRunnerForPhase(input.phase, input.item, selection)
	}
	if (options.runner !== undefined) return options.runner
	throw new SchedulerError(
		"spawn_failed",
		`scheduler: no runner configured for chain=${input.chain.name} item=${input.item.id} phase=${input.phase}; set SchedulerOptions.phaseRunner, .phaseRunnerSelectionForItem, .phaseRunnerSelectionForChain, or .runner`,
	)
}

function invocationPaths(targetCwd: string, agentCwd: string, presetDir: string, loopDataRoot: string): RunnerInvocationPaths {
	return { targetCwd, agentCwd, presetDir, loopDataRoot }
}

export type SchedulerPromptRenderInput = {
	rawPrompt: string
	preset: Preset
	phase: string
	chain: ChainRecord
	item: ItemRecord
	runId: string
	worktreePath: string
	issueKind: IssueKind
	loopDataRootOptions?: LoopDataRootOptions | undefined
	resume?: ResumeDecision
	runner?: AgentRunnerKind
}

export async function renderSchedulerSpawnPrompt(input: SchedulerPromptRenderInput): Promise<string> {
	const preset = input.preset
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
		resume: input.resume ?? (input.runner === undefined ? freshResume() : resumeDecisionForItem(input.item, input.phase, input.runner)),
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
	resume?: ResumeDecision
	runner?: AgentRunnerKind
}): ResolveContext {
	const chainPaths = resolveChainRuntimePaths(input.chain.name, input.loopDataRootOptions)
	const evidenceDir = resolveItemEvidenceDir(input.item, chainPaths.chainRoot, chainPaths.issueEvidenceDir(input.item.issueNumber))
	const currentIssueFile = resolveOptionalItemIssueFile(input.item, chainPaths.chainRoot)
	const resume = input.resume ?? (input.runner === undefined ? freshResume() : resumeDecisionForItem(input.item, input.phase.name, input.runner))
	const resumedSessionId = resume.kind === "resume" ? resume.sessionId : ""
	const runtime: RuntimeBindings = {
		// Preset-supplied business key values are spread first (#448): the preset
		// is the source of truth for its declared business keys. Engine facts
		// declared below can never be shadowed because
		// `parsePresetRuntimeBusinessKeys` rejects engine-owned keys at load.
		...resolvePresetBusinessKeyValues(input.preset),
		runId: input.runId,
		targetCwd: input.item.repoCwd,
		agentCwd: input.worktreePath,
		sharedContextPath: chainPaths.sharedFile,
		stateFile: "the central state DB",
		currentIssueFile,
		issueDir: chainPaths.issuesDir,
		evidenceDir,
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
		traceFile: `${chainPaths.runsDir}/${input.runId}/<phase>/stdout.jsonl`,
		loopFile: "central daemon scheduling state",
		presetDir: input.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.preset, input.phase),
		runtimeInputsDoc: "",
		phaseExitsDoc: "",
		issueKindDoc: "",
		runIdGeneration: resumedSessionId === "" ? "new" : "resumed",
		resumedFromPhase: resumedSessionId === "" ? "" : input.phase.name,
		resumedStartedAt: "",
		resumedSessionId,
		issueKind: input.issueKind ?? "",
		chainName: input.chain.name,
		chainUmbrellaRepo: input.chain.umbrellaRepo ?? "",
		chainUmbrellaIssue: input.chain.umbrellaIssue === null ? "" : String(input.chain.umbrellaIssue),
		chainBaseBranch: input.chain.baseBranch,
		repoCwd: input.item.repoCwd,
	}
	const chain = buildRenderBindings({
		bindings: buildSchedulerChainBindings(input.chain),
	})
	return { item: input.item, chain, runtime }
}

function buildSchedulerChainBindings(chain: ChainRecord): JsonObject {
	return {
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		...metadataBindings(chain.metadata),
	}
}

function resolveFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path)
}

function resolveItemEvidenceDir(item: ItemRecord, chainRoot: string, fallback: string): string {
	if (item.evidenceDir === null || item.evidenceDir === "") return fallback
	return resolveItemRuntimePath(chainRoot, item.evidenceDir)
}

function resolveOptionalItemIssueFile(item: ItemRecord, chainRoot: string): string {
	if (item.issueFile === null || item.issueFile === "") return ""
	return resolveItemRuntimePath(chainRoot, item.issueFile)
}

function resolveItemRuntimePath(chainRoot: string, path: string): string {
	return isAbsolute(path) ? path : resolve(chainRoot, path)
}

async function schedulerLoadedPreset(options: SchedulerOptions, chain: ChainRecord): Promise<SchedulerLoadedPreset> {
	return await options.presetForChain(chain)
}

// #412 per-item preset resolution. Falls back to chain-level resolution when the caller has not
// supplied a `presetForItem` resolver — preserves pre-#412 single-preset-per-chain behavior.
async function schedulerLoadedPresetForItem(options: SchedulerOptions, chain: ChainRecord, item: ItemRecord): Promise<SchedulerLoadedPreset> {
	if (options.presetForItem !== undefined) return await options.presetForItem(chain, item)
	return await options.presetForChain(chain)
}

// #412 chain-wide resolution that prefers a representative item's preset over the chain's legacy
// default seed. Used by scheduler tick paths that need the chain's status / phase vocabulary but
// run before any single item is selected: the first persisted item's preset is the canonical seed,
// chain.preset is consulted only when the chain has no items. This keeps `chain.preset = null`
// (post-#412 chains) workable as long as items themselves declare their preset.
async function schedulerLoadedPresetForChainItems(
	options: SchedulerOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
): Promise<SchedulerLoadedPreset> {
	const representative = items.find((item) => item.preset !== null || item.presetPath !== null)
	if (representative !== undefined) return await schedulerLoadedPresetForItem(options, chain, representative)
	return await schedulerLoadedPreset(options, chain)
}

async function emit(options: SchedulerOptions, event: SchedulerEvent): Promise<void> {
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
	await mkdir(paths.runPhaseDir(runId, phase), { recursive: true })
	await Promise.all([
		writeFile(paths.runStdoutFile(runId), ""),
		writeFile(paths.runStderrFile(runId), ""),
		writeFile(paths.runPhaseStdoutFile(runId, phase), ""),
		writeFile(paths.runPhaseStderrFile(runId, phase), ""),
		writeSchedulerRunStatus(options, {
			runId,
			chain,
			item,
			phase,
			startedAt,
			endedAt: null,
			exitCode: null,
			status: RUNNING_RUN_STATUS,
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
	await mkdir(paths.runPhaseDir(input.runId, input.phase), { recursive: true })
	await Promise.all([
		writeFile(paths.runStdoutFile(input.runId), input.stdoutText),
		writeFile(paths.runStderrFile(input.runId), input.stderrText),
		writeFile(paths.runPhaseStdoutFile(input.runId, input.phase), input.stdoutText),
		writeFile(paths.runPhaseStderrFile(input.runId, input.phase), input.stderrText),
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
		eventsPath: resolveLoopDataPaths(options.loopDataRootOptions).eventsFile,
	}, null, "\t")}\n`)
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
	try {
		const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
		return {
			stdout: new TextDecoder().decode(proc.stdout).trim(),
			stderr: new TextDecoder().decode(proc.stderr).trim(),
			exitCode: proc.exitCode,
		}
	} catch (error) {
		return { stdout: "", stderr: errorMessage(error), exitCode: 1 }
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
