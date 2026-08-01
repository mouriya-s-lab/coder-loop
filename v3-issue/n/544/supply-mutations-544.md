# RFC #544 R4 供给侧调查：S4 mutation / operator decision 与写入口收口

基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点：AGG §1.1 A/D/F、§1.2/1.3、§3.3、D7 性质 4、D8、CAP-4。本报告判断现存供给，不设计 GUI client，不裁决拆分或规模。

## A. 主 agent 摘要（≤一页）

### 问题、结论与置信边界

**问题**：现存 daemon command、调用/授权/持久化/审计与 join 地基，能否直接承担 F 档唯一写面及 CAP-4 per-epoch operator decision？

**结论（高置信，静态穷尽生产源码入口；未做 fault/concurrency runtime 实验）**：不能。现状有一个**daemon 命令大闭集**，但没有 F 档供给子集。四个解卡 verb 已存在且 CLI 走 RPC；但 `item.reorder` 的 per-phase gate 只验证 credential 所属 phase 有 grant，**不验证 credential 绑定的 item/chain 等于目标**：获权 agent 可重排同链其他 item，跨链路径甚至可能先提交 reorder、再在审计身份解析时报错。除此之外，wire request/response 退化为 `string + JsonObject`，operator 是“请求没带有效 agent credential”的消极分类，不是被认证的主体；SQLite store 仍公开且 scheduler/脚本/任何同仓 import 可直接写，故 daemon handler 不是体系级唯一裁判。单个 store 方法有 `BEGIN IMMEDIATE` 原子性，但每个动作的状态写、active-run 清除/终止与 JSONL 审计跨多个事务/副作用，失败可出现“已写盘但 RPC 报错/无结果审计”。handler 之间无 mutation 串行锁，重复/并发请求没有 request identity、expected-version 或 idempotency key。

D7 生命周期命名/语义存在硬偏离：中央 daemon 真正启停是 `daemon up`（前台进程入口）/`daemon.down`（RPC）；CLI `daemon start` 只确认 daemon 已运行，`daemon stop` 实际执行 `chain.stop`，`daemon restart` 只确认 daemon 可用且明确返回 `restarted:false`。因此 AGG 所称 start spawn、stop/restart RPC 在当前版本并不存在完整供给。`chain.stop` 会先持久化 stopped，再强制终止 active runs（bounded grace），并非注释中“in-flight naturally complete”；`resume` 只把 chain 改回 active，由 scheduler 后续重新选择。

CAP-4 **缺失**：只有 task-tree 初始快照可写入的 join binding/evaluation 行与只读列表；没有 decision ADT（`advance|hold|reopen`）、evaluation identity domain type、capability 查询、operator-decision command/handler、epoch CAS/幂等/审计事件或生产消费者。表中 `(par_node_id, epoch)` 与 `binding_version` FK 是可保留结构地基，但不能称作可复用 decision operation。

### 因果、影响、资产、未知与下一步

- **根因链**：daemon 大闭集只保证 command 名→auth class→handler 的 TS 穷尽；wire/结果仍宽类型，operator 由 credential 缺席推定；store 写 API 可绕过；动作把 DB、进程、events 分段提交；CAP-4 只有初始化持久化。于是“typed client 闭集、唯一裁判、per-epoch capability/decision、一致审计”都不能由现状推出。
- **当前影响**：CLI happy path 可完成四动作；单动作 store transaction 不会留下半张 reorder 表。重复 stop/resume/reorder/unblock 大多收敛到某个状态，但响应/审计不具 exactly-once，stop 中途失败还会留下 stopped chain 与未完全终止的 runs。
- **未来 GUI 影响**：不能直接派生精确 mutation client；无 credential 的网关会被当 operator，但这只是本机 socket 裸信任，并不携带网关/当前 operator identity。daemon down 时 stop/restart RPC不可用；现有 restart 也不重启。CAP-4 缺口单独阻塞 decision 入口，不应以 resume/unblock 代替。
- **纯证明缺口**：并发 handler 的实际交错、事件 append fault 后四动作的 wire 结果、进程 kill 位于 DB commit/terminate/event 各点的恢复结果尚未跑隔离实验；这些不改变上述代码级反证。
- **可保留资产**：`DaemonCommandName`/auth-class dispatch 穷尽；credential→active-run agent identity；四 verb 与参数校验；scheduler pause；store `IMMEDIATE` transactions；typed audit subject；join PK/FK、epoch/bindingVersion/effectiveFromEpoch；现有 active-run stop/resume integration fixtures。
- **确定未知路径**：仅用隔离 loop-data root 做 barrier 并发（同 chain stop/resume/reorder/unblock）、event path fault injection、DB-commit 后 kill/restart；随后由 CAP-4 owner 给出 evaluation identity、capability 与 decision 的权威契约，不能从现存表反推。
- **下一步**：R4/R5 将四 verb 标“修补后可复用”、daemon lifecycle 标“语义不符合”、CAP-4 标“未供给”；在供给方形成精确 request/result ADT、明确 operator trust boundary、动作/审计失败语义与真正 lifecycle operation 前，继续阻塞 GUI mutation 设计。

## B. 证据账本

### B1. 逐条三态

| 要求 | 三态 | 事实与偏离 |
|---|---|---|
| daemon command 名与授权分类穷尽 | **部分成立** | `DaemonCommandName` 是闭 union，`Record<DaemonCommandName, DaemonCommandSpec>` 强制每个命令分类；但这是 daemon **大闭集**（含 create/add/update/delete/context 等），不是 F 档子集。 |
| 全链路 ADT / 精确边界 | **缺失** | request 的 `command:string,args:JsonObject`，response `result:JsonObject` / string error；parse 只收 envelope 基本字段，各 handler再手工 parse。CLI结果也多为 JsonObject 手工解包。 |
| 四个解卡动作存在且 CLI→RPC | **成立（verb/happy path）** | `queue.unblock`、`chain.stop/resume`、`item.reorder` 均在 union/dispatch；CLI helper发送 socket RPC；现有 integration 覆盖各一次生效。 |
| F 档 mutation 供给闭集 | **缺失** | 无独立 F-subset type/client；同一 exported `sendDaemonRequest` 接受整个大闭集，裸 socket可手写任意 command；创建类同样是 operator-allowed daemon commands。GUI尚不存在，故不能证明“所有 GUI 写只来自闭集”。 |
| daemon 是体系级唯一写裁判 | **部分成立** | 生产 CLI 的四动作经 daemon；但 `openSqliteStateStore` 与所有 mutator公开，scheduler直接写 store，脚本也直接写。socket文件权限/peer identity未进入请求判定。唯一性只在约定的 CLI路径内成立。 |
| operator/agent 主体识别 | **部分成立** | agent credential解析到 active run 的 chain/item/run/phase；无 `agentCredential` 即 operator。网关无 credential 会走 operator leg，但“operator”没有用户/进程/peer identity，也无 capability identity。 |
| 四动作 daemon准入是唯一语义判断 | **缺失** | hard-deny/per-phase gate先于handler；但 reorder 的 agent gate 不校验 credential-bound item/chain 与目标一致。直接 store旁路不经过准入；operator allow audit在handler校验前发出，不能代表动作成功。 |
| 四动作事务/幂等/竞态/审计 | **部分成立** | 每个 store mutator单独 `IMMEDIATE` transaction；整体动作跨 DB、run termination、events。无请求幂等键/CAS/mutation锁；审计与状态不原子；详见 B4。 |
| D7 start/stop/restart | **缺失** | `up` 才启动 daemon；`down` 才停止 daemon。`start`仅status、`stop`=chain.stop、`restart`仅status并返回未重启。daemon死态只能外部spawn up，stop/restart RPC均不可达。 |
| stop/resume active-run 语义 | **部分成立** | stop先写 stopped再bounded terminate active runs；resume只写 active并恢复scheduler选择。非自然完成，崩溃点会跨层分裂。 |
| CAP-4 identity/capability/decision | **缺失** | 仅 persisted par node id + epoch + bindingVersion/state；无 decision ADT、capability query、command、handler、operation、审计或消费者。 |
| 历史迁移/存量 | **部分成立** | v3 runtime表由 schema/migration创建；legacy v13只迁成 seq/leaf，不产生 par evaluation。新 par的 binding/evaluation只在 `createTaskTree`初始整体事务写入；无后续 writer。 |

### B2. command、wire、调用入口与旁路

1. **大闭集与 auth class**
   - `src/daemon.ts:132-159`：四类 auth；operator定义为无 credential 的分支。
   - `src/daemon.ts:161-205`：22 个 daemon command；F 档四 verb只占其中四个，CAP-4/daemon restart均不在 union。
   - `src/daemon.ts:1725-1766`：`Record` dispatch；四 verb分类为 `chain.stop/resume/queue.unblock = hard-deny-for-agent`、`item.reorder = per-phase-authorized`。
   - `src/daemon.ts:1920-2121`：先 auth gate 后 handler；operator allow 的 `privileged_op.caller_admission` 在 handler解析/状态判断之前写入。
2. **wire边界不是 command ADT**
   - `src/daemon.ts:283-297`：request command仍为任意 string，args/result/error均宽 JSON。
   - `src/daemon.ts:4978-5002`：request/response只解析 envelope，不把 `(command,args,result)` 构造成 discriminated union。
   - `src/daemon.ts:4652-4693`：exported transport与request helper；无 timeout、request去重或 command-specific result parser。
3. **CLI→RPC**
   - `src/loop.ts:2487-2504`、`:2559-2601`：两套CLI transport均调用 socket；`AGENT_ATTRIBUTED_COMMANDS`在`:2526-2546`手工维护，值得保留但与 command spec 是平行清单。
   - `src/loop.ts:4010-4035`：queue unblock经RPC；chain/ item CLI最终走相同 request helper。
4. **裸socket/直接store旁路**
   - socket protocol是 newline JSON；任何能访问 socket 的进程均可手写 command，缺 credential被视为operator（`src/daemon.ts:1695-1722,1957-1983`）。没有 Unix peer credential或网关 identity。
   - `src/sqlite-state.ts:311-357,822-856`：公开 store含全套mutator且以readwrite打开；无daemon ownership token。
   - `src/scheduler.ts:821,1656,1900,2115,2647,2714,2813`：scheduler直接 update item/chain（在daemon进程内的合法 engine writer，但证明“所有mutation经RPC”不是现存全局不变量）。
   - `scripts/issue-558-integration.ts:122-179`、`scripts/issue-560-integration.ts:300-385`：脚本可直接开store写；tests中也大量如此。生产源码未发现四动作仍由CLI直接store写，但导出面未封死未来/同仓旁路。

### B3. 主体、授权与网关无 credential

`ItemMutationCaller` 是精确 `operator | agent` union（`src/daemon.ts:534-542`）；agent credential由scheduler注入env、CLI自动附加（`src/loop.ts:2489-2498,2549-2556`），daemon依据active-run registry解析，拒绝 missing/unknown/inactive/wrong-item（`src/daemon.ts:598-609`及 gate）。这是可保留的 agent 防伪资产。

反面是 operator 没有正身份：`resolveItemMutationCaller` 的无字段路径直接构造 `{kind:"operator"}`，gate对其放行。故 AGG “网关无agent凭证，daemon视为operator”在行为上成立，但“当前 operator capability”不存在；任何本机/具socket权限调用者同样成为operator。mesh-only HTTP trust无法沿 RPC 传递或审计，event subject也只能写泛化 `{kind:"operator"}`。

### B4. 四动作：参数、不变量、事务、重试/竞态、错误与审计

#### `queue.unblock`

- 参数：chain selector + nonempty/no-whitespace opaque `issue`，可`#`去前缀，`dryRun`（`src/daemon.ts:528-532,2739-2751`）。
- 不变量：只对preset `statuses.unblockable`；目标写回preset entry status；若current run指向该item则清除（`:2752-2787`）。
- 原子性偏离：`updateItem`与`clearCurrentRun`各自是独立`IMMEDIATE`事务，audit append又是文件副作用（`:2779-2804`）。中间崩溃可得到entry status但active_run未清，或DB已改但无audit/无成功response。
- 幂等：第二次返回`not_unblockable`，不会重复改盘；但不是同一请求结果重放，也会先产生一次 privileged allow audit。`dryRun`的response仍称`changed:true`（`:2806-2813`），consumer必须结合请求而非结果判定实际写入。
- 竞态：scheduler pause不等于跨request锁；两个handler可先后读取状态并分别形成结果。与其他直接store writer也无隔离边界。
- 审计：gate先记 generic privileged allow；成功写后只记 `item.mutation.caller_admission`，没有专属 queue-unblocked before/after event，也未把`clearedCurrent`放入审计。

#### `chain.stop`

- 参数/不变量：resolve chain；stopped为no-op；仅active→stopped（`src/daemon.ts:2554-2561`）。
- 实际语义：暂停scheduler，**先**transaction写 stopped，释放decision fingerprints，再并发bounded terminate active runs，最后append `chain.status`（`:2561-2585`；terminate helper`:2820-2839`）。这反驳旧注释`:186-188`的“in-flight naturally complete”。
- 崩溃/错误：DB commit后terminate throw会返回error并跳过`chain.status`；chain已经stopped。event append失败同样可使caller见error而状态已提交。retry通常走alreadyStopped并不补终止/audit，因此不能恢复缺失副作用。
- 并发：handler在pause前读chain；两个并发stop可都持有active快照并各自写/终止/审计。没有expected status/version CAS。
- 审计：gate allow与`chain.status`分离；`chain.status`总写subject operator，即使agent经`item.exitAction`调用共享stop逻辑时另有额外事件，见`src/daemon.ts:3437-3488`。整体不是单一decision record。

#### `chain.resume`

- 参数/不变量：active为no-op；仅stopped→active（`src/daemon.ts:2588-2610`）。completed/deleted不可resume。
- 语义：只写chain active并append `chain.status`；退出pause后scheduler才可能重启工作，不恢复被stop终止的run本身。
- 幂等/失败：重复active返回alreadyActive但不会补缺失audit；DB commit与event分离。与stop并发无CAS，最终顺序取决于各独立事务/陈旧预读。

#### `item.reorder`

- 参数：item selector + nonnegative integer position；store将超尾位置clamp（`src/daemon.ts:3242-3251`，`src/sqlite-state.ts:1806-1827`）。
- 准入：operator或credential所绑定phase显式`privilegedOps=["item.reorder"]`；agent identity来自credential。**缺口**：gate解析目标item/chain/preset后只用`caller.phase`查grant（`src/daemon.ts:2008-2117`），从未比较`caller.rowId/chainId`与目标。因此review credential可重排同链其他item；跨链目标也可通过目标preset的同名phase grant。handler只校验目标chain允许mutation。
- 原子性：全chain positions在一个`IMMEDIATE` transaction内更新，这是四动作最强的DB资产；event append仍在commit之后（`src/daemon.ts:3260-3276`）。跨链agent调用在commit后执行`requireStoredRunTaskIdentity(targetChain, callerRunId)`，可能因run不属于目标chain而抛错，形成“越权reorder已提交、RPC报错、无action audit”。
- 幂等/竞态：相同position会重复刷新所有`updated_at`并再发event；没有no-op响应。不同reorder并发各自完整串行事务，last transaction wins，但请求没有base-order/version，caller无法识别陈旧意图。
- 审计：generic gate allow + action-specific `item.reordered`；两者非原子，失败可只留前者或DB已改但缺后者。

#### 共通事务与事件失败

- `src/sqlite-state.ts:1605-1612`：每次store write各自`db.transaction(fn).immediate()`，只保证该方法内部。
- event是独立JSONL append；四handler多数在DB后`await record...`。因此“mutation审计由既有机制发射”只在无fault happy path成立，不能作为一致性/重放保证。
- request id只回显（`daemonRequest`随机UUID），daemon无去重表；网络在commit后断开时重试是新执行。

### B5. daemon 生命周期与死态

| CLI词 | 当前实际行为 | 证据 |
|---|---|---|
| `daemon up` | 当前进程构造daemon、注册signals并等待closed；不是detached spawn | `src/loop.ts:3770-3833` |
| `daemon down` | socket `daemon.down`，先terminate all runs后回复，再异步`stop()`关闭server/store/remove pid+sock | `src/loop.ts:3836-3849`; `src/daemon.ts:1749-1760,1695-1703,1512-1562` |
| `daemon start <target>` | load target后只请求`daemon.status`并回`alreadyRunning:true`；daemon死时失败 | `src/loop.ts:3852-3872` |
| internal `executeDaemonStart` | 有detached spawn实现，但不是`runDaemonStartCommand`的调用路径；主要供queue `--start-daemon`等内部路径 | `src/loop.ts:3874-3913`及调用搜索 |
| `daemon stop <target>` | RPC `chain.stop`，不是daemon lifecycle stop | `src/loop.ts:3916-3933` |
| `daemon restart <target>` | 只请求`daemon.status`；返回`restarted:false` | `src/loop.ts:3936-3956` |

因此 D7 所需“dead→start spawn；live→stop/restart RPC；restart后三证翻绿”没有一一对应operation。尤其daemon死时任何socket RPC都不可达；start必须是网关外部spawn且要验证detach/ready，现存公开 helper不是稳定typed contract。`sendDaemonRequest`无timeout（`src/daemon.ts:4652-4689`），半开daemon可令控制请求无限等待。

### B6. CAP-4 join/evaluation/binding 事实与消费者

- Shape：`JoinEvaluationSnapshot = not-evaluating | evaluating/decided/consumed {epoch,bindingVersion}`（`src/task-runtime.ts:34-42,158-164`）。这不是 operator decision；“decided”无decision payload。
- Schema：binding PK `(par_node_id,version)`含authorKind/authorId/authorityClass/effectiveFromEpoch；evaluation PK `(par_node_id,epoch)`并FK bindingVersion（`src/sqlite-state.ts:703-725`）。可防同par同epoch重复行，但没有 decision内容、actor capability或revision/CAS。
- Writer：只在`createTaskTree`整体transaction递归插入初始snapshot（`src/sqlite-state.ts:1974-1981,2397-2401,2421-2432`）。store API没有 append/update binding/evaluation operation。
- Reader/consumer：只有`listJoinBindings/listJoinEvaluations`和task snapshot latest-row projection（`:2041-2043,2519-2527`）；生产源码无调用这些list方法。scheduler搜索不到JoinEvaluation消费，故epoch不会在真实执行中推进。
- 初始作者固定为`engine/initial/definition/effectiveFromEpoch=0`（`:2421-2427`）；传入snapshot的非初始binding作者信息会被丢弃，因为snapshot value本身不携带这些字段。
- decision ADT `advance|hold|reopen`、evaluation identity、capability查询、operator decision command/response、审计event全部搜索为零。observability中的“decision”kind是scheduler诊断fingerprint（slot busy/backoff等），与CAP-4不同，不可复用冒充。
- 迁移：schema version 16（`:810`）；`STATE_SCHEMA_SQL`/`V3_RUNTIME_SCHEMA_SQL`在迁移transaction创建表（`:948-1089`）。legacy v13迁移只造seq/leaf closure（`:1121-1176`），不产生par/evaluation；存量盘没有可假定的epoch capability状态。

### B7. tests 同错与盲区

**已有可用证据**：
- `tests/integration/daemon/chain-crud.integration.ts:917-1004`证明单请求stop终止active run、resume后scheduler重新选择。
- 同文件`:1039-1136`证明operator无credential可执行大闭集中的多种命令，并检查generic privileged allow audit；这同时证明现存测试目标是“大闭集operator surface”，不是F档收口。
- `tests/integration/daemon/admission.integration.ts:1122-1421`覆盖agent hard deny与review-only reorder grant，但只对同一目标/phase授予关系。

**同错/盲区**：
- tests大量直接`openSqliteStateStore`改生产形态数据（例如chain-crud`:957-995`），所以不会暴露“store导出旁路破坏唯一RPC写面”。
- reorder只有`item.update`的wrong-item测试（admission`:97-210`）；没有reorder cross-item/cross-chain测试，因而漏掉credential目标未绑定这一授权漏洞。
- 无四动作的并发双请求、stop↔resume竞态、reorder stale base-order、unblock↔scheduler/direct writer测试。
- 无在DB commit后令event append失败、terminate失败或socket断开，再重试并核对DB/active_runs/events一致性的测试。
- 无 request-id重复投递/idempotency测试；现有“alreadyStopped/alreadyActive”只测状态收敛，不是请求幂等。
- 无真实daemon lifecycle `start/stop/restart`行为测试与D7语义对照；CLI测试若只断言当前输出，会固化词义错位。
- join tests主要验证schema/roundtrip/migration；没有capability/decision是因为产品面不存在，不是“未测但已实现”。

### B8. 实验限制与证据索引

本轮未启动daemon、未写任何loop-data/生产DB，未创建worktree；只做固定HEAD静态穷尽搜索。没有用绿测或commit替代符合性判断。若下一轮获准执行，实验限定 `/tmp` 隔离root并清理：

1. barrier同时发 stop/resume/reorder/unblock，保存完整RPC、SQLite、events；
2. 将events目标切成不可写/目录，分别触发四动作，判断“commit成功+RPC失败”的确切矩阵；
3. 在stop的DB commit、terminate、event三阶段kill子daemon，重启后核对chain/active_runs/agent进程；
4. 重放同request id与新request id，证明当前daemon均不去重；
5. lifecycle用真实CLI验证`start/restart`不spawn/不restart（代码已形成直接反证，实验只补运行证据）。

关键索引：daemon ADT/auth `src/daemon.ts:132-218,1725-1766,1920-2121`；wire `:283-297,4652-4693,4978-5018`；四handler `:2554-2610,2739-2817,3242-3277`；store/transaction `src/sqlite-state.ts:311-357,822-856,1605-1612,1806-1827`；lifecycle `src/loop.ts:3770-3956`；join `src/task-runtime.ts:34-42`、`src/sqlite-state.ts:302-305,703-725,1974-1981,2041-2043,2397-2432,2519-2527`。
