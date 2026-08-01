# RFC #543 R4-S2：gate / 调度运行时供给侧设计符合性深审

> 固定事实基线：`/Users/mouriya/Ext/code/coder-loop`，`main`，`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
> 设计锚点仅为同目录 `aggregation.md`、`01-clauses.md` 的 A5–A7、B、H、I 以及 D2–D3/J1/J4；`WORKFLOW.md` 规定调查法。
> 本报告只调查现状，不裁决需求、不设计 implementation issue、不修改产品代码或测试。

## A. 主 agent 摘要（最多一页）

### A1. 问题

main 已有 gate 声明闭集、chain-complete keep-active/fingerprint 先例、daemon/scheduler 状态底料。它们分别是否符合稳定语义，能否直接作为统一 gate evaluator、全决策点 hold、指纹/节流与 epoch/journal 的地基？

### A2. 结论与置信边界

**总判定：声明 ADT 是可保留地基；执行运行时整体尚不是 gate evaluator 地基；chain-complete 是有价值但必须拆分收编的先例，不能泛化复制。**

1. **符合（高置信）**：
   - 声明期 gate point 闭集是单一 `as const` union；包含 A6 所列八类名称；tick 强制显式正整数 `minIntervalMs`；闭包事件不在 gate point 列表中（A7 的声明半边）。
   - `onFailure` 声明为 `hold | advance`；四层 effective view 的纯合成顺序是 global→chain→preset→item。
   - chain-complete fingerprint 的 canonical serialization、稳定排序、自身状态剔除，确实避免其持久化写入自扰；keep-active 状态在 SQLite chain metadata 中，重启后仍能抑制同一上下文再问。
   - 调度与 daemon 已有异步 Promise/child-process 路径和跨 chain tick，不需要 `spawnSync` 执行 gate。
2. **偏离（高置信）**：
   - 所有 hook 声明在生产调度路径上**零执行消费者**；effective view 只有一个供测试/查询的 daemon 方法，没有 scheduler 调用者。A5、B2/B5、H1–H3、I1 的执行半边均未实现。
   - 现有 chain-complete decision 是私有二词 `complete | keep-active`，不是统一 `advance | hold | reopen`；异常固定 fail-closed，没有 per-hook `onFailure`；单 callback，无四层 AND、无多 reopen。
   - A6 的八个名字没有物化为八个可 hold 的生产挂点。pre-spawn 之前已经创建 run/closure/current-run 并更新 item；post-exit 的持久化、closure suspend、terminal event 在下一选择之前直接发生；item transition 无 `gate_held`；startup/shutdown 无 held state；tick 无逐声明节流状态。
   - chain-complete keep-active 存在专用 state/decision/callback/metadata shape，直接违反 I4“收编后专用形态不残留”和 I5“per-point evaluation store，不写 chain.metadata”。
   - 无 evaluation identity/epoch/journal/decision ingress/consumed transaction；J1/J4 不成立。
3. **静态不可判定（需最小隔离实验）**：
   - chain-complete trigger 长时间 await 时，operator 并发修改 chain metadata 与随后基于旧 `chain` 快照的 whole-metadata keep-active 写之间，是否在真实 daemon socket serialization 下必现 lost update。源码暴露明确窗口，但复现顺序取决于 callback/命令调度；见 B7。
   - daemon shutdown gate 将来需要“socket 可查但无新调度”的精确命令准入矩阵；当前 `shutting_down` 下连接/请求行为未为 gate 语义定义，单靠静态代码不能确定目标交互应落在哪个边界。

### A3. 因果与影响分类

- **当前影响**：当前声明是刻意的“零执行副作用”，故声明 gate 不会 hold；这是未交付而非已交付回归。chain-complete keep-active 当前能持久 hold chain completion，且测试证明上下文改变后重问。
- **未来影响**：若把 hook executor只接进现有函数附近，会在 pre-spawn、post-exit、status transition、startup/shutdown 的副作用之后才 hold，产生“名为 hold、状态已推进”；复制 chain metadata fingerprint 会把 per-point state 混入业务 carrier，并与 epoch/journal 冲突；直接复用单 callback 会丢 D2/D3。
- **纯证明缺口**：声明 union 的“新增 variant 强制所有执行处置点”目前无从证明，因为没有执行处置点；现有测试验证声明 parsing/展示和 chain-complete 私有语义，不能证明统一 evaluator。

### A4. 可保留资产

- `GateDecisionPoint` / tick discriminated declaration ADT 和 arktype 边界；四层 declaration provenance/order view。
- daemon 的 tick 单飞与 pause barrier、scheduler 的 per-chain finalizing guard、Promise 异步调用形态。
- chain-complete fingerprint 的稳定 JSON、排序、排除自身写入这一算法经验；**只可提取算法原则，不能保留其存储位置/私有 decision wire。**
- SQLite `write(... db.transaction(fn).immediate())` 单次写事务原语，以及 WAL/busy timeout 基础。
- `DecisionFingerprintState` 的 scoped lifecycle cleanup/exhaustive event handling可作观测事件去重资产；它不是 gate hold 存储。

### A5. 未知与下一步

- R5 前应把“lost metadata update 并发窗口”登记为静态未知；若其是否为负资产会改变修补地基，运行 B7 的隔离实验。
- 不需要操作员新增裁决：AND、reopen、epoch 正交、observer-only、tick 节流均已裁决。需要后续需求侧明确每个 point 的 canonical `FingerprintInput` 和 hold 前原子边界；那是既定 P 项/需求推导，不在本报告裁决。

---

## B. 证据附录

### B1. 稳定语义对照（三态）

| 条款 | 判定 | 生产证据与解释 |
|---|---|---|
| A5 gate hold、异步、不阻塞其他 chain | **偏离** | 声明存在但没有 evaluator/executor 调用。scheduler 唯一判定 callback 是 chain-complete 私有接口（`src/scheduler.ts:303-315,2752-2790`）；其他 chain 可继续是现有 scheduler 性质，但没有 hook hold 可验证。 |
| A6 内禀闭集全点 | **部分符合/执行偏离** | 名称闭集完整：`src/hook-declarations.ts:15-27`。生产挂点未物化；见 B3。 |
| A7 closure observer-only | **声明符合；运行接缝偏离** | closure 不在 gate point union（`src/hook-declarations.ts:15-24`），但 run post-exit gate 不存在；closure suspend 已在 post-exit直接执行（`src/scheduler.ts:2146-2151`），因此“在 post-exit hold 自然阻止 suspend”的运行保证不存在。 |
| B2 三词 decision/合法组合 | **偏离** | 唯一运行 decision 是 `complete | keep-active`（`src/scheduler.ts:310-315`）；无 `reopen`、无 point×decision validator。 |
| B5 per-hook timeout/onFailure | **声明半边符合；执行偏离** | parser强制 timeout/onFailure（`src/hook-declarations.ts:36-45,66-80,103-130`）；运行路径不消费。chain-complete异常固定返回 false（`src/scheduler.ts:2781-2790`）。 |
| B6 通用防抖 | **先例存在，通用语义偏离** | chain-complete 专用 fingerprint 持久化；其他 point 无此机制（`src/scheduler.ts:2755-2757,2793-2862`）。 |
| D2 四层全部执行、AND | **view 顺序符合；执行偏离** | `buildEffectiveHookView` 只拼接顺序（`src/hook-declarations.ts:138-145`）；唯一生产调用者缺失，单 chain callback 没有 AND。 |
| D3 多 reopen | **偏离** | 运行 decision union根本无 reopen；不存在同 target union / 异 target conflict diagnostic。 |
| H1 统一逐层 evaluator | **偏离** | effective view与scheduler无接线；chain-complete私有逻辑。 |
| H2 stdout parse/非法分类/onFailure | **偏离** | 无 script stdout evaluator。现有 trigger phase通过 runner输出的既有 phase机制取得私有 decision，不是本契约。 |
| H3 point-local hold、可改判 | **偏离** | keep-active只 hold chain completion，且同 fingerprint不会退避重问；上下文改变才重问。没有其他 point/local evaluator。 |
| I1 同一协议路径 | **偏离** | 八个名称只有声明，实际各生命周期路径没有 evaluator。 |
| I2 union新增暴露全部处置点 | **声明符合、证明缺口** | parser/serializer穷尽；没有 payload/evaluation/event执行处置点可被编译器暴露。 |
| I3 tick节流 | **声明符合、运行偏离** | `minIntervalMs > 0` parse存在（`src/hook-declarations.ts:73-80,119-127`）；daemon tick仅全局 interval与单飞（`src/daemon.ts:3612-3678`），无每声明 last-completion/epoch。 |
| I4 hold fingerprint收编 | **偏离** | 专用 `coderLoopChainCompleteTrigger` state、callback、decision仍存在；无 per-point通用 store。 |
| I5 typed FingerprintInput/per-point store | **偏离** | chain fingerprint手写全 chain/items投影且写 `chain.metadata`（`src/scheduler.ts:2819-2862`；`src/runtime-data.ts:81-95,489-504`）。effective hook declaration hash、point/host identity缺失。 |
| J1 epoch状态机/journal | **偏离** | SQLite schema/运行代码无 gate evaluation表、epoch或 evaluating/decided/consumed ADT；keep-active一次 whole-chain metadata update，不是 decision+effect transaction。 |
| J4 epoch与fingerprint正交 | **偏离** | 当前只有 fingerprint，没有 epoch；内存 observability fingerprint又是另一套含义（`src/daemon.ts:631-723`）。 |

设计依据：`01-clauses.md:18-20,27-31,45-46,87-101,111-114`；已落地声明的“零执行副作用”明确见 `aggregation.md:30`，故不能把无执行误判成回归。

### B2. 全部声明合成消费者

生产 `src/` 穷尽检索：

1. `buildEffectiveHookView` 定义于 `src/hook-declarations.ts:138-145`。
2. 唯一生产调用位于 `CoderLoopDaemon.effectiveHookViewForItem`：`src/daemon.ts:1215-1232`。
3. 该方法在 `src/` 中无调用方；仅测试 `tests/integration/daemon/hooks.integration.ts:39,87` 直接调用。
4. global hooks只在 daemon startup装载：`src/daemon.ts:1239-1244`；chain/item hooks由 runtime data parse/serialize持有（`src/runtime-data.ts:107-110,211-215,351,419`），无执行消费。
5. preset placeholder同样只进入 effective view输入；无绑定、脚本解析或执行者。

因此“符号存在”只证明声明面；不能证明 A5/H/I。

### B3. 调度决策点：真实生产路径、状态转换、调用者与可 hold 边界

#### B3.1 tick

- timer：`startSchedulerLoop` 每 interval 调 `queueSchedulerTick`（`src/daemon.ts:3612-3618`）。
- socket/mutation也可请求 tick，最终由 `requestSchedulerTick` 单飞，重入置 `schedulerTickRequested`（`src/daemon.ts:3620-3631`）。
- `runSchedulerTicks` 调 `schedulerTick`，只受 daemon rate-limit maxSpawns约束（`src/daemon.ts:3665-3678`）。
- 现有可 hold 边界：调用 `schedulerTick` 之前；但每个 tick hook声明需要独立完成时钟，不能等同全局 interval。

#### B3.2 run pre-spawn

- `schedulerTick` 读取链/项、解析状态/phase，选中 `next` 后直接调用 `spawnSchedulerRun`（`src/scheduler.ts:492-580`）。
- 真正 OS `spawn` 在 `src/scheduler.ts:1699-1706`，但此前已：worktree/closure资源准备、`recordRunWithClosureResources`、closure进入、current-run写入、item attempts/lastRun/phase更新（`src/scheduler.ts:1583-1656`）。
- 所以“在 OS spawn 前插一行 evaluator”太晚；A5 要求 hold 时 run推进不发生。可 hold 边界必须位于任何 run/closure/current-run/item副作用之前，至少在 `spawnSchedulerRun` 调用前或把prepare拆成事务化阶段。

#### B3.3 run post-exit / 下一次选择前

- close handler先写status artifact、complete run、clear current run，释放active slot与凭证，发 `agent.exit`/`phase.end`（`src/scheduler.ts:2040-2088`）。
- 随后更新item/backoff/session，可能suspend closure、发terminal，最后调用chain completion（`src/scheduler.ts:2089-2164`）。
- 下一 scheduler tick 才再次选择，但 A7 要求 post-exit hold 能阻止closure suspend；因此 evaluator必须在 `runLeavesPhase`/closure mutation之前。哪些 run record清理可在hold前落地，稳定条款未逐字段裁定，是后续 canonical point payload/transaction边界需求，不可由本报告补需求。

#### B3.4 item status transition

实际写入口不止一个：

- daemon operator/agent request先由 `admitItemStatusForRequest`执法，后进入store；锚点说明见 `src/daemon.ts:3806-3810`，具体command handler由该constructor产生 admitted status。
- scheduler内部至少有 attempt exhausted（`src/scheduler.ts:821-827`）、spawn abort restore（`src/scheduler.ts:1900-1903`）、run-status forward（`src/scheduler.ts:2101-2115`）、dependency unblock restore（`src/scheduler.ts:2643-2651`）。
- store `updateItem`本身只执行单行事务写，不知道 gate（`src/sqlite-state.ts:1762-1804`）。

统一 gate不能只包 daemon request，否则engine内部写旁路；也不能把异步脚本塞进同步store。需要在各生产者进入store前汇合到同一异步 transition orchestration，并保留admission事实。当前无结构化 `gate_held`返回形态。

#### B3.5 container.advance / par join

main已有task tree/closure与outer completion，但没有通用容器推进 evaluator。chain completion读取task tree并逐closure consume（`src/scheduler.ts:2723-2749`），这是顶层完成接缝，不等于所有容器推进点。RFC-1提供的容器推进/reopen语义尚属跨树消费，本切片不主审持久化。

#### B3.6 chain.complete

- 两个调用来源：每个tick尾 `src/scheduler.ts:580`；run close尾 `src/scheduler.ts:2164`。
- `completeChainIfReady`先检查active slot/items/dependency/terminal/finalizing，设置进程内 `finalizingChainIds`，解析phase plan，然后调用私有 trigger（`src/scheduler.ts:2683-2720`）。
- trigger放行后再次刷新chain/items/terminal，再consume closures、写chain completed、发事件（`src/scheduler.ts:2707-2716`）。
- `finalizingChainIds`使同进程并发调用快速返回，测试覆盖overlapping tick只调用一次（`tests/integration/scheduler/core.integration.ts:720-744`）。这是可保留的host-local排他先例，但非持久journal。

#### B3.7 daemon startup

- state仅 `starting|running|shutting_down|exited`（`src/daemon.ts:399`）。
- startup在装载hooks前后执行大量副作用：创建runtime目录、socket listen、open DB、recovery、写pid，之后直接置running、发start、启动scheduler（`src/daemon.ts:1235-1275`）。
- 无 `starting-held`；合理hold边界必须同时满足socket可查/不调度/恢复只做一次。当前状态机没有表达，不能由声明名称自动获得。

#### B3.8 daemon shutdown

- `stop`一进入就置 `shutting_down`、发stop、pause并等待tick、终止runs、关闭socket/DB、删runtime files、置exited（`src/daemon.ts:1512-1562`）。
- 无 `shutdown-held`。若 evaluator在stop入口之前，必须防重复stop并保持查询面；若在state切换之后，`requestSchedulerTick`会自然停止（`src/daemon.ts:3621`），但命令准入/重问时钟尚无定义。这是静态未知接缝，不是可直接复用的held state。

### B4. chain-complete fingerprint 深查

#### B4.1 输入与 canonicalization

`chainCompletionFingerprint`输入：

- chain稳定业务字段与 `metadata`，但用 `withoutChainCompleteTriggerState`剔除自身；
- 排序后的 terminal statuses；
- 全部items的row id、opaque itemId、repo/status/attempts/title/priority/run/session/path/runner/phase/extra/timestamps，按row id排序；
- 递归stable JSON（object key排序，数组保序），SHA-256。

证据：`src/scheduler.ts:2819-2865`。优点是确定、自扰字段被排除；偏离 I5 是投影过宽（偶然字段/时间戳/全extra），且不含 point identity、host identity、effective declaration hash。

#### B4.2 存储与事务

- state shape：`decision=keep-active,fingerprint,recordedAt,reason?,runId?`，存于 `chain.metadata.coderLoopChainCompleteTrigger`（`src/runtime-data.ts:81-95,203-209,489-504,611-626`）。
- `persistKeepActiveTriggerState`调用 `store.updateChain` whole metadata（`src/scheduler.ts:2798-2817`）。
- 单次 `updateChain`被 `db.transaction(...).immediate()`包裹（`src/sqlite-state.ts:1605-1612,1713-1734`）；数据库WAL与5秒busy timeout在`src/sqlite-state.ts:840-845`。
- 该事务只保证这一行写原子，不把“判定开始/decision/效果”组成J1事务，也无compare-and-swap/version check。

#### B4.3 抑制、恢复、自扰

- 每次评估前从传入chain snapshot读持久state；decision与新fingerprint相同即false且不再执行trigger（`src/scheduler.ts:2752-2757,2793-2796`）。
- metadata持久，daemon重启后仍生效；不依赖内存 `DecisionFingerprintState`。
- 自身state和chain updatedAt未进入fingerprint，因此持久hold不会自己制造新fingerprint。新item或item/业务metadata变化会触发重问。测试明确验证第一次keep-active、第二tick不重问、新item后第三tick重问（`tests/integration/scheduler/core.integration.ts:750-791`）。
- 缺口：没有backoff timer；稳定上下文永不重问。对I4“同上下文不重复问”是先例，对B2“退避重问”必须结合未来epoch/fingerprint规则理解，不能把当前永久抑制直接复制。

#### B4.4 并发与崩溃窗口

- 同进程同chain completion由 `finalizingChainIds`保护到整个await结束（`src/scheduler.ts:2693-2720`），防tick与close handler重复trigger。
- trigger自身可await外部runner；期间daemon socket命令仍可执行。`persistKeepActiveTriggerState`使用进入函数时的旧 `chain.metadata`构造whole metadata。若并发命令更新metadata，随后旧快照写可能覆盖它；没有CAS。源码证明窗口存在，实际命令序列是否必现见B7实验。
- 崩溃在trigger副作用之后、metadata persist之前：重启会重执行trigger；没有evaluation scope幂等。
- 崩溃在metadata persist之后：重启按fingerprint抑制；但没有“decision decided而效果未消费”状态，因为keep-active写本身就是唯一效果。此模型无法承载advance/reopen的J1消费原子性。
- advance/complete decision不持久；崩溃在callback返回后、chain completed写前会重问。故不是可泛化journal。

### B5. 两个“fingerprint”机制不得混同

1. **gate-like durable keep-active fingerprint**：scheduler计算，存chain metadata，控制是否再次调用chain trigger（B4）。
2. **observability decision edge suppression**：daemon `DecisionFingerprintState`在内存按slot/item/chain保存事件hash，决定重复decision event是否落日志；daemon restart即清空，scheduler lifecycle event释放scope（`src/daemon.ts:631-723,731-765`）。

后者的chain-complete key含event `runId + observabilityDecisionFingerprint`，只影响事件噪声，不hold、不恢复decision。测试 `tests/integration/daemon/runs-observability.integration.ts:294-321,323-479,483-505`证明的是观测去重与回收，不能用作I4/J1证据。

### B6. AND、多 reopen、epoch/journal接缝

- **AND**：四层view有正确顺序，但没有脚本解析/逐项执行/合成。chain-complete仅接收一个`chainCompleteTrigger`或一个`ForChain`（daemon wiring `src/daemon.ts:3785-3797`），二者以if/else互斥，不是AND。
- **多 reopen**：现有union无reopen，零接缝。容器consume发生在trigger放行之后；未来reopen必须在consume前完成校验/认领，不能复用当前boolean返回而隐藏D3冲突。
- **epoch/journal**：SQLite现有transaction原语可保留，但没有相关表/ADT/ingress。chain metadata state既无epoch又是whole-carrier，不能作为J1存储。`finalizingChainIds`是进程内排他，重启丢失；可辅助同进程并发但不能替代journal。
- **observer-only closure**：closure事件与mutation已存在，但post-exit和completion consume必须由gate host边界包住；不能给closure transition本身新增gate（A7）。

### B7. 静态未知的最小实验（未运行）

本调查没有启动中央daemon、没有改生产DB，也没有运行会生成worktree的fixture。以下实验仅在是否影响R5地基判断时执行：

#### B7.1 stale metadata lost-update

在本地隔离loop-data-root、scheduler integration fixture中：

1. terminal chain触发一个Promise阻塞的`chainCompleteTrigger`；
2. trigger已读到chain snapshot后，通过store或真实daemon socket更新同chain一个无关metadata字段；
3. 释放trigger返回keep-active；
4. 读取chain metadata，断言无关字段是否仍在；
5. 重跑10次并记录顺序。

副作用仅隔离fixture DB/目录；不用git worktree，可scheduler disabled后直接构造store/trigger上下文。预期不是本报告结论；若字段消失，确认现有专用存储是负资产；若保留，需找到额外serialization证据而非据一次成功下结论。

#### B7.2 shutdown-held查询面

此项须等需求侧把“held时允许哪些命令”从稳定语义投影出来后再实验；当前直接实验只能观察旧行为，不能判符合。隔离daemon中用阻塞barrier暂停stop的不同阶段，分别尝试status/socket命令并观察scheduler无新spawn，建立可插边界事实。

### B8. 测试同错与盲区

#### 已证明、可保留

- hook declaration parser、四层view与restart round-trip：`tests/integration/daemon/hooks.integration.ts:19-57,67-93`。
- chain-complete同进程排他、keep-active抑制与上下文变化重问、失败fail-closed：`tests/integration/scheduler/core.integration.ts:720-835`。
- decision observability去重/回收：`tests/integration/daemon/runs-observability.integration.ts:294-321,323-479,483-505`。

#### 同错风险

- hooks integration只直接调用`effectiveHookViewForItem`，没有通过scheduler触发；它与“声明存在即能力存在”的误读同错。
- chain-complete测试把`complete|keep-active`和固定fail-closed当正确私有契约；对稳定三词/onFailure/AND而言是旧语义回归测试，不是符合证明。
- fingerprint测试只证明新增item改变hash；未验证effective declaration hash、point identity、canonical最小投影、epoch正交。

#### 盲区

- 无任一点真实gate script执行、stdout parse、timeout、onFailure、其他chain不受影响。
- 无pre-spawn零副作用hold；无post-exit阻止closure suspend；无item mutation零落地/gate_held；无startup/shutdown held；无tick per-hook节流。
- 无四层gate AND、多reopen、conflict diagnostic。
- 无crash窗口、decided恢复、evaluating重问、mutation idempotency或stale decision拒绝。
- 无concurrent chain metadata mutation与keep-active whole-metadata write竞态测试。

### B9. 迁移与历史数据

- chain-complete state parser允许缺字段并保留unknown remainder（`src/runtime-data.ts:611-626,736-743`）；现有rows可携带该专用state跨升级。
- 通用per-point store落地时，不能静默把旧`keep-active`解释成J1 `decided/consumed` epoch：旧记录没有point identity、declaration hash、epoch或decision ingress证据。
- 稳定I4要求“收编专用形态不残留”，但历史行处置（迁移/忽略/清理时机）在当前锚点未裁定。R5应登记迁移事实需求，不由本报告选择策略。

### B10. 无策略字面量与 spawnSync核对

- gate相关生产代码只出现通用chain completion、hook point、decision词；未发现“轮数/检查任务”等策略字面量。R7当前无负资产。
- `src/`已有`Bun.spawnSync`用于其他既存边界：`src/sqlite-state.ts:1189`、`src/loop.ts:3678,4349,4357`、`src/daemon.ts:4914`。它们不是hook执行。稳定要求是gate evaluator不得新增/复用同步spawn；现有scheduler runner使用异步`spawn`（`src/scheduler.ts:1699-1706`），是可保留形态。

### B11. 证据索引与复核命令

固定HEAD：

```sh
git -C /Users/mouriya/Ext/code/coder-loop rev-parse --abbrev-ref HEAD
git -C /Users/mouriya/Ext/code/coder-loop rev-parse HEAD
# main
# 699842eba2eefc242d19f8fa9232bc1d9d5c3bdd
```

关键穷尽检索：

```sh
rg -n "effectiveHookViewForItem|buildEffectiveHookView|globalHookDeclarations|metadata\\.hooks|extra\\.hooks|PresetHookPlaceholder" src tests
rg -n "DecisionFingerprintState|chainComplete|completeTrigger|keep-active|fingerprint" src/scheduler.ts src/daemon.ts src/sqlite-state.ts src/runtime-data.ts
rg -n "type DaemonState|this.state|runSchedulerTicks|schedulerTick" src/daemon.ts
rg -n "updateItem\\(|engineLifecycleAdmittedItemStatus|completeChainIfReady|spawnSchedulerRun" src/scheduler.ts
rg -n "spawnSync" src
```

复核文件优先级：

1. `src/hook-declarations.ts:15-172`（声明闭集/parser/view）。
2. `src/scheduler.ts:492-580,1565-1750,2040-2165,2683-2865`（全部关键调度边界与先例）。
3. `src/daemon.ts:399,631-765,1215-1278,1512-1562,3608-3799`（daemon状态/tick/观测指纹/wiring）。
4. `src/runtime-data.ts:81-95,203-215,489-504,611-626,736-743`（专用持久shape）。
5. `src/sqlite-state.ts:840-845,1605-1612,1713-1734,1762-1804`（WAL/事务/write carrier）。
6. `tests/integration/scheduler/core.integration.ts:720-835` 与 `tests/integration/daemon/hooks.integration.ts:19-93`（测试边界）。

## C. 尾部核对

- 已逐条覆盖 A5–A7、B2/B5/B6、D2–D3、H1–H3、I1–I5、J1/J4。
- 已列八类决策点真实路径、转换/调用者/可hold边界。
- 已查 chain-complete fingerprint 输入、存储、事务、并发、恢复、自扰。
- 已区分 durable keep-active fingerprint 与内存 observability fingerprint。
- 已列全部 effective hook view生产消费者、测试同错/盲区、迁移/崩溃窗口与可保留资产。
- 未运行实验；两个静态未知均给出最小隔离实验和限制。
- 未修改产品代码、测试、配置、WORKFLOW.md或生产数据库；未创建worktree；未启动/修改中央daemon。
