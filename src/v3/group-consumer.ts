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
		const consumer = group.consumer.kind === "drain"
			? "drain"
			: `${group.consumer.kind}:${group.consumer.definition.content.digest}:${group.consumer.definition.product.digest}`
		return Effect.succeed({ kind: "consumption", group: group.identity, value: `${consumer}:${group.memberVersion}:${JSON.stringify(vector)}` })
	},
})
