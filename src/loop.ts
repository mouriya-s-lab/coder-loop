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
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { closeSync, createWriteStream, openSync, readFileSync, statSync, type Dirent, type WriteStream } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve, sep as pathSeparator } from "node:path"
import { command, flag, option, optional, positional, run as runCmd, string as cmdString, subcommands } from "cmd-ts"
import { type as arkType } from "arktype"
import type { BoundaryError, BoundaryRecord, BoundaryValue } from "./boundary-types"
import {
	CoderLoopDaemon,
	DaemonError,
	PRESET_PHASE_PRIVILEGED_OPS,
	PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS,
	PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELD_SET,
	daemonRequest,
	daemonSocketPathIssueError,
	detectDaemonSocketPathIssue,
	sendDaemonRequest,
	type DaemonCommandName,
	type DaemonResponse,
	type PresetPhasePrivilegedOp,
} from "./daemon"
import { dispatchSubcommand } from "./install-commands"
import {
	contextScopeFromCliArgs,
	parseContextAppendBeginResult,
	parseContextAppendChunkResult,
	parseContextAppendCliScopeArgs,
	parseContextAppendCommitResult,
	type ContextAppendBeginRequest,
	type ContextScope,
} from "./context-entry"
import { classifyRateLimitFromStdout } from "./rate-limit"
import { createStreamTextState } from "./runner-output"
import { LOOP_RUN_CREDENTIAL_ENV, RuntimePathError, resolveChainRuntimePaths, resolveLoopDataPaths } from "./runtime-paths"
import {
	parseObservabilityEventType,
	parseObservabilityKind,
	queryObservabilityEvents,
	type ObservabilityEventQuery,
	type PresetPlaceholderDirection,
	type PresetPlaceholderVerdict,
} from "./observability"
import {
	type ChainRecord,
	type CurrentRunRecord,
	type ItemRecord,
	openSqliteStateStore,
	type RunRecord,
	type SqliteStateStore,
} from "./sqlite-state"
import {
	chainBindings as metadataBindings,
	chainBindingsPresetPath,
	itemExtraJsonValue,
	itemExtraToJsonObject,
	metadataBoolean,
	metadataNestedString,
	metadataNestedStringArray,
	metadataString,
	parseInternalStatus,
	RuntimeDataError,
	type AdmittedItemStatus,
	type InternalStatus,
	type ItemExtra,
} from "./runtime-data"
import { checkPresetDag, type PresetDagFinding } from "./preset-dag-check"
export { checkPresetDag } from "./preset-dag-check"
export type { PresetDagFinding, PresetDagFindingKind, PresetDagFindingVerdict, PresetDagFindingTable, PresetDagFindingDeadlockContinuable, PresetDagFindingDeadVocabulary } from "./preset-dag-check"

const PKG_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_PRESET_NAME = "gh-issue-pr-iteration"
const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

// #505: the four target-relative runtime-path defaults (shared / issue /
// evidence / log) have been retired. The chain-side resolution path
// (chainResolvedFromChain -> chainRuntimePathForKind) is now the sole source —
// every chain has both a name and a loopDataRoot, so the derived
// `<loopDataRoot>/chains/<name>/...` path is always available. The
// makeStatusTargetSnapshot chain-load-failed branch is the only place where
// these paths can be absent, and now surfaces them as empty strings to mark
// them unavailable.
// History: #433 retired the on-disk target settings file; #434 retired the
// per-target policy markdown — project commands now come from the repo's own
// AGENTS / CLAUDE markdown, loop policy is inlined in preset fragments, and
// per-target overrides flow through chain.metadata exclusively.
const ENGINE_BUILTIN_RUNNER: AgentRunnerKind = "codex"
export const DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 60 * 60
export const ATTEMPT_TIMEOUT_KILL_MS = 5 * 1000
const STATUS_SNAPSHOT_STATE_VERSION = 1

let logStream: WriteStream | null = null

type AgentLabel = string
class CoderLoopError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CoderLoopError"
	}
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

const STATUS_STATE_FILE_KEY = `state${"File"}` as `state${"File"}`
type ChainBindingScalar = null | boolean | number | string

type ChainBindingFallback =
	| { kind: "none" }
	| { kind: "value"; value: ChainBindingScalar }

export type StatusItemSnapshot = {
	status: string
	attempts: number | null
	title: string | null
	priority: string | null
	lastRunId: string | null
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string | null
	runner: AgentRunnerKind | null
	// #412 per-item preset declaration (string = bundled name; path = absolute filesystem path).
	// Both null = legacy item resolving via chain fallback.
	preset: string | null
	presetPath: string | null
	extra: JsonObject
}

export type StatusCurrentRunSnapshot = {
	phase: string
	runId: string
	startedAt: string
	extra: JsonObject
}

type BuildOptionsInput = {
	targetCwd: string | null
	loopDataRoot: string | null
	chainName: string | null
	dryRun: boolean
	worktree: boolean
	chain: Pick<ChainRecord, "name" | "repository" | "baseBranch" | "metadata">
}

export type StatusCommandArgs = {
	targetCwd: string
	loopDataRoot?: string | null
	chainName?: string | null
	output: "json"
}

export type DaemonCommandArgs =
	| {
			action: "up"
			loopDataRoot: string | null
			schedulerIntervalMs: number | null
			json: boolean
	  }
	| {
			action: "status"
			targetCwd: string
			loopDataRoot?: string | null
			chainName?: string | null
			output: "json"
	  }
	| {
			action: "start"
			targetCwd: string
			loopDataRoot?: string | null
			chainName?: string | null
			dryRun: boolean
			worktree: boolean
			json: boolean
	  }
	| {
			action: "stop"
			targetCwd: string
			loopDataRoot?: string | null
			chainName?: string | null
			dryRun: boolean
			json: boolean
		}
	| {
			action: "restart"
			targetCwd: string
			loopDataRoot?: string | null
			chainName?: string | null
			dryRun: boolean
			worktree: boolean
			json: boolean
	  }
	| {
			action: "down"
			loopDataRoot: string | null
			json: boolean
	  }

export type LogsCommandArgs = {
	targetCwd: string
	loopDataRoot?: string | null
	kind: string | null
	type: string | null
	chainName?: string | null
	item: number | null
	run: string | null
	phase: string | null
	since: string | null
	follow: boolean
	json: boolean
}

export type ChainCommandArgs =
	| {
			action: "create"
			name: string
			configJson: JsonObject
			preset: string | null
			umbrella: string | null
			force: boolean
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "list"
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "status"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "stop"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "resume"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "delete"
			name: string
			loopDataRoot: string | null
			json: boolean
	  }
	// #526: replaces the retired runner-binding override surface (#432 K2 末段 +
	// close-verification row #4 — entire `runtime` CLI namespace gone). Operator-only
	// entry point to patch one chain's `chain.metadata.<kind>.model` runner-binding
	// override. Single kind per invocation makes the ADT precise, the error attribution
	// sharp, and the idempotency check on the daemon side trivially observable. The
	// storage path (`chain.metadata.<kind>.model`) and the daemon op
	// (`chain.updateBindings`) are reused verbatim — only the CLI face changed.
	| {
			action: "set-runner-model"
			name: string
			kind: AgentRunnerKind
			model: string
			loopDataRoot: string | null
			json: boolean
	  }

export type ItemCommandArgs =
	| {
			action: "add"
			chainName: string
			// #419: opaque string item id (formerly `issueNumber: number`). The CLI flag stays
			// `--issue` for backward compatibility with operators / scripts already using it;
			// the parser now accepts opaque string ids via `parseRequiredItemId` instead of the
			// old numeric `parseRequiredIssueNumber`. Only the discriminated-union field name was
			// renamed (`issueNumber` → `itemId`); no `--id` flag exists.
			itemId: string
			repoCwd: string
			// #412: exactly one of preset/presetPath is set; the CLI parser enforces this before
			// constructing the discriminated union variant.
			preset: string | null
			presetPath: string | null
			status: string | null
			attempts: number | null
			title: string | null
			priority: string | null
			fieldJson: JsonObject | null
			lastRunId: string | null
			issueFile: string | null
			evidenceDir: string | null
			agentCwd: string | null
			runner: AgentRunnerKind | null
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "batch-add"
			chainName: string
			items: JsonObject[]
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "list"
			chainName: string
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "update"
			chainName: string
			itemId: string
			repoCwd: string | null
			status: string | null
			title: string | null
			priority: string | null
			fieldJson: JsonObject | null
			issueFile: string | null
			evidenceDir: string | null
			runner: AgentRunnerKind | null
			// #406: `agentRunId` / `agentPhase` retired. Agent identity is bound by the spawn-time
			// `CODER_LOOP_RUN_CRED` env credential (`withInjectedRunCredential` auto-attaches).
			// #457: `blockerRepo` / `blockerRef` / `clearBlocker` retired as first-class engine fields;
			// blocker semantics moved to preset's generic `extraPatch` path inside `--field-json`.
			loopDataRoot: string | null
			json: boolean
	  }
	| {
			action: "reorder"
			chainName: string
			itemId: string
			position: number
			loopDataRoot: string | null
			json: boolean
	  }
	// #451 typed phase-exits query face: agent asks the daemon "what can I write
	// from my current phase?" before issuing the write. Both `agentRunId` and
	// `agentPhase` are required so the query pins to the phase the agent is
	// actively running (the item's last-write phase column is not necessarily
	// the agent's currently-running phase).
	| {
			action: "exits"
			chainName: string
			itemId: string
			agentRunId: string
			agentPhase: string
			loopDataRoot: string | null
			json: boolean
	  }
	// #405 chain-action exit-selection face: agent selects a `chain-action` exit
	// declared in `[[phases.exits]]` (currently only `stop`). Both `agentRunId`
	// and `agentPhase` are required for the same reason as `exits` — the daemon
	// pins the gate to the phase the agent is running, not the item's last-write
	// phase column. The selected action is mapped engine-side to the existing
	// chain.stop API path (D1 semantics: scheduler stops selecting from this
	// chain, in-flight runs naturally complete, `chain resume` reversible).
	| {
			action: "exit-action"
			chainName: string
			itemId: string
			agentRunId: string
			agentPhase: string
			chainAction: PresetPhaseChainAction
			loopDataRoot: string | null
			json: boolean
	  }

export type QueueUnblockCommandArgs = {
	targetCwd: string
	loopDataRoot: string | null
	chainName: string | null
	issue: string
	startDaemon: boolean
	dryRun: boolean
}

type ContextAppendCommandArgs = {
	chainName: string
	scope: ContextScope
	body: string | null
	bodyFile: string | null
	loopDataRoot: string | null
	json: boolean
}

// #433: per-target on-disk runtime preferences are retired. Every fact the engine spawns against
// reaches it via chain metadata now (see chainResolvedFromChain). The composed-options struct
// below holds the live shape that the loop builds from a `ChainRecord` alone.

// #481: opencode joins the union as the third runner kind. Boundary widens accordingly; the
// `AgentRunnerKind` TS union below mirrors it (compile-time `Record<AgentRunnerKind, ...>`
// admittance ensures we cannot leave a code path partial). ENGINE_BUILTIN_RUNNER stays `codex`
// — opencode is an explicit opt-in via `runner = "opencode"` on a preset's phase, never a
// fallback for missing claude/codex.
const AgentRunnerKindBoundary = arkType.or(arkType.unit("claude"), arkType.unit("codex"), arkType.unit("opencode"))

const TerminatedBoundary = arkType.or(
	{ kind: arkType.unit("clean") },
	{ kind: arkType.unit("signal"), name: "string" },
	{ kind: arkType.unit("error"), code: "string" },
	{ kind: arkType.unit("watchdog"), phase: arkType.or(arkType.unit("term"), arkType.unit("kill")), afterSummarySeconds: "number" },
	{ kind: arkType.unit("timeout"), phase: arkType.or(arkType.unit("term"), arkType.unit("kill")), attemptSeconds: "number" },
)

const AgentRunStatusBoundary = arkType({
	label: "string",
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"model?": "string|null",
	"pid": "number|null",
	startedAt: "string",
	lastEventAt: "string",
	outputPath: "string",
	statusPath: "string",
	bytesWritten: "number",
	promptChars: "number",
	"lastStream": arkType.or(arkType.unit("stdout"), arkType.unit("stderr"), "null"),
	"exitCode": "number|null",
	"signal": "string|null",
	"error": "string|null",
	"sessionId": "string|null",
	"terminated": arkType.or(TerminatedBoundary, "null"),
})

type AgentRunStatusInput = typeof AgentRunStatusBoundary.infer

const SessionEntryBoundary = arkType({
	attempt: "string",
	"runner?": arkType.or(AgentRunnerKindBoundary, "null"),
	"model?": "string|null",
	sessionId: "string|null",
	exitCode: "number|null",
	signal: "string|null",
	terminated: TerminatedBoundary,
	log: "string",
})

const ENGINE_ITEM_BINDING_KEYS = new Set([
	"id",
	"status",
	"agentCwd",
	"runner",
	"phase",
])

// #419: `LEGACY_TRANSPARENT_ITEM_FIELDS` retired together with the items physical-shape
// retire. The previous `Set` was a structural escape hatch that let presets refer to
// non-extra item fields by name without going through `[item.fields]`. After #419 every
// non-engine field lives inside `extra` (presets that need them declare them in
// `[item.fields]`), so the only resolution chain is `ENGINE_ITEM_BINDING_KEYS` →
// `extra.<key>`. `lookupItemRootField` reflects that.

const PRESET_ITEM_FIELD_TYPES = ["string", "number", "boolean", "json"] as const
type PresetItemFieldType = typeof PRESET_ITEM_FIELD_TYPES[number]

const PresetPhaseTriggerBoundary = arkType({
	"afterPhase?": "string",
	"whenStatus?": "string",
	"on?": "string",
})

// #405 typed phase-exits ADT. Each exit declared in `[[phases.exits]]` is either
// an item-status branch (the historical shape — preset declares a status the
// agent may write to advance the item) or a chain-action branch (currently only
// `stop`, mapped by the engine to the existing chain.stop API path). The two
// branches are disjoint by intent: an item-status exit advances the item, a
// chain-action exit performs a chain-level side effect with no item-status
// implication. arktype `or` keeps the wire shape ambiguous-free — a row with
// both `status` and `chainAction` (or with neither) fails parse at preset load.
const PresetPhaseExitBoundary = arkType.or(
	{ status: "string", when: "string" },
	{ chainAction: arkType.unit("stop"), when: "string" },
)

// #407 per-phase rights segment. First definition (#396 D10 verdict): #409 (privileged ops)
// and #410 (writable fields) consume the same shape rather than inventing parallel sections.
// All three fields are optional at the boundary; the parser normalizes the missing form to a
// default-deny runtime record so downstream gates never have to branch on "rights absent".
const PresetPhaseRightsBoundary = arkType({
	"createItems?": "boolean",
	"writableFields?": "string[]",
	"privilegedOps?": "string[]",
})

const PresetPhaseBoundary = arkType({
	name: "string",
	prompt: "string",
	"runner?": "string",
	"model?": "string",
	"exits?": PresetPhaseExitBoundary.array(),
	"variables?": "object",
	"trigger?": PresetPhaseTriggerBoundary,
	"roles?": "string[]",
	"rights?": PresetPhaseRightsBoundary,
})

const PresetFragmentBoundary = arkType({
	id: "string",
	role: "string",
	path: "string",
})

const PresetTomlBoundary = arkType({
	name: "string",
	item: { idField: "string", "fields?": "object" },
	"runtime?": { "businessKeys?": "string[]", "businessKeyValues?": "object" },
	statuses: { continuable: "string[]", terminal: "string[]", "success?": "string[]", "entry?": "string", "unblockable?": "string[]", exhausted: "string", "retry?": "string" },
	phases: PresetPhaseBoundary.array(),
	"fragments?": PresetFragmentBoundary.array(),
	// #433: [agent].binary / [agent].extraArgs retired (zombie schema with no read site). Runner
	// binaries now resolve from kind→PATH name (claude/codex) inside buildAgentRunnerCommands.
	"agent?": { "attemptTimeoutSeconds?": "number" },
})

const StatusSnapshotBoundary = arkType({
	target: "object",
	state: "object",
	queue: "object",
	runs: "object",
	current: "object",
	events: "object",
	processes: "object",
})

const CompileWarningBoundary = arkType({ verdict: arkType.unit("warn"), rule: "string", message: "string" })
export const PresetCompileErrorDiagnosticBoundary = arkType({ verdict: arkType.unit("error"), rule: "string", message: "string" })
export const PresetCompileProjectionBoundary = arkType({
	schemaVersion: arkType.unit(1),
	preset: {
		name: "string", dir: "string", sourceHash: "string",
		taskTree: { kind: arkType.unit("seq"), identity: "string" },
	},
	statuses: {
		continuable: "string[]", terminal: "string[]", success: "string[]", entry: "string",
		unblockable: "string[]", exhausted: "string", retry: "string|null",
	},
	stateGraph: {
		nodes: arkType({
			identity: "string",
			status: "string",
			classification: arkType.or(arkType.unit("continuable"), arkType.unit("terminal")),
		}).array(),
		edges: arkType.or(
			{ kind: arkType.unit("engine-entry"), to: "string" },
			{ kind: arkType.unit("engine-exhausted"), to: "string" },
			{ kind: arkType.unit("engine-unblock"), from: "string", to: "string" },
			{ kind: arkType.unit("phase-exit"), phase: "string", to: "string", when: "string" },
		).array(),
	},
	phases: arkType({
		identity: "string", name: "string",
		exits: arkType.or(
			{ kind: arkType.unit("item-status"), status: "string", when: "string" },
			{ kind: arkType.unit("chain-action"), action: arkType.unit("stop"), when: "string" },
		).array(),
		trigger: arkType.or(
			{ afterPhase: "string", whenStatus: "string" },
			{ on: arkType.unit("chain-complete") },
			"null",
		),
		runner: arkType.or(AgentRunnerKindBoundary, "null"), model: "string|null",
		variables: arkType({
			key: "string",
			type: arkType.unit("string"),
			sourceKind: arkType.or(arkType.unit("item"), arkType.unit("chain"), arkType.unit("runtime")),
		}).array(),
		toolRequirements: "string[]",
		rights: { createItems: "boolean", writableFields: "string[]", privilegedOps: "string[]" },
		taskTree: {
			kind: arkType.unit("seq"), identity: "string",
			children: arkType({ kind: arkType.unit("phase"), identity: "string", phase: "string" }).array(),
		},
	}).array(),
	tools: arkType({ id: "string" }).array(),
	fragments: arkType({ id: "string", role: "string", path: "string" }).array(),
	findings: CompileWarningBoundary.array(),
})

export type CompileWarning = typeof CompileWarningBoundary.infer
export type PresetCompileErrorDiagnostic = typeof PresetCompileErrorDiagnosticBoundary.infer
export type PresetCompileProjection = typeof PresetCompileProjectionBoundary.infer
export const PresetCompilePublicResultBoundary = arkType.or(
	{ kind: arkType.unit("compiled"), schemaVersion: arkType.unit(1), projection: PresetCompileProjectionBoundary },
	{ kind: arkType.unit("rejected"), schemaVersion: arkType.unit(1), diagnostics: arkType([PresetCompileErrorDiagnosticBoundary, "...", PresetCompileErrorDiagnosticBoundary.array()]) },
)
export type PresetCompilePublicResult = typeof PresetCompilePublicResultBoundary.infer
const PresetCompileCliArgsBoundary = arkType([
	arkType.unit("compile"),
	"string",
	arkType.unit("--json"),
])
type PresetCompileCliArgs = typeof PresetCompileCliArgsBoundary.infer

// #451 + #405: boundary parser for the `item.exits` wire-verb response. The CLI
// uses it to validate the daemon's reply before rendering — keeps the protocol
// shape pinned and forces both ends to stay in sync. After #405 the entry shape
// is the discriminated ADT (item-status | chain-action) so the read side
// mirrors the preset declaration without flattening the chain-action branch into
// a fake status string.
const ItemExitsResponseEntryBoundary = arkType.or(
	{ kind: arkType.unit("item-status"), status: "string", when: "string" },
	{ kind: arkType.unit("chain-action"), action: arkType.unit("stop"), when: "string" },
)

export const ItemExitsResponseBoundary = arkType({
	phase: "string",
	exits: ItemExitsResponseEntryBoundary.array(),
	allowedStatuses: "string[]",
	allowedChainActions: arkType.unit("stop").array(),
})

export type LoopOptions = {
	targetCwd: string
	sharedContextPath: string
	stateDbPath: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	loopDataRoot: string | null
	logFile: string
	repository: string | null
	baseBranch: string | null
	bindings: RenderBindings
	chainName?: string | null
	worktree: boolean
	hostRunner: AgentRunnerKind
	defaultRunner: AgentRunnerSelection
	runnerCommands: AgentRunnerCommands
	dryRun: boolean
	preset: Preset
	onStatusPersistenceFailure?: (failure: RunnerStatusPersistenceFailure) => void
}

type RunnerStatusPersistenceFailureFields = {
	stage: "status-artifact" | "run-record" | "current-run"
	runId: string
	phase: string
	persistencePath: string
	error: string
}

export type RunnerStatusPersistenceFailure = RunnerStatusPersistenceFailureFields & (
	| { path: "scheduler"; chainId: number; itemId: number }
	| { path: "chain-complete" }
)

export class RunnerStatusPersistenceError extends Error {
	constructor(readonly failure: RunnerStatusPersistenceFailure) {
		super(`${failure.path} ${failure.stage} persistence failed for run=${failure.runId} phase=${failure.phase} path=${failure.persistencePath}: ${failure.error}`)
		this.name = "RunnerStatusPersistenceError"
	}
}

export type PresetVariableSource =
	| { kind: "item"; field: string }
	| { kind: "chain"; field: string; fallback: ChainBindingFallback }
	| { kind: "runtime"; key: string; ownership?: "preset" }

type ParsedVariableSource =
	| { kind: "item"; field: string }
	| { kind: "chain"; field: string }
	| { kind: "runtime"; key: string }

export type PresetVariableDoc = {
	label: string
	prefix: string
	suffix: string
	style: "code" | "plain"
	blankBefore: boolean
}

export type PresetPhaseVariable = {
	key: string
	source: PresetVariableSource
	doc: PresetVariableDoc | null
}

// #405 ADT: each declared phase-exit is one of two disjoint branches. Code
// switching on `kind` must remain exhaustive — adding a new branch (future
// chain-action verbs, etc.) is a typechecker error at every consumer.
export type PresetPhaseExit =
	| { kind: "item-status"; status: InternalStatus; when: string }
	| { kind: "chain-action"; action: "stop"; when: string }

// #405 narrow helpers: most consumers (status admission gate, allowed-statuses
// projection) only care about the item-status branch. Co-located so the
// narrowing rule stays single-source — adding a new chain-action verb in the
// future will also require updating these projections.
export type PresetPhaseExitItemStatus = Extract<PresetPhaseExit, { kind: "item-status" }>
export type PresetPhaseExitChainAction = Extract<PresetPhaseExit, { kind: "chain-action" }>
export const PRESET_PHASE_CHAIN_ACTIONS = ["stop"] as const
export type PresetPhaseChainAction = (typeof PRESET_PHASE_CHAIN_ACTIONS)[number]

// #407 per-phase rights — the in-memory shape of the optional `[phases.rights]` toml segment.
// All three fields are non-optional: the parser normalizes a missing segment to default-deny
// (createItems=false, writableFields=∅, privilegedOps=∅) so downstream consumers (the create-
// gate here, #410's writable-fields gate, #409's privileged-ops gate) all read the same shape.
// `writableFields` is `ReadonlySet<string>` (open vocabulary — preset declares its own field
// universe). `privilegedOps` is narrowed to the engine's closed `PresetPhasePrivilegedOp` union
// at preset-load time (#409): unknown ops are rejected with the full vocabulary in the error
// message, so the in-memory privilegedOps Set never carries a string the gate could not decide on.
export type PresetPhaseRights = {
	createItems: boolean
	writableFields: ReadonlySet<string>
	privilegedOps: ReadonlySet<PresetPhasePrivilegedOp>
}

export type PresetPhase = {
	name: string
	prompt: string
	exits: readonly PresetPhaseExit[]
	variables: readonly PresetPhaseVariable[]
	trigger: PresetPhaseTrigger | null
	defaultRunner: AgentRunnerKind | null
	defaultModel: string | null
	// Visible fragment roles for this phase (issue #400). Fragment index injected
	// into this phase's prompt is sliced to roles named here. Empty when the
	// preset declares no fragments (slicing yields an empty index either way).
	roles: readonly string[]
	// #407 per-phase rights, always present at runtime (parser fills default-deny).
	rights: PresetPhaseRights
}

export type PresetFragment = {
	id: string
	role: string
	path: string
}

export type PresetBusinessKeyValue =
	| { kind: "literal"; value: string }

export type Preset = {
	name: string
	presetDir: string
	item: {
		idField: string
		fields: ReadonlyMap<string, PresetItemField>
	}
	runtime: {
		businessKeys: readonly string[]
		// preset-supplied values for declared business keys. A key present here is
		// rendered from the preset value with zero engine knowledge of its
		// semantics — fulfilling #448 / #422 "新增业务绑定只改 preset 文件".
		businessKeyValues: ReadonlyMap<string, PresetBusinessKeyValue>
	}
		statuses: {
			continuable: readonly InternalStatus[]
			terminal: readonly InternalStatus[]
			success: readonly InternalStatus[]
			entry: InternalStatus
			unblockable: readonly InternalStatus[]
			// #402: status the scheduler writes when the attempts budget is spent without a
			// terminal verdict from any phase. Required (D2 verdict): "未声明则禁用" silently
			// disables the runaway-retry safety, "隐形停选" produces a status outside the preset
			// vocabulary. Validated at load time as a member of `terminal` so the engine can write
			// it without re-validating downstream.
			exhausted: InternalStatus
			// #404: the continuable status reserved for "previous attempt requires another
			// iteration". Declared in `[statuses]` so the preset is the single source of
			// truth for the retry status name — the `retryStatusDoc` engine-rendered doc
			// builder reads this value instead of hard-coding it in prose. Validated at
			// load time as a member of `continuable`. Optional: a preset with no retry
			// concept may omit it; doc builders that need it will render the empty string.
			retry: InternalStatus | null
		}
	phases: readonly PresetPhase[]
	fragments: readonly PresetFragment[]
	agent: {
		attemptTimeoutSeconds: number
	}
}

export type CompiledTaskNode = { identity: string; kind: "phase"; phase: string }
export type CompiledPhaseTaskTree = { identity: string; kind: "seq"; phase: string; children: readonly [CompiledTaskNode] }
export type CompiledTaskTree = { identity: string; kind: "seq"; children: readonly CompiledPhaseTaskTree[] }
export type CompiledTaskModel = Preset & {
	sourceDir: string
	sourceHash: string
	tasks: CompiledTaskTree
}

export type CompiledPresetProduct = {
	model: CompiledTaskModel
	warnings: readonly CompileWarning[]
}

export type PresetCompileSuccess = CompiledPresetProduct & {
	kind: "compiled"
}

export type PresetCompileRejection = {
	kind: "rejected"
	diagnostics: readonly [PresetCompileErrorDiagnostic, ...PresetCompileErrorDiagnostic[]]
}

export type CompileResult =
	| PresetCompileSuccess
	| PresetCompileRejection

type ResolvedPresetCompileSource = {
	kind: "resolved"
	presetDir: string
}

type PresetCompileSourceResolution =
	| ResolvedPresetCompileSource
	| PresetCompileRejection

class PresetCompileFailure extends Error {
	constructor(readonly diagnostics: readonly [PresetCompileErrorDiagnostic, ...PresetCompileErrorDiagnostic[]]) {
		super(diagnostics.map((diagnostic) => diagnostic.message).join("\n"))
		this.name = "PresetCompileFailure"
	}
}

function missingPresetSource(message: string): PresetCompileFailure {
	return new PresetCompileFailure([{ verdict: "error", rule: "preset-source", message }])
}

function presetSourceDiagnostic(error: BoundaryError, code: string): PresetCompileErrorDiagnostic {
	return {
		verdict: "error",
		rule: "preset-source",
		message: `${code}: ${errorMessage(error)}`,
	}
}

function presetSourceFailure(error: BoundaryError, code: string): PresetCompileFailure {
	return new PresetCompileFailure([presetSourceDiagnostic(error, code)])
}

async function readPresetSourceBytes(path: string): Promise<Buffer> {
	try {
		return await readFile(path)
	} catch (error) {
		if (isNodeError(error) && typeof error.code === "string") throw presetSourceFailure(error, error.code)
		throw error
	}
}

async function readPresetSourceText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && typeof error.code === "string") throw presetSourceFailure(error, error.code)
		throw error
	}
}

class PresetStructureError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PresetStructureError"
	}
}

export function buildCompiledTaskTree(phases: readonly PresetPhase[]): CompiledTaskTree {
	return {
		kind: "seq",
		identity: "tasks:root",
		children: phases.map((phase) => ({
			kind: "seq",
			identity: `phase:${phase.name}`,
			phase: phase.name,
			children: [{ kind: "phase", identity: `task:${phase.name}`, phase: phase.name }],
		})),
	}
}

export type PresetItemField = {
	type: PresetItemFieldType
}

export type PresetPhaseTrigger =
	| { afterPhase: string; whenStatus: InternalStatus }
	| { on: "chain-complete" }

export type AgentRunnerKind = "claude" | "codex" | "opencode"

// #433: "config" source value is retired — there is no longer a target-side runtime preferences
// file to override phase runner choice from. #456: role-named source values (`iteration-default` /
// `review-default`) survive only as legacy enum tags in fixture-driven tests; the engine never
// produces them, so they are not emitted in `status --json` from any current code path. New code
// must not produce them — runner source flows from preset declaration / queue override / engine
// fallback only.
export type AgentRunnerSource = "preset" | "engine-builtin" | "queue" | "iteration-default" | "review-default"

export type AgentRunnerCommand = {
	kind: AgentRunnerKind
	binary: string
	extraArgs: readonly string[]
	model: string | null
}

export type AgentRunnerSelection = AgentRunnerCommand & {
	source: AgentRunnerSource
}

export type AgentRunnerCommands = {
	claude: AgentRunnerCommand
	codex: AgentRunnerCommand
	opencode: AgentRunnerCommand
}

export type RuntimeCheckError = {
	path: string
	message: string
}

export type AgentRunStatus = {
	label: AgentLabel
	runner: AgentRunnerKind | null
	model: string | null
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

export type CoderLoopStatusSnapshot = {
	target: StatusTargetSnapshot
	state: StatusStateSnapshot
	queue: StatusQueueSnapshot
	runs: StatusRunsSnapshot
	current: StatusCurrentSnapshot
	events: StatusEventsSnapshot
	processes: StatusProcessSnapshot
}

export type StatusTargetSnapshot = {
	cwd: string
	sharedContextPath: string
	[STATUS_STATE_FILE_KEY]: string
	issueDir: string
	evidenceRootDir: string
	logDir: string
	repository: string | null
	baseBranch: string | null
	worktree: boolean
	runner: StatusRunnerDefaultsSnapshot
	preset: {
		name: string
		presetDir: string
	} | null
}

export type StatusRunnerSelectionSnapshot = {
	kind: AgentRunnerKind
	source: AgentRunnerSource
	binary: string
	extraArgs: string[]
	model: string | null
}

export type StatusRunnerDefaultsSnapshot = {
	hostDefault: AgentRunnerKind
	default: StatusRunnerSelectionSnapshot
	phases: Record<string, StatusRunnerSelectionSnapshot>
}

export type StatusStateKind =
	| "ok"
	| "missing-preset"
	| "invalid-preset"
	| "missing-state"
	| "invalid-state"
	| "invalid-runtime"

export type StatusStateSnapshot = {
	kind: StatusStateKind
	ok: boolean
	loaded: boolean
	path: string
	version: number | null
	repository: string | null
	baseBranch: string | null
	errors: RuntimeCheckError[]
	error: string | null
}

export type StatusSelectedIssue = {
	id: string
	item: StatusItemSnapshot
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	runner: StatusRunnerSelectionSnapshot
	phaseRunners: Record<string, StatusRunnerSelectionSnapshot>
	// #412 resolved per-item preset: source (which item field decided it) + resolved preset directory.
	// Supervisor consumers see exactly which preset rendered the selected item without re-loading it.
	preset: StatusItemPresetSnapshot
}

export type StatusItemPresetSnapshot = {
	// "item-preset" / "item-preset-path" = honored item.preset / item.presetPath columns.
	// "chain-fallback" = legacy item with no per-item preset; resolved via chain.preset.
	source: "item-preset" | "item-preset-path" | "chain-fallback"
	name: string | null
	path: string | null
	presetDir: string
}

export type StatusQueueSnapshot = {
	total: number
	byStatus: Record<string, number>
	continuable: number
	terminal: number
	selected: StatusSelectedIssue | null
}

export type StatusRunCountSnapshot = {
	phase: string
	status: string
	count: number
}

export type StatusRunsSnapshot = {
	total: number
	byPhaseStatus: Record<string, Record<string, number>>
	counts: StatusRunCountSnapshot[]
}

export type StatusPhaseStatusSnapshot = {
	path: string
	exists: boolean
	value: AgentRunStatus | null
	error: string | null
}

export type StatusCurrentSnapshot = {
	run: StatusCurrentRunSnapshot | null
	id: string | null
	item: StatusItemSnapshot | null
	runner: StatusRunnerSelectionSnapshot | null
	phaseStatus: StatusPhaseStatusSnapshot | null
}

export type StatusEventsSnapshot = {
	runId: string | null
	path: string | null
	exists: boolean
	recent: JsonValue[]
	latest: JsonValue | null
	error: string | null
}

export type StatusProcessInfo = {
	pid: number
	ppid: number | null
	command: string | null
	cwd: string | null
	matchesTarget: boolean
	alive: boolean
	source: "ps" | "daemon-socket"
}

export type StatusProcessSnapshot = {
	live: StatusProcessInfo[]
	scanError: string | null
}

export type Terminated =
	| { kind: "clean" }
	| { kind: "signal"; name: string }
	| { kind: "error"; code: string }
	| { kind: "watchdog"; phase: "term" | "kill"; afterSummarySeconds: number }
	| { kind: "timeout"; phase: "term" | "kill"; attemptSeconds: number }

export type SessionEntry = {
	attempt: string
	runner?: AgentRunnerKind | null
	model?: string | null
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
	| (LoopEventBase & {
			type: "attempt.timeout"
			phase: string
			attemptStartedAt: string
			signal: "SIGTERM" | "SIGKILL"
			attemptSeconds: number
		})
	| (LoopEventBase & { type: "queue.terminal"; terminalStatus: string })

export type LoopEventType = LoopEvent["type"]

export const LOOP_EVENT_TYPES = [
	"queue.select",
	"phase.start",
	"phase.end",
	"attempt.start",
	"attempt.timeout",
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

export function loopEventsPath(logDir: string, runId: string): string {
	return resolve(logDir, runId, "events.jsonl")
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
	logDir: string,
	runId: string,
	logFn: (message: string) => void,
): LoopEventEmit {
	const path = loopEventsPath(logDir, runId)
	return (event) => appendLoopEvent(path, event, logFn)
}

export const RESUME_CONTINUE_PROMPT = "继续"
export const BACKOFF_BUDGET_SECONDS = 7200
const BACKOFF_INITIAL_SECONDS = 4
const BACKOFF_MAX_INTERVAL_SECONDS = 600

// #405 retired: the entire stdout verdict-parser family — the five-word vocab,
// the discriminated TS type, the per-runner stream parsers, and the v1
// `runReview` consumer that read the marker — has been deleted. Review's
// terminal action now flows entirely through #451's typed phase-exits selection
// face (`coder-loop item exits` + write via `coder-loop item update --status`
// for item-status branches, or `coder-loop item exit-action --action stop` for
// chain-action branches). No stdout-derived flow word survives in any code path.
export const SUMMARY_WATCHDOG_TERM_MS = Infinity
export const SUMMARY_WATCHDOG_KILL_MS = 5 * 1000

export type SelectedIssue = {
	item: ItemRecord
	issueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	runner: AgentRunnerSelection
}

export type IssueRunContext = {
	runIdGeneration: "new" | "resumed"
	resumedFromPhase: string | null
	resumedStartedAt: string | null
	resumedSessionId: string | null
}

export const ENGINE_RUNTIME_BINDING_KEYS = [
	"runId",
	"targetCwd",
	"agentCwd",
	"sharedContextPath",
	"stateFile",
	"currentIssueFile",
	"issueDir",
	"evidenceDir",
	"evidenceRootDir",
	"logDir",
	"traceFile",
	"loopFile",
	"presetDir",
	"fragmentIndex",
	"runtimeInputsDoc",
	"phaseExitsDoc",
	// #404: per-phase doc builders that inject status vocabulary into preset md
	// fragments so the prose layer never carries a hand-written copy of preset
	// metadata. Each builder enforces its own per-phase slice (contract-5
	// minimum visibility, issue #396 comment 4666115115) — iteration sees only
	// the statuses it legitimately reasons about; review sees the broader
	// vocabulary it must classify against; trigger phases see only their own
	// trigger status. Engine fact key count: 26 — keep
	// `docs/preset-authoring.md` and CLAUDE.md in sync.
	//
	// (Retry on #495 dropped `transitionGuidanceDoc`: it duplicated
	// `phaseExitsDoc`'s rendering of `phase.exits` in a different layout and
	// had no distinct consumer; keeping a redundant builder violated
	// contract-5 minimum surface. The post-rebase retry against main #497
	// also dropped `runVerdictVocabularyDoc` for the same reason — its only
	// consumer was the SUMMARY line #497 retired, and its data source
	// `REVIEW_SUMMARY_VERDICTS` was deleted by the same PR.)
	"statusVocabularyDoc",
	"triggerStatusDoc",
	"terminalStatusesDoc",
	"retryStatusDoc",
	"runIdGeneration",
	"resumedFromPhase",
	"resumedStartedAt",
	"resumedSessionId",
	"chainName",
	"repoCwd",
] as const

type EngineRuntimeBindingKey = (typeof ENGINE_RUNTIME_BINDING_KEYS)[number]

function isEngineRuntimeBindingKey(key: string): key is EngineRuntimeBindingKey {
	return (ENGINE_RUNTIME_BINDING_KEYS as readonly string[]).includes(key)
}

export type RuntimeBindings = Record<EngineRuntimeBindingKey, string> & Readonly<Record<string, string | undefined>>

export type RuntimeBindingPaths = {
	sharedContextPath: string
	currentIssueFile: string
	issueDir: string
	evidenceDir: string
	evidenceRootDir: string
	logDir: string
}

export const RUNTIME_BINDING_PATH_KEYS = ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"] as const
export type RuntimeBindingPathKey = (typeof RUNTIME_BINDING_PATH_KEYS)[number]

export function phaseDeclaredRuntimeBindingPaths(phase: Pick<PresetPhase, "variables">): readonly RuntimeBindingPathKey[] {
	const result: RuntimeBindingPathKey[] = []
	for (const variable of phase.variables) {
		if (variable.source.kind !== "runtime") continue
		let pathKey: RuntimeBindingPathKey | null = null
		switch (variable.source.key) {
			case "sharedContextPath": pathKey = "sharedContextPath"; break
			case "currentIssueFile": pathKey = "currentIssueFile"; break
			case "issueDir": pathKey = "issueDir"; break
			case "evidenceDir": pathKey = "evidenceDir"; break
			case "evidenceRootDir": pathKey = "evidenceRootDir"; break
			case "logDir":
			case "traceFile": pathKey = "logDir"; break
		}
		if (pathKey !== null && !result.includes(pathKey)) result.push(pathKey)
	}
	return result
}

export type RenderBindings = JsonObject

export type ResolveContext = {
	item: ItemRecord
	chain: RenderBindings
	runtime: RuntimeBindings
	// #404: preset reference required so per-phase doc builders
	// (status/transition/verdict vocabulary) can read declared status names,
	// trigger metadata, and other phase definitions without the prose layer
	// carrying hand-written copies of preset.toml.
	preset: Preset
}

type CliCommand =
	| { kind: "status"; args: StatusCommandArgs }
	| { kind: "logs"; args: LogsCommandArgs }
	| { kind: "daemon"; args: DaemonCommandArgs }
	| { kind: "chain"; args: ChainCommandArgs }
	| { kind: "item"; args: ItemCommandArgs }
	| { kind: "queue"; args: QueueUnblockCommandArgs }

// #433: the per-target runner / model CLI is retired; runner / model resolution is read from
// `coder-loop status <target> --json`'s runner view, set in preset.toml's per-phase `runner` /
// `model`, and the enum-renderer / [1m] suffix that lived here is gone with it.

function includesStringLiteral<const Values extends readonly string[]>(values: Values, value: string): value is Values[number] {
	return values.some((entry) => entry === value)
}

const statusCliCommand = command({
	name: "status",
	description: "Emit a read-only coder-loop runtime snapshot.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("status: only --json output is supported for now. Usage: coder-loop status <target> --json")
		return {
			kind: "status",
			args: {
				targetCwd: args.target,
				loopDataRoot: args.loopDataRoot ?? null,
				chainName: args.chain ?? null,
				output: "json",
			},
		}
	},
})

const logsCliCommand = command({
	name: "logs",
	description: "Query the unified coder-loop observability event stream.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		kind: option({ long: "kind", type: optional(cmdString) }),
		type: option({ long: "type", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		item: option({ long: "item", type: optional(cmdString) }),
		run: option({ long: "run", type: optional(cmdString) }),
		phase: option({ long: "phase", type: optional(cmdString) }),
		since: option({ long: "since", type: optional(cmdString) }),
		follow: flag({ long: "follow" }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("logs: only --json output is supported for now. Usage: coder-loop logs <target> --json")
		return {
			kind: "logs",
			args: {
				targetCwd: args.target,
				loopDataRoot: args.loopDataRoot ?? null,
				kind: args.kind ?? null,
				type: args.type ?? null,
				chainName: args.chain ?? null,
				item: parseOptionalPositiveInteger(args.item ?? null, "--item"),
				run: args.run ?? null,
				phase: args.phase ?? null,
				since: args.since ?? null,
				follow: args.follow,
				json: true,
			},
		}
	},
})

const daemonStatusCliCommand = command({
	name: "status",
	description: "Emit daemon ownership and runtime status for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		json: flag({ long: "json" }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
	},
	handler: (args): CliCommand => {
		if (!args.json) fail("daemon status: only --json output is supported for now. Usage: coder-loop daemon status <target> --json")
		return {
			kind: "daemon",
			args: {
				action: "status",
				targetCwd: args.target,
				loopDataRoot: args.loopDataRoot ?? null,
				chainName: args.chain ?? null,
				output: "json",
			},
		}
	},
})

const daemonUpCliCommand = command({
	name: "up",
	description: "Run the centralized coder-loop daemon process.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		schedulerIntervalMs: option({ long: "scheduler-interval-ms", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "up",
			loopDataRoot: args.loopDataRoot ?? null,
			schedulerIntervalMs: parseOptionalPositiveInteger(args.schedulerIntervalMs ?? null, "--scheduler-interval-ms"),
			json: args.json,
		},
	}),
})

const daemonStartCliCommand = command({
	name: "start",
	description: "Start coder-loop as a detached daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "start",
			targetCwd: args.target,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			dryRun: args.dryRun,
			worktree: args.worktree,
			json: args.json,
		},
	}),
})

const daemonStopCliCommand = command({
	name: "stop",
	description: "Stop the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "stop",
			targetCwd: args.target,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			dryRun: args.dryRun,
			json: args.json,
		},
	}),
})

const daemonRestartCliCommand = command({
	name: "restart",
	description: "Restart the coder-loop daemon for a target.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
		dryRun: flag({ long: "dry-run" }),
		worktree: flag({ long: "worktree" }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "restart",
			targetCwd: args.target,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
			dryRun: args.dryRun,
			worktree: args.worktree,
			json: args.json,
		},
	}),
})

const daemonDownCliCommand = command({
	name: "down",
	description: "Ask the centralized coder-loop daemon to shut down through its Unix socket.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "daemon",
		args: {
			action: "down",
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const daemonCliCommand = subcommands({
	name: "daemon",
	description: "Manage coder-loop daemon processes.",
	cmds: {
		up: daemonUpCliCommand,
		status: daemonStatusCliCommand,
		start: daemonStartCliCommand,
		stop: daemonStopCliCommand,
		restart: daemonRestartCliCommand,
		down: daemonDownCliCommand,
	},
})

const chainCreateCliCommand = command({
	name: "create",
	description: "Create a centralized coder-loop chain through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		configJson: option({ long: "config-json", type: cmdString }),
		preset: option({ long: "preset", type: optional(cmdString) }),
		umbrella: option({ long: "umbrella", type: optional(cmdString) }),
		force: flag({ long: "force" }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "create",
			name: args.name,
			configJson: parseOptionalJsonObjectFlag(args.configJson, "--config-json") ?? {},
			preset: args.preset ?? null,
			umbrella: args.umbrella ?? null,
			force: args.force,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainListCliCommand = command({
	name: "list",
	description: "List centralized coder-loop chains through the daemon socket.",
	args: {
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "list",
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainStatusCliCommand = command({
	name: "status",
	description: "Show one centralized coder-loop chain through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "status",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainStopCliCommand = command({
	name: "stop",
	description: "Mark one centralized coder-loop chain as stopped through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "stop",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainResumeCliCommand = command({
	name: "resume",
	description: "Resume one stopped centralized coder-loop chain through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "resume",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainDeleteCliCommand = command({
	name: "delete",
	description: "Mark one centralized coder-loop chain as deleted through the daemon socket.",
	args: {
		name: positional({ displayName: "name", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "delete",
			name: args.name,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

// #526: replaces the retired runner-binding override surface (the entire `runtime` CLI
// namespace was struck out by #432 K2 末段 + close-verification row #4; #481 had
// re-introduced a narrow slice for opencode-model overrides, which is the slice this
// chain-side command now absorbs). Operator-only entry point that patches one chain's
// runner-binding `model` override. Wraps the same `chain.updateBindings` daemon op the
// retired command used — the storage path (`chain.metadata.<kind>.model`) and the wire
// patch shape (`{<kind>: {model}}`) are preserved verbatim, only the CLI face changed.
// Single kind per invocation: tighter ADT input, precise error attribution, daemon-side
// idempotency check on re-run. Same flag set as `chain status/stop/resume/delete`
// (positional chain name + optional --loop-data-root / --json) so it slots cleanly into
// the existing `chain` subcommand group instead of resurrecting a top-level namespace.
const chainSetRunnerModelCliCommand = command({
	name: "set-runner-model",
	description: "Patch one chain's `chain.metadata.<kind>.model` runner-binding override through the daemon socket.",
	args: {
		name: positional({ displayName: "chain", type: cmdString }),
		kind: option({ long: "kind", type: cmdString }),
		model: option({ long: "model", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "chain",
		args: {
			action: "set-runner-model",
			name: args.name,
			kind: parseRequiredRunnerKind(args.kind, "--kind"),
			model: parseRequiredNonEmptyString(args.model, "--model"),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const chainCliCommand = subcommands({
	name: "chain",
	description: "Operate centralized coder-loop chains through the daemon socket.",
	cmds: {
		create: chainCreateCliCommand,
		list: chainListCliCommand,
		status: chainStatusCliCommand,
		stop: chainStopCliCommand,
		resume: chainResumeCliCommand,
		delete: chainDeleteCliCommand,
		"set-runner-model": chainSetRunnerModelCliCommand,
	},
})

const itemAddCliCommand = command({
	name: "add",
	description: "Add an item to a centralized coder-loop chain through the daemon socket. Exactly one of --preset or --preset-path is required (#412).",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		repoCwd: option({ long: "repo-cwd", type: cmdString }),
		// #412: preset must be specified per-item; the CLI surfaces both bundled-name and absolute-path
		// variants. The daemon rejects requests that pass neither or both.
		preset: option({ long: "preset", type: optional(cmdString) }),
		presetPath: option({ long: "preset-path", type: optional(cmdString) }),
		status: option({ long: "status", type: optional(cmdString) }),
		attempts: option({ long: "attempts", type: optional(cmdString) }),
		title: option({ long: "title", type: optional(cmdString) }),
		priority: option({ long: "priority", type: optional(cmdString) }),
		fieldJson: option({ long: "field-json", type: optional(cmdString) }),
		lastRunId: option({ long: "last-run-id", type: optional(cmdString) }),
		issueFile: option({ long: "issue-file", type: optional(cmdString) }),
		evidenceDir: option({ long: "evidence-dir", type: optional(cmdString) }),
		agentCwd: option({ long: "agent-cwd", type: optional(cmdString) }),
		runner: option({ long: "runner", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => {
		const presetSpec = parseItemPresetSpec(args.preset ?? null, args.presetPath ?? null)
		return {
			kind: "item",
			args: {
				action: "add",
				chainName: args.chain,
				itemId: parseRequiredItemId(args.issue, "--issue"),
				repoCwd: resolve(args.repoCwd),
				preset: presetSpec.preset,
				presetPath: presetSpec.presetPath,
				status: args.status ?? null,
				attempts: parseOptionalNonNegativeInteger(args.attempts ?? null, "--attempts"),
				title: args.title ?? null,
				priority: args.priority ?? null,
				fieldJson: parseOptionalJsonObjectFlag(args.fieldJson ?? null, "--field-json"),
				lastRunId: args.lastRunId ?? null,
				issueFile: args.issueFile ?? null,
				evidenceDir: args.evidenceDir ?? null,
				agentCwd: args.agentCwd === undefined ? null : resolve(args.agentCwd),
				runner: parseOptionalRunner(args.runner ?? null, "--runner"),
				loopDataRoot: args.loopDataRoot ?? null,
				json: args.json,
			},
		}
	},
})

const itemBatchAddCliCommand = command({
	name: "batch-add",
	description: "Add multiple items to one centralized coder-loop chain atomically through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		itemsJson: option({ long: "items-json", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "batch-add",
			chainName: args.chain,
			items: parseBatchItemsJson(args.itemsJson),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemListCliCommand = command({
	name: "list",
	description: "List items in a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "list",
			chainName: args.chain,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemUpdateCliCommand = command({
	name: "update",
	description: "Update an item in a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		repoCwd: option({ long: "repo-cwd", type: optional(cmdString) }),
		status: option({ long: "status", type: optional(cmdString) }),
		title: option({ long: "title", type: optional(cmdString) }),
		priority: option({ long: "priority", type: optional(cmdString) }),
		fieldJson: option({ long: "field-json", type: optional(cmdString) }),
		issueFile: option({ long: "issue-file", type: optional(cmdString) }),
		evidenceDir: option({ long: "evidence-dir", type: optional(cmdString) }),
		runner: option({ long: "runner", type: optional(cmdString) }),
		// #406: `--agent-run-id` / `--agent-phase` flags retired. The spawn-time env credential
		// (`CODER_LOOP_RUN_CRED`) auto-attaches via `withInjectedRunCredential`. Operators run the
		// CLI in their own env (no credential) and the daemon admits them as `operator`.
		// #457: `--blocker-repo` / `--blocker-ref` / `--clear-blocker` flags retired as first-class
		// engine fields; blocker semantics moved to preset's generic `--field-json` `extraPatch` path.
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "update",
			chainName: args.chain,
			itemId: parseRequiredItemId(args.issue, "--issue"),
			repoCwd: args.repoCwd === undefined ? null : resolve(args.repoCwd),
			status: args.status ?? null,
			title: args.title ?? null,
			priority: args.priority ?? null,
			fieldJson: parseOptionalJsonObjectFlag(args.fieldJson ?? null, "--field-json"),
			issueFile: args.issueFile ?? null,
			evidenceDir: args.evidenceDir ?? null,
			runner: parseOptionalRunner(args.runner ?? null, "--runner"),
			// #406: `agentRunId` / `agentPhase` retired (env-credential path).
			// #457: `blockerRepo` / `blockerRef` / `clearBlocker` retired (extraPatch path).
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemReorderCliCommand = command({
	name: "reorder",
	description: "Move an item to a new queue position in a centralized coder-loop chain through the daemon socket.",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		position: option({ long: "position", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "reorder",
			chainName: args.chain,
			itemId: parseRequiredItemId(args.issue, "--issue"),
			position: parseRequiredNonNegativeInteger(args.position, "--position"),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

// #451 typed phase-exits query CLI. Issued by an agent (so both --agent-run-id
// and --agent-phase are required, matching the `item update` audit-attribution
// precedent) to ask the daemon which statuses the agent's currently-running
// phase is allowed to write. The returned list is sourced from
// `[[phases.exits]]` of the item's resolved preset and is per-phase sliced
// (#396 contract row 5: no global state machine, no other phases' exits).
const itemExitsCliCommand = command({
	name: "exits",
	description: "Query the typed phase-exits for an item in its current run phase (agent surface for the completion protocol).",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		agentRunId: option({ long: "agent-run-id", type: cmdString }),
		agentPhase: option({ long: "agent-phase", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "exits",
			chainName: args.chain,
			itemId: parseRequiredItemId(args.issue, "--issue"),
			agentRunId: args.agentRunId,
			agentPhase: args.agentPhase,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

// #405 chain-action exit-selection CLI. Companion to the #451 typed query face:
// agents call `coder-loop item exits` to learn what their phase declares, then
// dispatch one of two writers — `item update --status` for item-status exits or
// this command for chain-action exits. The single chain action today is `stop`,
// which the engine maps to the chain.stop API path (D1: scheduler stops
// selecting from this chain, in-flight runs naturally complete, `chain resume`
// reversible). Agent direct `chain stop` calls are rejected (#409); this CLI is
// the only controlled channel that an agent may use to stop the chain it owns.
const itemExitActionCliCommand = command({
	name: "exit-action",
	description: "Select a chain-action exit declared in the item's current run phase (agent surface for chain-side completion verbs).",
	args: {
		chain: positional({ displayName: "chain", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		agentRunId: option({ long: "agent-run-id", type: cmdString }),
		agentPhase: option({ long: "agent-phase", type: cmdString }),
		action: option({ long: "action", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): CliCommand => ({
		kind: "item",
		args: {
			action: "exit-action",
			chainName: args.chain,
			itemId: parseRequiredItemId(args.issue, "--issue"),
			agentRunId: args.agentRunId,
			agentPhase: args.agentPhase,
			chainAction: parsePresetPhaseChainActionFlag(args.action),
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		},
	}),
})

const itemCliCommand = subcommands({
	name: "item",
	description: "Operate centralized coder-loop chain items through the daemon socket.",
	cmds: {
		add: itemAddCliCommand,
		"batch-add": itemBatchAddCliCommand,
		list: itemListCliCommand,
		update: itemUpdateCliCommand,
		reorder: itemReorderCliCommand,
		exits: itemExitsCliCommand,
		"exit-action": itemExitActionCliCommand,
	},
})

const contextAppendCliCommand = command({
	name: "append",
	description: "Append an opaque context entry through the daemon socket.",
	args: {
		chainName: positional({ displayName: "chain", type: cmdString }),
		scope: option({ long: "scope", type: cmdString }),
		itemId: option({ long: "item", type: optional(cmdString) }),
		groupId: option({ long: "group", type: optional(cmdString) }),
		body: option({ long: "body", type: optional(cmdString) }),
		bodyFile: option({ long: "body-file", type: optional(cmdString) }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		json: flag({ long: "json" }),
	},
	handler: (args): ContextAppendCommandArgs => {
		const scopeArgs = parseContextAppendCliScopeArgs({ scope: args.scope, itemId: args.itemId ?? null, groupId: args.groupId ?? null })
		return {
			chainName: args.chainName,
			scope: contextScopeFromCliArgs(scopeArgs),
			body: args.body ?? null,
			bodyFile: args.bodyFile ?? null,
			loopDataRoot: args.loopDataRoot ?? null,
			json: args.json,
		}
	},
})

const contextCliCommand = subcommands({ name: "context", description: "Append daemon-owned context entries.", cmds: { append: contextAppendCliCommand } })

async function runContextCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(contextCliCommand, args)
	const value = parsed.value
	if ((value.body === null) === (value.bodyFile === null)) fail("exactly one of --body or --body-file is required")
	const body = value.body ?? await readFile(value.bodyFile ?? fail("body file missing"), "utf-8")
	const beginRequest: ContextAppendBeginRequest = { scope: value.scope }
	const begun = parseContextAppendBeginResult(await requestDaemonResult(value.loopDataRoot, "context.append.begin", { chainName: value.chainName, ...beginRequest }))
	const sessionId = begun.sessionId
	const chunkChars = 256 * 1024
	let sequence = 0
	for (let offset = 0; offset < body.length; offset += chunkChars) {
		parseContextAppendChunkResult(await requestDaemonResult(value.loopDataRoot, "context.append.chunk", { sessionId, sequence, chunk: body.slice(offset, offset + chunkChars) }))
		sequence += 1
	}
	const result = parseContextAppendCommitResult(await requestDaemonResult(value.loopDataRoot, "context.append.commit", { sessionId }))
	writeCommandResult(result, value.json, (entry) => `context entry appended: ${String(entry.entryId ?? "")}\n`)
}

const queueUnblockCliCommand = command({
	name: "unblock",
	description: "Restore one preset-unblockable item to the preset entry status and clear blocker metadata.",
	args: {
		target: positional({ displayName: "target", type: cmdString }),
		issue: option({ long: "issue", type: cmdString }),
		loopDataRoot: option({ long: "loop-data-root", type: optional(cmdString) }),
		chain: option({ long: "chain", type: optional(cmdString) }),
			startDaemon: flag({ long: "start-daemon" }),
			dryRun: flag({ long: "dry-run" }),
		},
		handler: (args): CliCommand => ({
		kind: "queue",
		args: {
			targetCwd: args.target,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chain ?? null,
				issue: args.issue,
				startDaemon: args.startDaemon,
				dryRun: args.dryRun,
			},
		}),
})

const queueCliCommand = subcommands({
	name: "queue",
	description: "Operate on coder-loop queue state through checked runtime APIs.",
	cmds: {
		unblock: queueUnblockCliCommand,
	},
})

// #433: the legacy runtime-inspection / model-mutation CLI command group is retired (both the
// read and write sub-commands). To inspect runner / model resolution, read the `target.runner` /
// `queue.selected.*Runner` view of `coder-loop status <target> --json`. To change phase models,
// edit the preset.toml's per-phase `model` declaration in source.

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

function parseOptionalPositiveInteger(value: string | null, flagName: string): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flagName} must be a positive integer, got: ${value}`)
	return parsed
}

function parseRequiredPositiveInteger(value: string, flagName: string): number {
	const parsed = parseOptionalPositiveInteger(value, flagName)
	if (parsed === null) fail(`${flagName} is required`)
	return parsed
}

// #419: opaque item id parser for the CLI face. Replaces `parseRequiredPositiveInteger` on
// the `--issue` flag (kept for backward compat) — item identity is preset-declared and may be a string
// (single-phase-example's `idField = "id"` carries strings) or a string-encoded number
// (gh-issue-pr-iteration's `idField = "issue"` carries stringified GitHub issue numbers).
// The CLI no longer parses to an integer at this point; the daemon enforces shape per preset.
function parseRequiredItemId(value: string, flagName: string): string {
	if (typeof value !== "string" || value.length === 0) fail(`${flagName} is required`)
	if (/\s/.test(value)) fail(`${flagName} must not contain whitespace, got: ${value}`)
	return value
}

function parseOptionalNonNegativeInteger(value: string | null, flagName: string): number | null {
	if (value === null) return null
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) fail(`${flagName} must be a non-negative integer, got: ${value}`)
	return parsed
}

function parseRequiredNonNegativeInteger(value: string, flagName: string): number {
	const parsed = parseOptionalNonNegativeInteger(value, flagName)
	if (parsed === null) fail(`${flagName} is required`)
	return parsed
}

// #405 chain-action flag parser. Rejects values outside the engine's declared
// `PRESET_PHASE_CHAIN_ACTIONS` vocabulary at the CLI boundary — the daemon
// re-validates against the phase's declared options as a second leg, but the
// CLI fail-fast keeps operator/agent feedback friendly.
function parsePresetPhaseChainActionFlag(value: string): PresetPhaseChainAction {
	const found = PRESET_PHASE_CHAIN_ACTIONS.find((action) => action === value)
	if (found === undefined) {
		fail(`--action must be one of: ${PRESET_PHASE_CHAIN_ACTIONS.join(", ")}; got: ${value}`)
	}
	return found
}

function parseOptionalRunner(value: string | null, flagName: string): AgentRunnerKind | null {
	if (value === null) return null
	if (value === "claude" || value === "codex" || value === "opencode") return value
	fail(`${flagName} must be claude, codex, or opencode, got: ${value}`)
}

// #526 chain set-runner-model boundary parsers. Required variants of the runner-kind /
// non-whitespace-string narrowings so the CLI fails before the daemon round-trip when an
// operator omits `--kind` / `--model`, passes a typo, or passes whitespace-only.
// `parseRequiredItemId` (`src/loop.ts:1808`) set the sibling-parser standard: any
// whitespace in a required CLI string is a typo, not a value. `parseRequiredNonEmptyString`
// follows the same rule below — `--model "   "` would otherwise silently land in
// `chain.metadata.<kind>.model` and only fail at the next spawn far away from the write
// site. `parseRequiredRunnerKind` is the direct three-string narrowing (no proxy through
// `parseOptionalRunner`, whose null-return branch the type system requires here but the
// narrowed input could never hit).
function parseRequiredRunnerKind(value: string, flagName: string): AgentRunnerKind {
	if (typeof value !== "string" || value.length === 0) fail(`${flagName} is required`)
	if (value === "claude" || value === "codex" || value === "opencode") return value
	fail(`${flagName} must be claude, codex, or opencode, got: ${value}`)
}

function parseRequiredNonEmptyString(value: string, flagName: string): string {
	if (typeof value !== "string" || value.length === 0) fail(`${flagName} is required`)
	if (/\s/.test(value)) fail(`${flagName} must not contain whitespace, got: ${JSON.stringify(value)}`)
	return value
}

// #412 CLI item-preset parser: exactly one of --preset or --preset-path is required for `coder-loop
// item add`. The CLI rejects locally so the operator gets an immediate, friendlier message before the
// daemon's structured error fires.
function parseItemPresetSpec(presetName: string | null, presetPath: string | null): { preset: string | null; presetPath: string | null } {
	if (presetName === null && presetPath === null) {
		fail("item add requires exactly one of --preset (bundled name) or --preset-path (absolute dir). Pass --preset gh-issue-pr-iteration / --preset single-phase-example / --preset-path /abs/path. Since #412 a chain no longer supplies preset to items.")
	}
	if (presetName !== null && presetPath !== null) {
		fail(`item add: --preset and --preset-path are mutually exclusive (got --preset=${presetName}, --preset-path=${presetPath})`)
	}
	if (presetPath !== null) {
		return { preset: null, presetPath: resolve(presetPath) }
	}
	return { preset: presetName, presetPath: null }
}

async function runStatusCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(statusCliCommand, args)
	if (parsed.kind !== "status") return
	const snapshot = await buildCoderLoopStatusSnapshot(parsed.args)
	StatusSnapshotBoundary.assert(snapshot)
	process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
}

// #409: `coder-loop logs` is daemonized. The CLI no longer reads the events file from disk —
// every read goes through the daemon's `logs.query` op, which is on the hard-deny-for-agent
// list. This closes the gap where an agent process that imports the codebase or runs the CLI
// could read the cross-run observability stream without any authorization seam. The CLI's
// `--follow` mode polls the daemon, identical to the old disk-poll cadence.
async function runLogsCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(logsCliCommand, args)
	if (parsed.kind !== "logs") return
	const logsArgs = parsed.args
	const requestArgs = logsQueryRequestArgs(logsArgs)
	const loopDataRoot = logsArgs.loopDataRoot ?? null
	if (!logsArgs.follow) {
		const result = await requestDaemonResult(loopDataRoot, "logs.query", requestArgs)
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`)
		return
	}
	let emitted = 0
	while (true) {
		const result = await requestDaemonResult(loopDataRoot, "logs.query", requestArgs)
		const events = Array.isArray(result.events) ? result.events : []
		for (const event of events.slice(emitted)) {
			process.stdout.write(`${JSON.stringify(event)}\n`)
		}
		emitted = events.length
		await sleep(1_000)
	}
}

function logsQueryRequestArgs(args: LogsCommandArgs): JsonObject {
	const requestArgs: JsonObject = {}
	if (args.kind !== null) {
		// CLI-side parse mirrors the pre-#409 fail-fast so the operator sees a friendlier message
		// before the daemon's structured error fires. The daemon re-parses defensively.
		requestArgs.kind = parseObservabilityKind(args.kind)
	}
	if (args.type !== null) requestArgs.type = parseObservabilityEventType(args.type)
	if (args.chainName !== null && args.chainName !== undefined) requestArgs.chain = args.chainName
	if (args.item !== null) requestArgs.item = args.item
	if (args.run !== null) requestArgs.run = args.run
	if (args.phase !== null) requestArgs.phase = args.phase
	if (args.since !== null) {
		if (Number.isNaN(Date.parse(args.since))) fail(`--since must be an ISO timestamp or Date.parse-compatible timestamp: ${args.since}`)
		requestArgs.since = args.since
	}
	return requestArgs
}

async function runChainCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(chainCliCommand, args)
	if (parsed.value.kind !== "chain") return
	const chainArgs = parsed.value.args
	if (chainArgs.action === "create") {
		const repository = requiredChainCreateString(chainArgs.configJson, "repository", "--config-json")
		const baseBranch = optionalChainCreateString(chainArgs.configJson, "baseBranch", "--config-json") ?? "main"
		// #433: `--config-json` retains the input shape (the operator surface stayed because it's the
		// chain-bindings entry point), but the wire shape now writes `metadata.bindings` and strips
		// non-binding chain-create scalars (repository/baseBranch are top-level chain-create fields,
		// not bindings). `normalizeChainCreateBindings` rejects nested misshapes — that arktype-driven
		// rejection is also enforced daemon-side, so a stray key fails fast either path.
		const bindings = normalizeChainCreateBindings(chainArgs.configJson)
		// #457: `--umbrella owner/repo#123` is operator shorthand that merges
		// `umbrellaRepo` / `umbrellaIssue` into the chain bindings. The engine has no first-class
		// understanding of these — they live as preset-declared chain bindings (consumed by the
		// bundled preset via `chain.umbrellaRepo` / `chain.umbrellaIssue`). Explicit
		// `--config-json '{"umbrellaRepo":"...","umbrellaIssue":...}'` keys win on conflict so the
		// operator can still override the shorthand.
		if (chainArgs.umbrella !== null) {
			const umbrellaBindings = parseUmbrellaRef(chainArgs.umbrella, repository)
			for (const [key, value] of Object.entries(umbrellaBindings)) {
				if (!Object.hasOwn(bindings, key)) bindings[key] = value
			}
		}
		const requestArgs: JsonObject = {
			name: chainArgs.name,
			repository,
			baseBranch,
			metadata: { bindings },
		}
		if (chainArgs.preset !== null) requestArgs.preset = chainArgs.preset
		if (chainArgs.force) requestArgs.force = true
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.create", requestArgs)
		writeCommandResult(result, chainArgs.json, formatChainCreateResult)
		return
	}
	if (chainArgs.action === "list") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.list")
		writeCommandResult(result, chainArgs.json, formatChainListResult)
		return
	}
	if (chainArgs.action === "status") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.status", { chainName: chainArgs.name })
		writeCommandResult(result, chainArgs.json, formatChainStatusResult)
		return
	}
	if (chainArgs.action === "stop") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.stop", { chainName: chainArgs.name })
		writeCommandResult(result, chainArgs.json, formatChainStopResult)
		return
	}
	if (chainArgs.action === "resume") {
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.resume", { chainName: chainArgs.name })
		writeCommandResult(result, chainArgs.json, formatChainResumeResult)
		return
	}
	if (chainArgs.action === "set-runner-model") {
		// #526: assemble the wire patch on the CLI side so the chain-action dispatch reads
		// like every other chain.* op (one branch, one daemon call, one formatter). The
		// daemon op re-validates `{<kind>: {model}}` with hand-rolled per-kind typeof
		// guards (`src/daemon.ts:1962-2005` — kind in {claude,codex,opencode} union with
		// model:string-non-whitespace), so the CLI passes the minimal shape it accepts.
		const patch: JsonObject = { [chainArgs.kind]: { model: chainArgs.model } }
		const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.updateBindings", {
			chainName: chainArgs.name,
			patch,
		})
		writeCommandResult(result, chainArgs.json, (obj) => formatChainSetRunnerModelResult(obj, chainArgs.name, chainArgs.kind, chainArgs.model))
		return
	}
	const result = await requestDaemonResult(chainArgs.loopDataRoot, "chain.delete", { chainName: chainArgs.name })
	writeCommandResult(result, chainArgs.json, formatChainDeleteResult)
}

async function runItemCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(itemCliCommand, args)
	if (parsed.value.kind !== "item") return
	const itemArgs = parsed.value.args
	if (itemArgs.action === "add") {
		const requestArgs: JsonObject = {
			chainName: itemArgs.chainName,
			itemId: itemArgs.itemId,
			repoCwd: itemArgs.repoCwd,
		}
		// #412 preset is required per-item; the CLI parser guarantees exactly one of these is set.
		assignCliOptional(requestArgs, "preset", itemArgs.preset)
		assignCliOptional(requestArgs, "presetPath", itemArgs.presetPath)
		assignCliOptional(requestArgs, "status", itemArgs.status)
		assignCliOptional(requestArgs, "attempts", itemArgs.attempts)
		assignCliOptional(requestArgs, "title", itemArgs.title)
		assignCliOptional(requestArgs, "priority", itemArgs.priority)
		assignCliOptional(requestArgs, "extra", itemArgs.fieldJson)
		assignCliOptional(requestArgs, "lastRunId", itemArgs.lastRunId)
		assignCliOptional(requestArgs, "issueFile", itemArgs.issueFile)
		assignCliOptional(requestArgs, "evidenceDir", itemArgs.evidenceDir)
		assignCliOptional(requestArgs, "agentCwd", itemArgs.agentCwd)
		assignCliOptional(requestArgs, "runner", itemArgs.runner)
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.add", requestArgs)
		writeCommandResult(result, itemArgs.json, formatItemMutationResult)
		return
	}
	if (itemArgs.action === "batch-add") {
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.batchAdd", { chainName: itemArgs.chainName, items: itemArgs.items })
		writeCommandResult(result, itemArgs.json, formatItemBatchAddResult)
		return
	}
	if (itemArgs.action === "list") {
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.list", { chainName: itemArgs.chainName })
		writeCommandResult(result, itemArgs.json, formatItemListResult)
		return
	}
	if (itemArgs.action === "reorder") {
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.reorder", {
			chainName: itemArgs.chainName,
			itemId: itemArgs.itemId,
			position: itemArgs.position,
		})
		writeCommandResult(result, itemArgs.json, formatItemListResult)
		return
	}
	if (itemArgs.action === "exits") {
		// #451: typed phase-exits query. Both agent-run-id and agent-phase travel
		// to the daemon so the handler resolves the right phase (the item's
		// last-write phase column is not the agent's currently-running phase).
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.exits", {
			chainName: itemArgs.chainName,
			itemId: itemArgs.itemId,
			agentRunId: itemArgs.agentRunId,
			agentPhase: itemArgs.agentPhase,
		})
		writeCommandResult(result, itemArgs.json, formatItemExitsResult)
		return
	}
	if (itemArgs.action === "exit-action") {
		// #405: chain-action exit selection. Same agent-binding shape as the
		// `exits` query — both agent-run-id and agent-phase travel to the daemon
		// so the gate can confirm the phase actually declares the requested
		// action and the bound run owns this item. Credential auto-attaches from
		// `CODER_LOOP_RUN_CRED` env via `withInjectedRunCredential`; operators
		// have no credential and are admitted through the operator branch.
		const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.exitAction", {
			chainName: itemArgs.chainName,
			itemId: itemArgs.itemId,
			agentRunId: itemArgs.agentRunId,
			agentPhase: itemArgs.agentPhase,
			action: itemArgs.chainAction,
		})
		writeCommandResult(result, itemArgs.json, formatItemExitActionResult)
		return
	}
	const fields: JsonObject = {}
	const requestArgs: JsonObject = {
		chainName: itemArgs.chainName,
		itemId: itemArgs.itemId,
		fields,
	}
	// #406: agent attribution no longer takes flat args here. `withInjectedRunCredential` attaches
	// `agentCredential` from `CODER_LOOP_RUN_CRED` env when the caller is an engine-spawned agent;
	// operator runs leave it unset and the daemon admits them as `operator`.
	assignCliOptional(fields, "repoCwd", itemArgs.repoCwd)
	assignCliOptional(fields, "status", itemArgs.status)
	assignCliOptional(fields, "title", itemArgs.title)
	assignCliOptional(fields, "priority", itemArgs.priority)
	assignCliOptional(fields, "extraPatch", itemArgs.fieldJson)
	assignCliOptional(fields, "issueFile", itemArgs.issueFile)
	assignCliOptional(fields, "evidenceDir", itemArgs.evidenceDir)
	assignCliOptional(fields, "runner", itemArgs.runner)
	if (Object.keys(fields).length === 0) fail("item update requires at least one field to update")
	const result = await requestDaemonResult(itemArgs.loopDataRoot, "item.update", requestArgs)
	writeCommandResult(result, itemArgs.json, formatItemMutationResult)
}

function assignCliOptional(target: JsonObject, key: string, value: JsonValue | undefined): void {
	if (value !== undefined && value !== null) target[key] = value
}

function isJsonObjectRecord(value: BoundaryValue): value is JsonObject {
	return isJsonObject(value)
}

function parseOptionalJsonObjectFlag(raw: string | null, flagName: string): JsonObject | null {
	if (raw === null) return null
	let parsed: BoundaryValue
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		fail(`${flagName} must be a JSON object: ${errorMessage(error)}`)
	}
	if (!isJsonObject(parsed)) fail(`${flagName} must be a JSON object`)
	return parsed
}

function requiredChainCreateString(config: JsonObject, field: string, flagName: string): string {
	const value = config[field]
	if (typeof value !== "string" || value.trim() === "") fail(`${flagName}.${field} must be a non-empty string`)
	return value
}

function optionalChainCreateString(config: JsonObject, field: string, flagName: string): string | null {
	const value = config[field]
	if (value === undefined || value === null) return null
	if (typeof value !== "string" || value.trim() === "") fail(`${flagName}.${field} must be a non-empty string when provided`)
	return value
}

function parseBatchItemsJson(raw: string): JsonObject[] {
	let parsed: BoundaryValue
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		fail(`--items-json must be a JSON array: ${errorMessage(error)}`)
	}
	if (!Array.isArray(parsed)) fail("--items-json must be a JSON array")
	return parsed.map((entry, index) => {
		if (!isJsonObjectRecord(entry)) fail(`--items-json[${index}] must be an object`)
		const item: JsonObject = { ...entry }
		// #419: legacy back-fill for batch JSON written against pre-#419 schemas. Two flavors:
		// (a) `{ "issue": 123 }` was sugar for `{ "issueNumber": 123 }` in pre-#419 batch JSON;
		// (b) `{ "issueNumber": 123 }` was the canonical pre-#419 form. Both map to the new
		// `itemId` string wire field. Values are coerced to strings — the daemon enforces shape.
		if (item.itemId === undefined) {
			if (typeof item.issue === "number") {
				item.itemId = String(item.issue)
				delete item.issue
			} else if (typeof item.issue === "string" && item.issue.length > 0) {
				item.itemId = item.issue
				delete item.issue
			} else if (typeof item.issueNumber === "number") {
				item.itemId = String(item.issueNumber)
				delete item.issueNumber
			}
		}
		if (typeof item.repoCwd === "string") item.repoCwd = resolve(item.repoCwd)
		return item
	})
}

// #457: parses `owner/repo#123` / `#123` into chain-binding pairs the caller
// merges into `metadata.bindings`. Umbrella values are not engine first-class
// fields any more — the bundled preset reads them via `chain.umbrellaRepo`
// / `chain.umbrellaIssue` against the declared-binding namespace.
function parseUmbrellaRef(raw: string, defaultRepo: string): JsonObject {
	const trimmed = raw.trim()
	const match = /^(?:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<issue>[1-9][0-9]*)$/.exec(trimmed)
	if (match === null) fail(`--umbrella must look like owner/repo#123 or #123, got: ${raw}`)
	const issue = Number(match.groups?.issue)
	const repo = match.groups?.repo ?? defaultRepo
	return {
		umbrellaRepo: repo,
		umbrellaIssue: issue,
	}
}

async function runCentralDaemonStatusCommand(args: string[]): Promise<void> {
	const options = parseCentralDaemonSocketOptions(args, "daemon status")
	const result = await requestDaemonResultForDaemonCommand(options.loopDataRoot, "daemon.status", {}, options.json)
	if (result === null) return
	writeCommandResult(result, options.json, formatDaemonStatusResult)
}

function isCentralDaemonStatusInvocation(args: string[]): boolean {
	if (args[0] !== "status") return false
	if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) return false
	return !hasPositionalArgument(args.slice(1))
}

function hasPositionalArgument(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) continue
		if (!arg.startsWith("-")) return true
		const [name, inlineValue] = splitFlag(arg)
		if (inlineValue !== null) continue
		if (name === "--loop-data-root") index++
	}
	return false
}

function parseCentralDaemonSocketOptions(args: string[], usage: string): { loopDataRoot: string | null; json: boolean } {
	let loopDataRoot: string | null = null
	let json = false
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) fail(`${usage}: missing argument at index ${index}`)
		const [name, inlineValue] = splitFlag(arg)
		switch (name) {
			case "--loop-data-root":
				loopDataRoot = readFlagValue(args, index, inlineValue, name)
				if (inlineValue === null) index++
				break
			case "--json":
				rejectInlineValue(inlineValue, name)
				json = true
				break
			default:
				fail(`${usage}: unrecognized argument ${arg}`)
		}
	}
	return { loopDataRoot, json }
}

async function requestDaemonResult(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject = {}): Promise<JsonObject> {
	const pathOptions = loopDataRoot === null ? {} : { loopDataRoot }
	const socketPath = resolveLoopDataPaths(pathOptions).daemonSocket
	// #406: auto-attach the run-scoped credential from the spawn-time env. The agent is the only
	// caller whose process env carries `CODER_LOOP_RUN_CRED` (scheduler.ts injects it at spawn);
	// operator invocations see no env var, so `agentCredential` is omitted and the daemon's
	// caller-admission gate flows the operator branch. Zero hand-copy by design — the agent
	// neither sees the value (it lives only in env) nor has to forward it (the CLI does).
	const augmentedArgs = withInjectedRunCredential(command, args)
	let response: Awaited<ReturnType<typeof sendDaemonRequest>>
	try {
		response = await sendDaemonRequest(socketPath, daemonRequest(command, augmentedArgs))
	} catch (error) {
		const failure = await daemonConnectionFailure(loopDataRoot, error)
		fail(failure.message)
	}
	if (!response.ok) fail(`${response.error.code}: ${response.error.message}`)
	return response.result
}

// #406 / #407 / #405 / #409: command-scoped credential auto-injection. Every daemon command an
// agent might reach where the daemon makes an authorization decision (item-mutation gates AND
// caller-stratified hard-deny / per-phase gates) is listed here so the daemon sees the agent's
// env-borne credential and routes the request through the correct branch.
//
// Pre-#409 this set covered only the item-mutation gates; an agent's `coder-loop chain delete`
// or `daemon down` call therefore reached the daemon WITHOUT `agentCredential`, the resolver
// treated it as an operator, and the request landed — exactly the gap #409 closes. The set now
// also covers the #409 hard-deny family (chain lifecycle / daemon.down / logs.query /
// queue.unblock) and the per-phase-authorized family (item.reorder) so the daemon's caller
// stratification has the credential to decide on.
//
// Commands explicitly omitted (read-only or daemon-internal):
//   - chain.list / chain.status / item.list / item.exits / daemon.status — read-no-auth class.
//   - the credential is never injected into requests the daemon would ignore, so its lifetime
//     stays bound to the agent's run process even when CLI tooling broadens.
//
// `as const` literal union here is the only `as` form the project allows — a literal narrow,
// not a type-bypass cast.
const AGENT_ATTRIBUTED_COMMANDS = [
	"item.update",
	"item.add",
	"item.batchAdd",
	"item.exitAction",
	"item.reorder",
	"chain.create",
	"chain.stop",
	"chain.resume",
	"chain.delete",
	"daemon.down",
	"logs.query",
	"queue.unblock",
	"context.append.begin",
	"context.append.chunk",
	"context.append.commit",
] as const
type AgentAttributedCommand = typeof AGENT_ATTRIBUTED_COMMANDS[number]

function isAgentAttributedCommand(command: DaemonCommandName): command is AgentAttributedCommand {
	return (AGENT_ATTRIBUTED_COMMANDS as readonly DaemonCommandName[]).includes(command)
}

function withInjectedRunCredential(command: DaemonCommandName, args: JsonObject): JsonObject {
	if (!isAgentAttributedCommand(command)) return args
	const value = process.env[LOOP_RUN_CREDENTIAL_ENV]
	if (typeof value !== "string" || value === "") return args
	// Operator path explicitness: if the caller already supplied agentCredential (test fixtures
	// that exercise the gate directly), respect it instead of overwriting from env.
	if (Object.hasOwn(args, "agentCredential")) return args
	return { ...args, agentCredential: value }
}

async function requestDaemonResultForDaemonCommand(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject, json: boolean): Promise<JsonObject | null> {
	const response = await sendDaemonRequestForDaemonCommand(loopDataRoot, command, args, json)
	if (response === null) return null
	if (!response.ok) {
		if (json) {
			writeDaemonErrorResponse(daemonErrorResponse(response.error.code, response.error.message, response.error.details ?? {}))
			return null
		}
		fail(`${response.error.code}: ${response.error.message}`)
	}
	return response.result
}

async function sendDaemonRequestForDaemonCommand(loopDataRoot: string | null, command: DaemonCommandName, args: JsonObject, json: boolean): Promise<DaemonResponse | null> {
	let socketPath: string
	try {
		socketPath = resolveLoopDataPaths(loopDataRoot === null ? {} : { loopDataRoot }).daemonSocket
	} catch (error) {
		if (json) {
			writeDaemonErrorResponse(daemonCliErrorResponse(error, "invalid_loop_data_root"))
			return null
		}
		throw error
	}

	// #409: thread the agent's env-borne credential through this transport too. Pre-fix,
	// `runDaemonDownCommand` reached the daemon via this helper without going through
	// `withInjectedRunCredential`, so `daemon.down`'s `hard-deny-for-agent` classification
	// became unreachable dead code — an agent could `coder-loop daemon down` cleanly while
	// row 1 of #409 demands the opposite. The injector itself is a no-op when `command` is
	// not in `AGENT_ATTRIBUTED_COMMANDS` (e.g. `daemon.status`, which the other caller of
	// this helper uses), so the operator path is preserved on read commands too.
	const augmentedArgs = withInjectedRunCredential(command, args)
	try {
		return await sendDaemonRequest(socketPath, daemonRequest(command, augmentedArgs))
	} catch (error) {
		const failure = await daemonConnectionFailure(loopDataRoot, error)
		if (json) {
			writeDaemonErrorResponse(daemonErrorResponse(failure.code, failure.message, failure.details))
			return null
		}
		fail(failure.message)
	}
}

type DaemonConnectionFailure = {
	code: string
	message: string
	details: JsonObject
}

async function daemonConnectionFailure(loopDataRoot: string | null, error: BoundaryError): Promise<DaemonConnectionFailure> {
	const pathOptions = loopDataRoot === null ? {} : { loopDataRoot }
	const paths = resolveLoopDataPaths(pathOptions)
	const pathIssue = await detectDaemonSocketPathIssue(paths.daemonSocket, paths.daemonPid)
	if (pathIssue !== null) {
		const daemonError = daemonSocketPathIssueError(pathIssue)
		const details: JsonObject = { ...daemonError.details }
		if (isNodeError(error) && typeof error.code === "string") details.causeCode = error.code
		return {
			code: daemonError.code,
			message: daemonError.message,
			details,
		}
	}
	const details: JsonObject = { socketPath: paths.daemonSocket }
	if (loopDataRoot !== null) details.loopDataRoot = loopDataRoot
	if (isNodeError(error) && typeof error.code === "string") details.causeCode = error.code
	return {
		code: "daemon_not_running",
		message: centralDaemonNotRunningMessage(loopDataRoot, paths.daemonSocket, error),
		details,
	}
}

function centralDaemonNotRunningMessage(loopDataRoot: string | null, socketPath: string, error: BoundaryError): string {
	const hint = loopDataRoot === null ? "coder-loop daemon up" : `coder-loop daemon up --loop-data-root ${loopDataRoot}`
	const detail = isNodeError(error) && typeof error.code === "string" ? `${error.code}: ${errorMessage(error)}` : errorMessage(error)
	return `central daemon is not running at ${socketPath}; start it with \`${hint}\`. ${detail}`
}

function daemonCliErrorResponse(error: BoundaryError, fallbackCode: string): JsonObject {
	if (error instanceof DaemonError) return daemonErrorResponse(error.code, error.message, error.details)
	if (error instanceof RuntimePathError) {
		return daemonErrorResponse(error.code, error.message, { input: error.input })
	}
	return daemonErrorResponse(fallbackCode, errorMessage(error))
}

function daemonErrorResponse(code: string, message: string, details: JsonObject = {}): JsonObject {
	const error: JsonObject = { code, message }
	if (Object.keys(details).length > 0) error.details = details
	return { ok: false, error }
}

function writeDaemonErrorResponse(response: JsonObject): void {
	process.stdout.write(`${JSON.stringify(response, null, "\t")}\n`)
	process.exitCode = 1
}

function writeCommandResult(result: JsonObject, json: boolean, formatText: (result: JsonObject) => string): void {
	writeJsonOrText(result, json, formatText)
}

function writeJsonOrText(result: JsonObject, json: boolean, formatText: (result: JsonObject) => string): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`)
		return
	}
	process.stdout.write(formatText(result))
}

function formatChainCreateResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	return `created chain ${String(chain?.name ?? "")}\n`
}

function formatChainListResult(result: JsonObject): string {
	const chains = Array.isArray(result.chains) ? result.chains : []
	if (chains.length === 0) return "no chains\n"
	return chains.map((raw) => {
		const chain = jsonObjectEntry(raw) ?? {}
		return `${String(chain.name)}\t${String(chain.status)}\t${String(chain.repository)}\n`
	}).join("")
}

function formatChainStatusResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	const summary = jsonObjectEntry(result.summary)
	const items = jsonObjectEntry(summary?.items)
	const total = typeof items?.total === "number" ? items.total : 0
	const activeSlots = Array.isArray(summary?.activeSlots) ? summary.activeSlots.length : 0
	return [
		`chain: ${String(chain?.name ?? "")}`,
		`status: ${String(chain?.status ?? "")}`,
		`repository: ${String(chain?.repository ?? "")}`,
		`items: ${total}`,
		`activeSlots: ${activeSlots}`,
		"",
	].join("\n")
}

function formatChainStopResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	return `stopped chain ${String(chain?.name ?? "")}\n`
}

function formatChainResumeResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	return `resumed chain ${String(chain?.name ?? "")}\n`
}

function formatChainDeleteResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	return `deleted chain ${String(chain?.name ?? "")}\n`
}

// #526: text formatter for `chain set-runner-model`. Echoes which chain / runner /
// model the operator targeted plus the daemon-reported idempotency outcome (so a
// re-run that already matches the stored binding prints `alreadyMatched: yes`,
// matching the no-op semantics of `chain.updateBindings`). `--json` still passes
// the daemon reply through verbatim via `writeCommandResult`.
function formatChainSetRunnerModelResult(result: JsonObject, name: string, kind: AgentRunnerKind, model: string): string {
	const updatedKinds = Array.isArray(result.updatedKinds) ? result.updatedKinds.filter((entry): entry is string => typeof entry === "string") : []
	const alreadyMatched = result.alreadyMatched === true
	return [
		`chain: ${name}`,
		`kind: ${kind}`,
		`model: ${model}`,
		`alreadyMatched: ${alreadyMatched ? "yes" : "no"}`,
		`updatedKinds: ${updatedKinds.length === 0 ? "<none>" : updatedKinds.join(", ")}`,
		"",
	].join("\n")
}

function formatItemMutationResult(result: JsonObject): string {
	const item = jsonObjectEntry(result.item)
	// #419: prefer `itemId` (the post-retirement opaque string id surfaced by `itemToJson`); fall
	// back to the rowid only when itemId is somehow missing (legacy daemon response shapes that
	// pre-date #419 — keeps the formatter robust against version skew while operators upgrade).
	return `item ${String(item?.itemId ?? item?.id ?? "")}: ${String(item?.status ?? "")}\n`
}

function formatItemBatchAddResult(result: JsonObject): string {
	const items = Array.isArray(result.items) ? result.items : []
	return `added ${items.length} item(s)\n`
}

function formatItemListResult(result: JsonObject): string {
	const items = Array.isArray(result.items) ? result.items : []
	if (items.length === 0) return "no items\n"
	return items.map((raw) => {
		const item = jsonObjectEntry(raw) ?? {}
		// #419: render the opaque item id (formerly `issueNumber`). Daemon's `itemToJson` emits
		// both `itemId` and `id` (rowid); itemId is the preset-facing identity.
		return `${String(item.itemId ?? item.id ?? "")}\t${String(item.status)}\t${String(item.repoCwd)}\n`
	}).join("")
}

// #451 + #405 text formatter for the typed phase-exits query. Parses the wire
// shape through the arktype boundary before rendering — guarantees that a
// daemon version drift cannot quietly print malformed exits to the agent. The
// ADT (item-status | chain-action) renders each branch with the writer command
// the agent must use to select it.
function formatItemExitsResult(result: JsonObject): string {
	const parsed = ItemExitsResponseBoundary.assert(result)
	if (parsed.exits.length === 0) {
		return `phase: ${parsed.phase}\nexits: <none> (phase declares no [[phases.exits]]; default-deny rejects all status writes and chain-action selections)\n`
	}
	const rows = parsed.exits.map((exit) => {
		switch (exit.kind) {
			case "item-status":
				return `  - item-status ${exit.status} (writer: coder-loop item update --status ${exit.status}): ${exit.when}`
			case "chain-action":
				return `  - chain-action ${exit.action} (writer: coder-loop item exit-action --action ${exit.action}): ${exit.when}`
			default:
				return assertNeverPhaseExit(exit)
		}
	}).join("\n")
	return `phase: ${parsed.phase}\nexits:\n${rows}\n`
}

// #405 text formatter for the chain-action exit-selection response. The daemon
// returns the chain status after the action takes effect (e.g., `stopped` after
// `action: stop`) plus a brief account of terminated/ongoing runs.
function formatItemExitActionResult(result: JsonObject): string {
	const chain = jsonObjectEntry(result.chain)
	const action = typeof result.action === "string" ? result.action : ""
	const chainStatus = chain === undefined ? "" : String(chain.status ?? "")
	const terminatedRuns = Array.isArray(result.terminatedRuns) ? result.terminatedRuns : []
	const header = `exit-action: action=${action} chain=${String(chain?.name ?? "")} chainStatus=${chainStatus}\n`
	if (terminatedRuns.length === 0) return header
	return header + terminatedRuns.map((run) => {
		const record = jsonObjectEntry(run) ?? {}
		return `terminatedRun: runId=${String(record.runId ?? "")} exitCode=${String(record.exitCode ?? "")}\n`
	}).join("")
}

function formatDaemonStatusResult(result: JsonObject): string {
	const daemon = jsonObjectEntry(result.daemon)
	const activeRuns = Array.isArray(daemon?.activeRuns) ? daemon.activeRuns.length : 0
	return [
		`pid: ${String(daemon?.pid ?? "")}`,
		`running: ${String(daemon?.running ?? "")}`,
		`socket: ${String(daemon?.socketPath ?? "")}`,
		`activeRuns: ${activeRuns}`,
		"",
	].join("\n")
}

function formatDaemonUpResult(result: JsonObject): string {
	return `daemon up: pid=${String(result.pid ?? "")} socket=${String(result.socketPath ?? "")}\n`
}

function formatDaemonDownResult(result: JsonObject): string {
	const daemon = jsonObjectEntry(result.daemon)
	let output = `daemon down: shutdown=${String(result.shutdown ?? false)} pid=${String(daemon?.pid ?? "")} socket=${String(daemon?.socketPath ?? "")}\n`
	const terminatedRuns = Array.isArray(result.terminatedRuns) ? result.terminatedRuns : []
	for (const run of terminatedRuns) {
		const record = jsonObjectEntry(run) ?? {}
		output += `daemon down: terminated run=${String(record.runId ?? "")} exitCode=${String(record.exitCode ?? "")}\n`
	}
	return output
}

function formatDaemonStartResult(result: JsonObject): string {
	if (result.dryRun === true) {
		return [
			`daemon start dry-run: target=${String(result.target ?? "")}`,
			`daemon start dry-run: chain=${String(result.chain ?? "")}`,
			`daemon start dry-run: central-daemon=${String(result.centralDaemon ?? "required")}`,
			"",
		].join("\n")
	}
	const daemon = jsonObjectEntry(result.daemon)
	return `daemon start: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} already-running=${String(result.alreadyRunning ?? false)} pid=${String(daemon?.pid ?? "")}\n`
}

function formatDaemonStopResult(result: JsonObject): string {
	if (result.dryRun === true) return `daemon stop dry-run: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")}\n`
	const mutation = jsonObjectEntry(result.result)
	const chain = jsonObjectEntry(mutation?.chain)
	return `daemon stop: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} status=${String(chain?.status ?? "")}\n`
}

function formatDaemonRestartResult(result: JsonObject): string {
	if (result.dryRun === true) {
		return `daemon restart dry-run: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} central-daemon=${String(result.centralDaemon ?? "required")}\n`
	}
	const daemon = jsonObjectEntry(result.daemon)
	return `daemon restart: target=${String(result.target ?? "")} chain=${String(result.chain ?? "")} restarted=${String(result.restarted ?? false)} pid=${String(daemon?.pid ?? "")}\n`
}

function jsonObjectEntry(value: JsonValue | undefined): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined
}

async function runDaemonCommand(args: string[]): Promise<void> {
	if (isCentralDaemonStatusInvocation(args)) {
		await runCentralDaemonStatusCommand(args)
		return
	}
	const parsed = await runCmd(daemonCliCommand, args)
	if (parsed.value.kind !== "daemon") return
	const daemonArgs = parsed.value.args
	if (daemonArgs.action === "up") {
		await runDaemonUpCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "down") {
		await runDaemonDownCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "status") {
		const snapshot = await buildCoderLoopStatusSnapshot({
			targetCwd: daemonArgs.targetCwd,
			loopDataRoot: daemonArgs.loopDataRoot ?? null,
			chainName: daemonArgs.chainName ?? null,
			output: "json",
		})
		StatusSnapshotBoundary.assert(snapshot)
		process.stdout.write(`${stringifyStatusSnapshot(snapshot)}\n`)
		return
	}
	if (daemonArgs.action === "start") {
		await runDaemonStartCommand(daemonArgs)
		return
	}
	if (daemonArgs.action === "stop") {
		await runDaemonStopCommand(daemonArgs)
		return
	}
	await runDaemonRestartCommand(daemonArgs)
}

async function runQueueCommand(args: string[]): Promise<void> {
	const parsed = await runCmd(queueCliCommand, args)
	if (parsed.value.kind !== "queue") return
	await runQueueUnblockCommand(parsed.value.args)
}

export function projectCompiledPreset(model: CompiledTaskModel, findings: readonly CompileWarning[]): PresetCompileProjection {
	const statusNodes = [...model.statuses.continuable, ...model.statuses.terminal].map((status) => ({
		identity: `status:${status}`,
		status,
		classification: model.statuses.continuable.includes(status) ? "continuable" as const : "terminal" as const,
	}))
	const phaseEdges = model.phases.flatMap((phase) => phase.exits
		.filter((exit): exit is PresetPhaseExitItemStatus => exit.kind === "item-status")
		.map((exit) => ({ kind: "phase-exit" as const, phase: phase.name, to: exit.status, when: exit.when })))
	const projection = {
		schemaVersion: 1 as const,
		preset: {
			name: model.name,
			dir: model.sourceDir,
			sourceHash: model.sourceHash,
			taskTree: { kind: model.tasks.kind, identity: model.tasks.identity },
		},
		statuses: {
			continuable: [...model.statuses.continuable],
			terminal: [...model.statuses.terminal],
			success: [...model.statuses.success],
			entry: model.statuses.entry,
			unblockable: [...model.statuses.unblockable],
			exhausted: model.statuses.exhausted,
			retry: model.statuses.retry,
		},
		stateGraph: {
			nodes: statusNodes,
			edges: [
				{ kind: "engine-entry" as const, to: model.statuses.entry },
				{ kind: "engine-exhausted" as const, to: model.statuses.exhausted },
				...model.statuses.unblockable.map((from) => ({ kind: "engine-unblock" as const, from, to: model.statuses.entry })),
				...phaseEdges,
			],
		},
		phases: model.phases.map((phase) => {
			const taskTree = model.tasks.children.find((candidate) => candidate.phase === phase.name)
			if (taskTree === undefined) throw new CoderLoopError(`compiled task tree missing phase ${phase.name}`)
			return ({
			identity: taskTree.identity,
			name: phase.name,
			exits: [...phase.exits],
			trigger: phase.trigger,
			runner: phase.defaultRunner,
			model: phase.defaultModel,
			variables: phase.variables.map((variable) => ({ key: variable.key, type: "string" as const, sourceKind: variable.source.kind })),
			toolRequirements: [],
			rights: { createItems: phase.rights.createItems, writableFields: [...phase.rights.writableFields], privilegedOps: [...phase.rights.privilegedOps] },
			taskTree: {
				kind: taskTree.kind,
				identity: taskTree.identity,
				children: taskTree.children.map((child) => ({ ...child })),
			},
		})}),
		tools: [],
		fragments: model.fragments.map((fragment) => ({ id: fragment.id, role: fragment.role, path: relative(model.presetDir, fragment.path) })),
		findings: [...findings],
	}
	PresetCompileProjectionBoundary.assert(projection)
	return projection
}

export function projectPresetCompileResult(result: CompileResult): PresetCompilePublicResult {
	const projected = result.kind === "compiled"
		? { kind: "compiled" as const, schemaVersion: 1 as const, projection: projectCompiledPreset(result.model, result.warnings) }
		: { kind: "rejected" as const, schemaVersion: 1 as const, diagnostics: result.diagnostics }
	return PresetCompilePublicResultBoundary.assert(projected)
}

function parsePresetCompileCliArgs(args: string[]): PresetCompileCliArgs {
	if (!PresetCompileCliArgsBoundary.allows(args)) fail("Usage: coder-loop preset compile <name|path> --json")
	return PresetCompileCliArgsBoundary.assert(args)
}

async function resolvePresetCompileSource(source: string): Promise<PresetCompileSourceResolution> {
	const cwdRelative = resolve(process.cwd(), source)
	try {
		if ((await stat(cwdRelative)).isDirectory()) return { kind: "resolved", presetDir: cwdRelative }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { kind: "resolved", presetDir: PRESET_NAME_PATTERN.test(source) ? resolve(PKG_ROOT, "presets", source) : cwdRelative }
		}
		if (isNodeError(error) && typeof error.code === "string") {
			return { kind: "rejected", diagnostics: [presetSourceDiagnostic(error, error.code)] }
		}
		throw error
	}
	return { kind: "resolved", presetDir: PRESET_NAME_PATTERN.test(source) ? resolve(PKG_ROOT, "presets", source) : cwdRelative }
}

async function runPresetCommand(args: string[]): Promise<void> {
	const [, source] = parsePresetCompileCliArgs(args)
	const resolution = await resolvePresetCompileSource(source)
	const result = resolution.kind === "resolved" ? await compilePreset(resolution.presetDir) : resolution
	if (result.kind === "rejected") {
		process.stderr.write(`${JSON.stringify(projectPresetCompileResult(result))}\n`)
		process.exitCode = 1
		return
	}
	const publicResult = projectPresetCompileResult(result)
	if (publicResult.kind !== "compiled") throw new CoderLoopError("compiled result projection changed variant")
	process.stdout.write(`${JSON.stringify(publicResult.projection)}\n`)
}

async function main() {
	const firstArg = process.argv[2]
	if (firstArg === "status") {
		await runStatusCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "logs") {
		await runLogsCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "daemon") {
		await runDaemonCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "chain") {
		await runChainCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "item") {
		await runItemCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "queue") {
		await runQueueCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "preset") {
		await runPresetCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "context") {
		await runContextCommand(process.argv.slice(3))
		return
	}
	if (firstArg === "doctor") {
		const handled = await dispatchSubcommand(firstArg, process.argv.slice(3))
		if (handled) return
	}
	process.stdout.write(rootUsage())
	process.exitCode = 1
}

function rootUsage(): string {
	return [
		"Usage: coder-loop <command> [options]",
		"",
		"Commands:",
		"  status <target> --json",
		"  logs <target> --json [--kind K] [--type T] [--chain C] [--item ID] [--run RUN_ID] [--phase P] [--since TS] [--follow]",
		"  daemon <up|down|status|start|stop|restart>",
		"  chain <create|list|status|stop|resume|delete|set-runner-model>",
		"  item <add|batch-add|list|update|reorder|exits|exit-action>",
		"  queue unblock <target> --issue <issue>",
		"  context append <chain> --scope <chain|item|group> --body <text>",
		"  doctor <target>",
		"  preset compile <name|path> --json",
		"",
	].join("\n")
}

// #405 retired: the v1 review-driver function (and its stop-request derivative)
// had zero callers — the v2 daemon path spawns the review phase through
// `scheduler.ts` and never consumed any stdout flow signal. The function and
// the stdout-parser family it depended on are deleted; review's terminal action
// now flows through #451's typed phase-exits face exclusively.

function buildOptions(targetCwd: string, raw: BuildOptionsInput, resolved: ChainResolved, preset: Preset): LoopOptions {
	// #505: `resolved.{sharedContextFile,issueDir,evidenceDir,logDir}` are produced
	// by `chainResolvedFromChain` and always non-null (chain.metadata.X if present,
	// else the chain-derived path from `chainRuntimePathForKind`). The previous
	// `?? DEFAULT_*` target-relative fallback was dead and has been retired.
	const sharedContextPath = resolveFrom(targetCwd, resolved.sharedContextFile)
	const loopDataRoot = raw.loopDataRoot ?? resolved.loopDataRoot
	const stateDbPath = resolveLoopDataPaths(loopDataRootOption(loopDataRoot)).dbFile
	const issueDir = resolveFrom(targetCwd, resolved.issueDir)
	const evidenceRootDir = resolveFrom(targetCwd, resolved.evidenceDir)
	const logDir = resolveFrom(targetCwd, resolved.logDir)
	const worktree = raw.worktree || resolved.worktree === true
	const repository = raw.chain.repository
	const baseBranch = raw.chain.baseBranch
	const bindings = buildEffectiveBindings(raw.chain)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	const chainPaths = raw.chainName === null ? null : resolveChainRuntimePaths(raw.chainName, loopDataRootOption(loopDataRoot))
	const hostRunner = detectHostRunner(process.env)
	const runnerCommands = buildAgentRunnerCommands(resolved)
	const defaultRunner = selectPhaseDefaultRunner(firstNonTriggerPhaseForPreset(preset), preset, runnerCommands)

	return {
		targetCwd,
		sharedContextPath,
		stateDbPath,
		issueDir,
		evidenceRootDir,
		logDir,
		loopDataRoot,
		logFile: chainPaths === null ? resolve(logDir, `coder-loop-${process.pid}.${timestamp}.log`) : chainPaths.daemonLogFile(timestamp),
		repository,
		baseBranch,
		bindings,
		chainName: raw.chainName,
		worktree,
		hostRunner,
		defaultRunner,
		runnerCommands,
		dryRun: raw.dryRun,
		preset,
	}
}

export async function buildCoderLoopStatusSnapshot(args: StatusCommandArgs): Promise<CoderLoopStatusSnapshot> {
	let loaded: LoadedTargetRuntime
	try {
		loaded = await loadTargetRuntime({
			targetCwd: args.targetCwd,
			loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chainName ?? null,
			repository: null,
			baseBranch: null,
			dryRun: false,
			worktree: false,
			chainStatusScope: "status-snapshot",
		})
	} catch (error) {
		const targetCwd = resolve(args.targetCwd)
		const dbFile = resolveLoopDataPaths(loopDataRootOption(args.loopDataRoot ?? null)).dbFile
		const processes = await buildCentralStatusProcessSnapshot({
			targetCwd,
			loopDataRoot: args.loopDataRoot ?? null,
		})
		return makeUnavailableStatusSnapshot({
			target: makeStatusTargetSnapshot(targetCwd, dbFile, null),
			stateKind: "missing-state",
			stateDbPath: dbFile,
			errorPath: "chain",
			errorMessage: errorMessage(error),
			processes,
		})
	}
	const options = loaded.options
	const target = makeStatusTargetSnapshot(options.targetCwd, options.stateDbPath, options)
	const items = readDbItemsForChain(options.loopDataRoot, loaded.chain.id)
	const current = readDbCurrentRun(options.loopDataRoot, loaded.chain.id)
	// #412: status snapshot must resolve continuable / terminal / idField from each item's own preset
	// so mixed-preset chains stay selectable after chain-preset items finish. The resolver caches
	// loaded presets by directory so we read each preset.toml at most once per snapshot, and falls
	// back to the chain seed `options.preset` for legacy items that declare no preset.
	const itemPresets = await loadStatusItemPresets(options, items)
	const selected = pickFirstSelectableStatusItem(options, loaded.chain, items, current, itemPresets)
	const runtimeErrors = await collectStatusRuntimeErrors(options, loaded.chain, items, current, itemPresets)
	const currentSnapshot = await buildStatusCurrentSnapshotFromRecords(options, items, current, itemPresets)
	const events = await buildStatusEventsSnapshotFromRecords(options, current, selected, items)
	const processes = await buildCentralStatusProcessSnapshot(options)
	const snapshot: CoderLoopStatusSnapshot = {
		target,
		state: {
			kind: runtimeErrors.length === 0 ? "ok" : "invalid-runtime",
			ok: runtimeErrors.length === 0,
			loaded: true,
			path: resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).dbFile,
			version: STATUS_SNAPSHOT_STATE_VERSION,
			repository: loaded.chain.repository,
			baseBranch: loaded.chain.baseBranch,
			errors: runtimeErrors,
			error: null,
		},
		queue: buildStatusQueueSnapshotFromRecords(options, items, selected, itemPresets),
		runs: buildStatusRunsSnapshot(readDbRunsForChain(options.loopDataRoot, loaded.chain.id)),
		current: currentSnapshot,
		events,
		processes,
	}
	StatusSnapshotBoundary.assert(snapshot)
	return snapshot
}

// #412: per-item preset resolver used by status snapshot paths. The resolver loads each unique
// preset directory at most once per snapshot (TOML + phase prompt readability checks are not
// free) and returns the chain seed `options.preset` for items that declare no preset of their
// own. Failures loading an item-declared preset propagate — a broken preset is a real config
// error, not a fall-back-silently case.
export type StatusItemPresetResolver = {
	presetForItem(item: ItemRecord): Preset
	presetDirForItem(item: ItemRecord): string
}

async function loadStatusItemPresets(options: LoopOptions, items: readonly ItemRecord[]): Promise<StatusItemPresetResolver> {
	const cache = new Map<string, Preset>()
	cache.set(options.preset.presetDir, options.preset)
	for (const item of items) {
		if (item.preset === null && item.presetPath === null) continue
		const presetDir = resolveItemPresetDirForStatus(item)
		if (cache.has(presetDir)) continue
		const loaded = await loadPreset(presetDir)
		cache.set(presetDir, loaded)
	}
	return {
		presetForItem(item: ItemRecord): Preset {
			if (item.preset === null && item.presetPath === null) return options.preset
			const presetDir = resolveItemPresetDirForStatus(item)
			const cached = cache.get(presetDir)
			if (cached === undefined) throw new Error(`status: preset cache miss for item id=${item.id} presetDir=${presetDir}`)
			return cached
		},
		presetDirForItem(item: ItemRecord): string {
			if (item.preset === null && item.presetPath === null) return options.preset.presetDir
			return resolveItemPresetDirForStatus(item)
		},
	}
}

function resolveItemPresetDirForStatus(item: ItemRecord): string {
	if (item.presetPath !== null) return item.presetPath
	if (item.preset !== null) return resolvePresetDir({ preset: item.preset, presetPath: null }, PKG_ROOT, item.repoCwd)
	throw new Error(`resolveItemPresetDirForStatus: item id=${item.id} declares neither preset nor presetPath`)
}

type StatusReadResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "missing"; message: string }
	| { kind: "invalid"; message: string }

// #433: target-side runtime readers retired — `loadTargetRuntime` reads from chain metadata
// directly. Status snapshot still calls `makeStatusTargetSnapshot` for the unavailable snapshot
// branch, where there's no `options` yet because chain load failed.
// #505: the previous target-relative runtimeRoot fallback (formerly resolved under the
// target's own runtime directory) is retired. When `options === null` (chain failed to
// load — the only path here) the four chain-derived path fields are surfaced as empty
// strings to mark them unavailable; callers either render the empty value or branch on
// `state.kind !== "ok"` first.

function makeStatusTargetSnapshot(
	targetCwd: string,
	stateDbPath: string,
	options: LoopOptions | null,
): StatusTargetSnapshot {
	const preset = options === null ? null : {
		name: options.preset.name,
		presetDir: options.preset.presetDir,
	}
	return {
		cwd: targetCwd,
		sharedContextPath: options?.sharedContextPath ?? "",
		[STATUS_STATE_FILE_KEY]: options?.stateDbPath ?? stateDbPath,
		issueDir: options?.issueDir ?? "",
		evidenceRootDir: options?.evidenceRootDir ?? "",
		logDir: options?.logDir ?? "",
		repository: options?.repository ?? null,
		baseBranch: options?.baseBranch ?? null,
		worktree: options?.worktree ?? false,
		runner: buildStatusRunnerDefaultsSnapshot(options),
		preset,
	}
}

function buildStatusRunnerDefaultsSnapshot(options: LoopOptions | null): StatusRunnerDefaultsSnapshot {
	// #456: no more role-shaped runner default field. The single `default` slot still surfaces the
	// engine-builtin fallback for hosts that haven't loaded a preset; per-phase runners live entirely
	// under `phases`. Supervisor / doctor consumers read per-phase exclusively (DSL-declared phase
	// names; no engine assumption about which phase is "review").
	if (options !== null) {
		return {
			hostDefault: options.hostRunner,
			default: statusRunnerSelection(options.defaultRunner),
			phases: statusRunnerSelections(selectPhaseDefaultRunners(options.preset, options.runnerCommands)),
		}
	}
	const hostRunner = detectHostRunner(process.env)
	const resolved: Pick<ChainResolved, "claudeBinary" | "claudeModel" | "claudeExtraArgs" | "codexBinary" | "codexModel" | "codexExtraArgs" | "opencodeBinary" | "opencodeModel" | "opencodeExtraArgs"> = {
		claudeBinary: null,
		claudeModel: null,
		claudeExtraArgs: [],
		codexBinary: null,
		codexModel: null,
		codexExtraArgs: [],
		opencodeBinary: null,
		opencodeModel: null,
		opencodeExtraArgs: [],
	}
	return {
		hostDefault: hostRunner,
		default: statusRunnerSelection(selectDefaultRunner(buildAgentRunnerCommands(resolved))),
		phases: {},
	}
}

function makeUnavailableStatusSnapshot(input: {
	target: StatusTargetSnapshot
	stateKind: StatusStateKind
	stateDbPath: string
	errorPath: string
	errorMessage: string
	processes?: StatusProcessSnapshot
}): CoderLoopStatusSnapshot {
		return {
			target: input.target,
			state: {
				kind: input.stateKind,
				ok: false,
				loaded: false,
				path: input.stateDbPath,
				version: null,
			repository: null,
			baseBranch: null,
			errors: [{ path: input.errorPath, message: input.errorMessage }],
			error: input.errorMessage,
		},
		queue: { total: 0, byStatus: {}, continuable: 0, terminal: 0, selected: null },
		runs: { total: 0, byPhaseStatus: {}, counts: [] },
		current: { run: null, id: null, item: null, runner: null, phaseStatus: null },
		events: { runId: null, path: null, exists: false, recent: [], latest: null, error: null },
		processes: input.processes ?? { live: [], scanError: null },
	}
}

function flattenExtraReplacer(_key: string, value: BoundaryValue): BoundaryValue {
	if (!isObjectRecord(value) || !("extra" in value) || !isJsonObject(value.extra)) return value
	const extra = value.extra
	const rest: BoundaryRecord = {}
	for (const [k, v] of Object.entries(value)) {
		if (k !== "extra") rest[k] = v
	}
	return { ...extra, ...rest }
}

function stringifyStatusSnapshot(snapshot: CoderLoopStatusSnapshot): string {
	return JSON.stringify(snapshot, flattenExtraReplacer, "\t")
}

function pickFirstSelectableStatusItem(
	options: LoopOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
	current: CurrentRunRecord | null,
	itemPresets: StatusItemPresetResolver,
): SelectedIssue | null {
	// #412: continuable membership is a per-item preset question — different items in a mixed-preset
	// chain may have entirely disjoint status vocabularies. Reading `options.preset.statuses` here
	// (the chain seed) makes foreign-preset items unselectable once chain-preset items finish.
	const currentItem = current === null ? null : findCurrentItem(current, items, itemPresets)
	const isContinuableForItem = (item: ItemRecord): boolean =>
		itemPresets.presetForItem(item).statuses.continuable.includes(item.status)
	const selected = currentItem !== null && isContinuableForItem(currentItem)
		? currentItem
		: items.find(isContinuableForItem) ?? null
	if (selected === null) return null

	const selectedPreset = itemPresets.presetForItem(selected)
	const selectedId = getItemId(selected, selectedPreset)
	const issueFile = resolveOptionalChainIssueFile(options, chain, selected, "Selected issue file")
	const evidenceDir = resolveChainEvidenceDir(options, chain, selected, selectedId, "Selected evidence directory")
	const agentCwd = selected.agentCwd ?? options.targetCwd
	const selectedInput = phaseRunnerSelectionInputForPreset(options, selectedPreset)
	const runner = selectRunnerForPhase(firstNonTriggerPhaseForPreset(selectedPreset).name, selected, selectedInput)
	return { item: selected, issueFile, evidenceDir, agentCwd, runner }
}

// #412: try each item's own preset when looking up the current run's item, since the run was
// originally spawned against the item's preset (not the chain seed). The first preset whose
// idField matches yields the item — if none match, fall back to chain-seed lookup so legacy items
// without their own preset still resolve.
function findCurrentItem(
	current: CurrentRunRecord,
	items: readonly ItemRecord[],
	itemPresets: StatusItemPresetResolver,
): ItemRecord | null {
	const itemId = current.extra.itemId
	if (typeof itemId === "number" && Number.isInteger(itemId)) {
		const byItemId = items.find((item) => item.id === itemId)
		if (byItemId !== undefined) return byItemId
	}
	for (const item of items) {
		const preset = itemPresets.presetForItem(item)
		const currentId = currentIdFromRecord(current, preset)
		if (currentId !== null && getItemId(item, preset) === currentId) return item
	}
	return items.find((item) => item.lastRunId === current.runId) ?? null
}

function phaseRunnerSelectionInputForPreset(options: LoopOptions, preset: Preset): PhaseRunnerSelectionInput {
	if (preset === options.preset) return options
	const defaultRunner = selectPhaseDefaultRunner(firstNonTriggerPhaseForPreset(preset), preset, options.runnerCommands)
	return { preset, defaultRunner, runnerCommands: options.runnerCommands }
}

function buildStatusQueueSnapshotFromRecords(
	options: LoopOptions,
	items: readonly ItemRecord[],
	selected: SelectedIssue | null,
	itemPresets: StatusItemPresetResolver,
): StatusQueueSnapshot {
	const byStatus: Record<string, number> = {}
	for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
	// #412: in a mixed-preset chain, a single status name (e.g. `pending`) can be continuable
	// under one preset and absent under another. Decide per item, against the item's own preset.
	const isContinuable = (item: ItemRecord): boolean => itemPresets.presetForItem(item).statuses.continuable.includes(item.status)
	const isTerminal = (item: ItemRecord): boolean => itemPresets.presetForItem(item).statuses.terminal.includes(item.status)
	const selectedPreset = selected === null ? null : itemPresets.presetForItem(selected.item)
	return {
		total: items.length,
		byStatus,
		continuable: items.filter(isContinuable).length,
		terminal: items.filter(isTerminal).length,
		selected: selected === null || selectedPreset === null ? null : {
			id: getItemId(selected.item, selectedPreset),
			item: statusItemSnapshot(selected.item, selectedPreset),
			issueFile: selected.issueFile,
			evidenceDir: selected.evidenceDir,
			agentCwd: selected.agentCwd,
			runner: statusRunnerSelection(selected.runner),
			phaseRunners: statusRunnerSelections(selectPhaseRunnersForItem(selectedPreset, selected.item, options.runnerCommands)),
			preset: resolveStatusItemPresetSnapshot(selected.item, options.preset),
		},
	}
}

// #412: report the source + resolved directory of an item's preset for supervisor consumers.
// `presetDir` resolves the directory the engine would load for this item, computed without
// loading the preset (consumers can re-load if they need the full Preset; status callers only
// need to know which directory rendered the agent prompt).
function resolveStatusItemPresetSnapshot(item: ItemRecord, chainPreset: Preset): StatusItemPresetSnapshot {
	if (item.presetPath !== null) {
		return { source: "item-preset-path", name: null, path: item.presetPath, presetDir: item.presetPath }
	}
	if (item.preset !== null) {
		// Reuse the canonical bundled-preset resolver so item-level preset rendering matches the
		// engine's resolution exactly, without loading the preset's preset.toml.
		const presetDir = resolvePresetDir({ preset: item.preset, presetPath: null }, PKG_ROOT, item.repoCwd)
		return { source: "item-preset", name: item.preset, path: null, presetDir }
	}
	return { source: "chain-fallback", name: chainPreset.name, path: null, presetDir: chainPreset.presetDir }
}

function statusItemSnapshot(item: ItemRecord, preset: Preset): StatusItemSnapshot {
	// #419: idField value lives in `extra` under the preset-declared key; no separate
	// `issueNumber` engine column to back-fill from. The opaque `item.itemId` is the
	// authoritative identity and the migration copied the integer column value into
	// `extra.issue` for `gh-issue-pr-iteration`-shaped legacy rows.
	const extra = transparentItemExtra(item, preset)
	return {
		status: item.status,
		attempts: item.attempts,
		title: item.title,
		priority: item.priority,
		lastRunId: item.lastRunId,
		issueFile: item.issueFile,
		evidenceDir: item.evidenceDir,
		agentCwd: item.agentCwd,
		runner: item.runner,
		// #412: surface the item's stored preset declaration; downstream supervisors / dashboards
		// consume this to know which preset rendered each item without re-loading the preset directory.
		preset: item.preset,
		presetPath: item.presetPath,
		extra,
	}
}

function transparentItemExtra(item: ItemRecord, preset: Preset): JsonObject {
	// #419: every preset-declared `[item.fields]` value lives in `extra` after the items
	// table de-GitHub-shaping. No legacy physical-column fallback remains; the function is
	// kept (instead of inlining) so supervisor status snapshots keep going through one
	// helper that documents the preset-vs-extra contract.
	const extra = itemExtraToJsonObject(item.extra)
	// `preset` is unused at runtime now — kept on the signature for clarity at call sites,
	// matching the prior shape so review can diff the change easily. Silence the unused
	// warning via void without `as`.
	void preset
	return extra
}

function buildStatusRunsSnapshot(runs: readonly RunRecord[]): StatusRunsSnapshot {
	const byPhaseStatus: Record<string, Record<string, number>> = {}
	for (const run of runs) {
		const phaseCounts = byPhaseStatus[run.phase] ?? {}
		phaseCounts[run.status] = (phaseCounts[run.status] ?? 0) + 1
		byPhaseStatus[run.phase] = phaseCounts
	}
	const counts: StatusRunCountSnapshot[] = Object.entries(byPhaseStatus)
		.flatMap(([phase, statuses]) =>
			Object.entries(statuses).map(([status, count]) => ({ phase, status, count })),
		)
		.sort((a, b) => a.phase.localeCompare(b.phase) || a.status.localeCompare(b.status))
	return { total: runs.length, byPhaseStatus, counts }
}

async function buildStatusCurrentSnapshotFromRecords(
	options: LoopOptions,
	items: readonly ItemRecord[],
	current: CurrentRunRecord | null,
	itemPresets: StatusItemPresetResolver,
): Promise<StatusCurrentSnapshot> {
	if (current === null) return { run: null, id: null, item: null, runner: null, phaseStatus: null }
	let id: string | null = null
	let item: ItemRecord | null = null
	try {
		item = findCurrentItem(current, items, itemPresets)
		const fallbackPreset = item === null ? options.preset : itemPresets.presetForItem(item)
		id = item === null ? currentIdFromRecord(current, fallbackPreset) : getItemId(item, fallbackPreset)
	} catch {
		id = null
	}
	const outputPath = agentOutputPath(options, current.runId, current.phase)
	// #412: current-run runner resolution must use the running item's preset (the scheduler spawned
	// against that preset's phase plan). selectRunnerForPhase would otherwise look up the phase in
	// the chain seed and throw "preset X does not define phase Y" on a foreign-preset item.
	const itemPreset = item === null ? null : itemPresets.presetForItem(item)
	const selectionInput = itemPreset === null ? null : phaseRunnerSelectionInputForPreset(options, itemPreset)
	return {
		run: statusCurrentRunSnapshot(current),
		id,
		item: item === null || itemPreset === null ? null : statusItemSnapshot(item, itemPreset),
		runner: item === null || selectionInput === null ? null : statusRunnerSelection(selectRunnerForPhase(current.phase, item, selectionInput)),
		phaseStatus: await readAgentPhaseStatus(agentStatusPath(outputPath)),
	}
}

function statusCurrentRunSnapshot(current: CurrentRunRecord): StatusCurrentRunSnapshot {
	return {
		phase: current.phase,
		runId: current.runId,
		startedAt: new Date(current.startedAt * 1000).toISOString(),
		extra: itemExtraToJsonObject(current.extra),
	}
}

// #409: `currentItemFromRecords` retired alongside the inline `restoreUnblockableItemRecord`
// helper that fired the operator's CLI queue.unblock mutation — the daemon's
// `handleQueueUnblock` is the only writer now. `currentIdFromRecord` survives because
// `statusCurrentRunSnapshot` callers still use it to derive a current-item handle for read
// paths.
function currentIdFromRecord(current: CurrentRunRecord, preset: Preset): string | null {
	const value = itemExtraJsonValue(current.extra, preset.item.idField)
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	return null
}

function statusRunnerSelection(selection: AgentRunnerSelection): StatusRunnerSelectionSnapshot {
	return {
		kind: selection.kind,
		source: selection.source,
		binary: selection.binary,
		extraArgs: [...selection.extraArgs],
		model: selection.model,
	}
}

function statusRunnerSelections(selections: Record<string, AgentRunnerSelection>): Record<string, StatusRunnerSelectionSnapshot> {
	const out: Record<string, StatusRunnerSelectionSnapshot> = {}
	for (const [phase, selection] of Object.entries(selections)) out[phase] = statusRunnerSelection(selection)
	return out
}

async function readAgentPhaseStatus(path: string): Promise<StatusPhaseStatusSnapshot> {
	try {
		const raw = await readFile(path, "utf-8")
		const parsed: BoundaryValue = JSON.parse(raw)
		const status = agentStatusFromInput(assertArk(AgentRunStatusBoundary, parsed, "agent status"))
		return { path, exists: true, value: status, error: null }
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { path, exists: false, value: null, error: null }
		return { path, exists: true, value: null, error: errorMessage(error) }
	}
}

function agentStatusFromInput(input: AgentRunStatusInput): AgentRunStatus {
	return {
		label: input.label,
		runner: input.runner ?? null,
		model: input.model ?? null,
		pid: input.pid,
		startedAt: input.startedAt,
		lastEventAt: input.lastEventAt,
		outputPath: input.outputPath,
		statusPath: input.statusPath,
		bytesWritten: input.bytesWritten,
		promptChars: input.promptChars,
		lastStream: input.lastStream,
		exitCode: input.exitCode,
		signal: input.signal,
		error: input.error,
		sessionId: input.sessionId,
		terminated: input.terminated,
	}
}


async function buildStatusEventsSnapshotFromRecords(
	options: LoopOptions,
	current: CurrentRunRecord | null,
	selected: SelectedIssue | null,
	items: readonly ItemRecord[],
): Promise<StatusEventsSnapshot> {
	const runId = current?.runId ?? selected?.item.lastRunId ?? firstLastRunIdFromRecords(items)
	if (runId === null) return { runId: null, path: null, exists: false, recent: [], latest: null, error: null }
	const path = resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).eventsFile
	try {
		const result = await queryObservabilityEvents(path, { run: runId })
		const recent = result.events.slice(-20).map(jsonValueFromSerializable)
		return {
			runId,
			path,
			exists: result.events.length > 0,
			recent,
			latest: recent[recent.length - 1] ?? null,
			error: null,
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { runId, path, exists: false, recent: [], latest: null, error: null }
		return { runId, path, exists: true, recent: [], latest: null, error: errorMessage(error) }
	}
}

function firstLastRunIdFromRecords(items: readonly ItemRecord[]): string | null {
	for (const item of items) {
		if (item.lastRunId !== null) return item.lastRunId
	}
	return null
}

function jsonValueFromSerializable(value: BoundaryValue): JsonValue {
	const parsed: BoundaryValue = JSON.parse(JSON.stringify(value))
	if (!isJsonValue(parsed)) throw new Error("event is not JSON data")
	return parsed
}

function parseRecentJsonLines(raw: string, limit: number): JsonValue[] {
	const lines = raw.split("\n").filter((line) => line.trim() !== "")
	const recent = lines.slice(-limit)
	return recent.map((line) => {
		const parsed: BoundaryValue = JSON.parse(line)
		if (!isJsonValue(parsed)) throw new Error("event line is not JSON data")
		return parsed
	})
}

async function buildCentralStatusProcessSnapshot(options: Pick<LoopOptions, "targetCwd" | "loopDataRoot">): Promise<StatusProcessSnapshot> {
	const scan = scanLoopProcesses(options.targetCwd)
	const live = scan.kind === "ok" ? [...scan.value] : []
	const scanErrors = scan.kind === "ok" ? [] : [scan.message]
	const daemon = await readCentralDaemonProcessInfo(options.loopDataRoot)
	if (daemon.kind === "ok" && daemon.value !== null) {
		const daemonInfo = daemon.value
		if (live.every((entry) => entry.pid !== daemonInfo.pid)) live.push(daemonInfo)
	} else if (daemon.kind === "invalid") {
		scanErrors.push(daemon.message)
	}
	return {
		live,
		scanError: scanErrors.length === 0 ? null : scanErrors.join("; "),
	}
}

async function readCentralDaemonProcessInfo(loopDataRoot: string | null): Promise<StatusReadResult<StatusProcessInfo | null>> {
	const socketPath = resolveLoopDataPaths(loopDataRootOption(loopDataRoot)).daemonSocket
	let response: DaemonResponse
	try {
		response = await sendDaemonRequest(socketPath, daemonRequest("daemon.status"))
	} catch (error) {
		return { kind: "missing", message: centralDaemonNotRunningMessage(loopDataRoot, socketPath, error) }
	}
	if (!response.ok) return { kind: "invalid", message: `${response.error.code}: ${response.error.message}` }
	const processInfo = centralDaemonStatusToProcessInfo(response.result)
	if (processInfo === null) return { kind: "invalid", message: "daemon.status response did not include daemon process metadata" }
	return { kind: "ok", value: processInfo }
}

function centralDaemonStatusToProcessInfo(result: JsonObject): StatusProcessInfo | null {
	const daemon = result.daemon
	if (!isObjectRecord(daemon)) return null
	if (typeof daemon.pid !== "number" || !Number.isInteger(daemon.pid)) return null
	return {
		pid: daemon.pid,
		ppid: null,
		command: null,
		cwd: null,
		matchesTarget: true,
		alive: daemon.running !== false && isPidAlive(daemon.pid),
		source: "daemon-socket",
	}
}

function scanLoopProcesses(targetCwd: string): StatusReadResult<StatusProcessInfo[]> {
	const proc = Bun.spawnSync({
		cmd: ["ps", "-axo", "pid=,ppid=,command="],
		stdout: "pipe",
		stderr: "pipe",
	})
	if (proc.exitCode !== 0) return { kind: "invalid", message: new TextDecoder().decode(proc.stderr).trim() || "ps scan failed" }
	const stdout = new TextDecoder().decode(proc.stdout)
	const live: StatusProcessInfo[] = []
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		const ppid = Number(match[2])
		const commandText = match[3] ?? ""
		const invokesLoop = commandText.includes("src/loop.ts") || /(^|\s)coder-loop(\s|$)/.test(commandText)
		const looksLikeLoop = invokesLoop && !/(^|\s)(status|daemon|doctor)(\s|$)/.test(commandText)
		const matchesTarget = commandText.includes(targetCwd)
		if (!looksLikeLoop) continue
		live.push({
			pid,
			ppid: Number.isInteger(ppid) ? ppid : null,
			command: commandText,
			cwd: null,
			matchesTarget,
			alive: true,
			source: "ps",
		})
	}
	return { kind: "ok", value: live }
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export type DaemonStartPlan = {
	targetCwd: string
	command: string[]
	commandLine: string
	stdoutPath: string
	stderrPath: string
}

type DaemonStartResult =
	| {
			action: "start"
			target: string
			pid: number | null
				command: string[]
				stdoutPath: string
				stderrPath: string
	  }
		| {
				action: "start"
				target: string
				alreadyRunning: true
				pid: number
				source: StatusProcessInfo["source"]
		  }

const DAEMON_SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const
const DAEMON_IGNORED_SIGNALS = ["SIGHUP", "SIGUSR1", "SIGUSR2", "SIGPIPE"] as const

export function buildDaemonStartPlan(args: Extract<DaemonCommandArgs, { action: "start" }>): DaemonStartPlan {
	const targetCwd = resolve(args.targetCwd)
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
	// The central daemon is global, not per-chain: route its process stdout/stderr to the
	// loop-data-root daemon log location instead of any chains/<chain>/daemon directory.
	const loopDataPaths = resolveLoopDataPaths(loopDataRootOption(args.loopDataRoot ?? null))
	const stdoutPath = loopDataPaths.daemonStdoutFile(timestamp)
	const stderrPath = loopDataPaths.daemonStderrFile(timestamp)
	const command = [
		process.argv[0] ?? "bun",
		resolve(import.meta.dir, "loop.ts"),
		"daemon",
		"up",
	]
	if (args.loopDataRoot !== null && args.loopDataRoot !== undefined) command.push("--loop-data-root", args.loopDataRoot)
	return {
		targetCwd,
		command,
		commandLine: command.map(shellQuote).join(" "),
		stdoutPath,
		stderrPath,
	}
}

async function runDaemonUpCommand(args: Extract<DaemonCommandArgs, { action: "up" }>): Promise<void> {
	const scheduler = args.schedulerIntervalMs === null ? {} : { intervalMs: args.schedulerIntervalMs }
	let daemon: CoderLoopDaemon | null = null
	let shutdownStarted = false
	const shutdown = () => {
		if (shutdownStarted) return
		shutdownStarted = true
		if (daemon === null) {
			process.exit(0)
			return
		}
		void daemon.stop().then(() => process.exit(0))
	}
	const ignoreSignal = () => undefined
	// Fatal-error handlers: without these, an uncaught exception / unhandled rejection
	// prints a stack to an stderr that operational daemons do not capture, then exits —
	// leaving no durable trace of why the daemon died. Record the stack synchronously to
	// the global daemon.log first, then exit non-zero.
	const recordFatal = (kind: string) => (error: BoundaryError): void => {
		daemon?.recordFatalSync(kind, error)
		process.exit(1)
	}
	const onUncaughtException = recordFatal("uncaughtException")
	const onUnhandledRejection = recordFatal("unhandledRejection")
	let fatalHandlersRegistered = false
	let signalsRegistered = false
	let started = false
	try {
		daemon = new CoderLoopDaemon({
			...(args.loopDataRoot === null ? {} : { loopDataRoot: args.loopDataRoot }),
			scheduler,
		})
		process.on("uncaughtException", onUncaughtException)
		process.on("unhandledRejection", onUnhandledRejection)
		fatalHandlersRegistered = true
		for (const signal of DAEMON_SHUTDOWN_SIGNALS) process.once(signal, shutdown)
		for (const signal of DAEMON_IGNORED_SIGNALS) process.on(signal, ignoreSignal)
		signalsRegistered = true
		await daemon.start()
		started = true
		const result = {
			action: "up",
			pid: process.pid,
			socketPath: daemon.snapshot().socketPath,
			pidFile: daemon.snapshot().pidFile,
		}
		writeJsonOrText(result, args.json, formatDaemonUpResult)
		await daemon.closed
	} catch (error) {
		if (args.json && !started) {
			writeDaemonErrorResponse(daemonCliErrorResponse(error, "daemon_start_failed"))
			return
		}
		throw error
	} finally {
		if (fatalHandlersRegistered) {
			process.off("uncaughtException", onUncaughtException)
			process.off("unhandledRejection", onUnhandledRejection)
		}
		if (signalsRegistered) {
			for (const signal of DAEMON_SHUTDOWN_SIGNALS) process.off(signal, shutdown)
			for (const signal of DAEMON_IGNORED_SIGNALS) process.off(signal, ignoreSignal)
		}
	}
}

async function runDaemonDownCommand(args: Extract<DaemonCommandArgs, { action: "down" }>): Promise<void> {
	const response = await sendDaemonRequestForDaemonCommand(args.loopDataRoot, "daemon.down", {}, args.json)
	if (response === null) return
	if (args.json) {
		process.stdout.write(`${JSON.stringify(response, null, "\t")}\n`)
		if (!response.ok) process.exitCode = 1
		return
	}
	if (!response.ok) {
		process.stderr.write(`daemon down failed: ${response.error.code}: ${response.error.message}\n`)
		process.exitCode = 1
		return
	}
	process.stdout.write(formatDaemonDownResult(response.result))
}

async function runDaemonStartCommand(args: Extract<DaemonCommandArgs, { action: "start" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "start",
				target: runtime.options.targetCwd,
				chain: runtime.chain.name,
				dryRun: true,
				centralDaemon: "required",
			}, args.json, formatDaemonStartResult)
		return
	}
	const daemon = await requestDaemonResult(args.loopDataRoot ?? null, "daemon.status")
	writeJsonOrText({
		action: "start",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		alreadyRunning: true,
		daemon: daemon.daemon ?? null,
	}, args.json, formatDaemonStartResult)
}

async function executeDaemonStart(args: Extract<DaemonCommandArgs, { action: "start" }>, plan = buildDaemonStartPlan(args)): Promise<DaemonStartResult> {
	const current = await buildCoderLoopStatusSnapshot({
		targetCwd: args.targetCwd,
		loopDataRoot: args.loopDataRoot ?? null,
		chainName: args.chainName ?? null,
		output: "json",
	})
	const live = findOwnedLiveProcess(current)
	if (live !== null) {
			return {
				action: "start",
				target: plan.targetCwd,
				alreadyRunning: true,
				pid: live.pid,
				source: live.source,
			}
		}

	await mkdir(dirname(plan.stdoutPath), { recursive: true })
	const stdoutFd = openSync(plan.stdoutPath, "a")
	const stderrFd = openSync(plan.stderrPath, "a")
	try {
		const child = spawn(plan.command[0]!, plan.command.slice(1), {
			cwd: plan.targetCwd,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		})
		child.unref()
		return {
			action: "start",
			target: plan.targetCwd,
			pid: child.pid ?? null,
				command: plan.command,
				stdoutPath: plan.stdoutPath,
				stderrPath: plan.stderrPath,
			}
	} finally {
		closeSync(stdoutFd)
		closeSync(stderrFd)
	}
}

async function runDaemonStopCommand(args: Extract<DaemonCommandArgs, { action: "stop" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "stop",
			target: runtime.options.targetCwd,
			chain: runtime.chain.name,
			dryRun: true,
		}, args.json, formatDaemonStopResult)
		return
	}
	const result = await requestDaemonResult(args.loopDataRoot ?? null, "chain.stop", { chainName: runtime.chain.name })
	writeJsonOrText({
		action: "stop",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		result,
	}, args.json, formatDaemonStopResult)
}

async function runDaemonRestartCommand(args: Extract<DaemonCommandArgs, { action: "restart" }>): Promise<void> {
	const runtime = await loadTargetRuntime(daemonCommandToTargetLookupArgs(args))
	if (args.dryRun) {
		writeJsonOrText({
			action: "restart",
			target: runtime.options.targetCwd,
			chain: runtime.chain.name,
			dryRun: true,
			centralDaemon: "required",
		}, args.json, formatDaemonRestartResult)
		return
	}
	const daemon = await requestDaemonResult(args.loopDataRoot ?? null, "daemon.status")
	writeJsonOrText({
		action: "restart",
		target: runtime.options.targetCwd,
		chain: runtime.chain.name,
		restarted: false,
		reason: "central daemon is global; target restart resolves the chain and verifies daemon availability",
		daemon: daemon.daemon ?? null,
	}, args.json, formatDaemonRestartResult)
}

function daemonCommandToTargetLookupArgs(args: Extract<DaemonCommandArgs, { action: "start" | "stop" | "restart" }>): TargetChainLookupArgs {
	return {
		targetCwd: args.targetCwd,
		loopDataRoot: args.loopDataRoot ?? null,
			chainName: args.chainName ?? null,
			repository: null,
			baseBranch: null,
			dryRun: args.dryRun,
			worktree: "worktree" in args ? args.worktree : false,
		}
	}

export type QueueUnblockMutationOutcome =
	| {
			changed: true
			issue: string
			beforeStatus: string
			afterStatus: string
			clearedCurrent: boolean
	  }
	| {
			changed: false
			issue: string
			reason: "not_found"
	  }
	| {
			changed: false
			issue: string
			reason: "not_unblockable"
			status: string
	  }

type QueueUnblockCommandResult = {
	action: "queue.unblock"
	target: string
	repository: string | null
	[STATUS_STATE_FILE_KEY]: string
	issue: string
	dryRun: boolean
	mutation: QueueUnblockMutationOutcome
	daemon:
		| { requested: false; skipped: true; reason: "not_requested" | "no_requeue_needed" }
		| { requested: true; dryRun: true; plan: DaemonStartPlan }
		| { requested: true; dryRun: false; result: DaemonStartResult }
	verification: {
		itemStatus: string | null
		stateKind: StatusStateKind
		daemonRunning: boolean
		}
}

async function runQueueUnblockCommand(args: QueueUnblockCommandArgs): Promise<void> {
	const runtime = await loadTargetRuntime({
		targetCwd: args.targetCwd,
		loopDataRoot: args.loopDataRoot,
		chainName: args.chainName,
		repository: null,
		baseBranch: null,
		dryRun: args.dryRun,
		worktree: false,
	})
	const options = runtime.options
	const issue = normalizeQueueIssueId(args.issue)
	// #419: opaque item id (string). The CLI flag historically named `--issue` is kept for
	// back-compat; the underlying identity is now whatever string the preset's idField names.
	const itemId = parseRequiredItemId(issue, "queue unblock: --issue")
	// #409: queue.unblock now daemonizes. The daemon's `handleQueueUnblock` performs the SQLite
	// mutation (default-deny for agents via the hard-deny gate) and the operator-attribution
	// `item.mutation.caller_admission` audit event so external tooling watching the audit stream
	// still sees the operator's unblock. The CLI's role shrinks to: send the request, read the
	// resulting item status, and (optionally) bounce the daemon if `--start-daemon` was passed.
	const mutationResponse = await requestDaemonResult(options.loopDataRoot, "queue.unblock", {
		chainName: runtime.chain.name,
		issue,
		dryRun: args.dryRun,
	})
	const mutation = parseQueueUnblockMutationResponse(mutationResponse, issue)
	if (!mutation.changed && mutation.reason === "not_found") {
		fail(`queue unblock: issue ${issue} not found in SQLite state DB`)
	}

	let daemon: QueueUnblockCommandResult["daemon"]
	if (!mutation.changed) {
		daemon = { requested: false, skipped: true, reason: "no_requeue_needed" }
	} else if (!args.startDaemon) {
		daemon = { requested: false, skipped: true, reason: "not_requested" }
	} else if (args.dryRun) {
		daemon = {
			requested: true,
			dryRun: true,
			plan: buildDaemonStartPlan({
				action: "start",
				targetCwd: options.targetCwd,
				loopDataRoot: options.loopDataRoot,
				chainName: options.chainName ?? null,
				dryRun: true,
				worktree: options.worktree,
				json: false,
			}),
		}
	} else {
		daemon = {
			requested: true,
			dryRun: false,
			result: await executeDaemonStart({
				action: "start",
				targetCwd: options.targetCwd,
				loopDataRoot: options.loopDataRoot,
				chainName: options.chainName ?? null,
				dryRun: false,
				worktree: options.worktree,
				json: false,
			}),
		}
	}

	const item = readDbItemById(options.loopDataRoot, runtime.chain.id, itemId)
	const daemonRunning = daemonResultIndicatesRunning(daemon)
	const result: QueueUnblockCommandResult = {
		action: "queue.unblock",
		target: options.targetCwd,
		repository: options.repository,
		[STATUS_STATE_FILE_KEY]: options.stateDbPath,
		issue,
		dryRun: args.dryRun,
		mutation,
		daemon,
		verification: {
			itemStatus: item?.status ?? null,
			stateKind: "ok",
			daemonRunning,
		},
	}
	process.stdout.write(JSON.stringify(result, null, "\t") + "\n")
}

// #409: queue.unblock mutation response parser. The daemon emits
// `{ mutation: <QueueUnblockMutationOutcome JSON shape> }` from `handleQueueUnblock`; this CLI
// helper boundary-parses each variant. Failure to match any variant is treated as a daemon
// protocol bug (the daemon would not emit a malformed reply for an op the CLI sent), so the
// helper throws via `fail(...)` rather than silently coercing.
function parseQueueUnblockMutationResponse(response: JsonObject, requestedIssue: string): QueueUnblockMutationOutcome {
	const mutation = response.mutation
	if (mutation === undefined || mutation === null || typeof mutation !== "object" || Array.isArray(mutation)) {
		fail(`queue unblock: daemon reply missing or malformed 'mutation' field`)
	}
	const mutationObj: JsonObject = mutation
	const changed = mutationObj.changed
	const issueValue = mutationObj.issue
	const issue = typeof issueValue === "string" ? issueValue : requestedIssue
	if (changed === false) {
		const reason = mutationObj.reason
		if (reason === "not_found") return { changed: false, issue, reason: "not_found" }
		if (reason === "not_unblockable") {
			const status = mutationObj.status
			if (typeof status !== "string") fail(`queue unblock: daemon 'not_unblockable' reply missing status`)
			return { changed: false, issue, reason: "not_unblockable", status }
		}
		fail(`queue unblock: daemon reply has unknown reason ${JSON.stringify(reason)}`)
	}
	if (changed !== true) fail(`queue unblock: daemon reply has invalid 'changed' field ${JSON.stringify(changed)}`)
	const beforeStatus = mutationObj.beforeStatus
	const afterStatus = mutationObj.afterStatus
	const clearedCurrent = mutationObj.clearedCurrent
	if (typeof beforeStatus !== "string" || typeof afterStatus !== "string" || typeof clearedCurrent !== "boolean") {
		fail(`queue unblock: daemon 'changed' reply missing status/clearedCurrent fields`)
	}
	return { changed: true, issue, beforeStatus, afterStatus, clearedCurrent }
}

function daemonResultIndicatesRunning(daemon: QueueUnblockCommandResult["daemon"]): boolean {
	if (!daemon.requested) return false
	if (daemon.dryRun) return false
	if ("alreadyRunning" in daemon.result) return daemon.result.alreadyRunning === true
	return daemon.result.pid !== null
}

type TargetChainLookupArgs = {
	targetCwd: string
	loopDataRoot: string | null
	chainName: string | null
	repository: string | null
	baseBranch: string | null
	dryRun: boolean
	worktree: boolean
	chainStatusScope?: TargetChainStatusScope
}

type TargetChainStatusScope = "active-only" | "status-snapshot"

type LoadedTargetRuntime = {
	options: LoopOptions
	chain: ChainRecord
}

async function loadTargetRuntime(args: TargetChainLookupArgs): Promise<LoadedTargetRuntime> {
	// #433: target config file is retired — every per-target fact now comes from chain metadata.
	// `loadTargetRuntime` reads no on-disk config file; the only effective root is the explicit
	// flag (or the engine default), and chain metadata is the single source for preset/path
	// overrides.
	const targetCwd = resolve(args.targetCwd)
	const effectiveLoopDataRoot = args.loopDataRoot
	const chain = await resolveDbChainForTarget({ ...args, loopDataRoot: effectiveLoopDataRoot })
	const resolved = chainResolvedFromChain(chain, effectiveLoopDataRoot)
	const presetDir = resolvePresetDir(resolved, PKG_ROOT, targetCwd)
	const preset = await loadPreset(presetDir)
	const options = buildOptions(targetCwd, {
		targetCwd,
		loopDataRoot: effectiveLoopDataRoot,
		chainName: chain.name,
		dryRun: args.dryRun,
		worktree: args.worktree,
		chain,
	}, resolved, preset)
	return { options, chain }
}

async function loadLoopOptionsForTarget(
	targetCwdInput: string,
	repository: string | null,
	extra: Partial<TargetChainLookupArgs> = {},
): Promise<LoopOptions> {
	const loaded = await loadTargetRuntime({
		targetCwd: targetCwdInput,
		loopDataRoot: extra.loopDataRoot ?? null,
		chainName: extra.chainName ?? null,
		repository,
		baseBranch: extra.baseBranch ?? null,
		dryRun: extra.dryRun ?? false,
		worktree: extra.worktree ?? false,
	})
	return loaded.options
}

async function resolveDbChainForTarget(args: TargetChainLookupArgs): Promise<ChainRecord> {
	const loopDataRoot = args.loopDataRoot
	const statusScope = args.chainStatusScope ?? "active-only"
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		const requestedRepo = args.repository ?? await inferRepositoryFromGit(args.targetCwd)
		const requestedBase = args.baseBranch
		if (args.chainName !== null) {
			const chain = store.getChainByName(args.chainName)
			if (chain === null) throw new CoderLoopError(`SQLite state DB has no chain named "${args.chainName}"`)
			if (!chainStatusAllowedForTargetLookup(statusScope, chain.status)) throw new CoderLoopError(`SQLite chain "${chain.name}" is ${chain.status}, expected ${targetChainStatusExpectation(statusScope)}`)
			if (requestedRepo !== null && chain.repository !== requestedRepo) {
				throw new CoderLoopError(`SQLite chain "${chain.name}" repository is ${chain.repository}, expected ${requestedRepo}`)
			}
			if (requestedBase !== null && chain.baseBranch !== requestedBase) {
				throw new CoderLoopError(`SQLite chain "${chain.name}" base branch is ${chain.baseBranch}, expected ${requestedBase}`)
			}
			return chain
		}

		const targetCwd = resolve(args.targetCwd)
		const active = store.listChains().filter((chain) =>
			chainStatusAllowedForTargetLookup(statusScope, chain.status)
			&& (requestedRepo === null || chain.repository === requestedRepo)
			&& (requestedBase === null || chain.baseBranch === requestedBase)
		)
		const matchingByRepoCwd = active.filter((chain) =>
			store.listItems(chain.id).some((item) => samePath(item.repoCwd, targetCwd)),
		)
		if (matchingByRepoCwd.length === 1) return matchingByRepoCwd[0]!
		if (matchingByRepoCwd.length > 1) {
			throw new CoderLoopError(`target ${targetCwd} matches multiple ${targetChainStatusExpectation(statusScope)} chains by repo_cwd: ${matchingByRepoCwd.map((chain) => chain.name).join(", ")}; pass --chain <name>`)
		}
		if (active.length === 1) return active[0]!
		if (active.length === 0) {
			const repoLabel = requestedRepo === null ? "any repository" : `repository ${requestedRepo}`
			throw new CoderLoopError(`SQLite state DB has no ${targetChainStatusExpectation(statusScope)} chain for ${repoLabel} and target ${targetCwd}`)
		}
		throw new CoderLoopError(`target ${targetCwd} is ambiguous across ${targetChainStatusExpectation(statusScope)} chains: ${active.map((chain) => chain.name).join(", ")}; pass --chain <name>`)
	} finally {
		store.close()
	}
}

function chainStatusAllowedForTargetLookup(scope: TargetChainStatusScope, status: ChainRecord["status"]): boolean {
	if (scope === "active-only") return status === "active"
	return status === "active" || status === "completed"
}

function targetChainStatusExpectation(scope: TargetChainStatusScope): string {
	if (scope === "active-only") return "active"
	return "active or completed"
}

function readDbItemsForChain(loopDataRoot: string | null, chainId: number): ItemRecord[] {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.listItems(chainId)
	} finally {
		store.close()
	}
}

function readDbItemById(loopDataRoot: string | null, chainId: number, itemId: string): ItemRecord | null {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.getItemById(chainId, itemId)
	} finally {
		store.close()
	}
}

function readDbRunsForChain(loopDataRoot: string | null, chainId: number): RunRecord[] {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.listRuns(chainId)
	} finally {
		store.close()
	}
}

function readDbCurrentRun(loopDataRoot: string | null, chainId: number): CurrentRunRecord | null {
	const store = openSqliteStateStore({ createIfMissing: false, ...loopDataRootOption(loopDataRoot) })
	try {
		return store.getCurrentRun(chainId)
	} finally {
		store.close()
	}
}

// #433: chain metadata is now the sole source for per-target overrides; the engine no longer
// reads any target config file. `ChainResolved` carries the small set of facts the engine
// derives from chain metadata + runtime defaults — preset resolution, path overrides,
// model selections — for the rest of the loop assembly.
// #505: the four runtime path fields are non-null. `chainResolvedFromChain` sources them from
// chain.metadata.X if present, else from the derived `<loopDataRoot>/chains/<name>/...` path
// (`chainRuntimePathForKind`). The target-relative runtime-path fallback that previously lived
// under the target's own runtime directory has been retired.
export type ChainResolved = {
	worktree: boolean | null
	sharedContextFile: string
	issueDir: string
	evidenceDir: string
	logDir: string
	loopDataRoot: string | null
	// #433: per-runner overrides flow exclusively through chain.metadata.{claude,codex,opencode}.{binary,model,extraArgs}.
	// The retired target on-disk preferences file is no longer in the lookup chain.
	// #481: opencode (the third runner kind) follows the same shape — chain.metadata.opencode.{binary,model,extraArgs}.
	claudeBinary: string | null
	claudeModel: string | null
	claudeExtraArgs: readonly string[]
	codexBinary: string | null
	codexModel: string | null
	codexExtraArgs: readonly string[]
	opencodeBinary: string | null
	opencodeModel: string | null
	opencodeExtraArgs: readonly string[]
	preset: string | null
	presetPath: string | null
}

function chainResolvedFromChain(chain: ChainRecord, loopDataRoot: string | null): ChainResolved {
	const metadata = chain.metadata
	const presetPath = metadataString(metadata, "presetPath") ?? chainBindingsPresetPath(metadata) ?? null
	return {
		worktree: metadataBoolean(metadata, "worktree") ?? null,
		sharedContextFile: metadataString(metadata, "sharedContextFile") ?? chainRuntimePathForKind(chain.name, loopDataRoot, "shared"),
		issueDir: metadataString(metadata, "issueDir") ?? chainRuntimePathForKind(chain.name, loopDataRoot, "issues"),
		evidenceDir: metadataString(metadata, "evidenceDir") ?? chainRuntimePathForKind(chain.name, loopDataRoot, "evidence"),
		logDir: metadataString(metadata, "logDir") ?? chainRuntimePathForKind(chain.name, loopDataRoot, "runs"),
		loopDataRoot,
		claudeBinary: metadataNestedString(metadata, "claude", "binary") ?? null,
		claudeModel: metadataNestedString(metadata, "claude", "model") ?? null,
		claudeExtraArgs: metadataNestedStringArray(metadata, "claude", "extraArgs") ?? [],
		codexBinary: metadataNestedString(metadata, "codex", "binary") ?? null,
		codexModel: metadataNestedString(metadata, "codex", "model") ?? null,
		codexExtraArgs: metadataNestedStringArray(metadata, "codex", "extraArgs") ?? [],
		opencodeBinary: metadataNestedString(metadata, "opencode", "binary") ?? null,
		opencodeModel: metadataNestedString(metadata, "opencode", "model") ?? null,
		opencodeExtraArgs: metadataNestedStringArray(metadata, "opencode", "extraArgs") ?? [],
		preset: presetPath === null ? chain.preset : null,
		presetPath,
	}
}

function buildEffectiveBindings(
	chain: Pick<ChainRecord, "repository" | "baseBranch" | "metadata">,
): RenderBindings {
	return {
		repository: chain.repository,
		baseBranch: chain.baseBranch,
		...metadataBindings(chain.metadata),
	}
}

function chainRuntimePathForKind(chainName: string, loopDataRoot: string | null, kind: "shared" | "issues" | "evidence" | "runs"): string {
	const paths = resolveChainRuntimePaths(chainName, loopDataRootOption(loopDataRoot))
	if (kind === "shared") return paths.sharedFile
	if (kind === "issues") return paths.issuesDir
	if (kind === "evidence") return paths.evidenceDir
	return paths.runsDir
}

async function inferRepositoryFromGit(targetCwd: string): Promise<string | null> {
	const rootResult = Bun.spawnSync({
		cmd: ["git", "-C", resolve(targetCwd), "rev-parse", "--show-toplevel"],
		stdout: "pipe",
		stderr: "ignore",
	})
	if (rootResult.exitCode !== 0) return null
	const gitRoot = new TextDecoder().decode(rootResult.stdout).trim()
	if (!samePath(gitRoot, targetCwd)) return null
	const result = Bun.spawnSync({
		cmd: ["git", "-C", resolve(targetCwd), "remote", "get-url", "origin"],
		stdout: "pipe",
		stderr: "ignore",
	})
	if (result.exitCode !== 0) return null
	const url = new TextDecoder().decode(result.stdout).trim()
	const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
	if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`
	const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
	if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`
	return null
}

export function normalizeQueueIssueId(raw: string): string {
	const trimmed = raw.trim()
	if (trimmed === "") fail("queue unblock: --issue must not be empty")
	if (/\s/.test(trimmed)) fail(`queue unblock: --issue must not contain whitespace: ${raw}`)
	const crossRepoMatch = /^[^/\s]+\/[^#\s]+#(.+)$/.exec(trimmed)
	const value = crossRepoMatch ? crossRepoMatch[1]! : trimmed
	const normalized = value.startsWith("#") ? value.slice(1) : value
	if (normalized.trim() === "") fail(`queue unblock: --issue did not include an issue id: ${raw}`)
	return normalized
}

function hasOwnJsonKey(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function findOwnedLiveProcess(snapshot: CoderLoopStatusSnapshot): StatusProcessInfo | null {
	return snapshot.processes.live.find((entry) => entry.alive && entry.matchesTarget) ?? null
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true
		await sleep(50)
	}
	return !isPidAlive(pid)
}

// --- preset materialization ---
//
// `{{PRESET_ROOT}}` is an engine-owned template token that preset source md
// files use for cross-file references. Fragments and phase entries live in
// the same preset tree but reference each other via absolute paths (agents
// run in random worktrees, so relative references cannot resolve). The
// engine materializes the entire preset directory to
// `<loopDataRoot>/preset-materialized/<name>-<hash>/`, replacing every
// occurrence of the token with the target directory's absolute path in all
// `.md` files. Non-md files (e.g. `preset.toml`, `templates/*`) are copied
// verbatim. Hash is derived from the sorted (relpath, contents) tuple so
// unchanged sources reuse the same target; a source change produces a new
// target directory. Materialization is preset-agnostic: the engine only
// knows the reserved token and the copy layout, not any preset-specific
// file name or structure.
//
// Materialization is opt-in via `LoadPresetOptions.materialize`. Daemon
// callers pass `{ root: this.paths.root }`; direct unit tests that only
// exercise the parser can omit it (the token is substituted in-memory at
// prompt-read time — `readPresetPhasePrompt` + daemon prompt read use
// `substitutePresetRootToken` unconditionally so both modes yield prompts
// that never contain the token when validation or rendering sees them).
export const PRESET_ROOT_TOKEN = "{{PRESET_ROOT}}"
export const PRESET_MATERIALIZED_DIRNAME = "preset-materialized"

export type PresetMaterializeResult = {
	promptRoot: string
	contentHash: string
	dirName: string
}

export async function materializePreset(sourceDir: string, materializeRoot: string): Promise<PresetMaterializeResult> {
	const sourceAbs = resolve(sourceDir)
	const name = basename(sourceAbs)
	const files = await collectPresetSourceFiles(sourceAbs)
	const hasher = new Bun.CryptoHasher("sha256")
	for (const rel of files) {
		hasher.update(rel)
		hasher.update("\0")
		hasher.update(await readPresetSourceBytes(resolve(sourceAbs, rel)))
		hasher.update("\0")
	}
	const contentHash = hasher.digest("hex").slice(0, 16)
	const rootDir = resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME)
	const dirName = `${name}-${contentHash}`
	const target = resolve(rootDir, dirName)
	const marker = resolve(target, PRESET_MATERIALIZED_MARKER_FILENAME)
	try {
		if ((await stat(marker)).isFile()) return { promptRoot: target, contentHash, dirName }
	} catch (error) {
		if (!(isNodeError(error) && error.code === "ENOENT")) throw error
	}
	// A previous partial materialization (marker missing) needs to be wiped
	// before we recreate the target — the source may have changed in a way
	// that removed files, and a leftover copy would leak into the fresh view.
	await rm(target, { recursive: true, force: true })
	const stagingDir = resolve(rootDir, `.staging-${name}-${contentHash}-${process.pid}-${Date.now().toString(36)}`)
	await mkdir(stagingDir, { recursive: true })
	try {
		for (const rel of files) {
			const src = resolve(sourceAbs, rel)
			const dst = resolve(stagingDir, rel)
			await mkdir(dirname(dst), { recursive: true })
			if (rel.endsWith(".md")) {
				const content = await readPresetSourceText(src)
				await writeFile(dst, substitutePresetRootToken(content, target))
			} else {
				const bytes = await readPresetSourceBytes(src)
				await writeFile(dst, bytes)
			}
		}
		await writeFile(resolve(stagingDir, PRESET_MATERIALIZED_MARKER_FILENAME), "")
		try {
			await rename(stagingDir, target)
		} catch (error) {
			// Race: another process finalized the same content-hash target
			// concurrently. Discard our staging copy and reuse theirs.
			try {
				if ((await stat(marker)).isFile()) {
					await rm(stagingDir, { recursive: true, force: true })
					return { promptRoot: target, contentHash, dirName }
				}
			} catch {
				// fall through
			}
			throw error
		}
	} finally {
		// Best-effort cleanup on failure — if rename succeeded, the staging
		// dir is already gone, so rm on the missing path is a no-op.
		await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
	}
	// Prune older materialized copies of the same preset name so a series
	// of source edits doesn't grow the loop-data footprint without bound.
	// Only siblings that share the `<name>-` prefix (a different hash for
	// the same preset) are removed; other presets in the shared root
	// (`gh-issue-pr-iteration-*`, `engine-integration-*`, `real-e2e-minimal-*`, …) stay untouched.
	// Runs from concurrent daemons on a shared root would race here, but
	// the daemon is singleton per loop-data-root by design.
	await prunePresetSiblingsForName(rootDir, name, dirName)
	return { promptRoot: target, contentHash, dirName }
}

async function prunePresetSiblingsForName(rootDir: string, name: string, currentDirName: string): Promise<void> {
	let entries: string[]
	try {
		entries = await readdir(rootDir)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
	const prefix = `${name}-`
	for (const entry of entries) {
		if (entry === currentDirName) continue
		if (!entry.startsWith(prefix)) continue
		await rm(resolve(rootDir, entry), { recursive: true, force: true }).catch(() => {})
	}
}

const PRESET_MATERIALIZED_MARKER_FILENAME = ".materialized-complete"

async function collectPresetSourceFiles(sourceDir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[]
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch (error) {
			if (isNodeError(error) && typeof error.code === "string") throw presetSourceFailure(error, error.code)
			throw error
		}
		for (const entry of entries) {
			// Skip nothing — `.md` files, `preset.toml`, `templates/*`, and any
			// author-supplied auxiliary file should all appear in the materialized
			// copy. The one carve-out is our own marker file, which cannot be
			// present in a source tree by construction but we defensively drop it
			// anyway to keep hash stable if an author ever creates a colliding
			// filename.
			if (entry.name === PRESET_MATERIALIZED_MARKER_FILENAME) continue
			const full = resolve(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(full)
			} else if (entry.isFile()) {
				out.push(relative(sourceDir, full))
			}
		}
	}
	await walk(sourceDir)
	out.sort()
	return out
}

// Substitute the engine-owned `{{PRESET_ROOT}}` token with the given absolute
// directory. Called both physically at materialization time (writing the copied
// md files) and in-memory at prompt-read time (so tests that skip materialize
// still get post-substitution content). Idempotent: content without the token
// short-circuits, and re-invoking on already-substituted content is a no-op
// (materialized files contain no token).
export function substitutePresetRootToken(text: string, presetDir: string): string {
	return text.includes(PRESET_ROOT_TOKEN) ? text.replaceAll(PRESET_ROOT_TOKEN, presetDir) : text
}

// Prune stale materialized dirs. Called from daemon start so a series of
// preset edits doesn't grow the loop-data footprint without bound. `keep` is
// the set of dir basenames the daemon has just materialized (or wants to
// preserve). Staging dirs from prior crashes are also removed unless
// currently in flight — daemon start runs after any prior process died, so
// none should be live.
export async function prunePresetMaterializedRoot(
	materializeRoot: string,
	keep: ReadonlySet<string>,
): Promise<void> {
	const rootDir = resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME)
	let entries: string[]
	try {
		entries = await readdir(rootDir)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
	for (const entry of entries) {
		if (keep.has(entry)) continue
		await rm(resolve(rootDir, entry), { recursive: true, force: true }).catch(() => {})
	}
}

export type LoadPresetOptions = {
	onValidationFinding?: (finding: PresetPlaceholderFinding) => void
	// #408 cross-table DAG checker callback. Invoked once per finding before
	// loadPreset throws (for error verdicts) so daemons can record warn AND
	// error findings on the unified observability stream alongside the
	// placeholder findings — both run in the same load attempt, both feed the
	// same audit surface.
	onDagFinding?: (finding: PresetDagFinding) => void
	// Materialize the preset directory to `<root>/preset-materialized/<name>-<hash>/`
	// before parsing. When set, `preset.presetDir` and every fragment/prompt path
	// resolves to that materialized copy — `{{PRESET_ROOT}}` in md files has been
	// physically substituted with the target absolute path. When omitted, the
	// source directory is parsed directly and `{{PRESET_ROOT}}` is substituted
	// only in-memory at prompt-read time. Daemon callers must set this so agents
	// spawned in random worktrees read stable materialized paths.
	materialize?: { root: string }
}

export async function compilePreset(sourceDir: string, options: LoadPresetOptions = {}): Promise<CompileResult> {
	try {
		return { kind: "compiled", ...(await compilePresetOrThrow(sourceDir, options)) }
	} catch (error) {
		if (error instanceof PresetCompileFailure) return { kind: "rejected", diagnostics: error.diagnostics }
		if (error instanceof PresetStructureError) {
			return { kind: "rejected", diagnostics: [{ verdict: "error", rule: "preset-structure", message: error.message }] }
		}
		throw error
	}
}

export async function loadPreset(sourceDir: string, options: LoadPresetOptions = {}): Promise<CompiledTaskModel> {
	const result = await compilePreset(sourceDir, options)
	if (result.kind === "rejected") presetError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"))
	return result.model
}

async function compilePresetOrThrow(sourceDir: string, options: LoadPresetOptions): Promise<CompiledPresetProduct> {
	const sourceAbs = resolve(sourceDir)
	const presetDir = options.materialize
		? (await materializePreset(sourceDir, options.materialize.root)).promptRoot
		: sourceAbs
	const tomlPath = resolve(presetDir, "preset.toml")
	const raw = await readPresetSourceText(tomlPath)
	let parsed: BoundaryValue
	try {
		parsed = Bun.TOML.parse(raw)
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new PresetCompileFailure([{ verdict: "error", rule: "preset-toml", message: error.message }])
		}
		throw error
	}
	let preset: Preset
	try {
		preset = parsePreset(parsed, presetDir)
	} catch (error) {
		if (error instanceof RuntimeDataError) {
			throw new PresetCompileFailure([{
				verdict: "error",
				rule: "preset-structure",
				message: error.message,
			}])
		}
		throw error
	}
	// #408 cross-table DAG check runs immediately after `parsePreset` returns
	// the parsed shape and BEFORE per-phase prompt template validation. Order
	// matters for the operator-facing error: a deadlock or dead-vocabulary
	// finding is structural metadata drift (a phase-exit table missing an
	// edge) and is more actionable than a placeholder typo in a prompt the
	// drift would have made unreachable anyway.
	const dagFindings = checkPresetDag(preset)
	const warnings: CompileWarning[] = []
	const dagErrors: PresetDagFinding[] = []
	for (const finding of dagFindings) {
		options.onDagFinding?.(finding)
		if (finding.verdict === "error") dagErrors.push(finding)
		else warnings.push({ verdict: "warn", rule: finding.kind, message: finding.message })
	}
	if (dagErrors.length > 0) {
		const diagnostics = dagErrors.map((finding): PresetCompileErrorDiagnostic => ({ verdict: "error", rule: finding.kind, message: finding.message }))
		const first = diagnostics[0]
		if (first === undefined) throw new CoderLoopError("non-empty DAG errors lost during conversion")
		throw new PresetCompileFailure([first, ...diagnostics.slice(1)])
	}
	const phases: PresetPhase[] = []
	const placeholderErrors: PresetPlaceholderFinding[] = []
	for (const phase of preset.phases) {
		const prompt = await readPresetPhasePrompt(phase, presetDir)
		assertRoleEntryHasNoFrontmatter(prompt, `preset phase "${phase.name}" prompt`)
		const findings = validatePresetPhaseTemplate(prompt, phase, phase.prompt)
		for (const finding of findings) {
			options.onValidationFinding?.(finding)
			if (finding.verdict === "error") placeholderErrors.push(finding)
			else warnings.push({
				verdict: "warn",
				rule: finding.direction,
				message: `${resolve(sourceAbs, relative(presetDir, finding.file))}: {{${finding.key}}} (${finding.direction})`,
			})
		}
		phases.push(phase)
	}
	if (placeholderErrors.length > 0) {
		const diagnostics = placeholderErrors.map((finding): PresetCompileErrorDiagnostic => ({
			verdict: "error", rule: "template-undeclared",
			message: `${finding.file}: {{${finding.key}}} (${finding.direction})`,
		}))
		const first = diagnostics[0]
		if (first === undefined) throw new CoderLoopError("non-empty placeholder errors lost during conversion")
		throw new PresetCompileFailure([first, ...diagnostics.slice(1)])
	}
	for (const fragment of preset.fragments) {
		await assertReadable(fragment.path, `preset fragment "${fragment.id}"`)
	}
	const sourceHash = await hashPresetSource(sourceAbs)
	return {
		model: {
			...preset,
			phases,
			sourceDir: sourceAbs,
			sourceHash,
			tasks: buildCompiledTaskTree(phases),
		},
		warnings,
	}
}

async function hashPresetSource(sourceDir: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256")
	for (const rel of await collectPresetSourceFiles(sourceDir)) {
		hasher.update(rel)
		hasher.update("\0")
		hasher.update(await readPresetSourceBytes(resolve(sourceDir, rel)))
		hasher.update("\0")
	}
	return hasher.digest("hex")
}

export function parsePreset(value: BoundaryValue, presetDir: string): Preset {
	const root = assertArk(PresetTomlBoundary, value, "preset")

	for (const status of root.statuses.continuable) {
		if (root.statuses.terminal.includes(status)) presetError(`preset.statuses: "${status}" appears in both continuable and terminal`)
	}
	const continuableStatuses = root.statuses.continuable.map((status, index) => parseInternalStatus(status, `preset.statuses.continuable[${index}]`))
	const terminalStatuses = root.statuses.terminal.map((status, index) => parseInternalStatus(status, `preset.statuses.terminal[${index}]`))
	const successStatusNames = root.statuses.success ?? []
	const successStatuses = successStatusNames.map((status, index) => parseInternalStatus(status, `preset.statuses.success[${index}]`))
	for (const status of successStatusNames) {
		if (!root.statuses.terminal.includes(status)) presetError(`preset.statuses.success: "${status}" must be one of statuses.terminal`)
	}
	const entryStatusName = root.statuses.entry ?? root.statuses.continuable[0]
	if (entryStatusName === undefined) presetError("preset.statuses: continuable must declare at least one status")
	if (!root.statuses.continuable.includes(entryStatusName)) presetError(`preset.statuses.entry: "${entryStatusName}" must be one of statuses.continuable`)
	const entryStatus = parseInternalStatus(entryStatusName, "preset.statuses.entry")
	const unblockableStatusNames = root.statuses.unblockable ?? []
	const unblockableStatuses = unblockableStatusNames.map((status, index) => parseInternalStatus(status, `preset.statuses.unblockable[${index}]`))
	const seenUnblockableStatuses = new Set<string>()
	for (const status of unblockableStatusNames) {
		if (!root.statuses.terminal.includes(status)) presetError(`preset.statuses.unblockable: "${status}" must be one of statuses.terminal`)
		if (seenUnblockableStatuses.has(status)) presetError(`preset.statuses.unblockable: duplicate status "${status}"`)
		seenUnblockableStatuses.add(status)
	}
	// #402: exhaustedStatus is a required preset declaration (D2 verdict). The arktype boundary
	// already rejects a missing field with the field path, but the value must also be a member of
	// the terminal vocabulary so the engine can write it without re-validating the contract on
	// each transition.
	if (!root.statuses.terminal.includes(root.statuses.exhausted)) {
		presetError(`preset.statuses.exhausted: "${root.statuses.exhausted}" must be one of statuses.terminal`)
	}
	const exhaustedStatus = parseInternalStatus(root.statuses.exhausted, "preset.statuses.exhausted")
	// #404: preset declares the retry status name so doc builders never carry it as a literal.
	const retryStatusName = root.statuses.retry ?? null
	let retryStatus: InternalStatus | null = null
	if (retryStatusName !== null) {
		if (!root.statuses.continuable.includes(retryStatusName)) {
			presetError(`preset.statuses.retry: "${retryStatusName}" must be one of statuses.continuable`)
		}
		retryStatus = parseInternalStatus(retryStatusName, "preset.statuses.retry")
	}
	const statusNames = new Set<string>([...root.statuses.continuable, ...root.statuses.terminal])
	const itemFields = parsePresetItemFields(root.item.fields ?? {}, "preset.item.fields")
	// #419: post-#419 the `idField` value lives inside the per-item `extra` JSON under the same key
	// (the items physical-shape retire moved `issue_number` integer column → `item_id` opaque string
	// plus a salvage into `extra.<idField>`). A preset is therefore allowed — and for typed bindings
	// usually required — to also declare the idField inside `[item.fields]` so prompt placeholders
	// like `{{ISSUE}}` resolve through the standard `[item.fields]` typing pipeline instead of relying
	// on the engine-builtin string fallback. The pre-#419 rule that forbade this redeclaration was
	// guarding the now-retired structural escape (`LEGACY_TRANSPARENT_ITEM_FIELDS` fed
	// `item.issueNumber` to the resolver bypassing `[item.fields]`); with that escape gone the rule
	// no longer has anything to guard against.
	const attemptTimeoutSeconds = root.agent?.attemptTimeoutSeconds ?? DEFAULT_ATTEMPT_TIMEOUT_SECONDS
	if (!Number.isFinite(attemptTimeoutSeconds) || attemptTimeoutSeconds <= 0) {
		presetError("preset.agent.attemptTimeoutSeconds: must be a finite positive number")
	}
	const runtimeBusinessKeys = parsePresetRuntimeBusinessKeys(root.runtime?.businessKeys ?? [], "preset.runtime.businessKeys")
	const runtimeBusinessKeySet = new Set(runtimeBusinessKeys)
	const runtimeBusinessKeyValues = parsePresetRuntimeBusinessKeyValues(
		root.runtime?.businessKeyValues,
		runtimeBusinessKeys,
		"preset.runtime.businessKeyValues",
	)

	// Parse fragments before phases so phase.roles validation can check the
	// declared role universe (issue #400: phase↔role mapping is preset
	// metadata; the engine never infers roles from phase names).
	const fragmentIds = new Set<string>()
	const fragments: PresetFragment[] = []
	const fragmentRoles = new Set<string>()
	for (const [index, entry] of (root.fragments ?? []).entries()) {
		if (fragmentIds.has(entry.id)) presetError(`preset.fragments[${index}].id: duplicate id "${entry.id}"`)
		fragmentIds.add(entry.id)
		fragmentRoles.add(entry.role)
		fragments.push({ id: entry.id, role: entry.role, path: resolve(presetDir, entry.path) })
	}

	const phaseNames = new Set<string>()
	const phases: PresetPhase[] = []
	for (const [index, entry] of root.phases.entries()) {
		if (phaseNames.has(entry.name)) presetError(`preset.phases[${index}].name: duplicate name "${entry.name}"`)
		phaseNames.add(entry.name)
		const variablesRaw = entry.variables ?? {}
		if (!isObjectRecord(variablesRaw)) presetError(`preset.phases[${index}].variables: must be an object`)
		const variables: PresetPhaseVariable[] = []
		for (const [key, val] of Object.entries(variablesRaw)) {
			const variable = parseVariableBinding(val, `preset.phases[${index}].variables.${key}`)
			const parsedSource = parseVariableSource(variable.source, `preset.phases[${index}].variables.${key}`)
			if (parsedSource.kind !== "chain" && variable.chainFallback.kind !== "none") {
				presetError(`preset.phases[${index}].variables.${key}.default: defaults are only supported for chain bindings`)
			}
			const baseSource: PresetVariableSource = parsedSource.kind === "chain"
				? { ...parsedSource, fallback: variable.chainFallback }
				: parsedSource
			if (baseSource.kind === "item") {
				const itemField = itemFieldRoot(baseSource.field)
				if (!isKnownPresetItemField(itemField, root.item.idField, itemFields)) {
					presetError(`preset.phases[${index}].variables.${key}: unrecognized item field "${baseSource.field}" (engine fields: ${[...ENGINE_ITEM_BINDING_KEYS].join(", ")}; idField: ${root.item.idField}; declared fields: ${[...itemFields.keys()].join(", ") || "<none>"})`)
				}
			}
			let source: PresetVariableSource = baseSource
			if (baseSource.kind === "runtime" && !isEngineRuntimeBindingKey(baseSource.key)) {
				if (!runtimeBusinessKeySet.has(baseSource.key)) {
					presetError(`preset.phases[${index}].variables.${key}: unknown runtime key "${baseSource.key}" (engine facts: ${ENGINE_RUNTIME_BINDING_KEYS.join(", ")}; preset business keys: ${runtimeBusinessKeys.join(", ") || "<none>"})`)
				}
				source = { ...baseSource, ownership: "preset" }
			}
			variables.push({ key, source, doc: variable.doc })
		}
			const trigger = parsePresetPhaseTrigger(entry.trigger ?? null, `preset.phases[${index}].trigger`)
			const runner = parsePhaseRunner(entry.runner ?? null, `preset.phases[${index}].runner`)
			const model = parsePhaseModel(entry.model ?? null, `preset.phases[${index}].model`)
			const exits = parsePresetPhaseExits(entry.exits ?? [], `preset.phases[${index}].exits`)
		if (Object.hasOwn(entry, "statusWrites")) {
			presetError(`preset.phases[${index}].statusWrites: use [[phases.exits]] with status and when`)
		}
		const roles = parsePresetPhaseRoles(
			entry.roles ?? null,
			fragments.length > 0,
			fragmentRoles,
			`preset.phases[${index}].roles`,
		)
		// #407 normalize the optional `[phases.rights]` segment to a default-deny runtime record.
		// Missing segment → every field false / empty set; the gate downstream never has to branch
		// on "rights absent". Schema parsing is the only place that knows about the toml-side shape.
		const rights = parsePresetPhaseRights(entry.rights ?? null, `preset.phases[${index}].rights`)
		phases.push({ name: entry.name, prompt: resolve(presetDir, entry.prompt), exits, variables, trigger, defaultRunner: runner, defaultModel: model, roles, rights })
	}
	if (!phases.some((phase) => phase.trigger === null)) presetError("preset.phases: must include at least one non-trigger phase")

		for (const [index, phase] of phases.entries()) {
			const phaseExitStatuses = new Set<string>()
			const phaseExitChainActions = new Set<string>()
			for (const exit of phase.exits) {
				switch (exit.kind) {
					case "item-status": {
						if (!statusNames.has(exit.status)) {
							presetError(`preset.phases[${index}].exits.status: unrecognized status "${exit.status}"`)
						}
						if (phaseExitStatuses.has(exit.status)) {
							presetError(`preset.phases[${index}].exits.status: duplicate status "${exit.status}"`)
						}
						phaseExitStatuses.add(exit.status)
						break
					}
					case "chain-action": {
						if (phaseExitChainActions.has(exit.action)) {
							presetError(`preset.phases[${index}].exits.chainAction: duplicate action "${exit.action}"`)
						}
						phaseExitChainActions.add(exit.action)
						break
					}
					default:
						assertNeverPhaseExit(exit)
				}
			}
			if (phase.trigger === null) continue
			if (isChainCompleteTrigger(phase.trigger)) continue
			const trigger = phase.trigger
			if (!phaseNames.has(trigger.afterPhase)) {
				presetError(`preset.phases[${index}].trigger.afterPhase: unrecognized phase "${trigger.afterPhase}"`)
			}
			if (!statusNames.has(trigger.whenStatus)) {
				presetError(`preset.phases[${index}].trigger.whenStatus: unrecognized status "${trigger.whenStatus}"`)
			}
			const triggerSourcePhase = phases.find((candidate) => candidate.name === trigger.afterPhase)
			// #405: trigger linkage is keyed on item-status only (no chain-action exit can be
			// the `whenStatus` of another phase — chain-action exits do not write item status).
			const triggerSourceExits = new Set((triggerSourcePhase?.exits ?? []).flatMap((exit) => exit.kind === "item-status" ? [exit.status] : []))
			if (!triggerSourceExits.has(trigger.whenStatus)) {
				presetError(`preset.phases[${index}].trigger.whenStatus: status "${trigger.whenStatus}" is not declared by phase "${trigger.afterPhase}" item-status exits`)
			}
		}

	return {
		name: root.name,
		presetDir,
		item: { idField: root.item.idField, fields: itemFields },
		runtime: { businessKeys: runtimeBusinessKeys, businessKeyValues: runtimeBusinessKeyValues },
			statuses: { continuable: continuableStatuses, terminal: terminalStatuses, success: successStatuses, entry: entryStatus, unblockable: unblockableStatuses, exhausted: exhaustedStatus, retry: retryStatus },
		phases,
		fragments,
		agent: { attemptTimeoutSeconds },
	}
}

async function readPresetPhasePrompt(phase: PresetPhase, presetDir: string): Promise<string> {
	try {
		const raw = await readFile(phase.prompt, "utf-8")
		return substitutePresetRootToken(raw, presetDir)
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw missingPresetSource(`Missing preset phase "${phase.name}" prompt file: ${phase.prompt}`)
		}
		if (isNodeError(error) && typeof error.code === "string") throw presetSourceFailure(error, error.code)
		throw error
	}
}

type ParsedVariableBinding = {
	source: string
	doc: PresetVariableDoc | null
	chainFallback: ChainBindingFallback
}

function parsePresetItemFields(value: BoundaryValue, label: string): ReadonlyMap<string, PresetItemField> {
	if (!isObjectRecord(value) || Array.isArray(value)) presetError(`${label}: must be an object`)
	const fields = new Map<string, PresetItemField>()
	for (const [name, rawField] of Object.entries(value)) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) presetError(`${label}.${name}: field name must match ^[a-zA-Z][a-zA-Z0-9_]*$`)
		const fieldType = parsePresetItemFieldType(rawField, `${label}.${name}`)
		fields.set(name, { type: fieldType })
	}
	return fields
}

function parsePresetItemFieldType(value: BoundaryValue, label: string): PresetItemFieldType {
	if (typeof value === "string") {
		if (isPresetItemFieldType(value)) return value
		presetError(`${label}: type must be one of ${PRESET_ITEM_FIELD_TYPES.join(", ")}`)
	}
	if (!isObjectRecord(value) || Array.isArray(value)) presetError(`${label}: must be a field type string or { type = ... } object`)
	const typeValue = value.type
	if (typeof typeValue !== "string" || !isPresetItemFieldType(typeValue)) {
		presetError(`${label}.type: must be one of ${PRESET_ITEM_FIELD_TYPES.join(", ")}`)
	}
	return typeValue
}

function isPresetItemFieldType(value: string): value is PresetItemFieldType {
	return (PRESET_ITEM_FIELD_TYPES as readonly string[]).includes(value)
}

function parsePresetRuntimeBusinessKeys(value: readonly string[], label: string): readonly string[] {
	const keys: string[] = []
	const seen = new Set<string>()
	for (const [index, key] of value.entries()) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) presetError(`${label}[${index}]: key must match ^[a-zA-Z][a-zA-Z0-9_]*$`)
		if (isEngineRuntimeBindingKey(key)) presetError(`${label}[${index}]: "${key}" is engine-owned; do not redeclare it as a preset business key`)
		if (seen.has(key)) presetError(`${label}[${index}]: duplicate key "${key}"`)
		seen.add(key)
		keys.push(key)
	}
	return keys
}

// Parse `[runtime.businessKeyValues]`: optional table mapping declared business
// key names to a value spec the preset supplies. Each value spec is currently
// `{ literal = "<string>" }` — leaving room to grow other supply kinds without
// breaking the existing inline-table shape. Validated against the declared
// `businessKeys` list (issue #448): every key in this table must be declared,
// engine-owned keys are rejected (already enforced for declarations).
function parsePresetRuntimeBusinessKeyValues(
	value: BoundaryValue,
	declaredKeys: readonly string[],
	label: string,
): ReadonlyMap<string, PresetBusinessKeyValue> {
	const result = new Map<string, PresetBusinessKeyValue>()
	if (value === undefined) return result
	if (!isObjectRecord(value) || Array.isArray(value)) presetError(`${label}: must be a table`)
	const declaredSet = new Set(declaredKeys)
	for (const [key, raw] of Object.entries(value)) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) presetError(`${label}.${key}: key must match ^[a-zA-Z][a-zA-Z0-9_]*$`)
		if (!declaredSet.has(key)) {
			presetError(`${label}.${key}: not declared in preset.runtime.businessKeys (declared: ${declaredKeys.join(", ") || "<none>"})`)
		}
		if (!isObjectRecord(raw) || Array.isArray(raw)) presetError(`${label}.${key}: must be a value spec table (e.g. { literal = "..." })`)
		const keys = Object.keys(raw)
		if (keys.length === 0) presetError(`${label}.${key}: value spec must declare one of: literal`)
		if (keys.length > 1) presetError(`${label}.${key}: value spec must declare exactly one of: literal (got ${keys.join(", ")})`)
		if (Object.hasOwn(raw, "literal")) {
			const literal = raw.literal
			if (typeof literal !== "string") presetError(`${label}.${key}.literal: must be a string`)
			result.set(key, { kind: "literal", value: literal })
			continue
		}
		presetError(`${label}.${key}: unrecognized value spec key "${keys[0]}" (supported: literal)`)
	}
	return result
}

function isKnownPresetItemField(field: string, idField: string, itemFields: ReadonlyMap<string, PresetItemField>): boolean {
	return field === idField || ENGINE_ITEM_BINDING_KEYS.has(field) || itemFields.has(field)
}

const PRESET_VARIABLE_BINDING_FIELDS = new Set([
	"source",
	"default",
	"label",
	"prefix",
	"suffix",
	"style",
	"blankBefore",
])

function parseVariableBinding(value: BoundaryValue, label: string): ParsedVariableBinding {
	if (typeof value === "string") return { source: value, doc: null, chainFallback: { kind: "none" } }
	if (!isObjectRecord(value)) presetError(`${label}: must be a string or { source, label } object`)
	const unknownField = Object.keys(value).find((field) => !PRESET_VARIABLE_BINDING_FIELDS.has(field))
	if (unknownField !== undefined) presetError(`${label}.${unknownField}: unrecognized variable binding field`)
	const source = value.source
	if (typeof source !== "string") presetError(`${label}.source: must be a string`)
	const chainFallback: ChainBindingFallback = Object.hasOwn(value, "default")
		? { kind: "value", value: parseChainBindingDefaultValue(value.default, `${label}.default`) }
		: { kind: "none" }
	const labelValue = value.label
	if (labelValue === undefined) {
		const declaredDocFields = ["prefix", "suffix", "style", "blankBefore"].filter((field) => Object.hasOwn(value, field))
		if (declaredDocFields.length > 0) {
			presetError(`${label}.label: required when doc decoration fields are declared (${declaredDocFields.join(", ")})`)
		}
		return { source, doc: null, chainFallback }
	}
	if (typeof labelValue !== "string") presetError(`${label}.label: must be a string`)
	const prefixValue = value.prefix
	if (prefixValue !== undefined && typeof prefixValue !== "string") presetError(`${label}.prefix: must be a string`)
	const suffixValue = value.suffix
	if (suffixValue !== undefined && typeof suffixValue !== "string") presetError(`${label}.suffix: must be a string`)
	const styleValue = value.style ?? "code"
	if (styleValue !== "code" && styleValue !== "plain") presetError(`${label}.style: must be "code" or "plain"`)
	const blankBeforeValue = value.blankBefore ?? false
	if (typeof blankBeforeValue !== "boolean") presetError(`${label}.blankBefore: must be a boolean`)
	return { source, doc: { label: labelValue, prefix: prefixValue ?? "", suffix: suffixValue ?? "", style: styleValue, blankBefore: blankBeforeValue }, chainFallback }
}

function parseChainBindingDefaultValue(value: BoundaryValue, label: string): ChainBindingScalar {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number" && Number.isFinite(value)) return value
	presetError(`${label}: chain binding defaults must be null, string, number, or boolean`)
}

function parsePhaseRunner(value: BoundaryValue, label: string): AgentRunnerKind | null {
	if (value === null) return null
	if (value !== "claude" && value !== "codex" && value !== "opencode") presetError(`${label}: must be "claude", "codex", or "opencode"`)
	return value
}

// Parse the `[[phases]].rights` segment into the runtime `PresetPhaseRights` ADT (#407).
// Missing segment / missing fields → default-deny so the create-gate (and #410/#409 once
// they consume the same shape) never has to branch on "rights absent". `writableFields` /
// `privilegedOps` become `ReadonlySet<...>` for O(1) membership checks at gate sites.
// A duplicate string in either array is a preset authoring error (rejected here so the
// downstream consumers see a clean set).
//
// #409: `privilegedOps` is narrowed against the engine's closed
// `PresetPhasePrivilegedOp` union (`PRESET_PHASE_PRIVILEGED_OPS` tuple) at the parser
// boundary. An unknown value fails preset load with the full vocabulary in the error
// message — runtime gates therefore never have to defend against unknown op strings.
// `writableFields` stays open-vocabulary because the field universe is preset-declared.
function parsePresetPhaseRights(
	value: typeof PresetPhaseRightsBoundary.infer | null,
	label: string,
): PresetPhaseRights {
	if (value === null) {
		return { createItems: false, writableFields: new Set(), privilegedOps: new Set() }
	}
	return {
		createItems: value.createItems ?? false,
		writableFields: parsePresetPhaseRightsWritableFields(value.writableFields ?? null, `${label}.writableFields`),
		privilegedOps: parsePresetPhaseRightsPrivilegedOps(value.privilegedOps ?? null, `${label}.privilegedOps`),
	}
}

// #410 parser for `[phases.rights] writableFields`. Open-vocabulary (preset declares its own
// universe of writable keys — both top-level item-update fields and inner `extra` keys) BUT
// closed-rejection on the engine's control-plane vocabulary: `runner` / `repoCwd` / `dependsOn` /
// `priority` are scheduler/executor decisions and cannot be granted to any agent. The reserved
// set lives in `daemon.ts` (PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS) so the parser and the
// per-request gate share one source of truth — a future control-plane addition only changes the
// tuple in daemon.ts. The error message names the forbidden field, lists the engine's full
// control-plane vocabulary, and clarifies why no preset can grant it (default-deny + no preset
// surface, mirrors #409 acceptance #1 for the privileged-op axis).
function parsePresetPhaseRightsWritableFields(value: readonly string[] | null, label: string): ReadonlySet<string> {
	if (value === null) return new Set()
	const set = new Set<string>()
	for (const [index, entry] of value.entries()) {
		if (entry.trim() === "") presetError(`${label}[${index}]: must be a non-empty string`)
		if (set.has(entry)) presetError(`${label}[${index}]: duplicate entry "${entry}"`)
		if (PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELD_SET.has(entry)) {
			presetError(
				`${label}[${index}]: "${entry}" is a control-plane field (engine control-plane vocabulary: ${PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS.join(", ")}); ` +
					"control-plane fields are agent-default-deny with no preset surface to grant them",
			)
		}
		set.add(entry)
	}
	return set
}

// #409: narrow each entry to `PresetPhasePrivilegedOp` at preset load. Unknown ops fail with
// the full engine vocabulary in the error so the preset author sees what they can declare.
function parsePresetPhaseRightsPrivilegedOps(
	value: readonly string[] | null,
	label: string,
): ReadonlySet<PresetPhasePrivilegedOp> {
	if (value === null) return new Set()
	const set = new Set<PresetPhasePrivilegedOp>()
	for (const [index, entry] of value.entries()) {
		if (entry.trim() === "") presetError(`${label}[${index}]: must be a non-empty string`)
		const narrowed = narrowPresetPhasePrivilegedOp(entry)
		if (narrowed === null) {
			presetError(
				`${label}[${index}]: unknown privileged op "${entry}" (declared engine vocabulary: ${PRESET_PHASE_PRIVILEGED_OPS.join(", ")})`,
			)
		}
		if (set.has(narrowed)) presetError(`${label}[${index}]: duplicate entry "${entry}"`)
		set.add(narrowed)
	}
	return set
}

function narrowPresetPhasePrivilegedOp(value: string): PresetPhasePrivilegedOp | null {
	const found = PRESET_PHASE_PRIVILEGED_OPS.find((op) => op === value)
	return found ?? null
}

// Parse the `[[phases]].roles` field and validate against the declared fragment
// role universe. Issue #400: when a preset declares any fragments, every phase
// must declare which fragment roles it sees — the engine never infers role
// membership from phase name. Presets with zero fragments may omit `roles`;
// the index slice is empty either way.
function parsePresetPhaseRoles(
	value: readonly string[] | null,
	presetHasFragments: boolean,
	declaredRoles: ReadonlySet<string>,
	label: string,
): readonly string[] {
	if (value === null) {
		if (presetHasFragments) {
			const known = [...declaredRoles].sort().join(", ") || "<none>"
			presetError(`${label}: required when preset declares fragments (declared fragment roles: ${known})`)
		}
		return []
	}
	const seen = new Set<string>()
	const result: string[] = []
	for (const [index, role] of value.entries()) {
		if (role.trim() === "") presetError(`${label}[${index}]: must be a non-empty string`)
		if (seen.has(role)) presetError(`${label}[${index}]: duplicate role "${role}"`)
		seen.add(role)
		if (!declaredRoles.has(role)) {
			const known = [...declaredRoles].sort().join(", ") || "<none>"
			presetError(`${label}[${index}]: unrecognized role "${role}" (declared fragment roles: ${known})`)
		}
		result.push(role)
	}
	return result
}

function parsePhaseModel(value: BoundaryValue, label: string): string | null {
	if (value === null) return null
	if (typeof value !== "string" || value.trim() === "") presetError(`${label}: must be a non-empty string`)
	return value
}

function parsePresetPhaseExits(value: BoundaryValue, label: string): PresetPhaseExit[] {
	// #405 ADT: arktype's `or` returns a union — narrow per entry on the
	// discriminating field present in the wire shape. The discriminated TS shape
	// (`kind`) is inserted here so downstream consumers stay union-switching
	// rather than re-detecting from the wire fields.
	const exits = assertArk(PresetPhaseExitBoundary.array(), value, label)
	return exits.map((entry, index) => {
		if ("status" in entry) {
			return { kind: "item-status" as const, status: parseInternalStatus(entry.status, `${label}[${index}].status`), when: entry.when }
		}
		return { kind: "chain-action" as const, action: entry.chainAction, when: entry.when }
	})
}

function assertRoleEntryHasNoFrontmatter(markdown: string, label: string): void {
	if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return
	presetError(`${label}: frontmatter metadata is not supported; move phase runner metadata to preset.toml`)
}

// Legacy role-entry frontmatter must never reach an agent prompt. claude 2.1.160 rejects a
// `-p` value starting with `--`, so direct renderPrompt callers still strip it at the seam;
// loadPreset rejects metadata frontmatter before runtime.
export function stripRoleEntryFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return markdown
	const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown)
	if (match === null) return markdown
	return markdown.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "")
}

function parseVariableSource(value: string, label: string): ParsedVariableSource {
	const match = /^(item|chain|runtime)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)$/.exec(value)
	if (!match) presetError(`${label}: invalid variable source "${value}" (expected item.<f> | chain.<f> | runtime.<k>)`)
	const kind = parseVariableSourceKind(match[1]!, label)
	const fieldOrKey = match[2]!
	if (kind !== "item" && fieldOrKey.includes(".")) presetError(`${label}: ${kind} bindings do not support nested paths`)
	return kind === "runtime" ? { kind, key: fieldOrKey } : { kind, field: fieldOrKey }
}

function parseVariableSourceKind(value: string, label: string): "item" | "chain" | "runtime" {
	if (value === "item" || value === "chain" || value === "runtime") return value
	presetError(`${label}: invalid variable source prefix "${value}"`)
}

function itemFieldRoot(field: string): string {
	return field.split(".")[0] ?? field
}

function parsePresetPhaseTrigger(value: typeof PresetPhaseTriggerBoundary.infer | null, label: string): PresetPhaseTrigger | null {
	if (value === null) return null
	const hasAfterPhase = value.afterPhase !== undefined
	const hasWhenStatus = value.whenStatus !== undefined
	const hasOn = value.on !== undefined
	if (hasOn) {
		if (value.on !== "chain-complete") presetError(`${label}.on: unsupported trigger event "${value.on}"`)
		if (hasAfterPhase || hasWhenStatus) presetError(`${label}: chain-complete trigger cannot also declare afterPhase/whenStatus`)
		return { on: "chain-complete" }
	}
	if (hasAfterPhase && hasWhenStatus) return { afterPhase: value.afterPhase!, whenStatus: parseInternalStatus(value.whenStatus!, `${label}.whenStatus`) }
	presetError(`${label}: trigger must declare either afterPhase + whenStatus or on = "chain-complete"`)
}

function isChainCompleteTrigger(trigger: PresetPhaseTrigger): trigger is { on: "chain-complete" } {
	return "on" in trigger
}

function presetError(message: string): never {
	throw new PresetStructureError(message)
}


// #433: per-target on-disk runtime readers are retired. The only on-disk reader the engine keeps
// is the preset.toml itself; chain metadata covers everything else.

async function assertReadable(path: string, label: string): Promise<void> {
	try {
		await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw missingPresetSource(`Missing ${label} file: ${path}`)
		}
		if (isNodeError(error) && typeof error.code === "string") throw presetSourceFailure(error, error.code)
		throw error
	}
}

export function detectHostRunner(env: Record<string, string | undefined>): AgentRunnerKind {
	if (env.CODEX_SHELL === "1" || env.CODEX_THREAD_ID !== undefined || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.toLowerCase().includes("codex") === true) return "codex"
	if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE !== undefined || env.CLAUDE_SESSION_ID !== undefined || env.CLAUDE_PROJECT_DIR !== undefined) return "claude"
	return "claude"
}

// #433: runner binary / model / extraArgs come exclusively from chain.metadata.<kind> now —
// the retired target on-disk preferences file no longer layers anything on top. Defaults are
// the kind name on PATH (claude/codex/opencode) with no extra args.
// #481: opencode joins the slot list with the same shape; when a phase declares runner=opencode
// with no explicit `model`, applyPhaseDefaultModel falls back to DEFAULT_OPENCODE_MODEL — the
// only model the operator's opencode provider is currently configured for, per the issue body
// dependency footnote.
export const DEFAULT_OPENCODE_MODEL = "opencode-go/glm-5.2"
export function buildAgentRunnerCommands(resolved: Pick<ChainResolved, "claudeBinary" | "claudeModel" | "claudeExtraArgs" | "codexBinary" | "codexModel" | "codexExtraArgs" | "opencodeBinary" | "opencodeModel" | "opencodeExtraArgs">): AgentRunnerCommands {
	return {
		claude: {
			kind: "claude",
			binary: resolved.claudeBinary ?? "claude",
			extraArgs: [...resolved.claudeExtraArgs],
			model: resolved.claudeModel,
		},
		codex: {
			kind: "codex",
			binary: resolved.codexBinary ?? "codex",
			extraArgs: [...resolved.codexExtraArgs],
			model: resolved.codexModel,
		},
		opencode: {
			kind: "opencode",
			binary: resolved.opencodeBinary ?? "opencode",
			extraArgs: [...resolved.opencodeExtraArgs],
			model: resolved.opencodeModel,
		},
	}
}

export function selectEngineBuiltinRunner(commands: AgentRunnerCommands): AgentRunnerSelection {
	return { ...commands[ENGINE_BUILTIN_RUNNER], source: "engine-builtin" }
}

export function selectDefaultRunner(commands: AgentRunnerCommands): AgentRunnerSelection {
	return selectEngineBuiltinRunner(commands)
}

export type PhaseRunnerSelectionInput = {
	preset: Preset
	defaultRunner: AgentRunnerSelection
	runnerCommands: AgentRunnerCommands
}

function selectRunnerForItemOverride(item: Pick<ItemRecord, "runner">, input: Pick<PhaseRunnerSelectionInput, "runnerCommands">): AgentRunnerSelection | null {
	if (item.runner === null) return null
	return { ...input.runnerCommands[item.runner], source: "queue" }
}

function phaseByName(preset: Preset, phaseName: string): PresetPhase {
	const phase = preset.phases.find((entry) => entry.name === phaseName)
	if (phase === undefined) fail(`preset ${preset.name} does not define phase "${phaseName}"`)
	return phase
}

// #456: item override applies to every non-trigger phase, no engine assumption about which phase is
// "review" or "the last non-trigger phase". A preset that wants to lock a phase to its declared
// runner can omit `item.runner` from its queue intake (or override the phase runner at the preset
// level); the engine no longer special-cases phase names. Trigger phases stay engine-managed because
// they're spawned from the chain-complete / per-item-trigger drivers, not from the per-item queue.
function allowsItemRunnerOverride(phase: PresetPhase): boolean {
	return phase.trigger === null
}

function phaseDefaultRunnerKind(phase: PresetPhase): AgentRunnerKind {
	return phase.defaultRunner ?? ENGINE_BUILTIN_RUNNER
}

// Preset-declared phase model is a default; an explicit config model (claude.model /
// codex.model / opencode.model) overrides it. The phase model is bound to the phase's
// declared runner kind, so an item override switching to a different runner does not
// inherit it.
// #481: when the phase declares runner = "opencode" but no explicit `model`, fall back to the
// engine default `opencode-go/glm-5.2`. Explicit phase model still wins; chain.metadata
// opencode.model still wins; item override to claude/codex still ignores opencode defaults
// entirely (same kind-binding rule as before).
function applyPhaseDefaultModel(selection: AgentRunnerSelection, phase: PresetPhase): AgentRunnerSelection {
	if (selection.model !== null) return selection
	if (phase.defaultModel !== null && selection.kind === phaseDefaultRunnerKind(phase)) {
		return { ...selection, model: phase.defaultModel }
	}
	if (selection.kind === "opencode" && selection.kind === phaseDefaultRunnerKind(phase)) {
		return { ...selection, model: DEFAULT_OPENCODE_MODEL }
	}
	return selection
}

export function selectPhaseDefaultRunner(phase: PresetPhase, _preset: Preset, commands: AgentRunnerCommands): AgentRunnerSelection {
	const kind = phaseDefaultRunnerKind(phase)
	const command = commands[kind]
	const source: AgentRunnerSource = phase.defaultRunner === null ? "engine-builtin" : "preset"
	return applyPhaseDefaultModel({ ...command, source }, phase)
}

export function selectPhaseDefaultRunners(preset: Preset, commands: AgentRunnerCommands): Record<string, AgentRunnerSelection> {
	const runners: Record<string, AgentRunnerSelection> = {}
	for (const phase of preset.phases) runners[phase.name] = selectPhaseDefaultRunner(phase, preset, commands)
	return runners
}

export function selectPhaseRunnersForItem(preset: Preset, item: Pick<ItemRecord, "runner">, commands: AgentRunnerCommands): Record<string, AgentRunnerSelection> {
	const runners: Record<string, AgentRunnerSelection> = {}
	for (const phase of preset.phases) {
		const override = allowsItemRunnerOverride(phase) ? selectRunnerForItemOverride(item, { runnerCommands: commands }) : null
		runners[phase.name] = override === null ? selectPhaseDefaultRunner(phase, preset, commands) : applyPhaseDefaultModel(override, phase)
	}
	return runners
}

export function selectRunnerForPhase(phase: string, item: Pick<ItemRecord, "runner">, input: PhaseRunnerSelectionInput): AgentRunnerSelection {
	const presetPhase = phaseByName(input.preset, phase)
	const override = allowsItemRunnerOverride(presetPhase) ? selectRunnerForItemOverride(item, input) : null
	return override === null ? selectPhaseDefaultRunner(presetPhase, input.preset, input.runnerCommands) : applyPhaseDefaultModel(override, presetPhase)
}

export type BuildPhaseRunnerSelectionFromChainInput = {
	chain: ChainRecord
	loopDataRoot: string | null
	preset: Preset
}

export function buildPhaseRunnerSelectionFromChain(input: BuildPhaseRunnerSelectionFromChainInput): PhaseRunnerSelectionInput {
	const resolved = chainResolvedFromChain(input.chain, input.loopDataRoot)
	const runnerCommands = buildAgentRunnerCommands(resolved)
	const defaultRunner = selectPhaseDefaultRunner(firstNonTriggerPhaseForPreset(input.preset), input.preset, runnerCommands)
	return { preset: input.preset, defaultRunner, runnerCommands }
}

export type ResolvePhaseRunnerFromChainInput = BuildPhaseRunnerSelectionFromChainInput & {
	phase: string
	item: Pick<ItemRecord, "runner">
}

export function resolvePhaseRunnerFromChain(input: ResolvePhaseRunnerFromChainInput): AgentRunnerSelection {
	const selection = buildPhaseRunnerSelectionFromChain(input)
	return selectRunnerForPhase(input.phase, input.item, selection)
}

export function firstNonTriggerPhaseForPreset(preset: Preset): PresetPhase {
	const phase = preset.phases.find((entry) => entry.trigger === null) ?? preset.phases[0]
	if (phase === undefined) fail("preset must define at least one phase")
	return phase
}

export function triggeredPhasesAfter(preset: Preset, afterPhase: string, status: InternalStatus): readonly PresetPhase[] {
	return preset.phases.filter((phase) => phase.trigger !== null && !isChainCompleteTrigger(phase.trigger) && phase.trigger.afterPhase === afterPhase && phase.trigger.whenStatus === status)
}

export function chainCompleteTriggerPhases(preset: Preset): readonly PresetPhase[] {
	return preset.phases.filter((phase) => phase.trigger !== null && isChainCompleteTrigger(phase.trigger))
}

export type PresetChainCompleteDecision =
	| { decision: "complete"; reason?: string }
	| { decision: "keep-active"; reason?: string }

export type RunPresetChainCompleteTriggerPhasesPhaseRunner = (phase: string) => AgentRunnerSelection | Promise<AgentRunnerSelection>

export type RunPresetChainCompleteTriggerPhasesInput = {
	chain: ChainRecord
	items: readonly ItemRecord[]
	runId?: string
	terminalStatusNames: readonly InternalStatus[]
	loopDataRoot: string | null
	phaseRunner?: RunPresetChainCompleteTriggerPhasesPhaseRunner
	presetDir?: string
	preset?: Preset
	targetCwd?: string | null
	onStatusPersistenceFailure?: (failure: RunnerStatusPersistenceFailure) => void
}

export async function runPresetChainCompleteTriggerPhases(input: RunPresetChainCompleteTriggerPhasesInput): Promise<PresetChainCompleteDecision | null> {
	const rawTargetCwd = input.targetCwd ?? input.items[0]?.repoCwd
	if (rawTargetCwd === undefined || rawTargetCwd.trim() === "") throw new Error(`chain ${input.chain.id} has no item repoCwd for chain-complete trigger`)
	const targetCwd = resolve(rawTargetCwd)
	const resolved = chainResolvedFromChain(input.chain, input.loopDataRoot)
	const presetDir = input.presetDir ?? resolvePresetDir(resolved, PKG_ROOT, targetCwd)
	const preset = input.preset ?? await loadPreset(presetDir)
	const phases = chainCompleteTriggerPhases(preset)
	if (phases.length === 0) return null

	const options = buildOptions(targetCwd, {
		targetCwd,
		loopDataRoot: input.loopDataRoot,
		chainName: input.chain.name,
		dryRun: false,
		worktree: false,
		chain: input.chain,
	}, resolved, preset)
	if (input.onStatusPersistenceFailure !== undefined) options.onStatusPersistenceFailure = input.onStatusPersistenceFailure
	const anchorRecord = selectFinalizerAnchorItem(input.items, input.runId)
	const anchorId = getItemId(anchorRecord, preset)
	const currentIssueFile = resolveOptionalChainIssueFile(options, input.chain, anchorRecord, "Chain-complete trigger issue file")
	const evidenceDir = resolveChainEvidenceDir(options, input.chain, anchorRecord, anchorId, "Chain-complete trigger evidence directory")
	const finalizerRunId = input.runId ?? makeRunId(`chain-${input.chain.id}`)

	const phaseSelection = buildPhaseRunnerSelectionFromChain({ chain: input.chain, loopDataRoot: input.loopDataRoot, preset })
	const resolvePhaseRunner = async (phase: string): Promise<AgentRunnerSelection> => {
		if (input.phaseRunner !== undefined) return await input.phaseRunner(phase)
		return selectRunnerForPhase(phase, anchorRecord, phaseSelection)
	}

	for (const phase of phases) {
		const ctx: ResolveContext = {
			item: anchorRecord,
			chain: buildRenderBindings(options),
			runtime: buildRuntimeBindings({
				options,
				phase,
				runId: finalizerRunId,
				currentIssueFile,
				evidenceDir,
				agentCwd: targetCwd,
				issueRun: { runIdGeneration: "new", resumedFromPhase: null, resumedStartedAt: null, resumedSessionId: null },
				paths: buildCentralRuntimeBindingPaths({
					options,
					chain: input.chain,
					runId: finalizerRunId,
					currentIssueFile,
					evidenceDir,
				}),
			}),
			preset,
		}
		const promptRaw = await readFile(phase.prompt, "utf-8")
		const prompt = renderPrompt(promptRaw, phase, ctx)
		const outputPath = agentOutputPath(options, finalizerRunId, phase.name)
		const resolvedRunner = await resolvePhaseRunner(phase.name)
		log(`Starting chain-complete trigger phase ${phase.name} for chain ${input.chain.name} (runner=${resolvedRunner.kind})...`)
		const { output, stdoutBytes, code } = await runAgent(options, phase, prompt, outputPath, targetCwd, resolvedRunner, summaryWatchdogConfigForPhase(phase))
		log(`Chain-complete trigger phase ${phase.name} finished: exit=${code}, output=${outputPath} (${stdoutBytes} bytes)`)
		if (code !== 0) throw new Error(`chain-complete trigger phase ${phase.name} exited ${code}`)
		const decision = parseFinalizerSummaryDecision(output, resolvedRunner.kind)
		if (decision === null) throw new Error(`chain-complete trigger phase ${phase.name} did not print a valid FINALIZER SUMMARY`)
		if (decision.decision !== "complete") return decision
	}

	return { decision: "complete" }
}

function selectFinalizerAnchorItem(items: readonly ItemRecord[], runId: string | undefined): ItemRecord {
	const byRunId = runId === undefined ? undefined : items.find((item) => item.lastRunId === runId)
	const item = byRunId ?? items[0]
	if (item === undefined) throw new Error("chain-complete trigger requires at least one chain item")
	return item
}

function parseFinalizerSummaryDecision(output: string, runner: AgentRunnerKind): PresetChainCompleteDecision | null {
	let sawRunnerJson = false
	let decision: PresetChainCompleteDecision | null = null
	for (const line of output.split(/\r?\n/)) {
		const parsed = runnerAgentTextFromJsonLine(line, runner)
		sawRunnerJson = sawRunnerJson || parsed.parsedRunnerEvent
		if (parsed.text === null) continue
		decision = parseFinalizerSummaryDecisionFromText(parsed.text)
	}
	return sawRunnerJson ? decision : parseFinalizerSummaryDecisionFromText(output)
}

function parseFinalizerSummaryDecisionFromText(text: string): PresetChainCompleteDecision | null {
	const summaryLine = finalSummaryLine(text, "FINALIZER SUMMARY:")
	if (summaryLine === null) return null
	const match = summaryLine.match(/^FINALIZER SUMMARY:\s*decision=(complete|keep-active)\s*;(.*)$/)
	if (match === null) return null
	const tail = match[2] ?? ""
	const reasonMatch = tail.match(/(?:^|;)\s*reason=([^;]*)/)
	const reason = reasonMatch?.[1]?.trim()
	return reason === undefined || reason === ""
		? { decision: match[1] as "complete" | "keep-active" }
		: { decision: match[1] as "complete" | "keep-active", reason }
}

// #433: derive the chain-bindings object that wraps into `metadata.bindings`. Strips the
// chain-create top-level scalars (repository / baseBranch — those are first-class chain.create
// fields, not bindings), normalizes a relative `presetPath` to absolute, and rejects nested
// objects under bindings (e.g. `bindings.metadata.<key>` is a stale-shape failure mode the
// daemon also checks via arktype, so a stray nesting fails fast on either path).
const CHAIN_CREATE_NON_BINDING_KEYS = new Set(["repository", "baseBranch"])

function normalizeChainCreateBindings(config: JsonObject): JsonObject {
	const bindings: JsonObject = {}
	for (const [key, value] of Object.entries(config)) {
		if (CHAIN_CREATE_NON_BINDING_KEYS.has(key)) continue
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			fail(`--config-json.${key}: nested objects are not allowed inside chain bindings (got ${JSON.stringify(value)})`)
		}
		bindings[key] = value
	}
	const presetPath = bindings.presetPath
	if (typeof presetPath === "string" && presetPath.trim() !== "" && !isAbsolute(presetPath)) {
		bindings.presetPath = resolve(process.cwd(), presetPath)
	}
	return bindings
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

async function collectStatusRuntimeErrors(
	options: LoopOptions,
	chain: ChainRecord,
	items: readonly ItemRecord[],
	current: CurrentRunRecord | null,
	itemPresets: StatusItemPresetResolver,
): Promise<RuntimeCheckError[]> {
	const errors: RuntimeCheckError[] = []
	const seenIds = new Set<string>()

	if (options.worktree && (options.baseBranch === null || options.baseBranch.trim() === "")) pushCheckError(errors, "worktree", "worktree mode requires a non-empty baseBranch")

	await checkDirectory(options.targetCwd, "targetCwd", errors)
	if (chain.status !== "active" && chain.status !== "completed") pushCheckError(errors, "chain.status", `must be active or completed (got ${chain.status})`)
	await checkCentralRuntimeLayout(options, chain, errors)

	for (const [index, item] of items.entries()) {
		const label = `state.queue[${index}]`
		// #412: validate each item against its own preset's vocabulary. A status that's terminal under
		// one preset can be `pending` under another, so the chain-seed allowedStatuses is not a valid
		// gate in a mixed-preset chain. id duplication is checked per item-preset idField rather than
		// per chain-seed idField because two different presets may use different idField names.
		const itemPreset = itemPresets.presetForItem(item)
		const allowedStatusesForItem = new Set<string>([...itemPreset.statuses.continuable, ...itemPreset.statuses.terminal])
		const idAsString = getItemId(item, itemPreset)
		if (seenIds.has(idAsString)) pushCheckError(errors, `${label}.${itemPreset.item.idField}`, `duplicate id "${idAsString}"`)
		seenIds.add(idAsString)
		if (!allowedStatusesForItem.has(item.status)) pushCheckError(errors, `${label}.status`, `status "${item.status}" is not in preset.statuses (continuable + terminal)`)
		if (!Number.isInteger(item.attempts) || item.attempts < 0) pushCheckError(errors, `${label}.attempts`, "must be a non-negative integer")
		if (item.title !== null && item.title.trim() === "") pushCheckError(errors, `${label}.title`, "must be null or non-empty")
		if (item.priority !== null && item.priority.trim() === "") pushCheckError(errors, `${label}.priority`, "must be null or non-empty")
		// #419: `branch` / `pr` are no longer first-class engine fields. Presets that declare them as
		// `[item.fields]` transparent fields (gh-issue-pr-iteration does) now own their shape validation;
		// the doctor read path stops asserting types it cannot generalize across presets. Shape errors in
		// preset-declared transparent fields surface through `lookupItemField` on the resolve path
		// (`stringifyBindingValue` rejects non-string/number/boolean) — runtime, not doctor-time.
		if (item.lastRunId !== null && item.lastRunId.trim() === "") pushCheckError(errors, `${label}.lastRunId`, "must be null or non-empty")

		if (item.issueFile !== null) {
			checkChainItemPath(options, chain, item.issueFile, `${label}.issueFile`, "issues", errors)
		}
		if (item.evidenceDir !== null) {
			checkChainItemPath(options, chain, item.evidenceDir, `${label}.evidenceDir`, "evidence", errors)
		}
		if (item.agentCwd !== null) {
			if (!isAbsolute(item.agentCwd)) {
				pushCheckError(errors, `${label}.agentCwd`, `must be an absolute path (got "${item.agentCwd}")`)
			} else {
				await checkDirectory(item.agentCwd, `${label}.agentCwd`, errors)
			}
		}
	}

	if (current !== null) {
		// #412: validate the current run against the running item's preset, not the chain seed.
		// The active phase and continuable-status check both belong to the item's preset because
		// the scheduler spawned the run from that preset's phase plan.
		const currentItem = findCurrentItem(current, items, itemPresets)
		const currentItemPreset = currentItem === null ? options.preset : itemPresets.presetForItem(currentItem)
		const allowedPhasesForCurrent = new Set<string>(currentItemPreset.phases.map((phase) => phase.name))
		const currentIdField = currentItemPreset.item.idField
		if (currentItem === null) pushCheckError(errors, `state.current.${currentIdField}`, "current item is not present in queue")
		else if (!currentItemPreset.statuses.continuable.includes(currentItem.status)) pushCheckError(errors, `state.current.${currentIdField}`, `id "${getItemId(currentItem, currentItemPreset)}" has non-continuable status ${currentItem.status}`)
		if (!allowedPhasesForCurrent.has(current.phase)) pushCheckError(errors, "state.current.phase", `phase "${current.phase}" is not declared in preset.phases`)
		if (current.runId.trim() === "") pushCheckError(errors, "state.current.runId", "must not be empty")
	}

	return errors
}

function loopDataRootOption(loopDataRoot: string | null): { loopDataRoot?: string } {
	return loopDataRoot === null ? {} : { loopDataRoot }
}

function unixSeconds(): number {
	return Date.now() / 1000
}

function samePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right)
}

function resolveOptionalChainIssueFile(options: LoopOptions, chain: ChainRecord, item: ItemRecord, label: string): string | null {
	const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
	if (item.issueFile === null || item.issueFile === "") return null
	return resolveChainScopedPath(chainPaths.chainRoot, chainPaths.issuesDir, item.issueFile, label)
}

function resolveChainEvidenceDir(options: LoopOptions, chain: ChainRecord, item: ItemRecord, itemId: string, label: string): string {
	const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
	if (item.evidenceDir === null) return chainPaths.issueEvidenceDir(itemId)
	return resolveChainScopedPath(chainPaths.chainRoot, chainPaths.evidenceDir, item.evidenceDir, label)
}

function resolveChainScopedPath(chainRoot: string, expectedRoot: string, path: string, label: string): string {
	if (path.trim() === "") fail(`${label} must not be empty`)
	if (isAbsolute(path)) fail(`${label} must be relative to the chain root, got absolute path: ${path}`)
	const resolved = resolve(chainRoot, path)
	if (!isWithin(expectedRoot, resolved)) fail(`${label} must resolve inside ${expectedRoot}: ${path}`)
	return resolved
}

export function makeIssueRunContext(current: StatusCurrentRunSnapshot | null): IssueRunContext {
	if (current) {
		return {
			runIdGeneration: "resumed",
			resumedFromPhase: current.phase,
			resumedStartedAt: current.startedAt,
			resumedSessionId: null,
		}
	}

	return {
		runIdGeneration: "new",
		resumedFromPhase: null,
		resumedStartedAt: null,
		resumedSessionId: null,
	}
}

export function getItemId(item: ItemRecord, preset: Preset): string {
	// #419: the opaque `item.itemId` (DB column `items.item_id`) is the engine's authoritative
	// per-row identity. The preset-declared idField is now a passthrough into `extra` so
	// supervisors / agents can read it as `{{<idField>}}` via the standard variable pipeline,
	// but the engine itself derives the rendered id from `itemId` first (so the engine path
	// never needs to know `idField === "issue"` or any other preset-shaped literal). The
	// fallback to `extra[idField]` covers the legacy migration window where an older daemon
	// might have written the idField value to `extra` without copying it back to `item_id` —
	// idempotent against current writers because both store the same string post-#419.
	if (item.itemId.length > 0) return item.itemId
	const value = itemExtraJsonValue(item.extra, preset.item.idField)
	if (typeof value === "string" && value.length > 0) return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	throw new Error(`queue item is missing required id field "${preset.item.idField}"`)
}

// Placeholder grammar shared by load-time validation and render-time substitution:
//   - real placeholder: `{{KEY}}` where KEY matches `[A-Za-z_][A-Za-z0-9_]*`.
//   - literal escape:   `\{{KEY}}` — renders as `{{KEY}}`, never resolved.
// The single regex captures both so the scan stays positional: a value injected
// at render time can legitimately contain `{{...}}` (e.g. when a binding source
// quotes another template) and is never mistaken for residue because it lives
// in a value-position, not a template-position.
const PLACEHOLDER_SCAN_PATTERN = /(\\)?\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

export type PromptPlaceholderMatch =
	| { kind: "placeholder"; key: string; start: number; end: number }
	| { kind: "escape"; key: string; start: number; end: number }

export function extractPromptPlaceholders(template: string): readonly PromptPlaceholderMatch[] {
	const matches: PromptPlaceholderMatch[] = []
	for (const match of template.matchAll(PLACEHOLDER_SCAN_PATTERN)) {
		const start = match.index ?? 0
		const end = start + match[0].length
		const key = match[2]
		if (key === undefined) continue
		const isEscape = match[1] === "\\"
		matches.push(isEscape ? { kind: "escape", key, start, end } : { kind: "placeholder", key, start, end })
	}
	return matches
}

export type PresetPlaceholderFinding = {
	file: string
	key: string
	direction: PresetPlaceholderDirection
	verdict: PresetPlaceholderVerdict
}

// Validate one phase's prompt template against its declared variables.
// `template-undeclared` is always an error (every {{KEY}} in the template must
// resolve to a phase.variables entry, else the bug reaches the agent prompt).
// `declared-unused` is a warn because variables are sometimes referenced only
// by fragments that this validator doesn't see; raising it to error would
// generate noise without protecting agents from a real failure mode.
export function validatePresetPhaseTemplate(
	template: string,
	phase: PresetPhase,
	file: string,
): readonly PresetPlaceholderFinding[] {
	const declared = new Set(phase.variables.map((variable) => variable.key))
	const stripped = stripRoleEntryFrontmatter(template)
	const matches = extractPromptPlaceholders(stripped)
	const findings: PresetPlaceholderFinding[] = []
	const seenUndeclared = new Set<string>()
	const usedDeclared = new Set<string>()
	for (const match of matches) {
		if (match.kind === "escape") continue
		if (declared.has(match.key)) {
			usedDeclared.add(match.key)
			continue
		}
		if (seenUndeclared.has(match.key)) continue
		seenUndeclared.add(match.key)
		findings.push({ file, key: match.key, direction: "template-undeclared", verdict: "error" })
	}
	for (const key of declared) {
		if (usedDeclared.has(key)) continue
		findings.push({ file, key, direction: "declared-unused", verdict: "warn" })
	}
	return findings
}

export function renderPrompt(template: string, phase: PresetPhase, ctx: ResolveContext & { item: ItemRecord }): string {
	const stripped = stripRoleEntryFrontmatter(template)
	const matches = extractPromptPlaceholders(stripped)
	const declared = new Map(phase.variables.map((variable) => [variable.key, variable.source] as const))
	const parts: string[] = []
	let cursor = 0
	for (const match of matches) {
		parts.push(stripped.slice(cursor, match.start))
		if (match.kind === "escape") {
			// Emit the literal `{{KEY}}` (drop the leading backslash).
			parts.push(stripped.slice(match.start + 1, match.end))
			cursor = match.end
			continue
		}
		const source = declared.get(match.key)
		if (source === undefined) {
			throw new Error(
				`renderPrompt: phase "${phase.name}" template contains undeclared placeholder {{${match.key}}} ` +
					"(load-time validation should have caught this; running renderPrompt against a non-loadPreset template is unsupported)",
			)
		}
		parts.push(resolvePhaseBinding(source, phase, ctx))
		cursor = match.end
	}
	parts.push(stripped.slice(cursor))
	return parts.join("")
}

function resolvePhaseBinding(source: PresetVariableSource, phase: PresetPhase, ctx: ResolveContext): string {
	if (source.kind === "runtime") {
		assertRuntimeSourceDeclared(source)
		switch (source.key) {
			case "runtimeInputsDoc": return renderRuntimeInputsDoc(phase, ctx)
			case "phaseExitsDoc": return renderPhaseExitsDoc(phase)
			// #404: per-phase-sliced docs. The render function owns the slice policy
			// (caller does not pre-slice) so a new phase added to a preset cannot
			// silently widen the visibility surface.
			case "statusVocabularyDoc": return renderStatusVocabularyDoc(phase, ctx.preset)
			case "triggerStatusDoc": return renderTriggerStatusDoc(phase)
			case "terminalStatusesDoc": return renderTerminalStatusesDoc(phase, ctx.preset)
			case "retryStatusDoc": return renderRetryStatusDoc(ctx.preset)
		}
	}
	return resolveBinding(source, ctx)
}

export function renderRuntimeInputsDoc(phase: PresetPhase, ctx: ResolveContext): string {
	const lines: string[] = []
	for (const variable of phase.variables) {
		const doc = variable.doc
		if (doc === null) continue
		const value = resolveBinding(variable.source, ctx)
		if (doc.blankBefore) lines.push("")
		const decoratedValue = `${doc.prefix}${value}`
		const renderedValue = doc.style === "plain" ? decoratedValue : `\`${decoratedValue}\``
		lines.push(`- ${doc.label}: ${renderedValue}${doc.suffix}`)
	}
	return lines.join("\n")
}

export function renderPhaseExitsDoc(phase: PresetPhase): string {
	if (phase.exits.length === 0) return ""
	// #405 ADT: doc renders both branches with stable, distinguishable shapes —
	// item-status branches show the status word the agent must write; chain-action
	// branches show the action verb and route the agent to the dedicated CLI.
	return phase.exits.map((exit) => {
		switch (exit.kind) {
			case "item-status":
				return `- status \`${exit.status}\`: ${exit.when}`
			case "chain-action":
				return `- chain-action \`${exit.action}\`: ${exit.when}`
			default:
				return assertNeverPhaseExit(exit)
		}
	}).join("\n")
}

// #404 doc builders. Each function owns its per-phase visibility slice so
// callers cannot widen the surface by mistake — contract-5 minimum visibility
// (#396 comment 4666115115). A phase whose slice is empty receives an empty
// string; the template author writes the surrounding prose to make sense of
// the empty case (e.g. only review's classification table needs the broader
// vocabulary; other phases bind the placeholder only where they actually use it).

// Per-phase status vocabulary doc. The slice policy:
//   - phases declaring `[[phases.exits]]` (e.g. review): full continuable + terminal
//     vocabulary, so the phase can classify any item it observes in the queue.
//   - trigger phases (e.g. blocked-responder): only the single status that
//     gates the trigger — they never reason about other statuses.
//   - all other phases (e.g. iteration): continuable statuses only — the
//     actionable set the phase legitimately encounters.
// Output is two markdown bullet groups (`actionable` / `non-actionable`) when
// the slice spans both halves; a single bullet when it's one status. Render
// the empty string only when no status falls in the slice.
export function renderStatusVocabularyDoc(phase: PresetPhase, preset: Preset): string {
	const continuable = new Set<string>(preset.statuses.continuable)
	const terminal = new Set<string>(preset.statuses.terminal)
	const slice = statusVocabularySlice(phase, preset)
	if (slice.size === 0) return ""
	const actionable = [...slice].filter((status) => continuable.has(status))
	const nonActionable = [...slice].filter((status) => terminal.has(status))
	const lines: string[] = []
	if (actionable.length > 0) lines.push(`- actionable: ${joinStatusList(actionable)}`)
	if (nonActionable.length > 0) lines.push(`- non-actionable: ${joinStatusList(nonActionable)}`)
	return lines.join("\n")
}

function statusVocabularySlice(phase: PresetPhase, preset: Preset): ReadonlySet<string> {
	if (phase.trigger !== null && !isChainCompleteTrigger(phase.trigger)) {
		return new Set<string>([phase.trigger.whenStatus])
	}
	if (phase.exits.length > 0) {
		return new Set<string>([...preset.statuses.continuable, ...preset.statuses.terminal])
	}
	return new Set<string>(preset.statuses.continuable)
}

function joinStatusList(statuses: readonly string[]): string {
	return statuses.map((status) => `\`${status}\``).join(", ")
}

// Per-phase trigger status doc. Renders the single status string that gates a
// trigger phase (e.g. blocked-responder's `whenStatus`). Non-trigger phases
// render the empty string — their prompts should not bind this key.
export function renderTriggerStatusDoc(phase: PresetPhase): string {
	if (phase.trigger === null) return ""
	if (isChainCompleteTrigger(phase.trigger)) return ""
	return phase.trigger.whenStatus
}

// Per-phase terminal-statuses doc. The slice policy:
//   - phases that classify items (review): full terminal vocabulary.
//   - all other phases: terminal vocabulary they must not write themselves
//     (boundary-statement doc) — useful for iteration's MUST-NOT prose.
// Always renders the full `preset.statuses.terminal` list because there is no
// meaningful narrower slice (a phase's "you must not write these" set is the
// whole terminal set, by definition of terminal). Empty when the preset
// declares no terminal statuses.
export function renderTerminalStatusesDoc(phase: PresetPhase, preset: Preset): string {
	// `phase` is part of the signature for symmetry with the other builders and to
	// keep call-sites uniform; the slice policy is preset-wide today.
	if (preset.statuses.terminal.length === 0) return ""
	void phase
	return joinStatusList(preset.statuses.terminal)
}

// Single retry status doc. Renders `preset.statuses.retry` verbatim (backticks
// added) so md fragments can reference the "previous attempt requires another
// iteration" status without copying the string. A preset that did not declare
// `[statuses].retry` renders the empty string — fragments that bind this key
// require the preset to declare the field.
export function renderRetryStatusDoc(preset: Preset): string {
	const retry = preset.statuses.retry
	if (retry === null) return ""
	return `\`${retry}\``
}

// Run-verdict vocabulary doc was retired alongside #405's SUMMARY-line drop:
// the only consumer (`REVIEW SUMMARY: verdict={{RUN_VERDICT_VOCABULARY_DOC}}`)
// is gone, and the engine-owned `REVIEW_SUMMARY_VERDICTS` constant the builder
// read was deleted by #497. Keeping the builder would leave an engine fact key
// with no data source and no consumer — a contract-5 minimum-surface
// violation symmetric with this PR's earlier `transitionGuidanceDoc` drop.

export function phaseWritableStatuses(phase: PresetPhase): readonly InternalStatus[] {
	// #405 narrow: only item-status branches participate in the per-phase status
	// admission gate (#397). Chain-action branches contribute zero allowed
	// statuses — they are not item-status writes.
	return phase.exits.flatMap((exit) => exit.kind === "item-status" ? [exit.status] : [])
}

export function phaseChainActions(phase: PresetPhase): readonly PresetPhaseChainAction[] {
	// #405 narrow: chain-action branches the agent may select via the dedicated
	// exit-action CLI. Used by the engine to gate `coder-loop item exit-action`
	// against the phase's declared options.
	return phase.exits.flatMap((exit) => exit.kind === "chain-action" ? [exit.action] : [])
}

function assertNeverPhaseExit(value: never): never {
	throw new Error(`unhandled phase-exit kind: ${JSON.stringify(value)}`)
}

// #451 + #405 unified completion-protocol epilogue. Engine-owned, zero business
// literals: references only the engine's own CLI surface (`coder-loop item
// exits` for the query face, `coder-loop item update --status` for item-status
// exits, `coder-loop item exit-action --action` for chain-action exits). The
// same string is appended to every daemon-spawned phase prompt so the agent has
// one uniform protocol for "I am done" — multi-option phases pick one branch,
// single-option phases mark themselves complete by writing the only option.
// Phases that declare no `[[phases.exits]]` still receive the epilogue: the
// query face will truthfully report `<none>` and the write gate rejects all
// writes (default-deny per #397), which is the right teaching for those phases
// too. The chain-action branch is the only controlled channel for stop-chain —
// agent direct `coder-loop chain stop` calls are rejected at the daemon gate
// (#409); the engine maps the selected `chain-action: stop` exit to the same
// code path operator `chain stop` runs (D1: scheduler stops selecting from this
// chain, in-flight runs naturally complete, `chain resume` reversible).
export function phaseExitsEpilogue(): string {
	return [
		"",
		"",
		"## 完成协议（统一）",
		"",
		"无论本 phase 的目标是什么，做完工作后用同一条两步协议收尾：",
		"",
		"1. 查询当前 phase 在元数据中声明的可选下一步出边：",
		"   ```",
		"   coder-loop item exits <CHAIN> --issue <ISSUE> --agent-run-id <RUN_ID> --agent-phase <PHASE> --json",
		"   ```",
		"   返回的 `exits` 列表是本 phase 唯一允许选择的出边集合（per-phase 切片，不暴露其他 phase 出边）。每个 exit 是两种 kind 之一：",
		"   - `kind: \"item-status\"` 带 `status` 字段：表示在本 phase 写回该 item status 即可推进 item 到下一步。",
		"   - `kind: \"chain-action\"` 带 `action` 字段：表示在本 phase 触发一个 chain 级副作用（如 `action: \"stop\"` 停链），不是 item 终态。",
		"",
		"2. 按所选 exit 的 kind 执行对应写入：",
		"   - item-status 分支 → 用 `item update --status`：",
		"     ```",
		"     coder-loop item update <CHAIN> --issue <ISSUE> --status <chosen-status>",
		"     ```",
		"     `agent-run-id` / `agent-phase` 不需要手填——本 phase 进程的 env 已自动携带凭据。写返回集合以外的 status 会被默认拒绝（default-deny）。",
		"   - chain-action 分支 → 用 `item exit-action --action`：",
		"     ```",
		"     coder-loop item exit-action <CHAIN> --issue <ISSUE> --agent-run-id <RUN_ID> --agent-phase <PHASE> --action <chosen-action>",
		"     ```",
		"     选返回集合以外的 action（或绕过此通道直接调 `coder-loop chain stop`）都会被引擎拒绝。",
		"",
		"协议对所有 phase 一致：多选项 phase 选其一表达裁决；单选项 phase 调用即标记完成。不要凭空捏造任何元数据未声明的状态或动作。",
	].join("\n")
}

function lookupItemField(item: ItemRecord, field: string): JsonValue | undefined {
	const [root, ...path] = field.split(".")
	let value = lookupItemRootField(item, root ?? field)
	for (const segment of path) {
		if (!isJsonObject(value)) return undefined
		value = value[segment]
	}
	return value
}

function lookupItemRootField(item: ItemRecord, field: string): JsonValue | undefined {
	switch (field) {
		case "id": return item.id
		case "status": return item.status
		case "agentCwd": return item.agentCwd
		case "runner": return item.runner
		case "phase": return item.phase
		default:
			// #419: every non-engine field is preset-declared (lives in `[item.fields]`) and lands
			// in `extra` at insert / update. No legacy fall-through to physical columns — that
			// escape hatch was the structural defect the issue retired.
			return itemExtraJsonValue(item.extra, field)
	}
}

export function resolveBinding(source: PresetVariableSource, ctx: ResolveContext): string {
	if (source.kind === "item") {
		const value = lookupItemField(ctx.item, source.field)
		return stringifyBindingValue(value, `item.${source.field}`)
	}
	if (source.kind === "chain") {
		const value = ctx.chain[source.field] ?? (source.fallback.kind === "value" ? source.fallback.value : undefined)
		return stringifyBindingValue(value, `chain.${source.field}`)
	}
	assertRuntimeSourceDeclared(source)
	return runtimeBindingValue(ctx.runtime, source.key)
}

function assertRuntimeSourceDeclared(source: Extract<PresetVariableSource, { kind: "runtime" }>): void {
	if (isEngineRuntimeBindingKey(source.key)) return
	if (source.ownership === "preset") return
	throw new Error(`runtime.${source.key}: not an engine runtime fact or preset-declared business key`)
}

function runtimeBindingValue(runtime: RuntimeBindings, key: string): string {
	const value = runtime[key]
	if (value === undefined) throw new Error(`runtime.${key}: missing runtime binding value`)
	return value
}

// Resolve every preset-supplied business key value to its string form. Exposed
// to engine code that builds `RuntimeBindings` so preset-declared business keys
// no longer hit `runtimeBindingValue`'s "missing runtime binding value" throw
// when the preset itself supplied the value (issue #448). The engine remains
// agnostic about the semantics of any individual business key — it just merges
// the resolved map into the runtime record alongside engine facts.
export function resolvePresetBusinessKeyValues(preset: Preset): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, spec] of preset.runtime.businessKeyValues) {
		switch (spec.kind) {
			case "literal":
				out[key] = spec.value
				break
		}
	}
	return out
}

function stringifyBindingValue(value: JsonValue | undefined, label: string): string {
	if (value === null || value === undefined) return ""
	if (typeof value === "string") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	if (typeof value === "boolean") return String(value)
	throw new Error(`${label}: cannot stringify value of type ${typeof value}`)
}

// Render the fragment index for a specific phase (issue #400: minimum-
// visibility slicing). Only fragments whose role appears in `phase.roles`
// reach the agent prompt; cross-role fragments are filtered out. `assertReadable`
// in `loadPreset` still covers the full set — visibility and existence are
// separate concerns.
export function renderFragmentIndex(preset: Preset, phase: Pick<PresetPhase, "roles">): string {
	return sliceFragmentsForPhase(preset.fragments, phase.roles)
		.map((fragment) => `- ${fragment.id} (${fragment.role}): ${fragment.path}`)
		.join("\n")
}

export function sliceFragmentsForPhase(
	fragments: readonly PresetFragment[],
	roles: readonly string[],
): readonly PresetFragment[] {
	if (roles.length === 0) return []
	const allowed = new Set<string>(roles)
	return fragments.filter((fragment) => allowed.has(fragment.role))
}

export function buildCentralRuntimeBindingPaths(input: {
	options: LoopOptions
	chain: Pick<ChainRecord, "name">
	runId: string
	currentIssueFile: string | null
	evidenceDir: string | null
}): RuntimeBindingPaths {
	const rootOptions = loopDataRootOption(input.options.loopDataRoot)
	const chainPaths = resolveChainRuntimePaths(input.chain.name, rootOptions)
	return {
		sharedContextPath: chainPaths.sharedFile,
		currentIssueFile: input.currentIssueFile ?? "",
		issueDir: chainPaths.issuesDir,
		evidenceDir: input.evidenceDir ?? chainPaths.evidenceDir,
		evidenceRootDir: chainPaths.evidenceDir,
		logDir: chainPaths.runsDir,
	}
}

export type ChainRuntimeBinding = {
	name: string
}

export function buildRuntimeBindings(input: {
	options: LoopOptions
	phase: Pick<PresetPhase, "roles">
	runId: string
	currentIssueFile: string | null
	evidenceDir: string | null
	agentCwd: string
	issueRun: IssueRunContext
	paths?: RuntimeBindingPaths
	chain?: ChainRuntimeBinding
	repoCwd?: string
}): RuntimeBindings {
	const paths = input.paths ?? {
		sharedContextPath: input.options.sharedContextPath,
		currentIssueFile: input.currentIssueFile ?? "",
		issueDir: input.options.issueDir,
		evidenceDir: input.evidenceDir ?? input.options.evidenceRootDir,
		evidenceRootDir: input.options.evidenceRootDir,
		logDir: input.options.logDir,
	}
	return {
		// Preset-supplied business key values are merged first so engine facts
		// can never be shadowed by a preset literal (#448 guard: declaration-side
		// `parsePresetRuntimeBusinessKeys` already rejects engine-owned keys, so
		// this ordering is belt-and-suspenders rather than the primary defense).
		...resolvePresetBusinessKeyValues(input.options.preset),
		runId: input.runId,
		targetCwd: input.options.targetCwd,
		agentCwd: input.agentCwd,
		sharedContextPath: paths.sharedContextPath,
		stateFile: "the central state DB",
		currentIssueFile: paths.currentIssueFile,
		issueDir: paths.issueDir,
		evidenceDir: paths.evidenceDir,
		evidenceRootDir: paths.evidenceRootDir,
		logDir: paths.logDir,
		traceFile: `${paths.logDir}/${input.runId}/<phase>/stdout.jsonl`,
		loopFile: "central daemon scheduling state",
		presetDir: input.options.preset.presetDir,
		fragmentIndex: renderFragmentIndex(input.options.preset, input.phase),
		runtimeInputsDoc: "",
		phaseExitsDoc: "",
		// #404: placeholders only — actual values are computed lazily by
		// `resolvePhaseBinding` from `(phase, preset, ctx)`. Mirrors the
		// existing pattern for `runtimeInputsDoc` / `phaseExitsDoc`.
		statusVocabularyDoc: "",
		triggerStatusDoc: "",
		terminalStatusesDoc: "",
		retryStatusDoc: "",
		runIdGeneration: input.issueRun.runIdGeneration,
		resumedFromPhase: input.issueRun.resumedFromPhase ?? "",
		resumedStartedAt: input.issueRun.resumedStartedAt ?? "",
		resumedSessionId: input.issueRun.resumedSessionId ?? "",
		chainName: input.chain?.name ?? "",
		repoCwd: input.repoCwd ?? "",
	}
}

export type RenderBindingsInput = Pick<LoopOptions, "bindings">

export function buildRenderBindings(options: RenderBindingsInput): RenderBindings {
	return { ...options.bindings }
}

async function runAgent(
	options: LoopOptions,
	phase: PresetPhase,
	prompt: string,
	outputPath: string,
	agentCwd: string,
	runner: AgentRunnerSelection,
	watchdog: SummaryWatchdogConfig | null,
	eventContext?: LoopEventContext,
): Promise<{ output: string; stdoutBytes: number; code: number }> {
	const label = phase.name
	const sessionsPath = agentSessionsPath(outputPath)
	const lastEntry = await readLastSessionEntry(sessionsPath)
	const compatibleLastEntry = await selectResumeEntryForRunner(lastEntry, runner, outputPath, label)
	const initialResume = decideResume(compatibleLastEntry)
	if (initialResume.kind === "resume") {
		log(`Agent [${label}] cross-tick resume: sessionId=${initialResume.sessionId} (last terminated=${compatibleLastEntry?.terminated.kind ?? "?"})`)
	}

	const result = await runAgentWithBackoff({
		spawnAttempt: ({ resume }) => {
			const baseInput: SpawnOneAttemptInput = { options, label, prompt, outputPath, sessionsPath, resume, agentCwd, runner, watchdog, authorizationPhase: phase }
			return spawnOneAttempt(eventContext ? { ...baseInput, eventContext } : baseInput)
		},
		sleep: (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
		log,
		now: () => Date.now(),
		initialResume,
	})

	log(`Agent [${label}] finished after ${result.attempts} attempt(s); code=${result.code}`)
	return { output: result.output, stdoutBytes: result.stdoutBytes, code: result.code }
}

async function selectResumeEntryForRunner(
	entry: SessionEntry | null,
	runner: AgentRunnerSelection,
	outputPath: string,
	label: AgentLabel,
): Promise<SessionEntry | null> {
	if (entry === null) return null
	const lastRunner = entry.runner ?? await readAgentStatusRunner(agentStatusPath(outputPath))
	if (lastRunner !== null && lastRunner !== runner.kind) {
		log(`Agent [${label}] not resuming previous ${lastRunner} session with ${runner.kind} runner.`)
		return null
	}
	const lastModel = entry.model ?? await readAgentStatusModel(agentStatusPath(outputPath))
	if (lastModel !== runner.model) {
		log(`Agent [${label}] not resuming previous ${lastModel ?? "<default>"} model session with ${runner.model ?? "<default>"} model.`)
		return null
	}
	return entry
}

async function readAgentStatusRunner(statusPath: string): Promise<AgentRunnerKind | null> {
	const phaseStatus = await readAgentPhaseStatus(statusPath)
	return phaseStatus.value?.runner ?? null
}

async function readAgentStatusModel(statusPath: string): Promise<string | null> {
	const phaseStatus = await readAgentPhaseStatus(statusPath)
	return phaseStatus.value?.model ?? null
}

export type SpawnOneAttemptInput = {
	options: LoopOptions
	label: AgentLabel
	prompt: string
	outputPath: string
	sessionsPath: string
	resume: ResumeDecision
	agentCwd: string
	runner?: AgentRunnerSelection
	watchdog: SummaryWatchdogConfig | null
	attemptTimeout?: AttemptTimeoutConfig | null
	eventContext?: LoopEventContext
	statusWriter?: (path: string, payload: string) => Promise<void>
	authorizationPhase?: Pick<PresetPhase, "variables">
}

export type SummaryWatchdogConfig = {
	marker: string
	termMs: number
	killMs: number
}

export type AttemptTimeoutConfig = {
	termMs: number
	killMs: number
	attemptSeconds: number
}

export function attemptTimeoutConfigForPreset(preset: Preset): AttemptTimeoutConfig {
	return {
		termMs: preset.agent.attemptTimeoutSeconds * 1000,
		killMs: ATTEMPT_TIMEOUT_KILL_MS,
		attemptSeconds: preset.agent.attemptTimeoutSeconds,
	}
}

// #456: `PresetPhase.summaryMarker` is retired with the role taxonomy. The watchdog hook is
// preserved as a no-op call site (`#452` boundary owns the redesign of summary injection); every
// caller still passes a phase but the function now reports "no marker configured" unconditionally
// until #452 lands a DSL-declared injection point. Signature kept so callers don't churn.
export function summaryWatchdogConfigForPhase(_phase: PresetPhase): SummaryWatchdogConfig | null {
	return null
}

export type SummaryWatchdogTimerHandle = ReturnType<typeof setTimeout> | null

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

type SummaryWatchdogStdoutObserver = {
	observeStdout: (chunk: Buffer) => void
	finish: () => void
	error: () => SummaryWatchdogFrameError | null
}

export type SummaryWatchdogFrameError = {
	kind: "invalid-runner-event"
	runner: "codex"
	frameChars: number
	message: string
}

function createDisabledSummaryWatchdog(): SummaryWatchdog {
	let state: SummaryWatchdogState = { kind: "idle" }
	return {
		observeStdout: () => {},
		cancel: () => {
			state = { kind: "cancelled" }
		},
		state: () => state,
	}
}

function isObjectRecord(value: BoundaryValue): value is BoundaryRecord {
	return typeof value === "object" && value !== null
}

function codexAgentMessageText(event: BoundaryValue): string | null {
	if (!isObjectRecord(event)) return null
	if (event.type === "agent_message" && typeof event.text === "string") return event.text
	if (event.type !== "item.completed" || !isObjectRecord(event.item)) return null
	return event.item.type === "agent_message" && typeof event.item.text === "string" ? event.item.text : null
}

function claudeAgentMessageText(event: BoundaryValue): string | null {
	if (!isObjectRecord(event) || event.type !== "assistant" || !isObjectRecord(event.message)) return null
	const content = event.message.content
	if (!Array.isArray(content)) return null
	const textParts = content.flatMap((part): string[] => {
		if (!isObjectRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
		return [part.text]
	})
	return textParts.length === 0 ? null : textParts.join("\n")
}

function containsSummaryMarkerLine(text: string, marker: string): boolean {
	return text.split(/\r?\n/).some((line) => line.trimStart().startsWith(marker))
}

export function codexSummaryTextFromJsonLine(line: string, marker: string): string | null {
	const trimmed = line.trim()
	if (trimmed === "") return null
	try {
		const text = codexAgentMessageText(JSON.parse(trimmed))
		if (text === null || !containsSummaryMarkerLine(text, marker)) return null
		return text
	} catch {
		return null
	}
}

function finalSummaryLine(text: string, marker: string): string | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
	const lastLine = lines.at(-1)
	return lastLine?.startsWith(marker) ? lastLine : null
}

// #405 retired: the regex-escape helper and the per-text/per-stream stdout
// flow-word parsers were deleted together — they only existed to assemble the
// regex that captured the five-word stdout vocabulary. `finalSummaryLine` and
// `runnerAgentTextFromJsonLine` are still used by the chain-complete finalizer
// (`parseFinalizerSummaryDecision`) — out of scope for this issue.

function runnerAgentTextFromJsonLine(line: string, runner: AgentRunnerKind): { parsedRunnerEvent: boolean; text: string | null } {
	const trimmed = line.trim()
	if (trimmed === "" || !trimmed.startsWith("{")) return { parsedRunnerEvent: false, text: null }
	try {
		const event: BoundaryValue = JSON.parse(trimmed)
		if (!isObjectRecord(event) || typeof event.type !== "string") return { parsedRunnerEvent: false, text: null }
		const text = runner === "codex" ? codexAgentMessageText(event) : claudeAgentMessageText(event)
		return { parsedRunnerEvent: true, text }
	} catch {
		return { parsedRunnerEvent: false, text: null }
	}
}

// #405 retired: the public stdout-flow parser deleted along with the rest of
// the family. The exported surface — including the function the daemon test
// fixtures used to reconstruct fake-runner status writes — is gone; tests now
// route through `extra.writeStatus` directly (mirror of the real agent calling
// `coder-loop item update --status`).

export function createSummaryWatchdogStdoutObserver(runner: AgentRunnerKind, marker: string, watchdog: SummaryWatchdog): SummaryWatchdogStdoutObserver {
	if (runner !== "codex") {
		return {
			observeStdout: (chunk) => watchdog.observeStdout(chunk.toString("utf8")),
			finish: () => {},
			error: () => null,
		}
	}

	let frameError: SummaryWatchdogFrameError | null = null
	const stream = createStreamTextState((line) => {
		if (frameError !== null) return
		const trimmed = line.trim()
		if (trimmed === "" || !trimmed.startsWith("{")) return
		try {
			const text = codexAgentMessageText(JSON.parse(trimmed))
			if (text !== null && containsSummaryMarkerLine(text, marker)) watchdog.observeStdout(text)
		} catch (error) {
			frameError = {
				kind: "invalid-runner-event",
				runner: "codex",
				frameChars: line.length,
				message: `invalid codex JSONL runner event (${line.length} chars): ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	})
	return {
		observeStdout: stream.observe,
		finish: stream.finish,
		error: () => frameError,
	}
}

export function createSummaryWatchdog(deps: SummaryWatchdogDeps): SummaryWatchdog {
	let state: SummaryWatchdogState = { kind: "idle" }
	let tail = ""
	let termTimer: SummaryWatchdogTimerHandle = null
	let killTimer: SummaryWatchdogTimerHandle = null
	const tailLimit = Math.max(deps.config.marker.length - 1, 0)

	const arm = (): void => {
		if (state.kind !== "idle") return
		if (!Number.isFinite(deps.config.termMs) || deps.config.termMs <= 0) return
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
	const selectedRunner = input.runner ?? options.defaultRunner
	await mkdir(dirname(outputPath), { recursive: true })
	const loopDataRoot = resolveLoopDataPaths(loopDataRootOption(options.loopDataRoot)).root
	const runnerPlan = buildRunnerInvocation(selectedRunner, effectivePrompt, resume, buildRunnerFilesystemAuthorization({
		agentCwd: input.agentCwd,
		presetDir: options.preset.presetDir,
		loopDataRoot,
		sharedContextPath: options.sharedContextPath,
		currentIssueFile: "",
		issueDir: options.issueDir,
		evidenceDir: options.evidenceRootDir,
		evidenceRootDir: options.evidenceRootDir,
		logDir: options.logDir,
		daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
		declaredRuntimeBindingPaths: phaseDeclaredRuntimeBindingPaths(input.authorizationPhase ?? { variables: [] }),
	}))
	for (const directory of runnerPlan.runtimeDirectories) await mkdir(directory, { recursive: true })
	await writeFile(resolve(dirname(outputPath), "runner-authorization.json"), `${JSON.stringify(runnerPlan.authorizationEvidence)}\n`)
	return new Promise((resolveResult, rejectResult) => {
		let settled = false
		let streamedSessionId: string | null = null
		let streamedErrorCode: string | null = null
		let streamedStderrErrorCode: string | null = null
		let latestAgentText: string | null = null
		let lastPlainStdoutLine: string | null = null
		let sawRunnerJson = false
		const stdoutState = createStreamTextState((line) => {
			if (streamedSessionId === null) streamedSessionId = parseSessionIdFromRunnerStream(selectedRunner.kind, `${line}\n`)
			const parsed = runnerAgentTextFromJsonLine(line, selectedRunner.kind)
			sawRunnerJson = sawRunnerJson || parsed.parsedRunnerEvent
			if (parsed.text !== null) latestAgentText = parsed.text
			if (line.trim() !== "") lastPlainStdoutLine = line
			const code = extractErrorCode(line, "")
			if (code !== "unclassified") streamedErrorCode = code
		})
		const stderrState = createStreamTextState((line) => {
			const code = extractErrorCode("", line)
			if (code !== "unclassified") streamedStderrErrorCode = code
		})

		const startedAt = new Date().toISOString()
		const attemptStreamPath = agentAttemptStreamPath(outputPath, startedAt)
		const attemptStderrPath = agentAttemptStderrPath(outputPath, startedAt)
		const statusPath = agentStatusPath(outputPath)
		const streamOutFile = createWriteStream(attemptStreamPath, { flags: "w" })
		const stderrOutFile = createWriteStream(attemptStderrPath, { flags: "w" })
		const status: AgentRunStatus = {
			label,
			runner: selectedRunner.kind,
			model: selectedRunner.model,
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
		let statusWriteChain = Promise.resolve()
		let statusPersistenceFailure: RunnerStatusPersistenceError | null = null
		const writeStatus = (): Promise<void> => {
			const payload = `${JSON.stringify(status, null, "\t")}\n`
			statusWriteChain = statusWriteChain.then(async () => {
				if (statusPersistenceFailure !== null) throw statusPersistenceFailure
				try {
					await (input.statusWriter ?? writeFile)(statusPath, payload)
				} catch (error) {
					const failure: RunnerStatusPersistenceFailure = {
						path: "chain-complete",
						stage: "status-artifact",
						runId: basename(dirname(dirname(outputPath))),
						phase: String(label),
						persistencePath: statusPath,
						error: error instanceof Error ? error.message : String(error),
					}
					statusPersistenceFailure = new RunnerStatusPersistenceError(failure)
					options.onStatusPersistenceFailure?.(failure)
					throw statusPersistenceFailure
				}
			})
			return statusWriteChain
		}
		const watchdogConfig = input.watchdog
		const attemptTimeoutConfig = input.attemptTimeout ?? attemptTimeoutConfigForPreset(options.preset)
		const child = spawn(runnerPlan.binary, runnerPlan.args, {
			cwd: input.agentCwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: { ...process.env, ...runnerPlan.environment },
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

		type AttemptTimeoutState = "idle" | "term-sent" | "kill-sent" | "cancelled"
		let attemptTimeoutState: AttemptTimeoutState = "idle"
		let attemptTermTimer: ReturnType<typeof setTimeout> | null = null
		let attemptKillTimer: ReturnType<typeof setTimeout> | null = null

		const clearAttemptTimeoutTimers = (): void => {
			if (attemptTermTimer !== null) {
				clearTimeout(attemptTermTimer)
				attemptTermTimer = null
			}
			if (attemptKillTimer !== null) {
				clearTimeout(attemptKillTimer)
				attemptKillTimer = null
			}
		}

		const cancelAttemptTimeout = (): void => {
			clearAttemptTimeoutTimers()
			if (attemptTimeoutState === "idle") attemptTimeoutState = "cancelled"
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

		const emitAttemptTimeoutFire = (sig: "SIGTERM" | "SIGKILL"): void => {
			const ec = input.eventContext
			if (!ec) return
			void ec.emit({
				type: "attempt.timeout",
				ts: new Date().toISOString(),
				runId: ec.runId,
				issueId: ec.issueId,
				pr: ec.pr,
				branch: ec.branch,
				phase: ec.phase,
				attemptStartedAt: startedAt,
				signal: sig,
				attemptSeconds: attemptTimeoutConfig.attemptSeconds,
			})
		}

		let watchdog: SummaryWatchdog
		const armAttemptTimeout = (): void => {
			attemptTermTimer = setTimeout(() => {
				attemptTermTimer = null
				if (settled || attemptTimeoutState !== "idle") return
				if (watchdog.state().kind !== "idle") {
					attemptTimeoutState = "cancelled"
					return
				}
				attemptTimeoutState = "term-sent"
				log(`Agent [${label}] absolute attempt timeout after ${attemptTimeoutConfig.attemptSeconds}s before summary; sending SIGTERM (pid=${child.pid ?? "?"})`)
				emitAttemptTimeoutFire("SIGTERM")
				sendSignalToGroup("SIGTERM")
				attemptKillTimer = setTimeout(() => {
					attemptKillTimer = null
					if (settled || attemptTimeoutState !== "term-sent") return
					attemptTimeoutState = "kill-sent"
					log(`Agent [${label}] absolute attempt timeout SIGTERM+${Math.round(attemptTimeoutConfig.killMs / 1000)}s elapsed; sending SIGKILL (pid=${child.pid ?? "?"})`)
					emitAttemptTimeoutFire("SIGKILL")
					sendSignalToGroup("SIGKILL")
				}, attemptTimeoutConfig.killMs)
			}, attemptTimeoutConfig.termMs)
		}

		watchdog = watchdogConfig === null
			? createDisabledSummaryWatchdog()
			: createSummaryWatchdog({
					config: watchdogConfig,
					setTimer: (cb, ms) => setTimeout(cb, ms),
					clearTimer: (handle) => {
						if (handle !== null) clearTimeout(handle)
					},
					onTerm: () => {
						log(`Agent [${label}] forced-terminate after "${watchdogConfig.marker}" + ${Math.round(watchdogConfig.termMs / 1000)}s; sending SIGTERM (pid=${child.pid ?? "?"})`)
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
		const watchdogStdout = watchdogConfig === null
			? { observeStdout: (_chunk: Buffer) => {}, finish: () => {}, error: () => null }
			: createSummaryWatchdogStdoutObserver(selectedRunner.kind, watchdogConfig.marker, watchdog)
		armAttemptTimeout()

		const recordChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
			status.lastStream = stream
			status.lastEventAt = new Date().toISOString()
			status.bytesWritten += chunk.byteLength
			if (stream === "stdout") {
				stdoutState.observe(chunk)
				if (!streamOutFile.write(chunk)) {
					child.stdout.pause()
					streamOutFile.once("drain", () => child.stdout.resume())
				}
				status.sessionId = streamedSessionId
				const watchdogStateBefore = watchdog.state().kind
				watchdogStdout.observeStdout(chunk)
				if (watchdogStateBefore === "idle" && watchdog.state().kind !== "idle") {
					cancelAttemptTimeout()
				}
			} else {
				stderrState.observe(chunk)
				if (!stderrOutFile.write(chunk)) {
					child.stderr.pause()
					stderrOutFile.once("drain", () => child.stderr.resume())
				}
			}
			void writeStatus().catch(() => undefined)
		}

		status.pid = child.pid ?? null
		void writeStatus().catch(() => undefined)

		log(`Agent [${label}] spawned: runner=${selectedRunner.kind}, model=${selectedRunner.model ?? "<default>"}, pid=${child.pid}, stream=${attemptStreamPath}, stderr=${attemptStderrPath}, status=${statusPath}, resume=${resume.kind === "resume" ? resume.sessionId : "none"}, attemptTimeout=${attemptTimeoutConfig.attemptSeconds}s`)

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
				runner: selectedRunner.kind,
				model: selectedRunner.model,
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
				stdoutBytes: stdoutState.bytes(),
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
			cancelAttemptTimeout()
			status.error = error.message
			status.lastEventAt = new Date().toISOString()
			status.exitCode = 1
			status.terminated = { kind: "error", code: "spawn_error" }
			void (async () => {
				await writeStatus()
				log(`Agent [${label}] spawn error: ${error.message}`)
				await Promise.all([closeAgentOutputStream(streamOutFile), closeAgentOutputStream(stderrOutFile, `\nspawn error: ${error.message}\n`)])
				await settle({ kind: "error", code: "spawn_error" }, `spawn error: ${error.message}`, 1, null)
			})().catch(rejectResult)
		})

		child.on("close", (code, signal) => {
			if (settled) return
			settled = true
			const watchdogStateAtClose = watchdog.state()
			const attemptTimeoutStateAtClose = attemptTimeoutState
			watchdog.cancel()
			cancelAttemptTimeout()
			stdoutState.finish()
			stderrState.finish()
			watchdogStdout.finish()
			status.sessionId = streamedSessionId
			const summaryFrameError = watchdogStdout.error()
			if (summaryFrameError !== null) {
				status.error = summaryFrameError.message
				log(`Agent [${label}] summary frame error: ${summaryFrameError.message}`)
			}
			const exitCode = summaryFrameError === null ? code ?? 1 : 1
			const signalName = signal ?? null
			const terminated: Terminated =
				attemptTimeoutStateAtClose === "term-sent" || attemptTimeoutStateAtClose === "kill-sent"
					? {
							kind: "timeout",
							phase: attemptTimeoutStateAtClose === "kill-sent" ? "kill" : "term",
							attemptSeconds: attemptTimeoutConfig.attemptSeconds,
						}
					: watchdogConfig !== null && (watchdogStateAtClose.kind === "term-sent" || watchdogStateAtClose.kind === "kill-sent")
					? {
							kind: "watchdog",
							phase: watchdogStateAtClose.kind === "kill-sent" ? "kill" : "term",
							afterSummarySeconds: Math.round(watchdogConfig.termMs / 1000),
						}
					: summaryFrameError !== null
						? { kind: "error", code: "invalid_summary_runner_event" }
					: signalName !== null
						? { kind: "signal", name: signalName }
						: exitCode === 0
							? { kind: "clean" }
							: { kind: "error", code: streamedErrorCode ?? streamedStderrErrorCode ?? "unclassified" }
			status.exitCode = exitCode
			status.signal = signalName
			status.terminated = terminated
			status.lastEventAt = new Date().toISOString()
			const terminatedDetail =
				terminated.kind === "error"
					? `(${terminated.code})`
					: terminated.kind === "signal"
						? `(${terminated.name})`
						: terminated.kind === "watchdog"
							? `(forced-terminate after declared phase summary marker + ${terminated.afterSummarySeconds}s, phase=${terminated.phase})`
							: terminated.kind === "timeout"
								? `(absolute attempt timeout after ${terminated.attemptSeconds}s, phase=${terminated.phase})`
							: ""
			void (async () => {
				await writeStatus()
				if (signal) log(`Agent [${label}] killed by signal ${signal}`)
				await Promise.all([closeAgentOutputStream(streamOutFile), closeAgentOutputStream(stderrOutFile)])
				log(`Agent [${label}] attempt closed: exit=${exitCode}, signal=${signalName ?? "none"}, terminated=${terminated.kind}${terminatedDetail}, sessionId=${status.sessionId ?? "<none>"}`)
				const finalizerOutput = sawRunnerJson ? latestAgentText ?? "" : lastPlainStdoutLine ?? ""
				await settle(terminated, finalizerOutput, exitCode, signalName)
			})().catch(rejectResult)
		})
	})
}

async function closeAgentOutputStream(stream: WriteStream, finalChunk?: string): Promise<void> {
	await new Promise<void>((resolveClosed, rejectClosed) => {
		stream.once("error", rejectClosed)
		stream.end(finalChunk, () => resolveClosed())
	})
}

function stripModelArgs(extraArgs: readonly string[], flags: readonly string[]): string[] {
	const stripped: string[] = []
	for (let i = 0; i < extraArgs.length; i++) {
		const arg = extraArgs[i]!
		if (flags.includes(arg)) {
			i++
			continue
		}
		if (flags.some((flag) => arg.startsWith(`${flag}=`))) continue
		stripped.push(arg)
	}
	return stripped
}

export function agentClaudeArgs(extraArgs: readonly string[], prompt: string, resume: ResumeDecision, additionalDirs: readonly string[], model: string | null = null): string[] {
	const args = model === null ? [...extraArgs] : stripModelArgs(extraArgs, ["--model"])
	if (model !== null) args.push("--model", model)
	if (!args.includes("--output-format")) args.push("--output-format", "stream-json")
	if (!args.includes("--verbose")) args.push("--verbose")
	if (additionalDirs.length > 0 && !args.includes("--add-dir")) {
		args.push("--add-dir", ...additionalDirs)
	}
	if (resume.kind === "resume") args.push("--resume", resume.sessionId)
	args.push("-p", prompt)
	return args
}

export type RunnerInvocation =
	| { kind: "spawn"; binary: string; args: string[]; environment: Readonly<Record<string, string>>; runtimeDirectories: readonly string[]; authorizationEvidence: RunnerAuthorizationEvidence }

// #505: the loop-process-side git worktree helpers (worktreeBasePath /
// worktreePathForItem / ensureWorktreeForItem / removeWorktreeForItem /
// cleanupStaleWorktrees / validateWorktreePrerequisites) have been retired
// along with their internal helpers (gitExec / gitWorktreeListIncludesPath /
// realpathForComparison). They were exported but had zero callers anywhere
// in the tree — every live worktree path now flows through the central
// daemon's `<loopDataRoot>/chains/<name>/worktrees/` namespace, owned by
// `src/scheduler.ts`. Removing the dead block also retires the engine's
// previous engine-owned worktree namespace literal (sibling-of-target dot
// directory), which was the last remaining target-relative reference here.

// --- runner invocation ---

export type RunnerFilesystemSurface =
	| { kind: "task-private-directory"; channel: "agent-cwd" | "runner-scratch"; path: string }
	| { kind: "cwd-ancestor-directory"; channel: "agent-cwd-discovery"; access: "entries" | "metadata"; path: string }
	| { kind: "read-only-directory"; channel: "preset"; path: string }
	| { kind: "read-only-file"; channel: "runner-executable"; runner: AgentRunnerKind; path: string }
	| { kind: "writable-directory"; channel: "evidence" | "evidence-root" | "issues" | "logs" | "git-worktree-metadata" | "git-common-dir"; path: string }
	| { kind: "writable-file"; channel: "shared-context" | "current-issue" | "daemon-socket"; path: string }
	| { kind: "system-device"; channel: "null"; path: "/dev/null" }
	| { kind: "runner-runtime-directory"; runner: "claude"; channel: "projects" | "session-env"; path: string }
	| { kind: "runner-runtime-directory"; runner: "codex"; channel: "sessions" | "shell-snapshots" | "tmp" | "log" | "cache"; path: string }
	| { kind: "runner-runtime-directory"; runner: "opencode"; channel: "data" | "state"; path: string }
	| { kind: "runner-runtime-file"; runner: "codex"; channel: "installation-id" | "models-cache" | "state-db" | "state-db-shm" | "state-db-wal" | "logs-db" | "logs-db-shm" | "logs-db-wal" | "goals-db" | "goals-db-shm" | "goals-db-wal" | "memories-db" | "memories-db-shm" | "memories-db-wal"; path: string }

export type RunnerFilesystemAuthorization = {
	agentCwd: string
	loopDataRoot: string
	surfaces: readonly RunnerFilesystemSurface[]
}

export type RunnerAuthorizationEvidence = {
	schemaVersion: 1
	runner: AgentRunnerKind
	outerSandboxBinary: "/usr/bin/sandbox-exec"
	outerSandboxProfile: string
	surfaces: readonly RunnerFilesystemSurface[]
}

export type BuildRunnerFilesystemAuthorizationInput = RuntimeBindingPaths & {
	agentCwd: string
	presetDir: string
	loopDataRoot: string
	daemonSocketPath: string
	declaredRuntimeBindingPaths: readonly RuntimeBindingPathKey[]
}

export function buildRunnerFilesystemAuthorization(input: BuildRunnerFilesystemAuthorizationInput): RunnerFilesystemAuthorization {
	const runnerScratch = resolve(input.agentCwd, ".coder-loop-runner", "tmp")
	const declares = (key: RuntimeBindingPathKey): boolean => input.declaredRuntimeBindingPaths.includes(key)
	const surfaces: RunnerFilesystemSurface[] = [
		{ kind: "task-private-directory", channel: "agent-cwd", path: input.agentCwd },
		{ kind: "task-private-directory", channel: "runner-scratch", path: runnerScratch },
		...runnerCwdDiscoverySurfaces(input.loopDataRoot, input.agentCwd),
		...runnerGitMetadataSurfaces(input.agentCwd),
		{ kind: "read-only-directory", channel: "preset", path: input.presetDir },
		{ kind: "writable-file", channel: "daemon-socket", path: input.daemonSocketPath },
		{ kind: "system-device", channel: "null", path: "/dev/null" },
	]
	if (declares("evidenceDir")) surfaces.push({ kind: "writable-directory", channel: "evidence", path: input.evidenceDir })
	if (declares("evidenceRootDir")) surfaces.push({ kind: "writable-directory", channel: "evidence-root", path: input.evidenceRootDir })
	if (declares("issueDir")) surfaces.push({ kind: "writable-directory", channel: "issues", path: input.issueDir })
	if (declares("logDir")) surfaces.push({ kind: "writable-directory", channel: "logs", path: input.logDir })
	if (declares("sharedContextPath")) surfaces.push({ kind: "writable-file", channel: "shared-context", path: input.sharedContextPath })
	if (declares("currentIssueFile") && input.currentIssueFile !== "") surfaces.push({ kind: "writable-file", channel: "current-issue", path: input.currentIssueFile })
	for (const surface of surfaces) {
		if (samePath(surface.path, input.loopDataRoot)) throw new Error(`declared runner surface ${surface.channel} may not grant the loop-data root`)
	}
	const presetSurface = surfaces.find((surface) => surface.kind === "read-only-directory")
	if (presetSurface === undefined) throw new Error("declared runner surfaces require a read-only preset")
	return { agentCwd: input.agentCwd, loopDataRoot: input.loopDataRoot, surfaces }
}

function runnerCwdDiscoverySurfaces(loopDataRoot: string, agentCwd: string): RunnerFilesystemSurface[] {
	const root = resolve(loopDataRoot)
	const cwd = resolve(agentCwd)
	const relativeCwd = relative(root, cwd)
	if (relativeCwd === "" || relativeCwd === ".." || relativeCwd.startsWith(`..${pathSeparator}`) || isAbsolute(relativeCwd)) return []
	const segments = relativeCwd.split(pathSeparator)
	const ancestors = segments.slice(0, -1).map((_, index) => resolve(root, ...segments.slice(0, index + 1)))
	return ancestors.map((path, index) => ({
		kind: "cwd-ancestor-directory",
		channel: "agent-cwd-discovery",
		access: index < ancestors.length - 1 ? "entries" : "metadata",
		path,
	}))
}

function runnerGitMetadataSurfaces(agentCwd: string): RunnerFilesystemSurface[] {
	const dotGit = resolve(agentCwd, ".git")
	try {
		if (statSync(dotGit).isDirectory()) {
			return [{ kind: "writable-directory", channel: "git-common-dir", path: dotGit }]
		}
		const marker = readFileSync(dotGit, "utf-8").trim()
		if (!marker.startsWith("gitdir:")) return []
		const rawGitDir = marker.slice("gitdir:".length).trim()
		const gitDir = isAbsolute(rawGitDir) ? resolve(rawGitDir) : resolve(agentCwd, rawGitDir)
		let commonDir = gitDir
		try {
			const rawCommonDir = readFileSync(resolve(gitDir, "commondir"), "utf-8").trim()
			if (rawCommonDir !== "") commonDir = isAbsolute(rawCommonDir) ? resolve(rawCommonDir) : resolve(gitDir, rawCommonDir)
		} catch {
			// A standalone .git file has no separate common directory.
		}
		const result: RunnerFilesystemSurface[] = [{ kind: "writable-directory", channel: "git-worktree-metadata", path: gitDir }]
		if (!samePath(commonDir, gitDir)) result.push({ kind: "writable-directory", channel: "git-common-dir", path: commonDir })
		return result
	} catch {
		return []
	}
}

export function buildRunnerInvocation(runner: AgentRunnerSelection, prompt: string, resume: ResumeDecision, authorization: RunnerFilesystemAuthorization): RunnerInvocation {
	assertRunnerAuthorizationMetadata(runner)
	const runnerExecutable = isAbsolute(runner.binary) ? runner.binary : Bun.which(runner.binary) ?? runner.binary
	const effectiveAuthorization: RunnerFilesystemAuthorization = {
		...authorization,
		surfaces: [...authorization.surfaces, { kind: "read-only-file", channel: "runner-executable", runner: runner.kind, path: runnerExecutable }],
	}
	const runnerScratch = effectiveAuthorization.surfaces.find((surface) => surface.kind === "task-private-directory" && surface.channel === "runner-scratch")
	if (runnerScratch === undefined) throw new Error("declared runner surfaces require task-private runner scratch")
	const writableDirs = effectiveAuthorization.surfaces.flatMap((surface) => surface.kind === "task-private-directory" || surface.kind === "writable-directory" ? [surface.path] : [])
	const claudeDirs = effectiveAuthorization.surfaces.flatMap((surface) => surface.kind === "task-private-directory" || surface.kind === "read-only-directory" || surface.kind === "writable-directory" ? [surface.path] : [])
	const nativeArgs = runner.kind === "claude"
		? agentClaudeArgs(runner.extraArgs, prompt, resume, claudeDirs, runner.model)
		: runner.kind === "opencode"
			? agentOpencodeArgs(runner.extraArgs, prompt, resume, runner.model, authorization.agentCwd)
			: agentCodexArgs(runner.extraArgs, prompt, resume, authorization.agentCwd, runner.model, writableDirs)
	const environment = runnerEnvironment(runner.kind, runnerScratch.path)
	const outerSandboxProfile = runnerSandboxProfile(effectiveAuthorization, runner.kind)
	return {
		kind: "spawn",
		binary: "/usr/bin/sandbox-exec",
		args: ["-p", outerSandboxProfile, runner.binary, ...nativeArgs],
		environment,
		runtimeDirectories: [runnerScratch.path],
		authorizationEvidence: {
			schemaVersion: 1,
			runner: runner.kind,
			outerSandboxBinary: "/usr/bin/sandbox-exec",
			outerSandboxProfile,
			surfaces: effectiveAuthorization.surfaces,
		},
	}
}

function runnerEnvironment(runner: AgentRunnerKind, scratchPath: string): Readonly<Record<string, string>> {
	const common = { TMPDIR: scratchPath, TMP: scratchPath, TEMP: scratchPath }
	if (runner === "claude") return { ...common, CLAUDE_CODE_TMPDIR: scratchPath }
	return common
}

const RUNNER_AUTHORIZATION_OPTIONS = ["--add-dir", "--sandbox", "-s", "--cd", "-C", "--dir", "--permission-mode", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox"]

function assertRunnerAuthorizationMetadata(runner: AgentRunnerSelection): void {
	for (const arg of runner.extraArgs) {
		if (RUNNER_AUTHORIZATION_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`) || (option.length === 2 && arg.startsWith(option)))) {
			throw new Error(`runner authorization metadata may not supply ${arg}`)
		}
	}
}

function sandboxLiteral(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function runnerSandboxProfile(authorization: RunnerFilesystemAuthorization, runner: AgentRunnerKind): string {
	const surfaces = [...authorization.surfaces, ...runnerRuntimeSurfaces(runner)]
	const cwdAncestorMetadata = surfaces.flatMap((surface) => surface.kind === "cwd-ancestor-directory"
		? sandboxPathSpellings(surface.path).map((spelling) => `(literal ${sandboxLiteral(spelling)})`)
		: [])
	const cwdAncestorMetadataRule = cwdAncestorMetadata.length === 0 ? "" : `(allow file-read-metadata ${cwdAncestorMetadata.join(" ")}) `
	const cwdAncestorEntries = surfaces.flatMap((surface) => surface.kind === "cwd-ancestor-directory" && surface.access === "entries"
		? sandboxPathSpellings(surface.path).map((spelling) => `(literal ${sandboxLiteral(spelling)})`)
		: [])
	const cwdAncestorEntriesRule = cwdAncestorEntries.length === 0 ? "" : `(allow file-read-data ${cwdAncestorEntries.join(" ")}) `
	const readable = distinctPaths(surfaces.flatMap((surface) => {
		if (surface.kind === "cwd-ancestor-directory") return []
		const exactSocket = surface.kind === "writable-file" && surface.channel === "daemon-socket"
		if (exactSocket) return sandboxPathSpellings(surface.path).flatMap((path) => [`(literal ${sandboxLiteral(dirname(path))})`, `(subpath ${sandboxLiteral(path)})`])
		const predicate = exactSocket || (surface.kind !== "writable-file" && surface.kind !== "runner-runtime-file" && surface.kind !== "read-only-file" && surface.kind !== "system-device") ? "subpath" : "literal"
		return sandboxPathSpellings(surface.path).map((path) => `(${predicate} ${sandboxLiteral(path)})`)
	}))
	const writableDevices = distinctPaths(surfaces.flatMap((surface) => surface.kind === "system-device" ? [surface.path] : []))
	const preset = authorization.surfaces.find((surface) => surface.kind === "read-only-directory")
	if (preset === undefined) throw new Error("declared runner surfaces require a read-only preset")
	const presetTrees = distinctPaths(sandboxPathSpellings(preset.path))
	const denyPreset = presetTrees.map((path) => `(require-not (subpath ${sandboxLiteral(path)}))`).join(" ")
	const writableRules = distinctPaths(surfaces.flatMap((surface) => {
		if (surface.kind === "cwd-ancestor-directory" || surface.kind === "read-only-directory" || surface.kind === "read-only-file" || surface.kind === "system-device") return []
		const exactSocket = surface.kind === "writable-file" && surface.channel === "daemon-socket"
		const predicate = (surface.kind === "writable-file" && !exactSocket) || surface.kind === "runner-runtime-file" ? "literal" : "subpath"
		return sandboxPathSpellings(surface.path).map((path) => `(${predicate} ${sandboxLiteral(path)})`)
	}))
	const writeRules = writableRules.map((rule) => `(require-all ${rule} ${denyPreset})`).join(" ")
	const deviceWriteRules = writableDevices.map((path) => `(literal ${sandboxLiteral(path)})`).join(" ")
	const runnerRuntimeCapabilities = runner === "codex" ? "(allow system-socket) " : ""
	const outsideLoopData = sandboxPathSpellings(authorization.loopDataRoot).map((path) => `(require-not (subpath ${sandboxLiteral(path)}))`).join(" ")
	return `(version 1) (deny default) (allow process*) (allow signal) (allow network*) (allow sysctl-read) (allow mach-lookup) (allow ipc-posix*) ${runnerRuntimeCapabilities}${cwdAncestorMetadataRule}${cwdAncestorEntriesRule}(allow file-read* (require-all ${outsideLoopData})) (allow file-read* ${readable.join(" ")}) (allow file-write* ${writeRules} ${deviceWriteRules})`
}

function runnerRuntimeSurfaces(runner: AgentRunnerKind): RunnerFilesystemSurface[] {
	if (runner === "claude") {
		return [
			{ kind: "runner-runtime-directory", runner: "claude", channel: "projects", path: resolve(homedir(), ".claude/projects") },
			{ kind: "runner-runtime-directory", runner: "claude", channel: "session-env", path: resolve(homedir(), ".claude/session-env") },
		]
	}
	if (runner === "codex") {
		const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex")
		return [
			{ kind: "runner-runtime-file", runner: "codex", channel: "installation-id", path: resolve(codexHome, "installation_id") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "models-cache", path: resolve(codexHome, "models_cache.json") },
			{ kind: "runner-runtime-directory", runner: "codex", channel: "cache", path: resolve(codexHome, "cache") },
			{ kind: "runner-runtime-directory", runner: "codex", channel: "sessions", path: resolve(codexHome, "sessions") },
			{ kind: "runner-runtime-directory", runner: "codex", channel: "shell-snapshots", path: resolve(codexHome, "shell_snapshots") },
			{ kind: "runner-runtime-directory", runner: "codex", channel: "tmp", path: resolve(codexHome, "tmp") },
			{ kind: "runner-runtime-directory", runner: "codex", channel: "log", path: resolve(codexHome, "log") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "state-db", path: resolve(codexHome, "state_5.sqlite") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "state-db-shm", path: resolve(codexHome, "state_5.sqlite-shm") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "state-db-wal", path: resolve(codexHome, "state_5.sqlite-wal") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "logs-db", path: resolve(codexHome, "logs_2.sqlite") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "logs-db-shm", path: resolve(codexHome, "logs_2.sqlite-shm") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "logs-db-wal", path: resolve(codexHome, "logs_2.sqlite-wal") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "goals-db", path: resolve(codexHome, "goals_1.sqlite") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "goals-db-shm", path: resolve(codexHome, "goals_1.sqlite-shm") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "goals-db-wal", path: resolve(codexHome, "goals_1.sqlite-wal") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "memories-db", path: resolve(codexHome, "memories_1.sqlite") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "memories-db-shm", path: resolve(codexHome, "memories_1.sqlite-shm") },
			{ kind: "runner-runtime-file", runner: "codex", channel: "memories-db-wal", path: resolve(codexHome, "memories_1.sqlite-wal") },
		]
	}
	if (runner === "opencode") return [
		{ kind: "runner-runtime-directory", runner: "opencode", channel: "data", path: resolve(homedir(), ".local/share/opencode") },
		{ kind: "runner-runtime-directory", runner: "opencode", channel: "state", path: resolve(homedir(), ".local/state/opencode") },
	]
	return []
}

function sandboxPathSpellings(path: string): string[] {
	return path.startsWith("/var/") ? [path, `/private${path}`] : [path]
}

function distinctPaths(paths: readonly string[]): string[] {
	const result: string[] = []
	for (const path of paths) {
		if (!result.some((existing) => samePath(existing, path))) result.push(path)
	}
	return result
}

// #481 opencode invocation shape (matches operator's local `opencode 1.17.10`):
//   opencode run --format json --dangerously-skip-permissions --dir <cwd> -m <model> [-s <sessionID>] <prompt>
// Resume passes `-s <sessionID>`; fresh start omits it. JSON streaming is mandatory because the
// engine reads the first line for the `sessionID` (value `ses_…`) — see parseOpencodeSessionIdFromStream.
// Default model is `opencode-go/glm-5.2` (see DEFAULT_OPENCODE_MODEL); model resolution layered
// upstream in applyPhaseDefaultModel — the model arg passed here is authoritative once set.
export function agentOpencodeArgs(
	extraArgs: readonly string[],
	prompt: string,
	resume: ResumeDecision,
	model: string | null,
	agentCwd: string,
): string[] {
	const effectiveModel = model ?? DEFAULT_OPENCODE_MODEL
	const runnerArgs = stripModelArgs(extraArgs, ["--model", "-m"])
	const args: string[] = ["run"]
	if (!runnerArgs.includes("--pure")) args.push("--pure")
	if (!runnerArgs.includes("--format") && !runnerArgs.some((arg) => arg.startsWith("--format="))) args.push("--format", "json")
	if (!runnerArgs.includes("--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions")
	args.push("--dir", agentCwd)
	args.push(...runnerArgs)
	args.push("-m", effectiveModel)
	if (resume.kind === "resume") args.push("-s", resume.sessionId)
	args.push(prompt)
	return args
}

export function agentCodexArgs(
	extraArgs: readonly string[],
	prompt: string,
	resume: ResumeDecision,
	agentCwd: string,
	model: string | null = null,
	additionalDirs: readonly string[] = [],
): string[] {
	const topLevelArgs = ["--ask-for-approval", "never", "-c", "shell_environment_policy.inherit=all", "exec"]
	const runnerArgs = model === null ? [...extraArgs] : stripModelArgs(extraArgs, ["--model", "-m"])
	if (resume.kind === "resume") {
		const args = [...topLevelArgs, "resume", resume.sessionId, ...runnerArgs]
		if (model !== null) args.push("--model", model)
		if (!args.includes("--json")) args.push("--json")
		if (!args.includes("--ignore-rules")) args.push("--ignore-rules")
		args.push(prompt)
		return args
	}
	const args = [...topLevelArgs, ...runnerArgs]
	if (model !== null) args.push("--model", model)
	if (!args.includes("--json")) args.push("--json")
	if (!args.includes("--cd")) args.push("--cd", agentCwd)
	if (additionalDirs.length > 0 && !args.includes("--add-dir")) {
		for (const dir of additionalDirs) args.push("--add-dir", dir)
	}
	args.push(prompt)
	return args
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

function agentOutputPath(options: LoopOptions, runId: string, label: AgentLabel): string {
	return resolve(options.logDir, runId, label, "stdout.jsonl")
}

function agentStatusPath(outputPath: string): string {
	return resolve(dirname(outputPath), "status.json")
}

export function agentSessionsPath(outputPath: string): string {
	return resolve(dirname(outputPath), "sessions.jsonl")
}

function agentAttemptStderrPath(outputPath: string, startedAt: string): string {
	void startedAt
	return resolve(dirname(outputPath), "stderr.txt")
}

function agentAttemptStreamPath(outputPath: string, startedAt: string): string {
	void startedAt
	return outputPath
}

export function parseSessionIdFromStream(text: string): string | null {
	const newlineIdx = text.indexOf("\n")
	if (newlineIdx === -1) return null
	const firstLine = text.slice(0, newlineIdx).trim()
	if (firstLine === "") return null
	try {
		const event: BoundaryValue = JSON.parse(firstLine)
		if (isObjectRecord(event) && typeof event.session_id === "string" && event.session_id !== "") return event.session_id
		return null
	} catch {
		return null
	}
}

export function parseCodexThreadIdFromStream(text: string): string | null {
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "") continue
		try {
			const event: BoundaryValue = JSON.parse(trimmed)
			if (isObjectRecord(event) && event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id !== "") return event.thread_id
		} catch {
			continue
		}
	}
	return null
}

// #481: opencode emits a JSONL stream whose first event carries `sessionID` (value form
// `ses_<hex>`). The line shape (verified against `opencode 1.17.5` on the operator's machine) is
// a single JSON object per line; the first line is enough to capture the session id. We do not
// rely on a particular `type` field — only on the presence of a string `sessionID` on the first
// JSON object.
export function parseOpencodeSessionIdFromStream(text: string): string | null {
	const newlineIdx = text.indexOf("\n")
	const firstLine = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim()
	if (firstLine === "") return null
	try {
		const event: BoundaryValue = JSON.parse(firstLine)
		if (isObjectRecord(event) && typeof event.sessionID === "string" && event.sessionID !== "") return event.sessionID
		return null
	} catch {
		return null
	}
}

export function parseSessionIdFromRunnerStream(runner: AgentRunnerKind, text: string): string | null {
	if (runner === "codex") return parseCodexThreadIdFromStream(text)
	if (runner === "opencode") return parseOpencodeSessionIdFromStream(text)
	return parseSessionIdFromStream(text)
}

export function extractErrorCode(stdoutText: string, stderrText: string): string {
	// #478: account-level rate limit shapes do not fit the generic `error`/`message` extraction
	// below — claude/codex emit `{type:"result",is_error:true,api_error_status:429,result:"..."}`
	// (no `error` field, no `message` string), so the pre-#478 path fell through to stderr,
	// which is empty on rate-limit, and returned "unclassified". Delegate to the dedicated
	// rate-limit classifier first so `isTransient5xx` then routes to resume instead of fresh.
	const rateLimitCode = classifyRateLimitFromStdout(stdoutText).code
	if (rateLimitCode !== null) return rateLimitCode
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: BoundaryValue = JSON.parse(line)
			if (!isObjectRecord(parsed)) continue
			const isError = parsed["is_error"] === true || parsed["type"] === "error"
			if (!isError) continue
			const errorObj = parsed["error"]
			if (isObjectRecord(errorObj)) {
				if (typeof errorObj.type === "string" && errorObj.type !== "") return errorObj.type
				if (typeof errorObj.code === "string" && errorObj.code !== "") return errorObj.code
				if (typeof errorObj.message === "string" && errorObj.message !== "") return errorObj.message.slice(0, 200)
			}
			if (typeof parsed["message"] === "string" && parsed["message"] !== "") return parsed["message"].slice(0, 200)
		} catch {
			continue
		}
	}
	const httpMatch = stderrText.match(/\b(5\d\d)\b/)
	if (httpMatch) return `${httpMatch[1]}_http`
	const keywordMatch = stderrText.toLowerCase().match(/overloaded|rate[\s_-]?limit|service[\s_-]?unavailable/)
	if (keywordMatch) return keywordMatch[0]
	return "unclassified"
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
		case "timeout":
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
			const parsed: BoundaryValue = JSON.parse(line)
			const result = SessionEntryBoundary(parsed)
			if (result instanceof arkType.errors) continue
			return result
		} catch {
			continue
		}
	}
	return null
}


export async function appendSessionEntry(sessionsPath: string, entry: SessionEntry): Promise<void> {
	const line = JSON.stringify(entry) + "\n"
	await appendFile(sessionsPath, line)
}

export type AttemptOutcome = {
	output: string
	stdoutBytes: number
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

export async function runAgentWithBackoff(deps: RunWithBackoffDeps): Promise<{ output: string; stdoutBytes: number; code: number; attempts: number }> {
	let resume = deps.initialResume
	let retryIndex = 0
	let elapsedBackoffSeconds = 0
	let attempts = 0
	while (true) {
		attempts++
		const outcome = await deps.spawnAttempt({ resume })
		if (outcome.terminated.kind === "watchdog") {
			deps.log(`post-summary watchdog terminated attempt (phase=${outcome.terminated.phase}); treating as success because the phase printed its mandatory summary`)
			return { output: outcome.output, stdoutBytes: outcome.stdoutBytes, code: 0, attempts }
		}
		if (outcome.terminated.kind === "error" && isTransient5xx(outcome.terminated.code)) {
			if (outcome.sessionId === null) {
				deps.log(`backoff abort: transient-5xx without sessionId; returning to outer loop`)
				return { output: outcome.output, stdoutBytes: outcome.stdoutBytes, code: outcome.exitCode, attempts }
			}
			const sleepSeconds = nextBackoffSeconds(retryIndex)
			if (elapsedBackoffSeconds + sleepSeconds > BACKOFF_BUDGET_SECONDS) {
				deps.log(`backoff budget exhausted: elapsed=${elapsedBackoffSeconds}s, next=${sleepSeconds}s, budget=${BACKOFF_BUDGET_SECONDS}s; returning to outer loop`)
				return { output: outcome.output, stdoutBytes: outcome.stdoutBytes, code: outcome.exitCode, attempts }
			}
			deps.log(`transient-5xx detected (code=${outcome.terminated.code}); sleeping ${sleepSeconds}s before resume #${retryIndex + 1}`)
			await deps.sleep(sleepSeconds)
			elapsedBackoffSeconds += sleepSeconds
			retryIndex++
			resume = { kind: "resume", sessionId: outcome.sessionId }
			continue
		}
		return { output: outcome.output, stdoutBytes: outcome.stdoutBytes, code: outcome.exitCode, attempts }
	}
}

function resolveFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path)
}

async function checkCentralRuntimeLayout(options: LoopOptions, chain: ChainRecord, errors: RuntimeCheckError[]): Promise<void> {
	try {
		const rootOptions = loopDataRootOption(options.loopDataRoot)
		const loopData = resolveLoopDataPaths(rootOptions)
		const chainPaths = resolveChainRuntimePaths(chain.name, rootOptions)
		checkInside(loopData.root, chainPaths.sharedFile, "shared context", errors)
		checkInside(loopData.root, chainPaths.issuesDir, "issueDir", errors)
		checkInside(loopData.root, chainPaths.evidenceDir, "evidenceDir", errors)
		checkInside(loopData.root, chainPaths.runsDir, "logDir", errors)
		await checkFile(chainPaths.sharedFile, "sharedContextPath", errors)
		await checkDirectory(chainPaths.issuesDir, "issueDir", errors)
		await checkDirectory(chainPaths.evidenceDir, "evidenceRootDir", errors)
		await checkDirectory(chainPaths.runsDir, "logDir", errors)
	} catch (error) {
		pushCheckError(errors, "loopDataRoot", errorMessage(error))
	}
}

function checkChainItemPath(
	options: LoopOptions,
	chain: ChainRecord,
	path: string,
	label: string,
	kind: "issues" | "evidence",
	errors: RuntimeCheckError[],
): void {
	try {
		const chainPaths = resolveChainRuntimePaths(chain.name, loopDataRootOption(options.loopDataRoot))
		const root = kind === "issues" ? chainPaths.issuesDir : chainPaths.evidenceDir
		resolveChainScopedPath(chainPaths.chainRoot, root, path, label)
	} catch (error) {
		pushCheckError(errors, label, errorMessage(error))
	}
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
	const timestamp = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, "-")
	return id === null ? `run-${timestamp}-no-issue` : `run-${timestamp}-issue-${id}`
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists()
}

function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`
	console.error(line)
	logStream?.write(line + "\n")
}

function formatMaxIterations(value: number): string {
	return value === Number.POSITIVE_INFINITY ? "Infinity" : String(value)
}

type ArkAssertable<T> = {
	assert(data: BoundaryValue): T
}

function assertArk<T>(schema: ArkAssertable<T>, data: BoundaryValue, label: string): T {
	try {
		return schema.assert(data)
	} catch (error) {
		const message = `${label}: ${errorMessage(error)}`
		if (label === "preset") throw new PresetStructureError(message)
		throw new Error(message)
	}
}

function isJsonValue(value: BoundaryValue): value is JsonValue {
	if (value === null) return true
	const kind = typeof value
	if (kind === "string" || kind === "number" || kind === "boolean") return kind !== "number" || Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (kind !== "object") return false
	return isJsonObject(value)
}

function isJsonObject(value: BoundaryValue): value is JsonObject {
	if (!isObjectRecord(value) || Array.isArray(value)) return false
	return Object.values(value).every(isJsonValue)
}


function isNodeError(error: BoundaryError): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

function errorMessage(error: BoundaryError): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

function fail(message: string): never {
	throw new CoderLoopError(message)
}

if (import.meta.main) {
	main().catch((error: BoundaryError) => {
		const message = errorMessage(error)
		console.error(message)
		process.exit(1)
	})
}
