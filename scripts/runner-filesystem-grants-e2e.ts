#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const loopEntry = resolve(repoRoot, "src/loop.ts")
const workRoot = mkdtempSync(resolve(tmpdir(), "coder-loop-runner-grants-"))
const loopDataRoot = resolve(workRoot, "loop-data")
const target = resolve(workRoot, "target")
const preset = resolve(workRoot, "preset")
const { CODER_LOOP_RUN_CRED: _parentRunCredential, ...operatorEnv } = process.env
const runnerFlagIndex = Bun.argv.indexOf("--runner")
const requestedRunner = runnerFlagIndex === -1 ? null : Bun.argv[runnerFlagIndex + 1]
if (requestedRunner !== null && !["claude", "codex", "opencode"].includes(requestedRunner)) throw new Error(`invalid --runner ${requestedRunner}`)

function command(args: readonly string[], cwd = repoRoot): string {
	const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", env: operatorEnv })
	if (result.status !== 0) throw new Error(`${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`)
	return result.stdout
}

function writeRunnerCaptureWrapper(wrapper: string, realBinary: string, capturePath: string): void {
	writeFileSync(wrapper, `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
const args = Bun.argv.slice(2)
await writeFile(${JSON.stringify(capturePath)}, JSON.stringify(args) + "\\n")
const child = Bun.spawn({ cmd: [${JSON.stringify(realBinary)}, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
process.exit(await child.exited)
`)
	command(["chmod", "+x", wrapper])
}

function capturedArgv(path: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch (error) {
		throw new Error(`invalid captured runner argv ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error(`captured runner argv ${path} is not a string array`)
	return parsed
}

function assertCapturedInvocation(runner: string, argv: readonly string[]): void {
	for (const arg of argv) {
		if (arg === loopDataRoot || arg.endsWith(`=${loopDataRoot}`) || arg === `-C${loopDataRoot}` || arg === `-s${loopDataRoot}`) {
			throw new Error(`${runner}: captured argv grants the whole loop-data root via ${arg}`)
		}
	}
	for (const forbidden of ["--permission-mode", "--dangerously-bypass-approvals-and-sandbox"]) {
		if (argv.some((arg) => arg === forbidden || arg.startsWith(`${forbidden}=`))) throw new Error(`${runner}: captured argv contains forbidden metadata bypass ${forbidden}`)
	}
	for (const [index, arg] of argv.entries()) {
		if (arg === "danger-full-access" || arg === "--sandbox=danger-full-access" || arg === "-sdanger-full-access") {
			throw new Error(`${runner}: captured argv contains authorization bypass ${arg}`)
		}
		if ((arg === "--sandbox" || arg === "-s") && argv[index + 1] === "danger-full-access") {
			throw new Error(`${runner}: captured argv contains authorization bypass ${arg} danger-full-access`)
		}
	}
	const skipPermissionsCount = argv.filter((arg) => arg === "--dangerously-skip-permissions").length
	if (skipPermissionsCount !== (runner === "opencode" ? 1 : 0)) throw new Error(`${runner}: unexpected --dangerously-skip-permissions count ${skipPermissionsCount}`)
}

function assertCredentialedTransition(chain: string): void {
	const eventsPath = resolve(loopDataRoot, "events", "events.jsonl")
	const admitted = readFileSync(eventsPath, "utf8").split("\n").some((line) =>
		line.includes('"type":"item.mutation.caller_admission"')
		&& line.includes(`"chain":"${chain}"`)
		&& line.includes('"reason":"agent-credential-admitted"'))
	if (!admitted) throw new Error(`${chain}: terminal transition did not use the daemon-issued run credential`)
}

function writeFixture(): void {
	mkdirSync(target, { recursive: true })
	writeFileSync(resolve(target, "README.md"), "fixture\n")
	command(["git", "init", "-b", "main"], target)
	command(["git", "add", "README.md"], target)
	command(["git", "-c", "user.name=coder-loop-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-m", "fixture"], target)
	mkdirSync(preset, { recursive: true })
	writeFileSync(resolve(preset, "fragment.md"), "DECLARED_PRESET_READ_OK\n")
	writeFileSync(resolve(preset, "phase.md"), `Read {{FRAGMENT_INDEX}} and require it contains DECLARED_PRESET_READ_OK. Run a shell command that attempts to write {{PRESET_DIR}}/mutation-forbidden and require that write to fail. Read {{SHARED_CONTEXT_FILE}} and {{CURRENT_ISSUE_FILE}}. Write the text evidence-ok to {{EVIDENCE_DIR}}/runner.txt. Then run exactly: coder-loop item exits {{CHAIN_NAME}} --issue {{ISSUE}} --agent-run-id {{RUN_ID}} --agent-phase phase --json ; and coder-loop item update {{CHAIN_NAME}} --issue {{ISSUE}} --status done . Exit nonzero if any requirement fails.\n`)
	writeFileSync(resolve(preset, "preset.toml"), `name = "runner-filesystem-grants-e2e"\n[item]\nidField = "issue"\n[item.fields]\nissue = "number"\n[statuses]\nentry = "queued"\ncontinuable = ["queued"]\nterminal = ["done"]\nsuccess = ["done"]\nexhausted = "done"\n[[fragments]]\nid = "fixture"\nrole = "common"\npath = "fragment.md"\n[[phases]]\nname = "phase"\nprompt = "phase.md"\nroles = ["common"]\n[phases.variables]\nISSUE = "item.issue"\nCHAIN_NAME = "runtime.chainName"\nRUN_ID = "runtime.runId"\nPRESET_DIR = "runtime.presetDir"\nFRAGMENT_INDEX = "runtime.fragmentIndex"\nSHARED_CONTEXT_FILE = "runtime.sharedContextPath"\nCURRENT_ISSUE_FILE = "runtime.currentIssueFile"\nEVIDENCE_DIR = "runtime.evidenceDir"\n[[phases.exits]]\nstatus = "done"\nwhen = "fixture complete"\n`)
}

async function waitForSocket(): Promise<void> {
	while (true) {
		const result = spawnSync("bun", [loopEntry, "daemon", "status", "--loop-data-root", loopDataRoot, "--json"], { encoding: "utf8" })
		if (result.status === 0) return
		await Bun.sleep(100)
	}
}

async function waitForRunner(chain: string): Promise<void> {
	while (true) {
		const status = JSON.parse(command(["bun", loopEntry, "chain", "status", chain, "--loop-data-root", loopDataRoot, "--json"]))
		if (status.chain?.status === "completed" && status.summary?.items?.byStatus?.done === 1) return
		await Bun.sleep(250)
	}
}

writeFixture()
mkdirSync(loopDataRoot, { recursive: true })
const runners = ["claude", "codex", "opencode"].filter((candidate) => requestedRunner === null || candidate === requestedRunner)
const captureBin = resolve(workRoot, "capture-bin")
mkdirSync(captureBin, { recursive: true })
for (const runner of runners) {
	const realBinary = Bun.which(runner)
	if (realBinary === null) throw new Error(`${runner}: binary not found on PATH`)
	const invocationCapture = resolve(loopDataRoot, "chains", `filesystem-${runner}`, "evidence", "1", "runner.argv")
	writeRunnerCaptureWrapper(resolve(captureBin, runner), realBinary, invocationCapture)
}
const driverEnv = { ...operatorEnv, PATH: `${captureBin}:${operatorEnv.PATH ?? ""}` }
const daemon = spawn("bun", [loopEntry, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"], { cwd: repoRoot, stdio: "inherit", env: driverEnv })
try {
	await waitForSocket()
	for (const runner of runners) {
		const chain = `filesystem-${runner}`
		const invocationCapture = resolve(loopDataRoot, "chains", chain, "evidence", "1", "runner.argv")
		command(["bun", loopEntry, "chain", "create", chain, "--config-json", JSON.stringify({ repository: "local/fixture", baseBranch: "main", presetPath: preset }), "--loop-data-root", loopDataRoot])
		// The installed model inventory contains gpt-5.4-mini. Pin this boundary probe to that
		// low-latency model so C5 tests filesystem authorization rather than waiting on the
		// operator's potentially heavyweight interactive Codex default.
		if (runner === "codex") command(["bun", loopEntry, "chain", "set-runner-model", chain, "--kind", "codex", "--model", "gpt-5.4-mini", "--loop-data-root", loopDataRoot])
		mkdirSync(resolve(invocationCapture, ".."), { recursive: true })
		const issueFile = resolve(loopDataRoot, "chains", chain, "1.md")
		writeFileSync(issueFile, `${runner}-issue\n`)
		command(["bun", loopEntry, "item", "add", chain, "--issue", "1", "--repo-cwd", target, "--preset-path", preset, "--runner", runner, "--issue-file", "1.md", "--loop-data-root", loopDataRoot])
		await waitForRunner(chain)
		const evidence = resolve(loopDataRoot, "chains", chain, "evidence", "1", "runner.txt")
		if (readFileSync(evidence, "utf8").trim() !== "evidence-ok") throw new Error(`${runner}: missing declared evidence write`)
		if (existsSync(resolve(preset, "mutation-forbidden"))) throw new Error(`${runner}: preset mutation escaped sandbox`)
		if (!existsSync(invocationCapture)) throw new Error(`${runner}: actual runner argv was not captured`)
		const argv = capturedArgv(invocationCapture)
		assertCapturedInvocation(runner, argv)
		assertCredentialedTransition(chain)
		process.stdout.write(`${runner}: captured argv verified (${argv.length} args)\n`)
	}
	process.stdout.write(`runner filesystem grants e2e passed: ${runners.join(" ")}\n`)
} finally {
	spawnSync("bun", [loopEntry, "daemon", "down", "--loop-data-root", loopDataRoot], { encoding: "utf8", env: operatorEnv })
	daemon.kill("SIGTERM")
	await new Promise<void>((resolveClosed) => daemon.once("close", () => resolveClosed()))
	rmSync(workRoot, { recursive: true, force: true })
}
