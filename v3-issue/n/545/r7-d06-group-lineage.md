# RFC #545 R7 D-06：par 生产、group 身份、嵌套谱系与 lifecycle 地面事实

## A. 主 agent 摘要（最多一页）

### 问题、结论与置信边界

基线已核对为 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。调查只使用 `aggregate.md` D2/D3/D6/D11/D14、S23/S25/S27/S28、CAP-IN-2，R6 D-06 与 R5 L020/L022/L024/L035；不裁决 K1/K4a。

**结论分两层：**

1. **真实当前 compiler→scheduler 路径不能产生 par 分支 run。** preset schema 只有扁平 `[[phases]]`；compile 固定生成 `seq(root) → seq(phase) → phase leaf`；scheduler 不物化该 compiled tree，而是在每个 run 写入时调用 `ensureRuntimeClosure`，固定创建/要求一个 durable seq root，并把 leaf 作为 root 直接子节点追加，`source_par_node_id=NULL`。若 fixture 预置 par root，正常 scheduler run 的新增 closure反而在 `runtime closure append requires seq root` 断开。全仓 production 中没有 `createTaskTree` caller、par updater、par state updater或并行 branch scheduler。
2. **durable store 能表达并恢复 par 与完整结构祖先，但当前没有“run→可寻址 group 集合”的生产 resolver/admission。** run durable row给出 `chain_id + runtime_node_id(leaf) + closure_id`；`task_nodes.parent_node_id` 可从 leaf遍历全部 par祖先；直接 par父另冗余在 `closure.source_par_node_id`。隔离 fixture实验证明 nested par、terminal inner par、run rows和完整树重开后逐字稳定。可是“最近 par 单键”还是“全部 par祖先集合”正是未裁 K4a；已有字段不能替代裁决，且没有任何 consumer执行该遍历。

**因此，对调查问题的严格回答是：** 在 fixture 能构造的树中，durable state **足以机械恢复候选的直接/全部 par祖先**，稳定 group identity 是 par `runtime_node_id`；但当前真实 scheduler 不产生这种 run，产品也不能把候选变成已定义的“可寻址 group 容器集合”，不能基于成员关系接受真实 key或拒绝非成员 key。wire admission 对所有 group key（真实成员、不存在、同 chain组外、跨 chain）统一硬拒绝；direct store则反向地全部接受，能落虚空和跨 chain key。

### 因果链、后果、资产与未知

- **声明/compile断点：** preset boundary无 task-node variant；compiled task类型只有 seq/phase。**materialize断点：** scheduler只经 `recordRunWithClosureResources → ensureRuntimeClosure`造 seq+leaf。**update/terminal断点：** par kind tables能存 `open|completed|exhausted` 与 join history，却只有 create-time insert/read，无 production update API。不是删掉 daemon 的 group hard-reject即可解决的单点问题。
- **身份与授权：** active credential由 daemon内存 registry权威绑定 `(chainId,item rowId,runId,phase)`，可用 runId查 durable leaf；credential本身不含 closure/group。restart后 registry与active process state不恢复，历史 run/tree仍在，故“durable lineage可恢复”不等于“旧 credential可继续使用”。
- **嵌套：** direct `par→leaf` 的 `sourceParNodeId`等于直接父；`par→seq→leaf` 必须为 null；`par→…→par→leaf`只记录内层直接 par。完整祖先只能用 parent chain/tree递归恢复。fixture中三者分别观测为 `outer / null / inner`。
- **lifecycle：** run complete、closure suspend/consume、par terminal均不改 runtime node id；SQLite重开恢复同一 tree。item delete会删除该 item的 run与leaf，从而再也不能由该 run恢复 lineage，但不专门删除祖先 par。soft chain delete保留tree/run行却清空context entries；physical chain delete由FK级联清除tree/run/entries。故稳定身份的边界是“寻址对象与其 run仍在该 chain durable state内”，不是无限历史保证。
- **非成员 key确定后果：** wire永远返回 `group-unavailable-v2`，没有真假/成员差异；direct store实验在 chain A同时写入 `par:outer`、不存在的 `missing`、chain B的 `par:b`，重开后三条均保留并被 chain A全量list读出。现有 store无 group FK、ownership或membership检查，无scope filter read。
- **可保留资产：** `TaskNodeSnapshot`封闭 union；`groupId===runtimeNodeId` boundary；normalized parent chain、run→leaf FK、direct-parent trigger；递归 snapshot恢复；credential的chain/run权威来源；多数node traversal的穷尽switch。
- **仍未知/留给裁决：** K4a定义哪个祖先候选可寻址；K1如何分配fixture证明与真实调度证明。若要确定未来producer的runtime ID生成、并发物化、par terminal updater行为，必须在该producer实际进入基线后沿真实scheduler跑隔离E2E；当前不存在可执行路径，不能用fixture补称真实生产。

当前事实已经足以作为 K1/K4a 输入；本报告不选择答案、不提出issue或实现方案。

## B. 证据附录

### B1. 观察 → 机制 → 来源 → 历史 → 放大 → 消费者 → 根因集合 → 修补边界

| 层 | 地面事实 |
|---|---|
| 观察 | 正常 scheduler 树只出现 seq root + leaf；group wire全部拒绝；fixture可持久nested par但direct store可写任意group key。 |
| 直接机制 | `buildCompiledTaskTree`只造seq；`ensureRuntimeClosure`只允许seq root并把leaf直接追加；daemon按`scope.kind === group`无条件拒绝；store append只INSERT文本key。 |
| 上游来源 | preset TOML只有phase数组；scheduler每次spawn按phase记录run；group id只来自外部构造的`TaskTreeSnapshot` fixture。 |
| 历史 | v13 migration为每chain造seq root/leaf并回填run identity，全部`source_par_node_id=NULL`；v3 normalized schema能存par；context v14/v15 schema允许group文本，但未接producer/consumer。源码能证明迁移形状，不能证明历史动机。 |
| 放大条件 | 一旦仅移除hard reject，direct store现状会允许不存在/跨chain/非成员key；一旦出现nested par，只读`sourceParNodeId`会漏outer祖先；restart会丢credential registry。 |
| 消费者 | 当前tree消费者为scheduler closure/resource/recovery、daemon event identity与status；context消费者只有append CLI/socket及内部chain全量list。没有group resolver/filter/membership消费者。 |
| 根因集合 | 声明语言无par + compile固定seq + runtime materializer固定seq + 无par updater/scheduler + credential未解析lineage + admission无条件拒绝 + store无referential/membership invariant + read/filter缺失。 |
| 修补边界 | 只改daemon拒绝分支保留其余根因并暴露伪key；只加store FK无法表达run membership/nested ancestor；只依赖direct-parent字段会漏经seq和外层par。此处仅界定事实，不推荐方案。 |

### B2. 声明与 compile 链

1. `PresetPhaseBoundary`/`PresetTomlBoundary`仅接受phase数组，无seq/par/leaf声明variant（`src/loop.ts:490-518`）。
2. compiled ADT实际不是runtime node ADT：`CompiledTaskNode={kind:"phase"}`、每phase和root均固定`kind:"seq"`（`src/loop.ts:780-786`）。
3. `buildCompiledTaskTree`确定性生成 `tasks:root(seq) → phase:<name>(seq) → task:<name>(phase)`（`src/loop.ts:864-875`）；load compile把它放入model（`src/loop.ts:4686-4694`）。
4. scheduler只消费compiled phase leaf identity作为execution-definition packet（`src/scheduler.ts:1621-1626`）；migration helper同样只投影phase/definitionNodeId（`src/preset-migration-definition.ts:22-31`）。compiled tree没有被materialize成runtime par/seq结构。

**确定断点：** 当前声明面无法声明par；即使手工拿到runtime par snapshot，也不是compiler产物。

### B3. runtime materialize / run / credential完整链

1. scheduler spawn先从已存tree按`(item row,phase)`找closure，再调用`recordRunWithClosureResources`（`src/scheduler.ts:1581-1595,1607-1635`）。
2. store insert run总先调用`ensureRuntimeClosure`，随后从`task_closures(item_row_id,phase)`派生`closure_id + leaf_node_id`写入run，不相信caller自报runtime node（`src/sqlite-state.ts:1643-1671`）。
3. 无tree时`ensureRuntimeClosure`创建稳定字符串`chain:<id>:root` seq；已有root必须是seq，否则拒绝；新leaf固定为root直接子，closure固定`source_par_node_id=NULL`（`src/sqlite-state.ts:2292-2336`）。
4. active run再核对durable run与closure identity才写`active_runs`（`src/sqlite-state.ts:2468-2475`）。
5. credential mint只在daemon内存Map注册opaque UUID和`chainId,itemId,runId,phase`，close时撤销（`src/daemon.ts:4381-4395`; context type `src/scheduler.ts:416-433`）。caller resolver还要求registration对应当前in-memory active run（`src/daemon.ts:3949-3996`）。
6. daemon已有“runId→durable run→tree中leaf identity”的事件identity resolver，但只返回leaf identity，不返回ancestors（`src/daemon.ts:813-824,1132-1144`）。

**正常生产是否仅seq+leaf：是。** `rg createTaskTree` 的非测试命中只包括store定义；脚本`issue-560-integration.ts`直接构造fixture。没有daemon/scheduler production caller。`task_par_nodes.container_state`只有insert/read（`src/sqlite-state.ts:2397-2402,2519-2527`），无UPDATE/updater。

### B4. durable lineage与嵌套表达

#### B4.1 表与约束

- `task_nodes.runtime_node_id`全局PK；每node有`chain_id,parent_node_id,child_index,kind`，parent FK形成完整树（`src/sqlite-state.ts:661-672`）。
- `runs`以复合FK绑定`(closure_id,runtime_node_id)`到真实closure/leaf（`src/sqlite-state.ts:630-634`）；run row可稳定定位leaf。
- `task_closures.source_par_node_id` FK到par，但insert trigger规定：只有leaf的**直接 parent**为par时才必须等于该parent；否则必须null（`src/sqlite-state.ts:677-691,762-773`）。
- snapshot insert再执行同一直接父规则（`src/sqlite-state.ts:2363-2385`）。
- snapshot recovery按parent children递归并对node kind穷尽switch；par `groupId`由identity runtime id确定性重构（`src/sqlite-state.ts:2477-2527`）。

#### B4.2 三种嵌套形状的确定含义

| 形状 | `sourceParNodeId` | durable parent chain可恢复候选 |
|---|---|---|
| `par outer → leaf` | `outer` | `[outer]` |
| `par outer → seq → leaf` | `null` | `[outer]`，但只能遍历parent/tree获得 |
| `par outer → … → par inner → leaf` | `inner` | `[inner, outer]`，单字段只有inner |

所以L020的“direct parent不是祖先链”被运行实验复现。当前数据**没有丢失结构祖先**，丢失的是现成投影/API及K4a语义选择；若未来结构更新不保留parent chain，结论需重新验证。

### B5. par create/update/terminal/restart/delete

- `createTaskTree`在single immediate transaction中boundary parse并递归insert，chain只允许创建一次（`src/sqlite-state.ts:1974-1981,2363-2405`）。它是公开store API，但当前仅fixture/script caller。
- par insert写identity、pin/reopen/state、join binding/evaluation、children；没有production追加child、改state、reopen或join updater（`src/sqlite-state.ts:2397-2402`；公开store面只有`listJoinBindings/listJoinEvaluations`，`src/sqlite-state.ts:341-356`）。
- `completed|exhausted`与join evaluation只是持久字段；recovery不按terminal过滤（`src/task-runtime.ts:45-54`; `src/sqlite-state.ts:2519-2527`）。因此fixture terminal par身份在restart后稳定，但这不证明真实terminal transition，因为没有transition producer。
- run completion只更新run；closure lifecycle更新资源/状态，node identity不变。item delete显式删该item的active run、runs、leaf kind row和leaf node，并只维护seq cursor（`src/sqlite-state.ts:1849-1876`）；删除后该run及leaf lineage不可恢复，祖先par未被专项处理。
- soft chain delete更新status、清理runtime资源、invalidate内存context session并删除该chain entries，但不物理删tree/run（`src/daemon.ts:2505-2541`）。physical `deleteChain`删chain，runtime与entries由FK cascade清除（`src/sqlite-state.ts:653-783,1736-1737`）。
- process restart重开SQLite即可恢复tree/run；credential registry与append session是内存Map，不恢复。因admission要求active credential，旧run的durable lineage不能让旧credential复活。

### B6. 所有 group key write/read/filter/membership 点

#### B6.1 输入、编码与持久化

- CLI精确接受`--scope group --group <nonempty>`并构造scope ADT（`src/loop.ts:1943-1967`; `src/context-entry.ts:7-10,130-136`）。
- wire/persisted ADT都包含group，`contextScopeKey`把groupId写成scope_key，read parser原样重构（`src/context-entry.ts:4-10,87-100,121-145`）。
- DB表只约束`scope_kind`词表和scope_key文本，没有到`task_par_nodes`或chain ownership的FK（`src/sqlite-state.ts:775-784`）。
- store `appendContextEntry`只INSERT，既不查group存在，也不查chain或caller lineage；`listContextEntries`只按chain全列出（`src/sqlite-state.ts:2045-2063`）。

#### B6.2 admission、read/filter与membership

- daemon begin先做item存在检查；group则不查tree/run/key，统一审计并抛`group-unavailable-v2`（`src/daemon.ts:1852-1881`）。真实、伪造、跨chain、terminal、成员/非成员完全同形。
- commit只使用begin session中scope调用公开store append（`src/daemon.ts:1909-1917`）。
- CLI只有context append子命令，没有read（`src/loop.ts:1969-1986`）；daemon command面也没有context read；store list无scope filter。
- 全仓没有group membership resolver。可用身份资产是credential→runId与run row→leaf，但没有调用点把它连接到parent traversal。

**后果矩阵：**

| 输入 | daemon socket | direct store | 当前read |
|---|---|---|---|
| caller真实祖先par key | 一律拒绝 | 接受 | chain全量list可见 |
| 同chain但非ancestor par | 一律拒绝 | 接受 | 同上 |
| 不存在key | 一律拒绝 | 接受，产生虚空entry | 同上 |
| 他chain真实par key | 一律拒绝 | 接受，entry仍记当前chain | 同上 |
| terminal par key | 一律拒绝 | 接受 | 同上 |

### B7. 隔离实验

#### B7.1 环境与脚本

- 路径：`/tmp/rfc545-d06/experiment.ts`
- SQLite：`/tmp/rfc545-d06/state/db.sqlite`
- 输出：`/tmp/rfc545-d06/output.json`
- 命令：`bun /tmp/rfc545-d06/experiment.ts > /tmp/rfc545-d06/output.json`
- 未修改产品、测试、配置或生产DB；实验只用全新loopDataRoot。

#### B7.2 构造与观察

构造chain A的`par:outer(open)`，其children为：direct leaf、nested seq（含via-seq leaf与`par:inner(completed)→inner leaf`）；为三leaf各写durable run。另造chain B的`par:b`。关闭store重开后：

- `stableTree=true`；outer/inner id、terminal state、三run的runtime leaf均保持；
- direct/via-seq/inner的`sourceParNodeId`依次为`par:outer / null / par:inner`；
- chain A direct-store追加`par:outer`、`missing`、`par:b`全部成功；重开后chain A list三条均在。

#### B7.3 证据强度

该实验强证明：现存store schema/API能round-trip nested/terminal par、run→leaf identity和任意group key旁路；它**不证明**compiler/scheduler能产生par、不证明active branch credential、不证明join transition、也不证明S23/S45。真实scheduler断点由production调用链和类型/schema的封闭形状证明；当前不存在可运行的真实par scheduler实验。

### B8. 测试资产、同错与盲区

**可保留测试资产：**

- nested tree roundtrip与stable identity：`tests/unit/sqlite-state/task-tree.test.ts:205-247`；
- direct par parent invariant：同文件`249-264`及DB trigger；
- scheduler真实现有spawn持久run→seq-root leaf identity：`tests/integration/scheduler/core.integration.ts:18-44`；
- daemon restart对普通seq runtime与tree恢复：`tests/integration/scheduler/daemon-restart.integration.ts:395`附近；
- group wire拒绝：`tests/integration/daemon/context.integration.ts:114-175`。

**同错：** group integration明确把`group-unavailable-v2`作为正确终态，只证明当前S07安全拒绝，不能证明group key解析或membership；direct fixture roundtrip若被当作scheduler证明，会与“无producer”共同偏离。

**盲区：** declaration→real par compile、par materialization/updater、两个真实branch credentials、run→all par ancestors resolver、K4a任一口径、same-chain nonmember、cross-chain key、nonexistent key的store防御、terminal transition后group read、restart后重新mint的branch credential、item delete对nested par cursor/join、真实并发branch、join后chain自由读。现有绿测试不能关闭这些空白。

### B9. 事务、迁移、恢复与并发边界

- store mutation统一`db.transaction(...).immediate()`；create完整tree与单entry append各自原子，但二者之间没有事务或FK连接（`src/sqlite-state.ts:1605-1611,1974-1981,2045-2054`）。
- normal run+closure creation在一个store write内；若root不是seq整体失败，不会部分追加par child。
- migration在事务中创建normalized runtime；v13路径确定只造seq root/leaf并给closure source par null（`src/sqlite-state.ts:1108-1175`）。历史run不会凭迁移得到par祖先。
- restart恢复SQLite事实但不恢复daemon Maps。并发方面，SQLite immediate串行store writes；当前无par producer/updater，故没有真实par并发materialize可实验。未来producer出现后需验证collision、parent placement、terminal update与credential mint在同一真实生命周期的原子/顺序关系；目前这些是缺失路径，不是静态可推断行为。

### B10. 证据索引

| 事实 | 主证据 |
|---|---|
| 固定seq compile | `src/loop.ts:490-518,780-786,864-875,4686-4694` |
| scheduler phase identity消费 | `src/scheduler.ts:1581-1635` |
| normal seq+leaf materialize | `src/sqlite-state.ts:1643-1671,2292-2336` |
| normalized parent/run/closure结构 | `src/sqlite-state.ts:630-634,661-702,762-773` |
| par fixture insert/recover | `src/sqlite-state.ts:1974-1981,2363-2405,2477-2527` |
| credential权威与restart边界 | `src/scheduler.ts:416-433`; `src/daemon.ts:3949-3996,4381-4395` |
| group hard reject | `src/daemon.ts:1852-1881` |
| store任意key与chain-only list | `src/sqlite-state.ts:775-784,2045-2063` |
| CLI/wire/persisted group ADT | `src/context-entry.ts:4-10,87-145`; `src/loop.ts:1943-1986` |
| delete lifecycle | `src/sqlite-state.ts:1849-1876`; `src/daemon.ts:2505-2541` |
| 实验 | `/tmp/rfc545-d06/experiment.ts`, `/tmp/rfc545-d06/output.json` |

## 完整交付声明

本报告已覆盖 par 从声明/compile到runtime materialize/update/terminal/restart的生产与消费链，正常生产的seq+leaf断点，run→leaf→直接/全部par祖先的durable表达，credential/admission身份，terminal/restart/item delete/chain delete稳定边界，全部group key写/read/filter/membership点，fixture与真实scheduler差异，nested/组外/跨chain/伪造key的确定后果，事务/迁移/恢复、隔离实验、测试同错/盲区与可保留资产。报告没有裁决K1/K4a，没有提出方案、issue或实现，也没有修改WORKFLOW、产品、测试、配置或生产DB。
