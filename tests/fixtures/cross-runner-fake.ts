import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { openSqliteStateStore } from "../../src/sqlite-state"

type RunnerKind = "claude" | "codex"

type FakeRunnerResponse = {
	runner?: RunnerKind
	phase?: string
	exitCode?: number
	sessionId?: string | null
	stdout?: string[]
	stderr?: string[]
	// v1 status model: the agent owns its own item status and writes it explicitly. When set, the fake
	// runner writes this status to the shared store before exiting, mirroring `coder-loop item update`.
	writeStatus?: string
}

type FakeRunnerPlan = {
	responses: FakeRunnerResponse[]
	defaultResponse?: FakeRunnerResponse
}

type FakeRunnerState = {
	nextResponse: number
}

const [planPath, eventLogPath, runnerKind, loopDataRoot, ...runnerArgs] = Bun.argv.slice(2)

if (planPath === undefined || eventLogPath === undefined || !isRunnerKind(runnerKind) || loopDataRoot === undefined) {
	console.error("usage: cross-runner-fake.ts <plan.json> <event-log.jsonl> <claude|codex> <loop-data-root> [...runner args]")
	process.exit(2)
}

const plan = JSON.parse(await readFile(planPath, "utf-8")) as FakeRunnerPlan
const statePath = `${planPath}.state.json`
const state = await readState(statePath)
const responseIndex = state.nextResponse
const response = plan.responses[responseIndex] ?? plan.defaultResponse ?? { exitCode: 0 }
await writeState(statePath, { nextResponse: responseIndex + 1 })

const prompt = extractPrompt(runnerArgs)
const promptInput = parsePrompt(prompt)
const phase = stringValue(promptInput.phase, response.phase ?? "unknown")
const runId = stringValue(promptInput.runId, "unknown-run")
const issueNumber = numberValue(promptInput.issueNumber)
const resumedSessionId = extractResumeSessionId(runnerKind, runnerArgs)

await appendJsonLine(eventLogPath, {
	type: "spawn",
	responseIndex,
	runner: runnerKind,
	phase,
	runId,
	issueNumber,
	resumedSessionId,
	argv: runnerArgs,
})

if (response.sessionId !== undefined && response.sessionId !== null) {
	if (runnerKind === "claude") {
		console.log(JSON.stringify({ type: "system", subtype: "init", session_id: response.sessionId }))
	} else {
		console.log(JSON.stringify({ type: "thread.started", thread_id: response.sessionId }))
	}
}

for (const line of response.stdout ?? []) {
	console.log(serializeRunnerText(runnerKind, line))
}

for (const line of response.stderr ?? []) {
	console.error(line)
}

// v1 status model: the agent owns its item status and writes it through the shared store before
// exiting, exactly like `coder-loop item update --status` would. The scheduler only reads this value;
// it never infers status from the stdout/stderr above or from the exit code below.
if (typeof response.writeStatus === "string") {
	const itemId = numberValue(promptInput.itemId)
	if (itemId !== null) {
		const store = openSqliteStateStore({ loopDataRoot })
		try {
			store.updateItem(itemId, { status: response.writeStatus, updatedAt: Math.floor(Date.now() / 1000) })
		} finally {
			store.close()
		}
	}
}

process.exit(response.exitCode ?? 0)

function isRunnerKind(value: string | undefined): value is RunnerKind {
	return value === "claude" || value === "codex"
}

async function readState(path: string): Promise<FakeRunnerState> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<FakeRunnerState>
		return { nextResponse: typeof parsed.nextResponse === "number" ? parsed.nextResponse : 0 }
	} catch {
		return { nextResponse: 0 }
	}
}

async function writeState(path: string, state: FakeRunnerState): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(state))
}

function extractPrompt(args: string[]): string {
	const promptFlag = args.indexOf("-p")
	if (promptFlag >= 0) return args[promptFlag + 1] ?? "{}"
	return args.at(-1) ?? "{}"
}

function parsePrompt(prompt: string): Record<string, unknown> {
	try {
		const firstLine = prompt.split("\n")[0] ?? prompt
		const parsed = JSON.parse(firstLine) as unknown
		return isObject(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

function extractResumeSessionId(runner: RunnerKind, args: string[]): string | null {
	if (runner === "claude") {
		const index = args.indexOf("--resume")
		return index >= 0 ? args[index + 1] ?? null : null
	}
	const index = args.indexOf("resume")
	return index >= 0 ? args[index + 1] ?? null : null
}

function serializeRunnerText(runner: RunnerKind, text: string): string {
	if (text.trimStart().startsWith("{")) return text
	if (runner === "codex") return JSON.stringify({ type: "agent_message", text })
	return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function appendJsonLine(path: string, payload: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(payload)}\n`)
}
