# RFC #544 R8 / S4 — attempt definition 与 compile 消费决策档案

> 事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本档只使用 AGG 的 D2、D10、D11、CAP-2、CAP-3、CAP-7，R7 I10–I11 与收口核算；不重新读取源码、运行实验、实现、估算或拆分实施单元。

## A. 操作员摘要（≤一页）

当前 attempt 先把 definition hash 与 run identity 落 SQLite，之后才读取 phase prompt、解析 bindings、render `effectivePrompt` 并构造 argv；真正发给 runner 的 prompt/bindings只活在局部变量和 argv，run目录没有 `prompt.md`/`bindings.json`。同进程按源路径命中旧 cache；源修改后不失效。daemon restart 后 cache丢失并重新读同路径当前内容；新 materialization又 prune同名旧hash目录。于是 run能说“当时选了哪个hash”，却不能按hash恢复definition，也不能事后证明runner实际收到什么。

D2/D10/CAP-2 已明确要求：fresh/resume全部attempt保存与实发同源的prompt/bindings；历史缺失如实显示；spawn/retry/restart必须从attempt所属 pinned definition解引用，不得重读当前路径。当前缺失是**确定偏离，不能退回为是否要修的裁决**。CAP-3只确定类型化值将 additive 携带，当前基线仍是scalar render string；CAP-7则提供versioned compile产物与共享计算路径，但不是历史definition repository。

### 稳定边界与工程接缝

D11 已固定为 **current name-based compile preview**：GUI 选择 preset name，并与同次 `coder-loop preset compile <name> --json` 的产物对照；三视图来自同一个 versioned compile artifact。历史 attempt 的 pinned definition 不属于 D11 输入，把它加入 D11 会新增稳定设计未要求的历史视图。

CAP-2 已固定的保证是：attempt 所属 pinned definition 在 spawn/retry/restart 生命周期操作中必须可解引用，且不得重读当前路径。repository 载体、保留与 GC 算法、缺失表示是守住该保证的工程设计，不能反过来成为是否提供该保证的 owner 裁决；也不得自行发明 TTL 或无限保留。

CAP-3 的精确 typed shape 由外部能力 owner 落定，但它只允许在当前 scalar render string 基线上 additive、non-breaking 扩展，明确不阻塞 R9。RFC #544 保留 extension seam，不猜字段、variant 或复合值编码。

因此本档没有操作员裁决，也没有 R9 前置 owner 裁决。工程可比较的是 definition 内容持久化与 identity resolver 的载体、D2 同源 artifact 提交位置，以及 current name-based compile 的消费接缝。只保存 hash、延长 cache、禁止 prune、restart 重读路径、从 stdout 反推 prompt、GUI 重放 render，均不能满足已定性质。

## B. 完整档案

### B1. 稳定要求与当前事实

| 对象 | 稳定要求 | 当前事实 | 判定 |
|---|---|---|---|
| attempt prompt | D2：`prompt.md`与argv取同一个`effectivePrompt`；fresh/resume如实，finalizer特例隔离 | render后只传argv，run目录无prompt | 已确定偏离 |
| bindings | D2：逐KEY source+渲染值完整落盘；CAP-3后additive typed | number/boolean/string均塌为string；object拒绝；无per-attempt文件 | D2偏离；CAP-3 shape待owner |
| artifact失败 | D2：不挡run但必须发diagnostic事件 | 当前没有该artifact/失败面 | 已确定交付义务 |
| attempt展示 | D10：字节原样、精确parse、不重放；旧attempt显示“早于持久化” | 无可消费artifact | 已确定偏离 |
| definition identity | CAP-2：attempt所属pinned definition可解引用，retry/restart不读当前路径 | run持完整hash，但内容/locator不持久；旧materialization被prune | 已确定偏离 |
| compile preview | D11/CAP-7：name选择、三视图同一compile产物、同CLI计算路径/schemaVersion、findings | current compile投影是可保留资产 | 已固定为 current name-based preview |

### B2. 当前时序、因果与触发条件

| 顺序 | 当前动作 | 触发/放大条件 | 后果 |
|---:|---|---|---|
| 1 | 按源路径取进程cache；cold load时materialize并计算hash | 同路径源修改但daemon不重启 | 后续attempt继续用旧cached definition；路径“当前内容”与进程定义分离 |
| 2 | run/closure/item identity先落库，run extra持完整definition hash | 后续prompt读取、render、artifact初始化或spawn失败 | 有run identity但不能证明prompt算到哪一步、argv是什么 |
| 3 | 从materialized prompt读取、解析scalar binding、render并追加epilogue | number/boolean/string；object binding | 值统一变render string，原类型消失；复合值无法render |
| 4 | argv构造并spawn；run目录初始化status/streams/auth | 所有fresh/retry/resume | 实际输入只在局部值/argv；事后无prompt/binding artifact |
| 5 | daemon restart清cache并从同路径当前内容load | preset在两次进程间变化 | 恢复/重试可能取得新definition；旧run hash没有resolver |
| 6 | 新hash materialization完成后删同名旧hash sibling | 同preset多版本、restart/cold load | materialized目录只是短期cache，不是historical repository |

直接因果是：identity、definition内容、rendered输入分属SQLite、易失cache/materialization和局部变量，且没有一个持久边界把三者按attempt连起来。hash证明“scheduler选择的`LoadedPreset.sourceHash`”，不能证明prompt文件成功读取、每个binding值、实际argv文本或历史内容仍可取。

### B3. consumer影响与不可混同的保证

- D10若读取当前路径再render，会产生第二套值来源，无法声称展示当次实发。
- retry/restart若只有hash而无resolver，仍会回落到当前路径；hash的精确性不能替代内容可达性。
- CAP-7的compile boundary能证明六块产物内部与CLI一致；它不保存definition内容，也不自动把name-based compile绑定到historical attempt。
- D2的`prompt.md`/`bindings.json`可证明当次实发输入，但只保存这两个artifact仍不足以让CAP-2在未来retry/restart重新解引用完整definition。
- run row早于render不是自身错误；错误在于此后没有持久提交点记录“实际实发输入”，失败run也无精确阶段证据。

### B4. 事实支持的实现形态族及确定后果

下列是证据允许比较的形态族，可正交组合；不是对未来具体API、文件shape或存储介质的完备预设。

| 维度/形态 | 必须成立的性质 | 确定后果 | 不成立边界 |
|---|---|---|---|
| **P1 内容寻址definition repository** | 完整definition由full identity定位；写成后不可因同路径新hash删除；spawn/retry/restart只按pinned identity解引用 | 当前hash可成为稳定lookup key；同路径变化不改变旧attempt输入 | 仅延长materialization cache或目录短hash命名不能证明retention/identity |
| **P2 持久definition record+resolver** | SQLite execution definition或其持久locator能由identity到完整内容；resolver拒绝identity/content不匹配 | definition身份与内容在持久域关联；存储可不限定为目录 | 只有hash/semantic_hash而无内容或locator仍不可解引用 |
| **P3 attempt自持完整definition引用** | attempt/run持有稳定identity及可达引用，repository生命周期必须覆盖已声明的 spawn/retry/restart 解引用操作 | 每个attempt可恢复自己的definition，不依当前preset path | 把当前路径作为locator违反CAP-2 |
| **A1 render后、argv前同源artifact** | `prompt.md`直接写同一个`effectivePrompt`值；`bindings.json`来自同次resolver结果；写失败发diagnostic但spawn继续 | D10可逐字展示；artifact与argv构造点同源；失败可观察 | 事后从argv/stdout解析、GUI重render都不是同源 |
| **A2 attempt输入packet作为单一内存产品** | 一次解析产生definition identity、effectivePrompt、完整binding entries和resume metadata；argv与artifact仅投影该packet | fresh/retry/resume消费点由类型暴露；减少局部重算分叉 | packet若不持久，仍不能独自满足D10 |
| **A3 artifact存在/缺失显式ADT** | present含精确versioned内容；legacy-missing与write-failed可区分，后者有diagnostic关联 | D10不会以空白冒充无输入；历史与运行失败语义不同 | 一个nullable文件或统一“missing”会折叠原因 |
| **B1 scalar基线+additive typed位** | 当前render string保持；CAP-3 owner定义后只新增typed证据，不改变旧值语义 | D2可先落基线，typed能力后加入不breaking | 本RFC自定字段/variant/复合值即越过owner |
| **C1 current name-based compile** | 每次按所选name解析，产物经CAP-7 boundary；不标为attempt历史定义 | D11三视图与CLI同次对照，CAP-2与D11解耦 | 若页面与historical attempt并置却暗示“当时定义”，语义不实 |

**被稳定范围淘汰：**

- GUI直接读/解析`preset.toml`或重建compiler：违反D11/CAP-7同计算路径。
- 为D11自动增加current+pinned双视图、切换器或diff：权威文本无此要求，属于范围增长。
- 以无限保留或任意固定天数替代CAP-2可达性设计：新增稳定文本未要求的期限。
- 在CAP-3 owner产物前设计具体typed binding union/字段：越过外部shape边界。

### B5. 已定语义与权限边界

| 对象 | 已定语义 | 工程边界 |
|---|---|---|
| D11 | current name-based compile preview；三视图来自同一compile产物并与CLI同次对照 | 不新增historical-pinned视图或双视图 |
| CAP-2 | spawn/retry/restart按attempt pinned definition解引用，不读当前路径 | 设计repository、resolver、保留与GC时必须守住该可达性；不猜TTL或无限保留 |
| CAP-3 | scalar render string为基线；typed value仅additive、non-breaking | 精确shape随owner接口落定，保留extension seam，不阻塞R9 |

本档案没有操作员裁决。CAP-3 shape 是外部接口细节而非R9 gate；CAP-2的存储与GC是固定可达性保证之下的工程问题。

### B6. 具体触点与证明面

| 责任 | 当前模块/对象 | 后续必须覆盖的证明 |
|---|---|---|
| preset load/cache/materialize | `src/daemon.ts` 的`loadedPresetForItem`、`loadedPresetFromDirForChain`；`src/loop.ts` materializer/loader | 同路径V1→V2、同进程cache、restart、old identity resolver、prune后可达性 |
| run identity | `src/scheduler.ts` spawn choke point、`recordRunWithClosureResources`；SQLite `runs.extra`、`execution_definitions` | identity与definition内容匹配；pre-render失败、retry、resume、restart |
| render/bindings/argv | `renderPrompt`、binding resolver、scheduler exits epilogue、`buildRunnerInvocation` | prompt artifact与argv参数同一值；KEY/source/render值完整；scalar基线 |
| artifacts | runtime paths及phase初始化：status/stdout/stderr/auth/session | fresh、普通resume、finalizer特例；write失败继续+diagnostic；legacy缺失ADT |
| D10消费 | gateway artifact route、bindings boundary、attempt页 | 文件字节逐字；不markdown加工/不重render；missing原因如实 |
| compile | CAP-7 `preset compile --json`计算路径、schemaVersion boundary、findings | 两个preset三视图逐块一致；unsupported version显错；固定使用name输入 |
| owner接缝 | CAP-2 resolver/retention工程接缝；CAP-3 additive typed boundary | 只消费owner产物，不复制shape/GC规则 |

### B7. 仍未知

| 未知 | 当前最窄结论 | 谁/何时确定 |
|---|---|---|
| CAP-2 repository载体、GC与missing的具体实现 | 必须守住spawn/retry/restart期间pinned definition可解引用；不能指定额外期限 | R9工程设计与运行验证 |
| CAP-3 typed shape/value域 | scalar render string基线与additive seam已定；精确shape不由本RFC猜测 | 外部owner接口落定时消费，不阻塞R9 |
| historical compile是否与current并存 | 稳定设计未要求，当前范围不包含 | 只有新增需求才可进入范围 |
| source在materialize两次遍历间变化的生产频率 | 静态存在model/hash分离窗口，但未量化 | 实施identity原子性验证时定向测试 |
| 仓外run hash消费者与真实历史artifact分布 | 不影响已确定偏离，可能影响兼容/迁移 | 实施前consumer盘点 |

### B8. 决策分类

| 类别 | 内容 |
|---|---|
| 已确定必须修 | D2/D10 artifact缺失；CAP-2内容不可按hash解引用且restart读current；scalar之外原类型证据缺失但CAP-3具体shape未定 |
| 操作员裁决 | 0 |
| R9前置owner裁决 | 0；CAP-3精确shape为后续接口依赖，不阻塞scalar基线与extension seam |
| 工程分叉 | P1/P2/P3的持久载体与resolver布局；A1/A2/A3的同源artifact边界；固定current name-based compile入口 |
| 纯证明缺口 | source并发mutation窗口、仓外消费者、真实历史分布；不得据此弱化已定要求 |

### B9. 证据索引

- D2：`AGG-544-gui-observability-gateway.md:190-210`
- D10/D11：`AGG-544-gui-observability-gateway.md:385-424`
- CAP-2/3/7：`AGG-544-gui-observability-gateway.md:492-503`
- identity/materialization/render/artifact/cache/restart/prune/scalar实验：`detail-I10-544.md` A、B1–B7
- D11 current/pinned文本边界与CAP-2悬空依赖：`detail-I11-544.md` A、B2–B8
- R7分类与S4收口：`detail-investigation-audit-544.md` B1、B3–B5
