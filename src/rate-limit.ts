/**
 * Account-level rate-limit detection — shared by the legacy in-process loop (`loop.ts`)
 * and the centralized daemon scheduler (`scheduler.ts` / `daemon.ts`).
 *
 * The runner (claude / codex) emits account rate-limit signals as JSONL on stdout. When a
 * session limit is hit the process is rejected within ~2s and exits non-zero; stderr is empty.
 * Detection therefore scans stdout, not stderr.
 */
import { type as arkType } from "arktype"

export type RateLimitReset = {
	resetsAt: number
	resetAtIso: string
	rateLimitType: string | null
}

export const RATE_LIMIT_ERROR_CODE = "rate_limit_429"
const NOTICE_PREFIX = "CODER_LOOP_RATE_LIMIT"

export const RateLimitResetBoundary = arkType({
	resetsAt: "number",
	resetAtIso: "string",
	"rateLimitType": "string|null",
})

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function resetFromInfo(info: Record<string, unknown>): RateLimitReset | null {
	if (info.status !== "rejected") return null
	if (typeof info.resetsAt !== "number" || !Number.isFinite(info.resetsAt) || info.resetsAt <= 0) return null
	return {
		resetsAt: info.resetsAt,
		resetAtIso: new Date(info.resetsAt * 1000).toISOString(),
		rateLimitType: typeof info.rateLimitType === "string" && info.rateLimitType !== "" ? info.rateLimitType : null,
	}
}

/**
 * Reverse-scan stdout for the most recent `rate_limit_event` with `status:"rejected"` and
 * extract its `resetsAt` Unix timestamp. The runner exits < 1s after the rejected event, so a
 * post-mortem parse of the full stdout buffer is sufficient — no realtime stream watch needed.
 */
export function extractRateLimitReset(stdoutText: string): RateLimitReset | null {
	const lines = stdoutText.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (line === undefined || line.trim() === "") continue
		try {
			const parsed: unknown = JSON.parse(line)
			if (!isObjectRecord(parsed) || parsed.type !== "rate_limit_event") continue
			const info = parsed.rate_limit_info
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
 * Classify a single parsed JSONL event as a rate-limit error code (or null).
 * Recognizes the three shapes claude/codex emit:
 *   - `api_error_status === 429` (result event)
 *   - `error === "rate_limit"` (synthetic assistant message)
 *   - `result` text mentioning hit-your-limit / rate-limit
 */
export function extractRateLimitErrorCodeFromEvent(event: Record<string, unknown>): string | null {
	if (event.api_error_status === 429) return RATE_LIMIT_ERROR_CODE
	if (event.error === "rate_limit") return RATE_LIMIT_ERROR_CODE
	if (typeof event.result === "string" && /hit your (?:session )?limit|rate[\s_-]?limit/i.test(event.result)) return RATE_LIMIT_ERROR_CODE
	return null
}

export function isRateLimitErrorCode(code: string): boolean {
	const lower = code.toLowerCase()
	return lower.includes("rate_limit") || lower.includes("rate-limit") || lower.includes("ratelimit")
}

/**
 * Scan stdout for any rate-limit signal. Returns both the error code (from any 429/rate_limit
 * JSONL line) and the extracted reset (from the most recent rejected rate_limit_event). The
 * daemon close handler calls this once per agent exit.
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
			if (reset === null && parsed.type === "rate_limit_event") {
				const info = parsed.rate_limit_info
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

/**
 * Format a reset as a single-line notice the legacy in-process loop prints to stdout, so an
 * observer (daemon or supervisor) can detect rate-limit without parsing runner internals.
 */
export function formatRateLimitNotice(reset: RateLimitReset): string {
	return `${NOTICE_PREFIX} ${JSON.stringify(reset)}`
}

export function parseRateLimitNoticeLine(line: string): RateLimitReset | null {
	const prefixIndex = line.indexOf(NOTICE_PREFIX)
	if (prefixIndex < 0) return null
	const jsonStart = line.indexOf("{", prefixIndex + NOTICE_PREFIX.length)
	if (jsonStart < 0) return null
	try {
		const parsed: unknown = JSON.parse(line.slice(jsonStart))
		if (!isObjectRecord(parsed)) return null
		if (typeof parsed.resetsAt !== "number" || !Number.isFinite(parsed.resetsAt) || parsed.resetsAt <= 0) return null
		return {
			resetsAt: parsed.resetsAt,
			resetAtIso: typeof parsed.resetAtIso === "string" && parsed.resetAtIso !== ""
				? parsed.resetAtIso
				: new Date(parsed.resetsAt * 1000).toISOString(),
			rateLimitType: typeof parsed.rateLimitType === "string" && parsed.rateLimitType !== "" ? parsed.rateLimitType : null,
		}
	} catch {
		return null
	}
}

