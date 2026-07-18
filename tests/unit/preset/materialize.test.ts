import { describe, expect, test } from "bun:test"

import {
	resolve,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	stat,
	writeFile,
	tmpdir,
	PRESET_MATERIALIZED_DIRNAME,
	PRESET_ROOT_TOKEN,
	loadPreset,
	materializePreset,
	prunePresetMaterializedRoot,
	substitutePresetRootToken,
	PresetPlaceholderFinding,
	BUNDLED_PRESET_DIR,
} from "./helpers"

// --- preset materialization (`{{PRESET_ROOT}}` substitution + hash-keyed copy) ---
//
// Materialization is the substitution site for the engine-owned `{{PRESET_ROOT}}`
// token used by cross-file references in preset md files. The tests below cover
// (1) that token replacement is physical and produces an absolute path,
// (2) that the target dir is content-hash-keyed so unchanged sources are
// idempotent and source edits produce a new dir, (3) that loadPreset's
// `materialize` option threads through so `preset.presetDir` and every
// fragment/prompt path resolves to the materialized copy, (4) that
// placeholder validation ignores `{{PRESET_ROOT}}` (it's engine-owned, not
// declared in [phases.variables]), and (5) that `prunePresetMaterializedRoot`
// removes stale dirs.

async function writeMinimalMaterializeFixture(root: string, sentinel: string): Promise<{ presetDir: string }> {
	const presetDir = resolve(root, "materialize-fixture")
	await mkdir(resolve(presetDir, "quality"), { recursive: true })
	await writeFile(
		resolve(presetDir, "preset.toml"),
		`name = "materialize-fixture"

[item]
idField = "issue"

[item.fields]
issue = "number"

[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"

[[phases]]
name = "iteration"
prompt = "iter-entry.md"

  [[phases.exits]]
  status = "done"
  when   = "task finished"

  [phases.variables]
  PROMPT_ROOT = "runtime.presetDir"
`,
	)
	// Entry references a fragment via {{PRESET_ROOT}}; body carries a sentinel
	// so tests can spot content edits in the hash.
	await writeFile(
		resolve(presetDir, "iter-entry.md"),
		`Prompt root: {{PROMPT_ROOT}}\n\nRead {{PRESET_ROOT}}/quality/evidence.md before you act.\n\nSentinel: ${sentinel}\n`,
	)
	await writeFile(resolve(presetDir, "quality/evidence.md"), "quality evidence body\n")
	return { presetDir }
}

describe("materializePreset", () => {
	test("replaces {{PRESET_ROOT}} in .md files with the target absolute path; non-md files pass through verbatim", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const result = await materializePreset(presetDir, materializeRoot)

		expect(result.promptRoot).toBe(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME, result.dirName))
		expect(result.dirName.startsWith("materialize-fixture-")).toBe(true)

		// .md entry: token has been physically substituted with the target path.
		const entry = await readFile(resolve(result.promptRoot, "iter-entry.md"), "utf-8")
		expect(entry).not.toContain(PRESET_ROOT_TOKEN)
		expect(entry).toContain(`Read ${result.promptRoot}/quality/evidence.md`)

		// Non-md preset.toml: byte-for-byte copy (materialization does not touch
		// it; parsing runs on the target so path resolution still lands inside
		// the materialized dir).
		const tomlSrc = await readFile(resolve(presetDir, "preset.toml"), "utf-8")
		const tomlDst = await readFile(resolve(result.promptRoot, "preset.toml"), "utf-8")
		expect(tomlDst).toBe(tomlSrc)

		// Marker file signals a completed materialization for idempotent reuse.
		const marker = await stat(resolve(result.promptRoot, ".materialized-complete"))
		expect(marker.isFile()).toBe(true)
	})

	test("content hash is stable across repeated calls (idempotent) and changes when source changes", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const first = await materializePreset(presetDir, materializeRoot)
		const second = await materializePreset(presetDir, materializeRoot)
		expect(second.contentHash).toBe(first.contentHash)
		expect(second.promptRoot).toBe(first.promptRoot)

		// Same-content re-run keeps the single dir; prune-siblings-on-materialize
		// leaves the current one alone.
		const rootEntries = await readdir(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))
		expect(rootEntries.filter((entry) => entry.startsWith("materialize-fixture-"))).toEqual([first.dirName])

		// Editing the source produces a new hash and a new materialized dir; the
		// previous dir is pruned because it shares the `materialize-fixture-`
		// name prefix.
		await writeFile(
			resolve(presetDir, "iter-entry.md"),
			`Prompt root: {{PROMPT_ROOT}}\n\nRead {{PRESET_ROOT}}/quality/evidence.md before you act.\n\nSentinel: beta\n`,
		)
		const third = await materializePreset(presetDir, materializeRoot)
		expect(third.contentHash).not.toBe(first.contentHash)
		expect(third.promptRoot).not.toBe(first.promptRoot)
		const afterEdit = await readdir(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))
		expect(afterEdit.filter((entry) => entry.startsWith("materialize-fixture-"))).toEqual([third.dirName])
	})

	test("loadPreset({ materialize }) points preset.presetDir + fragment/prompt paths at the materialized copy", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const preset = await loadPreset(presetDir, { materialize: { root: materializeRoot } })
		expect(preset.presetDir.startsWith(resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME))).toBe(true)
		expect(preset.presetDir).not.toBe(presetDir)

		const iterPhase = preset.phases.find((phase) => phase.name === "iteration")
		expect(iterPhase).not.toBeUndefined()
		expect(iterPhase!.prompt.startsWith(preset.presetDir + "/")).toBe(true)

		// The materialized phase entry has no {{PRESET_ROOT}} residue.
		const entry = await readFile(iterPhase!.prompt, "utf-8")
		expect(entry).not.toContain(PRESET_ROOT_TOKEN)
	})

	test("materialize threads through gh-issue-pr-iteration end-to-end (all 57 references substituted, no residue in md files)", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const materializeRoot = resolve(tmp, "loop-data")

		const preset = await loadPreset(BUNDLED_PRESET_DIR, { materialize: { root: materializeRoot } })
		expect(preset.presetDir).not.toBe(BUNDLED_PRESET_DIR)

		// No md file in the materialized tree may still carry the token — the
		// substitution guarantee is what makes the fragments' absolute paths
		// resolve inside the sandbox at runtime.
		const walk = async (dir: string): Promise<string[]> => {
			const out: string[] = []
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const full = resolve(dir, entry.name)
				if (entry.isDirectory()) out.push(...(await walk(full)))
				else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full)
			}
			return out
		}
		const mdFiles = await walk(preset.presetDir)
		expect(mdFiles.length).toBeGreaterThan(0)
		for (const file of mdFiles) {
			const content = await readFile(file, "utf-8")
			expect(content).not.toContain(PRESET_ROOT_TOKEN)
		}
	})
})

describe("{{PRESET_ROOT}} placeholder handling", () => {
	test("loadPreset does not flag {{PRESET_ROOT}} as undeclared even when the phase entry uses it (in-memory substitution runs before validate)", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-materialize-"))
		const { presetDir } = await writeMinimalMaterializeFixture(tmp, "alpha")

		const findings: PresetPlaceholderFinding[] = []
		// No materialize option — the source md still contains the raw token,
		// but readPresetPhasePrompt substitutes with sourceDir before the
		// placeholder validator runs; validation must not report PRESET_ROOT
		// as an undeclared placeholder.
		await loadPreset(presetDir, { onValidationFinding: (finding) => findings.push(finding) })
		const errorFindings = findings.filter((finding) => finding.verdict === "error")
		expect(errorFindings).toEqual([])
	})

	test("substitutePresetRootToken is idempotent (no-op on content that already has been substituted)", () => {
		const substituted = substitutePresetRootToken("Read {{PRESET_ROOT}}/quality/evidence.md", "/materialized/preset-x")
		expect(substituted).toBe("Read /materialized/preset-x/quality/evidence.md")
		// Re-invoking has no effect (materialized files never round-trip through
		// the substitute helper, but idempotence is a load-bearing invariant of
		// the runtime read-and-substitute path).
		expect(substitutePresetRootToken(substituted, "/materialized/preset-x")).toBe(substituted)
	})
})

describe("prunePresetMaterializedRoot", () => {
	test("removes materialized dirs not present in the keep set; leaves kept dirs and returns cleanly on a missing root", async () => {
		const tmp = await mkdtemp(resolve(tmpdir(), "coder-loop-prune-"))
		const materializeRoot = resolve(tmp, "loop-data")
		// Missing root: prune is a no-op (no throw).
		await prunePresetMaterializedRoot(materializeRoot, new Set())

		const rootDir = resolve(materializeRoot, PRESET_MATERIALIZED_DIRNAME)
		await mkdir(resolve(rootDir, "alpha-abcdef01"), { recursive: true })
		await mkdir(resolve(rootDir, "alpha-11111111"), { recursive: true })
		await mkdir(resolve(rootDir, "beta-99999999"), { recursive: true })

		await prunePresetMaterializedRoot(materializeRoot, new Set(["alpha-abcdef01", "beta-99999999"]))
		const remaining = await readdir(rootDir)
		expect(remaining.sort()).toEqual(["alpha-abcdef01", "beta-99999999"].sort())
	})
})
