# `draft.md` 结构与原创性复核（R2）

> 范围：只读当前 `.writing-rfc-implementation/draft.md`。  
> 检查：是否以单item生命周期独立论证；是否避免旧文档摘抄、D1–D10目录化与概要式罗列；current / target / dependency / proof措辞是否清楚。  
> 本复核不评价素材事实来源，不修改draft。

## 判定

**PASS**

draft已经形成独立论证，而不是把旧RFC、SYNTH、issue或D1–D10换标题后重新排列。正文用一个H1 item贯穿：compile判定、immutable publish、D2/D3 pure plans、atomic create、runtime attempt、prompt/tool/gate、runner exit/transition、H2 restart。每一章的存在由前一阶段自然产生的问题推动，结构可以在删除所有domain编号后继续成立。

current / target / dependency / proof也没有只在结尾声明：开头先定义四类事实，中段在每个生命周期阶段用current失败推导target机制，并在对应位置标出dependency与proof，最后才作不重叠对账。读者不会因为中段机制使用现在时而误认为main已经完成。

文中确有清单和表格，但它们承担横向比较或最终核算：失败状态、current资产、具名dependency、proof gap、out-of-scope。这些列表建立在前文完整场景之上，不替代运行机制，因此不构成概要式罗列。

---

## 1. 单item生命周期是否为真实主轴

**通过。**

文章不是先给能力目录再逐项说明，而是沿H1/H2场景推进：

```text
H1 source
→ unique compile judgment
→ immutable definition publish
→ typed admission/materialization plans
→ atomic instance create
→ readiness/attempt/prompt/capability
→ runner exit/TransitionCommit/outbox
→ H2 source + daemon restart仍解析H1
```

各阶段之间有明确因果：

- compile成功仍不足以resume，所以必须publish完整definition；
- definition已live仍不足以create，所以必须对exact H1生成两份pure plan；
- plans成立仍不足以让scheduler可见，所以必须一次commit完整instance；
- instance存在仍不足以spawn，所以必须从readiness claim并完成prompt/capability preflight；
- runner退出仍不足以推进，所以必须TransitionCommit；
- process重启仍不足以证明历史，所以必须按pinned ref与journals恢复。

第9至13节是对前述单线机制的横向比较、边界和对账，没有另起一条domain叙事。

## 2. 是否仍是D1–D10目录化

**通过。不是目录化。**

标题按运行问题组织，而不是按domain组织：

- “H1首先必须得到唯一编译判定”；
- “Compile成功之后，为什么还必须发布不可变definition”；
- “Publish与Create之间为什么需要两份Pure Plan”；
- “为什么实例创建必须是一个事务”；
- “完整实例如何成为一次可执行Attempt”；
- “Runner退出为什么不等于业务完成”；
- “H2出现并重启后，旧Item为什么仍是H1”。

D1、D2、D3、D6、D10只在需要说明owner分界时出现。例如D2/D6用于区分value canonicalization与layout，D2/D3用于说明两份pure plan，D10/D1用于说明handoff与publish。编号没有决定章节顺序，也没有充当合同identity。

## 3. 是否像旧文档摘抄

**通过。未发现摘抄式结构。**

正文没有采用以下高风险形态：

- 按旧issue编号或OPEN/CLOSED状态组织；
- 复制旧设计骨架、裁决表或关闭验证表；
- 以“八项表达力”“六块projection”等历史清单作为主结构；
- 用旧源码行号或child issue状态证明current；
- 把历史SYNTH写成当前事实源。

文章的主要解释是重新构造的因果场景：H1/H2漂移、false/0/null/missing、runtime tree被scheduler旁路、optional binding不等于optional executor、run exit不等于transition。这些反例被用于推导authority合同，而不是作为旧文档引文堆叠。

文中出现`#547`是说明讨论对象，不是用issue号代替capability/ref/schema；具名外部能力也以provider/runtime/consumer名称说明owner与缺席行为。

## 4. 是否退化为概要或名词清单

**通过。主干不是概要。**

核心章节不仅说“有什么”，还持续回答：

- current为什么失败；
- target producer、artifact、consumer分别是谁；
- 最早失败边界在哪里；
- 哪些business row、definition ref、runtime state或journal被持久化；
- 哪些worktree/process/effect尚未发生；
- crash/restart依据哪个identity恢复；
- 哪些能力只定义contract、哪些仍是dependency/proof。

例如publish章节不是“content-addressed artifact”一句话，而是给出staging、fsync、digest复核、rename、live metadata、same-ref idempotency/collision、cold resolver与GC；create章节不是“原子事务”标签，而是列出同事务rows、commit可见性与commit unknown查询顺序；transition章节区分ToolOutcome、GateEvaluation、Transition、effect与outbox的authority。

以下列表不构成概要缺陷：

- 第9节失败状态表用于横向比较已经解释过的机制；
- 第12节out-of-scope逐项解释owner和缺席行为；
- 第13节四类事实表用于最终对账，并明确数字不是完成率。

它们没有取代生命周期主干。

## 5. Current / Target措辞

**通过。**

开篇明确：全文讨论目标实现，R12 source-ready 0、本批0、10 unit not-yet。随后主要目标章节都先给current反例：

- compiler/model/warning/cache多事实；
- definition只有hash/ref壳且restart重读H2；
- binding坍缩为string/missing空串；
- runtime tree存在但scheduler旁路；
- tools projection为空、hook carrier无executor；
- run close跨事务；
- GitHub/repository/default fallback仍闭合。

Target通常以“目标系统”“目标合同”“目标使用”引出，不会被读成current。第13节再次列出current资产及“不能证明什么”，防止把renderer、SQL ADT、hook carrier、tagged ref等槽位升级为已完成功能。

没有发现用“系统已经支持”一类无标记完成时态描述目标整链。

## 6. Dependency措辞

**通过。**

正文区分了dependency的不同作用：

- independent schema consumer缺席只保留cross-owner proof gap，不阻断本仓producer；
- typed ChainDefinition provider唯一拥有ADT/parser/version/error，本仓不得复制parser；
- tool outcome/finalize runtime与gate evaluator/journal缺席会阻断真实runtime能力；
- scripted join consumer产生可供transition消费的decided ref；
- GUI、hook execution、remote adapter不是#547自身实现。

Dependency没有被写成已交付能力，也没有用issue号取代合同名称。缺席行为被明确为unsupported reject、pinned hold或proof未完成，而不是fallback。

## 7. Proof措辞

**通过。**

正文把目标机制与尚待证明的路径分开，包括：

- schema cross-owner round-trip；
- multi-type create→prompt→runner与resume字节一致性；
- H1/H2 restart、publish crash、GC竞争；
- tool outcome/finalize/restart；
- gate timeout/recovery；
- transition crash、outbox/effect fault injection；
- remote repository present/missing；
- fragment population/dead finding；
- frozen-SHA integration/compatibility。

文章明确“proof未完成不自动说明producer不存在；存在schema、表或carrier也不说明整链已经运行”，没有把proof gap与foundation missing混为一类。

## 8. 原创性与结构风险复核

| 风险 | 结果 | 理由 |
|---|---|---|
| 旧文档顺序复刻 | 无 | 顺序来自H1 item生命周期 |
| D1–D10改名目录 | 无 | domain仅说明owner seam |
| issue号合同化 | 无 | identity使用ref/schema/journal/capability |
| 多层概要重复 | 无 | 开头定事实，随后只走一次生命周期 |
| 名词堆砌 | 无阻断 | 核心术语均伴随producer/consumer/failure/recovery |
| current写成target | 无 | current反例与target机制持续相邻 |
| dependency写成实现 | 无 | 具名owner及缺席行为明确 |
| proof写成完成 | 无 | 真实路径集中标为未证明 |
| 191/36写成进度 | 无 | 明确只是需求映射 |
| R12零批次写成blocked | 无 | 明确是拒绝虚构source-ready |

## 最终结论

**PASS。** 当前draft以一个H1 item从compile到H2 restart的生命周期独立完成论证，章节因果不依赖旧文档或D1–D10目录；清单只承担比较和对账，不替代机制说明。current、target、dependency、proof在开头、各阶段和最终核算中保持一致分栏，没有把expected seam、现存资产或proof gap写成已实现能力。
