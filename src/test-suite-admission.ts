import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { resolve } from "node:path"

import { Database, SQLiteError } from "bun:sqlite"
import { afterAll } from "bun:test"

const SUITE_LEASE_PATH = resolve(tmpdir(), `coder-loop-test-suite-admission-${userInfo().uid}.sqlite`)
const SUITE_LEASE_OWNER_PATH = `${SUITE_LEASE_PATH}.owner.json`
const LEASE_RETRY_INTERVAL_MS = 50

type SuiteAdmission =
	| { kind: "inherited" }
	| { kind: "owner"; database: Database }

type SuiteLeaseOwner = {
	pid: number
}

const admission = await acquireSuiteAdmission()

if (admission.kind === "owner") {
	let released = false
	const release = () => {
		if (released) return
		released = true
		unlinkSync(SUITE_LEASE_OWNER_PATH)
		admission.database.close()
	}
	afterAll(release)
	process.once("exit", release)
}

async function acquireSuiteAdmission(): Promise<SuiteAdmission> {
	const database = new Database(SUITE_LEASE_PATH, { create: true })
	while (true) {
		try {
			// SQLite's process-held file lock is shared across worktrees and released by the
			// kernel when a killed test runner closes its descriptors. Top-level preload
			// awaits admission before Bun creates any per-test timeout.
			database.exec("BEGIN EXCLUSIVE")
			const owner = { pid: process.pid }
			writeFileSync(SUITE_LEASE_OWNER_PATH, JSON.stringify(owner), "utf-8")
			return { kind: "owner", database }
		} catch (error) {
			if (!(error instanceof SQLiteError && error.code === "SQLITE_BUSY")) {
				database.close()
				throw error
			}
			const owner = readSuiteLeaseOwner()
			// cleanup.test.ts intentionally starts a nested `bun test` synchronously. Bun's
			// default spawn environment is its startup snapshot, so direct ancestry—not a
			// dynamically assigned env marker—is the ownership inheritance boundary.
			if (owner?.pid === process.ppid) {
				database.close()
				return { kind: "inherited" }
			}
			await waitForLeaseRetry()
		}
	}
}

function readSuiteLeaseOwner(): SuiteLeaseOwner | null {
	let source: string
	try {
		source = readFileSync(SUITE_LEASE_OWNER_PATH, "utf-8")
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return null
		throw error
	}
	const value: unknown = JSON.parse(source)
	if (!isSuiteLeaseOwner(value)) throw new Error(`Invalid suite lease owner at ${SUITE_LEASE_OWNER_PATH}`)
	return value
}

function isSuiteLeaseOwner(value: unknown): value is SuiteLeaseOwner {
	return typeof value === "object"
		&& value !== null
		&& "pid" in value
		&& typeof value.pid === "number"
		&& Number.isInteger(value.pid)
		&& value.pid > 0
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

async function waitForLeaseRetry(): Promise<void> {
	await new Promise<void>((resolveWait) => setTimeout(resolveWait, LEASE_RETRY_INTERVAL_MS))
}
