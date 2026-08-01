# SYNTH-#543 v3 生命周期 hook、可观测性与 gate 执行

> 本文档是**本地合成**，未写回 GitHub。依据 RFC #543 与其全部 sub-issue 合并而成。
> 来源：`v3-issue/issues/<N>/`（issue.json + comments.json + timeline.json + subissues.json）+ `v3-issue/design/`。

## 范围与组成

- **源 RFC**：#543 — RFC: v3 生命周期 hook——引擎扩展点与用户态 gate
- **子 issue 总数**：15（OPEN 6 / CLOSED·COMPLETED 1 / CLOSED·NOT_PLANNED 8）
- **本合成 issue 编号**：`SYNTH-#543`（仅本地标识）

---

## 一、RFC 设计骨架（#543 原文）

## 摘要

v3 生命周期 hook：引擎在生命周期事件与调度决策点上提供可挂脚本的扩展点，元数据全量传入；hook 通过调用 `coder-loop` CLI 操作队列（插队、重排、改状态），gate 型 hook 可 hold 住调度决策直到判定返回。gate 策略本身（查什么、何时插队、插什么）归使用者设计，引擎只提供接口和能力。

本 RFC 是 v3 RFC 树的一员（拆分依据 `v3/rfc-split.md`，2026-07-02 总控裁定），承接 v3 目标 5。设计裁决已由操作员在本 RFC 子会话（2026-07-02）逐项完成，见「设计裁决」节。

## 操作员目标（verbatim，2026-07-02）

> "我希望存在生命周期，这样可以挂脚本在 hook 上，这是为了更复杂的可扩展任务机制。举例一个场景：daemon 每一次运行都可以去跑某个脚本，跑脚本会把元数据都传进去，然后 hook 可以计算迭代进行了几轮。为了防止代码腐化，首先插队单独的全面检查代码任务，如果有问题继续插队由这个任务派生的修复任务，然后才继续。这种 gate 怎么设计是后来人自己设计，程序要提供这种接口和能力。" — `v3/v3-goals.md` 目标 5

## 现状事实（基线 pr-529 分支，实施前自行 grep 核对）

- **hook 机制不存在**：全仓无注册回调点、无 preset 侧脚本声明、无 pre-spawn/post-exit/pre-transition 扩展点（`v3/survey-engine-daemon.md` §7）。
- **事件面是现成的生命周期草稿**：`src/observability.ts` 约 40 种类型化事件（`daemon.start/stop`、`agent.spawn/exit`、`phase.start/end`、`item.status`、`queue.terminal`、`chain.completed` 等，五种 kind），发射点集中在 scheduler `emit()` 与 daemon `recordObservabilityEvent`。
- **阻塞 gate 已有唯一先例**：chain-complete trigger（`src/scheduler.ts` `chainCompletionTriggerAllowsCompletion`）——chain 完成前调判定返回 `complete|keep-active`，keep-active 带 fingerprint 幂等（同一队列布局不重复问），判定异常 = 不放行。
- **「插队」能力面已存在**：`item.add`（per-phase `createItems` 权利先例：review phase）+ `item.reorder --position`（`per-phase-authorized`，#409）；pending 选择按 `(position, id)` 排序（`comparePendingItems`）。phase-continuation 优先于 pending 选择——插队不打断进行中 item 的 pipeline，只在 item 边界生效。
- **鉴权与审计面现成**：#406 run-scoped 凭证 + #409 四类命令分级（`hard-deny-for-agent` / `per-phase-authorized` / `mutation-credential-gated` / `read-no-auth`）+ 每 mutation 1-3 条审计事件。
- **daemon 主线程约束**：tick 为 `setInterval` 单飞（同一时刻一个 tick in-flight）；`Bun.spawnSync` worktree 操作已是被点名的阻塞债（survey §2）——hook 执行不得新增主线程同步阻塞点。

## 设计裁决（操作员，2026-07-02，RFC-4 子会话）

1. **hook 点粒度**：「生命周期尽可能齐全，挂钩点够多，是哪个这是运行时的事情」——引擎不预判最小集，挂点清单以齐全为设计目标，用哪个由使用者声明时决定。
2. **gate 失败/超时语义**：声明时自选（`onFailure = hold | advance`）。
3. **hook 身份**：operator 全权——hook 子进程无凭证调 CLI，走操作员路径，不新增第三类主体。
4. **声明位**：四层全支持——全局 loop-data root、chain 级（metadata）、preset 级（抽象 gate 点，接口与实现分离）、item 级。
5. **与 RFC-1 验证者（#546）的关系**：统一 gate 接口——推进决策点上可绑定判定器，kind = script（本 RFC）| agent-phase（#546 validator；chain-complete trigger 已是顶层 join 实例）。判定点与各点允许的 decision 子集归 RFC-1：公共闭集为 `advance | hold | reopen(target, correctionItemIds)`，普通推进点只允许 `advance | hold`，仅容器推进/par join 与顶层 join 允许 `reopen`；非法 point × decision 组合在边界拒绝。script 判定器执行机制归本 RFC。#413 只作已被 #546 supersede 的前史引用，不再承载现行契约。

## 核心设计（从裁决展开）

### 两类 hook

- **observer**：订阅生命周期事件，异步旁路执行，不影响调度；失败只记 diagnostic 事件。挂点 = observability 事件类型枚举减去固定自反子集 `hook.*`（hook 点清单不另发明命名；事件枚举扩张时自动纳入 observer 挂点面，但 `hook.*` 永久排除）。订阅 `hook.*` 的声明在装载期拒绝，事件发射路径对 `hook.*` 零 observer 派发，避免 hook 执行事件再次触发自身形成进程风暴；hook 的可观测性由事件查询面提供。闭包生命周期落定后（#546 定型），闭包转移边（create / run-spawn / run-exit / suspend / reopen / consume）作为新事件类型进入 observer 词表并自动可订阅（参 #546 body「答复 #543（RFC-4）」节 2026-07-10 修订）。
- **gate**：挂在调度决策点上，逻辑 hold 住该宿主决策点（对应 run/item/container/chain/daemon/tick 的推进不发生）直到 hook 返回 decision；实现上异步 spawn 子进程，不阻塞 daemon 主线程与其他 chain 的调度。gate 决策点是引擎内禀闭集（与事件枚举分列）：至少含 run pre-spawn、run post-exit（下一次选择前）、item 状态转移、容器推进/par join（#546 判定点）、chain-complete（吸收现有 trigger 先例；#546 定性为顶层 join 实例）、daemon startup/shutdown、tick（须带节流声明才可挂）。**闭包转移边不进 gate 决策点闭集**——suspend/consume 是闭包状态转移；suspend 本身零资源副作用，consume 才允许 GC，副作用上放 gate = 让用户态扣住引擎资源管理、发明第二推进语义（design-boundary §4.2 红线）；要阻止挂起，在 run post-exit gate 上 hold，推进被扣则闭包自然不挂起。参 #546 body「答复 #543（RFC-4）」节 2026-07-10 修订。

### 执行模型

- hook = 任意可执行文件。输入：全量元数据 JSON 经 stdin。输出：gate hook 经 stdout 返回 decision JSON；observer 无输出契约。decision wire 是 `advance | hold | reopen(target, correctionItemIds)`（可附 reason）：`advance` 放行；`hold` 扣住该决策点、退避重问（chain-complete keep-active 先例）；`reopen` 退回并要求纠正，仅容器推进类决策点合法，其余决策点声明期拒绝。script 先经带 evaluation scope 的 CLI 创建 corrections，再把这些既存 item 的精确 id 放进 `correctionItemIds`；stdout 不承载 mutation。reopen consumer 原子完成的是「校验并认领这些既存 corrections + target 重开 + 游标/预算/decision consumed」，不谎称先前 CLI mutation 与 decision 消费属于同一事务。
- 每 hook 声明超时；超时/崩溃按其 `onFailure` 声明走 `hold`（该决策点退避重问，事件流可见）或 `advance`（记 diagnostic 后放行）。
- gate hold 后的重问需幂等防抖——chain-complete trigger 的 fingerprint 机制（`chain.metadata` 持久化 keep-active 指纹）是既有先例，具体形态归实现 child。

### 能力契约

hook 操作队列 = 在脚本内调 `coder-loop` CLI（socket 命令面），以 operator 身份。不引入「hook stdout 返回结构化 mutation 指令由引擎代执行」的第二套协议——mutation 全部走现有命令面，自动获得既有校验与审计事件。gate hook 的 stdout 只承载 decision，不承载 mutation。

操作员场景在此契约下的分解：post-run gate hook 读元数据算轮数 → 达到阈值时以当前 evaluation scope 调 `coder-loop item add` 创建检查 leaf，并返回 `hold`；原决策点保持扣住，不能靠全局 `(position, id)` 排序冒充控制流。检查 leaf 及其派生修复 leaf 完成后，同一 gate 才返回 `advance`，原 seq 才继续。「有问题继续插入修复任务」由检查任务的 agent 经 per-phase `createItems` 权利派生；检查/修复与被扣住决策点的关联必须以稳定 task/evaluation identity 表达。此场景是本 RFC 的验收场景。

### 声明位与合成语义

四层声明位（裁决 4）。同一挂点多层命中时全部执行，顺序 全局 → chain → preset → item；gate decision 合成为「任一非 advance 即不放行」（AND 放行）；hold 与 reopen 并存时 reopen 优先；多 reopen 按 #714 裁决合成：同 target 合并 IDs，不同 target hold + diagnostic。preset 级是抽象 gate 点：preset 只声明「此处需要一道命名 gate」（保持 preset 可分发、不含本机脚本路径），具体脚本由全局/chain 层绑定到该名字；声明语法归 RFC-2 的 DSL（见接口假设）。

### 可观测性

hook 执行自身进入事件流：新增 `hook.*` 事件类型（执行开始/结束/失败/gate decision），使 hold 状态与 hook 故障对 `status --json` 与 GUI（RFC-5）可见。

## 跨 RFC 接口假设

- **RFC-1（#546，已裁）**：统一判定器接口成立——推进决策点上可绑定 kind = script（本 RFC）| agent-phase（#546 validator）判定器，decision 契约为同一 ADT `advance | hold | reopen(target, correctionItemIds)`。`reopen` 即 #413 的「退回」（rollback 不需要独立词，#546 已答）；`hold` 承接本 RFC 裁决 2 与 chain-complete keep-active 先例——agent-phase 判定器同样可 hold（finalizer 的 keep-active 即实例），#546 的「不需要第三词」仅针对 rollback 一问，不否定 hold。corrections 两 kind 一律先经带 evaluation scope 的 CLI 插入；decision 必须引用精确 correction item IDs。decision 通道各按其 kind（script = stdout JSON，agent-phase = CLI 写回，#546「判定经 CLI 写回」）。gate 决策点闭集 = 本 RFC 挂点清单 ∪ #546 容器推进点（par join；chain-complete 为其顶层实例），合并完成。**闭包生命周期落定后的挂点补充**（#546 body「答复 #543（RFC-4）」节 2026-07-10 修订，逐字快照）：
  > "闭包生命周期落定后的挂点补充：闭包转移边（create / run-spawn / run-exit / suspend / reopen / consume）作为新事件类型进 **observer 事件词表**；gate 决策点闭集**不因此扩大**——转移边不可 gate（suspend/consume 是闭包状态转移；suspend 本身零资源副作用，consume 才允许 GC，副作用上放 gate = 让用户态扣住引擎资源管理、发明第二推进语义）；要阻止挂起，在 run post-exit gate 上 hold，推进被扣则闭包自然不挂起。"

  引擎侧对应表述：observer 事件词表扩张同前节「两类 hook」；gate 决策点闭集不扩，阻止挂起走 run post-exit gate hold。
- **RFC-2（#547，已答）**：hook「全量元数据」= #547 编译产物投影 + 运行态快照，不另造第二套 shape；preset 级具名抽象 gate 点的 DSL 声明位（命名、required/optional 标志）由 #547「DSL 演进面」第 7 项承载。
- **RFC-5（#544，已裁）**：`hook.*` 事件类型与字段归本 RFC 实现 children，经 #411 统一事件流被 #544 网关消费，零新增通道；gate hold 状态与 hook 声明清单（四层合成后的生效视图）进 status 快照新增的 hooks 节，并入 #544 已裁的快照 boundary 收紧工作。
- **RFC-3（#545）**：无直接接缝——hook 如需读共享 context，经该 CLI 的普通读取面，不新增契约。

## 已分配的实现裁决

以下问题不再由实现者重新设计；权威结论在对应 child：

- tick 节流、决策点闭集、同一点多 gate 合成：#712。
- evaluation epoch、hold 重问、mutation 幂等与 decision journal：#712；fingerprint 与 epoch 是两个正交概念。
- preset 抽象 gate 未绑定语义：#713 的 `optional | required` 三态绑定模型。
- item hook 声明载体、寿命与四层生效视图：#586。
- 同一脚本并发与重入：#711；observer 永久排除 `hook.*` 自反订阅。
- 多 reopen 合成：#714；相同 target 合并精确 correction IDs，不同 target 显式 hold 并发 diagnostic，绝不任选一个 target。

child 若改变上述结论，必须先同步本 umbrella；不得仅在 comment 中形成第二份契约。

## 约束

- hook 执行不得阻塞 daemon 主线程（禁止 `Bun.spawnSync` 形态；survey §2 已点名该债，不新增）。
- 引擎不含任何 gate 策略业务语义：轮数阈值、检查任务内容、插队位置全在 operator 脚本内；引擎只提供挂点、元数据、decision 协议（对应目标 5 「这种 gate 怎么设计是后来人自己设计」）。
- **代码红线（操作员裁决 2026-06-12，全仓 issue 统一）**：必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。依据：#78 / #109 原始约束、#453 契约 T3/T5。

## 关闭验证

逐条钉终态条件。本 RFC 是设计 issue：具体命令面由实现 children 落地时把各行具体化为可逐字重跑的命令；已分配裁决由对应 child 具体化并保持与本 body 同步。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | observer hook 在事件发生时被调用且元数据经 stdin 传入；自反订阅不可表达 | 声明 observer 订阅 `agent.exit` 并跑一个 run；另声明订阅 `hook.*` | `agent.exit` 脚本收到含该 run 元数据的 JSON且调度不受影响；`hook.*` 声明装载期拒绝且发射期零派发 |
| 2 | gate hook 能 hold 调度决策 | post-run gate 返回 `hold` | 该 chain 不选下一个 item，事件流可见 hold；返回 `advance` 后恢复 |
| 3 | 操作员验收场景成立 | post-run gate 脚本算轮数、达阈值后在同一 evaluation scope 创建检查 leaf 并 `hold`；检查/修复 leaf 完成后再 `advance` | hold 期间原 seq 不推进；检查 leaf 及其派生修复 leaf 全部完成后才恢复；正确性不依赖全局 `(position, id)` 排序 |
| 4 | `onFailure` 两种语义都成立 | 同一挂点分别声明 `hold` / `advance` 的必崩脚本 | `hold`：决策点退避重问且事件可见；`advance`：记 diagnostic 后放行 |
| 5 | 四层声明位与合成语义成立 | 全局+chain+preset+item 同挂点各声明一个 gate | 按 全局→chain→preset→item 顺序执行，任一 hold 即 hold |
| 6 | hook 执行可观测 | 跑 1/2/4 各场景后查事件流 | 每次 hook 执行有 `hook.*` 事件（开始/结束/失败/decision） |
| 7 | 引擎无 gate 策略业务字面量 | grep 引擎源码中轮数/检查任务等词表 | gate 策略全在 operator 脚本；引擎只有挂点与协议 |
| 8 | script gate 的 reopen 判定 | 容器推进点 gate 先经带 evaluation scope 的 CLI 插入纠正 item，再返回 `reopen(target, correctionItemIds)` | 精确 IDs 被校验并认领；target 重开、seq 游标回退、已 terminal item 状态不变；预插入 mutation 不被伪称为 decision 消费事务的一部分 |

## 范围外

- 容器/节点推进判定点的定义与退回（reopen）语义——归 #546（已裁）；本 RFC 消费其契约。
- 「全量元数据」的类型化 schema 与 preset DSL 声明语法——归 RFC-2。
- hook 展示面——归 RFC-5。
- #534 audit 修复树的 v2 缺陷——与本 RFC 并行不悖，不吸进范围。

## 本 issue 的验证边界

- **验证层级**：本 RFC umbrella 不直接运行测试，也不以任一 implementation PR 的局部测试关闭。
- **关闭所需证明**：所有直接 children 达到各自正文声明的验证深度；跨 child 的 v3 新语义接缝由 #684 在冻结合流 SHA 上证明；现有 bundled preset 兼容性由 #685 在发布候选 SHA 上证明。
- **不在本 issue 内执行**：不在 RFC 迭代中重复运行 `scripts/real-e2e.ts`，不把 compatibility E2E 绿解释成 `RFC: v3 生命周期 hook——引擎扩展点与用户态 gate` 的新语义已经成立。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。



---

## 二、当前实现 children（OPEN，当前 spec）

### #710 feat(engine): hook 全量元数据 payload 与运行态快照契约

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

合并声明消费与 payload 投影边界；已落地 #586 作为输入，不重复其实现。

hook stdin 的「全量元数据」typed payload 契约与单一组装函数：触发上下文 + #547 编译产物投影 + 运行态快照，三块类型全部从既有 schema 派生，零平行 shape。

## 问题

#543 执行模型要求「全量元数据 JSON 经 stdin」，接缝已裁「不另造第二套 shape」；当前不存在任何面向 hook 的元数据组装函数——若各执行 child 各自拼 JSON，必然手写平行 shape，违反接缝裁决，且 hook 作者面对的输入形态随执行路径漂移。

## 预期结果

性质表述：

1. **单一组装路径**：存在唯一 payload 组装函数与 typed 契约，三块组成——触发上下文（挂点 + 触发事件或决策点标识 + 关联键）、编译产物投影、运行态快照；observer/gate 两类执行路径共用，不存在第二套拼装。
2. **零平行 shape**：编译产物半边的类型从 #549 产物 schema 派生；运行态半边从 `StatusSnapshotBoundary` 派生；触发事件半边从 `ObservabilityEventBoundary` 派生——上游 shape 演进（#558 树结构节、#718 boundary 收紧）自动传导到 payload，本侧零同步代码。 运行中实例的编译产物半边必须解引用 #743 pinned definition；不得重新编译同路径当前 preset。
   运行态半边的红线适配：`StatusSnapshotBoundary` 现存匿名 `"object"` 槽（#718 收紧 child）——**匿名槽不透传进 payload**（透传即违反「禁匿名形状」红线）；payload 只投影已具精确 boundary 的节，#718 收紧后投影面经派生关系自动扩张，本侧零改动。
3. **版本化**：payload 自带版本标识；shape 演进 bump，PR body 列 shape diff（#456 先例）。
4. **schema 可导出**：hook 作者可获知 payload 精确形态（schema 导出面；作者文档载体归#715（收尾））。
5. **闭包元数据投影**（#546 body「资源模型公理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §2）：闭包转移边事件（`closure.create` / `run-spawn` / `run-exit` / `suspend` / `reopen` / `consume`）作为 observer 触发事件时，payload 运行态半边须投影闭包元数据（生命周期态 活跃/挂起/已消费、worktree 路径、闭包分支、par pin commit、sessionIds）。事实源 = #558 闭包状态表（四视图共同事实源）——投影关系派生自其 shape，本侧零平行定义；#558 落地后自动扩张。
6. **引擎不注入 GitHub 面字段**（L1 红线 + 权威记录 `v3/closure-lifecycle-decision.md` §5 打回记录）：payload 任何半边不得包含 mergedness、mergeCommit、PR 状态等 GitHub 面事实——「引擎理解 GitHub 字段」违反 L1 红线（`gh-issue-pr-iteration` preset 判定器自查 GitHub 面才是正确通道，供给条款 3）；边界 1 会话打回主张「引擎注入 mergedness 进判定 payload」的形态，本 child 从第一天起不留后门。相关 script 判定器自查形态见 #714。

### 显式决策项（落地时裁，裁决留本 thread）

- 编译产物投影的切片范围：全量六块 vs 按挂点相关切片（如 run 级挂点只投影所属 preset 的 phases 块）——「全量元数据」语义与 payload 体积的平衡。
- 无 chain/item 上下文的挂点（daemon startup/shutdown、tick）的运行态快照范围——与#712（决策点闭集） 协调（其 body 同步登记）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | payload 三块齐全且过 schema | 单元测试：fixture chain/run 组装 payload 后经边界 schema 校验 | local | 触发上下文/编译产物投影/运行态快照三块在场；校验通过；版本标识在场 |
| function | 操作员场景数据面 | 单元测试：多 runs fixture 下从 payload 运行态半边数出目标 item 的 run 次数 | local | 「计算迭代进行了几轮」可从 payload 得出 |
| type | 零平行 shape | 类型级断言 payload 类型由三个上游 schema 派生；`grep` 无重复字段手写定义 | local | 派生关系成立；无平行 shape |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |
| integration | stdin 端到端交付 | 登记：由 #711（observer 执行） 的「脚本收到含 run 元数据 JSON」验收行接管（本 child 落地时点为单元级） | local | — |

## 架构切片

1. **系统定位**：L1 引擎 hook 面的输入投影级——把引擎已有的两个 typed 事实源（定义态：编译产物；运行态：status 快照）加触发上下文合成为 hook 子进程的 stdin 契约。不新增事实源，只做投影合成。
2. **全局坐标**：引擎 typed 域（CompiledTaskModel / snapshot / event 信封）→ hook 子进程域（外部不可信消费者，经 stdin 收 JSON）。方向是 typed 域向外投影——无入站 parse 需求（hook 的回程通道是 gate stdout decision，归 gate child 的边界 parse）。
3. **类型↔值不漂移**：防值漂移——「全量元数据」若由各执行路径各自拼装即出现同值多副本失同步；单一组装函数封死。防类型泄露——payload 不得手写复制上游 schema 字段（从 schema 派生），上游演进零同步。
4. **消除的错误类别**：「hook 看到的元数据与 status/compile 输出不一致」不可表达（同源投影）；「执行路径间 payload 形态漂移」不可表达（单一组装）。

## log/观测义务

- 无新增运行期事件义务（payload 组装是纯函数面；组装失败随执行 children 的 hook.* 失败事件呈现）。

## 依赖关系

- Depends on: #586、#549、#743。
- Blocks: #711、#712、#713、#714、#715、#719、#744。



### #711 feat(daemon): observer hook 订阅派发与异步执行

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

只交付 observer 执行，不参与控制流。

observer hook 端到端执行：事件发射点派发 → 异步 spawn 脚本 → stdin 写 payload → 超时回收 → 失败只记 diagnostic；同时建立 observer/gate 共用的 hook 进程执行层（spawn/stdin/超时/并发语义）。

## 问题

声明模型与 payload 契约落地后，事件仍不触达任何脚本——#543 关闭验证行 1（observer 被调且元数据经 stdin）无机制承载；且 observer/gate 共用的「异步 spawn + stdin + 超时 + 并发语义」执行层不存在，gate children 无地基。

## 预期结果

性质表述：

1. **派发性质**：生效视图中订阅了事件类型 E 的每个 observer，在 E 发射时被异步 spawn（fire-and-forget）：调度路径不等待其完成、不消费其退出码；tick 时长不随 observer 数量与脚本时长增长。
2. **payload 经 stdin**：消费 #710（payload 契约） 的组装函数写入 stdin；任意可执行文件可消费（不要求特定语言/运行时）。
3. **超时与失败语义**：每 hook 声明超时生效（SIGTERM→SIGKILL 组信号回收）；observer 失败（非零退出/超时/spawn 失败）只记 diagnostic 事件——不影响调度、不重试、不升级。
4. **hook.* 事件**：hook 执行开始/结束/失败进入事件流（`ObservabilityEventTypeBoundary` 枚举扩张，经既有边界），含 hook 标识与触发事件关联键。事件发射路径对 `hook.*` 类型零 observer 派发（与#586（声明模型） 的自反挂点装载拒绝构成双层防护——自激励回路在声明期与发射期都不可表达）。
5. **零同步阻塞**：hook 路径无 `Bun.spawnSync` 新增；spawn/stdin 写入/回收全部异步。

### 显式决策项（落地时裁，裁决留本 thread）

- RFC 开放问题逐字："同一挂点多 hook / 跨 chain 并发触发同一脚本的互斥与重入语义。"——执行层公共语义，gate children 继承本裁决。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | observer 被调且 stdin 收 payload（RFC 行 1） | 声明 observer 订阅 `agent.exit`（fixture 脚本把 stdin 落文件），真跑一个 run | local | 脚本收到含该 run 元数据的 JSON；调度不受影响 |
| function | 失败只记 diagnostic | 必崩脚本 + 超时脚本各声明一个，真跑 | local | diagnostic 事件在场且点名 hook；调度照常推进；无重试 |
| function | 异步旁路 | 声明 sleep 长于 tick 间隔的慢脚本，观察 tick 事件节奏 | local | tick 节奏不被拉长；脚本与调度并行 |
| function | hook.* 事件（RFC 行 6 observer 份额） | 跑上述场景后查事件流 | local | 每次执行有开始/结束/失败事件，关联键可回溯触发事件 |
| function | 自反回路双层防护 | 事件发射路径对 `hook.*` 类型的派发检查（单元）+ 声明期拒绝（#586（声明模型） 验收已覆盖，此处发射期半边） | local | `hook.*` 事件零派发 |
| assumption | 无 spawnSync 新增 | 对本 child diff 范围 `grep -n "spawnSync"` | local | 零新增 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：daemon 事件面的消费者扩展级——在既有「事件记录」后沿加「事件派发」，加上 hook 子进程执行单元（与 agent run 并列的第二类引擎管理进程，但生命周期语义更弱：fire-and-forget、无 attempt/预算/resume）。
2. **全局坐标**：引擎事件域（typed `ObservabilityEvent`）→ hook 子进程域（stdin JSON 投影，出站）。子进程对引擎的回程只有事件流可见的退出码/超时事实（observer 无输出契约）——不存在需要 parse 的入站值。
3. **类型↔值不漂移**：防类型泄露——observer 订阅匹配直接用事件类型 union，不建平行的「挂点名」映射表；事件词表扩张零 hook 侧同步。
4. **消除的错误类别**：「observer 故障拖垮调度」不可表达（旁路性质 + 失败只记 diagnostic）；「hook 自激励回路」不可表达（发射期零派发 + 声明期拒绝双层）；「同步阻塞主线程」在 hook 路径不可表达（无 spawnSync、异步 API）。

## log/观测义务

- 新增 `hook.*` 执行事件（开始/结束/失败）：kind 归 lifecycle/diagnostic 按事件性质分（失败 = diagnostic，与 #543 observer 失败语义一致）；经 `ObservabilityEventTypeBoundary` 编译期 union 扩张，全部消费点由 typechecker 暴露。
- observer 失败的 diagnostic 事件必须含 hook 标识、触发事件类型、失败原因分类（非零退出/超时/spawn 失败）——headless 排障的最小字段集。

## 依赖关系

- Depends on: #586、#710。
- Blocks: #715。


### #712 feat(engine): 共享 gate evaluation、script decision 与指纹协议

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

把 script gate 执行与 decision 协议、gate 决策点闭集接线、gate 评估代次与幂等协议这三个原先互相消费的面合并为一个 owner，交付 post-exit hold→重评估→advance 的可达路径；inspection/correction subtree 在 hold 下运行的综合场景后置到最终验收并依赖 #546 runtime。

script gate 在第一个决策点（run post-exit，下一次选择前）端到端成立：spawn（复用 hook 执行层）→ stdout decision JSON 边界 parse（三词 ADT + 可选 reason）→ onFailure 折叠 → 决策点消费（advance 放行 / hold 扣住退避重问）。

gate 决策点从单点（post-exit）扩到闭集全点：run pre-spawn、item 状态转移、daemon startup/shutdown、tick（带节流声明）；hold 幂等指纹从 chain-complete 先例泛化为通用机制并收编既有复用点；四层合成在全部决策点走同一代码路径。（容器推进/par join 与 chain-complete 两点经 #714（join script） 通道，分工见「不应残留」。）

gate 评估获得持久化的代次身份与消费状态机；CLI mutation 面在 gate 评估语境下获得确认式幂等（重放返回首次结果，零副作用）；script decision 自 stdout parse 成功起进入共享 journal，消费与其全部引擎侧效果原子；daemon 重启恢复不重复消费、不丢已判定的 decision。journal/consumer 必须保留精确的 typed ingress 扩展边界，使 #700 只能把 validator CLI admission 接入同一协议，而不能复制状态机。

## 问题

gate 类 hook 的全部语义（hold 调度决策、stdout decision 协议、onFailure）无任何机制——#543 关闭验证行 2（gate hold）与行 4（onFailure 两语义）无处成立。决策点闭集全量接线体量配不上单 PR：先在操作员验收场景所在的一个决策点把协议端到端立起来，其余点由闭集 child 按同一路径扩展。

post-exit 单点落地后，闭集其余决策点仍无 gate 能力——裁决 1「挂点清单以齐全为设计目标」未兑现；hold 指纹仍是 chain-complete 专用形态，两处复用点（本 issue 的 gate 执行、#700 的 validator）各自贴先例走，无通用机制；RFC 关闭验证行 5 的合成语义只在单点成立。

本 issue 的 script gate 与 #700 的 validator 都允许 hold 后重新执行、改判，但没有共同机制承接「重复执行 ⇒ 重复副作用」：判定主体在 mutation 落地后、decision ingress 成功前死亡时，重问会重放 mutation；decision 已准入后消费中途 daemon 崩溃时，判定可能丢失且评估状态无从恢复。script/stdout 与 validator/CLI 若各自补洞又会形成两套可靠性协议——mutation+decision 原子性必须收敛为 kind-specific ingress + shared journal/consumer。

## 预期结果

性质表述：

1. **决策点评估**：post-exit 决策点上，生效视图命中的 gate 逐层逐个执行（顺序 全局→chain→preset→item）；合成 = AND 放行——本决策点词表是 `advance | hold` 二词子集（非容器推进点无 seq 游标可退），任一 hold 即整点 hold，全 advance 才放行。
2. **decision 边界 parse**：脚本 stdout 输出 decision JSON（统一判定契约三词 + 可选 reason），arktype 边界 parse 为穷尽 union；非法输出（非 JSON、词表外值、本决策点收到 reopen）按该 hook 的 `onFailure` 处置并记 diagnostic + 审计事件，无静默放行、无 default 兜底。stdout 不承载 mutation。
3. **onFailure 语义（RFC 行 4）**：超时/崩溃/协议违规 → `hold`（决策点扣住、退避重问、事件可见）或 `advance`（记 diagnostic 后放行）。
4. **hold 语义（RFC 行 2）**：该 chain 的 post-exit 决策扣住——不选下一个 item；其他 chain 调度不受影响；退避重问时脚本重新执行、可改判；幂等防抖先复用 chain-complete fingerprint 先例形态（泛化机制即本 issue 的决策点闭集，落地后收编该复用点）。
5. **gate decision 可观测**：每次 decision 有 `hook.*` decision 事件（判定词 + reason）。
6. **引擎零策略语义**：放行/扣住的理由判断全在脚本内；引擎只执行协议。

### 非容器 reopen 裁决

声明只能约束挂点，不能证明任意脚本未来 stdout 不会输出 reopen，因此不伪造“装载期可证明脚本输出”的保证。非容器决策点的允许 decision boundary 是 `advance | hold`；若脚本实际输出 reopen，stdout boundary 将其判为 `decision_not_allowed_at_point`，记录 diagnostic，并严格按该 hook 已声明的 `onFailure = hold | advance` 处理。compile 仍负责拒绝把显式声明为 container-only 的 gate 绑定到非容器点；runtime boundary 负责不可信脚本输出。

性质表述：

1. **闭集全点物化**：#543 挂点清单中除容器推进/par join、chain-complete（归 #714（join script））外的全部决策点可挂 gate；每点评估走本 issue gate 执行面落地的同一协议路径（同一 parse/onFailure/合成代码），不存在每点一套的私有评估逻辑。
2. **闭集是穷尽类型**：gate 决策点为引擎内禀闭集 union；新增决策点由编译器暴露全部处置点（声明校验、评估接线、payload 触发上下文、事件字段）。
3. **tick 节流**：tick gate 必须显式声明正整数 `minIntervalMs`，无默认值；无该字段或非正值 compile 拒绝。每个有效声明独立记录上次 evaluation 完成时刻，达到间隔才可发起下一 epoch；不使用引擎魔法频率。
4. **hold 指纹泛化**：任一决策点的 hold 退避重问带幂等指纹防抖（同一决策上下文不重复问、上下文变化后重问）；chain-complete 先例被泛化机制收编——本 issue gate 执行面与 #700 的先例复用点迁移到通用机制，先例专用形态不残留。
5. **四层合成全点一致**：全局→chain→preset→item 顺序与 AND 放行在全部决策点由同一合成实现保证（RFC 行 5 的合成半边；preset 层份额随#713（具名 gate） 补全）。

### 决策点行为裁决

- **指纹**：每个 point variant 定义类型化 `FingerprintInput`，由决策点 identity、宿主稳定 identity、该点会影响的 canonical 状态投影、effective hook declaration hash 构成；不得 hash 全库偶然字段。canonical JSON hash 与最近 hold 一并存入本 issue 的 per-point evaluation store，不再写 `chain.metadata`。hold consumed 后，仅 fingerprint 改变才开新 epoch；崩溃残留 `evaluating` 同 epoch 重放不查 fingerprint。
- **item 状态转移**：同步 RPC 不悬挂。gate hold 时请求返回结构化 `gate_held`（含 point identity/reason/retry hint），mutation 零落地；调用方重试形成下一次候选评估。advance 才在同一请求继续 admission。
- **daemon startup**：socket/status 面先进入 `starting-held`，scheduler 不开始；按 backoff 重评，advance 后进入 ready。**shutdown** hold 时 daemon 进入 `shutdown-held`，停止接收新调度但保留 socket/status 与现有进程回收能力，重评至 advance；operator 的 OS hard kill 不经过 gate。**tick** hold 只跳过该 tick 的调度推进，daemon 继续存活；达到声明的 `minIntervalMs` 且 fingerprint 变化后才重评。
- **无 chain/item 上下文 payload**：使用 #710 同一 payload envelope，host variant 为 daemon，携带 daemon lifecycle facts、tick identity、effective declarations 与当次 status snapshot；不存在伪造的 chain/item id，也不另建匿名 payload shape。

性质表述。四条可重放不变量是本 child 的核心契约：

1. **评估代次状态机**：每个 gate 决策点评估有持久化身份 `(决策点身份, epoch)`（决策点身份 = 决策点类型 × 宿主 chain/container/item/run id）；生命周期 `evaluating`（spawn 前 write-ahead 落状态）→ `decided`（kind-specific ingress 准入成功，decision 单事务持久化；script = stdout parse，validator = CLI default-deny admission）→ `consumed`（decision 效果落地，与效果同一事务）。崩溃/超时/非法或未授权 decision 停留在 `evaluating`；epoch 仅在 `consumed` 时递增。持久化不进 `chain.metadata`。
2. **I1 mutation 幂等**：evaluation scope 注入判定主体的执行环境；本 child 先覆盖 script，CLI mutation 自动附加为请求字段，#700 对 validator 复用同一字段与幂等域；幂等 key 从 `(evaluation scope, command, 规范化 args)` 派生。daemon admission 层 key 命中即返回首次 response 快照、零副作用；miss 时 mutation 与 key 记录同一事务。同一 epoch 内任一判定主体重放多次，每个逻辑 mutation 至多生效一次。
3. **I2 decision 消费原子**：每个 epoch 至多一个 decision 被准入并消费；typed ingress 只负责校验并写 journal，后续消费走同一实现。消费与全部引擎侧效果在单个状态存储事务内；重启时 `decided` 未消费则直接重消费、不重启对应判定主体，`evaluating` 残留则同 epoch 重问对应主体；滞后 mutation 被同 key 吸收，滞后 decision 被 epoch 与当前执行身份拒绝。
4. **I3 epoch 单调 + 与防抖指纹正交**：epoch 只在消费完成时递增，同 epoch 重放永不跨入下一代次的 key scope；hold consumed → epoch+1 + 记防抖指纹（下一 tick 指纹同则不问、变则新评估）；`evaluating` 残留的重问不查指纹、无条件重问。指纹本体形态归本 issue 的 gate 执行面，此处只钉两概念分离。
5. **I4 边界诚实与可追溯**：协议不承诺「评估恰好一次」；同 epoch 重放中非确定性脚本产生的不同 mutation 各自首次生效、可能残留孤儿 corrections，引擎不撤销、不判定「悬空」（业务语义，违反引擎零策略红线）；gate 评估语境下创建的 item 其 `item.created` 审计事件携带评估 scope 标识，operator 可追溯来源。
6. **普通 operator 路径零影响**：不携带评估 scope 的请求不进幂等分支，既有语义（含 `duplicate_item` conflict）逐字不变。

### 显式决策项（落地时裁，裁决留本 thread）

- 评估状态与 key→response 快照的存储 shape（同表带 kind 还是分表）与快照序列化边界——落地时按状态存储既有形态裁。
- 决策点闭集中无宿主 id 的点（daemon startup/shutdown、tick）的决策点身份构成——与本 issue 的无上下文 payload 决策项对称，协调登记。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | gate hold（RFC 行 2） | chain 声明 post-exit gate（fixture 脚本首答 `hold` 次答 `advance`），真跑两 item 队列 | local | hold 期间不选下一 item、事件可见 hold 与退避重问；advance 后恢复选中 |
| function | onFailure 两语义（RFC 行 4） | 同挂点分别声明 `onFailure=hold` / `advance` 的必崩脚本 | local | hold：决策点扣住退避重问、事件可见；advance：diagnostic 后放行 |
| function | decision 边界 parse | fixture 脚本分别输出非 JSON、词表外值、reopen | local | 均按 onFailure 处置且 diagnostic/审计事件点名违规类别；无静默放行 |
| function | 多 gate AND 合成 | 同点两 gate：一 advance 一 hold | local | 合成 hold；改全 advance 后放行 |
| function | 检查 leaf 与 hold 因果闭环 | fixture gate 脚本在当前 evaluation scope 调 `coder-loop item add` 创建检查 leaf 后返回 hold；检查 leaf 完成后再返回 advance | local | item 创建成功且带稳定 evaluation/task identity；hold 期间原决策点不推进；完成后才恢复；stdout decision 不含 mutation 字段且不依赖 `(position,id)` 抢跑 |
| function | 其他 chain 不受影响 | 两 chain 一有 hold gate 一无，并行真跑 | local | 无 gate chain 照常推进 |
| type | decision ADT 穷尽 | `bun run typecheck`；临时向 decision union 加词观察编译错误面 | local | 全部处置点报错，无 default 吞掉 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | pre-spawn gate | 声明 pre-spawn gate（hold→advance），真跑 | local | spawn 被扣住、退避重问事件可见；advance 后 spawn 发生 |
| function | 状态转移 gate | 声明状态转移 gate，agent 真实写 status | local | hold 返回结构化 `gate_held` 且 mutation 零落地；重试后 advance 才写入生效，事件可见 |
| function | tick 节流 | 声明带节流 tick gate 观察执行节奏；声明无节流 tick gate | local | 前者按节流节奏执行（事件计数可证）；后者装载期拒绝 |
| function | daemon startup/shutdown gate | 各声明一个并先 hold 后 advance，起停 daemon | local | startup 显示 `starting-held` 且 scheduler 未启动；shutdown 显示 `shutdown-held` 且无新调度、socket可查；advance 后完成转移 |
| function | 指纹防抖泛化 | 任一点 hold 后同一决策上下文连续多 tick | local | 脚本不被重复 spawn（指纹命中）；上下文变化后重问 |
| function | 收编无残留 | 泛化落地后 grep chain-complete 指纹专用形态在 gate/join 复用点的残留 | local | 复用点全部走通用机制 |
| function | 四层合成顺序（RFC 行 5 直接声明层份额） | 全局+chain+item 同点各一 gate（脚本记录执行序），其中一层 hold | local | 执行顺序 全局→chain→item；合成 hold |
| type | 决策点闭集穷尽 | `bun run typecheck`；临时加决策点 variant 观察编译错误面 | local | 全处置点报错，无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | I1 崩溃重放 mutation 至多一次（预期结果 1+2） | fixture gate 脚本：`item add` 后立即自杀（不输出 decision）；观察退避重问后的第二次执行 | local | 第二次执行的同一 add 得首次 response 回放（key 命中事件可见）；items 无重复；epoch 未递增（同代次） |
| function | key 与 mutation 同事务（预期结果 2） | gate 脚本 `item add` 成功后，直接查状态存储 | local | item 行与幂等 key 记录同时在场；不存在只有其一的中间态 |
| function | I2 decided 重启恢复不重问（预期结果 3） | fixture 脚本返回 decision 后 daemon 被 kill -9（脚本 sleep 控制时机）；重启 daemon | local | decision 直接被消费，脚本不被重新 spawn；事件序列可证 |
| function | I2 evaluating 重启恢复同代次重问（预期结果 3） | 脚本执行中 kill -9 daemon；重启 | local | 同 epoch 重问；脚本重放的 mutation 被 key 吸收 |
| integration | 下游 ingress 扩展边界唯一 | 对 shared journal/consumer 的 typed ingress seam 做 contract test，再由 #700 的真实 validator CLI 验收继承该 seam | local | 本 child 只有一个 journal/consumer；新增 ingress 只能提交同一 decision ADT，不存在复制 consumer 的入口 |
| function | I3 hold 后 epoch 递增与指纹正交（预期结果 4） | 脚本首答 hold；下一 tick 上下文未变；随后改变上下文 | local | 上下文未变不重问（指纹命中）；变化后重问且为新 epoch（新 key scope，脚本新插入生效） |
| function | I4 审计可追溯（预期结果 5） | gate 脚本 `item add` 后 advance；查 `item.created` 审计事件 | local | 事件含评估 scope 标识字段 |
| function | operator 路径零影响（预期结果 6） | 无注入 env 的普通 `coder-loop item add` 同 itemId 两次 | local | 第二次仍 `duplicate_item` conflict，既有语义不变 |
| type | 评估状态机 ADT 穷尽 | `bun run typecheck`；临时向状态 union 加 variant 观察编译错误面 | local | 全部处置点报错，无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：scheduler 决策面的 gate 评估级——在「run 终结 → 下一次选择」之间插入一个可编程放行点；decision 协议（stdout JSON 边界 parse + onFailure 折叠）是 script kind 判定器的执行器本体，与 #700 的 agent-phase 判定通道（CLI 写回）互为统一判定契约的两个 kind 实现。
2. **全局坐标**：hook 子进程域（不可信 stdout 字节）→ arktype 边界 parse → 引擎 typed decision 域 → 调度决策消费。入站信任升格点恰好一个（parse）；mutation 不走此边界（走既有 CLI 命令面，复用其校验与审计）。
3. **类型↔值不漂移**：防值漂移——decision 词表若在 parse 侧与消费侧各自定义即失同步；穷尽 union 单一定义封死。防类型泄露——非容器决策点的 `advance | hold` 子集限制以类型/校验表达，不靠散文约定。
4. **消除的错误类别**：「脚本输出垃圾被静默当放行」不可表达（边界 parse + onFailure，无 default）；「stdout 夹带 mutation 被引擎代执行」不可表达（decision schema 无 mutation 位，mutation 只经 CLI）；「一个 chain 的 hold 拖住别的 chain」不可表达（hold 作用域 = 该决策点）。

1. **系统定位**：scheduler/daemon 决策面的 gate 接线全集级——把本 issue gate 执行面立起的单点协议推广为「决策点闭集 × 同一协议」的乘积结构；hold 指纹泛化是该结构的持久化伴生件（决策点通用的幂等防抖）。
2. **全局坐标**：引擎调度域内部改造（各决策点 → 统一 gate 评估入口）；无新增域边界——decision 边界 parse 已由本 issue 的 gate 执行面拥有，本 child 只扩接线面。
3. **类型↔值不漂移**：防值漂移——各决策点若各自实现评估即协议行为漂移；单一评估路径封死。防类型泄露——决策点闭集是引擎内禀 union，不得以字符串散名出现在声明/事件/payload 中各自维护。
4. **消除的错误类别**：「某决策点的 gate 行为与其他点不一致」不可表达（同一路径）；「hold 重问风暴」不可表达（指纹防抖全点生效）；「tick gate 每秒轰炸」不可表达（节流声明装载期强制）。

1. **系统定位**：gate 执行器的可靠性层——本 issue 的 gate 执行面立起 decision 协议的语义面（parse/onFailure/合成），本 child 给同一执行器补齐故障半边：评估身份、mutation 重放安全、decision 持久化与消费原子、daemon 重启恢复。统一判定契约两 kind 中先落 script kind；agent-phase kind 的对称窗口（#700 通道下 agent 在 corrections 与 decision 写回之间崩溃）同根因，落地后由该侧按本协议形态收编，本 child 不越界。
2. **全局坐标**：hook 子进程域（不可信、可崩溃、可重放）→ CLI admission 域（幂等确认新增于此）→ 状态存储域（评估状态机 + key 快照 + 单事务消费）。零新增域边界——评估 scope 经既有 env 注入形态（`CODER_LOOP_RUN_CRED` 先例）进入既有 socket 命令面。
3. **类型↔值不漂移**：防值漂移——评估状态机若散落为 boolean/时间戳组合即无法穷尽恢复路径；`evaluating | decided | consumed` ADT 单一定义封死。防类型泄露——幂等 key 与快照是 admission 层内部事实，不泄进调度类型；防抖指纹与评估代次两概念不合一（操作员裁决 2026-07-10）。
4. **消除的错误类别**：「脚本崩溃重问导致重复 correction items」不可表达（同 epoch key 吸收）；「decision 已返回但 daemon 崩溃后凭空蒸发、脚本改判造成悬空」不可表达（decided write-ahead + 重消费）；「消费效果落地一半」不可表达（单事务）；「重放跨入新代次的 key scope」不可表达（epoch 仅 consumed 递增）。I4 明确不消除：非确定性脚本的孤儿 corrections 是接受的残留边界，以审计可追溯兜底。

## log/观测义务

- 新增 `hook.*` gate decision 事件（decision kind 建议 `decision`，与 #411 五 kind 对齐）：含 hook 标识、决策点、判定词、reason。
- 协议违规/超时/崩溃：diagnostic + 审计事件，点名违规类别——与既有 `invalid_request` 审计契约同风格。
- hold 扣住状态经 status 快照 hooks 节可见（#586（声明模型） 的 hooks 节承载，本 child 填充 hold 运行态字段）。

- 每决策点评估沿本 issue gate 执行面的 `hook.*` decision 事件契约，事件含决策点标识（闭集 union 值）。
- hold 扣住/重问/指纹命中经事件可见（重问节奏可从事件流重建——排障「为什么这个 chain 不动了」的第一入口）。
- status 快照 hooks 节的 hold 运行态字段覆盖全部决策点。

- key 命中（重放吸收）事件：含评估 scope、命中的 command、首次记录时间——排障「脚本为什么没插进去」的第一入口。
- 评估状态转移（`evaluating`/`decided`/`consumed`）与重启恢复动作（重消费/同代次重问）经事件可见。
- gate 评估语境创建的 item 其 `item.created` 审计事件携带评估 scope 标识（I4 可追溯）。
- 新增事件类型经 `ObservabilityEventTypeBoundary` 编译期 union 扩张（#543 观测义务总表惯例）。

## 依赖关系

- Depends on: #586、#710。
- Blocks: #713、#714、#715、#719、#740。



### #713 feat(engine): preset 级具名 gate 点声明与绑定解析

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

消费已落地的共享 gate decision ADT，不复制或预猜类型。

preset 声明的具名 gate 点获得执行语义：全局/chain 层绑定声明（gate 名 → 脚本 + 超时 + onFailure）、运行期在声明点解析绑定并执行 gate、未绑定语义（optional 空过；required 在实例创建边界拒绝；已存在实例恢复时缺绑定则显式 hold）。

## 问题

#740 只做声明位与产物暴露（语义零实现，见继承快照）；绑定声明、运行期查找、未绑定语义全部悬空——RFC 关闭验证行 5 的 preset 层份额与开放问题「preset 抽象 gate 点未被任何层绑定时的语义」无处成立。

## 预期结果

性质表述：

1. **绑定声明**：全局/chain 层可声明 gate 名 → 脚本绑定（含超时/onFailure），arktype 边界 parse，进#586（声明模型） 的生效视图（preset 层成员，合成顺序位置 = preset）。
2. **解析三态穷尽**：装载时每个 preset 声明的 gate 点解析为穷尽三态——已绑定（执行如普通 gate，走统一评估路径零特例）| 未绑定 optional（空过，跳过事件可见）| 未绑定 required（新实例创建拒绝；既有实例恢复 hold）；无 default 兜底。
3. **可分发性质**：preset 本体（toml + 模板）中不存在本机脚本路径的通道——绑定只在全局/chain 层。
4. **执行同路径**：绑定后的 gate 执行与其他层 gate 走同一协议/onFailure/合成实现，无 preset 层特例代码。

### 绑定解析裁决

- preset compile 不依赖某台机器的绑定，因此 required 未绑定不在 compile 期伪报。chain/item 实例创建时解析 effective binding：required 缺失则结构化拒绝创建并点名 gate；optional 缺失空过且发 skip 事件。已存在的 pinned 实例在 daemon 重启时若 required binding 丢失，进入可观察 hold，不回退到 optional、不换脚本。
- 同名绑定采用配置覆盖语义：chain binding 覆盖 global binding；只有一个 effective script 作为 preset 层 gate 执行，不把两份绑定都跑。global/chain 自己声明的普通 hooks 仍按四层合成各自执行，与“为 preset named gate 提供绑定”是两种不同角色。生效视图必须同时显示 selected binding 与 shadowed source，便于审计。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 绑定执行（RFC 行 5 preset 层份额） | fixture preset 声明具名 gate 点，chain 层绑定 fixture 脚本（hold→advance），真跑 | local | 声明点按 preset 层合成顺序执行该 gate；hold/advance 行为与其他层 gate 一致 |
| function | optional 未绑定空过 | optional gate 点零绑定，真跑 | local | 调度照常推进；跳过事件可见 |
| function | required 未绑定 | required gate 零绑定分别创建新实例、恢复既有 pinned 实例 | local | 新实例结构化拒绝创建；既有实例 hold；两者都点名 gate，无 optional fallback |
| function | 层间遮蔽/回落 | 同名 binding 同时置于 global 与 chain 层 | local | 只执行 chain binding；生效视图显示 selected chain + shadowed global；普通 global/chain hooks 不受影响 |
| function | 可分发性质 | grep fixture preset 全文 | local | preset 本体无本机脚本路径 |
| integration | 四层全景合成（RFC 行 5 完整化） | 全局 + chain + preset（绑定）+ item 同挂点各声明一个 gate，其一 hold，真跑 | local | 按 全局→chain→preset→item 顺序执行（脚本记录执行序）；任一 hold 即整点 hold——RFC 行 5 全语义在此行成立 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：hook 声明面的 preset 层间接绑定级——「接口与实现分离」在声明模型上的实例：preset 声明需求（名字），operator 声明供给（绑定），装载期做需求-供给匹配。
2. **全局坐标**：preset 声明域（可分发工件，#740 编译产物）× operator 绑定域（本机全局/chain 声明）→ 装载期匹配 → 生效视图 preset 层成员。两个输入域各自已有边界 parse，本 child 拥有匹配语义与三态结果类型。
3. **类型↔值不漂移**：防值漂移——gate 名在 preset 与绑定两侧是同一标识符空间，匹配结果三态穷尽，不存在「绑了但没被看见」的静默中间态。防类型泄露——本机路径不得进入 preset 域（可分发性质）。
4. **消除的错误类别**：「preset 需要的 gate 漏配且无人知晓」不可表达（三态 + required 裁决语义 + 编译产物暴露）；「preset 携带本机路径失去可分发性」不可表达。

## log/观测义务

- optional 未绑定的空过跳事件（lifecycle/diagnostic 按裁决定）——「为什么这个 gate 点没拦」可从事件流回答。
- required 未绑定按裁决形态产生 load 错误或运行期拒绝事件，点名 gate 名。
- 绑定执行本身沿统一 `hook.*` 事件契约（#712（决策点闭集） 已铺）。

## 依赖关系

- Depends on: #549、#586、#710、#712、#740、#743。
- Blocks: #715。



### #714 feat(engine): join script 判定器与 reopen 派发

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

消费共享 gate core 及 #546 validator/reopen runtime，不自建第二 decision consumer。

join ADT 的 `script` variant 真实化：容器推进点（par join；chain-complete 顶层实例）可绑 script 判定器——decision 经 stdout（script kind）进 #700 的 join 判定通道，reopen 校验后派发 #701 执行；容器点的三词合成（reopen 优先）与多 reopen 冲突裁决落地。

## 问题

#546 join ADT 尚无 `script` variant（已登记的未来方向，准入纪律要求连同全部消费点一次落齐）；#543 gate 决策点闭集的「容器推进/par join、chain-complete」两点未接线——RFC 关闭验证行 8（script gate 的 reopen 判定）无处成立；操作员目标 5 的 gate 场景在容器语境（并行批次质量门）无 script 承载。多 reopen 合成只在容器点存在（其余决策点词表无 reopen），按本 child 已裁规则执行。

## 预期结果

性质表述：

1. **script variant 真实化**：join 声明可取 `script`（绑定形态与 #739/#705 声明面协调，additive）；#700 join 评估的穷尽 switch 处置该 variant——容器全成员 terminal 时 spawn script gate（复用 hook 执行层与 decision 协议），而非 validator leaf。
2. **同一判定契约**：script 判定与 agent-phase validator 走同一 decision ADT 与派发路径——advance 放行、hold 扣住退避重问（指纹泛化机制）、reopen 校验后派发 #701；容器推进点三词全部合法（其余决策点的 `advance | hold` 子集限制不适用于此点）。
3. **corrections 先经 CLI、decision 精确引用**：脚本以 operator 身份先通过带 evaluation scope 的 `item add` 插入纠正 item，再返回 `reopen(target, correctionItemIds)`；stdout 不承载 mutation，只引用既存 item。#701 consumer 在单事务中校验/认领精确 IDs 并执行重开，不把先前 CLI mutation 伪装进同一事务。
4. **chain-complete 实例**：chain-complete 作为顶层 join 可绑 script（#705 声明位迁移落地后验收此半边）。
5. **容器点合成**：同一容器点多 gate 时 reopen 优先于 hold；多个 reopen 指向同一 target 时合并并去重 correction IDs，指向不同 target 时不推进，合成为 hold 并发出包含全部冲突 target 的 diagnostic。不得按声明顺序任选一个 target。
6. **mergedness ground truth 在 GitHub 面，script 判定器自查**（#546 body 供给条款 3 + 「引擎递出面定理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §4/§5）：合并真相（PR 是否 merged、mergeCommit）是 GitHub 面事实，由 script 判定器**经声明通道自查**（脚本内以 operator 身份调 `gh` / GitHub API），不由引擎注入进 payload——「引擎理解 GitHub 字段」违反 L1 红线，边界 1 会话打回「引擎注入 mergedness 进判定 payload」的形态。判定器读得到什么由供给条款 3 与谓词对象决定（引擎自有面：闭包分支上有无工作、发布没发布），mergedness 不在其中。

### 多 reopen 裁决

该问题只在容器推进点存在：相同 target 的 reopen 合并为一次 decision，correction IDs 取稳定顺序去重并集；不同 target 没有可证明安全的隐式优先级，因此合成为 hold + diagnostic，等待 operator 或下一 evaluation 改判。该规则是 decision ADT 的穷尽合成，不使用声明顺序兜底。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | script join advance | par(join=script) 全成员 terminal，fixture 脚本 advance，真跑 | local | 引擎 spawn 脚本（非 agent leaf）；外层 seq 推进 |
| function | script join hold | fixture 脚本首答 hold、重问改答 advance | local | 容器扣住退避重问（指纹防抖事件可证）；改判生效 |
| function | script reopen（RFC 行 8） | fixture 脚本先经带 evaluation scope 的 CLI 插入纠正 item，再 stdout `reopen(target, correctionItemIds)` 精确引用 | local | 纠正 item 追加进 target、seq 游标回退、已 terminal item 状态不变（与 #546 reopen 行同语义，#701 机制承接） |
| function | 非法 reopen target | fixture 脚本 reopen 指向未跑节点 / 跨 seq 节点 | local | 被拒 + 审计事件（#701 运行期校验路径）；容器状态不变 |
| function | reopen 合成 | 分别真跑：一 hold + 一 reopen；两个同 target reopen；两个不同 target reopen | local | reopen 优先于 hold；同 target 合并去重 IDs；不同 target 合成为 hold + diagnostic，容器不推进 |
| function | chain-complete script 实例 | chain metadata 顶层 join 绑 script，chain 全 item terminal | local | 脚本判定 chain 完成/keep-active（#705 落地后验收此行） |
| type | join ADT 穷尽兑现 | `bun run typecheck`（script variant 真实化后全消费点显式处置） | local | 通过；无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：#546 任务代数 join 策略 ADT 的 variant 实现级——统一判定器接口（#543 裁决 5）的 script kind 在容器推进点的落点；#700 是判定通道框架（spawn 判定器、接收 decision、派发），本 child 给该框架加第二种判定器 kind。
2. **全局坐标**：join 声明域（preset 树 / chain metadata 的 script variant）→ 引擎 join 评估域（穷尽 switch）→ hook 子进程域（stdout decision，经 #712（gate 执行） 的边界 parse 回引擎 typed decision）→ #701 reopen 执行域。跨了声明、评估、子进程三条既有边界，零新边界。
3. **类型↔值不漂移**：防值漂移——script 与 agent-phase 两 kind 的 decision 若各自定义即契约分裂；同一 typed decision 与同一派发路径封死。防类型泄露——script variant 的绑定形态不得把 hook 执行细节（脚本路径语义）泄进 join ADT 之外的调度类型。
4. **消除的错误类别**：「同一容器两种判定器行为不同」不可表达（同契约同派发）；「script 判定绕过 reopen 校验」不可表达（走 #700→#701 唯一通道）；「variant 被 default 静默吞掉」不可表达（穷尽 switch 兑现）。

## log/观测义务

- script join 判定沿 `hook.*` decision 事件契约（决策点标识 = 容器推进点，含容器 id）。
- reopen 派发/拒绝沿 #700/#701 的审计事件契约，本 child 不新增第二套。

## 依赖关系

- Depends on: #700、#701、#710、#712。
- Blocks: #715。



### #715 docs(v3): hook 与 gate 冻结 SHA 综合验收

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

唯一综合验收 owner；在 correction subtree 可运行的 #546 runtime 到位后执行 operator scenario。

hook 树收尾：操作员验收场景端到端真跑（RFC 行 3）、hook 作者文档（挂点/payload/decision/声明位，枚举内容从代码派生 + 测试守护）、引擎 gate 策略业务字面量全局守护（RFC 行 7）、RFC 关闭复核的证据映射。

## 问题

各 children 分片验收不等于操作员场景整链成立（gate → evaluation-scoped 检查 leaf → hold → 检查/修复完成 → advance）；hook 面无作者文档——「接口和能力」只存在于 issue 与源码；「引擎无 gate 策略业务字面量」是全局性质，各 child 切片 grep 不能替代全局守护。

## 预期结果

1. **操作员验收场景端到端成立（RFC 行 3 全语义）**：post-run gate 脚本按 payload 轮数达阈值 → 在同一 evaluation scope 创建检查 leaf → 返回 hold 扣住原决策点 → 检查 agent 经 createItems 派生修复 leaf → 检查/修复全部完成后返回 advance → 原 seq 才继续。全链真跑，事件序列可证；不得以队列 position 抢跑冒充 gate。
2. **hook 作者文档**：声明位四层、observer 挂点（事件词表引用）、gate 决策点闭集、payload schema、decision 协议与 onFailure、重放语义与幂等边界（评估代次、同代次重放的幂等吸收、I4 孤儿残留边界、gate 脚本对评估输入确定化的作者义务、引擎外副作用（GitHub comment 等）不受队列侧协议保护的提醒——#712）、能力契约（CLI mutation + operator 身份）、tick 节流与具名 gate 绑定、**闭包转移边事件词表**（#586 扩充）与**「转移边 observer-only、决策点闭集不扩」边界**（#546 body「资源模型公理·hook 挂点」+ 权威记录 `v3/closure-lifecycle-decision.md` §2；观测通道归 observer，阻止挂起走 #712 run post-exit gate hold）——枚举性内容从代码/schema 派生或测试守护，手写计数 drift 时测试红。
3. **全局守护（RFC 行 7）**：测试级守护「引擎源码无轮数阈值/检查任务类 gate 策略业务词」；引擎只含挂点、payload、decision 协议。
4. **RFC 关闭复核**：#543 的 8 行关闭验证 → children 验收证据的映射登记（本 issue 或 #543 comment），支撑 RFC 关闭。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 操作员场景（RFC 行 3） | 声明 post-run gate（fixture：轮数阈值 → evaluation-scoped `item add` 检查 leaf → hold；检查/修复完成后 → advance），多轮任务树真跑 | local | hold 期间原 seq 绝不推进；检查 agent 派生修复成功且全部完成后才继续；移除/改变 position 不影响正确性；事件序列完整可证 |
| function | 阻止挂起走 run post-exit gate hold（#546 转移边 observer-only 边界） | 声明 run post-exit gate hold（fixture 脚本首答 hold 次答 advance），观察某闭包在 phase 推进离开处 | local | hold 期间闭包不挂起（推进被扣，闭包停 active）；advance 后正常挂起进闭包分支；事件序列证「阻止挂起 = 推进被扣」而非「转移边被 gate」 |
| function | 文档派生守护 | `bun test`（文档清单守护测试） | local | 挂点清单/payload 字段/决策点闭集与代码同步；人为制造 drift 时测试红 |
| assumption | 业务字面量守护（RFC 行 7） | 守护测试 + 人工 grep 复核引擎源码 | local | 引擎无轮数/检查任务类 gate 策略词；只有挂点与协议 |
| assumption | RFC 关闭映射 | 查本 issue / #543 thread 的证据映射登记 | GitHub | 8 行关闭验证逐行指向 children 验收证据 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 伞 #543 的关闭终态条件（本 issue 复核对象）

以下是伞 #543 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | observer hook 在事件发生时被调用且元数据经 stdin 传入；自反订阅不可表达 | 声明 observer 订阅 `agent.exit` 并跑一个 run；另声明订阅 `hook.*` | `agent.exit` 脚本收到含该 run 元数据的 JSON且调度不受影响；`hook.*` 声明装载期拒绝且发射期零派发 |
| 2 | gate hook 能 hold 调度决策 | post-run gate 返回 `hold` | 该 chain 不选下一个 item，事件流可见 hold；返回 `advance` 后恢复 |
| 3 | 操作员验收场景成立 | post-run gate 脚本算轮数、达阈值后在同一 evaluation scope 创建检查 leaf 并 `hold`；检查/修复 leaf 完成后再 `advance` | hold 期间原 seq 不推进；检查 leaf 及其派生修复 leaf 全部完成后才恢复；正确性不依赖全局 `(position, id)` 排序 |
| 4 | `onFailure` 两种语义都成立 | 同一挂点分别声明 `hold` / `advance` 的必崩脚本 | `hold`：决策点退避重问且事件可见；`advance`：记 diagnostic 后放行 |
| 5 | 四层声明位与合成语义成立 | 全局+chain+preset+item 同挂点各声明一个 gate | 按 全局→chain→preset→item 顺序执行，任一 hold 即 hold |
| 6 | hook 执行可观测 | 跑 1/2/4 各场景后查事件流 | 每次 hook 执行有 `hook.*` 事件（开始/结束/失败/decision） |
| 7 | 引擎无 gate 策略业务字面量 | grep 引擎源码中轮数/检查任务等词表 | gate 策略全在 operator 脚本；引擎只有挂点与协议 |
| 8 | script gate 的 reopen 判定 | 容器推进点 gate 先经带 evaluation scope 的 CLI 插入纠正 item，再返回 `reopen(target, correctionItemIds)` | 精确 IDs 被校验并认领；target 重开、seq 游标回退、已 terminal item 状态不变；预插入 mutation 不被伪称为 decision 消费事务的一部分 |

## 架构切片

1. **系统定位**：hook 树的收尾对齐级（#708 同构）——机制全部在上游，本 child 交付整链组合验收、作者文档面、约束的持久执法（守护测试）。
2. **全局坐标**：无新域边界；文档是引擎 typed 事实（挂点 union、payload schema、decision ADT）向 operator 阅读域的派生投影——派生方向单一，防手写副本。
3. **类型↔值不漂移**：防值漂移——文档中的枚举清单是代码的派生视图 + 测试守护，不是第二份手写事实。
4. **消除的错误类别**：「文档与实现漂移无人发现」不可表达（守护测试红）；「gate 策略业务语义悄悄溜进引擎」从 review 约定升级为测试执法。

## log/观测义务

- 无新事件义务（组合验收消费上游 children 已铺的 `hook.*` 事件面；场景验收本身以事件序列为证据）。

## 依赖关系

- Depends on: #710、#711、#712、#713、#714、#698、#700、#701。
- Blocks: #543 closure。



---

## 三、已落地 children（CLOSED·COMPLETED，含关闭证据）

### #586 feat(engine): v3 hook 声明模型——四层声明位装载合并与生效视图

- state: **CLOSED·COMPLETED（已落地）** | author: `RiriAgent` | created: 2026-07-02
- closed: 2026-07-15
- 关联: referenced `c0be249f653d`, referenced `24365a19ce45`, referenced `95d604ba07bf`, referenced `16511ff5e05f`, referenced `45787d3ab45e`, referenced `288a77ec1e17`, referenced `79e9d4c99bae`, referenced `e25885122eaa`

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "**声明位**：四层全支持——全局 loop-data root、chain 级（metadata）、preset 级（抽象 gate 点，接口与实现分离）、item 级。" — #543 设计裁决 4

> "四层声明位（裁决 4）。同一挂点多层命中时全部执行，顺序 全局 → chain → preset → item；gate decision 合成为「任一非 advance 即不放行」（AND 放行）；hold 与 reopen 并存时 reopen 优先，多 reopen 并存的冲突语义见开放问题。preset 级是抽象 gate 点：preset 只声明「此处需要一道命名 gate」（保持 preset 可分发、不含本机脚本路径），具体脚本由全局/chain 层绑定到该名字；声明语法归 RFC-2 的 DSL（见接口假设）。" — #543 声明位与合成语义

> "**observer**：订阅生命周期事件，异步旁路执行，不影响调度；失败只记 diagnostic 事件。挂点 = observability 事件类型枚举（hook 点清单不另发明命名，直接复用事件类型词表；事件枚举扩张时 observer 挂点面自动扩张）。" — #543 核心设计·两类 hook

> "**gate**：挂在调度决策点上……gate 决策点是引擎内禀闭集（与事件枚举分列）：至少含 run pre-spawn、run post-exit（下一次选择前）、item 状态转移、容器推进/par join（#546 判定点）、chain-complete（吸收现有 trigger 先例；#546 定性为顶层 join 实例）、daemon startup/shutdown、tick（须带节流声明才可挂）。" — #543 核心设计·两类 hook

> "每 hook 声明超时；超时/崩溃按其 `onFailure` 声明走 `hold`（该决策点退避重问，事件流可见）或 `advance`（记 diagnostic 后放行）。" — #543 执行模型

> "gate hold 状态与 hook 声明清单（四层合成后的生效视图）进 status 快照新增的 hooks 节，并入 #544 已裁的快照 boundary 收紧工作。" — #543 跨 RFC 接口假设·RFC-5

## 目标

hook 声明的 typed 模型（observer|gate、挂点、脚本、超时、onFailure）与四层声明位的装载、校验、合并——产出供执行 children 与 #575 消费的单一 typed 生效视图；本 child 不拥有 `StatusSnapshotBoundary` 或 `status --json` 投影。

## 使用场景

- operator 在全局 loop-data root 或 chain 级声明 observer/gate hook；声明装载后，引擎内部得到四层合成的 typed 生效视图（哪个挂点有哪些 hook、来自哪层、执行顺序），执行 children 只消费该视图；`status --json` 与 GUI 投影唯一归 #575。
- 基座 child：observer 派发、gate 评估、具名 gate 绑定各 child 只消费生效视图，不各自读原始声明——本 child 是 hook 声明的唯一事实源。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- hook 机制不存在：`grep -rn "hook" src/ --include="*.ts"` 全部 7 处命中均为注释里对既有函数的口语化指代（如 `src/loop.ts:5632`），无任何注册机制（2026-07-02 核实）。
- chain 级声明载体先例：`ChainMetadata`（`src/runtime-data.ts:105`，12 字段 + `CHAIN_METADATA_KEYS` 白名单 `src/runtime-data.ts:246-259`）——`maxItemAttempts` / `coderLoopChainCompleteTrigger` 是「参数归元数据」先例。
- 全局层持久化先例：`rate-limit.json`（路径构造 `src/daemon.ts:922-927`、读 `:930`、写 `:985`）——daemon 级独立文件、刻意不进 db.sqlite；loop-data root 解析 `resolveLoopDataRoot`（`src/runtime-paths.ts:98`）。
- observer 挂点词表 = `ObservabilityEventTypeBoundary`（`src/observability.ts:24`，44 成员 union，五 kind `src/observability.ts:16`）；gate 决策点闭集 = #543 挂点清单（引擎内禀，与事件枚举分列）。
- **闭包转移边入 observer 事件词表**（#546 body「答复 #543（RFC-4）」节 2026-07-10 修订 + 权威记录 `v3/closure-lifecycle-decision.md` §2「hook 挂点」）：闭包生命周期转移边六事件 `closure.create` / `closure.run-spawn` / `closure.run-exit` / `closure.suspend` / `closure.reopen` / `closure.consume`（具体命名归事件词表落地时裁）作为新事件类型进入 `ObservabilityEventTypeBoundary` 后，本 child 的声明模型须能表达对它们的 observer 订阅（依「observer 挂点类型直接引用事件类型词表」自动扩张，本 child 零字面量）。**gate 决策点闭集不因此扩大**——转移边 observer-only，不可 gate（副作用上放 gate 即发明第二推进语义）；相关合成半边归 #590。
- item 级载体候选：items 表 `extra` 透明字段（#419 先例）——载体裁决是本 child 显式决策项。
- status 快照：`StatusSnapshotBoundary`（`src/loop.ts:490`，顶层匿名 `"object"` 槽的整体收紧归 #544 的快照 boundary 收紧 child）、`buildCoderLoopStatusSnapshot`（`src/loop.ts:2724`）。

## 问题

#543 的一切执行语义都以「引擎知道哪里挂了什么 hook」为前提；当前引擎没有任何 hook 声明面——四层声明位（裁决 4）与合成顺序（全局→chain→preset→item）无载体，执行 children 无从启动。

> "**hook 机制不存在**：全仓无注册回调点、无 preset 侧脚本声明、无 pre-spawn/post-exit/pre-transition 扩展点" — #543 现状事实

## 预期结果

性质表述：

1. **声明是穷尽 ADT**：`observer(事件类型) | gate(决策点)` 判别 union + 脚本路径 + 超时 + gate 的 `onFailure = hold | advance`；新增声明 kind / 挂点 variant 时编译器暴露全部处置点，无 default 兜底。observer 挂点类型直接引用事件类型词表（词表扩张时挂点面自动扩张、hook 侧零代码变更）；gate 决策点是引擎内禀闭集类型。
2. **四层装载合并**：全局（loop-data root 载体）+ chain（metadata）+ item 三层直接声明装载合并为单一生效视图，顺序保持 全局 → chain → preset → item；preset 层在视图中是具名 gate 点占位 variant（声明来自 #555 编译产物、绑定解析归#591（具名 gate）——本 child 只留穷尽 variant 位）。一切执行侧消费该视图，不重读原始声明。
3. **边界 parse 与装载拒绝**：声明经 arktype 边界 parse；非法声明装载期拒绝并点名——未知事件类型、未知决策点、gate 缺 onFailure，以及 **`hook.*` 自反挂点**（本 child 裁决：observer 不得订阅 `hook.*` 事件类型——hook 执行事件再派发 hook 构成无限自激励回路，与 #543「异步旁路执行，不影响调度」直接冲突；hook 观测 hook 的需求已由事件流查询面覆盖。裁决记录见本 thread）。
4. **投影输入契约**：生效视图是精确 typed ADT，可被 #575 直接投影为 `status --json` hooks 节，不需要重读或重新解释原始声明；本 child 不修改 `StatusSnapshotBoundary`。声明存在不改变任何调度行为（执行归后续 children）。
5. **写入面 operator 专属**：hook 声明（含后续具名 gate 绑定）的一切写入通道对 agent 主体 deny——agent 可改 hook 声明 = agent 可自行解除 gate，破坏 gate 的存在意义。与 #546 的判定权保护原则同构：定义态 join 实例内不可变，物化态 join 只能经 #564 的独立版本化演化通道改变；hook 声明同样不得落入 agent 可自行解除的普通写入面。本 child 的声明载体从第一天起归为 operator-only，拒绝留审计事件。

### 显式决策项（落地时裁，裁决留本 thread）

- RFC 开放问题逐字："item 级 hook 的声明载体与寿命（item 是消耗品，声明随 item 终态失效的清理语义）。"
- 全局层声明载体形态（loop-data root 下的文件名/格式）——RFC 只裁「全局 loop-data root」层存在，载体形态归本 child（`rate-limit.json` 独立文件先例可参照）。

## 不应残留

- 本 child 范围内：hook 声明以匿名 JSON / 裸 string 透传；生效视图之外的第二套声明读取路径；在本 child 内直接修改 `StatusSnapshotBoundary` 或另造 hooks 快照投影。
- 本 issue 范围之外不应改动：hook 进程执行（spawn/stdin/decision，归 observer/gate children）；具名 gate 点的绑定解析与未绑定语义（归#591（具名 gate））；#555 的声明语法与编译产物 shape；全部快照投影（hooks 节归 #575，其余匿名槽收紧归 #574）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 引擎无 gate 策略业务语义（#543 约束逐字）："引擎不含任何 gate 策略业务语义：轮数阈值、检查任务内容、插队位置全在 operator 脚本内；引擎只提供挂点、元数据、decision 协议"。
- hook 身份裁决（#543 裁决 3）："operator 全权——hook 子进程无凭证调 CLI，走操作员路径，不新增第三类主体。"——声明模型不引入凭证字段或第三类主体。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 四层声明合成视图 | 用声明装载测试读取 typed effective view | local | 视图呈现各挂点合成清单，来源层与顺序（全局→chain→preset→item）可见；不经 status 快照反推 |
| function | 非法声明装载拒绝 | 分别声明：未知事件类型 observer、未知决策点 gate、缺 onFailure 的 gate、订阅 `hook.*` 的 observer | local | 均装载期拒绝且错误点名违规字段 |
| function | 声明零执行副作用 | 声明 hook 后真跑一轮 | local | 调度行为与未声明时一致；无任何脚本被 spawn |
| function | agent 写入被拒 | 以 agent 主体（run-scoped 凭证）尝试写 hook 声明 | local | 被拒 + 审计事件；operator 路径写入成功 |
| type | 声明 ADT 穷尽 | `bun run typecheck`；临时向声明 union 加一个 kind variant 观察编译错误面 | local | typecheck 过；新增 variant 使全部处置点报错，无 default 吞掉 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 无（本树地基 child，先行）。
- Blocks: #588（observer 执行）、#589（gate 执行）、#591（具名 gate）、#575（status hooks 投影）。
- 协调边：#555（preset 级 gate 点声明经编译产物进入生效视图的占位读取，本 child 不硬依赖——占位 variant 先行，内容随 #591 填充）；#590 拥有 `GateDecisionPoint` 的接线语义，本 child 只引用同一共享 ADT，不复制 point 词表。



---

## 四、已替代草稿（CLOSED·NOT_PLANNED，仅摘要）

- #587 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): hook 全量元数据 stdin payload——编译产物投影与运行态快照契约 — hook stdin 的「全量元数据」typed payload 契约与单一组装函数：触发上下文 + #547 编译产物投影 + 运行态快照，三块类型全部从既有 schema 派生，零平行 shape。
- #588 [CLOSED·NOT_PLANNED（已替代草稿）] feat(daemon): observer hook 执行——事件订阅派发与异步脚本执行层 — observer hook 端到端执行：事件发射点派发 → 异步 spawn 脚本 → stdin 写 payload → 超时回收 → 失败只记 diagnostic；同时建立 observer/gate 共用的 hook 进程执行层（spawn/stdin/超时/并发语义）。
- #589 [CLOSED·NOT_PLANNED（已替代草稿）] feat(scheduler): script gate 执行与 decision 协议——run post-exit 决策点端到端 — script gate 在第一个决策点（run post-exit，下一次选择前）端到端成立：spawn（复用 hook 执行层）→ stdout decision JSON 边界 parse（三词 ADT + 可选 reason）→ onFailure 折叠 → 决策点消费（advance 放行 / hold 扣住退避重问）。
- #590 [CLOSED·NOT_PLANNED（已替代草稿）] feat(scheduler): gate 决策点闭集接线——全点物化、tick 节流与 hold 指纹泛化 — gate 决策点从单点（post-exit）扩到闭集全点：run pre-spawn、item 状态转移、daemon startup/shutdown、tick（带节流声明）；hold 幂等指纹从 chain-complete 先例泛化为通用机制并收编既有复用点；四层合成在全部决策点走同一代码路径。（容器推进/par join 与 chain-complete 两点经 #592（join script） 通道，分工见「不应残留」。）
- #591 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): preset 级具名 gate 点——绑定解析与未绑定语义 — preset 声明的具名 gate 点获得执行语义：全局/chain 层绑定声明（gate 名 → 脚本 + 超时 + onFailure）、运行期在声明点解析绑定并执行 gate、未绑定语义（optional 空过；required 在实例创建边界拒绝；已存在实例恢复时缺绑定则显式 hold）。
- #592 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): join script 判定器——容器推进点 script gate 与 reopen 派发 — join ADT 的 `script` variant 真实化：容器推进点（par join；chain-complete 顶层实例）可绑 script 判定器——decision 经 stdout（script kind）进 #561 的 join 判定通道，reopen 校验后派发 #562 执行；容器点的三词合成（reopen 优先）与多 reopen 冲突裁决落地。
- #593 [CLOSED·NOT_PLANNED（已替代草稿）] docs(v3): 生命周期 hook 收尾对齐——操作员验收场景、作者文档与字面量守护 — hook 树收尾：操作员验收场景端到端真跑（RFC 行 3）、hook 作者文档（挂点/payload/decision/声明位，枚举内容从代码派生 + 测试守护）、引擎 gate 策略业务字面量全局守护（RFC 行 7）、RFC 关闭复核的证据映射。
- #599 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): gate 评估代次与幂等协议——mutation 重放安全与 decision 消费原子性 — gate 评估获得持久化的代次身份与消费状态机；CLI mutation 面在 gate 评估语境下获得确认式幂等（重放返回首次结果，零副作用）；script decision 自 stdout parse 成功起进入共享 journal，消费与其全部引擎侧效果原子；daemon 重启恢复不重复消费、不丢已判定的 decision。journal/consumer 必须保留精确的 typed ingress 扩展边界，使 #561 只能把 validator CLI admission 接入同一协议，而不能复制状态机。

---

## 五、关键评论摘录（≥200 字符的决策性回复）

#### #586 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：三层模型（CLAUDE.md L1/L2/target）中 L1 引擎新增的 hook 声明面——「机制归引擎、参数归声明」在 hook 维度的参数半边；引擎持有声明 schema 与合成规则（机制），挂什么脚本在哪层全归 operator 声明（参数）。
2. **全局坐标**：operator 声明域（不可信输入：全局文件 / chain metadata / item extra）→ arktype 边界 parse → 引擎 typed 生效视图域 → status 快照投影（外部消费者域）。信任级在 parse 点一次升格，视图是 typed 域的合成产物、快照是其投影，无二次 parse。
3. **类型↔值不漂移**：防值漂移——四层原始声明若被执行侧各自读取即出现同一声明多处解释；生效视图作为唯一消费面封死。防类型泄露——observer 挂点类型引用事件词表本身而非复制枚举，词表演进零同步代码。
4. **消除的错误类别**：「执行侧对声明的解释不一致」不可表达（单一视图）；「声明了却静默无效」不可表达（未知挂点装载期拒绝）；「hook 自激励回路」不可表达（自反挂点声明期拒绝）。

## log/观测义务

- 装载期拒绝沿既有 preset load 失败形态（错误点名，`status --json` 可体现 invalid 状态）；无新增运行期事件义务（hook 执行事件归执行 children）。
- hooks 节进 status 快照是本 child 的观测交付物本体。


#### #586 评论 by `RiriAgent` (2026-07-02)

## 决策记录：observer 自反挂点（`hook.*`）声明期拒绝

body 预期结果 3 所引裁决的依据展开（#543 拆解会话当场裁决，2026-07-02）：

- **问题**：#543 已裁「observer 挂点 = observability 事件类型枚举，事件枚举扩张时挂点面自动扩张」；本树新增 `hook.*` 事件类型后，按字面 observer 可订阅 `hook.start` 一类事件——hook 执行发事件、事件再派发 hook，构成无限自激励回路。
- **裁决**：observer 挂点词表 = 事件类型枚举 **减去 `hook.*` 子集**；订阅 `hook.*` 的声明装载期拒绝，事件发射路径对 `hook.*` 类型零派发（双层防护，#588（observer 执行）承接发射期半边）。
- **依据**：自激励回路与 #543「异步旁路执行，不影响调度」直接冲突（进程风暴挤占调度资源即影响调度）；「hook 观测 hook」的真实需求已由事件流查询面（`coder-loop logs` / events JSONL）覆盖，无场景损失。「挂点面自动扩张」的设计意图是「事件词表演进零 hook 侧同步代码」，减去固定自反子集不破坏该意图。
- **可判定性**：手头事实（回路必然失控）+ 全局求解（禁订阅无场景损失）可靠判定，按 decision-closure 当场裁，不回传操作员。


#### #586 评论 by `RiriAgent` (2026-07-13)

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-11T08:48:26Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
- Investigated source revision: `f01560d5d0b324e791db7f599e502f09fc78a652` (`origin/main`, observed 2026-07-13).

## Deliverable

`implementation-pr`

Implement the declaration foundation only: an exhaustive typed hook declaration model, boundary parsing, the four-layer load/merge path, and one effective-view constructor consumed by later execution/projection children. Do not implement hook process execution, stdin/decision protocol, named-gate binding resolution, gate scheduling semantics, or `StatusSnapshotBoundary`/GUI projection; those remain owned by #588, #589, #591/#590, and #575 respectively.

The two issue-level open carrier decisions are resolved for this implementation as follows:

1. Global declarations live in one versioned JSON document at `<loop-data-root>/hooks.json`, resolved from the same root as `db.sqlite` and `rate-limit.json`; malformed or unknown content is a load error, never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations have the same lifetime as the item record: they remain attached through actionable/final states and disappear only when that item record is deleted. `hooks` is a control-plane field: operator writes are accepted, while every run-credential/agent mutation path is rejected and emits the existing field-write/caller-admission audit evidence.
3. Preset participation is an explicit named-gate-placeholder variant in the effective-view algebra. This PR supplies the exhaustive variant/merge slot but does not parse #555 syntax or resolve bindings; those behaviors remain #555/#591 work.
4. Effective ordering is stable `global -> chain -> preset -> item`, retaining source-layer provenance. Observer declarations reference the exported observability event-type boundary/type rather than copying its literals; the admissible observer point is that vocabulary minus `hook.*`. Gate decision points have one exported closed ADT shared with #590, not a second string list.

Current-tree anchors: `ChainMetadata` and `ItemExtra` are the typed persistence carriers (`src/runtime-data.ts:105`, `src/runtime-data.ts:155`); their known-key and serialization paths are centralized (`src/runtime-data.ts:255`, `src/runtime-data.ts:339`, `src/runtime-data.ts:406`); loop-data root resolution is centralized (`src/runtime-paths.ts:100`); the observability vocabulary currently has one arktype boundary (`src/observability.ts:24`); and agent item mutations already pass caller plus per-field admission (`src/daemon.ts:2707`, `src/daemon.ts:3818`).

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures prove global/chain/preset-placeholder/item entries converge through one constructor in exact source order with provenance retained. |
| C2 | function: boundary rejection | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; separate fixtures reject unknown observer event, unknown gate decision point, gate missing `onFailure`, malformed timeout/script, and observer subscription to every `hook.*` event, with the failing field named. |
| C3 | function: declaration-only, zero spawn | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; loading valid declarations and running a scheduler tick preserves ordinary scheduling and spawns no declared hook executable. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item declaration paths succeed; run-scoped credentials cannot write/patch/clear `hooks`, and denial is present in the existing caller/field-write audit stream. |
| C5 | persistence and lifetime | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global JSON plus chain/item declarations round-trip exactly; restart reloads the same effective view; item terminal-state changes do not delete item hook declarations. |
| C6 | type and schema integrity | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and complete unit/smoke suite pass. Tests may demonstrate exhaustiveness with compile-time fixtures, but must not weaken existing assertions. |
| C7 | pattern: no parallel/untyped declaration shape | shell | `rg -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b' src` in repository root; local env | Exit `0`; declarations/boundaries/effective-view construction converge in the hook declaration module plus typed carrier/path/daemon integration sites; no execution implementation or status snapshot projection appears. |
| C8 | pattern: red-line type constructs | shell | `git diff origin/main -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. |
| C9 | canonical runtime | shell | `bun scripts/real-e2e.ts` in repository root; authenticated `gh`, runner CLIs on `PATH`; use the script-owned isolated loop-data root | Exit `0`; transcript reports the fixture PR `MERGED`, fixture issue `CLOSED`, and teardown/tripwire success. |

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One dedicated hook declaration module and its focused test; imports at carrier/loader/admission integration boundaries only | Exactly one declaration ADT, one parser boundary, one gate-point ADT, and one effective-view constructor. All consumers import them; no copied unions or switch defaults. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, typed persistence carriers in `src/runtime-data.ts`, daemon/global loader and operator admission wiring, focused tests | Global/chain/item raw inputs are parsed once and merged once. No scheduler/execution/status-projection behavior is introduced. |
| `whole-tree` | observability event literals used as observer hook points | `src/observability.ts` is the event vocabulary authority; hook module may derive/filter its exported boundary/type | Zero copied observer-event string unions; adding an observability event reaches the observer declaration type automatically, with the structural `hook.*` exclusion remaining enforced. |
| `whole-tree` | agent-writable `hooks` | Operator-only global/chain control plane and operator branch of item mutation admission | Zero preset-grantable or agent-credential path can create, replace, patch, or clear hook declarations. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile` when dependencies are not already materialized; verify active GitHub account is `RiriAgent` and required runner binaries are on `PATH`.
- Start: no new standalone service is introduced. The target-mandated real driver is `bun scripts/real-e2e.ts`; it creates and owns an isolated daemon/loop-data root and a real GitHub fixture issue.
- Readiness: the driver must report its isolated daemon ready before seeding/scheduling the fixture.
- Behavior: first exercise declaration load/merge/rejection and operator-only writes through the focused integration tests; then run the real driver through daemon spawn, iteration, review, merge, and issue closure. A declaration-only fixture must prove the declared script is never spawned in this child.
- Logs: retain the real-E2E transcript and the script-reported isolated run/event paths in PR evidence. Required terminal observations are PR `MERGED`, issue `CLOSED`, and successful tripwire/teardown.
- Stop ownership: `scripts/real-e2e.ts` owns daemon shutdown, fixture teardown, and isolated artifacts. Do not stop or mutate the production daemon under `~/.coder-loop`.

## Test delta

`required`

Add focused declaration-model/boundary/merge tests and daemon integration coverage for persistence, restart reload, operator allow, agent deny plus audit, and zero execution side effects. Existing tests and assertions remain intact; tests must not permit unknown declarations, silent defaults, copied event/decision vocabularies, or a second effective-view construction path merely to obtain green results.

## Dependencies

- No implementation blocker and no prerequisite merge: the issue explicitly marks this as the foundation child, and the current GitHub graph reports no `blockedBy` nodes. Parent #543 is open: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- #555/#591 are coordination edges only. This PR reserves the typed preset-placeholder variant, but does not ingest or bind future named-gate syntax: https://github.com/mouriya-s-lab/coder-loop/issues/555 and https://github.com/mouriya-s-lab/coder-loop/issues/591.
- #590 must consume the same exported `GateDecisionPoint` ADT when it wires decision sites; it must not introduce another point vocabulary: https://github.com/mouriya-s-lab/coder-loop/issues/590.
- This issue blocks execution/projection children #588, #589, and #575; their current open state does not block declaration-model delivery: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- There is no existing issue PR, no closing PR reference, and no existing executable-contract marker as observed from the complete issue metadata/comments/timeline on 2026-07-13.

## Supersedes

none


#### #586 评论 by `RiriAgent` (2026-07-15)

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-15T12:58:28Z` (`lastEditedAt`, re-read from live GitHub).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
- Investigated revisions: `55ff3b2b7345a8e3d975934a53997d074aa02380` (`origin/main`) and existing PR head `0172878adc88c58f5c57a7d2d7db1b08d01f5a29`, observed 2026-07-15.

## Deliverable

`implementation-pr`

Continue the existing branch `coder-loop/v3-586-6ac101ef751a` and PR https://github.com/mouriya-s-lab/coder-loop/pull/672. Deliver only the hook declaration foundation: an exhaustive typed `observer | gate` declaration ADT, strict boundary parsing, global/chain/preset-placeholder/item loading and stable merge with provenance, and one typed effective-view entry for downstream execution/projection children.

The carrier decisions remain:

1. Global declarations are one versioned JSON document at `<loop-data-root>/hooks.json`; malformed JSON, unknown fields, and invalid declarations fail loading and are never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations live with the item record across actionable and terminal statuses and disappear only when the item record is deleted.
3. Preset participation is a typed `named-gate-placeholder` effective-view variant only. Parsing #555 syntax and resolving its binding remain #555/#591 work.
4. Effective order is exactly `global -> chain -> preset -> item`, retaining source-layer provenance. Observer points derive from the shared observability vocabulary with structural `hook.*` exclusion; gate points have one closed exported value/type authority shared with #590.
5. Every declaration write path is operator-only. Run credentials cannot create, replace, patch, indirectly clear, or directly clear hooks; each rejection uses the existing admission audit stream.

Do not implement hook execution, decision stdin/protocol, named-gate binding, gate scheduling, a positive hooks status section, or GUI projection. Those remain owned by #588, #589, #590/#591, and #575. Current source anchors are `src/hook-declarations.ts:8-47,56-169`, `src/runtime-data.ts:105-176,263-299,349-443`, `src/daemon.ts:233,1095-1124,3965-3980,5101-5124`, and `src/observability.ts:25-135,731-732,825-826`.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures reach the single typed constructor and show exact `global -> chain -> preset -> item` order plus provenance. |
| C2 | function/type: strict boundary and vocabulary evolution | shell | `bun run typecheck && bun test src/hook-declarations.test.ts src/observability.test.ts` in repository root; local env | Exit `0`; unknown observer/gate points, missing gate `onFailure`, invalid tick throttle, malformed script/timeout, undeclared fields, and `hook.*` observer subscriptions are rejected by named fields. A compile-time fixture must prove that adding a synthetic non-`hook.*` event needs no hook-side synchronization while a synthetic `hook.*` event remains excluded, with no cast or copied event union. |
| C3 | function: declaration-only zero execution | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; a valid declaration loads, ordinary scheduling reaches its existing terminal behavior, and the declared sentinel executable is never spawned. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item writes work; run-credential add, batch-add, replace, patch, direct clear, and omission-based indirect clear are denied and audited. |
| C5 | persistence/boundary: lifetime and projection separation | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global/chain/item declarations round-trip, daemon restart reloads the same effective view, terminal status retains item hooks, raw hooks remain absent from all public item/run status surfaces, unrelated explicit `null` persists, own `__proto__` is rejected, and only operator `hooks: null` clears hooks. |
| C6 | environment: complete local gate | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and the complete unit/smoke suite pass with no removed, renamed, skipped, weakened, or timeout-relaxed pre-existing test. |
| C7 | architecture: complete Pattern inventory | shell | `rg -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b|ObservabilityEventType|parseObservabilityEventType' src` in repository root; local env | Exit `0`; every match is classified against all Pattern rows below, with no parallel declaration/event authority, execution implementation, positive hooks status projection, or agent-writable hooks path. |
| C8 | type red lines | shell | `git diff "$(git merge-base HEAD origin/main)" HEAD -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root after `git fetch origin main`; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. The comparison is pinned to the PR merge base, not a moving two-dot `origin/main` diff. |
| C9 | process integration: existing engine behavior | shell | `bun scripts/engine-integration.ts` in repository root; local env with Bun and Git on `PATH`; script-owned isolated loop-data | Exit `0`; transcript shows isolated daemon socket readiness, real CLI/socket/spawn/admission/worktree/SQLite progression, terminal item, reclaimed worktree, no orphan, and teardown. This is the strongest process-level runtime check authorized for #586 and must not be described as real E2E. |

No browser row applies: this is a pure engine/CLI change and browser evidence is not required.

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One hook-declaration authority, its compile-time/focused tests, and typed imports at persistence/daemon integration boundaries | Exactly one declaration ADT, strict parser, gate-point authority, exhaustive conversion path, and effective-view constructor. No copied union, catch-all/default, cast, or second merge path. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, hook declaration loader, typed chain/item persistence, daemon load/effective-view/admission wiring, status omission boundary, and focused tests | Raw inputs parse once and merge once; persistence remains distinct from public status output. No hook execution or positive `StatusSnapshotBoundary`/GUI projection is introduced. |
| `whole-tree` | `ObservabilityEventType|parseObservabilityEventType|ObserverHookPoint|hook\.` | `src/observability.ts` as the sole event vocabulary/parser authority; hook declaration code may derive and structurally narrow its observer point type; focused compile/runtime tests | Zero copied event literal union. A new non-`hook.*` observability event automatically becomes an observer point; a new `hook.*` event automatically remains unrepresentable/rejected without editing hook declarations. The current `src/hook-declarations.ts:109-112` full-union return must converge to that invariant. |
| `whole-tree` | `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS|collectProtectedItemUpdateFieldKeys|assertItemAddRightsForCaller|\bhooks\b` | Central daemon control-plane classification plus operator branch and focused admission tests | Zero preset-grantable or run-credential path can create, replace, patch, directly clear, or indirectly clear hooks; operator writes preserve unrelated extra/null/reserved-key semantics. |

## Canonical runtime

- Setup: run `bun install --frozen-lockfile` when dependencies are not materialized; use the repository root and existing local Bun/Git binaries.
- Start: the authorized process-level driver for this issue is `bun scripts/engine-integration.ts`. It creates a run-owned local git fixture and isolated loop-data root, then starts its own daemon. No standing service or TCP port is introduced.
- Readiness: require the driver transcript to report the isolated daemon socket ready before chain/item operations.
- Behavior: execute C1-C8 first, then C9 to prove the declaration changes preserve the real daemon/CLI/socket/spawn/admission/worktree/SQLite process path. Declaration-specific behavior is proved by C1-C5; C9 is the repository process gate and is not evidence of real-agent/GitHub business completion.
- Logs: retain the literal command, exit status, stdout/stderr transcript, and script-reported run/event paths in the VerificationPacket/PR evidence.
- Stop ownership: `scripts/engine-integration.ts` owns daemon shutdown, fixture/worktree cleanup, and orphan checks on success or failure. Do not touch the production daemon or `~/.coder-loop` runtime.
- Explicit exclusion: the repository real-E2E driver is `bun scripts/real-e2e.ts`, but the current issue body forbids it for #586. Do not run the full v3 scenario or `scripts/real-e2e.ts`; frozen-SHA integration and bundled-preset compatibility belong to #684 and #685.

## Test delta

`required`

Retain the focused declaration, persistence, daemon-admission, status-boundary, zero-spawn, null/reserved-key, and exhaustiveness coverage already introduced, and add the compile-time/runtime regression that proves observer vocabulary expansion remains automatic while `hook.*` stays excluded. Existing tests and assertions must remain intact: no deletion, rename, skip/only/todo, assertion weakening, timeout relaxation, fallback union, cast, or copied vocabulary may be used to obtain green results.

## Dependencies

- No implementation blocker. The audit-order prerequisites #535, #536, and #538 are closed: https://github.com/mouriya-s-lab/coder-loop/issues/535, https://github.com/mouriya-s-lab/coder-loop/issues/536, https://github.com/mouriya-s-lab/coder-loop/issues/538. Parent #543 remains open and supplies the inherited hook semantics: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- Existing PR #672 is open, non-draft, mergeable/CLEAN, targets `main`, has no reported checks, and closes only #586 at head `0172878adc88c58f5c57a7d2d7db1b08d01f5a29`: https://github.com/mouriya-s-lab/coder-loop/pull/672.
- Latest review found one current candidate defect at `src/hook-declarations.ts:109-112`: future `hook.*` vocabulary variants leave the parsed point typed as the full `ObservabilityEventType`, violating automatic expansion/exclusion. Iteration must correct it before verification: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4981659217.
- #555/#591 are coordination edges for preset named-gate syntax/binding; #590 must consume the same exported `GateDecisionPoint`; they are not prerequisites for this declaration foundation: https://github.com/mouriya-s-lab/coder-loop/issues/555, https://github.com/mouriya-s-lab/coder-loop/issues/591, https://github.com/mouriya-s-lab/coder-loop/issues/590.
- #588, #589, and #575 remain downstream owners for observer execution, gate execution, and hooks/status GUI projection: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- #684 owns frozen-candidate full-chain integration and #685 alone owns the existing GitHub preset compatibility real E2E. Both are open, and neither check may be pulled into #586: https://github.com/mouriya-s-lab/coder-loop/issues/684, https://github.com/mouriya-s-lab/coder-loop/issues/685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4953812495


#### #586 评论 by `RiriAgent` (2026-07-15)

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-15T12:58:28Z` (`lastEditedAt`, re-read from live GitHub).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
  - https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098
- Investigated revisions: `55ff3b2b7345a8e3d975934a53997d074aa02380` (`origin/main`) and existing PR head `8611851e7ff045d5a6d5f7b667239f3a19b8e15e`, observed 2026-07-16.

## Deliverable

`implementation-pr`

Continue the existing branch `coder-loop/v3-586-6ac101ef751a` and PR https://github.com/mouriya-s-lab/coder-loop/pull/672. Deliver only the hook declaration foundation: an exhaustive typed `observer | gate` declaration ADT, strict boundary parsing, global/chain/preset-placeholder/item loading and stable merge with provenance, and one typed effective-view entry for downstream execution/projection children.

The carrier decisions remain:

1. Global declarations are one versioned JSON document at `<loop-data-root>/hooks.json`; malformed JSON, unknown fields, and invalid declarations fail loading and are never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations live with the item record across actionable and terminal statuses and disappear only when the item record is deleted.
3. Preset participation is a typed `named-gate-placeholder` effective-view variant only. Parsing #555 syntax and resolving its binding remain #555/#591 work.
4. Effective order is exactly `global -> chain -> preset -> item`, retaining source-layer provenance. Observer points derive from the shared observability vocabulary with structural `hook.*` exclusion; gate points have one closed exported value/type authority shared with #590.
5. Every declaration write path is operator-only. Run credentials cannot create, replace, patch, indirectly clear, or directly clear hooks; each rejection uses the existing admission audit stream.

Do not implement hook execution, decision stdin/protocol, named-gate binding, gate scheduling, a positive hooks status section, or GUI projection. Those remain owned by #588, #589, #590/#591, and #575. Current source anchors are `src/hook-declarations.ts:8-47,56-169`, `src/runtime-data.ts:105-176,263-299,349-443`, `src/daemon.ts:233,1095-1124,3965-3980,5101-5124`, and `src/observability.ts:25-135,731-732,825-826`.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures reach the single typed constructor and show exact `global -> chain -> preset -> item` order plus provenance. |
| C2 | function/type: strict boundary and vocabulary evolution | shell | `bun run typecheck && bun test src/hook-declarations.test.ts src/observability.test.ts` in repository root; local env | Exit `0`; unknown observer/gate points, missing gate `onFailure`, invalid tick throttle, malformed script/timeout, undeclared fields, and `hook.*` observer subscriptions are rejected by named fields. A compile-time fixture must prove that adding a synthetic non-`hook.*` event needs no hook-side synchronization while a synthetic `hook.*` event remains excluded, with no cast or copied event union. |
| C3 | function: declaration-only zero execution | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; a valid declaration loads, ordinary scheduling reaches its existing terminal behavior, and the declared sentinel executable is never spawned. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item writes work; run-credential add, batch-add, replace, patch, direct clear, and omission-based indirect clear are denied and audited. |
| C5 | persistence/boundary: lifetime and projection separation | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global/chain/item declarations round-trip, daemon restart reloads the same effective view, terminal status retains item hooks, raw hooks remain absent from all public item/run status surfaces, unrelated explicit `null` persists, own `__proto__` is rejected, and only operator `hooks: null` clears hooks. |
| C6 | environment: complete local gate | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and the complete unit/smoke suite pass with no removed, renamed, skipped, weakened, or timeout-relaxed pre-existing test. |
| C7 | architecture: complete Pattern inventory | shell | `LC_ALL=C rg --text -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b|ObservabilityEventType|parseObservabilityEventType' src --glob '*.ts'` in repository root; local env | Exit `0` with no `stopped searching binary file` diagnostic; every match, including matches after embedded NUL bytes, is classified against all Pattern rows below, with no parallel declaration/event authority, execution implementation, positive hooks status projection, or agent-writable hooks path. |
| C8 | type red lines | shell | `git diff "$(git merge-base HEAD origin/main)" HEAD -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root after `git fetch origin main`; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. The comparison is pinned to the PR merge base, not a moving two-dot `origin/main` diff. |
| C9 | process integration: existing engine behavior | shell | `bun scripts/engine-integration.ts` in repository root; local env with Bun and Git on `PATH`; script-owned isolated loop-data | Exit `0`; transcript shows isolated daemon socket readiness, real CLI/socket/spawn/admission/worktree/SQLite progression, terminal item, reclaimed worktree, no orphan, and teardown. This is the strongest process-level runtime check authorized for #586 and must not be described as real E2E. |

No browser row applies: this is a pure engine/CLI change and browser evidence is not required.

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One hook-declaration authority, its compile-time/focused tests, and typed imports at persistence/daemon integration boundaries | Exactly one declaration ADT, strict parser, gate-point authority, exhaustive conversion path, and effective-view constructor. No copied union, catch-all/default, cast, or second merge path. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, hook declaration loader, typed chain/item persistence, daemon load/effective-view/admission wiring, status omission boundary, and focused tests | Raw inputs parse once and merge once; persistence remains distinct from public status output. No hook execution or positive `StatusSnapshotBoundary`/GUI projection is introduced. |
| `whole-tree` | `LC_ALL=C rg --text -n 'ObservabilityEventType|parseObservabilityEventType|ObserverHookPoint|hook\.' src --glob '*.ts'` | `src/observability.ts` as the sole event vocabulary/parser authority; hook declaration code may derive and structurally narrow its observer point type; focused compile/runtime tests; comments containing the ordinary English word “hook” are classified but do not create declaration authority | Exit `0` with no binary-file diagnostic and every text match classified, including content after embedded NUL bytes. Zero copied event literal union. A new non-`hook.*` observability event automatically becomes an observer point; a new `hook.*` event automatically remains unrepresentable/rejected without editing hook declarations. |
| `whole-tree` | `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS|collectProtectedItemUpdateFieldKeys|assertItemAddRightsForCaller|\bhooks\b` | Central daemon control-plane classification plus operator branch and focused admission tests | Zero preset-grantable or run-credential path can create, replace, patch, directly clear, or indirectly clear hooks; operator writes preserve unrelated extra/null/reserved-key semantics. |

## Canonical runtime

- Setup: run `bun install --frozen-lockfile` when dependencies are not materialized; use the repository root and existing local Bun/Git binaries.
- Start: the authorized process-level driver for this issue is `bun scripts/engine-integration.ts`. It creates a run-owned local git fixture and isolated loop-data root, then starts its own daemon. No standing service or TCP port is introduced.
- Readiness: require the driver transcript to report the isolated daemon socket ready before chain/item operations.
- Behavior: execute C1-C8 first, then C9 to prove the declaration changes preserve the real daemon/CLI/socket/spawn/admission/worktree/SQLite process path. Declaration-specific behavior is proved by C1-C5; C9 is the repository process gate and is not evidence of real-agent/GitHub business completion.
- Logs: retain the literal command, exit status, stdout/stderr transcript, and script-reported run/event paths in the VerificationPacket/PR evidence.
- Stop ownership: `scripts/engine-integration.ts` owns daemon shutdown, fixture/worktree cleanup, and orphan checks on success or failure. Do not touch the production daemon or `~/.coder-loop` runtime.
- Explicit exclusion: the repository real-E2E driver is `bun scripts/real-e2e.ts`, but the current issue body forbids it for #586. Do not run the full v3 scenario or `scripts/real-e2e.ts`; frozen-SHA integration and bundled-preset compatibility belong to #684 and #685.

## Test delta

`required`

Retain the focused declaration, persistence, daemon-admission, status-boundary, zero-spawn, null/reserved-key, and exhaustiveness coverage already introduced, and add the compile-time/runtime regression that proves observer vocabulary expansion remains automatic while `hook.*` stays excluded. Existing tests and assertions must remain intact: no deletion, rename, skip/only/todo, assertion weakening, timeout relaxation, fallback union, cast, or copied vocabulary may be used to obtain green results.

## Dependencies

- No implementation blocker. The audit-order prerequisites #535, #536, and #538 are closed: https://github.com/mouriya-s-lab/coder-loop/issues/535, https://github.com/mouriya-s-lab/coder-loop/issues/536, https://github.com/mouriya-s-lab/coder-loop/issues/538. Parent #543 remains open and supplies the inherited hook semantics: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- Existing PR #672 is open, non-draft, mergeable/CLEAN, targets `main`, has no reported checks, and closes only #586 at head `8611851e7ff045d5a6d5f7b667239f3a19b8e15e`: https://github.com/mouriya-s-lab/coder-loop/pull/672.
- The contract-defect review proved that the prior whole-tree query stopped at NUL bytes in `src/scheduler.test.ts`. The text-mode C7 and Pattern commands above are the executable replacement. The same review identified two separate implementation findings still owned by iteration: operator whole-carrier replacement must preserve existing hooks unless `hooks: null` is explicit, and the unused parallel `HookSourceLayer` vocabulary must be removed or made the single derived authority: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098.
- The replacement VerificationPacket must also label the measured base revision accurately (the prior base suite measured `55ff3b2b7345a8e3d975934a53997d074aa02380`, not merge-base `07dad882ded934766f51e53a5e0a04605a18c697`) and explicitly map the setup artifact. These are evidence corrections, not new implementation scope: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098.
- #555/#591 are coordination edges for preset named-gate syntax/binding; #590 must consume the same exported `GateDecisionPoint`; they are not prerequisites for this declaration foundation: https://github.com/mouriya-s-lab/coder-loop/issues/555, https://github.com/mouriya-s-lab/coder-loop/issues/591, https://github.com/mouriya-s-lab/coder-loop/issues/590.
- #588, #589, and #575 remain downstream owners for observer execution, gate execution, and hooks/status GUI projection: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- #684 owns frozen-candidate full-chain integration and #685 alone owns the existing GitHub preset compatibility real E2E. Both are open, and neither check may be pulled into #586: https://github.com/mouriya-s-lab/coder-loop/issues/684, https://github.com/mouriya-s-lab/coder-loop/issues/685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4981760712


#### #586 评论 by `RiriAgent` (2026-07-15)

## Coder-loop closure (run-1784141673560-27-closure-item-6)

Accepted: merged https://github.com/mouriya-s-lab/coder-loop/pull/672 at squash commit `b2b92952d464f135109242f8cf5bdb9dae3397e3`; consumed verdict https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4984212736.

#### #587 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：L1 引擎 hook 面的输入投影级——把引擎已有的两个 typed 事实源（定义态：编译产物；运行态：status 快照）加触发上下文合成为 hook 子进程的 stdin 契约。不新增事实源，只做投影合成。
2. **全局坐标**：引擎 typed 域（CompiledTaskModel / snapshot / event 信封）→ hook 子进程域（外部不可信消费者，经 stdin 收 JSON）。方向是 typed 域向外投影——无入站 parse 需求（hook 的回程通道是 gate stdout decision，归 gate child 的边界 parse）。
3. **类型↔值不漂移**：防值漂移——「全量元数据」若由各执行路径各自拼装即出现同值多副本失同步；单一组装函数封死。防类型泄露——payload 不得手写复制上游 schema 字段（从 schema 派生），上游演进零同步。
4. **消除的错误类别**：「hook 看到的元数据与 status/compile 输出不一致」不可表达（同源投影）；「执行路径间 payload 形态漂移」不可表达（单一组装）。

## log/观测义务

- 无新增运行期事件义务（payload 组装是纯函数面；组装失败随执行 children 的 hook.* 失败事件呈现）。


#### #588 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：daemon 事件面的消费者扩展级——在既有「事件记录」后沿加「事件派发」，加上 hook 子进程执行单元（与 agent run 并列的第二类引擎管理进程，但生命周期语义更弱：fire-and-forget、无 attempt/预算/resume）。
2. **全局坐标**：引擎事件域（typed `ObservabilityEvent`）→ hook 子进程域（stdin JSON 投影，出站）。子进程对引擎的回程只有事件流可见的退出码/超时事实（observer 无输出契约）——不存在需要 parse 的入站值。
3. **类型↔值不漂移**：防类型泄露——observer 订阅匹配直接用事件类型 union，不建平行的「挂点名」映射表；事件词表扩张零 hook 侧同步。
4. **消除的错误类别**：「observer 故障拖垮调度」不可表达（旁路性质 + 失败只记 diagnostic）；「hook 自激励回路」不可表达（发射期零派发 + 声明期拒绝双层）；「同步阻塞主线程」在 hook 路径不可表达（无 spawnSync、异步 API）。

## log/观测义务

- 新增 `hook.*` 执行事件（开始/结束/失败）：kind 归 lifecycle/diagnostic 按事件性质分（失败 = diagnostic，与 #543 observer 失败语义一致）；经 `ObservabilityEventTypeBoundary` 编译期 union 扩张，全部消费点由 typechecker 暴露。
- observer 失败的 diagnostic 事件必须含 hook 标识、触发事件类型、失败原因分类（非零退出/超时/spawn 失败）——headless 排障的最小字段集。


#### #589 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：scheduler 决策面的 gate 评估级——在「run 终结 → 下一次选择」之间插入一个可编程放行点；decision 协议（stdout JSON 边界 parse + onFailure 折叠）是 script kind 判定器的执行器本体，与 #561 的 agent-phase 判定通道（CLI 写回）互为统一判定契约的两个 kind 实现。
2. **全局坐标**：hook 子进程域（不可信 stdout 字节）→ arktype 边界 parse → 引擎 typed decision 域 → 调度决策消费。入站信任升格点恰好一个（parse）；mutation 不走此边界（走既有 CLI 命令面，复用其校验与审计）。
3. **类型↔值不漂移**：防值漂移——decision 词表若在 parse 侧与消费侧各自定义即失同步；穷尽 union 单一定义封死。防类型泄露——非容器决策点的 `advance | hold` 子集限制以类型/校验表达，不靠散文约定。
4. **消除的错误类别**：「脚本输出垃圾被静默当放行」不可表达（边界 parse + onFailure，无 default）；「stdout 夹带 mutation 被引擎代执行」不可表达（decision schema 无 mutation 位，mutation 只经 CLI）；「一个 chain 的 hold 拖住别的 chain」不可表达（hold 作用域 = 该决策点）。

## log/观测义务

- 新增 `hook.*` gate decision 事件（decision kind 建议 `decision`，与 #411 五 kind 对齐）：含 hook 标识、决策点、判定词、reason。
- 协议违规/超时/崩溃：diagnostic + 审计事件，点名违规类别——与既有 `invalid_request` 审计契约同风格。
- hold 扣住状态经 status 快照 hooks 节可见（#586（声明模型） 的 hooks 节承载，本 child 填充 hold 运行态字段）。


#### #590 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：scheduler/daemon 决策面的 gate 接线全集级——把 #589（gate 执行） 立起的单点协议推广为「决策点闭集 × 同一协议」的乘积结构；hold 指纹泛化是该结构的持久化伴生件（决策点通用的幂等防抖）。
2. **全局坐标**：引擎调度域内部改造（各决策点 → 统一 gate 评估入口）；无新增域边界——decision 边界 parse 已由 #589（gate 执行） 拥有，本 child 只扩接线面。
3. **类型↔值不漂移**：防值漂移——各决策点若各自实现评估即协议行为漂移；单一评估路径封死。防类型泄露——决策点闭集是引擎内禀 union，不得以字符串散名出现在声明/事件/payload 中各自维护。
4. **消除的错误类别**：「某决策点的 gate 行为与其他点不一致」不可表达（同一路径）；「hold 重问风暴」不可表达（指纹防抖全点生效）；「tick gate 每秒轰炸」不可表达（节流声明装载期强制）。

## log/观测义务

- 每决策点评估沿 #589（gate 执行） 的 `hook.*` decision 事件契约，事件含决策点标识（闭集 union 值）。
- hold 扣住/重问/指纹命中经事件可见（重问节奏可从事件流重建——排障「为什么这个 chain 不动了」的第一入口）。
- status 快照 hooks 节的 hold 运行态字段覆盖全部决策点。


#### #591 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：hook 声明面的 preset 层间接绑定级——「接口与实现分离」在声明模型上的实例：preset 声明需求（名字），operator 声明供给（绑定），装载期做需求-供给匹配。
2. **全局坐标**：preset 声明域（可分发工件，#555 编译产物）× operator 绑定域（本机全局/chain 声明）→ 装载期匹配 → 生效视图 preset 层成员。两个输入域各自已有边界 parse，本 child 拥有匹配语义与三态结果类型。
3. **类型↔值不漂移**：防值漂移——gate 名在 preset 与绑定两侧是同一标识符空间，匹配结果三态穷尽，不存在「绑了但没被看见」的静默中间态。防类型泄露——本机路径不得进入 preset 域（可分发性质）。
4. **消除的错误类别**：「preset 需要的 gate 漏配且无人知晓」不可表达（三态 + required 裁决语义 + 编译产物暴露）；「preset 携带本机路径失去可分发性」不可表达。

## log/观测义务

- optional 未绑定的空过跳事件（lifecycle/diagnostic 按裁决定）——「为什么这个 gate 点没拦」可从事件流回答。
- required 未绑定按裁决形态产生 load 错误或运行期拒绝事件，点名 gate 名。
- 绑定执行本身沿统一 `hook.*` 事件契约（#590（决策点闭集） 已铺）。


#### #592 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：#546 任务代数 join 策略 ADT 的 variant 实现级——统一判定器接口（#543 裁决 5）的 script kind 在容器推进点的落点；#561 是判定通道框架（spawn 判定器、接收 decision、派发），本 child 给该框架加第二种判定器 kind。
2. **全局坐标**：join 声明域（preset 树 / chain metadata 的 script variant）→ 引擎 join 评估域（穷尽 switch）→ hook 子进程域（stdout decision，经 #589（gate 执行） 的边界 parse 回引擎 typed decision）→ #562 reopen 执行域。跨了声明、评估、子进程三条既有边界，零新边界。
3. **类型↔值不漂移**：防值漂移——script 与 agent-phase 两 kind 的 decision 若各自定义即契约分裂；同一 typed decision 与同一派发路径封死。防类型泄露——script variant 的绑定形态不得把 hook 执行细节（脚本路径语义）泄进 join ADT 之外的调度类型。
4. **消除的错误类别**：「同一容器两种判定器行为不同」不可表达（同契约同派发）；「script 判定绕过 reopen 校验」不可表达（走 #561→#562 唯一通道）；「variant 被 default 静默吞掉」不可表达（穷尽 switch 兑现）。

## log/观测义务

- script join 判定沿 `hook.*` decision 事件契约（决策点标识 = 容器推进点，含容器 id）。
- reopen 派发/拒绝沿 #561/#562 的审计事件契约，本 child 不新增第二套。



#### #593 评论 by `RiriAgent` (2026-07-02)


## 架构切片

1. **系统定位**：hook 树的收尾对齐级（#568 同构）——机制全部在上游，本 child 交付整链组合验收、作者文档面、约束的持久执法（守护测试）。
2. **全局坐标**：无新域边界；文档是引擎 typed 事实（挂点 union、payload schema、decision ADT）向 operator 阅读域的派生投影——派生方向单一，防手写副本。
3. **类型↔值不漂移**：防值漂移——文档中的枚举清单是代码的派生视图 + 测试守护，不是第二份手写事实。
4. **消除的错误类别**：「文档与实现漂移无人发现」不可表达（守护测试红）；「gate 策略业务语义悄悄溜进引擎」从 review 约定升级为测试执法。

## log/观测义务

- 无新事件义务（组合验收消费上游 children 已铺的 `hook.*` 事件面；场景验收本身以事件序列为证据）。


#### #599 评论 by `RiriAgent` (2026-07-10)


## 架构切片

1. **系统定位**：gate 执行器的可靠性层——#589 立起 decision 协议的语义面（parse/onFailure/合成），本 child 给同一执行器补齐故障半边：评估身份、mutation 重放安全、decision 持久化与消费原子、daemon 重启恢复。统一判定契约两 kind 中先落 script kind；agent-phase kind 的对称窗口（#561 通道下 agent 在 corrections 与 decision 写回之间崩溃）同根因，落地后由该侧按本协议形态收编，本 child 不越界。
2. **全局坐标**：hook 子进程域（不可信、可崩溃、可重放）→ CLI admission 域（幂等确认新增于此）→ 状态存储域（评估状态机 + key 快照 + 单事务消费）。零新增域边界——评估 scope 经既有 env 注入形态（`CODER_LOOP_RUN_CRED` 先例）进入既有 socket 命令面。
3. **类型↔值不漂移**：防值漂移——评估状态机若散落为 boolean/时间戳组合即无法穷尽恢复路径；`evaluating | decided | consumed` ADT 单一定义封死。防类型泄露——幂等 key 与快照是 admission 层内部事实，不泄进调度类型；防抖指纹与评估代次两概念不合一（操作员裁决 2026-07-10）。
4. **消除的错误类别**：「脚本崩溃重问导致重复 correction items」不可表达（同 epoch key 吸收）；「decision 已返回但 daemon 崩溃后凭空蒸发、脚本改判造成悬空」不可表达（decided write-ahead + 重消费）；「消费效果落地一半」不可表达（单事务）；「重放跨入新代次的 key scope」不可表达（epoch 仅 consumed 递增）。I4 明确不消除：非确定性脚本的孤儿 corrections 是接受的残留边界，以审计可追溯兜底。

## log/观测义务

- key 命中（重放吸收）事件：含评估 scope、命中的 command、首次记录时间——排障「脚本为什么没插进去」的第一入口。
- 评估状态转移（`evaluating`/`decided`/`consumed`）与重启恢复动作（重消费/同代次重问）经事件可见。
- gate 评估语境创建的 item 其 `item.created` 审计事件携带评估 scope 标识（I4 可追溯）。
- 新增事件类型经 `ObservabilityEventTypeBoundary` 编译期 union 扩张（#543 观测义务总表惯例）。



---

## 六、依赖与关联

Sub-issue graph（来自 GraphQL）：
- #586 [CLOSED] feat(engine): v3 hook 声明模型——四层声明位装载合并与生效视图
- #587 [CLOSED] feat(engine): hook 全量元数据 stdin payload——编译产物投影与运行态快照契约
- #588 [CLOSED] feat(daemon): observer hook 执行——事件订阅派发与异步脚本执行层
- #589 [CLOSED] feat(scheduler): script gate 执行与 decision 协议——run post-exit 决策点端到端
- #590 [CLOSED] feat(scheduler): gate 决策点闭集接线——全点物化、tick 节流与 hold 指纹泛化
- #591 [CLOSED] feat(engine): preset 级具名 gate 点——绑定解析与未绑定语义
- #592 [CLOSED] feat(engine): join script 判定器——容器推进点 script gate 与 reopen 派发
- #593 [CLOSED] docs(v3): 生命周期 hook 收尾对齐——操作员验收场景、作者文档与字面量守护
- #599 [CLOSED] feat(engine): gate 评估代次与幂等协议——mutation 重放安全与 decision 消费原子性
- #710 [OPEN] feat(engine): hook 全量元数据 payload 与运行态快照契约
- #711 [OPEN] feat(daemon): observer hook 订阅派发与异步执行
- #712 [OPEN] feat(engine): 共享 gate evaluation、script decision 与指纹协议
- #713 [OPEN] feat(engine): preset 级具名 gate 点声明与绑定解析
- #714 [OPEN] feat(engine): join script 判定器与 reopen 派发
- #715 [OPEN] docs(v3): hook 与 gate 冻结 SHA 综合验收
