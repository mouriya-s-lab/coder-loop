# RFC #544 长篇文档结构设计

> 本文件只设计最终文档的论证结构、叙事顺序与审查方法，不代写正文。最终文档不得沿用SYNTH/AGG的交付物编号顺序，也不得把现有报告压缩后首尾拼接。

## 1. 文档使命与原创叙事主线

### 1.1 使命

最终文档要让一位没有参与调查的维护者回答四个问题：

1. 操作员打开GUI时，看到的每个事实从哪里来，为什么可信？
2. daemon活着、停机、崩溃、数据轮转或请求失败时，系统如何保持可解释？
3. 浏览、诊断与控制为什么必须共享类型和身份，却不能共享错误的全局时点或权限推断？
4. 哪些保证已经固定，哪些只是实现选择，哪些只等待运行证据？

它不是功能清单、issue索引、调查日志或实现方案。篇幅必须用于展开因果链、运行故事、所有权和反例，而不是重复同一句结论。

### 1.2 原创主线：一次值班事件的证据旅程

采用“操作员在daemon异常后进入系统，逐步从观察走到行动”的时间顺序，而不是D1–D14或CAP-1–CAP-7顺序：

```mermaid
flowchart LR
    A[进入网关] --> B[确认观察面仍活着]
    B --> C[分辨daemon与网络状态]
    C --> D[读取持久运行态]
    D --> E[追溯事件与任务树]
    E --> F[定位具体attempt与定义]
    F --> G[判断是否有合法控制能力]
    G --> H[执行最小动作]
    H --> I[用status与events核验结果]
    I --> J[在移动端与关闭证据中复现]
```

每章都从这个故事中的一个认知转折开始：操作员当前知道什么、还不知道什么、下一份证据为什么能缩小不确定性。技术机制只在解释该转折所必需时出现。

### 1.3 正文的固定论证单元

每章至少包含以下五种内容，缺一不可：

- **因果问题**：什么现状会让操作员得出错误结论，错误如何沿消费者传播。
- **运行故事**：一个正常路径和至少一个失败路径，从入口走到最终可观察结果。
- **设计边界**：谁拥有事实、shape、读取、展示和动作；谁明确不拥有。
- **失败场景**：触发条件、可见结果、恢复边界；不以“显式报错”一句带过。
- **验证证据**：必须运行什么、观察什么终态、什么证据不能替代。

章节不能只列性质、验收表或“当前/目标”对照。

## 2. 建议的长篇结构

## 第一部：观察者为什么必须独立于被观察者

### 第1章：值班入口——先证明GUI本身仍然活着

**核心问题**：daemon死亡时，为什么页面、静态资产和读取路径仍能工作；为什么“页面打不开”和“daemon死了”是两个故障域。

**必须展开的论点**：

- 网关与daemon的进程生命周期为何分离。
- 单一root、明确listener和同一静态/API宿主如何限定观察范围。
- localhost、mesh与LAN/public的边界是运行事实，不是抽象安全口号。
- 页面可达、status可读、socket不可达三者如何形成不同诊断结果。

**运行故事**：

- 正常启动后本机与mesh设备访问同一应用。
- daemon被终止但网关继续服务静态页和持久状态。
- 网关不可达时浏览器连接失败，不得被页面逻辑伪装成daemon状态。

**设计边界**：网关拥有HTTP宿主和明确监听；不拥有SQLite、daemon进程监管或新的认证体系。

**失败场景**：部分listener启动、root被请求参数替换、wildcard fallback、网关退出连带daemon。

**验证证据**：真实PID/listener、生产HTTP响应、LAN拒达、mesh可达、停止后资源回收。不得以单一health curl或开发server代替。

### 第2章：观察不能改变现场——严格读取的信任起点

**核心问题**：如果读取会修改WAL、schema或sidecar，为什么所有后续GUI结论都失去证据资格。

**必须展开的论点**：

- 读取副作用如何把“观察到的状态”与“读取造成的状态”混在一起。
- schema不可消费、缺盘、权限与损坏为何必须是不同typed结果。
- live WAL与daemon-down分别需要怎样的中立性证据。
- 单次read snapshot为何只覆盖SQLite持久槽，不扩成跨介质全局时点。

**运行故事**：读取前记录盘面，执行status，读取后逐项对比；并发writer在中间提交时结果只能属于完整旧态或新态。

**设计边界**：reader拥有严格读取和错误；writer继续拥有migration；events/process证据保持独立采样。

**失败场景**：读取触发migration、helper顺序改变错误类型、跨commit拼出从未存在的树、以文件权限失败冒充只读实现。

**验证证据**：bytes/metadata/schema对比、并发barrier、旧/未来schema负例。类型检查与静态SELECT审查不足以证明。

## 第二部：从原始证据到可依赖契约

### 第3章：公共事实的最后一公里——最终wire而非内部对象

**核心问题**：为什么内部对象通过校验后仍可能在序列化阶段变成另一种未经验证的公共shape。

**必须展开的论点**：

- canonical public wire如何形成。
- CLI JSON与HTTP响应为何必须通过同一engine-owned boundary。
- 顶层、槽、variant、optional/nullability的精确性分别防什么错误。
- taskTree和未来CAP-4字段怎样组合进同一boundary而不转移领域所有权。

**运行故事**：一个合法snapshot从持久事实到CLI和HTTP；一个错tag、额外字段或序列化后改写如何被拒绝。

**设计边界**：boundary拥有公共shape；CAP producer拥有字段语义；gateway/frontend只派生类型。

**失败场景**：平行DTO、assert后flatten、宽object、default吞新variant、artifact正文被塞入status。

**验证证据**：最终CLI/HTTP逐字段对照、负例parse、shape diff、编译期穷尽。不得复活domain-vs-wire选项讨论。

### 第4章：时间不是一个——status、process与events如何并列

**核心问题**：一个页面同时展示当前持久态、活性探测和事件历史时，怎样避免伪造“同一瞬间”。

**必须展开的论点**：

- SQLite snapshot、pid/socket/RPC三证和events各自的采样时间。
- 三证分裂态为何比单boolean更有诊断价值。
- 最近转移、最后事件和当前状态如何并列而不建立全局顺序。
- daemon-down时哪些证据仍可取得。

**运行故事**：进程活但socket死；socket可连但RPC失败；daemon停止后SQLite和events仍可读。

**设计边界**：status保存持久事实，liveness保存探测，events保存过程；UI负责并列与解释，不合成不存在的原子观测。

**失败场景**：一证覆盖三证、网络失败被标为daemon死、跨流timestamp排序被宣传为因果序。

**验证证据**：人工构造所有关键分裂态、记录各证采样值和UI结果。

## 第三部：历史如何连续，而不被夸大成永久日志

### 第5章：事件流的两种任务——回看与跟随

**核心问题**：历史查询和实时跟随为什么共享event契约，却需要不同的读取状态。

**必须展开的论点**：

- active/history segment发现、排序和精确parse。
- writer所有权与normal day/size rotation如何为reader提供前提。
- active byte offset为什么是内部continuity状态，不是公共cursor。
- filter如何只使用typed envelope关联键。

**运行故事**：reader追随active追加，恰逢rotation，消费完旧段后进入新active；daemon随后停止但历史查询继续。

**设计边界**：event producer拥有ADT和normal publication；reader拥有offset/filter；UI只消费结果。

**失败场景**：用结果条数当offset、watch通知合并导致漏读、多writer重复sequence、坏行击穿全部历史。

**验证证据**：writer overlap、day/size rotation、reader交错、真实历史bad/partial样本。

### 第6章：连接活着不等于订阅永远存在

**核心问题**：SSE连接、daemon生命周期与浏览器生命周期怎样独立收口。

**必须展开的论点**：

- 已建立连接为何不依赖daemon存活。
- client abort为何必须清理watch/reader/interval/订阅。
- 网关restart后新连接从历史重新建立，而不是恢复旧subscription。
- 最后事件、死因线索、崩溃记录和具名异常怎样保留来源。

**运行故事**：浏览器连接→事件推送→daemon kill→历史仍读→浏览器强断→网关继续健康。

**设计边界**：D6拥有已连接continuity和资源生命周期；不拥有断线replay、持久cursor或crash journal。

**失败场景**：closed controller继续enqueue杀死进程；将fallback并入统一历史；用same-ts宣称因果顺序。

**验证证据**：真实Bun SSE、强断client、daemon kill、health与新连接；不得以mock stream代替。

## 第四部：身份把运行故事串起来

### 第7章：从daemon钻到attempt——两条结构轴不能混合

**核心问题**：执行层级和任务树结构为何必须交叉导航，却不能互相推断。

**必须展开的论点**：

- daemon→chain→item→run→phase/attempt的typed identity与父子关系。
- CAP-1 leaf/seq/par、join、reopen、closure状态的穷尽渲染。
- v2退化树为什么仍走同一union。
- canonical URL和wrong-parent/stale identity如何处理。

**运行故事**：从首屏逐层进入attempt；复制URL冷启动；打开v2线性chain；并发状态变化后遇到stale对象。

**设计边界**：status提供identity事实，CAP-1提供树shape，router提供定位，UI不生成第二树。

**失败场景**：slot复活、显示名/数组index充当identity、run列表反推tree、child跨parent误命中。

**验证证据**：完整钻取、冷启动URL、leaf/seq/par/v2 fixtures、穷尽编译检查。

### 第8章：事件与对象的双向索引

**核心问题**：如何从过程证据定位对象，又从对象查看相关过程，而不扫描/解释全部日志。

**必须展开的论点**：

- chain/item/runId/phase关联键的最窄定位规则。
- object→events必须调用typed filter而非前端自行扫描。
- unresolved target如何保留event证据。
- fallback证据缺少细粒度identity时为何只能链接到已知层级。

**运行故事**：从runId事件跳到run，再反查同run事件；对象已删除时event仍可读。

**设计边界**：events拥有关联键，D9拥有导航，不能由任何一方制造缺失identity。

**失败场景**：只按runId跨chain命中、坏链接丢弃event、展示排序冒充全局因果。

**验证证据**：多chain同名对象、不同关联键组合、deleted/unresolved target。

## 第五部：输入、定义与历史的不同时间语义

### 第9章：一次attempt到底使用了什么

**核心问题**：为什么definition identity、rendered prompt、bindings和runner实发值必须在同一attempt上闭合。

**必须展开的论点**：

- fresh、普通resume和finalizer特例的输入差异。
- prompt/bindings同源与artifact pair的present/failed/legacy语义。
- CAP-2 pinned definition在spawn/retry/restart中的解引用边界。
- CAP-3只提供scalar基线上的additive seam。

**运行故事**：attempt输入形成→artifact发布失败但runner继续→D10显示失败而非空白；历史attempt没有artifact时如实显示legacy。

**设计边界**：D2拥有artifact producer，CAP-2拥有definition可达，D10拥有展示；status不承载artifact正文。

**失败场景**：从stdout/argv重建、restart重读current preset、普通resume显示finalizer“继续”、猜typed binding字段。

**验证证据**：真实runner fresh/resume/finalizer、写失败、restart、逐字argv对照。

### 第10章：当前定义预览不是历史重演

**核心问题**：D11为什么只回答“当前选中preset会编译成什么”，不回答历史attempt当时使用什么。

**必须展开的论点**：

- current name-based输入与CLI共用compile路径。
- 单次refresh的多个视图来自同一个versioned artifact。
- stateGraph、phases/taskTree、variables/findings如何保持owner shape。
- unsupported schemaVersion的consumer拒绝。

**运行故事**：选择两个preset、查看三视图；源在两次refresh间变化；unsupported版本拒绝渲染。

**设计边界**：CAP-7拥有compiler/artifact，D11只消费；CAP-2不自动成为D11输入。

**失败场景**：historical-pinned复活、current+pinned双视图、按视图重复compile、GUI读源文件。

**验证证据**：GUI artifact与同次CLI逐块相等、单refresh identity一致、typed rejection。

## 第六部：从理解到行动，但不越过裁判

### 第11章：控制面只允许哪些动作

**核心问题**：为什么GUI写面必须恰为F档，并且gateway只转发、不裁决。

**必须展开的论点**：

- exact typed mutation façade与范围外command不可达。
- daemon start为何是gateway spawn，而stop/restart和四verb走socket。
- 既定operator主体与daemon唯一合法性裁判。
- accepted/rejected/failed和transport未确定结果的区别。

**运行故事**：daemon死态start；合法unblock；错误target reorder；handler失败；成功后status/events核验。

**设计边界**：D8拥有façade，daemon拥有合法性，domain拥有结果；gateway不重建认证或授权。

**失败场景**：裸socket、动态command、create入口、gateway预判authority、按钮成功替代终态核验。

**验证证据**：遍历所有可点写入口、负面不可构造检查、四动作真实执行。

### 第12章：operator decision为何不是resume的别名

**核心问题**：per-epoch decision如何保持identity、capability、domain effect和观测一致。

**必须展开的论点**：

- evaluation identity、binding version与decision ADT。
- capability查询与submit之间的currentness。
- decision storage/capability/epoch是工程形态，不写成需求选型。
- status/event/audit如何引用同一identity/operator/decision。

**运行故事**：有capability提交advance；无capability只显示缺口；stale epoch被拒；consumer执行后观察结果。

**设计边界**：CAP-4拥有domain，D8提供F接入，D3承载status，events承载过程；没有第二日志或授权系统。

**失败场景**：用resume/unblock/join修改冒充decision、UI自授、lifecycle`decided`冒充payload、要求durable operation平台。

**验证证据**：三decision真实domain路径、capable/none/stale、status/event/audit逐字段一致。

## 第七部：旁路信息与不同终端形态

### 第13章：context是原文，不是控制语言

**核心问题**：如何浏览context而不把body解释成系统指令或从内部store倒推外部合同。

**必须展开的论点**：

- operator socket typed read拓扑。
- item谱系、chain公告、group分支组三scope。
- envelope与opaque body。
- pagination/filter随CAP-6实际boundary。

**运行故事**：通过既有成功写入路径写三scope→socket read→浏览器对应视图；body包含Markdown和状态词仍原样。

**设计边界**：CAP-6拥有shape，D12拥有消费/UI；不拥有write recovery。

**失败场景**：gateway直读SQLite、猜cursor/group identity、解析body、把坏行/retention风险升级成合同。

**验证证据**：三scope全路径、类型来源检查、特殊body、实际pagination/filter。

### 第14章：手机不是第二套产品

**核心问题**：移动端怎样复用同一应用、数据与控制合同，同时满足PWA和首屏优先级。

**必须展开的论点**：

- NetBird监听与同一route graph。
- PWA installability/standalone与“不承诺离线控制”的边界。
- 首屏三证、active run、异常和动作的优先级。
- capability-gated control在移动端不改变权限语义。

**运行故事**：手机经mesh打开→安装→主屏standalone→查看首屏→执行动作→status/events核验。

**设计边界**：D13拥有响应式/PWA，复用D5/D7/D8/D9；不建mobile backend或认证。

**失败场景**：mobile-only API/client、LAN/public暴露、离线mutation、responsive层吞掉错误。

**验证证据**：真实NetBird手机、安装与standalone截图、监听审计、桌面回归。

## 第八部：怎样证明整套系统，而不是证明各自的mock

### 第15章：证据链、冻结SHA与失败回退

**核心问题**：哪些结果必须通过真实CLI、文件、socket、browser、mesh观察；为什么测试绿不能替代。

**必须展开的论点**：

- 每类保证对应的最强可行运行路径。
- D1–D13产品owner与D14证据owner的分离。
- frozen SHA、输入root/fixture、命令、环境、actual/expect的记录格式。
- #684整链路与#685compatibility的独立owner边界。

**运行故事**：在冻结SHA启动gateway、验证listeners/status/SSE/browser/mobile/control，某行失败后回到正确产品owner而非D14现场修。

**设计边界**：D14只汇总证据和文档；不更改产品、不降低expect、不接管其他验证owner。

**失败场景**：不同SHA证据拼接、mock替production route、单元测试替浏览器、遗漏失败环境、文档保留新旧矛盾层。

**验证证据**：关闭验证矩阵与可重跑命令；此章必须引用实际证据类型，不预写“全部通过”。

### 第16章：非目标、未知与下一步边界

**核心问题**：怎样让读者知道设计的强度停止在哪里。

**必须展开的论点**：

- U01–U15是运行输入，不是待补需求。
- 外部CAP shape未落定时如何保留typed seam。
- 禁止强化清单为何不是“以后可能顺手做”。
- 第一批滚动重拆为何只选择当前有证据的地基。

**运行故事**：实现者遇到bad history、CAP shape或transport风险时，如何判断是最小兼容、外部接口消费、定向实验还是新需求请求。

**设计边界**：文档弱化守不住的主张，不通过加机制保护未要求的保证。

**失败场景**：风险自动变需求、未知自动变blocker、验证纪律编译成产品机制、一次拆完整未来树。

**验证证据**：逐项追溯新增主张的稳定来源；无法追溯即删除或登记风险。

## 3. 每章写作模板

最终正文撰写者对每章使用以下模板，但不要保留模板标签造成机械感：

1. **开场场景**：用2–4段描述操作员当时看到什么、可能误判什么。
2. **因果链**：至少一张Mermaid图，展示producer、boundary、consumer及失败传播。
3. **正常运行故事**：按真实入口→边界→持久/网络副作用→用户结果叙述。
4. **失败故事**：至少一个反例，包含触发、传播、最终错误结论。
5. **所有权表**：事实owner、shape owner、transport owner、UI consumer、明确非owner。
6. **保证与停止线**：稳定保证、工程形态、运行未知、明确排除分开写。
7. **验证表**：命令/环境/实际观察/为何能证明；卫生测试单列。
8. **回扣主线**：说明本章减少了什么不确定性，下一章为何必要。

禁止每章重复同一大段“类型从boundary派生”“不新增需求”；首次完整解释，后续用具名原则引用并说明本章的具体应用。

## 4. 必须展开的跨章论点

以下论点不能只出现一句，需要在首次出现处完整论证，并在后续章节保持一致：

| 论点 | 首次完整展开章节 | 后续回扣 |
|---|---|---|
| 观察面与被观察进程分离 | 第1章 | 第4、6、14、15章 |
| 读取中立性是证据资格而非性能优化 | 第2章 | 第3、4、15章 |
| 最终wire是规范对象 | 第3章 | 第7、11、13、14章 |
| 多数据面没有全局时点 | 第4章 | 第5、6、8、12章 |
| identity比路径/名称/数组位置稳定 | 第7章 | 第8、9、12、13章 |
| producer/consumer所有权不可互换 | 第3章 | 第5、9–13章 |
| typed error不等于统一错误 | 第2章 | 第4、11、13章 |
| 可见结果不等于更强持久性机制 | 第5章 | 第6、9、11、12章 |
| 运行未知不生成需求 | 第2章首次提示，第16章系统收口 | 全文 |
| 证据owner不等于产品owner | 第15章 | 第16章 |

## 5. 禁止照抄的高风险段

最终文档不得从现有材料整段搬运以下内容；必须按新的因果位置重写：

1. **AGG“交付物清单层”D1–D14定义与验收表**：直接复制会让正文退化成编号目录，破坏运行故事。
2. **SYNTH中的多代issue/marker循环和时间线**：它们是溯源，不是设计论证；只在必要证据脚注使用。
3. **R7/R8旧C1–C5裁决包**：已被纠偏，任何二选一、六格membership或owner blocker措辞都不得进入正文。
4. **Decision档案中的候选形态全集**：最终文档只说明形态空间与约束，不能把候选表抄成指定实现或需求。
5. **expected-foundation F01–F30总表**：可作核对索引，不能成为正文30段逐项释义。
6. **demand报告的原子需求矩阵**：应融入运行故事和章节验证，不逐表复制155项。
7. **R11分类计数和R12issue草案body**：它们是规划产物，不能冒充系统设计正文。
8. **源码行号、实验命令流水账、agent调查过程**：只进入证据注释/附录，不占主叙事。
9. **旧架构中slot、parallel schema、historical D11、统一三流历史的描述**：即使作为反例，也必须明确标为禁止形态，不能留下可被误读的兼容层。
10. **“所有测试通过”“真实环境验证”之类无对象结论**：必须替换为具体入口、输入、环境和观察结果。

## 6. 容易误写成新需求的风险

| 调查风险/诱惑 | 正确写法 | 禁止写法 |
|---|---|---|
| live WAL配置未知 | 记录实现前最小实验与必须保持的中立性质 | 指定未经验证的SQLite flag为规范 |
| server资源风险 | 只写client deadline/cancel与现有交付边界 | 新增server caps、idle/handler deadline、connection quota |
| events历史shape演进 | 对真实不兼容样本做最小处理 | 预建schema-version/migration framework |
| rotation崩溃窗口 | 只保证normal writer/rotation | 新增crash journal、fsync、power-loss durability |
| SSE断线 | 保证已连接continuity和abort清理 | replay、`Last-Event-ID`、restart cursor |
| fallback物理分流 | 保证死因/异常可见且标来源 | 六格membership、统一三流全集、跨流因果序 |
| pinned definition回收 | 保证spawn/retry/restart期间可解引用 | TTL、永久保留或具体GC算法 |
| typed bindings未落定 | scalar基线+additive owner seam | 猜字段、union、复合值编码 |
| context写入风险 | 只消费成功持久化entry | partial restart、idempotency、outbox/ledger/staging、retention/auth六维合同 |
| mutation跨副作用窗口 | accepted/rejected/failed和status/events核验 | durable operation、query/replay、saga/log、known-outcome |
| operator来源 | 沿既定gateway operator与daemon裁判 | 重建peer/token认证或全面封store |
| CAP-4并发/currentness | 保持typed stale/conflict与domain owner | 指定CAS、sequencer或第二日志为需求 |
| 移动端网络 | 同一应用+NetBird明确listener | 新登录、SSO、public ingress或mobile backend |
| 验证纪律 | 写入证据表和owner回退 | 把“必须验证”变成产品持久机制 |

## 7. 术语统一方案

### 7.1 规范词表

| 统一术语 | 精确定义 | 禁止混用 |
|---|---|---|
| **网关 / gateway** | 独立于daemon的同仓Web进程，承载静态资产、API与SSE | server、supervisor、daemon UI进程 |
| **daemon** | coder-loop中央调度进程 | gateway、backend泛称 |
| **status snapshot** | engine-owned运行态公共值；SQLite持久槽来自单read snapshot，其他槽保留独立采样语义 | 全局snapshot、数据库dump |
| **canonical public wire** | 最终CLI JSON与HTTP payload共享并通过精确boundary的值 | domain object、serializer输出（未验证时） |
| **boundary** | owner导出的runtime parse/类型单源 | TypeScript interface、类型断言 |
| **persistent fact / 持久事实** | SQLite或明确artifact/event介质中由owner写入的事实 | process/worktree/git旁证 |
| **liveness三证** | pid/process、socket connect、typed RPC response三项独立观测 | running boolean |
| **主events流** | 4.3 active/history JSONL segments | fallback记录、统一三流 |
| **固定可见结果** | 主历史、最后事件、死因线索、崩溃记录和具名异常按来源可见 | fallback membership合同 |
| **attempt artifact** | 绑定attempt identity的prompt/bindings typed结果 | status字段、compile artifact |
| **pinned definition** | attempt生命周期操作按完整identity解引用的preset定义 | current preset path、D11 preview |
| **current compile preview** | 按preset name对当前定义产生的CAP-7 artifact | historical compile、attempt replay |
| **F façade** | GUI允许的exact mutation集合及typed client | daemon全部command registry |
| **operator主体** | gateway沿稳定信任模型发起socket mutation时的主体 | 任意无credential进程、CAP-4 capability |
| **capability** | 对指定evaluation identity可执行哪些decision的CAP-4领域结果 | operator认证、agent credential |
| **context entry** | CAP-6 typed envelope+opaque body | event、command、Markdown文档 |
| **运行未知** | 影响fixture、参数或验证但不改变稳定保证的未证事实 | requirement、blocker、owner裁决 |
| **工程形态** | 满足已定保证的实现空间 | 需求选项、操作员裁决 |

### 7.2 Identity拼写规则

- 首次出现写全：`chain identity`、`item identity`、`runId`、`phase`、`attempt identity`、`evaluation identity (parId, epoch, bindingVersion)`。
- 不用“ID”泛指不同层身份；表格必须列具体字段/variant。
- `name`只用于current preset选择或显示名，不替代运行identity。
- `source`在events中指物理证据来源，在bindings中指变量值来源；首次使用必须加限定词。

### 7.3 时间与状态措辞

- “当前”必须说明是status current projection、当前preset compile还是查询时current capability。
- “最后”必须说明是主JSONL最后可读事件或某来源最后记录，不写“全局最后”。
- “成功”必须说明是transport送达、daemon accepted、domain effect完成还是status最终可见。
- “可读”必须说明是strict status、events history、artifact route或CAP-6 read boundary。

## 8. 原创性与反抄袭方法

1. **先写问题句，再查材料**：每章先用原创语言写操作员误判与因果疑问，再从报告中抽取证据支持；禁止从原段落删词改写。
2. **跨材料合成**：每个核心章节至少连接两类事实源，例如strict read+wire、events+导航、mutation+观测，避免复刻单份报告结构。
3. **改变信息单位**：源材料以D/F/需求ID为单位，正文以运行转折和证据链为单位。
4. **只保留必要token**：固定命令、类型名、字段名原样；解释句全部重写。
5. **引用而非伪原创**：必须逐字引用的稳定定义用短引文并标来源，不对长段做同义替换。
6. **章节回读测试**：遮住标题后，若一章读起来像验收清单、issue body或AGG某一节，即重构为运行故事。
7. **相邻章去重**：同一原则第二次出现只说明新的消费者后果，不再复制定义。
8. **附录承载索引**：D1–D14、F01–F30、155项需求映射只放附录索引，正文不按编号顺序展开。

## 9. 附录设计

最终文档可有以下附录，但不得让附录取代正文论证：

- **附录A：稳定条款追溯表**——正文论点→AGG/CAP/F/Demand来源。
- **附录B：owner与接缝表**——沿R11 J01–J16列producer/consumer，不列issue编号。
- **附录C：验证证据目录**——命令、环境、fixture、实际结果、证据路径。
- **附录D：运行未知登记**——U01–U15及何时需要证实。
- **附录E：明确非目标**——按风险类别收口，不写“未来路线图”。
- **附录F：术语表**——只收规范词与禁止同义词。

## 10. 最终审查清单

### 10.1 结构与篇幅

- [ ] 正文沿操作员证据旅程，而非D1–D14、F01–F30或SYNTH时间线排列。
- [ ] 每章均有因果问题、正常故事、失败故事、owner边界和运行证据。
- [ ] 没有用一页摘要替代长篇论证，也没有把155项表格当正文。
- [ ] 每部结尾说明已消除的不确定性与下一部的必要性。

### 10.2 需求权威

- [ ] 每个“必须”都能追到稳定AGG/CAP/F/Demand条款。
- [ ] 工程形态使用“可采用/需满足”，没有写成唯一实现。
- [ ] U01–U15没有被称为需求、owner裁决或R10/R11 blocker。
- [ ] 评审反例只用于解释风险，没有自动生成机制。

### 10.3 已纠偏边界

- [ ] 最终CLI/HTTP wire明确是同一boundary对象，没有C1选项。
- [ ] fallback只保证固定可见结果，没有六格membership。
- [ ] D11始终是current name-based，没有historical或双视图。
- [ ] CAP-2写生命周期可达，不写TTL/永久/GC策略。
- [ ] CAP-3/CAP-6只写owner-derived seam，不猜shape。
- [ ] mutation没有durable operation/outbox/saga/log/known-outcome前提。

### 10.4 类型、身份与时间

- [ ] 每个跨边界值都点明owner boundary和consumer。
- [ ] 没有parallel schema、匿名object或前端字段推断。
- [ ] identity字段具体，不以name/index/path替代。
- [ ] SQLite、liveness、events的时间语义没有合成全局snapshot。
- [ ] “最后”“成功”“当前”“可读”均有明确限定。

### 10.5 运行故事

- [ ] 至少覆盖daemon live/down/kill、gateway down、mesh断开、SSE abort。
- [ ] 至少覆盖status不可消费盘、并发writer、events rotation/bad line。
- [ ] 至少覆盖fresh/resume/finalizer与artifact write failure。
- [ ] 至少覆盖合法/拒绝/失败mutation和CAP-4 capable/none/stale。
- [ ] 至少覆盖三context scope、opaque body与移动端真实动作。

### 10.6 验证证据

- [ ] 结果行直接观察用户/下游终态，不只引用自写测试。
- [ ] Web行为包含真实production server与browser路径。
- [ ] 网络行为包含listener与mesh/LAN实际观察。
- [ ] 文件中立性包含bytes/metadata/schema前后对比。
- [ ] 证据标注冻结SHA、环境、输入root/fixture、actual与expect。
- [ ] 无法运行的验证明确归owner和阶段，不伪称完成。

### 10.7 反抄袭

- [ ] 随机抽取三章，与AGG/SYNTH相邻段落比较，章节顺序和句法均非源文改写。
- [ ] 没有连续复制AGG验收表、Decision候选表或Demand矩阵。
- [ ] 固定引文短且有来源；其余解释以运行故事重新组织。
- [ ] 删除标题后，每章仍能辨认其独立因果论点，而不是编号条款汇编。
- [ ] 附录承担追溯，正文承担解释，两者没有整段重复。

## 11. 交付停止点

本设计完成后，正文作者应先提交：

1. 16章各自的一句话因果问题；
2. 每章正常/失败运行故事的事件序列；
3. owner/consumer表和计划引用的证据索引；
4. 一章试写样章用于检查原创叙事与信息密度。

以上四项通过结构审查后再扩写全文。不得从AGG第一节开始顺序“翻译”，也不得先复制表格再补连接句。
