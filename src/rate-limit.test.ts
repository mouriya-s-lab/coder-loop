import { expect, test } from "bun:test"

import {
	classifyRateLimitFromStdout,
	extractRateLimitErrorCodeFromEvent,
	extractRateLimitReset,
	formatRateLimitNotice,
	isRateLimitErrorCode,
	parseRateLimitNoticeLine,
	RATE_LIMIT_ERROR_CODE,
} from "./rate-limit"

test("extractRateLimitReset reverse-scans for the most recent rejected rate_limit_event and returns its resetsAt", () => {
	const stdout = [
		`{"type":"system","session_id":"sess-1"}`,
		`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779204000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled"}}`,
		`{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 1:30am (Asia/Tokyo)"}`,
	].join("\n")
	const reset = extractRateLimitReset(stdout)
	expect(reset).toEqual({
		resetsAt: 1779204000,
		resetAtIso: new Date(1779204000 * 1000).toISOString(),
		rateLimitType: "five_hour",
	})
})

test("extractRateLimitReset returns null when no rejected event is present", () => {
	expect(extractRateLimitReset(`{"type":"result","is_error":false}\n`)).toBe(null)
	expect(extractRateLimitReset("")).toBe(null)
	expect(extractRateLimitReset("not json\n")).toBe(null)
})

test("extractRateLimitReset ignores non-rejected rate_limit_event info", () => {
	const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1779204000}}`
	expect(extractRateLimitReset(stdout)).toBe(null)
})

test("extractRateLimitReset ignores rejected info with non-positive resetsAt", () => {
	const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":0}}`
	expect(extractRateLimitReset(stdout)).toBe(null)
})

test("extractRateLimitReset picks the most recent (last) rejected event when multiple appear", () => {
	const stdout = [
		`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779203000}}`,
		`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779204000}}`,
	].join("\n")
	expect(extractRateLimitReset(stdout)?.resetsAt).toBe(1779204000)
})

test("extractRateLimitErrorCodeFromEvent recognizes the three emitted shapes", () => {
	expect(extractRateLimitErrorCodeFromEvent({ api_error_status: 429 })).toBe(RATE_LIMIT_ERROR_CODE)
	expect(extractRateLimitErrorCodeFromEvent({ error: "rate_limit" })).toBe(RATE_LIMIT_ERROR_CODE)
	expect(extractRateLimitErrorCodeFromEvent({ result: "You've hit your session limit · resets 1:30am" })).toBe(RATE_LIMIT_ERROR_CODE)
	expect(extractRateLimitErrorCodeFromEvent({ result: "rate_limit exceeded" })).toBe(RATE_LIMIT_ERROR_CODE)
	expect(extractRateLimitErrorCodeFromEvent({ result: "rate-limit hit" })).toBe(RATE_LIMIT_ERROR_CODE)
	expect(extractRateLimitErrorCodeFromEvent({ api_error_status: 500 })).toBe(null)
	expect(extractRateLimitErrorCodeFromEvent({ result: "ok" })).toBe(null)
	expect(extractRateLimitErrorCodeFromEvent({ type: "assistant" })).toBe(null)
})

test("isRateLimitErrorCode matches rate_limit / rate-limit / ratelimit in any casing", () => {
	expect(isRateLimitErrorCode(RATE_LIMIT_ERROR_CODE)).toBe(true)
	expect(isRateLimitErrorCode("rate_limit_429")).toBe(true)
	expect(isRateLimitErrorCode("rate-limit")).toBe(true)
	expect(isRateLimitErrorCode("RATELIMIT")).toBe(true)
	expect(isRateLimitErrorCode("500_http")).toBe(false)
	expect(isRateLimitErrorCode("overloaded")).toBe(false)
})

test("classifyRateLimitFromStdout extracts both code and reset from a real rejected sample", () => {
	const stdout = [
		`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779204000,"rateLimitType":"five_hour"}}`,
		`{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit"}`,
	].join("\n")
	const result = classifyRateLimitFromStdout(stdout)
	expect(result.code).toBe(RATE_LIMIT_ERROR_CODE)
	expect(result.reset).toEqual({
		resetsAt: 1779204000,
		resetAtIso: new Date(1779204000 * 1000).toISOString(),
		rateLimitType: "five_hour",
	})
})

test("classifyRateLimitFromStdout returns code with null reset when only a 429 result line is present", () => {
	const stdout = `{"type":"result","is_error":true,"api_error_status":429,"result":"hit your limit"}`
	const result = classifyRateLimitFromStdout(stdout)
	expect(result.code).toBe(RATE_LIMIT_ERROR_CODE)
	expect(result.reset).toBe(null)
})

test("classifyRateLimitFromStdout returns reset with null code when only a rate_limit_event is present", () => {
	const stdout = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1779204000,"rateLimitType":"seven_day"}}`
	const result = classifyRateLimitFromStdout(stdout)
	expect(result.code).toBe(null)
	expect(result.reset?.resetsAt).toBe(1779204000)
	expect(result.reset?.rateLimitType).toBe("seven_day")
})

test("classifyRateLimitFromStdout returns null/null for clean output", () => {
	const result = classifyRateLimitFromStdout(`{"type":"result","is_error":false}\n`)
	expect(result.code).toBe(null)
	expect(result.reset).toBe(null)
})

test("formatRateLimitNotice and parseRateLimitNoticeLine round-trip a reset", () => {
	const reset = { resetsAt: 1779204000, resetAtIso: new Date(1779204000 * 1000).toISOString(), rateLimitType: "five_hour" }
	const notice = formatRateLimitNotice(reset)
	expect(notice).toStartWith("CODER_LOOP_RATE_LIMIT ")
	const parsed = parseRateLimitNoticeLine(notice)
	expect(parsed).toEqual(reset)
})

test("parseRateLimitNoticeLine returns null for non-notice lines", () => {
	expect(parseRateLimitNoticeLine("random stdout line")).toBe(null)
	expect(parseRateLimitNoticeLine("CODER_LOOP_RATE_LIMIT not json")).toBe(null)
	expect(parseRateLimitNoticeLine("")).toBe(null)
})

test("parseRateLimitNoticeLine tolerates leading text before the notice prefix", () => {
	const reset = { resetsAt: 1779204000, resetAtIso: new Date(1779204000 * 1000).toISOString(), rateLimitType: null }
	const line = `2026-06-18 prefix CODER_LOOP_RATE_LIMIT ${JSON.stringify(reset)}`
	expect(parseRateLimitNoticeLine(line)?.resetsAt).toBe(1779204000)
})
