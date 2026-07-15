import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "./runtime-data"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(import.meta.dir, "loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/activity-command-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("activity CLI without daemon", () => {
	test("queries one task and all live tasks while excluding a dead current row", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `run-${Date.now()}`, "loop-data")
		await mkdir(loopDataRoot, { recursive: true })
		const live = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
		try {
			await seedCurrentRun(loopDataRoot, "activity-live", "task-a", "run-live", live.pid, [2, 3, 5, 7])
			await seedCurrentRun(loopDataRoot, "activity-dead", "task-b", "run-dead", 999_999_999, [11, 13, 17, 19])

			expect(await Bun.file(resolve(loopDataRoot, "daemon.sock")).exists()).toBe(false)

			const item = runCli(["activity", "item", "activity-live", "--issue", "task-a", "--loop-data-root", loopDataRoot, "--json"])
			expect(item.exitCode).toBe(0)
			const itemResult = JSON.parse(item.stdout) as { tasks: Array<{ chain: string; item: string; pid: number; activity: { windows: unknown[] } }> }
			expect(itemResult.tasks).toHaveLength(1)
			expect(itemResult.tasks[0]).toMatchObject({ chain: "activity-live", item: "task-a", pid: live.pid })
			expect(itemResult.tasks[0]?.activity.windows).toEqual([
				{ seconds: 10, lines: 2 },
				{ seconds: 30, lines: 5 },
				{ seconds: 60, lines: 10 },
				{ seconds: 300, lines: 17 },
			])

			const all = runCli(["activity", "all", "--loop-data-root", loopDataRoot, "--json"])
			expect(all.exitCode).toBe(0)
			const allResult = JSON.parse(all.stdout) as { tasks: Array<{ chain: string; item: string }> }
			expect(allResult.tasks).toEqual([expect.objectContaining({ chain: "activity-live", item: "task-a" })])

			const human = runCli(["activity", "all", "--loop-data-root", loopDataRoot])
			expect(human.exitCode).toBe(0)
			expect(human.stdout).toContain("CHAIN\tITEM\tPHASE\tPID\t10s\t30s\t1m\t5m\tRUN")
			expect(human.stdout).toContain("activity-live\ttask-a\trun")
			expect(human.stdout).not.toContain("activity-dead")
		} finally {
			live.kill()
			await live.exited
		}
	})
})

async function seedCurrentRun(
	loopDataRoot: string,
	chainName: string,
	itemId: string,
	runId: string,
	pid: number,
	lines: readonly [number, number, number, number],
): Promise<void> {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({ name: chainName, preset: "single-phase-example", repository: "fixture/repo", baseBranch: "main" })
		const item = store.createItem({
			chainId: chain.id,
			itemId,
			repoCwd: REPO_ROOT,
			status: engineLifecycleAdmittedItemStatus(parseInternalStatus("pending", "test.status"), "test"),
			phase: "run",
			lastRunId: runId,
			extra: storedItemExtra({ id: itemId }),
		})
		store.recordRun({ runId, chainId: chain.id, itemId: item.id, phase: "run", startedAt: Date.now() / 1000, extra: storedItemExtra({}) })
		store.setCurrentRun({ chainId: chain.id, phase: "run", runId, startedAt: Date.now() / 1000, extra: storedItemExtra({ itemId: item.id, pid, processGroupLeader: true }) })
	} finally {
		store.close()
	}

	const now = Math.floor(Date.now() / 1000)
	const paths = resolveChainRuntimePaths(chainName, { loopDataRoot })
	await mkdir(paths.runPhaseDir(runId, "run"), { recursive: true })
	await writeFile(paths.runPhaseActivityFile(runId, "run"), JSON.stringify({
		updatedAt: new Date(now * 1000).toISOString(),
		buckets: [
			{ second: now - 5, lines: lines[0] },
			{ second: now - 20, lines: lines[1] },
			{ second: now - 50, lines: lines[2] },
			{ second: now - 200, lines: lines[3] },
		],
	}))
}

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({ cmd: ["bun", LOOP_ENTRY, ...args], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
	}
}
