# 《RFC #547 的目标实现：它改变什么，以及这些改变为何不可省》写作大纲

## 1. 读者画像

- **知识边界：** 熟悉 coder-loop v2 的 preset、phase、item、daemon、runner、SQLite 和 resume；没有读过 #547 的历史 SYNTH。每个新术语首次出现时必须同时说明 producer、consumer、持久事实与失败结果。
- **阅读动机：** 需要判断 RFC 的目标实现究竟改变哪条运行链、每个机制为什么必要，以及目标与 main 当前状态之间的距离。
- **预期收获：** 能跟随一个具体 item 从定义到重启解释每一步的唯一权威；能说明局部修补为什么不能替代完整合同；能区分 target、current、dependency、proof。

## 2. 核心论点

RFC #547 的目标实现是一条从可变定义到不可变执行实例的单一权威链；任何已经启用的能力都必须沿这条链运行，尚未交付的能力则必须以 reject、hold 或 unsupported 停止，不能靠 fallback 半启用。

## 3. 标题与时态承诺

**标题：**《RFC #547 的目标实现：它改变什么，以及这些改变为何不可省》

标题明确讨论目标实现，不暗示 main 已经完成。正文开头直接钉住：当前 R12 source-ready 为 0、本批为 0、10 个 capability unit 全部 not-yet。之后每个场景段固定使用四格：

1. current 已有什么；
2. current 会怎样失败；
3. target 要建立什么权威；
4. dependency/proof 还缺什么。

## 4. 唯一主轴：一个 item 的完整生命期

设置一个贯穿全文的具体场景：

- 操作者写入 H1 preset，其中含 referenced task graph、typed item/chain binding、structured JSON 值、required tool 与 pre-spawn gate；
- chain/item 在 H1 下创建；
- runner得到prompt并退出；
- daemon 在 source 改成 H2 后重启；
- 中途分别考察compile失败、binding非法、capability缺失、transition后外部effect不确定、artifact损坏。

全文只走一遍生命周期；每一站当场讲清成功、失败、持久化、外部副作用和restart，不在后文重复按domain扫描。

## 5. 细粒度追问链

1. H1首先怎样从一组文件变成一个可被所有consumer引用的判定？
2. compile成功为什么还不能直接创建item，为什么要先发布不可变definition？
3. definition已经发布，chain/item值和runtime tree为什么要先生成pure plan？
4. 为什么business row、definition ref、admitted binding、runtime graph和outbox必须一次commit？
5. item已经完整存在，scheduler凭什么选中一个节点？
6. prompt bytes由谁决定，为什么typed value和layout不能属于同一个owner？
7. required tool与gate声明何时变成runtime约束，capability缺失为何不能静默？
8. runner退出后为什么业务还不能推进？
9. transition commit后event、effect与外部副作用怎样恢复？
10. source变成H2并重启后，为什么旧item仍必须执行H1？
11. legacy、corrupt、unsupported与unknown effect分别为什么需要不同停止状态？
12. 哪些邻接能力不由#547实现，缺席时#547承担什么seam与typed行为？
13. target链已经定义清楚，为什么当前仍不能合法拆出下一项issue？

## 6. 场景化正文结构与节奏

### 第一章：先建立事实边界，而不是先列功能（快）

- 说明历史SYNTH只作线索，当前权威来自最终聚合/地基/供需审计。
- current：main有compiler骨架、source hash、doc renderer、runtime SQL ADT、hook carrier、opaque storage、事务/migration等资产。
- current限制：这些资产不分别证明公共schema、immutable resolver、typed admission、production tree scheduler、tool/gate runtime。
- target：全文讨论的链尚未实现；191项与36 seam是需求映射，不是完成率。
- proof：R12 0批次是拒绝虚构source-ready，不是blocked。

### 第二章：H1怎样得到唯一编译判定（慢）

**current/失败：** model与warnings可拆，load边界丢warning，daemon callback另投影，doctor/status读面不同；path cache让不同consumer看见不同source时态。dead-fragment所需typed graph/finding carrier也不存在。

**推导：** 因为所有后续阶段都必须引用同一静态判定，所以需要完整CompileEnvelope、独立finding identity、versioned schema/projection；callback/doctor/cache只能投影，不得再生产结论。

**target机制：** 稳定snapshot→compile→compiled/rejected envelope；compiled product identity与envelope identity分离；current doctor只诊断current definition；schema producer归compiler边界。

**当场失败/恢复：** rejected不产生live definition；source race重试；cache只缓存完整envelope，不以path充当authority。

**dependency/proof：** independent schema consumer只影响cross-owner proof；dead-fragment仍缺canonical typed fragment graph和finding carrier，不能塞进该item的旁路checker。

### 第三章：为什么compile成功后必须发布不可变definition（慢，H1/H2金币）

**current/失败：** tagged ref/hash只有归因壳；definition content不持久化；materialize在compile前发布/prune；同进程cache偶然冻结H1，restart后旧item读H2。

**推导：** compile证明“这一版成立”，但resume需要“可按identity取回这一版”。因此compile product必须进入完整pre-run bundle，经过stage、重读digest、fsync、atomic publish，才能得到live definition ref。

**target机制：** envelope→product handoff；definition bundle包含所有pre-run consumer字段；shared resolver；ref-aware cache/GC；current compile与pinned resolve两个读面。

**当场失败/恢复：** publish崩溃最多留下完整orphan；missing/corrupt/unknown version使existing instance hold，绝不compile current；真实pre-ref历史只读/hold。

**dependency/proof：** H1/H2 restart、publish crash、GC竞争仍需integration；typed ChainDefinition由外部provider拥有，本仓只消费verified ref。

### 第四章：publish和create之间为什么必须有两份pure plan（慢）

**current/失败：** generic JSON存储不等于typed admission；missing变空串、结构值拖到render；runtime tree由first run动态追加，scheduler仍读phase/status。

**推导：** 只有exact H1 live后才能判断具体值和生成实例图；但在business事务前必须把所有错误算完。因此D2产生admission plan，D3产生materialization plan，二者不写DB。

**typed value完整展开：** recursive ValueType最小闭集；source唯一authority；candidate→admitted value；missing/null/default/required；update完整对象校验；batch原子；agent-owned typed exit不覆盖外部owner。

**task definition完整展开：** referenced node table、显式stable id、duplicate/dangling/cycle、linear input只作normalize糖；non-degenerate par未交付时compile/runtime双层unsupported，不能串行化。

**当场失败/恢复：** admission失败零business row；definition graph非法在compile拒绝；dependency unavailable形成typed plan failure而非fallback。

**owner边界：** D2拥有typed value及canonical scalar/JSON serialization；D6只拥有doc layout；D3拥有runtime graph/readiness，D10只协调commit。

### 第五章：为什么实例创建必须是一个事务（慢）

**current/失败：** row、ref、closure、run、status分时落库会产生可见半实例；commit结果未知时盲重跑可重复资源或outbox。

**target事务：** 在一个BEGIN IMMEDIATE中写chain/item row、tagged definition ref、admitted bindings、完整runtime nodes/edges/readiness、transactional outbox row；commit前scheduler不可见，commit后dispatcher才投递。

**当场失败/恢复：** 事务前错误零写；commit未知先按instance identity/outbox查询；真实v14 repository column-only可无损搬入business binding，但所有pre-ref实例仍legacy-definition-unproven hold。

**去隐藏原语在此介入：** chain/item selector使用opaque identity；repository不再是engine selector，只在明确remote operation按需消费；baseBranch仍是typed ChainDefinition输入；无default preset、无representative preset、无implicit rebind。

### 第六章：完整实例怎样变成一次可执行attempt（慢）

**current/失败：** scheduler按linear phase/item status/runs推进；runtime cursor和tree可旁路；run-start局部原子不等于业务推进。

**target机制：** scheduler只读runtime readiness；原子ready→claimed并持久分配RunIntent/RunId；binding/runtime preflight更早完成；capacity由claim/held状态精确占用。

**prompt路径：** admitted value先由D2转canonical text，再由versioned DocRenderDeclaration组合label/prefix/suffix/style/blankBefore，D6输出确定性bytes；structured默认单行canonical JSON，fenced只由显式声明。

**当场失败/恢复：** unknown render version或corrupt declaration在任何worktree/process副作用前hold；claimed在pre-spawn gate阻断时原子变held并释放capacity，保留同一intent/evaluation epoch。

**proof：** 多类型create→prompt→runner和resume字节一致性尚未真实闭合。

### 第七章：tool和gate为何必须在spawn前证明runtime能力（慢，optional反例金币）

**current/失败：** tools projection恒空、doctor硬编码gh、hook carrier无executor；optional gate容易被误解成optional executor。

**tool路径：** definition-scoped ToolId、provider/availability/invocation/outcome/requiredness四轴；compile/doctor/prompt读同一registry；required必须最终关联确定ToolOutcome，entry-existence只是首个具体predicate。

**gate路径：** 四类typed point及host identity；chain覆盖global，item不参与named binding；required/optional只决定binding缺失语义。任何gate declaration都需要runtime capability。

**当场失败/恢复：** capability缺失或version mismatch：new instance reject、pinned instance hold；optional missing binding可skip，但selected gate执行失败或executor缺失绝不inert。pre-spawn先分配intent identity，gate advance后才允许worktree/process副作用。

**dependency：** tool outcome/finalize runtime与gate evaluator/journal尚未交付，本RFC定义seam和缺席行为，不虚构transport。

### 第八章：runner退出为什么不是业务完成（慢）

**current/失败：** run ended、item status、closure、active run、events分属多个事务；crash可留下互相矛盾事实，restart只能局部清理。

**target机制：** runner exit只是fact；validated exit、tool outcome、gate evaluation、join decision成为typed transition request输入；TransitionCommit是唯一业务完成authority，持有from/to、host、run、result与domain refs。

**journal分域：** ToolOutcome、GateEvaluation、Transition、external effect、outbox各有唯一owner；transition只引用/consume decided ref，不复制decision。

**当场失败/恢复：** 同事务写transition及派生readiness/outbox；commit后effect dispatcher只读committed rows；外部结果未知则hold，按TransitionId/effect identity dedupe，不能从event文字推断完成。

**dependency/proof：** scripted join consumer与真实tool/gate runtime未交付；transition crash/effect fault injection仍是proof gap。

### 第九章：H2出现并重启时为什么旧item仍是H1（慢）

- 按同一item依次说明status、resume、scheduler、prompt、tool/gate requirement、transition如何只走pinned ref和shared resolver。
- current source的H2只影响新compile/new instance；doctor current与instance status分离。
- cache miss/corrupt/retiring/GC各自行为；不得fallback current。
- legacy v14实例为什么永久不能从repository/event/path推导H1。
- 本章不新增机制，只把前述持久事实组合成restart证明。

### 第十章：横向比较停止状态，而不是首次介绍故障（慢）

用完整表格比较：compile rejected、admission rejected、dependency unsupported、pinned held、unknown effect、legacy-definition-unproven、definition corrupt。每行列：发生阶段、持久事实、是否写business rows、是否占capacity、可否自动retry、恢复所需证据、明确禁止的fallback。

本章的新价值是给出统一判据：
- 信息在当前边界已充分且输入无效 → reject；
- 已有pinned实例受外部/完整性条件阻断 → hold；
- 声明能力尚无runtime实现 → unsupported并按new/existing分流；
- 外部副作用结果无法证明 → unknown hold，不猜。

### 第十一章：明确的所有权边界（慢）

逐项说明“谁拥有、#547提供什么seam、缺席时怎样表现、为何不能吞并”：

- typed ChainDefinition provider；
- independent schema consumer；
- tool outcome/finalize runtime；
- gate evaluator/journal；
- scripted join consumer；
- GUI/hook/remote adapter；
- task algebra、worktree命名/pin/recovery等engine原生机制。

同时说明不做：不换TOML、不公开ArkType表达式、不加opaque JSON/computed business key、不定义新join/par算法、不实现tool本体或executor transport、不自动修复pre-ref history、不恢复plan/jump。

### 第十二章：为什么局部补丁不能解决（慢）

按完整反例而非术语比较：

- 只加compile JSON但不pin → restart漂移；
- 只加ValueType但create分事务 → 半实例；
- 只建runtime SQL但scheduler旁路 → status tree是假权威；
- 只加tool/gate声明但无capability/journal → silent inert；
- 只改CLI词名但保留repository/default fallback → engine仍有业务原语；
- 只做dead-fragment checker但无S-33/S-07 → 第二graph与第二finding authority。

限定主张：不是所有能力必须一个PR同时实现，而是任何已启用能力必须沿同一authority合同；未交付能力必须停在typed boundary。

### 第十三章：current、target、dependency和proof的最终对账（慢）

四张不重叠表：

1. current可复用资产及“不能证明什么”；
2. target保证；
3. 具名dependency及缺席行为；
4. proof gap及所需真实路径。

解释191项/36 seams只是完整需求映射；R12 source-ready 0、本批0、10 not-yet是因为expected producer尚未进入main。详细举dead-fragment：current只有fragment id/role/path与phase role验证，缺S-33 versioned typed graph和S-07 typed finding carrier；不能削验收或把其他owner塞进一个issue。

### 第十四章：结论（快）

回到一条item生命期：H1被判断、固定、实例化、执行、提交、恢复；每一步只有一个owner和一个可恢复持久事实。RFC价值不在“类型更多”，而在把未知放回正确边界，使未交付能力停止而不是猜测。

## 7. 节奏设计

真正慢镜头集中于六个场景：H1 compile、H1 publish/H2、pure plans+create、pre-spawn tool/gate、exit→transition、restart H1。背景、时态规则和结论快进。金币仅用于解释而非娱乐：H1/H2、false/0/null/missing、optional binding≠optional executor三处反例。

## 8. 支撑模板（正文每个场景必须执行）

每个场景段必须按以下顺序写，不允许只列名词：

1. current机制和具体失败；
2. 从失败推导出的必要约束；
3. target producer→artifact→consumer；
4. 最早失败点与尚未发生的副作用；
5. 持久事实与restart行为；
6. dependency与proof边界。

## 9. 对抗检验待复审项

- 主轴是否严格只走一遍item生命周期；
- 每个机制是否首次出现即完成current/target/dependency/proof定位；
- failure/recovery是否当场说明；
- D编号是否只作后台责任来源而非章节骨架；
- out-of-scope是否解释owner、seam和缺席行为；
- 标题是否消除完成时态歧义；
- 是否满足“不允许写概要”的机制深度。
