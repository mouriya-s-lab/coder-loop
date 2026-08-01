# RFC #544 R9 — 修补后预期地基

> 事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。输入为 AGG/SYNTH 稳定条款、纠偏后的 S1–S7 决策档案与两份收口核算、R7 I01–I15 事实摘要。本文件只定义 R10 可引用的最小预期保证，不选择具体工程形态，不修改稳定设计，也不设置操作员或外部 owner gate。

## A. 一页摘要

R9 收敛出的地基由 **30 项保证（F01–F30）** 构成：

- status 经严格只读、同一 SQLite snapshot 构造，最终 CLI/HTTP wire 由同一个 engine-owned 精确 boundary 验证；
- daemon 三证独立，typed client 有界完成并销毁 socket，response identity 与错误保持精确；死态可一键start，stop/restart遵循既定机制且restart后三证翻绿；
- 主 events 真实历史在 daemon-down 时可读，active offset 增量与正常 rotation 无丢无重，SSE 存活且断开释放资源；最后事件、死因线索、落盘崩溃记录和具名异常可见；
- attempt prompt/bindings 与实发同源，pinned definition 在 spawn/retry/restart 生命周期内可解引用；D11 固定 current name-based compile；CAP-3 只保留 scalar 基线上的 additive typed seam；
- context 只建立一个 operator socket typed read 合同，消费 CAP-6 upstream boundary；外部 shape 未落定不阻塞；
- GUI mutation 面恰为 F 档，复用既定 operator 主体与 daemon 裁判，逐 verb 呈现 accepted/rejected/failed 并由 status/events 核验；
- CAP-4 形成 evaluation identity → capability → `advance|hold|reopen` → consumer → status/event/audit 的完整 typed domain 链。

地基明确不吸收更强强化：server/response caps、通用 events schema-version/migration 框架、断线 replay/`Last-Event-ID`/restart cursor、context write recovery、operator 认证重构、全面封 store、durable mutation operation、共同 commit、outbox/saga/command log、跨介质 known-outcome、历史 D11 或双视图。它们只能在另有稳定需求时进入。

当前仍有 **15 项运行未知（U01–U15）**，包括特殊文件系统、真实历史盘与 events 样本、生产并发/规模、外部 CAP-3/CAP-6 的实际 shape、daemon生命周期与浏览器/mesh E2E 等。这些未知决定验证细节或兼容处理，不改变 F01–F30，也不构成 R10 阻塞。

## B. 完整地基映射

### B1. S1 — status read / consistency / wire

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F01** | D1严格只读；当前opener以read-write打开、切WAL并迁移 | status/gateway读取从打开到关闭均不能执行create、journal mutation或migration；daemon-down重复读取DB/WAL/journal/schema byte/metadata中立 | 缺盘前置检查、SQLite store边界、writer migration事务 | U01、U02 | 把文件权限、`createIfMissing:false`或跳过migration单独冒充strict read |
| **F02** | D1要求不可消费盘精确结果；当前缺盘/损坏/权限/schema被折成`missing-state` | schema不可消费、缺盘/不可用及其他读取失败以精确typed结果传播，分类不因失败helper不同而改变 | `SqliteStateError`入口、已有missing-state投影 | U02 | 用统一文案或catch-all代替domain error |
| **F03** | CAP-1/D9要求持久事实如实投影；当前五连接及tree多statement跨commit | 一次status中的SQLite持久槽与完整taskTree来自同一read snapshot；非DB events/processes不被虚构为同一全局时钟 | taskTree exact ADT、normalized tables、FK/CHECK、writer单事务 | U03 | 跨SQLite/events/process建立分布式事务 |
| **F04** | D3与代码红线要求精确契约；当前七槽宽、TS平行手写 | snapshot顶层及各槽精确，无匿名object兜底；TS/GUI类型从engine-owned boundary派生 | `TaskTreeSnapshotBoundary`、局部typed builders | U04 | 平行gateway schema、第二builder/parser |
| **F05** | D3验收固定`status --json`与HTTP消费面；当前assert后再平铺`extra` | **最终 CLI JSON 与 HTTP response wire通过同一个engine-owned精确boundary**；序列化后不存在未验证结构改写，shape diff可审 | 共享CLI stringifier、既有wire样本/文档 | U04 | 只验证内部domain而让public wire另算 |

### B2. S2 — daemon liveness / typed transport

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F06** | D7要求pid/process、socket connect、RPC三证；当前被压成process row | 三证分别保留原始分类、采样时间与任意分裂态，不折成单boolean | pid/socket路径、`daemon.status`、process旁证 | U05 | 原子化三次跨源观测 |
| **F07** | D5/D7/D8不能永久挂起；当前silent/half-close不完成 | typed client在明确deadline/cancel内完成；timeout/abort主动销毁底层socket，不以外层race遗留资源 | 现有socket client与request envelope | U06 | server idle/handler deadline或connection cap作为共同前提 |
| **F08** | 当前任意非空id可被接受 | response id严格匹配request id；EOF、incomplete、invalid envelope、mismatch不能冒充成功 | request id/envelope字段 | U06 | response/server byte或connection caps作为交付门槛 |
| **F09** | 当前command/result为宽`JsonObject`且错误折叠 | command→args→result/error从引擎闭集派生；connect、deadline、EOF、protocol、remote rejection与mutation未确定结果精确区分并显式呈现 | daemon command registry、既有handler specs | U07 | gateway复制command表或另写framing/parser |
| **F10** | D7要求daemon-down可恢复与一键生命周期控制 | daemon死态时start可用；**start由gateway spawn `coder-loop daemon up`，不是socket RPC**；stop/restart走既定机制；spawn出的daemon生命周期与gateway解耦；成功restart后三证均翻绿 | 既有daemon up/down/restart命令、pid/socket/RPC三证 | U15 | 新建通用process supervisor、把start伪装成RPC或让daemon依附gateway进程 |

### B3. S3 — events history / live continuity / visibility

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F11** | D6/4.3要求daemon-down历史；当前坏行/partial可击穿查询 | 交付范围内**真实主events active/history segments**可发现、精确parse、过滤并在daemon-down时读取；实际不兼容只做对应最小处理 | current event ADT、三代filename parser、segment排序 | U08 | 无实证先建通用schema-version、多代parser或history migration框架 |
| **F12** | 当前多writer竞争产生重复sequence，normal rotate/append可丢event | 普通、timer、fatal写入口共享唯一写入所有权；正常day/size rotation产生唯一段身份并完成append | JSONL writer、day/size rotation fixture | U09 | crash journal、publication recovery、fsync/power-loss保证 |
| **F13** | D6要求增量成本与翻段连续；当前每轮全读+结果计数 | reader按active byte offset增量读取；正常rotation中已提交event无丢无重；segment identity/offset仅是内部工程状态 | discovery/order、line parser、watch触发 | U09 | 对外通用cursor合同 |
| **F14** | SSE宿主已建立但资源生命周期需闭合 | 已建立SSE连接在daemon停止后仍由网关服务；client断开立即清理watch/reader，网关继续健康 | Bun SSE spike、`request.signal`硬门 | U10 | 断线replay、`Last-Event-ID`、restart cursor persistence |
| **F15** | 稳定首屏/死态目标；当前主流与fallback物理分散 | 主events历史、最后事件、`daemon.fatal`/`daemon.stop`等死因线索、落盘崩溃记录与具名异常可见；来源如实，物理归集不冒充统一三流全集 | event ADT、fallback files、关联键过滤 | U08、U09 | 跨流因果全序、fallback六格membership合同 |

### B4. S4 — attempt artifacts / pinned definition / compile

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F16** | D2要求实发同源；当前prompt/bindings仅存在局部变量 | 每个fresh、普通resume及finalizer特例attempt落`prompt.md`/`bindings.json`；prompt与argv取同一个`effectivePrompt`，bindings来自同次resolver结果 | renderer、runner invocation、run目录 | U11 | 从argv/stdout反推或GUI重放render |
| **F17** | D2落盘失败不挡run且不得静默 | artifact写失败时attempt继续，并产生唯一要求的diagnostic事件；成功路径零新增事件 | observability event通道 | U11 | 把artifact写入升级为runner提交事务 |
| **F18** | D10要求如实展示；历史attempt无artifact | D10逐字显示prompt、精确parse bindings，不二次markdown加工；legacy missing与write-failed如实区分 | run/phase页面与typed artifact boundary接缝 | U11 | 猜测或重建历史输入 |
| **F19** | CAP-2要求pinned可达；当前只有hash且cache/restart/prune破坏内容 | attempt所属definition在spawn/retry/restart生命周期操作中可按完整identity解引用，不重读同路径current内容 | 完整source hash、execution definition记录、materialized loader | U12 | 自行承诺TTL、无限保留或特定GC算法 |
| **F20** | D11/CAP-7稳定定义态预览 | D11固定**current name-based compile**；GUI与同次`preset compile <name> --json`共享计算路径/schemaVersion，三视图与findings来自同一artifact | CAP-7 compile projection/boundary | U12 | historical-pinned compile、current+pinned双视图 |
| **F21** | CAP-3为外部additive能力 | `bindings.json`与compile消费保持现有scalar render string基线，并保留non-breaking additive typed seam；外部shape到达后直接派生 | scalar renderer、CAP-7 typed boundary接缝 | U13 | 猜字段、variant、复合值编码或把shape当R10 gate |

### B5. S5 — context typed read seam

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F22** | CAP-6/D12要求operator read；当前只有内部full-list store | 存在一个daemon context服务域的operator socket typed read合同，经gateway到frontend；request/result/error全部从upstream ArkType boundary派生 | strict context ADT、store/list、author推导 | U13 | gateway直读store或复制entry shape |
| **F23** | D12固定三scope与展示语义 | chain公告、item谱系、group分支组三scope可浏览；显示`id/ts/scope/author`与opaque body，body不解释控制语义 | typed envelope/body、持久表 | U13、U14 | 自造pagination/filter/cursor/error shape |
| **F24** | 成功持久化entry当前仅可由内部测试观察 | 经既有成功写入路径持久化的entry可由实际upstream read boundary读出并在D12显示；pagination/filter跟随upstream | 现有成功写/store round-trip | U13、U14 | partial-upload restart、idempotency、DB/event原子、outbox/ledger/staging等write recovery |

### B6. S6 — F mutation surface / result observability

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F25** | D8/F档固定GUI动作闭集；当前daemon大闭集无GUI投影 | GUI mutation类型恰为F档；范围外create/add/batch类型不可达，命令/args/result/error从引擎单源派生 | daemon registry、21-command服务端闭集 | U07、U14 | gateway手写四字符串或暴露任意daemon command |
| **F26** | 稳定信任模型为零agent credential的operator调用与daemon裁判 | gateway按既定operator主体调用；**socket mutation**经daemon裁决，gateway不建平行授权判断；daemon start单独遵守F10的gateway spawn路径 | daemon auth gate、active credential检查 | U14、U15 | operator认证重构、peer/token体系、全面封锁store，或把start强塞进RPC |
| **F27** | 四动作handler存在但结果/错误与target核验不完整 | `queue.unblock`、`chain.stop/resume`、`item.reorder`逐verb区分accepted/rejected/failed；已知失败不报success，核心结果可由status/events核验 | 四handler、store事务、既有events | U07、U14 | durable operation/query/replay、共同commit、outbox/saga/log、跨介质known-outcome |

### B7. S7 — CAP-4 evaluation decision chain

| 保证 ID | 稳定条款 → 实然问题 | 最小修补后预期保证 | 可保留资产 | 仍未证明运行项 | 明确排除的强化 |
|---|---|---|---|---|---|
| **F28** | CAP-4要求per-epoch decision；当前只有evaluation lifecycle | evaluation由`parId+epoch`并关联binding version；decision是与lifecycle分离的`advance|hold|reopen`封闭ADT | evaluation history/latest、bindingVersion、task-tree identity | U14 | 用resume/unblock/改join冒充decision |
| **F29** | 当前无capability query与typed operation | 当前operator可查询指定evaluation capability；GUI仅在有capability时经F typed operation提交，daemon校验identity/currentness并给最小结果 | S6 typed façade接缝、daemon裁判 | U07、U14 | 第二授权系统、durable operation前提 |
| **F30** | 当前无领域consumer及同源观测 | evaluator真实消费decision；status、event、audit对齐同一evaluation identity、operator与decision，authority缺口如实显示 | taskTree status投影、event/audit通道 | U14 | 未要求的exactly-once、第二日志或全局sequencer |

## C. 跨簇接缝

| 接缝 ID | 连接的保证 | R10 引用规则 |
|---|---|---|
| **X01** | F03–F05 ↔ F30 | CAP-4运行态投影进入同一status snapshot/boundary；不得另建parallel status wire。F18 attempt artifact可经独立typed artifact route消费，不要求进入status |
| **X02** | F07–F09 ↔ F22/F25–F29 | context、mutation、capability共享typed transport合同；领域error不压成“daemon down” |
| **X03** | F11–F15 ↔ F17/F27/F30 | events提供可见与诊断通道；domain档拥有payload/结果语义，不以outbox或共同commit为前提 |
| **X04** | F16–F21 | artifact生命周期不替CAP-2 definition可达；scalar artifact不替CAP-3 typed seam；D11仍只看current compile |
| **X05** | F22–F24 ↔ CAP-6 | RFC只消费upstream ArkType boundary；外部shape到达后派生，不从内部full-list倒推 |
| **X06** | F25–F30 | CAP-4加入同一F façade并复用operator/daemon裁判与逐verb最小结果语义 |
| **X07** | F01–F05 ↔ F11–F15 | SQLite status与events是独立数据面；各自保证真实来源，不构造跨介质全局snapshot |

## D. 仍未证明的运行项

| 未知 ID | 未证明项 | 影响边界 |
|---|---|---|
| **U01** | Bun/SQLite在live WAL上满足strict read与sidecar byte/metadata中立的具体配置 | 需在实现前最小spike；不得放宽F01 |
| **U02** | 真实历代SQLite盘、特殊/网络FS、migration中断样本全集 | 决定F01/F02兼容矩阵，不新增通用迁移需求 |
| **U03** | 生产writer频率、最大taskTree深度/节点数、read snapshot寿命 | 性能与并发验证参数 |
| **U04** | 活chain全部optional wire分支及历史`extra`冲突分布 | D3 shape diff/golden输入 |
| **U05** | 跨用户pid/socket/`ps`权限errno与PID复用实况 | 三证failure分类样本 |
| **U06** | 合理client deadline及取消时Bun socket的真实销毁行为 | F07运行证明；不生成server cap |
| **U07** | mutation已提交但response丢失的生产频率、各verb失败窗口 | 风险与UI文案输入；不生成durable operation |
| **U08** | 真实events历史payload、坏行/partial/三代filename组合 | F11最小兼容/韧性处理输入 |
| **U09** | 生产多writer重叠频率、normal rotation与reader交错规模 | F12/F13压力参数；不生成crash journal |
| **U10** | 真实浏览器SSE在daemon kill、client abort、mesh链路下的资源行为 | F14专项E2E |
| **U11** | fresh/普通resume/finalizer及artifact写失败的真实runner全路径 | F16–F18专项验证 |
| **U12** | 真实definition历史分布、仓外hash消费者、repository可达性/GC实现 | F19/F20兼容与回收参数 |
| **U13** | CAP-3精确typed shape与CAP-6实际ArkType request/result/error、pagination/filter | 以typed seam接入，不阻塞R10 |
| **U14** | 四mutation verb、三context scope及CAP-4三decision的真实HTTP/浏览器/status/events/audit全路径 | 最终专项E2E与fixture输入 |
| **U15** | gateway spawn daemon后进程脱离、死态start、stop/restart及三证翻绿的真实本机/浏览器路径 | F10专项E2E；不生成通用supervisor |

## E. 禁止升级为地基主张

1. 不声称status与events/process具有跨介质同一时点。
2. 不把response/server caps、server idle/handler deadline或connection cap列为S2交付门槛。
3. 不把daemon start改写为socket RPC，不引入通用process supervisor，也不让spawn daemon生命周期依附gateway。
4. 不预建通用events schema-version、历史migration、crash journal、断线replay、`Last-Event-ID`或restart cursor。
5. 不把fallback物理文件全部并入统一三流历史，不声称跨流因果全序。
6. 不把D11扩成historical-pinned或current+pinned双视图。
7. 不猜CAP-3/CAP-6 shape、TTL、永久保留、cursor或error字面量；只保留typed seam。
8. 不把context write recovery、auth/audit、bad-row跨页snapshot等调查风险变成RFC #544合同。
9. 不要求operator认证重构、全面封store、durable operation、共同commit、outbox/saga/command log、known-outcome或exactly-once。
10. 不用resume/unblock/改join替代CAP-4 decision，不为CAP-4另建第二日志或授权系统。

## F. 证据索引

- 稳定条款：`AGG-544-gui-observability-gateway.md` D1–D3、D5–D12、D13、CAP-1–CAP-7、F档与代码红线。
- R8档案：`decision-S1-status-544.md`–`decision-S7-cap4-544.md`。
- 收口核算：`detail-investigation-audit-544.md`、`decision-dossiers-audit-544.md`。
- R7事实：`detail-I01-544.md`–`detail-I15-544.md`；分别支撑S1(I01–I03)、S2(I04–I05)、S3(I06–I09)、S4(I10–I11)、S5(I12)、S6(I13–I14)、S7(I15)。
