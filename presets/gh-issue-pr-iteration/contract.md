# `gh-issue-pr-iteration` Preset Contract

读者：要把用户大任务转换成本 preset 可消费 queue 的 planning agent（跑 `plan/` fragment chain 的那个）。也是 iter / review agent 期待 issue / PR 形态的**单一来源**。

读完后你能：照本文档写出一个 issue body，保证它能通过 commitment-gate / spike-followup-gate / title-intent-gate 的解析；写出一个 PR body，保证它能通过 pr-protocol / evidence-gate。

本文档不替代用户级 `writing-issue / writing-pr / review-pr` skill，只 override 与本 preset gate **解析**相关的字段。继承 / 覆盖范围见 §7。

---

## 1. Issue body 契约

### 1.1 标题

- 单一主语。`title-intent-gate` 对比 issue title 与 PR title 的主语 noun phrase，含 `and / + / 、 / /` 拼多个话题 → 永远判 drift。
- 允许 conventional commit 前缀（`feat: / fix: / refactor(...): / chore: / docs(...): / RFC:`），gate 在主语提取时会 strip。
- 标题中文（用户操作员要求）；mechanical token（`<repo>#<N>` / 文件路径 / 命令）原样保留。

### 1.2 必备段（按 issue 类型）

`kind:code` issue（deliverable 是 PR）必须含：

- `## 目标`
- `## 上下文`（含 Repo + 本地路径 + design source）
- `## 问题`
- `## 预期结果`
- `## 验收标准`（详见 §1.4）
- `## 依赖关系`

可选段：`## 约束`、`## 继承验证义务`（见 §1.5）。

`kind:comment` issue（spike / 设计 dialogue，deliverable 是 issue comment）必须含：

- `## 目标`
- `## 上下文`
- `## 验证步骤`（spike 走的具体步骤）
- `## 验收标准`（即使是 spike，也用同一张表说"何为通过"）
- `## 结果分支`（详见 §1.6）
- `## 依赖关系`

### 1.3 Kind label 单值规则

每个 issue 必须带**恰好一个** `kind:*` label：

- `kind:code` — deliverable 是 PR + 代码变更。`runtime.issueKind = "code"`。
- `kind:comment` — deliverable 是 issue comment + 可选 sub-issue 提议。`runtime.issueKind = "comment"`。

引擎 fetch 行为（`src/loop.ts` 的 `parseKindFromLabels`）：

- 0 个 `kind:*` label → `runtime.issueKind = ""`（legacy / 旧 issue 兼容路径，三 gate 自跳过）；
- ≥ 2 个 `kind:*` label → spawn abort，stderr 报 "expected exactly one kind:\* label, found N"；
- `kind:<value>` 且 value 不在 `{code, comment}` → spawn abort，stderr 报 "unknown kind label"。

`gh issue create` 必须传 `--label kind:code` 或 `--label kind:comment`，不要省略也不要双带。

Repo 必须先有这两个 label。check：

```bash
gh label list --repo <owner>/<repo> --search kind:
```

返回为空 → 先建 label 再开 issue。

### 1.4 `## 验收标准` 表（`commitment-gate` 解析）

`review/commitment-gate` 对 `kind:code` 的 issue 强制：

- 必须有 `## 验收标准` heading（无则 gate 自跳过 `commitment_skipped`，PR 可能无证据要求基础，但 evidence-gate 仍会查四层证据）。
- heading 下必须是 markdown pipe table，**列名顺序固定**：

  ```
  | # | Dimension | Check | Command | Env | Expect |
  |---|-----------|-------|---------|-----|--------|
  ```

  列名 / 列数与上面任一 token 不一致 → `commitment_failed`，feedback "issue body 验收标准 table malformed"。

- 每行的列含义：
  - `#` — 行号 1, 2, 3 …
  - `Dimension` — 4 个取值之一：`function` / `environment` / `integration` / `assumption`。
  - `Check` — 中文短句，描述这条 check 验证什么。
  - `Command` — 可执行 shell 命令字符串，反引号包裹（` `` `）。包含 `|` 时用 `\|` 转义。
  - `Env` — 行执行环境，取值之一：`local` / `VM` / `container` / `CI` / `browser` / `downstream` / `integration`。
  - `Expect` — 预期 actual。可以是 exit code（`exit 0`）、grep 匹配数（`≥ 1`）、布尔（`true`）、文件存在等。
- 每行**review 真的会执行或验证**：
  - `Env == local` → review agent 在 `{{TARGET_CWD}}` 跑 `Command`，比对 stdout/stderr/exit 与 `Expect`。
  - `Env != local` → review 不跑，转而在 PR 证据 packet 里找匹配 artifact（commit-pr / verify-evidence 阶段必须放进去）。

写表时遵守：

- 每行 `Check` 是结果导向的，不是"采用某实现"。"调用 `foo()` 函数" ❌；"输入无效时返回 4xx" ✅。
- `Command` 必须能在 `Env` 列声明的环境真跑通。"some build command" ❌；"`mise run build`" ✅。
- 不写 `[ ] tests pass` 这种自然语言 checkbox——commitment-gate 不解析 checkbox，只解析 table。
- 维度覆盖：涉及 Docker / VM / deployment 必有 `environment`；下游消费必有 `integration`；第三方 / 未文档化假设必有 `assumption`。

### 1.5 `## 继承验证义务` 表（可选）

仅当 issue 从上游继承了延期验证时写。表头：

```
| From | Original # | Check | Command | Env | Expect |
|------|------------|-------|---------|-----|--------|
```

`commitment-gate` 把 `## 继承验证义务` 行 concat 到 `## 验收标准` 行后面，全部逐行执行。继承的 obligation 不可二次延期——若当前 issue 仍跑不了，必须把它降级为 `kind:comment` spike 或重新分配给真能跑的下游 issue。

### 1.6 `## 结果分支`（`spike-followup-gate` 解析）

仅 `kind:comment` issue 写。`review/spike-followup-gate` 用这段判 spike comment 是否选了正确分支 + 提议足够 sub-issue。

格式：

```
## 结果分支

- **If passed**: <动作>。<对应 sub-issue 提议要求>。
- **If failed**: <动作>。<对应 sub-issue 提议要求>。
- **If <其他条件>**: <动作>。<...>
```

gate 解析规则：

- 每条分支以 `**If <条件>**:` 起手。
- gate 在 iter 的 spike comment 文本里找 "选了哪个分支"——comment 必须 quote 或明确指明 picked branch。
- gate 根据 picked branch 的文本判断**最少需要几个 sub-issue 提议**：
  - 分支文本含 `create` / `file` / `propose` / `开` / `提议` / `创建` 任一动词，或明确点名某 follow-up issue 类型 → 至少 1 个具体 sub-issue title 提议。
  - 分支文本是 "no follow-up needed" / "no action" → 0 个 sub-issue 提议。
- 提议 sub-issue title 必须具体（不是 `TBD` / `<title>` / `?`），否则 gate 判 "vague proposals do not satisfy the minimum"。

### 1.7 标题与 body 形态匹配

- `kind:code` 标题动词偏 "实现 / 加 / 修 / 重构"，body 必有 `## 验收标准`。
- `kind:comment` 标题偏 "Spike: 验证…" / "评估…"，body 必有 `## 验证步骤` + `## 结果分支`。
- 标题 prefix `RFC:` 偏 retroactive umbrella（用户级 writing-issue 的 retroactive 形态）；这种 issue 在 coder-loop 队列里通常用作 parent，不直接 queue 实现。

---

## 2. PR body 契约

### 2.1 First line: 关闭关键字

PR body **第一行**必须是：

```
Closes #<ISSUE>
```

`review/pr-protocol` grep PR body 第一行。缺失 / 在非第一行 / 关键字写错（`Close` 单数 / `Fixes` 等也是 GitHub 关键字但本 preset 强制 `Closes`） → `pr-protocol` 判 `retry`。

一个 PR closes 恰好一个 issue。多 issue → 拆 PR。

### 2.2 PR title

与 issue title 主语对齐（见 §1.1）。允许的差异：conventional commit 前缀、`(N/M)` 编号、语言切换、 minor 措辞调整（如 issue "加 net0 channel 健康探测" vs PR "feat(net0): add channel health probe"）。

### 2.3 四层证据 packet

PR body 必须含四层证据（`evidence-gate` 解析）。每层一节，每节含：可执行命令 + actual 输出 + verdict。任何一层缺失 → `evidence-gate` 判 `retry` / `blocked`。

层名（与 `## 验收标准` Dimension 一一对应）：

- **Functional** — 代码逻辑验证（单测 / 直接调用）。
- **Environment** — 目标环境验证（VM / container / browser / OS）。
- **Integration** — 下游 / 跨服务 / E2E 验证。
- **Assumption** — 第三方 / 未文档化行为验证（spike-style）。

没有相关 Dimension 的层可省略并在 PR body 说明 "无 X 行的验收（issue 无此 Dimension）"，evidence-gate 接受这种省略。

### 2.4 CI parity 行

若 target 有可复现的 CI，PR body 或 PR 评论必须含一行 explicit 声明：

```
CI parity: 本地 `<command>` 与 CI 等价，已 PASS。
```

无 CI 的 repo（本 repo 无 CI）则写：

```
CI parity: 本仓无 CI；本地 `<command>` 等价 CI gate，已 PASS。
```

`pr-protocol` grep "CI parity" 或 "本仓无 CI" 任一 token。

### 2.5 Retry 时的 PR thread 评论

每次 iter retry 必须在 PR thread 发新评论（不是改 PR body），记录：

- 本轮 addressed 的 review feedback；
- 改了哪些文件 / 行为；
- 当前完整的四层证据 packet（不要只贴 diff 的那一层）。

`pr-protocol` 检查"是否每轮有新 thread 评论"。仅改 PR body 不算 retry response，会被判 `retry`。

### 2.6 PR vs Issue 评论位置

PR 存在后：

- 实现 / review 讨论一律在 PR thread；
- issue 上只发"task scope 本身有问题 / blocked / 整 PR 无效需替代"的评论；
- iter retry response 一律在 PR thread，不发到 issue 上。

`pr-protocol` 检测"最新 retry response 是否在 issue 而非 PR" → `retry`。

---

## 3. Review gate 解析规则总表

按 review phase 顺序列出每个 gate 实际 grep / 解析的内容（fragment 文件做 ground truth）：

| Gate fragment | 输入 | 解析规则 | 失败 verdict |
|---|---|---|---|
| `review/trace-honesty` | iter trace + GitHub live state | trace 中的 verdict 与 GitHub 实际状态一致 | `retry` |
| `review/pr-protocol` | PR body + PR thread comments + issue comments | first line `Closes #<N>`、CI parity 行、最新 retry 在 PR thread | `retry` / `no_pr_semantic_review` |
| `review/title-intent-gate` | issue title + PR title | strip conventional prefix 后主语 noun phrase 对齐 | `title_drift` |
| `review/evidence-gate` | PR body 四层证据 | functional / environment / integration / assumption 各一层（无相关 Dimension 可省略并 explicit 注明） | `retry` / `blocked` |
| `review/commitment-gate` | issue `## 验收标准` + `## 继承验证义务` table | 列 `# / Dimension / Check / Command / Env / Expect`、每行 actual vs Expect | `commitment_failed` |
| `review/spike-followup-gate` | iter spike comment + issue `## 结果分支` | comment 选了一条分支 + 提议数 ≥ 该分支动词词表要求 | `spike_followup_failed` |
| `review/code-gate` | PR diff + CI checks | merge-ability、CI 绿、no diff red flag | `retry` |
| `review/issue-closure-gate` | 上面 gate 综合结果 | 决定 terminal action | 选 action fragment |

---

## 4. Kind label 路由

每个 gate 按 `runtime.issueKind` 自跳过：

| Gate | `kind:code` | `kind:comment` | `""`（empty / legacy） |
|---|---|---|---|
| `pr-protocol` | 跑 | 跑（但 `no_pr_semantic_review`，无 PR 时跳过下游 gate） | 跑 |
| `title-intent-gate` | 跑 | `title_gate_skipped`（无 PR） | 跑（legacy 也可能漂） |
| `evidence-gate` | 跑 | `evidence_passed`（无 PR 即无四层证据要求） | 跑 |
| `commitment-gate` | 跑（仅当 `## 验收标准` 表存在） | `commitment_skipped` | `commitment_skipped` |
| `spike-followup-gate` | `spike_gate_skipped` | 跑 | `spike_gate_skipped` |
| `code-gate` | 跑 | 跳（无 PR） | 跑 |

---

## 5. Planning 阶段不变量（写给 `plan/` fragment chain 自己）

planning agent 必须：

- 每个新 issue 走 §1 形态校验后再 `gh issue create`；
- 每个 issue 带恰好一个 `kind:*` label（§1.3）；
- 不在 issue body 里写实现方案 / 模块结构 / protocol choice / 命名（除非源 design 明确给出）；
- 高风险未文档化假设拆成独立 `kind:comment` spike issue，spike `Blocks: #<impl>` 标明依赖；
- adversarial validation：对每个 future-work issue 思考 "iter 怎么用最省事的方式糊弄 checkpoint"，能糊弄就把 checkpoint 改严；
- `## 验收标准` 表的 `Command` 列必须能在 `Env` 列声明的环境真跑通——planning 自己应该在 `{{TARGET_CWD}}` 试跑 `local` 行的命令做 smoke check；
- 写 queue 进 `state.json` 后必须跑 `coder-loop --target-cwd <target> --check-runtime` exit 0，否则 plan/init-queue 不能 verdict pass。

planning agent 禁止：

- 直接开 PR / 合 PR / 关 issue / 删 `.dev-loop`（这些是 iter / review 的事）；
- 把 kind label 之外的 `kind:*` 值用进 `gh issue create`；
- 在散文 issue body 里偷偷塞 `[ ] foo` checkbox 代替 `## 验收标准` 表；
- 把多个无关问题打包进同一 issue（违反 atomic）。

---

## 6. 当 `## 验收标准` 表能省略

少数 `kind:code` issue 太小（trivial 重命名 / 格式化），写不出有意义的 5 行表。允许省略 `## 验收标准`，commitment-gate 自跳过。代价：reviewer 完全靠四层证据 packet 判断，不享受 row-by-row 强制。planning agent 决定省略时必须在 issue body 写一句 "本 issue trivial，无 `## 验收标准` 表；依赖 PR 四层证据"——给 review agent 看见 explicit 决定，不是漏写。

`kind:comment` issue 不能省略 `## 验收标准`：spike 必须有"何为通过 / 失败"的判据，否则 spike-followup-gate 无法判 picked branch 是否合理。

---

## 7. vs 用户级 skill 的继承 / 覆盖

`writing-issue / writing-pr / review-pr` 是 repo-agnostic hygiene base，本 preset contract 在以下字段 **override** 它们：

| 字段 | user-level skill 说 | 本 preset 强制 |
|---|---|---|
| 标题语言 | 用户操作员要求中文 | 继承（无差异） |
| 原子性 | one issue, one problem | 继承（无差异） |
| Cite 原文 | 每条动机句要 cite | 继承（无差异） |
| `kind:*` label | （应该退出 user-level skill） | 强制单值 `kind:code` / `kind:comment`，规则见 §1.3 |
| 必备段（future-work issue） | 目标 / 上下文 / 问题 / 预期结果 / 约束 / 验收标准 / 继承验证义务 / 依赖关系 | 继承，但 §1.4 强制表格列固定 |
| Acceptance checkpoint 形态 | "checkpoint rows with dimension, command, environment, expected result" | §1.4 强制 6 列名顺序 + Dimension 枚举 + Command 反引号 |
| Spike `## 结果分支` | 提到但无解析规则 | §1.6 强制动词词表 + 最少 sub-issue 提议数 |
| Retroactive umbrella | 详细描述 | 继承（这种 issue 不进 coder-loop queue 走 plan/，由用户手动 file） |
| PR body 四层证据 | `writing-pr` 提到 | §2.3 强制层名 = Dimension 取值 + 与 `## 验收标准` Dimension 一一对应 |
| `Closes` 关键字位置 | `writing-pr` 提到 | §2.1 强制 first line |
| Retry on PR thread | `writing-pr` / routing rule 提到 | §2.5 强制新 thread 评论，PR body 改不算 |

用户级 skill 余下内容（cite 规则、retroactive 写法、parent-child API 机制、forbidden in title、cross-repo sub-issue、re-parenting）planning agent 继承全部，本 contract 不重复。

planning agent 读 `~/.claude/skills/writing-issue/SKILL.md` 作 base，**再读本 contract** 作 override；冲突时本 contract 胜。

---

## 8. 何时本 contract 需要更新

任何下列改动落地时必须同步更新本文档（顺带改 `docs/gh-issue-pr-iteration-fragments.md`、`src/preset.test.ts` 的 `EXPECTED_FRAGMENTS`、`preset.toml` 的 `[[fragments]]`）：

- 任意 gate fragment 的 `## Output verdict` / 解析规则变更；
- `runtime.*` 白名单增 / 减 key（影响 `runtime.issueKind` 行为）；
- 新增 / 删除 gate fragment；
- `kind:*` taxonomy 加新 label 值或改语义；
- 四层证据层名 / 数量 / 必填规则变更；
- `Closes` 关键字位置 / `Closes` 动词放宽。

本文档与 fragment 实际解析逻辑漂移 → planning agent 产 issue 后 review gate 拒绝，trace 上看不出原因——这是反复出现的失败模式，根本避免方式是把 contract 当 gate 实现的一部分维护。
