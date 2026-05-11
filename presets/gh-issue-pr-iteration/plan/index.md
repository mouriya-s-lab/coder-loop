# Fragment: plan/index

## Goal

Start one planning invocation and follow the planning fragment chain. Planning produces the coder-loop queue: atomic GitHub issues with executable checkpoints + parent/child graph + initialized `state.json`.

Planning is **not** a `preset.phases` member. It is invoked by the `/dev-plan` slash command, which is a thin shell that delegates to this fragment chain. The L1 engine does not see planning; it only sees the `iteration` → `review` phases that consume the queue planning produces.

## Required reads

Before role-specific planning, read these fragments from the entry prompt's fragment index:

1. `common/runtime-contract`
2. `common/github-routing`
3. `common/state-contract`
4. `contract.md` — the preset's contract on issue / PR / review shape (THIS IS THE OVERRIDE LAYER)
5. user-level `~/.claude/skills/writing-issue/SKILL.md` — generic issue hygiene base (atomicity, citation, parent/child API)

In all cases of conflict between user-level skill and `contract.md`, `contract.md` wins. User-level skill is hygiene base; contract is preset-specific override.

## Planning ownership

Planning produces planning signal. Concretely:

- read user input (design doc / issue link / large task description / repo + goal);
- classify each candidate deliverable (`implementation` / `spike` / `parent` / `design-question` / `no-code`);
- decompose into atomic issues, each with one coherent `## Why` paragraph;
- author `## 验收标准` (and `## 结果分支` for spikes) per `contract.md` §1.4 / §1.6;
- run adversarial validation against minimum-effort agent path;
- create issues with `gh issue create` (one `kind:*` label each, §1.3);
- link parent/child via `addSubIssue` (issue-to-issue only, never PR-as-child);
- initialize `state.json` queue with actionable issues;
- run `coder-loop --target-cwd <target> --check-runtime` to confirm queue valid;
- write handoff describing what was created and the queue state.

Planning must not:

- open PRs;
- merge anything;
- close issues (planning may file new issues but never closes them — closure is review's authority);
- bypass `contract.md` §1.4 table column requirements;
- skip adversarial validation;
- queue parent-only umbrella issues without a concrete closure task;
- delete `.dev-loop` or modify runtime files outside `state.json` + `issues/` + `evidence/`.

## Next fragment

Read `plan/intake`.
