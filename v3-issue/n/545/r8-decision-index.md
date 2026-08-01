# RFC #545 R8：事实与合同档案索引

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本索引只整理已有正式报告；不实现代码、不重拆 issue，也不从报告编号、验收排布或 runtime fixture 的宽表达能力生成产品需求。

## A. 主 agent 摘要

R8 的 **Decision 数为 0**，没有待用户选择的产品分叉。

K1 已由真实 `par` 路径的稳定产品目标收敛；K4a 已由合法 source 与 runtime 可表达空间的边界收敛；K4b 已由原始 doc-binding 目标与当前 CLI boundary 收敛为唯一实现合同。其余 K 项均已有稳定去向。

## B. K4b 唯一实现合同

声明 context capability 的 phase，由 `toolRequirementsDoc` 注入 append/read 用法，并对本 run 的每个可用 scope 给出可执行寻址说明：

1. credential 自动推导的参数明确说明无需填写；
2. CLI 要求显式提交 stable key 时，提供当前合法值；
3. 不展示 credential；
4. 不增加 `run` scope；
5. 不注入 entry body。

该合同要求 agent 不依赖未定义的外部来源猜 key，同时不固定值必须以独立字段、预填示例或其他特定呈现形态出现。最终文档必须与最终 CLI 参数语义一致，daemon 仍独立用 credential 与持久结构验证 caller、chain 和 key。

## C. 无需选择／不得重开

| 主题 | 处置 |
|---|---|
| group 真实路径的证明强度 | 产品目标已经要求真实 `par` 调度与两个真实 branch credential；fixture 只能证明其实际覆盖的局部机制。 |
| nested group membership | 当前合法 source 无 `par`；未来两层组合不推出多 membership。runtime fixture 的多祖先只是无效状态可表达。RFC #545 只消费并行结构层给出的真实容器身份。详见 `r8-archive-group.md` 与 `r8-nested-par-validity-audit.md`。 |
| prompt scope 文档 | 原始目标已经要求可执行的 run-relative scope 寻址说明；显式值或自动推导只随 CLI boundary 变化，不是产品选择。详见 `r8-archive-prompt-scope.md`。 |
| shared/context 并存、scope 闭集、author/chain 可见性 | D1–D3 已定；现状偏离只生成修补任务。 |
| required/expected outcome 与“一切 run” | D4 已定；trigger/validator lifecycle 是跨 RFC 输入。 |
| body 不透明、append-only/GC、socket/audit、大内容、分页 | D5–D10 已定；R7 事实限定实现与证明，不产生新目标。 |
| scope key 有效 | D11 已定；group key 只可来自权威并行结构身份。 |
| context 不承担 transition、中间态定位、精确 ADT、read boundary | D12–D15 已定。 |
| exactly-once、畸形行容错、任意 response cap、GUI/hook 新消费形态 | 稳定需求没有提出；不得由风险或评审反例扩张范围。 |
| DSL 语法、真实 par producer、统一 trigger/validator lifecycle | 跨 RFC 输入；本 RFC 消费能力，不在此重新设计。 |

## D. K1–K5 逐项处置

| K | R8 处置 |
|---|---|
| K1 | 真实 group 行为只由真实 `par` 路径证明；fixture 是局部证据。内部验收表冲突不生成产品分叉。 |
| K2 | D4 已要求一切 run；等待统一 lifecycle 输入，不裁缩窄范围。 |
| K3 | 是跨 RFC 供给与账目问题，不形成新产品选择。 |
| K4a | 伪问题。合法 source 空间与 runtime 可表达空间曾被混淆；多个结构祖先不授予多个 group membership。RFC #545 只消费并行结构层定义的真实容器身份。 |
| K4b | 已收敛为 B 节的唯一实现合同。 |
| K5 | 无定义引用残留；没有权威定义时删除残渣，不从编号猜能力。 |

## E. D/P 反向覆盖

| R6/R7 任务 | R8 去向 |
|---|---|
| D-01 lifecycle | 按 D6/D11 修补与验证；无新增选择。 |
| D-02 append transport | 按 D7/D9 修补；不新增 exactly-once。 |
| D-03 historical data | 按 D14 收敛精确 boundary；不新增部分成功语义。 |
| D-04 pagination | 按 D9/D10 验证既有 snapshot/keyset 主张；不新增任意 cap。 |
| D-05 read auth | 按 D3/D7 修补；prompt 可用性遵循 K4b 唯一合同。 |
| D-06 group lineage | 真实路径证明口径已确定；fixture 多祖先不生成 membership 需求，消费权威并行结构身份。 |
| D-07 finalize/outcome | D4 已定；等待跨 RFC lifecycle 输入。 |
| P-01 prompt sentinel | 证明 entry body 零注入，并正向验证 K4b 允许的寻址说明。 |
| P-02 external consumers | 纯证明；不生成 GUI/hook 需求。 |
| P-03 proof ledger | 纯证明；fixture 与真实路径各自只支持覆盖范围相同的主张。 |

## F. 档案映射

### prompt scope 事实／合同档案

- **覆盖：** K4b。
- **合同：** context 用法文档使无状态 agent 能按最终 CLI boundary 对本 run 可用 scope 直接寻址。
- **正式输入：** `aggregate.md` 的 D3/D8/D11/D14、S19/S29/S36/S42、K4b；R7 的 credential、selector、run/lineage 与 doc-binding 事实；`r8-prompt-decision-validity-audit.md`。
- **排除：** group 数学或 membership 设计、授权修补、DSL 语法、body 注入、GUI。
- **正式档案：** `r8-archive-prompt-scope.md`。

`r8-archive-group.md` 是非决策事实档案：它记录 K4a 如何被 runtime fixture 污染，以及 RFC #545 的合法消费边界。

## G. 完整性审计

1. **Decision 数：** 0。
2. **K1/K4a/K4b：** 均已按稳定目标、合法 source 边界与可执行 CLI 合同收敛。
3. **K 完整性：** K1–K5 均有唯一去向。
4. **D/P 完整性：** D-01～D-07、P-01～P-03 均已反向覆盖。
5. **需求锚定：** 报告编号、验收排布、fixture 宽边界、字段组合与工程落点均未生成产品需求。
6. **阶段条件：** R8 已无待选择项，事实／合同档案和纠错审计齐备，具备进入 R9 的条件。
7. **职责边界：** 本索引没有实现代码、创建 worktree、重拆 issue 或运行实验。
