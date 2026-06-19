import type { AgentRunnerKind } from "../loop"

export type RunnerSessionIdInvalidDetector = {
	runner: AgentRunnerKind
	detectsSessionIdInvalid: (stderr: string) => boolean
}

const CODEX_SESSION_ID_INVALID = /\bthread\/resume failed:\s*no rollout found for thread id\s+\S+/i
const CLAUDE_SESSION_ID_INVALID = /\bNo conversation found with session ID:\s*\S+/i
const OPENCODE_SESSION_ID_INVALID = /Session not found/i

export const codexSessionIdInvalidDetector: RunnerSessionIdInvalidDetector = {
	runner: "codex",
	detectsSessionIdInvalid: (stderr) => CODEX_SESSION_ID_INVALID.test(stderr),
}

export const claudeSessionIdInvalidDetector: RunnerSessionIdInvalidDetector = {
	runner: "claude",
	detectsSessionIdInvalid: (stderr) => CLAUDE_SESSION_ID_INVALID.test(stderr),
}

export const opencodeSessionIdInvalidDetector: RunnerSessionIdInvalidDetector = {
	runner: "opencode",
	detectsSessionIdInvalid: (stderr) => OPENCODE_SESSION_ID_INVALID.test(stderr),
}

const SESSION_ID_INVALID_DETECTORS: Record<AgentRunnerKind, RunnerSessionIdInvalidDetector> = {
	claude: claudeSessionIdInvalidDetector,
	codex: codexSessionIdInvalidDetector,
	opencode: opencodeSessionIdInvalidDetector,
}

export function detectsSessionIdInvalid(runner: AgentRunnerKind, stderr: string): boolean {
	return SESSION_ID_INVALID_DETECTORS[runner].detectsSessionIdInvalid(stderr)
}
