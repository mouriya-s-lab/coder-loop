# Fragment: review/code-gate

## Goal

Audit diff/code scope, tests, live checks, and mergeability after PR protocol and evidence pass.

## Checks

Reject unless live PR metadata and diff review show:

- PR diff is scoped to exactly the selected issue;
- PR diff does not stage `.coder-loop/runtime/`, `.dev-loop`, or `.dev-trace.txt`;
- PR does not weaken tests;
- PR follows target project conventions;
- required GitHub checks are passing;
- pending/running checks have been actively observed, including check names, statuses, conclusions, timestamps, URLs, head SHA, elapsed time, and timeout/hang assessment;
- GitHub mergeability is clean enough to merge immediately.

Pending, failing, missing, unknown, timed-out, or hung checks are not mergeable evidence.

If CI is legitimately still running, retry with exact observed check state and instruction to observe again later. If CI appears timed out or hung, retry with feedback requiring iteration to reproduce/diagnose with local CI-parity evidence.

## Output verdict

Choose exactly one:

- `code_gate_passed` → read `review/issue-closure-gate`.
- `retry` → read `review/action-retry`.

Do not merge until this fragment passes.