# Fragment: plan/decompose

## Goal

Take classified deliverables and emit a draft issue body for each. At this fragment the bodies are still markdown text (not yet posted to GitHub) — `plan/checkpoint-author` will fill in the tables, `plan/adversarial-validate` will harden them, `plan/create-issues` will actually post.

## Inputs

- Classified candidate list from `plan/classify`.
- `contract.md` §1 (issue body shape per kind).
- User-level `~/.claude/skills/writing-issue/SKILL.md` (hygiene base: atomicity test, citation rules, retroactive umbrella form for `parent` class).

## Procedure

1. For each `implementation` / `spike` / `parent` candidate, draft a body skeleton.

2. **Atomicity test** (per user-level skill hard constraint, also in `contract.md` §5):
   - Can you write a single coherent `## Why` (or `## 问题` / `## 目标` for future-work) paragraph that justifies the entire body without listing multiple distinct triggers?
   - If yes → keep as one issue.
   - If no → split into multiple issues; if they share a common driver, also create a `parent` umbrella.

3. **Section skeleton by class**:

   `implementation` (kind:code):

   ```markdown
   ## 目标
   <从设计源提取：完成什么>

   ## 上下文
   - **Repo**: <owner>/<repo>（path: <local>）
   - **Working directory**: <repo 内路径，如适用>
   - **Design doc / source**: <path / issue / PR / user request> section <N>
   - **Conventions**: <跨 repo 时写清楚 follow 哪个 repo 的现有 convention>

   ## 问题
   <现状为何不满足；observable，不是实现方案>

   ## 预期结果
   <用户 / 系统 / 下游能观察到什么>

   ## 约束
   <可选；只写源需求明确给出的外部约束>

   ## 验收标准
   <plan/checkpoint-author 将填表>

   ## 继承验证义务
   <可选；从上游继承的延期验证>

   ## 依赖关系
   - Depends on: #<N>（<原因>）
   - Blocks: #<M>（<原因>）
   ```

   `spike` (kind:comment):

   ```markdown
   ## 目标
   Verify assumption: <具体 claim>

   ## 上下文
   - **Repo**: <owner>/<repo>（path: <local>）
   - **Design doc / source**: <path / issue / PR> section <N>
   - **Assumption source**: <原文 quote>

   ## 验证步骤
   1. <具体步骤>
   2. <具体步骤>

   ## 验收标准
   <plan/checkpoint-author 将填表>

   ## 结果分支
   - **If passed**: <动作>
   - **If failed**: <动作>

   ## 依赖关系
   - Blocks: #<N>（依赖该假设的 implementation issue）
   ```

   `parent` (umbrella; usually kind:code if it itself has a closure task, otherwise no `kind:*` label and not queued):

   遵循用户级 writing-issue 的 retroactive umbrella form 或 future-work parent form。Parent body 通常含 `## 背景 / 为什么`、`## 范围`、`## 不在范围内`、`## 设计决策 / approach`、`## 时间线`、`## 实施 PR / 已挂 children`。本 contract 不重复 user-level skill 写法。

4. **Cite verification**. Each `## 问题` / `## 目标` / `## 背景` paragraph must trace to a source quote. Mark inline as `> "..." — <repo>#<N>` body / `<repo>@<sha>` commit. No motivation sentence without cite — if you can't cite, the issue isn't yet understood well enough.

5. **Title drafting**. Per `contract.md` §1.1: single subject (no `and / + / 、 / /`), Chinese, optional conventional commit prefix. Title preview the PR title that will close this issue — they must align (`title-intent-gate` will enforce).

6. **Forbidden in body**:
   - implementation solution / module structure / protocol choice / state-machine design / naming preferences (unless externally imposed by source);
   - future-tense `[ ]` checkbox lists in `## 验收标准` (use the table form);
   - internal draft IDs (`int-foo-bar`, `sub_new_id`);
   - retroactive `## Acceptance` future-tense checklist for landed work.

## Failure handling

If any candidate's draft body can't pass atomicity test even after splitting (e.g. the work is genuinely one PR but its Why has multiple unrelated motivations), emit `not_atomic_resplit` and return to `plan/classify` to re-decide. Don't write multi-motivation issues.

If `kind:comment` candidate's `## 结果分支` can't be drafted (you don't know what should happen on pass vs fail), the spike is under-specified — emit `intake_needs_clarification` and bounce back to operator.

## Output verdict

Choose exactly one:

- `atomic_set_ready` → read `plan/checkpoint-author`. Every draft body passes atomicity test and cites motivation.
- `not_atomic_resplit` → return to `plan/classify` with the candidates that need re-classification.
- `decompose_blocked` → read `plan/handoff` with the specific draft that can't be reduced to atomic shape.

Do not advance to checkpoint authoring with non-atomic bodies.
