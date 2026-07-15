#!/usr/bin/env bun
/**
 * engine-integration 的确定性 stub runner（issue #681）。
 *
 * 由引擎当作 `claude` runner 真实 spawn（scripts/engine-integration.ts 把 shim 目录前置到
 * PATH，`claude` 解析到本脚本）。它走真实 agent 的全部引擎面：
 *   - 进程从 scheduler spawn，cwd 是引擎创建的 slot worktree；
 *   - stdout 首行输出 stream-json 形状的 session_id，供 parseSessionIdFromStream 捕获；
 *   - iteration phase 在 worktree 里做真实 git commit；
 *   - review phase 用 `coder-loop item update --status`（PATH 上的 shim → src/loop.ts）
 *     经 daemon socket 的凭据准入（CODER_LOOP_RUN_CRED，#397 gate）写回 status。
 *
 * 无 LLM、无 GitHub、无网络。行为完全由 prompt 中的 PHASE=/CHAIN=/ITEM= 行驱动。
 */

import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

export type StubPromptFacts = {
	phase: string
	chain: string
	item: string
	run: string
}

export function parseStubPrompt(prompt: string): StubPromptFacts {
	const facts: Partial<StubPromptFacts> = {}
	for (const line of prompt.split("\n")) {
		const match = line.match(/^(PHASE|CHAIN|ITEM|RUN)=(.+)$/)
		if (match === null) continue
		const value = match[2]!.trim()
		if (match[1] === "PHASE") facts.phase = value
		if (match[1] === "CHAIN") facts.chain = value
		if (match[1] === "ITEM") facts.item = value
		if (match[1] === "RUN") facts.run = value
	}
	if (facts.phase === undefined || facts.chain === undefined || facts.item === undefined || facts.run === undefined) {
		throw new Error(`stub prompt is missing PHASE/CHAIN/ITEM/RUN lines:\n${prompt}`)
	}
	return { phase: facts.phase, chain: facts.chain, item: facts.item, run: facts.run }
}

export function extractPromptArg(argv: readonly string[]): string {
	// agentClaudeArgs 把 prompt 作为 `-p` 的下一个参数放在末尾。
	const flagIndex = argv.lastIndexOf("-p")
	const prompt = flagIndex === -1 ? undefined : argv[flagIndex + 1]
	if (prompt === undefined) throw new Error(`stub runner expects \`-p <prompt>\`, got: ${argv.join(" ")}`)
	return prompt
}

const MARKER_FILENAME = "engine-integration-marker.txt"

function sh(cmd: readonly string[]): { stdout: string; stderr: string; exitCode: number } {
	const proc = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
	return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? 1 }
}

function mustSh(cmd: readonly string[]): string {
	const result = sh(cmd)
	if (result.exitCode !== 0) throw new Error(`stub command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n${result.stderr}`)
	return result.stdout
}

function runIteration(facts: StubPromptFacts): void {
	writeFileSync(MARKER_FILENAME, `run: ${facts.run}\nitem: ${facts.item}\n`)
	mustSh(["git", "add", MARKER_FILENAME])
	mustSh(["git", "-c", "user.name=engine-integration-stub", "-c", "user.email=stub@engine-integration.local",
		"commit", "-m", `engine-integration: marker for run ${facts.run}`])
	process.stdout.write(`${JSON.stringify({ type: "stub", phase: "iteration", committed: MARKER_FILENAME })}\n`)
}

function runReview(facts: StubPromptFacts): void {
	const committed = existsSync(MARKER_FILENAME)
		&& sh(["git", "log", "-1", "--name-only", "--pretty=format:"]).stdout.includes(MARKER_FILENAME)
	const status = committed ? "done" : "changes_requested"
	// PATH 上的 `coder-loop` 是 harness shim → src/loop.ts；CODER_LOOP_DATA_DIR /
	// CODER_LOOP_RUN_CRED 由 scheduler spawn env 注入并被本进程继承，CLI 自动附加凭据。
	mustSh(["coder-loop", "item", "update", facts.chain, "--issue", facts.item, "--status", status, "--json"])
	process.stdout.write(`${JSON.stringify({ type: "stub", phase: "review", committed, wroteStatus: status })}\n`)
}

function main(): void {
	// 首行：claude stream-json 会话形状，引擎 parseSessionIdFromStream 只读首行的 session_id。
	process.stdout.write(`${JSON.stringify({ type: "system", session_id: `engine-integration-${randomUUID()}` })}\n`)
	const facts = parseStubPrompt(extractPromptArg(process.argv.slice(2)))
	if (facts.phase === "iteration") {
		runIteration(facts)
		return
	}
	if (facts.phase === "review") {
		runReview(facts)
		return
	}
	throw new Error(`stub runner does not know phase ${JSON.stringify(facts.phase)}`)
}

if (import.meta.main) {
	try {
		main()
	} catch (error) {
		process.stderr.write(`engine-integration-stub-runner: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exit(1)
	}
}
