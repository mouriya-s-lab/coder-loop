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

Iteration produces implementation signal:

- understand selected issue scope;
- continue existing branch/PR when retrying (`ISSUE_STATUS == changes_requested`) or when resuming an interrupted iteration (`RUN_ID_GENERATION == resumed`);
- implement one complete deliverable when required;
- run required verification and collect reviewer-visible evidence;
- create/update the implementation PR when code changed;
- append a handoff note.

Iteration must not create child issues, link sub-issues, merge PRs, close issues, remove `.dev-loop`, reorder/prepend queue items, or mark final local state.

## Next fragment

Read `iter/read-context`.