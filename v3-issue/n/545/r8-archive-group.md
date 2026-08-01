# RFC #545 R8 事实档案：group identity 的合法消费边界

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本文是非决策事实档案：当前没有 RFC #545 可裁决的 nested membership 问题。本文不设计并行数学、`par` producer、实现落点或 issue 切分。

## A. 结论

RFC #545 对 group 的稳定要求是“并行分支组内通信”，key 为并行结构层物化的真实 `par` 容器 ID。它没有要求一个内层 run 可任选多个结构祖先作为 group，也没有赋予本 RFC 定义这种关系的所有权。

当前合法 preset/source 不含 `par`。未来权威编排要求的两个并行层次由复合 `seq/par` 结构隔开；这能表达一个复合分支内部再执行并行任务，但不能推出后代 run 同时属于多个通信 group。并行结构 RFC 最终给出哪个真实、已定义容器身份，RFC #545 就校验并消费该身份。

## B. fixture 污染为何发生

1. runtime snapshot ADT 与 SQLite store 为持久化而递归接受任意 node child，技术上能存多个 `par` 祖先；
2. 手工 fixture 利用该宽边界构造了生产 source/compiler/scheduler 不能产生的形状；
3. parent traversal 能恢复多个结构祖先的数据事实，被误写成 caller 应拥有多个可寻址 group 的产品需求；
4. 两种假想 membership 规则由此进入 R8；
5. 但合法 source、真实 producer、context 原始需求均没有给出该 consumer 语义。

这是把 **runtime 可表达状态空间** 当成 **合法 source 状态空间**，再把结构包含误当成授权或通信 membership。完整证据见 `r8-nested-par-validity-audit.md`。

## C. 合法模型边界

| 层 | 已有事实 | 不能推出 |
|---|---|---|
| 当前 source/compiler | preset 无 task tree 声明；compiler/materializer 只生产 `seq` 与 leaf | 当前存在任何合法 `par` 或 nested group |
| 目标编排 | recursive `seq/par`；G3 要求复合分支内存在另一并行层次 | 直接同算子嵌套合法；结构后代自动取得多个 group |
| runtime snapshot/store | child boundary 宽，可 round-trip 多种递归形状 | 每个可存形状都是合法 source；每个祖先都是可提交 group |
| RFC #545 context | group key 是真实并行容器身份，daemon 必须验证 | RFC #545 自己发明并行容器集合或多 membership |

仓库没有已裁定的 `par` 结合律、扁平化律或多容器 membership 规则。本 RFC 不补写这些数学。若未来并行结构层给出新的唯一结论，本 RFC 只消费该结论。

## D. 保留的 group 不变量

1. group key 不能由 caller 自造，必须来自权威并行结构 producer。
2. daemon 以 credential 与 durable runtime 事实独立验证 caller 对该真实容器身份的资格；prompt/请求中的 ID 不是授权。
3. 不存在、跨 chain 或不属于 caller 的 group key必须拒绝；不得猜“当前组”或静默 fallback。
4. 每次 append 显式提交一个 group key；没有自动复制或跨容器广播需求。
5. scope 是过滤维度，不改变 chain 隔离与 author 规则。
6. terminal/restart 不应凭空改变已物化稳定身份；物理删除后的对象不可继续寻址。

这些不变量不要求、也不预埋 nested membership 选择。

## E. 真实 group 的证明边界

durable fixture 可以证明其真实覆盖的 snapshot round-trip、parent traversal、稳定 ID、重启恢复等局部机制；它不能证明合法 source producer、真实 branch credential 或真实并行通信。

“真实 parallel group communication”仍必须由真实 `par` 调度产生的两个 branch credential 写读同一权威容器身份来验证。fixture 的宽表达能力不得冒充这条真实路径，也不得生成额外产品需求。

## F. 证据索引

| 结论 | 正式输入 |
|---|---|
| group 的稳定含义与并行结构所有权边界 | `aggregate.md` D2、D3、D11、D14、CAP-IN-3、K4a |
| 当前 source/compiler/scheduler 不生产 `par`；runtime/store 边界过宽；目标 G3 不推出多 membership | `r8-nested-par-validity-audit.md` A–E |
| 真实 group 路径与 fixture 证据边界 | `r8-correction-audit.md` 第一项纠错；`r7-p03-proof-ledger.md` |

**完整交付：** 本档案没有操作员选择题。它仅记录 fixture 污染、合法模型边界、RFC #545 对权威并行容器身份的消费合同，以及真实 group 必须由真实 `par` 路径验证。
