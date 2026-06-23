# Fragment: common/dispatch-contract

## Purpose

This fragment defines how an orchestrator (iteration or review) drives subagent dispatches under the **claude `-p` async harness**. The orchestrator reading this is "you"; every `Agent` call you make in the workflow steps obeys this contract. The fragment changes only the dispatch transport; it does not change which dispatches are mandatory, what each subagent produces, or how acceptance is judged.

## The `Agent` tool is asynchronous

`Agent` does **not** return the subagent's report. The tool_result is exactly an async receipt:

```
Async agent launched successfully.
agentId: <task-id> (internal ID — do not mention to user. Use SendMessage with to: '<task-id>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.
```

You receive nothing else from this call. The subagent's full report lands only when a `<task-notification>` user message reaches you in a **later turn**:

```
<task-notification>
<task-id>...</task-id>
<tool-use-id>...</tool-use-id>
<output-file>/private/tmp/.../tasks/<task-id>.output</output-file>
<status>completed | failed | …</status>
<summary>…</summary>
<result>
<the subagent's full final message — this is the report you judge>
</result>
</task-notification>
```

The report is the **`<result>` block inside the `<task-notification>` itself** — read it directly from the user message text in the turn. The `<summary>` is a one-line hint, never the contract. **Do not `Read` the `<output-file>`** — that path is a symlink to the subagent's full conversation transcript (JSONL), and reading it will overflow your context window and bury the report under turn-by-turn intermediate steps.

Treating the async receipt as the report — checking the `<task-id>` against `accept.md`, or reasoning about the subagent's findings before its `<task-notification>` arrives — is the failure mode this fragment exists to prevent.

## Pattern around every dispatch round

A **dispatch round** is the set of `Agent` calls you make in a single turn. Each round follows this pattern:

1. **Dispatch.** Make the `Agent` tool calls — one per subagent in the round. A parallel contention plan = multiple `Agent` calls in the same turn (turning a parallel plan into sequential serial dispatch costs wall-clock and is its own protocol failure). Append one ledger line per dispatch: `step | task-id | dispatched | <Step focus>` — without the `task-id`, an arriving `<task-notification>` cannot be matched back to its dispatch.
2. **End the turn.** Do not loop, do not poll, do not call additional tools "to keep yourself busy" after dispatching. The harness re-invokes you when each `<task-notification>` arrives — that is the primary and reliable mechanism in this runner; empirical rounds in this project see notifications arrive 1–11 minutes after dispatch and have never been lost.
3. **Optional: long timeout protection.** Only if you expect a subagent to legitimately take more than ~30 minutes (e.g. an `e2e-replay` round that walks a long UI flow, or a round whose work is genuinely open-ended), call `ScheduleWakeup` once before ending the turn with `delaySeconds` set to the upper-bound runtime + a 5-minute margin (e.g. 2400–3000s). This is a safety net for a stuck or never-returning subagent, not a primary mechanism. **Do not** set a `ScheduleWakeup` on every routine round — short-fuse wakeups against rounds that finish via notification only burn turns. If a wakeup does fire while subagents are still outstanding, follow the "wakeup fired with subagents still outstanding" branch below.

## When the harness re-invokes you

Each re-invocation begins a fresh turn. Read the incoming user messages first, then act:

- **`<task-notification>` block(s) present** — for each one in the new turn:
  1. Read the report directly from the `<result>` block inside the notification (the turn's user-message text already contains it; do not `Read` the `<output-file>` symlink).
  2. Match `<task-id>` to its ledger line and the step's `accept.md`.
  3. Run the step's structural check, then substance judgment.
  4. Route the verdict per the owning workflow step's 4d / Step 3 rules: accepted → `[x]` + ledger; gaps or wrong direction → `TaskStop(to=<task-id>)` then a fresh `Agent(...)` with the gap list / corrected scope folded into the new `Step focus`. There is no continue-the-same-subagent path under this runner; every follow-up is a new dispatch.
  5. If subagents from this round are still outstanding (no notification yet), do **not** advance past their workflow line. End the turn after processing the notifications you did receive; the harness will re-invoke you for the next one. Do not poll, do not set short-fuse wakeups to "check on" outstanding subagents.
- **Optional long-timeout wakeup fired with subagents still outstanding** — only reachable if you set the optional timeout wakeup in step 3 above and no notification arrived in that window. This is a stuck-subagent signal, not a routine event. Investigate: a `<task-notification>` may still be in flight (end the turn and wait one more cycle); otherwise `TaskStop(to=<task-id>)` and dispatch fresh, recording `abandoned: <reason>` + the new `dispatched: <task-id>` in the ledger. Reading the `<output-file>` transcript for diagnosis is allowed only when you accept the context cost.
- **All round's reports now accepted** — advance to the next workflow line. Never advance while any line is still outstanding.

After ending the turn you do not control when you come back. Do not start work assuming a notification is imminent, and do not write speculative report-judgement text into the trace before the actual report arrives.

## Follow-ups are always a fresh dispatch

Under daemon-spawn `claude -p` the runner does not expose a "continue this subagent" path — the `Use SendMessage with to: '<task-id>' to continue this agent.` hint inside `Agent`'s tool_result is a harness-string for interactive Claude Code, not a tool you can call here (`ToolSearch select:SendMessage` returns no match; the deferred tool list has no continuation tool). So every follow-up — missing report field, gap list, re-scoped direction — is the same shape: `TaskStop(to=<task-id>)` to close the wrong/incomplete subagent, then a fresh `Agent(...)` whose `Step focus` carries the gap list or the corrected scope. Ledger records both events (`abandoned: <reason>` + `dispatched: <new task-id>`). The new dispatch starts a new async round; end the turn and wait for its `<task-notification>` (apply the optional long-timeout wakeup only if the fresh subagent is itself an open-ended round, per the pattern above).

The cost of this design is that the fresh subagent loses the prior session's intermediate context (caches, partial reads). That cost is paid in `task.md` / `report.md` self-containment — every step's task file is written to be re-entrant from runtime inputs alone. Do not invent in-conversation continuity that the runner cannot provide; do not try to call `SendMessage` to dodge the re-dispatch cost (it will fail at the tool layer and waste a turn).

## What this fragment does not change

- The four-mandatory-dispatch rule for `code` / `blocked` / legacy review; the verify ∥ e2e pairing in iteration; every existing acceptance gate, judgment, verdict transition, kind-routing matrix, and step `task.md` / `report.md` / `accept.md`.
- The substance of any subagent's work or any orchestrator's judgement.

This fragment fixes only how the orchestrator transports dispatch ↔ report across turns under the claude `-p` async harness. Every other obligation continues to live in the step that owns it.
