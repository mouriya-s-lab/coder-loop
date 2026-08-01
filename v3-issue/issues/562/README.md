# #562 feat(engine): reopen 执行语义——纠正追加、seq 游标回退、级联再验证与预算耗尽

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:15:50Z  | updated: 2026-07-17T20:14:56Z
- closed: 2026-07-17T20:14:56Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/562
- comments: 1  | timeline events: 25

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）。统一判定契约唯一权威文本在 #546 body「join 策略与验证者判定」节（本 child 与 #543 children 引用同一文本，不复制不改写），其中 reopen 分支：

> ```
> | reopen(target, correctionItemIds) -- 退回并精确引用已创建的纠正 item
>   target      ::= self | 同一 seq 内更早的兄弟节点
>   correctionItemIds ::= 同 evaluation scope 下先经 CLI 创建、属于 target 的 item stable id，≥1
> ```

继承条款逐字快照：

> "**reopen 零状态重置**：已 terminal 的 item 保持 terminal；纠正 item 追加进 target，target 重开，seq 游标回退到 target。副作用（PR/commit/comment）append-only，新一轮可见。「零状态重置」指不回滚任何已记账状态，不指丢弃执行现场——target 的任务闭包按持久对象从挂起态重开（同 worktree 路径、checkout 闭包分支尖端、resume session），现场完整。先例：`gh-issue-pr-iteration` 的 `changes_requested` 重试即此模式——retry 从来是状态转移 + 追加工作，不是回滚。" — #546 body（2026-07-10 修订）

> "**级联再验证**：seq(A,B,C) 中 C 的验证者 reopen A 后，seq 再次途经 B——drain 且无新工作瞬时通过，validator 重新裁决。不需要「跳过未受影响节点」机制。" — #546 body

> "**reopen 预算**：容器带 reopen 上限（类比 `maxItemAttempts`），耗尽时引擎写容器级 exhausted 终态。预算值归 preset/chain 元数据，机制归引擎。" — #546 body

> "**target 静态可检查**：只能指向 self 或同 seq 更早兄弟——不能指向未跑节点、不能跨出所在 seq 作用域；装载期校验（RFC-2 接缝）。" — #546 body

闭包生命周期（操作员裁决 2026-07-10，权威记录 `v3/closure-lifecycle-decision.md`）：

> "**重开是原闭包原地恢复调度**：suspend 零 GC，worktree/分支/index/未提交文件/session/scratch 始终保留；reopen 只把同一闭包切回 active。"

## 目标

`reopen(target, correctionItemIds)` 判定的执行机制：精确引用同 evaluation scope 下先经 CLI 创建的纠正 item，并在消费时校验/认领到 target、target 内已挂起任务闭包重开（闭包生命周期 suspended → active 转移）、seq 游标回退、零状态重置、级联再验证、reopen 预算耗尽落容器级 exhausted。

## 使用场景

「退回上一步」的 v3 形态（#413 退回语义的替代）。验证者判定某并行批次结果不合格时先经带 evaluation scope 的 CLI 创建 corrections，再写 `reopen(target, correctionItemIds)`：引擎校验并认领这些既存 item 到 target 容器、target 内被打回任务的闭包重开（agent 醒在原 worktree、原分支、原 session，上一轮 WIP 与 PR 延续——PR headRef 即闭包分支，第二轮推同一 PR）、游标退回；纠正工作跑完后 seq 再次途经后续节点级联再验证；反复退回超预算时容器落 exhausted，链不死锁。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- 先例 `changes_requested` 重试：retry 状态（continuable）+ 追加评论/工作，item 级「状态转移 + 追加」模式（`presets/gh-issue-pr-iteration/preset.toml` statuses/exits）——v2 靠同 worktree 残留现场偶然成立，v3 由闭包重开显式承载。
- `maxItemAttempts` 先例：值经 chain metadata（`maxItemAttemptsFromChainMetadata`，`src/runtime-data.ts`）、引擎 fallback `DEFAULT_MAX_ITEM_ATTEMPTS = 20`（`src/scheduler.ts:385`）；exhausted 终态字面量由 preset `[statuses].exhausted` 声明、引擎写入（`src/scheduler.ts:1966` 附近消费）。
- item 追加面：`store.createItems` + `createItems` right（`src/daemon.ts:3364-3435`）。
- 判定接收/派发归 #561（join 评估）；seq 游标、容器状态与闭包状态表归 #558（树运行态 shape）；闭包重开的机制本体（原闭包原地恢复 active）归 #560——本 child 在 reopen 执行时**调用**该转移，不重复实现。

## 问题

引擎无任何容器级回退机制：无游标回退、无纠正追加通道、无容器级预算；#413 开放问题「退回时状态重置与副作用」已由 #546 裁为零状态重置，但机制不存在——#546 行 5（reopen 语义）与行 6（预算耗尽不死锁）无处成立。且 v2 下打回重入的现场延续靠 slot 共享 worktree 偶然成立，slot 退役后若 reopen 走「新建环境」路径，上一轮 WIP、session、PR headRef 全部断裂。

## 预期结果

- reopen 执行的性质（六步，单事务见原子性条款）：① 校验 decision 引用的 corrections（≥1）均是同 evaluation scope 先经 CLI 创建、尚未被其他 decision 认领且属于 target 的既存纠正 item，并在本次消费中原子认领；每个纠正 item 的闭包已按 create 路径建立（par 内从 pin 派生）；② target 内被打回任务的闭包从 suspended 重开（经 #560 转移：原闭包原地恢复 active）；③ 所在 seq 游标回退到 target；④ reopen 计数递增；⑤ 判定消费完成标记落地；⑥ 审计事件。**已 terminal 的 item 状态不变**（零状态重置——不回滚记账，不丢现场）；副作用 append-only，新一轮可见。
- **闭包连续性**：target 重开前后，worktree 路径、闭包分支、PR headRef、该 phase `sessionIds` 全部不变——第二轮工作落在同一分支同一 PR，不产生平行分支/平行 PR。
- 级联再验证：游标回退后 seq 再次途经中间节点——drain 且无新工作瞬时通过；validator 重新裁决。不实现「跳过未受影响节点」。
- target 运行期校验：仅 self 或同一 seq 内更早兄弟合法；指向未跑节点、跨 seq 作用域的 reopen 被拒 + 审计事件（装载期静态校验归 #547 编译面，运行期校验是引擎自有防线——判定值运行时到达，装载期检查覆盖不了）。
- reopen 预算：容器级上限，值取自 preset/chain 元数据；耗尽后再收到 reopen 时引擎写容器级 exhausted 终态（item terminal 不自动 consume 闭包；GC 仍等待 #560 消费谓词），外层按失败终态归 join 消化，链不死锁。
- **reopen 执行原子性**（操作员裁决 2026-07-10，边界 4 审查）：既存 correction IDs 的校验/认领、target 重开 + seq 游标回退、预算递增，与判定消费完成标记（script kind 下即 #599 评估状态的 `consumed`）在单个状态存储事务内落地——daemon 在执行中途崩溃时恢复后要么整体重执行、要么已整体完成，不存在游标已回退但预算未记（或反之）的中间态。reopen 没有物理重建；事务只落定闭包态与控制流效果，既存 worktree 不参与该事务。
- reopen budget 是显式可选参数；未声明 = 不限。引擎不得驻留默认 reopen 次数或用任意 hard cap 代替声明。声明了预算时，耗尽语义按上文执行；未声明时，停止条件只能来自显式 decision/外层取消，不由引擎猜测。

## 不应残留

- 本 child 范围内：任何状态重置/回滚路径（terminal item 被改回非 terminal）；target 重开走新建 worktree/新分支/新 session 路径（闭包连续性断裂）；任何 suspend 上的现场搬运、stash、commit、删除或重建（环境必须原地保留）；引擎源码驻留 reopen 预算业务数值；「跳过未受影响节点」机制。
- 本 issue 范围之外不应改动：不动判定接收通道与 hold（归 #561（join 评估））；不动闭包挂起/重开机制本体（归 #560）；不动装载期 target 静态校验（归 #547）；不动 chain-complete（归 #566（chain 层声明位））。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | reopen 完整行为（#546 行 5） | seq(A, B, C)，C 处 validator 先经带 evaluation scope 的 CLI 创建 correction item `fix-1`，再写 `reopen(target=A, correctionItemIds=["fix-1"])`，真跑观察事件序列与 items | local | 纠正 item 追加进 A（新闭包 create）、A 重开、seq 游标回退到 A、已 terminal item 状态全部不变 |
| function | 闭包连续性（#546 行 7 切片） | 上一行中比对 target 被打回任务 reopen 前（挂起时）与 reopen 后的闭包元数据与 GitHub 面 | local | worktree 路径、闭包分支、PR headRef、该 phase sessionIds 全部不变；第二轮 commit 落同一 PR；挂起期 WIP 在重开后可见 |
| function | 级联再验证（#546 行 5） | 首行场景继续跑完 | local | 途经 B 时 drain 无新工作瞬时通过（或 validator 重新裁决），事件序列可证 |
| function | 非法 target 被拒 | validator 分别写 target=未跑节点、target=跨 seq 节点 | local | 均被拒 + 审计事件；容器状态不变 |
| function | 预算耗尽（#546 行 6） | 容器声明 reopen 预算 1，validator 连续两次 reopen | local | 第二次时引擎写容器级 exhausted；闭包环境继续保留，直到 #560 消费谓词成立后才 GC；链不死锁 |
| assumption | 预算值不驻留引擎（#546 行 10 切片） | 用未声明预算与显式预算 1 两个 fixture 真跑，并 grep 默认值定义 | local | 未声明时不限；显式预算 1 时第二次 reopen exhausted；引擎无默认 reopen 次数 |
| function | reopen 执行原子性 | correction 已经由 CLI 创建后，提交引用其精确 ID 的 reopen；配合 daemon kill -9 于消费时机真跑 | local | correction 的校验/认领、重开态转移、游标、预算、消费标记同时在场或同时缺席；先前 CLI 创建记录独立存在且不会重复；恢复后不重复计预算 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #561（join 评估，判定接收与派发通道）；#560（闭包挂起/重开转移机制——本 child 调用不实现）。
- Blocks: #566（chain 层声明位）——顶层 join 的 reopen 依赖本机制。
- Relates to: #599（评估代次与幂等协议——script kind 的消费标记与本 child 各步的同事务性协调）；#554（phase 树声明面——DSL 演进面第 3 项 reopen target 静态可检引用与第 5 项装载期检查清单）。


---

## Comments (1)

### comment #5007117645 by `RiriAgent` — 2026-07-17T20:14:55Z

重新拆分后由 #701 承接 reopen、纠正项与 leaf 重激活一致语义。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (25)

- 2026-07-02T11:15:52Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:21Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-02T11:18:27Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:07Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-10T11:17:17Z `cross-referenced` @RiriAgentsrc=604
- 2026-07-15T06:26:45Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-16T03:23:47Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-16T08:23:00Z `cross-referenced` @RiriAgentsrc=690
- 2026-07-17T20:13:16Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:21Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:14:55Z `commented` @RiriAgent
- 2026-07-17T20:14:56Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-18T01:17:08Z `cross-referenced` @RiriAgentsrc=749