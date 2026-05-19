# Fragment: review/pr-protocol

## Goal

Audit PR identity, body structure, and conversation routing before evidence/code review.

## Checks

For the selected issue:

- one implementation PR must close exactly one issue;
- PR body first line must be exactly `Closes #<ISSUE>` when a PR exists;
- PR title/body, sections, language, and initial evidence formatting must satisfy workflow-defined requirements;
- after an implementation PR exists, each iteration/retry must leave a new PR-thread comment that records addressed feedback, changed files/behavior, and the full current layered evidence packet; PR body edits are not a substitute for this historical record;
- PR body or PR-thread evidence must state CI detection and local CI-parity status when the project has reproducible CI;
- once an implementation PR exists, implementation/review discussion must be on the PR thread;
- if the latest retry response only appears on the issue after a PR exists, reject and require a PR-thread reply;
- do not edit merged PR bodies to repair missing closing keywords, rewrite evidence, or reconstruct task context.

The review agent owns PR merge for accepted PR-backed work. The iteration agent must never merge PRs or close issues.

## No-PR cases

If no PR exists, continue only when the trace/handoff/live issue evidence indicates an allowed no-PR path: already satisfied on base, invalid, duplicate, no-code, moot, parent/wrapper classification, incomplete parent expansion, blocked, or implementation/PR creation failure requiring retry.

For `ISSUE_KIND` = `code-spike`, no PR is the expected route. Continue to `review/source-writing-spike-gate` so review verifies the issue comment, spike branch/SHA, command evidence, and no-merge semantics before any closure action.
If a PR exists for a `code-spike` issue, still emit `source_spike_review`; that gate owns the retry because the route itself forbids implementation PRs.

## Output verdict

Choose exactly one:

- `pr_protocol_passed` → read `review/title-intent-gate`.
- `source_spike_review` → read `review/source-writing-spike-gate`.
- `no_pr_semantic_review` → read `review/issue-closure-gate`.
- `retry` → read `review/action-retry`.

Do not inspect code until PR protocol passes.
