import { describe, expect, test } from "bun:test"
import {
	ArgvEventBoundary, buildRunnerInvocation, chmod, createChain, createFixture, createItem, fixtureCaptureRoots,
	fixtureTaskLeaf, loadPreset, makeChainFixture, makeItemFixture, makeRunId, mkdir, readArgvEvents, readFile,
	renderSchedulerSpawnPrompt, REPO_ROOT, resolve, resolveChainRuntimePaths, resumeDecisionForItem,
	runnerAuthorizationForTest, runtimeStatus, schedulerTick, seedSessionClosure, stopFixture, writeFakeClaudeArgvEchoRunner,
	writeFakeClaudeInvalidOnceRunner, writeFakeClaudeNormalSessionRunner, writeFakeClaudeSessionRunner,
	writeFakeCodexSessionShellRunner, writeFile, type SchedulerOptions,
} from "./harness"

describe("scheduler", () => {
	test("rate-limit exit preserves the sessionId and the next spawn resumes from it", async () => {
		const fixture = await createFixture("rate-limit-resume")
		try {
			const chain = createChain(fixture.store, "rate-limit-resume-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 4782, repoCwd: "/repo/a" })
			const root = resolve(fixture.loopDataRoot, "..")
			const sessionId = "sess-rl-resume-test"
			const resetsAt = 1_900_000_500
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const argvDump = resolve(evidenceDir, "argv-dump.txt")
			// Single runner script with two branches:
			//   1st run (no --resume): emit session_id + W3 rate-limit lines + exit 1 →
			//      scheduler stores sessionId AND arms the cooldown gate.
			//   2nd run (--resume <sessionId> present): dump the full argv to disk + exit 0 →
			//      the test reads back the dump to assert the resume sessionId reached the runner.
			const runner = resolve(root, "rate-limit-resume-runner.sh")
			await writeFile(runner, [
				`#!/bin/sh`,
				`# always overwrite the argv dump so the last invocation wins`,
				`printf '%s\\n' "$*" > ${JSON.stringify(argvDump)}`,
				`case "$*" in`,
				`*--resume*)`,
				`    exit 0`,
				`    ;;`,
				`*)`,
				`    echo '{"type":"system","session_id":"${sessionId}"}'`,
				`    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt},"rateLimitType":"five_hour"}}'`,
				`    echo '{"type":"result","is_error":true,"api_error_status":429,"result":"hit your session limit"}'`,
				`    exit 1`,
				`    ;;`,
				`esac`,
				``,
			].join("\n"))
			await chmod(runner, 0o755)

			// Shared runIdFactory across both ticks — the fixture default constructs a
			// fresh attempt-counter Map per `fixture.options()` call, which would collide
			// on the second tick (UNIQUE runs.run_id) because rate-limit rolled attempts
			// back to the pre-spawn value. A shared per-test factory mimics production
			// runId monotonicity.
			let runSequence = 0
			const sharedRunIdFactory: SchedulerOptions["runIdFactory"] = ({ chain: c, item: it, phase }) => {
				runSequence += 1
				return `run-${c.id}-${it.id}-${phase}-${runSequence}`
			}

			const cooldownStart = 1_800_000_400
			const tick1 = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: runner, extraArgs: [], model: null },
				now: () => cooldownStart,
				runIdFactory: sharedRunIdFactory,
			}))
			expect(tick1.spawnedRuns).toHaveLength(1)
			await tick1.spawnedRuns[0]!.closed

			// sessionId stored: scheduler parsed it from stdout and wrote it via setItemSessionId.
			const itemAfterTick1 = fixture.store.getItem(item.id)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe(sessionId)
			// In-state cooldown gate armed; attempts unchanged (PR acceptance row 7).
			expect(fixture.state.rateLimitedUntilMs).toBe(resetsAt * 1000)
			expect(itemAfterTick1?.attempts).toBe(0)

			// Tick 2 with the now() clock advanced past the cooldown → scheduler resumes the
			// rate-limited item; runner argv must include `--resume <sessionId>`.
			const tick2 = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: runner, extraArgs: [], model: null },
				now: () => resetsAt + 5,
				runIdFactory: sharedRunIdFactory,
			}))
			expect(tick2.spawnedRuns).toHaveLength(1)
			await tick2.spawnedRuns[0]!.closed
			const argv = (await readFile(argvDump, "utf-8")).trim()
			expect(argv).toMatch(/--resume +sess-rl-resume-test\b/)
		} finally {
			await stopFixture(fixture)
		}
	})
})

describe("scheduler session-id resume (issue #291 / #311)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("first spawn (no session id for phase/runner): buildRunnerInvocation argv has no --resume; rendered prompt's RESUMED_SESSION_ID is empty (AC6)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const chain = makeChainFixture({ name: "first-spawn-chain" })
		const item = makeItemFixture(chain, { issueNumber: 291_001, repoCwd: "/repo/first-spawn-repo" })

		const decision = resumeDecisionForItem(item, "iteration", "claude")
		expect(decision).toEqual({ kind: "fresh" })

		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "iteration-default", binary: "claude", extraArgs: [], model: null },
			"prompt",
			decision,
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			expect(invocation.args).not.toContain("--resume")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-fresh",
			worktreePath: "/repo/fresh-worktree",
		})
		expect(rendered).toBe("RESUMED_SESSION_ID=[] RESUMED_FROM_PHASE=[] RUN_ID_GENERATION=[new]")
	})

	test("resume spawn (phase/runner session id set): buildRunnerInvocation argv contains --resume <id>; rendered prompt embeds the session id literal (AC4 / AC5)", async () => {
		const preset = await loadPreset(PRESET_DIR)
		const chain = makeChainFixture({ name: "resume-chain" })
		const item = makeItemFixture(chain, {
			issueNumber: 291_002,
			repoCwd: "/repo/resume-repo",
			sessionIds: { iteration: { claude: "sess-deadbeef-cafe" } },
			phase: "iteration",
		})

		const decision = resumeDecisionForItem(item, "iteration", "claude")
		expect(decision).toEqual({ kind: "resume", sessionId: "sess-deadbeef-cafe" })

		const invocation = buildRunnerInvocation(
			{ kind: "claude", source: "iteration-default", binary: "claude", extraArgs: [], model: null },
			"prompt",
			decision,
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			const idx = invocation.args.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(invocation.args[idx + 1]).toBe("sess-deadbeef-cafe")
		}

		const rendered = await renderSchedulerSpawnPrompt({
			rawPrompt: "RESUMED_SESSION_ID=[{{RESUMED_SESSION_ID}}] RESUMED_FROM_PHASE=[{{RESUMED_FROM_PHASE}}] RUN_ID_GENERATION=[{{RUN_ID_GENERATION}}]",
			preset,
			phase: "iteration",
			chain,
			item,
			runId: "run-resume",
			worktreePath: "/repo/resume-worktree",
			resume: decision,
		})
		expect(rendered).toBe("RESUMED_SESSION_ID=[sess-deadbeef-cafe] RESUMED_FROM_PHASE=[iteration] RUN_ID_GENERATION=[resumed]")
	})

	test("codex resume spawn (phase/runner session id set): buildRunnerInvocation argv shape includes `resume <sessionId>` subcommand", async () => {
		const item = makeItemFixture(makeChainFixture(), {
			issueNumber: 291_003,
			repoCwd: "/repo/codex-resume-repo",
			sessionIds: { iteration: { codex: "thread-codex-1" } },
		})
		const decision = resumeDecisionForItem(item, "iteration", "codex")
		const invocation = buildRunnerInvocation(
			{ kind: "codex", source: "iteration-default", binary: "codex", extraArgs: [], model: null },
			"prompt",
			decision,
			runnerAuthorizationForTest("/repo/worktree", PRESET_DIR, resolve(REPO_ROOT, ".coder-loop/runtime/evidence/scheduler-tests/render-only")),
		)
		expect(invocation.kind).toBe("spawn")
		if (invocation.kind === "spawn") {
			const resumeIdx = invocation.args.indexOf("resume")
			expect(resumeIdx).toBeGreaterThanOrEqual(0)
			expect(invocation.args[resumeIdx + 1]).toBe("thread-codex-1")
		}
	})

	test("resumeDecisionForItem selects only the current phase/runner session id (issue #311 AC3 / AC4)", () => {
		const item = makeItemFixture(makeChainFixture(), {
			issueNumber: 311_003,
			repoCwd: "/repo/phase-runner-resume",
			sessionIds: {
				iteration: { codex: "thread-iteration-codex" },
				review: { claude: "sess-review-claude" },
			},
		})

		expect(resumeDecisionForItem(item, "iteration", "codex")).toEqual({ kind: "resume", sessionId: "thread-iteration-codex" })
		expect(resumeDecisionForItem(item, "review", "claude")).toEqual({ kind: "resume", sessionId: "sess-review-claude" })
		expect(resumeDecisionForItem(item, "iteration", "claude")).toEqual({ kind: "fresh" })
		expect(resumeDecisionForItem(item, "review", "codex")).toEqual({ kind: "fresh" })
	})

	test("end-to-end (claude runner): session-id parsed from stdout first line is persisted to the phase/runner slot (AC3)", async () => {
		const fixture = await createFixture("session-id-capture-claude")
		try {
			const chain = createChain(fixture.store, "session-id-capture-claude-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_010, repoCwd: "/repo/session-id" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-session.ts")
			await writeFakeClaudeSessionRunner(fakeRunner, "sess-captured-001")

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			})
			// Single iteration spawn: the fake session runner writes no status, so drive exactly one
			// tick rather than run-until-idle (which would auto-advance to review and reuse the runId).
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-captured-001")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("end-to-end composition: seeded phase/runner session id reaches subprocess argv as --resume <id> (AC7 wire-level proxy)", async () => {
		const fixture = await createFixture("session-id-roundtrip-claude")
		try {
			const chain = createChain(fixture.store, "session-id-roundtrip-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_020, repoCwd: "/repo/session-roundtrip" })
			seedSessionClosure(fixture.store, chain, item, "iteration")
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-seeded-200" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-argv-echo.ts")
			await writeFakeClaudeArgvEchoRunner(fakeRunner)

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			})
			// Single iteration spawn (see note above): one tick captures the seeded session id on argv.
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			// #405: phase-aware runIdFactory — single iteration tick yields the iteration phase's
			// first attempt.
			const runId = `run-${chain.id}-${item.id}-iteration-1`
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const argvLine = stdout.split("\n").find((line) => line.startsWith("{") && line.includes("\"argv\""))
			expect(argvLine).toBeDefined()
			if (argvLine === undefined) throw new Error("argv event missing")
			const argv = ArgvEventBoundary.assert(JSON.parse(argvLine))
			const idx = argv.argv.indexOf("--resume")
			expect(idx).toBeGreaterThanOrEqual(0)
			expect(argv.argv[idx + 1]).toBe("sess-seeded-200")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("end-to-end (codex runner): codex thread.started event id is persisted to the phase/runner slot after exit", async () => {
		const fixture = await createFixture("session-id-capture-codex")
		try {
			const chain = createChain(fixture.store, "session-id-capture-codex-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 291_011, repoCwd: "/repo/session-id-codex" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-codex-session.sh")
			await writeFakeCodexSessionShellRunner(fakeRunner, "thread-captured-002")

			const options = fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: fakeRunner, extraArgs: [], model: null },
			})
			// Single iteration spawn (see note above): one tick captures the codex thread id after exit.
			const tick = await schedulerTick({ ...options, phase: "iteration" })
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-captured-002")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("end-to-end two-phase run stores iteration/codex and review/claude session ids separately (issue #311 AC2 / AC3)", async () => {
		const fixture = await createFixture("session-id-capture-phase-runner")
		try {
			const chain = createChain(fixture.store, "session-id-capture-phase-runner-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 311_010, repoCwd: "/repo/session-phase-runner" })
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-session.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-session.ts")
			await writeFakeCodexSessionShellRunner(fakeCodex, "thread-iteration-311")
			await writeFakeClaudeSessionRunner(fakeClaude, "sess-review-311")

			const sessionOptions = fixture.options({
				phaseRunner: ({ phase }) =>
					phase === "iteration"
						? { kind: "codex", source: "iteration-default", binary: fakeCodex, extraArgs: [], model: null }
						: { kind: "claude", source: "review-default", binary: "bun", extraArgs: [fakeClaude], model: null },
				runIdFactory: ({ chain, item, phase }) => `run-${chain.id}-${item.id}-${phase}`,
			})
			// The fake session runners write no status, so commit the fixture's durable
			// iteration → review transition between ticks. Tree readiness, not an explicit
			// flat phase override, selects the second phase.
			const iterTick = await schedulerTick(sessionOptions)
			const iterClosed = await iterTick.spawnedRuns[0]!.closed
			const iterationLeaf = fixtureTaskLeaf(fixture.store, chain.id, item.id, "iteration")
			const reviewLeaf = fixtureTaskLeaf(fixture.store, chain.id, item.id, "review")
			if (iterationLeaf === null || reviewLeaf === null) throw new Error("session fixture lost its two-phase task leaves")
			fixture.store.commitTaskTransition({
				sourceRunId: iterClosed.runId,
				sourceClosureId: iterationLeaf.closure.closureId,
				targetRuntimeNodeId: reviewLeaf.identity.runtimeNodeId,
				pathId: "session-fixture:iteration-complete",
				exitPayload: {},
				resolvedBindings: {},
				createdAt: 1_800_000_499,
				itemUpdate: { kind: "none" },
			})
			fixture.store.updateItem(item.id, { status: runtimeStatus("changes_requested"), updatedAt: 1_800_000_500 })
			const reviewTick = await schedulerTick(sessionOptions)
			await reviewTick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "codex" })).toBe("thread-iteration-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "claude" })).toBe("sess-review-311")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.store.getItemSessionId(item.id, { phase: "review", runner: "codex" })).toBeNull()
		} finally {
			await stopFixture(fixture)
		}
	})

	test("session-id-invalid stderr clears the phase/runner slot and the next spawn is fresh (issue #312 AC3)", async () => {
		const fixture = await createFixture("session-id-invalid-fresh")
		try {
			const chain = createChain(fixture.store, "session-id-invalid-fresh-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 312_003, repoCwd: "/repo/session-id-invalid" })
			seedSessionClosure(fixture.store, chain, item, "iteration")
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-stale-312" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-invalid-once.ts")
			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			await mkdir(chainPaths.evidenceDir, { recursive: true })
			const attemptFile = resolve(chainPaths.evidenceDir, "fake-claude-invalid-attempt.txt")
			await writeFakeClaudeInvalidOnceRunner(fakeRunner, "sess-fresh-312")
			let now = 1_800_312_000
			let runSequence = 0

			const options = fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner, attemptFile], model: null },
				runIdFactory: ({ chain, item }) => `run-${chain.id}-${item.id}-${++runSequence}`,
				now: () => now,
				spawnFailureBackoff: { initialSeconds: 1, maxSeconds: 2 },
			})

			const firstTick = await schedulerTick(options)
			expect(firstTick.spawnedRuns).toHaveLength(1)
			const firstClosed = await firstTick.spawnedRuns[0]!.closed
			expect(firstClosed.exitCode).toBe(1)
			expect(await readFile(resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runStderrFile(firstClosed.runId), "utf-8")).toContain("No conversation found with session ID: sess-stale-312")
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBeNull()
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({
				type: "session_id.invalidated",
				itemId: item.id,
				phase: "iteration",
				runner: "claude",
				previousSessionId: "sess-stale-312",
			}))

			// The agent exited non-zero without writing a status, so the spawn-set in_progress
			// remains; model the daemon recovery back to a continuable status so the next tick
			// re-selects a fresh iteration spawn rather than advancing to review.
			fixture.store.updateItem(item.id, { status: runtimeStatus("changes_requested"), phase: null, updatedAt: now })

			now += 2
			const secondTick = await schedulerTick(options)
			expect(secondTick.spawnedRuns).toHaveLength(1)
			const secondClosed = await secondTick.spawnedRuns[0]!.closed
			expect(secondClosed.exitCode).toBe(0)
			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-fresh-312")

			const argvEvents = await readArgvEvents(fixture.eventLogForChain(chain.name))
			expect(argvEvents).toHaveLength(2)
			expect(argvEvents[0]?.argv).toContain("--resume")
			expect(argvEvents[0]?.argv).toContain("sess-stale-312")
			expect(argvEvents[1]?.argv).not.toContain("--resume")
			expect(argvEvents[1]?.argv).not.toContain("sess-stale-312")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("normal non-invalid stderr updates the phase/runner session id instead of clearing it (issue #312 AC4)", async () => {
		const fixture = await createFixture("session-id-normal-update")
		try {
			const chain = createChain(fixture.store, "session-id-normal-update-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 312_004, repoCwd: "/repo/session-id-normal" })
			seedSessionClosure(fixture.store, chain, item, "iteration")
			fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: "claude", sessionId: "sess-old-312" })
			const fakeRunner = resolve(fixture.loopDataRoot, "..", "fake-claude-normal-session.ts")
			await writeFakeClaudeNormalSessionRunner(fakeRunner, "sess-new-312")

			const tick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
			}))
			await tick.spawnedRuns[0]!.closed

			expect(fixture.store.getItemSessionId(item.id, { phase: "iteration", runner: "claude" })).toBe("sess-new-312")
			expect(fixture.schedulerEvents.some((event) => event.type === "session_id.invalidated")).toBe(false)
		} finally {
			await stopFixture(fixture)
		}
	})

	describe("makeRunId phase segment (issue #294)", () => {
		test("phase is embedded in the runId so iter and review spawns never collide on the same item", () => {
			const iterRunId = makeRunId(42, "iteration")
			const reviewRunId = makeRunId(42, "review")
			expect(iterRunId).toContain("iteration")
			expect(reviewRunId).toContain("review")
			expect(iterRunId).not.toBe(reviewRunId)
			expect(iterRunId).toMatch(/-item-42$/)
			expect(reviewRunId).toMatch(/-item-42$/)
		})

		test("phase name with unsafe characters is sanitized into a path-safe segment", () => {
			const runId = makeRunId(9, "weird phase/name")
			expect(runId).toContain("weird-phase-name")
			expect(runId).toMatch(/^[A-Za-z0-9._-]+$/)
		})
	})
})
