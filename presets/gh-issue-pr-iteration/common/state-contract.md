# Fragment: common/state-contract

## Purpose

This fragment defines how `central SQLite state DB`, central daemon scheduling state, run stdout log, and handoff files are used.

## Queue state

Queue item statuses are finite:

- actionable: `queued`, `in_progress`, `changes_requested`;
- non-actionable/final-ish: `blocked`, `moot`, `done`.

The orchestrator selects an actionable `state.current` item before the front of `queue`. If review prepends child issues, it must set `current: null`; otherwise the parent will be selected again.

## Runtime files

- central daemon scheduling state is the loop on-switch. Review removes it only when no actionable work remains or review infrastructure is broken.
- run stdout log is per-run trace output for review. It is not durable task history.
- `loop-data/chains/<chain>/issues/<issue>.md` is append-only handoff for the selected issue.
- `loop-data/chains/<chain>/shared.md` stores only stable, source-cited cross-issue facts.
- `.coder-loop/workflow.md`, `.coder-loop/prompts/`, and `.coder-loop/templates/` are committed target policy/configuration when present.
- `loop-data runtime artifacts`, central daemon scheduling state, and run stdout log must not be staged into feature commits.

## Final state invariants

- No local item may become `done` while its required PR merge or GitHub issue closure has failed.
- No local item may become `moot` while its GitHub issue remains open.
- No local item may become `blocked` unless the blocker was published to the PR or issue thread, or GitHub posting itself failed and review stops as infrastructure-broken.
- A parent/wrapper issue with remaining coherent deliverables is not `done`, `moot`, or final `blocked`; review must create/link child issues, initialize their handoff/evidence paths, prepend them to the queue, set the parent to `changes_requested`, and clear `current`.
- Iteration may append evidence and recommendations to the issue handoff but must not write final state transitions.

## Fixed review transitions

Review follows fixed transitions; ordinary task review should apply the transition that matches the current verdict instead of inventing additional framework-level checks:

| Review result | Required external effect first | Local state only after |
|---|---|---|
| `retry` | feedback posted to PR/issue, or GitHub feedback failure recorded as infrastructure failure | selected item `changes_requested`, `current: null` |
| `expanded incomplete parent` | child issues created, linked as sub-issues, child handoff/evidence paths initialized | child items prepended, parent `changes_requested`, `current: null` |
| `accepted_pr` | acceptance posted, PR merged, issue comment posted, issue confirmed closed | selected item `done`, PR number set, `current: null` |
| `accepted_no_pr` | issue comment posted and issue confirmed closed | selected item `done`, `current: null` |
| `skip` | skip reason posted and issue confirmed closed | selected item `moot`, `current: null` |
| `blocked` | blocker reason posted to PR/issue | selected item `blocked`, `current: null` |

If a required external effect fails, do not write the corresponding final-ish local state. Use the failure path named by the action fragment.

## Handoff discipline

Handoff notes should be concise and source-cited: run ID, what happened, files changed, commands and outcomes, evidence artifacts, PR link, blockers, and proposed child issue specs when relevant.