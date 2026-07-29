import type { AgentRunnerKind } from "../loop"

export type RunnerSessionIdInvalidDetector = {
	runner: AgentRunnerKind
	detectsSessionIdInvalid: (stderr: string) => boolean
}

const CODEX_SESSION_ID_INVALID = /\bthread\/resume failed:\s*no rollout found for thread id\s+\S+/i
const CLAUDE_SESSION_ID_INVALID = /\bNo conversation found with session ID:\s*\S+/i
// #481: opencode writes a plain `Error: Session not found` to stderr when `-s <ses_id>` resolves
// to nothing on its side. The operator observed ANSI color codes wrapping the line on a real
// terminal, so we strip CSI sequences before matching — otherwise the regex misses the colored
// form. We deliberately keep the regex anchored to the literal phrase: opencode's stderr is
// otherwise short and unambiguous, so collapsing to a phrase match keeps false positives down.
const OPENCODE_SESSION_ID_INVALID = /\bError:\s*Session not found\b/i
// ANSI CSI escape sequence matcher (ESC, U+001B, followed by `[`, parameter bytes, terminator).
// The bracket / digit / semicolon group covers SGR (color) and most cursor-move sequences; the
// alpha terminator catches every common ending byte.
const ANSI_CSI_PATTERN = /\[[0-9;?]*[A-Za-z]/g

function stripAnsi(input: string): string {
	return input.replaceAll(ANSI_CSI_PATTERN, "")
}

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
	detectsSessionIdInvalid: (stderr) => OPENCODE_SESSION_ID_INVALID.test(stripAnsi(stderr)),
}

const SESSION_ID_INVALID_DETECTORS: Record<AgentRunnerKind, RunnerSessionIdInvalidDetector> = {
	claude: claudeSessionIdInvalidDetector,
	codex: codexSessionIdInvalidDetector,
	opencode: opencodeSessionIdInvalidDetector,
}

export function detectsSessionIdInvalid(runner: AgentRunnerKind, stderr: string): boolean {
	return SESSION_ID_INVALID_DETECTORS[runner].detectsSessionIdInvalid(stderr)
}
