import { Context, Effect, Layer } from "effect"
import type { ConsumptionIdentity, TaskGroup, TaskSettlement } from "./object-domain"

export type GroupConsumerService = {
	readonly consume: (group: TaskGroup, settlements: readonly TaskSettlement[]) => Effect.Effect<ConsumptionIdentity>
}

export class GroupConsumerRuntime extends Context.Tag("coder-loop/v3/GroupConsumerRuntime")<GroupConsumerRuntime, GroupConsumerService>() {}

export const GroupConsumerRuntimeLive: Layer.Layer<GroupConsumerRuntime> = Layer.succeed(GroupConsumerRuntime, {
	consume: (group, settlements) => {
		const vector = settlements.map((settlement) => settlement.kind === "returned"
			? { kind: settlement.kind, value: settlement.value }
			: { kind: settlement.kind, attempt: settlement.attempt, closure: settlement.closure })
		const consumer = groupConsumerIdentity(group.consumer)
		return Effect.succeed({ kind: "consumption", group: group.identity, value: `${consumer}:${group.memberVersion}:${JSON.stringify(vector)}` })
	},
})

function groupConsumerIdentity(consumer: TaskGroup["consumer"]): string {
	switch (consumer.kind) {
		case "drain":
			return "drain"
		case "validator":
		case "finalizer":
			return `${consumer.kind}:${consumer.definition.content.digest}:${consumer.definition.product.digest}`
	}
	return assertNever(consumer)
}

function assertNever(value: never): never {
	throw new Error(`unreachable variant: ${JSON.stringify(value)}`)
}
