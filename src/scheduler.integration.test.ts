import { afterAll, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	createSchedulerState,
	schedulerSlotWorktreePath,
	schedulerTick,
	type SchedulerEvent,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-integration-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

test("forced spawn failures over thirty scheduler seconds are capped by persisted exponential backoff", async () => {
	const root = resolve(TEST_ROOT, "forced-failure-30s")
	const loopDataRoot = resolve(root, "loop-data")
	const fakeRunner = resolve(root, "forced-failure-runner.ts")
	await mkdir(loopDataRoot, { recursive: true })
	// v1 status model: the runner exits non-zero and writes NO status of its own. The item therefore
	// stays in its continuable status (in_progress) and is re-spawned on the backoff cadence — proving
	// both "agent exits without terminal status -> continuable" and "repeated non-zero exits are capped
	// by persisted exponential backoff" without relying on any scheduler-side exit-code inference.
	await writeFile(
		fakeRunner,
		`const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
console.error("forced failure for item " + input.itemId)
process.exit(1)
`,
	)

	const store = openSqliteStateStore({ loopDataRoot })
	try {
		const chain = store.createChain({
			name: "forced-failure-30s-chain",
			preset: "gh-issue-pr-iteration",
			repository: "mouriya-s-lab/coder-loop",
			baseBranch: "main",
			status: "active",
			metadata: { maxItemAttempts: 50 },
		})
		const item = store.createItem({
			chainId: chain.id,
			issueNumber: 313_001,
			repoCwd: REPO_ROOT,
			status: "queued",
			attempts: 0,
			extra: { issueKind: "code" },
		})
		const state = createSchedulerState()
		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		let now = 1_800_040_000
		const options: SchedulerOptions = {
			store,
			state,
			presetDir: resolve(REPO_ROOT, "presets/gh-issue-pr-iteration"),
			// Drive a single explicit phase so the iteration->review trigger (covered elsewhere) does not
			// interleave un-backed-off review spawns into this backoff measurement. in_progress is declared
			// continuable here, mirroring gh-issue-pr-iteration's real `continuable` set, so the no-status
			// failing item keeps being re-selected through the pending path on each backoff window.
			phase: "iteration",
			pendingStatuses: ["queued", "in_progress"],
			runner: {
				kind: "claude",
				source: "iteration-default",
				binary: "bun",
				extraArgs: [fakeRunner],
				model: null,
			},
			worktreeManager,
			loopDataRootOptions: { loopDataRoot },
			now: () => now,
			runIdFactory: ({ item: selected }) => `run-forced-failure-${selected.id}-${now}`,
			prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: item.issueNumber, runId }),
			kindResolver: () => ({ ok: true, kind: "code" }),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		}

		let spawnCount = 0
		for (let second = 0; second < 30; second += 1) {
			now = 1_800_040_000 + second
			const tick = await schedulerTick(options)
			spawnCount += tick.spawnedRuns.length
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))
		}

		const updated = store.getItem(item.id)
		expect(spawnCount).toBeLessThanOrEqual(5)
		expect(schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === item.id)).toHaveLength(spawnCount)
		expect(updated?.attempts).toBe(spawnCount)
		expect(updated?.extra.schedulerBackoff).toMatchObject({
			failureCount: spawnCount,
			nextRunAt: 1_800_040_031,
		})
	} finally {
		store.close()
	}
})
