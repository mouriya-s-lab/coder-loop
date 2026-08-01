# RFC #544 R8 / S6 — GUI mutation 写面决策档案

> 事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。输入为 AGG D5/D8/F档、`detail-I13-544.md`、`detail-I14-544.md`、I05 transport摘要与R7收口；未重读源码、运行实验、实现、估算或拆 issue。

## A. 主 agent 摘要（≤一页）

稳定设计对本片只固定以下结果：

1. GUI写方法集合**恰为F档**，不暴露create/add/batch等范围外入口；
2. gateway使用引擎派生的typed client，不裸写socket、不复制command shape；
3. gateway不持有agent credential，按既定operator主体调用；
4. daemon是合法性唯一裁判，gateway不另建第二套授权判断；
5. `queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder`四动作真实可用；
6. 接受、拒绝与执行失败明确呈现，并能通过status/events核验结果。

当前21-command服务端闭集、daemon spec/auth/handler registry、active-run credential校验、四verb handler、store事务和事件类型均是可保留资产。当前缺口是没有从引擎单源派生F typed façade，部分target准入与动作后错误会使结果表述不准确，四动作也缺少逐verb的最小结果验证。

R7曾把调查揭示的强化方向提升成RFC前提：重新建立正向operator认证、全面封锁store mutator、持久operation identity、timeout后查询/重放、outbox/saga/command log以及跨介质全局known-outcome。稳定设计没有要求这些机制或强度；它们只能作为风险、可选强化或实现候选，不能进入修补后地基的必备保证。

因此本档无操作员裁决、无owner gate。R9只需选择满足F档、typed client、既定operator调用、daemon裁判和四动作最小错误传播/结果可观察性的工程形态。

## B. 完整档案

### B1. 稳定要求与当前事实

| 对象 | 稳定要求 | 当前事实 | R9判定 |
|---|---|---|---|
| GUI surface | 方法集合恰为F | daemon有21-command大闭集，当前无F typed façade | 必须建立引擎派生的F投影；不删服务端其他命令 |
| typed client | args/result/error由引擎类型单源派生 | wire仍以宽`command + JsonObject`调用，CLI另有归因表 | GUI/gateway不得裸socket或复制shape |
| operator主体 | 零agent credential的gateway按既定operator主体调用 | 当前缺credential即归operator；agent CLI漏附credential存在升级反例 | gateway路径沿既定operator调用；不把重建正向认证扩成RFC要求 |
| daemon裁判 | GUI不自裁合法性 | daemon有auth gate；direct store与脚本旁路存在 | GUI所有F动作经daemon；全面封store是范围外强化 |
| 四动作 | unblock/stop/resume/reorder真实可用 | 均有handler，但存在target、错误传播、DB/process/event时序差异 | 逐verb定义最小accepted/rejected/failed结果并用status/events核验 |
| transport | typed错误与响应边界 | I05记录deadline/cap/id等风险 | S2提供typed transport；S6不生成durable known-outcome要求 |

### B2. F闭集与typed façade

21-command daemon registry是服务端完整协议资产；F只是GUI mutation子集，两者不冲突。事实支持两类工程放置：

| 形态 | 必须证明 | 确定后果 |
|---|---|---|
| 显式F operation ADT | 每个F动作有精确args/result/error variant，façade exhaustive dispatch | 新daemon command不会自动进入GUI，范围外入口类型不可达 |
| registry metadata派生F | command registry标注GUI mutation surface，并派生ADT/client | command、auth与GUI surface保持单源，避免复制字符串表 |

两类都必须覆盖F档完整集合；只在gateway手写四个command字符串或暴露任意`DaemonCommandName`均不能证明“恰为F”。具体生成方式是工程选择。

### B3. 既定operator主体与daemon裁判边界

- gateway使用零agent credential的operator调用，这是稳定设计，不重新发明peer/session/token认证体系。
- agent credential存在时仍由daemon按既有run/phase/target事实裁决；I13的same/cross-target反例说明具体handler必须在副作用前完成其既定target检查。
- GUI/gateway不直接调用store；生产服务对外写入口经daemon即可满足本RFC。是否进一步以模块可见性、capability handle或store接口拆分封住所有脚本/tests/import，是工程治理强化，不是RFC #544保证。
- admission event证明一次准入判断，不自动证明动作完成；动作结果仍须由typed response以及随后status/events的可观察事实共同表达。

本片不要求“正向证明所有本地调用者都是operator”，也不要求把所有内部scheduler/maintenance写入口迁成daemon RPC。

### B4. 四动作的最小结果语义

| 动作 | 已有路径 | 为满足稳定验收必须明确的最小结果 | 核验面 |
|---|---|---|---|
| `chain.stop` | 写stopped后终止活动run/child并发事件 | accepted/rejected/failed可区分；成功后status显示stopped，相关事件可见 | status chain/current + stop/status events |
| `chain.resume` | 写active并触发后续scheduler tick | accepted/rejected/failed可区分；成功后status显示active；不把“已spawn新child”额外设为同步保证 | status chain + resume/status events |
| `queue.unblock` | 更新item并可能清current run | not-unblockable与成功/失败明确；成功后的item/current状态可读 | status queue/current + admission/action events |
| `item.reorder` | 事务重排queue后发事件 | target非法在写前拒绝；成功/失败明确；最终顺序可读 | status queue + reordered/admission events |

最小错误传播要求：handler已知失败不得序列化为成功；成功响应对应的核心状态改变必须可从status读回；事件用于核验和诊断，但本RFC不要求SQLite与JSONL跨介质原子提交、持久重放或全局exactly-once。

### B5. 调查风险与可选强化

| 调查发现 | 正确分类 | 本RFC不得据此声称 |
|---|---|---|
| 缺credential可被部分agent入口误归operator | agent调用路径的真实风险 | 必须重建operator认证、拆endpoint或引入peer identity |
| exported store mutator可绕过daemon | 内部治理/旁路风险 | 必须全面封store才能交付GUI写面 |
| request id不持久、断连后结果不明 | transport/重试风险 | 必须建operation journal、查询或重放协议 |
| DB/process/event/RPC存在分步窗口 | 四动作需定向错误传播验证 | 必须采用outbox、saga、command log或全局known-outcome |
| 并发stop/resume、reorder后提交者决定状态 | 工程并发语义 | 必须建立全局sequencer、CAS或幂等键 |

这些机制若未来由更强需求选择，必须另有需求来源和运行证据；本档案不把它们列为完整形态门槛。

### B6. 具体触点与验证面

| 责任 | 已定位触点 | 后续最小证明 |
|---|---|---|
| command/type单源 | `src/daemon.ts` command tuple/spec/dispatch；`src/loop.ts` client helper | F方法集合exact；范围外command不可从GUI client调用；args/result/error exact parse |
| operator调用 | gateway operator client、daemon caller resolution | gateway不附agent credential；daemon按operator路径接受合法F动作 |
| target准入 | 四verb auth/handler gates | wrong chain/item/root在副作用前typed reject；合法目标accepted |
| 四动作 | stop/resume/unblock/reorder handlers与store/scheduler接缝 | 每verb success/reject/failure；成功后status最终值；相应events可核验 |
| 前端 | mutation façade与UI action registry | 无裸socket、无create/add/batch；错误可见；动作后刷新status/events |

验证只需真实触发四动作及其关键拒绝/失败路径，并观察status/events最终结果。故障注入用于证明已选择的错误传播，不自动升级为跨介质持久提交系统。

### B7. 决策分类

| 类别 | 结论 |
|---|---|
| 已定必须交付 | F档exact surface、引擎派生typed client、既定operator调用、daemon唯一合法性裁判、四动作可用、结果与错误可观察 |
| 操作员裁决 | 0 |
| owner gate | 0 |
| 工程形态 | 显式F ADT或registry派生；四verb各自最小错误传播与status/events核验 |
| 风险/可选强化 | operator认证重构、全面封store、durable operation/idempotency、query/replay、outbox/saga/log、全局known-outcome、CAS/sequencer |
| 仍未知 | 仓外调用者、风险生产频率、具体错误variant命名、并发策略；均不改变稳定交付面 |

### B8. 证据索引

- F档、D5、D8：`AGG-544-gui-observability-gateway.md`
- command surface、caller/target/store旁路：`detail-I13-544.md`
- 四verb副作用与故障窗口：`detail-I14-544.md`
- transport风险：`detail-I05-544.md`
- R7分类：`detail-investigation-audit-544.md`
