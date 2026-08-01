# RFC #543 R4-S3 · 持久化、具名绑定与 reopen 供给侧设计符合性深审

> 固定事实面：`/Users/mouriya/Ext/code/coder-loop`，`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只以 `aggregation.md`、`01-clauses.md`、`WORKFLOW.md` 为设计锚点；未修改产品、测试、配置或数据库，未启动中央 daemon，未创建 worktree。

## A. 主 agent 摘要（目标层）

### A1. 问题与总判定

本轮问的是：main 的 operator mutation/admission、task join 状态、SQLite/closure 生命周期、named-gate placeholder 与 chain-complete 专用状态，能否直接成为 C、D3–D4、J、K、L（并与 B2–B4、I4–I5 对接）的地基。

结论：**只能保留局部资产，不能把现有形态认定为这些稳定语义已经具备。**

| 领域 | 三态 | 置信边界 |
|---|---|---|
| C operator CLI mutation | **部分符合、关键接缝偏离** | operator/agent ADT、既有校验与审计是真实生产路径；但无 evaluation scope、幂等 key/response、稳定 task/evaluation 关联，且 `item.created` 与 mutation 不同事务 |
| D3 多 reopen 合成 | **偏离（能力缺席）** | 无三词 decision、无组合器、无 reopen consumer；只有未来 writer 的 reachability 枚举字面量 |
| D4/K 具名绑定 | **偏离（placeholder 静态骨架）** | placeholder 只进入 effective view；无 parser、required/optional、global/chain binding、解析/遮蔽/恢复 consumer |
| J journal/恢复/幂等 | **偏离** | SQLite/WAL/事务是资产；join 表只有三态标签，无 decision、execution identity、effect/epoch API；无 evaluation scope 幂等表和 typed ingress seam |
| L script join/reopen | **偏离** | join 仅 `drain|validator`；无 `script`、无三词派发、无 reopen 写路径。closure reachability 可作保活素材，不是 reopen 效果实现 |
| I4–I5 fingerprint 接缝 | **偏离** | chain-complete 有持久化 keep-active fingerprint 先例，但它在 `chain.metadata`、专用二词协议、过宽投影；不符合 per-point store/typed projection/declaration hash/专用形态收编 |

### A2. 因果链

1. 现有 daemon 已把所有 socket command 放进穷尽 auth 分类，operator 是“请求无 `agentCredential`”，agent 身份来自 daemon 内存中的 run credential registry；这能承接“hook 以 operator 调现有 CLI”，但 hook 执行层必须明确不继承 agent credential。
2. CLI/daemon 请求 schema 目前不接受 evaluation scope；SQLite 没有 `(scope, command, canonical args) → response`，所以现有 add/update/reorder 只能提供校验和主体审计，不能提供 J2 重放幂等。
3. task join 的 `evaluating|decided|consumed` 只是 snapshot/schema 标签。生产代码只有建树时插入、读取/列举，没有状态推进 writer，表中也没有 decision body、判定执行身份、fingerprint 或 consumed effect。符号相同不构成 J1/J3。
4. closure consumption 已有 WAL 内的 lifecycle+intent 原子写与重启恢复，但其方向是“不可达 closure 的资源回收”，且 consumed 不可逆；reopen 需要 target 校验、correction 认领、游标回退、预算与 decision consumed 同事务，当前均无写路径。
5. named placeholder 目前只拼进四层 view；没有绑定配置模型和 runtime consumer。因此它是 DSL/展示骨架，不是 D4/K 的实现。
6. chain-complete keep-active fingerprint 是可复用算法经验，却恰好体现 I4–I5 要消除的专用状态：存在 `chain.metadata.coderLoopChainCompleteTrigger`，指纹包含大量偶然字段，不含 effective declaration hash，也没有通用 epoch/journal。

### A3. 当前 / 未来 / 纯证明影响

- **当前影响**：不得把表名/union 字面量计作 RFC 功能；目前不会执行 script join/reopen，不会为 gate mutation 去重，也不会解析 named gate binding。
- **未来实现影响**：可复用 auth 分类、operator bypass、arktype 边界模式、SQLite immediate transaction/WAL、task identity/closure FK、reachability facts、consumption intent outbox、chain-complete fingerprint 的“上下文不变则不重问”经验；必须新增统一 journal/consumer、evaluation scope admission、绑定解析与 script join ingress，而不是扩写现有 metadata 私有状态。
- **纯证明影响**：现有 unit tests 证明 schema round-trip、迁移与局部事务，不证明 crash-window、script/validator 共用 consumer、reopen 原子效果或 required binding 恢复语义。

### A4. 可保留资产

1. `DaemonCommandName` × `DaemonCommandAuthClass` 穷尽表与 operator/agent caller ADT。
2. item add/update/reorder 的已有校验、rights/admission 审计以及 batch add 的单事务写。
3. SQLite `WAL`、`busy_timeout=5000`、每个 store write 的 `BEGIN IMMEDIATE` transaction 包装。
4. task tree 稳定 runtime identity、join binding version/epoch FK、closure lifecycle/active run FK。
5. typed reachability seed/edge 与 closure consumption intent 的持久化恢复模式。
6. placeholder/effective layer 顺序的类型骨架；chain-complete fingerprint 的防抖先例（只保留经验，不保留专用存储形态）。

### A5. 未知、裁决与继续调查

- **静态未知（需最小故障注入实验）**：SQLite decision/effect 未来放入同一 transaction 后，在 `decided` commit、外部事件 append、资源清理、`consumed` commit 各 kill 点的真实恢复序列。当前没有 decision writer，无法在 main 对该未来行为做运行实验。
- **静态未知（需 RFC-1 供给核对）**：target 合法性、correction ownership、seq cursor/预算的权威写 API 尚不在 main；必须由 RFC-1 报告给出接口，不能从 reachability seed 名称反推。
- **无需新增语义裁决**：本轮没有发现第四种 decision 或复杂主体；已裁决的 operator 全权、三词 ADT、多 reopen 合成、epoch/fingerprint 正交、chain-over-global 足以裁判。
- **R5 前置结论**：可以继续总账核算，但必须把“可保留机制”与“稳定语义已实现”分列；J/K/L 不能标为 ready。

---

## B. 证据附录

### B1. 条款逐项三态对照

| 条款 | 现有生产证据 | 判定 | 缺口 / 可保留点 |
|---|---|---|---|
| C1 | socket command 穷尽分类与 dispatch：`src/daemon.ts:132-159,161-205,1725-1766`；无 credential 即 operator：`3949-3997` | 部分符合 | CLI mutation 确实复用既有 admission；尚无 hook runtime，须保证子进程不携 agent credential |
| C2 | add/update/reorder 真实写路径：`2887-2998,3104-3239,3242-3275` | 偏离 | 无 evaluation identity、被扣点稳定关联、检查 subtree join；全局 position 仍只是队列顺序 |
| D3 | `decided-reopen` 仅 reachability seed enum/schema：`src/sqlite-state.ts:297-300,726-737` | 偏离 | 无 decision 合成器、同 target union、异 target diagnostic |
| D4 | `PresetHookPlaceholder` 与四层 view：`src/hook-declarations.ts:48-58,138-144` | 部分骨架，运行偏离 | placeholder 未解析/绑定/执行 |
| J1 | join state ADT/schema：`src/task-runtime.ts:34-38`；`src/sqlite-state.ts:718-725` | 偏离 | 无通用 point identity；无 spawn 前 writer、decision body、execution id；epoch 无推进 API |
| J2 | operator/add admission：`src/daemon.ts:2887-2937,3949-3997,4136-4248` | 偏离 | 请求无 evaluation scope；无 canonical key、response snapshot、mutation+key transaction |
| J3 | store write transaction：`src/sqlite-state.ts:1605-1612` | 偏离 | 没有 journal consumer；join 表状态与引擎效果没有共同 writer |
| J4 | chain-complete fingerprint：`src/scheduler.ts:2752-2817` | 偏离 | fingerprint 与 epoch 并未正交实现；现有路径根本没有 epoch |
| J5 | `item.created` subject：`src/daemon.ts:2920-2935,2982-2995` | 偏离 | payload/subject 无 evaluation scope；事件在 DB commit 后异步记录，非 mutation transaction |
| J6 | operator 无 credential bypass、duplicate precheck：`src/daemon.ts:2912-2918,3953-3957,4152-4160` | 符合现状基线 | 引入 scope 后必须保持普通请求仍走 duplicate conflict |
| J7 | 无统一 decision 类型/ingress；join 仅 validator metadata | 偏离 | 必须新增唯一 typed ingress seam，而非复用状态标签冒充 |
| K1 | global hooks 读入：`src/daemon.ts:1235-1244`；chain/item hooks：`1215-1232` | 偏离 | 这是普通 hook declaration，不是 name→script binding；无 arktype binding document |
| K2 | placeholder 类型不含 required/optional：`src/hook-declarations.ts:48` | 偏离 | 三态解析完全缺席 |
| K3 | preset compile/instance resolution 无 named binding caller | 静态可判定偏离 | 只有测试手工传 placeholder，生产 parser 未见调用 |
| K4 | effective view 固定层序：`src/hook-declarations.ts:138-144` | 部分骨架 | 无 global/chain 同名选择、shadowed source；placeholder 未变为 effective script |
| K5 | placeholder 本身不含 path：`src/hook-declarations.ts:48` | 静态形态符合 | 生产 preset DSL 尚未提供该声明，不能据此声称可分发验收完成 |
| L1 | join union 仅 `drain|validator`：`src/task-runtime.ts:28-32`；DB CHECK 同样：`src/sqlite-state.ts:703-716` | 偏离 | 无 `script` variant、无 script spawn |
| L2 | chain-complete 专用 decision 为 `complete|keep-active`：`src/scheduler.ts:312,2752-2790` | 偏离 | 非三词 ADT；无统一派发/reopen |
| L3 | closure consumed 不可逆：`src/sqlite-state.ts:1985-1994`; seq cursor 仅建树/删除修补，无 reopen API | 偏离 | target 校验、correction 认领、cursor 回退、terminal 保留均缺席 |
| L4 | chain-complete 走 trigger phase：`src/daemon.ts:3785-3797`; `src/scheduler.ts:2683-2720` | 偏离但有迁移素材 | 顶层 join 尚未共用 script join；当前是 preset trigger 私有路径 |
| L5 | 当前 chain-complete runner/prompt 可自行使用外部工具，但本轮无 payload 注入 GitHub 字段证据 | 静态不可证明完整符合 | 本报告不扩查 payload 域；引擎 closure 面可作为“有无工作”来源 |
| B2–B4 | 当前 chain trigger 二词；无 reopen request/consumer | 偏离 | 三词 parser、精确 correction IDs、原子 claim+effect+consume 全缺 |
| I4–I5 | 专用 state 存在于 chain metadata：`src/runtime-data.ts:81-95,489-504`；fingerprint 生成：`src/scheduler.ts:2819-2855` | 偏离 | 专用形态残留；hash 投影含 repo/path/timestamps/session/extra 等广域字段，且无 hook declaration hash |

### B2. mutation/admission 写入口与身份传播（穷尽）

#### B2.1 socket command 分类

`DaemonCommandName` 的全部 mutation 面为：

- hard-deny-for-agent：chain create/stop/resume/delete/updateBindings、daemon down、queue unblock（`src/daemon.ts:161-205,1733-1765`）；
- mutation-credential-gated：item add/batchAdd/update/exitAction、context append begin/chunk/commit（同上）；
- per-phase-authorized：item reorder；
- 读面：chain/item/status/exits 等。

这是当前“无第三主体”的坚实地基：分类 union 与 `Record<DaemonCommandName,...>` 强制每个 command 入类（`src/daemon.ts:1725-1732`）。但 evaluation scope 是**请求维度**，不是新主体；不应新增第三 auth variant。

#### B2.2 caller 传播

- CLI 从环境自动附 `CODER_LOOP_RUN_CRED`，scheduler 只给 agent spawn 注入（`src/scheduler.ts:1694`；`src/loop.ts:2343,2491-2551`）。
- daemon 以 `args.agentCredential === undefined` 认定 operator；credential 存在时必须匹配进程内 registry 和 active run（`src/daemon.ts:3949-3997`）。
- item update 的 item binding、allow/deny audit 位于 `4033-4133`；add rights 位于 `4136-4248`；operator 绕过 preset rights。
- `item.created` 为 agent 附 durable closure/node/run/phase，为 operator 只写 operator subject（`2920-2935,2982-2995`）。当前事件 schema没有 evaluation scope。

因此 script hook 作为 operator 调 CLI 的最小正确实现应是：不设置/显式删除 `CODER_LOOP_RUN_CRED`，另注入 evaluation scope 专用 env；CLI 把 scope变为明确 request 字段。若错误继承触发 hook 的 agent env，它会被识别为 agent，而非 operator。

#### B2.3 写事务与审计边界

- `createItem` 与 `createItems` 各自通过 store `write()` 包装为 SQLite immediate transaction（`src/sqlite-state.ts:1605-1612,2184-2227`; daemon calls `2915-2918,2974-2977`）。batch children 在同一 DB transaction；单 add 的 duplicate precheck在 transaction 外，唯一约束兜底。
- `item.created` 在 DB transaction 返回后才写 observability（`src/daemon.ts:2915-2935`）。所以 process 在 item commit 后、event append 前崩溃会出现 item 已存在但审计缺失。J5 要 scope 可追溯，不能只在现有异步事件处补字段而宣称原子。
- update 的 item DB write与后续 status audit同样分离（`src/daemon.ts:3194-3239`）。
- 所有请求 known-key validator当前不接收 evaluation scope（add/update key 集在 `src/daemon.ts:438-503`），故仅靠 env 不会自动进入 admission。

### B3. SQLite、迁移、事务、锁与重启恢复

#### B3.1 物理表

与本轮直接相关的生产表：

- `task_join_bindings(par_node_id, version, join_kind, candidate_*, author_*, authority_class, effective_from_epoch, created_at)`（`src/sqlite-state.ts:703-717`）；
- `task_join_evaluation_bindings(par_node_id, epoch, binding_version, evaluation_state)`，PK `(par_node_id,epoch)`，FK binding version（`718-725`）；
- `task_closures`、seq/par nodes（`677-702`）；
- `closure_reachability_seeds/edges`（`726-737`）；
- `closure_consumption_intents`（`745-753`）；
- `active_runs`（`754-760`）。

**不存在** gate evaluation journal、decision payload、execution identity、evaluation mutation key/response snapshot、per-point fingerprint、named binding 表。

#### B3.2 migration 与存量兼容

- open 时 `foreign_keys=ON`、`busy_timeout=5000`，强制 WAL，随后同步迁移（`src/sqlite-state.ts:822-856`）。
- schema migration 由一个 transaction 包装（`948-1006`）；旧盘缺 runtime schema时物化 task tree/closures，旧 reachability seed CHECK 被 rebuild 以接受 `decided-reopen|next-epoch-candidate`（`973-1006,1095-1104`）。
- join evaluation 的存量兼容只有 snapshot round-trip：建树时 `insertJoinEvaluation` 插一次（`2398-2400,2430-2433`），读取 latest（`2520-2527`）。全仓无 set/update writer。
- `STATE_SCHEMA_VERSION` migration 目前能保留现有盘，但未来扩 join kind/script 或 journal 必须显式 migration；仅改 TS union 会被 DB CHECK 拒绝。

#### B3.3 并发与锁

- 每个 store mutation使用 `db.transaction(fn).immediate()`，即写前取得 reserved write lock（`1605-1612`）；WAL允许并行读，busy timeout 最多 5 秒等待。
- daemon 内另以 `pauseSchedulerForMutation()` 包住 item update/reorder 的跨异步流程（例如 `src/daemon.ts:3194-3239`），但这不是跨进程锁，也不能替代 DB 原子 consumer。
- evaluation mutation key记录必须与目标 mutation在**同一个** `write()` closure 内；若 daemon handler先调用现有 `createItem()` 再单独写 key，会留下 J2 崩溃窗口。

#### B3.4 重启与崩溃窗口

现有可证明恢复：

- closure consumption把 lifecycle=`consumed`和 pending intent同一 transaction写入（`src/sqlite-state.ts:2021-2032`）；重开 DB可读 pending intent，测试 `tests/unit/sqlite-state/task-tree.test.ts:268-301`。
- scheduler重试已 consumed closure时复用 intent observation，再做清理/发事件/标 emitted/清资源（`src/scheduler.ts:1489-1524`）。这是可复用 outbox 模式。

现有已知窗口：

1. consumption DB commit 后、worktree cleanup 前 kill：重启从 already-consumed+pending intent继续，方向可恢复；
2. cleanup 后、event emit 前 kill：重启会再尝试幂等 cleanup并发事件；
3. event emit成功、`mark...Emitted` 前 kill：可能重复发 `closure.consumed`，协议是 at-least-once，不是恰好一次；
4. emitted后、clear resources前 kill：重启继续清字段。

这些窗口证明 intent模式适合作为 decision consumer参考，却不证明 reopen：closure lifecycle一旦 consumed禁止 activate/suspend（`src/sqlite-state.ts:1985-1994`），故 reopen target必须在消费前由 reachability/decision原子保护，不能“先 consumed 再恢复”。

### B4. task join 三态的全部生产者与消费者

#### B4.1 生产者

1. 类型/snapshot 输入：`JoinEvaluationSnapshot`（`src/task-runtime.ts:34-38`）。
2. `createTaskTree` → `insertTaskNode` → `insertJoinEvaluation`；仅当 snapshot非 `not-evaluating` 时 INSERT（`src/sqlite-state.ts:1974-1980,2398-2400,2430-2433`）。
3. legacy migration会构造树并经同一路径插入；没有 runtime状态推进 writer。

#### B4.2 消费者

1. `rowToParNode`查询最新 epoch，把 row还原为 snapshot（`src/sqlite-state.ts:2520-2527`）。
2. `listJoinEvaluations`只读列举（`src/sqlite-state.ts:2041-2043`）。
3. tests断言 schema/round-trip；生产 scheduler没有依据 `evaluating/decided/consumed` 做恢复派发。

因此三态是**被动持久化模型**，不是 J 的 journal。复杂差异不是第四种稳定形态，而是缺少 transition API、decision data与consumer。

### B5. closure reopen / consume / 对账

#### B5.1 当前 consume 路径

`completeChainIfReady`在 chain complete trigger 放行后调用 `consumeCompletedChainClosures`，全部 complete才更新 chain completed（`src/scheduler.ts:2683-2717,2723-2749`）。每个 closure：

1. 依 authority重算结构+supplemental reachability（`src/sqlite-state.ts:2117-2153`）；
2. active-run或reachable则保留；否则 transaction内 consumed+intent（`2021-2032`）；
3. scheduler清 worktree/branch、发 `closure.consumed`、标 intent emitted、清资源（`src/scheduler.ts:1489-1524`）。

chain delete使用同一 consumer但 authority为 `chain-deletion`（`src/daemon.ts:2854-2867`）。

#### B5.2 当前 reopen 线索与实质

- `SupplementalClosureReachabilitySeedKind` 包含 `decided-reopen`、`next-epoch-candidate`，edge含 `scope-target`（`src/sqlite-state.ts:297-300`；schema `726-737`）。
- 唯一公开 writer `addClosureReachabilityFact`只是校验同 chain并 `INSERT OR IGNORE`（`2004-2016`）。
- 全仓生产调用没有写 `decided-reopen`/`next-epoch-candidate`；tests只证明它们能保活、幂等和拒绝 foreign closure（`tests/unit/sqlite-state/task-tree.test.ts:304-327`）。

缺失的 L3/B4 原子集合：correction IDs存在/属于scope/未被其他decision认领；target已跑且同seq；append corrections到target；seq cursor回退；reopen budget/count；decision consumed；非法审计。当前 `setClosureLifecycle`不能表达这些，`task_seq_nodes.next_child_node_id`也无公开回退 writer。

### B6. named placeholder 的 compiler/runtime 调用者

- 定义：`src/hook-declarations.ts:48`，只有 `{kind,name,point}`，没有 required/optional。
- 组装：`buildEffectiveHookView`按 global→chain→preset→item拼接，不解析 placeholder（`138-144`）。
- daemon caller：`effectiveHookViewForItem(...presetPlaceholders)`接受调用方已构造的 placeholder并返回 view（`src/daemon.ts:1215-1232`）。全仓生产侧没有 caller把 preset compiler产物送入该方法。
- test：`tests/unit/daemon/hook-declarations.test.ts:10-19`手工构造 placeholder，只断言排序/保形。

不存在：preset DSL parser、global/chain name binding parser、chain-over-global selection、shadowed source、new-instance required拒绝、pinned-instance missing binding hold、skip事件、gate executor。因此 D4/K不能以“类型已存在”判符合。

### B7. chain-complete 专用状态与 fingerprint

- 状态存于 `chains.metadata.coderLoopChainCompleteTrigger`，字段 `decision='keep-active'`, fingerprint, recordedAt, reason, runId（`src/runtime-data.ts:81-95,489-504`）。
- scheduler在所有items terminal后算 fingerprint；相同 fingerprint且keep-active直接不重问，否则跑preset chain-complete trigger，再写 metadata（`src/scheduler.ts:2683-2720,2752-2817`）。
- fingerprint payload包括 chain repository/baseBranch/metadata，items repoCwd、attempts、lastRunId、sessions、paths、整段 extra、createdAt/updatedAt 等（`2819-2855`），不是 I5要求的“该点影响的 canonical投影”，也没有 effective hook declaration hash。
- daemon另有**进程内** `DecisionFingerprintState`用于观测事件去重（`src/daemon.ts:640-719,1186`）；它不持久化，不能替代 per-point evaluation store。

可保留的是“fingerprint相同则跳过，状态变化再重问”的行为先例；必须迁移到通用 per-point store并删除专用 metadata形态，且epoch只随decision消费递增，不能由fingerprint代替。

### B8. 测试同错与盲区

#### B8.1 有效证明

- `tests/unit/sqlite-state/task-tree.test.ts:113-153`：旧 seed schema migration与新枚举可写。
- 同文件 `268-301`：closure intent跨 reopen DB、mark emitted幂等。
- 同文件 `304-327`：reachability fact幂等、same-chain校验、对 consumption的保活效果。
- `tests/unit/daemon/hook-declarations.test.ts:10-19`：effective view层序保形。

#### B8.2 同错风险

1. join snapshot tests可同时接受“从未发生生产 transition”的实现；schema round-trip绿不等于J1。
2. placeholder test直接注入TS对象，绕过缺失的preset parser、binding resolution与runtime executor；它会让静态骨架被误报为K完成。
3. reachability tests直接调用未来-writer enum，未证明任何decision consumer会原子写seed；枚举名字不是L3实现。
4. closure intent测试手工 mark emitted，未故障注入scheduler四个kill窗口；不能证明exactly-once（稳定语义本来也不要求exactly-once evaluation）。
5. chain-complete fingerprint测试若只测“不重复触发”，会掩盖它存入chain metadata、投影过宽、没有declaration hash与epoch正交的I5偏离。
6. mutation admission测试覆盖operator/agent rights，却没有evaluation scope、key命中response回放、mutation+key原子性、scope审计字段。

### B9. 最小实验与本轮限制

本轮未运行会改生产状态的实验。静态结论已经足够判定“功能缺席”；对未来崩溃语义，建议在实现后于本地隔离 loop-data执行以下最小矩阵：

1. gate `item add`后自杀，重启同epoch：断言response byte-equivalent回放且items=1；
2. kill点分别置于 evaluating write后、decision commit后、effect transaction中、consumed commit后：断言同epoch重问或直接消费符合J1–J4；
3. reopen consumer transaction中故障：断言correction claim、target/cursor/budget、decision consumed全有或全无；
4. required binding在创建前移除与pinned恢复前移除：分别结构化拒绝和hold；
5. closure event emit后kill：确认事件at-least-once并由event id/fingerprint供consumer去重，而非虚称exactly-once。

副作用边界：全部使用本地临时 loop-data与fixture repo；不得打开中央 `~/.coder-loop`、不得启动/重启中央daemon。

### B10. 证据索引（命令与观察）

执行的只读命令类别：

- `git -C /Users/mouriya/Ext/code/coder-loop rev-parse --abbrev-ref HEAD` → `main`；`rev-parse HEAD` → `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- `rg`/`nl -ba`读取上述文件与tests，确认所有 join evaluation writer、placeholder caller、reopen/reachability词、fingerprint存储与mutation admission入口。
- 未执行测试：本轮是设计符合性静态深审，现有测试不能补齐缺席的runtime路径；运行绿灯不会改变三态判定。

### B11. 报告收口

本报告的阻塞结论是：**main已有可复用的认证、事务、identity、reachability和outbox资产，但evaluation journal/scope、named binding resolution、script join/reopen consumer均未形成生产闭环。** R5必须把这些缺口作为供给不足核算，不得由相似名词推断地基已就绪。
