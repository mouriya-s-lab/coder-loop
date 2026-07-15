import { type } from "arktype"
import { readFile } from "node:fs/promises"

import type { BoundaryValue } from "./boundary-types"
import { parseObservabilityEventType, type ObservabilityEventType } from "./observability"
import type { JsonValue } from "./loop"

export type ObserverHookPointOf<EventType extends string> = Exclude<EventType, `hook.${string}`>
export type ObserverHookPoint = ObserverHookPointOf<ObservabilityEventType>

export function isObserverHookPoint<EventType extends string>(point: EventType): point is ObserverHookPointOf<EventType> {
	return !point.startsWith("hook.")
}

export const NON_TICK_GATE_DECISION_POINTS = [
	"run.pre-spawn",
	"run.post-exit",
	"item.status-transition",
	"container.advance",
	"chain.complete",
	"daemon.startup",
	"daemon.shutdown",
] as const
export const GATE_DECISION_POINTS = [...NON_TICK_GATE_DECISION_POINTS, "tick"] as const

export type GateDecisionPoint = (typeof GATE_DECISION_POINTS)[number]
export type NonTickGateDecisionPoint = (typeof NON_TICK_GATE_DECISION_POINTS)[number]

export type ObserverHookDeclaration = {
	kind: "observer"
	point: ObserverHookPoint
	script: string
	timeoutMs: number
}

type GateHookDeclarationBase = {
	kind: "gate"
	script: string
	timeoutMs: number
	onFailure: "hold" | "advance"
}

export type GateHookDeclaration =
	| (GateHookDeclarationBase & { point: NonTickGateDecisionPoint })
	| (GateHookDeclarationBase & { point: "tick"; minIntervalMs: number })

export type HookDeclaration = ObserverHookDeclaration | GateHookDeclaration
export type PresetHookPlaceholder = { kind: "named-gate-placeholder"; name: string; point: GateDecisionPoint }
export type HookSourceLayer = "global" | "chain" | "preset" | "item"
export type EffectiveHook =
	| { source: "global" | "chain" | "item"; declaration: HookDeclaration }
	| { source: "preset"; declaration: PresetHookPlaceholder }

type HookLayers = {
	global: readonly HookDeclaration[]
	chain: readonly HookDeclaration[]
	preset: readonly PresetHookPlaceholder[]
	item: readonly HookDeclaration[]
}

const ObserverHookInputBoundary = type({
	kind: type.unit("observer"),
	point: "string",
	script: "string",
	timeoutMs: "number.integer",
}).onUndeclaredKey("reject")
const NonTickGateHookInputBoundary = type({
	kind: type.unit("gate"),
	point: type.enumerated(...NON_TICK_GATE_DECISION_POINTS),
	script: "string",
	timeoutMs: "number.integer",
	onFailure: type.enumerated("hold", "advance"),
}).onUndeclaredKey("reject")
const TickGateHookInputBoundary = type({
	kind: type.unit("gate"),
	point: type.unit("tick"),
	script: "string",
	timeoutMs: "number.integer",
	onFailure: type.enumerated("hold", "advance"),
	minIntervalMs: "number.integer > 0",
}).onUndeclaredKey("reject")
const HookInputBoundary = type.or(ObserverHookInputBoundary, NonTickGateHookInputBoundary, TickGateHookInputBoundary)
const GlobalHookDocumentBoundary = type({ version: type.unit(1), hooks: "unknown[]" }).onUndeclaredKey("reject")
export type HookInput = typeof HookInputBoundary.infer

export function parseHookDeclarations(input: BoundaryValue, field = "hooks"): HookDeclaration[] {
	if (!Array.isArray(input)) throw new Error(`${field} must be an array`)
	return input.map((entry, index) => parseHookDeclaration(entry, `${field}[${index}]`))
}

export function parseGlobalHookDocument(input: BoundaryValue, field = "hooks.json"): HookDeclaration[] {
	let document: typeof GlobalHookDocumentBoundary.infer
	try { document = GlobalHookDocumentBoundary.assert(input) } catch (error) { throw new Error(`${field}: ${String(error)}`) }
	return parseHookDeclarations(document.hooks, `${field}.hooks`)
}

export async function loadGlobalHookDeclarations(hooksFile: string): Promise<HookDeclaration[]> {
	const content = await readFile(hooksFile, "utf8")
	let input: BoundaryValue
	try { input = JSON.parse(content) } catch (error) { throw new Error(`${hooksFile}: malformed JSON: ${String(error)}`) }
	return parseGlobalHookDocument(input, hooksFile)
}

function parseHookDeclaration(input: BoundaryValue, field: string): HookDeclaration {
	let value: typeof HookInputBoundary.infer
	try {
		value = HookInputBoundary.assert(input)
	} catch (error) {
		throw new Error(`${field}: ${String(error)}`)
	}
	if (value.script.trim() === "") throw new Error(`${field}.script must not be empty`)
	if (value.timeoutMs <= 0) throw new Error(`${field}.timeoutMs must be positive`)
	if (value.kind === "observer") {
		let point: ObservabilityEventType
		try { point = parseObservabilityEventType(value.point) } catch { throw new Error(`${field}.point is not a known observability event: ${value.point}`) }
		if (!isObserverHookPoint(point)) throw new Error(`${field}.point must not subscribe to hook.* events`)
		return { kind: "observer", point, script: value.script, timeoutMs: value.timeoutMs }
	}
	if (value.kind === "gate") {
		if (value.point === "tick") {
			return {
				kind: "gate",
				point: value.point,
				script: value.script,
				timeoutMs: value.timeoutMs,
				onFailure: value.onFailure,
				minIntervalMs: value.minIntervalMs,
			}
		}
		return { kind: "gate", point: value.point, script: value.script, timeoutMs: value.timeoutMs, onFailure: value.onFailure }
	}
	return assertNeverHookInput(value)
}

function assertNeverHookInput(input: never): never {
	throw new Error(`unhandled hook input: ${JSON.stringify(input)}`)
}

export function buildEffectiveHookView(layers: HookLayers): EffectiveHook[] {
	return [
		...layers.global.map((declaration) => ({ source: "global", declaration } as const)),
		...layers.chain.map((declaration) => ({ source: "chain", declaration } as const)),
		...layers.preset.map((declaration) => ({ source: "preset", declaration } as const)),
		...layers.item.map((declaration) => ({ source: "item", declaration } as const)),
	]
}

export function hookDeclarationsToJsonValue(declarations: readonly HookDeclaration[]): JsonValue {
	return declarations.map(hookDeclarationToJsonValue)
}

function hookDeclarationToJsonValue(declaration: HookDeclaration): JsonValue {
	if (declaration.kind === "observer") {
		return { kind: declaration.kind, point: declaration.point, script: declaration.script, timeoutMs: declaration.timeoutMs }
	}
	if (declaration.kind === "gate") {
		if (declaration.point === "tick") {
			return {
				kind: declaration.kind,
				point: declaration.point,
				script: declaration.script,
				timeoutMs: declaration.timeoutMs,
				onFailure: declaration.onFailure,
				minIntervalMs: declaration.minIntervalMs,
			}
		}
		return { kind: declaration.kind, point: declaration.point, script: declaration.script, timeoutMs: declaration.timeoutMs, onFailure: declaration.onFailure }
	}
	return assertNeverHookDeclaration(declaration)
}

function assertNeverHookDeclaration(declaration: never): never {
	throw new Error(`unhandled hook declaration: ${JSON.stringify(declaration)}`)
}
