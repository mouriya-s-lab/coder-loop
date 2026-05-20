# Fragment: plan/decompose

## Goal

Take classified deliverables and emit a draft issue body for each. At this fragment the bodies are still markdown text (not yet posted to GitHub) — `plan/checkpoint-author` will fill in the tables, `plan/adversarial-validate` will harden them, `plan/create-issues` will actually post.

## Inputs

- Classified candidate list from `plan/classify`.
- **Business frame from `plan/business-frame`** — the three user-facing sections (痛点 / 能多干什么 / 具体场景). Every sub-issue's `## 问题` / `## 预期结果` must cite back to this frame. If business-frame emitted `business_frame_skipped`, sub-issues are pure design-question / no-code and this constraint relaxes.
- `contract.md` §1 (issue body shape per kind).
- User-level `~/.claude/skills/writing-issue/SKILL.md` (hygiene base: atomicity test, citation rules, retroactive umbrella form for `parent` class).

## Procedure

1. For each `implementation` / `blocker-resolution` / `spike` / `source-writing-spike` / `parent` candidate, draft a body skeleton.

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
   - **业务陈述来源**: <umbrella issue # / 本 issue ## 业务陈述 section>

   ## 问题
   <**用户当前做不了什么 / 流程上的痛点**——用 user-facing 语言，主语是用户或用户的 agent，动词是用户能观察到的动作。引 business-frame §1（"用户当前做不了什么 / 痛点"），并写出本 sub-issue 没解决前用户场景在哪一步卡住。

   禁用工程层 observable 当作 "问题"：不写"e2e-script.ts line N 是 fetch"、"process tree 里没 MCP child"、"jsonl 不出现 tool_use"。这些是 audit 视角，不是用户视角。若你写不出 user-facing 的痛点版本，说明本 sub-issue 还没找到业务理由，回 `plan/classify` 重判。>

   ## 预期结果
   <**用户做完这一片后能多干什么 / 能观察到自己多干了什么**——同样 user-facing 语言。引 business-frame §3 具体场景中本 sub-issue 覆盖的步骤段。

   禁用工程 trace 当作 "预期结果"：不写"jsonl 出现 channel.send tool_use"、"docker access log 收到 envelope"、"pgrep -P 看到 MCP child"。这些是验证手段，归 `## 验收标准` 表。`## 预期结果` 只写用户观察。>

   ## 约束
   <可选；只写源需求明确给出的外部约束>

   ## 验收标准
   <plan/checkpoint-author 将填表。这里是把上面 user-facing 的"预期结果"折算成工程可核对的痕迹，工程动词允许出现。>

   ## 继承验证义务
   <可选；从上游继承的延期验证>

   ## 依赖关系
   - Depends on: #<N>（<原因>）
   - Blocks: #<M>（<原因>）
   ```

   `blocker-resolution` (kind:blocked):

   ```markdown
   ## 目标
   解除 <owner/repo#N 或具体 runtime blocker>。

   ## 上下文
   - **Repo**: <owner>/<repo>（path: <local>）
   - **Blocked source**: <issue / PR / review comment / runtime log source>
   - **Unblocks**: <owner/repo#N>

   ## 阻塞条件
   <当前 blocked 的具体条件：命令、runtime path、service、issue、PR 或 evidence gap。>

   Unblocks: <owner/repo#N>

   ## 预期结果
   <被阻塞的 loop/item 可以重新执行；写用户/agent 能观察到什么，不写实现方案。>

   ## 验收标准
   <plan/checkpoint-author 将填表；必须包含 blocked path e2e/integration 复测。>

   ## 依赖关系
   - Unblocks: <owner/repo#N>
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

   `source-writing-spike` (kind:code-spike):

   ```markdown
   ## 目标
   Verify assumption with source/runtime PoC: <具体 claim>

   ## 上下文
   - **Repo**: <owner>/<repo>（path: <local>）
   - **Design doc / source**: <path / issue / PR> section <N>
   - **Assumption source**: <原文 quote>

   ## 问题
   <为什么 comment-only spike 无法验证；为什么需要写 PoC/source 或 runtime evidence>

   ## 预期结果
   <spike 完成后 operator 能据此决定什么>

   ## 约束
   - PoC branch/evidence only; no implementation PR; no merge into main.

   ## 验证步骤
   1. <具体 source-writing / runtime 步骤>
   2. <具体 evidence 步骤>

   ## 验收标准
   <plan/checkpoint-author 将填表>

   ## 结果分支
   - **If passed**: <动作>
   - **If failed**: <动作>

   ## 依赖关系
   - Blocks: #<N>（依赖该 source-writing spike 的 implementation issue）
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

7. **Forbidden vocabulary specifically in `## 问题` and `## 预期结果` sections** (these belong in `## 验收标准` / `## 约束`, not in the business motivation): process/runtime terms (spawn, fork, exec, pid, ppid, subprocess, stdio, pipe, pgrep, ps), wire/API terms (POST, GET, fetch, envelope, payload, tool_use, tool_result, jsonl, transcript, access log), code-structure terms (line N, file path, MCP child, mailbox poller), config/packaging terms (docker, image, port, container, fnox key), verification-recipe verbs (register, deregister, evict, three-way reconciliation). The rule: if the noun is something the engineering team owns rather than something the user owns, it doesn't belong in 问题 or 预期结果.

8. **Cite back to business frame**: every `## 问题` paragraph must cite `umbrella#<N> §业务陈述 / §1 痛点` (or the same-issue `## 业务陈述` section if standalone); every `## 预期结果` paragraph must cite `umbrella#<N> §业务陈述 §3 具体场景, step N` to make the user-scenario step this sub-issue covers explicit. Without these cites, decompose is silently free to drift back into audit framing.

## Failure handling

If any candidate's draft body can't pass atomicity test even after splitting (e.g. the work is genuinely one PR but its Why has multiple unrelated motivations), emit `not_atomic_resplit` and return to `plan/classify` to re-decide. Don't write multi-motivation issues.

If `kind:comment` candidate's `## 结果分支` can't be drafted (you don't know what should happen on pass vs fail), the spike is under-specified — emit `intake_needs_clarification` and bounce back to operator.

## Output verdict

Choose exactly one:

- `atomic_set_ready` → read `plan/checkpoint-author`. Every draft body passes atomicity test and cites motivation.
- `not_atomic_resplit` → return to `plan/classify` with the candidates that need re-classification.
- `decompose_blocked` → read `plan/handoff` with the specific draft that can't be reduced to atomic shape.

Do not advance to checkpoint authoring with non-atomic bodies.
