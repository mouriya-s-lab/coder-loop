# #702 feat(engine): 运行中动态物化 par

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:24Z  | updated: 2026-07-27T04:26:53Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/702
- comments: 1  | timeline events: 17

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付正式 CLI/admission 下 leaf 原地物化 par、追加 sibling、pin 与诞生 join candidate；validator-at-birth 必须消费已落地 C03。

任何未终结节点可随时被追加平行兄弟：首次追加把运行中 leaf 原地物化为 par（物化请求可显式指定 join，值域 = pinned 定义内候选引用；未指定默认 drain），容器获得稳定 id，授权走 `createItems` right 的作用域维度扩展；追加动作按供给条款 4 的凝固点语义配合 pin（物化即容器诞生点则同步写 pin；追加进已存在容器则复用同 pin，不重新 pin）。

## 预期结果

- 性质：对任何未终结节点的追加请求都产生同容器平行兄弟——目标是裸 leaf 则原地物化为 par；目标已是 par 成员/容器则直接入该容器。已 terminal 节点追加被拒。
- **诞生时 join 参数**（`v3/join-evolution-decision.md` 裁决 4）：物化请求可显式指定 join——值域 = enclosing 实例 pinned 定义内的候选引用（drain 或 validator 候选，与 #703 演化通道共用同一值域），经 join ADT 边界 parse，悬空候选/自由构造的调用声明被拒 + 审计事件；未指定默认 `join=drain`。追加进已存在容器的请求不接受 join 参数（join 归容器诞生点与 #703 演化通道）。
- 物化不打扰在场者：原 leaf 的活 run 不中断、不重建、不重 spawn；物化是纯运行态结构变化。
- 物化时容器获得稳定 id：同容器后续追加复用同一 id；该 id 即 #545 `group` scope 键（存储位遵循 #558（树运行态 shape） 钉住的形态）。
- 调度与状态准入保持 item 粒度：par 节点不进入可调度单元集合、不拥有 item 状态。
- 授权：`createItems` right 增加目标作用域维度——agent 仅能在其被授权作用域内追加（作用域维度的具体词表为本 child 决策项，落地时裁并登记；声明语法与 #547 rights 面协同）；operator 无条件；不新增授权面。
- **凝固点语义（供给条款 4）**：
  - 追加**不重新 pin**——第二次及以后向已存在容器追加成员时，引擎不重写容器 pin；新成员闭包 create 时的底座 commit 从该容器已持久化的 pin 派生。
  - 物化即容器诞生点时**同步写 pin**——把裸 leaf 变成 par 的动作路径中，引擎先 pin base 尖端 commit（存储位随 #558）落库、再落库容器结构（含诞生 join）、再触发新成员闭包 create（新闭包底座 = 该 pin）。原成员（原 leaf 的现存闭包）不改动、不重派生。
  - **嵌套 par 内层重新 pin**：若追加发生在已展开的 par 内某成员，且该追加动作把内层裸 leaf 物化为内层 par，内层 par 独立重新 pin（内层 pin 与外层容器 pin 无关，各自持久化）。
- 追加进来的成员是**新任务** = 新闭包：走 #698 的 spawn 决策「无闭包记录 → 触发 #699 create 转移」路径；本 child 只负责结构落库与 pin 语义，不实现闭包 create 机制本体。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 原地物化（#546 行 3） | 对运行中 leaf 追加平行兄弟（不带 join 参数），观察树快照与原 run | local | 原地物化 par（默认 join=drain）；新 item 被同一容器调度；原 run 不中断不重建；par 容器自身不作为可调度单元被 spawn、不可被写 item 状态（粒度保持 item 级） |
| function | 诞生时 join 指定（预期结果 2） | 物化请求携带 validator 候选引用；另两次分别携带悬空 candidateId 与自由构造调用声明；对已存在容器追加时携带 join 参数 | local | 首次成功：容器诞生即 join=validator(候选)，成员全 terminal 后按 #700 spawn 验证者；悬空引用与自由构造均被拒 + 审计事件；对已存在容器带 join 参数被拒 |
| function | 容器 id 稳定 | 对同一容器再追加一次，比对两次快照的容器 id | local | 同一稳定 id；成员 3 个 |
| function | 物化时 pin 写入（供给条款 4） | 首次物化裸 leaf 为 par 时观察 pin 存储 | local | 容器 pin 落库 = 物化时刻 base 尖端 commit；新成员闭包 create 后底座 commit = 该 pin |
| function | 追加不重新 pin（凝固点语义） | 对已存在 par 容器再追加成员，比对追加前后容器 pin | local | 容器 pin 不变；新成员闭包底座 commit = 容器 pin（不等于追加时刻的 base 尖端） |
| function | 嵌套 par 内层独立 pin | 对已展开 par 的成员再触发内层物化 | local | 内层 par 独立重新 pin，与外层容器 pin 无关；内层新成员底座 = 内层 pin |
| function | terminal 拒绝 | 对已 terminal 节点追加 | local | 被拒 + 审计事件 |
| function | 授权作用域执法 | 无 createItems grant 的 phase 凭证追加；有 grant 但目标超出授权作用域 | local | 均被拒（default-deny）+ 审计事件；operator 无条件成功 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #698、#700；外部 #743。
- Blocks: #703、#706、#708、#709。




---

## Comments (1)

### comment #5055603513 by `RiriAgent` — 2026-07-23T07:23:37Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#702 承接 #563 运行中动态物化 par）相对 baseline 的进度

- **已落地**: 无。
- **半成品**: 无。
- **未开始**: 原地物化裸 leaf 为 par、诞生时 join 参数指定（drain / validator 候选引用；悬空引用与自由构造被拒）、容器 id 稳定、物化时 pin 写入 + 追加不重新 pin + 嵌套 par 内层独立 pin、terminal 拒绝、`createItems` right 作用域授权维度、`group` scope 键与容器 id 一致（存储位跟随 #558 shape）。

### 依赖

本 issue depends on **#698 + #700**。前置未落地时本 issue 无可用测试路径（物化目标是 par 结构，且诞生 join 值域是 pinned 定义候选表）。

### iteration agent

从 baseline checkout，全部从零构建动态物化通路。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (17)

- 2026-07-17T20:13:25Z `assigned` @RiriAgent
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:05Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:29Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:14:58Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-19T07:26:55Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-23T07:23:37Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-26T16:14:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-27T04:26:59Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-27T04:27:12Z `cross-referenced` @RiriAgentsrc=743