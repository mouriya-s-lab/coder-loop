# #705 feat(engine): chain 任务树与顶层 join

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:31Z  | updated: 2026-07-27T04:26:56Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/705
- comments: 2  | timeline events: 23

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付 chain metadata 生产实例化、顶层 join 和 chain-complete stdout 路径退役；复用 C03/C04，不自建第二 evaluator。

chain 层任务树（含顶层 join）声明落 chain metadata；chain-complete trigger 迁移为顶层 join 实例：判定经 CLI 写回、`FINALIZER SUMMARY` stdout 解析退役。

## 预期结果

- chain metadata 可声明 chain 层任务树：未声明 = 退化 `seq(items by position)`（现状语义，零迁移成本）；可声明嵌套 seq/par 与各容器 join；本 child 导出并唯一拥有该声明的精确 ADT、arktype boundary 与静态校验（树 well-formedness、join 完备性、reopen target 合法性），写入方只消费此 boundary，不得由 #742 或 daemon handler 再造第二套 parser。已解析值由 #743 规范化为 `ChainDefinitionRef`；引擎侧运行期防线自有。
- **`chain.baseBranch` 声明位**（2026-07-10 登记，源 #546 body「供给条款 1」）：integration base（默认 main，per-chain 可配——"系统迁就现场，不是现场迁就系统"），与顶层 join / chain-complete 同属 chain metadata 声明位家族。本 child 承接其**声明位**（chain metadata 字段的边界 parse 与静态校验），**消费方为 #699**（引擎起点解析：fetch base、worktree 底座 = 创建时刻该分支最新快照）——声明与消费分离。#546 body 逐字快照：

  > "**起点公理**：worktree 底座 = 创建时刻 `chain.baseBranch`（integration base，默认 main，per-chain 可配——系统迁就现场）最新快照；引擎创建前 fetch base（per-repo 串行化/去重，网络失败显式化，pin 成员免 fetch）……"

- chain-complete 判定 = 顶层 join 实例：顶层容器全 terminal 时按声明评估——drain 即完成；validator 则 spawn 终审 leaf，判定经 CLI 写回（`advance` ≡ 完成、`hold` ≡ keep-active 且幂等指纹语义保持——同一队列布局不重复问）。
- `FINALIZER SUMMARY` stdout 解析退役：`parseFinalizerSummaryDecisionFromText` 删除，`docs/reserved-strings.md` 对应行更新——落地后引擎零 stdout 控制信号（性质：全部控制信号经 CLI + 准入门）。
- bundled preset 迁移：`umbrella_finalizer` 从 preset trigger phase 迁为 chain 层顶层 validator 声明（chain create 时写入 metadata），`gh-issue-pr-iteration` 全保真行为不回归。
- preset 侧 `trigger = { on = "chain-complete" }` 声明位退役（`afterPhase`/`whenStatus` trigger 不在本 child，归 #706（phase 树接入））。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | chain 层嵌套树声明真跑（#546 行 1 声明半边） | `chain create --config-json` 声明含嵌套 par 的 chain 层树，灌 items 真跑 | local | 嵌套结构按代数语义推进到全树 terminal |
| function | `chain.baseBranch` 声明位（消费方 #699） | `chain create` 时携带非默认 `baseBranch`（如 `develop`），查 chain metadata；未声明时查默认 | local | 声明经边界 parse 落 chain metadata；未声明 = 默认 `main`；消费（fetch/底座解析）由 #699 承接 |
| function | 顶层 validator ≡ chain-complete | 声明顶层 validator；终审 agent 分别经 CLI 写 advance / hold | local | advance：chain 完成；hold：chain 保持 active、指纹幂等（同一队列布局不重复 spawn 终审） |
| function | 判定经 CLI 非 stdout | 终审 agent 在 stdout 打印旧 `FINALIZER SUMMARY: decision=complete` 但不调 CLI | local | 零效果——chain 不完成；仅 CLI 写回生效 |
| function | 未声明 = 退化 seq | 不带树声明建 chain 灌 items 真跑 | local | 行为与现状一致（顺序推进、drain 完成） |
| assumption | stdout 控制信号与旧声明位清零 | `grep -rn "FINALIZER SUMMARY" src/ docs/ presets/`；`grep -rn "chain-complete" src/ presets/*/preset.toml` | local | FINALIZER：src/ 零命中、docs/reserved-strings.md 无「现行 stdout 控制字符串」条目、preset 文案同步；preset 侧 `on = "chain-complete"` trigger 声明位退役（引擎解析与 bundled preset 声明均不存） |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #698、#699、#700、#701、#742。
- Blocks: #707、#708、#709、#733。




---

## Comments (2)

### comment #5055603929 by `RiriAgent` — 2026-07-23T07:23:40Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#705 承接 #566 chain metadata 顶层 join + chain-complete 迁移）相对 baseline 的进度

- **已落地（消费方半边）**: `chain.baseBranch` 消费方——`src/closure-lifecycle.ts` 里 fetch base + 派生 pin 的路径已完全遵循 #560 消费规则（fresh base、fetch failure typed 事件、no-origin fallback、HEAD 永不 fallback）。相关 commit：`fix: complete closure lifecycle runtime evidence` (48af423) 系列、`fix(scheduler): typed reachability-fact API, unpublished-orphan retention, async branch validation` (cbec3d7)。本 issue 声明位落定后此消费半边直接消费即可。
- **半成品**: 无。
- **未开始（声明位与 chain 顶层）**:
  - chain metadata 顶层任务树 ADT + arktype boundary + 静态校验（well-formedness / join 完备性 / reopen target 合法性）
  - `chain.baseBranch` **声明位**（边界 parse + 静态校验）—— 当前只有消费方，声明位归本 issue
  - 顶层 validator ≡ chain-complete（`FINALIZER SUMMARY` stdout 解析退役、`parseFinalizerSummaryDecisionFromText` 删除、`docs/reserved-strings.md` 更新）
  - `umbrella_finalizer` 从 `gh-issue-pr-iteration` preset trigger phase 迁到 chain 层顶层 validator 声明
  - `gh-issue-pr-iteration` 全保真行为零回归验证

### 依赖

本 issue depends on **#698 + #699 + #700 + #701**。声明位形式取决于树/闭包/join/reopen 语义已落地。

### iteration agent

从 baseline checkout。消费方半边已在 tree，只补声明位、chain metadata 层与 `FINALIZER SUMMARY` 退役。PR base = `coder-loop/v3-546-baseline`。



### comment #5066045420 by `RiriAgent` — 2026-07-24T04:08:54Z

已创建对应的 BLOCKED draft 实现 PR：[PR #757](https://github.com/mouriya-s-lab/coder-loop/pull/757)。它从 [PR #755](https://github.com/mouriya-s-lab/coder-loop/pull/755) 收窄后的 #698 分支堆叠，只承载从 #755 拆出的 chain 顶层 join 实现；#698、#699、#700、#701 等依赖满足前不进入合并。后续实现与 review 证据放在 PR #757。


---

## Timeline (23)

- 2026-07-17T20:13:32Z `assigned` @RiriAgent
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:32Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:04Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-17T20:38:56Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:39:09Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-23T07:23:40Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-24T04:08:54Z `commented` @RiriAgent
- 2026-07-26T16:14:13Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:02Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-26T23:49:06Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-26T23:49:10Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-26T23:52:39Z `cross-referenced` @RiriAgentsrc=743