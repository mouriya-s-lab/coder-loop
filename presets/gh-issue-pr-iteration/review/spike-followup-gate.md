# Fragment: review/spike-followup-gate

## Goal

For `kind:comment` issues (spike / design dialogue), verify that the iter-posted comment actually delivers what the issue's `## 结果分支` requires, including the minimum number of follow-up sub-issue proposals.

This gate exists because spike issues' value is in the follow-up they unlock. A spike that posts "yes the assumption holds" without proposing the implementation issue, or "the assumption fails" without proposing the design-question issue, has not delivered the deliverable promised in `## 结果分支`.

## When this gate runs

- `ISSUE_KIND` is `comment` → run the gate.
- `ISSUE_KIND` is `code` or `blocked` → skip via `spike_gate_skipped`. PR-backed code and blocker-resolution issues do not have a spike comment deliverable.
- `ISSUE_KIND` is `code-spike` → skip via `spike_gate_skipped`. Source-writing spike follow-up is verified by `review/source-writing-spike-gate`.
- `ISSUE_KIND` is empty (legacy unlabeled) → skip via `spike_gate_skipped`. Legacy issues are not spike-shaped.

## Inputs

- Live issue body: `gh issue view {{ISSUE}} -R {{REPO}} --json body,comments`. Re-fetch every time; do not trust the iter trace's snapshot.
- Latest issue comments: same call, `comments` field. The iter-posted comment is the most recent comment authored by the iter agent.
- Iter handoff at `{{SHARED_CONTEXT_FILE}}` for the proposed sub-issue list and the iter agent's stated comment URL, plus optional issue-local details at `{{CURRENT_ISSUE_FILE}}` when that path is non-empty and exists.

## Procedure

1. Re-fetch live body + comments.

2. Locate the latest comment posted by the iter agent for this run (cross-reference with `{{RUN_ID}}` or recency + handoff's stated comment URL).

3. Read the issue body's `## 结果分支` section. This section enumerates what should happen on each spike outcome (commonly `If passed:` / `If failed:` lines) and may name required follow-up sub-issues:
   - `If passed: proceed to implementation issue #<N>` — requires the comment to either confirm `#<N>` already exists, or propose its title if it does not.
   - `If failed: create a design-question issue` — requires the comment to propose at least 1 child issue title.
   - `If <other condition>: <action>` — requires the comment to address that condition and any sub-issue / child issue it implies.

4. Extract from the iter comment:
   - the picked branch (which `## 结果分支` line the comment selected);
   - the count of proposed follow-up sub-issue titles (look for proposal markers like `Proposed sub-issue:`, `提议 sub-issue`, bullet list under a `## 提议 follow-up` heading, or any clear enumeration of titles tagged as proposals);
   - the recommended next state for the spike issue itself (Closes / Replaces / Blocks).

5. Validate:
   - The comment must select exactly one branch from `## 结果分支`. Zero or multiple selections → fail.
   - The count of proposed sub-issue titles must meet the minimum required by the selected branch. The minimum is: at least 1 child issue if the branch text contains `create`, `file`, `propose`, `开`, `提议`, `创建`, or names a specific follow-up issue type. If the branch is "no follow-up needed" (e.g. `If passed: no action`), 0 sub-issue proposals are allowed.
   - Each proposed sub-issue title must be concrete (not a placeholder like `TBD` or `<title>`). Vague proposals do not satisfy the minimum.

## Failure handling

Emit `spike_followup_failed` if:

- the comment posts no branch selection;
- the comment selects a branch that requires sub-issue proposals but proposes fewer than the minimum or none;
- proposed sub-issue titles are placeholders/vague;
- the comment URL stated in handoff cannot be located in the live comment thread (comment was never actually posted, or posted to wrong issue).

Retry feedback (posted on the issue, not on a PR — there is no PR) must:

- quote the issue's `## 结果分支` lines verbatim;
- quote the iter comment's selected branch (or note that none was selected);
- list the missing or vague sub-issue title slots;
- instruct iteration to repost or amend the comment with the required follow-up titles.

## Output verdict

Choose exactly one:

- `spike_followup_passed` → read `review/code-gate`. Code-gate will self-skip since there is no PR for a comment-kind issue.
- `spike_gate_skipped` → read `review/code-gate`. Gate did not apply (`ISSUE_KIND` ≠ `comment`).
- `spike_followup_failed` → read `review/action-retry`. Retry feedback must cite the missing branch selection or sub-issue proposals.

Do not advance to issue closure for a `kind:comment` issue while spike follow-up is incomplete.
