# `draft.md` 深度审计

> 审计对象：`.writing-rfc-implementation/draft.md`。  
> 检查表：`35-writing-material-reader-questions.md` 的210项追问，重点验证熟悉coder-loop v2的读者能否沿一个item完整解释compile、publish、create、spawn、transition、restart。  
> 本审计不修改draft，只列阻断“不允许写概要”的缺陷。

## 判定

**不通过。**

draft已经不是一篇全局概要：compile、immutable publish、typed plans、atomic create、prompt owner链、transition/outbox与H1/H2 restart都有连续机制解释，current / target / dependency / proof也总体分开。一个v2读者已经可以复述主干成功路径。

但“可以复述主干”仍不等于“完整回答”。在最复杂、最需要运行时细节的三处，正文退回了协议名词概览：runtime tree/readiness、tool/gate journal、publish/GC并发恢复。它们恰好决定spawn、transition与restart是否真的可恢复。读者目前只能说“这里有typed journal / atomic claim / shared resolver”，不能解释每个状态怎样产生、持久化、消费、失败与重放。

以下4项是进入定稿前必须修复的阻断缺陷。

---

## F1 — Runtime tree到spawn的推进机制仍是摘要

### 位置

- `§4.2 Runtime materialization：声明图不等于运行图`
- `§6 完整实例如何成为一次可执行 Attempt`
- `§7 Runner退出为什么不等于业务完成`

### 当前文本能回答什么

正文已经说明：

- definition采用referenced-node table；
- materializer生成完整runtime nodes、edges、initial readiness；
- scheduler只读readiness；
- ready leaf原子claim并分配RunIntent/RunId；
- runner exit不是业务推进；
- TransitionCommit更新派生readiness。

### 仍无法回答的关键追问

v2读者仍不能根据正文解释：

1. `seq`、`par`、leaf、join各自在什么持久条件下从blocked/ready/running/terminal变化；
2. scheduler的readiness query到底读取哪些authority字段，为什么不需要重新解释definition graph；
3. 两个scheduler并发claim同一node时，CAS比较什么revision/epoch，失败者看到什么结果；
4. claim后pre-spawn失败时，哪些状态与capacity在同一事务恢复；非gate的preflight失败是否也走同一held语义；
5. TransitionCommit如何由目标node/path决定父seq、par sibling、join或chain-complete的下一readiness；
6. duplicate transition、stale transition、foreign RunId/credential、错误host分别怎样拒绝并保持原状态；
7. restart如何区分“已claim但未spawn”“process已退出但transition未commit”“transition已commit但outbox未dispatch”。

### 为什么这是阻断缺陷

`§4.2`列出了runtime ADT、materialization与unsupported，`§6`列出了claim/held，`§7`列出了transition，但三段之间缺少可执行状态链。读者只能记住三个名词，无法沿一个item解释spawn与业务推进。这直接未通过检查表关于readiness、claim、capacity、typed transition、并发与restart的追问。

### 必须补到什么深度

用贯穿全文的H1 item给出至少一条完整persisted state trace：

`initial readiness → CAS claim/RunIntent → pre-spawn outcome → process fact → awaiting transition → TransitionCommit → parent/join readiness`

每一步必须写明：读/写字段、事务边界、失败者状态、capacity、副作用、restart重放依据。不得只增加一张状态名表。

---

## F2 — ToolOutcome只有概念四轴，没有完整运行与恢复链

### 位置

- `§6.2 Tool与Gate必须先证明runtime capability`
- `§7 Runner退出为什么不等于业务完成`
- `§13.3 具名Dependency`

### 当前文本能回答什么

正文说明了ToolId、availability/invocation/outcome/requiredness四轴，指出required需要确定outcome，entry-existence只是一个predicate，并明确外部tool outcome/finalize runtime尚未交付。

### 仍无法回答的关键追问

正文没有展开：

1. compiled phase requirement何时实例化为稳定的per-run requirement identity；
2. invocation identity与requirement identity、run/phase/definition ref如何关联；
3. context entry作为evidence时，如何验证durable commit、author、chain/item/run/phase、namespace/tool；
4. evaluation journal的`Pending/Evaluated(Achieved|NotAchieved)/consumed`或等价状态如何单向演进；
5. required与expected在finalize时怎样穷尽地产生run verdict；
6. unresolved required evaluation为何hold而不是成功或失败；
7. runner退出后何时冻结可接受evidence，晚到entry如何处理；
8. restart遇到pending、evaluated未consume、已consume分别重评、重消费还是返回既有结果；
9. ToolOutcome如何在同一事务被transition引用/consume，而event、prompt文字、invocation log为何都不能替代它。

### 为什么这是阻断缺陷

当前tool段落仍像一份设计摘要：四轴、registry、capability、dependency都点到了，但读者无法回答“required tool最终怎样阻止或允许这个H1 run推进”。`§7`只说transition引用ToolOutcome，没有补上outcome怎样诞生与恢复。检查表对tool evidence、finalize、journal与restart的核心追问未闭合。

### 必须补到什么深度

沿同一个required tool给出完整链：

`compiled requirement → run requirement identity → invocation/evidence → typed evaluation → persisted verdict → finalize → transition consume → restart replay`

明确哪部分是#547的contract，哪部分由未交付dependency拥有；即使dependency未实现，目标运行语义也必须讲完整，缺席时则落到new reject / pinned hold。

---

## F3 — Gate只完整解释了pre-spawn一例，未覆盖声明的四类point与journal恢复

### 位置

- `§6.2 Tool与Gate必须先证明runtime capability`
- `§7 Runner退出为什么不等于业务完成`
- `§9 Reject、Hold、Unsupported与Unknown`

### 当前文本能回答什么

正文清楚解释了：

- named binding采用chain覆盖global，item不参与；
- optional binding不等于optional executor；
- capability缺失时new reject / pinned hold；
- pre-spawn gate在稳定RunIntent之后执行；
-阻断时claimed→held、保留epoch并释放capacity。

### 仍无法回答的关键追问

正文没有让读者解释：

1. gate的四类point分别作用于哪个host与哪个业务边界；
2. post-exit、container join、chain-complete为何不能复用pre-spawn的“是否创建process”叙述；
3. GateEvaluationId由哪些definition/host/point/binding/fingerprint组成；
4. journal的`evaluating / decided / consumed`或等价状态怎样持久演进；
5. timeout、malformed decision、executor error、selected optional gate失败分别怎样处理；
6. optional missing binding为什么可以skip，但skip为什么不是伪造一个advance decision；
7. restart遇到evaluating、decided未consume、consumed、held分别如何重评或重消费；
8. binding/capability恢复后如何以同identity/fingerprint继续，而不是创建第二evaluation；
9. container/chain point在scripted join consumer缺失时具体在哪里typed unsupported/hold。

### 为什么这是阻断缺陷

文章以pre-spawn gate为贯穿场景是合理的，但标题与范围承诺解释#547完整目标，而不是只解释一个point。当前“封闭decision point”只是一处术语；另外三类point与journal恢复没有机制说明。读者会误以为所有gate都只是spawn前boolean检查。

### 必须补到什么深度

保留pre-spawn作为慢镜头，同时给出四point的共同协议与差异矩阵：host identity、触发事实、允许的decision、consume动作、失败后持久状态、restart动作、dependency缺失行为。不能只枚举四个名字。

---

## F4 — Immutable publish / resolver / GC的崩溃与并发恢复仍停留在保证句

### 位置

- `§3.2 Target的publish合同`
- `§3.3 Corrupt、legacy与GC`
- `§8 H2出现并重启后，旧Item为什么仍是H1`

### 当前文本能回答什么

正文已说明stage、digest复核、fsync、atomic rename、live ref、orphan artifact、shared resolver、typed corrupt状态、ref-aware mark与retiring。这一部分明显深于概要。

### 仍无法回答的关键追问

但在恢复与并发处，正文只写“需要明确协调”“仍需集成验证”，没有给出target机制：

1. staging写一半、文件fsync后目录fsync前、rename前、rename后metadata未完成，各窗口留下什么可辨认状态；
2. 同一ref并发publish相同内容时如何幂等复用，不同内容时如何产生collision而不覆盖；
3. 不同ref并发publish为何不能互相prune；
4. resolver cold-read以什么顺序验证kind/schema、metadata live、manifest、asset digest与overall identity；
5. cache何时才可装入verified content，corrupt结果是否缓存；
6. GC mark set覆盖哪些persisted refs，何时在事务内重查零引用；
7. `live→retiring→trash→metadata delete`各阶段如何与new create、new resolver、已有reader协调；
8. publish/create/GC发生竞争时，哪一个持久状态决定重试或hold。

### 为什么这是阻断缺陷

文章声称解释“不可变、可恢复执行实例”，publish与GC正是不可变内容能否在restart后存在的核心。当前文本把最危险的崩溃/并发点归为“engineering coordination”与proof gap，但proof gap表示机制尚待验证，不表示目标机制可以不说明。v2读者仍无法解释definition为何不会在publish/GC竞争中消失。

### 必须补到什么深度

补出publish、cold resolver、GC三条状态/事务序列，逐窗口说明持久证据和恢复动作；再把“哪些仍需fault-injection proof”单独标出。不能用“atomic rename”“ref-aware GC”两个术语替代完整协议。

---

## 最终结论

**draft不属于短概要，但仍未达到“不允许写概要”的完整机制深度。** Compile、typed admission、atomic create、prompt owner、transition/outbox与current/target分栏已经形成扎实主干；阻断点集中在runtime readiness推进、ToolOutcome lifecycle、GateEvaluation四point/recovery、publish/resolver/GC并发恢复。修复这4项后，v2读者才可以不靠外部素材完整解释一个item从compile到restart的运行与故障语义。
