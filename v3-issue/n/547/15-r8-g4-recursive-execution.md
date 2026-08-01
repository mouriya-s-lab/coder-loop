# R8/G4 — Recursive execution 决策档案

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 只读事实输入：`13-r7-07-compiled-tree-model.md`、`13-r7-08-runtime-transition-commit.md`；稳定锚点：D3 P-D3-1…P-D3-9、§2.4 variant准入纪律、§2.5引擎原生供给条款。  
> 本档案不查源码、不做实验、不推荐、不裁决、不实现、不估算规模。所列形态是报告事实能够区分的形态，不宣称穷尽未来实现。

## A. 执行摘要（≤一页）

### A1. 问题来源

稳定D3要求的顺序是：先有可声明、可校验、identity稳定的递归定义树和typed transition paths；再由定义构造runtime树；scheduler只沿runtime readiness与committed transition推进。现存系统的顺序相反且断开：

1. 定义面仍以`phases[]`为唯一真实输入；`tasks`只是全部校验完成后从phase列表机械生成的退化伴生树。
2. canonical model同时保留`phases[]`与`tasks`，大量生产consumer继续读phase数组；compiled tree没有成为唯一权威。
3. runtime store已有leaf/seq/par/join、cursor、pin、evaluation等严格ADT/SQL资产，但production没有“compiled tree → runtime tree”constructor。
4. runtime树在首次run时才按当前phase动态append root/leaf/closure；scheduler不读tree cursor、par/join或candidate，而读`preset.phases + item.phase/status + runs`。
5. run-start有局部原子事务；run close由agent status、run complete、current/session/item/closure/event等多次独立写组成，没有typed `TransitionPath`或唯一业务commit。
6. restart recovery清stale process/current并把unfinished run标orphan；它不判定或重放业务transition，也不能消除agent外部副作用重复。

因此，定义模型必须先裁决；不能从runtime SQL倒推定义语法或identity，也不能把store中存在的variant、cursor、pin、join称为scheduler已经消费。

### A2. 稳定要求与触发条件

- 任意嵌套seq/par、显式稳定node id、非法结构load-time拒绝、真实递归projection；
- linear `[[phases]]`必须normalize为同一模型，不留第二套parse后权威；
- join是封闭ADT，candidate和transition引用在compile时完整；
- non-degenerate par在调度能力落地前必须点名拒绝，不能静默串行；
- seq推进消费committed transition，不能消费裸runner exit或terminal status；
- seq流转、par同commit派生、closure分支/回收/消费采样是引擎原生机制，不进入DSL；只有并发上限、reopen预算等参数属于声明；
- 新variant只有在语义、持久化、status/event投影和所有穷尽consumer同时存在时才准入。

触发nested声明、node rename/move、candidate引用、par scheduling或crash mid-close时，现有断裂从“线性路径仍可跑”放大为identity漂移、双权威、cursor偏离、不可达store状态或重复业务副作用。

### A3. 裁决与证明边界

本档案提出十个逐项问题，覆盖定义语法/normalize/identity/projection、runtime constructor/authority、transition commit/recovery、par pin和过渡guard。纯口径只决定“tree/cursor/run/status/event分别叫什么、谁被称为权威或commit”；一旦要求唯一canonical模型、constructor、scheduler改读、原子commit或replay，便是工程分叉。

R7-08没有运行会创建worktree的stub-runner/engine integration；成功、失败、kill、restart的全流程结论来自生产调用顺序和已有测试证据，而不是本轮新真实process实验。这是必须保留的**运行证明缺口**，不是可供选择的产品形态。操作员可以要求另行验证，但不能以“未跑”反推实现正确或错误。

---

## B. 完整决策案

## B1. 稳定设计合同

| 条款 | 稳定合同 | 决策边界 |
|---|---|---|
| P-D3-1 | 递归声明、稳定显式identity；linear normalize为退化seq且无第二模型 | 声明语法、normalize入口、identity作用域 |
| P-D3-2 | join封闭ADT；当前域`drain/validator`，后续variant整链加入 | 定义variant与runtime variant必须同义且有consumer |
| P-D3-3 | 空par、悬空引用、reopen、join、dependsOn等非法结构load-time error | finding分类与引用校验 |
| P-D3-4 | 并发上限/reopen预算是声明参数；机制由外树消费 | 参数/机制边界 |
| P-D3-5 | 公共产物真实投影非退化嵌套树 | 递归projection与旧数组读面 |
| P-D3-6 | par调度未落地前点名拒绝，不串行退化 | 过渡guard位置与错误面 |
| P-D3-7 | 具名candidate表；runtime值只引用`(definitionRef,candidateId)` | candidate identity与悬空校验 |
| P-D3-8 | 结构边即typed transition path；目标、prompt、bindings、`exit.*`完整 | 定义边与数据边的统一 |
| P-D3-9 | seq readiness消费committed transition；linear同样走此路径 | scheduler权威与commit语义 |
| §2.4 | variant须同时具备语义、持久化、投影、穷尽consumer | 禁止以store空壳预留 |
| §2.5 | 起点、closure分支、seq推进、par pin、回收/采样为引擎原生 | DSL只声明参数，不声明branch/pin机制 |

稳定D3只把seq/par TOML具体语法形态列为待裁决；不能借语法未定否定上述语义合同。

## B2. 定义面事实：退化伴生树而非canonical recursive model

### B2.1 声明与normalization

当前TOML只有`phases[]`及phase局部字段，没有：

- root、seq/par/join node声明；
-显式node id；
- candidate、transition、dependsOn、reopen target；
- par concurrency/reopen budget；
- typed transition target/input/output。

现有builder只接受phases并生成固定三层：

- `tasks:root`；
- 每phase一个`phase:<name>` seq容器；
- 每phase一个`task:<name>` leaf。

它在DAG、prompt、fragment与hash处理之后才运行。因此它不是“递归声明归一化”，而是phase列表的late derived projection companion。未知`[tasks]`声明会被静默丢弃并compile成功，进一步证明当前没有结构声明拒绝边界。证据：R7-07 A2、B2–B3、B6、B9。

### B2.2 Identity与引用

当前identity由phase name拼接：

- 合法linear集合靠重复phase拒绝和kind前缀保持唯一；
- phase rename必然改变id；
- node move没有输入形态；
- 用户不能声明稳定id；
- 没有node reference table，自然也没有duplicate/hanging reference检查。

compiled leaf id进入run packet和runtime node，是可保留的关联资产；它只证明“当前run归因到哪个退化leaf”，不证明结构identity已经可声明、稳定或被scheduler消费。证据：R7-07 B5；R7-08 B1。

### B2.3 双读面

canonical model保留`phases[]`和`tasks`。生产消费者分裂：

- phase parse/validation、DAG、prompt、runner、trigger、rights、status、doctor和scheduler主要读`phases[]`；
- projection、run definition packet、migration helper只读取退化`tasks.children`，并假设每phase单child。

所以tree不是唯一结构权威。局部扩展projection或store不会消除phase-array旁路。证据：R7-07 B4、B7–B8、B12。

## B3. Runtime面事实：store骨架而非compiled实例

### B3.1 Production constructor

production没有从compiled root递归实例化runtime tree的constructor。chain/item create只写业务rows；首次run时：

1. scheduler按phase数组选择item/phase；
2. run packet携带当前phase的compiled leaf identity；
3. store按需建seq root；
4. append当前phase leaf与closure；
5. 关联run。

后续phase在遇到时再append。nested seq/par/join不会由production路径创建。公开store API、migration或tests能写入这些variant，不等于definition→runtime接缝存在。证据：R7-08 A1、B1、B3。

### B3.2 Scheduler authority

当前selection读取：

- `preset.phases`顺序；
- item phase/status/lastRunId；
- latest run endedAt/exitCode/startStatus；
- trigger的afterPhase/whenStatus。

它不读取runtime tree、seq cursor、par state、join evaluation或candidate。正常run close也不推进cursor；cursor仅在root初建和leaf删除修复时写。因此cursor可以长期停在iteration而scheduler已跑review。status tree是真实持久化投影，但不是调度权威。证据：R7-08 B2、B4。

### B3.3 Store资产的准确边界

可保留资产包括：

- strict leaf/seq/par/join/evaluation ADT；
- SQLite definition/node/tree/closure/run FK、unique、check；
- seq cursor direct-child检查；
- par pin、epoch/reopen、join binding/evaluation version；
- definition/run/closure identity链；
- closure resource、consumption intent和cleanup/retry。

这些资产分别证明可表达、可round-trip或局部约束，不证明：

- compiler能产生相同结构；
- production constructor能实例化；
- scheduler能穷尽消费；
- status/events投影语义完整；
- par children确实同commit；
- transition exactly-once。

按§2.4，不得因ADT/SQL存在就宣称variant已准入。证据：R7-08 B3、B7、B10、B12。

## B4. Transition commit事实

### B4.1 Run-start局部事务

run-start的一个immediate transaction覆盖definition/root/leaf/closure、prepared resource核对和run row。这是强局部原子资产。

事务外仍有：

- current run；
- item phase/lastRun/attempt；
- credential、prompt/evidence；
- process spawn；
- events。

因此“run已落库但process未spawn”等窗口靠补偿和重调度处理，不能称为完整transition commit。证据：R7-08 B5。

### B4.2 Run-close多步事实

close路径跨越：

1. agent可提前独立写item status；
2. child exit分类；
3. completeRun；
4. clearCurrentRun；
5. session写/清；
6. item phase/attempt/backoff；
7. closure lifecycle；
8. events；
9. consumption与chain completion。

各store method可以原子，但整体无单一对象同时携带path identity、target、bindings、exit payload与commit id。item status和run exit是两个可分叉事实；event不是business commit。证据：R7-08 B6–B7。

### B4.3 Success/failure/kill/restart

| 场景 | 当前结果 | 与committed transition的差距 |
|---|---|---|
| success exit 0 | 线性推进；最终status依赖agent write | 无typed path/output与单commit |
| ordinary failure | 不推进，独立backoff/attempt | tree不回滚，也无transition rejection对象 |
| spawn失败 | run/resource事实可能已存在，走补偿 | process边界不在事务内 |
| timeout/kill/rate-limit/session invalid | 各自close分支 | 仍基于run/item旧字段 |
| daemon kill/restart | unfinished run orphan；旧item字段保留再调度 | 无法判定mid-close位置或业务副作用 |
| crash mid-close | 任意中间组合 | 不重放唯一transition |

现状倾向at-least-retry；同一业务意图可产生新runId并重复agent外部副作用。证据：R7-08 A2、B8–B9。

## B5. Recovery的准确角色

startup recovery会：

- 验证current run的runtime identity；
- kill stale process group；
- clear current；
- 将`endedAt=null` run标为`orphaned/-1`；
- reconcile closure resources与consumption facts；
- emit recovery summary/event。

它不会：

- 改item status/phase/session；
- 推进cursor；
- 恢复typed transition；
- 判定agent side effect是否发生；
- 重放close handler剩余业务步骤。

所以“recovery存在”只证明process/run/resource修复，不证明transition replay或exactly-once。若裁决要求业务replay，需要另行定义commit evidence和幂等边界；不能从现有orphan标记推导。证据：R7-08 B9。

## B6. §2.5 引擎原生行为边界

| 行为 | 现存资产 | 不得推导 |
|---|---|---|
| 起点/baseBranch | chain metadata、base commit | 不进入preset tree DSL |
| closure分支程序化 | branch/worktree命名和resource记录 | agent自建branch声明不应复活 |
| seq流转 | 现在线性phase推进可运行 | 当前裸exit推进不等于目标committed transition |
| par同commit派生 | store有`pinCommit`字段 | production无par constructor/child resource guard |
| 回收与消费采样 | reachability、intent、cleanup retry资产 | 不等于transition原子完成 |

并发上限和reopen预算属于tree声明参数；如何调度、pin和回收属于引擎机制。任何形态若把branch naming、起点或pin变成preset可override字段，都越过稳定边界。

## B7. 定义模型的事实支持形态

以下五种形态来自R7-07 B13，不排序：

| 形态 | 确定后果 | 具体触点 | 未知 |
|---|---|---|---|
| D1 recursive canonical + derived linear compatibility view | tree成为单一权威；旧consumer明确改读derived view | parser/normalizer、all phase consumers、projection | schemaVersion 1能否保留 |
| D2 linear canonical + optional structural overlay | 双事实源继续；必须定义冲突优先级 | phase model与overlay合并、consumer选择 | 冲突/漂移如何检测 |
| D3 新recursive declaration与旧phases二选一后normalize | loader判互斥/等价并产出一个模型 | TOML boundary、migration/error finding | 具体syntax与兼容窗口 |
| D4 显式node id与结构位置分离 | rename/move可保持引用 | identity作用域、uniqueness、reference validation | global还是局部命名域 |
| D5 版本化非退化projection并保留旧数组端点 | consumer可分期迁移；公共读面增加 | projector、schema、外部consumer | 是否允许多读面、何时退役 |

稳定P-D3-1要求最终不存在第二套parse后权威，因此D2若作为终态会保留已知根因；档案记录其后果，不将其推荐或自行排除为过渡形态。

## B8. Runtime/transition的事实支持形态

以下六种形态来自R7-08 B13，不排序：

| 形态 | 当前事实 | 确定后果 | 未知/缺口 |
|---|---|---|---|
| R1 phase/run/item继续权威，tree作projection | 当前实现 | linear可运行；cursor漂移；nested/par不可达 | 与P-D3-9终态不符 |
| R2 仅使用现有runtime tree storage | store API可写 | 无compiler constructor/scheduler消费，仍是fixture形态 | 谁构造、谁推进 |
| R3 agent status write视为transition | 当前业务信号之一 | 与run close/closure/event不原子 | path/output/commit id缺失 |
| R4 run exit视为transition | scheduler已消费 | 无typed path/output；agent status仍第二权威 | failure与业务结果如何区分 |
| R5 recovery补偿多步close | 当前局部做法 | 修process/run/resource，不能判定或重放业务side effect | replay/dedupe evidence |
| R6 以par pin SQL直接宣称same-commit | 只有field/round-trip | production无par child/resource guard | constructor/scheduler/资源验证 |

这些形态中，R2/R6专门展示“store资产不等于scheduler语义”；R3/R4展示“现有信号不等于typed unique commit”。它们不能绕过定义模型裁决。

## B9. 定义先于runtime的组合约束

组合任何D/R形态都必须满足以下顺序：

1. declaration先形成合法的normalized definition；
2. stable identity、candidate和transition references在compile时闭合；
3. public projection与内存模型同源；
4. runtime constructor从该definition产生实例，不自行重造结构；
5. scheduler只消费runtime readiness和committed transition；
6. recovery基于commit evidence恢复，而非猜测多步close的中间状态。

以下等同关系不成立：

1. derived退化tree ≠ recursive normalization；
2. compiled leaf id进入run ≠ runtime实例化compiled tree；
3. runtime node FK/unique ≠ scheduler读取tree；
4. seq cursor存在 ≠ cursor是推进权威；
5. par pin字段存在 ≠ children从同commit派生；
6. item status或run exit ≠ typed transition commit；
7. per-method transaction ≠ end-to-end business atomicity；
8. orphan reconciliation ≠ transition replay；
9. nested store tests绿色 ≠ production constructor可达；
10. recovery事件存在 ≠ agent外部副作用exactly-once。

## B10. 过渡guard与variant准入

### B10.1 Non-degenerate par guard

稳定P-D3-6已钉住：par scheduler尚未落地时，含非退化par的定义必须在调度侧点名拒绝，不得串行退化或仅warning。仍需裁决的是：

- guard依据哪个compiled identity/shape；
- 在chain/item创建、调度选取还是spawn边界首次执行；
- error如何进入status/event且避免重复判断；
- capability落地后由什么可验证事实解除。

“不加guard继续按phase数组跑”不是中性兼容，因为它会静默错跑。

### B10.2 Variant准入

现有runtime ADT中的par/join不自动满足§2.4，因为definition声明、production constructor、scheduler、status/event穷尽消费没有同时存在。未来新增`script`等variant也不能先加空预留。每个variant必须一次说明：

- 语义；
- definition boundary与validation；
- persistence；
- constructor；
- scheduler/recovery；
- status/events/public projection；
- exhaustive consumer。

## B11. R7-08运行证明缺口

本轮已运行的是隔离SQLite/runtime-tree测试，结果19 pass / 0 fail；它证明store约束、局部事务、round-trip与部分recovery资产。

本轮**没有**运行会创建closure worktree、启动daemon和stub runner的engine integration。故以下没有获得本轮新的真实process执行证明：

- success/failure/kill完整close时序；
- daemon crash发生在close任意两步骤之间；
- restart后重复spawn与agent外部副作用；
- compiled nested tree的production constructor；
- par children真实并发且共享pin；
- join evaluation/reopen/restart全链。

报告对这些路径的结论来自production调用顺序及已有integration源码/证据inventory。这个缺口：

- 不是“选择是否支持transition”的产品选项；
- 不削弱静态已确定的“当前无constructor/无scheduler读取/无单commit”；
- 会限制对真实时间、故障窗口和side-effect重复频率的置信度；
- 若操作员要求冻结工程方向前的运行证据，应另派专门验证，不得把旧green或store tests冒充该证明。

## B12. 纯口径选择与工程分叉

### B12.1 纯口径选择

- “compiled tree”是否只指normalized definition，不再称derived phase companion为完整tree；
- “runtime tree”是否只指definition实例，不再把lazy status projection称为已实例化workflow；
- “scheduler authority”明确为唯一readiness来源，而非多个平行信号；
- “transition commit”保留给同时含path/target/bindings/output/identity的业务事实；
- recovery event、orphan run、item status与runner exit各自的命名/证据角色。

若口径声称这些对象具备唯一性、原子性或重放能力，即进入工程分叉。

### B12.2 工程分叉

- seq/par TOML syntax与linear兼容入口；
- explicit node id作用域、rename/move与reference validation；
- normalized canonical tree及derived compatibility view；
- non-degenerate recursive projection与schema version；
- compiled→runtime constructor时点与事务；
- scheduler从tree cursor/readiness推进；
- typed transition path对象与唯一commit边界；
- item status/run exit/closure/event的迁移与派生关系；
- crash replay、dedupe和external side-effect边界；
- par pin资源guard、join/reopen scheduler与recovery；
- P-D3-6 capability guard及解除条件。

## B13. 需要操作员逐项裁决的问题

每题均可回答“保持未知/另查”。

1. **声明入口：** recursive tree采用嵌套内联还是引用式节点表；旧`[[phases]]`与新声明是二选一normalize、derived compatibility view，还是另有明确过渡形态？（工程分叉）
2. **Canonical authority：** 是否明确normalized recursive tree为parse后的唯一结构权威，phase数组只能是derived view；若暂时保留双读面，冲突优先级和退役条件是什么？（口径 + 工程分叉）
3. **Identity：** node id采用何种显式作用域，rename/move时哪些变化保持identity；duplicate、悬空candidate/transition/reopen引用如何归类？（工程分叉）
4. **Projection兼容：** 非退化recursive projection如何与schemaVersion 1的`phases[]`读面共存或迁移；是否需要保留独立旧端点？（工程分叉）
5. **Runtime constructor：** chain、item创建或其他哪个边界从definition实例化完整runtime tree；实例化失败的事务与可见状态是什么？（工程分叉）
6. **Scheduler authority：** runtime readiness/cursor何时成为唯一推进来源；现有item phase/status/run exit分别改为derived fact、输入信号还是过渡兼容？（口径 + 工程分叉）
7. **Transition commit：** 唯一commit对象至少包含哪些path/target/bindings/output/identity；agent status、run exit、closure lifecycle与event如何关联而不成为第二权威？（工程分叉）
8. **Recovery：** crash后按什么commit evidence决定replay、retry或hold；agent外部副作用的dedupe边界由谁承担；是否先另派fault-injection调查？（工程分叉/可另查）
9. **Par与引擎原生机制：** concurrency/reopen参数如何进入definition，同时确保base/branch/pin/seq/cleanup机制不进DSL；same-commit由哪些runtime/resource事实证明？（工程分叉）
10. **Guard与证明：** par scheduler未落地时guard在哪个边界点名拒绝、以什么status/event投影；在冻结方向前是否补跑真实process crash/par/join路径以关闭R7-08证明缺口？（工程分叉 + 验证裁决）

## B14. 裁决记录模板

| 问题 | 操作员裁决 | 保持未知/另查 | 不得误推 |
|---|---|---|---|
| Q1 声明入口 | 待裁决 | — | 语法未定不否定D3语义 |
| Q2 Canonical authority | 待裁决 | — | derived tree不冒充唯一模型 |
| Q3 Identity | 待裁决 | — | name拼接不证明move稳定 |
| Q4 Projection兼容 | 待裁决 | — | schemaVersion 1不自动兼容nested |
| Q5 Runtime constructor | 待裁决 | — | store API不冒充constructor |
| Q6 Scheduler authority | 待裁决 | — | cursor存在不等于消费 |
| Q7 Transition commit | 待裁决 | — | status/exit不冒充commit |
| Q8 Recovery | 待裁决 | — | orphan repair不冒充replay |
| Q9 Par机制 | 待裁决 | — | pin字段不证明same-commit |
| Q10 Guard/证明 | 待裁决 | — | proof gap不是产品形态 |

## B15. 证据索引

| 主题 | 只读事实来源 |
|---|---|
| 声明、normalization、identity、双读面 | `13-r7-07-compiled-tree-model.md` A1–A4、B2–B5 |
| Compile校验与projection | `13-r7-07-compiled-tree-model.md` B6–B8 |
| Nested声明探针与consumer未知 | `13-r7-07-compiled-tree-model.md` B9–B10 |
| 测试边界、根因与五种定义形态 | `13-r7-07-compiled-tree-model.md` B11–B14 |
| Production constructor与scheduler authority | `13-r7-08-runtime-transition-commit.md` A1、B1–B4 |
| Run-start/close事务 | `13-r7-08-runtime-transition-commit.md` B5–B7 |
| Success/failure/kill/restart与recovery | `13-r7-08-runtime-transition-commit.md` A2、B8–B9 |
| Par pin、测试盲区与六种runtime形态 | `13-r7-08-runtime-transition-commit.md` B10–B14 |
| 稳定D3 | `AGGREGATE-547.md` §3 D3 |
| Variant准入与引擎原生行为 | `AGGREGATE-547.md` §2.4–§2.5 |

## 尾部结论

**G4必须先裁决递归定义树的唯一canonical模型、stable identity和真实projection，再裁决它如何实例化runtime tree、由scheduler消费readiness并通过唯一typed transition commit推进。当前退化compiled tree、lazy runtime leaf、strict store ADT/SQL、cursor、pin、局部run-start事务和startup recovery都是可保留但边界有限的资产；它们不构成recursive definition、production constructor、scheduler authority、same-commit par或exactly-once transition。R7-08未新跑真实stub-runner/worktree故障链是需显式保留的验证缺口，不是产品选项。十项问题裁决前，不把store可表达性或旧线性绿测写成runtime语义。**
