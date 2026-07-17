# Step: resolve-blocker

The blocker-scoping runbook for an unblock-deliverable issue. Iteration executes this step inline in its own session — this preset forbids subagents, so treat the sections below as your own instruction set, not a task spec for a nested agent. The deliverable is a scoping analysis — no code changes here. This route is unblock work, not general feature work: the issue is complete only when the named blocker no longer holds, proven through the real path that was blocked.

## Task

From the iteration's runtime bindings and your Step focus: `ISSUE`, `REPO`, `AGENT_CWD`, and `Step focus`. Everything you determine must be quotable from the live issue or observable from the actual system — never invent a plausible blocker.

1. **Read the blocker contract.** Fetch the live issue body and latest comments: `gh issue view <ISSUE> -R <REPO> --json body,comments`. Use the marker Deliverable/Checks/Dependencies for execution and quote the issue/comment sentences that establish blocker intent:
   - the `Unblocks: owner/repo#N` back-link — when absent, record its absence explicitly (review treats no-back-link as a compatibility path, not an error);
   - the exact blocking condition: which command, runtime path, service, issue, PR, or evidence gap made the upstream item blocked;
   - the minimum success condition proving the blocker is gone.

   If the body does not identify a concrete blocker, a concrete success condition, or enough access to test the blocked path — stop here: record exactly which fact is missing in your handoff. Do not fill the gap with a guess; missing-fact cases route to iteration wrap-up (planning-stage exception).
2. **Define the smallest in-scope change.** The implementation scope is the smallest change that removes that one blocker. Write the out-of-scope list alongside it: adjacent cleanup, unrelated implementation, issue-graph edits, and work in the unblocked repository (unless the issue explicitly requires it and the working directory points at that checkout) are all out.
3. **Define the verification plan around the blocked path.** Two layers: narrow local checks for the changing files, plus an end-to-end / integration command that **replays the previously blocked path** and demonstrates the condition no longer reproduces. A plan of unit checks without the replay is incomplete — name the replay command explicitly. If the `Unblocks:` target cannot be resolved from available local runtime state, note that here.

## Report

```markdown
## Why this scoping
<how you identified the blocking condition from the issue body/comments; quotes backing it>

## What I actually determined
<the back-link (or its explicit absence); the exact blocking condition; the minimum
success condition; the in-scope change surface; the out-of-scope list; the verification
plan including the blocked-path replay command>

## Problems
<missing facts (no concrete blocker / success condition / access to the blocked path);
ambiguities you need to resolve before the next iteration step; anything touched for the cleanup ledger>
```

## Acceptance

Report structurally missing any of the three sections → send back before judging substance.

- **Concreteness** — the blocking condition names an actual command / path / service / evidence gap, quoted from the live issue, not paraphrased into vagueness. The success condition is observable.
- **Replay present** — the verification plan contains a command that replays the blocked path end-to-end. A plan of unit checks only is a gap: blocked-resolution evidence must be at least as strong as ordinary code evidence **plus** the replay.
- **Minimal scope** — the in-scope surface is the smallest blocker removal; broadening into adjacent work is a gap.
- **No invention** — if facts were missing, the report says which, rather than fabricating a blocker. Don't push to implementation in that case: record the missing facts and wrap up — review owns the blocked/retry classification.

On acceptance, carry the scoping (blocker, success condition, out-of-scope list, replay command) into the `Step focus` of the implement and verify steps you run next — those steps must stay inside this scope.
