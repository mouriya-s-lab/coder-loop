import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { resolve } from "node:path"

setDefaultTimeout(30_000)

import { startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"
import { LOOP_DATA_ROOT_ENV, resolveLoopDataPaths } from "./runtime-paths"
import { openSqliteStateStore } from "./sqlite-state"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedItemExtra } from "./runtime-data"
import { appendObservabilityEvent, makeObservabilityEvent } from "./observability"

// #397 test brand helper — see install-commands.test.ts for rationale.
function admittedTestStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}
import type { BoundaryRecord } from "./boundary-types"

// #456: the legacy chain-drain auto-fire suppressor helper retired with the path itself; tests
// that used to pre-install its lock now rely on the DSL chain-complete trigger driver only.

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/central-cli-tests", String(process.pid))
const DEFAULT_CHAIN_CONFIG = chainConfig("mouriya-s-lab/coder-loop")
const FIXTURE_CHAIN_CONFIG = chainConfig("fixture/repo")

let nextFixtureId = 0

function chainConfig(repository: string, baseBranch?: string): string {
	return JSON.stringify(baseBranch === undefined ? { repository } : { repository, baseBranch })
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("central chain/item CLI", () => {
	test("status reports runner persistence failures", async () => {
		const loopDataRoot = await makeLoopDataRoot("runner-persistence-status")
		const paths = resolveLoopDataPaths({ loopDataRoot })
		for (const [path, runId, phase, statusPath, error] of [
			["scheduler", "run-635-scheduler", "iteration", "/runs/scheduler/status.json", "EIO scheduler status"],
			["chain-complete", "run-635-trigger", "umbrella-finalizer", "/runs/trigger/status.json", "EACCES trigger status"],
		] as const) {
			await appendObservabilityEvent(paths.runnerPersistenceFailuresFile, makeObservabilityEvent({
				kind: "diagnostic",
				type: "runner.status_persistence_failed",
				chain: "failure-chain",
				runId,
				phase,
				subject: { kind: "engine" },
				payload: { path, stage: "status-artifact", persistencePath: statusPath, error },
			}))
		}
		const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
		try {
			const status = expectJsonOk(await runCli(["daemon", "status", "--loop-data-root", loopDataRoot, "--json"]))
			expect(status.daemon).toMatchObject({ runnerStatusPersistenceFailure: { path: "chain-complete", runId: "run-635-trigger", phase: "umbrella-finalizer", persistencePath: "/runs/trigger/status.json", error: "EACCES trigger status" } })
			const logs = expectJsonOk(await runCli(["logs", loopDataRoot, "--loop-data-root", loopDataRoot, "--json", "--type", "runner.status_persistence_failed"]))
			expect(logs.events).toHaveLength(2)
			expect(logs.events.map((event: BoundaryRecord) => event.payload)).toEqual([
				{ path: "scheduler", stage: "status-artifact", persistencePath: "/runs/scheduler/status.json", error: "EIO scheduler status" },
				{ path: "chain-complete", stage: "status-artifact", persistencePath: "/runs/trigger/status.json", error: "EACCES trigger status" },
			])
		} finally {
			await daemon.stop()
		}
	})
	test("status exposes scheduler lifecycle event failure", async () => {
		const loopDataRoot = await makeLoopDataRoot("lifecycle-persistence-status")
		const paths = resolveLoopDataPaths({ loopDataRoot })
		await appendObservabilityEvent(paths.lifecycleEventFailuresFile, makeObservabilityEvent({
			kind: "diagnostic",
			type: "scheduler.lifecycle_event_persistence_failed",
			chain: "failure-chain",
			item: 632,
			runId: "run-632-timeout",
			phase: "review",
			subject: { kind: "engine" },
			payload: { eventKind: "attempt.timeout", error: "EIO primary event sink", originalPersisted: false },
		}))
		const daemon = await startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })
		try {
			const status = expectJsonOk(await runCli(["daemon", "status", "--loop-data-root", loopDataRoot, "--json"]))
			expect(status.daemon).toMatchObject({
				lifecycleEventPersistenceFailure: {
					runId: "run-632-timeout",
					phase: "review",
					eventKind: "attempt.timeout",
					error: "EIO primary event sink",
					originalPersisted: false,
				},
			})
			const logs = expectJsonOk(await runCli(["logs", loopDataRoot, "--loop-data-root", loopDataRoot, "--json", "--run", "run-632-timeout", "--type", "scheduler.lifecycle_event_persistence_failed"]))
			expect(logs.events).toHaveLength(1)
			expect(logs.events[0]).toMatchObject({ runId: "run-632-timeout", phase: "review", payload: { eventKind: "attempt.timeout", originalPersisted: false } })
		} finally {
			await daemon.stop()
		}
	})

	test("observes ordered mutation and read on one socket", async () => {
		const fixture = await startFixture("ordered-mutation-read")
		try {
			const responses = await sendLinesOnDaemonConnection(resolve(fixture.loopDataRoot, "daemon.sock"), [
				JSON.stringify({ id: "mutation", command: "chain.create", args: { name: "ordered-chain", repository: "mouriya-s-lab/coder-loop" } }),
				JSON.stringify({ id: "read", command: "chain.list", args: {} }),
			])
			expect(responses.map((response) => response.id)).toEqual(["mutation", "read"])
			if (!responses[0]?.ok) throw new Error("mutation request failed")
			if (!responses[1]?.ok) throw new Error("read request failed")
			const chains = responses[1].result.chains
			if (!Array.isArray(chains)) throw new Error("chain.list result must contain chains")
			expect(chains).toHaveLength(1)
			expect(chains[0]).toMatchObject({ name: "ordered-chain" })
		} finally {
			await fixture.daemon.stop()
		}
	})
	test("chain CRUD CLI", async () => {
		const fixture = await startFixture("chain-crud")
		try {
			const created = expectJsonOk(await runCli(["chain", "create", "crud-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(created.chain).toMatchObject({
				name: "crud-chain",
				repository: "mouriya-s-lab/coder-loop",
				preset: "gh-issue-pr-iteration",
				status: "active",
			})

			const listed = expectJsonOk(await runCli(["chain", "list", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.chains).toHaveLength(1)
			expect(listed.chains[0]).toMatchObject({ name: "crud-chain", status: "active" })

			const status = expectJsonOk(await runCli(["chain", "status", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.chain).toMatchObject({ name: "crud-chain", status: "active" })
			expect(status.summary).toMatchObject({ completion: { state: "active", completedAt: null }, items: { total: 0, byStatus: {} } })

			const stopped = expectJsonOk(await runCli(["chain", "stop", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(stopped.chain).toMatchObject({ name: "crud-chain", status: "stopped" })
			expect(stopped.alreadyStopped).toBe(false)

			const stoppedStatus = expectJsonOk(await runCli(["chain", "status", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(stoppedStatus.chain).toMatchObject({ name: "crud-chain", status: "stopped" })
			expect(stoppedStatus.summary).toMatchObject({ completion: { state: "stopped", completedAt: null } })

			const resumed = expectJsonOk(await runCli(["chain", "resume", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(resumed.chain).toMatchObject({ name: "crud-chain", status: "active" })
			expect(resumed.alreadyActive).toBe(false)

			const deleted = expectJsonOk(await runCli(["chain", "delete", "crud-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(deleted.chain).toMatchObject({ name: "crud-chain", status: "deleted" })

			const unforcedRecreate = await runCli(["chain", "create", "crud-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"])
			expect(unforcedRecreate.exitCode).toBe(1)
			expect(unforcedRecreate.stderr).toContain("chain_deleted")
			expect(unforcedRecreate.stderr).toContain("force=true")

			const recreated = expectJsonOk(await runCli(["chain", "create", "crud-chain", "--config-json", chainConfig("mouriya-s-lab/coder-loop", "recreated"), "--force", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(recreated.chain).toMatchObject({
				name: "crud-chain",
				status: "active",
				baseBranch: "recreated",
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain umbrella parsing", async () => {
		const fixture = await startFixture("umbrella")
		try {
			const created = expectJsonOk(await runCli([
				"chain",
				"create",
				"umbrella-chain",
				"--config-json",
				DEFAULT_CHAIN_CONFIG,
				"--umbrella",
				"mouriya-s-lab/coder-loop#176",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			]))
			// #457: umbrella values flow through metadata.bindings rather than first-class
			// chain columns. `chain.create` shorthand (`--umbrella owner/repo#176`) still
			// works but writes to `metadata.bindings.umbrellaRepo / umbrellaIssue`.
			expect(created.chain).toMatchObject({
				metadata: { bindings: { umbrellaRepo: "mouriya-s-lab/coder-loop", umbrellaIssue: 176 } },
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("item CRUD CLI", async () => {
		const fixture = await startFixture("item-crud")
		try {
			expectJsonOk(await runCli(["chain", "create", "items-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const added = expectJsonOk(await runCli([
				"item",
				"add",
				"items-chain",
				"--issue",
				"181",
				"--repo-cwd",
				REPO_ROOT,
				"--preset",
				"gh-issue-pr-iteration",
				"--title",
				"feat: 引入 chain-item-daemon CLI 命令族",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			]))
			expect(added.item).toMatchObject({
				// #419: wire `issueNumber: int` retired; `itemId: string` is the canonical id.
				itemId: "181",
				repoCwd: REPO_ROOT,
				status: "queued",
				title: "feat: 引入 chain-item-daemon CLI 命令族",
			})

			const listed = expectJsonOk(await runCli(["item", "list", "items-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items).toHaveLength(1)
			expect(listed.items[0]).toMatchObject({ itemId: "181", status: "queued" })

			const updated = expectJsonOk(await runCli(["item", "update", "items-chain", "--issue", "181", "--status", "done", "--field-json", "{\"pr\":191}", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(updated.item).toMatchObject({ itemId: "181", status: "done", extra: { pr: 191 } })

			// #406 row 4 — operator path: no env credential, no claim flags → audit subject is
			// `{kind: "operator"}`. Pre-#406 this test also asserted an agent-attributed update via
			// the freely-claimed `--agent-run-id` / `--agent-phase` flags; those flags are retired
			// (the daemon now binds agent identity from the spawn-time env credential, never from
			// caller claims). The agent path is exercised end-to-end in the daemon integration
			// fixture (`daemon.test.ts > caller-admission gate`), where the scheduler spawns a real
			// run and the CLI auto-attaches the engine-minted credential from env.
			const operatorAuditLogs = expectJsonOk(await runCli(["logs", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--json", "--chain", "items-chain", "--kind", "audit", "--type", "item.status"]))
			expect(operatorAuditLogs.events).toHaveLength(1)
			expect(operatorAuditLogs.events[0]).toMatchObject({
				kind: "audit",
				type: "item.status",
				subject: { kind: "operator" },
				// #419: audit payload retired `issueNumber: int`; new shape is `rowId` + `itemId: string`.
				payload: { itemId: "181", fromStatus: "queued", toStatus: "done" },
			})

			// #406 retire-claim: pre-existing CLI flag `--agent-run-id` is no longer accepted —
			// cmd-ts rejects it as an unknown flag. This is the operator-side visible signal that
			// agent attribution moved off CLI claims onto engine-bound env credentials.
			const claimedAgentRetry = await runCli([
				"item",
				"update",
				"items-chain",
				"--issue",
				"181",
				"--status",
				"changes_requested",
				"--agent-run-id",
				"run-agent-status-181",
				"--agent-phase",
				"review",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			])
			expect(claimedAgentRetry.exitCode).not.toBe(0)

			// #406 unknown-credential rejection: an env-borne credential value that does not map
			// to any active run gets rejected at the daemon's caller-admission gate. Operator
			// invocations only see this if the env is mis-set; agents would never hit it during a
			// normal run (the scheduler mints the value, registers it, then injects). Asserting
			// here keeps the deny branch test-covered without spinning up a real spawn.
			const fabricatedCred = await runCli([
				"item",
				"update",
				"items-chain",
				"--issue",
				"181",
				"--status",
				"changes_requested",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			], { CODER_LOOP_RUN_CRED: "credential-that-was-never-minted" })
			expect(fabricatedCred.exitCode).not.toBe(0)
			expect(fabricatedCred.stderr).toContain("invalid_caller")
			expect(fabricatedCred.stderr).toContain("agentCredential")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("status commands use config-json presetPath statuses", async () => {
		const fixture = await startFixture("status-config-json-presetpath")
		try {
			const target = await makeTarget("status-config-json-presetpath-target")
			const presetPath = resolve(fixture.loopDataRoot, "..", "custom-status-preset")
			await mkdir(presetPath, { recursive: true })
			await writeFile(resolve(presetPath, "run.md"), "Run issue {{ISSUE}}.\n")
			await writeFile(resolve(presetPath, "preset.toml"), `name = "custom-status-fixture"

[item]
idField = "issue"

[statuses]
continuable = ["queued", "needs_work"]
terminal = ["custom_done"]
entry = "queued"
success = ["custom_done"]
exhausted = "custom_done"

[[phases]]
name = "run"
entry = true
startsAttempt = true
prompt = "run.md"

  # #408 cross-table DAG check requires every continuable status to have a
  # leaving phase-exit edge. The fixture's run phase had no exits declared —
  # this minimal exit keeps the status-snapshot test surface unchanged while
  # satisfying R2 (both continuable statuses can leave via "run → custom_done").
  [[phases.exits]]
  status = "custom_done"
  when = "Run finished and the item reached the success-terminal vocabulary."

  [phases.variables]
  ISSUE = "item.issue"

[agent]
binary = "echo"
extraArgs = []
attemptTimeoutSeconds = 3600
`)
			const config = JSON.stringify({ repository: "fixture/repo", baseBranch: "main", presetPath })
			expectJsonOk(await runCli(["chain", "create", "custom-status-chain", "--config-json", config, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			// #412: per-item preset required; mirror the chain's custom presetPath.
			expectJsonOk(await runCli(["item", "add", "custom-status-chain", "--issue", "45401", "--repo-cwd", target, "--preset-path", presetPath, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "update", "custom-status-chain", "--issue", "45401", "--status", "custom_done", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const chain = store.getChainByName("custom-status-chain")
				if (chain === null) throw new Error("expected custom-status-chain")
				store.updateChain(chain.id, { status: "completed" })
			} finally {
				store.close()
			}

			const status = expectJsonOk(await runCli(["status", target, "--chain", "custom-status-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.state).toMatchObject({ kind: "ok", ok: true })
			expect(status.target.preset).toMatchObject({ name: "custom-status-fixture", presetDir: presetPath })
			expect(status.queue).toMatchObject({ total: 1, continuable: 0, terminal: 1, selected: null })
			expect(status.queue.byStatus).toEqual({ custom_done: 1 })

			const daemonStatus = expectJsonOk(await runCli(["daemon", "status", target, "--chain", "custom-status-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(daemonStatus.state).toMatchObject({ kind: "ok", ok: true })
			expect(daemonStatus.target.preset).toMatchObject({ name: "custom-status-fixture", presetDir: presetPath })
			expect(daemonStatus.queue).toMatchObject({ total: 1, continuable: 0, terminal: 1, selected: null })
			expect(daemonStatus.queue.byStatus).toEqual({ custom_done: 1 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #412 retry — AC #3: in a mixed-preset chain (chain.preset != items[*].preset, or two items
	// declaring different presets), `coder-loop status --json` must resolve continuable / terminal
	// / idField from each item's own preset rather than the chain seed. Pre-fix, the chain-seed
	// `gh-issue-pr-iteration` preset's vocabulary was applied to every item: the foreign-preset
	// `single-phase-example` item's status ("pending") was not in the seed's continuable set, so
	// `state.kind` flipped to `invalid-runtime` and `queue.selected` became null once the
	// seed-preset items finished. The fix loads each item's preset and gates membership per-item.
	test("status CLI on mixed-preset chain selects foreign-preset item by its own continuable set (AC #3)", async () => {
		const fixture = await startFixture("status-mixed-preset")
		try {
			const target = await makeTarget("status-mixed-preset-target")
			expectJsonOk(await runCli(["chain", "create", "mixed-preset-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			// Item A: gh-issue-pr-iteration (chain seed). Advance it to `done` to drain the seed-preset
			// half of the queue, leaving only the foreign-preset item live.
			expectJsonOk(await runCli(["item", "add", "mixed-preset-chain", "--issue", "55501", "--repo-cwd", target, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "update", "mixed-preset-chain", "--issue", "55501", "--status", "done", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			// Item B: single-phase-example (foreign preset). idField=`id`, continuable=[`pending`],
			// terminal=[`done`]. We add it via single-phase-example so its idField bind requires
			// `id` rather than `issue`; pass `--field-json` for the id binding.
			expectJsonOk(await runCli([
				"item", "add", "mixed-preset-chain",
				"--issue", "55502",
				"--repo-cwd", target,
				"--preset", "single-phase-example",
				"--field-json", JSON.stringify({ id: "55502" }),
				"--loop-data-root", fixture.loopDataRoot,
				"--json",
			]))

			const status = expectJsonOk(await runCli(["status", target, "--chain", "mixed-preset-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.state).toMatchObject({ kind: "ok", ok: true })
			// queue.continuable counts items whose status is in their own preset's continuable set.
			// "pending" is continuable under single-phase-example (item B); "done" is terminal under
			// gh-issue-pr-iteration (item A). Pre-fix this would be 0 (foreign "pending" not in
			// seed continuable) and state.kind=invalid-runtime.
			expect(status.queue).toMatchObject({ total: 2, continuable: 1, terminal: 1 })
			expect(status.queue.selected).not.toBeNull()
			expect(status.queue.selected.item.preset).toBe("single-phase-example")
			// idField for single-phase-example is `id`; the snapshot resolves `id` via per-item preset.
			expect(status.queue.selected.id).toBe("55502")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("item reorder CLI", async () => {
		const fixture = await startFixture("item-reorder-cli")
		try {
			expectJsonOk(await runCli(["chain", "create", "reorder-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			// #412: per-item preset required.
			const itemsJson = JSON.stringify([
				// #419: wire input retires `issueNumber: int`; daemon accepts only `itemId: string`.
				{ itemId: "401", repoCwd: REPO_ROOT, title: "first", preset: "gh-issue-pr-iteration" },
				{ itemId: "402", repoCwd: REPO_ROOT, title: "second", preset: "gh-issue-pr-iteration" },
				{ itemId: "403", repoCwd: REPO_ROOT, title: "third", preset: "gh-issue-pr-iteration" },
			])
			expectJsonOk(await runCli(["item", "batch-add", "reorder-chain", "--items-json", itemsJson, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const moved = expectJsonOk(await runCli(["item", "reorder", "reorder-chain", "--issue", "403", "--position", "0", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(moved.items.map((item: BoundaryRecord) => item.itemId)).toEqual(["403", "401", "402"])
			expect(moved.items.map((item: BoundaryRecord) => item.position)).toEqual([0, 1, 2])

			const listed = expectJsonOk(await runCli(["item", "list", "reorder-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items.map((item: BoundaryRecord) => item.itemId)).toEqual(["403", "401", "402"])
			expect(listed.items.map((item: BoundaryRecord) => item.position)).toEqual([0, 1, 2])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("batch item add", async () => {
		const fixture = await startFixture("batch-item-add")
		try {
			expectJsonOk(await runCli(["chain", "create", "batch-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			// #412: per-item preset required.
			const itemsJson = JSON.stringify([
				// #419: wire input retires `issueNumber: int`; daemon accepts only `itemId: string`.
				{ itemId: "25801", repoCwd: REPO_ROOT, title: "first batch item", preset: "gh-issue-pr-iteration" },
				{ itemId: "25802", repoCwd: REPO_ROOT, priority: "high", preset: "gh-issue-pr-iteration" },
				{ itemId: "25803", repoCwd: REPO_ROOT, runner: "codex", preset: "gh-issue-pr-iteration" },
			])
			const added = expectJsonOk(await runCli(["item", "batch-add", "batch-chain", "--items-json", itemsJson, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(added.items).toHaveLength(3)
			expect(added.items.map((item: BoundaryRecord) => item.itemId)).toEqual(["25801", "25802", "25803"])

			const listed = expectJsonOk(await runCli(["item", "list", "batch-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(listed.items).toHaveLength(3)
			expect(listed.items.map((item: BoundaryRecord) => item.itemId)).toEqual(["25801", "25802", "25803"])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("batch item add matches daemon", async () => {
		const fixture = await startFixture("batch-item-add-matches-daemon")
		try {
			expectJsonOk(await runCli(["chain", "create", "batch-cli-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["chain", "create", "batch-daemon-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			// #412: per-item preset required.
			const batch = [
				// #419: wire input retires `issueNumber: int`; daemon accepts only `itemId: string`.
				{ itemId: "25901", repoCwd: REPO_ROOT, title: "same first", priority: "medium", preset: "gh-issue-pr-iteration" },
				{ itemId: "25902", repoCwd: REPO_ROOT, title: "same second", runner: "codex", preset: "gh-issue-pr-iteration" },
			]
			const cli = expectJsonOk(await runCli(["item", "batch-add", "batch-cli-chain", "--items-json", JSON.stringify(batch), "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const daemon = expectJsonOk(await runCli(["item", "batch-add", "batch-daemon-chain", "--items-json", JSON.stringify(batch), "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const comparable = (items: BoundaryRecord[]) => items.map((item) => ({
				itemId: item.itemId,
				repoCwd: item.repoCwd,
				status: item.status,
				title: item.title,
				priority: item.priority,
				runner: item.runner,
			}))
			expect(comparable(cli.items)).toEqual(comparable(daemon.items))

			const cliListed = expectJsonOk(await runCli(["item", "list", "batch-cli-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const daemonListed = expectJsonOk(await runCli(["item", "list", "batch-daemon-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(comparable(cliListed.items)).toEqual(comparable(daemonListed.items))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain status completion", async () => {
		const fixture = await startFixture("completion", { schedulerEnabled: true })
		try {
			expectJsonOk(await runCli(["chain", "create", "done-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "single-phase-example", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const chain = store.getChainByName("done-chain")
				if (chain === null) throw new Error("expected done-chain")
				store.createItem({ chainId: chain.id, itemId: "181", repoCwd: REPO_ROOT, status: admittedTestStatus("done") })
			} finally {
				store.close()
			}
			const status = await waitForJson(() => runCli(["chain", "status", "done-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]), (value) => value.chain?.status === "completed")
			expect(status.summary.completion.state).toBe("completed")
			expect(typeof status.summary.completion.completedAt).toBe("number")
			expect(status.summary.items.byStatus).toEqual({ done: 1 })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("chain status reports dependency waiting reason", async () => {
		const fixture = await startFixture("dependency-wait-status")
		try {
			expectJsonOk(await runCli(["chain", "create", "dependency-wait-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			let prerequisiteId = 0
			let dependentId = 0
			try {
				const chain = store.getChainByName("dependency-wait-chain")
				if (chain === null) throw new Error("expected dependency-wait-chain")
				const prerequisite = store.createItem({ chainId: chain.id, itemId: "2671", repoCwd: REPO_ROOT, status: admittedTestStatus("queued"), priority: "10" })
				const dependent = store.createItem({
					chainId: chain.id,
					itemId: "2672",
					repoCwd: REPO_ROOT,
					status: admittedTestStatus("queued"),
					priority: "00",
					extra: storedItemExtra({ dependsOn: [prerequisite.id] }),
				})
				prerequisiteId = prerequisite.id
				dependentId = dependent.id
			} finally {
				store.close()
			}

			const status = expectJsonOk(await runCli(["chain", "status", "dependency-wait-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const dependentStatus = status.items.find((item: BoundaryRecord) => item.id === dependentId)
			expect(dependentStatus?.waiting).toEqual({
				reason: "blocked-by-dependency",
				// #419: DependencyWaitReason renamed: `itemId: rowid` → `rowId: rowid`;
				// `issueNumber: int` → `itemId: string`.
				rowId: dependentId,
				itemId: "2672",
				repoCwd: REPO_ROOT,
				dependsOn: [prerequisiteId],
				unsatisfied: [prerequisiteId],
			})
			expect(status.summary.waiting.dependency).toEqual([dependentStatus?.waiting])
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon up down", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-down")
		const daemonProcess = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100", "--json"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		try {
			await waitFor(async () => {
				const socketStat = await stat(resolve(loopDataRoot, "daemon.sock"))
				return socketStat.isSocket() ? true : null
			}, 5_000)
			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot, "--json"])
			expect(down.exitCode).toBe(0)
			expect(JSON.parse(down.stdout)).toMatchObject({ ok: true, result: { shutdown: true } })
			expect(await daemonProcess.exited).toBe(0)
			const stdout = await new Response(daemonProcess.stdout).text()
			expect(JSON.parse(stdout)).toMatchObject({ action: "up", socketPath: resolve(loopDataRoot, "daemon.sock") })
		} finally {
			try {
				daemonProcess.kill()
			} catch {
				// Process may already have exited after daemon down.
			}
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	// #409 CLI-layer regression: `coder-loop daemon down` must inject the agent's env-borne
	// `CODER_LOOP_RUN_CRED` onto the wire so the daemon's `daemon.down` hard-deny-for-agent gate
	// actually fires for agent callers. Pre-fix, `runDaemonDownCommand` used
	// `sendDaemonRequestForDaemonCommand` which bypassed `withInjectedRunCredential`, so the
	// credential was silently stripped at the CLI layer and the daemon resolved the caller as
	// the operator — an agent could shut the daemon down cleanly while #409 row 1 demands the
	// opposite. A fabricated credential value is enough to prove the wiring: the daemon rejects
	// any non-empty credential it didn't mint, so a non-zero exit + intact daemon proves the
	// CLI attached `agentCredential`; without the fix the daemon would have killed itself
	// regardless of the env value. The "real agent credential → hard-deny-for-agent" branch is
	// covered separately in daemon.test.ts (`#409 row 1`).
	test("daemon down with CODER_LOOP_RUN_CRED env attaches agentCredential and is rejected by daemon (#409 CLI wiring)", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-down-agent-cred")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const daemonPid = Number((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim())
			// Agent-credential path: the credential value is unknown to the registry (no run
			// minted it), so the daemon's caller-admission resolver returns `unknown-credential`
			// at the hard-deny gate. Both `unknown-credential` and `hard-deny-for-agent` prove
			// that the credential reached the daemon — operator path returns no error at all.
			const agentDown = await runCli(
				["daemon", "down", "--loop-data-root", loopDataRoot, "--json"],
				{ CODER_LOOP_RUN_CRED: "fabricated-credential-from-agent-env" },
			)
			expect(agentDown.exitCode).not.toBe(0)
			expect(JSON.parse(agentDown.stdout)).toMatchObject({ ok: false, error: { code: "invalid_caller" } })
			expect(isPidAlive(daemonPid), "agent-credentialed daemon down must NOT kill the daemon").toBe(true)

			// Operator path (no env): the credential is omitted, the daemon resolves the caller
			// as operator, and the shutdown proceeds normally. Proves the fix did not regress the
			// operator path (#409 row 4 in the issue's acceptance table).
			const operatorDown = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot, "--json"])
			expect(operatorDown.exitCode).toBe(0)
			expect(JSON.parse(operatorDown.stdout)).toMatchObject({ ok: true, result: { shutdown: true } })
			expect(await daemonProcess.exited).toBe(0)
		} finally {
			try {
				daemonProcess.kill()
			} catch {
				// Process may already have exited after operator daemon down.
			}
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("daemon up ignores reload/debug signals and SIGQUIT shuts down gracefully", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-signal-policy")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const daemonPid = Number((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim())

			for (const signal of ["SIGUSR1", "SIGHUP", "SIGPIPE", "SIGUSR2"] as const) {
				process.kill(daemonPid, signal)
				await sleep(100)
				expect(isPidAlive(daemonPid), `${signal} should not stop daemon up`).toBe(true)
				expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))
			}

			process.kill(daemonPid, "SIGQUIT")
			expect(await daemonProcess.exited).toBe(0)
			await waitForDaemonSocketRemoval(loopDataRoot)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}

		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			const shutdownLoopDataRoot = await makeLoopDataRoot(`daemon-${signal.toLowerCase()}-policy`)
			const shutdownProcess = spawnDaemonUp(shutdownLoopDataRoot)
			try {
				await waitForDaemonFiles(shutdownLoopDataRoot)
				const shutdownPid = Number((await readFile(resolve(shutdownLoopDataRoot, "daemon.pid"), "utf-8")).trim())
				process.kill(shutdownPid, signal)
				expect(await shutdownProcess.exited).toBe(0)
				await waitForDaemonSocketRemoval(shutdownLoopDataRoot)
			} finally {
				shutdownProcess.kill()
				await shutdownProcess.exited.catch(() => undefined)
			}
		}
	})

	test("daemon shutdown cleans runtime after background rejection", async () => {
		const down = await exerciseShutdownAfterSocketRepairFailure("daemon-down")
		const sigterm = await exerciseShutdownAfterSocketRepairFailure("sigterm")

		expect(down).toEqual({ exitCode: 0, pidExists: false, socketExists: false })
		expect(sigterm).toEqual(down)
	})

	test("daemon down emits human text without json flag", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-down-text")
		const daemonProcess = Bun.spawn({
			cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		})
		try {
			await waitFor(async () => {
				const socketStat = await stat(resolve(loopDataRoot, "daemon.sock"))
				return socketStat.isSocket() ? true : null
			}, 5_000)
			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(down.stdout).toContain("daemon down: shutdown=true")
			expect(down.stdout).toContain(`socket=${resolve(loopDataRoot, "daemon.sock")}`)
			expect(await daemonProcess.exited).toBe(0)
			const stdout = await new Response(daemonProcess.stdout).text()
			expect(stdout).toContain("daemon up: pid=")
			expect(stdout).toContain(`socket=${resolve(loopDataRoot, "daemon.sock")}`)
		} finally {
			try {
				daemonProcess.kill()
			} catch {
				// Process may already have exited after daemon down.
			}
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("daemon commands expose json flag in help", async () => {
		for (const action of ["up", "status", "start", "stop", "restart", "down"]) {
			const help = await runCli(["daemon", action, "--help"])
			expect(help.exitCode).toBe(0)
			expect(help.stdout).toContain("--json")
		}
	})

	test("second daemon up fails without orphaning first daemon", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-duplicate")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const firstPid = (await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim()

			const duplicate = await runCli(["daemon", "up", "--loop-data-root", loopDataRoot])
			expect(duplicate.exitCode).toBe(1)
			expect(duplicate.stderr).toContain("daemon socket is already accepting connections")

			await waitForDaemonFiles(loopDataRoot)
			expect((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim()).toBe(firstPid)
			expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await daemonProcess.exited).toBe(0)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("concurrent daemon up race leaves one usable daemon", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-up-race")
		const first = spawnDaemonUp(loopDataRoot)
		const second = spawnDaemonUp(loopDataRoot)
		try {
			const loser = await waitForFirstExit([
				{ name: "first", proc: first },
				{ name: "second", proc: second },
			])
			const winner = loser.name === "first" ? second : first
			expect(loser.exitCode).toBe(1)
			expect(loser.stderr).toContain("daemon socket is already accepting connections")

			await waitForDaemonFiles(loopDataRoot)
			expectJsonOk(await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"]))

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await winner.exited).toBe(0)
		} finally {
			first.kill()
			second.kill()
			await Promise.all([first.exited.catch(() => undefined), second.exited.catch(() => undefined)])
		}
	})

	test("daemon not running explicit error", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `not-running-${++nextFixtureId}`)
		const result = await runCli(["chain", "list", "--loop-data-root", loopDataRoot, "--json"])
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("central daemon is not running")
		expect(result.stderr).toContain("coder-loop daemon up --loop-data-root")
	})

	test("daemon status and down --json emit JSON when central daemon is not running", async () => {
		const loopDataRoot = resolve(TEST_ROOT, `daemon-dead-json-${++nextFixtureId}`)
		await mkdir(loopDataRoot, { recursive: true })

		for (const action of ["status", "down"] as const) {
			const result = await runCli(["daemon", action, "--loop-data-root", loopDataRoot, "--json"])
			const parsed = expectJsonError(result)
			expect(result.stderr).toBe("")
			expect(parsed.error).toMatchObject({
				code: "daemon_not_running",
				details: {
					loopDataRoot,
					socketPath: resolve(loopDataRoot, "daemon.sock"),
					causeCode: "ENOENT",
				},
			})
			expect(parsed.error.message).toContain("central daemon is not running")
			expect(parsed.error.message).toContain("coder-loop daemon up --loop-data-root")
		}
	})

	test("daemon status --json reports live pid with missing socket pathname", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-socket-unlinked-json")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = Bun.spawn({
			cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		if (stale.pid === undefined) throw new Error("expected stale process pid")
		await writeFile(resolve(loopDataRoot, "daemon.pid"), `${stale.pid}\n`)

		try {
			const result = await runCli(["daemon", "status", "--loop-data-root", loopDataRoot, "--json"])
			const parsed = expectJsonError(result)
			expect(parsed.error.code).toBe("daemon_socket_unlinked")
			expect(parsed.error.details).toMatchObject({
				pid: stale.pid,
				socketPath: resolve(loopDataRoot, "daemon.sock"),
				pidFile: resolve(loopDataRoot, "daemon.pid"),
				causeCode: "ENOENT",
			})
		} finally {
			stale.kill()
			await stale.exited.catch(() => undefined)
		}
	})

	test("daemon up --json emits JSON when loop-data root cannot be prepared", async () => {
		await mkdir(TEST_ROOT, { recursive: true })
		const parentFile = resolve(TEST_ROOT, `not-a-directory-${++nextFixtureId}`)
		await writeFile(parentFile, "not a directory\n")
		const loopDataRoot = resolve(parentFile, "child")

		const result = await runCli(["daemon", "up", "--loop-data-root", loopDataRoot, "--json"])
		const parsed = expectJsonError(result)
		expect(result.stderr).toBe("")
		expect(parsed.error).toMatchObject({
			code: "db_unavailable",
			details: { loopDataRoot },
		})
		expect(parsed.error.message).toContain("unable to prepare loop-data directory")
	})

	test("daemon status target reports chain-only daemon from loop-data socket", async () => {
		const loopDataRoot = await makeLoopDataRoot("daemon-status-chain-only")
		const daemonProcess = spawnDaemonUp(loopDataRoot)
		try {
			await waitForDaemonFiles(loopDataRoot)
			const daemonPid = Number((await readFile(resolve(loopDataRoot, "daemon.pid"), "utf-8")).trim())

			const status = expectJsonOk(await runCli(["daemon", "status", REPO_ROOT, "--loop-data-root", loopDataRoot, "--json"]))
			const liveDaemon = status.processes.live.find((entry: BoundaryRecord) => entry.pid === daemonPid)
			expect(liveDaemon).toMatchObject({
				pid: daemonPid,
				source: "daemon-socket",
				alive: true,
				matchesTarget: true,
			})

			const down = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot])
			expect(down.exitCode).toBe(0)
			expect(await daemonProcess.exited).toBe(0)
		} finally {
			daemonProcess.kill()
			await daemonProcess.exited.catch(() => undefined)
		}
	})

	test("json output schema stable", async () => {
		const fixture = await startFixture("json-schema")
		try {
			expectJsonOk(await runCli(["chain", "create", "schema-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--umbrella", "mouriya-s-lab/coder-loop#176", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "schema-chain", "--issue", "181", "--repo-cwd", REPO_ROOT, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const status = expectJsonOk(await runCli(["chain", "status", "schema-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			expect(Object.keys(status).sort()).toEqual(["activeRuns", "chain", "items", "summary"])
			// #457: `summary.umbrella` retired — supervisors should read umbrella values from
			// `chain.metadata.bindings.umbrellaRepo / umbrellaIssue` directly.
			expect(Object.keys(status.summary).sort()).toEqual(["activeSlots", "completion", "items", "recovery", "waiting"])
			expect(status.summary.recovery).toEqual({ needed: false, staleInProgressItems: [] })
			expect(status.chain).toMatchObject({
				name: "schema-chain",
				preset: "gh-issue-pr-iteration",
				repository: "mouriya-s-lab/coder-loop",
				metadata: { bindings: { umbrellaRepo: "mouriya-s-lab/coder-loop", umbrellaIssue: 176 } },
			})
			expect(status.items[0]).toMatchObject({ itemId: "181", status: "queued", repoCwd: REPO_ROOT })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon start chain resolve", async () => {
		const fixture = await startFixture("target-cwd")
		try {
			expectJsonOk(await runCli(["chain", "create", "target-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "target-chain", "--issue", "184", "--repo-cwd", REPO_ROOT, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const start = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(start.exitCode).toBe(0)
			expect(start.stdout).toContain(`daemon start dry-run: target=${REPO_ROOT}`)
			expect(start.stdout).toContain("daemon start dry-run: chain=target-chain")
			expect(start.stdout).not.toContain("command=")

			const startJson = expectJsonOk(await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(startJson).toMatchObject({ action: "start", target: REPO_ROOT, chain: "target-chain", dryRun: true })

			const stopJson = expectJsonOk(await runCli(["daemon", "stop", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(stopJson).toMatchObject({ action: "stop", target: REPO_ROOT, chain: "target-chain", dryRun: true })

			const restartJson = expectJsonOk(await runCli(["daemon", "restart", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--dry-run", "--json"]))
			expect(restartJson).toMatchObject({ action: "restart", target: REPO_ROOT, chain: "target-chain", dryRun: true, centralDaemon: "required" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon stop preserves chain as stopped (regression: PR #194 wired it to chain.delete)", async () => {
		const fixture = await startFixture("daemon-stop-keeps-chain")
		try {
			expectJsonOk(await runCli(["chain", "create", "target-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "target-chain", "--issue", "184", "--repo-cwd", REPO_ROOT, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const stopJson = expectJsonOk(await runCli(["daemon", "stop", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "target-chain", "--json"]))
			expect(stopJson).toMatchObject({ action: "stop", target: REPO_ROOT, chain: "target-chain" })
			expect(stopJson.result.chain).toMatchObject({ name: "target-chain", status: "stopped" })
			expect(stopJson.result.chain.status).not.toBe("deleted")
			expect(stopJson.result.alreadyStopped).toBe(false)

			const status = expectJsonOk(await runCli(["chain", "status", "target-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.chain).toMatchObject({ name: "target-chain", status: "stopped" })

			const resumed = expectJsonOk(await runCli(["chain", "resume", "target-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(resumed.chain).toMatchObject({ name: "target-chain", status: "active" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon start ignores target-local legacy loop-data when loop-data root is omitted", async () => {
		// #433: the engine no longer reads any target runtime file — `--loop-data-root` / env wins
		// without exception. The legacy target-local layout below is just a noise directory; the
		// global store wins on its own merits.
		const target = await makeTarget("target-cwd-legacy-local")
		const globalLoopDataRoot = await makeLoopDataRoot("target-cwd-global")
		const targetLocalLoopDataRoot = resolve(target, ".coder-loop/runtime/loop-data")
		await mkdir(globalLoopDataRoot, { recursive: true })
		await mkdir(targetLocalLoopDataRoot, { recursive: true })

		const globalStore = openSqliteStateStore({ loopDataRoot: globalLoopDataRoot })
		try {
			globalStore.createChain({
				name: "global-chain",
				preset: "gh-issue-pr-iteration",
				repository: "fixture/repo",
				baseBranch: "main",
			})
		} finally {
			globalStore.close()
		}

		const legacyStore = openSqliteStateStore({ loopDataRoot: targetLocalLoopDataRoot })
		try {
			legacyStore.createChain({
				name: "legacy-local-chain",
				preset: "gh-issue-pr-iteration",
				repository: "fixture/repo",
				baseBranch: "main",
			})
		} finally {
			legacyStore.close()
		}

		const result = await runCli(
			["daemon", "start", target, "--dry-run", "--json"],
			{ [LOOP_DATA_ROOT_ENV]: globalLoopDataRoot },
		)
		const parsed = expectJsonOk(result)
		expect(parsed).toMatchObject({ action: "start", target, chain: "global-chain", dryRun: true })
	})

	test("daemon target-cwd fails explicitly when no chain matches", async () => {
		const fixture = await startFixture("target-cwd-missing")
		try {
			const start = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(start.exitCode).toBe(1)
			expect(start.stderr).toContain("SQLite state DB has no active chain")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon start ambiguous chain", async () => {
		const fixture = await startFixture("target-cwd-ambiguous")
		try {
			for (const chain of ["first-chain", "second-chain"]) {
				expectJsonOk(await runCli(["chain", "create", chain, "--config-json", DEFAULT_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
				expectJsonOk(await runCli(["item", "add", chain, "--issue", chain === "first-chain" ? "184" : "185", "--repo-cwd", REPO_ROOT, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			}

			const ambiguous = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--dry-run"])
			expect(ambiguous.exitCode).toBe(1)
			expect(ambiguous.stderr).toContain("matches multiple active chains")
			expect(ambiguous.stderr).toContain("--chain")

			const selected = await runCli(["daemon", "start", REPO_ROOT, "--loop-data-root", fixture.loopDataRoot, "--chain", "second-chain", "--dry-run"])
			expect(selected.exitCode).toBe(0)
			expect(selected.stdout).toContain("chain=second-chain")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("status json reports DB snapshot and live process scan", async () => {
		const fixture = await startFixture("status-json")
		try {
			const target = await makeTarget("status-json-target")
			expectJsonOk(await runCli(["chain", "create", "status-json-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["item", "add", "status-json-chain", "--issue", "184", "--repo-cwd", target, "--preset", "gh-issue-pr-iteration", "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const status = expectJsonOk(await runCli(["status", target, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expect(status.state).toMatchObject({ kind: "ok", ok: true, path: resolve(fixture.loopDataRoot, "db.sqlite") })
			expect(status.queue.selected.id).toBe("184")
			expect(Array.isArray(status.processes.live)).toBe(true)
			expect(status.processes.scanError === null || typeof status.processes.scanError === "string").toBe(true)
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("logs --chain reads stopped and completed chain history with explicit loop-data-root flag", async () => {
		// #433: `--loop-data-root` (or env) is now the only loop-data root source — target config
		// files are retired. Keep this test by passing the flag explicitly everywhere it was
		// previously implied by the target-local config file.
		const fixture = await startFixture("logs-non-active-chain-history", { schedulerEnabled: true })
		try {
			const target = await makeTarget("logs-non-active-chain-target")
			await mkdir(resolve(target, ".coder-loop/runtime"), { recursive: true })
			expectJsonOk(await runCli(["chain", "create", "logs-stopped-history-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["chain", "stop", "logs-stopped-history-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			expectJsonOk(await runCli(["chain", "create", "logs-completed-history-chain", "--config-json", DEFAULT_CHAIN_CONFIG, "--preset", "single-phase-example", "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const completedChain = store.getChainByName("logs-completed-history-chain")
				if (completedChain === null) throw new Error("expected logs-completed-history-chain")
				store.createItem({ chainId: completedChain.id, itemId: "411", repoCwd: REPO_ROOT, status: admittedTestStatus("done") })
			} finally {
				store.close()
			}
			await waitForJson(() => runCli(["chain", "status", "logs-completed-history-chain", "--loop-data-root", fixture.loopDataRoot, "--json"]), (value) => value.chain?.status === "completed")

			const stoppedLogs = expectJsonOk(await runCli([
				"logs",
				target,
				"--loop-data-root",
				fixture.loopDataRoot,
				"--chain",
				"logs-stopped-history-chain",
				"--json",
				"--kind",
				"audit",
				"--type",
				"chain.status",
			]))

			expect(stoppedLogs.path).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(stoppedLogs.events).toHaveLength(1)
			expect(stoppedLogs.events[0]).toMatchObject({
				kind: "audit",
				type: "chain.status",
				chain: "logs-stopped-history-chain",
				payload: { fromStatus: "active", toStatus: "stopped" },
			})
			const completedLogs = expectJsonOk(await runCli([
				"logs",
				target,
				"--loop-data-root",
				fixture.loopDataRoot,
				"--chain",
				"logs-completed-history-chain",
				"--json",
				"--kind",
				"lifecycle",
				"--type",
				"chain.completed",
			]))
			expect(completedLogs.path).toBe(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)
			expect(completedLogs.events).toHaveLength(1)
			expect(completedLogs.events[0]).toMatchObject({
				kind: "lifecycle",
				type: "chain.completed",
				chain: "logs-completed-history-chain",
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	// #436: install/uninstall surface deleted. The two doctor tests below remain — neither
	// looks at target files (zero target-file check is the K1 property doctor must satisfy).
	test("install and uninstall subcommands no longer exist", async () => {
		const env = await fakeCliEnv("install-retired")
		const installResult = await runCli(["install", "/tmp/x"], env)
		expect(installResult.exitCode).toBe(1)
		expect(installResult.stdout).toContain("Usage:")
		expect(installResult.stdout).not.toContain("install <target>")
		expect(installResult.stdout).not.toContain("uninstall <target>")
		const uninstallResult = await runCli(["uninstall", "/tmp/x"], env)
		expect(uninstallResult.exitCode).toBe(1)
		expect(uninstallResult.stdout).toContain("Usage:")
		expect(uninstallResult.stdout).not.toContain("install <target>")
		expect(uninstallResult.stdout).not.toContain("uninstall <target>")
	})

	test("doctor checks operator machine and live runtime; no target file checks", async () => {
		const fixture = await startFixture("doctor-chain")
		try {
			const env = await fakeCliEnv("doctor-chain")
			const target = await makeTarget("doctor-target")
			expectJsonOk(await runCli(["chain", "create", "doctor-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const result = await runCli(["doctor", target, "--repo", "fixture/repo", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-chain"], env)
			expect(result.exitCode, result.stderr).toBe(0)
			// #436: zero target-file checks. Doctor must not enumerate workflow.md / labels / skills /
			// any other target-relative artifact. Only operator-machine + live-runtime sections.
			expect(result.stderr).not.toContain("workflow.md")
			expect(result.stderr).not.toContain("[Layer A]")
			expect(result.stderr).not.toContain("[Layer D]")
			expect(result.stderr).not.toContain("Target 项目文件")
			expect(result.stderr).not.toContain("legacy local runtime")
			expect(result.stderr).toContain("[Operator machine]")
			expect(result.stderr).toContain("[Live Runtime]")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("doctor repo access succeeds", async () => {
		const fixture = await startFixture("doctor-repo-access-success")
		try {
			const fakeGh = await fakeDoctorCliEnv("doctor-repo-access-success", 0)
			const target = await makeTarget("doctor-repo-access-success-target")
			expectJsonOk(await runCli(["chain", "create", "doctor-repo-access-success", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const result = await runCli(["doctor", target, "--repo", "fixture/success", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-repo-access-success"], fakeGh.env)

			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stderr).toContain("OK: repo access fixture/success")
			expect(await readFile(fakeGh.callsPath, "utf-8")).toContain("repo view fixture/success")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("doctor repo access failure is fatal", async () => {
		const fixture = await startFixture("doctor-repo-access-failure")
		try {
			const fakeGh = await fakeDoctorCliEnv("doctor-repo-access-failure", 1)
			const target = await makeTarget("doctor-repo-access-failure-target")
			expectJsonOk(await runCli(["chain", "create", "doctor-repo-access-failure", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const result = await runCli(["doctor", target, "--repo", "fixture/failure", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-repo-access-failure"], fakeGh.env)

			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("FAIL: repo access fixture/failure")
			expect(await readFile(fakeGh.callsPath, "utf-8")).toContain("repo view fixture/failure")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("doctor omits repo access check without flag", async () => {
		const fixture = await startFixture("doctor-repo-access-omitted")
		try {
			const fakeGh = await fakeDoctorCliEnv("doctor-repo-access-omitted", 1)
			const target = await makeTarget("doctor-repo-access-omitted-target")
			expectJsonOk(await runCli(["chain", "create", "doctor-repo-access-omitted", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))

			const result = await runCli(["doctor", target, "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-repo-access-omitted"], fakeGh.env)

			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stderr).not.toContain("repo access")
			expect(await readFile(fakeGh.callsPath, "utf-8")).not.toContain("repo view")
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("doctor passes regardless of target .coder-loop/runtime presence", async () => {
		const fixture = await startFixture("doctor-runtime-dir")
		try {
			const env = await fakeCliEnv("doctor-runtime-dir")
			const target = await makeTarget("doctor-runtime-target")
			await mkdir(resolve(target, ".coder-loop/runtime"), { recursive: true })
			expectJsonOk(await runCli(["chain", "create", "doctor-runtime-chain", "--config-json", FIXTURE_CHAIN_CONFIG, "--loop-data-root", fixture.loopDataRoot, "--json"]))
			const result = await runCli(["doctor", target, "--repo", "fixture/repo", "--loop-data-root", fixture.loopDataRoot, "--chain", "doctor-runtime-chain"], env)
			expect(result.exitCode, result.stderr).toBe(0)
			expect(result.stderr).not.toContain("workflow.md")
			expect(result.stderr).not.toContain("WARN: .coder-loop/runtime")
			expect(result.stderr).not.toContain("legacy local runtime")
		} finally {
			await fixture.daemon.stop()
		}
	})
})

type Fixture = {
	daemon: CoderLoopDaemon
	loopDataRoot: string
}

type FixtureOptions = {
	schedulerEnabled?: boolean
}

async function startFixture(name: string, options: FixtureOptions = {}): Promise<Fixture> {
	const loopDataRoot = await makeLoopDataRoot(name)
	const daemon = await startCoderLoopDaemon({
		loopDataRoot,
		scheduler: {
			enabled: options.schedulerEnabled ?? false,
			intervalMs: 20,
			chainCompleteTriggerForChain: () => null,
		},
	})
	return { daemon, loopDataRoot }
}

async function makeLoopDataRoot(name: string): Promise<string> {
	const root = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(root, { recursive: true })
	return resolve(root, "loop-data")
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CODER_LOOP_RUN_CRED: undefined, ...env },
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	return {
		exitCode,
		stdout,
		stderr,
	}
}

type TestDaemonResponse =
	| { id: string; ok: true; result: BoundaryRecord }
	| { id: string; ok: false; error: { code: string; message: string } }

async function sendLinesOnDaemonConnection(socketPath: string, lines: readonly string[]): Promise<TestDaemonResponse[]> {
	return await new Promise((resolveResponses, reject) => {
		const socket = createConnection(socketPath)
		const responses: TestDaemonResponse[] = []
		let buffer = ""
		const cleanup = () => {
			socket.removeAllListeners()
			socket.destroy()
		}
		socket.setEncoding("utf-8")
		socket.on("connect", () => socket.write(`${lines.join("\n")}\n`))
		socket.on("data", (chunk: string) => {
			buffer += chunk
			let newlineIndex = buffer.indexOf("\n")
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				responses.push(parseTestDaemonResponse(line))
				if (responses.length === lines.length) {
					cleanup()
					resolveResponses(responses)
					return
				}
				newlineIndex = buffer.indexOf("\n")
			}
		})
		socket.on("error", (error) => {
			cleanup()
			reject(error)
		})
	})
}

function parseTestDaemonResponse(line: string): TestDaemonResponse {
	const parsed: unknown = JSON.parse(line)
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected daemon response object")
	const response = boundaryRecord(parsed)
	const id = response.id
	if (typeof id !== "string") throw new Error("expected daemon response id")
	if (response.ok === true) {
		const result = response.result
		if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("expected daemon response result")
		return { id, ok: true, result: boundaryRecord(result) }
	}
	if (response.ok !== false) throw new Error("expected daemon response ok")
	const error = response.error
	if (typeof error !== "object" || error === null || Array.isArray(error)) throw new Error("expected daemon response error")
	const errorRecord = boundaryRecord(error)
	if (typeof errorRecord.code !== "string" || typeof errorRecord.message !== "string") throw new Error("expected daemon response error fields")
	return { id, ok: false, error: { code: errorRecord.code, message: errorRecord.message } }
}

function boundaryRecord(value: unknown): BoundaryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
	return value as BoundaryRecord
}

function spawnDaemonUp(loopDataRoot: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"],
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CODER_LOOP_RUN_CRED: undefined },
	})
}

async function exerciseShutdownAfterSocketRepairFailure(
	mode: "daemon-down" | "sigterm",
): Promise<{ exitCode: number | null; pidExists: boolean; socketExists: boolean }> {
	const loopDataRoot = await makeLoopDataRoot(`daemon-background-rejection-${mode}`)
	const socketPath = resolve(loopDataRoot, "daemon.sock")
	const pidFile = resolve(loopDataRoot, "daemon.pid")
	const daemonProcess = spawnDaemonUp(loopDataRoot)
	try {
		await waitForDaemonFiles(loopDataRoot)
		const daemonPid = Number((await readFile(pidFile, "utf-8")).trim())
		await unlink(socketPath)
		await mkdir(socketPath)
		await new Promise((resolveWait) => setTimeout(resolveWait, 600))
		expect(isPidAlive(daemonPid)).toBe(true)

		await rm(socketPath, { recursive: true })
		await waitFor(async () => {
			try {
				return (await stat(socketPath)).isSocket() ? true : null
			} catch {
				return null
			}
		}, 5_000)
		if (mode === "daemon-down") {
			const result = await runCli(["daemon", "down", "--loop-data-root", loopDataRoot, "--json"])
			expect(result.exitCode).toBe(0)
		} else {
			process.kill(daemonPid, "SIGTERM")
		}

		const exitCode = await daemonProcess.exited
		const stderr = await new Response(daemonProcess.stderr).text()
		expect(stderr).toContain("coder-loop daemon socket repair failed:")
		expect(stderr).toContain(socketPath)
		return {
			exitCode,
			pidExists: await pathExistsForShutdownTest(pidFile),
			socketExists: await pathExistsForShutdownTest(socketPath),
		}
	} finally {
		await rm(socketPath, { recursive: true, force: true })
		daemonProcess.kill()
		await daemonProcess.exited
	}
}

async function pathExistsForShutdownTest(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
		throw error
	}
}

async function waitForDaemonFiles(loopDataRoot: string): Promise<void> {
	const socketPath = resolve(loopDataRoot, "daemon.sock")
	const pidFile = resolve(loopDataRoot, "daemon.pid")
	await waitFor(async () => {
		const [socketStat, pidStat] = await Promise.all([stat(socketPath), stat(pidFile)])
		return socketStat.isSocket() && pidStat.isFile() ? true : null
	}, 5_000)
}

async function waitForDaemonSocketRemoval(loopDataRoot: string): Promise<void> {
	await waitFor(async () => {
		try {
			await stat(resolve(loopDataRoot, "daemon.sock"))
			return null
		} catch {
			return true
		}
	}, 5_000)
}

type NamedDaemonProcess = {
	name: string
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">
}

async function waitForFirstExit(processes: NamedDaemonProcess[]): Promise<{ name: string; exitCode: number | null; stderr: string }> {
	return await Promise.race(processes.map(async ({ name, proc }) => ({
		name,
		exitCode: await proc.exited,
		stderr: await new Response(proc.stderr).text(),
	})))
}

// #436: target directories no longer seed `.coder-loop/workflow.md` — the engine
// retired the per-target policy file in #434 and the doctor surface that asserted
// its existence in #436. Plain empty directories are sufficient for the remaining
// tests (status snapshot, doctor live-runtime output, etc.) which only need a
// stable filesystem anchor for spawn cwd / chain bookkeeping.
async function makeTarget(name: string): Promise<string> {
	const target = resolve(TEST_ROOT, `${++nextFixtureId}-${name}`)
	await mkdir(target, { recursive: true })
	return target
}

async function fakeCliEnv(name: string): Promise<Record<string, string>> {
	const bin = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-bin`)
	const home = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-home`)
	await mkdir(bin, { recursive: true })
	await mkdir(home, { recursive: true })
	await writeExecutable(resolve(bin, "gh"), [
		"#!/usr/bin/env bash",
		`if [ "$1" = "auth" ]; then exit 0; fi`,
		"exit 0",
		"",
	].join("\n"))
	for (const name of ["codex", "claude", "coder-loop"]) {
		await writeExecutable(resolve(bin, name), "#!/usr/bin/env bash\nexit 0\n")
	}
	return { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }
}

async function fakeDoctorCliEnv(name: string, repoExitCode: number): Promise<{ env: Record<string, string>; callsPath: string }> {
	const bin = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-bin`)
	const home = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-home`)
	const callsPath = resolve(TEST_ROOT, `${++nextFixtureId}-${name}-gh-calls.log`)
	await mkdir(bin, { recursive: true })
	await mkdir(home, { recursive: true })
	await writeExecutable(resolve(bin, "gh"), [
		"#!/usr/bin/env bash",
		'printf "%s\\n" "$*" >> "$FAKE_GH_CALLS"',
		'if [ "$1" = "auth" ]; then exit 0; fi',
		'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then exit "$FAKE_GH_REPO_EXIT"; fi',
		"exit 0",
		"",
	].join("\n"))
	for (const executable of ["codex", "claude", "coder-loop"]) {
		await writeExecutable(resolve(bin, executable), "#!/usr/bin/env bash\nexit 0\n")
	}
	return {
		env: {
			HOME: home,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FAKE_GH_CALLS: callsPath,
			FAKE_GH_REPO_EXIT: String(repoExitCode),
		},
		callsPath,
	}
}

async function writeExecutable(path: string, content: string): Promise<void> {
	await writeFile(path, content, { mode: 0o755 })
}

function expectJsonOk(result: { exitCode: number | null; stdout: string; stderr: string }) {
	expect(result.exitCode, result.stderr).toBe(0)
	return JSON.parse(result.stdout)
}

function expectJsonError(result: { exitCode: number | null; stdout: string; stderr: string }): { ok: false; error: { code: string; message: string; details?: BoundaryRecord } } {
	expect(result.exitCode, result.stderr).toBe(1)
	const parsed = JSON.parse(result.stdout)
	expect(parsed.ok).toBe(false)
	expect(typeof parsed.error?.code).toBe("string")
	expect(typeof parsed.error?.message).toBe("string")
	return parsed
}

async function waitForJson(
	read: () => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
	predicate: (value: ReturnType<typeof expectJsonOk>) => boolean,
	timeoutMs = 2_000,
): Promise<ReturnType<typeof expectJsonOk>> {
	return await waitFor(async () => {
		const result = expectJsonOk(await read())
		return predicate(result) ? result : null
	}, timeoutMs)
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number, intervalMs = 20): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let latest: T | null = await read().catch(() => null)
	while (latest === null) {
		if (Date.now() > deadline) throw new Error("condition not met before timeout")
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
		latest = await read().catch(() => null)
	}
	return latest
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveWait) => setTimeout(resolveWait, ms))
}
