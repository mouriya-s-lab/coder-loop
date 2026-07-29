import { FAKE_RUNNER_STATUS_WRITE_SNIPPET, TEST_ROOT, chmod, daemonRequest, deferred, describe, expect, expectOk, mkdir, numberValue, openSqliteStateStore, pathIsSocket, readChainStatus, readFile, record, request, resolve, runtimeStatus, sendDaemonRequest, sendLinesOnDaemonConnection, spawn, startCoderLoopDaemon, startFixture, stringValue, test, unlink, waitFor, waitForPidExit, writeFile } from "./harness"
let nextFixtureId = 0

describe("daemon", () => {
	test("orders requests within one daemon connection", async () => {
		const fixture = await startFixture("ordered-connection", { schedulerEnabled: false })
		const slowStarted = deferred<void>()
		const releaseSlow = deferred<void>()
		const startedRequestIds: string[] = []
		const originalResponseForLine = Reflect.get(fixture.daemon, "responseForLine")
		if (typeof originalResponseForLine !== "function") throw new Error("daemon responseForLine is unavailable")
		Reflect.set(fixture.daemon, "responseForLine", async (line: string) => {
			const request = record(JSON.parse(line))
			const requestId = stringValue(request.id)
			startedRequestIds.push(requestId)
			if (requestId === "slow") {
				slowStarted.resolve(undefined)
				await releaseSlow.promise
			}
			return await Reflect.apply(originalResponseForLine, fixture.daemon, [line])
		})
		try {
			const responsesPromise = sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "slow", command: "daemon.status", args: {} }),
				JSON.stringify({ id: "next", command: "daemon.status", args: {} }),
			])
			await slowStarted.promise
			expect(startedRequestIds).toEqual(["slow"])
			releaseSlow.resolve(undefined)
			const responses = await responsesPromise
			expect(responses.map((response) => response.id)).toEqual(["slow", "next"])
			expect(startedRequestIds).toEqual(["slow", "next"])
		} finally {
			releaseSlow.resolve(undefined)
			await fixture.daemon.stop()
		}
	})

	test("keeps independent daemon connections concurrent", async () => {
		const fixture = await startFixture("concurrent-connections", { schedulerEnabled: false })
		const slowStarted = deferred<void>()
		const releaseSlow = deferred<void>()
		const originalResponseForLine = Reflect.get(fixture.daemon, "responseForLine")
		if (typeof originalResponseForLine !== "function") throw new Error("daemon responseForLine is unavailable")
		Reflect.set(fixture.daemon, "responseForLine", async (line: string) => {
			const request = record(JSON.parse(line))
			if (stringValue(request.id) === "slow-connection") {
				slowStarted.resolve(undefined)
				await releaseSlow.promise
			}
			return await Reflect.apply(originalResponseForLine, fixture.daemon, [line])
		})
		try {
			const slowResponsePromise = sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "slow-connection", command: "daemon.status", args: {} }),
			])
			await slowStarted.promise
			const independentResponses = await sendLinesOnDaemonConnection(fixture.socketPath, [
				JSON.stringify({ id: "independent-connection", command: "daemon.status", args: {} }),
			])
			expect(independentResponses).toMatchObject([{ id: "independent-connection", ok: true }])
			releaseSlow.resolve(undefined)
			expect(await slowResponsePromise).toMatchObject([{ id: "slow-connection", ok: true }])
		} finally {
			releaseSlow.resolve(undefined)
			await fixture.daemon.stop()
		}
	})

	test("continues ordered connection after request failure", async () => {
		const fixture = await startFixture("failure-continues", { schedulerEnabled: false })
		try {
			const responses = await sendLinesOnDaemonConnection(fixture.socketPath, [
				"not-json",
				JSON.stringify({ id: "after-failure", command: "daemon.status", args: {} }),
			])
			expect(responses).toHaveLength(2)
			expect(responses[0]).toMatchObject({ id: "unknown", ok: false })
			expect(responses[1]).toMatchObject({ id: "after-failure", ok: true })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("drives chain-complete decision through a large runner event", async () => {
		const fixture = await startFixture("large-chain-complete-decision", {
			schedulerIntervalMs: 1_000,
			useDefaultChainCompleteTrigger: true,
			beforeStart: async ({ fakeRunner }) => {
				await writeFile(fakeRunner, `#!/usr/bin/env bun
const prompt = Bun.argv.at(-1) ?? ""
if (prompt.includes("FINALIZER SUMMARY")) {
	const event = { type: "item.completed", item: { type: "agent_message", text: "x".repeat(1_000_001) + "\\nFINALIZER SUMMARY: decision=complete; reason=large-event" } }
	await Bun.write(Bun.stdout, JSON.stringify(event) + "\\n")
} else {
	const input = JSON.parse(prompt)
	${FAKE_RUNNER_STATUS_WRITE_SNIPPET}
}
process.exitCode = 0
`)
				await chmod(fakeRunner, 0o755)
			},
			schedulerRunnerKind: "codex",
			schedulerBinaryIsFakeRunner: true,
		})
		try {
			if (fixture.defaultItemPresetPath === undefined || fixture.defaultItemPresetPath === null) {
				throw new Error("large chain-complete fixture requires its task root")
			}
			const agentCwd = resolve(fixture.defaultItemPresetPath, "..")
			const chain = record(expectOk(await request(fixture, "chain.create", {
				name: "large-chain-complete-decision-chain",
				repository: "mouriya-s-lab/coder-loop",
			})).chain)
			const chainId = numberValue(chain.id)
			const added = record(expectOk(await request(fixture, "item.add", {
				chainId,
				itemId: "633",
				repoCwd: agentCwd,
			})).item)
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			try {
				store.updateItem(numberValue(added.id), { status: runtimeStatus("done"), updatedAt: Math.floor(Date.now() / 1_000) })
			} finally {
				store.close()
			}

			await waitFor(async () => readChainStatus(fixture.loopDataRoot, chainId), (status) => status === "completed", 10_000)
			const triggerEvent = fixture.schedulerEvents.find((event) => event.type === "chain.complete_trigger" && event.chainId === chainId)
			expect(triggerEvent).toMatchObject({ decision: "complete" })
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon up creates socket and pid", async () => {
		const fixture = await startFixture("up", { schedulerEnabled: false })
		try {
			expect(await pathIsSocket(fixture.socketPath)).toBe(true)
			expect((await readFile(fixture.pidFile, "utf-8")).trim()).toBe(String(process.pid))
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon rebinds socket pathname after unlink", async () => {
		const fixture = await startFixture("socket-path-rebind", { schedulerEnabled: false })
		try {
			await unlink(fixture.socketPath)
			await waitFor(async () => {
				try {
					return await pathIsSocket(fixture.socketPath)
				} catch {
					return false
				}
			}, (rebuilt) => rebuilt)

			const status = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("daemon.status"))).daemon)
			expect(status).toMatchObject({
				pid: process.pid,
				socketPath: fixture.socketPath,
				running: true,
			})
		} finally {
			await fixture.daemon.stop()
		}
	})

	test("daemon startup rejects live pid with missing socket pathname", async () => {
		const root = resolve(TEST_ROOT, `${++nextFixtureId}-startup-socket-unlinked`)
		const loopDataRoot = root + "-loop-data"
		const pidFile = resolve(loopDataRoot, "daemon.pid")
		await mkdir(loopDataRoot, { recursive: true })
		const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		})
		stale.unref()
		if (stale.pid === undefined) throw new Error("expected stale process pid")
		await writeFile(pidFile, `${stale.pid}\n`)

		try {
			await expect(startCoderLoopDaemon({ loopDataRoot, scheduler: { enabled: false } })).rejects.toMatchObject({
				code: "daemon_socket_unlinked",
				details: {
					pid: stale.pid,
					socketPath: resolve(loopDataRoot, "daemon.sock"),
					pidFile,
				},
			})
		} finally {
			try {
				process.kill(-(stale.pid), "SIGKILL")
			} catch {
				try {
					process.kill(stale.pid, "SIGKILL")
				} catch {
					// Already exited.
				}
			}
			await waitForPidExit(stale.pid, 1_000)
		}
	})
})
