import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

export type CompileEnvelopeIdentity = string & { readonly CompileEnvelopeIdentity: unique symbol }
export type CompiledProductIdentity = string & { readonly CompiledProductIdentity: unique symbol }
export type DefinitionContentIdentity = string & { readonly DefinitionContentIdentity: unique symbol }
export type DefinitionNodeIdentity = string & { readonly DefinitionNodeIdentity: unique symbol }

export type DefinitionFinding = {
	identity: string
	verdict: "warn"
	rule: string
	message: string
}

export type DefinitionHandoff =
	| { kind: "item-status"; status: string; when: string }
	| { kind: "chain-action"; action: "stop"; when: string }

export type DefinitionActivation =
	| { kind: "after-step"; step: string; whenStatus: string }
	| { kind: "chain-complete" }
	| { kind: "frontier" }

export type RecursiveStepDefinition = {
	kind: "step"
	identity: DefinitionNodeIdentity
	name: string
	promptAsset: string
	handoffs: readonly DefinitionHandoff[]
	activation: DefinitionActivation
	runner: string | null
	model: string | null
	values: readonly { key: string; type: "string"; sourceKind: "item" | "chain" | "runtime" }[]
	rights: { createItems: boolean; writableFields: readonly string[]; privilegedOps: readonly string[] }
}

export type RecursiveTaskDefinition = {
	name: string
	item: { idField: string; fields: readonly { name: string; type: string }[] }
	routing: {
		continuable: readonly string[]
		terminal: readonly string[]
		success: readonly string[]
		entry: string
		unblockable: readonly string[]
		exhausted: string
		retry: string | null
	}
	root: {
		kind: "sequence"
		identity: DefinitionNodeIdentity
		children: readonly RecursiveStepDefinition[]
	}
	fragments: readonly { id: string; role: string; asset: string }[]
}

export type CompiledDefinitionEnvelope = {
	kind: "compiled"
	schemaVersion: 2
	envelopeIdentity: CompileEnvelopeIdentity
	productIdentity: CompiledProductIdentity
	definitionContentIdentity: DefinitionContentIdentity
	definitionRef: PresetDefinitionRef
	definition: RecursiveTaskDefinition
	findings: readonly DefinitionFinding[]
}

export type PresetDefinitionRef = {
	kind: "preset-definition"
	schemaVersion: 1
	contentIdentity: DefinitionContentIdentity
}

export function presetDefinitionRefFromDigest(digest: string): PresetDefinitionRef {
	const contentIdentity = `content-sha256:${normalizeDigest(digest)}` as DefinitionContentIdentity
	return { kind: "preset-definition", schemaVersion: 1, contentIdentity }
}

export function parsePresetDefinitionRef(value: unknown): PresetDefinitionRef | null {
	if (!isRecord(value) || value.kind !== "preset-definition" || value.schemaVersion !== 1) return null
	if (typeof value.contentIdentity !== "string" || contentIdentityDigest(value.contentIdentity) === null) return null
	return { kind: "preset-definition", schemaVersion: 1, contentIdentity: value.contentIdentity as DefinitionContentIdentity }
}

export type DefinitionCompileInput = {
	name: string
	sourceHash: string
	item: { idField: string; fields: readonly { name: string; type: string }[] }
	routing: RecursiveTaskDefinition["routing"]
	steps: readonly Omit<RecursiveStepDefinition, "kind" | "identity">[]
	fragments: RecursiveTaskDefinition["fragments"]
	findings: readonly { verdict: "warn"; rule: string; message: string }[]
}

export type PublishedPresetDefinition = {
	ref: PresetDefinitionRef
	bundleDir: string
}

export type DefinitionResolutionFailureReason =
	| "invalid-ref"
	| "missing-bundle"
	| "manifest-unreadable"
	| "schema-mismatch"
	| "identity-mismatch"
	| "asset-missing"
	| "asset-digest-mismatch"
	| "envelope-invalid"

export type PresetDefinitionResolution =
	| { kind: "resolved"; ref: PresetDefinitionRef; bundleDir: string; envelope: CompiledDefinitionEnvelope }
	| { kind: "corrupt"; ref: PresetDefinitionRef; reason: DefinitionResolutionFailureReason; detail: string }

type DefinitionAsset = { path: string; digest: string; size: number; mode: number }
type DefinitionManifest = {
	schemaVersion: 1
	contentIdentity: DefinitionContentIdentity
	productIdentity: CompiledProductIdentity
	envelopeIdentity: CompileEnvelopeIdentity
	assets: readonly DefinitionAsset[]
	envelope: CompiledDefinitionEnvelope
}

export function buildCompiledDefinitionEnvelope(input: DefinitionCompileInput): CompiledDefinitionEnvelope {
	const rootIdentity = definitionNodeIdentity("root", input.name)
	const definition: RecursiveTaskDefinition = {
		name: input.name,
		item: input.item,
		routing: input.routing,
		root: {
			kind: "sequence",
			identity: rootIdentity,
			children: input.steps.map((step) => ({
				...step,
				kind: "step" as const,
				identity: definitionNodeIdentity("step", step.name),
			})),
		},
		fragments: input.fragments,
	}
	const productIdentity = prefixedIdentity("product-sha256", canonicalJson(definition)) as CompiledProductIdentity
	const definitionContentIdentity = `content-sha256:${normalizeDigest(input.sourceHash)}` as DefinitionContentIdentity
	const findings = input.findings.map((finding) => ({
		...finding,
		identity: prefixedIdentity("finding-sha256", canonicalJson(finding)),
	}))
	const envelopeIdentity = prefixedIdentity("compile-sha256", canonicalJson({ productIdentity, definitionContentIdentity, findings })) as CompileEnvelopeIdentity
	return {
		kind: "compiled",
		schemaVersion: 2,
		envelopeIdentity,
		productIdentity,
		definitionContentIdentity,
		definitionRef: presetDefinitionRefFromDigest(input.sourceHash),
		definition,
		findings,
	}
}

export async function publishDefinitionBundle(
	envelope: CompiledDefinitionEnvelope,
	sourceDir: string,
	storeRoot: string,
): Promise<PublishedPresetDefinition> {
	const ref = envelope.definitionRef
	const identitySegment = contentIdentityDigest(ref.contentIdentity)
	if (identitySegment === null) throw new Error(`invalid definition content identity: ${ref.contentIdentity}`)
	const definitionsRoot = resolve(storeRoot, "definitions")
	const stagingRoot = resolve(storeRoot, "staging")
	const bundleDir = resolve(definitionsRoot, identitySegment)
	const assets = await snapshotAssets(sourceDir, storeRoot)
	await mkdir(definitionsRoot, { recursive: true })
	await mkdir(stagingRoot, { recursive: true })

	if (await pathExists(bundleDir)) {
		const existing = await resolveDefinitionBundle(ref, storeRoot)
		if (existing.kind === "resolved") return { ref, bundleDir }
		throw new Error(`definition identity collision at ${bundleDir}: ${existing.reason}: ${existing.detail}`)
	}

	const stagingDir = resolve(stagingRoot, `${identitySegment}-${process.pid}-${crypto.randomUUID()}`)
	try {
		await mkdir(resolve(stagingDir, "assets"), { recursive: true })
		for (const asset of assets) {
			const sourcePath = resolve(sourceDir, asset.path)
			const targetPath = safeAssetPath(resolve(stagingDir, "assets"), asset.path)
			await mkdir(dirname(targetPath), { recursive: true })
			await writeFile(targetPath, await readFile(sourcePath))
			await chmod(targetPath, asset.mode)
			await syncFile(targetPath)
		}
		const manifest: DefinitionManifest = {
			schemaVersion: 1,
			contentIdentity: envelope.definitionContentIdentity,
			productIdentity: envelope.productIdentity,
			envelopeIdentity: envelope.envelopeIdentity,
			assets,
			envelope,
		}
		const manifestPath = resolve(stagingDir, "manifest.json")
		await writeFile(manifestPath, `${canonicalJson(manifest)}\n`)
		await syncFile(manifestPath)
		await syncDirectory(resolve(stagingDir, "assets"))
		await syncDirectory(stagingDir)

		const staged = await verifyBundleAt(ref, stagingDir)
		if (staged.kind === "corrupt") throw new Error(`staged definition failed verification: ${staged.reason}: ${staged.detail}`)
		try {
			await rename(stagingDir, bundleDir)
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error
			const raced = await resolveDefinitionBundle(ref, storeRoot)
			if (raced.kind === "corrupt") throw new Error(`definition publish race resolved to corrupt bundle: ${raced.reason}: ${raced.detail}`)
		}
		await syncDirectory(definitionsRoot)
		return { ref, bundleDir }
	} finally {
		await rm(stagingDir, { recursive: true, force: true })
	}
}

export async function resolveDefinitionBundle(
	ref: PresetDefinitionRef,
	storeRoot: string,
): Promise<PresetDefinitionResolution> {
	const identitySegment = contentIdentityDigest(ref.contentIdentity)
	if (ref.kind !== "preset-definition" || ref.schemaVersion !== 1 || identitySegment === null) {
		return corrupt(ref, "invalid-ref", "expected preset-definition schemaVersion=1 with content-sha256 identity")
	}
	return await verifyBundleAt(ref, resolve(storeRoot, "definitions", identitySegment))
}

async function verifyBundleAt(ref: PresetDefinitionRef, bundleDir: string): Promise<PresetDefinitionResolution> {
	if (!(await pathExists(bundleDir))) return corrupt(ref, "missing-bundle", bundleDir)
	let decoded: unknown
	try {
		decoded = JSON.parse(await readFile(resolve(bundleDir, "manifest.json"), "utf8"))
	} catch (error) {
		return corrupt(ref, "manifest-unreadable", errorMessage(error))
	}
	const manifest = parseManifest(decoded)
	if (manifest === null) return corrupt(ref, "schema-mismatch", "manifest does not match schemaVersion 1")
	if (manifest.contentIdentity !== ref.contentIdentity) {
		return corrupt(ref, "identity-mismatch", `manifest=${manifest.contentIdentity} ref=${ref.contentIdentity}`)
	}
	for (const asset of manifest.assets) {
		let bytes: Buffer
		try {
			bytes = await readFile(safeAssetPath(resolve(bundleDir, "assets"), asset.path))
		} catch (error) {
			return corrupt(ref, "asset-missing", `${asset.path}: ${errorMessage(error)}`)
		}
		const digest = sha256(bytes)
		if (digest !== asset.digest || bytes.byteLength !== asset.size) {
			return corrupt(ref, "asset-digest-mismatch", `${asset.path}: expected ${asset.digest}/${asset.size}, observed ${digest}/${bytes.byteLength}`)
		}
	}
	const observedContentIdentity = `content-sha256:${await hashAssetSet(resolve(bundleDir, "assets"), manifest.assets)}`
	if (observedContentIdentity !== ref.contentIdentity) {
		return corrupt(ref, "identity-mismatch", `asset set=${observedContentIdentity} ref=${ref.contentIdentity}`)
	}
	if (!isCompiledEnvelope(manifest.envelope)) return corrupt(ref, "envelope-invalid", "compiled envelope shape or identity join is invalid")
	if (
		manifest.envelope.definitionContentIdentity !== ref.contentIdentity
		|| manifest.envelope.productIdentity !== manifest.productIdentity
		|| manifest.envelope.envelopeIdentity !== manifest.envelopeIdentity
	) {
		return corrupt(ref, "identity-mismatch", "manifest and envelope identities differ")
	}
	return { kind: "resolved", ref, bundleDir, envelope: manifest.envelope }
}

async function snapshotAssets(sourceDir: string, excludedRoot: string): Promise<readonly DefinitionAsset[]> {
	const paths = await collectFiles(sourceDir, excludedRoot)
	const assets: DefinitionAsset[] = []
	for (const path of paths) {
		const bytes = await readFile(resolve(sourceDir, path))
		const metadata = await stat(resolve(sourceDir, path))
		assets.push({ path, digest: sha256(bytes), size: bytes.byteLength, mode: metadata.mode & 0o777 })
	}
	return assets
}

async function collectFiles(root: string, excludedRoot: string): Promise<readonly string[]> {
	const files: string[] = []
	const excluded = resolve(excludedRoot)
	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true })
		for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
			const absolute = resolve(dir, entry.name)
			if (absolute === excluded || absolute.startsWith(`${excluded}${sep}`)) continue
			if (entry.isDirectory()) await walk(absolute)
			else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"))
		}
	}
	await walk(root)
	return files.sort()
}

async function hashAssetSet(root: string, assets: readonly DefinitionAsset[]): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256")
	for (const asset of [...assets].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
		hasher.update(asset.path)
		hasher.update("\0")
		hasher.update(await readFile(safeAssetPath(root, asset.path)))
		hasher.update("\0")
	}
	return hasher.digest("hex")
}

function definitionNodeIdentity(kind: "root" | "step", name: string): DefinitionNodeIdentity {
	return prefixedIdentity(`definition-${kind}-sha256`, name) as DefinitionNodeIdentity
}

function prefixedIdentity(prefix: string, value: string): string {
	return `${prefix}:${sha256(value)}`
}

function normalizeDigest(value: string): string {
	const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`expected sha256 digest, got ${value}`)
	return digest
}

function contentIdentityDigest(value: string): string | null {
	const match = /^content-sha256:([0-9a-f]{64})$/.exec(value)
	return match?.[1] ?? null
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson)
	if (value === null || typeof value !== "object") return value
	const record = value as Record<string, unknown>
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]))
}

function sha256(value: string | Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256")
	hasher.update(value)
	return hasher.digest("hex")
}

function safeAssetPath(root: string, asset: string): string {
	if (asset === "" || asset.startsWith("/") || asset.split("/").includes("..")) throw new Error(`unsafe definition asset path: ${asset}`)
	const path = resolve(root, asset)
	if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`definition asset escapes root: ${asset}`)
	return path
}

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r")
	try { await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r")
	try { await handle.sync() } finally { await handle.close() }
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true } catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false
		throw error
	}
}

function parseManifest(value: unknown): DefinitionManifest | null {
	if (!isRecord(value) || value.schemaVersion !== 1) return null
	if (typeof value.contentIdentity !== "string" || typeof value.productIdentity !== "string" || typeof value.envelopeIdentity !== "string") return null
	if (!Array.isArray(value.assets) || !value.assets.every(isDefinitionAsset)) return null
	return {
		schemaVersion: 1,
		contentIdentity: value.contentIdentity as DefinitionContentIdentity,
		productIdentity: value.productIdentity as CompiledProductIdentity,
		envelopeIdentity: value.envelopeIdentity as CompileEnvelopeIdentity,
		assets: value.assets,
		envelope: value.envelope as CompiledDefinitionEnvelope,
	}
}

function isDefinitionAsset(value: unknown): value is DefinitionAsset {
	return isRecord(value)
		&& typeof value.path === "string"
		&& typeof value.digest === "string"
		&& typeof value.size === "number"
		&& typeof value.mode === "number"
}

function isCompiledEnvelope(value: unknown): value is CompiledDefinitionEnvelope {
	if (!isRecord(value) || value.kind !== "compiled" || value.schemaVersion !== 2) return false
	if (typeof value.envelopeIdentity !== "string" || typeof value.productIdentity !== "string" || typeof value.definitionContentIdentity !== "string") return false
	if (!isRecord(value.definitionRef) || value.definitionRef.kind !== "preset-definition" || value.definitionRef.schemaVersion !== 1) return false
	if (value.definitionRef.contentIdentity !== value.definitionContentIdentity) return false
	return isRecord(value.definition) && Array.isArray(value.findings)
}

function corrupt(ref: PresetDefinitionRef, reason: DefinitionResolutionFailureReason, detail: string): PresetDefinitionResolution {
	return { kind: "corrupt", ref, reason, detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value
}

function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message
	if (typeof value === "string") return value
	return JSON.stringify(value)
}
