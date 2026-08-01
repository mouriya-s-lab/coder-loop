# R8/G1 — Compile contract 决策档案

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 只读事实输入：`13-r7-01-finding-authority.md`、`13-r7-04-schema-external-consumers.md`、`13-r7-05-binding-type-authority.md`；稳定锚点：D1 P-D1-1/P-D1-2、D2 P-D2-1…P-D2-7，以及 AGGREGATE §2 的 A/C/D/E。  
> 本档案不查源码、不做实验、不推荐、不裁决、不设计实现、不估算规模。下列“形态”只是在三份报告事实范围内可区分的合同形态，不宣称穷尽未来实现。

## A. 执行摘要（≤一页）

### A1. 为什么现在必须裁决

当前被称为“compile contract”的事实由三个彼此独立的断面组成，不能以其中一个代替另外两个：

1. **finding authority**：单次 `CompileResult`、daemon callback/event、status/doctor 并不共享一个 finding 生命周期。CLI 保留成功 warnings；`loadPreset` 丢弃 warnings并把失败压成异常；daemon 另投影结构化 event，受 path cache、cold caller、非原子持久化支配；doctor 对成功 warning 静默。
2. **projection 与 schema 分发**：code checkout 能产出带 `schemaVersion:1` 的 projection instance，源码内有 ArkType boundary；二者都不是独立 consumer 可取得并派生类型的 schema artifact。installed app 版本甚至没有 `preset` 命令。已核验 owner 中没有真实外部 consumer，但未来 GUI owner、hook、`hapi-remote-session` 仍不存在或未知。
3. **binding type evidence**：item 四词、无类型的 source/doc/fallback binding、开放递归 JSON 存储、scalar-only renderer、固定 `type:"string"` 的公共 projection没有形成共同类型权威。现有 runner/exit 也没有 agent-owned typed result object。

这三个断面的共同因果不是“缺一个字段”：当前 source evidence、canonical model、public instance、schema distribution、runtime rendering、finding presentation和外部 owner各有不同的时间、信息量与失败语义。稳定设计要求 D1 提供版本化公共投影及可派生 schema，D2 让 source schema 成为贯穿创建、渲染、转移与外部消费的类型权威；P-D1-2 则仍要求操作员明确 doctor 与 findings 的关系。

### A2. 触发条件与确定影响

- 同一路径被 daemon 首次 cold-load、并发或随后 cache-hit 时，finding 归属和可见性不同；成功源变化在 daemon 生命周期内不重编译，direct status/doctor却读取调用时当前源。
- rejected compile 可能让 callback看见较早 warning与较晚 error，而最终 rejected `CompileResult` 只有 error；event写失败不阻止model返回。
- 独立 consumer若只拿 projection instance，只能手写/猜测shape；若import私有 ArkType boundary，则与源码commit耦合；目前没有真实外部链可验证版本、cache或unknown variant失败。
- generic storage能保留nested JSON，但renderer只接受scalar；null/missing/空串坍缩；同一chain source可跨phase具有不同fallback形状而compile无可比较的type evidence。
- public projection固定string并删除source path、fallback、required、doc与owner；schema即使出现，也只能描述被投影出的shape，不能恢复projector已删除的语义。
- runner stdout/stderr和phase exit是日志/控制面，不是agent-owned typed result；把它们视为D2数据边会混淆权威。

### A3. 裁决边界

本档案把裁决拆为十个短问题：finding权威/时间/失败集合/doctor角色，schema合同/真实producer/首个consumer，以及binding类型闭集/nullable与结构投影/agent-owned数据边。前四项与后六项存在接缝，但不得合并成一句“统一compile输出”：finding时间语义、schema分发、binding真实性、external owner是独立边界。

纯口径选择只包括“哪些对象可以被正式称为finding authority/schema/health”。一旦要求跨cache replay、durable event、独立schema取得、类型证据贯穿、结构文本投影或agent-owned result，便是工程分叉。任何问题均可裁决为“保持未知/另查”；未裁决项不得回写成规格。

---

## B. 完整决策案

## B1. 稳定设计要求

| 锚点 | 稳定要求 | 当前决策需要回答 |
|---|---|---|
| A / D1 | 装载即编译；canonical model 与版本化公共投影同源；唯一投影函数与boundary round-trip | 公共投影的对外合同是什么，schema如何成为独立消费面 |
| P-D1-1 | projection instance不得冒充schema；独立consumer零coder-loop source import并从schema派生 | schema合同、真实producer版本、首个consumer边界 |
| P-D1-2 | compile findings与doctor关系待裁决 | finding authority、时间/归属、失败集合与doctor角色 |
| C / P-D2-1 | source schema是类型唯一权威；target expectation若存在需检查兼容 | 哪些source共享一个可比较类型证据 |
| D / P-D2-2/3 | required/default显式；在最早可决定阶段失败；不得静默空串 | missing/null/empty、实例准入与render失败边界 |
| P-D2-4/5 |结构类型可由公共schema消费；projection携带真实type/required/default | 公共ValueType闭集及instance/schema真实性 |
| P-D2-6/7 | `exit.*`沿同一类型流；agent-owned与外部binding不可互相伪造 | agent result对象、owner与失败状态边界 |
| E | businessKeys不新增computed variant | 不以派生值需要为由扩大source union |

## B2. 当前事实图：三个独立断面

### B2.1 Finding authority

单次compile的类型权威是：

- 成功：`model + warnings`；
- 失败：非空、error-only diagnostics。

生产消费却分裂为：

- compile CLI直接消费完整结果；
- `loadPreset`成功只给model、失败给异常文本；
- daemon callback在verdict前逐finding收集，再在cold load后写结构化event；
- cache-hit caller不replay findings，并发caller共享cold promise但不共享归属；
- status/doctor重新读当前源，不接callback；doctor把load failure当runtime `FAIL`，对成功warning静默；
- daemon finding event写失败可被吞掉，model仍返回。

因此“同一次compile”不能自动推出“所有面看到相同findings”。时间（current source或daemon cache）、归属（compile或chain）、保真（generic或structured）、失败集合与durability必须分别裁决。证据：R7-01 A1–A3、B1–B4、B6。

### B2.2 Projection/schema/external owner

现存产物是：

- code checkout 的projection instance；
- private source内的ArkType runtime boundary；
- instance中的`schemaVersion:1`与source hash。

不存在或未建立的是：

- JSON Schema文件、schema CLI、生成/发布artifact或package export；
- installed app上的稳定compile producer；
- typed `bindings.json` writer/reader；
- 已实现GUI/hook consumer；
- 已核验的`hapi-remote-session` consumer。

已知 `github-hapi-agent-router` 使用自己的Zod config和HAPI target，不消费coder-loop contract；`hapi`也无该消费。这个结论只覆盖已核验owner，不能外推全系统。证据：R7-04 A1–A3、B1–B7、B9。

### B2.3 Binding type evidence

当前类型证据沿链路逐步丢失：

| 层 | 现有证据 | 丢失或不一致 |
|---|---|---|
| item声明 | `string/number/boolean/json`四词 | production后续不消费type；bundled只覆盖string/number |
| chain/runtime | chain无source schema；runtime为string | 与item不共享ValueType权威 |
| canonical binding | source ADT、chain fallback、doc product | 无target type、required、projection、agent owner |
| storage | recursive JSON、null/array/object可保真 | 不受preset source schema约束 |
| renderer | scalar stringify | null/missing变空串；array/object throw |
| public projection | `key,type:"string",sourceKind` | 删除path、fallback、required、doc、owner、真实type |
| runner/exit | stdout/stderr、status/action | 无typed result payload与`exit.*` source |

同一source跨phasealias/doc差异是正常事实；但同一chain source的不同fallback类型也因无target expectation而不可比较。结构JSON存储能力不能冒充结构型公共语言或render contract。证据：R7-05 A1–A3、B1–B8、B11。

## B3. 复杂因果与触发条件

### B3.1 Cache时间语义不是finding口径

daemon path cache决定“哪个compile发生”，finding contract决定“发生后的结果如何消费”。两者不可合并：

- cold-load有callback/event，cache-hit没有新finding；
- 成功cache不随源变化而失效；
- direct status/doctor读取当前源，与daemon cached model可能不同；
- cold caller的chain获得event归属，复用同一model的其他chain可能没有event；
- failure会删cache并允许下次重编译，因此错误finding可重复出现。

若裁决只写“doctor显示compile warnings”，仍未决定它显示当前源、daemon cached compile还是历史event，也未决定属于target、chain还是compile identity。

### B3.2 Schema存在不修复projection失真

schema artifact只能描述其输入shape。当前projection把所有variable写成string且删除大部分binding证据，所以：

- 为现有projection生成schema只能稳定描述当前失真；
- 扩充canonical model但不改projector，外部consumer仍不可见；
- 让consumer import ArkType boundary可验证instance，却不满足零source import；
- `schemaVersion:1`只标记instance shape，不能证明artifact discovery、producer binary关联或兼容政策。

### B3.3 Generic JSON能力不是ValueType合同

存储可保真recursive JSON，renderer却只接受scalar；item四词没有约束存储值；`json`也不选择canonical text projection。因而“系统已经支持JSON”至少混合了三件不同事实：存储值域、公共类型语言、prompt文本投影。裁决必须分别说明，否则nested JSON会继续到render才失败，null/missing/empty仍不可区分。

### B3.4 External owner缺席不是合同自由

当前没有真实独立consumer，意味着版本/cache/unknown variant行为不可观测，而不是这些问题无需定义。反过来，也不能凭未来GUI/hook文字决定artifact载体或语言，因为owner、技术栈、网络面尚未确定。可以把首个consumer留待另查，但不能把“已知owner无consumer”写成“全系统无consumer”。

### B3.5 Agent result与控制面不可混同

runner日志、exit code、item status和chain action已存在，但都不承载typed path payload。若D2继续要求`exit.*`：

- 必须明确它是agent构造的数据对象，而非stdout解析或status/action别名；
- owner必须能区分agent-owned和external authoritative binding；
- typed parse失败必须有明确状态，不能伪造前驱结果或坍缩为空串。

是否保留此稳定要求不属于本档案的自由选项；本档案只要求操作员裁决其首批合同边界或保持未知另查。

## B4. Finding合同的事实支持形态

以下四种形态来自R7-01 B6，不排序：

| 形态 | 定义 | 确定后果 | 仍未知/具体触点 |
|---|---|---|---|
| F1 compile-result唯一finding权威；doctor保持runtime health consumer | CLI/compile API解释current compile；daemon event只作观测 | 单次结果边界清楚；doctor不显示成功warning | rejected前序warning是否保留；daemon event正式地位 |
| F2 status/doctor重新compile当前源并消费findings | operator读面以调用时磁盘为准 | 可见当前源warning；可能与daemon cached behavior不同 | per-item failure结构；是否重复compile；归属target/chain |
| F3 status/doctor读取daemon persisted validation events | operator读面以cold-load历史为准 | 复用结构化payload；cache-hit chain可能无event，写失败可缺失 | durability、replay、去重、compile identity、source变更失效 |
| F4 保持当前hybrid | CLI generic、daemon structured event、doctor仅load failure | 无新合同；多套字段/时间/归属/完整性继续并存 | 必须明确不得称为单一authority |

跨形态共同未决：

1. rejected compile是否只保留errors，还是也保留verdict前warnings；
2. authority按compile identity、preset path、target还是chain归属；
3. cache-hit是否重放；
4. event持久化是否是审计事实还是best-effort observability；
5. doctor的“健康”是否包含定义warning。

这些不是口径同义词：一旦要求replay、durability、identity关联或跨读面一致，便产生工程触点。证据触点见R7-01 B1–B4、B8。

## B5. Projection/schema分发的事实支持形态

以下五种形态来自R7-04 B9，不排序：

| 形态 | 当前事实基础 | 确定后果 | 未知/触点 |
|---|---|---|---|
| S1 仅projection instance作外部输入 | code CLI已存在 | consumer手写或猜shape；不能从instance派生完整类型 | installed producer缺失；compat无法验证 |
| S2 consumer import ArkType source boundary | 同仓test如此 | 与private repo/source commit耦合；不满足零source import | 外部语言、package边界、版本同步 |
| S3 独立版本化schema artifact | 当前无producer | 可形成零source-import合同的载体类别 | CLI/文件/package载体、生成器、发现/cache/compat均未裁决 |
| S4 未来API同时提供projection/schema | GUI/ingress仅有文档意向 | 可把discovery/version放到网络合同 | 当前无网络面、owner或consumer运行事实 |
| S5 typed bindings文件作为第二公共面 | 仅原型/文字有名称 | 能把实例值与compile metadata分开 | writer/reader、shape、owner、版本和失败全未知 |

必须保持的独立边界：

- “instance还是schema”是合同性质问题；
- “schema通过何种载体分发”是工程分叉；
- “哪个installed producer承担版本身份”是部署/发布分叉；
- “第一个真实consumer是谁”是owner事实；
- “typed bindings是否是第二公共面”不能由schema分发自动推出。

证据触点见R7-04 B1–B6、B8–B10。

## B6. Binding类型合同的事实支持形态与约束

R7-05没有把候选实现收敛成互斥菜单；它给出以下必须逐项裁决的合同轴。每一轴都列出事实允许的形态与确定后果，不把组合预设为完备方案。

### B6.1 类型权威覆盖面

| 形态 | 确定后果 |
|---|---|
| 只让item四词继续作声明 | chain/runtime/agent-owned仍各自无共同权威；same-source跨通道不可比较 |
| 建立覆盖item/chain/runtime的共同source type evidence | 可比较source与fallback；仍不自动产生agent-owned result |
| 在上项外纳入`exit.*` agent-owned path | D2数据边可表达；必须区分日志/控制面并定义owner/parse failure |

稳定D2要求的终态覆盖item/chain/runtime与agent-owned path；这里的裁决是首批合同边界与未知是否另查，而不是允许悄然删去稳定要求。

### B6.2 ValueType闭集

| 形态 | 确定后果 |
|---|---|
| scalar-only公开类型 | 与当前renderer能力接近；无法满足稳定的递归结构公开消费 |
| 四型加递归array/record/union等封闭ADT | 能表达稳定要求；需要明确每个variant的instance/schema/text projection |
| 把generic `json`当不透明逃生舱 | 延续存储与render分裂；consumer仍需猜shape，违背封闭可派生目标 |

首批variant、nullable表示和union/record细节尚未由三报告决定；可逐项保持未知，但不能把ArkType expression当公共语言。

### B6.3 Missing、null、empty与default

| 形态 | 确定后果 |
|---|---|
| 延续null/missing→`""` | 三种状态不可区分；静默降级继续 |
| required/default显式，nullable另作type证据 | 最早可决定失败可归因；需要migration/历史值解释 |
| 允许每使用点局部fallback而无source兼容检查 | 同source跨phase可异型；source不再是唯一类型权威 |

稳定D2已要求required/default与最早拒绝；操作员仍需裁决nullable如何表达、历史空串如何解释以及fallback是否必须与source evidence兼容。

### B6.4 结构值的prompt projection

| 形态 | 确定后果 |
|---|---|
| 结构值不可绑定prompt | 公共类型可有结构，但prompt binding必须在compile/create拒绝 |
| 结构值有显式canonical text projection | nested值可进入prompt；projection规则成为公共可消费事实 |
| 延续运行时`String`/throw或从`json`猜 | 失败推迟且跨语言不稳定；不满足真实化公共合同 |

三报告不决定canonical格式，也不决定所有结构variant都必须可渲染。

### B6.5 Same-source、alias与doc

- 同source跨phase的binding key重命名与doc差异是现存正常形态，不应自动视为type冲突。
- target expectation若存在，必须能回指同一个source evidence，才能检测真正的冲突。
- doc product/renderer是可保留资产；类型变化不能恢复按业务key特判。

此轴的工程分叉是“如何保存source identity及expectation”；纯口径是“alias/doc是否属于type identity”。R7-05事实支持把它们分开。

### B6.6 Agent-owned result

| 形态 | 确定后果 |
|---|---|
| 不提供typed result对象 | 现有status/action控制面继续；稳定P-D2-6/7仍未交付 |
| 将stdout或日志解释为result | 与现有不消费stdout的事实冲突；混淆日志和权威数据 |
| 独立`exit.*`对象沿同一类型流 | 可表达path-specific值与owner；必须定义CLI构造、准入、持久化、后继失败状态与防覆盖 |

该轴不能由finding authority、schema artifact或generic storage单独解决。

## B7. 组合后仍必须保持的边界

无论操作员如何组合F/S/B形态，以下等同关系均不成立：

1. compile CLI有instance ≠ 外部有schema；
2. ArkType boundary可round-trip ≠ 独立consumer零source import；
3. `schemaVersion:1` ≠ schema artifact版本、producer binary identity或compat政策；
4. daemon event有structured finding ≠ finding durable/complete/per-chain；
5. doctor重新load ≠ doctor观察daemon实际cached定义；
6. storage支持recursive JSON ≠ ValueType、schema与renderer支持结构；
7. item四词存在 ≠ source schema是全通道唯一权威；
8. public projection有`type:"string"` ≠ 真实type证据；
9. runner stdout/status/action ≠ agent-owned typed result；
10. 已核验owner无consumer ≠ 全系统无consumer。

## B8. 纯口径选择与工程分叉

### B8.1 纯口径选择

- “finding authority”专指单次`CompileResult`、daemon validation history，还是允许多个明确命名的读面；
- doctor是runtime health、definition health或二者分节；
- “schema”是否保留给可派生artifact，不再称projection instance/runtime boundary为schema；
- alias、doc decoration是否排除于type identity；
- daemon event是审计事实还是best-effort observability。

口径一旦声称跨时间/消费者一致，就不再是纯命名，必须由对应保证支撑。

### B8.2 工程分叉

- current-source compile、daemon-cache snapshot或persisted event作为doctor输入；
- rejected warning集合、cache-hit replay、event durability/identity/去重；
- schema artifact的生成、分发、发现、版本、cache与unknown-shape失败；
- installed app/code producer身份与artifact关联；
- 第一个独立consumer及其语言/owner；
- ValueType闭集、source schema贯穿、fallback兼容检查；
- required/default/nullable与历史空串解释；
- recursive structure的canonical text projection；
- `exit.*`对象的CLI、owner、持久化、准入与后继失败状态。

## B9. 外部owner与未知边界

| owner/面 | 已知事实 | 决策限制 |
|---|---|---|
| `mouriya-s-lab/coder-loop` code | 有instance producer与private boundary | 不是稳定installed外部面 |
| app-installed coder-loop | 基线时没有`preset`命令 | 不能作为当前producer证据 |
| RFC-5 GUI | owner/repo/API未定，无consumer | 不得据此选载体或语言 |
| RFC-4 hook | runtime不存在 | 不得冒充现有consumer |
| `github-hapi-agent-router` | 自有Zod/HAPI路径 | 不是coder-loop contract consumer |
| `hapi` | 无该消费 | 只对已核验checkout成立 |
| `hapi-remote-session` | 无本地checkout | 保持未知/另查 |
| typed `bindings.json` | 无writer/reader | 名称不是公共合同证据 |

如操作员需要以某个外部owner的约束裁决artifact载体，应先选择“另查该owner”，而不是让本档案猜测。

## B10. 需要操作员逐项裁决的问题

每题均可回答“保持未知/另查”；括号中说明性质。

1. **Finding权威：** 单次`CompileResult`是否是唯一规范finding集合，daemon events只作观测；还是允许另一个明确命名的持久validation权威？（口径；若选持久权威则进入工程分叉）
2. **Doctor时间面：** doctor的definition健康应观察调用时当前源、daemon实际cached compile、persisted validation history，还是保持纯runtime health且不展示成功warning？（工程分叉）
3. **Rejected集合：** compile失败时，verdict前已产生的warnings是否属于规范结果；若属于，是否要求所有消费者保真？（合同口径 + 工程分叉）
4. **Finding归属与durability：** findings按compile identity、preset path、target还是chain归属；cache-hit是否replay；daemon event是best-effort还是durable？（工程分叉）
5. **Schema合同：** 是否确认“schema”只指独立consumer可取得并派生类型的版本化artifact，而projection instance与ArkType boundary分别保持其他名称？（纯口径）
6. **Producer与首个consumer：** 哪个真实运行面承担schema producer identity，哪个独立owner作为首个消费证明；还是先保持未知并调查GUI/`hapi-remote-session`？（owner/工程分叉）
7. **公共面数量：** projection+schema是否构成唯一公共compile合同；typed `bindings.json`是否另立第二公共面，还是保持未知直到writer/reader owner落定？（工程边界）
8. **类型权威与ValueType：** 首批合同是否同时覆盖item/chain/runtime source，并保留后续`exit.*`同一语言；递归闭集首批包含哪些variant，哪些明确保持未知？（工程分叉）
9. **Missing/nullable/结构投影：** required/default、nullable、missing与空串如何区分；结构值是禁止prompt binding、要求显式canonical projection，还是该点另查？（工程分叉）
10. **Agent-owned数据边：** P-D2-6/7的`exit.*`是否在本轮固定为独立typed result对象并明确owner/失败状态，还是保持稳定要求但另派调查后再定具体合同？（工程分叉）

## B11. 裁决记录模板

| 问题 | 操作员裁决 | 保持未知/另查内容 | 不得误推的事项 |
|---|---|---|---|
| Q1 Finding权威 | 待裁决 | — | 不由现有hybrid自动推出 |
| Q2 Doctor时间面 | 待裁决 | — | doctor load不等于daemon cache |
| Q3 Rejected集合 | 待裁决 | — | callback集合不等于CompileResult |
| Q4 归属/durability | 待裁决 | — | event存在不等于durable |
| Q5 Schema口径 | 待裁决 | — | instance/boundary不冒充artifact |
| Q6 Producer/consumer | 待裁决 | — | 已知owner无consumer不外推 |
| Q7 公共面数量 | 待裁决 | — | bindings名称不等于实存合同 |
| Q8 ValueType覆盖 | 待裁决 | — | generic JSON不冒充类型语言 |
| Q9 Nullable/projection | 待裁决 | — | null/missing/empty不自动等价 |
| Q10 Agent-owned边 | 待裁决 | — | stdout/status/action不冒充result |

## B12. 证据索引

| 本档案主题 | 只读事实来源 |
|---|---|
| CompileResult、loadPreset损失、CLI/daemon/status/doctor消费者 | `13-r7-01-finding-authority.md` A1–A3、B1–B4 |
| Finding cache时间、归属、durability与四种形态 | `13-r7-01-finding-authority.md` B3、B6–B8 |
| Projection instance与ArkType boundary | `13-r7-04-schema-external-consumers.md` A1、B1 |
| code/app producer漂移 | `13-r7-04-schema-external-consumers.md` B2 |
| 外部owner、router/hapi、GUI/hook未知 | `13-r7-04-schema-external-consumers.md` B3–B4、B7、B10 |
| typed bindings无writer/reader | `13-r7-04-schema-external-consumers.md` B5 |
| schema版本/cache/失败空位与五种形态 | `13-r7-04-schema-external-consumers.md` B6、B8–B9 |
| 类型权威丢失链 | `13-r7-05-binding-type-authority.md` A1–A3、B1–B2 |
| bundled值域与实际storage/render边界 | `13-r7-05-binding-type-authority.md` B3–B5 |
| public projection消费者与失真 | `13-r7-05-binding-type-authority.md` B6 |
| agent result/exit数据边 | `13-r7-05-binding-type-authority.md` B7 |
| doc资产、测试同错与形态约束 | `13-r7-05-binding-type-authority.md` B8、B10–B13 |
| 稳定D1/D2条款 | `AGGREGATE-547.md` §2.1、§3 D1/D2 |

## 尾部结论

**G1 的决策对象不是一个“compile JSON格式”，而是三条必须独立闭合再对接的合同：finding在何种时间/归属/失败集合上权威，projection如何通过真实producer向独立consumer提供可派生schema，以及binding source evidence如何贯穿ValueType、required/default、结构projection和agent-owned result。当前hybrid、private ArkType boundary、`schemaVersion:1`、generic JSON存储、固定string projection及已知owner无consumer，均不能替代这些裁决。档案列出的十题允许保持未知/另查；操作员裁决前，不把任一形态写成推荐、规格或实现范围。**
