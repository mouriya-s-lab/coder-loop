import { isAbsolute, relative, resolve } from "node:path"
import type { WriteStream } from "node:fs"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export class CoderLoopError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CoderLoopError"
	}
}

let logStream: WriteStream | null = null

export function setLogStream(stream: WriteStream | null): void {
	logStream = stream
}

export function getLogStream(): WriteStream | null {
	return logStream
}

export function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`
	console.error(line)
	logStream?.write(line + "\n")
}

export function fail(message: string): never {
	throw new CoderLoopError(message)
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true
	const kind = typeof value
	if (kind === "string" || kind === "number" || kind === "boolean") return kind !== "number" || Number.isFinite(value)
	if (Array.isArray(value)) return value.every(isJsonValue)
	if (kind !== "object") return false
	return isJsonObject(value)
}

export function isJsonObject(value: unknown): value is JsonObject {
	if (!isObjectRecord(value) || Array.isArray(value)) return false
	return Object.values(value).every(isJsonValue)
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type ArkAssertable<T> = {
	assert(data: unknown): T
}

export function assertArk<T>(schema: ArkAssertable<T>, data: unknown, label: string): T {
	try {
		return schema.assert(data)
	} catch (error) {
		throw new Error(`${label}: ${errorMessage(error)}`)
	}
}

export async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists()
}

export async function removeLoopFile(path: string): Promise<void> {
	try {
		await Bun.file(path).delete()
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return
		throw error
	}
}

export function resolveFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path)
}

export function isWithin(base: string, path: string): boolean {
	const rel = relative(base, path)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

const DEFAULT_IDLE_SLEEP_MS = 60_000

export function resolveIdleSleepMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.CODER_LOOP_IDLE_SLEEP_MS
	if (raw === undefined || raw === "") return DEFAULT_IDLE_SLEEP_MS
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`CODER_LOOP_IDLE_SLEEP_MS must be a non-negative number, got: ${raw}`)
	return parsed
}

export function formatMaxIterations(value: number): string {
	return value === Number.POSITIVE_INFINITY ? "Infinity" : String(value)
}

export function isIsoDateTime(value: string): boolean {
	return !Number.isNaN(Date.parse(value))
}

export function makeRunId(id: string | null): string {
	const timestamp = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, "-")
	return id === null ? `run-${timestamp}-no-issue` : `run-${timestamp}-issue-${id}`
}
