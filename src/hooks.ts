import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { type as arkType } from "arktype"

import type { BoundaryValue } from "./boundary-types"
import {
	ObservabilityEventTypeBoundary,
	type ObservabilityEventType,
} from "./observability"
import {
	resolveLoopDataPaths,
	type LoopDataRootOptions,
} from "./runtime-paths"

export type GateDecisionPoint =
	| { kind: "run.pre-spawn" }
	| { kind: "run.post-exit" }
	| { kind: "item.status-transition" }
	| { kind: "container.join" }
	| { kind: "chain-complete" }
	| { kind: "daemon.startup" }
	| { kind: "daemon.shutdown" }
	| { kind: "tick"; minIntervalMs: number }

export type HookFailurePolicy = "hold" | "advance"

export type HookDeclaration =
	| {
		kind: "observer"
		event: ObservabilityEventType
		script: string
		timeoutMs: number
	}
	| {
		kind: "gate"
		point: GateDecisionPoint
		script: string
		timeoutMs: number
		onFailure: HookFailurePolicy
	}

export type DirectHookSource =
	| { kind: "global" }
	| { kind: "chain"; chainId: number }
	| { kind: "item"; itemId: number }

export type PresetHookSource = { kind: "preset"; presetName: string }

export type EffectiveDirectHookEntry = {
	kind: "direct"
	source: DirectHookSource
	declaration: HookDeclaration
}

export type EffectivePresetGatePointEntry = {
	kind: "preset-gate-point"
	source: PresetHookSource
	name: string
}

export type EffectiveHookEntry =
	| EffectiveDirectHookEntry
	| EffectivePresetGatePointEntry

export type EffectiveHookView = {
	entries: EffectiveHookEntry[]
}

export type PresetGatePointPlaceholder = {
	name: string
	presetName: string
}

export type HookMutationTarget =
	| { kind: "global" }
	| { kind: "chain"; chainId: number }
	| { kind: "item"; itemId: number }

export type ChainHookLayer = {
	chainId: number
	declarations: HookDeclaration[]
}

export type ItemHookLayer = {
	itemId: number
	declarations: HookDeclaration[]
}

export type EffectiveHookViewInput = {
	global: HookDeclaration[]
	chain: ChainHookLayer
	preset: PresetGatePointPlaceholder[]
	item: ItemHookLayer
}

export type LoadEffectiveHookViewInput = LoopDataRootOptions & Omit<EffectiveHookViewInput, "global">

type ArkAssertable<T> = {
	assert(data: BoundaryValue): T
}

type GlobalHookFile = {
	hooks: HookDeclaration[]
}

const PositiveIntegerBoundary = arkType("number.integer > 0")
const GateDecisionPointBoundary = arkType.or(
	{ kind: arkType.unit("run.pre-spawn") },
	{ kind: arkType.unit("run.post-exit") },
	{ kind: arkType.unit("item.status-transition") },
	{ kind: arkType.unit("container.join") },
	{ kind: arkType.unit("chain-complete") },
	{ kind: arkType.unit("daemon.startup") },
	{ kind: arkType.unit("daemon.shutdown") },
	{ kind: arkType.unit("tick"), minIntervalMs: PositiveIntegerBoundary },
)
const HookFailurePolicyBoundary = arkType.or(arkType.unit("hold"), arkType.unit("advance"))
const HookDeclarationBoundary = arkType.or(
	{
		kind: arkType.unit("observer"),
		event: ObservabilityEventTypeBoundary,
		script: "string",
		timeoutMs: PositiveIntegerBoundary,
	},
	{
		kind: arkType.unit("gate"),
		point: GateDecisionPointBoundary,
		script: "string",
		timeoutMs: PositiveIntegerBoundary,
		onFailure: HookFailurePolicyBoundary,
	},
)
const HookDeclarationsBoundary: ArkAssertable<HookDeclaration[]> = HookDeclarationBoundary.array()
const GlobalHookFileBoundary: ArkAssertable<GlobalHookFile> = arkType({ hooks: HookDeclarationBoundary.array() })
const HookMutationTargetBoundary: ArkAssertable<HookMutationTarget> = arkType.or(
	{ kind: arkType.unit("global") },
	{ kind: arkType.unit("chain"), chainId: PositiveIntegerBoundary },
	{ kind: arkType.unit("item"), itemId: PositiveIntegerBoundary },
)
const _GATE_DECISION_POINT_BOUNDARY_MATCHES_TYPE: ArkAssertable<GateDecisionPoint> = GateDecisionPointBoundary
const _HOOK_DECLARATION_BOUNDARY_MATCHES_TYPE: ArkAssertable<HookDeclaration> = HookDeclarationBoundary
void _GATE_DECISION_POINT_BOUNDARY_MATCHES_TYPE
void _HOOK_DECLARATION_BOUNDARY_MATCHES_TYPE

export class HookDeclarationError extends Error {
	constructor(message: string, readonly field: string) {
		super(message)
		this.name = "HookDeclarationError"
	}
}

export function parseHookDeclarations(input: BoundaryValue, field = "hooks"): HookDeclaration[] {
	assertNoSelfReflexiveObservers(input, field)
	try {
		return HookDeclarationsBoundary.assert(input)
	} catch (error) {
		throw hookBoundaryError(error, field)
	}
}

export function hookDeclarationsToJsonValue(declarations: HookDeclaration[]): HookDeclaration[] {
	return declarations.map(copyHookDeclaration)
}

export function parseHookMutationTarget(input: BoundaryValue, field = "target"): HookMutationTarget {
	try {
		return HookMutationTargetBoundary.assert(input)
	} catch (error) {
		throw hookBoundaryError(error, field)
	}
}

export async function loadGlobalHookDeclarations(options: LoopDataRootOptions = {}): Promise<HookDeclaration[]> {
	const path = resolveLoopDataPaths(options).hooksFile
	let raw: string
	try {
		raw = await readFile(path, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return []
		throw error
	}
	let parsed: BoundaryValue
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw hookBoundaryError(error, "hooks.json")
	}
	assertNoSelfReflexiveObserversFromFile(parsed)
	try {
		return GlobalHookFileBoundary.assert(parsed).hooks
	} catch (error) {
		throw hookBoundaryError(error, "hooks.json")
	}
}

export async function writeGlobalHookDeclarations(
	declarations: HookDeclaration[],
	options: LoopDataRootOptions = {},
): Promise<void> {
	const parsed = parseHookDeclarations(declarations, "hooks")
	const path = resolveLoopDataPaths(options).hooksFile
	await mkdir(dirname(path), { recursive: true })
	const stagingPath = `${path}.${process.pid}.${randomUUID()}.staging`
	try {
		await writeFile(stagingPath, `${JSON.stringify({ hooks: hookDeclarationsToJsonValue(parsed) }, null, 2)}\n`, "utf-8")
		await rename(stagingPath, path)
	} catch (error) {
		await unlink(stagingPath).catch((unlinkError) => {
			if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError
		})
		throw error
	}
}

export async function loadEffectiveHookView(input: LoadEffectiveHookViewInput): Promise<EffectiveHookView> {
	const global = await loadGlobalHookDeclarations(input)
	return composeEffectiveHookView({
		global,
		chain: input.chain,
		preset: input.preset,
		item: input.item,
	})
}

export function composeEffectiveHookView(input: EffectiveHookViewInput): EffectiveHookView {
	return {
		entries: [
			...directEntries({ kind: "global" }, input.global),
			...directEntries({ kind: "chain", chainId: input.chain.chainId }, input.chain.declarations),
			...input.preset.map((placeholder): EffectiveHookEntry => ({
				kind: "preset-gate-point",
				source: { kind: "preset", presetName: placeholder.presetName },
				name: placeholder.name,
			})),
			...directEntries({ kind: "item", itemId: input.item.itemId }, input.item.declarations),
		],
	}
}

function directEntries(source: DirectHookSource, declarations: HookDeclaration[]): EffectiveHookEntry[] {
	return declarations.map((declaration): EffectiveHookEntry => ({
		kind: "direct",
		source: copyDirectHookSource(source),
		declaration: copyHookDeclaration(declaration),
	}))
}

function copyDirectHookSource(source: DirectHookSource): DirectHookSource {
	switch (source.kind) {
		case "global":
			return { kind: "global" }
		case "chain":
			return { kind: "chain", chainId: source.chainId }
		case "item":
			return { kind: "item", itemId: source.itemId }
	}
}

function copyHookDeclaration(declaration: HookDeclaration): HookDeclaration {
	switch (declaration.kind) {
		case "observer":
			return { ...declaration }
		case "gate":
			return { ...declaration, point: copyGateDecisionPoint(declaration.point) }
	}
}

function copyGateDecisionPoint(point: GateDecisionPoint): GateDecisionPoint {
	switch (point.kind) {
		case "run.pre-spawn":
		case "run.post-exit":
		case "item.status-transition":
		case "container.join":
		case "chain-complete":
		case "daemon.startup":
		case "daemon.shutdown":
			return { kind: point.kind }
		case "tick":
			return { kind: "tick", minIntervalMs: point.minIntervalMs }
	}
}

function assertNoSelfReflexiveObservers(input: BoundaryValue, field: string): void {
	if (!Array.isArray(input)) return
	input.forEach((entry, index) => {
		if (
			typeof entry === "object"
			&& entry !== null
			&& "kind" in entry
			&& entry.kind === "observer"
			&& "event" in entry
			&& typeof entry.event === "string"
			&& entry.event.startsWith("hook.")
		) {
			throw new HookDeclarationError(`${field}[${index}].event must not subscribe to hook.* events`, `${field}[${index}].event`)
		}
	})
}

function assertNoSelfReflexiveObserversFromFile(input: BoundaryValue): void {
	if (typeof input !== "object" || input === null || !("hooks" in input)) return
	assertNoSelfReflexiveObservers(input.hooks, "hooks.json.hooks")
}

function hookBoundaryError(error: BoundaryValue, field: string): HookDeclarationError {
	const detail = error instanceof Error ? error.message : String(error)
	return new HookDeclarationError(`${field}: ${detail}`, field)
}

function isNodeError(error: BoundaryValue): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}
