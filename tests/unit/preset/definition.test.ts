import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
	compilePreset,
	projectPresetCompileResult,
	publishPresetDefinition,
	presetDefinitionRefFromDigest,
	resolvePresetDefinition,
	type PresetDefinitionRef,
} from "../../../src/loop"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const VALID = resolve(REPO_ROOT, "test-fixtures/preset-definition/recursive-valid")
const INVALID = resolve(REPO_ROOT, "test-fixtures/preset-definition/recursive-invalid")
const scratch: string[] = []

afterEach(async () => {
	await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("pinned recursive preset definition", () => {
	test("compile is total and exposes distinct identities without legacy authority keys", async () => {
		const compiled = await compilePreset(VALID)
		expect(compiled.kind).toBe("compiled")
		if (compiled.kind !== "compiled") return

		const projected = projectPresetCompileResult(compiled)
		expect(projected.kind).toBe("compiled")
		if (projected.kind !== "compiled") return
		expect(projected.envelopeIdentity).toStartWith("compile-sha256:")
		expect(projected.productIdentity).toStartWith("product-sha256:")
		expect(projected.definitionContentIdentity).toStartWith("content-sha256:")
		expect(new Set([
			projected.envelopeIdentity,
			projected.productIdentity,
			projected.definitionContentIdentity,
		]).size).toBe(3)
		expect(projected.definition.root.children.map((child) => child.name)).toEqual(["prepare", "finish"])
		expect(JSON.stringify(projected)).not.toMatch(/\"(?:statuses|stateGraph|phases)\"\s*:/)
	})

	test("rejected envelope carries a non-empty typed diagnostic collection", async () => {
		const result = projectPresetCompileResult(await compilePreset(INVALID))
		expect(result.kind).toBe("rejected")
		if (result.kind !== "rejected") return
		expect(result.diagnostics.length).toBeGreaterThan(0)
		expect(result.diagnostics[0]).toMatchObject({ verdict: "error" })
	})

	test("publish is idempotent and exact-ref resolve fails closed on corruption", async () => {
		const storeRoot = await mkdtemp(resolve(tmpdir(), "coder-loop-definition-test-"))
		scratch.push(storeRoot)
		const compiled = await compilePreset(VALID)
		expect(compiled.kind).toBe("compiled")
		if (compiled.kind !== "compiled") return

		const [first, raced] = await Promise.all([
			publishPresetDefinition(compiled, storeRoot),
			publishPresetDefinition(compiled, storeRoot),
		])
		const second = await publishPresetDefinition(compiled, storeRoot)
		expect(raced).toEqual(first)
		expect(second).toEqual(first)
		const resolved = await resolvePresetDefinition(first.ref, storeRoot)
		expect(resolved.kind).toBe("resolved")
		if (resolved.kind !== "resolved") return
		expect(resolved.envelope.definitionContentIdentity).toBe(first.ref.contentIdentity)

		const manifestPath = resolve(first.bundleDir, "manifest.json")
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { assets: Array<{ path: string }> }
		const asset = manifest.assets[0]
		expect(asset).toBeDefined()
		if (asset === undefined) return
		await writeFile(resolve(first.bundleDir, "assets", asset.path), "corrupt")
		const corrupt = await resolvePresetDefinition(first.ref, storeRoot)
		expect(corrupt).toMatchObject({ kind: "corrupt", reason: "asset-digest-mismatch" })

		const missingRef: PresetDefinitionRef = presetDefinitionRefFromDigest("0".repeat(64))
		expect(await resolvePresetDefinition(missingRef, storeRoot)).toMatchObject({ kind: "corrupt", reason: "missing-bundle" })
	})
})
