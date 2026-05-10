# Fragment: review/read-evidence

## Goal

Collect all evidence required for review before making a verdict.

## Required reads

Read, in order:

1. trace file;
2. workflow file;
3. shared context file;
4. state file;
5. current issue handoff file if an issue is selected;
6. target repo `CLAUDE.md` as project reference;
7. live GitHub issue/PR/check state.

If no selected issue exists, skip issue-specific audit and proceed to `review/global-assessment`.

## GitHub reads

For the selected issue:

```bash
gh issue view <ISSUE> -R <REPO> --json number,title,body,labels,comments,state,url,closedByPullRequests
gh api "repos/<REPO>/issues/<ISSUE>/sub_issues" -H "X-GitHub-Api-Version: 2026-03-10"
gh pr list -R <REPO> --state all --search "<ISSUE> in:body" --json number,title,state,mergedAt,headRefName,url,body,statusCheckRollup,mergeStateStatus
```

For every child/subtask issue returned by the API or clearly referenced in body/comments:

```bash
gh issue view <CHILD_NUMBER> -R <REPO> --json number,title,body,state,url,labels,comments,closedByPullRequests
gh pr list -R <REPO> --state all --search "<CHILD_NUMBER> in:body" --json number,title,state,mergedAt,url,body
```

For every candidate implementation PR:

```bash
gh pr view <PR_NUMBER> -R <REPO> --json number,title,state,mergedAt,mergeCommit,url,body,comments,reviews,statusCheckRollup,mergeStateStatus,headRefName
gh api repos/<REPO>/pulls/<PR_NUMBER>/comments
```

## Output verdict

Choose exactly one:

- `evidence_loaded` → read `review/trace-honesty`.
- `no_selected_issue` → read `review/global-assessment`.
- `review_infrastructure_broken` → read `review/action-stop` if present in the index, otherwise proceed to `review/global-assessment` with the exact failure.

If the trace file cannot be read, use `review_infrastructure_broken`.