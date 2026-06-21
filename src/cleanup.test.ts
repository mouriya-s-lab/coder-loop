import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"
import { buildRuntimeBindings, type LoopOptions, type PresetPhase } from "./loop"
import { parseInternalStatus } from "./runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SRC_DIR = resolve(REPO_ROOT, "src")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const LOOP_ENTRY = resolve(SRC_DIR, "loop.ts")

describe("phase C cleanup guards", () => {
	test("runtime binding keys trimmed", async () => {
		const phase: Pick<PresetPhase, "roles"> = { roles: [] }
		const runtime = buildRuntimeBindings({
			options: makeLoopOptions(),
			phase,
			runId: "run-cleanup",
			currentIssueFile: null,
			evidenceDir: null,
			agentCwd: "/repo",
			issueRun: {
				runIdGeneration: "new",
				resumedFromPhase: null,
				resumedStartedAt: null,
				resumedSessionId: null,
			},
		})

		expect(Object.keys(runtime).sort()).toEqual([
			"agentCwd",
			"chainName",
			"currentIssueFile",
			"evidenceDir",
			"evidenceRootDir",
				"fragmentIndex",
				"issueDir",
				"logDir",
				"loopFile",
				"phaseExitsDoc",
				"presetDir",
				"repoCwd",
				"resumedFromPhase",
				"resumedSessionId",
				"resumedStartedAt",
				"retryStatusDoc",
				"runId",
				"runIdGeneration",
				"runtimeInputsDoc",
				"sharedContextPath",
				"stateFile",
				"statusVocabularyDoc",
				"targetCwd",
				"terminalStatusesDoc",
				"traceFile",
				"triggerStatusDoc",
			].sort())

			for (const forbidden of [`state${"Path"}`]) {
				expect(forbidden in runtime).toBe(false)
			}
	})

	test("preset fragments cleaned", async () => {
		const files = await markdownFiles(PRESET_DIR)
		for (const file of files) {
			const rel = relative(PRESET_DIR, file)
			const text = await readFile(file, "utf-8")
			for (const forbidden of formerPresetTokens()) {
				expect(text, `${rel} should not contain ${forbidden}`).not.toContain(forbidden)
			}
		}
	})

	test("exclude entries cleaned", async () => {
		const source = await readFile(LOOP_ENTRY, "utf-8")
		expect(source).not.toContain(`EXCLUDE_${"ENTRIES"}`)
		for (const forbidden of formerFileSignals()) {
			expect(source).not.toContain(forbidden)
		}
	})

	test("smoke after cleanup", async () => {
		const proc = Bun.spawnSync({
			cmd: ["bun", "test", "src/smoke.test.ts", "--test-name-pattern", "status and queue unblock use SQLite state"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		expect(proc.exitCode, `${new TextDecoder().decode(proc.stdout)}\n${new TextDecoder().decode(proc.stderr)}`).toBe(0)
	})
})

async function markdownFiles(root: string): Promise<string[]> {
	const found: string[] = []
	for (const entry of await readdir(root, { recursive: true })) {
		const path = join(root, entry)
		const info = await stat(path)
		if (info.isFile() && extname(path) === ".md") found.push(path)
	}
	return found
}

function formerPresetTokens(): string[] {
	return [
		...formerTargetArtifacts(),
		`state.${"json"}`,
		`.coder-loop/${"runtime"}/state.${"json"}`,
	]
}

function formerTargetArtifacts(): string[] {
	return [
		...formerFileSignals(),
		`.coder-loop/${"runtime"}`,
	]
}

function formerFileSignals(): string[] {
	return [
		`.${"dev-loop"}`,
		`.${"dev-trace"}`,
	]
}

function makeLoopOptions(): LoopOptions {
	return {
		targetCwd: "/repo",
		sharedContextPath: "/loop-data/chains/main/shared.md",
		stateDbPath: "/loop-data/db.sqlite",
		issueDir: "/loop-data/chains/main/issues",
		evidenceRootDir: "/loop-data/chains/main/evidence",
		logDir: "/loop-data/chains/main/runs",
		loopDataRoot: "/loop-data",
		logFile: "/loop-data/chains/main/daemon/daemon.log",
		repository: "fixture/repo",
		baseBranch: "main",
		bindings: {
			repository: "fixture/repo",
			baseBranch: "main",
		},
		chainName: "main",
		worktree: false,
		hostRunner: "codex",
		defaultRunner: {
			kind: "codex",
			binary: "codex",
			extraArgs: [],
			model: null,
			source: "iteration-default",
		},
		runnerCommands: {
			claude: { kind: "claude", binary: "claude", extraArgs: [], model: null },
			codex: { kind: "codex", binary: "codex", extraArgs: [], model: null },
		},
		dryRun: false,
		preset: {
			name: "cleanup-test",
			presetDir: PRESET_DIR,
			item: { idField: "issue", fields: new Map() },
			runtime: { businessKeys: [], businessKeyValues: new Map() },
				statuses: {
					continuable: [parseInternalStatus("queued", "test.status")],
					terminal: [parseInternalStatus("done", "test.status")],
					success: [parseInternalStatus("done", "test.status")],
					entry: parseInternalStatus("queued", "test.status"),
					unblockable: [],
					// #402: required by Preset.statuses.
					exhausted: parseInternalStatus("done", "test.status"),
					// #404: optional preset-declared retry status; this fixture has no retry concept.
					retry: null,
				},
			phases: [],
			fragments: [],
			// #433: [agent].binary/extraArgs retired; preset.agent is now { attemptTimeoutSeconds }.
			agent: { attemptTimeoutSeconds: 3600 },
		},
	}
}
