import { describe, expect, test } from "bun:test"

import {
	classifyRateLimitFromStdout,
	extractRateLimitErrorCodeFromEvent,
	extractRateLimitReset,
	isRateLimitErrorCode,
	RATE_LIMIT_ERROR_CODE,
} from "./rate-limit"

describe("rate-limit detection (#478)", () => {
	// W3 fixture line shape (chain 35/37/38 incident, 2026-06-17 22:56 JST).
	const RATE_LIMIT_EVENT = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781713800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled"}}`
	const RATE_LIMIT_RESULT = `{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 1:30am (Asia/Tokyo)"}`

	test("extractRateLimitReset reverse-scans stdout for the rejected rate_limit_event and parses resetsAt", () => {
		const stdout = [
			`{"type":"system","session_id":"sess-1"}`,
			RATE_LIMIT_EVENT,
			RATE_LIMIT_RESULT,
		].join("\n")
		const reset = extractRateLimitReset(stdout)
		expect(reset).not.toBeNull()
		if (reset === null) throw new Error("expected reset")
		expect(reset.resetsAt).toBe(1781713800)
		expect(reset.rateLimitType).toBe("five_hour")
		// resetAtIso is derived from resetsAt; assert it is a non-empty ISO string for that timestamp.
		expect(reset.resetAtIso).toBe(new Date(1781713800 * 1000).toISOString())
	})

	test("extractRateLimitReset returns null for streams without a rejected rate_limit_event", () => {
		const stdout = [
			`{"type":"system","session_id":"sess-1"}`,
			`{"type":"rate_limit_event","rate_limit_info":{"status":"ok","resetsAt":1781713800}}`,
			`{"type":"result","is_error":false,"result":"done"}`,
		].join("\n")
		expect(extractRateLimitReset(stdout)).toBeNull()
	})

	test("extractRateLimitErrorCodeFromEvent recognizes the three documented 429 shapes", () => {
		expect(extractRateLimitErrorCodeFromEvent({ api_error_status: 429, result: "ratelimit" })).toBe(RATE_LIMIT_ERROR_CODE)
		expect(extractRateLimitErrorCodeFromEvent({ error: "rate_limit", message: "rejected" })).toBe(RATE_LIMIT_ERROR_CODE)
		expect(extractRateLimitErrorCodeFromEvent({ type: "result", result: "You've hit your session limit · resets 1:30am" })).toBe(RATE_LIMIT_ERROR_CODE)
		expect(extractRateLimitErrorCodeFromEvent({ type: "result", result: "all good" })).toBeNull()
		expect(extractRateLimitErrorCodeFromEvent({ type: "system", session_id: "sess" })).toBeNull()
	})

	test("isRateLimitErrorCode matches any of the documented spellings", () => {
		expect(isRateLimitErrorCode(RATE_LIMIT_ERROR_CODE)).toBe(true)
		expect(isRateLimitErrorCode("rate-limit")).toBe(true)
		expect(isRateLimitErrorCode("RateLimited")).toBe(true)
		expect(isRateLimitErrorCode("500_http")).toBe(false)
		expect(isRateLimitErrorCode("overloaded")).toBe(false)
		expect(isRateLimitErrorCode("unclassified")).toBe(false)
	})

	test("classifyRateLimitFromStdout returns code + reset in one pass on a real W3 stream", () => {
		const stdout = [
			`{"type":"system","session_id":"sess-1"}`,
			RATE_LIMIT_EVENT,
			RATE_LIMIT_RESULT,
		].join("\n")
		const classified = classifyRateLimitFromStdout(stdout)
		expect(classified.code).toBe(RATE_LIMIT_ERROR_CODE)
		expect(classified.reset?.resetsAt).toBe(1781713800)
	})

	test("classifyRateLimitFromStdout tolerates non-JSON lines and missing fields", () => {
		const stdout = [
			"not-json",
			"",
			`{"type":"system","session_id":"sess-1"}`,
		].join("\n")
		const classified = classifyRateLimitFromStdout(stdout)
		expect(classified.code).toBeNull()
		expect(classified.reset).toBeNull()
	})
})
