# `outline.md` 对抗检验

> 检验范围：只看当前 `.writing-rfc-implementation/outline.md`。  
> 检验标准：`wp-outline-build` 的逻辑链、读者追问链、支撑、标题承诺、结构、节奏；强制检查“不允许写概要”、D1–D10改名罗列，以及current / target / dependency / proof的完整分离。  
> 本文件记录当前判定，不保留修订过程。

## 结论

**通过。当前大纲可以进入写作阶段。**

大纲已经把文章主轴固定为一个具体item的单次完整生命周期：H1定义被编译、发布、实例化、调度、渲染、受tool/gate约束、提交transition，并在source变为H2后重启恢复。章节不再按D1–D10分组，而是按读者在这条生命期上自然产生的问题推进。

每个主要场景都要求同时写出current机制与失败、由失败推导的target约束、producer→artifact→consumer、最早失败点、持久事实、restart、dependency与proof。因而current / target / dependency / proof不再只在开头声明或结尾补账，而成为正文每个场景的固定语法。

标题明确承诺“目标实现”，第一章立即钉住R12 source-ready 0、本批0、10个unit全部not-yet；中段不会自然被读成main今日已经完成。成功、失败和恢复也在每个生命周期阶段当场解释，横向错误章只做状态比较，不承担补写前文机制。

大纲的机制密度已经足以约束正文不能退化成概要：它要求逐站解释输入、owner、typed artifact、consumer、事务、尚未发生的副作用与恢复，而不是只列ADT/ref/schema/journal术语。可以进入写作，但正文必须严格执行第8节支撑模板。

---

## 一、逻辑链检验

### 1. 核心论点可由正文主轴完整证明 — 通过

核心论点是：已启用能力必须沿“可变定义→不可变执行实例”的单一权威链运行；未交付能力必须在typed boundary停止。

正文结构按同一item依次回答：

1. H1如何得到唯一compile判定；
2. 为什么compile product必须publish成可解析的immutable definition；
3. 为什么exact live definition之后才生成D2/D3 pure plans；
4. 为什么完整instance必须一次事务创建；
5. scheduler如何从persisted readiness开始attempt；
6. typed value如何变成prompt bytes；
7. tool/gate capability如何阻断spawn；
8. runner exit为何必须进入typed transition；
9. H2出现并重启后为何旧item仍解析H1。

这条链直接兑现核心论点，没有在中途切回domain目录或issue历史。

### 2. 根因到机制的推导明确 — 通过

每章都用“current/失败→推导→target机制”建立必要性：

- model/warning/cache分裂推出CompileEnvelope authority；
- H1/H2漂移推出immutable bundle/shared resolver；
- missing/空串与fixture tree推出D2/D3 pure plans；
- 半实例与commit未知推出单一create事务；
- scheduler旁路推出persisted readiness；
- empty tools/hook carrier推出capability handshake与journal；
- run ended与业务推进分裂推出TransitionCommit。

机制不再由“更typed”口号直接跳出。

### 3. 没有把合同不可分割偷换成一次性实施 — 通过

第十二章明确限定：不是所有能力必须在一个PR同时实现；约束是任何已启用能力必须沿相同authority合同，未交付能力必须reject/hold/unsupported。该表述与R12零批次、具名dependency和分阶段交付兼容。

### 4. 概念按使用点定义 — 通过

大纲没有要求读者先吞下一张未解释的全系统产品图。每个新术语在对应生命周期站点出现，并受读者画像中的强约束：首次出现必须同时说明producer、consumer、持久事实与失败结果。

## 二、读者追问链检验

### 5. 追问链达到机制粒度 — 通过

13个问题覆盖publish/create分相、D2/D3 plans、atomic create、readiness、value/layout owner、capability、runner exit、effect recovery、H1/H2、停止状态、out-of-scope与R12零批次。每一章正面回答相邻问题，没有“作者突然想讲另一个domain”的跳跃。

### 6. 横切能力回到自然介入点 — 通过

- binding与task tree在publish→create之间解释；
- repository/baseBranch、default preset与opaque identity在实例create解释；
- doc rendering在attempt/prompt解释；
- tool/gate在pre-spawn解释；
- effect/outbox在transition解释；
- dead-fragment放在compile current缺口与最终状态对账中。

旧原语不再因共享“清理”标签而被强行并章。

### 7. Failure/recovery当场回答 — 通过

第二至第八章均有“当场失败/恢复”或等价机制；第九章组合restart证明；第十章只横向比较停止状态。这避免了先写成功概要、后面统一补故障的重复结构。

## 三、支撑检验

### 8. 每个核心主张都有完整支撑形状 — 通过

第8节把正文支撑固定为：

`current机制和具体失败 → 必要约束 → target producer/artifact/consumer → 最早失败点/未发生副作用 → 持久事实/restart → dependency/proof`

各场景大纲已经按这一形状预填具体反例，不是只写“有证据支撑”。

### 9. Current事实不会被target覆盖 — 通过

每个核心章节先写current/失败，再写target；第一章还明确现有compiler骨架、renderer、SQL ADT、hook carrier、tagged ref等资产分别不能证明完整能力。第十三章只做最终对账，不承担首次纠正时态。

### 10. Proof与foundation/dependency分开 — 通过

大纲分别表达：

- independent schema consumer只影响cross-owner proof；
- typed ChainDefinition provider提供外部owned definition语义；
- tool outcome/finalize与gate evaluator/journal缺失会阻断runtime capability；
- scripted join consumer未交付时必须unsupported；
- multi-type prompt、restart、crash、GC、effect fault injection仍是proof gap。

没有把“未跑验证”统一写成“无producer”，也没有把有contract写成runtime已交付。

### 11. Dead-fragment current/target边界明确 — 通过

大纲同时钉住：target需要dead-fragment同源finding；current缺typed graph与finding carrier；不能创建旁路checker，也不能把其他owner塞进同一unit。第十三章进一步用S-33/S-07解释R12 not-yet，expected seam不会被写成current供给。

## 四、标题与承诺检验

### 12. 标题无完成时态歧义 — 通过

标题使用“目标实现”，副承诺是“改变什么、为何不可省”，没有暗示main已经完成。第3节要求正文开头直接写source-ready 0、本批0、10 not-yet，标题承诺与当前状态相容。

### 13. 标题承诺有逐项兑现位置 — 通过

- “改变什么”：第二至第九章沿item生命周期完整展开；
- “为何不可省”：每章current失败与推导、以及第十二章局部补丁反例；
- 运行时如何工作：第四至第九章；
- 故障/恢复：每章当场说明，加第九/十章组合；
- 哪些不实现：第十一章；
- 当前与目标：第一章、每章四格、第十三章。

兑现不依赖一句自我声明，而有具体结构位置。

## 五、结构与“不允许写概要”检验

### 14. 不再是D1–D10改名罗列 — 通过

章节单位是item生命周期问题，而不是domain：compile、publish、plans、create、attempt、pre-spawn、transition、restart。一个章节可以明确组合多个owner，但组合理由来自同一运行阶段。D编号只可能作为责任来源，不构成标题或顺序。

### 15. 没有多层overview重复 — 通过

第一章只建立事实/时态边界，之后直接进入H1场景；没有“全链概要→扩展概要→domain目录”的三遍扫描。生命周期只走一遍，第十至十三章承担横向比较、边界、反例与对账，不重述成功路径。

### 16. Out-of-scope得到完整机制待遇 — 通过

第十一章标为慢，要求逐项说明owner、#547提供的seam、缺席行为与不能吞并的原因；不再只是快速否定清单。

### 17. 节奏有真实密度变化 — 通过

第7节把真正慢镜头收敛到六个场景，第一章与结论快进，并放置三个有解释价值的金币：H1/H2、false/0/null/missing、optional binding≠optional executor。虽然正文结构多数核心章仍标“慢”，节奏规则已经明确哪些内容必须展开、哪些只作过渡。

### 18. 横向章节有新增信息边界 — 通过

- 第十章比较停止状态共同判据，不首次介绍故障；
- 第十一章解释ownership/out-of-scope；
- 第十二章用完整反例证明局部补丁不足；
- 第十三章做四态最终对账。

它们不会与纵向生命周期章节简单重复。

## 六、current / target / dependency / proof专项检验

### 19. 四态成为每个场景的固定语法 — 通过

第3节规定四格，第8节规定六步支撑模板；第二至第八章已经显式使用current/失败、target机制、dependency/proof。第九章以pinned/current对比完成restart证明，第十三章只汇总四张不重叠表。

### 20. Dependency与proof进入实际机制链 — 通过

依赖不是末尾名单：typed provider进入publish/pin，tool/gate provider进入pre-spawn，scripted join进入transition；proof分别附着于schema consumer、prompt/runner、restart、publish/GC、transition/effect路径。

### 21. 可复用资产与“不能证明什么”成对出现 — 通过

第一章先建立总规则，各场景再用current/失败限制资产能力，例如tagged ref不等于definition content、generic JSON不等于admission、runtime SQL不等于scheduler、hook carrier不等于executor。

### 22. R12零批次反向约束全文时态 — 通过

source-ready 0被放在标题时态承诺和第一章，不是末尾补充；第十三章用S-33/S-07给出具体例子。正文模板要求任何target机制都必须紧邻current与未交付标记，因此不会把191项/36 seams写成完成率。

## 七、写作阶段必须保持的硬约束

大纲已经通过，但正文若违反以下任一项，应退回大纲/写作阶段修正：

1. 严格沿一个item生命期只走一遍，不增设D1–D10能力目录。
2. 每个场景执行第8节六步支撑模板，不删current或dependency/proof格。
3. Target机制不使用无标记完成时态。
4. 每个失败点写明持久事实、尚未发生的副作用与restart结果。
5. Tool/gate/join/provider/consumer未交付时只写contract与typed停止行为。
6. 第十至十三章只做比较/边界/对账，不重新讲一遍成功路径。
7. 不把191、36 seams或现存ADT/renderer/ref槽位写成实现完成度。
8. 不用旧issue编号、SYNTH状态或术语堆砌替代机制解释。

## 最终判定

**通过。逻辑链、追问链、支撑、标题承诺、结构、节奏及current / target / dependency / proof分栏均已形成可执行约束；大纲不再是概要或D1–D10改名罗列，可以进入写作阶段。**
