# Fragment: review/trace-honesty

## Goal

Compare iteration claims against trace, files, and live GitHub state.

## Retry conditions

Use `retry` if any required evidence is missing or false:

- iteration claims it read workflow/handoff but trace shows no read/query;
- claims tests passed but no command output is present;
- claims browser evidence exists but no screenshot paths or files are present;
- claims blocked but did not try the obvious next command/query;
- claims PR created but no live PR exists;
- claims PR was updated after review feedback but no new PR-thread comment exists (a PR body edit alone does not count — the PR body is immutable after creation; only a new PR-thread comment satisfies this check);
- claims done but PR body/evidence/checks are incomplete.

## Output verdict

Choose exactly one:

- `trace_valid` → read `review/pr-protocol`.
- `retry` → read `review/action-retry`.

Feedback must identify the exact false or missing claim and what the next iteration must produce.