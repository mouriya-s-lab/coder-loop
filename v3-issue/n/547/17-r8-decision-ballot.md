# RFC #547 — R8 操作员决策 ballot

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 输入：`16-r8-decision-audit.md` 的 TF-01…TF-44 与七份 `15-r8-g*-*.md`。  
> 用途：让操作员分轮作答；不预填、不推荐、不裁决、不设计实现、不估规模。候选仅为事实支持形态，均非完备集；每题始终可答 `X：以上皆非 + 说明`。

## A. 摘要（≤1页）

本 ballot 只询问审计确认的 **44 个真分叉**，不重新询问稳定 RFC：schema artifact 与 instance 区分、source type 唯一权威、recursive normalized tree 唯一权威、创建成功前 pin、全 consumer 同 ref、missing/corrupt 不回退 current、D4/D5 本仓与外树份额、unsupported handshake、引擎原生机制不进 DSL、opaque item id、repository 退物理列、无默认 preset 等均为选项合法性前提。

为避免一次要求回答44题，ballot分五轮：

| 轮次 | 数量 | 目的 | 前置 |
|---|---:|---|---|
| R1 基础边界 | 6 | 先固定会解锁最多后续的producer、type、definition、tree、tool identity | 无 |
| R2 核心合同 | 9 | 固定schema/value/null/admission、gate identity、repository与chain语义 | R1相关答案 |
| R3 对外语义 | 13 | 固定finding/render/update/read面、capability与breaking边界 | R1–R2相关答案 |
| R4 生命周期 | 14 | 固定migration、artifact/cache、runtime/transition/recovery与registry | R1–R3相关答案 |
| R5 外部闭环 | 2 | 在外部owner证据满足停点后固定C6与gate执行闭环 | R1–R4；STOP-08/09达到门槛 |

第一轮仅6题：TF-04、TF-06、TF-16、TF-17、TF-25、TF-32。它们能独立裁决，且分别解锁schema/binding、definition、recursive runtime和tool链；第一轮不要求猜外部consumer或executor。

**答法：** 每题写代码（如 `TF-04=B`），必要时补限定；若现有形态均不准确，写 `X` 并给一句合同描述。调查/证明停点列在C2，不混入产品选择，也不因证据未到就自动选择某形态。

---

## B. 分轮 ballot

## R1：基础边界（6题，无前置）

### TF-04 Schema producer、分发面与首个consumer责任

**来源：** 当前projection instance、private boundary与版本数字都不能充当可分发schema，且首个独立consumer尚未确认。  
**稳定前提：** schema是独立可分发artifact；instance/boundary不得冒充schema。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | 本仓compile producer负责发布规范artifact；consumer只派生类型/校验 | producer版本、compile JSON、artifact分发为本仓责任；外部owner不补语义 |
| B | 独立schema build/export边界负责发布，compile只引用artifact identity | 新旧compile读同一artifact；触点为schema build、ref与consumer加载 |
| C | 暂只裁本仓producer责任，首consumer保持未知到STOP-01 | artifact仍须可独立取得；不猜consumer或载体 |

**未知：** 首个独立consumer owner与真实读取失败路径。  
**回答：** `TF-04=A|B|C|X：说明`

### TF-06 Source type authority 与 use-site expectation

**来源：** source catalog必须唯一解释值，但跨phase use-site仍可能需要约束兼容性。  
**稳定前提：** source schema是类型唯一权威；expectation不得重新解释source。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | use-site只能引用source type，不另声明expectation | 冲突面最小；触点为binding parser、compiled projection |
| B | use-site可声明可验证的窄化/兼容约束 | compile检查source→expectation；不能改变source解释 |
| C | expectation只表达消费能力集合，不表达新类型 | 跨phase冲突按能力不相容报错；触点为compile diagnostics |

**未知：** 真实跨phase冲突需求与expectation载体（STOP-02）。  
**回答：** `TF-06=A|B|C|X：说明`

### TF-16 PresetDefinition 创建前字段闭集

**来源：** 当前需要pin完整执行定义，但尚未逐字段确定preset创建前可计算闭集。  
**稳定前提：** 只保护创建前可完整计算字段；运行结果不得进入definition。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | 收录normalized preset、模板/fragments、typed bindings、词表、tools/gates及compiled findings | resume/render/doctor均可只读ref；artifact较完整 |
| B | 收录canonical compiled model及其内容依赖manifest，原文由内容ref间接引用 | resolver需递归校验manifest；projection只读canonical model |
| C | 先闭集于当前真实consumer必需字段，外部字段等STOP-11后另行版本化 | 不为未知GUI/hook扩字段；后续新增需definition版本演进 |

**未知：** 外部GUI/hook真实读取字段。  
**回答：** `TF-16=A|B|C|X：说明`

### TF-17 ChainDefinition 字段闭集与owner

**来源：** chain tree/join/baseBranch与typed chain boundary在稳定记录中存在owner冲突，实存producer尚未找到。  
**稳定前提：** chain与preset definition分离；只经单一typed boundary；无第二parser。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | 本仓拥有并发布ChainDefinition；外部producer提交该typed boundary | 本仓定义tree/join/baseBranch闭集与parse/version错误 |
| B | 外部owner拥有并发布boundary artifact；本仓只消费并pin | D9完整工作以前置artifact为门；本仓不得复制schema |
| C | owner暂保持未知并阻断依赖chain definition的份额 | repository等独立份额可继续；D9/chain runtime明确blocked |

**未知：** external producer owner、artifact与错误路径（STOP-10）。  
**回答：** `TF-17=A|B|C|X：说明`

### TF-25 Recursive DSL、linear compatibility 与projection迁移

**来源：** stable authority是normalized recursive tree，但当前linear phase数组与旧projection仍是消费面。  
**稳定前提：** canonical recursive tree唯一权威；compat view不得成为第二权威。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | linear声明作为语法糖compile成退化seq；projection同时给canonical tree与标记compat view | 旧preset可读；consumer须迁到tree并识别非权威view |
| B | 输入短期同时接受linear/recursive，输出只给versioned canonical tree | 外部projection breaking；parser承担双输入迁移期 |
| C | 新schema只收recursive，bundled/历史声明一次性迁移 | 无长期双grammar；旧输入在边界响亮失败 |

**未知：** repo外projection consumer。  
**回答：** `TF-25=A|B|C|X：说明`

### TF-32 Tool identity、provider边界与entry-existence作用域

**来源：** 当前doctor、runner与external events没有贯穿definition→outcome的共同tool identity。  
**稳定前提：** D4四轴正交；tool与gate不是同一domain；provider差异不得改变identity链。

| 码 | 互斥形态 | 确定后果与触点 |
|---|---|---|
| A | registry tool id贯穿phase/run/invocation/outcome；entry-existence按run+worktree唯一 | 触点为compile、doctor、prompt、C6、finalize |
| B | registry tool id + provider-scoped capability id组成identity；outcome仍回指统一tool id | provider可独立版本化；需映射与冲突错误 |
| C | tool requirement id贯穿definition，invocation id按attempt生成；entry-existence按invocation证明 | retry产生新attempt但同requirement；finalize聚合attempt |

**未知：** 外部真实invocation样本（STOP-08）。  
**回答：** `TF-32=A|B|C|X：说明`

## R2：核心合同（9题；前置R1）

### TF-01 Finding authority 与 rejected warning集合
**来源：** compile、doctor、runtime等多读面可能各自产生findings，rejected前warnings集合也未定。  
**稳定前提：** finding必须结构化、可投影；不能由展示文本反推。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | CompileResult是规范全集，拒绝也返回已收集warnings+errors | compile/CLI/schema共享一次结果 |
| B | 独立validation result是规范全集，CompileResult引用它 | doctor/current-source可复用validation artifact |
| C | findings按stage组成有序集合，reject保留已完成stage结果 | identity需含stage；后续stage不存在不得伪装空集合 |

**未知：** consumer对部分stage集合需求。 **回答：** `TF-01=A|B|C|X`

### TF-05 Projection/schema/typed bindings公共合同面数量
**来源：** 当前instance projection会丢schema/type evidence，多个公共面可能重复或分工。  
**稳定前提：** schema artifact与projection instance必须区分。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | schema、compiled projection、runtime instance三面分离，以ref关联 | 每面单一职责；consumer需追ref |
| B | schema独立，compiled projection内嵌typed binding descriptors，runtime只给值 | 减少一次查询；projection体积增大 |
| C | schema catalog+ref，compiled/runtime均只引用catalog entry | catalog可复用；ref完整性成为共同失败点 |

**未知：** 首consumer读取组合。 **回答：** `TF-05=A|B|C|X`

### TF-07 首批ValueType闭集与opaque JSON
**来源：** 当前`json/object`丢结构类型，而无证据的预留variant违反封闭ADT纪律。  
**稳定前提：** 首批ADT只含有真实值域/consumer证据的variant；不能用opaque占位掩盖未知。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | string/number/boolean/null + named structured schema ref | JSON必须匹配具名结构；parser/projection可穷尽 |
| B | 标量 + recursive array/record typed nodes | 结构内嵌；compile JSON较大但无需catalog ref |
| C | 首批只含已证明标量；结构值在有证据前拒绝 | 现存json binding需migration/失败，非opaque保留 |

**未知：** 额外真实值域（STOP-03）。 **回答：** `TF-07=A|B|C|X`

### TF-08 Missing/null/required/default语义
**来源：** 当前missing可能变空串，null、default与required又分散解释。  
**稳定前提：** missing不得静默变值；类型边界必须保留证据。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | missing独立variant；null仅类型允许；default属source声明；required属use-site | parser/render/admission各自穷尽 |
| B | missing由source optionality表达；default解析后消除missing；null仍为值 | compiled model只见resolved/defaulted或missing error |
| C | required/default都归source，use-site只消费 | 同source所有phase语义一致，无法逐use-site required |

**未知：** runtime-late value的missing时点。 **回答：** `TF-08=A|B|C|X`

### TF-10 Agent-owned typed result对象、owner与失败状态
**来源：** agent写回内容需typed，但现有item/status/exit字段边界未形成单一对象。  
**稳定前提：** agent只能拥有明确result字段，不能覆盖engine/runtime权威binding。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 每phase一个typed ExitResult对象，写回原子校验 | item update/exit command只写该对象 |
| B | definition声明多个具名agent result slot，逐slot校验后transition汇总 | 支持多结果；需slot identity与完整性 |
| C | agent result只进入typed transition payload，不作为item通用字段 | 状态与结果同commit；普通update不接收result |

**未知：** 外部owner variants（STOP-04）。 **回答：** `TF-10=A|B|C|X`

### TF-11 Typed admission domain与最早决定时点
**来源：** CLI、wire、store与scheduler可在不同时间发现同一非法typed值。  
**稳定前提：** 不可信边界立即parse成精确domain type；不能靠后续render兜底。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | daemon command边界统一parse，CLI仅语法；DB只收domain值 | socket/direct一致；store migration另处理 |
| B | shared domain constructor被CLI与daemon调用，daemon仍为权威复验 | 早反馈且不信任CLI；需单实现 |
| C | definition-aware admission service位于daemon事务内 | type/refinement与写入同边界；CLI不能独立判定 |

**未知：** chain boundary owner能否提供同constructor。 **回答：** `TF-11=A|B|C|X`

### TF-36 Gate declaration、point/host identity与pre-spawn时点
**来源：** carrier有八个字符串点和异构host，但稳定contract只有四类typed point且run identity创建时点冲突。  
**稳定前提：** point使用封闭ADT：run.pre-spawn、run.post-exit、container.join、chain-complete；不得发明第二位置语法。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | gate id在definition内唯一；point variant携完整host id；pre-spawn在run id创建后执行 | decision可稳定关联run；spawn前可hold |
| B | gate id在host scope唯一；definition+point+host组成identity；pre-spawn使用预分配run id | 支持同名跨host；失败run需保留identity |
| C | gate id全preset唯一；point只携host ref；pre-spawn绑定run-intent identity | run未创建也可判定；transition需intent→run关联 |

**未知：** 现存额外point的真实consumer。 **回答：** `TF-36=A|B|C|X`

### TF-41 Repository单一权威、selector与typed producer前置
**来源：** 物理列和binding双权威，target/status/fingerprint仍读列。  
**稳定前提：** repository只在business bindings；列与forge格式校验退役；baseBranch保留一等。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | repository binding仍作公开target selector | lookup/status/fingerprint统一读binding；缺值显式失败 |
| B | target改用chain identity，repository仅业务projection | operator caller迁移；fingerprint不得依赖repository |
| C | create保留写binding的纯sugar，但后续只用chain identity寻址 | create与lookup非对称但无双权威 |

**未知：** external typed producer与repo外target caller。 **回答：** `TF-41=A|B|C|X`

### TF-43 Omitted/null/legacy/both-set/empty/mixed chain语义
**来源：** 当前status、scheduler、migration与resolver对同一source组合给出不同结果。  
**稳定前提：** 无默认preset；省略为null；需要定义时点名失败；item recovery取per-item preset。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 存储/list允许null；首次需definition失败；legacy异常行hold修复；chain-wide只读显式ChainDefinition | empty/mixed顺序无关；无静默fallback |
| B | 启动migration只自动规范化有唯一证据的legacy行，其余hold；无chain definition即无chain-wide行为 | 需要证据规则与migration审计 |
| C | 明确migration-only resolver兼容legacy，normal runtime严格；empty/mixed须显式声明 | legacy路径可观察且不得rebind |

**未知：** 存量组合计数与可恢复证据。 **回答：** `TF-43=A|B|C|X`

## R3：对外语义（13题；前置R1–R2相关答案）

### TF-02 Doctor definition健康的时间面
**来源：** doctor可读current source、cache、历史instance或runtime，现状未区分。  
**稳定前提：** current与instance是不同问题；doctor不得用一个面冒充另一个。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | doctor默认current-source，另列instance ref健康 | operator同时看到发布与存量健康 |
| B | doctor必须显式`current|instance`模式 | 无默认混淆；CLI/API多一个必选维度 |
| C | doctor只查current；instance健康归status | 职责分离；跨命令关联ref |

**未知：** operator主要调用路径。 **回答：** `TF-02=A|B|C|X`

### TF-03 Finding identity、归属、replay与durability
**来源：** findings可能来自重复compile/cache/restart，当前无稳定identity或durability合同。  
**稳定前提：** 同一规范finding不得因读面重复而变成不同事实。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | identity=definition content+rule+location；随definition持久化 | replay稳定；runtime只引用 |
| B | identity=compile attempt+rule+location；artifact保留attempt | 可审计每次compile；同内容多组findings |
| C | canonical findings随definition，transient IO findings随attempt | 两类durability与projection需显式tag |

**未知：** 外部consumer去重需求。 **回答：** `TF-03=A|B|C|X`

### TF-09 Prompt projection与typed render error
**来源：** 结构值、number/boolean与错误目前可能压成字符串。  
**稳定前提：** render必须由typed value决定；错误保留binding/source/path证据。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 标量canonical文本；结构canonical JSON；error含binding/source/expected/actual/path | 可复现文本，结构清晰 |
| B | 每ValueType声明projection strategy；error再含strategy | 可扩展但schema/renderer紧耦合 |
| C | 结构禁止直接插值，只能由typed doc renderer消费 | prompt模板更严格；避免任意JSON文本 |

**未知：** 既有结构插值依赖。 **回答：** `TF-09=A|B|C|X`

### TF-12 Update patch与完整对象合法性
**来源：** patch字段可单独合法但merge后对象违反refinement。  
**稳定前提：** 持久对象不得处于非法状态。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | patch仅parse操作，merge后完整对象是最终判据 | update事务需读旧值后validate |
| B | update定义typed domain operations，不接受任意merge patch | 每操作保持不变量；API breaking |
| C | replace完整对象，不提供partial patch | 简单原子校验；caller承担读改写冲突 |

**未知：** 外部patch caller。 **回答：** `TF-12=A|B|C|X`

### TF-13 Batch原子性、definition读取与旁路refinement
**来源：** batch需共享definition且全拒绝，但旁路/迁移可绕过refinement。  
**稳定前提：** batch不得部分写入非法对象。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 事务前pin一次definition、全parse，单DB事务全写 | source变化不影响批内；失败零写入 |
| B | DB事务内读/pin definition并逐项validate，任一rollback | definition与写入同snapshot；事务更长 |
| C | batch编译成typed operation list后由store原子应用 | CLI/wire共享计划；store不接raw input |

**未知：** 批量规模与并发要求。 **回答：** `TF-13=A|B|C|X`

### TF-15 Preflight、错误落点、retry与副作用
**来源：** 静态missing与运行期动态失败现在可能混为同一render错误。  
**稳定前提：** 可创建前决定的错误不得延迟；动态失败不得伪装静态。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | static在compile/create拒绝；dynamic在pre-spawn hold且可retry；spawn前无副作用 | 状态分类清晰 |
| B | static compile finding，实例化时最终拒绝；dynamic形成typed failed attempt | 允许预览非法模型但不执行 |
| C | dynamic resolver在独立事务预取并缓存结果，成功后才开始run | retry围绕preflight；缓存identity必需 |

**未知：** 动态resolver副作用种类。 **回答：** `TF-15=A|B|C|X`

### TF-19 Current-source/instance读面与两类ref关系
**来源：** preset/chain refs与current-source查询可能被同一status字段混写。  
**稳定前提：** 已运行实例只读其ref；source变化只影响新实例。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | API显式分`currentDefinition`与`instanceDefinitionRef` | status/GUI不得自动比较替换 |
| B | instance API只给ref，另有compile/current endpoint | 责任最清楚；consumer需两次查询 |
| C | status给两ref及`sameContent`比较结果 | 便于运维；比较不是rebind |

**未知：** GUI对current diff需求。 **回答：** `TF-19=A|B|C|X`

### TF-26 Node identity作用域与引用错误
**来源：** recursive tree需要稳定node引用，但rename/move与局部重名语义未定。  
**稳定前提：** references必须typed、可验证；不得靠数组位置。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | definition全局显式node id；move/rename不改id | 所有ref简单；作者承担全局唯一 |
| B | 容器局部id + canonical path identity | move改变path；悬空/跨scope错误分开 |
| C | 稳定生成id + author alias | projection暴露二者；alias冲突与生成稳定性需定义 |

**未知：** authoring ergonomics需求。 **回答：** `TF-26=A|B|C|X`

### TF-33 Expected与required finalize语义
**来源：** `expected`可只是文档，也可能影响结果；required outcome缺失必须可观察。  
**稳定前提：** required必须有outcome才能成功；doctor availability不是outcome。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | expected仅observability/prompt；required决定finalize | expected缺失不改run结果但被记录 |
| B | expected形成非阻断warning outcome；required形成阻断 | 两类都持久化，severity不同 |
| C | expected只描述允许outcome集合，actual不匹配即typed failure；required再要求存在 | 合规性更强，需明确集合 |

**未知：** 现有expected字段真实承诺。 **回答：** `TF-33=A|B|C|X`

### TF-37 Optional语义与binding resolution
**来源：** global/chain/item scripts并列但无precedence，optional缺binding/失败也未区分。  
**稳定前提：** required/optional是具名gate声明；binding不得按list order偶然选择。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | item>chain>global明确override；optional无binding继续并记录，执行失败hold | 解析唯一；失败不被“optional”吞掉 |
| B | 最具体层必须唯一，跨层重名即ambiguity错误；optional无binding跳过 | 禁止override；配置更严格 |
| C | declaration显式指定允许层级/override政策 | 每gate可不同；compiled projection需携policy |

**未知：** 外部executor对optional failure分类。 **回答：** `TF-37=A|B|C|X`

### TF-38 Gate capability advertisement/version与unsupported边界
**来源：** valid gate declaration当前可永久inert，无runtime capability handshake。  
**稳定前提：** capability缺失时实例化或调度前结构化unsupported；不得静默忽略。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | daemon启动advertise版本集合；实例create比较 | 不支持则不创建运行实例 |
| B | scheduler注册executor capability；首次调度比较并hold | 允许存储/预览，执行前阻断 |
| C | definition声明minimum capability version；create与resume都校验 | restart降级也可检测；状态需版本证据 |

**未知：** executor部署拓扑。 **回答：** `TF-38=A|B|C|X`

### TF-40 De-GitHub breaking发布与兼容边界
**来源：** queue CLI/wire/batch/migration有四套GitHub兼容语义，仓内consumer主动使用旧词表。  
**稳定前提：** opaque/no normalization；`--issue`→`--item`无alias；wire为`itemId`。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | CLI/wire/docs/scripts在单一可消费checkpoint同时breaking；历史DB migration保留 | 中间提交不可发布；仓外caller立即失败 |
| B | 有序提交但只以最终checkpoint为contract；runtime legacy先删、历史migration按最低schema另裁 | 施工态不宣称兼容 |
| C | runtime与历史升级在同版本切断，旧DB须先经旧版本升级 | 最低直接升级版本明确降低 |

**未知：** 仓外caller与生产DB最低schema。 **回答：** `TF-40=A|B|C|X`

### TF-44 Engine清零scope与历史migration豁免
**来源：** `issue`同时是engine legacy词与合法gh preset业务字段。  
**稳定前提：** engine symbols清零；合法preset业务字段不得误删。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 按symbol/目录ownership gate，历史migration文件窄白名单 | runtime新增命中失败；业务字段允许 |
| B | AST/API surface gate + 独立历史schema fixtures | 不依赖纯文本；docs/scripts另有consumer gate |
| C | 分三gate：runtime symbols、public producer文本、historical migration | 失败归因最清楚；维护三份scope |

**未知：** 外部consumer不由清零证明。 **回答：** `TF-44=A|B|C|X`

## R4：生命周期（14题；前置R1–R3相关答案）

### TF-14 Binding存量违规数据migration
**来源：** 现有存量可能违反新type/refinement，尚无分布事实。  
**稳定前提：** 不得把非法数据静默视为合法，也不得无证据发明转换。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 可证明无损转换自动迁移，其余hold并报告 | 需转换白名单与审计 |
| B | 全部违规行hold，显式repair后继续 | 不猜转换；运维成本外显 |
| C | legacy tagged value只读兼容，禁止新写，逐实例迁移 | normal domain与legacy可观察分离 |

**未知：** 存量统计（STOP-05）。 **回答：** `TF-14=A|B|C|X`

### TF-18 Definition publish/ref与create事务、orphan
**来源：** pin必须在create成功前，但文件publish与DB create跨资源不能天然原子。  
**稳定前提：** 创建成功时ref已完整可解析。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 先immutable publish，再DB create；失败artifact为可GC orphan | create永不指缺失内容 |
| B | stage artifact→DB create→commit marker；无marker均不可读 | recovery需完成/清理stage |
| C | content入同一DB事务，外部文件仅派生cache | 原子最直接；artifact store形态改变 |

**未知：** artifact size/DB约束。 **回答：** `TF-18=A|B|C|X`

### TF-20 无内容历史实例migration
**来源：** 历史row只有ref/hash壳，无法证明当时bytes。  
**稳定前提：** missing历史内容不得回退当前source冒充原定义。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 无可证明内容即hold，显式重建为新实例 | 历史身份不伪造 |
| B | 仅当可由审计证据验证hash匹配时回填，否则hold | 可恢复子集需证据链 |
| C | legacy实例标记不可resume但保留只读status/history | 运维可见，执行永久禁止 |

**未知：** 历史artifact残留率。 **回答：** `TF-20=A|B|C|X`

### TF-21 Artifact publish verdict、snapshot与integrity
**来源：** hash/copy/compile若读取不同bytes，会发布自相矛盾artifact。  
**稳定前提：** ref内容寻址且损坏响亮失败。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 单次bytes snapshot→compile→hash→atomic rename+manifest | verdict与内容同源 |
| B | compile canonical serialization，hash/存储canonical bytes | 原source格式不受保护，语义内容受保护 |
| C | source bundle+canonical result双artifact，同manifest绑定 | 可审计原文与执行内容，完整性面更大 |

**未知：** 是否需保留source原貌。 **回答：** `TF-21=A|B|C|X`

### TF-22 Publish/retire、retention与并发owner
**来源：** immutable artifact需要GC，但并发create/resume可能仍引用。  
**稳定前提：** 被活实例引用的definition不可退役。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | DB引用计数/租约决定retention，单publisher锁publish/GC | 并发清晰；需崩溃修复租约 |
| B | mark-and-sweep从持久refs扫描，publish无全局锁按content id幂等 | GC最终一致；扫描期保护集合 |
| C | 只增不删到明确release checkpoint | 无并发GC风险；存储持续增长 |

**未知：** artifact量与保留政策。 **回答：** `TF-22=A|B|C|X`

### TF-23 Process cache职责、identity与失效
**来源：** 当前path cache偶然让同daemon稳定，restart即失效并重读source。  
**稳定前提：** cache不是definition authority；miss不得回退current。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 只缓存definition ref→verified content，进程寿命，corrupt即逐出并报错 | restart从artifact重载 |
| B | 分source compile cache与instance content cache，identity严格分离 | current预览与resume不混用 |
| C | 不设instance process cache，每次resolver读immutable store | 语义简单；IO增加 |

**未知：** 性能数据。 **回答：** `TF-23=A|B|C|X`

### TF-24 Definition content、统一resolver与missing/corrupt外显
**来源：** row目前无content，consumer各自重读path。  
**稳定前提：** 全consumer同ref；missing/corrupt hold/error且不fallback。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | canonical bytes blob + shared resolver；状态分missing/corrupt/incompatible | scheduler/status/events同错误ADT |
| B | manifest+chunk refs；resolver校验整图 | 支持大bundle；部分缺失可精确定位 |
| C | typed DB content rows；resolver只按tagged ref读取 | schema迁移承担内容演进 |

**未知：** 外部content consumer（STOP-11）。 **回答：** `TF-24=A|B|C|X`

### TF-27 Runtime tree constructor时点、事务与失败
**来源：** compiled tree存在但runtime store只有骨架，实例化边界未定。  
**稳定前提：** runtime readiness是scheduler权威；不支持的非退化par不得串行执行。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | chain create后、首次schedule前单事务实例化整树 | 失败chain hold且无部分nodes |
| B | item/chain instance create事务内同步构造 | create较重，但成功即runtime-ready |
| C | versioned constructor job原子publishruntime tree | 可异步；pending/failed状态必须外显 |

**未知：** tree规模。 **回答：** `TF-27=A|B|C|X`

### TF-28 Scheduler authority迁移与旧事实角色
**来源：** scheduler现读旧phase/status/run事实，未来应读runtime readiness。  
**稳定前提：** runtime tree/cursor readiness是唯一推进权威。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 旧事实仅作projection/audit，由runtime transition写出 | scheduler不再反推状态 |
| B | 迁移期双写但每次校验一致，读取只runtime | mismatch hold；旧consumer可过渡 |
| C | 一次性迁移后移除旧推进字段，run/status变事件派生view | breaking较大，无长期双写 |

**未知：** 外部旧字段consumer。 **回答：** `TF-28=A|B|C|X`

### TF-29 Typed transition commit与多事实关联
**来源：** close涉及status/run/closure/event/gate多次写入，缺共同transition identity。  
**稳定前提：** gate decision不得成为第二推进权威。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 单TransitionCommit含from/to、host、run、result、gate decisions、closure refs | store原子写并派生events |
| B | transition主记录先commit，其他事实按同transition id幂等materialize | 可恢复最终一致；read面识别pending |
| C | append-only typed transition event为权威，views事务更新 | replay能力强；event schema成为核心 |

**未知：** DB原子边界与外部event时序。 **回答：** `TF-29=A|B|C|X`

### TF-30 Transition recovery、retry/hold与副作用dedupe
**来源：** crash可落在多写步骤之间，外部副作用不能靠DB rollback撤销。  
**稳定前提：** 不得重复transition或静默丢失已发生副作用。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | transition id作幂等key；restart补齐未完成materialization；外部call同key dedupe | 可安全replay |
| B | 每阶段write-ahead intent，未知外部结果即hold人工核对 | 不猜副作用是否发生 |
| C | retry只允许无副作用阶段；有副作用不确定一律hold | 合同保守，吞吐降低 |

**未知：** fault injection结果（STOP-06）。 **回答：** `TF-30=A|B|C|X`

### TF-31 Par concurrency/reopen、guard与原生资源接缝
**来源：** DSL可声明par/reopen，但真实scheduler路径未完成。  
**稳定前提：** unsupported必须点名拒绝；base/branch/pin/seq/cleanup等原生机制不进DSL。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | per-par声明concurrency/reopen budget，compile校验，runtime无能力则create拒绝 | guard在实例化边界 |
| B | definition只声明结构，concurrency/reopen由chain runtime policy提供 | DSL较纯；policy仍须pin/投影 |
| C | 首版只允许退化seq；非退化par统一unsupported，直到STOP-07证明链路 | 不提前承诺运行参数 |

**未知：** real par/join路径（STOP-07）。 **回答：** `TF-31=A|B|C|X`

### TF-34 Registry、doctor与prompt doc公共合同
**来源：** registry projection为空，doctor硬编码，prompt要求文档未与同一表相连。  
**稳定前提：** 三consumer读同一registry四轴；prompt文档不是执法替代。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | canonical registry artifact，compile/doctor/doc均按tool id读 | 单一版本与错误源 |
| B | typed registry service输出compile view、availability view、doc view | views明确但service成为运行依赖 |
| C | registry内嵌provider adapter ref与doc schema，doctor按adapter执行 | provider扩展集中；adapter错误需typed化 |

**未知：** provider availability缓存需求。 **回答：** `TF-34=A|B|C|X`

### TF-42 Repository冲突migration与resource不变量
**来源：** 列/binding可一致、单边、冲突或缺失，closure identity却不依赖repository字符串。  
**稳定前提：** 冲突响亮失败不选边；items/runs/closure/worktree不损坏；baseBranch保持。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | 整库事务：一致/列-only迁入，冲突使升级整体失败 | 原子清楚；一个冲突阻断全库 |
| B | 逐chain migration，冲突chain hold，其余升级 | 需mixed schema/read状态 |
| C | 启动前预检列出全部冲突，零写；修复后一次事务升级 | 不产生半迁移；要求repair流程 |

**未知：** 生产组合计数、fingerprint contract。 **回答：** `TF-42=A|B|C|X`

## R5：外部闭环（2题；前置R1–R4及相应停点）

### TF-35 C6 identity handshake、outcome/finalize/recovery
**来源：** 相邻HAPI/events没有coder-loop共同identity，尚无tool→outcome闭环。  
**稳定前提：** 本仓声明/compile，C6外树执法；required finalize必须读同identity outcome。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | request/response API按definition/tool/run/invocation id返回outcome，daemon持久化后finalize | 同步合同；timeout需hold/retry |
| B | durable event protocol，invocation/outcome以幂等id关联 | 异步恢复；consumer offset与迟到规则必需 |
| C | C6写共享typed outcome store，本仓只按ref读取 | store owner/ACL/schema成为边界 |

**未知：** C6 owner/API真实链，STOP-08未满足前本题只保持未知。 **回答：** `TF-35=A|B|C|X|U：保持未知至STOP-08`

### TF-39 Gate executor、decision persistence/recovery与读面
**来源：** 当前只有carrier，无binding执行、decision或restart恢复。  
**稳定前提：** executor必须返回typed decision并关联host transition；不得用hook/status/tool替代gate。

| 码 | 形态 | 后果与触点 |
|---|---|---|
| A | daemon调用typed executor API，decision与transition同事务持久化 | 强一致；外部call需intent/dedupe |
| B | durable gate job/outcome，host保持pending直到decision到达 | 异步可恢复；timeout/retry状态外显 |
| C | 外部executor写decision store，本仓resolver按gate+host+attempt读取 | owner边界清楚；读面/权限/迟到规则必需 |

**未知：** gate executor owner与完整链，STOP-09未满足前保持未知。 **回答：** `TF-39=A|B|C|X|U：保持未知至STOP-09`

## B6. 答题模板

首轮只需复制：

```text
R1
TF-04=
TF-06=
TF-16=
TF-17=
TF-25=
TF-32=

限定/以上皆非说明：
- TF-xx: ...
```

后续轮次模板：

```text
R<轮次>
TF-xx=<A|B|C|X|U>
...

限定：
- TF-xx: ...
```

`X`必须写合同句；`U`只用于题目明确允许保持未知且列出停点的情形。答案若改变稳定前提，必须显式重开RFC，不能作为本ballot普通选项。

---

## C. 覆盖与调查停点

## C1. 44/44覆盖映射

| 轮次 | TF IDs | 数量 |
|---|---|---:|
| R1 | 04, 06, 16, 17, 25, 32 | 6 |
| R2 | 01, 05, 07, 08, 10, 11, 36, 41, 43 | 9 |
| R3 | 02, 03, 09, 12, 13, 15, 19, 26, 33, 37, 38, 40, 44 | 13 |
| R4 | 14, 18, 20, 21, 22, 23, 24, 27, 28, 29, 30, 31, 34, 42 | 14 |
| R5 | 35, 39 | 2 |
| **合计** | **TF-01…TF-44，每项恰好一次** | **44** |

未映射：**0**。重复：**0**。

依赖摘要：R1定义公共边界；R2依其固定核心domain；R3依R1/R2确定对外语义；R4在合同确定后裁生命周期；R5只有在外部owner证据到位后才裁transport/persistence闭环。

## C2. 12类调查/证明停点（不作产品选择）

| 停点 | 证据门槛 | 未达到时的唯一诚实状态 |
|---|---|---|
| STOP-01 首schema consumer | owner、producer identity、真实读取/失败路径 | consumer保持未知，不猜artifact载体 |
| STOP-02 expectation载体 | 真实跨phase冲突需求 | 不新增expectation机制 |
| STOP-03 ValueType variants | 真实值域与consumer证据 | 不加opaque预留variant |
| STOP-04 external字段 | 独立consumer字段清单 | 不扩本仓已定typed对象 |
| STOP-05 binding存量 | 离线分布与历史definition证据 | 不由零样本选择normalize政策 |
| STOP-06 transition crash | close fault injection与side-effect证据 | proof gap不作为recovery形态 |
| STOP-07 real par/join | constructor/scheduler后真实全链 | 不从不可达路径新增需求 |
| STOP-08 C6 | tool→run→invocation→outcome→finalize/restart | TF-35保持未知 |
| STOP-09 gate executor | binding→host decision→transition→restart | TF-39保持未知 |
| STOP-10 typed chain producer | owner、artifact、parse/version/error | TF-17可选保持未知并阻断依赖份额 |
| STOP-11 GUI/hook definition | owner真实读取字段/identity | 不扩definition闭集 |
| STOP-12 owner治理 | 各owner达到各自证据门槛 | unknown不改写为不存在 |

## C3. 证明停点（裁决后另编，不混入选项）

- schema consumer E2E、filesystem损坏/并发publish、cache restart、transition fault injection、real par/join、C6 invocation/outcome、gate timeout/restart、repository生产DB盘点均是**证明任务**。
- “当前跑不了”不自动选择保守或宽松产品语义；“较易测试”也不构成候选优势。
- 停点达到后若出现新真分叉，必须重新对照原问题清单；不能把证据空位直接扩成需求。

## 尾部结论

本ballot将审计确认的TF-01…TF-44全部且仅一次编入五轮，未映射0。第一轮只含6个能独立裁决且解锁最多后续的基础边界；其余38题均标明依赖轮次，C6与gate executor两题在对应外部证据到位前允许保持未知。每题均以稳定RFC为不可变前提，列出2–4个事实支持且互斥的形态、确定后果、触点和未知，并允许“以上皆非+说明”；12类调查停点和证明计划独立列出，不把缺证据、易实现或已有候选误作产品裁决。
