#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { parseSessionIdFromRunnerStream } from "../src/loop"

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
import { appendFile } from "node:fs/promises"
const args = Bun.argv.slice(2)
await appendFile(${JSON.stringify(capturePath)}, JSON.stringify(args) + "\\n")
const child = Bun.spawn({ cmd: [${JSON.stringify(realBinary)}, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
process.exit(await child.exited)
`)
	command(["chmod", "+x", wrapper])
}

function capturedInvocations(path: string): string[][] {
	return readFileSync(path, "utf8").trim().split("\n").map((line, index) => {
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch (error) {
			throw new Error(`invalid captured runner argv ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
		}
		if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error(`captured runner argv ${path}:${index + 1} is not a string array`)
		return parsed
	})
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

function runDirectories(chain: string): string[] {
	const runsDir = resolve(loopDataRoot, "chains", chain, "runs")
	return readdirSync(runsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
}

function runSessionId(runner: string, chain: string, runId: string): string {
	if (!(["claude", "codex", "opencode"] as const).some((kind) => kind === runner)) throw new Error(`${runner}: unknown runner kind`)
	const streamPath = resolve(loopDataRoot, "chains", chain, "runs", runId, "phase", "stdout.jsonl")
	const sessionId = parseSessionIdFromRunnerStream(runner, readFileSync(streamPath, "utf8"))
	if (sessionId === null) throw new Error(`${chain}/${runId}: missing retained runner session id`)
	return sessionId
}

function assertOuterAuthorizationEvidence(runner: string, chain: string, runId: string): string {
	const evidencePath = resolve(loopDataRoot, "chains", chain, "runs", runId, "phase", "runner-authorization.json")
	const evidence = readFileSync(evidencePath, "utf8")
	if (!evidence.includes(`"runner":"${runner}"`)) throw new Error(`${runner}: outer authorization evidence has the wrong runner`)
	if (!evidence.includes('"outerSandboxBinary":"/usr/bin/sandbox-exec"')) throw new Error(`${runner}: outer sandbox binary missing from authorization evidence`)
	if (!evidence.includes('"outerSandboxProfile":"(version 1)')) throw new Error(`${runner}: complete outer sandbox profile missing from authorization evidence`)
	if (!evidence.includes(`(require-not (subpath \\"${loopDataRoot}\\"))`)) throw new Error(`${runner}: outer profile does not exclude the loop-data root from ambient reads`)
	if (evidence.includes(`"path":"${loopDataRoot}"`)) throw new Error(`${runner}: outer profile surfaces contain the whole loop-data root`)
	return evidencePath
}

function assertCredentialedTransitions(chain: string, runIds: readonly string[]): void {
	const eventsPath = resolve(loopDataRoot, "events", "events.jsonl")
	const events = readFileSync(eventsPath, "utf8").split("\n")
	for (const runId of runIds) {
		const admitted = events.some((line) =>
			line.includes('"type":"item.mutation.caller_admission"')
			&& line.includes(`"chain":"${chain}"`)
			&& line.includes(`"runId":"${runId}"`)
			&& line.includes('"reason":"agent-credential-admitted"'))
		if (!admitted) throw new Error(`${chain}/${runId}: transition did not use the daemon-issued run credential`)
	}
}

function assertResumeInvocation(runner: string, freshArgv: readonly string[], resumedArgv: readonly string[], sessionId: string): void {
	const expected = runner === "claude" ? "--resume" : runner === "opencode" ? "-s" : "resume"
	const freshIndex = freshArgv.indexOf(expected)
	if (freshIndex !== -1 && freshArgv[freshIndex + 1] === sessionId) throw new Error(`${runner}: fresh invocation unexpectedly resumed ${sessionId}`)
	const resumedIndex = resumedArgv.indexOf(expected)
	if (resumedIndex === -1 || resumedArgv[resumedIndex + 1] !== sessionId) throw new Error(`${runner}: second invocation did not resume retained session ${sessionId}`)
}

function writeFixture(): void {
	mkdirSync(target, { recursive: true })
	writeFileSync(resolve(target, "README.md"), "fixture\n")
	writeFileSync(resolve(target, "runner-filesystem-probe.sh"), `#!/bin/sh
set -eu

run_id="$1"
chain="$2"
preset_dir="$3"
shared_context="$4"
current_issue="$5"
evidence_dir="$6"
undeclared_same="$7"
undeclared_other="$8"
undeclared_root="$9"

grep -q DECLARED_PRESET_READ_OK "$preset_dir/fragment.md"
cat "$shared_context" "$current_issue" >/dev/null
if { printf mutation > "$preset_dir/mutation-forbidden"; } 2>/dev/null; then
	echo "preset mutation unexpectedly succeeded" >&2
	exit 1
fi
for path in "$undeclared_same" "$undeclared_other" "$undeclared_root"; do
	if cat "$path" >/dev/null 2>&1; then
		echo "undeclared read unexpectedly succeeded: $path" >&2
		exit 1
	fi
	if { printf append >> "$path"; } 2>/dev/null; then
		echo "undeclared append unexpectedly succeeded: $path" >&2
		exit 1
	fi
done

printf 'evidence-ok\n' > "$evidence_dir/runner-$run_id.txt"
printf 'runner-boundary\n' > "runner-boundary-$run_id.txt"
git add "runner-boundary-$run_id.txt"
git -c user.name=coder-loop-e2e -c user.email=e2e@example.invalid commit -m "runner-boundary-$run_id"
coder-loop item exits "$chain" --issue 1 --agent-run-id "$run_id" --agent-phase phase --json >/dev/null
if [ ! -e "$evidence_dir/resume-ready" ]; then
	printf 'ready\n' > "$evidence_dir/resume-ready"
	coder-loop item update "$chain" --issue 1 --status queued
	printf 'COMPLETION_PROTOCOL_ALREADY_EXECUTED status=queued; do not query exits or write status again\n'
else
	coder-loop item update "$chain" --issue 1 --status done
	printf 'COMPLETION_PROTOCOL_ALREADY_EXECUTED status=done; do not query exits or write status again\n'
fi
`, { mode: 0o755 })
	command(["git", "init", "-b", "main"], target)
	command(["git", "add", "README.md", "runner-filesystem-probe.sh"], target)
	command(["git", "-c", "user.name=coder-loop-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-m", "fixture"], target)
	mkdirSync(preset, { recursive: true })
	writeFileSync(resolve(preset, "fragment.md"), "DECLARED_PRESET_READ_OK\n")
	writeFileSync(resolve(preset, "phase.md"), `Execute exactly this command once in a non-login shell without a PTY, without inspecting files or constructing a replacement command:\n\n/bin/sh ./runner-filesystem-probe.sh {{RUN_ID}} {{CHAIN_NAME}} {{PRESET_DIR}} {{SHARED_CONTEXT_FILE}} {{CURRENT_ISSUE_FILE}} {{EVIDENCE_DIR}} ${loopDataRoot}/chains/{{CHAIN_NAME}}/undeclared.txt ${loopDataRoot}/chains/undeclared-other/private.txt ${loopDataRoot}/central.sqlite\n\nThe script itself executes the required completion protocol and prints the selected status. After it returns, do not query exits, do not write item status again, and do not run any other command; end the response immediately.\n`)
	writeFileSync(resolve(preset, "preset.toml"), `name = "runner-filesystem-grants-e2e"\n[item]\nidField = "issue"\n[item.fields]\nissue = "number"\n[statuses]\nentry = "queued"\ncontinuable = ["queued"]\nterminal = ["done"]\nsuccess = ["done"]\nexhausted = "done"\n[[fragments]]\nid = "fixture"\nrole = "common"\npath = "fragment.md"\n[[phases]]\nname = "phase"\nprompt = "phase.md"\nroles = ["common"]\n[phases.variables]\nISSUE = "item.issue"\nCHAIN_NAME = "runtime.chainName"\nRUN_ID = "runtime.runId"\nPRESET_DIR = "runtime.presetDir"\nFRAGMENT_INDEX = "runtime.fragmentIndex"\nSHARED_CONTEXT_FILE = "runtime.sharedContextPath"\nCURRENT_ISSUE_FILE = "runtime.currentIssueFile"\nEVIDENCE_DIR = "runtime.evidenceDir"\n[[phases.exits]]\nstatus = "queued"\nwhen = "fresh invocation requests native resume"\n[[phases.exits]]\nstatus = "done"\nwhen = "resumed invocation completes fixture"\n`)
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
writeFileSync(resolve(loopDataRoot, "central.sqlite"), "root-secret\n")
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
let completed = false
try {
	await waitForSocket()
	mkdirSync(resolve(loopDataRoot, "chains", "undeclared-other"), { recursive: true })
	writeFileSync(resolve(loopDataRoot, "chains", "undeclared-other", "private.txt"), "other-chain-secret\n")
	for (const runner of runners) {
		const chain = `filesystem-${runner}`
		const invocationCapture = resolve(loopDataRoot, "chains", chain, "evidence", "1", "runner.argv")
		command(["bun", loopEntry, "chain", "create", chain, "--config-json", JSON.stringify({ repository: "local/fixture", baseBranch: "main", presetPath: preset }), "--loop-data-root", loopDataRoot])
		writeFileSync(resolve(loopDataRoot, "chains", chain, "undeclared.txt"), "same-chain-secret\n")
		// The installed model inventory contains gpt-5.4-mini. Pin this boundary probe to that
		// low-latency model so C6 tests filesystem authorization rather than waiting on the
		// operator's potentially heavyweight interactive Codex default.
		if (runner === "codex") command(["bun", loopEntry, "chain", "set-runner-model", chain, "--kind", "codex", "--model", "gpt-5.4-mini", "--loop-data-root", loopDataRoot])
		mkdirSync(resolve(invocationCapture, ".."), { recursive: true })
		const issueFile = resolve(loopDataRoot, "chains", chain, "1.md")
		writeFileSync(issueFile, `${runner}-issue\n`)
		command(["bun", loopEntry, "item", "add", chain, "--issue", "1", "--repo-cwd", target, "--preset-path", preset, "--runner", runner, "--issue-file", "1.md", "--loop-data-root", loopDataRoot])
		await waitForRunner(chain)
		const runIds = runDirectories(chain)
		if (runIds.length !== 2) throw new Error(`${runner}: expected fresh plus resumed run directories, observed ${runIds.join(", ")}`)
		if (existsSync(resolve(preset, "mutation-forbidden"))) throw new Error(`${runner}: preset mutation escaped sandbox`)
		if (!existsSync(invocationCapture)) throw new Error(`${runner}: actual runner argv was not captured`)
		const invocations = capturedInvocations(invocationCapture)
		if (invocations.length !== 2) throw new Error(`${runner}: expected two captured invocations, observed ${invocations.length}`)
		for (const argv of invocations) assertCapturedInvocation(runner, argv)
		const retainedSessionId = runSessionId(runner, chain, runIds[0]!)
		assertResumeInvocation(runner, invocations[0]!, invocations[1]!, retainedSessionId)
		const outerEvidencePaths = runIds.map((runId) => assertOuterAuthorizationEvidence(runner, chain, runId))
		assertCredentialedTransitions(chain, runIds)
		for (const runId of runIds) {
			const runDir = resolve(loopDataRoot, "chains", chain, "runs", runId)
			if (!existsSync(resolve(runDir, "status.json"))) throw new Error(`${runner}/${runId}: missing retained status.json`)
			for (const artifact of ["stdout.jsonl", "runner-authorization.json"]) {
				if (!existsSync(resolve(runDir, "phase", artifact))) throw new Error(`${runner}/${runId}: missing retained ${artifact}`)
			}
			const evidence = resolve(loopDataRoot, "chains", chain, "evidence", "1", `runner-${runId}.txt`)
			if (readFileSync(evidence, "utf8").trim() !== "evidence-ok") throw new Error(`${runner}/${runId}: missing declared evidence write`)
			const commit = command(["git", "log", "--all", "--format=%s", "--grep", `^runner-boundary-${runId}$`], target)
			if (commit.trim() === "") throw new Error(`${runner}/${runId}: linked-worktree commit was not retained`)
		}
		if (readFileSync(resolve(loopDataRoot, "chains", chain, "undeclared.txt"), "utf8") !== "same-chain-secret\n") throw new Error(`${runner}: undeclared same-chain sentinel was modified`)
		if (readFileSync(resolve(loopDataRoot, "chains", "undeclared-other", "private.txt"), "utf8") !== "other-chain-secret\n") throw new Error(`${runner}: undeclared other-chain sentinel was modified`)
		if (readFileSync(resolve(loopDataRoot, "central.sqlite"), "utf8") !== "root-secret\n") throw new Error(`${runner}: undeclared root sentinel was modified`)
		process.stdout.write(`${runner}: fresh/resume argv and outer profiles verified (${invocations.map((argv) => argv.length).join("/")} args; ${outerEvidencePaths.join(", ")})\n`)
	}
	process.stdout.write(`runner filesystem grants e2e passed: ${runners.join(" ")}\n`)
	completed = true
} finally {
	spawnSync("bun", [loopEntry, "daemon", "down", "--loop-data-root", loopDataRoot], { encoding: "utf8", env: operatorEnv })
	if (daemon.exitCode === null) {
		daemon.kill("SIGTERM")
		await new Promise<void>((resolveClosed) => daemon.once("close", () => resolveClosed()))
	}
	if (completed) rmSync(workRoot, { recursive: true, force: true })
	else process.stderr.write(`runner filesystem grants e2e diagnostics retained at ${workRoot}\n`)
}
