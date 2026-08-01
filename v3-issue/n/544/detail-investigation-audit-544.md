# RFC #544 R7 收口核算

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只核算
> `detail-investigation-index-544.md` 与 `detail-I01-544.md`–`detail-I15-544.md`；
> AGG 只用于识别稳定条款标签。未重新读取源码、运行实验或用报告之间的一致性提升置信。

## A. 主 agent 摘要（≤一页）

- **R7 gate：15/15 通过。** 每份报告都回答了 R6 的可证伪问题，给出观察、直接机制、上游/历史来源、放大条件、消费者后果、多因根因、症状修补残留、可保留资产和未知边界。I09、I11 是文本契约调查，运行证据不适用；其证据是逐句来源矩阵。其余 13 份均同时具有代码/数据流证据，且 12 份具有运行或受控实验；I06 的运行矩阵用于 parser/compatibility，不以报告一致性代替证据。
- **R6→R7：38/38 总账项有去向。** L01–L05、L07–L09、L11–L18、L20–L24、L28–L30、L32(CAP-4) 由对应 I 项直接闭合；资产和测试盲区 L06/L10/L19/L25–L27/L31/L33 被相应调查吸收；L32 lifecycle 已在 R6 定性；L34–L38 是未来 gateway 责任/原料/证明面，不被倒记成当前供给缺陷。
- **事实续查：0。** 报告中的剩余未知均被明确限定为生产频率、断电/特殊文件系统、仓外消费者、外部接口细节或稳定设计未要求防御的风险。它们不阻止 R8/R9；若后续试图作出超出这些边界的 durability、规模、仓外兼容、精确外部 API shape 或恢复保证，必须另有稳定需求与定向调查，不能从本组报告外推。
- **R8 共享因果簇：7 个。** S1 status读/一致性/wire（I01–I03）；S2 daemon活性与transport（I04–I05）；S3 events writer/连续性/可见结果（I06–I09）；S4 attempt definition与compile消费（I10–I11）；S5 context read（I12）；S6 mutation准入与结果（I13–I14）；S7 CAP-4 decision（I15）。
- **契约裁决：0。** D3 已固定最终 CLI/HTTP wire 由同一 engine-owned 精确 boundary 验证；events 主历史、最后事件、死因线索与具名异常的可见结果已经固定；D11 是 current name-based compile preview；CAP-2 已固定 spawn/retry/restart 生命周期内 pinned definition 可解引用；CAP-3 是 scalar 基线上的 additive typed seam且不阻塞；CAP-6 固定消费 upstream typed boundary、三 scope、envelope 与 opaque body，pagination/filter 随 upstream 实际接口。其余均为工程布局、外部接口细节或风险，不是操作员/owner gate。
- **跨报告冲突：0。** 有 9 组表面冲突/重复接缝已归并为层级差异；代表项包括I04的RPC活性证据与I05的client完成风险、I06的current parser资产与I08的active offset/rotation缺失、I10的attempt-pinned requirement与I11的D11文本沉默、I13准入缺陷与I14跨副作用风险。重复事实只保留一次，不构成额外置信票。
- **可进入 R8：是。** 15/15 均已形成决策输入；R8 应按 7 个共享因果簇对固定需求比较工程分叉，同时把不受稳定需求支持的风险降级，不能生成新的保证或 owner gate。不得把“已确定偏离”重新包装成是否要解决的需求问题，也不得从报告数量、实验次数或一致性估算规模。

## B. 完整核算

### B1. 逐项 gate 矩阵

标记：`✓` 为报告内明确闭合；`T` 为权威文本证据（运行证据不适用）；`R` 为运行/受控实验；`S` 为静态代码、数据流或历史证据。`续查` 只指进入 R8 前仍缺事实，不含已经隔离的外部未知。`裁决` 只列需求/契约问题，不把工程实现选择误标为需求裁决。

| I | 结构 | 八层因果覆盖（观察/机制/上游/历史/放大/消费者/根因/修补边界） | 证据 | 未知边界 | 续查 | 操作员/能力 owner 裁决 | R8 输入 |
|---|---|---|---|---|---:|---|---|
| I01 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 生产旧盘全集、特殊 FS、SIGKILL migration/断电 | 0 | 无；严格只读偏离已确定 | S1 |
| I02 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 活 chain 全 optional 分支、历史 extra 冲突全集 | 0 | 无；最终 CLI/HTTP wire 的同源精确 boundary 已固定 | S1 |
| I03 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 生产写频率、旧盘 FK、网络 FS WAL | 0 | 无；单时点偏离已确定 | S1 |
| I04 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 跨用户权限、PID 复用实况；transport 交 I05 | 0 | 无；三证投影缺失已确定 | S2 |
| I05 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | OS/规模分布、仓外错误解释 | 0 | 无；有界性/身份偏离已确定 | S2 |
| I06 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 历史真实 payload 全集、未来 version policy | 0 | 无；“44”是口径修正，compat 机制属工程分叉 | S3 |
| I07 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 生产并发频率、断电 durability | 0 | 无；并发可达与提交边界已确定 | S3 |
| I08 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 仓外consumer、replay/重启cursor | 0 | 无；active offset/rotation continuity偏离已定，reconnect为风险 | S3 |
| I09 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | T | fallback 物理归集、展示、去重/排序未规定 | 0 | 无；主历史/最后事件/死因线索/具名异常可见结果已固定 | S3 |
| I10 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | retention/GC实现、CAP-3具体shape、仓外引用 | 0 | 无；CAP-2 pinned可达已定，CAP-3 additive seam不阻塞 | S4 |
| I11 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | T | historical compile不在稳定范围 | 0 | 无；D11固定current name-based preview | S4 |
| I12 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | upstream pagination/filter；其余写恢复/审计风险 | 0 | 无；CAP-6 typed consumer seam已定，外部shape不阻塞 | S5 |
| I13 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 仓外 socket/store consumers | 0 | 无；闭集/主体/旁路偏离已确定 | S6 |
| I14 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 生产并发/重试频率、断电、仓外retry | 0 | 无；跨副作用不可判定是风险，固定交付为逐verb结果/错误及status/events核验 | S6 |
| I15 | ✓ | ✓/✓/✓/✓/✓/✓/✓/✓ | S+R | 固定基线外 #700、未来 epoch 策略、仓外 readers | 0 | 无；CAP-4 operation/capability 不可达已确定 | S7 |

**Gate 解释。** I06 虽未把八层写成编号小节，但摘要的“观察→机制→来源→放大→影响→多因根因→只改计数残留”与 B2–B6 的资产/实验闭合全部 gate。I09/I11 的“运行证据”不适用：二者的可证伪对象是稳定文本是否定义集合/消费语义，逐句来源矩阵才是同范围证据。没有把其他报告对它们的认同当成证据。

### B2. R6→R7 全覆盖

| R6 总账 | R7 去向 | 收口判定 |
|---|---|---|
| L01–L02 | I01 | opener、副作用、错误分类和 schema mismatch 已闭合 |
| L03–L04 | I02 | boundary、post-assert wire 改写及 reparse 边界已闭合 |
| L05 | I03 | 多连接/多 statement snapshot 与可达撕裂已闭合 |
| L06 | I03 资产 | exact task-tree ADT 被保留，未误作一致性证明 |
| L07 | I04 | pid/process/socket/RPC 三证与压缩矩阵已闭合 |
| L08 | I05 | deadline、大小、id、envelope、传播已闭合 |
| L09 | I01 | Bun/WAL/权限/历史盘代表矩阵已闭合；特殊 FS 留作边界 |
| L10 | I01–I04 | 四组测试盲区均被相应证据/残余盲区核算 |
| L11,L14 | I06 | event ADT 身份、44/46/52、filename/payload compatibility 与 fail-fast 已闭合 |
| L12–L13,L17 | I07 | writer ownership、rotate/append、并发与 kill 点已闭合 |
| L15–L16 | I08 | active offset/rotation连续性、watch资源面已闭合；reconnect/restart cursor降为风险 |
| L18 | I09 | 主events历史、最后事件、死因线索与具名异常可见结果固定；fallback归集/展示/去重排序归工程形态 |
| L19 | I06–I09 | schema/write/read/visibility 盲区各归其因果层 |
| L20–L22 | I10 | attempt identity、materialization、render/argv 与 typed binding 已闭合 |
| L23 | I12 | context read 缺失、三段写与失败重试已闭合 |
| L24 | I10–I12 | CAP-2 pinned可达、D11 current preview已定；CAP-3 additive与CAP-6 typed seam保留，外部shape不阻塞 |
| L25 | I10–I11 资产 | current compile projection 被保留但未冒充 historical |
| L26 | I10/I12 资产 | identity/context/prompt 资产进入相应因果链 |
| L27 | I01,I10–I12 | read API 证明盲区分别落在真实 boundary |
| L28–L29 | I13 | command 闭集、credential、target binding、store 旁路已闭合 |
| L30 | I14 | 四 verb 的 DB/process/event/RPC 时间线与失败终态已闭合 |
| L31 | I13–I15 资产 | dispatch/transaction/join identity 按用途保留 |
| L32 lifecycle | R6 已确定 | 生命周期词义偏离没有剩余事实问题，不重复调查 |
| L32 CAP-4 | I15 | join identity 与缺失 decision/capability operation 已闭合 |
| L33 | I05,I13–I15 | transport、准入、跨副作用风险、decision盲区各归一处 |
| L34–L38 | R6“无需 R7” | 未来 gateway trust/host/SSE/import/HTTP mapping 与专项 E2E 保持未来责任；其当前供给前置事实在 I05/I08/I13 |

覆盖核算为 **38/38**，不是 38 次独立调查：资产、测试盲区和未来消费责任只作为对应因果链的输入或边界。

### B3. 跨报告互证、表面冲突与去重

| 组合 | 表面冲突/重复 | 归并结论 | R8 使用规则 |
|---|---|---|---|
| I01 ↔ I03 | “同一 SQLite 文件”似乎支持一致，I03 又否定单时点 | 文件身份与 transaction snapshot 是不同保证层 | 合并为 S1，不用精确 schema 或同文件替代单时点 |
| I02 ↔ I03 | exact shape 与 commit 一致性容易混同 | shape validator不表达 commit identity | 最终wire精确验证已固定；一致性是独立工程问题 |
| I04 ↔ I05 | I04 需要 RPC probe，I05 证明 probe 可永久挂起 | 证据语义与 transport 有界性是接缝，不是冲突 | S2 同档；先保留三证独立，再比较 transport 机制 |
| I06 ↔ I08 | current exact event ADT/segment parser是资产，reader continuity又失败 | 单行shape合法不等于active offset/rotation连续 | S3不以parser资产证明翻段无丢重；不新增reconnect合同 |
| I07 ↔ I08 | writer 未提交/重复与 reader 丢重有重复后果 | I07 给可达磁盘状态，I08给消费/恢复结果 | 只在 S3 因果链各记一次，不累计置信 |
| I08 ↔ I09 | 三流现状明确，但稳定文本未规定物理合流 | 可见结果与物理归集分层 | 保证主历史/最后/死因线索/具名异常结果；不得从 logs.query 现状倒推统一三流全集 |
| I10 ↔ I11 | CAP-2 pinned attempt与D11 compile preview曾被误合并 | CAP-2约束attempt生命周期可达；D11固定current name-based preview | S4保留两条固定语义，不增加historical D11 |
| I13 ↔ I14 | 两者都出现“DB已改但RPC error/无audit” | I13给准入事实，I14给跨副作用风险 | S6固定逐verb accepted/rejected/failed与status/events核验；不要求共同提交保证 |
| I13/I14 ↔ I15 | CAP-4 将来也是 mutation，却当前没有 operation | 通用 mutation 缺陷不能替代缺失的 decision 领域契约 | S7 单列，复用已证边界但不伪造 operation |

未发现同一事实在两份报告中给出互斥值。上表“互证”只表示接缝相容和责任分层，**不提高任何结论的置信度**。

### B4. R8 待决簇（不生成选项、推荐或档案正文）

| 簇 | 报告 | 共享因果 | 已确定偏离/资产 | 进入 R8 前的契约裁决 |
|---|---|---|---|---|
| S1 status read / consistency / wire | I01–I03 | 一个 status 消费面同时受 opener、跨提交组装和 post-assert wire 变换影响 | 严格只读、单时点、精确最终契约均未成立；最终wire必须由同一engine-owned精确boundary验证；task-tree ADT/FK是资产 | 无 |
| S2 daemon liveness / RPC transport | I04–I05 | D7 三证最终都经过当前无界、无 response identity 的共享 transport/投影 | 三证被压缩；transport无界且身份未绑定 | 无 |
| S3 events contract / continuity / visibility | I06–I09 | 非事务rotate/append与结果计数reader破坏active offset/翻段连续性 | current ADT/filename parser是资产；主历史/最后事件/死因线索/具名异常可见结果已固定；replay/restart cursor为可选强化 | 无 |
| S4 attempt definition / compile | I10–I11 | attempt pinned definition可达与current compile preview是不同消费面 | hash存在；prompt/bindings与pinned definition不可解引用；current compile资产可保留 | 无 |
| S5 context read boundary | I12 | 内部typed store没有operator socket外部读取面 | strict ADT/表/author推导是资产；CAP-6消费面不可用；写恢复风险不升为本RFC保证 | 无 |
| S6 mutation admission / result | I13–I14 | 宽command/消极operator/target未绑定破坏D8；跨副作用无共同commit是事实风险 | daemon大闭集、active credential、单store transaction可保留；逐verb accepted/rejected/failed与status/events核验是固定交付 | 无 |
| S7 CAP-4 decision | I15 | lifecycle join identity没有 decision/capability领域操作和消费者 | normalized join/evaluation identity可保留；operation当前不可达 | 无（稳定 CAP-4 已给操作语义） |

这里的“无裁决”不表示没有工程分叉，而是**偏离是否存在已经确定**；R8 比较的是如何满足既定条款，不能把它退回成是否需要满足。

### B5. 偏离、口径与工程分叉分类

1. **已确定事实与稳定范围必须分开：** I01、I03–I08、I10、I12–I15 的运行偏离/风险均已证实，可作为 R8 反例；但只有能追溯到稳定问题清单的最小部分才是必须修的约束。I12 在 RFC #544 内的必修仅是外部 typed read 缺失；其三段写一致性是外部 context owner 风险。S2/S3/S6/S7 同理，不得把已证风险自动升级成资源上限、通用兼容、认证、提交或恢复保证。
2. **纯口径修正：** I06 的“44 种”应理解为 #618 时点，而契约合入时是 46、当前是 52 type/53 payload variants。修正计数不会自行建立 version compatibility，也不构成独立机制档案。
3. **固定要求与外部 seam：** D11 current preview、CAP-2 pinned可达、CAP-3 additive非阻塞、CAP-6 typed consumer seam均已确定；精确外部shape、TTL与未要求的恢复/安全/资源保证不能被升级为R9 gate。
4. **工程分叉候选类别（仅分类，不列方案）：** read isolation/boundary、transport lifecycle/identity、event active-offset/rotation continuity、definition repository/artifact、context read handler、mutation授权/逐verb结果呈现、decision state machine。S2/S3/S5/S6/S7调查中发现的资源、replay、兼容、写恢复、认证或跨副作用提交风险，只有能追溯到稳定问题清单的最小保证才能进入R9；其余降为风险或可选工程。

### B6. 收口判定

- gate：**15/15**
- R6 覆盖：**38/38**
- 进入 R8 前事实 follow-up：**0**
- 明确契约裁决类别：**0**
- R8 共享因果簇：**7**
- 跨报告实质冲突：**0**
- 表面冲突/重复接缝：**9 组，已分层归并**
- 是否可进入 R8：**可以**

收口不证明未来实现完成，也不证明报告未覆盖的生产规模、断电持久性、特殊文件系统或仓外兼容性。它只证明 R6 列出的事实问题已经得到足以进入 R8 的因果、后果、未知和资产边界。
