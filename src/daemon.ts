import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import {
	buildPhaseRunnerSelectionFromChain,
	loadPreset,
	phaseChainActions,
	phaseWritableStatuses,
	runPresetChainCompleteTriggerPhases,
	PRESET_PHASE_CHAIN_ACTIONS,
	type AgentRunnerKind,
	type AgentRunnerSelection,
	type JsonObject,
	type JsonValue,
	type LoadPresetOptions,
	type PresetDagFinding,
	type PresetPhaseChainAction,
	type PresetPhaseRights,
	type PresetPlaceholderFinding,
} from "./loop"
import {
	cleanupSchedulerChainWorktrees,
	createSchedulerState,
	listActiveRuns,
	listPendingCloseHandlers,
	markRunPendingRecycle,
	maxItemAttemptsFromChainMetadata,
	schedulerTick,
	type SchedulerCompletedRun,
	type SchedulerEvent,
	type SchedulerChainWorktreeCleanup,
	type SchedulerLoadedPreset,
	type SchedulerOptions,
	type SchedulerPresetResolver,
	type SchedulerPresetItemResolver,
	type SchedulerRunCredential,
	type SchedulerRunCredentialContext,
	type SchedulerRunCredentialIssuer,
	type SchedulerSpawnContext,
	type SchedulerState,
} from "./scheduler"
import {
	type ChainRecord,
	type CreateChainInput,
	type CreateItemInput,
	type DependencyWaitReason,
	type ItemRecord,
	listDependencyWaitReasons,
	openSqliteStateStore,
	type RunRecord,
	type SqliteStateStore,
	type UpdateItemInput,
} from "./sqlite-state"
import {
	assertRequestAdmittedItemStatus,
	chainMetadataToJsonObject,
	chainPresetPath,
	engineLifecycleAdmittedItemStatus,
	itemDependsOnIds,
	itemExtraToJsonObject,
	parseInternalStatus,
	parseChainMetadataForRequest,
	parseItemExtraForRequest,
	runtimeDataJsonValue,
	storedItemExtra,
	RuntimeDataError,
	type AdmittedItemStatus,
	type InternalStatus,
	type ItemExtra,
} from "./runtime-data"
import {
	LOOP_RUN_CREDENTIAL_ENV,
	type LoopDataRootOptions,
	RuntimePathError,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	sanitizeChainName,
} from "./runtime-paths"
import {
	appendObservabilityEvent,
	appendObservabilityEventSync,
	makeObservabilityEvent,
	observabilityDecisionFingerprint,
	observabilityDecisionKey,
	observabilityEventToJsonValue,
	parseObservabilityEventType,
	parseObservabilityKind,
	queryObservabilityEvents,
	renderObservabilityEvent,
	type ItemStatusAdmissionRecord,
	type ObservabilityEvent,
	type ObservabilityEventQuery,
	type ObservabilitySubject,
	type ItemUpdateFieldWriteReason,
	type PrivilegedOpAuditOp,
	type PrivilegedOpAuditReason,
} from "./observability"

// #409: every daemon command an agent process can reach belongs to exactly one
// authorization class. The classification is the engine's compile-time gate —
// `DaemonCommandSpecs` indexes every command on this union and the
// `assertNeverDaemonCommand` exhaustiveness check at the request-dispatch site
// rejects a new command added without an entry (and therefore without an auth
// classification). Hard-deny is engine-internal vocabulary; presets cannot
// grant or revoke it (#409 acceptance #1 — "无授权语法，不给 preset 开口").
//
// - `hard-deny-for-agent` — agents credentialed via #406 are rejected before
//   the handler body runs. Operator callers (no credential) pass. There is no
//   preset surface to grant these for an agent. Covers chain lifecycle
//   (create/stop/resume/delete), `daemon.down`, `logs.query` (#411 visibility
//   minimum), and `queue.unblock` (operator-only blocker unwedge).
// - `per-phase-authorized` — agents are allowed iff their currently-running
//   phase's `[phases.rights] privilegedOps` declares the op. Today only
//   `item.reorder` is here (review's expanded-incomplete-parent flow needs it).
// - `mutation-credential-gated` — the existing #406/#407/#405 per-item caller
//   + rights/exit gates already cover these handlers; this class is a marker
//   so the dispatch-table classification stays exhaustive but the existing
//   handlers keep their bespoke authorization logic (`handleItemUpdate`,
//   `handleItemAdd`, `handleItemBatchAdd`, `handleItemExitAction`).
// - `read-no-auth` — read-only inspection that does not mutate engine state
//   or leak cross-run observability. Available to both operators and agents.
export type DaemonCommandAuthClass =
	| "hard-deny-for-agent"
	| "per-phase-authorized"
	| "mutation-credential-gated"
	| "read-no-auth"

export type DaemonCommandName =
	| "chain.create"
	| "chain.list"
	| "chain.status"
	| "chain.stop"
	| "chain.resume"
	| "chain.delete"
	| "item.add"
	| "item.batchAdd"
	| "item.list"
	| "item.update"
	| "item.reorder"
	// #451 typed phase-exits query face. Read-side companion to the #397
	// write-side default-deny gate: the agent asks "what may I write from my
	// currently-running phase?" before issuing the write.
	| "item.exits"
	// #405 chain-action exit-selection write face. Agent picks a chain-action
	// exit (today only `stop`) declared in the phase's [[phases.exits]] — the
	// daemon gates against the phase's declared options and routes the selected
	// action through the same code path as operator `chain.stop` (D1: scheduler
	// stops selecting from this chain, in-flight runs naturally complete,
	// `chain resume` reversible). Agent direct `chain.stop` calls are still
	// rejected (#409); this is the only controlled channel for an agent to stop
	// the chain it owns.
	| "item.exitAction"
	| "daemon.status"
	| "daemon.down"
	// #409: previously executed inline in the CLI process — moved behind the
	// daemon socket so the hard-deny gate is the only architectural seam an
	// agent process can hit. `logs.query` reads the observability event stream
	// (cross-run / cross-chain — contract-5 minimum visibility forbids the
	// agent from seeing it); `queue.unblock` performs the operator-only
	// blocker-clearing mutation (SQLite restore of an unblockable item to the
	// preset's entry status).
	| "logs.query"
	| "queue.unblock"

// #409: the privileged-op vocabulary the preset's `[phases.rights]
// privilegedOps` segment may grant a phase. Closed engine-internal union — the
// preset parser narrows the `ReadonlySet<string>` field into
// `ReadonlySet<PresetPhasePrivilegedOp>` and rejects unknown values at preset
// load with the full vocabulary in the error message.
//
// Today the only entry is `item.reorder` — review's expanded-incomplete-parent
// flow legitimately needs it (`presets/gh-issue-pr-iteration/review/
// update-state.md`). Adding a future per-phase-authorized op = extend this
// `as const` tuple, switch its dispatch-table entry to `per-phase-authorized`,
// and the typechecker carries the rest.
export const PRESET_PHASE_PRIVILEGED_OPS = ["item.reorder"] as const
export type PresetPhasePrivilegedOp = (typeof PRESET_PHASE_PRIVILEGED_OPS)[number]

// #410 field-write rights — engine domain classification of `item.update`'s field axis. Three
// disjoint domains plus the #397 status field. The control-plane domain is the engine's seam
// between scheduler/executor decisions and item state; agents are default-denied here and
// presets cannot grant — the preset parser refuses any control-plane name in `writableFields`
// with a clear vocabulary error. Passthrough fields are open to per-phase grant. `extra` /
// `extraPatch` are aggregate carriers — the gate expands them and gates each inner key
// individually (with `dependsOn` short-circuited to control-plane regardless of carrier,
// because the existing extra-flatten path in `handleItemUpdate` lifts it to top-level).
//
// The classification helper `classifyItemUpdateField` runs an exhaustive switch over this union
// and uses `assertNever` to force a new field added to `ITEM_UPDATE_FIELD_KEYS` to receive a
// verdict before the project builds. The control-plane set below is the single source of truth
// the preset parser cross-checks against, so the two sides of the contract cannot drift.
export const PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS = ["repoCwd", "runner", "dependsOn", "priority"] as const
export type ItemUpdateControlPlaneField = (typeof PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS)[number]
// Passthrough = the agent-grantable subset. `extra` / `extraPatch` are aggregates and are NOT in
// either set — their grant happens via the inner-key expansion against `writableFields`. #419:
// `branch` / `pr` retired from the top-level passthrough set; presets that need to grant them now
// declare them in `[item.fields]` and the agent writes via `extraPatch` (the same gate matrix
// runs through the extra-inner expansion path in `collectItemUpdateFieldKeys`, so the per-phase
// `writableFields` declaration on review continues to authorize them).
const PRESET_PHASE_RIGHTS_PASSTHROUGH_FIELDS = ["title", "issueFile", "evidenceDir"] as const
type ItemUpdatePassthroughField = (typeof PRESET_PHASE_RIGHTS_PASSTHROUGH_FIELDS)[number]

// #410 the exhaustive classification verdict for `ItemUpdateFieldName`. Reading any update
// field through this discriminated union forces every call site to handle every domain.
export type ItemUpdateFieldClassification =
	| { kind: "status" }
	| { kind: "control-plane"; field: ItemUpdateControlPlaneField }
	| { kind: "passthrough"; field: ItemUpdatePassthroughField }
	| { kind: "aggregate"; field: "extra" | "extraPatch" }

export function classifyItemUpdateField(field: ItemUpdateFieldName): ItemUpdateFieldClassification {
	switch (field) {
		case "status":
			return { kind: "status" }
		case "repoCwd":
		case "runner":
		case "dependsOn":
		case "priority":
			return { kind: "control-plane", field }
		case "title":
		case "issueFile":
		case "evidenceDir":
			return { kind: "passthrough", field }
		case "extra":
		case "extraPatch":
			return { kind: "aggregate", field }
		default:
			return assertNeverItemUpdateField(field)
	}
}

function assertNeverItemUpdateField(field: never): never {
	throw new DaemonError("internal_error", `unhandled item.update field axis: ${JSON.stringify(field)}`, {})
}

// #410 the set form used by the preset parser to reject control-plane name attempts. Built once
// from the `as const` tuple so the parser and the classifier consume the same source of truth.
export const PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELD_SET: ReadonlySet<string> =
	new Set(PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS)

export type DaemonRequest = {
	id: string
	command: string
	args: JsonObject
}

export type DaemonResponse =
	| { id: string; ok: true; result: JsonObject }
	| { id: string; ok: false; error: DaemonResponseError }

export type DaemonResponseError = {
	code: string
	message: string
	details?: JsonObject
}

export type CoderLoopDaemonSchedulerConfig = Partial<Omit<SchedulerOptions, "store" | "state" | "presetForChain">> & {
	enabled?: boolean
	intervalMs?: number
	presetDir?: string
	presetForChain?: SchedulerPresetResolver
	presetForItem?: SchedulerPresetItemResolver
}

export type StartCoderLoopDaemonOptions = LoopDataRootOptions & {
	scheduler?: CoderLoopDaemonSchedulerConfig
	shutdownGraceMs?: number
}

export type CoderLoopDaemonSnapshot = {
	pid: number
	socketPath: string
	pidFile: string
	running: boolean
	shuttingDown: boolean
	schedulerEnabled: boolean
	activeRuns: JsonObject[]
}

type DaemonState = "starting" | "running" | "shutting_down" | "exited"
type UnknownRecord = { [key: string]: unknown }
export type DaemonSocketPathIssue = {
	kind: "daemon_socket_unlinked"
	pid: number
	socketPath: string
	pidFile: string
}

const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const BUNDLED_PRESETS_DIR = resolve(import.meta.dir, "../presets")
const MAX_DAEMON_REQUEST_BYTES = 1_048_576
const MAX_CHAIN_METADATA_BYTES = 16_384
const MAX_CHAIN_METADATA_DEPTH = 8
const MAX_ITEM_EXTRA_BYTES = 16_384
const MAX_ITEM_EXTRA_DEPTH = 8
const MAX_ITEM_TITLE_LENGTH = 1024
const MAX_REPO_CWD_LENGTH = 4096
const MAX_REPOSITORY_REF_LENGTH = 200
const STALE_RECOVERY_FORCE_AFTER_MS = 1_000
const ORPHANED_RUN_STATUS = parseInternalStatus("orphaned", "daemon.orphanedRunStatus")
const ORPHANED_RUN_EXIT_CODE = -1
const DAEMON_SOCKET_PATH_CHECK_INTERVAL_MS = 250
const ORPHAN_CHAIN_DIR_PREFIX = ".orphan-"
const RESERVED_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"])
const ITEM_PRIORITY_VALUES = ["low", "medium", "high", "critical"] as const
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
// Shared by repoCwd and item-level presetPath validation — defining as a constant avoids escaping
// the raw control characters inline at every call site.
const PRESET_PATH_CONTROL_CHAR_REGEX: RegExp = new RegExp("[\\u0000-\\u001f\\u007f]", "u")
const REPOSITORY_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const CHAIN_CREATE_ARG_KEYS = [
	"name",
	"preset",
	"repository",
	"baseBranch",
	"metadata",
	"force",
] as const
const ITEM_ADD_ARG_KEYS = [
	"chainId",
	"chainName",
	"name",
	// #419: opaque string item id (replaces `issueNumber` integer wire field).
	"itemId",
	"repoCwd",
	"title",
	"priority",
	// #419: `branch` / `pr` are retired from the top-level item.add wire. Presets that declare
	// them in `[item.fields]` (e.g. `gh-issue-pr-iteration`) accept them via the `extra` carrier
	// instead — same admission path as any other preset-declared transparent field.
	"issueFile",
	"evidenceDir",
	"runner",
	// #412: preset declaration site moved from chain to item. Exactly one of `preset` (bundled name)
	// or `presetPath` (absolute filesystem dir) is required at the API boundary.
	"preset",
	"presetPath",
	"extra",
	"dependsOn",
	// #407: env-borne credential threaded through `withInjectedRunCredential` (loop.ts). Present
	// only when the request originates inside an active agent run; operator CLI invocations have no
	// such env so the field is absent and the caller-admission gate routes through the operator leg.
	"agentCredential",
] as const
// #407 batch-add: `agentCredential` is a BATCH-level field (one credential per request, validated
// once) — explicitly NOT per-item, so it is removed from `ITEM_BATCH_ADD_ITEM_KEYS` below.
const ITEM_BATCH_ADD_ARG_KEYS = ["chainId", "chainName", "name", "items", "agentCredential"] as const
const ITEM_BATCH_ADD_ITEM_KEYS = ITEM_ADD_ARG_KEYS.filter((key) => key !== "chainId" && key !== "chainName" && key !== "name" && key !== "agentCredential")
// #419: itemId here is the opaque string preset-id identifier (string), distinct from the rowid
// integer selector that the daemon also accepts. Both are routed in `resolveItem`: a numeric
// `itemId` is the rowid; a string `itemId` is the preset-declared opaque identity. The legacy
// `issueNumber` wire selector is retired (no compatibility alias — wire is breaking-renamed per
// #456 precedent).
const ITEM_UPDATE_SELECTOR_KEYS = ["itemId", "chainId", "chainName", "name"] as const
// #410 exported: the engine's compile-time vocabulary of writable item-update fields. The
// per-phase field-write gate (`gateItemUpdateFieldWrites`) exhausts this union — adding a new
// entry forces a classification verdict in `classifyItemUpdateField`, which the typechecker
// enforces via `assertNever`. Preset authors only see this vocabulary indirectly through the
// `[phases.rights] writableFields` declaration; the engine refuses any name in `writableFields`
// that classifies as control-plane (see `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS` below).
// #419: `branch` / `pr` retired from the top-level item.update field vocabulary. Presets that
// declare them in `[item.fields]` (gh-issue-pr-iteration ships with `branch = "string"` / `pr =
// "number"`) now route writes through the `extra` / `extraPatch` aggregate path; the same gate
// matrix expands the inner keys and checks them against the caller-phase's `writableFields`, so
// gh-issue-pr-iteration's `phases.rights.writableFields = ["branch", "pr", ...]` continues to
// authorize review-phase writes without any admission-gate code change.
export const ITEM_UPDATE_FIELD_KEYS = [
	"repoCwd",
	"status",
	"title",
	"priority",
	"issueFile",
	"evidenceDir",
	"runner",
	"extra",
	"extraPatch",
	"dependsOn",
] as const
export type ItemUpdateFieldName = (typeof ITEM_UPDATE_FIELD_KEYS)[number]
// #406: `agentRunId` / `agentPhase` are retired from the request boundary in favor of
// the env-borne credential (see `CALLER_REJECTED_LEGACY_ATTRIBUTION_KEYS` below). They are
// rejected with `unsupported field` so the only way for an agent to claim a (run, phase) is via
// a credential the engine itself minted — agents cannot hand-write their identity.
const ITEM_UPDATE_ARG_KEYS = [...ITEM_UPDATE_SELECTOR_KEYS, "fields", ...ITEM_UPDATE_FIELD_KEYS, "agentCredential"] as const
// #409: `agentCredential` joins item.reorder's known-keys set so the CLI's auto-injection
// from `CODER_LOOP_RUN_CRED` is accepted by the daemon. The per-phase-authorized gate at
// `runAuthorizationGate` decides allow/deny; the handler body re-resolves the item by its
// selector and never reads the credential field directly.
const ITEM_REORDER_ARG_KEYS = [...ITEM_UPDATE_SELECTOR_KEYS, "position", "agentCredential"] as const
// #451 typed phase-exits query. Same selector vocabulary as `item.update`; the
// agent attribution pair (`agentRunId` + `agentPhase`) is required (not
// optional like on `item.update`) because the query face exists specifically to
// answer "what can THIS agent run, in THIS phase, write?" — the item's
// last-write phase column is not necessarily the same phase the agent is
// running right now.
const ITEM_EXITS_ARG_KEYS = [...ITEM_UPDATE_SELECTOR_KEYS, "agentRunId", "agentPhase"] as const
// #405: same selector + agent-binding pair as `item.exits`, plus the chosen
// `action` and the optional `agentCredential` envelope. The action vocabulary
// itself is gated against the phase's declared chain-action exits inside the
// handler — the request boundary only enforces the call shape.
const ITEM_EXIT_ACTION_ARG_KEYS = [...ITEM_UPDATE_SELECTOR_KEYS, "agentRunId", "agentPhase", "action", "agentCredential"] as const

// #409 logs.query request envelope. Mirrors `ObservabilityEventQuery` plus the
// `agentCredential` envelope used by the auth gate. `chain` is the chain name
// (not chainId); `item` is the item rowid; `run` is the runId. None of these
// fields scopes the query for security purposes (the hard-deny gate already
// kicked in by the time the handler runs), they're just selectors.
const LOGS_QUERY_ARG_KEYS = ["kind", "type", "chain", "item", "run", "phase", "since", "agentCredential"] as const
// #409 queue.unblock request envelope. Same chain-selector vocabulary the rest
// of the daemon uses, plus the issue id (the original CLI accepted only
// `--issue`, which is the issue number). `agentCredential` lets the daemon
// hard-deny agents.
const QUEUE_UNBLOCK_ARG_KEYS = ["chainId", "chainName", "name", "issue", "dryRun", "agentCredential"] as const

// #406: parsed item-mutation caller — the typed result of the daemon's boundary parse of the
// `agentCredential` request field. `operator` carries no run binding (the operator path takes
// no credential at all); `agent` carries the binding the daemon resolved from the credential's
// active-run registry entry — runId/phase here are the engine-bound values, NOT a caller claim.
// Downstream handlers switch exhaustively on `kind` so "anonymous mutation" is unrepresentable.
type ItemMutationCaller =
	| { kind: "operator"; subject: Extract<ObservabilitySubject, { kind: "operator" }> }
	| { kind: "agent"; runId: string; phase: string; subject: Extract<ObservabilitySubject, { kind: "agent" }> }

// #406 caller-admission deny reasons. Co-located with the observability event union (every
// reason here appears in `item.mutation.caller_admission.payload.reason`). Mirrors the threat-
// model branches from issue body:
//   - `missing-credential`: agentCredential present but empty / not in registry → "stale or never-minted"
//   - `unknown-credential`: credential value doesn't match any registered active run
//   - `inactive-run`: credential resolves to a run no longer active (revoked but not yet GC'd)
//   - `wrong-item`: credential's bound itemId doesn't match the request's target item
type CallerAdmissionDenyReason =
	| "missing-credential"
	| "unknown-credential"
	| "inactive-run"
	| "wrong-item"

// #407 review-feedback refactor: the subset of `CallerAdmissionDenyReason` reachable from the
// boundary-parse resolver (`resolveItemMutationCaller`). `wrong-item` is item-bound and emitted
// later in `admitItemMutationCaller` after the resolver succeeds, so it is intentionally absent
// here. The resolver returns a typed `err` variant of exactly this shape — there is no string-
// match recovery of the reason from a thrown error, and no `unknown` widening of the credential
// field. Each err variant carries the typed payload the downstream audit / DaemonError needs.
type ResolveCallerDenyReason =
	| { kind: "missing-credential" }
	| { kind: "unknown-credential" }
	| { kind: "inactive-run"; runId: string }

// #407 review-feedback refactor: minimal Result sum type. The codebase has no Result/Either lib;
// rather than pull one in for one call site, declare the ADT inline. Exhaustive case analysis is
// the type-system contract — adding a new variant of either arm forces every consumer to handle
// it (no catch-all default in any switch). Defined locally to daemon.ts to keep the surface area
// of the type minimal until a second caller appears.
type Result<T, E> =
	| { kind: "ok"; value: T }
	| { kind: "err"; error: E }

// #406: the daemon-owned credential issuer. Implements `SchedulerRunCredentialIssuer` so the
// scheduler can mint/revoke without knowing it talks to a Map. Keyed by credential value because
// the request boundary has only the value in hand — the binding is what the registry returns.
type RunCredentialRegistration = {
	value: string
	context: SchedulerRunCredentialContext
}

export class DaemonError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details: JsonObject = {},
	) {
		super(message)
		this.name = "DaemonError"
	}
}

export function schedulerEventToObservabilityEvent(chain: ChainRecord, event: SchedulerEvent): ObservabilityEvent {
	switch (event.type) {
		case "slot.busy":
			return makeObservabilityEvent({
				kind: "decision",
				type: "slot.busy",
				chain: chain.name,
				runId: event.activeRunId,
				subject: { kind: "engine" },
				payload: { slotKey: event.slotKey, chainId: event.chainId, repoCwd: event.repoCwd, activeRunId: event.activeRunId },
			})
		case "item.dependency_wait":
			return makeObservabilityEvent({
				kind: "decision",
				type: "item.dependency_wait",
				chain: chain.name,
				// #419 review I2: `event.item` on the observability envelope carries the rowid
				// (which legacy consumers grep for); the typed payload now exposes that integer
				// on `rowId` instead of the colliding `itemId` field.
				item: event.rowId,
				subject: { kind: "engine" },
				payload: { rowId: event.rowId, dependsOn: [...event.dependsOn], unsatisfied: [...event.unsatisfied] },
			})
		case "item.backoff":
			return makeObservabilityEvent({
				kind: "decision",
				type: "item.backoff",
				chain: chain.name,
				item: event.rowId,
				subject: { kind: "engine" },
				payload: { rowId: event.rowId, failureCount: event.failureCount, nextRunAt: event.nextRunAt },
			})
		case "agent.spawn":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "agent.spawn",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { slotKey: event.slotKey, pid: event.pid, worktreePath: event.worktreePath, presetDir: event.presetDir },
			})
		case "agent.exit":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "agent.exit",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "agent", runId: event.runId, phase: event.phase },
				payload: { slotKey: event.slotKey, exitCode: event.exitCode, status: event.status, excerpt: event.excerpt },
			})
		case "session_id.invalidated":
			return makeObservabilityEvent({
				kind: "validation",
				type: "session_id.invalidated",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { runner: event.runner, previousSessionId: event.previousSessionId, reason: event.reason },
			})
		case "spawn.aborted":
			return makeObservabilityEvent({
				kind: "validation",
				type: "spawn.aborted",
				chain: chain.name,
				item: event.itemId,
				subject: { kind: "engine" },
				payload: { slotKey: event.slotKey, chainId: event.chainId, id: event.id, reason: event.reason, toStatus: event.toStatus },
			})
		case "chain.complete_trigger":
			return makeObservabilityEvent({
				kind: "decision",
				type: "chain.complete_trigger",
				chain: chain.name,
				...(event.runId === undefined ? {} : { runId: event.runId }),
				subject: { kind: "engine" },
				payload: {
					chainId: event.chainId,
					decision: event.decision,
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			})
		case "chain.complete_trigger_failed":
			return makeObservabilityEvent({
				kind: "diagnostic",
				type: "chain.complete_trigger_failed",
				chain: chain.name,
				...(event.runId === undefined ? {} : { runId: event.runId }),
				subject: { kind: "engine" },
				payload: { chainId: event.chainId, error: event.error },
			})
		case "chain.completed":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "chain.completed",
				chain: chain.name,
				...(event.runId === undefined ? {} : { runId: event.runId }),
				subject: { kind: "engine" },
				payload: { chainId: event.chainId },
			})
		case "phase.start":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "phase.start",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { repoCwd: event.repoCwd, pid: event.pid },
			})
		case "phase.end":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "phase.end",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { exitCode: event.exitCode, durationSeconds: event.durationSeconds, status: event.status },
			})
		case "attempt.timeout":
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "attempt.timeout",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { signal: event.signal, attemptMs: event.attemptMs, excerpt: event.excerpt },
			})
		case "recycle.pending_entered":
			// #452 lifecycle: agent wrote item status, recycle clock armed. Carries the
			// window duration so an observer can pair this with the eventual
			// `recycle.timeout_kill` or `recycle.natural_exit` event for the same runId.
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "recycle.pending_entered",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { recycleAfterMs: event.recycleAfterMs },
			})
		case "recycle.timeout_kill":
			// #452 lifecycle: recycle window elapsed without natural exit; engine SIGKILLed
			// the process group. Carries the excerpt for diagnostics so an auditor can see
			// what the wedge was doing without re-reading the run logs.
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "recycle.timeout_kill",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { signal: event.signal, recycleAfterMs: event.recycleAfterMs, excerpt: event.excerpt },
			})
		case "recycle.natural_exit":
			// #452 lifecycle: child closed during the recycle window without timeout.
			// Carries `elapsedMs` so the lifecycle stream tells whether agents tend to
			// exit fast after writing state (small elapsedMs) or sit on the window edge.
			return makeObservabilityEvent({
				kind: "lifecycle",
				type: "recycle.natural_exit",
				chain: chain.name,
				item: event.itemId,
				runId: event.runId,
				phase: event.phase,
				subject: { kind: "engine" },
				payload: { elapsedMs: event.elapsedMs },
			})
		case "queue.terminal":
			return makeObservabilityEvent({
				kind: "audit",
				type: "queue.terminal",
				chain: chain.name,
				// #419 review I2: envelope `item` slot carries the rowid for grep-friendly correlation
				// against runs.item_id; the typed payload moved the integer from `itemId` (which now
				// uniformly means opaque string identity) to `rowId` to match the split convention.
				item: event.rowId,
				runId: event.runId,
				subject: { kind: "engine" },
				payload: { rowId: event.rowId, terminalStatus: event.terminalStatus },
			})
		case "item.dependency_unblocked":
			return makeObservabilityEvent({
				kind: "audit",
				type: "item.dependency_unblocked",
				chain: chain.name,
				item: event.rowId,
				subject: { kind: "engine" },
				payload: {
					rowId: event.rowId,
					fromStatus: event.fromStatus,
					toStatus: event.toStatus,
					dependsOn: [...event.dependsOn],
				},
			})
		default:
			return assertNeverSchedulerEvent(event)
	}
}

export class CoderLoopDaemon {
	private readonly paths: ReturnType<typeof resolveLoopDataPaths>
	private readonly schedulerState: SchedulerState = createSchedulerState()
	private readonly sockets = new Set<Socket>()
	private readonly shutdownGraceMs: number
	private server: Server | null = null
	private store: SqliteStateStore | null = null
	private state: DaemonState = "starting"
	private schedulerTimer: ReturnType<typeof setInterval> | null = null
	private schedulerTickInFlight: Promise<void> | null = null
	private schedulerTickRequested = false
	private schedulerPauseDepth = 0
	private socketPathCheckTimer: ReturnType<typeof setInterval> | null = null
	private socketPathRepairInFlight: Promise<void> | null = null
	private ownsDaemonSocket = false
	private ownsDaemonPid = false
	private readonly lastDecisionFingerprints = new Map<string, string>()
	private readonly loadedPresetCache = new Map<string, Promise<SchedulerLoadedPreset>>()
	// #406 run credential registry. Map keyed on credential value → run binding. Lifetime is the
	// daemon process: when daemon down kills all active runs (#467), the registry dies with it,
	// matching the "credentials die with the process" invariant. Not persisted to SQLite — credentials
	// are process-instance-scoped, not durable state.
	private readonly runCredentialRegistry = new Map<string, RunCredentialRegistration>()
	private resolveClosed: (() => void) | null = null
	private readonly daemonBatchTimestamp = formatDaemonBatchTimestamp(new Date())
	// #409: classified dispatch table; built once at construction. Each entry binds a
	// `DaemonCommandName` to its authorization class and handler. The type forces every
	// command in the union to appear here — adding a new command without an entry breaks
	// the build (the source of truth for "no agent-reachable surface escapes classification").
	private readonly commandSpecs: Record<DaemonCommandName, DaemonCommandSpec>
	readonly closed: Promise<void>

	constructor(private readonly options: StartCoderLoopDaemonOptions = {}) {
		this.paths = resolveLoopDataPaths(options)
		this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000
		this.closed = new Promise((resolveClosed) => {
			this.resolveClosed = resolveClosed
		})
		this.commandSpecs = this.buildDaemonCommandSpecs()
	}

	async start(): Promise<this> {
		if (this.state !== "starting") throw new DaemonError("invalid_state", `daemon cannot start from state ${this.state}`)
		await this.prepareRuntimeDirectory()

		try {
			const pathIssue = await detectDaemonSocketPathIssue(this.paths.daemonSocket, this.paths.daemonPid)
			if (pathIssue !== null) throw daemonSocketPathIssueError(pathIssue)
			await removeStaleSocket(this.paths.daemonSocket)
			const server = createServer((socket) => this.acceptConnection(socket))
			this.server = server
			await listenOrReportSocketInUse(server, this.paths.daemonSocket)
			this.ownsDaemonSocket = true
			const store = openSqliteStateStore(this.options)
			this.store = store
			this.startSocketPathMonitor()
			await this.quarantineOrphanChainDirectories()
			await this.ensureRuntimeLayoutForExistingChains()
			await this.recoverStaleSchedulerState()
			await writeFile(this.paths.daemonPid, `${process.pid}\n`)
			this.ownsDaemonPid = true
			this.state = "running"
			await this.recordObservabilityEvent(makeObservabilityEvent({
				kind: "lifecycle",
				type: "daemon.start",
				subject: { kind: "engine" },
				payload: { pid: process.pid, socketPath: this.paths.daemonSocket },
			}))
			this.startSchedulerLoop()
			this.queueSchedulerTick()
			return this
		} catch (error) {
			await this.stopAfterStartFailure()
			throw translateDaemonStartError(error, { socketPath: this.paths.daemonSocket, pidFile: this.paths.daemonPid })
		}
	}

	snapshot(): CoderLoopDaemonSnapshot {
		return {
			pid: process.pid,
			socketPath: this.paths.daemonSocket,
			pidFile: this.paths.daemonPid,
			running: this.state === "running",
			shuttingDown: this.state === "shutting_down",
			schedulerEnabled: this.schedulerEnabled(),
			activeRuns: listActiveRuns(this.schedulerState).map((run) => ({
				runId: run.runId,
				pid: run.pid,
				itemId: run.itemId,
				chainId: run.chainId,
				repoCwd: run.repoCwd,
				worktreePath: run.worktreePath,
				startedAt: run.startedAt,
			})),
		}
	}

	async stop(): Promise<void> {
		if (this.state === "exited") return
		if (this.state !== "shutting_down") this.state = "shutting_down"
		// Durable shutdown marker so the global daemon.log records that the daemon
		// stopped on purpose — distinguishing a clean stop from a fatal/external kill.
		await this.recordObservabilityEvent(makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.stop",
			subject: { kind: "engine" },
			payload: { pid: process.pid },
		})).catch(() => undefined)
		// Pause scheduler tick: clears the interval timer, awaits any in-flight
		// tick, and bumps schedulerPauseDepth so requestSchedulerTick is gated
		// out for the remainder of shutdown. The resume callback would no-op
		// because state is now "shutting_down", so we deliberately discard it.
		await this.pauseSchedulerForMutation()
		await this.stopSocketPathMonitor()

		// Bounded-grace terminate instead of waiting for natural agent completion (#467).
		// Also covers the SIGTERM path (signal handler calls stop()), which previously
		// exited the daemon while detached agents kept running as orphans.
		const terminatedRuns = await this.terminateAllActiveRuns()
		if (terminatedRuns.length > 0) {
			await this.recordObservabilityEvent(makeObservabilityEvent({
				kind: "lifecycle",
				type: "daemon.stop.terminated_runs",
				subject: { kind: "engine" },
				payload: { pid: process.pid, runIds: terminatedRuns.map((run) => run.runId) },
			})).catch(() => undefined)
		}

		// Wait for pending close handlers to finish before closing SQLite.
		// attachRunCloseHandler may null activeRun before completeChainIfReady
		// finishes so the chain can complete. With active runs terminated above
		// this drains quickly instead of blocking on agent runtime.
		await this.waitForSchedulerQuiescence()

		for (const socket of this.sockets) socket.end()
		if (this.server !== null) {
			await closeServer(this.server)
			this.server = null
		}
		this.store?.close()
		this.store = null
		await this.removeOwnedRuntimeFiles()
		this.state = "exited"
		this.resolveClosed?.()
	}

	private async prepareRuntimeDirectory(): Promise<void> {
		try {
			await mkdir(this.paths.root, { recursive: true })
			await mkdir(this.paths.chainsDir, { recursive: true })
			await mkdir(this.paths.eventsDir, { recursive: true })
			await mkdir(this.paths.daemonLogDir, { recursive: true })
		} catch (error) {
			throw new DaemonError("db_unavailable", `unable to prepare loop-data directory at ${this.paths.root}: ${errorMessage(error)}`, {
				loopDataRoot: this.paths.root,
			})
		}
	}

	private async stopAfterStartFailure(): Promise<void> {
		await this.stopSocketPathMonitor()
		for (const socket of this.sockets) socket.destroy()
		if (this.server !== null) {
			await closeServer(this.server).catch(() => undefined)
			this.server = null
		}
		this.store?.close()
		this.store = null
		await this.removeOwnedRuntimeFiles()
		this.state = "exited"
		this.resolveClosed?.()
	}

	private startSocketPathMonitor(): void {
		if (this.socketPathCheckTimer !== null) return
		this.socketPathCheckTimer = setInterval(() => {
			if (this.socketPathRepairInFlight !== null) return
			this.socketPathRepairInFlight = this.ensureSocketPathReachable()
				.catch((error) => {
					process.stderr.write(`coder-loop daemon socket repair failed: ${errorMessage(error)}\n`)
					throw error
				})
				.finally(() => {
					this.socketPathRepairInFlight = null
				})
		}, DAEMON_SOCKET_PATH_CHECK_INTERVAL_MS)
	}

	private async stopSocketPathMonitor(): Promise<void> {
		if (this.socketPathCheckTimer !== null) {
			clearInterval(this.socketPathCheckTimer)
			this.socketPathCheckTimer = null
		}
		if (this.socketPathRepairInFlight !== null) await this.socketPathRepairInFlight
	}

	private async ensureSocketPathReachable(): Promise<void> {
		if (this.state === "shutting_down" || this.state === "exited") return
		if (await canUseDaemonSocketPath(this.paths.daemonSocket)) return

		const previousServer = this.server
		if (previousServer !== null) {
			await closeServer(previousServer)
			if (this.server === previousServer) this.server = null
		}

		await removeStaleSocket(this.paths.daemonSocket)
		const replacementServer = createServer((socket) => this.acceptConnection(socket))
		await listenOrReportSocketInUse(replacementServer, this.paths.daemonSocket)
		this.server = replacementServer
		this.ownsDaemonSocket = true
		await this.recordObservabilityEvent(makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.socket.rebind",
			subject: { kind: "engine" },
			payload: { pid: process.pid, socketPath: this.paths.daemonSocket },
		}))
	}

	private async waitForSchedulerQuiescence(): Promise<void> {
		while (true) {
			const activeRuns = listActiveRuns(this.schedulerState)
			const pendingCloseHandlers = listPendingCloseHandlers(this.schedulerState)
			if (activeRuns.length === 0 && pendingCloseHandlers.length === 0) return
			await Promise.all([
				...activeRuns.map((run) => run.closed.catch(() => undefined)),
				...pendingCloseHandlers.map((pendingCloseHandler) => pendingCloseHandler.catch(() => undefined)),
			])
		}
	}

	private async removeOwnedRuntimeFiles(): Promise<void> {
		if (this.ownsDaemonSocket) {
			await unlinkIfExists(this.paths.daemonSocket)
			this.ownsDaemonSocket = false
		}
		if (this.ownsDaemonPid) {
			await unlinkIfExists(this.paths.daemonPid)
			this.ownsDaemonPid = false
		}
	}

	private acceptConnection(socket: Socket): void {
		this.sockets.add(socket)
		socket.setEncoding("utf-8")
		let buffer = ""
		let oversizedRequestRejected = false
		socket.on("data", (chunk: string) => {
			if (oversizedRequestRejected) return
			buffer += chunk
			let newlineIndex = buffer.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				if (line.trim() !== "") void this.handleLine(socket, line)
				newlineIndex = buffer.indexOf("\n")
			}
			if (byteLength(buffer) > MAX_DAEMON_REQUEST_BYTES) {
				oversizedRequestRejected = true
				const actualBytes = byteLength(buffer)
				buffer = ""
				writeOversizedRequestResponse(socket, actualBytes)
			}
		})
		socket.on("close", () => {
			this.sockets.delete(socket)
		})
		socket.on("error", () => {
			this.sockets.delete(socket)
		})
	}

	private async handleLine(socket: Socket, line: string): Promise<void> {
		const response = await this.responseForLine(line)
		socket.write(`${JSON.stringify(response)}\n`)
		if (response.ok && response.result.shutdown === true) {
			socket.end()
			setTimeout(() => {
				void this.stop()
			}, 0)
		}
	}

	private async responseForLine(line: string): Promise<DaemonResponse> {
		let requestId = "unknown"
		try {
			validateRequestLineSize(line)
			const request = parseDaemonRequest(line)
			requestId = request.id
			if (this.state === "starting") {
				throw new DaemonError("daemon_starting", "daemon is still starting; retry after startup recovery completes", {
					state: this.state,
					command: request.command,
				})
			}
			const result = await this.handleRequest(request)
			return { id: request.id, ok: true, result }
		} catch (error) {
			return { id: requestId, ok: false, error: responseError(error) }
		}
	}

	// #409 classified dispatch. Each entry pairs a daemon command with an authorization class
	// (`DaemonCommandAuthClass`) and its handler. The TS object literal is typed as
	// `Record<DaemonCommandName, DaemonCommandSpec>`, so adding a `DaemonCommandName` without an
	// entry — or an entry whose `authClass` falls outside the closed union — fails the build.
	// `handleRequest` dispatches by looking up the spec and running the auth gate BEFORE the
	// handler body, so a hard-deny op cannot accidentally do work in the handler before the
	// gate fires.
	private buildDaemonCommandSpecs(): Record<DaemonCommandName, DaemonCommandSpec> {
		return {
			"chain.create": { authClass: "hard-deny-for-agent", handler: (args) => this.handleChainCreate(args) },
			"chain.list": { authClass: "read-no-auth", handler: () => Promise.resolve(this.handleChainList()) },
			"chain.status": { authClass: "read-no-auth", handler: (args) => this.handleChainStatus(args) },
			"chain.stop": { authClass: "hard-deny-for-agent", handler: (args) => this.handleChainStop(args) },
			"chain.resume": { authClass: "hard-deny-for-agent", handler: (args) => this.handleChainResume(args) },
			"chain.delete": { authClass: "hard-deny-for-agent", handler: (args) => this.handleChainDelete(args) },
			"item.add": { authClass: "mutation-credential-gated", handler: (args) => this.handleItemAdd(args) },
			"item.batchAdd": { authClass: "mutation-credential-gated", handler: (args) => this.handleItemBatchAdd(args) },
			"item.list": { authClass: "read-no-auth", handler: (args) => Promise.resolve(this.handleItemList(args)) },
			"item.update": { authClass: "mutation-credential-gated", handler: (args) => this.handleItemUpdate(args) },
			"item.reorder": { authClass: "per-phase-authorized", handler: (args) => this.handleItemReorder(args) },
			"item.exits": { authClass: "read-no-auth", handler: (args) => this.handleItemExits(args) },
			"item.exitAction": { authClass: "mutation-credential-gated", handler: (args) => this.handleItemExitAction(args) },
			"daemon.status": { authClass: "read-no-auth", handler: () => Promise.resolve({ daemon: daemonSnapshotToJson(this.snapshot()) }) },
			"daemon.down": {
				authClass: "hard-deny-for-agent",
				handler: async () => {
					// Terminate before replying so the caller sees which runs were cut short (#467).
					const terminatedRuns = await this.terminateAllActiveRuns()
					return {
						shutdown: true,
						terminatedRuns: terminatedRuns.map(completedRunToJson),
						daemon: daemonSnapshotToJson(this.snapshot()),
					}
				},
			},
			"logs.query": { authClass: "hard-deny-for-agent", handler: (args) => this.handleLogsQuery(args) },
			"queue.unblock": { authClass: "hard-deny-for-agent", handler: (args) => this.handleQueueUnblock(args) },
		}
	}

	private async handleRequest(request: DaemonRequest): Promise<JsonObject> {
		const narrowed = narrowDaemonCommandName(request.command)
		if (narrowed === null) {
			throw new DaemonError("unknown_command", `unknown daemon command: ${request.command}`, { command: request.command })
		}
		const spec = this.commandSpecs[narrowed]
		// #409 caller stratification. Hard-deny / per-phase-authorized classes consult the
		// caller-resolution result before running the handler. mutation-credential-gated and
		// read-no-auth bypass — the former runs its own bespoke per-item gate inside the
		// handler, the latter is unauthenticated by design.
		await this.runAuthorizationGate(narrowed, spec.authClass, request.args)
		return await spec.handler(request.args)
	}

	// #409 caller stratification gate. Returns void on allow; throws DaemonError on deny.
	// Emits exactly one `privileged_op.caller_admission` audit event per call (allow OR deny)
	// for hard-deny-for-agent and per-phase-authorized classes. Other classes return early
	// without emitting (their existing per-handler gates own auditing).
	private async runAuthorizationGate(
		op: DaemonCommandName,
		authClass: DaemonCommandAuthClass,
		args: JsonObject,
	): Promise<void> {
		switch (authClass) {
			case "read-no-auth":
				return
			case "mutation-credential-gated":
				return
			case "hard-deny-for-agent": {
				const auditOp = narrowPrivilegedOpAuditOp(op)
				if (auditOp === null) {
					// Defensive: a hard-deny op MUST be in the audit vocabulary so the gate's
					// verdict is replayable. This branch is structurally unreachable — adding a
					// new hard-deny op requires extending the boundary union in observability.ts
					// or the typechecker will fail at the recordPrivilegedOpAuditEvent call site.
					throw new DaemonError("internal_error", `privileged-op audit vocabulary missing for hard-deny op "${op}"`, { op })
				}
				const resolved = this.resolveItemMutationCaller(args)
				if (resolved.kind === "err") {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: { kind: "operator" },
						claimedRunId: null,
						claimedPhase: null,
						chainName: null,
						presetName: null,
						outcome: "deny",
						reason: resolved.error.kind,
					})
					throw this.resolveCallerDenyError(resolved.error)
				}
				const caller = resolved.value
				if (caller.kind === "operator") {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: caller.subject,
						claimedRunId: null,
						claimedPhase: null,
						chainName: null,
						presetName: null,
						outcome: "allow",
						reason: "operator",
					})
					return
				}
				// Agent path: rejected. The error message names no preset grammar — there is no
				// preset key an author could declare to flip the verdict (acceptance #1).
				await this.recordPrivilegedOpAuditEvent({
					op: auditOp,
					subject: caller.subject,
					claimedRunId: caller.runId,
					claimedPhase: caller.phase,
					chainName: null,
					presetName: null,
					outcome: "deny",
					reason: "hard-deny-for-agent",
				})
				throw new DaemonError(
					"invalid_caller",
					`op "${op}" requires operator credentials and exposes no authorization grammar to presets`,
					{ op, phase: caller.phase },
				)
			}
			case "per-phase-authorized": {
				const auditOp = narrowPrivilegedOpAuditOp(op)
				if (auditOp === null) {
					throw new DaemonError("internal_error", `privileged-op audit vocabulary missing for per-phase op "${op}"`, { op })
				}
				const resolved = this.resolveItemMutationCaller(args)
				if (resolved.kind === "err") {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: { kind: "operator" },
						claimedRunId: null,
						claimedPhase: null,
						chainName: null,
						presetName: null,
						outcome: "deny",
						reason: resolved.error.kind,
					})
					throw this.resolveCallerDenyError(resolved.error)
				}
				const caller = resolved.value
				if (caller.kind === "operator") {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: caller.subject,
						claimedRunId: null,
						claimedPhase: null,
						chainName: null,
						presetName: null,
						outcome: "allow",
						reason: "operator",
					})
					return
				}
				// Agent path: resolve the operating chain → item → preset to find the
				// caller-phase's `[phases.rights] privilegedOps` grant. Today only `item.reorder`
				// is per-phase-authorized, and the request always carries an item selector
				// (`itemId` — opaque preset-declared string id since #419; numeric rowid is also
				// accepted via the same `itemId` field), so the item-resolve succeeds in the
				// happy path. #409 retry: wrap the resolution chain so any throw (missing item,
				// missing chain, preset load failure) emits a `privileged_op.caller_admission`
				// deny event BEFORE re-throwing — mirrors the hard-deny branch shape at lines
				// 961-1005. The contract is "every gated allow/deny emits one event"; without
				// this wrap an adversarial/stale request that hits a pre-grant resolve error
				// would deny without leaving an audit trace.
				let item: ItemRecord
				let chain: ChainRecord
				let preset: SchedulerLoadedPreset["preset"]
				try {
					item = this.resolveItem(args)
					const store = this.requireStore()
					const chainOrNull = store.getChain(item.chainId)
					if (chainOrNull === null) {
						throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
					}
					chain = chainOrNull
					preset = (await this.loadedPresetForItem(chain, item, `${op}.privileged-ops`)).preset
				} catch (resolveError) {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: caller.subject,
						claimedRunId: caller.runId,
						claimedPhase: caller.phase,
						chainName: null,
						presetName: null,
						outcome: "deny",
						// `inactive-run`: the resolution chain (item → chain → preset) failed,
						// so the agent's claimed run is no longer backed by a live, loadable
						// state. The `PrivilegedOpAuditReasonBoundary` already includes this
						// unit; the review's required-changes block explicitly allows reusing
						// it for this edge instead of extending the boundary union.
						reason: "inactive-run",
					})
					throw resolveError
				}
				const presetPhase = preset.phases.find((entry) => entry.name === caller.phase)
				const presetName = preset.name
				// Narrow the engine's audit-vocabulary `PrivilegedOpAuditOp` (8 ops total) down
				// to the preset's grantable subset `PresetPhasePrivilegedOp` (today: only
				// `item.reorder`). A hard-deny op accidentally routed through this branch (the
				// dispatch-table classification mis-set) would yield `null` and short-circuit to
				// deny without consulting the preset — defensive in case a future refactor flips
				// a class without extending `PRESET_PHASE_PRIVILEGED_OPS`.
				const privilegedOp = narrowPresetPhasePrivilegedOpFromAudit(auditOp)
				const grant = privilegedOp !== null
					&& (presetPhase?.rights.privilegedOps.has(privilegedOp) ?? false)
				if (!grant) {
					await this.recordPrivilegedOpAuditEvent({
						op: auditOp,
						subject: caller.subject,
						claimedRunId: caller.runId,
						claimedPhase: caller.phase,
						chainName: chain.name,
						presetName,
						outcome: "deny",
						reason: presetPhase === undefined
							? "no-rights-segment"
							: this.classifyNoPrivilegedOpsGrant(presetPhase.rights),
					})
					throw new DaemonError(
						"invalid_caller",
						`${op}: phase "${caller.phase}" has no ${op} grant on preset "${presetName}"`,
						{ op, phase: caller.phase, presetName },
					)
				}
				await this.recordPrivilegedOpAuditEvent({
					op: auditOp,
					subject: caller.subject,
					claimedRunId: caller.runId,
					claimedPhase: caller.phase,
					chainName: chain.name,
					presetName,
					outcome: "allow",
					reason: "agent-allowed",
				})
				return
			}
			default:
				return assertNeverDaemonCommandAuthClass(authClass)
		}
	}

	// #409 mirror of #407's `classifyNoCreateGrantReason`: distinguish "phase has no rights
	// segment at all" from "phase declared rights but did not include this privileged op".
	// Both deny — distinct reasons surface that difference in audit queries.
	private classifyNoPrivilegedOpsGrant(
		rights: PresetPhaseRights,
	): "no-privileged-ops-grant" | "no-rights-segment" {
		if (!rights.createItems && rights.writableFields.size === 0 && rights.privilegedOps.size === 0) {
			return "no-rights-segment"
		}
		return "no-privileged-ops-grant"
	}

	private async recordPrivilegedOpAuditEvent(input: {
		op: PrivilegedOpAuditOp
		subject: ObservabilitySubject
		claimedRunId: string | null
		claimedPhase: string | null
		chainName: string | null
		presetName: string | null
		outcome: "allow" | "deny"
		reason: PrivilegedOpAuditReason
	}): Promise<void> {
		const event = makeObservabilityEvent({
			kind: "audit",
			type: "privileged_op.caller_admission",
			...(input.chainName === null ? {} : { chain: input.chainName }),
			...(input.subject.kind === "agent"
				? { runId: input.subject.runId, phase: input.subject.phase }
				: {}),
			subject: input.subject,
			payload: {
				op: input.op,
				claimedRunId: input.claimedRunId,
				claimedPhase: input.claimedPhase,
				presetName: input.presetName,
				outcome: input.outcome,
				reason: input.reason,
			},
		})
		await this.recordObservabilityEvent(event)
	}

	private async handleChainCreate(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "chain.create args", CHAIN_CREATE_ARG_KEYS)
		// Since #412, chain.preset is a legacy default-seed: it no longer drives any item's preset
		// (item.add now requires per-item preset) but it still seeds chain-wide vocabulary queries
		// for code paths that operate on a chain without an item in hand (chain status, complete
		// trigger eval, recovery). To preserve install / supervisor flows, retain the
		// `gh-issue-pr-iteration` default; callers that explicitly want a presetless chain pass
		// `preset: null`. Physical column retirement is tracked in #419.
		const rawPresetArg = args.preset
		const rawChainPreset = rawPresetArg === undefined
			? DEFAULT_PRESET_NAME
			: optionalStringOrNull(args, "preset")
		const chainPreset = rawChainPreset === null || rawChainPreset === undefined
			? null
			: await validateBundledPresetForRequest(rawChainPreset)
		const input: CreateChainInput = {
			name: validateChainNameForRequest(requiredString(args, "name")),
			preset: chainPreset,
			repository: validateRepositoryForRequest(requiredString(args, "repository")),
			baseBranch: validateBaseBranchForRequest(optionalString(args, "baseBranch") ?? "main"),
			status: "active",
			metadata: validateChainMetadata(sizedJsonObject(args, "metadata", MAX_CHAIN_METADATA_BYTES) ?? {}),
		}
		// #457: umbrella-shaped values now live inside metadata.bindings (declared-field path).
		// Preset's own arktype boundary for the bindings shape rejects malformed entries; the
		// daemon retired the first-class umbrella validator and no longer surfaces those as
		// chain-create request fields.
		const store = this.requireStore()
		const existing = store.getChainByName(input.name)
		const force = optionalBoolean(args, "force") ?? false
		let chain: ChainRecord
		if (existing === null) {
			chain = store.createChain(input)
		} else {
			if (existing.status === "deleted") {
				if (!force) {
					throw new DaemonError("chain_deleted", `chain ${input.name} is deleted; pass force=true to recreate it`, {
						chainId: existing.id,
						chainName: existing.name,
						status: existing.status,
					})
				}
				store.deleteChain(existing.id)
				chain = store.createChain(input)
			} else {
				const conflicts = chainCreateConflicts(existing, input)
				if (conflicts.length > 0) {
					throw new DaemonError("conflict", `chain ${input.name} already exists with different fields`, {
						chainName: input.name,
						conflicts,
					})
				}
				chain = existing
			}
		}
		await this.ensureChainRuntimeLayout(chain.name)
		await this.recordObservabilityEvent(makeObservabilityEvent({
			kind: "audit",
			type: "chain.layout",
			chain: chain.name,
			subject: { kind: "engine" },
			payload: { chainId: chain.id, state: this.state },
		}))
		return { chain: chainToJson(chain) }
	}

	private async ensureChainRuntimeLayout(chainName: string): Promise<void> {
		const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: this.paths.root })
		await mkdir(paths.issuesDir, { recursive: true })
		await mkdir(paths.evidenceDir, { recursive: true })
		await mkdir(paths.runsDir, { recursive: true })
		await mkdir(paths.daemonDir, { recursive: true })
		await mkdir(paths.daemonBatchDir(this.daemonBatchTimestamp), { recursive: true })
		await writeFile(paths.daemonLogFile(this.daemonBatchTimestamp), "", { flag: "a" })
		await writeFile(paths.sharedFile, "# Shared durable context\n\n", { flag: "wx" }).catch((error: unknown) => {
			if (isNodeError(error) && error.code === "EEXIST") return
			throw error
		})
	}

	private async ensureRuntimeLayoutForExistingChains(): Promise<void> {
		for (const chain of this.requireStore().listChains()) {
			if (chain.status === "deleted") continue
			try {
				await this.ensureChainRuntimeLayout(chain.name)
			} catch (error) {
				if (isInvalidChainNameError(error)) {
					this.warnSkippedInvalidChain(chain, error, "startup runtime layout")
					continue
				}
				throw error
			}
		}
	}

	private async quarantineOrphanChainDirectories(): Promise<void> {
		const knownNames = new Set(this.requireStore().listChains().filter((chain) => chain.status !== "deleted").map((chain) => chain.name))
		const orphanRoot = resolve(this.paths.chainsDir, `${ORPHAN_CHAIN_DIR_PREFIX}${this.daemonBatchTimestamp}`)
		let orphanRootCreated = false
		const entries = await readdir(this.paths.chainsDir, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (entry.name.startsWith(ORPHAN_CHAIN_DIR_PREFIX)) continue
			if (knownNames.has(entry.name)) continue
			const source = resolve(this.paths.chainsDir, entry.name)
			const destination = resolve(orphanRoot, entry.name)
			try {
				if (!orphanRootCreated) {
					await mkdir(orphanRoot, { recursive: true })
					orphanRootCreated = true
				}
				await rename(source, destination)
				console.warn(`coder-loop daemon warning: moved orphan chain directory ${entry.name} to ${destination}`)
			} catch (error) {
				console.warn(`coder-loop daemon warning: unable to move orphan chain directory ${entry.name}: ${errorMessage(error)}`)
			}
		}
	}

	private async recordObservabilityEvent(event: ObservabilityEvent): Promise<void> {
		if (this.shouldSuppressDecisionEvent(event)) return
		await appendObservabilityEvent(this.paths.eventsFile, event)
		this.writeRenderedObservabilityEvent(event)
	}

	/**
	 * Synchronously record a fatal/uncaught error to the unified event stream before the
	 * process exits. An async appendFile would not flush from inside an
	 * uncaughtException / unhandledRejection handler that ends with process.exit, so
	 * this deliberately uses sync fs to guarantee the stack reaches durable storage.
	 */
	recordFatalSync(kind: string, error: unknown): void {
		const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
		const event = makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.fatal",
			subject: { kind: "engine" },
			payload: { fatalKind: kind, pid: process.pid, error: stack },
		})
		try {
			appendObservabilityEventSync(this.paths.eventsFile, event)
			this.writeRenderedObservabilityEvent(event)
		} catch {
			// Last resort: if durable logging itself fails, still surface the stack to
			// stderr so a launcher capturing stderr keeps it.
			try {
				process.stderr.write(`${renderObservabilityEvent(event)}\n`)
			} catch {
				// nothing else we can do while crashing
			}
		}
	}

	private async recordObservabilityEventForChainId(chainId: number, build: (chain: ChainRecord) => ObservabilityEvent): Promise<void> {
		const chain = this.requireStore().getChain(chainId)
		if (chain === null) return
		await this.recordObservabilityEventIfChainNameIsValid(chain, build(chain))
	}

	private async recordObservabilityEventIfChainNameIsValid(chain: ChainRecord, event: ObservabilityEvent): Promise<void> {
		if (chain.status === "deleted") return
		try {
			sanitizeChainName(chain.name)
			await this.recordObservabilityEvent(event)
		} catch (error) {
			if (isInvalidChainNameError(error)) return
			throw error
		}
	}

	private shouldSuppressDecisionEvent(event: ObservabilityEvent): boolean {
		if (event.kind !== "decision") return false
		const key = observabilityDecisionKey(event)
		const fingerprint = observabilityDecisionFingerprint(event)
		const previous = this.lastDecisionFingerprints.get(key)
		if (previous === fingerprint) return true
		this.lastDecisionFingerprints.set(key, fingerprint)
		return false
	}

	private writeRenderedObservabilityEvent(event: ObservabilityEvent): void {
		try {
			process.stderr.write(`${renderObservabilityEvent(event)}\n`)
		} catch {
			// stderr is the final derived human-readable sink.
		}
	}

	private async recoverStaleSchedulerState(): Promise<void> {
		const store = this.requireStore()
		for (const chain of store.listChains()) {
			if (chain.status === "deleted") continue
			const currentRun = store.getCurrentRun(chain.id)
			if (currentRun !== null) {
				const stalePid = await this.readRunProcessGroupPid(chain, currentRun.runId, currentRun.extra)
				if (stalePid !== null) await terminateStaleProcessGroup(stalePid, Math.min(this.shutdownGraceMs, STALE_RECOVERY_FORCE_AFTER_MS))

				const midFlightItemId = optionalPositiveInteger(currentRun.extra.itemId)
				const midFlightItem = midFlightItemId !== null ? store.getItem(midFlightItemId) : null
				const itemsToRecover = midFlightItem === null ? [] : [midFlightItem]

				store.clearCurrentRun(chain.id)
				const recoveredAt = unixSeconds()
				const recoveryStatus = await this.entryItemStatusForRecovery(chain)
				for (const item of itemsToRecover) {
					store.updateItem(item.id, { status: recoveryStatus, phase: null, updatedAt: recoveredAt })
				}
				await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
					kind: "lifecycle",
					type: "scheduler.recovery",
					chain: chain.name,
					runId: currentRun.runId,
					subject: { kind: "engine" },
					payload: {
						reason: "stale_current_run",
						pid: stalePid,
						recoveredItems: itemsToRecover.map((item) => ({
							rowId: item.id,
							itemId: item.itemId,
							fromStatus: item.status,
							toStatus: recoveryStatus,
						})),
						reconciledRuns: [],
					},
				}))
				for (const item of itemsToRecover) {
					await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
						kind: "audit",
						type: "item.status",
						chain: chain.name,
						item: item.id,
						runId: currentRun.runId,
						subject: { kind: "engine" },
						payload: {
							rowId: item.id,
							itemId: item.itemId,
							fromStatus: item.status,
							toStatus: recoveryStatus,
							reason: "stale_current_run_recovery",
						},
					}))
				}
			}

			await this.reconcileOrphanedRuns(chain)
		}
	}

	private async reconcileOrphanedRuns(chain: ChainRecord): Promise<void> {
		const store = this.requireStore()
		const orphanedRuns = store.listRuns(chain.id).filter((run) => run.endedAt === null)
		if (orphanedRuns.length === 0) return

		const reconciledAt = unixSeconds()
		const reconciledRuns: { runId: string; itemId: number; phase: string; pid: number | null }[] = []
		for (const run of orphanedRuns) {
			const stalePid = await this.readRunProcessGroupPid(chain, run.runId, run.extra)
			if (stalePid !== null) await terminateStaleProcessGroup(stalePid, Math.min(this.shutdownGraceMs, STALE_RECOVERY_FORCE_AFTER_MS))
			store.completeRun(run.runId, {
				endedAt: reconciledAt,
				exitCode: ORPHANED_RUN_EXIT_CODE,
				status: ORPHANED_RUN_STATUS,
				extra: storedItemExtra({ ...itemExtraToJsonObject(run.extra), reconciledBy: "daemon_startup", reconciledAt }),
			})
			reconciledRuns.push({ runId: run.runId, itemId: run.itemId, phase: run.phase, pid: stalePid })
		}

		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "lifecycle",
			type: "scheduler.recovery",
			chain: chain.name,
			subject: { kind: "engine" },
			payload: {
				reason: "orphaned_run_reconciled",
				pid: null,
				recoveredItems: [],
				reconciledRuns,
			},
		}))
	}

	private async readRunProcessGroupPid(chain: ChainRecord, runId: string, extra: ItemExtra): Promise<number | null> {
		const extraPid = extra.pid ?? null
		if (extraPid !== null && extra.processGroupLeader === true) return extraPid
		try {
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: this.paths.root })
			const raw = await readFile(paths.runStatusFile(runId), "utf-8")
			const parsed = parseJsonRecord(raw)
			const statusPid = optionalPositiveInteger(parsed.pid)
			return statusPid !== null && parsed.processGroupLeader === true ? statusPid : null
		} catch {
			return null
		}
	}

	private handleChainList(): JsonObject {
		return { chains: this.requireStore().listChains().map(chainToJson) }
	}

	private async handleChainStatus(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		const items = this.requireStore().listItems(chain.id)
		const activeRuns = listActiveRuns(this.schedulerState).filter((run) => run.chainId === chain.id)
		// #412: when chain.preset is null (post-#412 chain) but items are present, resolve status
		// vocabulary from the representative item's preset. When the chain has no resolvable preset
		// at all (post-#412 chain with no items declaring preset and no legacy chain.preset seed),
		// status reports as no waits — that's the genuine "nothing to schedule" state, not an error
		// to mask. Real load failures (broken preset dir, malformed preset.toml) still propagate.
		const presetForStatus = this.canResolvePresetForChainOrItems(chain, items)
			? await this.loadedPresetForChainOrItems(chain, items, "chain.status")
			: null
		const pendingStatusSet = presetForStatus === null
			? new Set<InternalStatus>()
			: new Set(presetForStatus.preset.statuses.continuable)
		const terminalStatusSet = presetForStatus === null
			? new Set<InternalStatus>()
			: new Set(presetForStatus.preset.statuses.terminal)
		const continuableStatusNames = [...pendingStatusSet]
		const terminalStatusNames = [...terminalStatusSet]
		const dependencyWaits = listDependencyWaitReasons(items, { statuses: continuableStatusNames, terminalStatusNames })
		// #419: key by `rowId` (items.id integer). `wait.itemId` is now the opaque preset id
		// string, which is unique per chain but not what items.id collates against.
		const dependencyWaitsByRowId = new Map(dependencyWaits.map((wait) => [wait.rowId, wait]))
		return {
			chain: chainToJson(chain),
			summary: chainStatusSummary(chain, items, activeRuns, dependencyWaits),
			items: items.map((item) => itemToJson(item, dependencyWaitsByRowId.get(item.id) ?? null)),
			activeRuns: activeRuns.map(activeRunToJson),
		}
	}

	// #412 helper: resolve a SchedulerLoadedPreset for chain status / vocabulary queries. Prefers the
	// representative item's preset (so post-#412 chains with chain.preset=null still work as long as
	// items declare their own preset) and falls back to the chain's legacy default seed.
	private async loadedPresetForChainOrItems(chain: ChainRecord, items: readonly ItemRecord[], operation: string): Promise<SchedulerLoadedPreset> {
		const representative = items.find((item) => item.preset !== null || item.presetPath !== null)
		if (representative !== undefined) return await this.loadedPresetForItem(chain, representative, operation)
		return await this.loadedPresetForChain(chain, operation)
	}

	// #412: predicate paired with `loadedPresetForChainOrItems` — answers "is there any preset
	// source to attempt loading?" without catching load errors. Used by paths that must distinguish
	// "no preset configured" (legitimately empty status) from "preset configured but broken" (real
	// error, must propagate).
	private canResolvePresetForChainOrItems(chain: ChainRecord, items: readonly ItemRecord[]): boolean {
		const representative = items.find((item) => item.preset !== null || item.presetPath !== null)
		if (representative !== undefined) return true
		if (chainPresetPath(chain.metadata) !== null) return true
		return chain.preset !== null
	}

	private async handleChainDelete(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		if (chain.status === "deleted") return { chain: chainToJson(chain), alreadyDeleted: true }
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const terminatedRuns = await this.terminateActiveRunsForChain(chain.id)
			const cleanup = await this.cleanupChainRuntime(chain)
			const updated = this.requireStore().updateChain(chain.id, { status: "deleted" })
			return {
				chain: chainToJson(updated),
				alreadyDeleted: false,
				terminatedRuns: terminatedRuns.map(completedRunToJson),
				cleanup,
			}
		} finally {
			resumeScheduler()
		}
	}

	private async handleChainStop(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		if (chain.status === "stopped") return { chain: chainToJson(chain), alreadyStopped: true, terminatedRuns: [] }
		assertChainCanTransition(chain, "chain.stop", "active", "stopped")
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const stopped = this.requireStore().updateChain(chain.id, { status: "stopped" })
			const terminatedRuns = await this.terminateActiveRunsForChain(chain.id)
			await this.recordObservabilityEventIfChainNameIsValid(stopped, makeObservabilityEvent({
				kind: "audit",
				type: "chain.status",
				chain: stopped.name,
				subject: { kind: "operator" },
				payload: {
					chainId: stopped.id,
					fromStatus: chain.status,
					toStatus: stopped.status,
					terminatedRunIds: terminatedRuns.map((run) => run.runId),
				},
			}))
			return {
				chain: chainToJson(stopped),
				alreadyStopped: false,
				terminatedRuns: terminatedRuns.map(completedRunToJson),
			}
		} finally {
			resumeScheduler()
		}
	}

	private async handleChainResume(args: JsonObject): Promise<JsonObject> {
		const chain = this.resolveChain(args)
		if (chain.status === "active") return { chain: chainToJson(chain), alreadyActive: true }
		assertChainCanTransition(chain, "chain.resume", "stopped", "active")
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const resumed = this.requireStore().updateChain(chain.id, { status: "active" })
			await this.recordObservabilityEventIfChainNameIsValid(resumed, makeObservabilityEvent({
				kind: "audit",
				type: "chain.status",
				chain: resumed.name,
				subject: { kind: "operator" },
				payload: {
					chainId: resumed.id,
					fromStatus: chain.status,
					toStatus: resumed.status,
					terminatedRunIds: [],
				},
			}))
			return { chain: chainToJson(resumed), alreadyActive: false }
		} finally {
			resumeScheduler()
		}
	}

	// #409 logs query, daemonized. Previously executed inline in the CLI process
	// (`runLogsCommand` in loop.ts) — read the event-stream file directly with no
	// authorization seam. Moving it behind the daemon socket places it on the
	// hard-deny gate: an agent process that imports the codebase or runs the CLI
	// cannot read the cross-run / cross-chain observability stream. The gate at
	// `runAuthorizationGate` already fired by the time control reaches here.
	private async handleLogsQuery(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "logs.query args", LOGS_QUERY_ARG_KEYS)
		const query: ObservabilityEventQuery = {}
		const kind = optionalString(args, "kind")
		if (kind !== null) {
			try {
				query.kind = parseObservabilityKind(kind)
			} catch (error) {
				throw new DaemonError("invalid_request", `logs.query: kind: ${errorMessage(error)}`, { kind })
			}
		}
		const type = optionalString(args, "type")
		if (type !== null) {
			try {
				query.type = parseObservabilityEventType(type)
			} catch (error) {
				throw new DaemonError("invalid_request", `logs.query: type: ${errorMessage(error)}`, { type })
			}
		}
		const chain = optionalString(args, "chain")
		if (chain !== null) query.chain = chain
		const item = optionalInteger(args, "item")
		if (item !== null) query.item = item
		const run = optionalString(args, "run")
		if (run !== null) query.run = run
		const phase = optionalString(args, "phase")
		if (phase !== null) query.phase = phase
		const since = optionalString(args, "since")
		if (since !== null) {
			if (Number.isNaN(Date.parse(since))) {
				throw new DaemonError("invalid_request", "logs.query: since must be an ISO timestamp or Date.parse-compatible string", { since })
			}
			query.since = since
		}
		const result = await queryObservabilityEvents(this.paths.eventsFile, query)
		// `events` is `ObservabilityEvent[]` (typed sum union built from arktype atoms — every
		// field is already JsonValue-compatible). Route each entry through the structural
		// JSON.stringify+parse helper in observability.ts, then run it past `isJsonValue` so the
		// wire reply only carries values the boundary type system can speak. An entry that fails
		// the guard is dropped with a daemon-warning event rather than crashing the whole query.
		const events: JsonValue[] = []
		for (const event of result.events) {
			const candidate: unknown = observabilityEventToJsonValue(event)
			if (isJsonValue(candidate)) {
				events.push(candidate)
			}
		}
		return { path: result.path, events }
	}

	// #409 queue.unblock, daemonized. Previously executed SQLite mutations in the
	// CLI process (`runQueueUnblockCommand` + `restoreUnblockableItemRecord` in
	// loop.ts) — the operator wrote the store directly with no architectural seam.
	// Moving the mutation behind the daemon socket places it on the hard-deny
	// gate so an agent's `coder-loop queue unblock` call is rejected before any
	// store change. The `item.mutation.caller_admission` operator-allow event the
	// old CLI hand-emitted is now emitted alongside the per-#409 privileged-op
	// admission so external audit tooling still sees the operator's blocker-clear
	// attributed to the same item id.
	private async handleQueueUnblock(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "queue.unblock args", QUEUE_UNBLOCK_ARG_KEYS)
		const chain = this.resolveChain(args)
		const issueRaw = requiredString(args, "issue")
		const issue = issueRaw.trim()
		if (issue === "") throw new DaemonError("invalid_request", "queue.unblock: issue must not be empty")
		if (/\s/.test(issue)) throw new DaemonError("invalid_request", "queue.unblock: issue must not contain whitespace", { issue: issueRaw })
		// #419: opaque item id (string). Historical `#123` shorthand still maps to the literal id
		// without the `#` prefix so operators don't have to think about whether their preset uses
		// numeric ids; the preset-declared idField decides what's valid downstream.
		const itemId = issue.startsWith("#") ? issue.slice(1) : issue
		if (itemId === "") throw new DaemonError("invalid_request", `queue.unblock: issue must contain an id after #`, { issue: issueRaw })
		const dryRun = optionalBoolean(args, "dryRun") ?? false
		const { preset } = await this.loadedPresetForChain(chain, "queue.unblock")
		const store = this.requireStore()
		const item = store.getItemById(chain.id, itemId)
		if (item === null) {
			throw new DaemonError("not_found", `queue.unblock: item ${issue} not found in chain ${chain.name}`, { chainName: chain.name, itemId })
		}
		if (!preset.statuses.unblockable.includes(item.status)) {
			return {
				mutation: {
					changed: false,
					issue,
					reason: "not_unblockable",
					status: item.status,
				},
			}
		}
		const entryStatus = preset.statuses.entry
		const current = store.getCurrentRun(chain.id)
		// CurrentRunRecord stores the active item identifier inside `extra.itemId` (the same shape
		// the scheduler writes when it spawns); resolve it as JsonValue and only match when it's
		// the numeric rowid the store inserted.
		const currentExtraItemId = current === null ? null : current.extra.itemId
		const clearedCurrent = typeof currentExtraItemId === "number"
			&& Number.isInteger(currentExtraItemId)
			&& currentExtraItemId === item.id
		if (!dryRun) {
			store.updateItem(item.id, {
				// #397: queue.unblock is operator-issued — restore the item to the preset's entry
				// status. The value comes from preset.statuses.entry (engine-derived), so we brand
				// through the narrow engine-lifecycle constructor.
				status: engineLifecycleAdmittedItemStatus(entryStatus, "queue.unblock-entry-restore"),
				updatedAt: unixSeconds(),
			})
			if (clearedCurrent) store.clearCurrentRun(chain.id)
			// Mirror the #406 operator-attribution audit shape the old CLI emitted so external
			// tooling that watches `item.mutation.caller_admission` keeps seeing the unblock.
			await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
				kind: "audit",
				type: "item.mutation.caller_admission",
				chain: chain.name,
				item: item.id,
				subject: { kind: "operator" },
				payload: {
					rowId: item.id,
					itemId,
					claimedRunId: null,
					claimedPhase: null,
					outcome: "allow",
					reason: "operator",
				},
			}))
		}
		return {
			mutation: {
				changed: true,
				issue,
				beforeStatus: item.status,
				afterStatus: entryStatus,
				clearedCurrent,
			},
		}
	}

	private async terminateActiveRunsForChain(chainId: number): Promise<SchedulerCompletedRun[]> {
		const activeRuns = listActiveRuns(this.schedulerState).filter((run) => run.chainId === chainId)
		return await Promise.all(activeRuns.map((run) => run.terminate({ forceAfterMs: this.shutdownGraceMs })))
	}

	// Daemon shutdown must not outlive its agents (#467): waiting for natural completion
	// blocks `daemon down` for the agent's whole runtime, and escalating to SIGTERM then
	// exits the daemon while detached agents keep running as orphans. Terminate with the
	// same bounded grace chain.stop/chain.delete already use. A terminate failure must
	// not wedge shutdown: log and continue.
	private async terminateAllActiveRuns(): Promise<SchedulerCompletedRun[]> {
		const activeRuns = listActiveRuns(this.schedulerState)
		const settled = await Promise.all(activeRuns.map(async (run) => {
			try {
				return await run.terminate({ forceAfterMs: this.shutdownGraceMs })
			} catch (error) {
				process.stderr.write(`coder-loop daemon: terminate run ${run.runId} (pid ${String(run.pid ?? "?")}) failed: ${errorMessage(error)}\n`)
				return null
			}
		}))
		return settled.filter((run): run is SchedulerCompletedRun => run !== null)
	}

	private async cleanupChainRuntime(chain: ChainRecord): Promise<JsonObject> {
		const store = this.requireStore()
		const repoCwds = store.listItems(chain.id).map((item) => item.repoCwd)
		const worktrees = cleanupSchedulerChainWorktrees(chain, repoCwds, { loopDataRoot: this.paths.root })
		try {
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: this.paths.root })
			await rm(paths.chainRoot, { recursive: true, force: true })
			return { chainRoot: paths.chainRoot, chainRootRemoved: true, worktrees: schedulerWorktreeCleanupsToJson(worktrees) }
		} catch (error) {
			if (isInvalidChainNameError(error)) {
				return {
					chainRoot: null,
					chainRootRemoved: false,
					worktrees: schedulerWorktreeCleanupsToJson(worktrees),
					error: errorMessage(error),
				}
			}
			throw error
		}
	}

	private async handleItemAdd(args: JsonObject): Promise<JsonObject> {
		validateItemAddRequest(args)
		const chain = this.resolveChain(args)
		assertChainAllowsItemMutation(chain, "item.add")
		// #407 caller + rights gate runs BEFORE buildCreateItemInput so a no-create-grant agent is
		// rejected before any further field validation work happens (cheap-fail). The per-item
		// preset spec is parsed first because the rights live on the new item's preset, not the
		// chain's preset. #412 invariants (preset required per item) stay intact — the same
		// `requireItemPresetForRequest` call still runs inside buildCreateItemInput; we just look
		// up the spec twice (once here to enforce rights, once inside buildCreateItemInput to
		// build the CreateItemInput). The duplicate parse is the simplest code-self-consistent
		// shape and the spec parse is cheap (no preset.toml load).
		const presetSpec = await this.requireItemPresetForRequest(args, "item.add")
		// #407 review-feedback refactor: resolver returns typed `Result`. Invalid-credential cases
		// throw the equivalent DaemonError without emitting an audit event — preserves pre-refactor
		// behavior on the add path (the previous code threw from inside the resolver and the
		// caller never wrapped it in a `recordCallerAdmissionEvent` because the add path's audit
		// schema is `item.add.rights_admission`, which is emitted later by the rights gate).
		const resolvedCaller = this.resolveItemMutationCaller(args)
		if (resolvedCaller.kind === "err") throw this.resolveCallerDenyError(resolvedCaller.error)
		const caller = resolvedCaller.value
		await this.assertItemAddRightsForCaller(chain, caller, presetSpec, "item.add")
		const store = this.requireStore()
		const existingItems = store.listItems(chain.id)
		const input = await this.buildCreateItemInput(chain, args, existingItems, "item.add")
		const existing = store.getItemById(chain.id, input.itemId)
		if (existing !== null) throw duplicateItemAddError(chain, input.itemId, existing)
		let item: ItemRecord
		try {
			item = store.createItem(input)
		} catch (error) {
			throw this.translateCreateItemFailure(chain, input.itemId, error)
		}
		// #407: emit `item.created` with the caller's true subject (operator | agent+run). The
		// previous hard-coded `{ kind: "operator" }` lied about who created the item the moment
		// agent paths became reachable; the exhaustive switch on caller.kind here is how
		// runId/phase enter the event base for the agent path.
		const createdCallerExtras = caller.kind === "agent"
			? { runId: caller.runId, phase: caller.phase }
			: {}
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.created",
			chain: chain.name,
			item: item.id,
			...createdCallerExtras,
			subject: caller.subject,
			payload: { rowId: item.id, itemId: item.itemId, status: item.status },
		}))
		this.queueSchedulerTick()
		return { item: itemToJson(item) }
	}

	private async handleItemBatchAdd(args: JsonObject): Promise<JsonObject> {
		validateItemBatchAddRequest(args)
		const chain = this.resolveChain(args)
		assertChainAllowsItemMutation(chain, "item.batchAdd")
		const store = this.requireStore()
		const rawItems = requiredJsonObjectArray(args, "items")
		if (rawItems.length === 0) throw new DaemonError("invalid_request", "item.batchAdd requires at least one item", { field: "items" })
		// #407 caller is batch-level — one credential per request validated once before per-item
		// work begins. Each child item still carries its own preset declaration so the rights
		// check is run per-item (a batch may legitimately mix presets); a single deny aborts the
		// entire batch (整批拒/整批放行).
		//
		// #407 review-feedback refactor: identical Result-unwrap shape as handleItemAdd above —
		// invalid credential throws the equivalent DaemonError without audit emission, preserving
		// pre-refactor wire behavior.
		const resolvedCaller = this.resolveItemMutationCaller(args)
		if (resolvedCaller.kind === "err") throw this.resolveCallerDenyError(resolvedCaller.error)
		const caller = resolvedCaller.value
		const existingItems = store.listItems(chain.id)
		const inputs: CreateItemInput[] = []
		const requestedIds = new Set<string>()
		for (const [index, rawItem] of rawItems.entries()) {
			validateKnownKeys(rawItem, `item.batchAdd items[${index}]`, ITEM_BATCH_ADD_ITEM_KEYS)
			const presetSpec = await this.requireItemPresetForRequest(rawItem, `items[${index}]`)
			await this.assertItemAddRightsForCaller(chain, caller, presetSpec, `items[${index}]`)
			const input = await this.buildCreateItemInput(chain, rawItem, existingItems, `items[${index}]`)
			if (requestedIds.has(input.itemId)) {
				throw new DaemonError("conflict", `batch contains duplicate itemId ${input.itemId}`, { chainId: chain.id, chainName: chain.name, itemId: input.itemId })
			}
			requestedIds.add(input.itemId)
			const existing = store.getItemById(chain.id, input.itemId)
			if (existing !== null) throw duplicateItemAddError(chain, input.itemId, existing)
			inputs.push(input)
		}
		let items: ItemRecord[]
		try {
			items = store.createItems(inputs)
		} catch (error) {
			const firstDuplicate = inputs.map((input) => [input.itemId, store.getItemById(chain.id, input.itemId)] as const).find(([, existing]) => existing !== null)
			if (firstDuplicate !== undefined && firstDuplicate[1] !== null) throw duplicateItemAddError(chain, firstDuplicate[0], firstDuplicate[1])
			throw error
		}
		// #407: emit `item.created` with the caller's true subject for each created child.
		const createdCallerExtras = caller.kind === "agent"
			? { runId: caller.runId, phase: caller.phase }
			: {}
		for (const item of items) {
			await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
				kind: "audit",
				type: "item.created",
				chain: chain.name,
				item: item.id,
				...createdCallerExtras,
				subject: caller.subject,
				payload: { rowId: item.id, itemId: item.itemId, status: item.status },
			}))
		}
		this.queueSchedulerTick()
		return { items: items.map((item) => itemToJson(item)) }
	}

	private async buildCreateItemInput(chain: ChainRecord, args: JsonObject, existingItems: readonly ItemRecord[], label: string): Promise<CreateItemInput> {
		const rawExtra = sizedJsonObject(args, "extra", MAX_ITEM_EXTRA_BYTES) ?? {}
		const topLevelDependsOn = optionalDependsOn(args, "dependsOn")
		const extraDependsOn = topLevelDependsOn === undefined ? optionalDependsOn(rawExtra, "dependsOn") : undefined
		const dependsOn = topLevelDependsOn === undefined ? extraDependsOn : topLevelDependsOn
		if (dependsOn !== undefined) validateDependsOnGraph(existingItems, null, dependsOn)
		// #412: preset must be specified on every new item. The candidate set was killed by the operator:
		// no chain-level default, no engine-builtin default, no inherit-from-chain — only explicit per-item
		// preset survives. Engine-derived items (review-on-empty etc.) bypass this API entirely.
		const presetSpec = await this.requireItemPresetForRequest(args, label)
		// Derive the new item's default status from its OWN preset, not the chain's. This makes it valid
		// to create the first item on a chain whose chains.preset column is null (post-#412 chains).
		// Load failures are surfaced per-chain so the standard `daemon.preset_load_failed` observability
		// event fires and the error message stays consistent with chain-mutation paths.
		const defaultStatus = await this.defaultItemStatusForPresetSpecOnChain(chain, presetSpec)
		// #419: opaque-string item id is the wire-level identity. We back-fill it into `extra` under
		// the preset-declared idField key so the standard binding pipeline (`getItemId` →
		// `itemExtraJsonValue(idField)`) keeps resolving the per-issue `{{<idField>}}` placeholder
		// without engine-side preset literals. `validateItemId` rejects empty / whitespace-bearing
		// values and any extra carrier that already declares a conflicting idField value.
		const itemIdRaw = validateItemId(requiredString(args, "itemId"))
		const presetForIdField = await this.loadedPresetFromSpec(chain, presetSpec, label)
		const idFieldKey = presetForIdField.preset.item.idField
		const extraWithDependsOn = withDependsOn(rawExtra, dependsOn)
		const existingIdInExtra = extraWithDependsOn[idFieldKey]
		if (existingIdInExtra !== undefined) {
			const asString = typeof existingIdInExtra === "string"
				? existingIdInExtra
				: typeof existingIdInExtra === "number" && Number.isFinite(existingIdInExtra)
					? String(existingIdInExtra)
					: null
			if (asString === null || asString !== itemIdRaw) {
				throw new DaemonError(
					"invalid_request",
					`${label}: extra.${idFieldKey} (${JSON.stringify(existingIdInExtra)}) conflicts with itemId (${JSON.stringify(itemIdRaw)})`,
					{ field: `extra.${idFieldKey}` },
				)
			}
		}
		const extraWithIdField: JsonObject = { ...extraWithDependsOn, [idFieldKey]: itemIdRaw }
		const input: CreateItemInput = {
			chainId: chain.id,
			itemId: itemIdRaw,
			repoCwd: await validateRepoCwdForRequest(requiredString(args, "repoCwd")),
			status: defaultStatus,
			preset: presetSpec.preset,
			presetPath: presetSpec.presetPath,
			extra: validateItemExtra(extraWithIdField),
		}
		assignOptional(input, "title", validateItemTitleForRequest(optionalStringOrNull(args, "title")))
		assignOptional(input, "priority", validateItemPriorityForRequest(optionalStringOrNull(args, "priority")))
		// #419: `branch` / `pr` no longer accepted as top-level item.add fields; presets that need
		// them declare them in `[item.fields]` and the caller passes them inside `extra`.
		assignOptional(input, "issueFile", validateRelativeItemPathForRequest(optionalStringOrNull(args, "issueFile"), "issueFile"))
		assignOptional(input, "evidenceDir", validateEvidenceDirForRequest(optionalStringOrNull(args, "evidenceDir"), chain, this.paths.root))
		assignOptional(input, "runner", optionalRunner(args, "runner"))
		return input
	}

	private async requireItemPresetForRequest(args: JsonObject, label: string): Promise<{ preset: string | null; presetPath: string | null }> {
		const presetName = optionalStringOrNull(args, "preset")
		const presetPath = optionalStringOrNull(args, "presetPath")
		if ((presetName === null || presetName === undefined) && (presetPath === null || presetPath === undefined)) {
			throw new DaemonError(
				"invalid_request",
				`${label}: preset is required (pass "preset" with a bundled preset name or "presetPath" with an absolute path; item creators may not silently inherit a chain/config/default preset since #412)`,
				{ field: "preset" },
			)
		}
		if (presetName !== null && presetName !== undefined && presetPath !== null && presetPath !== undefined) {
			throw new DaemonError(
				"invalid_request",
				`${label}: "preset" and "presetPath" are mutually exclusive (got preset="${presetName}", presetPath="${presetPath}")`,
				{ field: "preset" },
			)
		}
		if (presetName !== null && presetName !== undefined) {
			const validated = await validateBundledPresetForRequest(presetName)
			return { preset: validated, presetPath: null }
		}
		if (presetPath !== null && presetPath !== undefined) {
			const validated = await validateItemPresetPathForRequest(presetPath)
			return { preset: null, presetPath: validated }
		}
		// Both null/undefined was handled above; the remaining branches are exhaustive.
		throw new DaemonError("invalid_request", `${label}: preset specification could not be resolved`, { field: "preset" })
	}

	private translateCreateItemFailure(chain: ChainRecord, itemId: string, error: unknown): never {
		try {
			const existingAfterFailure = this.requireStore().getItemById(chain.id, itemId)
			if (existingAfterFailure !== null) throw duplicateItemAddError(chain, itemId, existingAfterFailure)
		} catch (lookupError) {
			if (lookupError instanceof DaemonError) throw lookupError
		}
		throw error
	}

	private handleItemList(args: JsonObject): JsonObject {
		const chain = this.resolveChain(args)
		return { items: this.requireStore().listItems(chain.id).map((item) => itemToJson(item)) }
	}

	private async handleItemUpdate(args: JsonObject): Promise<JsonObject> {
		validateItemUpdateRequest(args)
		const item = this.resolveItem(args)
		const fields = itemUpdateFields(args)
		const store = this.requireStore()
		const chain = store.getChain(item.chainId)
		if (chain === null) throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
		assertChainAllowsItemMutation(chain, "item.update")
		// #406: parse the caller at boundary into the typed ADT. Downstream switches over the
		// ADT, not over loose strings; the operator/agent split — and the runId/phase the agent
		// path carries — both come from the registry-validated credential, not from caller claims.
		const caller = await this.admitItemMutationCaller(chain, item, args)
		// #410: per-phase field-write gate. Runs at request-parse-point AFTER caller admission —
		// the per-field-shape validation below stays untouched. Operator path is always allowed
		// (the rights segment is the agent-grant surface; operators bypass entirely). Agent path
		// loads the item's preset and checks each requested field (including extra-inner keys)
		// against the phase's `writableFields`. Control-plane fields (`runner`/`repoCwd`/
		// `dependsOn`/`priority`) are default-deny with no preset surface — same shape as #409's
		// hard-deny-for-agent class but on the field axis. Throws DaemonError on deny; the
		// throw happens BEFORE any store write or per-field shape validation, so a denied request
		// never produces partial state. The audit event is emitted in both allow and deny paths.
		await this.admitItemUpdateFieldWrites(chain, item, caller, fields)
		const input: UpdateItemInput = {}
		const repoCwd = optionalString(fields, "repoCwd")
		if (repoCwd !== null) assignOptional(input, "repoCwd", await validateRepoCwdForRequest(repoCwd))
		const status = optionalString(fields, "status")
		if (status !== null) {
			assignOptional(input, "status", await this.admitItemStatusForRequest(chain, item, status, caller.subject))
		}
		assignOptional(input, "title", validateItemTitleForRequest(optionalStringOrNull(fields, "title")))
		assignOptional(input, "priority", validateItemPriorityForRequest(optionalStringOrNull(fields, "priority")))
		// #419: `branch` / `pr` no longer accepted as top-level update fields. Presets that declare them
		// in `[item.fields]` (gh-issue-pr-iteration does) accept them via the `extra` / `extraPatch`
		// carriers below; `validateItemExtraInnerKeys` runs the same git-branch / positive-int shape
		// checks the legacy top-level validators ran, so review-phase writes to `extra.branch` /
		// `extra.pr` are validated identically to the pre-#419 top-level write.
		assignOptional(input, "issueFile", validateRelativeItemPathForRequest(optionalStringOrNull(fields, "issueFile"), "issueFile"))
		assignOptional(input, "evidenceDir", validateEvidenceDirForRequest(optionalStringOrNull(fields, "evidenceDir"), chain, this.paths.root))
		assignOptional(input, "runner", optionalRunner(fields, "runner"))
		const rawExtra = sizedJsonObject(fields, "extra", MAX_ITEM_EXTRA_BYTES)
		const rawExtraPatch = sizedJsonObject(fields, "extraPatch", MAX_ITEM_EXTRA_BYTES)
		if (rawExtra !== undefined && rawExtraPatch !== undefined) {
			throw new DaemonError("invalid_request", "item.update fields must not combine extra and extraPatch", {})
		}
		const requestedExtra = rawExtra !== undefined
			? rawExtra
			: rawExtraPatch === undefined
				? undefined
				: { ...itemExtraToJsonObject(item.extra), ...rawExtraPatch }
		// #419: when a write touches the extra-inner `branch` / `pr` keys (typical
		// gh-issue-pr-iteration review-phase write), run the same shape validation the legacy
		// top-level validators ran (git-branch grammar via `validateGitBranchNameForRequest`;
		// positive-int via `validateItemPrForRequest`). The fields are now preset-declared
		// transparent fields; the engine has no business-shape knowledge of them outside this
		// validation block. The block fires off the carrier that actually carries the write
		// (`rawExtra` for replacement, `rawExtraPatch` for patch) — both surface the inner key
		// at the same level after the merge.
		const extraInnerCarrier = rawExtra ?? rawExtraPatch
		if (extraInnerCarrier !== undefined) {
			if (Object.hasOwn(extraInnerCarrier, "branch")) {
				const branchValue = extraInnerCarrier.branch
				if (branchValue !== null && typeof branchValue === "string") {
					validateGitBranchNameForRequest(branchValue, "extra.branch")
				} else if (branchValue !== null) {
					throw new DaemonError("invalid_request", "extra.branch must be a string or null", { field: "extra.branch" })
				}
			}
			if (Object.hasOwn(extraInnerCarrier, "pr")) {
				const prValue = extraInnerCarrier.pr
				if (prValue !== null && typeof prValue === "number") {
					if (!Number.isInteger(prValue) || prValue < 1) {
						throw new DaemonError("invalid_request", "extra.pr must be a positive integer or null", { field: "extra.pr", value: prValue })
					}
				} else if (prValue !== null) {
					throw new DaemonError("invalid_request", "extra.pr must be an integer or null", { field: "extra.pr" })
				}
			}
		}
		const topLevelDependsOn = optionalDependsOn(fields, "dependsOn")
		const extraDependsOn = topLevelDependsOn === undefined && requestedExtra !== undefined ? optionalDependsOn(requestedExtra, "dependsOn") : undefined
		const dependsOn = topLevelDependsOn === undefined ? extraDependsOn : topLevelDependsOn
		if (dependsOn !== undefined) {
			validateDependsOnGraph(store.listItems(item.chainId), item.id, dependsOn)
			input.extra = validateItemExtra(withDependsOn(requestedExtra ?? itemExtraToJsonObject(item.extra), dependsOn))
		} else if (requestedExtra !== undefined) {
			input.extra = validateItemExtra(requestedExtra)
		}
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const updated = store.updateItem(item.id, input)
			if (updated.status !== item.status) {
				// #406: emit `item.status` with the caller's true subject. The exhaustive switch on
				// `caller.kind` is how runId/phase enter the event base — they come from the
				// registry-validated credential binding, not from caller-supplied fields. Adding a
				// new caller variant in the future = a typechecker error here (the assertNever in
				// observability.ts already enforces exhaustiveness on the rendering side).
				const callerExtras = caller.kind === "agent"
					? { runId: caller.runId, phase: caller.phase }
					: {}
				await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
					kind: "audit",
					type: "item.status",
					chain: chain.name,
					item: item.id,
					...callerExtras,
					subject: caller.subject,
					payload: {
						rowId: item.id,
						itemId: item.itemId,
						fromStatus: item.status,
						toStatus: updated.status,
						reason: "item.update",
					},
				}))
				// #452: completion signal switched from stdout marker to state write. An
				// agent-attributed status write that mutated `item.status` (i.e. survived
				// the #397 admission gate above and actually transitioned) is "this run is
				// done" — hand the scheduler the runId so its lifecycle GC can enter the
				// recycle zone. Operator-path writes do not arm recycle (no per-run window
				// is meaningful: there is no in-flight run binding the operator's hand).
				// `markRunPendingRecycle` is idempotent against unknown / already-armed
				// runIds, so a credential pointing at a run that already closed is harmless.
				if (caller.kind === "agent") {
					markRunPendingRecycle(this.schedulerState, caller.runId)
				}
			}
			return { item: itemToJson(updated) }
		} finally {
			resumeScheduler()
		}
	}

	private async handleItemReorder(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "item.reorder args", ITEM_REORDER_ARG_KEYS)
		validateItemUpdateSelector(args)
		const position = requiredInteger(args, "position")
		if (position < 0) throw new DaemonError("invalid_request", "position must be a non-negative integer")
		const item = this.resolveItem(args)
		const store = this.requireStore()
		const chain = store.getChain(item.chainId)
		if (chain === null) throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
		assertChainAllowsItemMutation(chain, "item.reorder")
		// #409: the per-phase-authorized gate at `runAuthorizationGate` already decided allow
		// (operator or review-phase agent with the grant). Re-resolve the caller here so the
		// item.reordered audit subject reflects the actual mutator instead of always reading
		// `operator`. The resolver is pure — it does not throw on the allowed agent path.
		const callerResolved = this.resolveItemMutationCaller(args)
		const subject: ObservabilitySubject = callerResolved.kind === "ok"
			? callerResolved.value.subject
			: { kind: "operator" }
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const reordered = store.reorderItem(item.id, position)
			await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
				kind: "audit",
				type: "item.reordered",
				chain: chain.name,
				item: item.id,
				...(subject.kind === "agent"
					? { runId: subject.runId, phase: subject.phase }
					: {}),
				subject,
				payload: { rowId: item.id, itemId: item.itemId, position },
			}))
			return { items: reordered.map((entry) => itemToJson(entry)) }
		} finally {
			resumeScheduler()
		}
	}

	// #451 typed phase-exits query face. Read-side companion to the #397
	// write-side default-deny gate at `admitItemStatusForPhaseRequest`: returns
	// the typed `[[phases.exits]]` for the agent's currently-running phase so
	// the agent can pick a status from the declared set before issuing the
	// write. Reuses `allowedItemStatusesForPhase` so the read side cannot drift
	// from the write side — both speak the same source-of-truth helper.
	//
	// Unknown phase (`allowed === null`) is rejected as a typed
	// `invalid_request` error rather than collapsed to empty exits: empty exits
	// on a *known* phase is a real signal ("phase declares no [[phases.exits]];
	// default-deny rejects all status writes") while unknown phase means the
	// caller has lost track of the preset shape — different problems, different
	// agent responses.
	private async handleItemExits(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "item.exits args", ITEM_EXITS_ARG_KEYS)
		validateItemUpdateSelector(args)
		const agentRunId = optionalString(args, "agentRunId")
		const agentPhase = optionalString(args, "agentPhase")
		if (agentRunId === null || agentPhase === null) {
			throw new DaemonError("invalid_request", "item.exits requires both agentRunId and agentPhase (the query is per-agent-run, per-phase)", {})
		}
		const item = this.resolveItem(args)
		const store = this.requireStore()
		const chain = store.getChain(item.chainId)
		if (chain === null) throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
		const { preset } = await this.loadedPresetForItem(chain, item, "item.exits")
		const presetPhase = preset.phases.find((entry) => entry.name === agentPhase)
		if (presetPhase === undefined) {
			const knownPhases = preset.phases.map((entry) => entry.name)
			throw new DaemonError(
				"invalid_request",
				`item.exits: phase "${agentPhase}" is not declared in preset "${preset.name}" (known phases: ${knownPhases.join(", ") || "<none>"})`,
				{ phase: agentPhase, knownPhases },
			)
		}
		// Query is read-only — no audit event is emitted (the write-side gate at
		// `admitItemStatusForPhaseRequest` and `handleItemExitAction` already
		// record the write attempt the query informs). The ADT response carries
		// both branches typed so the CLI cannot collapse a chain-action exit
		// into a fake status string.
		const exits: JsonValue[] = presetPhase.exits.map((exit) => phaseExitToJsonValue(exit))
		const allowedStatuses = phaseWritableStatuses(presetPhase).slice().sort()
		const allowedChainActions = phaseChainActions(presetPhase).slice().sort()
		return { phase: agentPhase, exits, allowedStatuses, allowedChainActions }
	}

	// #405 chain-action exit selection. Companion write-side surface to the
	// #451 typed query: agent calls `item.exits` to learn what its phase
	// declares, then dispatches one of two writers — `item.update --status` for
	// item-status exits or this handler for chain-action exits. Today the only
	// chain action is `stop`, mapped to the chain.stop API path (D1 semantics:
	// scheduler stops selecting, in-flight runs naturally complete, `chain
	// resume` reversible). Three gates:
	//   1. Caller admission via `admitItemMutationCaller` (operator or
	//      credential-bound agent). The chain-action selection is a privileged
	//      write — unauthenticated callers and stale credentials cannot fire it.
	//   2. Per-phase action vocabulary — the action must be declared in the
	//      requesting phase's `[[phases.exits]]` chain-action branch; default-deny
	//      otherwise (mirrors the #397 default-deny status admission).
	//   3. The phase the agent claims must actually be the agent's currently
	//      running phase (the caller-admission gate confirms the credential
	//      binding includes the same phase).
	// Two observability events:
	//   - `item.exit.selected` (audit) — records the agent's selection regardless
	//     of whether the engine proceeds; pairs with the existing `item.status.write_admission`
	//     pattern for status writes.
	//   - `chain.stop.from_phase_exit` (lifecycle) — records the engine's
	//     execution of the chain-stop side effect, distinguishing operator vs
	//     phase-exit-driven stops in the lifecycle stream.
	private async handleItemExitAction(args: JsonObject): Promise<JsonObject> {
		validateKnownKeys(args, "item.exitAction args", ITEM_EXIT_ACTION_ARG_KEYS)
		validateItemUpdateSelector(args)
		const agentRunId = optionalString(args, "agentRunId")
		const agentPhase = optionalString(args, "agentPhase")
		if (agentRunId === null || agentPhase === null) {
			throw new DaemonError("invalid_request", "item.exitAction requires both agentRunId and agentPhase (the gate is per-agent-run, per-phase)", {})
		}
		const action = parseChainActionFromRequest(args)
		const item = this.resolveItem(args)
		const store = this.requireStore()
		const chain = store.getChain(item.chainId)
		if (chain === null) throw new DaemonError("not_found", `chain ${item.chainId} was not found`, { chainId: item.chainId })
		assertChainAllowsItemMutation(chain, "item.exitAction")
		const caller = await this.admitItemMutationCaller(chain, item, args)
		const { preset } = await this.loadedPresetForItem(chain, item, "item.exitAction")
		const presetPhase = preset.phases.find((entry) => entry.name === agentPhase)
		if (presetPhase === undefined) {
			const knownPhases = preset.phases.map((entry) => entry.name)
			throw new DaemonError(
				"invalid_request",
				`item.exitAction: phase "${agentPhase}" is not declared in preset "${preset.name}" (known phases: ${knownPhases.join(", ") || "<none>"})`,
				{ phase: agentPhase, knownPhases },
			)
		}
		const declaredActions = phaseChainActions(presetPhase)
		const declaredActionList = declaredActions.slice().sort()
		const isDeclared = declaredActions.includes(action)
		await this.recordExitSelectionAuditEvent(chain, {
			item,
			phase: agentPhase,
			runId: agentRunId,
			selection: { kind: "chain-action", action },
			declaredChainActions: declaredActionList,
			declaredItemStatuses: phaseWritableStatuses(presetPhase).slice().sort(),
			outcome: isDeclared ? "allow" : "deny",
			reason: isDeclared ? "admitted" : "phase-exits",
			subject: caller.subject,
		})
		if (!isDeclared) {
			throw new DaemonError(
				"invalid_request",
				`item.exitAction: chain action "${action}" is not declared by phase "${agentPhase}" (declared chain actions: ${declaredActionList.join(", ") || "<none> (default-deny)"})`,
				{ action, phase: agentPhase, declaredChainActions: declaredActionList },
			)
		}
		switch (action) {
			case "stop": {
				const result = await this.performChainStopFromPhaseExit(chain, {
					rowId: item.id,
					itemId: item.itemId,
					runId: agentRunId,
					phase: agentPhase,
					subject: caller.subject,
				})
				return { action, chain: chainToJson(result.chain), terminatedRuns: result.terminatedRuns.map(completedRunToJson) }
			}
			default:
				return assertNeverChainAction(action)
		}
	}

	// #405: chain-action: stop dispatcher. Drives the same code path the
	// operator `chain.stop` handler runs (state mutation + active-run termination
	// + audit event) and then emits the lifecycle distinguisher.
	private async performChainStopFromPhaseExit(chain: ChainRecord, source: { rowId: number; itemId: string; runId: string; phase: string; subject: ObservabilitySubject }): Promise<{ chain: ChainRecord; terminatedRuns: SchedulerCompletedRun[] }> {
		const resumeScheduler = await this.pauseSchedulerForMutation()
		try {
			const store = this.requireStore()
			// Mirror handleChainStop: idempotent if already stopped.
			if (chain.status === "stopped") {
				await this.recordChainStopFromPhaseExitLifecycle(chain, { ...source, alreadyStopped: true, terminatedRunIds: [] })
				return { chain, terminatedRuns: [] }
			}
			assertChainCanTransition(chain, "item.exitAction:stop", "active", "stopped")
			const stopped = store.updateChain(chain.id, { status: "stopped" })
			const terminatedRuns = await this.terminateActiveRunsForChain(chain.id)
			const terminatedRunIds = terminatedRuns.map((run) => run.runId)
			await this.recordObservabilityEventIfChainNameIsValid(stopped, makeObservabilityEvent({
				kind: "audit",
				type: "chain.status",
				chain: stopped.name,
				// event.item is the items.id integer rowid (FK shape; matches `runs.item_id`).
				item: source.rowId,
				runId: source.runId,
				phase: source.phase,
				subject: source.subject,
				payload: {
					chainId: stopped.id,
					fromStatus: chain.status,
					toStatus: stopped.status,
					terminatedRunIds,
				},
			}))
			await this.recordChainStopFromPhaseExitLifecycle(stopped, { ...source, alreadyStopped: false, terminatedRunIds })
			return { chain: stopped, terminatedRuns }
		} finally {
			resumeScheduler()
		}
	}

	private async recordChainStopFromPhaseExitLifecycle(chain: ChainRecord, source: { rowId: number; itemId: string; runId: string; phase: string; subject: ObservabilitySubject; alreadyStopped: boolean; terminatedRunIds: string[] }): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "lifecycle",
			type: "chain.stop.from_phase_exit",
			chain: chain.name,
			// event.item is the items.id integer rowid (FK shape; matches `runs.item_id`).
			item: source.rowId,
			runId: source.runId,
			phase: source.phase,
			subject: source.subject,
			payload: {
				chainId: chain.id,
				// `id` here is the opaque preset-declared string id (formerly `issueNumber`).
				id: source.itemId,
				alreadyStopped: source.alreadyStopped,
				terminatedRunIds: source.terminatedRunIds,
			},
		}))
	}

	// #405: emits one `item.exit.selected` audit event per chain-action exit
	// selection request — both admit and deny outcomes — so the audit stream
	// records the agent's intent independent of whether the engine proceeded.
	private async recordExitSelectionAuditEvent(chain: ChainRecord, input: {
		item: ItemRecord
		phase: string
		runId: string
		selection: { kind: "chain-action"; action: PresetPhaseChainAction }
		declaredItemStatuses: readonly string[]
		declaredChainActions: readonly string[]
		outcome: "allow" | "deny"
		reason: "admitted" | "phase-exits"
		subject: ObservabilitySubject
	}): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.exit.selected",
			chain: chain.name,
			item: input.item.id,
			runId: input.runId,
			phase: input.phase,
			subject: input.subject,
			payload: {
				rowId: input.item.id,
				itemId: input.item.itemId,
				phase: input.phase,
				selectionKind: input.selection.kind,
				selectedAction: input.selection.action,
				declaredItemStatuses: [...input.declaredItemStatuses],
				declaredChainActions: [...input.declaredChainActions],
				outcome: input.outcome,
				reason: input.reason,
			},
		}))
	}

	private resolveChain(args: JsonObject): ChainRecord {
		const store = this.requireStore()
		const chainId = optionalInteger(args, "chainId")
		const chainName = requestedChainName(args)
		if (chainId !== null) {
			const chain = store.getChain(chainId)
			if (chain === null) throw new DaemonError("not_found", `chain ${chainId} was not found`, { chainId })
			if (chainName !== null) {
				const chainByName = store.getChainByName(chainName)
				if (chainByName === null) throw new DaemonError("not_found", `chain ${chainName} was not found`, { chainName })
				if (chainByName.id !== chain.id) {
					throw new DaemonError("invalid_request", "chainId and chainName both provided but point to different chains", {
						chainId,
						chainName,
						chainIdResolvesTo: chain.name,
						chainNameResolvesTo: chainByName.id,
					})
				}
			}
			return chain
		}
		if (chainName !== null) {
			const chain = store.getChainByName(chainName)
			if (chain === null) throw new DaemonError("not_found", `chain ${chainName} was not found`, { chainName })
			return chain
		}
		throw new DaemonError("invalid_request", "request requires chainId or chainName")
	}

	private resolveItem(args: JsonObject): ItemRecord {
		// #419: the `itemId` wire field accepts either a numeric rowid (engine-internal) or the
		// preset-declared opaque string id (the only identity surface for agents / operators after
		// the items table de-GitHub-shaping). Numbers route to `getItem(rowid)`; strings route via
		// `getItemById(chain.id, itemId)` against the new `items.item_id` column. The legacy
		// `issueNumber` integer selector is retired (breaking wire change, #456 precedent).
		const rawItemId = args["itemId"]
		if (typeof rawItemId === "number" && Number.isInteger(rawItemId) && rawItemId > 0) {
			const item = this.requireStore().getItem(rawItemId)
			if (item === null) throw new DaemonError("not_found", `item ${rawItemId} was not found`, { itemId: rawItemId })
			return item
		}
		const chain = this.resolveChain(args)
		const itemId = validateItemId(requiredString(args, "itemId"))
		const item = this.requireStore().getItemById(chain.id, itemId)
		if (item === null) throw new DaemonError("not_found", `item ${itemId} was not found in chain ${chain.name}`, { chainId: chain.id, itemId })
		return item
	}

	private requireStore(): SqliteStateStore {
		if (this.store === null) throw new DaemonError("daemon_not_running", "daemon store is not open")
		return this.store
	}

	private schedulerEnabled(): boolean {
		return this.options.scheduler?.enabled !== false
	}

	private startSchedulerLoop(): void {
		if (!this.schedulerEnabled()) return
		const intervalMs = this.options.scheduler?.intervalMs ?? 1_000
		this.schedulerTimer = setInterval(() => {
			this.queueSchedulerTick()
		}, intervalMs)
	}

	private async requestSchedulerTick(): Promise<void> {
		if (!this.schedulerEnabled() || this.state !== "running" || this.schedulerPauseDepth > 0) return
		if (this.schedulerTickInFlight !== null) {
			this.schedulerTickRequested = true
			return await this.schedulerTickInFlight
		}
		this.schedulerTickInFlight = this.runSchedulerTicks()
		try {
			await this.schedulerTickInFlight
		} finally {
			this.schedulerTickInFlight = null
		}
	}

	private queueSchedulerTick(): void {
		void this.requestSchedulerTick().catch((error: unknown) => {
			const message = errorMessage(error)
			void this.recordObservabilityEvent(makeObservabilityEvent({
				kind: "diagnostic",
				type: "scheduler.tick_failed",
				subject: { kind: "engine" },
				payload: { pid: process.pid, error: message },
			})).catch(() => undefined)
		})
	}

	private async pauseSchedulerForMutation(): Promise<() => void> {
		this.schedulerPauseDepth += 1
		if (this.schedulerTimer !== null) {
			clearInterval(this.schedulerTimer)
			this.schedulerTimer = null
		}
		await this.schedulerTickInFlight
		let resumed = false
		return () => {
			if (resumed) return
			resumed = true
			this.schedulerPauseDepth -= 1
			if (this.schedulerPauseDepth === 0 && this.state === "running") {
				this.startSchedulerLoop()
				this.queueSchedulerTick()
			}
		}
	}

	private async runSchedulerTicks(): Promise<void> {
		do {
			this.schedulerTickRequested = false
			await schedulerTick(this.buildSchedulerOptions())
		} while (this.schedulerTickRequested && this.state === "running")
	}

	private buildSchedulerOptions(): SchedulerOptions {
		const scheduler = this.options.scheduler ?? {}
		const externalOnEvent = scheduler.onEvent
		const schedulerPresetDir = scheduler.presetDir
		const presetForChain: SchedulerPresetResolver = scheduler.presetForChain ?? ((chain: ChainRecord) =>
			schedulerPresetDir === undefined ? this.loadedPresetForChain(chain, "scheduler.tick") : this.loadedPresetFromDirForChain(chain, schedulerPresetDir, "scheduler.tick"))
		// #412: per-item preset resolution. Test fixtures can override `presetForItem` directly; production
		// uses the daemon's `loadedPresetForItem` which honors item.preset / item.presetPath first and
		// falls back to chain-level resolution for legacy items.
		const presetForItem: SchedulerPresetItemResolver = scheduler.presetForItem ?? ((chain: ChainRecord, item: ItemRecord) =>
			schedulerPresetDir === undefined ? this.loadedPresetForItem(chain, item, "scheduler.tick") : this.loadedPresetFromDirForChain(chain, schedulerPresetDir, "scheduler.tick"))
		const presetPromptResolver = (ctx: SchedulerSpawnContext): Promise<string> =>
			this.resolveLoadedPresetPhasePrompt(ctx)
		const fallbackRunner = scheduler.runner ?? defaultDaemonRunner()
		const phaseRunnerSelectionForChain: SchedulerOptions["phaseRunnerSelectionForChain"] = scheduler.phaseRunnerSelectionForChain
			?? (scheduler.phaseRunner !== undefined || scheduler.runner !== undefined
				? undefined
				: async (chain) => {
					const { preset } = await presetForChain(chain)
					return buildPhaseRunnerSelectionFromChain({
						chain,
						loopDataRoot: this.paths.root,
						preset,
					})
				})
		// #412: per-item phase runner resolver. resolvePhaseRunner prefers this over the chain-wide
		// form so mixed-preset chains pick runner+phases from the item's own preset. Production
		// dispatches via the same `presetForItem` codepath the scheduler already uses for spawn;
		// test fixtures can override via scheduler.phaseRunnerSelectionForItem.
		const phaseRunnerSelectionForItem: SchedulerOptions["phaseRunnerSelectionForItem"] = scheduler.phaseRunnerSelectionForItem
			?? (scheduler.phaseRunner !== undefined || scheduler.runner !== undefined
				? undefined
				: async (chain, item) => {
					const { preset } = await presetForItem(chain, item)
					return buildPhaseRunnerSelectionFromChain({
						chain,
						loopDataRoot: this.paths.root,
						preset,
					})
				})
		const options: SchedulerOptions = {
			store: this.requireStore(),
			state: this.schedulerState,
			runner: fallbackRunner,
			presetForChain,
			presetForItem,
			prompt: scheduler.prompt ?? presetPromptResolver,
			onEvent: async (event) => {
				if (this.store !== null) {
					await this.recordObservabilityEventForChainId(event.chainId, (chain) => schedulerEventToObservabilityEvent(chain, event))
				}
				await externalOnEvent?.(event)
			},
		}
		if (scheduler.phaseRunner !== undefined) options.phaseRunner = scheduler.phaseRunner
		if (phaseRunnerSelectionForChain !== undefined) options.phaseRunnerSelectionForChain = phaseRunnerSelectionForChain
		if (phaseRunnerSelectionForItem !== undefined) options.phaseRunnerSelectionForItem = phaseRunnerSelectionForItem
		if (scheduler.phase !== undefined) options.phase = scheduler.phase
		if (scheduler.worktreeManager !== undefined) options.worktreeManager = scheduler.worktreeManager
		options.loopDataRootOptions = this.options
		if (scheduler.now !== undefined) options.now = scheduler.now
		if (scheduler.runIdFactory !== undefined) options.runIdFactory = scheduler.runIdFactory
		// #406: wire the daemon-owned credential issuer. Test fixtures may pass their own issuer
		// through scheduler.runCredentials (for unit tests that want to inspect bindings directly);
		// production defaults to the daemon's instance-bound registry.
		options.runCredentials = scheduler.runCredentials ?? this.buildRunCredentialIssuer()
		options.maxItemAttemptsForChain = scheduler.maxItemAttemptsForChain
			?? ((chain) => maxItemAttemptsFromChainMetadata(chain.metadata))
		if (scheduler.maxItemAttempts !== undefined) options.maxItemAttempts = scheduler.maxItemAttempts
		if (scheduler.spawnFailureBackoff !== undefined) options.spawnFailureBackoff = scheduler.spawnFailureBackoff
		if (scheduler.spawnFailureBackoffForChain !== undefined) options.spawnFailureBackoffForChain = scheduler.spawnFailureBackoffForChain
		if (scheduler.attemptTimeoutMs !== undefined) options.attemptTimeoutMs = scheduler.attemptTimeoutMs
		if (scheduler.attemptKillMs !== undefined) options.attemptKillMs = scheduler.attemptKillMs
		// #452: the retired `watchdogGraceMs`/`watchdogKillMs` knobs configured the
		// stdout-summary watchdog. Their replacement is the recycle-zone window that
		// arms only after the daemon observes a successful agent state write.
		if (scheduler.recycleAfterStateWriteMs !== undefined) options.recycleAfterStateWriteMs = scheduler.recycleAfterStateWriteMs
		if (scheduler.recycleKillGraceMs !== undefined) options.recycleKillGraceMs = scheduler.recycleKillGraceMs
		if (scheduler.chainCompleteTrigger !== undefined) options.chainCompleteTrigger = scheduler.chainCompleteTrigger
		else if (scheduler.chainCompleteTriggerForChain !== undefined) options.chainCompleteTriggerForChain = scheduler.chainCompleteTriggerForChain
		else {
			const explicitRunnerOverride = scheduler.runner !== undefined ? fallbackRunner : null
			options.chainCompleteTriggerForChain = async (context) =>
				await runPresetChainCompleteTriggerPhases({
					...context,
					loopDataRoot: this.paths.root,
					terminalStatusNames: context.terminalStatusNames,
					...(await presetForChain(context.chain)),
					...(explicitRunnerOverride === null ? {} : { phaseRunner: () => explicitRunnerOverride }),
				})
		}
		return options
	}

	private warnSkippedInvalidChain(chain: ChainRecord, error: RuntimePathError, context: string): void {
		console.warn(`coder-loop daemon warning: skipped ${context} for invalid chain ${chain.id} (${JSON.stringify(chain.name)}): ${error.message}`)
	}

	// #397 default-deny admission gate. Replaces the old `validateItemStatusForRequest` (which
	// returned `InternalStatus`) — the rename and the return type (`AdmittedItemStatus`) are how
	// the typechecker enumerates every status-write path: any code calling `store.updateItem({
	// status })` needs an `AdmittedItemStatus`, which is producible only here (request flow) or
	// via the narrow `engineLifecycleAdmittedItemStatus` constructor in runtime-data.ts.
	//
	// Both legs of the admission emit one `item.status.write_admission` audit event so a
	// default-deny rejection can be replayed from the event stream (#411-style audit obligation;
	// see issue #397 comment "log 义务").
	private async admitItemStatusForRequest(chain: ChainRecord, item: ItemRecord, status: string, subject: ObservabilitySubject): Promise<AdmittedItemStatus> {
		await this.admitItemStatusVocabularyForRequest(chain, item, status, subject)
		const phase = item.phase
		if (phase === null) {
			// Operator mid-run path (#397 acceptance row 7): no active phase → vocabulary-only.
			// Audit records the no-phase outcome so the no-special-casing claim is auditable.
			await this.recordItemStatusAdmissionEvent(chain, {
				item,
				phase: null,
				requestedStatus: status,
				declaredExits: [],
				outcome: "allow",
				reason: "no-phase-active",
				subject,
			})
		} else {
			await this.admitItemStatusForPhaseRequest(chain, item, phase, status, subject)
		}
		const parsed = parseInternalStatus(status, "item.status")
		assertRequestAdmittedItemStatus(parsed)
		return parsed
	}

	private async admitItemStatusVocabularyForRequest(chain: ChainRecord, item: ItemRecord, status: string, subject: ObservabilitySubject): Promise<void> {
		const allowed = await this.allowedItemStatuses(chain)
		if (allowed.has(status)) return
		await this.recordItemStatusAdmissionEvent(chain, {
			item,
			phase: item.phase,
			requestedStatus: status,
			declaredExits: [],
			outcome: "deny",
			reason: "vocabulary",
			subject,
		})
		throw new DaemonError("invalid_request", `item status must be one of: ${[...allowed].sort().join(", ")}`, { status })
	}

	// #412 per-item flavor: derive the entry status from the item's declared preset rather than the
	// chain's. The chain-aware variant routes load failures through `loadedPresetFromDirForChain`
	// so each chain that hits a bad preset gets its own `daemon.preset_load_failed` observability
	// event and a consistent "failed to load preset for chain <name>" error message.
	private async defaultItemStatusForPresetSpecOnChain(chain: ChainRecord, spec: { preset: string | null; presetPath: string | null }): Promise<AdmittedItemStatus> {
		const presetDir = spec.presetPath !== null
			? (isAbsolute(spec.presetPath) ? spec.presetPath : resolve(spec.presetPath))
			: bundledPresetDir(spec.preset ?? "")
		const { preset } = await this.loadedPresetFromDirForChain(chain, presetDir, "item.create.default-status")
		return engineLifecycleAdmittedItemStatus(preset.statuses.entry, "item.created-default-from-preset")
	}

	// #397 default-deny: when the active phase is unknown to the preset, or when the phase has
	// no `[[phases.exits]]` declared (writable set is empty), every status write is rejected. The
	// pre-#397 gate returned `null` from `allowedItemStatusesForPhase` and short-circuited to
	// "allow" for unknown phases — the failure mode the issue body anchors as "iteration phase 正
	// 是无 exits" (iteration's writable set is empty under the new default-deny semantics, so
	// agent attempts to write status from iteration are rejected at this gate even though the
	// prompt convention says iteration writes no status).
	private async admitItemStatusForPhaseRequest(chain: ChainRecord, item: ItemRecord, phase: string, status: string, subject: ObservabilitySubject): Promise<void> {
		const allowed = await this.allowedItemStatusesForPhase(chain, phase)
		const allowedList = allowed === null ? [] : [...allowed].sort()
		const declaredExits: readonly string[] = allowedList
		if (allowed !== null && allowed.has(status)) {
			await this.recordItemStatusAdmissionEvent(chain, {
				item,
				phase,
				requestedStatus: status,
				declaredExits,
				outcome: "allow",
				reason: "admitted",
				subject,
			})
			return
		}
		await this.recordItemStatusAdmissionEvent(chain, {
			item,
			phase,
			requestedStatus: status,
			declaredExits,
			outcome: "deny",
			reason: "phase-exits",
			subject,
		})
		const phaseContext = allowed === null
			? `phase ${phase} is not declared in the preset; default-deny rejects all status writes from an unknown phase`
			: `item status ${status} is not allowed while item phase is ${phase}; allowed statuses: ${allowedList.join(", ") || "<none> (default-deny: phase declares no [[phases.exits]])"}`
		throw new DaemonError("invalid_request", phaseContext, {
			status,
			phase,
			allowed: allowedList,
		})
	}

	private async allowedItemStatusesForPhase(chain: ChainRecord, phase: string): Promise<Set<string> | null> {
		const { preset } = await this.loadedPresetForChain(chain, "item.status.admit-phase")
		const presetPhase = preset.phases.find((entry) => entry.name === phase)
		if (presetPhase === undefined) return null
		return new Set(phaseWritableStatuses(presetPhase))
	}

	private async recordItemStatusAdmissionEvent(chain: ChainRecord, input: ItemStatusAdmissionRecord): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.status.write_admission",
			chain: chain.name,
			item: input.item.id,
			...(input.phase === null ? {} : { phase: input.phase }),
			subject: input.subject,
			payload: {
				rowId: input.item.id,
				itemId: input.item.itemId,
				phase: input.phase,
				requestedStatus: input.requestedStatus,
				declaredExits: [...input.declaredExits],
				outcome: input.outcome,
				reason: input.reason,
			},
		}))
	}

	// #406/#407 caller resolution. Boundary parse of `agentCredential`: the request is either
	// agent-attributed (env-borne credential present) or operator-attributed (no credential). The
	// item-bound `wrong-item` check is NOT performed here — that leg is item-specific and lives in
	// `admitItemMutationCaller` (used by `item.update`). The `item.add` / `item.batchAdd` callers
	// have no item to compare against (it is being created), so they call this resolver directly
	// and rely on the rights gate to enforce phase authorization. This function does not emit
	// audit events — emission is the caller's job because the audit schema differs between the
	// update path (`item.mutation.caller_admission` requires itemId) and the add path
	// (`item.add.rights_admission` carries the credential outcome inside its `reason`).
	//
	// Returns a `Result<ItemMutationCaller, ResolveCallerDenyReason>` — the typed err variant
	// carries the reason directly (no thrown DaemonError, no string-match recovery of the reason,
	// no `unknown` widening of `args.agentCredential` past its boundary-parsed `JsonValue` type).
	// The reason is constructed at the branch that decides it, so a future variant addition forces
	// every consumer to handle it (exhaustive switch in `admitItemMutationCaller`).
	private resolveItemMutationCaller(args: JsonObject): Result<ItemMutationCaller, ResolveCallerDenyReason> {
		// `args` came in through the JsonObject boundary parser already, so `args[K]` for any K
		// is `JsonValue | undefined` — a typed sum type, NOT `unknown`. This reads `JsonValue`
		// directly without widening.
		const credentialField: JsonValue | undefined = args.agentCredential
		if (credentialField === undefined) {
			// Operator path: no credential field at all → caller is the operator.
			const subject: Extract<ObservabilitySubject, { kind: "operator" }> = { kind: "operator" }
			return { kind: "ok", value: { kind: "operator", subject } }
		}
		if (typeof credentialField !== "string" || credentialField === "") {
			// `JsonValue` narrows here: not a non-empty string → either null/boolean/number/array/
			// nested object, or the empty string. Both surface as `missing-credential` because the
			// only legitimate shape is a registered UUID, and treating "wrong type" as the same
			// reason as "absent" matches the pre-refactor behavior preserved for wire compat.
			return { kind: "err", error: { kind: "missing-credential" } }
		}
		const registration = this.runCredentialRegistry.get(credentialField)
		if (registration === undefined) {
			return { kind: "err", error: { kind: "unknown-credential" } }
		}
		// Defense in depth: confirm the bound run is still active in the scheduler state. The
		// scheduler revokes the credential in the close-handler `finally`, but if a revocation
		// ever fails to fire (process crash inside the handler), this catches the staleness.
		const activeRuns = listActiveRuns(this.schedulerState)
		const stillActive = activeRuns.some((run) => run.runId === registration.context.runId)
		if (!stillActive) {
			// Also evict the stale binding so further requests fail with the cleaner
			// `unknown-credential` reason instead of repeatedly tripping this branch.
			this.runCredentialRegistry.delete(credentialField)
			return { kind: "err", error: { kind: "inactive-run", runId: registration.context.runId } }
		}
		const subject: Extract<ObservabilitySubject, { kind: "agent" }> = {
			kind: "agent",
			runId: registration.context.runId,
			phase: registration.context.phase,
		}
		return {
			kind: "ok",
			value: { kind: "agent", runId: registration.context.runId, phase: registration.context.phase, subject },
		}
	}

	// #407 review-feedback refactor: convert a typed `ResolveCallerDenyReason` err variant into
	// the `DaemonError` the wire callers throw. Centralised here so the `invalid_caller` code,
	// message text, and `details` payload remain identical to the pre-refactor throws — the wire
	// shape is part of the public daemon protocol and pinned by socket integration tests. The
	// exhaustive switch enforces that any new variant added to `ResolveCallerDenyReason` must
	// gain a corresponding throw shape (TS reports the missing case otherwise).
	private resolveCallerDenyError(reason: ResolveCallerDenyReason): DaemonError {
		switch (reason.kind) {
			case "missing-credential":
				return new DaemonError("invalid_caller", "agentCredential must be a non-empty string when provided", {
					field: "agentCredential",
				})
			case "unknown-credential":
				return new DaemonError(
					"invalid_caller",
					"agentCredential did not match any active run; the run may have ended (credential revoked on run close) " +
						"or the credential value was never minted by this daemon.",
					{},
				)
			case "inactive-run":
				return new DaemonError(
					"invalid_caller",
					`agentCredential resolves to run ${reason.runId}, which is no longer active.`,
					{ runId: reason.runId },
				)
		}
	}

	// #406 caller-admission gate for `item.update`. Reuses the registry-lookup helper above and
	// layers the item-specific `wrong-item` check on top. Emits one `item.mutation.caller_admission`
	// audit event per outcome (allow or deny) so a rejection is replayable from the event stream
	// alongside `agent.exit` / `item.status`. The returned `ItemMutationCaller` is the type-level
	// proof that "anonymous mutation" did not slip through — downstream code consumes
	// `caller.subject` directly rather than reconstructing it.
	private async admitItemMutationCaller(
		chain: ChainRecord,
		item: ItemRecord,
		args: JsonObject,
	): Promise<ItemMutationCaller> {
		// Pre-406 free-claim attribution keys (`agentRunId` / `agentPhase`) are rejected one layer
		// earlier by `validateKnownKeys` in `validateItemUpdateRequest` — they are no longer in
		// `ITEM_UPDATE_ARG_KEYS`. By the time control reaches this gate, the args object cannot
		// contain them, so no `legacy-attribution-args` branch is reachable here.
		//
		// #407 review-feedback refactor: the resolver returns a typed `Result`. The deny reason
		// for the `item.mutation.caller_admission` audit event is read directly off the err
		// variant — no thrown DaemonError to inspect, no errorMessage.includes(...) string match,
		// no `unknown` widening of `args.agentCredential`. Variant name lines up 1:1 with the
		// `CallerAdmissionDenyReason` literal expected by the audit payload.
		const credentialFieldRaw: JsonValue | undefined = args.agentCredential
		const resolved = this.resolveItemMutationCaller(args)
		if (resolved.kind === "err") {
			await this.recordCallerAdmissionEvent(chain, {
				item,
				subject: { kind: "operator" },
				claimedRunId: null,
				claimedPhase: null,
				outcome: "deny",
				reason: resolved.error.kind,
			})
			throw this.resolveCallerDenyError(resolved.error)
		}
		const caller = resolved.value
		if (caller.kind === "operator") {
			await this.recordCallerAdmissionEvent(chain, {
				item,
				subject: caller.subject,
				claimedRunId: null,
				claimedPhase: null,
				outcome: "allow",
				reason: "operator",
			})
			return caller
		}
		// Agent path: enforce item-binding (parallel-slot misfire protection). The credential
		// already resolved in the helper above; re-fetch the registration here to compare bound
		// itemId vs request item.id. The registry returns undefined only on a race with revocation
		// — the cleaner failure mode (the resolve helper would itself throw `unknown-credential`)
		// already handled the absent case earlier, so the undefined branch here is structurally
		// unreachable. Keep a defensive guard so a future race condition still hits a clean error.
		const credentialKey = typeof credentialFieldRaw === "string" ? credentialFieldRaw : ""
		const registration = this.runCredentialRegistry.get(credentialKey)
		if (registration !== undefined && registration.context.itemId !== item.id) {
			await this.recordCallerAdmissionEvent(chain, {
				item,
				subject: caller.subject,
				claimedRunId: caller.runId,
				claimedPhase: caller.phase,
				outcome: "deny",
				reason: "wrong-item",
			})
			throw new DaemonError(
				"invalid_caller",
				`agentCredential is bound to item ${registration.context.itemId}, not ${item.id}; ` +
					"parallel-slot misfire — the agent attempted to mutate an item it does not own.",
				{ boundItemId: registration.context.itemId, requestItemId: item.id },
			)
		}
		await this.recordCallerAdmissionEvent(chain, {
			item,
			subject: caller.subject,
			claimedRunId: caller.runId,
			claimedPhase: caller.phase,
			outcome: "allow",
			reason: "agent-credential-admitted",
		})
		return caller
	}

	private async recordCallerAdmissionEvent(chain: ChainRecord, input: {
		item: ItemRecord
		subject: ObservabilitySubject
		claimedRunId: string | null
		claimedPhase: string | null
		outcome: "allow" | "deny"
		reason: "operator" | "agent-credential-admitted" | CallerAdmissionDenyReason
	}): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.mutation.caller_admission",
			chain: chain.name,
			item: input.item.id,
			...(input.subject.kind === "agent"
				? { runId: input.subject.runId, phase: input.subject.phase }
				: {}),
			subject: input.subject,
			payload: {
				rowId: input.item.id,
				itemId: input.item.itemId,
				claimedRunId: input.claimedRunId,
				claimedPhase: input.claimedPhase,
				outcome: input.outcome,
				reason: input.reason,
			},
		}))
	}

	// #407 per-phase item-creation rights gate. Operators (no agentCredential) bypass entirely —
	// CLI invocations on the operator's machine are out of scope by design (acceptance row #3).
	// Agents must hold a `[phases.rights] createItems = true` segment under their currently-bound
	// phase on the NEW item's preset (not the chain's, not the agent's currently-running preset —
	// item.add binds the rights check to where the new item will run, identical in form to the
	// status-write gate's "active phase of THIS item" check). A missing `[phases.rights]` segment
	// → default-deny (acceptance row #4); a present-but-false `createItems` → deny. Allow + deny
	// are both audited via `item.add.rights_admission`. The deny path throws `invalid_caller` so
	// the wire-level shape matches the existing #406 caller-admission rejection family.
	private async assertItemAddRightsForCaller(
		chain: ChainRecord,
		caller: ItemMutationCaller,
		presetSpec: { preset: string | null; presetPath: string | null },
		label: string,
	): Promise<void> {
		const presetName = presetSpec.preset ?? presetSpec.presetPath ?? "<unknown>"
		if (caller.kind === "operator") {
			await this.recordItemAddRightsAdmissionEvent(chain, {
				caller,
				outcome: "allow",
				reason: "operator",
				presetName,
			})
			return
		}
		// Load the new item's preset to look up the caller-phase rights. Failures route through
		// the standard preset_load_failed path so a malformed preset surfaces in the event stream
		// the same way scheduler-side loads do.
		const presetDir = presetSpec.presetPath !== null
			? (isAbsolute(presetSpec.presetPath) ? presetSpec.presetPath : resolve(presetSpec.presetPath))
			: bundledPresetDir(presetSpec.preset ?? "")
		const { preset } = await this.loadedPresetFromDirForChain(chain, presetDir, `${label}.rights`)
		const callerPhase = preset.phases.find((entry) => entry.name === caller.phase)
		if (callerPhase === undefined) {
			// The caller's bound phase is not declared in the new item's preset — treat as
			// default-deny since a phase we don't know cannot have been granted createItems.
			await this.recordItemAddRightsAdmissionEvent(chain, {
				caller,
				outcome: "deny",
				reason: "no-rights-segment",
				presetName,
			})
			throw new DaemonError(
				"invalid_caller",
				`${label}: phase "${caller.phase}" is not declared in preset "${presetName}"; no creation grant available (default-deny)`,
				{ phase: caller.phase, presetName },
			)
		}
		if (!callerPhase.rights.createItems) {
			// The phase exists but has no createItems grant — distinguish the "segment absent
			// entirely" (no-rights-segment) from "segment present, createItems explicitly false or
			// omitted" (no-create-grant) for fast audit queries.
			const reason = this.classifyNoCreateGrantReason(callerPhase.rights)
			await this.recordItemAddRightsAdmissionEvent(chain, {
				caller,
				outcome: "deny",
				reason,
				presetName,
			})
			throw new DaemonError(
				"invalid_caller",
				`${label}: phase "${caller.phase}" has no createItems grant on preset "${presetName}"`,
				{ phase: caller.phase, presetName },
			)
		}
		await this.recordItemAddRightsAdmissionEvent(chain, {
			caller,
			outcome: "allow",
			reason: "agent-allowed",
			presetName,
		})
	}

	// #407 classify the absence of createItems into the two reason variants. A segment that is
	// completely missing from the preset.toml is interpreted as "default-deny + author has not yet
	// declared any rights"; a segment declared without createItems (or with createItems=false) is
	// "author saw the rights segment but withheld createItems". Both deny — distinct reasons
	// surface that difference in audit queries.
	private classifyNoCreateGrantReason(rights: PresetPhaseRights): "no-rights-segment" | "no-create-grant" {
		if (!rights.createItems && rights.writableFields.size === 0 && rights.privilegedOps.size === 0) {
			return "no-rights-segment"
		}
		return "no-create-grant"
	}

	private async recordItemAddRightsAdmissionEvent(chain: ChainRecord, input: {
		caller: ItemMutationCaller
		outcome: "allow" | "deny"
		reason: "operator" | "agent-allowed" | "no-create-grant" | "no-rights-segment"
		presetName: string
	}): Promise<void> {
		const claimedPhase = input.caller.kind === "agent" ? input.caller.phase : null
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.add.rights_admission",
			chain: chain.name,
			...(input.caller.kind === "agent"
				? { runId: input.caller.runId, phase: input.caller.phase }
				: {}),
			subject: input.caller.subject,
			payload: {
				claimedPhase,
				presetName: input.presetName,
				outcome: input.outcome,
				reason: input.reason,
			},
		}))
	}

	// #410 per-phase field-write gate. Runs at the request-parse-point of `item.update`. Parses
	// the requested field set once (top-level update fields + expanded `extra` / `extraPatch`
	// inner keys), classifies each via `classifyItemUpdateField`, then judges the matrix in one
	// pass against the caller-phase's `[phases.rights] writableFields`. Operator path skips
	// classification entirely (the rights segment is the agent-grant surface). Throws
	// `invalid_caller` on deny BEFORE any store write — denied requests produce no partial state.
	//
	// Two structurally distinct deny variants surface separately so audit consumers can tell
	// "preset author can fix this" from "no preset surface can ever grant this":
	//   - `control-plane-denied`  → request touched `runner`/`repoCwd`/`dependsOn`/`priority`
	//     (top-level or inside extra/extraPatch). Default-deny, no preset surface.
	//   - `field-not-granted`     → only passthrough fields / extra-inner keys not declared in
	//     the phase's `writableFields`. Recoverable by extending the preset's writable set.
	private async admitItemUpdateFieldWrites(
		chain: ChainRecord,
		item: ItemRecord,
		caller: ItemMutationCaller,
		fields: JsonObject,
	): Promise<void> {
		const requested = collectItemUpdateFieldKeys(fields)
		if (caller.kind === "operator") {
			// Operator path: always allow. Emit one allow event with reason=operator so the
			// audit trail records every item.update through this gate uniformly (mirrors
			// `item.mutation.caller_admission`'s operator-allow event).
			await this.recordItemUpdateFieldWriteAdmissionEvent(chain, {
				item,
				caller,
				outcome: "allow",
				reason: "operator",
				presetName: null,
				requestedFields: [...requested.all].sort(),
				grantedFields: [...requested.all].sort(),
				deniedFields: [],
			})
			return
		}
		// Agent path: load the item's preset to find the caller-phase's writableFields. Routes
		// load failures through the standard preset_load_failed path.
		const { preset } = await this.loadedPresetForItem(chain, item, "item.update.field-rights")
		const callerPhase = preset.phases.find((entry) => entry.name === caller.phase)
		const presetName = preset.name
		// Phase missing from the new item's preset — the caller phase cannot have grants in a
		// preset that does not declare it. Default-deny via the same `no-rights-segment` reason
		// the #407 gate emits, so audit queries grouped by reason stay consistent.
		if (callerPhase === undefined) {
			await this.recordItemUpdateFieldWriteAdmissionEvent(chain, {
				item,
				caller,
				outcome: "deny",
				reason: "no-rights-segment",
				presetName,
				requestedFields: [...requested.all].sort(),
				grantedFields: [],
				deniedFields: [...requested.all].sort(),
			})
			throw new DaemonError(
				"invalid_caller",
				`item.update: phase "${caller.phase}" is not declared in preset "${presetName}"; no field-write grant available (default-deny)`,
				{ phase: caller.phase, presetName },
			)
		}
		const verdict = judgeItemUpdateFieldWrites(requested, callerPhase.rights)
		if (verdict.kind === "allow") {
			await this.recordItemUpdateFieldWriteAdmissionEvent(chain, {
				item,
				caller,
				outcome: "allow",
				reason: verdict.reason,
				presetName,
				requestedFields: [...requested.all].sort(),
				grantedFields: [...verdict.granted].sort(),
				deniedFields: [],
			})
			return
		}
		await this.recordItemUpdateFieldWriteAdmissionEvent(chain, {
			item,
			caller,
			outcome: "deny",
			reason: verdict.reason,
			presetName,
			requestedFields: [...requested.all].sort(),
			grantedFields: [...verdict.granted].sort(),
			deniedFields: [...verdict.denied].sort(),
		})
		throw new DaemonError(
			"invalid_caller",
			`item.update: phase "${caller.phase}" on preset "${presetName}" has no write grant for field(s) ${[...verdict.denied].sort().map((field) => `"${field}"`).join(", ")} (reason=${verdict.reason})`,
			{ phase: caller.phase, presetName, deniedFields: [...verdict.denied].sort(), reason: verdict.reason },
		)
	}

	private async recordItemUpdateFieldWriteAdmissionEvent(chain: ChainRecord, input: {
		item: ItemRecord
		caller: ItemMutationCaller
		outcome: "allow" | "deny"
		reason: ItemUpdateFieldWriteReason
		presetName: string | null
		requestedFields: string[]
		grantedFields: string[]
		deniedFields: string[]
	}): Promise<void> {
		const claimedPhase = input.caller.kind === "agent" ? input.caller.phase : null
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "audit",
			type: "item.update.field_write_admission",
			chain: chain.name,
			item: input.item.id,
			...(input.caller.kind === "agent"
				? { runId: input.caller.runId, phase: input.caller.phase }
				: {}),
			subject: input.caller.subject,
			payload: {
				rowId: input.item.id,
				itemId: input.item.itemId,
				claimedPhase,
				presetName: input.presetName,
				requestedFields: input.requestedFields,
				grantedFields: input.grantedFields,
				deniedFields: input.deniedFields,
				outcome: input.outcome,
				reason: input.reason,
			},
		}))
	}

	// #406: build the credential issuer the daemon hands to the scheduler. Mint generates an
	// opaque UUID and registers it; revoke deletes the entry. Both are idempotent in shape — mint
	// never collides because UUID v4 is the source of the value; revoke tolerates a missing entry
	// (the registry may have already evicted it via the inactive-run branch of the admission gate).
	private buildRunCredentialIssuer(): SchedulerRunCredentialIssuer {
		return {
			mint: (context: SchedulerRunCredentialContext): SchedulerRunCredential => {
				const value = randomUUID()
				this.runCredentialRegistry.set(value, { value, context: { ...context } })
				return { value }
			},
			revoke: (credential: SchedulerRunCredential, _context: SchedulerRunCredentialContext): void => {
				this.runCredentialRegistry.delete(credential.value)
			},
		}
	}

	private async allowedItemStatuses(chain: ChainRecord): Promise<Set<string>> {
		const { preset } = await this.loadedPresetForChain(chain, "item.status.allowed")
		return new Set([...preset.statuses.continuable, ...preset.statuses.terminal])
	}

	private async continuableItemStatuses(chain: ChainRecord): Promise<Set<InternalStatus>> {
		const { preset } = await this.loadedPresetForChain(chain, "chain.continuable-statuses")
		return new Set(preset.statuses.continuable)
	}

	private async terminalItemStatuses(chain: ChainRecord): Promise<Set<InternalStatus>> {
		const { preset } = await this.loadedPresetForChain(chain, "chain.terminal-statuses")
		return new Set(preset.statuses.terminal)
	}

	private async unblockItemStatuses(chain: ChainRecord): Promise<{ success: readonly InternalStatus[]; entry: InternalStatus }> {
		const { preset } = await this.loadedPresetForChain(chain, "chain.unblock-statuses")
		return { success: preset.statuses.success, entry: preset.statuses.entry }
	}

	private async entryItemStatusForRecovery(chain: ChainRecord): Promise<AdmittedItemStatus> {
		const { entry } = await this.unblockItemStatuses(chain)
		return engineLifecycleAdmittedItemStatus(entry, "scheduler.recovery-entry-restore")
	}

	private async resolveLoadedPresetPhasePrompt(ctx: SchedulerSpawnContext): Promise<string> {
		const { preset, presetDir } = ctx.loadedPreset
		const presetPhase = preset.phases.find((entry) => entry.name === ctx.phase)
		if (presetPhase === undefined) {
			throw new Error(defaultDaemonPrompt({ reason: "phase_not_found_in_preset", preset: preset.name, phase: ctx.phase, presetDir }))
		}
		return await readFile(presetPhase.prompt, "utf-8")
	}

	private async loadedPresetForChain(chain: ChainRecord, operation: string): Promise<SchedulerLoadedPreset> {
		const presetDir = this.presetDirForChain(chain)
		return await this.loadedPresetFromDirForChain(chain, presetDir, operation)
	}

	// #419 helper: resolve+load a preset from the spec returned by `requireItemPresetForRequest`. Used
	// by `buildCreateItemInput` to consult the item's preset for `idField` without having to commit a
	// row to the store first.
	private async loadedPresetFromSpec(chain: ChainRecord, spec: { preset: string | null; presetPath: string | null }, operation: string): Promise<SchedulerLoadedPreset> {
		if (spec.presetPath !== null) {
			const dir = isAbsolute(spec.presetPath) ? spec.presetPath : resolve(spec.presetPath)
			return await this.loadedPresetFromDirForChain(chain, dir, operation)
		}
		if (spec.preset !== null) {
			return await this.loadedPresetFromDirForChain(chain, bundledPresetDir(spec.preset), operation)
		}
		return await this.loadedPresetForChain(chain, operation)
	}

	// #412 per-item preset loader. Resolves preset from item.preset / item.presetPath, falling back
	// to the chain-level resolver for legacy items.
	private async loadedPresetForItem(chain: ChainRecord, item: ItemRecord, operation: string): Promise<SchedulerLoadedPreset> {
		const presetDir = this.presetDirForItem(chain, item)
		return await this.loadedPresetFromDirForChain(chain, presetDir, operation)
	}

	private async loadedPresetFromDirForChain(chain: ChainRecord, presetDir: string, operation: string): Promise<SchedulerLoadedPreset> {
		const key = this.loadedPresetCacheKey(presetDir)
		const cached = this.loadedPresetCache.get(key)
		const collectedFindings: PresetPlaceholderFinding[] = []
		// #408 cross-table DAG findings flow alongside the placeholder findings — both warn AND error
		// findings need to land on the unified observability stream, so the collector runs even when
		// the load eventually throws (error-verdict findings always come WITH the throw, but the
		// warn-verdict findings are real informational events the operator must still see).
		const collectedDagFindings: PresetDagFinding[] = []
		// Findings are emitted only when the cache is cold so we don't double-write per chain.
		const loading = cached ?? loadSchedulerPresetFromDir(presetDir, {
			onValidationFinding: (finding) => collectedFindings.push(finding),
			onDagFinding: (finding) => collectedDagFindings.push(finding),
		})
		if (cached === undefined) this.loadedPresetCache.set(key, loading)
		try {
			const loaded = await loading
			for (const finding of collectedFindings) {
				await this.recordPlaceholderFinding(chain, finding)
			}
			for (const finding of collectedDagFindings) {
				await this.recordDagFinding(chain, finding)
			}
			return loaded
		} catch (error) {
			this.loadedPresetCache.delete(key)
			for (const finding of collectedFindings) {
				await this.recordPlaceholderFinding(chain, finding)
			}
			for (const finding of collectedDagFindings) {
				await this.recordDagFinding(chain, finding)
			}
			await this.recordPresetLoadFailure(chain, presetDir, operation, error)
			// #403: the error message names chain, target (chainName), preset, presetDir, and the
			// refused operation. "Generic 'preset error'" is forbidden by the issue's constraints.
			throw new DaemonError(
				"invalid_request",
				`failed to load preset for chain ${chain.name} (operation ${operation}, presetDir ${presetDir}): ${errorMessage(error)}`,
				{
					chainId: chain.id,
					chainName: chain.name,
					preset: chain.preset,
					presetDir,
					operation,
					error: errorMessage(error),
				},
			)
		}
	}

	private async recordPresetLoadFailure(chain: ChainRecord, presetDir: string, operation: string, error: unknown): Promise<void> {
		// #403: validation event (migrated from lifecycle in this issue). The event is emitted from
		// the single load-failure choke point so every refusal — regardless of the calling surface —
		// goes through the unified observability stream with consistent payload shape.
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "validation",
			type: "daemon.preset_load_failed",
			chain: chain.name,
			subject: { kind: "engine" },
			payload: {
				chainId: chain.id,
				preset: chain.preset,
				presetDir,
				error: errorMessage(error),
				operation,
			},
		}))
	}

	private async recordPlaceholderFinding(chain: ChainRecord, finding: PresetPlaceholderFinding): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "validation",
			type: "preset.placeholder_check",
			chain: chain.name,
			subject: { kind: "engine" },
			payload: {
				file: finding.file,
				key: finding.key,
				direction: finding.direction,
				verdict: finding.verdict,
			},
		}))
	}

	// #408 cross-table DAG checker emitter. Mirrors `recordPlaceholderFinding`'s
	// shape so the unified observability stream carries both preset-validation
	// families side-by-side. The error path additionally produces a
	// `daemon.preset_load_failed` event via `recordPresetLoadFailure`; auditors
	// looking at a deadlock see the structural finding first, then the generic
	// load-failure event with the operation context.
	private async recordDagFinding(chain: ChainRecord, finding: PresetDagFinding): Promise<void> {
		await this.recordObservabilityEventIfChainNameIsValid(chain, makeObservabilityEvent({
			kind: "validation",
			type: "preset.dag_check",
			chain: chain.name,
			subject: { kind: "engine" },
			payload: {
				kind: finding.kind,
				verdict: finding.verdict,
				table: finding.table,
				status: finding.status,
				message: finding.message,
			},
		}))
	}

	private presetDirForChain(chain: ChainRecord): string {
		// Chain-wide preset resolver — used by code paths that operate on a chain without an item
		// context (e.g. chain-complete trigger eval, listing chain-level status vocab). Per-item
		// paths (spawn, status snapshot) prefer `presetDirForItem`.
		//
		// Resolution order:
		// 1. `chain.metadata.presetPath` (explicit override carried in chain metadata).
		// 2. `chain.preset` — legacy default-seed retained for back-compat (#412 / #419 docs).
		// 3. Error: chain has no preset and no item context to derive one from.
		const presetPath = chainPresetPath(chain.metadata)
		if (presetPath !== null) return isAbsolute(presetPath) ? presetPath : resolve(presetPath)
		const legacyPreset = chain.preset
		if (legacyPreset === null) {
			throw new DaemonError(
				"invalid_request",
				`chain ${chain.name} has no preset and no items to derive one from; chain-level preset resolution requires either chains.preset (legacy) or an item context (#412 moved preset to items)`,
				{ chainId: chain.id, chainName: chain.name },
			)
		}
		if (!PRESET_NAME_PATTERN.test(legacyPreset)) {
			throw new DaemonError("invalid_request", `chain.preset: invalid name "${legacyPreset}" (must match ${PRESET_NAME_PATTERN.source})`, {
				chainId: chain.id,
				chainName: chain.name,
				preset: legacyPreset,
			})
		}
		return bundledPresetDir(legacyPreset)
	}

	private presetDirForItem(chain: ChainRecord, item: ItemRecord): string {
		// Per-item preset resolver — the post-#412 primary path. Resolution order:
		// 1. `item.presetPath` (absolute path; daemon API validates on insert).
		// 2. `item.preset` (bundled name; daemon API validates on insert).
		// 3. Fall back to chain-level resolution for legacy items still carrying null preset/presetPath
		//    (back-fill migration handles most of these; this path covers any that slipped through).
		if (item.presetPath !== null) return isAbsolute(item.presetPath) ? item.presetPath : resolve(item.presetPath)
		if (item.preset !== null) {
			if (!PRESET_NAME_PATTERN.test(item.preset)) {
				throw new DaemonError("invalid_request", `item ${item.id}: invalid preset name "${item.preset}" (must match ${PRESET_NAME_PATTERN.source})`, {
					rowId: item.id,
					itemId: item.itemId,
					preset: item.preset,
				})
			}
			return bundledPresetDir(item.preset)
		}
		return this.presetDirForChain(chain)
	}

	private loadedPresetCacheKey(presetDir: string): string {
		return isAbsolute(presetDir) ? presetDir : resolve(presetDir)
	}
}

export async function startCoderLoopDaemon(options: StartCoderLoopDaemonOptions = {}): Promise<CoderLoopDaemon> {
	return await new CoderLoopDaemon(options).start()
}

export async function sendDaemonRequest(socketPath: string, request: Omit<DaemonRequest, "args"> & { args?: JsonObject }): Promise<DaemonResponse> {
	return await new Promise((resolveResponse, reject) => {
		const socket = createConnection(socketPath)
		let buffer = ""
		const cleanup = () => {
			socket.removeAllListeners()
			socket.destroy()
		}
		socket.setEncoding("utf-8")
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ ...request, args: request.args ?? {} })}\n`)
		})
		socket.on("data", (chunk: string) => {
			buffer += chunk
			const newlineIndex = buffer.indexOf("\n")
			if (newlineIndex === -1) return
			const line = buffer.slice(0, newlineIndex)
			try {
				const response = parseDaemonResponse(line)
				cleanup()
				resolveResponse(response)
			} catch (error) {
				cleanup()
				reject(error)
			}
		})
		socket.on("error", (error) => {
			cleanup()
			reject(error)
		})
	})
}

export function daemonRequest(command: DaemonCommandName, args: JsonObject = {}): DaemonRequest {
	return { id: randomUUID(), command, args }
}

function defaultDaemonRunner(): AgentRunnerSelection {
	return {
		kind: "codex",
		source: "engine-builtin",
		binary: "codex",
		extraArgs: [],
		model: null,
	}
}

function defaultDaemonPrompt(details: { reason: string; preset?: string; phase?: string; presetDir?: string } = { reason: "missing_configured_prompt" }): string {
	const fields = [
		`reason=${details.reason}`,
		details.preset !== undefined ? `preset=${details.preset}` : null,
		details.phase !== undefined ? `phase=${details.phase}` : null,
		details.presetDir !== undefined ? `presetDir=${details.presetDir}` : null,
	].filter((entry): entry is string => entry !== null)
	return `coder-loop daemon scheduler prompt resolver failed (${fields.join(", ")}); investigate scheduler configuration or preset.`
}

function validateChainNameForRequest(input: string): string {
	try {
		const sanitized = sanitizeChainName(input)
		if (sanitized.startsWith("-")) {
			throw new DaemonError("invalid_request", "chain name must not start with hyphen", { reason: "leading_hyphen", input })
		}
		return sanitized
	} catch (error) {
		if (isInvalidChainNameError(error)) {
			throw new DaemonError("invalid_request", error.message, { reason: error.code, input: error.input })
		}
		throw error
	}
}

function isInvalidChainNameError(error: unknown): error is RuntimePathError {
	return error instanceof RuntimePathError && error.code === "invalid_chain_name"
}

// #457: only `repository` remains as an engine-side `owner/repo` field — the engine column survives
// because chain-identity check (resolveDbChainForTarget at src/loop.ts:3433-3438) and worktree-create
// mechanism (validateWorktreePrerequisites) consume it. Other GitHub-shaped owner/repo fields
// retired as engine first-class fields; a preset needing an `owner/repo` style chain binding or
// item field declares it through the generic chain `metadata.bindings` / `[item.fields]` /
// `extraPatch` paths and parses the string itself. The function used to take a field-name union
// parameter — collapsed since no other field shares the validator.
function validateRepositoryForRequest(input: string): string {
	const field = "repository" as const
	const details: JsonObject = { [field]: input }
	if (input.length > MAX_REPOSITORY_REF_LENGTH) {
		throw new DaemonError("invalid_request", `${field} must be ${MAX_REPOSITORY_REF_LENGTH} characters or fewer`, details)
	}
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, details)
	}
	if (!REPOSITORY_REF_PATTERN.test(input)) {
		throw new DaemonError("invalid_request", `${field} must use owner/repo format`, details)
	}
	const repoName = input.slice(input.indexOf("/") + 1)
	if (repoName === "." || repoName === "..") {
		throw new DaemonError("invalid_request", `${field} name must not be a reserved path segment`, details)
	}
	return input
}

function validateBaseBranchForRequest(input: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", "baseBranch must not contain control characters", { baseBranch: input })
	}
	if (input.includes("@{")) {
		throw new DaemonError("invalid_request", "baseBranch must be a literal branch name, not checkout shorthand", { baseBranch: input })
	}

	const check = Bun.spawnSync({ cmd: ["git", "check-ref-format", "--branch", input], stdout: "pipe", stderr: "pipe" })
	if (check.exitCode !== 0) {
		throw new DaemonError("invalid_request", "baseBranch must be a valid git branch name", { baseBranch: input })
	}
	return input
}

function validateItemTitleForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	if (value.length > MAX_ITEM_TITLE_LENGTH) {
		throw new DaemonError("invalid_request", `title must be ${MAX_ITEM_TITLE_LENGTH} characters or fewer`, { title: value })
	}
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw new DaemonError("invalid_request", "title must not contain control characters", { title: value })
	}
	return value
}

function validateItemPriorityForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	if (!(ITEM_PRIORITY_VALUES as readonly string[]).includes(value)) {
		throw new DaemonError("invalid_request", `priority must be one of: ${ITEM_PRIORITY_VALUES.join(", ")}, or null`, { priority: value })
	}
	return value
}

function validateItemBranchForRequest(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value
	validateGitBranchNameForRequest(value, "branch")
	return value
}

// #419: shape validation for the wire-level opaque item id. Rejects empty / whitespace-bearing
// values. Identity uniqueness is enforced by the SQLite `UNIQUE (chain_id, item_id)` constraint
// (translated by `translateCreateItemFailure` into a `duplicate_item` DaemonError surface).
const MAX_ITEM_ID_LENGTH = 256
function validateItemId(value: string): string {
	if (value === "") throw new DaemonError("invalid_request", "itemId must be a non-empty string", { field: "itemId" })
	if (/\s/.test(value)) throw new DaemonError("invalid_request", "itemId must not contain whitespace", { field: "itemId", value })
	if (value.length > MAX_ITEM_ID_LENGTH) throw new DaemonError("invalid_request", `itemId length ${value.length} exceeds ${MAX_ITEM_ID_LENGTH} characters`, { field: "itemId" })
	return value
}

function validateGitBranchNameForRequest(input: string, field: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(input)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, { [field]: input })
	}
	if (input.includes("@{")) {
		throw new DaemonError("invalid_request", `${field} must be a literal branch name, not checkout shorthand`, { [field]: input })
	}

	const check = Bun.spawnSync({ cmd: ["git", "check-ref-format", "--branch", input], stdout: "pipe", stderr: "pipe" })
	if (check.exitCode !== 0) {
		throw new DaemonError("invalid_request", `${field} must be a valid git branch name`, { [field]: input })
	}
	return input
}

function validateItemPrForRequest(value: number | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value
	if (value < 1) {
		throw new DaemonError("invalid_request", "pr must be a positive integer or null", { pr: value })
	}
	return value
}

function validateRelativeItemPathForRequest(value: string | null | undefined, field: "issueFile" | "evidenceDir"): string | null | undefined {
	if (value === undefined || value === null) return value
	validateItemPathText(value, field)
	if (isAbsolute(value)) throw new DaemonError("invalid_request", `${field} must be a relative path`, { [field]: value })
	if (hasParentPathSegment(value)) throw new DaemonError("invalid_request", `${field} must not contain parent path segments`, { [field]: value })
	return value
}

function validateEvidenceDirForRequest(value: string | null | undefined, chain: ChainRecord, loopDataRoot: string): string | null | undefined {
	if (value === undefined || value === null) return value
	validateItemPathText(value, "evidenceDir")
	if (!isAbsolute(value)) return validateRelativeItemPathForRequest(value, "evidenceDir")

	const chainRoot = resolveChainRuntimePaths(chain.name, { loopDataRoot }).chainRoot
	const resolved = resolve(value)
	if (!isPathInsideOrEqual(chainRoot, resolved)) {
		throw new DaemonError("invalid_request", "evidenceDir absolute path must stay under the chain root", {
			evidenceDir: value,
			chainRoot,
		})
	}
	return value
}

function validateItemPathText(value: string, field: "issueFile" | "evidenceDir"): void {
	if (value === "") throw new DaemonError("invalid_request", `${field} must not be empty`, { [field]: value })
	if (value.length > MAX_REPO_CWD_LENGTH) {
		throw new DaemonError("invalid_request", `${field} must be ${MAX_REPO_CWD_LENGTH} characters or fewer`, { [field]: value })
	}
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw new DaemonError("invalid_request", `${field} must not contain control characters`, { [field]: value })
	}
}

function hasParentPathSegment(value: string): boolean {
	return value.split(/[\\/]+/u).some((segment) => segment === "..")
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate)
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function formatDaemonBatchTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace(/[T:]/g, "-")
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

async function terminateStaleProcessGroup(pid: number, forceAfterMs: number): Promise<void> {
	if (pid === process.pid) return
	const termSent = sendSignalToPidOrGroup(pid, "SIGTERM")
	if (!termSent) return
	await delay(forceAfterMs)
	if (isPidOrGroupAlive(pid)) sendSignalToPidOrGroup(pid, "SIGKILL")
}

function sendSignalToPidOrGroup(pid: number, signal: NodeJS.Signals): boolean {
	if (process.platform !== "win32") {
		if (canSignalStoredProcessGroup(pid)) {
			try {
				process.kill(-pid, signal)
				return true
			} catch (error) {
				if (!isNoSuchProcessError(error)) return true
			}
		}
	}
	try {
		process.kill(pid, signal)
		return true
	} catch (error) {
		return !isNoSuchProcessError(error)
	}
}

function canSignalStoredProcessGroup(pid: number): boolean {
	const currentGroup = readProcessGroupId(process.pid)
	const targetGroup = readProcessGroupId(pid)
	if (currentGroup !== null && currentGroup === pid) return false
	if (targetGroup !== null && targetGroup !== pid) return false
	if (currentGroup !== null && targetGroup !== null && currentGroup === targetGroup) return false
	return true
}

function readProcessGroupId(pid: number): number | null {
	const result = Bun.spawnSync({ cmd: ["ps", "-o", "pgid=", "-p", String(pid)], stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0) return null
	const raw = new TextDecoder().decode(result.stdout).trim()
	const value = Number(raw)
	return Number.isSafeInteger(value) && value > 0 ? value : null
}

function isPidOrGroupAlive(pid: number): boolean {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, 0)
			return true
		} catch (error) {
			if (!isNoSuchProcessError(error)) return true
		}
	}
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return !isNoSuchProcessError(error)
	}
}

function isNoSuchProcessError(error: unknown): boolean {
	return isNodeError(error) && error.code === "ESRCH"
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeOversizedRequestResponse(socket: Socket, actualBytes: number): void {
	const response: DaemonResponse = {
		id: "unknown",
		ok: false,
		error: {
			code: "request_too_large",
			message: `request line must be ${MAX_DAEMON_REQUEST_BYTES} bytes or fewer`,
			details: {
				limitBytes: MAX_DAEMON_REQUEST_BYTES,
				actualBytes,
			},
		},
	}
	socket.write(`${JSON.stringify(response)}\n`, () => {
		socket.end()
	})
}

function validateRequestLineSize(line: string): void {
	const actualBytes = byteLength(line)
	if (actualBytes > MAX_DAEMON_REQUEST_BYTES) {
		throw new DaemonError("request_too_large", `request line must be ${MAX_DAEMON_REQUEST_BYTES} bytes or fewer`, {
			limitBytes: MAX_DAEMON_REQUEST_BYTES,
			actualBytes,
		})
	}
}

function byteLength(input: string): number {
	return Buffer.byteLength(input, "utf8")
}

function parseDaemonRequest(line: string): DaemonRequest {
	const parsed = parseJsonRecord(line)
	const id = requiredString(parsed, "id")
	const command = requiredString(parsed, "command")
	const args = optionalJsonObject(parsed, "args") ?? {}
	return { id, command, args }
}

function parseDaemonResponse(line: string): DaemonResponse {
	const parsed = parseJsonRecord(line)
	const id = requiredString(parsed, "id")
	const ok = requiredBoolean(parsed, "ok")
	if (ok) return { id, ok: true, result: optionalJsonObject(parsed, "result") ?? {} }
	const errorRecord = requiredRecord(parsed, "error")
	const error: DaemonResponseError = {
		code: requiredString(errorRecord, "code"),
		message: requiredString(errorRecord, "message"),
	}
	const details = optionalJsonObject(errorRecord, "details")
	if (details !== undefined) error.details = details
	return {
		id,
		ok: false,
		error,
	}
}

function parseJsonRecord(line: string): UnknownRecord {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new DaemonError("invalid_json", `invalid JSON request: ${errorMessage(error)}`)
	}
	if (!isRecord(parsed)) throw new DaemonError("invalid_request", "message must be a JSON object")
	return parsed
}

function responseError(error: unknown): DaemonResponseError {
	if (error instanceof DaemonError) return { code: error.code, message: error.message, details: error.details }
	return { code: "internal_error", message: errorMessage(error) }
}

function requiredString(record: UnknownRecord, key: string): string {
	const value = record[key]
	if (typeof value !== "string" || value === "") throw new DaemonError("invalid_request", `${key} must be a non-empty string`)
	return value
}

function optionalString(record: UnknownRecord, key: string): string | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "string" || value === "") throw new DaemonError("invalid_request", `${key} must be a non-empty string when provided`)
	return value
}

function optionalStringOrNull(record: UnknownRecord, key: string): string | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (typeof value !== "string") {
		throw new DaemonError("invalid_request", `${key} must be a string or null when provided`, {
			field: key,
			value: toJsonValue(value),
		})
	}
	return value
}

function requiredInteger(record: UnknownRecord, key: string): number {
	const value = record[key]
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer`)
	return value
}

function requiredPositiveInteger(record: UnknownRecord, key: string): number {
	const value = requiredInteger(record, key)
	if (value < 1) throw new DaemonError("invalid_request", `${key} must be a positive integer`)
	return value
}

function optionalInteger(record: UnknownRecord, key: string): number | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer when provided`)
	return value
}

function optionalPositiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function optionalIntegerOrNull(record: UnknownRecord, key: string): number | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (typeof value !== "number" || !Number.isInteger(value)) throw new DaemonError("invalid_request", `${key} must be an integer or null when provided`)
	return value
}

function requiredBoolean(record: UnknownRecord, key: string): boolean {
	const value = record[key]
	if (typeof value !== "boolean") throw new DaemonError("invalid_request", `${key} must be a boolean`)
	return value
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | null {
	const value = record[key]
	if (value === undefined) return null
	if (typeof value !== "boolean") throw new DaemonError("invalid_request", `${key} must be a boolean when provided`)
	return value
}

function requiredRecord(record: UnknownRecord, key: string): UnknownRecord {
	const value = record[key]
	if (!isRecord(value)) throw new DaemonError("invalid_request", `${key} must be a JSON object`)
	return value
}

function optionalJsonObject(record: UnknownRecord, key: string): JsonObject | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (!isRecord(value) || !isJsonObject(value)) throw new DaemonError("invalid_request", `${key} must be a JSON object when provided`)
	return value
}

function sizedJsonObject(record: UnknownRecord, key: string, limitBytes: number): JsonObject | undefined {
	const value = optionalJsonObject(record, key)
	if (value === undefined) return undefined
	const actualBytes = byteLength(JSON.stringify(value))
	if (actualBytes > limitBytes) {
		throw new DaemonError("request_too_large", `${key} must be ${limitBytes} bytes or fewer`, {
			field: key,
			limitBytes,
			actualBytes,
		})
	}
	return value
}

function validateChainMetadata(metadata: JsonObject): ReturnType<typeof parseChainMetadataForRequest> {
	validateJsonObjectSafety(metadata, "metadata", MAX_CHAIN_METADATA_DEPTH, "metadata")
	return parseRuntimeData(() => parseChainMetadataForRequest(metadata, "metadata"))
}

function validateItemExtra(extra: JsonObject): ItemExtra {
	validateJsonObjectSafety(extra, "extra", MAX_ITEM_EXTRA_DEPTH, "extra")
	return parseRuntimeData(() => parseItemExtraForRequest(extra, "extra"))
}


function validateJsonObjectSafety(value: JsonValue, path: string, maxDepth: number, label: string, depth = 0): void {
	if (depth > maxDepth) {
		throw new DaemonError("invalid_request", `${label} nesting depth must be ${maxDepth} or fewer`, {
			field: path,
			maxDepth,
			actualDepth: depth,
		})
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => validateJsonObjectSafety(item, `${path}[${index}]`, maxDepth, label, depth + 1))
		return
	}
	if (!isJsonObjectValue(value)) return

	for (const [key, child] of Object.entries(value)) {
		const field = key === "" ? `${path}.<empty>` : `${path}.${key}`
		if (key === "") {
			throw new DaemonError("invalid_request", `${label} key must not be empty string`, { field })
		}
		if (RESERVED_METADATA_KEYS.has(key)) {
			throw new DaemonError("invalid_request", `${label} key not allowed: ${key}`, { field })
		}
		validateJsonObjectSafety(child, field, maxDepth, label, depth + 1)
	}
}

function validateKnownKeys(record: UnknownRecord, label: string, allowedKeys: readonly string[]): void {
	const allowed = new Set(allowedKeys)
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) {
			throw new DaemonError("invalid_request", `${label} contains unsupported field: ${key}`, {
				field: key,
				allowed: [...allowedKeys],
			})
		}
	}
}

function validateItemAddRequest(args: JsonObject): void {
	validateKnownKeys(args, "item.add args", ITEM_ADD_ARG_KEYS)
}

function validateItemBatchAddRequest(args: JsonObject): void {
	validateKnownKeys(args, "item.batchAdd args", ITEM_BATCH_ADD_ARG_KEYS)
}

function validateItemUpdateRequest(args: JsonObject): void {
	// #406 boundary parse step 1: top-level known-keys gate. `validateKnownKeys` rejects
	// `agentRunId` / `agentPhase` (they are not in `ITEM_UPDATE_ARG_KEYS` since #406 retired the
	// free-claim attribution surface). This is the only layer that produces an "unsupported field"
	// rejection for the retired keys — the deeper caller-admission gate cannot observe them.
	validateKnownKeys(args, "item.update args", ITEM_UPDATE_ARG_KEYS)
	validateItemUpdateSelector(args)
	const nestedFields = optionalJsonObject(args, "fields")
	if (nestedFields !== undefined) {
		validateKnownKeys(nestedFields, "item.update fields", ITEM_UPDATE_FIELD_KEYS)
		for (const key of ITEM_UPDATE_FIELD_KEYS) {
			if (Object.hasOwn(args, key)) {
				throw new DaemonError("invalid_request", `item.update args cannot mix top-level update field with fields object: ${key}`, { field: key })
			}
		}
	}
	const fields = itemUpdateFields(args)
	if (Object.keys(fields).length === 0) throw new DaemonError("invalid_request", "item.update requires at least one field to update")
}

function validateItemUpdateSelector(args: JsonObject): void {
	// #419: `itemId` accepts either a numeric rowid (legacy / engine internal) or the opaque
	// preset-declared string id. When the caller passes a rowid we still reject duplicate chain
	// selectors (rowid is globally unique; chain coords are redundant). When the caller passes a
	// string the chain selector remains required (string ids are per-chain unique, not global).
	const rawItemId = args["itemId"]
	const isNumericItemId = typeof rawItemId === "number" && Number.isInteger(rawItemId) && rawItemId > 0
	if (!isNumericItemId) return
	for (const key of ["chainId", "chainName", "name"] as const) {
		if (Object.hasOwn(args, key)) {
			throw new DaemonError("invalid_request", `item.update with rowid itemId must not include selector field ${key}`, { field: key })
		}
	}
}

function itemUpdateFields(args: JsonObject): JsonObject {
	const nestedFields = optionalJsonObject(args, "fields")
	if (nestedFields !== undefined) return nestedFields
	const fields: JsonObject = {}
	for (const key of ITEM_UPDATE_FIELD_KEYS) {
		if (Object.hasOwn(args, key)) {
			const value = args[key]
			if (value === undefined) throw new DaemonError("invalid_request", `item.update field ${key} must be a JSON value`, { field: key })
			fields[key] = value
		}
	}
	return fields
}

// #410 carrier-aware view of a single requested item-update field. The gate cares about three
// things per field: (1) the top-level field name in the engine vocabulary (always set), (2) the
// inner extra keys when the carrier is `extra`/`extraPatch` (so the matrix gates each key
// individually instead of pretending the wrapper is the unit), and (3) the carrier itself
// (so the renderer can name the carrier in the requested field set). The expanded inner keys
// are *separate from* the top-level field — both are surfaced to the gate so the deny message
// can name the actual key the agent attempted to write (e.g. "blockerRepo") rather than the
// generic carrier "extra".
type ItemUpdateRequestedFields = {
	topLevel: ReadonlySet<ItemUpdateFieldName>
	innerKeys: ReadonlySet<string>
	all: ReadonlySet<string>
}

// Collect the set of fields the request is attempting to write. `extra` and `extraPatch` carriers
// are expanded one level — each top-level inner key in the wrapper joins the set the matrix
// gates. Nested objects inside extra (e.g. `extra.dependsOn = [42]`) surface as the inner key
// name (`dependsOn`), not a recursive walk; the gate runs the classifier on each name and treats
// `dependsOn` as control-plane regardless of carrier (the existing top-level extraction in
// `handleItemUpdate` lifts it to the dependsOn field for graph validation, so the policy is
// uniform). The wrapper (`extra` / `extraPatch`) is also recorded as a top-level field so the
// audit trail surfaces it; on its own the wrapper is not classified — only its inner keys are.
function collectItemUpdateFieldKeys(fields: JsonObject): ItemUpdateRequestedFields {
	const topLevel = new Set<ItemUpdateFieldName>()
	const innerKeys = new Set<string>()
	const all = new Set<string>()
	for (const key of ITEM_UPDATE_FIELD_KEYS) {
		if (!Object.hasOwn(fields, key)) continue
		topLevel.add(key)
		all.add(key)
		if (key === "extra" || key === "extraPatch") {
			const value = fields[key]
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				for (const innerKey of Object.keys(value)) {
					innerKeys.add(innerKey)
					all.add(innerKey)
				}
			}
		}
	}
	return { topLevel, innerKeys, all }
}

// #410 the matrix verdict — exhaustive on the requested field set against the phase rights.
type ItemUpdateFieldWriteVerdict =
	| { kind: "allow"; reason: "agent-allowed"; granted: ReadonlySet<string> }
	| { kind: "deny"; reason: "no-rights-segment" | "field-not-granted" | "control-plane-denied"; granted: ReadonlySet<string>; denied: ReadonlySet<string> }

// Judge the requested field set in one pass. Status is delegated to the existing #397 admission
// gate so we ignore it here. Aggregate wrappers (`extra` / `extraPatch`) are not themselves
// gated — their grant is decided per inner key (which we already collected). Control-plane
// fields anywhere in the requested set short-circuit to `control-plane-denied` (no preset
// surface can recover this — it is structurally distinct from `field-not-granted`).
function judgeItemUpdateFieldWrites(
	requested: ItemUpdateRequestedFields,
	rights: PresetPhaseRights,
): ItemUpdateFieldWriteVerdict {
	// Short-circuit: an empty rights segment (default-deny shape from a missing or all-default
	// `[phases.rights]`) is the same audit shape as #407's `no-rights-segment` — distinct from
	// `field-not-granted` for audit query grouping. A request with only the `status` field
	// would still leave the requested set empty (status is delegated upstream) — in that case
	// allow trivially even on an empty rights segment, since the gate has nothing to judge.
	const gatedFields = new Set<string>()
	const granted = new Set<string>()
	const deniedPassthrough = new Set<string>()
	const deniedControlPlane = new Set<string>()
	for (const field of requested.topLevel) {
		const classification = classifyItemUpdateField(field)
		switch (classification.kind) {
			case "status":
				// Delegated to #397's admission gate; not classified here.
				continue
			case "control-plane":
				gatedFields.add(field)
				deniedControlPlane.add(field)
				break
			case "passthrough":
				gatedFields.add(field)
				if (rights.writableFields.has(field)) {
					granted.add(field)
				} else {
					deniedPassthrough.add(field)
				}
				break
			case "aggregate":
				// The wrapper itself is not gated — its inner keys are gated below. If the
				// wrapper appears with no inner keys (e.g. `extra: {}`), nothing to gate;
				// proceed without contributing to either set.
				break
			default:
				return assertNeverItemUpdateClassification(classification)
		}
	}
	// Inner keys (from `extra` / `extraPatch`). `dependsOn` short-circuits to control-plane
	// regardless of carrier — the existing `handleItemUpdate` flatten path lifts
	// `extra.dependsOn` to the top-level dependsOn field for graph validation.
	for (const innerKey of requested.innerKeys) {
		gatedFields.add(innerKey)
		if (PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELD_SET.has(innerKey)) {
			deniedControlPlane.add(innerKey)
			continue
		}
		if (rights.writableFields.has(innerKey)) {
			granted.add(innerKey)
		} else {
			deniedPassthrough.add(innerKey)
		}
	}
	if (gatedFields.size === 0) {
		// Nothing to judge (e.g. status-only update). Allow without consulting rights.
		return { kind: "allow", reason: "agent-allowed", granted: new Set() }
	}
	if (deniedControlPlane.size > 0) {
		// Control-plane denial dominates — it's structurally non-recoverable by preset config,
		// so surface it as the primary deny reason even when passthrough denials are also present.
		const allDenied = new Set<string>([...deniedControlPlane, ...deniedPassthrough])
		return { kind: "deny", reason: "control-plane-denied", granted, denied: allDenied }
	}
	if (deniedPassthrough.size > 0) {
		// Distinguish `no-rights-segment` (rights are all default-deny shape — preset author
		// didn't declare any writable fields for this phase) from `field-not-granted` (preset
		// declared some fields but not the requested one). Mirrors #407's two-reason split.
		const reason: "no-rights-segment" | "field-not-granted" =
			rights.writableFields.size === 0 && !rights.createItems && rights.privilegedOps.size === 0
				? "no-rights-segment"
				: "field-not-granted"
		return { kind: "deny", reason, granted, denied: deniedPassthrough }
	}
	return { kind: "allow", reason: "agent-allowed", granted }
}

function assertNeverItemUpdateClassification(value: never): never {
	throw new DaemonError("internal_error", `unhandled item.update field classification: ${JSON.stringify(value)}`, {})
}

function requestedChainName(args: JsonObject): string | null {
	const chainName = optionalString(args, "chainName")
	const name = optionalString(args, "name")
	if (chainName !== null && name !== null && chainName !== name) {
		throw new DaemonError("invalid_request", "chainName and name both provided but differ", { chainName, name })
	}
	return chainName ?? name
}

function requiredJsonObjectArray(record: UnknownRecord, key: string): JsonObject[] {
	const value = record[key]
	if (!Array.isArray(value)) throw new DaemonError("invalid_request", `${key} must be an array of item objects`, { field: key })
	return value.map((entry, index) => {
		if (!isRecord(entry) || !isJsonObject(entry)) throw new DaemonError("invalid_request", `${key}[${index}] must be an item object`, { field: `${key}[${index}]` })
		return entry
	})
}

function optionalDependsOn(record: UnknownRecord, key: string): number[] | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (!Array.isArray(value)) throw new DaemonError("invalid_request", `${key} must be an array of positive item ids or null when provided`)
	return value.map((entry, index) => {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
			throw new DaemonError("invalid_request", `${key}[${index}] must be a positive item id`, { index, value: toJsonValue(entry) })
		}
		return entry
	})
}

function optionalRunner(record: UnknownRecord, key: string): AgentRunnerKind | null | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (value === null) return null
	if (value !== "claude" && value !== "codex") throw new DaemonError("invalid_request", `${key} must be claude, codex, or null`)
	return value
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) target[key] = value
}

async function validateRepoCwdForRequest(input: string): Promise<string> {
	if (input.length > MAX_REPO_CWD_LENGTH) throw new DaemonError("invalid_request", `repoCwd must be ${MAX_REPO_CWD_LENGTH} characters or fewer`)
	if (!isAbsolute(input)) throw new DaemonError("invalid_request", "repoCwd must be an absolute path", { repoCwd: input })
	if (/[\u0000-\u001f\u007f]/u.test(input)) throw new DaemonError("invalid_request", "repoCwd must not contain control characters", { repoCwd: input })
	let pathStat: Awaited<ReturnType<typeof stat>>
	try {
		pathStat = await stat(input)
	} catch (error) {
		throw new DaemonError("invalid_request", `repoCwd must exist and be a directory: ${errorMessage(error)}`, { repoCwd: input })
	}
	if (!pathStat.isDirectory()) throw new DaemonError("invalid_request", "repoCwd must be a directory", { repoCwd: input })
	return input
}

async function validateBundledPresetForRequest(input: string): Promise<string> {
	if (!PRESET_NAME_PATTERN.test(input)) {
		throw new DaemonError("invalid_request", `preset must match ${PRESET_NAME_PATTERN.source}`, { preset: input })
	}
	const presetFile = resolve(bundledPresetDir(input), "preset.toml")
	try {
		const presetStat = await stat(presetFile)
		if (!presetStat.isFile()) {
			throw new DaemonError("invalid_request", `unknown preset: ${input}`, { preset: input })
		}
	} catch (error) {
		if (error instanceof DaemonError) throw error
		throw new DaemonError("invalid_request", `unknown preset: ${input}`, { preset: input })
	}
	return input
}

// #412 item-level presetPath: must be an absolute path to a directory containing preset.toml.
// Relative paths are rejected to avoid ambiguity about the resolution base — items live in the
// central DB and may be read from any working directory.
async function validateItemPresetPathForRequest(input: string): Promise<string> {
	if (!isAbsolute(input)) throw new DaemonError("invalid_request", "presetPath must be an absolute path", { presetPath: input })
	if (PRESET_PATH_CONTROL_CHAR_REGEX.test(input)) throw new DaemonError("invalid_request", "presetPath must not contain control characters", { presetPath: input })
	const presetFile = resolve(input, "preset.toml")
	try {
		const presetStat = await stat(presetFile)
		if (!presetStat.isFile()) {
			throw new DaemonError("invalid_request", `presetPath does not contain a preset.toml: ${input}`, { presetPath: input })
		}
	} catch (error) {
		if (error instanceof DaemonError) throw error
		throw new DaemonError("invalid_request", `presetPath is not loadable: ${input}`, { presetPath: input, error: errorMessage(error) })
	}
	return input
}

function bundledPresetDir(presetName: string): string {
	return resolve(BUNDLED_PRESETS_DIR, presetName)
}

async function loadSchedulerPresetFromDir(presetDir: string, options: LoadPresetOptions = {}): Promise<SchedulerLoadedPreset> {
	return { presetDir, preset: await loadPreset(presetDir, options) }
}

function assertNeverSchedulerEvent(event: never): never {
	throw new DaemonError("internal_error", `unhandled scheduler event: ${JSON.stringify(event)}`)
}

function validateDependsOnGraph(items: readonly ItemRecord[], itemId: number | null, dependsOn: readonly number[] | null): void {
	if (dependsOn === null) return
	const byId = new Map(items.map((item) => [item.id, item]))
	for (const dependencyId of dependsOn) {
		if (!byId.has(dependencyId)) throw new DaemonError("invalid_request", `dependsOn references unknown item ${dependencyId}`, { itemId: itemId ?? null, dependsOn: [...dependsOn] })
	}
	if (itemId === null) return

	const visit = (candidateId: number, path: number[]): void => {
		if (candidateId === itemId) {
			throw new DaemonError("invalid_request", `dependsOn would create a dependency cycle through item ${itemId}`, { itemId, path: [...path, candidateId] })
		}
		if (path.includes(candidateId)) return
		const candidate = byId.get(candidateId)
		if (candidate === undefined) return
		for (const nextId of dependsOnFromStoredExtra(candidate.extra)) visit(nextId, [...path, candidateId])
	}

	for (const dependencyId of dependsOn) visit(dependencyId, [])
}

function dependsOnFromStoredExtra(extra: ItemExtra): number[] {
	return itemDependsOnIds(extra)
}

function withDependsOn(extra: JsonObject, dependsOn: readonly number[] | null | undefined): JsonObject {
	if (dependsOn === undefined) return extra
	const next: JsonObject = { ...extra }
	if (dependsOn === null) {
		delete next.dependsOn
	} else {
		next.dependsOn = [...dependsOn]
	}
	return next
}

function parseRuntimeData<T>(parse: () => T): T {
	try {
		return parse()
	} catch (error) {
		if (error instanceof RuntimeDataError) {
			throw new DaemonError("invalid_request", error.message, {
				field: error.issue.field,
				value: error.issue.value,
			})
		}
		throw error
	}
}

function toJsonValue(value: unknown): JsonValue {
	return runtimeDataJsonValue(value)
}

function chainCreateConflicts(existing: ChainRecord, requested: CreateChainInput): JsonObject[] {
	const conflicts: JsonObject[] = []
	const addConflict = (field: string, existingValue: JsonValue, requestedValue: JsonValue): void => {
		if (jsonValuesEqual(existingValue, requestedValue)) return
		conflicts.push({ field, existing: existingValue, requested: requestedValue })
	}

	// `requested.preset` may be undefined since #412 made the chain-level preset optional; treat absent
	// as explicit-null so the conflict comparison is well-defined.
	addConflict("preset", existing.preset, requested.preset ?? null)
	addConflict("repository", existing.repository, requested.repository)
	addConflict("baseBranch", existing.baseBranch, requested.baseBranch)
	addConflict("status", existing.status, requested.status ?? "active")

	const existingMetadata = chainMetadataToJsonObject(existing.metadata)
	const requestedMetadata = requested.metadata === undefined ? {} : chainMetadataToJsonObject(requested.metadata)
	for (const [key, requestedValue] of Object.entries(requestedMetadata)) {
		const existingHasKey = Object.hasOwn(existingMetadata, key)
		const existingValue = existingMetadata[key]
		if (existingHasKey && jsonValuesEqual(existingValue, requestedValue)) continue
		conflicts.push({
			field: `metadata.${key}`,
			existing: existingHasKey && existingValue !== undefined ? existingValue : null,
			existingPresent: existingHasKey,
			requested: requestedValue,
		})
	}

	return conflicts
}

// #419: now keys on the opaque preset-declared `itemId` string (formerly `issueNumber`
// integer). `existingItemId` continues to surface the existing row's rowid so callers can
// route by it; the new `itemId` payload field holds the conflicting opaque id.
function duplicateItemAddError(chain: ChainRecord, itemId: string, existing: ItemRecord): DaemonError {
	return new DaemonError("conflict", `item with id ${itemId} already exists in chain ${chain.name}`, {
		chainId: chain.id,
		chainName: chain.name,
		itemId,
		existingItemId: existing.id,
	})
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((value, index) => jsonValuesEqual(value, right[index]))
	}
	if (isJsonObjectValue(left) || isJsonObjectValue(right)) {
		if (!isJsonObjectValue(left) || !isJsonObjectValue(right)) return false
		const leftKeys = Object.keys(left).sort()
		const rightKeys = Object.keys(right).sort()
		if (leftKeys.length !== rightKeys.length) return false
		return leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]))
	}
	return false
}

function daemonSnapshotToJson(snapshot: CoderLoopDaemonSnapshot): JsonObject {
	return {
		pid: snapshot.pid,
		socketPath: snapshot.socketPath,
		pidFile: snapshot.pidFile,
		running: snapshot.running,
		shuttingDown: snapshot.shuttingDown,
		schedulerEnabled: snapshot.schedulerEnabled,
		activeRuns: snapshot.activeRuns,
	}
}

function schedulerWorktreeCleanupsToJson(worktrees: readonly SchedulerChainWorktreeCleanup[]): JsonValue {
	return worktrees.map((worktree): JsonObject => ({
		repoCwd: worktree.repoCwd,
		worktreePath: worktree.worktreePath,
		registered: worktree.registered,
		removed: worktree.removed,
		directoryRemoved: worktree.directoryRemoved,
		pruned: worktree.pruned,
		error: worktree.error,
	}))
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(value: UnknownRecord): value is JsonObject {
	return Object.values(value).every(isJsonValue)
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (isRecord(value)) return Object.values(value).every(isJsonValue)
	return false
}

// #405: parse the request's `action` field against the engine's chain-action
// vocabulary at the boundary. The handler then re-checks against the phase's
// declared chain-action exits as a second leg (vocabulary + per-phase admission,
// same shape as #397's status admission).
function parseChainActionFromRequest(args: JsonObject): PresetPhaseChainAction {
	const raw = requiredString(args, "action")
	const found = PRESET_PHASE_CHAIN_ACTIONS.find((action) => action === raw)
	if (found === undefined) {
		throw new DaemonError("invalid_request", `item.exitAction: action must be one of: ${PRESET_PHASE_CHAIN_ACTIONS.join(", ")}; got: ${raw}`, { action: raw })
	}
	return found
}

// #405 exhaustiveness guards: forces consumers to update every site when the
// `PresetPhaseExit` / `PresetPhaseChainAction` ADTs gain a new branch.
function assertNeverPhaseExitInDaemon(value: never): never {
	throw new DaemonError("internal_error", `unhandled phase-exit kind: ${JSON.stringify(value)}`)
}

// #405: project the typed `PresetPhaseExit` ADT to a JsonValue wire-shape entry.
// The explicit JsonObject return type prevents TS from inferring the inferred
// union-shape with `action?: undefined` / `status?: undefined` discriminators that
// JsonValue rejects (the test `InternalStatus type branding` checks this).
function phaseExitToJsonValue(exit: { kind: "item-status"; status: string; when: string } | { kind: "chain-action"; action: "stop"; when: string }): JsonObject {
	switch (exit.kind) {
		case "item-status":
			return { kind: "item-status", status: exit.status, when: exit.when }
		case "chain-action":
			return { kind: "chain-action", action: exit.action, when: exit.when }
		default:
			return assertNeverPhaseExitInDaemon(exit)
	}
}

function assertNeverChainAction(value: never): never {
	throw new DaemonError("internal_error", `unhandled chain-action: ${JSON.stringify(value)}`)
}

// #409 dispatch helpers — sit at module level so `handleRequest` and
// `runAuthorizationGate` can share the closed enumeration of command names
// (`DAEMON_COMMAND_NAMES`) and the auth-class assertNever. The
// `DaemonCommandSpec` shape ties each `DaemonCommandName` to its auth class
// and handler; the `Record<DaemonCommandName, DaemonCommandSpec>` type on
// `commandSpecs` is the compile-time gate that prevents adding a new command
// without classifying it.
type DaemonCommandSpec = {
	readonly authClass: DaemonCommandAuthClass
	readonly handler: (args: JsonObject) => Promise<JsonObject>
}

const DAEMON_COMMAND_NAMES = [
	"chain.create",
	"chain.list",
	"chain.status",
	"chain.stop",
	"chain.resume",
	"chain.delete",
	"item.add",
	"item.batchAdd",
	"item.list",
	"item.update",
	"item.reorder",
	"item.exits",
	"item.exitAction",
	"daemon.status",
	"daemon.down",
	"logs.query",
	"queue.unblock",
] as const

// Compile-time bidirectional subset check: `DAEMON_COMMAND_NAMES` must enumerate exactly the
// `DaemonCommandName` union — no missing entries, no extras. The two `satisfies`-style
// assignments below break the build the moment one side drifts from the other.
const _DAEMON_COMMAND_NAMES_COVERS_UNION: readonly DaemonCommandName[] = DAEMON_COMMAND_NAMES
type _DaemonCommandNamesTuple = typeof DAEMON_COMMAND_NAMES[number]
const _DAEMON_COMMAND_NAMES_NO_EXTRAS: DaemonCommandName = "chain.create" satisfies _DaemonCommandNamesTuple
void _DAEMON_COMMAND_NAMES_COVERS_UNION
void _DAEMON_COMMAND_NAMES_NO_EXTRAS

function narrowDaemonCommandName(value: string): DaemonCommandName | null {
	const found = DAEMON_COMMAND_NAMES.find((name) => name === value)
	return found ?? null
}

// #409 narrow the engine's `DaemonCommandName` to the `PrivilegedOpAuditOp` boundary union
// declared in observability.ts. The latter is a strict subset (only gated ops appear) — a
// command that does not flow through the gate is intentionally absent from the audit
// vocabulary. Returns null when the command never goes through the gate (caller treats this
// as a structural unreachable branch).
// #409 narrow from the broader audit-vocabulary union to the preset's grantable subset.
// `PresetPhasePrivilegedOp` is what `PresetPhaseRights.privilegedOps` actually stores; the
// audit union is wider because it also names hard-deny ops (those have no grantable form).
function narrowPresetPhasePrivilegedOpFromAudit(op: PrivilegedOpAuditOp): PresetPhasePrivilegedOp | null {
	const found = PRESET_PHASE_PRIVILEGED_OPS.find((entry) => entry === op)
	return found ?? null
}

function narrowPrivilegedOpAuditOp(op: DaemonCommandName): PrivilegedOpAuditOp | null {
	switch (op) {
		case "chain.create":
		case "chain.stop":
		case "chain.resume":
		case "chain.delete":
		case "daemon.down":
		case "logs.query":
		case "queue.unblock":
		case "item.reorder":
			return op
		case "chain.list":
		case "chain.status":
		case "item.add":
		case "item.batchAdd":
		case "item.list":
		case "item.update":
		case "item.exits":
		case "item.exitAction":
		case "daemon.status":
			return null
		default:
			return assertNeverDaemonCommand(op)
	}
}

function assertNeverDaemonCommand(value: never): never {
	throw new DaemonError("internal_error", `unhandled daemon command: ${JSON.stringify(value)}`)
}

function assertNeverDaemonCommandAuthClass(value: never): never {
	throw new DaemonError("internal_error", `unhandled daemon command auth class: ${JSON.stringify(value)}`)
}

function chainToJson(chain: ChainRecord): JsonObject {
	return {
		id: chain.id,
		name: chain.name,
		preset: chain.preset,
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		status: chain.status,
		metadata: chainMetadataToJsonObject(chain.metadata),
		createdAt: chain.createdAt,
		updatedAt: chain.updatedAt,
	}
}

function itemToJson(item: ItemRecord, dependencyWait?: DependencyWaitReason | null): JsonObject {
	// #419: wire schema retires top-level `issueNumber` (int), `branch`, `pr`. The opaque
	// preset-declared identity surfaces as `itemId` (string); the rowid stays on `id` (int).
	// Supervisors that wanted branch/pr previously read them as first-class fields now read
	// them off `extra` (gh-issue-pr-iteration declares both in `[item.fields]`, so they
	// continue to round-trip through `extra.branch` / `extra.pr`). Breaking wire change —
	// PR body enumerates the shape diff per #456 precedent.
	const result: JsonObject = {
		id: item.id,
		chainId: item.chainId,
		itemId: item.itemId,
		repoCwd: item.repoCwd,
		status: item.status,
		attempts: item.attempts,
		position: item.position,
		title: item.title,
		priority: item.priority,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile,
		evidenceDir: item.evidenceDir,
		agentCwd: item.agentCwd,
		runner: item.runner,
		// #412: surface the item's stored preset declaration so `item list --json` is consistent
		// with `coder-loop status --json` `queue.selected.preset.*` exposure. Supervisors reading
		// `item list` need to see per-item preset to drive routing decisions.
		preset: item.preset,
		presetPath: item.presetPath,
		extra: itemExtraToJsonObject(item.extra),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	}
	if (dependencyWait !== undefined) result.waiting = dependencyWait === null ? null : dependencyWaitToJson(dependencyWait)
	return result
}

function assertChainAllowsItemMutation(chain: ChainRecord, operation: string): void {
	if (chain.status === "active") return
	if (chain.status === "deleted") throw new DaemonError("chain_deleted", `${operation} cannot mutate deleted chain ${chain.name}`, {
		chainId: chain.id,
		chainName: chain.name,
		status: chain.status,
	})
	throw new DaemonError("chain_not_active", `${operation} cannot mutate non-active chain ${chain.name} with status ${chain.status}; create a new chain for new work`, {
		chainId: chain.id,
		chainName: chain.name,
		status: chain.status,
		requiredStatus: "active",
		nextStep: "create_new_chain",
	})
}

function assertChainCanTransition(chain: ChainRecord, operation: string, from: ChainRecord["status"], to: ChainRecord["status"]): void {
	if (chain.status === from) return
	if (chain.status === "deleted") throw new DaemonError("chain_deleted", `${operation} cannot mutate deleted chain ${chain.name}`, {
		chainId: chain.id,
		chainName: chain.name,
		status: chain.status,
	})
	throw new DaemonError("chain_not_active", `${operation} can transition chain ${chain.name} from ${from} to ${to}, got ${chain.status}`, {
		chainId: chain.id,
		chainName: chain.name,
		status: chain.status,
		requiredStatus: from,
		nextStatus: to,
	})
}

function chainStatusSummary(
	chain: ChainRecord,
	items: ItemRecord[],
	activeRuns: ReturnType<typeof listActiveRuns>,
	dependencyWaits: readonly DependencyWaitReason[],
): JsonObject {
	const byStatus: Record<string, number> = {}
	for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	const activeItemIds = new Set(activeRuns.map((run) => run.itemId))
	const staleInProgressItems = items
		.filter((item) => item.status === "in_progress" && !activeItemIds.has(item.id))
		.map((item) => ({
			rowId: item.id,
			itemId: item.itemId,
			runId: item.lastRunId,
			repoCwd: item.repoCwd,
			agentCwd: item.agentCwd,
		}))
	return {
		completion: {
			state: chain.status,
			completedAt: chain.status === "completed" ? chain.updatedAt : null,
		},
		// #457: chain-summary no longer surfaces umbrella-shaped first-class fields. Supervisors that
		// need umbrella metadata read the preset-declared keys from `chain.metadata.bindings` directly.
		items: {
			total: items.length,
			byStatus,
		},
		activeSlots: activeRuns.map((run) => ({
			chainId: run.chainId,
			repoCwd: run.repoCwd,
			itemId: run.itemId,
			runId: run.runId,
			pid: run.pid,
			worktreePath: run.worktreePath,
			startedAt: run.startedAt,
		})),
		recovery: {
			needed: staleInProgressItems.length > 0,
			staleInProgressItems,
		},
		waiting: {
			dependency: dependencyWaits.map(dependencyWaitToJson),
		},
	}
}

function dependencyWaitToJson(wait: DependencyWaitReason): JsonObject {
	return {
		reason: "blocked-by-dependency",
		// #419: DependencyWaitReason now carries `rowId` (items.id integer rowid) and `itemId`
		// (opaque preset-declared string id). Wire schema follows the same `rowId` / `itemId`
		// split itemToJson uses so supervisors see one shape everywhere.
		rowId: wait.rowId,
		itemId: wait.itemId,
		repoCwd: wait.repoCwd,
		dependsOn: wait.dependsOn,
		unsatisfied: wait.unsatisfied,
	}
}

function activeRunToJson(run: ReturnType<typeof listActiveRuns>[number]): JsonObject {
	return {
		runId: run.runId,
		pid: run.pid,
		itemId: run.itemId,
		chainId: run.chainId,
		repoCwd: run.repoCwd,
		worktreePath: run.worktreePath,
		startedAt: run.startedAt,
	}
}

function completedRunToJson(run: SchedulerCompletedRun): JsonObject {
	return {
		runId: run.runId,
		itemId: run.itemId,
		chainId: run.chainId,
		repoCwd: run.repoCwd,
		exitCode: run.exitCode,
		status: run.status,
		stdoutBytes: run.stdout.length,
		stderrBytes: run.stderr.length,
	}
}

export function runToJson(run: RunRecord): JsonObject {
	return {
		id: run.id,
		runId: run.runId,
		chainId: run.chainId,
		itemId: run.itemId,
		phase: run.phase,
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		exitCode: run.exitCode,
		extra: itemExtraToJsonObject(run.extra),
	}
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	if (!await pathExists(socketPath)) return
	if (await canConnect(socketPath)) {
		throw new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${socketPath}`, { socketPath })
	}
	await unlinkIfExists(socketPath)
}

export async function detectDaemonSocketPathIssue(socketPath: string, pidFile: string): Promise<DaemonSocketPathIssue | null> {
	if (await pathExists(socketPath)) return null
	const pid = await readDaemonPid(pidFile)
	if (pid === null) return null
	if (!isPidOrGroupAlive(pid)) return null
	return { kind: "daemon_socket_unlinked", pid, socketPath, pidFile }
}

export function daemonSocketPathIssueError(issue: DaemonSocketPathIssue): DaemonError {
	return new DaemonError(
		issue.kind,
		`daemon process ${issue.pid} is alive but socket pathname is missing at ${issue.socketPath}; stop that daemon process before starting a replacement, or wait for the running daemon to recreate the socket`,
		{
			pid: issue.pid,
			socketPath: issue.socketPath,
			pidFile: issue.pidFile,
		},
	)
}

async function readDaemonPid(pidFile: string): Promise<number | null> {
	let content: string
	try {
		content = await readFile(pidFile, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	}
	const parsed = Number(content.trim())
	if (!Number.isInteger(parsed) || parsed <= 0) return null
	return parsed
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function canUseDaemonSocketPath(socketPath: string): Promise<boolean> {
	let socketStat: Awaited<ReturnType<typeof stat>>
	try {
		socketStat = await stat(socketPath)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false
		throw error
	}
	if (!socketStat.isSocket()) return false
	return await canConnect(socketPath)
}

async function canConnect(socketPath: string): Promise<boolean> {
	return await new Promise((resolveConnect) => {
		const socket = createConnection(socketPath)
		const done = (value: boolean) => {
			socket.removeAllListeners()
			socket.destroy()
			resolveConnect(value)
		}
		socket.on("connect", () => done(true))
		socket.on("error", () => done(false))
		socket.setTimeout(100, () => done(false))
	})
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path)
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error
	}
}

async function listen(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolveListen, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening)
			reject(error)
		}
		const onListening = () => {
			server.off("error", onError)
			resolveListen()
		}
		server.once("error", onError)
		server.once("listening", onListening)
		server.listen(socketPath)
	})
}

async function listenOrReportSocketInUse(server: Server, socketPath: string): Promise<void> {
	try {
		await listen(server, socketPath)
	} catch (error) {
		if (await pathExists(socketPath) && await canConnect(socketPath)) {
			throw new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${socketPath}`, { socketPath })
		}
		throw error
	}
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => {
			if (error) reject(error)
			else resolveClose()
		})
	})
}

function translateDaemonStartError(error: unknown, details: JsonObject): DaemonError {
	if (error instanceof DaemonError) return error
	if (isNodeError(error) && error.code === "EADDRINUSE" && typeof details.socketPath === "string") {
		return new DaemonError("socket_in_use", `daemon socket is already accepting connections at ${details.socketPath}`, {
			socketPath: details.socketPath,
		})
	}
	return new DaemonError("daemon_start_failed", `unable to start coder-loop daemon: ${errorMessage(error)}`, details)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
