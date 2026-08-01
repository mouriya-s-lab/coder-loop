# RFC #547 R4/S3：定义树→运行态树、identity 与 transition commit 供给深审

> 审查基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` §2、D3、D10 identity 接缝、D11；`04-r3-supply-slicing.md` S3、接缝与完成判据。  
> 范围：调查现存供给；不设计语法或补齐方案，不改产品、测试、配置、issue、WORKFLOW 或数据库。

## A. 主 agent 摘要（最多一页）

### A1. 问题、结论与置信边界

**问题**：现存 compiled task tree 是否真实实例化为运行态树；definition/runtime identity 是否贯穿 SQLite、status、events、scheduler、closure；业务 transition 是否单事务提交；并发、崩溃与恢复是否仍有双事实源；§2.5 五条原生供给是否无 DSL override。

**总论：现存代码提供了强健的运行态树存储骨架和一条生产 identity 关联链，但没有实现 D3 的定义树实例化与 transition commit。符号与表是真实资产，调度权威仍是线性 `preset.phases + item.phase/status + runs`，不是运行态树。**

| 稳定语义 | 结论 |
|---|---|
| P-D3-1 递归定义树、稳定显式 identity、线性 normalize 同一模型 | **无现存供给**（仅退化 compiled tree + 独立 runtime ADT） |
| P-D3-2 join 封闭 ADT及完整生产语义 | **部分符合**（ADT/SQL/round-trip 有；生产实例化/调度无） |
| P-D3-3 非法树结构装载期拒绝 | **无现存供给** |
| P-D3-4 par concurrency/reopen 元数据与消费 | **无现存供给** |
| P-D3-5 非退化公共产物树 | **无现存供给** |
| P-D3-6 非退化 par 调度 guard | **无现存供给**（当前 DSL 无法产出 par） |
| P-D3-7 candidate `(definitionRef,candidateId)` | **部分符合**（runtime/SQL value 有；定义候选表和生产入口无） |
| P-D3-8 typed transition path | **无现存供给** |
| P-D3-9 seq readiness 只消费 committed transition | **不符合** |
| D10 identity 接缝：运行节点持 tagged ref + definition node id | **部分符合** |
| §2.4 runtime ADT variant 同时有边界/SQL/status读取 | **部分符合**（fixture surface 完整，生产 scheduler 不消费 seq/par） |
| §2.5 起点/闭包分支/seq/par pin/回收采样为原生且不可 override | **部分符合** |
| transition 单一事务提交且为唯一业务完成信号 | **无现存供给** |

置信边界：盘点了 compiled identity 生产、全部生产 runtime-tree 写入口、SQLite schema/约束、scheduler selection/close、status、observability、closure consumption、startup recovery及全部 `createTaskTree` 调用点。执行 1 条 scheduler identity integration 与 3 条 SQLite tree tests，均使用测试隔离 root且完成清理；未启动中央 daemon、未触碰 `~/.coder-loop`。未运行真实并发 daemon crash，因此崩溃窗口结论来自明确的跨事务调用顺序。

### A2. 核心因果

1. **定义树与运行树没有 constructor 接缝。** compiler 仅生成 `tasks:root → phase:<name> → phase:<name>:task` 的退化 seq；scheduler 不遍历它实例化树，只把全 phase 的 `(phase, definitionNodeId)` 复制进每个 run 的 `extra`。SQLite 在首次 `recordRun` 时按当前 run 动态 append 一个 closure leaf；后续 phase 运行时再 append。它不是从 compiled tree 一次实例化。
2. **运行态树不是调度权威。** scheduler 直接从 `preset.phases` 建 `nonTriggerPhases[]`，按 `item.phase` 在数组中 `indexOf + 1`，以 `latestRun.endedAt/exitCode` 和 item status决定下一 phase。`task_seq_nodes.next_child_node_id` 不参与生产 phase selection，正常完成也不更新 cursor。
3. **identity 链是真实但只关联“被运行的 phase”。** production scheduler把 canonical compiled leaf identity写进 run packet；`recordRun` 原子创建 definition row、root/leaf/closure/run，`runs` 持 closure/runtime-node FK；status输出完整树，startup recovery通过 run.runtimeNodeId回查 tree identity。普通 phase/closure events多只带 runId/closureId；daemon转换可对 run-scoped events追加 identity，但不是每个事件 shape强制携带。
4. **没有 transition commit。** agent item status write、run completion、active-run clear、item phase/lastRun update、closure suspend、session update和 events分属多个 store transactions及异步步骤。崩溃可留下“run ended但 active_runs尚在”“run完成但 item/closure未推进”等中间态；startup recovery只清 stale current、把未结束 run标 orphan，不重放一个 committed transition。
5. **nested seq/par 是 fixture 可写能力。** `createTaskTree` 是公开 store API、事务/约束/round-trip完整，但生产源码无调用；所有调用均在 tests。par pin/join/bindingVersion/epoch因此是持久化骨架，不是生产 scheduler供给。
6. **§2.5 供给不齐。** fresh base、closure branch命名/创建、资源回收和 publication sampling 是 engine code且 preset DSL没有 override；linear seq推进虽在 engine，但消费旧的 phase/run/status事实而非 committed transition；par same-commit pin只有字段和 fixture；因此不能整体判符合。

### A3. 当前/未来影响、资产、未知、接缝与下一步

**当前影响**

- status中的 `taskTree` 是真实 SQLite projection，但描述的是“运行遇到过的 closures”，不是 compiled definition 的已实例化执行树。
- scheduler能在不读取 runtime cursor的情况下推进；tree/status与调度决策可漂移而不立即阻止运行。
- runtime root的 definition ref取首次 run 的 preset ref；后续 mixed-preset item leaf可持不同 ref，而 root与 leaf的定义归属不同。schema允许，调度仍按 representative preset phase plan。
- run/closure资源创建在一个 `recordRunWithClosureResources` transaction内，这是局部强保证；随后 setCurrentRun、item update、spawn/event不在其中。

**未来影响**

- **S1**：canonical compiled identities可保留；但仅复制 identity字符串不能替代 tree实例化。
- **S4**：gate/outcome若要成为 transition条件，不能附着在当前多步 close path后声称原子。
- **S5**：runtime node只持 tagged ref/hash；`execution_definitions` 当前不存定义内容。谁解析 ref并恢复内容归 S5，本片只能证明节点引用存在。
- **S6**：item/create入口没有与 runtime tree实例化同事务；树首次写发生在 run spawn，故 create admission成功不代表运行实例定义/树已落盘。
- **D11**：现有 integration只证明退化 identity链，不证明非退化 tree、transition path或 crash atomicity。

**可保留资产**

- 精确 runtime ADT与strict boundary；leaf/seq/par、drain/validator、evaluation state均封闭。
- SQLite FK/unique/check/trigger约束、`BEGIN IMMEDIATE` write wrapper、tree recursive insert/read round-trip。
- production run→closure→runtime node→tagged definition ref/node id链。
- record run + prepared closure resources的单事务局部保证。
- closure lifecycle、reachability facts、consumption intent/outbox式 pending→emitted恢复资产。
- startup stale/orphan run identity核对；status完整tree projection。
- engine-owned closure branch/worktree与回收/采样实现，无 preset-name 分支。

**未知**

- D10定义内容如何持久恢复、resume如何按 pin读取由 S5确定；本报告不从 hash/ref推导内容可恢复。
- hook/GUI是否完整消费 identity不在本仓现存消费者内；需相邻树/冻结 SHA验收确定。
- seq/par最终 TOML、transition path、script join与par scheduler语义属于未来需求推导，不在本片裁决。

**下一步（审查输入，不是实现方案）**：R4 汇总应把“运行存储骨架可保留”与“生产调度仍完全旁路 tree/transition”并列；交叉要求 S5证明 ref内容权威、S6登记实例创建时点缺口、S4不得把现有 item status write冒充 transition commit。

---

## B. 证据附录

## B1. 设计对照

### B1.1 P-D3-1 / P-D3-5：compiled tree与运行树实例化

**结论：无现存完整供给。**

compiled tree：

- `CompiledTaskNode/CompiledPhaseTaskTree/CompiledTaskTree` 只有 phase leaf和两层 seq：`src/loop.ts:780-787`。
- identity由 `buildCompiledTaskTree` 生成；root/phase/leaf投影见 `src/loop.ts:2900-2953`。

runtime tree：

- 独立 ADT为 leaf/seq/par：`src/task-runtime.ts:43-58`。
- identity三元组为 `runtimeNodeId + tagged definitionRef + definitionNodeId`：`src/task-runtime.ts:3-11`。

生产接缝实际是：

1. scheduler重新加载 preset，计算 source hash：`src/scheduler.ts:1586-1588`。
2. 把 `preset.tasks.children`压成 run extra的 phase/id列表：`src/scheduler.ts:1607-1630`。
3. `recordRunWithClosureResources`进入 `insertRun → ensureRuntimeClosure`：`src/sqlite-state.ts:1915-1918,1643-1671`。
4. `ensureRuntimeClosure`若无 root则创建动态 root；只为**当前 run.phase** append一个 leaf：`src/sqlite-state.ts:2292-2336`。

反证：

- 它不递归遍历 compiled tree。
- item/create、chain/create不创建 runtime tree。
- phase leaf在第一次运行该 phase时才出现。
- runtime `child_index`是 `MAX+1` 的运行遭遇顺序，而非 compiled结构路径。
- `createTaskTree`可递归写完整tree（`src/sqlite-state.ts:1974-1981,2363-2405`），但全仓生产源码无调用；调用全部在 tests。

测试 `existing task root materializes every phase...` 的名称易误导：第一次 review run后断言只有 review leaf，直到 finalize run才出现 finalize leaf（`tests/unit/sqlite-state/task-tree.test.ts:156-201`）。它证明按运行逐 leaf物化，不是新 item一次物化完整定义。

### B1.2 P-D3-2 / P-D3-7 / §2.4：join与variant

**结论：部分符合。**

- runtime union：`drain | validator`，candidate含 tagged `ExecutionDefinitionRef + candidateId`：`src/task-runtime.ts:28-38`。
- par包含 `pinCommit/state/reopen/join/children`：`src/task-runtime.ts:45-54`。
- strict runtime boundary递归穷尽：`src/task-runtime.ts:127-165`。
- SQL join binding `(par_node_id,version)`、evaluation `(par_node_id,epoch)`并以 FK锁定 binding version：`src/sqlite-state.ts:695-725`。
- recursive insert switch穷尽 leaf/seq/par：`src/sqlite-state.ts:2376-2405`。

缺口：

- compiler没有 join candidate table、par、candidate completeness检查。
- production scheduler无 par/join读取、写入或guard。
- production无法产生 par node；所有 nested/par实例来自 `createTaskTree` tests。
- `script` variant不存在；按设计它必须与语义/存储/观测/消费同时加入，因此当前不算空预留，这一点符合variant纪律，但D3终态未达。

### B1.3 P-D3-3 / P-D3-4 / P-D3-6：结构执法与par guard

**结论：无现存供给。**

- TOML boundary没有递归 tree/par/join/reopen/concurrency字段：`src/loop.ts:490-518`。
- compiler自然无法检查 empty par、tree duplicate id、reopen target、join completeness、static dependsOn tree cycle。
- scheduler没有“par调度尚未落地”guard，因为 compiled model没有可出现的非退化 par。
- runtime store对已给 snapshot执行结构约束（cursor direct child、source par actual parent、FK/unique/check），这是存储入口防御，不是装载期定义检查。

### B1.4 P-D3-8：typed transition path

**结论：无现存供给。**

全仓没有 `TransitionPath` domain type、path identity、target invocation、prompt identity/hash、完整 bindings或 `exit.*` schema。现有：

- phase exits是 `item-status | chain-action stop`：`src/loop.ts:684-698`。
- scheduler以phase数组和run/item状态推进，不构造 transition payload。
- public stateGraph edge只是 phase/status/when展示，不是可提交的数据边：`src/loop.ts:2906-2933`。

### B1.5 P-D3-9：seq readiness消费 committed transition

**结论：不符合。**

scheduler权威：

- `SchedulerPhasePlan`是 `firstPhase + nonTriggerPhases[] + itemTriggerPhases[]`：`src/scheduler.ts:592-596`。
- 从 `preset.phases`过滤并保序：`src/scheduler.ts:612-623`。
- continuation以 `item.phase`在数组的 index、latest run ended/exitCode、item status计算：`src/scheduler.ts:635-713`。
- run close再按旧phase plan决定是否离开phase：`src/scheduler.ts:2146-2151`。

runtime seq cursor：

- SQL字段存在：`src/sqlite-state.ts:694`。
- production dynamic root只在首次leaf时设置 cursor；后续append不推进：`src/sqlite-state.ts:2327-2336`。
- 唯一update cursor生产逻辑是删除item时避开被删leaf：`src/sqlite-state.ts:1849-1877`。
- scheduler selection不读取cursor。

因此 linear preset存在两套推进事实：scheduler phase/run/item facts是权威；runtime tree cursor是展示/存储骨架，且可能停在首leaf。

## B2. identity生产、存储与消费者全集

### B2.1 identity生产

| identity | 生产点 | 语义 |
|---|---|---|
| compiled root | `tasks:root` | 定义root identity |
| compiled phase seq | `phase:<name>` | phase容器 |
| compiled task leaf | `phase:<name>:task` | scheduler复制为 definitionNodeId |
| runtime root | `chain:<chainId>:root` | 首run动态创建 |
| runtime leaf | `closure-node:<itemRowId>:<phase>` | item/phase closure节点 |
| closure | `closure:<itemRowId>:<phase>` | Git/worktree/session生命周期 |
| definition ref | `{kind:"preset",contentIdentity:sourceHash}` | 当前编译source hash |

生产代码：`src/scheduler.ts:1581-1626`、`src/sqlite-state.ts:2305-2333`。

### B2.2 SQL约束

- `execution_definitions` PK `(kind,content_identity)`：`src/sqlite-state.ts:653-660`。
- `task_nodes.runtime_node_id` PK；definition FK；parent/index unique：`src/sqlite-state.ts:661-672`。
- 每chain一个tree/root unique：`src/sqlite-state.ts:673-676`。
- closure与leaf 1:1，item/phase unique，closure/leaf composite unique：`src/sqlite-state.ts:677-693`。
- run `(closure_id,runtime_node_id)` composite FK至 closure，`(run_id,closure_id)` unique：`src/sqlite-state.ts:630-635`。
- active run对closure和run再有FK：`src/sqlite-state.ts:754-760`。
- source par trigger验证leaf实际parent：`src/sqlite-state.ts:762-773`。

缺口/边界：

- `definition_node_id`仅非空，无 FK到定义内容内节点表；execution_definitions也没有node/content表。
- root与leaf可引用不同definition refs；schema不要求同tree单一definition。
- runtime ID格式是字符串约定，不是 tagged ADT variant。

### B2.3 status/events/scheduler/closure消费者

- status snapshot直接读DB task tree：`src/loop.ts:3169-3175`。
- scheduler用tree寻找existing closure、lifecycle、资源回收/消费：`src/scheduler.ts:1581-1584,2146-2151,1013-1078,1490-1523`。
- scheduler**不**用tree决定next phase。
- runs持runtime identity；scheduler event conversion可通过run join解析：相关 integration `tests/integration/scheduler/core.integration.ts:22-60`。
- startup recovery从run.runtimeNodeId回查tree identity；缺失即internal error：`src/daemon.ts:2370-2388,2400-2432`。
- observability有可选event identity union，recovery reconciled run明确携带三元identity：`src/observability.ts:230-237,268-295,466-487`。
- closure events主要携带closureId，不强制携带definition identity：`src/observability.ts:359-383`。
- hook/GUI无仓内生产消费者证据，登记为D11/外树缺口。

## B3. 写入口、事务与并发

### B3.1 store事务模型

所有store write各自用 `db.transaction(fn).immediate()`：`src/sqlite-state.ts:1605-1612`。这带来单个method的串行写锁与回滚保证，但**不**把多个store method合并为业务transition。

### B3.2 局部原子保证

`recordRunWithClosureResources`单事务内：

- insert definition/root/leaf/closure/kind row；
-核对prepared closure id；
-更新prepared worktree/branch/base commit；
-insert run并持durable closure/runtime-node identity。

证据：`src/sqlite-state.ts:1643-1671,1915-1918,2292-2336`。对应测试：`tests/unit/sqlite-state/task-tree.test.ts:64-112`。

`createTaskTree`也递归单事务，但只被fixtures调用。

### B3.3 业务完成不是单事务

run close顺序至少包括：

1. 写文件artifact（非DB）。
2. `completeRun`独立事务。
3. `clearCurrentRun`独立事务。
4. 清内存active/credential。
5. emit agent.exit/phase.end。
6. update item/session各独立事务。
7. set closure lifecycle独立事务。
8. emit closure/queue events并尝试chain completion。

证据：`src/scheduler.ts:2035-2085,2110-2165`；store methods `src/sqlite-state.ts:1926-1972,1985-2001`。

agent status写发生在daemon request路径，早于child exit；它不是与run complete/tree cursor/closure一同提交。故现存没有“完整 transition commit = 唯一业务完成信号”。

### B3.4 并发约束

- SQLite `BEGIN IMMEDIATE`阻止同DB并发writer交错到单method内部。
- runtime_node/closure/item-phase unique与active-run unique拒绝重复身份。
- scheduler JS state/slot串行同repo，但DB schema仍是最终约束。
- `ensureRuntimeClosure`先query再insert，竞争时第二writer由unique constraint失败，不是幂等读取成功；上层spawn failure containment处理，但没有transition retry protocol。

## B4. 崩溃与恢复

### B4.1 可观察崩溃窗口

因为完成分成多个事务：

- run已`ended_at`，`active_runs`尚未删除；
- active run已清，item.phase/lastRun或closure lifecycle尚未更新；
- item status已由agent提交，run尚未完成；
- DB已完成，observability event尚未持久；
- closure lifecycle已suspend，event未写；
- consumption intent已pending但cleanup/event尚未完成。

### B4.2 startup recovery

- stale current run：按persisted tree核对identity、杀进程、清active run、写recovery event：`src/daemon.ts:2370-2388`。
- orphaned unfinished runs：逐run核对identity、complete为orphan状态、汇总recovery event：`src/daemon.ts:2400-2432`。
- closure resources随后reconcile：`src/daemon.ts:2391-2396`。

恢复优点：不凭内存猜runtime identity，缺join硬失败。

局限：

- 不存在transition record可重放/判定“哪些步骤已提交”。
- `run ended + active_runs残留`不属于 orphaned unfinished过滤，stale current路径只清active；其余item/closure推进不会由transition重放。
- scheduler下次仍从item.phase/status/runs重算，而非tree cursor/committed transition，双事实源继续存在。

## B5. closure consumption、reachability与§2.5

### B5.1 closure lifecycle与消费

- lifecycle `active|suspended|consumed`，consumed不可逆且active需要资源：`src/sqlite-state.ts:1985-2001`。
- reachability seed/edge显式类型化并有FK：`src/sqlite-state.ts:726-738,2004-2015`。
- consumption先assessment/sampling，再原子写intent/lifecycle，event发出后mark emitted，最后资源清理：`src/scheduler.ts:1490-1523`。
- pending/emitted intent持久化允许event失败后恢复观察：schema `src/sqlite-state.ts:745-752`。

这是可保留资产，但closure消费commit仍不是D3 transition commit。

### B5.2 §2.5逐项

| 原生供给 | 结论 | 现状 |
|---|---|---|
| 起点公理 | 部分符合 | worktree manager从chain/base与Git事实计算base commit；preset DSL无起点字段，但外部Git失败先于run DB记录 |
| 闭包分支程序化 | 符合（本片现存范围） | closure id/branch/path由engine函数生成，preset无命名字段 |
| seq流转 | 不符合稳定语义 | engine代码推进，但按phase array/run/item facts，不按committed transition/runtime cursor |
| par同commit派生(pin) | 无现存生产供给 | `pinCommit`字段/SQL/fixture有，production无par constructor/scheduler |
| 回收与消费采样 | 部分符合 | engine-owned sampling/reconcile/cleanup真实存在且无DSL override；与transition不原子 |

唯一相关 `chain.baseBranch`在chain metadata，不在 preset tree DSL；`PresetTomlBoundary`无branch/start/pin字段（`src/loop.ts:508-518`）。未发现preset名特判。

## B6. fixture-only 与生产路径矩阵

| 能力 | 类型/SQL | fixture | production |
|---|---|---|---|
| nested seq/par tree | 有 | `createTaskTree`多处 | **无调用** |
| drain/validator join round-trip | 有 | unit test | 无scheduler消费 |
| par pin/reopen/epoch/version | 有 | unit fixtures | 无实例化/推进 |
|退化 runtime root/leaf | 有 | 有 | `recordRun`动态创建 |
| compiled leaf identity关联 | 有 | integration验证 | scheduler run packet真实写入 |
| seq cursor推进 | 有 | create/delete tests | 正常phase推进不消费/不更新 |
| closure consume/reconcile | 有 | integration覆盖 | scheduler真实消费 |

全部 `createTaskTree(`调用位置经全仓检索均在：

- `tests/unit/sqlite-state/**`
- `tests/integration/scheduler/**`
- `tests/integration/cli/**`

`src/`只有interface与实现定义，无调用。

## B7. 测试、最小隔离核验与盲区

### B7.1 本次执行

```text
bun test ./tests/integration/scheduler/core.integration.ts \
  -t 'runtime identity event chain starts'
# 1 pass, 45 filtered, 0 fail

bun test ./tests/unit/sqlite-state/task-tree.test.ts \
  -t 'existing task root materializes every phase|nested task tree round-trip|prepared closure resources and run history commit atomically'
# 3 pass, 16 filtered, 0 fail
```

integration使用仓内测试隔离root `.coder-loop/runtime/evidence/scheduler-tests/<pid>/...`，结束后确认目录已清理；未连接中央daemon或`~/.coder-loop`。没有额外 `/tmp/rfc547-s3-*` 文件产生。

### B7.2 这些测试实际证明

- production scheduler产生的run leaf definitionNodeId等于canonical compiled leaf id；run.runtimeNodeId关联leaf。
- prepared resources + closure + run在单store method内回滚/提交。
- nested runtime ADT/SQL可round-trip。
- phase leaves按首次run逐个materialize并跨reopen保留。

### B7.3 同错与盲区

1. nested tree round-trip完全走fixture-only `createTaskTree`，不证明compiler/scheduler接入。
2. identity integration只验证一个退化phase leaf，不验证完整compiled/runtime node集合。
3. “materializes every phase”测试名称暗示一次物化，断言实际是逐run物化。
4. 没有断言scheduler phase selection读取runtime tree/cursor；源码证明它不读。
5. 没有transition commit type/table/API，自然没有atomic/crash测试。
6. prepared closure atomic test只覆盖run开始局部事务，不能推广到run完成。
7. join tests只round-trip，不存在production decision/evaluation consumer。
8. recovery tests可证明orphan清理，不证明跨多事务业务transition恰好一次。
9. status含tree，但普通events/hook/GUI identity全集无跨面比对。

## B8. 与相邻片交换的接缝事实

### S1

- 输入：`sourceHash`与`phase:*:task` canonical identity。
- 当前runtime只复制phase leaf ids，不消费compiled root/phase结构。
- S1 daemon path cache可能使新run取得旧compiled identity；S3本身不解决。

### S4

- 现有item status request是独立业务写，不是transition payload。
- future gate/outcome若只观察status/run exit，仍会继承双事实源；本片不裁决其机制。

### S5

- S3持有的唯一定义信息是tagged ref和definitionNodeId。
- `execution_definitions`只存 identity/hash/version，不存定义内容或node表：`src/sqlite-state.ts:653-660`。
- 定义内容所有权、resolver、缺失hold、resume prompt均必须由S5证明；S3不得把FK存在写成pin完成。

### S6

- chain/item create不实例化tree或definition。
- 第一次run spawn才创建runtime root/leaf；因此实例创建成功与执行定义/树持久化不原子。
- store createTaskTree不是daemon create admission生产入口。

## B9. 证据索引

| 主题 | 证据 |
|---|---|
| compiled tree | `src/loop.ts:780-787,2900-2953` |
| runtime ADT/boundary | `src/task-runtime.ts:3-58,60-178` |
| runtime SQL schema | `src/sqlite-state.ts:653-773` |
| transaction wrapper | `src/sqlite-state.ts:1605-1612` |
| run/closure atomic start | `src/sqlite-state.ts:1643-1671,1915-1918` |
| dynamic runtime constructor | `src/sqlite-state.ts:2292-2361` |
| generic fixture tree writer | `src/sqlite-state.ts:1974-1981,2363-2405` |
| scheduler definition packet | `src/scheduler.ts:1565-1639` |
| linear phase authority | `src/scheduler.ts:592-713` |
| multi-step close | `src/scheduler.ts:2035-2165` |
| cursor only deletion update | `src/sqlite-state.ts:1849-1877` |
| status tree | `src/loop.ts:3169-3175` |
| recovery identity | `src/daemon.ts:2370-2432` |
| event identity boundary | `src/observability.ts:230-295,466-487` |
| closure consumption | `src/scheduler.ts:1490-1523` |
| fixture/production identity test | `tests/integration/scheduler/core.integration.ts:22-60` |
| task-tree tests | `tests/unit/sqlite-state/task-tree.test.ts:64-205` |

## B10. 尾部结论

S3的现存供给应被描述为：**有真实、严格、可恢复的运行态树持久化骨架；有退化生产run到compiled leaf identity的链；没有定义树到运行树的生产实例化，没有以runtime tree为权威的scheduler，没有typed transition path或单一transition commit。** Nested seq/par、join、pin、epoch/version的符号、SQL和绿色round-trip主要由fixture供给，不能作为生产语义证据。当前scheduler继续按`preset.phases + item.phase/status + runs`推进，runtime seq cursor不参与且正常完成不更新；run完成又跨多个事务与事件步骤，崩溃恢复只能局部清理，不能重放唯一业务commit。故D3总体不符合稳定终态，D10 identity接缝和§2.5仅部分符合；R4不得以v16表存在、identity integration绿色或closure资产完整把它升级为可作地基。
