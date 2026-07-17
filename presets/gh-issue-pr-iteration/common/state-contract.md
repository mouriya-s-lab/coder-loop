# Fragment: common/state-contract

## Purpose

This fragment defines how `central SQLite state DB`, central daemon scheduling state, run stdout log, and handoff files are used.

## Queue state

Queue item statuses are finite and split into two categories:

- actionable — the preset's `[statuses].continuable` set. The engine schedules these.
- non-actionable / final-ish — the preset's `[statuses].terminal` set. The engine skips these unless `queue unblock` restores one to `[statuses].entry`.

The two sets are disjoint and exhaustive (preset load enforces this). The exact status names for the active preset are rendered in your role's entry prompt under the status vocabulary doc (review) or the phase-exits doc (every phase) — read them there rather than copying any literal into this fragment.

The orchestrator selects an actionable `state.current` item before the front of `queue`. If review prepends child issues, it must set `current: null`; otherwise the parent will be selected again.

## Runtime files

- central daemon scheduling state is the loop on-switch. Review removes it only when no actionable work remains or review infrastructure is broken.
- run stdout log is per-run trace output for review. It is not durable task history.
- `loop-data/chains/<chain>/shared.md` is the daemon-owned append-only local handoff. It is not durable executable-contract authority; that authority is the unique current GitHub marker comment selected by `common/executable-contract.md`. Cross-phase business facts travel as GitHub packets per `common/packets.md`, never as handoff-only state.
- `loop-data/chains/<chain>/issues/<issue>.md` is an optional issue-local attachment. Its absence must not block any phase's startup.
- Per-target policy / project commands / PR conventions live in the repo's own `CLAUDE.md` / `AGENTS.md`, not in `.coder-loop/`. Loop-internal policy (PR evidence layers, verdict semantics) lives inside the preset fragments.
- `loop-data runtime artifacts`, central daemon scheduling state, and run stdout log must not be staged into feature commits.

## Final state invariants

- No local item may become `done` while its required PR merge or GitHub issue closure has failed. Only closure writes the success terminal, and only after re-reading live GitHub state and confirming the external terminal state.
- No local item may become `moot` while its GitHub issue remains open. Only closure writes it.
- No local item may become `blocked` unless the blocker was published to the PR or issue thread, or GitHub posting itself failed and review stops as infrastructure-broken. Review is the only phase that writes it.
- A parent/wrapper issue with remaining coherent deliverables is not put in any final / terminal status; review must create/link child issues, initialize their handoff/evidence paths, prepend them to the queue, set the parent back to the preset-declared retry status (the same status `retry` transitions write — query it for your phase via the completion protocol described in your entry prompt), and clear `current`.
- Producing phases (iteration, verification, publish) never write terminal statuses: their exits are the retry and contract-invalid continuable routes; everything else is a clean exit that lets the scheduler advance the frontier.
- A missing, malformed, ambiguous, or stale executable contract transitions through the preset-declared `contract_invalid` exit to `contract-enrichment`; it is not an implementation retry and must not be repaired by rewriting the issue body.
- Closure's drift exits (`candidate_drift` / `verification_drift` / `publication_drift` / `review_drift`) are sameness routing, not judgments: they return the item to the phase whose output no longer matches live GitHub state, and never accompany an executed merge/close.

## Phase transition ownership

Each transition requires its external effect durable first; the status names themselves are preset metadata — query the allowed set via `coder-loop item exits` and write via `coder-loop item update --status <chosen>` (see the completion protocol in your entry prompt) rather than hand-writing literals here.

| Writer | Verdict / situation | Required external effect first | Local transition |
|---|---|---|---|
| iteration | contract defect found | defect + source evidence posted | contract-invalid continuable status |
| verification | candidate failed a check | VerificationPacket (failure form) posted | retry continuable status |
| verification | contract check unexecutable | defect evidence posted | contract-invalid continuable status |
| publish | candidate drifted / delivery needs code | gap posted to PR/issue thread | retry continuable status |
| publish | delivery route invalid | defect evidence posted | contract-invalid continuable status |
| review | `retry` | feedback report posted to PR/issue | retry continuable status, `current: null` |
| review | `reenrich` | contract defect posted | contract-invalid continuable status |
| review | `expanded incomplete parent` | children created + linked + handoff/evidence initialized | children prepended, parent to retry status, `current: null` |
| review | `blocked` | blocker + pointer published | blocked terminal status |
| review | accepted-pr / accepted-no-pr / moot | durable ReviewVerdict published | none — clean exit; closure owns the terminal |
| closure | verdict executed | merge/close/unblock confirmed live | `done` / `moot` terminal status |
| closure | live state drifted | drift evidence posted | the matching drift continuable status |

If a required external effect fails, do not write the corresponding local state. Use the failure path named by the action fragment or entry prompt.

## Handoff discipline

Handoff notes should be concise and source-cited: run ID, what happened, files changed, commands and outcomes, evidence artifacts, packet/PR URLs, blockers, and proposed child issue specs when relevant.
