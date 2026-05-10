# Fragment: review/global-assessment

## Goal

Decide mechanically whether the loop should continue after issue-specific review.

This fragment only classifies the current queue after the fixed transition fragments have already done their side effects and state updates.

## Procedure

After issue-specific state update, read the latest state file again and classify every queue item:

- actionable: `queued`, `in_progress`, `changes_requested`;
- non-actionable: `blocked`, `moot`, `done`.

Print a table:

```text
Issue | Status | Classification | Reason
#N    | queued | actionable     | ready for iteration
```

Then print:

```text
Actionable: N | In-progress/changes-requested included: N | Non-actionable: N
```

## Decision rule

- If actionable count > 0, leave `.dev-loop` untouched.
- If actionable count == 0, remove `.dev-loop`.
- If review infrastructure is broken and state cannot be updated/audited, remove `.dev-loop`.

Never remove `.dev-loop` just because the current issue needs retry.

## Output verdict

Choose exactly one:

- `loop_continues` → read `review/final`.
- `loop_stopped_complete` → read `review/final`.
- `loop_stopped_infrastructure` → read `review/final`.