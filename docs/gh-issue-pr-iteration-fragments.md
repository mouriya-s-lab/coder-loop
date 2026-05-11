# `gh-issue-pr-iteration` Fragment 路由

读者：维护 bundled preset 的人——加 / 改 / 删 fragment，调整 review gate 顺序，或想搞清楚某条 trace 走的是哪条链。

读完后你能：照着图找到任意 fragment 的 verdict 出口与下一跳；理解 `ISSUE_KIND` 怎么在 iter 链早期分流；理解 review 13-step 顺序里每个 gate 的 fail-fast 边界。

不在范围内：preset.toml 字段语义（看 [preset-authoring](./preset-authoring.md)）；写 issue / PR 内容（看用户级 skill `writing-issue` / `writing-pr` / `review-pr`）。

---

## 1. preset 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested` |
| `statuses.terminal` | `blocked / moot / done` |
| phases | `iteration` → `review`（两段固定顺序） |
| `agent.binary` | `claude` |
| fragments | 32 个，分布在 `common/ / iter/ / review/` 三个目录 |

`item` 字段（除 `issue / status` 外）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `attempts` | number / null | iteration 累计次数；review 判循环失败的硬上限 |
| `title` | string / null | 人类可读标题 |
| `priority` | `high \| medium \| low` / null | review 决定下一选哪个 |
| `branch` | string / null | iteration 创建的 PR 分支名 |
| `pr` | number / null | iteration 开的 PR 号 |
| `lastRunId` | string / null | 上一次 iteration 的 runId |
| `issueFile` | string / null | issue handoff 文件相对路径 |
| `evidenceDir` | string / null | 该 issue 的证据目录相对路径 |

status 字面量都是 preset 字符串，引擎只识别 `continuable / terminal` 二元集合。除上述外的转移（包括 `queued → done` 等）也合法，由 agent 通过 prompt 写入 state.json。

---

## 2. Fragment 全集（32）

按目录列出全部 fragment id：

**common/** — 程序↔agent 边界、GitHub 路由、状态文件不变量（iter / review 入口都读）

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`

**iter/** — iteration phase 内部，9 个

- `iter/index` — phase 入口
- `iter/read-context`
- `iter/classify-scope`
- `iter/implement`
- `iter/spike-comment`
- `iter/verify-evidence`
- `iter/commit-pr`
- `iter/handoff`
- `iter/final`

**review/** — review phase 内部，20 个

- `review/index` — phase 入口
- `review/read-evidence`
- `review/trace-honesty`
- `review/pr-protocol`
- `review/title-intent-gate`
- `review/evidence-gate`
- `review/commitment-gate`
- `review/spike-followup-gate`
- `review/code-gate`
- `review/issue-closure-gate`
- `review/action-retry`
- `review/action-expand-parent`
- `review/action-accept-pr`
- `review/action-accept-no-pr`
- `review/action-skip`
- `review/action-blocked`
- `review/action-stop`
- `review/update-state`
- `review/global-assessment`
- `review/final`

fragment 总数 = 3 + 9 + 20 = 32，与 `presets/gh-issue-pr-iteration/preset.toml` 的 `[[fragments]]` 块数一致。

---

## 3. Iteration phase 跳转

`iter/index` 强制先读 `common/runtime-contract` → `common/github-routing` → `common/state-contract`，然后进 `iter/read-context`。

```
iter/read-context
  ├─ context_ready
  │    ├─ ISSUE_KIND == "comment"     → iter/spike-comment    (spike / design dialogue)
  │    └─ ISSUE_KIND == "code" or ""  → iter/classify-scope   (legacy 无 label 走 code 路径)
  └─ infrastructure_failure           → iter/handoff
```

**Code 分支**（绝大多数 issue）：

```
iter/classify-scope
  ├─ needs_implementation  → iter/implement
  ├─ handoff_only          → iter/handoff
  └─ blocked               → iter/handoff   (含证明 blocker 的命令 / query)

iter/implement
  ├─ implementation_ready_for_verification  → iter/verify-evidence
  └─ implementation_blocked                 → iter/handoff

iter/verify-evidence
  ├─ verification_passed         → iter/commit-pr
  ├─ verification_failed_fixable → iter/implement     (回到上一步)
  └─ verification_blocked        → iter/handoff

iter/commit-pr
  ├─ pr_ready              → iter/handoff
  ├─ no_code_change        → iter/handoff
  └─ commit_or_pr_blocked  → iter/handoff
```

**Comment 分支**（spike / design dialogue）：

```
iter/spike-comment
  ├─ spike_comment_posted  → iter/handoff   (含 comment URL + 提议 sub-issue 标题)
  └─ spike_blocked         → iter/handoff   (含具体 blocker)
```

不论哪条分支，最终都收敛到 `iter/handoff` → `iter/final`：

```
iter/handoff
  ├─ handoff_written  → iter/final
  └─ handoff_failed   → iter/final          (失败也走 final，把失败信息写进 mandatory summary)
```

`iter/final` 没有 `## Output verdict` 段，是 iteration phase 的硬终点。

### Iteration 不可做的事

`iter/index` 明确禁止：创建 child issue / 链接 sub-issue / 合并 PR / 关闭 issue / 删 `.dev-loop` / 重排 queue / 写入最终 local state——不论 `ISSUE_KIND` 哪条分支。这些是 review 的职责。

---

## 4. Review phase 顺序（13 步）

`review/index` 强制：

```
common/runtime-contract → common/github-routing → common/state-contract → review/read-evidence
```

之后按 `review/index` 的 `## Phase order` 顺序：

| # | Fragment | 角色 |
|---|---|---|
| 1 | `review/read-evidence` | 载入 trace 与 GitHub live state |
| 2 | `review/trace-honesty` | trace 与 GitHub 实况是否一致 |
| 3 | `review/pr-protocol` | PR 身份 / closing keyword / 评论位置 |
| 4 | `review/title-intent-gate` | PR title 与 issue title 主语一致性（仅 `kind:code` + 存在 PR） |
| 5 | `review/evidence-gate` | 四层证据 packet 是否齐 |
| 6 | `review/commitment-gate` | 逐行兑现 issue `## 验收标准` 表（仅 `kind:code` + 表存在） |
| 7 | `review/spike-followup-gate` | spike comment 是否选了 `## 结果分支` + 提议足够 sub-issue（仅 `kind:comment`） |
| 8 | `review/code-gate` | merge-ability / CI / 代码质量（无 PR 时自跳过） |
| 9 | `review/issue-closure-gate` | 选 terminal action |
| 10 | terminal action（六选一） | 执行副作用：accept-pr / accept-no-pr / expand-parent / skip / blocked / retry |
| 11 | `review/update-state` | 写 state.json 转移 |
| 12 | `review/global-assessment` | 决定 loop 继续 / 停 |
| 13 | `review/final` | review phase 硬终点 |

每个 gate 不通过 → 跳 `review/action-retry` / `review/action-blocked` / `review/action-stop` 之一，绕过下游 gate 直达 update-state。

### Gate 跳转细节

```
review/read-evidence
  ├─ evidence_loaded                  → review/trace-honesty
  ├─ no_selected_issue                → review/global-assessment
  └─ review_infrastructure_broken     → review/action-stop (无该 fragment 则 global-assessment)

review/trace-honesty
  ├─ trace_valid  → review/pr-protocol
  └─ retry        → review/action-retry

review/pr-protocol
  ├─ pr_protocol_passed   → review/title-intent-gate
  ├─ no_pr_semantic_review → review/issue-closure-gate   (无 PR 直接跳到 closure，跳过 4-8)
  └─ retry                → review/action-retry

review/title-intent-gate
  ├─ title_aligned        → review/evidence-gate
  ├─ title_drift          → review/action-retry
  └─ title_gate_skipped   → review/evidence-gate         (无 PR 或 kind:comment 自跳过)

review/evidence-gate
  ├─ evidence_passed → review/commitment-gate
  ├─ retry           → review/action-retry
  └─ blocked         → review/action-blocked

review/commitment-gate
  ├─ commitment_passed  → review/spike-followup-gate
  ├─ commitment_skipped → review/spike-followup-gate     (ISSUE_KIND ≠ code 或无 ## 验收标准 表)
  └─ commitment_failed  → review/action-retry            (引用每个失败行)

review/spike-followup-gate
  ├─ spike_followup_passed  → review/code-gate
  ├─ spike_gate_skipped     → review/code-gate           (ISSUE_KIND ≠ comment)
  └─ spike_followup_failed  → review/action-retry

review/code-gate
  ├─ code_gate_passed → review/issue-closure-gate
  └─ retry            → review/action-retry

review/issue-closure-gate
  ├─ accepted_pr      → review/action-accept-pr
  ├─ accepted_no_pr   → review/action-accept-no-pr
  ├─ expand_parent    → review/action-expand-parent
  ├─ skip             → review/action-skip
  ├─ blocked          → review/action-blocked
  └─ retry            → review/action-retry
```

### Terminal action fragments

每个 action fragment 执行 GitHub 副作用（merge / close / 提 child / post comment），输出二选一：

```
review/action-accept-pr
  ├─ accepted_pr_closed   → review/update-state (transition: accepted_pr)
  └─ accept_pr_failed     → review/action-retry

review/action-accept-no-pr
  ├─ accepted_no_pr_closed → review/update-state (transition: accepted_no_pr)
  └─ accept_no_pr_failed   → review/action-retry

review/action-expand-parent
  ├─ parent_expanded         → review/update-state (transition: expanded incomplete parent)
  └─ parent_expansion_failed → review/action-retry

review/action-skip
  ├─ skip_closed     → review/update-state (transition: skip)
  └─ skip_close_failed → review/action-retry

review/action-blocked
  ├─ blocked_feedback_posted → review/update-state (transition: blocked)
  └─ blocked_feedback_failed → review/action-stop      (无法发表 = 不能假设 blocker 持久)

review/action-retry
  ├─ retry_feedback_posted → review/update-state (transition: retry)
  └─ retry_feedback_failed → review/action-stop

review/action-stop
  ├─ loop_stopped     → review/final (verdict: stop)
  └─ stop_not_allowed → review/action-retry
```

`review/update-state` 出口：

```
review/update-state
  ├─ state_updated         → review/global-assessment
  └─ state_update_failed   → review/global-assessment    (并把 review 基础设施标为 broken)
```

`review/global-assessment` 三个 verdict 全部 → `review/final`（区别只在 final 输出的 verdict 字面量）。`review/final` 无 verdict 段，phase 硬终点。

---

## 5. `ISSUE_KIND` 在 review 链的分流

`ISSUE_KIND` 由引擎在 spawn 前 `gh issue view --json labels` fetch，注入 prompt 模板。三个 review gate 用它自跳过：

| Gate | `kind:code` | `kind:comment` | empty / legacy |
|---|---|---|---|
| `title-intent-gate` | 跑（要求 PR title 与 issue title 主语一致） | `title_gate_skipped`（无 PR） | 跑（legacy 也可能漂） |
| `commitment-gate` | 跑（逐行兑现 `## 验收标准` 表） | `commitment_skipped` | 视有无 `## 验收标准` 表决定 |
| `spike-followup-gate` | `spike_gate_skipped` | 跑（要求 spike comment 选 `## 结果分支` + 足够 sub-issue 提议） | `spike_gate_skipped` |

`code-gate` 在无 PR 时自跳过（`no_pr_semantic_review` 路径直接绕过它进 `issue-closure-gate`）。

设计权衡：每个 gate 自跳过而非按 kind 做 phase 分叉，这样 review phase 顺序保持 13 步固定，trace 易读、`review/index` 不需要按 kind 维护多份。

---

## 6. 实战：从 trace 反推走了哪条链

trace 文件在 `<target>/.coder-loop/runtime/logs/<runId>.<phase>.txt`。每个 fragment 会输出自己的 verdict 字面量（如 `verification_passed`），按 §3 / §4 的图就能反推路径。

常见路径示例：

- **顺利 PR-merge**：`read-context (context_ready) → classify-scope (needs_implementation) → implement (ready_for_verification) → verify-evidence (passed) → commit-pr (pr_ready) → handoff (written) → final`；review：`read-evidence → trace-honesty → pr-protocol → title-intent-gate (aligned) → evidence-gate (passed) → commitment-gate (passed) → spike-followup-gate (skipped) → code-gate (passed) → issue-closure-gate (accepted_pr) → action-accept-pr (closed) → update-state → global-assessment → final`.
- **Spike 成功**：`read-context (ready, kind=comment) → spike-comment (posted) → handoff → final`；review：`... → title-intent-gate (skipped) → evidence-gate (passed) → commitment-gate (skipped) → spike-followup-gate (passed) → code-gate (passed, no PR) → issue-closure-gate (accepted_no_pr) → action-accept-no-pr → ...`.
- **commitment-gate 失败 retry**：`... → commitment-gate (failed) → action-retry → update-state (retry) → global-assessment → final`；iter 下轮重启从 implement 开始。

---

## 7. 改 fragment 链的检查清单

加 / 删 / 改 fragment 时：

1. 改源 markdown（`presets/gh-issue-pr-iteration/<role>/<name>.md`），保持 `## Output verdict` 段格式（verdict → next fragment 一一映射）。
2. 改 `preset.toml` 的 `[[fragments]]` 块（增 / 减条目）。
3. 改 `iter/index.md` 或 `review/index.md` 的 phase 顺序段。
4. 改 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 数组。
5. 改本文档（§2 全集列表 / §3-4 跳转图 / §4 phase 顺序表）。
6. 跑 `bun test`（preset.test.ts 会验证 fragment 集合一致性）+ `bun x tsc --noEmit`.

漏改任一处 → preset load throws 或 test 红或文档说谎。
