import { resolve } from "node:path"
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	ENGINE_RUNTIME_BINDING_KEYS,
	PRESET_MATERIALIZED_DIRNAME,
	PRESET_ROOT_TOKEN,
	chainCompleteTriggerPhases,
	loadPreset,
	materializePreset,
	parsePreset,
	prunePresetMaterializedRoot,
	renderFragmentIndex,
	renderRuntimeInputsDoc,
	resolveBinding,
	sliceFragmentsForPhase,
	substitutePresetRootToken,
	triggeredPhasesAfter,
	type Preset,
	type PresetPhase,
	type PresetDagFinding,
	type PresetPlaceholderFinding,
	type PresetVariableSource,
	type ResolveContext,
	type RuntimeBindings,
} from "../../../src/loop"
import { parseInternalStatus, storedItemExtra } from "../../../src/runtime-data"
import type { ItemRecord } from "../../../src/sqlite-state"
import type { BoundaryRecord } from "../../../src/boundary-types"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
export const BUNDLED_PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
export const REAL_E2E_MINIMAL_PRESET_DIR = resolve(REPO_ROOT, "presets/real-e2e-minimal")

export function status(value: string) {
	return parseInternalStatus(value, "test.status")
}

// Minimum-shape `RuntimeBindings` for the #457 declared-binding driver test (acceptance row 2):
// the runtime channel must satisfy the `Record<EngineRuntimeBindingKey, string>` requirement, but
// the umbrella resolution path under test exercises only the `chain.<field>` channel, so every
// engine fact is filled with a placeholder. ENGINE_RUNTIME_BINDING_KEYS is the source of truth for
// the key set — using it keeps this helper aligned with the post-#457 count automatically.
export function makeMinimalRuntimeBindings(): RuntimeBindings {
	const placeholder = Object.fromEntries(ENGINE_RUNTIME_BINDING_KEYS.map((key) => [key, ""])) as Record<string, string>
	return placeholder as RuntimeBindings
}

export function makeItemRecord(extra: ItemRecord["extra"] = storedItemExtra({})): ItemRecord {
	return {
		id: 1,
		chainId: 1,
		itemId: "539",
		repoCwd: REPO_ROOT,
		status: status("queued"),
		attempts: 0,
		position: 0,
		title: null,
		priority: null,
		lastRunId: null,
		sessionIds: {},
		issueFile: null,
		evidenceDir: null,
		agentCwd: null,
		runner: null,
		phase: null,
		preset: null,
		presetPath: null,
		extra,
		createdAt: 0,
		updatedAt: 0,
		statusUpdatedAt: 0,
	}
}

export const EXPECTED_FRAGMENTS = [
	{ id: "common/runtime-contract", role: "common", relPath: "common/runtime-contract.md" },
	{ id: "common/github-routing", role: "common", relPath: "common/github-routing.md" },
	{ id: "common/state-contract", role: "common", relPath: "common/state-contract.md" },
	{ id: "common/dispatch-contract", role: "common", relPath: "common/dispatch-contract.md" },
	{ id: "contract", role: "common", relPath: "contract.md" },
	{ id: "quality/evidence", role: "quality", relPath: "quality/evidence.md" },
	{ id: "quality/honesty", role: "quality", relPath: "quality/honesty.md" },
	{ id: "quality/cleanup", role: "quality", relPath: "quality/cleanup.md" },
	{ id: "iter/steps/research", role: "iter", relPath: "iter/steps/research.md" },
	{ id: "iter/steps/resolve-blocker", role: "iter", relPath: "iter/steps/resolve-blocker.md" },
	{ id: "iter/steps/implement", role: "iter", relPath: "iter/steps/implement.md" },
	{ id: "iter/steps/verify", role: "iter", relPath: "iter/steps/verify.md" },
	{ id: "iter/steps/e2e", role: "iter", relPath: "iter/steps/e2e.md" },
	{ id: "iter/steps/submit", role: "iter", relPath: "iter/steps/submit.md" },
	{ id: "iter/steps/source-spike", role: "iter", relPath: "iter/steps/source-spike.md" },
	{ id: "iter/steps/spike-comment", role: "iter", relPath: "iter/steps/spike-comment.md" },
	{ id: "review/steps/investigate", role: "review", relPath: "review/steps/investigate.md" },
	{ id: "review/steps/diff-audit", role: "review", relPath: "review/steps/diff-audit.md" },
	{ id: "review/steps/replay", role: "review", relPath: "review/steps/replay.md" },
	{ id: "review/spike-followup", role: "review", relPath: "review/spike-followup.md" },
	{ id: "review/source-spike-audit", role: "review", relPath: "review/source-spike-audit.md" },
	{ id: "review/actions/accept-pr", role: "review", relPath: "review/actions/accept-pr.md" },
	{ id: "review/actions/accept-no-pr", role: "review", relPath: "review/actions/accept-no-pr.md" },
	{ id: "review/actions/retry", role: "review", relPath: "review/actions/retry.md" },
	{ id: "review/actions/expand-parent", role: "review", relPath: "review/actions/expand-parent.md" },
	{ id: "review/actions/skip", role: "review", relPath: "review/actions/skip.md" },
	{ id: "review/actions/blocked", role: "review", relPath: "review/actions/blocked.md" },
	{ id: "review/actions/stop", role: "review", relPath: "review/actions/stop.md" },
	{ id: "review/actions/state-write", role: "review", relPath: "review/actions/state-write.md" },
] as const

export const EXPECTED_VARIABLE_KEYS = [
	"TARGET_CWD",
	"AGENT_CWD",
	"REPO",
	"BASE_BRANCH",
	"ISSUE",
	"RUN_ID",
	"SHARED_CONTEXT_FILE",
	"STATE_FILE",
	"CURRENT_ISSUE_FILE",
	"ISSUE_DIR",
	"EVIDENCE_DIR",
	"EVIDENCE_ROOT_DIR",
	"LOG_DIR",
	"TRACE_FILE",
	"LOOP_FILE",
	"PROMPT_ROOT",
	"PROMPT_FRAGMENT_INDEX",
	"RUNTIME_INPUTS_DOC",
	"PHASE_EXITS_DOC",
	"REQUIRE_BROWSER_EVIDENCE",
	"ISSUE_BRANCH",
	"ISSUE_PR",
	"ISSUE_STATUS",
	"ISSUE_LAST_RUN_ID",
	"RUN_ID_GENERATION",
	"RESUMED_FROM_PHASE",
	"RESUMED_STARTED_AT",
	"RESUMED_SESSION_ID",
	"CHAIN_NAME",
	"CHAIN_UMBRELLA_REPO",
	"CHAIN_UMBRELLA_ISSUE",
	"REPO_CWD",
] as const


export { resolve, mkdir, mkdtemp, readFile, readdir, stat, writeFile, tmpdir, DEFAULT_ATTEMPT_TIMEOUT_SECONDS, ENGINE_RUNTIME_BINDING_KEYS, PRESET_MATERIALIZED_DIRNAME, PRESET_ROOT_TOKEN, chainCompleteTriggerPhases, loadPreset, materializePreset, parsePreset, prunePresetMaterializedRoot, renderFragmentIndex, renderRuntimeInputsDoc, resolveBinding, sliceFragmentsForPhase, substitutePresetRootToken, triggeredPhasesAfter, parseInternalStatus, storedItemExtra }
export type { Preset, PresetPhase, PresetDagFinding, PresetPlaceholderFinding, PresetVariableSource, ResolveContext, RuntimeBindings, ItemRecord, BoundaryRecord }

