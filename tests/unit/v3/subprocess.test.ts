import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSubprocess } from "../../../src/v3/subprocess"

const scratchRoots: string[] = []

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("runSubprocess", () => {
	test("interrupts and reaps the detached process group", async () => {
		const root = mkdtempSync(join(tmpdir(), "coder-loop-subprocess-interrupt-"))
		scratchRoots.push(root)
		const leaderFile = join(root, "leader.pid")
		const descendantFile = join(root, "descendant.pid")
		const command = `echo $$ > ${leaderFile}; trap '' TERM; /bin/sh -c 'trap "" TERM; echo $$ > ${descendantFile}; sleep 30' & wait`
		const observed = await Effect.runPromise(Effect.gen(function* () {
			const fiber = yield* Effect.fork(runSubprocess({
				executable: "/bin/sh",
				argv: ["-c", command],
				cwd: root,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				stdin: null,
				timeoutMs: 20_000,
				termGraceMs: 100,
				maxOutputBytes: 1_024,
				sandbox: { filesystem: "unrestricted", network: "none", resources: [] },
			}))
			while (!existsSync(leaderFile) || !existsSync(descendantFile)) yield* Effect.sleep("10 millis")
			const leaderPid = Number(readFileSync(leaderFile, "utf8").trim())
			const descendantPid = Number(readFileSync(descendantFile, "utf8").trim())
			const startedAt = Date.now()
			yield* Fiber.interrupt(fiber)
			return {
				elapsedMs: Date.now() - startedAt,
				leaderAlive: processIsAlive(leaderPid),
				descendantAlive: processIsAlive(descendantPid),
			}
		}))
		expect(observed.elapsedMs).toBeLessThan(2_000)
		expect(observed.leaderAlive).toBe(false)
		expect(observed.descendantAlive).toBe(false)
	}, 5_000)
})

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}
