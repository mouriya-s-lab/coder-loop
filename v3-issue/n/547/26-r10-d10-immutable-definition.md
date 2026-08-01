# RFC 547 — R10/D10 不可变执行定义原子需求

> 需求权威：`AGGREGATE-547.md` 的 D10、统一 Gate 与 dependency 边界；唯一预期地基：`24-r9-expected-foundation.md`。定义供给与历史事实仅取既有 pre-ref/definition lifecycle 报告。本文只派生需求，不读取源码、不恢复旧 issue 边界、不实现代码、不重拆 issue。

## A. 主 agent 摘要（≤1页）

D10 只拥有一条不可分裂的产品生命周期：先从 D1 的 compiled product，并通过D9 client boundary消费外部typed ChainDefinition provider已经验证的ref/payload，形成完整运行前 bundle，校验后按 tagged ref 原子发布；再把 D2 的纯 admission 结果与 D3 的纯 runtime materialization 结果合入一个 `BEGIN IMMEDIATE` create transaction，同时写 owner row、definition refs、admitted bindings、全部 runtime nodes/edges/join config/readiness、migration provenance 与 transactional outbox。事务提交后才可 dispatch，scheduler 因而永远看不到半实例。

身份必须分域：`CompileEnvelopeRef` 标识完整 compile/rejected envelope；只有 compiled branch 才产生 `CompiledProductIdentity`，它映射为 `PresetDefinitionRef.contentIdentity`；`ChainDefinitionRef`来自外部typed ChainDefinition provider，并经D9 client boundary进入本域。三类 tagged ref 以及 `SchemaRef` 不得用裸 hash 互换。definition identity 只覆盖 canonical manifest、normalized definition 与 logical assets/digests，不含物理路径、mtime 或运行结果。

运行前闭集必须覆盖所有 execution consumer：source/identity/schema/contract、item schema、runtime business declarations/literals、status vocabulary、normalized tree/node identities、exits/triggers/transitions、prompt/template/fragment bytes与roles、variable declarations、runner/model defaults、rights、timeout和compile warnings。run/session/attempt、worktree/base commit、cursor、join evaluation/decision/result等运行事实不属于 bundle。definition-time join declaration被 pin；运行期 join binding/evaluation/version演进不改 definition ref。

读面只有两个：`compileCurrent(SourceLocator)` 服务 preview 与新实例；`resolveDefinition(DefinitionRef)` 服务所有既有 instance consumer。instance 缺失、损坏、schema不支持、kind不符或正在retire时，必须 typed hold，绝不 fallback current。process cache只按完整 tagged ref 缓存已校验 bundle；GC按所有持久 ref 可达性回收，并与publish/create共享ref级协调。

真实 v14 的15 chains、69 items、932 runs全部是pre-ref且0个能证明历史definition。迁移必须保留其list/status/audit可读性，并统一标记`legacy-definition-unproven`；resume、schedule与mutation保持hold。repository字段搬运、current locator、event、marker、status或残留artifact都不能解除hold或合成历史ref。

本报告派生 **20项原子需求**。D10不重做D1 compiler/finding、D2 typed admission、D3 runtime semantics或外部provider的ChainDefinition ADT/parser/schema/version/error；它只经D9 client boundary接收已经验证的typed产物，负责不可变artifact生命周期、ref解析、原子create组合、完整性/cache/GC和legacy hold。typed ChainDefinition provider与non-degenerate runtime capabilities仍是dependency/proof seam；v14历史definition永久不可由现有证据证明。

## B. 原子需求明细

### B1. 身份、闭集与不可变产品

| ID | 原子需求 | 输入/生产者 → 消费者 | 不变量与禁止项 | 失败与恢复 |
|---|---|---|---|---|
| D10-R01 | **机械闭合 preset 运行前内容。** 从D1 compiled branch收集全部pre-run consumer所需的source identity/manifest/hash/schema/contract、item id与field schema、runtime business keys/literals、完整status vocabulary、normalized task tree/node ids、exits/triggers/transitions、prompt/template/fragment bytes与roles、variables source/default/doc/type、runner/model defaults、rights、agent timeout及compile warnings。 | D1 compiled product → bundle builder、resolver及全部instance consumer | 字段集合按consumer并集求得，不允许手选projection；明确排除run/session/attempt、worktree/base commit、cursor、join evaluation/decision/result。 | 任一声明、asset或consumer所需字段缺失时不发布，保留typed compile/boundary failure；不得降级为identity shell。 |
| D10-R02 | **经D9 client boundary接收外部typed ChainDefinition provider已经验证的bundle/ref。** D10只消费该boundary交付的版本化`ChainDefinitionRef`及完整typed payload，并在需要它的create上固定该ref。 | 外部typed ChainDefinition provider → D9 client boundary → D10 publish/create/resolver | ChainDefinition ADT/parser/schema/version/error由外部provider唯一拥有；D9本地域只拥有client boundary与fallback退役，D10不另建parser、不重新验证provider语义、不让preset/current source代填。 | provider、client boundary、schema或exact bundle不可用时create typed reject；已有instance按其ref hold，不fallback preset。 |
| D10-R03 | **分离 CompileEnvelope 与 definition 身份。** `CompileEnvelopeRef`标识完整compiled/rejected envelope；仅compiled branch具有`CompiledProductIdentity`，后者确定性映射为tagged `PresetDefinitionRef.contentIdentity`。 | D1 identity handoff → definition ref producer | `CompileEnvelopeRef`、`CompiledProductIdentity`、`SchemaRef`、`PresetDefinitionRef`、`ChainDefinitionRef`保持不同domain；禁止裸hash替代tagged ref或让rejected envelope成为definition。 | kind/schema/identity映射不一致即typed reject，不发布、不创建兼容ref。 |
| D10-R04 | **生成canonical bundle与manifest。** bundle包含tagged ref、compile contract ref、normalized definition、compile warnings，以及按logical path列出的asset length/digest/bytes。identity由canonical manifest、normalized definition与logical asset path/digest计算。 | stable compiled handoff → publisher/resolver | identity排除absolute/physical path、staging locator、mtime与runtime result；manifest必须给出边界与逐asset digest，marker不构成完整性证据。 | canonicalization、logical-path boundary或digest生成失败即终止publish；修复后重新从完整stable handoff构建。 |

### B2. 发布、create与可见性

| ID | 原子需求 | 操作与事务边界 | 不变量 | 失败与恢复 |
|---|---|---|---|---|
| D10-R05 | **完整bundle只在同filesystem staging中构造。** 写完全部metadata、normalized payload与assets后再进入验证。 | stable snapshot → staging | staging永远不是live resolver目标；compile rejected、partial write或进程中断不能产生live ref。 | finally/startup recovery清理孤立staging；不得以marker提升为live。 |
| D10-R06 | **publish前重读验证。** 从staging重读并验证tagged kind/schema、manifest boundary、每个asset digest、normalized definition boundary与overall identity。 | staged bundle → verified publish candidate | 验证对象必须与将rename的bytes相同；不得信任仅内存中的先前计算。 | 任一不一致返回typed integrity/publish error并隔离staging；不prune任何既有artifact。 |
| D10-R07 | **fsync后atomic publish且幂等处理同ref。** 完整验证后fsync文件/目录，再atomic rename到content-addressed live locator；同ref已存在时必须完整复核相等才复用。 | verified candidate → live artifact | 不同hash互不删除；同hash/并发publish收敛到同一完整内容；相同ref不同内容为collision。 | crash最多留下staging或完整unreferenced artifact；collision报`definition-ref-collision`，绝不覆盖。 |
| D10-R08 | **持久化artifact生命周期元数据。** 至少保存完整tagged ref、`live\|retiring` state、manifest digest、locator与created time，并让create/resolver/GC查询同一authority。 | publisher/GC → artifact metadata readers | 只有完整且verified artifact可为`live`；metadata row、filesystem object与ref状态必须可核对。 | live缺文件/不一致视为corrupt并hold引用者；不得从current source自愈。 |
| D10-R09 | **create前组合纯计划。** 在进入写事务前取得exact live refs、D2 `AdmittedBindings`纯计划和D3完整runtime materialization纯计划，并确认所有dependency/capability gate。 | D1/D9 refs + D2 plan + D3 plan → create coordinator | D10只组合typed产物，不重做default/type/refinement、tree constructor、readiness或transition语义；任一plan失败则零写。 | typed reject返回原owner error；不得留下owner row、lazy tree或first-spawn补写。 |
| D10-R10 | **单一`BEGIN IMMEDIATE`原子创建完整instance。** 同一事务重验artifact=`live`，写chain/item row、全部definition refs、admitted bindings、完整runtime nodes/edges/join config/readiness、migration provenance与transactional outbox rows。batch必须全plan后整批提交。 | create coordinator → SQLite instance state | commit前scheduler不可见；不存在无ref owner、半tree、lazy definition claim或bindings/runtime分事务；runtime node仅单向指向pinned definition node/ref。 | 任一写入/FK/CAS/constraint失败整体rollback；artifact可暂时无引用并由GC处理。 |
| D10-R11 | **commit后只dispatch持久outbox。** 所有外部dispatch/effect必须从已提交outbox读取，不能在create transaction提交前触发。 | committed outbox → dispatcher | Outbox只负责effect delivery；Transition、ToolOutcome、GateEvaluation、Effect与Outbox仍各有独立authority，D10不得合并journals。 | commit未知时先查持久outbox/instance再幂等恢复；不重跑create猜测结果。 |

### B3. 双读面、resolver与生命周期消费

| ID | 原子需求 | 接口/消费者 | 不变量 | 失败与恢复 |
|---|---|---|---|---|
| D10-R12 | **提供current专用读面。** `compileCurrent(SourceLocator) -> CompileEnvelope`只服务preview、compile CLI、ingress预校验与新instance候选。 | source locator → D1 compile current | 不接受instance id/ref，不回答既有instance应执行什么；current findings不成为instance健康fallback。 | source/compile失败返回D1 envelope中的typed findings，不触碰既有instance/ref。 |
| D10-R13 | **提供共享instance resolver。** `resolveDefinition(DefinitionRef) -> Result<VerifiedBundle, DefinitionResolveError>`是daemon、scheduler、resume、recovery、status/events/hooks/GUI与mutation authorization的唯一definition content入口。 | persisted tagged ref → all instance consumers | 不接受source locator；所有status vocabulary、rights、exits、runner/model、prompt/fragments、binding render和definition展示来自同一pinned bundle。events可携ref归因但不是resolver。 | consumer不得旁路重compile；resolver error统一进入D10-R17 hold/recovery。 |
| D10-R14 | **resume/restart始终重解析pinned ref。** resume重渲染、startup recovery再调度、restart后的status/mutation/spawn均先读取持久ref并走shared resolver。 | persisted instance → restarted daemon/session | H1 instance在source变为H2后仍解析H1；只有新instance可选择H2。无implicit rebind API或path/cache偶然权威。 | pinned bundle不可解析时hold并保留现场；恢复exact H1后可重试同一操作，不换ref。 |
| D10-R15 | **definition与runtime join演进分域。** immutable bundle固定definition-time join declaration/config；runtime join binding、evaluation、cursor、decision、reopen count以各自runtime authority/version演进。 | D3 definition/runtime contracts → resolver/runtime store | append-only runtime join binding version不改变definition ref；candidate definition只能用tagged ref；D10不吸收join evaluator/consumer语义。 | candidate ref缺失/损坏或scripted join consumer不可用时typed hold/unsupported，不compile current、不改pin。 |

### B4. 完整性、cache、GC与legacy

| ID | 原子需求 | 检查/操作 | 不变量 | 失败与恢复 |
|---|---|---|---|---|
| D10-R16 | **resolver cold-read执行全完整性验证。** 依次验证tagged kind/schema、metadata=`live`、artifact/manifest存在、manifest boundary、全部asset digest、overall identity及normalized definition boundary。 | artifact metadata/files → `VerifiedBundle` | 未完成全部校验不得进入cache或consumer；schema/version与kind是identity组成部分。 | 返回封闭typed error：`definition-ref-missing`、`definition-artifact-missing`、`definition-artifact-corrupt`、`definition-schema-unsupported`、`definition-kind-mismatch`或`definition-retiring`。 |
| D10-R17 | **definition错误统一typed hold且可精确恢复。** resolver错误及`legacy-definition-unproven`拒绝mutation、spawn、resume、schedule与transition，清除或不创建current run，持久化结构化hold并在status显示所需ref/subject。 | resolver/create/recovery → instance lifecycle | 不读current、不换ref、不制造兼容bundle；DB/ref/artifact现场保留。 | 仅放回与原ref canonical identity一致的exact bundle可解除artifact类hold；不同内容只能创建新instance或等待另行明确的migration产品裁决。 |
| D10-R18 | **cache只加速verified tagged ref。** key为完整`kind/contentIdentity/schemaVersion`，value为共享的`Promise<VerifiedBundle>`，采用bounded LRU。 | resolver → process cache | path/name/mtime/chain/item不得作key；success仅在完整验证后缓存；cache不是durability/retention authority，restart必须重验。 | failure entry立即移除或短暂negative-cache后移除；evict/restart不改变instance语义，exact bundle修复后允许重试。 |
| D10-R19 | **ref-aware retention与并发GC。** mark set覆盖chain/item/runtime nodes/runs/history的全部persisted refs；publish/create/GC共享ref级协调。GC在`BEGIN IMMEDIATE`内重查零引用后将`live→retiring`，再同filesystem移入trash、删除文件、最后移除metadata。 | persisted refs + artifact metadata → GC | 任一历史或运行对象仍引用即不可retire；不按basename sibling/marker/cache决定保留；GC不删除history row腾空间。 | startup继续retiring cleanup；rm失败保留retiring供重试；live缺/corrupt只hold，不从source rebuild；create与GC竞争不产生dangling ref。 |
| D10-R20 | **所有v14 pre-ref历史保持不可证明hold。** migration新增nullable tagged refs与hold reason，把15 chains/69 items/932 runs对应legacy owner标为`legacy-definition-unproven`，保留deleted/stopped状态及list/status/audit读面。 | schema v14 rows → migrated read-only history | 0个历史ref可由current preset/path、repository、event、marker、status、backup或残留artifact合成；repository column migration不解除hold。 | resume/schedule/mutation明确拒绝；只有未来获得可外部验证的exact bundle证据并经单独产品裁决才能写ref，当前迁移本身不提供repair/rebind。 |

## C. 跨域接口与不重复实现

| 上游域 | D10消费的typed交付 | D10负责 | D10明确不负责 |
|---|---|---|---|
| D1 Compile contract | `CompileEnvelopeRef`、compiled branch、`CompiledProductIdentity`、schema/contract ref、normalized compiled handoff与warnings | 把compiled product封装/发布为immutable preset bundle，维护tagged ref与resolver | 不重编译、不重建finding、不把rejected branch转换为definition、不另造schema authority |
| D2 Typed bindings | 完整validation后的纯`AdmittedBindings`/batch admission plan | 在create transaction中与owner/ref/runtime一起持久化 | 不重做source/default/required/type/refinement、candidate replacement或CAS语义 |
| D3 Recursive runtime | normalized definition input对应的完整runtime materialization plan及其typed failure | 原子写nodes/edges/join config/readiness并保持definition关联 | 不实现constructor算法、readiness scheduler、transition commit、par降级或join runtime authority |
| D9 Chain boundary | D9 client boundary转交的、由外部provider验证的typed/versioned `ChainDefinitionRef`与bundle | 发布/解析/固定其exact tagged ref，并供chain-level consumers读取 | 不拥有外部provider的ChainDefinition ADT/parser/schema/version/error，不绕过D9 client boundary，不恢复default preset或fallback |

## D. 地基匹配、dependency与证明计划

### D1. 与唯一预期地基逐项匹配

| 地基/Gate | 本报告落点 | 匹配结论 |
|---|---|---|
| D10 stable/current gap/formal decision | R01–R20 | current与pinned分离；immutable publish、单事务create、shared resolver、ref-aware GC、legacy hold全部覆盖 |
| Gate 1 identity | R02–R04、R16 | 四类tagged identity分域；无裸hash互换；integrity/schema typed error |
| Gate 2 publish→create | R05–R11 | publish先行；pure plans；一个IMMEDIATE transaction；commit后dispatch |
| Gate 3 v14 migration | R20 | 15/69/932全pre-ref，repository仅staging，全部legacy hold且不伪造repair |
| Gate 4 journals/effects | R11、D3接口 | 只协调transactional outbox，不合并Transition/ToolOutcome/GateEvaluation/Effect authority |
| Gate 6 recursive/par unsupported | R09、R15、D3接口 | runtime plan/capability不足则首副作用前typed reject/hold；不串行降级 |
| Gate 8 de-GitHub | R02、R20、D9接口 | repository不参与definition恢复；baseBranch仍归typed ChainDefinition provider |

### D2. Dependency与证明边界

| Dependency / seam | D10要求的行为 | 当前不得声称 |
|---|---|---|
| typed ChainDefinition provider（出处 #705）与D9 client boundary | 外部provider或D9 boundary不可用/unknown schema时新create reject，既有ref hold；D10仅保留boundary consumer而不补ADT/parser/schema/version/error | 不得称ChainDefinition跨boundary runtime已交付 |
| D2 typed admission与D3完整constructor | 仅接收全成或typed failure的pure plan；失败零写 | 不得用D10事务壳冒充typed flow或recursive runtime已实现 |
| non-degenerate par / scripted join consumer（出处 #714） | capability不足时按Gate 6及join contract typed unsupported/hold，首副作用前停止 | 不得顺序降级或仅凭pinned declaration称join/par可运行 |
| tool outcome/finalize（出处 #597）与gate evaluator/journal（出处 #712） | 保持其journal authority；required/declaration能力缺失时create reject或existing hold | 不得把outbox、definition或context伪装成outcome/evaluation |
| v14 history | 永久按现有证据不可证明；D10只提供hold与审计读面 | 不得称migration恢复了H1或repository搬运释放了hold |
| compatibility real E2E（出处 #685） | 由冻结SHA专用验收承担；D10实现只跑自身边界 | 不得以本需求报告、unit或synthetic fixture替代整链兼容性 |

### D3. 最小直接验证矩阵

| 验证主题 | 必须直接触发 | 必须观察 |
|---|---|---|
| H1/H2时间面 | H1创建后编辑source为H2，执行restart/status/mutation/resume/spawn，再创建新instance | 旧instance所有consumer仍解析H1；新instance解析H2；零instance path recompile |
| publish崩溃矩阵 | 在stage write、verify、fsync、rename及create commit各故障点注入失败 | 仅有可清理staging、完整unreferenced artifact或完整committed instance；无dangling/half instance |
| publish并发与collision | 同ref同内容、同ref不同内容、不同ref并发publish | 同内容幂等复用；不同内容collision；不同ref不互删 |
| atomic create/outbox | 分别让D2 plan、D3 plan、DB中段与dispatch失败，并执行batch场景 | plan失败零写；DB失败全rollback；commit前零dispatch；commit后从persisted outbox幂等恢复 |
| integrity/hold/recovery | 删除artifact、篡改asset/manifest、改kind/schema、制造retiring，再恢复exact bytes | 每类typed hold且不读current；exact原内容恢复后同ref可重试，不同内容不能解hold |
| cache | cold/concurrent/hit/evict/restart/failed-read-repair | 始终按完整tagged ref得到同一verified bytes；restart重验；失败不永久毒化cache |
| GC竞争与重启 | refs覆盖chain/item/node/run/history；create/publish与GC竞争；trash删除失败后restart | 有ref不retire；无dangling ref；retiring cleanup可续跑；history不被GC擅删 |
| legacy migration | 用v14 15/69/932形状fixture升级并尝试list/status/audit/resume/schedule/mutation/repository搬运 | 0个伪造ref；历史可读；所有运行/变更入口为`legacy-definition-unproven` hold；repository不解hold |
| join演进 | 固定definition ref后追加runtime join binding/evaluation版本，并制造candidate ref缺失 | definition ref不变；runtime版本可追踪；missing candidate typed hold且不compile current |

## 尾结论

**D10必须且只应拥有完整pre-run immutable artifact的发布与持久生命周期、tagged-ref shared resolution、D1/D2/D3/D9 typed产物的原子create组合、integrity/cache/ref-aware GC，以及pre-ref历史的不可证明hold。20项原子需求已经覆盖D10与相关Gate且未复制相邻域实现；typed ChainDefinition provider、non-degenerate runtime能力和冻结SHA整链仍是dependency或证明接缝。任何既有instance缺ref、缺content或损坏时都只能hold，绝不能由current source、repository、event、marker或status推导替代definition。**
