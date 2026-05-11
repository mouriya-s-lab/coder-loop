# Fragment: plan/final

## Goal

Hard terminus for the planning run. Emit a single-line summary the slash command shell captures and shows the operator.

## Procedure

1. Read the handoff file written by `plan/handoff` (or, if `handoff_failed`, the in-memory accumulated state).

2. Print to stdout a one-paragraph summary in this exact shape (so the slash command shell can grep for it):

   ```
   === planning final ===
   verdict: <queue_initialized | intake_needs_clarification | classification_blocked | decompose_blocked | validation_blocked | partial_creation | queue_init_failed | handoff_failed>
   issues_created: <N> (queued: <M>)
   handoff: <path or "stdout">
   next: <one-line "what operator does next">
   === end planning final ===
   ```

3. Exit. Do not write further GitHub state. Do not mutate `state.json` beyond what `plan/init-queue` already did. Do not delete `.dev-loop` (planning does not interact with the loop sentinel — that's iter / review territory).

## Output

No verdict section follows this fragment. This is the hard terminus; the slash command shell exits after reading the `=== planning final ===` block.
