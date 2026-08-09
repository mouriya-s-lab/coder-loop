import { scope, type as arkType } from "arktype"
import type { CompiledDefinitionProduct, PresetDefinition, JsonValue } from "./definition"
import { parseDeclaredValue } from "./definition"

const v3Types = scope({
	DefinitionSourceIdentity: { kind: "'definition-source'", digest: "string > 0", "+": "reject" },
	StringValueType: { kind: "'string'", "+": "reject" },
	NumberValueType: { kind: "'number'", "+": "reject" },
	BooleanValueType: { kind: "'boolean'", "+": "reject" },
	JsonValueType: { kind: "'json'", "+": "reject" },
	LiteralValueType: { kind: "'literal'", value: "string | number | boolean | null", "+": "reject" },
	ArrayValueType: { kind: "'array'", element: "ValueType", "+": "reject" },
	ValueField: { type: "ValueType", optional: "boolean", "+": "reject" },
	RecordValueType: { kind: "'record'", fields: { "[string]": "ValueField" }, "+": "reject" },
	UnionValueType: { kind: "'union'", variants: "ValueType[] > 0", "+": "reject" },
	ValueType: "StringValueType | NumberValueType | BooleanValueType | JsonValueType | LiteralValueType | ArrayValueType | RecordValueType | UnionValueType",
	ItemValueSource: { kind: "'item'", "+": "reject" },
	MapValueSource: {
		kind: "'map'",
		stage: "'pre-agent' | 'post-agent'",
		module: "string > 0",
		exportName: "string > 0",
		reads: "string[]",
		"+": "reject",
	},
	AgentValueSource: { kind: "'agent'", "+": "reject" },
	ValueSource: "ItemValueSource | MapValueSource | AgentValueSource",
	DeclaredValue: { name: "string > 0", type: "ValueType", source: "ValueSource", required: "boolean", "+": "reject" },
	PromptConsumer: { kind: "'prompt'", value: "string > 0", "+": "reject" },
	PredicateConsumer: { kind: "'predicate'", value: "string > 0", predicate: "string > 0", "+": "reject" },
	ChooserConsumer: { kind: "'chooser'", value: "string > 0", chooser: "string > 0", "+": "reject" },
	MapInputConsumer: { kind: "'map-input'", value: "string > 0", mapValue: "string > 0", "+": "reject" },
	ValueConsumer: "PromptConsumer | PredicateConsumer | ChooserConsumer | MapInputConsumer",
	Successor: { target: "string > 0", when: "string | null", "+": "reject" },
	Chooser: { kind: "'agent' | 'map'", name: "string > 0", "+": "reject" },
	HandoffContract: {
		returns: "ValueType",
		returnValue: "string > 0",
		predicates: "string[]",
		successors: "Successor[]",
		chooser: "Chooser | null",
		onNil: "'return-nil' | 'escalate'",
		onException: "'propagate' | 'fail'",
		"+": "reject",
	},
	LeafTaskDefinition: { kind: "'leaf'", id: "string > 0", promptAsset: "string > 0", contract: "HandoffContract", "+": "reject" },
	FinalizerDefinition: { values: "DeclaredValue[]", consumers: "ValueConsumer[]", task: "LeafTaskDefinition", "+": "reject" },
	SeqTaskDefinition: { kind: "'seq'", id: "string > 0", children: "RecursiveTaskDefinition[]", "+": "reject" },
	ClosedGrowth: "'closed'",
	TimedGrowth: { kind: "'fixed-deadline' | 'sliding-deadline'", durationMs: "number > 0", "+": "reject" },
	ParTaskDefinition: {
		kind: "'par'",
		id: "string > 0",
		children: "RecursiveTaskDefinition[]",
		growth: "ClosedGrowth | TimedGrowth",
		finalizer: "FinalizerDefinition",
		"+": "reject",
	},
	RecursiveTaskDefinition: "LeafTaskDefinition | SeqTaskDefinition | ParTaskDefinition",
	PresetDefinition: {
		schemaVersion: "3",
		name: "string > 0",
		sourceIdentity: "DefinitionSourceIdentity",
		values: "DeclaredValue[]",
		consumers: "ValueConsumer[]",
		task: "RecursiveTaskDefinition",
		"+": "reject",
	},
	CompiledProductIdentity: { kind: "'compiled-product'", digest: "string > 0" },
	CompiledDefinitionProduct: {
		identity: "CompiledProductIdentity",
		definition: "PresetDefinition",
		taskIndex: { "[string]": "RecursiveTaskDefinition" },
		valueIndex: { "[string]": "DeclaredValue" },
	},
}).export()

export const PresetDefinitionBoundary = v3Types.PresetDefinition
export const CompiledDefinitionProductBoundary = v3Types.CompiledDefinitionProduct
export const PresetDefinitionSchemaVersion = 3

export type PresetDefinitionParseResult =
	| { readonly kind: "accepted"; readonly definition: PresetDefinition }
	| { readonly kind: "rejected"; readonly issues: readonly SchemaIssue[] }

export type SchemaIssue = {
	readonly path: readonly (string | number)[]
	readonly expected: string
	readonly actual: string
}

export function parsePresetDefinition(candidate: unknown): PresetDefinitionParseResult {
	const parsed = PresetDefinitionBoundary(candidate)
	if (parsed instanceof arkType.errors) {
		return {
			kind: "rejected",
			issues: parsed.map((error) => ({
				path: [...error.path].map((segment) => typeof segment === "number" ? segment : String(segment)),
				expected: error.expected,
				actual: error.actual,
			})),
		}
	}
	return { kind: "accepted", definition: parsed }
}

export function parseCompiledDefinitionProduct(candidate: unknown): CompiledDefinitionProduct | null {
	const parsed = CompiledDefinitionProductBoundary(candidate)
	return parsed instanceof arkType.errors ? null : parsed
}

export function publicPresetDefinitionSchema(): JsonValue {
	const parsed = parseDeclaredValue({ kind: "json" }, PresetDefinitionBoundary.toJsonSchema())
	if (parsed.kind === "rejected") throw new Error("ArkType emitted a non-JSON schema")
	return parsed.value
}
