// #408 preset DAG cross-table consistency checker.
//
// The DAG of legal item-status transitions is assembled from three independent
// preset tables: `[statuses]` (vocabulary + entry / exhausted / continuable),
// `[[phases.exits]]` (per-phase outgoing edges), and `[[phases]].trigger`
// (incoming-edge filters for triggered phases). The per-table validators in
// `parsePreset` enforce local well-formedness (every exits.status is in the
// vocabulary; every trigger.whenStatus is in the source phase's exits, etc.).
// They do not enforce CROSS-table consistency — a preset can declare a
// continuable status no producer ever writes (dead vocabulary), or one no exit
// ever leaves (a deadlock). This module fills that gap.
//
// Two rules, no overlap with the existing local checks:
//
//   R2 — deadlock-continuable [error]: a continuable status must have at least
//        one leaving phase-exit edge. The leaving check is GLOBAL across the
//        preset, considering (a) any non-trigger phase whose item-status exit
//        writes some status != S, plus (b) any trigger phase whose
//        `trigger.whenStatus == S` writes a status != S (so a triggered
//        responder gated on S that writes a terminal counts as the leaving
//        edge for S). The engine's exhausted-sink alone does NOT count — the
//        operator intent is to detect silent stuckness in the DAG itself, not
//        to lean on the retry-budget safety net.
//
//   R3 — dead-vocabulary [warn]: a continuable status no producer can ever
//        write. Producers are the union of preset.statuses.entry,
//        preset.statuses.exhausted, and every `item-status` phase exit's
//        status field, across all phases (trigger or non-trigger). A
//        continuable status declared but unreachable from any producer is
//        drift to warn about — it does not break scheduling correctness, but
//        the rendered preset prose / status vocabulary will name a value no
//        path can produce.
//
// Everything is pure: this module never reads files, never mutates the preset.
// The caller (loadPreset) iterates the returned findings, invokes the
// observability callback per finding, and throws on error verdicts.

import type { InternalStatus } from "./runtime-data"
import type { Preset, PresetPhase, PresetPhaseExit, PresetPhaseTrigger } from "./loop"

// #408 finding ADT. Two named variants, discriminated on `kind` + `verdict`.
// Both surface the same `table` literal (`"statuses.continuable"`) because the
// status under review lives in that table — pinpoint metadata names the exact
// status string (and, for the deadlock variant, the contributing phases) so an
// operator reading the rendered finding never needs to grep the preset.
export type PresetDagFindingTable = "statuses.continuable"

export type PresetDagFindingDeadlockContinuable = {
	verdict: "error"
	kind: "deadlock-continuable"
	table: "statuses.continuable"
	status: InternalStatus
	// Sites that COULD have provided a leaving edge for `status` but did not:
	// every non-trigger phase plus every trigger phase keyed on `status`. The
	// list is informational — the finding's `message` already enumerates them.
	contributingPhases: readonly string[]
	message: string
}

export type PresetDagFindingDeadVocabulary = {
	verdict: "warn"
	kind: "dead-vocabulary"
	table: "statuses.continuable"
	status: InternalStatus
	// Producers the checker considered when deciding this is dead vocabulary.
	// Always at least `[statuses.entry, statuses.exhausted]`; longer when the
	// preset has any item-status exits. Informational — the finding's
	// `message` already names the producers.
	knownProducers: readonly InternalStatus[]
	message: string
}

export type PresetDagFinding =
	| PresetDagFindingDeadlockContinuable
	| PresetDagFindingDeadVocabulary

export type PresetDagFindingKind = PresetDagFinding["kind"]
export type PresetDagFindingVerdict = PresetDagFinding["verdict"]

// Pure cross-table consistency check. Returns one finding per violation, in
// declaration order of `preset.statuses.continuable` so output is deterministic
// and stable for tests / event ordering.
export function checkPresetDag(preset: Preset): readonly PresetDagFinding[] {
	const findings: PresetDagFinding[] = []
	const itemStatusExits = collectItemStatusExits(preset.phases)
	const producers = collectProducerStatuses(preset, itemStatusExits)
	for (const status of preset.statuses.continuable) {
		// R3 first — a dead-vocabulary status surfaces as a warn even when
		// it also lacks a leaving edge (the operator wants to know "no one
		// writes this" before "no one leaves this", because R3 is the
		// upstream cause).
		if (!producers.has(status)) {
			findings.push(makeDeadVocabularyFinding(status, producers))
			continue
		}
		const leavingPhases = collectLeavingPhases(preset.phases, status, itemStatusExits)
		if (leavingPhases.length === 0) {
			findings.push(makeDeadlockContinuableFinding(status, collectDeadlockContributors(preset.phases, status)))
		}
	}
	return findings
}

// All `item-status` exits flattened to a (phase, status) tuple list. The
// chain-action branch is intentionally dropped — it writes no item-status and
// therefore cannot contribute to a producer/leaving-edge for any continuable
// status. Keeping it out of the tuple list at the source means every downstream
// reducer in this module can ignore the chain-action branch without re-narrowing.
type PhaseItemStatusExit = {
	phaseName: string
	phaseTrigger: PresetPhaseTrigger | null
	status: InternalStatus
}

function collectItemStatusExits(phases: readonly PresetPhase[]): readonly PhaseItemStatusExit[] {
	const exits: PhaseItemStatusExit[] = []
	for (const phase of phases) {
		for (const exit of phase.exits) {
			if (exit.kind !== "item-status") continue
			exits.push({ phaseName: phase.name, phaseTrigger: phase.trigger, status: exit.status })
		}
	}
	return exits
}

// Producers: the set of statuses any path in the engine + preset can write to
// item.status. Engine-owned sources are `statuses.entry` (orphan recovery,
// dependency unblock, queue unblock, item creation) and `statuses.exhausted`
// (retry-budget sink). Preset-owned sources are every `item-status` exit's
// status, regardless of whether the owning phase is trigger or non-trigger.
function collectProducerStatuses(preset: Preset, itemStatusExits: readonly PhaseItemStatusExit[]): ReadonlySet<InternalStatus> {
	const producers = new Set<InternalStatus>()
	producers.add(preset.statuses.entry)
	producers.add(preset.statuses.exhausted)
	for (const exit of itemStatusExits) producers.add(exit.status)
	return producers
}

// "Leaving" phases for continuable status S: phases whose item-status exits can
// write some status != S when S is the item's current status. Per the rule:
//   (a) any non-trigger phase — runs against any status, so any of its exits
//       writing != S counts.
//   (b) a trigger phase whose `trigger.whenStatus == S` — fires precisely when
//       item.status == S, so its exits writing != S count.
// A trigger phase keyed on a different status (or on chain-complete) cannot
// reduce S, so it does not contribute a leaving edge for S.
function collectLeavingPhases(
	phases: readonly PresetPhase[],
	status: InternalStatus,
	itemStatusExits: readonly PhaseItemStatusExit[],
): readonly string[] {
	const leaving = new Set<string>()
	for (const exit of itemStatusExits) {
		if (exit.status === status) continue
		if (exit.phaseTrigger === null) {
			leaving.add(exit.phaseName)
			continue
		}
		if (isChainCompleteTrigger(exit.phaseTrigger)) continue
		if (exit.phaseTrigger.whenStatus === status) {
			leaving.add(exit.phaseName)
		}
	}
	// Stable order: declaration order of `phases`.
	return phases.map((phase) => phase.name).filter((name) => leaving.has(name))
}

// Contributors for a deadlock finding's diagnostic message: every phase that
// MIGHT have helped reduce S — namely, every non-trigger phase plus every
// trigger phase keyed on S. We include phases even if they have zero exits,
// because "no exits declared" is the actionable diagnostic the operator needs
// (the deadlock cause is that someone forgot to declare exits, not that the
// exits they declared all write S).
function collectDeadlockContributors(phases: readonly PresetPhase[], status: InternalStatus): readonly string[] {
	const contributors: string[] = []
	for (const phase of phases) {
		if (phase.trigger === null) {
			contributors.push(phase.name)
			continue
		}
		if (isChainCompleteTrigger(phase.trigger)) continue
		if (phase.trigger.whenStatus === status) contributors.push(phase.name)
	}
	return contributors
}

function isChainCompleteTrigger(trigger: PresetPhaseTrigger): trigger is { on: "chain-complete" } {
	return "on" in trigger
}

// Diagnostic message builders are co-located so the wording stays in sync with
// the rule definitions at the top of the file. The message names the status,
// the table, and the contributing phases (or known producers) so an operator
// reading the rendered finding can locate the cause without grepping.
function makeDeadlockContinuableFinding(
	status: InternalStatus,
	contributors: readonly string[],
): PresetDagFindingDeadlockContinuable {
	const contributorsClause = contributors.length === 0
		? "no non-trigger phase and no trigger phase keyed on this status declares any item-status exit"
		: `phases that could leave it but do not: ${contributors.join(", ")}`
	return {
		verdict: "error",
		kind: "deadlock-continuable",
		table: "statuses.continuable",
		status,
		contributingPhases: contributors,
		message: `preset.statuses.continuable: "${status}" has no leaving phase-exit edge — ${contributorsClause}. The engine's exhausted-sink does not count; declare an item-status exit that writes a different status.`,
	}
}

function makeDeadVocabularyFinding(
	status: InternalStatus,
	producers: ReadonlySet<InternalStatus>,
): PresetDagFindingDeadVocabulary {
	const knownProducers = [...producers].sort()
	return {
		verdict: "warn",
		kind: "dead-vocabulary",
		table: "statuses.continuable",
		status,
		knownProducers,
		message: `preset.statuses.continuable: "${status}" is declared but no phase exit or engine transition can write it (known producers: ${knownProducers.join(", ") || "<none>"}). Either remove the dead vocabulary entry or declare a producer.`,
	}
}
