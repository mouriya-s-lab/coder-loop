import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildCoderLoopStatusSnapshot } from "./loop"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "./runtime-data"
import { openSqliteStateStore } from "./sqlite-state"

const TEST_ROOT = resolve(import.meta.dir, "../.coder-loop/runtime/evidence/status-activity-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("status current agent activity", () => {
	test("exposes bounded line windows without session content", async () => {
		const target = resolve(TEST_ROOT, "target")
		const loopDataRoot = resolve(TEST_ROOT, "loop-data")
		const chainName = "activity-chain"
		await mkdir(target, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({ name: chainName, preset: "single-phase-example", repository: "fixture/repo", baseBranch: "main" })
			const item = store.createItem({
				chainId: chain.id,
				itemId: "activity-item",
				repoCwd: target,
				status: engineLifecycleAdmittedItemStatus(parseInternalStatus("pending", "test.status"), "test"),
				phase: "run",
				lastRunId: "run-activity",
				extra: storedItemExtra({ id: "activity-item" }),
			})
			store.recordRun({ runId: "run-activity", chainId: chain.id, itemId: item.id, phase: "run", startedAt: 100, extra: storedItemExtra({}) })
			store.setCurrentRun({ chainId: chain.id, phase: "run", runId: "run-activity", startedAt: 100, extra: storedItemExtra({ itemId: item.id }) })
		} finally {
			store.close()
		}

		const paths = resolveChainRuntimePaths(chainName, { loopDataRoot })
		await mkdir(paths.runPhaseDir("run-activity", "run"), { recursive: true })
		const nowSecond = Math.floor(Date.now() / 1000)
		await writeFile(paths.runPhaseActivityFile("run-activity", "run"), JSON.stringify({
			updatedAt: new Date(nowSecond * 1000).toISOString(),
			buckets: [
				{ second: nowSecond - 5, lines: 2 },
				{ second: nowSecond - 20, lines: 3 },
				{ second: nowSecond - 50, lines: 5 },
				{ second: nowSecond - 200, lines: 7 },
			],
		}))

		const snapshot = await buildCoderLoopStatusSnapshot({ targetCwd: target, loopDataRoot, chainName, output: "json" })
		expect(snapshot.current.activity).toMatchObject({
			path: paths.runPhaseActivityFile("run-activity", "run"),
			exists: true,
			error: null,
			windows: [
				{ seconds: 10, lines: 2 },
				{ seconds: 30, lines: 5 },
				{ seconds: 60, lines: 10 },
				{ seconds: 300, lines: 17 },
			],
		})
		expect(JSON.stringify(snapshot.current.activity)).not.toContain("session secret payload")
	})
})
