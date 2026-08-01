# R7-DI-05 — daemon shutdown / pause / socket / scheduler 准入实然矩阵

固定证据基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只回答 `08-detail-investigation-index.md` 的 DI-05、`S2-U02`，以 A5/H3 为语境；不引入 `held` 状态、不裁决 gate、不提出需求或实现选择。

## A. 摘要（≤1 页）

### A1. 结论

1. **现有 `shutting_down` 窗口已具备“socket 仍可查询、scheduler 不再接受新 tick”的可观察组合，但不是查询专用准入态。** `stop()` 先同步把 daemon 置为 `shutting_down`，随后才等待 scheduler tick、终止 run、等待 close handler，最后才关闭 sockets/server/DB（`src/daemon.ts:1512-1562`）。窗口内 `daemon.status` 与 `chain.list` 实验成功；`daemon.status` 如实返回 `running=false, shuttingDown=true`。
2. **同一窗口内 mutation 没有 lifecycle gate，仍可写。** 请求路径只对 `starting` 特判，`shutting_down` 未被 `responseForLine` / dispatch 拒绝（`src/daemon.ts:1706-1721,1920-1932`）。隔离实验在该窗口成功执行 `chain.create` 与 `item.add`，持久化 active chain + queued item。因此现有机制不是“query allow / mutation deny”的 shutdown admission matrix。
3. **不新调度来自 scheduler 请求门，而不是 socket command admission。** `requestSchedulerTick()` 仅在 `state === "running" && pauseDepth===0` 执行（`src/daemon.ts:3620-3631`）；shutdown 先改 state，再调用 pause、清 timer 并等待当前 tick（`1512-1531,3646-3662`）。实验中 mutation 成功但 `agent.spawn` 计数保持 `1→1`。
4. **已有 pause 是 daemon-wide、嵌套计数、临时 mutation serialization；不是 point-local hold。** pause 清全局 interval、等待整次 in-flight tick，resume depth 到零才重启 timer 并主动 queue tick（`3646-3662`）。chain stop/delete/resume、queue unblock、item update/reorder 等复用它；create/add 则无需统一 lifecycle admission。它可证明“全局暂停调度”的机械边界，不能证明 A5/H3 的 per-decision/per-chain 语义。
5. **finalizing/close handler 是另一组 quiescence 资产。** run close 时 `finalizingItemStatuses` 暂存状态，close promise 进入 `pendingCloseHandlers`，chain completion 用 `finalizingChainIds` 单飞；shutdown 在关闭 SQLite 前循环等待 active runs 与 pending handlers 全空（`src/scheduler.ts:1992-2200,2683-2720`; `src/daemon.ts:1637-1647`）。这些结构防止 shutdown 与收尾写 DB 相撞，但不构成 socket lifecycle admission。
6. **根因集合（事实归纳，不是修补决定）：** R1 lifecycle state 未进入 command dispatch admission；R2 socket 的关闭顺序刻意晚于 quiescence，放大了 R1 的可写窗口；R3 scheduler gate 与 mutation gate 分离，故“mutation accepted but no subsequent scheduling”；R4 某些 mutation 各自 pause，而 create/add 依赖 tick request 的 state gate，准入口径不统一。

### A2. S2-U02 收敛

`S2-U02` 从“shutdown 边界未知”收敛为：**现有 shutdown 可在短暂 quiescence 窗口同时提供可查询 socket 与零新 scheduler spawn；但它也允许 mutation，且最终关闭 socket，因此不能把该窗口表述为稳定的 query-only 宿主态。** 后续若需判断某未来投影能否复用，只能在需求明确后逐命令重跑相同矩阵；本报告不作该判断。

### A3. 仍未知

- 正常负载下 shutdown 窗口长度不稳定；它取决于 in-flight tick、run termination grace 与 close/finalizer handler，不能由本实验量化。
- 所有 18 个 command 在 `shutting_down` 下的逐项实测尚未穷尽；静态 dispatch 表表明没有统一 lifecycle gate，但各 handler 仍可能因 chain/store 状态自行失败。方法：以同一 barrier 对 `DaemonCommandName` 闭集逐项发送合法请求，记录 response、DB diff、event diff、spawn diff。
- 进程在 shutdown 各阶段被 SIGKILL 后的每个 command 可见性未逐 kill-point 实测；现有 startup recovery 证据只覆盖孤儿 current-run/process 层，不等价于 mutation 原子性。

---

## B. 证据附录

### B1. 状态转换与关闭全调用链

| 阶段 | 状态 / 动作 | socket / store | scheduler / run | 证据 |
|---|---|---|---|---|
| start 前 | `starting` | 建目录、listen socket、open SQLite | 尚未 tick | `src/daemon.ts:1235-1254` |
| recovery | 仍 `starting` | socket 已 listen；请求仅显式拒绝 `starting` | stale recovery | `1239-1265,1706-1717` |
| running | `state="running"` | 所有 command 走 auth+handler | start interval + immediate queued tick | `1266-1275,1732-1766` |
| stop 入口 | 同步置 `shutting_down` | socket/server/store 仍在 | 后续 tick request 因 state 被 gate | `1512-1528,3620-3626` |
| drain tick | pauseDepth++、clear interval、await in-flight tick | commands 仍可 dispatch | 已进入的整次 tick先完成；不会续轮（loop 条件检查 running） | `1523-1531,3646-3678` |
| terminate | state 不变 | 仍可访问 | bounded terminate active runs | `1532-1545,2825-2840` |
| finalize | state 不变 | SQLite 必须保持 open | 等 active run 与 pending close handlers 全空 | `1547-1551,1637-1647` |
| close | `socket.end`→`server.close`→DB close→unlink | 新连接停止，已有连接结束 | 已静默 | `1553-1562,6114-6121` |
| exited | `state="exited"` | runtime socket/pid 删除 | stop 幂等返回 | `1513,1558-1562` |

`daemon.down` 并不直接设置状态：handler 先终止 runs并返回 `{shutdown:true}`；`handleLine` 写 response、end 当前 socket，再以 timer 调 `stop()`（`src/daemon.ts:1749-1759,1695-1703`）。直接 `stop()`/signal 路径则从 `1512` 进入。

### B2. command admission 实然矩阵

分类闭集来自 `buildDaemonCommandSpecs`（`src/daemon.ts:1732-1766`）；授权发生在 handler 前，但只区分 caller auth class，不读取 daemon lifecycle（`1920-1983`）。

| command 类 / 示例 | running | `shutting_down` 且 store/socket 未关 | exited | 是否会请求/恢复 scheduler |
|---|---|---|---|---|
| 状态查询 `daemon.status` | allow | **实验 allow**，显示 shuttingDown | socket 不可连接 | 否 |
| 数据查询 `chain.list/status`, `item.list/exits`, `logs.query` | 按 auth/参数 | `chain.list` **实验 allow**；静态无 lifecycle deny | socket 不可连接 | 否 |
| 直接 mutation `chain.create`, `item.add/batchAdd`, context append | 按 auth/参数 | `chain.create`、`item.add` **实验 allow 并写 DB** | socket 不可连接 | handler 可触发普通 tick 请求的路径仍被 state gate；无新 spawn |
| pause-wrapped mutation `chain.stop/delete/resume`, `queue.unblock`, `item.update/reorder`, exitAction stop | 按 auth/参数，先等 tick | 静态仍可进 handler；嵌套 pauseDepth，resume 因 state 非 running 不重启 | socket 不可连接 | `pauseSchedulerForMutation`; resume no-op on shutdown |
| `daemon.down` | allow operator / deny agent | 可再次进入；stop 自身幂等状态设置，但 handler仍会 terminate snapshot | socket 不可连接 | termination 后异步 stop |
| 新 scheduling | periodic/command aftermath可请求 | **deny（silent return）** | 无进程 | `state !== running` 或 pauseDepth>0 即 return |

注意：“静态无 lifecycle deny”只证明公共 gate 缺席，不证明每组每个合法请求必成功；chain transition、caller credential、preset load、DB constraints 仍是 handler-local gate。

### B3. scheduler pause / finalizing / close-handler 机制矩阵

| 机制 | 粒度 | 进入 | 退出 | 已证明作用 | 未证明 |
|---|---|---|---|---|---|
| `schedulerPauseDepth` | daemon-wide | mutation/shutdown；depth++、clear timer、await tick | callback once；depth--；running 且 0 才 restart+tick | 不与完整 tick 并发；可嵌套 | point-local hold、公平性、query-only admission |
| `state !== running` scheduler gate | daemon-wide | stop 首行 | 仅新 daemon start | 不接受新 tick/不续请求轮 | socket mutation deny |
| slot `activeRun` | chain×repo | spawn | close bookkeeping 中清 | 同 slot busy 抑制并发 run | shutdown admission |
| `finalizingItemStatuses` | item | close handler读到最终 status | handler finally | DB/close 窗口内 completion 看到有效 status | 持久 lifecycle state |
| `finalizingChainIds` | chain | completion check | finally | chain completion trigger single-flight | scheduler/global pause |
| `pendingCloseHandlers` | daemon state set | child close | promise finally | shutdown可等待收尾 promise | socket command隔离 |

来源：`src/scheduler.ts:463-472,492-540,1992-2200,2683-2720,2988-3024`。

### B4. 隔离运行实验

命令：`bun test /tmp/r7-di05-experiment.test.ts`（2026-07-30，Bun `1.3.14`）。fixture 使用独立 loop-data；通过 scheduler `slot.busy` event barrier 将一个 tick 悬停，调用 public `daemon.stop()` 后、释放 tick 前发送 socket 请求。记录：

```json
{
  "daemon": { "running": false, "shuttingDown": true, "activeRuns": 1 },
  "chain.list.ok": true,
  "chain.create.duringShutdown": { "status": "active" },
  "item.add.duringShutdown.ok": true,
  "agent.spawn.count": { "before": 1, "after100ms": 1 }
}
```

观察边界：测试日志同时出现 `daemon.stop`，随后 `chain.layout ... state=shutting_down` 与 `item.created ... status=queued`，证明 mutation 发生在 shutdown state，而 spawn 未增加。释放 barrier 后原 active run 被终止、close handler完成、daemon关闭。该实验没有添加 held/gate，也未触碰中央 daemon/生产 DB。fixture 的运行期资源由 harness teardown 清理；它不构成产品测试资产或绿色回归证明。

### B5. 并发、崩溃与恢复

- **并发序列：** stop 的 state 写是 await 前同步动作；因此与其后到达的 request 不会错过 scheduler state gate。但 socket request 和 terminate/finalize 仍可并行，因为 server 到 drain 末尾才关。
- **mutation 与 drain：** direct mutation 可以在 close handlers 正在读写同一 store 时执行；SQLite store 的同步操作避免 JS 语句级同时执行，却没有 daemon lifecycle 级业务隔离。pause-wrapped mutation会叠加 depth并等待同一 tick，但不等待所有 close handlers，除非其自身 terminate路径间接等待。
- **close handler：** active slot 在 close handler中早于部分 event/completion工作被清；`pendingCloseHandlers` 补充这一窗口，shutdown按两者循环等待后再关 DB（`src/scheduler.ts:2064-2077,2164-2199`; `src/daemon.ts:1637-1646`）。
- **异常 tick：** shutdown 捕获 pause 等待中 tick rejection并继续 drain（`src/daemon.ts:1527-1531`）；现有 integration 验证随后可重启（`tests/integration/daemon/shutdown.integration.ts:45-114`）。
- **进程崩溃：** clean stop 会删 socket/pid；外部 kill遗留物由 start recovery处理。该恢复对 shutdown窗口中新建 chain/item并不回滚：它们是已提交 SQLite事实。逐 kill-point 的 DB/event一致性仍未知，方法见 A3。

### B6. 测试资产、同错与盲区

| 资产 | 覆盖 | 同错 / 盲区 |
|---|---|---|
| `tests/integration/daemon/shutdown.integration.ts:4-43` | down、终止 active run、清 runtime files | 只在 down response 后观察；未在 `shutting_down` 窗口发 query/mutation |
| 同文件 `45-114` | in-flight tick rejection、shutdown继续、restart | barrier 存在但窗口内未测 command admission |
| 同文件 `117-159` | bounded terminate、无孤儿 | 未测 socket仍开放时的请求 |
| 同文件 `161-207` | pending chain-complete handler阻止 DB提前关闭 | 恰好制造长窗口，但只检查 closed flag与最终 chain状态 |
| `tests/integration/daemon/connection.integration.ts:136-168` | socket/pid与socket rebind | running态；不覆盖 shutdown admission |
| `tests/integration/daemon/admission.integration.ts:1121-1200` | caller auth class，含 daemon.down hard deny agent | 授权矩阵不是 lifecycle矩阵；两者可共同遗漏 shutting_down mutation |
| 本 DI-05 隔离实验 | status/query/direct mutation/spawn diff | 非 checked-in 测试；只抽样四类，不证明全 command闭集 |

共同盲区的机制：生产 dispatch 与多数测试均围绕 caller authorization/handler correctness组织，lifecycle state 只在 `starting` 前置检查；因此绿测、闭合 command union、符号 `shuttingDown` 都不能证明 query-only shutdown admission。

### B7. 历史、来源、放大条件、消费者、修补边界

- **历史来源：** `git blame` 显示 stop state骨架来自 `0c5f92e8`，pause 注释/机制来自 `7728e1ca`，shutdown tick rejection兜底来自 `b9f51512`；后续 #467 增加 bounded termination/close drain。历史解释来源，不提升为需求。
- **放大条件：** 长 in-flight tick、slow runner termination、slow chain-complete trigger/close handler会扩大 socket 可写窗口；空闲 daemon窗口可能短到客户端难以命中。
- **消费者：** CLI/socket clients消费 response；scheduler timer与mutation callbacks消费 pause/state；close handler与shutdown消费 active/pending/finalizing sets；startup recovery消费遗留 DB/runtime状态。
- **最窄事实边界（非方案）：** 若未来工作只需验证“可查且不新调度”，相关现存边界位于 `responseForLine/handleRequest`、`requestSchedulerTick/pauseSchedulerForMutation`、以及 stop 的 socket关闭顺序。chain/item业务逻辑、gate decision语义与持久化协议不属于本 DI 的可归因根因。是否改、如何改不在本报告裁决范围。

### B8. 证据索引与尾部

- 状态 ADT：`src/daemon.ts:399,1177`
- start/run transition：`src/daemon.ts:1235-1275`
- stop/drain/close：`src/daemon.ts:1512-1562,1637-1647`
- socket request sequencing：`src/daemon.ts:1660-1723`
- closed command/auth table：`src/daemon.ts:1732-1766,1920-1983`
- pause/tick gate：`src/daemon.ts:3608-3679`
- scheduler state/tick：`src/scheduler.ts:463-540`
- close/finalizing：`src/scheduler.ts:1992-2200,2683-2720,2988-3024`
- shutdown tests：`tests/integration/daemon/shutdown.integration.ts:4-250`

证据强度：运行观察 > 生产调用链 > integration asset > 历史。commit、类型闭集和绿测均未被当作 lifecycle 行为证明。
