# R7-09 · current closure authority、历史 owner/migration 与 lifecycle 对应

基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
历史只读候选：`8e9642c`  
设计锚点：`AGG-548.md` T7、STD-748-B1  
Ledger：`S2-D15 S2-R04 S2-R05 S2-A02 S2-U04`

## A. 主 agent 摘要

### 问题

current main 中谁拥有 closure 的 identity、run、worktree/branch、session、reachability、消费意图与清理终态；历史 HAPI 候选的 slot/item 资产能否直接对应这套 authority；这些事实是否足以让 R7-06/07 在同一 closure 上断言 invocation/loss。

### 结论与置信边界

**结论（高置信）：current main 已有唯一、持久化、per-closure authority；历史候选不能整块恢复。**

1. closure 是 `(closure_id, leaf_node_id, item_row_id, phase)` 的持久身份；run 同时持有 `closure_id` 与 `runtime_node_id`，active run 以 `closure_id` 唯一占用；session 以 `(closure_id, runner_kind)` 持久化。
2. worktree path 与 branch 都由 `(loopDataRoot, chainName, repoCwd, closureId)` 确定，first-open/reopen 与 retry/restart 复用同一 tuple；session 同样按 closure+runner 恢复。
3. `active/suspended/consumed`、持久 reachability、两类 consumption authority、durable consumption intent、Git cleanup 与 startup reconciliation 共同构成 closure lifecycle。`consumed` 不可逆并删除 session；资源只有成功清理后才置空。
4. stop 只终止 run、保留 closure/resource/session，resume 因而可在同一 closure 恢复；delete 先消费并清理全部 closure，失败保持 stopped 且可重试；startup 终结孤儿 run并核对/清理资源残留。
5. 历史候选把 worktree/branch owner 降为 `(chain, repo)` slot，并让 item phase/session 承担恢复入口；它同时删除 current reachability、consumption intent、closure cleanup/reconciliation。该形态会形成第二事实源，不能与 current authority 并存。

**置信边界：** current local-process closure 生命周期由生产代码、43 个 focused tests 和隔离的 issue-560 全场景脚本共同证明。R7-09 没有、也不应证明真实 HAPI remote invocation 或 active-loss ordering；那仍属于 R7-06/07。

### 因果与影响

历史 slot 可在不同 phase/closure 间复用同一 cwd/branch；current 则把 WIP、session、run identity、可达性和清理全部绑定到 closure。若恢复 slot owner，retry 看似“复用 cwd”，实则无法证明复用的是**同一 closure**，并会绕开 consumed/session deletion、reachability gate、intent retry 和 namespace-safe cleanup。因此这是 authority 冲突，不是字段改名。

- **当前影响：** current main 已能提供 R7-06/07 所需的 closure/run/cwd/session 基准，不需要先发明新 owner。
- **未来影响：** 任一 external-terminal invocation 只有进入 current `recordRunWithClosureResources → active_runs → closure_sessions → consumption` 路径，才可主张与其他 runner 同构。
- **纯证明缺口：** HAPI 是否真实进入上述路径，以及 loss-first/terminal-first 的顺序，不在本报告内。

### 历史资产分类

| 历史资产 | 事实分类 |
|---|---|
| `closure_sessions` 增加 `hapi` runner variant；session getter/setter 仍经 closure join | **可隔离移植，但须在 current schema 上适配** |
| runner/domain/probe/typed availability 与 hold 词汇 | **可隔离；不改变 closure authority** |
| slot key 的并发互斥 `(chainId, repoCwd)` | **可保留为调度锁，不可升级为资源 owner** |
| slot worktree path/branch、`slot.worktreePath`、item `agentCwd` 作为恢复事实 | **双事实源负资产** |
| slot cleanup、stale slot branch recovery | **必须适配 current per-closure namespace/ownership 后才有意义** |
| HAPI CHECK widening migration | **迁移动机可保留；历史实现必须按 current 完整 schema 复核** |
| invocation-pending/zero-spawn 路径 | **不属于 R7-09 可保留 closure 资产，且不能证明 lifecycle** |

### 未知与解锁判断

- **未知：** 真实 HAPI session id 的 wire 形状、remote invocation 到 status admission、同一 invocation 的 loss ordering；均明确留给 R7-04/06/07。
- **已足够解锁 R7-06/07：是。** 它们应以 current closure/run/resource/session authority 为观察坐标，不能以历史 slot/item 字段为坐标。
- **已足够供 R8 使用：是（仅 authority 事实）。** 无需再裁决 closure owner；R8 仍须消费 R7-06/07 的真实 invocation/loss 事实。

## B. 证据附录

### B1. current authority map

| 事实 | Authority / invariant | 证据 |
|---|---|---|
| closure identity | `task_closures.closure_id` PK；`leaf_node_id` unique；`(item_row_id,phase)` unique | `src/sqlite-state.ts:677-691` |
| runtime node | leaf `runtime_node_id` 一对一引用 closure | `src/sqlite-state.ts:693` |
| run identity | run 写入时解析 closure+leaf；prepared resources 与 run 在同一 store write transaction | `src/sqlite-state.ts:1647-1662`；`tests/unit/sqlite-state/task-tree.test.ts` “prepared closure resources and run history commit atomically” |
| active occupancy | `active_runs.closure_id` PK；`(run_id,closure_id)` FK | `src/sqlite-state.ts:754-760` |
| lifecycle | `active/suspended/consumed`；consumed 不可逆；active run 禁止 suspend/consume | `src/sqlite-state.ts:1985-1994` |
| resource tuple | live closure 必须同时有 worktree+branch；仅 consumed 可为空 | `src/sqlite-state.ts:691,1997-2001` |
| worktree identity | path/branch 由 closureId 哈希进入 engine closure namespace | `src/closure-lifecycle.ts:98-129` |
| session | `(closure_id,runner_kind)` PK；消费删除 closure sessions | `src/sqlite-state.ts:739-744,2028-2031` |
| reachability | persisted tree + active run + resumable/seq/par seeds + supplemental seed/edge fixed point | `src/closure-lifecycle.ts:25-86`；`src/sqlite-state.ts:2129-2153` |
| consumption authority | only `outer-completion` or `chain-deletion`；active/reachable closure retained | `src/sqlite-state.ts:282-293,2117-2126` |
| consumption intent | lifecycle+session delete+pending intent 同一 DB transaction；event emitted 后另事务标 emitted | `src/sqlite-state.ts:2021-2038` |
| cleanup authority | 只清 engine-owned closure/retired provenance；foreign reject | `src/closure-lifecycle.ts:132-167`；`src/scheduler.ts:1279-1425` |
| startup reconciliation | stale/orphan run reconciliation 后扫描 closure resources | `src/daemon.ts:2366-2432` |

### B2. 写入口与消费者

#### 写入口

1. **closure/run/resource 创建：** scheduler 在 spawn 前取得/创建 closure tuple，然后 `recordRunWithClosureResources`；`src/scheduler.ts:1581-1638`。
2. **phase lifecycle：** phase 离开 active→suspended，重新进入 suspended→active；`src/scheduler.ts:1755-1774,2147-2151`。
3. **session：** runner close parser 经 `setItemSessionId` 写入；该 store API 实际 join `(item,phase)` 到 closure，consumed 禁止新增；`src/sqlite-state.ts:329-330,1830-1848`。
4. **active run：** `setCurrentRun/clearCurrentRun` 最终写 `active_runs`，run 必须匹配 closure/phase/chain；`src/sqlite-state.ts:1630-1666,2481-2509`。
5. **reachability supplement：** 唯一 API `addClosureReachabilityFact` 只接受 future-writer seed 或 edge，并验证同 chain；`src/sqlite-state.ts:2004-2017`。
6. **consume：** chain completion 与 chain deletion 都只经 `consumeSchedulerClosure`；`src/scheduler.ts:1489-1524,2723-2749`；`src/daemon.ts:2843-2868`。
7. **startup repair：** `reconcileClosureResources` 只修 consumed retired tuples/孤儿 engine namespace residue，不重建缺失的 live resource；`src/scheduler.ts:1010-1270`。

#### 消费者

- scheduler spawn 读取 closure resource/session 决定 first-open/reopen 与 resume：`src/scheduler.ts:1583-1604`。
- status/task tree 读取 closure、run 与 session snapshot：`src/sqlite-state.ts:2456-2523`。
- completion/delete 读取 reachability、active run、intent 与 ownership：`src/sqlite-state.ts:2117-2153`；`src/scheduler.ts:1489-1524`。
- daemon startup 与 observability 消费 reconciliation/consumed/lifecycle 事件：`src/daemon.ts:748-871,2391-2396`。

### B3. lifecycle 实际终态

| 动作 | run | closure/resource/session | 证据 |
|---|---|---|---|
| retry（同 phase） | 新 run id/attempt | 同 closure、同 cwd/branch；已有 session 进入 `--resume` | `src/scheduler.ts:1583-1604`；实验 C04/C09 |
| phase advance | 旧 run complete | 旧 closure suspended、资源/session 保留；新 phase closure active | `src/scheduler.ts:2147-2151`；实验 C01-C04 |
| stop | active run 被 terminate | chain stopped；不调用 cleanup/consume，closure/resource/session 保留 | `src/daemon.ts:2554-2585` |
| resume | scheduler 重新选取 | stopped→active；复用持久 closure/session | `src/daemon.ts:2588-2609`；实验 C09 |
| outer completion | 无 active/reachable closure | consumed、session 删除、intent durable、Git 清理、resource tuple 置空；全部完成后 chain completed | `src/scheduler.ts:2705-2715,2723-2749` |
| delete | 先 terminate | chain 先 stopped；逐 closure consume/cleanup；失败保持 stopped 可重试；成功 deleted 并删 chain runtime root | `src/daemon.ts:2505-2541,2843-2884`；实验 delete-retry |
| restart | stale process/run 终结 | closure state不静默推进；核对缺失/孤儿/registration/retired residue；pending cleanup 可重试 | `src/daemon.ts:2366-2432`；实验 C07/C09 |

### B4. SQL、事务、锁与 crash windows

#### 事务与锁

- store `write(...)` 包装单次同步 SQLite write transaction；因此 prepared closure resources+run、consume lifecycle+session delete+intent 各自原子。
- Git 不可能与 SQLite 同事务。repo Git 操作由 `RepositoryGitCoordinator.run` 按 repo 串行；相同 base fetch 可 singleflight：`src/closure-lifecycle.ts:188-220`。
- daemon 的 stop/delete 用 `pauseSchedulerForMutation` 包住状态变更、terminate 与 cleanup：`src/daemon.ts:2517-2540,2561-2585`。
- consumption 是显式 saga：先 durable consumed+pending intent，再 Git cleanup，再 emit，再标 emitted，再清 resource tuple：`src/scheduler.ts:1489-1524`。

#### crash windows 与恢复结果

1. **worktree 已创建、DB run/resources 尚未提交：** 可能留下 engine namespace orphan；startup reconciliation 扫描 branch/worktree/directory，未发布 work 不会静默删除。
2. **DB run/resources 已提交、child 未 spawn：** preparation failure cleanup/containment 完成 run；closure tuple仍是 durable authority，后续可 reopen。
3. **child active、daemon crash：** startup 终止 stale process group，清 `active_runs`，把无结束 run 标 orphaned；closure/resource/session不被重置。
4. **DB 已 consumed、Git cleanup 未完成：** pending intent 与仍在 DB 的 resource tuple允许 delete/restart重试；不会再次决定新的 observation。
5. **event emitted、`mark...emitted` 前 crash：** pending intent可能导致重发，语义是 durable at-least-once，不是 exactly-once external emission；测试只证明最终表内 emitted 与正常/重试路径观测到单条。
6. **Git cleanup 成功、resource tuple 置空前 crash：** startup sees consumed tuple and retries idempotent cleanup，再置空。

### B5. migration 与历史候选对照

#### current migration 前提

current schema migration 在一个 SQLite immediate transaction 中：

- 建 current base/runtime schema；
- legacy item/session → per-closure runtime；
- run backfill `closure_id/runtime_node_id`，缺映射则 fail closed；
- v14 删除 item `session_ids` source；
- 保留 reachability tables、consumption intent、FK/index。

证据：`src/sqlite-state.ts:973-1087,1093-1175`。当前 focused migration suite 证明 canonical v13/v14 FK、normalized runtime、重复打开与 session source retirement。

#### 历史 `8e9642c`

| 历史触点 | 与 current 对应 | 分类 |
|---|---|---|
| `schedulerSlotWorktreePath` / slot branch `(chain,repo)` | current `closureWorktreePath/closureBranchName(...closureId)` | 双 owner 冲突；`8e9642c:src/scheduler.ts:937-972` |
| `slot.worktreePath` across runs | current closure snapshot resource tuple | 双事实源；`8e9642c:src/scheduler.ts:1080-1107` |
| item+phase lookup session，底层仍 join closure | current closure session | 底层资产可适配；`8e9642c:src/sqlite-state.ts:1722-1738` |
| widen `items.runner` + `closure_sessions.runner_kind` for hapi | current runner CHECK + closure schema | 动机可保留；实现须以 current full schema为输入 |
| `rebuildClosureSessionsForHapi` whole-table swap | current table还有同列/FK，但 migration 同轮还需维护 reachability/intent/index与 FK sequencing | 不可原样认定安全；`8e9642c:src/sqlite-state.ts:875-1028` |
| 删除 reachability/consumption intent API与表，删除 closure cleanup/reconciliation | current consumption/recovery authority | 明确负资产；`git diff 699842e..8e9642c -- src/sqlite-state.ts src/scheduler.ts` |
| probe available 后 invocation-pending gate | 不产生真实 active HAPI run | 不提供 closure lifecycle 证据；`8e9642c:src/runner-execution.ts:21-29`、`8e9642c:src/scheduler.ts:1198-1205` |

历史 migration 的主要风险不是 `closure_sessions_new` 三列复制本身，而是候选以较旧的**整套** runtime schema为目标：它删除了 current 的 reachability与intent authority，并用检测函数把“含 opencode+hapi”混入旧命名的 opencode check。把该 commit 整体重放到 current main 会使 migration/表清单/消费者回退；仅从该 commit 抽出 runner variant 也仍需在 current schema副本上验证 FK、indexes、user_version与重复打开。

### B6. 测试、同错风险与实验

#### current 测试

命令：

```text
bun test tests/unit/runtime/closure-lifecycle.test.ts \
  tests/unit/sqlite-state/task-tree.test.ts \
  tests/unit/sqlite-state/migrations.test.ts
```

结果：`43 pass, 0 fail`。覆盖 fixed-point reachability、per-closure namespace、prepared resource/run atomicity、lifecycle constraints、intent persistence、active-run conflicts、v13/v14 migration/FK/idempotency。

隔离进程级脚本：

```text
bun scripts/issue-560-integration.ts \
  --log-file /tmp/rfc548-r7-09-issue560.log --foreground
```

结果：`issue-560.pass`，source SHA 与固定基线一致，C01-C10 全过；脚本使用自己的 UUID loop-data/daemon/repositories，结束后 runtime 不存在，临时 log 已清理。关键观察：

- C04：phase reopen 同 closure/cwd/session；
- C09：daemon restart 后 attempt 3 仍同 cwd/branch/session；
- C05：reachability retain/consume、正常 completion 后两个 closure 均 consumed 且资源为空；
- C07：missing directory/branch、orphan、registration、repo config drift 均被观察；
- delete-retry：首次 cleanup incomplete 后 chain 为 stopped；restart reconciliation 后重试成功，消费事件一条且 chain root 删除。

#### 同错/盲区

- issue-560 runner 是 deterministic stub，不证明 HAPI external-terminal wire 或 remote lifecycle。
- current session tests只证明 `claude/codex/opencode` domain；把 `hapi` 加入 enum而未进入真实 invocation，仍可全绿。
- 历史测试若以 slot cwd复用或 zero-HAPI-spawn 为 PASS，会把错误 owner/终点固化；不得作为 T7 closure 同构证明。

### B7. 事实支持的形态与触点

本调查只支持以下事实形态，不提出补法：

1. external-terminal 必须引用 current durable `closure_id/runtime_node_id/run_id`。
2. cwd/branch/session/retry/restart 的同一性必须以 closure tuple判定，不能以 slot或 item 字段判定。
3. stop/resume 不消费 closure；outer completion/delete 才有 consumption authority。
4. cleanup/reconciliation 必须继续以 current namespace、reachability与intent为事实源。
5. 历史 HAPI runner/session variant只能作为隔离资产评估，不能携带旧 slot lifecycle。

触点清单：`src/task-runtime.ts`、`src/closure-lifecycle.ts`、`src/sqlite-state.ts`、`src/scheduler.ts`、`src/daemon.ts`、`src/runtime-data.ts`、observability/status、migration tests、closure lifecycle/integration tests。此清单是事实边界，不是实现拆分。

### B8. 证据索引

| ID | 证据 |
|---|---|
| E01 | `src/sqlite-state.ts:677-760` schema identity/resource/session/intent/active-run |
| E02 | `src/sqlite-state.ts:1985-2038` lifecycle、consume与intent事务 |
| E03 | `src/sqlite-state.ts:2117-2153` authority/reachability |
| E04 | `src/closure-lifecycle.ts:25-86,107-167,193-220` reachability、namespace、ownership、repo lock |
| E05 | `src/scheduler.ts:1279-1524` cleanup/observation/consume saga |
| E06 | `src/scheduler.ts:1581-1774,2147-2164,2723-2749` spawn/reopen/phase/completion |
| E07 | `src/daemon.ts:2366-2432,2505-2609,2843-2884` startup/delete/stop/resume |
| E08 | `8e9642c:src/scheduler.ts:937-1051,1080-1205` historical slot owner |
| E09 | `8e9642c:src/sqlite-state.ts:875-1028,1722-1738` historical migration/session |
| E10 | 43 focused tests：全过 |
| E11 | issue-560 isolated process integration C01-C10：全过 |

## 报告核对

- [x] A 摘要不超过一页量级，含结论/置信、因果、影响、资产、未知、R7-06/07 与 R8 解锁判断。
- [x] B 附录含 current authority map、历史对照、全部写入口/消费者、SQL/事务/锁/migration/crash windows。
- [x] 区分 retry/resume/consume/stop/delete/restart 实际终态。
- [x] 区分可隔离资产、必须适配与双事实源负资产。
- [x] 未扩展到真实 remote invocation/loss；未提出补法、规模估算、实现或 issue 重拆。
- [x] 仅写本报告；未修改产品、测试、配置、DB、WORKFLOW、issue/PR。

报告行数：222 行。
