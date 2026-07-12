import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
	composeEffectiveHookView,
	loadGlobalHookDeclarations,
	loadEffectiveHookView,
	parseHookDeclarations,
	type HookDeclaration,
} from "./hooks"
import {
	chainMetadataToJsonObject,
	itemExtraToJsonObject,
	storedChainMetadata,
	storedItemExtra,
} from "./runtime-data"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function gate(script: string): HookDeclaration {
	return {
		kind: "gate",
		point: { kind: "run.pre-spawn" },
		script,
		timeoutMs: 1_000,
		onFailure: "hold",
	}
}

describe("hook declaration boundary", () => {
	test("parses observer and all eight gate decision-point variants", () => {
		const declarations = parseHookDeclarations([
			{ kind: "observer", event: "closure.reopen", script: "/hooks/observe", timeoutMs: 500 },
			...[
				"run.pre-spawn",
				"run.post-exit",
				"item.status-transition",
				"container.join",
				"chain-complete",
				"daemon.startup",
				"daemon.shutdown",
			].map((kind) => ({ kind: "gate", point: { kind }, script: `/hooks/${kind}`, timeoutMs: 500, onFailure: "advance" })),
			{ kind: "gate", point: { kind: "tick", minIntervalMs: 2_000 }, script: "/hooks/tick", timeoutMs: 500, onFailure: "hold" },
		], "hooks")

		expect(declarations).toHaveLength(9)
		expect(declarations[0]).toEqual({ kind: "observer", event: "closure.reopen", script: "/hooks/observe", timeoutMs: 500 })
		expect(declarations[8]).toEqual({
			kind: "gate",
			point: { kind: "tick", minIntervalMs: 2_000 },
			script: "/hooks/tick",
			timeoutMs: 500,
			onFailure: "hold",
		})
	})

	test.each([
		["unknown observer event", { kind: "observer", event: "not.an.event", script: "/hooks/x", timeoutMs: 1_000 }, "event"],
		["unknown gate decision point", { kind: "gate", point: { kind: "not-a-point" }, script: "/hooks/x", timeoutMs: 1_000, onFailure: "hold" }, "point"],
		["gate missing onFailure", { kind: "gate", point: { kind: "run.pre-spawn" }, script: "/hooks/x", timeoutMs: 1_000 }, "onFailure"],
		["observer self-reflex", { kind: "observer", event: "hook.start", script: "/hooks/x", timeoutMs: 1_000 }, "hook.*"],
		["tick missing throttle", { kind: "gate", point: { kind: "tick" }, script: "/hooks/x", timeoutMs: 1_000, onFailure: "hold" }, "minIntervalMs"],
		["tick non-positive throttle", { kind: "gate", point: { kind: "tick", minIntervalMs: 0 }, script: "/hooks/x", timeoutMs: 1_000, onFailure: "hold" }, "minIntervalMs"],
	])("rejects %s and names %s", (_label, declaration, field) => {
		expect(() => parseHookDeclarations([declaration], "hooks")).toThrow(String(field))
	})
})

describe("hook carriers and effective view", () => {
	test("missing global hooks.json loads as an empty declaration list", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-hooks-"))
		roots.push(root)
		expect(await loadGlobalHookDeclarations({ loopDataRoot: root })).toEqual([])
	})

	test("global hooks.json rejects malformed declarations at load", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-hooks-"))
		roots.push(root)
		await writeFile(resolve(root, "hooks.json"), JSON.stringify({ hooks: [{ kind: "gate", point: { kind: "run.pre-spawn" }, script: "/hooks/x", timeoutMs: 1_000 }] }))
		await expect(loadGlobalHookDeclarations({ loopDataRoot: root })).rejects.toThrow("onFailure")
	})

	test("chain and item hooks round-trip as typed first-class carriers", () => {
		const chain = storedChainMetadata({ hooks: [gate("/hooks/chain")] })
		const item = storedItemExtra({ hooks: [gate("/hooks/item")] })

		expect(chain.hooks).toEqual([gate("/hooks/chain")])
		expect(item.hooks).toEqual([gate("/hooks/item")])
		expect(chainMetadataToJsonObject(chain).hooks).toEqual([gate("/hooks/chain")])
		expect(itemExtraToJsonObject(item).hooks).toEqual([gate("/hooks/item")])
	})

	test("composes one typed view in global, chain, preset, item order with source identities", () => {
		const view = composeEffectiveHookView({
			global: [gate("/hooks/global")],
			chain: { chainId: 7, declarations: [gate("/hooks/chain")] },
			preset: [{ name: "release-approval", presetName: "shipping" }],
			item: { itemId: 11, declarations: [gate("/hooks/item")] },
		})

		expect(view.entries.map((entry) => entry.kind === "direct" ? `${entry.source.kind}:${entry.declaration.script}` : `preset:${entry.name}`)).toEqual([
			"global:/hooks/global",
			"chain:/hooks/chain",
			"preset:release-approval",
			"item:/hooks/item",
		])
		expect(view.entries[1]).toMatchObject({ kind: "direct", source: { kind: "chain", chainId: 7 } })
		expect(view.entries[2]).toEqual({ kind: "preset-gate-point", source: { kind: "preset", presetName: "shipping" }, name: "release-approval" })
		expect(view.entries[3]).toMatchObject({ kind: "direct", source: { kind: "item", itemId: 11 } })
	})

	test("loads the global carrier and composes it with typed chain, preset, and item layers", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "coder-loop-hooks-"))
		roots.push(root)
		await writeFile(resolve(root, "hooks.json"), JSON.stringify({ hooks: [gate("/hooks/global-loaded")] }))

		const view = await loadEffectiveHookView({
			loopDataRoot: root,
			chain: { chainId: 17, declarations: [gate("/hooks/chain-loaded")] },
			preset: [{ name: "approval", presetName: "release" }],
			item: { itemId: 29, declarations: [gate("/hooks/item-loaded")] },
		})

		expect(view.entries.map((entry) => entry.kind === "direct" ? entry.declaration.script : entry.name)).toEqual([
			"/hooks/global-loaded",
			"/hooks/chain-loaded",
			"approval",
			"/hooks/item-loaded",
		])
	})
})
