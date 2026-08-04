import { FAKE_RUNNER_STATUS_WRITE_SNIPPET, FakeRunnerRunningEventBoundary, PRESET_DIR, REPO_ROOT, TEST_ROOT, daemonRequest, describe, expect, expectInvalid, expectOk, mkdir, numberValue, openSqliteStateStore, queryObservabilityEvents, readChainStatus, readFile, readItem, readRun, readdir, record, request, resolve, resolveChainRuntimePaths, resolveLoopDataPaths, runtimeStatus, sendDaemonRequest, startCoderLoopDaemon, startFixture, stat, stringValue, test, waitFor, writeCredentialedFixturePreset, writeFile } from "./harness"
import type { JsonObject } from "./harness"
let nextFixtureId = 0

describe("daemon", () => {
	test("socket item.update operator path emits operator-attributed caller-admission audit (#406)", async () => {
		const fixture = await startFixture("item-update-caller-operator", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406001",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)
			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
			})).item)
			expect(updated).toMatchObject({ id: itemId, status: runtimeStatus("done") })

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const allEvents = (await queryObservabilityEvents(eventsPath)).events
			const callerAllow = allEvents.find((event) => event.kind === "audit" && event.type === "item.mutation.caller_admission" && event.item === itemId)
			expect(callerAllow).toBeDefined()
			if (callerAllow !== undefined && callerAllow.kind === "audit" && callerAllow.type === "item.mutation.caller_admission") {
				expect(callerAllow.subject).toEqual({ kind: "operator" })
				expect(callerAllow.payload).toMatchObject({
					rowId: itemId,
					itemId: "406001",
					claimedRunId: null,
					claimedPhase: null,
					outcome: "allow",
					reason: "operator",
				})
			}
			const statusEvent = allEvents.find((event) => event.kind === "audit" && event.type === "item.status" && event.item === itemId)
			expect(statusEvent).toBeDefined()
			if (statusEvent !== undefined && statusEvent.kind === "audit" && statusEvent.type === "item.status") {
				expect(statusEvent.subject).toEqual({ kind: "operator" })
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (unknown-credential deny). A request that carries an
	// `agentCredential` value that does not match any registered active run is rejected with
	// `invalid_caller` and the audit event records `reason: unknown-credential`.

	test("socket item.update rejects an unknown agentCredential value (#406)", async () => {
		const fixture = await startFixture("item-update-caller-unknown-credential", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-unknown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406002",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)
			const denied = await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
				agentCredential: "credential-not-in-registry",
			})
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const allEvents = (await queryObservabilityEvents(eventsPath)).events
			const callerDeny = allEvents.find((event) => event.kind === "audit" && event.type === "item.mutation.caller_admission" && event.item === itemId && event.payload.outcome === "deny")
			expect(callerDeny).toBeDefined()
			if (callerDeny !== undefined && callerDeny.kind === "audit" && callerDeny.type === "item.mutation.caller_admission") {
				expect(callerDeny.payload.reason).toBe("unknown-credential")
			}
			// The store was untouched — the gate ran before any state mutation.
			const items = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(items) || items.length === 0) throw new Error("expected an item in caller-unknown-chain")
			const stillQueued = record(items[0])
			expect(stillQueued.status).toBe(runtimeStatus("queued"))
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #406 caller-admission gate (legacy attribution flags). The retired `agentRunId` /
	// `agentPhase` keys are rejected by `validateKnownKeys` (they are not in ITEM_UPDATE_ARG_KEYS).
	// This pins the substitutive contract: agents can no longer hand-write their identity.
	// #406 caller-admission gate (live spawn → wrong-item). Two items in the same chain spawn
	// sequentially under the default fake runner. We capture the active credential from inside
	// the runner's process env, then use it to attempt an item.update against a sibling item the
	// credential is NOT bound to. The daemon's `wrong-item` deny branch fires and the audit log
	// carries reason=wrong-item.

	test("socket item.update rejects cross-item write with the wrong-item deny branch (live spawn, #406)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-wrong-item-live`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const promptCapturePath = resolve(root, "captured-prompt.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		// #406 dedicated runner: captures `CODER_LOOP_RUN_CRED` env + the rendered prompt to side
		// files, sleeps long enough for the test to drive an item.update against another item, then
		// exits 0 leaving the per-run status untouched (no writeStatus needed).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await writeFile(${JSON.stringify(promptCapturePath)}, prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 3000))
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 2_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-wrong-item-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const itemA = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406010",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemB = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406011",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemBId = numberValue(itemB.id)

			// Wait for itemA's spawn and the credential capture.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Same credential against the sibling item: the wrong-item deny branch must fire.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId: itemBId,
				status: runtimeStatus("done"),
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			// Audit replay: the deny is recorded against itemB with reason=wrong-item.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemBId
				&& event.payload.outcome === "deny"
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.mutation.caller_admission") {
				expect(denyEvent.payload.reason).toBe("wrong-item")
			}

			// #406 row 6 — prompt/trace leak guard: the credential value never enters the rendered
			// prompt (or, by extension, anything the agent could exfiltrate via its own writes).
			const promptCapture = await readFile(promptCapturePath, "utf-8")
			expect(promptCapture.includes(credential)).toBe(false)
			// Run trace artifacts (stdout/stderr) likewise must not carry the credential value.
			const paths = resolveChainRuntimePaths("caller-wrong-item-chain", { loopDataRoot })
			// Allow the run to finish so the close handler writes the trace artifacts.
			await waitFor(async () => {
				try {
					return await readFile(paths.runStdoutFile(stringValue(itemA.lastRunId ?? "")), "utf-8")
				} catch {
					return null
				}
			}, () => true, 8_000)
			// Walk the per-run dir and grep every file for the credential value.
			const runDir = paths.runDir(stringValue((await readItem(loopDataRoot, chainId, 406_010))?.lastRunId ?? ""))
			let leak = false
			async function walk(dir: string): Promise<void> {
				let names: string[]
				try {
					names = await readdir(dir)
				} catch {
					return
				}
				for (const name of names) {
					const child = resolve(dir, name)
					let entryStat
					try {
						entryStat = await stat(child)
					} catch {
						continue
					}
					if (entryStat.isDirectory()) {
						await walk(child)
					} else if (entryStat.isFile()) {
						try {
							const body = await readFile(child, "utf-8")
							if (body.includes(credential)) leak = true
						} catch {
							// Binary or unreadable — skip.
						}
					}
				}
			}
			await walk(runDir)
			expect(leak).toBe(false)
		} finally {
			await daemon.stop()
		}
	})

	// #406 row 3 — affirmative admit: with the agent credential env captured, `item update` on
	// the bound item returns ok AND the SQLite item.status reflects the declared exit AND the
	// emitted audit event carries `subject.kind === "agent"` with the runId. The dedicated row-3
	// observation that distinguishes "credential admitted" from "request rejected": this test
	// FAILS if `admitItemMutationCaller` ever regresses to the operator branch (or a deny) for an
	// agent's own credential against its own bound item — the deny-sibling/expiry tests only catch
	// regressions where credentials are wrongly accepted, never where they're wrongly rejected.

	test("socket item.update admits the agent's own credential against its bound item (live spawn, #406 row 3)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-admit-bound-item-live`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		// Capture credential to a side file, then sleep long enough for the test to drive an
		// affirmative item.update against the bound item before exiting.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 3500))
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 3_000,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-admit-bound-item-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(item.id)

			// Wait until the runner has spawned and captured the credential into the side file.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// The scheduler stamps `phase="iteration"` at spawn, and the gh-issue-pr-iteration
			// preset declares zero exits for iteration. The agent-realistic affirmative path runs
			// in review (whose declared exits include `changes_requested`); since we can't drive
			// a real iteration→review transition mid-test without racing the run's natural close,
			// we manually rewrite the item's phase to "review" while the runner is still alive
			// (so the daemon's active-run registry still holds this credential). The caller-
			// admission gate (which only checks `chain + item + credential-still-active`) admits
			// the call exactly as it would for a real review-phase agent; the per-phase write
			// gate then runs against `phase="review"` and allows `changes_requested`.
			const store = openSqliteStateStore({ loopDataRoot })
			try {
				store.updateItem(itemId, { phase: "review", updatedAt: Math.floor(Date.now() / 1000) })
			} finally {
				store.close()
			}

			// Affirmative row 3: bound item + active credential → ok + status reflected + audit
			// subject = {agent, runId, phase}. If the admit code regresses to denying the bound
			// item (caller becomes `operator` for an agent credential, or the gate returns deny),
			// `response.ok` flips to false and the subject assertions stall — the wrong-item /
			// expiry tests would still pass because they only exercise the deny side.
			const response = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				agentCredential: credential,
			}))
			expect(response.ok).toBe(true)
			if (!response.ok) throw new Error(`expected admit, got error ${response.error.code}: ${response.error.message}`)
			const updatedItem = record(response.result.item)
			expect(updatedItem.id).toBe(itemId)
			expect(updatedItem.status).toBe(runtimeStatus("changes_requested"))

			// SQLite cross-check: bypass the daemon and read the row directly. If the admit path
			// flipped to "allow but skip write" the response would still be ok=true with a stale
			// status; this assertion catches that.
			const persisted = await readItem(loopDataRoot, chainId, 406_300)
			expect(persisted?.status).toBe(runtimeStatus("changes_requested"))

			// Audit replay: the caller-admission allow event for this mutation must carry
			// `subject.kind === "agent"` with the runId that was bound to this credential at
			// spawn time. Find the run id from the eventLog the fake runner wrote.
			const runIdLine = (await readFile(eventLog, "utf-8")).split("\n").find((line) => line.trim() !== "") ?? ""
			// Boundary-parse the fake-runner event-log entry instead of casting onto an anonymous
			// shape (#406 红线).
			const runIdRecord = FakeRunnerRunningEventBoundary.assert(JSON.parse(runIdLine))
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const admissionAllow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "agent-credential-admitted"
			)
			expect(admissionAllow).toBeDefined()
			if (admissionAllow !== undefined && admissionAllow.kind === "audit" && admissionAllow.type === "item.mutation.caller_admission") {
				expect(admissionAllow.subject).toEqual({ kind: "agent", runId: runIdRecord.runId, phase: "iteration" })
				expect(admissionAllow.payload.claimedRunId).toBe(runIdRecord.runId)
			}
			// And the downstream `item.status` audit must inherit the agent subject + runId; this is
			// the observation row 3 names — operator-attribution slipping through would tag this
			// event `{kind: "operator"}`.
			const statusEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.status"
				&& event.item === itemId
				&& "runId" in event
				&& event.runId === runIdRecord.runId
			)
			expect(statusEvent).toBeDefined()
			if (statusEvent !== undefined && statusEvent.kind === "audit" && statusEvent.type === "item.status") {
				expect(statusEvent.subject).toEqual({ kind: "agent", runId: runIdRecord.runId, phase: "iteration" })
				expect(statusEvent.payload.toStatus).toBe("changes_requested")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #406 caller-admission gate (run-end → credential invalidation). A credential captured during
	// an active run is rejected after the run closes — the scheduler's `finally` revokes it from
	// the registry, and the unknown-credential deny branch fires.

	test("socket item.update rejects an expired credential after the run ends (live spawn, #406)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-caller-credential-expiry-live`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
// Exit non-zero with no status write — the item stays queued (the scheduler honors the agent's
// non-write outcome and applies attempt backoff). This keeps the chain non-terminal so the
// post-run item.update attempt reaches the caller-admission gate (not chain_not_active).
process.exitCode = 1
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId, eventLog }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "caller-expiry-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "406020",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const itemId = numberValue(item.id)

			// Wait for the credential to be captured (it appears as soon as the runner starts).
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Wait for the run to end (active runs returns to empty).
			await waitFor(
				async () => record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon).activeRuns,
				(runs) => Array.isArray(runs) && runs.length === 0,
				10_000,
			)

			// Same credential against the same item after the run closed: deny with
			// `unknown-credential` (the scheduler's finally already revoked it).
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("agentCredential")
			}

			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.mutation.caller_admission"
				&& event.item === itemId
				&& event.payload.outcome === "deny"
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.mutation.caller_admission") {
				expect(denyEvent.payload.reason).toBe("unknown-credential")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #406 row 5 / #417 composition: review agent self-tagging terminal status exits cleanly without
	// any explicit reaper kill (`terminateActiveRunsForItem` stays uncalled). The credential
	// revocation runs in the scheduler's natural close-handler `finally`, NOT via a daemon-side
	// kill. This pins the "#417 行为不回退" contract.

	test("active run terminating naturally invalidates its credential without explicit kill (#406 + #417)", async () => {
		const fixture = await startFixture("caller-no-reaper-kill")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "caller-no-reaper-kill-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "406030",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 100, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)

			// Run completes naturally.
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			const finalItem = await readItem(fixture.loopDataRoot, chainId, 406_030)
			expect(finalItem?.lastRunId).not.toBeNull()
			const lastRun = await readRun(fixture.loopDataRoot, finalItem?.lastRunId ?? "")
			expect(lastRun).not.toBeNull()
			// 143 = SIGTERM exit code. The natural close must be exitCode=0, not 143 (the #417
			// reaper-kill signature). If a kill leaks back in, this would be 143.
			expect(lastRun?.exitCode).toBe(0)
			// itemId asserted defined for tooling; not referenced further.
			expect(finalItem).not.toBeNull()
			expect(itemId).toBe(finalItem?.id ?? -1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add denies an iteration-phase agentCredential with no-rights-segment (#407 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row1-iter-deny`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		// Fake iteration runner: capture CODER_LOOP_RUN_CRED, then sleep long enough for the
		// test to drive an item.add against the daemon before the run closes (closing the run
		// would revoke the credential from the registry and the gate would short-circuit on
		// `unknown-credential` before ever reaching the rights check).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					eventLog,
					sleepMs: 3_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row1-iter-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			// Parent item the scheduler will spawn against (iteration phase, no rights).
			const parent = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407100",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))).item)
			const parentId = numberValue(parent.id)

			// Wait for the scheduler to spawn the iteration runner and capture the credential.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue the item.add with the iteration agent's credential. Iteration phase has NO
			// `[phases.rights]` segment in preset.toml → classifyNoCreateGrantReason yields
			// `no-rights-segment` (createItems=false AND writableFields empty AND privilegedOps empty).
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407101",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("iteration")
				expect(denied.error.message).toContain("createItems")
			}

			// Audit replay: exactly one `item.add.rights_admission` event for the iteration phase,
			// outcome=deny, reason=no-rights-segment. The subject must be `agent` (not operator —
			// the credential resolved successfully). The deny event MUST exist before the agent's
			// run-close handler revokes the credential, so we read the events file immediately.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denyEvent = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "deny",
			)
			expect(denyEvent).toBeDefined()
			if (denyEvent !== undefined && denyEvent.kind === "audit" && denyEvent.type === "item.add.rights_admission") {
				expect(denyEvent.payload.reason).toBe("no-rights-segment")
				expect(denyEvent.payload.claimedPhase).toBe("iteration")
				expect(denyEvent.subject).toMatchObject({ kind: "agent" })
				expect(denyEvent.payload.presetName).toBe("gh-issue-pr-iteration")
			}

			// Item-list cross-check: only the parent item exists; the child the agent attempted to
			// create was rejected BEFORE store.createItem. (parentId asserted defined for tooling.)
			const listed = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const items = Array.isArray(listed.items) ? listed.items : []
			expect(items.length).toBe(1)
			expect(parentId).toBe(numberValue(record(items[0] ?? {}).id))
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #2 — review phase declares `[phases.rights] createItems = true` in
	// gh-issue-pr-iteration preset.toml, so an item.add request bearing a review-phase agent
	// credential is admitted. The audit event records outcome=allow / reason=agent-allowed.
	// item.list cross-check confirms the child WAS inserted into the queue. Pipeline reaches
	// the review phase via the realistic iteration→review transition (iteration writes
	// `in_progress` status with exitCode=0, scheduler advances to review on the next tick).

	test("socket item.add admits a review-phase agentCredential and inserts the child (#407 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row2-review-allow`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Fake runner branches on `input.phase`: iteration writes `in_progress` status with
		// exitCode 0 (scheduler then advances to review). Review captures the credential and
		// sleeps long enough for the test to drive the item.add. The runner uses
		// FAKE_RUNNER_STATUS_WRITE_SNIPPET shape: it consumes input.writeStatus from the prompt
		// (the scheduler-side `prompt` lambda below maps phase→writeStatus the same way
		// startPhaseAdvancementFixture does).
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const { openSqliteStateStore } = await import(${JSON.stringify(resolve(REPO_ROOT, "src/sqlite-state.ts"))})

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
} else {
	// Iteration: write in_progress status and exit 0 so the scheduler advances to review.
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, 5))
}
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row2-review-allow-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			const parent = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407200",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			}))).item)
			const parentId = numberValue(parent.id)

			// Wait for the scheduler to advance iteration→review and the review runner to capture
			// its credential. The 12s timeout accommodates two scheduler ticks (iteration spawn
			// + review spawn) on a busy CI host.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 12_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue item.add with the review-phase credential. Review has createItems=true →
			// allow. The new item appears in the queue.
			const created = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407201",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
				agentCredential: credential,
			}))
			expect(created.ok).toBe(true)
			if (!created.ok) throw new Error(`expected allow, got ${created.error.code}: ${created.error.message}`)
			const newItem = record(created.result.item)
			expect(stringValue(newItem.itemId)).toBe("407201")

			const deniedHookAdd = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407202",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
				extra: { hooks: [] },
				agentCredential: credential,
			}))
			expect(deniedHookAdd.ok).toBe(false)
			if (!deniedHookAdd.ok) expect(deniedHookAdd.error.message).toContain("hooks")

			const deniedHookBatch = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.batchAdd", {
				chainId,
				items: [{ itemId: "407203", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration", extra: { hooks: [] } }],
				agentCredential: credential,
			}))
			expect(deniedHookBatch.ok).toBe(false)
			if (!deniedHookBatch.ok) expect(deniedHookBatch.error.message).toContain("hooks")

			// item.list cross-check: parent + child both present (2 items).
			const listed = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const items = Array.isArray(listed.items) ? listed.items : []
			const itemIds = items.map((entry) => stringValue(record(entry).itemId)).sort()
			expect(itemIds).toEqual(["407200", "407201"])
			expect(parentId).toBeGreaterThan(0)

			// Audit replay: outcome=allow, reason=agent-allowed, subject.kind=agent, phase=review.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const allow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "agent-allowed",
			)
			expect(allow).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "item.add.rights_admission") {
				expect(allow.payload.claimedPhase).toBe("review")
				expect(allow.subject).toMatchObject({ kind: "agent" })
				expect(allow.payload.presetName).toBe(credentialedPresetDir)
			}
			const hookDenials = events.filter((event) => event.kind === "audit" && event.type === "item.add.rights_admission" && event.payload.reason === "control-plane-denied")
			expect(hookDenials).toHaveLength(2)
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #3 — the operator path (no agentCredential field at all) is NEVER
	// gated by the rights segment. The boundary parse treats absent `agentCredential` as
	// `kind: "operator"`, the gate emits one `item.add.rights_admission` allow event with
	// reason=operator, and the item is created. Mirrors the existing #406 operator-path test
	// at line ~3216 but on the create path instead of the update path.

	test("socket item.add operator path bypasses the rights gate with reason=operator (#407 row 3)", async () => {
		const fixture = await startFixture("407-row3-operator-bypass", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "407-row3-operator-bypass-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "407300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const itemId = numberValue(added.id)
			expect(itemId).toBeGreaterThan(0)

			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const allow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow",
			)
			expect(allow).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "item.add.rights_admission") {
				expect(allow.payload.reason).toBe("operator")
				expect(allow.subject).toEqual({ kind: "operator" })
				expect(allow.payload.claimedPhase).toBeNull()
				expect(allow.payload.presetName).toBe("gh-issue-pr-iteration")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #407 acceptance row #4 — single-phase-example preset has no `[phases.rights]` segment
	// anywhere (the run phase omits it). An agent credential bound to its `run` phase that
	// tries item.add against the same chain is rejected with reason=no-rights-segment. The
	// operator-variant inside the same test confirms operator path is unaffected (mirrors
	// row #3 but on the smoke preset).

	test("socket item.add default-deny on single-phase-example for agents; operator path still allowed (#407 row 4)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row4-default-deny`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		const smokePresetDir = resolve(REPO_ROOT, "presets/single-phase-example")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		// Capture-credential fake runner; sleeps long enough for the test to drive item.add.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: smokePresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row4-default-deny-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			// Operator-path variant first (precondition for row 4's "operator path always allowed"):
			// no credential → allow with reason=operator. Issue this BEFORE the scheduler spawns the
			// agent runner so chain has at least one item to schedule.
			const operatorItem = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407400",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			}))).item)
			expect(numberValue(operatorItem.id)).toBeGreaterThan(0)

			// Wait for the run-phase credential to land in the capture file.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Agent path: the `run` phase has no rights segment → default-deny.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407401",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) expect(denied.error.code).toBe("invalid_caller")

			// Audit replay: agent deny event MUST carry reason=no-rights-segment + agent subject.
			// Also assert the operator allow event from the precondition exists.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllow = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			expect(operatorAllow).toBeDefined()
			if (operatorAllow !== undefined && operatorAllow.kind === "audit" && operatorAllow.type === "item.add.rights_admission") {
				expect(operatorAllow.payload.presetName).toBe("single-phase-example")
				expect(operatorAllow.subject).toEqual({ kind: "operator" })
			}
			const agentDeny = events.find((event) =>
				event.kind === "audit"
				&& event.type === "item.add.rights_admission"
				&& event.payload.outcome === "deny",
			)
			expect(agentDeny).toBeDefined()
			if (agentDeny !== undefined && agentDeny.kind === "audit" && agentDeny.type === "item.add.rights_admission") {
				expect(agentDeny.payload.reason).toBe("no-rights-segment")
				expect(agentDeny.payload.claimedPhase).toBe("run")
				expect(agentDeny.subject).toMatchObject({ kind: "agent" })
				expect(agentDeny.payload.presetName).toBe("single-phase-example")
			}
		} finally {
			await daemon.stop()
		}
	})

	// #407 acceptance row #5 — field-validation parity with item.update. A review-phase agent
	// credential (createItems=true) issues item.add carrying an illegal priority value. The
	// daemon's `validateItemPriorityForRequest` (shared between item.add and item.update) must
	// reject with the SAME shape as the update path: code=invalid_request, message includes
	// the allowed list (low, medium, high, critical). The point is to pin that the new gate
	// does not change downstream field validation — it runs BEFORE buildCreateItemInput, and
	// buildCreateItemInput still enforces field shape exactly as before.

	test("socket item.add review credential rejects illegal priority with the same invalid_request shape as item.update (#407 row 5)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-407-row5-priority-validation`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 4000))
} else {
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, 5))
}
process.exitCode = 0
`,
		)

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 3_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "407-row5-priority-validation-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407500",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			})))

			// Wait for the review phase credential to be captured.
			await waitFor(async () => {
				try {
					return (await readFile(capturePath, "utf-8")).trim()
				} catch {
					return ""
				}
			}, (value) => value.length > 0, 12_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Issue item.add carrying an illegal priority value. Even though the agent's review
			// credential WOULD pass the rights gate, the request must be rejected for the
			// priority shape: code=invalid_request, message includes the allowed enum.
			const denied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "407501",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
				agentCredential: credential,
				priority: "super-critical",
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_request")
				expect(denied.error.message).toContain("priority must be one of")
				expect(denied.error.message).toContain("critical")
			}

			// Cross-check the equivalence on item.update: same illegal priority value, same code
			// + message. This pins "review path uses validateItemPriorityForRequest just like update".
			// We need a real item to update against; the scheduler's parent item works.
			const parent = await waitFor(
				async () => await readItem(loopDataRoot, chainId, 407_500),
				(value) => value !== null,
				6_000,
			)
			expect(parent).not.toBeNull()
			const updateDenied = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId: parent?.id ?? -1,
				priority: "super-critical",
			}))
			expect(updateDenied.ok).toBe(false)
			if (!updateDenied.ok && !denied.ok) {
				expect(updateDenied.error.code).toBe(denied.error.code)
				expect(updateDenied.error.message).toBe(denied.error.message)
			}
		} finally {
			await daemon.stop()
		}
	})

	// #409 acceptance row #1 — hard-deny vocabulary. Each agent-credentialed daemon call
	// against the hard-deny list (`chain.delete`, `chain.stop`, `daemon.down`, `logs.query`,
	// `queue.unblock`, `chain.create`, `chain.resume`) must be rejected before any handler-side
	// work, with an error message that names NO preset grammar (the operator cannot flip the
	// gate via a `[phases.rights]` declaration — the contract forbids it). Every rejection emits
	// one `privileged_op.caller_admission` audit event with `outcome=deny / reason=hard-deny-for-agent`.

	test("daemon hard-denies chain.delete / chain.stop / daemon.down for agent credentials with no-preset-grammar message (#409 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-row1-hard-deny`)
		const loopDataRoot = root + "-loop-data"
		const capturePath = resolve(root, "captured-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(root, { recursive: true })
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await writeFile(${JSON.stringify(capturePath)}, process.env.CODER_LOOP_RUN_CRED ?? "")
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId }) + "\\n")
await new Promise((r) => setTimeout(r, input.sleepMs ?? 6_000))
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: PRESET_DIR,
				worktreeManager: async () => root,
				prompt: ({ item, runId }) => JSON.stringify({ itemId: item.id, issueNumber: Number(item.itemId), runId, eventLog, sleepMs: 5_500 }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-row1-hard-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409100",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})))

			// Wait for the scheduler to spawn the iteration runner and capture its credential.
			await waitFor(async () => {
				try { return (await readFile(capturePath, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const credential = (await readFile(capturePath, "utf-8")).trim()
			expect(credential.length).toBeGreaterThan(0)

			// Drive each hard-deny op with the agent credential and assert the verdict + message.
			const hardDenyAttempts: { command: "chain.delete" | "chain.stop" | "chain.resume" | "chain.create" | "daemon.down" | "logs.query" | "queue.unblock"; args: JsonObject }[] = [
				{ command: "chain.delete", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.stop", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.resume", args: { chainName: "409-row1-hard-deny-chain", agentCredential: credential } },
				{ command: "chain.create", args: { name: "409-row1-second", preset: "gh-issue-pr-iteration", repository: "mouriya-s-lab/coder-loop", agentCredential: credential } },
				{ command: "daemon.down", args: { agentCredential: credential } },
				{ command: "logs.query", args: { agentCredential: credential } },
				{ command: "queue.unblock", args: { chainName: "409-row1-hard-deny-chain", issue: "409100", agentCredential: credential } },
			]
			for (const attempt of hardDenyAttempts) {
				const reply = await sendDaemonRequest(snapshot.socketPath, daemonRequest(attempt.command, attempt.args))
				expect(reply.ok, `expected ${attempt.command} to be denied for agent credential`).toBe(false)
				if (!reply.ok) {
					expect(reply.error.code).toBe("invalid_caller")
					// Acceptance #1: the message names no authorization grammar. The strings
					// "phases.rights", "privilegedOps", "createItems", "writableFields" must NOT
					// appear — those are the only preset-rights words the codebase exposes today.
					expect(reply.error.message).not.toContain("phases.rights")
					expect(reply.error.message).not.toContain("privilegedOps")
					expect(reply.error.message).not.toContain("createItems")
					expect(reply.error.message).not.toContain("writableFields")
					expect(reply.error.message).toContain(attempt.command)
					expect(reply.error.message).toContain("operator credentials")
				}
			}

			// Audit replay: every attempt above emits exactly one privileged_op.caller_admission
			// event with outcome=deny + reason=hard-deny-for-agent + the agent's subject. The
			// daemon also emits operator-allow events for chain.create + item.add we ran during
			// setup — filter on outcome=deny so we only see the seven denials above.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denies = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "deny",
			)
			expect(denies.length).toBeGreaterThanOrEqual(hardDenyAttempts.length)
			const expectedOps = new Set(hardDenyAttempts.map((entry) => entry.command))
			for (const expectedOp of expectedOps) {
				const match = denies.find((event) =>
					event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === expectedOp,
				)
				expect(match, `expected privileged_op.caller_admission deny for ${expectedOp}`).toBeDefined()
				if (match !== undefined && match.kind === "audit" && match.type === "privileged_op.caller_admission") {
					expect(match.payload.reason).toBe("hard-deny-for-agent")
					expect(match.subject).toMatchObject({ kind: "agent" })
					expect(match.payload.claimedPhase).toBe("iteration")
				}
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 acceptance row #2 — per-phase authorized op. `item.reorder` is the only entry in the
	// `PRESET_PHASE_PRIVILEGED_OPS` tuple today; the bundled `gh-issue-pr-iteration` preset
	// declares it on review's `[phases.rights] privilegedOps`. An iteration-phase agent
	// credential issuing item.reorder must be rejected (no grant on iteration's rights segment);
	// a review-phase agent credential must succeed. Both outcomes emit `privileged_op.caller_admission`.

	test("daemon allows item.reorder for review agent and denies it for iteration agent (#409 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-409-row2-per-phase`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		// Two-phase fake runner: iteration writes its credential to iterationCapture + writes
		// in_progress status (scheduler advances to review on the next tick); review writes its
		// credential to reviewCapture and sleeps long enough for the test to drive reorder.
		// #419 review M2: iteration's sleep extended from 5ms to `iterationSleepMs` (default 3_000ms)
		// so the iteration agent's run stays in the daemon's active-runs map while the test sends
		// the deny-path `item.reorder`. The original 5ms window raced under full-suite concurrent
		// load — the run had already closed (revoking the credential) before the request landed,
		// turning the expected "deny + reason=no-rights-segment" into an "inactive-run" rejection.
		// The longer sleep is bounded by the scheduler's slot-busy semantics: review can't spawn
		// until iteration's run closes, so this just pushes review's start a few seconds later,
		// well within the test's 30s budget.
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, input.iterationSleepMs ?? 3_000))
}
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 5_500,
					// #419 review M2: keep iteration alive ~3s so the deny-path reorder request below
					// hits the active-credential gate instead of the inactive-run branch when the test
					// suite runs concurrently.
					iterationSleepMs: 3_000,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "409-row2-per-phase-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409200",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			})))
			// Add a second item so reorder is meaningful (position 1 vs 0).
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "409201",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			})))

			// Capture the iteration credential first.
			await waitFor(async () => {
				try { return (await readFile(iterationCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const iterationCredential = (await readFile(iterationCapture, "utf-8")).trim()
			expect(iterationCredential.length).toBeGreaterThan(0)

			// #419 review M2: confirm the iteration run is still active before issuing the deny-path
			// reorder. Otherwise — under full-suite concurrent load — the iteration runner may have
			// already exited and revoked its credential, and the daemon would reject with
			// `agentCredential resolves to run … which is no longer active` instead of the
			// per-phase rights deny we are asserting on. The DaemonActiveRun wire shape only
			// exposes `runId`, not `phase`, so we identify the iteration run by the runId pattern
			// (`run-<ts>-<seq>-iteration-item-<n>`) which the engine bakes into the runId at
			// agent.spawn (via makeRunIdFactory — see loop.ts).
			await waitFor(async () => {
				const status = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon
				const activeRuns = record(status).activeRuns
				return Array.isArray(activeRuns) ? activeRuns : []
			}, (runs) => runs.some((run) => {
				const runId = record(run).runId
				return typeof runId === "string" && runId.includes("-iteration-item-")
			}), 8_000)

			// Iteration phase has NO privilegedOps in its rights segment → deny.
			const iterationReorder = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.reorder", {
				chainName: "409-row2-per-phase-chain",
				itemId: "409201",
				position: 0,
				agentCredential: iterationCredential,
			}))
			expect(iterationReorder.ok).toBe(false)
			if (!iterationReorder.ok) {
				expect(iterationReorder.error.code).toBe("invalid_caller")
				expect(iterationReorder.error.message).toContain("item.reorder")
				expect(iterationReorder.error.message).toContain("iteration")
				expect(iterationReorder.error.message).toContain("gh-issue-pr-iteration")
			}

			// Now wait for the review phase credential (the iteration's in_progress write makes
			// the scheduler advance to review on the next tick).
			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)
			expect(reviewCredential).not.toBe(iterationCredential)

			// Review phase HAS privilegedOps = ["item.reorder"] → allow.
			const reviewReorder = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.reorder", {
				chainName: "409-row2-per-phase-chain",
				itemId: "409201",
				position: 0,
				agentCredential: reviewCredential,
			})))
			const reorderedItems = Array.isArray(reviewReorder.items) ? reviewReorder.items : []
			expect(reorderedItems.length).toBeGreaterThan(0)

			// Audit replay: one allow + one deny for item.reorder.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const reorderAudits = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.op === "item.reorder",
			)
			const allow = reorderAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "allow",
			)
			const deny = reorderAudits.find((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "deny",
			)
			expect(allow).toBeDefined()
			expect(deny).toBeDefined()
			if (allow !== undefined && allow.kind === "audit" && allow.type === "privileged_op.caller_admission") {
				expect(allow.payload.reason).toBe("agent-allowed")
				expect(allow.payload.claimedPhase).toBe("review")
				expect(allow.payload.presetName).toBe("gh-issue-pr-iteration")
			}
			if (deny !== undefined && deny.kind === "audit" && deny.type === "privileged_op.caller_admission") {
				expect(deny.payload.reason).toBe("no-rights-segment")
				expect(deny.payload.claimedPhase).toBe("iteration")
				expect(deny.payload.presetName).toBe("gh-issue-pr-iteration")
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #409 retry — the per-phase-authorized agent path must emit a `privileged_op.caller_admission`
	// deny event even when the pre-grant resolution chain (resolveItem → getChain → loadedPresetForItem)
	// throws BEFORE the grant lookup can run. The hard-deny branch at runAuthorizationGate already
	// emits on resolveItemMutationCaller failures; this test pins the symmetric obligation for the
	// per-phase branch. Reason: `inactive-run` (the boundary unit reused for "agent's run no longer
	// has a live resolvable item/chain/preset" per the review's required-changes block).

	test("daemon allows review-phase agent to write declared passthrough fields branch + pr + extra blocker keys (#410 row 2)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-row2-allow`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 5_500))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, 5))
}
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 6_000,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "410-row2-allow-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "410200",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			}))).item)
			const itemId = numberValue(added.id)
			expect(itemId).toBeGreaterThan(0)

			// Wait for the review credential — the scheduler advances iteration → review on the
			// next tick after iteration writes in_progress.
			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)

			// Allow #1: branch + pr declared in preset.review.writableFields → admit, write lands.
			const allowed = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { branch: "feat/issue-410", pr: 1042 } },
				agentCredential: reviewCredential,
			})))
			const updatedA = record(allowed.item)
			const updatedAExtra = record(updatedA.extra)
			expect(updatedAExtra.branch).toBe("feat/issue-410")
			expect(numberValue(updatedAExtra.pr)).toBe(1042)

			// Allow #2: extraPatch with blockerRepo + blockerRef inner keys — both declared in
			// writableFields → admit. The merge preserves any prior extra contents.
			const allowedExtra = expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { blockerRepo: "mouriya-s-lab/other", blockerRef: "#999" } },
				agentCredential: reviewCredential,
			})))
			const updatedB = record(allowedExtra.item)
			const extra = record(updatedB.extra)
			expect(extra.blockerRepo).toBe("mouriya-s-lab/other")
			expect(extra.blockerRef).toBe("#999")

			// Audit replay: both calls emitted item.update.field_write_admission allow events with
			// reason=agent-allowed, claimedPhase=review, presetName=gh-issue-pr-iteration, the
			// declared field set in `grantedFields`, and an empty deniedFields list.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const reviewAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.claimedPhase === "review",
			)
			expect(reviewAllows.length).toBeGreaterThanOrEqual(2)
			const allowBranchPr = reviewAllows.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.grantedFields.includes("branch")
				&& event.payload.grantedFields.includes("pr"),
			)
			expect(allowBranchPr).toBeDefined()
			if (allowBranchPr !== undefined && allowBranchPr.kind === "audit" && allowBranchPr.type === "item.update.field_write_admission") {
				expect(allowBranchPr.payload.reason).toBe("agent-allowed")
				expect(allowBranchPr.payload.deniedFields).toEqual([])
				expect(allowBranchPr.payload.presetName).toBe("gh-issue-pr-iteration")
			}
			const allowBlocker = reviewAllows.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.grantedFields.includes("blockerRepo")
				&& event.payload.grantedFields.includes("blockerRef"),
			)
			expect(allowBlocker).toBeDefined()
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #410 acceptance row #1 — control-plane fields (`runner` / `repoCwd` / `dependsOn` /
	// `priority`) cannot be granted by any preset and the review agent (the only phase with a
	// rights segment) is rejected when it tries to write them. The audit event carries
	// reason=control-plane-denied. Also covers the undeclared-passthrough case (`title` is a
	// passthrough field but NOT in review's writableFields) → reason=field-not-granted.

	test("daemon denies review-phase agent on control-plane fields and undeclared passthrough (#410 row 1)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-row1-deny`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { writeFile, appendFile } from "node:fs/promises"
const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt.split("\\n")[0] ?? prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
if (input.phase === "review") {
	await writeFile(${JSON.stringify(reviewCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	await new Promise((r) => setTimeout(r, input.sleepMs ?? 6_000))
} else {
	await writeFile(${JSON.stringify(iterationCapture)}, process.env.CODER_LOOP_RUN_CRED ?? "")
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
	await new Promise((r) => setTimeout(r, 5))
}
process.exitCode = 0
`,
		)
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: Number(item.itemId),
					runId,
					phase,
					eventLog,
					sleepMs: 6_500,
					writeStatus: phase === "iteration" ? "in_progress" : null,
				}),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "410-row1-deny-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "410100",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			}))).item)
			const itemId = numberValue(added.id)
			const protectedHook = { kind: "observer", point: "agent.spawn", script: "/bin/true", timeoutMs: 1_000 }
			expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { hooks: [protectedHook] } },
			})))

			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			expect(reviewCredential.length).toBeGreaterThan(0)

			// Deny #1: control-plane field `runner` (top-level) — no preset can grant.
			const denyRunner = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { runner: "codex" },
				agentCredential: reviewCredential,
			}))
			expect(denyRunner.ok).toBe(false)
			if (!denyRunner.ok) {
				expect(denyRunner.error.code).toBe("invalid_caller")
				expect(denyRunner.error.message).toContain("runner")
				expect(denyRunner.error.message).toContain("review")
				expect(denyRunner.error.message).toContain("control-plane-denied")
			}

			// Deny #2: control-plane field `repoCwd` (top-level).
			const denyRepoCwd = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { repoCwd: REPO_ROOT },
				agentCredential: reviewCredential,
			}))
			expect(denyRepoCwd.ok).toBe(false)
			if (!denyRepoCwd.ok) {
				expect(denyRepoCwd.error.message).toContain("repoCwd")
			}

			// Deny #3: control-plane field `dependsOn` (top-level).
			const denyDependsOn = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { dependsOn: [] },
				agentCredential: reviewCredential,
			}))
			expect(denyDependsOn.ok).toBe(false)
			if (!denyDependsOn.ok) {
				expect(denyDependsOn.error.message).toContain("dependsOn")
			}

			// Deny #4: control-plane field `priority` (top-level).
			const denyPriority = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { priority: "high" },
				agentCredential: reviewCredential,
			}))
			expect(denyPriority.ok).toBe(false)
			if (!denyPriority.ok) {
				expect(denyPriority.error.message).toContain("priority")
			}

			// Deny #5: `dependsOn` smuggled through `extra` — gate normalizes it to control-plane.
			const denyExtraDependsOn = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extra: { dependsOn: [] } },
				agentCredential: reviewCredential,
			}))
			expect(denyExtraDependsOn.ok).toBe(false)
			if (!denyExtraDependsOn.ok) {
				expect(denyExtraDependsOn.error.message).toContain("dependsOn")
				expect(denyExtraDependsOn.error.message).toContain("control-plane-denied")
			}

			// Deny #6: passthrough field `title` is NOT in review's writableFields → field-not-granted.
			const denyTitle = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { title: "should be denied" },
				agentCredential: reviewCredential,
			}))
			expect(denyTitle.ok).toBe(false)
			if (!denyTitle.ok) {
				expect(denyTitle.error.message).toContain("title")
				expect(denyTitle.error.message).toContain("field-not-granted")
			}

			// Deny #7: undeclared extra inner key → field-not-granted.
			const denyExtraKey = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", {
				itemId,
				fields: { extraPatch: { madeUpKey: "x" } },
				agentCredential: reviewCredential,
			}))
			expect(denyExtraKey.ok).toBe(false)
			if (!denyExtraKey.ok) {
				expect(denyExtraKey.error.message).toContain("madeUpKey")
				expect(denyExtraKey.error.message).toContain("field-not-granted")
			}

			for (const fields of [
				{ extra: { hooks: [] } },
				{ extraPatch: { hooks: [] } },
				{ extraPatch: { hooks: null } },
				{ extra: { branch: "allowed/without-protected-hooks" } },
			]) {
				const deniedHooks = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.update", { itemId, fields, agentCredential: reviewCredential }))
				expect(deniedHooks.ok).toBe(false)
				if (!deniedHooks.ok) {
					expect(deniedHooks.error.message).toContain("hooks")
					expect(deniedHooks.error.message).toContain("control-plane-denied")
				}
			}

			// Audit replay: one deny event per attempt. Spot-check control-plane and undeclared.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const denies = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "deny",
			)
			expect(denies.length).toBeGreaterThanOrEqual(11)
			expect(denies.filter((event) => event.kind === "audit" && event.type === "item.update.field_write_admission" && event.payload.deniedFields.includes("hooks"))).toHaveLength(5)
			const controlPlaneRunner = denies.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.reason === "control-plane-denied"
				&& event.payload.deniedFields.includes("runner"),
			)
			expect(controlPlaneRunner).toBeDefined()
			if (controlPlaneRunner !== undefined && controlPlaneRunner.kind === "audit" && controlPlaneRunner.type === "item.update.field_write_admission") {
				expect(controlPlaneRunner.payload.claimedPhase).toBe("review")
				expect(controlPlaneRunner.payload.presetName).toBe("gh-issue-pr-iteration")
				expect(controlPlaneRunner.subject).toMatchObject({ kind: "agent" })
			}
			const titleDeny = denies.find((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.payload.reason === "field-not-granted"
				&& event.payload.deniedFields.includes("title"),
			)
			expect(titleDeny).toBeDefined()
			// Store state untouched on the denied paths: branch/pr (preset-declared transparent
			// fields after #419) and the rest of extra all default.
			const stillQueued = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.list", { chainId }))))
			const itemsList = Array.isArray(stillQueued.items) ? stillQueued.items : []
			expect(itemsList.length).toBe(1)
			const stillRecord = record(itemsList[0])
			// #419: `branch` / `pr` are no longer top-level wire fields. After denial they must
			// still be absent from the `extra` carrier where presets declare them.
			const stillExtra = record(stillRecord.extra)
			expect(stillExtra.hooks).toEqual([protectedHook])
			expect(stillExtra.branch).toBeUndefined()
			expect(stillExtra.pr).toBeUndefined()
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #410 acceptance row #3 — operators bypass the gate entirely. The fixture writes every kind
	// of field (control-plane + passthrough + extra inner keys) via the no-credential operator
	// path; every call succeeds and the audit trail records each as outcome=allow / reason=operator.

	test("daemon allows operator path to write every item.update field (#410 row 3)", async () => {
		const fixture = await startFixture("410-row3-operator-bypass", { schedulerEnabled: false })
		try {
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "410-row3-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(created.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "410300",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const itemId = numberValue(added.id)
			// Operator can write each control-plane field without a credential — no gate hits.
			expectOk(await request(fixture, "item.update", { itemId, runner: "codex" }))
			expectOk(await request(fixture, "item.update", { itemId, repoCwd: REPO_ROOT }))
			expectOk(await request(fixture, "item.update", { itemId, priority: "high" }))
			// Passthrough fields work too — including ones not in any preset's writableFields.
			expectOk(await request(fixture, "item.update", { itemId, title: "operator-set title" }))
			expectOk(await request(fixture, "item.update", { itemId, extraPatch: { branch: "operator/branch" } }))
			expectOk(await request(fixture, "item.update", { itemId, extraPatch: { pr: 7 } }))
			// Extra payloads with arbitrary inner keys.
			const finalUpdate = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { blockerRepo: "owner/dep", blockerRef: "#1", arbitrary: "key" },
			})).item)
			const extra = record(finalUpdate.extra)
			expect(extra.blockerRepo).toBe("owner/dep")
			expect(extra.arbitrary).toBe("key")
			const explicitNull = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { arbitrary: null },
			})).item)
			const explicitNullExtra = record(explicitNull.extra)
			expect(Object.hasOwn(explicitNullExtra, "arbitrary")).toBe(true)
			expect(explicitNullExtra.arbitrary).toBeNull()
			const reservedKeyPatch = await request(fixture, "item.update", {
				itemId,
				extraPatch: JSON.parse(`{"__proto__":null}`),
			})
			expectInvalid(reservedKeyPatch)
			if (!reservedKeyPatch.ok) {
				expect(reservedKeyPatch.error.message).toBe("extra key not allowed: __proto__")
				expect(record(reservedKeyPatch.error.details).field).toBe("extra.__proto__")
			}
			const hook = { kind: "observer", point: "agent.spawn", script: "/bin/true", timeoutMs: 1000 }
			const replaced = record(expectOk(await request(fixture, "item.update", { itemId, extra: { hooks: [hook] } })).item)
			expect(record(replaced.extra).hooks).toEqual([hook])
			const replacementWithOmittedHooks = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extra: { branch: "operator/replacement" },
			})).item)
			expect(record(replacementWithOmittedHooks.extra)).toMatchObject({ branch: "operator/replacement", hooks: [hook] })
			const replacementWithExplicitHookClear = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extra: { branch: "operator/cleared", hooks: null },
			})).item)
			expect(record(replacementWithExplicitHookClear.extra)).toEqual({ branch: "operator/cleared" })
			const patched = record(expectOk(await request(fixture, "item.update", { itemId, extraPatch: { hooks: [hook] } })).item)
			expect(record(patched.extra).hooks).toEqual([hook])
			const cleared = record(expectOk(await request(fixture, "item.update", { itemId, extraPatch: { hooks: null } })).item)
			expect(record(cleared.extra).hooks).toBeUndefined()

			// Audit replay: every item.update emitted one field_write_admission allow with
			// reason=operator. The subject is operator on every event.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "item.update.field_write_admission"
				&& event.item === itemId
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			expect(operatorAllows.length).toBeGreaterThanOrEqual(12)
			for (const event of operatorAllows) {
				if (event.kind === "audit" && event.type === "item.update.field_write_admission") {
					expect(event.subject).toEqual({ kind: "operator" })
					expect(event.payload.claimedPhase).toBeNull()
					expect(event.payload.presetName).toBeNull()
					expect(event.payload.deniedFields).toEqual([])
				}
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #410 preset-parser side — declaring a control-plane field in `writableFields` fails preset
	// load with a clear error naming the engine's control-plane vocabulary. Loaded via item-level
	// `presetPath` (the per-item preset declaration site since #412) so the parse failure
	// surfaces through the normal item.add load chain.

	test("preset load rejects control-plane field in [phases.rights] writableFields (#410 parse-side)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-410-preset-parse-control-plane`)
		const presetDir = resolve(root, "broken-preset")
		await mkdir(presetDir, { recursive: true })
		await writeFile(resolve(presetDir, "preset.toml"), `name = "broken-control-plane-grant"

[item]
idField = "issue"

[item.fields]

[statuses]
continuable = ["queued"]
terminal    = ["done"]
success     = ["done"]
entry       = "queued"
exhausted   = "done"

[[phases]]
name   = "iteration"
prompt = "iter.md"

  [phases.rights]
  writableFields = ["runner"]
`)
		await writeFile(resolve(presetDir, "iter.md"), "minimal entry\n")
		const fixture = await startFixture("410-preset-parse-control-plane", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "410-broken-grant-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			// Loading the broken preset via the per-item path surfaces the parse failure.
			const reply = await request(fixture, "item.add", {
				chainId,
				itemId: "410400",
				repoCwd: REPO_ROOT,
				presetPath: presetDir,
			})
			expect(reply.ok).toBe(false)
			if (!reply.ok) {
				expect(reply.error.message).toContain("writableFields")
				expect(reply.error.message).toContain("runner")
				expect(reply.error.message).toContain("control-plane")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})
})
