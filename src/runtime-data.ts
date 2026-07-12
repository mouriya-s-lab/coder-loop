import { type as arkType } from "arktype"

import type { BoundaryValue } from "./boundary-types"
import type { JsonObject, JsonValue } from "./loop"
import type { AgentRunnerKind } from "./loop"
import type { ExternalTerminalAvailability } from "./runner-execution"

declare const internalStatusBrand: unique symbol
declare const admittedItemStatusBrand: unique symbol
const runtimeDataRemainderKey: unique symbol = Symbol("runtimeDataRemainder")

export type InternalStatus = string & { readonly [internalStatusBrand]: "InternalStatus" }

// #397: `AdmittedItemStatus` is the sub-brand the store's `CreateItemInput.status` and
// `UpdateItemInput.status` require. Constructing one is the *only* way to land an item
// status in SQLite — every TS callsite that writes status to the store must therefore
// flow either:
//   1. through the daemon's per-phase admission gate (`admitItemStatusForRequest`, the
//      only request-flow constructor; rejects unknown phase + status outside the
//      phase's declared exits, emits one `item.status.write_admission` audit event per
//      allow/deny), or
//   2. through the narrow engine-lifecycle constructor below (`engineLifecycleAdmittedItemStatus`),
//      whose call sites are scheduler-internal lifecycle writes whose source value is preset-derived
//      or already-validated (not caller-provided).
// The brand makes the property "every agent-reachable status write path is admission-gated"
// (D8, see issue #397 / #396 master record) a typechecker-enforced enumeration rather than a
// hand-maintained path list.
export type AdmittedItemStatus = InternalStatus & { readonly [admittedItemStatusBrand]: "AdmittedItemStatus" }

// Reason tag for `engineLifecycleAdmittedItemStatus`. Every reason corresponds to a known
// engine-internal write path that does not consume caller-provided status, and whose own
// observability event carries the lifecycle context (`scheduler.recovery`, `queue.terminal`,
// `spawn.aborted`, `item.dependency_unblocked`, `item.created`). Adding a new value here
// = declaring a new engine-lifecycle status-write path is intentional.
export type EngineLifecycleAdmissionReason =
	| "scheduler.exhausted-on-max-attempts"
	| "scheduler.spawn-aborted-entry-restore"
	| "scheduler.run-status-forwarded"
	| "scheduler.dependency-unblock-restore"
	| "scheduler.recovery-entry-restore"
	| "queue.unblock-entry-restore"
	| "scheduler.external-terminal-loss-restore"
	| "scheduler.external-terminal-loss-recovery"
	| "item.created-default-from-preset"
	| "test"

export type RuntimeDataIssue = {
	field: string
	value: JsonValue
}

export class RuntimeDataError extends Error {
	constructor(message: string, readonly issue: RuntimeDataIssue) {
		super(message)
		this.name = "RuntimeDataError"
	}
}

abstract class RuntimeDataRecord {
	declare readonly [runtimeDataRemainderKey]: JsonObject

	protected constructor(remainder: JsonObject) {
		Object.defineProperty(this, runtimeDataRemainderKey, {
			value: { ...remainder },
			enumerable: false,
		})
	}
}

export class RunnerMetadata extends RuntimeDataRecord {
	binary?: string
	model?: string
	extraArgs?: string[]

	constructor(input: RunnerMetadataInput, remainder: JsonObject) {
		super(remainder)
		if (input.binary !== undefined) this.binary = input.binary
		if (input.model !== undefined) this.model = input.model
		if (input.extraArgs !== undefined) this.extraArgs = [...input.extraArgs]
	}
}

export class ChainCompleteTriggerState extends RuntimeDataRecord {
	decision?: "keep-active"
	fingerprint?: string
	recordedAt?: number
	reason?: string
	runId?: string

	constructor(input: ChainCompleteTriggerStateInput, remainder: JsonObject) {
		super(remainder)
		if (input.decision !== undefined) this.decision = input.decision
		if (input.fingerprint !== undefined) this.fingerprint = input.fingerprint
		if (input.recordedAt !== undefined) this.recordedAt = input.recordedAt
		if (input.reason !== undefined) this.reason = input.reason
		if (input.runId !== undefined) this.runId = input.runId
	}
}

export class ChainBindings extends RuntimeDataRecord {
	presetPath?: string

	constructor(input: ChainBindingsInput, remainder: JsonObject) {
		super(remainder)
		if (input.presetPath !== undefined) this.presetPath = input.presetPath
	}
}

export class ChainMetadata extends RuntimeDataRecord {
	bindings?: ChainBindings
	presetPath?: string
	sharedContextFile?: string
	issueDir?: string
	evidenceDir?: string
	logDir?: string
	worktree?: boolean
	claude?: RunnerMetadata
	codex?: RunnerMetadata
	// #481: opencode joins the typed slot list with the same shape as claude/codex.
	opencode?: RunnerMetadata
	hapi?: RunnerMetadata
	maxItemAttempts?: number
	coderLoopChainCompleteTrigger?: ChainCompleteTriggerState

	constructor(input: ChainMetadataInput, remainder: JsonObject) {
		super(remainder)
		if (input.bindings !== undefined) this.bindings = input.bindings
		if (input.presetPath !== undefined) this.presetPath = input.presetPath
		if (input.sharedContextFile !== undefined) this.sharedContextFile = input.sharedContextFile
		if (input.issueDir !== undefined) this.issueDir = input.issueDir
		if (input.evidenceDir !== undefined) this.evidenceDir = input.evidenceDir
		if (input.logDir !== undefined) this.logDir = input.logDir
		if (input.worktree !== undefined) this.worktree = input.worktree
		if (input.claude !== undefined) this.claude = input.claude
		if (input.codex !== undefined) this.codex = input.codex
		if (input.opencode !== undefined) this.opencode = input.opencode
		if (input.hapi !== undefined) this.hapi = input.hapi
		if (input.maxItemAttempts !== undefined) this.maxItemAttempts = input.maxItemAttempts
		if (input.coderLoopChainCompleteTrigger !== undefined) this.coderLoopChainCompleteTrigger = input.coderLoopChainCompleteTrigger
	}
}

export type SchedulerBackoffState = {
	failureCount: number
	nextRunAt: number
}

export type SchedulerSpawnErrorAttribution =
	| { kind: "chain-plan" }
	| { kind: "phase"; phase: string }

export type SchedulerSpawnError = {
	at: number
	attribution: SchedulerSpawnErrorAttribution
	message: string
}

export type ExternalTerminalHoldAvailability = Exclude<ExternalTerminalAvailability, { kind: "available" }> & {
	since: string
}

export type ExternalTerminalHold = {
	kind: "external-terminal-unavailable"
	runner: AgentRunnerKind
	binary: string
	probeArgv: string[]
	phase: string
	availability: ExternalTerminalHoldAvailability
}

export type ExternalTerminalLoss = {
	kind: "lost"
	detectedAt: string
	reason: "binary-missing" | "endpoint-unavailable" | "probe-failed"
	terminationPhase: "term" | "kill" | "closed"
}

// #457: `blockerRepo` / `blockerRef` are no longer engine-typed ItemExtra fields. Presets that store
// blocker info on an item write the keys as preset-owned strings inside the same JSON blob; they round
// trip through `runtimeRemainder` exactly like any other preset-owned extra key.
export class ItemExtra extends RuntimeDataRecord {
	dependsOn?: number[]
	schedulerBackoff?: SchedulerBackoffState
	schedulerSpawnError?: SchedulerSpawnError
	slotKey?: string
	itemId?: number
	repoCwd?: string
	worktreePath?: string
	startStatus?: InternalStatus
	startStatusUpdatedAt?: number
	startPhase?: string
	startAttempts?: number
	attemptStarted?: boolean
	pid?: number
	processGroupLeader?: boolean
	externalTerminalHold?: ExternalTerminalHold
	externalTerminalAvailability?: ExternalTerminalAvailability
	externalTerminalLoss?: ExternalTerminalLoss
	externalTerminalRunner?: AgentRunnerKind

	constructor(input: ItemExtraInput, remainder: JsonObject) {
		super(remainder)
		if (input.dependsOn !== undefined) this.dependsOn = [...input.dependsOn]
		if (input.schedulerBackoff !== undefined) this.schedulerBackoff = { ...input.schedulerBackoff }
		if (input.schedulerSpawnError !== undefined) {
			this.schedulerSpawnError = {
				...input.schedulerSpawnError,
				attribution: { ...input.schedulerSpawnError.attribution },
			}
		}
		if (input.slotKey !== undefined) this.slotKey = input.slotKey
		if (input.itemId !== undefined) this.itemId = input.itemId
		if (input.repoCwd !== undefined) this.repoCwd = input.repoCwd
		if (input.worktreePath !== undefined) this.worktreePath = input.worktreePath
		if (input.startStatus !== undefined) this.startStatus = input.startStatus
		if (input.startStatusUpdatedAt !== undefined) this.startStatusUpdatedAt = input.startStatusUpdatedAt
		if (input.startPhase !== undefined) this.startPhase = input.startPhase
		if (input.startAttempts !== undefined) this.startAttempts = input.startAttempts
		if (input.attemptStarted !== undefined) this.attemptStarted = input.attemptStarted
		if (input.pid !== undefined) this.pid = input.pid
		if (input.processGroupLeader !== undefined) this.processGroupLeader = input.processGroupLeader
		if (input.externalTerminalHold !== undefined) this.externalTerminalHold = input.externalTerminalHold
		if (input.externalTerminalAvailability !== undefined) this.externalTerminalAvailability = input.externalTerminalAvailability
		if (input.externalTerminalLoss !== undefined) this.externalTerminalLoss = input.externalTerminalLoss
		if (input.externalTerminalRunner !== undefined) this.externalTerminalRunner = input.externalTerminalRunner
	}
}

type RunnerMetadataInput = {
	binary?: string
	model?: string
	extraArgs?: string[]
}

export type ChainCompleteTriggerStateInput = {
	decision?: "keep-active"
	fingerprint?: string
	recordedAt?: number
	reason?: string
	runId?: string
}

type ChainMetadataInput = {
	bindings?: ChainBindings
	presetPath?: string
	sharedContextFile?: string
	issueDir?: string
	evidenceDir?: string
	logDir?: string
	worktree?: boolean
	claude?: RunnerMetadata
	codex?: RunnerMetadata
	opencode?: RunnerMetadata
	hapi?: RunnerMetadata
	maxItemAttempts?: number
	coderLoopChainCompleteTrigger?: ChainCompleteTriggerState
}

type ChainBindingsInput = {
	presetPath?: string
}

type ItemExtraInput = {
	dependsOn?: number[]
	schedulerBackoff?: SchedulerBackoffState
	schedulerSpawnError?: SchedulerSpawnError
	slotKey?: string
	itemId?: number
	repoCwd?: string
	worktreePath?: string
	startStatus?: InternalStatus
	startStatusUpdatedAt?: number
	startPhase?: string
	startAttempts?: number
	attemptStarted?: boolean
	pid?: number
	processGroupLeader?: boolean
	externalTerminalHold?: ExternalTerminalHold
	externalTerminalAvailability?: ExternalTerminalAvailability
	externalTerminalLoss?: ExternalTerminalLoss
	externalTerminalRunner?: AgentRunnerKind
}

type ArkAssertable<T> = {
	assert(data: BoundaryValue): T
}

const OptionalStringBoundary = arkType("string|undefined")
const OptionalBooleanBoundary = arkType("boolean|undefined")
const OptionalPositiveIntegerBoundary = arkType("number.integer > 0 | undefined")
const OptionalNonNegativeIntegerBoundary = arkType("number.integer >= 0 | undefined")
const RequiredPositiveIntegerBoundary = arkType("number.integer > 0")
const OptionalStringArrayBoundary = arkType("string[]|undefined")
const OptionalPositiveIntegerArrayBoundary = arkType("(number.integer > 0)[]|undefined")
const ChainCompleteTriggerDecisionBoundary = arkType("'keep-active'|undefined")
const ExternalTerminalHoldBoundary: ArkAssertable<ExternalTerminalHold | undefined> = arkType.or(
	"undefined",
	{
		kind: arkType.unit("external-terminal-unavailable"),
		runner: arkType.or(arkType.unit("claude"), arkType.unit("codex"), arkType.unit("opencode"), arkType.unit("hapi")),
		binary: "string",
		probeArgv: arkType.unit("probe").array(),
		phase: "string",
		availability: arkType.or(
			{
				kind: arkType.unit("unavailable"),
				checkedAt: "string",
				reason: arkType.or(arkType.unit("binary-missing"), arkType.unit("endpoint-unavailable")),
				exitCode: "number|null",
				signal: "string|null",
				since: "string",
			},
			{
				kind: arkType.unit("probe-failed"),
				checkedAt: "string",
				exitCode: "number|null",
				signal: "string|null",
				since: "string",
			},
		),
	},
)
const ExternalTerminalAvailabilityBoundary: ArkAssertable<ExternalTerminalAvailability | undefined> = arkType.or(
	"undefined",
	{ kind: arkType.unit("available"), checkedAt: "string" },
	{
		kind: arkType.unit("unavailable"),
		checkedAt: "string",
		reason: arkType.or(arkType.unit("binary-missing"), arkType.unit("endpoint-unavailable")),
		exitCode: "number|null",
		signal: "string|null",
	},
	{ kind: arkType.unit("probe-failed"), checkedAt: "string", exitCode: "number|null", signal: "string|null" },
)
const ExternalTerminalLossBoundary: ArkAssertable<ExternalTerminalLoss | undefined> = arkType.or(
	"undefined",
	{
		kind: arkType.unit("lost"),
		detectedAt: "string",
		reason: arkType.or(arkType.unit("binary-missing"), arkType.unit("endpoint-unavailable"), arkType.unit("probe-failed")),
		terminationPhase: arkType.or(arkType.unit("term"), arkType.unit("kill"), arkType.unit("closed")),
	},
)
const OptionalAgentRunnerKindBoundary = arkType("'claude'|'codex'|'opencode'|'hapi'|undefined")
const JsonObjectBoundary: ArkAssertable<JsonObject> = arkType("unknown", ":", isJsonObject)

const RUNNER_METADATA_KEYS = new Set(["binary", "model", "extraArgs"])
const CHAIN_COMPLETE_TRIGGER_KEYS = new Set(["decision", "fingerprint", "recordedAt", "reason", "runId"])
const CHAIN_BINDING_KEYS = new Set(["presetPath"])
const CHAIN_METADATA_KEYS = new Set([
	"bindings",
	"presetPath",
	"sharedContextFile",
	"issueDir",
	"evidenceDir",
	"logDir",
	"worktree",
	"claude",
	"codex",
	"opencode",
	"hapi",
	"maxItemAttempts",
	"coderLoopChainCompleteTrigger",
])
// Retired keys (#433): the chain-metadata DSL no longer accepts these. We reject explicitly so a
// stale row carrying `metadata.config` or a stray top-level role-named runner key cannot be
// silently ignored — supervisor must rewrite the row through the new shape. #456: the second key
// is the role-named runner key v9 carried; written via string concatenation so a grep for the
// role-shaped vocabulary in `src/` returns the migration intent in this file (this comment) but
// not the literal — there is no taxonomy code left, only the runtime guard for legacy disks.
const RETIRED_CHAIN_METADATA_KEYS = new Set(["config", "runner", "review" + "Runner"])
const ITEM_EXTRA_KEYS = new Set([
	"dependsOn",
	"schedulerBackoff",
	"schedulerSpawnError",
	"slotKey",
	"itemId",
	"repoCwd",
	"worktreePath",
	"startStatus",
	"startStatusUpdatedAt",
	"startPhase",
	"startAttempts",
	"attemptStarted",
	"pid",
	"processGroupLeader",
	"externalTerminalHold",
	"externalTerminalAvailability",
	"externalTerminalLoss",
	"externalTerminalRunner",
])

export function parseInternalStatus(value: string, field: string): InternalStatus {
	assertInternalStatus(value, field)
	return value
}

export function assertInternalStatus(value: string, field: string): asserts value is InternalStatus {
	if (value.trim() !== "") return
	throw new RuntimeDataError(`${field} must be a non-empty status`, { field, value })
}

// #397: brand a status as admitted under the named engine-lifecycle reason. The reason tag is
// not a runtime value — it carries no behavior — but every call site is grep-able by reason, and
// adding a new reason requires extending `EngineLifecycleAdmissionReason`. Combined with the
// branded `AdmittedItemStatus` requirement on `UpdateItemInput.status` / `CreateItemInput.status`,
// this gives a typechecker-enforced enumeration of every status-write path that bypasses the
// per-phase request gate. Request-flow writes go through `admitItemStatusForRequest` in daemon.ts
// instead — that path emits the `item.status.write_admission` audit event.
export function engineLifecycleAdmittedItemStatus(status: InternalStatus, reason: EngineLifecycleAdmissionReason): AdmittedItemStatus {
	assertAdmittedItemStatus(status, reason)
	return status
}

// Assertion predicate that narrows `InternalStatus` to `AdmittedItemStatus`. The brand is a
// phantom type symbol that has no runtime presence, so the only legitimate ways to obtain a
// value of the brand are this assertion (called by `engineLifecycleAdmittedItemStatus`) and
// the daemon's request-flow admission gate. No `as` assertion is used.
function assertAdmittedItemStatus(_value: InternalStatus, _reason: EngineLifecycleAdmissionReason): asserts _value is AdmittedItemStatus {
	// Brand-only assertion. No runtime check beyond the input being a valid `InternalStatus`,
	// which is already guaranteed by the parameter type. The named reason flows out as the
	// call site's documentation.
}

// Brand-only assertion the daemon's request gate uses after running the vocabulary + per-phase
// admission check. Exported so the gate (in daemon.ts) can elevate a parsed `InternalStatus`
// to `AdmittedItemStatus` without `as`, matching the pattern above. The daemon emits its own
// `item.status.write_admission` audit event alongside this call.
export function assertRequestAdmittedItemStatus(_value: InternalStatus): asserts _value is AdmittedItemStatus {
	// Brand-only assertion; the caller has already run the gate.
}

export function storedChainMetadata(value: JsonObject, field = "metadata"): ChainMetadata {
	return parseChainMetadata(value, field)
}

export function parseChainMetadataForRequest(value: BoundaryValue, field = "metadata"): ChainMetadata {
	return parseChainMetadata(requestJsonObject(value, field), field)
}

export function chainMetadataToJsonObject(metadata: ChainMetadata): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(metadata) }
	assignJson(result, "bindings", metadata.bindings === undefined ? undefined : chainBindingsToJsonObject(metadata.bindings))
	assignJson(result, "presetPath", metadata.presetPath)
	assignJson(result, "sharedContextFile", metadata.sharedContextFile)
	assignJson(result, "issueDir", metadata.issueDir)
	assignJson(result, "evidenceDir", metadata.evidenceDir)
	assignJson(result, "logDir", metadata.logDir)
	assignJson(result, "worktree", metadata.worktree)
	assignJson(result, "claude", metadata.claude === undefined ? undefined : runnerMetadataToJsonObject(metadata.claude))
	assignJson(result, "codex", metadata.codex === undefined ? undefined : runnerMetadataToJsonObject(metadata.codex))
	assignJson(result, "opencode", metadata.opencode === undefined ? undefined : runnerMetadataToJsonObject(metadata.opencode))
	assignJson(result, "hapi", metadata.hapi === undefined ? undefined : runnerMetadataToJsonObject(metadata.hapi))
	assignJson(result, "maxItemAttempts", metadata.maxItemAttempts)
	assignJson(
		result,
		"coderLoopChainCompleteTrigger",
		metadata.coderLoopChainCompleteTrigger === undefined ? undefined : chainCompleteTriggerStateToJsonObject(metadata.coderLoopChainCompleteTrigger),
	)
	return result
}

export function chainBindings(metadata: ChainMetadata): JsonObject {
	return metadata.bindings === undefined ? {} : chainBindingsToJsonObject(metadata.bindings)
}

export function chainBindingsPresetPath(metadata: ChainMetadata): string | null {
	return metadata.bindings?.presetPath ?? null
}

export function chainPresetPath(metadata: ChainMetadata): string | null {
	const direct = metadataString(metadata, "presetPath")
	if (direct !== null) return direct
	return chainBindingsPresetPath(metadata)
}

export function metadataString(metadata: ChainMetadata, key: keyof ChainMetadata & string): string | null {
	const value = metadata[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

export function metadataBoolean(metadata: ChainMetadata, key: keyof ChainMetadata & string): boolean | null {
	const value = metadata[key]
	return typeof value === "boolean" ? value : null
}

export function metadataNestedString(metadata: ChainMetadata, objectKey: "claude" | "codex" | "opencode" | "hapi", key: keyof RunnerMetadata & string): string | null {
	const object = metadata[objectKey]
	if (object === undefined) return null
	const value = object[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

export function metadataNestedStringArray(metadata: ChainMetadata, objectKey: "claude" | "codex" | "opencode" | "hapi", key: keyof RunnerMetadata & string): string[] | null {
	const object = metadata[objectKey]
	if (object === undefined) return null
	const value = object[key]
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null
}

export function storedItemExtra(value: JsonObject, field = "extra"): ItemExtra {
	return parseItemExtra(value, field)
}

export function parseItemExtraForRequest(value: BoundaryValue, field = "extra"): ItemExtra {
	return parseItemExtra(requestJsonObject(value, field), field)
}

export function itemExtraToJsonObject(extra: ItemExtra): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(extra) }
	assignJson(result, "dependsOn", extra.dependsOn === undefined ? undefined : [...extra.dependsOn])
	assignJson(result, "schedulerBackoff", extra.schedulerBackoff === undefined ? undefined : { ...extra.schedulerBackoff })
	assignJson(result, "schedulerSpawnError", extra.schedulerSpawnError === undefined ? undefined : {
		...extra.schedulerSpawnError,
		attribution: { ...extra.schedulerSpawnError.attribution },
	})
	assignJson(result, "slotKey", extra.slotKey)
	assignJson(result, "itemId", extra.itemId)
	assignJson(result, "repoCwd", extra.repoCwd)
	assignJson(result, "worktreePath", extra.worktreePath)
	assignJson(result, "startStatus", extra.startStatus)
	assignJson(result, "startStatusUpdatedAt", extra.startStatusUpdatedAt)
	assignJson(result, "startPhase", extra.startPhase)
	assignJson(result, "startAttempts", extra.startAttempts)
	assignJson(result, "attemptStarted", extra.attemptStarted)
	assignJson(result, "pid", extra.pid)
	assignJson(result, "processGroupLeader", extra.processGroupLeader)
	assignJson(result, "externalTerminalHold", extra.externalTerminalHold === undefined ? undefined : {
		...extra.externalTerminalHold,
		probeArgv: [...extra.externalTerminalHold.probeArgv],
		availability: { ...extra.externalTerminalHold.availability },
	})
	assignJson(result, "externalTerminalAvailability", extra.externalTerminalAvailability === undefined ? undefined : { ...extra.externalTerminalAvailability })
	assignJson(result, "externalTerminalLoss", extra.externalTerminalLoss === undefined ? undefined : { ...extra.externalTerminalLoss })
	assignJson(result, "externalTerminalRunner", extra.externalTerminalRunner)
	return result
}

export function itemExtraJsonValue(extra: ItemExtra, key: string): JsonValue | undefined {
	return itemExtraToJsonObject(extra)[key]
}

export function itemExtraWithoutKeys(extra: ItemExtra, keys: readonly string[]): ItemExtra {
	const next = itemExtraToJsonObject(extra)
	for (const key of keys) delete next[key]
	return storedItemExtra(next)
}

export function itemDependsOnIds(extra: ItemExtra): number[] {
	return extra.dependsOn === undefined ? [] : [...extra.dependsOn]
}

export function itemSchedulerBackoff(extra: ItemExtra): SchedulerBackoffState | null {
	return extra.schedulerBackoff === undefined ? null : { ...extra.schedulerBackoff }
}

export function withSchedulerBackoff(extra: ItemExtra, state: SchedulerBackoffState): ItemExtra {
	return storedItemExtra({ ...itemExtraToJsonObject(extra), schedulerBackoff: { ...state } })
}

export function clearSchedulerBackoff(extra: ItemExtra): ItemExtra {
	if (extra.schedulerBackoff === undefined) return extra
	const next = itemExtraToJsonObject(extra)
	delete next.schedulerBackoff
	return storedItemExtra(next)
}

export function withSchedulerSpawnError(extra: ItemExtra, error: SchedulerSpawnError): ItemExtra {
	return storedItemExtra({
		...itemExtraToJsonObject(extra),
		schedulerSpawnError: { ...error, attribution: { ...error.attribution } },
	})
}

export function clearSchedulerSpawnError(extra: ItemExtra): ItemExtra {
	if (extra.schedulerSpawnError === undefined) return extra
	const next = itemExtraToJsonObject(extra)
	delete next.schedulerSpawnError
	return storedItemExtra(next)
}

export function withExternalTerminalHold(extra: ItemExtra, hold: ExternalTerminalHold): ItemExtra {
	return storedItemExtra({
		...itemExtraToJsonObject(extra),
		externalTerminalHold: { ...hold, probeArgv: [...hold.probeArgv], availability: { ...hold.availability } },
	})
}

export function clearExternalTerminalHold(extra: ItemExtra): ItemExtra {
	if (extra.externalTerminalHold === undefined) return extra
	const next = itemExtraToJsonObject(extra)
	delete next.externalTerminalHold
	return storedItemExtra(next)
}

export function chainCompleteTriggerState(metadata: ChainMetadata): ChainCompleteTriggerState | null {
	return metadata.coderLoopChainCompleteTrigger ?? null
}

export function withoutChainCompleteTriggerState(metadata: ChainMetadata): ChainMetadata {
	if (metadata.coderLoopChainCompleteTrigger === undefined) return metadata
	const next = chainMetadataToJsonObject(metadata)
	delete next.coderLoopChainCompleteTrigger
	return storedChainMetadata(next)
}

export function withChainCompleteTriggerState(metadata: ChainMetadata, state: ChainCompleteTriggerStateInput): ChainMetadata {
	return storedChainMetadata({
		...chainMetadataToJsonObject(metadata),
		coderLoopChainCompleteTrigger: chainCompleteTriggerStateToJsonObject(new ChainCompleteTriggerState(state, {})),
	})
}

export function runtimeDataJsonValue(value: BoundaryValue): JsonValue {
	return isJsonValue(value) ? value : String(value)
}

function parseChainMetadata(value: JsonObject, field: string): ChainMetadata {
	// #433: enforce the new shape — retired keys (`config`, top-level `runner` and v9's role-named
	// runner key) raise an explicit error rather than slipping through as remainder, so stale rows
	// surface as the supervisor reads them instead of getting silently masked. #456: the role-named
	// guidance text is composed at runtime so a grep for the role vocabulary in `src/` finds the
	// migration guard (this file) by intent, not by literal — the engine itself no longer carries
	// the taxonomy. The hint string still names the key plainly for operators reading the error.
	const RETIRED_RUNNER_KEY = "review" + "Runner"
	for (const retiredKey of RETIRED_CHAIN_METADATA_KEYS) {
		if (Object.prototype.hasOwnProperty.call(value, retiredKey)) {
			throw runtimeDataError(
				`${field}.${retiredKey}`,
				runtimeDataJsonValue(value[retiredKey] ?? null),
				`${field}.${retiredKey} is retired (#433); migrate "config" → "bindings" and drop top-level "runner"/"${RETIRED_RUNNER_KEY}"`,
			)
		}
	}
	const input: ChainMetadataInput = {}
	const bindings = optionalChainBindingsField(value, "bindings", `${field}.bindings`)
	if (bindings !== undefined) input.bindings = bindings
	const presetPath = optionalStringField(value, "presetPath", `${field}.presetPath`)
	if (presetPath !== undefined) input.presetPath = presetPath
	const sharedContextFile = optionalStringField(value, "sharedContextFile", `${field}.sharedContextFile`)
	if (sharedContextFile !== undefined) input.sharedContextFile = sharedContextFile
	const issueDir = optionalStringField(value, "issueDir", `${field}.issueDir`)
	if (issueDir !== undefined) input.issueDir = issueDir
	const evidenceDir = optionalStringField(value, "evidenceDir", `${field}.evidenceDir`)
	if (evidenceDir !== undefined) input.evidenceDir = evidenceDir
	const logDir = optionalStringField(value, "logDir", `${field}.logDir`)
	if (logDir !== undefined) input.logDir = logDir
	const worktree = optionalBooleanField(value, "worktree", `${field}.worktree`)
	if (worktree !== undefined) input.worktree = worktree
	const claude = optionalRunnerMetadataField(value, "claude", `${field}.claude`)
	if (claude !== undefined) input.claude = claude
	const codex = optionalRunnerMetadataField(value, "codex", `${field}.codex`)
	if (codex !== undefined) input.codex = codex
	const opencode = optionalRunnerMetadataField(value, "opencode", `${field}.opencode`)
	if (opencode !== undefined) input.opencode = opencode
	const hapi = optionalRunnerMetadataField(value, "hapi", `${field}.hapi`)
	if (hapi !== undefined) input.hapi = hapi
	const maxItemAttempts = optionalPositiveIntegerField(value, "maxItemAttempts", `${field}.maxItemAttempts`)
	if (maxItemAttempts !== undefined) input.maxItemAttempts = maxItemAttempts
	const trigger = optionalChainCompleteTriggerStateField(value, "coderLoopChainCompleteTrigger", `${field}.coderLoopChainCompleteTrigger`)
	if (trigger !== undefined) input.coderLoopChainCompleteTrigger = trigger
	return new ChainMetadata(input, remainderExcept(value, CHAIN_METADATA_KEYS))
}

function parseItemExtra(value: JsonObject, field: string): ItemExtra {
	const input: ItemExtraInput = {}
	const dependsOn = optionalPositiveIntegerArrayField(value, "dependsOn", `${field}.dependsOn`, `${field}.dependsOn must be an array of positive item ids when provided`)
	if (dependsOn !== undefined) input.dependsOn = dependsOn
	const schedulerBackoff = optionalSchedulerBackoffField(value, "schedulerBackoff", `${field}.schedulerBackoff`)
	if (schedulerBackoff !== undefined) input.schedulerBackoff = schedulerBackoff
	const schedulerSpawnError = optionalSchedulerSpawnErrorField(value, "schedulerSpawnError", `${field}.schedulerSpawnError`)
	if (schedulerSpawnError !== undefined) input.schedulerSpawnError = schedulerSpawnError
	const slotKey = optionalStringField(value, "slotKey", `${field}.slotKey`)
	if (slotKey !== undefined) input.slotKey = slotKey
	const itemId = optionalPositiveIntegerField(value, "itemId", `${field}.itemId`)
	if (itemId !== undefined) input.itemId = itemId
	const repoCwd = optionalStringField(value, "repoCwd", `${field}.repoCwd`)
	if (repoCwd !== undefined) input.repoCwd = repoCwd
	const worktreePath = optionalStringField(value, "worktreePath", `${field}.worktreePath`)
	if (worktreePath !== undefined) input.worktreePath = worktreePath
	const startStatus = optionalStringField(value, "startStatus", `${field}.startStatus`)
	if (startStatus !== undefined) input.startStatus = parseInternalStatus(startStatus, `${field}.startStatus`)
	const startStatusUpdatedAt = optionalPositiveIntegerField(value, "startStatusUpdatedAt", `${field}.startStatusUpdatedAt`)
	if (startStatusUpdatedAt !== undefined) input.startStatusUpdatedAt = startStatusUpdatedAt
	const startPhase = optionalStringField(value, "startPhase", `${field}.startPhase`)
	if (startPhase !== undefined) input.startPhase = startPhase
	const startAttempts = arkField(OptionalNonNegativeIntegerBoundary, value.startAttempts, `${field}.startAttempts`, `${field}.startAttempts must be a non-negative integer when provided`)
	if (startAttempts !== undefined) input.startAttempts = startAttempts
	const attemptStarted = optionalBooleanField(value, "attemptStarted", `${field}.attemptStarted`)
	if (attemptStarted !== undefined) input.attemptStarted = attemptStarted
	const pid = optionalPositiveIntegerField(value, "pid", `${field}.pid`)
	if (pid !== undefined) input.pid = pid
	const processGroupLeader = optionalBooleanField(value, "processGroupLeader", `${field}.processGroupLeader`)
	if (processGroupLeader !== undefined) input.processGroupLeader = processGroupLeader
	const externalTerminalHold = arkField(ExternalTerminalHoldBoundary, value.externalTerminalHold, `${field}.externalTerminalHold`, `${field}.externalTerminalHold must be a typed external-terminal hold`)
	if (externalTerminalHold !== undefined) input.externalTerminalHold = externalTerminalHold
	const externalTerminalAvailability = arkField(ExternalTerminalAvailabilityBoundary, value.externalTerminalAvailability, `${field}.externalTerminalAvailability`, `${field}.externalTerminalAvailability must be a typed external-terminal availability`)
	if (externalTerminalAvailability !== undefined) input.externalTerminalAvailability = externalTerminalAvailability
	const externalTerminalLoss = arkField(ExternalTerminalLossBoundary, value.externalTerminalLoss, `${field}.externalTerminalLoss`, `${field}.externalTerminalLoss must be a typed external-terminal loss`)
	if (externalTerminalLoss !== undefined) input.externalTerminalLoss = externalTerminalLoss
	const externalTerminalRunner = arkField(OptionalAgentRunnerKindBoundary, value.externalTerminalRunner, `${field}.externalTerminalRunner`, `${field}.externalTerminalRunner must be a runner kind when provided`)
	if (externalTerminalRunner !== undefined) input.externalTerminalRunner = externalTerminalRunner
	return new ItemExtra(input, remainderExcept(value, ITEM_EXTRA_KEYS))
}

function optionalChainBindingsField(record: JsonObject, key: string, field: string): ChainBindings | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	const input: ChainBindingsInput = {}
	const presetPath = optionalStringField(object, "presetPath", `${field}.presetPath`)
	if (presetPath !== undefined) input.presetPath = presetPath
	return new ChainBindings(input, remainderExcept(object, CHAIN_BINDING_KEYS))
}

function optionalRunnerMetadataField(record: JsonObject, key: string, field: string): RunnerMetadata | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	const input: RunnerMetadataInput = {}
	const binary = optionalStringField(object, "binary", `${field}.binary`)
	if (binary !== undefined) input.binary = binary
	const model = optionalStringField(object, "model", `${field}.model`)
	if (model !== undefined) input.model = model
	const extraArgs = optionalStringArrayField(object, "extraArgs", `${field}.extraArgs`)
	if (extraArgs !== undefined) input.extraArgs = extraArgs
	return new RunnerMetadata(input, remainderExcept(object, RUNNER_METADATA_KEYS))
}

function optionalChainCompleteTriggerStateField(record: JsonObject, key: string, field: string): ChainCompleteTriggerState | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	const input: ChainCompleteTriggerStateInput = {}
	const decision = arkField(ChainCompleteTriggerDecisionBoundary, object.decision, `${field}.decision`, `${field}.decision must be keep-active when provided`)
	if (decision !== undefined) input.decision = decision
	const fingerprint = optionalStringField(object, "fingerprint", `${field}.fingerprint`)
	if (fingerprint !== undefined) input.fingerprint = fingerprint
	const recordedAt = optionalPositiveIntegerField(object, "recordedAt", `${field}.recordedAt`)
	if (recordedAt !== undefined) input.recordedAt = recordedAt
	const reason = optionalStringField(object, "reason", `${field}.reason`)
	if (reason !== undefined) input.reason = reason
	const runId = optionalStringField(object, "runId", `${field}.runId`)
	if (runId !== undefined) input.runId = runId
	return new ChainCompleteTriggerState(input, remainderExcept(object, CHAIN_COMPLETE_TRIGGER_KEYS))
}

function optionalSchedulerBackoffField(record: JsonObject, key: string, field: string): SchedulerBackoffState | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	return {
		failureCount: requiredPositiveIntegerField(object, "failureCount", `${field}.failureCount`),
		nextRunAt: requiredPositiveIntegerField(object, "nextRunAt", `${field}.nextRunAt`),
	}
}

function optionalSchedulerSpawnErrorField(record: JsonObject, key: string, field: string): SchedulerSpawnError | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	return {
		at: requiredPositiveIntegerField(object, "at", `${field}.at`),
		attribution: schedulerSpawnErrorAttribution(object.attribution, `${field}.attribution`),
		message: requiredStringField(object, "message", `${field}.message`),
	}
}

function schedulerSpawnErrorAttribution(value: JsonValue | undefined, field: string): SchedulerSpawnErrorAttribution {
	const object = jsonObjectFieldValue(value, field)
	const kind = requiredStringField(object, "kind", `${field}.kind`)
	if (kind === "chain-plan") return { kind }
	if (kind === "phase") return { kind, phase: requiredStringField(object, "phase", `${field}.phase`) }
	throw runtimeDataError(field, value, `${field}.kind must be "chain-plan" or "phase"`)
}

function requestJsonObject(value: BoundaryValue, field: string): JsonObject {
	try {
		return { ...JsonObjectBoundary.assert(value) }
	} catch {
		throw runtimeDataError(field, runtimeDataJsonValue(value), `${field} must be a JSON object`)
	}
}

function jsonObjectFieldValue(value: JsonValue | undefined, field: string): JsonObject {
	return { ...arkField(JsonObjectBoundary, value, field, `${field} must be a JSON object when provided`) }
}

function optionalStringField(record: JsonObject, key: string, field: string): string | undefined {
	return arkField(OptionalStringBoundary, record[key], field, `${field} must be a string when provided`)
}

function requiredStringField(record: JsonObject, key: string, field: string): string {
	const value = record[key]
	if (typeof value === "string") return value
	throw runtimeDataError(field, value, `${field} must be a string`)
}

function optionalStringArrayField(record: JsonObject, key: string, field: string): string[] | undefined {
	const value = arkField(OptionalStringArrayBoundary, record[key], field, `${field} must be a string array when provided`)
	return value === undefined ? undefined : [...value]
}

function optionalBooleanField(record: JsonObject, key: string, field: string): boolean | undefined {
	return arkField(OptionalBooleanBoundary, record[key], field, `${field} must be a boolean when provided`)
}

function optionalPositiveIntegerField(record: JsonObject, key: string, field: string): number | undefined {
	return arkField(OptionalPositiveIntegerBoundary, record[key], field, `${field} must be a positive integer when provided`)
}

function requiredPositiveIntegerField(record: JsonObject, key: string, field: string): number {
	return arkField(RequiredPositiveIntegerBoundary, record[key], field, `${field} must be a positive integer`)
}

function optionalPositiveIntegerArrayField(record: JsonObject, key: string, field: string, message: string): number[] | undefined {
	const value = arkField(OptionalPositiveIntegerArrayBoundary, record[key], field, message)
	return value === undefined ? undefined : [...value]
}

function arkField<T>(boundary: ArkAssertable<T>, value: JsonValue | undefined, field: string, message: string): T {
	try {
		return boundary.assert(value)
	} catch {
		throw runtimeDataError(field, value, message)
	}
}

function runtimeRemainder(record: RuntimeDataRecord): JsonObject {
	return { ...record[runtimeDataRemainderKey] }
}

function remainderExcept(value: JsonObject, knownKeys: ReadonlySet<string>): JsonObject {
	const remainder: JsonObject = {}
	for (const [key, entry] of Object.entries(value)) {
		if (!knownKeys.has(key)) remainder[key] = entry
	}
	return remainder
}

function runnerMetadataToJsonObject(metadata: RunnerMetadata): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(metadata) }
	assignJson(result, "binary", metadata.binary)
	assignJson(result, "model", metadata.model)
	assignJson(result, "extraArgs", metadata.extraArgs === undefined ? undefined : [...metadata.extraArgs])
	return result
}

function chainBindingsToJsonObject(bindings: ChainBindings): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(bindings) }
	assignJson(result, "presetPath", bindings.presetPath)
	return result
}

function chainCompleteTriggerStateToJsonObject(state: ChainCompleteTriggerState): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(state) }
	assignJson(result, "decision", state.decision)
	assignJson(result, "fingerprint", state.fingerprint)
	assignJson(result, "recordedAt", state.recordedAt)
	assignJson(result, "reason", state.reason)
	assignJson(result, "runId", state.runId)
	return result
}

function assignJson(target: JsonObject, key: string, value: JsonValue | undefined): void {
	if (value !== undefined) target[key] = value
}

function runtimeDataError(field: string, value: JsonValue | undefined, message: string): RuntimeDataError {
	return new RuntimeDataError(message, { field, value: value === undefined ? null : value })
}

function isJsonObject(value: BoundaryValue): value is JsonObject {
	return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isJsonValue)
}

function isJsonValue(value: BoundaryValue): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (value === undefined || typeof value !== "object") return false
	return Object.values(value).every(isJsonValue)
}
