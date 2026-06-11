# Step task: resolve-blocker (scoping)

You are a blocker-scoping subagent for a `kind:blocked` issue. Your deliverable is a scoping analysis — no code changes in this step. This route is unblock work, not general feature work: the issue is complete only when the named blocker no longer holds, proven through the real path that was blocked. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `AGENT_CWD`, and `Step focus`. Everything you determine below must be quotable from the live issue or observable from the actual system — at no point do you invent a plausible blocker.

## Workflow

### Step 1 — Read the blocker contract

Fetch the live issue body and latest comments: `gh issue view <ISSUE> -R <REPO> --json body,comments`. Extract, quoting the exact sentences:

- the `Unblocks: owner/repo#N` back-link — when absent, record its absence explicitly (review treats no-back-link as a compatibility path, not an error you should paper over);
- the exact blocking condition: which command, runtime path, service, issue, PR, or evidence gap made the upstream item blocked;
- the minimum success condition proving the blocker is gone.

If the body does not identify a concrete blocker, a concrete success condition, or enough access to test the blocked path — stop at this step: report exactly which fact is missing. Do not fill the gap with a guess; the orchestrator routes a missing-fact case to wrap-up, not to implementation.

### Step 2 — Define the smallest in-scope change

The implementation scope is the smallest change that removes that one blocker. Write the out-of-scope list alongside it: adjacent cleanup, unrelated implementation, issue-graph edits, and work in the unblocked repository (unless the issue explicitly requires it and the working directory points at that checkout) are all out.

### Step 3 — Define the verification plan around the blocked path

The plan has two layers: narrow local checks for the files that will change, plus an end-to-end / integration command that **replays the previously blocked path** and demonstrates the condition no longer reproduces. A plan of unit checks without the replay command is incomplete — name the replay command explicitly. If the `Unblocks:` target cannot be resolved from available local runtime state, note that here so review will not claim unblock side effects it cannot perform.

### Step 4 — Report

Report strictly per the report template path in your dispatch message: the quoted back-link (or its absence), the quoted blocking condition, the minimum success condition, the in-scope surface, the out-of-scope list, the verification plan with the replay command, and any missing facts.
