import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
	DaemonError,
	daemonRequest,
	sendDaemonRequest,
	startCoderLoopDaemon,
	type CoderLoopDaemon,
	type DaemonResponse,
} from "./daemon"
import { buildCoderLoopStatusSnapshot } from "./loop"
import {
	createGitWorktreeManager,
	reviewOnEmptyLockPathForChainName,
	schedulerSlotWorktreePath,
	serializeSchedulerReviewOnEmptyLock,
	type SchedulerEvent,
	type SchedulerKindResolver,
	type SchedulerOptions,
	type SchedulerWorktreeManager,
} from "./scheduler"
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

	test("socket chain.create validates umbrellaRepo format", async () => {
		const fixture = await startFixture("chain-create-invalid-umbrella-repo", { schedulerEnabled: false })
		try {
			const invalidUmbrellaRepos = [
				"/etc/passwd",
				"no-slash",
				"a/b/c",
				"foo",
				"https://github.com/owner/repo",
				"bad owner/repo",
				"owner/.",
				"owner/..",
				"owner/repo\u007f",
				"owner-/repo",
			]

			for (const [index, umbrellaRepo] of invalidUmbrellaRepos.entries()) {
				const response = await request(fixture, "chain.create", {
					name: `umbrella-repo-check-${index}`,
					repository: "mouriya-s-lab/coder-loop",
					umbrellaRepo,
				})

				expectInvalid(response)
				if (!response.ok) expect(response.error.message).toContain("umbrellaRepo")
				const listed = expectOk(await request(fixture, "chain.list")).chains
				expect(Array.isArray(listed)).toBe(true)
				expect(listed).toHaveLength(0)
			}

			const nullUmbrellaRepo = record(expectOk(await request(fixture, "chain.create", {
				name: "null-umbrella-repo",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaRepo: null,
			})).chain)
			expect(nullUmbrellaRepo).toMatchObject({ umbrellaRepo: null })

			const validUmbrellaRepo = record(expectOk(await request(fixture, "chain.create", {
				name: "valid-umbrella-repo",
				repository: "mouriya-s-lab/coder-loop",
				umbrellaRepo: "mouriya-s-lab/coder-loop",
			})).chain)
			expect(validUmbrellaRepo).toMatchObject({ umbrellaRepo: "mouriya-s-lab/coder-loop" })
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

			expect(Object.prototype).not.toHaveProperty("polluted")
			const validMetadata = { runner: "codex", maxItemAttempts: 7, nested: nestedMetadata(7), list: [{ leaf: "ok" }] }
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
					{ issueNumber: 25811, repoCwd: REPO_ROOT, title: "valid before invalid" },
					{ issueNumber: 0, repoCwd: REPO_ROOT, title: "invalid issue" },
					{ issueNumber: 25813, repoCwd: REPO_ROOT, title: "valid after invalid" },
				],
			})
			expectInvalid(failed)

			const listed = expectOk(await request(fixture, "item.list", { chainId })).items
			expect(Array.isArray(listed)).toBe(true)
			expect(listed).toHaveLength(0)

			const added = expectOk(await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ issueNumber: 25821, repoCwd: REPO_ROOT, title: "valid one" },
					{ issueNumber: 25822, repoCwd: REPO_ROOT, title: "valid two" },
					{ issueNumber: 25823, repoCwd: REPO_ROOT, title: "valid three" },
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
			expectOk(await request(fixture, "item.add", { chainId, issueNumber: 25901, repoCwd: REPO_ROOT, title: "occupant" }))
			const baseline = expectOk(await request(fixture, "item.list", { chainId })).items as Record<string, unknown>[]
			expect(baseline).toHaveLength(1)

			const failed = await request(fixture, "item.batchAdd", {
				chainId,
				items: [
					{ issueNumber: 25902, repoCwd: REPO_ROOT, title: "would-be first" },
					{ issueNumber: 25901, repoCwd: REPO_ROOT, title: "conflict with occupant" },
					{ issueNumber: 25903, repoCwd: REPO_ROOT, title: "would-be third" },
				],
			})
			expectConflict(failed)

			const after = expectOk(await request(fixture, "item.list", { chainId })).items as Record<string, unknown>[]
			expect(after.map((item) => Number(item.issueNumber))).toEqual([25901])
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

	test("terminal item.update terminates active run and completes chain", async () => {
		const fixture = await startFixture("terminal-update-active-run")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "terminal-update-active-run-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName("terminal-update-active-run-chain", fixture.loopDataRoot)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				issueNumber: 249,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5_000, exitCode: 0 },
			})).item)
			const itemId = numberValue(added.id)
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const updated = record(expectOk(await request(fixture, "item.update", {
				itemId,
				status: "done",
			})).item)

			expect(updated).toMatchObject({ id: itemId, status: "done" })
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("completed")
			expect(record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns).toEqual([])
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({ type: "agent.exit", itemId, status: "done" }))
			expect(fixture.schedulerEvents).toContainEqual(expect.objectContaining({ type: "chain.completed", chainId }))
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

	test("daemon graceful shutdown waits for active runs to finish naturally", async () => {
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
				extra: { sleepMs: 400, exitCode: 0 },
			})
			await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)

			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await fixture.daemon.closed

			expect(await pathExists(fixture.socketPath)).toBe(false)
			expect(await pathExists(fixture.pidFile)).toBe(false)
			const item = await readItem(fixture.loopDataRoot, chainId, 180)
			// Fake runner emits the default REVIEW SUMMARY (verdict=accepted) and exits 0;
			// natural completion via attachRunCloseHandler maps that to "done".
			expect(item?.status).toBe("done")
			expect(typeof item?.lastRunId).toBe("string")
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			// exit 0 (natural exit, not SIGTERM/SIGKILL) is the strongest single proof
			// that daemon waited for the child instead of force-terminating it.
			expect(run?.exitCode).toBe(0)
			expect(await readCurrentRun(fixture.loopDataRoot, chainId)).toBeNull()

			const phaseEnd = fixture.schedulerEvents.find((event) => event.type === "phase.end")
			expect(phaseEnd).toBeDefined()
			expect((phaseEnd as { status?: string }).status).toBe("done")
			const queueTerminal = fixture.schedulerEvents.find((event) => event.type === "queue.terminal")
			expect(queueTerminal).toBeDefined()
			expect((queueTerminal as { terminalStatus?: string }).terminalStatus).toBe("done")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown does not return before active runs exit", async () => {
		const fixture = await startFixture("graceful-shutdown-timing")
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "shutdown-timing-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const childSleepMs = 500
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 181,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: childSleepMs, exitCode: 0 },
			})
			const activeRuns = await waitFor(async () => record(expectOk(await request(fixture, "daemon.status")).daemon).activeRuns, (runs) => Array.isArray(runs) && runs.length === 1)
			const startedAt = Date.now()
			const firstRun = (activeRuns as unknown as Array<{ startedAt?: number }>)[0]
			const spawnedAt = typeof firstRun?.startedAt === "number" ? firstRun.startedAt : startedAt
			const remainingSleepMs = Math.max(0, spawnedAt + childSleepMs - startedAt)

			const downStartedAt = Date.now()
			expect((await request(fixture, "daemon.down")).ok).toBe(true)
			await fixture.daemon.closed
			const shutdownDurationMs = Date.now() - downStartedAt

			// Allow some scheduler-tick latency, but if the daemon force-killed the
			// child mid-sleep this would resolve in tens of milliseconds.
			expect(shutdownDurationMs).toBeGreaterThanOrEqual(Math.max(50, remainingSleepMs - 100))

			const item = await readItem(fixture.loopDataRoot, chainId, 181)
			const run = await readRun(fixture.loopDataRoot, item?.lastRunId ?? "")
			expect(run?.exitCode).toBe(0)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon shutdown waits for pending scheduler close handlers before closing db", async () => {
		let triggerStarted = false
		let releaseTrigger: () => void = () => {}
		const triggerReleased = new Promise<void>((resolveRelease) => {
			releaseTrigger = resolveRelease
		})
		const fixture = await startFixture("shutdown-pending-close-handler", {
			schedulerIntervalMs: 30,
			chainCompleteTriggerForChain: async () => {
				triggerStarted = true
				await triggerReleased
				return { decision: "complete" }
			},
		})
		try {
			const chainName = "shutdown-pending-close-handler-chain"
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName(chainName, fixture.loopDataRoot)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 317,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})
			await waitFor(async () => triggerStarted, (started) => started)

			let closed = false
			void fixture.daemon.closed.then(() => {
				closed = true
			})
			const down = await request(fixture, "daemon.down")
			expect(down.ok).toBe(true)
			await new Promise((resolveWait) => setTimeout(resolveWait, 50))
			expect(closed).toBe(false)

			releaseTrigger()
			await fixture.daemon.closed
			expect(closed).toBe(true)
			expect(await readChainStatus(fixture.loopDataRoot, chainId)).toBe("completed")
		} finally {
			releaseTrigger()
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
			preInstallReviewOnEmptyLockByName("scheduler-artifacts-chain", fixture.loopDataRoot)
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
			expect(events.map((event) => event.type)).toEqual([
				"agent.spawn",
				"phase.start",
				"agent.exit",
				"phase.end",
				"queue.terminal",
				"chain.completed",
			])
			expect(daemonLog).toContain("scheduler.event")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("status snapshot recent events include scheduler phase.start / phase.end / queue.terminal", async () => {
		const chainName = "scheduler-status-events-chain"
		// Use a long scheduler interval so the second item stays queued (chain stays active)
		// while we snapshot status after the first item reaches terminal.
		const fixture = await startFixture("scheduler-status-events", { schedulerIntervalMs: 60_000 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: chainName,
				repository: "mouriya-s-lab/coder-loop",
				metadata: { workflowFile: "CLAUDE.md" },
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 304,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 305,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0 },
			})
			const item = await waitFor(async () => readItem(fixture.loopDataRoot, chainId, 304), (candidate) => candidate?.status === "done")
			expect(item?.lastRunId).not.toBeNull()
			const paths = resolveChainRuntimePaths(chainName, { loopDataRoot: fixture.loopDataRoot })

			const snapshot = await buildCoderLoopStatusSnapshot({
				targetCwd: REPO_ROOT,
				configPath: null,
				loopDataRoot: fixture.loopDataRoot,
				chainName,
				repository: "mouriya-s-lab/coder-loop",
				output: "json",
			})

			expect(snapshot.state.kind).toBe("ok")
			expect(snapshot.events.runId).toBe(item?.lastRunId ?? null)
			expect(snapshot.events.exists).toBe(true)
			expect(snapshot.events.path).toBe(paths.runEventsFile(item?.lastRunId ?? ""))
			expect(snapshot.events.error).toBeNull()
			const eventTypes = snapshot.events.recent.map((event) =>
				typeof event === "object" && event !== null && !Array.isArray(event) && typeof event.type === "string" ? event.type : null,
			)
			expect(eventTypes).toContain("phase.start")
			expect(eventTypes).toContain("phase.end")
			expect(eventTypes).toContain("queue.terminal")

			const cli = Bun.spawn({
				cmd: [
					"bun",
					resolve(REPO_ROOT, "src/loop.ts"),
					"status",
					REPO_ROOT,
					"--chain",
					chainName,
					"--loop-data-root",
					fixture.loopDataRoot,
					"--repo",
					"mouriya-s-lab/coder-loop",
					"--json",
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CODER_LOOP_DATA_DIR: fixture.loopDataRoot },
			})
			const [cliStdout, cliStderr, cliExit] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			])
			if (cliExit !== 0) {
				console.error("CLI_STDERR", cliStderr)
				console.error("CLI_STDOUT", cliStdout)
			}
			expect(cliExit).toBe(0)
			const cliPayload = JSON.parse(cliStdout) as { events: { recent: unknown[] } }
			const cliTypes = cliPayload.events.recent.map((event) =>
				typeof event === "object" && event !== null && !Array.isArray(event) && typeof (event as Record<string, unknown>).type === "string"
					? ((event as Record<string, unknown>).type as string)
					: null,
			)
			expect(cliTypes).toContain("phase.start")
			expect(cliTypes).toContain("phase.end")
			expect(cliTypes).toContain("queue.terminal")
		} finally {
			await fixture.daemon.stop()
		}
	}, 30_000)

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

	test("daemon scheduler aborts spawn when kind gate reports missing label (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver("kind-gate-missing-label-live", () => ({ ok: true, kind: null }))
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-missing-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, issueNumber: 9101, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9101),
				(candidate) => candidate?.status === "blocked",
				5_000,
			)
			expect(item?.status).toBe("blocked")
			expect(item?.lastRunId).toBeNull()
			expect(fixture.schedulerEvents.some((event) => event.type === "agent.spawn" && event.itemId === item!.id)).toBe(false)
			const aborted = fixture.schedulerEvents.find((event) => event.type === "spawn.aborted" && event.itemId === item!.id)
			expect(aborted).toMatchObject({ type: "spawn.aborted", chainId, itemId: item!.id, issueNumber: 9101, toStatus: "blocked" })
			expect(warnings.some((line) => line.includes("kind label check failed") && line.includes("expected exactly one kind"))).toBe(true)

			const paths = resolveChainRuntimePaths("kind-gate-missing-label-live-chain", { loopDataRoot: fixture.loopDataRoot })
			const daemonBatches = await readdir(paths.daemonDir)
			const daemonLog = await readFile(paths.daemonLogFile(daemonBatches[0]!), "utf-8")
			expect(daemonLog).toContain("spawn.aborted")
			expect(daemonLog).toContain("expected exactly one kind")
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler aborts spawn when kind gate reports multiple labels (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver(
			"kind-gate-multi-label-live",
			() => ({ ok: false, error: "expected exactly one kind:* label, found 2: kind:code, kind:comment" }),
		)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-multi-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, issueNumber: 9102, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9102),
				(candidate) => candidate?.status === "blocked",
				5_000,
			)
			expect(item?.status).toBe("blocked")
			expect(warnings.some((line) => line.includes("expected exactly one kind:* label, found 2"))).toBe(true)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler aborts spawn when kind gate reports unknown label (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixtureWithKindResolver(
			"kind-gate-unknown-label-live",
			() => ({ ok: false, error: 'unknown kind label "kind:foo" (allowed: kind:code, kind:comment, kind:code-spike, kind:blocked)' }),
		)
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "kind-gate-unknown-label-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", { chainId, issueNumber: 9103, repoCwd: REPO_ROOT })

			const item = await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 9103),
				(candidate) => candidate?.status === "blocked",
				5_000,
			)
			expect(item?.status).toBe("blocked")
			expect(warnings.some((line) => line.includes('unknown kind label "kind:foo"'))).toBe(true)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	})

	test("daemon scheduler spawns blocked-responder trigger phase after review exits blocked (live integration, issue #290)", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-b3-blocked-responder-live`)
		const loopDataRoot = resolve(root, "ld")
		const fakeRunner = resolve(root, "fake-phase-runner.ts")
		const eventLog = resolve(root, "events.jsonl")
		await mkdir(loopDataRoot, { recursive: true })
		await writeFile(
			fakeRunner,
			`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", phase: input.phase, runId: input.runId }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", phase: input.phase, runId: input.runId }) + "\\n")
if (input.phase === "iteration") await writeLine("ITERATION SUMMARY: scope=b3-live; reason=iter-marker")
else if (input.phase === "review") await writeLine("REVIEW SUMMARY: verdict=blocked; issue=#0; reason=b3-live-blocked")
else if (input.phase === "blocked-responder") await writeLine("REVIEW SUMMARY: verdict=accepted; issue=#0; reason=b3-live-unblock-accepted")
process.exitCode = 0
`,
		)

		const schedulerEvents: SchedulerEvent[] = []
		const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
			const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
			await mkdir(worktreePath, { recursive: true })
			return worktreePath
		}
		const runnerSelection: SchedulerOptions["runner"] = {
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
				enabled: true,
				intervalMs: 30,
				runner: runnerSelection,
				presetDir: PRESET_DIR,
				worktreeManager,
				kindResolver: () => ({ ok: true, kind: "code" }),
				prompt: ({ item, runId, phase }) => JSON.stringify({
					itemId: item.id,
					issueNumber: item.issueNumber,
					runId,
					phase,
					eventLog,
					sleepMs: 5,
				}),
				statusFromExit: ({ phase }) => {
					if (phase === "iteration") return "in_progress"
					if (phase === "review") return "blocked"
					return "done"
				},
				chainCompleteTriggerForChain: () => null,
				onEvent: (event) => {
					schedulerEvents.push(event)
				},
			},
		})
		const socketPath = daemon.snapshot().socketPath
		try {
			const chain = record(expectOk(await sendDaemonRequest(socketPath, daemonRequest("chain.create", {
				name: "b3-blocked-responder-live-chain",
				repository: "mouriya-s-lab/coder-loop",
			}))).chain)
			const chainId = numberValue(chain.id)
			preInstallReviewOnEmptyLockByName("b3-blocked-responder-live-chain", loopDataRoot)
			expectOk(await sendDaemonRequest(socketPath, daemonRequest("item.add", { chainId, issueNumber: 29011, repoCwd: REPO_ROOT })))

			const finalItem = await waitFor(
				async () => readItem(loopDataRoot, chainId, 29011),
				(candidate) => candidate?.phase === "blocked-responder" && candidate?.status === "done",
				10_000,
			)
			expect(finalItem?.phase).toBe("blocked-responder")
			expect(finalItem?.status).toBe("done")

			const phaseStarts = schedulerEvents
				.filter((event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
					event.type === "phase.start" && event.itemId === finalItem!.id,
				)
				.map((event) => event.phase)
			expect(phaseStarts).toEqual(["iteration", "review", "blocked-responder"])

			const paths = resolveChainRuntimePaths("b3-blocked-responder-live-chain", { loopDataRoot })
			const daemonBatches = await readdir(paths.daemonDir)
			const daemonLog = await readFile(paths.daemonLogFile(daemonBatches[0]!), "utf-8")
			expect(daemonLog).toContain("blocked-responder")
		} finally {
			await daemon.stop()
		}
	})

	test("daemon re-spawns item after agent exits 0 without SUMMARY marker (live integration)", async () => {
		const warnings: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
		}
		const fixture = await startFixture("scheduler-respawn-no-summary", { schedulerIntervalMs: 30 })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "scheduler-respawn-no-summary-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			await request(fixture, "item.add", {
				chainId,
				issueNumber: 7284,
				repoCwd: REPO_ROOT,
				extra: { sleepMs: 5, exitCode: 0, summary: null },
			})

			await waitFor(
				async () => readItem(fixture.loopDataRoot, chainId, 7284),
				(candidate) => (candidate?.attempts ?? 0) >= 2,
				5_000,
			)

			const finalItem = await readItem(fixture.loopDataRoot, chainId, 7284)
			expect(finalItem?.attempts).toBeGreaterThanOrEqual(2)
			expect(["queued", "in_progress", "changes_requested"]).toContain(finalItem?.status ?? "")
			expect(fixture.schedulerEvents.filter((event) => event.type === "agent.spawn" && event.itemId === finalItem!.id).length).toBeGreaterThanOrEqual(2)
			expect(warnings.some((line) => line.includes("exit 0 without SUMMARY marker"))).toBe(true)
		} finally {
			console.warn = originalWarn
			await fixture.daemon.stop()
		}
	})

	describe("per-phase runner selection (issue #287 AC5)", () => {
		test("live daemon with chain metadata claude/codex.binary spawns codex script for iter phase", async () => {
			const fixture = await startChainBasedRunnerFixture("ac5-iter", { phase: "iteration" })
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac5-iter-chain",
					preset: "single-phase-example",
					repository: "mouriya-s-lab/coder-loop",
					metadata: {
						claude: { binary: fixture.fakeClaudeBinary },
						codex: { binary: fixture.fakeCodexBinary },
					},
				})).chain
				const chainId = numberValue(record(result).id)
				preInstallReviewOnEmptyLockByName("ac5-iter-chain", fixture.loopDataRoot)
				await request(fixture, "item.add", {
					chainId,
					issueNumber: 287_301,
					repoCwd: REPO_ROOT,
					extra: { issueKind: "code" },
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 287_301),
					(candidate) => candidate !== null && candidate.lastRunId !== null && candidate.status === "done",
					5_000,
				)
				expect(item).not.toBeNull()
				const runId = item!.lastRunId!
				const stdoutPath = resolveChainRuntimePaths(`ac5-iter-chain`, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(runId)
				const stdout = await readFile(stdoutPath, "utf-8")
				expect(stdout).toContain("BINARY:codex")
				expect(stdout).not.toContain("BINARY:claude")
			} finally {
				await fixture.daemon.stop()
			}
		})

		test("live daemon with chain metadata claude/codex.binary spawns claude script for review phase", async () => {
			const fixture = await startChainBasedRunnerFixture("ac5-review", { phase: "review" })
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac5-review-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
					metadata: {
						claude: { binary: fixture.fakeClaudeBinary },
						codex: { binary: fixture.fakeCodexBinary },
					},
				})).chain
				const chainId = numberValue(record(result).id)
				preInstallReviewOnEmptyLockByName("ac5-review-chain", fixture.loopDataRoot)
				await request(fixture, "item.add", {
					chainId,
					issueNumber: 287_302,
					repoCwd: REPO_ROOT,
					extra: { issueKind: "code" },
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 287_302),
					(candidate) => candidate !== null && candidate.lastRunId !== null && candidate.status === "done",
					5_000,
				)
				expect(item).not.toBeNull()
				const runId = item!.lastRunId!
				const stdoutPath = resolveChainRuntimePaths(`ac5-review-chain`, { loopDataRoot: fixture.loopDataRoot }).runStdoutFile(runId)
				const stdout = await readFile(stdoutPath, "utf-8")
				expect(stdout).toContain("BINARY:claude")
				expect(stdout).not.toContain("BINARY:codex")
			} finally {
				await fixture.daemon.stop()
			}
		})
	})

	describe("per-item phase advancement (issue #289 AC7)", () => {
		test("live daemon drives one item through iter → review in two distinct spawns (not one synchronous spawn-then-review)", async () => {
			const fixture = await startPhaseAdvancementFixture("ac7-iter-then-review")
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "ac7-iter-then-review-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
				})).chain
				const chainId = numberValue(record(result).id)
				preInstallReviewOnEmptyLockByName("ac7-iter-then-review-chain", fixture.loopDataRoot)
				await request(fixture, "item.add", {
					chainId,
					issueNumber: 289_001,
					repoCwd: REPO_ROOT,
					extra: { issueKind: "code" },
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 289_001),
					(candidate) => candidate !== null && candidate.status === "done",
					10_000,
				)
				expect(item).not.toBeNull()
				expect(item!.attempts).toBeGreaterThanOrEqual(2)
				expect(item!.phase).toBe("review")

				const spawnEvents = fixture.schedulerEvents.filter(
					(event) => event.type === "agent.spawn" && event.itemId === item!.id,
				)
				expect(spawnEvents).toHaveLength(2)

				const phaseStartEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
						event.type === "phase.start" && event.itemId === item!.id,
				)
				const startedPhases = phaseStartEvents.map((event) => event.phase)
				expect(startedPhases).toEqual(["iteration", "review"])

				const phaseEndEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.end" }> =>
						event.type === "phase.end" && event.itemId === item!.id,
				)
				const endedPhases = phaseEndEvents.map((event) => event.phase)
				expect(endedPhases).toEqual(["iteration", "review"])

				const terminalEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "queue.terminal" }> =>
						event.type === "queue.terminal" && event.itemId === item!.id,
				)
				expect(terminalEvents).toHaveLength(1)
				expect(terminalEvents[0]!.terminalStatus).toBe("done")

				const daemonDir = resolveChainRuntimePaths("ac7-iter-then-review-chain", { loopDataRoot: fixture.loopDataRoot }).daemonDir
				const batchDirs = await readdir(daemonDir)
				expect(batchDirs.length).toBeGreaterThanOrEqual(1)
				const newestBatch = batchDirs.sort().at(-1)!
				const persistedLogPath = resolve(daemonDir, newestBatch, "daemon.log")
				const persistedLog = await readFile(persistedLogPath, "utf-8")
				const persistedSpawnLines = persistedLog
					.split("\n")
					.filter(Boolean)
					.filter((line) => {
						const parsed = JSON.parse(line) as { type?: string; event?: { type?: string; itemId?: number } }
						return parsed.type === "scheduler.event" && parsed.event?.type === "agent.spawn" && parsed.event.itemId === item!.id
					})
				expect(persistedSpawnLines).toHaveLength(2)
			} finally {
				await fixture.daemon.stop()
			}
		})
	})

	describe("per-(item, phase) runId + artifact directory (issue #294)", () => {
		test("iter and review spawns produce distinct phase-tagged runIds with isolated artifact subdirs and SQLite runs rows", async () => {
			const fixture = await startPhaseAdvancementFixture("phase-runid-artifact")
			try {
				const result = expectOk(await request(fixture, "chain.create", {
					name: "phase-runid-artifact-chain",
					preset: "gh-issue-pr-iteration",
					repository: "mouriya-s-lab/coder-loop",
				})).chain
				const chain = record(result)
				const chainId = numberValue(chain.id)
				preInstallReviewOnEmptyLockByName("phase-runid-artifact-chain", fixture.loopDataRoot)
				await request(fixture, "item.add", {
					chainId,
					issueNumber: 294_001,
					repoCwd: REPO_ROOT,
					extra: { issueKind: "code" },
				})

				const item = await waitFor(
					async () => readItem(fixture.loopDataRoot, chainId, 294_001),
					(candidate) => candidate !== null && candidate.status === "done",
					10_000,
				)
				expect(item).not.toBeNull()

				const phaseStartEvents = fixture.schedulerEvents.filter(
					(event): event is Extract<SchedulerEvent, { type: "phase.start" }> =>
						event.type === "phase.start" && event.itemId === item!.id,
				)
				expect(phaseStartEvents.map((event) => event.phase)).toEqual(["iteration", "review"])
				const runIdByPhase = new Map<string, string>(phaseStartEvents.map((event) => [event.phase, event.runId]))
				const iterRunId = runIdByPhase.get("iteration")!
				const reviewRunId = runIdByPhase.get("review")!
				expect(iterRunId).toBeTruthy()
				expect(reviewRunId).toBeTruthy()
				expect(iterRunId).not.toBe(reviewRunId)
				expect(iterRunId).toContain("iteration")
				expect(reviewRunId).toContain("review")

				const paths = resolveChainRuntimePaths("phase-runid-artifact-chain", { loopDataRoot: fixture.loopDataRoot })
				for (const runId of [iterRunId, reviewRunId]) {
					const runDirEntries = await readdir(paths.runDir(runId))
					expect(runDirEntries.sort()).toEqual(["events.jsonl", "status.json", "stderr.log", "stdout.log"])
				}
				const iterStatus = JSON.parse(await readFile(paths.runStatusFile(iterRunId), "utf-8")) as { phase: string }
				const reviewStatus = JSON.parse(await readFile(paths.runStatusFile(reviewRunId), "utf-8")) as { phase: string }
				expect(iterStatus.phase).toBe("iteration")
				expect(reviewStatus.phase).toBe("review")

				const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot, createIfMissing: false })
				try {
					const iterRow = store.getRunByRunId(iterRunId)
					const reviewRow = store.getRunByRunId(reviewRunId)
					expect(iterRow?.phase).toBe("iteration")
					expect(reviewRow?.phase).toBe("review")
					expect(iterRow?.status).toBe("in_progress")
					expect(reviewRow?.status).toBe("done")
					expect(iterRow?.itemId).toBe(item!.id)
					expect(reviewRow?.itemId).toBe(item!.id)
				} finally {
					store.close()
				}

				const iterEventLines = (await readFile(paths.runEventsFile(iterRunId), "utf-8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { type: string; phase?: string })
				const reviewEventLines = (await readFile(paths.runEventsFile(reviewRunId), "utf-8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { type: string; phase?: string })
				const iterPhaseEnd = iterEventLines.find((event) => event.type === "phase.end")
				const reviewPhaseEnd = reviewEventLines.find((event) => event.type === "phase.end")
				expect(iterPhaseEnd?.phase).toBe("iteration")
				expect(reviewPhaseEnd?.phase).toBe("review")
			} finally {
				await fixture.daemon.stop()
			}
		})
	})
})

type PhaseAdvancementFixture = Fixture & {
	fakePhaseAwareRunner: string
}

async function startPhaseAdvancementFixture(name: string): Promise<PhaseAdvancementFixture> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const eventLog = resolve(root, "events.jsonl")
	const fakeRunner = resolve(root, "phase-aware-runner.ts")
	await mkdir(root, { recursive: true })
	await writeFile(
		fakeRunner,
		`import { appendFile } from "node:fs/promises"

const promptIndex = Bun.argv.indexOf("-p")
const prompt = promptIndex === -1 ? "{}" : Bun.argv[promptIndex + 1] ?? "{}"
const input = JSON.parse(prompt)
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, phase: input.phase, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, phase: input.phase, cwd: process.cwd() }) + "\\n")
await writeLine("done:" + input.itemId + ":" + input.phase)
if (input.phase === "review") {
	await writeLine("REVIEW SUMMARY: verdict=accepted; issue=#" + input.issueNumber + "; reason=phase-aware-runner review")
} else {
	await writeLine("ITERATION SUMMARY: scope=phase-aware-runner; reason=iter-marker")
}
process.exitCode = 0
`,
	)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}

	const fakeRunnerSelection: SchedulerOptions["runner"] = {
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
			enabled: true,
			intervalMs: 20,
			runner: fakeRunnerSelection,
			presetDir: PRESET_DIR,
			worktreeManager,
			kindResolver: () => ({ ok: true, kind: "code" }),
			prompt: ({ item, runId, phase }) => JSON.stringify({
				itemId: item.id,
				issueNumber: item.issueNumber,
				runId,
				phase,
				eventLog,
				sleepMs: 5,
			}),
			statusFromExit: ({ phase }) => phase === "iteration" ? "in_progress" : "done",
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return {
		daemon,
		loopDataRoot,
		socketPath: snapshot.socketPath,
		pidFile: snapshot.pidFile,
		eventLog,
		schedulerEvents,
		fakePhaseAwareRunner: fakeRunner,
	}
}

type ChainBasedRunnerFixture = Fixture & {
	fakeCodexBinary: string
	fakeClaudeBinary: string
}

async function startChainBasedRunnerFixture(name: string, options: { phase: string }): Promise<ChainBasedRunnerFixture> {
	const { chmod } = await import("node:fs/promises")
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	const loopDataRoot = resolve(root, "ld")
	const eventLog = resolve(root, "events.jsonl")
	await mkdir(root, { recursive: true })
	const fakeCodex = resolve(root, "fake-codex.sh")
	const fakeClaude = resolve(root, "fake-claude.sh")
	await writeFile(
		fakeCodex,
		`#!/bin/sh
echo "BINARY:codex"
echo "ITERATION SUMMARY: scope=ac5; reason=marker"
echo "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=marker"
exit 0
`,
	)
	await writeFile(
		fakeClaude,
		`#!/bin/sh
echo "BINARY:claude"
echo "ITERATION SUMMARY: scope=ac5; reason=marker"
echo "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=marker"
exit 0
`,
	)
	await chmod(fakeCodex, 0o755)
	await chmod(fakeClaude, 0o755)

	const schedulerEvents: SchedulerEvent[] = []
	const worktreeManager: SchedulerWorktreeManager = async ({ chain, repoCwd }) => {
		const worktreePath = schedulerSlotWorktreePath(chain, repoCwd, { loopDataRoot })
		await mkdir(worktreePath, { recursive: true })
		return worktreePath
	}

	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		shutdownGraceMs: 100,
		scheduler: {
			enabled: true,
			intervalMs: 20,
			worktreeManager,
			kindResolver: () => ({ ok: true, kind: "code" }),
			phase: options.phase,
			prompt: () => "ac5-phase-prompt",
			chainCompleteTriggerForChain: () => null,
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return {
		daemon,
		loopDataRoot,
		socketPath: snapshot.socketPath,
		pidFile: snapshot.pidFile,
		eventLog,
		schedulerEvents,
		fakeCodexBinary: fakeCodex,
		fakeClaudeBinary: fakeClaude,
	}
}

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
	kindResolver?: SchedulerKindResolver
	chainCompleteTriggerForChain?: SchedulerOptions["chainCompleteTriggerForChain"]
}

function preInstallReviewOnEmptyLockByName(chainName: string, loopDataRoot: string, runId = "test-pre-installed"): void {
	const lockPath = reviewOnEmptyLockPathForChainName(chainName, { loopDataRoot })
	mkdirSync(resolve(lockPath, ".."), { recursive: true })
	writeFileSync(lockPath, serializeSchedulerReviewOnEmptyLock(runId, new Date(0)))
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
			kindResolver: options.kindResolver ?? (() => ({ ok: true, kind: "code" })),
			prompt: ({ item, runId }) => {
				const payload: Record<string, unknown> = {
					itemId: item.id,
					issueNumber: item.issueNumber,
					runId,
					eventLog,
					sleepMs: typeof item.extra.sleepMs === "number" ? item.extra.sleepMs : 5,
					exitCode: typeof item.extra.exitCode === "number" ? item.extra.exitCode : 0,
				}
				if (Object.prototype.hasOwnProperty.call(item.extra, "summary")) payload.summary = item.extra.summary
				return JSON.stringify(payload)
			},
			chainCompleteTriggerForChain: options.chainCompleteTriggerForChain ?? (() => null),
			onEvent: (event) => {
				schedulerEvents.push(event)
			},
		},
	})
	const snapshot = daemon.snapshot()
	return { daemon, loopDataRoot, socketPath: snapshot.socketPath, pidFile: snapshot.pidFile, eventLog, schedulerEvents }
}

async function startFixtureWithKindResolver(name: string, kindResolver: SchedulerKindResolver): Promise<Fixture> {
	return await startFixture(name, { schedulerIntervalMs: 30, kindResolver })
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
const writeLine = (line) => Bun.write(Bun.stdout, line + "\\n")
await appendFile(input.eventLog, JSON.stringify({ type: "start", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await new Promise((resolve) => setTimeout(resolve, input.sleepMs))
await appendFile(input.eventLog, JSON.stringify({ type: "end", itemId: input.itemId, issueNumber: input.issueNumber, runId: input.runId, cwd: process.cwd() }) + "\\n")
await writeLine("done:" + input.itemId)
const summary = Object.prototype.hasOwnProperty.call(input, "summary") ? input.summary : "REVIEW SUMMARY: verdict=accepted; issue=#0; reason=fake-runner default"
if (summary !== null) await writeLine(summary)
process.exitCode = input.exitCode
`,
		)
	}
