import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

import {
	chainRuntimePaths,
	DEFAULT_LOOP_DATA_ROOT,
	ensureChainRuntimeSkeleton,
	loopDataRootPaths,
	LOOP_DATA_ROOT_ENV,
	resolveLoopDataRoot,
	runRuntimePaths,
	sanitizeChainName,
} from "./runtime-paths"
import { openStateDb } from "./state-db"

const REPO_ROOT = resolve(import.meta.dir, "..")
const RUNTIME_PATHS_TEST_ROOT = resolve(REPO_ROOT, ".cache/runtime-paths-tests")

describe("runtime-paths", () => {
	test("resolves default, env, and explicit loop-data roots", () => {
		expect(resolveLoopDataRoot(null, {})).toBe(DEFAULT_LOOP_DATA_ROOT)
		expect(resolveLoopDataRoot(null, { [LOOP_DATA_ROOT_ENV]: "~/Ext/custom-loop-data" })).toBe(resolve(homedir(), "Ext/custom-loop-data"))
		expect(resolveLoopDataRoot(".cache/local-loop-data", {})).toBe(resolve(".cache/local-loop-data"))
		expect(loopDataRootPaths(".cache/local-loop-data", {}).stateDbPath).toBe(resolve(".cache/local-loop-data/state.db"))
	})

	test("sanitizes chain names without allowing traversal or control characters", () => {
		expect(sanitizeChainName("release/train")).toBe("release-train")
		expect(sanitizeChainName(" coder loop ")).toBe("coder-loop")
		expect(() => sanitizeChainName("")).toThrow(/must not be empty/)
		expect(() => sanitizeChainName("..")).toThrow(/path segments/)
		expect(() => sanitizeChainName("parent/../child")).toThrow(/path segments/)
		expect(() => sanitizeChainName("/absolute")).toThrow(/absolute path/)
		expect(() => sanitizeChainName("bad\u0000name")).toThrow(/control characters/)
	})

	test("builds per-chain path model and skeleton without top-level logs or events", async () => {
		const root = resolve(RUNTIME_PATHS_TEST_ROOT, `skeleton-${Date.now()}-${Math.random().toString(16).slice(2)}`)
		const paths = chainRuntimePaths(root, "release/train")
		try {
			openStateDb(loopDataRootPaths(root).stateDbPath).close()
			await ensureChainRuntimeSkeleton(paths)
			await ensureChainRuntimeSkeleton(paths)

			expect(paths.chainSlug).toBe("release-train")
			expect(paths.sharedPath).toBe(resolve(root, "chains/release-train/shared.md"))
			expect(paths.runDir("run:1")).toBe(resolve(root, "chains/release-train/runs/run-1"))
			expect(paths.daemonRunDir("2026-05-20T21:37:28Z")).toBe(resolve(root, "chains/release-train/daemon/2026-05-20T21-37-28Z"))
			const runPaths = runRuntimePaths(paths.runsDir, "run:1")
			expect(runPaths.eventsPath).toBe(resolve(root, "chains/release-train/runs/run-1/events.jsonl"))
			expect(runPaths.phasePaths("iteration")).toEqual({
				phaseDir: resolve(root, "chains/release-train/runs/run-1/iteration"),
				latestPath: resolve(root, "chains/release-train/runs/run-1/iteration/latest.md"),
				stdoutPath: resolve(root, "chains/release-train/runs/run-1/iteration/stdout.jsonl"),
				stderrPath: resolve(root, "chains/release-train/runs/run-1/iteration/stderr.txt"),
				statusPath: resolve(root, "chains/release-train/runs/run-1/iteration/status.json"),
				sessionsPath: resolve(root, "chains/release-train/runs/run-1/iteration/sessions.jsonl"),
			})
			expect(existsSync(paths.sharedPath)).toBe(true)
			expect(await readFile(paths.sharedPath, "utf-8")).toBe("# Shared durable context\n")
			expect(existsSync(paths.issuesDir)).toBe(true)
			expect(existsSync(paths.evidenceDir)).toBe(true)
			expect(existsSync(paths.runsDir)).toBe(true)
			expect(existsSync(paths.daemonDir)).toBe(true)

			const rootEntries = await readdir(root)
			expect(rootEntries).toContain("state.db")
			expect(rootEntries).toContain("chains")
			expect(rootEntries).not.toContain("logs")
			expect(rootEntries).not.toContain("events")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
