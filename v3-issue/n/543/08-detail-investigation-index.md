# RFC #543 · R6 待调查细节索引

> 唯一输入总账：`07-supply-ledger.md`。本索引只把“现有报告仍不能用地面事实消解的分叉”送入 R7；明确缺席、已证偏离、局部资产和纯证明缺口不因条目数量而机械升级为调查任务。本文件不提出选项、补法、实现边界或工作量。

## A. 主 agent 摘要

- **R7 事实调查项：7 项。** 主题分别为：observer 子进程故障/回收、pinned compile projection 的真实供给、closure 六条边的真实生产事实、旧 metadata 并发写隔离、shutdown-held 的真实准入面、journal 四个 kill point 的恢复序列、reopen 权威事实/API 供给。
- **纯口径项：2 项。** P3 对同脚本并发/重入的要求强度，以及旧专用历史行的迁移处置；它们不能靠继续读代码替操作员作决定。
- **排除覆盖：141 项。** 其中包括明确缺席/已证偏离、已知资产、有效测试的局部证明、同错测试、纯测试盲区、影响摘要和已经静态确定的迁移/恢复事实。
- **150 项全覆盖：** 7 个调查项 + 2 个口径项 + 141 个排除项；未映射 0，重复主归属 0。
- **R5 gap：无。** R5 已声明 150/150 覆盖；本轮没有重新读源码或实验，也没有发现账目缺口。

## B. R7 调查索引

### R7-DI-01 · observer 子进程故障、进程组与 daemon 重启后的真实边界

- **稳定条款 / ledger IDs：** G1–G5；主归属 `S1-U01`。上下文仅引用 `S1-C20–S1-C24`、`S1-A07`、`S1-T08–S1-T14`。
- **报告已观察事实：** observer 生产执行路径不存在；现有 agent 异步 spawn/stdin/process-group 只能作为经验，不能证明未来 hook 路径；slow、nonzero、timeout、spawn failure、孙进程回收和 daemon crash orphan 尚未被运行观察。
- **为何证据不足：** “当前不存在”足以判定偏离，却不能回答可复用进程设施在各故障点的真实行为，也不能判定哪些现有生命周期边界可作为新执行面的地基。
- **可能涉及的层：** runner/process lifecycle、daemon shutdown/recovery、event diagnostic；不预设它们共享根因。
- **所需代码/数据/运行实验：** R7 subagent 读取既有进程管理与 daemon 生命周期事实；以隔离 fixture 分别注入 slow/nonzero/timeout/spawn failure、孙进程和 daemon 中止，记录父子 PID、信号、退出与残留。不得实现 observer。
- **为何必须单独派发：** 这是操作系统进程与故障注入问题，证据形态和外部供给调查不同，且必须避免把 agent executor 的相似形态误写成可直接复用结论。
- **边界 / 依赖 / 并行性：** 不决定 payload、gate 或 binding；不依赖其他调查，可首波并行。

### R7-DI-02 · definitionRef 到 pinned compile projection 的真实供给面

- **稳定条款 / ledger IDs：** F3、D1；主归属 `S1-U03`。上下文仅引用 `S1-C05`、`S1-C14`、`S1-A06`、`S1-T06`、`S1-T16`、X-05。
- **报告已观察事实：** 当前只有 identity 与候选 compile boundary；手工 placeholder 绕过 producer，未证明完整 projection 的存储及解引用 API。
- **为何证据不足：** 报告不能从 placeholder 推出 RFC-2 最终会提供什么、由谁持有、在 pin/restart 后如何解引用；因此尚不能判断该供给是否可成为 payload/binding 的真实地基。
- **可能涉及的层：** preset compiler、definition persistence/pinning、daemon read boundary；不预设存储形态。
- **所需代码/数据/运行实验：** 读取 RFC-2 已冻结契约及其实际生产/消费路径，取得 definitionRef 生命周期样本；若存在运行入口，仅做 compile→pin→restart→resolve 的只读/隔离验证。
- **为何必须单独派发：** 权威事实位于外部供给边界，不能由当前 RFC 的 hook 账目推断；与本仓进程实验所需证据不同。
- **边界 / 依赖 / 并行性：** 只调查 projection 供给，不设计 HookPayload 或 named binding；可首波并行，结果供后续综合使用。

### R7-DI-03 · closure 六条转移边的真实生产事实

- **稳定条款 / ledger IDs：** A4、F7；主归属 `S1-U04`。上下文仅引用 `S1-C04`、`S1-C18`、`S1-T15`、X-04。
- **报告已观察事实：** 现有五类 closure 事件不等于稳定 RFC 所需六条转移边；typed facts 未形成可核对的全量 metadata 投影；报告明确禁止猜测映射。
- **为何证据不足：** 尚不知道 RFC-1 实际在哪些状态转移点生产六边、各边携带哪些权威事实，以及已有事件是同一事实、派生事实还是缺席。
- **可能涉及的层：** task-tree/closure state transition、event producer、typed fact boundary；不预设一边一事件或共同 writer。
- **所需代码/数据/运行实验：** 读取 RFC-1 冻结契约和实际 producer；逐边触发最小场景，记录转移前后状态与发出的 typed facts/metadata。
- **为何必须单独派发：** 六边是独立外部状态机事实，若混入 observer 调查会把订阅者需求反推成生产者事实。
- **边界 / 依赖 / 并行性：** 不调查 observer dispatch，也不决定 payload shape；可与 DI-01/02 并行。

### R7-DI-04 · 旧 chain metadata whole-snapshot 写的并发隔离事实

- **稳定条款 / ledger IDs：** B6、J4（地基资格相关）；主归属 `S2-U01`。上下文仅引用 `S2-C06`、`S2-C18`、`S2-A02–S2-A04`、`S2-T11`、X-06。
- **报告已观察事实：** tick 单飞、per-chain finalizing 与 SQLite immediate transaction 是资产；旧 chain trigger 对 whole metadata 的 keep-active 写是否和并发写产生 lost update 未被隔离实验裁决。
- **为何证据不足：** 事务存在不等于读改写快照不会覆盖另一 writer；静态报告不能确定实际交错与锁边界，因而不能判定旧机制是否有任何可保留的持久化地基资格。
- **可能涉及的层：** scheduler concurrency、chain metadata persistence、SQLite transaction boundary；不预设问题在数据库或调用方。
- **所需代码/数据/运行实验：** 读取真实读改写边界；在隔离 DB 中以同步 barrier 制造两个 writer 交错，记录最终 metadata、事务顺序与审计结果。
- **为何必须单独派发：** 这是窄幅并发可证伪实验，和协议缺席或迁移口径不同；合并调查会掩盖复现实验的判据。
- **边界 / 依赖 / 并行性：** 不设计 journal/fingerprint；可首波并行。

### R7-DI-05 · shutdown-held 时查询与调度准入的真实矩阵

- **稳定条款 / ledger IDs：** A5、H3（运行宿主边界）；主归属 `S2-U02`。上下文仅引用 `S2-C01`、`S2-C11`、`S2-A02`、`S2-T08`。
- **报告已观察事实：** 当前无 point-local held state；shutdown-held 时 socket 是否仍可查询且不再产生新调度，须在需求投影后观察。
- **为何证据不足：** “无 gate”不能回答现有 daemon shutdown/pause/socket 的先后顺序和可复用边界；这些事实会决定宿主是否具备所需地基，但不能从声明 ADT 推断。
- **可能涉及的层：** daemon lifecycle、socket command admission、scheduler pause/finalizing；不预设 held 等同 pause 或 shutdown。
- **所需代码/数据/运行实验：** 读取生命周期状态转换与 socket admission；用现有可表达的 pause/shutdown 状态构造隔离实验，逐项记录 status/query/mutation/new scheduling 的实际结果。不得添加 held 状态。
- **为何必须单独派发：** 它要求 daemon 运行态矩阵，不能由 gate parser 或持久化调查替代。
- **边界 / 依赖 / 并行性：** 只形成宿主事实，不决定 gate decision；可首波并行。

### R7-DI-06 · decision/effect 同事务周围四个 kill point 的真实恢复序列

- **稳定条款 / ledger IDs：** J1–J3、J5；主归属 `S3-U01`。上下文仅引用 `S3-C05–S3-C07`、`S3-C09`、`S3-A03`、`S3-A05`、`S3-T08`、`S3-R01–S3-R04`。
- **报告已观察事实：** 现有 consumption-intent outbox 给出四段恢复窗口的静态事实，但统一 journal、consumer、decision/effect writer 不存在，故真实 kill/restart 序列未验证。
- **为何证据不足：** 静态窗口与手工 emitted 测试无法证明进程中止后的 replay、幂等、副作用次数和清理顺序，也无法裁定现有 outbox 模式的地基资格。
- **可能涉及的层：** SQLite transaction、outbox consumer、daemon restart、event emission；不预设未来 journal 等同现有 intent。
- **所需代码/数据/运行实验：** 对现有最接近的 intent 路径做四个明确 kill point 的隔离故障注入，记录 DB 行、side effect/event 次数、restart 后推进与最终清理。
- **为何必须单独派发：** 这是恢复一致性实验，必须有逐 kill-point 可证伪证据；不能被普通 transaction 绿色测试合并替代。
- **边界 / 依赖 / 并行性：** 不设计 journal schema；与 DI-04 都涉及 DB 但验证对象不同，可并行。

### R7-DI-07 · reopen target/correction/cursor/budget 的权威事实与 API 供给

- **稳定条款 / ledger IDs：** B2–B4、L3、L5；主归属 `S3-U02`。上下文仅引用 `S3-C19`、`S3-C21`、`S3-C22`、X-04。
- **报告已观察事实：** consume 当前不可逆；现有 closure 可作为“有无工作”来源，但 target、精确 correction IDs、cursor 与 budget 的权威 API 等待 RFC-1，不能从 reachability enum 反推。
- **为何证据不足：** 缺少生产者事实时无法判断四类值是否已经存在、生命周期和一致性边界如何、哪些仅是派生视图；因此不能决定 reopen consumer 的地基资格。
- **可能涉及的层：** RFC-1 task/closure model、scheduler cursor/budget、mutation ingress；不预设一个共同 API。
- **所需代码/数据/运行实验：** 读取 RFC-1 冻结契约及真实 producer/consumer；逐类追踪权威值的创建、持久化、读取与状态转移，必要时在隔离场景记录 reopen 前后事实。
- **为何必须单独派发：** 这是 reopen 的权威数据来源调查，与 DI-03 的六边事件生产虽同属 RFC-1，但问题、证据和可证伪结论不同，不能互相替代。
- **边界 / 依赖 / 并行性：** 可与 DI-03 并行；综合时才能核对事件事实与 reopen 权威值是否相接，不提前假定相接。

## C. 纯口径项

| ID | 稳定条款 / ledger IDs | 已知事实 | 为什么不是 R7 事实调查 |
|---|---|---|---|
| R7-PO-01 | P3；`S1-U02` | 同脚本跨事件/chain 的并发与重入要求被明确保留为未知。 | 继续观察当前不存在的 observer 不能产出需求强度；须由操作员确认基线口径。本轮不列选项。 |
| R7-PO-02 | 迁移口径；`S2-M03` | 旧专用历史行客观存在的可能性及新旧语义不等价已登记；迁移/忽略/清理未裁决。 | 这是对历史数据的产品处置口径，不应由代码现状自动决定。本轮不列策略。 |

## D. 排除/归并表与 150 ledger IDs 全覆盖映射

### D1. 排除/归并表

| 排除组 | Ledger IDs（主归属） | 数量 | 不进入 R7 独立调查的理由 |
|---|---|---:|---|
| EX-01 条款判定 | `S1-C01–S1-C27`, `S2-C01–S2-C18`, `S3-C01–S3-C23` | 68 | 均已被报告判为符合、部分符合、明确缺席、已证偏离或静态不可判定/证明缺口；R7 继续读同一事实不会产生新的补法依据。真正的外部或运行未知已另抽为 DI。 |
| EX-02 已知资产 | `S1-A01–S1-A07`, `S2-A01–S2-A05`, `S3-A01–S3-A06` | 18 | 是已定位的局部地基或经验，同时报告已写明其能力边界；是否采用属于后续综合，不需为每项再派调查。 |
| EX-03 测试证据 | `S1-T01–S1-T19`, `S2-T01–S2-T11`, `S3-T01–S3-T10` | 40 | 有效测试只证明局部；同错与盲区已明确。缺少测试本身是证明缺口，不是未决设计事实；相关真实实验仅在 DI-01/04/05/06 中按可证伪问题派发。 |
| EX-04 影响摘要 | `S1-I01–S1-I03`, `S2-I01–S2-I03`, `S3-I01–S3-I03` | 9 | 是条款、资产与测试事实的影响归纳，不是新增 ground-truth 问题，避免重复派发。 |
| EX-05 已定迁移事实 | `S2-M01–S2-M02` | 2 | 已知旧 metadata 可跨升级、旧二词不可静默等同 journal epoch；这是确定约束，不需再调查。未裁决处置单列 PO-02。 |
| EX-06 已定恢复窗口 | `S3-R01–S3-R04` | 4 | 四窗口的静态后果已经明确；它们作为 DI-06 的实验参照，不各自机械拆任务。 |
| **排除合计** |  | **141** |  |

### D2. 150 项唯一主归属核对

| 来源 | R7 调查 | 纯口径 | 排除 | 小计 |
|---|---|---|---|---:|
| S1（60） | `S1-U01`, `S1-U03`, `S1-U04` | `S1-U02` | `S1-C01–C27`, `S1-A01–A07`, `S1-T01–T19`, `S1-I01–I03` | 60 |
| S2（42） | `S2-U01`, `S2-U02` | `S2-M03` | `S2-C01–C18`, `S2-A01–A05`, `S2-T01–T11`, `S2-M01–M02`, `S2-I01–I03` | 42 |
| S3（48） | `S3-U01`, `S3-U02` | — | `S3-C01–C23`, `S3-A01–A06`, `S3-T01–T10`, `S3-R01–R04`, `S3-I01–I03` | 48 |
| **总计** | **7** | **2** | **141** | **150** |

> B 节中的“上下文引用”不改变 ledger ID 的唯一主归属；它只说明稳定条款与已知证据的关联，防止同一账目被重复计数。

## E. 派发波次建议

- **首波（全部可并行）：** DI-01、DI-02、DI-03、DI-04、DI-05、DI-06、DI-07。七项之间没有事实前置依赖；其中 DI-03 与 DI-07 同读 RFC-1，但分别核对事件边与 reopen 权威值，应独立产出。
- **汇合核对（不是新增调查/实现顺序）：** DI-02 与 DI-07 用于核对外部供给边界；DI-03 与 DI-07 核对同属 RFC-1 的事实是否真的相接；DI-04 与 DI-06 只比较事务地基证据，不合并结论。
- **口径等待：** PO-01、PO-02 可与首波并行向操作员登记，但在获得口径前不得由 subagent 自行生成方案。

## F. 文件尾部核对

- [x] 仅以 `07-supply-ledger.md` 为完整账目，未重新调查源码或运行实验。
- [x] R7 调查项有限、可证伪、可独立派发；未把 150 条机械转换为任务。
- [x] 每个调查项含唯一 ID、稳定条款/ledger IDs、已观察事实、证据不足原因、可能层、所需事实/实验、单独派发理由、边界/依赖/并行性。
- [x] 未生成实现选项、推荐、PR/issue 边界或工作量。
- [x] 纯口径项与事实调查分离。
- [x] 150 = 7 调查 + 2 口径 + 141 排除；未映射 0，重复主归属 0。
- [x] R5 coverage gap：0。
