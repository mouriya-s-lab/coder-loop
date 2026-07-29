import { describe, expect, test } from "bun:test"

import {
	DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
	chainCompleteTriggerPhases,
	parsePreset,
	renderRuntimeInputsDoc,
	triggeredPhasesAfter,
	ResolveContext,
	BoundaryRecord,
	status,
	makeMinimalRuntimeBindings,
	makeItemRecord,
} from "./helpers"

describe("parsePreset schema validation", () => {
	// `fragments` is omitted by default so most tests do not have to declare a
	// matching `roles` array on every phase. Tests that exercise fragment-
	// related contracts (duplicate id, fragment path, accepts-minimal) add their
	// own `fragments` + `roles`.
	const minimalRoot = () => ({
		name: "x",
		item: { idField: "id" },
		// #402: every preset must declare `exhausted` (D2 verdict) and the value must be
		// a member of `terminal`. Tests that pin the rejection path override this directly.
		statuses: { continuable: ["a"], terminal: ["b"], exhausted: "b" },
		phases: [
			{ name: "p", prompt: "p.md", variables: { K: "item.id" } },
		],
		agent: { binary: "echo" },
	})

	test("runtime input doc decoration is schema driven", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{
				name: "p",
				prompt: "p.md",
				variables: {
					ISSUE: { source: "runtime.runId", label: "Named issue", prefix: "ref:", suffix: "!", style: "plain" },
					TICKET: { source: "runtime.runId", label: "Ticket", prefix: "#", suffix: " after", style: "code" },
				},
			}],
		}
		const preset = parsePreset(root, "/tmp")
		const phase = preset.phases[0]!
		expect(phase.variables.map((variable) => variable.doc)).toEqual([
			{ label: "Named issue", prefix: "ref:", suffix: "!", style: "plain", blankBefore: false },
			{ label: "Ticket", prefix: "#", suffix: " after", style: "code", blankBefore: false },
		])
		const runtime = makeMinimalRuntimeBindings()
		runtime.runId = "539"
		const ctx: ResolveContext = { item: makeItemRecord(), chain: {}, runtime, preset }

		expect(renderRuntimeInputsDoc(phase, ctx)).toBe("- Named issue: ref:539!\n- Ticket: `#539` after")
	})

	test("rejects doc decoration without a label but retains default-only object bindings", () => {
		const decorationFields: ReadonlyArray<readonly [string, string | boolean]> = [
			["prefix", "#"],
			["suffix", "!"],
			["style", "plain"],
			["blankBefore", true],
		]
		for (const [field, value] of decorationFields) {
			const root: BoundaryRecord = {
				...minimalRoot(),
				phases: [{ name: "p", prompt: "p.md", variables: { X: { source: "chain.optional", default: "", [field]: value } } }],
			}
			expect(() => parsePreset(root, "/tmp"), field).toThrow(/\.label: required when doc decoration fields are declared/)
		}

		const defaultOnly: BoundaryRecord = {
			...minimalRoot(),
			phases: [{ name: "p", prompt: "p.md", variables: { X: { source: "chain.optional", default: "" } } }],
		}
		expect(parsePreset(defaultOnly, "/tmp").phases[0]!.variables[0]).toEqual({
			key: "X",
			source: { kind: "chain", field: "optional", fallback: { kind: "value", value: "" } },
			doc: null,
		})
	})

	test("rejects unknown variable binding fields", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{
				name: "p",
				prompt: "p.md",
				variables: {
					X: { source: "item.id", label: "Issue", prefx: "#", style: "code" },
				},
			}],
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(
			/preset\.phases\[0\]\.variables\.X\.prefx: unrecognized variable binding field/,
		)
	})

	test("rejects bogus variable prefix", () => {
		const root = minimalRoot()
		root.phases[0]!.variables = { K: "bogus.x" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/bogus\.x/)
	})

	test("rejects bare name (no dot) variable source", () => {
		const root = minimalRoot()
		root.phases[0]!.variables = { K: "noDot" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/noDot/)
	})

	test("rejects continuable / terminal overlap", () => {
		const root = minimalRoot()
		root.statuses = { continuable: ["a", "b"], terminal: ["b", "c"], exhausted: "b" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/both continuable and terminal/)
	})

	// #402: D2 verdict — `statuses.exhausted` is a required preset declaration. The
	// arktype boundary rejects a missing field with the field path inside the error.
	test("rejects a preset that omits statuses.exhausted (#402)", () => {
		// parsePreset accepts BoundaryValue (= unknown). The arktype boundary is the
		// runtime gate; constructing a deliberately-incomplete object is how we exercise
		// the load-time rejection — the TypeScript type of minimalRoot() carries the
		// declared shape, so we route through a record-typed variable to construct an
		// input that statically lacks `exhausted`.
		const root: BoundaryRecord = { ...minimalRoot(), statuses: { continuable: ["a"], terminal: ["b"] } }
		expect(() => parsePreset(root, "/tmp")).toThrow(/exhausted/)
	})

	// #402: load-time validation also rejects an exhausted落点 that is not in the
	// terminal vocabulary — engine writes the value directly, so it must be reachable
	// as a terminal status.
	test("rejects a preset whose statuses.exhausted is not in terminal (#402)", () => {
		const root = minimalRoot()
		root.statuses = { continuable: ["a"], terminal: ["b"], exhausted: "not_a_terminal_status" }
		expect(() => parsePreset(root, "/tmp")).toThrow(/preset\.statuses\.exhausted.*must be one of statuses\.terminal/)
	})

	test("rejects duplicate phase name", () => {
		const root = minimalRoot()
		root.phases = [
			{ name: "p", prompt: "p1.md", variables: { K: "item.id" } },
			{ name: "p", prompt: "p2.md", variables: { K: "item.id" } },
		]
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate name "p"/)
	})

	// #456: previously asserted the "last non-trigger phase" position via an engine helper. That
	// helper enforced an engine assumption the DSL never declared; with the taxonomy retired the
	// test pins the trigger declaration itself.
	test("accepts trigger phases and exposes them via triggeredPhasesAfter", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued"], terminal: ["blocked", "done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(preset.phases.filter((phase) => phase.trigger === null).map((phase) => phase.name)).toEqual(["iteration", "review"])
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
			expect(triggeredPhasesAfter(preset, "review", status("done"))).toEqual([])
	})

	// #456: the role-shaped `summaryMarker` field on `PresetPhase` is retired with the taxonomy;
	// this test now pins per-phase exits and the explicit phase runner instead. The prior
	// "summaryMarker defaults to null for both phases" assertion is unrepresentable (no field).
	test("accepts per-phase exit declarations and per-phase runner overrides", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued", "in_progress"], terminal: ["done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", runner: "claude", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")

			// #405 ADT projection: this test's phases all use the item-status branch so the
			// narrowed view yields the same shape the pre-ADT projection used.
			expect(preset.phases.map((phase) => phase.exits.flatMap((exit) => exit.kind === "item-status" ? [exit.status] : []))).toEqual([[status("in_progress")], [status("done")]])
		expect(preset.phases[1]!.defaultRunner).toBe("claude")
	})

	test("preset loader accepts opencode runner", () => {
		// #481 acceptance #1: `runner = "opencode"` on a preset phase must round-trip through
		// the loader and produce `defaultRunner = "opencode"`. Mirrors the per-phase override
		// test above; the only diff is the third runner kind. Catches any regression where the
		// ark boundary, `parsePhaseRunner`, or the AgentRunnerKind union slips back to a
		// `claude | codex` binary.
		const root: BoundaryRecord = minimalRoot()
		root.statuses = { continuable: ["queued", "in_progress"], terminal: ["done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", runner: "opencode", exits: [{ status: "in_progress", when: "handoff" }], variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "done", when: "accepted" }], variables: { K: "item.id" } },
		]

		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.defaultRunner).toBe("opencode")
	})

	test("accepts manual unblock statuses declared as terminal subset", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["parked", "finished"], entry: "ready", unblockable: ["parked"], exhausted: "finished" }

		const preset = parsePreset(root, "/tmp")

		expect(preset.statuses.entry).toBe("ready")
		expect([...preset.statuses.unblockable]).toEqual(["parked"])
	})

	test("rejects manual unblock statuses outside terminal set", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["finished"], entry: "ready", unblockable: ["parked"], exhausted: "finished" }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: "parked" must be one of statuses\.terminal/)
	})

	test("rejects duplicate manual unblock statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["ready"], terminal: ["parked"], entry: "ready", unblockable: ["parked", "parked"], exhausted: "parked" }

		expect(() => parsePreset(root, "/tmp")).toThrow(/statuses\.unblockable: duplicate status "parked"/)
	})

	test("rejects per-phase exit declarations outside preset statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "missing", when: "bad" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: unrecognized status "missing"/)
	})

	test("rejects duplicate per-phase exit declarations", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", exits: [{ status: "a", when: "one" }, { status: "a", when: "two" }], variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/exits\.status: duplicate status "a"/)
	})

	test("accepts chain-complete trigger phases", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued"], terminal: ["blocked", "done"], exhausted: "done" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "review", prompt: "review.md", exits: [{ status: "blocked", when: "blocked" }], variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
			{ name: "finalizer", prompt: "finalizer.md", trigger: { on: "chain-complete" }, variables: { K: "runtime.runId" } },
		]

		const preset = parsePreset(root, "/tmp")

			expect(preset.phases[2]!.trigger).toEqual({ afterPhase: "review", whenStatus: status("blocked") })
			expect(preset.phases[3]!.trigger).toEqual({ on: "chain-complete" })
			// #456: previously this also asserted the "last non-trigger phase" position via an engine
			// helper. With the role-shaped helper retired the test pins the non-trigger phase order
			// via preset structure directly; "review" being the last non-trigger phase is now a
			// property of the test fixture, not engine knowledge.
			expect(preset.phases.filter((phase) => phase.trigger === null).map((phase) => phase.name)).toEqual(["iteration", "review"])
			expect(triggeredPhasesAfter(preset, "review", status("blocked")).map((phase) => phase.name)).toEqual(["responder"])
		expect(chainCompleteTriggerPhases(preset).map((phase) => phase.name)).toEqual(["finalizer"])
	})

	test("rejects trigger afterPhase that does not name a declared phase", () => {
		const root: BoundaryRecord = minimalRoot()
		root.statuses = {continuable: ["queued"], terminal: ["blocked"], exhausted: "blocked" }
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "review", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.afterPhase: unrecognized phase "review"/)
	})

	test("rejects trigger whenStatus outside preset statuses", () => {
		const root: BoundaryRecord = minimalRoot()
		root.phases = [
			{ name: "iteration", prompt: "iter.md", variables: { K: "item.id" } },
			{ name: "responder", prompt: "responder.md", trigger: { afterPhase: "iteration", whenStatus: "blocked" }, variables: { K: "item.id" } },
		]

		expect(() => parsePreset(root, "/tmp")).toThrow(/trigger\.whenStatus: unrecognized status "blocked"/)
	})

	test("rejects duplicate fragment id", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			fragments: [
				{ id: "f", role: "x", path: "f1.md" },
				{ id: "f", role: "x", path: "f2.md" },
			],
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/duplicate id "f"/)
	})

	test("rejects misspelled item field reference (e.g. item.stauts instead of item.status)", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.stauts" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unrecognized item field "stauts"/)
	})

	test("accepts declared runtime business keys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: { businessKeys: ["customBusiness"] },
			phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.customBusiness" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect([...preset.runtime.businessKeys]).toEqual(["customBusiness"])
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "runtime", key: "customBusiness", ownership: "preset" }, doc: null })
	})

	test("rejects undeclared runtime business keys", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.customBusiness" } }] }
		expect(() => parsePreset(root, "/tmp")).toThrow(/unknown runtime key "customBusiness"/)
	})

	test("rejects runtime business key declarations that collide with engine facts", () => {
		const root: BoundaryRecord = { ...minimalRoot(), runtime: { businessKeys: ["runId"] } }
		expect(() => parsePreset(root, "/tmp")).toThrow(/"runId" is engine-owned/)
	})

	// #448: preset can supply business key values entirely within its own file
	// via `[runtime.businessKeyValues]`.
	test("accepts preset-supplied literal business key values", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: "demo-value" } },
			},
			phases: [{ name: "p", prompt: "p.md", variables: { X: "runtime.auditDemo" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(preset.runtime.businessKeyValues.get("auditDemo")).toEqual({ kind: "literal", value: "demo-value" })
	})

	test("rejects businessKeyValues entries not declared in businessKeys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { strayKey: { literal: "x" } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/strayKey: not declared in preset\.runtime\.businessKeys/)
	})

	test("rejects businessKeyValues entries with no value spec key", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: {} },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo: value spec must declare one of/)
	})

	test("rejects businessKeyValues literal that is not a string", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: 42 } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo\.literal: must be a string/)
	})

	test("rejects businessKeyValues with multiple competing spec keys", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			runtime: {
				businessKeys: ["auditDemo"],
				businessKeyValues: { auditDemo: { literal: "x", other: "y" } },
			},
		}
		expect(() => parsePreset(root, "/tmp")).toThrow(/auditDemo: value spec must declare exactly one of/)
	})

	test("accepts item.idField reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.id" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "item", field: "id" }, doc: null })
	})

	test("accepts known base item field reference in variables", () => {
		const root: BoundaryRecord = { ...minimalRoot(), phases: [{ name: "p", prompt: "p.md", variables: { X: "item.status" } }] }
		const preset = parsePreset(root, "/tmp")
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "X", source: { kind: "item", field: "status" }, doc: null })
	})

	test("accepts declared transparent item fields", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			item: { idField: "id", fields: { branch: "string", pr: { type: "number" } } },
			phases: [{ name: "p", prompt: "p.md", variables: { BRANCH: "item.branch", PR: "item.pr" } }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(Object.fromEntries(preset.item.fields)).toEqual({ branch: { type: "string" }, pr: { type: "number" } })
		expect(preset.phases[0]!.variables).toEqual([
			{ key: "BRANCH", source: { kind: "item", field: "branch" }, doc: null },
			{ key: "PR", source: { kind: "item", field: "pr" }, doc: null },
		])
	})

	test("accepts minimal valid preset and produces normalized shape", () => {
		const root: BoundaryRecord = {
			...minimalRoot(),
			phases: [{ name: "p", prompt: "p.md", variables: { K: "item.id" }, roles: ["x"] }],
			fragments: [{ id: "f", role: "x", path: "f.md" }],
		}
		const preset = parsePreset(root, "/tmp")
		expect(preset.name).toBe("x")
		expect(preset.item.idField).toBe("id")
		expect(Object.fromEntries(preset.item.fields)).toEqual({})
		expect(preset.phases[0]!.variables[0]).toEqual({ key: "K", source: { kind: "item", field: "id" }, doc: null })
		expect(preset.phases[0]!.roles).toEqual(["x"])
		expect(preset.fragments[0]!.path).toBe("/tmp/f.md")
		expect(preset.agent.attemptTimeoutSeconds).toBe(DEFAULT_ATTEMPT_TIMEOUT_SECONDS)
	})

	test("accepts agent attemptTimeoutSeconds override", () => {
		const root: BoundaryRecord = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 120 }
		const preset = parsePreset(root, "/tmp")
		expect(preset.agent.attemptTimeoutSeconds).toBe(120)
	})

	test("rejects non-positive agent attemptTimeoutSeconds", () => {
		const root: BoundaryRecord = minimalRoot()
		root.agent = { binary: "echo", attemptTimeoutSeconds: 0 }
		expect(() => parsePreset(root, "/tmp")).toThrow(/attemptTimeoutSeconds/)
	})
})

