import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "node:net"
import { Database } from "bun:sqlite"
import {
	contextScopeFromCliArgs,
	parseContextAppendCliScopeArgs,
	parseContextAuthor,
	parseContextScope,
	parsePersistedContextEntryRow,
	persistedContextScope,
} from "./context-entry"
import { openSqliteStateStore } from "./sqlite-state"
import { daemonRequest, sendDaemonRequest } from "./daemon"
import { resolveLoopDataPaths } from "./runtime-paths"

describe("context entry foundation", () => {
	test("closed scope and author boundaries reject malformed variants", () => {
		expect(parseContextScope({ kind: "chain" })).toEqual({ kind: "chain" })
		expect(parseContextScope({ kind: "item", itemId: "594" })).toEqual({ kind: "item", itemId: "594" })
		expect(() => parseContextScope({ kind: "run", runId: "r" })).toThrow()
		expect(parseContextAuthor({ kind: "operator" })).toEqual({ kind: "operator" })
		expect(() => parseContextAuthor({ kind: "agent", runId: "r" })).toThrow()
	})

	test("CLI and persisted-row scope boundaries yield exhaustive discriminated products", () => {
		for (const input of [
			{ scope: "chain", itemId: null, groupId: null },
			{ scope: "item", itemId: "594", groupId: null },
			{ scope: "group", itemId: null, groupId: "par-1" },
		] as const) {
			const parsed = parseContextAppendCliScopeArgs(input)
			expect(contextScopeFromCliArgs(parsed).kind).toBe(input.scope)
		}
		expect(() => parseContextAppendCliScopeArgs({ scope: "item", itemId: null, groupId: null })).toThrow()
		expect(() => parseContextAppendCliScopeArgs({ scope: "chain", itemId: "594", groupId: null })).toThrow()

		const common = { id: "entry", chain_id: 1, created_at: 1, author: '{"kind":"operator"}', body: "body" }
		expect(persistedContextScope(parsePersistedContextEntryRow({ ...common, scope_kind: "chain", scope_key: null }))).toEqual({ kind: "chain" })
		expect(persistedContextScope(parsePersistedContextEntryRow({ ...common, scope_kind: "item", scope_key: "594" }))).toEqual({ kind: "item", itemId: "594" })
		expect(persistedContextScope(parsePersistedContextEntryRow({ ...common, scope_kind: "group", scope_key: "par-1" }))).toEqual({ kind: "group", groupId: "par-1" })
		expect(() => parsePersistedContextEntryRow({ ...common, scope_kind: "chain", scope_key: "unexpected" })).toThrow()
	})

	test("context entries are append-only and removed by chain delete", async () => {
		const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "coder-loop-context-"))
		try {
			const store = openSqliteStateStore({ loopDataRoot: root })
			const one = store.createChain({ name: "one", repository: "o/r", baseBranch: "main" })
			const two = store.createChain({ name: "two", repository: "o/r", baseBranch: "main" })
			const body = "queued\nFINALIZER SUMMARY: decision=complete\n雪".repeat(2000)
			const entry = store.appendContextEntry({ chainId: one.id, scope: { kind: "chain" }, author: { kind: "operator" }, body })
			store.appendContextEntry({ chainId: two.id, scope: { kind: "chain" }, author: { kind: "operator" }, body: "survives" })
			expect(store.listContextEntries(one.id)).toEqual([entry])
			expect(store.deleteContextEntriesForChain(one.id)).toBe(1)
			expect(store.listContextEntries(one.id)).toEqual([])
			expect(store.listContextEntries(two.id).map((value) => value.body)).toEqual(["survives"])
			store.close()
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test("orderly socket close before a complete response rejects", async () => {
		const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "coder-loop-close-"))
		const socketPath = join(root, "peer.sock")
		const server = createServer((socket) => socket.end('{"id":"partial"'))
		await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socketPath, resolveListen) })
		try { await expect(sendDaemonRequest(socketPath, daemonRequest("daemon.status"))).rejects.toThrow("closed before a complete") }
		finally { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await rm(root, { recursive: true, force: true }) }
	})

	test("context schema migration preserves existing data", async () => {
		const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "coder-loop-migrate-"))
		try {
			const initial = openSqliteStateStore({ loopDataRoot: root })
			const chain = initial.createChain({ name: "preserved", repository: "o/r", baseBranch: "main" })
			initial.close()
			const db = new Database(resolveLoopDataPaths({ loopDataRoot: root }).dbFile)
			db.exec("DROP TABLE context_entries; PRAGMA user_version = 13")
			db.close()
			const migrated = openSqliteStateStore({ loopDataRoot: root })
			expect(migrated.getChain(chain.id)?.name).toBe("preserved")
			expect(migrated.listTableColumns("context_entries")).toContain("body")
			migrated.close()
			const reopened = openSqliteStateStore({ loopDataRoot: root })
			expect(reopened.getChain(chain.id)?.name).toBe("preserved")
			reopened.close()
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test("persisted context rows reject unknown scope kind and missing scope key", async () => {
		for (const malformed of [
			{ id: "bad-kind", scopeKind: "future", scopeKey: "x" },
			{ id: "bad-key", scopeKind: "item", scopeKey: null },
		] as const) {
			const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "coder-loop-malformed-context-"))
			try {
				const store = openSqliteStateStore({ loopDataRoot: root })
				const chain = store.createChain({ name: `chain-${malformed.id}`, repository: "o/r", baseBranch: "main" })
				store.close()
				const db = new Database(resolveLoopDataPaths({ loopDataRoot: root }).dbFile)
				db.exec("PRAGMA ignore_check_constraints = ON")
				db.query("INSERT INTO context_entries (id,chain_id,created_at,scope_kind,scope_key,author,body) VALUES ($id,$chainId,1,$scopeKind,$scopeKey,'{\"kind\":\"operator\"}','body')").run({ $id: malformed.id, $chainId: chain.id, $scopeKind: malformed.scopeKind, $scopeKey: malformed.scopeKey })
				db.close()
				const reopened = openSqliteStateStore({ loopDataRoot: root })
				expect(() => reopened.listContextEntries(chain.id)).toThrow()
				reopened.close()
			} finally { await rm(root, { recursive: true, force: true }) }
		}
	})
})
