import { describe, expect, test } from "bun:test"

import {
	chmod,
	mkdir,
	readFile,
	rm,
	writeFile,
	homedir,
	dirname,
	resolve,
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
	agentSessionsPath,
	phaseDeclaredRuntimeBindingPaths,
	decideResume,
	detectHostRunner,
	extractErrorCode,
	isTransient5xx,
	normalizeQueueIssueId,
	parseSessionIdFromRunnerStream,
	spawnOneAttempt,
	createStreamTextState,
	TEST_ROOT,
	makeOptions,
} from "./helpers"

describe("small parsers", () => {
	test("runner filesystem grants project one declared surface model across runners", () => {
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/loop-data",
			agentCwd: "/runtime/loop-data/chains/c/worktrees/i",
			presetDir: "/runtime/loop-data/preset-materialized/p",
			sharedContextPath: "/runtime/loop-data/chains/c/shared.md",
			currentIssueFile: "/runtime/loop-data/chains/c/issues/1.md",
			evidenceDir: "/runtime/loop-data/chains/c/evidence/1",
			evidenceRootDir: "/runtime/loop-data/chains/c/evidence",
			issueDir: "/runtime/loop-data/chains/c/issues",
			logDir: "/runtime/loop-data/chains/c/runs",
			daemonSocketPath: "/runtime/loop-data/daemon.sock",
			declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
		})
		expect(authorization.surfaces).toContainEqual({ kind: "read-only-directory", channel: "preset", path: "/runtime/loop-data/preset-materialized/p" })
		expect(authorization.surfaces).toContainEqual({ kind: "system-device", channel: "null", path: "/dev/null" })
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ path: "/runtime/loop-data" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ path: "/dev" }))
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `session-${kind}` }] as const) {
				const plan = buildRunnerInvocation({ kind, binary: kind, extraArgs: [], model: null, source: "engine-builtin" }, "prompt", resume, authorization)
				const runnerScratch = resolve("/runtime/loop-data/chains/c/worktrees/i", ".coder-loop-runner", "tmp")
				const outerSandboxProfile = plan.args[1]
				if (outerSandboxProfile === undefined) throw new Error("runner invocation must include an outer sandbox profile")
				expect(plan.binary).toBe("/usr/bin/sandbox-exec")
				expect(plan.authorizationEvidence.outerSandboxProfile).toBe(outerSandboxProfile)
				expect(plan.authorizationEvidence.runner).toBe(kind)
				expect(plan.authorizationEvidence.surfaces).toContainEqual(expect.objectContaining({ kind: kind === "codex" ? "runner-runtime-file" : "runner-runtime-directory", runner: kind }))
				expect(plan.args[2]).toBe(kind)
				expect(plan.args.slice(2)).not.toContain("/runtime/loop-data")
				expect(plan.args).not.toContain("danger-full-access")
				expect(plan.args[1]).toContain("/runtime/loop-data/chains/c/evidence/1")
				expect(plan.args[1]).toContain(runnerScratch)
				expect(plan.args[1]).toContain('(literal "/dev/null")')
				expect(plan.args[1]).toContain('(subpath "/runtime/loop-data/daemon.sock")')
				expect(plan.args[1]).toContain('(allow file-read-metadata (literal "/runtime/loop-data/chains") (literal "/runtime/loop-data/chains/c") (literal "/runtime/loop-data/chains/c/worktrees"))')
				expect(plan.args[1]).not.toContain('(subpath "/dev")')
				expect(plan.args.slice(2)).not.toContain("/dev/null")
				expect(plan.args[1]).not.toContain("/private/tmp/claude-")
				expect(plan.environment.TMPDIR).toBe(runnerScratch)
				expect(plan.environment.TMP).toBe(runnerScratch)
				expect(plan.environment.TEMP).toBe(runnerScratch)
				expect(plan.environment.CLAUDE_CODE_TMPDIR).toBe(kind === "claude" ? runnerScratch : undefined)
				expect(plan.runtimeDirectories).toEqual([runnerScratch])
				if (resume.kind === "resume") expect(plan.args).toContain(`session-${kind}`)
				if (kind === "claude") {
					expect(plan.args[1]).toContain(resolve(homedir(), ".claude/projects"))
				}
				if (kind === "codex") {
					expect(plan.args).not.toContain("--sandbox")
					expect(plan.args).toContain("shell_environment_policy.inherit=all")
					for (const filename of [
						"installation_id",
						"models_cache.json",
						"logs_2.sqlite", "logs_2.sqlite-shm", "logs_2.sqlite-wal",
						"goals_1.sqlite", "goals_1.sqlite-shm", "goals_1.sqlite-wal",
						"memories_1.sqlite", "memories_1.sqlite-shm", "memories_1.sqlite-wal",
					]) {
						expect(plan.args[1]).toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), filename))
					}
					expect(plan.args[1]).toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "cache"))
					expect(plan.args[1]).not.toContain(resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "plugins"))
					expect(plan.args[1]).toContain("(allow system-socket)")
				}
				if (kind === "opencode") {
					expect(plan.args).toContain("--pure")
					const dirIndex = plan.args.indexOf("--dir")
					expect(dirIndex).toBeGreaterThan(-1)
					expect(plan.args[dirIndex + 1]).toBe("/runtime/loop-data/chains/c/worktrees/i")
					expect(plan.args[1]).toContain(resolve(homedir(), ".local/share/opencode"))
					expect(plan.args[1]).toContain(resolve(homedir(), ".local/state/opencode"))
				}
			}
		}
	})

	test("runner filesystem grants reject equal-root and ancestor tree grants while retaining literal cwd traversal", () => {
		const input = {
			loopDataRoot: "/runtime/loop-data",
			agentCwd: "/runtime/loop-data/chains/c/worktrees/i",
			presetDir: "/runtime/loop-data/preset-materialized/p",
			sharedContextPath: "/runtime/loop-data/chains/c/shared.md",
			currentIssueFile: "",
			evidenceDir: "/runtime/loop-data/chains/c/evidence/1",
			evidenceRootDir: "/runtime/loop-data/chains/c/evidence",
			issueDir: "/runtime/loop-data/chains/c/issues",
			logDir: "/runtime/loop-data/chains/c/runs",
			daemonSocketPath: "/runtime/loop-data/daemon.sock",
			declaredRuntimeBindingPaths: [] as const,
		}
		expect(() => buildRunnerFilesystemAuthorization({ ...input, presetDir: input.loopDataRoot })).toThrow("may not grant the loop-data root")
		expect(() => buildRunnerFilesystemAuthorization({ ...input, presetDir: "/runtime" })).toThrow("may not grant an ancestor of the loop-data root")
		const authorization = buildRunnerFilesystemAuthorization(input)
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: "/runtime/loop-data/chains" })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "metadata", path: "/runtime/loop-data/chains/c/worktrees" })
	})

	test("runner git metadata authorizes a real commit from a linked worktree", async () => {
		const root = resolve(TEST_ROOT, "runner-linked-worktree-git")
		const repository = resolve(root, "repository")
		const worktree = resolve(root, "worktree")
		const loopDataRoot = resolve(root, "loop-data")
		await rm(root, { recursive: true, force: true })
		await mkdir(repository, { recursive: true })
		const git = (cwd: string, args: readonly string[]) => Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
		expect(git(repository, ["init", "-b", "main"]).exitCode).toBe(0)
		await writeFile(resolve(repository, "README.md"), "base\n")
		expect(git(repository, ["add", "README.md"]).exitCode).toBe(0)
		expect(git(repository, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]).exitCode).toBe(0)
		expect(git(repository, ["worktree", "add", "-b", "linked", worktree]).exitCode).toBe(0)
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd: worktree, presetDir: resolve(root, "preset"), sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"),
			currentIssueFile: "", evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"), evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"),
			issueDir: resolve(loopDataRoot, "chains/c/issues"), logDir: resolve(loopDataRoot, "chains/c/runs"), daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
			declaredRuntimeBindingPaths: [],
		})
		expect(authorization.surfaces).toContainEqual(expect.objectContaining({ kind: "writable-directory", channel: "git-worktree-metadata" }))
		expect(authorization.surfaces).toContainEqual(expect.objectContaining({ kind: "writable-directory", channel: "git-common-dir" }))
		const plan = buildRunnerInvocation({ kind: "claude", binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", { kind: "fresh" }, authorization)
		const commit = Bun.spawnSync({
			cmd: ["/usr/bin/sandbox-exec", "-p", plan.authorizationEvidence.outerSandboxProfile, "/bin/sh", "-c", "printf linked > linked.txt && git add linked.txt && git -c user.name=fixture -c user.email=fixture@example.invalid commit -m linked"],
			cwd: worktree, stdout: "pipe", stderr: "pipe",
		})
		expect(commit.exitCode, new TextDecoder().decode(commit.stderr)).toBe(0)
		expect(git(worktree, ["rev-parse", "--verify", "HEAD"]).exitCode).toBe(0)
	})

	test("runner filesystem grants let Bun discover a nested task cwd without broad parent authority", async () => {
		const root = resolve(TEST_ROOT, "runner-bun-cwd-discovery")
		const loopDataRoot = resolve(root, "loop-data")
		const agentCwd = resolve(loopDataRoot, "chains", "c", "worktrees", "i")
		const presetDir = resolve(loopDataRoot, "preset-materialized", "p")
		const undeclared = resolve(loopDataRoot, "chains", "c", "undeclared.txt")
		await rm(root, { recursive: true, force: true })
		await Promise.all([agentCwd, presetDir].map((path) => mkdir(path, { recursive: true })))
		await writeFile(resolve(agentCwd, "package.json"), `${JSON.stringify({ scripts: { check: "node -e \"process.stdout.write('cwd-ok')\"" } })}\n`)
		await writeFile(undeclared, "private\n")
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd, presetDir, sharedContextPath: resolve(loopDataRoot, "chains/c/shared.md"),
			currentIssueFile: "", evidenceDir: resolve(loopDataRoot, "chains/c/evidence/1"), evidenceRootDir: resolve(loopDataRoot, "chains/c/evidence"),
			issueDir: resolve(loopDataRoot, "chains/c/issues"), logDir: resolve(loopDataRoot, "chains/c/runs"), daemonSocketPath: resolve(loopDataRoot, "daemon.sock"),
			declaredRuntimeBindingPaths: [],
		})
		const plan = buildRunnerInvocation({ kind: "codex", binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", { kind: "fresh" }, authorization)
		const profile = plan.authorizationEvidence.outerSandboxProfile
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: resolve(loopDataRoot, "chains") })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "entries", path: resolve(loopDataRoot, "chains", "c") })
		expect(authorization.surfaces).toContainEqual({ kind: "cwd-ancestor-directory", channel: "agent-cwd-discovery", access: "metadata", path: resolve(loopDataRoot, "chains", "c", "worktrees") })
		const bun = Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "run", "check"], cwd: agentCwd, stdout: "pipe", stderr: "pipe" })
		expect(bun.exitCode, new TextDecoder().decode(bun.stderr)).toBe(0)
		expect(new TextDecoder().decode(bun.stdout)).toContain("cwd-ok")
		expect(profile).toContain(`(allow file-read-data (literal "${resolve(loopDataRoot, "chains")}") (literal "${resolve(loopDataRoot, "chains", "c")}"))`)
		expect(profile).not.toContain(`(subpath "${resolve(loopDataRoot, "chains")}")`)
		expect(profile).not.toContain(`(subpath "${resolve(loopDataRoot, "chains", "c")}")`)
		const denied = Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/cat", undeclared], stdout: "pipe", stderr: "pipe" })
		expect(denied.exitCode).not.toBe(0)
	})

	test("runner filesystem grants deny undeclared writes and preserve every declared writable channel", async () => {
		const root = resolve(TEST_ROOT, "runner-filesystem-explicit-writes")
		const loopDataRoot = resolve(root, "loop-data")
		const agentCwd = resolve(root, "agent")
		const presetDir = resolve(root, "preset")
		const evidenceDir = resolve(loopDataRoot, "chains/c/evidence/1")
		const evidenceRootDir = resolve(loopDataRoot, "chains/c/evidence")
		const issueDir = resolve(loopDataRoot, "chains/c/issues")
		const logDir = resolve(loopDataRoot, "chains/c/runs")
		const sharedContextPath = resolve(loopDataRoot, "chains/c/shared.md")
		const currentIssueFile = resolve(issueDir, "1.md")
		const daemonSocketPath = resolve(loopDataRoot, "daemon.sock")
		const undeclared = resolve(root, "undeclared.txt")
		const undeclaredSameChain = resolve(loopDataRoot, "chains/c/undeclared.txt")
		const undeclaredOtherChain = resolve(loopDataRoot, "chains/other/private.txt")
		const undeclaredRoot = resolve(loopDataRoot, "central.sqlite")
		await rm(root, { recursive: true, force: true })
		await Promise.all([agentCwd, presetDir, evidenceDir, evidenceRootDir, issueDir, logDir].map((path) => mkdir(path, { recursive: true })))
		await mkdir(dirname(undeclaredOtherChain), { recursive: true })
		await Promise.all([sharedContextPath, currentIssueFile, daemonSocketPath, undeclared, undeclaredSameChain, undeclaredOtherChain, undeclaredRoot].map((path) => writeFile(path, "initial\n")))
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot, agentCwd, presetDir, sharedContextPath, currentIssueFile,
			evidenceDir, evidenceRootDir, issueDir, logDir, daemonSocketPath,
			declaredRuntimeBindingPaths: ["sharedContextPath", "currentIssueFile", "issueDir", "evidenceDir", "evidenceRootDir", "logDir"],
		})
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				const plan = buildRunnerInvocation({ kind, binary: "/usr/bin/true", extraArgs: [], model: null, source: "engine-builtin" }, "prompt", resume, authorization)
				const profile = plan.args[1]!
				const writeProbe = (path: string) => Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `printf allowed >> ${JSON.stringify(path)}`], stdout: "pipe", stderr: "pipe" })
				const readProbe = (path: string) => Bun.spawnSync({ cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", `cat ${JSON.stringify(path)}`], stdout: "pipe", stderr: "pipe" })
				for (const path of [
					resolve(agentCwd, `${kind}-${resume.kind}-agent.txt`), resolve(evidenceDir, `${kind}-${resume.kind}-evidence.txt`), resolve(evidenceRootDir, `${kind}-${resume.kind}-root.txt`),
					resolve(issueDir, `${kind}-${resume.kind}-issue.txt`), resolve(logDir, `${kind}-${resume.kind}-log.txt`), sharedContextPath, currentIssueFile, daemonSocketPath,
				]) expect(writeProbe(path).exitCode, `${kind}/${resume.kind}: ${path}`).toBe(0)
				expect(writeProbe("/dev/null").exitCode, `${kind}/${resume.kind}: /dev/null`).toBe(0)
				expect(writeProbe("/dev/zero").exitCode, `${kind}/${resume.kind}: /dev sibling`).not.toBe(0)
				expect(writeProbe(resolve(presetDir, `${kind}-${resume.kind}-forbidden.txt`)).exitCode, `${kind}/${resume.kind}: preset`).not.toBe(0)
				expect(writeProbe(undeclared).exitCode, `${kind}/${resume.kind}: undeclared`).not.toBe(0)
				for (const path of [undeclaredSameChain, undeclaredOtherChain, undeclaredRoot]) {
					expect(readProbe(path).exitCode, `${kind}/${resume.kind}: undeclared read ${path}`).not.toBe(0)
					expect(writeProbe(path).exitCode, `${kind}/${resume.kind}: undeclared write ${path}`).not.toBe(0)
				}
			}
		}
	})

	test("phase-scoped runner surfaces include only actually declared runtime binding paths", () => {
		const phase = makeOptions().preset.phases[0]!
		const declared = phaseDeclaredRuntimeBindingPaths({
			...phase,
			variables: [
				{ key: "EVIDENCE", source: { kind: "runtime", key: "evidenceDir" }, doc: null },
				{ key: "TRACE", source: { kind: "runtime", key: "traceFile" }, doc: null },
				{ key: "STATUS", source: { kind: "runtime", key: "statusVocabularyDoc" }, doc: null },
			],
		})
		expect(declared).toEqual(["evidenceDir", "logDir"])
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/root", agentCwd: "/repo", presetDir: "/preset", sharedContextPath: "/runtime/root/chains/c/shared.md",
			currentIssueFile: "/runtime/root/chains/c/issues/1.md", evidenceDir: "/runtime/root/chains/c/evidence/1", evidenceRootDir: "/runtime/root/chains/c/evidence",
			issueDir: "/runtime/root/chains/c/issues", logDir: "/runtime/root/chains/c/runs", daemonSocketPath: "/runtime/root/daemon.sock",
			declaredRuntimeBindingPaths: declared,
		})
		expect(authorization.surfaces).toContainEqual({ kind: "writable-directory", channel: "evidence", path: "/runtime/root/chains/c/evidence/1" })
		expect(authorization.surfaces).toContainEqual({ kind: "writable-directory", channel: "logs", path: "/runtime/root/chains/c/runs" })
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "shared-context" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "current-issue" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "issues" }))
		expect(authorization.surfaces).not.toContainEqual(expect.objectContaining({ channel: "evidence-root" }))
	})

	test("runner authorization metadata cannot widen projections", () => {
		const authorization = buildRunnerFilesystemAuthorization({
			loopDataRoot: "/runtime/root", agentCwd: "/repo", presetDir: "/preset", sharedContextPath: "/runtime/root/chains/c/shared.md",
			currentIssueFile: "", evidenceDir: "/runtime/root/chains/c/evidence/1", evidenceRootDir: "/runtime/root/chains/c/evidence",
			issueDir: "/runtime/root/chains/c/issues", logDir: "/runtime/root/chains/c/runs", daemonSocketPath: "/runtime/root/daemon.sock",
			declaredRuntimeBindingPaths: ["evidenceDir"],
		})
		const bypasses = [
			["--add-dir", "/runtime/root"], ["--add-dir=/runtime/root"], ["--sandbox", "danger-full-access"], ["--sandbox=danger-full-access"],
			["-s", "danger-full-access"], ["-sdanger-full-access"], ["--cd", "/runtime/root"], ["--cd=/runtime/root"], ["-C", "/runtime/root"], ["-C/runtime/root"],
			["--dir", "/runtime/root"], ["--dir=/runtime/root"], ["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"],
			["--dangerously-skip-permissions"], ["--dangerously-bypass-approvals-and-sandbox"],
		]
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				for (const extraArgs of bypasses) {
					expect(() => buildRunnerInvocation({ kind, binary: kind, extraArgs, model: null, source: "engine-builtin" }, "prompt", resume, authorization), `${kind}/${resume.kind}: ${extraArgs.join(" ")}`).toThrow("runner authorization metadata")
				}
			}
		}
	})

	test("runner projections reach the chain-complete spawn path for every runner and resume mode", async () => {
		const root = resolve(TEST_ROOT, "runner-chain-complete-projections")
		const options = makeOptions()
		const currentIssueFile = resolve(options.issueDir, "333.md")
		const unrelatedIssueFile = resolve(options.issueDir, "999.md")
		const evidenceDir = resolve(options.evidenceRootDir, "333")
		const unrelatedEvidenceDir = resolve(options.evidenceRootDir, "999")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		for (const kind of ["claude", "codex", "opencode"] as const) {
			for (const resume of [{ kind: "fresh" }, { kind: "resume", sessionId: `resume-${kind}` }] as const) {
				const capture = resolve(root, `${kind}-${resume.kind}.argv`)
				const runner = resolve(root, `${kind}-${resume.kind}.sh`)
				await writeFile(runner, `#!/bin/sh\nset -e\nprintf probe > /dev/null\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\n`)
				await chmod(runner, 0o755)
				const outputPath = resolve(root, `${kind}-${resume.kind}`, "phase", "stdout.jsonl")
				const outcome = await spawnOneAttempt({
					options, label: "phase", prompt: "projection-prompt", outputPath,
					sessionsPath: agentSessionsPath(outputPath), resume, agentCwd: root,
					runner: { kind, source: "preset", binary: runner, extraArgs: [], model: null },
					authorizationPaths: { currentIssueFile, evidenceDir },
					authorizationPhase: {
						variables: [
							{ key: "CURRENT_ISSUE", source: { kind: "runtime", key: "currentIssueFile" }, doc: null },
							{ key: "EVIDENCE", source: { kind: "runtime", key: "evidenceDir" }, doc: null },
						],
					},
				})
				expect(outcome.exitCode).toBe(0)
				const argv = await readFile(capture, "utf8")
				const authorization = await readFile(resolve(dirname(outputPath), "runner-authorization.json"), "utf8")
				expect(argv).toContain(resume.kind === "resume" ? `resume-${kind}` : "projection-prompt")
				expect(argv.split("\n")).not.toContain(TEST_ROOT)
				expect(authorization).toContain(`"channel":"current-issue","path":"${currentIssueFile}"`)
				expect(authorization).toContain(`"channel":"evidence","path":"${evidenceDir}"`)
				expect(authorization).not.toContain('"channel":"evidence-root"')
				expect(authorization).not.toContain('"path":"' + options.evidenceRootDir + '"')
				expect(authorization).not.toContain(unrelatedIssueFile)
				expect(authorization).not.toContain(unrelatedEvidenceDir)
				if (kind === "claude") {
					expect(argv).toContain(root)
					expect(argv).toContain(options.preset.presetDir)
					expect(argv).toContain(evidenceDir)
					expect(argv.split("\n")).not.toContain(options.evidenceRootDir)
					expect(argv).not.toContain(options.issueDir)
					expect(argv).not.toContain(options.logDir)
				}
				if (kind === "codex" && resume.kind === "fresh") {
					expect(argv).toContain(root)
					expect(argv).toContain(evidenceDir)
					expect(argv.split("\n")).not.toContain(options.evidenceRootDir)
					expect(argv).not.toContain(options.issueDir)
					expect(argv).not.toContain(options.logDir)
					expect(argv).not.toContain(options.preset.presetDir)
				}
			}
		}
		await rm(root, { recursive: true, force: true })
	})

	test("reports ordered chain-complete status persistence failure", async () => {
		const root = resolve(TEST_ROOT, "status-persistence-intermediate")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		const runner = resolve(root, "runner.sh")
		await writeFile(runner, "#!/bin/sh\necho intermediate\nsleep 0.05\necho 'FINALIZER SUMMARY: decision=complete; reason=test'\n")
		await chmod(runner, 0o755)
		const options = makeOptions()
		const failures: import("../../../src/loop").RunnerStatusPersistenceFailure[] = []
		options.onStatusPersistenceFailure = (failure) => failures.push(failure)
		let writes = 0
		const outputPath = resolve(root, "run-635", "umbrella-finalizer", "stdout.jsonl")
		await expect(spawnOneAttempt({
			options,
			label: "umbrella-finalizer",
			prompt: "test",
			outputPath,
			sessionsPath: resolve(root, "run-635", "umbrella-finalizer", "sessions.jsonl"),
			resume: { kind: "fresh" },
			agentCwd: root,
			runner: { kind: "claude", source: "preset", binary: runner, extraArgs: [], model: null },
			statusWriter: async (path, payload) => {
				writes += 1
				if (writes === 2) {
					await rm(path, { force: true })
					await mkdir(path)
				}
				await writeFile(path, payload)
			},
		})).rejects.toThrow(/chain-complete status-artifact persistence failed/)
		expect(writes).toBe(2)
		expect(failures).toHaveLength(1)
		expect(failures[0]).toMatchObject({ path: "chain-complete", stage: "status-artifact", runId: "run-635", phase: "umbrella-finalizer" })
	})

	test("rejects successful chain-complete decision when terminal status persistence fails", async () => {
		const root = resolve(TEST_ROOT, "status-persistence-terminal")
		await rm(root, { recursive: true, force: true })
		await mkdir(root, { recursive: true })
		const runner = resolve(root, "runner.sh")
		await writeFile(runner, "#!/bin/sh\nprintf 'FINALIZER SUMMARY: decision=complete; reason=test'\n")
		await chmod(runner, 0o755)
		const options = makeOptions()
		let writes = 0
		const outputPath = resolve(root, "run-635-terminal", "umbrella-finalizer", "stdout.jsonl")
		await expect(spawnOneAttempt({
			options,
			label: "umbrella-finalizer",
			prompt: "test",
			outputPath,
			sessionsPath: resolve(root, "run-635-terminal", "umbrella-finalizer", "sessions.jsonl"),
			resume: { kind: "fresh" },
			agentCwd: root,
			runner: { kind: "claude", source: "preset", binary: runner, extraArgs: [], model: null },
			statusWriter: async (path, payload) => {
				writes += 1
				if (writes === 3) {
					await rm(path, { force: true })
					await mkdir(path)
				}
				await writeFile(path, payload)
			},
		})).rejects.toThrow(/chain-complete status-artifact persistence failed/)
		expect(writes).toBe(3)
	})
	test("detects session id across streamed chunk boundaries", () => {
		const observed: { sessionId: string | null } = { sessionId: null }
		const state = createStreamTextState((line) => {
			observed.sessionId ??= parseSessionIdFromRunnerStream("codex", `${line}\n`)
		})
		for (const chunk of ["{\"type\":\"thread.star", "ted\",\"thread_", "id\":\"thread-streamed\"}\n"]) {
			state.observe(Buffer.from(chunk))
		}
		state.finish()
		expect(observed.sessionId).toBe("thread-streamed")
	})

	test("stream text state retains finalizer summary without retaining full history", () => {
		const observed: { finalizerSummary: string | null } = { finalizerSummary: null }
		const state = createStreamTextState((line) => {
			if (line.startsWith("FINALIZER SUMMARY:")) observed.finalizerSummary = line
		})
		const payload = Buffer.from(`${"runner output\n".repeat(200_000)}FINALIZER SUMMARY: decision=complete; reason=streamed\n`)
		for (let offset = 0; offset < payload.byteLength; offset += 8191) state.observe(payload.subarray(offset, offset + 8191))
		state.finish()
		expect(state.bytes()).toBe(payload.byteLength)
		expect(observed.finalizerSummary).toBe("FINALIZER SUMMARY: decision=complete; reason=streamed")
		expect(Object.keys(state).sort()).toEqual(["bytes", "finish", "observe", "pendingChars"])
	})

	test("detectHostRunner defaults to Codex inside Codex env and Claude otherwise", () => {
		expect(detectHostRunner({ CODEX_SHELL: "1" })).toBe("codex")
		expect(detectHostRunner({ CODEX_THREAD_ID: "thread" })).toBe("codex")
		expect(detectHostRunner({ CLAUDECODE: "1" })).toBe("claude")
		expect(detectHostRunner({})).toBe("claude")
	})

	test("normalizeQueueIssueId accepts local and cross-repo forms", () => {
		expect(normalizeQueueIssueId("#333")).toBe("333")
		expect(normalizeQueueIssueId("mouriya-s-lab/coder-loop#333")).toBe("333")
	})

	test("runner stream parsers extract sessions", () => {
		expect(parseSessionIdFromRunnerStream("claude", "{\"type\":\"system\",\"session_id\":\"sess-1\"}\n")).toBe("sess-1")
		expect(parseSessionIdFromRunnerStream("codex", "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}")).toBe("thread-1")
	})

	// #478 acceptance row 1: extractErrorCode must recognize account-level rate limit on
	// stdout JSONL (api_error_status:429 / error:rate_limit / "hit your session limit"
	// result text). Before #478 the W3 chain 35/37/38 incident saw extractErrorCode fall
	// through to stderr (which is empty on rate-limit) → returned "unclassified" →
	// decideResume went `fresh` → wasted the stored sessionId.
	test("extractErrorCode detects 429 in stdout JSONL (W3 fixture shape)", () => {
		const w3Stream = [
			`{"type":"system","session_id":"sess-1"}`,
			`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781713800,"rateLimitType":"five_hour"}}`,
			`{"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 1:30am (Asia/Tokyo)"}`,
		].join("\n")
		expect(extractErrorCode(w3Stream, "")).toMatch(/rate_limit/)
		// Synthetic assistant-shape (error:"rate_limit") also classified, not falling through to "unclassified".
		expect(extractErrorCode(`{"is_error":true,"error":"rate_limit"}`, "")).toMatch(/rate_limit/)
		// Non-rate-limit JSONL preserves the legacy path: extracts error.type from is_error events.
		expect(extractErrorCode(`{"type":"result","is_error":true,"error":{"type":"timeout"}}`, "")).toBe("timeout")
	})

	// #478 acceptance row 2: the rate-limit code returned above must pass isTransient5xx,
	// so decideResume routes the rejected run to `resume` with the stored sessionId
	// (not `fresh`, which would have wasted the conversation continuity).
	test("isTransient5xx accepts the rate-limit error code", () => {
		expect(isTransient5xx("rate_limit_429")).toBe(true)
		expect(isTransient5xx("RateLimited")).toBe(true)
		expect(isTransient5xx("500_http")).toBe(true)
		expect(isTransient5xx("unclassified")).toBe(false)
	})


	test("decideResume resumes interrupted or transient prior sessions only", () => {
		expect(decideResume(null)).toEqual({ kind: "fresh" })
		expect(decideResume({
			attempt: "a",
			runner: "codex",
			model: null,
			sessionId: "thread-clean",
			exitCode: 0,
			signal: null,
			terminated: { kind: "clean" },
			log: "stdout.jsonl",
		})).toEqual({ kind: "fresh" })
		expect(decideResume({
			attempt: "a",
			runner: "codex",
			model: null,
			sessionId: "thread-ok",
			exitCode: null,
			signal: "SIGTERM",
			terminated: { kind: "signal", name: "SIGTERM" },
			log: "stdout.jsonl",
		})).toEqual({ kind: "resume", sessionId: "thread-ok" })
	})
})

