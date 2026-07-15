import { describe, expect, test } from "bun:test"
import { AgentActivityAccumulator, activityWindows } from "./agent-activity"

describe("agent activity windows", () => {
	test("aggregates fixed windows and drops expired output", () => {
		const activity = new AgentActivityAccumulator()
		activity.observe(Buffer.from("old\n"), 0)
		activity.observe(Buffer.from("minute\n"), 242_000)
		activity.observe(Buffer.from("half-minute\n"), 272_000)
		activity.observe(Buffer.from("recent-a\nrecent-b\n"), 296_000)

		expect(activityWindows(activity.artifact(300_000), 300_000)).toEqual([
			{ seconds: 10, lines: 2 },
			{ seconds: 30, lines: 3 },
			{ seconds: 60, lines: 4 },
			{ seconds: 300, lines: 4 },
		])
	})

	test("counts complete lines across chunks without counting a partial line", () => {
		const activity = new AgentActivityAccumulator()
		activity.observe(Buffer.from("partial"), 100_000)
		activity.observe(Buffer.from(" line\nsecond\nunfinished"), 101_000)

		expect(activityWindows(activity.artifact(101_000), 101_000)[0]).toEqual({ seconds: 10, lines: 2 })
	})

	test("uses inclusive second buckets at each window boundary", () => {
		const activity = new AgentActivityAccumulator()
		activity.observe(Buffer.from("inside\n"), 91_000)
		activity.observe(Buffer.from("outside\n"), 90_000)

		expect(activityWindows(activity.artifact(100_000), 100_000)[0]).toEqual({ seconds: 10, lines: 1 })
		expect(activityWindows(activity.artifact(101_000), 101_000)[0]).toEqual({ seconds: 10, lines: 0 })
	})
})
