# RFC #543 · R4-S1 供给侧设计符合性深审：observer / payload

> 基线：`/Users/mouriya/Ext/code/coder-loop`，`main`，`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 设计锚点：本目录 `aggregation.md`、`01-clauses.md` 的 A1–A4、D1–D2、E、F、G、I2、I9，以及操作员既有裁决。  
> 调查边界：只读生产代码和测试；未启动 daemon、未修改数据库、未做运行实验。本文是本切片唯一产物。

## A. 主 agent 摘要

### 1. 问题

main 现有的 hook 声明/有效视图、统一事件流和 closure 投影底料，是否已经遵守稳定 RFC 语义，能否作为 observer 执行与 stdin payload 的真实地基；尤其需要核对：

- observer 是否真是异步旁路，且 `hook.*` 自反排除有声明期和发射期双层防护；
- 四层声明是否由所有生产触发点消费，并在全点保持 `global → chain → preset → item`；
- payload 是否可从编译产物、事件信封、status/closure 快照派生，而不复制 shape；
- closure 转移边是否完整进入 observer 词表；
- 事件生产/消费、失败恢复和子进程生命周期是否已有可复用保证。

### 2. 结论与置信边界

**结论：现有底料不能作为“observer/payload 已接线”的地基，只能作为若干局部构件。**

- **符合：A2。** observer point 的类型面确实从 canonical observability event union 结构减去 `hook.*`，未来普通事件自动进入，未来 `hook.*` 自动排除。
- **偏离：A1、A3、A4、D1、D2、E1–E5、F1–F7、G1–G6、I2、I9。** 这里的“偏离”多数不是错误执行，而是稳定语义要求的生产路径不存在；不能把声明 shape 或测试 helper 当作执行保证。
- **静态不可判定：F8 的运行契约。** 当前根本没有 hook payload，因而生产代码当前确实没有向它注入 GitHub 字段，但这不能证明未来 payload boundary 会持续排除这些字段。需在 payload 出现后以精确 boundary/派生关系和负向 fixture 判定。

高置信证据是：`buildEffectiveHookView` 在生产代码中只有 `CoderLoopDaemon.effectiveHookViewForItem` 包装，而该包装没有任何生产调用者；唯一调用方是测试。统一事件记录函数只做 suppress / append / render，没有 observer dispatch。现有集成测试还明确断言声明脚本在调度期间**不会执行**。

### 3. 复杂因果简述

当前实现是“声明持久化骨架 + 事件底料 + closure 状态底料”三块并存，但没有把它们连接：

1. global hooks 在 daemon 启动时装载，chain/item hooks 随 SQLite 记录持久化，preset placeholder 只能由调用者手工传入。
2. `buildEffectiveHookView` 能按四层排序，却没有 scheduler/event producer 调用它，所以它既不筛选触发事件，也不执行 observer/gate。
3. scheduler event 经一个穷尽转换进入 `ObservabilityEvent`，daemon 的其他 audit/lifecycle 入口也直接写统一事件流；所有入口最终只持久化和渲染。
4. closure 已有 typed 状态树和五种 `closure.*` 事件，但事件是“资源/聚合生命周期/消费/故障/对账”模型，不是 A4 的 create/run-spawn/run-exit/suspend/reopen/consume 六条转移边模型。
5. compiled preset projection 只存在于 compile 公共结果；运行实例 pinned `definitionRef` 在 SQLite 只保留 kind/content identity 和 phase/node identity，并没有可按 ref 解引用的完整 compile projection。status 顶层 boundary 仍以多个匿名 `"object"` 槽组成。

因此缺口不只是“加 spawn”：payload 的 pinned definition 解引用、发射后的统一 dispatch、daemon-host 匿名触发上下文、closure 六边语义、进程组超时回收和所有 event writer 的覆盖都还没有共同边界。

### 4. 影响分层

**当前影响**

- 声明不产生执行副作用；observer 不会收到 stdin，也不会产生 `hook.*` 事件。
- 四层顺序只在显式调用 helper 时成立；真实事件发生时没有四层匹配或派发。
- closure 事件可查询，但不能被 observer 订阅执行。
- 没有 payload schema、版本、导出面或运行态/编译态拼装。

**未来能力出现后的影响**

- 若只在 scheduler `onEvent` 接 dispatch，会遗漏 daemon 自产事件、sync fatal 路径和 fallback event streams；A2 的“全事件词表”将成为假全量。
- 若从当前 preset 路径重编译 payload，会违反 pinned definition；当前 DB 仅凭 hash 无法解引用完整投影。
- 若直接透传 status snapshot，会把匿名 object 槽和透明 extra 带进平行 shape；若直接复用现有 closure audit payload，又会丢失 session、par pin、完整生命周期事实。
- 若 hook 子进程复用 agent timeout 代码但不抽出独立公共执行层，observer/gate 的进程组、超时和恢复语义会分叉。

**纯证明缺口**

- A2 的类型级 exhaustiveness 有测试，但没有运行 dispatch consumer，故只能证明词表派生，不证明全事件派发。
- 四层 helper 的顺序测试与持久化测试，与“声明零执行副作用”同错：它们明确没有证明 D2/I9 的全点执行和 AND。
- closure typed boundary 与事件 conversion 有测试价值，但没有六边一一对应和 observer payload 投影证明。
- F8 只有“目前没有 payload”的消极事实，没有稳定边界守护。

### 5. 可保留资产

1. `ObserverHookPointOf<ObservabilityEventType>`、`isObserverHookPoint` 及解析期拒绝，可保留为 A2/A3 声明期半边。
2. `HookDeclaration` ADT、ArkType 装载边界、global versioned document、tick 正整数约束。
3. global/chain/item 持久化与 `buildEffectiveHookView` 的 provenance/稳定层序；它可成为唯一合成 helper，但必须进入真实生产调用链，preset 层须来自 pinned compiled definition。
4. `ObservabilityEventBoundary`、`schedulerEventToObservabilityEvent` 的穷尽 switch、统一 query/render 基础。
5. `TaskTreeSnapshotBoundary`、`ClosureSnapshot`、closure sessions、par `pinCommit`、active runs 等精确运行态底料。
6. `PresetCompileProjectionBoundary` 作为未来 payload 编译半边的候选派生源。
7. scheduler 已有异步 `Bun.spawn`、stdin/进程组信号、SIGTERM→SIGKILL 的 agent 生命周期代码可供抽取原则参考；当前不是 hook 公共执行层，不能直接算 G3/G4。

### 6. 未知与下一步

- **需继续调查/实现时最小实验：** observer 执行层出现后，用隔离 loop-data-root 真跑 slow/nonzero/timeout/spawn-failure 脚本，测 scheduler tick 与另一 chain 是否推进、stdin 是否完整、进程组孙进程是否被 SIGTERM→SIGKILL 回收、daemon kill/restart 后是否遗留孤儿。
- **并发/重入尚未裁决：** 同一脚本被多个事件/chain 同时触发时的互斥语义属于已登记 P3；本报告不裁决。
- **pinned projection 需供给方确认：** RFC-2 必须提供由 persisted `definitionRef` 解引用完整 compile product 的真实 API/存储；当前 `execution_definitions` 行不足以实现 F3。
- **closure 六边需与 RFC-1 对账：** 当前五类事件不是六条边的同义重命名，尤其 create/run-spawn/run-exit/reopen 无明确事件。需要生产者逐边定义和发射，不能由本切片猜映射。
- 无需新增操作员裁决；R5 应把上述偏离、F8 证明缺口和 P3/解引用未知记入总账。

---

## B. 证据附录

### B1. 逐条设计三态对照

| 条款 | 三态 | 生产事实 | 能否作地基 |
|---|---|---|---|
| A1 | 偏离 | 只有 observer declaration；无事件匹配、spawn、diagnostic。集成测试断言脚本不执行。 | declaration 可留；执行语义不可用。 |
| A2 | **符合** | observer point = event union 减 `hook.*`；解析复用 canonical event parser，无平行点名表。 | 可直接保留。 |
| A3 | 偏离 | 装载期拒绝已成立；发射路径没有 observer dispatcher，因而“零派发”只是执行不存在，不是第二道显式防护。 | 声明期半边可留；dispatch 必须再次结构排除。 |
| A4 | 偏离 | 有 5 个 closure 事件，但不是 create/run-spawn/run-exit/suspend/reopen/consume 六边；无 observer 执行。 | typed closure/event 底料可留，事件语义不能冒充六边。 |
| D1 | 偏离 | global/chain/item 有真实装载/持久化；preset 只有 helper 参数 placeholder，没有 compiler producer 或生产 consumer。 | 三层存储和 provenance helper 可留。 |
| D2 | 偏离 | helper 排序正确；没有 hook 执行、AND、hold/reopen 合成。 | 仅层序构件可留。 |
| E1 | 偏离 | canonical event union 无任何 `hook.*`。 | 现有 union 扩张机制可留。 |
| E2 | 偏离 | status 故意排除 item/run extra hooks；无 hooks 节、hold、故障投影。 | status typed task tree 可供运行态投影，不是 E2。 |
| E3 | 偏离 | 无 observer failure event boundary/producer。 | 统一 diagnostic kind 可留。 |
| E4 | 偏离 | 无 hook decision event；现有 decision events 是 scheduler 既有决策。 | event envelope 可留，字段 contract 待新增。 |
| E5 | 偏离 | 无 hook hold/retry/fingerprint/key/evaluation events。 | 既有 chain decision fingerprint 不是 hook evaluation protocol。 |
| F1 | 偏离 | 无 HookPayload boundary/assembler。 | 无。 |
| F2 | 偏离 | compile projection、status、event 分别有边界，但 status 顶层仍含匿名 object；没有派生关系。 | 三个候选源部分可留。 |
| F3 | 偏离 | runtime node 有 pinned `definitionRef`，但 DB definition 表只存 identity/hash/version，未存完整 projection，也无 ref→projection API。 | identity 可留；解引用能力缺失。 |
| F4 | 偏离 | 无 payload 投影。status 透明 extra 会剔除 hooks，但顶层匿名槽仍在。 | “不直接透传 status”约束必须显式实现。 |
| F5 | 偏离 | 无 payload/version。 | compile result 的 schemaVersion 先例可参考。 |
| F6 | 偏离 | 无 payload schema 导出面。 | ArkType 导出风格可沿用。 |
| F7 | 偏离 | closure state 有 lifecycle/worktree/branch/base/sessions，par 有 pinCommit；没有派生到 payload，且现有 event payload 不含全量 closure metadata。 | typed task tree/closure 是强底料。 |
| F8 | **静态不可判定** | 不存在 payload，所以当前无注入；也不存在精确负向 contract。 | 待 payload boundary 出现后证明。 |
| G1 | 偏离 | 事件记录不 spawn observer；调度测试确认 sentinel 不出现。 | 无。 |
| G2 | 偏离 | 无 stdin write。 | 无。 |
| G3 | 偏离 | timeout 只在声明；无 hook child/process-group lifecycle。 | agent 回收代码只能抽取复用，不能算交付。 |
| G4 | 偏离 | observer/gate 共同执行层不存在。 | 无。 |
| G5 | 偏离 | hook 路径不存在，故“零新增 spawnSync”不是异步执行保证。仓内其他领域仍有 spawnSync。 | 新层须用 async spawn；不得以全仓 grep 误判。 |
| G6 | 偏离 | 声明 matcher 的类型来源正确；实际 dispatch matcher 不存在。 | A2 构件可直接用于未来 matcher。 |
| I2 | 偏离 | gate point tuple 统一了声明 parser；payload/event/评估接线都不存在，不能由编译器暴露这些消费点。 | tuple/type 可留，但尚非全点 exhaustiveness。 |
| I9 | 偏离 | 四层顺序只有一个 helper；它没有生产调用者，也没有任何决策点 AND。 | helper 是候选唯一合成入口。 |

### B2. 声明装载、合成及全部生产调用者

#### global

- `src/runtime-paths.ts:13` 定义 `hooks.json` 文件名。
- `src/hook-declarations.ts:90-100` 解析 version=1 document，并由 `loadGlobalHookDeclarations` 读文件。
- `src/daemon.ts:1235-1244` daemon `start()` 只在启动时装载一次；ENOENT 为空，malformed/invalid 使启动失败。
- `src/daemon.ts:1190` 仅以内存数组保存；运行期间不 watch/reload。

#### chain / item

- `src/runtime-data.ts:107-137` 的 `ChainMetadata.hooks` 与 `src/runtime-data.ts:159-176` 的 `ItemExtra.hooks` 是 typed 持久化字段。
- `src/runtime-data.ts:351,419,529,559` 提供 JSON roundtrip/parse。
- `src/daemon.ts:4163-4166,5263-5286` 对 agent 写入 hooks 做 operator-only 保护并覆盖 replace/patch/clear 形态。
- `src/runtime-data.ts:438-443` status transparent extra 明确删除 hooks；它证明持久化不等于 status effective view。

#### preset / 合成

- `src/hook-declarations.ts:48-58` 定义手工 `PresetHookPlaceholder` 和带 provenance 的 `EffectiveHook`。
- `src/hook-declarations.ts:138-145` 是唯一层序合成函数。
- `src/daemon.ts:1215-1232` 是唯一生产源码包装，读取 global/chain/item，并要求调用者传 preset placeholders。
- 全仓生产代码检索 `effectiveHookViewForItem(` 只有该定义；调用只出现在 `tests/integration/daemon/hooks.integration.ts:39,87`。`buildEffectiveHookView` 也只有该包装和 unit test 使用。
- `src/loop.ts:490-518` 的 preset TOML boundary 没有 hooks/named-gate DSL 字段；故不存在 placeholder 的 compiler producer。

结论：现有“有效视图”是可测试 helper，不是生产 effective view。

### B3. 事件生产、转换、持久化和消费入口

#### canonical boundary

- `src/observability.ts:17-23` 五种 kind。
- `src/observability.ts:25-110` canonical event type union；其中 `src/observability.ts:33-37` 是五种 closure type，整个 union 无 `hook.*`。
- `src/observability.ts:291-297,297-823` event identity 与 payload union；`src/observability.ts:823-826` 合成唯一 `ObservabilityEventBoundary`。

#### scheduler → event

- `src/daemon.ts:3728-3741` scheduler `onEvent` 解析 task identity，经 `schedulerEventToObservabilityEvent` 后写流。
- `src/daemon.ts:827-1119` 是 scheduler event 的穷尽转换，尾部走 `assertNeverSchedulerEvent`（`src/daemon.ts:5494-5496`）。
- scheduler closure 发射点包括 resource prepare `src/scheduler.ts:1638`、lifecycle suspend/activate `src/scheduler.ts:1767-1773,2149-2150`、consume 调用链的 closure event、git failure；这些先进入 scheduler `emit`（`src/scheduler.ts:3251`）。

#### daemon 自产与特殊入口

- daemon 多个 command/start/stop/recovery 路径直接构造 `makeObservabilityEvent` 后调用 record methods；它们不经过 scheduler `onEvent`。
- `src/daemon.ts:2285-2294` 两个 async 中央 record helper 只做 decision suppression、append、render。
- `src/daemon.ts:2303-2322` fatal/uncaught 路径同步 append；它不经过 async record helper。
- `src/daemon.ts:2325-2333` chain-name-safe wrapper 仍最终只 record。
- `src/daemon.ts:1330-1361` lifecycle/runner persistence failure 有独立 fallback files 和同步写入。
- `src/observability.ts:923-950` 同时存在 async/sync append APIs；未来只改其中一个不能覆盖全生产入口。

#### consumers

- `src/daemon.ts:2336-2340` decision fingerprint consumer 只消费现有 `kind=decision` 以抑制重复事件。
- `src/daemon.ts:2342-2347` human renderer sink。
- `src/daemon.ts:2680-2715` logs query 合并主 events 与两个 failure streams。
- `src/observability.ts:953-978` query/parser/filter；`src/observability.ts:1023-1244` renderer 穷尽各 kind/type。
- 没有 observer consumer、event→effective hooks matcher、dispatch queue 或 hook process registry。

**接线后果：** observer dispatch 若要求覆盖 “observability 事件类型枚举” 的所有真实事件，必须选择一个能覆盖 async record、sync fatal、fallback stream 的明确策略；不能假设 scheduler `onEvent` 是唯一生产入口。同步 fatal 路径是否允许 observer 属于实现时必须依据 A1/A2 的“生命周期事件”定义处理，若无法异步安全 spawn，应在稳定事件词表/触发资格上显式建模，而不是静默漏掉。

### B4. closure 元数据来源与 A4 六边差异

#### typed facts

- `src/task-runtime.ts:13-26`：closure lifecycle、worktreePath、branchName、baseCommit、sourceParNodeId、sessions。
- `src/task-runtime.ts:43-58`：leaf/seq/par tree；par 独有 `pinCommit`，树顶有 activeRuns。
- `src/task-runtime.ts:60-85` 起提供精确 ArkType boundary。
- `src/sqlite-state.ts:1842-1845` closure sessions 与 closure timestamp 在 immediate transaction 内更新。
- `src/sqlite-state.ts:1953-1964` active run 与 closure identity/lifecycle 检查和写入在事务内。

#### current event projection

- `closure.resource_prepared`：资源路径/branch/base/freshness。
- `closure.lifecycle_changed`：只表示 active↔suspended，reason 只有 phase-left/phase-entered。
- `closure.consumed`：消费证据/freshness。
- `closure.git_failed`：故障。
- `closure.reconciled`：对账结果。

A4 要求六条转移边 create/run-spawn/run-exit/suspend/reopen/consume。当前：

- suspend 可由 `closure.lifecycle_changed(active→suspended)` 表示；
- consume 有专门事件；
- resource_prepared 不是 create 的可靠同义词；
- activate 不是 reopen 的可靠同义词；
- agent.spawn/exit 虽可关联 run，但不是明确 closure run-spawn/run-exit 边；
- git_failed/reconciled 是诊断/对账，不是六边。

因此不能通过改名解释为已完成。未来应让 RFC-1 的真实 transition producer 逐边提供 typed event，并让 observer point 从 event union 自动获得它们。

### B5. payload 可复用 boundary、匿名槽和 pinned definition

#### 可复用精确 boundary

- 事件信封：`ObservabilityEventBoundary`（`src/observability.ts:823-826`）。
- 编译产物：`PresetCompileProjectionBoundary`（`src/loop.ts:533-587`），含 schemaVersion、preset/sourceHash/task tree identity、statuses/state graph/phases/tools/fragments/findings。
- 运行 task tree：`TaskTreeSnapshotBoundary`（`src/task-runtime.ts:60-...`）与 `CoderLoopStatusSnapshot.taskTree`（`src/loop.ts:936-945`）。

#### 匿名槽

- `src/loop.ts:520-529` 的 `StatusSnapshotBoundary` 把 target/state/queue/runs/current/events/processes 全部声明为 `"object"`，只有 taskTree 是精确 boundary。
- `CoderLoopStatusSnapshot` 的 TypeScript named types（`src/loop.ts:936-...`）不等于外部输入 ArkType 精确派生 boundary；F2/F4 要求的 schema 派生关系尚不成立。
- item/run transparent extra 会删除 hooks（`src/runtime-data.ts:438-443`），但仍容纳 preset-owned remainder；直接把 status object 作为 payload 会引入匿名/开放 shape。

#### pinned definition

- runtime identity 使用 `{kind, contentIdentity}` definition ref（`src/task-runtime.ts:3-11`）。
- SQLite `execution_definitions` 表在 `src/sqlite-state.ts:653-660`；插入函数 `src/sqlite-state.ts:2359-2361` 只保存 kind、identity、semantic_hash=identity、schema_version=1。
- task nodes 保存 definition ref/node id；例如 legacy migration `src/sqlite-state.ts:1131-1153`，新 tree persistence 也复用 `insertDefinition`。
- daemon 的普通 preset resolution 仍按 item 的 preset path/name load/materialize（`src/daemon.ts:3687-3719,5479-5491`）；没有 persisted definition ref→compiled projection lookup。

所以当前 pinned identity 能保证 runtime node 指向哪个内容身份，却不能单独重建 F3 所需的完整 compile projection。把当前路径重新 `loadPreset` 会读到路径的新内容，不能视为解引用。

### B6. 事务、并发、失败恢复与子进程回收

#### 已有事务性质

- chain/item hook 声明随其现有 SQLite row JSON 更新，继承对应 operator command 的事务语义。
- closure/active-run 更新在 sqlite store transaction 内维护 identity/lifecycle 不变量。
- observability file append 与 SQLite mutation不是同一事务；record helper await append，但 append failure 的普通 API会写 stderr而不回滚状态。

这些性质可作为 payload 快照的数据来源一致性线索，但当前没有定义“事件时刻快照”和“组装时读取快照”的原子性；异步 observer 尤其可能在执行时看到事件之后的新状态。稳定 RFC只要求运行态快照，具体采样点若影响语义需在实现中固定。

#### 并发

- 当前不存在 observer queue/registry，所以没有同脚本串行、跨 chain 并行、backpressure 或最大并发语义。
- A1/G1 要求调度不等待；这排除了在 event writer 上 await 脚本完成，但并不自动决定 spawn 本身、stdin 写入失败、并发上限如何处理。
- P3 已明确把互斥/重入留作落地决策；本报告不新增结论。

#### daemon 崩溃/重启

- hook declarations 会随 global file、chain/item SQLite 恢复。
- 没有 observer execution journal、child registry 或恢复记录；fire-and-forget observer 是否跨 daemon restart 被终止、遗留还是忽略，目前无代码语义。
- 事件流 append 是 JSONL rotate 模型；它可记录已发生事实，但不能替代 hook execution recovery。

#### 子进程回收

- scheduler agent 路径已有 timeout 后 SIGTERM、再 SIGKILL process group（如 `src/scheduler.ts:2339-2344,2578-2591`）。
- daemon stop 也有 PID/group 回收 helper（`src/daemon.ts:4879-4933`）。
- 这些函数绑定 agent/daemon lifecycle；没有 hook child handle、hook process group 创建、hook timeout diagnostic 或 observer “不重试”路径。
- `src/sqlite-state.ts:1189`、`src/daemon.ts:4914` 等现有 `Bun.spawnSync` 属于迁移/进程探测，不是 hook 路径。G5 的验收应限制在 hook 执行路径，不能错误声称全仓无 spawnSync。

### B7. I2/I9 全点 exhaustiveness 与四层 AND 接缝

#### I2

现有正资产：

- `NON_TICK_GATE_DECISION_POINTS`/`GATE_DECISION_POINTS` tuple 单一导出（`src/hook-declarations.ts:15-27`）。
- Gate declaration union 用 tick variant 强制 `minIntervalMs`（`src/hook-declarations.ts:43-45,66-80`）。

缺口：

- tuple 只被 declaration parser/type 消费；
- 没有 evaluation wiring、payload trigger-context variant、hook event point field或各 point producer；
- 因此新增 point 不会让这些缺失层编译失败。

本切片不判断 gate runtime 的具体点行为，只确认 observer/payload 不能依赖当前 tuple 声称“全点 exhaustiveness”。

#### I9 / 四层 AND

现有正资产：

- `buildEffectiveHookView` 单函数固定 layer order 和 provenance。

缺口：

- 无生产 caller；
- 无按 point/kind 筛选；
- 无 observer 全执行；
- 无 gate sequential/parallel执行策略；
- 无 decision collection/AND；
- preset placeholder 没有 compiler/pinned-definition producer；
- daemon startup/shutdown/tick 没有 chain/item 宿主时，四层适用范围及 payload scope 尚未实现（对应已登记 P2/P5，不在本报告裁决）。

结论：四层 AND 接缝目前只有“排序数组”一项资产，不能作为全点保证。

### B8. 测试：有效覆盖、同错与盲区

#### 有效局部覆盖

- `tests/unit/daemon/hook-declarations.exhaustiveness.ts:14-18`：未来普通 event 自动成为 observer point，未来 `hook.*` 自动排除；有效证明 A2 类型关系。
- `tests/unit/daemon/hook-declarations.test.ts`：解析、layer order、tick validation 等声明边界。
- `tests/integration/daemon/hooks.integration.ts:21-59`：global reload、chain/item persistence、手工 effective view layer order。
- `tests/integration/daemon/hooks.integration.ts:65-167`：hooks 不进入现有 status item/run transparent surfaces；有效证明当前边界事实。

#### 与实现同错

- `tests/integration/daemon/hooks.integration.ts:5,45-48` 的测试名称和 sentinel 断言明确把“调度中永不执行”作为 #586 骨架预期；它不能证明 A1/G1，反而是未接线的强反证。
- 同一测试通过直接调用 `effectiveHookViewForItem(..., [presetPlaceholder])` 注入 preset placeholder，绕开了 compiler/pinned-definition producer；不能证明 D1 preset 层。
- layer order equality 只证明数组顺序，不证明触发匹配、全部执行或 gate AND。

#### 盲区

- 所有 daemon/observability event writer 是否派发 observer；
- `hook.*` 发射期显式零派发；
- slow observer 不拉长 tick/另一 chain；
- stdin schema/version/导出；
- timeout、spawn failure、非零退出与 diagnostic 字段；
- SIGTERM→SIGKILL group 回收及孙进程；
- daemon crash/restart 的 orphan behavior；
- closure 六边事件及 payload closure metadata；
- persisted definition ref 解引用 compile projection；
- F8 GitHub 字段负向守护；
- I2 新增 point 时 evaluation/payload/event consumers 的编译失败；
- I9 所有 point 的统一合成。

### B9. 最小实验计划与限制

本次未运行实验，因为当前生产实现明确没有 observer/payload，运行只能重复“sentinel 不出现”，而不能判定尚不存在的超时/并发/回收语义。

实现出现后，最小隔离实验应：

1. 用独立 `--loop-data-root` 和 fixture repo 启 daemon，不接触中央 daemon。
2. global/chain/item 各声明记录 stdin 的 observer；preset placeholder 必须来自真实 pinned compile product。
3. 触发 daemon 自产 event、scheduler event、closure 六边 event，核对每个 event 的四层匹配和一次性 dispatch。
4. 脚本矩阵：成功、非零、sleep timeout、exec/spawn failure、fork 孙进程。
5. 同时运行无 hooks 的另一 chain并采样 tick，证明旁路。
6. observer 执行中 kill -9 隔离 daemon，重启后检查孤儿进程、事件流和“不重试”边界。
7. stdin 经导出 schema parse；fixture 中加入 status 匿名 extra 和 GitHub 风格字段，证明二者未泄漏；再改变 preset 路径内容，证明 payload仍按 pinned definition ref解引用。

副作用边界：只允许 fixture 根、隔离 loop-data-root 和脚本输出文件；不得启动或修改中央 daemon/生产数据库。

### B10. 证据索引

| 主题 | 主要证据 |
|---|---|
| observer point 结构减法 | `src/hook-declarations.ts:8-13,103-116` |
| gate point tuple | `src/hook-declarations.ts:15-27,43-45,66-80` |
| 四层 helper | `src/hook-declarations.ts:48-58,138-145` |
| helper 唯一生产包装/无 caller | `src/daemon.ts:1215-1232`；全仓 `rg 'effectiveHookViewForItem\\('` |
| global 装载 | `src/daemon.ts:1235-1244` |
| status 排除 hooks | `src/runtime-data.ts:438-443` |
| canonical event union | `src/observability.ts:17-110` |
| closure event payload | `src/observability.ts:355-383` |
| event record 无 dispatch | `src/daemon.ts:2285-2294` |
| sync/fallback writers | `src/daemon.ts:1330-1361,2303-2322` |
| scheduler event conversion | `src/daemon.ts:827-1119,3728-3741,5494-5496` |
| compile projection boundary | `src/loop.ts:533-587` |
| status anonymous boundary | `src/loop.ts:520-529` |
| task/closure typed snapshot | `src/task-runtime.ts:3-58,60-85` |
| persisted definition 不足 | `src/sqlite-state.ts:653-660,2359-2361` |
| preset current-path load | `src/daemon.ts:3687-3719,5479-5491` |
| zero execution integration evidence | `tests/integration/daemon/hooks.integration.ts:5-59` |
| status projection evidence | `tests/integration/daemon/hooks.integration.ts:65-167` |

**文件结束。**
