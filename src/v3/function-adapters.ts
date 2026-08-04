import { type as arkType } from "arktype"
import { Context, Effect, Layer } from "effect"
import type { Context3, ContextValues, MapFault, MapResult } from "./context"
import type { DeclaredValue, ValueConsumer } from "./definition"
import { DefinitionStore, type DefinitionRef } from "./definition-store"
import { runSubprocess, type SandboxDeclaration, type SubprocessOutcome, type SubprocessSpec } from "./subprocess"

export type MapRuntimeConfig = {
	readonly executable: string
	readonly workerScript: string
	readonly env: Readonly<Record<string, string>>
	readonly sandbox: SandboxDeclaration
	readonly launcher:
		| { readonly kind: "direct" }
		| { readonly kind: "sandbox-exec"; readonly executable: "/usr/bin/sandbox-exec"; readonly profile: string }
	readonly timeoutMs: number
	readonly termGraceMs: number
	readonly maxOutputBytes: number
}

export type MapRuntimeService = {
	readonly execute: (
		stage: "pre-agent" | "post-agent",
		definition: DefinitionRef,
		declarations: readonly DeclaredValue[],
		context: ContextValues,
		cwd: string,
	) => Effect.Effect<readonly MapResult[]>
}

export class MapRuntime extends Context.Tag("coder-loop/v3/MapRuntime")<MapRuntime, MapRuntimeService>() {}

export function makeMapRuntimeLive(config: MapRuntimeConfig): Layer.Layer<MapRuntime, never, DefinitionStore> {
	validateMapRuntimeConfig(config)
	return Layer.effect(MapRuntime, Effect.gen(function*() {
		const definitions = yield* DefinitionStore
		return {
			execute: (stage, definition, declarations, context, cwd) => Effect.all(
				declarations
					.filter((declaration): declaration is DeclaredValue & { readonly source: { readonly kind: "map"; readonly stage: typeof stage; readonly module: string; readonly exportName: string; readonly reads: readonly string[] } } => declaration.source.kind === "map" && declaration.source.stage === stage)
					.map((declaration) => executeMap(definitions, config, definition, declaration, context, cwd)),
				{ concurrency: "unbounded" },
			),
		}
	}))
}

function executeMap(
	definitions: typeof DefinitionStore.Service,
	config: MapRuntimeConfig,
	definition: DefinitionRef,
	declaration: DeclaredValue & { readonly source: { readonly kind: "map"; readonly stage: "pre-agent" | "post-agent"; readonly module: string; readonly exportName: string; readonly reads: readonly string[] } },
	context: ContextValues,
	cwd: string,
): Effect.Effect<MapResult> {
	const input: Record<string, ContextValues[string]> = {}
	for (const name of declaration.source.reads) {
		const value = context[name]
		if (value !== undefined) input[name] = value
	}
	return Effect.matchEffect(definitions.assetPath(definition, declaration.source.module), {
		onFailure: (error) => Effect.succeed<MapResult>({ kind: "fault", valueName: declaration.name, fault: { kind: "spawn", message: `definition asset unavailable: ${error.kind}` } }),
		onSuccess: (modulePath) => Effect.map(runSubprocess(mapSubprocessSpec(config, modulePath, declaration.source.exportName, cwd, input)), (outcome) => mapResult(declaration.name, outcome)),
	})
}

function mapSubprocessSpec(config: MapRuntimeConfig, modulePath: string, exportName: string, cwd: string, input: ContextValues): SubprocessSpec {
	const nativeArgv = [config.workerScript, modulePath, exportName]
	return {
		executable: config.launcher.kind === "direct" ? config.executable : config.launcher.executable,
		argv: config.launcher.kind === "direct" ? nativeArgv : ["-p", config.launcher.profile, config.executable, ...nativeArgv],
		cwd,
		env: config.env,
		stdin: JSON.stringify(input),
		timeoutMs: config.timeoutMs,
		termGraceMs: config.termGraceMs,
		maxOutputBytes: config.maxOutputBytes,
		sandbox: config.sandbox,
	}
}

function mapResult(valueName: string, outcome: SubprocessOutcome): MapResult {
	if (outcome.kind !== "success") return { kind: "fault", valueName, fault: outcomeFault(outcome) }
	let candidate: unknown
	try {
		candidate = JSON.parse(new TextDecoder().decode(outcome.stdout))
	} catch {
		return { kind: "fault", valueName, fault: { kind: "map-rejected", message: "map worker did not emit one JSON result" } }
	}
	const parsed = MapWorkerResultBoundary(candidate)
	if (parsed instanceof arkType.errors) return { kind: "fault", valueName, fault: { kind: "map-rejected", message: parsed.summary } }
	return parsed.kind === "absent"
		? { kind: "absent", valueName }
		: { kind: "produced", valueName, value: parsed.value }
}

const MapWorkerResultBoundary = arkType.or(
	{ kind: "'absent'", "+": "reject" },
	{ kind: "'produced'", value: "unknown", "+": "reject" },
)

function outcomeFault(outcome: Exclude<SubprocessOutcome, { readonly kind: "success" }>): MapFault {
	switch (outcome.kind) {
		case "spawn-failure": return { kind: "spawn", message: outcome.message }
		case "timeout": return { kind: "timeout", message: outcome.signal }
		case "nonzero": return { kind: "exit", message: `exit ${outcome.exitCode}: ${new TextDecoder().decode(outcome.stderr).trim()}` }
		case "signal": return { kind: "exit", message: `signal ${outcome.signal}` }
	}
}

function validateMapRuntimeConfig(config: MapRuntimeConfig): void {
	if (config.executable === "" || config.workerScript === "") throw new Error("map worker executable and script must be explicit")
	if (config.launcher.kind === "direct" && (config.sandbox.filesystem !== "unrestricted" || config.sandbox.network !== "unrestricted")) throw new Error("restricted map sandbox declarations require an enforcing launcher")
	if (config.timeoutMs <= 0 || config.termGraceMs <= 0 || config.maxOutputBytes <= 0) throw new Error("map worker limits must be positive")
}

export type PredicateAdapterError = {
	readonly kind: "predicate-adapter-error"
	readonly predicate: string
	readonly message: string
}

export type PredicateRuntimeService = {
	readonly evaluate: (
		names: readonly string[],
		consumers: readonly ValueConsumer[],
		context: Context3,
	) => Effect.Effect<Readonly<Record<string, boolean>>, PredicateAdapterError>
}

export class PredicateRuntime extends Context.Tag("coder-loop/v3/PredicateRuntime")<PredicateRuntime, PredicateRuntimeService>() {}

export const PredicateRuntimeLive: Layer.Layer<PredicateRuntime> = Layer.succeed(PredicateRuntime, {
	evaluate: (names, consumers, context) => Effect.forEach(names, (name) => {
		const matches = consumers.filter((consumer): consumer is Extract<ValueConsumer, { readonly kind: "predicate" }> => consumer.kind === "predicate" && consumer.predicate === name)
		if (matches.length !== 1) return Effect.fail<PredicateAdapterError>({ kind: "predicate-adapter-error", predicate: name, message: `expected one compiled predicate consumer, found ${matches.length}` })
		const match = matches[0]
		if (match === undefined) return Effect.fail<PredicateAdapterError>({ kind: "predicate-adapter-error", predicate: name, message: `expected one compiled predicate consumer, found ${matches.length}` })
		const value = context.values[match.value]
		return typeof value === "boolean"
			? Effect.succeed([name, value] as const)
			: Effect.fail<PredicateAdapterError>({ kind: "predicate-adapter-error", predicate: name, message: `predicate value ${match.value} is not boolean` })
	}, { concurrency: "unbounded" }).pipe(Effect.map((entries) => Object.fromEntries(entries))),
})
