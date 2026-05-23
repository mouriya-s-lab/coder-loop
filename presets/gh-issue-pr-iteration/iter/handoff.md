# Fragment: iter/handoff

## Goal

Write durable local handoff for review without deciding final state.

## Procedure

Append a concise run note to the current issue handoff file with:

- run ID;
- classification and what was done;
- files changed;
- commands run and outcomes;
- CI detection result and local CI-parity status;
- screenshots/artifacts captured;
- PR number/link if any;
- blockers or unresolved risks;
- proposed child issue titles, expected outcomes, acceptance criteria, evidence requirements, and split rationale when parent scope is incomplete;
- proposed shared-context additions, if any.

Do not set final state in `central SQLite state DB`. Do not reorder queue items. Do not close GitHub issues. Do not remove central daemon scheduling state.

## Output verdict

Choose exactly one:

- `handoff_written` → read `iter/final`.
- `handoff_failed` → read `iter/final` and include the exact failure in the mandatory summary.