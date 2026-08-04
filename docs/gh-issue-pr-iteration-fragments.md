# `gh-issue-pr-iteration` Fragment 布局（调度者架构）

读者：维护 bundled preset 的人——加 / 改 / 删 fragment，调整调度者手册或步骤合同，或想搞清楚某条 trace 走的是哪条路径。

读完后你能：理解 iter / review 两个 entry 的调度者循环；找到任意步骤单文件与品质文件；按 §7 清单安全地改动布局。

不在范围内：preset.toml 字段语义（看 [preset-authoring](./preset-authoring.md)）；写 issue / PR 内容（看 `presets/gh-issue-pr-iteration/contract.md`）；设计意图（看 `presets/gh-issue-pr-iteration/DESIGN.md`）。

---

## 1. preset 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested` |
| `statuses.terminal` | `blocked / moot / done / exhausted` |
| `statuses.unblockable` | `blocked`（`queue unblock` 恢复到 `statuses.entry = queued`） |
| phases | 4 个：`iteration` → `review`（普通执行流），加两个 trigger phase — `blocked-responder`（`trigger = { afterPhase = "review", whenStatus = "blocked" }`）和 `umbrella-finalizer`（`trigger = { on = "chain-complete" }`） |
| phase runner/model | 四个 phase 当前全部 `runner = "codex"`、`model = "gpt-5.6-sol"`；非 trigger phase 仍可被 item 覆盖 |
| `[agent].attemptTimeoutSeconds` | `7200` |
| fragments | 29 个，分布在 `common/ / quality/ / iter/steps/ / review/` 四块 |

`item` 字段（除 `issue / status` 外）。bundled preset 的 `[item.fields]` 把 `issue` (number) / `branch` (string) / `pr` (number) / `lastRunId` (string) 声明为透明字段——engine items 表只保留 `item_id` opaque identity；这些字段落 `extra` JSON，wire 序列化时 flattenExtraReplacer 平铺到 `queue.selected.item.<field>`。CLI 写入统一走 `--field-json`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `attempts` | number / null | iteration→review 业务周期累计次数；仅 fresh iteration 启动时递增，review、trigger、resume 与 rate-limit rollback 不递增；scheduler exhausted 预算单位 |
| `title` | string / null | 人类可读标题 |
| `priority` | `high \| medium \| low` / null | review 决定下一选哪个 |
| `branch` | string / null | iteration 创建的 PR 分支名（透明字段，落 `extra.branch`） |
| `pr` | number / null | iteration 开的 PR 号（透明字段，落 `extra.pr`） |
| `lastRunId` | string / null | 上一次 iteration 的 runId（透明字段，落 `extra.lastRunId`） |
| `issueFile` | string / null | 可选 per-issue handoff attachment 相对路径；主 handoff 是 chain-level `shared.md` |
| `evidenceDir` | string / null | 该 issue 的证据目录相对路径 |
| `agentCwd` | string / null | agent spawn 的绝对 cwd；跨仓或 post-review responder 可指向外部 checkout |
| `runner` | `claude \| codex \| opencode` / null | 该 item 对非 trigger phase（`iteration` / `review`）的 runner override |
| `extra.blockerRepo` | string / undefined | `blocked` transition 通过 `--field-json '{"extraPatch":{"blockerRepo":"<owner>/<repo>"}}'` 写入的阻塞仓库；不是 first-class 列 |
| `extra.blockerRef` | string / undefined | 同上通道写入的阻塞 issue ref 或环境条件 |

status 字面量都是 preset 字符串，引擎只识别 `continuable / terminal` 二元集合。合法状态转移由 review 调度者通过 `coder-loop item update` 或 `item exit-action` 写入 centralized chain state（见 `review/actions/state-write.md`）。

---

## 2. 调度者架构总览

iteration / review 两个复杂角色是**调度者**，entry md 是按序执行的 **workflow**：每个 Step 在使用现场写明做什么、谁做（亲自的命令是闭集，清单外即派发）、派哪个 subagent、传什么输入、回报查什么、各 verdict 去哪。调度者的本职是**维护任务清单**：计划落成显式 checklist，每条只有 `[x] accepted` 或 `[-] skipped: <reason>` 两种出口。

核心约定：

- **每步一个 md 文件，三段结构**：`Task`（subagent 的任务）、`Report`（必填字段结构化汇报模板，空集写 `none`）、`Acceptance`（调度者的验收判据）。执行者与调度者读同一份文件；支持的 runner 都按“诚实但会犯错”设计，判据对执行者可见是有意选择（设计前提见 `presets/gh-issue-pr-iteration/DESIGN.md`）。
- **quality 文件三个单文件**：`quality/evidence.md`、`quality/honesty.md`、`quality/cleanup.md`。每份内含执行侧约束 + 判断侧规则，同源同文。
- **过程纪律以 superpowers 为设计参考蒸馏内联**：`implement` 的 Process discipline 段（test-first 铁律 / 根因先于修复 / retry 反馈逐条核实）与 `verify` / `e2e` / `submit` 的 Claim gate 段（先跑当轮命令读全量输出再落成功措辞）改编自 superpowers 对应 skill 的纪律内核，按无人值守 loop 调整（无 human-partner 分支、无交互 gate）。preset 自包含，不做运行时 skill 调用；蒸馏来源与改编原则见 `presets/gh-issue-pr-iteration/DESIGN.md` 前提八。
- **硬性条件两源**：issue 的任务要求（live issue body）+ preset 的品质判据（`quality/*.md`）。验收是 LLM 判断，不是程序检查；先查结构（必填字段）再判实质。
- **dispatch 消息只含指针 + 运行时键值**，不转述任何规则文本；prompt 内跨文件引用全部写 `{{PRESET_ROOT}}/<rel>` 形式（引擎自有词表，见 `docs/reserved-strings.md`）。`{{PRESET_ROOT}}` 在 preset 加载时被物化层替换为 `<loopDataRoot>/preset-materialized/<name>-<hash>/` 目录的绝对路径——agent 跑在随机 worktree 也读得到；fragment 不经引擎 `{{KEY}}` 渲染，物化时按字面串替换。
- **补缺使用当前 runner 支持的 follow-up；无 continuation 能力时才关闭旧任务并 fresh dispatch**（机制见 `common/dispatch-contract.md`）。
- **e2e 直跑是唯一正规产物**：unit/integration 必须有但只是辅助层；e2e 直接运行真实物；auth/binary 永远是执行者自己解决。
- **运行环境是交付物、清理归 review**：iter 跑完 e2e 留环境 + 交 runtime manifest；review 凭它必然复跑得动，manifest 缺项 = packet 失败；全部 teardown 由 review 执行。
- **代码审查在 loop 内、锚定 issue 设计、不发散**：diff-audit 步审 changed code 的逻辑正确性 / 设计偏离 / conventions / diff 内结构 / diff 内测试变更 / 全仓 issue-named pattern 覆盖，每条发现必须带锚。

trigger 角色（blocked-responder / umbrella-finalizer）任务简单，未调度者化——单一 entry prompt，agent 一次跑完。

---

## 3. Fragment 全集（29）

**common/**（5，含 contract）— 程序↔agent 边界、GitHub 路由、状态不变量、dispatch 契约、issue/PR 解析契约：

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`
- `common/dispatch-contract` — runner-neutral 的 subagent transport 与权威 dispatch ledger；业务拆分和强制步骤仍由 entry 拥有
- `contract` — issue body / PR body / review 验收点解析规则

**quality/**（3）— iter 与 review 共用的品质判据，每份内含执行/判断双侧规则：

- `quality/evidence` — 证据真实性：真实路径、log 文本化、synthetic 拒收、CI parity、测试清单 delta（runner 汇总行取头端计数，不用静态 rg / grep）、弱信号不算验收
- `quality/honesty` — 声明=观察、七类 scope-reduction 触发（cosmetic-handwave 一律硬拒；含 test-weakening）、intent-action 对照、字面授权规则 + stale-baseline 例外
- `quality/cleanup` — 副作用申报与调度者收尾清扫（iter 只扫 scratch；review 拆环境 + 扫自身）

**iter/steps/**（8）— iteration 调度者的步骤合同：

| 步骤 | 用途 |
|---|---|
| `iter/steps/research` | 可选调查步（实现方向不明时派） |
| `iter/steps/resolve-blocker` | unblock-deliverable 前置 scoping（阻塞条件 / 最小成功条件 / replay 计划） |
| `iter/steps/implement` | 写代码（分支续接、读契约、思考框架、intent statement；不 commit） |
| `iter/steps/verify` | 跑验收行（browser 行转交 e2e 步）+ 测试套件两侧清点 + CI parity + 项目命令 |
| `iter/steps/e2e` | 直跑真实物（操作者方式调真实入口 / agent-browser 真 UI，含转交的 browser 验收行；禁脚本 e2e）+ 留 standing environment + 写 runtime manifest |
| `iter/steps/submit` | intent-vs-action delta、commit、push、PR（fresh）或 PR comment（retry） |
| `iter/steps/source-spike` | source-writing-spike-deliverable 整步（PoC 分支 + 命令 + no-merge comment） |
| `iter/steps/spike-comment` | comment-spike-deliverable 整步（评论 + 结果分支 + 提议 sub-issues） |

**review/**（13）：

- `review/steps/investigate` — 重材料读取回 verbatim 摘要（可选派发）
- `review/steps/diff-audit` — **强制派发**（PR-backed，纯读）：PR diff vs base 的 scope 映射（每个 changed file 归 in-scope/support/unmapped）、runtime artifacts 卫生扫描、diff 中的测试变更（含 config/glob/skip-marker/CI test-collection 变化）逐条枚举、锚定 issue 设计的代码审查、issue-named 全仓收敛模式单次全 site 枚举
- `review/steps/replay` — **强制派发**（PR-backed，占 AGENT_CWD + 驱动 standing environment）：canonical 全套测试命令按 runner 汇总行取头端计数、验收表逐行真跑（`Env=browser` 行在 e2e re-drive 的真 UI walk 内执行）、按 iter 交接的 runtime manifest 复跑 packet e2e 主张（程序真实入口 / agent-browser 真 UI）、脚本 e2e 形态即 finding；环境保持运行交还调度者收尾
- `review/spike-followup`、`review/source-spike-audit` — 特定 deliverable 判断指南（调度者亲读）
- `review/actions/{accept-pr,accept-no-pr,retry,expand-parent,skip,blocked,stop}` — 终局动作（调度者按 verdict 只读其一并亲自执行副作用）
- `review/actions/state-write` — `coder-loop item update` 状态写出与 expand 队列规则

fragment 总数 = 5 + 3 + 8 + 13 = 29，与 `preset.toml` 的 `[[fragments]]` 块数和 `tests/unit/preset/helpers.ts` 的 `EXPECTED_FRAGMENTS` 一致。

---

## 4. Iteration 调度者（`iter-entry.md`，workflow 形态）

Step 0 读契约（4 份 common：`runtime-contract` / `github-routing` / `state-contract` / `dispatch-contract` + 两份 quality `honesty` / `evidence`）→ Step 1 spawn 分类（Resume/Retry/Fresh）→ Step 2 调查（**核心项亲自读取**：issue、linked PR 全量拉取并 verbatim 引用最新 retry comment 与 PR body caveat 段、sub-issues、shared context、state 文件、current-issue 文件、一跳图引用；bulk 材料派 `research`）→ Step 3 **建任务清单**（按 **deliverable signal** 从 issue body 判断，落成显式 checklist；两态出口）→ Step 4 逐条执行（4a 派发模板 → 4b 按单文件 Acceptance 节查结构 → 4c 判实质 → 4d verdict 路由；`verify ∥ e2e` 同轮并发派发；ledger 是权威子任务状态）→ Step 5 Wrap up（最终 checklist / handoff / summary 写盘）→ Step 6 Cleanup（scratch only，e2e standing environment 保留）→ Step 7 `ITERATION SUMMARY:` 一行。此 summary 是给 review 的接力人类信号，不承担引擎控制语义。

Deliverable signal → 步骤序列：

| Deliverable signal | 序列（每项 = 一次派发；`∥` = async 并发派发） |
|---|---|
| Code change（默认路径） | `[research?] → implement → (verify ∥ e2e) → submit` |
| Unblock 另一个 issue | `resolve-blocker → implement → (verify ∥ e2e) → submit` |
| Source-writing spike（no-merge） | `[research?] → source-spike` |
| Comment deliverable | `[research?] → spike-comment` |

Body 信号在两行之间模糊时，先派 `research` 钉死。verify / e2e 发现产品性失败 → 在清单里插入 scoped implement 行，implement 过后 `verify ∥ e2e` **两行都**重跑完整契约。iteration 不写 item status；scheduler 从 run ledger 推进到 review。

边界不变：不选别的 issue、不批处理、不建 child issue、不 merge、不关 issue、不动队列与最终状态、不 stage runtime artifacts、不删/弱化 issue 字面要求之外的测试。

---

## 5. Review 调度者（`review-entry.md`，workflow 形态）

Step 0 读契约 → Step 1 调查（**核心项亲自读取**：trace、shared context 里的 Intent/Result 块、state 文件、current-issue 文件、target 的 CLAUDE.md/AGENTS.md、live GitHub state 含 issue body 与 PR 全量并 verbatim 引用最新 retry comment 与 PR body caveat 段、一跳图引用；bulk 材料派 investigate）→ Step 2 建清单（**PR-backed 路由强制含 diff-audit 与 replay 两个派发**——缺任一份已验收报告的 verdict（含 retry）无效；争用安排：diff-audit 纯读 ∥ replay 占 AGENT_CWD 并驱动 standing environment，同一 async round 派发）→ Step 3 执行派发并消化报告：
- **replay** = 契约行 / e2e / suite-count 真值：验收表逐行真跑、canonical 测试头端计数（runner 汇总行）、e2e 直跑复演、browser 契约行在真 UI walk 内执行、packet e2e 脚本形态即 form finding、unblock 路由必含 blocked-path e2e。
- **diff-audit** = scope / 卫生 / 代码 / 测试完整性真值：files 映射、runtime artifacts 卫生、diff 中测试变更逐条枚举（含 test-collection 层变化）、锚定 issue 设计的 4 类 code findings、issue-named 全仓收敛模式单次全 site 枚举。

→ Step 4 亲自判断：trace honesty / PR protocol / title-intent / caveat honesty / evidence form / checks-mergeability 实测。先收集全部失败再 verdict → Step 5 closure 分类 → Step 6 终局动作（PR 回复是**全量 review 报告**：每个 check 一节引实测值 + `## 缺失汇总` 单一权威缺口区 + `## Skipped checks` 写明理由；retry 反馈质量线：契约发现领先措辞发现）+ state write + 环境收尾（e2e standing environment 的 teardown 归 review）→ Step 7 global assessment、handoff、清场、`REVIEW SUMMARY:` 一行。

**review 可独立复验但绝不替 iter 修**。Review 的 deliverable-signal 分流见 `review-entry.md` 底部的 routing matrix（contract.md §4 有 issue 作者视角摘要）。终局动作通过 `coder-loop item exits` + `item update --status` 或 `item exit-action --action stop` 落 phase-exit。

---

## 6. 实战：从 trace 反推走了什么

phase 输出文件路径由 `coder-loop status <target> --json` 的 `current.phaseStatus.value.outputPath` 暴露；layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`。反推依据：

- **调度者的派发账**（dispatch ledger）与各步 subagent 汇报会出现在 stdout 流里——按步骤名（research / implement / verify / submit / diff-audit / replay …）定位。
- **handoff 注记**：iter 在 `loop-data/chains/<chain>/shared.md` 留 per-run 计划、Intent/Result 块与各步 outcome；review 留 verdict + 失败判断点 + replay 摘要。
- **终行**：iter 尾部的 `ITERATION SUMMARY:` 是给 review 的接力人类信号，不承担引擎语义；review 的终局是通过 `coder-loop item update --status` 或 `item exit-action` 显式写 phase-exit。

---

## 7. 改布局的检查清单

加 / 删 / 改 entry、步骤单文件、品质判据时：

1. 改源 markdown。步骤单文件保持 `Task` / `Report` / `Acceptance` 三段齐全；跨文件引用写 `{{PRESET_ROOT}}/<rel>` 形式（引擎物化时替换为绝对路径；语义见 `docs/reserved-strings.md`）。
2. 改 `preset.toml` 的 `[[fragments]]` 块（增 / 减条目）。
3. 改 `iter-entry.md` / `review-entry.md` 的步骤文件表或验收点顺序。
4. 改 `tests/unit/preset/helpers.ts` 的 `EXPECTED_FRAGMENTS` 数组与 `tests/unit/preset/load-bundled.test.ts` 的 entry 断言。
5. 改 `presets/gh-issue-pr-iteration/contract.md`（§3 验收点总表 / §4 deliverable 路由）与本文档（§3 全集 / §4-5）。
6. 跑 `bun test`（preset.test.ts 验证 fragment 集合一致性）+ `bun x tsc --noEmit`。

漏改任一处 → preset load throws 或 test 红或文档说谎。
