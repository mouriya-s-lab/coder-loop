# Fragment: common/runtime-contract

## Purpose

This fragment defines the boundary between the deterministic program state machine and the AI-judged agent state machine.

## Program FSM boundary

The orchestrator may decide only facts that are fully programmable:

- which state/config files exist and are readable;
- whether `state.current` exists;
- which declared phase owns `state.current`, including `contract-enrichment`, `iteration`, or `review`;
- whether a queue item status is actionable (membership in the preset's `[statuses].continuable` set);
- which issue/run/prompt path to bind into an agent invocation;
- whether an agent process exited with code `0`;
- whether central daemon scheduling state still exists.

The program must not judge semantic completion, evidence quality, issue validity, PR correctness, parent closure, or blocker legitimacy.

## Agent FSM boundary

The agent owns contextual judgments that require reading natural language, code, screenshots, logs, GitHub discussions, or project conventions:

- whether the issue scope is fully understood;
- whether implementation is needed;
- whether evidence proves the changed behavior;
- whether a PR is reviewable and mergeable;
- whether a parent issue has complete children or remaining scope;
- whether to retry, accept, skip, block, expand a parent, or stop.
- whether a GitHub executable-contract marker is current and well formed; malformed or stale contracts select the declared re-enrichment exit rather than an implementation retry.

## Reading order

- Read the role entry prompt first; it contains the rendered runtime inputs and the fragment index with absolute paths.
- Read the common fragments the entry prompt names before role-specific step files.
- Enrichment reads `enrichment/*.md`; implementation and review step files live under `iter/steps/` and `review/steps/`. The role entry prompt is the guide to when each is opened.

## Terminal summaries

Only the role's entry prompt prints the mandatory final summary line.
