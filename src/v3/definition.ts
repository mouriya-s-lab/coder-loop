import { createHash } from "node:crypto"
import { isBoundaryRecord } from "../boundary-types"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type DefinitionSourceIdentity = { readonly kind: "definition-source"; readonly digest: string }
export type CompileEnvelopeIdentity = { readonly kind: "compile-envelope"; readonly digest: string }
export type CompiledProductIdentity = { readonly kind: "compiled-product"; readonly digest: string }
export type DefinitionContentIdentity = { readonly kind: "definition-content"; readonly digest: string }

export type ValueType =
	| { readonly kind: "string" }
	| { readonly kind: "number" }
	| { readonly kind: "boolean" }
	| { readonly kind: "json" }
	| { readonly kind: "literal"; readonly value: null | boolean | number | string }
	| { readonly kind: "array"; readonly element: ValueType }
	| { readonly kind: "record"; readonly fields: Readonly<Record<string, ValueField>> }
	| { readonly kind: "union"; readonly variants: readonly ValueType[] }

export type ValueField = {
	readonly type: ValueType
	readonly optional: boolean
}

export type ValueSource =
	| { readonly kind: "item" }
	| {
		readonly kind: "map"
		readonly stage: "pre-agent" | "post-agent"
		readonly module: string
		readonly exportName: string
		readonly reads: readonly string[]
	}
	| { readonly kind: "agent" }

export type DeclaredValue = {
	readonly name: string
	readonly type: ValueType
	readonly source: ValueSource
	readonly required: boolean
}

export type ValueConsumer =
	| { readonly kind: "prompt"; readonly value: string }
	| { readonly kind: "predicate"; readonly value: string; readonly predicate: string }
	| { readonly kind: "chooser"; readonly value: string; readonly chooser: string }
	| { readonly kind: "map-input"; readonly value: string; readonly mapValue: string }

export type Successor = {
	readonly target: string
	readonly when: string | null
}

export type HandoffContract = {
	readonly returns: ValueType
	readonly returnValue: string
	readonly predicates: readonly string[]
	readonly successors: readonly Successor[]
	readonly chooser: { readonly kind: "agent" | "map"; readonly name: string } | null
	readonly onNil: "return-nil" | "escalate"
	readonly onException: "propagate" | "fail"
}

export type FinalizerDefinition = {
	readonly values: readonly DeclaredValue[]
	readonly consumers: readonly ValueConsumer[]
	readonly task: Extract<RecursiveTaskDefinition, { readonly kind: "leaf" }>
}

export type RecursiveTaskDefinition =
	| { readonly kind: "leaf"; readonly id: string; readonly promptAsset: string; readonly contract: HandoffContract }
	| { readonly kind: "seq"; readonly id: string; readonly children: readonly RecursiveTaskDefinition[] }
	| {
		readonly kind: "par"
		readonly id: string
		readonly children: readonly RecursiveTaskDefinition[]
		readonly growth: "closed" | { readonly kind: "fixed-deadline" | "sliding-deadline"; readonly durationMs: number }
		readonly finalizer: FinalizerDefinition
	}

export type PresetDefinition = {
	readonly schemaVersion: 3
	readonly name: string
	readonly sourceIdentity: DefinitionSourceIdentity
	readonly values: readonly DeclaredValue[]
	readonly consumers: readonly ValueConsumer[]
	readonly task: RecursiveTaskDefinition
}

export type CompileFinding =
	| { readonly kind: "unconsumed-value"; readonly value: string }
	| { readonly kind: "map-asset-unverified"; readonly value: string; readonly module: string; readonly exportName: string }
	| { readonly kind: "map-asset-invalid"; readonly value: string; readonly module: string; readonly exportName: string; readonly reason: string }
	| { readonly kind: "prompt-asset-unverified"; readonly taskId: string; readonly asset: string }
	| { readonly kind: "prompt-asset-invalid"; readonly taskId: string; readonly asset: string; readonly reason: string }
export type CompileDiagnostic =
	| { readonly kind: "duplicate-value-source"; readonly value: string }
	| { readonly kind: "unknown-value"; readonly consumer: ValueConsumer }
	| { readonly kind: "future-value-read"; readonly value: string; readonly mapValue: string }
	| { readonly kind: "unknown-return-value"; readonly taskId: string; readonly value: string }
	| { readonly kind: "return-type-mismatch"; readonly taskId: string; readonly value: string }
	| { readonly kind: "duplicate-task-identity"; readonly taskId: string }
	| { readonly kind: "unknown-successor"; readonly taskId: string; readonly target: string }
	| { readonly kind: "missing-chooser"; readonly taskId: string; readonly successorCount: number }
	| { readonly kind: "unexpected-chooser"; readonly taskId: string; readonly successorCount: number }
	| { readonly kind: "empty-task-group"; readonly taskId: string }
	| { readonly kind: "invalid-growth-window"; readonly taskId: string; readonly durationMs: number }
	| { readonly kind: "duplicate-predicate"; readonly predicate: string }
	| { readonly kind: "unknown-predicate"; readonly taskId: string; readonly predicate: string }
	| { readonly kind: "predicate-type-mismatch"; readonly predicate: string; readonly value: string }
	| { readonly kind: "duplicate-chooser"; readonly chooser: string }
	| { readonly kind: "unknown-chooser"; readonly taskId: string; readonly chooser: string }
	| { readonly kind: "chooser-type-mismatch"; readonly chooser: string; readonly value: string }
	| { readonly kind: "chooser-source-mismatch"; readonly taskId: string; readonly chooser: string; readonly expected: "agent" | "map" }
	| { readonly kind: "duplicate-fail-successor"; readonly taskId: string }
	| { readonly kind: "invalid-finalizer-return-type"; readonly taskId: string }
	| { readonly kind: "invalid-finalizer-contract"; readonly taskId: string }

export type CompiledDefinitionProduct = {
	readonly identity: CompiledProductIdentity
	readonly definition: PresetDefinition
	readonly taskIndex: Readonly<Record<string, RecursiveTaskDefinition>>
	readonly valueIndex: Readonly<Record<string, DeclaredValue>>
}

export type CompileEnvelope =
	| {
		readonly kind: "compiled"
		readonly identity: CompileEnvelopeIdentity
		readonly product: CompiledDefinitionProduct
		readonly findings: readonly CompileFinding[]
	}
	| {
		readonly kind: "rejected"
		readonly identity: CompileEnvelopeIdentity
		readonly diagnostics: readonly [CompileDiagnostic, ...CompileDiagnostic[]]
	}

export type ValueParseIssue = {
	readonly path: readonly (string | number)[]
	readonly expected: string
	readonly actual: string
}

export type ValueParseResult =
	| { readonly kind: "accepted"; readonly value: JsonValue }
	| { readonly kind: "rejected"; readonly issues: readonly [ValueParseIssue, ...ValueParseIssue[]] }

export function compilePresetDefinition(definition: PresetDefinition): CompileEnvelope {
	const diagnostics: CompileDiagnostic[] = []
	const findings: CompileFinding[] = []
	const scope = analyzeValueScope(definition.values, definition.consumers, findings, diagnostics)
	collectReturnedValues(definition.task, scope.consumed)
	collectUnconsumedValues(definition.values, scope.consumed, findings)

	const taskIndex = new Map<string, RecursiveTaskDefinition>()
	indexTask(definition.task, taskIndex, diagnostics)
	validateTask(definition.task, taskIndex, scope, findings, diagnostics)
	collectPromptAssetFindings(definition.task, findings)

	if (diagnostics.length > 0) return rejectedEnvelope(definition, nonEmpty(diagnostics))

	const product: CompiledDefinitionProduct = {
		identity: compiledDefinitionProductIdentity(definition, Object.fromEntries(taskIndex), Object.fromEntries(scope.values)),
		definition,
		taskIndex: Object.fromEntries(taskIndex),
		valueIndex: Object.fromEntries(scope.values),
	}
	return {
		kind: "compiled",
		identity: { kind: "compile-envelope", digest: digest({ product: product.identity, findings }) },
		product,
		findings,
	}
}

export function compiledDefinitionProductIdentity(
	definition: PresetDefinition,
	taskIndex: Readonly<Record<string, RecursiveTaskDefinition>>,
	valueIndex: Readonly<Record<string, DeclaredValue>>,
): CompiledProductIdentity {
	return {
		kind: "compiled-product",
		digest: digest({ definition, taskIds: Object.keys(taskIndex).sort(), valueNames: Object.keys(valueIndex).sort() }),
	}
}

type ValueScope = {
	readonly values: Map<string, DeclaredValue>
	readonly consumed: Set<string>
	readonly predicates: Map<string, Extract<ValueConsumer, { readonly kind: "predicate" }>>
	readonly choosers: Map<string, Extract<ValueConsumer, { readonly kind: "chooser" }>>
}

function analyzeValueScope(
	declarations: readonly DeclaredValue[],
	consumers: readonly ValueConsumer[],
	findings: CompileFinding[],
	diagnostics: CompileDiagnostic[],
): ValueScope {
	const values = new Map<string, DeclaredValue>()
	for (const value of declarations) {
		if (values.has(value.name)) diagnostics.push({ kind: "duplicate-value-source", value: value.name })
		else values.set(value.name, value)
		if (value.source.kind === "map") findings.push({ kind: "map-asset-unverified", value: value.name, module: value.source.module, exportName: value.source.exportName })
	}
	const consumed = new Set<string>()
	const predicates = new Map<string, Extract<ValueConsumer, { readonly kind: "predicate" }>>()
	const choosers = new Map<string, Extract<ValueConsumer, { readonly kind: "chooser" }>>()
	for (const consumer of consumers) {
		const value = values.get(consumer.value)
		if (value === undefined) {
			diagnostics.push({ kind: "unknown-value", consumer })
			continue
		}
		consumed.add(consumer.value)
		if (consumer.kind === "predicate") {
			if (predicates.has(consumer.predicate)) diagnostics.push({ kind: "duplicate-predicate", predicate: consumer.predicate })
			else predicates.set(consumer.predicate, consumer)
			if (value.type.kind !== "boolean") diagnostics.push({ kind: "predicate-type-mismatch", predicate: consumer.predicate, value: consumer.value })
		}
		if (consumer.kind === "chooser") {
			if (choosers.has(consumer.chooser)) diagnostics.push({ kind: "duplicate-chooser", chooser: consumer.chooser })
			else choosers.set(consumer.chooser, consumer)
			if (value.type.kind !== "string") diagnostics.push({ kind: "chooser-type-mismatch", chooser: consumer.chooser, value: consumer.value })
		}
		if (consumer.kind !== "map-input") continue
		const mapOutput = values.get(consumer.mapValue)
		if (mapOutput?.source.kind !== "map") {
			diagnostics.push({ kind: "unknown-value", consumer })
			continue
		}
		if (!isValueVisibleAtMapStage(value.source, mapOutput.source.stage)) diagnostics.push({ kind: "future-value-read", value: consumer.value, mapValue: consumer.mapValue })
	}
	return { values, consumed, predicates, choosers }
}

function collectUnconsumedValues(declarations: readonly DeclaredValue[], consumed: ReadonlySet<string>, findings: CompileFinding[]): void {
	for (const value of declarations) {
		if (!consumed.has(value.name)) findings.push({ kind: "unconsumed-value", value: value.name })
	}
}

export function resolveCompileAssets(
	envelope: CompileEnvelope,
	assets: Readonly<Record<string, string | Uint8Array>>,
): CompileEnvelope {
	if (envelope.kind === "rejected") return envelope
	const findings = envelope.findings.flatMap((finding): CompileFinding[] => {
		if (finding.kind === "map-asset-unverified") {
			const source = assetText(assets[finding.module])
			if (source === null) return [finding]
			try {
				const exports = new Bun.Transpiler({ loader: "ts" }).scan(source).exports
				return exports.includes(finding.exportName)
					? []
					: [{ ...finding, kind: "map-asset-invalid", reason: `missing export ${finding.exportName}` }]
			} catch (error) {
				return [{ ...finding, kind: "map-asset-invalid", reason: error instanceof Error ? error.message : String(error) }]
			}
		}
		if (finding.kind === "prompt-asset-unverified") {
			const template = assetText(assets[finding.asset])
			if (template === null) return [finding]
			const scope = valueScopeForTask(envelope.product.definition, finding.taskId)
			const valueNames = new Set(scope.values.map((value) => value.name))
			const promptConsumers = new Set(scope.consumers.flatMap((consumer) => consumer.kind === "prompt" ? [consumer.value] : []))
			const placeholders = [...template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu)]
				.map((match) => match[1])
				.filter((name): name is string => name !== undefined)
			const invalid = [...new Set(placeholders)].filter((name) => !valueNames.has(name) || !promptConsumers.has(name))
			return invalid.length === 0
				? []
				: [{ ...finding, kind: "prompt-asset-invalid", reason: `undeclared prompt consumers: ${invalid.join(", ")}` }]
		}
		return [finding]
	})
	return { ...envelope, findings }
}

function valueScopeForTask(definition: PresetDefinition, taskId: string): Pick<FinalizerDefinition, "values" | "consumers"> {
	const finalizer = findFinalizer(definition.task, taskId)
	return finalizer ?? definition
}

function findFinalizer(node: RecursiveTaskDefinition, taskId: string): FinalizerDefinition | null {
	if (node.kind === "leaf") return null
	if (node.kind === "par" && node.finalizer.task.id === taskId) return node.finalizer
	for (const child of node.children) {
		const found = findFinalizer(child, taskId)
		if (found !== null) return found
	}
	return null
}

export function strictCompiledProduct(envelope: CompileEnvelope):
	| { readonly kind: "accepted"; readonly product: CompiledDefinitionProduct }
	| { readonly kind: "rejected"; readonly reason: "compile-rejected" | "compile-incomplete"; readonly envelope: CompileEnvelope } {
	if (envelope.kind === "rejected") return { kind: "rejected", reason: "compile-rejected", envelope }
	if (envelope.findings.length > 0) return { kind: "rejected", reason: "compile-incomplete", envelope }
	return { kind: "accepted", product: envelope.product }
}

export function definitionContentIdentity(assets: Readonly<Record<string, string | Uint8Array>>): DefinitionContentIdentity {
	const canonicalAssets = Object.entries(assets)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, bytes]) => {
			const content = typeof bytes === "string" ? Buffer.from(bytes) : bytes
			return { path, digest: digest([...content]) }
		})
	return { kind: "definition-content", digest: digest(canonicalAssets) }
}

export function parseDeclaredValue(type: ValueType, input: unknown): ValueParseResult {
	const issues: ValueParseIssue[] = []
	const value = parseValue(type, input, [], issues)
	return issues.length === 0
		? { kind: "accepted", value }
		: { kind: "rejected", issues: nonEmpty(issues) }
}

function rejectedEnvelope(candidate: unknown, diagnostics: readonly [CompileDiagnostic, ...CompileDiagnostic[]]): CompileEnvelope {
	return {
		kind: "rejected",
		identity: { kind: "compile-envelope", digest: digest({ candidate: canonicalize(candidate), diagnostics }) },
		diagnostics,
	}
}

function isValueVisibleAtMapStage(source: ValueSource, stage: "pre-agent" | "post-agent"): boolean {
	if (source.kind === "item") return true
	if (source.kind === "agent") return stage === "post-agent"
	return source.stage === "pre-agent" && stage === "post-agent"
}

function indexTask(node: RecursiveTaskDefinition, index: Map<string, RecursiveTaskDefinition>, diagnostics: CompileDiagnostic[]): void {
	if (index.has(node.id)) diagnostics.push({ kind: "duplicate-task-identity", taskId: node.id })
	else index.set(node.id, node)
	if (node.kind === "leaf") return
	if (node.kind === "par") {
		const finalizer = node.finalizer.task
		if (index.has(finalizer.id)) diagnostics.push({ kind: "duplicate-task-identity", taskId: finalizer.id })
		else index.set(finalizer.id, finalizer)
	}
	for (const child of node.children) indexTask(child, index, diagnostics)
}

function validateTask(
	node: RecursiveTaskDefinition,
	index: ReadonlyMap<string, RecursiveTaskDefinition>,
	scope: ValueScope,
	findings: CompileFinding[],
	diagnostics: CompileDiagnostic[],
): void {
	if (node.kind !== "leaf" && node.children.length === 0) diagnostics.push({ kind: "empty-task-group", taskId: node.id })
	if (node.kind === "par" && node.growth !== "closed" && (!Number.isFinite(node.growth.durationMs) || node.growth.durationMs <= 0)) {
		diagnostics.push({ kind: "invalid-growth-window", taskId: node.id, durationMs: node.growth.durationMs })
	}
	if (node.kind === "leaf") {
		validateHandoff(node.id, node.contract, index, scope.values, scope.predicates, scope.choosers, diagnostics)
		return
	}
	if (node.kind === "par") {
		const finalizerScope = analyzeValueScope(node.finalizer.values, node.finalizer.consumers, findings, diagnostics)
		finalizerScope.consumed.add(node.finalizer.task.contract.returnValue)
		collectUnconsumedValues(node.finalizer.values, finalizerScope.consumed, findings)
		validateHandoff(node.finalizer.task.id, node.finalizer.task.contract, index, finalizerScope.values, finalizerScope.predicates, finalizerScope.choosers, diagnostics)
		if (digest(node.finalizer.task.contract.returns) !== digest(finalizerResultType())) diagnostics.push({ kind: "invalid-finalizer-return-type", taskId: node.finalizer.task.id })
		if (node.finalizer.task.contract.successors.length > 0 || node.finalizer.task.contract.predicates.length > 0 || node.finalizer.task.contract.chooser !== null) {
			diagnostics.push({ kind: "invalid-finalizer-contract", taskId: node.finalizer.task.id })
		}
	}
	for (const child of node.children) validateTask(child, index, scope, findings, diagnostics)
}

function validateHandoff(
	taskId: string,
	contract: HandoffContract,
	index: ReadonlyMap<string, RecursiveTaskDefinition>,
	values: ReadonlyMap<string, DeclaredValue>,
	predicates: ReadonlyMap<string, Extract<ValueConsumer, { readonly kind: "predicate" }>>,
	choosers: ReadonlyMap<string, Extract<ValueConsumer, { readonly kind: "chooser" }>>,
	diagnostics: CompileDiagnostic[],
): void {
	const returned = values.get(contract.returnValue)
	if (returned === undefined) diagnostics.push({ kind: "unknown-return-value", taskId, value: contract.returnValue })
	else if (digest(returned.type) !== digest(contract.returns)) diagnostics.push({ kind: "return-type-mismatch", taskId, value: contract.returnValue })
	for (const predicate of contract.predicates) {
		if (!predicates.has(predicate)) diagnostics.push({ kind: "unknown-predicate", taskId, predicate })
	}
	const failSuccessors = contract.successors.filter((successor) => successor.when === "fail")
	const normalSuccessors = contract.successors.filter((successor) => successor.when !== "fail")
	if (failSuccessors.length > 1) diagnostics.push({ kind: "duplicate-fail-successor", taskId })
	for (const successor of contract.successors) {
		if (!index.has(successor.target)) diagnostics.push({ kind: "unknown-successor", taskId, target: successor.target })
	}
	if (normalSuccessors.length >= 2 && contract.chooser === null) {
		diagnostics.push({ kind: "missing-chooser", taskId, successorCount: normalSuccessors.length })
	}
	if (normalSuccessors.length < 2 && contract.chooser !== null) {
		diagnostics.push({ kind: "unexpected-chooser", taskId, successorCount: normalSuccessors.length })
	}
	if (contract.chooser !== null) {
		const consumer = choosers.get(contract.chooser.name)
		if (consumer === undefined) diagnostics.push({ kind: "unknown-chooser", taskId, chooser: contract.chooser.name })
		else if (values.get(consumer.value)?.source.kind !== contract.chooser.kind) diagnostics.push({ kind: "chooser-source-mismatch", taskId, chooser: contract.chooser.name, expected: contract.chooser.kind })
	}
}

export function finalizerResultType(): ValueType {
	return {
		kind: "union",
		variants: [
			{ kind: "record", fields: { kind: { type: { kind: "literal", value: "advance" }, optional: false }, value: { type: { kind: "json" }, optional: true } } },
			{ kind: "record", fields: { kind: { type: { kind: "literal", value: "hold" }, optional: false }, reason: { type: { kind: "string" }, optional: false } } },
		],
	}
}

function parseValue(type: ValueType, input: unknown, path: readonly (string | number)[], issues: ValueParseIssue[]): JsonValue {
	switch (type.kind) {
		case "literal":
			if (input === type.value) return type.value
			return rejectValue(path, JSON.stringify(type.value), input, issues)
		case "string":
			if (typeof input === "string") return input
			return rejectValue(path, "string", input, issues)
		case "number":
			if (typeof input === "number" && Number.isFinite(input)) return input
			return rejectValue(path, "finite number", input, issues)
		case "boolean":
			if (typeof input === "boolean") return input
			return rejectValue(path, "boolean", input, issues)
		case "json":
			if (isJsonValue(input)) return input
			return rejectValue(path, "JSON value", input, issues)
		case "array":
			if (!Array.isArray(input)) return rejectValue(path, "array", input, issues)
			return input.map((entry, index) => parseValue(type.element, entry, [...path, index], issues))
		case "record": {
			if (!isBoundaryRecord(input)) return rejectValue(path, "record", input, issues)
			const output: Record<string, JsonValue> = {}
			for (const [fieldName, field] of Object.entries(type.fields)) {
				if (!Object.hasOwn(input, fieldName)) {
					if (!field.optional) issues.push({ path: [...path, fieldName], expected: describeType(field.type), actual: "missing" })
					continue
				}
				output[fieldName] = parseValue(field.type, input[fieldName], [...path, fieldName], issues)
			}
			for (const fieldName of Object.keys(input)) {
				if (!Object.hasOwn(type.fields, fieldName)) issues.push({ path: [...path, fieldName], expected: "declared field", actual: "unexpected field" })
			}
			return output
		}
		case "union": {
			for (const variant of type.variants) {
				const variantIssues: ValueParseIssue[] = []
				const parsed = parseValue(variant, input, path, variantIssues)
				if (variantIssues.length === 0) return parsed
			}
			return rejectValue(path, type.variants.map(describeType).join(" | "), input, issues)
		}
	}
}

function rejectValue(path: readonly (string | number)[], expected: string, input: unknown, issues: ValueParseIssue[]): null {
	issues.push({ path, expected, actual: describeActual(input) })
	return null
}

function describeType(type: ValueType): string {
	switch (type.kind) {
		case "string": return "string"
		case "number": return "finite number"
		case "boolean": return "boolean"
		case "json": return "JSON value"
		case "array": return `array<${describeType(type.element)}>`
		case "record": return "record"
		case "literal": return JSON.stringify(type.value)
		case "union": return type.variants.map(describeType).join(" | ")
	}
}

function describeActual(input: unknown): string {
	if (input === null) return "null"
	if (Array.isArray(input)) return "array"
	return typeof input
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true
	if (typeof value === "number") return Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJsonValue)
	return isBoundaryRecord(value) && Object.values(value).every(isJsonValue)
}

function collectReturnedValues(node: RecursiveTaskDefinition, consumed: Set<string>): void {
	if (node.kind === "leaf") {
		consumed.add(node.contract.returnValue)
		return
	}
	for (const child of node.children) collectReturnedValues(child, consumed)
}

function collectPromptAssetFindings(node: RecursiveTaskDefinition, findings: CompileFinding[]): void {
	if (node.kind === "leaf") {
		findings.push({ kind: "prompt-asset-unverified", taskId: node.id, asset: node.promptAsset })
		return
	}
	for (const child of node.children) collectPromptAssetFindings(child, findings)
	if (node.kind === "par") findings.push({ kind: "prompt-asset-unverified", taskId: node.finalizer.task.id, asset: node.finalizer.task.promptAsset })
}

function assetText(asset: string | Uint8Array | undefined): string | null {
	if (asset === undefined) return null
	try {
		return typeof asset === "string" ? asset : new TextDecoder("utf-8", { fatal: true }).decode(asset)
	} catch {
		return null
	}
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (!isBoundaryRecord(value)) return value
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]))
}

function nonEmpty<T>(values: readonly T[]): readonly [T, ...T[]] {
	const [first, ...rest] = values
	if (first === undefined) throw new Error("expected non-empty values")
	return [first, ...rest]
}
