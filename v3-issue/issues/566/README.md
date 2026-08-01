# #566 feat(engine): chain 层任务树声明位——chain metadata 承载顶层 join 与 chain-complete 迁移

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:16:01Z  | updated: 2026-07-17T20:15:04Z
- closed: 2026-07-17T20:15:04Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/566
- comments: 1  | timeline events: 26

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）。继承条款逐字快照：

> "chain-complete trigger（`src/scheduler.ts:1809`）→ 顶层 task 的 join 判定实例（#543 已认定其为 gate 实例）；声明位从 preset trigger 迁至 chain metadata（chain 层树语义的一部分，见接口假设答复 #547）" — #546 body「旧概念 → 新代数映射」

> "**答复 #547（RFC-2）反向登记项**：`DEFAULT_PRESET_NAME` 退役后「无 item 在手的 chain 级判定」的落点 = **chain metadata**——chain 层任务树（含顶层 join/chain-complete 判定）声明在 chain 自身元数据，不来自任何 preset（#412 已使 chain 退出 preset 事实源，preset 无处兜底）；声明的边界 parse 与校验归 #547 编译/校验面。item 恢复词表（`entryItemStatusForRecovery`）仍取自 per-item preset，不受影响。" — #546 body「接口假设」

> "chain | 顶层 task（通常 seq）；chain 作为命名/凭证/隔离边界保留" — #546 body「旧概念 → 新代数映射」

> "`hold` 承接 #543 操作员裁决 2 与 chain-complete keep-active 先例——本 RFC 把 chain-complete trigger 定性为顶层 join 实例，该先例的 `keep-active` 正是 `hold`" — #546 body「join 策略与验证者判定」

## 目标

chain 层任务树（含顶层 join）声明落 chain metadata；chain-complete trigger 迁移为顶层 join 实例：判定经 CLI 写回、`FINALIZER SUMMARY` stdout 解析退役。

## 使用场景

operator 建 chain 时在 chain metadata 声明 chain 层树结构（本 child 唯一拥有该声明的 schema、arktype boundary parse 与静态校验；#605 在 chain create 时将已解析声明冻结为 `ChainDefinitionRef`，实例生命周期内不可修改；运行中仅允许动态物化新容器，且只有物化态容器可经 #564 追加 join binding version，本 child 不另开声明态改写面）——默认退化 `seq(items)` 零声明可用；需要并行批次时声明嵌套 par 与 join；需要「链完成前终审」时声明顶层 validator（即现 chain-complete finalizer 的 v3 形态：keep-active ≡ hold，complete ≡ advance）。这也是 #547 退役 `DEFAULT_PRESET_NAME` 后「无 item 在手的 chain 级判定」的唯一落点。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- chain-complete trigger 现状：preset 侧 `trigger = { on = "chain-complete" }` 声明；评估在 `src/scheduler.ts:1784-1851`（`chainCompleteTriggerState` 指纹持久化于 chain metadata）；判定解析 `parseFinalizerSummaryDecisionFromText`（`src/loop.ts:4863`）——**全仓唯一残存 stdout 控制信号**（`docs/reserved-strings.md:16-18` 自证：「当前唯一还依赖 stdout 文本解析的控制字符串」）。
- `ChainMetadata`（`src/runtime-data.ts:105`）：bindings / maxItemAttempts / `coderLoopChainCompleteTrigger` 先例——chain 级声明与状态已走 metadata。
- `DEFAULT_PRESET_NAME`（`src/daemon.ts:374`、`src/loop.ts:70`）退役归 #547 零原语清单；本 child 提供其所需的 chain metadata 落点。
- bundled preset `gh-issue-pr-iteration` 的 `umbrella_finalizer` phase 是 chain-complete trigger 的唯一生产消费者（`presets/gh-issue-pr-iteration/preset.toml`）——迁移后它成为 chain 层顶层 validator 的 item 调用声明，real-e2e 全保真跑它。
- join 评估与 hold 归 #561（join 评估）；reopen 执行归 #562（reopen 执行）。

## 问题

chain 层唯一的「树语义」是 chain-complete trigger，且它声明在 preset、判定走 stdout 解析——三重违反 v3 契约：判定应经 CLI 写回（#397 形态）、chain 层语义不应来自 preset 事实源（#412 方向）、引擎应零 stdout 控制信号；chain metadata 无任务树声明位，#546 行 1 的 chain 层声明面缺失；#547 的 `DEFAULT_PRESET_NAME` 退役被本落点阻塞。

## 预期结果

- chain metadata 可声明 chain 层任务树：未声明 = 退化 `seq(items by position)`（现状语义，零迁移成本）；可声明嵌套 seq/par 与各容器 join；本 child 导出并唯一拥有该声明的精确 ADT、arktype boundary 与静态校验（树 well-formedness、join 完备性、reopen target 合法性），写入方只消费此 boundary，不得由 #557 或 daemon handler 再造第二套 parser。已解析值由 #605 规范化为 `ChainDefinitionRef`；引擎侧运行期防线自有。
- **`chain.baseBranch` 声明位**（2026-07-10 登记，源 #546 body「供给条款 1」）：integration base（默认 main，per-chain 可配——"系统迁就现场，不是现场迁就系统"），与顶层 join / chain-complete 同属 chain metadata 声明位家族。本 child 承接其**声明位**（chain metadata 字段的边界 parse 与静态校验），**消费方为 #560**（引擎起点解析：fetch base、worktree 底座 = 创建时刻该分支最新快照）——声明与消费分离。#546 body 逐字快照：

  > "**起点公理**：worktree 底座 = 创建时刻 `chain.baseBranch`（integration base，默认 main，per-chain 可配——系统迁就现场）最新快照；引擎创建前 fetch base（per-repo 串行化/去重，网络失败显式化，pin 成员免 fetch）……"

- chain-complete 判定 = 顶层 join 实例：顶层容器全 terminal 时按声明评估——drain 即完成；validator 则 spawn 终审 leaf，判定经 CLI 写回（`advance` ≡ 完成、`hold` ≡ keep-active 且幂等指纹语义保持——同一队列布局不重复问）。
- `FINALIZER SUMMARY` stdout 解析退役：`parseFinalizerSummaryDecisionFromText` 删除，`docs/reserved-strings.md` 对应行更新——落地后引擎零 stdout 控制信号（性质：全部控制信号经 CLI + 准入门）。
- bundled preset 迁移：`umbrella_finalizer` 从 preset trigger phase 迁为 chain 层顶层 validator 声明（chain create 时写入 metadata），`gh-issue-pr-iteration` 全保真行为不回归。
- preset 侧 `trigger = { on = "chain-complete" }` 声明位退役（`afterPhase`/`whenStatus` trigger 不在本 child，归 #567（phase 树接入））。

## 不应残留

- 本 child 范围内：`parseFinalizerSummaryDecisionFromText` 及任何 stdout 判定解析；preset 侧 `on = "chain-complete"` trigger 声明位；`docs/reserved-strings.md` 中「stdout 控制字符串」的过时行。
- 本 issue 范围之外不应改动：不动 `afterPhase`/`whenStatus` trigger（归 #567（phase 树接入））；不退役 `DEFAULT_PRESET_NAME` 本体（归 #547，本 child 只提供落点）；不动 join 评估机制本体（归 #561（join 评估））。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：preset compile/render contract、受影响 fragment/CLI 的目标测试，以及使用确定性 runner 的最小调度 integration。
- **本 issue 必须证明**：修改后的声明或 prompt 能被当前引擎装载并进入预期分支，旧制度性指示/旧词表按正文清单消失；不得只靠 grep，也不得要求真实 agent 替代确定性断言。
- **不在本 issue 内执行**：本 issue 不自行运行完整 GitHub issue→PR→merge→close。改动合流后的 `real-e2e-minimal`/`gh-issue-pr-iteration` compatibility 由 #685 在冻结发布候选 SHA 上统一证明；涉及 v3 新运行态的接缝由 #684 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | chain 层嵌套树声明真跑（#546 行 1 声明半边） | `chain create --config-json` 声明含嵌套 par 的 chain 层树，灌 items 真跑 | local | 嵌套结构按代数语义推进到全树 terminal |
| function | `chain.baseBranch` 声明位（消费方 #560） | `chain create` 时携带非默认 `baseBranch`（如 `develop`），查 chain metadata；未声明时查默认 | local | 声明经边界 parse 落 chain metadata；未声明 = 默认 `main`；消费（fetch/底座解析）由 #560 承接 |
| function | 顶层 validator ≡ chain-complete | 声明顶层 validator；终审 agent 分别经 CLI 写 advance / hold | local | advance：chain 完成；hold：chain 保持 active、指纹幂等（同一队列布局不重复 spawn 终审） |
| function | 判定经 CLI 非 stdout | 终审 agent 在 stdout 打印旧 `FINALIZER SUMMARY: decision=complete` 但不调 CLI | local | 零效果——chain 不完成；仅 CLI 写回生效 |
| function | 未声明 = 退化 seq | 不带树声明建 chain 灌 items 真跑 | local | 行为与现状一致（顺序推进、drain 完成） |
| assumption | stdout 控制信号与旧声明位清零 | `grep -rn "FINALIZER SUMMARY" src/ docs/ presets/`；`grep -rn "chain-complete" src/ presets/*/preset.toml` | local | FINALIZER：src/ 零命中、docs/reserved-strings.md 无「现行 stdout 控制字符串」条目、preset 文案同步；preset 侧 `on = "chain-complete"` trigger 声明位退役（引擎解析与 bundled preset 声明均不存） |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #558（树运行态 shape，chain 层树持久化）、#561（join 评估，顶层 join 评估机制）、#562（reopen 执行，顶层 validator 可 reopen）、#605（chain create 冻结 chain 层结构声明；daemon 重启与运行消费者沿 pinned definition 解引用，定义态 join 实例内不可变）。
- Blocks: #557（`DEFAULT_PRESET_NAME` 退役只消费本 child 的唯一 typed boundary；#557 不再拥有 chain declaration schema/parser）。


---

## Comments (1)

### comment #5007118599 by `RiriAgent` — 2026-07-17T20:15:03Z

重新拆分后由 #705 承接 chain 任务树与顶层 join。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (26)

- 2026-07-02T11:16:02Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:21Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-02T11:18:28Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:12Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-05T07:46:21Z `cross-referenced` @RiriAgentsrc=557
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-10T11:21:06Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-10T17:21:26Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-11T10:10:36Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-15T06:26:45Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:32Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:15:03Z `commented` @RiriAgent
- 2026-07-17T20:15:04Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:30Z `cross-referenced` @RiriAgentsrc=742