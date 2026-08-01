# R8 DEC-545-03 有效性审计：prompt 中的 scope 信息

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只审计 DEC-545-03 是否是需求层真实分叉；不修改代码、issue、WORKFLOW，也不引入 credential 展示、run scope、nested group 或 DSL 机制。

## A. 结论

**DEC-545-03 不是需要操作员在 C0–C3 中裁决的产品分叉。**

原始合同已经给出产品结果：声明 context 工具的 phase，其 prompt 经 doc-binding 获得：

1. 覆盖 context append/read 的 CLI 用法；
2. 足以让当前无状态 agent 对本 run 可用的 `chain`、`item`、`group` scope 组成合法调用的**运行时寻址说明**；
3. 不含任何 entry body。

“本 run 的 scope 标识”自然指上述 run-relative scope 寻址信息，不是 `chain/item/run/phase` author identity 标签。原裁决明确 scope 闭集只有 `item | chain | group`，不设 `run` scope；`runId`、`phase` 因而不是 scope 标识。没有已记录用户场景要求 context 用法文档重复展示 run/phase 诊断标签。

实现可以让某个地址由 credential/daemon 推导，也可以要求 CLI 显式提交稳定 key；这是 CLI boundary 的实现 shape，不是 prompt 产品选项。稳定合同是：**用法文档必须把“哪些值自动推导、哪些值须显式提交、须提交时当前合法值是什么”说完整，使 agent 不必从未定义的外部来源猜 key。** 当前已落地 append CLI 要求显式 chain selector，`item`/`group` 还要求稳定 ID，因此若沿用该 shape，doc-binding 必须给出当前 chain、当前 item 业务 ID，以及当前存在时的 group 稳定 ID。若后续正式 CLI 将某个当前 scope 改为 credential-derived default，则文档应说明省略规则，无须为同一值再造展示字段。

C0–C3 把“静态/动态”和“identity/handle”排列成字段组合，却没有对应四种用户需求。C0 在当前显式参数 shape 下不能履行调用合同；C1 添加与 scope 无关的 run/phase 且仍缺 group 地址；C3 是 C1 的冗余超集；C2 最接近原文，但“必须显示 handles”仍过度固定实现，因为 credential-derived default 也可满足同一产品合同。应撤销 DEC-545-03，而不是请求操作员选 C0–C3。

## B. 原文语义

### B1. 权威裁决已经区分 scope 与 author identity

SYNTH 的操作员裁决把 scope 闭集定为：

- `item`：同一 item 跨 run/phase 谱系；
- `chain`：跨 item 的链级公告；
- `group`：并行分支组内通信；
- 明确“不设 `run` scope”。

同一节另把 author 定为 credential 推导的 `chain/item/run/phase`。因此：

- `runId`、`phase` 属 author/执行身份；
- `chain`、item stable key、group stable key 属 scope 寻址；
- 不能因为短语写了“本 run”就把 run identity 四元组重新命名为 scope。

证据：`SYNTH-545-context-shared-cli.md:36-41`；聚合后的同义约束见 `aggregate.md:18-24`。

### B2. “CLI 用法 + 本 run 的 scope 标识”服务于无状态 agent 调用

原目标是让独立运行的无状态 agent 通过 CLI 传递 context；读取形态紧接着规定 agent 按 scope/item/since 过滤，并由 doc-binding 注入“CLI 用法 + 本 run 的 scope 标识”，而不是内容。这里的“标识”是用来完成调用寻址的文档材料，不是另设诊断面。

最小且自然的精确含义是：

> 对每个可用 scope variant，说明当前 run 调用 append/read 时如何寻址；自动推导的地址明确说明推导规则，必须显式提交的地址提供当前合法稳定值。

这既不要求展示 credential，也不要求新增通用 runtime identity 面。证据：`SYNTH-545-context-shared-cli.md:57-59`。

### B3. 原 SYNTH 的“无需 runtime id”只是实现充分性检查

后续 child 草稿写道：“凭证已让 daemon 端到端推导 author 与 scope 键，用法文档可能无需携带运行时 id（agent 直接调命令即可正确寻址）”，并要求按“凭证推导充分性”裁决。该句询问的是**所选 CLI shape 是否已能自动寻址**，不是要求在 identity 标签与 handles 之间选择产品形态。

同一 SYNTH 对 group 又明确区分：

- 默认键可由 credential 所属运行态推导；
- 若开放显式指定路径，则提交的 key 必须解析到真实容器。

所以“是否显示具体 ID”只能随 CLI 的参数合同决定：默认推导路径不需要重复显示 ID；显式路径必须使 agent 得到要提交的 ID。证据：`SYNTH-545-context-shared-cli.md:217-218,274-276`。

## C. 真实调用需要的信息

### C1. 当前 append（已实现 shape）

基线源码的当前命令是：

`coder-loop context append <chain> --scope <chain|item|group> [--item <id> | --group <id>] (--body ... | --body-file ...)`

调用方显式提供：

| scope | 当前 CLI 显式参数 | daemon/credential 推导 |
|---|---|---|
| `chain` | positional chain selector、`--scope chain`、body | agent author；credential bound chain 用于核对 selector |
| `item` | positional chain selector、`--scope item`、业务 item stable ID | agent author；bound chain/item 用于 admission 核对 |
| `group` | positional chain selector、`--scope group`、group stable ID | agent author；当前基线尚无真实 group 正路径 |

CLI 从 `CODER_LOOP_RUN_CRED` 自动向三段 append socket 命令附带 credential；credential registry 绑定 `chainId + item rowId + runId + phase`。它当前**不替调用方填 positional chain、item ID 或 group ID**。daemon 用 credential 构造 author、约束 chain，并校验 scope key；selector 不是授权来源。

证据：

- `src/loop.ts@699842e:1943-1986`：append 参数与 begin/chunk/commit；
- `src/context-entry.ts@699842e:4-10,121-136`：scope ADT 与显式 key；
- `src/loop.ts@699842e:2526-2556`：credential 自动附带；
- `r7-d05-read-auth.md:17-19,61-63,69-84`：credential binding、selector 与 handler 核对。

因此，在**当前 append shape** 下，仅有静态语法不足以让一个无状态 agent调用：

- chain name 可由已有 engine runtime binding `chainName` 得到；
- item 业务 ID 可由 preset 已声明的 `item.<idField>` binding 注入（它不是新增 context identity 轴）；
- group stable ID 没有现有通用 runtime binding，也不能从静态用法发现；若 CLI 要求显式 `--group`，context doc 必须带来该值。

### C2. 目标 read（稳定合同，未实现 shape）

基线没有 context read CLI、daemon command 或 response boundary，不能虚构具体 subcommand/flag。稳定合同只确定：

- agent 查询的 chain 由 credential 限定；caller 指定他 chain必须无效或被拒；
- operator 无 credential 可选择任意 chain；
-过滤闭集是 `scope variant + stable key`、author subject/phase、`after` cursor；
- `pageSize` 是每次请求显式正整数；
- 返回 `nextCursor | exhausted`。

因此 read 用法文档须说明 selector/filter 的精确最终 CLI shape；对于 scope filter，若 boundary 要求 stable key，就与 append 一样必须提供或说明其现有来源。`author phase` 是查询过滤值，不等于“本 run phase 标签”；用户可能查询其他 author/phase，不能把当前 phase 展示包装成 read 所需 scope 信息。

证据：`aggregate.md:24-27`（D8/D10/D11）；`r7-d05-read-auth.md:5-7,33-35,173-180`（read 尚不存在及未来 chain confinement seam）。

### C3. credential 能推导什么，不能据此假定什么

credential 权威绑定 author identity 与 agent 所属 chain。它能让 daemon：

- 构造不可自报的 author；
- 把 agent 可见性限制在所属 chain；
- 校验显式 selector/scope key。

它并不自动意味着最终 CLI 一定省略 chain/item/group 参数。当前 CLI 事实上没有省略。未来 group 的默认键可以由真实并行运行态推导，但 SYNTH 同时保留了可能的显式指定路径。故正确合同不是“永远显示 ID”或“永远不显示 ID”，而是让 doc 与最终 CLI 参数语义一致并可直接执行。

## D. C0–C3 需求追溯

| 形态 | 需求追溯 | 结论 |
|---|---|---|
| C0：仅静态用法 | 只能在最终 CLI 对当前 scope 完全凭 credential 推导、无需未提供 key 时满足调用目标；当前 append shape 不满足。它还删除原文明确要求的 run-relative scope 寻址说明。 | 不是独立产品合同；只是某种自动寻址实现下可能产生的文档结果。删除为裁决选项。 |
| C1：静态用法 + `chain/item/run/phase` identity | `run/phase` 无 context scope 用户场景，且 D2 明确无 run scope；group 地址仍缺失。 | 追溯不到需求，删除。 |
| C2：静态用法 + scope handles | 对当前显式 append shape，可履行 agent 组成 variant/key 的需要；与原文最接近。 | 保留其“调用所需寻址信息”实质，但不把“必须显示 handle 字段”冻结为产品选择；自动推导的参数只需文档说明。 |
| C3：identity + handles | handles 已解决调用；额外 run/phase identity 没有需求。 | C2 的冗余超集，删除。 |

由此没有剩余的普通用户行为分叉。真正可观察的要求只有一个：agent 读到 doc 后能否在不猜 key、不读 entry body、不从未定义外部来源找 ID 的前提下，组成目标 CLI 调用。具体值是“显示”还是“credential-derived”属于实现与 boundary 对齐。

## E. 对 R8 的处置

1. 从 R8 decision 集合撤销 DEC-545-03；不得再向操作员呈现 C0–C3。
2. 把 K4b 收敛为一条实现合同，而非决策：

   > `toolRequirementsDoc` 为声明 context capability 的 phase 注入 append/read 用法，并对本 run 的每个可用 scope 给出可执行寻址说明：credential 自动推导的参数明确标注无需填写；CLI 要求显式提交的 stable key 则提供当前合法值。不得展示 credential，不得增加 run scope，不得注入 entry body。

3. 在实现 issue 确定最终 read/append CLI boundary 时，用命令级验收证明：
   - prompt 中给出的用法可以由该 run 直接执行；
   - 显式 key 与自动推导规则无矛盾；
   - agent 不需要猜 group key；
   - daemon 仍独立以 credential/持久结构验证 caller、chain 和 key。
4. 已有 `chainName`、preset item id binding 可复用；是否把它们以内联示例、doc 字段或既有 placeholder 组合渲染，是呈现/接线问题，不重开产品裁决。

## F. 证据索引

| 结论 | 权威证据 |
|---|---|
| scope 只有 item/chain/group；无 run scope | `../../../v3-issue/synthesized/SYNTH-545-context-shared-cli.md:36-41` |
| doc-binding 注入 CLI 用法 + 本 run scope 标识，不注入内容 | 同文件 `:57-59` |
| group 默认键可凭证/运行态推导；显式路径仍须校验真实容器 | 同文件 `:205-218` |
| “是否注入 runtime id”应按凭证推导充分性判断 | 同文件 `:255-276` |
| 当前 append 要求 chain selector、scope variant、item/group key | `src/loop.ts@699842e:1943-1986`; `src/context-entry.ts@699842e:4-10,121-136` |
| credential 自动附带但只在 daemon 解析为 author/chain authority | `src/loop.ts@699842e:2526-2556`; `r7-d05-read-auth.md:17-19,69-84` |
| 已有 runtime `chainName` 与 item binding 能力；无 group binding | `src/loop.ts@699842e:1221-1272,5778-5835,6007-6054` |
| read 尚不存在；不能假设具体 flag | `r7-d05-read-auth.md:5-7`; `r7-d06-group-lineage.md:105` |
| read 稳定过滤合同 | `aggregate.md:24-27` |

