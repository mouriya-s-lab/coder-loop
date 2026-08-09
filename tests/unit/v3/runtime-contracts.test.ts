import { describe, expect, test } from "bun:test"
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
				request.resolve(JSON.parse(buffer.slice(0, newline)))
				socket.end(`${JSON.stringify({ schemaVersion: 3, requestId: "response", outcome: { kind: "success", value: { kind: "status" } } })}\n`)
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
			expect(stdout).toHaveLength(1)
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
		try {
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
				expect(events.transitions).toEqual([{ identity: "settle-and-admit", family: "task-settlement", committedAt: expect.any(Number) }])
			}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
