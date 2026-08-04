# Fragment: common/state-contract

## Purpose

This fragment defines how `central SQLite state DB`, central daemon scheduling state, run stdout log, and handoff files are used.

## Queue state

Queue item statuses are finite and split into two categories:

- actionable — the preset's `[statuses].continuable` set. The engine schedules these.
- non-actionable / final-ish — the preset's `[statuses].terminal` set. The engine skips these unless `queue unblock` restores one to `[statuses].entry`.

The two sets are disjoint and exhaustive (preset load enforces this). The exact status names for the active preset are rendered in your role's entry prompt under the status vocabulary doc — read them there rather than copying any literal into this fragment.

The orchestrator selects an actionable `state.current` item before the front of `queue`. If review prepends child issues, it must set `current: null`; otherwise the parent will be selected again.

## Runtime files

- central daemon scheduling state is the loop on-switch. Review removes it only when no actionable work remains or review infrastructure is broken.
- run stdout log is per-run trace output for review. It is not durable task history.
- `loop-data/chains/<chain>/shared.md` is the daemon-owned chain handoff/shared file and primary append-only local handoff for every phase.
- `loop-data/chains/<chain>/issues/<issue>.md` is an optional issue-local attachment. Its absence must not block iteration or review startup.
- Per-target policy / project commands / PR conventions live in the repo's own `CLAUDE.md` / `AGENTS.md`, not in `.coder-loop/`. Loop-internal policy (PR evidence layers, verdict semantics, CI parity rules) lives inside the preset fragments.
- `loop-data runtime artifacts`, central daemon scheduling state, and run stdout log must not be staged into feature commits.

## Final state invariants

- No local item may become `done` while its required PR merge or GitHub issue closure has failed.
- No local item may become `moot` while its GitHub issue remains open.
- No local item may become `blocked` unless the blocker was published to the PR or issue thread, or GitHub posting itself failed and review stops as infrastructure-broken.
- A parent/wrapper issue with remaining coherent deliverables is not put in any final / terminal status; review must create/link child issues, initialize their handoff/evidence paths, prepend them to the queue, set the parent back to the preset-declared retry status (the same status `retry` transitions write — query it for your phase via the completion protocol described in your entry prompt), and clear `current`.
- Iteration may append evidence and recommendations to the chain handoff but must not write final state transitions.

## Fixed review transitions

Review follows fixed transitions; ordinary task review should apply the transition that matches the current verdict instead of inventing additional framework-level checks:

For each review verdict the required external effect must succeed before the local status transition is written; the status names themselves are preset metadata, so query the allowed set via `coder-loop item exits` and `coder-loop item update --status <chosen>` (see the completion protocol in your entry prompt) rather than hand-writing literals here.

| Review result | Required external effect first | Local state only after (preset terminology) |
|---|---|---|
| `retry` | feedback posted to PR/issue, or GitHub feedback failure recorded as infrastructure failure | selected item set to the preset's retry continuable status, `current: null` |
| `expanded incomplete parent` | child issues created, linked as sub-issues, child handoff/evidence paths initialized | child items prepended, parent set to the preset's retry continuable status, `current: null` |
| `accepted_pr` | acceptance posted, PR merged, issue comment posted, issue confirmed closed | selected item set to a success-terminal status (preset's `[statuses].success`), PR number set, `current: null` |
| `accepted_no_pr` | issue comment posted and issue confirmed closed | selected item set to a success-terminal status, `current: null` |
| `skip` | skip reason posted and issue confirmed closed | selected item set to the preset's "no-longer-applicable" terminal status, `current: null` |
| `blocked` | blocker reason posted to PR/issue | selected item set to the preset's blocked terminal status, `current: null` |

If a required external effect fails, do not write the corresponding final-ish local state. Use the failure path named by the action fragment.

## Handoff discipline

Handoff notes should be concise and source-cited: run ID, what happened, files changed, commands and outcomes, evidence artifacts, PR link, blockers, and proposed child issue specs when relevant.
