import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, open, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"

import {
	OBSERVABILITY_EVENT_SEGMENT_BYTES,
	ObservabilityEventBoundary,
	appendObservabilityEvent,
	collectObservabilityExcerpt,
	discoverObservabilityEventSegments,
	makeHistoricalObservabilityEventSegment,
	makeObservabilityEvent,
	queryObservabilityEvents,
} from "./observability"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/observability-tests", String(process.pid))

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("observability", () => {
	test("exported event boundary parses the same exhaustive event union used by writers", () => {
		const event = makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.start",
			subject: { kind: "engine" },
			payload: { pid: 10, socketPath: "/socket/a" },
		}, new Date("2026-06-12T00:00:00.000Z"))

		expect(ObservabilityEventBoundary.assert(event)).toEqual(event)
	})

	test("segment contract discovers shuffled same-day history in causal order before active", () => {
		const eventsFile = resolve(TEST_ROOT, "contract", "events.jsonl")
		const collision = {
			from: new Date("2026-06-12T00:00:00.000Z"),
			to: "2026-06-12T00:00:00.000Z",
		}
		const first = makeHistoricalObservabilityEventSegment(eventsFile, 0n, collision)
		const second = makeHistoricalObservabilityEventSegment(eventsFile, 1n, collision)
		const third = makeHistoricalObservabilityEventSegment(eventsFile, 2n, {
			from: new Date("2026-06-12T23:59:59.999Z"),
			to: "2026-06-12T23:59:59.999Z",
		})
		const segments = discoverObservabilityEventSegments(eventsFile, [
			basename(third.path),
			basename(eventsFile),
			basename(first.path),
			"unrelated.jsonl",
			basename(second.path),
		])

		expect(segments).toEqual([first, second, third, { kind: "active", path: eventsFile }])
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

	test("day rotation uses the exported segment contract without loss or duplication", async () => {
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
		const beforeRotation = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
		expect(beforeRotation.events.map((event) => event.type)).toEqual(["daemon.start"])

		await appendObservabilityEvent(eventsFile, makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.stop",
			subject: { kind: "engine" },
			payload: { pid: 10 },
		}, new Date("2026-06-12T00:00:00.000Z")))

		const entries = await readdir(root)
		expect(entries.filter((entry) => entry.startsWith("events-") && entry.endsWith(".jsonl"))).toHaveLength(1)
		const segments = discoverObservabilityEventSegments(eventsFile, entries)
		expect(segments.map((segment) => segment.kind)).toEqual(["history", "active"])
		const result = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
		expect(result.events.map((event) => event.type)).toEqual(["daemon.start", "daemon.stop"])
	})

	test("32MB rotation uses the exported segment contract without loss or duplication", async () => {
		const root = resolve(TEST_ROOT, "size-rotation")
		const eventsFile = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		const first = makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.start",
			subject: { kind: "engine" },
			payload: { pid: 10, socketPath: "/socket/a" },
		}, new Date("2026-06-12T00:00:00.000Z"))
		const firstLine = `${JSON.stringify(first)}\n`
		await writeFile(eventsFile, firstLine)
		const paddingChunk = Buffer.alloc(1024 * 1024, 0x20)
		let paddingBytes = OBSERVABILITY_EVENT_SEGMENT_BYTES - Buffer.byteLength(firstLine)
		const active = await open(eventsFile, "a")
		try {
			while (paddingBytes > 0) {
				const chunk = paddingChunk.subarray(0, Math.min(paddingChunk.byteLength, paddingBytes))
				await active.write(chunk)
				paddingBytes -= chunk.byteLength
			}
		} finally {
			await active.close()
		}
		const beforeRotation = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
		expect(beforeRotation.events).toEqual([first])
		const second = makeObservabilityEvent({
			kind: "lifecycle",
			type: "daemon.stop",
			subject: { kind: "engine" },
			payload: { pid: 10 },
		}, new Date("2026-06-12T00:01:00.000Z"))

		await appendObservabilityEvent(eventsFile, second)

		const entries = await readdir(root)
		const segments = discoverObservabilityEventSegments(eventsFile, entries)
		expect(segments.map((segment) => segment.kind)).toEqual(["history", "active"])
		const result = await queryObservabilityEvents(eventsFile, { kind: "lifecycle" })
		expect(result.events).toEqual([first, second])
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
