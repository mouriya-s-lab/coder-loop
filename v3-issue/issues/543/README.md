# #543 RFC: v3 生命周期 hook——引擎扩展点与用户态 gate

- state: **open**  | author: `RiriAgent`  | created: 2026-07-02T07:41:21Z  | updated: 2026-07-26T16:14:59Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/543
- comments: 3  | timeline events: 57
- sub-issues:
  - #586 [CLOSED] feat(engine): v3 hook 声明模型——四层声明位装载合并与生效视图 (mouriya-s-lab/coder-loop)
  - #587 [CLOSED] feat(engine): hook 全量元数据 stdin payload——编译产物投影与运行态快照契约 (mouriya-s-lab/coder-loop)
  - #588 [CLOSED] feat(daemon): observer hook 执行——事件订阅派发与异步脚本执行层 (mouriya-s-lab/coder-loop)
  - #589 [CLOSED] feat(scheduler): script gate 执行与 decision 协议——run post-exit 决策点端到端 (mouriya-s-lab/coder-loop)
  - #590 [CLOSED] feat(scheduler): gate 决策点闭集接线——全点物化、tick 节流与 hold 指纹泛化 (mouriya-s-lab/coder-loop)
  - #591 [CLOSED] feat(engine): preset 级具名 gate 点——绑定解析与未绑定语义 (mouriya-s-lab/coder-loop)
  - #592 [CLOSED] feat(engine): join script 判定器——容器推进点 script gate 与 reopen 派发 (mouriya-s-lab/coder-loop)
  - #593 [CLOSED] docs(v3): 生命周期 hook 收尾对齐——操作员验收场景、作者文档与字面量守护 (mouriya-s-lab/coder-loop)
  - #599 [CLOSED] feat(engine): gate 评估代次与幂等协议——mutation 重放安全与 decision 消费原子性 (mouriya-s-lab/coder-loop)
  - #710 [OPEN] feat(engine): hook 全量元数据 payload 与运行态快照契约 (mouriya-s-lab/coder-loop)
  - #711 [OPEN] feat(daemon): observer hook 订阅派发与异步执行 (mouriya-s-lab/coder-loop)
  - #712 [OPEN] feat(engine): 共享 gate evaluation、script decision 与指纹协议 (mouriya-s-lab/coder-loop)
  - #713 [OPEN] feat(engine): preset 级具名 gate 点声明与绑定解析 (mouriya-s-lab/coder-loop)
  - #714 [OPEN] feat(engine): join script 判定器与 reopen 派发 (mouriya-s-lab/coder-loop)
  - #715 [OPEN] docs(v3): hook 与 gate 冻结 SHA 综合验收 (mouriya-s-lab/coder-loop)

---

## Body

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

## Comments (3)

### comment #4863549712 by `RiriAgent` — 2026-07-02T08:05:06Z

RFC-2 已落地为 #547。接缝答复：hook「全量元数据」schema = #547 编译产物投影 + 运行态快照，不另造第二套 shape；preset 级具名抽象 gate 点的 DSL 声明位（名字 + required/optional 标志）由 #547「DSL 演进面」第 7 项提供，脚本绑定与执行语义仍归本 RFC。


### comment #4866578421 by `RiriAgent` — 2026-07-02T14:01:46Z

实现拆解 children 已落地并全部挂为 sub-issues（8 个，2026-07-02，按 `writing-complex-issues` 流程 + 对抗审查后发布）。

## children 名录与依赖边

| Issue | 职责 | Depends on | Blocks |
|---|---|---|---|
| #586 | hook 声明模型：四层声明位装载合并、生效视图、status hooks 节、写入面 operator 专属（**地基，先行**） | — | #588 #589 #591；跨树：#544 快照 boundary 收紧 child（待立 W2）消费 hooks 节 shape |
| #587 | stdin 全量元数据 payload：编译产物投影 + 运行态快照，零平行 shape | #549（总控简报边 2） | #588 #589 |
| #588 | observer 执行：事件订阅派发 + observer/gate 共用异步脚本执行层 | #586 #587 | #589 |
| #589 | script gate 执行与 decision 协议：run post-exit 决策点端到端（stdout 三词 parse、onFailure、hold 先例复用） | #586 #587 #588 | #590 #591 #592 #593 |
| #590 | gate 决策点闭集接线：全点物化、tick 节流、hold 指纹泛化（收编 #589 与 #561 的先例复用点） | #589 | #591 #592 #593 |
| #591 | preset 级具名 gate 点：绑定解析、未绑定语义、四层全景合成验收 | #555（总控简报边 3）、#586、#590 | — |
| #592 | join script 判定器：容器推进点 script gate、reopen 校验派发 #562、chain-complete 顶层实例 | #589 #590、#561、#562 | — |
| #593 | 收尾对齐：操作员验收场景 e2e、hook 作者文档（派生+守护）、业务字面量全局守护 | #586–#592 全部 | 本 RFC 关闭复核 |

跨 RFC 边按总控简报物化：边 2（#549 → #587）与边 3（#555 → #591）已回填至 #549/#555 body 依赖行；边 5（统一判定契约 `advance | hold | reopen(target, corrections)` 以 #546 body「join 策略与验证者判定」节为唯一权威文本）——执行器机制侧由 #589（stdout decision/onFailure）、#590（fingerprint 幂等泛化）、#592（容器点 script kind）承接，与 #561/#562 引用同一文本不复制；#561 的「泛化后由 #543 侧收编」由 #590 承接（已回填其 Relates 行）。#544 接缝（hooks 节进 status 快照）由 #586（声明清单）+ #589/#590（hold 运行态字段）产出 shape，#544 快照收紧 child（待立 W2）消费。#545 无直接接缝（RFC body 已载）。

## 关闭验证行覆盖映射（并集完整，无缩水）

| 行 | 覆盖 children |
|---|---|
| 1 observer 被调且 stdin 元数据 | #588（#587 供 payload） |
| 2 gate hold 调度决策 | #589 |
| 3 操作员验收场景 | #593（机制成分来自 #587/#589 + 既有 CLI 能力） |
| 4 onFailure 两语义 | #589 |
| 5 四层声明位与合成 | #586（声明面）+ #589（AND 首点）+ #590（全点/直接层）+ #591（preset 层 + 四层全景行） |
| 6 hook.* 可观测 | #588/#589/#590 各自事件验收 + #593 汇总映射 |
| 7 引擎无 gate 策略业务字面量 | #593（全局守护）+ 各 child「不应残留」切片 |
| 8 script gate reopen 判定 | #592 |

## 开放问题分配（RFC「子 issue 验证后再实现」的落位）

- tick 挂点节流声明形态 → #590。
- gate hold 重问节奏与幂等指纹形态（泛化方向）→ #590（#589 先复用 chain-complete 先例，与 #561 同模式）。
- preset 抽象 gate 点未绑定语义 → #591。
- item 级 hook 声明载体与寿命 → #586。
- 同挂点多 hook / 跨 chain 并发同一脚本互斥重入 → #588（执行层公共语义，gate 继承）。
- 多 reopen 并存合成 → #592（该问题只在容器推进点存在——其余决策点词表是 `advance | hold` 子集）。

拆解新识别决策项（RFC 开放问题之外，各 child body 显式登记）：全局层声明载体形态（#586）；编译产物投影切片范围与无上下文挂点的 payload 形态（#587/#590 对称登记）；非容器决策点 reopen 的「声明期拒绝」具体化（#589）；item 状态转移/daemon shutdown/tick 点的 hold 表达（#590）；具名 gate 绑定的层间遮蔽/回落（#591）。

## 排序登记

- #534 audit 树（#535/#536/#538）默认先合：#586 #588 #589 #590 #591 #592 触 `src/scheduler.ts`/`src/daemon.ts` 面，在其后 rebase。
- 与 #546 树：#592 硬依赖 #561/#562；#589/#590 与 #559（树调度）触同一 scheduler 推进面——无硬依赖，先合者定接线形态、后合者 rebase（两 child body 协调边已登记）。

## 对抗审查记录

九轮换面扫描（设计自洽 / 验收可钻性 / 组合一致性 / 主体 / 字段挂点 / 行覆盖 / 修正交叉 / 引用对照 / headless 自包含），第 7–9 轮无新发现，干涸：

- **坐实并修正**：agent 可写 hook 声明 = 自行解除 gate 的逃逸洞——#586 补「写入面 operator 专属」性质与验收行（与 #564 control-plane 归类同构）；payload 透传 `StatusSnapshotBoundary` 匿名槽违反 ADT 红线——#587 钉「匿名槽不透传、只投影精确节、#544 收紧后自动扩张」；tick 点 hold 语义缺失——#590 决策项补全；#589/#590 与 #559 的 scheduler 推进面重叠——两 body 补排序协调边；RFC 行 5 四层全景验收无完整承载——#591 补全景合成行。
- **当场裁决（记录于 #586 thread）**：observer 不得订阅 `hook.*` 事件（自反挂点声明期拒绝 + 发射期零派发双层防护）——自激励回路与「异步旁路不影响调度」直接冲突，hook 观测 hook 的需求已由事件流查询面覆盖。
- **落空的怀疑（正例）**：hook 子进程无凭证走 operator 路径与现状 socket 信任模型一致（#544 网关先例「daemon 视之为 operator 主体」），无需新增鉴权面；非容器决策点 `advance | hold` 子集划分与 RFC「reopen 仅容器推进类决策点合法」逐字一致，#589/#592 词表分工无缝。

## 观测义务总表

- #586：无新运行期事件（hooks 节进 status 快照是交付物本体；装载拒绝沿 preset load 失败形态）。
- #588：`hook.*` 执行事件（开始/结束/失败）；observer 失败 diagnostic 含 hook 标识、触发事件、失败分类。
- #589/#590：`hook.*` gate decision 事件（决策点标识、判定词、reason）；hold/重问/指纹命中事件可见；协议违规沿 `invalid_request` 审计风格。
- #587/#593：无新事件义务（纯函数面/组合验收）。
- #591：未绑定空过/拒绝事件点名 gate 名。
- #592：沿 #561/#562 审计契约，零第二套。
- 新增事件类型全部经 `ObservabilityEventTypeBoundary` 编译期 union 扩张。



### comment #4984304080 by `RiriAgent` — 2026-07-15T19:03:56Z

## Coder-loop umbrella finalizer (run-1784141673560-27-closure-item-6)

### What was checked

- Re-read the live parent/sub-issue graph for #543 and all nine explicit children (#586–#593, #599), including each issue body, comments, timeline, state, parent edge, and candidate closing-PR references.
- Re-read candidate PRs #656 and #672 for #586, including bodies, issue comments, reviews, review threads, timelines, commits, checks/statuses, and closing edges. PR #656 is closed/unmerged and explicitly retired; PR #672 has the accepted ordinary-review verdict at https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4984212736, was merged as `b2b92952d464f135109242f8cf5bdb9dae3397e3`, and closed #586.
- Re-read chain `v3-586`: its only queue item is #586 and is locally `done`; the chain itself is still `active`. The durable GitHub parent edge identifies #543 as the umbrella even though chain metadata has no explicit umbrella binding.
- Checked the umbrella's closure prerequisites #684 and #685 and dependency issues that determine whether another direct child can safely enter this chain.

### Child closure table

| Child | GitHub / PR evidence | Chain representation | Closure assessment |
|---|---|---|---|
| #586 | closed by merged PR #672; accepted verdict [comment](https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4984212736); closure [comment](https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4984244372) | queue item `586`: `done` | complete |
| #587 | open; no closing PR | absent | remaining; blocked by open #574 and #605 |
| #588 | open; no closing PR | absent | remaining; depends on #587 |
| #589 | open; no closing PR | absent | remaining; depends on #587 and #588 |
| #590 | open; no closing PR | absent | remaining; depends on #589 |
| #591 | open; no closing PR | absent | remaining; depends on open #555, #590, and #605 |
| #592 | open; no closing PR | absent | remaining; depends on #589, #590, and open #561/#562 |
| #593 | open; no closing PR | absent | remaining; final integration/docs child after all other hook children |
| #599 | open; no closing PR | absent | remaining; depends on #589 |

### Remaining scope

Eight of nine explicit children remain open. This is coherent, already represented scope, not scope that should be duplicated into new issues. The umbrella body additionally requires frozen-candidate integration from open #684 and bundled-preset compatibility real E2E from open #685 before #543 can close.

No queue injection is safe in this pass: the next foundation child #587 is not executable while #574 and #605 remain open, and every other open direct child is downstream of #587, #589, #590, or other open cross-tree dependencies. Adding them now would ignore their declared dependency order; adding #574/#605 would incorrectly absorb work owned by other umbrellas into this chain.

### Local evidence

- Chain handoff: `/Users/mouriya/.coder-loop/loop-data/chains/v3-586/shared.md`
- Accepted review record: `/Users/mouriya/.coder-loop/loop-data/chains/v3-586/evidence/586/run-1784139900840-25-review-item-6-accepted.md`
- Final verified artifacts: `/Users/mouriya/.coder-loop/loop-data/chains/v3-586/evidence/586/C1.log` through `C9.log`, plus `cleanup-and-final-identity.log`
- Closure run: `/Users/mouriya/.coder-loop/loop-data/chains/v3-586/runs/run-1784141673560-27-closure-item-6/closure/stdout.jsonl`
- Finalizer live GitHub snapshot: `/tmp/coder-loop-finalizer-586/github/`

### Finalizer decision

`keep-active`. Do not close #543 and do not mark chain `v3-586` completed. No new follow-up issue was created because all remaining deliverables already have explicit issue owners; no item was injected because the next direct child is dependency-blocked.



---

## Timeline (57)

- 2026-07-02T07:41:23Z `assigned` @RiriAgent
- 2026-07-02T07:53:38Z `cross-referenced` @RiriAgentsrc=545
- 2026-07-02T07:59:59Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T08:04:39Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T08:05:06Z `commented` @RiriAgent
- 2026-07-02T09:33:31Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-02T10:29:09Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-02T11:11:54Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-02T11:12:43Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-02T11:15:49Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-02T11:15:52Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-02T11:16:02Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-02T11:17:44Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-02T11:17:51Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-02T12:02:05Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-02T12:02:07Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-02T12:02:40Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T12:02:43Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T12:02:45Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T12:02:58Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:15Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:16Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:17Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:18Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:19Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:21Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:22Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:23Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:01:46Z `commented` @RiriAgent
- 2026-07-05T09:15:11Z `referenced` @RiriAgentcommit=128b13eb115198d0e94bd53f6f7ac764e2b42909
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-10T04:50:50Z `sub_issue_added` @RiriAgent
- 2026-07-13T06:05:07Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-15T10:52:19Z `cross-referenced` @RiriAgentsrc=683
- 2026-07-15T10:53:40Z `cross-referenced` @RiriAgentsrc=684
- 2026-07-15T19:03:56Z `commented` @RiriAgent
- 2026-07-17T20:13:40Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:19Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:37:25Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:39:33Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:39:34Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:39:35Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:39:41Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:39:43Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:39:45Z `sub_issue_added` @RiriAgent
- 2026-07-26T23:48:55Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-26T23:49:18Z `cross-referenced` @RiriAgentsrc=718