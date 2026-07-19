import { rename } from "node:fs/promises"

import { REPO_ROOT, closureWorktreePath, daemonRequest, describe, expect, expectChainDeleted, expectChainNotActive, expectConflict, expectInvalid, expectInvalidDetails, expectOk, expectTooLarge, gitOutput, initGitTarget, nestedMetadata, numberValue, openSqliteStateStore, pathExists, queryObservabilityEvents, readChain, readChainStatus, readFile, readItem, record, request, resolveChainRuntimePaths, resolveLoopDataPaths, runtimeStatus, sendDaemonRequest, startCoderLoopDaemon, startFixture, storedChainMetadata, storedItemExtra, test, waitFor } from "./harness"
import type { SchedulerEvent } from "./harness"

describe("daemon", () => {
	test("socket chain.create", async () => {
		const fixture = await startFixture("chain-create", { schedulerEnabled: false })
		try {
			// #433: top-level `metadata.runner` is retired. Operators who want the chain to expose
			// a particular runner kind set it via the per-runner channel (`metadata.codex.binary`)
			// instead; the bare runner alias is gone.
			// #457: umbrella values now flow through metadata.bindings rather than a first-class
			// chain.create field; the daemon no longer validates `umbrellaIssue` / `umbrellaRepo`
			// as engine-typed fields, so the test exercises the declared-binding path instead.
			const result = expectOk(await request(fixture, "chain.create", {
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" }, bindings: { umbrellaIssue: 176 } },
			}))

			expect(result.chain).toMatchObject({
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: { codex: { binary: "codex" }, bindings: { umbrellaIssue: 176 } },
			})
			const paths = resolveChainRuntimePaths("central-state", { loopDataRoot: fixture.loopDataRoot })
			await expect(Bun.file(paths.sharedFile).exists()).resolves.toBe(true)
			await expect(readFile(paths.sharedFile, "utf-8")).resolves.toBe("# Shared durable context\n\n")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create is idempotent but rejects conflicting existing fields", async () => {
		const fixture = await startFixture("chain-create-conflict", { schedulerEnabled: false })
		try {
			const first = record(expectOk(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})).chain)

			const repeated = record(expectOk(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})).chain)
			expect(repeated.id).toBe(first.id)
			expect(repeated).toMatchObject({
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			})

			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/different",
				baseBranch: "main",
				metadata: { codex: { binary: "codex" } },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "develop",
				metadata: { codex: { binary: "codex" } },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { claude: { binary: "claude" } },
			}))

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(1)
			const [listedChain] = listed
			expect(record(listedChain)).toMatchObject({ repository: "mouriya-s-lab/coder-loop", baseBranch: "main", metadata: { codex: { binary: "codex" } } })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create rejects invalid names before db insert", async () => {
		const fixture = await startFixture("chain-create-invalid", { schedulerEnabled: false })
		try {
			const invalidNames = ["..", ".", "a/b", "../escape", "/etc/hi", "ab cd", "-flag", "a".repeat(256), "bad\tname"]

			for (const name of invalidNames) {
				const response = await request(fixture, "chain.create", {
					name,
					repository: "mouriya-s-lab/coder-loop",
				})

				expect(response.ok).toBe(false)
				if (!response.ok) expect(response.error.code).toBe("invalid_request")
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates repository format", async () => {
		const fixture = await startFixture("chain-create-invalid-repository", { schedulerEnabled: false })
		try {
			const invalidRepositories = [
				"x/y\nbad",
				"x",
				"x/",
				"/y",
				"x/y/z",
				"bad owner/repo",
				"owner/.",
				"owner/..",
				"owner/repo\u007f",
				"owner-/repo",
			]

			for (const [index, repository] of invalidRepositories.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `repo-check-${index}`,
					repository,
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates baseBranch as a git branch name", async () => {
		const fixture = await startFixture("chain-create-invalid-base-branch", { schedulerEnabled: false })
		try {
			const invalidBaseBranches = [
				"../../etc/passwd",
				"main\nbad",
				"bad\u0000name",
				"main..bad",
				"main@{bad",
				"@{-1}",
				"main:bad",
				"main^bad",
				"main?bad",
				"main*bad",
				"main[bad",
				"/main",
				"main.lock",
				"main/.bad",
				"-bad",
				"bad branch",
			]

			for (const [index, baseBranch] of invalidBaseBranches.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `base-branch-check-${index}`,
					repository: "mouriya-s-lab/coder-loop",
					baseBranch,
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			const valid = record(expectOk(await request(fixture, "chain.create", {
				name: "base-branch-valid",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "feature/safe-branch",
			})).chain)
			expect(valid).toMatchObject({ baseBranch: "feature/safe-branch" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #457: `umbrellaIssue` / `umbrellaRepo` are no longer first-class chain.create fields. They flow
	// through `metadata.bindings`, where the operator (or the `--umbrella owner/repo#123` CLI
	// shorthand) writes them as preset-declared chain bindings. The daemon rejects the legacy keys
	// at the strict-args gate so stale callers fail loudly instead of silently dropping their value.

	test("socket chain.create rejects undeclared args", async () => {
		const fixture = await startFixture("chain-create-strict-args", { schedulerEnabled: false })
		try {
			const args = JSON.parse(
				`{"name":"strict-args","repository":"mouriya-s-lab/coder-loop","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}`,
			)

			expectInvalid(await request(fixture, "chain.create", args))
			expectInvalid(await request(fixture, "chain.create", {
				name: "status-field",
				repository: "mouriya-s-lab/coder-loop",
				status: "deleted",
			}))
			expect(Object.prototype).not.toHaveProperty("polluted")
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates metadata keys and nesting before db insert", async () => {
		const fixture = await startFixture("chain-create-metadata-validation", { schedulerEnabled: false })
		try {
			const invalidCases = [
				{ name: "metadata-proto", metadata: JSON.parse(`{"__proto__":{"polluted":1},"normal":"v"}`) },
				{ name: "metadata-constructor", metadata: JSON.parse(`{"constructor":{"prototype":{"polluted":2}}}`) },
				{ name: "metadata-prototype", metadata: JSON.parse(`{"safe":{"prototype":true}}`) },
				{ name: "metadata-empty-key", metadata: JSON.parse(`{"":"empty-key"}`) },
				{ name: "metadata-nested-proto", metadata: JSON.parse(`{"items":[{"__proto__":{"polluted":3}}]}`) },
				{ name: "metadata-too-deep", metadata: nestedMetadata(9) },
				{ name: "metadata-max-attempts-zero", metadata: { maxItemAttempts: 0 } },
				{ name: "metadata-max-attempts-float", metadata: { maxItemAttempts: 1.5 } },
			]

			for (const { name, metadata } of invalidCases) {
				expectInvalid(await request(fixture, "chain.create", {
					name,
					repository: "mouriya-s-lab/coder-loop",
					metadata,
				}))
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			// #433: `metadata.config` is retired; the parser rejects it explicitly so a stale row
			// or a stale supervisor write fails fast instead of silently masking the value.
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-config-retired",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { config: { workflowFile: "workflow.md" } },
				}),
				"metadata.config",
				{ workflowFile: "workflow.md" },
			)
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-bindings-array",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { bindings: ["not", "an", "object"] },
				}),
				"metadata.bindings",
				["not", "an", "object"],
			)
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-attempts-string",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { maxItemAttempts: "seven" },
				}),
				"metadata.maxItemAttempts",
				"seven",
			)
			// #433: top-level `runner` and the role-named runner companion are also retired (dead keys
			// with no read site pre-#433; the role companion's name is composed at runtime in the
			// runtime-data guard per #456 so it does not appear as a literal in `src/`). The parser
			// raises explicitly so the rejection is observable.
			expectInvalidDetails(
				await request(fixture, "chain.create", {
					name: "metadata-runner-retired",
					repository: "mouriya-s-lab/coder-loop",
					metadata: { runner: "codex" },
				}),
				"metadata.runner",
				"codex",
			)

			expect(Object.prototype).not.toHaveProperty("polluted")
			const validMetadata = { bindings: { workflowFile: "workflow.md" }, maxItemAttempts: 7, nested: nestedMetadata(7), list: [{ leaf: "ok" }] }
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "metadata-valid",
				repository: "mouriya-s-lab/coder-loop",
				metadata: validMetadata,
			})).chain)
			expect(created.metadata).toEqual(validMetadata)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create validates preset name and existence before db insert", async () => {
		const fixture = await startFixture("chain-create-invalid-preset", { schedulerEnabled: false })
		try {
			const invalidPresets = ["../etc", "bad\nname", "bad name", "Bad", "bad_name", "-bad", "1bad", "non-existent"]

			for (const [index, preset] of invalidPresets.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `preset-check-${index}`,
					preset,
					repository: "mouriya-s-lab/coder-loop",
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon rejects existing chains with invalid or unknown presets instead of falling back", async () => {
		const fixture = await startFixture("existing-preset-explicit-failure", { schedulerEnabled: false })
		try {
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let invalidPresetItemId: number
			let unknownPresetItemId: number
			try {
				const invalidPresetChain = store.createChain({
					name: "invalid-preset-chain",
					preset: "bad_name",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
				invalidPresetItemId = store.createItem({
					chainId: invalidPresetChain.id,
					itemId: "41101",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({ sleepMs: 5, exitCode: 0 }),
				}).id
				const unknownPresetChain = store.createChain({
					name: "unknown-preset-chain",
					preset: "missing-preset",
					repository: "mouriya-s-lab/coder-loop",
					baseBranch: "main",
					status: "active",
					metadata: storedChainMetadata({}),
				})
				unknownPresetItemId = store.createItem({
					chainId: unknownPresetChain.id,
					itemId: "41102",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({ sleepMs: 5, exitCode: 0 }),
				}).id
			} finally {
				store.close()
			}

			const invalidPresetResponse = await request(fixture, "item.update", {
				itemId: invalidPresetItemId,
				fields: { status: runtimeStatus("done") },
			})
			expect(invalidPresetResponse.ok).toBe(false)
			if (!invalidPresetResponse.ok) {
				expect(invalidPresetResponse.error.code).toBe("invalid_request")
				expect(invalidPresetResponse.error.message).toContain("invalid name")
			}

			const unknownPresetResponse = await request(fixture, "item.update", {
				itemId: unknownPresetItemId,
				fields: { status: runtimeStatus("done") },
			})
			expect(unknownPresetResponse.ok).toBe(false)
			if (!unknownPresetResponse.ok) {
				expect(unknownPresetResponse.error.code).toBe("invalid_request")
				expect(unknownPresetResponse.error.message).toContain("failed to load preset")
				expect(unknownPresetResponse.error.message).toContain("missing-preset")
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create rejects oversized request and metadata payloads", async () => {
		const fixture = await startFixture("chain-create-size-limits", { schedulerEnabled: false })
		try {
			expectTooLarge(await request(fixture, "chain.create", {
				name: "metadata-too-large",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { k: "x".repeat(17 * 1024) },
			}))
			expectTooLarge(await request(fixture, "chain.create", {
				name: "line-too-large",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { k: "x".repeat(1024 * 1024) },
			}))

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete reports already_deleted consistently", async () => {
		const fixture = await startFixture("chain-delete-idempotency", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted).toMatchObject({ alreadyDeleted: false, chain: { status: "deleted" } })

			const deletedAgain = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deletedAgain).toMatchObject({ alreadyDeleted: true, chain: { status: "deleted" } })

			const missing = await request(fixture, "chain.delete", { chainId: 99999 })
			expect(missing.ok).toBe(false)
			if (!missing.ok) expect(missing.error.code).toBe("not_found")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain lookup rejects conflicting chainId and chainName", async () => {
		const fixture = await startFixture("chain-lookup-conflict", { schedulerEnabled: false })
		try {
			const chainA = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-a",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainB = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-b",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainAId = numberValue(chainA.id)
			const chainBId = numberValue(chainB.id)

			const matchingStatus = record(expectOk(await request(fixture, "chain.status", { chainId: chainAId, chainName: "chain-a" })).chain)
			expect(matchingStatus).toMatchObject({ id: chainAId, name: "chain-a" })

			const mismatchedStatus = await request(fixture, "chain.status", { chainId: chainAId, chainName: "chain-b" })
			expectInvalid(mismatchedStatus)
			if (mismatchedStatus.ok) throw new Error("expected mismatched chain.status to fail")
			expect(mismatchedStatus.error.message).toBe("chainId and chainName both provided but point to different chains")
			expect(record(mismatchedStatus.error.details)).toMatchObject({
				chainId: chainAId,
				chainName: "chain-b",
				chainIdResolvesTo: "chain-a",
				chainNameResolvesTo: chainBId,
			})

			const mismatchedDelete = await request(fixture, "chain.delete", { chainId: chainAId, chainName: "chain-b" })
			expectInvalid(mismatchedDelete)
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(2)
			expect(listed.map((entry) => record(entry))).toEqual([
				expect.objectContaining({ id: chainAId, name: "chain-a", status: "active" }),
				expect.objectContaining({ id: chainBId, name: "chain-b", status: "active" }),
			])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create force recreates deleted same-name chain", async () => {
		const fixture = await startFixture("chain-create-deleted-name", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			expectOk(await request(fixture, "chain.delete", { chainId }))
			const unforced = await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
			})
			expectChainDeleted(unforced)
			if (!unforced.ok) expect(unforced.error.message).toContain("force=true")

			const recreated = record(expectOk(await request(fixture, "chain.create", {
				name: "recyclable",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "recreated",
				force: true,
			})).chain)
			const recreatedId = numberValue(recreated.id)
			expect(recreatedId).not.toBe(chainId)
			expect(recreated).toMatchObject({
				name: "recyclable",
				status: "active",
				baseBranch: "recreated",
			})

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({ id: recreatedId, name: "recyclable", status: "active" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket deleted chain remains read-only for item mutations", async () => {
		const fixture = await startFixture("deleted-chain-read-only", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "read-only-deleted-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "226",
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			expectOk(await request(fixture, "chain.delete", { chainId }))

			expectChainDeleted(await request(fixture, "item.add", {
				chainId,
				itemId: "227",
				repoCwd: REPO_ROOT,
			}))
			expectChainDeleted(await request(fixture, "item.update", { itemId, status: runtimeStatus("done") }))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(expectOk(await request(fixture, "chain.status", { chainId })).chain).status).toBe("deleted")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket completed chain remains read-only for item mutations", async () => {
		const fixture = await startFixture("completed-chain-read-only", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "read-only-completed-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "228",
				repoCwd: REPO_ROOT,
				title: "complete me",
			})).item)
			const itemId = numberValue(added.id)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { status: runtimeStatus("done"), phase: "review", updatedAt: 1_800_015_200 })
				store.updateChain(chainId, { status: "completed", updatedAt: 1_800_015_201 })
			} finally {
				store.close()
			}

			expectChainNotActive(await request(fixture, "item.add", {
				chainId,
				itemId: "229",
				repoCwd: REPO_ROOT,
			}), "completed", "item.add")
			expectChainNotActive(await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ itemId: "230", repoCwd: REPO_ROOT },
					{ itemId: "231", repoCwd: REPO_ROOT },
				],
			}), "completed", "item.batchAdd")
			expectChainNotActive(await request(fixture, "item.update", { itemId, title: "mutated after completion" }), "completed", "item.update")
			expectChainNotActive(await request(fixture, "item.reorder", { itemId, position: 0 }), "completed", "item.reorder")

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected item list array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({
				id: itemId,
				itemId: "228",
				status: runtimeStatus("done"),
				title: "complete me",
			})
			expect(record(expectOk(await request(fixture, "chain.status", { chainId })).chain).status).toBe("completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete removes scheduler worktree registration and chain runtime layout", async () => {
		const fixture = await startFixture("chain-delete-cleanup", { realWorktreeManager: true })
		const target = fixture.loopDataRoot + "-target"
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, itemId: "225", repoCwd: target, extra: { sleepMs: 5_000 } })
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const storedChain = await readChain(fixture.loopDataRoot, chainId)
			if (storedChain === null) throw new Error("expected chain record")
			const paths = resolveChainRuntimePaths("delete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const lookup = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let worktreePath: string
			try {
				const root = lookup.getTaskTree(chainId)?.root
				if (root?.kind !== "seq") throw new Error("expected seq task tree")
				const iteration = root.children.find((node) => node.kind === "leaf" && node.closure.phase === "iteration")
				if (iteration?.kind !== "leaf") throw new Error("expected iteration closure")
				worktreePath = closureWorktreePath(fixture.loopDataRoot, storedChain.name, target, iteration.closure.closureId)
			} finally { lookup.close() }
			expect(await pathExists(worktreePath)).toBe(true)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).toContain(worktreePath)

			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted).toMatchObject({
				alreadyDeleted: false,
				chain: { status: "deleted" },
				cleanup: { chainRootRemoved: true },
			})
			expect(await pathExists(paths.chainRoot)).toBe(false)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)

			await fixture.daemon.stop()
			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
			try {
				expect(await pathExists(paths.chainRoot)).toBe(false)
			} finally {
				await restarted.stop()
			}
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete retains recovery state until incomplete closure cleanup can be retried", async () => {
		const fixture = await startFixture("chain-delete-incomplete-cleanup", { realWorktreeManager: true })
		const target = fixture.loopDataRoot + "-target"
		const unavailableTarget = target + "-unavailable"
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-incomplete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, itemId: "560-delete-retry", repoCwd: target, extra: { sleepMs: 5_000 } })
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			const paths = resolveChainRuntimePaths("delete-incomplete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let worktreePath: string
			let branchName: string
			let attemptsBeforeDelete: number
			try {
				const root = store.getTaskTree(chainId)?.root
				if (root?.kind !== "seq") throw new Error("expected seq task tree")
				const closure = root.children.find((node) => node.kind === "leaf" && node.closure.phase === "iteration")
				if (closure?.kind !== "leaf" || closure.closure.worktreePath === null || closure.closure.branchName === null) throw new Error("expected persisted iteration resources")
				expect(closure.closure.lifecycle).toBe("active")
				worktreePath = closure.closure.worktreePath
				branchName = closure.closure.branchName
				const item = store.listItems(chainId).find((entry) => entry.itemId === "560-delete-retry")
				if (item === undefined) throw new Error("expected delete retry item")
				attemptsBeforeDelete = item.attempts
			} finally { store.close() }
			await rename(target, unavailableTarget)

			const failed = await request(fixture, "chain.delete", { chainId })

			expect(failed.ok).toBe(false)
			if (!failed.ok) {
				expect(failed.error.code).toBe("runtime_cleanup_incomplete")
				expect(record(failed.error.details)).toMatchObject({ chainRoot: paths.chainRoot, chainRootRemoved: false })
			}
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("stopped")
			expect(await pathExists(paths.chainRoot)).toBe(true)
			expect(await pathExists(worktreePath)).toBe(true)
			for (let index = 0; index < 3; index += 1) expectOk(await request(fixture, "daemon.status"))
			const failedStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const root = failedStore.getTaskTree(chainId)?.root
				if (root?.kind !== "seq") throw new Error("expected retained seq task tree")
				const closure = root.children.find((node) => node.kind === "leaf" && node.closure.phase === "iteration")
				if (closure?.kind !== "leaf") throw new Error("expected retained iteration closure")
				expect(closure.closure).toMatchObject({ lifecycle: "consumed", worktreePath, branchName, sessions: [] })
				expect(failedStore.listItems(chainId).find((entry) => entry.itemId === "560-delete-retry")?.attempts).toBe(attemptsBeforeDelete)
			} finally { failedStore.close() }

			await rename(unavailableTarget, target)
			await fixture.daemon.stop()
			const restarted = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
			try {
				const reconciliation = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
					chain: "delete-incomplete-cleanup",
					type: "closure.reconciled",
				})
				expect(reconciliation.events.some((event) => JSON.stringify(event).includes("orphan-directory"))).toBe(true)
				expect(reconciliation.events.some((event) => JSON.stringify(event).includes("orphan-branch"))).toBe(true)
				expect(await pathExists(worktreePath)).toBe(false)
				expect(Bun.spawnSync({ cmd: ["git", "show-ref", "--verify", "--quiet", branchName], cwd: target, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(1)

				const retried = expectOk(await sendDaemonRequest(restarted.snapshot().socketPath, daemonRequest("chain.delete", { chainId })))
				expect(retried).toMatchObject({ alreadyDeleted: false, chain: { status: "deleted" }, cleanup: { chainRootRemoved: true } })
				const consumption = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
					chain: "delete-incomplete-cleanup",
					type: "closure.consumed",
				})
				expect(consumption.events).toHaveLength(1)
				expect(consumption.events[0]).toMatchObject({
					type: "closure.consumed",
					payload: {
						evidence: "unevaluable",
						freshness: { kind: "no-origin", availability: "unavailable" },
					},
				})
				expect(await pathExists(paths.chainRoot)).toBe(false)
			} finally {
				await restarted.stop()
			}
		} finally {
			if (await pathExists(unavailableTarget)) await rename(unavailableTarget, target)
			await fixture.daemon.stop()
		}
	})

	test("socket completed chain removes scheduler worktree registration and preserves audit runtime", async () => {
		const fixture = await startFixture("chain-complete-cleanup", { realWorktreeManager: true })
		const target = fixture.loopDataRoot + "-target"
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "complete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, itemId: "351003", repoCwd: target })
			await waitFor(
				async () =>
					fixture.schedulerEvents.find(
						(event): event is Extract<SchedulerEvent, { type: "chain.completed" }> => event.type === "chain.completed" && event.chainId === chainId,
					) ?? null,
				(event) => event !== null,
				10_000,
			)

			const storedChain = await readChain(fixture.loopDataRoot, chainId)
			if (storedChain === null) throw new Error("expected chain record")
			const completedItem = await readItem(fixture.loopDataRoot, chainId, 351_003)
			if (completedItem === null || completedItem.lastRunId === null) throw new Error("expected completed item run id")
			const paths = resolveChainRuntimePaths("complete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const worktreePath = closureWorktreePath(fixture.loopDataRoot, storedChain.name, target, `closure:${completedItem.id}:iteration`)
			const reviewWorktreePath = closureWorktreePath(fixture.loopDataRoot, storedChain.name, target, `closure:${completedItem.id}:review`)
			const taskStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			const taskRoot = taskStore.getTaskTree(chainId)?.root ?? null
			taskStore.close()
			if (taskRoot === null || taskRoot.kind !== "seq") throw new Error("expected completed seq task tree")
			const phaseClosures = taskRoot.children.flatMap((node) => node.kind === "leaf" ? [node.closure] : [])
			const iterationClosure = phaseClosures.find((closure) => closure.phase === "iteration")
			const reviewClosure = phaseClosures.find((closure) => closure.phase === "review")
			if (iterationClosure === undefined || reviewClosure === undefined) throw new Error("expected iteration and review closures")

			expect(storedChain.status).toBe("completed")
			expect(await pathExists(worktreePath)).toBe(false)
			expect(await pathExists(reviewWorktreePath)).toBe(false)
			expect(iterationClosure).toMatchObject({ lifecycle: "consumed", worktreePath: null, branchName: null, sessions: [] })
			expect(reviewClosure).toMatchObject({ lifecycle: "consumed", worktreePath: null, branchName: null, sessions: [] })
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(worktreePath)
			expect(gitOutput(target, ["worktree", "list", "--porcelain"])).not.toContain(reviewWorktreePath)
			expect(await pathExists(paths.chainRoot)).toBe(true)
			expect(await pathExists(paths.runsDir)).toBe(true)
			expect(await pathExists(paths.runEventsFile(completedItem.lastRunId))).toBe(false)
			const events = await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile, {
				chain: "complete-cleanup",
				type: "chain.completed",
			})
			expect(events.events).toHaveLength(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete terminates active runs before marking chain deleted", async () => {
		const fixture = await startFixture("chain-delete-active-run", { schedulerIntervalMs: 20 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-active-run",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "220",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const startedAt = Date.now()
			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))

			expect(Date.now() - startedAt).toBeLessThan(4_000)
			expect(deleted).toMatchObject({
				alreadyDeleted: false,
				chain: { status: "deleted" },
				// A force-killed agent never wrote its own status, so the item keeps its entry status.
				terminatedRuns: [{
					chainId,
					itemId,
					exitCode: 1,
					status: runtimeStatus("queued"),
				}],
				cleanup: { chainRootRemoved: true },
			})
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])

			const status = record(expectOk(await request(fixture, "chain.status", { chainId })))
			expect(record(status.chain).status).toBe("deleted")
			expect(status.activeRuns).toEqual([])
			expect(record(status.summary).activeSlots).toEqual([])
			expect(record(record(status.summary).items).byStatus).toEqual({ queued: 1 })
			expect(await pathExists(resolveChainRuntimePaths("delete-active-run", { loopDataRoot: fixture.loopDataRoot }).chainRoot)).toBe(false)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("auto chain completion", async () => {
		const fixture = await startFixture("completion")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "completion-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "180",
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: runtimeStatus("done"),
			})

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("terminal item.update sets terminal status; active run finishes naturally, then chain completes", async () => {
		const fixture = await startFixture("terminal-update-active-run")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "terminal-update-active-run-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "249",
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 500, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { phase: "review", updatedAt: 1_800_020_200 })
			} finally {
				store.close()
			}

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: runtimeStatus("done"),
			})).item)

			expect(updated).toMatchObject({ id: itemId, status: runtimeStatus("done") })
			// item.update no longer terminates the active run. The run finishes naturally,
			// then the close handler completes the chain (item already terminal).
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({ type: "agent.exit", itemId, status: runtimeStatus("done") }))
			const chainCompleted = await waitFor(
				async () => fixture.schedulerEvents.find((event) => event.type === "chain.completed" && event.chainId === chainId) ?? null,
				(event) => event !== null,
			)
			expect(chainCompleted).toMatchObject({ type: "chain.completed", chainId })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.stop terminates active runs and preserves stopped chain runtime", async () => {
		const fixture = await startFixture("chain-stop-active-run")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-stop-active-run",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "349201",
				repoCwd: REPO_ROOT,
				extra: {
					sleepMs: 5_000,
					summary: "ITERATION SUMMARY: fake iteration in progress",
				},
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const currentChain = await readChain(fixture.loopDataRoot, chainId)
			if (currentChain === null) throw new Error("expected chain")
			const lookup = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let worktreePath: string
			try {
				const root = lookup.getTaskTree(chainId)?.root
				if (root?.kind !== "seq") throw new Error("expected seq task tree")
				const iteration = root.children.find((node) => node.kind === "leaf" && node.closure.phase === "iteration")
				if (iteration?.kind !== "leaf") throw new Error("expected iteration closure")
				worktreePath = closureWorktreePath(fixture.loopDataRoot, currentChain.name, REPO_ROOT, iteration.closure.closureId)
			} finally { lookup.close() }
			const stopped = record(expectOk(await request(fixture, "chain.stop", { chainId })))

			expect(record(stopped.chain).status).toBe("stopped")
			expect(stopped.alreadyStopped).toBe(false)
			expect(Array.isArray(stopped.terminatedRuns)).toBe(true)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])
			expect(await pathExists(resolveChainRuntimePaths("chain-stop-active-run", { loopDataRoot: fixture.loopDataRoot }).chainRoot)).toBe(true)
			expect(await pathExists(worktreePath)).toBe(true)

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(itemId, { status: runtimeStatus("done"), updatedAt: 1_800_034_900 })
			} finally {
				store.close()
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 80))
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("stopped")
			expect((await readItem(fixture.loopDataRoot, chainId, 349_201))?.status).toBe("done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.resume restores scheduling for a stopped chain", async () => {
		const fixture = await startFixture("chain-resume-schedules")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "chain-resume-schedules",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			expect(record(expectOk(await request(fixture, "chain.stop", { chainId })).chain).status).toBe("stopped")

			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.createItem({
					chainId,
					itemId: "349202",
					repoCwd: REPO_ROOT,
					status: runtimeStatus("queued"),
					attempts: 0,
					extra: storedItemExtra({
						sleepMs: 200,
						summary: "ITERATION SUMMARY: fake iteration in progress",
					}),
				})
			} finally {
				store.close()
			}

			const resumed = record(expectOk(await request(fixture, "chain.resume", { chainId })))
			expect(record(resumed.chain).status).toBe("active")
			expect(resumed.alreadyActive).toBe(false)
			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 349_202), (item) => item?.phase === "iteration" && item.attempts > 0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon survives all chains complete", async () => {
		const fixture = await startFixture("survives-complete")
		try {
			const first = record(expectOk(await request(fixture, "chain.create", {
				name: "first-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId: numberValue(first.id),
				itemId: "180",
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: runtimeStatus("done"),
			})
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, numberValue(first.id)), (status) => status === "completed")

			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
			await request(fixture, "chain.create", {
				name: "second-chain",
				repository: "mouriya-s-lab/coder-loop",
			})
			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(2)
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).running).toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon allows the full operator-issued chain/queue/inspect surface (#409 row 4)", async () => {
		const fixture = await startFixture("409-row4-operator", { schedulerEnabled: false })
		try {
			const created = record(expectOk(await request(fixture, "chain.create", {
				name: "409-row4-operator-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(created.id)

			// Operator queue surface: add, list, reorder, queue.unblock (after dropping the item to
			// a preset-unblockable status via item.update).
			const addedA = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "409400",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			const addedB = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "409401",
				repoCwd: REPO_ROOT,
				preset: "gh-issue-pr-iteration",
			})).item)
			expect(numberValue(addedA.id)).toBeGreaterThan(0)
			expect(numberValue(addedB.id)).toBeGreaterThan(0)

			const listed = record(expectOk(await request(fixture, "item.list", { chainId })))
			const items = Array.isArray(listed.items) ? listed.items : []
			expect(items.length).toBe(2)

			const reordered = expectOk(await request(fixture, "item.reorder", {
				chainId,
				itemId: "409401",
				position: 0,
			}))
			const reorderedItems = Array.isArray(reordered.items) ? reordered.items : []
			expect(reorderedItems.length).toBe(2)

			// Drive an item to a preset-unblockable status (gh-issue-pr-iteration has `blocked` in
			// its unblockable set) so queue.unblock has work to do.
			expectOk(await request(fixture, "item.update", {
				chainId,
				itemId: "409400",
				status: "blocked",
			}))
			const unblock = record(expectOk(await request(fixture, "queue.unblock", {
				chainName: "409-row4-operator-chain",
				issue: "409400",
			})))
			const mutation = record(unblock.mutation)
			expect(mutation.changed).toBe(true)
			expect(mutation.afterStatus).toBe("queued")

			// Inspect surface: logs.query, daemon.status, chain.list, chain.status are all OK.
			const operatorLogs = expectOk(await request(fixture, "logs.query", {}))
			expect(Array.isArray(operatorLogs.events)).toBe(true)
			expectOk(await request(fixture, "daemon.status", {}))
			expectOk(await request(fixture, "chain.list", {}))
			expectOk(await request(fixture, "chain.status", { chainName: "409-row4-operator-chain" }))

			// Chain lifecycle (stop / resume / delete) all succeed for operator.
			expectOk(await request(fixture, "chain.stop", { chainName: "409-row4-operator-chain" }))
			expectOk(await request(fixture, "chain.resume", { chainName: "409-row4-operator-chain" }))
			expectOk(await request(fixture, "chain.delete", { chainName: "409-row4-operator-chain" }))

			// Audit replay: every operator-issued gated op left one allow event with
			// reason=operator. The set of ops we exercised on the per-phase / hard-deny path:
			// chain.create, item.reorder (per-phase), queue.unblock, logs.query, chain.stop,
			// chain.resume, chain.delete. Other ops (item.add / item.update / item.list /
			// daemon.status / chain.list / chain.status) are not on the gated list and emit no
			// privileged_op.caller_admission events.
			const eventsPath = resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile
			const events = (await queryObservabilityEvents(eventsPath)).events
			const operatorAllows = events.filter((event) =>
				event.kind === "audit"
				&& event.type === "privileged_op.caller_admission"
				&& event.payload.outcome === "allow"
				&& event.payload.reason === "operator",
			)
			const expectedOperatorOps = new Set([
				"chain.create",
				"item.reorder",
				"queue.unblock",
				"logs.query",
				"chain.stop",
				"chain.resume",
				"chain.delete",
			])
			for (const expectedOp of expectedOperatorOps) {
				const match = operatorAllows.find((event) =>
					event.kind === "audit"
					&& event.type === "privileged_op.caller_admission"
					&& event.payload.op === expectedOp,
				)
				expect(match, `expected operator allow for ${expectedOp}`).toBeDefined()
			}
		} finally {
			await fixture.daemon.stop()
		}
	}, 30_000)
})
