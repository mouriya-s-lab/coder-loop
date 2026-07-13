import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createWriteStream, existsSync, realpathSync, rmSync, type WriteStream } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

import {
	buildRenderBindings,
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
	parseSessionIdFromRunnerStream,
	phaseExitsEpilogue,
	renderFragmentIndex,
	renderPrompt,
	resolvePresetBusinessKeyValues,
	selectRunnerForPhase,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type JsonObject,
	type JsonValue,
	type Preset,
	type PresetPhase,
	type PhaseRunnerSelectionInput,
	type ResolveContext,
	type ResumeDecision,
	type RunnerFilesystemAuthorization,
	type RuntimeBindings,
	RunnerStatusPersistenceError,
	type RunnerStatusPersistenceFailure,
} from "./loop"
import { classifyRateLimitFromStdout, isRateLimitErrorCode, type RateLimitReset } from "./rate-limit"
import {
	chainCompleteTriggerState,
	chainBindings as metadataBindings,
	chainMetadataToJsonObject,
	clearSchedulerBackoff as clearItemSchedulerBackoff,
	clearSchedulerSpawnError as clearItemSchedulerSpawnError,
	engineLifecycleAdmittedItemStatus,
	itemSchedulerBackoff,
	itemExtraToJsonObject,
	itemExtraWithoutKeys,
	parseInternalStatus,
	storedItemExtra,
	withChainCompleteTriggerState,
	withoutChainCompleteTriggerState,
	withSchedulerBackoff,
	withSchedulerSpawnError as withItemSchedulerSpawnError,
	type AdmittedItemStatus,
	type InternalStatus,
	type SchedulerBackoffState,
	type SchedulerSpawnError,
	type SchedulerSpawnErrorAttribution,
} from "./runtime-data"
import { detectsSessionIdInvalid } from "./runners/session-id"
import { type ChainRecord, dependsOnItemIds, type ItemRecord, listDependencyWaitReasons, type RunRecord, type SqliteStateStore } from "./sqlite-state"
import {
	LOOP_DATA_ROOT_ENV,
	LOOP_RUN_CREDENTIAL_ENV,
	type LoopDataRootOptions,
	RuntimePathError,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	sanitizeChainName,
} from "./runtime-paths"
import { collectObservabilityExcerpt, type ObservabilityExcerpt } from "./observability"
import { createStreamTextState } from "./runner-output"

// #452: completion signal is the daemon-observed state write, not a stdout marker.
// The previous "per-run nonce summary tag" prompt injection + stdout watchdog
// (retired here together with `summaryInstructionFor`, `makeRunSummaryTag`,
// `extractSummaryValue`, the close-marker observe-stdout state machine, and the
// `watchdogGraceMs`/`watchdogKillMs` knobs) gated completion on the agent emitting
// a particular string. Under the unified completion protocol (#451) the agent
// writes status through the daemon-serialised `coder-loop item update` path, and
// the daemon hands the scheduler a `markRunPendingRecycle(runId)` signal at that
// moment — that is the only thing the engine treats as "this run is done"; stdout
// content, including forged close markers, has zero effect on recycle timing or
// completion classification.
//
// `ATTEMPT_TIMEOUT_MS` / `ATTEMPT_KILL_MS` are unchanged — they remain the
// time-based fallback for runs that never write state AND never exit (the floor
// the issue's acceptance #4 pins).
//
// `RECYCLE_AFTER_STATE_WRITE_MS` is the post-state-write recycle window: once the
// daemon marks a run as pending recycle, the engine grants the agent process this
// long to exit naturally before SIGKILLing the process group. The default mirrors
// the operator's verbatim example (500s). It is configurable via
// `SchedulerOptions.recycleAfterStateWriteMs`, but the recycle semantics
// themselves (state-write → recycle zone → timeout kill) are mandatory and not
// opt-out, per the operator's 2026-06-12 decree.
const ATTEMPT_TIMEOUT_MS = 2 * 60 * 60 * 1000
const ATTEMPT_KILL_MS = 5 * 1000
const RECYCLE_AFTER_STATE_WRITE_MS = 500 * 1000
const RECYCLE_KILL_GRACE_MS = 5 * 1000
// #462 startup idle watchdog. A runner hung at turn submission emits only its stream banner
// (codex --json: `thread.started` + `turn.started` ≈ 101 bytes) and then nothing — observed
// on run-1781258195574-6 which burned the full attempt timeout with stdoutBytes=101. A healthy
// run crosses the progress threshold within seconds (first item event). Mid-run silences are
// legitimate and long (orchestrator wait_agent gaps up to 1800s measured on real sessions), so
// the watchdog disarms permanently once cumulative stdout crosses the threshold and never
// re-arms. stderr intentionally does not count as progress: the codex RUST_LOG diagnostics
// (#463) stream there from spawn and would neutralize detection. Overridable per spawn via
// SchedulerOptions, and globally via the env knobs documented inside installSchedulerRunLifecycleGc.
const STARTUP_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const STARTUP_IDLE_PROGRESS_BYTES = 200
const STARTUP_IDLE_KILL_MS = 5 * 1000

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

type SchedulerPreparingRun = SchedulerActiveRun & {
	markPrepared: () => void
	abortPreparation: (options?: SchedulerRunTerminateOptions) => Promise<SchedulerCompletedRun>
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
	stdoutBytes: number
	stderrBytes: number
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

// #452: per-run recycle-zone trigger. The scheduler installs a callback into this map for
// every spawned run (see `installSchedulerRunLifecycleGc`); the daemon, after a successful
// agent-attributed `item.update` status write, looks the runId up via
// `markRunPendingRecycle` and fires the callback exactly once. The callback arms the recycle
// timer and emits `recycle.pending_entered`. The map is cleared in the run's close handler
// regardless of whether recycle armed, so a missed write never leaks a callback.
export type SchedulerRecycleTrigger = () => void

export type SchedulerState = {
	slots: Map<string, SchedulerSlot>
	finalizingItemStatuses: Map<number, InternalStatus>
	finalizingChainIds: Set<number>
	pendingCloseHandlers: Set<Promise<unknown>>
	recycleTriggers: Map<string, SchedulerRecycleTrigger>
	lifecycleEventPersistenceFailures: SchedulerLifecycleEventPersistenceFailure[]
	// #478: account-level rate-limit cooldown. The scheduler close handler arms this
	// synchronously (before its first await) when a run exits with a rejected
	// `rate_limit_event`; `schedulerTick` consults the value before spawning so the next
	// tick does not re-spawn the rate-limited item and consume another attempt slot. The
	// daemon's `applyRateLimitNotice` then persists the same value (UTC millis) into
	// `DaemonRateLimitState`. Null when no cooldown is in effect.
	rateLimitedUntilMs: number | null
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
	// #419 review I2: `itemId` (rowid integer) renamed to `rowId` for wire-shape consistency
	// with other `item.*` audit events that use the split shape `{ rowId: number, itemId: string }`.
	// `itemId` on the audit wire now uniformly means the opaque preset-declared string identity;
	// these decision-tier events only carry the rowid, so the field shifts to `rowId`.
	| { type: "item.dependency_wait"; chainId: number; rowId: number; dependsOn: readonly number[]; unsatisfied: readonly number[] }
	| { type: "item.backoff"; chainId: number; rowId: number; failureCount: number; nextRunAt: number }
	| { type: "agent.spawn"; slotKey: string; chainId: number; itemId: number; runId: string; phase: string; pid: number | null; worktreePath: string; presetDir: string }
	| { type: "agent.exit"; slotKey: string; chainId: number; itemId: number; runId: string; phase: string; exitCode: number; status: InternalStatus; excerpt: ObservabilityExcerpt }
	| { type: "session_id.invalidated"; ts: string; runId: string; chainId: number; itemId: number; phase: string; runner: AgentRunnerKind; previousSessionId: string | null; reason: "runner_session_id_invalid" }
	// #419: `spawn.aborted` payload retires the integer `issueNumber` field. The `id` here is the
	// item's opaque preset-declared string id (formerly `issueNumber`-as-int). `itemId` remains
	// the rowid (integer). Supervisor consumers must read `id` for the issue/item identity.
	| { type: "spawn.aborted"; slotKey: string; chainId: number; chainName: string; itemId: number; id: string; reason: string; toStatus: InternalStatus }
	| { type: "chain.complete_trigger"; chainId: number; chainName: string; runId?: string; decision: SchedulerChainCompleteDecision["decision"]; reason?: string }
	| { type: "chain.complete_trigger_failed"; chainId: number; chainName: string; runId?: string; error: string }
	| { type: "chain.completed"; chainId: number; chainName: string; runId?: string }
	| { type: "phase.start"; ts: string; runId: string; chainId: number; itemId: number; repoCwd: string; phase: string; pid: number | null }
	| { type: "phase.end"; ts: string; runId: string; chainId: number; itemId: number; phase: string; exitCode: number; durationSeconds: number; status: InternalStatus }
	| { type: "attempt.timeout"; ts: string; runId: string; chainId: number; itemId: number; phase: string; signal: "SIGTERM" | "SIGKILL"; attemptMs: number; excerpt: ObservabilityExcerpt }
	// #462: startup idle reclaim. Distinct from `attempt.timeout` so the lifecycle stream
	// distinguishes early zero-output kills from the absolute attempt-timeout floor.
	| { type: "run.startup_idle_kill"; ts: string; runId: string; chainId: number; itemId: number; phase: string; idleTimeoutMs: number; stdoutBytes: number }
	// #452 recycle-zone lifecycle. The three events are mutually exclusive per run after
	// state has been written: `recycle.pending_entered` fires exactly once when the daemon
	// signals the agent's status-write succeeded; from there the run goes to either
	// `recycle.natural_exit` (child closed within the window) or `recycle.timeout_kill`
	// (window elapsed and the engine SIGKILLed the process group). A run that never
	// writes state takes neither — it falls through to `attempt.timeout` instead.
	| { type: "recycle.pending_entered"; ts: string; runId: string; chainId: number; itemId: number; phase: string; recycleAfterMs: number }
	| { type: "recycle.timeout_kill"; ts: string; runId: string; chainId: number; itemId: number; phase: string; signal: "SIGKILL"; recycleAfterMs: number; excerpt: ObservabilityExcerpt }
	| { type: "recycle.natural_exit"; ts: string; runId: string; chainId: number; itemId: number; phase: string; elapsedMs: number }
	// #419 review I2: same rename as above — `itemId` (rowid integer) → `rowId` on these
	// audit-tier events so the wire-side `itemId` field uniformly means opaque string identity.
	| { type: "queue.terminal"; ts: string; runId: string; chainId: number; rowId: number; terminalStatus: InternalStatus }
	| { type: "item.dependency_unblocked"; chainId: number; rowId: number; fromStatus: InternalStatus; toStatus: InternalStatus; dependsOn: readonly number[] }
	// #478: account-level rate limit observed on this run's stdout. The scheduler fires
	// this immediately on detection in its close handler so observers can pair the per-run
	// trigger with the daemon-wide cooldown decision exposed via `daemon.status`. Distinct
	// from `attempt.timeout` because rate-limit exits do not consume an attempt slot.
	| { type: "scheduler.rate_limited"; ts: string; chainId: number; itemId: number; runId: string; resetsAt: number; resetAtIso: string; rateLimitType: string | null }

export type SchedulerTimerLifecycleEvent = Extract<SchedulerEvent, {
	type:
		| "attempt.timeout"
		| "run.startup_idle_kill"
		| "recycle.pending_entered"
		| "recycle.timeout_kill"
		| "recycle.natural_exit"
}>

export type SchedulerLifecycleEventPersistenceFailure = {
	event: SchedulerTimerLifecycleEvent
	error: string
}

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
// defaultRunner, runnerCommands per `PhaseRunnerSelectionInput`) against the item's own preset —
// not the chain seed — because the phase being spawned belongs to the item's preset's phase plan.
// If the caller wires `phaseRunnerSelectionForItem`, the scheduler prefers it over the chain-wide
// form. The chain-wide form is preserved for callers that only have a chain in hand (chain-complete
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
	// Timer callbacks cannot await the observability sink without delaying process lifecycle.
	// This synchronous failure channel records the rejected event separately while termination,
	// recycle arming, and close cleanup continue independently.
	onLifecycleEventPersistenceFailure?: (failure: SchedulerLifecycleEventPersistenceFailure) => void
	onRunnerStatusPersistenceFailure?: (failure: RunnerStatusPersistenceFailure) => void
	attemptTimeoutMs?: number
	attemptKillMs?: number
	// #462: startup idle watchdog knobs (semantics documented at STARTUP_IDLE_TIMEOUT_MS).
	// Daemon forwards the same names from `scheduler.startupIdle*` so tests can run with
	// 100-400 ms thresholds while production keeps the 10 min / 200 B / 5 s defaults.
	startupIdleTimeoutMs?: number
	startupIdleProgressBytes?: number
	startupIdleKillMs?: number
	// #452: post-state-write recycle window. Once the daemon notifies the scheduler that this
	// run wrote item status (via `markRunPendingRecycle`), the engine waits at most this long
	// for the child to exit naturally before SIGKILLing the process group. The semantics are
	// mandatory; the knob only tunes the duration. `recycleKillGraceMs` is the post-kill grace
	// before a follow-up SIGKILL retry on stuck signal delivery (mirrors attemptKillMs shape).
	recycleAfterStateWriteMs?: number
	recycleKillGraceMs?: number
	// #406: run-scoped credential supplier. The scheduler mints one credential per spawn
	// (`mint(...)`), injects its value into the runner process env, and revokes it from the
	// supplier when the run process closes. When unset (test fixtures that don't exercise the
	// caller-admission gate), the scheduler still spawns the agent but the env var is absent,
	// so any item.update from the agent flows the operator path through the daemon gate.
	runCredentials?: SchedulerRunCredentialIssuer
	// #478: invoked from the close handler when a rate-limit signal is found on stdout. The
	// daemon wires this to `applyRateLimitNotice`, which persists the cooldown into the
	// daemon's `DaemonRateLimitState` (independent of scheduler-tick state). The scheduler's
	// in-state gate (`SchedulerState.rateLimitedUntilMs`) is set synchronously in the close
	// handler before this callback fires, so the next tick is gated even before persist lands.
	onRateLimitObserved?: (info: { runId: string; chainId: number; itemId: number; reset: RateLimitReset }) => void | Promise<void>
}

// #406: minted run credential. The string is the secret value the daemon's caller-admission
// gate matches against an active-run table at the request boundary. The scheduler treats it as
// opaque — only the daemon's registry knows the binding to (chain, item, run).
export type SchedulerRunCredential = {
	readonly value: string
}

export type SchedulerRunCredentialContext = {
	chainId: number
	itemId: number
	runId: string
	phase: string
}

export type SchedulerRunCredentialIssuer = {
	mint: (context: SchedulerRunCredentialContext) => SchedulerRunCredential
	revoke: (credential: SchedulerRunCredential, context: SchedulerRunCredentialContext) => void
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

export type SchedulerTickResult = {
	spawnedRuns: SchedulerActiveRun[]
	completedChainIds: number[]
}

const DEFAULT_SPAWN_FAILURE_BACKOFF: SchedulerSpawnFailureBackoffConfig = { initialSeconds: 60, maxSeconds: 480 }

let fallbackRunSequence = 0

export function createSchedulerState(): SchedulerState {
	return {
		slots: new Map(),
		finalizingItemStatuses: new Map(),
		finalizingChainIds: new Set(),
		pendingCloseHandlers: new Set(),
		recycleTriggers: new Map(),
		lifecycleEventPersistenceFailures: [],
		rateLimitedUntilMs: null,
	}
}

// #452: the daemon calls this once per agent-attributed `item.update` status write that
// passed admission (see daemon.ts handleItemUpdate). Idempotent — if the run has already
// entered recycle or the run is unknown, this is a no-op. The lookup is by runId so the
// daemon does not need a handle into per-run scheduler internals.
export function markRunPendingRecycle(state: SchedulerState, runId: string): void {
	const trigger = state.recycleTriggers.get(runId)
	if (trigger === undefined) return
	state.recycleTriggers.delete(runId)
	trigger()
}

export function maxItemAttemptsFromChainMetadata(metadata: ChainRecord["metadata"]): number {
	const value = metadata.maxItemAttempts
	if (isPositiveInteger(value)) return value
	return DEFAULT_MAX_ITEM_ATTEMPTS
}

export async function schedulerTick(options: SchedulerOptions, limits?: { maxSpawns?: number }): Promise<SchedulerTickResult> {
	const activeChains = options.store
		.listChains()
		.filter((chain) => chain.status === "active" && hasValidChainName(chain.name))
	const activeChainIds = new Set(activeChains.map((chain) => chain.id))
	const spawnedRuns: SchedulerActiveRun[] = []
	const completedChainIds: number[] = []

	removeIdleSlotsForInactiveChains(options.state, activeChainIds)

	// #478: in-state paused gate — a rate-limit cooldown armed synchronously by a prior run's
	// close handler takes effect immediately, before the daemon-level async persist can land.
	// Without this gate the next tick (1 s cadence) re-spawns the rate-limited item and burns
	// another attempt slot. The daemon-level gate (`limits.maxSpawns=0`) is the long-lived
	// authority; this synchronous in-state gate plugs the tick-boundary race only.
	const tickNowMs = nowSeconds(options) * 1000
	const statePaused = options.state.rateLimitedUntilMs !== null && tickNowMs < options.state.rateLimitedUntilMs
	const effectiveMaxSpawns = statePaused ? 0 : limits?.maxSpawns
	const spawnCapped = (): boolean => effectiveMaxSpawns !== undefined && spawnedRuns.length >= effectiveMaxSpawns

	for (const chain of activeChains) {
		if (spawnCapped()) break
		let items = options.store.listItems(chain.id)
		// #412: an empty chain with no chain-level preset has nothing to drive — skip cleanly instead
		// of crashing chain-wide preset resolution. The chain becomes actionable as soon as the first
		// item (with its own preset) is added.
		if (items.length === 0 && chain.preset === null) continue
		const chainPreparationItem = [...items].sort(comparePendingItems)[0]
		if (
			chainPreparationItem?.extra.schedulerSpawnError?.attribution.kind === "chain-plan"
			&& !itemBackoffReady(chainPreparationItem, nowSeconds(options))
		) continue
		let chainStatuses: SchedulerChainStatuses
		let phasePlan: SchedulerPhasePlan
		try {
			chainStatuses = await schedulerStatusesForChainWithItems(options, chain, items)
			phasePlan = await resolvePhasePlanForChainWithItems(options, chain, items)
		} catch (error) {
			if (chainPreparationItem === undefined) throw error
			const slot = getOrCreateSlot(options.state, chain, chainPreparationItem.repoCwd)
			await containSchedulerPreparationFailure(options, chain, chainPreparationItem, slot, { kind: "chain-plan" }, error)
			continue
		}
		const runs = options.store.listRuns(chain.id)
		const repoCwds = distinct(items.map((item) => item.repoCwd))

		for (const repoCwd of repoCwds) {
			if (spawnCapped()) break
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

			const activeRun = await spawnSchedulerRun(options, chain, next.item, slot, next.phase, phasePlan)
			if (activeRun !== null) spawnedRuns.push(activeRun)
		}

		// Restore dependency-unblocked terminal items AFTER selection so a freshly-unblocked item is
		// not also selected in the same tick — it becomes actionable now and is picked up on the next
		// tick. Running it before chain completion keeps the chain from draining or completing while
		// an item has just become actionable again. #456: the legacy review-on-empty branch retired
		// here — chain-drain side effects flow through the DSL chain-complete trigger path
		// (`runPresetChainCompleteTriggerPhases`), which `completeChainIfReady` consults via
		// `chainCompletionTriggerAllowsCompletion` below.
		items = await unblockDependencySatisfiedItems(options, chain, items, chainStatuses)

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
	if (options.phase !== undefined) return { firstPhase: options.phase, nonTriggerPhases: [options.phase], itemTriggerPhases: [] }
	const { preset } = await schedulerLoadedPresetForChainItems(options, chain, items)
	return buildPhasePlanFromPreset(preset)
}

function buildPhasePlanFromPreset(preset: SchedulerLoadedPreset["preset"]): SchedulerPhasePlan {
	const nonTriggerPhases = preset.phases.flatMap((phase) => phase.trigger === null ? [phase.name] : [])
	const firstPhase = nonTriggerPhases[0]
	if (firstPhase === undefined) throw new Error(`preset ${preset.name} has no non-trigger phases`)
	const itemTriggerPhases = preset.phases.flatMap((phase): SchedulerItemTriggerPhase[] => {
		const trigger = phase.trigger
		if (trigger === null) return []
		if (!("afterPhase" in trigger)) return []
		return [{ name: phase.name, afterPhase: trigger.afterPhase, whenStatus: trigger.whenStatus }]
	})
	return { firstPhase, nonTriggerPhases, itemTriggerPhases }
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
			// #419: DependencyWaitReason carries `rowId` (items.id rowid) and `itemId` (opaque
			// preset string). Build the wait-set on rowid so the lookup `item.id` (number) matches.
		}).map((wait) => wait.rowId),
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
			// #419 review I2: DependencyWaitReason supplies `rowId` (items.id rowid). The audit
			// wire's `rowId` field carries that integer; opaque string identity (when needed)
			// lives in the split-shape `item.*` audit events.
			rowId: wait.rowId,
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
			// #419 review I2: rowid (items.id) is carried on `rowId`, not `itemId`.
			rowId: item.id,
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
			// #397: brand the preset-derived exhausted status at the call site. Exhausting on
			// max attempts is an engine-lifecycle write (no caller-provided status), so it
			// bypasses the per-phase request gate and brands through the narrow engine-lifecycle
			// constructor. #402 made the underlying string value preset-declared; the brand only
			// uplifts the static type at the store-write boundary.
			status: engineLifecycleAdmittedItemStatus(exhaustedStatus, "scheduler.exhausted-on-max-attempts"),
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
			// #419 review I2: items.id rowid is `rowId` (audit `itemId` is reserved for the
			// opaque preset-declared string identity used by split-shape `item.*` events).
			rowId: item.id,
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
	phasePlan: SchedulerPhasePlan,
): Promise<SchedulerActiveRun | null> {
	const worktreeManager = options.worktreeManager ?? createGitWorktreeManager(options.loopDataRootOptions)
	const attribution: SchedulerSpawnErrorAttribution = { kind: "phase", phase }
	let worktreePath = slot.worktreePath
	let runId: string | null = null
	let startedAt: number | null = null
	let credential: SchedulerRunCredential | null = null
	let credentialContext: SchedulerRunCredentialContext | null = null
	let activeRun: SchedulerPreparingRun | null = null
	try {
		worktreePath = worktreePath ?? await worktreeManager({ chain, repoCwd: item.repoCwd, slotKey: slot.key })
		slot.worktreePath = worktreePath

		const runner = await resolvePhaseRunner(options, { chain, item, phase })
		const resumeDecision = resumeDecisionForItem(item, phase, runner.kind)
		const startsAttempt = phase === phasePlan.firstPhase && resumeDecision.kind === "fresh"
		runId = options.runIdFactory?.({ chain, item, phase }) ?? makeRunId(item.id, phase)
		startedAt = nowSeconds(options)
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
			attempts: item.attempts + (startsAttempt ? 1 : 0),
			lastRunId: runId,
			agentCwd: worktreePath,
			phase,
			updatedAt: startedAt,
		}
		const extraWithoutSpawnError = clearItemSchedulerSpawnError(item.extra)
		if (extraWithoutSpawnError !== item.extra) spawnUpdate.extra = extraWithoutSpawnError
		options.store.updateItem(item.id, spawnUpdate)

		const loadedPreset = await schedulerLoadedPresetForItem(options, chain, item)
		const presetDir = loadedPreset.preset.presetDir
		const context: SchedulerSpawnContext = { chain, item, slot, runId, worktreePath, presetDir, loadedPreset, phase }
		const rawPrompt = typeof options.prompt === "string" ? options.prompt : await options.prompt(context)
		const renderedPrompt = await renderSchedulerSpawnPrompt({
			rawPrompt,
			preset: loadedPreset.preset,
			phase,
			chain,
			item,
			runId,
			worktreePath,
			loopDataRootOptions: options.loopDataRootOptions,
			resume: resumeDecision,
			runner: runner.kind,
		})
		const finalPrompt = renderedPrompt + phaseExitsEpilogue()
		const runnerPlan = buildRunnerInvocation(
			runner,
			finalPrompt,
			resumeDecision,
			invocationAuthorization(chain, item, worktreePath, presetDir, resolveLoopDataPaths(options.loopDataRootOptions).root),
		)
		for (const directory of runnerPlan.runtimeDirectories) await mkdir(directory, { recursive: true })
		await initializeSchedulerRunArtifacts(options, chain, item, runId, phase, startedAt, worktreePath)
		credentialContext = { chainId: chain.id, itemId: item.id, runId, phase }
		credential = options.runCredentials?.mint(credentialContext) ?? null
		if (isAbsolute(runner.binary) && !existsSync(runner.binary)) throw new Error(`runner binary does not exist: ${runner.binary}`)
		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			...runnerPlan.environment,
			[LOOP_DATA_ROOT_ENV]: resolveLoopDataPaths(options.loopDataRootOptions).root,
		}
		if (credential !== null) spawnEnv[LOOP_RUN_CREDENTIAL_ENV] = credential.value
		if (runner.kind === "codex") {
			const level = process.env["CODER_LOOP_CODEX_RUST_LOG"] ?? process.env["RUST_LOG"] ?? "info"
			if (level !== "") spawnEnv["RUST_LOG"] = level
		}
		const child = spawn(runnerPlan.binary, runnerPlan.args, {
			cwd: worktreePath,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: spawnEnv,
		})
		await waitForChildSpawn(child)
		activeRun = attachRunCloseHandler(options, chain, item, slot, runId, worktreePath, startedAt, phase, child, runner, credential, credentialContext)
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
		await emit(options, { type: "agent.spawn", slotKey: slot.key, chainId: chain.id, itemId: item.id, runId, phase, pid: activeRun.pid, worktreePath, presetDir })
		await emit(options, { type: "phase.start", ts: nowIso(options), runId, chainId: chain.id, itemId: item.id, repoCwd: item.repoCwd, phase, pid: activeRun.pid })
		activeRun.markPrepared()
		return activeRun
	} catch (error) {
		const failure = await cleanupFailedRunPreparation(options, chain, item, slot, {
			runId,
			activeRun,
			credential,
			credentialContext,
		}, error)
		await containSchedulerPreparationFailure(options, chain, item, slot, attribution, failure)
		return null
	}
}

async function waitForChildSpawn(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolveSpawned, rejectSpawned) => {
		const onSpawn = (): void => {
			child.off("error", onError)
			resolveSpawned()
		}
		const onError = (error: Error): void => {
			child.off("spawn", onSpawn)
			rejectSpawned(error)
		}
		child.once("spawn", onSpawn)
		child.once("error", onError)
	})
}

type FailedRunPreparationResources = {
	runId: string | null
	activeRun: SchedulerPreparingRun | null
	credential: SchedulerRunCredential | null
	credentialContext: SchedulerRunCredentialContext | null
}

async function cleanupFailedRunPreparation(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	slot: SchedulerSlot,
	resources: FailedRunPreparationResources,
	failure: unknown,
): Promise<Error> {
	const cleanupErrors: string[] = []
	if (resources.activeRun !== null) {
		try {
			await resources.activeRun.abortPreparation({ forceAfterMs: 1_000 })
		} catch (error) {
			cleanupErrors.push(`child cleanup failed: ${errorMessage(error)}`)
		}
	} else if (resources.credential !== null && resources.credentialContext !== null) {
		try {
			options.runCredentials?.revoke(resources.credential, resources.credentialContext)
		} catch (error) {
			cleanupErrors.push(`credential cleanup failed: ${errorMessage(error)}`)
		}
	}

	if (resources.runId !== null) {
		const failedAt = nowSeconds(options)
		const run = options.store.getRunByRunId(resources.runId)
		if (run !== null && run.endedAt === null) {
			const currentItem = options.store.getItem(item.id) ?? item
			const worktreePath = run.extra.worktreePath
			if (worktreePath === undefined) {
				cleanupErrors.push("artifact cleanup failed: recorded run has no worktreePath")
			} else {
				try {
					await writeSchedulerRunCompletionArtifacts(options, {
						runId: resources.runId,
						chain,
						item,
						phase: run.phase,
						startedAt: run.startedAt,
						endedAt: failedAt,
						exitCode: 1,
						status: currentItem.status,
						pid: resources.activeRun?.pid ?? null,
						worktreePath,
						output: { kind: "inline", stdoutText: "", stderrText: errorMessage(failure) },
					})
				} catch (error) {
					cleanupErrors.push(`artifact cleanup failed: ${errorMessage(error)}`)
				}
			}
			options.store.completeRun(resources.runId, {
				endedAt: failedAt,
				exitCode: 1,
				status: currentItem.status,
				extra: run.extra,
			})
		}
		const currentRun = options.store.getCurrentRun(chain.id)
		if (currentRun?.runId === resources.runId) options.store.clearCurrentRun(chain.id)
		options.state.recycleTriggers.delete(resources.runId)
	}
	if (resources.runId === null || slot.activeRun?.runId === resources.runId) slot.activeRun = null

	const message = errorMessage(failure)
	return new Error(cleanupErrors.length === 0 ? message : `${message}; ${cleanupErrors.join("; ")}`)
}

async function containSchedulerPreparationFailure(
	options: SchedulerOptions,
	chain: ChainRecord,
	item: ItemRecord,
	slot: SchedulerSlot,
	attribution: SchedulerSpawnErrorAttribution,
	failure: unknown,
): Promise<void> {
	const failedAt = nowSeconds(options)
	const message = errorMessage(failure)
	const persistedItem = options.store.getItem(item.id) ?? item
	const nextFromAttemptStart = withNextSchedulerBackoff(item.extra, failedAt, spawnFailureBackoffForChain(options, chain))
	const backoff = itemSchedulerBackoff(nextFromAttemptStart)
	if (backoff === null) throw new Error("scheduler preparation backoff construction failed")
	const extraWithBackoff = withSchedulerBackoff(persistedItem.extra, backoff)
	options.store.updateItem(item.id, {
		status: engineLifecycleAdmittedItemStatus(item.status, "scheduler.spawn-aborted-entry-restore"),
		statusUpdatedAt: item.statusUpdatedAt,
		phase: item.phase,
		extra: withSchedulerSpawnError(extraWithBackoff, failedAt, attribution, message),
		updatedAt: failedAt,
	})
	console.warn(`coder-loop scheduler: preparation failed for chain=${chain.name} item=${item.id} id=${item.itemId}: ${message}`)
	await emit(options, {
		type: "spawn.aborted",
		slotKey: slot.key,
		chainId: chain.id,
		chainName: chain.name,
		itemId: item.id,
		id: item.itemId,
		reason: message,
		toStatus: item.status,
	})
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
	// #406: the credential minted at spawn for this run, revoked here when the run closes
	// (`completeRun` + `clearCurrentRun` adjacency). `null` when no issuer is wired (test fixtures
	// that bypass the caller-admission gate). Revocation runs even when the close path takes the
	// error branch — the run is no longer active either way.
	credential: SchedulerRunCredential | null,
	credentialContext: SchedulerRunCredentialContext,
): SchedulerPreparingRun {
	let parsedSessionId: string | null = null
	let sessionIdInvalid = false
	let rateLimit = classifyRateLimitFromStdout("")
	const stdoutState = createStreamTextState((line) => {
		if (parsedSessionId === null) parsedSessionId = parseSessionIdFromRunnerStream(runner.kind, `${line}\n`)
		const observed = classifyRateLimitFromStdout(line)
		rateLimit = { code: rateLimit.code ?? observed.code, reset: observed.reset ?? rateLimit.reset }
	})
	const stderrState = createStreamTextState((line) => {
		sessionIdInvalid = sessionIdInvalid || detectsSessionIdInvalid(runner.kind, line)
	})
	const outputPaths = schedulerPhaseOutputPaths(options, chain, runId, phase)
	const outputWriters = createSchedulerPhaseOutputWriters(outputPaths)
	let lifecycleGc: SchedulerRunLifecycleGc | null = null
	let terminatorCleanup: (() => void) | null = null
	let closeMode: "preparing" | "normal" | "preparation-abort" = "preparing"
	let releaseCloseHandler: () => void = () => {}
	const preparationDecided = new Promise<void>((resolve) => {
		releaseCloseHandler = resolve
	})
	const decideCloseMode = (mode: "normal" | "preparation-abort"): void => {
		if (closeMode !== "preparing") throw new Error(`scheduler run ${runId} preparation already decided as ${closeMode}`)
		closeMode = mode
		releaseCloseHandler()
	}

	const closed = new Promise<SchedulerCompletedRun>((resolveClosed, rejectClosed) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutState.observe(chunk)
			writeChunkWithBackpressure(child.stdout!, outputWriters.stdout, chunk)
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrState.observe(chunk)
			writeChunkWithBackpressure(child.stderr!, outputWriters.stderr, chunk)
		})
		child.on("error", (error) => {
			const chunk = Buffer.from(error.message)
			stderrState.observe(chunk)
			for (const writer of outputWriters.stderr) writer.write(chunk)
		})

		const installedGc = installSchedulerRunLifecycleGc(options, child, {
			chain,
			item,
			runId,
			phase,
			stdoutPath: outputPaths.stdoutPath,
			stderrPath: outputPaths.stderrPath,
			startedAt,
		})
		lifecycleGc = installedGc
		terminatorCleanup = installedGc.terminatorCleanup

		child.on("close", (code) => {
			lifecycleGc?.cleanup()

			const pendingCloseHandler = (async (): Promise<SchedulerCompletedRun> => {
				const exitCode = code ?? 1
				stdoutState.finish()
				stderrState.finish()
				const stdoutBytes = stdoutState.bytes()
				const stderrBytes = stderrState.bytes()
				if (closeMode === "preparing") await preparationDecided
				if (closeMode === "preparation-abort") {
					try {
						await closeSchedulerPhaseOutputWriters(outputWriters)
						return {
							runId,
							itemId: item.id,
							chainId: chain.id,
							repoCwd: item.repoCwd,
							exitCode,
							stdoutBytes,
							stderrBytes,
							status: (options.store.getItem(item.id) ?? item).status,
						}
					} finally {
						if (credential !== null) options.runCredentials?.revoke(credential, credentialContext)
					}
				}
				// #478: detect account rate-limit BEFORE the first await so the in-state cooldown
				// gate (`SchedulerState.rateLimitedUntilMs`) is armed synchronously. The next
				// scheduler tick may fire while this close handler is still awaiting artifact
				// writes / status resolution; without the synchronous arm that tick would re-spawn
				// the rate-limited item and burn another attempt slot.
				if (rateLimit.reset !== null) {
					options.state.rateLimitedUntilMs = rateLimit.reset.resetsAt * 1000
				}
				const rateLimitExit = (rateLimit.code !== null && isRateLimitErrorCode(rateLimit.code)) || rateLimit.reset !== null
				const terminalStatuses = new Set((await schedulerStatusesForChain(options, chain)).terminal)
				const currentItem = options.store.getItem(item.id)
				const status = (currentItem ?? item).status
				const endedAt = nowSeconds(options)
				const itemTransitionedToTerminal = !terminalStatuses.has(item.status) && terminalStatuses.has(status)
				options.state.finalizingItemStatuses.set(item.id, status)
				let persistenceStage: RunnerStatusPersistenceFailure["stage"] | null = "status-artifact"
				try {
					await closeSchedulerPhaseOutputWriters(outputWriters)
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
						output: { kind: "streamed", stdoutBytes, stderrBytes },
					})
					persistenceStage = "run-record"
					const completedRun = options.store.getRunByRunId(runId)
					options.store.completeRun(runId, {
						endedAt,
						exitCode,
						status,
						extra: storedItemExtra({
							...(completedRun === null ? {} : itemExtraToJsonObject(completedRun.extra)),
							stdoutBytes,
							stderrBytes,
						}),
					})

					persistenceStage = "current-run"
					const currentRun = options.store.getCurrentRun(chain.id)
					if (currentRun?.runId === runId) options.store.clearCurrentRun(chain.id)
					persistenceStage = null

					if (slot.activeRun?.runId === runId) slot.activeRun = null
					// #530: revoke synchronously alongside activeRun=null so `listActiveRuns`
					// empty and credential-absent are atomic from the event loop's perspective.
					// The `finally` below still runs (Map.delete is idempotent) as safety net.
					if (credential !== null) options.runCredentials?.revoke(credential, credentialContext)
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
					const previousSessionId = (currentItem ?? item).sessionIds[phase]?.[runner.kind] ?? null
					if (currentItem === null || !terminalStatuses.has(currentItem.status)) {
						const itemForBackoff = currentItem ?? item
						const statusWasWrittenDuringRun = currentItem !== null && currentItem.statusUpdatedAt !== item.statusUpdatedAt && currentItem.statusUpdatedAt >= startedAt
						// #478: rate-limit exits do not consume an attempt slot (roll the spawn-time
						// +1 back to the pre-spawn value via explicit `attempts: item.attempts`) and
						// do not enter the blind exponential spawn-failure backoff — the account
						// cooldown is owned by the daemon-level gate. Non-rate-limit exits flow
						// through `extraAfterRunCompletion` exactly as before.
						const extra = rateLimitExit
							? clearItemSchedulerBackoff(itemForBackoff.extra)
							: extraAfterRunCompletion(options, chain, itemForBackoff, exitCode, status, terminalStatuses, endedAt)
						const update: Parameters<typeof options.store.updateItem>[1] = {
							// #397: when the agent wrote a status via the gated `item.update` during the
							// run, the scheduler forwards that same status back into store on the
							// post-run bookkeeping write. The agent-side write already passed the
							// admission gate (see `admitItemStatusForRequest` in daemon.ts), so re-
							// branding here under `scheduler.run-status-forwarded` records that this
							// is engine-internal carry, not a fresh caller-provided write.
							...(statusWasWrittenDuringRun ? { status: engineLifecycleAdmittedItemStatus(status, "scheduler.run-status-forwarded") } : {}),
							...(rateLimitExit ? { attempts: item.attempts } : {}),
							lastRunId: runId,
							agentCwd: worktreePath,
							extra,
							updatedAt: endedAt,
						}
						options.store.updateItem(item.id, update)
					}
					if (rateLimitExit && rateLimit.reset !== null) {
						await emit(options, {
							type: "scheduler.rate_limited",
							ts: nowIso(options),
							chainId: chain.id,
							itemId: item.id,
							runId,
							resetsAt: rateLimit.reset.resetsAt,
							resetAtIso: rateLimit.reset.resetAtIso,
							rateLimitType: rateLimit.reset.rateLimitType,
						})
						await options.onRateLimitObserved?.({ runId, chainId: chain.id, itemId: item.id, reset: rateLimit.reset })
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
							// #419 review I2: rowid carried on `rowId`, not `itemId`.
							rowId: item.id,
							terminalStatus: status,
						})
					}
					await completeChainIfReady(options, chain, runId, [...terminalStatuses])
			return { runId, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, exitCode, stdoutBytes, stderrBytes, status }
				} catch (error) {
					if (slot.activeRun?.runId === runId) slot.activeRun = null
					if (persistenceStage === null) throw error
					const failure: RunnerStatusPersistenceFailure = {
						path: "scheduler",
						stage: persistenceStage,
						runId,
						phase,
						persistencePath: persistenceStage === "status-artifact"
							? resolveChainRuntimePaths(chain.name, options.loopDataRootOptions).runStatusFile(runId)
							: resolveLoopDataPaths(options.loopDataRootOptions).dbFile,
						error: error instanceof Error ? error.message : String(error),
						chainId: chain.id,
						itemId: item.id,
					}
					options.onRunnerStatusPersistenceFailure?.(failure)
					throw new RunnerStatusPersistenceError(failure)
				} finally {
					options.state.finalizingItemStatuses.delete(item.id)
					// #406: revoke the run credential exactly once per run close. Composing with
					// #417's double GC: this path runs after the natural close; explicit
					// `terminateAllActiveRuns` (e.g. daemon shutdown) drives child exit through the
					// same close event so this same `finally` runs. The supplier is responsible for
					// idempotency if a revoke ever arrives twice.
					if (credential !== null) options.runCredentials?.revoke(credential, credentialContext)
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
	const abortPreparation = (options?: SchedulerRunTerminateOptions): Promise<SchedulerCompletedRun> => {
		decideCloseMode("preparation-abort")
		return terminate(options)
	}
	const markPrepared = (): void => decideCloseMode("normal")
	return { runId, pid: child.pid ?? null, itemId: item.id, chainId: chain.id, repoCwd: item.repoCwd, worktreePath, startedAt, closed, terminate, markPrepared, abortPreparation }
}

type SchedulerPhaseOutputPaths = {
	stdoutPath: string
	stderrPath: string
	runStdoutPath: string
	runStderrPath: string
}

type SchedulerPhaseOutputWriters = {
	stdout: readonly WriteStream[]
	stderr: readonly WriteStream[]
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
		runStdoutPath: paths.runStdoutFile(runId),
		runStderrPath: paths.runStderrFile(runId),
	}
}

function createSchedulerPhaseOutputWriters(paths: SchedulerPhaseOutputPaths): SchedulerPhaseOutputWriters {
	return {
		stdout: [createWriteStream(paths.stdoutPath, { flags: "a" }), createWriteStream(paths.runStdoutPath, { flags: "a" })],
		stderr: [createWriteStream(paths.stderrPath, { flags: "a" }), createWriteStream(paths.runStderrPath, { flags: "a" })],
	}
}

function writeChunkWithBackpressure(source: NodeJS.ReadableStream, writers: readonly WriteStream[], chunk: Buffer): void {
	const blocked = writers.filter((writer) => !writer.write(chunk))
	if (blocked.length === 0) return
	source.pause()
	void Promise.all(blocked.map((writer) => new Promise<void>((resolveDrain) => writer.once("drain", resolveDrain))))
		.then(() => source.resume())
}

async function closeSchedulerPhaseOutputWriters(writers: SchedulerPhaseOutputWriters): Promise<void> {
	await Promise.all([...writers.stdout, ...writers.stderr].map(closeWriteStream))
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

function combineCleanup(existing: (() => void) | null, next: () => void): () => void {
	return () => {
		if (existing !== null) existing()
		next()
	}
}

// #462: helper for opt-in env override of startup idle watchdog knobs. Rejects everything
// that is not a positive finite integer (negatives / zero / NaN / floats / empty string),
// so a stray export (`STARTUP_IDLE_TIMEOUT_MS=abc`) never silently degrades the default.
function envPositiveIntOrNull(name: string): number | null {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return null
	const value = Number(raw)
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null
	return value
}

type SchedulerRunLifecycleGc = {
	cleanup: () => void
	terminatorCleanup: (() => void) | null
}

// #452 lifecycle GC. The retired stdout-driven summary watchdog used to live here; the
// replacement is a recycle zone armed by the daemon via `markRunPendingRecycle(runId)`.
//
// Two parallel timers:
//   1. Attempt timeout (`attemptTimeoutMs`) — unchanged baseline floor. Catches runs that
//      never write state AND never exit. SIGTERM, then SIGKILL after `attemptKillMs`.
//   2. Recycle zone (`recycleAfterStateWriteMs`) — armed only when the daemon calls
//      `markRunPendingRecycle(context.runId)`. From arm, the child has `recycleAfterMs`
//      to exit naturally. If it does, the close handler emits `recycle.natural_exit`.
//      If it doesn't, the engine SIGKILLs the process group via
//      `sendSignalToChildProcessGroup` and emits `recycle.timeout_kill`. The SIGKILL goes
//      directly (no SIGTERM first) because the agent has already declared completion by
//      writing state — the only reason it is still alive is wedge / cleanup loop.
//
// stdout content is read for nothing in this function — acceptance row 4's "stdout 内容
// （含伪造标签）零影响" is guaranteed by absence of any stdout observer here.
function installSchedulerRunLifecycleGc(
	options: SchedulerOptions,
	child: ReturnType<typeof spawn>,
	context: {
		chain: ChainRecord
		item: ItemRecord
		runId: string
		phase: string
		stdoutPath: string
		stderrPath: string
		startedAt: number
	},
): SchedulerRunLifecycleGc {
	const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS
	const attemptKillMs = options.attemptKillMs ?? ATTEMPT_KILL_MS
	const recycleAfterMs = options.recycleAfterStateWriteMs ?? RECYCLE_AFTER_STATE_WRITE_MS
	const recycleKillGraceMs = options.recycleKillGraceMs ?? RECYCLE_KILL_GRACE_MS
	type LifecyclePhase = "running" | "recycling" | "killing" | "settled"
	let lifecyclePhase: LifecyclePhase = "running"
	let lifecycleCleanup: (() => void) | null = null
	const addLifecycleCleanup = (cleanup: () => void): void => {
		lifecycleCleanup = combineCleanup(lifecycleCleanup, cleanup)
	}

	// Attempt timeout (preserved as the time-based fallback floor — acceptance row 4).
	let attemptTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		attemptTimer = null
		if (child.exitCode !== null || child.signalCode !== null) return
		sendSignalToChildProcessGroup(child, "SIGTERM")
		emitTimerOwnedLifecycleEvent(options, emitSchedulerTimeoutEvent(options, context, "SIGTERM", attemptTimeoutMs))
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				sendSignalToChildProcessGroup(child, "SIGKILL")
				emitTimerOwnedLifecycleEvent(options, emitSchedulerTimeoutEvent(options, context, "SIGKILL", attemptTimeoutMs))
			}
		}, attemptKillMs)
		addLifecycleCleanup(() => clearTimeout(killTimer))
	}, attemptTimeoutMs)

	addLifecycleCleanup(() => { if (attemptTimer !== null) { clearTimeout(attemptTimer); attemptTimer = null } })

	// #462 startup idle watchdog. Semantics documented at STARTUP_IDLE_TIMEOUT_MS. Resolved
	// in precedence order: SchedulerOptions override → env knob → engine default.
	//   CODER_LOOP_STARTUP_IDLE_TIMEOUT_MS   — override the 10 min default
	//   CODER_LOOP_STARTUP_IDLE_PROGRESS_BYTES — override the 200 B threshold
	// The kill grace is options-only (test wiring); production keeps STARTUP_IDLE_KILL_MS.
	// Listens to stdout only — stderr is intentionally excluded so #463's RUST_LOG output
	// (which streams to stderr from spawn) does not neutralize the watchdog.
	const startupIdleTimeoutMs = options.startupIdleTimeoutMs
		?? envPositiveIntOrNull("CODER_LOOP_STARTUP_IDLE_TIMEOUT_MS")
		?? STARTUP_IDLE_TIMEOUT_MS
	const startupIdleProgressBytes = options.startupIdleProgressBytes
		?? envPositiveIntOrNull("CODER_LOOP_STARTUP_IDLE_PROGRESS_BYTES")
		?? STARTUP_IDLE_PROGRESS_BYTES
	const startupIdleKillMs = options.startupIdleKillMs ?? STARTUP_IDLE_KILL_MS
	let startupStdoutBytes = 0
	let startupIdleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		startupIdleTimer = null
		if (child.exitCode !== null || child.signalCode !== null) return
		const event: SchedulerTimerLifecycleEvent = {
			type: "run.startup_idle_kill",
			ts: nowIso(options),
			runId: context.runId,
			chainId: context.chain.id,
			itemId: context.item.id,
			phase: context.phase,
			idleTimeoutMs: startupIdleTimeoutMs,
			stdoutBytes: startupStdoutBytes,
		}
		sendSignalToChildProcessGroup(child, "SIGTERM")
		emitTimerOwnedLifecycleEvent(options, emit(options, event), event)
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) sendSignalToChildProcessGroup(child, "SIGKILL")
		}, startupIdleKillMs)
		addLifecycleCleanup(() => clearTimeout(killTimer))
	}, startupIdleTimeoutMs)
	child.stdout?.on("data", (chunk: Buffer) => {
		if (startupIdleTimer === null) return
		startupStdoutBytes += chunk.byteLength
		if (startupStdoutBytes >= startupIdleProgressBytes) {
			// Permanent disarm: orchestrator wait_agent gaps up to 1800s are legitimate,
			// re-arming after progress would inevitably mis-fire on healthy long runs.
			clearTimeout(startupIdleTimer)
			startupIdleTimer = null
		}
	})
	addLifecycleCleanup(() => {
		if (startupIdleTimer !== null) {
			clearTimeout(startupIdleTimer)
			startupIdleTimer = null
		}
	})

	// Recycle zone arm trigger — registered against runId so the daemon's `handleItemUpdate`
	// can fire it after a successful agent-attributed status write. Idempotent against
	// re-arming: once `recycling` has begun, further calls are no-ops.
	let recycleTimer: ReturnType<typeof setTimeout> | null = null
	let recycleKillTimer: ReturnType<typeof setTimeout> | null = null
	let recycleEnteredAtMs: number | null = null
	const armRecycle = (): void => {
		if (lifecyclePhase !== "running") return
		lifecyclePhase = "recycling"
		recycleEnteredAtMs = Date.now()
		// The attempt-timeout fallback no longer applies once the agent has signalled
		// completion via the state write — recycle owns the timeline from here.
		if (attemptTimer !== null) { clearTimeout(attemptTimer); attemptTimer = null }
		const pendingEvent: SchedulerTimerLifecycleEvent = {
			type: "recycle.pending_entered",
			ts: nowIso(options),
			runId: context.runId,
			chainId: context.chain.id,
			itemId: context.item.id,
			phase: context.phase,
			recycleAfterMs,
		}
		recycleTimer = setTimeout(() => {
			recycleTimer = null
			if (child.exitCode !== null || child.signalCode !== null) return
			lifecyclePhase = "killing"
			sendSignalToChildProcessGroup(child, "SIGKILL")
			emitTimerOwnedLifecycleEvent(options, emitSchedulerRecycleTimeoutKillEvent(options, context, recycleAfterMs))
			recycleKillTimer = setTimeout(() => {
				recycleKillTimer = null
				if (child.exitCode === null && child.signalCode === null) {
					sendSignalToChildProcessGroup(child, "SIGKILL")
				}
			}, recycleKillGraceMs)
		}, recycleAfterMs)
		emitTimerOwnedLifecycleEvent(options, emit(options, pendingEvent), pendingEvent)
	}
	options.state.recycleTriggers.set(context.runId, armRecycle)

	addLifecycleCleanup(() => {
		options.state.recycleTriggers.delete(context.runId)
		if (recycleTimer !== null) { clearTimeout(recycleTimer); recycleTimer = null }
		if (recycleKillTimer !== null) { clearTimeout(recycleKillTimer); recycleKillTimer = null }
		// Natural exit (or any non-timeout close) while recycle was armed — emit the
		// `recycle.natural_exit` classifier so the lifecycle stream can distinguish it from
		// `recycle.timeout_kill`. Killing-state exits are already classified by the
		// timeout-kill event emitted above; do not double-emit.
		if (lifecyclePhase === "recycling" && recycleEnteredAtMs !== null) {
			const elapsedMs = Math.max(0, Date.now() - recycleEnteredAtMs)
			const naturalExitEvent: SchedulerTimerLifecycleEvent = {
				type: "recycle.natural_exit",
				ts: nowIso(options),
				runId: context.runId,
				chainId: context.chain.id,
				itemId: context.item.id,
				phase: context.phase,
				elapsedMs,
			}
			emitTimerOwnedLifecycleEvent(options, emit(options, naturalExitEvent), naturalExitEvent)
		}
		lifecyclePhase = "settled"
	})

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
	const event: SchedulerTimerLifecycleEvent = {
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
	}
	try {
		await emit(options, event)
	} catch (error) {
		throw new SchedulerLifecycleEventPersistenceError(event, error)
	}
}

function emitTimerOwnedLifecycleEvent(
	options: SchedulerOptions,
	persistence: Promise<void>,
	knownEvent?: SchedulerTimerLifecycleEvent,
): void {
	void persistence.catch((error: unknown) => {
		const event = knownEvent ?? timerLifecycleEventFromPersistenceError(error)
		const failure = { event, error: errorMessage(error) }
		options.state.lifecycleEventPersistenceFailures.push(failure)
		options.onLifecycleEventPersistenceFailure?.(failure)
	})
}

class SchedulerLifecycleEventPersistenceError extends Error {
	constructor(readonly event: SchedulerTimerLifecycleEvent, cause: unknown) {
		super(errorMessage(cause), { cause })
		this.name = "SchedulerLifecycleEventPersistenceError"
	}
}

function timerLifecycleEventFromPersistenceError(error: unknown): SchedulerTimerLifecycleEvent {
	if (error instanceof SchedulerLifecycleEventPersistenceError) return error.event
	throw error
}

// #452 recycle-zone fire event. SIGKILL-only because the agent has already declared
// completion via the state write; SIGTERM-first would just delay the inevitable for an
// already-acknowledged-done process.
async function emitSchedulerRecycleTimeoutKillEvent(
	options: SchedulerOptions,
	context: {
		chain: ChainRecord
		item: ItemRecord
		runId: string
		phase: string
		stdoutPath: string
		stderrPath: string
	},
	recycleAfterMs: number,
): Promise<void> {
	const event: SchedulerTimerLifecycleEvent = {
		type: "recycle.timeout_kill",
		ts: nowIso(options),
		runId: context.runId,
		chainId: context.chain.id,
		itemId: context.item.id,
		phase: context.phase,
		signal: "SIGKILL",
		recycleAfterMs,
		excerpt: await collectObservabilityExcerpt({
			stdoutPath: context.stdoutPath,
			stderrPath: context.stderrPath,
		}),
	}
	try {
		await emit(options, event)
	} catch (error) {
		throw new SchedulerLifecycleEventPersistenceError(event, error)
	}
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
		options.store.updateItem(item.id, {
			status: engineLifecycleAdmittedItemStatus(chainStatuses.entry, "scheduler.dependency-unblock-restore"),
			extra: nextExtra,
			updatedAt: nowSeconds(options),
		})
		await emit(options, {
			type: "item.dependency_unblocked",
			chainId: chain.id,
			// #419 review I2: rowid carried on `rowId`. `itemId` on the audit wire is reserved for
			// the opaque string identity (this event currently only ships the rowid; the string
			// identity is available via the item record on the consumer side if needed).
			rowId: item.id,
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
	// #456: the legacy `reviewOnEmptyLockExistsForChain` gate is retired with the review-on-empty
	// path. Chain-drain side effects (the bundled gh-issue-pr-iteration umbrella finalizer, for
	// example) now flow through `chainCompletionTriggerAllowsCompletion` below — the preset declares
	// `trigger = { on = "chain-complete" }` and `runPresetChainCompleteTriggerPhases` runs them with
	// `keep-active` semantics that delay completion as long as the trigger demands it.
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
			metadata: chainMetadataForFingerprint(chain.metadata),
		},
		terminalStatuses: [...terminalStatuses].sort(),
		items: items
			.map((item) => ({
				id: item.id,
				// #419: fingerprint replaces `issueNumber` (integer) with the opaque preset
				// `itemId` string and removes the top-level `branch` / `pr` projections —
				// presets that need them declare them in `[item.fields]` and they round-trip
				// through the included `extra` JSON, so a chain-complete decision driven by
				// branch/pr churn still sees them inside `extra` and the fingerprint covers it.
				itemId: item.itemId,
				repoCwd: item.repoCwd,
				status: item.status,
				attempts: item.attempts,
				title: item.title,
				priority: item.priority,
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

function withSchedulerSpawnError(
	extra: ItemRecord["extra"],
	failedAt: number,
	attribution: SchedulerSpawnErrorAttribution,
	message: string,
): ItemRecord["extra"] {
	const error: SchedulerSpawnError = { at: failedAt, attribution, message }
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

// #456: the chain-drain auto-fire family (the dispatch / representative-item / fallback-item /
// spawn / close-handler functions, the related constants, lock helpers and run-id factory) is
// retired. Side effects on chain-drain flow exclusively through the preset-declared
// `trigger = { on = "chain-complete" }` phases, driven by
// `chainCompletionTriggerAllowsCompletion` → `runPresetChainCompleteTriggerPhases`. The bundled
// gh-issue-pr-iteration preset's `umbrella-finalizer` phase, declared with
// `trigger = { on = "chain-complete" }`, gives bundled chains the same drain behavior they had
// before the role-named auto-fire path existed.

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

function invocationAuthorization(chain: ChainRecord, item: ItemRecord, agentCwd: string, presetDir: string, loopDataRoot: string): RunnerFilesystemAuthorization {
	const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot })
	return buildRunnerFilesystemAuthorization({
		agentCwd,
		presetDir,
		loopDataRoot,
		sharedContextPath: chainPaths.sharedFile,
		currentIssueFile: resolveOptionalItemIssueFile(item, chainPaths.chainRoot) ?? "",
		issueDir: chainPaths.issuesDir,
		evidenceDir: resolveItemEvidenceDir(item, chainPaths.chainRoot, chainPaths.issueEvidenceDir(item.itemId)),
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
		daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
	})
}

export type SchedulerPromptRenderInput = {
	rawPrompt: string
	preset: Preset
	phase: string
	chain: ChainRecord
	item: ItemRecord
	runId: string
	worktreePath: string
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
	loopDataRootOptions?: LoopDataRootOptions | undefined
	resume?: ResumeDecision
	runner?: AgentRunnerKind
}): ResolveContext {
	const chainPaths = resolveChainRuntimePaths(input.chain.name, input.loopDataRootOptions)
	const evidenceDir = resolveItemEvidenceDir(input.item, chainPaths.chainRoot, chainPaths.issueEvidenceDir(input.item.itemId))
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
		// #404: placeholders only — actual values are computed lazily by
		// `resolvePhaseBinding` from `(phase, preset, ctx)`. Mirrors the
		// existing pattern for `runtimeInputsDoc` / `phaseExitsDoc`.
		statusVocabularyDoc: "",
		triggerStatusDoc: "",
		terminalStatusesDoc: "",
		retryStatusDoc: "",
		runIdGeneration: resumedSessionId === "" ? "new" : "resumed",
		resumedFromPhase: resumedSessionId === "" ? "" : input.phase.name,
		resumedStartedAt: "",
		resumedSessionId,
		chainName: input.chain.name,
		repoCwd: input.item.repoCwd,
	}
	const chain = buildRenderBindings({
		bindings: buildSchedulerChainBindings(input.chain),
	})
	return { item: input.item, chain, runtime, preset: input.preset }
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
		output:
			| { kind: "streamed"; stdoutBytes: number; stderrBytes: number }
			| { kind: "inline"; stdoutText: string; stderrText: string }
	},
): Promise<void> {
	const paths = resolveChainRuntimePaths(input.chain.name, options.loopDataRootOptions)
	await mkdir(paths.runDir(input.runId), { recursive: true })
	await mkdir(paths.runPhaseDir(input.runId, input.phase), { recursive: true })
	const stdoutBytes = input.output.kind === "streamed" ? input.output.stdoutBytes : Buffer.byteLength(input.output.stdoutText)
	const stderrBytes = input.output.kind === "streamed" ? input.output.stderrBytes : Buffer.byteLength(input.output.stderrText)
	const inlineWrites = input.output.kind === "streamed" ? [] : [
		writeFile(paths.runStdoutFile(input.runId), input.output.stdoutText),
		writeFile(paths.runStderrFile(input.runId), input.output.stderrText),
		writeFile(paths.runPhaseStdoutFile(input.runId, input.phase), input.output.stdoutText),
		writeFile(paths.runPhaseStderrFile(input.runId, input.phase), input.output.stderrText),
	]
	await Promise.all([
		...inlineWrites,
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
			stdoutBytes,
			stderrBytes,
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
		// #419: split rowid (`rowId`) and opaque preset id (`itemId`). `itemId` was the rowid
		// pre-#419; both fields now travel so supervisor consumers see one consistent shape.
		rowId: input.item.id,
		itemId: input.item.itemId,
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
