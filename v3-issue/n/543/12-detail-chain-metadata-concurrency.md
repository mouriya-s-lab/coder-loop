# R7-DI-04：旧 chain metadata whole-snapshot 写的并发隔离事实

> 调查基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。归属 `S2-U01`；只核对 B6/J4 地基资格。本文不设计 journal、fingerprint，不裁决新增需求。

## A. 摘要（≤1 页）

### A1. 结论

**隔离实验已裁决 `S2-U01`：旧 keep-active 与并发 metadata writer 会发生 lost update。** SQLite `BEGIN IMMEDIATE` 只把两个最终 `UPDATE` 串行化；它不能把调用方在事务外取得的旧 `ChainRecord.metadata` 变成字段级合并或 compare-and-swap。最后提交的 whole-metadata 快照覆盖前一个 writer 的 metadata 子树。

真实 keep-active 路径在运行 trigger 前持有 `chain` 快照，跨越一次外部 `await`，然后用该旧快照构造整个 metadata：`src/scheduler.ts:2752-2777,2798-2816`。`updateChain` 虽在 immediate transaction 中重新读当前行，却在提供 `input.metadata` 时无条件选择调用方快照，并以一个 `UPDATE chains SET ... metadata=$metadata ...` 重写全行：`src/sqlite-state.ts:1605-1612,1713-1733`。因此事务提供原子提交、writer 排队和崩溃回滚，不提供 stale-snapshot 冲突检测。

同步 barrier 的两个确定性交错均复现覆盖：

| 最终顺序 | 最终 metadata | 被覆盖资产 |
|---|---|---|
| binding `m1` 先提交；旧 keep-active 后提交 | `codex.model=m0` + keep-active | binding `m1` 丢失 |
| keep-active 先提交；旧 binding `m2` 后提交 | `codex.model=m2`，无 keep-active | keep-active 丢失 |

同一隔离 DB 的锁实验中，第二 writer 等待约 `967ms` 后才提交，证明 immediate writer 锁确实串行；故问题不是并行 SQL 撕裂，而是**串行提交了两个过期的 whole-snapshot replacement，last writer wins**。未提交事务进程以 code 73 退出后，重开 DB 不见其 `crash=uncommitted`，证明 WAL/transaction 崩溃回滚成立。

### A2. B6/J4 可核实地基资产

| 资产 | 实测/直接机制 | 地基资格边界 |
|---|---|---|
| WAL + `busy_timeout=5000` + immediate transaction | `src/sqlite-state.ts:838-850,1605-1612`；双连接实测 writer 等待后顺序提交 | 可作为单次持久化原子性、writer 排队、崩溃回滚资产；不能证明跨 await 的读改写隔离 |
| canonical stable JSON + SHA-256 + 排除自身 keep-active state | `src/scheduler.ts:2819-2872` | 是 B6 的既有防抖算法先例；不是 J4 epoch，也不改变 metadata 覆盖行为 |
| typed metadata parser/serializer 与 keep-active carrier | `src/runtime-data.ts:341-368,489-504` | 能稳定读写旧专用状态；carrier 仍是 whole metadata 的一部分，不能作为并发写隔离资产 |
| schema migration 的 metadata 保留/重写事务 | `src/sqlite-state.ts:1001-1016,1398-1439,1488-1526` | 证明旧 metadata 可跨升级和迁移事务原子性；不提供 runtime writer 冲突检测 |
| per-process `finalizingChainIds` | `src/scheduler.ts:2693-2720` | 阻止同一 scheduler state 内同 chain 的重入 finalizer；不隔离 operator metadata writer，也不跨进程持久化 |
| audit/event | trigger decision 在写前 emit；binding writer 在写后记 `chain.layout` | 能留下“decision/操作发生过”的旁证；没有 metadata before/after/version，不能检测或恢复覆盖 |

**J4 仍没有 epoch 资产。** 现有 durable fingerprint 是专用 keep-active 状态；daemon 的 decision fingerprint 又是内存观测去重（`src/daemon.ts:631-723`）。二者都不构成 epoch。这里可保留的 J4 地基仅是 SQLite 的原子事务/恢复原语，不是旧 metadata 写协议。

### A3. 根因集合与修补边界事实

1. **上游来源：** scheduler 把 trigger 启动前的 `ChainRecord` 穿过外部异步执行，再在返回后用于 whole-metadata 构造。
2. **直接机制：** `updateChain` 对传入 metadata 执行 replacement；事务内读取的 current metadata 不参与合并，也没有 revision/CAS predicate。
3. **放大条件：** trigger await 窗口长；daemon 不同 socket 各自有 request promise chain，可并发进入 handler；operator binding 写在该窗口内可完成（`src/daemon.ts:1660-1693,1920-1932,2624-2669`）。
4. **消费者影响：** 后提交 keep-active 可回滚 runner model/bindings/path/hook 等 metadata；后提交 operator snapshot 可删除 durable keep-active，导致相同完成上下文被再次触发。审计记录仍可能显示两项操作成功。
5. **修补边界（只描述缺陷边界）：** 必须覆盖“读取基准 → 异步间隙 → metadata 写入”的冲突语义；只强化 SQL transaction、tick 单飞或现有 event audit 均不触达根因。本文不指定实现形态。

## B. 证据附录

### B1. 真实调用链（穷尽生产入口）

#### B1.1 keep-active reader/writer

1. `completeChainIfReady` 从 store 重读当前 chain 和 items，检查 active/terminal，并用内存 `finalizingChainIds` 排除同一 scheduler state 重入：`src/scheduler.ts:2683-2707`。
2. `chainCompletionTriggerAllowsCompletion(options, current, ...)` 接收该 `current` 快照：`src/scheduler.ts:2707`。
3. 由快照及 items 计算 fingerprint；相同专用状态则短路：`src/scheduler.ts:2752-2757,2793-2796`。
4. `await options.chainCompleteTrigger(...)` 或 `await ...ForChain(...)` 执行外部 trigger：`src/scheduler.ts:2764-2766`。此处是快照存活的异步窗口。
5. 决策 event **先于** metadata 写 emit：`src/scheduler.ts:2768-2777`。
6. `persistKeepActiveTriggerState` 用入参 `chain.metadata` 调 `withChainCompleteTriggerState`，生成整个新对象：`src/scheduler.ts:2798-2816`；helper 展开完整旧 metadata 后写专用字段：`src/runtime-data.ts:500-504`。
7. store `updateChain` 开 immediate transaction，读当前 row；但 `metadata: input.metadata ?? current.metadata` 选择入参 replacement：`src/sqlite-state.ts:1713-1725`；随后同一 SQL 更新 chain 全部列：`1727-1733`。

#### B1.2 实际并发 writer

生产代码中除 create-time metadata 外，检索到的 runtime metadata mutation 入口只有：

- scheduler keep-active：`src/scheduler.ts:2813-2816`；
- daemon `chain.updateBindings`：handler 从 `resolveChain` 得快照，复制并 patch runner model，随后 whole replacement `updateChain`：`src/daemon.ts:2624-2661`；成功后才记 `chain.layout` audit：`2662-2669`。

`chain.create` 只在新建/force recreate 时写初值：`src/daemon.ts:2166-2229`；schema migrations 是启动期 DB rewrite，不是正常并发入口。测试 harness 的 metadata update 不是生产入口。

#### B1.3 daemon 并发可达性

每个 socket 内请求由局部 `requestSequence` 串行，但该 promise 不是 daemon 全局队列；每个 accepted socket 各建一份：`src/daemon.ts:1660-1677`。不同 socket 可各自执行 `handleRequest`；dispatch 直接 await handler，没有全局 mutex：`src/daemon.ts:1920-1932`。`chain.updateBindings` 是 operator-only admission，但 admission 不是 scheduler metadata 锁：`src/daemon.ts:1734-1741,1934-1955`。

因此 tick 自身单飞/per-chain finalizing 只约束 scheduler 调用；它不排除另一 socket 的 operator writer。

### B2. store 事务、锁与 SQL

- open 时启用 foreign keys、5 秒 busy timeout，并把 journal mode 设为 WAL：`src/sqlite-state.ts:822-856`。
- 每个 store write 包在 Bun SQLite `db.transaction(fn).immediate()`：`src/sqlite-state.ts:1605-1612`。
- `updateChain` 的事务内 read + write 是原子的，但 metadata replacement 来自事务外调用方构造的值：`src/sqlite-state.ts:1713-1733`。
- SQL 没有 metadata revision、旧值 predicate 或字段级 JSON patch；`WHERE` 只有 `id = $id`：`src/sqlite-state.ts:1727-1732`。

隔离层事实：`BEGIN IMMEDIATE` 在事务开始取得 writer reservation，使另一个 writer 等待/超时；它不会验证待提交 JSON 是不是从旧版本派生。故“有 immediate transaction”和“无 lost update”不是同一命题。

### B3. barrier 实验

#### B3.1 环境与命令

实验仅使用 `/tmp/r7-di04-isolated`，未触碰生产 DB/daemon。脚本 `/tmp/r7-di04-experiment.ts` 用两个 `openSqliteStateStore` 连接同一 DB；barrier 在两个调用方都读取快照后开放，再按指定顺序写。

```bash
bun /tmp/r7-di04-experiment.ts | tee /tmp/r7-di04-experiment.log
```

基线 initial：

```json
{"bindings":{"seed":"v0"},"codex":{"model":"m0"}}
```

#### B3.2 交错一：binding → stale keep-active

顺序：

1. A/B barrier 前都读到 `codex.model=m0`；
2. B whole snapshot 写 `m1`，DB 确认 `m1`；
3. A 用 barrier 前快照添加 keep-active 后提交。

最终观察：

```json
{"bindings":{"seed":"v0"},"codex":{"model":"m0"},"coderLoopChainCompleteTrigger":{"decision":"keep-active","fingerprint":"fp-A1","recordedAt":200,"reason":"A1","runId":"run-A1"}}
```

`m1` 丢失；A 的旧 `m0` 被恢复。

#### B3.3 交错二：keep-active → stale binding

顺序：

1. 重置后 A/B barrier 前都读到无 trigger、`m0`；
2. A 写 keep-active，DB 确认专用状态存在；
3. B 用 barrier 前快照写 `m2`。

最终观察：

```json
{"bindings":{"seed":"v0"},"codex":{"model":"m2"}}
```

keep-active 丢失。两次实验 journal mode 均报告 `wal`。

### B4. 锁顺序与崩溃实验

脚本 `/tmp/r7-di04-lock-parent.ts` + `/tmp/r7-di04-lock-holder.ts` 使用 `/tmp/r7-di04-lock/db.sqlite`：child 先 `BEGIN IMMEDIATE` 并以 ready file 开 barrier；parent 再调用真实 store `updateChain`。

```bash
bun /tmp/r7-di04-lock-parent.ts | tee /tmp/r7-di04-lock.log
```

观察：

```json
{"label":"lock-order","elapsedMs":967,"metadata":{"seed":"v0","holder":"committed"}}
{"label":"crash-rollback","childExit":73,"metadata":{"seed":"v0","holder":"committed"}}
```

解释：holder 约 900ms 后提交，parent 的 immediate write 等待约 967ms，最终两项不同列/基于事务内 current 的 status 更新均存在；这证明 writer 排队。第二 child 在 transaction 中写 `crash=uncommitted` 后 `process.exit(73)`，重开 DB 后字段不存在；这证明未提交 whole metadata 不外露。该实验不证明 stale snapshot 安全，B3 已反证。

### B5. 审计与可观测性

- scheduler 对 `keep-active` 的 `chain.complete_trigger` event 在 persist 前 emit：`src/scheduler.ts:2768-2777`。若 persist 抛错，catch 还会发 failed event：`2781-2789`；若 persist 成功后稍后被覆盖，原 decision event 仍存在。
- daemon binding writer在 `updateChain` 返回后发 `chain.layout` audit：`src/daemon.ts:2661-2669`。
- `chain.layout` payload 是 `chainId/updatedKinds/state`，没有 metadata before/after/version：`src/daemon.ts:2662-2668`。
- store `updateChain` 自身不写审计行/intent；审计是 DB 外的 daemon observability path。

因此并发交错可留下两条“成功”记录而最终只保留后写快照。现有审计能证明两个动作到达过，不能定位被覆盖 JSON、决定顺序或自动恢复丢失子树。

### B6. 迁移与恢复

#### B6.1 migration

schema migration 外层是单事务：`src/sqlite-state.ts:1001-1006`。历史 umbrella 列在 rebuild 前迁入 `metadata.bindings`：`1007-1016,1398-1439`。v9→v10 对每行 metadata 做 parse/rewrite 后 whole update：`1488-1526`。这些发生在 store open 初始化阶段，且 migration transaction 提供原子性；它们说明旧 metadata 状态可继续存活/被重写，不是 normal runtime 并发 writer 的隔离协议。

#### B6.2 restart/crash

keep-active 已提交后属于 chain row，restart 重读 parser 能恢复专用字段（`src/sqlite-state.ts:2173`; `src/runtime-data.ts:489-504`）。未提交事务由 WAL 回滚（B4 实测）。但是已经成功提交、随后被另一个合法 whole-snapshot commit 覆盖的数据不是“未提交崩溃”，SQLite 不会恢复它；现有无 metadata version/history/outbox 可重建。

### B7. 测试同错与盲区

现有覆盖证明各自 happy path，但没有让两类 writer共享同一 barrier：

- keep-active 测试证明首次写后不重复触发、follow-up 改变上下文后重问：`tests/integration/scheduler/core.integration.ts:750-792`；单 store、无 metadata 并发写。
- overlapping completion tick 测试证明 `finalizingChainIds` 阻止同 scheduler state 双 finalizer：`tests/integration/scheduler/core.integration.ts:704-748`；第二参与者仍是 scheduler tick，不是 operator writer。
- runner model smoke 证明 CLI→daemon→SQLite round-trip及同值幂等：`tests/integration/cli/smoke.integration.ts:54-112`；无长 await 中的旧快照。
- CRUD 只测 chain round-trip/status：`tests/unit/sqlite-state/crud.test.ts:78-99,159-160`；未断言 concurrent metadata semantics。

这些测试与生产实现共享“读快照、构造完整 metadata、单独提交”的假设，故绿色不能排除 B3 的 last-writer-wins。`S2-T11` 盲区成立。

### B8. 上游来源与历史原因

`git blame`：

- store immediate transaction 与 `updateChain` whole-row update 均源于 `71596a25`（2026-05-23）；metadata replacement 行后来由 `14989dce` 调整类型/shape。
- chain-complete keep-active/fingerprint 主体源于 `87b86f81`（2026-05-26）；当前 metadata helper接线由 `14989dce`（2026-06-17）。

可直接证明的历史机制是：通用 CRUD 先提供 whole `ChainRecord` replacement，随后 keep-active 专用状态复用了这个 carrier。commit/符号只定位来源，不证明当时的设计意图；本文不从 commit message推断需求。

### B9. 观察 / 机制 / 影响 / 根因对照

| 类别 | 事实 |
|---|---|
| 观察 | 两种最终写顺序各自丢失另一 writer 的 metadata 子树 |
| 直接机制 | 事务外旧快照 + 事务内无条件 whole replacement + `WHERE id` |
| 上游来源 | generic `updateChain` whole-record CRUD 被 keep-active 与 binding patch共同复用 |
| 历史原因 | 可确认演进顺序；原作者动机未知且不作推断 |
| 放大条件 | 外部 runner await、不同 daemon socket并发、metadata 承载多类配置/状态 |
| 消费者影响 | runner/bindings/path/hook 值回退，或 keep-active 消失导致同上下文再触发；审计与最终态不一致 |
| 根因集合 | 缺少覆盖异步读改写窗口的冲突语义；scheduler mutex 与 DB writer serialization只覆盖各自局部 |
| 修补边界 | 需触达 stale read 到 commit 的端到端边界；不由本文选定具体协议 |

### B10. 未知与确定方法

1. **生产中该交错出现过多少次：未知。** 现有 event 不含 metadata before/after/version，无法从事件单独重建。确定方法：对生产 DB 备份与完整 observability history做时间相关核对，并寻找 operator binding audit 后 model回退或同 fingerprint finalizer重复；若历史没有 metadata snapshot/version，只能给下界，不能得完整次数。
2. **所有外部直接 import store 的非仓库调用者：未知。** 仓库内生产入口已穷尽；确定方法：对部署脚本/外部插件仓做 `updateChain`/`chains.metadata` 调用面审计。本文不访问中央运行仓或 daemon。
3. **SQLite 锁等待的精确时长：非契约。** 本机一次为约 967ms；确定方法是多次在目标 Bun/SQLite 版本和目标文件系统运行 B4，记录分布。锁“串行而非合并”的性质已由代码与实验确定。

### B11. 证据索引

| 证据 | 位置 |
|---|---|
| keep-active async read/write窗口 | `src/scheduler.ts:2752-2816` |
| fingerprint/self-state排除 | `src/scheduler.ts:2819-2872` |
| typed metadata carrier | `src/runtime-data.ts:341-368,489-504` |
| WAL/busy timeout | `src/sqlite-state.ts:822-856` |
| immediate write wrapper | `src/sqlite-state.ts:1605-1612` |
| whole-row update SQL | `src/sqlite-state.ts:1713-1733` |
| concurrent operator writer/audit | `src/daemon.ts:2624-2669` |
| per-socket concurrency | `src/daemon.ts:1660-1693,1920-1932` |
| migration metadata handling | `src/sqlite-state.ts:1001-1016,1398-1439,1488-1526` |
| barrier 输出 | `/tmp/r7-di04-experiment.log` |
| lock/crash 输出 | `/tmp/r7-di04-lock.log` |

## C. 文件尾部核对

- [x] 固定并记录 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- [x] 穷尽仓库内生产 metadata 读/写入口、SQL、transaction、lock 与 audit 调用链。
- [x] 隔离 DB + barrier 复现两种顺序并记录最终 metadata。
- [x] 单独验证 immediate writer 排队与未提交事务崩溃回滚。
- [x] 区分观察、直接机制、上游来源、历史、放大条件、消费者影响、根因与修补边界。
- [x] 核对 migration/restart、同错测试、盲区与可保留资产。
- [x] 未设计 journal/fingerprint，未裁决/新增需求，未列实现选项，未估工。
- [x] 未改代码、测试、配置、WORKFLOW、生产 DB；未建 worktree；未触碰中央 daemon。
