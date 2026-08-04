import {
	cp,
	daemonRequest,
	describe,
	expect,
	gitOutput,
	initGitTarget,
	loadPreset,
	mkdir,
	openSqliteStateStore,
	pathExists,
	queryObservabilityEvents,
	readFile,
	resolve,
	resolveLoopDataPaths,
	rm,
	runtimeStatus,
	sendDaemonRequest,
	startCoderLoopDaemon,
	storedChainMetadata,
	storedItemExtra,
	test,
	waitFor,
	writeFile,
	TEST_ROOT,
	REPO_ROOT,
} from "./harness"

let nextFixtureId = 0

async function forceSchedulerTick(daemon: object): Promise<void> {
	const tick = Reflect.get(daemon, "requestSchedulerTick")
	if (typeof tick !== "function") throw new Error("daemon scheduler tick entrypoint is unavailable")
	await Reflect.apply(tick, daemon, [])
}

describe("daemon pinned preset definition", () => {
	test("restart resolves H1 exactly and corrupt H1 fails closed before runner side effects", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-preset-definition-pin`)
		const loopDataRoot = resolve(root, "loop-data")
		const source = resolve(root, "authoring-source")
		const target = resolve(root, "target")
		const worktree = resolve(root, "worktree")
		const capturePath = resolve(worktree, "runner-prompt.txt")
		const runnerPath = resolve(root, "capture-runner.ts")
		const chainName = "preset-definition-pin"
		await mkdir(root, { recursive: true })
		await initGitTarget(target)
		const baseCommit = gitOutput(target, ["rev-parse", "HEAD"])
		gitOutput(target, ["worktree", "add", "-b", "definition-pin", worktree, "main"])
		await cp(resolve(REPO_ROOT, "presets/single-phase-example"), source, { recursive: true })
		await writeFile(resolve(source, "run-entry.md"), "PINNED_PROMPT=H1\n")
		await writeFile(runnerPath, `import { writeFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
await writeFile(${JSON.stringify(capturePath)}, promptIndex === -1 ? "" : Bun.argv[promptIndex + 1] ?? "")
process.exitCode = 0
`)

		const h1 = await loadPreset(source, { definitionStore: { root: loopDataRoot } })
		const h1Step = h1.tasks.children[0]
		if (h1Step === undefined) throw new Error("H1 must contain a runnable step")
		const h1DefinitionNode = h1Step.children[0]
		if (h1DefinitionNode === undefined) throw new Error("H1 step must contain a definition node")
		const persistedRef = { kind: "preset", contentIdentity: h1.definitionRef.contentIdentity } as const

		const store = openSqliteStateStore({ loopDataRoot })
		let chainId: number
		let itemRowId: number
		try {
			const chain = store.createChain({
				name: chainName,
				preset: null,
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: storedChainMetadata({ presetPath: source }),
			})
			chainId = chain.id
			const item = store.createItem({
				chainId,
				itemId: "2498-definition-pin",
				repoCwd: target,
				status: runtimeStatus("pending"),
				presetPath: source,
				extra: storedItemExtra({}),
			})
			itemRowId = item.id
			store.createTaskTree(chainId, {
				root: {
					kind: "seq",
					identity: { runtimeNodeId: "definition-pin-root", definitionRef: persistedRef, definitionNodeId: "root" },
					cursor: { kind: "next", nodeId: "definition-pin-leaf" },
					children: [{
						kind: "leaf",
						identity: { runtimeNodeId: "definition-pin-leaf", definitionRef: persistedRef, definitionNodeId: h1DefinitionNode.identity },
						closure: {
							closureId: "definition-pin-closure",
							itemRowId,
							itemId: item.itemId,
							phase: h1Step.phase,
							lifecycle: "active",
							worktreePath: worktree,
							branchName: "refs/heads/definition-pin",
							baseCommit,
							sourceParNodeId: null,
							sessions: [],
						},
					}],
				},
				activeRuns: [],
			})
		} finally {
			store.close()
		}

		const beforeRestart = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		await beforeRestart.stop()

		await writeFile(resolve(source, "run-entry.md"), "PINNED_PROMPT=H2\n")
		const h2 = await loadPreset(source, { definitionStore: { root: loopDataRoot } })
		expect(h2.definitionRef.contentIdentity).not.toBe(h1.definitionRef.contentIdentity)

		const schedulerEvents: unknown[] = []
		const scheduler = {
			enabled: true,
			intervalMs: 20,
			runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [runnerPath], model: null } as const,
			worktreeManager: async () => worktree,
			chainCompleteTriggerForChain: () => null,
			onEvent: (event: unknown) => { schedulerEvents.push(event) },
		}
		const afterRestart = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler })
		try {
			await sendDaemonRequest(afterRestart.snapshot().socketPath, daemonRequest("item.update", { itemId: itemRowId, title: "wake pinned H1" }))
			await forceSchedulerTick(afterRestart)
			await waitFor(
				async () => ({ prompt: await pathExists(capturePath) ? await readFile(capturePath, "utf8") : "", events: schedulerEvents }),
				(value) => value.prompt.includes("PINNED_PROMPT=H1") || value.events.some((event) => JSON.stringify(event).includes("spawn.aborted")),
				5_000,
			)
			const captured = await pathExists(capturePath) ? await readFile(capturePath, "utf8") : JSON.stringify(schedulerEvents)
			expect(captured).toContain("PINNED_PROMPT=H1")
			expect(captured).not.toContain("PINNED_PROMPT=H2")
			const persisted = openSqliteStateStore({ loopDataRoot })
			try {
				const tree = persisted.getTaskTree(chainId)
				expect(tree?.root.identity.definitionRef).toEqual(persistedRef)
			} finally {
				persisted.close()
			}
		} finally {
			await afterRestart.stop()
		}

		await rm(capturePath, { force: true })
		await writeFile(resolve(h1.presetDir, "run-entry.md"), "CORRUPTED_H1\n")
		const corruptRestart = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler })
		try {
			await sendDaemonRequest(corruptRestart.snapshot().socketPath, daemonRequest("item.update", { itemId: itemRowId, title: "wake corrupt H1" }))
			await forceSchedulerTick(corruptRestart)
			const failures = await waitFor(
				async () => (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot }).eventsFile, { type: "daemon.preset_load_failed" })).events,
				(events) => events.some((event) => JSON.stringify(event).includes(h1.definitionRef.contentIdentity) && JSON.stringify(event).includes("asset-digest-mismatch")),
				5_000,
			)
			expect(failures.length).toBeGreaterThan(0)
			expect(await pathExists(capturePath)).toBe(false)
		} finally {
			await corruptRestart.stop()
		}
	}, 20_000)
})
