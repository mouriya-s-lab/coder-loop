import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { parseFunctionCheckpoint } from "../../../src/v3/persistence"
import { FunctionRuntime, makeFunctionRuntimeLive, restoreAgentSessionFromCheckpoint } from "../../../src/v3/function-runtime"
import { compilePresetDefinition, resolveCompileAssets, strictCompiledProduct, type DeclaredValue, type PresetDefinition } from "../../../src/v3/definition"
import { DefinitionStore } from "../../../src/v3/definition-store"
import { MapRuntime, PredicateRuntime } from "../../../src/v3/function-adapters"
import { HookRuntime } from "../../../src/v3/hooks"
import { groupKey, taskKey, type ObjectDomainSnapshot, type Task } from "../../../src/v3/object-domain"
import { ProviderFactStore, RunnerProvider } from "../../../src/v3/provider"
import { makeObjectDomainStoreLive, ObjectDomainStore } from "../../../src/v3/sqlite-store"

const run = { kind: "agent-run" as const, chainId: "chain", taskId: "task", closureId: "closure", runId: "run" }
const common = { run, stepId: "step", runnerSessionIdentity: null }

describe("function checkpoint persistence", () => {
	test("rejects temporal gaps and non-monotonic context", () => {
		const valid = {
			...common,
			stage: "context-3",
			context0: { stage: "context-0", values: { item: { first: 1, second: 2 } } },
			context1: { stage: "context-1", values: { item: { second: 2, first: 1 }, pre: 3 } },
			prompt: { kind: "frozen-prompt", text: "prompt", inputValues: { pre: 3, item: { first: 1, second: 2 } } },
			context2: { stage: "context-2", values: { item: { first: 1, second: 2 }, pre: 3, agent: "accepted" } },
			context3: { stage: "context-3", values: { item: { first: 1, second: 2 }, pre: 3, agent: "accepted", post: true } },
			agent: { state: "closed", accepted: { post: false } },
			predicates: { ready: true },
		}
		const cases = [
			{ name: "missing predecessors", value: { ...valid, context0: null, context1: null, prompt: null, context3: null, predicates: {} } },
			{ name: "rewritten predecessor", value: { ...valid, context1: { stage: "context-1", values: { item: "rewritten", pre: 3 } } } },
			{ name: "prompt drift", value: { ...valid, prompt: { kind: "frozen-prompt", text: "prompt", inputValues: { item: { first: 1, second: 2 } } } } },
			{ name: "agent bypass", value: valid },
			{ name: "early predicates", value: { ...valid, stage: "context-2", context3: null } },
			{ name: "open agent overwrites context-1", value: { ...valid, stage: "agent-open", context2: null, context3: null, agent: { state: "open", accepted: { item: "forged" } }, predicates: {} } },
		]
		for (const entry of cases) expect(parseFunctionCheckpoint(entry.value), entry.name).toMatchObject({ kind: "rejected" })
	})

	test("accepts a complete monotonic checkpoint independent of object key order", () => {
		const value = {
			...common,
			stage: "context-3",
			context0: { stage: "context-0", values: { item: { first: 1, second: 2 } } },
			context1: { stage: "context-1", values: { item: { second: 2, first: 1 }, pre: 3 } },
			prompt: { kind: "frozen-prompt", text: "prompt", inputValues: { pre: 3, item: { first: 1, second: 2 } } },
			context2: { stage: "context-2", values: { item: { first: 1, second: 2 }, pre: 3, agent: "accepted" } },
			context3: { stage: "context-3", values: { item: { first: 1, second: 2 }, pre: 3, agent: "accepted", post: true } },
			agent: { state: "closed", accepted: { item: { second: 2, first: 1 }, pre: 3, agent: "accepted" } },
			predicates: { ready: true },
		}
		expect(parseFunctionCheckpoint(value)).toMatchObject({ kind: "accepted", value: { stage: "context-3", context3: { values: { post: true } } } })
	})

	test("reparses recovered agent values against pinned declarations", () => {
		const declarations: readonly DeclaredValue[] = [
			{ name: "item", type: { kind: "string" }, source: { kind: "item" }, required: true },
			{ name: "answer", type: { kind: "number" }, source: { kind: "agent" }, required: true },
		]
		const prefix = {
			...common,
			context0: { stage: "context-0" as const, values: { item: "input" } },
			context1: { stage: "context-1" as const, values: { item: "input" } },
			prompt: { kind: "frozen-prompt" as const, text: "prompt", inputValues: { item: "input" } },
			context3: null,
			predicates: {},
		}
		const wrongType = {
			...prefix,
			stage: "context-2" as const,
			context2: { stage: "context-2" as const, values: { item: "input", answer: "not-a-number" } },
			agent: { state: "closed" as const, accepted: { item: "input", answer: "not-a-number" } },
		}
		const undeclared = {
			...prefix,
			stage: "context-2" as const,
			context2: { stage: "context-2" as const, values: { item: "input", answer: 42, forged: true } },
			agent: { state: "closed" as const, accepted: { item: "input", answer: 42, forged: true } },
		}
		const valid = {
			...prefix,
			stage: "context-2" as const,
			context2: { stage: "context-2" as const, values: { item: "input", answer: 42 } },
			agent: { state: "closed" as const, accepted: { item: "input", answer: 42 } },
		}
		expect(restoreAgentSessionFromCheckpoint(wrongType, declarations)).toBeNull()
		expect(restoreAgentSessionFromCheckpoint(undeclared, declarations)).toBeNull()
		expect(restoreAgentSessionFromCheckpoint(valid, declarations)).toEqual({ state: "closed", authority: run, context: valid.context2 })
	})

	test("execute settles closed checkpoints whose agent values fail pinned parsing", async () => {
		const root = await mkdtemp(join(process.cwd(), ".test-runs-v3-checkpoint-"))
		try {
			const definition: PresetDefinition = {
				schemaVersion: 3,
				name: "checkpoint-recovery",
				sourceIdentity: { kind: "definition-source", digest: "source" },
				values: [
					{ name: "item", type: { kind: "string" }, source: { kind: "item" }, required: true },
					{ name: "answer", type: { kind: "number" }, source: { kind: "agent" }, required: true },
				],
				consumers: [{ kind: "prompt", value: "item" }],
				task: { kind: "leaf", id: "root", promptAsset: "prompt.txt", contract: { returns: { kind: "number" }, returnValue: "answer", predicates: [], successors: [], chooser: null, onNil: "return-nil", onException: "fail" } },
			}
			const compiled = compilePresetDefinition(definition)
			expect(compiled.kind).toBe("compiled")
			if (compiled.kind !== "compiled") return
			const strict = strictCompiledProduct(resolveCompileAssets(compiled, { "prompt.txt": "answer {{item}}" }))
			expect(strict.kind).toBe("accepted")
			if (strict.kind !== "accepted") return
			const ref = { kind: "published-definition" as const, content: { kind: "definition-content" as const, digest: "content" }, product: strict.product.identity }
			const bundle = { ref, definition, product: strict.product, assets: { "prompt.txt": new TextEncoder().encode("answer {{item}}") } }
			const chain = { kind: "chain" as const, value: "checkpoint-recovery" }
			const group = { kind: "group" as const, chain, value: "root" }
			const identity = { kind: "task" as const, chain, value: "root" }
			const closure = { kind: "closure" as const, task: identity, attempt: 0 }
			const leasedRun = { kind: "run" as const, closure, value: "run" }
			const task: Task = { kind: "task", identity, group, input: { definition: ref, entrypoint: "root", basePin: "base", value: { item: "input" }, valueIdentity: "input" }, dependsOn: [], priority: 0, state: { kind: "leased", run: leasedRun, acquiredAt: 1, expiresAt: 9999999999999 }, closure: { kind: "active", identity: closure, basePin: "base", branch: "branch", worktree: root, scratch: join(root, "scratch") } }
			const snapshot: ObjectDomainSnapshot = { chain, tasks: { [taskKey(identity)]: task }, groups: { [groupKey(group)]: { kind: "task-group", identity: group, members: [identity], memberVersion: 1, wait: { kind: "none" }, join: { kind: "drain" }, state: { kind: "open" } } }, awaits: {}, admittedFacts: {} }
			const authority = { kind: "agent-run" as const, chainId: chain.value, taskId: taskKey(identity), closureId: `${taskKey(identity)}/0`, runId: leasedRun.value }
			const checkpointPrefix = { run: authority, stepId: "root", runnerSessionIdentity: null, context0: { stage: "context-0" as const, values: { item: "input" } }, context1: { stage: "context-1" as const, values: { item: "input" } }, prompt: { kind: "frozen-prompt" as const, text: "answer input", inputValues: { item: "input" } }, context2: { stage: "context-2" as const, values: { item: "input", answer: "wrong-type" } }, agent: { state: "closed" as const, accepted: { item: "input", answer: "wrong-type" } }, predicates: {} }

			for (const stage of ["context-2", "context-3"] as const) {
				const checkpoint = stage === "context-2"
					? { ...checkpointPrefix, stage, context3: null }
					: { ...checkpointPrefix, stage, context3: { stage: "context-3" as const, values: { item: "input", answer: "wrong-type" } } }
				const store = makeObjectDomainStoreLive(join(root, `${stage}.sqlite`))
				const dependencies = Layer.mergeAll(
					store,
					Layer.succeed(DefinitionStore, { publish: () => Effect.die("unused"), resolve: () => Effect.succeed(bundle), assetPath: () => Effect.die("unused") }),
					Layer.succeed(MapRuntime, { execute: () => Effect.succeed([]) }),
					Layer.succeed(PredicateRuntime, { evaluate: () => Effect.succeed({}) }),
					Layer.succeed(HookRuntime, { trigger: () => Effect.succeed([]), recover: Effect.succeed([]), listAudit: Effect.succeed([]), shutdown: Effect.void }),
					Layer.succeed(ProviderFactStore, { commit: (_identity, fact) => Effect.succeed(fact), read: () => Effect.succeed(null), list: Effect.succeed([]) }),
					Layer.succeed(RunnerProvider, { endpoint: { kind: "runner-endpoint", digest: "runner" }, probe: Effect.succeed({ kind: "ready" as const, endpoint: { kind: "runner-endpoint" as const, digest: "runner" }, evidence: { observedAt: 1, detail: "ready" } }), recordAbsence: () => Effect.die("unused"), invoke: () => Effect.die("unused") }),
				)
				const layers = makeFunctionRuntimeLive({ socketPath: join(root, "agent.sock"), submitArgv: ["coder-loop", "agent", "submit"] }).pipe(Layer.provideMerge(dependencies))
				await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
					const objectStore = yield* ObjectDomainStore
					const runtime = yield* FunctionRuntime
					yield* objectStore.bootstrap(snapshot)
					yield* objectStore.writeFunctionCheckpoint(checkpoint)
					const result = yield* runtime.execute(identity)
					expect(result, stage).toMatchObject({ kind: "settled", settlement: { kind: "exception", cause: { cause: { kind: "policy", reason: "program-fault" } } } })
				})).pipe(Effect.provide(layers)))
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
