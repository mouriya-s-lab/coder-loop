# Fragment: iter/index

## Goal

Start exactly one iteration for the selected issue and follow the iteration fragment chain.

## Required reads

Before role-specific work, read these common fragments from the entry prompt's fragment index:

1. `common/runtime-contract`
2. `common/github-routing`
3. `common/state-contract`

Then read `iter/read-context`.

## Iteration ownership

Iteration produces implementation signal. The exact deliverable depends on `ISSUE_KIND`:

- `ISSUE_KIND` is `code` or empty (legacy unlabeled) — PR-backed code path:
  - understand selected issue scope;
  - continue existing branch/PR when retrying (`ISSUE_STATUS == changes_requested`) or when resuming an interrupted iteration (`RUN_ID_GENERATION == resumed`);
  - implement one complete deliverable when required;
  - run required verification and collect reviewer-visible evidence;
  - create/update the implementation PR when code changed;
  - append a handoff note.
- `ISSUE_KIND` is `code-spike` — source-writing no-merge spike path:
  - understand selected spike scope;
  - continue existing spike branch when retrying or resuming;
  - write the minimal PoC/source/evidence needed to answer the spike;
  - post the result as an issue comment with evidence artifacts and branch/SHA when useful;
  - do not open a PR, merge anything, close the issue, or write final local state.
- `ISSUE_KIND` is `comment` — comment path (spike / design dialogue):
  - understand the selected issue's question and result branches;
  - post a GitHub issue comment with the answer + cited evidence;
  - propose any follow-up sub-issue titles in the comment (do not file them — review action layer handles creation);
  - do not write code, do not open a PR, do not edit the issue body;
  - append a handoff note with the posted comment URL.

Iteration must not create child issues, link sub-issues, merge PRs, close issues, remove `.dev-loop`, reorder/prepend queue items, or mark final local state, regardless of `ISSUE_KIND`.

## Next fragment

Read `iter/read-context`.
