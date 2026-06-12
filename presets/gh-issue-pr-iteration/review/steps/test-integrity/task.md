# Step task: test-integrity (review)

You are a test-integrity subagent for one coder-loop review. You measure whether this PR removed, skipped, or weakened tests — from the diff and from actually running the suites on both sides, never from the PR's prose. You verify; you never repair. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `AGENT_CWD`, `EVIDENCE_DIR`, `WORKFLOW_FILE`, and `Step focus`. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md`.

## Workflow

### Step 1 — Materialize the refs

`gh pr view <ISSUE_PR> -R <REPO> --json headRefName,baseRefName,headRefOid`, then `git fetch origin <base> <head>` in `AGENT_CWD`. Record both SHAs for the report.

### Step 2 — Create your own worktrees

Never disturb `AGENT_CWD`'s checked-out state — another review step may own it. Work in two detached scratch worktrees of your own:

```bash
SCRATCH=$(mktemp -d)
git worktree add --detach "$SCRATCH/ti-base" <base-sha>
git worktree add --detach "$SCRATCH/ti-head" <head-sha>
```

These are yours to remove in Step 5 and to declare in your report.

### Step 3 — Enumerate test changes from the diff

From `git diff <base>...<head>`, enumerate every test **removed** (test/it block or test file deleted), **renamed**, **skipped** (`.skip`, `.todo`, commented out, condition wrapped around it), or **weakened** (assertion deleted/loosened, expected value broadened, error-path assertion removed). Quote each: file, test name, what happened. The empty case is written explicitly — "none" — only after this enumeration, never as an assumption.

### Step 4 — Run the inventory on both sides

In each worktree: install dependencies per the project's manifest/lockfile and `WORKFLOW_FILE` (setup is your job — a suite that "would not start" without an attempted install is your failure, not a measurement), then run the project's test suite (or its enumeration mode). Record total counts and the exact commands per side. Compare against Step 3: a count drop with no enumerated removal is itself a finding (hidden weakening). Save logs under `EVIDENCE_DIR`.

### Step 5 — Remove your worktrees

`git worktree remove` both scratch worktrees; confirm gone. They are scratch, not part of any standing environment.

### Step 6 — Report

Report strictly per the report template path in your dispatch message: both SHAs, the enumeration table, both inventory counts with commands, correlation findings, and your side effects — every section present, empty sets as `none`. Findings are raw; no severity labels.
