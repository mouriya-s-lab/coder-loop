# 从字符串调度到可恢复执行：设计为什么必然改变

> 本文是新文档的“为什么”材料，只解释因果、必要保证、机制边界和反例。事实输入来自当前聚合结论、供给深审、正式决策与供需图；不复述旧文档结构，不按 issue 或设计域编号组织，也不把目标合同写成已实现事实。

## 摘要

一个线性字符串调度器可以在很弱的假设下工作：阶段是一列名字，输入最终能变成字符串，进程能随时重读配置，runner退出后推进到下一项，外部工具和审批只被视为环境细节。只要执行短、定义不变、没有并发分支、没有恢复要求，这些假设彼此兼容。

递归任务、typed binding、tool/gate和resume并不是四个可以分别加按钮的功能。它们同时打破上述假设，并暴露出三个不可避免的问题：

1. **权威分裂**：声明、投影、持久状态、runner事实和外部事件都可能各自声称“这次执行是什么、完成了什么”。
2. **时间漂移**：创建时、运行时、恢复时看到的定义、能力和输入不再天然相同。
3. **错误阶段错位**：本可在装载或创建前决定的错误，被拖到render、spawn、外部副作用甚至恢复时才爆发。

所以核心任务不是给旧字符串管线增加更多字段，而是建立一条单一authority链：定义先被编译和固定，输入在副作用前被解释，运行实例一次完整构造，调度只消费持久 readiness 和 typed transition，工具与gate的结论各由自己的journal提供，恢复按同一身份重放或hold。局部资产可以复用，但局部补丁不能替代这条链。

## 一、字符串模型成立所依赖的隐含前提

线性字符串调度的最小模型大致是：读取当前配置，找到当前阶段，渲染字符串，启动runner，观察退出，再写下一个阶段。这个模型隐含了五个前提：

- 阶段的位置就是身份；移动或插入阶段不会影响已存在实例。
- 所有值最终都能无损地降为字符串；missing、null、false、0和空字符串不需要区分。
- 当前配置就是实例应执行的配置；重启时重读文件不会改变历史语义。
- runner退出足以表示业务完成；不存在需要独立判断的工具结果、审批结论或join条件。
- 每一步的写入和副作用足够接近，崩溃后可以根据最后几个字段猜回正确状态。

当前供给调查已经显示，这些前提在简单路径上能形成一个自洽系统，却不能自然扩展：已有真实source hash但没有可按hash恢复的内容；已有runtime tree表和外键但生产scheduler仍按阶段数组推进；已有hook声明carrier但没有runtime executor或decision journal；已有JSON安全存储但类型只在render末端暴露；已有状态和事件但run结束、item推进、closure更新分属多个写入。

这些不是“代码还差一点”的同一种缺口。它们说明旧模型的身份、时间和完成语义本身不够表达新问题。

## 二、递归任务为什么迫使身份与推进权威分离

线性列表里，“第几个阶段”既可做显示位置，也常被当成推进依据。递归结构加入seq、par、join和reopen后，位置不再稳定：同一个节点可以被移动到另一个父节点，多个分支可以同时ready，join是否成立取决于一组持久事实，而不是“数组下一个元素”。

因此必须分开三件事：定义身份回答“声明中的哪个节点”；运行身份回答“这个实例中的哪一次节点实体”；转移身份回答“哪一次合法提交改变了业务图”。

如果仍以路径或索引做身份，移动节点会同时看起来像删除旧任务和创建新任务；如果只把递归树写进数据库却让scheduler继续读线性数组，status展示的树和真正的推进决定可以彼此漂移；如果runner exit直接推进，join、gate和typed exit就只能在推进之后补救。

这也是为什么“有树表”不是“有递归调度”。真正必要的保证是：定义图先通过结构检查，实例创建时完整物化运行图，readiness是持久事实，只有typed transition能推进它。使用referenced node table、稳定node id、CAS claim或具体SQL表形，都是实现这组保证的工程选择；需求本身是位置无关身份、完整实例和单一推进authority。

## 三、typed binding为什么不能在render时补验证

字符串世界会把输入缺失写成空串，把数字、布尔和结构值在最后一刻插进prompt。这在typed binding中立即产生语义碰撞：missing不是null；null不是空字符串；false和0不是“没有值”；default只能补missing，不能覆盖显式null或类型错误；agent-owned exit不能覆盖chain、item或runtime拥有的输入；record和array的错误必须指出嵌套路径，而不是render时抛一个泛化异常。

一旦值跨越create、storage、resume、render和transition边界，晚验证就已经太迟。错误值可能先被持久化、触发资源创建，或在重启后用另一套转换规则重新解释。正确因果顺序只能是：source schema定义类型authority，外部raw值先以unknown进入boundary，admission产生精确typed value或structured failure，持久层保存值连同source/owner/definition identity，所有consumer只读admitted value。

canonical scalar文本和canonical JSON解决的是“同一个typed value如何得到确定字节”；doc renderer解决的是“这些字节如何按声明进入文档布局”。两者必须分域。否则每个renderer都会重新解释类型，或者类型层会开始拥有Markdown/block/fence布局，形成新的双authority。

递归ValueType的最小闭集、closed record、canonical JSON和CAS replacement是已经选定的机制合同。它们服务的必要保证是：值在进入副作用前只有一种解释，更新不能丢失并发修改，resume不能把相同持久值渲染成另一种意义。

## 四、tool和gate为什么不是“执行一个脚本”

工具与gate都可能调用外部逻辑，但它们回答不同问题。工具回答“某个run要求的结果是否已经取得”，至少包含provider存在、当前可用、发生调用、能够确定outcome四个正交维度。看到一次命令、context entry或事件，并不证明required结果已达成。

gate回答“某个具体lifecycle host在这个epoch能否继续”。同名gate挂在pre-spawn、post-exit、container join或chain complete，必须绑定不同的stable host。一个声明carrier或字符串point无法证明executor存在，也无法在restart后定位原来的decision。

所以二者不能共用一个“hook成功”字段。ToolOutcome和GateEvaluation需要不同identity、不同journal和不同消费点；业务transition只引用已经决定的domain ref，不复制它们的判断字段。event只是观察投影，不能成为完成authority。

required和optional也不能被解释为“有能力就执行，没有就算了”。optional只允许缺少named binding时skip；它不允许缺runtime executor，更不允许吞掉已经选择的executor failure。否则声明看起来启用了gate，运行时却静默绕过，系统无法区分“批准”与“从未判断”。

capability handshake的必要性来自这里：定义可以描述未来能力，但instance create和resume必须核对当前runtime是否真的advertise所需协议、point、decision和journal版本。缺能力的新实例应在业务写入前拒绝；既有pinned实例应hold。具体executor走进程、函数、RPC还是其他transport，不是需求事实，不能由合同凭空规定。

## 五、resume为什么把“当前配置”变成错误authority

没有resume时，重读当前文件常被误认为无害；有resume后，实例跨越了定义版本的时间边界。假设实例创建时使用H1，运行中配置被改为H2：status仍显示H1 ref而prompt从H2重渲染，会造成可观测身份与行为分裂；H2删除当前节点时，失败可能在资源创建后发生；H2保留同名节点但改变rights、prompt或status vocabulary时，漂移可能完全静默；同进程cache还可能暂时冻结H1，daemon重启后才读取H2，使行为依赖重启时机。

hash本身不能解决问题。hash只证明“某些bytes有一个identity”；如果内容、manifest和assets没有被保存并可按ref验证读取，resume仍只能回到当前路径。ref、外键和status归因同样不够，除非所有instance consumer都通过shared resolver读取同一immutable bundle。

因此需求必需的是：current读面只服务新候选和诊断，pinned读面只服务既有实例；创建前发布完整不可变定义；实例原子写入exact ref；resume、scheduler、render、authorization和status都走同一个resolver；missing/corrupt ref只能hold，不能fallback current。

content-addressed bundle、staging重读验证、atomic rename、ref-aware GC和bounded cache是工程机制。它们不是目的，但共同实现“同一ref在任意时间只解释为同一完整内容”。历史pre-ref实例没有证据恢复原定义，诚实行为只能是legacy-definition-unproven hold；repository值、run marker或相似current preset都不能补造历史事实。

## 六、为什么事务边界必须按可见业务状态设计

当编译、binding、runtime tree、gate和side effect汇合，旧式“每个store方法各自事务化”仍会留下业务半状态：row已写但ref缺失，run结束但readiness未推进，transition已提交但outbox未写，gate hold后worktree已经创建，或外部调用结果未知却被自动重放。

必要的边界有三类：

1. **实例可见性边界**：publish完成后，先纯计算binding/runtime/capability plans，再用一个业务事务写owner row、refs、admitted bindings、完整runtime图、initial readiness和outbox rows。scheduler只能在commit后看见实例。
2. **调度副作用边界**：先原子claim并分配stable RunIntent/RunId，再完成gate evaluation。hold要从claimed转为held、释放capacity且保留同一identity；只有advance后才建worktree、closure或process。
3. **业务推进边界**：typed transition和其引用的domain decision consumption同事务提交；外部effects用intent、receipt和effect ledger恢复；outbox只负责commit后的事件交付。

这里的需求不是“所有事情都塞进一个大事务”，而是每个外部观察者永远看不到不合法的中间业务状态。BEGIN IMMEDIATE、transactional outbox、idempotency key和effect ledger是当前选定机制。对于跨系统副作用，exactly-once通常不可保证；能保证的是不把unknown当success、不无证据重放，并将unknown持久hold到可裁决。

## 七、为什么通用引擎必须去除GitHub和默认preset原语

项目无关引擎如果把repository当chain identity、把owner/repo#id当item语法、把某个preset当隐式default，会在新类型链和resume链中形成隐藏authority：CLI、wire、SQLite列、status和git inference可能各自决定“这是哪个目标”。

repository可以是业务输入，但只有明确需要remote operation的adapter应读取它。local worktree、closure resource和reconciliation有自己的chain/item/baseBranch事实，不应因repository缺失而失败，也不应从git remote反推。类似地，item必须显式pin自己的definition；chain declaration、current preset和default name不能替代。

这不是为了追求抽象纯洁，而是为了消除同一值的两条写读链。保留物理repository列并同时加入typed binding，会让migration、update和status产生冲突优先级；保留default preset会让empty chain、mixed chain和restart得到不同代表定义。单一breaking checkpoint和owner allowlist是清除旧producer的工程机制；必要保证是engine identity opaque、业务binding typed、definition选择显式。

## 八、为什么局部补丁必然失败

| 局部补丁 | 为什么不够 |
|---|---|
| 给DTO增加tools、gates或tree字段 | 没有canonical producer/runtime consumer时，字段只会永远为空或被静默丢弃 |
| 给definition表增加hash/ref | 没有完整内容与resolver时，ref只能归因，不能控制resume行为 |
| 把runtime tree写进SQLite | scheduler若仍读phase数组和item.status，tree只是旁观projection |
| 在render前加几个类型检查 | create/storage已经接受坏值，missing/null/default和resume语义仍分裂 |
| 把hook carrier直接叫gate | carrier没有typed host、capability、decision journal或recovery epoch |
| runner退出时顺手更新更多字段 | 多次写入仍有crash窗口，且runner exit不等于tool/gate/join业务结论 |
| 失败时重读current或重新执行 | 定义和外部effect可能已经变化，重试会制造新事实而不是恢复旧事实 |
| repository缺失时从git推断 | local与remote authority重新合并，行为依赖机器环境 |
| par未实现时顺序执行 | 改变用户声明的并发/join语义，成功结果不再是同一程序 |
| optional gate无executor时跳过 | 把“未评估”伪装成“允许”，破坏审计与恢复 |

共同问题是：补丁修复了一个读面，却没有规定谁写、谁拥有identity、何时可见、失败后如何恢复。跨阶段系统必须先闭合这四个问题，才谈得上局部实现。

## 九、需求必需与工程机制的分界

### 必需的产品保证

- 每类事实只有一个authority，其他读面只能派生。
- identity跨compile、create、run、transition和recovery稳定，且不同domain不混用裸hash/string。
- existing instance消费创建时pinned definition，不受current源改变影响。
- raw输入在最早拥有完整schema的边界解析；missing/null/default/owner语义不可后移。
- runtime instance在scheduler可见前完整构造；业务推进只来自typed transition。
- tool outcome、gate decision、business transition、external effect和event delivery分属不同authority。
- capability缺失、unsupported语义、corrupt ref和unknown effect必须显式reject/hold，不能fallback或inert。
- engine identity与local资源不依赖GitHub/repository格式或隐式default preset。
- restart从持久事实恢复，不从current、进程残影或事件猜测。

### 可替换的工程机制

- referenced node table是实现稳定图identity的选定语法，不代表所有系统都必须使用TOML表。
- content-addressed directory、manifest、atomic rename是immutable bundle的实现方案；其他具同等完整性与原子性的store也可满足保证。
- SQLite BEGIN IMMEDIATE是当前事务机制；必要的是业务原子可见性，而非特定数据库关键字。
- transactional outbox、effect ledger和CAS是当前恢复机制；可替换方案必须保留相同authority和crash语义。
- canonical JSON inline是冻结的默认投影；显式renderer仍可选择block/fenced，但不能启发式切换。
- LRU cache、具体表结构、executor transport和部署顺序不是产品需求，不应从证明缺口反推。

## 十、反例与边界

- **同名不等于同一任务。** 移动node但保留stable id，语义上仍是同一实体；原位置新建同名新id，不应继承旧runtime状态。
- **存在值不等于字符串truthy。** false、0、null、空字符串和missing必须得到不同admission结果。
- **调用发生不等于结果达成。** 工具命令被启动但缺durable evidence或finalize evaluation，required outcome仍未满足。
- **optional不等于无executor也放行。** optional gate缺named binding可skip；整个capability不存在时，新实例必须reject，旧实例必须hold。
- **显示旧ref不等于执行旧定义。** status携H1 ref但resume从current加载H2，归因连续不能证明行为被pin。
- **repository缺失不应阻断本地恢复。** local worktree已有chain/item/baseBranch和资源事实；缺repository只应阻断明确remote operation。
- **崩溃后的“看起来完成”不等于transition。** run记录结束而transition未commit时，startup不能只看exit code推进。

明确边界：不从无证据历史行恢复原definition；不承诺外部effect exactly-once，只承诺unknown可见且不自动冒险重放；不把独立schema consumer、tool outcome runtime、gate evaluator、scripted join consumer或non-degenerate par写成已实现；不要求一次实现全部未来能力；不扩展ValueType、join算法、executor transport、样式语言或产品规模；不以更多文档替代真实create、spawn、transition、restart和跨owner验证。

## 尾结论

**字符串调度器扩展到递归任务、typed binding、tool/gate与resume后，真正不可避免的变化不是字段数量，而是authority、identity、时间和事务边界必须显式化。递归结构要求位置无关身份与typed transition；typed value要求admission早于持久化和render；tool/gate要求独立decision journal与真实capability；resume要求immutable pin和shared resolver；副作用要求原子可见状态、hold与可恢复effect。局部补丁只能修一个读面，无法阻止其余读写链继续产生漂移。产品需求因此聚焦单一authority、稳定identity、最早失败、诚实unsupported/hold与持久恢复；具体语法、数据库、cache、outbox和transport只是满足这些保证的工程机制。**
