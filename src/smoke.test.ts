import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createWriteStream } from "node:fs"

import { startCoderLoopDaemon, type CoderLoopDaemon } from "./daemon"
import { openSqliteStateStore } from "./sqlite-state"
import { parseObservabilityEvent, type ObservabilityEvent } from "./observability"
import { engineLifecycleAdmittedItemStatus, parseInternalStatus, storedChainMetadata, storedItemExtra } from "./runtime-data"
import { createStreamTextState } from "./runner-output"

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
	test("bounds runner memory while preserving large output artifacts", async () => {
		const artifactDir = resolve(TEST_ROOT, "large-output-artifacts")
		await mkdir(artifactDir, { recursive: true })
		for (const path of [resolve(artifactDir, "scheduler.log"), resolve(artifactDir, "chain-complete.log")]) {
			let maxPendingChars = 0
			const state = createStreamTextState(() => {})
			const artifactWriter = createWriteStream(path)
			for (let index = 0; index < 100_000; index++) {
				const chunk = Buffer.from(`large-output-${index}\n`)
				state.observe(chunk)
				if (!artifactWriter.write(chunk)) await new Promise<void>((resolveDrain) => artifactWriter.once("drain", resolveDrain))
				maxPendingChars = Math.max(maxPendingChars, state.pendingChars())
			}
			state.finish()
			await new Promise<void>((resolveClosed) => artifactWriter.end(resolveClosed))
			const artifact = await stat(path)
			expect(artifact.size).toBe(state.bytes())
			expect(maxPendingChars).toBe(0)
		}
	})

	test("no-subcommand invocation is usage-only and does not enter a loop", () => {
		const result = runCli([])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toContain("Usage: coder-loop <command> [options]")
		expect(result.stdout).toContain("daemon <up|down|status|start|stop|restart>")
	})

	// #526 (closing #432 K2 末段 + close-verification row #4): the entire `runtime`
	// CLI namespace is retired. The runner-binding model-override slice that #481
	// had bolted onto it moved to `coder-loop chain set-runner-model` (chain
	// subcommand group). Usage must list neither a literal `runtime` line nor the
	// flag set the retired narrow surface had — and must list the replacement chain
	// subcommand. The two `toContain` checks are paired so a future regression that
	// adds the wrong half (e.g. listing `runtime set` again, or dropping the new
	// `set-runner-model` from the chain group) fails before it merges.
	test("usage no longer lists the retired runtime CLI; lists chain set-runner-model instead (#526)", () => {
		const result = runCli([])
		expect(result.stdout).not.toContain("runtime set <target>")
		expect(result.stdout).not.toContain("[--claude-model M] [--codex-model M] [--opencode-model M]")
		expect(result.stdout).not.toMatch(/^\s*runtime\b/m)
		expect(result.stdout).toContain("chain <create|list|status|stop|resume|delete|set-runner-model>")
	})

	// #526: typing the retired `runtime` namespace must fall through to the generic
	// unknown-command branch (usage + exit 1), not into a runtime-scoped error
	// message. Asserts both the exit code and the absence of the retired sub-error
	// shape so a future revival of `runRuntimeCommand` (or any analogous dispatch
	// branch under firstArg === "runtime") fails this row.
	test("invoking the retired `runtime` namespace falls through to generic usage + exit 1 (#526)", () => {
		const setResult = runCli(["runtime", "set", ".", "--claude-model", "x"])
		expect(setResult.exitCode).toBe(1)
		expect(setResult.stdout).toContain("Usage: coder-loop <command> [options]")
		const setCombined = setResult.stderr + setResult.stdout
		expect(setCombined).not.toContain("only `runtime")
		expect(setCombined).not.toContain("runtime set: <target> is required")

		const showResult = runCli(["runtime", "show", "."])
		expect(showResult.exitCode).toBe(1)
		expect(showResult.stdout).toContain("Usage: coder-loop <command> [options]")
		const showCombined = showResult.stderr + showResult.stdout
		expect(showCombined).not.toContain("only `runtime")
		expect(showCombined).not.toContain("runtime set: <target> is required")
	})

	// #526: happy-path for the new `chain set-runner-model` CLI surface. Locks in the
	// wire patch shape ({<kind>: {model}}), the idempotency short-circuit
	// (`alreadyMatched=true` / `updatedKinds=[]` on second identical write), the
	// daemon-reported metadata round-trip, and the SQLite read-back of
	// `chain.metadata.<kind>.model`. Without this row the new surface is locked only
	// by negative usage assertions, leaving the operational write path untested.
	test("chain set-runner-model patches chain.metadata.<kind>.model idempotently (#526)", async () => {
		const fixture = await createTarget("chain-set-runner-model-smoke")
		const seedStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
		try {
			seedStore.createChain({
				name: fixture.chainName,
				preset: "gh-issue-pr-iteration",
				repository: "fixture/repo",
				baseBranch: "main",
				metadata: storedChainMetadata({}),
			})
		} finally {
			seedStore.close()
		}

		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const argsBase = [
				"chain",
				"set-runner-model",
				fixture.chainName,
				"--kind",
				"opencode",
				"--model",
				"opencode-go/glm-5.2",
				"--loop-data-root",
				fixture.loopDataRoot,
				"--json",
			]

			const first = expectJsonOk(await runCliAsync(argsBase))
			expect(first.alreadyMatched).toBe(false)
			expect(first.updatedKinds).toEqual(["opencode"])
			expect(first.chain.metadata.opencode.model).toBe("opencode-go/glm-5.2")

			const second = expectJsonOk(await runCliAsync(argsBase))
			expect(second.alreadyMatched).toBe(true)
			expect(second.updatedKinds).toEqual([])
			expect(second.chain.metadata.opencode.model).toBe("opencode-go/glm-5.2")

			const verifyStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				const reread = verifyStore.getChainByName(fixture.chainName)
				expect(reread).not.toBeNull()
				const metadata = reread?.metadata as { opencode?: { model?: string } }
				expect(metadata?.opencode?.model).toBe("opencode-go/glm-5.2")
			} finally {
				verifyStore.close()
			}
		} finally {
			await daemon.stop()
		}
	}, 30_000)

	// #526: CLI-side parser rejections for `chain set-runner-model`. These run without a
	// daemon (the CLI parser fails before any socket round-trip), pinning the boundary
	// guarantees `parseRequiredRunnerKind` / `parseRequiredNonEmptyString` make. The
	// whitespace row is specifically a regression test for the silent-failure path
	// surfaced in code review: pre-fix, `--model "   "` landed `model: "   "` in SQLite.
	test("chain set-runner-model rejects bogus --kind / empty / whitespace --model at parse time (#526)", () => {
		const bogusKind = runCli(["chain", "set-runner-model", "anychain", "--kind", "bogus", "--model", "claude-sonnet-4-6"])
		expect(bogusKind.exitCode).toBe(1)
		const bogusKindCombined = bogusKind.stderr + bogusKind.stdout
		expect(bogusKindCombined).toContain("--kind must be claude, codex, or opencode")

		const whitespaceModel = runCli(["chain", "set-runner-model", "anychain", "--kind", "opencode", "--model", "   "])
		expect(whitespaceModel.exitCode).toBe(1)
		const whitespaceCombined = whitespaceModel.stderr + whitespaceModel.stdout
		expect(whitespaceCombined).toContain("--model must not contain whitespace")

		const innerWhitespaceModel = runCli(["chain", "set-runner-model", "anychain", "--kind", "opencode", "--model", "has space"])
		expect(innerWhitespaceModel.exitCode).toBe(1)
		expect(innerWhitespaceModel.stderr + innerWhitespaceModel.stdout).toContain("--model must not contain whitespace")
	})

	test("status and queue unblock use SQLite state", async () => {
		const fixture = await createTarget("chain-smoke")
		seedChain(fixture, {
			legacyItemNumber: 333,
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
			const unblocked = expectJsonOk(await runCliAsync(["queue", "unblock", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--item", "333", "--chain", fixture.chainName]))
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
			legacyItemNumber: 406_400,
			status: "blocked",
			extra: { blockerRepo: "owner/dependency", blockerRef: "#406" },
		})
		const daemon = await startCoderLoopDaemon({ loopDataRoot: fixture.loopDataRoot, shutdownGraceMs: 100, scheduler: { enabled: false } })
		try {
			const unblocked = expectJsonOk(await runCliAsync(["queue", "unblock", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--item", "406400", "--chain", fixture.chainName]))
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
					// #419: payload retired `legacyItemNumber: int` in favor of `rowId` (items.id rowid)
					// + `itemId` (preset-declared opaque string).
					itemId: "406400",
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
		seedChain(fixture, { legacyItemNumber: 191, status: "queued" })

		const baseline = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))

		// Drop a stale legacy file in. With #433, the engine no longer reads it; everything must
		// resolve via centralized chain metadata, so the runner view is identical.
		const legacyConfigPath = resolve(fixture.target, ".coder-loop/runtime/cl433-legacy-prefs.json")
		await writeFile(legacyConfigPath, `${JSON.stringify({ claude: { model: "should-be-ignored" }, codex: { model: "should-also-be-ignored" } }, null, 2)}\n`)

		const afterLegacy = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))

		expect(afterLegacy.target.runner).toEqual(baseline.target.runner)
		expect(afterLegacy.queue.selected.runner).toEqual(baseline.queue.selected.runner)
		// #456: the per-phase runner enumeration (`queue.selected.phaseRunners`,
		// `target.runner.phases`) is the only runner face after role taxonomy retirement.
		expect(afterLegacy.queue.selected.phaseRunners).toEqual(baseline.queue.selected.phaseRunners)
	})

	// #433: the supervisor-visible status schema no longer carries config/configPath/configFormat.
	test("status --json target keys do not include any retired config fields", async () => {
		const fixture = await createTarget("status-no-config")
		seedChain(fixture, { legacyItemNumber: 192, status: "queued" })
		const snapshot = expectJsonOk(runCli(["status", fixture.target, "--loop-data-root", fixture.loopDataRoot, "--chain", fixture.chainName, "--json"]))
		const keys = Object.keys(snapshot.target)
		for (const retired of ["config", "configPath", "configFormat"]) {
			expect(keys).not.toContain(retired)
		}
	})

	test("daemon start dry-run resolves a chain and emits central-daemon plan", async () => {
		const fixture = await createTarget("daemon-smoke")
		seedChain(fixture, { legacyItemNumber: 184, status: "queued" })

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
	legacyItemNumber: number
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
			itemId: String(options.legacyItemNumber),
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
		env: { ...process.env, CODER_LOOP_RUN_CRED: undefined },
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
		env: { ...process.env, CODER_LOOP_RUN_CRED: undefined },
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
