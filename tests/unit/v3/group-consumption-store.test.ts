import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { groupKey, taskKey, type GroupIdentity, type ObjectDomainSnapshot, type Task } from "../../../src/v3/object-domain"
import { makeObjectDomainStoreLive, ObjectDomainStore } from "../../../src/v3/sqlite-store"

type ConsumptionCase = "consumer-ready" | "wrong-group" | "valid"

const expected = {
	"consumer-ready": { outcome: "state-mismatch", durable: "consuming" },
	"wrong-group": { outcome: "identity-mismatch", durable: "consuming" },
	valid: { outcome: "committed", durable: "consumed" },
} as const

describe("group consumption committed transition", () => {
	for (const mode of ["consumer-ready", "wrong-group", "valid"] as const) {
		test(`${mode} preserves the fixed consumer boundary`, async () => {
			const base = join(process.cwd(), ".test-runs")
			await mkdir(base, { recursive: true })
			const root = await mkdtemp(join(base, `group-consumption-${mode}-`))
			try {
				const observed = await runCase(mode, join(root, "runtime.sqlite"))
				expect(observed).toEqual(expected[mode])
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		})
	}
})

async function runCase(mode: ConsumptionCase, databaseFile: string): Promise<{ readonly outcome: string; readonly durable: string }> {
	const chain = { kind: "chain" as const, value: `case-${mode}` }
	const group = { kind: "group" as const, chain, value: "source" }
	const consumerGroup = { kind: "group" as const, chain, value: "consumer" }
	const wrongGroup = { kind: "group" as const, chain, value: "wrong" }
	const memberId = { kind: "task" as const, chain, value: "member" }
	const consumerId = { kind: "task" as const, chain, value: "consumer" }
	const definition = { kind: "published-definition" as const, content: { kind: "definition-content" as const, digest: "content" }, product: { kind: "compiled-product" as const, digest: "product" } }
	const input = { definition, entrypoint: "root", basePin: "base", value: null, valueIdentity: "input" }
	const memberSettlement = { kind: "returned" as const, value: "member-result" }
	const consumerSettlement = { kind: "returned" as const, value: "accepted" }
	const member: Task = { kind: "task", identity: memberId, group, input, dependsOn: [], priority: 0, state: { kind: "settled", settlement: memberSettlement, settledAt: 1 }, closure: { kind: "active", identity: { kind: "closure", task: memberId, attempt: 0 }, basePin: "base", branch: "member", worktree: "/worktree/member", scratch: "/scratch/member" } }
	const consumerFields = { kind: "task" as const, identity: consumerId, group: consumerGroup, input, dependsOn: [], priority: 0 }
	const consumer: Task = mode === "consumer-ready"
		? { ...consumerFields, state: { kind: "ready" }, closure: { kind: "unallocated" } }
		: { ...consumerFields, state: { kind: "settled", settlement: consumerSettlement, settledAt: 2 }, closure: { kind: "active", identity: { kind: "closure", task: consumerId, attempt: 0 }, basePin: "base", branch: "consumer", worktree: "/worktree/consumer", scratch: "/scratch/consumer" } }
	const consumptionGroup: GroupIdentity = mode === "wrong-group" ? wrongGroup : group
	const snapshot: ObjectDomainSnapshot = {
		chain,
		tasks: { [taskKey(memberId)]: member, [taskKey(consumerId)]: consumer },
		groups: {
			[groupKey(group)]: { kind: "task-group", identity: group, members: [memberId], memberVersion: 1, wait: { kind: "none" }, join: { kind: "validator", definition, entrypoint: "root" }, state: { kind: "consuming", consumerTask: consumerId, consumerGroup, settlementsDigest: "digest", startedAt: 2 } },
			[groupKey(consumerGroup)]: { kind: "task-group", identity: consumerGroup, members: [consumerId], memberVersion: 1, wait: { kind: "none" }, join: { kind: "drain" }, state: { kind: "open" } },
		},
		awaits: {},
		admittedFacts: {},
	}
	return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
		const store = yield* ObjectDomainStore
		yield* store.bootstrap(snapshot)
		const exit = yield* Effect.exit(store.commit({
			identity: `consume-${mode}`,
			transition: { family: "group-consumption", group, state: { kind: "consumed", consumption: { kind: "consumption", group: consumptionGroup, value: "checkpoint" }, consumedAt: 3 }, settlements: [memberSettlement] },
		}))
		const durable = (yield* store.readSnapshot(chain)).groups[groupKey(group)]?.state.kind ?? "missing"
		if (exit._tag === "Success") return { outcome: exit.value.kind, durable }
		if (exit.cause._tag === "Fail" && exit.cause.error.kind === "transition-rejected") return { outcome: exit.cause.error.reason, durable }
		return { outcome: "unexpected-failure", durable }
	}).pipe(Effect.provide(makeObjectDomainStoreLive(databaseFile)))))
}
