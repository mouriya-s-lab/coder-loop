import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildLiveRuntimeHealthLines } from "./install-commands"
import { buildCoderLoopStatusSnapshot } from "./loop"
import { openSqliteStateStore } from "./sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "./runtime-data"

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

describe("install command ownership", () => {
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
})

async function makeDoctorTarget(): Promise<string> {
	const dir = resolve(TEST_ROOT, `doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const loopDataRoot = resolve(dir, "loop-data")
	await mkdir(resolve(dir, ".coder-loop"), { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "issues"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "evidence"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", "doctor-chain", "runs"), { recursive: true })
	await writeFile(resolve(loopDataRoot, "chains", "doctor-chain", "shared.md"), "# Shared durable context\n\n")
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "doctor-chain",
			preset: "single-phase-example",
			repository: "fixture/repo",
			baseBranch: "main",
		})
		store.createItem({
			chainId: chain.id,
			// #419: items.item_id is now the preset-declared opaque string identity (idField=`id`
			// for `single-phase-example`). The fixture writes "alpha" here so `getItemId` returns
			// the preset id directly without falling through to `extra.id`.
			itemId: "alpha",
			repoCwd: dir,
			status: runtimeStatus("pending"),
			extra: storedItemExtra({ id: "alpha" }),
		})
	} finally {
		store.close()
	}
	return dir
}
