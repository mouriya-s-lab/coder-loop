import { type as arkType } from "arktype"

import type { BoundaryValue } from "./boundary-types"
import type { JsonObject, JsonValue } from "./loop"

declare const internalStatusBrand: unique symbol
const runtimeDataRemainderKey: unique symbol = Symbol("runtimeDataRemainder")

export type InternalStatus = string & { readonly [internalStatusBrand]: "InternalStatus" }

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

export class ChainConfigBindings extends RuntimeDataRecord {
	presetPath?: string
	workflowFile?: string

	constructor(input: ChainConfigBindingsInput, remainder: JsonObject) {
		super(remainder)
		if (input.presetPath !== undefined) this.presetPath = input.presetPath
		if (input.workflowFile !== undefined) this.workflowFile = input.workflowFile
	}
}

export class ChainMetadata extends RuntimeDataRecord {
	config?: ChainConfigBindings
	presetPath?: string
	workflowFile?: string
	sharedContextFile?: string
	issueDir?: string
	evidenceDir?: string
	logDir?: string
	worktree?: boolean
	claude?: RunnerMetadata
	codex?: RunnerMetadata
	maxItemAttempts?: number
	coderLoopChainCompleteTrigger?: ChainCompleteTriggerState

	constructor(input: ChainMetadataInput, remainder: JsonObject) {
		super(remainder)
		if (input.config !== undefined) this.config = input.config
		if (input.presetPath !== undefined) this.presetPath = input.presetPath
		if (input.workflowFile !== undefined) this.workflowFile = input.workflowFile
		if (input.sharedContextFile !== undefined) this.sharedContextFile = input.sharedContextFile
		if (input.issueDir !== undefined) this.issueDir = input.issueDir
		if (input.evidenceDir !== undefined) this.evidenceDir = input.evidenceDir
		if (input.logDir !== undefined) this.logDir = input.logDir
		if (input.worktree !== undefined) this.worktree = input.worktree
		if (input.claude !== undefined) this.claude = input.claude
		if (input.codex !== undefined) this.codex = input.codex
		if (input.maxItemAttempts !== undefined) this.maxItemAttempts = input.maxItemAttempts
		if (input.coderLoopChainCompleteTrigger !== undefined) this.coderLoopChainCompleteTrigger = input.coderLoopChainCompleteTrigger
	}
}

export type SchedulerBackoffState = {
	failureCount: number
	nextRunAt: number
}

export type SchedulerSpawnError = {
	at: number
	phase: string
	message: string
}

export class ItemExtra extends RuntimeDataRecord {
	dependsOn?: number[]
	blockerRepo?: string
	blockerRef?: string
	schedulerBackoff?: SchedulerBackoffState
	schedulerSpawnError?: SchedulerSpawnError
	issueKind?: string
	slotKey?: string
	itemId?: number
	repoCwd?: string
	worktreePath?: string
	startStatus?: InternalStatus
	startStatusUpdatedAt?: number
	startPhase?: string
	pid?: number
	processGroupLeader?: boolean

	constructor(input: ItemExtraInput, remainder: JsonObject) {
		super(remainder)
		if (input.dependsOn !== undefined) this.dependsOn = [...input.dependsOn]
		if (input.blockerRepo !== undefined) this.blockerRepo = input.blockerRepo
		if (input.blockerRef !== undefined) this.blockerRef = input.blockerRef
		if (input.schedulerBackoff !== undefined) this.schedulerBackoff = { ...input.schedulerBackoff }
		if (input.schedulerSpawnError !== undefined) this.schedulerSpawnError = { ...input.schedulerSpawnError }
		if (input.issueKind !== undefined) this.issueKind = input.issueKind
		if (input.slotKey !== undefined) this.slotKey = input.slotKey
		if (input.itemId !== undefined) this.itemId = input.itemId
		if (input.repoCwd !== undefined) this.repoCwd = input.repoCwd
		if (input.worktreePath !== undefined) this.worktreePath = input.worktreePath
		if (input.startStatus !== undefined) this.startStatus = input.startStatus
		if (input.startStatusUpdatedAt !== undefined) this.startStatusUpdatedAt = input.startStatusUpdatedAt
		if (input.startPhase !== undefined) this.startPhase = input.startPhase
		if (input.pid !== undefined) this.pid = input.pid
		if (input.processGroupLeader !== undefined) this.processGroupLeader = input.processGroupLeader
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
	config?: ChainConfigBindings
	presetPath?: string
	workflowFile?: string
	sharedContextFile?: string
	issueDir?: string
	evidenceDir?: string
	logDir?: string
	worktree?: boolean
	claude?: RunnerMetadata
	codex?: RunnerMetadata
	maxItemAttempts?: number
	coderLoopChainCompleteTrigger?: ChainCompleteTriggerState
}

type ChainConfigBindingsInput = {
	presetPath?: string
	workflowFile?: string
}

type ItemExtraInput = {
	dependsOn?: number[]
	blockerRepo?: string
	blockerRef?: string
	schedulerBackoff?: SchedulerBackoffState
	schedulerSpawnError?: SchedulerSpawnError
	issueKind?: string
	slotKey?: string
	itemId?: number
	repoCwd?: string
	worktreePath?: string
	startStatus?: InternalStatus
	startStatusUpdatedAt?: number
	startPhase?: string
	pid?: number
	processGroupLeader?: boolean
}

type ArkAssertable<T> = {
	assert(data: BoundaryValue): T
}

const OptionalStringBoundary = arkType("string|undefined")
const OptionalBooleanBoundary = arkType("boolean|undefined")
const OptionalPositiveIntegerBoundary = arkType("number.integer > 0 | undefined")
const RequiredPositiveIntegerBoundary = arkType("number.integer > 0")
const OptionalStringArrayBoundary = arkType("string[]|undefined")
const OptionalPositiveIntegerArrayBoundary = arkType("(number.integer > 0)[]|undefined")
const ChainCompleteTriggerDecisionBoundary = arkType("'keep-active'|undefined")
const JsonObjectBoundary: ArkAssertable<JsonObject> = arkType("unknown", ":", isJsonObject)

const RUNNER_METADATA_KEYS = new Set(["binary", "model", "extraArgs"])
const CHAIN_COMPLETE_TRIGGER_KEYS = new Set(["decision", "fingerprint", "recordedAt", "reason", "runId"])
const CHAIN_CONFIG_BINDING_KEYS = new Set(["presetPath", "workflowFile"])
const CHAIN_METADATA_KEYS = new Set([
	"config",
	"presetPath",
	"workflowFile",
	"sharedContextFile",
	"issueDir",
	"evidenceDir",
	"logDir",
	"worktree",
	"claude",
	"codex",
	"maxItemAttempts",
	"coderLoopChainCompleteTrigger",
])
const ITEM_EXTRA_KEYS = new Set([
	"dependsOn",
	"blockerRepo",
	"blockerRef",
	"schedulerBackoff",
	"schedulerSpawnError",
	"issueKind",
	"slotKey",
	"itemId",
	"repoCwd",
	"worktreePath",
	"startStatus",
	"startStatusUpdatedAt",
	"startPhase",
	"pid",
	"processGroupLeader",
])

export function parseInternalStatus(value: string, field: string): InternalStatus {
	assertInternalStatus(value, field)
	return value
}

export function assertInternalStatus(value: string, field: string): asserts value is InternalStatus {
	if (value.trim() !== "") return
	throw new RuntimeDataError(`${field} must be a non-empty status`, { field, value })
}

export function storedChainMetadata(value: JsonObject, field = "metadata"): ChainMetadata {
	return parseChainMetadata(value, field)
}

export function parseChainMetadataForRequest(value: BoundaryValue, field = "metadata"): ChainMetadata {
	return parseChainMetadata(requestJsonObject(value, field), field)
}

export function chainMetadataToJsonObject(metadata: ChainMetadata): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(metadata) }
	assignJson(result, "config", metadata.config === undefined ? undefined : chainConfigBindingsToJsonObject(metadata.config))
	assignJson(result, "presetPath", metadata.presetPath)
	assignJson(result, "workflowFile", metadata.workflowFile)
	assignJson(result, "sharedContextFile", metadata.sharedContextFile)
	assignJson(result, "issueDir", metadata.issueDir)
	assignJson(result, "evidenceDir", metadata.evidenceDir)
	assignJson(result, "logDir", metadata.logDir)
	assignJson(result, "worktree", metadata.worktree)
	assignJson(result, "claude", metadata.claude === undefined ? undefined : runnerMetadataToJsonObject(metadata.claude))
	assignJson(result, "codex", metadata.codex === undefined ? undefined : runnerMetadataToJsonObject(metadata.codex))
	assignJson(result, "maxItemAttempts", metadata.maxItemAttempts)
	assignJson(
		result,
		"coderLoopChainCompleteTrigger",
		metadata.coderLoopChainCompleteTrigger === undefined ? undefined : chainCompleteTriggerStateToJsonObject(metadata.coderLoopChainCompleteTrigger),
	)
	return result
}

export function chainConfigBindings(metadata: ChainMetadata): JsonObject {
	return metadata.config === undefined ? {} : chainConfigBindingsToJsonObject(metadata.config)
}

export function chainConfigPresetPath(metadata: ChainMetadata): string | null {
	return metadata.config?.presetPath ?? null
}

export function chainConfigWorkflowFile(metadata: ChainMetadata): string | null {
	return metadata.config?.workflowFile ?? null
}

export function chainPresetPath(metadata: ChainMetadata): string | null {
	const direct = metadataString(metadata, "presetPath")
	if (direct !== null) return direct
	return chainConfigPresetPath(metadata)
}

export function metadataString(metadata: ChainMetadata, key: keyof ChainMetadata & string): string | null {
	const value = metadata[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

export function metadataBoolean(metadata: ChainMetadata, key: keyof ChainMetadata & string): boolean | null {
	const value = metadata[key]
	return typeof value === "boolean" ? value : null
}

export function metadataNestedString(metadata: ChainMetadata, objectKey: "claude" | "codex", key: keyof RunnerMetadata & string): string | null {
	const object = metadata[objectKey]
	if (object === undefined) return null
	const value = object[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

export function metadataNestedStringArray(metadata: ChainMetadata, objectKey: "claude" | "codex", key: keyof RunnerMetadata & string): string[] | null {
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
	assignJson(result, "blockerRepo", extra.blockerRepo)
	assignJson(result, "blockerRef", extra.blockerRef)
	assignJson(result, "schedulerBackoff", extra.schedulerBackoff === undefined ? undefined : { ...extra.schedulerBackoff })
	assignJson(result, "schedulerSpawnError", extra.schedulerSpawnError === undefined ? undefined : { ...extra.schedulerSpawnError })
	assignJson(result, "issueKind", extra.issueKind)
	assignJson(result, "slotKey", extra.slotKey)
	assignJson(result, "itemId", extra.itemId)
	assignJson(result, "repoCwd", extra.repoCwd)
	assignJson(result, "worktreePath", extra.worktreePath)
	assignJson(result, "startStatus", extra.startStatus)
	assignJson(result, "startStatusUpdatedAt", extra.startStatusUpdatedAt)
	assignJson(result, "startPhase", extra.startPhase)
	assignJson(result, "pid", extra.pid)
	assignJson(result, "processGroupLeader", extra.processGroupLeader)
	return result
}

export function itemExtraJsonValue(extra: ItemExtra, key: string): JsonValue | undefined {
	return itemExtraToJsonObject(extra)[key]
}

export function itemExtraHasJsonKey(extra: ItemExtra, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(itemExtraToJsonObject(extra), key)
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
	return storedItemExtra({ ...itemExtraToJsonObject(extra), schedulerSpawnError: { ...error } })
}

export function clearSchedulerSpawnError(extra: ItemExtra): ItemExtra {
	if (extra.schedulerSpawnError === undefined) return extra
	const next = itemExtraToJsonObject(extra)
	delete next.schedulerSpawnError
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
	const input: ChainMetadataInput = {}
	const config = optionalChainConfigBindingsField(value, "config", `${field}.config`)
	if (config !== undefined) input.config = config
	const presetPath = optionalStringField(value, "presetPath", `${field}.presetPath`)
	if (presetPath !== undefined) input.presetPath = presetPath
	const workflowFile = optionalStringField(value, "workflowFile", `${field}.workflowFile`)
	if (workflowFile !== undefined) input.workflowFile = workflowFile
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
	const blockerRepo = optionalStringField(value, "blockerRepo", `${field}.blockerRepo`)
	if (blockerRepo !== undefined) input.blockerRepo = blockerRepo
	const blockerRef = optionalStringField(value, "blockerRef", `${field}.blockerRef`)
	if (blockerRef !== undefined) input.blockerRef = blockerRef
	const schedulerBackoff = optionalSchedulerBackoffField(value, "schedulerBackoff", `${field}.schedulerBackoff`)
	if (schedulerBackoff !== undefined) input.schedulerBackoff = schedulerBackoff
	const schedulerSpawnError = optionalSchedulerSpawnErrorField(value, "schedulerSpawnError", `${field}.schedulerSpawnError`)
	if (schedulerSpawnError !== undefined) input.schedulerSpawnError = schedulerSpawnError
	const issueKind = optionalStringField(value, "issueKind", `${field}.issueKind`)
	if (issueKind !== undefined) input.issueKind = issueKind
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
	const pid = optionalPositiveIntegerField(value, "pid", `${field}.pid`)
	if (pid !== undefined) input.pid = pid
	const processGroupLeader = optionalBooleanField(value, "processGroupLeader", `${field}.processGroupLeader`)
	if (processGroupLeader !== undefined) input.processGroupLeader = processGroupLeader
	return new ItemExtra(input, remainderExcept(value, ITEM_EXTRA_KEYS))
}

function optionalChainConfigBindingsField(record: JsonObject, key: string, field: string): ChainConfigBindings | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	const object = jsonObjectFieldValue(value, field)
	const input: ChainConfigBindingsInput = {}
	const presetPath = optionalStringField(object, "presetPath", `${field}.presetPath`)
	if (presetPath !== undefined) input.presetPath = presetPath
	const workflowFile = optionalStringField(object, "workflowFile", `${field}.workflowFile`)
	if (workflowFile !== undefined) input.workflowFile = workflowFile
	return new ChainConfigBindings(input, remainderExcept(object, CHAIN_CONFIG_BINDING_KEYS))
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
		phase: requiredStringField(object, "phase", `${field}.phase`),
		message: requiredStringField(object, "message", `${field}.message`),
	}
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

function chainConfigBindingsToJsonObject(config: ChainConfigBindings): JsonObject {
	const result: JsonObject = { ...runtimeRemainder(config) }
	assignJson(result, "presetPath", config.presetPath)
	assignJson(result, "workflowFile", config.workflowFile)
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
