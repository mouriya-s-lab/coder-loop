import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buildLiveRuntimeHealthLines, upsertTargetChain } from "./install-commands"
import { buildCoderLoopStatusSnapshot, loadPreset } from "./loop"
import { defaultChainNameForTarget } from "./runtime-paths"
import { openStateStore } from "./state-db"

const REPO_ROOT = resolve(import.meta.dir, "..")

describe("buildLiveRuntimeHealthLines", () => {
	test("summarizes status snapshot health and stale loop ownership signals", async () => {
		const target = await makeDoctorTarget()
		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, configPath: null, repository: null, output: "json" })
		const lines = buildLiveRuntimeHealthLines(snapshot)

		expect(lines).toContain(`OK: state ok (${resolve(target, ".coder-loop/runtime/state.json")})`)
		expect(lines.some((line) => line.includes("queue total=1") && line.includes("selected=alpha"))).toBe(true)
		expect(lines.some((line) => line.includes("runner hostDefault=") && line.includes("default="))).toBe(true)
		expect(lines.some((line) => line.includes("current id=alpha") && line.includes("phase=run"))).toBe(true)
		expect(lines.some((line) => line.includes("current phase status missing"))).toBe(true)
		expect(lines).toContain("WARN: stale loop file: recorded pid is not alive")
		expect(lines).toContain("WARN: no live loop process is owned by this target")
	})
})

describe("install label catalog", () => {
	test("includes the blocked issue kind label", async () => {
		const source = await readFile(resolve(REPO_ROOT, "src/install-commands.ts"), "utf-8")
		expect(source).toContain('name: "kind:blocked"')
		expect(source).toContain("解除具体阻塞条件")
	})
})

describe("chain install metadata", () => {
	test("imports legacy state into a stable chain without duplicating items", async () => {
		const target = await mkdtemp(resolve(tmpdir(), "coder-loop-install-chain-"))
		const root = resolve(target, "loop-data")
		const runtime = resolve(target, ".coder-loop/runtime")
		await mkdir(resolve(runtime, "issues"), { recursive: true })
		await mkdir(resolve(runtime, "evidence/issue-146"), { recursive: true })
		await mkdir(resolve(runtime, "logs"), { recursive: true })
		await writeFile(resolve(target, ".coder-loop/workflow.md"), "# workflow\n")
		await writeFile(resolve(runtime, "issues/146.md"), "# Issue 146\n")
		await writeFile(resolve(runtime, "state.json"), JSON.stringify({
			version: 1,
			queue: [{
				issue: 146,
				status: "queued",
				priority: "medium",
				issueFile: ".coder-loop/runtime/issues/146.md",
				evidenceDir: ".coder-loop/runtime/evidence/issue-146",
				kind: "code",
			}],
			repository: "owner/repo",
			baseBranch: "main",
			recentRuns: [],
			current: null,
		}, null, "\t"))
		const preset = await loadPreset(resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"))
		const previousRoot = process.env.CODER_LOOP_DATA_ROOT
		process.env.CODER_LOOP_DATA_ROOT = root
		try {
			const first = await upsertTargetChain({ target, preset, repository: "owner/repo", baseBranch: "main", dryRun: false })
			const second = await upsertTargetChain({ target, preset, repository: "owner/repo", baseBranch: "main", dryRun: false })
			expect(first.itemsInserted).toBe(1)
			expect(second.itemsInserted).toBe(0)
			expect(second.itemsUpdated).toBe(1)

			const store = openStateStore(resolve(root, "state.db"))
			try {
				const chain = store.getChain(defaultChainNameForTarget(target))
				expect(chain?.repository).toBe("owner/repo")
				expect(chain?.baseBranch).toBe("main")
				const items = store.listItems(chain?.id ?? -1)
				expect(items).toHaveLength(1)
				expect(items[0]?.issue).toBe(146)
				expect(items[0]?.issueFile).toBe("issues/146.md")
				expect(items[0]?.evidenceDir).toBe("evidence/issue-146")
				expect(items[0]?.extra).toEqual({ kind: "code" })
			} finally {
				store.close()
			}
		} finally {
			if (previousRoot === undefined) delete process.env.CODER_LOOP_DATA_ROOT
			else process.env.CODER_LOOP_DATA_ROOT = previousRoot
		}
	})
})

async function makeDoctorTarget(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-doctor-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({ preset: "single-phase-example" }, null, 2))
	await writeFile(resolve(runtime, "state.json"), JSON.stringify({
		version: 1,
		queue: [{ id: "alpha", status: "pending" }],
		recentRuns: [],
		current: {
			id: "alpha",
			phase: "run",
			runId: "run-alpha",
			startedAt: new Date().toISOString(),
		},
	}, null, 2))
	await writeFile(resolve(dir, ".dev-loop"), [
		"started: 2026-05-17T00:00:00.000Z",
		"pid: 999999",
		`log: ${resolve(runtime, "logs/coder-loop-999999.log")}`,
		`cwd: ${dir}`,
		`state: ${resolve(runtime, "state.json")}`,
		"command: bun src/loop.ts --target-cwd .",
		"requireBrowserEvidence: false",
		"",
	].join("\n"))
	return dir
}
