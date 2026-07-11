# `gh-issue-pr-iteration` Preset Contract

读者：给本 preset queue 灌 issue 的 **issue writer**（operator、上游 slash command、或任何按本 preset 契约往目标 repo 写 GitHub issue 的角色）。同时也是 iter / review 调度者期待 issue / PR 形态的**单一来源**——iter/review agent 在运行时读本文档判定 issue/PR 是否合契约。

读完后你能：照本文档写出一个 issue body，保证它能通过 review 调度者的 contract replay / spike follow-up / title-intent 验收；写出一个 PR body，保证它能通过 PR protocol / evidence form 验收。

本文档是本 preset 写 issue / PR / review 形态的自包含契约。用户级 `writing-issue / writing-pr / review-pr` skill 若存在可作 operator 个人参考；缺失不得阻塞 issue 编写，冲突时本文档胜。软引用边界见 §7。

---

## 1. Issue body 契约

### 1.1 标题

- 单一主语。review 的 title-intent 验收对比 issue title 与 PR title 的主语 noun phrase，含 `and / + / 、 / /` 拼多个话题 → 永远判 drift。
- 允许 conventional commit 前缀（`feat: / fix: / refactor(...): / chore: / docs(...): / RFC:`），验收在主语提取时会 strip。
- 标题中文（用户操作员要求）；mechanical token（`<repo>#<N>` / 文件路径 / 命令）原样保留。

### 1.2 必备段（按 deliverable 形态）

Issue 的 deliverable 形态由 issue body 自身的内容决定——本 preset 不再用 label 编码它。issue writer 按 §1.6 的标题/必备段对应关系写出形态，review/iter 调度者在读 issue 时按 body 内容判断走哪条工作流。

实现-PR-deliverable issue（最常见的形态，body 描述要做的代码/配置/文档变更，下游交付物是合并的 PR）必须含：

- `## 目标`
- `## 上下文`（含 Repo + 本地路径 + design source）
- `## 问题`
- `## 预期结果`
- `## 验收标准`（详见 §1.3）
- `## 依赖关系`

可选段：`## 约束`、`## 继承验证义务`（见 §1.4）。

Comment-spike-deliverable issue（spike / 设计 dialogue，下游交付物是 issue comment）必须含：

- `## 目标`
- `## 上下文`
- `## 验证步骤`（spike 走的具体步骤）
- `## 验收标准`（即使是 spike，也用同一张表说"何为通过"）
- `## 结果分支`（详见 §1.5）
- `## 依赖关系`

Source-writing-spike-deliverable issue（source-writing spike，下游交付物是 no-merge branch/evidence/comment）必须含：

- `## 目标`
- `## 上下文`（含 Repo + 本地路径 + design source）
- `## 问题`
- `## 预期结果`
- `## 验证步骤`（spike 走的具体 runtime / source-writing 步骤）
- `## 验收标准`
- `## 结果分支`（详见 §1.5）
- `## 依赖关系`
- `## 约束` 必须包含 no-merge / no-PR 字面要求（review 在 source-spike-audit 里据此判 PR 存在 = retry）。

Unblock-deliverable issue（解除阻塞，下游交付物是 PR + 跨 issue 的 unblock 副作用）必须含：

- `## 目标`
- `## 上下文`（含 Repo + 本地路径 + blocked 来源）
- `## 阻塞条件`（具体说明哪个命令 / runtime path / issue / evidence gap 目前 blocked）
- `Unblocks: owner/repo#N`（unblock 契约的唯一 wiring 入口，必须有；确实没有 back-link 时必须说明原因）
- `## 预期结果`
- `## 验收标准`（必须包含真实 blocked path 的 e2e/integration 复测——review 据此判 unblock 是否真的解除）
- `## 依赖关系`

### 1.3 `## 验收标准` 表（review contract replay 逐行执行）

review 调度者对实现-PR-deliverable 与 unblock-deliverable 的 issue 派 replay subagent 强制逐行复验：

- 必须有 `## 验收标准` heading（无则 replay 对该表自跳过，PR 可能无证据要求基础，但 evidence form 验收仍会查四层证据）。
- heading 下必须是 markdown pipe table，**列名顺序固定**：

  ```
  | # | Dimension | Check | Command | Env | Expect |
  |---|-----------|-------|---------|-----|--------|
  ```

  列名 / 列数与上面任一 token 不一致 → replay 判表损坏 → retry，feedback "issue body 验收标准 table malformed"。

- 每行的列含义：
  - `#` — 行号 1, 2, 3 …
  - `Dimension` — 4 个取值之一：`function` / `environment` / `integration` / `assumption`。
  - `Check` — 中文短句，描述这条 check 验证什么。
  - `Command` — 可执行 shell 命令字符串，反引号包裹（` `` `）。包含 `|` 时用 `\|` 转义。
  - `Env` — 行执行环境，取值之一：`local` / `VM` / `container` / `CI` / `browser` / `downstream` / `integration`。
  - `Expect` — 预期 actual。可以是 exit code（`exit 0`）、grep 匹配数（`≥ 1`）、布尔（`true`）、文件存在等。
- 每行**review 的 replay subagent 真的会执行或验证**：
  - `Env == local` → replay subagent 在 `{{AGENT_CWD}}` 跑 `Command`（in-repo case 时 `AGENT_CWD == TARGET_CWD`；cross-repo iteration 时 = item.agentCwd 所指向的外部 repo checkout），比对 stdout/stderr/exit 与 `Expect`。
  - `Env == browser` → replay subagent 在 e2e re-drive 的真 UI walk 内执行行的 Command 并对照 Expect（同一份 subagent 报告的 `Browser acceptance rows` 表）。
  - 其他 Env → replay 在 PR 证据 packet 里找匹配 artifact（iter 的 verify/submit 步骤必须放进去），且环境可达时尽量真重跑取得更强信号。

写表时遵守：

- 每行 `Check` 是结果导向的，不是"采用某实现"。"调用 `foo()` 函数" ❌；"输入无效时返回 4xx" ✅。
- `Command` 必须能在 `Env` 列声明的环境真跑通。"some build command" ❌；"`mise run build`" ✅。
- 不写 `[ ] tests pass` 这种自然语言 checkbox——contract replay 不解析 checkbox，只解析 table。
- 维度覆盖：涉及 Docker / VM / deployment 必有 `environment`；下游消费必有 `integration`；第三方 / 未文档化假设必有 `assumption`。

### 1.4 `## 继承验证义务` 表（可选）

仅当 issue 从上游继承了延期验证时写。表头：

```
| From | Original # | Check | Command | Env | Expect |
|------|------------|-------|---------|-----|--------|
```

contract replay 把 `## 继承验证义务` 行 concat 到 `## 验收标准` 行后面，全部逐行执行。继承的 obligation 不可二次延期——若当前 issue 仍跑不了，必须把它降级为 comment-spike-deliverable issue 或重新分配给真能跑的下游 issue。

### 1.5 `## 结果分支`（spike follow-up 判断解析）

Comment-spike-deliverable 与 source-writing-spike-deliverable issue 都要写。review 调度者按 `review/spike-followup.md` / `review/source-spike-audit.md` 判断指南用这段判 spike comment 是否选了正确分支 + 提议足够 sub-issue。

格式：

```
## 结果分支

- **If passed**: <动作>。<对应 sub-issue 提议要求>。
- **If failed**: <动作>。<对应 sub-issue 提议要求>。
- **If <其他条件>**: <动作>。<...>
```

解析规则：

- 每条分支以 `**If <条件>**:` 起手。
- 验收在 iter 的 spike comment 文本里找 "选了哪个分支"——comment 必须 quote 或明确指明 picked branch。
- 验收根据 picked branch 的文本判断**最少需要几个 sub-issue 提议**：
  - 分支文本含 `create` / `file` / `propose` / `开` / `提议` / `创建` 任一动词，或明确点名某 follow-up issue 类型 → 至少 1 个具体 sub-issue title 提议。
  - 分支文本是 "no follow-up needed" / "no action" → 0 个 sub-issue 提议。
- 提议 sub-issue title 必须具体（不是 `TBD` / `<title>` / `?`），否则判 "vague proposals do not satisfy the minimum"。

### 1.6 标题与 body 形态匹配

iter 与 review agent 通过这套 title/body 对应关系判断 issue 的 deliverable 形态——既是 issue writer 写时的 self-check，也是消费端读时的对照锚。

- 实现-PR-deliverable issue 标题动词偏 "实现 / 加 / 修 / 重构"，body 必有 `## 验收标准`，下游交付物是一份合并的 PR。
- Comment-spike-deliverable issue 标题偏 "Spike: 验证…" / "评估…"，body 必有 `## 验证步骤` + `## 结果分支`，下游交付物只有 issue comment（无 PR、无代码变更）。
- Source-writing-spike-deliverable issue 标题偏 "Spike: 验证…" / "PoC: 验证…"，body 必有 `## 验证步骤` + `## 结果分支`，并在 `## 约束` 中明确 no-merge / no-PR 字面要求；下游交付物是 spike 分支 + evidence + issue comment（绝不合并进生产线）。
- Unblock-deliverable issue 标题偏 "解除 / unblock / resolve blocker"，body 必有具体阻塞条件、`Unblocks: owner/repo#N` back-link（缺则说明原因）、`## 验收标准`，且验收必须包含真实 blocked path 的 e2e/integration 复测——下游交付物是 PR + unblock 跨 issue 副作用。
- 标题 prefix `RFC:` 偏 retroactive umbrella（见 §7.2）；这种 issue 在 coder-loop 队列里通常用作 parent，不直接 queue 实现。

---

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

PR body 必须含四层证据（review 的 evidence form 验收解析）。每层一节，每节含：可执行命令 + actual 输出 + verdict。任何一层缺失 → retry / blocked。

层名（与 `## 验收标准` Dimension 一一对应）：

- **Functional** — 代码逻辑验证（单测 / 直接调用）。
- **Environment** — 目标环境验证（VM / container / browser / OS）。
- **Integration** — 下游 / 跨服务 / E2E 验证。
- **Assumption** — 第三方 / 未文档化行为验证（spike-style）。

没有相关 Dimension 的层可省略并在 PR body 说明 "无 X 行的验收（issue 无此 Dimension）"，evidence form 验收接受这种省略。

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
| Diff audit | diff-audit subagent 真跑（纯读） | PR diff vs base + changed code 本体 + diff 中的测试变更 + issue body 点名的全仓收敛模式 | 每个 changed file 映射到 issue scope；runtime artifacts / scheduling state 不入仓；diff 中的测试删/改名/skip/弱化逐条枚举（含 test-collection config/glob/skip-marker/CI 变化）；代码审查锚定 issue 设计：逻辑错误（须可追溯失败路径）/ 偏离 issue 声明的设计（须引原句）/ 违反项目 conventions（须引来源）/ diff 内结构缺陷；并对 issue body 自己点名的全仓收敛模式（`## 不应残留` / `## 预期结果` "升一等类型 / 不再 …" / `## 验收标准` 数值红线）做一次性全仓 site 枚举——其余发散性发现不进 verdict | retry action（引用全部失败行 + 每个 pattern 的全部剩余 site） |
| Replay | replay subagent 真跑（占 AGENT_CWD + 驱动 typed runtime handoff） | issue `## 验收标准` + `## 继承验证义务` 全部行 + iter 的 runtime manifest + PR packet e2e claims | canonical 全套测试命令按 runner 自身汇总行取头端计数（不用静态 rg / grep）；逐行执行/复验（列 `# / Dimension / Check / Command / Env / Expect`，actual vs Expect）；`Env=browser` 行在 e2e re-drive 的真 UI walk 内执行并对照 Expect；对 packet e2e 主张按 iter 交接的 runtime manifest 复跑（程序真实入口 / agent-browser 真 UI）；unblock-deliverable 路由必含 blocked-path e2e；packet e2e 为脚本产物即 form 失败；manifest 缺项计为 packet 失败；未跑行仅两种合法形态：setup 未完成（附尝试记录）/ manifest 缺项 | retry action（引用全部失败行） |
| Checks/mergeability | 调度者亲自 | live PR checks（names/conclusions/timestamps/head SHA）+ mergeStateStatus | 实测观察；pending/hung 不算 mergeable；CI 合法在跑 → retry 附 observe-again | retry action |
| Trace honesty | 调度者亲自 | iter 汇报/trace + GitHub live state | 每个声明有对应观察（`quality/honesty.md` claim-vs-observation） | retry action |
| PR protocol | 调度者亲自 | PR body + thread + issue comments | first line `Closes #<N>`、CI parity 行、retry 必有新 PR-thread comment | retry action / no-PR 路由 |
| Title-intent | 调度者亲自 | issue title + PR title | strip conventional prefix 后主语 noun phrase 对齐 | retry action |
| Caveat honesty | 调度者亲自 | handoff `Intent/Result (run …)` blocks + PR body/comments（scope-reduction 触发相关段落原文引用）+ diff-audit 报告（intent↔action 比对） | `quality/honesty.md` 七类 scope-reduction 触发；cosmetic-handwave 一律硬拒；授权须 issue body 字面句，stale-baseline 例外见同文件 | retry action |
| Evidence form | 调度者亲自 | PR body（opening packet）/ 最新 run 的 PR comment | `quality/evidence.md`：分层齐全、claim 映射、artifact 可查、测试清单 delta 在场、**e2e 直跑证据**（真实入口实跑 / agent-browser 真 UI；脚本 e2e 一律不算，unit/integration 只是辅助层）、**runtime manifest** 在场且可凭其重跑（auth 只写解析位置，secret 值入包即硬拒）；unblock-deliverable 路由额外要求 blocked-path 复测 | retry / blocked action |
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

## 5. Issue-writing 不变量（写给灌 queue 的 issue writer）

issue writer 必须：

- 每个新 issue 走 §1 形态校验后再 `gh issue create`；
- 不在 issue body 里写实现方案 / 模块结构 / protocol choice / 命名（除非源 design 明确给出）；
- 高风险未文档化假设拆成独立 comment-spike-deliverable issue（按 §1.2 的 comment-spike 必备段写），spike `Blocks: #<impl>` 标明依赖；
- `## 验收标准` 表的 `Command` 列必须能在 `Env` 列声明的环境真跑通——issue writer 自己应该在 issue 未来的 spawn cwd 下试跑 `local` 行的命令做 smoke check（in-repo work = `{{TARGET_CWD}}`；cross-repo work = 该 queue item 计划写到 `agentCwd` 的那个绝对路径）；
- 用 `coder-loop item add` / `item batch-add` 把 issue 入队后跑 `coder-loop status <target> --json --chain <chain-name>` 确认 exit 0、`.state.ok == true`、`.queue.selected.id` 指向预期 next item。

issue writer 禁止：

- 直接开 PR / 合 PR / 关 issue / 删 central daemon scheduling state（这些是 iter / review 的事）；
- 在散文 issue body 里偷偷塞 `[ ] foo` checkbox 代替 `## 验收标准` 表；
- 把多个无关问题打包进同一 issue（违反 atomic）。

---

## 6. 当 `## 验收标准` 表能省略

少数实现-PR-deliverable issue 太小（trivial 重命名 / 格式化），写不出有意义的 5 行表。允许省略 `## 验收标准`，contract replay 对表自跳过。代价：reviewer 完全靠四层证据 packet 判断，不享受 row-by-row 强制。issue writer 决定省略时必须在 issue body 写一句 "本 issue trivial，无 `## 验收标准` 表；依赖 PR 四层证据"——给 review agent 看见 explicit 决定，不是漏写。

Unblock-deliverable issue 不能省略 `## 验收标准`：至少要有一个真实 blocked path 的 e2e/integration 复测。Comment-spike-deliverable 与 source-writing-spike-deliverable issue 也不能省略 `## 验收标准`：spike 必须有"何为通过 / 失败"的判据，否则 review 无法判 picked branch 是否合理。

---

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
