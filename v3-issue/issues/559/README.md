# #559 feat(scheduler): v3 序/并任务树调度——seq 游标推进、par 真并发与 slot 退役

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:15:43Z  | updated: 2026-07-17T20:14:51Z
- closed: 2026-07-17T20:14:51Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/559
- comments: 2  | timeline events: 35

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）。继承条款逐字快照：

> "递归定义，嵌套深度不设限。「最多两层」不是代数约束，只是 bundled preset 的实际用法。" — #546 body「任务代数」

> "**slot 串行退役**：现行 `(chainId, repoCwd)` slot 内串行（`schedulerSlotKey`，`src/scheduler.ts:791`）的存在理由就是共享单份 worktree（per-slot 分支名，`src/scheduler.ts:813`）；公理落定后「谁能并行」完全由任务结构决定，资源键不再参与语义。" — #546 body「资源模型公理」

> "**并发上限退化为纯限流参数**：全局上限 + per-par 上限，参数归元数据声明（#396 契约），机制归引擎。" — #546 body「资源模型公理」

> "seq/par 是控制结构；`dependsOn` 是横跨结构的「start-after」数据约束……不进代数本体。现状机制原样保留：写入期查环（`src/daemon.ts:4647`）、全部依赖到 success 状态后恢复 entry（`src/scheduler.ts:1710`）。" — #546 body「dependsOn」

> "错误向上归 join 消化：子任务失败（exhausted 等非 success 终态）不自动传播。" — #546 body「取消与错误传播」

闭包生命周期与单活性（2026-07-10 修订，权威记录 `v3/closure-lifecycle-decision.md`）——本 child 的调度语义按此重写，逐字快照：

> "闭包 = 同一 (item, phase) attempt 链的执行环境：worktree + 引擎创建的工作分支 + session + per-task scratch。" — #546 body「资源模型公理」

> ```
> stateDiagram-v2
>   [*] --> active : create（首次打开：fetch base → 建 worktree 底座 → 引擎建闭包分支/par 下从 pin 派生）
>   active --> active : run-exit → run-spawn（attempt 链内；含中断 resume——同 worktree 同 session）
>   active --> suspended : suspend（只改变调度状态；环境原地保留）
>   suspended --> active : reopen（原闭包原地恢复调度）
>   active --> consumed : consume（控制流证明不可再 resume/reopen）
>   suspended --> consumed : consume（同上）
>   consumed --> [*] : 回收 worktree/分支 + 清 sessionIds + 发消费证据
> ```
> — #546 body「资源模型公理」

> "**单活性不变式**：每闭包同一时刻至多一个活 run（执法键 = 闭包；挂起态无活 run；par 只存在于闭包之间）；v2 由 slot 串行与 `current_runs` PK=chain_id 偶然保证，二者在 v3 均退役，由 #558/#559 显式重立。" — #546 body「资源模型公理」

> "**par 同 commit 派生**：par 展开/物化时引擎 pin base 尖端 commit 并持久化；成员子树共同启动入口任务集的闭包首次打开从 pin 派生（凝固点语义：后续追加复用同 pin）；嵌套 par 内层重新 pin；rationale = 并发代数语义不被调度时序引入副作用" — #546 body「供给条款」#4

## 目标

调度决策从「flat position 队列 + slot=(chainId, repoCwd) 串行」切换为任务树遍历：seq 依游标推进、par 打开期间成员真并发、任意深度嵌套、slot 语义退役、单活性执法键从「chain / slot」重立到「闭包」、par 展开时按供给条款 4 写入 pin。

## 使用场景

引擎调度核心。落地后 daemon 对同一 chain 同一 repo 的 par 成员真并发 spawn（现被 slot 串行封死）；operator 经元数据声明全局/per-par 并发上限做纯限流。join 评估、reopen、动态物化、chain 层声明都建立在本 child 的树遍历之上；闭包持久化 shape 由 #558 提供、转移执行机制由 #560 提供，本 child 只做调度决策（在决策时把「该 create / 该 reopen / 该 resume」落到 #560 的相应转移调用上）。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- `schedulerTick`（`src/scheduler.ts:425`）：对 active chain 逐个决策；`slot.activeRun !== null` 时跳过整个 slot（slot 内严格串行）。
- `selectNextItemAndPhase`（`src/scheduler.ts:554`）：flat `(position, id)` 选取；`schedulerSlotKey`（`src/scheduler.ts:791`）。
- dependsOn：写入期查环 `validateDependsOnGraph`（`src/daemon.ts:4647`）；恢复 `src/scheduler.ts:1705-1748`（全部依赖 success 后恢复 entry 并清 dependsOn 记录）。
- 并发上限现状：无总上限；仅 #478 限流网关 `limits.maxSpawns` 与 staggered resume。`DEFAULT_MAX_ITEM_ATTEMPTS = 20`（`src/scheduler.ts:385`）是引擎机制默认值先例。
- 退避：`itemSchedulerBackoff`（`src/scheduler.ts:699` 消费点），失败 run 指数退避——树调度必须保持 per-leaf 退避语义。
- 闭包状态表（活/挂/终 + worktree 路径、闭包分支、sessionIds、par pin commit）持久化 shape 归 #558；转移执行（create/suspend/reopen/consume 六步机制）归 #560——本 child 在调度时**查表决策 + 触发转移**，不实现转移本体、不直接写状态表。
- item 内 phase 推进（`nextNonTriggerPhaseForItem`，`src/scheduler.ts:604`）**本 child 不动**：phase 层树接入是后续 child（消费 #547 DSL），本 child 只动 chain 层与容器调度；item 在树中是 leaf，其内部 phase 数组推进维持现状。

## 问题

slot=(chainId, repoCwd) 内严格串行使同 repo 的 par 成员物理上不可能并发——#546 关闭验证行 2（par 真并发）在现调度器下恒不可满足；调度只认 flat 队列，无容器节点、无 seq 游标，嵌套结构（行 1）无法推进；无 per-par 限流参数位；单活性在 v2 由 slot 串行与 `current_runs` PK=chain_id 偶然保证（`src/scheduler.ts:791`、`current_runs` 表），这两个偶然保证在 slot 退役与树调度落地后同时消失——单活性需按新执法键（闭包）显式重立；par 展开缺 pin 写入点，供给条款 4「pin base 尖端 commit 并持久化」无着落。

## 预期结果

- 调度决策唯一来源是任务树结构：seq 按游标依序推进；par 打开期间全部未终结成员可并发 spawn；嵌套任意深度按代数语义推进（性质：对任何 well-formed 树，每个 tick 的可 spawn 集 = 树语义允许的就绪 leaf 集，与资源键无关）。
- **spawn 一个 leaf = 查闭包状态表决策动作**（对照 #558 shape）：
  - 无闭包记录 → 触发 #560 的 create 转移；
  - 闭包记录为 suspended → 触发 #560 的 reopen 转移；
  - 闭包记录为 active 且当前无活 run → 触发 #560 的 resume 路径（同 worktree、同 session，attempt 链内继续）；
  - 闭包记录为 active 且已有活 run → 违反单活性，本 tick 不 spawn（下一 tick 由 run-exit 事件驱动）；
  - 闭包记录为 consumed → 该 leaf 不再可 spawn（终态既落）。
  本 child 只做决策与派发，机制本体归 #560；调度侧不重复实现闭包转移。
- drain join 的**结构性放行**随树遍历落地：par 全部成员 terminal 即容器 terminal、外层 seq 推进（drain 是代数的退化 join，无判定通道即可放行）；validator/hold 判定通道归 #561（join 评估）——本 child 落地后未声明 validator 的 par 全链路可跑通。
- **slot 串行语义退役**：`schedulerSlotKey` 不再参与调度决策；同 chain 同 repoCwd 的 par 成员执行区间可重叠。退役 rationale 更新——「共享单份 worktree」的存在理由消失，v3 每闭包一份 worktree，资源键（chainId, repoCwd）与「谁能并行」解耦。
- **单活性执法（新执法键 = 闭包）**：v2 偶然保证的两根柱子（slot 串行、`current_runs` PK=chain_id）随 slot 退役与树调度落地同时消失，本 child 在调度路径按新键显式重立——每次 spawn 决策前查该 leaf 对应闭包是否已有活 run，命中即拒绝第二个 run 并留可审计事件；表征形态（`current_runs` PK 换 closure id 还是别的形态）跟随 #558 shape，本 child 消费；挂起态闭包对应 leaf 决策路径不 spawn（走 reopen 而非新 create）。
- **par 展开时 pin 写入**：调度器识别到某 par 节点进入「展开」状态（即将 spawn 其成员入口任务集）时，先 pin base 尖端 commit——存储位与字段归 #558 shape，本 child 在调度路径承接**写入动作**并保证「pin 先落库、成员闭包 create 后读同一 pin」的时序（避免调度时序引入副作用）；嵌套 par 内层 par 展开时同样重新 pin（内层 par 有自己的 pin，独立于外层）；运行中追加成员时**不**重 pin（凝固点语义，追加复用同 pin——由 #563（动态物化）在追加路径消费）；本 child 只负责首次展开路径的 pin 写入与内层重 pin 语义。
- 并发上限 = 纯限流参数：全局上限与 per-par 上限的值取自元数据声明；未声明全局上限 = 不限（现状语义延续）；引擎不驻留业务上限数值。
- dependsOn 与树正交：par 成员携带跨结构 dependsOn 照常被 gate、全依赖 success 后恢复；写入期查环行为不变。
- 子任务失败不自动向上传播：非 success 终态成员不使容器/祖先失败，容器处置归 join 评估（后续 child）；本 child 保证失败 leaf 的退避/attempts 语义在树下不回归。
- v2 线性链（退化 seq 树）调度行为零回归。

## 不应残留

- 本 child 范围内：`schedulerSlotKey` 或任何资源键参与「谁能并行」判定；「每 chain 单活 run」假设的读写点（`current_runs` PK=chain_id 的语义位）；引擎内并发上限业务数值；spawn 路径直接写闭包状态（应经 #560 转移调用）。
- 本 issue 范围之外不应改动：不动 item 内 phase 数组推进与 trigger phase（归 #567（phase 树接入））；不实现 join 评估/reopen/物化/取消（归各自 child）；不实现闭包转移本体（create/suspend/reopen/consume 机制归 #560，本 child 消费其转移调用）；不定义闭包状态表 shape（归 #558）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535（spawn 流水线错误收容，直接同面）/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | par 真并发（#546 行 2） | 构造 par 内 2 item（同 chain 同 repoCwd）的树，daemon 调度后查 runs 表两 run 的 `started_at`/`ended_at` | local | 执行区间重叠（真并发，非串行） |
| function | 嵌套深度推进（#546 行 1 调度半边） | 构造 `seq(leaf, par(leaf, par(leaf, leaf)))` 树真跑 | local | 嵌套结构按代数语义推进到全树 terminal |
| function | spawn 派发按闭包状态决策 | 分别构造三态触发场景：新 leaf（无闭包记录）、已挂起 leaf 被重新调度（suspended）、活跃闭包中断后 tick（active/无活 run） | local | 三种场景分别触发 #560 的 create / reopen / resume 转移调用；调度决策不直接写闭包状态 |
| function | 单活性执法（执法键 = 闭包） | 对已有活 run 的闭包再次触发 spawn 决策；对同 leaf 挂起态触发调度 | local | 第二个活 run 被拒 + 审计事件；挂起态走 reopen 分支不走 create |
| function | par 展开 pin 写入（供给条款 4） | 首次展开含 ≥2 成员的 par；嵌套 par 内层展开 | local | 展开前 pin base 尖端 commit 落库（存储位随 #558）；成员闭包 create 后底座 commit = 该 pin；内层 par 独立重新 pin |
| function | per-par 上限限流 | par 内 3 成员 + 元数据声明 per-par 上限 2，观察活 run 数 | local | 任意时刻该容器活 run ≤ 2，全部成员最终完成 |
| function | 全局上限限流 | 元数据声明全局上限 1 + 两 chain 各一就绪 item | local | 任意时刻全 daemon 活 run ≤ 1；未声明时行为不限（现状延续） |
| function | dependsOn 正交（#546 行 8） | par 成员携带跨结构 dependsOn 真跑；另写入含环的 dependsOn | local | 约束边与并行结构独立生效（先 gate 后恢复 entry）；环在写入期被拒 |
| function | 失败不上溯 | par 内一成员耗尽 attempts 落 exhausted，其余成员正常 | local | 其余成员照常执行完成；容器与祖先不因此失败 |
| assumption | slot 退役（#546 行 10 切片） | `grep -n "schedulerSlotKey" src/scheduler.ts src/daemon.ts` | local | 无调度决策路径引用（符号删除或仅存于迁移/清理代码） |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #558（任务树 + 闭包状态表运行态 shape，本树地基）——树遍历与闭包状态查表读写其持久化形态；#560（闭包转移机制：create/suspend/reopen/consume 六步执行本体）——本 child 的 spawn 决策把「该 create / 该 reopen / 该 resume / 该 consume」派发到 #560 提供的转移调用，机制不重复实现。
- Blocks: #561（join 评估）、#562（reopen 执行）、#563（动态物化）、#565（取消）、#566（chain 层声明位）、#567（phase 树接入）。
- Relates to: #554（phase 树声明面——DSL 演进面第 5 项装载期检查清单含静态 `dependsOn` 查环，#546 行 8「装载期被拒」半边的证据来源）。


---

## Comments (2)

### comment #4865332560 by `RiriAgent` — 2026-07-02T11:46:53Z

范围补充（#546 树对抗审查第二轮，调用面全集扫描，2026-07-02）：**「leaf 事后重激活」类语义缺口**，本 child 落地时必须裁并登记。

现状存在两条把 terminal item 恢复为 continuable（entry status）的通道，都绕过 join/reopen 机制：

1. **`queue.unblock`**（operator 驱动）：`handleQueueUnblock`（`src/daemon.ts:2069-2112`）把 unblockable-terminal item 恢复到 preset entry status，`hard-deny-for-agent`、operator-only。
2. **dependsOn 满足恢复**（engine 驱动）：`src/scheduler.ts:1705-1748`——terminal item 的全部 dependsOn 目标到 success 后自动恢复 entry。

树调度下的未定义交互：被恢复的 leaf 若位于**已放行（advance/drain 通过）的 par 容器**或**seq 游标已越过的位置**，祖先视图如何一致——候选语义（本 child 决策项，不预钉）：(a) 重激活级联重开祖先（对齐 #562 reopen 的游标回退语义）；(b) 对已放行容器内成员拒绝恢复（错误点名原因）；(c) 允许 leaf 重跑但容器状态不变——注意 (c) 会造成「容器 terminal 而成员 active」的视图分裂，若选它须写明快照如何呈现。

两条通道必须落同一语义（它们是同一类事件的 operator/engine 两个触发源），裁决写回本 issue 并同步 #561（若裁 (a)，重激活即一个 join 重评估/reopen 触发点）与 #558（若容器状态可被重激活改变，shape 的容器状态机须可表示）。

验收补充行（裁决后具体化）：对已放行容器内成员分别经 `queue unblock` 与 dependsOn 满足触发恢复 → 行为与登记裁决一致、树快照无未定义状态。



### comment #5007117124 by `RiriAgent` — 2026-07-17T20:14:51Z

重新拆分后由 #698 承接生产入口与 seq/par drain 调度；原 issue comment 中尚未裁决的 leaf 重激活语义由 #701 明确承接。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (35)

- 2026-07-02T11:15:44Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:21Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-02T11:18:23Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-02T11:18:25Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-02T11:18:28Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:03Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T11:46:53Z `commented` @RiriAgent
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:04:23Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-10T05:56:41Z `cross-referenced` @RiriAgentsrc=602
- 2026-07-10T05:59:58Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-15T00:56:12Z `referenced` @RiriAgentcommit=a476e18668ab5ebd3debcfeeaf3a749a219b4126
- 2026-07-16T00:49:13Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-16T08:23:00Z `cross-referenced` @RiriAgentsrc=690
- 2026-07-17T20:13:14Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:13:16Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:21Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:13:25Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:51Z `commented` @RiriAgent
- 2026-07-17T20:14:52Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:36Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:37:46Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-18T01:17:08Z `cross-referenced` @RiriAgentsrc=749