import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")

type Scenario = {
	name: string
	checks: readonly string[]
	command: readonly string[]
}

const scenarios: readonly Scenario[] = [
	{ name: "closure identity, async Git, local base, reconciliation and failure containment", checks: ["C01", "C02", "C03", "C07", "C08", "C10", "C11"], command: ["bun", "test", "src/scheduler.worktree.integration.test.ts"] },
	{ name: "fixed-point reachability, par pins and repository serialization", checks: ["C05", "C06", "C10"], command: ["bun", "test", "src/closure-lifecycle.test.ts"] },
	{ name: "serialized consumption and session clearing", checks: ["C04", "C05", "C09"], command: ["bun", "test", "src/sqlite-state.test.ts", "--filter", "closure consumption rechecks"] },
	{ name: "no-origin doctor warning", checks: ["C02"], command: ["bun", "test", "src/install-commands.test.ts", "--filter", "no-origin repository"] },
]

async function run(command: readonly string[]): Promise<void> {
	await new Promise<void>((resolveRun, rejectRun) => {
		const child = spawn(command[0]!, command.slice(1), { cwd: REPO_ROOT, env: process.env, stdio: "inherit" })
		child.on("error", rejectRun)
		child.on("close", (code, signal) => {
			if (code === 0) resolveRun()
			else rejectRun(new Error(`${command.join(" ")} failed: code=${String(code)} signal=${String(signal)}`))
		})
	})
}

async function main(): Promise<void> {
	const fixtureId = randomUUID()
	const sourceSha = (await Bun.$`git rev-parse HEAD`.cwd(REPO_ROOT).quiet()).text().trim()
	console.log(JSON.stringify({ event: "issue-560.start", fixtureId, sourceSha, scenarios: scenarios.map((scenario) => ({ name: scenario.name, checks: scenario.checks })) }))
	for (const scenario of scenarios) {
		console.log(JSON.stringify({ event: "issue-560.scenario.start", fixtureId, name: scenario.name, checks: scenario.checks, command: scenario.command }))
		await run(scenario.command)
		console.log(JSON.stringify({ event: "issue-560.scenario.pass", fixtureId, name: scenario.name, checks: scenario.checks }))
	}
	if ((await Bun.$`rg -n ${"Bun\\.spawnSync"} src/scheduler.ts`.cwd(REPO_ROOT).quiet().nothrow()).exitCode === 0) throw new Error("C11 failed: synchronous Git remains in scheduler")
	console.log(JSON.stringify({ event: "issue-560.pass", fixtureId, sourceSha, checks: ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11"] }))
}

await main()
