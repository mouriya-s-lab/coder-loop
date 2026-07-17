# Fragment: common/state-contract

## Purpose

This fragment defines how the central SQLite state DB (agents touch it only through the daemon-serialized CLI — `coder-loop status` / `item list` / `item exits` / `item update` / `item exit-action`), run stdout log, and handoff files are used.

## Queue state

Queue item statuses are finite and split into two categories:

- actionable — the preset's `[statuses].continuable` set. The engine schedules these.
- non-actionable / final-ish — the preset's `[statuses].terminal` set. The engine skips these. Two restore paths exist: the engine automatically restores a terminal item to `[statuses].entry` once every queue item its `dependsOn` record targets reaches a success terminal status (the cross-repo unblock mechanism — see the blocked-responder entry), and the operator-only `coder-loop queue unblock` command (the daemon rejects agent credentials on it).

The two sets are disjoint and exhaustive (preset load enforces this). The exact status names for the active preset are rendered in your role's entry prompt under the status vocabulary doc (review) or the phase-exits doc (every phase) — read them there rather than copying any literal into this fragment.

The scheduler selects the next actionable item itself (queue order and priority are engine-owned); agents never pick or re-pin the selected item. When review prepends child issues, writing the parent's retry status is what releases the selection — the scheduler then picks the prepended children first.

## Runtime files

- Chain scheduling is daemon-owned; there is no on-switch file. The only agent-side channel to stop a chain is review's **stop** chain-action exit (`coder-loop item exit-action --action stop`, per `review/actions/stop.md`), reserved for broken review infrastructure or a failed irreversible side effect; chain completion itself is engine-detected (all items terminal → umbrella-finalizer trigger → `completed`). `chain stop` / `chain resume` / `queue unblock` are operator-only commands.
- run stdout log is per-run trace output for review. It is not durable task history.
- `loop-data/chains/<chain>/shared.md` is the daemon-owned **per-round scratchpad** for structured phase-to-phase context passing within one round. It is not executable-contract authority (that stays with the unique current GitHub marker comment selected by `common/executable-contract.md`) and it is not the cross-round historical record (that stays in the GitHub packet arrays per `common/packets.md`). Its ownership passes to whichever phase is currently writing; rebound phases (packet retry, drift, review-issued retry / reenrich) are responsible for compacting it before exiting. Structure is `## Issue #<n>` → `### Round <n>` → `#### Phase: <name>` notes and a leading `<!-- coder-loop:shared:verdict … -->` block when the round was opened by a retry / drift. Full schema, writer / reader rules, and compaction protocol are specified in `common/packets.md` (Shared handoff block).
- `loop-data/chains/<chain>/issues/<issue>.md` is an optional issue-local attachment. Its absence must not block any phase's startup.
- Per-target policy / project commands / PR conventions live in the repo's own `CLAUDE.md` / `AGENTS.md`, not in `.coder-loop/`. Loop-internal policy (PR evidence layers, verdict semantics) lives inside the preset fragments.
- `loop-data runtime artifacts` and run stdout log must not be staged into feature commits.

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
| review | `retry` | feedback report posted to PR/issue | retry continuable status |
| review | `reenrich` | contract defect posted | contract-invalid continuable status |
| review | `expanded incomplete parent` | children created + linked + handoff/evidence initialized | children prepended, parent to retry status |
| review | `blocked` | blocker + pointer published | blocked terminal status |
| review | accepted-pr / accepted-no-pr / moot | durable ReviewVerdict published | none — clean exit; closure owns the terminal |
| closure | verdict executed | merge/close confirmed live | `done` / `moot` terminal status (`done` also releases any items whose `dependsOn` targets this one) |
| closure | live state drifted | drift evidence posted | the matching drift continuable status |

If a required external effect fails, do not write the corresponding local state. Use the failure path named by the action fragment or entry prompt.

## Handoff discipline

Handoff notes are structured per the Shared handoff block schema in `common/packets.md`. Each phase writes its own `#### Phase: <name>` note under the current `### Round <n>` of its `## Issue #<n>` section — concise, source-cited (run ID, what happened, files/artifacts touched, commands and outcomes, packet/PR URLs, blockers, proposed child issue specs when relevant). Notes are consumed by same-round downstream phases per each entry's Step 1 / Step 2 read list; they never substitute for the durable GitHub packet a phase must post.

## Shared handoff compaction (round boundaries)

Every retry-writing phase MUST rewrite the affected shared.md region **before** it exits (in one apply_patch, so the compaction and the new content land atomically). The rule is uniform across writers:

- **Any retry / drift exit** = close the current round in `## Issue #{{ISSUE}}` and open a new round. Physically: replace the entire `### Round <n>` block with a one-line summary `### Round <n> — closed by <phase> as <status> at <run-id>`, then append a fresh `### Round <n+1> — opened by <phase> as <status>` with the required `<!-- coder-loop:shared:verdict … -->` block as the round's first content. The full ReviewVerdict / DiffAuditReport / VerificationAuditReport / VerificationPacket comment on GitHub is the durable historical record — shared.md carries the pointer, not the copy.
- **Any clean forward exit** = leave the current round intact; append a new `#### Phase: <name>` note. No compaction.
- **`closure` writing `done` or `moot`** = the round is over and its content will not be read again (subsequent iteration on this issue never re-enters the loop). Replace the entire `## Issue #{{ISSUE}}` section with a one-line summary `## Issue #{{ISSUE}} — closed <done|moot> at <run-id>, see <PR/issue URL>`. This is the only sanctioned deletion of accumulated notes.
- **`closure` drift** = same as any other retry exit (close round `<n>`, open `<n+1>` with the drift verdict block).

The rule is not "clean up when it feels cluttered"; it is "the writer of the transition owns the compaction". A retry exit that appends without closing the round leaves stale phase notes downstream will read as live — that is a protocol violation caught by review.
