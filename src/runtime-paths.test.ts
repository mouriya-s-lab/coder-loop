import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
	LOOP_DATA_ROOT_ENV,
	RuntimePathError,
	defaultLoopDataRoot,
	resolveChainRuntimePaths,
	resolveLoopDataPaths,
	resolveLoopDataRoot,
	sanitizeChainName,
} from "./runtime-paths"

const REPO_ROOT = resolve(import.meta.dir, "..")

describe("runtime path model", () => {
	test("loop-data root default resolves under user-level coder-loop data", () => {
		expect(defaultLoopDataRoot("/home/tester")).toBe("/home/tester/.coder-loop/loop-data")
		expect(resolveLoopDataRoot({ homeDir: "/home/tester", env: {} })).toBe("/home/tester/.coder-loop/loop-data")
		expect(resolveLoopDataPaths({ homeDir: "/home/tester", env: {} })).toEqual({
			root: "/home/tester/.coder-loop/loop-data",
			dbFile: "/home/tester/.coder-loop/loop-data/db.sqlite",
			daemonSocket: "/home/tester/.coder-loop/loop-data/daemon.sock",
			daemonPid: "/home/tester/.coder-loop/loop-data/daemon.pid",
			chainsDir: "/home/tester/.coder-loop/loop-data/chains",
		})
	})

	test("loop-data root env override takes precedence over default", () => {
		const root = "/var/lib/coder-loop-data"
		expect(resolveLoopDataRoot({ homeDir: "/home/tester", env: { [LOOP_DATA_ROOT_ENV]: root } })).toBe(root)
		expect(resolveLoopDataPaths({ env: { [LOOP_DATA_ROOT_ENV]: root } }).dbFile).toBe("/var/lib/coder-loop-data/db.sqlite")
	})

	test("loop-data root env override rejects empty or relative paths instead of falling back", () => {
		expect(() => resolveLoopDataRoot({ env: { [LOOP_DATA_ROOT_ENV]: "" } })).toThrow(RuntimePathError)
		expect(() => resolveLoopDataRoot({ env: { [LOOP_DATA_ROOT_ENV]: "relative/loop-data" } })).toThrow(RuntimePathError)
	})

	test("per-chain paths include shared, issues, evidence, runs, and daemon layout", () => {
		const paths = resolveChainRuntimePaths("coder-loop", { loopDataRoot: "/var/lib/coder-loop/loop-data" })

		expect(paths.chainName).toBe("coder-loop")
		expect(paths.chainRoot).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop")
		expect(paths.sharedFile).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/shared.md")
		expect(paths.issuesDir).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/issues")
		expect(paths.issueFile(178)).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/issues/178.md")
		expect(paths.evidenceDir).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/evidence")
		expect(paths.issueEvidenceDir(178)).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/evidence/178")
		expect(paths.runsDir).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs")
		expect(paths.runDir("run-2026-05-22")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22")
		expect(paths.runEventsFile("run-2026-05-22")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/events.jsonl")
		expect(paths.runPhaseDir("run-2026-05-22", "iteration")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/iteration")
		expect(paths.runPhaseStdoutFile("run-2026-05-22", "iteration")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/iteration/stdout.jsonl")
		expect(paths.runPhaseStderrFile("run-2026-05-22", "iteration")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/iteration/stderr.txt")
		expect(paths.runPhaseStatusFile("run-2026-05-22", "iteration")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/iteration/status.json")
		expect(paths.runPhaseSessionsFile("run-2026-05-22", "iteration")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/runs/run-2026-05-22/iteration/sessions.jsonl")
		expect(paths.daemonDir).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/daemon")
		expect(paths.daemonBatchDir("2026-05-22-16-28-22")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/daemon/2026-05-22-16-28-22")
		expect(paths.daemonLogFile("2026-05-22-16-28-22")).toBe("/var/lib/coder-loop/loop-data/chains/coder-loop/daemon/2026-05-22-16-28-22/engine.log")
	})

	test("sanitization rejects empty traversal absolute control and separator input", () => {
		for (const invalid of ["", "   ", ".", "../escape", "foo..bar", "/absolute", "has/slash", "has\\slash", "control\u0000"]) {
			try {
				sanitizeChainName(invalid)
				throw new Error(`expected invalid chain name to throw: ${invalid}`)
			} catch (error) {
				expect(error).toBeInstanceOf(RuntimePathError)
				expect((error as RuntimePathError).code).toBe("invalid_chain_name")
			}
		}
	})

	test("sanitization accepts letters digits hyphen underscore and dot", () => {
		for (const valid of ["coder-loop", "coder_loop", "CoderLoop123", "release.2026-05-22", "a.b_c-d"]) {
			expect(sanitizeChainName(valid)).toBe(valid)
		}
	})

	test("pure path module no side effect", async () => {
		const root = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/issue-178/no-side-effect-root-" + Date.now())
		const paths = resolveChainRuntimePaths("coder-loop", { loopDataRoot: root })

		expect(paths.issueFile(178)).toBe(resolve(root, "chains/coder-loop/issues/178.md"))
		expect(await Bun.file(root).exists()).toBe(false)
		expect(await Bun.file(paths.chainRoot).exists()).toBe(false)
		expect(await Bun.file(paths.issueFile(178)).exists()).toBe(false)
	})
})
