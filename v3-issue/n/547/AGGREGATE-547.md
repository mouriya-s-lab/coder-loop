# RFC 547 全局聚合视图 — R9 正式回写

> 事实基线：R5 `11-r5-supply-ledger.md` 的现存供给核算；正式裁决：`22-r8-final-decisions.md`；复审：`23-r8-final-audit.md`（缺陷 0）。本文直接替换旧未决与相反预裁，不保留 ballot、旧说法或修订痕迹。本文不表示代码、外部 dependency、integration 或 E2E 已完成。

## 1. 目标、读法与状态边界

RFC 547 的目标是把 compiler、typed binding、recursive task definition、runtime scheduler、tool/gate capability、immutable definition 与 de-GitHub primitive 收敛为一条可验证生产链。每个域固定使用同一回锚顺序：

1. **稳定条款**：已经裁定、不可由实现便利反转；
2. **实然问题**：R5 在当前系统中核实的断链；
3. **正式裁决**：R8 的唯一目标合同；
4. **修补后预期保证**：实现完成后才成立；
5. **仍未证明运行项**：dependency、typed unsupported、integration/E2E gap。

“实然”与“预期”不得互换。R8 完成只表示规范收敛；未运行真实路径的能力不得称已交付。

## 2. 全局稳定条款

- `CompileEnvelope = compiled(product,warnings) | rejected(nonEmptyDiagnostics)` 是唯一 finding authority。
- source schema 是 `ValueType` 唯一解释权；use-site 只声明引用、required/default/projection/compat expectation。
- `exit.*` 是 agent-owned typed result，不能覆盖外部/item/chain/runtime authoritative bindings。
- `required` 只有在工具定义可以确定 outcome 时合法；availability、invocation、outcome 正交。
- engine 无 default preset；新 item 显式选择 per-item definition；legacy 不 implicit rebind current/default。
- engine 不知道 GitHub；repository 只能是 optional typed business binding，不能回流为 selector 或 definition 专用字段。
- 每个 gate declaration 都要求 runtime gate capability；optional 只允许缺 named binding 时 skip，不允许缺 executor 时 inert。
- 所有身份、状态和 expected failure 使用 tagged ADT 与 exhaustive handling；不以裸 string/hash、boolean flag soup 或 catch-all fallback 代替。

## 3. D1–D10 回锚

### D1 编译管线与公共投影

- **稳定条款：** TF-01 的完整 CompileEnvelope 是 findings 唯一 authority。
- **实然问题：** canonical compiler/projection/source hash 可复用，但 warnings/model/callback 可拆错；path-only cache、校验前 materialize 与 doctor 读面不一致；无独立可分发 schema artifact。
- **正式裁决：** CompileEnvelopeRef、SchemaRef 与 DefinitionRef 分域；schema/compile/binding 属同一 contract family；doctor 默认只诊断 current source/findings，pinned instance 健康归 status/ref 或显式 `--definition-ref`。
- **修补后预期保证：** compile、cache、publish、callback、doctor 使用同一 envelope；verified bundle 才可 immutable publish；finding 不被第二读面重算。
- **仍未证明：** independent schema consumer（出处 #747） 未落地，cross-owner parse/version mismatch E2E 不得声称通过。

### D2 变量绑定类型流

- **稳定条款：** source schema 唯一类型 authority；`exit.*` 仅 agent-owned。
- **实然问题：** binding/runtime string-only，missing/null 可变空串，create/update 不按 preset required/type/default admission，projection 丢 owner/source/path。
- **正式裁决：** 首批递归 `ValueType = string | number | boolean | null | array | record | union`；无 opaque json；missing 与 null 分离；structured prompt 默认单行 canonical JSON；candidate replacement 完整验证并 CAS。
- **修补后预期保证：** 不可信输入在 boundary 解析为精确 value；admission 在 create 前完成；batch 全量 plan 后单事务写入；typed value 贯通 render/transition。
- **仍未证明：** 真实 create→render→exit typed 流未完成 integration。

### D3 任务树与类型化转移

- **稳定条款：** stable node identity 不依赖位置；typed transition 是唯一业务推进 authority。
- **实然问题：** runtime seq/par/join ADT 与 SQL 资产存在，但 compiled recursive tree、production constructor、scheduler 消费与 transition commit 缺失，主要证明来自 fixture。
- **正式裁决：** TOML 使用 referenced node table：root id、keyed node declarations、child id refs；linear `[[phases]]` 仅作 compat sugar 并立即 normalize；DefinitionNode→RuntimeNode 单向关联。
- **修补后预期保证：** duplicate/dangling/cycle 在 compile 拒绝；create 完整物化 runtime tree；readiness 与 typed transition 原子推进。
- **仍未证明：** referenced-node boundary 未交付前 `[tasks]` 返回 `recursive_tasks_unsupported`；non-degenerate par runtime 返回 `par_runtime_unsupported` + hold，绝不串行降级。

### D4 工具注册表

- **稳定条款：** required/outcome 判据固定；availability、invocation、outcome、requiredness 四轴正交。
- **实然问题：** public projection/boundary 槽位及通用 identity/事务基建可复用，但 registry、requirements、doctor/prompt projection、runtime finalize 无生产链；hook carrier 只属于 D5 gate 资产。
- **正式裁决：** definition-scoped ToolId；registry 同 ref/version 供 compile、doctor、prompt；ToolOutcomeEvaluation 由 tool outcome/finalize runtime domain journal（出处 #597） 唯一拥有。
- **修补后预期保证：** capability 真实注册才 advertise；required/expected 穷尽解释 achieved/missing；transition 只 consume decided domain ref。
- **仍未证明：** tool outcome/finalize runtime（出处 #597）未实现；required runtime create/schedule 必须 typed unsupported 或 existing hold，expected 不得伪造成功事件。

### D5 gate 声明位

- **稳定条款：** 任何 gate declaration 都需要 runtime gate capability。
- **实然问题：** declaration carrier/effective view 存在，但 host identity、executor、journal、transition consumption 与 recovery 未实现。
- **正式裁决：** GateDefinition、point、host、GateEvaluationId/epoch 分域；chain binding 覆盖 global，item 不参与；gate evaluator/journal（出处 #712）的 GateEvaluation journal 是唯一 decision authority。
- **修补后预期保证：** pre-spawn gate 在全部资源副作用前 evaluate；hold 原子 `claimed→held`，保留 RunIntent/RunId/epoch 并释放 scheduler capacity；恢复按 journal/fingerprint 重评。
- **仍未证明：** gate evaluator/journal（出处 #712）缺失时任何 gate declaration 在 create typed reject，既有 pinned instance hold；optional 只允许 missing binding skip，不允许 missing executor inert。

### D6 doc 渲染声明驱动

- **稳定条款：** renderer 由声明驱动，不能按 value 内容启发式选择。
- **实然问题：** doc product/renderer/prefix migration 可复用，但 outer boundary 宽、手写 binding、结构值到 render 才失败。
- **正式裁决：** scalar 用各类型 canonical 文本；structured value 默认 canonical JSON inline；block/fenced 仅由显式 renderer 声明。
- **修补后预期保证：** render 输入已是 admission 后精确 value，输出字节确定且不依赖 placeholder 位置。
- **仍未证明：** 多类型真实 prompt/render/runner 路径尚未运行。

### D7 GitHub 记法与 repository 原语退役

- **稳定条款：** engine 不知道 GitHub；repository 不得成为 selector 或 definition 专用字段。
- **实然问题：** repository 物理权威、forge admission、`--issue`/GitHub normalize 与历史 allowlist 仍可能形成双权威；closure/worktree/reconcile 资产可复用。
- **正式裁决：** opaque chain identity；repository 为 optional typed chain business binding；`baseBranch` 留在 typed ChainDefinition provider（出处 #705）的 ChainDefinition；local worktree、closure resource、reconciliation 完全不读 repository。
- **修补后预期保证：** 只有明确 remote operation 的 boundary adapter 按需消费 resolved repository；missing/invalid 仅阻断该 remote operation，不阻断 local worktree/reconcile，也不 fallback git inference。
- **仍未证明：** typed/API、public producer、historical allowlist 三层清零与真实 remote operation E2E 尚未完成。

### D8 plan 面退役与 dead-fragment

- **稳定条款：** plan 实体不恢复；fragment 必须有真实 consumer。
- **实然问题：** plan 目录/注册/命令已退役，但 dead-fragment checker 不存在，bundled 无 warning 不能证明规则存在。
- **正式裁决：** dead fragment finding 归同一 CompileEnvelope，不新建旁路 checker authority。
- **修补后预期保证：** compile 可确定地报告无消费者 fragment；旧 plan/jump DSL 不复活。
- **仍未证明：** bundled 与外部 fragment 人口的冻结 SHA 验证缺失。

### D9 chain 声明与 preset fallback 退役

- **稳定条款：** 无 default preset、无 implicit rebind。
- **实然问题：** per-item preset 资产存在，但 legacy null 可 fallback chain/default；本仓无外部 typed ChainDefinition boundary。
- **正式裁决：** item 显式 pin PresetDefinitionRef；ChainDefinition ADT/parser/version/error 由外部 typed ChainDefinition provider（出处 #705）唯一拥有，本树只消费 tagged ChainDefinitionRef/schema。
- **修补后预期保证：** current、chain declaration 与 item pinned definition 不再互相替代；parser owner 唯一。
- **仍未证明：** typed ChainDefinition provider（出处 #705）的交付与跨 boundary runtime 未验证。

### D10 不可变执行定义

- **稳定条款：** current 与 pinned instance 是不同时间面；缺 ref 不 fallback current。
- **实然问题：** tagged ref/FK/source hash 可复用，但 definition 表无完整内容、create 不 pin、resume/restart 重读 current。
- **正式裁决：** staging verify 后 atomic publish immutable definition；create 单一 `BEGIN IMMEDIATE` 同写 row/ref/admitted bindings/完整 runtime/outbox rows；shared resolver、ref-aware GC；v14 pre-ref 全部 hold。
- **修补后预期保证：** scheduler 只观察完整 instance；missing/corrupt ref typed hold；commit 后只 dispatch 已持久化 outbox；repository 搬运不解除 definition hold。
- **仍未证明：** v14 历史 definition 不可从 current/status/marker 推断；restart/resume、GC 与 failure recovery integration 未运行。

## 4. 八个统一 Gate

| Gate | 正式合同 | 实然可复用 | 仍需修补/证明 |
|---|---|---|---|
| 1 identity | CompileEnvelopeRef、SchemaRef、PresetDefinitionRef、ChainDefinitionRef 分域，裸 hash 不互换 | canonical source hash/projection | artifact integrity、typed error、consumer round-trip |
| 2 publish/create | publish 先于 create；一个 IMMEDIATE 事务写 row/ref/bindings/runtime/outbox rows；commit 后只 dispatch | WAL/事务/batch框架 | pure plans、完整 constructor、failure/restart integration |
| 3 migration | 15 chains/69 items/932 runs 全 pre-ref；repository 无损 staging；全部 legacy hold | migration/physical rows | conflict-zero-write、schema-proven repair；历史 H1 不可证明 |
| 4 journals | Transition/ToolOutcome/GateEvaluation/Effect/Outbox 各一 authority | transaction/outbox substrate | tool outcome/finalize runtime journal（出处 #597）与 gate evaluator/journal（出处 #712）、effect unknown recovery |
| 5 pre-spawn | `ready→claimed`；hold 原子 `claimed→held` 并释放容量；advance 后才建资源 | readiness/run/closure基础 | held recovery 与 gate evaluator/journal（出处 #712）的 executor |
| 6 recursive/par | boundary 缺失 compile typed reject；runtime 缺失首副作用前 hold；无串行降级 | runtime tree ADT | referenced-node parser/normalizer、par scheduler backstop |
| 7 schema consumer | 本仓 producer 输出独立版本化 artifact；unknown version 拒绝 | compiler/public CLI | independent schema consumer（出处 #747）dependency unavailable，cross-owner E2E 未过 |
| 8 de-GitHub | repository optional business binding；local worktree/reconcile 不读它 | closure/baseBranch/opaque identity | remote adapter、alias/allowlist 清零 |

## 5. 44/44 正式决策映射

| TF | 来源类 | 唯一正式落点 |
|---|---|---|
| 01 | A | D1 CompileEnvelope 唯一 finding authority |
| 02 | 自主U | D1 doctor 默认 current；instance 健康归 status/ref 或显式 definition-ref |
| 03 | E | Gate-1 完整 envelope identity、deterministic cache/durability |
| 04 | 自主U | D1/Gate-7 本仓 schema producer；independent schema consumer dependency（出处 #747） |
| 05 | E | D1 schema/compile/binding 同 contract family、不同文档角色 |
| 06 | A | D2 source schema 唯一类型 authority |
| 07 | 自主U | D2 最小递归 ValueType，无 opaque json |
| 08 | E | D2 missing/null/required/default ADT 与阶段语义 |
| 09 | 自主U | D2/D6 canonical JSON inline |
| 10 | A | D2 typed `exit.*` agent owner |
| 11 | E | Gate-2 admission 最早边界、Gate-5 preflight |
| 12 | E | D2 candidate patch/replacement 完整 validation + CAS |
| 13 | E | Gate-2 batch 全 plan 后单事务；migration 旁路显式 |
| 14 | I | Gate-3 四类 population；无证据值 hold |
| 15 | E | Gate-5 首副作用前 preflight；deterministic failure 不 retry |
| 16 | E | D10 definition 字段由全部 pre-run consumer 机械闭包 |
| 17 | 自主U | D9 typed ChainDefinition provider 唯一拥有 ChainDefinition（出处 #705）；本 RFC 只消费 |
| 18 | E | Gate-2 publish 先于 create；row/ref/tree/outbox 单事务 |
| 19 | E | D1/D10 current 与 instance tagged-ref 双读面 |
| 20 | I | Gate-3 全部 pre-ref legacy 只读/hold |
| 21 | E | D10 staging verify + atomic immutable publish/integrity |
| 22 | E | D10 live/retiring 与 ref-aware GC/create 协调 |
| 23 | E | D1/D10 cache 只缓存 verified tagged ref，不作 authority |
| 24 | E | D10 shared resolver；missing/corrupt typed hold；不 fallback current |
| 25 | 自主U | D3 referenced node table；linear normalize |
| 26 | E | D3 DefinitionNode/RuntimeNode 双域单向关联 |
| 27 | E | Gate-2 admission 时完整 constructor，无 lazy half-tree |
| 28 | E | Gate-5 readiness claim 唯一 scheduler authority |
| 29 | E | Gate-4 typed transition 唯一 business commit |
| 30 | E | Gate-4 effect/outbox recovery；unknown hold |
| 31 | I | Gate-6 compile/scheduler 具名 unsupported，无串行降级 |
| 32 | E | D4 definition-scoped ToolId 与四轴正交 |
| 33 | A | D4 required/outcome 判据 |
| 34 | E | D4 registry 同 ref/version 供 compile/doctor/prompt |
| 35 | I | D4/Gate-4 tool outcome/finalize runtime owner 已知（出处 #597），实现缺失 dependency hold |
| 36 | E | D5 gate definition/point/host/evaluation identity |
| 37 | I | D5 chain 覆盖 global、item 不参与；selected/shadowed/missing 三态 |
| 38 | E | D4/D5 capability 真实注册才 advertise；unsupported handshake |
| 39 | I | D5/Gate-5 gate evaluator/journal owner 已知（出处 #712）；executor/journal 缺失 reject/hold |
| 40 | E | D7 single breaking checkpoint，不留 CLI/wire/runtime alias 双权威 |
| 41 | E | Gate-8 repository business binding、opaque chain selector |
| 42 | I | Gate-3 15 条 column-only 无损 staging；未来 conflict 零写 |
| 43 | A | D9 无 default preset、无 implicit rebind |
| 44 | E | D7 typed/API、public producer、historical allowlist 三层清零 gate |

核算：5 A + 7 I + 26 E + 6 自主 U = **44/44**；未映射 **0**。

## 6. 当前 dependency 与证明边界

| Dependency/能力 | 当前事实 | 必须行为 | 仍需证明 |
|---|---|---|---|
| independent schema consumer（出处 #747） | consumer 未落地 | `dependency-unavailable(independent-schema-consumer)` | daemon 停机预校验、derived type、version mismatch |
| tool outcome/finalize runtime（出处 #597） | registry/finalize 链未实现 | required create/schedule unsupported 或 existing hold；expected 不伪造成功 | outcome/finalize/retry/restart |
| gate evaluator/journal（出处 #712） | carrier 有，executor/journal/recovery 无 | gate capability 不 advertise；任何 declaration create reject；pinned hold | hold→advance、onFailure、restart、dedupe |
| scripted join consumer（出处 #714） | owner 合同有，完整 consumer 未证明 | 全链前 typed unsupported | persistence/observe/consume/reopen |
| non-degenerate par | strict ADT 有，production 链无 | `par_runtime_unsupported`，首副作用前 hold | definition→constructor→scheduler→join/recovery |
| compatibility real E2E（出处 #685） | 文档收敛不等于 runtime | implementation issue 只验自身边界 | 冻结 SHA integration 与 compatibility real E2E |

## 7. R10 输入边界

R10 只使用 `24-r9-expected-foundation.md` 作为预期地基摘要；需要实然证据时回查 R5 与源码。不得从旧 issue 边界反推需求，不得恢复 ballot、nested recursive grammar、双 identity、双 journal、半实例、隐式 migration/fallback，也不得因 proof gap 新增产品机制或重拆 issue。

## 8. 覆盖对账

- D1–D10：10/10 已按五段回锚。
- Gate-1–Gate-8：8/8。
- 正式决策：44/44，未映射 0。
- independent schema consumer、tool outcome/finalize runtime、gate evaluator/journal、scripted join consumer 与 non-degenerate par：均明确标为 dependency、typed unsupported/hold 或证明缺口。
- 代码/测试/worktree/issue 重拆：0。

## 尾结论

**RFC #547 的当前事实与修补后预期已经分离：R5 资产继续复用，R8 的 44 项裁决与八个 Gate 成为唯一目标合同，D1–D10 均按稳定条款→实然问题→正式裁决→预期保证→证明缺口回锚。independent schema consumer（出处 #747）、tool outcome/finalize runtime（出处 #597）、gate evaluator/journal（出处 #712）、scripted join consumer（出处 #714）、non-degenerate par 与冻结 SHA 真实链路仍未交付，不得冒充已实现或已通过 E2E。**
