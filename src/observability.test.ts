import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	appendObservabilityEvent,
	appendObservabilityEventSyncOrThrow,
	collectObservabilityExcerpt,
	discoverObservabilityEventSegments,
	makeObservabilityEvent,
	OBSERVABILITY_EVENT_SEGMENT_BYTES,
	ObservabilityEventBoundary,
	ObservabilityEventSegmentBoundary,
	ObservabilityEventTypeBoundary,
	ObservabilityKindBoundary,
	parseObservabilityEvent,
	parseObservabilityEventSegmentName,
	queryObservabilityEvents,
} from "./observability"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/observability-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("observability", () => {
	test("exports the canonical event schemas as runtime parsers", () => {
		const event = makeObservabilityEvent({ kind: "lifecycle", type: "daemon.stop", subject: { kind: "engine" }, payload: { pid: 10 } })
		expect(ObservabilityKindBoundary.assert(JSON.parse(JSON.stringify(event.kind)))).toBe("lifecycle")
		expect(ObservabilityEventTypeBoundary.assert(JSON.parse(JSON.stringify(event.type)))).toBe("daemon.stop")
		expect(ObservabilityEventBoundary.assert(JSON.parse(JSON.stringify(event)))).toEqual(event)
	})

	test("task event identity is an exact all-or-none triple", () => {
		const event = makeObservabilityEvent({ kind: "lifecycle", type: "daemon.stop", subject: { kind: "engine" }, payload: { pid: 10 } })
		expect(parseObservabilityEvent({ ...event, runtimeNodeId: "runtime-leaf", definitionRef: { kind: "chain", contentIdentity: "sha256:event" }, definitionNodeId: "definition-leaf" }).runtimeNodeId).toBe("runtime-leaf")
		for (const partial of [
			{ runtimeNodeId: "runtime-leaf" },
			{ definitionRef: { kind: "chain", contentIdentity: "sha256:event" } },
			{ definitionNodeId: "definition-leaf" },
			{ runtimeNodeId: "runtime-leaf", definitionNodeId: "definition-leaf" },
		]) expect(() => parseObservabilityEvent({ ...event, ...partial })).toThrow()

		const recovery = {
			kind: "lifecycle",
			type: "scheduler.recovery",
			chain: "recovery-chain",
			runId: "run-stale",
			subject: { kind: "engine" },
			payload: { reason: "stale_current_run", pid: null, reconciledRuns: [] },
			ts: "2026-07-16T00:00:00.000Z",
		}
		expect(() => parseObservabilityEvent(recovery)).toThrow()
		expect(() => parseObservabilityEvent({
			kind: "lifecycle",
			type: "scheduler.recovery",
			chain: "recovery-chain",
			subject: { kind: "engine" },
			ts: "2026-07-16T00:00:00.000Z",
			payload: {
				reason: "orphaned_run_reconciled",
				pid: null,
				reconciledRuns: [{ runId: "run-orphan", itemId: 1, phase: "iteration", pid: null }],
			},
		})).toThrow()
	})

	test("query filters by kind, type, chain, run, phase, and since", async () => {
		const root = resolve(TEST_ROOT, "query")
		const eventsFile = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })

		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "decision",
			type: "slot.busy",
			chain: "chain-a",
			runId: "run-1",
			subject: { kind: "engine" },
			payload: { slotKey: "slot-a", chainId: 1, repoCwd: "/repo/a", activeRunId: "run-1" },
		}, new Date("2026-06-12T00:00:00.000Z")))
		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "lifecycle",
			type: "phase.start",
			chain: "chain-a",
			item: 10,
			runId: "run-1",
			phase: "iteration",
			subject: { kind: "engine" },
			payload: { repoCwd: "/repo/a", pid: 123 },
		}, new Date("2026-06-12T00:01:00.000Z")))
		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "lifecycle",
			type: "phase.start",
			chain: "chain-b",
			item: 20,
			runId: "run-2",
			phase: "review",
			subject: { kind: "engine" },
			payload: { repoCwd: "/repo/b", pid: null },
		}, new Date("2026-06-12T00:02:00.000Z")))

		const result = await queryObservabilityEvents(eventsFile, {
			kind: "lifecycle",
			type: "phase.start",
			chain: "chain-a",
			run: "run-1",
			phase: "iteration",
			since: "2026-06-12T00:00:30.000Z",
		})

		expect(result.path).toBe(eventsFile)
		expect(result.events.map((event) => event.type)).toEqual(["phase.start"])
		expect(result.events[0]?.chain).toBe("chain-a")
		expect(result.events[0]?.runId).toBe("run-1")
	})

	test("query includes rotated event stream segments", async () => {
		const root = resolve(TEST_ROOT, "rotation")
		const eventsFile = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })

		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.start",
			subject: { kind: "engine" },
			payload: { pid: 10, socketPath: "/socket/a" },
		}, new Date("2026-06-11T23:59:00.000Z")))
		const previousDay = new Date("2026-06-11T23:59:30.000Z")
		await utimes(eventsFile, previousDay, previousDay)

		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.stop",
			subject: { kind: "engine" },
			payload: { pid: 10 },
		}, new Date("2026-06-12T00:00:00.000Z")))

		const entries = await readdir(root)
		expect(entries.filter((entry) => entry.startsWith("events-") && entry.endsWith(".jsonl"))).toHaveLength(1)
		const result = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
		expect(result.events.map((event) => event.type)).toEqual(["daemon.start", "daemon.stop"])
	})

	test("exported segment contract discovers a deterministic causal order", async () => {
		const root = resolve(TEST_ROOT, "segment-order")
		const eventsFile = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		const names = [
			"events-0000000000000002-2026-06-12T00-00-00.000Z-2026-06-12T00-01-00.000Z-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
			"events-0000000000000001-2026-06-12T00-00-00.000Z-2026-06-12T00-01-00.000Z-ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl",
			"events-0000000000000003-2026-06-12T00-00-00.000Z-2026-06-12T00-01-00.000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
		]
		for (const name of names) await writeFile(resolve(root, name), "")
		await writeFile(eventsFile, "")

		const segments = await discoverObservabilityEventSegments(eventsFile)
		expect(segments.map((segment) => segment.kind === "history" ? segment.sequence : "active")).toEqual([1, 2, 3, "active"])
		for (const segment of segments) ObservabilityEventSegmentBoundary.assert(segment)
		expect(() => parseObservabilityEventSegmentName(eventsFile,
			"events-0000000000000002-2026-06-12T00-00-00.000Z-2026-06-12T00-01-00.000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
		)).not.toThrow()
	})

	test("segment discovery deterministically orders valid equal-timestamp legacy segments", async () => {
		const root = resolve(TEST_ROOT, "segment-tie")
		const eventsFile = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		for (const id of ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) {
			await writeFile(resolve(root, `events-2026-06-12T00-00-00.000Z-2026-06-12T00-01-00.000Z-${id}.jsonl`), "")
		}
		const segments = await discoverObservabilityEventSegments(eventsFile)
		expect(segments.map((segment) => segment.kind === "legacy-history" ? segment.id : segment.kind)).toEqual([
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		])
	})

	test("async and sync writers produce contract-recognized names and preserve exact sequence across day and size rotations", async () => {
		for (const mode of ["day", "size"] as const) {
			const root = resolve(TEST_ROOT, `continuity-${mode}`)
			const eventsFile = resolve(root, "events.jsonl")
			await mkdir(root, { recursive: true })
			const first = makeObservabilityEvent({ kind: "lifecycle", type: "daemon.start", subject: { kind: "engine" }, payload: { pid: 10, socketPath: "/socket" } }, new Date("2026-06-11T23:59:00.000Z"))
			const second = makeObservabilityEvent({ kind: "lifecycle", type: "daemon.stop", subject: { kind: "engine" }, payload: { pid: 10 } }, new Date("2026-06-12T00:00:00.000Z"))
			await appendObservabilityEvent(eventsFile, first)
			let heldPosition = (await stat(eventsFile)).size
			if (mode === "day") {
				const previousDay = new Date("2026-06-11T23:59:30.000Z")
				await utimes(eventsFile, previousDay, previousDay)
				appendObservabilityEventSyncOrThrow(eventsFile, second)
			} else {
				await writeFile(eventsFile, `${JSON.stringify(first)}\n${" ".repeat(OBSERVABILITY_EVENT_SEGMENT_BYTES)}`)
				heldPosition = (await stat(eventsFile)).size
				await appendObservabilityEvent(eventsFile, second)
			}
			const segments = await discoverObservabilityEventSegments(eventsFile)
			expect(segments.map((segment) => segment.kind)).toEqual(["history", "active"])
			const history = segments[0]
			if (history?.kind !== "history") throw new Error("expected history segment")
			expect(parseObservabilityEventSegmentName(eventsFile, history.name)).toEqual(history)
			const rotatedBytes = await readFile(history.path)
			expect(rotatedBytes.byteLength).toBe(heldPosition)
			expect(rotatedBytes.subarray(heldPosition).byteLength).toBe(0)
			const result = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
			expect(result.events).toEqual([ObservabilityEventBoundary.assert(first), ObservabilityEventBoundary.assert(second)])
		}
	})

	test("excerpt collection carries only bounded tail records and marks truncation", async () => {
		const root = resolve(TEST_ROOT, "excerpt")
		const stdoutPath = resolve(root, "stdout.jsonl")
		const stderrPath = resolve(root, "stderr.txt")
		await mkdir(root, { recursive: true })
		await writeFile(stdoutPath, "one\ntwo\nthree\nfour\nfive\nlong-abcdef\n")
		await writeFile(stderrPath, "err-one\nerr-two\nerr-three\nerr-four\nerr-five\nerr-six\n")

		const excerpt = await collectObservabilityExcerpt({
			stdoutPath,
			stderrPath,
			recordLimit: 5,
			recordByteLimit: 8,
		})

		expect(excerpt.stdout).toEqual({
			path: stdoutPath,
			missing: false,
			truncated: true,
			records: ["two", "three", "four", "five", "long-abc"],
		})
		expect(excerpt.stderr).toEqual({
			path: stderrPath,
			missing: false,
			truncated: true,
			records: ["err-two", "err-thre", "err-four", "err-five", "err-six"],
		})

		const missingExcerpt = await collectObservabilityExcerpt({
			stdoutPath: resolve(root, "missing-stdout.jsonl"),
			stderrPath: resolve(root, "missing-stderr.txt"),
		})
		expect(missingExcerpt.stdout).toEqual({
			path: resolve(root, "missing-stdout.jsonl"),
			missing: true,
			truncated: false,
			records: [],
		})
		expect(missingExcerpt.stderr.missing).toBe(true)
	})
})
