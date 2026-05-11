---
name: writing-issue
description: How to write a GitHub issue body and place it in the right parent-child position. Covers PM hierarchy (What/Why/How), future-work executable checkpoint issues (Problem/Expected Outcome/Acceptance Criteria/Dependencies), spike issues, inherited verification obligations, retroactive umbrella form, citation rules, parent selection, sub-issue API mechanics (addSubIssue, single-parent rule, cross-repo, PR-as-child reject), and what NOT to write (solutions in issues, retroactive Acceptance checklists, mechanical classification, internal IDs in body). Use whenever opening an issue, drafting an umbrella to retro-fit landed work, or deciding where a new issue should hang in the graph.
---

# writing-issue

The user-level issue/PR routing rule lives in `~/.claude/rules/github-issue-pr-routing.rule.md`. This skill is only the spec for issue body form, parent-child placement, citation rules, and the sub-issue API.

## Hard constraints

**One issue, one problem.** Atomicity is the whole point of PM hierarchy. If the body describes four separable problems, that's four issues — not one issue with four bullets. Symptoms of a mashed-up issue: multiple unrelated motivation paragraphs (each justifying a different fix), Scope bullets that each look like their own complete proposal, title joined by "and" / "+" / "/" / "、" linking unrelated topics, multiple PRs would close it for completely independent reasons. When you find yourself drafting that, stop and split: file one issue per atomic problem, and if they share a common driver, file a fifth umbrella issue and use `addSubIssue` to hang the four under it. Each child stays atomic; the umbrella body says why the four belong together.

A test for "is this atomic": can you write a single coherent `## Why` paragraph that justifies the entire body without listing multiple distinct triggers? If the Why naturally splits into "first problem is X, second problem is Y, third problem is Z", the issue is not atomic — split it before going further.

**Title and body must be Chinese.** Operator's hard rule. The whole body — including section headers, prose, scope bullets, timeline — is written in Chinese. When citing a source PR/commit/issue, paste the source text verbatim (don't translate, don't paraphrase the quote). Code identifiers, file paths, command names, and `<repo>#<N>` references are mechanical tokens, not prose — they stay as-is.

**Cite original text or don't claim it.** Every motivation sentence in the body must trace to a real quote — a PR body line, a commit message, an existing issue body, or a log capture. Format: `> "..." — \`<repo>#<N>\` body` or `<repo>@<short-sha>` commit. No "as I recall" / "the goal is X" without a source. If you can't cite it, you don't yet understand it well enough to file the issue.

**No fabrication.** When pulling motivation prose from existing PRs/commits, paraphrasing is fine but inventing quotes or stitching sentences across sources to fit a narrative is not. If two cites contradict, surface the contradiction in the body, don't paper over it.

**Case-by-case, never mechanical classification.** Do not slice issues by version number, batch number, repo, time window, or title keyword. Each issue's parent and scope come from reading the actual body content of related issues/PRs. "v0.1.4 must be a sub-issue of v0.1.3" is not a rule — sometimes it's right, sometimes v0.1.4 is independent enough to be a sibling.

**Retroactive umbrella must say so.** When the issue is filed AFTER the work landed (umbrella to retro-fit a stack of merged PRs), the first paragraph of `## Why` must contain the literal phrase **"filed retroactively to umbrella work that already landed"** plus the date/time window. Operators reading the issue need to see at a glance that this is reconstruction, not pre-design.

**Parent must be an Issue, never a PR.** GitHub sub-issue is issue-to-issue only — `addSubIssue` rejects PRs as children. PRs hang under issues exclusively through the closing-keyword mechanism (PR body says `Closes #N`). If you find yourself drawing a tree where a PR has children, the tree is wrong: insert an issue between the PR and its would-be children, or pull the children up as siblings of the PR under the PR's parent issue.

**Sub-issue is single-parent.** A child can only have one parent. If your design has the same issue appearing under two different lines, GitHub will accept the first-arrival link and reject the second. Decide which line owns the child before you start linking; the other line gets a prose reference, not a sub-issue edge.

**Forbidden in title and body:** internal IDs like `int-foo-bar` or `int-foo-sub-N-slug`, sub_new_id strings, source-tree paths like `intermediates/<id>/...`, working-group names, agent IDs. The operator looks at the issue body on GitHub directly — internal scaffolding is noise that survives no review. If the body needs to reference a sibling sub-proposal, use its title or its GitHub issue number after creation, not its draft id.

**Forbidden in body: future-tense `[ ]` Acceptance checklist for retroactive work.** Most umbrellas in this codebase are retroactive — the work has already merged. Writing an Acceptance section with unchecked boxes is misleading: the operator can't tick them because the boxes were satisfied by PRs that already merged, and there's nothing left to verify. Use a How section in prose to describe what the work actually does, plus an Implementing-PRs section listing the merged PRs. Skip Acceptance entirely. Future-tense checklists only belong on issues for work that has not yet started.

**Fresh implementation issues need executable checkpoints, not prose acceptance.** When the issue is for future work, the body must be sufficient for an agent to implement and verify without rereading the design doc. Use `## 目标`, `## 上下文`, `## 问题`, `## 预期结果`, `## 约束`, `## 验收标准`, optional `## 继承验证义务`, and `## 依赖关系`. Acceptance criteria are checkpoint rows with dimension, command, environment, and expected result — not vague `[ ] tests pass` checkboxes.

**Do not write the solution into the issue.** For future work, the issue defines the problem, constraints, expected outcome, and verification checkpoints. It should not prescribe implementation structure, module boundaries, protocol choices, state-machine design, or naming unless those are externally imposed constraints from a source requirement. Let the PR carry the implementation.

**Do not invent scope while drafting issues.** Extract the problem, desired outcome, constraints, and verification needs from the design source or user request. If the source does not specify a required behavior, dependency, or constraint, do not add it as scope. Ask or file a design-question issue instead.

**Spike risky assumptions before implementation.** If the work depends on undocumented third-party behavior, cross-network/cross-environment connectivity, or speculative language like "should work" / "expected to" / "presumably", create a spike issue first. A spike verifies or falsifies the assumption and blocks the implementation issue; it is not production implementation.

**Every executable checkpoint must be runnable.** A checkpoint needs a concrete command, target environment, and expected output/exit status. If no available environment can run it now, either create a spike or place it as an inherited verification obligation on the downstream issue that can run it. Do not leave deferred verification unassigned.

**Checkpoint dimensions must cover the real risk.** Use `function` for code logic, `environment` for target runtime/container/VM behavior, `integration` for output consumed by downstream phases, and `assumption` for third-party or design assumptions. Do not create function-only issues for Docker, networking, deployment, browser, external-service, or cross-repo work.

**Checkpoints verify outcomes, not implementation choices.** Design checkpoints from the user's problem and expected result: observable behavior, rejected invalid cases, target-environment behavior, downstream compatibility, and assumption validity. Do not add checkpoints that merely force a preferred internal implementation unless the issue's source explicitly makes that implementation a requirement.

**Adversarial validation is mandatory for future-work issues.** Before opening the issue, simulate the minimum-effort agent path to passing the checkpoints. If that shortcut can pass while the user-visible problem remains unsolved, add or sharpen outcome checkpoints. Clarify confusing terms inline at first use, and state any implicit requirement that would waste an iteration if the agent guessed wrong.

**Defer label / classification / body-section rules to the target repo's preset contract.** If the target repo runs a coder-loop preset, additionally consult `<repo>/presets/<preset>/contract.md` (or the equivalent under `.coder-loop/`) for issue-creation rules that override this skill — label taxonomy, mandatory body sections per kind, and review gate parsing requirements all live there. This skill is the hygiene base; the preset contract is the override layer.

## Form

Choose the form by issue kind. Future-work implementation issues use executable checkpoints. Retroactive umbrellas use cited prose and landed PR lists. Do not mix the two shapes.

### Future-work implementation issue

Use this when the work has not landed yet and an agent or human will implement it from the issue.

```markdown
# <标题：terse 中文，描述这个 issue 解决的那一个问题>

## 目标

<从设计文档或用户请求提取：这个任务完成什么。不要发明设计。>

## 上下文

- **Repo**: `owner/repo`（path: `/local/path`）
- **Working directory**: `<repo 内路径，如适用>`
- **Design doc / source**: `<path / issue / PR / user request>` section <N>
- **Conventions**: <跨 repo 时写清楚 follow 哪个 repo 的现有 convention>

## 问题

<问题是什么，为什么现在的行为不满足需求。写 observable problem，不写怎么改代码。>

## 预期结果

<完成后用户 / 系统 / 下游能观察到什么结果。用结果语言，不用实现语言。>

## 约束

<可选。只写源需求明确给出的外部约束：目标环境、兼容性、安全边界、必须/禁止使用的外部接口。不要写内部模块结构或个人偏好的方案。>

## 验收标准

每条 criterion 是结果导向的可执行 checkpoint：dimension、command、environment、expected result 都要写清楚。checkpoint 要证明问题被解决，而不是证明采用了某个内部实现。

Dimensions: `function`（代码逻辑）、`environment`（目标环境 / container / VM / browser 行为）、`integration`（下游可消费输出）、`assumption`（第三方或设计假设）。

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | <验证什么> | `<可执行命令>` | local / VM / CI | <期望输出或 exit code> |
| 2 | environment | <验证什么> | `<可执行命令>` | VM / container / browser | <期望> |
| 3 | integration | <验证什么> | `<可执行命令>` | local / CI / downstream | <期望> |
| 4 | assumption | <验证什么> | `<可执行命令>` | target env | <期望> |

## 继承验证义务

<可选。只有从上游 issue 继承了延期验证时才写。obligation 不可二次延期。>

| From | Original # | Check | Command | Env | Expect |
|------|------------|-------|---------|-----|--------|
| #N | ac-K | <验证什么> | `<cmd>` | <env> | <expect> |

## 依赖关系

- Depends on: #<N>（<需要什么>）
  - Required postconditions: <上游 checkpoint IDs>
- Blocks: #<M>（<谁依赖它>）
```

### Spike issue

Use this before implementation when the design relies on an unverified risky assumption.

```markdown
# Spike: <验证的那一个假设>

## 目标

Verify assumption: <具体技术 claim>

## 上下文

- **Repo**: `owner/repo`（path: `/local/path`）
- **Design doc / source**: <path / issue / PR> section <N>
- **Assumption source**: <原文 quote 或明确来源>

## 验证步骤

1. <具体步骤>
2. <具体步骤>

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | assumption | <验证什么> | `<cmd>` | target env | <expect> |

## 结果分支

- **If passed**: Assumption holds. Proceed to implementation issue #<N>.
- **If failed**: Create a `design-question` issue with the evidence. Do NOT proceed to implementation.

## 依赖关系

- Blocks: #<N>（依赖该假设的 implementation issue）
```

### Retroactive umbrella / hierarchy issue

Use this when the work has already landed, when organizing a stack of merged PRs, or when inserting a missing middle-layer PM issue.

Body 段顺序如下。可省略不适用段；保留的段要按这个顺序，reader 看 issue 时按这个顺序找东西。

整份 body 是中文（含 section 名）。直接复制下面这份骨架填内容：

```markdown
# <标题：terse 中文，描述这个 issue 解决的那一个问题；retroactive 用 `RFC:` 前缀>

## 背景 / 为什么

<2-4 段中文散文。每句动机话跟一条 cite — `<repo>#<N>` body / `<repo>@<sha>` commit / 一条 log 抓到的截图。
retroactive umbrella 第一句必须含「filed retroactively to umbrella work that already landed」加时间窗口。
引用源 PR / commit 时整段 verbatim 粘贴 blockquote，不翻译。>

## 范围

<bullet 列，每个 bullet 对应一个 child issue 或一条 sub-line，末尾跟 `<repo>#<N>` / `<repo>!<N>` 引用。
retroactive 不写 `[ ]` checkbox（工作早 merged，打不了勾）。>

## 不在范围内

<可选段。只在源 PR/commit 明确说排除某事时才写，例：「下游 consumer-side bump 在 dns-hardening umbrella 下，不在这」。否则整段省略。>

## 设计决策 / approach

<可选段。多个独立 design tradeoff 时一个决策一段，每段跟 cite。>

## 时间线

<一段中文。retroactive 写法：「Filed retroactively. Wave 2026-04-20T13:41Z (#8) 起 2026-04-20T23:20Z (!14 merged) 止——14 小时单 session burst。」标实际落地的时间窗口。>

## 实施 PR / 已挂 children

<纯 list，不是 checkbox。每条 merged PR + 每个 existing issue child + 每个嵌套 sub-proposal 各一条：

- `Mouriya-Emma/<repo>!N` — <PR title> [merged]（closes 这个 issue）
- 已有 issue child：`Mouriya-Emma/<repo>#<M>` — <title>
- 嵌套子 sub-proposal：<title>>
```

如果起草过程含 Source bundle 段（列每条 cite 的来源 audit trail），落 GitHub 之前剥掉。GitHub 上看到的 body 是「背景」「范围」「不在范围内（如有）」「设计决策」「时间线」「实施 PR」六段。

篇幅目标 50-200 行 markdown。低于 50 行通常 cite 不够；高于 200 行通常是机械复制而不是综合。

## Voice

Operator voice is terse and imperative, in Chinese (see hard constraint above). Read 1-2 of the operator's existing umbrella bodies before drafting — pick from any Mouriya-Emma repo, find one with `RFC:` prefix and multi-paragraph Why. Style match: short sentences, no marketing tone, no future-promise framing — landed work in past tense, planned work in imperative ("加 `net0` channel", not "我们将加").

Bullet lists go for genuinely enumerable things (Scope children, decision points, timeline events). Prose paragraphs do everything else. Do not write `**Label** — description` lines stacked as a fake checklist — operator considers that style noise.

## Mechanics: where to put the issue

You're either (a) opening a fresh issue for new work, or (b) creating a retroactive umbrella for landed work, or (c) supplementing a PM hierarchy by adding a missing middle-layer issue.

**Pick the home repo by who's driving.** IaC-core-driven work (the IaC repo opens an RFC and the work fans out across submodules) lives in the IaC repo. App-driven work (the app repo wants to be deployed; that pulls IaC repos along) lives in the app repo. CICD onboarding lines parent under the application repo, not under the runner-host IaC repo.

**Cross-repo sub-issue is supported and works.** GitHub `addSubIssue` accepts a parent in repo A and a child in repo B as long as both are under the same org. Use this freely — don't duplicate an issue across repos to avoid cross-repo links.

**Decide parent before opening.** If parent is an existing issue, look it up (`gh issue view <repo>#<N>`) to confirm it's still appropriate. If parent is a NEW intermediate that doesn't exist yet, create the parent first, then the child, then link. The opposite order can leave the new child orphaned if the parent creation fails.

## Mechanics: linking with addSubIssue

Once both issues exist, link them with the GraphQL mutation. Resolve each issue's GraphQL ID by number, then call `addSubIssue`:

```bash
PARENT_ID=$(gh api graphql -F num=<parent-number> -f query='
  query($num:Int!){repository(owner:"Mouriya-Emma",name:"<parent-repo>"){
    issue(number:$num){id}}}' --jq '.data.repository.issue.id')

CHILD_ID=$(gh api graphql -F num=<child-number> -f query='
  query($num:Int!){repository(owner:"Mouriya-Emma",name:"<child-repo>"){
    issue(number:$num){id}}}' --jq '.data.repository.issue.id')

gh api graphql -f query='
  mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){
    subIssue{number title}issue{number title}}}' \
  -f p="$PARENT_ID" -f c="$CHILD_ID"
```

`-F` for typed integer variables (number), `-f` for strings (IDs). Mixing them up gives `Variable $num of type Int! was provided invalid value`.

Failure modes seen in practice:
- `Could not resolve to Issue node with the global id of 'PR_...'` — you tried to add a PR as child. PRs can't be sub-issues; rework the tree.
- `Sub issue may only have one parent` — child already has a parent. Either remove the existing parent (`removeSubIssue`) first, or accept the existing parent and drop this link.
- `Issue may not contain duplicate sub-issues` — the link already exists. Idempotent no-op; safe to ignore.
- HTTP 504 — GitHub API hiccup. Retry the same call; should succeed.

Closed parent + closed child link works fine. Sub-issue API does not require either side to be open.

## Mechanics: re-parenting

When you discover an issue is parented wrong (or appears under multiple parents in your draft), use `removeSubIssue` to detach, then `addSubIssue` to attach to the correct parent:

```bash
gh api graphql -f query='
  mutation($p:ID!,$c:ID!){removeSubIssue(input:{issueId:$p,subIssueId:$c}){
    subIssue{number}}}' -f p="$OLD_PARENT_ID" -f c="$CHILD_ID"
```

This is reversible, doesn't touch the issue body, and is safe to do on closed issues.

## Self-check before posting

Run through this list against the draft body before `gh issue create`:

- 标题描述的是单一问题，没有 and / + / 、 拼多个话题。
- `## 背景 / 为什么` 能通顺读成一段，没有「第一个问题 / 第二个问题」的内部分裂。
- 每条动机句跟着 cite；找不到 cite 的句子要么删要么补 cite。
- 全 body 中文（除 mechanical token：code identifier、`<repo>#<N>`、文件路径、命令）。
- retroactive 的话第一段写了「filed retroactively to umbrella work that already landed」+ 时间窗口。
- 标题和 body 没出现 `int-...` / `sub_new_id` / 内部草稿 id。
- 没有 retroactive 的 `## Acceptance` 段（unchecked checkbox 是误导）。
- 引用别的 issue 时 `#N` 真存在；不确定 `gh issue view <repo>#N` 验过再放。
- 引用 child PR / issue 时数字对得上 GitHub 上实际编号。
- 若是 future-work issue：有 `Problem / Expected Outcome / Context / Acceptance Criteria / Dependencies`，每条 acceptance criterion 都是结果导向 checkpoint 表格行。
- future-work checkpoint 都有 Dimension / Check / Command / Env / Expect；没有空泛的 `[ ] tests pass`。
- checkpoint 验证结果而不是方案：能证明用户可见问题解决、无效输入被拒、目标环境可运行、下游能消费或假设成立。
- checkpoint 覆盖相关维度：Docker / VM / deployment 有 `environment`；下游消费有 `integration`；第三方/推测假设有 `assumption`。
- issue 没有写内部解决方案、模块结构、protocol choice、state-machine design 或命名偏好；除非这些是源需求明确给出的外部约束。
- 有延期验证时写进 `Inherited Verification Obligations`，且没有二次延期。
- 有高风险假设时先开 spike，implementation issue 依赖 spike 结果。
- 做过 adversarial validation：最省事路径不能在用户可见问题仍未解决时通过 checkpoint；易混术语已在首次出现处消歧。
- 目标 repo 若跑 coder-loop preset，已查过 preset contract（如 `presets/<preset>/contract.md`），其 label / section / gate 规则与本 skill 冲突时以 preset contract 为准。

## When this skill applies

Trigger 这个 skill 的场景：开新 issue（不论 bug / feature / RFC）、起草 retroactive umbrella、给现有孤儿 issue 决定 sub-issue parent、把单层 umbrella 重写成 PM 层级。

不适用：PR body 写作（用 `writing-pr`）、改已有 issue body（禁止）、issue 上的 comment（直接写中文散文，没有特定形式）。
