import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "node:net"
import { Effect, Layer } from "effect"
import { runCli } from "../../../src/v3/cli"
import {
	evaluateTransition,
	openAgentValueSession,
	parseContext0,
	settlePreAgentMaps,
	submitAgentValues,
	type AgentRunAuthority,
} from "../../../src/v3/context"
import {
	compilePresetDefinition,
	finalizerResultType,
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
import { makeObjectDomainStoreLive, ObjectDomainStore } from "../../../src/v3/sqlite-store"
import { runnerSandboxProfile } from "../../../src/v3/provider"

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
	test("compile remains incomplete until every declared map asset resolves", () => {
		const compiled = compilePresetDefinition(definition)
		expect(compiled.kind).toBe("compiled")
		if (compiled.kind !== "compiled") return
		expect(compiled.findings).toEqual([
			{ kind: "map-asset-unverified", value: "pre", module: "map.ts", exportName: "run" },
			{ kind: "prompt-asset-unverified", taskId: "root", asset: "prompt.txt" },
		])
		expect(strictCompiledProduct(compiled).kind).toBe("rejected")

		const resolved = resolveCompileAssets(compiled, {
			"map.ts": "export const run = () => 1",
			"prompt.txt": "Process {{request}}",
		})
		const strict = strictCompiledProduct(resolved)
		expect(strict.kind).toBe("accepted")
		if (strict.kind !== "accepted") return
		expect(strict.product.taskIndex.root?.kind).toBe("leaf")
		expect(strict.product.valueIndex.result?.source.kind).toBe("agent")
	})

	test("parallel definitions require an ordinary typed finalizer program", () => {
		const finalizerType = finalizerResultType()
		const parallel: PresetDefinition = {
			...definition,
			name: "parallel-contract-test",
			task: {
				kind: "par",
				id: "parallel",
				growth: "closed",
				children: [definition.task],
				finalizer: {
					values: [
						{ name: "settlements", type: { kind: "array", element: { kind: "json" } }, source: { kind: "item" }, required: true },
						{ name: "decision", type: finalizerType, source: { kind: "agent" }, required: true },
					],
					consumers: [{ kind: "prompt", value: "settlements" }],
					task: {
						kind: "leaf",
						id: "parallel-finalizer",
						promptAsset: "finalizer.txt",
						contract: { returns: finalizerType, returnValue: "decision", predicates: [], successors: [], chooser: null, onNil: "return-nil", onException: "propagate" },
					},
				},
			},
		}
		const resolved = resolveCompileAssets(compilePresetDefinition(parallel), {
			"map.ts": "export const run = () => 1",
			"prompt.txt": "Process {{request}}",
			"finalizer.txt": "Finalize {{settlements}}",
		})
		expect(strictCompiledProduct(resolved).kind).toBe("accepted")
		if (parallel.task.kind !== "par") return
		const invalid = compilePresetDefinition({
			...parallel,
			task: {
				...parallel.task,
				finalizer: {
					...parallel.task.finalizer,
					values: parallel.task.finalizer.values.map((value) => value.name === "decision" ? { ...value, type: { kind: "string" as const } } : value),
					task: { ...parallel.task.finalizer.task, contract: { ...parallel.task.finalizer.task.contract, returns: { kind: "string" } } },
				},
			},
		})
		expect(invalid).toMatchObject({ kind: "rejected", diagnostics: expect.arrayContaining([{ kind: "invalid-finalizer-return-type", taskId: "parallel-finalizer" }]) })
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

	test("fail successors remain inside the same function transition", () => {
		const contract = {
			returns: { kind: "string" as const },
			returnValue: "result",
			predicates: ["gate"],
			successors: [{ target: "recover", when: "fail" }],
			chooser: null,
			onNil: "escalate" as const,
			onException: "fail" as const,
		}
		const context = { stage: "context-3" as const, values: { result: "done", gate: false } }
		expect(evaluateTransition(contract, context, () => false)).toEqual({ kind: "internal-successor", target: "recover" })
	})

	test("generated runner sandbox writes only in the closure", async () => {
		if (Bun.which("/usr/bin/sandbox-exec") === null) return
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-sandbox-"))
		const outside = `${root}-outside`
		try {
			await mkdir(outside)
			const profile = runnerSandboxProfile(root, join(root, "agent.sock"), "/bin/sh", [])
			const allowed = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `echo allowed > ${join(root, "allowed.txt")}`], { stdout: "pipe", stderr: "pipe" })
			const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `echo denied > ${join(outside, "denied.txt")}`], { stdout: "pipe", stderr: "pipe" })
			await Bun.write(join(outside, "secret.txt"), "secret")
			const deniedRead = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `cat ${join(outside, "secret.txt")}`], { stdout: "pipe", stderr: "pipe" })
			expect(allowed.exitCode).toBe(0)
			expect(await Bun.file(join(root, "allowed.txt")).text()).toBe("allowed\n")
			expect(denied.exitCode).not.toBe(0)
			expect(await Bun.file(join(outside, "denied.txt")).exists()).toBe(false)
			expect(deniedRead.exitCode).not.toBe(0)
		} finally {
			await rm(root, { recursive: true, force: true })
			await rm(outside, { recursive: true, force: true })
		}
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
				const request = { identity, allocation: "base-pin-test", basePin: "HEAD", branch: "coder-loop/v3/base-pin-test" }
				const first = yield* service.prepare(request)
				const second = yield* service.prepare(request)
				expect(first.basePin).not.toBe("HEAD")
				expect(second).toEqual(first)
				const competing = yield* service.prepare({ ...request, allocation: "competing-candidate", branch: "coder-loop/v3/competing-candidate" })
				expect(competing.worktree).not.toBe(first.worktree)
				yield* service.discard(competing)
				expect(yield* Effect.promise(() => Bun.file(join(first.worktree, "seed.txt")).exists())).toBe(true)
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
		const socketLayer = makeDaemonSocketLive({ operatorPath, agentPath, maxFrameBytes: 1024, maxResponseBytes: 1024 * 1024, onError: () => undefined }).pipe(Layer.provide(protocol))
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

	test("daemon socket drains responses larger than the kernel write buffer", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-socket-response-"))
		const operatorPath = join(root, "operator.sock")
		const agentPath = join(root, "agent.sock")
		const expected = "x".repeat(128 * 1024)
		const protocol = Layer.succeed(DaemonProtocol, {
			handle: () => Effect.succeed({
				schemaVersion: 3 as const,
				requestId: null,
				outcome: {
					kind: "failure" as const,
					error: {
						kind: "task-input-rejected" as const,
						task: "large",
						fields: [{ valueName: "large", issues: [{ path: [], expected, actual: "test" }] }],
					},
				},
			}),
		})
		const socketLayer = makeDaemonSocketLive({ operatorPath, agentPath, maxFrameBytes: 1024, maxResponseBytes: 1024 * 1024, onError: () => undefined }).pipe(Layer.provide(protocol))
		try {
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const socket = yield* DaemonSocket
				let stdout = ""
				const exitCode = yield* Effect.promise(() => runCli(["status", "--socket", operatorPath, "--chain", "large"], {
					stdout: (text) => { stdout += text },
					stderr: () => undefined,
				}))
				expect(exitCode).toBe(1)
				expect(stdout.length).toBeGreaterThan(expected.length)
				expect(stdout).toContain(expected)
				yield* socket.stop
			}).pipe(Effect.provide(socketLayer))))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("daemon socket rejects aggregate request and response buffers above configured limits", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-socket-limits-"))
		const operatorPath = join(root, "operator.sock")
		const agentPath = join(root, "agent.sock")
		const errors: string[] = []
		const protocol = Layer.succeed(DaemonProtocol, {
			handle: () => Effect.succeed({
				schemaVersion: 3 as const,
				requestId: null,
				outcome: { kind: "rejected" as const, rejection: { kind: "request-rejected" as const, reason: "invalid-envelope" as const, issues: ["x".repeat(2048)] } },
			}),
		})
		const socketLayer = makeDaemonSocketLive({
			operatorPath,
			agentPath,
			maxFrameBytes: 128,
			maxResponseBytes: 256,
			onError: (error) => { errors.push(error.message) },
		}).pipe(Layer.provide(protocol))
		try {
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const socket = yield* DaemonSocket
				yield* Effect.promise(() => sendRaw(operatorPath, `${"x".repeat(129)}\n`))
				yield* Effect.promise(() => sendRaw(operatorPath, "{}\n{}\n"))
				yield* Effect.promise(() => sendRaw(operatorPath, "{}\n"))
				expect(errors).toContain("request frame exceeds maxFrameBytes")
				expect(errors).toContain("connection queued more than one request frame")
				expect(errors).toContain("daemon response exceeds maxResponseBytes")
				yield* socket.stop
			}).pipe(Effect.provide(socketLayer))))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("concurrent admissions at one frontier produce one durable winner", async () => {
		const base = join(process.cwd(), ".test-runs")
		await mkdir(base, { recursive: true })
		const root = await mkdtemp(join(base, "v3-admission-race-"))
		try {
			const databaseFile = join(root, "runtime.sqlite")
			await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
				const store = yield* ObjectDomainStore
				const chain = { kind: "chain" as const, value: "race" }
				const group = { kind: "group" as const, chain, value: "root" }
				const seedIdentity = { kind: "task" as const, chain, value: "seed" }
				const definitionRef = {
					kind: "published-definition" as const,
					content: { kind: "definition-content" as const, digest: "content" },
					product: { kind: "compiled-product" as const, digest: "product" },
				}
				const seed: Task = {
					identity: seedIdentity,
					group,
					input: { definition: definitionRef, entrypoint: "seed", basePin: "base", value: { request: "work" }, valueIdentity: "seed" },
					dependsOn: [],
					priority: 1,
					state: { kind: "ready" },
					closure: { kind: "unallocated" },
				}
				yield* store.bootstrap({
					chain,
					tasks: { [taskKey(seedIdentity)]: seed },
					groups: { [groupKey(group)]: { identity: group, members: [seedIdentity], memberVersion: 1, wait: { kind: "none" }, consumer: { kind: "drain" }, state: { kind: "open" } } },
					awaits: {},
					admittedFacts: {},
				})
				const candidate = (value: string) => ({
					fact: { kind: "fact" as const, source: "race", value },
					position: { group, expectedMemberVersion: 1 },
					timing: { kind: "before-termination" as const },
					authority: { kind: "external" as const, principal: "test", allowedChain: chain },
					task: {
						identity: { kind: "task" as const, chain, value },
						group,
						input: { definition: definitionRef, entrypoint: value, basePin: "base", value: { request: value }, valueIdentity: value },
						dependsOn: [],
						priority: 1,
					},
				})
				const results = yield* Effect.all(
					[store.admit(chain, candidate("left")), store.admit(chain, candidate("right"))],
					{ concurrency: "unbounded" },
				)
				expect(results.map((result) => result.kind).sort()).toEqual(["admitted", "rejected"])
				const durable = yield* store.readSnapshot(chain)
				expect(durable.groups[groupKey(group)]?.memberVersion).toBe(2)
				expect(Object.keys(durable.tasks)).toHaveLength(2)
				expect(Object.keys(durable.admittedFacts)).toHaveLength(1)
				const forgedGroup = { kind: "group" as const, chain, value: "forged" }
				const mismatched = candidate("mismatched")
				const mismatch = yield* store.admit(chain, {
					...mismatched,
					position: { group, expectedMemberVersion: 2 },
					task: { ...mismatched.task, group: forgedGroup },
				})
				expect(mismatch).toMatchObject({ kind: "rejected", reason: { kind: "contract-rejected", reason: "task-group-mismatch" } })
			}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
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
					input: { definition: definitionRef, entrypoint: "parent", basePin: "base", value: { request: "work" }, valueIdentity: "input" },
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
					input: { definition: definitionRef, entrypoint: "child", basePin: "base", value: { result: "done" }, valueIdentity: "next-input" },
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
async function sendRaw(path: string, payload: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		void Bun.connect({
			unix: path,
			socket: {
				open: (socket) => { socket.write(payload) },
				data: () => undefined,
				close: () => resolve(),
				error: (_socket, error) => reject(error),
			},
		}).catch(reject)
	})
}
