# Fragment: review/index

## Goal

Start one review invocation and follow the review fragment chain. Review is the acceptance and loop-control gate; human review is not a substitute.

## Required reads

Before role-specific review, read these common fragments from the entry prompt's fragment index:

1. `common/runtime-contract`
2. `common/github-routing`
3. `common/state-contract`

Then read `review/read-evidence`.

## Review ownership

Review owns:

- trace audit;
- PR protocol audit;
- evidence audit;
- code/check/mergeability audit;
- issue hierarchy and final closure gate;
- PR merge when accepted;
- issue closure when complete or skipped;
- child issue creation/linking when parent scope is incomplete;
- final local state transition;
- global loop stop/continue decision.

Review must not repair implementation evidence itself: do not run tests, start servers, capture screenshots, or make code changes to fix the PR.

## Phase order

Run review in this order:

1. `review/read-evidence`
2. `review/trace-honesty`
3. `review/pr-protocol`
4. `review/evidence-gate`
5. `review/commitment-gate`
6. `review/code-gate`
7. `review/issue-closure-gate`
8. one terminal action fragment
9. `review/update-state`
10. `review/global-assessment`
11. `review/final`

Do not inspect a later semantic phase until the previous gate has passed, except when the issue has no implementation PR and is being evaluated as no-code/already-satisfied/skip.