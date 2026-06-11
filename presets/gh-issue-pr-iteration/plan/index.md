# Fragment: plan/index

## Goal

Start one planning invocation and follow the planning fragment chain. Planning produces the coder-loop queue: atomic GitHub issues with executable checkpoints + parent/child graph + initialized `central state DB`.

Planning is **not** a `preset.phases` member. It is invoked by the `/dev-plan` slash command, which is a thin shell that delegates to this fragment chain. The L1 engine does not see planning; it sees the runtime phases that consume the queue planning produces: `iteration`, `review`, and any configured post-review trigger phases such as `blocked-responder`.

## Required reads

Before role-specific planning, read these fragments from the entry prompt's fragment index:

1. `common/runtime-contract`
2. `common/github-routing`
3. `common/state-contract`
4. `contract.md` — the preset's self-contained contract on issue / PR / review shape, including atomicity, citation, and parent/child rules
5. `<target>/.coder-loop/workflow.md` — target commands and conventions

User-level writing/review skills are optional operator references only. If present, they may inform style; if absent, planning proceeds from `contract.md` and workflow policy.

## Planning ownership

Planning produces planning signal. Concretely:

- read user input (design doc / issue link / large task description / repo + goal);
- classify each candidate deliverable (`implementation` / `spike` / `parent` / `design-question` / `no-code`);
- decompose into atomic issues, each with one coherent `## Why` paragraph;
- author `## 验收标准` (and `## 结果分支` for spikes) per `contract.md` §1.4 / §1.6;
- run adversarial validation against minimum-effort agent path;
- create issues with `gh issue create` (one `kind:*` label each, §1.3);
- link parent/child via `addSubIssue` (issue-to-issue only, never PR-as-child);
- initialize `central state DB` queue with actionable issues;
- run `coder-loop --target-cwd <target> --check-runtime` to confirm queue valid;
- write handoff describing what was created and the queue state.

Planning must not:

- open PRs;
- merge anything;
- close issues (planning may file new issues but never closes them — closure is review's authority);
- bypass `contract.md` §1.4 table column requirements;
- skip adversarial validation;
- queue parent-only umbrella issues without a concrete closure task;
- delete central daemon scheduling state or modify runtime files outside `central state DB` + `issues/` + `evidence/`.

## Next fragment

Read `plan/intake`.
