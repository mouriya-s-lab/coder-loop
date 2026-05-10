# Fragment: common/runtime-contract

## Purpose

This fragment defines the boundary between the deterministic program state machine and the AI-judged agent state machine.

## Program FSM boundary

The orchestrator may decide only facts that are fully programmable:

- which state/config files exist and are readable;
- whether `state.current` exists;
- whether `state.current.phase` is `iteration` or `review`;
- whether a queue item status is actionable (`queued`, `in_progress`, `changes_requested`);
- which issue/run/prompt path to bind into an agent invocation;
- whether an agent process exited with code `0`;
- whether `.dev-loop` still exists.

The program must not judge semantic completion, evidence quality, issue validity, PR correctness, parent closure, or blocker legitimacy.

## Agent FSM boundary

The agent owns contextual judgments that require reading natural language, code, screenshots, logs, GitHub discussions, or project conventions:

- whether the issue scope is fully understood;
- whether implementation is needed;
- whether evidence proves the changed behavior;
- whether a PR is reviewable and mergeable;
- whether a parent issue has complete children or remaining scope;
- whether to retry, accept, skip, block, expand a parent, or stop.

## Fragment protocol

- Read the role entry prompt first; it contains the rendered runtime inputs and the fragment index with absolute paths.
- Read the common fragments required by the role entry prompt before role-specific fragments.
- Each role-specific fragment names the allowed next fragment IDs. Use the entry prompt's fragment index to find the path for the next fragment.
- Do not skip ahead to terminal action fragments unless the current fragment's verdict allows it.
- Do not invent verdicts. If no listed verdict fits, choose the safest listed retry/block/stop path and state why.

## Terminal summaries

Only the role's final fragment prints the mandatory final summary line. Intermediate fragments may keep brief notes in the trace but must continue to the next fragment.