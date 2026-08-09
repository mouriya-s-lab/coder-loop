import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "node:net"
import { Effect, Layer } from "effect"
import { runCli } from "../../../src/v3/cli"
import {
	openAgentValueSession,
	parseContext0,
	settlePreAgentMaps,
	submitAgentValues,
	type AgentRunAuthority,
} from "../../../src/v3/context"
import {
	compilePresetDefinition,
	resolveCompileAssets,
	strictCompiledProduct,
	type PresetDefinition,
} from "../../../src/v3/definition"
import { DaemonProtocol } from "../../../src/v3/daemon-handler"
import { DaemonSocket, makeDaemonSocketLive } from "../../../src/v3/daemon-socket"
import { parseDaemonRequest } from "../../../src/v3/daemon-protocol"
import {
	groupKey,
	taskKey,
	type ObjectDomainSnapshot,
	type Task,
} from "../../../src/v3/object-domain"
import { makeRepositoryGitLive, RepositoryGit } from "../../../src/v3/git-service"
import { buildEventProjection, buildStatusProjection } from "../../../src/v3/projection"
import { selectReadyTask } from "../../../src/v3/scheduler"
import { makeObjectDomainStoreLive, ObjectDomainStore } from "../../../src/v3/sqlite-store"

const definition: PresetDefinition = {
	schemaVersion: 3,
	name: "contract-test",
	sourceIdentity: { kind: "definition-source", digest: "source" },
	values: [
		{ name: "request", type: { kind: "string" }, source: { kind: "item" }, required: true },
		{ name: "pre", type: { kind: "number" }, source: { kind: "map", stage: "pre-agent", module: "map.ts", exportName: "run", reads: ["request"] }, required: true },
		{ name: "result", type: { kind: "string" }, source: { kind: "agent" }, required: true },
	],
	consumers: [
		{ kind: "prompt", value: "request" },
		{ kind: "prompt", value: "pre" },
		{ kind: "map-input", value: "request", mapValue: "pre" },
	],
	task: {
		kind: "leaf",
		id: "root",
		promptAsset: "prompt.txt",
		contract: {
			returns: { kind: "string" },
			returnValue: "result",
			predicates: [],
			successors: [],
			chooser: null,
			onNil: "return-nil",
			onException: "fail",
		},
	},
}

const authority: AgentRunAuthority = {
	kind: "agent-run",
	chainId: "chain",
	taskId: "chain/root",
	closureId: "chain/root/0",
	runId: "run-1",
}

describe("v3 architecture contracts", () => {
	test("task selection excludes every non-ready state", () => {
		const chain = { kind: "chain" as const, value: "selection" }
		const group = { kind: "group" as const, chain, value: "root" }
		const makeTask = (value: string, state: Task["state"], priority: number): Task => ({
			identity: { kind: "task", chain, value },
			group,
			input: {
				definition: {
					kind: "published-definition",
					content: { kind: "definition-content", digest: "content" },
					product: { kind: "compiled-product", digest: "product" },
				},
				entrypoint: "root",
				basePin: "base",
				value: null,
				valueIdentity: value,
			},
			dependsOn: [],
			priority,
			state,
			closure: { kind: "unallocated" },
		})
		const ready = makeTask("ready", { kind: "ready" }, 1)
		const held = makeTask("held", { kind: "held", reason: { kind: "pre-spawn-absence", endpoint: "runner", detail: "missing", observedAt: 1 } }, 99)

		expect(selectReadyTask([{ chain, tasks: [held, ready] }])?.task).toBe(ready)
		expect(selectReadyTask([{ chain, tasks: [held] }])).toBeNull()
	})

	test("store rejects an existing unversioned shape without changing it", async () => {
		const root = await mkdtemp(join(process.cwd(), ".v3-store-schema-"))
		const databaseFile = join(root, "legacy.sqlite")
		try {
			const seed = new Database(databaseFile)
			seed.exec("CREATE TABLE v3_meta(schema_version INTEGER); CREATE TABLE v3_chains(old_column TEXT)")
			const before = seed.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()
			seed.close()

			const exit = await Effect.runPromiseExit(Effect.scoped(ObjectDomainStore.pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
			expect(exit._tag).toBe("Failure")

			const observed = new Database(databaseFile)
			expect(observed.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before)
			expect(observed.query<{ schema_version: number }, []>("SELECT schema_version FROM v3_meta").all()).toEqual([])
			observed.close()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("compile remains incomplete until every declared asset resolves", () => {
		const compiled = compilePresetDefinition(definition)
		expect(compiled.kind).toBe("compiled")
		if (compiled.kind !== "compiled") return
		expect(compiled.findings).toEqual([
			{ kind: "map-asset-unverified", value: "pre", module: "map.ts", exportName: "run" },
			{ kind: "prompt-asset-unverified", taskId: "root", asset: "prompt.txt" },
		])
		expect(strictCompiledProduct(compiled).kind).toBe("rejected")

		const resolved = resolveCompileAssets(compiled, { "map.ts": "export const run = () => 1", "prompt.txt": "Run the task." })
		const strict = strictCompiledProduct(resolved)
		expect(strict.kind).toBe("accepted")
		if (strict.kind !== "accepted") return
		expect(strict.product.taskIndex.root?.kind).toBe("leaf")
		expect(strict.product.valueIndex.result?.source.kind).toBe("agent")
	})

	test("typed context admits only declared values and closes on required agent fields", () => {
		const rejected = parseContext0(definition.values, { request: "work", extra: true })
		expect(rejected.kind).toBe("rejected")

		const context0 = parseContext0(definition.values, { request: "work" })
		expect(context0.kind).toBe("accepted")
		if (context0.kind !== "accepted") return
		const pre = settlePreAgentMaps(context0.context, definition.values, [{ kind: "produced", valueName: "pre", value: 7 }])
		expect(pre.kind).toBe("settled")
		if (pre.kind !== "settled") return

		const session = openAgentValueSession(authority, pre.context, definition.values)
		const invalid = submitAgentValues(session, authority, { result: 3 })
		expect(invalid).toMatchObject({ kind: "rejected", reason: "invalid-value" })
		const closed = submitAgentValues(session, authority, { result: "done" })
		expect(closed.kind).toBe("accepted")
		if (closed.kind !== "accepted") return
		expect(closed.session).toEqual({ state: "closed", authority, context: { stage: "context-2", values: { request: "work", pre: 7, result: "done" } } })
	})

	test("daemon boundary rejects caller confusion before dispatch", () => {
		const request = parseDaemonRequest({
			schemaVersion: 3,
			requestId: "request-1",
			caller: { kind: "operator" },
			command: { kind: "agent-submit", values: { result: "forged" } },
		})
		expect(request).toEqual({ kind: "rejected", rejection: { kind: "request-rejected", reason: "unauthorized", issues: ["agent-submit requires agent authority"] } })
		const invalidCursor = parseDaemonRequest({
			schemaVersion: 3,
			requestId: "request-2",
			caller: { kind: "operator" },
			command: { kind: "events-read", chain: { kind: "chain", value: "chain" }, since: 0.5 },
		})
		expect(invalidCursor).toMatchObject({ kind: "rejected", rejection: { kind: "request-rejected", reason: "invalid-command" } })
	})

	test("operator CLI sends a typed status command when no action token is present", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-cli-"))
		const socketPath = join(root, "daemon.sock")
		const request = Promise.withResolvers<unknown>()
		const server = createServer((socket) => {
			let buffer = ""
			socket.setEncoding("utf8")
			socket.on("data", (chunk) => {
				buffer += chunk
				const newline = buffer.indexOf("\n")
				if (newline < 0) return
				const candidate = JSON.parse(buffer.slice(0, newline))
				request.resolve(candidate)
				socket.end(`${JSON.stringify({
					schemaVersion: 3,
					requestId: candidate.requestId,
					outcome: {
						kind: "success",
						value: {
							kind: "status",
							projection: { schemaVersion: 3, chain: "chain", taskCounts: { ready: 0, leased: 0, suspended: 0, held: 0, settled: 0 }, ready: [], tasks: [], groups: [], awaits: 0, admittedFacts: 0 },
						},
					},
				})}\n`)
			})
		})
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject)
				server.listen(socketPath, resolve)
			})
			const stdout: string[] = []
			const stderr: string[] = []
			const exit = await runCli(["status", "--socket", socketPath, "--chain", "chain"], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) })
			expect(exit).toBe(0)
			expect(stderr).toEqual([])
			expect(JSON.parse(stdout.join(""))).toEqual({ schemaVersion: 3, chain: "chain", taskCounts: { ready: 0, leased: 0, suspended: 0, held: 0, settled: 0 }, ready: [], tasks: [], groups: [], awaits: 0, admittedFacts: 0 })
			expect(await request.promise).toMatchObject({ caller: { kind: "operator" }, command: { kind: "status-read", chain: { kind: "chain", value: "chain" } } })
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await rm(root, { recursive: true, force: true })
		}
	})

	test("Git closure preparation resolves symbolic base pins before residue comparison", async () => {
		const git = Bun.which("git")
		expect(git).not.toBeNull()
		if (git === null) return
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-git-"))
		const repository = join(root, "repository")
		const workspaceRoot = join(root, "workspaces")
		const run = async (...argv: string[]): Promise<void> => {
			const outcome = Bun.spawnSync({ cmd: [git, ...argv], cwd: root, stdout: "pipe", stderr: "pipe" })
			if (outcome.exitCode !== 0) throw new Error(new TextDecoder().decode(outcome.stderr))
		}
		try {
			await mkdir(repository)
			await run("-C", repository, "init")
			await run("-C", repository, "config", "user.email", "v3-test@example.invalid")
			await run("-C", repository, "config", "user.name", "v3 test")
			await writeFile(join(repository, "seed.txt"), "seed\n")
			await run("-C", repository, "add", "seed.txt")
			await run("-C", repository, "commit", "-m", "seed")
			await Effect.runPromise(Effect.gen(function*() {
				const service = yield* RepositoryGit
				const chain = { kind: "chain" as const, value: "chain" }
				const task = { kind: "task" as const, chain, value: "root" }
				const identity = { kind: "closure" as const, task, attempt: 0 }
				const request = { identity, basePin: "HEAD", branch: "coder-loop/v3/base-pin-test", allocation: "allocation-1" }
				const first = yield* service.prepare(request)
				const second = yield* service.prepare(request)
				expect(first.basePin).not.toBe("HEAD")
				expect(second).toEqual(first)
				yield* service.discard(first)
			}).pipe(Effect.provide(makeRepositoryGitLive({
				repository,
				workspaceRoot,
				executable: git,
				env: {},
				timeoutMs: 5_000,
				termGraceMs: 500,
				maxOutputBytes: 1_048_576,
			}))))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("daemon socket lock rejects a second live owner and releases paths on stop", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-socket-"))
		const operatorPath = join(root, "operator.sock")
		const agentPath = join(root, "agent.sock")
		const protocol = Layer.succeed(DaemonProtocol, {
			handle: () => Effect.succeed({ schemaVersion: 3 as const, requestId: null, outcome: { kind: "rejected" as const, rejection: { kind: "request-rejected" as const, reason: "invalid-envelope" as const, issues: ["test"] } } }),
		})
		const socketLayer = makeDaemonSocketLive({ operatorPath, agentPath, maxFrameBytes: 1024, maxResponseBytes: 1024, onError: () => undefined }).pipe(Layer.provide(protocol))
		try {
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const socket = yield* DaemonSocket
				const duplicate = yield* Effect.exit(Layer.build(socketLayer))
				expect(duplicate._tag).toBe("Failure")
				yield* socket.stop
			}).pipe(Effect.provide(socketLayer))))
			expect(await Bun.file(operatorPath).exists()).toBe(false)
			expect(await Bun.file(agentPath).exists()).toBe(false)
			expect(await Bun.file(`${operatorPath}.lock`).exists()).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("settlement and successor admission commit atomically and project from durable facts", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-store-"))
		const originalNow = Date.now
		try {
			Date.now = () => 2_000
			const databaseFile = join(root, "runtime.sqlite")
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const store = yield* ObjectDomainStore
				const chain = { kind: "chain" as const, value: "chain" }
				const group = { kind: "group" as const, chain, value: "root" }
				const parentIdentity = { kind: "task" as const, chain, value: "root" }
				const definitionRef = {
					kind: "published-definition" as const,
					content: { kind: "definition-content" as const, digest: "content" },
					product: { kind: "compiled-product" as const, digest: "product" },
				}
				const parent: Task = {
					identity: parentIdentity,
					group,
					input: { definition: definitionRef, entrypoint: "root", basePin: "base", value: { request: "work" }, valueIdentity: "input" },
					dependsOn: [],
					priority: 5,
					state: { kind: "leased", run: { kind: "run", closure: { kind: "closure", task: parentIdentity, attempt: 0 }, value: "run" }, acquiredAt: 10, expiresAt: 20 },
					closure: { kind: "active", identity: { kind: "closure", task: parentIdentity, attempt: 0 }, basePin: "base", branch: "coder-loop/v3/root", worktree: "/worktree", scratch: "/scratch" },
				}
				const snapshot: ObjectDomainSnapshot = {
					chain,
					tasks: { [taskKey(parentIdentity)]: parent },
					groups: { [groupKey(group)]: { identity: group, members: [parentIdentity], memberVersion: 1, wait: { kind: "none" }, consumer: { kind: "drain" }, state: { kind: "open" } } },
					awaits: {},
					admittedFacts: {},
				}
				yield* store.bootstrap(snapshot)
				const run = parent.state.kind === "leased" ? parent.state.run : null
				expect(run).not.toBeNull()
				if (run === null) return
				const successorIdentity = { kind: "task" as const, chain, value: "next" }
				const successor: Task = {
					identity: successorIdentity,
					group,
					input: { definition: definitionRef, entrypoint: "root", basePin: "base", value: { result: "done" }, valueIdentity: "next-input" },
					dependsOn: [parentIdentity],
					priority: 5,
					state: { kind: "ready" },
					closure: { kind: "unallocated" },
				}
				const commit = yield* store.commit({
					identity: "settle-and-admit",
					transition: {
						family: "task-settlement",
						task: parentIdentity,
						run,
						settlement: { kind: "returned", value: "done" },
						successors: [{ fact: { kind: "fact", source: "handoff", value: "next" }, task: successor, position: { group, expectedMemberVersion: 1 } }],
					},
				})
				expect(commit.kind).toBe("committed")
				const durable = yield* store.readSnapshot(chain)
				expect(durable.tasks[taskKey(parentIdentity)]?.state.kind).toBe("settled")
				expect(durable.tasks[taskKey(successorIdentity)]?.state.kind).toBe("ready")
				expect(durable.groups[groupKey(group)]?.memberVersion).toBe(2)
				const status = buildStatusProjection(durable)
				expect(status.ready).toEqual(["chain/next"])
				const events = buildEventProjection(chain.value, yield* store.listTransitions(chain, 0))
				expect(events.transitions).toEqual([{ identity: "settle-and-admit", family: "task-settlement", cursor: 1, committedAt: 2_000 }])
				yield* store.commit({
					identity: "hold-successor",
					transition: { family: "task-held", task: successorIdentity, expectedRun: null, reason: { kind: "pre-spawn-absence", endpoint: "runner", detail: "missing", observedAt: 2_000 } },
				})
				Date.now = () => 1_000
				yield* store.commit({ identity: "unhold-successor", transition: { family: "task-unhold", task: successorIdentity } })
				expect(yield* store.listTransitions(chain, 1)).toEqual([
					{ identity: "hold-successor", family: "task-held", cursor: 2, committedAt: 2_000 },
					{ identity: "unhold-successor", family: "task-unhold", cursor: 3, committedAt: 1_000 },
				])
			}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
		} finally {
			Date.now = originalNow
			await rm(root, { recursive: true, force: true })
		}
	})

	test("snapshot rejects relational identities that disagree with payload identities", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-store-identity-"))
		try {
			for (const mutation of [
				"UPDATE v3_tasks SET task_key='wrong/task'",
				"UPDATE v3_groups SET group_key='wrong/group'",
				"UPDATE v3_awaits SET await_key='wrong/await'",
			]) {
				const databaseFile = join(root, `${Bun.hash(mutation)}.sqlite`)
				await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
					const store = yield* ObjectDomainStore
					const chain = { kind: "chain" as const, value: "chain" }
					const group = { kind: "group" as const, chain, value: "root" }
					const identity = { kind: "task" as const, chain, value: "task" }
					const task: Task = {
						identity,
						group,
						input: { definition: { kind: "published-definition", content: { kind: "definition-content", digest: "content" }, product: { kind: "compiled-product", digest: "product" } }, entrypoint: "root", basePin: "base", value: null, valueIdentity: "input" },
						dependsOn: [], priority: 0, state: { kind: "ready" }, closure: { kind: "unallocated" },
					}
					const awaitIdentity = { kind: "await" as const, parent: identity, attempt: 0, site: "site" }
					const snapshot: ObjectDomainSnapshot = {
						chain,
						tasks: { [taskKey(identity)]: task },
						groups: { [groupKey(group)]: { identity: group, members: [identity], memberVersion: 1, wait: { kind: "none" }, consumer: { kind: "drain" }, state: { kind: "open" } } },
						awaits: { "chain/task/0/site": { kind: "waiting", identity: awaitIdentity, parentClosure: { kind: "closure", task: identity, attempt: 0 }, child: identity } },
						admittedFacts: {},
					}
					yield* store.bootstrap(snapshot)
					const database = new Database(databaseFile)
					database.exec("PRAGMA foreign_keys = OFF")
					database.exec(mutation)
					database.close()
					const error = yield* Effect.flip(store.readSnapshot(chain))
					expect(error).toMatchObject({ kind: "store-schema", reason: "persisted-shape-invalid" })
				}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("closure base pin is validated at lease and retained after collection", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-base-pin-"))
		try {
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const store = yield* ObjectDomainStore
				const chain = { kind: "chain" as const, value: "base-pin" }
				const group = { kind: "group" as const, chain, value: "root" }
				const identity = { kind: "task" as const, chain, value: "task" }
				const closureIdentity = { kind: "closure" as const, task: identity, attempt: 0 }
				const run = { kind: "run" as const, closure: closureIdentity, value: "run" }
				const task: Task = {
					identity,
					group,
					input: {
						definition: { kind: "published-definition", content: { kind: "definition-content", digest: "content" }, product: { kind: "compiled-product", digest: "product" } },
						entrypoint: "root",
						basePin: "expected-pin",
						value: null,
						valueIdentity: "input",
					},
					dependsOn: [],
					priority: 0,
					state: { kind: "ready" },
					closure: { kind: "unallocated" },
				}
				yield* store.bootstrap({
					chain,
					tasks: { [taskKey(identity)]: task },
					groups: { [groupKey(group)]: { identity: group, members: [identity], memberVersion: 1, wait: { kind: "none" }, consumer: { kind: "drain" }, state: { kind: "open" } } },
					awaits: {},
					admittedFacts: {},
				})
				const resources = { kind: "active" as const, identity: closureIdentity, basePin: "expected-pin", branch: "branch", worktree: "/worktree", scratch: "/scratch" }
				const rejected = yield* Effect.either(store.commit({
					identity: "wrong-pin",
					transition: { family: "lease-acquire", task: identity, run, closure: { ...resources, basePin: "wrong-pin" }, acquiredAt: 1, expiresAt: 2 },
				}))
				expect(rejected._tag).toBe("Left")
				if (rejected._tag === "Left") expect(rejected.left).toEqual(expect.objectContaining({ kind: "transition-rejected", family: "lease-acquire", reason: "identity-mismatch" }))
				expect((yield* store.readSnapshot(chain)).tasks[taskKey(identity)]?.closure.kind).toBe("unallocated")

				yield* store.commit({ identity: "lease", transition: { family: "lease-acquire", task: identity, run, closure: resources, acquiredAt: 1, expiresAt: 2 } })
				const settlement = { kind: "returned" as const, value: null }
				yield* store.commit({ identity: "settle", transition: { family: "task-settlement", task: identity, run, settlement, successors: [] } })
				yield* store.commit({ identity: "terminate", transition: { family: "group-termination", group, state: { kind: "terminated", reason: "immediate", memberVersion: 1, terminatedAt: 3 } } })
				yield* store.commit({ identity: "consume", transition: { family: "group-consumption", group, state: { kind: "consumed", consumption: { kind: "consumption", group, value: "done" }, consumedAt: 3 }, settlements: [settlement] } })
				yield* store.commit({ identity: "freeze", transition: { family: "resource-intent", closure: closureIdentity, action: "freeze-evidence", publication: { kind: "no-work", observedAt: 3 } } })
				yield* store.commit({ identity: "collect", transition: { family: "resource-intent", closure: closureIdentity, action: "collect", publication: { kind: "no-work", observedAt: 3 } } })
				const collected = (yield* store.readSnapshot(chain)).tasks[taskKey(identity)]?.closure
				expect(collected).toEqual({ kind: "collected", identity: closureIdentity, basePin: "expected-pin", publication: { kind: "no-work", observedAt: 3 }, collectedAt: expect.any(Number) })
			}).pipe(Effect.provide(makeObjectDomainStoreLive(join(root, "runtime.sqlite"))))))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
	test("closure collection requires a consumed owning group reference", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-collect-"))
		try {
			for (const fixture of [
				{ name: "open-member", consumed: false, member: true, reason: "state-mismatch" },
				{ name: "consumed-missing-member", consumed: true, member: false, reason: "identity-mismatch" },
			] as const) {
				await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
					const store = yield* ObjectDomainStore
					const chain = { kind: "chain" as const, value: fixture.name }
					const group = { kind: "group" as const, chain, value: "group" }
					const identity = { kind: "task" as const, chain, value: "task" }
					const closure = { kind: "closure" as const, task: identity, attempt: 0 }
					const publication = { kind: "no-work" as const, observedAt: 1 }
					const snapshot: ObjectDomainSnapshot = {
						chain,
						groups: { [groupKey(group)]: { identity: group, members: fixture.member ? [identity] : [], memberVersion: fixture.member ? 1 : 0, wait: { kind: "none" }, consumer: { kind: "drain" }, state: fixture.consumed ? { kind: "consumed", consumption: { kind: "consumption", group, value: "done" }, consumedAt: 1 } : { kind: "open" } } },
						tasks: { [taskKey(identity)]: { identity, group, input: { definition: { kind: "published-definition", content: { kind: "definition-content", digest: "content" }, product: { kind: "compiled-product", digest: "product" } }, entrypoint: "root", basePin: "base", value: null, valueIdentity: "input" }, dependsOn: [], priority: 0, state: { kind: "settled", settlement: { kind: "returned", value: null }, settledAt: 1 }, closure: { kind: "evidence-frozen", identity: closure, basePin: "base", branch: "coder-loop/v3/test", worktree: "/worktree", scratch: "/scratch", publication } } },
						awaits: {},
						admittedFacts: {},
					}
					yield* store.bootstrap(snapshot)
					const result = yield* Effect.either(store.commit({ identity: `collect:${fixture.name}`, transition: { family: "resource-intent", closure, action: "collect", publication } }))
					expect(result._tag).toBe("Left")
					if (result._tag === "Left") expect(result.left).toMatchObject({ kind: "transition-rejected", reason: fixture.reason })
					const after = yield* store.readSnapshot(chain)
					expect(after.tasks[taskKey(identity)]?.closure.kind).toBe("evidence-frozen")
				}).pipe(Effect.provide(makeObjectDomainStoreLive(join(root, `${fixture.name}.sqlite`))))))
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("events include committed await consumption", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-events-await-consumption-"))
		try {
			const databaseFile = join(root, "runtime.sqlite")
			await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
				const store = yield* ObjectDomainStore
				const chain = { kind: "chain" as const, value: "events-await-consumption" }
				yield* store.bootstrap({ chain, tasks: {}, groups: {}, awaits: {}, admittedFacts: {} })
				const database = new Database(databaseFile, { strict: true })
				database.query("INSERT INTO v3_transitions(identity_key,chain_key,family,payload,committed_at) VALUES ($identity,$chain,$family,$payload,$at)").run({
					identity: "await-consume:token-1", chain: chain.value, family: "await-consumption", payload: "{}", at: 42,
				})
				database.close()
				expect(yield* store.listTransitions(chain, 0)).toEqual([
					{ identity: "await-consume:token-1", family: "await-consumption", cursor: 1, committedAt: 42 },
				])
			}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
		} finally { await rm(root, { recursive: true, force: true }) }
	})

})
