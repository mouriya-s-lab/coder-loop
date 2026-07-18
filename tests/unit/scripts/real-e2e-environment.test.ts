import { describe, expect, test } from "bun:test"
import { operatorSubprocessEnvironment } from "../../../scripts/real-e2e-environment"

describe("real-e2e operator subprocess environment", () => {
	test("removes an inherited run credential without mutating the parent environment", () => {
		const parentEnvironment: NodeJS.ProcessEnv = {
			PATH: "/fixture/bin",
			CODER_LOOP_RUN_CRED: "credential-from-parent-agent",
			REAL_E2E_SENTINEL: "preserved",
		}

		const subprocessEnvironment = operatorSubprocessEnvironment(parentEnvironment)

		expect(subprocessEnvironment).toEqual({
			PATH: "/fixture/bin",
			REAL_E2E_SENTINEL: "preserved",
		})
		expect(parentEnvironment.CODER_LOOP_RUN_CRED).toBe("credential-from-parent-agent")
	})
})
