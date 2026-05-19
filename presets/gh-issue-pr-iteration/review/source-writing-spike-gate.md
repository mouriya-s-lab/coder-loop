# Fragment: review/source-writing-spike-gate

## Goal

Audit `kind:code-spike` output without treating it as PR-backed implementation. A source-writing spike may produce a branch, PoC files, command logs, screenshots, and an issue comment, but review must not merge a PR or require an implementation PR before accepting the spike result.

## When this gate runs

- `ISSUE_KIND` is `code-spike` and no PR exists for the selected issue -> run this gate.
- `ISSUE_KIND` is `code-spike` and a PR exists -> emit `source_spike_retry`; source-writing spike output must not be represented as an implementation PR unless the issue was relabeled to `kind:code`.
- `ISSUE_KIND` is `code`, `comment`, or empty -> skip this gate via the normal PR/no-PR route.

## Inputs

- Live issue body and comments via `gh issue view {{ISSUE}} -R {{REPO}} --json body,comments,labels`.
- Iter handoff at `{{CURRENT_ISSUE_FILE}}`.
- Evidence artifacts under `{{EVIDENCE_DIR}}`.
- Optional pushed spike branch named in the issue comment or handoff.

## Procedure

1. Locate the issue comment for this run by matching `{{RUN_ID}}` or the comment URL recorded in handoff.
2. Verify the comment clearly states this is no-merge spike evidence and not production implementation.
3. Verify the comment or handoff records the spike branch and head SHA when source files were changed. If the branch was not pushed, verify the comment explains why a local-only branch is sufficient evidence.
4. Verify every command promised by the issue's `## 验收标准` / `## 验证步骤` has a corresponding exit status and concise output or artifact reference.
5. If `Browser evidence required` is `true`, verify browser evidence exists when the spike has browser-observable behavior. If it does not, require an explicit not-applicable reason tied to the issue scope.
6. If the issue has `## 结果分支`, verify the comment selects exactly one branch and proposes any follow-up issue titles required by that branch.
7. Verify no implementation PR exists for this issue and no review path is asking to run the PR merge command.

## Failure handling

Emit `source_spike_retry` if:

- no run-matching issue comment exists;
- evidence artifacts are missing, stale, or not mapped to commands;
- source changes exist but no branch/SHA or local-only justification is recorded;
- required browser evidence is missing without a scope-based not-applicable reason;
- required follow-up titles are missing or vague;
- a PR exists for the source-writing spike route.

Retry feedback belongs on the issue thread because this route has no PR.

## Output verdict

Choose exactly one:

- `source_spike_passed` -> read `review/issue-closure-gate`.
- `source_spike_skipped` -> read `review/title-intent-gate`.
- `source_spike_retry` -> read `review/action-retry`.

Do not merge or close anything from this fragment. Terminal action fragments perform side effects.
