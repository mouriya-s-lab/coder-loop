import { FAKE_RUNNER_STATUS_WRITE_SNIPPET, REPO_ROOT, TEST_ROOT, assertNeverQueueUnblockOutcomeScenario, chainBindings, daemonRequest, describe, expect, expectConflict, expectInvalid, expectInvalidDetails, expectOk, expectTooLarge, initGitTarget, itemExtraToJsonObject, mkdir, nestedMetadata, numberValue, openSqliteStateStore, queryObservabilityEvents, readFile, readItem, record, request, resolve, resolveChainRuntimePaths, resolveLoopDataPaths, runtimeStatus, sendDaemonRequest, staleRecoveryRunExtra, startCoderLoopDaemon, startFixture, startQueueUnblockGateFixture, storedChainMetadata, storedItemExtra, stringValue, test, waitFor, waitForItemQueueTerminal, writeCredentialedFixturePreset, writeFile, writePromptCaptureRunner, writeSinglePhasePromptPreset } from "./harness"
import type { BoundaryRecord, JsonObject, QueueUnblockOutcomeScenario, SchedulerWorktreeManager } from "./harness"
let nextFixtureId = 0

describe("daemon", () => {
	test("socket item CRUD", async () => {
		const fixture = await startFixture("item-crud", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "crud-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
				title: "feat: 单进程 daemon",
				extra: { sleepMs: 5 },
			})).item)
			expect(added).toMatchObject({ itemId: "180", status: runtimeStatus("queued"), title: "feat: 单进程 daemon" })

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: runtimeStatus("done"), title: "updated daemon item", extraPatch: { pr: 190 } },
			})).item)
			expect(updated).toMatchObject({ status: runtimeStatus("done"), title: "updated daemon item", extra: expect.objectContaining({ pr: 190 }) })
		} finally {
			await fixture.daemon.stop()
		}
	})


	// #412 retry: itemToJson must surface per-item preset / presetPath so `item list --json` is
	// consistent with `coder-loop status --json` `queue.selected.preset.*` exposure. Supervisors
	// reading `item list` need to know each item's preset to drive routing decisions; pre-fix the
	// view omitted both fields.

	test("socket item list exposes per-item preset and presetPath (post-#412)", async () => {
		const fixture = await startFixture("item-list-preset-exposure", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "item-list-preset-exposure-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const presetPathDir = resolve(REPO_ROOT, "presets/single-phase-example")
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "41280",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			}))
			expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "41281",
				repoCwd: REPO_ROOT,
				presetPath: presetPathDir,
			}))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(listed)) throw new Error("expected item.list items array")
			expect(listed).toHaveLength(2)
			const bundled = listed.map(record).find((item) => item.itemId === "41280")
			const pathItem = listed.map(record).find((item) => item.itemId === "41281")
			if (bundled === undefined || pathItem === undefined) throw new Error("expected both items in list")
			expect(bundled).toMatchObject({ preset: "gh-issue-pr-iteration", presetPath: null })
			expect(pathItem).toMatchObject({ preset: null, presetPath: presetPathDir })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item batch add short-circuits on invalid input without partial write", async () => {
		const fixture = await startFixture("item-batch-add-invalid-input", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "batch-invalid-input-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const failed = await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25811", repoCwd: REPO_ROOT, title: "valid before invalid" },
					{ itemId: "", repoCwd: REPO_ROOT, title: "invalid issue" },
					{ itemId: "25813", repoCwd: REPO_ROOT, title: "valid after invalid" },
				],
			})
			expectInvalid(failed)

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)

			const added = expectOk(await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25821", repoCwd: REPO_ROOT, title: "valid one" },
					{ itemId: "25822", repoCwd: REPO_ROOT, title: "valid two" },
					{ itemId: "25823", repoCwd: REPO_ROOT, title: "valid three" },
				],
			})).items
			expect(Array.isArray(added)).toBe(true)
			expect(added).toHaveLength(3)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item batch add rejects conflict with existing item without partial write", async () => {
		const fixture = await startFixture("item-batch-add-conflict", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "batch-conflict-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "25901", repoCwd: REPO_ROOT, title: "occupant" }))
			const baseline = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(baseline).toHaveLength(1)

			const failed = await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "25902", repoCwd: REPO_ROOT, title: "would-be first" },
					{ itemId: "25901", repoCwd: REPO_ROOT, title: "conflict with occupant" },
					{ itemId: "25903", repoCwd: REPO_ROOT, title: "would-be third" },
				],
			})
			expectConflict(failed)

			const after = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(after.map((item) => Number(item.itemId))).toEqual([25901])
			expect(after.map((item) => item.id)).toEqual(baseline.map((item) => item.id))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects duplicate issue as conflict without SQL details", async () => {
		const fixture = await startFixture("item-add-duplicate", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "duplicate-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const first = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "242",
				repoCwd: REPO_ROOT,
			})).item)

			const duplicate = await request(fixture, "item.add", {
				chainId,
				itemId: "242",
				repoCwd: REPO_ROOT,
			})
			expectConflict(duplicate)
			if (duplicate.ok) throw new Error("expected duplicate item.add to fail")
			expect(duplicate.error.message).toBe("item with id 242 already exists in chain duplicate-item-chain")
			expect(JSON.stringify(duplicate.error)).not.toContain("UNIQUE constraint")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.chain_id")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.issue_number")
			expect(record(duplicate.error.details)).toMatchObject({
				chainId,
				chainName: "duplicate-item-chain",
				itemId: "242",
				existingItemId: numberValue(first.id),
			})

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(listed)) throw new Error("expected item.list items array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({ id: numberValue(first.id), itemId: "242" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects invalid issue and repo fields before db insert", async () => {
		const fixture = await startFixture("item-add-validation", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "validation-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const invalidRequests = [
				{ itemId: "", repoCwd: REPO_ROOT },
				{ itemId: "bad with space", repoCwd: REPO_ROOT },
				{ itemId: "181", repoCwd: "relative/path" },
				{ itemId: "182", repoCwd: resolve(REPO_ROOT, "missing-coder-loop-test-dir") },
				{ itemId: "183", repoCwd: `${REPO_ROOT}\nchild` },
				{ itemId: "184", repoCwd: `${REPO_ROOT}\u0000child` },
			]

			for (const args of invalidRequests) {
				expectInvalid(await request(fixture, "item.add", { chainId, ...args }))
			}

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add rejects daemon-owned, unsafe, and unknown fields before db insert", async () => {
		const fixture = await startFixture("item-add-strict-fields", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "strict-add-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const chainPaths = resolveChainRuntimePaths("strict-add-chain", { loopDataRoot: fixture.loopDataRoot })
			const absoluteEvidenceDir = resolve(chainPaths.chainRoot, "evidence/custom-246")

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "246",
				repoCwd: REPO_ROOT,
				title: "strict add item",
				priority: "high",
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				runner: "codex",
				extra: { note: "allowed", branch: "feature/issue-246", pr: 254 },
			})).item)
			expect(added).toMatchObject({
				itemId: "246",
				status: runtimeStatus("queued"),
				attempts: 0,
				priority: "high",
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				lastRunId: null,
				agentCwd: null,
				runner: "codex",
				extra: expect.objectContaining({ note: "allowed", branch: "feature/issue-246", pr: 254 }),
			})

			const invalidRequests = [
				{ itemId: "601", repoCwd: REPO_ROOT, status: runtimeStatus("done") },
				{ itemId: "602", repoCwd: REPO_ROOT, attempts: 999 },
				{ itemId: "603", repoCwd: REPO_ROOT, lastRunId: "hacked" },
				{ itemId: "604", repoCwd: REPO_ROOT, agentCwd: "/etc/passwd" },
				{ itemId: "605", repoCwd: REPO_ROOT, id: 1 },
				{ itemId: "606", repoCwd: REPO_ROOT, createdAt: 1 },
				{ itemId: "607", repoCwd: REPO_ROOT, updatedAt: 1 },
				{ itemId: "608", repoCwd: REPO_ROOT, branch: "../../etc/passwd" },
				{ itemId: "609", repoCwd: REPO_ROOT, issueFile: "../../etc/passwd" },
				{ itemId: "610", repoCwd: REPO_ROOT, evidenceDir: "/etc/coder-loop-evidence" },
				{ itemId: "611", repoCwd: REPO_ROOT, random_field: "hack" },
				{ itemId: "612", repoCwd: REPO_ROOT, title: "bad\nline" },
				{ itemId: "613", repoCwd: REPO_ROOT, priority: "garbage-xyz" },
				{ itemId: "614", repoCwd: REPO_ROOT, priority: 999 },
				{ itemId: "615", repoCwd: REPO_ROOT, pr: -1 },
				{ itemId: "616", repoCwd: REPO_ROOT, extra: JSON.parse(`{"__proto__":{"polluted":1}}`) },
				{ itemId: "617", repoCwd: REPO_ROOT, extra: { "": "empty-key" } },
				{ itemId: "618", repoCwd: REPO_ROOT, extra: nestedMetadata(9) },
			]
			for (const args of invalidRequests) expectInvalid(await request(fixture, "item.add", { chainId, ...args }))

			expectTooLarge(await request(fixture, "item.add", {
				chainId,
				itemId: "619",
				repoCwd: REPO_ROOT,
				extra: { k: "x".repeat(17 * 1024) },
			}))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(Array.isArray(listed) ? listed[0] : null)).toMatchObject({ itemId: "246" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.add acks before scheduler side effects finish", async () => {
		const fixture = await startFixture("item-add-async-scheduler", {
			schedulerIntervalMs: 50,
			worktreeManager: async () => {
				throw new Error("synthetic scheduler failure")
			},
		})
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "async-add-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "185",
				repoCwd: REPO_ROOT,
			})).item)

			expect(added).toMatchObject({ itemId: "185", status: runtimeStatus("queued"), repoCwd: REPO_ROOT })
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 185), (item) => item?.status === "queued")
			await new Promise((resolveWait) => setTimeout(resolveWait, 120))
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update validates status and dependency graph", async () => {
		const fixture = await startFixture("item-update-validation", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "dependency-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const first = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "186", repoCwd: REPO_ROOT })).item)
			const second = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "187", repoCwd: REPO_ROOT })).item)
			const firstId = numberValue(first.id)
			const secondId = numberValue(second.id)

			expectInvalid(await request(fixture, "item.update", { itemId: firstId, status: "garbage_state" }))
			expectInvalid(await request(fixture, "item.update", { itemId: firstId, dependsOn: [firstId] }))

			const updatedFirst = record(expectOk(await request(fixture, "item.update", { itemId: firstId, dependsOn: [secondId] })).item)
			expect(record(updatedFirst.extra).dependsOn).toEqual([secondId])

			expectInvalid(await request(fixture, "item.update", { itemId: secondId, dependsOn: [firstId] }))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon validates item statuses from config-json presetPath metadata", async () => {
		const fixture = await startFixture("custom-preset-status-validation", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "custom-status-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
			await writeFile(resolve(presetPath, "preset.toml"), `name = "custom-status-fixture"

[item]
idField = "issue"

[routing]
continuable = ["queued", "needs_work"]
terminal = ["custom_done"]
entry = "queued"
success = ["custom_done"]
exhausted = "custom_done"

[[steps]]
name = "run"
prompt = "run.md"

  # #408: minimal leaving edge so R2 (deadlock-continuable) passes for the
  # fixture. The status-validation test surface is unchanged; "run → custom_done"
  # only matters to the new checker, not to this test's assertions.
  [[steps.handoffs]]
  status = "custom_done"
  when = "Run finished and the item reached the success-terminal vocabulary."

  [steps.values]
  ISSUE = "item.issue"

[agent]
attemptTimeoutSeconds = 3600
`)

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "custom-preset-chain",
				repository: "mouriya-s-lab/coder-loop",
				// #433: presetPath now lives at metadata.bindings.presetPath (the retired
				// metadata.config wrapper is gone).
				metadata: { bindings: { presetPath } },
			})).chain)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId: numberValue(chain.id),
				itemId: "45401",
				repoCwd: REPO_ROOT,
			})).item)
			expect(added.status).toBe("queued")

			const rejected = await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "not_in_custom_preset",
			})
			expect(rejected.ok).toBe(false)
			if (!rejected.ok) {
				expect(rejected.error.code).toBe("invalid_request")
				expect(rejected.error.message).toContain("custom_done")
				expect(rejected.error.message).toContain("needs_work")
			}

			const accepted = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "custom_done",
			})).item)
			expect(accepted.status).toBe("custom_done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon reports custom presetPath load failures to each chain mutation request", async () => {
		const fixture = await startFixture("custom-preset-load-failure", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "bad-status-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "preset.toml"), "name = [broken\n")

			const firstChain = record(expectOk(await request(fixture, "chain.create", {
				name: "bad-custom-preset-chain-a",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const secondChain = record(expectOk(await request(fixture, "chain.create", {
				name: "bad-custom-preset-chain-b",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)

			// #412: presetPath now lives on the item, not on chain.metadata.config. Both items declare
			// the same broken presetPath to verify chain-mutation load-failure reporting is per-request
			// (each chain gets its own failure event) and the bad path is surfaced verbatim.
			const [firstResponse, secondResponse] = await Promise.all([
				request(fixture, "item.add", {
					chainId: numberValue(firstChain.id),
					itemId: "45402",
					repoCwd: REPO_ROOT,
					presetPath,
				}),
				request(fixture, "item.add", {
					chainId: numberValue(secondChain.id),
					itemId: "45403",
					repoCwd: REPO_ROOT,
					presetPath,
				}),
			])
			for (const [response, chain] of [[firstResponse, firstChain], [secondResponse, secondChain]] as const) {
				expect(response.ok).toBe(false)
				if (!response.ok) {
					expect(response.error.code).toBe("invalid_request")
					expect(response.error.message).toContain(`failed to load preset for chain ${chain.name}`)
					expect(response.error.details).toMatchObject({ chainId: numberValue(chain.id), presetDir: presetPath })
				}
			}
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, { type: "daemon.preset_load_failed" })
			const firstEvent = events.events.find((event) => event.chain === firstChain.name)
			const secondEvent = events.events.find((event) => event.chain === secondChain.name)
			expect(firstEvent?.type).toBe("daemon.preset_load_failed")
			expect(secondEvent?.type).toBe("daemon.preset_load_failed")
			if (firstEvent?.type !== "daemon.preset_load_failed" || secondEvent?.type !== "daemon.preset_load_failed") {
				throw new Error("expected daemon.preset_load_failed events for both chains")
			}
			// #403: event kind migrated from `lifecycle` to `validation` — preset-resolution refusal is
			// a per-operation validation event, not a daemon lifecycle transition.
			expect(firstEvent.kind).toBe("validation")
			expect(secondEvent.kind).toBe("validation")
			expect(firstEvent.payload).toMatchObject({
				chainId: numberValue(firstChain.id),
				preset: "gh-issue-pr-iteration",
				presetDir: presetPath,
				// #403: every refusal carries the refused operation name. `item.add` triggers
				// `defaultItemStatusForPresetSpecOnChain`, which the daemon records as
				// `item.create.default-status`.
				operation: "item.create.default-status",
			})
			expect(secondEvent.payload).toMatchObject({
				chainId: numberValue(secondChain.id),
				preset: "gh-issue-pr-iteration",
				presetDir: presetPath,
				operation: "item.create.default-status",
			})
			expect(firstEvent.payload.error.length).toBeGreaterThan(0)
			expect(secondEvent.payload.error.length).toBeGreaterThan(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #403 log obligation. When the engine's fallback status vocabularies are removed, every
	// preset-resolution failure must surface as a *validation* event through the unified observability
	// stream, naming the refused operation (chain.status, scheduler.tick, item.exits, ...). This test
	// drives `chain.status` against a chain whose `metadata.presetPath` points to a broken preset.toml
	// and asserts (1) the request fails with a precise error naming chain/operation/presetDir, and (2)
	// the emitted event is `kind: "validation"` with `payload.operation: "chain.status"`.

	test("daemon emits validation event naming chain.status when preset resolution refuses chain.status", async () => {
		const fixture = await startFixture("preset-load-failure-chain-status", { schedulerEnabled: false })
		try {
			const presetPath = resolve(fixture.loopDataRoot, "..", "bad-status-preset-chain-status")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "preset.toml"), "this is not toml { ][\n")

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "validation-event-chain-status",
				repository: "mouriya-s-lab/coder-loop",
				// `chain.metadata.presetPath` makes `canResolvePresetForChainOrItems` return true even
				// when no items exist, so `chain.status` will try to load and fail on the broken
				// preset.toml.
				metadata: { presetPath },
			})).chain)

			const statusResponse = await request(fixture, "chain.status", { chainId: numberValue(chain.id) })
			expect(statusResponse.ok).toBe(false)
			if (!statusResponse.ok) {
				expect(statusResponse.error.code).toBe("invalid_request")
				expect(statusResponse.error.message).toContain(`failed to load preset for chain ${chain.name}`)
				expect(statusResponse.error.message).toContain("operation chain.status")
				expect(statusResponse.error.message).toContain(presetPath)
				expect(statusResponse.error.details).toMatchObject({
					chainId: numberValue(chain.id),
					chainName: chain.name,
					presetDir: presetPath,
					operation: "chain.status",
				})
			}

			const events = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "daemon.preset_load_failed" },
			)
			const event = events.events.find((entry) =>
				entry.chain === chain.name && entry.type === "daemon.preset_load_failed" && entry.payload.operation === "chain.status"
			)
			if (event === undefined || event.type !== "daemon.preset_load_failed") {
				throw new Error("expected a daemon.preset_load_failed event for chain.status on this chain")
			}
			expect(event.kind).toBe("validation")
			expect(event.payload).toMatchObject({
				chainId: numberValue(chain.id),
				presetDir: presetPath,
				operation: "chain.status",
			})
			expect(event.payload.error.length).toBeGreaterThan(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #408: cross-table DAG findings (deadlock-continuable error AND
	// dead-vocabulary warn) must surface on the unified observability stream as
	// `preset.dag_check` validation events. The error verdict triggers the
	// existing `daemon.preset_load_failed` path; both event types must land,
	// with the DAG-check finding emitted BEFORE the generic load-failure event
	// so an auditor sees the structural cause first.

	test("daemon emits preset.dag_check validation events for cross-table DAG findings (issue #408)", async () => {
		const fixture = await startFixture("preset-dag-check-daemon", { schedulerEnabled: false })
		try {
			// Fixture preset: `pending` is continuable but no phase exit / engine
			// transition ever writes a status != pending (`run`'s only exit writes
			// `pending` itself). `dead_word` is continuable but no producer can
			// write it — the warn-verdict cause.
			const presetPath = resolve(fixture.loopDataRoot, "..", "broken-dag-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
			await writeFile(resolve(presetPath, "preset.toml"), `name = "broken-dag-fixture"

[item]
idField = "issue"

[routing]
continuable = ["queued", "pending", "dead_word"]
terminal    = ["done", "exhausted"]
entry       = "queued"
success     = ["done"]
exhausted   = "exhausted"

[[steps]]
name   = "run"
prompt = "run.md"

  # \`pending\` has no leaving edge (the only exit writes pending itself), so
  # R2 fires with deadlock-continuable on \`pending\`. \`dead_word\` is never
  # produced anywhere → R3 fires with dead-vocabulary as a warn.
  [[steps.handoffs]]
  status = "pending"
  when   = "Always re-asserts pending — the deadlock."

  [steps.values]
  ISSUE = "item.issue"

[agent]
attemptTimeoutSeconds = 3600
`)

			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "broken-dag-chain",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath },
			})).chain)

			// Drive a request that loads the preset. `chain.status` resolves the
			// chain-wide preset (metadata.presetPath set), so it goes through the
			// load path and rejects on the deadlock finding.
			const statusResponse = await request(fixture, "chain.status", { chainId: numberValue(chain.id) })
			expect(statusResponse.ok).toBe(false)
			if (!statusResponse.ok) {
				expect(statusResponse.error.code).toBe("invalid_request")
				expect(statusResponse.error.message).toContain(`failed to load preset for chain ${chain.name}`)
				expect(statusResponse.error.message).toContain("preset.routing.continuable")
				expect(statusResponse.error.message).toContain("has no leaving phase-exit edge")
				expect(statusResponse.error.message).toContain("pending")
			}

			// Validate the new event type's payload shape and content.
			const dagEvents = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "preset.dag_check" },
			)
			const chainDagEvents = dagEvents.events.filter((entry) => entry.chain === chain.name && entry.type === "preset.dag_check")
			expect(chainDagEvents.length).toBeGreaterThanOrEqual(2)
			const deadlockEvent = chainDagEvents.find((entry) => entry.type === "preset.dag_check" && entry.payload.kind === "deadlock-continuable")
			const deadVocabEvent = chainDagEvents.find((entry) => entry.type === "preset.dag_check" && entry.payload.kind === "dead-vocabulary")
			if (deadlockEvent === undefined || deadlockEvent.type !== "preset.dag_check") {
				throw new Error("expected a deadlock-continuable preset.dag_check event")
			}
			if (deadVocabEvent === undefined || deadVocabEvent.type !== "preset.dag_check") {
				throw new Error("expected a dead-vocabulary preset.dag_check event")
			}
			expect(deadlockEvent.kind).toBe("validation")
			expect(deadlockEvent.payload).toMatchObject({
				kind: "deadlock-continuable",
				verdict: "error",
				table: "statuses.continuable",
				status: "pending",
			})
			expect(deadlockEvent.payload.message.length).toBeGreaterThan(0)
			expect(deadVocabEvent.kind).toBe("validation")
			expect(deadVocabEvent.payload).toMatchObject({
				kind: "dead-vocabulary",
				verdict: "warn",
				table: "statuses.continuable",
				status: "dead_word",
			})

			// The error-finding path also emits the unified `daemon.preset_load_failed`
			// event so auditors can correlate "preset failed to load" against the
			// upstream structural finding. Ordering: every DAG-check event has a
			// timestamp <= the load-failed event's, since findings are recorded
			// before `recordPresetLoadFailure` runs.
			const loadFailedEvents = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "daemon.preset_load_failed" },
			)
			const chainLoadFailed = loadFailedEvents.events.find((entry) => entry.chain === chain.name)
			if (chainLoadFailed === undefined || chainLoadFailed.type !== "daemon.preset_load_failed") {
				throw new Error("expected a daemon.preset_load_failed event for the broken DAG chain")
			}
			expect(chainLoadFailed.kind).toBe("validation")
			expect(Date.parse(deadlockEvent.ts)).toBeLessThanOrEqual(Date.parse(chainLoadFailed.ts))
			expect(Date.parse(deadVocabEvent.ts)).toBeLessThanOrEqual(Date.parse(chainLoadFailed.ts))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon default scheduler prompt resolver consumes scheduler presetDir loaded preset", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-scheduler-preset-dir-prompt`)
		const loopDataRoot = root + "-loop-data"
		const presetDir = resolve(root, "override-preset")
		const runner = resolve(root, "capture-prompt-runner.ts")
		const promptCapture = resolve(root, "captured-prompt.txt")
		const repoCwd = resolve(root, "repo")
		await mkdir(root, { recursive: true })
		await initGitTarget(repoCwd)
		await writePromptCaptureRunner(runner, promptCapture)
		await writeSinglePhasePromptPreset(presetDir, "CUSTOM_SCHEDULER_PRESET_PROMPT")

		const worktreeManager: SchedulerWorktreeManager = async () => {
			return root
		}
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				presetDir,
				runner: {
					kind: "claude",
					source: "iteration-default",
					binary: "bun",
					extraArgs: [runner],
					model: null,
				},
				worktreeManager,
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const socketPath = daemon.snapshot().socketPath
			const fixture = {
				daemon,
				loopDataRoot,
				socketPath,
				pidFile: daemon.snapshot().pidFile,
				eventLog: resolve(root, "events.jsonl"),
				schedulerEvents: [],
			}
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-preset-dir-prompt-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			await request(fixture, "item.add", {
				chainId: numberValue(chain.id),
				itemId: "45403",
				repoCwd,
			})

			const prompt = await waitFor(
				async () => {
					try {
						return await readFile(promptCapture, "utf-8")
					} catch {
						return ""
					}
				},
				(value) => value.includes("CUSTOM_SCHEDULER_PRESET_PROMPT"),
				5_000,
			)
			expect(prompt).toContain("CUSTOM_SCHEDULER_PRESET_PROMPT")
			expect(prompt).not.toContain("Step task: implement")
		} finally {
			await daemon.stop()
		}
	})

	test("socket item.update writes typed blocker fields into extra without disturbing other keys", async () => {
		const fixture = await startFixture("item-update-blocker", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "blocker-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const anchor = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "500", repoCwd: REPO_ROOT })).item)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "501",
				repoCwd: REPO_ROOT,
				dependsOn: [numberValue(anchor.id)],
			})).item)
			const itemId = numberValue(item.id)

			// #457: blocker fields are no longer first-class engine flags. The preset writes them
			// through the generic `extraPatch` channel as preset-owned string keys. The legacy
			// `blockerRepo` / `blockerRef` / `clearBlocker` top-level args are rejected at the
			// strict-args gate.
			const blocked = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("blocked"),
				extraPatch: { blockerRepo: "mouriya-s-lab/other", blockerRef: "#267" },
			})).item)
			expect(record(blocked.extra)).toMatchObject({ blockerRepo: "mouriya-s-lab/other", blockerRef: "#267", dependsOn: [numberValue(anchor.id)] })
			expect(blocked.status).toBe("blocked")
			expect(blocked.agentCwd).toBeNull()

			// To drop preset-owned blocker keys the agent rebuilds the full `extra` without them
			// (the engine no longer has a "clear blocker" first-class op). dependsOn must be
			// preserved by the agent in its rebuilt extra.
			const cleared = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("changes_requested"),
				extra: { dependsOn: [numberValue(anchor.id)] },
			})).item)
			expect(record(cleared.extra)).not.toHaveProperty("blockerRepo")
			expect(record(cleared.extra)).not.toHaveProperty("blockerRef")
			expect(record(cleared.extra).dependsOn).toEqual([numberValue(anchor.id)])

			// agentCwd remains daemon-owned: it cannot be set through item.update.
			expectInvalid(await request(fixture, "item.update", { itemId, fields: { agentCwd: "/abs/elsewhere" } }))
			// #457: legacy first-class blocker mutation args are rejected at the strict-args gate.
			expectInvalid(await request(fixture, "item.update", { itemId, blockerRepo: "mouriya-s-lab/other" }))
			expectInvalid(await request(fixture, "item.update", { itemId, blockerRef: "#9" }))
			expectInvalid(await request(fixture, "item.update", { itemId, clearBlocker: true }))
			expectInvalidDetails(
				await request(fixture, "item.update", { itemId, extraPatch: { schedulerBackoff: { failureCount: "bad", nextRunAt: 1_800_000_000 } } }),
				"extra.schedulerBackoff.failureCount",
				"bad",
			)
			const legalExtra = record(expectOk(await request(fixture, "item.update", {
				itemId,
				extraPatch: { schedulerBackoff: { failureCount: 1, nextRunAt: 1_800_000_000 } },
			})).item)
			expect(record(legalExtra.extra).schedulerBackoff).toEqual({ failureCount: 1, nextRunAt: 1_800_000_000 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon loads legacy-shaped metadata and item extra from existing SQLite data before scheduling", async () => {
		let seededItemId = 0
		const fixture = await startFixture("legacy-db-typed-runtime-data", {
			schedulerIntervalMs: 20,
			beforeStart: ({ loopDataRoot, defaultItemPresetPath }) => {
				if (defaultItemPresetPath === null) throw new Error("legacy scheduler fixture requires a credentialed preset")
				const store = openSqliteStateStore({ loopDataRoot, createIfMissing: true })
				try {
					const chain = store.createChain({
						name: "legacy-runtime-data-chain",
						preset: "gh-issue-pr-iteration",
						repository: "mouriya-s-lab/coder-loop",
						baseBranch: "main",
						metadata: storedChainMetadata({
							presetPath: defaultItemPresetPath,
							// #433: legacy `metadata.config` is retired; chain bindings now live at
							// `metadata.bindings`. parseChainMetadata raises an explicit error on the
							// retired key — that rejection is exercised in the metadata boundary tests
							// above (`metadata-config-array`, etc.).
							bindings: { workflowFile: "legacy-workflow.md" },
							maxItemAttempts: 3,
							coderLoopChainCompleteTrigger: { decision: "keep-active", fingerprint: "old-fingerprint", recordedAt: 1_800_000_000 },
						}),
					})
					const item = store.createItem({
						chainId: chain.id,
						itemId: "455",
						repoCwd: REPO_ROOT,
						status: runtimeStatus("queued"),
						preset: null,
						presetPath: defaultItemPresetPath,
						extra: storedItemExtra({
							slotKey: "legacy-slot",
							blockerRepo: "mouriya-s-lab/coder-loop",
							blockerRef: "#454",
							schedulerBackoff: { failureCount: 1, nextRunAt: 1 },
							summary: "PHASE DONE: issue=#455; reason=legacy db compatibility",
							writeStatus: "done",
						}),
					})
					seededItemId = item.id
				} finally {
					store.close()
				}
			},
		})
		try {
			const terminal = await waitForItemQueueTerminal(fixture, seededItemId, 10_000)
			expect(terminal.terminalStatus).toBe("done")
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot, createIfMissing: false })
			try {
				const chain = store.getChainByName("legacy-runtime-data-chain")
				if (chain === null) throw new Error("expected seeded chain")
				expect(chainBindings(chain.metadata)).toEqual({ workflowFile: "legacy-workflow.md" })
				expect(chain.metadata.maxItemAttempts).toBe(3)
				const item = store.getItem(seededItemId)
				if (item === null) throw new Error("expected seeded item")
				expect(item.status).toBe("done")
				// #457: blockerRepo / blockerRef are no longer engine-typed ItemExtra fields — they
				// round-trip through `runtimeRemainder` like any preset-owned key. The store JSON
				// view exposes them through `itemExtraToJsonObject`.
				const extraJson = itemExtraToJsonObject(item.extra)
				expect(extraJson.blockerRepo).toBe("mouriya-s-lab/coder-loop")
				expect(extraJson.blockerRef).toBe("#454")
				expect(item.extra.schedulerBackoff).toEqual({ failureCount: 1, nextRunAt: 1 })
			} finally {
				store.close()
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.reorder renumbers queue positions", async () => {
		const fixture = await startFixture("item-reorder", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "reorder-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const a = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "301", repoCwd: REPO_ROOT })).item)
			const b = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "302", repoCwd: REPO_ROOT })).item)
			const c = record(expectOk(await request(fixture, "item.add", { chainId, itemId: "303", repoCwd: REPO_ROOT })).item)

			const baseline = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(baseline.map((item) => Number(item.itemId))).toEqual([301, 302, 303])
			expect(baseline.map((item) => Number(item.position))).toEqual([0, 1, 2])

			const moved = expectOk(await request(fixture, "item.reorder", { itemId: numberValue(c.id), position: 0 })).items as BoundaryRecord[]
			expect(moved.map((item) => Number(item.itemId))).toEqual([303, 301, 302])
			expect(moved.map((item) => Number(item.position))).toEqual([0, 1, 2])

			const after = expectOk(await request(fixture, "item.list", { chainId })).items as BoundaryRecord[]
			expect(after.map((item) => Number(item.itemId))).toEqual([303, 301, 302])
			expect(after.map((item) => Number(item.position))).toEqual([0, 1, 2])

			expectInvalid(await request(fixture, "item.reorder", { itemId: numberValue(a.id), position: -1 }))
			expectInvalid(await request(fixture, "item.reorder", { itemId: numberValue(b.id), chainId, position: 0 }))

			const missing = await request(fixture, "item.reorder", { itemId: 999_999, position: 0 })
			expect(missing.ok).toBe(false)
			if (!missing.ok) {
				expect(missing.error.code).toBe("not_found")
				expect(missing.error.message).toContain("999999")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item status validation follows the item preset (post-#412)", async () => {
		const fixture = await startFixture("item-status-preset", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			// #412: item carries its own preset; chain.preset is no longer the source of truth.
			// The item explicitly declares the same preset as the chain to exercise status vocab.
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "188",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			})).item)
			expect(added).toMatchObject({ itemId: "188", status: "pending" })
			const pending = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "pending",
			})).item)
			expect(pending).toMatchObject({ itemId: "188", status: "pending" })

			expectInvalid(await request(fixture, "item.update", { itemId: numberValue(added.id), status: runtimeStatus("changes_requested") }))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update applies preset phase status write policy", async () => {
		const fixture = await startFixture("item-update-phase-status-policy", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "phase-policy-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const iterationItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34701",
				repoCwd: REPO_ROOT,
			})).item)
			const iterationItemId = numberValue(iterationItem.id)

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(iterationItemId, { phase: "iteration", updatedAt: 1_800_020_000 })
			} finally {
				store.close()
			}

			// #508: `in_progress` rejoined `[routing].continuable` so daemon recovery can leave
			// it untouched and the scheduler can re-pick interrupted items. Vocab gate now
			// admits it, so the rejection comes from the phase-exits gate (iteration declares
			// no `[[steps.handoffs]]`, so every status is denied here) — same shape as the other
			// vocab-valid statuses below.
			for (const status of ["in_progress", "changes_requested", "blocked", "moot", "done", "exhausted"]) {
				const rejected = await request(fixture, "item.update", { itemId: iterationItemId, status })
				expectInvalid(rejected)
				if (!rejected.ok) expect(rejected.error.details).toMatchObject({ phase: "iteration", status, allowed: [] })
			}
			expect((await readItem(fixture.loopDataRoot, chainId, 34701))?.phase).toBe("iteration")

			// #397: review write that exits the phase's declared exits set (queued is vocab-valid but
			// not in review's [[steps.handoffs]]) is rejected under default-deny.
			const reviewExitOutsideItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34715",
				repoCwd: REPO_ROOT,
			})).item)
			const reviewExitOutsideItemId = numberValue(reviewExitOutsideItem.id)
			const exitOutsideStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				exitOutsideStore.updateItem(reviewExitOutsideItemId, { phase: "review", updatedAt: 1_800_020_098 })
			} finally {
				exitOutsideStore.close()
			}
			const reviewExitOutsideRejected = await request(fixture, "item.update", { itemId: reviewExitOutsideItemId, status: "queued" })
			expectInvalid(reviewExitOutsideRejected)
			if (!reviewExitOutsideRejected.ok) {
				expect(reviewExitOutsideRejected.error.details).toMatchObject({
					phase: "review",
					status: "queued",
					allowed: ["blocked", "changes_requested", "done", "exhausted", "moot"],
				})
			}

			// #397: an unknown phase (not declared in the preset) is now rejected — pre-#397 this
			// case short-circuited to "allow" via `allowed === null`, the actual default-allow leak
			// the issue body anchors. Default-deny rejects any status write from an unknown phase.
			const unknownPhaseItem = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34716",
				repoCwd: REPO_ROOT,
			})).item)
			const unknownPhaseItemId = numberValue(unknownPhaseItem.id)
			const unknownPhaseStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				unknownPhaseStore.updateItem(unknownPhaseItemId, { phase: "some-undeclared-phase", updatedAt: 1_800_020_099 })
			} finally {
				unknownPhaseStore.close()
			}
			const unknownPhaseRejected = await request(fixture, "item.update", { itemId: unknownPhaseItemId, status: "done" })
			expectInvalid(unknownPhaseRejected)
			if (!unknownPhaseRejected.ok) {
				expect(unknownPhaseRejected.error.details).toMatchObject({
					phase: "some-undeclared-phase",
					status: "done",
					allowed: [],
				})
				expect(unknownPhaseRejected.error.message).toContain("not declared in the preset")
			}

			const reviewStatuses = ["changes_requested", "blocked", "moot", "done", "exhausted"]
			for (const [index, status] of reviewStatuses.entries()) {
				const reviewItem = record(expectOk(await request(fixture, "item.add", {
					chainId,
					itemId: String(34710 + index),
					repoCwd: REPO_ROOT,
				})).item)
				const reviewItemId = numberValue(reviewItem.id)
				const reviewStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
				try {
					reviewStore.updateItem(reviewItemId, { phase: "review", updatedAt: 1_800_020_100 + index })
				} finally {
					reviewStore.close()
				}
				const updated = record(expectOk(await request(fixture, "item.update", { itemId: reviewItemId, status })).item)
				expect(updated).toMatchObject({ id: reviewItemId, status })
				expect((await readItem(fixture.loopDataRoot, chainId, 34710 + index))?.phase).toBe("review")
			}

			// #397 log obligation (issue comment "log 义务"): every allow and deny outcome of the
			// per-phase admission gate emits an `item.status.write_admission` audit event carrying
			// the subject, item, phase, requested status, declared exits, outcome, and reason. Pull
			// the event stream and assert iteration-deny / review-deny-vocab / unknown-phase-deny /
			// review-allow shapes are all present.
			const { events: admissionEvents } = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "item.status.write_admission", chain: stringValue(chain.name) },
			)
			const denyEvents = admissionEvents.filter((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.outcome === "deny")
			const allowEvents = admissionEvents.filter((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.outcome === "allow")
			expect(denyEvents.length).toBeGreaterThanOrEqual(8) // 6 iteration + 1 review-queued + 1 unknown-phase
			expect(allowEvents.length).toBe(reviewStatuses.length) // every review write was allowed
			const iterationDeny = denyEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "iteration" && event.payload.requestedStatus === "done")
			expect(iterationDeny).toBeDefined()
			if (iterationDeny !== undefined && iterationDeny.kind === "audit" && iterationDeny.type === "item.status.write_admission") {
				expect(iterationDeny.payload.declaredExits).toEqual([])
				expect(iterationDeny.payload.reason).toBe("phase-exits")
			}
			const unknownDeny = denyEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "some-undeclared-phase")
			expect(unknownDeny).toBeDefined()
			if (unknownDeny !== undefined && unknownDeny.kind === "audit" && unknownDeny.type === "item.status.write_admission") {
				expect(unknownDeny.payload.declaredExits).toEqual([])
				expect(unknownDeny.payload.reason).toBe("phase-exits")
			}
			const reviewAllow = allowEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === "review" && event.payload.requestedStatus === "done")
			expect(reviewAllow).toBeDefined()
			if (reviewAllow !== undefined && reviewAllow.kind === "audit" && reviewAllow.type === "item.status.write_admission") {
				expect([...reviewAllow.payload.declaredExits].sort()).toEqual(["blocked", "changes_requested", "done", "exhausted", "moot"])
				expect(reviewAllow.payload.reason).toBe("admitted")
				// The subject envelope must carry "operator" since the request flowed without
				// `agentRunId`/`agentPhase` attribution (operator mid-run path).
				expect(reviewAllow.subject).toEqual({ kind: "operator" })
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.update with no active phase records no-phase-active admission audit", async () => {
		// #397 acceptance row 7: operator mid-run path. When the item carries phase=null (no active
		// run), the gate runs only the vocabulary leg and records a `no-phase-active` audit so the
		// operator-shortcut is auditable rather than silent.
		const fixture = await startFixture("item-update-no-phase-admission", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "no-phase-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "34801",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(item.id)
			// Item has phase=null after creation; the write below is the operator mid-run write
			// path covered by acceptance row 7.
			expect((await readItem(fixture.loopDataRoot, chainId, 34801))?.phase).toBeNull()

			const accepted = record(expectOk(await request(fixture, "item.update", { itemId, status: "changes_requested" })).item)
			expect(accepted).toMatchObject({ id: itemId, status: "changes_requested" })

			const { events: admissionEvents } = await queryObservabilityEvents(
				resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile,
				{ type: "item.status.write_admission", chain: stringValue(chain.name) },
			)
			const noPhaseEntry = admissionEvents.find((event) => event.kind === "audit" && event.type === "item.status.write_admission" && event.payload.phase === null)
			expect(noPhaseEntry).toBeDefined()
			if (noPhaseEntry !== undefined && noPhaseEntry.kind === "audit" && noPhaseEntry.type === "item.status.write_admission") {
				expect(noPhaseEntry.payload.outcome).toBe("allow")
				expect(noPhaseEntry.payload.reason).toBe("no-phase-active")
				expect(noPhaseEntry.payload.declaredExits).toEqual([])
				expect(noPhaseEntry.payload.requestedStatus).toBe("changes_requested")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket item.exits returns typed phase exits and parity with write-side allowed", async () => {
		// #451 typed phase-exits query face. Three scenarios in one fixture:
		//   1. Multi-option phase (gh-issue-pr-iteration/review) returns its declared 5 exits and
		//      the flat `allowed` list matches the write-side gate's `allowed` payload.
		//   2. Single-option phase (single-phase-example/run) returns exactly one exit — the
		//      uniform protocol shape multi-option and single-option phases share.
		//   3. Unknown phase is rejected with `invalid_request` listing the known phase names.
		// Acceptance rows covered: 1 (query face), 2 (write parity), 3 (single-option completion).
		const fixture = await startFixture("item-exits-typed-query", { schedulerEnabled: false })
		try {
			// Scenario 1: multi-option review phase from gh-issue-pr-iteration.
			const reviewChain = record(expectOk(await request(fixture, "chain.create", {
				name: "exits-review-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const reviewChainId = numberValue(reviewChain.id)
			const reviewItem = record(expectOk(await request(fixture, "item.add", {
				chainId: reviewChainId,
				itemId: "45101",
				repoCwd: REPO_ROOT,
			})).item)
			const reviewItemId = numberValue(reviewItem.id)

			const reviewExits = expectOk(await request(fixture, "item.exits", {
				itemId: reviewItemId,
				agentRunId: "run-exits-test-1",
				agentPhase: "review",
			}))
			expect(reviewExits.phase).toBe("review")
			// #405 ADT: the typed phase-exits face now splits the allowed payload into
			// `allowedStatuses` (item-status branch) and `allowedChainActions` (chain-action
			// branch). Review declares its five item-status exits plus the chain-action `stop`
			// exit (the controlled stop-chain channel — agent direct `chain stop` rejected
			// per #409).
			expect(reviewExits.allowedStatuses).toEqual(["blocked", "changes_requested", "done", "exhausted", "moot"])
			expect(reviewExits.allowedChainActions).toEqual(["stop"])
			const reviewExitsArray = Array.isArray(reviewExits.exits) ? reviewExits.exits : []
			expect(reviewExitsArray.length).toBe(6)
			for (const raw of reviewExitsArray) {
				const exit = record(raw)
				expect(typeof exit.when).toBe("string")
					if (typeof exit.when !== "string") throw new Error("expected exit condition")
					expect(exit.when.length).toBeGreaterThan(0)
				if (exit.kind === "item-status") {
					expect(typeof exit.status).toBe("string")
				} else if (exit.kind === "chain-action") {
					expect(exit.action).toBe("stop")
				} else {
					throw new Error(`unknown exit kind: ${JSON.stringify(exit)}`)
				}
			}

			// Cross-check write-side parity (#397): the gate's `allowed` payload on a deny equals
			// the query's `allowedStatuses` list (chain-action exits do not participate in the
			// item-status write gate), so the agent that queries-then-writes sees one consistent
			// item-status set.
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(reviewItemId, { phase: "review", updatedAt: 1_800_030_000 })
			} finally {
				store.close()
			}
			const writeDenied = await request(fixture, "item.update", { itemId: reviewItemId, status: "queued" })
			expectInvalid(writeDenied)
			if (!writeDenied.ok) {
				expect(writeDenied.error.details).toMatchObject({
					phase: "review",
					allowed: reviewExits.allowedStatuses,
				})
			}

			// Scenario 2: single-option `run` phase from single-phase-example. Same protocol shape;
			// the only exit is `done` and writing it marks the item complete.
			const runChain = record(expectOk(await request(fixture, "chain.create", {
				name: "exits-single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const runChainId = numberValue(runChain.id)
			const runItem = record(expectOk(await request(fixture, "item.add", {
				chainId: runChainId,
				itemId: "45102",
				repoCwd: REPO_ROOT,
				preset: "single-phase-example",
			})).item)
			const runItemId = numberValue(runItem.id)

			const runExits = expectOk(await request(fixture, "item.exits", {
				itemId: runItemId,
				agentRunId: "run-exits-test-2",
				agentPhase: "run",
			}))
			expect(runExits.phase).toBe("run")
			// #405 ADT: single-option phase only declares item-status exits, so
			// `allowedChainActions` is empty here while `allowedStatuses` mirrors the historical
			// `allowed` projection.
			expect(runExits.allowedStatuses).toEqual(["done"])
			expect(runExits.allowedChainActions).toEqual([])
			const runExitsArray = Array.isArray(runExits.exits) ? runExits.exits : []
			expect(runExitsArray.length).toBe(1)
			const onlyExit = record(runExitsArray[0])
			expect(onlyExit.kind).toBe("item-status")
			expect(onlyExit.status).toBe("done")

			// Scenario 3: unknown phase rejected with typed `invalid_request` listing known phases.
			const unknownPhase = await request(fixture, "item.exits", {
				itemId: reviewItemId,
				agentRunId: "run-exits-test-3",
				agentPhase: "no-such-phase",
			})
			expect(unknownPhase.ok).toBe(false)
			if (!unknownPhase.ok) {
				expect(unknownPhase.error.code).toBe("invalid_request")
				expect(unknownPhase.error.message).toContain("no-such-phase")
				expect(unknownPhase.error.details).toMatchObject({ phase: "no-such-phase" })
			}

			// Missing agent attribution is rejected (the query face is per-agent-run by design).
			const missingAttribution = await request(fixture, "item.exits", { itemId: reviewItemId, agentRunId: "run-x" })
			expect(missingAttribution.ok).toBe(false)
			if (!missingAttribution.ok) {
				expect(missingAttribution.error.code).toBe("invalid_request")
				expect(missingAttribution.error.message).toContain("agentRunId and agentPhase")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #405 chain-action exit selection face. Three scenarios cover the protocol surface:
	//   1. Selecting a declared chain-action (`stop`) maps to the operator chain.stop semantics —
	//      chain status flips to `stopped`, the audit + lifecycle events fire (#411 obligation), and
	//      operator `chain.resume` reversibly restores active status.
	//   2. Selecting a chain-action that the phase does not declare is rejected as `invalid_request`
	//      with the typed declared-options list (default-deny per the #397 pattern).
	//   3. Agent direct `chain.stop` calls remain rejected through the credential gate — this CLI
	//      is the only controlled channel for an agent to stop the chain it owns (#409).

	test("socket item.exitAction stop maps to chain.stop and emits the audit + lifecycle events (#405 + #411)", async () => {
		const fixture = await startFixture("item-exit-action-stop", { schedulerEnabled: false })
		try {
			const chainRecord = record(expectOk(await request(fixture, "chain.create", {
				name: "exit-action-stop-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chainRecord.id)
			const item = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "45201",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(item.id)
			const eventsFile = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const durableStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				durableStore.recordRun({
					runId: "run-exit-action-test-2",
					chainId,
					itemId,
					phase: "review",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
			} finally {
				durableStore.close()
			}

			// Scenario 2a: vocabulary-invalid action is rejected by the request boundary before the
			// per-phase admission gate fires. The error message echoes the engine vocabulary.
			const bogusVocab = await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-1a",
				agentPhase: "review",
				action: "not_a_real_action",
			})
			expect(bogusVocab.ok).toBe(false)
			if (!bogusVocab.ok) {
				expect(bogusVocab.error.code).toBe("invalid_request")
				expect(bogusVocab.error.message).toMatch(/action must be one of: stop/)
			}

			// Scenario 2b: vocabulary-valid but phase-undeclared action is rejected by the per-phase
			// admission gate (default-deny per #397 pattern). Iteration declares no chain-action exits
			// at all (its `[[steps.handoffs]]` is empty), so `action=stop` against `agentPhase=iteration`
			// is admitted at the vocabulary leg and denied at the per-phase leg — producing the
			// `item.exit.selected` audit event with `outcome=deny reason=phase-exits`.
			const undeclared = await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-2",
				agentPhase: "iteration",
				action: "stop",
			})
			expect(undeclared.ok).toBe(false)
			if (!undeclared.ok) {
				expect(undeclared.error.code).toBe("invalid_request")
				expect(undeclared.error.message).toMatch(/chain action "stop" is not declared by phase "iteration"/)
			}

			// Scenario 1a: agent-attribution-bypass operator-style call (no agentCredential) succeeds —
			// the chain stops and both observability events fire. Agents go through the credential
			// gate; operator path is the same handler with no credential field.
			const accepted = expectOk(await request(fixture, "item.exitAction", {
				itemId,
				agentRunId: "run-exit-action-test-2",
				agentPhase: "review",
				action: "stop",
			}))
			expect(accepted.action).toBe("stop")
			const acceptedChain = record(accepted.chain)
			expect(acceptedChain.status).toBe("stopped")

			// #411 audit event: `item.exit.selected` fired for the deny + allow attempts.
			const { events: auditEvents } = await queryObservabilityEvents(eventsFile, { type: "item.exit.selected" })
			expect(auditEvents.length).toBeGreaterThanOrEqual(2)
			const denyEvent = auditEvents.find((event) => event.type === "item.exit.selected" && event.payload.outcome === "deny")
			const allowEvent = auditEvents.find((event) => event.type === "item.exit.selected" && event.payload.outcome === "allow")
			if (denyEvent?.type !== "item.exit.selected") throw new Error("expected deny item.exit.selected audit")
			if (allowEvent?.type !== "item.exit.selected") throw new Error("expected allow item.exit.selected audit")
			expect(denyEvent.payload.selectionKind).toBe("chain-action")
			expect(denyEvent.payload.reason).toBe("phase-exits")
			expect(denyEvent.payload.declaredChainActions).toEqual([]) // iteration declares no chain-action exits
			expect(denyEvent.phase).toBe("iteration")
			expect(allowEvent.payload.selectedAction).toBe("stop")
			expect(allowEvent.payload.reason).toBe("admitted")
			expect(allowEvent.payload.declaredChainActions).toEqual(["stop"]) // review declares stop
			expect(allowEvent.phase).toBe("review")

			// #411 lifecycle distinguisher: `chain.stop.from_phase_exit` fires alongside the existing
			// `chain.status` audit event the chain-stop dispatcher already emits.
			const { events: lifecycleEvents } = await queryObservabilityEvents(eventsFile, { type: "chain.stop.from_phase_exit" })
			expect(lifecycleEvents.length).toBe(1)
			const lifecycleEvent = lifecycleEvents[0]
			if (lifecycleEvent?.type !== "chain.stop.from_phase_exit") throw new Error("expected chain.stop.from_phase_exit lifecycle event")
			expect(lifecycleEvent.payload.chainId).toBe(chainId)
			expect(lifecycleEvent.payload.id).toBe("45201")
			expect(lifecycleEvent.payload.alreadyStopped).toBe(false)
			expect(lifecycleEvent.phase).toBe("review")
			expect(lifecycleEvent.runId).toBe("run-exit-action-test-2")

			// Scenario 1b: chain.resume reversibly restores active status — confirms the chain-action
			// exit path is the same code path operator `chain stop` runs (D1 semantics).
			const resumed = expectOk(await request(fixture, "chain.resume", { chainId }))
			const resumedChain = record(resumed.chain)
			expect(resumedChain.status).toBe("active")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("credential-bound item.exitAction denies forged attribution and preserves overlapping already-stopped review attempts (#600)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-600-exit-action-credential-truth`)
		const loopDataRoot = root + "-loop-data"
		const credentialedPresetDir = await writeCredentialedFixturePreset(root)
		const iterationCapture = resolve(root, "iteration-credential.txt")
		const iterationRelease = resolve(root, "iteration-release")
		const reviewCapture = resolve(root, "review-credential.txt")
		const fakeRunner = resolve(root, "fake-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { appendFile, writeFile } from "node:fs/promises"
import { type as arkType } from "arktype"
const IterationRunnerPromptBoundary = arkType({
	itemId: "number",
	runId: "string",
	phase: arkType.unit("iteration"),
	eventLog: "string",
})
const ReviewRunnerPromptBoundary = arkType({
	itemId: "number",
	runId: "string",
	phase: arkType.unit("review"),
	eventLog: "string",
})
const RunnerPromptBoundary = arkType.or(IterationRunnerPromptBoundary, ReviewRunnerPromptBoundary)
type IterationRunnerPrompt = typeof IterationRunnerPromptBoundary.infer
type ReviewRunnerPrompt = typeof ReviewRunnerPromptBoundary.infer
type RunnerPrompt = IterationRunnerPrompt | ReviewRunnerPrompt
function assertNeverRunnerPrompt(input: never): never {
	throw new Error(\`unexpected runner prompt phase: \${JSON.stringify(input)}\`)
}
const promptIndex = Bun.argv.indexOf("-p")
if (promptIndex === -1 || promptIndex + 1 >= Bun.argv.length) {
	throw new Error("fake runner requires -p followed by a prompt value")
}
const prompt = Bun.argv[promptIndex + 1]
if (prompt === undefined) throw new Error("fake runner requires -p followed by a prompt value")
const promptPayloadEnd = prompt.indexOf("\\n")
const promptPayload = prompt.slice(0, promptPayloadEnd === -1 ? prompt.length : promptPayloadEnd)
const input: RunnerPrompt = RunnerPromptBoundary.assert(JSON.parse(promptPayload))
const loopDataRoot = process.env.CODER_LOOP_DATA_DIR
if (typeof loopDataRoot !== "string" || loopDataRoot.length === 0) {
	throw new Error("fake runner requires CODER_LOOP_DATA_DIR")
}
const credential = process.env.CODER_LOOP_RUN_CRED
if (typeof credential !== "string" || credential.length === 0) {
	throw new Error("fake runner requires CODER_LOOP_RUN_CRED")
}
await appendFile(input.eventLog, JSON.stringify({ type: "running", itemId: input.itemId, runId: input.runId, phase: input.phase }) + "\\n")
switch (input.phase) {
	case "iteration": {
		await writeFile(${JSON.stringify(iterationCapture)}, credential)
		while (!(await Bun.file(${JSON.stringify(iterationRelease)}).exists())) await Bun.sleep(10)
		${FAKE_RUNNER_STATUS_WRITE_SNIPPET.replaceAll("input.writeStatus", '"in_progress"')}
		break
	}
	case "review":
		await writeFile(${JSON.stringify(reviewCapture)}, credential)
		await new Promise((resolveWait) => setTimeout(resolveWait, 8_000))
		break
	default:
		assertNeverRunnerPrompt(input)
}
process.exitCode = 0
`,
		)
		const runnerEnv = { ...process.env }
		delete runnerEnv.CODER_LOOP_DATA_DIR
		delete runnerEnv.CODER_LOOP_RUN_CRED
		const validIterationPrompt = JSON.stringify({ itemId: 60001, runId: "boundary-run", phase: "iteration", eventLog })
		const invalidPhasePrompt = JSON.stringify({ itemId: 60001, runId: "boundary-run", phase: "unknown", eventLog })
		const boundaryCases = [
			{
				name: "missing -p",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires -p followed by a prompt value",
			},
			{
				name: "missing prompt value",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p"], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires -p followed by a prompt value",
			},
			{
				name: "missing data dir",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", validIterationPrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires CODER_LOOP_DATA_DIR",
			},
			{
				name: "missing credential",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", validIterationPrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "requires CODER_LOOP_RUN_CRED",
			},
			{
				name: "unknown phase",
				proc: Bun.spawn({ cmd: ["bun", fakeRunner, "-p", invalidPhasePrompt], cwd: REPO_ROOT, env: { ...runnerEnv, CODER_LOOP_DATA_DIR: loopDataRoot, CODER_LOOP_RUN_CRED: "boundary-credential" }, stdout: "pipe", stderr: "pipe" }),
				expectedError: "phase",
			},
		]
		for (const boundaryCase of boundaryCases) {
			const [exitCode, stderr] = await Promise.all([
				boundaryCase.proc.exited,
				new Response(boundaryCase.proc.stderr).text(),
			])
			expect(exitCode, boundaryCase.name).not.toBe(0)
			expect(stderr, boundaryCase.name).toContain(boundaryCase.expectedError)
		}
		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 100,
			scheduler: {
				enabled: true,
				intervalMs: 20,
				runner: { kind: "claude", source: "iteration-default", binary: "bun", extraArgs: [fakeRunner], model: null },
				presetDir: credentialedPresetDir,
				worktreeManager: async () => root,
				prompt: ({ item, runId, phase }) => JSON.stringify({ itemId: item.id, runId, phase, eventLog }),
				chainCompleteTriggerForChain: () => null,
			},
		})
		try {
			const snapshot = daemon.snapshot()
			const chain = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.create", {
				name: "exit-action-credential-truth-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { presetPath: credentialedPresetDir },
			}))).chain)
			const chainId = numberValue(chain.id)
			const item = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.add", {
				chainId,
				itemId: "60001",
				repoCwd: REPO_ROOT,
				presetPath: credentialedPresetDir,
			}))).item)
			const itemId = numberValue(item.id)

			await waitFor(async () => {
				try { return (await readFile(iterationCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 8_000)
			const iterationCredential = (await readFile(iterationCapture, "utf-8")).trim()
			const iterationStatus = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon)
			const iterationRuns = Array.isArray(iterationStatus.activeRuns) ? iterationStatus.activeRuns : []
			const iterationRun = iterationRuns.map(record).find((run) => typeof run.runId === "string" && run.runId.includes("-iteration-item-"))
			if (iterationRun === undefined) throw new Error("expected active iteration run")
			const iterationRunId = stringValue(iterationRun.runId)

			const forged = await sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", {
				itemId,
				agentRunId: iterationRunId,
				agentPhase: "review",
				action: "stop",
				agentCredential: iterationCredential,
			}))
			expect(forged.ok).toBe(false)
			if (!forged.ok) {
				expect(forged.error.code).toBe("invalid_caller")
				expect(forged.error.message).toContain("phase")
				expect(forged.error.details).toMatchObject({
					boundRunId: iterationRunId,
					boundPhase: "iteration",
					claimedRunId: iterationRunId,
					claimedPhase: "review",
				})
			}
			const stillActive = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("chain.status", { chainId }))).chain)
			expect(stillActive.status).toBe("active")

			const eventsFile = resolveLoopDataPaths({ loopDataRoot }).eventsFile
			const forgedEvents = (await queryObservabilityEvents(eventsFile, { type: "item.exit.selected" })).events
			const forgedDeny = forgedEvents.find((event) => event.type === "item.exit.selected" && event.payload.reason === "caller-attribution-mismatch")
			if (forgedDeny?.type !== "item.exit.selected") throw new Error("expected caller-attribution-mismatch item.exit.selected audit")
			expect(forgedDeny.phase).toBe("iteration")
			expect(forgedDeny.runId).toBe(iterationRunId)
			expect(forgedDeny.payload.phase).toBe("iteration")
			expect(forgedDeny.payload.declaredChainActions).toEqual([])
			expect(forgedDeny.subject).toEqual({ kind: "agent", runId: iterationRunId, phase: "iteration" })
			await writeFile(iterationRelease, "release")

			await waitFor(async () => {
				try { return (await readFile(reviewCapture, "utf-8")).trim() } catch { return "" }
			}, (value) => value.length > 0, 12_000)
			const reviewCredential = (await readFile(reviewCapture, "utf-8")).trim()
			const reviewStatus = record(expectOk(await sendDaemonRequest(snapshot.socketPath, daemonRequest("daemon.status"))).daemon)
			const reviewRuns = Array.isArray(reviewStatus.activeRuns) ? reviewStatus.activeRuns : []
			const reviewRun = reviewRuns.map(record).find((run) => typeof run.runId === "string" && run.runId.includes("-review-item-"))
			if (reviewRun === undefined) throw new Error("expected active review run")
			const reviewRunId = stringValue(reviewRun.runId)

			const stopArgs: JsonObject = {
				itemId,
				agentRunId: reviewRunId,
				agentPhase: "review",
				action: "stop",
				agentCredential: reviewCredential,
			}
			const stopResponses = await Promise.all([
				sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", stopArgs)),
				sendDaemonRequest(snapshot.socketPath, daemonRequest("item.exitAction", stopArgs)),
			])
			const acceptedStops = stopResponses.map(expectOk)
			expect(acceptedStops.map((accepted) => record(accepted.chain).status)).toEqual(["stopped", "stopped"])
			const finalEvents = (await queryObservabilityEvents(eventsFile)).events
			const acceptedSelections = finalEvents.filter((event) => event.type === "item.exit.selected" && event.payload.outcome === "allow")
			expect(acceptedSelections).toHaveLength(2)
			for (const acceptedSelection of acceptedSelections) {
				if (acceptedSelection.type !== "item.exit.selected") throw new Error("expected allowed item.exit.selected audit")
				expect(acceptedSelection.phase).toBe("review")
				expect(acceptedSelection.runId).toBe(reviewRunId)
				expect(acceptedSelection.subject).toEqual({ kind: "agent", runId: reviewRunId, phase: "review" })
			}
			const stopLifecycleEvents = finalEvents.filter((event) => event.type === "chain.stop.from_phase_exit")
			expect(stopLifecycleEvents).toHaveLength(2)
			for (const stopLifecycle of stopLifecycleEvents) {
				if (stopLifecycle.type !== "chain.stop.from_phase_exit") throw new Error("expected chain.stop.from_phase_exit lifecycle event")
				expect(stopLifecycle.phase).toBe("review")
				expect(stopLifecycle.runId).toBe(reviewRunId)
				expect(stopLifecycle.subject).toEqual({ kind: "agent", runId: reviewRunId, phase: "review" })
			}
			expect(stopLifecycleEvents.map((event) => event.type === "chain.stop.from_phase_exit" && event.payload.alreadyStopped).sort()).toEqual([false, true])
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	test("socket item.update rejects immutable selectors and daemon-owned fields", async () => {
		const fixture = await startFixture("item-update-strict-fields", { schedulerEnabled: false })
		try {
			const firstChain = record(expectOk(await request(fixture, "chain.create", {
				name: "immutable-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const secondChain = record(expectOk(await request(fixture, "chain.create", {
				name: "other-item-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(firstChain.id)
			const otherChainId = numberValue(secondChain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "221",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			const invalidRequests = [
				{ itemId },
				{ itemId, chainId: otherChainId, status: runtimeStatus("done") },
				{ itemId, id: itemId, status: runtimeStatus("done") },
				{ itemId, createdAt: 1, status: runtimeStatus("done") },
				{ itemId, updatedAt: 1, status: runtimeStatus("done") },
				{ itemId, attempts: 5 },
				{ itemId, lastRunId: "run-forged" },
				{ itemId, agentCwd: "/etc/passwd" },
				{ itemId, fields: { chainId: otherChainId } },
				{ itemId, fields: { issueNumber: 999 } },
				{ itemId, fields: { attempts: 5 } },
				{ itemId, fields: { lastRunId: "run-forged" } },
				{ itemId, fields: { agentCwd: "/etc/passwd" } },
				{ itemId, fields: { updatedAt: 1 } },
			]
			for (const args of invalidRequests) expectInvalid(await request(fixture, "item.update", args))

			const unchangedItems = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(unchangedItems)).toBe(true)
			if (!Array.isArray(unchangedItems)) throw new Error("expected unchanged item list array")
			expect(unchangedItems).toHaveLength(1)
			expect(record(unchangedItems[0])).toMatchObject({
				id: itemId,
				chainId,
				itemId: "221",
				status: runtimeStatus("queued"),
				attempts: 0,
				lastRunId: null,
				agentCwd: null,
			})
			const otherItems = expectOk(await request(fixture, "item.list", { chainId: otherChainId })).items
			expect(Array.isArray(otherItems)).toBe(true)
			expect(otherItems).toHaveLength(0)

			const updated = record(expectOk(await request(fixture, "item.update", {
				chainId,
				itemId: "221",
				fields: { status: runtimeStatus("done"), title: "strict item update" },
			})).item)
			expect(updated).toMatchObject({ id: itemId, chainId, status: runtimeStatus("done"), title: "strict item update" })
			expect(stringValue(updated.itemId)).toBe("221")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("queue unblock waits for in-flight scheduler tick", async () => {
		const fixture = await startQueueUnblockGateFixture("538-in-flight", { preset: "loaded", targetStatus: "blocked" })
		try {
			await fixture.tickEntered.promise

			// Model the snapshot that existed when the in-flight tick began. Once released, the
			// real scheduler spawn adds the sentinel item's current run alongside this one.
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.recordRun({
					runId: "run-before-in-flight-tick",
					chainId: fixture.chainId,
					itemId: fixture.targetRowId,
					phase: "iteration",
					startedAt: 1_800_000_000,
					extra: staleRecoveryRunExtra(REPO_ROOT),
				})
				store.setCurrentRun({
					chainId: fixture.chainId,
					phase: "iteration",
					runId: "run-before-in-flight-tick",
					startedAt: 1_800_000_000,
					extra: storedItemExtra({ itemId: fixture.targetRowId }),
				})
			} finally {
				store.close()
			}

			let unblockSettled = false
			const unblockPromise = sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
			})).then((response) => {
				unblockSettled = true
				return response
			})

			// The operator-admission event is written before dispatch enters handleQueueUnblock.
			// Seeing it while the worktree promise gate is still closed proves the request reached
			// the handler; the item/current-run snapshot must remain untouched until the tick exits.
			await waitFor(
				async () => (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events,
				(events) => events.filter((event) =>
					event.kind === "audit"
						&& event.type === "privileged_op.caller_admission"
						&& event.payload.op === "queue.unblock"
						&& event.payload.outcome === "allow",
				).length >= 2,
			)
			expect(unblockSettled).toBe(false)
			expect((await readItem(fixture.loopDataRoot, fixture.chainId, Number(fixture.targetItemId)))?.status).toBe("blocked")

			fixture.releaseTick.resolve()
			const unblock = record(expectOk(await unblockPromise))
			expect(record(unblock.mutation)).toMatchObject({
				changed: true,
				beforeStatus: "blocked",
				afterStatus: "queued",
				clearedCurrent: true,
			})

			const remainingCurrentRunsStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const currentRuns = remainingCurrentRunsStore.listCurrentRuns(fixture.chainId)
				expect(currentRuns).toHaveLength(1)
				expect(currentRuns[0]?.extra.itemId).toBe(fixture.sentinelRowId)
				expect(currentRuns[0]?.runId).not.toBe("run-before-in-flight-tick")
			} finally {
				remainingCurrentRunsStore.close()
			}
		} finally {
			fixture.releaseTick.resolve()
			await fixture.daemon.stop()
		}
	}, 30_000)

	test("queue unblock always resumes scheduler", async () => {
		const scenarios: readonly QueueUnblockOutcomeScenario[] = [
			{ kind: "success", preset: "loaded", targetStatus: "blocked", issue: "target", dryRun: false },
			{ kind: "dry-run", preset: "loaded", targetStatus: "blocked", issue: "target", dryRun: true },
			{ kind: "not-unblockable", preset: "loaded", targetStatus: "done", issue: "target", dryRun: false },
			{ kind: "not-found", preset: "loaded", targetStatus: "blocked", issue: "missing", dryRun: false },
			{ kind: "preset-load-error", preset: "missing", targetStatus: "blocked", issue: "target", dryRun: false },
		]

		for (const scenario of scenarios) {
			const fixture = await startQueueUnblockGateFixture(`538-resume-${scenario.kind}`, scenario)
			try {
				await fixture.tickEntered.promise
				const responsePromise = sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
					chainName: fixture.chainName,
					issue: scenario.issue === "target" ? fixture.targetItemId : scenario.issue,
					dryRun: scenario.dryRun,
				}))

				fixture.releaseTick.resolve()
				const response = await responsePromise
				switch (scenario.kind) {
					case "success":
					case "dry-run":
						expectOk(response)
						break
					case "not-unblockable":
						expect(record(expectOk(response).mutation).reason).toBe("not_unblockable")
						break
					case "not-found":
					case "preset-load-error":
						expect(response.ok).toBe(false)
						break
					default:
						assertNeverQueueUnblockOutcomeScenario(scenario)
				}

				// The initial tick is now holding an active sentinel run. A post-outcome tick
				// therefore emits slot.busy; reaching this promise proves finally resumed the
				// scheduler for returns and throws alike without inspecting private pause depth.
				const busyEvent = await fixture.postOutcomeTick.promise
				expect(busyEvent.type).toBe("slot.busy")
			} finally {
				fixture.releaseTick.resolve()
				await fixture.daemon.stop()
			}
		}
	}, 30_000)

	test("queue unblock caller admission", async () => {
		const fixture = await startQueueUnblockGateFixture("538-caller-admission", { preset: "loaded", targetStatus: "blocked" })
		try {
			await fixture.tickEntered.promise
			fixture.releaseTick.resolve()
			const credential = await waitFor(
				async () => {
					try {
						return (await readFile(fixture.credentialPath, "utf-8")).trim()
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
						throw error
					}
				},
				(value) => value.length > 0,
			)

			const denied = await sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
				agentCredential: credential,
			}))
			expect(denied.ok).toBe(false)
			if (!denied.ok) {
				expect(denied.error.code).toBe("invalid_caller")
				expect(denied.error.message).toContain("operator credentials")
			}
			expect((await readItem(fixture.loopDataRoot, fixture.chainId, Number(fixture.targetItemId)))?.status).toBe("blocked")

			const allowed = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("queue.unblock", {
				chainName: fixture.chainName,
				issue: fixture.targetItemId,
			}))))
			expect(record(allowed.mutation).changed).toBe(true)

			const events = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
			const queueAdmission = events.filter((event) =>
				event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === "queue.unblock",
			)
			expect(queueAdmission.some((event) =>
				event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.outcome === "deny"
					&& event.payload.reason === "hard-deny-for-agent"
					&& event.subject?.kind === "agent",
			)).toBe(true)
			expect(queueAdmission.some((event) => event.kind === "audit" && event.type === "privileged_op.caller_admission" && event.payload.outcome === "allow")).toBe(true)
			expect(events.some((event) =>
				event.kind === "audit"
					&& event.type === "item.mutation.caller_admission"
					&& event.item === fixture.targetRowId
					&& event.payload.outcome === "allow"
					&& event.payload.reason === "operator",
			)).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #410 acceptance row #2 — review writes its declared passthrough fields (top-level + inner
	// blocker keys via extraPatch). Uses the same two-phase fake runner shape as #409 row 2:
	// iteration captures its credential + writes in_progress; review captures its credential and
	// sleeps while the test drives the live `item.update` calls. The fixture preset has
	// `writableFields = ["branch", "pr", "blockerRepo", "blockerRef"]` on the review phase, so a
	// review-CRED update of `branch` + `pr` succeeds and a review-CRED `extraPatch` write of
	// `blockerRepo` + `blockerRef` succeeds. The deny half (control-plane denial + undeclared
	// field) is covered in the row #1 test below.
})
