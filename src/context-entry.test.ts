import { describe, expect, test } from "bun:test"

import {
	ContextAppendAccumulator,
	contextChainScope,
	contextGroupScope,
	contextItemScope,
	parseContextAppendBeginRequest,
	parseContextAppendChunkRequest,
	parseContextAppendCommitRequest,
} from "./context-entry"

describe("context entry ADTs", () => {
	test("parses the closed scope variants and rejects client-supplied author", () => {
		expect(parseContextAppendBeginRequest({ uploadId: "upload-a", chainName: "chain-a", scope: { kind: "chain" } })).toEqual({
			uploadId: "upload-a",
			chainName: "chain-a",
			scope: contextChainScope(),
		})
		expect(parseContextAppendBeginRequest({ uploadId: "upload-a", chainName: "chain-a", scope: { kind: "item", itemId: "594" } })).toEqual({
			uploadId: "upload-a",
			chainName: "chain-a",
			scope: contextItemScope("594"),
		})
		expect(parseContextAppendBeginRequest({ uploadId: "upload-a", chainName: "chain-a", scope: { kind: "group", groupId: "par-7" } })).toEqual({
			uploadId: "upload-a",
			chainName: "chain-a",
			scope: contextGroupScope("par-7"),
		})
		expect(() => parseContextAppendBeginRequest({
			uploadId: "upload-a",
			chainName: "chain-a",
			scope: { kind: "chain" },
			author: { kind: "operator" },
		})).toThrow("author")
		expect(() => parseContextAppendBeginRequest({ uploadId: "upload-a", chainName: "chain-a", scope: { kind: "run", runId: "r" } })).toThrow("scope")
	})

	test("assembles ordered UTF-8 chunks without truncation and commits exactly once", () => {
		const accumulator = new ContextAppendAccumulator(
			"upload-1",
			"connection-1",
			1,
			contextChainScope(),
		)
		accumulator.append(parseContextAppendChunkRequest({ uploadId: "upload-1", index: 0, body: "α" }))
		accumulator.append(parseContextAppendChunkRequest({ uploadId: "upload-1", index: 1, body: "🙂omega" }))
		expect(accumulator.commit(parseContextAppendCommitRequest({ uploadId: "upload-1", chunkCount: 2 }))).toBe("α🙂omega")
		expect(() => accumulator.commit(parseContextAppendCommitRequest({ uploadId: "upload-1", chunkCount: 2 }))).toThrow("already committed")
	})

	test("rejects gaps, reordering, and mismatched upload ids instead of accepting an incomplete body", () => {
		const accumulator = new ContextAppendAccumulator("upload-1", "connection-1", 1, contextItemScope("594"))
		expect(() => accumulator.append(parseContextAppendChunkRequest({ uploadId: "upload-1", index: 1, body: "late" }))).toThrow("expected chunk index 0")
		accumulator.append(parseContextAppendChunkRequest({ uploadId: "upload-1", index: 0, body: "first" }))
		expect(() => accumulator.append(parseContextAppendChunkRequest({ uploadId: "other", index: 1, body: "wrong" }))).toThrow("upload id")
		expect(() => accumulator.commit(parseContextAppendCommitRequest({ uploadId: "upload-1", chunkCount: 2 }))).toThrow("expected 2 chunks, received 1")
	})
})
