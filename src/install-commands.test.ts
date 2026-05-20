import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buildLiveRuntimeHealthLines } from "./install-commands"
import { buildCoderLoopStatusSnapshot } from "./loop"

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
