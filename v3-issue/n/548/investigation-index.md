# RFC #548 R6 — R7 细节调查索引

**固定基线：** `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
**事实输入：** `supply-findings-ledger.md`；稳定条款文字回指 `AGG-548.md`。  
**边界：** 本文只把 R5 的 73 条候选整理为可证伪的调查委托；不调查源码、不做实验、不裁决、不列候选方案、不估算实现，也不重拆 issue。

# A. 主 agent 摘要

R6 将 73 条候选闭合为 **10 个 R7 索引项**和两组无需 R7 的事实。候选的主分类计数为：**A 已明确事实 16、B 真实设计/工程分叉 18、C 静态/运行证明缺口 38、D 纯边界事实 1，共 73**。分类只说明下一步需要什么证据，不表示接受、优先级或补法。

十项中，R7-01、R7-08、R7-09 会在建立地面事实后暴露真实裁决点；R7-02～07、R7-10 的目标是补足静态或运行证明。关键事实依赖是：真实 external-terminal CLI 合约（R7-04）先于真实 invocation/lifecycle（R7-06），真实 invocation 又先于同一 invocation 的 loss ordering（R7-07）；current closure authority 与历史资产的对应（R7-09）也先于 R7-06/07 的 closure 断言。main 入队侧的 schema（R7-01）、重放（R7-02）与审计（R7-03）可并行。

**R6 gate：满足。** 每个 R7 项都有稳定条款、已观察事实、证据不足点、需建立事实、实验边界和独立派发理由；73 个候选恰好各有一个主归属，反向映射闭合。R6 没有把静态结构提升为可用能力，也没有把同一术语下的相反调用方向合并。

**建议首批 R7：** R7-01、R7-02、R7-04、R7-09。它们彼此可并行，并分别建立 schema/validation、入队重放、真实 CLI、closure authority 四组后续调查的前置事实。R7-03 可与首批并行但不阻塞 R8；其余按依赖批次推进。

# B. 详细索引

## R7-01 — 可消费 schema artifact 与创建期字段契约

- **分类 / Ledger IDs：** B（12）：`S1-D07 S1-D08 S1-D09 S1-D11 S1-D12 S1-R01 S1-R04 S1-R05 S1-R06 S1-T03 S1-T04 S1-U02`
- **稳定条款：** §2.1 D、§2.2；T2；STD-745；P-747-1/2/3/4。
- **观察事实：** current compile 是 8-key projection instance；preset load 和 top-level known-key 可在 insert 前拒绝，但 `[item.fields]` 的声明、类型、required 与统一 typed verdict 没有形成已证明的消费契约。现有测试 oracle 与 producer 同源，并把 top-level strict 混同于 `extra` 字段契约。
- **为何不足以决定补法：** 现有证据只证明“缺什么”，没有证明 authoritative schema 信息目前存放在哪里、哪些边界实际消费它、现有 grammar 能表达什么、错误结构跨 CLI 后保留到什么程度。未建立这些事实就无法判断裁决点究竟在 artifact 形态、grammar、创建期解析还是消费边界。
- **可能涉及层：** preset grammar/load/compile、item add/socket/CLI、版本化 artifact、消费端生成或解析、测试 oracle；这里只列触点，不预设根因。
- **必须建立的事实：** schema 与 field declaration 的真实数据流；compile 输出的所有生产消费者；required/type/unknown/preset-missing 四类错误在各边界的实际 shape；`schemaVersion` 的生产与消费语义；独立 oracle 是否存在。
- **最小实验或真实外部路径：** 对一个带 required 与类型声明的最小 preset，从 compile artifact 到 PATH CLI item add 分别注入 missing/unknown/type mismatch/missing preset/schemaVersion mismatch，保存逐层结构化结果与 DB/runner 副作用；实验只求事实，不设计新格式。
- **为何单独派 subagent：** 它横跨 artifact 与写入边界，容易被 R7-02 的重放语义或消费 daemon 的实现假设污染，需要独立证据链。
- **预期报告边界：** 只报告现有权威字段、消费者、可复现实验、仍需裁决的最小分叉；不提出 schema 载体或校验实现。

## R7-02 — `new-workspace` 两步写入、重放与 caller-visible verdict

- **分类 / Ledger IDs：** C（11）：`S1-D03 S1-D04 S1-D05 S1-D14 S1-D15 S1-R07 S1-R08 S1-R09 S1-T05 S1-T06 S1-U01`
- **稳定条款：** §2.1 C；T1/T3/T5；P-746-3/4。
- **观察事实：** chain create 与 item add 均可达但非原子；串行 chain replay、item UNIQUE 与 socket details 已有窄地基。并发 chain lookup/insert、item duplicate 的成功分类、commit 后 event/reply 前崩溃、PATH CLI 扁平错误均未被实际证明。
- **为何不足以决定补法：** 静态窗口不能说明 wire 上实际返回、SQLite 最终态与重放收敛；“同字段”目前也不是完整对象相等。必须先区分竞争、断连、进程崩溃和调用方分类分别造成的观察结果。
- **可能涉及层：** CLI、daemon socket handler、chain/item persistence、SQLite transaction/WAL、reply serialization、调用方重放。
- **必须建立的事实：** chain equality 的逐字段规则；同名并发的胜败响应；item duplicate 的 socket 与 PATH CLI 结果；在 create/item commit、event append、reply 各边界 kill 后的 durable state；重放后 item/执行次数。
- **最小实验或真实外部路径：** 隔离 loop-data 下并发同名 chain create；对 new-workspace 的两步调用逐 kill-point/断连并以相同请求重放；核对 SQLite、CLI exit/stdout/stderr、status 与执行次数。`S1-U01` 中 audit 不可写的子事实由 R7-03 报告，避免一个实验结论吞并两个根因。
- **为何单独派 subagent：** 这是写入运输与持久化时序问题，需要一个连续故障矩阵；与 schema 正确性、事件证明力是不同因果链。
- **预期报告边界：** 给出可复现矩阵和每个窗口的实际终态/返回；不定义 already-exists 的产品语义或组合命令。

## R7-03 — 入队决策审计的实际证明力

- **分类 / Ledger IDs：** C（3）：`S1-D16 S1-R10 S1-T07`
- **稳定条款：** LOG-746；T5。
- **观察事实：** rights event 只证明准入，created append 是 best-effort；duplicate 无 created，chain replay 不可区分；status/list 是当前态而非逐决策记录。现有测试只走正常文件事件。
- **为何不足以决定补法：** 尚不知道 event append 不可写、进程终止与 duplicate/replay 时真实留下哪些记录，也不知道哪些正式消费者依赖何种字段；不能据“事件存在”决定审计缺口位于 producer、存储还是消费解释。
- **可能涉及层：** daemon event producer、事件文件、status/list、CLI response、消费 daemon 日志。
- **必须建立的事实：** 各写入判定对应的 event/response/status 可见性；append failure 的实际处置；event schema 的真实消费者与 retention；delivery/caller identity 是否能由现有记录关联。
- **最小实验或真实外部路径：** 复用 R7-02 的正常、duplicate、replay、kill 场景，另加入事件路径不可写；逐场景保存事件、响应与 durable state。实验协调复用 fixture，但报告独立。
- **为何单独派 subagent：** 审计是观察证明而非写入正确性；合并调查会把“最终态正确”误当“逐决策可审计”。
- **预期报告边界：** 只陈述每种记录能证明和不能证明什么及消费者事实；不设计新 event。

## R7-04 — external-terminal 真实 CLI 与 probe/invocation 合约

- **分类 / Ledger IDs：** C（5）：`S2-D04 S2-D09 S2-R01 S2-R02 S2-U01`
- **稳定条款：** T7；STD-602-1/2/8。
- **观察事实：** 历史候选有 execution-domain/probe 分类，但 child error 被压成 executable-missing；HAPI vocabulary 进入 parser/storage，真实 invocation 被 pending/throw 截断。argv、prompt、cwd、auth、resume/session、exit/status schema 未核实。
- **为何不足以决定补法：** 候选代码中的 builder 不是外部 CLI 的事实源；不知道真实 binary 的命令面和失败分类，就无法判定现有 ADT、probe identity 或 headless status 边界能否表达它。
- **可能涉及层：** 外部 CLI binary、process spawn/env/cwd、prompt transport、auth resolution、status file/parser、runner domain/probe。
- **必须建立的事实：** 当前安装 binary/version；probe 与 invocation argv；输入、cwd、auth、resume/session 标识；同步 exit 与异步 status 的 schema/时序；missing、unavailable、spawn error 的可区分输出。
- **最小实验或真实外部路径：** 在隔离目录直接执行真实 CLI 的 probe 和最小 remote session，记录 argv/help/version、生成文件、exit/status 与 resume 行为；凭据仅从既有本地路径解析，不索取或写入报告。
- **为何单独派 subagent：** 这是树外真实系统契约调查，必须与候选实现隔离，避免由历史代码反推外部事实。
- **预期报告边界：** 产出带版本与命令证据的外部契约及未知项；不映射成 coder-loop 实现方案。

## R7-05 — availability 缺席、创建后 hold 与恢复时序

- **分类 / Ledger IDs：** C（6）：`S2-D05 S2-D08 S2-R06 S2-R07 S2-T02 S2-T03`
- **稳定条款：** §2.1 I；T7；STD-602-2。
- **观察事实：** 候选先 commit item 再 probe/hold；缺席 hold 可让位且不改 preset status，但恢复终点为 invocation-pending。probe、hold、warning、clear 与 DB mutation 非同事务，已有测试把 pending 当目标。
- **为何不足以决定补法：** 尚未通过真实 daemon 时序确定 create→hold crash、probe 状态翻转、clear→invoke 间隙分别如何被 scheduler/startup 看见；静态窗口也不能证明警告与 hold 的持续、去重、恢复行为。
- **可能涉及层：** item create、availability probe、hold persistence、scheduler selection、warning/events/status、startup recovery。
- **必须建立的事实：** 各 mutation 的实际顺序和 transaction 边界；缺席 item 的 durable/status/event 形态；多次 probe 与重启后的 hold/警告变化；恢复后第一个实际 scheduler 动作。
- **最小实验或真实外部路径：** 用可控真实 probe 结果在隔离 daemon 中覆盖创建时缺席、运行中恢复、各边界重启/kill，并观察 DB、queue、events/status 与是否产生 runner side effect。真实 invocation 的最终完成由 R7-06 负责。
- **为何单独派 subagent：** 缺席是正常调度态，和“可用后真实 remote 是否成功”是不同命题；单列可防止 pending 同错继续充当恢复证明。
- **预期报告边界：** 只给状态时序与故障观察；不决定 hold 存储位置或恢复策略。

## R7-06 — 同构 completion/retry、status admission 与真实 remote E2E

- **分类 / Ledger IDs：** C（6）：`S2-D10 S2-D13 S2-D16 S2-T04 S2-T06 S2-U02`
- **稳定条款：** T7；STD-602-1/7。
- **观察事实：** generic local completion pipeline 存在，但 historical HAPI 路径进不去且 parser 返回 null；synthetic status/holds 可观察，验收却以 zero-hapi-spawn 为 PASS。真实 daemon→CLI/HAPI→status admission 从未执行。
- **为何不足以决定补法：** 不知道真实 external-terminal 的过程、status 与 daemon admission 如何接合，也不知道 retry 是由 exit、status 还是 scheduler 状态触发；不能从 generic local pipeline 的存在推断同构。
- **可能涉及层：** scheduler/runner invocation、remote session、status parser/admission、attempt/retry、phase/item terminal、observability。
- **必须建立的事实：** 一个真实 invocation 的 run/attempt identity；prompt/cwd 传递；status 产生与准入；success/failure/retry 对 phase/item 的真实推进；status/events 对同一 identity 的关联。
- **最小实验或真实外部路径：** 依赖 R7-04 合约与 R7-09 authority 事实，在隔离 daemon 走真实 external-terminal session 至 status admission，至少覆盖成功和一次可判定失败/重试，观察 remote、SQLite、status/events 与最终 item 状态。
- **为何单独派 subagent：** 这是唯一必须证明真实跨系统业务路径的项；不能被 fake runner、synthetic state 或 availability 实验替代。
- **预期报告边界：** 提交完整可复现 trace 与未成立的接缝；不修改实现、不把单次成功外推到 loss ordering。

## R7-07 — 同一生产 invocation 的 loss/terminal total order

- **分类 / Ledger IDs：** C（5）：`S2-D11 S2-D12 S2-R03 S2-T05 S2-U03`
- **稳定条款：** T7；STD-602-3/4/5。
- **观察事实：** latch/revoke/terminate/startup recovery 与 durable close 读取静态存在，但没有真实 active HAPI run 来源；现有 active-loss 由 synthetic 状态制造。
- **为何不足以决定补法：** 静态分支无法建立外部终态写入、loss 检测、closure commit 与 recovery 的实际先后，也不能证明两个竞争结果均绑定同一 invocation。
- **可能涉及层：** live process/session observation、loss detector、status admission、durable latch、closure、startup recovery。
- **必须建立的事实：** 同一 run/attempt/session identity 的所有时间戳与 durable writes；loss-first 和 terminal-first 各自最终态；重复/迟到信号、重启与 terminate 的效果。
- **最小实验或真实外部路径：** 依赖 R7-06 可达真实 invocation，分别在 terminal admission 前造成 remote loss、在 terminal durable 后造成连接 loss，并复现重启；保存外部 session、DB、status/events 的同 identity trace。
- **为何单独派 subagent：** total order 是竞争性质，单次 E2E 或 synthetic fixture都不能证明；需要专门控制时序。
- **预期报告边界：** 只报告可重复的 ordering 事实与未覆盖窗口；不提出锁、latch 或事务方案。

## R7-08 — probe endpoint identity 的真实区分维度

- **分类 / Ledger IDs：** B（1）：`S2-D14`
- **稳定条款：** T7。
- **观察事实：** 历史 key 是 `kind+binary`，只在 probe argv 固定时与 endpoint 等价；argv 改变会混淆。
- **为何不足以决定补法：** R5 未建立真实 CLI 是否存在 endpoint/profile/argv/env 等可变维度，也未证明 probe cache/hold 的实际作用域；因此无法判断 identity 需求。
- **可能涉及层：** target/phase runner config、probe invocation、availability cache/hold、status。
- **必须建立的事实：** 真实配置中决定可达性的全部输入；相同 binary 不同 argv/env/profile 的 probe 结果；key 的所有 producer/consumer 与生命周期。
- **最小实验或真实外部路径：** 在 R7-04 已确认的合约上以两个可区分 endpoint/profile 做 probe，对照当前 key、cache/hold 与 status 归属；若真实合约没有该维度，明确以证据证伪分叉。
- **为何单独派 subagent：** 单一 ledger 指向一个窄但可能跨配置与运行态的 identity 问题，合入 CLI 大调查容易被遗漏。
- **预期报告边界：** 给出 identity 输入集合及碰撞/不碰撞事实；不选择 key 结构。

## R7-09 — current closure authority、历史 owner/migration 与 lifecycle 对应

- **分类 / Ledger IDs：** B（5）：`S2-D15 S2-R04 S2-R05 S2-A02 S2-U04`
- **稳定条款：** T7；STD-748-B1。
- **观察事实：** 历史候选以 slot path/item session 为 owner，current main 已有 durable closure path、run identity、reachability、intent、cleanup authority；历史 whole-table CHECK rebuild 可能破坏 current schema。retry/resume reuse、consume cleanup、stop/delete/restart 未在 current authority 下验证。
- **为何不足以决定补法：** R5 只确认两套所有权模型并存于比较范围，没有建立 current authority 的完整状态机、数据库版本迁移前提或真实消费者；不能据历史字段名决定保留、映射或舍弃。
- **可能涉及层：** task-runtime/loop/sqlite migration、scheduler/daemon、worktree/closure lifecycle、runtime data、observability/tests。
- **必须建立的事实：** current closure schema 与状态转移的唯一写者/读者；run/attempt/session/worktree identity 关系；retry/resume/consume/stop/delete/restart 的实际资源终态；历史 migration 在 current schema 副本上的行为。
- **最小实验或真实外部路径：** 先做 current main 的静态 writer/reader 与 migration 图，再在隔离 DB/daemon 执行上述 lifecycle，核对 closure 与资源；历史 migration 仅在可丢弃副本上重放并记录 schema/invariant 差异。
- **为何单独派 subagent：** 这是 reconciliation 的 authority 调查，跨层且会约束 R7-06/07；不能由历史候选自身声明所有权。
- **预期报告边界：** 产出 current authority 事实、历史触点对应表和最小待裁分叉；不写 migration 或 lifecycle 补法。

## R7-10 — immutable candidate 与 live merge-base gate 事实

- **分类 / Ledger IDs：** C（2）：`S2-D17 S2-U05`
- **稳定条款：** STD-602-9/10。
- **观察事实：** 只有 focused fake tests；没有 immutable candidate 与 live merge-base 的完整 gate 证据。
- **为何不足以决定补法：** 未知相应标准要求的实际命令、基线 SHA、环境和结果；focused pass 不能替代两侧同一 gate，也不能说明失败是否由候选引入。
- **可能涉及层：** repository refs、typecheck/unit/integration gates、环境卫生与测试产物。
- **必须建立的事实：** candidate/base 的不可变 SHA；权威 gate 命令与环境；两侧完整结果、diff 与残留资源。
- **最小实验或真实外部路径：** 在固定 SHA 上分别运行标准点名的完整本地 gates，保存命令、版本、日志与卫生检查；不以此替代 R7-06/07 的真实 external-terminal 路径。
- **为何单独派 subagent：** 回归归因要求同环境双基线，和行为调查的 fixture/结论不同；可在语义调查结束后独立执行。
- **预期报告边界：** 只报告双基线 gate 证据与归因边界；不修失败、不宣布 RFC 完成。

# C. 无需 R7 的事实集合

## C1. A — 已明确事实，只待后续回锚（16）

`S1-D01 S1-D02 S1-D06 S1-D10 S1-D13 S1-D17 S1-A01 S1-A02 S2-D01 S2-D02 S2-D03 S2-D06 S2-D07 S2-A01 S2-N01 S2-N02`

这些条目已经在固定基线上明确了窄运输/存储/ADT/side-effect gate，或明确标出不可作为目标终点的负资产。后续设计可引用其**限定强度**，但无需派 R7 去重复证明；“可保留”仍不等于目标保证，“负资产”也不等于已决定替代物。

## C2. D — 纯边界事实，不扩成任务（1）

`S1-D18`

消费 daemon 位于 current main 审计树外，main 最多提供 response shape；消费端 ADT 是否成立应在其真实交付边界验证。本 RFC 的 R7 不以“树外未知”为理由扩大 coder-loop 调查或预设消费端设计。

# D. 派发批次与依赖

| 批次 | 可并行项 | 事实依赖 | 对 R8 的作用 |
|---|---|---|---|
| 1 | R7-01、R7-02、R7-04、R7-09；R7-03 可同批 | 均只依赖 R5 与固定基线；R7-03 可复用 R7-02 fixture 但不依赖其结论 | R7-01、R7-04、R7-09 阻塞相关设计档案；R7-02 可能暴露重放/verdict 裁决点 |
| 2 | R7-05、R7-08 | 依赖 R7-04 的真实 probe/identity 输入；R7-05 另消费 R7-09 的 current persistence 事实 | 两者若出现多种真实可行语义，阻塞 R8；否则以事实关闭 |
| 3 | R7-06 | 依赖 R7-04 合约与 R7-09 authority；可消费 R7-05 的恢复时序 | 阻塞 external-terminal 是否形成真实同构执行边界的 R8 结论 |
| 4 | R7-07 | 依赖 R7-06 已建立同一真实 invocation | 只在 ordering 事实暴露真实分叉时阻塞 R8，否则是性质证明 |
| 5 | R7-10 | 依赖待评估 candidate SHA 固定；不依赖行为方案 | 后续 runtime/regression proof，不应阻塞前期 R8 设计档案 |

R7-03 是后续 runtime/audit proof，不阻塞 R8 选择；但它必须在宣称 LOG-746 成立前完成。R7-10 是候选冻结后的 proof。R7-02 的 kill/replay 结果若只确认单一现状，可直接作为事实输入；只有出现需求相关、互不兼容的真实补法边界时才提交 R8 裁决。

# E. 双向覆盖与计数

## E1. 索引 / 无需 R7 → Ledger

| 归属 | 分类 | 数量 | Ledger IDs |
|---|---|---:|---|
| R7-01 | B | 12 | S1-D07, S1-D08, S1-D09, S1-D11, S1-D12, S1-R01, S1-R04, S1-R05, S1-R06, S1-T03, S1-T04, S1-U02 |
| R7-02 | C | 11 | S1-D03, S1-D04, S1-D05, S1-D14, S1-D15, S1-R07, S1-R08, S1-R09, S1-T05, S1-T06, S1-U01 |
| R7-03 | C | 3 | S1-D16, S1-R10, S1-T07 |
| R7-04 | C | 5 | S2-D04, S2-D09, S2-R01, S2-R02, S2-U01 |
| R7-05 | C | 6 | S2-D05, S2-D08, S2-R06, S2-R07, S2-T02, S2-T03 |
| R7-06 | C | 6 | S2-D10, S2-D13, S2-D16, S2-T04, S2-T06, S2-U02 |
| R7-07 | C | 5 | S2-D11, S2-D12, S2-R03, S2-T05, S2-U03 |
| R7-08 | B | 1 | S2-D14 |
| R7-09 | B | 5 | S2-D15, S2-R04, S2-R05, S2-A02, S2-U04 |
| R7-10 | C | 2 | S2-D17, S2-U05 |
| 无需 R7：明确事实 | A | 16 | S1-D01, S1-D02, S1-D06, S1-D10, S1-D13, S1-D17, S1-A01, S1-A02, S2-D01, S2-D02, S2-D03, S2-D06, S2-D07, S2-A01, S2-N01, S2-N02 |
| 无需 R7：边界事实 | D | 1 | S1-D18 |
| **合计** |  | **73** | 每个候选恰有一个主归属 |

## E2. Ledger → 索引反向速查

| Ledger 范围 | 归属 |
|---|---|
| `S1-D01,D02,D06,D10,D13,D17,A01,A02` | A：无需 R7 |
| `S1-D18` | D：无需 R7 |
| `S1-D07,D08,D09,D11,D12,R01,R04,R05,R06,T03,T04,U02` | R7-01 |
| `S1-D03,D04,D05,D14,D15,R07,R08,R09,T05,T06,U01` | R7-02 |
| `S1-D16,R10,T07` | R7-03 |
| `S2-D01,D02,D03,D06,D07,A01,N01,N02` | A：无需 R7 |
| `S2-D04,D09,R01,R02,U01` | R7-04 |
| `S2-D05,D08,R06,R07,T02,T03` | R7-05 |
| `S2-D10,D13,D16,T04,T06,U02` | R7-06 |
| `S2-D11,D12,R03,T05,U03` | R7-07 |
| `S2-D14` | R7-08 |
| `S2-D15,R04,R05,A02,U04` | R7-09 |
| `S2-D17,U05` | R7-10 |

## E3. 计数闭合

| 分类 | 无需 R7 | R7 索引内 | 合计 |
|---|---:|---:|---:|
| A 已明确事实 | 16 | 0 | 16 |
| B 真实设计/工程分叉 | 0 | 18 | 18 |
| C 静态/运行证明缺口 | 0 | 38 | 38 |
| D 纯边界事实 | 1 | 0 | 1 |
| **总计** | **17** | **56** | **73** |

闭合规则：计数按 Ledger ID 的唯一主归属计算；某实验可以复用另一项 fixture，但不得共享或吞并结论。特别是 `S1-U01` 主归 R7-02，其“audit 不可写”子观察由 R7-03 交叉消费，不重复计数；这不把审计根因并入重放根因。R5 中 8 条标记“否”的非候选不进入本表。
