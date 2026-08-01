# `draft.md` 机制深度复审（R2）

> 审计对象：`.writing-rfc-implementation/draft.md` 当前版本。只读检查其是否达到“非概要”的机制深度，重点核对完整runtime持久轨迹、ToolOutcome全链、四个Gate point及journal恢复、publish/resolver/GC崩溃并发协议。不修改draft或其他文件。

## A. 最终结论

**PASS。缺陷数：0。**

当前draft已经越过“目标摘要”层：四项重点均给出稳定identity、持久状态、写入/消费authority、失败前副作用边界、restart选择依据和未证明的runtime路径。它不仅说“需要持久化/恢复”，还说明持久化什么、状态如何前进、哪个consumer可以推进、崩溃后从哪条事实继续，以及哪些近似行为被禁止。

仍保留的内容均属于诚实proof gap，而非机制空洞：H1/H2 restart、publish崩溃窗口、create/GC竞争、tool finalize/restart、gate timeout/recovery、transition/outbox/effect fault injection尚需真实集成验证。draft没有把这些测试未完成写成机制未定义或已完成。

## B. 四项重点复核

### B1. 完整runtime持久轨迹

**判定：通过。**

第5–8节给出从完整实例到业务推进的持久轨迹，而不是只描述“scheduler运行task”：

1. create事务一次写入owner row、definition ref、admitted bindings、完整runtime nodes/edges、initial readiness和transactional outbox；commit前scheduler不可见。
2. ready leaf以revision/epoch约束的CAS进入claimed，同一权威步骤分配stable RunIntent/RunId。
3. pre-spawn gate在stable host上决定advance或claimed→held；held保留intent/run/evaluation epoch并释放capacity，且没有worktree/closure/process副作用。
4. advance后才允许建立资源与process fact。
5. process exit写immutable exit fact，attempt进入awaiting-transition；runner exit本身不推进业务。
6. validator以exit fact和domain journal refs构造TransitionCommit；commit原子派生seq child、par children或join host readiness。
7. duplicate transition幂等返回既有commit；stale revision、foreign credential和wrong host在写入前拒绝。
8. restart按持久事实分支：claimed无process fact恢复同一pre-spawn identity；exit已写而transition未提交则重建同一request；transition已提交而outbox未dispatch只恢复dispatcher。

这已经说明runtime node、readiness、claim、attempt、exit、transition、outbox之间的owner与时序。它也明确runtime tree持久存在但scheduler旁路的current问题，避免把SQLite shape误当生产调度能力。

### B2. ToolOutcome全链

**判定：通过。**

第6.2节给出完整的声明到consume链：

- definition-scoped ToolId进入registry；compile、doctor、prompt读取同一registry。
- compiled requirement在具体run派生stable requirement identity。
- invocation产生带definition/run/phase/tool/namespace/author及durable-commit provenance的evidence。
- evaluator把journal从Pending推进为Evaluated，并区分Achieved、NotAchieved、NotEvaluated。
- finalize建立本attempt的cutoff并冻结可消费结果；late evidence不能回写当前transition。
- required与expected语义分开：required缺能力导致new unsupported/existing hold；expected缺能力可继续但必须显式NotEvaluated，不能伪装Achieved或消失。
- TransitionCommit只consume已经finalize且host相符的ref，不从event/context/invocation猜outcome。
- restart按journal state继续：Pending恢复同一evaluation，Evaluated未finalize只finalize，已consume不得重复消费。

同时，draft把真实invocation/evidence/finalize runtime列为具名dependency，不虚构transport。这正是合同机制与外部实现边界的正确深度。

### B3. 四个Gate point与journal恢复

**判定：通过。**

第6.2节逐一给出四个封闭point的host、trigger和decision作用：

| Point | Stable host | Trigger fact | Decision consumer |
|---|---|---|---|
| run.pre-spawn | RunIntent/RunId | claim完成 | spawn或hold |
| run.post-exit | 同一run | durable exit fact | 是否允许构造transition |
| container.join | container node + epoch | 所需children到候选终态 | join推进或hold |
| chain-complete | chain completion epoch | root候选完成 | 发布终态或hold |

每个point都要求trigger fingerprint、binding identity、decision和consume ref进入GateEvaluation journal，不能只发event。journal状态明确为evaluating→decided→consumed：restart恢复evaluating的同一host/fingerprint；decided由唯一consumer原子consume；consumed返回既有结果。

binding与capability边界也完整：chain覆盖global，item不参加named binding；optional只允许没有matching binding时skip，选中后的executor failure不能吞；任何gate declaration在capability absent时new reject/existing hold。create-time capability admission与claim后的host-specific evaluation被明确分开，避免把“支持协议”与“这次decision”混成一个状态。

### B4. Publish/resolver/GC崩溃并发协议

**判定：通过。**

第3节已经给出足以实现和验证的状态协议：

**Publish**

- 同filesystem staging写partial bundle；staging不可解析。
- 写入、fsync文件和目录，按canonical bytes计算identity，再重开验证manifest、asset digest和overall identity。
- 全部验证后才rename并将metadata置live。
- same ref/same content幂等；same ref/different content是collision；different refs不得互相prune。
- publish先于create，因此崩溃至多留下完整unreferenced artifact，由GC清理，不产生DB已引用但文件未完成的instance。

**Resolver/cache**

- cold resolve验证tagged kind/schema、metadata live、manifest、每个asset digest和整体identity，全部通过后才入process cache。
- missing/corrupt/unsupported/retiring是不同typed结果；禁止旧cache、current source或弱兼容解析fallback。
- cache只是verified content加速层，不是durability或retention authority。

**GC/concurrency**

- mark依据chain、item、runtime node、run和保留历史的全部persisted refs。
- 候选在事务中重验零ref才允许live→retiring；retiring后new resolve/create立即拒绝，因而与新增引用形成明确互斥点。
- 清理移入trash再删metadata；任一步崩溃，restart按retiring/trash继续，不把artifact复活为live。
- 有持久ref绝不retire；零ref进入retiring后不得再新增ref；cache不获得保留权。

该节还明确把publish crash windows、create/GC race、cache rebuild和corrupt recovery列为待跑集成验证，没有以协议文字冒充runtime proof。

## C. 非概要深度标准

| 检查 | 结果 |
|---|---|
| 只写目标名词、无状态迁移 | 否 |
| 给出stable identity与owner | 是 |
| 给出写入/consume顺序 | 是 |
| 给出副作用最早边界 | 是 |
| 给出crash/restart分支 | 是 |
| 区分authority与projection/event | 是 |
| 区分new reject与existing hold | 是 |
| 区分机制合同与具名dependency | 是 |
| 明确禁止fallback/inert/guess | 是 |
| 保留真实proof gap | 是 |

## D. 精确缺陷

**无。**

非阻塞验证提醒不构成draft缺陷：实现后仍必须以fault injection或进程级integration覆盖publish每个崩溃点、create/GC竞争、claim/held capacity、ToolOutcome late evidence/finalize/restart、四point GateEvaluation恢复、transition/outbox/effect unknown。draft已把这些列为proof gap，当前无需为了“显得更深”虚构transport、线程模型或数据库表DDL。

## 尾结论

**PASS，缺陷0。当前draft已为四项重点提供非概要机制深度：runtime从ready/claimed/held到exit/transition/outbox的完整持久轨迹；ToolOutcome从requirement、evidence、evaluation、finalize到consume/restart的全链；四个typed Gate point的host/trigger/decision及evaluating/decided/consumed恢复；publish、cold resolver、cache和ref-aware GC的崩溃/并发协议。剩余内容均被诚实标为需真实验证的proof gap，没有机制空白或把未实现dependency冒充完成。**
