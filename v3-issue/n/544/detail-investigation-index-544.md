# RFC #544 R6 逐细节调查索引

核算基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
唯一事实输入：`supply-ledger-544.md`；稳定条款名称仅引用 `AGG-544-gui-observability-gateway.md`。本文不补充源码事实，不提出实现选项、推荐、工作量或 issue/PR 边界。

## A. 主 agent 摘要

- **索引数量：15。** 它们不是把 38 条总账机械拆成 38 个任务，而是按“同一未知会共同改变哪一类保证的事实判定”合并；写提交与读恢复、当前缺陷与纯证明缺口、引擎供给与未来 gateway 消费责任仍保持分开。
- **主要问题簇：** status/SQLite（I01–I05）、events（I06–I09）、attempt/read API（I10–I12）、mutation/decision（I13–I15）。
- **覆盖：** 总账 L01–L38 全部进入“需 R7 索引”或“无需 R7”之一；资产和测试条可作为某索引的既有证据/证明面被覆盖，但不单独生成调查；纯未来 gateway 责任不倒记为当前供给调查。
- **依赖批次：** 第一批 I01、I02、I04、I05、I06、I07、I10、I12、I13 可并行；第二批 I03、I08、I11、I14 只依赖第一批建立的边界/身份事实；第三批 I09、I15 分别依赖事件目标可见性与 decision 契约事实。批次仅表达事实输入顺序，不暗示修补结论。
- **gate：** R7 只能回答各索引列明的可证伪事实问题。没有形成代码/数据/运行证据前，静态未知不得升级为缺陷；没有稳定条款依据，不得把候选机制写成需求。

## B. 完整索引

### I01 — SQLite 严格只读与失败分类

- **稳定条款：** D1「严格只读 status snapshot 入口」；D5 对 D1 入口的消费约束。
- **总账观察：** L01（现 opener 会 WAL/迁移）、L02（mismatch 缺失且错误折叠）、L09（Bun/WAL/权限/历史盘行为未知）；L10 中 D1 测试盲区。
- **证据不足：** 已知调用违反严格只读，但平台实际打开、journal/schema 副作用与各种现存盘错误如何区分尚未用运行事实钉住；这些事实会改变可稳定声称的 daemon-down 与磁盘中立边界。
- **所需调查：** opener 到 snapshot 的代码调用链、Bun/SQLite 当前版本行为、代表性缺盘/旧 schema/只读权限/WAL 历史盘数据矩阵，以及重复读取前后的文件与 schema 观测。
- **可能涉及层：** SQLite opener、schema/version parser、snapshot error boundary、CLI/route 消费；不预设根因在哪层。
- **独立性与接缝：** 需独立 subagent，因为包含平台运行实验且必须避免被静态代码结论替代。可与 I02/I04 并行；I03 的一致性实验应复用其已确认的 opener 语义。

### I02 — status 精确 boundary 与最终 wire 等价性

- **稳定条款：** D3「status snapshot 精确 schema boundary」。
- **总账观察：** L03（七槽匿名 object、平行 TS shape、生产 boundary 不导出）、L04（assert 后 replacer 再改写）；L10 的七槽负例与 wire reparse 盲区。
- **证据不足：** 总账证明“非单源”和“验证对象非最终 wire”，但未建立每个变换点、七槽实际输出集合及 CLI/未来 route 是否共享完全相同的边界；这些事实决定能否作出精确 schema 与 wire 等价主张。
- **所需调查：** status 构造、parse/assert、serialization/replacer、CLI 输出的完整代码数据流；采集各槽正反例并对最终 JSON 重新解析的运行实验。
- **可能涉及层：** domain snapshot、boundary/parser、serialization、CLI adapter；不预设哪层拥有最终 shape。
- **独立性与接缝：** schema 身份问题与 SQLite 副作用正交，需独立 subagent。可与 I01/I04 并行；为 I03 提供可观测快照字段边界。

### I03 — status/task-tree 单时点事实

- **稳定条款：** CAP-1 任务树快照 shape；D3 对 CAP-1 的集成；D9 任务树钻取。
- **总账观察：** L05（多连接/语句、递归读取无显式 read transaction）、L06（task-tree 精确 ADT/持久化资产）、L10（并发一致性测试缺失）。
- **证据不足：** 静态路径能显示可能撕裂，却未证明具体并发交错、哪些槽共享或不共享 snapshot、以及 task-tree 递归读的可观测断裂；这会改变“同一事实源/单时点”主张的实际边界。
- **所需调查：** snapshot 与 task-tree 所有 DB read 的连接/事务时间线，受控 writer 穿插实验，记录可复现的跨提交组合与不可出现组合。
- **可能涉及层：** snapshot orchestration、SQLite transaction、task-tree repository、boundary 输出。
- **独立性与接缝：** 需要专门并发实验，不能并入 schema 调查。依赖 I01 确认 opener/SQLite 行为，消费 I02 的输出观测边界；之后可独立完成。

### I04 — daemon 三证独立性与活性语义

- **稳定条款：** D7「daemon 活性首屏与生命周期控制」。
- **总账观察：** L07（pid 缺失、ps 与 socket/RPC 折叠、missing 丢弃、connect/应答不分、daemon.status 信息缺失）；L10 的三证组合盲区。
- **证据不足：** 总账列出投影缺失，但未逐项建立 pid/process/socket/RPC 在真实存活、陈尸、权限拒绝和不应答状态下的独立观测值及组合；不做该矩阵无法稳定解释“活着/可连接/可应答”。
- **所需调查：** 三证探针代码链与状态压缩点；真实 daemon、陈尸 pid/socket、权限失败、接受但不应答等运行矩阵及 status 输出。
- **可能涉及层：** pid/process probe、socket probe、daemon.status RPC、status projection、GUI 消费契约。
- **独立性与接缝：** 它回答证据语义，不回答 transport 安全，故与 I05 分开。可并行；I05 的超时事实可作为某些矩阵输入。

### I05 — socket transport 有界失败与响应身份

- **稳定条款：** D5「socket RPC typed client」；D7/D8 的 RPC 消费边界。
- **总账观察：** L08（无 timeout/取消、response id 不核对、response 无大小上限、高层错误 ADT不导出）；L33 中 socket fault 盲区。
- **证据不足：** 已知保护缺失，但未建立 client/server framing、连接生命周期、半开与超大/错 id 响应的实际行为，以及哪些调用共享同一 transport；这些事实会改变可承诺的失败有界性和错误分类。
- **所需调查：** transport/client/server parser 完整链；不应答、断流、错 id、超大响应、错误 envelope 的受控 socket 实验，并核对所有高层调用传播结果。
- **可能涉及层：** socket framing、RPC client/server、boundary ADT、status/mutation adapters。
- **独立性与接缝：** transport 是 status 与 mutation 共用先决事实，需单独 subagent 防止两边重复调查。可首批并行；I13/I14 引用结果但不重复实验。

### I06 — events 契约身份与 schema 兼容边界

- **稳定条款：** 4.3「已合入的 events 消费契约」；D6 events 消费。
- **总账观察：** L11（精确 ADT/parser 资产，当前 52 type；与 AGG 44 的契约漂移）、L14（坏行/partial/旧 schema 使 query throw，legacy 仅文件名兼容）。
- **证据不足：** 现有报告同时记录精确资产与数量漂移，却未建立稳定条款所指词表与当前 parser 的逐 variant 对应关系，也未区分 envelope、文件名和事件 payload 的兼容边界；这会改变“精确契约”可被消费的范围。
- **所需调查：** 稳定契约文本与当前 event ADT/parser/fixtures 的逐项映射；各类历史 envelope、未知 type、坏行、尾 partial 的读取实验。
- **可能涉及层：** event ADT、envelope/version parser、segment filename parser、query boundary、契约文档。
- **独立性与接缝：** 契约身份先于恢复/实时语义，需独立 subagent。可与 I07 并行；为 I08/I09 提供可解析事件集合。

### I07 — events 写入提交、并发与崩溃事实

- **稳定条款：** 4.3 events 契约；D6 的 rotate/reconnect 保证所依赖的写侧事实。
- **总账观察：** L12（无 owner 约束/锁并可争 sequence/rename）、L13（rename 与 append 分离、无 fsync/marker、错误可吞）、L17（真实并发、append 持久性、kill 点未知）；L19 写侧测试盲区。
- **证据不足：** 静态窗口已知，但 writer 实际调用并发、系统调用边界和 crash 后磁盘状态没有证据；这些事实决定哪些丢失/重复/不可见状态是真实可达的。
- **所需调查：** 所有 writer 调用与同步关系、rotate/append 系统调用序列；并发 writer/reader、逐系统调用点 kill、重启后 segment/sequence/readback 的运行实验及真实工作负载频率数据。
- **可能涉及层：** daemon writer ownership、sequence 分配、filesystem append/rename/fsync、错误传播。
- **独立性与接缝：** 这是写侧因果链，不能与 reader 恢复混成一个结论。首批可并行；I08 需其确认的可达磁盘状态。

### I08 — events 跨 segment 顺序与 cursor/reconnect

- **稳定条款：** D6「events 增量读取与实时推送」；4.3 events 契约。
- **总账观察：** L14（读到坏/旧内容全量失败）、L15（legacy/new、same-ts、三流无全局序）、L16（无 cursor/tail/watch recovery）；L19 的 cursor/watch/多流盲区。
- **证据不足：** 当前 full query 缺口明确，但 segment 发现次序、同 timestamp 稳定性、rotate 边界与 watcher 通知在真实 reader 中如何组合尚未形成运行证据；不能据此声称 reconnect 的丢重性质。
- **所需调查：** discovery/order/query 与所有潜在 tail/watch 消费链；在 I07 已确认的 rotate/crash 状态上执行断连、重连、跨日/跨阈值、same-ts、通知合并/丢失实验并核对事件集合和次序。
- **可能涉及层：** segment discovery、query parser、cursor identity、filesystem watch、SSE 前置供给。
- **独立性与接缝：** reader continuity 依赖 I06 的合法事件集合和 I07 的可达写侧状态，故置于第二批；与 I09 的“哪些流应可见”分开。

### I09 — failure streams 目标可见性

- **稳定条款：** D6 的实时事件展示；2.2 关闭验证中的事件可见性要求；4.3 events 契约。
- **总账观察：** L15 已知主流不含 lifecycle/runner failure 两流；L18 明确“不知道稳定目标是否要求合并”；L19 多流测试缺口。
- **证据不足：** 这是稳定主张的范围缺口而非源码未知。未逐条核对 D6/关闭验证/4.3 对“events”的集合定义前，无法判定三流差异是偏离还是合法边界。
- **所需调查：** 只做权威文本追踪：把稳定条款中的事件集合、failure/lifecycle 可见性与三流现状逐句映射；若文本要求运行证据，再用已有流数据核对可见性，不发明新要求。
- **可能涉及层：** 稳定契约、event stream ownership、D6 消费面；不预设必须合流。
- **独立性与接缝：** 需要独立 subagent避免把代码现状倒推为需求。依赖 I06/I08 给出各流事实后进行；结论只裁定调查范围，不产生方案。

### I10 — attempt 快照、pinned definition 与 typed binding 因果链

- **稳定条款：** D2；D10；CAP-2；CAP-3。
- **总账观察：** L20（不落 prompt/bindings，retry/restart 重渲染）、L21（hash 有而 definition 不可解引用）、L22（最终值 string）、L24 中 CAP-2 retention/GC 与 CAP-3 additive shape 未决；L25/L26 为现存 compile/identity/prompt 资产。
- **证据不足：** 已知终态缺失，但 attempt identity、definition materialization/prune、render、runner argv、retry/resume/restart 的精确时序和数据所有权未被统一追踪；不掌握该因果链就无法判断历史同一性可被怎样证明。
- **所需调查：** 从 definition identity/materialization 到 attempt 创建、render、spawn、artifact 目录、retry/resume/restart、prune 的完整代码与持久数据追踪；固定 definition 后修改同路径 preset 的最小运行实验，核对 argv、身份和磁盘产物。
- **可能涉及层：** preset loader/materialization、scheduler、attempt identity、prompt renderer、runner adapter、artifact storage。
- **独立性与接缝：** 多条症状共享“attempt 所属定义实例”这一因果边界，合并为一个 subagent可避免相互矛盾；与 context/compile 消费语义分开。首批可执行。

### I11 — D11 对 pinned definition 的消费语义

- **稳定条款：** D11；CAP-2；CAP-7。
- **总账观察：** L24 明确 D11 对 CAP-2 的消费语义未由现状/AGG 依赖行说明；L25 表明 compile 只表达当前定义态，不能替代 historical/pinned；L21 提供不可解引用现状。
- **证据不足：** 稳定条款只记依赖而未说明消费方式；在目标语义未确定时，源码调查不能判定当前 compile projection 是否偏离。
- **所需调查：** 权威文本中 D11/CAP-2/CAP-7 的所有定义与引用链；结合 I10 已确认的 identity/materialization事实，明确哪些主张有文本依据、哪些仍为未裁决，不补造 shape。
- **可能涉及层：** 需求契约、compile command/projection、definition resolver、GUI metadata consumer。
- **独立性与接缝：** 这是纯契约缺口，需独立于 I10 的当前实现事实。第二批依赖 I10；若权威文本仍无定义，应保持未知而非提出选项。

### I12 — context read boundary 与写入一致性

- **稳定条款：** CAP-6；D12。
- **总账观察：** L23（strict ADT/table/internal list 存在，但无外部 read/权限/分页/filter；append session/DB/event 有非原子重试窗口）、L24 中 CAP-6 分页/filter shape 未决；L26 资产；L27 测试绕过外部 boundary。
- **证据不足：** read boundary 的缺失明确，但 scope/author/envelope 现有数据量、写入后可见性和失败重试的真实状态尚未从外部消费视角建立；分页/filter shape 又明确归外部能力所有，不能由本调查猜测。
- **所需调查：** context schema/store/list/append/session/event 的代码与持久数据流；按 scope/author 的代表性数据、失败注入与重试后 DB/event/session 对账；只记录 CAP-6 已明示的 boundary 事实。
- **可能涉及层：** context repository、daemon/operator read surface、authorization、pagination boundary、event/session side effects。
- **独立性与接缝：** context 有独立数据模型和外部能力 owner，需独立 subagent。可首批并行；不与 mutation 一般原子性混并。

### I13 — mutation 闭集、主体与准入绑定

- **稳定条款：** D5 typed client；D8；F 档写动作闭集。
- **总账观察：** L28（大 command 闭集、string+JsonObject、F 无独立 subset/client、CLI 平行清单）、L29（无凭证=operator、缺 peer identity、store 可旁路、reorder target 未绑定）；L31 可保留 dispatch/identity/happy-path 资产；L33 准入/并发盲区。
- **证据不足：** 已知边界过宽与旁路存在，但尚未逐 command 建立 wire parse→auth→handler→store 的实际可达路径，也未证明 caller identity 与 target binding 的所有组合；这些事实决定“唯一裁判”和“编译期闭集”能否稳定陈述。
- **所需调查：** daemon command registry、auth classification、credential resolution、CLI/client command lists、四 verb handler与所有直接 store caller 的完整路径；operator/agent、跨 item/chain、绕过 socket 的运行矩阵。
- **可能涉及层：** command ADT/parser、socket auth、handler dispatch、store API、CLI/client adapters。
- **独立性与接缝：** 它调查准入与可达性，不调查跨副作用提交，故与 I14 分开。可首批进行并复用 I05 transport 事实。

### I14 — mutation 跨副作用、竞态与重试结果

- **稳定条款：** D8；F 档四动作的生效与审计要求。
- **总账观察：** L30（DB/run termination/events/RPC 跨副作用、无 request-id/CAS/串行锁、重试不能补缺）；L31 的 IMMEDIATE transaction/audit 资产；L33 并发、fault、幂等盲区。
- **证据不足：** 总账指出事务边界分裂，但四个 verb 各自副作用次序、失败点、并发冲突和重试后终态未被运行实验穷尽；不同 verb 不能从一个 happy path 外推。
- **所需调查：** 四 verb 的 handler→DB→scheduler/process→event→reply 时间线；并发相同/相反请求、连接断开、event/terminate/store fault、重复请求实验，并对账 DB、进程、队列、event、audit 与 RPC 结果。
- **可能涉及层：** handler orchestration、SQLite transaction、scheduler/process control、event writer、RPC response。
- **独立性与接缝：** 需要专门 fault/concurrency harness，且先由 I13 钉住哪些入口与主体合法；因此第二批执行。

### I15 — CAP-4 decision 契约与现存 join 身份

- **稳定条款：** CAP-4；D8 operator decision；D13 移动端入口；F 档 decision operation。
- **总账观察：** L32 的 CAP-4 部分（仅初始化 join 行，无 decision ADT/capability/operation/consumer）；L31 的 join PK/FK/epoch/bindingVersion 资产；L33 无 CAP-4 operation 测试。
- **证据不足：** “join 行存在”不能证明 evaluation identity、epoch、capability 与 decision operation 如何对应；未建立现存 identity 生命周期与稳定 CAP-4 字段的逐项映射前，无法区分可复用事实和真正缺失。
- **所需调查：** CAP-4 权威字段/状态转换与现有 join/evaluation/epoch 数据模型、写读路径的逐项映射；构造 epoch 变化、重复/过期 decision、无 capability 的数据/运行观察，只记录实际接受与拒绝。
- **可能涉及层：** join/evaluation schema、scheduler gate、capability query、mutation operation、audit/events。
- **独立性与接缝：** decision 是独立状态机，不能塞进一般 mutation 四 verb 调查。第三批依赖 I13 的主体/准入与 I14 的副作用边界事实。

## C. 无需单独 R7 的账项

| 总账 ID | 无需单独 R7 的理由 |
|---|---|
| L06 | 纯 task-tree 资产；仅作为 I03 的既有输入，不产生新的事实缺口。 |
| L10 | 纯测试盲区；其每一盲区已分别进入 I01–I04 的所需实验，不单设“测试调查”。 |
| L19 | 纯 events 测试盲区；已由 I06–I09 按因果边界覆盖。 |
| L25 | 纯 compile projection 资产；其“当前定义态”边界由 I10/I11 消费，不单查资产。 |
| L26 | 纯 identity/context/prompt 基础资产；分别由 I10/I12 消费。 |
| L27 | 纯 read API 证明盲区；D1、attempt、compile、context 已分配到 I01、I10–I12。 |
| L31 | 纯 mutation/join 资产；分别为 I13–I15 的输入。 |
| L32（lifecycle 部分） | `up/down/start/stop/restart` 的词义偏离已经由总账明确，且稳定 D7 条款明确；没有尚待事实会改变该偏离的定性。CAP-4 部分另由 I15 覆盖。 |
| L33 | 纯 mutation 测试盲区；已按 transport、准入、跨副作用、decision 分配 I05、I13–I15。 |
| L34 | 纯未来 gateway 单-root/HTTP trust 责任，不是当前供给缺陷。 |
| L35 | 纯未来 gateway host/SSE/双进程生命周期责任；当前 events/socket 先决缺口已由 I05/I08 调查。 |
| L36 | 纯 gateway 导入/path 原料资产，不单独调查。 |
| L37 | gateway 尚不存在，故无现存 route/runtime E2E 对象；不是已实现功能的测试缺口。 |
| L38 | 纯未来 HTTP 映射责任；当前 socket/mutation 供给事实已由 I05/I13 调查。 |

## D. 38 条总账全覆盖矩阵

| 总账 ID | R6 归属 | 总账 ID | R6 归属 |
|---|---|---|---|
| L01 | I01 | L20 | I10 |
| L02 | I01 | L21 | I10（亦为 I11 输入） |
| L03 | I02 | L22 | I10 |
| L04 | I02 | L23 | I12 |
| L05 | I03 | L24 | I10（CAP-2/3）、I11（D11）、I12（CAP-6） |
| L06 | 无需单独 R7：I03 资产输入 | L25 | 无需单独 R7：I10/I11 资产输入 |
| L07 | I04 | L26 | 无需单独 R7：I10/I12 资产输入 |
| L08 | I05 | L27 | 无需单独 R7：I01、I10–I12 已覆盖 |
| L09 | I01 | L28 | I13 |
| L10 | 无需单独 R7：I01–I04 已覆盖 | L29 | I13 |
| L11 | I06 | L30 | I14 |
| L12 | I07 | L31 | 无需单独 R7：I13–I15 资产输入 |
| L13 | I07 | L32 | lifecycle 无需；CAP-4→I15 |
| L14 | I06（schema/坏内容）、I08（恢复） | L33 | 无需单独 R7：I05、I13–I15 已覆盖 |
| L15 | I08（顺序/多流现状）、I09（目标范围） | L34 | 无需 R7：纯未来责任 |
| L16 | I08 | L35 | 无需 R7：纯未来责任 |
| L17 | I07 | L36 | 无需 R7：纯资产 |
| L18 | I09 | L37 | 无需 R7：纯未来证明责任 |
| L19 | 无需单独 R7：I06–I09 已覆盖 | L38 | 无需 R7：纯未来责任 |

覆盖计数：38/38；遗漏 0；没有把资产、测试盲区或未来消费责任伪装成独立缺陷。

## E. 建议 R7 派发批次（仅事实依赖）

1. **第一批，可并行：** I01、I02、I04、I05、I06、I07、I10、I12、I13。它们各自能从当前总账直接开始，所需事实面互不构成前置结论。
2. **第二批：** I03（等待 I01/I02 的 opener 与观测边界）；I08（等待 I06/I07 的合法事件集合与可达磁盘状态）；I11（等待 I10 的 pinned identity/materialization 事实）；I14（等待 I13 的合法入口/主体集合，并复用 I05 transport 事实）。
3. **第三批：** I09（在 I06/I08 钉住三流与可见行为后只裁定稳定条款范围）；I15（复用 I13 主体/准入及 I14 副作用事实，调查独立 decision 状态机）。

批次不表示优先级、实现顺序或修改归属；若前一批仍产出“未知”，后一批必须保留该未知，禁止用候选设计填空。
