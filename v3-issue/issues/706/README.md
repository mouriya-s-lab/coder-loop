# #706 feat(scheduler): preset phase tree 与 trigger 迁移

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:33Z  | updated: 2026-07-27T04:26:57Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/706
- comments: 2  | timeline events: 20

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 现行补充契约：类型化路径完成协议

继承 [#451](https://github.com/mouriya-s-lab/coder-loop/issues/451) 与 [#452](https://github.com/mouriya-s-lab/coder-loop/issues/452)：agent 查询合法出边并经 CLI 提交选择，提交即业务完成；runner exit 不是业务完成权威。v3 将其从裸 status 扩展为 committed transition。

preset 对每条后继路径声明目标、可选 prompt 模板及全部输入来源。agent 只填写声明为 `exit.*` 的类型化对象；固定或外部值由既有 `item.*` / `chain.*` / `runtime.*` / typed literal binding 按 `required | default` 与 projection 规则填充。缺字段、错类型、非法路径或不可满足的已知 required binding 均不得完成当前 leaf，也不得创建后继。

本 issue 负责后继 phase 的真实 prompt 消费：路径可选择专属 prompt 模板；模板中的 `exit.*` 值来自前驱 committed transition，其余值沿既有 preset binding 解析。线性数组退化为 `seq` 时也必须走同一协议，不得保留“不带 transition state 的数组推进”旁路。

补充验收：fixture 声明 A 的一条路径到 B，模板同时引用 agent 提交的结构对象与 `item.*` / `chain.*` / `runtime.*` / literal。真实 CLI 完成 A 后读取 B 的落盘 prompt/bindings，所有值与来源逐项相等；agent 尝试在 exit object 伪造外部 binding 不得覆盖引擎解析值。

## 目标

交付 preset→item 的 phase tree 生产入口、数组推进退役和 trigger 条件追加；复用 C01 scheduler，不另建遍历器。

item 被调度时展开为其 preset 声明的 phase 任务树（消费 #547 编译产物的树结构）：phase 数组推进退役为退化 seq，`afterPhase`/`whenStatus` trigger 迁移为状态条件化动态 spawn，phase 层与 chain 层由同一套树调度语义驱动。

## 预期结果

- item 展开：item 被调度时按其 preset 编译产物中的 phase 任务树展开，树的 leaf 才是 agent run；phase 层树与 chain 层树走同一套遍历/join/reopen 语义（性质：引擎调度代码无 phase 层专属的第二套推进机制）。
- 线性 preset 零回归：无树声明的 `[[phases]]` 数组编译为退化 seq，调度行为与现状一致（含退避、attempts、状态准入）。
- phase 层 par 真并发：声明 `seq(s1, par(s2a, s2b), s3)` 的 fixture preset 真跑时 s2a/s2b 执行区间重叠，join 后 s3 开始。
- trigger phase 迁移：`afterPhase`/`whenStatus` 语义映射为状态条件化动态 spawn——条件满足时向树内动态追加对应 phase 节点；`blocked → blocked_responder` 先例行为保持；映射细节（触发时点、追加位置、重复触发语义）为本 child 显式决策项，落地时裁并登记在本 issue。
- `nextNonTriggerPhaseForItem` 数组推进路径退役（被树遍历吸收）。
- **缺口③扩围处置**（2026-07-10 登记，源 #546 body「引擎递出面定理」节修订）：`evidenceDir` / `currentIssueFile`（item 级面）与 `SHARED_CONTEXT_FILE`（chain 级面）寿命长于任务，**纯 seq 下已是「生命周期 ⊆ 任务」反例**（同 item 先后 phase 两任务共享同一 evidenceDir——两任务，不止 phase 级 par 下）。#546 body 逐字快照：

  > "**缺口③（扩围）**：`evidenceDir`/`currentIssueFile`（item 级面）与 `SHARED_CONTEXT_FILE`（chain 级面）寿命都长于任务（`src/scheduler.ts:2205-2221`）——不止 phase 级 par 下共享，纯 seq 下已是「生命周期 ⊆ 任务」反例（同 item 先后 phase 两个任务共享同一 evidenceDir）。按定理口径逐面作用域化，归本 issue 落地时处置。"

  处置口径：按递出面定理（每个引擎递出面「任务私有 or 声明通道」）逐面作用域化——`evidenceDir` / `currentIssueFile` 作用域收紧至任务（`(item, phase)` 私有），`SHARED_CONTEXT_FILE` binding 随 #545 落地一并退役（缺口②，已归 #545）。具体作用域化机制（是否 per-任务子目录、如何在同 item 跨 phase 隔离而 retry 同任务共享）为本 child 决策项，落地时裁并登记在本 issue。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | phase 层 par 真并发（#546 行 1/2 phase 层） | fixture preset 声明 `seq(s1, par(s2a, s2b), s3)` 真跑，查两 run 时间区间与 s3 起点 | local | s2a/s2b 区间重叠；s3 在 par join 之后才 spawn |
| function | 线性 preset 退化等价 | `single-phase-example` 与线性多 phase fixture 真跑 | local | 推进顺序、退避、attempts、状态准入与迁移前一致 |
| function | trigger 迁移语义保持 | fixture 触发 `blocked` 状态 | local | `blocked_responder` 对应节点被动态追加并 spawn，行为与现状 trigger 等价 |
| function | 重复触发语义 | 同一 item 两次进入 whenStatus 条件（决策项裁定后具体化） | local | 行为与本 issue 登记的裁决一致，无未定义状态 |
| assumption | 单套调度语义 | `grep -n "nextNonTriggerPhaseForItem" src/` | local | 数组推进路径退役（符号删除或仅存迁移代码）；phase 推进由树遍历承载 |
| function | 缺口③作用域化（evidenceDir / currentIssueFile） | 声明 `seq(s1, s2)` 单 item 跑两 phase；对比两任务闭包看到的 `evidenceDir` 路径与 `currentIssueFile` 路径 | local | 两任务面互相不共享（作用域 ⊆ 任务，与递出面定理一致）；同任务 retry（闭包重开）同一路径可见 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #698、#700、#702；外部 #737、#739。
- Blocks: #707、#708、#709、#733、#744。




---

## Comments (2)

### comment #5055604104 by `RiriAgent` — 2026-07-23T07:23:41Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#706 承接 #567 preset phase tree + trigger 迁移）相对 baseline 的进度

- **已落地**: 无。baseline 里 phase 层调度仍是数组推进语义，未接入树遍历。
- **半成品**: 无。
- **未开始**: 本 issue 验收清单全部 — item 展开 preset phase 任务树、线性 preset 零回归、phase 层 par 真并发（`seq(s1, par(s2a, s2b), s3)` fixture）、trigger phase 迁移（`afterPhase` / `whenStatus` → 状态条件化动态 spawn）、`nextNonTriggerPhaseForItem` 数组推进退役、evidenceDir / currentIssueFile 作用域收紧到 `(item, phase)` 私有（缺口③扩围处置：同 item 先后 phase 两任务不再共享 evidenceDir）。

### 依赖

本 issue depends on **#698 + #700 + #702**（+ 外部 #737 / #739 / #554）。前置未落地时本 issue 无可用测试路径。

### iteration agent

从 baseline checkout，全部从零构建 phase 层树接入。PR base = `coder-loop/v3-546-baseline`。



### comment #5066045522 by `RiriAgent` — 2026-07-24T04:08:55Z

已创建对应的 BLOCKED draft 实现 PR：[PR #756](https://github.com/mouriya-s-lab/coder-loop/pull/756)。它从 [PR #755](https://github.com/mouriya-s-lab/coder-loop/pull/755) 收窄后的 #698 分支堆叠，只承载从 #755 拆出的 phase/trigger migration 实现；#700、#702、#737、#739 与外部 #554 等依赖满足前不进入合并。后续实现与 review 证据放在 PR #756。


---

## Timeline (20)

- 2026-07-17T20:13:34Z `assigned` @RiriAgent
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:33Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:06Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-17T20:38:56Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:39:05Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-23T07:23:41Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-24T04:08:55Z `commented` @RiriAgent
- 2026-07-26T16:14:02Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-27T04:26:59Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-27T04:27:10Z `cross-referenced` @RiriAgentsrc=737