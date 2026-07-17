export type ChainStatus = "active" | "completed" | "stopped" | "deleted" | string | null

export type CompletionVerdict =
	| { kind: "success" }
	| { kind: "terminal-failure"; status: string }
	| null

export function completionVerdict(
	chainStatus: ChainStatus,
	byStatus: Readonly<Record<string, number>>,
	terminalFailure: readonly string[],
): CompletionVerdict {
	for (const status of terminalFailure) {
		if ((byStatus[status] ?? 0) >= 1) return { kind: "terminal-failure", status }
	}
	return chainStatus === "completed" ? { kind: "success" } : null
}
