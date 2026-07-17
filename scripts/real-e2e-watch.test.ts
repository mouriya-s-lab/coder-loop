import { describe, expect, test } from "bun:test"
import { completionVerdict } from "./real-e2e-watch"

describe("real e2e completion gate", () => {
	test("does not succeed when the item is done but the chain-complete trigger kept the chain active", () => {
		expect(completionVerdict("active", { done: 1 }, ["blocked", "moot", "exhausted"])).toBeNull()
	})

	test("succeeds only after the chain reaches completed", () => {
		expect(completionVerdict("completed", { done: 1 }, ["blocked", "moot", "exhausted"])).toEqual({ kind: "success" })
	})
})
