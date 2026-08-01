# RFC #545 R8：DEC-545-02 嵌套 `par` 有效性审计

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只调查 DEC-545-02 是否由权威任务语义产生；不修改产品、测试、issue 拆分或 workflow。

## A. 摘要

1. **当前生产语言没有嵌套 `par`，甚至没有任何合法 source `par`。** preset boundary 只有扁平 `phases`；compiler 固定产出 `seq(seq(phase), …)`；scheduler 的兼容物化路径固定造 `seq` root 下的 `leaf`。因此当前合法输入不能产生 `par→par`，也不能产生 `par→seq→par`。
2. **v3 权威编排明确要求两个并行层次，但给出的合法形状是由 `seq` 隔开的组合，不是同构造子直接嵌套。** G3 的形状是 chain `seq(A, par(B,C), D)`，其中 B 自身为 `seq(prep, par(implementation, independent-review), integrate)`。这证明“外层并行分支内部再执行内层并行”是目标；不证明 `par(par(...), ...)` 是合法语法。
3. **没有发现已裁定的规范化律。** 权威文档称 #554 交付“phase `seq/par` 递归任务树”，却没有规定 `par` 结合律、直接 `par` child 扁平化、`seq`/`par` 交替规范形或 leaf-only branch。不能把常见代数定律自行升级为本项目合同；但也不能用宽松 runtime ADT 反推所有递归形状都是合法 source。
4. **runtime/store boundary 过宽，能存 `par→par` 与 `par→seq→par`，这只是“无效状态可表达”。** `TaskSeqNodeSnapshot.children` 与 `TaskParNodeSnapshot.children` 都是任意 `TaskNodeSnapshot[]`；boundary 递归接受；SQLite insert 也递归写入而不约束 parent/child kind。它是 snapshot 存储形状，不是 source 任务代数的合法性证明。
5. **DEC-545-02 的两个候选都没有真实需求来源。** RFC 的稳定合同只说 group 是“并行分支组内通信”，key 是该 `par` 容器 ID；没有条款要求一个内层 run 可选择外层祖先容器。K4a 的“最近祖先/全部祖先”是聚合稿从可表达的多祖先 fixture 生出的选择题，而当前/future 已写出的 source 合同均未定义这种寻址能力。
6. **R8 应删除 DEC-545-02，不应让操作员在两个臆造候选间裁决。** 对“嵌套并行不符合数学”的证据支持的精确收敛是：直接同算子嵌套没有权威合法性；两个并行层次可以经不同组合子出现，但这不自动产生“多 group membership”。RFC #545 只消费并行结构 RFC 最终给出的单个真实容器归属，不重新设计任务数学。

## B. 权威数学 / 设计语义

### B1. 已出现的构造子

当前仓库同时存在三套不同层次的形状，不能混为一谈：

| 层次 | 构造子 | 已定义语义 |
|---|---|---|
| 当前 source/compiler | root `seq`、per-phase `seq`、`phase` leaf | phase 按序；每个 phase tree 当前只有一个 phase leaf。`src/loop.ts:780-874` |
| 目标编译语言（尚未落地） | recursive `seq/par` phase tree + phase leaf | `seq` 串行、`par` 并行且带 join；#554 被权威编排定义为“phase `seq/par` 递归任务树与 join ADT”。`v3/execution-orchestration.md:121-125`（本 worktree 删除，读取 `main`） |
| runtime snapshot | `leaf | seq(children) | par(children, join, state, …)` | durable 执行快照；`seq` 有 cursor，`par` 有 group ID / join / state。`src/task-runtime.ts:40-55` |

最高层业务目标只要求“依赖之外还应有平行函数”和 phase 级并行，没有给出 descendant group membership：`v3/v3-goals.md:13-25`（读取 `main`）。RFC #545 自身只规定 `group = 并行分支组内通信`、key 为 `par` 物化容器 ID：`aggregate.md:17-18`。

### B2. `par.children` 的权威限制

- **当前 source：** 没有 `par` 声明位，所以不存在“允许哪些 child”的合法输入问题；`PresetPhaseBoundary` 没有 task tree 字段，`PresetTomlBoundary` 仅有 phase 数组：`src/loop.ts:490-518`。
- **目标 source：** 文档只说“递归任务树”，并在 G1 使用 `seq(leaf, par(leaf, leaf))`，在 G3 使用两个由 `seq` 隔开的并行层次：`v3/execution-orchestration.md:101-110,187-197`。这些证据支持 `par` 分支可包含复合任务（G3 的 B 是复合 phase tree），但没有一个例子或规则允许直接 `par` child 为 `par`。
- **runtime boundary：** 类型上允许任意 `TaskNodeSnapshot` child，包括 `leaf/seq/par`，因此技术上接受两种形状；这是实然的宽边界，不是目标语言裁决：`src/task-runtime.ts:43-55,127-146`。

### B3. 规范化 / 结合律

调查未发现以下任一条已成为仓库合同：

- `par(par(A,B),C) = par(A,B,C)` 的结合/扁平化律；
- `seq(seq(A,B),C) = seq(A,B,C)`；
- `seq`/`par` 必须交替；
- `par` 必须 leaf-only；
- nested container 的 join、失败、取消、worktree 或 group identity 在扁平化时如何保留。

所以不能声称仓库已经实现某一规范化器。另一方面，DEC-545-02 也不能以“snapshot 能有多个 `par` 祖先”为依据要求产品裁决；合法 source grammar 与 normalization 本应由 #554/#567 的任务数学给出，RFC #545 明确只消费并行结构标识裁决，不拥有该设计：`aggregate.md:197-201`。

用户所说“嵌套并行不符合数学”至少有两个可区分解释：

1. **直接同算子嵌套** `par(par(A,B),C)`：权威输入没有证明它合法；若 `par` 取通常的 n 元结合构造，它应规范化消除。但本仓没有已写出的结合律，故本报告只下结论“不得把它作为 RFC #545 的合法需求输入”，不代替并行 RFC补写数学。
2. **结构中存在两个并行层次** `par(seq(...par(...)...), C)`：G3 明确要求这种场景，因此不能笼统声称所有层次嵌套都被目标排除。不过该内层 leaf 是外层的复合分支后代，不等于它拥有两个可任选的 group scope；权威设计从未给出这种推论。

## C. Compiler / runtime 实然边界

### C1. 合法 source 到 compiler

`parsePreset` 的 arktype boundary 不接收 task tree；`buildCompiledTaskTree` 无条件生成：

- `tasks:root`：`seq`；
- 每个 phase：一个 `seq`；
- 每个 phase 下：唯一 `phase` leaf。

证据：`src/loop.ts:490-518,780-786,864-874,4602-4694`。因此当前 compiler 从合法 preset **不可能**产生 `par→par` 或 `par→seq→par`。

### C2. compiler 到 scheduler/materializer

当前 scheduler 只消费 compiled phase leaf identity。run 写入时 `ensureRuntimeClosure`：

- 无树则创建 `seq` root；
- 有树则强制 root 必须为 `seq`；
- 新 closure 永远作为 root 的直接 `leaf` child；
- `source_par_node_id` 固定 `NULL`。

证据：`src/sqlite-state.ts:2292-2335`，以及 compiled definition projection 的消费点 `src/scheduler.ts:1621-1626`。所以生产 runtime 同样不可能产生任一种 nested `par`。

### C3. fixture/store 为什么能表达

`createTaskTree` 接收完整 snapshot 并调用递归 `insertTaskNode`；`seq` 和 `par` 两个 case 都无 parent-kind grammar check，直接递归所有 child：`src/sqlite-state.ts:1974-1980,2363-2402`。snapshot boundary 也只验证节点自身字段和递归 child 合法性，不限制边种类：`src/task-runtime.ts:127-146`。

因此：

| 形状 | 合法 source/compiler 产生 | scheduler 产生 | direct fixture 存储 |
|---|---:|---:|---:|
| `par→par` | 否 | 否 | 是 |
| `par→seq→par` | 否（当前） | 否（当前） | 是 |
| G3 两层组合 | 目标要求、尚未落地 | 尚未落地 | snapshot 可模拟 |

fixture 的“可 round-trip”只证明 schema 表达力，不能证明输入在任务代数中有效。

## D. fixture 污染成因

污染链如下：

1. runtime ADT 为持久化/恢复方便递归开放所有 child variants；
2. R7 fixture 手工构造 `par outer → seq → par inner → leaf`（并曾讨论 `par→par→leaf`），证明 parent-chain 可恢复多个 `par` 祖先；
3. 调查把“可恢复的结构祖先集合”误写成“产品必须决定的可寻址 group 集合”；
4. aggregate K4a 的“最近祖先单键 / 全部祖先多容器”因此进入 R8，被错误标为用户可观察产品分叉；
5. 但源语言、compiler、scheduler、context 原始需求均没有 producer 或 consumer 要求这种选择。

关键错误是以存储的**可表达状态空间**替代源语言的**合法状态空间**，再从无 consumer 的投影差异生成需求。`sourceParNodeId` 只记录直接 `par` parent、parent chain 可找祖先，均只是数据事实；不授予 scope 资格。

## E. 对 R8 的处置

### E1. DEC-545-02 是否为真实 Decision

不是。两个候选都缺需求来源：

- “最近 `par`”假定任一结构后代天然成为某个 group member；
- “全部祖先 `par`”进一步假定结构包含关系自动授予多容器寻址；
- D2/D11 只要求显式真实 group key 与“并行分支组内”通信，没有定义这两种 membership；
- 权威并行设计的 G3 只要求两层执行结构，没有要求内层 agent 向外层 group 发布。

因此不能择一。即便两个候选会造成不同假想 CLI 结果，“能描述不同结果”也不是需求证据。

### E2. 需求锚定后的唯一处置

1. 从 R8 Decision index、档案和进度账本删除 DEC-545-02；记录其为由无效/未定义 fixture shape 生出的伪问题。
2. 不在 RFC #545 中新增 normalization、membership resolver 或 nested-group 机制；不重拆 issue。
3. RFC #545 的 group 合同保持已有最小含义：真实 `par` producer 提供哪个稳定 group/container identity，本 RFC 就校验并使用该真实身份做该并行组内通信。
4. 若未来并行结构 RFC 明确定义多个合法同时归属容器，那是新的权威输入；届时消费其单一结论，而不是保留本 Decision 预埋选择。

这遵守 `aggregate.md:197-201` 已写明的所有权边界：“并行结构标识与并行通信的唯一性裁决归并行结构 RFC，本簇只消费其裁决结果”。

## F. 证据索引

| 结论 | 权威证据 |
|---|---|
| v3 业务只要求平行函数/phase 级并行 | `main:v3/v3-goals.md:13-25` |
| #554 目标是 recursive `seq/par` phase tree | `main:v3/execution-orchestration.md:113-125` |
| G1 基本形状 | `main:v3/execution-orchestration.md:101-110` |
| G3 两个并行层次由 `seq` 隔开 | `main:v3/execution-orchestration.md:187-197` |
| RFC group 原始稳定含义 | `aggregate.md:17-18,26-28` |
| 并行数学/唯一性不归 RFC #545 | `aggregate.md:197-201` |
| K4a 的两个候选只出现在聚合未决登记 | `aggregate.md:189-195` |
| 当前 preset 无任务树声明 | `src/loop.ts:490-518` |
| 当前 compiled ADT 固定 seq/phase | `src/loop.ts:780-786,864-874` |
| compiler 固定调用该 builder | `src/loop.ts:4602-4694` |
| runtime ADT child 递归开放 | `src/task-runtime.ts:40-55,127-146` |
| store 递归接受所有 child kinds | `src/sqlite-state.ts:1974-1980,2363-2402` |
| production materializer 只造 seq root + direct leaf | `src/sqlite-state.ts:2292-2335` |

调查只读本地 repo 与 `git show main:<path>`；未使用 GitHub/API，未创建 worktree，未运行或修改产品代码、测试与数据库。
