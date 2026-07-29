import { describe, expect, test } from "bun:test"

import {
	buildAgentRunnerCommands,
	buildRunnerFilesystemAuthorization,
	buildRunnerInvocation,
} from "../../../src/loop"

describe("loop external-terminal runner", () => {
	test("configured hapi command participates in the same resolved runner map", () => {
		const commands = buildAgentRunnerCommands({
			claudeBinary: null, claudeModel: null, claudeExtraArgs: [],
			codexBinary: null, codexModel: null, codexExtraArgs: [],
			opencodeBinary: null, opencodeModel: null, opencodeExtraArgs: [],
			hapiBinary: "/opt/bin/fake-external-terminal", hapiModel: null, hapiExtraArgs: ["--fixture"],
		})
		expect(commands.hapi).toEqual({
			kind: "hapi",
			binary: "/opt/bin/fake-external-terminal",
			extraArgs: ["--fixture"],
			model: null,
		})
	})

	test("hapi invocation builder defaults to typed invocation-pending without a spawn plan", () => {
		const authorization = buildRunnerFilesystemAuthorization({
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
			declaredRuntimeBindingPaths: [],
		})
		const defaultDecision = buildRunnerInvocation(
			{ kind: "hapi", binary: "hapi-remote-session", extraArgs: [], model: null, source: "engine-builtin" },
			"prompt-owned-by-603",
			{ kind: "fresh" },
			authorization,
		)
		const configuredDecision = buildRunnerInvocation(
			{ kind: "hapi", binary: "hapi-remote-session", extraArgs: ["--configured"], model: null, source: "engine-builtin" },
			"prompt-owned-by-603",
			{ kind: "resume", sessionId: "session-owned-by-603" },
			authorization,
		)
		expect(defaultDecision).toEqual({ kind: "invocation-pending", runner: "hapi", capability: { kind: "probe-only", outcome: "invocation-pending" } })
		expect(configuredDecision).toEqual({ kind: "invocation-pending", runner: "hapi", capability: { kind: "probe-only", outcome: "invocation-pending" } })
	})
})
