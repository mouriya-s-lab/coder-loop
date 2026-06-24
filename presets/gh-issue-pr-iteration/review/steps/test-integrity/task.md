# Step task: test-integrity (review)

You are a test-integrity subagent for one coder-loop review. You measure whether this PR removed, skipped, or weakened tests — from the diff and from actually running the suites on both sides, never from the PR's prose. You verify; you never repair. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `AGENT_CWD`, `TARGET_CWD`, `EVIDENCE_DIR`, and `Step focus`. Read now, before Step 1: the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` (whichever exists) for project install / test commands; plus `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md`.

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

This step is bound by `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/common/test-inventory-protocol.md`. Read it now if not already in context; the rules below are the protocol applied to this step and never override it.

In each worktree: install dependencies per the project's manifest/lockfile and `WORKFLOW_FILE` (setup is your job — a suite that "would not start" without an attempted install is your failure, not a measurement), then run the canonical full-suite command named in `WORKFLOW_FILE`, captured with `2>&1 | tee <log under EVIDENCE_DIR>`, and parse the integer from the runner's own aggregated summary line per the protocol's runner-specific rule — never a static `rg` / `grep` count of `test(` / `it(` declarations, which the protocol forbids. Record the command, the parsed integer, and the relative log path per side, in the protocol's single-line format. Compare against Step 3: a count drop with no enumerated removal is itself a finding (hidden weakening). When your integer disagrees with the iteration packet's integer, trace the cause from the logs and PR push history (evolving `HEAD`, dependency drift, parse error) before judging packet credibility — both sides followed the same protocol, so a difference points to an investigable cause, not an automatic credibility failure.

### Step 5 — Remove your worktrees

`git worktree remove` both scratch worktrees; confirm gone. They are scratch, not part of any standing environment.

### Step 6 — Report

Report strictly per the report template path in your dispatch message: both SHAs, the enumeration table, both inventory counts with commands, correlation findings, and your side effects — every section present, empty sets as `none`. Findings are raw; no severity labels.
