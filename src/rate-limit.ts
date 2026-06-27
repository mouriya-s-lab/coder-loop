/**
 * Account-level rate-limit detection on runner stdout.
 *
 * The runner (claude / codex / opencode) emits account rate-limit signals as JSONL on stdout.
 * When a session limit is hit the process is rejected within ~2 s and exits non-zero; stderr is
 * empty. Detection therefore scans stdout, not stderr. The functions here are pure (no I/O, no
 * scheduler state), so the centralized daemon close handler can call them off the run's captured
 * stdout buffer and the legacy `extractErrorCode` path in `loop.ts` can also wire them in.
 *
 * W3 chain 35/37/38 (2026-06-17) observed shape:
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781713800,...}}
 *   {"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · ..."}
 */
import { type as arkType } from "arktype"

export type RateLimitReset = {
	resetsAt: number
	resetAtIso: string
	rateLimitType: string | null
}

export const RATE_LIMIT_ERROR_CODE = "rate_limit_429"

export const RateLimitResetBoundary = arkType({
	resetsAt: "number",
	resetAtIso: "string",
	"rateLimitType": "string|null",
})

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function resetFromInfo(info: Record<string, unknown>): RateLimitReset | null {
	if (info["status"] !== "rejected") return null
	const resetsAt = info["resetsAt"]
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null
	const rateLimitType = info["rateLimitType"]
	return {
		resetsAt,
		resetAtIso: new Date(resetsAt * 1000).toISOString(),
		rateLimitType: typeof rateLimitType === "string" && rateLimitType !== "" ? rateLimitType : null,
	}
}

/**
 * Reverse-scan stdout for the most recent `rate_limit_event` with `status:"rejected"` and
 * extract its `resetsAt` Unix timestamp. The runner exits < 1 s after the rejected event, so a
 * post-mortem parse of the full stdout buffer is sufficient — no realtime stream watch needed.
 */
export function extractRateLimitReset(stdoutText: string): RateLimitReset | null {
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: unknown = JSON.parse(line)
			if (!isObjectRecord(parsed) || parsed["type"] !== "rate_limit_event") continue
			const info = parsed["rate_limit_info"]
			if (!isObjectRecord(info)) continue
			const reset = resetFromInfo(info)
			if (reset !== null) return reset
		} catch {
			continue
		}
	}
	return null
}

/**
 * Classify a single parsed JSONL event as a rate-limit error code (or null). Recognizes the
 * three shapes claude/codex/opencode emit:
 *   - `api_error_status === 429` (result event)
 *   - `error === "rate_limit"` (synthetic assistant message)
 *   - `result` text mentioning "hit (your) (session) limit" or "rate limit"
 */
export function extractRateLimitErrorCodeFromEvent(event: Record<string, unknown>): string | null {
	if (event["api_error_status"] === 429) return RATE_LIMIT_ERROR_CODE
	if (event["error"] === "rate_limit") return RATE_LIMIT_ERROR_CODE
	const result = event["result"]
	if (typeof result === "string" && /hit your (?:session )?limit|rate[\s_-]?limit/i.test(result)) return RATE_LIMIT_ERROR_CODE
	return null
}

export function isRateLimitErrorCode(code: string): boolean {
	const lower = code.toLowerCase()
	return lower.includes("rate_limit") || lower.includes("rate-limit") || lower.includes("ratelimit")
}

/**
 * Scan stdout for any rate-limit signal in one pass. Returns the error code (from any 429 /
 * rate_limit JSONL line) and the extracted reset (from the most recent rejected rate_limit_event).
 * The daemon close handler calls this once per agent exit; the legacy `extractErrorCode` in
 * loop.ts delegates here before falling through to its stderr-keyword scan.
 */
export function classifyRateLimitFromStdout(stdoutText: string): { code: string | null; reset: RateLimitReset | null } {
	let code: string | null = null
	let reset: RateLimitReset | null = null
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: unknown = JSON.parse(line)
			if (!isObjectRecord(parsed)) continue
			if (code === null) {
				const eventCode = extractRateLimitErrorCodeFromEvent(parsed)
				if (eventCode !== null) code = eventCode
			}
			if (reset === null && parsed["type"] === "rate_limit_event") {
				const info = parsed["rate_limit_info"]
				if (isObjectRecord(info)) {
					const candidate = resetFromInfo(info)
					if (candidate !== null) reset = candidate
				}
			}
			if (code !== null && reset !== null) break
		} catch {
			continue
		}
	}
	return { code, reset }
}
