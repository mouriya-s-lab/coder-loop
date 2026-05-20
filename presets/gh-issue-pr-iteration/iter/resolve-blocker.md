# Fragment: iter/resolve-blocker

## Goal

Narrow a `kind:blocked` issue to the one blocking condition it promises to remove before entering implementation.

This route is for unblock work, not general feature work. The selected issue's deliverable is complete only when the named blocker no longer holds and the evidence proves that through the real path that was blocked.

## Applicability

Use only when `ISSUE_KIND` is `blocked`. If `ISSUE_KIND` is `code` or empty, return to `iter/classify-scope`. If `ISSUE_KIND` is `comment`, use `iter/spike-comment`. If `ISSUE_KIND` is `code-spike`, use `iter/source-writing-spike`.

## Procedure

1. Re-read the live issue body and comments gathered in `iter/read-context`.

2. Extract and record:
   - the `Unblocks: owner/repo#N` back-link, if present;
   - the exact blocking condition, including the command, runtime path, service, issue, PR, or evidence gap that made the upstream item blocked;
   - the minimum success condition that proves the blocker is gone.

3. Scope the iteration to removing that one blocker. Do not broaden into adjacent cleanup, unrelated implementation, issue-graph edits, or work in the unblocked repository unless the issue explicitly requires a cross-repo code change and `AGENT_CWD` points at that checkout.

4. Choose verification before editing. The verification plan must include:
   - the narrow local/unit checks needed for changed files;
   - an end-to-end or integration command that replays the blocked path and demonstrates the blocking condition no longer reproduces;
   - a note when the `Unblocks:` target cannot be resolved from available local runtime state, so review can avoid claiming unblock side effects it cannot perform.

5. If the issue body does not identify a concrete blocker, a concrete success condition, or enough local/runtime access to test the blocked path, do not invent one. Record the missing fact and hand off as blocked or handoff-only.

## Output verdict

Choose exactly one:

- `needs_implementation` -> read `iter/implement`.
- `handoff_only` -> read `iter/handoff` with evidence explaining why no PR was created.
- `blocked` -> read `iter/handoff` and record the attempted command/query proving the blocker.

Do not implement broad issue scope from this fragment. The next implementation fragment must stay inside the blocker-removal scope above.
