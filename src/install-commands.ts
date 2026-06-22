/**
 * coder-loop doctor subcommand.
 *
 * #436 capstone of umbrella #432: the prior bootstrap surface (target policy
 * file write, slash command vendoring, label asset creation, in-process chain
 * registration, post-bootstrap status smoke) reduced to nothing — each layer
 * either died with a prior child (#434/#435/#421) or moved to the daemon API
 * (`chain create`). What remains is a single read-only operator-facing health
 * check.
 *
 * `doctor` surface:
 *   - operator machine prerequisites: `gh` (+ auth), the runner CLIs declared
 *     by the bundled preset, `coder-loop` itself on PATH.
 *   - live runtime: the same snapshot `coder-loop status --json` returns,
 *     formatted as one human-readable line per signal.
 *
 * Zero target-file checks, zero mutation.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import type { AgentRunnerSelection, CoderLoopStatusSnapshot, JsonValue } from "./loop"
import { buildCoderLoopStatusSnapshot } from "./loop"

type DoctorArgs = {
	target: string
	repo: string | null
	loopDataRoot: string | null
	chainName: string | null
}

type CheckOutcome =
	| { ok: true; detail: string }
	| { ok: false; detail: string }

function formatStatusRunner(runner: { kind: string; source: string; binary: string; model: string | null }): string {
	return `${runner.kind} (${runner.source}, binary=${runner.binary}, model=${runner.model ?? "<default>"})`
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function info(message: string): void {
	console.error(message)
}

function joinArgs(remaining: string[], index: number, inlineValue: string | null, name: string): { value: string; consumed: number } {
	if (inlineValue !== null) return { value: inlineValue, consumed: 0 }
	const value = remaining[index + 1]
	if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`)
	return { value, consumed: 1 }
}

function splitFlag(arg: string): [string, string | null] {
	const eq = arg.indexOf("=")
	if (eq === -1) return [arg, null]
	return [arg.slice(0, eq), arg.slice(eq + 1)]
}

function parseDoctorArgs(raw: string[]): DoctorArgs {
	let target: string | null = null
	let repo: string | null = null
	let loopDataRoot: string | null = null
	let chainName: string | null = null
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i]!
		if (!arg.startsWith("--")) {
			if (target !== null) fail(`doctor: 多余位置参数 "${arg}"`)
			target = arg
			continue
		}
		const [name, inline] = splitFlag(arg)
		if (name === "--repo") {
			const { value, consumed } = joinArgs(raw, i, inline, name)
			repo = value
			i += consumed
			continue
		}
		if (name === "--loop-data-root") {
			const { value, consumed } = joinArgs(raw, i, inline, name)
			loopDataRoot = value
			i += consumed
			continue
		}
		if (name === "--chain") {
			const { value, consumed } = joinArgs(raw, i, inline, name)
			chainName = value
			i += consumed
			continue
		}
		fail(`doctor: 未知参数 "${arg}"`)
	}
	return { target: resolve(target ?? process.cwd()), repo, loopDataRoot, chainName }
}

async function spawnCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolveResult) => {
		const child: ChildProcess = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
		const out: Buffer[] = []
		const err: Buffer[] = []
		child.stdout?.on("data", (c: Buffer) => out.push(c))
		child.stderr?.on("data", (c: Buffer) => err.push(c))
		child.on("error", () => resolveResult({ code: 127, stdout: "", stderr: "" }))
		child.on("close", (code) => {
			resolveResult({
				code: code ?? 1,
				stdout: Buffer.concat(out).toString("utf-8"),
				stderr: Buffer.concat(err).toString("utf-8"),
			})
		})
	})
}

function whichBinary(name: string): string | null {
	if (typeof (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun?.which === "function") {
		return (globalThis as { Bun: { which: (n: string) => string | null } }).Bun.which(name)
	}
	const path = process.env.PATH ?? ""
	for (const dir of path.split(":")) {
		if (dir === "") continue
		const candidate = resolve(dir, name)
		try {
			const fs = require("node:fs") as typeof import("node:fs")
			if (fs.existsSync(candidate)) return candidate
		} catch {
			// ignore
		}
	}
	return null
}

// ===================================================================
// Operator machine prerequisites (verify only, never install)
// ===================================================================

type RequiredRunnerCli = Pick<AgentRunnerSelection, "kind" | "binary">

async function checkOperatorPrereqs(requiredRunners: RequiredRunnerCli[]): Promise<CheckOutcome[]> {
	const results: CheckOutcome[] = []

	const ghPath = whichBinary("gh")
	if (!ghPath) {
		results.push({ ok: false, detail: "gh CLI 未在 PATH 中。安装：https://cli.github.com — macOS: `brew install gh`；Linux: 见官网。" })
	} else {
		results.push({ ok: true, detail: `gh CLI 在 ${ghPath}` })
		const authResult = await spawnCapture("gh", ["auth", "status"])
		if (authResult.code !== 0) {
			results.push({ ok: false, detail: "gh 未认证。运行：`gh auth login --scopes repo`（必须含 repo scope 才能 create labels / issues / PRs）。" })
		} else {
			results.push({ ok: true, detail: "gh 已认证（scope 含 repo）" })
		}
	}

	for (const requiredRunner of uniqueRequiredRunners(requiredRunners)) {
		const runnerPath = whichBinary(requiredRunner.binary)
		if (!runnerPath) results.push({ ok: false, detail: runnerInstallHint(requiredRunner) })
		else results.push({ ok: true, detail: `${requiredRunner.kind} runner CLI (${requiredRunner.binary}) 在 ${runnerPath}` })
	}

	const coderLoopPath = whichBinary("coder-loop")
	if (!coderLoopPath) {
		results.push({ ok: false, detail: "coder-loop CLI 未在 PATH（提示：可用 `bun link` 在本 repo 注册全局命令）。" })
	} else {
		results.push({ ok: true, detail: `coder-loop CLI 在 ${coderLoopPath}` })
	}

	return results
}

function uniqueRequiredRunners(runners: RequiredRunnerCli[]): RequiredRunnerCli[] {
	const seen = new Set<string>()
	const unique: RequiredRunnerCli[] = []
	for (const runner of runners) {
		const key = `${runner.kind}\0${runner.binary}`
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(runner)
	}
	return unique
}

function runnerInstallHint(runner: RequiredRunnerCli): string {
	if (runner.kind === "codex") return `codex runner CLI (${runner.binary}) 未在 PATH 中。安装/配置 Codex CLI，并确认 \`${runner.binary} --version\` 可运行。`
	return `claude runner CLI (${runner.binary}) 未在 PATH 中。安装：https://docs.anthropic.com/claude/docs/claude-code（npm: \`npm install -g @anthropic-ai/claude-code\`），并确认 \`${runner.binary} --version\` 可运行。`
}

// ===================================================================
// Live runtime health (read-only; sourced from coder-loop status)
// ===================================================================

export function buildLiveRuntimeHealthLines(snapshot: CoderLoopStatusSnapshot): string[] {
	const lines: string[] = []
	const statePrefix = snapshot.state.ok ? "OK" : "FAIL"
	lines.push(`${statePrefix}: state ${snapshot.state.kind} (${snapshot.state.path})`)
	for (const error of snapshot.state.errors) lines.push(`  FAIL: ${error.path}: ${error.message}`)

	const selected = snapshot.queue.selected?.id ?? "<none>"
	lines.push(`INFO: queue total=${snapshot.queue.total}, continuable=${snapshot.queue.continuable}, terminal=${snapshot.queue.terminal}, selected=${selected}`)
	// #456: role-shaped runner-default summary segments retired. Per-phase runner enumeration
	// below is the canonical display — every preset-declared phase appears once, regardless of
	// whether it happens to be named "review" or anything else.
	lines.push(`INFO: runner hostDefault=${snapshot.target.runner.hostDefault}, default=${formatStatusRunner(snapshot.target.runner.default)}`)
	lines.push(`INFO: phase runners=${formatPhaseRunners(snapshot.target.runner.phases)}`)
	if (snapshot.queue.selected !== null) lines.push(`INFO: selected runner=${formatStatusRunner(snapshot.queue.selected.runner)}`)

	if (snapshot.current.run === null) {
		lines.push("INFO: current run=<none>")
	} else {
		const currentRunner = snapshot.current.runner === null ? "<unknown>" : formatStatusRunner(snapshot.current.runner)
		lines.push(`INFO: current id=${snapshot.current.id ?? "<unknown>"}, phase=${snapshot.current.run.phase}, runId=${snapshot.current.run.runId}, runner=${currentRunner}`)
		const phaseStatus = snapshot.current.phaseStatus
		if (phaseStatus === null) {
			lines.push("WARN: current phase status unavailable")
		} else if (!phaseStatus.exists) {
			lines.push(`WARN: current phase status missing (${phaseStatus.path})`)
		} else if (phaseStatus.error !== null) {
			lines.push(`FAIL: current phase status unreadable (${phaseStatus.error})`)
		} else if (phaseStatus.value !== null) {
			lines.push(`OK: current phase status runner=${phaseStatus.value.runner ?? "<unknown>"}, model=${phaseStatus.value.model ?? "<default>"}, pid=${phaseStatus.value.pid}, exit=${phaseStatus.value.exitCode ?? "<running>"}, signal=${phaseStatus.value.signal ?? "<none>"}, session=${phaseStatus.value.sessionId ?? "<none>"}`)
		}
	}

	if (snapshot.events.error !== null) {
		lines.push(`FAIL: events unreadable (${snapshot.events.error})`)
	} else if (snapshot.events.runId === null) {
		lines.push("INFO: events runId=<none>")
	} else {
		const latestType = eventType(snapshot.events.latest)
		lines.push(`${snapshot.events.exists ? "OK" : "WARN"}: events runId=${snapshot.events.runId}, exists=${snapshot.events.exists}, recent=${snapshot.events.recent.length}, latest=${latestType}`)
	}

	const matchingLive = snapshot.processes.live.filter((entry) => entry.alive && entry.matchesTarget)
	lines.push(`INFO: live processes total=${snapshot.processes.live.length}, matching=${matchingLive.length}`)
	if (snapshot.processes.scanError !== null) lines.push(`FAIL: process scan error: ${snapshot.processes.scanError}`)
	if (matchingLive.length > 1) lines.push("WARN: multiple live loop processes match target")

	return lines
}

function formatPhaseRunners(phases: Record<string, { kind: string; source: string; binary: string; model: string | null }>): string {
	const entries = Object.entries(phases)
	if (entries.length === 0) return "<none>"
	return entries.map(([phase, runner]) => `${phase}=${formatStatusRunner(runner)}`).join(", ")
}

function eventType(value: JsonValue | null): string {
	if (value === null) return "<none>"
	if (typeof value !== "object" || Array.isArray(value)) return "<non-object>"
	const type = value.type
	return typeof type === "string" ? type : "<unknown>"
}

// ===================================================================
// doctor entry point
// ===================================================================

export async function runDoctorCommand(rawArgs: string[]): Promise<void> {
	const args = parseDoctorArgs(rawArgs)
	let hasFailure = false
	info(`==> coder-loop doctor: target=${args.target}`)

	const statusSnapshot = await buildCoderLoopStatusSnapshot({
		targetCwd: args.target,
		loopDataRoot: args.loopDataRoot,
		chainName: args.chainName,
		output: "json",
	})

	info("\n[Operator machine] gh / runner CLI / coder-loop on PATH")
	const bResults = await checkOperatorPrereqs(Object.values(statusSnapshot.target.runner.phases))
	info(`  INFO: target default runner=${formatStatusRunner(statusSnapshot.target.runner.default)}`)
	// #456: per-phase enumeration replaces the legacy `review default runner=` line.
	info(`  INFO: phase runners=${formatPhaseRunners(statusSnapshot.target.runner.phases)}`)
	for (const r of bResults) {
		info(`  ${r.ok ? "OK" : "FAIL"}: ${r.detail}`)
		if (!r.ok) hasFailure = true
	}

	info("\n[Live Runtime] coder-loop runtime health")
	for (const line of buildLiveRuntimeHealthLines(statusSnapshot)) {
		info(`  ${line}`)
		if (line.trimStart().startsWith("FAIL:")) hasFailure = true
	}

	info("\nDoctor 完成（read-only）。FAIL 项按提示手动修复（PATH / `gh auth login` / runner CLI / central daemon）。")
	if (hasFailure) process.exitCode = 1
}

export async function dispatchSubcommand(subcommand: string, rest: string[]): Promise<boolean> {
	if (subcommand === "doctor") {
		await runDoctorCommand(rest)
		return true
	}
	return false
}
