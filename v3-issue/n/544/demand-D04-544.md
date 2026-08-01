# RFC #544 R10 / D4 — status hooks 与 gate hold 可见性原子需求

> 需求事实源仅为 AGG D4、CAP-5 稳定语义与 `expected-foundation-544.md`。本报告定义 D4 对 upstream hook 运行态和既有 status/events 地基的最小消费合同，不定义 hook 执行、gate 重试或资源治理机制。

## A. 一页摘要

D4 的目标是回答两个操作员问题：**“这个 chain 为什么不动？”** 与 **“现在生效的 hook 是哪些？”**

为此需要三条已经由 CAP-5 拥有的 typed seam：

1. 全局、chain、preset、item 四层声明合成后的 effective hook view，并为每个生效项标注来源层；
2. gate hold 当前态，包括决策点、hold 起始与重问节奏线索；
3. `hook.*` observability event 的精确类型与关联字段。

D4 不复制或补造这些 shape。它只把 upstream current view 集成进 status `hooks` 节，经同一个 engine-owned status boundary 输出；把 gate hold 显示在 chain 视图和首屏异常区；把 effective hook 清单放在 chain 详情；再以同一个 hook identity 将“现在”的status与“过程”的events关联。

共形成 **10项原子需求 D04-R01–R10**：CAP-5 upstream seam 3项、D4自身建立5项、既有地基直接供给2项、地基缺口0。外部CAP-5精确shape尚未落定时保留typed seam即可，不构成R10阻塞。

验证观察必须覆盖：四层同时声明后的effective结果与source layer；真实hold后的decision point/start/re-ask线索；非法hooks shape拒绝；同一hook在status与`hook.*`事件间可关联；GUI chain详情与首屏异常区实际可达。D4不要求执行hook、设计重试算法、保存新日志、引入资源cap或从事件反推当前态。

## B. 原子需求矩阵

### B1. 需求、供给与所有权

| 需求 ID | 原子需求 | 稳定来源 | F / X 映射 | Owner / 分类 | 验证时必须观察 | 仍未知 |
|---|---|---|---|---|---|---|
| **D04-R01** | 提供指定chain上下文的effective hook view：四层声明合成后只返回实际生效项，每项携带稳定hook identity与source layer | CAP-5；D4“四层合成后的生效视图” | typed seam；F04/F05承载最终投影 | **CAP-5 upstream seam** | 全局/chain/preset/item各声明hook；返回结果与upstream合成语义一致，来源层逐项正确 | D04-U01 |
| **D04-R02** | 提供当前gate hold的typed状态：无hold或hold中；hold中携决策点、hold起始、重问节奏线索及所属chain identity | CAP-5；D4 gate hold定义 | typed seam；F03–F05承载current status | **CAP-5 upstream seam** | 触发真实hold后读取准确决策点与时间/节奏线索；解除后不继续显示旧hold | D04-U01、D04-U02 |
| **D04-R03** | 导出`hook.*` observability event的精确ADT与关联字段，至少可把过程事件关联到同一hook与chain | CAP-5；D4“快照与事件互补” | F10–F15 events地基，X03 | **CAP-5 upstream seam** | 每个交付范围hook事件通过upstream boundary；hook/chain关联键存在且非法variant被拒绝 | D04-U01 |
| **D04-R04** | status新增精确`hooks`节，集成R01 effective view与R02 gate hold；不得复制CAP-5 shape或使用匿名object | D4定义及负例验收；D3代码红线 | F04、F05 | **D4自身建立** | 正常/无hook/hold/无hold各形态通过同一status boundary；非法字段/variant拒绝 | D04-U01 |
| **D04-R05** | 一次status中的chain identity、effective view与gate hold属于同一次current projection；不得把不同chain或前后状态拼成“现在” | D4“hooks节反映现在”；回答chain为何不动 | F03、F04 | **D4自身建立** | 在合成或hold变化边界读取时，结果要么是变化前整形、要么变化后整形；chain identity不串线 | D04-U02 |
| **D04-R06** | chain详情展示全部effective hooks及source layer；无生效hook时明确显示空态，不从原始声明自行重算 | D4 GUI定义 | F05 | **D4自身建立** | 四层fixture在chain详情逐项可见；页面结果与status hooks节一致 | D04-U03 |
| **D04-R07** | hold中时，chain视图与首屏异常区均显示所属chain、决策点、hold起始与可用重问节奏线索；解除后同步退出hold呈现 | D4 GUI定义与gate hold验收 | F04、F05 | **D4自身建立** | 真实hold/解除浏览器路径；两个视图内容同源且可导航到对应chain | D04-U02、D04-U03 |
| **D04-R08** | status current hook与`hook.*`过程事件按同一个hook identity关联；GUI可从current view到对应过程信息，不能用名称/文案猜关联 | D4“字段可关联（同一hook标识）” | F14、F15，X03 | **D4自身建立** | 同名不同identity不串联；同identity事件可被定位；无事件时不伪造历史 | D04-U01、D04-U03 |
| **D04-R09** | `hooks`节随最终CLI/HTTP status wire通过唯一engine-owned精确boundary；gateway/frontend类型由该boundary派生 | D3是D4固定红线 | F04、F05 | **地基直接供给，D4消费** | 最终CLI和HTTP response均以同一boundary parse；无parallel hooks parser/schema | D04-U04 |
| **D04-R10** | `hook.*`事件复用主events真实历史、过滤、SSE存活/断开清理与可见性通道；D4不建第二事件存储或tailer | D4事件互补；CAP-5备注“既有事件通道” | F10–F15，X03 | **地基直接供给，D4消费** | daemon-down历史中交付范围hook事件可读；live事件经既有SSE到达；client断开资源释放 | D04-U03、D04-U04 |

### B2. 计数与依赖判定

| 分类 | 需求 | 数量 | 判定 |
|---|---|---:|---|
| CAP-5 upstream seam | D04-R01–R03 | **3** | shape与领域语义归CAP-5；D4只派生类型与消费 |
| D4自身建立 | D04-R04–R08 | **5** | status集成、current一致性、GUI呈现与跨面关联 |
| 地基直接供给 | D04-R09–R10 | **2** | 复用F03–F05、F10–F15与X01/X03，不另建通道 |
| 地基未闭合 | 无 | **0** | CAP-5实际shape是typed seam依赖，不是缺失的本地合同或owner gate |
| 原子需求总计 | D04-R01–R10 | **10** | 可进入后续需求拆分 |

### B3. Read / identity / type / consistency 边界

#### Read

- status `hooks`节读取CAP-5提供的current projection；GUI不得读取原始四层声明后自行合成。
- events只表达过程，不能从最后一条`hook.*`事件反推当前effective view或gate hold。
- D4不要求另建hook history API；过程读取复用F10–F15。

#### Identity

- chain identity贯穿status hooks节、gate hold与GUI route。
- hook identity由CAP-5拥有，必须同时出现在effective view与可关联的`hook.*`事件字段；显示名、脚本路径或文本不是关联键。
- gate决策点identity按CAP-5 shape原样消费；D4不自造epoch、retry或execution identity。

#### Type

- CAP-5 boundary是hook/gate/event字段的唯一shape来源。
- status通过F04/F05集成该shape；events通过F10/F14消费该ADT。
- 外部shape尚未落定时只保留typed import seam，不以`JsonObject`、anonymous record或手写frontend type占位。

#### Consistency

- R05只要求一次status中“现在”的effective view与hold状态自洽，不建立status与events的跨介质事务。
- status与event通过identity关联，不要求二者同时提交、全局有序或exactly-once。
- GUI各视图消费同一status结果/失效周期，不自行并行重算current state。

### B4. 验证观察矩阵

| 观察面 | 最小场景 | 通过证据 | 不能替代 |
|---|---|---|---|
| 四层effective view | 四层各声明可区分hook，并包含覆盖/合成场景 | status仅列实际生效项；hook identity与source layer逐项匹配upstream结果 | GUI硬编码四层规则、只检查数量 |
| gate hold | 真实gate进入hold，再解除 | status、chain视图、异常区显示/清除同一决策点与时间/节奏线索 | 手工构造静态JSON或仅看事件 |
| 精确类型 | 合法空态/有效态与逐variant非法shape | engine boundary接受合法、拒绝非法；frontend类型同源 | TypeScript手写interface、宽object parse |
| current一致性 | effective/hold更新边界并发读取 | 同一status不跨chain、不拼前后状态 | 静止fixture |
| event关联 | 同名不同identity、同identity多过程事件 | identity关联准确；无事件不伪造 | 字符串名称匹配或timestamp邻近 |
| 真实消费 | CLI/HTTP、chain详情、首屏异常区、live/history events | 最终wire parse、浏览器可达、daemon-down历史可查、断开资源清理 | builder unit test或单张静态截图 |

### B5. 仍未知但不构成地基缺口

| 未知 ID | 未证明项 | 后续处理 | 不得生成的需求 |
|---|---|---|---|
| **D04-U01** | CAP-5实际ArkType字段、hook identity与四层覆盖细节 | upstream落地后逐字段派生并用真实fixture核对 | D4自造hook shape、合成规则或fallback identity |
| **D04-U02** | hold起始/解除与重问节奏线索的生产时点 | 用CAP-5真实producer做变化边界测试 | 设计重试算法、timer、backoff或gate执行状态机 |
| **D04-U03** | hook数量、事件量及浏览器视图密度 | 作为布局和性能测试参数 | pagination、retention、资源cap或聚合策略 |
| **D04-U04** | hooks节加入后全部status optional分支及真实HTTP/SSE组合 | 纳入D3/D6真实路径E2E | 第二boundary、第二event reader或阶段阻塞 |

### B6. 明确排除

1. 不定义hook执行顺序、脚本运行、失败重试、重问算法、backoff或恢复。
2. 不新增hook registry、scheduler状态机、持久operation、outbox或第二事件日志。
3. 不新增server/client资源cap、pagination、retention或历史索引要求。
4. 不从events反推current effective view/gate hold，不从原始声明在GUI重建合成。
5. 不要求status与events跨介质原子提交、全局顺序、replay或exactly-once。
6. 不猜CAP-5字段名、variant或identity编码；upstream shape未落定只保留typed seam。

## C. 证据索引

- 稳定语义：`AGG-544-gui-observability-gateway.md` D4、CAP-5；类型与消费接缝为D3、D6。
- 修补后地基：`expected-foundation-544.md` F03–F05、F10–F15、X03。
- 本报告未使用源码、旧issue或实现候选。
