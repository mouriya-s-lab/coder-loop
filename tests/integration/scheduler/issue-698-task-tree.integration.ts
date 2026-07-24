import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { sendDaemonRequest, type DaemonResponse } from "../../../src/daemon"
import type {
	TaskLeafNodeSnapshot,
	TaskNodeIdentity,
	TaskNodeSnapshot,
	TaskParNodeSnapshot,
	TaskSeqNodeSnapshot,
} from "../../../src/task-runtime"
import type {
	ChainRecord,
	CommitTaskTransitionInput,
	ItemRecord,
	SqliteStateStore,
} from "../../../src/sqlite-state"
import {
	REPO_ROOT,
	createChain,
	createFixture,
	createItem,
	fixtureTransitionRunId,
	gitOutput,
	initGitTarget,
	itemExtraToJsonObject,
	listActiveRuns,
	loadedPresetFromDir,
	maxConcurrentRunnerEvents,
	queryObservabilityEvents,
	readRunnerEvents,
	resolveLoopDataPaths,
	runtimeStatus,
	schedulerTick,
	startCoderLoopDaemon,
	stopFixture,
	storedItemExtra,
	type Fixture,
	type JsonObject,
} from "./harness"

type TreeContext = {
	chain: ChainRecord
	item: ItemRecord
	baseCommit: string
}

let transitionTimestamp = 1_900_698_000

function chainTaskRootId(chain: ChainRecord): string {
	return `chain:${chain.id}:tasks`
}

function runtimeNodeId(context: TreeContext, declarationId: string): string {
	return `task:${context.chain.id}:item:${context.item.id}:${declarationId}`
}

function nodeIdentity(context: TreeContext, declarationId: string): TaskNodeIdentity {
	return {
		runtimeNodeId: runtimeNodeId(context, declarationId),
		definitionRef: {
			kind: "preset",
			contentIdentity: `sha256:issue-698-${context.chain.id}-${context.item.id}`,
		},
		definitionNodeId: declarationId,
	}
}

function leafNode(
	context: TreeContext,
	declarationId: string,
	phase: string,
	sourceParNodeId: string,
): TaskLeafNodeSnapshot {
	const identity = nodeIdentity(context, declarationId)
	return {
		kind: "leaf",
		identity,
		state: "pending",
		closure: {
			closureId: `closure:${context.chain.id}:${context.item.id}:${declarationId}`,
			itemRowId: context.item.id,
			itemId: context.item.itemId,
			phase,
			lifecycle: "active",
			worktreePath: context.item.repoCwd,
			branchName: `issue-698/${context.chain.id}/${context.item.id}/${declarationId}`,
			baseCommit: context.baseCommit,
			sourceParNodeId,
			sessions: [],
		},
	}
}

function seqNode(
	context: TreeContext,
	declarationId: string,
	children: readonly TaskNodeSnapshot[],
): TaskSeqNodeSnapshot {
	const first = children[0]
	if (first === undefined) throw new Error(`test seq ${declarationId} requires a child`)
	return {
		kind: "seq",
		identity: nodeIdentity(context, declarationId),
		cursor: { kind: "next", nodeId: first.identity.runtimeNodeId },
		children,
	}
}

function parNode(
	context: TreeContext,
	declarationId: string,
	children: readonly TaskNodeSnapshot[],
	maxConcurrency: number | null = null,
): TaskParNodeSnapshot {
	const identity = nodeIdentity(context, declarationId)
	return {
		kind: "par",
		identity,
		groupId: identity.runtimeNodeId,
		pinCommit: context.baseCommit,
		maxConcurrency,
		state: "open",
		reopen: { count: 0, budgetRef: `task.${declarationId}.reopenBudget:0` },
		join: {
			currentVersion: 1,
			value: { kind: "drain" },
			evaluation: { kind: "not-evaluating" },
		},
		children,
	}
}

function appendSingleLeafItem(
	store: SqliteStateStore,
	chain: ChainRecord,
	item: ItemRecord,
	declarationId = "only",
): TaskLeafNodeSnapshot {
	const context: TreeContext = { chain, item, baseCommit: "0123456789abcdef0123456789abcdef01234567" }
	const leaf = leafNode(context, declarationId, "iteration", chainTaskRootId(chain))
	store.appendItemTaskTree(chain.id, seqNode(context, "root", [leaf]))
	return leaf
}

function collectTaskLeaves(node: TaskNodeSnapshot): TaskLeafNodeSnapshot[] {
	if (node.kind === "leaf") return [node]
	return node.children.flatMap(collectTaskLeaves)
}

function findNode(node: TaskNodeSnapshot, wantedId: string): TaskNodeSnapshot | null {
	if (node.identity.runtimeNodeId === wantedId) return node
	if (node.kind === "leaf") return null
	for (const child of node.children) {
		const found = findNode(child, wantedId)
		if (found !== null) return found
	}
	return null
}

function requireTree(store: SqliteStateStore, chainId: number): TaskNodeSnapshot {
	const tree = store.getTaskTree(chainId)
	if (tree === null) throw new Error(`chain ${chainId} has no task tree`)
	return tree.root
}

function requireLeaf(store: SqliteStateStore, chainId: number, nodeId: string): TaskLeafNodeSnapshot {
	const node = findNode(requireTree(store, chainId), nodeId)
	if (node === null || node.kind !== "leaf") throw new Error(`task leaf ${nodeId} was not found`)
	return node
}

function requireSeq(store: SqliteStateStore, chainId: number, nodeId: string): TaskSeqNodeSnapshot {
	const node = findNode(requireTree(store, chainId), nodeId)
	if (node === null || node.kind !== "seq") throw new Error(`task seq ${nodeId} was not found`)
	return node
}

function requirePar(store: SqliteStateStore, chainId: number, nodeId: string): TaskParNodeSnapshot {
	const node = findNode(requireTree(store, chainId), nodeId)
	if (node === null || node.kind !== "par") throw new Error(`task par ${nodeId} was not found`)
	return node
}

function commitLeaf(
	store: SqliteStateStore,
	chainId: number,
	sourceRuntimeNodeId: string,
	targetRuntimeNodeId: string | null,
	pathId: string,
	itemUpdate: CommitTaskTransitionInput["itemUpdate"] = { kind: "none" },
): void {
	const source = requireLeaf(store, chainId, sourceRuntimeNodeId)
	store.commitTaskTransition({
		sourceRunId: fixtureTransitionRunId(store, chainId, source.closure.itemRowId, source.closure.phase),
		sourceClosureId: source.closure.closureId,
		targetRuntimeNodeId,
		pathId,
		exitPayload: {},
		resolvedBindings: {},
		createdAt: transitionTimestamp++,
		itemUpdate,
	})
}

async function daemonRequest(
	fixture: Fixture,
	command: string,
	args: JsonObject,
): Promise<DaemonResponse> {
	const daemon = fixture.daemon
	if (daemon === undefined) throw new Error("scheduler fixture daemon is unavailable")
	return await sendDaemonRequest(daemon.snapshot().socketPath, {
		id: `issue-698-${command}-${transitionTimestamp++}`,
		command,
		args,
	})
}

function daemonItemRowId(response: DaemonResponse): number {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	const rawItem = response.result.item
	if (rawItem === null || Array.isArray(rawItem) || typeof rawItem !== "object") {
		throw new Error("daemon item response has no item object")
	}
	const id = rawItem.id
	if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
		throw new Error("daemon item response has no positive row id")
	}
	return id
}

function spawnedRunPhases(
	store: SqliteStateStore,
	runs: readonly { runId: string }[],
): string[] {
	return runs.map(({ runId }) => {
		const run = store.getRunByRunId(runId)
		if (run === null) throw new Error(`spawned run ${runId} was not persisted`)
		return run.phase
	})
}

async function writePhasePreset(
	fixture: Fixture,
	name: string,
	phases: readonly string[],
): Promise<Awaited<ReturnType<typeof loadedPresetFromDir>>> {
	const presetDir = resolve(fixture.loopDataRoot, "..", name)
	await mkdir(presetDir, { recursive: true })
	for (const phase of phases) {
		await writeFile(resolve(presetDir, `${phase}.md`), `${phase} phase\n`)
	}
	const declarations = phases
		.map((phase) => `[[phases]]
name = "${phase}"
prompt = "${phase}.md"
runner = "claude"
[[phases.exits]]
status = "done"
when = "the integration fixture commits the task leaf"
[phases.variables]
LOG_DIR = "runtime.logDir"
`)
		.join("\n")
	await writeFile(resolve(presetDir, "preset.toml"), `name = "${name}"
[item]
idField = "issue"
[item.fields]
issue = "string"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
${declarations}
`)
	return await loadedPresetFromDir(presetDir)
}

describe("issue #698 recursive task-tree scheduler integration", () => {
	test("public item creation fetches and pins an origin-tracking-only base before persisting the tree", async () => {
		const fixture = await createFixture("issue-698-public-origin-pin")
		try {
			const root = resolve(fixture.loopDataRoot, "..", "origin-pin")
			const origin = resolve(root, "origin.git")
			const seed = resolve(root, "seed")
			const repository = resolve(root, "repository")
			await mkdir(seed, { recursive: true })
			gitOutput(root, ["init", "-q", "--bare", origin])
			gitOutput(seed, ["init", "-q", "-b", "main"])
			gitOutput(seed, ["config", "user.email", "issue-698@example.invalid"])
			gitOutput(seed, ["config", "user.name", "Issue 698"])
			await writeFile(resolve(seed, "README.md"), "first\n")
			gitOutput(seed, ["add", "README.md"])
			gitOutput(seed, ["commit", "-qm", "first"])
			gitOutput(seed, ["remote", "add", "origin", origin])
			gitOutput(seed, ["push", "-q", "-u", "origin", "main"])
			gitOutput(origin, ["symbolic-ref", "HEAD", "refs/heads/main"])
			gitOutput(root, ["clone", "-q", origin, repository])
			const staleCommit = gitOutput(repository, ["rev-parse", "refs/remotes/origin/main"])
			const detachedCommit = gitOutput(repository, ["rev-parse", "HEAD"])
			gitOutput(repository, ["checkout", "-q", "--detach", detachedCommit])
			gitOutput(repository, ["branch", "-D", "main"])

			await writeFile(resolve(seed, "README.md"), "second\n")
			gitOutput(seed, ["add", "README.md"])
			gitOutput(seed, ["commit", "-qm", "second"])
			gitOutput(seed, ["push", "-q", "origin", "main"])
			const expectedCommit = gitOutput(seed, ["rev-parse", "HEAD"])
			expect(expectedCommit).not.toBe(staleCommit)
			expect(gitOutput(repository, ["rev-parse", "refs/remotes/origin/main"])).toBe(staleCommit)

			const presetDir = resolve(fixture.loopDataRoot, "..", "issue-698-public-origin-pin-preset")
			await mkdir(presetDir, { recursive: true })
			await writeFile(resolve(presetDir, "work.md"), "work phase\n")
			await writeFile(resolve(presetDir, "other.md"), "other phase\n")
			await writeFile(resolve(presetDir, "preset.toml"), `name = "issue-698-public-origin-pin-preset"
[item]
idField = "issue"
[item.fields]
issue = "string"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
[[phases]]
name = "work"
prompt = "work.md"
runner = "claude"
[[phases.exits]]
status = "done"
when = "the fixture commits the typed task path"
[[phases]]
name = "other"
prompt = "other.md"
runner = "claude"
[[phases.exits]]
status = "done"
when = "the fixture verifies wrong-phase discovery rejection"
[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "first-work", kind = "phase", phase = "work", paths = [{ id = "first-path", target = "second-other" }] },
  { id = "second-other", kind = "phase", phase = "other", paths = [{ id = "second-path" }] }
]
`)
			const loadedPreset = await loadedPresetFromDir(presetDir)
			const createdChain = await daemonRequest(fixture, "chain.create", {
				name: "issue-698-public-origin-pin-chain",
				repository: "fixture/issue-698",
				baseBranch: "main",
			})
			if (!createdChain.ok) throw new Error(`${createdChain.error.code}: ${createdChain.error.message}`)
			const chainPayload = createdChain.result.chain
			if (chainPayload === null || Array.isArray(chainPayload) || typeof chainPayload !== "object" || typeof chainPayload.id !== "number") {
				throw new Error("public chain.create response omitted its row id")
			}
			const createdItem = await daemonRequest(fixture, "item.add", {
				chainId: chainPayload.id,
				itemId: "origin-pin-item",
				repoCwd: repository,
				presetPath: loadedPreset.presetDir,
			})
			if (!createdItem.ok) throw new Error(`${createdItem.error.code}: ${createdItem.error.message}`)

			const tree = fixture.store.getTaskTree(chainPayload.id)
			if (tree === null) throw new Error("public item.add did not persist its runtime tree")
			const persistedLeaves = tree.root.kind === "leaf"
				? [tree.root]
				: collectTaskLeaves(tree.root)
			expect(persistedLeaves).toHaveLength(2)
			expect(persistedLeaves.every((leaf) => leaf.closure.baseCommit === expectedCommit)).toBe(true)
			expect(tree.root.kind).toBe("par")
			if (tree.root.kind === "par") expect(tree.root.pinCommit).toBe(expectedCommit)
			expect(gitOutput(repository, ["rev-parse", "refs/remotes/origin/main"])).toBe(expectedCommit)

			const itemRowId = daemonItemRowId(createdItem)
			const firstLeaf = persistedLeaves.find((leaf) => leaf.identity.definitionNodeId === "first-work")
			const secondLeaf = persistedLeaves.find((leaf) => leaf.identity.definitionNodeId === "second-other")
			if (firstLeaf === undefined || secondLeaf === undefined) throw new Error("public runtime tree lost phase definition identities")
			const firstRun = fixture.store.recordRun({
				runId: "issue-698-first-work-run",
				chainId: chainPayload.id,
				itemId: itemRowId,
				phase: "work",
				startedAt: transitionTimestamp++,
				extra: storedItemExtra({}),
			})
			expect(firstRun.runtimeNodeId).toBe(firstLeaf.identity.runtimeNodeId)
			fixture.store.commitTaskTransition({
				sourceRunId: firstRun.runId,
				sourceClosureId: firstLeaf.closure.closureId,
				targetRuntimeNodeId: secondLeaf.identity.runtimeNodeId,
				pathId: "first-path",
				exitPayload: {},
				resolvedBindings: {},
				createdAt: transitionTimestamp++,
				itemUpdate: { kind: "none" },
			})
			const secondRun = fixture.store.recordRun({
				runId: "issue-698-second-other-run",
				chainId: chainPayload.id,
				itemId: itemRowId,
				phase: "other",
				startedAt: transitionTimestamp++,
				extra: storedItemExtra({}),
			})
			expect(secondRun.runtimeNodeId).toBe(secondLeaf.identity.runtimeNodeId)

			const exits = await daemonRequest(fixture, "item.exits", {
				itemId: itemRowId,
				agentRunId: secondRun.runId,
				agentPhase: "other",
			})
			if (!exits.ok) throw new Error(`${exits.error.code}: ${exits.error.message}`)
			const advertised = Array.isArray(exits.result.exits)
				? exits.result.exits.flatMap((entry) =>
					entry !== null && !Array.isArray(entry) && typeof entry === "object" && entry.kind === "task-path"
						? [entry.path]
						: [],
				)
				: []
			expect(advertised).toEqual(["second-path"])
			const wrongPhase = await daemonRequest(fixture, "item.exits", {
				itemId: itemRowId,
				agentRunId: secondRun.runId,
				agentPhase: "work",
			})
			expect(wrongPhase.ok).toBe(false)
			if (!wrongPhase.ok) expect(wrongPhase.error.code).toBe("invalid_caller")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("public creation records item.created before the resumed scheduler can persist agent.spawn", async () => {
		const root = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests", String(process.pid), `issue-698-created-before-spawn-${Date.now()}`)
		const loopDataRoot = resolve(root, "loop-data")
		const repository = resolve(root, "repository")
		const presetDir = resolve(root, "preset")
		const runner = resolve(root, "held-runner.ts")
		await initGitTarget(repository)
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(presetDir, "work.md"), "work phase\n")
		await writeFile(resolve(presetDir, "preset.toml"), `name = "issue-698-created-before-spawn"
[item]
idField = "issue"
[item.fields]
issue = "string"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
[[phases]]
name = "work"
prompt = "work.md"
runner = "claude"
[[phases.exits]]
status = "done"
when = "the fixture releases the held runner"
`)
		await writeFile(runner, "await new Promise((resolve) => setTimeout(resolve, 10_000))\n")

		const spawned = Promise.withResolvers<void>()
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 60_000,
				presetDir,
				runner: {
					kind: "claude",
					source: "iteration-default",
					binary: "bun",
					extraArgs: [runner],
					model: null,
				},
				worktreeManager: async () => repository,
				prompt: () => "created-before-spawn",
				chainCompleteTriggerForChain: () => null,
				onEvent: (event) => {
					if (event.type === "agent.spawn") spawned.resolve()
				},
			},
		})
		try {
			const chainName = "issue-698-created-before-spawn-chain"
			const createdChain = await sendDaemonRequest(daemon.snapshot().socketPath, {
				id: "issue-698-created-before-spawn-chain",
				command: "chain.create",
				args: {
					name: chainName,
					repository: "fixture/issue-698",
					baseBranch: "main",
				},
			})
			if (!createdChain.ok) throw new Error(`${createdChain.error.code}: ${createdChain.error.message}`)
			const chain = createdChain.result.chain
			if (chain === null || Array.isArray(chain) || typeof chain !== "object" || typeof chain.id !== "number") {
				throw new Error("public chain.create response omitted its row id")
			}
			const createdItem = await sendDaemonRequest(daemon.snapshot().socketPath, {
				id: "issue-698-created-before-spawn-item",
				command: "item.add",
				args: {
					chainId: chain.id,
					itemId: "created-before-spawn",
					repoCwd: repository,
					presetPath: presetDir,
				},
			})
			const itemRowId = daemonItemRowId(createdItem)
			await Promise.race([
				spawned.promise,
				Bun.sleep(5_000).then(() => {
					throw new Error("timed out waiting for the resumed scheduler to spawn the created item")
				}),
			])

			const events = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot }).eventsFile,
				{ chain: chainName, item: itemRowId },
			)
			const types = events.events.map((event) => event.type)
			const createdIndex = types.indexOf("item.created")
			const spawnIndex = types.indexOf("agent.spawn")
			expect(createdIndex).toBeGreaterThanOrEqual(0)
			expect(spawnIndex).toBeGreaterThan(createdIndex)
		} finally {
			await daemon.stop()
		}
	})

	test("committed transition is atomic and idempotent, while runner exit and naked status cannot advance seq", async () => {
		const fixture = await createFixture("issue-698-transition")
		try {
			const chain = createChain(fixture.store, "issue-698-transition-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 698_001,
				repoCwd: "/repo/issue-698-transition",
				writeStatus: null,
				taskPhases: null,
			})
			const context: TreeContext = {
				chain,
				item,
				baseCommit: "1111111111111111111111111111111111111111",
			}
			const first = leafNode(context, "a", "iteration", chainTaskRootId(chain))
			const second = leafNode(context, "b", "review", chainTaskRootId(chain))
			const itemRoot = seqNode(context, "root", [first, second])
			fixture.store.appendItemTaskTree(chain.id, itemRoot)

			const firstTick = await schedulerTick(fixture.options())
			expect(spawnedRunPhases(fixture.store, firstTick.spawnedRuns)).toEqual(["iteration"])
			await firstTick.spawnedRuns[0]!.closed

			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: first.identity.runtimeNodeId,
			})
			expect(fixture.store.listTaskTransitions(chain.id)).toEqual([])

			const nakedTerminal = await daemonRequest(fixture, "item.update", {
				itemId: item.id,
				status: "done",
			})
			expect(nakedTerminal.ok).toBe(true)
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: first.identity.runtimeNodeId,
			})
			expect(fixture.store.listTaskTransitions(chain.id)).toEqual([])
			expect((await schedulerTick(fixture.options())).spawnedRuns).toHaveLength(0)

			const restored = fixture.store.updateItem(item.id, {
				status: runtimeStatus("queued"),
				updatedAt: transitionTimestamp++,
			})
			expect(restored.status).toBe("queued")

			expect(() => commitLeaf(
				fixture.store,
				chain.id,
				first.identity.runtimeNodeId,
				null,
				"wrong-target",
			)).toThrow("not the structural successor")
			expect(requireLeaf(fixture.store, chain.id, first.identity.runtimeNodeId).state).toBe("pending")
			expect(fixture.store.listTaskTransitions(chain.id)).toEqual([])

			expect(() => commitLeaf(
				fixture.store,
				chain.id,
				first.identity.runtimeNodeId,
				second.identity.runtimeNodeId,
				"rollback-owner-mismatch",
				{
					kind: "always",
					itemId: item.id + 100_000,
					update: { status: runtimeStatus("done"), updatedAt: transitionTimestamp++ },
				},
			)).toThrow("does not own source closure")
			expect(requireLeaf(fixture.store, chain.id, first.identity.runtimeNodeId).state).toBe("pending")
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: first.identity.runtimeNodeId,
			})
			expect(fixture.store.listTaskTransitions(chain.id)).toEqual([])

			commitLeaf(
				fixture.store,
				chain.id,
				first.identity.runtimeNodeId,
				second.identity.runtimeNodeId,
				"advance",
			)
			expect(requireLeaf(fixture.store, chain.id, first.identity.runtimeNodeId).state).toBe("completed")
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: second.identity.runtimeNodeId,
			})
			expect(fixture.store.listTaskTransitions(chain.id).map((transition) => transition.pathId)).toEqual(["advance"])

			expect(() => commitLeaf(
				fixture.store,
				chain.id,
				first.identity.runtimeNodeId,
				second.identity.runtimeNodeId,
				"advance",
			)).toThrow("already transitioned")
			expect(fixture.store.listTaskTransitions(chain.id).map((transition) => transition.pathId)).toEqual(["advance"])

			const successorTick = await schedulerTick(fixture.options())
			expect(spawnedRunPhases(fixture.store, successorTick.spawnedRuns)).toEqual(["review"])
			await successorTick.spawnedRuns[0]!.closed
			commitLeaf(
				fixture.store,
				chain.id,
				second.identity.runtimeNodeId,
				null,
				"finish",
				{
					kind: "when-task-terminal",
					itemId: item.id,
					update: { status: runtimeStatus("done"), phase: "review", updatedAt: transitionTimestamp++ },
				},
			)
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({ kind: "complete" })
		} finally {
			await stopFixture(fixture)
		}
	})

	test("nested seq/par readiness opens same-repository leaves concurrently and drain advances only after every member", async () => {
		const fixture = await createFixture("issue-698-recursive-drain")
		try {
			const loadedPreset = await writePhasePreset(
				fixture,
				"issue-698-recursive-drain-preset",
				["a", "b", "c", "d", "e"],
			)
			const chain = createChain(fixture.store, "issue-698-recursive-drain-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 698_002,
				repoCwd: "/repo/issue-698-shared",
				sleepMs: 60,
				writeStatus: null,
				taskPhases: null,
			})
			const context: TreeContext = {
				chain,
				item,
				baseCommit: "2222222222222222222222222222222222222222",
			}
			const outerId = runtimeNodeId(context, "outer")
			const innerId = runtimeNodeId(context, "inner")
			const first = leafNode(context, "a", "a", chainTaskRootId(chain))
			const direct = leafNode(context, "b", "b", outerId)
			const nestedOne = leafNode(context, "c", "c", innerId)
			const nestedTwo = leafNode(context, "d", "d", innerId)
			const inner = parNode(context, "inner", [nestedOne, nestedTwo])
			const outer = parNode(context, "outer", [direct, inner])
			const final = leafNode(context, "e", "e", chainTaskRootId(chain))
			const itemRoot = seqNode(context, "root", [first, outer, final])
			fixture.store.appendItemTaskTree(chain.id, itemRoot)
			const options = fixture.options({ loadedPreset })

			const entryTick = await schedulerTick(options)
			expect(spawnedRunPhases(fixture.store, entryTick.spawnedRuns)).toEqual(["a"])
			await entryTick.spawnedRuns[0]!.closed
			commitLeaf(
				fixture.store,
				chain.id,
				first.identity.runtimeNodeId,
				outer.identity.runtimeNodeId,
				"enter-par",
			)
			fixture.store.updateItem(item.id, {
				extra: storedItemExtra({
					...itemExtraToJsonObject(item.extra),
					waitForConcurrentStarts: 3,
				}),
				updatedAt: transitionTimestamp++,
			})

			const parTick = await schedulerTick(options)
			expect(parTick.spawnedRuns).toHaveLength(3)
			expect(spawnedRunPhases(fixture.store, parTick.spawnedRuns).sort()).toEqual(["b", "c", "d"])
			expect(new Set(parTick.spawnedRuns.map((run) => run.itemId))).toEqual(new Set([item.id]))
			expect(new Set(parTick.spawnedRuns.map((run) => run.worktreePath)).size).toBe(3)
			expect(listActiveRuns(fixture.state)).toHaveLength(3)
			await Promise.all(parTick.spawnedRuns.map((run) => run.closed))
			const afterParRuns = fixture.store.getItem(item.id)
			if (afterParRuns === null) throw new Error(`item ${item.id} disappeared after parallel runs`)
			const finalPhaseExtra = itemExtraToJsonObject(afterParRuns.extra)
			delete finalPhaseExtra.waitForConcurrentStarts
			fixture.store.updateItem(item.id, {
				extra: storedItemExtra(finalPhaseExtra),
				updatedAt: transitionTimestamp++,
			})

			const events = await readRunnerEvents(fixture.eventLogForChain(chain.name))
			expect(maxConcurrentRunnerEvents(events)).toBe(3)

			commitLeaf(fixture.store, chain.id, direct.identity.runtimeNodeId, null, "finish-b")
			expect(requirePar(fixture.store, chain.id, outer.identity.runtimeNodeId).state).toBe("open")
			expect(requirePar(fixture.store, chain.id, inner.identity.runtimeNodeId).state).toBe("open")
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: outer.identity.runtimeNodeId,
			})

			commitLeaf(fixture.store, chain.id, nestedOne.identity.runtimeNodeId, null, "finish-c")
			expect(requirePar(fixture.store, chain.id, inner.identity.runtimeNodeId).state).toBe("open")
			expect(requirePar(fixture.store, chain.id, outer.identity.runtimeNodeId).state).toBe("open")

			commitLeaf(fixture.store, chain.id, nestedTwo.identity.runtimeNodeId, null, "finish-d")
			expect(requirePar(fixture.store, chain.id, inner.identity.runtimeNodeId).state).toBe("completed")
			expect(requirePar(fixture.store, chain.id, outer.identity.runtimeNodeId).state).toBe("completed")
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({
				kind: "next",
				nodeId: final.identity.runtimeNodeId,
			})

			const finalTick = await schedulerTick(options)
			expect(spawnedRunPhases(fixture.store, finalTick.spawnedRuns)).toEqual(["e"])
			await finalTick.spawnedRuns[0]!.closed
			commitLeaf(
				fixture.store,
				chain.id,
				final.identity.runtimeNodeId,
				null,
				"finish-e",
					{
						kind: "when-task-terminal",
						itemId: item.id,
						update: { status: runtimeStatus("done"), phase: "e", updatedAt: transitionTimestamp++ },
					},
			)
			expect(requireSeq(fixture.store, chain.id, itemRoot.identity.runtimeNodeId).cursor).toEqual({ kind: "complete" })
			expect(requirePar(fixture.store, chain.id, chainTaskRootId(chain)).state).toBe("completed")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("per-par limit caps live closures, audits duplicate denial, and releases the remaining member", async () => {
		const fixture = await createFixture("issue-698-par-limit")
		try {
			const loadedPreset = await writePhasePreset(
				fixture,
				"issue-698-par-limit-preset",
				["a", "b", "c"],
			)
			const chain = createChain(fixture.store, "issue-698-par-limit-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 698_003,
				repoCwd: "/repo/issue-698-par-limit",
				sleepMs: 80,
				waitForConcurrentStarts: 2,
				writeStatus: null,
				taskPhases: null,
			})
			const context: TreeContext = {
				chain,
				item,
				baseCommit: "3333333333333333333333333333333333333333",
			}
			const rootId = runtimeNodeId(context, "limited")
			const first = leafNode(context, "one", "a", rootId)
			const second = leafNode(context, "two", "b", rootId)
			const third = leafNode(context, "three", "c", rootId)
			const limited = parNode(context, "limited", [first, second, third], 2)
			fixture.store.appendItemTaskTree(chain.id, limited)
			const options = fixture.options({ loadedPreset })

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(2)
			expect(spawnedRunPhases(fixture.store, firstTick.spawnedRuns)).toEqual(["a", "b"])
			expect(listActiveRuns(fixture.state)).toHaveLength(2)
			expect(fixture.store.listCurrentRuns(chain.id)).toHaveLength(2)
			expect(new Set(fixture.store.listCurrentRuns(chain.id).map((run) => run.runId)).size).toBe(2)

			const whileLive = await schedulerTick(options)
			expect(whileLive.spawnedRuns).toHaveLength(0)
			const denials = fixture.schedulerEvents.filter((event) => event.type === "closure.dispatch_denied")
			expect(denials).toHaveLength(2)
			expect(new Set(denials.map((event) => `${event.closureId}:${event.runtimeNodeId}:${event.runId}`)).size).toBe(2)

			await Promise.all(firstTick.spawnedRuns.map((run) => run.closed))
			commitLeaf(fixture.store, chain.id, first.identity.runtimeNodeId, null, "finish-one")
			commitLeaf(fixture.store, chain.id, second.identity.runtimeNodeId, null, "finish-two")
			expect(requirePar(fixture.store, chain.id, limited.identity.runtimeNodeId).state).toBe("open")

			const released = await schedulerTick(options)
			expect(released.spawnedRuns).toHaveLength(1)
			expect(spawnedRunPhases(fixture.store, released.spawnedRuns)).toEqual(["c"])
			await released.spawnedRuns[0]!.closed
			commitLeaf(
				fixture.store,
				chain.id,
				third.identity.runtimeNodeId,
				null,
				"finish-three",
					{
						kind: "when-task-terminal",
						itemId: item.id,
						update: { status: runtimeStatus("done"), phase: "c", updatedAt: transitionTimestamp++ },
					},
			)
			expect(requirePar(fixture.store, chain.id, limited.identity.runtimeNodeId).state).toBe("completed")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("declared daemon-global limit counts a stopped chain's durable run, while no declaration adds no engine cap", async () => {
		const limited = await createFixture("issue-698-global-limit")
		try {
			const limitedBindings = {
				umbrellaIssue: 698,
				umbrellaRepo: "mouriya-s-lab/coder-loop",
				maxConcurrency: 1,
			}
			const firstChain = createChain(limited.store, "issue-698-global-limit-a", {
				metadata: { bindings: limitedBindings },
			})
			const secondChain = createChain(limited.store, "issue-698-global-limit-b", {
				metadata: { bindings: limitedBindings },
			})
			const firstItem = createItem(limited.store, firstChain, {
				issueNumber: 698_004,
				repoCwd: "/repo/issue-698-global",
				sleepMs: 200,
				writeStatus: null,
				taskPhases: null,
			})
			const secondItem = createItem(limited.store, secondChain, {
				issueNumber: 698_005,
				repoCwd: "/repo/issue-698-global",
				sleepMs: 80,
				writeStatus: null,
				taskPhases: null,
			})
			const firstLeaf = appendSingleLeafItem(limited.store, firstChain, firstItem)
			appendSingleLeafItem(limited.store, secondChain, secondItem)

			const limitedTick = await schedulerTick(limited.options())
			expect(limitedTick.spawnedRuns).toHaveLength(1)
			expect(listActiveRuns(limited.state)).toHaveLength(1)
			limited.store.updateChain(firstChain.id, {
				status: "stopped",
				updatedAt: transitionTimestamp++,
			})
			expect(limited.store.listCurrentRuns(firstChain.id)).toHaveLength(1)
			expect((await schedulerTick(limited.options())).spawnedRuns).toHaveLength(0)
			await limitedTick.spawnedRuns[0]!.closed
			commitLeaf(limited.store, firstChain.id, firstLeaf.identity.runtimeNodeId, null, "finish-global-first")

			const releasedTick = await schedulerTick(limited.options())
			expect(releasedTick.spawnedRuns).toHaveLength(1)
			expect(releasedTick.spawnedRuns[0]?.chainId).toBe(secondChain.id)
			await releasedTick.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(limited)
		}

		const unlimited = await createFixture("issue-698-no-global-limit")
		try {
			const firstChain = createChain(unlimited.store, "issue-698-no-global-limit-a")
			const secondChain = createChain(unlimited.store, "issue-698-no-global-limit-b")
			const firstItem = createItem(unlimited.store, firstChain, {
				issueNumber: 698_006,
				repoCwd: "/repo/issue-698-no-global",
				sleepMs: 60,
				writeStatus: null,
				taskPhases: null,
			})
			const secondItem = createItem(unlimited.store, secondChain, {
				issueNumber: 698_007,
				repoCwd: "/repo/issue-698-no-global",
				sleepMs: 60,
				writeStatus: null,
				taskPhases: null,
			})
			appendSingleLeafItem(unlimited.store, firstChain, firstItem)
			appendSingleLeafItem(unlimited.store, secondChain, secondItem)

			const unlimitedTick = await schedulerTick(unlimited.options())
			expect(unlimitedTick.spawnedRuns).toHaveLength(2)
			expect(listActiveRuns(unlimited.state)).toHaveLength(2)
			await Promise.all(unlimitedTick.spawnedRuns.map((run) => run.closed))
		} finally {
			await stopFixture(unlimited)
		}
	})

	test("dependency gating stays orthogonal to readiness and public cycle rejection leaves the graph unchanged", async () => {
		const fixture = await createFixture("issue-698-dependency")
		try {
			const chain = createChain(fixture.store, "issue-698-dependency-chain")
			const prerequisite = createItem(fixture.store, chain, {
				issueNumber: 698_008,
				repoCwd: "/repo/issue-698-dependency",
				writeStatus: null,
				taskPhases: null,
			})
			const dependent = createItem(fixture.store, chain, {
				issueNumber: 698_009,
				repoCwd: "/repo/issue-698-dependency",
				writeStatus: null,
				taskPhases: null,
			})
			const prerequisiteLeaf = appendSingleLeafItem(fixture.store, chain, prerequisite, "prerequisite")
			appendSingleLeafItem(fixture.store, chain, dependent, "dependent")
			fixture.store.updateItem(dependent.id, {
				extra: storedItemExtra({
					...itemExtraToJsonObject(dependent.extra),
					dependsOn: [prerequisite.id],
				}),
				updatedAt: transitionTimestamp++,
			})

			const cycle = await daemonRequest(fixture, "item.update", {
				itemId: prerequisite.id,
				dependsOn: [dependent.id],
			})
			expect(cycle.ok).toBe(false)
			if (!cycle.ok) expect(cycle.error.message).toContain("dependency cycle")
			expect(fixture.store.getItem(prerequisite.id)?.extra.dependsOn).toBeUndefined()
			expect(fixture.store.getItem(dependent.id)?.extra.dependsOn).toEqual([prerequisite.id])

			const gated = await schedulerTick(fixture.options())
			expect(gated.spawnedRuns.map((run) => run.itemId)).toEqual([prerequisite.id])
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "item.dependency_wait",
				rowId: dependent.id,
				unsatisfied: [prerequisite.id],
			}))
			await gated.spawnedRuns[0]!.closed
			commitLeaf(
				fixture.store,
				chain.id,
				prerequisiteLeaf.identity.runtimeNodeId,
				null,
				"prerequisite-success",
				{
					kind: "when-task-terminal",
					itemId: prerequisite.id,
					update: { status: runtimeStatus("done"), phase: "iteration", updatedAt: transitionTimestamp++ },
				},
			)

			const released = await schedulerTick(fixture.options())
			expect(released.spawnedRuns.map((run) => run.itemId)).toEqual([dependent.id])
			await released.spawnedRuns[0]!.closed
		} finally {
			await stopFixture(fixture)
		}
	})

	test("successful parallel sibling cannot clear a newer failed-leaf backoff generation", async () => {
		const fixture = await createFixture("issue-698-par-backoff-ownership")
		try {
			const loadedPreset = await writePhasePreset(
				fixture,
				"issue-698-par-backoff-ownership-preset",
				["fail", "ok"],
			)
			const chain = createChain(fixture.store, "issue-698-par-backoff-ownership-chain")
			const item = createItem(fixture.store, chain, {
				issueNumber: 698_010,
				repoCwd: "/repo/issue-698-par-backoff",
				writeStatus: null,
				taskPhases: null,
			})
			const context: TreeContext = {
				chain,
				item,
				baseCommit: "4444444444444444444444444444444444444444",
			}
			const rootId = runtimeNodeId(context, "parallel")
			const failedLeaf = leafNode(context, "failed", "fail", rootId)
			const successfulLeaf = leafNode(context, "successful", "ok", rootId)
			fixture.store.appendItemTaskTree(chain.id, parNode(context, "parallel", [failedLeaf, successfulLeaf]))
			const options = fixture.options({
				loadedPreset,
				prompt: ({ chain: currentChain, item: currentItem, runId, worktreePath, phase }) =>
					JSON.stringify({
						itemId: currentItem.id,
						issueNumber: Number(currentItem.itemId),
						chainName: currentChain.name,
						runId,
						worktreePath,
						eventLog: fixture.eventLogForChain(currentChain.name),
						sleepMs: phase === "fail" ? 5 : 80,
						waitForConcurrentStarts: 2,
						exitCode: phase === "fail" ? 1 : 0,
						writeStatus: null,
					}),
			})

			const tick = await schedulerTick(options)
			expect(spawnedRunPhases(fixture.store, tick.spawnedRuns).sort()).toEqual(["fail", "ok"])
			const failedRun = tick.spawnedRuns.find((run) => fixture.store.getRunByRunId(run.runId)?.phase === "fail")
			const successfulRun = tick.spawnedRuns.find((run) => fixture.store.getRunByRunId(run.runId)?.phase === "ok")
			if (failedRun === undefined || successfulRun === undefined) throw new Error("parallel backoff fixture did not spawn both phases")

			expect((await failedRun.closed).exitCode).toBe(1)
			const failedBackoff = fixture.store.getItem(item.id)?.extra.schedulerBackoff
			expect(failedBackoff).toEqual({
				failureCount: 1,
				nextRunAt: expect.any(Number),
			})

			expect((await successfulRun.closed).exitCode).toBe(0)
			expect(fixture.store.getItem(item.id)?.extra.schedulerBackoff).toEqual(failedBackoff)
			expect(fixture.store.listRuns(chain.id).filter((run) => run.runtimeNodeId === failedLeaf.identity.runtimeNodeId)).toHaveLength(1)
			expect((await schedulerTick(options)).spawnedRuns).toHaveLength(0)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("attempt exhaustion terminates only its member while siblings run and drain completes without failure propagation", async () => {
		const fixture = await createFixture("issue-698-exhaustion-containment")
		try {
			const chain = createChain(fixture.store, "issue-698-exhaustion-containment-chain", {
				metadata: { maxItemAttempts: 1 },
			})
			const exhaustedItem = createItem(fixture.store, chain, {
				issueNumber: 698_011,
				repoCwd: "/repo/issue-698-exhaustion",
				writeStatus: null,
				taskPhases: null,
			})
			const siblingOne = createItem(fixture.store, chain, {
				issueNumber: 698_012,
				repoCwd: "/repo/issue-698-exhaustion",
				sleepMs: 60,
				waitForConcurrentStarts: 2,
				writeStatus: null,
				taskPhases: null,
			})
			const siblingTwo = createItem(fixture.store, chain, {
				issueNumber: 698_013,
				repoCwd: "/repo/issue-698-exhaustion",
				sleepMs: 60,
				waitForConcurrentStarts: 2,
				writeStatus: null,
				taskPhases: null,
			})
			fixture.store.updateItem(exhaustedItem.id, {
				attempts: 1,
				lastRunId: "issue-698-exhausted-prior-failure",
				extra: storedItemExtra({
					...itemExtraToJsonObject(exhaustedItem.extra),
					schedulerBackoff: { failureCount: 1, nextRunAt: 1_800_000_000 },
				}),
				updatedAt: transitionTimestamp++,
			})
			const exhaustedLeaf = appendSingleLeafItem(fixture.store, chain, exhaustedItem, "exhausted")
			const siblingOneLeaf = appendSingleLeafItem(fixture.store, chain, siblingOne, "sibling-one")
			const siblingTwoLeaf = appendSingleLeafItem(fixture.store, chain, siblingTwo, "sibling-two")
			fixture.store.recordRun({
				runId: "issue-698-exhausted-prior-failure",
				chainId: chain.id,
				itemId: exhaustedItem.id,
				phase: "iteration",
				startedAt: 1_900_697_998,
				endedAt: 1_900_697_999,
				exitCode: 1,
			})

			const tick = await schedulerTick(fixture.options())
			expect(tick.spawnedRuns.map((run) => run.itemId).sort((left, right) => left - right)).toEqual(
				[siblingOne.id, siblingTwo.id].sort((left, right) => left - right),
			)
			expect(fixture.store.getItem(exhaustedItem.id)?.status).toBe("exhausted")
			expect(fixture.store.getItem(exhaustedItem.id)?.extra.schedulerBackoff).toBeUndefined()
			expect(requireLeaf(fixture.store, chain.id, exhaustedLeaf.identity.runtimeNodeId).state).toBe("exhausted")
			expect(requirePar(fixture.store, chain.id, chainTaskRootId(chain)).state).toBe("open")
			await Promise.all(tick.spawnedRuns.map((run) => run.closed))

			commitLeaf(
				fixture.store,
				chain.id,
				siblingOneLeaf.identity.runtimeNodeId,
				null,
				"sibling-one-success",
				{
					kind: "when-task-terminal",
					itemId: siblingOne.id,
					update: { status: runtimeStatus("done"), phase: "iteration", updatedAt: transitionTimestamp++ },
				},
			)
			expect(requirePar(fixture.store, chain.id, chainTaskRootId(chain)).state).toBe("open")
			commitLeaf(
				fixture.store,
				chain.id,
				siblingTwoLeaf.identity.runtimeNodeId,
				null,
				"sibling-two-success",
				{
					kind: "when-task-terminal",
					itemId: siblingTwo.id,
					update: { status: runtimeStatus("done"), phase: "iteration", updatedAt: transitionTimestamp++ },
				},
			)
			expect(requirePar(fixture.store, chain.id, chainTaskRootId(chain)).state).toBe("completed")
			expect(fixture.store.getItem(siblingOne.id)?.status).toBe("done")
			expect(fixture.store.getItem(siblingTwo.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
		}
	})

})
