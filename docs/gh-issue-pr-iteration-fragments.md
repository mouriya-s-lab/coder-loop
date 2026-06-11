# `gh-issue-pr-iteration` Fragment 布局（调度者架构）

读者：维护 bundled preset 的人——加 / 改 / 删 fragment，调整调度者手册或步骤合同，或想搞清楚某条 trace 走的是哪条路径。

读完后你能：理解 iter / review 两个 entry 的调度者循环；找到任意步骤三件套（task / report / accept）与品质判据文件；理解 plan 链 9 个 verdict 的回退路径（plan 链仍是查表式 fragment 链）；按 §8 清单安全地改动布局。

不在范围内：preset.toml 字段语义（看 [preset-authoring](./preset-authoring.md)）；写 issue / PR 内容（看 `presets/gh-issue-pr-iteration/contract.md`，用户级 skill 只可作为可选 operator 参考）。

---

## 1. preset 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested` |
| `statuses.terminal` | `blocked / moot / done / exhausted` |
| `statuses.unblockable` | `blocked`（`queue unblock` 恢复到 `statuses.entry = queued`） |
| phases | `iteration` → `review`，以及 review 后按 `trigger` 条件运行的 side-effect phase（当前：`blocked-responder` on `blocked`）；planning 不在 phases 内，由 `/dev-plan` slash command 入口驱动 |
| `agent.binary` | `claude` |
| fragments | 56 个，分布在 `common/ / plan/ / quality/ / iter/steps/ / review/` 五块 |

`item` 字段（除 `issue / status` 外）。`branch` / `pr` / `lastRunId` 由 bundled preset 的 `[item.fields]` 声明，是透明 item 字段；SQLite 仍保留旧列以兼容现有 chain，新增 CLI 写入走 `--field-json`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `attempts` | number / null | iteration 累计次数；review 判循环失败的硬上限 |
| `title` | string / null | 人类可读标题 |
| `priority` | `high \| medium \| low` / null | review 决定下一选哪个 |
| `branch` | string / null | iteration 创建的 PR 分支名 |
| `pr` | number / null | iteration 开的 PR 号 |
| `lastRunId` | string / null | 上一次 iteration 的 runId |
| `issueFile` | string / null | 可选 per-issue handoff attachment 相对路径；主 handoff 是 chain-level `shared.md` |
| `evidenceDir` | string / null | 该 issue 的证据目录相对路径 |
| `agentCwd` | string / null | agent spawn 的绝对 cwd；跨仓或 post-review responder 可指向外部 checkout |
| `runner` | `claude \| codex` / null | 该 item 对允许 item override 的普通执行 phase 的 runner override |
| `blockerRepo` | string / undefined | `blocked` transition 写入的阻塞仓库，`owner/repo` |
| `blockerRef` | string / undefined | `blocked` transition 写入的阻塞 issue ref 或环境条件 |

status 字面量都是 preset 字符串，引擎只识别 `continuable / terminal` 二元集合。除常见转移外的转移（包括 `queued → done` 等）也合法，由 review 调度者通过 `coder-loop item update` 写入 centralized chain state（见 `review/actions/state-write.md`）。

---

## 2. 调度者架构总览

iteration / review 两个复杂角色不再是「查表自执行的 fragment 链」，而是**调度者**：entry md 即调度者手册，它调查 → 计划 → 派 subagent 执行 → 按硬性条件验收 → 补缺 → 清场。设计动机：执行的复杂度会耗尽单一上下文的注意力，后段的验证 / 证据 / 收尾塌方；调度者模式把执行切片给上下文全新的 subagent，调度者的注意力只花在计划与验收（LLM 判断）上。

核心约定：

- **每步三件套**：`task.md`（subagent 的任务 prompt，**调度者永不读**——防 context 污染）、`report.md`（subagent 的汇报模板：为什么这么做 / 实际做了什么 / 有什么问题）、`accept.md`（调度者的验收判据，task.md 不引用它——防执行者向判据表演）。
- **硬性条件两源**：issue 的任务要求（live issue body）+ preset 的品质判据（`quality/*.md`）。验收是 LLM 判断，不是程序检查。
- **dispatch 消息只含指针 + 运行时键值**，不转述任何规则文本；prompt 内跨文件引用全部写 `/Users/mouriya/Ext/app/coder-loop/...` 绝对路径（agent 跑在随机 worktree，运行时锚定 app 目录；fragment 不经引擎渲染，占位符无人替换）。
- **补缺走同一 subagent**（claude: Task follow-up；codex: `send_input`），方向错了才重派。
- **无内部超时**：时间归引擎 watchdog。
- **bug / 代码质量审查退出 loop**：style / conventions / 架构审美 / contract 之外的 bug-hunting 后退给人工 review；loop 只守诚实、协议、契约兑现（复验）、mergeability/CI 实测、closure 语义。

plan 链不变（仍为查表式 fragment 链）；trigger 角色（blocked-responder / umbrella-finalizer）任务简单，未调度者化。

---

## 3. Fragment 全集（56）

**common/**（4，含 contract）— 程序↔agent 边界、GitHub 路由、状态不变量、issue/PR 解析契约：

- `common/runtime-contract`（其 Fragment protocol 节只适用 plan 链）
- `common/github-routing`
- `common/state-contract`
- `contract` — issue body / PR body / review 验收点解析规则

**plan/**（12，仅 `/dev-plan` 进入）：`plan/index`、`plan/intake`、`plan/classify`、`plan/triage-existing`、`plan/business-frame`、`plan/decompose`、`plan/checkpoint-author`、`plan/adversarial-validate`、`plan/create-issues`、`plan/init-queue`、`plan/handoff`、`plan/final`

**quality/**（3）— iter 与 review 共用的品质判据，§A 事前约束（task.md 引用）+ §B 验收判断（accept.md / 调度者引用）：

- `quality/evidence` — 证据真实性（真实路径、log 文本化、synthetic 拒收、CI parity、弱信号不算验收）
- `quality/honesty` — 声明=观察、六类 scope-reduction 触发（cosmetic-handwave 一律硬拒）、intent-action 对照
- `quality/cleanup` — 副作用申报与调度者收尾清扫

**iter/steps/**（7 组 × 3 = 21）— iteration 调度者的步骤合同：

| 步骤 | 用途 |
|---|---|
| `research` | 可选调查步（实现方向不明时派） |
| `resolve-blocker` | `kind:blocked` 前置 scoping（阻塞条件 / 最小成功条件 / replay 计划） |
| `implement` | 写代码（分支续接、读契约、思考框架、intent statement；不 commit） |
| `verify` | 跑验收行 + CI parity + workflow 命令，产证据进 evidence 目录 |
| `submit` | intent-vs-action delta、commit、push、PR（fresh）或 PR comment（retry） |
| `source-spike` | `kind:code-spike` 整步（PoC 分支 + 命令 + no-merge comment） |
| `spike-comment` | `kind:comment` 整步（评论 + 结果分支 + 提议 sub-issues） |

**review/**（16）：

- `review/steps/investigate/{task,report,accept}` — 重材料读取回 verbatim 摘要
- `review/steps/replay/{task,report,accept}` — 独立复验：验收表逐行真跑 / artifact 核验、packet 关键 claim 重跑、checks 实测
- `review/spike-followup`、`review/source-spike-audit` — kind 特定判断指南（调度者亲读）
- `review/actions/{accept-pr,accept-no-pr,retry,expand-parent,skip,blocked,stop}` — 终局动作（调度者按 verdict 只读其一并亲自执行副作用）
- `review/actions/state-write` — `coder-loop item update` 状态写出与 expand 队列规则

fragment 总数 = 4 + 12 + 3 + 21 + 16 = 56，与 `preset.toml` 的 `[[fragments]]` 块数和 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 一致。

---

## 4. Planning phase 跳转（不变，查表式）

`/dev-plan` 是 thin-shell slash command（`.claude/commands/dev-plan.md`），把 `$ARGUMENTS` 作为 intake 输入交给 plan 链。planning 不消费 queue item，plan 不是 `preset.phases` 成员；slash command 直接读 `plan/index.md`。

`plan/index` 强制先读 `<preset>/contract.md` + 目标 `<target>/.coder-loop/workflow.md`，然后进 `plan/intake`。用户级写作 skill 若存在可参考；缺失不阻塞。

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

不论哪条分支，最终收敛到 `plan/handoff` → `plan/final`；`plan/final` 打印 `=== planning final ===` block 供 slash command shell grep。`plan/index` 明确禁止：开 PR、merge PR、关 issue、写 review-side state、操作 daemon/chain stop、越过 `contract.md` 自行决定 issue 形态。

---

## 5. Iteration 调度者（`iter-entry.md`）

四个阶段：**Investigate**（亲自轻读 issue/PR/handoff/state；重调查派 research）→ **Plan**（按 `ISSUE_KIND` 定步骤计划，绑每步验收来源；判断 issue 是否真的可实现，否则记录分类直接 wrap-up 交 review）→ **Dispatch & judge**（逐步派发、按 accept.md + issue 要求验收、缺口 send_input 补派）→ **Wrap up**（handoff、按派发账清场、`ITERATION SUMMARY:` 一行）。

kind → 步骤计划：

| `ISSUE_KIND` | 计划 |
|---|---|
| `code` / 空（legacy） | [research?] → implement → verify → submit |
| `blocked` | resolve-blocker → implement → verify → submit |
| `code-spike` | [research?] → source-spike |
| `comment` | [research?] → spike-comment |

verify 发现产品性失败 → 缺口路由回 implement 补派，再**整表**重跑 verify（不是只重跑失败行）——「完整的迭代」在 iter 内闭环，不把半成品推给 review 轮转。iteration 不写 item status；scheduler 从 run ledger 推进到 review。

边界不变：不选别的 issue、不批处理、不建 child issue、不 merge、不关 issue、不动队列与最终状态、不 stage runtime artifacts。

---

## 6. Review 调度者（`review-entry.md`）

五个阶段：

1. **Investigate** — 亲自轻读 + 判断关键材料（Intent/Result blocks、PR caveats、最新 retry comment）**verbatim 亲读**；大材料派 investigate 回 verbatim 摘要。
2. **Honesty & protocol judgments**（亲自，依序）— trace honesty → PR protocol → title-intent → caveat honesty（`quality/honesty.md` §B 六类触发）→ evidence form（`quality/evidence.md` §B）。kind 特定判断按需读 `review/spike-followup.md` / `review/source-spike-audit.md`。
3. **Replay**（派发）— 验收表逐行真跑 / artifact 核验、packet 关键 claim 重跑、checks/mergeability 实测。replay 结论是契约真值：任一行不匹配 → retry（一次引用全部失败行）；行 Command 本身坏 → 先修 issue 合同；`kind:blocked` 必须含 blocked-path e2e 成功。**review 可独立复验但绝不替 iter 修**。
4. **Closure judgment**（亲自）— atomic / parent / child closure table / completeness 分类。
5. **Terminal action + state write + wrap-up** — 按 verdict 只读一个 `review/actions/*.md` 亲自执行副作用，按 `state-write.md` 写状态（外部副作用先于本地终态）；global assessment 决定 scheduling state 去留；handoff、清场、`REVIEW SUMMARY:` 一行。

kind 分流矩阵见 `review-entry.md` 的 Kind routing matrix（contract.md §4 有 issue 作者视角摘要）。

---

## 7. 实战：从 trace 反推走了什么

phase 输出文件路径由 `coder-loop status <target> --json` 的 `current.phaseStatus.value.outputPath` 暴露；layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`。调度者模式下不再有逐 fragment 的 verdict 字面量链；反推依据：

- **调度者的派发账**（dispatch ledger）与各步 subagent 汇报会出现在 stdout 流里——按步骤名（research / implement / verify / submit / replay …）定位。
- **handoff 注记**：iter 在 `loop-data/chains/<chain>/shared.md` 留 per-run 计划与各步 outcome；review 留 verdict + 失败判断点 + replay 摘要。
- **终行**：`ITERATION SUMMARY:` / `REVIEW SUMMARY: verdict=…` 是两个 phase 的硬终点标记。
- plan 链仍按 §4 的 verdict 图反推。

---

## 8. 改布局的检查清单

加 / 删 / 改 entry、步骤三件套、品质判据时：

1. 改源 markdown。步骤合同保持三件套齐全；task.md 不得引用同步骤 accept.md；跨文件引用写 `/Users/mouriya/Ext/app/coder-loop/...` 绝对路径。
2. 改 `preset.toml` 的 `[[fragments]]` 块（增 / 减条目）。
3. 改 `iter-entry.md` / `review-entry.md` 的步骤目录表或验收点顺序。
4. 改 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 数组与 entry 断言。
5. 改 `presets/gh-issue-pr-iteration/contract.md`（§3 验收点总表 / §4 kind 路由）与本文档（§3 全集 / §5-6）。
6. 跑 `bun test`（preset.test.ts 验证 fragment 集合一致性）+ `bun x tsc --noEmit`。

漏改任一处 → preset load throws 或 test 红或文档说谎。
