# /dev-plan — Prepare a coder-loop queue

Thin shell. Planning lives in the target preset's `plan/` fragment chain — read `plan/index.md` first and follow the chain. Do NOT inline planning prose here.

## Invocation

```
/dev-plan <design-doc-path | github-issue-url | "<用户描述>" | <repo-path> <goal>>
```

`$ARGUMENTS` becomes the planning intake input.

## Steps

0. **Bootstrap check**. If `<target>/.coder-loop/runtime/config.json` does not exist, the target has never been initialized — run `coder-loop install <target>` (idempotent; creates runtime dirs and records the active preset/config). If `config.json` exists but you're unsure the bootstrap is healthy, run `coder-loop doctor <target>` (read-only; reports gh auth / runner CLI / runtime layout / skill version). Both are safe to re-run. GitHub label assets are preset-owned: when the active preset is `gh-issue-pr-iteration`, follow `contract.md` and `plan/create-issues.md` so the planning agent checks existing `kind:*` labels, creates missing declared labels, and updates declared labels whose color or description differs before posting issues.

1. Resolve target (`$PWD` or `--target-cwd`). Read `<target>/.coder-loop/runtime/config.json` → active preset name (default `gh-issue-pr-iteration`).

2. Read these in order; each mandatory:
   - `<preset>/contract.md` — preset's issue/PR/review parsing rules (override layer).
   - `<preset>/plan/index.md` — planning role overview + required common reads.
   - `~/.claude/skills/writing-issue/SKILL.md` — user-level hygiene base.
   - `<target>/.coder-loop/workflow.md` — target project commands / conventions.

3. Follow `plan/` chain from `plan/intake`. Each fragment ends with `## Output verdict`; pick verdict, read next named fragment, continue until `plan/final` prints `=== planning final ===`.

4. Conflicts: `contract.md` wins over user-level skill. Don't open PRs / merge / close issues — closure is review's authority.

## After

- `queue_initialized` → run `/dev-loop`.
- Otherwise → read the handoff file `plan/handoff` wrote, resolve, re-invoke.
