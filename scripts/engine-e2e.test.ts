import { describe, expect, test } from "bun:test"
import { extractPromptArg, parseStubPrompt } from "./engine-e2e-stub-runner"
import { sanitizedSubprocessEnvironment } from "./engine-e2e"

describe("engine-e2e stub runner prompt contract", () => {
	test("parses PHASE/CHAIN/ITEM/RUN lines from a rendered entry prompt", () => {
		const prompt = [
			"engine-e2e deterministic stub protocol.",
			"",
			"PHASE=iteration",
			"CHAIN=engine-e2e-abc",
			"ITEM=e2e-item-1",
			"RUN=run-123",
			"",
			"Task: commit the marker.",
			"",
			"## 完成协议（统一）",
		].join("\n")
		expect(parseStubPrompt(prompt)).toEqual({
			phase: "iteration",
			chain: "engine-e2e-abc",
			item: "e2e-item-1",
			run: "run-123",
		})
	})

	test("rejects prompts missing a required fact line", () => {
		expect(() => parseStubPrompt("PHASE=review\nCHAIN=c\nITEM=i\n")).toThrow(/missing PHASE\/CHAIN\/ITEM\/RUN/)
	})

	test("extracts the prompt from agentClaudeArgs-shaped argv (`-p` carries the prompt)", () => {
		const argv = ["--output-format", "stream-json", "--verbose", "--add-dir", "/a", "/b", "-p", "PHASE=review\n"]
		expect(extractPromptArg(argv)).toBe("PHASE=review\n")
	})

	test("rejects argv without `-p`", () => {
		expect(() => extractPromptArg(["--verbose"])).toThrow(/expects `-p <prompt>`/)
	})
})

describe("engine-e2e subprocess environment", () => {
	test("strips outer run credential and loop-data pointer (dogfood isolation)", () => {
		const env = sanitizedSubprocessEnvironment({
			PATH: "/usr/bin",
			CODER_LOOP_RUN_CRED: "outer-secret",
			CODER_LOOP_DATA_DIR: "/outer/loop-data",
		})
		expect(env.PATH).toBe("/usr/bin")
		expect(env.CODER_LOOP_RUN_CRED).toBeUndefined()
		expect(env.CODER_LOOP_DATA_DIR).toBeUndefined()
	})
})
