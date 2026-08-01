# RFC #543 · R10 evaluation scope / journal / recovery 需求侧报告

> 证据边界：只读 `01-clauses.md` 的 B3–B4、I4–I5、J，`23-expected-foundation.md`，以及 `06`、`12`、`14`、`15`、`21` 的既有摘要。本文只推导需求，不选择 schema、table、outbox、drainer、锁、队列或模块签名；不把既有同名状态当作实现证明。

## A. 摘要

gate evaluation 必须有一个持久、类型化、可恢复的权威链条：稳定 point identity 下的 epoch，epoch 内的 execution/delivery identity，typed decision ingress，decision 与引擎内 pending intent 的原子建立，以及 outcome/consumption 的持久推进。恢复只根据该权威状态行动，不能依赖原 scheduler point、原 socket 请求或当前 preset 路径偶然重现。

判定脚本可在 evaluation scope 中先经现有 operator CLI 创建 correction。该 mutation 与随后 decision 消费不是同一事务；因此它必须靠 evaluation-scoped 幂等 admission、首次 response 快照和 audit correlation 保持可重放。`reopen` 的 claim、target、cursor、budget 与 consumed effect 则由 RFC-1 权威在消费事务中全有或全无。外部文件、Git、事件 sink、数据库或第三方 effect 只记录 attempt/outcome；本文不主张回滚、跨系统事务或 exactly-once。

需求集合共 **26 项**：既有地基可承接 **5**，#543 本能力必须自建 **16**，外部 blocker **5**（RFC-1：3；RFC-2：2）。这些分类说明实现责任与供给接缝，不表示任何一项已实现或已通过运行验证。

## B. 语义模型

### B1. 身份与代次

- **Point identity**：决策点 variant 与宿主稳定 identity 的类型化积；不能用显示名、metadata 路径或偶然 scheduler 调用栈代替。
- **Epoch**：某 point identity 的单调代次。epoch 只在本代 decision 的引擎内效果完成消费后递增；重启、超时、非法输出和残留 `evaluating` 都不自行换代。
- **Evaluation identity**：`(point identity, epoch)`，是 evaluation scope、mutation 幂等、decision ingress、恢复与审计的共同关联根。
- **Execution identity**：判定主体的一次真实执行 attempt。重问产生新 execution identity，但仍归属同一 evaluation identity，直至该 epoch 被消费。
- **Delivery identity**：一次待推进的引擎内交付/效果意图的稳定身份。重启重派保持 delivery identity，attempt identity 可变化。

identity 必须贯穿 typed ingress、payload/env、journal、CLI admission response、audit/event/diagnostic。滞后 decision 除 evaluation identity 外还须匹配当前 execution identity；旧 attempt 不能覆盖新 attempt 的准入结果。

### B2. decision、outcome 与 terminal

decision 只从 kind-specific typed ingress 进入：script 经 stdout boundary，未来 validator 经 default-deny admission；两者提交同一 decision ADT、同一 journal/consumer，不复制状态机。decision 的“准入成功”仅表示其已成为该 epoch 的唯一权威判定，不等于效果已消费。

outcome 是引擎拥有的 attempt/delivery 推进结果，包括协议拒绝、已持久化 pending、效果成功或确定失败。`terminal/consumed` 只证明所有引擎拥有的 durable transition 与 delivery outcome 已记录；它不证明外部 effect exactly-once、可撤销或与 SQLite 原子。

### B3. evaluation-scoped operator mutation

判定主体仍以 operator 身份调用既有 CLI，stdout 不承载 mutation。引擎向执行环境注入不可伪造的 evaluation scope，CLI 请求自动携带该 scope。幂等 key 由 evaluation identity、command 与规范化 args 导出：命中返回首次 response 的类型化快照且零副作用；miss 时 mutation 与 key/response 在同一引擎事务提交。

普通 operator 请求不带 evaluation scope，完全绕过此幂等分支，既有 conflict 与审计语义不变。evaluation-scoped item 创建须在审计事实中携带 evaluation identity，但引擎不把非确定脚本多次创建出的不同 logical mutations 自动判为“孤儿”、撤销或合并。

### B4. 指纹与 metadata

hold fingerprint 与 epoch 正交：fingerprint 只决定已消费 hold 后，在 canonical 状态未变化时是否抑制再次询问；同 epoch 的 `evaluating` 恢复无条件重问。每个 point variant 的 fingerprint 输入只含 point identity、宿主稳定 identity、会影响该点的 canonical 状态投影和 effective declaration hash，不能 hash 全库偶然字段。

evaluation、epoch、fingerprint、decision 与 delivery authority 不写入 `chain.metadata`。任何仍需修改 metadata 的 typed mutation必须基于事务内 durable current state 原子应用，或显式返回 conflict；不得以 stale whole snapshot 成功覆盖并发写入的不相交状态。

### B5. 原子边界与恢复

spawn 前先持久化 `evaluating`。typed decision ingress 将 decision 与其第一批引擎内 pending intent 原子建立；不得出现 durable decision 已可见但必需 intent 永久缺失。消费可由后续事务推进，但每一步必须留下可恢复的 pending 或确定 outcome。

重启时：`evaluating` 残留在同 epoch 重问；`decided`/pending 不重跑判定主体，直接恢复消费；已 terminal/consumed 不再重消费。恢复推进不能依赖原触发点重现。外部 effect 的 attempt 可重复，引擎只用稳定 delivery identity 关联 attempt/outcome，不把外部真实世界纳入事务主张。

## C. 原子需求矩阵

| ID | 原子需求 | 权威证据/验收后果 | 分类 |
|---|---|---|---|
| EJ-01 | point identity 为 point variant × host stable identity 的 typed 值 | 不以字符串散名或 metadata key 代替；跨重启相同 point 可定位 | 本能力自建 |
| EJ-02 | evaluation identity 固定为 `(point identity, epoch)` | scope、journal、恢复、audit 使用同一 identity | 本能力自建 |
| EJ-03 | epoch 仅在 consumed 后递增 | crash/timeout/invalid output 不换代；同 epoch replay 不跨 key scope | 本能力自建 |
| EJ-04 | 每次判定执行有 execution identity，滞后 ingress 须匹配当前 attempt | 旧 stdout/validator result 被 typed reject，不能覆盖新 attempt | 本能力自建 |
| EJ-05 | 每个引擎内 pending delivery/effect intent 有稳定 delivery identity | restart retry identity 不变，attempt 可多次且可关联 | 本能力自建 |
| EJ-06 | spawn 前 write-ahead `evaluating` | kill 后能区分“需同 epoch 重问”而非无记录消失 | 本能力自建 |
| EJ-07 | script/validator 走 kind-specific typed ingress，但共享一个 decision ADT 与 consumer | 非 JSON、非法 point decision、stale execution 均穷尽拒绝；无第二状态机 | 本能力自建 |
| EJ-08 | 每 epoch 至多一个权威 decision | 重复/竞争 ingress 得确定 typed response，不产生双消费 | 本能力自建 |
| EJ-09 | decision 与必需的引擎内 pending intent 原子建立 | kill 后只见“都无”或“decision + pending 均有” | 本能力自建 |
| EJ-10 | pending consumption 的每一步留下 durable progress/outcome | restart 无需原触发点即可继续，terminal 后不再执行 | 本能力自建 |
| EJ-11 | terminal/consumed 只在所有引擎拥有的 outcome 已记录后成立 | status/audit 不把未记录步骤误报完成 | 本能力自建 |
| EJ-12 | evaluation scope 注入判定主体并自动进入 CLI request | 脚本无需从 stdout mutation；普通 operator 不受影响 | 本能力自建 |
| EJ-13 | mutation key = evaluation identity + command + canonical args | 同 epoch 相同逻辑 mutation 可稳定命中 | 本能力自建 |
| EJ-14 | mutation 与 key/首次 typed response 快照同事务 | replay 命中返回首次 response、DB/event/spawn 零新增副作用 | 本能力自建 |
| EJ-15 | evaluation-scoped mutation audit 携带 evaluation identity | item/command/decision/execution/delivery 可追溯关联 | 既有地基可承接 |
| EJ-16 | 普通 operator 请求不进入 evaluation 幂等分支 | `duplicate_item` 等既有语义保持 | 既有地基可承接 |
| EJ-17 | hold fingerprint 使用 per-point typed canonical projection 与 declaration hash | 状态不变抑制重问，变化后重问；不 hash 全库偶然字段 | 本能力自建 |
| EJ-18 | fingerprint 与 epoch 正交，且新 authority 不读旧 keep-active carrier | `evaluating` 恢复无条件重问；旧 metadata 不影响首次 evaluation | 本能力自建 |
| EJ-19 | typed metadata mutation基于 current durable state原子应用或显式 conflict | 双连接交错不出现双成功后 silent lost update | 既有地基可承接 |
| EJ-20 | SQLite immediate transaction/WAL 作为局部原子与持久基础能力 | transaction rollback、commit 后重开读取可作为实现底料，不冒充完整 journal | 既有地基可承接 |
| EJ-21 | 现有 operator CLI 的 typed auth/validation/audit 继续作为 mutation 唯一命令面 | hook 不继承 agent credential，不新增 stdout mutation 协议 | 既有地基可承接 |
| EJ-22 | pinned definition resolver 供给不可变定义与公共 compile projection | 同一 evaluation/delivery 重放输入不随当前路径漂移；missing/corrupt/version typed failure | RFC-2 blocker |
| EJ-23 | pinned projection/payload 能携带稳定 evaluation/execution/delivery identity并跨重启复现 | H1→source H2→restart 后旧实例仍读 H1，新实例读 H2 | RFC-2 blocker |
| EJ-24 | structured reopen authority 接收 typed decision、opaque target 与精确 correction IDs | point×decision、membership、已运行、同 seq、claim 等穷尽校验 | RFC-1 blocker |
| EJ-25 | reopen 成功时 target、correction claim、cursor/budget 与 consumed effects 全有或全无 | 合法/非法/重复/冲突/预算耗尽/kill-restart 均有 typed outcome | RFC-1 blocker |
| EJ-26 | terminal corrections 保持，consumed closure 不可被重新激活 | reopen 不改写既有 terminal item，生命周期非法路径拒绝 | RFC-1 blocker |

## D. 分类与责任边界

### D1. 既有地基可承接（5）

现有资产仅包括：operator CLI 的 typed admission/validation/audit；SQLite immediate transaction、WAL 与局部原子写；typed carrier/transaction 可支撑 current-state mutation；audit/event 边界可扩展 correlation；普通 operator 路径可保持隔离。它们是构建材料，不证明 evaluation scope、journal、恢复或 reopen 已存在。

### D2. #543 本能力必须自建（16）

#543 拥有 point/evaluation/epoch/execution/delivery identity、write-ahead evaluating、typed decision ingress、单一 journal/consumer、decision+pending intent 原子建立、restart 推进、terminal/consumed、evaluation-scoped mutation key/response、fingerprint/epoch 正交以及新旧 authority 隔离。实现可采用任何物理形态，只要能证明 C 节后果。

### D3. 外部 blocker（5）

- **RFC-2（2）**：pinned definition resolver 与公共 compile projection；跨重启固定 evaluation input。缺失时不得回退当前 preset 路径或自行建立第二份 canonical model。
- **RFC-1（3）**：typed structured-reopen admission；claim/cursor/budget/consumed 的原子 effect；terminal/lifecycle preservation。缺失时 `advance|hold` 可独立完成，但不得声称 `reopen` 分支完整。

closure canonical transition 六边是 observer/event 接缝，不是本报告 evaluation journal 核心需求；它仍是整个 RFC 的 RFC-1 blocker，但不重复计入本报告 5 项。

## E. 接缝与证明计划

1. **identity/ingress：** 对每个 point variant 构造 stable identity；并发提交两个 decision、旧 execution 延迟提交、非法 decision，观察唯一权威 decision 与 typed rejection。
2. **mutation replay：** 同一 evaluation scope 重放相同 command/args，确认返回字节/语义等价的首次 typed response且只有一次 mutation/audit side effect；改变 canonical args 则形成独立 key。普通 operator 路径保持原 conflict。
3. **原子 kill points：** 在 evaluating 持久化前后、decision+pending transaction 中、commit 后、effect attempt 后/outcome 前、consumed 前后做 deterministic process kill。未提交事实不可见；已提交 pending restart 后自行推进；terminal 不重消费。
4. **metadata concurrency：** 两连接 barrier 覆盖不相交字段与同字段竞争的两种提交序，证明无 stale silent overwrite；检查生产 writer 闭集。
5. **fingerprint：** canonical 状态不变、相关状态变化、无关字段变化、declaration hash 变化、旧 keep-active fixture、`evaluating` restart 六组场景，分别证明防抖与 epoch 正交。
6. **RFC-2 seam：** 冻结供给 SHA 上 pin H1，路径改 H2 后 restart；旧 evaluation 重放仍是 H1，新实例为 H2；missing/corrupt/version 均 typed fail、无 fallback。
7. **RFC-1 seam：** 冻结供给 SHA 上覆盖合法/非法 target、cross-seq、未运行、重复 claim、竞争 claim、预算耗尽、terminal corrections、transaction kill/restart，证明全有或全无。
8. **外部 effect：** 模拟 event append/文件/Git effect 在 attempt 后 outcome 前崩溃，允许重复；必须观察稳定 delivery identity 与每次 attempt/outcome，禁止以事件条数或外部最终状态证明 exactly-once。

## F. 尾部核对

- [x] 固定 point/evaluation/epoch/execution/delivery/decision/outcome/consumed 的语义关系。
- [x] evaluation-scoped CLI mutation 仍走 operator 命令面，含 canonical key、首次 response 快照、普通路径隔离与 audit correlation。
- [x] decision + pending intent 固定为引擎内原子边界；restart 不依赖原触发点。
- [x] typed ingress 是单一 journal/consumer 的扩展 seam，不复制状态机。
- [x] fingerprint 与 epoch 正交，新 authority 不读旧 keep-active metadata。
- [x] metadata 只固定无 stale silent overwrite 的结果，不选择 patch/CAS/分表。
- [x] RFC-1/RFC-2 blocker 与 #543 自建责任分开；未用本地 journal 冒充 reopen authority。
- [x] 外部 effect 只记录 attempt/outcome，不主张回滚、跨系统事务或 exactly-once。
- [x] 未选择 schema/table/outbox/drainer/锁/队列/模块物理形态。
- [x] 未读源码、未实验、未创建 worktree、未修改其他文件。

最终计数（以原子矩阵为准）：**26 条**；既有地基 **5**，本能力自建 **16**，外部 blocker **5**（RFC-1 **3**、RFC-2 **2**）。
