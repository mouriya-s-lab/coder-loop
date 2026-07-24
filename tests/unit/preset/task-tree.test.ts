import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { compilePreset, loadPreset } from "../../../src/loop"

async function withPreset(toml: string, run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(resolve(tmpdir(), "coder-loop-task-tree-"))
	try {
		await writeFile(resolve(root, "preset.toml"), toml)
		await writeFile(resolve(root, "a.md"), "A\n")
		await writeFile(resolve(root, "b.md"), "B\n")
		await writeFile(resolve(root, "path.md"), "B {{RESULT}} {{ISSUE}}\n")
		await run(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

const header = `name = "task-tree"
[item]
idField = "id"
[item.fields]
id = "string"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
[[phases]]
name = "a"
prompt = "a.md"
[[phases.exits]]
status = "done"
when = "legacy compatibility"
[[phases]]
name = "b"
prompt = "b.md"
[[phases.exits]]
status = "done"
when = "legacy compatibility"
`

describe("recursive task declaration", () => {
	test("compiles stable seq/par nodes and typed transition paths", async () => {
		await withPreset(`${header}
[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "a", kind = "phase", phase = "a", paths = [
    { id = "to-b", target = "b", fields = { result = "string" }, bindings = { RESULT = "exit.result", ISSUE = "item.id" }, prompt = "path.md" }
  ] },
  { id = "b", kind = "phase", phase = "b", paths = [
    { id = "finish" }
  ] }
]
`, async (root) => {
			const preset = await loadPreset(root)
			expect(preset.taskDeclaration).toEqual({
				identity: "root",
				kind: "seq",
				completeStatus: "done",
				children: [
					{
						identity: "a",
						kind: "phase",
						phase: "a",
						paths: [{
							identity: "to-b",
							target: "b",
							fields: [{ name: "result", type: "string", required: true }],
							bindings: [
								{ target: "RESULT", source: { kind: "exit", field: "result" }, required: true },
								{ target: "ISSUE", source: { kind: "item", field: "id" }, required: true },
							],
							prompt: "path.md",
						}],
					},
					{ identity: "b", kind: "phase", phase: "b", paths: [{ identity: "finish", target: null, fields: [], bindings: [], prompt: null }] },
				],
			})
		})
	})

	test("rejects a dangling transition target at compile time", async () => {
		await withPreset(`${header}
[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "a", kind = "phase", phase = "a", paths = [{ id = "broken", target = "missing" }] }
]
`, async (root) => {
			const result = await compilePreset(root)
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected") expect(result.diagnostics).toContainEqual(expect.objectContaining({
				rule: "task-structure",
				message: expect.stringContaining('path "broken" targets unknown node "missing"'),
			}))
		})
	})

	test("rejects duplicate phase nodes because one item phase owns one persistent closure", async () => {
		await withPreset(`${header}
[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "first-a", kind = "phase", phase = "a", paths = [{ id = "next", target = "second-a" }] },
  { id = "second-a", kind = "phase", phase = "a", paths = [{ id = "finish" }] }
]
`, async (root) => {
			const result = await compilePreset(root)
			expect(result.kind).toBe("rejected")
			if (result.kind === "rejected") expect(result.diagnostics).toContainEqual(expect.objectContaining({
				rule: "task-structure",
				message: expect.stringContaining('phase "a" is already referenced by task node "first-a"'),
			}))
		})
	})
})
