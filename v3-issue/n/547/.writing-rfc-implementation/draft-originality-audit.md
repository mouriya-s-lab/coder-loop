# draft.md 独立思考与原创性审计

> 审计对象：.writing-rfc-implementation/draft.md。对照材料：SYNTH-547-type-system-compile.md、当前 AGGREGATE-547.md、33-writing-material-capabilities.md、34-writing-material-rationale.md。本审计只判断是否机械复述、是否形成独立因果论证及是否把旧 issue 号合同化；不修改 draft。

## A. 结论

**通过。缺陷数：0。必须修复点：0。**

draft没有照搬SYNTH的issue/child编排，也没有按AGGREGATE的旧D1–D10顺序换词复述。它选择了一条独立生命周期叙事：用“实例在H1下创建、source变成H2、daemon restart”作为贯穿反例，从唯一编译判定开始，依次推导immutable publish、两份pure plan、atomic create、attempt/capability、typed transition、resume和错误分类。章节边界由前一步产物为何不足以支持下一步决定，而不是由旧文档编号决定。

论证也不只是把素材摘要扩写。draft反复执行自己的因果变换：

- 从path cache与direct loader的不同时间视图推出compile verdict必须同源；
- 从hash/ref“只能归因、不能取回内容”推出immutable definition与shared resolver；
- 从bad value可能先落库推出admission必须早于business transaction；
- 从runtime tree已存但scheduler旁路推出“持久形状不等于推进authority”；
- 从carrier/空projection不能证明executor推出capability handshake与reject/hold；
- 从run exit、status、closure和event跨事务推出typed transition与journal分域；
- 从H1/H2 restart反例回收全文，证明各consumer必须读取pinned ref。

这些推导把事实、目标、dependency和proof连接成一条新论证，而不是逐段重述旧结论。两张主要表也承担新的综合功能：失败状态表横向比较不同阶段的判定与恢复；current资产表限定“可复用但不能证明什么”。它们不是旧issue验收表或D1–D10表的复制。

issue号检查通过。draft中的RFC #547指本文所解释的RFC自身，不作为dependency、capability、schema、ref、journal、error或owner identity；owner/repo#123只是opaque item反例。没有出现旧child issue号，也没有以issue开闭状态决定能力语义。具名边界仍使用independent schema consumer、typed ChainDefinition provider、tool outcome/finalize runtime、gate evaluator/journal和scripted join consumer。

## B. 结构原创性

### B1. 与SYNTH的区别

SYNTH的主体是“RFC骨架 + 当前/历史children + 每个child的目标、问题、验收、依赖 + 关闭证据”，按issue档案组织。draft没有沿用这套结构：

| SYNTH组织方式 | draft组织方式 | 判定 |
|---|---|---|
| RFC原文、裁决、开放问题、范围外 | 先声明current/target/dependency/proof | 重新建立读者前提 |
| 按child issue逐项展开 | 按H1→compile→publish→create→attempt→transition→restart生命周期展开 | 非机械映射 |
| 每项重复目标/问题/验收/依赖 | 每节回答“上一步为什么仍不足” | 独立因果结构 |
| 关闭证据与历史issue快照占大篇幅 | 只保留current事实及proof边界 | 没有复制历史账本 |
| issue号承担导航 | 具名artifact/capability承担导航 | 无issue合同化 |

SYNTH中的旧开放问题、旧child范围、旧验收措辞和issue关系图没有被抄入draft。draft也没有沿着SYNTH的doc、de-GitHub、binding、tool、tree、gate、fragment、fallback、definition child顺序逐项改写。

### B2. 与AGGREGATE的区别

AGGREGATE以稳定条款→实然问题→正式裁决→预期保证→证明缺口，并按D1–D10列账。draft保留“current不能冒充target”这一必要边界，但没有复用其章节骨架：

- 没有D1–D10标题或44项映射；
- compile、binding、runtime、gate、definition按执行因果交叉出现；
- atomic create把binding、runtime、definition、outbox放进同一叙事节点，而不是分域摘要；
- H1/H2在publish、resume、status、cache和legacy中反复检验同一主张；
- “为什么局部补丁不够”直接比较跨域断链，不复述单域裁决表。

第13节采用current/target/dependency/proof对账，与AGGREGATE的状态纪律相容，但内容服务于前面生命周期论证的收束，不是把十域摘要重新排列。该共同分类属于必须保持的事实边界，不构成结构抄袭。

### B3. 与33/34素材的区别

33号提供八项可观察能力和写作建议，34号提供第一性问题与反例。draft消费了这些素材，但进行了明显再组织：

| 素材 | draft的转化 | 判定 |
|---|---|---|
| 33号八能力并列 | 合并为一次H1实例的连续生命周期 | 综合而非罗列 |
| 33号建议用具体故障贯穿 | 具体化为H1→H2→restart，并在第8节闭环 | 独立展开 |
| 34号authority/time/error三问题 | 分散到compile、publish、create、transition和recovery的具体失败点 | 从原则推导合同 |
| 34号局部补丁反例 | draft用自身系统路径逐段证明，并在第11节集中回收 | 非句式复制 |
| 34号需求/机制分界 | draft把机制嵌入各阶段，再在范围外说明owner边界 | 新叙事位置 |

文本级抽查未发现与SYNTH、AGGREGATE、33或34完全相同的30字符以上完整句段。术语重合集中在冻结domain名、状态名和artifact名，属于不可随意改写的合同词汇，不是复制证据。

## C. 措辞与表格审计

### C1. 措辞

通过项：

- 使用“为什么还必须”“为什么不等于”等问题式标题推进因果，不是“目标/问题/验收”模板复刻；
- current事实后立即说明它不能证明什么，避免把资产清单冒充实现；
- target语句有明确时态隔离，没有把合同写成main现状；
- dependency以稳定能力名表达，issue号不决定行为；
- proof gap与producer不存在分开，没有以“未跑”反推“没有实现”；
- H1/H2、half-instance、empty value、gate inert、runner exit等反例贯穿多个阶段，而非各域孤立陈述。

没有发现大段照搬旧文档的固定句序，也没有用同义词替换掩盖原段落结构。

### C2. 表格

| draft表格 | 是否机械复述 | 理由 |
|---|---|---|
| 第9节失败状态表 | 否 | 横跨compile、admission、dependency、pinned、effect、legacy、corrupt，比较持久结果、capacity与恢复；旧文档没有以此读者问题组织同表 |
| 第13.1节current资产表 | 否 | 资产源于事实账，但新增“可以复用/不能证明”的教学对照，且被前文因果使用 |

表格没有按D1–D10、issue、TF或191项需求机械枚举。它们压缩的是论证结果，而非替代论证。

## D. 独立因果推导审计

| 因果链 | 事实前提 | 推出的不可避免问题 | 局部补丁为何失败 | 结果 |
|---|---|---|---|---|
| source snapshot→CompileEnvelope | path cache/callback/doctor多读面 | 同一source出现多个判定 | 单加checker会造第二finding authority | 通过 |
| compiled product→immutable definition | ref有identity无content | restart读取H2、status仍归因H1 | 单加hash/ref不能pin行为 | 通过 |
| exact definition→admission/materialization | generic JSON与tree store都非生产语义 | bad value/half tree拖到副作用后 | render校验或fixture tree不够 | 通过 |
| pure plans→atomic create | 分事务写row/binding/tree/outbox | scheduler可见半实例、事件永久缺失 | 各store局部事务不够 | 通过 |
| ready→attempt/capability | carrier/空shape无executor | gate/tool声明静默无效 | optional/invocation不能冒充decision | 通过 |
| runner exit→transition | run/item/closure/event多写入 | crash后完成事实矛盾 | 顺手多写字段仍无单一commit | 通过 |
| pinned ref→resume | current H2与instance H1分时 | cache/restart改变旧实例语义 | fallback current伪造恢复 | 通过 |
| generic engine→去隐藏原语 | repository/default/issue多入口转换 | identity与binding双authority | 只重命名CLI不够 | 通过 |

八条链均包含事实前提、失败机制、目标保证和恢复边界，满足独立思考而非结论堆叠。

## E. Issue号与合同identity审计

| 出现形式 | 角色 | 判定 |
|---|---|---|
| RFC #547、#547 | 当前RFC自指 | 允许，不是dependency identity |
| owner/repo#123 | opaque-id反例 | 允许，不是实际issue依赖 |
| 旧child issue号 | 未出现 | 通过 |
| 以issue open/closed决定能力 | 未出现 | 通过 |
| issue号进入schema/ref/journal/error/capability | 未出现 | 通过 |
| 具名dependency | 全部使用稳定能力名 | 通过 |

## F. 必须修复点

**无。**

非阻塞编辑观察：第13节保留191项、36 seam、10 unit与零批次数字，会让文章带少量workflow收束色彩，但这些数字被明确解释为覆盖证据而非实现完成，也没有改变独立生命周期主线。是否在面向外部读者的最终润色中压缩，属于篇幅与受众选择，不是“照抄旧文档”问题。

## G. 最终核算

| 检查 | 结果 |
|---|---|
| 复用SYNTH issue/child结构 | 0 |
| 复用AGGREGATE D1–D10结构 | 0 |
| 30字符以上完整句段精确重合 | 0 |
| 机械改写旧摘要 | 未发现 |
| 独立因果链 | 8/8具备 |
| 表格承担新综合功能 | 2/2 |
| 旧issue号合同化 | 0 |
| 必须修复点 | 0 |
| 缺陷数 | **0** |
| 原创性审计 | **通过** |

## 尾结论

**draft.md通过独立思考与原创性审计。它没有复制SYNTH的issue档案、AGGREGATE的D1–D10账本或33/34的章节顺序，而是以H1创建→H2变更→restart为贯穿反例，独立推导compile、immutable publish、typed plans、atomic create、capability、transition与resume为何构成一条不可拆的authority链。旧issue号没有进入合同identity，current/target/dependency/proof保持分离。缺陷数0，必须修复点0。**
