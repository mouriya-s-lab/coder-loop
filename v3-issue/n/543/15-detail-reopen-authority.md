# RFC #543 R7-DI-07 · reopen 四类权威事实与 API 供给

> 调查基线：`main` HEAD `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 唯一问题：RFC-1/当前 main 中 target、精确 correction IDs、cursor、budget 四类权威事实和 API 的真实供给，能否为 B2–B4/L3/L5 提供地基。本文不设计 reopen consumer。

## A. 摘要（≤1 页）

### A1. 结论

四类事实**不是一个共同 API**，当前也没有结构化 `reopen(target, correctionItemIds)` producer、decision carrier 或 consumer：

| 类别 | 当前权威事实 | 当前写 API | 对 reopen 的供给结论 |
|---|---|---|---|
| target | 持久 task tree 的 `TaskNodeIdentity.runtimeNodeId`、父子关系、kind；leaf 另有 closure/item/phase identity | 仅整树初始化、运行时顶层 seq leaf lazy materialization、item 删除；无 target lookup/validation/reopen writer | 可提供稳定节点身份和结构读取底料；不能判定“已跑、同 seq、可 reopen” |
| correction IDs | `items.item_id`：preset `idField` 语义下、chain 内唯一的 opaque string；另有内部 row `items.id` | operator/agent 经 daemon `item.add` / `item.batchAdd`，再到 `createItem(s)` | 可先创建既存 item并精确返回 IDs；没有 evaluation scope、target membership、claim/owner 或 decision 关联 |
| cursor | seq 的 `task_seq_nodes.next_child_node_id`，读成 `next(nodeId) | complete` | 整树 import、旧盘迁移、首次 lazy root、删除当前 item时修补；无通用推进/回退 API | 是持久投影，但不是 reopen authority；当前 producer不足以实施或校验“回退” |
| budget | par 的 `reopen_count` 与 `reopen_budget_ref`，读成 `ParReopenSnapshot` | 仅整树 import/旧盘迁移 | shape 已持久化；count 无增量 writer，budgetRef 无解析/额度值/耗尽 writer，因此不是可消费预算 |

所以 S3-U02 的“外部供给未知”可在当前基线收敛为：**四类均已有部分持久 shape，但只有 correction item 有生产 mutation ingress；target/cursor/budget 没有 reopen 所需的权威 writer，四类之间没有 scope/claim/decision transaction。** `decided-reopen` 只是 supplemental closure reachability seed；它接收的是 `closureId`，既不携带 target node、correction IDs、cursor 或 budget，也没有生产 caller，不能反推 reopen API。

### A2. 对稳定条款的地基资格

- **B2（三词 ADT）**：无供给。main 没有 decision ADT/carrier/parser。
- **B3（先创建 correction，decision 精确引用）**：部分地基。item mutation 可创建 chain-unique opaque IDs，batch 创建在一个 SQLite immediate transaction 内；但创建事件在 commit 后逐条发，且无 evaluation scope/target 归属。
- **B4（claim + reopen + cursor/budget + decision consumed 原子）**：无供给。不存在 claim、reopen effect、cursor rewind、budget increment、decision consumed 的共同 writer。
- **L3（target 重开、seq 回退、terminal item 不变）**：仅 identity/tree/lifecycle 底料。`setClosureLifecycle(activate)`只能恢复 suspended closure，不能追加 corrections或回退 cursor；`deleteItem`反而可向后修补 cursor。
- **L5（闭包分支上有无工作/是否发布）**：closure snapshot 持久保存 branch/worktree/base commit，可作为脚本定位输入；main 不持久化 mergedness/publishedness，GitHub 真相仍须声明通道外查。此事实与结构化 reopen authority分离。

### A3. 一致性与风险边界

所有 store write 都由 `db.transaction(fn).immediate()` 包装；SQLite 开启 foreign keys、5 秒 busy timeout、WAL（`src/sqlite-state.ts:822-850,1605-1612`）。因此**已有单个 writer 内**的 item batch、整树 import、lazy closure materialization等是原子的。但当前没有把四类事实写入同一 transaction 的入口，故不能把 SQLite 能力误报为 B4 已实现。

旧盘迁移在一笔 schema transaction 中物化 task tree；v16 rebuild只扩大 reachability seed CHECK。重启后四类 persisted shape可读取，但不会自动补出 decision、claim、cursor rewind或 budget consumption。

## B. 调查附录

### B1. 固定契约与术语边界

RFC-1 冻结裁决把 retry/reopen 对象钉为持久任务闭包，合法生命周期为 `suspended → active`，consume 后不可再 reopen（`v3/closure-lifecycle-decision.md:16,38-49`）；seq/par/join/reopen 是控制代数，且 mergedness 经声明通道由判定器自查（`:58,70`）。当前 main 另有两种同名但不同义的“reopen”：

1. scheduler 对既存 `(item,phase)` worktree/session 的资源恢复；
2. SQLite 文件 close/open 的测试动作。

两者均不是 B2–B4/L3 的结构化 `reopen(target, correctionItemIds)` consumer。本文只把它们当现存机制证据，不把名称当设计证明。

### B2. target：节点身份与合法性事实

#### B2.1 producer、carrier、持久化

- domain carrier 是 `TaskNodeIdentity { runtimeNodeId, definitionRef, definitionNodeId }`；树节点为精确 `leaf | seq | par` ADT（`src/task-runtime.ts:7-55`）。
- normalized tables以 `task_nodes.runtime_node_id` 为主键，记录 `chain_id,parent_node_id,child_index,kind`；leaf/seq/par再落各自表。closure通过 `leaf_node_id`、`item_row_id`、phase、`source_par_node_id`与结构相连（schema `src/sqlite-state.ts:680-737`）。
- producer 入口共三类：
  1. `createTaskTree(chainId, snapshot)`：精确 boundary 后递归整树写入，一条 immediate transaction（`:1974-1980,2363-2405`）；
  2. `recordRun* → ensureRuntimeClosure`：仅支持顶层 seq root，按首次运行 append leaf/closure；如果 root尚无 seq row才把 cursor设到该 leaf（`:1915-1917,2292-2336`）；
  3. legacy v13→v16迁移：为历史 item×phase物化稳定 node/closure identity并把 cursor初始化到首 child（`:1130-1162`）。
- reader只有 `getTaskTree(chainId)`返回完整 snapshot；没有 `getTaskNode(target)`或面向 reopen 的 target validator（store surface `:311-357`）。

#### B2.2 生命周期与状态转移

- closure identity是 `(item row,phase)`唯一，lifecycle为 active/suspended/consumed；scheduler phase leave/enter调用 `setClosureLifecycle(suspend|activate)`（`src/scheduler.ts:1755-1774`）。
- `setClosureLifecycle`验证 consumed不可逆、有active run不可离开active、activate须保留资源，并在 consumed 时删 sessions（`src/sqlite-state.ts:1985-1994`）。
- 这只校验一个 `closureId`，不校验结构化 target 是否已跑、是否与决策点同 seq、是否为允许回退的祖先/兄弟，也不追加 subtree。
- target的 `runtimeNodeId` 与 closureId、itemId 是三个不同 identity 域；当前没有 API 声明 reopen wire上的 `target`究竟取哪一个。不能从 `resourceState:"reopen"`或 reachability seed猜定。

#### B2.3 一致性、崩溃、历史兼容

- 整树 create 与 lazy closure materialization各自在 immediate transaction内；FK与父子/直接 cursor child校验阻止部分悬空状态。
- scheduler资源 reopen并非一个 transaction：run/closure资源记录可早于 suspended→active写入；这已由 DI-03定位，不能作为结构重开原子性。
- migration会生成 legacy identity并在重启后稳定读取；它保证历史可读，不保证 legacy节点满足未来“已跑/同 seq”target predicate。

#### B2.4 对消费者的影响与根因集合

可保留资产：typed identity、normalized parent/child、chain ownership、closure lifecycle invariants、完整树读取。  
缺口根因不是“少一个 enum”，而是：

1. wire target identity域未在 main实现；
2. 无权威 target lookup/predicate；
3. 无结构 append/reopen writer；
4. consumed不可逆，不能以 lifecycle API事后补救。

修补边界仅能陈述为：未来机制必须消费这些持久事实而不能由 reachability enum反推；本文不提出 API 形态。

### B3. 精确 correction IDs：item identity与创建面

#### B3.1 producer、carrier、writer/reader

- `ItemRecord.itemId`是 preset `idField` 语义下的 opaque string；物理 `items.item_id TEXT NOT NULL`，`UNIQUE(chain_id,item_id)`；内部 row id `items.id`是另一 identity（`src/sqlite-state.ts:106-147,580-587`）。
- CLI `item add/batch-add`经 daemon socket；单 add走 `handleItemAdd`，batch逐项做preset/rights/status/duplicate校验，再调用 `createItem(s)`（`src/loop.ts:2260-2290`; `src/daemon.ts:2887-2998`）。
- `createItems`把整批 `insertItem`放在同一个 immediate transaction（`src/sqlite-state.ts:1739-1743`）。`getItemById(chainId,itemId)`与`listItems`是读取面（`:1747-1759`）。
- daemon成功后返回完整 item JSON；`item.created` audit payload同时带内部 `rowId`与opaque `itemId`（`src/daemon.ts:2920-2937,2982-2998`）。

#### B3.2 authority、scope、claim

- itemId的权威唯一边界是**chain**，不是 evaluation epoch或 target container。
- agent mutation已有 caller/run/phase credential与preset rights gate；这证明“谁可创建 item”，不证明“该 item属于某次 reopen evaluation”。
- schema、request和audit payload均无 `evaluationScope`、`correctionOfDecision`、`targetNodeId`、claim token/owner。全仓也无 `correctionItemIds` carrier。
- item创建与后续 decision消费天然不是同一 transaction；B3允许这种先后，但 main连关联证据也未持久化。
- batch rows原子创建；commit后的逐条 audit event不是同一 DB transaction，事件中途失败不回滚 items。因此 event不能代替 correction claim authority。

#### B3.3 生命周期与 terminal语义

- correction目前只是普通 item，走普通 status、attempt、phase、scheduler路径；无 correction subtype。
- terminal状态属于preset词表，经 admission写入。没有 reopen consumer改写既有 terminal item；当前也没有“不改 terminal”的专门断言，因为对应写路径根本不存在。
- `deleteItem`会删除 runs/closures/nodes/item，并在被删 leaf恰为 seq cursor时把 cursor向后移到 surviving sibling（`:1849-1877`）。这说明普通 item mutation可影响结构，且语义是删除修补，不是 reopen claim。

#### B3.4 地基结论

opaque ID、chain唯一、批量原子创建、caller审计均可保留；但“精确 IDs”目前只能证明这些 rows存在，不能证明其 evaluation ownership、target membership、未被另一 decision认领。B3为部分地基，B4无 claim地基。

### B4. cursor：持久投影而非 reopen authority

#### B4.1 carrier与读取

- domain为 `SeqCursorSnapshot = next(nodeId) | complete`（`src/task-runtime.ts:40,44`）。
- SQLite carrier为 `task_seq_nodes.next_child_node_id`，FK指向任意 task node；读回时 NULL→complete，否则→next（`src/sqlite-state.ts:694,2499-2501`）。
- 整树 boundary另验证 `next.nodeId`必须是该 seq 的 direct child（`src/task-runtime.ts:131-136`; insert时再验证 `src/sqlite-state.ts:2388-2395`）。

#### B4.2 所有 writer

全仓生产 SQL写点只有：

1. legacy migration初始化首 node（`:1162`）；
2. `deleteItem`在当前 leaf被删时选择下一个 surviving sibling（`:1855-1873`）；
3. lazy root首次materialize时初始化到首 leaf，之后append不更新（`:2334-2335`）；
4. `createTaskTree`按输入snapshot写入（`:2393-2395`）。

没有 scheduler推进 writer、rewind writer、compare-and-set、epoch关联或 public `setSeqCursor` API。`getTaskTree`是唯一稳定读面。

#### B4.3 一致性与影响

这些 writer各自位于所属 immediate transaction；create boundary能拒绝非direct child。SQLite FK本身却不表达“同一 parent”，所以未来任何raw/update writer必须重复结构校验，不能只靠FK。

当前 cursor可作为“当前持久投影是什么”的事实；但由于正常生产并未全面以它驱动调度，也没有回退转移，它不能证明 reopen target合法或提供B4消费动作。删除测试仅证明向后修补：`tests/unit/sqlite-state/task-tree.test.ts:423-449`。

### B5. budget：持久 shape，无运行 authority

#### B5.1 carrier、schema、writer/reader

- domain为 par-local `reopen: { count:number>=0, budgetRef:non-empty string }`（`src/task-runtime.ts:41,45-53,140-146`）。
- SQLite为 `task_par_nodes.reopen_count CHECK >=0`、`reopen_budget_ref TEXT NOT NULL`（`src/sqlite-state.ts:695-701`）。
- writer仅整树 import/legacy materialization路径；生产代码对两列没有 UPDATE。reader随 `getTaskTree`返回 snapshot（`:2397-2401,2520-2527`）。
- `budgetRef`只是字符串引用；main没有在该表附近提供binding resolution、额度数值、remaining budget、increment、exhausted transition或审计。

#### B5.2 生命周期、一致性、重启

count/budgetRef与par row同事务创建并跨重启保留；exact boundary拒绝负count/空ref/多余字段。此为shape完整性，不是额度真相。`container_state`虽有`exhausted` variant，也无 reopen budget consumer把count与state原子推进。

#### B5.3 地基结论

par place上持久附着count/ref符合“预算随容器”的静态承载方向，但 main中 producer永远不累计，ref永远不求值；因此不能用于B4/L3的运行判定，更不能因测试round-trip就称预算API存在。

### B6. `decided-reopen` reachability：为何不是第五种权威 API

- `SupplementalClosureReachabilitySeedKind`允许 `open-append | decided-reopen | next-epoch-candidate`；`addClosureReachabilityFact`只验证closure属于chain并INSERT OR IGNORE（`src/sqlite-state.ts:294-301,2004-2016`）。
- 表只存 `(chain_id,closure_id,kind)`；edge只存closure间 `resume | scope-target`（schema `:726-737`）。
- reachability算法把seed/edge用于“是否可consume”固定点；它不修改task tree（`src/closure-lifecycle.ts:6-38,41-87`）。
- 全仓生产 caller对 `decided-reopen`/`next-epoch-candidate`为零；unit测试明确称其“without producer APIs”，另一个store测试仅手工seed验证保活、幂等和foreign chain拒绝（`tests/unit/runtime/closure-lifecycle.test.ts:27-47`; `tests/unit/sqlite-state/task-tree.test.ts:304-327`）。
- seed没有删除/consume API，因而即使未来writer出现，当前表面也只会永久保活，不能表达decision lifecycle。

直接机制只证明closure GC安全底料；上游来源是#560为future writer预留的reachability种类。把它提升成reopen authority会同时丢失target node、corrections、cursor、budget和decision epoch五组事实，是本调查排除的同名推断。

### B7. 事务、锁、崩溃与重启矩阵

| 边界 | 已有保证 | 未有保证 |
|---|---|---|
| item batch create | 单 immediate transaction；任一row失败整批回滚 | commit后events非原子；无evaluation scope/claim |
| task tree create | 整树+join/cursor/budget/closures单transaction | 仅初始化；不能重复create或消费decision |
| lazy closure | run writer transaction中materialize identity/resources | 只append顶层seq leaf；不追加correction subtree |
| lifecycle activate | 单closure update原子，consumed不可逆 | scheduler完整reopen时序不是单transaction |
| cursor | 各现有writer局部原子 | 无rewind/epoch/CAS |
| budget | 初始row原子 | 无increment/resolve/exhaust |
| reachability seed | 单fact幂等insert | 无producer lifecycle/removal/decision linkage |
| schema restart | WAL；migration transaction；shape跨reopen读取 | 不合成缺失decision/claim/effect |

如果进程在correction创建commit后、未来decision前崩溃，当前只留下普通items；没有scope判定它们是否孤儿。如果在任何未来结构效果之间崩溃，当前根本没有该共同writer可观察。故B4的“全有或全无”在main既未失败也未通过，而是不可执行。

### B8. 测试证据、同错与盲区

本轮在固定HEAD运行：

```text
bun test tests/unit/runtime/task-runtime.test.ts \
  tests/unit/runtime/closure-lifecycle.test.ts \
  tests/unit/sqlite-state/task-tree.test.ts
30 pass, 0 fail, 100 expect()
```

有效资产覆盖：

- exact task runtime ADT/多余字段拒绝；
- nested tree、cursor direct-child、join/reopen shape round-trip；
- identity跨DB reopen；
- typed reachability保活与foreign chain拒绝；
- migration cursor delete修补；
- closure lifecycle/resource/active-run invariants。

同错/盲区：

1. round-trip以snapshot作为输入，能证明carrier，不能证明producer authority；
2. 手工写`decided-reopen`只证明schema与GC算法，不能证明decision；
3. cursor测试只覆盖初始化与删除向后修补，没有推进/回退；
4. budget只参与boundary/round-trip，无increment/exhaust；
5. 没有 evaluation-scoped item创建、claim竞争、cross-seq target拒绝、terminal保持、四类同事务、crash recovery测试；
6. symbol存在、测试绿色、schema migration均不能补足这些运行路径。

### B9. 观察事实、机制、来源、影响、根因与修补边界

| 分类 | 结论 |
|---|---|
| 观察事实 | 四类shape分散；correction item ingress真实可用；target/cursor/budget只有初始化/读取底料；无共同decision/consumer |
| 直接机制 | normalized task tree、opaque item identity、immediate transactions、WAL、closure reachability |
| 上游来源 | RFC-1持久闭包/控制代数；future-writer reachability为GC保活预留，不是consumer |
| 历史原因 | v13迁移把线性item运行态物化为task tree；当前runtime仍以顶层seq lazy兼容路径为主 |
| 放大条件 | nested seq/par、并发evaluation、崩溃发生在item创建后、旧盘legacy identity、raw DB旁路 |
| 消费者影响 | #543若直接消费现有shape，会缺target legality、claim、cursor rewind、budget authority和decision lifecycle |
| 根因集合 | wire identity未落地；producer/writer缺失；四类无scope关联；无原子派发入口 |
| 修补边界 | R8只能把现有typed schema/transaction/identity列作可保留地基，并把缺失接口列为RFC-1供给阻塞；不得从enum或snapshot自行设计consumer |

### B10. 剩余未知与确定方法

1. **wire target最终取 runtimeNodeId、closureId还是另一个scope identity**：main无事实。确定方法是读取RFC-1后续落地的正式 decision boundary 与 producer，不从现有名称猜。
2. **budgetRef解析到哪一份定义/运行值**：main无resolver/caller。确定方法是追踪未来compile/runtime binding producer及其持久版本。
3. **correction scope/claim cardinality与冲突错误**：main无schema/API。确定方法是未来RFC-1 mutation/consumer实现及并发隔离测试。
4. **seq rewind的合法路径（ancestor/direct child/cross-seq）**：冻结需求只要求拒绝未跑/跨seq，main无predicate。确定方法是RFC-1正式target validator和嵌套树场景。
5. **未来四类是否必须同一store API实现**：B4要求效果原子，不等于公开API必须单函数；当前事实不能裁决接口形态。

### B11. 证据索引与尾部核对

主要代码证据：

- ADT：`src/task-runtime.ts:7-58,127-178`
- store API：`src/sqlite-state.ts:280-357`
- schema：`src/sqlite-state.ts:680-745`
- WAL/迁移/transaction：`src/sqlite-state.ts:822-850,948-1006,1605-1612`
- item writer：`src/sqlite-state.ts:1739-1759`; `src/daemon.ts:2887-2998`
- cursor/delete：`src/sqlite-state.ts:1849-1877`
- tree/lifecycle/reachability：`src/sqlite-state.ts:1974-2016,2292-2405,2499-2527`
- reachability算法：`src/closure-lifecycle.ts:6-87`
- frozen closure contract：`v3/closure-lifecycle-decision.md:38-58,70`

尾部核对：

- [x] 逐target/correction IDs/cursor/budget追踪producer、carrier、writer、reader、consumer与生命周期。
- [x] 穷尽生产SQL/API入口；区分初始化、兼容迁移、普通资源reopen和结构化reopen。
- [x] 覆盖事务/锁/WAL/崩溃/重启/历史兼容。
- [x] 列出测试有效资产、同错和盲区。
- [x] 未从`decided-reopen` enum反推权威API。
- [x] 未设计consumer、未新增需求、未估工、未改产品代码/测试/配置/WORKFLOW/生产DB。
