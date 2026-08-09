import { type as arkType } from "arktype"
import type { RuntimeHostConfig } from "./runtime-host"

export type RuntimeFileConfig = Omit<RuntimeHostConfig, "onTransportError" | "onCycleError">

export type RuntimeConfigParseResult =
	| { readonly kind: "accepted"; readonly config: RuntimeFileConfig }
	| { readonly kind: "rejected"; readonly issues: readonly string[] }

const SandboxBoundary = arkType({
	filesystem: "'closure-only'|'read-only'|'unrestricted'",
	network: "'none'|'declared-endpoints'|'unrestricted'",
	resources: "string[]",
	"+": "reject",
})
const LauncherBoundary = arkType.or(
	{ kind: "'direct'", "+": "reject" },
	{ kind: "'sandbox-exec'", executable: "'/usr/bin/sandbox-exec'", profile: "string > 0", "+": "reject" },
)
const RunnerLauncherBoundary = arkType.or(
	{ kind: "'direct'", "+": "reject" },
	{ kind: "'sandbox-exec'", executable: "'/usr/bin/sandbox-exec'", "+": "reject" },
)
const MapBoundary = arkType({
	executable: "string > 0",
	workerScript: "string > 0",
	env: { "[string]": "string" },
	sandbox: SandboxBoundary,
	launcher: LauncherBoundary,
	timeoutMs: "number.integer > 0",
	termGraceMs: "number.integer > 0",
	maxOutputBytes: "number.integer > 0",
	"+": "reject",
})
const HookBoundary = arkType({
	id: "string > 0",
	anchors: "('function-entry'|'pre-map'|'prompt-frozen'|'agent-start'|'post-map'|'routing'|'function-exit'|'committed-transition')[]",
	executable: "string > 0",
	argv: "string[]",
	cwd: "string > 0",
	env: { "[string]": "string" },
	sandbox: SandboxBoundary,
	launcher: LauncherBoundary,
	timeoutMs: "number.integer > 0",
	termGraceMs: "number.integer > 0",
	maxOutputBytes: "number.integer > 0",
	"+": "reject",
})
const RuntimeConfigBoundary = arkType({
	schemaVersion: "3",
	databaseFile: "string > 0",
	definitionRoot: "string > 0",
	providerFactRoot: "string > 0",
	hookRoot: "string > 0",
	socket: { operatorPath: "string > 0", agentPath: "string > 0", maxFrameBytes: "number.integer > 0", maxResponseBytes: "number.integer > 0", "+": "reject" },
	agentSubmitArgv: "string[]",
	map: MapBoundary,
	git: {
		repository: "string > 0", workspaceRoot: "string > 0", executable: "string > 0", env: { "[string]": "string" },
		timeoutMs: "number.integer > 0", termGraceMs: "number.integer > 0", maxOutputBytes: "number.integer > 0", "+": "reject",
	},
	runner: {
		kind: "'claude'|'codex'|'opencode'",
		executable: "string > 0",
		model: "string > 0",
		endpoint: { transport: "'local-process'|'remote-api'|'session'", server: "string", principal: "string", machine: "string", profile: "string", "+": "reject" },
		env: { "[string]": "string" },
		sandbox: SandboxBoundary,
		launcher: RunnerLauncherBoundary,
		timeoutMs: "number.integer > 0",
		termGraceMs: "number.integer > 0",
		maxOutputBytes: "number.integer > 0",
		"+": "reject",
	},
	hooks: HookBoundary.array(),
	hookShutdownWaitMs: "number.integer > 0",
	leaseMs: "number.integer > 0",
	maxConcurrency: "number.integer > 0",
	cycleMs: "number.integer > 0",
	"+": "reject",
})

export function parseRuntimeConfig(candidate: unknown): RuntimeConfigParseResult {
	const parsed = RuntimeConfigBoundary(candidate)
	if (parsed instanceof arkType.errors) return { kind: "rejected", issues: [parsed.summary] }
	const isolationIssues = [
		...(parsed.runner.sandbox.filesystem === "closure-only" ? [] : ["runner.sandbox.filesystem must be closure-only so agent code cannot reach the operator socket"]),
		...(parsed.runner.launcher.kind === "sandbox-exec" ? [] : ["runner.launcher must be sandbox-exec so the declared filesystem boundary is enforced"]),
	]
	return isolationIssues.length > 0
		? { kind: "rejected", issues: isolationIssues }
		: { kind: "accepted", config: parsed }
}
