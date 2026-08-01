# RFC #543 · R7-DI-06 decision/effect kill points 调查

> 固定基线：`main` @ `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一语义锚点：`08-detail-investigation-index.md` 的 R7-DI-06；`01-clauses.md` 的 J1–J3/J5；`07-supply-ledger.md` 的 S3-U01（上下文 S3-C05–C07/C09、S3-A03/A05、S3-T08、S3-R01–R04）。  
> 调查边界：只调查当前最接近的 closure consumption intent/outbox；相似状态名不被视为 future evaluation journal；本文不设计 journal schema、不裁决需求。

## A. 主 agent 摘要（≤1 页）

### 问题与结论

当前最接近 decision/effect 的生产路径不是四态 evaluation journal，而是两段式 closure consumption：

1. SQLite `BEGIN IMMEDIATE` 事务把 `task_closures.lifecycle='consumed'`、session 删除和一条 `pending` consumption intent 一起提交；
2. 事务外依次执行 Git cleanup、append `closure.consumed` event、把 intent 标 `emitted`、最后清空资源字段。

因此它只能提供 **“消费决定 + 引擎内 DB 状态 + durable pending intent”原子地基**，不能提供 J1–J3 的 evaluating/decided/consumed journal 或 decision 与全部 effect 同事务。Git 和事件文件都在 SQLite 事务外。

四类 kill point 对应到当前最近路径后的恢复事实是：

| 参照 kill point | 当前最近位置 | durable DB / 副作用 | 重启后实际推进 |
|---|---|---|---|
| evaluating | `assessClosureConsumption` 返回后、消费事务前 | closure 仍 active/suspended；session、resource 在；无 intent；0 event/0 cleanup | 没有 evaluating 行可恢复；只有调用者再次进入 completion/delete 才重新评估 |
| decision | `consumeClosureIfUnreachable` 提交后、cleanup 前 | closure consumed；session 已删；pending intent；resource 仍在；0 event/0 cleanup | completion tick 可再次调用并直接用保存 observation；chain-delete 请求本身没有 startup resume worker |
| effect | cleanup 或 event append 周围 | cleanup 可能已部分/全部发生而 DB resource 仍在；pending intent；event 可能 0 或 1 | cleanup 设计为可重试；若 kill 在 event append 后、mark 前，重试会再次 append，故 event 是 at-least-once、可重复 |
| consumed | intent 已标 emitted、resource clear 前/后 | emitted intent；event 已至少 1；resource 可能尚未清空或已 null | 再进入 consumer 不再 emit；会重试/收敛 cleanup 与 resource clear；startup reconciliation也能清 consumed 残留资源，但不承担 pending intent drain |

### 因果与影响

- **直接机制**：SQLite writer 使用 `db.transaction(fn).immediate()`；消费事务内部顺序是 lifecycle → sessions delete → pending intent。scheduler 外部顺序是 cleanup → emit → mark emitted → clear resource identity。
- **关键崩溃窗口**：event append 与 `mark emitted` 分离，故“事件已经存在但 intent 仍 pending”；重放会产生重复 event。反向窗口（marked emitted 但 event 不存在）只在 emit 返回成功却未真正 durable 的外部文件系统语义下可能，代码没有 fsync 协议证明。
- **恢复入口不统一**：outer-completion 会在活动 chain 的 scheduler tick 再进 consumer；delete cleanup 是 socket 请求路径，daemon 启动没有扫描 pending intents 的 outbox drainer。startup reconciliation只处理 Git/DB resource residue。
- **当前影响**：资源清理失败保留 durable identity 并返回 incomplete；重启 reconciliation 可回收 consumed residue。事件消费者必须容忍重复；不能假设一次。
- **未来影响/证明缺口**：这条路径没有 evaluation identity、epoch、decision body、判定执行身份、mutation key 或 evaluation scope，因此不能从恢复表现宣称 J1/J2/J3/J5 已满足。

### 可保留资产与边界

可作为 J1–J3/J5 地基的资产，仅限：

1. 通用 `BEGIN IMMEDIATE` writer 与异常回滚边界；
2. “主 DB 状态变化 + durable pending intent”同事务写法；
3. `already-consumed` 读取已保存 observation、避免重新采样的重放形态；
4. idempotent `mark...Emitted`、可重试 cleanup、resource identity 延迟清空；
5. startup reconciliation 对 consumed Git residue 的收敛能力；
6. typed event/evidence/freshness boundary。

不可直接复用为保证：两态 pending/emitted 不能冒充 J1 三态；event 文件不是 SQLite outbox；startup reconciliation 不是通用 consumer；event 次数不是 exactly-once；closure id 不是 evaluation scope；现有 `item.created` 也没有 J5 scope。

### 未知与下一步

精确 `SIGKILL` 落在 SQLite transaction 指令中无法由当前公开 API 确定性触发：实现没有 fault hook，按墙钟发 signal 只能得到不可复现采样。本轮因此使用已有可执行 reopen/cleanup/reconciliation场景验证可观察边界，并在附录给出确定性故障注入方案；**事务中间 kill 的 WAL/OS 级结果仍是未知**，不能由 SQLite 原子性静态推断替代实测。无需操作员裁决；若后续阶段要求把该未知消账，应先做隔离 fault harness，而不是改产品实现。

## B. 证据附录

### B1. 生产调用链穷尽

#### Writer / transaction

- 表：`src/sqlite-state.ts:745-753`，每 closure 至多一条 intent，状态仅 `pending|emitted`。
- 所有 store writes：`src/sqlite-state.ts:1605-1612`，`db.transaction(fn).immediate()`。
- consumption writer：`src/sqlite-state.ts:2021-2032`。
  - 先在同一 transaction 内重算 reachability；
  - `UPDATE task_closures ... consumed`；
  - `DELETE closure_sessions`；
  - `INSERT closure_consumption_intents ... pending`。
- intent insert：`src/sqlite-state.ts:2106-2115`；读取与 JSON boundary：`2090-2103`。
- emitted writer：`src/sqlite-state.ts:2034-2039`，独立 transaction；重复调用直接返回 emitted。

#### Consumer / effects / cleanup ordering

- 唯一 intent consumer：`src/scheduler.ts:1489-1524`。
- 事务前 observation sample：`src/scheduler.ts:1490-1497`；已经 consumed 且有 intent 时复用保存值。
- consumption DB commit：`1498-1502`。
- Git cleanup：`1505-1517`；失败立即返回 incomplete，尚未 emit/mark/clear。
- event append callback：`1519-1520`；随后独立 DB transaction mark emitted：`1521`。
- resource identity 最后清空：`1523`。
- event 最终落文件由 daemon callback接入：`src/daemon.ts:2854-2865` → `src/observability.ts:923-936`。

#### 两个生产入口与 restart

- normal outer completion：`src/scheduler.ts:2690-2719,2723-2749`；chain 只有所有 closure consumer 返回 complete 才标 completed。活动 chain 重启后 scheduler 可再次走此路径。
- operator chain deletion：`src/daemon.ts:2480-2530,2843-2876`；cleanup 属于请求处理。进程死后不会仅凭 pending intent 自动恢复该 socket 请求。
- 全仓只有 scheduler `1519-1521` 读取 pending 并 mark；`rg` 无 startup outbox scan/drain。
- startup reconciliation另有 consumed residue 回收：测试入口证明资源收敛，但它不读取/mark pending intent。

### B2. 四个 kill point：序列、行与次数

#### KP-EVALUATING：评估完成，消费 transaction 未开始

**对应位置**：`scheduler.ts:1490-1497` 后、`1498` 前。

**DB**：没有 current evaluation row；closure lifecycle、sessions、resources 不变；intent row 不存在。observation 只在内存。

**restart**：没有通用 recovery cursor。outer completion 若仍满足条件会重新 sample 与重新 assess；delete 则须新的 delete 操作进入。副作用和 event 均 0。

**与 J1 的边界**：此处最能证明当前资产不足——J1 要 spawn 前 write-ahead evaluating，当前路径完全没有相应 durable fact。

#### KP-DECISION：消费 transaction 已提交，任何外部 effect 前

**对应位置**：`scheduler.ts:1502` 返回后、`1505` 前。

**DB SQL 结果**：

```sql
task_closures.lifecycle = 'consumed';
closure_sessions = 0 rows for closure;
closure_consumption_intents.status = 'pending';
task_closures.worktree_path / branch_name remain non-NULL;
```

**次数**：cleanup 0，event 0。restart/re-entry 后 `assessClosureConsumption` 返回 `already-consumed` 并带 pending intent（`sqlite-state.ts:2122`）；consumer复用 intent observation（`scheduler.ts:1493-1497`），不重新采样 decision evidence。

**事务异常**：在 lifecycle update、session delete、intent insert任一步抛错时，`BEGIN IMMEDIATE` closure整体回滚；但本轮没有可确定性 SIGKILL hook，故只确认代码 transaction boundary，未把进程中止等同普通异常。

#### KP-EFFECT：外部 effect 进行中或刚完成

**cleanup 前/中 kill**：DB保持 consumed + pending + resource identity。Git可能无变化、部分变化或已清理；重试依靠持久化 identity检查/清理。cleanup返回错误时 consumer在`1516`提前退出，event 0，resource仍非 null。

**cleanup 后、event 前 kill**：Git effect 1，event 0，pending。重试会把已不存在/可 prune 的 owned registration再清理并继续。

**event append 后、mark 前 kill**：Git effect已收敛，事件文件已有 1 条，DB仍 pending。重试通过`1519`再次 append，所以最终 event **2 条或更多**；这是明确 at-least-once窗口，不是 exactly-once。

**mark 后、resource clear 前 kill**：DB emitted，event 1（正常文件 append语义），resource identity仍在。重试不 emit，只重试 cleanup并清 resource。

#### KP-CONSUMED：consumer全部步骤返回后

**DB**：lifecycle consumed；sessions空；intent emitted；worktree/branch null。**外部**：owned Git资源已清；event通常1。

再次调用时 decision为 already-consumed、intent emitted，cleanup因资源空跳过，event不追加，resource clear无变化。该“消费后重放静默”只适用于当前 closure evidence event，不证明未来 per-epoch decision 最多消费一次。

### B3. 清理失败、restart 与 reconciliation

- `tests/integration/scheduler/worktree.integration.ts:852-873` 构造 repo unavailable：调用返回 incomplete；DB已 consumed，resource identity保留。说明 cleanup失败不会丢定位资产。
- `:460-482` 构造 consumed lifecycle + 残留 worktree/branch，再跑 startup reconciliation：目录、registration、branch被删除。
- `:485-510` 同时证明 reconciliation 清理后把 DB resources置 null。
- 但 reconciliation不触碰 `closure_consumption_intents`，所以若唯一恢复动作只是 startup reconcile，pending event不会被 drain。normal scheduler completion再次运行时才有机会消费；delete路径没有自动 resume。

### B4. 实际执行证据

基线核对：

```text
pwd -> /Users/mouriya/Ext/code/coder-loop/v3-issue/n/543
git rev-parse HEAD -> 699842eba2eefc242d19f8fa9232bc1d9d5c3bdd
```

执行 1：

```sh
bun test tests/unit/sqlite-state/task-tree.test.ts \
  --test-name-pattern 'closure consumption intent survives reopen and is emitted once'
```

观察：1 pass。测试在首次 store 写 consumed+pending 后 close/reopen；reopen读取 already-consumed+pending；两次 mark只得到 emitted；再次 reopen仍 emitted（`tests/unit/sqlite-state/task-tree.test.ts:268-301`）。它验证 DB reopen 和 mark 幂等，不验证真实 event append次数。

执行 2：

```sh
bun test ./tests/integration/scheduler/worktree.integration.ts \
  --test-name-pattern 'serialized closure consumption removes only owned resources and emits evidence with freshness'
```

观察：1 pass。真实本地 Git worktree被删除；DB closure为 consumed/resources null/sessions空；捕获 1 个 `closure.consumed` event（`:901-924`）。它验证无故障顺序，不验证 kill window。

### B5. 确定性 fault harness（当前不可无侵入执行）

要把 OS kill 未知消账，最小可复现实验应在隔离 loop-data与fixture Git repo启动 child process，并以 test-only IPC barrier精确停在以下点后由 parent `SIGKILL`：

1. assess返回后；
2. `consumeClosureIfUnreachable`返回后；
3. cleanup返回后，以及 emit callback append返回后；
4. `markClosureConsumptionIntentEmitted`返回后与 `setClosureResources`返回后。

每次 parent 用 `bun:sqlite`只读查询上述三表，计数events JSONL，检查 worktree registration/branch/path，再启动同一 consumer入口。当前生产 API没有这些 barrier；靠 `setTimeout`/轮询文件无法保证kill落点，因此本轮没有伪装成真实 fault injection。此 harness可放隔离实验目录，但需要 test-only wrapper/子进程控制面；不得写入生产 daemon或中央 DB。

### B6. 测试同错、盲区与资产

**有效资产**：

- unit reopen测试证明 pending intent持久化与 mark幂等；
- real Git integration证明正常 cleanup/event/resource-clear次序；
- repo unavailable测试证明 incomplete与identity保留；
- reconciliation测试证明 consumed residue可收敛。

**同错/盲区**：

1. unit测试手工 mark emitted，没有真的调用 emit；其“emitted once”测试名不能证明 event一次。
2. integration只跑 happy path，events数组callback没有 durable append/kill窗口。
3. reconciliation测试以 `setClosureLifecycle`直接造 consumed，没有 pending intent，故看不到 outbox未 drain。
4. 无测试在 event append 后、mark前重放；重复 event风险由生产顺序直接成立。
5. 无测试用真正进程中止打断 SQLite transaction；普通 throw rollback不能证明 WAL/OS kill表现。
6. 所有现存资产均为 closure消费，不携带 evaluation scope/epoch/decision identity；状态名相近不能提升为 J1–J3/J5符合证据。

### B7. 分层因果账目

| 层 | 事实 |
|---|---|
| 观察 | consumed、pending intent可跨 reopen；cleanup可失败后保留identity；正常路径1 event |
| 直接机制 | 一个SQLite transaction写lifecycle/session/intent；事务外cleanup→emit→mark→clear |
| 上游来源 | reachability/active-run/authority决定 consumable；Git采样产生 evidence/freshness |
| 历史/形态 | closure lifecycle专用outbox，不是通用gate journal；两态intent服务审计event |
| 放大条件 | kill/emit失败/repo不可用；delete请求死后无自动resume；重复restart可重复event |
| 消费者 | scheduler completion、daemon delete cleanup、observability JSONL读者、startup reconciler |
| 根因集合 | SQLite与Git/event跨介质；无统一recovery worker；emit与mark分离；无evaluation identity |
| 修补边界 | 只补一次event去重不生成J1/J2/J3；只加journal表也不使Git/file effect进同事务 |

### B8. 证据索引与尾部

- Schema/transaction：`src/sqlite-state.ts:745-753,1605-1612,2021-2039,2090-2126`。
- Consumer/ordering：`src/scheduler.ts:1489-1524`。
- completion retry入口：`src/scheduler.ts:2690-2749`。
- delete入口：`src/daemon.ts:2480-2530,2843-2876`。
- event persistence：`src/daemon.ts:2325-2330,2854-2865`; `src/observability.ts:923-946`。
- Tests：`tests/unit/sqlite-state/task-tree.test.ts:268-301`; `tests/integration/scheduler/worktree.integration.ts:460-510,852-924`。

**收口结论**：现有 outbox最有价值的地基是“DB决定与pending intent同事务 + 重放复用保存观察 + 外部cleanup可收敛”；它同时实证了不能跨SQLite/Git/event宣称同事务或exactly-once。四态 journal、epoch、evaluation scope与统一restart consumer仍不存在；真实 transaction内 `SIGKILL`结果仍须确定性隔离harness验证。
