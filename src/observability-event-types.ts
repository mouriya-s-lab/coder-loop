export const OBSERVABILITY_EVENT_TYPES = [
	"chain.layout", "chain.status", "item.created", "item.status", "item.reordered", "queue.terminal",
	"item.dependency_unblocked", "slot.busy", "item.dependency_wait", "item.backoff", "chain.complete_trigger",
	"daemon.start", "daemon.stop", "daemon.stop.terminated_runs", "daemon.socket.rebind", "daemon.fatal",
	"daemon.preset_load_failed", "scheduler.recovery", "agent.spawn", "agent.exit", "phase.start", "phase.end",
	"chain.completed", "attempt.timeout", "run.startup_idle_kill", "scheduler.rate_limited", "recycle.pending_entered",
	"recycle.timeout_kill", "recycle.natural_exit", "spawn.aborted", "session_id.invalidated", "chain.invalid",
	"preset.placeholder_check", "preset.dag_check", "daemon.warning", "scheduler.tick_failed",
	"scheduler.lifecycle_event_persistence_failed", "runner.status_persistence_failed", "chain.complete_trigger_failed",
	"item.status.write_admission", "item.mutation.caller_admission", "item.exit.selected", "chain.stop.from_phase_exit",
	"item.add.rights_admission", "privileged_op.caller_admission", "item.update.field_write_admission",
] as const

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number]
const OBSERVABILITY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(OBSERVABILITY_EVENT_TYPES)

export const ObservabilityEventTypeBoundary = { assert: parseObservabilityEventType }

export function parseObservabilityEventType(input: string): ObservabilityEventType {
	if (!OBSERVABILITY_EVENT_TYPE_SET.has(input)) throw new Error(`unknown observability event type: ${input}`)
	assertObservabilityEventType(input)
	return input
}

function assertObservabilityEventType(input: string): asserts input is ObservabilityEventType {
	if (!OBSERVABILITY_EVENT_TYPE_SET.has(input)) throw new Error(`unknown observability event type: ${input}`)
}
