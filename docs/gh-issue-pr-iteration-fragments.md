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
| fragments | 62 个，分布在 `common/ / plan/ / quality/ / iter/steps/ / review/` 五块 |

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

iteration / review 两个复杂角色不再是「查表自执行的 fragment 链」，而是**调度者**，entry md 是按序执行的 **workflow**（不是散文手册）：每个 Step 在使用现场写明做什么、谁做（亲自的命令是闭集清单，清单外即派发）、派哪个 subagent、传什么输入、回报查什么、各 verdict 去哪。调度者的本职是**维护任务清单**：计划落成显式 checklist，每条只有 `[x] accepted`（由被验收的 subagent 汇报勾掉，不能自己做掉）或 `[-] skipped: <reason>` 两种出口，全勾完才允许退出；每次 verdict 后重印整张清单。

核心约定：

- **每步三件套**：`task.md`（subagent 的任务 prompt，含 Inputs 节声明消费哪些 dispatch 字段）、`report.md`（必填字段结构化汇报模板，空集写 `none`）、`accept.md`（调度者的验收判据，内嵌 Required report fields——调度者凭它判断结构完整性，**永不打开 task.md / report.md**；task.md 也不引用 accept.md，防执行者向判据表演）。
- **quality 文件按受众物理拆分**：`-execute.md` 只给执行 subagent（事前约束），`-judge.md` 只给调度者（验收判断）。单文件双受众是已证实的双向泄漏源（执行者读到判据照着表演 / 调度者吞下执行细节）。
- **硬性条件两源**：issue 的任务要求（live issue body）+ preset 的品质判据（`quality/*-judge.md`）。验收是 LLM 判断，不是程序检查；先查结构（必填字段）再判实质。
- **dispatch 消息只含指针 + 运行时键值**，不转述任何规则文本；prompt 内跨文件引用全部写 `/Users/mouriya/Ext/app/coder-loop/...` 绝对路径（agent 跑在随机 worktree，运行时锚定 app 目录；fragment 不经引擎渲染，占位符无人替换）。
- **补缺走同一 subagent**（claude: Task follow-up；codex: `send_input`），方向错了才重派。
- **无内部超时**：时间归引擎 watchdog。
- **e2e 直跑是唯一正规产物**：unit/integration 必须有但只是辅助层；e2e 必须直接运行真实物（程序 → 操作者方式调真实入口；web → agent-browser 走真 UI），**禁止脚本 e2e**；auth/binary 永远是执行者自己解决（standalone → 起环境时自铸 auth；服务插件 → IaC 基建必有可解析 auth），不存在缺失项。
- **运行环境是交付物、清理归 review**：iter 跑完 e2e 把环境留着、交 runtime manifest（binaries/services/auth 解析位置/端口/在跑 PID/停法；secret 值不入任何报告），review 凭它必然复跑得动——manifest 缺项是 packet 失败计入 retry；全部 teardown 由 review 调度者收尾执行。
- **代码审查在 loop 内、锚定 issue 设计、不发散**：diff-audit 步审 changed code 的逻辑正确性 / 设计偏离 / conventions / diff 内结构，每条发现必须带锚（可追溯失败路径 / issue 原句 / convention 来源）；替代设计、issue 设计外的改进、diff 没碰的代码不进 verdict。loop 内同样不可让渡：scope 对应、测试完整性、runtime artifacts 卫生（diff-audit 步）、契约逐行兑现与 CI/mergeability 实测（replay 步）、诚实、协议、closure 语义。

plan 链不变（仍为查表式 fragment 链）；trigger 角色（blocked-responder / umbrella-finalizer）任务简单，未调度者化。

---

## 3. Fragment 全集（62）

**common/**（4，含 contract）— 程序↔agent 边界、GitHub 路由、状态不变量、issue/PR 解析契约：

- `common/runtime-contract`（其 Fragment protocol 节只适用 plan 链）
- `common/github-routing`
- `common/state-contract`
- `contract` — issue body / PR body / review 验收点解析规则

**plan/**（12，仅 `/dev-plan` 进入）：`plan/index`、`plan/intake`、`plan/classify`、`plan/triage-existing`、`plan/business-frame`、`plan/decompose`、`plan/checkpoint-author`、`plan/adversarial-validate`、`plan/create-issues`、`plan/init-queue`、`plan/handoff`、`plan/final`

**quality/**（6）— iter 与 review 共用的品质判据，按受众拆成两个文件（执行者与调度者互不读对方那份）：

- `quality/evidence-execute` / `quality/evidence-judge` — 证据真实性：真实路径、log 文本化、synthetic 拒收、CI parity、测试清单 delta（execute 侧产出 / judge 侧要求在场）、弱信号不算验收
- `quality/honesty-execute` / `quality/honesty-judge` — 声明=观察、七类 scope-reduction 触发（cosmetic-handwave 一律硬拒；新增 test-weakening）、intent-action 对照、字面授权规则 + stale-baseline 例外（base 前进造成的字面值过期不算缩水，复验测得新基线即接受）
- `quality/cleanup-execute` / `quality/cleanup-judge` — 副作用申报（execute）与调度者收尾清扫（judge）

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

**review/**（19）：

- `review/steps/investigate/{task,report,accept}` — 重材料读取回 verbatim 摘要
- `review/steps/diff-audit/{task,report,accept}` — **强制派发**（PR-backed kind）：PR diff vs base 的 scope 映射（每个 changed file 归 in-scope/support/unmapped）、runtime artifacts 卫生扫描、测试完整性（base/head 测试清单两侧计数 + 删/改名/skip/弱化逐条枚举；计数下降无枚举 = 隐藏弱化硬拒）、锚定 issue 设计的代码审查（逻辑错误带失败路径 / 设计偏离引 issue 原句 / convention 违反引来源 / diff 内结构缺陷；不发散）
- `review/steps/replay/{task,report,accept}` — **强制派发**（PR-backed kind）：验收表逐行真跑 / artifact 核验、packet 关键 claim 重跑、checks 实测
- `review/spike-followup`、`review/source-spike-audit` — kind 特定判断指南（调度者亲读）
- `review/actions/{accept-pr,accept-no-pr,retry,expand-parent,skip,blocked,stop}` — 终局动作（调度者按 verdict 只读其一并亲自执行副作用）
- `review/actions/state-write` — `coder-loop item update` 状态写出与 expand 队列规则

fragment 总数 = 4 + 12 + 6 + 21 + 19 = 62，与 `preset.toml` 的 `[[fragments]]` 块数和 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 一致。

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

## 5. Iteration 调度者（`iter-entry.md`，workflow 形态）

Step 0 读契约（common 三件 + 两个 `-judge` 判据）→ Step 1 spawn 分类（Resume/Retry/Fresh）→ Step 2 调查（**恰好五项亲自读取**，每项标注喂哪个决策；五项之外的任何阅读都派 research）→ Step 3 **建任务清单**（按 `ISSUE_KIND` 选步骤序列，落成显式 checklist；两态出口；每 verdict 后重印）→ Step 4 逐条执行（4a 派发模板 → 4b 按 accept.md 必填字段查结构 → 4c 判实质 → 4d verdict 路由）→ Step 5 handoff → Step 6 按派发账清场 → Step 7 `ITERATION SUMMARY:` 一行（含 `list=` 与 `dispatched=` 字段）。

kind → 步骤序列：

| `ISSUE_KIND` | 序列（每项 = 一次派发） |
|---|---|
| `code` / 空（legacy） | [research?] → implement → verify → submit |
| `blocked` | resolve-blocker → implement → verify → submit |
| `code-spike` | [research?] → source-spike |
| `comment` | [research?] → spike-comment |

verify 发现产品性失败 → 在清单里 verify 行前插入 scoped implement 行，implement 过后**整表**重跑 verify（不是只重跑失败行）——「完整的迭代」在 iter 内闭环，不把半成品推给 review 轮转。iteration 不写 item status；scheduler 从 run ledger 推进到 review。

边界不变：不选别的 issue、不批处理、不建 child issue、不 merge、不关 issue、不动队列与最终状态、不 stage runtime artifacts、不删/弱化 issue 字面要求之外的测试。

---

## 6. Review 调度者（`review-entry.md`，workflow 形态）

Step 0 读契约 → Step 1 调查（**恰好六项亲自读取**；Intent/Result blocks、PR body 与最新 retry comment **verbatim 亲读**；大材料派 investigate）→ Step 2 建清单（**PR-backed kind 强制含 diff-audit 与 replay 两个派发**——缺任一份已验收报告的 verdict（含 retry）无效；"packet 一眼就有问题" 不是豁免，先拿齐两份报告一次引全）→ Step 3 执行派发并消化报告（replay = 契约真值；diff-audit = scope/测试完整性/卫生/代码真值，code findings 须带锚才进 verdict；stale-baseline 例外在此适用）→ Step 4 五项亲自判断（trace honesty / PR protocol / title-intent / caveat honesty / evidence form，每项输入与失败条件内联在步骤现场；先收集全部失败再 verdict，不见首败即停）→ Step 5 closure 分类 → Step 6 终局动作（retry 反馈质量线：契约发现领先措辞发现，每条具名到行号/文件/测试名/触发短语；两份报告全绿而仅剩措辞抱怨时必须对照 honesty-judge 复查再发）+ state write → Step 7 global assessment、handoff、清场、`REVIEW SUMMARY:` 一行（含 `dispatched=` 字段，`no` 仅 no-PR 路由 / stop 合法）。

**review 可独立复验但绝不替 iter 修**。kind 分流矩阵见 `review-entry.md` 的 Kind routing matrix（contract.md §4 有 issue 作者视角摘要）。

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
