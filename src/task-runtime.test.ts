import { describe, expect, test } from "bun:test"

import { assertTaskTreeSnapshot } from "./task-runtime"

const identity = {
	runtimeNodeId: "root",
	definitionRef: { kind: "chain", contentIdentity: "sha256:exact-boundary" },
	definitionNodeId: "definition-root",
}

const closure = {
	closureId: "closure-leaf",
	itemRowId: 1,
	itemId: "item-1",
	phase: "iteration",
	lifecycle: "active",
	worktreePath: "/worktree",
	branchName: "issue-1",
	baseCommit: "0123456789abcdef",
	sourceParNodeId: null,
	sessions: [{ runner: "codex", sessionId: "session-1" }],
}

describe("task runtime exact boundary", () => {
	test("rejects undeclared keys recursively across task runtime variants", () => {
		const leaf = { kind: "leaf", identity, closure }
		const valid = { root: leaf, activeRuns: [{ closureId: closure.closureId, runId: "run-1", phase: closure.phase, startedAt: 1 }] }
		expect(() => assertTaskTreeSnapshot(valid)).not.toThrow()

		const invalidInputs = [
			{ ...valid, extra: true },
			{ ...valid, root: { ...leaf, extra: true } },
			{ ...valid, root: { ...leaf, identity: { ...identity, extra: true } } },
			{ ...valid, root: { ...leaf, identity: { ...identity, definitionRef: { ...identity.definitionRef, extra: true } } } },
			{ ...valid, root: { ...leaf, closure: { ...closure, extra: true } } },
			{ ...valid, root: { ...leaf, closure: { ...closure, sessions: [{ ...closure.sessions[0], extra: true }] } } },
			{ ...valid, activeRuns: [{ ...valid.activeRuns[0], extra: true }] },
		]
		for (const input of invalidInputs) expect(() => assertTaskTreeSnapshot(input)).toThrow()
	})

	test("rejects undeclared keys in seq, par, join and evaluation records", () => {
		const leaf = { kind: "leaf", identity: { ...identity, runtimeNodeId: "leaf" }, closure }
		const par = {
			kind: "par",
			identity: { ...identity, runtimeNodeId: "par" },
			groupId: "par",
			pinCommit: closure.baseCommit,
			state: "open",
			reopen: { count: 0, budgetRef: "chain.maxReopens" },
			join: { currentVersion: 1, value: { kind: "drain" }, evaluation: { kind: "not-evaluating" } },
			children: [leaf],
		}
		const seq = { kind: "seq", identity, cursor: { kind: "next", nodeId: "par" }, children: [par] }
		const invalidRoots = [
			{ ...seq, cursor: { ...seq.cursor, extra: true } },
			{ ...seq, children: [{ ...par, reopen: { ...par.reopen, extra: true } }] },
			{ ...seq, children: [{ ...par, join: { ...par.join, extra: true } }] },
			{ ...seq, children: [{ ...par, join: { ...par.join, value: { kind: "drain", extra: true } } }] },
			{ ...seq, children: [{ ...par, join: { ...par.join, evaluation: { kind: "not-evaluating", extra: true } } }] },
		]
		for (const root of invalidRoots) expect(() => assertTaskTreeSnapshot({ root, activeRuns: [] })).toThrow()
	})
})
