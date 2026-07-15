import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("runner filesystem grants e2e driver", () => {
	test("renders the real-runner probe as a quote-free shell command", () => {
		const source = readFileSync(resolve(import.meta.dir, "runner-filesystem-grants-e2e.ts"), "utf8")
		const command = source.match(/without a PTY[^\n]*:\\n\\n([^\n]+)\\n\\nThe script itself/)?.[1]
		expect(command).toBeDefined()
		expect(command).toBe("/bin/sh ./runner-filesystem-probe.sh {{RUN_ID}} {{CHAIN_NAME}} {{PRESET_DIR}} {{SHARED_CONTEXT_FILE}} {{CURRENT_ISSUE_FILE}} {{EVIDENCE_DIR}} ${loopDataRoot}/chains/{{CHAIN_NAME}}/undeclared.txt ${loopDataRoot}/chains/undeclared-other/private.txt ${loopDataRoot}/central.sqlite")
		expect(command).not.toMatch(/[\"']/)
	})
})
