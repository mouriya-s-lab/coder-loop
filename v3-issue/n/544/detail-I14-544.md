# RFC #544 R7 / I14 — mutation 跨副作用、竞态与重试结果

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`，Bun 1.3.14 / macOS arm64。锚点仅为 AGG D8/F 四动作、R5 L30/L31/L33、R6 I14；主体与准入复用 I13，transport 复用 I05。本文只调查现状，不提出修法、选项、推荐、成本或 issue 拆分。

## A. 主 agent 摘要（≤一页）

**可证伪问题：** `queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder` 从 handler 到 DB、scheduler/child、event/audit、RPC 的真实顺序是什么；并发、断连、event/terminate/store fault 与重复调用后六类终态能否支持 D8“生效与审计”？

**结论（高置信，真实隔离 daemon + 明示 private fault 注入）：D8 目前只能承诺“每个 store 调用自身是 `BEGIN IMMEDIATE` 原子事务，且正常串行 happy path 最终可见”；不能承诺一个动作在 DB、进程、queue、event/audit、RPC 间原子、幂等或结果可判定。** 四 verb 没有共同 mutation commit：准入 audit 先于 handler；handler 内分别执行 1–2 个 store 事务、进程终止和 tolerant JSONL append，最后才构造 reply。不同 socket 并行，scheduler pause 只等当前 tick并以 depth 暂停新 tick，不是 mutation mutex。request `id`只回显、不持久化、不去重。

关键反例：真实 client 发完 `chain.stop`立即断开，DB仍变 stopped且 audit已写，client无结果；真实 event sink 变目录后 `chain.resume`仍 RPC success、DB active，但 main event/action audit均缺失且没有 failure event；test-only private terminate 注入在 DB stop 后抛错，RPC `internal_error`、DB已 stopped、只有准入 audit而没有 `chain.status`；I13 已证 agent cross-chain reorder 可 DB 已改而 RPC error。`queue.unblock`更分裂：item status与 `active_runs`删除是两个事务，且删除 current-run 不终止 scheduler 内存 run/child；它没有业务结果事件，只有准入 audit与成功分支的第二条 caller-admission audit。

并发实测：两条 stop得到一次真实 stop和一次 `alreadyStopped`; stop/resume可都成功、最终 active并产生两条相反 `chain.status`；同目标 reorder相同位置写两次、发两条 `item.reordered`，相反位置都成功、最终由后提交者决定；两条 concurrent unblock一条 changed、一条 not-unblockable，只有 changed 分支发第二条 audit。重复不是按 request identity重放原结果，而是重新观察当时状态；reorder即使最终不变仍报告成功并发 outcome audit。

**审计边界：** `privileged_op.caller_admission`只证明准入尝试，不证明动作生效；`chain.status`/`item.reordered`更接近 outcome，但 tolerant sink允许“生效且无记录”，stop terminate fault允许“生效且只有 admission”，unblock没有独立 mutation outcome event。现有 failure streams不接收这些 tolerant mutation append failures。RPC success不证明 JSONL，RPC error/断连不证明未生效。

**可保留资产：** command/auth dispatch、四 verb 参数与状态门、store 单方法 IMMEDIATE transaction、scheduler tick pause/depth、typed audit payload、正常 happy-path回包。**测试同错/盲区：** happy-path integration把 RPC success、DB终态和 event同轮出现视为一体；没有跨 socket相反动作、send后断连、event/terminate/store fault、request-id重放、unblock child仍活矩阵。资产未知：真实生产并发频率、断电 durability、仓外重试策略；未据此猜测。

## B. 完整调查

### B1. 共同 transport、调度与提交边界

```mermaid
sequenceDiagram
    participant C as client
    participant A as auth gate
    participant H as verb handler
    participant S as scheduler pause
    participant DB as SQLite store
    participant P as child/process close
    participant E as tolerant JSONL writer
    C->>A: one-line request(id, command, args)
    A->>E: privileged_op.caller_admission
    A->>H: allow
    H->>S: pause new ticks; await in-flight tick
    H->>DB: one or more independent IMMEDIATE transactions
    opt chain.stop
      H->>P: terminate active in-memory runs; await close pipeline
      P->>DB: complete run; clear active_runs (separate writes)
      P->>E: scheduler lifecycle events
    end
    H->>E: action audit (tolerant)
    H-->>C: reply written last
    Note over C,E: socket close does not cancel H; request id has no persistence/dedup role
```

- 同一连接以本地 `requestSequence`串行；每个 accepted socket各有一条链，所以不同连接可并行（`src/daemon.ts:1660-1697`）。reply只在 handler完成后 `socket.write`；close/error只删 socket set，不取消工作。
- auth gate在 handler前发 `privileged_op.caller_admission`（`:1920-1937`）；因此该 event是 admission，不是 commit marker。
- `pauseSchedulerForMutation`增加 depth、停 timer、等待 `schedulerTickInFlight`，返回的 closure在 depth归零后重新 tick（`:3646-3662`）。它没有等待/锁住另一个 mutation handler；实验的跨 socket动作确实重叠进入。
- store的每个 public write各自 `db.transaction(fn).immediate()`（`src/sqlite-state.ts:1605-1612`）。跨两个 store方法、process与JSONL没有外层事务。
- mutation action events走 tolerant `appendObservabilityEvent`，其 error由 wrapper吞掉；daemon随后仍 rendered stderr（I07 B4；`src/daemon.ts:2285-2294`）。三条 failure stream没有 mutation append接入。

### B2. 四个 verb 的精确时间线

#### `chain.stop`

1. gate写 admission；handler读取 chain快照；已 stopped则直接 `alreadyStopped:true`，无 action event。
2. active时 pause/await tick；`updateChain(stopped)`单事务提交；release decision fingerprint。
3. 从**内存 schedulerState**列 active runs，`Promise.all(run.terminate)`；每个 child close pipeline另行写 completion artifact、`runs`、`active_runs`并发 lifecycle events，最后内存 slot清空（daemon `:2554-2585,2820-2822`；scheduler `:2051-2072,2193-2208`）。
4. 全部 terminate fulfilled后 tolerant append `chain.status`，payload列 terminated run ids；构造 success reply；finally resume scheduler。

所以 DB chain先 stopped，child/run cleanup后到，action audit再后，RPC最后。任何后段失败不会回滚 chain。terminate `Promise.all`一个 reject即跳过 `chain.status`和success reply；其他 terminate promise仍可能继续。

#### `chain.resume`

1. gate admission；读取 chain；已 active直接 `alreadyActive:true`，无 action event。
2. stopped时 pause；单事务写 active；tolerant append `chain.status(stopped→active)`；success reply；finally恢复 scheduler并排 tick（`:2588-2610`）。

因此 RPC返回前DB已 active；但新 work实际 spawn只能发生在 finally重新排的异步 tick，RPC success不等于已有 child。event sink failure不阻断 reply。

#### `queue.unblock`

1. gate admission；解析 chain/issue；pause并等待 tick；加载 preset；读 item与 current runs。
2. 非 unblockable直接 success `changed:false`，没有第二条 action/caller audit。
3. changed分支先 `updateItem(entry status)`一个事务，再条件 `clearCurrentRun(runId)`另一个事务；**不调用 active run terminate，也不清内存 slot/child**（`:2739-2817`; store `:1762-1804,1971-1972`）。
4. tolerant append `item.mutation.caller_admission`（名字仍是准入，payload无 before/after）；返回 `changed:true`；finally重新 tick。

若第二个 store失败，item已 queued而 active_runs仍在；若 clear成功，schedulerState中的 active run和child仍可继续，后续 close还可写 run/item相关副作用。没有 `queue.unblocked`或等价 outcome event。

#### `item.reorder`

1. gate admission；handler在 pause**之前**解析 item、chain、caller subject。
2. pause后 `reorderItem`在单个 IMMEDIATE transaction中重编号整条 chain queue（store `:1806-1825`）。
3. DB提交后，为 agent subject才调用 `requireStoredRunTaskIdentity`构造 audit identity；I13 cross-chain反例就在此抛错，所以 DB已改而无 action event/RPC error。
4. tolerant append `item.reordered`，返回整条 items；finally恢复 scheduler（daemon `:3242-3277`）。

`position` event记录请求值，不是 clamp后的实际 index；同位置重复也重写全队列并发新 event，没有 no-op结果。

### B3. runtime 并发、断连、fault 与重复矩阵

所有真实路径均用隔离 `/tmp/coder-loop-544-I14-runtime-*`、scheduler disabled（除源码已证的 process链），真实 daemon socket与SQLite；没有访问生产 root。`terminate-fault`和`store-fault`是**明确的 test-only private point 注入**，只证明注入点前后控制流，不能冒充真实 OS terminate/SQLite fault注入。event fault是真实文件系统 EISDIR。I13 cross-chain reorder作为既有真实路径复用。

| 场景 | RPC | DB / queue | active run / child | main/failure event与action audit |
|---|---|---|---|---|
| concurrent stop×2 | 两个 success：一次 `alreadyStopped:false`、一次 true | stopped | 无 run fixture | 2 admission，1 `chain.status` |
| concurrent stop + resume | 两个 success | 最终 active（本轮stop先、resume后） | resume回包时尚无新spawn证明 | 2 admission，`active→stopped`与`stopped→active`各一 |
| concurrent reorder同位置 | 两个 success | 两次整队事务，最终同序 | 不适用 | 2 admission + 2 identical `item.reordered` |
| concurrent reorder 0 vs 2 | 两个 success | 最终 position 2（本轮后提交者） | 不适用 | 两条相反请求event；无冲突标记 |
| concurrent unblock×2 | 一 changed、一 not_unblockable | queued | fixture无child | 2 admission，仅changed有第二条caller audit |
| sequential retry unblock | 首次 changed，次次 success/no-op | queued | 同上 | 每次有admission；只有首次第二条audit |
| send stop后立即 destroy client | 客户端没有reply | stopped | 无 run fixture | admission + `chain.status`均存在 |
| real event sink EISDIR后 resume | **success** | active | tick随后才可能spawn | JSONL query失败/新audit缺失；stderr rendered；无failure-stream记录 |
| terminate private reject | `internal_error` | **stopped** | 注入在真正terminate前，故未执行 | admission存在，`chain.status`缺失 |
| daemon store private close | `internal_error` | 本轮无写；后续无法从该daemon store读 | 无改变证据 | admission已先写；无action event |
| I13 agent cross-chain reorder | `internal_error` | **目标queue已改** | 不适用 | allow admission；action audit缺失 |

相反请求结果不构成跨运行固定顺序：stop/resume都在pause前取快照，最终值由实际 store提交顺序与前置快照决定；矩阵证明二者可都success，不证明本机每轮必为active。SQLite IMMEDIATE序列化单次store事务，但不把前置读取、event或reply纳入序列化点。

### B4. 重试、RPC与“生效/审计”可陈述范围

| 观察 | 能证明 | 不能证明 |
|---|---|---|
| RPC success | handler走到return，所引用store调用已返回 | event JSONL成功；resume已spawn；跨断电durability |
| RPC typed error | 某一步抛错 | DB未改变（terminate/reorder反例）或child未收到signal |
| timeout/断连 | client没拿到完整reply | handler取消/未执行/未生效（disconnect-stop反例） |
| admission audit | gate处理过并allow/deny | handler生效或RPC交付 |
| `chain.status` / `item.reordered` | tolerant append在调用控制流上返回 | 稳定落盘（I07）；所有副作用作为同一commit完成 |
| 第二次 no-op | 重试时当前状态不再满足变化条件 | 与哪个原request相同、原request结果为何 |

request `id`只用于response envelope（`:1706-1721`）；store/audit没有 request id、expected version或dedup record。因而“重试”是新执行：stop/unblock可能转为 no-op，reorder会再写再审计，stop/resume相反动作可撤销前一动作。D8当前可陈述的最低事实是“正常串行 happy path中，四 handler各自按上表最终更新对应DB且尝试发审计”；不可陈述 exactly-once、all-or-nothing、error=未生效、success=已审计或断连后安全重试。

### B5. 八层因果、症状修补残留

1. **症状：** success无event、error但DB已改、断连后未知、重复event、相反动作双success、unblock current row与child分离。
2. **直接触发：** 后段event/terminate/identity失败，跨socket交错，reply前断连，或重发同verb。
3. **handler机制：** 每个verb手写不同的 DB→process→event→reply序列；早退分支又有不同审计集合。
4. **事务机制：** IMMEDIATE只包一个store方法；unblock明确调用两个事务，stop还跨child close pipeline。
5. **并发机制：** per-socket promise chain不跨socket；scheduler pause是tick barrier/depth，不是handler mutex或状态version gate。
6. **传播机制：** event writer tolerant；terminate/identity/store throw变RPC error但不补偿已提交DB；socket close不取消。
7. **identity机制：** request id不进入domain/store/event，服务端不能识别重试或回放原结果。
8. **保证影响：** D8的“生效与审计”只能逐副作用观察，不能成为一个可判定操作结果；status/events一致不由当前机制保证。

症状修补残留：只依赖 IMMEDIATE仍留下跨store/process/event；只看 admission audit把尝试误作结果；只让event抛错会把“success无audit”换成“error但DB已改”；只在client重试会让reorder重复audit、相反动作覆盖、断连结果仍未知；只把scheduler pause当锁会遗漏跨socket mutation并行；只检查最终DB会遗漏旧child和审计缺口。此处仅登记残留，不提出修法。

### B6. 测试同错、资产与未知

- **同错：** 现有 happy-path integration分别断言 response、DB和events，但没有在中间副作用注错；这证明全部成功时能同现，不证明一个commit。store unit只验证每个mutator自身transaction，与D8跨层原子性不是同一范围。
- **盲区：** 四verb跨socket同/反向矩阵、send后断连、event sink/terminate/store fault、request-id重复、unblock带真实child、部分 terminate 多run rejection、reply write error均无现存回归。
- **可保留资产：** 单mutator IMMEDIATE、queue reorder单事务重编号、tick barrier、stop await run terminator、typed event payload和明确early-result shape；均不越界为跨副作用保证。
- **未知：** 生产并发/重试频率；真实 child signal failure发生时 close promise终态；SQLite进程崩溃/磁盘故障的具体状态；断电持久性；仓外消费者如何解释 timeout/error。未运行故障文件系统或power-cut，不猜。

### B7. 证据索引与清理

| 证据 | 路径/命令 | 证明范围 |
|---|---|---|
| E1 runtime矩阵 | `bun /tmp/coder-loop-544-I14-experiment.ts > /tmp/coder-loop-544-I14-results.json 2>/tmp/coder-loop-544-I14-stderr.log` | 真实isolated socket并发/断连/EISDIR；明示private terminate/store fault |
| E2 精简读面 | `/tmp/coder-loop-544-I14-summary.json` | 逐场RPC、DB/queue、events对账（首轮摘要；完整结果以E1最终文件为准） |
| E3 transport/dispatch | `src/daemon.ts:1660-1722,1920-1937`；I05/I13 | per-socket序列、reply顺序、准入边界 |
| E4 四handlers | `src/daemon.ts:2554-2610,2739-2822,3242-3277` | verb逐步顺序 |
| E5 store transactions | `src/sqlite-state.ts:1605-1612,1713-1734,1762-1825,1971-1972` | 单方法IMMEDIATE及unblock双事务 |
| E6 scheduler/process | `src/scheduler.ts:2051-2072,2193-2208` | child close后的run/current/in-memory次序 |
| E7 event传播 | `src/daemon.ts:2285-2333`；I07 | tolerant action append与failure流边界 |
| E8 cross-chain反例 | I13 B4 | reorder DB先写后identity error |

实验结束由每个 fixture `daemon.stop()`并递归删除其 `/tmp/coder-loop-544-I14-runtime-*` root；最终检查无残留 runtime root。保留的 `/tmp/coder-loop-544-I14-{experiment.ts,results.json,stderr.log,summary.json}`仅为报告证据。未创建 worktree，未修改产品、测试、配置或生产 loop-data。
