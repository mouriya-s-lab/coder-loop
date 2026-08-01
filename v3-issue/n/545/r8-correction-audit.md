# RFC #545 R8 纠错审计

## 第一项纠错：K1 不形成操作员 Decision

### 1. 错误性质

旧 R8 把 aggregate 中的内部标准 ID `S23`、以及从旧 #734 目标句合成的 `S45`，组合成三种所谓验收形态，要求操作员选择 fixture 与真实路径分别在哪一行形成“关闭”。这违反需求锚定：

- `S23` 是聚合阶段为标准池新增的内部 ID，不是用户提出的产品概念。
- `S45` 不是 SYNTH 原始终态表中的一行；它来自旧 #734 的目标句“新增真实 parallel group communication 关闭行”。
- 评审发现的目标句/验收表证据强度冲突，只能生成需要按产品目标收敛的问题，不能生成新的产品选择。
- 三种形态改变的是报告如何分配证据与使用内部“关闭”措辞，不改变用户实际使用 context group 时的行为，因此不应要求操作员裁决。

### 2. SYNTH 原文锚点

权威原文位于 `/Users/mouriya/Ext/code/coder-loop/v3-issue/synthesized/SYNTH-545-context-shared-cli.md`：

1. **第 203–207 行，旧 #731 目标：** 第 205 行明确写明“必须依赖真实 par 生产调度，以两个真实并行 branch credential 写读同一稳定 group id；禁止直接 store fixture 冒充。”这是稳定产品目标。
2. **第 227–237 行，旧 #731 验收表：** 第 232 行又要求 fixture 构造 `par(leaf, leaf)` 树运行态且不经调度。它可作为局部机制证据，但覆盖不了目标句要求的真实 producer 与两个真实 branch credential。
3. **第 359–363 行，旧 #734 目标：** 第 361 行只有“新增真实 parallel group communication 关闭行”的目标句。
4. **第 388–402 行，旧 #734 冻结 SHA 复核表：** 实际九行终态条件中没有单列 parallel group communication。因此 aggregate 的 `S45` 是从目标句补合的标准，不是原表既存行。

按稳定目标与 repo 验证边界收敛后的唯一口径是：fixture 只支持与其覆盖范围相同的 durable tree、lineage、membership 等局部主张；“真实 parallel group communication”必须由真实 `par` 调度产生的两个 branch credential 写读路径证明。无需在两者之间选择。

### 3. 修正范围

- `r8-decision-index.md` 的 K1 归入“已由稳定目标收敛，无需裁决”。
- `r8-archive-group.md` 不再讨论内部标准行如何分配证据。
- `r8-archive-prompt-scope.md` 先呈现无状态 agent 组成 CLI 命令时知道/不知道哪些地址，再呈现四种合同。
- 前序 `aggregate.md`、`materials.md` 保留，作为矛盾如何产生的事实记录，不在本次纠错中改写。

### 4. 当时保留项及后续纠正

第一轮纠错当时仍保留了嵌套并行组 membership 与 prompt scope 信息。后续有效性审计证明前者同样由报告/fixture 自身生长，见下述第二项纠错；因此当前只剩 prompt scope 信息。

prompt scope 信息仍追溯到 SYNTH 明写的 K4b：静态用法、identity、scope handles 及其组合会让无状态 agent 获得不同命令填参信息，并改变合法 prompt 内容与文档合同。

## 第二项纠错：合法 source 空间不等于 runtime 可表达空间

### 1. 错误性质

R7/R8 曾用手工 runtime fixture 构造含多个 `par` 祖先的树。因为 parent traversal 能恢复这些祖先，报告继而把它们投影成 caller 可能拥有的多个 group membership，并生成一个操作员选择题。这条推导没有需求来源：

- 当前合法 preset/source 没有 `par` 声明，compiler 与 scheduler 也不生产 `par`；
- runtime snapshot/store 的递归 boundary 较宽，能存某种形状只证明“无效状态可表达”，不证明 source grammar 接受它；
- 未来权威 G3 确实要求两个并行层次，但它们通过复合 `seq/par` 结构组合；结构中有两个并行容器，不推出一个后代 run 同时拥有两个可选通信 group；
- RFC #545 的稳定合同只消费并行结构层给出的真实容器身份，不拥有并行数学或 membership 唯一性的设计权。

因此，描述两种假想 CLI 结果并不能证明产品必须二选一。错误根因是把 **runtime 可表达空间** 替代 **合法 source 空间**，再把结构 ancestry 错当成通信 membership。

### 2. 权威证据与精确结论

完整调查在 `r8-nested-par-validity-audit.md`：

1. 当前 source/compiler/scheduler 不会产生 `par→par` 或 `par→seq→par`；
2. 目标编排的 recursive `seq/par` 与 G3 两层组合尚未定义 `par` 结合律、规范化律或多 membership；
3. runtime/store 确实可以 round-trip 多祖先 fixture，但它不是合法 source 证明；
4. aggregate 的 K4a 候选只来自该 fixture 投影，没有真实 producer 或 consumer 要求；
5. RFC #545 应等待并消费并行结构 RFC 的单一权威结论，不预埋自己的候选。

精确收敛不是断言“所有两层并行都非法”，也不是替并行 RFC 补写数学；而是：**现有证据不允许把 runtime 多祖先 fixture 当作 RFC #545 的合法 membership 需求。**

### 3. 修正范围

- `r8-decision-index.md` 的 Decision 总数改为 1；K4a 登记为伪问题。
- 原活跃嵌套 membership Decision 已删除；`r8-archive-group.md` 改为非决策事实档案。
- `r8-archive-prompt-scope.md` 不再等待或暗含 ancestry membership 选择；group handle 只能来自并行结构层定义并由 daemon 验证的真实容器身份。
- `aggregate.md`、`materials.md` 与 `WORKFLOW.md` 不在本次报告纠错中改写，保留阶段事实与职责边界。

### 4. 当前剩余 Decision

该轮当时仍把 prompt 字段组合保留为产品选择。后续有效性审计证明这也是由报告组合轴生成的伪需求，见下述第三项纠错。

## 第三项纠错：字段组合笛卡尔积不构成产品需求

### 1. 错误性质

旧 prompt 档案把“是否有动态内容”与“identity 标签／scope handle”排列成字段组合，再把组合结果包装成多个可选合同。这个笛卡尔积没有对应多个用户目标：用户只要求无状态 agent 获得 context append/read 用法，并能对本 run 可用 scope 组成合法调用。

- 只给静态用法，在当前显式参数 shape 下不能让 agent 获得 item/group key，也删除了原文要求的 run-relative scope 寻址说明；
- 增加 `chain/item/run/phase` identity 仍不能解决 group 寻址，且 `run/phase` 不是 context scope；
- identity 与 scope 地址的并集只是冗余字段超集，没有新增用户场景；
- 把“必须展示 handle”冻结为产品选择同样过度，因为最终 CLI 可以让某些地址由 credential 自动推导。

字段集合有多种排列，只说明呈现或 boundary shape 有多种可能，不证明需求层存在同数量的产品分叉。错误根因是从产物自身的分类轴生成候选，再让用户替报告选择字段集合。

### 2. 唯一合同来源

原始 SYNTH 已明确：声明 context 工具的 phase 通过 doc-binding 获得“CLI 用法 + 本 run 的 scope 标识”，entry body 不进入 prompt；scope 闭集是 `item | chain | group`，明确没有 `run` scope。结合无状态 agent 的调用目标，唯一稳定合同是：

> `toolRequirementsDoc` 为声明 context capability 的 phase 注入 append/read 用法，并对本 run 的每个可用 scope 给出可执行寻址说明：credential 自动推导的参数明确标注无需填写；CLI 要求显式提交的 stable key 则提供当前合法值。不得展示 credential，不得增加 run scope，不得注入 entry body。

当前 append 要求显式 chain selector，并在 item/group scope 要求 stable key；credential 会自动附带但不替调用方填写这些地址。未来 read 尚未实现，不能预造 flag。故“显示具体值”还是“说明自动推导”只能随最终 CLI boundary 决定，不是用户需选择的产品行为。

完整调查见 `r8-prompt-decision-validity-audit.md`。

### 3. 修正范围

- `r8-decision-index.md` 的 Decision 总数改为 0，K4b 登记为唯一实现合同，R8 无待选择项。
- `r8-archive-prompt-scope.md` 原位改为事实／合同档案，不再列字段组合候选或选择表。
- active R8 档案只保留用户目标、唯一合同、当前 append 事实、未来 read 边界、验收 oracle 与外部输入。
- `aggregate.md`、`materials.md` 与 `WORKFLOW.md` 不在本次报告纠错中改写。
