# Fragment: review/issue-closure-gate

## Goal

Decide whether the GitHub issue can be closed, must be expanded into child issues, should be skipped, should be blocked, or needs retry.

## Applicability

Run this gate before any local `done` or `moot` transition.

- PR-backed work must pass PR protocol, evidence, and code gates. Its implementation PR must be merged by `review/action-accept-pr` before local `done` is written.
- Source-writing spike work (`ISSUE_KIND` = `code-spike`) must pass `review/source-writing-spike-gate`; it is accepted through `accepted_no_pr` and must never route to `review/action-accept-pr`.
- No-code, duplicate, invalid, already-satisfied, parent/wrapper, and moot outcomes still need this gate before local `done` or `moot`.

## Classification

Classify the selected issue as one of:

- `atomic`: one complete deliverable with no child scope;
- `parent/wrapper`: primarily coordinates explicit or implicit child deliverables;
- `has_child_issues`: GitHub sub-issues or clearly linked child issues exist;
- `incomplete_parent`: remaining scope is not represented by closed child issues or a merged PR;
- `invalid_or_no_code`: invalid, duplicate, out of scope, no-code, already satisfied, or truly moot;
- `blocked`: a real external dependency prevents progress.

Fixed classification rules:

- Parent/wrapper is not a skip reason by itself. If child/current scope is complete, accept/close it; if remaining scope exists, expand it; if a real external dependency exists, block it.
- `skip` is only for issues that should not produce implementation work at all: duplicate, invalid, out-of-scope, no-code, or truly moot.
- `accepted_no_pr` is only for already-satisfied-on-base, complete no-code closure, or a complete source-writing spike where local `done` is the correct semantic result.
- A closed child issue without a merged PR counts as complete only when its issue history explicitly justifies no-code/duplicate/invalid/out-of-scope/already-satisfied/moot closure.
- If the selected issue has an open implementation PR, do not use `accepted_no_pr` or `skip` unless the PR is explicitly invalid/unusable and feedback is routed accordingly.

## Child closure table

For every child/subtask issue, build this table in the review note or handoff:

```text
Child issue | Issue state | Closing/candidate PR | PR merged? | Conclusion
#N          | CLOSED      | #M                   | yes        | complete
```

A child is complete only when the child issue is `CLOSED` and its implementation PR is `MERGED`, or issue history proves no-code/duplicate/invalid/out-of-scope/already-satisfied/moot closure.

## Current issue completeness

The current issue is complete only when:

- all explicit child/subtask issues are complete;
- every corresponding implementation PR is merged or no-code closure is justified;
- current acceptance criteria and comments have no unresolved scope;
- the current implementation PR, if any, passed previous phases;
- the current source-writing spike, if `ISSUE_KIND` is `code-spike`, passed `review/source-writing-spike-gate`;
- no coherent deliverable remains to split out.

## Output verdict

Choose exactly one:

- `accepted_pr` → read `review/action-accept-pr`.
- `accepted_no_pr` → read `review/action-accept-no-pr`.
- `expand_parent` → read `review/action-expand-parent`.
- `skip` → read `review/action-skip`.
- `blocked` → read `review/action-blocked`.
- `retry` → read `review/action-retry`.

Do not set local final state from this fragment. Terminal action fragments perform side effects.
