import { describe, expect, test } from "bun:test"

import { withInjectedRunCredential } from "../../../src/loop"

describe("agent credential command injection", () => {
	test("task transition carries the runner credential while anonymous and read-only calls remain unclaimed", () => {
		const transition = withInjectedRunCredential(
			"item.transition",
			{ itemId: "item", agentRunId: "run", agentPhase: "phase", path: "finish", exit: {} },
			{ CODER_LOOP_RUN_CRED: "credential-bound-to-run" },
		)
		expect(transition).toMatchObject({ agentCredential: "credential-bound-to-run" })

		const anonymous = withInjectedRunCredential(
			"item.transition",
			{ itemId: "item", agentRunId: "run", agentPhase: "phase", path: "finish", exit: {} },
			{},
		)
		expect(anonymous).not.toHaveProperty("agentCredential")

		const exits = withInjectedRunCredential(
			"item.exits",
			{ itemId: "item", agentRunId: "run", agentPhase: "phase" },
			{ CODER_LOOP_RUN_CRED: "credential-bound-to-run" },
		)
		expect(exits).not.toHaveProperty("agentCredential")
	})
})
