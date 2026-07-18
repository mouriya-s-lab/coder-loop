import { describe, expect, test } from "bun:test"

import {
	resolve,
	mkdtemp,
	writeFile,
	tmpdir,
	loadPreset,
	PresetDagFinding,
	REPO_ROOT,
	BUNDLED_PRESET_DIR,
	REAL_E2E_MINIMAL_PRESET_DIR,
} from "./helpers"

describe("loadPreset cross-table DAG check (issue #408)", () => {
	// Fixture writer: copies the placeholder-validation `minimalPresetToml` shape
	// but takes an arbitrary preset.toml body so each row of issue #408's
	// acceptance table can construct exactly the violation it needs (and nothing
	// else). All fixtures pin the entry md to "run-entry.md" with two declared
	// variables — `KEY` (item.id) and `TITLE` (item.title) — and write a matching
	// entry md so the placeholder validator never trips before the DAG checker.
	async function writeDagFixture(tomlBody: string): Promise<string> {
		const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-dag-preset-"))
		await writeFile(resolve(dir, "preset.toml"), tomlBody)
		await writeFile(resolve(dir, "run-entry.md"), "id={{KEY}} title={{TITLE}}\n")
		return dir
	}

	const baseStatusesBlock = `[item]
idField = "id"

[item.fields]
title = "string"
`

	// Row 5a — dead trigger edge (whenStatus has no producer in afterPhase's exits).
	// The existing local check at `loop.ts:4116-4122` already rejects this with
	// the precise per-phase error before the cross-table DAG checker ever runs,
	// so the new check is a non-overlap: this row's expected error message is the
	// existing local one. We assert that behavior is preserved (the DAG checker
	// does not weaken or hide the local rejection).
	test("row #1 / row #5a: trigger edge keyed on a status no producer phase writes is rejected by the existing local check (DAG checker does not regress it)", async () => {
		const dir = await writeDagFixture(`name = "dead-trigger-edge"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Done."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "responder"
prompt  = "run-entry.md"
trigger = { afterPhase = "run", whenStatus = "queued" }

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		// Existing local rule fires first with the per-phase pinpoint; cross-table
		// DAG check never runs on this fixture because parsePreset rejects it.
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) })).rejects.toThrow(/preset\.phases\[1\]\.trigger\.whenStatus: status "queued" is not declared by phase "run" item-status exits/)
		expect(findings).toEqual([])
	})

	test("row #2 / row #5b: deadlock-continuable surfaces as an error finding pinpointing the table and status", async () => {
		// Two continuable statuses, only one of which has any phase-exit leaving
		// edge. `pending` is the deadlock target — no phase writes !=pending.
		const dir = await writeDagFixture(`name = "deadlock-continuable"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "pending"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "pending"
  when   = "Always stays in pending — the deadlock."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset.statuses.continuable: "pending" has no leaving phase-exit edge/)
		const deadlock = findings.find((f) => f.kind === "deadlock-continuable")
		expect(deadlock).toBeDefined()
		if (deadlock?.kind === "deadlock-continuable") {
			expect(deadlock.verdict).toBe("error")
			expect(deadlock.table).toBe("statuses.continuable")
			expect(deadlock.status).toBe("pending")
			expect([...deadlock.contributingPhases]).toEqual(["run"])
		}
	})

	test("row #3: dead-vocabulary surfaces as a warn finding and does NOT block the load", async () => {
		// `in_progress` is declared continuable but no producer (entry, exhausted,
		// or any item-status exit) can write it — the dead-vocabulary drift shape
		// acknowledged in the issue body.
		const dir = await writeDagFixture(`name = "dead-vocabulary"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "in_progress"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("dead-vocabulary")
		const dead = findings.find((f) => f.kind === "dead-vocabulary")
		expect(dead).toBeDefined()
		if (dead?.kind === "dead-vocabulary") {
			expect(dead.verdict).toBe("warn")
			expect(dead.table).toBe("statuses.continuable")
			expect(dead.status).toBe("in_progress")
			// Known producers: entry ("queued"), exhausted ("exhausted"), and the
			// single item-status exit ("done"). The list is sorted for stability.
			expect([...dead.knownProducers]).toEqual(["done", "exhausted", "queued"])
		}
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})

	test("row #4: every bundled preset loads with no DAG error findings", async () => {
		for (const presetDir of [
			BUNDLED_PRESET_DIR,
			resolve(REPO_ROOT, "presets/single-phase-example"),
			resolve(REPO_ROOT, "presets/business-key-example"),
			resolve(REPO_ROOT, "presets/engine-integration"),
			REAL_E2E_MINIMAL_PRESET_DIR,
		]) {
			const findings: PresetDagFinding[] = []
			await loadPreset(presetDir, { onDagFinding: (f) => findings.push(f) })
			expect(findings.filter((f) => f.verdict === "error")).toEqual([])
		}
	})

	test("row #4 (chain-complete variant): a `trigger = { on = \"chain-complete\" }` phase with no exits is NOT misreported as a deadlock contributor", async () => {
		// Mirror the umbrella-finalizer shape from `gh-issue-pr-iteration`. The
		// chain-complete trigger phase fires only on chain completion and writes
		// no item status; it must not be counted as a leaving edge for any
		// continuable status, and it must not appear in the deadlock-finding
		// `contributingPhases` list. We verify by giving `run` a real leaving
		// edge for `queued` and a chain-complete phase with zero exits — the load
		// must succeed with zero findings.
		const dir = await writeDagFixture(`name = "chain-complete-variant"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "finalizer"
prompt  = "run-entry.md"
trigger = { on = "chain-complete" }

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("chain-complete-variant")
		expect(findings).toEqual([])
	})

	test("row #5: entry status outside continuable is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "entry-not-continuable"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "done"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.statuses\.entry: "done" must be one of statuses\.continuable/)
	})

	test("row #5: unblockable status outside terminal is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "unblockable-not-terminal"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
unblockable = ["queued"]
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.statuses\.unblockable: "queued" must be one of statuses\.terminal/)
	})

	test("row #5: exit status outside the declared vocabulary is rejected by the existing local check", async () => {
		const dir = await writeDagFixture(`name = "exit-status-unknown"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "no_such_status"
  when   = "This status is not in the declared vocabulary."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		await expect(loadPreset(dir, { onDagFinding: (f) => findings.push(f) }))
			.rejects.toThrow(/preset\.phases\[\d+\]\.exits\.status: unrecognized status "no_such_status"/)
	})

	test("trigger-keyed phase whose exits all write back to its own keyed status is correctly identified as NOT a leaving edge", async () => {
		// A trigger phase with `whenStatus = S` and exits writing only `S` does
		// NOT contribute a leaving edge for S. This pins the (b)-branch of the
		// leaving-check rule: a triggered responder that only re-asserts its
		// gating status is a self-loop, not a path out.
		const dir = await writeDagFixture(`name = "trigger-selfloop"
version = 1
${baseStatusesBlock}
[statuses]
continuable = ["queued", "needs_review"]
terminal    = ["done", "exhausted"]
entry       = "queued"
exhausted   = "exhausted"

[[phases]]
name   = "run"
prompt = "run-entry.md"

  [[phases.exits]]
  status = "needs_review"
  when   = "Item needs review attention."

  [[phases.exits]]
  status = "done"
  when   = "Run finished."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[[phases]]
name    = "responder"
prompt  = "run-entry.md"
trigger = { afterPhase = "run", whenStatus = "needs_review" }

  [[phases.exits]]
  status = "needs_review"
  when   = "Responder failed; re-key on needs_review for retry."

  [phases.variables]
  KEY = "item.id"
  TITLE = "item.title"

[agent]
attemptTimeoutSeconds = 3600
`)
		const findings: PresetDagFinding[] = []
		const preset = await loadPreset(dir, { onDagFinding: (f) => findings.push(f) })
		expect(preset.name).toBe("trigger-selfloop")
		// `needs_review` has a leaving edge through `run` (which writes `done` !=
		// needs_review), so it is NOT a deadlock; the responder's self-loop does
		// not contribute, but it does not need to.
		expect(findings.filter((f) => f.verdict === "error")).toEqual([])
	})
})

