# Real e2e fixture

This document records the small real-world fixture used to validate coder-loop
against an actual GitHub issue, branch, PR, review, merge, and issue-closure
path. It is intentionally not a unit test: the point is to catch integration
failures across the local runner, `gh`, target bootstrap files, PR evidence, and
review state transitions.

## Fixture

- Repository: `Mouriya-Emma/coder-loop-e2e-fixture`
- Local checkout: `/Users/mouriya/Ext/code/coder-loop-e2e-fixture`
- Visibility check:

```bash
gh repo view Mouriya-Emma/coder-loop-e2e-fixture --json nameWithOwner,visibility
```

Expected: exit 0 and `visibility` is `PRIVATE`.

The fixture repo keeps only tiny committed assets:

- `message.txt`, the one-line task target;
- `scripts/check-message.mjs`, the real check used by PR evidence;
- `.coder-loop/workflow.md` and `.claude/commands/dev-*.md`, target bootstrap
  contracts;
- `CLAUDE.md`, project commands and PR boundaries for the spawned agent.

Do not commit `.coder-loop/runtime/`, runtime logs, or local evidence artifacts from this fixture. If an older fixture run left `.dev-loop` / `.dev-trace.txt`, keep those out too.

## Runner Coverage

The successful 2026-05-17 run used Codex end to end. Current runner semantics differ for review: iteration can still be Codex, but review now defaults to Claude unless target config explicitly sets `reviewRunner`:

- target config: `.coder-loop/runtime/config.json` has `"runner": "codex"`;
- queue item: `runner: "codex"`;
- `status --json`: selected runner `kind=codex`, `source=queue`;
- `status --json`: review runner defaults to `kind=claude`, `source=review-default`, `model=claude-opus-4-7` unless config sets `reviewRunner` to another runner;
- iteration phase status should record `runner: "codex"` and a Codex `thread_id`; review phase status should record `runner: "claude"` and `model: "claude-opus-4-7"` under the default review policy.

Codex runner requires real workspace writes and GitHub CLI access for the
`gh-issue-pr-iteration` preset. The default fresh Codex invocation therefore
uses `--sandbox danger-full-access`; targets that want a narrower sandbox can
override it through `codex.extraArgs`.

## Bootstrap / Health Checks

From the coder-loop repo:

```bash
bun src/loop.ts install /Users/mouriya/Ext/code/coder-loop-e2e-fixture \
  --repo Mouriya-Emma/coder-loop-e2e-fixture
bun src/loop.ts --target-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture --check-runtime
bun src/loop.ts doctor /Users/mouriya/Ext/code/coder-loop-e2e-fixture
bun src/loop.ts status /Users/mouriya/Ext/code/coder-loop-e2e-fixture --json \
  | jq '.state.kind, .target.runner, .queue.selected, .current'
```

Expected:

- install is idempotent and preserves existing target workflow plus centralized chain state;
- runtime check exits 0;
- doctor has no `FAIL`;
- `state.kind == "ok"`;
- selected queue item, when present, resolves to runner `codex`;
- no stale live process / chain ownership before a clean e2e run.

If doctor reports stale runtime ownership, inspect `coder-loop daemon status ... --json` and stop/delete the target chain through the daemon API before rerunning.

## Repeatable Task Shape

Use a deliberately tiny issue so the run validates loop mechanics rather than a
large feature:

1. Put `message.txt` on `main` in a failing state:

   ```text
   status: pending
   ```

2. Create a `kind:code` issue whose expected outcome is exactly:

   ```text
   status: complete
   ```

3. Queue that issue in the centralized chain runtime, with an item shaped like:

   ```jsonc
   {
     "issue": <issue-number>,
     "status": "queued",
     "attempts": 0,
     "branch": null,
     "pr": null,
     "lastRunId": null,
     "issueFile": ".coder-loop/runtime/issues/<issue-number>.md",
     "evidenceDir": ".coder-loop/runtime/evidence/issue-<issue-number>",
     "agentCwd": null,
     "runner": "codex"
   }
   ```

4. Ensure chain `current` is null before the run (`coder-loop status ... --json | jq .current`).

5. Run exactly one work iteration:

   ```bash
   CODER_LOOP_IDLE_SLEEP_MS=50 \
     bun src/loop.ts --target-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture --once
   ```

Expected result:

- iteration creates a feature branch and PR;
- PR body starts with `Closes #<issue-number>`;
- PR evidence includes the changed `message.txt` and `bun run check`;
- review posts an acceptance comment, merges the PR, and confirms GitHub closes
  the issue through the closing reference;
- local queue item becomes `status: "done"` with `pr` set;
- `current` becomes `null`;
- no live loop process remains and `current` becomes `null`.

## 2026-05-17 Evidence

Successful run:

- Fixture issue: `Mouriya-Emma/coder-loop-e2e-fixture#1`
- Fixture PR: `Mouriya-Emma/coder-loop-e2e-fixture#2`
- Run id: `run-2026-05-16-22-31-27-929-issue-1`
- Iteration Codex thread: `019e32ea-7b62-76d2-a2a8-8c27e8a0e173`
- Review Codex thread: `019e32ee-5fa7-79d0-8198-486050dc6caf`
- Fixture PR merge commit:
  `d5b7e29aa54a75ffa7e94b726287b7190d005086`

Key verification commands:

```bash
bun src/loop.ts install /Users/mouriya/Ext/code/coder-loop-e2e-fixture \
  --repo Mouriya-Emma/coder-loop-e2e-fixture

bun src/loop.ts doctor /Users/mouriya/Ext/code/coder-loop-e2e-fixture \
  --repo Mouriya-Emma/coder-loop-e2e-fixture

gh pr view 2 --repo Mouriya-Emma/coder-loop-e2e-fixture \
  --json state,mergedAt,mergeCommit,closingIssuesReferences,comments

gh issue view 1 --repo Mouriya-Emma/coder-loop-e2e-fixture \
  --json state,closedAt,closedByPullRequestsReferences

bun src/loop.ts status /Users/mouriya/Ext/code/coder-loop-e2e-fixture --json \
  | jq '.queue, .current, .processes'

cd /Users/mouriya/Ext/code/coder-loop-e2e-fixture
git switch main
git pull --ff-only
bun run check
```

Observed result:

- PR #2 state: `MERGED`;
- PR #2 closing reference points to issue #1;
- issue #1 state: `CLOSED`;
- issue #1 `closedByPullRequestsReferences` points to PR #2;
- install/doctor/status exit 0 after the run, with no selected item and no live
  loop process;
- local status has `queue.byStatus.done == 1`, `queue.selected == null`,
  `current.run == null` and no live loop process;
- `bun run check` on updated fixture `main` prints
  `message fixture check passed`.

## Known Pitfalls

- The target repo must include `CLAUDE.md` because the bundled
  `gh-issue-pr-iteration` read-context and review fragments require it as
  project reference.
- A non-git temp directory can fail Codex before sandbox evaluation with
  `Not inside a trusted directory and --skip-git-repo-check was not specified`.
  This fixture intentionally uses a real git repo instead of adding
  `--skip-git-repo-check` to runner defaults.
- `codex exec resume` does not accept `--sandbox`; sandbox defaults apply only to
  fresh `codex exec`.
- Review currently reads the iteration trace, which contains
  `ITERATION SUMMARY`; the generic summary watchdog may arm during review. In
  the successful run review exited before the watchdog fired, but this is worth
  tracking if future reviews are longer.
