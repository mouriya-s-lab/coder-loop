/**
 * coder-loop install / uninstall / doctor subcommands.
 *
 * Four layers (per issue #49):
 *   A) target project files: committed workflow.md policy
 *   B) target GitHub state: kind:code / kind:comment / kind:code-spike / kind:blocked labels
 *   C) operator machine prereqs: gh (+ auth), selected runner CLIs (verify only)
 *   D) user-level skill version: writing-issue marker check
 *
 * Idempotent by design: re-running install does not mutate files whose
 * content already matches; `--force` overrides.
 */

import { spawn, type ChildProcess } from "node:child_process"
import {
	access,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { resolve, dirname } from "node:path"
import { daemonRequest, sendDaemonRequest } from "./daemon"
import { buildCoderLoopStatusSnapshot, loadPreset, type AgentRunnerKind, type AgentRunnerSelection, type CoderLoopStatusSnapshot, type JsonValue, type Preset } from "./loop"
import { resolveLoopDataPaths } from "./runtime-paths"

const PKG_ROOT = resolve(import.meta.dir, "..")
const PRESETS_DIR = resolve(PKG_ROOT, "presets")
const TEMPLATES_DIR = resolve(PKG_ROOT, "templates")

const SLASH_COMMAND_FILES = ["dev-plan.md", "dev-loop.md"] as const
const KIND_LABELS = [
	{ name: "kind:code", color: "1f883d", description: "Issue 的 deliverable 是代码 PR" },
	{ name: "kind:comment", color: "0969da", description: "Issue 的 deliverable 是 PR comment / review reply" },
	{ name: "kind:code-spike", color: "fbca04", description: "Issue 的 deliverable 是 source-writing spike evidence；不走 PR merge" },
	{ name: "kind:blocked", color: "b60205", description: "Issue 的 deliverable 是解除具体阻塞条件并恢复被阻塞 loop" },
] as const

const WRITING_ISSUE_SKILL_REL = ".claude/skills/writing-issue/SKILL.md"
const WRITING_ISSUE_MARKER = "docs/reserved-strings.md"

const WORKFLOW_REL = ".coder-loop/workflow.md"
const SLASH_COMMANDS_REL = ".claude/commands"

type InstallArgs = {
	target: string
	repo: string | null
	presetName: string
	loopDataRoot: string | null
	force: boolean
	dryRun: boolean
	installSkills: boolean
	skipSkillCheck: boolean
}

type UninstallArgs = {
	target: string
}

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

type RepoSlug = {
	owner: string
	name: string
	slug: string
}

function repoSlugError(repo: string): string {
	return `install: invalid repo slug ${JSON.stringify(repo)}`
}

function parseRepoSlug(input: string): RepoSlug | null {
	if (input.trim() !== input) return null
	const parts = input.split("/")
	if (parts.length !== 2) return null
	const owner = parts[0]!
	const name = parts[1]!
	if (!isRepoSlugSegment(owner) || !isRepoSlugSegment(name)) return null
	return { owner, name, slug: `${owner}/${name}` }
}

function isRepoSlugSegment(input: string): boolean {
	return input.length > 0 && input.length <= 255 && /^[A-Za-z0-9._-]+$/.test(input)
}

function requireInstallRepoSlug(repo: string): RepoSlug {
	const parsed = parseRepoSlug(repo)
	if (parsed === null) fail(repoSlugError(repo))
	return parsed
}

async function assertInstallTargetIsGitRepository(target: string): Promise<void> {
	if (!(await pathExists(resolve(target, ".git")))) {
		fail(`install: target is not a git repository: ${target}`)
	}
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

function parseInstallArgs(raw: string[]): InstallArgs {
	let target: string | null = null
	let repo: string | null = null
	let presetName = "gh-issue-pr-iteration"
	let loopDataRoot: string | null = null
	let force = false
	let dryRun = false
	let installSkills = false
	let skipSkillCheck = false

	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i]!
		if (!arg.startsWith("--")) {
			if (target !== null) fail(`install: 多余位置参数 "${arg}"（target 已为 ${target}）`)
			target = arg
			continue
		}
		const [name, inline] = splitFlag(arg)
		switch (name) {
			case "--repo": {
				const { value, consumed } = joinArgs(raw, i, inline, name)
				repo = value
				i += consumed
				break
			}
			case "--preset": {
				const { value, consumed } = joinArgs(raw, i, inline, name)
				presetName = value
				i += consumed
				break
			}
			case "--loop-data-root": {
				const { value, consumed } = joinArgs(raw, i, inline, name)
				loopDataRoot = value
				i += consumed
				break
			}
			case "--force":
				force = true
				break
			case "--dry-run":
				dryRun = true
				break
			case "--install-skills":
				installSkills = true
				break
			case "--skip-skill-check":
				skipSkillCheck = true
				break
			default:
				fail(`install: 未知参数 "${arg}"`)
		}
	}

	if (target === null) fail("install: 缺少 target 路径。用法: coder-loop install <target> [--repo <slug>] [--preset <name>] [--loop-data-root <path>] [--force] [--dry-run] [--install-skills] [--skip-skill-check]")
	return { target: resolve(target), repo, presetName, loopDataRoot, force, dryRun, installSkills, skipSkillCheck }
}

function parseUninstallArgs(raw: string[]): UninstallArgs {
	let target: string | null = null
	for (const arg of raw) {
		if (arg.startsWith("--")) fail(`uninstall: 未知参数 "${arg}"`)
		if (target !== null) fail(`uninstall: 多余位置参数 "${arg}"`)
		target = arg
	}
	if (target === null) fail("uninstall: 缺少 target 路径。用法: coder-loop uninstall <target>")
	return { target: resolve(target) }
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8")
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT") return null
		throw error
	}
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
// Layer C: operator machine prereqs (verify only, never install)
// ===================================================================

type RequiredRunnerCli = Pick<AgentRunnerSelection, "kind" | "binary">

function requiredRunnersForPreset(preset: Preset): RequiredRunnerCli[] {
	return preset.phases.map((phase) => {
		const kind: AgentRunnerKind = phase.defaultRunner ?? "codex"
		return { kind, binary: kind }
	})
}

async function checkLayerC(requiredRunners: RequiredRunnerCli[]): Promise<CheckOutcome[]> {
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
// Layer D: user-level skill version check (writing-issue marker)
// ===================================================================

type SkillCheckStatus = "ok" | "missing" | "outdated"

async function checkLayerD(): Promise<{ status: SkillCheckStatus; detail: string; path: string }> {
	const path = resolve(homedir(), WRITING_ISSUE_SKILL_REL)
	const content = await readIfExists(path)
	if (content === null) {
		return { status: "missing", detail: `${path} 不存在`, path }
	}
	if (!content.includes(WRITING_ISSUE_MARKER)) {
		return { status: "outdated", detail: `${path} 缺少新版 marker "${WRITING_ISSUE_MARKER}"（缺少 engine reserved strings issue-writing rule）`, path }
	}
	return { status: "ok", detail: `${path} 含新版 marker`, path }
}

async function syncWritingIssueSkill(dryRun: boolean): Promise<{ wrote: boolean; path: string; sourcePath: string }> {
	const sourcePath = resolve(TEMPLATES_DIR, "skills/writing-issue/SKILL.md")
	const targetPath = resolve(homedir(), WRITING_ISSUE_SKILL_REL)
	const sourceContent = await readFile(sourcePath, "utf-8")
	const existing = await readIfExists(targetPath)
	if (existing === sourceContent) return { wrote: false, path: targetPath, sourcePath }
	if (dryRun) return { wrote: false, path: targetPath, sourcePath }
	await mkdir(dirname(targetPath), { recursive: true })
	await writeFile(targetPath, sourceContent)
	return { wrote: true, path: targetPath, sourcePath }
}

// ===================================================================
// Layer A: target project files
// ===================================================================

async function ensureWorkflowMd(target: string, dryRun: boolean): Promise<{ wrote: boolean; path: string }> {
	const path = resolve(target, WORKFLOW_REL)
	if (await pathExists(path)) return { wrote: false, path }
	const template = await readFile(resolve(TEMPLATES_DIR, "workflow.md"), "utf-8")
	if (!dryRun) {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, template)
	}
	return { wrote: true, path }
}

// ===================================================================
// Layer B: GitHub labels
// ===================================================================

type LabelOutcome =
	| { name: string; status: "exists" | "created" | "skipped-no-repo" | "would-create" }
	| { name: string; status: "failed"; reason: string }

async function ensureGithubLabels(repo: string | null, dryRun: boolean): Promise<LabelOutcome[]> {
	if (repo === null) {
		return KIND_LABELS.map((l) => ({ name: l.name, status: "skipped-no-repo" }))
	}
	const list = await spawnCapture("gh", ["label", "list", "--repo", repo, "--limit", "500", "--json", "name", "--jq", "[.[].name]"])
	let existingNames = new Set<string>()
	if (list.code === 0) {
		try {
			const parsed: unknown = JSON.parse(list.stdout.trim() === "" ? "[]" : list.stdout)
			if (Array.isArray(parsed)) {
				for (const entry of parsed) if (typeof entry === "string") existingNames.add(entry)
			}
		} catch {
			// fall through; treat as empty
		}
	} else {
		return KIND_LABELS.map((l) => ({ name: l.name, status: "failed", reason: `gh label list failed: ${list.stderr.trim()}` }))
	}
	const out: LabelOutcome[] = []
	for (const label of KIND_LABELS) {
		if (existingNames.has(label.name)) {
			out.push({ name: label.name, status: "exists" })
			continue
		}
		if (dryRun) {
			out.push({ name: label.name, status: "would-create" })
			continue
		}
		const create = await spawnCapture("gh", [
			"label", "create", label.name,
			"--repo", repo,
			"--color", label.color,
			"--description", label.description,
		])
		if (create.code !== 0) {
			out.push({ name: label.name, status: "failed", reason: create.stderr.trim() })
		} else {
			out.push({ name: label.name, status: "created" })
		}
	}
	return out
}

// ===================================================================
// Final status smoke invocation
// ===================================================================

async function runInstallStatusSmoke(target: string, loopDataRoot: string | null, chainName: string | null = null): Promise<{ code: number; output: string }> {
	const entry = resolve(PKG_ROOT, "src/loop.ts")
	const bunPath = whichBinary("bun") ?? "bun"
	const args = [entry, "status", target, "--json"]
	if (loopDataRoot !== null) args.push("--loop-data-root", loopDataRoot)
	if (chainName !== null) args.push("--chain", chainName)
	const child = await spawnCapture(bunPath, args)
	return { code: child.code, output: `${child.stdout}\n${child.stderr}` }
}

async function createChainThroughDaemon(input: {
	target: string
	repo: string
	preset: Preset
	loopDataRoot: string | null
	dryRun: boolean
}): Promise<{ chainName: string; result: JsonValue | null }> {
	const chainName = defaultChainName(input.repo)
	if (input.dryRun) return { chainName, result: null }
	const socketPath = centralDaemonSocketPath(input.loopDataRoot)
	try {
		const response = await sendDaemonRequest(socketPath, daemonRequest("chain.create", {
			name: chainName,
			repository: input.repo,
			preset: input.preset.name,
			baseBranch: "main",
			metadata: {},
		}))
		if (!response.ok) fail(`${response.error.code}: ${response.error.message}`)
		return { chainName, result: response.result as JsonValue }
	} catch (error) {
		fail(formatCentralDaemonNotRunning(input.loopDataRoot, socketPath, error))
	}
}

function defaultChainName(repo: string): string {
	return requireInstallRepoSlug(repo).name
}

async function assertCentralDaemonReachable(loopDataRoot: string | null, dryRun: boolean): Promise<void> {
	if (dryRun) return
	const socketPath = centralDaemonSocketPath(loopDataRoot)
	try {
		const response = await sendDaemonRequest(socketPath, daemonRequest("chain.list"))
		if (!response.ok) fail(`${response.error.code}: ${response.error.message}`)
	} catch (error) {
		fail(formatCentralDaemonNotRunning(loopDataRoot, socketPath, error))
	}
}

function centralDaemonSocketPath(loopDataRoot: string | null): string {
	return resolveLoopDataPaths(loopDataRoot === null ? {} : { loopDataRoot }).daemonSocket
}

function formatCentralDaemonNotRunning(loopDataRoot: string | null, socketPath: string, error: unknown): string {
	const hint = loopDataRoot === null ? "coder-loop daemon up" : `coder-loop daemon up --loop-data-root ${loopDataRoot}`
	return `central daemon is not running at ${socketPath}; start it with \`${hint}\`. ${error instanceof Error ? error.message : String(error)}`
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
	lines.push(`INFO: runner hostDefault=${snapshot.target.runner.hostDefault}, default=${formatStatusRunner(snapshot.target.runner.default)}, reviewDefault=${formatStatusRunner(snapshot.target.runner.reviewDefault)}`)
	lines.push(`INFO: phase runners=${formatPhaseRunners(snapshot.target.runner.phases)}`)
	if (snapshot.queue.selected !== null) lines.push(`INFO: selected runner=${formatStatusRunner(snapshot.queue.selected.runner)}, review=${formatStatusRunner(snapshot.queue.selected.reviewRunner)}`)

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
// install / uninstall / doctor entry points
// ===================================================================

async function loadAvailablePresets(): Promise<string[]> {
	try {
		const fs = await import("node:fs/promises")
		const entries = await fs.readdir(PRESETS_DIR, { withFileTypes: true })
		return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
	} catch {
		return []
	}
}

async function loadPresetForName(name: string): Promise<Preset> {
	const presetDir = resolve(PRESETS_DIR, name)
	if (!(await pathExists(presetDir))) {
		const available = await loadAvailablePresets()
		console.error(`install: 未知 preset "${name}"。可用 preset: ${available.length === 0 ? "<none>" : available.join(", ")}`)
		process.exit(1)
	}
	return loadPreset(presetDir)
}

export async function runInstallCommand(rawArgs: string[]): Promise<void> {
	const args = parseInstallArgs(rawArgs)
	await assertInstallTargetIsGitRepository(args.target)
	const explicitRepo = args.repo === null ? null : requireInstallRepoSlug(args.repo).slug
	const preset = await loadPresetForName(args.presetName)
	const repoForChain = explicitRepo ?? (await inferRepoFromGit(args.target))
	if (repoForChain === null) fail("install: missing --repo and git origin is not a GitHub repository; cannot create chain")
	await assertCentralDaemonReachable(args.loopDataRoot, args.dryRun)

	info(`==> coder-loop install: target=${args.target}, preset=${preset.name}@${preset.version}, dry-run=${args.dryRun}`)

	info("\n[Layer A] Target committed policy")
	const workflowResult = await ensureWorkflowMd(args.target, args.dryRun)
	info(`  ${workflowResult.wrote ? (args.dryRun ? "would-write" : "已写入") : "未变化（保留 operator 自定义）"}: ${WORKFLOW_REL}`)

	info("\n[Central] DB chain")
	const chainCreate = await createChainThroughDaemon({
		target: args.target,
		repo: repoForChain,
		preset,
		loopDataRoot: args.loopDataRoot,
		dryRun: args.dryRun,
	})
	info(`  ${args.dryRun ? "would-upsert" : "upserted"} chain: ${chainCreate.chainName} (repo ${repoForChain})`)

	// Layer C: prereqs
	info("\n[Layer C] Operator 机器先决条件")
	const installRunners = requiredRunnersForPreset(preset)
	info(`  INFO: role entry md runners=${installRunners.map((runner) => `${runner.kind}:${runner.binary}`).join(", ")}`)
	const layerCResults = await checkLayerC(installRunners)
	for (const r of layerCResults) info(`  ${r.ok ? "OK" : "FAIL"}: ${r.detail}`)
	const layerCOk = layerCResults.every((r) => r.ok)
	if (!layerCOk && !args.dryRun) {
		fail(`Layer C 校验未通过：先按上面提示修复 gh / runner CLI / 认证，再重跑 install。`)
	}

	// Layer D: user-level skill
	info("\n[Layer D] User-level skill 版本")
	const layerD = await checkLayerD()
	info(`  ${layerD.status === "ok" ? "OK" : "FAIL"}: ${layerD.detail}`)
	if (layerD.status !== "ok") {
		if (args.installSkills) {
			info("  --install-skills: 同步 templates/skills/writing-issue/SKILL.md → user-level")
			const sync = await syncWritingIssueSkill(args.dryRun)
			info(`  ${sync.wrote ? "已写入" : (args.dryRun ? "would-write" : "未变化")}: ${sync.path}（源：${sync.sourcePath}）`)
		} else if (args.skipSkillCheck) {
			info("  --skip-skill-check 已设置：跳过 Layer D 严格校验。")
		} else if (!args.dryRun) {
			fail(`Layer D 校验未通过。修复路径：\n  (a) coder-loop install ${args.target} --install-skills   # 自动 sync 新版\n  (b) 手动覆盖 ${layerD.path} 为最新 writing-issue SKILL.md\n  (c) coder-loop install ${args.target} --skip-skill-check  # 临时绕过`)
		}
	}

	// Layer B: GitHub labels
	info("\n[Layer B] Target GitHub 状态")
	const repoForLabels = repoForChain
	const labelOutcomes = await ensureGithubLabels(repoForLabels, args.dryRun)
	for (const o of labelOutcomes) {
		const desc = o.status === "failed" ? `FAIL (${o.reason})` : o.status
		info(`  ${o.name}: ${desc}`)
	}

	// Final: status smoke (skip in dry-run)
	if (args.dryRun) {
		info("\n[Final] --dry-run：跳过 status smoke")
		return
	}
	info("\n[Final] 跑 coder-loop status --json")
	const finalCheck = await runInstallStatusSmoke(args.target, args.loopDataRoot, chainCreate.chainName)
	process.stderr.write(finalCheck.output)
	if (finalCheck.code !== 0) {
		fail(`\nInstall 部分成功，但 status smoke 退出 ${finalCheck.code}。修复后重跑 install。`)
	}
	info("\nInstall 完成。下一步：在 target 跑 `/dev-plan <design-doc-or-issue>`。")
}

async function inferRepoFromGit(target: string): Promise<string | null> {
	const result = await spawnCapture("git", ["-C", target, "remote", "get-url", "origin"])
	if (result.code !== 0) return null
	const url = result.stdout.trim()
	// Forms: git@github.com:owner/repo.git, https://github.com/owner/repo(.git)
	const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
	if (sshMatch) return parseRepoSlug(`${sshMatch[1]}/${sshMatch[2]}`)?.slug ?? null
	const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
	if (httpsMatch) return parseRepoSlug(`${httpsMatch[1]}/${httpsMatch[2]}`)?.slug ?? null
	return null
}

export async function runUninstallCommand(rawArgs: string[]): Promise<void> {
	const args = parseUninstallArgs(rawArgs)
	info(`==> coder-loop uninstall: target=${args.target}`)
	let removed = 0
	for (const fname of SLASH_COMMAND_FILES) {
		const p = resolve(args.target, SLASH_COMMANDS_REL, fname)
		if (await pathExists(p)) {
			await rm(p)
			info(`  已删除: ${SLASH_COMMANDS_REL}/${fname}`)
			removed++
		} else {
			info(`  未找到（已不存在）: ${SLASH_COMMANDS_REL}/${fname}`)
		}
	}
	info(`\nUninstall 完成。runtime / GitHub labels / user-level skills 一概保留（${removed} 个 slash command 文件被移除）。`)
}

export async function runDoctorCommand(rawArgs: string[]): Promise<void> {
	const args = parseDoctorArgs(rawArgs)
	let hasFailure = false
	info(`==> coder-loop doctor: target=${args.target}`)

	info("\n[Layer A] Target 项目文件")
	const aChecks: { label: string; check: Promise<boolean> }[] = [
		{ label: WORKFLOW_REL, check: pathExists(resolve(args.target, WORKFLOW_REL)) },
	]
	for (const c of aChecks) {
		const ok = await c.check
		info(`  ${ok ? "OK" : "FAIL"}: ${c.label}`)
		if (!ok) hasFailure = true
	}

	info("\n[Layer B] Target GitHub 状态")
	const repo = args.repo ?? (await inferRepoFromGit(args.target))
	if (repo === null) {
		info("  SKIP: 未提供 --repo 且 git remote 未配置；无法检查 labels")
	} else {
		const list = await spawnCapture("gh", ["label", "list", "--repo", repo, "--limit", "500", "--json", "name", "--jq", "[.[].name]"])
		if (list.code !== 0) {
			info(`  FAIL: gh label list 失败 (${list.stderr.trim()})`)
			hasFailure = true
		} else {
			let names = new Set<string>()
			try {
				const parsed: unknown = JSON.parse(list.stdout.trim() === "" ? "[]" : list.stdout)
				if (Array.isArray(parsed)) for (const e of parsed) if (typeof e === "string") names.add(e)
			} catch {
				// ignore
			}
			for (const label of KIND_LABELS) {
				const ok = names.has(label.name)
				info(`  ${ok ? "OK" : "FAIL"}: label ${label.name}（repo ${repo}）`)
				if (!ok) hasFailure = true
			}
		}
	}

	const statusSnapshot = await buildCoderLoopStatusSnapshot({
		targetCwd: args.target,
		configPath: null,
		loopDataRoot: args.loopDataRoot,
		chainName: args.chainName,
		output: "json",
	})

	info("\n[Layer C] Operator 机器先决条件")
	const cResults = await checkLayerC(Object.values(statusSnapshot.target.runner.phases))
	info(`  INFO: target default runner=${formatStatusRunner(statusSnapshot.target.runner.default)}`)
	info(`  INFO: review default runner=${formatStatusRunner(statusSnapshot.target.runner.reviewDefault)}`)
	info(`  INFO: phase runners=${formatPhaseRunners(statusSnapshot.target.runner.phases)}`)
	for (const r of cResults) {
		info(`  ${r.ok ? "OK" : "FAIL"}: ${r.detail}`)
		if (!r.ok) hasFailure = true
	}

	info("\n[Layer D] User-level skill 版本")
	const dResult = await checkLayerD()
	info(`  ${dResult.status === "ok" ? "OK" : "FAIL"}: ${dResult.detail}`)
	if (dResult.status !== "ok") hasFailure = true

	info("\n[Live Runtime] coder-loop runtime health")
	for (const line of buildLiveRuntimeHealthLines(statusSnapshot)) {
		info(`  ${line}`)
		if (line.trimStart().startsWith("FAIL:")) hasFailure = true
	}

	info("\nDoctor 完成（read-only）。任何 FAIL 项需 `coder-loop install <target>` 或手动修复。")
	if (hasFailure) process.exitCode = 1
}

export async function dispatchSubcommand(subcommand: string, rest: string[]): Promise<boolean> {
	if (subcommand === "install") {
		await runInstallCommand(rest)
		return true
	}
	if (subcommand === "uninstall") {
		await runUninstallCommand(rest)
		return true
	}
	if (subcommand === "doctor") {
		await runDoctorCommand(rest)
		return true
	}
	return false
}
