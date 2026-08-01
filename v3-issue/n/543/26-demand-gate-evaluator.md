# RFC #543 R10：gate evaluator / 全决策点接线需求侧报告

> 证据边界：只读 `01-clauses.md` 的 A5–A7、B、D2–D3、H、I，`23-expected-foundation.md`，以及 `05-supply-gate-runtime.md`、`12-detail-chain-metadata-concurrency.md`、`13-detail-shutdown-admission.md`、`21-runtime-consistency-resolution.md` 的主摘要。本文只推导稳定结果合同；不读取源码、不运行实验、不选择 patch/CAS/table/queue/lock，不替外部 effect 兜底。

## A. 摘要

gate evaluator 不是八处各写一段脚本调用，而是一条由**穷尽 point ADT × 穷尽 decision ADT**驱动的公共判定通道。八类宿主点必须先形成类型化 candidate：`run pre-spawn`、`run post-exit`、`item 状态转移`、`container advance / par join`、`chain-complete`、`daemon startup`、`daemon shutdown`、`tick`。闭包六条转移边明确不在该 ADT 中。每个 candidate 读取该点的 current state 与四层 effective declarations，建立 durable evaluation identity/epoch，按 global→chain→preset→item 执行并解析 gate，合成唯一 typed decision，再以同一个 point-specific consumer 原子地落地或返回 hold。

统一 wire decision 是 `advance | hold | reopen(target, correctionItemIds)`；但合法性由 point×decision 决定：非容器推进点只接受 `advance | hold`，容器推进/par join 与作为顶层 join 的 chain-complete 才接受 `reopen`。运行期实际收到非法 `reopen` 必须成为 `decision_not_allowed_at_point`，按该 hook 的 `onFailure` 转换，并留下 diagnostic/audit；不得靠装载期假装证明脚本未来输出。

四层全部命中、稳定顺序执行，只有所有结果均为 `advance` 才放行。任一 `reopen` 压过 `hold`；同 target 的 reopen 以稳定顺序合并去重 corrections；不同 target 不任选一个，降为 hold 并报告全部冲突 target。该合成必须只有一份实现并服务全部 point。

hold 与 epoch 是正交的：epoch 标识一次可恢复评估/消费代次；fingerprint 只决定一个**已消费 hold**在 canonical candidate 未变化时是否需要再次执行脚本。`evaluating` 残留在同 epoch 无条件恢复重问，不查 fingerprint；hold 被消费后 epoch 递增并保存 point-specific fingerprint，只有相关 canonical state 或 effective declaration hash 变化才重新评估。tick 还须同时通过每声明独立的正整数 `minIntervalMs` 节流；节流不是 epoch，也不是 fingerprint。

`23` 已固定 typed current-state mutation、durable evaluation/delivery authority、restart recovery、`shutdown-held` admission 与 stable identity 的最低地基。该能力仍须自建 evaluator、decision parser/consumer、point×decision 合法性、四层合成、八点 candidate/consumer 接线、fingerprint 投影、tick 节流、typed hold/rejection 与全套事件。RFC-1 structured reopen authority 是唯一直接阻塞 `reopen` 完整消费的外部 blocker；RFC-2 pinned definition/payload resolver 与公共 hook subprocess/payload 地基是执行 gate script 的前置供给。任何文件、Git、数据库或第三方副作用均由脚本作者自行协调，不进入本 evaluator 的事务、回滚或 exactly-once 保证。

## B. 稳定语义

### B1. evaluator 的统一状态通道

1. **Candidate 构造**：每个 point variant 提供稳定 point identity、宿主 identity、candidate mutation/advance、canonical fingerprint input、effective declarations 与共享 payload trigger context；不存在匿名字符串 point。
2. **Evaluation 建立**：在启动任何 gate 前，以 `(point identity, epoch)` write-ahead 建立 `evaluating`；该身份贯穿脚本环境、CLI mutation scope、decision ingress、journal、event、status 与恢复。
3. **逐 hook 判定**：按四层稳定顺序执行每个命中声明；stdout 只承载 decision，经共享 ADT 边界解析。spawn/timeout/crash/协议违规按该声明的 `onFailure` 映射为 `hold | advance`，同时保留原始失败分类。
4. **合成**：所有 gate 都参与；不得见到首个 `hold` 就漏跑后层，也不得以完成先后改变声明顺序。合成结果由 D2–D3 的 AND/reopen 规则唯一决定。
5. **Decision ingress**：kind-specific ingress 只准入属于当前 execution、point、epoch 的 decision；迟到、重复或身份不匹配均 typed reject，不能落到当前代次。
6. **消费**：`advance` 与该 point 的候选推进在同一原子边界完成；`hold` 与不推进事实、reason/retry hint、fingerprint 及 epoch 前进在同一原子边界完成；`reopen` 委托 RFC-1 authority 原子校验/认领 corrections 并落地 reopen、游标/预算和 consumed。
7. **恢复**：`decided` 未消费直接重消费，不再执行脚本；`evaluating` 残留在同 epoch 重问；已消费代次不重复产生引擎内推进效果。外部脚本本身不保证只执行一次。

### B2. point × decision 合法性矩阵

| Point variant | `advance` | `hold` | `reopen` | hold / admission 的可观察结果 |
|---|---|---|---|---|
| run pre-spawn | 合法；继续本次 spawn admission | 合法；本次 spawn 不发生 | 非法 | chain 局部扣住，其他 chain 可调度 |
| run post-exit | 合法；允许下一次选择/后续推进 | 合法；后续推进不发生 | 非法 | 在闭包 suspend 等后果前扣住；闭包边本身不 gate |
| item 状态转移 | 合法；同一 RPC 继续 mutation admission | 合法 | 非法 | RPC 返回 typed `gate_held`，mutation 零落地 |
| container advance / par join | 合法；推进容器 | 合法 | 合法 | reopen 必须经 RFC-1 structured authority |
| chain-complete（顶层 join） | 合法；完成 chain | 合法 | 合法 | 与其他 join 共用同一协议，不保留 keep-active 私有 evaluator |
| daemon startup | 合法；进入 ready 并启动 scheduler | 合法 | 非法 | `starting-held`；socket/status 可见，scheduler 不开始 |
| daemon shutdown | 合法；继续有界 drain/关闭 | 合法 | 非法 | `shutdown-held`；query 可用，拒绝新 mutation/dispatch |
| tick | 合法；执行该 tick 的候选推进 | 合法；跳过该 tick 推进 | 非法 | daemon 存活；须同时满足 declaration interval 与 fingerprint 变化 |

闭包 `create / run-spawn / run-exit / suspend / reopen / consume` 只进入 observer 事件面，不能出现在此矩阵。若未来新增 point，类型穷尽性必须同时暴露 candidate 构造、合法 decision、payload trigger、fingerprint input、消费、事件、status 与恢复缺口。

### B3. 四层 AND 与多 reopen

- Effective declarations 的执行序固定为 global→chain→preset→item；同层内也必须有稳定声明顺序。
- `advance ∧ advance = advance`；任何没有 reopen 的非 advance 集合合成为 hold。
- 一个或多个 reopen 与 hold 并存时，reopen 优先。
- 同 target reopen：correction IDs 按稳定首次出现顺序取并集并去重。
- 不同 target reopen：结果是 hold，不产生 reopen effect；diagnostic 完整列出冲突 targets。
- 单个 gate 的失败先按自己的 `onFailure` 变成 typed decision，再进入同一合成器；失败不能绕开 AND。
- 顺序只决定执行与稳定合并次序，不承诺脚本外部 effect 的完成顺序或隔离。

### B4. hold、fingerprint、epoch 与 tick

- 每个 point variant 定义专属 `FingerprintInput`：point identity、稳定宿主 identity、只含该点推进所依赖的 canonical current-state projection、effective declaration hash。
- fingerprint 不 hash 全库偶然字段，不写 `chain.metadata`，也不复用旧 keep-active carrier。
- `evaluating`、`decided`、`consumed` 是 epoch 内恢复状态；epoch 只在 decision effect 消费完成时单调递增。
- 已消费 hold 保存最近 fingerprint；相同 fingerprint 的候选不再启动新 evaluation，相关投影或声明变化后才进入下一代评估。
- crash 遗留 `evaluating` 不受 fingerprint 抑制，必须在原 epoch 重问；`decided` 则重消费而不重问。
- tick gate 每个有效声明独立维护最近 evaluation 完成时刻；只有 `minIntervalMs` 已到且 hold fingerprint 允许时才发起评估。`minIntervalMs` 缺失、非整数或非正数均在 compile boundary 拒绝，无默认值。

### B5. 生命周期、query 与 mutation admission

- `starting-held`：query/status/socket 可用；scheduler、run spawn、observer dispatch 和普通 mutation 不开始；重评 advance 后才 ready。
- `shutdown-held`：query/status/socket 与 owned-process recovery 保持可用；尚未进入执行的 mutation返回 typed lifecycle rejection，且 DB/event/spawn 零副作用；不再产生 scheduler 或 observer dispatch；已经入执行的工作按既定 drain 收敛。
- item transition hold：同步调用不悬挂，返回带 point identity、reason、retry hint 的 typed `gate_held`，且候选 mutation零落地。
- point-local hold 不冻结其他 chain；daemon point 的 hold 才按其生命周期语义影响全局 admission。
- gate script 在 evaluation scope 内发起的 CLI mutation 也必须通过同一 lifecycle/authorization/current-state admission；“由 gate 发起”不授予绕过权。

### B6. 身份、恢复、授权与事件

- 最低身份链为：point identity → epoch/evaluation identity → hook declaration identity → execution attempt identity → decision/consumption identity；correction mutation 还携带 evaluation scope 与规范化 command identity。
- gate 以 operator 身份调用既有 CLI；evaluation scope 只提供幂等关联，不扩大权限。无 scope 的普通 operator 请求保持原语义。
- 同 epoch 的 scoped mutation 以 `(evaluation scope, command, normalized args)` 吸收重放并返回首次 response；不同非确定 mutation 仍可能分别首次生效，引擎不撤销孤儿 corrections。
- status 必须暴露 point hold、reason/retry、epoch、effective declarations 与 daemon held lifecycle；query 读取的是 durable current state，不是陈旧 carrier。
- 事件至少覆盖 execution start/terminal/failure、parsed/effective decision、协议违规分类、hold consumed、fingerprint suppression/re-evaluation、tick throttling、mutation replay hit、evaluation 状态转移、restart recovery、reopen conflict 与 lifecycle rejection。
- 事件携带稳定因果 identity；事件是审计/投影，不得成为 decision 或消费的第二权威。`hook.*` 事件不得再次触发 observer。

## C. 原子需求矩阵

| ID | 原子结果合同 | 分类 | 验收证据 |
|---|---|---|---|
| GE-01 | gate point 是八 variant 穷尽 ADT，闭包六边不在其中 | 本能力自建 | compile exhaustive fixtures |
| GE-02 | 每 variant 具 typed point/host identity 与 candidate | 本能力自建 | 全 point candidate contract tests |
| GE-03 | decision 是 parse/consumer 共用的 `advance/hold/reopen` ADT | 本能力自建 | boundary + exhaustive consumer tests |
| GE-04 | 非 join point 实际输出 reopen 得到 `decision_not_allowed_at_point` | 本能力自建 | 每个非法 point 的 runtime test |
| GE-05 | container/par join 与 chain-complete 接受 reopen | 本能力自建 | 合法 point×decision runtime matrix |
| GE-06 | stdout 非 JSON、词表外值及结构错误均按声明 `onFailure` 转换并审计 | 本能力自建 | failure matrix |
| GE-07 | 四层全部执行且顺序为 global→chain→preset→item | 本能力自建 | trace order test |
| GE-08 | 只有全 advance 才 advance；hold/reopen 优先级固定 | 本能力自建 | decision product table |
| GE-09 | 同 target reopen 稳定并集去重 corrections | 本能力自建 | permutation/duplicate tests |
| GE-10 | 不同 target reopen 降为 hold 并完整 diagnostic | 本能力自建 | conflict runtime test |
| GE-11 | evaluation/epoch/decision/pending effect 是 durable typed authority | `23` 已供合同 | kill/restart matrix |
| GE-12 | `evaluating` 在 spawn 前 write-ahead，残留同 epoch 重问 | `23` 已供合同 | pre/post-spawn kill points |
| GE-13 | `decided` 未消费重消费且不重跑 gate | `23` 已供合同 | decision/consume barrier kill |
| GE-14 | advance 与 point-owned candidate effect 同一原子消费边界 | `23` 已供合同 | all point commit kill tests |
| GE-15 | hold 与不推进、fingerprint、epoch 前进同一原子消费边界 | 本能力自建 | hold consume kill tests |
| GE-16 | epoch 只在 consumed 后递增；fingerprint 与 epoch 正交 | 本能力自建 | recovery/state-machine tests |
| GE-17 | 每 variant 的 canonical fingerprint 只含相关 state + declaration hash | 本能力自建 | change/suppression matrix |
| GE-18 | fingerprint 存在独立 authority，不进 metadata/旧 keep-active carrier | `23` 已供合同 | legacy fixture + writer audit |
| GE-19 | tick 声明必须有独立正整数 `minIntervalMs`，无默认值 | 本能力自建 | compile rejection matrix |
| GE-20 | tick 同时满足 interval 与 fingerprint 才新评估 | 本能力自建 | fake-clock runtime test |
| GE-21 | item hold 返回 typed `gate_held` 且 mutation 零落地 | 本能力自建 | RPC response + DB/event diff |
| GE-22 | startup hold 进入 queryable `starting-held` 且无 scheduler start | 本能力自建 | lifecycle barrier runtime test |
| GE-23 | shutdown hold query 可用、mutation typed reject、无新 dispatch | `23` 已供合同 | command ADT + DB/event/spawn diff |
| GE-24 | #543 runtime mutation 基于 durable current state 原子应用或 typed conflict | `23` 已供合同 | 双连接 barrier 两种提交序 |
| GE-25 | hold 只扣宿主 point，其他 chain 可继续 | 本能力自建 | two-chain concurrency test |
| GE-26 | evaluation scope 注入 CLI，重放 mutation 至多首次生效一次 | `23` 已供合同 | same-key replay/response snapshot test |
| GE-27 | stable identity 贯穿 payload、journal、status、audit、diagnostic、recovery | 本能力自建 | cross-surface correlation test |
| GE-28 | 迟到/重复/错 execution 或错 epoch decision typed reject | 本能力自建 | ingress identity matrix |
| GE-29 | hook subprocess、固定 pinned payload 与 typed execution outcome 可供 evaluator 使用 | 地基/外部 blocker | subprocess/payload foundation integration |
| GE-30 | reopen 原子校验、claim、budget、cursor 与 consumed 由 RFC-1 authority 提供 | 地基/外部 blocker | frozen RFC-1 provider contract suite |
| GE-31 | pinned definition resolver/公共 compile projection 供 gate payload 使用 | 地基/外部 blocker | frozen RFC-2 drift/restart suite |
| GE-32 | gate execution/decision/hold/fingerprint/recovery/lifecycle 均进入统一事件与 status | 本能力自建 | event/status sequence reconstruction |

## D. 三类分类

### D1. `23` 已供的地基结果合同（8）

`GE-11`、`GE-12`、`GE-13`、`GE-14`、`GE-18`、`GE-23`、`GE-24`、`GE-26`。这些是 R9 已固定的最低后果，不代表 main 已实现；R10 不重新设计其物理承载。gate evaluator 只在这些合同上建立自己的 candidate、decision 与消费语义。

### D2. 本能力必须自建（21）

`GE-01`–`GE-10`、`GE-15`–`GE-17`、`GE-19`–`GE-22`、`GE-25`、`GE-27`–`GE-28`、`GE-32`。核心是统一 evaluator、八点接线、point×decision 合法性、四层合成、hold/fingerprint/tick、typed point-specific outcome 与可观察性；不能把旧 chain-complete keep-active 私有路径复制八次。

### D3. 地基 / 外部 blocker（3）

1. **GE-29：公共 hook subprocess + pinned payload 地基。** evaluator 依赖异步 spawn/stdin/timeout/process-group/outcome 与固定输入，但不把 agent 领域 executor 当成 gate 协议。
2. **GE-30：RFC-1 structured reopen authority。** 缺它时 `advance/hold` 仍可成立，但任何“reopen 完整可消费”的主张保持 blocker；#543 不用本地 reachability、journal 或多次 CLI 调用代替。
3. **GE-31：RFC-2 pinned definition resolver / compile projection。** 缺它时不能证明恢复后的 gate 仍针对 pinned definition 获得一致 payload；不得回退当前路径重编译。

文件、Git、目标数据库和第三方服务不是 blocker，也不是 evaluator 的兜底范围。脚本并发、重放或非确定性造成的外部 effect 由脚本作者利用目标系统自身的幂等/CAS/锁能力协调。

## E. 接缝与证明

### E1. 八点共用、各点自有的边界

共用部分只有 declaration resolution、payload envelope、subprocess execution、decision parse/onFailure、四层合成、evaluation journal/identity、事件/status 投影与恢复驱动。每个 point 只提供类型化的 candidate/current-state projection、合法 decision subset、fingerprint input 和消费 adapter。由此既避免八套 evaluator，也不把不同宿主的 mutation/admission 伪装成相同副作用。

### E2. 必须证明的原子接缝

1. candidate current-state read 与 point consume 之间出现变化时，实现必须基于 durable current state 原子应用或 typed conflict/重新候选，不能成功覆盖新状态。
2. evaluation write-ahead 与 subprocess spawn 的每个 kill point，都必须恢复为同 epoch 重问或已知 terminal outcome，不能形成无身份执行。
3. decision durable 与 pending effect 建立之间必须没有“decision 已权威存在但恢复者不知道要消费”的窗口。
4. advance/hold/reopen 各自的 consumed 与引擎内 effect 必须全有或全无；reopen 的原子域由 RFC-1 authority 给出。
5. status/event append 失败不能改变 authoritative decision；恢复后可重建投影，允许重复但保持同一 identity。

### E3. 全点运行证明

- 对八点逐一触发真实 candidate，覆盖 advance、hold、失败→onFailure；对三类 join 点再覆盖 reopen 合法/冲突。
- 两条 chain 并行：一条 point hold 时另一条仍推进；daemon startup/shutdown 例外按全局生命周期合同验证。
- item RPC 观察 typed `gate_held` 与零 mutation；tick 用可控时钟观察 interval 与 fingerprint 两道条件。
- 四层 trace 必须证明执行顺序、全部执行、AND/reopen product；脚本不同完成速度不得改变合成。
- crash matrix 覆盖 evaluating、decided、consume transaction 前/中/后；重启后分别观察重问、重消费或不重复 effect。
- command ADT 在 `shutdown-held` 下穷尽 query/mutation，核对 response、DB diff、event diff、spawn diff。
- metadata 双连接 barrier 覆盖不相交与同字段冲突；证明没有 stale whole-snapshot 双成功丢失。
- 事件/status 以 stable identity 重建一次 hold→suppressed→state change→re-evaluate→advance 的完整节奏。

### E4. 明确不证明

- 不证明 gate 脚本或外部 effect 只执行一次、可回滚、全局有序或跨系统原子。
- 不证明声明执行顺序等于外部副作用完成顺序。
- 不提供 per-script/global serialization、资源锁、distributed transaction 或 effect sandbox。
- 不把 schema、table、queue、outbox、CAS、patch、revision、lock、consumer 数量或模块签名写成需求。

## F. 尾部

- 原子需求：**32**。
- 分类：`23` 已供合同 **8**；本能力自建 **21**；地基/外部 blocker **3**。
- 外部 blocker：**RFC-1 structured reopen authority**、**RFC-2 pinned definition resolver/compile projection**；另有本 RFC 内公共 hook subprocess/payload 前置地基。
- 已覆盖：typed decision、point×decision、四层 AND、多 reopen、hold/re-evaluate、fingerprint/epoch 正交、tick 节流、startup/shutdown/query/mutation admission、metadata current-state mutation、身份/恢复/授权/事件。
- 未选择 patch/CAS/table/queue/lock；未把外部 effect 纳入引擎保证；未读源码、未实验、未修改其他文件、未创建 worktree、未拆 issue。
