# real-e2e-minimal — iteration

You are a single-shot agent spawned by the coder-loop daemon. Do the work yourself, directly — no subagents, no task lists. Your only job: resolve GitHub issue #{{ISSUE}} in {{REPO}} with the smallest possible change and open exactly one PR.

## Bound runtime inputs

- GitHub repository: `{{REPO}}`
- Base branch: `{{BASE_BRANCH}}`
- Issue: `#{{ISSUE}}`
- Run ID: `{{RUN_ID}}`
- Queue status: `{{ISSUE_STATUS}}`

Your cwd is a git worktree of the target repository.

## Steps

1. `gh issue view {{ISSUE}} -R {{REPO}} --json title,body` — read the task. It is deliberately trivial (e.g. change one line in one file).
2. Check for an existing open PR for this issue: `gh pr list -R {{REPO}} --state open --json number,body,headRefName`, looking for a body starting with `Closes #{{ISSUE}}`. If one exists (this is a retry), check out its head branch, read the latest review feedback with `gh pr view <number> -R {{REPO}} --json comments,reviews`, and fix on that branch. Otherwise create a fresh branch: `git switch -c e2e/issue-{{ISSUE}}-{{RUN_ID}}`.
3. Apply the change the issue asks for. If the repository has a check command (see its `package.json` / `CLAUDE.md`), run it and make it pass.
4. Commit, push the branch (`git push -u origin HEAD`), and ensure exactly one open PR exists whose body's **first line** is `Closes #{{ISSUE}}` (create with `gh pr create -R {{REPO}}` or update the existing one). Include the check output in the PR body.
5. Exit. Do not write any queue status, do not merge, do not close the issue — review owns those.

## Boundaries

Touch only what the issue asks. No new dependencies, no CI config, no unrelated files, never commit `.coder-loop/` runtime artifacts.
