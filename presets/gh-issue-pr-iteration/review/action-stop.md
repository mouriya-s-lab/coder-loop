# Fragment: review/action-stop

## Goal

Stop the loop for mechanical completion or review infrastructure failure.

## Use cases

Use this only when:

- no actionable queue item exists and global assessment confirms the loop is complete;
- review infrastructure is broken and state cannot be safely audited or updated;
- the trace file or required runtime files are unavailable and continuing would create a tight loop or corrupt state;
- a required GitHub side effect failed before durable feedback/closure/linking was published, so local state must not be advanced as if the side effect succeeded.

Do not use stop for bad code, weak evidence, failed tests, PR conflicts, pending checks, merge failure, or unproven blocked/skipped claims. Those are retry or blocked.

## Procedure

- If state can be read, record the actionable/non-actionable classification before stopping.
- If state cannot be read, record the exact infrastructure failure.
- Remove `.dev-loop` only for mechanical completion or infrastructure failure.
- Do not mark the selected issue `done`, `moot`, or `blocked` unless the appropriate action fragment already proved and performed that transition.

## Output verdict

Choose exactly one:

- `loop_stopped` → read `review/final` with verdict `stop`.
- `stop_not_allowed` → read `review/action-retry`.