import { scope } from "arktype"
import { readFile } from "node:fs/promises"

import type { BoundaryValue } from "./boundary-types"
import { parseObservabilityEventType, type ObservabilityEventType } from "./observability-event-types"
import type { JsonValue } from "./loop"

export type ObserverHookPoint = Exclude<ObservabilityEventType, `hook.${string}`>

export type GateDecisionPoint =
	| "run.pre-spawn"
	| "run.post-exit"
	| "item.status-transition"
	| "container.advance"
	| "chain.complete"
	| "daemon.startup"
	| "daemon.shutdown"
	| "tick"

export type ObserverHookDeclaration = {
	kind: "observer"
	point: ObserverHookPoint
	script: string
	timeoutMs: number
}

export type GateHookDeclaration = {
	kind: "gate"
	point: GateDecisionPoint
	script: string
	timeoutMs: number
	onFailure: "hold" | "advance"
}

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

const HookBoundaries = scope({
	HookInput: { kind: "string", point: "string", script: "string", timeoutMs: "number.integer", "onFailure?": "string" },
	GlobalHookDocument: { version: "1", hooks: "unknown[]" },
}).export()
const HookInputBoundary = HookBoundaries.HookInput
const GlobalHookDocumentBoundary = HookBoundaries.GlobalHookDocument

const GATE_DECISION_POINTS: ReadonlySet<string> = new Set([
	"run.pre-spawn", "run.post-exit", "item.status-transition", "container.advance",
	"chain.complete", "daemon.startup", "daemon.shutdown", "tick",
])

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
		if (value.point.startsWith("hook.")) throw new Error(`${field}.point must not subscribe to hook.* events`)
		let point: ObservabilityEventType
		try { point = parseObservabilityEventType(value.point) } catch { throw new Error(`${field}.point is not a known observability event: ${value.point}`) }
		return { kind: "observer", point, script: value.script, timeoutMs: value.timeoutMs }
	}
	if (value.kind === "gate") {
		if (!GATE_DECISION_POINTS.has(value.point)) throw new Error(`${field}.point is not a known gate decision point: ${value.point}`)
		if (value.onFailure !== "hold" && value.onFailure !== "advance") throw new Error(`${field}.onFailure must be hold or advance`)
		assertGateDecisionPoint(value.point)
		return { kind: "gate", point: value.point, script: value.script, timeoutMs: value.timeoutMs, onFailure: value.onFailure }
	}
	throw new Error(`${field}.kind must be observer or gate`)
}

function assertGateDecisionPoint(value: string): asserts value is GateDecisionPoint {
	if (!GATE_DECISION_POINTS.has(value)) throw new Error(`unknown gate decision point: ${value}`)
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
	const result: JsonValue[] = []
	for (const declaration of declarations) {
		switch (declaration.kind) {
			case "observer": result.push({ kind: declaration.kind, point: declaration.point, script: declaration.script, timeoutMs: declaration.timeoutMs }); break
			case "gate": result.push({ kind: declaration.kind, point: declaration.point, script: declaration.script, timeoutMs: declaration.timeoutMs, onFailure: declaration.onFailure }); break
		}
	}
	return result
}
