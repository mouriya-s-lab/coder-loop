import { describe, expect, test } from "bun:test"

import {
	chainMetadataToJsonObject,
	itemExtraToJsonObject,
	storedChainMetadata,
	storedItemExtra,
} from "../../../src/runtime-data"

const hooks = [
	{ kind: "observer", point: "agent.spawn", script: "/bin/observe", timeoutMs: 1000 },
	{ kind: "gate", point: "run.pre-spawn", script: "/bin/gate", timeoutMs: 2000, onFailure: "hold" },
]

describe("hook declaration persistence carriers", () => {
	test("chain metadata round-trips hooks exactly", () => {
		const stored = storedChainMetadata({ hooks })
		expect(chainMetadataToJsonObject(stored)).toEqual({ hooks })
	})

	test("item extra round-trips hooks with unrelated persisted state", () => {
		const stored = storedItemExtra({ hooks, arbitrary: "preserved" })
		expect(itemExtraToJsonObject(stored)).toEqual({ hooks, arbitrary: "preserved" })
	})
})
