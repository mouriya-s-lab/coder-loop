# #701 feat(engine): reopen、纠正项与 leaf 重激活一致语义

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:20Z  | updated: 2026-07-27T04:26:52Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/701
- comments: 1  | timeline events: 16

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付 correction/reopen 原子执行、预算和祖先级联重评估；同时答复 #698 未决修订：queue.unblock 与 dependsOn 恢复都不得直接翻转已越过 leaf，而统一形成结构化 reopen，级联重开祖先。

`reopen(target, correctionItemIds)` 判定的执行机制：精确引用同 evaluation scope 下先经 CLI 创建的纠正 item，并在消费时校验/认领到 target、target 内已挂起任务闭包重开（闭包生命周期 suspended → active 转移）、seq 游标回退、零状态重置、级联再验证、reopen 预算耗尽落容器级 exhausted。

## 预期结果

- reopen 执行的性质（六步，单事务见原子性条款）：① 校验 decision 引用的 corrections（≥1）均是同 evaluation scope 先经 CLI 创建、尚未被其他 decision 认领且属于 target 的既存纠正 item，并在本次消费中原子认领；每个纠正 item 的闭包已按 create 路径建立（par 内从 pin 派生）；② target 内被打回任务的闭包从 suspended 重开（经 #699 转移：原闭包原地恢复 active）；③ 所在 seq 游标回退到 target；④ reopen 计数递增；⑤ 判定消费完成标记落地；⑥ 审计事件。**已 terminal 的 item 状态不变**（零状态重置——不回滚记账，不丢现场）；副作用 append-only，新一轮可见。
- **闭包连续性**：target 重开前后，worktree 路径、闭包分支、PR headRef、该 phase `sessionIds` 全部不变——第二轮工作落在同一分支同一 PR，不产生平行分支/平行 PR。
- 级联再验证：游标回退后 seq 再次途经中间节点——drain 且无新工作瞬时通过；validator 重新裁决。不实现「跳过未受影响节点」。
- target 运行期校验：仅 self 或同一 seq 内更早兄弟合法；指向未跑节点、跨 seq 作用域的 reopen 被拒 + 审计事件（装载期静态校验归 #547 编译面，运行期校验是引擎自有防线——判定值运行时到达，装载期检查覆盖不了）。
- reopen 预算：容器级上限，值取自 preset/chain 元数据；耗尽后再收到 reopen 时引擎写容器级 exhausted 终态（item terminal 不自动 consume 闭包；GC 仍等待 #699 消费谓词），外层按失败终态归 join 消化，链不死锁。
- **reopen 执行原子性**（操作员裁决 2026-07-10，边界 4 审查）：既存 correction IDs 的校验/认领、target 重开 + seq 游标回退、预算递增，与判定消费完成标记（script kind 下即 #712 评估状态的 `consumed`）在单个状态存储事务内落地——daemon 在执行中途崩溃时恢复后要么整体重执行、要么已整体完成，不存在游标已回退但预算未记（或反之）的中间态。reopen 没有物理重建；事务只落定闭包态与控制流效果，既存 worktree 不参与该事务。
- reopen budget 是显式可选参数；未声明 = 不限。引擎不得驻留默认 reopen 次数或用任意 hard cap 代替声明。声明了预算时，耗尽语义按上文执行；未声明时，停止条件只能来自显式 decision/外层取消，不由引擎猜测。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | reopen 完整行为（#546 行 5） | seq(A, B, C)，C 处 validator 先经带 evaluation scope 的 CLI 创建 correction item `fix-1`，再写 `reopen(target=A, correctionItemIds=["fix-1"])`，真跑观察事件序列与 items | local | 纠正 item 追加进 A（新闭包 create）、A 重开、seq 游标回退到 A、已 terminal item 状态全部不变 |
| function | 闭包连续性（#546 行 7 切片） | 上一行中比对 target 被打回任务 reopen 前（挂起时）与 reopen 后的闭包元数据与 GitHub 面 | local | worktree 路径、闭包分支、PR headRef、该 phase sessionIds 全部不变；第二轮 commit 落同一 PR；挂起期 WIP 在重开后可见 |
| function | 级联再验证（#546 行 5） | 首行场景继续跑完 | local | 途经 B 时 drain 无新工作瞬时通过（或 validator 重新裁决），事件序列可证 |
| function | 非法 target 被拒 | validator 分别写 target=未跑节点、target=跨 seq 节点 | local | 均被拒 + 审计事件；容器状态不变 |
| function | 预算耗尽（#546 行 6） | 容器声明 reopen 预算 1，validator 连续两次 reopen | local | 第二次时引擎写容器级 exhausted；闭包环境继续保留，直到 #699 消费谓词成立后才 GC；链不死锁 |
| assumption | 预算值不驻留引擎（#546 行 10 切片） | 用未声明预算与显式预算 1 两个 fixture 真跑，并 grep 默认值定义 | local | 未声明时不限；显式预算 1 时第二次 reopen exhausted；引擎无默认 reopen 次数 |
| function | reopen 执行原子性 | correction 已经由 CLI 创建后，提交引用其精确 ID 的 reopen；配合 daemon kill -9 于消费时机真跑 | local | correction 的校验/认领、重开态转移、游标、预算、消费标记同时在场或同时缺席；先前 CLI 创建记录独立存在且不会重复；恢复后不重复计预算 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 范围补充：leaf 事后重激活语义缺口

来自 #546 树对抗审查第二轮（调用面全集扫描，2026-07-02）：**「leaf 事后重激活」类语义缺口**，本 child 落地时必须裁并登记。

现状存在两条把 terminal item 恢复为 continuable（entry status）的通道，都绕过 join/reopen 机制：

1. **`queue.unblock`**（operator 驱动）：`handleQueueUnblock`（`src/daemon.ts:2069-2112`）把 unblockable-terminal item 恢复到 preset entry status，`hard-deny-for-agent`、operator-only。
2. **dependsOn 满足恢复**（engine 驱动）：`src/scheduler.ts:1705-1748`——terminal item 的全部 dependsOn 目标到 success 后自动恢复 entry。

树调度下的未定义交互：被恢复的 leaf 若位于**已放行（advance/drain 通过）的 par 容器**或**seq 游标已越过的位置**，祖先视图如何一致——候选语义（本 child 决策项，不预钉）：(a) 重激活级联重开祖先（对齐本 issue 的 reopen 游标回退语义）；(b) 对已放行容器内成员拒绝恢复（错误点名原因）；(c) 允许 leaf 重跑但容器状态不变——注意 (c) 会造成「容器 terminal 而成员 active」的视图分裂，若选它须写明快照如何呈现。

两条通道必须落同一语义（它们是同一类事件的 operator/engine 两个触发源），裁决写回本 issue 并同步 #700（若裁 (a)，重激活即一个 join 重评估/reopen 触发点）与 #558（若容器状态可被重激活改变，shape 的容器状态机须可表示）。

验收补充行（裁决后具体化）：对已放行容器内成员分别经 `queue unblock` 与 dependsOn 满足触发恢复 → 行为与登记裁决一致、树快照无未定义状态。

## 依赖关系

- Depends on: #699、#700。
- Blocks: #705、#708、#709、#714、#715。




---

## Comments (1)

### comment #5055603359 by `RiriAgent` — 2026-07-23T07:23:36Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#701 承接 #562 reopen 执行语义）相对 baseline 的进度

- **已落地（间接底座）**: closure suspend/reopen 生命周期机制（`src/closure-lifecycle.ts`）已支撑本 issue 依赖的 "target 内挂起闭包 suspended→active 转移" 底座；`fix: preserve closure reopen and reconciliation invariants` (6babc2d) 与 `fix: preserve migrated closure resources on reopen` (ba4a421) 落定了闭包重开的 invariant，本 issue 可直接消费。
- **半成品**: 无 — 有底座但无本 issue 层的 reopen 执行语义（六步事务、correction ID 认领、seq 游标回退、级联再验证、reopen 预算、原子性）。
- **未开始**: reopen 完整行为（correction append → target 重开 → seq 游标回退 → 级联再验证）、target 运行期校验（拒绝跨 seq / 未跑节点）、reopen 预算耗尽落容器级 exhausted、reopen 执行原子性单事务、`queue.unblock` 与 dependsOn 满足恢复的树调度语义归并（#559 未回复的范围补充）。

### 依赖

本 issue depends on **#699**（承接完成，底座已在 baseline）+ **#700**（validator 侧写 reopen decision）。#700 未落地前，本 issue 的 reopen 执行没有触发源。

### iteration agent

从 baseline checkout，利用已在 tree 的 closure suspend/reopen 底座实现 reopen 执行语义。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (16)

- 2026-07-17T20:13:21Z `assigned` @RiriAgent
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:29Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:14:52Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-17T20:14:56Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-17T20:38:33Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-18T07:40:29Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-23T07:23:36Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-26T23:49:10Z `cross-referenced` @RiriAgentsrc=712