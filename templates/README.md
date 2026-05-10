# coder-loop templates

These are reusable starting points distilled from real production usage (the Fulcrum project is the reference implementation). Copy into a target project, replace placeholders, adapt to local conventions.

## What coder-loop actually is

`coder-loop` is a **stateless program loop**. It alternates iteration and review agent spawns, captures their output to trace/log/status files, and exits. It does not judge issue completion, evidence sufficiency, PR correctness, parent closure, queue priority, or any other domain question. All of those judgments come from:

- the agent prompts in `prompts/` (built into this repo)
- the **project policy** the agents read at every spawn — primarily `.coder-loop/workflow.md`, `.coder-loop/runtime/shared.md`, and per-issue handoff files
- live GitHub issue/PR state

The templates below are the project-policy half. If you delete a rule from one of these files in your target project, the loop stops enforcing it. There is no built-in fallback. That is by design — coder-loop is project-agnostic precisely because the rules live in the target.

## Available templates

| Template | Copy to | Purpose |
|---|---|---|
| `workflow.md` | `<TARGET>/.coder-loop/workflow.md` | committed project policy: goal, source-of-truth, PR/evidence rules, CI-parity, review behavior |
| `shared.md` | `<TARGET>/.coder-loop/runtime/shared.md` | local durable cross-issue facts, with allowed/forbidden policy |
| `pr-body.md` | `<TARGET>/.coder-loop/templates/pr-body.md` (or inline into `workflow.md`) | PR body skeleton with evidence layers |
| `supervisor/` | `<TARGET>/.coder-loop/runtime/supervisor/<MISSION>/` + `<TARGET>/.claude/skills/bootstrap/SKILL.md` | optional outer-layer supervisor (cron-driven cross-patrol orchestration) — see `supervisor/README.md` |

## Minimum viable target setup

The smallest project that can run coder-loop needs only:

1. A committed `.coder-loop/workflow.md` (start from `workflow.md`, trim layers you don't need).
2. A `.coder-loop/runtime/config.json` with at least `repository` and `baseBranch` (defaults in `src/loop.ts` cover the rest).
3. Local `gh` auth for the target repository.

`shared.md` and `pr-body.md` are highly recommended but not required for the loop to start. The `supervisor/` pattern is only needed for long multi-mission work — short single-issue runs don't need it.

## Why these specific templates

These four are the things every project using coder-loop has had to write from scratch. Anything else (project-specific hooks, language-specific test wrappers, custom slash commands) stays in the target project — those are not cross-project patterns.
