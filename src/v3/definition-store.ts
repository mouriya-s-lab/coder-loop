import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type as arkType } from "arktype"
import { Context, Effect, Layer } from "effect"
import {
	compiledDefinitionProductIdentity,
	definitionContentIdentity,
	strictCompiledProduct,
	type CompileEnvelope,
	type CompiledDefinitionProduct,
	type CompiledProductIdentity,
	type DefinitionContentIdentity,
	type PresetDefinition,
} from "./definition"
import { parseCompiledDefinitionProduct, parsePresetDefinition } from "./schema"

export type DefinitionRef = {
	readonly kind: "published-definition"
	readonly content: DefinitionContentIdentity
	readonly product: CompiledProductIdentity
}

export type DefinitionBundle = {
	readonly ref: DefinitionRef
	readonly assets: Readonly<Record<string, Uint8Array>>
	readonly definition: PresetDefinition
	readonly product: CompiledDefinitionProduct
}

export type DefinitionStoreError =
	| { readonly kind: "compile-rejected"; readonly envelope: CompileEnvelope }
	| { readonly kind: "compile-incomplete"; readonly envelope: CompileEnvelope }
	| { readonly kind: "publish-io"; readonly stage: "prepare" | "write" | "fsync" | "rename"; readonly path: string; readonly message: string }
	| { readonly kind: "identity-collision"; readonly ref: DefinitionRef }
	| {
		readonly kind: "resolve-rejected"
		readonly ref: DefinitionRef
		readonly reason: "path-traversal" | "invalid-digest"
	}
	| {
		readonly kind: "definition-corrupt"
		readonly ref: DefinitionRef
		readonly reason: "missing-artifact" | "manifest-invalid" | "asset-missing" | "asset-digest-mismatch" | "identity-mismatch"
		readonly asset: string | null
	}

export type DefinitionStoreService = {
	readonly publish: (
		envelope: CompileEnvelope,
		assets: Readonly<Record<string, string | Uint8Array>>,
	) => Effect.Effect<DefinitionRef, DefinitionStoreError>
	readonly resolve: (ref: DefinitionRef) => Effect.Effect<DefinitionBundle, DefinitionStoreError>
	readonly assetPath: (ref: DefinitionRef, asset: string) => Effect.Effect<string, DefinitionStoreError>
}

export class DefinitionStore extends Context.Tag("coder-loop/v3/DefinitionStore")<DefinitionStore, DefinitionStoreService>() {}

const ManifestBoundary = arkType({
	schemaVersion: "3",
	contentIdentity: "string > 0",
	productIdentity: "string > 0",
	assets: {
		"[string]": {
			digest: "string > 0",
			bytes: "number.integer >= 0",
		},
	},
})

type Manifest = typeof ManifestBoundary.infer

export function makeDefinitionStoreLive(root: string): Layer.Layer<DefinitionStore> {
	return Layer.succeed(DefinitionStore, {
		publish: (envelope, assets) => publishDefinition(root, envelope, assets),
		resolve: (ref) => resolveDefinition(root, ref),
		assetPath: (ref, asset) => Effect.map(resolveDefinition(root, ref), () => safeAssetPath(definitionPath(root, ref), asset)),
	})
}

function publishDefinition(
	root: string,
	envelope: CompileEnvelope,
	assets: Readonly<Record<string, string | Uint8Array>>,
): Effect.Effect<DefinitionRef, DefinitionStoreError> {
	const strict = strictCompiledProduct(envelope)
	if (strict.kind === "rejected") return Effect.fail({ kind: strict.reason, envelope: strict.envelope })

	const publishedProduct = Buffer.from(`${JSON.stringify(strict.product)}\n`)
	const publishedAssets = { ...assets, "compiled-product.json": publishedProduct }
	const content = definitionContentIdentity(publishedAssets)
	const ref: DefinitionRef = { kind: "published-definition", content, product: strict.product.identity }
	const target = definitionPath(root, ref)
	const staging = join(root, ".staging", `${content.digest}-${randomUUID()}`)
	const normalizedAssets = Object.fromEntries(Object.entries(publishedAssets).map(([path, bytes]) => [path, typeof bytes === "string" ? Buffer.from(bytes) : bytes]))
	const manifest: Manifest = {
		schemaVersion: 3,
		contentIdentity: content.digest,
		productIdentity: strict.product.identity.digest,
		assets: Object.fromEntries(Object.entries(normalizedAssets).map(([path, bytes]) => [path, { digest: bytesDigest(bytes), bytes: bytes.byteLength }])),
	}

	return Effect.tryPromise({
		try: async () => {
			await stagedIo("prepare", staging, () => mkdir(staging, { recursive: true }))
			const directories = new Set<string>([staging])
			for (const [relativePath, bytes] of Object.entries(normalizedAssets)) {
				const path = safeAssetPath(staging, relativePath)
				await stagedIo("prepare", dirname(path), () => mkdir(dirname(path), { recursive: true }))
				directories.add(dirname(path))
				const handle = await stagedIo("write", path, () => open(path, "wx"))
				try {
					await stagedIo("write", path, () => handle.writeFile(bytes))
					await stagedIo("fsync", path, () => handle.sync())
				} finally {
					await handle.close()
				}
			}
			for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
				await stagedIo("fsync", directory, () => syncDirectory(directory))
			}
			const manifestPath = join(staging, "manifest.json")
			const manifestHandle = await stagedIo("write", manifestPath, () => open(manifestPath, "wx"))
			try {
				await stagedIo("write", manifestPath, () => manifestHandle.writeFile(`${JSON.stringify(manifest)}\n`))
				await stagedIo("fsync", manifestPath, () => manifestHandle.sync())
			} finally {
				await manifestHandle.close()
			}
			const stagingHandle = await stagedIo("fsync", staging, () => open(staging, "r"))
			try {
				await stagedIo("fsync", staging, () => stagingHandle.sync())
			} finally {
				await stagingHandle.close()
			}

			const verified = await resolveBundleFromPath(staging, ref)
			if (verified.kind === "error") throw new DefinitionProtocolFailure(verified.error)
			await stagedIo("prepare", dirname(target), () => mkdir(dirname(target), { recursive: true }))
			try {
				await stagedIo("rename", staging, () => rename(staging, target))
				await stagedIo("fsync", dirname(target), () => syncDirectory(dirname(target)))
			} catch (error) {
				if (error instanceof DefinitionProtocolFailure) throw error
				if (!(await pathExists(target))) {
					throw error instanceof StagedIoFailure ? error : new StagedIoFailure("rename", staging, error)
				}
				const existing = await resolveBundleFromPath(target, ref)
				if (existing.kind === "error") throw new DefinitionProtocolFailure({ kind: "identity-collision", ref })
				await rm(staging, { recursive: true, force: true })
			}
			return ref
		},
		catch: (error): DefinitionStoreError => {
			if (error instanceof DefinitionProtocolFailure) return error.failure
			if (error instanceof StagedIoFailure) return { kind: "publish-io", stage: error.stage, path: error.path, message: error.message }
			throw error
		},
	})
}

function resolveDefinition(root: string, ref: DefinitionRef): Effect.Effect<DefinitionBundle, DefinitionStoreError> {
	const digest = ref.content.digest
	if (digest.length === 0) return Effect.fail({ kind: "resolve-rejected", ref, reason: "invalid-digest" })
	if (digest.startsWith("/") || digest.split(/[\\/]+/u).includes("..")) {
		return Effect.fail({ kind: "resolve-rejected", ref, reason: "path-traversal" })
	}
	return Effect.tryPromise({
		try: async () => {
			const resolved = await resolveBundleFromPath(definitionPath(root, ref), ref)
			if (resolved.kind === "error") throw new DefinitionProtocolFailure(resolved.error)
			return resolved.bundle
		},
		catch: (error): DefinitionStoreError => {
			if (error instanceof DefinitionProtocolFailure) return error.failure
			throw error
		},
	})
}

async function resolveBundleFromPath(
	path: string,
	ref: DefinitionRef,
): Promise<{ readonly kind: "ok"; readonly bundle: DefinitionBundle } | { readonly kind: "error"; readonly error: DefinitionStoreError }> {
	let rawManifest: Uint8Array
	try {
		rawManifest = await readFile(join(path, "manifest.json"))
	} catch {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "missing-artifact", asset: null } }
	}

	let decoded: unknown
	try {
		decoded = JSON.parse(Buffer.from(rawManifest).toString("utf8"))
	} catch {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "manifest.json" } }
	}
	const parsed = ManifestBoundary(decoded)
	if (parsed instanceof arkType.errors) {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "manifest.json" } }
	}
	if (parsed.contentIdentity !== ref.content.digest || parsed.productIdentity !== ref.product.digest) {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "identity-mismatch", asset: "manifest.json" } }
	}

	const assets: Record<string, Uint8Array> = {}
	for (const [relativePath, expected] of Object.entries(parsed.assets)) {
		let bytes: Uint8Array
		try {
			bytes = await readFile(safeAssetPath(path, relativePath))
		} catch {
			return { kind: "error", error: { kind: "definition-corrupt", ref, reason: relativePath === "compiled-product.json" ? "missing-artifact" : "asset-missing", asset: relativePath } }
		}
		if (bytes.byteLength !== expected.bytes || bytesDigest(bytes) !== expected.digest) {
			return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "asset-digest-mismatch", asset: relativePath } }
		}
		assets[relativePath] = bytes
	}
	const identity = definitionContentIdentity(assets)
	if (identity.digest !== ref.content.digest) {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "identity-mismatch", asset: null } }
	}
	const definitionAsset = assets["definition.json"]
	if (definitionAsset === undefined) return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "missing-artifact", asset: "definition.json" } }
	let definitionCandidate: unknown
	try {
		definitionCandidate = JSON.parse(new TextDecoder().decode(definitionAsset))
	} catch {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "definition.json" } }
	}
	const definition = parsePresetDefinition(definitionCandidate)
	if (definition.kind === "rejected") return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "definition.json" } }
	const productAsset = assets["compiled-product.json"]
	if (productAsset === undefined) return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "missing-artifact", asset: "compiled-product.json" } }
	let productCandidate: unknown
	try {
		productCandidate = JSON.parse(new TextDecoder().decode(productAsset))
	} catch {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "compiled-product.json" } }
	}
	const product = parseCompiledDefinitionProduct(productCandidate)
	if (product === null) return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "manifest-invalid", asset: "compiled-product.json" } }
	const expectedIdentity = compiledDefinitionProductIdentity(product.definition, product.taskIndex, product.valueIndex)
	if (!publishedProductIndexesMatch(product) || product.identity.digest !== expectedIdentity.digest || product.identity.digest !== ref.product.digest) {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "identity-mismatch", asset: "compiled-product.json" } }
	}
	if (JSON.stringify(definition.definition) !== JSON.stringify(product.definition)) {
		return { kind: "error", error: { kind: "definition-corrupt", ref, reason: "identity-mismatch", asset: "definition.json" } }
	}
	return { kind: "ok", bundle: { ref, assets, definition: product.definition, product } }
}

function publishedProductIndexesMatch(product: CompiledDefinitionProduct): boolean {
	const expectedTasks: Record<string, unknown> = {}
	const visit = (task: CompiledDefinitionProduct["definition"]["task"]): void => {
		expectedTasks[task.id] = task
		if (task.kind === "leaf") return
		if (task.kind === "par") expectedTasks[task.finalizer.task.id] = task.finalizer.task
		for (const child of task.children) visit(child)
	}
	visit(product.definition.task)
	const expectedValues = Object.fromEntries(product.definition.values.map((value) => [value.name, value]))
	return JSON.stringify(product.taskIndex) === JSON.stringify(expectedTasks)
		&& JSON.stringify(product.valueIndex) === JSON.stringify(expectedValues)
}

function definitionPath(root: string, ref: DefinitionRef): string {
	return join(root, "definitions", ref.content.digest)
}


function safeAssetPath(root: string, relativePath: string): string {
	if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.split(/[\\/]+/u).includes("..")) {
		throw new Error(`invalid definition asset path: ${relativePath}`)
	}
	return join(root, relativePath)
}

function bytesDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r")
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

class DefinitionProtocolFailure extends Error {
	constructor(readonly failure: DefinitionStoreError) {
		super(failure.kind)
	}
}

class StagedIoFailure extends Error {
	constructor(
		readonly stage: Extract<DefinitionStoreError, { kind: "publish-io" }>["stage"],
		readonly path: string,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : String(cause))
	}
}

async function stagedIo<T>(
	stage: Extract<DefinitionStoreError, { kind: "publish-io" }>["stage"],
	path: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run()
	} catch (error) {
		if (error instanceof StagedIoFailure || error instanceof DefinitionProtocolFailure) throw error
		throw new StagedIoFailure(stage, path, error)
	}
}
