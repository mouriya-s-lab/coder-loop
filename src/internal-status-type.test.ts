import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/internal-status-type-tests", String(process.pid))
const RUNTIME_DATA_PATH = resolve(REPO_ROOT, "src/runtime-data.ts")

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("InternalStatus type branding", () => {
	test("rejects bare strings and accepts boundary-constructed statuses", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const negativePath = resolve(TEST_ROOT, "internal-status-negative.ts")
		const positivePath = resolve(TEST_ROOT, "internal-status-positive.ts")
		await writeFile(negativePath, `
import { type InternalStatus } from ${JSON.stringify(RUNTIME_DATA_PATH)}

const status: InternalStatus = "queued"
void status
`)
		await writeFile(positivePath, `
import { parseInternalStatus, type InternalStatus } from ${JSON.stringify(RUNTIME_DATA_PATH)}

const status: InternalStatus = parseInternalStatus("queued", "fixture.status")
void status
`)

		const rejected = await runTypeScriptNoEmit(negativePath)
		expect(rejected.code).not.toBe(0)
		expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("is not assignable to type 'InternalStatus'")

		const accepted = await runTypeScriptNoEmit(positivePath)
		expect(accepted.code).toBe(0)
	})
})

async function runTypeScriptNoEmit(path: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolveResult, reject) => {
		const child = spawn("bun", [
			"x",
			"tsc",
			"--strict",
			"--target",
			"ESNext",
			"--module",
			"ESNext",
			"--moduleResolution",
			"bundler",
			"--allowImportingTsExtensions",
			"--noEmit",
			path,
		], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] })
		const stdout: Buffer[] = []
		const stderr: Buffer[] = []
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", reject)
		child.on("close", (code) => {
			resolveResult({
				code,
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: Buffer.concat(stderr).toString("utf-8"),
			})
		})
	})
}
