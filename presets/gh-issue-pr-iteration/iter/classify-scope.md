# Fragment: iter/classify-scope

## Goal

Classify what kind of work the selected issue requires.

This fragment is for `kind:code` and legacy unlabeled PR-backed work. `kind:blocked` must route through `iter/resolve-blocker` first so the implementation scope is limited to removing the named blocker.

## Procedure

- Read the full issue body and latest comments.
- Follow explicit dependencies mentioned in the issue body/comments.
- Read linked PRs for dependency issues when relevant.
- Determine whether the issue is atomic implementation work, retry work, already satisfied on the base branch, blocked by missing infrastructure/access, parent/wrapper-only, moot/duplicate/invalid, or incomplete parent/wrapper scope.

## Parent and wrapper handling

If the issue is parent/wrapper-only or contains remaining scope that should be split:

- gather evidence for the classification;
- propose child issue titles, expected outcomes, acceptance criteria, evidence requirements, and why each child is a separate coherent deliverable;
- record the proposal in handoff;
- do not create child issues, link sub-issues, close the parent, or change queue ordering.

## Already satisfied / skip handling

If the issue appears already satisfied, invalid, duplicate, no-code, or moot:

- gather live evidence;
- record it in handoff;
- do not close the issue or set final state.

## Output verdict

Choose exactly one:

- `needs_implementation` → read `iter/implement`.
- `handoff_only` → read `iter/handoff`.
- `blocked` → read `iter/handoff` and record the attempted command/query proving the blocker.

Do not use `handoff_only` to avoid work that is actually implementable.
