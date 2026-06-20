# Action: expand incomplete parent

Create/link child issues for remaining parent scope and prepare front-of-queue insertion. Use only when closure judgment found remaining coherent deliverables not represented by complete child issues or a merged PR.

## Create and link each child

One child per remaining coherent deliverable. The body follows the pure issue-writing model: one issue, one problem; problem and expected outcome in the issue; implementation left to the PR; executable checkpoint rows for future work. Use the target workflow's issue language; the structure below is semantic.

```bash
CHILD_URL=$(gh issue create -R <REPO> \
  --title "<remaining-task title>" \
  --body "$(cat <<'EOF'
Parent issue: #<ISSUE>

## Goal

<what this child issue must complete>

## Context

- **Repo**: <REPO>
- **Parent issue**: #<ISSUE>
- **Source**: parent issue #<ISSUE> and reviewed evidence

## Problem

<the coherent remaining problem>

## Expected Outcome

<observable final state>

## Constraints

<only externally imposed constraints>

## Acceptance Criteria

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | <verify the outcome> | `<command>` | <env> | <expected> |

## Inherited Verification Obligations

<only if the parent had obligations that cannot drop; otherwise "None">

## Dependencies

- Depends on: #<ISSUE>（parent expansion source）
EOF
)")
CHILD_NUMBER=$(echo "$CHILD_URL" | grep -o '[0-9]*$')
PARENT_ID=$(gh api graphql -F num=<ISSUE> -f query='
  query($num:Int!){repository(owner:"<OWNER>",name:"<REPO_NAME>"){
    issue(number:$num){id}}}' --jq '.data.repository.issue.id')
CHILD_ID=$(gh api graphql -F num=$CHILD_NUMBER -f query='
  query($num:Int!){repository(owner:"<OWNER>",name:"<REPO_NAME>"){
    issue(number:$num){id}}}' --jq '.data.repository.issue.id')
gh api graphql -f query='
  mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){
    subIssue{number title}issue{number title}}}' \
  -f p="$PARENT_ID" -f c="$CHILD_ID"
```

Before creating, self-check: one coherent problem; no unchecked-checkbox acceptance; no prescribed implementation internals; no loop run IDs or local scaffolding in the GitHub body. Each child's body must follow the §1.2 deliverable shape (implementation-PR / unblock / comment-spike / source-writing-spike) that matches its intended work; the deliverable signal lives in the body, not in any label.

## Queue front-insertion

The new children must be **inserted before** any pre-existing queued siblings, in creation order — never appended. Initialize local bookkeeping first: per child, create/update `loop-data/chains/<chain>/issues/<child>.md` (issue URL, parent, summary, acceptance, evidence requirements) and `loop-data/chains/<chain>/evidence/issue-<child>/`; never stage these into feature commits.

Do not close the parent or mark it final.

## After

Children created + linked + bookkeeping initialized → write state per `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/review/actions/state-write.md` with transition `expanded incomplete parent` (it owns the batch-add/reorder commands). Creation/linking failed → take the retry action with the exact failure.
