import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")

async function makeMinimalTarget(presetName: string): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "coder-loop-smoke-"))
	const runtime = resolve(dir, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence"), { recursive: true })
	await mkdir(resolve(runtime, "logs"), { recursive: true })
	await writeFile(resolve(dir, ".coder-loop/workflow.md"), "# placeholder workflow\n")
	await writeFile(resolve(runtime, "shared.md"), "# placeholder shared context\n")
	await writeFile(
		resolve(runtime, "config.json"),
		JSON.stringify({ preset: presetName }, null, 2),
	)
	const state = {
		version: 1,
		queue: [
			{ id: "alpha", status: "pending" },
			{ id: "beta", status: "pending" },
		],
		recentRuns: [],
		current: null,
	}
	await writeFile(resolve(runtime, "state.json"), JSON.stringify(state, null, 2))
	return dir
}

describe("smoke: single-phase-example preset", () => {
	test("--check-runtime passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--check-runtime"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Runtime check passed: target=")
		expect(stderr).toContain("Runtime check passed: preset=single-phase-example")
		expect(stderr).toContain("queue=2, selected=alpha")
		expect(stderr).not.toContain("repo=")
	})

	test("--dry-run passes with minimal target", async () => {
		const target = await makeMinimalTarget("single-phase-example")
		const proc = Bun.spawnSync({
			cmd: ["bun", LOOP_ENTRY, "--target-cwd", target, "--dry-run"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		const stderr = new TextDecoder().decode(proc.stderr)
		expect(proc.exitCode).toBe(0)
		expect(stderr).toContain("Dry run: target=")
		expect(stderr).toContain("Dry run: selected=alpha")
		expect(stderr).not.toContain("repo=")
	})
})
