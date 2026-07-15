import { afterAll, describe, expect, test } from "bun:test"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildLiveRuntimeHealthLines } from "./install-commands"
import { buildCoderLoopStatusSnapshot } from "./loop"
import { openSqliteStateStore } from "./sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/install-command-tests", String(process.pid))

// #397 test brand helper: tests that bypass the daemon and write status directly to SQLite
// (simulating an already-admitted value) brand through the `"test"` lifecycle reason rather
// than going through the request gate. The production path is still typechecker-enforced;
// see `AdmittedItemStatus` in src/runtime-data.ts.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("buildLiveRuntimeHealthLines", () => {
	test("summarizes status snapshot health and stale loop ownership signals", async () => {
		const target = await makeDoctorTarget()
		const loopDataRoot = resolve(target, "loop-data")
		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, loopDataRoot, output: "json" })
		const lines = buildLiveRuntimeHealthLines(snapshot)

		expect(lines).toContain(`OK: state ok (${resolve(loopDataRoot, "db.sqlite")})`)
		expect(lines.some((line) => line.includes("queue total=1") && line.includes("selected=alpha"))).toBe(true)
		expect(lines.some((line) => line.includes("runner hostDefault=") && line.includes("default="))).toBe(true)
		expect(lines).toContain("INFO: current run=<none>")
		expect(lines.some((line) => /^INFO: live processes total=\d+, matching=\d+$/.test(line))).toBe(true)
	})
})

describe("doctor command ownership", () => {
	test("reports hapi-remote-session guidance for a missing hapi runner", async () => {
		const missingBinary = `missing-hapi-remote-session-${process.pid}`
		const target = await makeDoctorTarget({ runner: "hapi", binary: missingBinary })
		const loopDataRoot = resolve(target, "loop-data")
		const bin = resolve(target, "doctor-bin")
		await mkdir(bin, { recursive: true })
		await writeFile(resolve(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
		await writeFile(resolve(bin, "coder-loop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
		const proc = Bun.spawn({
			cmd: [process.execPath, resolve(REPO_ROOT, "src/loop.ts"), "doctor", target, "--loop-data-root", loopDataRoot, "--chain", "doctor-chain"],
			cwd: REPO_ROOT,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		})
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
		expect(exitCode).toBe(1)
		expect(stderr).toContain(
			`hapi runner CLI (${missingBinary}) 未在 PATH 中。安装/配置 hapi-remote-session，并确认 \`${missingBinary} --version\` 与 \`${missingBinary} probe\` 可运行。`,
		)
		expect(stderr).not.toContain(`claude runner CLI (${missingBinary})`)
	})

	test("does not carry the preset kind label bootstrap asset", async () => {
		const source = await readFile(resolve(REPO_ROOT, "src/install-commands.ts"), "utf-8")
		expect(source).not.toContain("KIND_LABELS")
		expect(source).not.toContain("\"label\", \"create\"")
		expect(source).not.toContain("\"label\", \"list\"")
	})

	test("does not carry user-level skill bootstrap ownership", async () => {
		const source = await readFile(resolve(REPO_ROOT, "src/install-commands.ts"), "utf-8")
		expect(source).not.toContain([".claude", "skills"].join("/"))
		expect(source).not.toContain(["install", "skills"].join("-"))
		expect(source).not.toContain(["skip", "skill", "check"].join("-"))
		expect(source).not.toContain(["WRITING", "ISSUE"].join("_"))
		await expect(Bun.file(resolve(REPO_ROOT, "templates/skills")).exists()).resolves.toBe(false)
	})

	// #436: install / uninstall surface deleted entirely. doctor is the only survivor.
	test("does not carry install / uninstall surface or target file checks", async () => {
		const source = await readFile(resolve(REPO_ROOT, "src/install-commands.ts"), "utf-8")
		expect(source).not.toContain("runInstallCommand")
		expect(source).not.toContain("runUninstallCommand")
		expect(source).not.toContain("SLASH_COMMAND_FILES")
		expect(source).not.toContain("WORKFLOW_REL")
		expect(source).not.toContain("ensureWorkflowMd")
		expect(source).not.toContain(["workflow", "md"].join("."))
		expect(source).not.toContain("[Layer A]")
		await expect(Bun.file(resolve(REPO_ROOT, "templates/workflow.md")).exists()).resolves.toBe(false)
	})
})

async function makeDoctorTarget(runner?: { runner: "hapi"; binary: string }): Promise<string> {
	const dir = resolve(TEST_ROOT, `doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const loopDataRoot = resolve(dir, "loop-data")
	const presetPath = runner === undefined ? null : resolve(dir, "hapi-preset")
	await mkdir(resolve(dir, ".coder-loop"), { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "issues"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "evidence"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "runs"), { recursive: true })
	await writeFile(resolve(loopDataRoot, "chains", "doctor-chain", "shared.md"), "# Shared durable context\n\n")
	if (presetPath !== null) {
		await cp(resolve(REPO_ROOT, "presets/single-phase-example"), presetPath, { recursive: true })
		const presetToml = resolve(presetPath, "preset.toml")
		await writeFile(presetToml, (await readFile(presetToml, "utf-8")).replace('name   = "run"', 'name   = "run"\nrunner = "hapi"'))
	}
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "doctor-chain",
			preset: "single-phase-example",
			repository: "fixture/repo",
			baseBranch: "main",
			metadata: runner === undefined || presetPath === null
				? storedChainMetadata({})
				: storedChainMetadata({ presetPath, hapi: { binary: runner.binary } }),
		})
		store.createItem({
			chainId: chain.id,
			// #419: items.item_id is now the preset-declared opaque string identity (idField=`id`
			// for `single-phase-example`). The fixture writes "alpha" here so `getItemId` returns
			// the preset id directly without falling through to `extra.id`.
			itemId: "alpha",
			repoCwd: dir,
			status: runtimeStatus("pending"),
			preset: presetPath === null ? "single-phase-example" : null,
			presetPath,
			extra: storedItemExtra({ id: "alpha" }),
		})
	} finally {
		store.close()
	}
	return dir
}
