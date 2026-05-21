export type RateLimitReset = {
	resetsAt: number
	resetAtIso: string
	rateLimitType: string | null
}

export const RATE_LIMIT_ERROR_CODE = "rate_limit_429"
const NOTICE_PREFIX = "CODER_LOOP_RATE_LIMIT"

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

export function extractRateLimitErrorCodeFromEvent(event: Record<string, unknown>): string | null {
	if (event.api_error_status === 429) return RATE_LIMIT_ERROR_CODE
	if (event.error === "rate_limit") return RATE_LIMIT_ERROR_CODE
	if (typeof event.result === "string" && /hit your limit|rate[\s_-]?limit/i.test(event.result)) return RATE_LIMIT_ERROR_CODE
	return null
}

export function isRateLimitErrorCode(code: string): boolean {
	const lower = code.toLowerCase()
	return lower.includes("rate_limit") || lower.includes("rate-limit") || lower.includes("ratelimit")
}

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
