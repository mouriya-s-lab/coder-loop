# RFC implementation draft 第二轮事实审计

> 审计对象：`.writing-rfc-implementation/draft.md`。对照 `AGGREGATE-547.md`、`24-r9-expected-foundation.md`、`28-r11-supply-demand-map.md`、`30-r12-rolling-decomposition.md` 与 `31-r12-decomposition-audit.md`。本文只报告事实与合同阻断，不修改 draft。

## A. 结论

**FAIL。阻断项：3。**

首轮七项中 F1、F3、F4、F5、F6 已修正；F2 与 F7 仍有未清除的矛盾表述。另有一处新引入/遗留的 typed-boundary 泛化错误。除此之外，current/target/dependency/proof 时态、owner、历史数据、R12 零批次及 issue authority 均与权威材料一致。

## B. 首轮 F1–F7 复核

| 首轮项 | 结果 | 复核依据 |
|---|---|---|
| F1 capability admission / gate evaluation 顺序 | PASS | `draft.md:15-28,134,160-162` 已把 create 前 handshake 与 claim 后 gate evaluation 分开。 |
| F2 expected tool 缺席语义 | **FAIL** | `draft.md:154` 已写对，但 `:160,196,224,232,263` 又把 runtime capability/tool dependency 缺席一概写成 new reject/hold 或“不能运行”，抹掉 expected → continue + explicit `NotEvaluated` 的例外。 |
| F3 recursive boundary / par runtime | PASS | `draft.md:114` 已分别给出 `recursive_tasks_unsupported` 与首副作用前 `par_runtime_unsupported`。 |
| F4 identity/ref 扩张 | PASS | `draft.md:50-54,71` 保持 envelope/product/schema/definition identity 分域，未再要求 universal location 或 Definition→Envelope 反向 ref。 |
| F5 GC reader/lease | PASS | `draft.md:88` 明确 cache/reader 不具 retention authority，仅 persisted refs 决定退役。 |
| F6 rejected envelope 持久化 | PASS | `draft.md:192-194` 改为“权威结果或所需持久状态”，并明确无新增永久历史义务。 |
| F7 committed intent / external effect | **FAIL** | `draft.md:174` 已正确分开，但 `:120-122` 仍把 outbox 收窄为“派生事件/创建事件”。权威合同是通用 outbox/effect intent 的 commit-before-dispatch 因果，不保证存在某个 creation event。 |

## C. 阻断项与具体修正

### R2-F1 — expected tool 例外仍被多处总括句覆盖

**位置：** `draft.md:160,196,224,232,263`。

这些句子与 `draft.md:154` 自相矛盾，也违反 R9 的明确非对称：required tool capability 缺席才是 new unsupported/existing hold；expected capability 缺席允许继续，但必须显式 `NotEvaluated`。gate capability 缺席仍是任何 gate declaration new reject/pinned hold。

**修正：** 所有总括句均拆分 gate、required tool、expected tool；失败表的 dependency 行明确排除 expected tool，13.3 的 tool dependency 改为“required 路径不能运行；expected 路径继续并显式 `NotEvaluated`”。

### R2-F2 — D10 outbox 被收窄成未裁定的 creation event

**位置：** `draft.md:120-122`。

“投递派生事件”“永久没有创建事件”把通用 transactional outbox/effect intent 合同收窄为具体 creation-event 合同；该事件不是 R9/R11 裁定的普遍产物。`draft.md:174` 已采用正确的通用表述，但本段仍会指导实现者建立错误的必备事件。

**修正：** 改为“commit 后 dispatcher 才执行已提交的 dispatch/effect intent”；崩溃反例改成“造成不可恢复的漏投递或无法判定”，不命名 creation event。

### R2-F3 — “所有具体值在 instance 创建前准入”错误覆盖 runtime-produced values

**位置：** `draft.md:255`。

目标保证写成“所有具体值按 exact definition 准入”，并置于 instance 创建前的串联叙述中；但 `draft.md:102` 及 D2 合同明确区分 pre-run chain/item candidate 与运行时才产生的 agent exit / external outcome。后两者只能在各自 typed runtime boundary 解析，不能在 instance create admission 中预先准入。

**修正：** 改成“pre-run chain/item candidate 在 create/update/batch admission 按 exact definition 准入；runtime-produced exit/outcome 在各自 typed boundary 按 pinned definition 准入”。

## D. 其余事实复核

| 检查 | 结果 |
|---|---|
| 历史人口 | PASS：15 chains、69 items、932 finished runs，全部 pre-ref，不能证明历史 definition。 |
| repository migration | PASS：15 chains 均 column-only、无已发现冲突；shape 搬运不解除 legacy hold。 |
| owner | PASS：D1/D2/D3/D6/D9/D10、ChainDefinition provider、tool/gate/join dependencies 与各 journal authority 未越权。 |
| current / target | PASS：未把表、carrier、schema 或 191 项需求写成 current 已交付。 |
| dependency / proof | PASS：外部 consumer/provider/runtime 与 restart、GC、typed flow、tool/gate、frozen-SHA E2E 均保持未交付/待证明时态。 |
| R12 | PASS：source-ready 0、issue draft 0、not-yet 10；零批次未写成 blocked。 |
| issue/SYNTH authority | PASS：issue 号仅作 provenance；没有旧 SYNTH 或 child issue 被提升为合同 authority。 |

## 尾结论

**第二轮事实审计 FAIL，阻断 3 项。** 首轮结构性问题大多已收敛，但 expected tool 的 `NotEvaluated` 例外仍被多处总括句否定，D10 outbox 仍被错误收窄为 creation event，且 target 总结把 runtime-produced values 泛化成 create 前准入。修正这三处合同表述后再复审；不得借修文新增 transport、event、store 或 runtime 能力。
