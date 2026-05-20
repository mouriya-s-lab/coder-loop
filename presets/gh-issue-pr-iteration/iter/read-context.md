# Fragment: iter/read-context

## Goal

Collect the selected issue context before making implementation decisions.

## Inputs

Use the concrete runtime values from the entry prompt: target working directory (where state / issues / evidence live), agent working directory (your `cwd`; equals target for in-repo work, points at a different repo's checkout for cross-repo iteration), repository, base branch, current issue, run ID, workflow file, shared context file, state file, current issue handoff, evidence directory, branch/PR fields, queue status, previous run ID, run-ID generation, and resumed-from phase.

## Procedure

Read in order:

1. workflow file;
2. shared context file;
3. state file and confirm the selected issue matches the entry prompt;
4. current issue handoff file;
5. target repo `CLAUDE.md` as project reference;
6. live GitHub issue state;
7. linked/open PR state.

Use commands shaped like:

```bash
gh issue view <ISSUE> -R <REPO> --json title,body,labels,comments,state,url
gh pr list -R <REPO> --state open --search "<ISSUE> in:body" --json number,title,headRefName,url,body,statusCheckRollup,mergeStateStatus
```

If a PR exists for the selected issue, read its full review thread before changing code:

```bash
gh pr view <PR_NUMBER> -R <REPO> --json title,body,comments,reviews,statusCheckRollup,mergeStateStatus,headRefName,url
gh api repos/<REPO>/pulls/<PR_NUMBER>/comments
```

If retrying (queue status is `changes_requested` and previous run ID is non-empty), treat the newest coder-loop PR review/comment as the primary instruction. Do not create a replacement branch or PR unless the existing PR is explicitly invalid or unusable.

## Output verdict

Choose exactly one:

- `context_ready` → branch by `ISSUE_KIND`:
  - `ISSUE_KIND` is `comment` → read `iter/spike-comment`. The deliverable is an issue comment + sub-issue 列表, not code.
  - `ISSUE_KIND` is `code-spike` → read `iter/source-writing-spike`. The deliverable is source-writing spike evidence + issue comment, not a PR.
  - `ISSUE_KIND` is `blocked` → read `iter/resolve-blocker`. The deliverable is PR-backed blocker removal with e2e proof that the blocked path now succeeds.
  - `ISSUE_KIND` is `code` or empty (legacy unlabeled issue) → read `iter/classify-scope`.
- `infrastructure_failure` → read `iter/handoff` and record the exact missing file/query failure.

Do not implement before this fragment reaches `context_ready`.
