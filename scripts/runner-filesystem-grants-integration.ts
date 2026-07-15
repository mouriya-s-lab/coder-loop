#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, relative, resolve } from "node:path"
import { parseSessionIdFromRunnerStream } from "../src/loop"

const repoRoot = resolve(import.meta.dir, "..")
const loopEntry = resolve(repoRoot, "src/loop.ts")
const workRoot = mkdtempSync(resolve(tmpdir(), "coder-loop-runner-grants-"))
const loopDataRoot = resolve(workRoot, "loop-data")
const target = resolve(workRoot, "target")
const preset = resolve(workRoot, "preset")
const retainedEvidenceRoot = resolve(repoRoot, ".coder-loop", "evidence", "runner-filesystem-grants-integration", basename(workRoot))
const { CODER_LOOP_RUN_CRED: _parentRunCredential, ...operatorEnv } = process.env
const runnerFlagIndex = Bun.argv.indexOf("--runner")
const requestedRunner = runnerFlagIndex === -1 ? null : Bun.argv[runnerFlagIndex + 1]
if (requestedRunner !== null && !["claude", "codex", "opencode"].includes(requestedRunner)) throw new Error(`invalid --runner ${requestedRunner}`)
const SOCKET_WAIT_TIMEOUT_MS = 30_000
const RUNNER_WAIT_TIMEOUT_MS = 300_000
const DIAGNOSTIC_TAIL_CHARACTERS = 16_000

type RunnerEvidenceResult = {
	runner: string
	runIds: string[]
	nativeArgv: string
	outerProfiles: string[]
	statusFiles: string[]
	finalChainStatus: string
	positiveResults: string[]
	negativeResults: string[]
}

type CompletedEvidenceResult = {
	schema: 1
	outcome: "passed"
	runners: RunnerEvidenceResult[]
	events: string
	daemonLogs: string[]
	stateBefore: SqliteStateSnapshot
	stateAfter: SqliteStateSnapshot
	cleanup: {
		daemonExited: true
		socketRemoved: true
		worktreesReclaimed: true
	}
}

type SqliteCountRow = { count: number }

type SqliteStateSnapshot = {
	items: number
	runs: number
	doneItems: number
}

function command(args: readonly string[], cwd = repoRoot): string {
	const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", env: operatorEnv })
	if (result.status !== 0) throw new Error(`${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`)
	return result.stdout
}

function sqliteStateSnapshot(): SqliteStateSnapshot {
	const database = new Database(resolve(loopDataRoot, "db.sqlite"), { readonly: true })
	try {
		const items = database.query<SqliteCountRow, []>("SELECT COUNT(*) AS count FROM items").get()?.count ?? 0
		const runs = database.query<SqliteCountRow, []>("SELECT COUNT(*) AS count FROM runs").get()?.count ?? 0
		const doneItems = database.query<SqliteCountRow, []>("SELECT COUNT(*) AS count FROM items WHERE status = 'done'").get()?.count ?? 0
		return { items, runs, doneItems }
	} finally {
		database.close()
	}
}

function writeDeterministicRunnerShim(wrapper: string, runner: string, capturePath: string): void {
	writeFileSync(wrapper, `#!/usr/bin/env bun
import { appendFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const PROBE_ARGUMENTS_BEGIN = "RUNNER_PROBE_ARGUMENTS_BEGIN"
const PROBE_ARGUMENTS_END = "RUNNER_PROBE_ARGUMENTS_END"
function runnerPromptProbeArguments(args: readonly string[]): string[] {
	const prompts = args.filter((arg) => arg.includes(PROBE_ARGUMENTS_BEGIN) && arg.includes(PROBE_ARGUMENTS_END))
	if (prompts.length !== 1) throw new Error(\`expected one rendered probe argument declaration, observed \${prompts.length}\`)
	const declaration = prompts[0]!.split(PROBE_ARGUMENTS_BEGIN)[1]?.split(PROBE_ARGUMENTS_END)[0]
	const probeArguments = declaration?.trim().split("\\n") ?? []
	if (probeArguments.length !== 9 || probeArguments.some((argument) => argument.length === 0)) {
		throw new Error(\`expected nine non-empty rendered probe arguments, observed \${JSON.stringify(probeArguments)}\`)
	}
	return probeArguments
}
const args = Bun.argv.slice(2)
await appendFile(${JSON.stringify(capturePath)}, JSON.stringify(args) + "\\n")
const probeArguments = runnerPromptProbeArguments(args)
await writeFile(resolve(process.cwd(), "runner-filesystem-probe.args"), probeArguments.join("\\n") + "\\n")
const runner = ${JSON.stringify(runner)}
const sessionId = "deterministic-" + runner + "-session"
const sessionEvent = runner === "claude"
	? { type: "system", session_id: sessionId }
	: runner === "codex"
		? { type: "thread.started", thread_id: sessionId }
		: { type: "step_start", sessionID: sessionId }
process.stdout.write(JSON.stringify(sessionEvent) + "\\n")
const probe = Bun.spawn({ cmd: ["/bin/sh", resolve(process.cwd(), "runner-filesystem-probe.sh")], stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env })
process.exit(await probe.exited)
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

probe_config="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/runner-filesystem-probe.args"
set --
while IFS= read -r argument; do
	set -- "$@" "$argument"
done < "$probe_config"
rm -f "$probe_config"
if [ "$#" -ne 9 ]; then
	echo "expected nine driver-owned probe arguments, observed $#" >&2
	exit 1
fi

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
	writeFileSync(resolve(preset, "phase.md"), `Execute exactly this command once in a non-login shell without a PTY, without inspecting files or constructing a replacement command:\n\n/bin/sh {{AGENT_CWD}}/runner-filesystem-probe.sh\n\nThe script itself consumes the driver-owned task-private argument declaration, executes the required completion protocol, and prints the selected status. Do not retype or pass any of the declaration values. After it returns, do not query exits, do not write item status again, and do not run any other command; end the response immediately.\n\nRUNNER_PROBE_ARGUMENTS_BEGIN\n{{RUN_ID}}\n{{CHAIN_NAME}}\n{{PRESET_DIR}}\n{{SHARED_CONTEXT_FILE}}\n{{CURRENT_ISSUE_FILE}}\n{{EVIDENCE_DIR}}\n${loopDataRoot}/chains/{{CHAIN_NAME}}/undeclared.txt\n${loopDataRoot}/chains/undeclared-other/private.txt\n${loopDataRoot}/central.sqlite\nRUNNER_PROBE_ARGUMENTS_END\n`)
	writeFileSync(resolve(preset, "preset.toml"), `name = "runner-filesystem-grants-integration"\n[item]\nidField = "issue"\n[item.fields]\nissue = "number"\n[statuses]\nentry = "fresh"\ncontinuable = ["fresh", "queued"]\nterminal = ["done"]\nsuccess = ["done"]\nexhausted = "done"\n[[fragments]]\nid = "fixture"\nrole = "common"\npath = "fragment.md"\n[[phases]]\nname = "phase"\nprompt = "phase.md"\nroles = ["common"]\n[phases.variables]\nISSUE = "item.issue"\nCHAIN_NAME = "runtime.chainName"\nRUN_ID = "runtime.runId"\nAGENT_CWD = "runtime.agentCwd"\nPRESET_DIR = "runtime.presetDir"\nFRAGMENT_INDEX = "runtime.fragmentIndex"\nSHARED_CONTEXT_FILE = "runtime.sharedContextPath"\nCURRENT_ISSUE_FILE = "runtime.currentIssueFile"\nEVIDENCE_DIR = "runtime.evidenceDir"\n[[phases.exits]]\nstatus = "queued"\nwhen = "fresh invocation requests native resume"\n[[phases.exits]]\nstatus = "done"\nwhen = "resumed invocation completes fixture"\n`)
}

function retainedDiagnosticFiles(root: string): string[] {
	if (!existsSync(root)) return []
	const retainedNames = new Set(["daemon.log", "runner.argv", "status.json", "stdout.jsonl", "stderr.txt", "runner-authorization.json"])
	const pending = [root]
	const retained: string[] = []
	while (pending.length > 0) {
		const directory = pending.pop()
		if (directory === undefined) break
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name)
			if (entry.isDirectory()) pending.push(path)
			else if (entry.isFile() && retainedNames.has(entry.name)) retained.push(path)
		}
	}
	return retained.sort((left, right) => left.localeCompare(right))
}

function runnerTimeoutDiagnostics(chain: string | null, lastStatus: string): string {
	const chainRoot = chain === null ? loopDataRoot : resolve(loopDataRoot, "chains", chain)
	const sections = [`runner filesystem grants integration timeout diagnostics`, `workRoot=${workRoot}`, `chain=${chain ?? "<daemon-readiness>"}`, `lastChainStatus=${lastStatus}`]
	for (const path of retainedDiagnosticFiles(chainRoot)) {
		const size = statSync(path).size
		const content = readFileSync(path, "utf8")
		sections.push(`--- ${path} (${size} bytes) ---\n${content.slice(-DIAGNOSTIC_TAIL_CHARACTERS)}`)
	}
	return sections.join("\n")
}

async function waitForSocket(timeoutMs = SOCKET_WAIT_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastStatus = "daemon status not yet attempted"
	while (Date.now() < deadline) {
		const result = spawnSync("bun", [loopEntry, "daemon", "status", "--loop-data-root", loopDataRoot, "--json"], { encoding: "utf8" })
		if (result.status === 0) return
		lastStatus = `exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
		await Bun.sleep(100)
	}
	throw new Error(runnerTimeoutDiagnostics(null, lastStatus))
}

async function waitForRunner(chain: string, timeoutMs = RUNNER_WAIT_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let lastStatus = "chain status not yet attempted"
	while (Date.now() < deadline) {
		const result = spawnSync("bun", [loopEntry, "chain", "status", chain, "--loop-data-root", loopDataRoot, "--json"], { cwd: repoRoot, encoding: "utf8", env: operatorEnv })
		lastStatus = `exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
		if (result.status === 0) {
			const status: unknown = JSON.parse(result.stdout)
			if (typeof status === "object" && status !== null) {
				const chainStatus = Reflect.get(status, "chain")
				const summary = Reflect.get(status, "summary")
				if (typeof chainStatus === "object" && chainStatus !== null && Reflect.get(chainStatus, "status") === "completed"
					&& typeof summary === "object" && summary !== null) {
					const items = Reflect.get(summary, "items")
					if (typeof items === "object" && items !== null) {
						const byStatus = Reflect.get(items, "byStatus")
						if (typeof byStatus === "object" && byStatus !== null && Reflect.get(byStatus, "done") === 1) return
					}
				}
			}
		}
		await Bun.sleep(250)
	}
	throw new Error(runnerTimeoutDiagnostics(chain, lastStatus))
}

writeFixture()
mkdirSync(loopDataRoot, { recursive: true })
writeFileSync(resolve(loopDataRoot, "central.sqlite"), "root-secret\n")
const runners = ["claude", "codex", "opencode"].filter((candidate) => requestedRunner === null || candidate === requestedRunner)
const captureBin = resolve(workRoot, "capture-bin")
mkdirSync(captureBin, { recursive: true })
for (const runner of runners) {
	const invocationCapture = resolve(loopDataRoot, "chains", `filesystem-${runner}`, "evidence", "1", "runner.argv")
	writeDeterministicRunnerShim(resolve(captureBin, runner), runner, invocationCapture)
}
const driverEnv = { ...operatorEnv, PATH: `${captureBin}:${operatorEnv.PATH ?? ""}` }
const daemon = spawn("bun", [loopEntry, "daemon", "up", "--loop-data-root", loopDataRoot, "--scheduler-interval-ms", "100"], { cwd: repoRoot, stdio: "inherit", env: driverEnv })
let completed = false
const runnerResults: RunnerEvidenceResult[] = []
let stateBefore: SqliteStateSnapshot | null = null
let stateAfter: SqliteStateSnapshot | null = null
try {
	await waitForSocket()
	stateBefore = sqliteStateSnapshot()
	if (stateBefore.items !== 0 || stateBefore.runs !== 0 || stateBefore.doneItems !== 0) throw new Error(`unexpected initial SQLite state ${JSON.stringify(stateBefore)}`)
	mkdirSync(resolve(loopDataRoot, "chains", "undeclared-other"), { recursive: true })
	writeFileSync(resolve(loopDataRoot, "chains", "undeclared-other", "private.txt"), "other-chain-secret\n")
	for (const runner of runners) {
		const chain = `filesystem-${runner}`
		const invocationCapture = resolve(loopDataRoot, "chains", chain, "evidence", "1", "runner.argv")
		command(["bun", loopEntry, "chain", "create", chain, "--config-json", JSON.stringify({ repository: "local/fixture", baseBranch: "main", presetPath: preset }), "--loop-data-root", loopDataRoot])
		writeFileSync(resolve(loopDataRoot, "chains", chain, "undeclared.txt"), "same-chain-secret\n")
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
		const finalChainStatus = resolve(loopDataRoot, "chains", chain, "evidence", "1", "final-chain-status.json")
		writeFileSync(finalChainStatus, command(["bun", loopEntry, "chain", "status", chain, "--loop-data-root", loopDataRoot, "--json"]))
		const worktrees = resolve(loopDataRoot, "chains", chain, "worktrees")
		if (readdirSync(worktrees).length !== 0) throw new Error(`${runner}: run-owned worktree was not reclaimed`)
		runnerResults.push({
			runner,
			runIds,
			nativeArgv: relative(workRoot, invocationCapture),
			outerProfiles: outerEvidencePaths.map((path) => relative(workRoot, path)),
			statusFiles: runIds.map((runId) => relative(workRoot, resolve(loopDataRoot, "chains", chain, "runs", runId, "status.json"))),
			finalChainStatus: relative(workRoot, finalChainStatus),
			positiveResults: ["declared preset/shared/current-issue reads", "declared evidence writes", "linked-worktree commits", "credentialed fresh/resume transitions"],
			negativeResults: ["preset mutation denied", "undeclared same-chain reads/writes denied", "undeclared other-chain reads/writes denied", "root-level loop-data reads/writes denied", "negative sentinels unchanged"],
		})
		process.stdout.write(`${runner}: fresh/resume argv and outer profiles verified (${invocations.map((argv) => argv.length).join("/")} args; ${outerEvidencePaths.join(", ")})\n`)
	}
	stateAfter = sqliteStateSnapshot()
	if (stateAfter.items !== runners.length || stateAfter.runs !== runners.length * 2 || stateAfter.doneItems !== runners.length) {
		throw new Error(`unexpected final SQLite state ${JSON.stringify(stateAfter)}`)
	}
	process.stdout.write(`runner filesystem grants integration passed: ${runners.join(" ")}\n`)
	completed = true
} finally {
	spawnSync("bun", [loopEntry, "daemon", "down", "--loop-data-root", loopDataRoot], { encoding: "utf8", env: operatorEnv })
	if (daemon.exitCode === null) {
		daemon.kill("SIGTERM")
		await new Promise<void>((resolveClosed) => daemon.once("close", () => resolveClosed()))
	}
	const daemonSocket = resolve(loopDataRoot, "daemon.sock")
	if (completed && stateBefore !== null && stateAfter !== null && daemon.exitCode !== null && !existsSync(daemonSocket)) {
		const result: CompletedEvidenceResult = {
			schema: 1,
			outcome: "passed",
			runners: runnerResults,
			events: relative(workRoot, resolve(loopDataRoot, "events", "events.jsonl")),
			daemonLogs: retainedDiagnosticFiles(loopDataRoot)
				.filter((path) => basename(path) === "daemon.log")
				.map((path) => relative(workRoot, path)),
			stateBefore,
			stateAfter,
			cleanup: { daemonExited: true, socketRemoved: true, worktreesReclaimed: true },
		}
		writeFileSync(resolve(workRoot, "runner-filesystem-grants-integration-results.json"), `${JSON.stringify(result, null, 2)}\n`)
		mkdirSync(resolve(retainedEvidenceRoot, ".."), { recursive: true })
		cpSync(workRoot, retainedEvidenceRoot, { recursive: true, errorOnExist: true })
		rmSync(workRoot, { recursive: true, force: true })
		process.stdout.write(`runner-filesystem-grants-integration evidence retained at ${retainedEvidenceRoot}\n`)
	} else {
		process.stderr.write(`runner filesystem grants integration diagnostics retained at ${workRoot}\n`)
		if (completed) throw new Error(`runner filesystem grants integration cleanup incomplete: daemonExitCode=${daemon.exitCode} socketExists=${existsSync(daemonSocket)}`)
	}
}
