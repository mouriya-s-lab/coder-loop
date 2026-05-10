# Fragment: review/action-expand-parent

## Goal

Create/link child issues for remaining parent scope and prepare queue front insertion.

## Preconditions

Use this only when `review/issue-closure-gate` found remaining coherent deliverables not represented by complete child issues or a merged PR.

## Procedure

For each remaining coherent deliverable, create one child issue. The child issue body must follow the pure issue-writing model: one issue, one problem; problem and expected outcome in the issue; implementation details left to the PR; acceptance criteria expressed as executable checkpoint rows when this is future implementation work. Use the target workflow-defined issue language and section style; the structure below is semantic, not a requirement to use English headings.

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

<what coherent remaining problem is not yet represented by complete child issues or a merged PR>

## Expected Outcome

<observable final state>

## Constraints

<only externally imposed constraints from the parent issue, workflow, or reviewed evidence>

## Acceptance Criteria

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | <verify the outcome> | `<workflow command or issue-specific command>` | <local / CI / target env> | <expected output or exit code> |

## Inherited Verification Obligations

<only if parent had verification obligations that cannot be dropped; otherwise write "None">

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

Prepare a queue item for each new child:

```json
{
  "issue": 123,
  "status": "queued",
  "attempts": 0,
  "title": "<child issue title>",
  "priority": "<inherit parent priority>",
  "branch": null,
  "pr": null,
  "lastRunId": null,
  "issueFile": ".coder-loop/runtime/issues/123.md",
  "evidenceDir": ".coder-loop/runtime/evidence/issue-123"
}
```

Initialize the local child bookkeeping before state insertion:

- create or update `.coder-loop/runtime/issues/<child>.md` with the child issue URL, parent issue number, remaining task summary, acceptance criteria, and evidence requirements;
- create `.coder-loop/runtime/evidence/issue-<child>/` if it does not exist;
- do not stage these `.coder-loop/runtime/` files into any feature commit.

Before creating the child, self-check that it describes one coherent remaining problem, contains no unchecked checklist acceptance criteria, does not prescribe implementation internals, and does not expose loop run IDs or other local scaffolding in the GitHub body.

Do not close the parent issue. Do not mark the parent final. Leave `.dev-loop` untouched.

## Output verdict

Choose exactly one:

- `parent_expanded` → read `review/update-state` with transition `expanded incomplete parent`.
- `parent_expansion_failed` → read `review/action-retry` with the exact child creation/linking failure.