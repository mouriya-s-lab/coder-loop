import { expect, test } from "bun:test"

import { assertAgentsMdCurrent, renderAgentsMd } from "./sync-agents-md"

test("AGENTS.md is a regular, current merge of CLAUDE.md and enabled Claude rules", async () => {
	await expect(assertAgentsMdCurrent()).resolves.toBeUndefined()
	const rendered = await renderAgentsMd()
	expect(rendered).toContain("<!-- BEGIN SOURCE: CLAUDE.md -->")
	expect(rendered).toContain("<!-- BEGIN SOURCE: .claude/rules/code-vs-app-boundary.rule.md -->")
})
