#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { resolve } from "node:path"

import {
	assertTaskTreeSnapshot,
	collectReadyTaskLeaves,
	decideClosureDispatch,
	taskExecutionRoots,
	taskNodeTerminal,
	type ClosureSnapshot,
	type TaskLeafNodeSnapshot,
	type TaskNodeSnapshot,
	type TaskTreeSnapshot,
} from "../src/task-runtime"
import { loadPreset } from "../src/loop"

const REPO_ROOT = resolve(import.meta.dir, "..")
const LOOP_ENTRY = resolve(REPO_ROOT, "src/loop.ts")
const SOURCE_SHA = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()
const REAL_GIT = spawnSync("command", ["-v", "git"], { shell: true, encoding: "utf8" }).stdout.trim() || "/usr/bin/git"
const EVIDENCE_BASE = resolve(homedir(), ".coder-loop/loop-data/chains/v3-546-v2/evidence/698")

type CommandResult = { stdout: string; stderr: string; exitCode: number }
type JsonObject = Record<string, unknown>
type RunnerEvent = JsonObject & {
	type: string
	scenario: string
	item: string
	phase: string
	attempt: number
	at: number
}
type RunRow = {
	run_id: string
	item_id: number
	runtime_node_id: string
	phase: string
	started_at: number
	ended_at: number | null
	exit_code: number | null
}
type LeafRow = {
	runtime_node_id: string
	item_row_id: number
	phase: string
	state: "pending" | "completed" | "exhausted"
	source_par_node_id: string | null
}
type ItemRow = { id: number; item_id: string; status: string; attempts: number; extra: string; last_run_id: string | null }
type TransitionRow = {
	id: number
	source_run_id: string
	source_runtime_node_id: string
	target_runtime_node_id: string | null
	path_id: string
	exit_payload: string
	resolved_bindings: string
}
type ParRow = { runtime_node_id: string; pin_commit: string; max_concurrency: number | null; container_state: string; node_rowid: number }

type RuntimeLayout = {
	runtimeId: string
	runtimeRoot: string
	evidenceRoot: string
	transcript: string
	commandLog: string
	runnerLog: string
	gitLog: string
	controlRoot: string
	loopDataRoot: string
	dbFile: string
	repository: { path: string; origin: string; commit: string }
	presetsRoot: string
}
type RuntimeContext = RuntimeLayout & {
	env: NodeJS.ProcessEnv
	daemon: { child: ChildProcess; stdout: string; stderr: string }
}

let activeTranscript: string | null = null
let activeCommandLog: string | null = null
const runnerEventCache = new Map<string, RunnerEvent>()

function fail(message: string): never {
	throw new Error(message)
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) fail(message)
}

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asObject(value: unknown, label: string): JsonObject {
	assert(isJsonObject(value), `${label} is not an object`)
	return value
}

function parseJsonObject(text: string, label: string): JsonObject {
	return asObject(JSON.parse(text), label)
}

function log(id: string, message: string): void {
	const line = `${new Date().toISOString()} ${id} ${message}\n`
	if (activeTranscript !== null) writeFileSync(activeTranscript, line, { flag: "a" })
	process.stdout.write(line)
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra }
	delete env.CODER_LOOP_RUN_CRED
	delete env.CODER_LOOP_DATA_DIR
	return env
}

function command(
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean; record?: boolean } = {},
): CommandResult {
	const startedAt = Date.now()
	const result = spawnSync(args[0]!, args.slice(1), {
		cwd: options.cwd ?? REPO_ROOT,
		env: options.env ?? cleanEnvironment(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
	const observed = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 }
	if (activeCommandLog !== null && options.record !== false) {
		writeFileSync(activeCommandLog, `${JSON.stringify({
			at: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			cwd: options.cwd ?? REPO_ROOT,
			args,
			...observed,
		})}\n`, { flag: "a" })
	}
	if (observed.exitCode !== 0 && options.allowFail !== true) {
		fail(`${args.join(" ")} failed (${observed.exitCode}): ${observed.stderr || observed.stdout}`)
	}
	return observed
}

function cli(ctx: RuntimeContext, args: readonly string[], allowFail = false): CommandResult {
	return command(["bun", LOOP_ENTRY, ...args, "--loop-data-root", ctx.loopDataRoot], { env: ctx.env, allowFail })
}

async function until<T>(
	read: () => T,
	accepted: (value: T) => boolean,
	label: string,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let last: T | undefined
	while (Date.now() < deadline) {
		last = read()
		if (accepted(last)) return last
		await Bun.sleep(100)
	}
	fail(`timeout waiting for ${label}; last=${JSON.stringify(last)}`)
}

function writeEvidence(ctx: RuntimeContext, name: string, value: unknown): void {
	writeFileSync(resolve(ctx.evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`)
}

function dbAll<T>(ctx: RuntimeContext, sql: string, params: Record<string, string | number | null> = {}): T[] {
	const db = new Database(ctx.dbFile, { readonly: true })
	try {
		const namedParams = Object.fromEntries(
			Object.entries(params).map(([key, value]) => [key.startsWith("$") ? key : `$${key}`, value]),
		)
		return db.query<T, Record<string, string | number | null>>(sql).all(namedParams)
	} finally {
		db.close()
	}
}

function dbGet<T>(ctx: RuntimeContext, sql: string, params: Record<string, string | number | null> = {}): T | null {
	return dbAll<T>(ctx, sql, params)[0] ?? null
}

function itemRow(ctx: RuntimeContext, chain: string, item: string): ItemRow {
	const row = dbGet<ItemRow>(ctx, `SELECT items.id, items.item_id, items.status, items.attempts, items.extra, items.last_run_id
		FROM items INNER JOIN chains ON chains.id = items.chain_id
		WHERE chains.name = $chain AND items.item_id = $item`, { chain, item })
	assert(row !== null, `missing item ${chain}/${item}`)
	return row
}

function chainId(ctx: RuntimeContext, chain: string): number {
	const row = dbGet<{ id: number }>(ctx, "SELECT id FROM chains WHERE name = $chain", { chain })
	assert(row !== null, `missing chain ${chain}`)
	return row.id
}

function taskTree(ctx: RuntimeContext, chain: string): TaskTreeSnapshot {
	const result = parseJsonObject(cli(ctx, ["status", ctx.repository.path, "--json", "--chain", chain]).stdout, `status ${chain}`)
	return assertTaskTreeSnapshot(result.taskTree)
}

function leaves(node: TaskNodeSnapshot): TaskLeafNodeSnapshot[] {
	if (node.kind === "leaf") return [node]
	return node.children.flatMap(leaves)
}

function leafByPhase(tree: TaskTreeSnapshot, itemRowId: number, phase: string): TaskLeafNodeSnapshot {
	const leaf = leaves(tree.root).find((candidate) => candidate.closure.itemRowId === itemRowId && candidate.closure.phase === phase)
	assert(leaf !== undefined, `missing leaf item=${itemRowId} phase=${phase}`)
	return leaf
}

function activeClosureIds(tree: TaskTreeSnapshot): Set<string> {
	return new Set(tree.activeRuns.map((run) => run.closureId))
}

function readRunnerEvents(ctx: RuntimeContext): RunnerEvent[] {
	const files = dbAll<{ worktree_path: string }>(ctx, `SELECT DISTINCT worktree_path
		FROM task_closures
		WHERE worktree_path IS NOT NULL`)
		.map((row) => resolve(row.worktree_path, ".issue-698-events.jsonl"))
		.filter(existsSync)
	const observed = files.flatMap((file) => readFileSync(file, "utf8").split("\n"))
		.filter((line) => line.trim() !== "")
		.map((line) => asObject(JSON.parse(line), "runner event"))
		.map((event) => ({
			...event,
			type: String(event.type),
			scenario: String(event.scenario),
			item: String(event.item),
			phase: String(event.phase),
			attempt: Number(event.attempt),
			at: Number(event.at),
		}))
	for (const event of observed) runnerEventCache.set(JSON.stringify(event), event)
	return [...runnerEventCache.values()]
		.sort((left, right) => left.at - right.at)
}

function matchingEvents(ctx: RuntimeContext, input: Partial<Pick<RunnerEvent, "type" | "scenario" | "item" | "phase" | "attempt">>): RunnerEvent[] {
	return readRunnerEvents(ctx).filter((event) => Object.entries(input).every(([key, value]) => event[key] === value))
}

function markerPath(ctx: RuntimeContext, scenario: string, item: string, phase: string, label: string): string {
	const closure = dbGet<{ worktree_path: string }>(ctx, `SELECT task_closures.worktree_path
		FROM task_closures
		INNER JOIN items ON items.id = task_closures.item_row_id
		WHERE items.item_id = $item AND task_closures.phase = $phase
			AND task_closures.worktree_path IS NOT NULL
		ORDER BY task_closures.created_at DESC
		LIMIT 1`, { item, phase })
	assert(closure !== null, `runner worktree is not prepared for ${item}/${phase}`)
	const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-")
	return resolve(closure.worktree_path, `.${[scenario, item, phase, label].map(safe).join("--")}`)
}

function release(ctx: RuntimeContext, scenario: string, item: string, phase: string, label = "release"): void {
	writeFileSync(markerPath(ctx, scenario, item, phase, label), `${Date.now()}\n`)
}

function writePreset(ctx: RuntimeLayout, name: string, toml: string, prompts: Record<string, string>): string {
	const dir = resolve(ctx.presetsRoot, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(resolve(dir, "preset.toml"), toml)
	for (const [file, body] of Object.entries(prompts)) writeFileSync(resolve(dir, file), body)
	return dir
}

function phaseBlock(name: string): string {
	return `[[phases]]
name = "${name}"
prompt = "${name}.md"
runner = "claude"
[[phases.exits]]
status = "done"
when = "The fixture deliberately exercises a naked status write; typed task advancement still requires a committed task path."
[phases.variables]
CHAIN = "runtime.chainName"
ITEM = "item.fixtureId"
RUN = "runtime.runId"
`
}

function typedPreset(
	ctx: RuntimeLayout,
	name: string,
	phases: readonly string[],
	tasks: string,
	extraPrompts: Record<string, string> = {},
): string {
	const prompts = Object.fromEntries(phases.map((phase) => [
		`${phase}.md`,
		`FIXTURE scenario=${name} phase=${phase} chain={{CHAIN}} item={{ITEM}} run={{RUN}}\n`,
	]))
	return writePreset(ctx, name, `name = "${name}"
[item]
idField = "fixtureId"
[item.fields]
fixtureId = "string"
context = "json"
[statuses]
continuable = ["queued"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
exhausted = "exhausted"
${phases.map(phaseBlock).join("\n")}
${tasks}
`, { ...prompts, ...extraPrompts })
}

function writePresets(ctx: RuntimeLayout): Record<string, string> {
	const result: Record<string, string> = {}
	result.c01 = typedPreset(ctx, "c01", ["only"], `[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [{ id = "only", kind = "phase", phase = "only", paths = [{ id = "finish" }] }]
`)
	result.c03 = typedPreset(ctx, "c03", ["a", "b", "c"], `[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "a", kind = "phase", phase = "a", paths = [
    { id = "advance", target = "b", prompt = "b-successor.md", fields = { result = "string" }, bindings = { RESULT = "exit.result", ITEM_BINDING = "item.fixtureId", ROW_ID = "item.id", ITEM_STATUS = "item.status", AGENT_CWD = "item.agentCwd", ITEM_RUNNER = "item.runner", ITEM_PHASE = "item.phase", NESTED = "item.context.nested", CHAIN = "chain.fixtureChain" } },
    { id = "missing-external", target = "b", fields = { result = "string" }, bindings = { REQUIRED = "chain.absent" } }
  ] },
  { id = "b", kind = "phase", phase = "b", paths = [{ id = "advance-b", target = "c" }] },
  { id = "c", kind = "phase", phase = "c", paths = [{ id = "finish-c" }] }
]
`, {
		"b-successor.md": "SUCCESSOR result={{RESULT}} item={{ITEM_BINDING}} row={{ROW_ID}} status={{ITEM_STATUS}} cwd={{AGENT_CWD}} runner={{ITEM_RUNNER}} sourcePhase={{ITEM_PHASE}} nested={{NESTED}}\nFIXTURE scenario=c03 phase=b chain={{CHAIN}} item={{ITEM_BINDING}}\n",
	})
	result.c04 = typedPreset(ctx, "c04", ["a", "b", "c", "d", "e"], `[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [
  { id = "a", kind = "phase", phase = "a", paths = [{ id = "advance-a", target = "outer", prompt = "outer-successor.md", fields = { token = "string" }, bindings = { TOKEN = "exit.token", CHAIN = "chain.fixtureChain", ITEM = "item.fixtureId", RUN = "runtime.runId" } }] },
  { id = "outer", kind = "par", join = "drain", children = [
    { id = "b", kind = "phase", phase = "b", paths = [{ id = "finish-b" }] },
    { id = "inner", kind = "par", join = "drain", children = [
      { id = "c", kind = "phase", phase = "c", paths = [{ id = "finish-c" }] },
      { id = "d", kind = "phase", phase = "d", paths = [{ id = "finish-d" }] }
    ]}
  ]},
  { id = "e", kind = "phase", phase = "e", paths = [{ id = "finish-e" }] }
]
`, {
		"outer-successor.md": "OUTER token={{TOKEN}}\nFIXTURE scenario=c04 phase=container chain={{CHAIN}} item={{ITEM}} run={{RUN}}\n",
	})
	result.c08per = typedPreset(ctx, "c08per", ["p1", "p2", "p3"], `[tasks]
id = "root"
kind = "par"
join = "drain"
maxConcurrency = 2
completeStatus = "done"
children = [
 { id = "p1", kind = "phase", phase = "p1", paths = [{ id = "finish-p1" }] },
 { id = "p2", kind = "phase", phase = "p2", paths = [{ id = "finish-p2" }] },
 { id = "p3", kind = "phase", phase = "p3", paths = [{ id = "finish-p3" }] }
]
`)
	result.c08global = typedPreset(ctx, "c08global", ["only"], `[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [{ id = "only", kind = "phase", phase = "only", paths = [{ id = "finish" }] }]
`)
	result.c08unlimited = typedPreset(ctx, "c08unlimited", ["u1", "u2", "u3"], `[tasks]
id = "root"
kind = "par"
join = "drain"
completeStatus = "done"
children = [
 { id = "u1", kind = "phase", phase = "u1", paths = [{ id = "finish-u1" }] },
 { id = "u2", kind = "phase", phase = "u2", paths = [{ id = "finish-u2" }] },
 { id = "u3", kind = "phase", phase = "u3", paths = [{ id = "finish-u3" }] }
]
`)
	result.c09 = typedPreset(ctx, "c09", ["only"], `[tasks]
id = "root"
kind = "seq"
completeStatus = "done"
children = [{ id = "only", kind = "phase", phase = "only", paths = [{ id = "finish" }] }]
`)
	result.c10 = typedPreset(ctx, "c10", ["fail", "ok1", "ok2"], `[tasks]
id = "root"
kind = "par"
join = "drain"
completeStatus = "done"
children = [
 { id = "fail", kind = "phase", phase = "fail", paths = [{ id = "finish-fail" }] },
 { id = "ok1", kind = "phase", phase = "ok1", paths = [{ id = "finish-ok1" }] },
 { id = "ok2", kind = "phase", phase = "ok2", paths = [{ id = "finish-ok2" }] }
]
`)
	const legacyName = "c11"
	result.c11 = writePreset(ctx, legacyName, `name = "${legacyName}"
[item]
idField = "fixtureId"
[item.fields]
fixtureId = "string"
[statuses]
continuable = ["queued", "retry"]
terminal = ["done", "exhausted"]
success = ["done"]
entry = "queued"
retry = "retry"
exhausted = "exhausted"
[[phases]]
name = "iteration"
prompt = "iteration.md"
runner = "claude"
[phases.variables]
CHAIN = "runtime.chainName"
ITEM = "item.fixtureId"
RUN = "runtime.runId"
[[phases]]
name = "review"
prompt = "review.md"
runner = "claude"
[[phases.exits]]
status = "retry"
when = "Credential-bound retry to the first legacy phase."
[[phases.exits]]
status = "done"
when = "Credential-bound terminal completion."
[phases.variables]
CHAIN = "runtime.chainName"
ITEM = "item.fixtureId"
RUN = "runtime.runId"
`, {
		"iteration.md": "FIXTURE scenario=c11 phase=iteration chain={{CHAIN}} item={{ITEM}} run={{RUN}}\n",
		"review.md": "FIXTURE scenario=c11 phase=review chain={{CHAIN}} item={{ITEM}} run={{RUN}}\n",
	})
	return result
}

function writeShims(ctx: RuntimeLayout): string {
	const dir = resolve(ctx.runtimeRoot, "shims")
	mkdirSync(dir, { recursive: true })
	writeFileSync(resolve(dir, "coder-loop"), `#!/bin/sh\nexec bun ${JSON.stringify(LOOP_ENTRY)} "$@"\n`)
	writeFileSync(resolve(dir, "git"), `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(ctx.gitLog)}, JSON.stringify({ at: Date.now(), cwd: process.cwd(), argv }) + "\\n")
const result = spawnSync(${JSON.stringify(REAL_GIT)}, argv, { stdio: "inherit" })
process.exit(result.status ?? 1)
`)
	writeFileSync(resolve(dir, "claude"), `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, resolve } from "node:path"

const argv = process.argv.slice(2)
const promptIndex = argv.lastIndexOf("-p")
const prompt = promptIndex < 0 ? "" : argv[promptIndex + 1] ?? ""
const match = /FIXTURE scenario=([^ ]+) phase=([^ ]+) chain=([^ ]+) item=([^\\s]+)(?: run=([^\\s]+))?/.exec(prompt)
if (match === null) throw new Error("fixture metadata missing: " + prompt.slice(0, 400))
const scenario = match[1]
let phase = match[2]
const chain = match[3]
const item = match[4]
const discoverRun = () => {
  const listed = spawnSync("coder-loop", ["item", "list", chain, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (listed.status !== 0) throw new Error("item list failed while resolving run: " + (listed.stderr ?? ""))
  const selected = JSON.parse(listed.stdout).items.find((candidate) => candidate.itemId === item)
  if (selected?.lastRunId === null || selected?.lastRunId === undefined) throw new Error("active run missing for successor phase " + phase)
  return selected.lastRunId
}
let run = match[5] ?? discoverRun()
const safe = (value) => value.replace(/[^A-Za-z0-9._-]/g, "-")
const key = [scenario, item, phase].map(safe).join("--")
const countPath = resolve(process.cwd(), "." + key + ".count")
mkdirSync(dirname(countPath), { recursive: true })
let attempt = 1
try { attempt = Number(readFileSync(countPath, "utf8")) + 1 } catch {}
writeFileSync(countPath, String(attempt))
const event = (type, extra = {}) => appendFileSync(resolve(process.cwd(), ".issue-698-events.jsonl"), JSON.stringify({ type, scenario, item, phase, run, attempt, at: Date.now(), cwd: process.cwd(), argv, prompt, ...extra }) + "\\n")
const invoke = (args) => {
  const result = spawnSync("coder-loop", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}
if (scenario === "c04" && phase === "container") {
  const status = invoke(["chain", "status", chain, "--json"])
  if (status.exitCode !== 0) throw new Error("container successor status failed: " + status.stderr)
  const activeRuns = JSON.parse(status.stdout).activeRuns ?? []
  const currentRun = activeRuns.find((candidate) =>
    typeof candidate.worktreePath === "string"
      && basename(candidate.worktreePath) === basename(process.cwd())
  )
  if (currentRun === undefined) throw new Error("container successor could not resolve its active run")
  run = currentRun.runId
  const matches = ["b", "c", "d"].filter((candidate) =>
    invoke(["item", "exits", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", candidate, "--json"]).exitCode === 0
  )
  if (matches.length !== 1) throw new Error("container successor could not resolve its durable phase: " + JSON.stringify(matches))
  phase = matches[0]
}
const marker = (label) => resolve(process.cwd(), "." + [scenario, item, phase, label].map(safe).join("--"))
const wait = async (label) => {
  event("waiting", { label })
  while (!existsSync(marker(label))) await Bun.sleep(50)
}
const transition = (preferred) => {
  const queried = invoke(["item", "exits", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--json"])
  if (queried.exitCode !== 0) throw new Error("exits failed: " + queried.stderr)
  const packet = JSON.parse(queried.stdout)
  const paths = packet.exits.filter((entry) => entry.kind === "task-path")
  const selected = paths.find((entry) => entry.path === preferred) ?? paths[0]
  if (selected === undefined) throw new Error("no task path for " + phase)
  const payload = Object.fromEntries(selected.fields.map((field) => [field.name, field.type === "string" ? (scenario === "c03" && phase === "a" ? "ok {{UNDECLARED}}" : "ok") : field.type === "number" ? 1 : field.type === "boolean" ? true : {}]))
  const accepted = invoke(["item", "transition", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--path", selected.path, "--exit-json", JSON.stringify(payload), "--json"])
  event("transition", { path: selected.path, payload, result: accepted })
  if (accepted.exitCode !== 0) throw new Error("transition failed: " + accepted.stderr)
  return { selected, payload, accepted }
}

event("start")
if (scenario === "c03" && phase === "a" && attempt === 1) {
  const forged = invoke(["item", "transition", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", "b", "--path", "advance", "--exit-json", "{\\"result\\":\\"ok\\"}", "--json"])
  event("forged-attribution", { result: forged })
  const forgedExits = invoke(["item", "exits", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", "b", "--json"])
  event("forged-exits", { result: forgedExits })
  await wait("ack-forged")
  const negatives = [
    ["advance", "{}"],
    ["advance", "{\\"result\\":1}"],
    ["not-declared", "{}"],
    ["missing-external", "{\\"result\\":\\"ok\\"}"],
  ]
  for (let index = 0; index < negatives.length; index += 1) {
    const [path, payload] = negatives[index]
    const result = invoke(["item", "transition", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--path", path, "--exit-json", payload, "--json"])
    event("negative", { index, path, payload, result })
    await wait("ack-negative-" + index)
  }
  process.stdout.write("stdout cannot advance typed task state\\n")
  event("stdout-only")
  await wait("ack-stdout")
  const discovery = invoke(["item", "exits", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--json"])
  const naked = invoke(["item", "update", chain, "--issue", item, "--status", "done", "--json"])
  event("naked-status", { discovery, result: naked })
  await wait("hold-after-naked")
} else if (scenario === "c03" && phase === "a") {
  const committed = transition("advance")
  const exact = invoke(["item", "transition", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--path", committed.selected.path, "--exit-json", JSON.stringify(committed.payload), "--json"])
  const conflict = invoke(["item", "transition", chain, "--issue", item, "--agent-run-id", run, "--agent-phase", phase, "--path", committed.selected.path, "--exit-json", JSON.stringify({ result: "different" }), "--json"])
  event("replay", { exact, conflict })
} else if (scenario === "c04" || scenario === "c08per" || scenario === "c08global" || scenario === "c08unlimited" || scenario === "c09" || (scenario === "c10" && phase !== "fail")) {
  await wait("release")
  transition()
} else if (scenario === "c10" && phase === "fail") {
  event("intentional-failure")
  process.exitCode = 1
} else if (scenario === "c11" && phase === "iteration" && attempt === 1) {
  process.stdout.write(JSON.stringify({ type: "system", session_id: "c11-iteration-session" }) + "\\n")
  event("legacy-failure", { session: "c11-iteration-session" })
  process.exitCode = 1
} else if (scenario === "c11" && phase === "iteration" && attempt === 2) {
  process.stdout.write(JSON.stringify({ type: "system", session_id: "c11-iteration-session" }) + "\\n")
  event("legacy-implicit-success", { resumed: argv.includes("c11-iteration-session") })
} else if (scenario === "c11" && phase === "iteration") {
  event("legacy-post-retry-iteration", { resumed: argv.includes("c11-iteration-session") })
  await wait("review-session-persisted")
  process.stdout.write(JSON.stringify({ type: "system", session_id: "c11-iteration-session" }) + "\\n")
} else if (scenario === "c11" && phase === "review" && attempt === 1) {
  process.stdout.write(JSON.stringify({ type: "system", session_id: "c11-review-session" }) + "\\n")
  const result = invoke(["item", "update", chain, "--issue", item, "--status", "retry", "--json"])
  event("legacy-retry", { resumed: argv.includes("c11-review-session"), session: "c11-review-session", result })
  if (result.exitCode !== 0) throw new Error("legacy retry failed: " + result.stderr)
} else if (scenario === "c11" && phase === "review") {
  const result = invoke(["item", "update", chain, "--issue", item, "--status", "done", "--json"])
  event("legacy-terminal", { resumed: argv.includes("c11-review-session"), result })
  if (result.exitCode !== 0) throw new Error("legacy terminal failed: " + result.stderr)
} else {
  transition()
}
event("end", { exitCode: process.exitCode ?? 0 })
`)
	for (const name of ["coder-loop", "git", "claude"]) chmodSync(resolve(dir, name), 0o755)
	return dir
}

function prepareRepository(runtimeRoot: string): RuntimeLayout["repository"] {
	const origin = resolve(runtimeRoot, "origin.git")
	const seed = resolve(runtimeRoot, "seed")
	const repository = resolve(runtimeRoot, "repository")
	mkdirSync(seed, { recursive: true })
	command([REAL_GIT, "init", "-q", "--bare", origin], { record: false })
	command([REAL_GIT, "init", "-q", "-b", "main"], { cwd: seed, record: false })
	writeFileSync(resolve(seed, "README.md"), "issue 698 public runtime fixture\n")
	command([REAL_GIT, "add", "README.md"], { cwd: seed, record: false })
	command([
		REAL_GIT,
		"-c",
		"user.name=issue-698",
		"-c",
		"user.email=issue-698@invalid",
		"commit",
		"-qm",
		"seed issue 698 fixture",
	], { cwd: seed, record: false })
	command([REAL_GIT, "remote", "add", "origin", origin], { cwd: seed, record: false })
	command([REAL_GIT, "push", "-q", "-u", "origin", "main"], { cwd: seed, record: false })
	command([REAL_GIT, "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin, record: false })
	command([REAL_GIT, "clone", "-q", origin, repository], { record: false })
	const commit = command([REAL_GIT, "rev-parse", "HEAD"], { cwd: repository, record: false }).stdout.trim()
	assert(/^[0-9a-f]{40}$/.test(commit), `fixture commit is invalid: ${commit}`)
	command([REAL_GIT, "checkout", "-q", "--detach", commit], { cwd: repository, record: false })
	command([REAL_GIT, "branch", "-D", "main"], { cwd: repository, record: false })
	assert(command([REAL_GIT, "rev-parse", "--verify", "main^{commit}"], { cwd: repository, allowFail: true, record: false }).exitCode !== 0, "fixture unexpectedly retained a local main branch")
	assert(command([REAL_GIT, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: repository, record: false }).stdout.trim() === commit, "fixture lost origin/main")
	return { path: repository, origin, commit }
}

function prepareLayout(): RuntimeLayout {
	const runtimeId = randomUUID()
	const runtimeRoot = mkdtempSync(resolve(tmpdir(), "coder-loop-698-"))
	const evidenceRoot = resolve(EVIDENCE_BASE, `${SOURCE_SHA}-${runtimeId}`)
	mkdirSync(evidenceRoot, { recursive: true })
	const controlRoot = resolve(runtimeRoot, "control")
	const loopDataRoot = resolve(runtimeRoot, "loop-data")
	const presetsRoot = resolve(runtimeRoot, "presets")
	for (const path of [controlRoot, loopDataRoot, presetsRoot]) mkdirSync(path, { recursive: true })
	return {
		runtimeId,
		runtimeRoot,
		evidenceRoot,
		transcript: resolve(evidenceRoot, "transcript.log"),
		commandLog: resolve(evidenceRoot, "commands.jsonl"),
		runnerLog: resolve(evidenceRoot, "runner.jsonl"),
		gitLog: resolve(evidenceRoot, "git.jsonl"),
		controlRoot,
		loopDataRoot,
		dbFile: resolve(loopDataRoot, "db.sqlite"),
		repository: prepareRepository(runtimeRoot),
		presetsRoot,
	}
}

function startDaemon(layout: RuntimeLayout, shimDir: string): RuntimeContext {
	const stdout = resolve(layout.runtimeRoot, "daemon.stdout.log")
	const stderr = resolve(layout.runtimeRoot, "daemon.stderr.log")
	const out = openSync(stdout, "a")
	const err = openSync(stderr, "a")
	const env = cleanEnvironment({
		PATH: `${shimDir}:${process.env.PATH ?? ""}`,
		ISSUE698_RUNTIME_ID: layout.runtimeId,
	})
	const child = spawn("bun", [LOOP_ENTRY, "daemon", "up", "--loop-data-root", layout.loopDataRoot], {
		cwd: REPO_ROOT,
		env,
		stdio: ["ignore", out, err],
	})
	closeSync(out)
	closeSync(err)
	return { ...layout, env, daemon: { child, stdout, stderr } }
}

async function waitForDaemon(ctx: RuntimeContext): Promise<void> {
	await until(
		() => ({
			socket: existsSync(resolve(ctx.loopDataRoot, "daemon.sock")),
			status: cli(ctx, ["daemon", "status", "--json"], true),
			exitCode: ctx.daemon.child.exitCode,
		}),
		(value) => value.socket && value.status.exitCode === 0 && value.exitCode === null,
		"isolated daemon readiness",
	)
	log("C01", `daemon ready pid=${ctx.daemon.child.pid ?? "unknown"} socket=${resolve(ctx.loopDataRoot, "daemon.sock")}`)
}

function uniqueChain(ctx: RuntimeContext, suffix: string): string {
	return `i698-${ctx.runtimeId.slice(0, 8)}-${suffix}`
}

function createStagedChain(
	ctx: RuntimeContext,
	suffix: string,
	bindings: JsonObject = {},
): string {
	const chain = uniqueChain(ctx, suffix)
	const create = cli(ctx, [
		"chain",
		"create",
		chain,
		"--config-json",
		JSON.stringify({ repository: "issue-698/runtime-fixture", baseBranch: "main", fixtureChain: chain, ...bindings }),
		"--preset",
		"single-phase-example",
		"--json",
	])
	assert(parseJsonObject(create.stdout, `chain create ${chain}`).chain !== undefined, `chain ${chain} create response omitted chain`)
	return chain
}

function createUngatedChain(ctx: RuntimeContext, suffix: string, bindings: JsonObject = {}): string {
	const chain = uniqueChain(ctx, suffix)
	cli(ctx, [
		"chain",
		"create",
		chain,
		"--config-json",
		JSON.stringify({ repository: "issue-698/runtime-fixture", baseBranch: "main", fixtureChain: chain, ...bindings }),
		"--preset",
		"single-phase-example",
		"--json",
	])
	return chain
}

function addItem(
	ctx: RuntimeContext,
	presets: Readonly<Record<string, string>>,
	chain: string,
	item: string,
	preset: string,
	options: { attempts?: number; fields?: JsonObject; stage?: boolean } = {},
): ItemRow {
	const presetPath = presets[preset]
	assert(presetPath !== undefined, `missing preset ${preset}`)
	const args = [
		"item",
		"add",
		chain,
		"--issue",
		item,
		"--repo-cwd",
		ctx.repository.path,
		"--preset-path",
		presetPath,
		"--json",
	]
	if (options.attempts !== undefined) args.push("--attempts", String(options.attempts))
	const fields: JsonObject = { ...options.fields }
	if (options.stage === true) {
		fields.schedulerBackoff = {
			failureCount: 1,
			nextRunAt: Math.floor(Date.now() / 1_000) + 3_600,
		}
	}
	if (Object.keys(fields).length > 0) args.push("--field-json", JSON.stringify(fields))
	cli(ctx, args)
	return itemRow(ctx, chain, item)
}

async function resumeChain(ctx: RuntimeContext, chain: string): Promise<void> {
	if (chainStatus(ctx, chain) === "stopped") cli(ctx, ["chain", "resume", chain, "--json"])
	const items = dbAll<{ item_id: string; extra: string }>(ctx, `SELECT items.item_id, items.extra
		FROM items INNER JOIN chains ON chains.id = items.chain_id
		WHERE chains.name = $chain`, { chain })
	for (const item of items) {
		if (parseJsonObject(item.extra, `item ${item.item_id} extra`).schedulerBackoff === undefined) continue
		cli(ctx, [
			"item",
			"update",
			chain,
			"--issue",
			item.item_id,
			"--field-json",
			JSON.stringify({ schedulerBackoff: { failureCount: 1, nextRunAt: 1 } }),
			"--json",
		])
	}
}

function chainStatus(ctx: RuntimeContext, chain: string): string {
	const row = dbGet<{ status: string }>(ctx, "SELECT status FROM chains WHERE name = $chain", { chain })
	assert(row !== null, `missing chain ${chain}`)
	return row.status
}

function runRows(ctx: RuntimeContext, chain: string): RunRow[] {
	return dbAll<RunRow>(ctx, `SELECT runs.run_id, runs.item_id, runs.runtime_node_id, runs.phase,
		runs.started_at, runs.ended_at, runs.exit_code
		FROM runs INNER JOIN chains ON chains.id = runs.chain_id
		WHERE chains.name = $chain ORDER BY runs.id`, { chain })
}

function leafRows(ctx: RuntimeContext, chain: string): LeafRow[] {
	return dbAll<LeafRow>(ctx, `SELECT task_leaf_nodes.runtime_node_id, task_closures.item_row_id,
		task_closures.phase, task_leaf_nodes.state, task_closures.source_par_node_id
		FROM task_leaf_nodes
		INNER JOIN task_closures ON task_closures.closure_id = task_leaf_nodes.closure_id
		INNER JOIN items ON items.id = task_closures.item_row_id
		INNER JOIN chains ON chains.id = items.chain_id
		WHERE chains.name = $chain ORDER BY task_leaf_nodes.runtime_node_id`, { chain })
}

function transitionRows(ctx: RuntimeContext, chain: string): TransitionRow[] {
	return dbAll<TransitionRow>(ctx, `SELECT task_transitions.id, task_transitions.source_run_id, task_transitions.source_runtime_node_id,
		task_transitions.target_runtime_node_id, task_transitions.path_id,
		task_transitions.exit_payload, task_transitions.resolved_bindings
		FROM task_transitions
		INNER JOIN task_nodes ON task_nodes.runtime_node_id = task_transitions.source_runtime_node_id
		INNER JOIN chains ON chains.id = task_nodes.chain_id
		WHERE chains.name = $chain ORDER BY task_transitions.id`, { chain })
}

function parRows(ctx: RuntimeContext, chain: string): ParRow[] {
	return dbAll<ParRow>(ctx, `SELECT task_par_nodes.runtime_node_id, task_par_nodes.pin_commit,
		task_par_nodes.max_concurrency, task_par_nodes.container_state, task_nodes.rowid AS node_rowid
		FROM task_par_nodes
		INNER JOIN task_nodes ON task_nodes.runtime_node_id = task_par_nodes.runtime_node_id
		INNER JOIN chains ON chains.id = task_nodes.chain_id
		WHERE chains.name = $chain ORDER BY task_nodes.rowid`, { chain })
}

function schedulerBackoff(row: ItemRow): JsonObject | null {
	const extra = parseJsonObject(row.extra, `item ${row.item_id} extra`)
	const raw = extra.schedulerBackoff
	return raw === undefined ? null : asObject(raw, `item ${row.item_id} schedulerBackoff`)
}

function findTaskNode(node: TaskNodeSnapshot, definitionNodeId: string): TaskNodeSnapshot | null {
	if (node.identity.definitionNodeId === definitionNodeId) return node
	if (node.kind === "leaf") return null
	for (const child of node.children) {
		const found = findTaskNode(child, definitionNodeId)
		if (found !== null) return found
	}
	return null
}

function taskNodeContainsItem(node: TaskNodeSnapshot, itemRowId: number): boolean {
	if (node.kind === "leaf") return node.closure.itemRowId === itemRowId
	return node.children.some((child) => taskNodeContainsItem(child, itemRowId))
}

function itemTaskRoot(tree: TaskTreeSnapshot, itemRowId: number): TaskNodeSnapshot | null {
	return taskExecutionRoots(tree.root).find((root) => taskNodeContainsItem(root, itemRowId)) ?? null
}

function readyTaskLeaves(tree: TaskTreeSnapshot, activeClosureIds: ReadonlySet<string>): string[] {
	return taskExecutionRoots(tree.root).flatMap((root) => collectReadyTaskLeaves(root, activeClosureIds))
}

function gitEventOperation(event: JsonObject): string | null {
	const argv = event.argv
	if (!Array.isArray(argv) || !argv.every((entry) => typeof entry === "string")) return null
	if (argv[0] === "-C") return typeof argv[2] === "string" ? argv[2] : null
	return typeof argv[0] === "string" ? argv[0] : null
}

async function waitForRunnerEvent(
	ctx: RuntimeContext,
	input: Partial<Pick<RunnerEvent, "type" | "scenario" | "item" | "phase" | "attempt">>,
	timeoutMs = 30_000,
): Promise<RunnerEvent> {
	const events = await until(
		() => matchingEvents(ctx, input),
		(value) => value.length > 0,
		`runner event ${JSON.stringify(input)}`,
		timeoutMs,
	)
	return events.at(-1)!
}

async function waitForItemTaskCompletion(ctx: RuntimeContext, chain: string, itemRowId: number, timeoutMs = 30_000): Promise<void> {
	await until(
		() => taskTree(ctx, chain),
		(tree) => {
			const root = itemTaskRoot(tree, itemRowId)
			return root !== null && taskNodeTerminal(root)
		},
		`${chain} item ${itemRowId} task completion`,
		timeoutMs,
	)
}

function eventResult(event: RunnerEvent, key = "result"): CommandResult {
	const value = asObject(event[key], `runner event ${event.type}.${key}`)
	return {
		stdout: String(value.stdout ?? ""),
		stderr: String(value.stderr ?? ""),
		exitCode: Number(value.exitCode),
	}
}

function observabilityEvents(ctx: RuntimeContext, chain: string, type: string): JsonObject[] {
	const result = cli(ctx, ["logs", ctx.repository.path, "--json", "--chain", chain, "--type", type])
	const events = parseJsonObject(result.stdout, `${type} logs`).events
	assert(Array.isArray(events), `${type} logs omitted events`)
	return events.map((event, index) => asObject(event, `${type} event ${index}`))
}

async function runC01(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const chain = createStagedChain(ctx, "c01")
	chains.push(chain)
	const item = addItem(ctx, presets, chain, "c01-item", "c01", { stage: true })
	const tree = taskTree(ctx, chain)
	const ready = readyTaskLeaves(tree, activeClosureIds(tree))
	const c01Preset = presets.c01
	assert(c01Preset !== undefined, "C01 preset path is missing")
	const compiled = await loadPreset(c01Preset)
	const only = leafByPhase(tree, item.id, "only")
	assert(tree.root.identity.runtimeNodeId === `chain:${chainId(ctx, chain)}:tasks`, "C01 chain tree identity is not durable")
	assert(only.identity.definitionRef.kind === "preset", "C01 leaf definition is not preset-owned")
	assert(only.identity.definitionRef.contentIdentity === `sha256:${compiled.sourceHash}`, "C01 leaf definition identity does not match the exact compiled preset")
	assert(only.identity.definitionNodeId === "only", "C01 leaf definition node identity is not stable")
	assert(ready.length === 1, `C01 expected one ready leaf, got ${JSON.stringify(ready)}`)
	assert(ready[0] === only.identity.runtimeNodeId, "C01 initial ready identity is not the compiled entry leaf")
	assert(runRows(ctx, chain).length === 0, "C01 created a run before the public stop")
	cli(ctx, ["chain", "stop", chain, "--json"])
	assert(chainStatus(ctx, chain) === "stopped", "C01 public stop did not persist")
	assert(runRows(ctx, chain).length === 0, "C01 public stop observed an unexpected run")
	writeEvidence(ctx, "C01-public-instantiation.json", { chain, item, tree, ready, runs: [] })
	log("C01", `public add persisted tree=${tree.root.identity.runtimeNodeId} ready=${ready[0]} runs=0`)
	await resumeChain(ctx, chain)
	await waitForItemTaskCompletion(ctx, chain, item.id)
	assert(itemRow(ctx, chain, item.item_id).status === "done", "C01 item did not complete through its typed path")
}

async function runC02C03(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const chain = createStagedChain(ctx, "c03")
	chains.push(chain)
	const item = addItem(ctx, presets, chain, "c03-item", "c03", {
		fields: {
			id: "spoofed-id",
			status: "spoofed-status",
			agentCwd: "/spoofed/worktree",
			runner: "spoofed-runner",
			phase: "spoofed-phase",
			context: { nested: "declared-extra" },
		},
	})
	const initial = taskTree(ctx, chain)
	const a = leafByPhase(initial, item.id, "a")
	const b = leafByPhase(initial, item.id, "b")
	await resumeChain(ctx, chain)
	const forged = await waitForRunnerEvent(ctx, { type: "forged-attribution", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
	assert(eventResult(forged).exitCode !== 0, "C03 credential-bound runner forged another phase")
	const forgedExits = await waitForRunnerEvent(ctx, { type: "forged-exits", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
	assert(eventResult(forgedExits).exitCode !== 0, "C03 exit discovery selected paths from a claimed phase that the durable run does not own")
	const activeRun = runRows(ctx, chain).find((run) => run.phase === "a" && run.ended_at === null)
	assert(activeRun !== undefined, "C03 active A run disappeared before anonymous attribution check")
	const anonymous = cli(ctx, [
		"item",
		"transition",
		chain,
		"--issue",
		item.item_id,
		"--agent-run-id",
		activeRun.run_id,
		"--agent-phase",
		"a",
		"--path",
		"advance",
		"--exit-json",
		JSON.stringify({ result: "ok" }),
		"--json",
	], true)
	assert(anonymous.exitCode !== 0, "C03 anonymous operator forged an active task transition")
	assert(transitionRows(ctx, chain).length === 0, "C03 rejected attribution persisted a transition")
	release(ctx, "c03", item.item_id, "a", "ack-forged")

	for (let index = 0; index < 4; index += 1) {
		const event = await waitForRunnerEvent(ctx, { type: "negative", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
		const negatives = matchingEvents(ctx, { type: "negative", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
		const current = negatives[index] ?? event
		assert(eventResult(current).exitCode !== 0, `C02 invalid submission ${index} unexpectedly succeeded`)
		const tree = taskTree(ctx, chain)
		assert(leafByPhase(tree, item.id, "a").state === "pending", `C02 invalid submission ${index} completed A`)
		assert(leafByPhase(tree, item.id, "b").state === "pending", `C02 invalid submission ${index} changed B`)
		assert(
			!collectReadyTaskLeaves(tree.root, activeClosureIds(tree)).includes(b.identity.runtimeNodeId),
			`C02 invalid submission ${index} made B ready`,
		)
		assert(transitionRows(ctx, chain).length === 0, `C02 invalid submission ${index} persisted a transition`)
		release(ctx, "c03", item.item_id, "a", `ack-negative-${index}`)
		if (index < 3) {
			await until(
				() => matchingEvents(ctx, { type: "negative", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 }).length,
				(count) => count >= index + 2,
				`C02 invalid submission ${index + 1}`,
			)
		}
	}
	log("C02", "four invalid typed submissions rejected without tree mutation")

	await waitForRunnerEvent(ctx, { type: "stdout-only", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
	assert(transitionRows(ctx, chain).length === 0, "C03 stdout advanced the task tree")
	assert(leafByPhase(taskTree(ctx, chain), item.id, "a").state === "pending", "C03 stdout completed A")
	release(ctx, "c03", item.item_id, "a", "ack-stdout")
	const naked = await waitForRunnerEvent(ctx, { type: "naked-status", scenario: "c03", item: item.item_id, phase: "a", attempt: 1 })
	const discovery = eventResult(naked, "discovery")
	assert(discovery.exitCode === 0, `C03 task exit discovery failed: ${discovery.stderr}`)
	const discoveryPacket = parseJsonObject(discovery.stdout, "C03 task exit discovery")
	assert(Array.isArray(discoveryPacket.exits), "C03 task exit discovery omitted exits")
	const discoveredExits = discoveryPacket.exits.map((entry, index) => asObject(entry, `C03 discovered exit ${index}`))
	assert(
		discoveredExits.filter((exit) => exit.kind === "task-path").map((exit) => String(exit.path)).sort().join(",") === "advance,missing-external",
		"C03 task exit discovery did not expose the exact authored paths",
	)
	assert(discoveredExits.every((exit) => exit.kind !== "item-status"), "C03 authored task discovery advertised a rejected item-status exit")
	assert(Array.isArray(discoveryPacket.allowedStatuses) && discoveryPacket.allowedStatuses.length === 0, "C03 authored task discovery advertised writable statuses")
	assert(eventResult(naked).exitCode !== 0, "C03 naked status write bypassed the typed task transition path")
	assert(eventResult(naked).stderr.includes("item.transition"), "C03 naked status rejection did not direct the runner to item.transition")
	assert(itemRow(ctx, chain, item.item_id).status === "queued", "C03 rejected naked status write changed item status")
	const afterNaked = taskTree(ctx, chain)
	assert(leafByPhase(afterNaked, item.id, "a").state === "pending", "C03 naked status write completed A")
	assert(!collectReadyTaskLeaves(afterNaked.root, activeClosureIds(afterNaked)).includes(b.identity.runtimeNodeId), "C03 naked status write made B ready")
	assert(transitionRows(ctx, chain).length === 0, "C03 naked status write synthesized a transition")
	assert(String(naked.prompt).includes('kind: "task-path"'), "C03 spawned prompt omitted the task-path exit discriminator")
	assert(String(naked.prompt).includes("coder-loop item transition"), "C03 spawned prompt omitted the task transition writer")
	const admissionLogs = await until(
		() => cli(ctx, ["logs", ctx.repository.path, "--json", "--chain", chain, "--type", "item.status.write_admission"], true),
		(result) => {
			if (result.exitCode !== 0) return false
			const events = parseJsonObject(result.stdout, "C03 status admission logs").events
			if (!Array.isArray(events)) return false
			return events.some((entry, index) => {
				const event = asObject(entry, `C03 status admission event ${index}`)
				const payload = asObject(event.payload, `C03 status admission payload ${index}`)
				return payload.reason === "task-transition-required" && payload.outcome === "deny"
			})
		},
		"C03 task-transition-required audit",
	)
	assert(admissionLogs.exitCode === 0, "C03 task-transition-required audit query failed")
	release(ctx, "c03", item.item_id, "a", "hold-after-naked")

	const replay = await waitForRunnerEvent(ctx, { type: "replay", scenario: "c03", item: item.item_id, phase: "a", attempt: 2 })
	const exact = eventResult(replay, "exact")
	const conflict = eventResult(replay, "conflict")
	assert(exact.exitCode === 0, `C03 exact replay failed: ${exact.stderr}`)
	assert(conflict.exitCode !== 0, "C03 conflicting replay unexpectedly succeeded")
	const accepted = matchingEvents(ctx, { type: "transition", scenario: "c03", item: item.item_id, phase: "a", attempt: 2 }).at(-1)
	assert(accepted !== undefined, "C03 accepted transition event is missing")
	const firstPacket = parseJsonObject(eventResult(accepted).stdout, "C03 committed transition")
	const replayPacket = parseJsonObject(exact.stdout, "C03 replayed transition")
	const firstTransition = asObject(firstPacket.transition, "C03 first transition")
	const replayTransition = asObject(replayPacket.transition, "C03 replay transition")
	assert(firstTransition.id === replayTransition.id, "C03 exact replay returned a different transition identity")
	const transitions = transitionRows(ctx, chain)
	assert(transitions.length === 1, `C03 replay duplicated A transition: ${transitions.length}`)
	assert(transitions[0]?.source_runtime_node_id === a.identity.runtimeNodeId, "C03 transition source is not A")
	assert(transitions[0]?.target_runtime_node_id === b.identity.runtimeNodeId, "C03 transition target is not B")
	const authoritativeBindings = parseJsonObject(transitions[0]!.resolved_bindings, "C03 bindings")
	assert(authoritativeBindings.RESULT === "ok {{UNDECLARED}}", "C03 authoritative exit binding is missing")
	assert(authoritativeBindings.ITEM_BINDING === "c03-item", "C03 preset idField binding is not authoritative")
	assert(authoritativeBindings.ROW_ID === item.id, "C03 item.id binding used spoofed extra instead of the row identity")
	assert(authoritativeBindings.ITEM_STATUS === "queued", "C03 item.status binding used spoofed extra instead of the current status")
	assert(authoritativeBindings.ITEM_RUNNER === null, "C03 item.runner binding used spoofed extra instead of the current runner override")
	assert(authoritativeBindings.ITEM_PHASE === "a", "C03 item.phase binding used spoofed extra instead of the current phase")
	assert(authoritativeBindings.NESTED === "declared-extra", "C03 declared nested extra binding is missing")
	assert(
		typeof authoritativeBindings.AGENT_CWD === "string"
			&& typeof accepted.cwd === "string"
			&& realpathSync(authoritativeBindings.AGENT_CWD) === realpathSync(accepted.cwd),
		"C03 item.agentCwd binding differs from the source run worktree",
	)
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c03", item: item.item_id, phase: "b" })
	const successor = matchingEvents(ctx, { type: "start", scenario: "c03", item: item.item_id, phase: "b" }).at(-1)!
	assert(
		String(successor.prompt).includes(`SUCCESSOR result=ok {{UNDECLARED}} item=c03-item row=${item.id} status=queued cwd=${authoritativeBindings.AGENT_CWD} runner=null sourcePhase=a nested=declared-extra`),
		"C03 successor prompt did not consume authoritative resolved bindings as one-pass values",
	)
	const cStart = await waitForRunnerEvent(ctx, { type: "start", scenario: "c03", item: item.item_id, phase: "c" })
	await waitForItemTaskCompletion(ctx, chain, item.id)
	const finalTransitions = transitionRows(ctx, chain)
	assert(finalTransitions.length === 3, `C03 expected one transition per leaf, got ${finalTransitions.length}`)
	assert(finalTransitions.map((transition) => transition.path_id).join(",") === "advance,advance-b,finish-c", "C03 durable exit discovery did not follow the declared source nodes")
	assert(!String(cStart.prompt).includes("SUCCESSOR result=ok"), "C03 newer direct edge without a prompt reused a stale incoming edge prompt")
	assert(String(cStart.prompt).includes("FIXTURE scenario=c03 phase=c"), "C03 newer no-prompt edge did not restore the phase prompt")
	writeEvidence(ctx, "C02-C03-transitions.json", { chain, transitions: finalTransitions, runnerEvents: matchingEvents(ctx, { scenario: "c03", item: item.item_id }) })
	log("C03", `credential attribution enforced; runner exit/stdout/status preserved cursor; exact replay id=${String(firstTransition.id)}; successor=${b.identity.runtimeNodeId}`)
}

async function runC04C05C06C07(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const pureLeaf = leafByPhase(taskTree(ctx, chains[0]!), itemRow(ctx, chains[0]!, "c01-item").id, "only").closure
	const active: ClosureSnapshot = { ...pureLeaf, lifecycle: "active" }
	const suspended: ClosureSnapshot = { ...pureLeaf, lifecycle: "suspended" }
	const consumed: ClosureSnapshot = { ...pureLeaf, lifecycle: "consumed" }
	assert(decideClosureDispatch(null, false).kind === "create", "C06 absent closure decision is not create")
	assert(decideClosureDispatch(suspended, false).kind === "reopen", "C06 suspended closure decision is not reopen")
	assert(decideClosureDispatch(active, false).kind === "resume", "C06 active idle closure decision is not resume")
	assert(decideClosureDispatch(active, true).kind === "deny-active-live", "C06 active live closure decision is not deny")
	assert(decideClosureDispatch(consumed, false).kind === "never-spawn", "C06 consumed closure decision is not never-spawn")
	log("C06", "five-state closure dispatch ADT produced create/reopen/resume/deny/never-spawn")

	const gitBefore = existsSync(ctx.gitLog) ? readFileSync(ctx.gitLog, "utf8").split("\n").filter(Boolean).length : 0
	const chain = createStagedChain(ctx, "c04")
	chains.push(chain)
	const item = addItem(ctx, presets, chain, "c04-item", "c04")
	const pinnedTree = taskTree(ctx, chain)
	const pins = parRows(ctx, chain)
	assert(pins.length === 2, `C07 expected authored outer and inner par pins; got ${pins.length}`)
	assert(pins.every((row) => row.pin_commit === ctx.repository.commit), "C07 par pin differs from the exact local base commit")
	const pinLeaves = leaves(pinnedTree.root).filter((leaf) => leaf.closure.itemRowId === item.id)
	assert(pinLeaves.every((leaf) => leaf.closure.baseCommit === ctx.repository.commit), "C07 entry closure did not inherit its par pin")
	const outer = findTaskNode(pinnedTree.root, "outer")
	const inner = findTaskNode(pinnedTree.root, "inner")
	assert(outer?.kind === "par" && inner?.kind === "par", "C07 nested par nodes are missing")
	for (const phase of ["b"]) {
		assert(leafByPhase(pinnedTree, item.id, phase).closure.sourceParNodeId === outer.identity.runtimeNodeId, `C07 ${phase} source par is wrong`)
	}
	for (const phase of ["c", "d"]) {
		assert(leafByPhase(pinnedTree, item.id, phase).closure.sourceParNodeId === inner.identity.runtimeNodeId, `C07 ${phase} source par is wrong`)
	}
	const gitAfterLines = existsSync(ctx.gitLog) ? readFileSync(ctx.gitLog, "utf8").split("\n").filter(Boolean).slice(gitBefore) : []
	const gitAfter = gitAfterLines.map((line) => asObject(JSON.parse(line), "C07 git event"))
	const creationFetches = gitAfter.filter((event) => gitEventOperation(event) === "fetch")
	assert(creationFetches.length === 1, `C07 public tree creation expected one origin fetch, got ${creationFetches.length}`)
	const creationFetchArgv = creationFetches[0]?.argv
	assert(Array.isArray(creationFetchArgv) && creationFetchArgv.includes("origin") && creationFetchArgv.includes("main"), "C07 public tree fetch did not target origin/main")
	const gitAfterCreationOffset = gitBefore + gitAfterLines.length
	writeEvidence(ctx, "C07-pins.json", { chain, commit: ctx.repository.commit, pins, leaves: pinLeaves, git: gitAfter })
	log("C07", `persisted ${pins.length} par pins at ${ctx.repository.commit}; tree creation fetches=1`)

	await resumeChain(ctx, chain)
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c04", item: item.item_id, phase: "a" })
	release(ctx, "c04", item.item_id, "a")
	for (const phase of ["b", "c", "d"]) {
		const started = await waitForRunnerEvent(ctx, { type: "start", scenario: "c04", item: item.item_id, phase })
		assert(String(started.prompt).includes("OUTER token=ok"), `C03/C05 container edge prompt did not reach recursively ready ${phase}`)
	}
	const overlapTree = taskTree(ctx, chain)
	const structuralReady = readyTaskLeaves(overlapTree, new Set())
	const liveIds = new Set(overlapTree.activeRuns.map((run) => {
		const leaf = leaves(overlapTree.root).find((candidate) => candidate.closure.closureId === run.closureId)
		assert(leaf !== undefined, `C04 active closure ${run.closureId} has no leaf`)
		return leaf.identity.runtimeNodeId
	}))
	for (const phase of ["b", "c", "d"]) {
		const id = leafByPhase(overlapTree, item.id, phase).identity.runtimeNodeId
		assert(structuralReady.includes(id), `C05 ${phase} is not recursively ready`)
		assert(liveIds.has(id), `C05 recursively ready ${phase} did not spawn`)
	}
	assert(overlapTree.activeRuns.length === 3, `C04 same-repo par expected three live runs, got ${overlapTree.activeRuns.length}`)
	await Bun.sleep(1_200)
	const denied = await until(
		() => cli(ctx, ["logs", ctx.repository.path, "--json", "--chain", chain, "--type", "closure.dispatch_denied"], true),
		(result) => {
			if (result.exitCode !== 0) return false
			const events = parseJsonObject(result.stdout, "C06 logs").events
			return Array.isArray(events) && events.length > 0
		},
		"C06 closure.dispatch_denied audit",
	)
	const deniedEvents = parseJsonObject(denied.stdout, "C06 denied logs").events
	assert(Array.isArray(deniedEvents), "C06 denied logs omitted events")
	const deniedEvent = asObject(deniedEvents[0], "C06 denied event")
	assert(typeof deniedEvent.runtimeNodeId === "string" && typeof deniedEvent.definitionNodeId === "string", "C06 denial omitted durable task identity")
	assert(typeof deniedEvent.runId === "string", "C06 denial omitted live run identity")
	log("C06", `public audit carried run=${String(deniedEvent.runId)} node=${String(deniedEvent.runtimeNodeId)}`)

	const live = runRows(ctx, chain).filter((row) => row.ended_at === null && ["b", "c", "d"].includes(row.phase))
	assert(live.length === 3, `C04 durable overlap expected three live intervals, got ${live.length}`)
	const latestStart = Math.max(...live.map((row) => row.started_at))
	assert(live.every((row) => row.ended_at === null || row.ended_at >= latestStart), "C04 par intervals do not overlap")
	release(ctx, "c04", item.item_id, "b")
	const afterB = await until(
		() => taskTree(ctx, chain),
		(tree) => leafByPhase(tree, item.id, "b").state === "completed",
		"C05 b completion",
	)
	const afterBOuter = findTaskNode(afterB.root, "outer")
	assert(afterBOuter?.kind === "par" && afterBOuter.state === "open", "C05 outer drain completed while inner members were live")
	assert(matchingEvents(ctx, { type: "start", scenario: "c04", item: item.item_id, phase: "e" }).length === 0, "C05 seq successor e started after only b completed")
	release(ctx, "c04", item.item_id, "c")
	const afterC = await until(
		() => taskTree(ctx, chain),
		(tree) => leafByPhase(tree, item.id, "c").state === "completed",
		"C05 c completion",
	)
	const afterCInner = findTaskNode(afterC.root, "inner")
	const afterCOuter = findTaskNode(afterC.root, "outer")
	assert(afterCInner?.kind === "par" && afterCInner.state === "open", "C05 inner drain completed before d")
	assert(afterCOuter?.kind === "par" && afterCOuter.state === "open", "C05 outer drain completed before inner drain")
	assert(matchingEvents(ctx, { type: "start", scenario: "c04", item: item.item_id, phase: "e" }).length === 0, "C05 seq successor e started before d completed")
	const gitThroughDispatchLines = existsSync(ctx.gitLog)
		? readFileSync(ctx.gitLog, "utf8").split("\n").filter(Boolean).slice(gitAfterCreationOffset)
		: []
	const gitThroughDispatch = gitThroughDispatchLines.map((line) => asObject(JSON.parse(line), "C07 dispatch git event"))
	assert(
		gitThroughDispatch.every((event) => gitEventOperation(event) !== "fetch"),
		"C07 member dispatch performed a per-closure fetch after pins were persisted",
	)
	release(ctx, "c04", item.item_id, "d")
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c04", item: item.item_id, phase: "e" })
	const drained = taskTree(ctx, chain)
	const drainedInner = findTaskNode(drained.root, "inner")
	const drainedOuter = findTaskNode(drained.root, "outer")
	assert(drainedInner?.kind === "par" && drainedInner.state === "completed", "C05 inner par did not drain")
	assert(drainedOuter?.kind === "par" && drainedOuter.state === "completed", "C05 outer par did not drain")
	release(ctx, "c04", item.item_id, "e")
	await waitForItemTaskCompletion(ctx, chain, item.id)
	assert(readyTaskLeaves(taskTree(ctx, chain), new Set()).length === 0, "C05 complete item tree still has a ready leaf")
	writeEvidence(ctx, "C04-C07-overlap-drain.json", { chain, runs: runRows(ctx, chain), finalTree: taskTree(ctx, chain), deniedEvents, gitThroughDispatch })
	log("C04", "same-repository b/c/d intervals overlapped")
	log("C05", "nested inner/outer drain completed before seq successor e")
}

async function runC08(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const perChain = createStagedChain(ctx, "c08-per")
	chains.push(perChain)
	const perItem = addItem(ctx, presets, perChain, "c08-per-item", "c08per")
	await resumeChain(ctx, perChain)
	for (const phase of ["p1", "p2"]) await waitForRunnerEvent(ctx, { type: "start", scenario: "c08per", item: perItem.item_id, phase })
	await Bun.sleep(1_100)
	assert(matchingEvents(ctx, { type: "start", scenario: "c08per", item: perItem.item_id }).length === 2, "C08 per-par limit admitted a third live member")
	release(ctx, "c08per", perItem.item_id, "p1")
	release(ctx, "c08per", perItem.item_id, "p2")
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c08per", item: perItem.item_id, phase: "p3" })
	release(ctx, "c08per", perItem.item_id, "p3")
	await waitForItemTaskCompletion(ctx, perChain, perItem.id)

	const globalOne = createStagedChain(ctx, "c08-global-one", { maxConcurrency: 1 })
	const globalTwo = createStagedChain(ctx, "c08-global-two", { maxConcurrency: 1 })
	chains.push(globalOne, globalTwo)
	const globalOneItem = addItem(ctx, presets, globalOne, "c08-global-one", "c08global")
	const globalTwoItem = addItem(ctx, presets, globalTwo, "c08-global-two", "c08global")
	await resumeChain(ctx, globalOne)
	await resumeChain(ctx, globalTwo)
	const firstGlobal = await until(
		() => matchingEvents(ctx, { type: "start", scenario: "c08global" }),
		(events) => events.length === 1,
		"C08 first globally limited run",
	)
	await Bun.sleep(1_100)
	assert(matchingEvents(ctx, { type: "start", scenario: "c08global" }).length === 1, "C08 declared daemon-global limit admitted a second run")
	const firstItem = firstGlobal[0]!.item
	release(ctx, "c08global", firstItem, "only")
	const globalStarts = await until(
		() => matchingEvents(ctx, { type: "start", scenario: "c08global" }),
		(events) => events.length === 2,
		"C08 second globally limited run",
	)
	const secondItem = globalStarts.find((event) => event.item !== firstItem)?.item
	assert(secondItem !== undefined, "C08 global limit never released the second chain")
	release(ctx, "c08global", secondItem, "only")
	await waitForItemTaskCompletion(ctx, globalOne, globalOneItem.id)
	await waitForItemTaskCompletion(ctx, globalTwo, globalTwoItem.id)

	const unlimitedChain = createStagedChain(ctx, "c08-unlimited")
	chains.push(unlimitedChain)
	const unlimitedItem = addItem(ctx, presets, unlimitedChain, "c08-unlimited", "c08unlimited")
	await resumeChain(ctx, unlimitedChain)
	for (const phase of ["u1", "u2", "u3"]) await waitForRunnerEvent(ctx, { type: "start", scenario: "c08unlimited", item: unlimitedItem.item_id, phase })
	assert(taskTree(ctx, unlimitedChain).activeRuns.length === 3, "C08 absence of global limit imposed an engine cap")
	for (const phase of ["u1", "u2", "u3"]) release(ctx, "c08unlimited", unlimitedItem.item_id, phase)
	await waitForItemTaskCompletion(ctx, unlimitedChain, unlimitedItem.id)
	writeEvidence(ctx, "C08-limits.json", {
		perPar: runRows(ctx, perChain),
		global: [runRows(ctx, globalOne), runRows(ctx, globalTwo)],
		unlimited: runRows(ctx, unlimitedChain),
	})
	log("C08", "observed per-par=2, declared daemon-global=1, and undeclared global=3")
	void globalOneItem
	void globalTwoItem
}

async function runC09(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const chain = createStagedChain(ctx, "c09")
	chains.push(chain)
	const anchor = addItem(ctx, presets, chain, "c09-anchor", "c09")
	const dependent = addItem(ctx, presets, chain, "c09-dependent", "c09", { fields: { dependsOn: [anchor.id] } })
	const terminalProbe = addItem(ctx, presets, chain, "c09-terminal-probe", "c09")
	await resumeChain(ctx, chain)
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c09", item: anchor.item_id, phase: "only" })
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c09", item: terminalProbe.item_id, phase: "only" })
	await Bun.sleep(1_100)
	assert(matchingEvents(ctx, { type: "start", scenario: "c09", item: dependent.item_id }).length === 0, "C09 dependent leaf spawned before declared success")
	release(ctx, "c09", terminalProbe.item_id, "only")
	await until(
		() => ({ row: itemRow(ctx, chain, terminalProbe.item_id), tree: taskTree(ctx, chain) }),
		(value) => value.row.status === "done" && leafByPhase(value.tree, terminalProbe.id, "only").state === "completed",
		"C09 terminal probe completion",
	)
	cli(ctx, [
		"item",
		"update",
		chain,
		"--issue",
		terminalProbe.item_id,
		"--field-json",
		JSON.stringify({ dependsOn: [anchor.id] }),
		"--json",
	])
	release(ctx, "c09", anchor.item_id, "only")
	await waitForRunnerEvent(ctx, { type: "start", scenario: "c09", item: dependent.item_id, phase: "only" })
	const preservedTerminal = await until(
		() => ({
			row: itemRow(ctx, chain, terminalProbe.item_id),
			tree: taskTree(ctx, chain),
			starts: matchingEvents(ctx, { type: "start", scenario: "c09", item: terminalProbe.item_id, phase: "only" }),
		}),
		(value) => parseJsonObject(value.row.extra, "C09 terminal probe extra").dependsOn === undefined,
		"C09 terminal probe satisfied dependency cleanup",
	)
	assert(preservedTerminal.row.status === "done", "C09 satisfied dependency reactivated an already-terminal item")
	assert(leafByPhase(preservedTerminal.tree, terminalProbe.id, "only").state === "completed", "C09 satisfied dependency reopened an already-completed leaf")
	assert(preservedTerminal.starts.length === 1, "C09 already-terminal item spawned a second run")
	const terminalProbeUnblocks = observabilityEvents(ctx, chain, "item.dependency_unblocked")
		.filter((event) => asObject(event.payload, "C09 dependency-unblocked payload").rowId === terminalProbe.id)
	assert(terminalProbeUnblocks.length === 0, "C09 already-terminal item emitted a reactivation event")
	release(ctx, "c09", dependent.item_id, "only")
	await waitForItemTaskCompletion(ctx, chain, anchor.id)
	await waitForItemTaskCompletion(ctx, chain, dependent.id)

	const cycleChain = createUngatedChain(ctx, "c09-cycle")
	chains.push(cycleChain)
	const first = addItem(ctx, presets, cycleChain, "c09-cycle-a", "c09", { stage: true })
	const second = addItem(ctx, presets, cycleChain, "c09-cycle-b", "c09", { fields: { dependsOn: [first.id] }, stage: true })
	const before = itemRow(ctx, cycleChain, first.item_id).extra
	const rejected = cli(ctx, [
		"item",
		"update",
		cycleChain,
		"--issue",
		first.item_id,
		"--field-json",
		JSON.stringify({ dependsOn: [second.id] }),
		"--json",
	], true)
	assert(rejected.exitCode !== 0, "C09 public cycle write unexpectedly succeeded")
	assert(itemRow(ctx, cycleChain, first.item_id).extra === before, "C09 rejected cycle changed persistence")
	assert(runRows(ctx, cycleChain).length === 0, "C09 cycle fixture dispatched before rejection")
	writeEvidence(ctx, "C09-dependencies.json", {
		runs: runRows(ctx, chain),
		terminalProbe: preservedTerminal,
		cycle: { before: JSON.parse(before), rejected },
	})
	log("C09", "dependency stayed orthogonal to structure; terminal leaf was not reactivated; cycle rejected with persistence unchanged")
}

async function runC10(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const chain = createStagedChain(ctx, "c10")
	chains.push(chain)
	const item = addItem(ctx, presets, chain, "c10-item", "c10", { attempts: 19 })
	await resumeChain(ctx, chain)
	for (const phase of ["fail", "ok1", "ok2"]) await waitForRunnerEvent(ctx, { type: "start", scenario: "c10", item: item.item_id, phase })
	await until(
		() => ({ row: itemRow(ctx, chain, item.item_id), runs: runRows(ctx, chain) }),
		(value) => value.row.attempts === 20 && value.runs.some((run) => run.phase === "fail" && run.ended_at !== null && run.exit_code === 1),
		"C10 failed leaf backoff",
	)
	const whileSiblingsLive = itemRow(ctx, chain, item.item_id)
	const backoff = schedulerBackoff(whileSiblingsLive)
	assert(backoff !== null && Number(backoff.failureCount) === 1, "C10 failed leaf did not persist backoff at attempt 20")
	assert(taskTree(ctx, chain).activeRuns.length === 2, "C10 successful siblings were not kept live after one failure")
	assert(leafByPhase(taskTree(ctx, chain), item.id, "fail").state === "pending", "C10 failed member exhausted while siblings were live")
	release(ctx, "c10", item.item_id, "ok1")
	const afterSiblingSuccess = await until(
		() => ({ row: itemRow(ctx, chain, item.item_id), tree: taskTree(ctx, chain), runs: runRows(ctx, chain) }),
		(value) => value.tree.activeRuns.length === 1
			&& value.runs.some((run) => run.phase === "ok1" && run.ended_at !== null && run.exit_code === 0),
		"C10 first successful sibling completion",
	)
	const preservedBackoff = schedulerBackoff(afterSiblingSuccess.row)
	assert(
		preservedBackoff !== null
			&& preservedBackoff.failureCount === backoff.failureCount
			&& preservedBackoff.nextRunAt === backoff.nextRunAt,
		"C10 successful sibling cleared or replaced the failed leaf backoff",
	)
	assert(afterSiblingSuccess.runs.filter((run) => run.phase === "fail").length === 1, "C10 failed leaf respawned while another sibling was live")
	release(ctx, "c10", item.item_id, "ok2")
	await until(
		() => ({ row: itemRow(ctx, chain, item.item_id), tree: taskTree(ctx, chain) }),
		(value) => value.row.status === "exhausted" && leafByPhase(value.tree, item.id, "fail").state === "exhausted",
		"C10 leaf-scoped exhaustion",
	)
	const finalTree = taskTree(ctx, chain)
	assert(leafByPhase(finalTree, item.id, "ok1").state === "completed", "C10 ok1 did not complete")
	assert(leafByPhase(finalTree, item.id, "ok2").state === "completed", "C10 ok2 did not complete")
	const completedItemRoot = itemTaskRoot(finalTree, item.id)
	assert(completedItemRoot?.kind === "par" && completedItemRoot.state === "completed", "C10 drain did not complete after terminal siblings")
	await waitForItemTaskCompletion(ctx, chain, item.id)
	const persistedLeaves = leafRows(ctx, chain)
	const finalRuns = runRows(ctx, chain)
	assert(finalRuns.length === 3, `C10 expected exactly three member runs, got ${finalRuns.length}`)
	assert(finalRuns.filter((run) => run.phase === "fail").length === 1, "C10 failed leaf ran more than once before exhaustion")
	assert(persistedLeaves.filter((leaf) => leaf.state === "exhausted").map((leaf) => leaf.phase).join(",") === "fail", "C10 persistence exhausted more than the failed leaf")
	writeEvidence(ctx, "C10-exhaustion.json", { whileSiblingsLive, afterSiblingSuccess, backoff, preservedBackoff, runs: finalRuns, persistedLeaves, finalTree })
	log("C10", "attempt=20/backoff survived sibling success; failed leaf ran once; only failed leaf exhausted; drain completed")
}

async function runC11(ctx: RuntimeContext, presets: Readonly<Record<string, string>>, chains: string[]): Promise<void> {
	const chain = createStagedChain(ctx, "c11")
	chains.push(chain)
	const item = addItem(ctx, presets, chain, "c11-item", "c11")
	await resumeChain(ctx, chain)
	await waitForRunnerEvent(ctx, { type: "legacy-failure", scenario: "c11", item: item.item_id, phase: "iteration", attempt: 1 })
	const firstFailure = await until(
		() => ({ row: itemRow(ctx, chain, item.item_id), runs: runRows(ctx, chain) }),
		(value) => value.runs.some((run) => run.phase === "iteration" && run.exit_code === 1 && run.ended_at !== null) && schedulerBackoff(value.row) !== null,
		"C11 first failure persistence",
	)
	const firstRun = firstFailure.runs.find((run) => run.phase === "iteration")!
	const firstBackoff = schedulerBackoff(firstFailure.row)!
	assert(Number(firstBackoff.nextRunAt) - Number(firstRun.ended_at) === 60, "C11 did not persist the declared 60-second scheduler retry delay")
	const iterationSession = dbGet<{ session_id: string }>(ctx, `SELECT closure_sessions.session_id
		FROM closure_sessions
		INNER JOIN task_closures ON task_closures.closure_id = closure_sessions.closure_id
		INNER JOIN items ON items.id = task_closures.item_row_id
		INNER JOIN chains ON chains.id = items.chain_id
		WHERE chains.name = $chain AND task_closures.phase = 'iteration'`, { chain })
	assert(iterationSession?.session_id === "c11-iteration-session", "C11 failed run session was not persisted")
	log("C11", `failure persisted attempts=${firstFailure.row.attempts} backoff=60s session=${iterationSession.session_id}`)

	const firstSuccess = await waitForRunnerEvent(ctx, { type: "legacy-implicit-success", scenario: "c11", item: item.item_id, phase: "iteration", attempt: 2 }, 75_000)
	assert(firstSuccess.resumed === true, "C11 successful iteration did not resume the persisted session")
	const retry = await waitForRunnerEvent(ctx, { type: "legacy-retry", scenario: "c11", item: item.item_id, phase: "review", attempt: 1 })
	assert(retry.resumed === false, "C11 first review unexpectedly resumed a session")
	assert(eventResult(retry).exitCode === 0, `C11 review retry status failed: ${eventResult(retry).stderr}`)
	const postRetryIteration = await waitForRunnerEvent(ctx, { type: "legacy-post-retry-iteration", scenario: "c11", item: item.item_id, phase: "iteration", attempt: 3 })
	assert(postRetryIteration.resumed === true, "C11 post-review iteration did not preserve its session")
	const reviewSession = await until(
		() => dbGet<{ session_id: string }>(ctx, `SELECT closure_sessions.session_id
			FROM closure_sessions
			INNER JOIN task_closures ON task_closures.closure_id = closure_sessions.closure_id
			INNER JOIN items ON items.id = task_closures.item_row_id
			INNER JOIN chains ON chains.id = items.chain_id
			WHERE chains.name = $chain AND task_closures.phase = 'review'`, { chain }),
		(value) => value?.session_id === "c11-review-session",
		"C11 review retry session persistence",
	)
	release(ctx, "c11", item.item_id, "iteration", "review-session-persisted")
	const terminal = await waitForRunnerEvent(ctx, { type: "legacy-terminal", scenario: "c11", item: item.item_id, phase: "review", attempt: 2 })
	assert(terminal.resumed === true, "C11 final review did not resume the retry review session")
	assert(eventResult(terminal).exitCode === 0, `C11 final legacy status failed: ${eventResult(terminal).stderr}`)
	await waitForItemTaskCompletion(ctx, chain, item.id, 30_000)
	const runs = runRows(ctx, chain)
	assert(runs.map((run) => run.phase).join(",") === "iteration,iteration,review,iteration,review", `C11 phase order changed: ${runs.map((run) => run.phase).join(",")}`)
	assert(itemRow(ctx, chain, item.item_id).attempts === 1, "C11 session retry or successor incorrectly consumed another attempt")
	assert(itemRow(ctx, chain, item.item_id).status === "done", "C11 final legacy status did not complete the item")
	const finalTree = taskTree(ctx, chain)
	const finalItemRoot = itemTaskRoot(finalTree, item.id)
	assert(finalItemRoot !== null && taskNodeTerminal(finalItemRoot), "C11 item declaration tree did not reach terminal")
	assert(leafByPhase(finalTree, item.id, "iteration").state === "completed", "C11 final iteration leaf is not completed")
	assert(leafByPhase(finalTree, item.id, "review").state === "completed", "C11 final review leaf is not completed")
	const transitions = transitionRows(ctx, chain)
	assert(transitions.map((row) => row.path_id).join(",") === [
		"legacy-run-success:iteration",
		"legacy-status:review:retry",
		"legacy-run-success:iteration",
		"legacy-status:review:done",
	].join(","), "C11 legacy transition history lost implicit success, retry, or terminal order")
	const successfulRunIds = runs.filter((run) => run.exit_code === 0).map((run) => run.run_id)
	assert(transitions.map((row) => row.source_run_id).join(",") === successfulRunIds.join(","), "C11 transition source identities do not match successful runs 2-5")
	const statusAdmissionEvents = observabilityEvents(ctx, chain, "item.status.write_admission")
	const statusAdmissions = statusAdmissionEvents.map((event, index) => asObject(event.payload, `C11 status admission payload ${index}`))
	for (const requestedStatus of ["retry", "done"]) {
		assert(
			statusAdmissions.some((payload) =>
				payload.phase === "review"
				&& payload.requestedStatus === requestedStatus
				&& payload.outcome === "allow"
				&& payload.reason === "admitted"),
			`C11 ${requestedStatus} status admission audit is missing`,
		)
	}
	const lifecycleEvents = observabilityEvents(ctx, chain, "closure.lifecycle_changed")
	const lifecycleObservations = lifecycleEvents.map((event, index) => ({
		phase: event.phase,
		payload: asObject(event.payload, `C11 lifecycle payload ${index}`),
	}))
	assert(
		lifecycleObservations.some(({ phase, payload }) =>
			phase === "iteration"
				&& payload.from === "active"
				&& payload.to === "suspended"
				&& payload.reason === "phase-left"),
		"C11 implicit iteration advancement did not emit phase-left lifecycle observability",
	)
	assert(
		lifecycleObservations.some(({ phase, payload }) =>
			phase === "iteration"
				&& payload.from === "suspended"
				&& payload.to === "active"
				&& payload.reason === "phase-entered"),
		"C11 retry did not emit iteration phase-entered lifecycle observability",
	)
	assert(
		lifecycleObservations.some(({ phase, payload }) =>
			phase === "review"
				&& payload.from === "active"
				&& payload.to === "suspended"
				&& payload.reason === "phase-left"),
		"C11 terminal review did not emit phase-left lifecycle observability",
	)
	writeEvidence(ctx, "C11-legacy.json", {
		firstBackoff,
		sessions: { iteration: iterationSession, review: reviewSession },
		runs,
		transitions,
		statusAdmissionEvents,
		lifecycleEvents,
		finalTree,
	})
	log("C11", "no-[tasks] preset preserved failure/backoff, two session resumes, retry reset, status/lifecycle observability, terminal completion, and per-run transition history")
}

async function stopDaemon(ctx: RuntimeContext): Promise<void> {
	cli(ctx, ["daemon", "down", "--json"], true)
	await until(() => ctx.daemon.child.exitCode, (code) => code !== null, "isolated daemon exit", 20_000)
	await until(
		() => ({ socket: existsSync(resolve(ctx.loopDataRoot, "daemon.sock")), pid: existsSync(resolve(ctx.loopDataRoot, "daemon.pid")) }),
		(state) => !state.socket && !state.pid,
		"isolated daemon pid/socket cleanup",
		20_000,
	)
}

function copyRuntimeDiagnostics(ctx: RuntimeContext): void {
	for (const [source, target] of [
		[ctx.daemon.stdout, resolve(ctx.evidenceRoot, "daemon.stdout.log")],
		[ctx.daemon.stderr, resolve(ctx.evidenceRoot, "daemon.stderr.log")],
	] as const) {
		if (existsSync(source)) copyFileSync(source, target)
	}
}

function captureRunnerEvents(ctx: RuntimeContext): void {
	const events = readRunnerEvents(ctx)
	writeFileSync(ctx.runnerLog, events.map((event) => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n"))
}

function assertOwnedResources(ctx: RuntimeContext, chains: readonly string[]): JsonObject {
	const worktrees = command([REAL_GIT, "worktree", "list", "--porcelain"], { cwd: ctx.repository.path, record: false }).stdout
	const registered = worktrees
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path.startsWith(ctx.loopDataRoot))
	const refs = command([REAL_GIT, "for-each-ref", "--format=%(refname)", "refs/heads/coder-loop"], { cwd: ctx.repository.path, record: false }).stdout
		.split("\n")
		.filter(Boolean)
		.filter((ref) => chains.some((chain) => ref.includes(chain)))
	assert(registered.length === 0, `owned worktrees remain registered: ${registered.join(", ")}`)
	assert(refs.length === 0, `owned refs remain: ${refs.join(", ")}`)
	return { registeredWorktrees: registered, refs, daemonPid: ctx.daemon.child.pid ?? null, socketExists: existsSync(resolve(ctx.loopDataRoot, "daemon.sock")) }
}

async function deleteChains(ctx: RuntimeContext, chains: readonly string[]): Promise<void> {
	for (const chain of [...chains].reverse()) {
		if (chainStatus(ctx, chain) === "active") cli(ctx, ["chain", "stop", chain, "--json"], true)
		cli(ctx, ["chain", "delete", chain, "--json"], true)
	}
	await Bun.sleep(500)
}

async function main(): Promise<void> {
	assert(/^[0-9a-f]{40}$/.test(SOURCE_SHA), `source SHA is invalid: ${SOURCE_SHA}`)
	const sourceStatus = command([REAL_GIT, "status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPO_ROOT, record: false }).stdout
	assert(sourceStatus === "", `candidate checkout is dirty; exact-SHA evidence would be false:\n${sourceStatus}`)
	const base = command([REAL_GIT, "rev-parse", "origin/coder-loop/v3-546-baseline"], { cwd: REPO_ROOT, record: false }).stdout.trim()
	assert(base === "d67fec5bf245616e1a0bd67508a443e5842c2722", `unexpected #698 base ${base}`)
	assert(command([REAL_GIT, "merge-base", "--is-ancestor", base, SOURCE_SHA], { cwd: REPO_ROOT, allowFail: true, record: false }).exitCode === 0, `candidate ${SOURCE_SHA} is not based on ${base}`)
	const layout = prepareLayout()
	activeTranscript = layout.transcript
	activeCommandLog = layout.commandLog
	const presets = writePresets(layout)
	const shimDir = writeShims(layout)
	const ctx = startDaemon(layout, shimDir)
	const chains: string[] = []
	let success = false
	try {
		log("C01-C11", `source=${SOURCE_SHA} base=${base} runtime=${layout.runtimeId} evidence=${layout.evidenceRoot}`)
		await waitForDaemon(ctx)
		await runC01(ctx, presets, chains)
		await runC02C03(ctx, presets, chains)
		await runC04C05C06C07(ctx, presets, chains)
		await runC08(ctx, presets, chains)
		await runC09(ctx, presets, chains)
		await runC10(ctx, presets, chains)
		await runC11(ctx, presets, chains)
		captureRunnerEvents(ctx)
		await deleteChains(ctx, chains)
		await stopDaemon(ctx)
		copyRuntimeDiagnostics(ctx)
		const cleanup = assertOwnedResources(ctx, chains)
		writeEvidence(ctx, "manifest.json", {
			sourceSha: SOURCE_SHA,
			baseSha: base,
			runtimeId: layout.runtimeId,
			evidenceRoot: layout.evidenceRoot,
			repositoryCommit: layout.repository.commit,
			checks: ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11"],
			cleanup,
		})
		rmSync(layout.runtimeRoot, { recursive: true, force: true })
		assert(!existsSync(layout.runtimeRoot), `owned runtime root remains: ${layout.runtimeRoot}`)
		success = true
		log("C01-C11", `PASS source=${SOURCE_SHA} runtime=${layout.runtimeId} evidence=${layout.evidenceRoot} cleanup=verified`)
	} finally {
		if (!success) {
			if (ctx.daemon.child.exitCode === null) await stopDaemon(ctx).catch(() => {})
			captureRunnerEvents(ctx)
			copyRuntimeDiagnostics(ctx)
			writeFileSync(resolve(layout.evidenceRoot, "failure.json"), `${JSON.stringify({
				sourceSha: SOURCE_SHA,
				runtimeId: layout.runtimeId,
				diagnosticRoot: layout.runtimeRoot,
				evidenceRoot: layout.evidenceRoot,
				daemonExitCode: ctx.daemon.child.exitCode,
			}, null, 2)}\n`)
			process.stderr.write(`issue-698 diagnostics retained at ${layout.runtimeRoot}; evidence ${layout.evidenceRoot}\n`)
		}
	}
}

await main()
