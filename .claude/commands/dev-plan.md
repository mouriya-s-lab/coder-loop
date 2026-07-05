# /dev-plan — Prepare a coder-loop queue

Thin shell. Planning lives in the target preset's `plan/` fragment chain — read `plan/index.md` first and follow the chain. Do NOT inline planning prose here.

## Invocation

```
/dev-plan <design-doc-path | github-issue-url | "<用户描述>" | <repo-path> <goal>>
```

`$ARGUMENTS` becomes the planning intake input.

## Steps

0. **Health check**. Run `coder-loop status "$PWD" --json` — if `state.kind == "ok"` and `queue.total >= 0`, the target's chain resolves through the central daemon and you can proceed. If it errors on chain lookup, the target has not been registered yet — run `coder-loop chain create <name> --config-json '{"repository":"<owner>/<repo>","baseBranch":"<base>"}' --preset gh-issue-pr-iteration` first (target directory needs no bootstrap files). For any other failure kind, run `coder-loop doctor "$PWD" --repo <owner>/<repo>` and address what it flags before planning. GitHub label assets are preset-owned: when the active preset is `gh-issue-pr-iteration`, follow `contract.md` and `plan/create-issues.md` so the planning agent checks existing `kind:*` labels, creates missing declared labels, and updates declared labels whose color or description differs before posting issues.

1. Resolve target (`$PWD` or `--target-cwd`). Read the active chain via `coder-loop status "$PWD" --json | jq -r '.target.preset.name'` → active preset name.

2. Read these mandatory inputs in order:
   - `<preset>/contract.md` — preset's self-contained issue/PR/review parsing and planning hygiene rules.
   - `<preset>/plan/index.md` — planning role overview + required common reads.
   - `<target>/CLAUDE.md` and/or `<target>/AGENTS.md` — target project commands / conventions. When both are absent, `plan/intake` returns `intake_needs_clarification` demanding the operator commit one first.

   Optional: user-level writing/review skills if present. They are operator references only; absence must not block planning.

3. Follow `plan/` chain from `plan/intake`. Each fragment ends with `## Output verdict`; pick verdict, read next named fragment, continue until `plan/final` prints `=== planning final ===`.

4. Conflicts: `contract.md` wins over optional user-level references. Don't open PRs / merge / close issues — closure is review's authority.

## After

- `queue_initialized` → run `/dev-loop`.
- Otherwise → read the handoff file `plan/handoff` wrote, resolve, re-invoke.
