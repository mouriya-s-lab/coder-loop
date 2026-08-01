# #703 feat(daemon): 物化容器 join binding 演化

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:26Z  | updated: 2026-07-27T04:26:54Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/703
- comments: 1  | timeline events: 14

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付 append-only binding version、epoch 冻结、候选引用与方向授权。

物化容器的判定权演化通道：容器未终结期间经 socket 追加 join 绑定版本（值域 = pinned 定义内候选引用），下一 evaluation epoch 采样生效；定义态容器与非法值被拒；授权方向敏感（加严可授 agent，放宽 operator-only）；每次演化留一等审计事件。

## 预期结果

- **演化通道**：物化容器未终结期间，operator 经 socket 对其追加 join 绑定版本；值经 join ADT + 候选引用边界 parse——candidateId 在 enclosing 实例 pinned 定义的候选表中解析，悬空引用/词表外值/自由构造的调用声明均被拒；追加与审计事件（作者、授权类别、v(n)→v(n+1)、生效起始 epoch）同事务落地。
- **生效语义**：追加对在途 evaluation epoch 零影响（该 epoch 按创建时采样的绑定跑完，含同 epoch 崩溃重问）；下一 epoch 创建时采样最新版本（采样机制归 #700/#712，本 child 保证版本序列读面在采样点可用且 append-only 无中间态）。
- **定义态拒绝**：join 来自 preset/chain metadata 声明（非物化诞生）的容器，任何绑定追加被拒 + 审计事件，错误点名定义态不可变与 `v3/join-evolution-decision.md`。
- **授权方向敏感**：operator 恒可（双向）；agent 凭证默认拒绝；preset rights 显式授权的 phase 仅可加严方向（drain→validator），放宽方向（validator→drain）对 agent 恒拒；授权语义复用 #409/#410 权利矩阵形态，不新增授权面。
- **place 属性不变**：追加前后容器 id、par pin、reopen 预算计数、`group` scope 键全部不变。
- 已 terminal 容器的追加被拒（无意义写入）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 演化生效于下一 epoch（预期结果 1+2） | 物化容器（drain）在途 evaluation 中追加 validator 候选绑定；观察本轮与下轮汇合 | local | 本轮按旧绑定完成；下轮 epoch 采样新绑定 spawn 验证者；审计事件含 v(n)→v(n+1) 与生效 epoch |
| function | 同 epoch 主体冻结（预期结果 2） | evaluation `evaluating` 中追加绑定后 kill -9 daemon 重启，观察同 epoch 重问 | local | 重问仍按 epoch 记录中采样的旧绑定执行；新绑定仅下一 epoch 生效 |
| function | 定义态拒绝（预期结果 3） | 对 preset phase 树声明 join 的容器追加绑定 | local | 被拒 + 审计事件，错误点名定义态不可变 |
| function | 授权方向敏感（预期结果 4） | 无 rights agent 追加；有 rights agent 分别追加加严与放宽；operator 双向 | local | 无 rights 拒；有 rights 加严成功、放宽被拒；operator 双向成功；每次尝试留审计事件 |
| function | 值域候选引用（预期结果 1） | 分别写入悬空 candidateId、自由构造的 item 调用声明 JSON、合法候选引用 | local | 前两者边界 parse 被拒且错误点名；合法引用解析进 enclosing 实例 pinned 定义 |
| function | place 属性不变（预期结果 5） | 追加前后比对容器 id、pin commit、reopen 计数、group 键 | local | 全部不变 |
| function | terminal 拒绝（预期结果 6） | 对已 terminal 容器追加 | local | 被拒 + 审计事件 |
| assumption | join 不在 control-plane set | `grep -rn "PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS" src/` 后人工核对 | local | set 仍为四字段；join 演化走独立命令分类 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #700、#702。
- Blocks: #708、#709。



---

## Comments (1)

### comment #5055603635 by `RiriAgent` — 2026-07-23T07:23:38Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#703 承接 #564 物化容器 join binding 演化）相对 baseline 的进度

- **已落地**: 无。
- **半成品**: 无。
- **未开始**: 演化通道（socket 追加 join 绑定版本）、生效语义（在途 epoch 零影响 / 下一 epoch 采样）、定义态拒绝、授权方向敏感（agent 加严 vs operator 双向）、值域候选引用（悬空/自由构造被拒）、place 属性不变（container id / pin / reopen 预算 / group 键）、terminal 拒绝、join 不进入 `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS`（保留四字段）。

### 依赖

本 issue depends on **#700 + #702**。前置未落地时本 issue 无可用测试路径。

### iteration agent

从 baseline checkout，全部从零构建 binding 演化通道。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (14)

- 2026-07-17T20:13:27Z `assigned` @RiriAgent
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:30Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:00Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-19T07:26:55Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-23T07:23:38Z `commented` @RiriAgent
- 2026-07-26T16:14:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T16:14:47Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:01Z `cross-referenced` @RiriAgentsrc=705