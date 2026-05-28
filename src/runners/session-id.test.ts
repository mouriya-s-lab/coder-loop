import { describe, expect, test } from "bun:test"

import {
	claudeSessionIdInvalidDetector,
	codexSessionIdInvalidDetector,
	detectsSessionIdInvalid,
} from "./session-id"

describe("runner session id invalid detection", () => {
	test("codex detects resume thread ids that no longer exist", () => {
		const stderr = "thread/resume failed: no rollout found for thread id d400e2b2-04a4-44f8-8f13-3078f41a5593"
		expect(codexSessionIdInvalidDetector.detectsSessionIdInvalid(stderr)).toBe(true)
		expect(detectsSessionIdInvalid("codex", stderr)).toBe(true)
	})

	test("claude detects missing conversation session ids", () => {
		const stderr = "No conversation found with session ID: 019e6cf2-5b39-7b83-9bc5-8c8b96122682"
		expect(claudeSessionIdInvalidDetector.detectsSessionIdInvalid(stderr)).toBe(true)
		expect(detectsSessionIdInvalid("claude", stderr)).toBe(true)
	})

	test("does not treat ordinary runner stderr as session-id invalid", () => {
		expect(detectsSessionIdInvalid("codex", "transient network failure")).toBe(false)
		expect(detectsSessionIdInvalid("claude", "rate limit exceeded")).toBe(false)
	})
})
