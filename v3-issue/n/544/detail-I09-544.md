# RFC #544 R7 / I09 — failure streams 的目标可见性

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一输入为 AGG §2.2/§3.1/§3.2/§4.3/D6、对应 SYNTH 行、R5 L15/L18/L19、R6 I09，以及 I06/I08 已证三流事实。本文只追踪权威文本的事件集合，不以代码现状倒推需求，不提出合流方案、推荐或成本。

## A. 主 agent 摘要（≤一页）

1. **“events”在稳定文字中不是一个始终定义清楚的集合名。** §3.1 架构图、三个数据面说明、§4.3 与 D6 都用单数 `events JSONL` 指向网关 `fs.watch + offset` 的主消费面；§4.3 固化的是 event boundary、主段发现/排序/轮转规则。它没有逐字把 lifecycle persistence failure 与 runner persistence failure 两个物理文件纳入该段集合。因而不能从“events”同名直接推出“三个物理流必须合成一个流”。
2. **RFC 整体又明确要求若干 failure/lifecycle 信息可见。** 关闭验证要求 daemon 死时显示“死于何时、最后事件与三证细节”，并要求 events 历史照常可读；§3.1 要求死前最后事件、`daemon.fatal`/`daemon.stop` 与“落盘崩溃记录”可读；§3.2 首屏要求最近异常事件（列举 `daemon.fatal`、`scheduler.tick_failed`、`attempt.timeout` 等）。这些是**语义可见性要求**，但文本没有把每一项绑定到某个物理文件，也没有声明三流全局序。
3. **D6 的明确集合边界较窄。** D6逐字要求“按4.3契约直读 events JSONL”，读取 active/history 段、按信封键和时间过滤、全程精确 parse；其验收只核跨 rotation、daemon-down 历史、过滤与SSE存活。D6没有点名两个 failure 文件、三流合并、failure-stream cursor、跨流无丢不重或跨流顺序。因此把这些全部读入 D6 是新增要求；反过来，以 D6 只写主段为由取消 §2.2/§3.1/§3.2 已明确的死因、最后事件和最近异常可见性，也不成立。
4. **术语必须分层。** `lifecycle` 在 §4.3 首先是五个 event kind 之一；`daemon.fatal`/`daemon.stop` 是主 event ADT 中的 lifecycle event type。I06/I08所称 “lifecycle failure stream” 则是独立的 persistence-failure JSONL。三者名称相近但不是同一集合。`runner failure stream` 同样是物理 fallback 文件，不等于所有 runner/attempt failure 事件。
5. **三流差异不是可直接判定的整体“偏离”或整体“合法边界”。** 对 D6 已写明的主 segment 消费契约，两个 fallback 文件未被纳入，三流物理差异属于合法的文本沉默；对全 RFC 的死因/最后事件/最近异常终态，消费者若因数据所在物理流而看不到明确要求的记录，则结果偏离这些终态。权威文本没有证明“所有两个 failure 流的所有记录都必须可见”，也没有证明“只看主流必然足够”。
6. **已有运行事实只用于现状对照。** I06/I08已证：主流、lifecycle persistence-failure、runner persistence-failure 是三个物理流；`logs.query` 才读取三流并仅按 `ts` 稳定排序；主流查询不含后两流；same-ts无全局因果序；任一流坏行可使三流查询整体失败。本文不新增实验，也不把该现状升级为目标。
7. **最小待裁决问题只有一个集合边界问题：** RFC 所称 GUI “events 历史 / 最后事件 / 最近异常事件”各自是否包含两个 persistence-failure 物理流中的哪些记录。现有文字已足以确定主 events segment 是 D6 推送与历史的核心集合，也足以确定列明的死因/最后事件/最近异常必须可见；但不足以确定 fallback 记录的逐类归属、跨流统一身份或顺序。该问题未裁决前，L18保持“静态未知”，不能把L15的三流事实改写成实现要求。

## B. 逐句来源矩阵、现状对照与置信边界

### B1. 权威文字中的事件集合

| 来源 | 逐句含义 | 明确的事件集合/可见性 | 对两个 failure 物理流的效力 |
|---|---|---|---|
| AGG §2.2 #1 `:54`；SYNTH `:124` | 活态呈现“最近事件”；死态呈现“死于何时、最后事件与三证细节” | 明确要求最近/最后事件进入首屏；没有定义候选集合或选取顺序 | 沉默；既未排除 fallback 记录，也未要求三流全部参与 |
| AGG §2.2 #2 `:55`；SYNTH `:125` | daemon-down 时“events 历史与队列终态照常可读” | 明确要求一个称为 events 历史的集合在 daemon-down 可读 | 未给出物理文件枚举 |
| AGG §2.2 #3 `:56`；SYNTH `:126` | `agent.spawn → phase 推进 → agent.exit` 全链路事件实时到达 | 明确的最小实时链是业务 lifecycle 事件链 | 没有要求 persistence-failure 两流实时到达 |
| AGG §2.2 #5 `:58`；SYNTH `:128` | 从任一事件跳到 run/item | 对被GUI纳入的事件要求关联跳转 | “任一”受先前集合未定义影响，不能反向扩张为磁盘上三流全部记录 |
| AGG §3.1 图与说明 `:88-105`；SYNTH `:57-74` | daemon是“events唯一写入方”，一个 `events JSONL` 节点；网关直读其推送与历史 | 架构明确画出单一主 events 数据面 | 未画两个 fallback 文件；图的沉默不能证明其归入或排除语义历史 |
| AGG §3.1 daemon-down `:104`；SYNTH `:73` | “events历史与死前最后事件（JSONL）”、`daemon.fatal`/`daemon.stop` 与落盘崩溃记录可读 | 明确要求这些死因线索可见；并把“落盘崩溃记录”与括号中的主JSONL事件并列 | 明确存在不止主event type的死因素材，但没有声明其路径、schema或必须统一为一条流 |
| AGG §3.2 `:110`；SYNTH `:85` | 首屏含最近异常事件，列举 `daemon.fatal`/`scheduler.tick_failed`/`attempt.timeout`“等” | 三个具名 type 必须可见；“等”表示列举非穷尽，但不提供可计算闭集 | 不能据“等”推出两个 failure 流全量纳入 |
| AGG §4.3 `:155-161`；SYNTH `:974-1016,1324-1335,1615-1624` | 导出 boundary、五kind、type union、主段发现/排序/active basename/轮转；网关按契约读段 | 明确的是同仓 event schema 与主 segment contract | 没有点名 lifecycle/runner failure path、发现规则或三流合并规则 |
| AGG §4.3 `:157` | `lifecycle` 是五 kind 之一 | `lifecycle` 是逻辑 event 分类 | 不能等同于“lifecycle persistence-failure”物理文件 |
| AGG §4.3 `:158-159`；SYNTH `:1003-1006,1023-1025` | 段全序、翻段无丢重、真实daemon轮转 | 保证范围是被导出发现/排序的主段集合 | 没有跨三个物理流的全局序或无丢重主张 |
| AGG D6 `:290-294`；SYNTH `:410-425` | 按4.3直读 active/history，SSE推送，历史查询、过滤与精确类型 | D6核心集合明确继承4.3主segment contract | 未定义读取两个failure文件 |
| AGG D6验收 `:301-305`；SYNTH `:431-439` | rotation、daemon-down历史、过滤、长历史性能 | 验收观察主event reader行为 | 没有三流覆盖或跨流排序验收 |

### B2. 文本明确、文本沉默与表面冲突

| 分类 | 结论 |
|---|---|
| **文本明确** | 主 `events JSONL` 是D6的增量推送与历史核心；其schema/segment规则来自4.3；daemon-down仍须读历史；首屏须有最近/最后事件；`daemon.fatal`、`daemon.stop`、`scheduler.tick_failed`、`attempt.timeout`及落盘崩溃记录须支撑死因/异常可见性。 |
| **文本沉默** | 两个 persistence-failure 文件是否属于D6“events历史”；是否实时SSE；是否进入所有过滤查询；是否参与“最后事件”；哪些runner persistence failure算首屏异常；三流是否共享cursor、event identity或全局顺序。 |
| **表面冲突** | §3.1图和D6使用单一 `events JSONL`，而§3.1 daemon-down又要求“落盘崩溃记录”可读。它们并非逻辑矛盾：前者定义核心数据面，后者定义用户必须看到的结果；缺失的是结果到物理来源的归属规则。 |
| **不成立的推导** | “4.3 union含diagnostic/lifecycle type，所以所有采用同ADT的物理文件自动属于4.3 segment集合”；“首屏写最近异常，所以所有failure文件全部进入主历史”；“D6只点主流，所以fallback诊断可以完全不可见”。三者均超出逐字文本。 |

### B3. I06/I08 已证现状对照

| 已证事实 | 对权威文字能证明什么 | 不能证明什么 |
|---|---|---|
| I06：存在主流、lifecycle persistence-failure、runner persistence-failure三个物理流，均使用同一event ADT | “逻辑schema同源”与“物理文件不同”可同时成立 | 同ADT不自动赋予同一契约集合身份 |
| I06：`scheduler.lifecycle_event_persistence_failed` 与 `runner.status_persistence_failed` 在#671契约合入前已进入union | 4.3导出union包含这两类合法事件shape | 4.3未因此导出两个fallback文件的segment/discovery契约 |
| I08：主流query不含后两流；daemon `logs.query`读取三流 | 当前确有两种不同消费集合 | 哪一种就是GUI目标集合 |
| I08：三流合并只按`ts`稳定排序；same-ts为来源拼接序，无全局sequence | 现状不能提供跨流因果全序 | RFC是否要求跨流全序；文本没有该主张 |
| I08：任一流坏行可使`logs.query`整体失败 | 若复用该集合，现状可见性有失败边界 | RFC没有要求复用`logs.query`，也不能由失败反推必须合流 |

### B4. failure、lifecycle 与文件身份词汇表

| 术语 | 在本文中的身份 | 不得混同 |
|---|---|---|
| `lifecycle` kind | §4.3 event ADT的五个逻辑kind之一 | lifecycle persistence-failure文件 |
| `daemon.fatal` / `daemon.stop` | 具名 lifecycle event type，§3.1/§3.2要求可作为死因线索 | “所有daemon崩溃记录”的同义词 |
| lifecycle persistence-failure stream | I06/I08已证的独立fallback JSONL物理文件 | 主events所有lifecycle kind事件 |
| runner persistence-failure stream | I06/I08已证的独立fallback JSONL物理文件 | `agent.exit`、`attempt.timeout`等正常主流runner生命周期事件 |
| events历史 | RFC用户语义名；D6核心指4.3主segments，但全RFC是否扩及fallback尚未裁决 | 任一同ADT文件的自动并集 |
| 最后事件 / 最近异常 | 展示选择语义 | 磁盘文件尾、三流timestamp sort或全局因果序；文本均未如此定义 |

### B5. 消费者影响与最小待裁决问题

**已确定的消费者责任：**

- D6 consumer必须消费4.3主segment契约，提供增量推送、历史、过滤、daemon-down读取与精确类型链。
- GUI首屏/daemon-down体验必须展示权威文字具名的死因、最后事件和最近异常信息。
- 事件详情/跳转只能对GUI实际纳入的事件集合施加关联键要求，不能先用“任一事件”扩张集合。

**尚未确定的消费者边界：**

- “events历史”“最后事件”“最近异常事件”三个展示/查询概念，是否以及按何种记录范围包含两个 persistence-failure 物理流。
- 若包含，文本仍未规定它们与主segment之间的统一身份、cursor或顺序；这些不能从I08现存timestamp sort继承为稳定语义。

**最小待裁决问题：**

> GUI 的“events历史 / 最后事件 / 最近异常事件”三个语义集合，分别是否包含 lifecycle persistence-failure 与 runner persistence-failure 文件中的记录；若包含，哪些记录属于各集合？

该问题只请求集合归属，不预设物理合流、读取实现或排序机制。未裁决前，L18继续为静态未知；L15只保留“三流现状及无全局序”的事实。

### B6. 来源索引与置信边界

- AGG：`AGG-544-gui-observability-gateway.md:50-63,83-114,153-165,288-317`。
- SYNTH：`v3-issue/synthesized/SYNTH-544-gui-observability-gateway.md:52-88,118-133,400-445,964-1032,1310-1335,1600-1624`。
- R5：`supply-ledger-544.md:61,64-65`（L15/L18/L19）。
- R6：`detail-investigation-index-544.md:88-95`（I09）。
- 现状事实：`detail-I06-544.md` B2/B5/B7；`detail-I08-544.md` A6、B1/B2/B6。

**高置信：** 逐句文本是否点名某集合、4.3/D6主segment边界、术语同名与物理文件的区分、I06/I08三流现状。  
**未被文本决定：** fallback记录的GUI集合归属、跨流identity/cursor/顺序、生产root中这些记录的实际频率。本文未查新源码、未访问生产root、未做实验，也未把未知改写为实现方案。
