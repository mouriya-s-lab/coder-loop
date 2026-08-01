# RFC #543 · R7-DI-03 closure 六条转移边的真实生产事实

> 调查基线：`/Users/mouriya/Ext/code/coder-loop` main `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点为 `08-detail-investigation-index.md` 的 DI-03、A4/F7、ledger `S1-U04`，以及 RFC-1 冻结契约 `v3/closure-lifecycle-decision.md`。本文只报告 producer ground truth；不设计 observer、payload shape、补法或工作量。

## A. 摘要（≤1 页）

### A1. 结论

RFC-1 冻结契约把 closure 定义为持久三态对象，并把六个**语义边**列为 `create / run-spawn / run-exit / suspend / reopen / consume`；其中 run-spawn/run-exit 是 attempt 链内 `active → active` 的执行边，不等于 lifecycle 列值变化（`v3/closure-lifecycle-decision.md:38-44,54,58`）。main 的权威持久事实与事件流没有同构地实现这六边：

| RFC-1 边 | main 权威持久事实 | main 最接近的事件 | 关系 |
|---|---|---|---|
| create | 同一 SQLite write 中创建 tree/leaf/closure，初态 `active`，并插入首条 `runs` | `closure.resource_prepared` | 派生且多义：每次 spawn preparation 都发，不只 create；显式 `createTaskTree` 可创建 closure 而完全不发它 |
| run-spawn | `runs.status=running` 先落盘；随后 `active_runs` 建立；进程真正 spawn 成功在更后 | `agent.spawn`；此前还有 `closure.resource_prepared` | 有真实 run 事件，但没有 `closure.run_spawn`；`agent.spawn` 带 durable closure identity，却不是 closure 词表成员 |
| run-exit | `runs` 写 ended/exit/status，并删除 `active_runs`；closure 通常仍 `active` | `agent.exit` | 有真实 run 事件，但没有 `closure.run_exit`；之后是否 suspend 是独立条件边 |
| suspend | `task_closures.lifecycle: active → suspended` | `closure.lifecycle_changed` (`reason=phase-left`) | 当前唯一与六边直接同事实的 closure 事件，但一个通用事件类型承载 suspend 与 reopen 两方向 |
| reopen | `task_closures.lifecycle: suspended → active`；资源/session 原地保留 | `closure.lifecycle_changed` (`reason=phase-entered`) | 当前合法历史中直接承载该方向；名称仍不是 reopen，且 scheduler 的 `resourceState:"reopen"` 也用于 active retry，不能当权威边 |
| consume | 同一 transaction 写 `lifecycle=consumed`、清 sessions、写 pending intent；之后异步清 Git、发事件、mark emitted、清 resource tuple | `closure.consumed` | 直接相关但事件位于 effect 中段；at-least-once，且 payload 是消费证据而非全 closure snapshot |

现有五类 `closure.*` 是五类**审计/诊断主题**，不是六边的压缩编码：`resource_prepared` 跨 create/spawn/retry，`lifecycle_changed` 合并 suspend/reopen，`consumed` 对应 consume 的外部效果证据，`git_failed` 与 `reconciled` 均不是状态机边。create/run-spawn/run-exit 没有显式 closure event type；因此五类不能通过重命名或数量配对得到六边。

### A2. 根因集合与影响边界

- **直接机制：** 状态、run、active-run、consumption intent 分属不同 SQL 表和 write；JSONL observability 是 DB commit 后的独立 append，没有与 producer transaction 共用原子提交。
- **上游来源：** main 的实现目标同时服务资源准备、runner lifecycle、GC evidence 与启动对账；事件词表按这些操作主题形成，而 RFC-1 冻结契约要求的是状态机语义边。
- **历史原因：** lazy runtime closure 在首次 run preparation 才物化；显式 task-tree import 又可直接携带任意 closure lifecycle。这产生两个 create producer，而事件只接在 scheduler preparation 上。
- **放大条件：** spawn preparation 失败、event append 前 crash、consume emit→mark 间 crash、显式 `createTaskTree`、active retry、startup reconciliation，都会放大“持久事实与事件不是一边一条”的差异。
- **消费者影响：** 当前消费者是 JSONL/log query/renderer 与测试；没有 observer dispatcher。消费者可查询现有 typed event，却无法只靠 `closure.*` 无歧义重建六边全序或全量 closure metadata。
- **修补边界（只定边界，不列补法）：** 六边的生产事实跨 `sqlite-state`、scheduler runner lifecycle 与 consumption outbox；不能只改 observability type tuple，也不能从未来订阅者想要的 payload 反推 producer。

### A3. 运行观察

在 source SHA 上运行隔离脚本：

```text
bun scripts/issue-560-integration.ts > /tmp/r7-di03-issue560.jsonl 2> /tmp/r7-di03-issue560.stderr
EXIT=0
issue-560.pass sourceSha=699842e... checks=C01..C10
```

脚本使用独立 loop-data/daemon，未接触中央 daemon。观察到 lifecycle 场景同一 closure 从 iteration attempt 1 离开后 suspended，再以 attempt 2 原 worktree/session reopen；`C04.pass` 明确给出 `reopenedAttempt:2`。完整链路同时证明 `closure.lifecycle_changed` 的 `phase-left/phase-entered` 审计、最终 consumption 与对账。该脚本没有把六边变成独立事件，反而验证了当前复杂映射。

## B. 证据附录

### B1. RFC-1 冻结契约的边，而非事件数量

权威状态机是：create 进入 active；attempt 链内 run-exit→run-spawn 保持 active；suspend 为 active→suspended；reopen 为 suspended→active；active/suspended 均可 consume；consumed 后 GC（`v3/closure-lifecycle-decision.md:38-44`）。同文件把转移边定义为 observer 事件，把 gate 闭集保持不变（`:54,58`）。因此：

1. 六边包含两个不改变 lifecycle 字段值的 run 边；
2. consume 有两个 source state，却是同一语义边名；
3. “六边”不意味着六个 SQL update，也不天然意味着一边一 event record；
4. main 是否供给必须逐 producer 核对，不能按五类 `closure.*` 猜映射。

### B2. 六边逐项追踪

#### B2.1 create

**状态前后。** lazy 正常路径在 closure 不存在时创建 `active` closure。`spawnSchedulerRun` 先选 closure id、准备 worktree，然后调用 `recordRunWithClosureResources`（`src/scheduler.ts:1581-1607,1631-1638`）。store 的 `insertRun` 先调用 `ensureRuntimeClosure`；后者在同一 write transaction 内创建 seq root（若无）、leaf node、`task_closures(lifecycle='active', resources...)`、leaf association 与 seq cursor（`src/sqlite-state.ts:1643-1663,2292-2335`）。

**持久事实。** closure id、item row、phase、leaf identity、definition ref、active lifecycle、worktree/branch/baseCommit、created/updated time 与首条 running run 一起 commit。写封装是 SQLite immediate transaction（store `write`）；run 与 closure 不会在该调用内部半写。

**事件。** commit 返回后 scheduler 发 `closure.resource_prepared`，payload 为 closureId/worktree/branch/baseCommit/freshness（`src/scheduler.ts:1638`; `src/daemon.ts:833-842`; `src/observability.ts:355-360`）。它不是 create 专属：已有 closure 的 retry/reopen 每次也走同一位置。另一路 `createTaskTree` 可按输入 snapshot 直接 INSERT leaf closure，甚至允许 suspended/consumed 初态，只返回 snapshot而不 emit scheduler event（`src/sqlite-state.ts:1974-1980,2363-2402`）。

**事务/崩溃/重放。** DB commit 后到 JSONL append 前 crash 会留下 closure/run 而无 `resource_prepared`。反之 event 已 append 后后续 spawn preparation 失败，closure/run preparation事实仍可能存在并进入失败清理；事件不是“进程已 spawn”的证据。重启从 DB 读取 tree/run；不会回放缺失的 create event，startup reconciliation只发 `closure.reconciled` findings。

#### B2.2 run-spawn

**状态前后。** RFC-1 语义为 active→active。main 在 OS spawn 前已经：记录 `runs.status=running`、发 resource_prepared、必要时 reopen lifecycle、插入 `active_runs`、更新 item/run metadata与 artifacts（`src/scheduler.ts:1607-1685`）。真正 `spawn()` + `waitForChildSpawn()` 成功后 attach handler并再次写 current run PID，随后才发 `agent.spawn`（`:1699-1737`）。

**持久事实与 typed metadata。** `runs` 携 closureId/runtimeNodeId/phase；`active_runs` 以 closureId 为 PK，保证单活，并要求 closure active（`src/sqlite-state.ts:1945-1965`）。daemon 转换 run event 时经 `resolveSchedulerEventTaskIdentity` 加入 durable task identity；因此 `agent.spawn` 可带 closure identity，但事件 type 属 runner lifecycle，不是 `closure.*`。

**事件关系。** `closure.resource_prepared` 早于真实 spawn；`agent.spawn` 才表示 child spawn 成功。单次 run-spawn 可对应 resource_prepared + agent.spawn + phase.start 多条事件；spawn failure可只有 resource_prepared/诊断而没有 agent.spawn。故不存在稳定的一边一 closure 事件。

**崩溃/重放。** running run/active-run 在进程 spawn 前已持久化，形成准备窗口；startup recovery根据 DB/process facts处理 active run，但不会补发原 `agent.spawn`。JSONL append 独立于 DB，查询是历史读取，不是 replay consumer。

#### B2.3 run-exit

**状态前后。** child close 后先写 completion artifacts，再 `completeRun` 写 endedAt/exitCode/status，`clearCurrentRun` 删除 active run；closure此时仍 active。然后发 `agent.exit` 和 `phase.end`，再更新 item/backoff/session；只有满足 `runLeavesPhase` 才另行 suspend（`src/scheduler.ts:1992-2088,2089-2151`）。

**权威事实。** `runs` completion与 `active_runs` 删除是两个 store writes，不是与 agent.exit append 的共同 transaction。closure lifecycle 不记录 run-exit本身；run history才是该边的持久权威。

**事件关系。** `agent.exit` 带 runId/phase/exitCode/status/excerpt及 durable task identity；没有 `closure.run_exit`。同一个 exit可能随后产生 `closure.lifecycle_changed(suspend)`、queue.terminal、chain completion/consume；也可能都不产生。run-exit不能用 suspend或consume反推。

**崩溃/重放。** completeRun成功而 clearCurrentRun或event append前 crash，会由启动恢复面处理数据库残留；原 exit event不保证补发。event append后后续 item/session/suspend失败，又会留下“exit可见但后续边缺席”的合法故障窗口。

#### B2.4 suspend

**状态前后与 producer。** 两个生产点：进入新 phase 时先 suspend旧 phase closure（`src/scheduler.ts:1763-1768`）；run close满足 `runLeavesPhase` 时 suspend当前 closure（`:2146-2151`）。store验证不得有 active run，然后 transaction更新 lifecycle与updatedAt；不清 session/resources（`src/sqlite-state.ts:1985-1994`）。

**事件。** DB write返回后发同一 typed `closure.lifecycle_changed`：`from=active,to=suspended,reason=phase-left`。boundary只允许 active/suspended方向和两个reason（`src/observability.ts:361-366`）。这是六边中与现有 closure event最直接的映射。

**窗口/重放。** commit→append crash留下suspended但无事件；append失败不回滚状态。下一 tick看到已suspended不会重复执行 active→suspended，故缺失事件不会自动重放。重复调用store本身允许同态写，但scheduler guard只在active时发。

#### B2.5 reopen

**状态前后与 producer。** scheduler先根据“已有 closure + 有历史 phase run”把 worktree manager调用标成 `resourceState:"reopen"`，但这个标签也覆盖 lifecycle仍active的普通 retry（`src/scheduler.ts:1583-1596`），不是权威状态边。真正边由 `enterClosurePhase` 读取 persisted tree；仅在 suspended时调用 `setClosureLifecycle(kind=activate)`并发 `closure.lifecycle_changed(from=suspended,to=active,reason=phase-entered)`（`:1755-1774`）。资源/session原地保留。

**重要时序。** `recordRunWithClosureResources` 在 activate 之前执行，它允许 suspended closure记录 running run；随后 activate，再 `setCurrentRun`（后者要求 active）。因此 reopen不是单一 transaction：run row可先于 lifecycle active commit存在。该顺序也是不能从一条event推导完整metadata快照的直接证据。

**事件/未知。** 在当前合法运行历史，lifecycle_changed精确反映 suspended→active；但没有名为 reopen 的事件，也没有 RFC-1未来 `reopen(target)` consumer。显式 tree import或直接 lifecycle API造成的旁路是否应生成同类语义事件，main没有统一producer。DI-07所查结构化reopen authority不由本文推断。

#### B2.6 consume

**状态前后与producer。** outer completion或chain deletion调用 `consumeSchedulerClosure`。先 assess active-run/reachability；若可消费，`consumeClosureIfUnreachable`在一个 transaction内写 lifecycle=consumed、删 sessions、插入 pending `closure_consumption_intents`（`src/sqlite-state.ts:2021-2032,2117-2153`）。scheduler随后清理worktree/branch，发 `closure.consumed`，mark intent emitted，最后把resource tuple清null（`src/scheduler.ts:1489-1524`）。

**事件。** payload只有 closureId、evidence四词与origin freshness；daemon conversion不带item/phase（`src/daemon.ts:853-860`; `src/observability.ts:367-372`）。消费持久事实可从 closure + intent读取，event只是effect阶段的审计证据。

**事务/崩溃/重放。** pending intent使DB decision可在restart后继续；cleanup失败保留 consumed+resource tuple并返回 incomplete。emit成功而mark emitted前crash会重发，所以该事件是at-least-once；mark emitted后resource clear前crash则restart对账继续清理。`issue-560`隔离运行观察到cleanup retry最终只有一条事件，但代码窗口与既有intent测试不保证所有kill点exactly-once。

### B3. 五类 closure.* 的 producer/consumer全集

| type | producer | payload事实 | consumer/用途 | 是否六边 |
|---|---|---|---|---|
| `closure.resource_prepared` | scheduler每次run preparation | closure资源tuple + base freshness | daemon typed conversion→JSONL/log query/render/tests | create/spawn派生，多义 |
| `closure.lifecycle_changed` | phase enter/leave、run close | closureId + active/suspended from/to + reason | 同上 | suspend/reopen共用 |
| `closure.consumed` | consumption outbox effect | closureId + evidence/freshness | 同上；intent控制retry | consume相关，至少一次 |
| `closure.git_failed` | spawn preparation的typed Git failure | closureId + error code/text | 诊断/log/tests | 非转移边 |
| `closure.reconciled` | daemon startup/manual reconciliation findings | optional closureId + repo + mismatch/repaired | 对账/log/tests | 非转移边 |

类型词表在 `src/observability.ts:25-37`；scheduler union在 `src/scheduler.ts:241-247`；daemon conversion在 `src/daemon.ts:827-878`；daemon scheduler接线在 `src/daemon.ts:3728-3742`。消费者仅持久化/渲染/查询和测试；全仓没有 observer matcher/dispatch consumer。

### B4. typed metadata投影的实际边界

- closure snapshot持久字段：closureId、itemRowId/itemId、phase、lifecycle、worktreePath、branchName、baseCommit、sourceParNodeId、sessions（`src/sqlite-state.ts:2511-2516`）。
- run持久身份另含runId、closureId、runtimeNodeId、phase；active-run另表以closureId执法。
- event base可携chain/item/phase/runId与durable task identity，但五类closure事件各自payload是窄投影；特别是consumed/reconciled没有item/phase。
- 因此不存在“每条六边均携同一全量typed closure metadata”的生产事实。消费者若只读closure.*不能无损关联create/run边；若混读agent.*，仍需DB identity和时序窗口处理。

### B5. 测试：可保留资产、同错与盲区

**可保留资产。** observability boundary测试证明五类wire的typed parse/render；scheduler integration证明典型顺序包含resource_prepared→agent.spawn→agent.exit→lifecycle/consume；task-tree/store测试证明三态、single-active、pending intent与reachability；`scripts/issue-560-integration.ts`证明真实隔离daemon、Git、runner、restart/reconcile路径。

**同错。** 测试多以现有type名作为期望，因此只能证明当前五主题自洽，不能证明RFC-1六边齐备。把 `resource_prepared` 计作create、把 `agent.spawn/exit`当closure event、把phase-entered一概称业务reopen，都会与生产机制同错。

**盲区。** 没有测试枚举“六语义边×所有producer”并断言typed metadata；没有createTaskTree旁路事件覆盖；没有commit→append每个kill点；没有agent.spawn/exit缺事件后的replay；没有证明event stream可从零重建closure状态；consume emit→mark窗口只证明重试机制，不证明consumer去重。

### B6. 运行证据索引

- 命令：`bun scripts/issue-560-integration.ts > /tmp/r7-di03-issue560.jsonl 2> /tmp/r7-di03-issue560.stderr`。
- 结果：exit 0；run id `fd6f38f5-104c-4a84-9409-aa1afe51184f`；最终 `issue-560.pass`，source SHA与基线一致。
- 核心观察：`C04.pass` 的 closure `closure:4:iteration`，原worktree/session，`reopenedAttempt:2`；事件日志包含phase-left/phase-entered。`C05.C07.delete-retry.pass`记录consumption event 1与最终cleanup。证据目录由脚本输出为 `.coder-loop/evidence/issue-560/<run-id>`；脚本teardown后隔离runtime已清理。
- 限定：该脚本验证当前实现，不证明未来observer dispatch或统一payload；它也不把缺席的create/run-spawn/run-exit closure types变成已供给。

## C. 文件尾部核对

- [x] 固定main SHA `699842e...`，未改产品代码、测试、配置、WORKFLOW、生产DB，未建worktree，未碰中央daemon。
- [x] 逐create/run-spawn/run-exit/suspend/reopen/consume列出状态前后、producer、持久事实、event/payload、consumer、事务/崩溃窗口/重放。
- [x] 五类closure.*与六边逐项对账；未假定一边一事件。
- [x] 区分观察事实、直接机制、上游来源、历史原因、放大条件、消费者影响、根因集合与修补边界。
- [x] 记录测试可保留资产、同错和盲区，并运行隔离最小全链场景。
- [x] 未裁决、未新增需求、未设计observer/payload、未列补法/工作量、未重拆issue。
- [x] 剩余未知仅限未来RFC-1结构化reopen producer及未来observer消费协议；两者在main不存在，本文不猜测。
