import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { groupKey, taskKey, type ObjectDomainSnapshot, type Task, type TaskSettlement } from "../../../src/v3/object-domain"
import { makeObjectDomainStoreLive, ObjectDomainStore } from "../../../src/v3/sqlite-store"

type ConsumerField = "entrypoint" | "value" | "valueIdentity" | "dependsOn"

describe("group consumer committed transition", () => {
	test("rejects consumer task fields not derived from the settlement vector", async () => {
		for (const field of ["entrypoint", "value", "valueIdentity", "dependsOn"] satisfies readonly ConsumerField[]) {
			const base = join(process.cwd(), ".test-runs")
			await mkdir(base, { recursive: true })
			const root = await mkdtemp(join(base, `v3-group-consumer-${field}-`))
			try {
				await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
					const store = yield* ObjectDomainStore
					const chain = { kind: "chain" as const, value: `chain-${field}` }
					const sourceGroup = { kind: "group" as const, chain, value: "source" }
					const first = { kind: "task" as const, chain, value: "first" }
					const second = { kind: "task" as const, chain, value: "second" }
					const definition = {
						kind: "published-definition" as const,
						content: { kind: "definition-content" as const, digest: "content" },
						product: { kind: "compiled-product" as const, digest: "product" },
					}
					const settlements: readonly TaskSettlement[] = [
						{ kind: "returned", value: { answer: 42 } },
						{ kind: "exception", cause: { kind: "exception", cause: { kind: "policy", reason: "program-fault" } }, attempt: 0, closure: { kind: "closure", task: second, attempt: 0 } },
					]
					const member = (identity: Task["identity"], settlement: TaskSettlement): Task => ({
						identity,
						group: sourceGroup,
						input: { definition, entrypoint: identity.value, basePin: "base", value: {}, valueIdentity: `${identity.value}-input` },
						dependsOn: [],
						priority: 1,
						state: { kind: "settled", settlement, settledAt: 1 },
						closure: { kind: "unallocated" },
					})
					const snapshot: ObjectDomainSnapshot = {
						chain,
						tasks: { [taskKey(first)]: member(first, settlements[0]!), [taskKey(second)]: member(second, settlements[1]!) },
						groups: { [groupKey(sourceGroup)]: { identity: sourceGroup, members: [first, second], memberVersion: 2, wait: { kind: "none" }, consumer: { kind: "validator", definition, entrypoint: "validate" }, state: { kind: "terminated", reason: "immediate", memberVersion: 2, terminatedAt: 2 } } },
						awaits: {},
						admittedFacts: {},
					}
					yield* store.bootstrap(snapshot)
					const consumerGroup = { kind: "group" as const, chain, value: "source/$validator/2/group" }
					const consumerTask = { kind: "task" as const, chain, value: "source/$validator/2/task" }
					const value = { settlements }
					const task: Task = {
						identity: consumerTask,
						group: consumerGroup,
						input: {
							definition,
							entrypoint: field === "entrypoint" ? "forged" : "validate",
							basePin: "base",
							value: field === "value" ? { settlements: [] } : value,
							valueIdentity: field === "valueIdentity" ? "forged" : createHash("sha256").update(JSON.stringify(value)).digest("hex"),
						},
						dependsOn: field === "dependsOn" ? [first] : [first, second],
						priority: 1,
						state: { kind: "ready" },
						closure: { kind: "unallocated" },
					}
					const result = yield* Effect.exit(store.commit({
						identity: `reject-${field}`,
						transition: {
							family: "group-consumer-start",
							group: sourceGroup,
							settlements,
							state: { kind: "consuming", consumerTask, consumerGroup, settlementsDigest: createHash("sha256").update(JSON.stringify(settlements)).digest("hex"), startedAt: 3 },
							consumerGroup: { identity: consumerGroup, members: [consumerTask], memberVersion: 1, wait: { kind: "none" }, consumer: { kind: "drain" }, state: { kind: "open" } },
							task,
						},
					}))
					expect(Exit.isFailure(result)).toBe(true)
					const durable = yield* store.readSnapshot(chain)
					expect(durable.groups[groupKey(sourceGroup)]?.state.kind).toBe("terminated")
					expect(durable.groups[groupKey(consumerGroup)]).toBeUndefined()
					expect(durable.tasks[taskKey(consumerTask)]).toBeUndefined()
				}).pipe(Effect.provide(makeObjectDomainStoreLive(join(root, "runtime.sqlite"))))))
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		}
	})
})
