import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

export const LOOP_DATA_ROOT_ENV = "CODER_LOOP_DATA_ROOT"
export const DEFAULT_LOOP_DATA_ROOT = resolve(homedir(), "Ext/loop-data")
export const LOOP_DATA_STATE_DB = "state.db"
export const LOOP_DATA_DAEMON_SOCKET = "daemon.sock"
export const LOOP_DATA_DAEMON_PID = "daemon.pid"

export type LoopDataRootPaths = {
	rootDir: string
	stateDbPath: string
	daemonSocketPath: string
	daemonPidPath: string
	chainsDir: string
}

export type ChainRuntimePaths = {
	rootDir: string
	chainName: string
	chainSlug: string
	chainDir: string
	sharedPath: string
	issuesDir: string
	evidenceDir: string
	runsDir: string
	daemonDir: string
	runDir: (runId: string) => string
	daemonRunDir: (timestamp: string) => string
}

export function resolveLoopDataRoot(input: string | null = null, env: Record<string, string | undefined> = process.env): string {
	const raw = input ?? env[LOOP_DATA_ROOT_ENV] ?? DEFAULT_LOOP_DATA_ROOT
	const expanded = expandHome(raw.trim())
	if (expanded === "") throw new Error("loop-data root must not be empty")
	return resolve(expanded)
}

export function loopDataRootPaths(input: string | null = null, env: Record<string, string | undefined> = process.env): LoopDataRootPaths {
	const rootDir = resolveLoopDataRoot(input, env)
	return {
		rootDir,
		stateDbPath: resolve(rootDir, LOOP_DATA_STATE_DB),
		daemonSocketPath: resolve(rootDir, LOOP_DATA_DAEMON_SOCKET),
		daemonPidPath: resolve(rootDir, LOOP_DATA_DAEMON_PID),
		chainsDir: resolve(rootDir, "chains"),
	}
}

export function chainRuntimePaths(rootInput: string | null, chainName: string): ChainRuntimePaths {
	const root = loopDataRootPaths(rootInput)
	const chainSlug = sanitizeChainName(chainName)
	const chainDir = resolve(root.chainsDir, chainSlug)
	return {
		rootDir: root.rootDir,
		chainName,
		chainSlug,
		chainDir,
		sharedPath: resolve(chainDir, "shared.md"),
		issuesDir: resolve(chainDir, "issues"),
		evidenceDir: resolve(chainDir, "evidence"),
		runsDir: resolve(chainDir, "runs"),
		daemonDir: resolve(chainDir, "daemon"),
		runDir: (runId) => resolve(chainDir, "runs", sanitizeRuntimeSegment(runId, "runId")),
		daemonRunDir: (timestamp) => resolve(chainDir, "daemon", sanitizeRuntimeSegment(timestamp, "timestamp")),
	}
}

export async function ensureChainRuntimeSkeleton(paths: ChainRuntimePaths): Promise<void> {
	await mkdir(paths.issuesDir, { recursive: true })
	await mkdir(paths.evidenceDir, { recursive: true })
	await mkdir(paths.runsDir, { recursive: true })
	await mkdir(paths.daemonDir, { recursive: true })
	await writeFileIfMissing(paths.sharedPath, "# Shared durable context\n")
}

export function sanitizeChainName(value: string): string {
	return sanitizeRuntimeSegment(value, "chain name")
}

function sanitizeRuntimeSegment(value: string, label: string): string {
	const trimmed = value.trim()
	if (trimmed === "") throw new Error(`${label} must not be empty`)
	if (isAbsolute(trimmed)) throw new Error(`${label} must not be an absolute path: ${value}`)
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${label} must not contain control characters`)
	if (trimmed.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")) {
		throw new Error(`${label} must not contain . or .. path segments: ${value}`)
	}
	const sanitized = trimmed
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^\.+|\.+$/g, "")
		.replace(/^-+|-+$/g, "")
	if (sanitized === "") throw new Error(`${label} did not contain any safe path characters: ${value}`)
	return sanitized
}

function expandHome(value: string): string {
	if (value === "~") return homedir()
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
	return value
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
	try {
		await writeFile(path, content, { flag: "wx" })
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return
		throw error
	}
}

function isNodeError(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error && typeof error.code === "string"
}
