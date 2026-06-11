# Step task: resolve-blocker (scoping)

You are a blocker-scoping subagent for a `kind:blocked` issue. Your deliverable is a scoping analysis — no code changes in this step. This route is unblock work, not general feature work: the issue is complete only when the named blocker no longer holds, proven through the real path that was blocked.

## Inputs

From your dispatch message you consume: `ISSUE`, `REPO`, `AGENT_CWD`, and `Step focus`. You fetch the live issue body and comments yourself (below); everything you determine must be quotable from them or from the actual system.

## Procedure

1. Fetch the live issue body and latest comments (`gh issue view <ISSUE> -R <REPO> --json body,comments`).
2. Extract and record:
   - the `Unblocks: owner/repo#N` back-link, if present (if absent, note that explicitly — review treats no-back-link as a compatibility path);
   - the exact blocking condition: which command, runtime path, service, issue, PR, or evidence gap made the upstream item blocked;
   - the minimum success condition proving the blocker is gone.
3. Define the implementation scope as the smallest change removing that one blocker. List what is explicitly out of scope (adjacent cleanup, unrelated implementation, issue-graph edits, work in the unblocked repository unless the issue explicitly requires it and the working directory points at that checkout).
4. Define the verification plan: the narrow local checks for files that will change, plus an end-to-end / integration command that **replays the blocked path** and demonstrates the condition no longer reproduces. If the `Unblocks:` target cannot be resolved from available local runtime state, note it so review will not claim unblock side effects it cannot perform.
5. If the issue body does not identify a concrete blocker, a concrete success condition, or enough access to test the blocked path — do not invent one. Report exactly which fact is missing.

## Report

Report strictly per the report template path given in your dispatch message.
