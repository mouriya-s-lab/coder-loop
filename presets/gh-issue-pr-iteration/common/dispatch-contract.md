# Fragment: common/dispatch-contract

## Purpose

This fragment defines the runner-neutral contract between an orchestrator and its subagents. The workflow owns **what** to dispatch, dependencies, and acceptance. The active runner owns **how** spawn, wait, completion delivery, follow-up, and cancellation are transported.

Do not name or emulate another runner's tools. Use only the subagent controls exposed by the current runner's system/tool surface.

## Dispatch record

Before each dispatch, append one authoritative ledger row:

```text
<step> | <task-id> | dispatched | <Step focus>
```

The task id returned by the runner binds the eventual report to the workflow line. The ledger is the run's subtask state; the checklist is a planning view and does not need to be reprinted after every transition.

For independent ready steps, dispatch them in the same round so the runner may execute them concurrently. For dependent steps, wait for and accept the prerequisite first.

## Completion delivery

Runner transports have two explicit shapes:

- **Immediate completion**: the dispatch/wait control returns the completed subagent report. Judge that report now.
- **Deferred completion**: the dispatch returns only an id/receipt and the runner later resumes or notifies you with the completed report. Record the id, yield as required by the runner, and judge only after the completion payload arrives.

A launch receipt, task id, status summary, or transcript path is not a report. Do not infer findings before the completed report exists. Do not read a full conversation transcript when the runner already supplies the subagent's final report.

## Report judgment

Match the completed report to its ledger row, then apply the owning step file's `Acceptance` section:

1. Required report fields are present.
2. The report addresses the issue-specific `Step focus`.
3. Its claims satisfy the issue contract plus `quality/honesty.md` and `quality/evidence.md`.

Record exactly one result:

```text
<step> | <task-id> | accepted | <declared side effects>
<step> | <task-id> | rejected | <missing fields, gaps, or wrong direction>
```

## Follow-up

When the report is rejected, use the current runner's supported follow-up operation on that subagent when one exists. Otherwise close/cancel that task through the runner and dispatch a fresh subagent. In either case, send only the missing fields, gap list, or corrected scope as the new `Step focus`; the step file remains the task contract.

This capability branch is transport-only. It must not change the workflow's required steps, acceptance criteria, or verdict.

## Boundary

This fragment owns dispatch transport and the authoritative subtask ledger only. Entry workflows own task decomposition and dependencies. Step files own Task / Report / Acceptance. Quality files own cross-step judgment. Action files own external effects and final state transitions.
