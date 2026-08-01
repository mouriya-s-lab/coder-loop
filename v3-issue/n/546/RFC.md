# RFC #546：任务代数——三域模型与柯里化派生

> 三域模型设计草稿——2026-07-31 会话裁决系列的整理稿，未经操作员验收，不自证任何阶段完成。裁决出处、supersession 与闭合记录集中于附录 B。调查记录只能提供证据，不能新增需求。被它替换的上一份聚合草稿已找回为 [DRAFT-seq-par-task-model.md](DRAFT-seq-par-task-model.md)。

## 0. 核心模型

三个域，各司其职，互不越界：

| 域 | 是什么 | 规则 |
|---|---|---|
| **对象域** | **task**——唯一的抽象对象，唯一被调度、被并发的东西。派生任务、下级任务、验证任务，都是 task，无第二类居民 | 抽象且行为尽可能少：身份（引擎 id）、组合位置、锁。不持有业务状态，不解释业务 |
| **函数域** | **闭包**——task 执行时内部的函数实例，消费值、产出值。**状态只存在于函数域**：worktree、session、scratch、执行中的一切累积 | 纯运行时行为，task 私有。本 RFC 供给其资源生命周期，不进其内部 |
| **值域** | **不可变数据**——item 是种子实参，phase 是函数标签，status 是返回值的 tag，exit/binding 是参数 | 被消费、被产出；永不被调度，永不持有状态 |

task 对外是函数的基本逻辑，只有二值合同：

```
task 结局 ::= returned(value)   -- 提交了 committed transition；value 是业务数据，引擎路由、不解释
            | exception         -- 永不提交：崩溃、attempts 耗尽
```

引擎平面不存在「业务失败」类别：失败含义的返回是正常返回，只是 tag 在业务上意味着失败。引擎唯一认识的失败是 exception。

**派生 = 柯里化应用。** 声明是柯里化函数文本；编译把声明部分应用成等待前驱值的一元函数；运行时把它应用到前驱的返回值上：

```
定义态:  phase :: Decl → (Value → Result)
编译态:  phaseₖ = phase(declₖ)                  -- 部分应用 + 静态检查
运行态:  taskₖ₊₁ = phaseₖ₊₁( f(x) 的返回值 )     -- 应用即派生
```

返回值的 tag 经声明的派发表选中下一个函数。引擎可见的全部运行时演化只有五种事件——**应用、返回、异常、派生、汇合消费**——无第五面墙，代数由此完备，且完备性在编译态可判（派发穷尽性检查）。

这修正了 v2 的设计 bug：item 与 task 一体两面——同一个东西既当值又当调度对象，status 词既是业务值又是调度器状态。三域拆开后，**本 RFC 调度的是 task，不是任何内层内容**；v2 的 phase 编排语义住在值域与编译平面，不上浮到本 RFC。

## 一、定义态

值域的一切与函数文本住在这里：

- **phase 声明** = 柯里化函数文本：prompt 模板、runner/model、返回值 union（status 词表）、派发表（每个返回 tag → 下一函数或显式 terminal）、await 子任务声明。
- **item 声明** = 种子实参（issue 引用等）。**item 不持有状态。**
- **chain 声明** = 命名 / 凭证 / 隔离边界 + `baseBranch`（默认 main，per-chain 可配）+ 顶层汇合消费者（finalizer）。
- 参数归声明：status 字面量、返回 union、派发表、配额、并发上限（未声明 = 不限，引擎无默认 cap）。机制归引擎：组合子、事件类型、right variant 等机制 ADT。引擎源码零业务字面量。
- 定义不可变（tagged `ExecutionDefinitionRef` pin）。改定义 = 新定义、新实例；不存在运行实例的定义热改。

## 二、编译态

- **部分应用**：`phase(decl)` → 等待前驱值的一元函数。
- **静态检查**：派发**穷尽性**（totality——每个声明的返回 variant 要么有函数承接、要么显式 terminal）；结构 well-formedness；dependsOn 查环。
- 编译检查不是运行前的一道全局闸门：运行中的每次实例化（追加、物化、await 派生）都经同一编译产物的边界 parse。三时态是**每个定义对象各自的三态**，不是 chain 生命周期的三段论。

## 三、运行态 = 给正在运行的任务加锁 + 只增日志

已有的冻结，新的只能追加，任何东西不能编辑。

### 3.1 组合子

- **seq（依赖线）**：`g ∘ f`——g 应用于 f 的返回值。
- **par（并行 + 汇合）**：并发的是任务。join = 消费返回元组的函数，按 allSettled 收集——**exception 也是落定结果**。`drain` = 平凡消费（声明的漠视，放行）；`validator` = 派生一个消费元组的 task，判定即其返回值，走同一提交口（无独立判定通道、无 stdout 解析）。join 在实例化时定死。
- **await**：「对象域执行时内部有若干个函数域」的机制形态——task 执行中派生下级 task 并等待其返回值；等待期间释放锁、函数域现场原地保留；下级返回后原函数域带值继续。**全模型唯一一处运行中的函数接收外部值**，禁止以 resume 注入等 ad-hoc 形态旁路。
- **dependsOn**：忽略返回值的跨结构顺序约束（await-and-discard）；查环在写入 / 装载期；依赖失败则依赖方永不启动。
- **动态追加**：对任何未落定 task 可追加平行兄弟；首次追加原地物化 par——join 只在诞生时指定（值域 = pinned 定义内候选引用，缺省 drain 即代数退化情形）；容器获得稳定 id（RFC-3 `group` 键）；成员从容器 pin 派生，追加复用 pin，嵌套内层独立重 pin。

**chain 的初始 task 互为并行同级**：v2 队列是被 slot 串行化伪装的并行，位置序 = 调度优先级而非依赖；显式依赖用 dependsOn 或声明结构。`item add` = 提交种子值 + 派生首个消费它的 task。**chain-complete = 顶层 finalizer task** 消费全体落定结果：返回 advance-tag 即完成，hold-tag 即保持开放（重问的幂等指纹 / 防抖归 RFC-4）。

### 3.2 异常语义（= PL 异常）

失败了就是失败了，没有回滚。

- exception 中止所在依赖线：无返回 → 无派发 → 无后继。不存在预建的未启动节点，因此失败不留悬挂结构。
- **业务失败流程是 preset 设计的一环，由下一个节点处理**：声明的派发分支与 await 处理任务即 catch。preset 没设计的情况，不关引擎的事。
- 未捕获的 exception 沿依赖线向上传播，至最近 par 边界成为元组中的一个落定结果，归 join 消费。
- **无消费者 → 停在那**：除并行同级任务外都不可推进。这是非错误状态，引擎零升级、零兜底。

### 3.3 运行时动词表（穷尽）

| 动词 | 语义 |
|---|---|
| `spawn` | 对可应用的 task 加锁并执行 |
| `commit` | 返回：一次原子提交持久化返回值、完成 task、构造派发选中的下一应用 |
| `derive` | 前向派生新 task（转移后继、par 追加、await 下级、correction）；只进未落定结构 |
| `release` | 未完成 task 解锁（await 等待、中断）；函数域现场原地保留 |
| `override-advance` | **唯一干预动词**：operator 对汇合点强制一次前向推进；forward-only、经同一提交口、审计 |

**没有的动词**：回退、删除、取消、join 改写、完成后 reopen。完成是吸收态，汇合放行一次，derive 只进未落定结构。旧十二不变量与非法形状矩阵由本表吸收：**无法表达的形状不需要写边界去拒绝**。

实例级运维在树语义之外，粒度只有整 chain：`stop`（暂停加锁）/ `resume` / `delete`（丢弃整个实例）。

### 3.4 持久面

引擎持久面 = **五种事件的只增日志 + 锁表**（每 task 至多一活 run）。一切「当前状态」读面（status、树快照）是日志投影，非权威可变单元；崩溃恢复 = 日志重建前沿 + 锁对账。准入门是**返回值提交口**，不是状态写入口。

## 四、函数域资源合同

状态只在函数域；本 RFC 供给其资源，不进其内部。

- **每 task 一个闭包**：worktree + 引擎创建的闭包分支 + session + scratch，全私有。并发成立条件：活跃任务间无未声明共享可变状态；跨任务值只经声明通道——git origin、GitHub 面、提交口 CLI、context CLI（跨树）、`shared.md`（chain 级自由 prompt 注入面，零行为定义）、presetDir（只读）。
- **递出面定理**：引擎递出的每个面穷尽归入三类——任务私有 / 声明通道 / repo 级共享 Git 协调面；结构性 git 操作（worktree、分支创建命名、起点解析、pin、终态采样、回收）归引擎，内容性（commit、解决冲突、push、PR）归 agent；blame 边界与 escape 语义不变。
- **Git 供给**：底座 = 创建时刻 `chain.baseBranch` 最新快照（先 fetch、per-repo 串行去重、网络失败显式化、无 HEAD 兜底）；resume 起点 = 闭包分支尖端（底座无关，非还原动作）；PR headRef 即闭包分支，agent 契约 = 在其上 commit / 解决冲突 / push / 开 PR；par 成员从持久化 pin 派生；worktree 间零产物传递机制，合并真相是 GitHub 面事实、归判定 task 经声明通道自查。
- **GC**：消费谓词（无活 run 且不再被任何前向可达引用）成立才回收；release 零 GC；回收只碰引擎 namespace；启动对账对磁盘 / 分支 / DB 三方逐项核查，异常暴露、不静默清理。消费证据四值 `{无工作, 已发布, 未发布即弃, 无法求值}` + origin 新鲜度，只暴露不参与推进。**`已发布`** = consume 采样时刻，闭包**自有**远端通道（同名闭包分支 ref / 引擎自知的 PR headRef）历史包含闭包分支尖端 commit；落后 / force-push 移走 / rename / head 删除 → `未发布即弃`；查询失败 → `无法求值`，不得压成未发布；tags、他人 branch、provider synthetic ref、多 remote 不在检查集合；merged 真相归判定 task，不与本证据合并呈现。

## 五、边界

- **范围外**：DSL 具体语法与装载校验（RFC-2，向本树供给柯里化编译产物与穷尽性检查、`ExecutionDefinitionRef`）；context 工具本体（RFC-3，消费 par 容器稳定 id 作 `group` 键）；script 判定器与 hook / 重问指纹（RFC-4）；展示面（RFC-5）；外挂执行通道（RFC-6）；v2 audit（#534）。
- **既有基座**：#397 default-deny 准入门、#451/#452 typed exit 协议（commit 的实现基座）、#409/#410 权利矩阵（derive 授权复用 `createItems` right + scope 声明；operator 恒可、agent default-deny + 审计；scope 词表与结构匹配归 R9）、#406 run-scoped credential（ambient git 凭据不在其覆盖内，登记事实）。
- **验收执行权**：#684 整链路 integration（冻结合流 SHA）、#685 compatibility real E2E（`bun scripts/real-e2e.ts` 两 preset）、#709 综合复核；各实现 issue 的逐字条款见项目 `CLAUDE.md`。交付标准由 R9/R10 从本文推导原子化。

---

## 附录 A：v2 概念对照与退役

| v2 概念 | 归宿 |
|---|---|
| item / task 一体两面 | 拆三域；task 是唯一调度对象 |
| 可变 item.status 单元 | 返回值 tag + 日志投影读面 |
| phase 数组顺序推进、phase 层任务树、「两层实例化」 | 出局；phase = 函数标签值；并行工作 = 派生 task |
| trigger phase（afterPhase / whenStatus） | await / 派发分支。v2 实测（`src/scheduler.ts:649-655, 2974-2986`）：电平触发、每 episode 一次、无跨 episode 记忆，消抖是结构性的——与 await 派生逐点等价，零回归 |
| chain-complete trigger（keep-active） | 顶层 finalizer task（hold-tag 返回）；stdout 判定（`FINALIZER SUMMARY`）退役 |
| slot = (chainId, repoCwd) 串行、per-slot worktree 与分支名 | 退役；队列序重述为调度优先级 |
| preset 指示 agent 自建分支 | 退役；`ISSUE_BRANCH` 绑引擎 closure branch runtime fact，不可 agent 写回 |
| chain 完成时清理 worktree | 退役；改消费谓词驱动的回收 + 启动对账 |
| dependsOn | 原样保留（await-and-discard） |
| 子树取消（#565） | 出局，无需求源（附录 B-3） |
| join 运行时演化、epoch 采样 / 绑定版本 | 出局（附录 B-2）；join 实例化定死 |
| 旧 §3 十二不变量 + X 矩阵（写边界防御框架） | 由 §3.3 动词表吸收 |

## 附录 B：Supersession 与 R8 闭合记录（2026-07-31）

本次收敛的裁决系列：三时态、运行态 = 锁 + 只增日志、对象 / 函数 / 值三域、柯里化派生、异常语义（fail-stop + par 隔离 + 声明消费者）、await 构造。被 supersede 的旧裁决：

1. **`v3/task-closure-decision.md` 裁决 1 的粒度条款**（任务 = 同一 (item, phase) attempt 链）：task 身份是引擎 id，不由值组合定义，(item, phase) 降为绑定元数据。依据即该文档 §6-4 自己的方法论——操作员 verbatim（「边界在于什么是任务」）未定义粒度，(item, phase) 是会话以 v2 session 键代答的解释层。其余条款（对外无状态、resume 闭包内动作、递出面定理、系统自证完备）存活。
2. **`v3/join-evolution-decision.md` 裁决 3**（物化态 join 绑定版本演化 + epoch 采样）：运行中程序不可编辑；其 §88 反例（长寿命容器事后装 gate）的前向回答 = 向外围开放结构 append 检查 task / chain finalizer 把关——当年选项空间未含此项。裁决 5 的 override-advance 机制保留，「救济坏死判定者」的兜底定位废止。
3. **子树取消（旧 H 块，#565）**：出处审计证实无操作员需求源（目标源、#413、全部设计会话 verbatim 均无取消类诉求，v2 只有整 chain stop）；整块出局，连带旧 B-D2-1 / B-D3-1 / B-D3-2 与 C-D2-1 / C-D3-1 删除。
4. **`v3/v3-goals.md` 及「phase 级并行与 item 级并行须同时覆盖」注**：操作员作废；文件已删除，SYNTH-546 残留注已清。
5. 旧问题树其余项归宿：B-D4-1 併入 C 类 scope 词表；B-D6-1 由构造式派生吸收（顺序 = 派生顺序 + 确定性 tie-break，工程项）；B-D6-2 经源码调查闭合（附录 A trigger 行）；B-M2-1 裁定自有通道 contains-tip 档位（定义入 §4 GC 条款）。**R8 无剩余未决项。**

## 附录 C：已落地面与迁移登记

- **L 持久化 shape（PR #675，main `9ac3b87`）**：规范化树 / 闭包 / 锁表结构存活。演进登记三项：① 闭包键从 (item, phase) 改 **task id**，(item, phase) 降为绑定引用列；② 各「当前状态」列定性为日志投影；③ v13 线性链迁移目标从「退化顶层 seq」改为**默认并行（序 = 优先级）**——seq 目标会使失败 item 封死整条 chain，非 v2 行为。
- **M 引擎递出授权面（PR #678，main `9844e99`）**：binding 切片授权、sandbox 执法源存活，per-task 同型。
- **K bundled preset Git 契约迁移**：存活——agent 自建工作分支指示清零；稳定比较只读保存 base SHA / pin；无 config/hooks、他闭包 refs、repo-wide 破坏性指示。
