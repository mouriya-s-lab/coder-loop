# #709 test(v3): 在冻结 SHA 上完成 #546 综合验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:39Z  | updated: 2026-07-27T04:26:58Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/709
- comments: 1  | timeline events: 15

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

在同一冻结 SHA 上执行总关闭验证；这是唯一跨 child 综合 E2E owner，前置 child 不得用 future seam 冒充。

## 类型化转移补充验收

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| T1 | 出边可计算 | 对含两条后继路径的 preset 执行 compile 与 agent 出边查询 | 每条路径公开目标、prompt template 与 agent-owned `exit.*` schema；不暴露为 agent 可填的外部 binding |
| T2 | 提交即完成 | 真实运行 `seq(A,B)`，A 提交完整 transition 后保持 runner 不退出 | transition 原子持久化，A 完成、B 唯一实例化，A run 进入 #452 待回收语义 |
| T3 | 不完整不得推进 | A 分别提交缺字段、错类型、非法路径并直接 exit 0 | 每次均无 committed transition、B 不创建，runner exit 不冒充完成 |
| T4 | 后继 prompt 数据流 | 合法路径模板同时引用 `exit.*`、`item.*`、`chain.*`、`runtime.*` 与 literal | B 的 prompt/bindings 与各权威来源逐项一致；agent 不能覆盖外部值 |
| T5 | context 边界 | A 只写 context entry 而不提交 transition | context 可按 scope 读取，但 A 不完成、B 不创建；区域共享不替代后继交付 |

## 伞 #546 的关闭终态条件（本 issue 复核对象）

以下是伞 #546 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | seq/par 任意深度可声明可调度 | 声明含嵌套 par 的任务树并真跑 | 嵌套结构按代数语义推进到全树 terminal |
| 2 | par 真并发 | par 内 ≥2 item，daemon 调度下观察 run 时间区间 | 执行区间重叠（真并发，非串行） |
| 3 | 运行中追加平行任务 | 对运行中 leaf 追加兄弟 | 原地物化 par、新 item 被同一容器调度，无需重建 |
| 4 | 物化容器 join 演化 + 定义态零漂移 | 对执行中物化容器追加绑定版本（drain→validator 候选引用；再 validator→drain）；对定义态声明的 join 尝试改写；无授权 agent 尝试放宽 | 追加即审计事件（作者/版本/生效 epoch）；在途 epoch 按旧绑定跑完，下一 epoch 采样新绑定生效；定义态改写被拒并点名；agent 放宽方向被拒；非候选引用值被拒 |
| 5 | reopen 语义 | 验证者先经带 evaluation scope 的 CLI 创建 correction items，再写 `reopen(target, correctionItemIds)` 精确引用 | consumer 校验并原子认领既存 corrections，seq 游标回退、已 terminal item 状态不变、途经节点级联再验证；先前 CLI mutation 不冒充 decision 消费事务的一部分 |
| 6 | reopen 预算 | 预算耗尽再 reopen | 引擎写容器级 exhausted，链不死锁 |
| 7 | 独立 worktree + 闭包三态生命周期 | 任意两个任务的 run（含同 item 先后 phase、同 repo 并发分支）比对路径；触发同任务中断后 resume；触发 phase 推进后对同 item 打回重入 | 不同任务路径互不相同；同任务 resume 醒在同一 worktree；phase 推进后闭包挂起且目录/分支/index/未提交文件/session/scratch 全部保留；打回重入在原闭包原地恢复；只有消费谓词成立后才回收目录/分支并清该 phase `sessionIds` |
| 8 | dependsOn 正交保留 | par 成员携带跨结构 dependsOn | 约束边与并行结构独立生效，环在写入期/装载期被拒 |
| 9 | 取消向下传播 | cancel 一个含活 run 的子树 | 下属 run 全部终止、未启动 item 落取消终态 |
| 10 | 机制/参数分离（#396 契约延续） | grep 引擎源码 | join 策略的取值选择、状态字面量、reopen 预算值均不在引擎，归 preset/元数据声明（join union 的 variant 定义是引擎原生 ADT，不在此列） |
| 11 | 判定器 hold | validator 对未收敛的 par 返回 `hold` | 容器不推进不退回，决策点退避重问（幂等防抖，机制归 #543），下次判定可改判 advance/reopen |
| 12 | 每闭包单活 | 对已有活 run 的闭包再触发调度/唤醒；对挂起态闭包核查 | 引擎拒绝第二个活 run（执法键 = 闭包），拒绝留可审计事件；挂起态闭包无活 run |
| 13 | 闭包分支程序化（供给条款 1/2） | 观察闭包首次打开与 agent 产出的 PR | worktree 底座 = 创建时刻 base 最新快照（引擎先 fetch）；工作分支由引擎创建，agent 未自建分支；PR headRef 即闭包分支 |
| 14 | par 同 commit 派生（供给条款 4） | par 展开含 ≥2 成员并真跑；运行中追加成员；嵌套 par | 成员入口闭包底座 commit 相同且等于持久化的 pin；追加成员复用同 pin；嵌套 par 内层重新 pin |
| 15 | 启动状态对账（供给条款 5） | 人为构造磁盘/分支/DB 三方不一致（多目录、少分支、幽灵记录）后重启 daemon | 对账按闭包状态表逐项核查，异常暴露为可审计事件、不静默清理不掩盖 |
| 15a | 共享 Git 协调面 | 两个 active 闭包 + 一个 suspended 闭包并发执行获准 fetch/commit/push；随后恢复 suspended 闭包并比对 pin/分支/HEAD/index/WIP；另构造 repo config/hooks 漂移 | `origin/*` 可前移且带新鲜度；三闭包保存的稳定输入与私有现场不变；config/hooks 漂移显式暴露；引擎 repo-wide 操作串行且只改自身 namespace |
| 16 | operator 一次性判定 override | operator 对未收敛容器的当前 evaluation epoch 显式写 advance/hold/reopen | 经同一准入门生效 + 独立审计词条；join 绑定不变，下一 epoch 判定主体照旧 |

## 依赖关系

- Depends on: #701、#702、#703、#704、#705、#706、#707、#708；外部 #737、#739；关闭前要求 #698–#708 全部完成。
- Blocks: #546 closure。



---

## Comments (1)

### comment #5055604575 by `RiriAgent` — 2026-07-23T07:23:44Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#709 v3 总关闭综合验收 — 冻结 SHA E2E）相对 baseline 的进度

- **已落地**: 无（本 issue 是唯一跨 child 综合 E2E owner，只在同一冻结 SHA 上跑 16 条终态验收）。
- **半成品**: 无。
- **未开始**（全部 16 条 + 类型化转移 T1-T5）:
  1. seq/par 任意深度声明可调度
  2. par 真并发
  3. 运行中追加平行任务
  4. 物化容器 join 演化 + 定义态零漂移
  5. reopen 语义
  6. reopen 预算
  7. 独立 worktree + 闭包三态生命周期
  8. dependsOn 正交保留
  9. 取消向下传播
  10. 机制/参数分离
  11. 判定器 hold
  12. 每闭包单活
  13. 闭包分支程序化（供给条款 1/2）
  14. par 同 commit 派生（供给条款 4）
  15. 启动状态对账（供给条款 5）
  15a. 共享 Git 协调面
  16. operator 一次性判定 override
  T1-T5: 类型化转移补充验收

### 依赖

本 issue depends on **#701 + #703 + #704 + #707 + #708**（+ 外部 #737 / #739）；关闭前要求 **#698~#708 全部完成**。前置未全部落地前禁止启动本 issue。

### iteration agent

前置未落地时不动手；本 chain 最后一步。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (15)

- 2026-07-17T20:13:40Z `assigned` @RiriAgent
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:05Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:14:07Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:35Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:08Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-23T07:23:44Z `commented` @RiriAgent
- 2026-07-27T04:26:49Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-27T04:27:10Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-27T04:27:11Z `cross-referenced` @RiriAgentsrc=739