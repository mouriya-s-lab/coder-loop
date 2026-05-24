import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
	DaemonError,
	daemonRequest,
	sendDaemonRequest,
	startCoderLoopDaemon,
	type CoderLoopDaemon,
	type DaemonResponse,
} from "./daemon"
import { createGitWorktreeManager, schedulerSlotWorktreePath, type SchedulerEvent, type SchedulerOptions, type SchedulerWorktreeManager } from "./scheduler"
import { resolveChainRuntimePaths } from "./runtime-paths"
import { openSqliteStateStore } from "./sqlite-state"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/dt", String(process.pid))
const PRESET_DIR = resolve(REPO_ROOT, "presets/gh-issue-pr-iteration")

let nextFixtureId = 0

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("daemon", () => {
	test("daemon up creates socket and pid", async () => {
		const fixture = await startFixture("up", { schedulerEnabled: false })
		try {
			expect(await pathIsSocket(fixture.socketPath)).toBe(true)
			expect((await readFile(fixture.pidFile, "utf-8")).trim()).toBe(String(process.pid))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.create", async () => {
		const fixture = await startFixture("chain-create", { schedulerEnabled: false })
		try {
			const result = expectOk(await request(fixture, "chain.create", {
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				umbrellaIssue: 176,
				metadata: { runner: "codex" },
			}))

			expect(result.chain).toMatchObject({
				name: "central-state",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: { runner: "codex" },
			})
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
				metadata: { runner: "codex" },
			})).chain)

			const repeated = record(expectOk(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { runner: "codex" },
			})).chain)
			expect(repeated.id).toBe(first.id)
			expect(repeated).toMatchObject({
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { runner: "codex" },
			})

			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/different",
				baseBranch: "main",
				metadata: { runner: "codex" },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "develop",
				metadata: { runner: "codex" },
			}))
			expectConflict(await request(fixture, "chain.create", {
				name: "stable-chain",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				metadata: { runner: "claude" },
			}))

			const listed = expectOk(await request(fixture, "chain.list")).chains
			expect(Array.isArray(listed)).toBe(true)
			if (!Array.isArray(listed)) throw new Error("expected chain list array")
			expect(listed).toHaveLength(1)
			const [listedChain] = listed
			expect(record(listedChain)).toMatchObject({ repository: "mouriya-s-lab/coder-loop", baseBranch: "main", metadata: { runner: "codex" } })
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

	test("socket chain.create validates umbrellaIssue as positive or null", async () => {
		const fixture = await startFixture("chain-create-invalid-umbrella-issue", { schedulerEnabled: false })
		try {
			for (const umbrellaIssue of [0, -1]) {
				const response = await request(fixture, "chain.create", {
					name: `umbrella-check-${umbrellaIssue}`,
					repository: "mouriya-s-lab/coder-loop",
					umbrellaIssue,
				})

				expectInvalid(response)
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			const nullUmbrella = record(expectOk(await request(fixture, "chain.create", {
				name: "null-umbrella",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaIssue: null,
			})).chain)
			expect(nullUmbrella).toMatchObject({ umbrellaIssue: null })

			const positiveUmbrella = record(expectOk(await request(fixture, "chain.create", {
				name: "positive-umbrella",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaIssue: 1,
			})).chain)
			expect(positiveUmbrella).toMatchObject({ umbrellaIssue: 1 })
		} finally {
			await fixture.daemon.stop()
		}
	})

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

			expect(Object.prototype).not.toHaveProperty("polluted")
			const validMetadata = { runner: "codex", nested: nestedMetadata(7), list: [{ leaf: "ok" }] }
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

	test("daemon startup skips invalid existing chain rows", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-invalid-existing-chain`)
		const loopDataRoot = resolve(root, "ld")
		await mkdir(loopDataRoot, { recursive: true })
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			store.createChain({
				name: "..",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: {},
			})
			store.createChain({
				name: "valid-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: {},
			})
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			expect(daemon.snapshot().running).toBe(true)
			const listed = expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.list"))).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(2)
			expect(await pathExists(resolveChainRuntimePaths("valid-chain", { loopDataRoot }).sharedFile)).toBe(true)
		} finally {
			await daemon.stop()
		}
	})

	test("daemon startup quarantines chain directories missing from DB", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-orphan-chain-directory`)
		const loopDataRoot = resolve(root, "ld")
		const orphanPath = resolve(loopDataRoot, "chains", "Z", "issues")
		await mkdir(orphanPath, { recursive: true })

		const daemon = await startCoderLoopDaemon({ loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			expect(daemon.snapshot().running).toBe(true)
			expect(await pathExists(resolve(loopDataRoot, "chains", "Z"))).toBe(false)
			const entries = await readdir(resolve(loopDataRoot, "chains"))
			const orphanDir = entries.find((entry) => entry.startsWith(".orphan-"))
			expect(orphanDir).toBeDefined()
			if (orphanDir === undefined) throw new Error("expected orphan quarantine directory")
			expect(await pathExists(resolve(loopDataRoot, "chains", orphanDir, "Z", "issues"))).toBe(true)
			const listed = expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.list"))).chains
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)
		} finally {
			await daemon.stop()
		}
	})

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
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				title: "feat: 单进程 daemon",
				extra: { sleepMs: 5 },
			})).item)
			expect(added).toMatchObject({ issueNumber: 180, status: "queued", title: "feat: 单进程 daemon" })

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: "done", pr: 190, title: "updated daemon item" },
			})).item)
			expect(updated).toMatchObject({ status: "done", pr: 190, title: "updated daemon item" })
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
				issueNumber: 242,
				repoCwd: REPO_ROOT,
			})).item)

			const duplicate = await request(fixture, "item.add", {
				chainId,
				issueNumber: 242,
				repoCwd: REPO_ROOT,
			})
			expectConflict(duplicate)
			if (duplicate.ok) throw new Error("expected duplicate item.add to fail")
			expect(duplicate.error.message).toBe("item with issueNumber 242 already exists in chain duplicate-item-chain")
			expect(JSON.stringify(duplicate.error)).not.toContain("UNIQUE constraint")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.chain_id")
			expect(JSON.stringify(duplicate.error)).not.toContain("items.issue_number")
			expect(record(duplicate.error.details)).toMatchObject({
				chainId,
				chainName: "duplicate-item-chain",
				issueNumber: 242,
				existingItemId: numberValue(first.id),
			})

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			if (!Array.isArray(listed)) throw new Error("expected item.list items array")
			expect(listed).toHaveLength(1)
			expect(record(listed[0])).toMatchObject({ id: numberValue(first.id), issueNumber: 242 })
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
				{ issueNumber: 0, repoCwd: REPO_ROOT },
				{ issueNumber: -1, repoCwd: REPO_ROOT },
				{ issueNumber: 181, repoCwd: "relative/path" },
				{ issueNumber: 182, repoCwd: resolve(REPO_ROOT, "missing-coder-loop-test-dir") },
				{ issueNumber: 183, repoCwd: `${REPO_ROOT}\nchild` },
				{ issueNumber: 184, repoCwd: `${REPO_ROOT}\u0000child` },
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
				issueNumber: 246,
				repoCwd: REPO_ROOT,
				title: "strict add item",
				priority: "high",
				branch: "feature/issue-246",
				pr: 254,
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				runner: "codex",
				extra: { note: "allowed" },
			})).item)
			expect(added).toMatchObject({
				issueNumber: 246,
				status: "queued",
				attempts: 0,
				priority: "high",
				branch: "feature/issue-246",
				pr: 254,
				issueFile: "issues/246.md",
				evidenceDir: absoluteEvidenceDir,
				lastRunId: null,
				agentCwd: null,
				runner: "codex",
			})

			const invalidRequests = [
				{ issueNumber: 601, repoCwd: REPO_ROOT, status: "done" },
				{ issueNumber: 602, repoCwd: REPO_ROOT, attempts: 999 },
				{ issueNumber: 603, repoCwd: REPO_ROOT, lastRunId: "hacked" },
				{ issueNumber: 604, repoCwd: REPO_ROOT, agentCwd: "/etc/passwd" },
				{ issueNumber: 605, repoCwd: REPO_ROOT, id: 1 },
				{ issueNumber: 606, repoCwd: REPO_ROOT, createdAt: 1 },
				{ issueNumber: 607, repoCwd: REPO_ROOT, updatedAt: 1 },
				{ issueNumber: 608, repoCwd: REPO_ROOT, branch: "../../etc/passwd" },
				{ issueNumber: 609, repoCwd: REPO_ROOT, issueFile: "../../etc/passwd" },
				{ issueNumber: 610, repoCwd: REPO_ROOT, evidenceDir: "/etc/coder-loop-evidence" },
				{ issueNumber: 611, repoCwd: REPO_ROOT, random_field: "hack" },
				{ issueNumber: 612, repoCwd: REPO_ROOT, title: "bad\nline" },
				{ issueNumber: 613, repoCwd: REPO_ROOT, priority: "garbage-xyz" },
				{ issueNumber: 614, repoCwd: REPO_ROOT, priority: 999 },
				{ issueNumber: 615, repoCwd: REPO_ROOT, pr: -1 },
				{ issueNumber: 616, repoCwd: REPO_ROOT, extra: JSON.parse(`{"__proto__":{"polluted":1}}`) },
				{ issueNumber: 617, repoCwd: REPO_ROOT, extra: { "": "empty-key" } },
				{ issueNumber: 618, repoCwd: REPO_ROOT, extra: nestedMetadata(9) },
			]
			for (const args of invalidRequests) expectInvalid(await request(fixture, "item.add", { chainId, ...args }))

			expectTooLarge(await request(fixture, "item.add", {
				chainId,
				issueNumber: 619,
				repoCwd: REPO_ROOT,
				extra: { k: "x".repeat(17 * 1024) },
			}))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(Array.isArray(listed) ? listed[0] : null)).toMatchObject({ issueNumber: 246 })
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
				issueNumber: 185,
				repoCwd: REPO_ROOT,
			})).item)

			expect(added).toMatchObject({ issueNumber: 185, status: "queued", repoCwd: REPO_ROOT })
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
			const first = record(expectOk(await request(fixture, "item.add", { chainId, issueNumber: 186, repoCwd: REPO_ROOT })).item)
			const second = record(expectOk(await request(fixture, "item.add", { chainId, issueNumber: 187, repoCwd: REPO_ROOT })).item)
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

	test("socket item status validation follows the chain preset", async () => {
		const fixture = await startFixture("item-status-preset", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "single-phase-chain",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)

			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				issueNumber: 188,
				repoCwd: REPO_ROOT,
			})).item)
			expect(added).toMatchObject({ issueNumber: 188, status: "queued" })
			const pending = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "pending",
			})).item)
			expect(pending).toMatchObject({ issueNumber: 188, status: "pending" })

			expectInvalid(await request(fixture, "item.update", { itemId: numberValue(added.id), status: "changes_requested" }))
		} finally {
			await fixture.daemon.stop()
		}
	})

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
				issueNumber: 221,
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			const invalidRequests = [
				{ itemId },
				{ itemId, chainId: otherChainId, status: "done" },
				{ itemId, issueNumber: 999, status: "done" },
				{ itemId, id: itemId, status: "done" },
				{ itemId, createdAt: 1, status: "done" },
				{ itemId, updatedAt: 1, status: "done" },
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
				issueNumber: 221,
				status: "queued",
				attempts: 0,
				lastRunId: null,
				agentCwd: null,
			})
			const otherItems = expectOk(await request(fixture, "item.list", { chainId: otherChainId })).items
			expect(Array.isArray(otherItems)).toBe(true)
			expect(otherItems).toHaveLength(0)

			const updated = record(expectOk(await request(fixture, "item.update", {
				chainId,
				issueNumber: 221,
				fields: { status: "done", title: "strict item update" },
			})).item)
			expect(updated).toMatchObject({ id: itemId, chainId, issueNumber: 221, status: "done", title: "strict item update" })
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
				issueNumber: 226,
				repoCwd: REPO_ROOT,
			})).item)
			const itemId = numberValue(added.id)

			expectOk(await request(fixture, "chain.delete", { chainId }))

			expectChainDeleted(await request(fixture, "item.add", {
				chainId,
				issueNumber: 227,
				repoCwd: REPO_ROOT,
			}))
			expectChainDeleted(await request(fixture, "item.update", { itemId, status: "done" }))

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(1)
			expect(record(expectOk(await request(fixture, "chain.status", { chainId })).chain).status).toBe("deleted")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("socket chain.delete removes scheduler worktree registration and chain runtime layout", async () => {
		const fixture = await startFixture("chain-delete-cleanup", { realWorktreeManager: true })
		const target = resolve(fixture.loopDataRoot, "..", "target")
		await initGitTarget(target)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "delete-cleanup",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, issueNumber: 225, repoCwd: target })
			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed")

			const storedChain = await readChain(fixture.loopDataRoot, chainId)
			if (storedChain === null) throw new Error("expected chain record")
			const paths = resolveChainRuntimePaths("delete-cleanup", { loopDataRoot: fixture.loopDataRoot })
			const worktreePath = schedulerSlotWorktreePath(storedChain, target, { loopDataRoot: fixture.loopDataRoot })
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
				issueNumber: 220,
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
				terminatedRuns: [{
					chainId,
					itemId,
					exitCode: 1,
					status: "changes_requested",
				}],
				cleanup: { chainRootRemoved: true },
			})
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])

			const status = record(expectOk(await request(fixture, "chain.status", { chainId })))
			expect(record(status.chain).status).toBe("deleted")
			expect(status.activeRuns).toEqual([])
			expect(record(status.summary).activeSlots).toEqual([])
			expect(record(record(status.summary).items).byStatus).toEqual({ changes_requested: 1 })
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
				issueNumber: 180,
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "done",
			})

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed")
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
				issueNumber: 180,
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "done",
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

	test("daemon graceful shutdown", async () => {
		const fixture = await startFixture("graceful-shutdown")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			expect(await pathExists(fixture.socketPath)).toBe(false)
			expect(await pathExists(fixture.pidFile)).toBe(false)
			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			expect(item?.status).toBe("changes_requested")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(1)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown preserves user terminal item status", async () => {
		const fixture = await startFixture("terminal-shutdown")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "terminal-shutdown-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})).item)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				fields: { status: "done" },
			})).item)
			expect(updated.status).toBe("done")

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			expect(item?.status).toBe("done")
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("completed")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon startup recovers stale in_progress item and process group", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-recovery`)
		const loopDataRoot = resolve(root, "ld")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")

		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "startup-recovery-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: {},
			})
			const item = store.createItem({
				chainId: chain.id,
				issueNumber: 217,
				repoCwd: REPO_ROOT,
				status: "in_progress",
				attempts: 1,
				lastRunId: "run-stale-217",
				agentCwd: resolve(root, "worktree"),
				title: "stale item",
				extra: {},
			})
			store.recordRun({
				runId: "run-stale-217",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_000,
				extra: {},
			})
			store.setCurrentRun({
				chainId: chain.id,
				phase: "iteration",
				runId: "run-stale-217",
				startedAt: 1_800_000_000,
				extra: { itemId: item.id, pid: stale.pid, processGroupLeader: true },
			})
		} finally {
			store.close()
		}

		const daemon = await startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 50,
			scheduler: { enabled: false },
		})
		try {
			expect(await waitForPidExit(stale.pid, 1_000)).toBe(true)
			const recovered = await readItem(loopDataRoot, 1, 217)
			expect(recovered?.status).toBe("changes_requested")
			expect(recovered?.attempts).toBe(1)
			expect(await readCurrentRun(loopDataRoot, 1)).toBeNull()
			const status = record(expectOk(await sendDaemonRequest(daemon.snapshot().socketPath, daemonRequest("chain.status", { chainName: "startup-recovery-chain" }))))
			expect(record(status.summary).recovery).toEqual({ needed: false, staleInProgressItems: [] })
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already reaped by daemon startup recovery.
				}
			}
			await daemon.stop()
		}
	})

	test("daemon startup rejects socket commands before stale recovery finishes", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-recovery-socket`)
		const loopDataRoot = resolve(root, "ld")
		const socketPath = resolve(loopDataRoot, "daemon.sock")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")

		const store = openSqliteStateStore({ loopDataRoot })
		try {
			const chain = store.createChain({
				name: "startup-recovery-socket-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				baseBranch: "main",
				status: "active",
				metadata: {},
			})
			const item = store.createItem({
				chainId: chain.id,
				issueNumber: 238,
				repoCwd: REPO_ROOT,
				status: "in_progress",
				attempts: 1,
				lastRunId: "run-stale-238",
				agentCwd: resolve(root, "worktree"),
				title: "stale item",
				extra: {},
			})
			store.recordRun({
				runId: "run-stale-238",
				chainId: chain.id,
				itemId: item.id,
				phase: "iteration",
				startedAt: 1_800_000_000,
				extra: {},
			})
			store.setCurrentRun({
				chainId: chain.id,
				phase: "iteration",
				runId: "run-stale-238",
				startedAt: 1_800_000_000,
				extra: { itemId: item.id, pid: stale.pid, processGroupLeader: true },
			})
		} finally {
			store.close()
		}

		const startPromise = startCoderLoopDaemon({
			loopDataRoot,
			shutdownGraceMs: 500,
			scheduler: { enabled: false },
		})
		await new Promise((resolveWait) => setTimeout(resolveWait, 100))
		expect(await pathIsSocket(socketPath)).toBe(true)
		const earlyResponse = await sendDaemonRequest(socketPath, daemonRequest("daemon.down", {}))
		expect(earlyResponse.ok).toBe(false)
		if (!earlyResponse.ok) expect(earlyResponse.error.code).toBe("daemon_starting")

		const daemon = await startPromise
		try {
			expect(await pathIsSocket(socketPath)).toBe(true)
			expect(await waitForPidExit(stale.pid, 1_000)).toBe(true)
			expect((await readItem(loopDataRoot, 1, 238))?.status).toBe("changes_requested")
			expect(await readCurrentRun(loopDataRoot, 1)).toBeNull()
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already reaped by daemon startup recovery.
				}
			}
			await daemon.stop()
		}
	})

	test("chain status marks stale in_progress rows without active slots", async () => {
		const fixture = await startFixture("status-recovery-marker", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "status-recovery-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				issueNumber: 217,
				repoCwd: REPO_ROOT,
			})).item)
			await request(fixture, "item.update", {
				itemId: numberValue(added.id),
				status: "in_progress",
			})

			const status = record(expectOk(await request(fixture, "chain.status", { chainId })))
			expect(record(status.summary).activeSlots).toEqual([])
			expect(record(record(status.summary).items).byStatus).toEqual({ in_progress: 1 })
			expect(record(status.summary).recovery).toMatchObject({
				needed: true,
				staleInProgressItems: [{ issueNumber: 217, repoCwd: REPO_ROOT }],
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("subprocess exit callback writes db", async () => {
		const fixture = await startFixture("exit-callback", { schedulerIntervalMs: 1_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "exit-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 180,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 7 },
			})

			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 180), (candidate) => candidate?.status === "changes_requested")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(7)
			expect(typeof run?.endedAt).toBe("number")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler writes run artifacts and per-chain daemon log", async () => {
		const fixture = await startFixture("scheduler-artifacts", { schedulerIntervalMs: 1_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-artifacts-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 203,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})

			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 203), (candidate) => candidate?.status === "done")
			const runId = item?.lastRunId ?? ""
			const paths = resolveChainRuntimePaths("scheduler-artifacts-chain", { loopDataRoot: fixture.loopDataRoot })
			const status = JSON.parse(await readFile(paths.runStatusFile(runId), "utf-8")) as Record<string, unknown>
			const stdout = await readFile(paths.runStdoutFile(runId), "utf-8")
			const stderr = await readFile(paths.runStderrFile(runId), "utf-8")
			const events = (await readFile(paths.runEventsFile(runId), "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string })
			const daemonBatches = await readdir(paths.daemonDir)
			const daemonLog = await readFile(paths.daemonLogFile(daemonBatches[0]!), "utf-8")

			expect(status).toMatchObject({ runId, chainId, issueNumber: 203, phase: "iteration", exitCode: 0, status: "done" })
			expect(stdout).toContain("done:")
			expect(stderr).toBe("")
			expect(events.map((event) => event.type)).toEqual(["agent.spawn", "agent.exit", "chain.completed"])
			expect(daemonLog).toContain("scheduler.event")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler uses bundled preset directory from the chain", async () => {
		const fixture = await startFixture("scheduler-chain-preset", { schedulerIntervalMs: 1_000, schedulerPresetDir: null })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-chain-preset",
				preset: "single-phase-example",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 215,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})

			await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 215), (candidate) => candidate?.status === "done")
			const spawnEvent = fixture.schedulerEvents.find((event) => event.type === "agent.spawn")
			expect(spawnEvent).toMatchObject({
				type: "agent.spawn",
				chainId,
				presetDir: resolve(REPO_ROOT, "presets/single-phase-example"),
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon db unavailable explicit fail", async () => {
		const rootFile = resolve(TEST_ROOT, `not-a-dir-${++nextFixtureId}`)
		await mkdir(resolve(rootFile, ".."), { recursive: true })
		await writeFile(rootFile, "not a directory")

		try {
			await startCoderLoopDaemon({ loopDataRoot: rootFile })
			throw new Error("expected daemon start to fail")
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonError)
			expect((error as DaemonError).code).toBe("db_unavailable")
		}
	})

	test("unknown command rejected", async () => {
		const fixture = await startFixture("unknown-command", { schedulerEnabled: false })
		try {
			const response = await sendDaemonRequest(fixture.socketPath, { id: "unknown", command: "chain.archive", args: {} })
			expect(response.ok).toBe(false)
			if (!response.ok) expect(response.error.code).toBe("unknown_command")
		} finally {
			await fixture.daemon.stop()
		}
	})
})

type Fixture = {
	daemon: CoderLoopDaemon
	loopDataRoot: string
	socketPath: string
	pidFile: string
	eventLog: string
	schedulerEvents: SchedulerEvent[]
}

type FixtureOptions = {
	schedulerEnabled?: boolean
	schedulerIntervalMs?: number
	schedulerPresetDir?: string | null
	realWorktreeManager?: boolean
	worktreeManager?: SchedulerWorktreeManager
}

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const fakeRunner = resolve(root, "fake-runner.ts")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	await writeFakeRunner(fakeRunner)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = options.worktreeManager ?? (options.realWorktreeManager ? createGitWorktreeManager({ loopDataRoot }) : async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	})

	const scheduler: SchedulerOptions["runner"] = {
		kind: "claude",
		source: "iteration-default",
		binary: "bun",
		extraArgs: [fakeRunner],
		model: null,
	}
	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		shutdownGraceMs: 100,
		scheduler: {
			enabled: options.schedulerEnabled ?? true,
			intervalMs: options.schedulerIntervalMs ?? 20,
			runner: scheduler,
			...(options.schedulerPresetDir === null ? {} : { presetDir: options.schedulerPresetDir ?? PRESET_DIR }),
			worktreeManager,
			prompt: ({ item, runId }) =>
				JSON.stringify({
					itemId: item.id,
					issueNumber: item.issueNumber,
					runId,
					eventLog,
					sleepMs: typeof item.extra.sleepMs === "number" ? item.extra.sleepMs : 5,
					exitCode: typeof item.extra.exitCode === "number" ? item.extra.exitCode : 0,
				}),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, pidFile: snapshot.pidFile, eventLog, schedulerEvents }
}

async function request(fixture: Fixture, command: string, args = {}): Promise<DaemonResponse> {
	return await sendDaemonRequest(fixture.socketPath, { id: `${command}-${Date.now()}`, command, args })
}

function expectOk(response: DaemonResponse) {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
	return response.result
}

function expectInvalid(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("invalid_request")
}

function expectChainDeleted(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("chain_deleted")
}

function expectConflict(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("conflict")
}

function expectTooLarge(response: DaemonResponse): void {
	expect(response.ok).toBe(false)
	if (!response.ok) expect(response.error.code).toBe("request_too_large")
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
	return value as Record<string, unknown>
}

function nestedMetadata(depth: number): Record<string, unknown> {
	let value: unknown = "ok"
	for (let index = 0; index < depth; index++) value = { nest: value }
	return record(value)
}

function numberValue(value: unknown): number {
	if (typeof value !== "number") throw new Error("expected number")
	return value
}

async function readChainStatus(loopDataRoot: string, chainId: number): Promise<string | null> {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getChain(chainId)?.status ?? null
	} finally {
		store.close()
	}
}

async function readChain(loopDataRoot: string, chainId: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getChain(chainId)
	} finally {
		store.close()
	}
}

async function readItem(loopDataRoot: string, chainId: number, issueNumber: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getItemByIssue(chainId, issueNumber)
	} finally {
		store.close()
	}
}

async function readRun(loopDataRoot: string, runId: string) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getRunByRunId(runId)
	} finally {
		store.close()
	}
}

async function readCurrentRun(loopDataRoot: string, chainId: number) {
	const store = openSqliteStateStore({ loopDataRoot })
	try {
		return store.getCurrentRun(chainId)
	} finally {
		store.close()
	}
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
	const startedAt = Date.now()
	let latest = await read()
	while (!predicate(latest)) {
		if (Date.now() - startedAt > timeoutMs) throw new Error(`condition not met; latest=${JSON.stringify(latest)}`)
		await new Promise((resolveWait) => setTimeout(resolveWait, 20))
		latest = await read()
	}
	return latest
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now()
	while (Date.now() - startedAt <= timeoutMs) {
		if (!isPidAlive(pid)) return true
		await new Promise((resolveWait) => setTimeout(resolveWait, 20))
	}
	return !isPidAlive(pid)
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function pathIsSocket(path: string): Promise<boolean> {
	return (await stat(path)).isSocket()
}

async function initGitTarget(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
	gitOutput(path, ["init", "-q"])
	gitOutput(path, ["config", "user.email", "test@example.invalid"])
	gitOutput(path, ["config", "user.name", "Test User"])
	await writeFile(resolve(path, "README.md"), "test\n")
	gitOutput(path, ["add", "README.md"])
	gitOutput(path, ["commit", "-qm", "init"])
}

function gitOutput(cwd: string, args: readonly string[]): string {
	const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
	const stdout = new TextDecoder().decode(proc.stdout).trim()
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim()
		throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${proc.exitCode}): ${stderr}`)
	}
	return stdout
}

async function writeFakeRunner(path: string): Promise<void> {
	await writeFile(
		path,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
console.log("done:" + input.itemId)
process.exit(input.exitCode)
`,
	)
}
