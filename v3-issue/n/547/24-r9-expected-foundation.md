# RFC 547 — R10 唯一预期地基摘要

> 权威输入：`22-r8-final-decisions.md` 与通过的 `23-r8-final-audit.md`。本文只描述修补后的预期合同及其证明边界，不表示代码、外部 dependency 或 E2E 已交付；不重拆 issue，不新增需求。

## 1. 使用规则

每项按五列读取：稳定条款是不可退让约束；实然问题来自 R5 供给账；原子保证是 R8 正式裁决后的目标；需要修补表示尚未落地；dependency/证明缺口不得写成已实现。R10 只能以本文件为预期地基，并回看 R5/源码确认实然状态。

## 2. D1–D10 原子保证

| 域 | 稳定条款 | 实然问题 | 修补后原子保证 | 可复用资产 | 需要修补 | dependency / 仍未证明 |
|---|---|---|---|---|---|---|
| D1 编译与投影 | TF-01：`CompileEnvelope` 是唯一 finding authority | warnings/model/callback 可拆错；cache/materialize/doctor 不同源；无可分发 schema | compiled/rejected 完整 envelope 具有确定 identity；schema、compile、binding 属同一 contract family；doctor 默认只诊断 current findings | canonical compiler/result、projection、source SHA、boundary | envelope 贯通 callback/cache/materialize/doctor；verified artifact publish | independent schema consumer（出处 #747） 未落地；cross-owner round-trip 未证明 |
| D2 binding 类型流 | TF-06 source schema 唯一类型 authority；TF-10 `exit.*` agent-owned | runtime string-only；missing/null 变空串；create/update 无 typed admission | 递归 `ValueType`、owner/source/refined value 贯穿 admission/render/transition；missing 与 null 分离；structured 默认 canonical JSON inline | source tagged union、doc renderer、JSON-safe persistence、事务框架 | schema-driven parse/default/required、candidate replacement/CAS、完整 batch plan | 真实 typed flow 未 E2E |
| D3 task tree/transition | stable node id；typed transition 唯一推进 authority | compiled recursive tree、production constructor/scheduler/transition commit 缺失 | referenced node table：root id、keyed node declarations、child id refs；linear phases 仅 normalize；DefinitionNode→RuntimeNode 单向关联；transition 原子推进 | runtime seq/par/join ADT、SQL约束、round-trip、runtime identity | recursive boundary、constructor、readiness scheduler、transition store | non-degenerate par 为 `par_runtime_unsupported`；整链未证明 |
| D4 tool registry | required 仅在工具定义可判定 outcome 时合法 | registry/requirements/projection/finalize 无生产链 | definition-scoped ToolId；availability/invocation/outcome/requiredness 四轴正交；compile/doctor/prompt 读同一 registry ref/version | public projection/boundary槽位、通用identity与事务基建 | registry、capability handshake、requirements、outcome journal | tool outcome/finalize runtime（出处 #597）未实现；required 实例 create/schedule unsupported 或 existing hold |
| D5 gate | gate declaration 必须有 runtime capability | carrier 存在，executor/journal/recovery 不存在 | GateDefinition/point/host/evaluation identity 明确；chain binding 覆盖 global，item 不参与；pre-spawn evaluation 在资源副作用前 | hook declaration carrier、effective view、写入授权 | gate evaluator/journal（出处 #712）的 executor、journal、transition consumption、recovery | gate evaluator/journal（出处 #712）缺失时任何 gate declaration create typed reject，既有 pinned instance hold；optional 只跳 missing binding，不跳 missing executor |
| D6 doc rendering | renderer 声明驱动；默认 structured projection 确定 | outer boundary 宽、手写 binding、结构值晚失败 | scalar canonical 文本；structured value 单行 canonical JSON；block/fence 仅显式 renderer | 已有 doc product/renderer/prefix migration | typed value 到 renderer 的完整边界 | 真实多类型 prompt/render 路径未证明 |
| D7 de-GitHub/repository | engine 不知道 GitHub；repository 不是 selector/definition 专用字段 | repository、forge admission、`--issue` 等仍形成双权威 | opaque chain identity；repository 是 optional typed chain business binding；worktree/closure/reconcile 不读 repository；仅 remote adapter 按需消费 | opaque item/wire、closure/worktree/reconcile、baseBranch 消费 | 单一 breaking checkpoint 清除 alias；typed/API/public/historical 三层 gate | remote adapter 的真实缺 binding 行为未证明 |
| D8 plan/dead fragment | plan 实体退役；无隐式 fragment | plan 主体已退役但无 dead-fragment checker | 不恢复 plan；compile 对无消费者 fragment 给出同源 finding | 已退役目录/命令、canonical compiler | dead-fragment analysis 与 tests | bundled/外部 fragment 人口的冻结 SHA 核对未证明 |
| D9 chain/preset | TF-43：无 default preset、无 implicit rebind | legacy null→chain/default fallback；typed ChainDefinition boundary 不在本树 | item 显式 pin PresetDefinitionRef；ChainDefinitionRef/ADT/parser/version 由 typed ChainDefinition provider（出处 #705）唯一拥有，本树只消费 | per-item preset 互斥、opaque storage、baseBranch | 清除 fallback；接入 typed ChainDefinition provider（出处 #705）的 tagged ref/schema | typed ChainDefinition provider（出处 #705）的外树交付与跨边界运行未证明 |
| D10 immutable definition | current 与 pinned 是不同时间面 | definition 表无内容；create 不 pin；resume/restart 重读 current | immutable publish；create 单事务写 row/ref/bindings/完整 runtime/outbox；shared resolver；ref-aware GC；legacy pre-ref 一律 hold | source hash、tagged ref/FK、SQLite migration/事务 | bundle/content resolver、integrity、pin、GC、migration repair | v14 历史 definition 不可证明；冻结 SHA restart/resume 未验证 |

## 3. 八个 Gate 的最小合同

| Gate | 原子保证 | 可复用资产 | 需要修补 | dependency / proof gap |
|---|---|---|---|---|
| 1 Compile→Definition identity | CompileEnvelopeRef、SchemaRef、PresetDefinitionRef、ChainDefinitionRef 分域且禁止裸 hash 互换 | canonical hash/projection | tagged identity、integrity与 typed errors | artifact/consumer round-trip 未证明 |
| 2 Publish→create | publish 完整 immutable bundle；一个 `BEGIN IMMEDIATE` 同写 row/ref/bindings/runtime/outbox rows；commit 后只 dispatch | WAL/IMMEDIATE、batch persistence | pure admission/materialization plan 与单一 constructor | failure/restart recovery integration 未证明 |
| 3 v14 migration | 15 chains/69 items/932 runs 全 pre-ref；repository 只无损 staging；全部 `legacy-definition-unproven` hold | migration framework、physical rows | conflict-zero-write、typed binding repair、显式 repair 命令 | 历史 H1 不可从 current 推断 |
| 4 Journals/effects | Transition、ToolOutcome、GateEvaluation、Effect、Outbox 各一 authority；DB consume 同事务；unknown hold | transaction/outbox substrate | domain refs、effect ledger、idempotent recovery | tool outcome/finalize runtime journal（出处 #597）与 gate evaluator/journal（出处 #712） 未实现 |
| 5 Pre-spawn | `ready→claimed` 分配稳定 RunIntent/RunId；hold 同事务 `claimed→held`，保留 epoch 并释放容量；advance 后才建资源 | readiness/run/closure基础 | held ADT、journal fingerprint 重评、capacity release | gate evaluator/journal（出处 #712）的 executor/recovery 未实现 |
| 6 Recursive/par unsupported | referenced-node boundary 未交付则 `recursive_tasks_unsupported`；par runtime 未交付则首副作用前 `par_runtime_unsupported` + hold；不串行降级 | runtime tree ADT | parser/normalizer与 scheduler backstop | non-degenerate par production 链未实现 |
| 7 Schema consumer | 本仓 producer 输出版本化 artifact；unknown version 拒绝 | compiler/public CLI | schema generation、round-trip、unknown-version tests | independent schema consumer（出处 #747）未实现，记录 `dependency-unavailable(independent-schema-consumer)` |
| 8 De-GitHub boundary | repository optional business binding；baseBranch 留在 typed ChainDefinition provider（出处 #705）的 ChainDefinition；local worktree/reconcile 不读 repository | closure/baseBranch、opaque identity | remote adapter typed consumption、alias 清零 | 真实 remote operation 与历史 allowlist 未证明 |

## 4. 统一未交付账

| 项目 | 当前合同 | 禁止声称 |
|---|---|---|
| independent schema consumer（出处 #747） | dependency unavailable；producer 可先静态/边界验证 | 不得称 independent consumer E2E 已过 |
| tool outcome/finalize runtime（出处 #597） | required 路径 unsupported/existing hold；expected 不伪造成功 | 不得把 context/event 当 ToolOutcome |
| gate evaluator/journal（出处 #712） | capability 不 advertise；create reject / pinned hold | 不得把 optional 解释为 executor 可缺 |
| scripted join consumer（出处 #714） | 完整 consumer 前 typed unsupported | 不得只凭 carrier/ADT 称 join 可运行 |
| non-degenerate par | compile 与 runtime 分层；runtime typed unsupported | 不得顺序降级或称 production scheduler 已存在 |
| compatibility real E2E（出处 #685） | 由专用冻结 SHA integration 与 compatibility real E2E 承担 | 不得以 unit、fixture 或本 RFC 文档替代 |

## 5. 覆盖核对

- D1–D10：10/10。
- Gate-1–Gate-8：8/8。
- R8 44 项决策：由 `AGGREGATE-547.md` 的 44/44 映射保持唯一入口；本文不复制第二份 ballot。
- 新需求：0；新 issue 拆分：0；代码实现：0。

## 尾结论

**R10 的唯一预期地基是：复用 R5 已证资产，以 R8 的 44 项正式裁决和八个 Gate 修补现存断链；current 与 expected 始终分栏。independent schema consumer（出处 #747）、tool outcome/finalize runtime（出处 #597）、gate evaluator/journal（出处 #712）、scripted join consumer（出处 #714）、non-degenerate par 与冻结 SHA 整链仍是 dependency、typed unsupported 或证明缺口，不是已交付能力。**
