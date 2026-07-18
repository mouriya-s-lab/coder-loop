import { DAEMON_RATE_LIMIT_STAGGER_MS, createDaemonRateLimitState, daemonRateLimitDecision, describe, expect, rateLimitStatusFromState, record, test } from "./harness"
import type { DaemonRateLimitState } from "./harness"

	const reset: { resetsAt: number; resetAtIso: string; rateLimitType: string | null } = {
		resetsAt: 2_000_000_000,
		resetAtIso: "2033-05-18T03:33:20.000Z",
		rateLimitType: "five_hour",
	}
	const cooldownNowMs = (reset.resetsAt - 60) * 1000
	const postResetNowMs = (reset.resetsAt + 5) * 1000


describe("daemonRateLimitDecision (issue #478)", () => {
	test("normal — no cooldown armed → no spawn cap", () => {
		const state = createDaemonRateLimitState()
		const decision = daemonRateLimitDecision(state, cooldownNowMs)
		expect(decision.kind).toBe("normal")
		expect(decision.maxSpawns).toBeUndefined()
	})

	test("paused — cooldown armed, reset not elapsed → 0 spawns", () => {
		const state = { ...createDaemonRateLimitState(), reset }
		const decision = daemonRateLimitDecision(state, cooldownNowMs)
		expect(decision.kind).toBe("paused")
		expect(decision.maxSpawns).toBe(0)
	})

	test("stagger-wait — reset elapsed, stagger window still cooling → 0 spawns", () => {
		const state = {
			...createDaemonRateLimitState(),
			reset,
			nextResumeAtMs: postResetNowMs + 10_000,
		}
		const decision = daemonRateLimitDecision(state, postResetNowMs)
		expect(decision.kind).toBe("stagger-wait")
		expect(decision.maxSpawns).toBe(0)
	})

	test("stagger-ready — reset elapsed, stagger window passed (or never armed) → cap = 1", () => {
		const stateReady = { ...createDaemonRateLimitState(), reset, nextResumeAtMs: postResetNowMs - 1 }
		const decisionReady = daemonRateLimitDecision(stateReady, postResetNowMs)
		expect(decisionReady.kind).toBe("stagger-ready")
		expect(decisionReady.maxSpawns).toBe(1)

		// Right after reset elapses, no stagger has armed yet → decision still grants 1.
		const stateFirstTick = { ...createDaemonRateLimitState(), reset }
		const decisionFirstTick = daemonRateLimitDecision(stateFirstTick, postResetNowMs)
		expect(decisionFirstTick.kind).toBe("stagger-ready")
		expect(decisionFirstTick.maxSpawns).toBe(1)
	})

	test("DAEMON_RATE_LIMIT_STAGGER_MS pins the post-reset stagger window per #157 history", () => {
		expect(DAEMON_RATE_LIMIT_STAGGER_MS).toBe(30_000)
	})

describe("rateLimitStatusFromState daemon.status wire shape (issue #478)", () => {
	const populatedState: DaemonRateLimitState = {
		reset: { resetsAt: 2_000_000_000, resetAtIso: "2033-05-18T03:33:20.000Z", rateLimitType: "five_hour" },
		observedAt: "2033-05-18T03:23:00.000Z",
		sourceRunId: "run-rate-limited-1",
		sourceItemId: 478,
		sourceChainId: 42,
		nextResumeAtMs: 2_000_000_030_000,
	}

	test("empty state — wire shape exposes all 10 fields with null/normal defaults", () => {
		const wire = rateLimitStatusFromState(createDaemonRateLimitState(), 1_900_000_000_000)
		expect(Object.keys(wire).sort()).toEqual([
			"active",
			"mode",
			"nextResumeAt",
			"observedAt",
			"rateLimitType",
			"rateLimitedUntil",
			"rateLimitedUntilUnix",
			"sourceChainId",
			"sourceItemId",
			"sourceRunId",
			"staggerMs",
		])
		expect(wire["active"]).toBe(false)
		expect(wire["mode"]).toBe("normal")
		expect(wire["rateLimitedUntil"]).toBeNull()
		expect(wire["rateLimitedUntilUnix"]).toBeNull()
		expect(wire["rateLimitType"]).toBeNull()
		expect(wire["observedAt"]).toBeNull()
		expect(wire["sourceRunId"]).toBeNull()
		expect(wire["sourceItemId"]).toBeNull()
		expect(wire["sourceChainId"]).toBeNull()
		expect(wire["nextResumeAt"]).toBeNull()
		expect(wire["staggerMs"]).toBe(DAEMON_RATE_LIMIT_STAGGER_MS)
	})

	test("populated state during cooldown — `active=true`, `mode=paused`, ISO + unix coexist (covers issue acceptance row 4)", () => {
		// nowMs before reset → paused
		const cooldownNowMs = (populatedState.reset!.resetsAt - 600) * 1000
		const wire = rateLimitStatusFromState(populatedState, cooldownNowMs)
		expect(wire["active"]).toBe(true)
		expect(wire["mode"]).toBe("paused")
		expect(wire["rateLimitedUntil"]).toBe("2033-05-18T03:33:20.000Z")
		expect(wire["rateLimitedUntilUnix"]).toBe(2_000_000_000)
		expect(wire["rateLimitType"]).toBe("five_hour")
		expect(wire["observedAt"]).toBe("2033-05-18T03:23:00.000Z")
		expect(wire["sourceRunId"]).toBe("run-rate-limited-1")
		expect(wire["sourceItemId"]).toBe(478)
		expect(wire["sourceChainId"]).toBe(42)
		// nextResumeAt is serialized as an ISO string when nextResumeAtMs is set.
		expect(wire["nextResumeAt"]).toBe(new Date(populatedState.nextResumeAtMs!).toISOString())
		// JSON.stringify must not drop any field (undefined would be silently dropped) —
		// the round-trip pins this because every value above is either a primitive or null.
		const roundTrip = record(JSON.parse(JSON.stringify(wire)))
		expect(Object.keys(roundTrip).sort()).toEqual([
			"active", "mode", "nextResumeAt", "observedAt", "rateLimitType",
			"rateLimitedUntil", "rateLimitedUntilUnix", "sourceChainId",
			"sourceItemId", "sourceRunId", "staggerMs",
		])
	})

	test("populated state after reset, before stagger — `active=true`, `mode=stagger-wait`", () => {
		const wire = rateLimitStatusFromState(populatedState, populatedState.nextResumeAtMs! - 1)
		expect(wire["active"]).toBe(true)
		expect(wire["mode"]).toBe("stagger-wait")
	})

	test("populated state after stagger window — `active=false`, `mode=stagger-ready`", () => {
		const wire = rateLimitStatusFromState(populatedState, populatedState.nextResumeAtMs! + 1)
		expect(wire["active"]).toBe(false)
		expect(wire["mode"]).toBe("stagger-ready")
	})
})
})
