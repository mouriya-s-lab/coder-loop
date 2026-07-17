# `gh-issue-pr-iteration` Fragment 布局（八 phase 单 session 架构）

读者：维护 bundled preset 的人——加 / 改 / 删 fragment，调整 phase entry 或步骤合同，或想搞清楚某条 trace 走的是哪条路径。

读完后你能：理解八个普通 phase entry（`contract-enrichment` / `iteration` / `verification` / `publish` / `diff-audit` / `verification-audit` / `review` / `closure`）与两个 trigger entry 的分工；找到任意步骤单文件与品质文件；按 §9 清单安全地改动布局。

不在范围内：preset.toml 字段语义（看 [preset-authoring](./preset-authoring.md)）；写 issue / PR 内容（看 `presets/gh-issue-pr-iteration/contract.md`）；设计意图（看 `presets/gh-issue-pr-iteration/DESIGN.md`）。

---

## 1. preset 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested / contract_invalid / candidate_drift / verification_drift / publication_drift / review_drift`（四个 drift 是 closure 的 sameness 再入路由，漏声明会让 closure 写入后 item 永不再入 frontier；`verification_drift` 同时是 verification-audit 的 packet 缺陷出口） |
| `statuses.terminal` | `blocked / moot / done / exhausted` |
| `statuses.unblockable` | `blocked`（`queue unblock` 恢复到 `statuses.entry = queued`） |
| phases | 8 个：`contract-enrichment` → `iteration` → `verification` → `publish` → `diff-audit` → `verification-audit` → `review` → `closure`（普通执行流），加两个 trigger phase — `blocked-responder`（`trigger = { afterPhase = "review", whenStatus = "blocked" }`）和 `umbrella-finalizer`（`trigger = { on = "chain-complete" }`）。只有 `iteration` 声明 `startsAttempt = true`：一次 attempt 覆盖它之后的整条后继链 |
| phase runner/model | 全部 phase 当前 `runner = "codex"`、`model = "gpt-5.6-sol"`；非 trigger phase 仍可被 item 覆盖 |
| `[agent].attemptTimeoutSeconds` | `7200` |
| fragments | 30 个，分布在 `common/ / enrichment/ / quality/ / iter/steps/ / review/` 五块 |

`item` 字段（除 `issue / status` 外）。bundled preset 的 `[item.fields]` 把 `issue` (number) / `branch` (string) / `pr` (number) / `lastRunId` (string) 声明为透明字段——engine items 表只保留 `item_id` opaque identity；这些字段落 `extra` JSON，wire 序列化时 flattenExtraReplacer 平铺到 `queue.selected.item.<field>`。CLI 写入统一走 `--field-json`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `attempts` | number / null | iteration→closure 业务周期累计次数；仅 fresh iteration 启动时递增，后继 phase、trigger、resume 与 rate-limit rollback 不递增（closure 的 `verification_drift` / `publication_drift` / `review_drift` 中链再入也不递增，只有 `candidate_drift` 回 iteration 时新开一次）；scheduler exhausted 预算单位 |
| `title` | string / null | 人类可读标题 |
| `priority` | `high \| medium \| low` / null | review 决定下一选哪个 |
| `branch` | string / null | 交付分支名（透明字段，落 `extra.branch`；由 iteration / publish 通过 rights grant 同步） |
| `pr` | number / null | PR 号（透明字段，落 `extra.pr`；同上通道同步） |
| `lastRunId` | string / null | 上一次 iteration 的 runId（透明字段，落 `extra.lastRunId`） |
| `issueFile` | string / null | 可选 per-issue handoff attachment 相对路径；主 handoff 是 chain-level `shared.md` |
| `evidenceDir` | string / null | 该 issue 的证据目录相对路径 |
| `agentCwd` | string / null | agent spawn 的绝对 cwd；跨仓或 post-review responder 可指向外部 checkout |
| `runner` | `claude \| codex \| opencode` / null | 该 item 对非 trigger phase（八个普通 phase）的 runner override |
| `extra.blockerRepo` | string / undefined | `blocked` transition 通过 `--field-json '{"extraPatch":{"blockerRepo":"<owner>/<repo>"}}'` 写入的阻塞仓库；不是 first-class 列 |
| `extra.blockerRef` | string / undefined | 同上通道写入的阻塞 issue ref 或环境条件 |

status 字面量都是 preset 字符串，引擎只识别 `continuable / terminal` 二元集合。合法状态转移按 phase 所有权写入 centralized chain state：终局 `done` / `moot` 只由 closure 写；`changes_requested` / `contract_invalid` 由发现缺陷的 phase 写；`verification_drift` 由 verification-audit（packet 缺陷）或 closure（live 漂移）写；`blocked` 与队列动作由 review 写（见 `common/state-contract.md` 的 Phase transition ownership 表与 `review/actions/state-write.md`）。写出通道统一是 `coder-loop item exits` + `item update --status` 或 `item exit-action`。

---

## 2. 架构总览

**本 preset 禁用 subagent**：每个 phase 的 entry agent 在自己那一次 spawn 里 inline 走完全部步骤，不派嵌套 agent、不 delegate 到其他 runner session。独立复核不靠 session 内隔离，靠 **phase 拆分**：verification 独立执行、diff-audit 与 verification-audit 各自 fresh session 出 durable 报告、review 只裁决。

八个普通 phase 之间以 GitHub 上的 durable packet 交接（`common/packets.md`），谁都不信谁的自述：iteration 产出 candidate + **CandidateRef**；verification 独立执行 contract checks 后发布 **VerificationPacket**；publish 从 packet 组装 ready deliverable；diff-audit 出 **DiffAuditReport**；verification-audit 出 **VerificationAuditReport**；review 裁决后落 **ReviewVerdict**；closure 只信 packet 链与 live state。PR body 的 `coder-loop:current-state` index（五个 append-only URL 数组 + `contractMarkerUrl`）是 O(1) 定位面——消费者按名拉取，不枚举 comment 时间轴。

核心约定：

- **每个步骤单文件三段结构**：`Task`（这一步做什么）、`Report`（必填字段结构化汇报模板，空集写 `none`）、`Acceptance`（勾掉清单行前的自检门槛）。iteration 在同一 session 内读并 inline 执行；判据对执行者可见是有意选择（设计前提见 `presets/gh-issue-pr-iteration/DESIGN.md`）。
- **quality 文件三个单文件**：`quality/evidence.md`、`quality/honesty.md`、`quality/cleanup.md`。每份内含执行侧约束 + 判断侧规则，同源同文。
- **过程纪律以 superpowers 为设计参考蒸馏内联**：`implement` 的 Process discipline 段（test-first 铁律 / 根因先于修复 / retry 反馈逐条核实）与 `verify` / `e2e` / `submit` 的 Claim gate 段（先跑当轮命令读全量输出再落成功措辞）改编自 superpowers 对应 skill 的纪律内核，按无人值守 loop 调整（无 human-partner 分支、无交互 gate）。preset 自包含，不做运行时 skill 调用；蒸馏来源与改编原则见 `presets/gh-issue-pr-iteration/DESIGN.md` 前提八。
- **权威输入分层**：live issue body/operator comments 提供 intent；唯一 current executable-contract marker 提供 Deliverable、typed Checks、Pattern scope、Canonical runtime、Test delta 与 Dependencies；`quality/*.md` 提供跨步骤品质判据。验收是 LLM 判断，不是程序检查；先查结构（必填字段）再判实质。
- **prompt 内跨文件引用全部写 `{{PRESET_ROOT}}/<rel>` 形式**（引擎自有词表，见 `docs/reserved-strings.md`）。`{{PRESET_ROOT}}` 在 preset 加载时被物化层替换为 `<loopDataRoot>/preset-materialized/<name>-<hash>/` 目录的绝对路径——agent 跑在随机 worktree 也读得到；fragment 不经引擎 `{{KEY}}` 渲染，物化时按字面串替换。
- **真实路径 E2E 是正规产物**：按 marker 的 Canonical runtime 执行 target-mandated real driver；它可以是仓库脚本，判断依据是真实路径而非文件形态。
- **运行环境是交付物、清理按 runtime handoff ADT 分账**：iter 跑完 e2e 留环境 + 交 runtime manifest（`durable` / `recreatable` 二择一）；verification 按 kind 独立复驱并负责它接手的环境 teardown（packet 的 `runtime.cleanup` 记录结果）；diff-audit / verification-audit / review 纯读为主，不复驱 e2e runtime、不停自己没启动的东西（`quality/cleanup.md`）。
- **代码审查在 loop 内、锚定 issue 设计、不发散**：diff-audit phase 审 changed code 的逻辑正确性 / 设计偏离 / conventions / diff 内结构 / diff 内测试变更 / marker Pattern 覆盖，每条发现必须带锚 + 根因 mechanism（provenance + class sweep）；范围外根因走 `## Out-of-scope roots` 路由，不计入本 PR。

trigger 角色（blocked-responder / umbrella-finalizer）任务简单——单一 entry prompt，agent 一次跑完。两者各带窄授权（`[phases.rights]`）：blocked-responder 有 `createItems` + `privilegedOps = ["item.dependsOn"]`——在 blocker 仓的 chain 里 `item add` 注入 follow-up item，再对自己的 blocked item 写顶层 `dependsOn`，之后引擎在 blocker item 落 `done` 时自动把 blocked item 恢复到 `queued`（打印 `RESPONDER SUMMARY:`）；umbrella-finalizer 有 `createItems`——剩余 scope 经 `gh issue create` + `coder-loop item add` 注入本 chain（打印 `FINALIZER SUMMARY:`，`decision=complete|keep-active` 由引擎解析）。

---

## 3. Fragment 全集（30）

**common/**（6，含 contract）— 程序↔agent 边界、GitHub 路由、状态不变量、executable authority、packet 协议与 PR protocol：

- `common/runtime-contract`
- `common/github-routing`
- `common/state-contract`
- `common/executable-contract` — marker currentness、Supersedes 与 intent/executable authority 边界
- `common/packets` — CandidateRef / VerificationPacket / DiffAuditReport / VerificationAuditReport / ReviewVerdict 五个 fenced-json packet 的 schema、`coder-loop:current-state` index（五个 append-only URL 数组）、revision-join 消费表与 durability 规则
- `contract` — intent 形态指南与 PR protocol；不替代 marker packet

**enrichment/**（2）— 一次性调查节点：

- `enrichment/task` — 调查 source、target rules、runtime 并发布 marker
- `enrichment/contract-schema` — typed packet schema（Checks / Pattern / Canonical runtime / Test delta / Dependencies）

**quality/**（3）— 各 phase 共用的品质判据，每份内含执行/判断双侧规则：

- `quality/evidence` — 证据真实性：真实路径、log 文本化、synthetic 拒收、套件计数只认 runner 汇总行（不用静态 rg / grep；测试完整性归 diff-audit 按 diff 枚举）、弱信号不算验收
- `quality/honesty` — 声明=观察、七类 scope-reduction 触发（cosmetic-handwave 一律硬拒；含 test-weakening）、intent-action 对照、字面授权规则 + stale-baseline 例外
- `quality/cleanup` — 副作用申报与各 phase 收尾自扫（按 runtime handoff ADT 分账）

**iter/steps/**（8）— iteration 在自己 session 内逐条执行的步骤合同：

| 步骤 | 用途 |
|---|---|
| `iter/steps/research` | 可选调查步（实现方向不明时先做） |
| `iter/steps/resolve-blocker` | unblock-deliverable 前置 scoping（阻塞条件 / 最小成功条件 / replay 计划） |
| `iter/steps/implement` | 写代码 + **本地 commit**（分支续接、读契约、思考框架、intent statement；不 push——verify/e2e 对 committed HEAD 执行） |
| `iter/steps/verify` | 跑验收行（browser 行转交 e2e 步）+ 测试套件 + 项目命令 |
| `iter/steps/e2e` | 按 marker Canonical runtime 驱动真实路径（可使用 target-mandated repository script；含 typed browser Checks）+ 留 standing environment + 写 runtime manifest |
| `iter/steps/submit` | intent-vs-action delta、push（commit 归 implement）、**draft** PR（fresh：`Closes` 行 + 简述 + fresh-check 表，不组装 evidence packet——四层 body 归 publish）或 PR delta comment（retry：最新 feedback 逐项回应 + cross-round finding ledger）+ `coder-loop:candidate-ref` block 与 `coder-loop:current-state` index（绑定 exact pushed head SHA；publish 才把 draft 翻 ready） |
| `iter/steps/source-spike` | source-writing-spike-deliverable 整步（PoC 分支 + 命令 + no-merge comment） |
| `iter/steps/spike-comment` | comment-spike-deliverable 整步（评论 + 结果分支 + 提议 sub-issues） |

**review/**（11）— review 裁决用的判断指南与终局动作：

- `review/spike-followup`、`review/source-spike-audit` — 特定 deliverable 判断指南（review 亲读）
- `review/actions/{accept-pr,accept-no-pr,reenrich,retry,expand-parent,skip,blocked,stop}` — 终局动作（review 按 verdict 只读其一并亲自执行副作用）
- `review/actions/state-write` — `coder-loop item update` 状态写出与 expand 队列规则

fragment 总数 = 6 + 2 + 3 + 8 + 11 = 30，与 `preset.toml` 的 `[[fragments]]` 块数和 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 一致。diff-audit 与 verification-audit 没有 role fragment——它们的全部指令在各自 entry md 里（`diff-audit-entry.md` / `verification-audit-entry.md`，roles 只挂 `common + quality`）。

---

## 4. Iteration（`iter-entry.md`，单 session workflow）

Step 0 读契约（`runtime-contract` / `github-routing` / `state-contract` / `executable-contract` / `packets` + 两份 quality `honesty` / `evidence`）→ Step 1 spawn 分类（Resume/Retry/Fresh；先验 marker，坏 marker 直接 `contract_invalid`）→ Step 2 调查（**全部亲自读取**：issue + marker、linked PR 经 `coder-loop:current-state` index 拉取——retry 时读全量 cross-round 历史（三个报告/verdict 数组的每个 URL）并**自建 required-changes ledger**、sub-issues、shared context、queue selected（`coder-loop status --json`）、current-issue 文件、一跳图引用；verbatim 引用 verdict 要求行与 caveat 段）→ Step 3 **建任务清单**（按 current marker 的 **Deliverable** 选序列，落成显式 checklist；两态出口）→ Step 4 逐条 inline 执行（读对应 runbook 的 Task / Report / Acceptance 三段，自查过 Acceptance 才勾行）→ Step 5 Wrap up（CandidateRef 确认 gate、`branch` / `pr` 字段同步、handoff run note）→ Step 6 Cleanup（scratch only，e2e standing environment 按 runtime handoff ADT 交接）→ Step 7 `ITERATION SUMMARY:` 一行。此 summary 是给后继 phase 的接力人类信号，不承担引擎控制语义；scheduler 由 clean exit 推进到 verification。

Marker `Deliverable` → 步骤序列（全部同 session 顺序执行，无并发）：

| Deliverable | 序列 |
|---|---|
| `implementation-pr` | `[research?] → implement → verify → e2e → submit` |
| `blocker-removal` | `resolve-blocker → implement → verify → e2e → submit` |
| `source-writing-spike` | `[research?] → source-spike` |
| `spike-comment` | `[research?] → spike-comment` |

verify 与 e2e **顺序**执行（verify 先——e2e 驱动的是 verify 观察到的 committed HEAD）；任一步发现产品性失败 → 清单插入 scoped `implement — fix` 行，修完按序重跑 verify → e2e 覆盖完整契约。Marker 缺失、歧义或落后于 operator correction 时走 `contract_invalid` 回 enrichment；不得由 iteration 猜路。干净收尾时 iteration 不写 item status（clean exit 走 completed edge 进 verification）。

边界不变：禁 subagent、不选别的 issue、不批处理、不建 child issue、不 merge、不关 issue、不动队列与最终状态、不 stage runtime artifacts、测试变更遵守 marker `Test delta`。

---

## 5. verification / publish / closure（单 session 执行者）

三个 entry 都是单 session 顺序执行；每个都以 revision join（packet 声明的 SHA == live head）为前置，join 失败按 drift/contract_invalid 路由，不带病继续。

- **verification**（roles `common + quality`）：解析 marker + CandidateRef → materialize exact SHA → 逐项执行 contract checks + target-required suites（已被 Check 行覆盖的套件不重复跑）+ 一次真实 E2E（**绝不修改产品源码**）→ 发布 `coder-loop:verification-packet` PR comment 并 append 到 index 的 `verificationPacketUrls` → 干净收尾进 publish；candidate 失败写 `changes_requested`，contract 缺陷写 `contract_invalid`。打印 `VERIFICATION SUMMARY:`。
- **publish**（rights `branch` / `pr`，roles `common + quality`）：revision join 后按 VerificationPacket 组装 PR title / body / `Closes` / 四层 evidence + runtime manifest（body 是唯一 evidence 叙事面；iteration 的 draft body 只有身份与路由），`gh pr ready` 翻 draft，`coder-loop item update --field-json` 同步 `branch` / `pr` 镜像字段 → 干净收尾进 diff-audit。打印 `PUBLISH SUMMARY:`。
- **closure**（roles `common`，唯一写 `done` / `moot` 的 phase）：重读 live state（crash 恢复：已 merged → 续做剩余 effect，不重复 merge）→ drift 检查表（首个 mismatch → `candidate_drift` / `verification_drift` / `publication_drift` / `review_drift` / `contract_invalid`）→ 按序执行 effect（`gh pr merge --squash --delete-branch`、closure comment + issue close；issue 带 `Unblocks:` back-link 时只在 comment 里点名，不做任何 unblock 动作——跨仓解锁由引擎的 dependsOn 自动恢复承担，`done` 落地即释放依赖它的 item，`moot` 不释放须在 handoff 标注）→ 确认 live terminal state 后**最后**写 `done` / `moot`。普通 merge 失败 → `review_drift`；approval 边界 / 部分完成 → 非零退出不写 status，留给 recover-run。打印 `CLOSURE SUMMARY:`。

---

## 6. diff-audit / verification-audit（独立审计 phase）

两个 fresh-session 审计 phase，在 publish 与 review 之间串行运行；纯读为主，绝不修 code / tests / PR body，各出一份 durable 报告 comment 并 append 到 index 对应数组。review 只消费报告，不重审。

- **diff-audit**（`diff-audit-entry.md`）= scope / 卫生 / 代码真值 / 测试完整性：marker 先于 diff 读取 → `git diff <base>...<head>` 物化 → 逐文件 scope 映射（in-scope/support/unmapped）→ 卫生扫描（runtime artifacts / 日志 / droppings）→ diff 内测试变更逐条枚举（含 test-collection 层变化；本 preset 测试完整性的唯一权威）→ marker Pattern rows 按 typed scope（`changed` / `whole-tree`）跑覆盖表 → 锚定 issue 设计的 4 类 code findings + 每条的根因 mechanism（provenance 分类 + class sweep 全量站点枚举；范围外根因移 `## Out-of-scope roots`）→ 事实性 change footprint → 出 **DiffAuditReport**（`clean` / `changes-requested` / `contract-invalid`）。
- **verification-audit**（`verification-audit-entry.md`）= packet 链 / identity / 覆盖真值：index 解析 packet 链 → 三方 SHA identity binding（CandidateRef == packet.candidate == live head）→ marker Check 覆盖表核对（原命令、cwd、exit、observation）→ artifact 解析与内容抽查 → live checks（statusCheckRollup / mergeStateStatus 对 verified SHA——review 与 contract 表消费的就是这份记录）→ runtime 记录与 conclusion 一致性 → 有界 spot 复跑（仅对起疑的廉价行）——**不**复跑 canonical suite、完整 check 表或 E2E → 出 **VerificationAuditReport**（`clean` / `verification-drift` / `changes-requested` / `contract-invalid`；`verification-drift` 回 verification 对同一 candidate 重跑）。

---

## 7. Review（`review-entry.md`，单 session 裁决者）

Step 0 读契约 → Step 1 调查（**全部亲自读取**：trace、shared context 的 Intent/Result 块、queue selected（`coder-loop status --json`）、current-issue 文件、target 的 CLAUDE.md/AGENTS.md、live GitHub state——经 index 拉取 head-only 对象（marker / 本轮 iteration delta comment / 最新 packet 与两份审计报告）与 full-history 对象（全部 verdict + 全部审计报告，供 cross-round 判断）、一跳图引用；verbatim 引用 caveat 段；不枚举 PR comment 时间轴）→ Step 2 读两份 durable 审计报告并 roll-up（**PR-backed 路由缺任一份报告的 verdict 一律无效**——路由 `changes_requested` 点名缺报告的 phase；任一报告 `changes-requested` / `contract-invalid` → 直接采纳其 verdict 与 findings；对报告有异议只能路由回该 audit phase 重跑，禁止影子重审）→ Step 3 亲自做 7 项 self-judgment：trace honesty / PR protocol / title-intent / caveat honesty / evidence form / checks-mergeability / **cross-round regression**（自建历史 findings ledger 与 submit 的 ledger 逐行核对：行数相等、每行 addressed/regressed-and-refixed/deferred 有实据、曾修复项在当前 head 仍成立、静默掉行即硬拒）。evidence form 与 checks-mergeability 消费 VerificationPacket 与 VerificationAuditReport 的记录——不重开 artifact、不重复 `gh pr view`。先收集全部失败再 verdict → Step 4 Completeness judgment（child closure table、atomic/parent/moot 分类）→ Step 5 Verdict action（按 outcome 只读一个 action 文件并执行其副作用；retry 反馈质量线：契约与 packet 发现领先措辞发现，逐条带锚一次给全）→ Step 6 global assessment（按 status 词表分类整队列）、handoff、清场、最终 exit 选择。

`accepted` / `moot` → 落 durable `coder-loop:review-verdict` block 后**干净收尾进 closure**（不 merge、不 close、不写 done/moot）；`retry` / `reenrich` / `blocked` → status write；`stop` → exit-action。

**review 绝不替被审工作修**。Review 的 marker Deliverable 分流见 `review-entry.md` 底部的 routing matrix（contract.md §4 有 issue 作者视角摘要）。状态写出通过 `coder-loop item exits` + `item update --status` 或 `item exit-action --action stop` 落 phase-exit。

---

## 8. 实战：从 trace 反推走了什么

phase 输出文件路径由 `coder-loop status <target> --json` 的 `current.phaseStatus.value.outputPath` 暴露；layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`。反推依据：

- **每个 phase 的 trace 就是顺序步骤本身**（无 subagent 派发）——iteration 按任务清单行（research / implement / verify / e2e / submit …）定位；审计 phase 按报告章节定位。
- **GitHub packets**：enrichment marker、`coder-loop:candidate-ref`（PR body）、`coder-loop:verification-packet`、`coder-loop:diff-audit-report`、`coder-loop:verification-audit-report`、`coder-loop:review-verdict`（各自 PR/issue comment）构成可反推的 durable 链；PR body 的 `coder-loop:current-state` index 五个数组按轮次给出全部 URL。
- **handoff 注记**：每个 phase 在 `loop-data/chains/<chain>/shared.md` 留 per-run note；iter 另有 Intent/Result 块。
- **终行**：每个 phase 尾部的 `<PHASE> SUMMARY:` 是给后继的接力人类信号，不承担引擎语义；状态转移全部通过 `coder-loop item update --status` 或 `item exit-action` 显式写 phase-exit，终局 `done` / `moot` 只出现在 closure 的 trace 里。

---

## 9. 改布局的检查清单

加 / 删 / 改 entry、步骤单文件、品质判据时：

1. 改源 markdown。步骤单文件保持 `Task` / `Report` / `Acceptance` 三段齐全；跨文件引用写 `{{PRESET_ROOT}}/<rel>` 形式（引擎物化时替换为绝对路径；语义见 `docs/reserved-strings.md`）。
2. 改 `preset.toml` 的 `[[fragments]]` 块（增 / 减条目）。
3. 改对应 entry（`contract-enrichment` / `iter` / `verification` / `publish` / `diff-audit` / `verification-audit` / `review` / `closure` 的 `-entry.md`）的步骤文件表或验收点顺序。
4. 改 `src/preset.test.ts` 的 `EXPECTED_FRAGMENTS` 数组与 entry 断言。
5. 同步检查 `common/executable-contract.md`、`enrichment/contract-schema.md`、`contract.md`、templates 与本文档；authority/schema 只在前两者定义。
6. 跑 `bun test`（preset.test.ts 验证 fragment 集合一致性）+ `bun x tsc --noEmit`。

漏改任一处 → preset load throws 或 test 红或文档说谎。
