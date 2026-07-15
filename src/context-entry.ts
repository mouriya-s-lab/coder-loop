import { type as arkType } from "arktype"
import type { BoundaryValue } from "./boundary-types"

export const ContextScopeBoundary = arkType({ kind: "'chain'" }).or({ kind: "'item'", itemId: "string" }).or({ kind: "'group'", groupId: "string" })
export type ContextScope = typeof ContextScopeBoundary.infer

export const ContextAppendCliScopeArgsBoundary = arkType({ scope: "'chain'", itemId: "null", groupId: "null" })
	.or({ scope: "'item'", itemId: "string > 0", groupId: "null" })
	.or({ scope: "'group'", itemId: "null", groupId: "string > 0" })
export type ContextAppendCliScopeArgs = typeof ContextAppendCliScopeArgsBoundary.infer

export const ContextAuthorBoundary = arkType({ kind: "'operator'" }).or({
	kind: "'agent'", chainId: "number.integer", itemId: "string", runId: "string", phase: "string",
})
export type ContextAuthor = typeof ContextAuthorBoundary.infer

export const ContextAppendBeginRequestBoundary = arkType({ scope: ContextScopeBoundary })
export type ContextAppendBeginRequest = typeof ContextAppendBeginRequestBoundary.infer

export const ContextAppendSessionRequestBoundary = arkType({ sessionId: "string > 0" })
export type ContextAppendSessionRequest = typeof ContextAppendSessionRequestBoundary.infer

export const ContextAppendChunkRequestBoundary = arkType({
	sessionId: "string > 0",
	sequence: "number.integer >= 0",
	chunk: "string",
})
export type ContextAppendChunkRequest = typeof ContextAppendChunkRequestBoundary.infer

export const ContextAppendBeginResultBoundary = arkType({ sessionId: "string > 0" })
export type ContextAppendBeginResult = typeof ContextAppendBeginResultBoundary.infer

export const ContextAppendChunkResultBoundary = arkType({ sessionId: "string > 0", nextSequence: "number.integer >= 0" })
export type ContextAppendChunkResult = typeof ContextAppendChunkResultBoundary.infer

export const ContextAppendCommitResultBoundary = arkType({ entryId: "string > 0", createdAt: "number" })
export type ContextAppendCommitResult = typeof ContextAppendCommitResultBoundary.infer

export const ContextAppendCommandBoundary = arkType.or(arkType.unit("begin"), arkType.unit("chunk"), arkType.unit("commit"))
export type ContextAppendCommand = typeof ContextAppendCommandBoundary.infer

export const ContextWriteAdmissionPayloadBoundary = arkType({
	command: ContextAppendCommandBoundary,
	outcome: arkType.unit("allow"),
	reason: arkType.or(arkType.unit("admitted"), arkType.unit("operator")),
	"sessionId": arkType.or("string", "null"),
}).or({
	command: ContextAppendCommandBoundary,
	outcome: arkType.unit("deny"),
	reason: arkType.or(
		arkType.unit("invalid-request"), arkType.unit("missing-credential"), arkType.unit("unknown-credential"),
		arkType.unit("inactive-run"), arkType.unit("cross-chain"), arkType.unit("session-owner-mismatch"),
		arkType.unit("item-not-found"), arkType.unit("group-unavailable-v2"), arkType.unit("unknown-session"),
		arkType.unit("sequence-mismatch"), arkType.unit("chain-not-found"), arkType.unit("chain-deleted"),
	),
	"sessionId": arkType.or("string", "null"),
})
export type ContextWriteAdmissionPayload = typeof ContextWriteAdmissionPayloadBoundary.infer
export type ContextWriteAdmissionDenyReason = Extract<ContextWriteAdmissionPayload, { outcome: "deny" }>["reason"]
export type ContextWriteAdmissionRecord<TSubject> = ContextWriteAdmissionPayload & { subject: TSubject }

export type ContextAppendSession = {
	chainId: number
	scope: ContextScope
	author: ContextAuthor
	chunks: string[]
	nextSequence: number
}

export type AppendContextEntryInput = {
	chainId: number
	scope: ContextScope
	author: ContextAuthor
	body: string
	createdAt?: number
}

export type ContextEntry = {
	id: string
	chainId: number
	createdAt: number
	scope: ContextScope
	author: ContextAuthor
	body: string
}

const PersistedContextEntryCommonBoundaryFields = {
	id: "string", chain_id: "number.integer", created_at: "number", author: "string", body: "string",
} as const
export const PersistedContextScopeBoundary = arkType({ scope_kind: "'chain'", scope_key: "null" })
	.or({ scope_kind: "'item'", scope_key: "string > 0" })
	.or({ scope_kind: "'group'", scope_key: "string > 0" })
export type PersistedContextScope = typeof PersistedContextScopeBoundary.infer
export const PersistedContextEntryRowBoundary = arkType({
	...PersistedContextEntryCommonBoundaryFields, scope_kind: "'chain'", scope_key: "null",
}).or({
	...PersistedContextEntryCommonBoundaryFields, scope_kind: "'item'", scope_key: "string > 0",
}).or({
	...PersistedContextEntryCommonBoundaryFields, scope_kind: "'group'", scope_key: "string > 0",
})
export type PersistedContextEntryRow = typeof PersistedContextEntryRowBoundary.infer

type ArkAssertable<T> = { assert(data: BoundaryValue): T }
function parse<T>(schema: ArkAssertable<T>, value: BoundaryValue, label: string): T {
	try { return schema.assert(value) } catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
}

export function parseContextScope(value: BoundaryValue): ContextScope { return parse(ContextScopeBoundary, value, "context scope") }
export function parseContextAppendCliScopeArgs(value: BoundaryValue): ContextAppendCliScopeArgs { return parse(ContextAppendCliScopeArgsBoundary, value, "context append CLI scope") }
export function parseContextAuthor(value: BoundaryValue): ContextAuthor { return parse(ContextAuthorBoundary, value, "context author") }
export function parsePersistedContextEntryRow(value: BoundaryValue): PersistedContextEntryRow { return parse(PersistedContextEntryRowBoundary, value, "persisted context entry row") }
export function parseContextAppendBeginRequest(value: BoundaryValue): ContextAppendBeginRequest { return parse(ContextAppendBeginRequestBoundary, value, "context append begin request") }
export function parseContextAppendSessionRequest(value: BoundaryValue): ContextAppendSessionRequest { return parse(ContextAppendSessionRequestBoundary, value, "context append session request") }
export function parseContextAppendChunkRequest(value: BoundaryValue): ContextAppendChunkRequest { return parse(ContextAppendChunkRequestBoundary, value, "context append chunk request") }
export function parseContextAppendBeginResult(value: BoundaryValue): ContextAppendBeginResult { return parse(ContextAppendBeginResultBoundary, value, "context append begin result") }
export function parseContextAppendChunkResult(value: BoundaryValue): ContextAppendChunkResult { return parse(ContextAppendChunkResultBoundary, value, "context append chunk result") }
export function parseContextAppendCommitResult(value: BoundaryValue): ContextAppendCommitResult { return parse(ContextAppendCommitResultBoundary, value, "context append commit result") }

function assertNeverContextScope(value: never): never { throw new Error(`unhandled context scope: ${JSON.stringify(value)}`) }

export function contextScopeKey(scope: ContextScope): string | null {
	switch (scope.kind) {
		case "chain": return null
		case "item": return scope.itemId
		case "group": return scope.groupId
		default: return assertNeverContextScope(scope)
	}
}

export function contextScopeFromCliArgs(input: ContextAppendCliScopeArgs): ContextScope {
	switch (input.scope) {
		case "chain": return { kind: "chain" }
		case "item": return { kind: "item", itemId: input.itemId }
		case "group": return { kind: "group", groupId: input.groupId }
		default: return assertNeverContextScope(input)
	}
}

export function persistedContextScope(scope: PersistedContextScope): ContextScope {
	switch (scope.scope_kind) {
		case "chain": return { kind: "chain" }
		case "item": return { kind: "item", itemId: scope.scope_key }
		case "group": return { kind: "group", groupId: scope.scope_key }
		default: return assertNeverContextScope(scope)
	}
}
