import { describe, expect, test } from "bun:test"
import {
	buildRunnerInvocation, chmod, createChain, createFixture, createItem, fixtureCaptureRoots, fixturePresetDirs,
	loadPreset, makeChainFixture, mkdir, optionsWithoutRunner, readFile, REPO_ROOT, resolve,
	resolveChainRuntimePaths, resolvePhaseRunnerFromChain, runPresetChainCompleteTriggerPhases,
	runnerAuthorizationForTest, runtimeStatus, schedulerTick, seedSessionClosure, stopFixture, storedChainMetadata,
	writeBunMarkerRunner, writeFile, writeShellFinalizerMarkerScript, writeShellMarkerScript,
	type AgentRunnerSelection, type SchedulerPhaseRunner,
} from "./harness"

describe("scheduler", () => {
	test("runner projections reach scheduler fresh and resume paths for every runner", async () => {
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [false, true]) {
				const fixture = await createFixture(`runner-projection-${kind}-${resume ? "resume" : "fresh"}`)
				try {
					const chain = createChain(fixture.store, `runner-projection-${kind}-${resume ? "resume" : "fresh"}-chain`)
					const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
					await mkdir(chainPaths.evidenceDir, { recursive: true })
					const captureArgv = resolve(chainPaths.evidenceDir, `${kind}-${resume ? "resume" : "fresh"}.argv.json`)
					const item = createItem(fixture.store, chain, { issueNumber: 601_000 + (resume ? 1 : 0), repoCwd: "/repo/a", runner: kind, captureArgv, probeNullDevice: true })
					if (resume) {
						seedSessionClosure(fixture.store, chain, item, "iteration")
						fixture.store.setItemSessionId(item.id, { phase: "iteration", runner: kind, sessionId: `scheduler-resume-${kind}` })
					}
					const tick = await schedulerTick(fixture.options({
						runner: { kind, source: "queue", binary: fixture.fakeRunner, extraArgs: [], model: null },
					}))
					expect(tick.spawnedRuns).toHaveLength(1)
					expect((await tick.spawnedRuns[0]!.closed).exitCode).toBe(0)
					const argv = await readFile(captureArgv, "utf8")
					expect(argv).toContain(resume ? `scheduler-resume-${kind}` : "601000")
					const projected: unknown = JSON.parse(argv)
					if (!Array.isArray(projected) || !projected.every((value) => typeof value === "string")) throw new Error("captured scheduler argv must be a string array")
					const fixturePresetDir = fixturePresetDirs.get(fixture.store)
					if (fixturePresetDir === undefined) throw new Error("scheduler fixture must retain its preset directory")
					expect(projected).not.toContain(fixture.loopDataRoot)
					expect(projected).not.toContain("/dev/null")
					const authorizationEvidencePath = resolve(chainPaths.runPhaseDir(tick.spawnedRuns[0]!.runId, "iteration"), "runner-authorization.json")
					const authorizationEvidence = await readFile(authorizationEvidencePath, "utf8")
					expect(authorizationEvidence).toContain('"outerSandboxProfile"')
					expect(authorizationEvidence).toContain(`"runner":"${kind}"`)
					expect(authorizationEvidence).toContain(`(require-not (subpath \\"${fixture.loopDataRoot}\\"))`)
					expect(authorizationEvidence).not.toContain(`"path":"${fixture.loopDataRoot}"`)
					if (kind === "claude") {
						expect(projected).toContain(fixturePresetDir)
						expect(projected).toContain(chainPaths.evidenceDir)
					}
					if (kind === "codex" && !resume) {
						expect(projected).toContain(chainPaths.evidenceDir)
						expect(projected).toContain(chainPaths.issuesDir)
						expect(projected).toContain(chainPaths.runsDir)
						expect(projected).not.toContain(fixturePresetDir)
					}
				} finally {
					await stopFixture(fixture)
				}
			}
		}
	})

	test("codex spawns inherit a default RUST_LOG while claude spawns do not", async () => {
		const fixture = await createFixture("rust-log-injection")
		const savedRustLog = process.env["RUST_LOG"]
		const savedOverride = process.env["CODER_LOOP_CODEX_RUST_LOG"]
		delete process.env["RUST_LOG"]
		delete process.env["CODER_LOOP_CODEX_RUST_LOG"]
		try {
			const chain = createChain(fixture.store, "rust-log-injection-chain")
			const codexItem = createItem(fixture.store, chain, { issueNumber: 4631, repoCwd: "/repo/a", writeStatus: "done" })
			const root = resolve(fixture.loopDataRoot, "..")
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const codexDump = resolve(evidenceDir, "codex-env.txt")
			const claudeDump = resolve(evidenceDir, "claude-env.txt")
			const makeEnvDumpRunner = async (path: string, dump: string): Promise<void> => {
				await writeFile(path, `#!/bin/sh\necho "rust_log=\${RUST_LOG-unset}" > ${dump}\nexit 0\n`)
				await chmod(path, 0o755)
			}
			const codexRunner = resolve(root, "codex-env-runner.sh")
			await makeEnvDumpRunner(codexRunner, codexDump)

			const codexTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: codexRunner, extraArgs: [], model: null },
			}))
			expect(codexTick.spawnedRuns).toHaveLength(1)
			await codexTick.spawnedRuns[0]!.closed
			expect((await readFile(codexDump, "utf-8")).trim()).toBe("rust_log=info")

			// Same chain, second item through a claude-kind runner: no injection.
			fixture.store.updateItem(codexItem.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_900 })
			createItem(fixture.store, chain, { issueNumber: 4632, repoCwd: "/repo/b", writeStatus: "done" })
			const claudeRunner = resolve(root, "claude-env-runner.sh")
			await makeEnvDumpRunner(claudeRunner, claudeDump)
			const claudeTick = await schedulerTick(fixture.options({
				runner: { kind: "claude", source: "iteration-default", binary: claudeRunner, extraArgs: [], model: null },
			}))
			expect(claudeTick.spawnedRuns).toHaveLength(1)
			await claudeTick.spawnedRuns[0]!.closed
			expect((await readFile(claudeDump, "utf-8")).trim()).toBe("rust_log=unset")
		} finally {
			if (savedRustLog !== undefined) process.env["RUST_LOG"] = savedRustLog
			if (savedOverride !== undefined) process.env["CODER_LOOP_CODEX_RUST_LOG"] = savedOverride
			await stopFixture(fixture)
		}
	})

	// #463: operator-supplied overrides take precedence over the engine default. An
	// explicit `CODER_LOOP_CODEX_RUST_LOG=trace` is forwarded verbatim; an explicit
	// empty value disables the injection entirely (codex stderr stays bare). The
	// engine documents the precedence in one place: the code comment above the env
	// construction in `spawnSchedulerRun`.
	test("CODER_LOOP_CODEX_RUST_LOG override controls or disables the codex RUST_LOG injection", async () => {
		const fixture = await createFixture("rust-log-override")
		const savedRustLog = process.env["RUST_LOG"]
		const savedOverride = process.env["CODER_LOOP_CODEX_RUST_LOG"]
		delete process.env["RUST_LOG"]
		try {
			const chain = createChain(fixture.store, "rust-log-override-chain")
			const firstItem = createItem(fixture.store, chain, { issueNumber: 4633, repoCwd: "/repo/a", writeStatus: "done" })
			const root = resolve(fixture.loopDataRoot, "..")
			const evidenceDir = fixtureCaptureRoots.get(fixture.store)
			if (evidenceDir === undefined) throw new Error("scheduler fixture lost its declared evidence directory")
			const traceDump = resolve(evidenceDir, "trace-env.txt")
			const disabledDump = resolve(evidenceDir, "disabled-env.txt")
			const makeEnvDumpRunner = async (path: string, dump: string): Promise<void> => {
				await writeFile(path, `#!/bin/sh\necho "rust_log=\${RUST_LOG-unset}" > ${dump}\nexit 0\n`)
				await chmod(path, 0o755)
			}
			const traceRunner = resolve(root, "trace-runner.sh")
			await makeEnvDumpRunner(traceRunner, traceDump)

			process.env["CODER_LOOP_CODEX_RUST_LOG"] = "trace"
			const traceTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: traceRunner, extraArgs: [], model: null },
			}))
			await traceTick.spawnedRuns[0]!.closed
			expect((await readFile(traceDump, "utf-8")).trim()).toBe("rust_log=trace")

			fixture.store.updateItem(firstItem.id, { status: runtimeStatus("done"), updatedAt: 1_800_000_910 })
			createItem(fixture.store, chain, { issueNumber: 4634, repoCwd: "/repo/b", writeStatus: "done" })
			const disabledRunner = resolve(root, "disabled-runner.sh")
			await makeEnvDumpRunner(disabledRunner, disabledDump)

			process.env["CODER_LOOP_CODEX_RUST_LOG"] = ""
			const disabledTick = await schedulerTick(fixture.options({
				runner: { kind: "codex", source: "iteration-default", binary: disabledRunner, extraArgs: [], model: null },
			}))
			await disabledTick.spawnedRuns[0]!.closed
			expect((await readFile(disabledDump, "utf-8")).trim()).toBe("rust_log=unset")
		} finally {
			if (savedRustLog !== undefined) process.env["RUST_LOG"] = savedRustLog
			else delete process.env["RUST_LOG"]
			if (savedOverride !== undefined) process.env["CODER_LOOP_CODEX_RUST_LOG"] = savedOverride
			else delete process.env["CODER_LOOP_CODEX_RUST_LOG"]
			await stopFixture(fixture)
		}
	})

	// #478 acceptance row 6 + I4 review: a rate-limit exit must NOT lose the conversation —
	// the next spawn for the same item must invoke the runner with `--resume <sessionId>`
	// continuing from the sessionId the rate-limited run published. Pre-#478 the run
	// classified as `unclassified` → decideResume returned `fresh`, throwing away the
	// stored sessionId. The PR's rate-limit-exit branch goes through `clearItemSchedulerBackoff`
	// instead of `extraAfterRunCompletion`, which (today) preserves sessionIds; this test
	// pins the invariant so a future refactor cannot silently regress it.
})
describe("scheduler per-phase runner selection (issue #287)", () => {
	test("spawnSchedulerRun routes phase=iteration through phaseRunner and uses returned binary for spawn (AC2 iter)", async () => {
		const fixture = await createFixture("phase-runner-iter")
		try {
			const chain = createChain(fixture.store, "phase-runner-iter-chain")
			createItem(fixture.store, chain, { issueNumber: 287_101, repoCwd: "/repo/a" })

			const fakeIter = resolve(fixture.loopDataRoot, "..", "fake-iter-marker.ts")
			await writeBunMarkerRunner(fakeIter, "PER-PHASE:codex")

			const observedPhases: string[] = []
			const phaseRunner: SchedulerPhaseRunner = ({ phase }) => {
				observedPhases.push(phase)
				return {
					kind: "claude",
					// #433: "config" source value is retired (no target-side preferences file
					// left). Iteration phases now stamp the "iteration-default" source label.
					source: "iteration-default",
					binary: "bun",
					extraArgs: [fakeIter],
					model: null,
				}
			}

			const baseOptions = optionsWithoutRunner(fixture.options())
			const tick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "iteration",
			})
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(observedPhases).toEqual(["iteration"])
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("PER-PHASE:codex")
			expect(capturedStdout).not.toContain("PER-PHASE:claude")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("spawnSchedulerRun routes phase=review through phaseRunner and uses returned binary for spawn (AC2 review)", async () => {
		const fixture = await createFixture("phase-runner-review")
		try {
			const chain = createChain(fixture.store, "phase-runner-review-chain")
			createItem(fixture.store, chain, { issueNumber: 287_102, repoCwd: "/repo/a" })

			const fakeIter = resolve(fixture.loopDataRoot, "..", "fake-codex-review.ts")
			const fakeReview = resolve(fixture.loopDataRoot, "..", "fake-claude-review.ts")
			await writeBunMarkerRunner(fakeIter, "PER-PHASE:codex")
			await writeBunMarkerRunner(fakeReview, "PER-PHASE:claude")

			const observedPhases: string[] = []
			const phaseRunner: SchedulerPhaseRunner = ({ phase }) => {
				observedPhases.push(phase)
				if (phase === "review") {
					return {
						kind: "claude",
						source: "review-default",
						binary: "bun",
						extraArgs: [fakeReview],
						model: "claude-opus-4-7",
					}
				}
				return {
					kind: "claude",
					// #433: same retirement as above — non-review fallback path is "iteration-default".
					source: "iteration-default",
					binary: "bun",
					extraArgs: [fakeIter],
					model: null,
				}
			}

			const baseOptions = optionsWithoutRunner(fixture.options())
			const tick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "review",
			})
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(observedPhases).toEqual(["review"])
			const paths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const capturedStdout = await readFile(paths.runStdoutFile(closed.runId), "utf-8")
			expect(capturedStdout).toContain("PER-PHASE:claude")
			expect(capturedStdout).not.toContain("PER-PHASE:codex")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("falls back to options.runner when phaseRunner is not configured (backward compat)", async () => {
		const fixture = await createFixture("phase-runner-fallback")
		try {
			const chain = createChain(fixture.store, "phase-runner-fallback-chain")
			createItem(fixture.store, chain, { issueNumber: 287_103, repoCwd: "/repo/a", writeStatus: "done" })

			const tick = await schedulerTick(fixture.options())
			const closed = await tick.spawnedRuns[0]!.closed

			expect(closed.exitCode).toBe(0)
			expect(fixture.store.getItem(fixture.store.listItems(chain.id)[0]!.id)?.status).toBe("done")
		} finally {
			await stopFixture(fixture)
		}
	})

	test("contains missing runner failure with diagnostic, backoff, and spawn.aborted", async () => {
		const fixture = await createFixture("phase-runner-missing")
		try {
			const chain = createChain(fixture.store, "phase-runner-missing-chain")
			createItem(fixture.store, chain, { issueNumber: 287_104, repoCwd: "/repo/a" })

			const baseOptions = optionsWithoutRunner(fixture.options())

			const tick = await schedulerTick(baseOptions)
			expect(tick.spawnedRuns).toHaveLength(0)
			expect(fixture.store.getCurrentRun(chain.id)).toBeNull()
			const failedItem = fixture.store.listItems(chain.id)[0]
			expect(failedItem?.extra.schedulerSpawnError).toMatchObject({
				attribution: { kind: "phase", phase: "iteration" },
				message: expect.stringContaining("no runner configured"),
			})
			expect(failedItem?.extra.schedulerBackoff).toMatchObject({ failureCount: 1 })
			expect(fixture.schedulerEvents.filter((event) => event.type === "spawn.aborted")).toHaveLength(1)
		} finally {
			await stopFixture(fixture)
		}
	})

	describe("resolvePhaseRunnerFromChain", () => {
		const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

		test("chain default → iteration phase returns codex with binary 'codex'", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "iteration",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.binary).toBe("codex")
			expect(runner.source).toBe("preset")
		})

		test("chain default → review phase returns codex with the preset-declared model", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.binary).toBe("codex")
			expect(runner.model).toBe("gpt-5.6-sol")
			expect(runner.source).toBe("preset")
		})

		// #433: the legacy `metadata.reviewRunner` top-level field is retired. Parsing chain
		// metadata that carries it must now fail loudly (no silent-ignore fallback), so the
		// preset's declared review runner remains the single source of truth for that phase.

		test("chain metadata codex.model overrides the preset-declared review model", async () => {
			const chain = makeChainFixture({
				metadata: storedChainMetadata({
					codex: { model: "gpt-5.6-terra" },
				}),
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.model).toBe("gpt-5.6-terra")
		})

		test("item.runner='claude' overrides codex iteration default for non-review phase", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "iteration",
				item: { runner: "claude" },
			})
			expect(runner.kind).toBe("claude")
			expect(runner.source).toBe("queue")
		})

		test("chain default → triggered/finalizer phase resolves to its preset codex runner", async () => {
			const chain = makeChainFixture({ metadata: storedChainMetadata({}) })
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "umbrella-finalizer",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.source).toBe("preset")
		})

		test("preset-declared review model flows into review args via buildRunnerInvocation", async () => {
			const chain = makeChainFixture({
				metadata: storedChainMetadata({
					codex: {
						extraArgs: ["--model", "gpt-stale"],
					},
				}),
			})
			const preset = await loadPreset(PRESET_DIR)
			const runner = resolvePhaseRunnerFromChain({
				chain,
				loopDataRoot: null,
				preset,
				phase: "review",
				item: { runner: null },
			})
			expect(runner.kind).toBe("codex")
			expect(runner.model).toBe("gpt-5.6-sol")
			const invocation = buildRunnerInvocation(runner, "p", { kind: "fresh" }, runnerAuthorizationForTest("/repo/a", PRESET_DIR, "/lr"))
			const modelFlagIndex = invocation.args.indexOf("--model")
			expect(modelFlagIndex).toBeGreaterThanOrEqual(0)
			expect(invocation.args[modelFlagIndex + 1]).toBe("gpt-5.6-sol")
			expect(invocation.args.filter((arg) => arg === "claude-stale")).toEqual([])
		})
	})

	// #456: item.runner override now applies uniformly to every non-trigger phase. The bundled
	// preset's `review` phase has `trigger === null`, so an item-level `runner: "claude"` flows
	// through both `iteration` and `review` — there is no engine-side carve-out keeping `review`
	// on its preset default once the item declares an override. The previous assertion that review
	// stayed on `BINARY:codex` encoded the retired role-name carve-out (`selectReviewRunner` /
	// `lastNonTriggerPhaseForPreset`); after #456's policy unification, every non-trigger phase
	// honors the same override. Phase-name-based gating, when a preset wants it, belongs to preset
	// declaration (e.g., setting `[[phases]].runner` on `review` makes the preset default explicit
	// — but item override still wins because `trigger === null`).
	test("AC5 integration: chain-based phaseRunner honors item claude override on every non-trigger phase (iteration + review), regardless of phase name", async () => {
		const fixture = await createFixture("ac5-integration")
		try {
			const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-marker.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-marker.sh")
			await writeShellMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellMarkerScript(fakeClaude, "BINARY:claude")

			const chain = createChain(fixture.store, "ac5-integration-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			createItem(fixture.store, chain, { issueNumber: 287_201, repoCwd: "/repo/a", runner: "claude" })

			const preset = await loadPreset(PRESET_DIR)
			const phaseRunner: SchedulerPhaseRunner = ({ chain: c, phase, item }) =>
				resolvePhaseRunnerFromChain({
					chain: c,
					loopDataRoot: fixture.loopDataRoot,
					preset,
					phase,
					item,
				})

			let runSeq = 0
			const baseOptions = optionsWithoutRunner(fixture.options({
				loadedPreset: { presetDir: PRESET_DIR, preset },
				runIdFactory: ({ chain: c, item, phase }) => `run-${c.id}-${item.id}-${phase}-${++runSeq}`,
			}))

			const iterTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "iteration",
				prompt: "iter-prompt",
			})
			expect(iterTick.spawnedRuns).toHaveLength(1)
			const iterClosed = await iterTick.spawnedRuns[0]!.closed
			expect(iterClosed.exitCode).toBe(0)
			const iterPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const iterStdout = await readFile(iterPaths.runStdoutFile(iterClosed.runId), "utf-8")
			expect(iterStdout).toContain("BINARY:claude")
			expect(iterStdout).not.toContain("BINARY:codex")

			fixture.store.updateItem(fixture.store.listItems(chain.id)[0]!.id, { status: runtimeStatus("changes_requested") })

			const reviewTick = await schedulerTick({
				...baseOptions,
				phaseRunner,
				phase: "review",
				prompt: "review-prompt",
			})
			expect(reviewTick.spawnedRuns).toHaveLength(1)
			const reviewClosed = await reviewTick.spawnedRuns[0]!.closed
			expect(reviewClosed.exitCode).toBe(0)
			const reviewStdout = await readFile(iterPaths.runStdoutFile(reviewClosed.runId), "utf-8")
			// Unified policy: item.runner = "claude" propagates to every non-trigger phase, including
			// review under the bundled preset (which has `trigger === null`). The role-named carve-out
			// is gone, so review emits the same `BINARY:claude` as iteration.
			expect(reviewStdout).toContain("BINARY:claude")
			expect(reviewStdout).not.toContain("BINARY:codex")
		} finally {
			await stopFixture(fixture)
		}
	})
})

describe("runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry)", () => {
	const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

	test("streams chain-complete runner output without retaining full history", async () => {
		const fixture = await createFixture("trigger-large-output")
		try {
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-large-finalizer.sh")
			await writeFile(fakeClaude, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 200000 ]; do echo "trigger-$i"; i=$((i + 1)); done\necho "FINALIZER SUMMARY: decision=complete; reason=large-output"\n`)
			await chmod(fakeClaude, 0o755)
			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-large")
			await mkdir(targetCwd, { recursive: true })
			const chain = createChain(fixture.store, "trigger-large-output-chain")
			const item = createItem(fixture.store, chain, { issueNumber: 630_002, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const runId = `trigger-${chain.id}-large`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items: fixture.store.listItems(chain.id),
				runId,
				terminalStatusNames: [runtimeStatus("done")],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
				phaseRunner: () => ({ kind: "claude", source: "iteration-default", binary: fakeClaude, extraArgs: [], model: null }),
			})
			expect(decision).toEqual({ decision: "complete" })
			const path = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot }).runPhaseStdoutFile(runId, "umbrella-finalizer")
			const output = await readFile(path, "utf-8")
			expect(output).toContain("trigger-199999")
			expect(output.endsWith("FINALIZER SUMMARY: decision=complete; reason=large-output\n")).toBe(true)
		} finally {
			await stopFixture(fixture)
		}
	})

	test("default chain metadata → triggered phase 'umbrella-finalizer' spawns preset codex via chain-derived selectRunnerForPhase", async () => {
		const fixture = await createFixture("trigger-iter-default")
		try {
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-finalizer.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-finalizer.sh")
			await writeShellFinalizerMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellFinalizerMarkerScript(fakeClaude, "BINARY:claude")

			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-iter")
			await mkdir(targetCwd, { recursive: true })

			const chain = createChain(fixture.store, "trigger-iter-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			const item = createItem(fixture.store, chain, { issueNumber: 287_801, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const items = fixture.store.listItems(chain.id)

			const runId = `trigger-${chain.id}-default`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
			})
			expect(decision).toEqual({ decision: "complete" })

			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(chainPaths.runPhaseStdoutFile(runId, "umbrella-finalizer"), "utf-8")
			expect(stdout).toContain("BINARY:codex")
			expect(stdout).not.toContain("BINARY:claude")
		} finally {
			await stopFixture(fixture)
		}
	})

	// #433: the legacy `metadata.runner` top-level field is retired. The retirement is enforced at
	// parse time (createChain → parseChainMetadata), so the chain never makes it to the trigger
	// phase code. This locks in the "no silent-ignore" stance: operators who try the old shape get
	// a loud error pointing at the new bindings/per-runner channels.

	test("phaseRunner override input wins over chain-derived selection for the triggered phase spawn", async () => {
		const fixture = await createFixture("trigger-phaseRunner-override")
		try {
			const fakeCodex = resolve(fixture.loopDataRoot, "..", "fake-codex-finalizer.sh")
			const fakeClaude = resolve(fixture.loopDataRoot, "..", "fake-claude-finalizer.sh")
			await writeShellFinalizerMarkerScript(fakeCodex, "BINARY:codex")
			await writeShellFinalizerMarkerScript(fakeClaude, "BINARY:claude")

			const targetCwd = resolve(fixture.loopDataRoot, "..", "target-trigger-override")
			await mkdir(targetCwd, { recursive: true })

			const chain = createChain(fixture.store, "trigger-override-chain", {
				metadata: {
					claude: { binary: fakeClaude },
					codex: { binary: fakeCodex },
				},
			})
			const item = createItem(fixture.store, chain, { issueNumber: 287_803, repoCwd: targetCwd })
			fixture.store.updateItem(item.id, { evidenceDir: null })
			const items = fixture.store.listItems(chain.id)

			const seenPhases: string[] = []
			const overrideRunner: AgentRunnerSelection = {
				kind: "claude",
				source: "iteration-default",
				binary: fakeClaude,
				extraArgs: [],
				model: null,
			}

			const runId = `trigger-${chain.id}-override`
			const decision = await runPresetChainCompleteTriggerPhases({
				chain,
				items,
				runId,
				terminalStatusNames: [runtimeStatus("done"), runtimeStatus("moot"), runtimeStatus("blocked")],
				loopDataRoot: fixture.loopDataRoot,
				presetDir: PRESET_DIR,
				targetCwd,
				phaseRunner: (phase) => {
					seenPhases.push(phase)
					return overrideRunner
				},
			})
			expect(decision).toEqual({ decision: "complete" })
			expect(seenPhases).toEqual(["umbrella-finalizer"])

			const chainPaths = resolveChainRuntimePaths(chain.name, { loopDataRoot: fixture.loopDataRoot })
			const stdout = await readFile(chainPaths.runPhaseStdoutFile(runId, "umbrella-finalizer"), "utf-8")
			expect(stdout).toContain("BINARY:claude")
			expect(stdout).not.toContain("BINARY:codex")
		} finally {
			await stopFixture(fixture)
		}
	})
})
