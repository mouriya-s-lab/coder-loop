# RFC #545 R10：group 真实化能力需求

本文只从 `aggregate.md` 的 D2/D3/D6/D7/D11/D14、S23–S28、CAP-IN-2/3，以及 `r9-expected-foundation.md` F-01～F-10 提取 group 能力的原子地基需求。并行结构层是容器身份、归属结论和真实 branch run 的权威；context 只消费，不定义并行数学。

## A. 摘要

group 真实化不是从 runtime ancestry 推导一个“看起来合理”的组，而是把上游已经裁定并持久化的真实容器身份与 run 归属，接入 context 的既有授权、存储、读取和生命周期边界。

完整能力必须同时满足：

1. 上游提供真实 `par` 容器稳定身份、run 对容器的权威归属，以及真实 branch credential；
2. daemon 以 credential 和 durable runtime 事实重新验证每次 group 写入，不信任 caller、prompt 或请求自报；
3. entry 写入、scope 引用与 admission audit 的事务结果一致，不产生不存在、非成员或跨 chain 的悬空 group entry；
4. read 的 group filter 精确命中该真实容器的 entries；组外按 group 不命中，但同 chain 的 chain-scope 自由读不受影响；
5. terminal、join 和 restart 不改变已经物化的稳定身份语义；chain 删除是 entry 的唯一删除通道；
6. 真实 `par` 调度产生的两 branch 必须完成双向写读，才能证明真实 group 通信。fixture 只能证明它实际覆盖的持久形状、解析、恢复或局部 admission。

R9 已给出可复用的预期地基合同，但这些合同只有各自 runtime proof 完成后才成立。group 自身不能用局部资产、fixture 或类型检查把未闭合地基冒充为已经供给。

## B. 原子需求

### N-G01 权威容器身份

- group key 必须是并行结构层物化的真实 `par` 容器稳定 ID。
- context 不生成、猜测、规范化或从 ancestry 合成 group key。
- 请求必须显式提交一个 group key；无隐式“当前组”、fallback、自动复制或跨容器广播。

### N-G02 权威 membership 消费

- 并行结构层必须提供 run 对真实容器的权威归属结论。
- context 只消费该结论及其节点 ADT，不定义 membership 集合、基数、结合律、扁平化或 nested `par` 语义。
- 容器谱系/归属的消费必须对上游节点 ADT 穷尽；新增 variant 由编译器暴露处置点。

### N-G03 credential 绑定身份

- agent 主体仍是 credential 所标识的 `agent(run)`；author 的 chain/item/run/phase 只能从凭证解析路径构造。
- group ID 只是寻址值，不是 capability。prompt 中展示、请求中复制或猜中一个真实 ID 都不能取得 membership。
- daemon 必须把 credential 所属 run、chain 与上游 durable membership 事实绑定后再判定。

### N-G04 server-side write admission

- 每次 group append 都由 daemon 独立检查：
  1. 容器真实存在；
  2. 容器属于 credential 所属 chain；
  3. credential run 被权威结构层判定为该容器成员。
- 不存在、非成员、跨 chain 和无可寻址容器必须显式拒绝并点名原因，且不得落库。
- 当前“无容器则拒绝”的分支须保持单一语义；不得因树是否存在形成兜底双路径。

### N-G05 admission、entry 与 audit 的事务一致性

- 接受判定必须只在合法 group 引用可持久化时产生，并与 durable entry 及“接受”审计一致。
- 拒绝判定不得产生 entry，并须与“拒绝”审计及拒绝原因一致。
- context 不要求 exactly-once caller 语义，但不能把“caller 是否唯一知道提交结果”与“数据库内 admission/entry/audit 是否自洽”混为一谈。
- group 能力依赖 F-01/F-02 的权威入口和一致审计闭合；若这些基础事务保证尚未通过 runtime proof，group 写入不能宣称完成。

### N-G06 精确 group read filter

- group read 必须按显式 scope variant 与稳定 group key过滤。
- 同一真实容器中的两个 branch，各自写入后应能按 group 双向命中。
- 同 chain、容器外 run 按该 group 过滤不命中。
- group 是过滤维度，不是新的可见性边界：agent 可见性仍恒限 credential chain；同 chain 的 chain-scope read 仍可读取该 chain entries。
- operator 与 agent 读取继续遵守 F-04/F-05 的 typed pagination、response boundary 与 daemon-side chain confinement。

### N-G07 chain 隔离

- group 永不跨 chain。相同字面 ID、伪造 selector 或复制 handle 都不能越过 credential chain。
- group entry 的引用对象必须在 caller chain 内真实存在，不能产生跨 chain 或指向虚空的 row。
- operator 无凭证路径可选择任意 chain，但必须走 operator 的 typed 路径，不能由 agent 命令分类遗漏退化而成。

### N-G08 生命周期与身份稳定

- 容器 terminal、branch terminal、join 和 daemon restart 不得凭空改变已物化容器稳定 ID及其既有 entry 的解释。
- join 后不新增专属读取机制；后续同 chain run 依靠 chain 内自由读命中上游 branch entries。
- entry 与 chain 同生共死，append-only，无独立 group GC；chain 删除是唯一删除通道。
- 物理删除后的容器不得继续作为新 group append 的合法寻址对象。

### N-G09 restart 恢复

- restart 后必须从 durable runtime 事实恢复同一权威容器身份与 membership 结论，不能依赖进程内缓存或 caller 重报。
- 恢复后的 admission 与 read filter必须和 restart 前一致。
- durable fixture 可证明 snapshot round-trip、稳定 ID、parser 或恢复机制的局部性质；只有真实 producer形成的身份/归属才能作为产品 membership 输入。

### N-G10 typed boundary

- group scope、容器身份、membership 消费、admission 结果、拒绝原因、read request/response均须保持精确 ADT。
- 外部输入只在 boundary 以 `unknown` 接收并解析；内部不得退化为匿名对象、raw map、`any` 或真 `as`。
- scope variant和节点 variant均须穷尽消费。

### N-G11 真实路径证明

- 真实 scheduler 必须物化一个权威 `par` 容器并产生两个真实 branch run credential。
- 两个 branch 各写一条以该真实容器 ID为 key 的 group entry，再分别按 group 读取并双向命中。
- 同一证据路径还应观察非成员、不存在 key、跨 chain、terminal/restart，以及 join 后 chain read。
- fixture、direct store/tree构造、mock credential、unit/typecheck都不能替代此路径。

## C. F-01～F-10 与 CAP-IN 匹配

| 地基/输入 | group 所需保证 | 当前性质 |
|---|---|---|
| F-01 Storage authority / lifecycle | 唯一产品 authority、合法 scope 引用、append-only、chain-lifetime cleanup、restart 后无 residue | group 直接依赖；须先以 runtime proof 闭合 |
| F-02 Append / audit / transport | 接受/拒绝审计与 admission 一致；真实 socket 边界显式失败且不挂起 | group 写事务与可观察拒绝依赖；须 runtime proof |
| F-03 Persisted exactness | 合法 group envelope 经 migration/restart 精确保持；malformed row明确失败 | group 身份恢复和 entry 解释依赖 |
| F-04 Read pagination / response | group filter进入封闭 typed read与稳定可穷尽分页 | group read 自建过滤语义，但复用公共 read 地基 |
| F-05 Read authorization / classification | agent 恒限 credential chain；operator/agent typed 区分；命令分类穷尽 | group 不另造授权粒度，复用公共 read authority |
| F-06 Group 合法身份消费 | 真实 identity/membership 的 server-side校验、双向通信、terminal/restart稳定 | group 能力主体；其中 identity/membership 本身来自 CAP-IN-2 |
| F-07 Finalize / outcome | context outcome按本 run author 的 durable entry existence求值 | 非 group 专属；group entry若被写入，仍受同一 finalize 合同消费 |
| F-08 Prompt executable addressing | 仅向合法 run展示当前可提交的真实 group key；无合法 group明确不可用 | 消费 CAP-IN-2 的合法 identity；handle不扩权 |
| F-09 Docs / `shared.md` coexistence | group仍是结构化 context，不取代 `shared.md` 或 transition | 边界约束；不新增 group 特例 |
| F-10 Pure proofs / integrated evidence | pure oracle只证明解析/filter/membership消费；真实 `par` 路径证明生产与通信 | 证据总约束；S23不得由fixture替代 |
| CAP-IN-2 树运行态 shape | 权威容器身份、归属结论、稳定 ID存储位、谱系/节点 ADT | **外部输入**；本 RFC 不定义，未供给时 F-06不能闭合 |
| CAP-IN-3 真实 par 生产调度 | 真实容器物化、两 branch run及其真实 credential | **外部输入**；未供给时 S23/N-G11不能运行 |

## D. 接缝与外部输入

### D.1 group 能力自建

在 CAP-IN-2/3 给出权威输入之后，context group 能力负责：

- 把 group scope 纳入精确 request/envelope/read filter ADT；
- 在 daemon append admission 中调用并消费权威 membership 结论；
- 对不存在、非成员、跨 chain、无容器进行明确拒绝；
- 保证接受/拒绝、entry 与 audit 的持久事务结果一致；
- 实现 group read filter及其与 chain confinement、分页 response 的组合；
- 保证 terminal/restart 后的消费语义稳定；
- 提供合法 scope handle的可执行文档，但不把 handle当授权；
- 建立局部 pure proofs和真实 `par` 集成证明。

### D.2 外部必须供给

CAP-IN-2 必须先明确并交付：

- 哪个对象是权威 `par` 容器；
- 它的稳定 ID及 durable 存储位；
- run 对该容器的权威归属结论；
- 归属在 terminal/restart 时如何恢复；
- context 可穷尽消费的节点/归属 ADT。

CAP-IN-3 必须交付：

- 正常生产路径上的真实 `par` 容器物化；
- 至少两个真实 branch run；
- 每个 branch 的真实 credential；
- 可执行至 terminal/restart/join观察点的调度路径。

### D.3 地基尚未闭合

即使 CAP-IN-2/3 到位，以下 R9 地基在各自 runtime proof完成前仍不能假定成立：

- F-01：唯一 authority、引用完整性、chain lifecycle/restart；
- F-02：admission、audit与持久结果一致；
- F-04/F-05：公开 typed read、分页、agent chain confinement；
- F-03：合法持久数据的 migration/restart exactness；
- F-08：真实 CLI 与 prompt handle一致；
- F-10：证据强度与主张等宽。

## E. 不得依赖与范围外

- 不从结构 ancestry 推导 membership、集合或基数。
- 不设计或预埋 nested `par`、结合律、扁平化或多容器 membership。
- 不把 runtime/store 能表达的 fixture shape 当作合法 source shape。
- 不把 group ID、prompt handle或请求 selector当成授权。
- 不新增 `run` scope，不新增第三类主体，不扩展 phase rights。
- 不把 group变成跨 chain通道；也不把 group误写成 chain 内可见性边界。
- 不新增 join专属 read、自动复制、广播、隐式“当前组”或 fallback。
- 不用 direct store/tree fixture、mock credential、unit、typecheck或静态扫描冒充真实 `par` producer与通信。
- 不新增 exactly-once caller、operation identity、独立 group GC或未要求的 response cap。
- 不改变 `shared.md`、transition、evidence、GUI或并行结构层自身的设计所有权。

## F. 验证强度与证据

| 层级 | 可证明内容 | 不可外推 |
|---|---|---|
| Pure/ADT | scope parser、节点/归属 variant穷尽、membership消费函数、admission分类、group filter、typed response | producer真实存在、credential真实来源、socket事务、restart或真实通信 |
| Durable局部 fixture | 权威格式输入后的snapshot/entry round-trip、稳定ID保存、restart parser、拒绝不落库、filter局部行为 | 合法 source数学、真实 membership、真实 branch credential、S23双向通信 |
| Socket integration | credential-derived identity、伪造/不存在/非成员/跨 chain拒绝、entry+audit事务结果、typed read与分页 | scheduler确实生产真实 `par` 与真实 branches |
| 真实 `par` runtime | 真实容器、两个真实branch credential、双向group写读、组外不命中、terminal/restart、join后chain read | 未覆盖的并行数学或任意 nested语义 |
| 冻结 SHA综合复核 | 重跑S23及相关S24–S28路径，核对最终DB、audit、read结果与生命周期状态 | 不能以复核本身替代拥有该契约的能力修复 |

最低完整证据集合：

1. **身份/授权：** 记录真实容器 ID、两个 branch run/credential 与权威 membership 响应；伪造、非成员、跨 chain均被 daemon拒绝。
2. **事务：** 接受时 durable entry与接受审计一致；拒绝时无 entry且有匹配拒绝审计。故障/restart后数据库状态仍符合判定。
3. **读取：** 两 branch双向命中；容器外 run按group不命中；agent越chain零可见；operator路径保持typed区分。
4. **恢复：** terminal与daemon restart前后同一真实容器身份、membership消费和既有entry解释不变；chain删除后entry清除且旧对象不可新寻址。
5. **join：** 后续同chain run通过普通chain read读到上游branch entries，且没有join专属代码路径作为证明前提。
6. **类型：** scope、membership、admission、filter与节点variant的exhaustive tests/typecheck为辅助证据；不得替代以上runtime路径。

