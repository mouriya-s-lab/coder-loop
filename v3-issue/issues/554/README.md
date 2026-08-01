# #554 phase 任务树声明面：seq/par 递归结构、join ADT 与装载期检查

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:31Z  | updated: 2026-07-17T20:41:56Z
- closed: 2026-07-17T20:41:56Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/554
- comments: 2  | timeline events: 24

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其「DSL 演进面」第 1–6 项，逐字快照：

> "1. **phase 任务树声明**：`[[phases]]` 线性数组演进为可声明递归 seq/par 结构；每个可引用节点有稳定显式 id；join 策略字段为封闭 ADT。#554 基础阶段只落 `drain | validator`；本轮 v3 的 #592 在语义、持久化、观测投影和所有消费点齐备时一次加入 `script`，v3 关闭终态为 `drain | validator | script`；`best-of-n` 仍是未来演进方向。
> 2. **validator 的 item 调用声明**：preset 引用 + 变量绑定，复用三前缀绑定 DSL。
> 3. **reopen target 静态可检引用**：`self | 同 seq 更早兄弟`，装载期校验。
> 4. **per-par 并发上限与 reopen 预算声明位**：参数归元数据、机制归引擎（#396 契约）。
> 5. **装载期检查清单**：树 well-formedness、reopen target 合法性、join 声明完备性、静态 `dependsOn` 查环——并入编译管线，与 #408 既有两规则同层。
> 6. **编译产物含任务树结构**（供 #544 渲染）。" — #547 核心设计·DSL 演进面

代数语义的权威定义（声明面复述其词表，不重定义语义）：

> "`task ::= leaf | seq(task…) | par(task…, join)`" ... "join 是封闭 ADT，union 只含语义、持久化、观测投影与全部穷尽消费点同时落地的 variant；`script`（RFC-4 hook 判定器）由本轮 v3 child #592 按该准入纪律加入 union，并一次落齐持久化、status/events 投影与全部穷尽消费点；`best-of-n`（并行 N 取一）仍是未来方向。" — #546 核心模型·任务代数

分工边界逐字快照：

> "代数语义、调度、reopen 机制归 #546，声明面与装载期校验归本 RFC" — #547 接口假设·答复 #546

## 目标

DSL 可声明递归 seq/par phase 任务树（含稳定节点 identity、join ADT、validator 调用、reopen target 引用、per-par 参数位、join 候选具名声明位），装载期完成全部结构检查，编译产物携带任务树结构与 identity。

## 使用场景

- bundled preset 未来的「iter 三阶段两并行」（`v3/v3-goals.md` 目标 4）可以纯 meta 声明——该业务重构本身由 #604 承接，本 child 提供其声明位。
- preset 作者写错树（reopen target 指向未跑节点、par 缺 join、dependsOn 静态环）在 compile 当场报错，不用等运行期死锁。
- #544 GUI 从编译产物直接渲染任务树结构图。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- 现状 `[[phases]]` 是线性数组（arktype boundary `src/loop.ts:460-488`）；推进是数组顺序（`nextNonTriggerPhaseForItem`，`src/scheduler.ts:604`）——调度语义的改造归 #546 children，本 child 不动 scheduler。
- 装载期检查同层先例：`checkPresetDag`（`src/preset-dag-check.ts`，#408 两规则 R2 error / R3 warn，findings 经编译管线冒泡）。
- `dependsOn` 既有写入期查环（`src/daemon.ts:4657`）——本 child 增加**静态声明部分**的装载期查环（#546："静态声明部分增加装载期查环（RFC-2 接缝）"），运行期动态 dependsOn 查环不动。
- 三前缀绑定 DSL（`PresetVariableSource`，`src/loop.ts:539-548`）——validator 的 item 调用声明复用之。
- 编译产物侧：编译管线 child 已钉 phases 块的退化线性 seq 树 shape——本 child 非退化真实化。
- **phase 树声明面不含 worktree/分支/起点/pin 声明位**（#546 body「资源模型公理·供给条款」节 + 权威记录 `v3/closure-lifecycle-decision.md` §3）：供给条款五条全部是引擎原生行为（结构性 git 操作归引擎程序化）——起点解析（按 `chain.baseBranch` 创建时刻快照）、闭包分支创建与命名、par pin 的钉入/复用、回收与终态采样均不进 DSL；本 child 的树结构、join、reopen target、per-par 参数（并发上限、reopen 预算）声明面不包含分支名、起点 ref、pin commit 或 worktree 路径的任何声明位。同一刀法的 chain 层切片见 #547「答复 #546」节的供给条款登记（`chain.baseBranch` 是唯一相关声明位，归 chain metadata 而非 preset）。

## 问题

> "「零原语纯 meta 定义」……纯 meta 定义'三阶段两并行 + 强制 CLI 工具调用'需要 DSL 增加什么表达力——从 RFC-1 拿并行结构需求清单" — `v3/rfc-split.md` RFC-2 议题 2

#546 登记的八项表达力需求中，第 1–6 项是并行结构基础，第 8 项是具名 join 候选声明位；当前 DSL 均无法表达：线性数组连「两个 phase 并行」都写不出来，更没有 join、reopen target、并发上限或候选注册位。第 7 项具名 gate 点由 #555 承接。

## 预期结果

性质表述：

1. **递归可声明且 identity 稳定**：seq/par 任意嵌套深度可声明；每个可引用节点具有 preset 内稳定显式 id。compile 输出、SQLite、status/events 沿同一 identity 链关联；移动节点导致结构路径变化时 identity 不变。存量线性数组 normalize 为退化 seq，不保留第二套 parse 后模型。
2. **join 是封闭 ADT**：当前仅 `drain | validator` 两个有完整语义的 variant；TS 侧穷尽 switch。本 child 交付时 union 只有 `drain | validator`；本轮 v3 的 #592 随后把 `script` 连同语义、持久化、观测投影和全部消费点一次加入，`best-of-n` 仍只登记未来方向。validator 携带 typed workflow invocation，不用自由字符串拼调用。
3. **非法结构活不过装载期**：树 well-formedness（空 par、重复 phase 名、悬空引用）、reopen target 合法性（只能 `self | 同 seq 更早兄弟`）、join 声明完备性（par 必有 join；validator 必有调用声明）、静态 `dependsOn` 环——全部是编译 error findings，与 #408 同层同形态；错误点名违规节点。
4. **参数归元数据**：per-par 并发上限与 reopen 预算是声明位 + 编译期类型/范围校验；消费机制归 #546 children（#396 机制/参数分离契约）。
5. **产物真实化**：编译产物 phases 块任务树结构非退化——嵌套 seq/par 树可被 `jq` 遍历（#544 渲染的输入）。
6. **过渡期不静默错跑**：scheduler 对新结构的消费归 #546 children；在其落地前，含非退化 par 的编译产物被调度侧点名拒绝（错误指明「par 调度尚未落地」）——不做退化串行执行（会错跑 validator join 语义）、不做可忽略的 warn。本 child 触 scheduler 仅限这一道 guard。
7. **join 候选具名声明位**（`v3/join-evolution-decision.md` 不变量 7 的编译面；操作员裁决 2026-07-11）：preset 可声明具名 join 候选（validator 调用声明的具名注册，形态同预期结果 2 的 typed workflow invocation），编译产物携带候选表（每候选稳定 id）。运行时进入 join 位的值只能引用该候选表——#563 物化诞生时 join 参数与 #564 演化通道的值域即 `(definitionRef, candidateId)`，其中 `definitionRef` 为 #605 的 tagged `ExecutionDefinitionRef = preset | chain`，运行时不接受自由构造的调用声明。装载期校验：候选自身完备性（同预期结果 3 的 validator 完备性规则）；树内 join 声明与候选引用的悬空检查。

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- seq/par 在 TOML 的具体语法形态（嵌套内联表 vs 引用式节点表）。

## 不应残留

- 本 child 范围内：不留「树声明与线性数组两套 parse 后模型」——parse 后统一为一棵树（线性 = 退化 seq），下游只见树。
- 范围之外不动：scheduler 推进逻辑（`src/scheduler.ts:604` 区段）、join 评估、reopen 执行、worktree 语义（全归 #546 children；本 child 对 scheduler 的唯一改动是「非退化 par 点名拒绝」guard）；bundled preset 的三阶段重构（#604）。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 代数词表（leaf/seq/par、drain/validator、advance/hold/reopen）以 #546 body 为权威——声明面引用不改写；词表变更回 RFC 层重裁。
- 编译产物 shape 变更走 `schemaVersion`，PR body 列 shape diff。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 嵌套树可声明可导出 | fixture preset 声明 seq 内嵌 par（含 validator join + 调用声明）→ `preset compile --json \| jq` 遍历树 | local | 编译通过；产物树结构与声明同构 |
| function | reopen target 静态校验 | fixture 声明指向「未跑到的后位兄弟」/「跨 seq 节点」的 reopen target → compile | local | 编译错误点名非法引用与规则 |
| function | join 完备性 | fixture par 缺 join / validator 缺调用声明 → compile | local | 编译错误点名 |
| function | 静态 dependsOn 查环 | fixture 声明静态环 → compile | local | 编译错误点名环路径 |
| function | 参数声明位 | fixture 声明 per-par 并发上限与 reopen 预算（含非法值如负数）→ compile | local | 合法值入产物；非法值编译错误 |
| function | 过渡期 guard | 含非退化 par 的 fixture preset 建 chain 并启 daemon 调度 | local | 调度侧点名拒绝（错误指明 par 调度尚未落地），不串行执行、链不静默卡死 |
| integration | 存量 preset 零改动兼容 | `bun test`（全量既有 preset 加载用例）+ 对 bundled preset `preset compile` | local | 全绿；线性数组呈现为退化 seq 树 |
| integration | identity 跨层连续 | 编译嵌套树、持久化运行态、读取 status/events，再移动一个不改 id 的节点重编译 | local | compile/SQLite/status/events 可按 id 关联；路径变化不制造新身份 |
| function | 空预留 variant 禁止 | 枚举 join union 并检查每个 variant 的 scheduler/persistence/status consumer | local | union 中只有完整实现的 variant，无 best-of-n/script 占位 |
| function | join 候选声明位（预期结果 7） | fixture 声明具名候选 → `preset compile --json \| jq` 读候选表；另一 fixture 声明不完备候选（缺调用声明）→ compile | local | 产物含候选表（稳定 id + typed invocation）；不完备候选编译错误点名 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #549（编译管线 child）（产物树 shape 基线与 findings 通道）。
- 被消费：#559（树调度）、#561（join 评估）、#562（reopen 执行）、#563（动态物化——诞生时 join 参数消费候选表）、#564（物化容器判定权演化——演化值域消费候选表）、#565（取消）、#566（chain 层声明位）、#567（phase 树接入）——#546 实现 children 消费本声明面。
- Blocks（弱）: #604（bundled preset「iter 三阶段两并行」与闭包分支契约迁移）。


---

## Comments (2)

### comment #4865082338 by `RiriAgent` — 2026-07-02T11:14:40Z

## 架构切片

1. **系统定位**：编译管线的结构校验级——任务树 parse + well-formedness 检查，与 #408 `checkPresetDag` 同层；产物 phases 块的树结构投影。调度消费归 #546 children，本 child 在 scheduler 侧仅一道「非退化 par 点名拒绝」guard。
2. **全局坐标**：TOML 树声明域 → typed task tree ADT（封闭 join union）→ 编译产物树投影（#544 渲染输入）。#546 的调度语义域消费同一棵内存树。
3. **类型↔值不漂移**：防值漂移——产物树与内存树同源（一次 parse，两个投影）；防类型泄露——join/reopen 的**语义**不进声明面类型（声明面只知道词表与引用合法性，不知道调度行为）。
4. **消除的错误类别**：「非法树（悬空 reopen target、缺 join、静态 dependsOn 环）活到运行期死锁」不可表达；「par 语义未落地时静默串行错跑」不可表达（guard）。

## log/观测义务

- 新增结构校验的 error/warn 进 compile findings 通道（与 #408 同形态）。
- scheduler guard 拒绝沿既有 scheduler diagnostic 事件形态记录，点名 preset 与 par 节点。



### comment #5007304203 by `RiriAgent` — 2026-07-17T20:41:56Z

重新拆分后由 #739 承接，并把生产 runtime identity 验收后置到 #744。旧 issue 无关联 PR，关闭。


---

## Timeline (24)

- 2026-07-02T11:12:32Z `assigned` @RiriAgent
- 2026-07-02T11:13:09Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:40Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-05T07:47:09Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-05T07:47:21Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-05T07:47:49Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-05T07:48:16Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-05T07:52:00Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-10T17:18:34Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-10T17:21:26Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-10T17:23:11Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-10T17:27:31Z `referenced` @RiriAgentcommit=a720d74f93ef04080c001cf0fec1202db9e450b5
- 2026-07-11T06:42:47Z `cross-referenced` @RiriAgentsrc=604
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:41:56Z `commented` @RiriAgent
- 2026-07-17T20:41:57Z `closed` @RiriAgentcommit=None
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756