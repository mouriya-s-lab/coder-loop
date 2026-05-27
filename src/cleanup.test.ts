import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"
import { buildRuntimeBindings, type LoopOptions } from "./loop"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SRC_DIR = resolve(REPO_ROOT, "src")
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
const LOOP_ENTRY = resolve(SRC_DIR, "loop.ts")

describe("phase C cleanup guards", () => {
	test("runtime binding keys trimmed", async () => {
		const runtime = buildRuntimeBindings({
			options: makeLoopOptions(),
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
			issueKind: "code",
		})

		expect(Object.keys(runtime).sort()).toEqual([
			"agentCwd",
			"chainBaseBranch",
			"chainName",
			"chainUmbrellaIssue",
			"chainUmbrellaRepo",
			"currentIssueFile",
			"evidenceDir",
			"evidenceRootDir",
			"fragmentIndex",
			"issueDir",
			"issueKind",
			"logDir",
			"presetDir",
			"repoCwd",
			"resumedFromPhase",
			"resumedSessionId",
			"resumedStartedAt",
			"runId",
			"runIdGeneration",
			"sharedContextPath",
			"targetCwd",
			"workflowPath",
		].sort())

		for (const forbidden of [`state${"Path"}`, `trace${"File"}`, `loop${"File"}`]) {
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
			cmd: ["bun", "test", "src/smoke.test.ts", "--test-name-pattern", "runs a trigger phase when review changes the item to the matching status"],
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
		configPath: "/repo/config.json",
		workflowPath: "/repo/.coder-loop/workflow.md",
		sharedContextPath: "/loop-data/chains/main/shared.md",
		stateFile: "/loop-data/db.sqlite",
		issueDir: "/loop-data/chains/main/issues",
		evidenceRootDir: "/loop-data/chains/main/evidence",
		logDir: "/loop-data/chains/main/runs",
		loopDataRoot: "/loop-data",
		logFile: "/loop-data/chains/main/daemon/daemon.log",
		repository: "fixture/repo",
		baseBranch: "main",
		chainName: "main",
		worktree: false,
		requireBrowserEvidence: false,
		hostRunner: "codex",
		defaultRunner: {
			kind: "codex",
			binary: "codex",
			extraArgs: [],
			model: null,
			source: "iteration-default",
		},
		reviewRunner: {
			kind: "claude",
			binary: "claude",
			extraArgs: [],
			model: null,
			source: "review-default",
		},
		runnerCommands: {
			claude: { kind: "claude", binary: "claude", extraArgs: [], model: null },
			codex: { kind: "codex", binary: "codex", extraArgs: [], model: null },
		},
		maxIterations: 1,
		dryRun: false,
		checkRuntime: false,
		preset: {
			name: "cleanup-test",
			version: 1,
			description: "cleanup test preset",
			presetDir: PRESET_DIR,
			item: { idField: "issue" },
			statuses: { continuable: ["queued"], terminal: ["done"] },
			phases: [],
			fragments: [],
			agent: { binary: "claude", extraArgs: [], attemptTimeoutSeconds: 3600 },
		},
	}
}
