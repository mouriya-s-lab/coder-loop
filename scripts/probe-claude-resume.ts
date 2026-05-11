#!/usr/bin/env bun
/**
 * Assumption probe for issue #53 §验收标准 row 7:
 *   `claude --resume <id> -p "继续"` 真能续接同一 session.
 *
 * Steps:
 *   1. Spawn `claude -p "<token>" --output-format stream-json --verbose`.
 *      Token is a unique random string the model will echo / process.
 *      Capture session_id from the first stream-json system/init event.
 *   2. Spawn `claude --resume <session_id> -p "继续" --output-format stream-json --verbose`.
 *   3. Assert the resumed session's stream contains the same session_id
 *      AND the resumed turn references the original token (cross-turn context preservation).
 *
 * Exit 0 on success, 1 on any assertion failure or spawn failure.
 * Designed to be called as the local-env command for the assumption checkpoint.
 */

import { spawn } from "node:child_process"

type SpawnResult = { stdout: string; stderr: string; exitCode: number }

function runClaude(args: readonly string[]): Promise<SpawnResult> {
	return new Promise((resolveResult) => {
		const out: Buffer[] = []
		const err: Buffer[] = []
		const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] })
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
		child.on("error", (error) => {
			resolveResult({ stdout: "", stderr: `spawn error: ${error.message}`, exitCode: 1 })
		})
		child.on("close", (code) => {
			resolveResult({
				stdout: Buffer.concat(out).toString("utf-8"),
				stderr: Buffer.concat(err).toString("utf-8"),
				exitCode: code ?? 1,
			})
		})
	})
}

function extractFirstSessionId(stdout: string): string | null {
	const newlineIdx = stdout.indexOf("\n")
	if (newlineIdx === -1) return null
	try {
		const event = JSON.parse(stdout.slice(0, newlineIdx)) as { session_id?: unknown }
		return typeof event.session_id === "string" ? event.session_id : null
	} catch {
		return null
	}
}

function extractAllSessionIds(stdout: string): string[] {
	const ids: string[] = []
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue
		try {
			const event = JSON.parse(line) as { session_id?: unknown }
			if (typeof event.session_id === "string") ids.push(event.session_id)
		} catch {
			continue
		}
	}
	return ids
}

function extractAssistantText(stdout: string): string {
	const parts: string[] = []
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue
		try {
			const event = JSON.parse(line) as { type?: unknown; message?: unknown }
			if (event.type !== "assistant") continue
			const message = event.message as { content?: unknown } | undefined
			const content = message?.content
			if (!Array.isArray(content)) continue
			for (const block of content) {
				if (typeof block !== "object" || block === null) continue
				const b = block as { type?: unknown; text?: unknown }
				if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
			}
		} catch {
			continue
		}
	}
	return parts.join("\n")
}

async function main(): Promise<number> {
	const token = `RESUME_PROBE_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
	console.error(`[probe] token=${token}`)

	const initialPrompt = `Remember this exact token: ${token}. Reply briefly with "noted".`
	const first = await runClaude(["-p", initialPrompt, "--output-format", "stream-json", "--verbose"])
	if (first.exitCode !== 0) {
		console.error(`[probe] initial spawn failed: exit=${first.exitCode}, stderr=${first.stderr.slice(0, 500)}`)
		return 1
	}
	const sessionId = extractFirstSessionId(first.stdout)
	if (sessionId === null) {
		console.error(`[probe] no session_id in initial stream; first 500 chars: ${first.stdout.slice(0, 500)}`)
		return 1
	}
	console.error(`[probe] initial session_id=${sessionId}`)

	const second = await runClaude(["--resume", sessionId, "-p", "继续。What was the exact token I asked you to remember? Reply with just the token.", "--output-format", "stream-json", "--verbose"])
	if (second.exitCode !== 0) {
		console.error(`[probe] resume spawn failed: exit=${second.exitCode}, stderr=${second.stderr.slice(0, 500)}`)
		return 1
	}

	const resumedIds = extractAllSessionIds(second.stdout)
	const allMatch = resumedIds.length > 0 && resumedIds.every((id) => id === sessionId)
	if (!allMatch) {
		console.error(`[probe] resumed stream has different session_id(s): ${JSON.stringify(resumedIds.slice(0, 3))}, expected ${sessionId}`)
		return 1
	}

	const resumedText = extractAssistantText(second.stdout)
	if (!resumedText.includes(token)) {
		console.error(`[probe] resumed response did NOT echo prior token. Response: ${resumedText.slice(0, 500)}`)
		return 1
	}

	console.error(`[probe] PASS: session_id preserved across resume; cross-turn context retained.`)
	console.log(token)
	console.log(sessionId)
	return 0
}

const exitCode = await main()
process.exit(exitCode)
