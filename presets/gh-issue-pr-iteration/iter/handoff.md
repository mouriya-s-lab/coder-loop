# Fragment: iter/handoff

## Goal

Write durable local handoff for review without deciding final state.

## Procedure

Append a concise run note to the chain handoff/shared file (`{{SHARED_CONTEXT_FILE}}`) with:

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

If `{{CURRENT_ISSUE_FILE}}` is non-empty and already exists, you may append the same note or issue-local details there. A missing per-issue handoff file is not a handoff failure.

Do not set final state in `central SQLite state DB`. Do not reorder queue items. Do not close GitHub issues. Do not remove central daemon scheduling state.

## Output verdict

Choose exactly one:

- `handoff_written` → read `iter/final`.
- `handoff_failed` → read `iter/final` and include the exact failure in the mandatory summary.
