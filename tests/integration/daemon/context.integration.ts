import { REPO_ROOT, daemonRequest, describe, expect, expectOk, numberValue, openSqliteStateStore, queryObservabilityEvents, readFile, record, request, resolveLoopDataPaths, sendDaemonRequest, startFixture, startQueueUnblockGateFixture, stringValue, test, waitFor } from "./harness"

describe("daemonRateLimitDecision (issue #478)", () => {
	test("context append derives author from credential", async () => {
		const fixture = await startQueueUnblockGateFixture("context-agent-author", { preset: "loaded", targetStatus: "blocked" })
		try {
			fixture.releaseTick.resolve()
			const credential = await waitFor(async () => { try { return (await readFile(fixture.credentialPath, "utf-8")).trim() } catch { return "" } }, (value) => value.length > 0, 8_000)
			const missing = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: "" }))
			expect(missing.ok).toBe(false)
			const unknown = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: "unknown-context-credential" }))
			expect(unknown.ok).toBe(false)
			if (!unknown.ok) expect(unknown.error.message).toContain("did not match any active run")
			const forged = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, author: { kind: "operator" }, agentCredential: credential }))
			expect(forged.ok).toBe(false)
			const begun = expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential })))
			const sessionId = stringValue(begun.sessionId)
			const mismatched = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sessionId, sequence: 0, chunk: "no", }))
			expect(mismatched.ok).toBe(false)
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sessionId, sequence: 0, chunk: "agent-body", agentCredential: credential })))
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId, agentCredential: credential })))
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			const entry = store.listContextEntries(fixture.chainId)[0]
			expect(entry?.author).toMatchObject({ kind: "agent", chainId: fixture.chainId, runId: expect.any(String), phase: expect.any(String) })
			store.close()
			const other = record(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("chain.create", { name: "context-other-chain", repository: "o/r" }))).chain)
			const crossChain = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainId: numberValue(other.id), scope: { kind: "chain" }, agentCredential: credential }))
			expect(crossChain.ok).toBe(false)
			const registry = Reflect.get(fixture.daemon, "runCredentialRegistry")
			if (!(registry instanceof Map)) throw new Error("credential registry unavailable")
			const registration = registry.get(credential)
			expect(registration).toBeDefined()
			expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("chain.stop", { chainName: fixture.chainName })))
			registry.set(credential, registration)
			const inactive = await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential }))
			expect(inactive.ok).toBe(false)
			if (!inactive.ok) expect(inactive.error.message).toContain("no longer active")
			const admissionEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
				.filter((event) => event.type === "context.write_admission")
			const denyReasons = admissionEvents.flatMap((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" ? [event.payload.reason] : [])
			for (const reason of ["missing-credential", "unknown-credential", "invalid-request", "session-owner-mismatch", "cross-chain", "inactive-run"] as const) {
				expect(denyReasons).toContain(reason)
			}
		} finally { await fixture.daemon.stop() }
	}, 30_000)

	test("context denial audit preserves active agent attribution before request and chain rejection", async () => {
		const fixture = await startQueueUnblockGateFixture("context-agent-deny-attribution", { preset: "loaded", targetStatus: "blocked" })
		try {
			fixture.releaseTick.resolve()
			const credential = await waitFor(async () => { try { return (await readFile(fixture.credentialPath, "utf-8")).trim() } catch { return "" } }, (value) => value.length > 0, 8_000)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.chunk", { sequence: 0, chunk: "body", agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: "unknown-agent-session", agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: "missing-context-chain", scope: { kind: "chain" }, agentCredential: credential }))).ok).toBe(false)

			const deletedSessionId = stringValue(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", {
				chainName: fixture.chainName,
				scope: { kind: "chain" },
				agentCredential: credential,
			}))).sessionId)
			const missingSessionId = stringValue(expectOk(await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", {
				chainName: fixture.chainName,
				scope: { kind: "chain" },
				agentCredential: credential,
			}))).sessionId)
			const deletingStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			deletingStore.updateChain(fixture.chainId, { status: "deleted" })
			deletingStore.close()
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.begin", { chainName: fixture.chainName, scope: { kind: "chain" }, agentCredential: credential }))).ok).toBe(false)
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: deletedSessionId, agentCredential: credential }))).ok).toBe(false)
			const restoringStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			restoringStore.updateChain(fixture.chainId, { status: "active" })
			restoringStore.close()
			const sessions = Reflect.get(fixture.daemon, "contextAppendSessions")
			if (!(sessions instanceof Map)) throw new Error("context sessions unavailable")
			record(sessions.get(missingSessionId)).chainId = 2_147_483_647
			expect((await sendDaemonRequest(fixture.socketPath, daemonRequest("context.append.commit", { sessionId: missingSessionId, agentCredential: credential }))).ok).toBe(false)

			const denialEvents = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events
			for (const reason of ["invalid-request", "unknown-session", "chain-deleted", "chain-not-found"] as const) {
				expect(denialEvents.some((event) => event.type === "context.write_admission"
					&& event.payload.outcome === "deny"
					&& event.payload.reason === reason
					&& event.subject?.kind === "agent")).toBe(true)
			}
		} finally { await fixture.daemon.stop() }
	}, 30_000)

	test("context append sessions cannot outlive soft chain deletion", async () => {
		const fixture = await startFixture("context-deleted-chain-lifecycle", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-deleted-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			const sessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })).sessionId)
			expectOk(await request(fixture, "context.append.chunk", { sessionId, sequence: 0, chunk: "must-not-survive" }))
			const deleted = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deleted.deletedContextEntries).toBe(0)
			expect((await request(fixture, "context.append.commit", { sessionId })).ok).toBe(false)
			const beginAfterDelete = await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })
			expect(beginAfterDelete.ok).toBe(false)
			if (!beginAfterDelete.ok) expect(beginAfterDelete.error.code).toBe("chain_deleted")

			const residueStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			residueStore.appendContextEntry({ chainId, scope: { kind: "chain" }, author: { kind: "operator" }, body: "late residue" })
			residueStore.close()
			const deletedAgain = expectOk(await request(fixture, "chain.delete", { chainId }))
			expect(deletedAgain).toMatchObject({ alreadyDeleted: true, deletedContextEntries: 1 })
			const checkStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(checkStore.listContextEntries(chainId)).toEqual([])
			checkStore.close()
		} finally { await fixture.daemon.stop() }
	})

	test("context write admission audit", async () => {
		const fixture = await startFixture("context-write-audit", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-audit-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			const begun = expectOk(await request(fixture, "context.append.begin", { chainId: numberValue(chain.id), scope: { kind: "chain" } }))
			const sessionId = stringValue(begun.sessionId)
			expectOk(await request(fixture, "context.append.chunk", { sessionId, sequence: 0, chunk: "operator-body" }))
			expectOk(await request(fixture, "context.append.commit", { sessionId }))
			const denied = await request(fixture, "context.append.begin", { chainId: numberValue(chain.id), scope: { kind: "group", groupId: "absent" } })
			expect(denied.ok).toBe(false)

			expect((await request(fixture, "context.append.begin", { chainId })).ok).toBe(false)
			expect((await request(fixture, "context.append.chunk", {})).ok).toBe(false)
			expect((await request(fixture, "context.append.commit", { sessionId: "vanished-session" })).ok).toBe(false)

			const malformedSessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } })).sessionId)
			expect((await request(fixture, "context.append.chunk", { sessionId: malformedSessionId, sequence: "zero", chunk: "body" })).ok).toBe(false)
			expect((await request(fixture, "context.append.chunk", { sessionId: malformedSessionId, sequence: 1, chunk: "body" })).ok).toBe(false)

			const vanishedChain = record(expectOk(await request(fixture, "chain.create", { name: "context-vanished-chain", repository: "o/r" })).chain)
			const vanishedChainId = numberValue(vanishedChain.id)
			const vanishedChainSessionId = stringValue(expectOk(await request(fixture, "context.append.begin", { chainId: vanishedChainId, scope: { kind: "chain" } })).sessionId)
			const deletingStore = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(deletingStore.deleteChain(vanishedChainId)).toBe(true)
			deletingStore.close()
			expect((await request(fixture, "context.append.commit", { sessionId: vanishedChainSessionId })).ok).toBe(false)

			const events = (await queryObservabilityEvents(resolveLoopDataPaths({ loopDataRoot: fixture.loopDataRoot }).eventsFile)).events.filter((event) => event.type === "context.write_admission")
			expect(events.some((event) => event.type === "context.write_admission" && event.payload.outcome === "allow" && event.payload.reason === "operator")).toBe(true)
			expect(events.some((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" && event.payload.reason === "group-unavailable-v2")).toBe(true)
			const denyReasons = events.flatMap((event) => event.type === "context.write_admission" && event.payload.outcome === "deny" ? [event.payload.reason] : [])
			expect(denyReasons).toContain("invalid-request")
			expect(denyReasons).toContain("unknown-session")
			expect(denyReasons).toContain("sequence-mismatch")
			expect(denyReasons).toContain("chain-not-found")
			const store = openSqliteStateStore({ loopDataRoot: fixture.loopDataRoot })
			expect(store.listContextEntries(numberValue(chain.id))[0]?.author).toEqual({ kind: "operator" })
			store.close()
		} finally { await fixture.daemon.stop() }
	})

	test("context scope admission", async () => {
		const fixture = await startFixture("context-scope-admission", { schedulerEnabled: false })
		try {
			const chain = record(expectOk(await request(fixture, "chain.create", { name: "context-scope-chain", repository: "o/r" })).chain)
			const chainId = numberValue(chain.id)
			expectOk(await request(fixture, "item.add", { chainId, itemId: "known", repoCwd: REPO_ROOT, preset: "gh-issue-pr-iteration" }))
			const chainScope = expectOk(await request(fixture, "context.append.begin", { chainId, scope: { kind: "chain" } }))
			expect(typeof chainScope.sessionId).toBe("string")
			expect((await request(fixture, "context.append.begin", { chainId, scope: { kind: "item", itemId: "known" } })).ok).toBe(true)
			const missingItem = await request(fixture, "context.append.begin", { chainId, scope: { kind: "item", itemId: "missing" } })
			expect(missingItem.ok).toBe(false)
			if (!missingItem.ok) expect(missingItem.error.code).toBe("item-not-found")
			const missingGroup = await request(fixture, "context.append.begin", { chainId, scope: { kind: "group", groupId: "missing" } })
			expect(missingGroup.ok).toBe(false)
			if (!missingGroup.ok) expect(missingGroup.error.code).toBe("group-unavailable-v2")
			const sessions = Reflect.get(fixture.daemon, "contextAppendSessions")
			if (!(sessions instanceof Map)) throw new Error("context sessions unavailable")
			const admitted = sessions.get(chainScope.sessionId)
			expect(admitted).toMatchObject({ chainId, scope: { kind: "chain" } })
		} finally { await fixture.daemon.stop() }
	})
})
