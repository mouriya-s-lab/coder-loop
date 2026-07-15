import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("runner filesystem grants e2e driver", () => {
	test("materializes model-independent probe arguments behind one declared-agent-cwd entry", () => {
		const source = readFileSync(resolve(import.meta.dir, "runner-filesystem-grants-e2e.ts"), "utf8")
		const command = source.match(/without a PTY[^\n]*:\\n\\n([^\n]+)\\n\\nThe script itself/)?.[1]
		const argumentDeclaration = source.match(/RUNNER_PROBE_ARGUMENTS_BEGIN\\n([^`]+?)\\nRUNNER_PROBE_ARGUMENTS_END/)?.[1]?.split("\\n")
		expect(command).toBeDefined()
		expect(source).toContain('AGENT_CWD = "runtime.agentCwd"')
		expect(command).toBe("/bin/sh {{AGENT_CWD}}/runner-filesystem-probe.sh")
		expect(command).not.toContain(" ./runner-filesystem-probe.sh")
		expect(command).not.toMatch(/[\"']/)
		expect(argumentDeclaration).toEqual([
			"{{RUN_ID}}",
			"{{CHAIN_NAME}}",
			"{{PRESET_DIR}}",
			"{{SHARED_CONTEXT_FILE}}",
			"{{CURRENT_ISSUE_FILE}}",
			"{{EVIDENCE_DIR}}",
			"${loopDataRoot}/chains/{{CHAIN_NAME}}/undeclared.txt",
			"${loopDataRoot}/chains/undeclared-other/private.txt",
			"${loopDataRoot}/central.sqlite",
		])
		expect(source).toContain('const probeArguments = runnerPromptProbeArguments(args)')
		expect(source).toContain('await writeFile(resolve(process.cwd(), "runner-filesystem-probe.args"), probeArguments.join("\\\\n") + "\\\\n")')
	})
})
