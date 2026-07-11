import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { acquireRealE2eGlobalMutex } from "./real-e2e-global-mutex"

const root = resolve(import.meta.dir, "../.coder-loop/runtime/evidence/e2e-global-mutex-tests", String(process.pid))

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("real-e2e global mutex", () => {
	test("waiter enters only after the current owner releases", async () => {
		mkdirSync(root, { recursive: true })
		const owner = await acquireRealE2eGlobalMutex({ domain: "serial", lockRoot: root, onWait: () => {} })
		const waits: Array<number | null> = []
		let entered = false
		const waiterPromise = acquireRealE2eGlobalMutex({
			domain: "serial",
			lockRoot: root,
			onWait: (pid) => waits.push(pid),
		}).then((mutex) => {
			entered = true
			return mutex
		})
		await Bun.sleep(1_100)
		expect(entered).toBe(false)
		expect(waits).toEqual([process.pid])
		owner.release()
		const waiter = await waiterPromise
		expect(entered).toBe(true)
		waiter.release()
	})

	test("shlock reclaims an owner killed without releasing", async () => {
		mkdirSync(root, { recursive: true })
		const helper = resolve(root, "owner.ts")
		await Bun.write(helper, `import { acquireRealE2eGlobalMutex } from ${JSON.stringify(resolve(import.meta.dir, "real-e2e-global-mutex.ts"))};\nconst lock = await acquireRealE2eGlobalMutex({ domain: "stale", lockRoot: ${JSON.stringify(root)}, onWait: () => {} });\nconsole.log("acquired");\nawait new Promise(() => {});\n`)
		const child = Bun.spawn(["bun", helper], { stdout: "pipe", stderr: "inherit" })
		const reader = child.stdout.getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toContain("acquired")
		child.kill("SIGKILL")
		await child.exited
		const recovered = await acquireRealE2eGlobalMutex({ domain: "stale", lockRoot: root, onWait: () => {} })
		recovered.release()
	})
})
