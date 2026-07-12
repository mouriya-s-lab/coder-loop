# `gh-issue-pr-iteration` Preset Contract

读者：contract-enrichment、iteration 与 review agent。

原 issue body 与后续 operator comments 是任务 intent，不要求预先包含实现前无法知道的 Pattern、canonical runtime/E2E、精确 Command 或 test-delta authorization。`contract-enrichment` 调查当前源码、target rules 与运行现场后，在 GitHub issue comment 发布 `schema=1` executable-contract marker；iteration/review 按 `common/executable-contract.md` 读取唯一 current packet。

本文档余下的 issue 结构是 enrichment 判断 intent 与 deliverable 的输入指南，不再是要求存量 issue writer 未卜先知的 executable authority。literal checks、Pattern scope、runtime/E2E、test delta 与 dependencies 以当前 marker packet 为准；缺失或 malformed marker 必须回 contract 路径，禁止静默解释 live issue body。PR protocol 仍由本文档与 marker packet共同约束。

---

## 1. Issue body 契约

### 1.1 标题

- 单一主语。review 的 title-intent 验收对比 issue title 与 PR title 的主语 noun phrase，含 `and / + / 、 / /` 拼多个话题 → 永远判 drift。
- 允许 conventional commit 前缀（`feat: / fix: / refactor(...): / chore: / docs(...): / RFC:`），验收在主语提取时会 strip。
- 标题中文（用户操作员要求）；mechanical token（`<repo>#<N>` / 文件路径 / 命令）原样保留。

### 1.2 Intent clues and deliverable enrichment

The issue need not follow a coder-loop-only checklist. Enrichment reads the complete body and later operator comments, preserves their wording as intent, and selects exactly one marker `Deliverable`:

- 实现-PR-deliverable → `implementation-pr`
- Unblock-deliverable → `blocker-removal`
- Comment-spike-deliverable → `spike-comment`
- Source-writing-spike-deliverable or an already-satisfied/invalid task → the applicable no-PR marker variant

Headings such as `## 目标`, `## 问题`, `## 预期结果`, `## 验收标准`, `## 结果分支`, `## 阻塞条件`, and `Unblocks:` are evidence for intent, not a required executable schema. Missing or malformed legacy tables do not by themselves make the issue invalid. Enrichment resolves ambiguity by inspecting source, target rules, runtime, linked objects, and later operator corrections; it records the selected route and sources in the marker.

### 1.3 Executable checks

The current marker's `Checks` table is the only row-by-row replay contract. Its stable IDs and `shell | browser` variants follow `enrichment/contract-schema.md`. A legacy `## 验收标准` or `## 继承验证义务` table is an input to enrichment, never executed directly after enrichment. Shell commands remain literal shell; browser actions and observations are typed browser fields and are never translated from a shell-looking `Command` cell.

### 1.4 Pattern, runtime, tests, and dependencies

Pattern scope, canonical runtime/E2E, test-delta authorization, and verified dependencies come from the current marker. The target-mandated real E2E driver may be a repository script; accept it when it drives the real consumer path named by target rules. Do not reject or accept evidence merely because the driver is implemented as a script.

### 1.5 Result branches and follow-up

Spike result branches in the issue remain intent. Enrichment records the executable route and decisive checks; iteration reports the observed branch with sources. Follow-up issue proposals stay proposals unless review's graph action creates them.

### 1.6 Authority split

Title/body/comments answer **what and why**. The unique current marker answers **what exactly to execute and judge**. A missing, ambiguous, malformed, or stale marker selects `contract_invalid` and re-enrichment; iteration/review must not guess, reinterpret the body, or demand that the original author retroactively supply an implementation-time checklist.

## 2. PR body 契约

### 2.1 First line: 关闭关键字

PR body **第一行**必须是：

```
Closes #<ISSUE>
```

review 的 PR protocol 验收 grep PR body 第一行。缺失 / 在非第一行 / 关键字写错（`Close` 单数 / `Fixes` 等也是 GitHub 关键字但本 preset 强制 `Closes`） → retry。

一个 PR closes 恰好一个 issue。多 issue → 拆 PR。

### 2.2 PR title

与 issue title 主语对齐（见 §1.1）。允许的差异：conventional commit 前缀、`(N/M)` 编号、语言切换、 minor 措辞调整（如 issue "加 net0 channel 健康探测" vs PR "feat(net0): add channel health probe"）。

### 2.3 四层证据 packet

PR body和每轮 retry comment都保留四个固定 heading，与 `templates/pr-body.md` 一致：

- `Layer 1 — Change preview`
- `Layer 2 — Landing checks`
- `Layer 3 — Startup / runtime ordering`
- `Layer 4 — End-to-end behavior`
- `Analysis`

每层引用 current marker URL/schema/source revision，并把 claim 映射到稳定 Check ID。没有适用内容时保留 heading，写 marker-cited not-applicable reason，不删除层。Layer 4 按 marker `Canonical runtime` 运行 target-mandated real driver；driver 是仓库脚本并不使证据失效，关键是它是否驱动真实消费路径并产出可观察结果。

### 2.4 CI parity 行

若 target 有可复现的 CI，PR body 或 PR 评论必须含一行 explicit 声明：

```
CI parity: 本地 `<command>` 与 CI 等价，已 PASS。
```

无 CI 的 repo（本 repo 无 CI）则写：

```
CI parity: 本仓无 CI；本地 `<command>` 等价 CI gate，已 PASS。
```

PR protocol 验收 grep "CI parity" 或 "本仓无 CI" 任一 token。

### 2.5 Retry 时的 PR thread 评论

每次 iter retry 必须在 PR thread 发新评论（不是改 PR body），记录：

- 本轮 addressed 的 review feedback；
- 改了哪些文件 / 行为；
- 当前完整的四层证据 packet（不要只贴 diff 的那一层）。

PR protocol 验收检查"是否每轮有新 thread 评论"。仅改 PR body 不算 retry response，会被判 retry。

### 2.6 PR vs Issue 评论位置

PR 存在后：

- 实现 / review 讨论一律在 PR thread；
- issue 上只发"task scope 本身有问题 / blocked / 整 PR 无效需替代"的评论；
- iter retry response 一律在 PR thread，不发到 issue 上。

PR protocol 验收检测"最新 retry response 是否在 issue 而非 PR" → retry。

---

## 3. Review 验收点总表

Review 是调度者（orchestrator）：PR-backed 路由必须先派 diff-audit 与 replay 两个 subagent 真跑、拿齐两份已验收报告后才允许做 body 判断与 verdict；诚实性/协议判断由调度者亲自做。每次 PR 回复（retry 反馈与 accept 总结）都是完整 review 报告：每个 check 一节引实测值 + `## 缺失汇总` 单一权威缺口区 + `## Skipped checks` 写明理由。按 `review-entry.md` 的 phase 顺序列出每个验收点（entry 与 quality/ 文件做 ground truth）：

| 验收点 | 执行方 | 输入 | 规则 | 失败处置 |
|---|---|---|---|---|
| Diff audit | diff-audit subagent 真跑（纯读） | PR diff vs base + changed code 本体 + diff 中的测试变更 + current marker 声明的 Pattern scope | 每个 changed file 映射到 issue scope；runtime artifacts / scheduling state 不入仓；diff 中的测试删/改名/skip/弱化逐条枚举（含 test-collection config/glob/skip-marker/CI 变化）；代码审查锚定 issue 设计：逻辑错误（须可追溯失败路径）/ 偏离 issue 声明的设计（须引原句）/ 违反项目 conventions（须引来源）/ diff 内结构缺陷；并对 current marker 的 typed Pattern rows做一次性全仓 site 枚举——其余发散性发现不进 verdict | retry action（引用全部失败行 + 每个 pattern 的全部剩余 site） |
| Replay | replay subagent 真跑（占 AGENT_CWD + 驱动 typed runtime handoff） | current marker 的全部 stable-ID Checks + iter 的 runtime manifest + PR packet e2e claims | canonical 全套测试命令按 runner 自身汇总行取头端计数（不用静态 rg / grep）；逐行执行/复验（列 `# / Dimension / Check / Command / Env / Expect`，actual vs Expect）；`Env=browser` 行在 e2e re-drive 的真 UI walk 内执行并对照 Expect；对 packet e2e 主张按 iter 交接的 runtime manifest 复跑（程序真实入口 / agent-browser 真 UI）；unblock-deliverable 路由必含 blocked-path e2e；packet E2E 未按 marker 命名的 target-mandated real driver 驱动真实路径即失败；manifest 缺项计为 packet 失败；未跑行仅两种合法形态：setup 未完成（附尝试记录）/ manifest 缺项 | retry action（引用全部失败行） |
| Checks/mergeability | 调度者亲自 | live PR checks（names/conclusions/timestamps/head SHA）+ mergeStateStatus | 实测观察；pending/hung 不算 mergeable；CI 合法在跑 → retry 附 observe-again | retry action |
| Trace honesty | 调度者亲自 | iter 汇报/trace + GitHub live state | 每个声明有对应观察（`quality/honesty.md` claim-vs-observation） | retry action |
| PR protocol | 调度者亲自 | PR body + thread + issue comments | first line `Closes #<N>`、CI parity 行、retry 必有新 PR-thread comment | retry action / no-PR 路由 |
| Title-intent | 调度者亲自 | issue title + PR title | strip conventional prefix 后主语 noun phrase 对齐 | retry action |
| Caveat honesty | 调度者亲自 | handoff `Intent/Result (run …)` blocks + PR body/comments（scope-reduction 触发相关段落原文引用）+ diff-audit 报告（intent↔action 比对） | `quality/honesty.md` 七类 scope-reduction 触发；cosmetic-handwave 一律硬拒；授权须 current marker Test delta 或可追溯 intent source，stale-baseline 例外见同文件 | retry action |
| Evidence form | 调度者亲自 | PR body（opening packet）/ 最新 run 的 PR comment | `quality/evidence.md`：分层齐全、claim 映射、artifact 可查、测试清单 delta 在场、**真实路径 E2E 证据**（按 marker Canonical runtime 的 target-mandated real driver；仓库脚本只要驱动真实消费路径即可）、**runtime manifest** 在场且可凭其重跑（auth 只写解析位置，secret 值入包即硬拒）；unblock-deliverable 路由额外要求 blocked-path 复测 | retry / blocked action |
| Spike follow-up（comment-spike-deliverable） | 调度者亲自（`review/spike-followup.md`） | iter comment + issue `## 结果分支` | 选恰好一条分支 + 提议数 ≥ 分支动词词表要求 | retry action |
| Source-spike audit（source-writing-spike-deliverable） | 调度者亲自（`review/source-spike-audit.md`） | issue comment + spike branch + 证据 | no-merge 语义、branch/SHA、命令覆盖、结果分支；有 PR 即 retry | retry action |
| Closure | 调度者亲自 | 上面验收点综合 + child closure table | 决定 terminal action（accept-pr / accept-no-pr / retry / expand-parent / skip / blocked / stop） | 选 action 文件 |

代码审查**在 loop 内**，锚点是 issue 声明的设计：逻辑正确性、conventions、diff 内结构由 diff-audit 步审，所有发现必须带锚（可追溯失败路径 / issue 原句 / convention 来源），**不发散**——替代设计、issue 设计之外的改进想法、diff 没碰的代码一律不进 verdict（diff 外既有问题至多在 Problems 记一行 out-of-scope observation）。PR-backed 路由缺少两份派发报告（diff-audit / replay）任意一份的 verdict 无效（仅 no-PR 路由与 infra-stop 例外）。review 的每条 PR 回复是全量报告：每个 check 一节引实测值（SHA / 计数 / 原句引用 / URL / 时间戳）——这些值只有真做了检查才存在。

---

## 4. Deliverable 路由

每个验收点是否跑、按哪个 deliverable 路由跑——以 `review-entry.md` 底部的「Deliverable routing matrix」为单一来源；本文档不再复述同一张表。issue 作者从这张表反推自己写的 issue body 在 review 时会经过哪些 gate：

- 实现-PR-deliverable / unblock-deliverable issue 都走 PR-backed 路由（两份 dispatch 报告 + 全套 self-judgment）；
- comment-spike-deliverable / source-writing-spike-deliverable issue 走 no-PR 路由（仅 self-judgment + 对应的 spike 判断指南）；
- unblock-deliverable issue 还要在 replay 与 evidence form 上接受额外的 blocked-path 复测要求。

---

## 5. Generic issue-writing boundary

Generic issue authors provide clear intent, sources, constraints, dependencies, and observable desired outcomes. They are not required to predict exact Commands, Pattern scope, target runtime orchestration, or test-delta authorization before source/runtime investigation. Those fields belong to contract-enrichment. Existing issues are valid enrichment inputs even when their section layouts differ.

## 6. Contract invalidation and re-enrichment

A defect in the current executable packet—broken Check, wrong Pattern scope, stale source revision, incorrect canonical driver, missing dependency, or ambiguous current marker—is not an implementation retry. Publish the defect with sources and select the preset's `contract_invalid` exit so the declared next-node edge returns to `contract-enrichment`. Preserve the original issue body as intent; a superseding marker links the prior marker in `Supersedes`.

## 7. 用户级 skill 软引用与自包含 issue-writing 规则

用户级 `writing-issue / writing-pr / review-pr` skill 是 operator 个人资产，不属于 engine 或 preset 的分发物。issue writer **可以**在本机存在这些 skill 时参考其写作习惯；不存在、不可读、版本不同都不得阻塞 issue 编写，也不得要求先安装或同步。本文档是必需规则的权威来源。

### 7.1 自包含规则索引

| 规则 | 本 preset 的权威位置 |
|---|---|
| 标题单主语、中文、禁用多 topic 连接 | §1.1 / §1.6 / §7.2 |
| issue 必备段 | §1.2 |
| `## 验收标准` 表形态 | §1.3 |
| 继承验证义务 | §1.4 |
| Spike `## 结果分支` | §1.5 |
| 标题与 body 形态匹配 | §1.6 |
| 原子性、citation、parent/child、retroactive umbrella、re-parenting | §7.2 |
| PR body、证据、retry 位置 | §2 |

### 7.2 Issue-writing hygiene base

- **One issue, one problem.** 一个可执行 issue 只能有一个主问题和一个可连贯解释的 `## 问题` / `## 目标`。如果 body 需要多个互不依赖的动机段、多个 title 主语，或一个 PR 无法自然 close 全部动机，必须拆成多个 child issue；若它们共享同一个业务驱动，再建 parent umbrella 解释共同背景。
- **Atomicity test.** 起草前先问：能否写出一个不靠列表堆叠的单段理由来证明这个 issue 的全部范围？能则保留；不能则回到分解。不要用 "顺手"、"同文件"、"同模块" 合并独立问题。
- **Citation.** 每条动机句必须追溯到可检查来源：issue/PR body、commit message、design doc、log/evidence artifact 或用户原话。推荐格式：`> "..." — <repo>#<N> body`、`<repo>@<short-sha> commit`、`<path>:<line>`。没有来源的动机不得写进 issue；引用原文不要翻译或拼接伪造。
- **Required sections.** Future-work issue 使用 §1.2 的段结构；`## 验收标准` 只使用 §1.3 表格，不用自然语言 checklist 替代。`## 问题` 和 `## 预期结果` 写用户/agent 可观察的痛点与收益，验证命令和实现细节放入 `## 验收标准` 或 `## 约束`。
- **Forbidden title/body shape.** 标题不得用 `and` / `+` / `/` / `、` 拼多个主题；body 不写内部 draft id、未来源化的方案偏好、实现模块结构、protocol choice、未来态 `[ ]` checklist、或把 PR 当成有子 issue 的节点。
- **Parent/child graph.** GitHub sub-issue 只连接 issue-to-issue；PR 只能通过 PR body 第一行 `Closes #<ISSUE>` 归属 issue。创建 parent/child 关系时用 GitHub GraphQL `addSubIssue`；child 已有 parent 时先判断是否真的需要 re-parent，记录原因，再移除旧 parent 后挂到新 parent。跨 repo child 必须写完整 `<owner>/<repo>#<N>` 引用，不能靠当前 repo 省略。
- **Retroactive umbrella.** 已落地工作补 umbrella 时必须在 `## 背景` 或 `## 为什么` 首段明说它是 retroactive，写清落地时间窗口，并列出已合并 PR/commit。Retroactive umbrella 不写未来态验收 checklist；用已落地事实、引用和 PR 列表说明完成内容。
- **Re-parenting and duplicate links.** 发现错误 parent 时不要复制一个新 child 或把旧链接留作模糊历史；读取当前 parent/children，说明迁移理由，执行一次明确 re-parent。`addSubIssue` 返回 duplicate 时把它当成已满足的幂等结果记录，不重复创建。

---

## 8. 何时本 contract 需要更新

任何下列改动落地时必须同步更新本文档（顺带改 `docs/gh-issue-pr-iteration-fragments.md`、`src/preset.test.ts` 的 `EXPECTED_FRAGMENTS`、`preset.toml` 的 `[[fragments]]`）：

- `review-entry.md` 任一验收点的判定规则变更，或 `quality/*.md` 判据变更；
- step 单文件（`iter/steps/*.md` / `review/steps/*.md`）Task / Report / Acceptance 三段解析口径变更；
- `runtime.*` 白名单增 / 减 key、preset business key 表增减；
- 四层证据层名 / 数量 / 必填规则变更；
- `Closes` 关键字位置 / `Closes` 动词放宽。

本文档与 entry/quality 实际判定逻辑漂移 → issue writer 产 issue 后 review 验收拒绝，trace 上看不出原因——这是反复出现的失败模式，根本避免方式是把 contract 当验收实现的一部分维护。
