import { describe, expect, test } from "bun:test"

import {
	claudeSessionIdInvalidDetector,
	codexSessionIdInvalidDetector,
	detectsSessionIdInvalid,
	opencodeSessionIdInvalidDetector,
} from "../../../src/runners/session-id"

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
		expect(detectsSessionIdInvalid("opencode", "transient network failure")).toBe(false)
	})

	test("opencode detects missing session ids with ANSI color codes", () => {
		// Real shape observed from `opencode run -s <fake-ses-id>` on the operator's machine:
		// stderr is a single colored line — `\x1b[91m\x1b[1mError: \x1b[0mSession not found\n`.
		// The `\b` word-boundary anchor in the detector regex must work even though the ANSI CSI
		// terminator byte right before `Session` is `m` (a word character). The detector strips
		// CSI sequences before matching, so the boundary check sees `Error: Session not found`.
		const ansiStderr = "\x1b[91m\x1b[1mError: \x1b[0mSession not found\n"
		expect(opencodeSessionIdInvalidDetector.detectsSessionIdInvalid(ansiStderr)).toBe(true)
		expect(detectsSessionIdInvalid("opencode", ansiStderr)).toBe(true)
		// The bare un-colored phrase (e.g., when stderr is piped through a stripping wrapper)
		// must also match — the colored form is the only one observed in the wild but the
		// detector should remain robust either way.
		const bareStderr = "Error: Session not found"
		expect(opencodeSessionIdInvalidDetector.detectsSessionIdInvalid(bareStderr)).toBe(true)
		expect(detectsSessionIdInvalid("opencode", bareStderr)).toBe(true)
	})

	// #528 spike: the regex must reject partial / adjacent matches so that an unrelated stderr
	// mentioning "Session" or "not found" doesn't get classified as an invalid-session signal.
	// These cases lock the regex shape so refactors (e.g., loosening to `/session.*not found/`)
	// can't silently expand the match set.
	test("opencode rejects partial / adjacent stderr lines that mention session or not-found", () => {
		const rejects = [
			// "Session" appears, but the literal "not found" phrase does not.
			"Session created successfully",
			"Session expired, please re-authenticate",
			// "not found" appears, but not paired with the "Session" word the regex requires.
			"Error: file not found",
			"Error: command not found",
			// Right tokens but in wrong order (regex anchors on `Error: Session not found`, ordered).
			"Session not found Error",
			// Empty stderr — opencode is allowed to exit non-zero with no stderr; engine MUST
			// treat that as transient, not as an invalidation signal.
			"",
		]
		for (const stderr of rejects) {
			expect(detectsSessionIdInvalid("opencode", stderr)).toBe(false)
		}
	})
})
