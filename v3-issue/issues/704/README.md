# #704 feat(engine): 子树取消向下传播

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:29Z  | updated: 2026-07-27T04:26:55Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/704
- comments: 1  | timeline events: 10

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付 runtime subtree cancel、active run 终止、未启动 leaf 取消、兄弟隔离；取消不冒充 closure consume。

对任务树任一子树的取消操作：向下传播终止全部下属活 run（SIGTERM→SIGKILL 复用看门狗路径），未启动 item 落取消终态，兄弟子树不受影响；取消本身不触发 GC，闭包只有在 #699 消费谓词随后成立时才进入 consumed 并回收。

## 预期结果

- 性质：对任一节点的 cancel 使其整个子树到达终结——
  - 全部下属**活 run**被终止（SIGTERM→SIGKILL，复用看门狗信号路径与事件形态）；
  - 全部**未启动 item**落取消终态；
  - 容器节点落取消终结；
  - 子树内已 create 的闭包停止执行但环境原地保留；取消不证明 consumed，不触发 GC；从未 create 的 item 只落取消终态；
  - 子树外的节点（兄弟、祖先的其他分支）零影响——兄弟闭包不动、兄弟活 run 不中断、兄弟未启动 item 不落取消终态。
- 取消不上溯：被取消子树对外层呈现为失败终态，归外层 join 消化（drain 照常放行、validator 可见），不自动传播失败。
- 取消终态字面量不驻留引擎：跟随 `[statuses].exhausted` 先例——引擎写入、字面量来自声明；声明键名与声明位（preset statuses / chain 元数据）为本 child 显式决策项，落地时裁并登记在本 issue（声明语法与 #547 编译面协同）。
- 幂等：对已 terminal 子树 cancel 为 no-op（成功返回，无副作用）——闭包取消状态不重复写；活 run 已被杀过的不重发信号。
- 授权：cancel 是 mutation，进 #409 编译期穷尽分类；主体分级（operator 恒可；agent 是否可取消自身作用域）为本 child 显式决策项，落地时裁并登记。
- 每次 cancel 留审计事件（请求 + 每个被终止 run 的终止事件 + 每个被取消 run 的状态事件）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 取消向下传播（#546 行 9） | cancel 一个含 1 活 run + 1 未启动 item 的子树，`ps` 验证进程、查 items 终态 | local | 活 run 进程组消失（SIGTERM→SIGKILL 事件可见）；未启动 item 落取消终态 |
| function | 取消不触发 GC（活跃闭包） | 取消活跃 run 后核对闭包状态、目录、分支、sessionIds | local | run 已停止、取消终态已写；worktree/分支/sessionIds 仍在；无消费证据 |
| function | 取消不触发 GC（挂起闭包） | 取消包含挂起闭包的子树 | local | 闭包保持可恢复环境；目录/分支/sessionIds 仍在；仅消费谓词成立后由 #699 回收 |
| function | 未 create 过闭包的 item | 子树内含从未启动的 item（无闭包记录），取消该子树 | local | 落取消终态；无 consume/GC 调用 |
| function | 兄弟零影响（#546 行 9） | 上一行的树中并行兄弟子树带活 run 与已挂起闭包 | local | 兄弟 run 不中断、照常推进到 terminal；兄弟挂起闭包环境与状态均不变 |
| function | 失败归 join 不上溯 | 被取消子树所在 par 的 join=drain 与 join=validator 各跑一次 | local | drain：全员 terminal 后照常放行；validator：判定输入可见被取消成员 |
| function | 幂等 | 对已 terminal 子树重复 cancel | local | no-op 成功返回，无新副作用；不重发信号、不重复写取消状态；GC 仍只由 consumed 触发 |
| function | 授权分级执法 | 主体分级决策项裁定后，以未授权主体（按裁决为 agent 或越作用域凭证）发 cancel | local | 被拒 + 审计事件；行为与本 issue 登记的裁决一致 |
| assumption | 终态字面量不驻留引擎（#546 行 10 切片） | 决策项裁决后 `grep -rn "<取消终态字面量>" src/` | local | 引擎零命中；字面量仅存在于声明（preset/元数据）与测试 fixture |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #698、#699、#700。
- Blocks: #708、#709。




---

## Comments (1)

### comment #5055603764 by `RiriAgent` — 2026-07-23T07:23:39Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#704 承接 #565 子树取消向下传播）相对 baseline 的进度

- **已落地（间接底座）**: SIGTERM→SIGKILL 看门狗信号路径与 daemon 层 run 终止事件形态在 v2 已存在（baseline 未改）；#699 落地的 closure lifecycle 提供"取消后闭包环境原地保留、不触发 consume"的底座（`src/closure-lifecycle.ts` 消费谓词只在显式条件下触发，取消不落谓词）。
- **半成品**: 无。
- **未开始**: 取消向下传播的树遍历、未启动 item 落取消终态、容器节点落取消终结、幂等（对已 terminal 子树 no-op）、失败归 join 不上溯、取消终态字面量声明位（`[statuses]` 声明键决策，跟随 `exhausted` 先例）、授权分级（agent 主体是否可取消自身作用域决策）、审计事件全套（请求 + 每个被终止 run 的终止事件 + 每个被取消 run 的状态事件）。

### 依赖

本 issue depends on **#698 + #699 + #700**。#698 树遍历、#700 join 消化未落地前，本 issue 无完整触发路径。

### iteration agent

从 baseline checkout，全部从零构建 subtree cancel 通道。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (10)

- 2026-07-17T20:13:30Z `assigned` @RiriAgent
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:31Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:02Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-23T07:23:39Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755