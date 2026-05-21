import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { chainRuntimePaths } from "./runtime-paths"
import { migrateStateJson } from "./state-migration"
import { allItemsTerminal, completeChain, openStateDb } from "./state-db"

const REPO_ROOT = resolve(import.meta.dir, "..")
const MIGRATION_TEST_ROOT = resolve(REPO_ROOT, ".cache/state-migration-tests")

async function withMigrationTarget<T>(name: string, fn: (paths: { target: string; root: string; dbPath: string; agentCwd: string }) => T | Promise<T>): Promise<T> {
	await mkdir(MIGRATION_TEST_ROOT, { recursive: true })
	const dir = await mkdtemp(resolve(MIGRATION_TEST_ROOT, `${name}-`))
	const target = resolve(dir, "legacy-target")
	const root = resolve(dir, "loop-data")
	const agentCwd = resolve(dir, "agent-worktree")
	await mkdir(agentCwd, { recursive: true })
	try {
		return await fn({ target, root, dbPath: resolve(root, "state.db"), agentCwd })
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe("migrateStateJson", () => {
	test("copies legacy state, artifacts, runs, and leaves an idempotent backup", async () => {
		await withMigrationTarget("full", async ({ target, root, dbPath, agentCwd }) => {
			await writeLegacyRuntime(target, {
				repository: "owner/service",
				baseBranch: "trunk",
				queue: [
					{
						issue: 1,
						status: "done",
						priority: "high",
						attempts: 2,
						title: "first",
						branch: "issue-1",
						pr: 10,
						lastRunId: "run-1",
						issueFile: ".coder-loop/runtime/issues/1.md",
						evidenceDir: ".coder-loop/runtime/evidence/issue-1",
						agentCwd,
						runner: "codex",
						extra: { reviewed: true },
						kind: "code",
					},
					{
						issue: 2,
						status: "merged",
						priority: "medium",
						title: "second",
					},
					{ status: "queued" },
				],
				recentRuns: [
					{
						id: "run-1",
						issue: 1,
						phase: "iteration",
						runner: "codex",
						startedAt: "2026-05-21T00:00:00.000Z",
						finishedAt: "2026-05-21T00:01:00.000Z",
						exitCode: 0,
						terminated: { kind: "clean" },
						logPath: "legacy/log.txt",
						statusPath: "legacy/status.json",
					},
				],
			})

			const db = openStateDb(dbPath)
			try {
				const first = await migrateStateJson(target, db, { rootDir: root })
				expect(first.chain.name).toBe("service")
				expect(first.chain.repository).toBe("owner/service")
				expect(first.chain.baseBranch).toBe("trunk")
				expect(first.chain.status).toBe("active")
				expect(first.chain.umbrellaIssue).toBeNull()
				expect(first.chain.umbrellaRepo).toBeNull()
				expect(first.itemsInserted).toBe(2)
				expect(first.itemsUpdated).toBe(0)
				expect(first.runsInserted).toBe(1)
				expect(first.skipped).toContainEqual({ issue: null, reason: "invalid legacy queue item" })
				expect(first.backupPath).toBe(resolve(target, ".coder-loop/runtime/state.json.pre-sqlite-migration"))
				expect(existsSync(first.legacyStatePath)).toBe(true)
				expect(existsSync(first.backupPath ?? "")).toBe(true)

				const chainPaths = chainRuntimePaths(root, "service")
				expect(await readFile(chainPaths.sharedPath, "utf-8")).toBe("# shared from legacy\n")
				expect(await readFile(resolve(chainPaths.issuesDir, "1.md"), "utf-8")).toBe("# issue one\n")
				expect(await readFile(resolve(chainPaths.evidenceDir, "issue-1/proof.txt"), "utf-8")).toBe("proof\n")

				const itemOne = first.items.find((item) => item.issue === 1)
				expect(itemOne).toMatchObject({
					repoCwd: agentCwd,
					agentCwd,
					issueFile: "issues/1.md",
					evidenceDir: "evidence/issue-1",
					runner: "codex",
					extra: { reviewed: true, kind: "code" },
				})

				const second = await migrateStateJson(target, db, { rootDir: root })
				expect(second.itemsInserted).toBe(0)
				expect(second.itemsUpdated).toBe(0)
				expect(second.skipped).toEqual(expect.arrayContaining([
					{ issue: 1, reason: "item already exists in migrated chain" },
					{ issue: 2, reason: "item already exists in migrated chain" },
				]))
			} finally {
				db.close()
			}
		})
	})

	test("keeps an all-terminal migrated chain active until scheduler/status completion", async () => {
		await withMigrationTarget("terminal", async ({ target, root, dbPath }) => {
			await writeLegacyRuntime(target, {
				repository: "owner/done-chain",
				baseBranch: "main",
				queue: [
					{ issue: 7, status: "done" },
					{ issue: 8, status: "merged" },
				],
				recentRuns: [],
			})
			const db = openStateDb(dbPath)
			try {
				const migrated = await migrateStateJson(target, db, { rootDir: root })
				expect(migrated.chain.status).toBe("active")
				expect(allItemsTerminal(db, migrated.chain.id)).toBe(true)
				expect(completeChain(db, migrated.chain.id).status).toBe("completed")
			} finally {
				db.close()
			}
		})
	})
})

async function writeLegacyRuntime(target: string, state: Record<string, unknown>): Promise<void> {
	const runtime = resolve(target, ".coder-loop/runtime")
	await mkdir(resolve(runtime, "issues"), { recursive: true })
	await mkdir(resolve(runtime, "evidence/issue-1"), { recursive: true })
	await writeFile(resolve(runtime, "config.json"), JSON.stringify({
		preset: "gh-issue-pr-iteration",
		repository: state.repository,
		baseBranch: state.baseBranch,
	}, null, "\t"))
	await writeFile(resolve(runtime, "shared.md"), "# shared from legacy\n")
	await writeFile(resolve(runtime, "issues/1.md"), "# issue one\n")
	await writeFile(resolve(runtime, "evidence/issue-1/proof.txt"), "proof\n")
	await writeFile(resolve(runtime, "state.json"), JSON.stringify({
		version: 1,
		...state,
		current: null,
	}, null, "\t"))
}
