# Fragment: common/github-routing

## Purpose

This fragment defines the pure GitHub issue/PR routing model: where durable task context, implementation evidence, graph edges, and review conversation belong.

## Core model

GitHub issues carry task semantics:

- problem statement, why, and expected outcome;
- scope boundaries and acceptance criteria;
- ownership, parent/child placement, and retroactive umbrellas;
- blockers, invalidity, duplicate/no-code status, and follow-up work.

Pull requests carry implementation semantics:

- diff cover letter;
- closing keyword for exactly one issue;
- reviewer-consumable evidence;
- CI/check status;
- implementation review conversation.

A PR is not a task container. A PR body is not the place to reconstruct or extend the task's why; put task motivation and follow-up work in issues.

## Opening work

- Do not open a PR without a real issue for it to close.
- If the work has no issue yet, create or identify the issue first, then open a PR whose body starts with the closing keyword for that issue.
- One PR closes one issue. If the work naturally closes multiple independent problems, split it into multiple issues and PRs unless it is one coherent refactor issue.
- PRs attach to issues through the closing keyword in the PR body, not through `addSubIssue`.

## Conversation routing

- Before an implementation PR exists, discuss task scope, blockers, invalidity, duplicate/no-code status, and retry feedback on the issue.
- Once an implementation PR exists, implementation and review discussion belongs on the PR thread.
- For an open PR, reply to review feedback on the PR thread, not on the issue.
- Post on the issue after a PR exists only when the issue topic itself is disputed, the work is blocked/skipped/no-code, or the current PR is explicitly invalid and a replacement issue/PR path is needed.
- Local handoff files, memory, or issue comments are not substitutes for PR-thread review once the PR exists.

## Updating open PRs

- For an open PR you are actively authoring, update the PR body when the initial evidence packet, closing keyword, or reviewer-visible proof is incomplete, wrong, or stale.
- When updating an open PR after review, also leave a PR comment summarizing what changed and which evidence was added or replaced.
- Continue an existing open PR/branch for retry work unless that PR is explicitly invalid or unusable.

## After merge

- Treat merged PRs as immutable workflow records. Do not edit merged PR bodies to repair missing closing keywords, rewrite evidence, or reconstruct task context.
- If a merged PR has a real defect or incomplete follow-up, open a new issue that states the problem and then a new PR that closes that issue.
- If a merged PR is correct, there is no reason to rewrite it; the task's why and follow-up context belong in the issue graph.
- If a merged PR missed its closing keyword, accept the orphaned graph edge or create a new issue/umbrella that references the PR in prose. Do not retrofit the old PR body.

## Graph boundaries

- Issues can be parent/child nodes. PRs cannot be sub-issue children.
- A child issue can have only one parent; competing parentage gets a prose reference, not a second sub-issue edge.
- Retroactive organization belongs in new issues or umbrella issues, not in edits to already-landed PR or issue bodies.
