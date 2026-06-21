import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"
import { openSqliteStateStore } from "./sqlite-state"
import { parseObservabilityEvent, type ObservabilityEvent } from "./observability"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const TEST_ROOT = resolve(REPO_ROOT, ".coder-loop/runtime/evidence/smoke-tests", String(process.pid))

// #397 test brand helper — see install-commands.test.ts for rationale.
function runtimeStatus(value: string) {
	return engineLifecycleAdmittedItemStatus(parseInternalStatus(value, "test.status"), "test")
}

afterAll(async () => {
	await rm(TEST_ROOT, { recursive: true, force: true })
})

describe("smoke: v2 central chain CLI", () => {
	test("no-subcommand invocation is usage-only and does not enter a loop", () => {
		const result = runCli([])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toContain("Usage: coder-loop <command> [options]")
		expect(result.stdout).toContain("daemon <up|down|status|start|stop|restart>")
	})

	// #433: usage must not advertise the retired `runtime` command group.
	test("usage no longer lists the retired runtime CLI", () => {
		const result = runCli([])
		expect(result.stdout).not.toContain("runtime")
	})

	test("status and queue unblock use SQLite state", async () => {
		const fixture = await createTarget("chain-smoke")
		seedChain(fixture, {
			issueNumber: 333,
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#267" },
		})
		const beforeState = await readFile(fixture.legacyStatePath, "utf-8")
		const beforeMtime = (await stat(fixture.legacyStatePath)).mtimeMs

		// #409: queue unblock now daemonizes (the mutation goes through the daemon's hard-deny
		// gate so an agent process can't write blocker state). Run an in-process daemon for the
		// CLI subprocess to talk to; the test uses `runCliAsync` (not spawnSync) so the daemon
		// can process the request while the subprocess is alive. Operator path = no credential
		// → daemon caller-resolution treats it as `kind: "operator"`.
		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const unblocked = expectJsonOk(await runCliAsync(["queue", "unblock", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--issue", "333", "--chain", fixture.chainName]))
			expect(unblocked.mutation.changed).toBe(true)
			expect(unblocked.verification.itemStatus).toBe("queued")

			const snapshot = expectJsonOk(await runCliAsync(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))
			expect(snapshot.state.kind).toBe("ok")
			expect(snapshot.queue.total).toBe(1)
			expect(snapshot.queue.selected.id).toBe("333")
			expect(await readFile(fixture.legacyStatePath, "utf-8")).toBe(beforeState)
			expect((await stat(fixture.legacyStatePath)).mtimeMs).toBe(beforeMtime)
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #406 row 4 / #409 — operator vs agent+run distinguishability for `queue unblock`. The
	// CLI's `queue unblock` now daemonizes (the mutation goes through the daemon's hard-deny
	// gate so an agent process can't write blocker state). The daemon emits the
	// `item.mutation.caller_admission` audit event tagged `subject: {kind: "operator"}` so the
	// audit stream stays uniform with the daemon-mediated operator `item update` path.
	// The test:
	//   1. seeds a blocked item and unblocks it through the daemon.
	//   2. queries `coder-loop logs --kind audit --type item.mutation.caller_admission --json`.
	//   3. asserts exactly one event with operator subject + reason=operator + outcome=allow.
	//   4. asserts no agent-subject event for this fixture (no agent ever spawned).
	test("queue unblock emits operator-subject caller-admission audit (#406 row 4)", async () => {
		const fixture = await createTarget("queue-unblock-audit")
		seedChain(fixture, {
			issueNumber: 406_400,
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#406" },
		})
		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const unblocked = expectJsonOk(await runCliAsync(["queue", "unblock", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--issue", "406400", "--chain", fixture.chainName]))
			expect(unblocked.mutation.changed).toBe(true)
			expect(unblocked.verification.itemStatus).toBe("queued")

			const auditLogs = expectJsonOk(await runCliAsync([
				"logs",
				fixture.target,
				"--loop-data-root",
				fixture.loopDataRoot,
				"--chain",
				fixture.chainName,
				"--kind",
				"audit",
				"--type",
				"item.mutation.caller_admission",
				"--json",
			]))
			expect(Array.isArray(auditLogs.events)).toBe(true)
			expect(auditLogs.events).toHaveLength(1)
			expect(auditLogs.events[0]).toMatchObject({
				kind: "audit",
				type: "item.mutation.caller_admission",
				subject: { kind: "operator" },
				payload: {
					issueNumber: 406_400,
					claimedRunId: null,
					claimedPhase: null,
					outcome: "allow",
					reason: "operator",
				},
			})
			// No agent-subject event exists in this fixture: no scheduler run, no minted credential.
			// `subject.kind === "agent"` would imply a credential-admitted path, which never happened.
			const allAudit = expectJsonOk(await runCliAsync([
				"logs",
				fixture.target,
				"--loop-data-root",
				fixture.loopDataRoot,
				"--chain",
				fixture.chainName,
				"--kind",
				"audit",
				"--json",
			]))
			// Re-parse each wire-shaped event through the arktype boundary so the filter operates on
			// the precise `ObservabilityEvent` tagged union, not an `any`/anonymous cast (red-line).
			const allAuditEvents = parseObservabilityEventArray(allAudit.events)
			const agentSubjectAdmissionEvents = allAuditEvents.filter(
				(event) =>
					event.kind === "audit" &&
					event.type === "item.mutation.caller_admission" &&
					event.subject?.kind === "agent",
			)
			expect(agentSubjectAdmissionEvents).toHaveLength(0)
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #433: status output is flag-insensitive to the retired target config file. Whether or not
	// any legacy `.coder-loop/runtime/config.{json,toml}` exists on disk, the engine reads the
	// same chain.metadata and reports the same runner view. Acceptance row 3.
	test("status --json runner view does not change when a stale target config file is dropped in", async () => {
		const fixture = await createTarget("status-runner-flag")
		seedChain(fixture, { issueNumber: 191, status: "queued" })

		const baseline = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))

		// Drop a stale legacy file in. With #433, the engine no longer reads it; everything must
		// resolve via centralized chain metadata, so the runner view is identical.
		const legacyConfigPath = resolve(fixture.target, ".coder-loop/runtime/cl433-legacy-prefs.json")
		await writeFile(legacyConfigPath, `${JSON.stringify({ claude: { model: "should-be-ignored" }, codex: { model: "should-also-be-ignored" } }, null, 2)}\n`)

		const afterLegacy = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))

		expect(afterLegacy.target.runner).toEqual(baseline.target.runner)
		expect(afterLegacy.queue.selected.runner).toEqual(baseline.queue.selected.runner)
		expect(afterLegacy.queue.selected.reviewRunner).toEqual(baseline.queue.selected.reviewRunner)
	})

	// #433: the supervisor-visible status schema no longer carries config/configPath/configFormat.
	test("status --json target keys do not include any retired config fields", async () => {
		const fixture = await createTarget("status-no-config")
		seedChain(fixture, { issueNumber: 192, status: "queued" })
		const snapshot = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))
		const keys = Object.keys(snapshot.target)
		for (const retired of ["config", "configPath", "configFormat"]) {
			expect(keys).not.toContain(retired)
		}
	})

	test("daemon start dry-run resolves a chain and emits central-daemon plan", async () => {
		const fixture = await createTarget("daemon-smoke")
		seedChain(fixture, { issueNumber: 184, status: "queued" })

		const result = runCli(["daemon", "start", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--dry-run"])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain(`daemon start dry-run: chain=${fixture.chainName}`)
		expect(result.stdout).toContain("daemon start dry-run: central-daemon=required")
	})
})

type Fixture = {
	target: string
	loopDataRoot: string
	chainName: string
	legacyStatePath: string
}

type SeedOptions = {
	issueNumber: number
	status: string
	extra?: Record<string, string>
}

async function createTarget(name: string): Promise<Fixture> {
	const root = resolve(TEST_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	const target = resolve(root, "target")
	const runtime = resolve(target, ".coder-loop/runtime")
	const loopDataRoot = resolve(root, "loop-data")
	const chainName = `${name}-chain`
	await mkdir(resolve(target, ".coder-loop"), { recursive: true })
	await mkdir(runtime, { recursive: true })
	await mkdir(loopDataRoot, { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", chainName, "issues"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", chainName, "evidence"), { recursive: true })
	await mkdir(resolve(loopDataRoot, "chains", chainName, "runs"), { recursive: true })
	await writeFile(resolve(loopDataRoot, "chains", chainName, "shared.md"), "# shared\n")
	await writeFile(resolve(runtime, "shared.md"), "# shared\n")
	// #433: the engine no longer reads any target on-disk runtime config; loop-data root is
	// passed via flag or env. Just keep a benign legacy state.json placeholder around so the
	// "do not touch legacy files" smoke check still has something to mtime-pin.
	const legacyStatePath = resolve(runtime, "state.json")
	await writeFile(legacyStatePath, `${JSON.stringify({ queue: [], recentRuns: [], current: null }, null, 2)}\n`)
	return { target, loopDataRoot, chainName, legacyStatePath }
}

function seedChain(fixture: Fixture, options: SeedOptions): void {
	const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
	try {
		const chain = store.createChain({
			name: fixture.chainName,
			preset: "gh-issue-pr-iteration",
			repository: "fixture/repo",
			baseBranch: "main",
			metadata: storedChainMetadata({}),
		})
		store.createItem({
			chainId: chain.id,
			issueNumber: options.issueNumber,
			repoCwd: fixture.target,
			status: runtimeStatus(options.status),
			issueFile: null,
			evidenceDir: null,
			extra: storedItemExtra(options.extra ?? {}),
		})
	} finally {
		store.close()
	}
}

function runCli(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: proc.exitCode,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	}
}

// #409: async variant required when the CLI talks to an in-process daemon in the same Bun
// runtime. `Bun.spawnSync` blocks the event loop, which deadlocks the daemon (it can't accept
// connections while spawnSync is waiting on the subprocess that's trying to connect).
async function runCliAsync(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", LOOP_ENTRY, ...args],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { exitCode, stdout, stderr }
}

function expectJsonOk(result: { exitCode: number | null; stdout: string; stderr: string }): any {
	expect(result.exitCode, result.stderr).toBe(0)
	return JSON.parse(result.stdout)
}

// Boundary parser for `coder-loop logs --json` event arrays. The CLI stdout is opaque text
// (`expectJsonOk` returns `any` by necessity since each command emits a different envelope);
// this helper re-parses each entry through the arktype `ObservabilityEvent` boundary so the
// caller gets the precise tagged union — discharging an opaque external payload at a real
// boundary parse entry, with no `as` cast onto an anonymous shape (#406 红线).
function parseObservabilityEventArray(rawEvents: Iterable<unknown>): ObservabilityEvent[] {
	const events: ObservabilityEvent[] = []
	for (const raw of rawEvents) {
		events.push(parseObservabilityEvent(raw))
	}
	return events
}
