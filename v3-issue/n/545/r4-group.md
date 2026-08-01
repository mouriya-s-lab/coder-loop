# RFC #545 R4 供给侧调查：tree / group / run lineage / admission

## A. 主 agent 摘要（最多一页）

### 问题与结论

基线已核对：`main`，HEAD `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只以 `aggregate.md` 的 D2/D3/D7/D11/D14、S23–S28 为设计锚点。

**结论：main 已有一套可持久、可恢复、带稳定 par runtime node id 的树 shape，也已有 run→leaf closure 与“直接 par 父”谱系；但 group context 仍在 daemon begin admission 里按 scope variant 无条件拒绝。** 因此当前不是“没有树”，而是四层未接合：

1. 树存储能表示 `par`，`groupId` 被强制等于 `identity.runtimeNodeId`；
2. 正常 run 持久化有 `run.runtime_node_id → leaf → closure.source_par_node_id`，凭证却只缓存 `(chainId,item rowId,runId,phase)`；
3. context admission 不查询树、run 或 par 表，看到 `scope.kind === "group"` 就直接返回 `group-unavailable-v2`；
4. context 没有 socket 读取命令，store 读取也只有按 chain 全列出，因而 S23/S24/S27 的消费者路径尚不存在。

这不是单一 daemon 分支问题。即便删掉拒绝分支，store 的 `context_entries.scope_key` 对 par 无 FK，`appendContextEntry` 也不校验 group 所属 chain/存在性；正常生产路径只自动物化 seq root + leaf，源码中没有 par 生产调度或 par state 更新；直接 par 子 leaf 有单一 `sourceParNodeId`，但嵌套 par 经 seq 后的后代不会在 closure 字段保留祖先链。至少是 admission、store invariant、生产物化、谱系解析、读取 API 五个接缝。

### 稳定语义三态

| 锚点 | 判断 | 置信边界 |
|---|---|---|
| D2 / S23 | **偏离** | group append 一律拒绝；无 context read；无真实 par 调度。树 fixture 能稳定表示一个 group，但不构成互见路径。 |
| D2 / S24 | **未实现** | chain 内可见性与 group filter 的 read contract 均不存在；现有 `listContextEntries(chainId)` 是内部全列举。 |
| D11 / S25 | **偏离** | wire 路径对不存在键和真实键给同一 `group-unavailable-v2`；direct store 可写任意非空 group key，形成虚空或跨 chain 指向。 |
| D11 / S26 | **部分符合但原因过宽** | 无容器 item 确实拒绝，然而有真实容器也同样拒绝；未从凭证谱系判定“无容器”。 |
| D2 / S27 | **静态地基存在、能力未实现** | terminal par 行/树节点不会因 join state 自动删除，soft chain delete 前树仍可寻址；但 context read 不存在，soft delete 会删全部 entries。 |
| D14 / S28 | **部分符合** | `TaskNodeSnapshot` 是 `leaf|seq|par`，已有递归穷尽 switch；但 `isTaskNodeSnapshot` 以顺序 if/fallthrough 解析而非显式穷尽 switch，context scope 自身有穷尽转换。 |
| D3 | **group 所需身份部分具备** | daemon credential 权威绑定 chain/item/run/phase，并验证 active run；可由 run row继续解析 leaf/closure/par，但 credential registration 本身没有 closure/runtime/group。 |
| D7 | **写半边部分符合，读半边缺失** | CLI→socket→daemon 三段 append 与每段 admission audit 已有；read socket 命令没有。commit 是 DB append 后再写 audit，存在“entry 已落库但 allow audit 未写”的崩溃窗口。 |

### 复杂因果、当前/未来影响与证明缺口

- **多因一果**：“group 一律拒绝”表面是 daemon 分支，深层还有正常运行态不生产 par、credential 不携带/不解析 lineage、store 不守 group FK、没有 read/filter consumer。只改分支会把安全拒绝变成可写伪 group。
- **身份来源**：可信链来自 daemon 内存 credential registry；run 持久行另有 `chain_id/item_id/closure_id/runtime_node_id/phase`，closure 有 `source_par_node_id`。因此无需相信调用方 group claim，但必须验证显式 group key既属于目标 chain 的真实 par，又符合最终裁定的 run/group 谱系规则。
- **嵌套边界**：当前 `sourceParNodeId` 只表达 leaf 的**直接** par 父。`par → seq → leaf` 时 leaf 值必须为 null；若未来 K4a 需要祖先链，只能遍历 task_nodes parent 链/树，不能把现字段误当完整祖先谱系。
- **生命周期**：par `completed|exhausted` 仍保留；closure consumed 仍保留 identity；重启从 SQLite恢复树。soft `chain.delete` 只标 deleted、明确删 context entries，树仍在；physical `deleteChain` 才由 FK cascade 删除树与 entries。join 后“自由读”不能跨 soft delete。
- **事务/崩溃**：树创建、run/closure 写、单 entry append 各自用 SQLite immediate transaction；context begin/chunk session只在 daemon 内存，重启即丢。commit 先删除内存 session，再 append DB，再异步 audit，DB/audit 不原子。

### 可保留资产、负资产、未知与下一步

**可保留资产**：`TaskNodeSnapshot` ADT；`runtimeNodeId` 稳定主键；`groupId===runtimeNodeId` boundary invariant；normalized `task_nodes/task_par_nodes/task_closures/runs`；run→leaf durable identity；直接 par parent 的 DB trigger；chain-scoped credential registry；`findTaskNodeIdentity` 的穷尽递归；context scope/author ADT 与 append socket/audit框架。

**负资产**：文案与 reason `group-unavailable-v2` 把已出现的 v3 tree 误称为“v2 无 par”；scope-kind 无条件拒绝；store 允许任意 group key；只有直接父的 `sourceParNodeId` 容易被误用为完整谱系；正常生产只追加 seq leaf；无 read command/filter。

**未知**（需后续设计/实验证明，不在本调查裁决）：真实 par runtime producer 将如何生成 collision-free runtimeNodeId；K4a 嵌套 par 取最近祖先还是祖先链；S23 fixture 与 S45 真实调度验证分工；终态 par state 的正式更新 API（当前源码无 updater）。

**下一步**：供需匹配时必须把“验证真实 par key 属于 chain”与“验证 caller run 对该 group 的谱系资格”拆开；查询应基于 normalized parent chain 或树穷尽遍历，不以 `sourceParNodeId` 单字段冒充嵌套祖先链；先明确 producer，再接 admission/read，最后分别覆盖 fixture 与真实调度验证。

## B. 证据附录

### B1. 设计三态详表

#### D2：group = par 物化稳定容器 id

- **shape 符合**：`TaskParNodeSnapshot.groupId` 存在，boundary 要求其等于 `identity.runtimeNodeId`（`src/task-runtime.ts:45-55,127-146`）；SQLite 只存 `task_par_nodes.runtime_node_id`，读取时确定性重构 `groupId`（`src/sqlite-state.ts:695-702,2520-2527`）。这避免双重可漂移 ID。
- **生产偏离**：正常 `recordRun` 进入 `ensureRuntimeClosure`；无树时创建 `chain:<id>:root` seq，有树时要求 root 为 seq，然后把 leaf追加为 root 直接子节点，closure 的 `source_par_node_id=NULL`（`src/sqlite-state.ts:2292-2336`）。源码内 `createTaskTree` 的调用均在 tests/scripts，没有 daemon/scheduler production caller；par 没有 UPDATE production API。
- **消费偏离**：context CLI 只有 append（`src/loop.ts:1943-1986,1969`）；daemon command union/spec 只有 `context.append.begin/chunk/commit`（`src/daemon.ts:203-205,1763-1765`）；store 只有 `listContextEntries(chainId)` 全列举（`src/sqlite-state.ts:354-356,2056-2063`）。

#### D3：凭证所属 chain 与 run identity

- credential issuer mint 时存 daemon 内存 `{value, context}`（`src/daemon.ts:4381-4395`）；context 含 `chainId,itemId(row id),runId,phase`（`src/scheduler.ts:416-432`）。
- request resolution拒绝空/未知/非 active credential，并从 registry 构造 caller；调用方不能自报 chain/run/phase（`src/daemon.ts:3949-3996`）。author 再把 row id解析成业务 item id，并拒绝 cross-chain（`src/daemon.ts:1769-1775`）。
- durable run row同时持有 `closure_id`、leaf `runtime_node_id`（`src/sqlite-state.ts:2261-2276`）；insert run从 `(item row,phase)` closure association派生二者（`src/sqlite-state.ts:1643-1671`）。所以可由可信 runId继续解析真实 leaf及其 ancestors，而不是信任 CLI group key。
- 缺口：credential registration没有 closure/runtimeNode/group；当前 context resolver也从不查 run/tree。daemon 已有类似 `resolveStoredRunTaskIdentity` 从 run row与 tree解析 node的可复用模式（`src/daemon.ts:813-824`），但它只返回 identity，不返回 ancestors。

#### D11：键必须解析到本 chain 真实对象

- item scope做 `getItemById(chain.id,itemId)`（`src/daemon.ts:1865-1869`）。
- group scope无论 key、tree、caller为何，直接拒绝（`src/daemon.ts:1870-1873`）。所以不存在 group key admission，真实/伪造/跨 chain完全同形。
- DB `context_entries.scope_key` 是普通 TEXT，无到 `task_par_nodes` 的 FK（`src/sqlite-state.ts:775-784`）；`appendContextEntry`只做 insert，不验 chain/group（`src/sqlite-state.ts:2045-2054`）。store API可直接写 `groupId:"other-chain-par"` 或不存在 key。当前 wire hard reject遮住此负资产，但取消拒绝后会立刻暴露。
- par 自身可通过 `task_nodes.chain_id`核验所属 chain（`src/sqlite-state.ts:661-672`）；因此“真实且本 chain”有现成数据，不应仅按全局 `runtime_node_id`存在性判断。

#### D14 / S28：ADT 穷尽

- 节点 union封闭为 leaf/seq/par（`src/task-runtime.ts:43-55`）。insert使用 switch + assertNever（`src/sqlite-state.ts:2363-2405`）；daemon递归查 identity 使用 switch + assertNever（`src/daemon.ts:1132-1144`）。
- snapshot boundary递归校验 exact keys，并强制 groupId identity（`src/task-runtime.ts:127-146,167-178`）。
- context scope boundary及 CLI/persisted转换均三 variant switch + never（`src/context-entry.ts:4-10,119-145`）。
- 置信边界：`isTaskNodeSnapshot`不是显式 switch，而是 leaf/seq 后把其余值判作 par（仍会拒绝未知 kind，但新增 variant不会由此函数的 switch产生编译错误）。故不能把全链路 S28 判为完全符合。

### B2. par ID 完整生产链

1. **声明/构造**：外部 typed `TaskTreeSnapshot` 提供 `identity.runtimeNodeId`及相同 `groupId`；boundary拒绝两者不等（`task-runtime.ts:127-146`）。当前只见 tests/scripts调用 `createTaskTree`，无 production compiler/materializer。
2. **物化**：`createTaskTree`在 immediate transaction里 boundary parse、递归 `insertTaskNode`（`sqlite-state.ts:1605-1611,1974-1981`）。par写 `task_nodes`公共行 + `task_par_nodes` kind行 + join binding/evaluation + children（`2363-2405`）。
3. **存储**：`runtime_node_id`是全局 PK；每 node带 `chain_id,parent_node_id,child_index,kind`（`661-672`）。par专表以同 ID 为 PK/FK（`695-702`）。
4. **恢复/snapshot**：`getTaskTree(chainId)`从 task_trees root递归 children（`2477-2488,2491-2509`）；par读取时用 identity runtime id重构 groupId（`2520-2527`）。重启不重新生成 id。
5. **终态**：par state列支持 `open|completed|exhausted`，读取不按 state过滤；但当前没有 update函数，fixture写入什么就保持什么。

### B3. leaf/item/run 谱系与所有入口

- leaf closure含 item row/business id、phase、lifecycle、`sourceParNodeId`（`task-runtime.ts:15-26,43`）。
- createTaskTree递归时只看**直接 parent kind**：直接 par child leaf必须 `sourceParNodeId=parentNodeId`；非直接 par child必须 null（`sqlite-state.ts:2363,2376-2385`）。DB trigger复制这一约束（`762-773`）。
- 正常 run入口：`recordRun`/`recordRunWithClosureResources`→`ensureRuntimeClosure`→closure→run durable ids（`344-347,1643-1671,2292-2336`）。
- active run入口：`setCurrentRun`再次核对 run closure/runtime identity后写 active_runs（`1945-1965`）；fixture tree active runs也核对 chain/closure/run（`2468-2475`）。
- 历史迁移：v13每 chain物化 seq root和每 item/phase leaf，所有 `source_par_node_id=NULL`，随后 run identity回填到 closure/leaf（`1121-1175,1108-1119`）。历史不会凭空拥有 group谱系。
- item delete会删 runs，推进 seq cursor并删相应 node/closure；这条逻辑只显式维护 seq cursor，未见 par child/item deletion专项语义（`1849-1870`及后续同函数）。

**嵌套边界**：`par→par→leaf` 的 leaf只能指内层直接 par；`par→seq→leaf` 的 leaf必须 null。完整祖先关系仍在 `task_nodes.parent_node_id`/snapshot children中，可遍历；`sourceParNodeId`不是祖先链。

### B4. group 无条件拒绝的跨层机制

- CLI精确接受显式 `--scope group --group <id>`并构造成 group ADT（`loop.ts:1943-1960`; `context-entry.ts:130-136`）。
- daemon parse后，在 author resolution和session创建之前执行 scope-kind拒绝（`daemon.ts:1852-1881`）。所以 operator/agent、真实/伪键、组内/组外、open/terminal par全拒绝。
- reason ADT与 wire error固定为 `group-unavailable-v2`（`context-entry.ts:42-59`; `daemon.ts:1870-1872`）。
- “历史兼容/迁移原因”只找到源码事实：main 独立 v14 context 与 v3 runtime表在 v15合并（`sqlite-state.ts:808-810`），历史 v13迁移只造 seq（`1121-1175`）。没有证据证明为何拒绝文案在 tree出现后仍保留；该历史动机记为**未知**，不能由注释/commit推断。

消费者影响：目前不会落伪 group entry，S07拒绝稳定；同时所有真实 group写、互见、组外过滤、join后读取都不可达。测试把这一拒绝当预期，构成对旧行为的同错锁定，而非 group真实化证明。

### B5. terminal、join、delete、restart

- join binding/evaluation和par state均持久；snapshot读取不剔除 terminal par或 consumed closure（`task-runtime.ts:28-54`; `sqlite-state.ts:2430-2455,2520-2527`）。因此 join后 node ID在同 chain树内仍可寻址。
- daemon restart重新 open SQLite即可恢复 tree/run rows；credential registry和context append sessions是内存 Map，不恢复。活动 credential必须重新由运行生命周期 mint；半成 append丢失。
- daemon `chain.delete`是 soft delete：先停 run/cleanup，再 `status=deleted`，invalidate sessions并明确删除 context entries（`daemon.ts:2505-2541`）；未物理删 tree。所以树可能仍可读，但 S27 entries已不存在。
- store `deleteChain`物理 DELETE，FK cascade清树、closures、runs、entries（`sqlite-state.ts:638-784,1736-1737`）。这符合 chain级生命周期清除，但 soft/physical两阶段必须在消费者语义中区分。

### B6. 事务、锁、迁移与崩溃窗口

- store所有 mutation由 `db.transaction(fn).immediate()`包裹（`sqlite-state.ts:1605-1611`）；create tree递归、run+closure、单 entry append各自原子。
- context三段协议不是一个 DB transaction：begin/chunk仅内存 Map；每一段单独写 observability event。commit先删 session，再 DB append，再 await audit（`daemon.ts:1909-1917`）。若 append失败，session已丢；若 append后进程崩溃/事件写失败，entry存在而 allow audit缺失。没有观察到跨 SQLite/事件文件事务。
- migration总体在 immediate transaction中执行并按需关/开 foreign_keys（`sqlite-state.ts:1077-1090`）；v13→normalized runtime只造 seq/leaf，不造伪 par。迁移崩溃由 SQLite事务回滚，未发现 context group专属迁移。
- 并发：SQLite immediate串行 store writes；context session Map的 sequence检查在单 daemon event loop内，但 commit 删除session后才写 DB。没有 group-specific race，因为当前在 begin即拒绝。

### B7. 边界矩阵

| 边界 | 当前事实 |
|---|---|
| nested par | tree可表示；closure仅直接 parent单键，祖先须遍历。 |
| 同 chain 组外 item | credential能识别 chain/item/run，但没有现成 group membership resolver；当前一律拒绝。 |
| 不存在 group key | wire拒绝 `group-unavailable-v2`；direct store可落虚空。 |
| 跨 chain真实 group key | wire同样拒绝；direct store可在 A chain entry写 B chain key，因为无 FK/校验。 |
| terminal group | tree仍保留并可 snapshot；无 context read。 |
| 历史 tree | v13迁移为 seq，无 group；normalized fixture par可持久恢复。 |
| chain restart | tree恢复；credential/session不恢复。 |
| chain delete | soft delete删 entries但留树；physical delete级联全删。 |

### B8. 写入口、读消费者与穷尽点索引

**tree写入口**：`createTaskTree`; `ensureRuntimeClosure`; migration `migrateLegacyRuntimeToV3`; item deletion/cursor maintenance; closure lifecycle/resource/session updates; run/active-run insert/complete。没有 par materialize/update production入口。

**context写入口**：daemon三段 append是用户/agent socket入口；store `appendContextEntry`是内部直写入口，tests亦直接使用。后者绕过 admission/audit/key validity，因而不能作为 D7生产入口。

**context读消费者**：仅 tests/internal store `listContextEntries(chainId)`；无 daemon command、CLI read、group filter或 GUI contract。

**ADT穷尽点**：`insertTaskNode`, `findTaskNodeIdentity`, closure collectors/lifecycle traversal（同类在 `src/closure-lifecycle.ts`），context scope key/CLI/persisted conversions。`isTaskNodeSnapshot`是运行时 exact boundary但不是编译期 switch穷尽。

### B9. 测试覆盖、同错与盲区

- 覆盖 par shape roundtrip、groupId identity、direct par source invariant、join history恢复：`tests/unit/sqlite-state/task-tree.test.ts:205-247,397-408`。
- 覆盖 credential author、cross-chain credential、stale credential、session ownership与 audit：`tests/integration/daemon/context.integration.ts:4-87`。
- 覆盖 group拒绝并明确断言 code/reason：`context.integration.ts:114-175`。这是 S07回归，不证明真实 key判定；未来若只改实现而不重写该断言会形成旧行为同错。
- 覆盖 soft delete清 context：`context.integration.ts:89-112`。
- 盲区：真实 par producer；两个真实 branch credentials；group key本 chain存在性；caller membership；组外 filter；跨 chain key；nested ancestor；terminal join后 read；store direct invalid group防御；commit DB/audit crash；par child item delete；restart后真实 par group行为。

### B10. 最小实验与限制

未运行写数据库实验。静态证据对关键结论已决定性：无 production `createTaskTree` caller、无 par updater、daemon无条件分支、store schema无 FK、无 read command。为避免产生额外 fixture/副作用，本调查只执行 `pwd`、`git branch --show-current`、`git rev-parse HEAD`、`rg`、`nl/sed`只读命令。没有修改产品代码、测试、配置或生产数据库。

若后续需要验证静态未知，最小隔离实验应放 `/tmp/rfc545-r4-group/`：新 loopDataRoot中手工 `createTaskTree(par(leaves))`，分别证明 restart roundtrip、soft delete tree/entry分离，以及 direct store可落跨 chain group key；该实验仍不能替代真实 par调度。

### B11. 资产判断：能否作为 S23–S28 地基

- **S23**：可保留 ID/树/run lineage 底座；尚不能直接消费为功能，缺 producer、membership resolver、read/write admission。
- **S24**：chain boundary有底座，group filter无底座 API。
- **S25**：par chain ownership数据有底座；context store/admission未接，且 direct store是负资产。
- **S26**：现拒绝框架/audit可保留；reason判定必须从“scope kind”改为真实容器/谱系结果，不能简单放行。
- **S27**：terminal tree保留是地基；context lifecycle/read缺失，soft delete明确清除。
- **S28**：node union与多数 traversal可保留；新增 ancestry traversal必须显式穷尽，不能仅依赖 `sourceParNodeId`。

## 完整交付声明

本报告已覆盖统一任务书要求的稳定 ID生产链、run/item/leaf谱系及入口、credential/admission身份、group无条件拒绝的跨层原因、terminal/join/delete/restart、嵌套/组外/伪造/跨 chain/历史边界、写读入口与 ADT穷尽点、测试同错/盲区、事务/迁移/崩溃窗口、可保留与负资产以及 S23–S28 地基判断。证据不足的历史动机与未来 producer/K4a/K1均明确标未知，未作需求裁决。
