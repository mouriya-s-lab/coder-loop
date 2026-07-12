import { type as arkType } from "arktype"

import type { BoundaryValue } from "./boundary-types"

export type ContextScope =
	| { kind: "chain" }
	| { kind: "item"; itemId: string }
	| { kind: "group"; groupId: string }

export type ContextAuthor =
	| { kind: "operator" }
	| { kind: "agent"; chainId: number; itemId: string; runId: string; phase: string }

export type ContextEntry = {
	id: number
	chainId: number
	ts: number
	scope: ContextScope
	author: ContextAuthor
	body: string
}

const ContextScopeBoundary = arkType.or(
	{ kind: arkType.unit("chain") },
	{ kind: arkType.unit("item"), itemId: "string > 0" },
	{ kind: arkType.unit("group"), groupId: "string > 0" },
)

const ContextAppendBeginRequestBoundary = arkType({
	uploadId: "string > 0",
	chainName: "string > 0",
	scope: ContextScopeBoundary,
	"agentCredential?": "string > 0",
}).onUndeclaredKey("reject")

const ContextAppendChunkRequestBoundary = arkType({
	uploadId: "string > 0",
	index: "number.integer >= 0",
	body: "string",
	"agentCredential?": "string > 0",
}).onUndeclaredKey("reject")

const ContextAppendCommitRequestBoundary = arkType({
	uploadId: "string > 0",
	chunkCount: "number.integer >= 0",
	"agentCredential?": "string > 0",
}).onUndeclaredKey("reject")

export type ContextAppendBeginRequest = typeof ContextAppendBeginRequestBoundary.infer
export type ContextAppendChunkRequest = typeof ContextAppendChunkRequestBoundary.infer
export type ContextAppendCommitRequest = typeof ContextAppendCommitRequestBoundary.infer

export function parseContextAppendBeginRequest(value: BoundaryValue): ContextAppendBeginRequest {
	return ContextAppendBeginRequestBoundary.assert(value)
}

export function parseContextAppendChunkRequest(value: BoundaryValue): ContextAppendChunkRequest {
	return ContextAppendChunkRequestBoundary.assert(value)
}

export function parseContextAppendCommitRequest(value: BoundaryValue): ContextAppendCommitRequest {
	return ContextAppendCommitRequestBoundary.assert(value)
}

export function contextChainScope(): Extract<ContextScope, { kind: "chain" }> {
	return { kind: "chain" }
}

export function contextItemScope(itemId: string): Extract<ContextScope, { kind: "item" }> {
	return { kind: "item", itemId }
}

export function contextGroupScope(groupId: string): Extract<ContextScope, { kind: "group" }> {
	return { kind: "group", groupId }
}

export class ContextAppendProtocolError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ContextAppendProtocolError"
	}
}

export class ContextAppendAccumulator {
	readonly chunks: string[] = []
	private committed = false

	constructor(
		readonly uploadId: string,
		readonly connectionId: string,
		readonly chainId: number,
		readonly scope: ContextScope,
	) {}

	append(request: ContextAppendChunkRequest): void {
		if (this.committed) throw new ContextAppendProtocolError(`context upload ${this.uploadId} is already committed`)
		if (request.uploadId !== this.uploadId) throw new ContextAppendProtocolError(`context upload id mismatch: expected ${this.uploadId}`)
		if (request.index !== this.chunks.length) {
			throw new ContextAppendProtocolError(`expected chunk index ${this.chunks.length}, received ${request.index}`)
		}
		this.chunks.push(request.body)
	}

	commit(request: ContextAppendCommitRequest): string {
		if (this.committed) throw new ContextAppendProtocolError(`context upload ${this.uploadId} is already committed`)
		if (request.uploadId !== this.uploadId) throw new ContextAppendProtocolError(`context upload id mismatch: expected ${this.uploadId}`)
		if (request.chunkCount !== this.chunks.length) {
			throw new ContextAppendProtocolError(`expected ${request.chunkCount} chunks, received ${this.chunks.length}`)
		}
		this.committed = true
		return this.chunks.join("")
	}
}

export function assertNeverContextScope(value: never): never {
	throw new ContextAppendProtocolError(`unhandled context scope: ${JSON.stringify(value)}`)
}

export function assertNeverContextAuthor(value: never): never {
	throw new ContextAppendProtocolError(`unhandled context author: ${JSON.stringify(value)}`)
}
