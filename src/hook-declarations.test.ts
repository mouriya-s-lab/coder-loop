import { describe, expect, test } from "bun:test"

import { buildEffectiveHookView, parseGlobalHookDocument, parseHookDeclarations } from "./hook-declarations"
import { chainMetadataToJsonObject, itemExtraToJsonObject, storedChainMetadata, storedItemExtra } from "./runtime-data"

const observer = { kind: "observer", point: "agent.spawn", script: "/bin/observe", timeoutMs: 1000 }
const gate = { kind: "gate", point: "run.pre-spawn", script: "/bin/gate", timeoutMs: 2000, onFailure: "hold" }

describe("hook declarations", () => {
	test("merges all four layers in provenance order", () => {
		const view = buildEffectiveHookView({
			global: parseHookDeclarations([observer], "global"),
			chain: parseHookDeclarations([gate], "chain"),
			preset: [{ kind: "named-gate-placeholder", name: "approval", point: "item.status-transition" }],
			item: parseHookDeclarations([{ ...observer, script: "/bin/item" }], "item"),
		})
		expect(view.map((entry) => entry.source)).toEqual(["global", "chain", "preset", "item"])
		expect(view[2]).toEqual({ source: "preset", declaration: { kind: "named-gate-placeholder", name: "approval", point: "item.status-transition" } })
	})

	test("parses the versioned global document and round-trips typed carriers", () => {
		const hooks = parseGlobalHookDocument({ version: 1, hooks: [observer, gate] })
		const metadata = storedChainMetadata({ hooks })
		const extra = storedItemExtra({ hooks })
		expect(chainMetadataToJsonObject(metadata).hooks).toEqual([observer, gate])
		expect(itemExtraToJsonObject(extra).hooks).toEqual([observer, gate])
	})

	test.each([
		[[{ ...observer, point: "unknown.event" }], "point"],
		[[{ ...gate, point: "unknown-gate" }], "point"],
		[[{ kind: "gate", point: "tick", script: "/bin/gate", timeoutMs: 1 }], "onFailure"],
		[[{ ...observer, onFailure: "garbage" }], "onFailure"],
		[[{ ...observer, script: "" }], "script"],
		[[{ ...observer, timeoutMs: 0 }], "timeoutMs"],
		[[{ ...observer, point: "hook.start" }], "point"],
	])("rejects malformed declaration %#", (input, field) => {
		expect(() => parseHookDeclarations(input, "hooks")).toThrow(field)
	})
})
