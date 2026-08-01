# RFC #543 · R7-DI-01 observer 子进程故障、进程组与 daemon 生命周期事实

> 调查基线：`main` `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只调查现有 runner/process 与 daemon 生命周期；没有实现 observer、没有修改产品代码/测试/配置/生产数据库，也没有启动或接触中央 daemon。

## A. 主 agent 摘要（≤1 页）

### 结论与置信度

**高置信：现有设施提供了若干经过真实进程测试的局部地基，但不存在可直接复用为 observer 的公共执行边界。** 可保留的是机制资产，不是 agent executor 整体：

1. POSIX 上 `detached: true` 建立独立进程组、向 `-pid` 发信号、失败时退回 leader kill 的模式；
2. `SIGTERM → bounded grace → SIGKILL → await close` 的异步回收序列；
3. spawn 前后分界、准备失败的资源清理、close handler 排空，以及退出事实/摘录的异步持久化经验；
4. daemon clean stop 先封住调度、终止 active runs、排空 close handlers、最后关闭 SQLite；crash 后以持久化 PID/进程组事实清除 stale group 并把未结束 run 标为 orphaned。

**不能作为地基的边界：** `SchedulerActiveRun`、slot/current-run/closure、attempt/backoff/session/credential、item status、agent 事件名称及 daemon startup orphan reconciliation 的整套语义都绑定 agent run。observer 当前没有 registry、durable row、shutdown ownership、restart policy 或 diagnostic producer；从形态相似不能推出共享。

### 因果链

- agent spawn 在持久化 run/current-run 后以 Node `spawn(..., detached: true)` 启动；spawn 成功后才安装 close/lifecycle handler并再次写入 PID。
- slow runner 不阻塞 scheduler tick：active run 进入 slot，后续 tick 看到 busy；但 runner 生命周期由 attempt/startup-idle/recycle timers 管理，不是通用 fire-and-forget dispatcher。
- nonzero/被信号终止都汇合到 `close`，`code ?? 1`；完成 run、清 active row、发 `agent.exit/phase.end`，再做 agent-specific backoff/phase/chain 处理。
- spawn/准备失败被 containment 捕获，完成已建 run、清 active row/slot、撤销凭证、写 `spawn.aborted` 与 backoff；兄弟 chain/item 可继续。
- clean daemon stop 拥有 active-run handle，故能做 bounded group termination；`SIGKILL` daemon 绕过此路径，child 当下成为 orphan，只有下一次 startup 依据 DB PID 才尝试回收。
- 恢复是多事务补偿，不是 run-complete 与 active-row-clear 的单事务提交；startup 扫描所有 `endedAt=null` run，kill 后再 `completeRun`，因而能收敛若干 crash 窗口，但不提供 observer 所需的 delivery/retry 语义。

### 消费者影响与可保留资产

- 对未来异步 observer，调度“不 await 脚本完成”不能借用 slot semantics 来证明；需要自己的启动/登记/诊断边界，否则 slow observer 仍可能在事件 writer 上造成背压。
- failure diagnostic 可借鉴现有 typed lifecycle event + persistence-failure fallback 的分层，但现有 `spawn.aborted`、`attempt.timeout`、`agent.exit` 都不是 observer diagnostic。
- 进程组回收模式可抽象为领域无关的 async subprocess primitive；daemon clean stop/restart 只能在 observer child 被明确登记或持久化时承接，否则当前 active-run registry 看不见它。
- G5 可据现状固定为：agent热路径使用异步 `spawn`；仓内 `spawnSync` 仍用于 `ps`/迁移/CLI 等，不能用“全仓无 spawnSync”作为 observer 证明。

### 未知、裁决与复查

- **未知：** observer 是否应在 daemon crash 后被 startup 杀、允许自然完成、或被忽略/重派；当前事实不能产生该需求。
- **未知：** observer 是否需要持久化 child PID/PGID、clean-stop registry，以及 diagnostic 写失败时的降级面。
- **未知：** macOS 已验证负 PGID 信号机制；Windows 只退回 leader kill，孙进程回收能力未证。
- **需 R8 裁决：是。** 需裁决 observer child ownership/restart policy 与 diagnostic durability；本报告不列实现选项。
- **需实现后复查：是。** 真实 observer 路径出现后必须重跑 slow/nonzero/timeout/spawn-failure/孙进程/daemon `SIGKILL` 矩阵，不能以本轮 agent 测试替代。

---

## B. 证据附录

### B1. 调查范围与穷尽方法

检索生产与测试中的 `Bun.spawn`、Node `spawn`、`spawnSync`、`process.kill`、`detached`、`SIGTERM`、`SIGKILL`、shutdown/recovery/close。与 DI-01 有直接生命周期关系的生产调用链归为三组：

1. scheduler agent run：`src/scheduler.ts`；
2. legacy chain-complete agent executor：`src/loop.ts`；
3. daemon 自身启动、停止、startup orphan recovery：`src/loop.ts`、`src/daemon.ts`。

其他 spawn 调用（git 校验、CLI 启 daemon、test runner、integration harness）只作调用者清单，不冒充 observer 地基。observer 声明/事件记录路径仍无 spawn caller，证据沿用 `04-supply-observer-payload.md` 的无调用者结论。

### B2. 全调用链

#### B2.1 scheduler agent run

1. scheduler 先创建 closure/run/current-run 并更新 item attempt/phase（`src/scheduler.ts:1607-1656`）。
2. 构造 invocation、artifact、credential；绝对 binary 缺失在 spawn 前抛错（`src/scheduler.ts:1675-1698`）。
3. Node `spawn` 使用 `stdio=[ignore,pipe,pipe]`、`detached:true`；`waitForChildSpawn` 明确在 `spawn` 与 `error` 间裁决（`src/scheduler.ts:1699-1706,1797-1809`）。
4. 成功后 attach close handler、登记 slot active run、把 PID 与 `processGroupLeader:true` 写 active row，然后发 spawn/start（`src/scheduler.ts:1706-1738`）。
5. stdout/stderr 流式落盘；`error` 写 stderr；`close` 是唯一正常完成入口（`src/scheduler.ts:1965-1996`）。
6. close 取 `code ?? 1`，关闭 writer，写 status artifact，`completeRun` 后 `clearCurrentRun`，再发 exit/end；随后处理 session、backoff、phase、chain（`src/scheduler.ts:1992-2165`）。
7. close async 尾部进入 `pendingCloseHandlers` 集合，供 scheduler/daemon quiescence 等待（`src/scheduler.ts:2192-2199`）。
8. 显式 terminate 是幂等的一次 `SIGTERM`，等待 close 到 grace，仍活则 `SIGKILL`，最终仍 await close（`src/scheduler.ts:2568-2583`）。
9. 信号优先发给 `-pid` 进程组，失败再 leader kill（`src/scheduler.ts:2586-2601`）。

#### B2.2 timeout/recycle 的直接机制

- absolute attempt timeout：到时向 group 发 SIGTERM、发 timeout lifecycle event；grace 后仍未 close 则 SIGKILL（`src/scheduler.ts:2335-2348`）。
- startup idle watchdog：只观察 stdout 字节阈值，超时同样 TERM→KILL（`src/scheduler.ts:2352-2402`）。
- agent 已写状态后的 recycle：取消 attempt timer，窗口结束直接 SIGKILL group；close 时区分 natural exit/timeout kill（`src/scheduler.ts:2404-2459`）。
- timer event persistence failure被独立上报，但不跳过信号动作；聚焦集成测试真实验证此顺序（`tests/integration/scheduler/core.integration.ts:93-181`）。

#### B2.3 preparation/spawn failure

- 所有 preparation 错误进入统一 catch（`src/scheduler.ts:1740-1751`）。
- 若 child 已启动，调用 `abortPreparation({forceAfterMs:1000})`；否则撤销已 mint credential；已建 run 写失败 completion artifact、标 exit 1、清 active row/recycle trigger/slot（`src/scheduler.ts:1819-1882`）。
- item entry status 被恢复并写 spawn-error/backoff，发 `spawn.aborted`（`src/scheduler.ts:1885-1917`）。
- 运行测试覆盖 artifact/prompt/credential/process-spawn/已启动 child 后 event failure；缺 binary 时 PID 不存在，已启动 child 则 PID 被实际探测为死亡（`tests/integration/scheduler/core.integration.ts:300-381`）。

#### B2.4 daemon clean stop

1. `daemon.down` 返回 shutdown 后异步调用 `stop()`；OS SIGTERM/SIGINT/SIGQUIT handler 也调用相同路径（`src/daemon.ts:1698-1702`; `src/loop.ts:3743-3782`）。
2. `stop()` 先切 `shutting_down`、记录 stop，再 pause scheduler：清 interval、等待 in-flight tick，pause depth 阻止新 tick（`src/daemon.ts:1512-1531,3646-3662`）。
3. 停 socket monitor；对内存 active runs 并行 terminate，单个失败只写 stderr 不阻塞全局 shutdown（`src/daemon.ts:1532-1545,2825-2840`）。
4. 等 active runs 与 pending close handlers 都为空；才 end sockets、close server、close SQLite、删自有 socket/pid 文件（`src/daemon.ts:1547-1562,1637-1657`）。

#### B2.5 daemon crash 与 startup recovery

- fatal exception/rejection handler只同步写 fatal 并 `process.exit(1)`；外部 SIGKILL 无 handler。两者都不会运行 active-run terminate（`src/loop.ts:3784-3793`）。
- startup 扫 `endedAt=null` runs，从 active/run extra 取 PID；若有 PID，先 `terminateStaleProcessGroup`，再把 run 标 `exitCode=-1,status=orphaned`（`src/daemon.ts:2400-2419`）。
- stale termination先 TERM，等待 `min(shutdownGraceMs, recovery force window)`，仍活再 KILL（`src/daemon.ts:4877-4883`）。
- 为避免误杀，stored PID 的当前 PGID、目标 PGID与 daemon PGID经 `ps` 检查；只有目标 PID 是 group leader且不与 daemon 同组才发 `-pid`，否则退回 PID（`src/daemon.ts:4885-4935`）。此检查本身使用 `Bun.spawnSync(ps)`（`src/daemon.ts:4913-4918`）。

#### B2.6 legacy executor 与其他 callers

- `src/loop.ts:6448-6527` 的 legacy chain-complete executor也用 detached group、TERM→KILL timeout，但拥有自己的 status/log/event结构，和 scheduler 已经是两套实现；这正是“形似不等于公共层”的直接证据。
- daemon CLI `start` 以 detached/unref 启 daemon（`src/loop.ts:3892-3909`），它管理 daemon 本身，不管理 agent/observer children。
- `git check-ref-format` 用 async `Bun.spawn`（`src/daemon.ts:4778`）；SQLite migration/PGID probe/若干 CLI 边界存在 `spawnSync`（如 `src/sqlite-state.ts:1189`, `src/daemon.ts:4914`, `src/loop.ts:3678,4349`）。它们不在未来 observer 热路径，但证明 G5 不能扩大成全仓禁令。

### B3. 逐故障场景事实

| 场景 | 真实观察 | 直接机制 | 对 observer 地基的资格 |
|---|---|---|---|
| slow | active agent 不阻塞 daemon；slot busy，timeout/stop 可回收。 | child handle + timers + async close。 | 异步 spawn/handle 可参考；slot/attempt 不可搬用。 |
| nonzero | `exitCode=7` 原样持久化并出 phase.end；item status不由 exit code直接推导。 | close handler `code ?? 1`。 | exit capture/diagnostic素材可留；agent phase/backoff不可留。 |
| timeout | TERM 后 KILL，最终 exit 1；timeout event persistence failure不阻止 kill。 | lifecycle timers + group signal。 | 回收 primitive可留；attempt/recycle分类不可留。 |
| spawn failure | 无 child PID；已建 run被标 exit 1，active row/slot清除，`spawn.aborted`并退避；兄弟可继续。 | waitForChildSpawn + preparation containment。 | spawn/error分界与cleanup模式可留；backoff/retry语义不可留。 |
| spawn 后 preparation failure | 已启动 PID被 TERM/KILL并确认消失。 | abortPreparation复用 terminator。 | 对“登记后失败仍回收”有价值。 |
| 孙进程 | 生产代码明确以 detached PID为 PGID并向负 PID发信号；现有聚焦测试只探测 leader，不显式记录孙 PID。 | POSIX process group。 | **条件资格**；需要 observer 实现后以孙 PID实测补证。 |
| clean daemon stop | active agent被 bounded terminate；PID 0 probe失败、DB active row清除；shutdown等 close handler后关库。 | 内存 active registry + quiescence。 | 只有未来 observer纳入明确 registry/ownership后才可承接。 |
| daemon SIGKILL | 当前 agent立即失去 daemon owner；restart scan stale DB事实并回收旧 group、标 orphan，再可调度新 run。 | durable run/PID + startup compensation。 | 不能自动覆盖无 durable row 的 observer。 |

### B4. 本轮运行观察

#### B4.1 命令

```sh
cd /Users/mouriya/Ext/code/coder-loop
bun test \
  ./tests/integration/daemon/shutdown.integration.ts \
  ./tests/integration/daemon/startup-recovery.integration.ts \
  ./tests/integration/daemon/runs-observability.integration.ts \
  ./tests/integration/scheduler/core.integration.ts \
  ./tests/integration/scheduler/session-resume.integration.ts
```

结果：`99 pass, 0 fail, 987 expect() calls, 43.30s`。测试全部使用仓内隔离 evidence/loop-data fixture；未接触中央 daemon。

#### B4.2 可归因观察

- shutdown 测试实际记录 agent PID，down 后 signal-0 探测为死亡；terminated run exit 1且 current run为空（`tests/integration/daemon/shutdown.integration.ts:117-155`）。
- timeout fixture把 500ms runner置于100ms timeout/10ms grace，观察 `agent.exit=1`（`tests/integration/daemon/runs-observability.integration.ts:1359-1387`）。
- nonzero fixture观察 phase.end/run均保存 7（`tests/integration/daemon/runs-observability.integration.ts:4-34`）。
- spawn/preparation矩阵观察 run exit 1、active row/slot为空、spawn.aborted；已启动 child PID消失（`tests/integration/scheduler/core.integration.ts:300-381`）。
- startup recovery fixture真实启动 detached stale process并观察其退出，同时保持 item业务字段，清 active row（`tests/integration/daemon/startup-recovery.integration.ts:143-230`）。
- orphan non-current run也被 group回收并标 orphaned（`tests/integration/daemon/startup-recovery.integration.ts:337-401`）。

### B5. 并发、事务与崩溃窗口

#### B5.1 event-loop 并发边界

- scheduler pause只保证 daemon内等待当前 tick并阻止新 tick，不暂停 child close事件；因此 shutdown必须另等 pending close handlers（`src/daemon.ts:1523-1551`）。
- close handler在首个 await 前同步设置 rate-limit/finalizing等内存门，再做 artifact/DB/event写；这是 agent-specific并发收口（`src/scheduler.ts:2019-2035`）。
- slow child不是 awaited tick任务；但 spawn准备本身以及 event sink仍在 tick内 await。未来 observer若在 event writer await spawn/stdio准备，仍可能拉长 writer，不能由 agent slot测试反证。

#### B5.2 SQLite 原子性与补偿

- store每个公开 write独立包在 `db.transaction(fn).immediate()`（`src/sqlite-state.ts:1605-1611`）。
- spawn准备的 run insert、active set、item update、spawn、PID active update不是一个事务；任何点失败靠 cleanup补偿（`src/scheduler.ts:1607-1751`）。
- close的 `completeRun` 与 `clearCurrentRun`是两个独立 immediate transactions（调用 `src/scheduler.ts:2051-2066`；实现 `src/sqlite-state.ts:1926-1972`）。在两者之间 crash时，startup以 `endedAt=null` 扫描不会选已完成 run，而 stale active row通过 task/run关联的完整清理边界本轮未单独注入；这是现有测试盲区，不能声称全 crash point原子。
- 相反，在 run仍未完成的 crash窗口，startup明确扫 `endedAt=null`，kill group、标 orphaned；已有 SIGKILL/restart测试验证重新出现新 active run，但测试 teardown自行 kill收集到的 PID，未单独断言旧孙进程数（`tests/integration/scheduler/daemon-restart.integration.ts:511-587`）。

### B6. 上游来源与历史原因

本节只记录 git可核对的历史动机，不把 commit/issue号当设计证明：

- `8a88372` / PR #472（源改动 #467）：clean stop从等待自然完成改为 bounded terminate；源码注释明确此前 daemon退出时 detached agents会成为 orphan（`src/daemon.ts:2825-2829`）。
- `575177e` / PR #525（#508）：startup recovery被收缩为 process-layer cleanup，不改 item业务字段；因此 recovery可作为进程补偿经验，但不是业务重试语义。
- `91fcec7` / PR #500（#452）：废弃 stdout summary作为完成信号，引入状态写后 recycle zone；说明现有 GC触发与 agent协议强绑定。
- `968d3b8` / PR #522（#462）：加入 startup-idle watchdog，仅stdout进度解除；同样是 agent runner领域策略，不是通用 subprocess timeout。

### B7. 根因集合与放大条件

#### 已证根因

1. **领域耦合：** process primitive内嵌 scheduler run、item、phase、credential、session、backoff、closure与事件类型，没有公共 executor接口。
2. **ownership缺席：** observer没有 child registry/durable PID/PGID；daemon stop/recovery只能看到 agent active runs。
3. **两套相似实现：** scheduler与legacy executor分别实现 group timeout，说明相似性尚未形成单一可复用边界。
4. **恢复是补偿式：** 多个 immediate transaction之间存在 crash窗口，recovery按未结束 run扫描；这不是通用异步任务 journal。

#### 放大条件

- observer脚本 fork孙进程、忽略 TERM或继承stdio；若无独立 PGID与KILL升级，会留下进程/管道。
- daemon被 SIGKILL而非 clean stop；任何仅内存 registry消失。
- spawn后、PID持久化前崩溃；startup无可靠 PID来源。
- diagnostic writer失败；若失败处理与 child回收互相 await，可能反向阻塞事件生产。
- Windows或非 group-leader child；现有 fallback仅杀 leader。

### B8. 测试同错、盲区与可保留资产

#### 有效证明

- 真实 subprocess、真实信号、真实 SQLite fixture的99项聚焦测试证明agent路径在当前平台的局部行为。
- timeout diagnostic sink失败不妨碍kill，证明副作用与诊断失败可分离。
- preparation failure后兄弟调度继续，证明containment边界不会必然污染全 scheduler。
- clean stop排空close handler后关库，证明shutdown顺序资产。

#### 同错/不可外推

- 所有生命周期 fixture调用agent scheduler，因此共享agent-specific slot/run/status模型；它们不能证明observer异步旁路。
- 多数kill断言只探测leader PID；“发了负PID”与“所有孙进程均消失”不是同一证据。
- crash/restart测试证明可重新调度，不证明observer不重试、也未统计side effect次数。
- timer测试使用短测试参数；能证明顺序，不证明未来observer timeout默认值。

#### 明确盲区

1. 记录 leader/child/grandchild PID、PGID，并分别验证 TERM响应与KILL后残留。
2. daemon在 observer spawn前、spawn后未登记、登记后、diagnostic前后被SIGKILL的矩阵。
3. `completeRun`与`clearCurrentRun`之间kill的孤立DB终态。
4. Windows孙进程回收。
5. observer stdin写入期间child早退/EPIPE、超大payload/backpressure。

### B9. 修补边界（非方案、非裁决）

- 可以保留：async spawn、spawn/error握手、detached PGID信号、TERM/KILL grace、close等待、流式摘录、diagnostic失败不阻止回收、shutdown quiescence的机制性质。
- 必须隔离：agent item/phase/closure/slot/current-run、credential/session、attempt/recycle/backoff、agent事件词表。
- 不得假定：observer持久化、重试、daemon crash ownership、diagnostic durability、并发上限。
- observer实现出现前，本报告不能把任何 agent函数直接命名为共同执行层；实现后必须由真实observer调用链与故障实验重新取得资格。

### B10. 未知的确定调查方法

若 R8裁决后进入实现验证，使用独立 `--loop-data-root` 与脚本PID日志：脚本写 leader PID/PGID，fork一个忽略TERM的孙进程写PID/PGID；逐场景触发并以 `ps -o pid,ppid,pgid,state,command -p ...`、`kill -0`、事件文件和SQLite查询记录 before/after。daemon crash用隔离 daemon PID `SIGKILL`，不得触碰中央 daemon；重启同一隔离root，核对是否回收/重派及diagnostic次数。spawn failure同时覆盖不存在binary与权限拒绝。无法在Windows执行时保留平台未知，不从POSIX结果类推。

### B11. 证据索引

| 事实 | 位置 |
|---|---|
| agent detached spawn / PID持久化 | `src/scheduler.ts:1699-1738` |
| spawn/error握手 | `src/scheduler.ts:1797-1809` |
| preparation containment | `src/scheduler.ts:1819-1917` |
| close与run/current清理 | `src/scheduler.ts:1965-2199` |
| attempt/startup/recycle timers | `src/scheduler.ts:2295-2459` |
| group terminate primitive | `src/scheduler.ts:2568-2601` |
| daemon stop顺序 | `src/daemon.ts:1512-1562` |
| quiescence | `src/daemon.ts:1637-1647` |
| startup orphan recovery | `src/daemon.ts:2400-2430` |
| stale PGID safety/kill | `src/daemon.ts:4877-4935` |
| signal/fatal handler | `src/loop.ts:3743-3833` |
| legacy第二套executor | `src/loop.ts:6448-6527` |
| 每write immediate事务 | `src/sqlite-state.ts:1605-1611` |
| complete/clear独立事务 | `src/sqlite-state.ts:1926-1972` |
| shutdown runtime证据 | `tests/integration/daemon/shutdown.integration.ts:4-207` |
| recovery runtime证据 | `tests/integration/daemon/startup-recovery.integration.ts:143-401` |
| timeout/nonzero证据 | `tests/integration/daemon/runs-observability.integration.ts:4-34,1297-1387` |
| spawn failure/active child cleanup | `tests/integration/scheduler/core.integration.ts:300-381` |
| crash/restart证据与盲区 | `tests/integration/scheduler/daemon-restart.integration.ts:511-587` |

## C. 文件尾部核对

- [x] 仅调查 R7-DI-01；未实现 observer，未新增需求、选项、推荐、PR/行数估算。
- [x] 固定基线为 `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- [x] 穷尽并分类相关 spawn/kill/process-group/shutdown/recovery caller；没有把相似 agent executor当成已可复用层。
- [x] 覆盖 slow/nonzero/timeout/spawn failure、孙进程证据边界、clean stop、daemon crash/restart、PID/信号/退出/残留。
- [x] 记录事务并发/恢复窗口、测试有效证明/同错/盲区与可保留资产。
- [x] 运行实验只使用仓内隔离 fixture；99 pass / 0 fail；未触碰中央 daemon或生产DB。
- [x] 未知均给出确定复查方法；需要产品口径处明确送R8裁决。
- [x] A层主agent摘要与B层证据附录分离。
