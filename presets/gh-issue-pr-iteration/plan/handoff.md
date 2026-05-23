# Fragment: plan/handoff

## Goal

Record the planning outcome in a form the operator (and any future planning re-invocation) can read. Planning's deliverable is the GitHub issue set + queue; the handoff is the audit trail explaining what happened and why.

## Inputs

- The verdict from the upstream fragment (`queue_initialized` / `creation_failed` / `intake_needs_clarification` / etc).
- All material accumulated through the chain: classifications, draft bodies, validation findings, created issue numbers, queue state.

## Procedure

1. Write `{{TARGET_CWD}}/loop-data/chains/<chain>/runs/<runId>.plan.handoff.md` (or append to `<runId>.plan.txt` — the slash command shell will decide the exact path).

2. Required handoff sections:

   ```markdown
   # Planning run <runId>

   ## Outcome

   <one of: queue_initialized | partial_creation | intake_needs_clarification | classification_blocked | decompose_blocked | validation_blocked | queue_init_failed>

   ## What landed

   ### Issues created

   - `<repo>#<N>` — <title>  (kind:<code|comment>, [queued|filed-but-not-queued])
   - ...

   ### Parent / child links

   - `<repo>#<P>` ← `<repo>#<C>` (addSubIssue OK)
   - ...

   ### Queue state

   - Before: N items
   - Added: M items (#<list>)
   - After: N+M items
   - First selected: #<id>

   ## What did NOT land

   <if any issues failed to create, list them with the error>

   ## Open questions for operator

   <if intake_needs_clarification: list the questions verbatim>

   ## How to proceed

   <one of:>
   - `Queue is ready. Start with: /dev-loop` (when queue_initialized)
   - `Operator must answer the questions above, then re-invoke /dev-plan with augmented input` (when intake_needs_clarification)
   - `Operator must resolve <ambiguity>, then re-invoke /dev-plan` (when classification_blocked / decompose_blocked / validation_blocked)
   - `Manual recovery: <steps>` (when partial_creation or queue_init_failed)

   ## Trace

   Fragment chain walked this run:
   <list of fragment ids visited + their verdicts>
   ```

3. The handoff file goes to disk regardless of success / failure. Planning's audit trail matters most when planning failed — the operator needs to know what state the GitHub side and the queue are in.

4. **GitHub side**: do not post the handoff to any issue. Planning audit trail is local. The operator reads the handoff file directly; the slash command shell may also print a summary to stdout.

5. **State side**: if planning landed `queue_initialized`, the actionable queue is already in `central state DB` (from `plan/init-queue`). No further state mutation needed here.

## Failure handling

If writing the handoff file itself fails (disk full, permission), print the would-be content to stdout and exit non-zero. The slash command shell captures stdout, so the operator still sees the audit trail even if disk write failed.

## Output verdict

Choose exactly one:

- `handoff_written` → read `plan/final`.
- `handoff_failed` → read `plan/final` and include the file-write failure in the mandatory summary.

`plan/final` is the hard terminus; planning ends there regardless of which verdict reaches it.
