import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { compilePresetDefinition, resolveCompileAssets, type PresetDefinition } from "../../../src/v3/definition"
import { DefinitionStore, makeDefinitionStoreLive } from "../../../src/v3/definition-store"

const definition: PresetDefinition = {
	schemaVersion: 3,
	name: "published-product-test",
	sourceIdentity: { kind: "definition-source", digest: "source" },
	values: [
		{ name: "request", type: { kind: "string" }, source: { kind: "item" }, required: true },
		{ name: "result", type: { kind: "string" }, source: { kind: "agent" }, required: true },
	],
	consumers: [{ kind: "prompt", value: "request" }],
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

describe("DefinitionStore published compiled product", () => {
	test("publish persists and resolve reads the accepted product", async () => {
		const root = await mkdtemp(join(tmpdir(), "coder-loop-definition-store-"))
		try {
			const assets = { "definition.json": `${JSON.stringify(definition)}\n`, "prompt.txt": "Run" }
			const envelope = resolveCompileAssets(compilePresetDefinition(definition), assets)
			const program = Effect.gen(function*() {
				const store = yield* DefinitionStore
				const ref = yield* store.publish(envelope, assets)
				const bundle = yield* store.resolve(ref)
				return { ref, bundle }
			}).pipe(Effect.provide(makeDefinitionStoreLive(root)))
			const { ref, bundle } = await Effect.runPromise(program)

			expect(bundle.product.identity).toEqual(ref.product)
			expect(Object.keys(bundle.product.taskIndex)).toEqual(["root"])
			expect(Object.keys(bundle.product.valueIndex)).toEqual(["request", "result"])
			expect(JSON.parse(await readFile(join(root, "definitions", ref.content.digest, "compiled-product.json"), "utf8"))).toEqual(bundle.product)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("missing published product is a typed corrupt definition", async () => {
		const root = await mkdtemp(join(tmpdir(), "coder-loop-definition-store-"))
		try {
			const assets = { "definition.json": `${JSON.stringify(definition)}\n`, "prompt.txt": "Run" }
			const envelope = resolveCompileAssets(compilePresetDefinition(definition), assets)
			const storeLayer = makeDefinitionStoreLive(root)
			const ref = await Effect.runPromise(Effect.flatMap(DefinitionStore, (store) => store.publish(envelope, assets)).pipe(Effect.provide(storeLayer)))
			await unlink(join(root, "definitions", ref.content.digest, "compiled-product.json"))
			const resolved = await Effect.runPromise(Effect.either(Effect.flatMap(DefinitionStore, (store) => store.resolve(ref))).pipe(Effect.provide(storeLayer)))
			expect(resolved).toMatchObject({
				_tag: "Left",
				left: { kind: "definition-corrupt", reason: "missing-artifact", asset: "compiled-product.json" },
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
