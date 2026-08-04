import { Context, Effect, Layer } from "effect"
import type { ConsumptionIdentity, TaskGroup, TaskSettlement } from "./object-domain"


export type GroupConsumerService = {
	readonly consume: (group: TaskGroup, settlements: readonly TaskSettlement[]) => Effect.Effect<ConsumptionIdentity | null>
}

export class GroupConsumerRuntime extends Context.Tag("coder-loop/v3/GroupConsumerRuntime")<GroupConsumerRuntime, GroupConsumerService>() {}

export const GroupConsumerRuntimeLive: Layer.Layer<GroupConsumerRuntime> = Layer.succeed(GroupConsumerRuntime, {
	consume: (group, settlements) => {
		if (group.consumer.kind !== "drain") return Effect.succeed(null)
		const vector = settlements.map((settlement) => settlement.kind === "returned" ? { kind: settlement.kind, value: settlement.value } : { kind: settlement.kind, attempt: settlement.attempt, closure: settlement.closure })
		return Effect.succeed({ kind: "consumption", group: group.identity, value: `drain:${group.memberVersion}:${JSON.stringify(vector)}` })
	},
})
