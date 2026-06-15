import type { JsonObject, JsonValue } from "./loop"

declare const internalStatusBrand: unique symbol

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

export type RunnerMetadata = JsonObject & {
	binary?: string
	model?: string
	extraArgs?: string[]
}

export type ChainCompleteTriggerState = JsonObject & {
	decision?: "keep-active"
	fingerprint?: string
	recordedAt?: number
	reason?: string
	runId?: string
}

export type ChainMetadata = JsonObject & {
	config?: JsonObject
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

export type SchedulerBackoffState = JsonObject & {
	failureCount: number
	nextRunAt: number
}

export type SchedulerSpawnError = JsonObject & {
	at: number
	phase: string
	message: string
}

export type ItemExtra = JsonObject & {
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
	startStatus?: string
	startStatusUpdatedAt?: number
	startPhase?: string
	pid?: number
	processGroupLeader?: boolean
}

export function parseInternalStatus(value: string, field: string): InternalStatus {
	assertInternalStatus(value, field)
	return value
}

export function assertInternalStatus(value: string, field: string): asserts value is InternalStatus {
	if (value.trim() !== "") return
	throw new RuntimeDataError(`${field} must be a non-empty status`, { field, value })
}

export function storedChainMetadata(value: JsonObject): ChainMetadata {
	assertStoredChainMetadata(value)
	return value
}

export function parseChainMetadataForRequest(value: JsonObject, field = "metadata"): ChainMetadata {
	validateKnownChainMetadata(value, field)
	assertStoredChainMetadata(value)
	return value
}

export function chainConfigBindings(metadata: ChainMetadata, field = "metadata.config"): JsonObject {
	const value = metadata.config
	if (value === undefined) return {}
	if (isJsonObject(value)) return { ...value }
	throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
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
	if (!isJsonObject(object)) return null
	const value = object[key]
	return typeof value === "string" && value.trim() !== "" ? value : null
}

export function metadataNestedStringArray(metadata: ChainMetadata, objectKey: "claude" | "codex", key: keyof RunnerMetadata & string): string[] | null {
	const object = metadata[objectKey]
	if (!isJsonObject(object)) return null
	const value = object[key]
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null
}

export function storedItemExtra(value: JsonObject): ItemExtra {
	assertStoredItemExtra(value)
	return value
}

export function parseItemExtraForRequest(value: JsonObject, field = "extra"): ItemExtra {
	validateKnownItemExtra(value, field)
	assertStoredItemExtra(value)
	return value
}

export function itemDependsOnIds(extra: ItemExtra): number[] {
	const value = extra.dependsOn
	if (!Array.isArray(value)) return []
	return value.filter((entry) => Number.isInteger(entry) && entry >= 1)
}

export function withDependsOnExtra(extra: ItemExtra, dependsOn: readonly number[] | null | undefined): ItemExtra {
	if (dependsOn === undefined) return extra
	const next: ItemExtra = { ...extra }
	if (dependsOn === null) {
		delete next.dependsOn
	} else {
		next.dependsOn = [...dependsOn]
	}
	return next
}

export function itemSchedulerBackoff(extra: ItemExtra): SchedulerBackoffState | null {
	const value = extra.schedulerBackoff
	if (!isJsonObject(value)) return null
	if (!isPositiveInteger(value.failureCount) || !isPositiveInteger(value.nextRunAt)) return null
	assertSchedulerBackoffState(value)
	return value
}

export function withSchedulerBackoff(extra: ItemExtra, state: SchedulerBackoffState): ItemExtra {
	return { ...extra, schedulerBackoff: state }
}

export function clearSchedulerBackoff(extra: ItemExtra): ItemExtra {
	if (extra.schedulerBackoff === undefined) return extra
	const next: ItemExtra = { ...extra }
	delete next.schedulerBackoff
	return next
}

export function withSchedulerSpawnError(extra: ItemExtra, error: SchedulerSpawnError): ItemExtra {
	return { ...extra, schedulerSpawnError: error }
}

export function clearSchedulerSpawnError(extra: ItemExtra): ItemExtra {
	if (extra.schedulerSpawnError === undefined) return extra
	const next: ItemExtra = { ...extra }
	delete next.schedulerSpawnError
	return next
}

export function chainCompleteTriggerState(metadata: ChainMetadata): ChainCompleteTriggerState | null {
	const value = metadata.coderLoopChainCompleteTrigger
	if (!isJsonObject(value)) return null
	assertChainCompleteTriggerState(value)
	return value
}

export function withoutChainCompleteTriggerState(metadata: ChainMetadata): ChainMetadata {
	if (metadata.coderLoopChainCompleteTrigger === undefined) return metadata
	const next: ChainMetadata = { ...metadata }
	delete next.coderLoopChainCompleteTrigger
	return next
}

export function withChainCompleteTriggerState(metadata: ChainMetadata, state: ChainCompleteTriggerState): ChainMetadata {
	return { ...metadata, coderLoopChainCompleteTrigger: state }
}

export function runtimeDataJsonValue(value: unknown): JsonValue {
	return isJsonValue(value) ? value : String(value)
}

function assertStoredChainMetadata(_value: JsonObject): asserts _value is ChainMetadata {}

function assertStoredItemExtra(_value: JsonObject): asserts _value is ItemExtra {}

function assertSchedulerBackoffState(value: JsonObject): asserts value is SchedulerBackoffState {
	if (isPositiveInteger(value.failureCount) && isPositiveInteger(value.nextRunAt)) return
	throw runtimeDataError("extra.schedulerBackoff", value, "extra.schedulerBackoff must contain positive integer failureCount and nextRunAt")
}

function assertChainCompleteTriggerState(value: JsonObject): asserts value is ChainCompleteTriggerState {
	if (value.decision === undefined || value.decision === "keep-active") return
	throw runtimeDataError("metadata.coderLoopChainCompleteTrigger.decision", value.decision, "metadata.coderLoopChainCompleteTrigger.decision must be keep-active when provided")
}

function validateKnownChainMetadata(metadata: JsonObject, field: string): void {
	validateOptionalString(metadata, "presetPath", `${field}.presetPath`)
	validateOptionalString(metadata, "workflowFile", `${field}.workflowFile`)
	validateOptionalString(metadata, "sharedContextFile", `${field}.sharedContextFile`)
	validateOptionalString(metadata, "issueDir", `${field}.issueDir`)
	validateOptionalString(metadata, "evidenceDir", `${field}.evidenceDir`)
	validateOptionalString(metadata, "logDir", `${field}.logDir`)
	validateOptionalBoolean(metadata, "worktree", `${field}.worktree`)
	validateOptionalPositiveInteger(metadata, "maxItemAttempts", `${field}.maxItemAttempts`)
	validateOptionalJsonObject(metadata, "config", `${field}.config`)
	validateOptionalRunnerMetadata(metadata, "claude", `${field}.claude`)
	validateOptionalRunnerMetadata(metadata, "codex", `${field}.codex`)
	validateOptionalChainCompleteTriggerState(metadata, "coderLoopChainCompleteTrigger", `${field}.coderLoopChainCompleteTrigger`)
}

function validateKnownItemExtra(extra: JsonObject, field: string): void {
	validateOptionalDependsOn(extra, "dependsOn", `${field}.dependsOn`)
	validateOptionalString(extra, "blockerRepo", `${field}.blockerRepo`)
	validateOptionalString(extra, "blockerRef", `${field}.blockerRef`)
	validateOptionalSchedulerBackoff(extra, "schedulerBackoff", `${field}.schedulerBackoff`)
	validateOptionalSchedulerSpawnError(extra, "schedulerSpawnError", `${field}.schedulerSpawnError`)
	validateOptionalString(extra, "issueKind", `${field}.issueKind`)
	validateOptionalString(extra, "slotKey", `${field}.slotKey`)
	validateOptionalPositiveInteger(extra, "itemId", `${field}.itemId`)
	validateOptionalString(extra, "repoCwd", `${field}.repoCwd`)
	validateOptionalString(extra, "worktreePath", `${field}.worktreePath`)
	validateOptionalString(extra, "startStatus", `${field}.startStatus`)
	validateOptionalPositiveInteger(extra, "startStatusUpdatedAt", `${field}.startStatusUpdatedAt`)
	validateOptionalString(extra, "startPhase", `${field}.startPhase`)
	validateOptionalPositiveInteger(extra, "pid", `${field}.pid`)
	validateOptionalBoolean(extra, "processGroupLeader", `${field}.processGroupLeader`)
}

function validateOptionalRunnerMetadata(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!isJsonObject(value)) throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
	validateOptionalString(value, "binary", `${field}.binary`)
	validateOptionalString(value, "model", `${field}.model`)
	validateOptionalStringArray(value, "extraArgs", `${field}.extraArgs`)
}

function validateOptionalChainCompleteTriggerState(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!isJsonObject(value)) throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
	if (value.decision !== undefined && value.decision !== "keep-active") {
		throw runtimeDataError(`${field}.decision`, value.decision, `${field}.decision must be keep-active when provided`)
	}
	validateOptionalString(value, "fingerprint", `${field}.fingerprint`)
	validateOptionalPositiveInteger(value, "recordedAt", `${field}.recordedAt`)
	validateOptionalString(value, "reason", `${field}.reason`)
	validateOptionalString(value, "runId", `${field}.runId`)
}

function validateOptionalSchedulerBackoff(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!isJsonObject(value)) throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
	validateRequiredPositiveInteger(value, "failureCount", `${field}.failureCount`)
	validateRequiredPositiveInteger(value, "nextRunAt", `${field}.nextRunAt`)
}

function validateOptionalSchedulerSpawnError(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!isJsonObject(value)) throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
	validateRequiredPositiveInteger(value, "at", `${field}.at`)
	validateRequiredString(value, "phase", `${field}.phase`)
	validateRequiredString(value, "message", `${field}.message`)
}

function validateOptionalDependsOn(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!Array.isArray(value)) throw runtimeDataError(field, value, `${field} must be an array of positive item ids when provided`)
	value.forEach((entry, index) => {
		if (!isPositiveInteger(entry)) throw runtimeDataError(`${field}[${index}]`, entry, `${field}[${index}] must be a positive item id`)
	})
}

function validateOptionalJsonObject(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (!isJsonObject(value)) throw runtimeDataError(field, value, `${field} must be a JSON object when provided`)
}

function validateOptionalString(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (typeof value === "string") return
	throw runtimeDataError(field, value, `${field} must be a string when provided`)
}

function validateRequiredString(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (typeof value === "string") return
	throw runtimeDataError(field, value, `${field} must be a string`)
}

function validateOptionalStringArray(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return
	throw runtimeDataError(field, value, `${field} must be a string array when provided`)
}

function validateOptionalBoolean(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (typeof value === "boolean") return
	throw runtimeDataError(field, value, `${field} must be a boolean when provided`)
}

function validateOptionalPositiveInteger(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (value === undefined) return
	if (isPositiveInteger(value)) return
	throw runtimeDataError(field, value, `${field} must be a positive integer when provided`)
}

function validateRequiredPositiveInteger(record: JsonObject, key: string, field: string): void {
	const value = record[key]
	if (isPositiveInteger(value)) return
	throw runtimeDataError(field, value, `${field} must be a positive integer`)
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function runtimeDataError(field: string, value: JsonValue | undefined, message: string): RuntimeDataError {
	return new RuntimeDataError(message, { field, value: value === undefined ? null : value })
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (value === undefined || typeof value !== "object") return false
	return Object.values(value).every(isJsonValue)
}
