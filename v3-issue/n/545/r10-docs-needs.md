# RFC #545 R10：文档与 prompt 合同需求

本文只把 `aggregate.md` 的 D1/D8/D13/D14、S19/S29/S36/S40–S43，`r9-expected-foundation.md` 与 `r8-archive-prompt-scope.md` 的唯一合同翻译成原子能力需求。它不定义命令语法、实现方案、issue 顺序或并行数学；最终文档只能记录届时已经存在且可执行的实现事实。

## A. 摘要

文档面有两个相邻但不同的交付：

1. **静态文档对齐。** 直接替换 CLAUDE 与相关 docs 中已经失真的无状态、持久事实、`shared.md`、handoff 和“唯一通道”表述，使其一次性表达当前边界；作者手册解释 capability 声明、`required | expected` 语义和 binding/doc-builder 计数守护流程。
2. **每个 run 的可执行 prompt 文档。** 只有声明 context capability 的 phase 获得真实 append/read 用法；CLI 自动推导什么就明确什么无需填写，CLI 显式要求哪个 stable key 就提供该 run 当前合法值，没有合法 scope 就明确不可用。prompt 不含 entry body，也不展示 opaque credential、author identity 标签或不存在的 `run` scope。

这两项不能用散文先行制造实现。尤其 read 尚须由 F-04/F-05 提供真实 CLI、typed request/result 与鉴权边界；capability 声明及 per-phase 文档切片依赖 CAP-IN 工具声明位；group handle 依赖并行结构层提供合法身份和归属结论。文档面自身可以拥有 no-legacy 改写、相关 docs 盘点、作者视角说明、help/docs/schema 对照和 count-guard 更新，但只有在被描述的 boundary 已落地后才能完成实态对齐。

R9 已提供可消费的**预期合同**与局部资产，而不是已完成行为：现有 doc builder/phase slicing、runtime binding count guard、`chainName`/item binding 和 `shared.md` 创建/注入机制可保留；F-08 固定可执行寻址与 body 零注入，F-09 固定双通道并存和 no-legacy，F-10 固定证据强度。read、context capability、`toolRequirementsDoc`、合法 group binding 和全 phase sentinel 证明仍未闭合。

## B. 原子需求

### N-D01：`shared.md` 与 context 并存边界

- `shared.md` 继续是 chain 级自由 prompt 注入面；context 是结构化、受控、可审计的 chain 生命周期中间态。
- 相关 docs 中每一处 `shared.md` / handoff / 跨 run 传递叙述，都必须用这一分工核对；需要改的直接替换，不需要改的留下逐点核对证据。
- context 不替代 transition、后继必需交付、持久业务事实、trace 或 evidence；“并行分支唯一结构化受控通道”不得扩写成 agent 不存在其他行为旁路。
- `shared.md` 机制不改，并须保留其创建、显式 prompt 注入和 context store 零替代行为。

### N-D02：无状态与持久性边界改写

- CLAUDE 的无状态前提必须按 D13 直接改写成单一当前结论：agent run 仍无状态；持久业务语义仍只依赖 GitHub；context 是删 chain 即消失、不能承担流转信号或持久事实的受控中间态。
- A 域只收编“跨 run 传递”子类的结构化 envelope、socket transport 与 audit；引擎不解析 body 语义。B 域、trace、evidence 与 `shared.md` 边界不变。
- 不保留旧结论、勘误层、删除线或“过去/现在”对照。

### N-D03：闭合 capability 声明与 per-phase 切片

- context 必须是闭合 capability union 的成员，成员携带覆盖 append/read 的用法文档内容，并由穷尽 switch 消费。
- per-phase `toolRequirements` 只把对应文档切片注入声明该 capability 的 phase；未声明 phase 不获得该文档。
- 作者手册必须从 preset 作者视角说明 context capability、`required | expected` 的可执法边界，以及新增 binding/doc builder 时如何同步计数守护。
- 文档不得把当前空 projection、松散工具名字符串或静态 prose 当成 capability 注册已经存在。

### N-D04：append 的真实 help 与 boundary

- prompt 和作者文档只能复制最终真实 append CLI 的命令、selector、scope variant、body 输入与自动推导规则。
- 对最终 boundary：credential/daemon 自动推导的参数明确标注无需填写；仍须显式提交的 chain selector、item/group stable key必须获得本 run 当前合法值。
- CLI 预填值只用于寻址，不是 capability；daemon 仍独立验证 credential、chain、item 与 group membership。
- 文档不得暴露 opaque credential，不得把 CLI 重写当 server-side authority。

### N-D05：read 的真实 help、typed boundary 与鉴权

- read 尚未形成的 subcommand、selector、flag 或 JSON shape一律不在文档中预写。
- read 落地后，prompt/作者文档必须逐项对齐其真实 `--help`、typed request/result、scope 与 author filter、显式正整数 `pageSize`、`after` cursor、`nextCursor | exhausted`。
- agent read 恒限 credential chain；operator 无 credential 可选择 chain。文档不能用调用者自觉、显式 selector 或 prompt handle替代 daemon confinement。
- author phase 是 filter 值，不是 scope；不得由此新增 `run` scope。

### N-D06：runtime scope availability

- `chain | item | group` 是 scope 闭集。对每个本 run 当前合法 scope，文档必须足以直接组成真实调用，无需猜 key 或读取 credential。
- chain 与 item 的可执行值可消费 R9 所列的既有 `chainName` 与 preset item binding，但必须与最终 CLI boundary 接线并经命令执行证明，不能仅因 binding 存在就宣称完成。
- group 地址只能消费并行结构层给出的真实容器身份与归属结论；本簇不得从 runtime ancestry 合成 membership、基数或 key。
- 没有合法 group 时明确显示不可用；禁止伪 key、猜测、静默 fallback。何时存在合法 group 由 CAP-IN 并行结构能力决定，不由 prompt 文档决定。

### N-D07：entry body 零注入

- prompt 只注入用法与可执行寻址信息，不注入 entry body、摘要、marker、sentinel 或由 body 派生的内容。
- 该义务覆盖所有 phase 渲染路径，不能以静态零引用或某一个 direct phase 代替。
- body 零注入与 read 可用性并存：agent主动调用 read 拉取内容，doc-binding 自身永不推送内容。

### N-D08：help / docs / schema 实态一致与 no-legacy

- CLAUDE、作者手册、相关 docs、root/nested `--help`、typed command/tool boundary 和 prompt 文档必须描述同一个现存命令面。
- 文档生成只能引用已实现 boundary；命令或 schema改变时，先形成实现事实，再据此更新 help与文档，不能凭记忆预写未来 flag。
- read response boundary 是未来 GUI consumer 契约；shape 变更必须显式列 diff，但本文不新增 GUI 行为。
- 全文以 no-legacy 方式直接替换；删除无权威定义的旧编号、外部 issue 残渣及互相否定的旧结论。

### N-D09：binding/doc-builder count guard

- 新增 runtime binding 或 doc builder slice 时，必须同步其单一事实源、作者手册中的维护流程和现有计数守护。
- `bun test` 中的计数守护必须通过，并证明新增成员被纳入；不得通过放宽计数、catch-all 或 stringly fallback 绕过闭合 union。
- count guard 只能证明清单同步和穷尽接线，不能替代 prompt 可执行性、body sentinel 或 runtime authorization 证明。

## C. Foundation / CAP / 其他能力匹配

| 原子需求 | R9 已提供 | 文档面自建 | 仍依赖的能力或未闭合地基 |
|---|---|---|---|
| N-D01 并存边界 | F-09 合同；现有 `shared.md` 创建/注入机制；S13 局部运行基线 | docs 现场盘点、直接改写、并存说明、冻结点复核记录 | F-10 要求与主张等宽的 runtime 零回归；不能从文档推出机制正确 |
| N-D02 无状态边界 | F-09 的 D13 稳定合同 | CLAUDE 单层替换与 no-legacy 清理 | context lifecycle/authority 由 F-01/F-02/F-03 实现事实支撑；未成立前不得写成已交付 |
| N-D03 capability 与切片 | 现有 doc builder/phase slicing/count guard 是可保留资产；F-08/F-09 固定消费合同 | context 文档内容、作者视角说明、count-guard 接线说明 | **CAP-IN 工具声明位**：`[[tools]]`、per-phase `toolRequirements`、闭合 capability union、`toolRequirementsDoc`；F-07 提供 outcome/finalize 语义 |
| N-D04 append help | F-02/F-03 描述修补后 append/transport/exactness；R8 固定寻址规则 | 从真实 help/boundary生成或核对 prompt 文案 | F-01/F-02 的 server-side authority与真实 transport尚须闭合；不能把当前局部 append资产当最终完整合同 |
| N-D05 read help | F-04/F-05 固定过滤、分页、response与auth合同 | read 落地后的 help/docs/schema逐项对照 | F-04/F-05 当前未落地的 read CLI、typed request/result、分类与 confinement；GUI只消费其结果，不供给命令 |
| N-D06 scope availability | F-08；已有 `chainName`/item binding | 把合法 runtime值接入 per-phase 文档；无 scope负文案 | chain/item须匹配最终 boundary；group依赖 **CAP-IN 树运行态 shape/权威归属**，真实路径另依赖 CAP-IN par producer；RFC 不定义并行数学 |
| N-D07 body 零注入 | F-08/F-10 与 S19 oracle | 全 phase doc rendering 的负注入证明 | read 与 prompt 渲染路径均落地后才能做完整 sentinel proof；静态 grep 不足 |
| N-D08 实态/no-legacy | F-09 固定所有权与改写原则 | help/docs/schema审计、直接替换、旧残渣删除 | append/read/capability实现必须先成为事实；read boundary变更需向未来 consumer显式声明 |
| N-D09 count guard | 现有 runtime binding count guard 和 ADT惯例 | 新成员同步、作者手册维护流程、测试证据 | CAP-IN capability union 与具体 runtime/doc binding先有精确成员；F-10限制证据外推 |

文档能力可以自建的是**陈述、切片内容、盘点、生成/核对、no-legacy 与守护接线**。它不能自建 read 命令、授权、outcome、统一 finalize、group membership 或 parallel producer，也不能通过展示 runtime 值补齐这些能力。

## D. 接缝与生成顺序约束

以下是事实生成依赖，不是 issue 或施工先后编号：

1. **boundary 先于命令文档。** append/read 的 typed command、真实 `--help`、自动推导与显式参数先成为可运行事实，之后才生成或核对静态用法；read 未落地时只保留稳定需求，不命名 flag。
2. **合法身份先于 runtime handle。** chain/item 值必须来自已存在 binding并匹配最终参数；group handle必须来自 CAP-IN 权威身份/归属。prompt 不从结构形状反推数学。
3. **capability 声明先于 per-phase projection。** CAP-IN 提供闭合工具成员与 `toolRequirementsDoc` 切片位后，本簇才能接入 context文档；未声明 phase 的负投影与声明 phase的正投影应由同一闭合分派产生。
4. **实现事实先于仓库文档收口。** CLAUDE/docs可先消除与稳定 D1/D13 冲突的旧结论，但凡描述具体命令、flag、schema或已交付行为，都必须等待对应 runtime fact；最终 S43 对齐只能在这些事实齐备后完成。
5. **doc rendering 与授权各自证明。** prompt handle可执行不等于获权；CLI成功路径证明寻址可用，raw socket跨 chain/伪 key拒绝证明 daemon authority。
6. **全路径渲染后做零注入。** direct、trigger、validator 等实际 phase projection都进入统一可渲染路径后，才可执行 all-phase sentinel oracle；单路径通过不能关闭宽主张。
7. **计数守护随精确成员同步。** 新 capability、binding或 doc slice 的定义与守护清单必须在同一可验证状态中；守护通过后仍须继续做命令执行和 sentinel验证。
8. **最后做 no-legacy 实态审计。** 以最终 help、typed boundary和可运行 prompt为依据通读 CLAUDE/作者手册/docs，删除临时未来时态、旧命令和互相否定叠层。

## E. 不得依赖与范围外

- 不依赖或注入 author identity 标签、run/phase 诊断标签；author phase只可作为 read filter值。
- 不增加 `run` scope；scope 闭集始终是 `chain | item | group`。
- 不展示 opaque credential，不把 prompt handle、CLI自动附带或caller selector视为授权。
- 不虚构 read subcommand、flag、selector、response shape或未实现 capability；不凭记忆写 help。
- 不从 runtime ancestry、fixture形状或多个结构祖先定义 group membership、嵌套并行数学、结合律或扁平化。
- 不注入 entry body、摘要、marker或sentinel；不把 context变成推送式 prompt内容。
- 不修改 `shared.md` 机制，不用 context替代 transition、持久业务事实、evidence、trace或后继必需交付。
- 不新增 GUI 行为；GUI只是未来 typed read boundary的消费者。
- 不把 count guard、typecheck、静态 grep、fixture或单命令 smoke外推为完整 prompt/runtime保证。
- 不保留旧编号、外部 issue残渣、勘误叠层或“唯一传递通道”等超过 D1 可证强度的表述。

## F. 验证证据

| 证明目标 | 必要证据 | 不能替代它的证据 |
|---|---|---|
| capability 切片正确 | 声明 context 的 phase渲染出文档，未声明 phase不渲染；closed union穷尽 typecheck；count guard `bun test` 绿 | 空 projection、字符串搜索、只测一个 phase |
| append 文档可执行 | 从渲染 prompt复制真实命令，对每个当前合法 scope完成 append；help、typed boundary与文案逐项一致 | 静态语法示例、binding存在、CLI自动附带 credential |
| read 文档可执行 | 从渲染 prompt复制真实 read命令，逐页读至 exhausted并覆盖实际 filter；request/result过精确 boundary | 内部 store list、未来语法草案、单页结果 |
| scope availability正确 | chain/item handle实跑成功；无group run明确不可用且无伪key；有group时只消费CAP-IN合法handle并由daemon复核 | ancestry推导、fixture自造group id、prompt值本身 |
| handle不扩权 | raw socket用他chain、虚空item/group、复制其他run handle均拒绝且不落库/不越权读取 | CLI预填/重写、文档警告 |
| body零注入 | store预置唯一sentinel body，渲染全部实际phase prompt，产物零sentinel；随后主动read仍可取回原文 | 源码无引用、只测未声明phase、手工阅读 |
| `shared.md` 并存 | 冻结SHA复跑create、显式prompt注入与context store零替代；相关docs逐点盘点留证 | 文档说“并存”、只跑context |
| D13/no-legacy对齐 | CLAUDE与相关docs通读审计：单一当前结论，无旧“durable/唯一/GitHub唯一”冲突层；与runtime lifecycle事实核对 | grep无某个单词、追加勘误段 |
| help/docs/schema一致 | root/nested `--help`、作者手册、CLAUDE/docs、typed command/result、prompt输出形成逐项矩阵且无漂移 | 记忆、旧快照、只看root help |
| 守护范围准确 | 新 capability/binding/doc slice触发既有计数/穷尽守卫；遗漏成员的负向测试失败、补齐后通过 | 单纯把期望计数改大、catch-all/default |

完成证据必须与主张同宽：prompt 可执行性由真实 CLI 执行证明，授权由 daemon/raw socket证明，body零注入由全 phase sentinel证明，`shared.md`并存由原机制运行证明，文档实态由最终 boundary 对照证明。
