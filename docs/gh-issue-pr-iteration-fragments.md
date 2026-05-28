# `gh-issue-pr-iteration` Fragment 路由

读者：维护 bundled preset 的人——加 / 改 / 删 fragment，调整 review gate 顺序，或想搞清楚某条 trace 走的是哪条链。

读完后你能：照着图找到任意 fragment 的 verdict 出口与下一跳；理解 plan 链 9 个 verdict 的回退路径；理解 `ISSUE_KIND` 怎么在 iter 链早期分流；理解 review 15-step 顺序里每个 gate 的 fail-fast 边界。

不在范围内：preset.toml 字段语义（看 [preset-authoring](./preset-authoring.md)）；写 issue / PR 内容（看 `presets/gh-issue-pr-iteration/contract.md` + 用户级 skill `writing-issue` / `writing-pr` / `review-pr`）。

---

## 1. preset 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested` |
| `statuses.terminal` | `blocked / moot / done / exhausted` |
| phases | `iteration` → `review`，以及 review 后按 `trigger` 条件运行的 side-effect phase（当前：`blocked-responder` on `blocked`）；planning 不在 phases 内，由 `/dev-plan` slash command 入口驱动 |
| `agent.binary` | `claude` |
| fragments | 48 个，分布在 `common/ / plan/ / iter/ / review/` 四个目录 |

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
| `agentCwd` | string / null | agent spawn 的绝对 cwd；跨仓或 post-review responder 可指向外部 checkout |
| `runner` | `claude \| codex` / null | 该 item 的 iteration/trigger runner override |
| `blockerRepo` | string / undefined | `blocked` transition 写入的阻塞仓库，`owner/repo` |
| `blockerRef` | string / undefined | `blocked` transition 写入的阻塞 issue ref 或环境条件 |

status 字面量都是 preset 字符串，引擎只识别 `continuable / terminal` 二元集合。除上述外的转移（包括 `queued → done` 等）也合法，由 agent 通过 prompt 驱动 review/update-state 写入 centralized chain state。

---

## 2. Fragment 全集（48）

按目录列出全部 fragment id：

**common/** — 程序↔agent 边界、GitHub 路由、状态文件不变量、preset 内 issue/PR/review 解析契约（plan / iter / review 入口都读）

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`
- `contract` — preset 的 issue body / PR body / review gate 解析规则，override 用户级 `writing-issue` skill

**plan/** — planning phase 内部，12 个（仅 `/dev-plan` slash command 进入）

- `plan/index` — phase 入口
- `plan/intake`
- `plan/classify`
- `plan/triage-existing` — 既存 issue 的 rewrite_body / pr_reply / close_* / no_op 副作用动作
- `plan/business-frame` — 用 business outcome 三段式（痛点 / 用户做完能多干什么 / 具体场景）阻止 sub-issue body 写成 audit 视角
- `plan/decompose`
- `plan/checkpoint-author`
- `plan/adversarial-validate`
- `plan/create-issues`
- `plan/init-queue`
- `plan/handoff`
- `plan/final`

**iter/** — iteration phase 内部，10 个

- `iter/index` — phase 入口
- `iter/read-context`
- `iter/classify-scope`
- `iter/implement`
- `iter/spike-comment`
- `iter/source-writing-spike`
- `iter/verify-evidence`
- `iter/commit-pr`
- `iter/handoff`
- `iter/final`

**review/** — review phase 内部，22 个

- `review/index` — phase 入口
- `review/read-evidence`
- `review/trace-honesty`
- `review/pr-protocol`
- `review/source-writing-spike-gate`
- `review/title-intent-gate`
- `review/evidence-gate`
- `review/caveat-honesty-gate` — 在 evidence_passed 之后、commitment-gate 之前扫 5 类 caveat（system-under-test bypass / invariant downgrade / cosmetic handwave / cross-issue scope deferral / environment-precondition admission）
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

fragment 总数 = 4 + 12 + 10 + 22 = 48，与 `presets/gh-issue-pr-iteration/preset.toml` 的 `[[fragments]]` 块数一致。

---

## 3. Planning phase 跳转

`/dev-plan` 是 thin-shell slash command（`.claude/commands/dev-plan.md`），把 `$ARGUMENTS` 作为 intake 输入交给 plan 链。planning 不消费 queue item（与 iter / review 的 per-item 不同），因此 plan 不是 `preset.phases` 成员；slash command 直接读 `plan/index.md`。

`plan/index` 强制先读 `<preset>/contract.md` + 用户级 `writing-issue` skill + 目标 `<target>/.coder-loop/workflow.md`，然后进 `plan/intake`。

```
plan/intake
  ├─ intake_clear                    → plan/classify
  ├─ intake_needs_clarification      → plan/handoff
  └─ intake_blocked                  → plan/handoff

plan/classify
  ├─ classified (有既存 issue 要 triage)   → plan/triage-existing
  ├─ classified (无既存 issue)              → plan/decompose
  ├─ classification_blocked                → plan/handoff
  └─ classification_no_work                → plan/handoff

plan/triage-existing
  ├─ triage_complete                       → plan/decompose
  ├─ triage_only                           → plan/init-queue
  ├─ triage_close_via_review               → plan/handoff
  └─ triage_blocked                        → plan/handoff

plan/decompose
  ├─ atomic_set_ready                → plan/checkpoint-author
  ├─ not_atomic_resplit              → plan/classify        (返回 classify 重切)
  └─ decompose_blocked               → plan/handoff

plan/checkpoint-author
  ├─ checkpoints_authored            → plan/adversarial-validate
  ├─ cannot_author_blocked           → plan/handoff
  └─ not_atomic_resplit              → plan/decompose

plan/adversarial-validate
  ├─ validated                       → plan/create-issues
  ├─ sharpen_checkpoints             → plan/checkpoint-author (回上一步)
  ├─ sharpen_resplit                 → plan/decompose
  └─ validation_blocked              → plan/handoff

plan/create-issues
  ├─ issues_created                  → plan/init-queue
  └─ creation_failed                 → plan/handoff          (含已创建 / 未创建分组)

plan/init-queue
  ├─ queue_initialized               → plan/handoff
  └─ queue_init_failed               → plan/handoff
```

不论哪条分支，最终收敛到 `plan/handoff` → `plan/final`：

```
plan/handoff
  ├─ handoff_written                 → plan/final
  └─ handoff_failed                  → plan/final           (失败把 file-write 错误写进 mandatory summary)
```

`plan/final` 无 `## Output verdict`，是 planning 的硬终点，打印 `=== planning final ===` block 供 slash command shell grep。

### Planning 不可做的事

`plan/index` 明确禁止：开 PR、merge PR、关 issue、写 review-side state（这些是 review 的职责）；操作 daemon/chain stop（与 plan 无关）；越过 `contract.md` 自行决定 issue 形态。

---

## 4. Iteration phase 跳转

`iter/index` 强制先读 `common/runtime-contract` → `common/github-routing` → `common/state-contract`，然后进 `iter/read-context`。

```
iter/read-context
  ├─ context_ready
  │    ├─ ISSUE_KIND == "comment"     → iter/spike-comment    (spike / design dialogue)
  │    ├─ ISSUE_KIND == "code-spike"  → iter/source-writing-spike (source-writing no-merge spike)
  │    ├─ ISSUE_KIND == "blocked"     → iter/resolve-blocker  (PR-backed blocker removal)
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

**Blocked 分支**（解除具体 blocker）：

```
iter/resolve-blocker
  ├─ needs_implementation  → iter/implement
  ├─ handoff_only          → iter/handoff
  └─ blocked               → iter/handoff   (含证明 blocker / 缺失 unblock 输入的命令或 query)
```

**Comment 分支**（spike / design dialogue）：

```
iter/spike-comment
  ├─ spike_comment_posted  → iter/handoff   (含 comment URL + 提议 sub-issue 标题)
  └─ spike_blocked         → iter/handoff   (含具体 blocker)
```

**Source-writing spike 分支**（no-merge PoC / evidence）：

```
iter/source-writing-spike
  ├─ source_spike_comment_posted  → iter/handoff   (含 issue comment URL + evidence + branch/SHA)
  └─ source_spike_blocked         → iter/handoff   (含具体 blocker)
```

不论哪条分支，最终都收敛到 `iter/handoff` → `iter/final`：

```
iter/handoff
  ├─ handoff_written  → iter/final
  └─ handoff_failed   → iter/final          (失败也走 final，把失败信息写进 mandatory summary)
```

`iter/final` 没有 `## Output verdict` 段，是 iteration phase 的硬终点。

### Iteration 不可做的事

`iter/index` 明确禁止：创建 child issue / 链接 sub-issue / 合并 PR / 关闭 issue / 操作 daemon/chain stop / 重排 queue / 写入最终 local state——不论 `ISSUE_KIND` 哪条分支。这些是 review 的职责。

---

## 5. Review phase 顺序（15 步）

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
| 4 | `review/source-writing-spike-gate` | source-writing spike evidence/no-merge gate（仅 `kind:code-spike`） |
| 5 | `review/title-intent-gate` | PR title 与 issue title 主语一致性（仅 PR-backed 路径 + 存在 PR） |
| 6 | `review/evidence-gate` | 四层证据 packet 是否齐 |
| 7 | `review/caveat-honesty-gate` | 证据 caveat 是否诚实 |
| 8 | `review/commitment-gate` | 逐行兑现 issue `## 验收标准` 表（`kind:code` / `kind:blocked` + 表存在） |
| 9 | `review/spike-followup-gate` | spike comment 是否选了 `## 结果分支` + 提议足够 sub-issue（仅 `kind:comment`） |
| 10 | `review/code-gate` | merge-ability / CI / 代码质量（无 PR 时自跳过） |
| 11 | `review/issue-closure-gate` | 选 terminal action |
| 12 | terminal action（六选一） | 执行副作用：accept-pr / accept-no-pr / expand-parent / skip / blocked / retry |
| 13 | `review/update-state` | 写 centralized chain state 转移 |
| 14 | `review/global-assessment` | 决定 loop 继续 / 停 |
| 15 | `review/final` | review phase 硬终点 |

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
  ├─ pr_protocol_passed    → review/title-intent-gate
  ├─ source_spike_review   → review/source-writing-spike-gate
  ├─ no_pr_semantic_review → review/issue-closure-gate   (普通无 PR 直接跳到 closure)
  └─ retry                → review/action-retry

review/source-writing-spike-gate
  ├─ source_spike_passed  → review/issue-closure-gate
  ├─ source_spike_skipped → review/title-intent-gate
  └─ source_spike_retry   → review/action-retry

review/title-intent-gate
  ├─ title_aligned        → review/evidence-gate
  ├─ title_drift          → review/action-retry
  └─ title_gate_skipped   → review/evidence-gate         (无 PR / kind:comment / kind:code-spike 自跳过)

review/evidence-gate
  ├─ evidence_passed → review/commitment-gate
  ├─ retry           → review/action-retry
  └─ blocked         → review/action-blocked

review/commitment-gate
  ├─ commitment_passed  → review/spike-followup-gate
  ├─ commitment_skipped → review/spike-followup-gate     (ISSUE_KIND 不是 code/blocked 或无 ## 验收标准 表)
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
  ├─ accepted_pr_closed              → review/update-state (transition: accepted_pr)
  ├─ accept_pr_infrastructure_failed → review/action-stop
  └─ accept_pr_retry_needed          → review/action-retry

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

## 6. `ISSUE_KIND` 在 review 链的分流

`ISSUE_KIND` 由引擎在 spawn 前 `gh issue view --json labels` fetch，注入 prompt 模板。无 repo 的本地 fixture 可用 queue item 的 `kind` 字段模拟。四个 review gate 用它自跳过：

| Gate | `kind:code` | `kind:blocked` | `kind:comment` | `kind:code-spike` | empty / legacy |
|---|---|---|---|---|---|
| `source-writing-spike-gate` | `source_spike_skipped` | `source_spike_skipped` | `source_spike_skipped` | 跑（要求 no-merge evidence/comment/branch） | `source_spike_skipped` |
| `title-intent-gate` | 跑（要求 PR title 与 issue title 主语一致） | 跑（同 PR-backed 路径） | `title_gate_skipped`（无 PR） | 跳过（source spike 无 PR） | 跑（legacy 也可能漂） |
| `evidence-gate` | 四层证据 | 四层证据 + blocked path e2e/integration 复测 | 无 PR 时自通过 | 由 `source-writing-spike-gate` 审证据 | 四层证据 |
| `commitment-gate` | 跑（逐行兑现 `## 验收标准` 表） | 跑（逐行兑现 `## 验收标准` 表） | `commitment_skipped` | 由 `source-writing-spike-gate` 审命令证据 | 视有无 `## 验收标准` 表决定 |
| `spike-followup-gate` | `spike_gate_skipped` | `spike_gate_skipped` | 跑（要求 spike comment 选 `## 结果分支` + 足够 sub-issue 提议） | 由 `source-writing-spike-gate` 审结果分支 | `spike_gate_skipped` |

`code-gate` 在无 PR 时自跳过（`no_pr_semantic_review` 路径直接绕过它进 `issue-closure-gate`）。

设计权衡：PR-backed 与 comment-only gate 仍自跳过；`kind:blocked` 是 PR-backed 但 evidence-gate 多一层 blocked path 复测；`kind:code-spike` 是显式分叉，因为它允许 source writes 但禁止 PR merge，必须在 no-PR closure 前单独审证据。

---

## 7. 实战：从 trace 反推走了哪条链

phase 输出文件路径由 `coder-loop status <target> --json` 的 `current.phaseStatus.value.outputPath` 暴露；新版 layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`。每个 fragment 会输出自己的 verdict 字面量（如 `verification_passed`），按 §3 / §4 / §5 的图就能反推路径。

常见路径示例：

- **Planning 顺利**：`plan/intake (intake_clear) → plan/classify (classified) → plan/decompose (atomic_set_ready) → plan/checkpoint-author (checkpoints_authored) → plan/adversarial-validate (validated) → plan/create-issues (issues_created) → plan/init-queue (queue_initialized) → plan/handoff (handoff_written) → plan/final`。`plan/init-queue` 通过 centralized chain/item API 初始化队列：优先 `coder-loop item batch-add` / daemon `item.batchAdd` 原子写入，必要时才用兼容的单条 `coder-loop item add` fallback；handoff 与 evidence 路径位于 `loop-data/chains/<chain>/issues`、`evidence`。
- **Planning intake 不清**：`plan/intake (intake_needs_clarification) → plan/handoff (handoff_written) → plan/final (verdict: intake_needs_clarification)`；operator 看 handoff 文件回答问题后重跑 `/dev-plan`.
- **顺利 PR-merge**：`iter/read-context (context_ready) → classify-scope (needs_implementation) → implement (ready_for_verification) → verify-evidence (passed) → commit-pr (pr_ready) → handoff (written) → final`；review：`read-evidence → trace-honesty → pr-protocol → title-intent-gate (aligned) → evidence-gate (passed) → commitment-gate (passed) → spike-followup-gate (skipped) → code-gate (passed) → issue-closure-gate (accepted_pr) → action-accept-pr (closed) → update-state → global-assessment → final`.
- **Spike 成功**：`read-context (ready, kind=comment) → spike-comment (posted) → handoff → final`；review：`... → title-intent-gate (skipped) → evidence-gate (passed) → commitment-gate (skipped) → spike-followup-gate (passed) → code-gate (passed, no PR) → issue-closure-gate (accepted_no_pr) → action-accept-no-pr → ...`.
- **commitment-gate 失败 retry**：`... → commitment-gate (failed) → action-retry → update-state (retry) → global-assessment → final`；iter 下轮重启从 implement 开始。

---

## 8. 改 fragment 链的检查清单

加 / 删 / 改 fragment 时：

1. 改源 markdown（`presets/gh-issue-pr-iteration/<role>/<name>.md`），保持 `## Output verdict` 段格式（verdict → next fragment 一一映射）。
2. 改 `preset.toml` 的 `[[fragments]]` 块（增 / 减条目）。
3. 改 `iter/index.md` 或 `review/index.md` 的 phase 顺序段。
4. 改 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 数组。
5. 改本文档（§2 全集列表 / §3-5 跳转图 / §5 phase 顺序表）。
6. 跑 `bun test`（preset.test.ts 会验证 fragment 集合一致性）+ `bun x tsc --noEmit`.

漏改任一处 → preset load throws 或 test 红或文档说谎。
