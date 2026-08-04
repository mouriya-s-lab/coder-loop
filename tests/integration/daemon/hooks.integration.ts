import { LOOP_ENTRY, REPO_ROOT, buildCoderLoopStatusSnapshot, chmod, describe, expect, expectOk, numberValue, openSqliteStateStore, parseHookDeclarations, pathExists, readItem, record, request, resolve, staleRecoveryRunExtra, startCoderLoopDaemon, startFixture, storedItemExtra, test, waitFor, writeFile } from "./harness"
import type { GateHookDeclaration, ObserverHookDeclaration, PresetHookPlaceholder } from "./harness"

describe("daemon", () => {
	test("hook declarations persist across all layers, reload on restart, and never execute during scheduling", async () => {
		let sentinelPath = ""
		const globalHook: ObserverHookDeclaration = { kind: "observer", point: "agent.spawn", script: "", timeoutMs: 1000 }
		const fixture = await startFixture("hook-declaration-foundation", {
			beforeStart: async ({ root, loopDataRoot }) => {
				sentinelPath = resolve(root, "hook-spawned")
				const sentinel = resolve(root, "sentinel-hook")
				await writeFile(sentinel, `#!/bin/sh\ntouch ${JSON.stringify(sentinelPath)}\n`)
				await chmod(sentinel, 0o755)
				globalHook.script = sentinel
				await writeFile(resolve(loopDataRoot, "hooks.json"), JSON.stringify({ version: 1, hooks: [globalHook] }))
			},
		})
		const gateHook: GateHookDeclaration = { kind: "gate", point: "run.pre-spawn", script: "/bin/false", timeoutMs: 1000, onFailure: "hold" }
		const presetPlaceholder: PresetHookPlaceholder = { kind: "named-gate-placeholder", name: "approval", point: "item.status-transition" }
		try {
			const loadedGlobal = parseHookDeclarations(Reflect.get(fixture.daemon, "globalHookDeclarations"), "daemon.globalHooks")
			expect(loadedGlobal).toEqual([globalHook])
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "hook-declaration-foundation-chain",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { hooks: [gateHook] },
			})).chain)
			const chainId = numberValue(chain.id)
			expect(record(chain.metadata).hooks).toEqual([gateHook])
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId, itemId: "58601", repoCwd: REPO_ROOT, extra: { hooks: [globalHook], writeStatus: "done" },
			})).item)
			const batch = record(expectOk(await request(fixture, "item.batchAdd", {
				chainId,
				items: [{ itemId: "58602", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", extra: { hooks: [globalHook] } }],
			})))
			expect(Array.isArray(batch.items) ? record(batch.items[0]).extra : null).toMatchObject({ hooks: [globalHook] })
			const rowId = numberValue(item.id)
			expect(fixture.daemon.effectiveHookViewForItem(chainId, rowId, [presetPlaceholder])).toEqual([
				{ source: "global", declaration: globalHook },
				{ source: "chain", declaration: gateHook },
				{ source: "preset", declaration: presetPlaceholder },
				{ source: "item", declaration: globalHook },
			])
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 58601), (candidate) => candidate?.status === "done")
			const terminal = await readItem(fixture.loopDataRoot, chainId, 58601)
			expect(terminal?.extra.hooks).toEqual([globalHook])
			expect(await pathExists(sentinelPath)).toBe(false)
			expect(rowId).toBeGreaterThan(0)
			await fixture.daemon.stop()
			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, scheduler: { enabled: false } })
			try {
				expect(parseHookDeclarations(Reflect.get(restarted, "globalHookDeclarations"), "daemon.globalHooks")).toEqual([globalHook])
				const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
				try {
					expect(store.getChain(chainId)?.metadata.hooks).toEqual([gateHook])
					expect(store.getItem(rowId)?.extra.hooks).toEqual([globalHook])
				} finally { store.close() }
			} finally { await restarted.stop() }
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("persisted item hooks feed the effective view without entering status item or run surfaces", async () => {
		const chainName = "hook-status-projection-boundary-chain"
		const fixture = await startFixture("hook-status-projection-boundary", { schedulerEnabled: false })
		const itemHook: ObserverHookDeclaration = {
			kind: "observer",
			point: "agent.spawn",
			script: "/bin/true",
			timeoutMs: 1000,
		}
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "58603",
				repoCwd: REPO_ROOT,
				extra: { hooks: [itemHook], visibleItemField: "item-visible" },
			})).item)
			const itemRowId = numberValue(item.id)
			expect(fixture.daemon.effectiveHookViewForItem(chainId, itemRowId, [])).toEqual([
				{ source: "item", declaration: itemHook },
			])

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				expect(store.getItem(itemRowId)?.extra.hooks).toEqual([itemHook])
				store.recordRun({
					runId: "run-hook-status-projection-boundary",
					chainId,
					itemId: itemRowId,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT, { hooks: [itemHook], visibleRecordedRunField: "recorded-run-visible" }),
				})
				store.setCurrentRun({
					chainId,
					phase: "iteration",
					runId: "run-hook-status-projection-boundary",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({
						itemId: itemRowId,
						hooks: [itemHook],
						visibleCurrentRunField: "current-run-visible",
					}),
				})
			} finally {
				store.close()
			}

			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				output: "json",
			})
			expect(snapshot.queue.selected?.item.extra.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(snapshot.queue.selected?.item.extra ?? {}, "hooks")).toBe(false)
			expect(snapshot.current.item?.extra.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(snapshot.current.item?.extra ?? {}, "hooks")).toBe(false)
			expect(snapshot.current.run?.extra.visibleCurrentRunField).toBe("current-run-visible")
			expect(Object.hasOwn(snapshot.current.run?.extra ?? {}, "hooks")).toBe(false)

			const cli = Bun.spawn({
				cmd: [
					"bun",
					LOOP_ENTRY,
					"status",
					REPO_ROOT,
					"--chain",
					chainName,
					"--loop-data-root",
					fixture.loopDataRoot,
					"--json",
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CODER_LOOP_RUN_CRED: undefined, CODER_LOOP_DATA_DIR: fixture.loopDataRoot },
			})
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			])
			expect(exitCode, stderr).toBe(0)
			const payload = record(JSON.parse(stdout))
			const queueItem = record(record(record(payload.queue).selected).item)
			const current = record(payload.current)
			const currentItem = record(current.item)
			const currentRun = record(current.run)
			expect(queueItem.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(queueItem, "hooks")).toBe(false)
			expect(currentItem.visibleItemField).toBe("item-visible")
			expect(Object.hasOwn(currentItem, "hooks")).toBe(false)
			expect(currentRun.visibleCurrentRunField).toBe("current-run-visible")
			expect(Object.hasOwn(currentRun, "hooks")).toBe(false)
		} finally {
			await fixture.daemon.stop()
		}
	})
})
