# RFC #548 S2 — HAPI / external-terminal supply-side reconciliation audit

**基线：** current `main` = `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`；历史候选 `8e9642c399050e54f7e7bba80cc37c5f084b7d89`；回退 `483466f`。  
**唯一设计事实：** `AGG-548.md` §2.1 G/I、§2.4、T7、STD-602-9/10、§4、§6。  
**方法边界：** 只读 `git show/diff` 与 current source/tests；未 checkout/worktree，未启动 daemon/数据库/runner，未调用真实 HAPI。

---

# A. 主 agent 摘要（单页）

## 问题与结论

R4 要求判断已回退的 `8e9642c` 是否符合稳定 T7，以及其资产在 #749 后能否回到 current main。**结论：它不符合稳定 T7，不能原样作为下游地基。** 决定性事实不是“缺少一些测试”，而是生产类型明确把 HAPI 定义为 `{kind:"probe-only", outcome:"invocation-pending"}`；HAPI invocation builder 不生成 spawn plan，并在进入调用分支时抛错。因此候选不存在真实 HAPI run、`status.json` admission、retry/resume、terminal result，也不存在通过真实 HAPI 路径可达的 active loss。仓库脚本明确以 `zero-hapi-spawn` 为 PASS。

历史 availability/probe/hold 机制是有价值但不完备的资产：它有 local/external execution-domain ADT、字面量 `probe`、exit 69/missing/nonzero/signal/deadline 分类、调度前 gate、hold/restoration event/status、loss latch。它不能证明外部终端生命周期，因为唯一 external runner 无法 active。

#749 后历史 worktree/session/run 层已成为结构性负资产：`8e9642c` 以 repo slot (`slot.worktreePath` + slot branch) 为资源 owner，以 item+phase+runner 寻址 session；current main 以 closure 为 durable owner，使用 closure-derived path/branch、`recordRunWithClosureResources`、runs 的 `closure_id/runtime_node_id`、closure session、reachability、active-run exclusion、consumption intent、cleanup 和 startup reconciliation。历史 scheduler/SQLite hunks会制造第二事实源，不能整块恢复。

## 复杂因果

1. 稳定 T7 把 availability 与真实 invocation 定义为原子交付。
2. `8e9642c` 接受 HAPI runner/storage vocabulary，却把可用后的终点设成 `invocation_pending`。
3. 所有 active-loss/race/recovery 测试只能注入 synthetic active state，不能证明同一真实 HAPI 路径。
4. #749 又将资源所有权从 slot/item 移到 durable closure。
5. 所以“历史实现完整”既不是符合证明，也不是可恢复证明。

## 影响、资产与置信边界

- **当前影响：** 无；`483466f` 已移除该实现，current main runner/storage vocabulary 又是三元。
- **未来影响：** 可复用窄的 execution-domain/probe ADT、hold/loss wire 概念、focused probe/fairness tests；invocation 与全部 closure-bound runtime 集成必须对 current main 重新核对。
- **负资产：** `probe-only`/`invocation-pending`；`zero-hapi-spawn` integration；slot worktree owner；item/phase session owner；历史 whole-table CHECK rebuild；用 synthetic active loss 代替真实 HAPI loss 的证据。
- **纯证明缺口：** 外部 CLI 的真实 argv/env/prompt/cwd/resume/status/session 合约；真实 remote completion；同一路径 active loss；terminal-first/loss-first；restart/concurrent endpoint；STD-602-9/10。
- **置信度：** 对静态行为与结构冲突为高；对真实 `hapi-remote-session`/HAPI 行为不作主张。

## 下一步性质

无需新增设计裁决即可否定 `8e9642c` 的 T7 完成性。只有外部 CLI 合约和真实 HAPI E2E 仍需调查。本报告不提出实现方案、规模或 issue 重拆。

---

# B. 证据附录

## B1. 稳定设计逐条对照

| 稳定 T7 条款 | 结果 | 证据与边界 |
|---|---|---|
| runner domain 为穷尽 `local-process|external-terminal` | **静态符合** | `8e9642c:src/runner-execution.ts:4-17` 穷尽三种 local 与 HAPI。 |
| scheduler availability 只消费 domain ADT | **大体静态符合** | `scheduler.ts:545-552,1314-1374` 不按 HAPI 名称 probe；invocation builder 仍 HAPI 特判。 |
| coder-loop 无 HAPI HTTP/session-server 实现 | **静态符合** | 变更引擎文件只含 binary/probe/headless；外部 CLI 真实边界未验证。 |
| probe 为字面量 `probe`，结果 typed | **静态符合但有分类缺陷** | `runner-execution.ts:19-128`；0/69/other/signal/deadline 分开。但所有 child `error` 都映为 executable-missing，不只 ENOENT。 |
| 创建接受 durable item，立即 hold/warn | **部分符合，有 crash window** | `daemon.ts:2866-2894,3232-3271` 先提交 item，再异步 probe/另一次 store write；正常 reply 前 await，但中间崩溃会暂留无 hold durable item。 |
| gate 位于 worktree/run/attempt/credential/session/artifact/process 前 | **候选调度路径符合** | `scheduler.ts:1088-1098` 先 availability/capability gate。 |
| absent 不改 preset status/attempt/backoff | **覆盖路径符合** | hold 只进 `item.extra`；历史 integration 断言零 run/current/attempt/backoff/artifact。 |
| restore 后自动真实执行 | **明确偏离** | HAPI capability 是 probe-only；恢复只产生 `runner.invocation_pending` (`runner-execution.ts:19-28`; `scheduler.ts:1361-1375`)。 |
| 真实 HAPI 收到完整 prompt/cwd/status/resume/auth | **明确偏离** | `loop.ts:6962-7014` 返回 pending，并抛 “pending the #603 invocation contract”。 |
| completion/failure/retry/resume/status 同构 | **对真实 HAPI 不可达** | generic local pipeline 存在；HAPI进不去；`parseSessionIdFromRunnerStream("hapi")` 返回 null (`loop.ts:7262-7267`)。 |
| active loss 走同一真实 HAPI route | **不可达/偏离** | loss latch 代码存在，但无法产生真实 active HAPI run。 |
| terminal-first/loss-first total order | **有模型，无生产证明** | close 读取 durable loss latch；真实 HAPI 路径不可达。 |
| status/events/holds 可观察 | **synthetic/persisted state 静态符合** | `loop.ts:3429-3463,3549-3584`；不能报告真实 active HAPI。 |
| endpoint identity 含 kind+binary+probe argv | **仅因 argv 固定而等价** | dedup/clear 实际 key 为 kind+binary，argv 固定 `['probe']`；若 argv 可变会混淆。 |
| per-task-closure worktree、retry复用、consumed 后回收 | **相对 current main 偏离** | 历史以 slot 为 owner；详见 B4。 |
| 真实 remote-session E2E | **缺失** | 历史脚本以 `zero-hapi-spawn` 结束；稳定条款禁止 fake-only 替代。 |
| 本地 runner 不回归 / 完整卫生 | **证据不足** | focused fake tests 不等于 STD-602-9/10；本调查未运行 candidate/merge-base gate。 |

## B2. `8e9642c` 完整生产调用链

### 声明、解析、存储

- runner boundary/type：`8e9642c:src/loop.ts:403-408,891` 扩为 `claude|codex|opencode|hapi`。
- CLI/preset parser：`loop.ts:2105-2124,5111-5113` 接受 HAPI。
- resolved command：`loop.ts:5334-5358` 默认 binary=`hapi-remote-session`，允许 model/extraArgs。
- SQLite：`sqlite-state.ts:511,539,688` 扩宽 `items.runner` 与 `closure_sessions.runner_kind` CHECK；task runtime session boundary 也接受 HAPI。

### probe、选择、hold、恢复、公平性

- `gateResolvedRunnerAvailability` 只 probe external domain (`runner-execution.ts:116-128`)。
- add/batch-add/update 在持久化后调用 daemon refresh (`daemon.ts:2866-2955,3198-3271`)。
- candidate gate 在历史 slot worktree/run/attempt 等之前 (`scheduler.ts:1088-1098`)。
- absent：写 typed hold，跨所有 item 扫描同 endpoint warning，emit warning，返回 false (`scheduler.ts:1314-1356`)。
- available：清所有同 runner+binary hold，emit 一次 restoration (`scheduler.ts:1347-1394`)。
- held candidate 从 `remainingCandidates` 移除，当前 repo 后续 runnable item 可继续 (`scheduler.ts:611-634`)；这只证明相关公平性，不外推新的阻塞保证。

### invocation、退出、status、retry/resume

- `runnerInvocationCapability("hapi")` 是 probe-only (`runner-execution.ts:19-28`)。
- `buildRunnerInvocation` 对 HAPI 返回 pending，HAPI switch 抛错 (`loop.ts:6962-7014`)。
- 所以 `scheduler.ts:1222` 的 generic spawn 与随后 status artifact/admission 对 HAPI不可达。
- generic resume 从 item+phase+runner 取 session (`scheduler.ts:1107`)，close 时更新 (`scheduler.ts:1759-1776`)；HAPI stream session parser 固定 null。
- 普通 stdout/HAPI private response 没有旁路推进；问题是根本没有真实 HAPI 写回。

### 运行中 loss 与 daemon recovery

- tick probe active external run；不再 available 时写 item hold 与 durable `run.extra.externalTerminalLoss`，revoke credential、清 session、TERM/KILL (`scheduler.ts:545-594`)。
- close handler 让 durable loss latch 胜过普通 status，恢复 pre-run status/phase/attempt，不进 blind backoff (`scheduler.ts:1646-1761`)。
- startup 在 generic orphan reconciliation 前特殊消费已 latch loss (`daemon.ts:2348-2399`)。
- **证明边界：** 机制静态存在，但 HAPI 无法 active；测试注入的 active state 不能转化为真实路径证明。

## B3. 三类状态 ADT、入口与消费者

### ADT 分离

- endpoint absence/probe failure：`unavailable(binary-missing|endpoint-unavailable)` 与 `probe-failed(unexpected-exit|signal|deadline-exceeded)`。
- transient/ordinary spawn failure：仍为 scheduler `spawn_failed` + backoff，不编码成 availability。
- active loss：独立 durable `ExternalTerminalLossFact`，含 `terminationPhase=term|kill|closed`。

这三类在内部 shape 上不混淆；但 probe child 任意 `error` 被误标 binary missing，且额外的 `invocation-pending` 本身与稳定“available⇒真实 invocation”冲突。

### 穷尽入口/旁路/消费者

已核查：

- `loop.ts` runner boundaries、CLI/preset parsing、runner commands、invocation、environment/sandbox/runtime surfaces、stream text/session parser、status wire；
- `runner-execution.ts` domain/capability/probe decode；
- `sqlite-state.ts` items/closure-session CHECK、row boundary、migration、session read/write；
- `daemon.ts` add/batch/update refresh、scheduler event translation、startup recovery；
- `scheduler.ts` item与chain-complete gate、active probe、close、retry/backoff；
- `runtime-data.ts` hold/current/loss codecs；
- `observability.ts` event schema/renderer；
- `loop.ts:3429-3584` queue/current status consumers。

switch 总体显式；核心缺陷不是遗漏 variant，而是完整实现了错误 variant `probe-only`。Current main 的 runner 与 closure-session authority 均已恢复三元 (`src/loop.ts:402,885`; `src/sqlite-state.ts:459,741`)。

## B4. worktree/session 生命周期：历史与 #749 current main

### 历史 owner

`8e9642c`：

- scheduler slot 持有 `worktreePath` (`scheduler.ts:1071-1099`)；
- path/branch 由 repo slot 导出 (`scheduler.ts:945-1048`)；
- run.extra 只复制该路径；
- session 用 item+phase+runner 寻址；
- cleanup 是 slot/chain cleanup；
- 没有 reachability graph 或 durable consumption intent 决定 closure 是否可回收。

历史虽已有 `task_closures` 表，实际资源 owner 仍是 slot，这是与 current main 竞争的事实源。

### current owner

`699842e`：

- closure-derived path/branch：`src/closure-lifecycle.ts:107-130`；
- engine/retired/migrated/foreign ownership：`:132-167`；
- repo Git coordinator/singleflight：`:188-220`；
- reachability seeds/edges：`:6-87`；
- scheduler 按 closureId first-open/reopen，并 `recordRunWithClosureResources`：`src/scheduler.ts:1565-1640`；
- run durable identity=`closure_id/runtime_node_id`，`setCurrentRun` 校验 identity/lifecycle/单 active run：`src/sqlite-state.ts:1945-1965`；
- active/suspended/consumed 转移、consumed 清 session：`:1985-2031`；
- unreachable assessment + consumption intent 后才 cleanup：`scheduler.ts:1428-1523`；
- startup audit/repair missing/retired/orphan resource 并保护 unpublished branch：`:999-1172`。

### reconcile 冲突点

历史 runner vocabulary/probe 可分离；以下不可整块复用：

- `spawnSchedulerRun` resource preparation 与 current `recordRunWithClosureResources`；
- runs/active_runs 的 closure/runtime-node identity；
- `closure_sessions` 的 closure owner；
- `setClosureLifecycle`、`assessClosureConsumption`、`consumeClosureIfUnreachable`；
- reachability seed/edge 与 migration gates；
- closure cleanup/reconciliation/Git coordinator；
- delete/stop/recovery 对 closure 的 consume/reconcile 路径。

同一 closure retry/resume 的 current 复用与 consumed 后清理已有明确 owner；历史 slot owner 会绕过这些 invariant。

## B5. SQLite、事务、锁与崩溃窗口

### schema/migration 兼容

历史扩宽 `items.runner`、`closure_sessions.runner_kind`，通过解析 `sqlite_master` 和 whole-table rebuild 迁移 (`8e9642c:src/sqlite-state.ts:851-1027`)。Current main 新增/重建 reachability、consumption intents、run closure identity，并把 `items.session_ids` 迁到 closure sessions (`src/sqlite-state.ts:974-1118`)。历史 whole-table 定义是旧组合；直接重放可能遗漏/破坏 current columns、CHECK、FK、run identity、reachability/intent 关联。历史 migration tests 只证明历史组合。

### 事务与锁

- 每个 store mutation 是同步 `db.transaction(fn).immediate()` (`8e9642c:src/sqlite-state.ts:1527-1533`)；schema migration 也是 immediate transaction。
- probe 在 SQLite 外；item commit、hold write、warning append、restoration clear、loss latch、credential revoke、process termination不是单事务。
- warning dedup 是 scan-then-write，没有 DB uniqueness constraint。

### crash/race

- create commit 与 post-probe hold 之间 crash：durable item 暂无“立即”hold。
- successful probe 与 spawn 之间 endpoint 可丢失；历史又无真实 invocation 可测其表现。
- active loss 先 durable latch，再 await warning，这是正面资产；startup 有专门恢复。
- restoration 先 clear hold，随后 HAPI停在 pending，可永久呈现 restored 但无 run。
- 历史 slot cleanup 不具 current consumption intent/reconciliation 的 crash recovery。

## B6. 队列与阻塞传播（仅稳定条款范围）

- held item 不占 repo slot，后续 candidate 可在同 tick 被选 (`8e9642c:src/scheduler.ts:611-634`)。
- hold 不改 preset status，所以 dependency/block propagation 仍见原 status；历史没有新增特殊传播语义。
- chain-complete external phase 也在 trigger side effect 前 gate (`scheduler.ts:2406-2470`)。
- warning 全局去重不等于 hold 全局化；每个 item 自存 hold，`queue.holds[]` 列出所有当前 hold。
- 未运行实验，不主张更强 starvation/dependency 保证。

## B7. tests / integration fixture 的证明边界

### 覆盖的机制

历史 tests 覆盖：probe ADT/字面 executable、pre-side-effect gate、本地 runner 不 probe、held candidate 让位、restoration、loss latch/revoke/terminate、terminal-first/loss-first、warning dedup、status projection、startup loss recovery、HAPI CHECK migration。这些可作为 focused regression 线索。

### 与代码共同偏离

- `tests/unit/loop/external-terminal.test.ts` 明确期待 HAPI=`invocation-pending`。
- `tests/integration/scheduler/external-terminal.integration.ts` 首测即 “invocation-pending external terminal releases the repo slot…”；restoration 验证了错误终点。
- `scripts/external-terminal-integration.ts:19-23,421-449,526` 明写恢复到 pending “without HAPI spawn”，PASS=`zero-hapi-spawn`。
- active-loss tests 构造/替代 active external state；HAPI 无法 spawn，所以不满足“同一真实 hapi 路径”。

### 盲区

无真实 HAPI machine/session；无 verified CLI contract；无 HAPI `status.json` admission；无 #749 closure reuse/consume；无真实 concurrent endpoint；无 candidate/merge-base STD-602-9/10；focused local fake tests 不足以证明 missing-binary/spawn/attempt/resume 全不回归。

## B8. 资产分类与具体触点

### 可保留（隔离后）

- `src/runner-execution.ts` execution-domain/probe ADT（child error 分类仍需事实裁定）；
- `runtime-data.ts` hold/current/loss shape（需绑定 current closure/run identity）；
- observability/status vocabulary（需穷尽 current schema consumers）；
- probe/fairness/race test ideas（不是验收证据）。

### 必须 reconcile

- `src/loop.ts`：runner boundary、CLI/preset parser、command resolution、invocation、env/sandbox/runtime surfaces、stream/session/status；
- `src/task-runtime.ts`：closure session runner ADT；
- `src/sqlite-state.ts`：CHECK/boundary/migration/run identity/consumption；
- `src/scheduler.ts`：candidate/chain-complete gate、closure resource、active loss、close、consume/cleanup；
- `src/daemon.ts`：add/batch/update、events、startup recovery、delete/stop；
- `src/runtime-data.ts`、`src/observability.ts`；
- tests/fixture 全部需对真实 invocation 与 current closure owner 复核。

### 负资产

- `RunnerInvocationCapability=probe-only`、`runner.invocation_pending` production gate；
- HAPI invocation throw；
- `zero-hapi-spawn` script；
- slot worktree/branch owner；
- item-scoped session owner；
- historical whole-table migration replay；
- synthetic loss 充当 real-HAPI loss proof。

## B9. 静态未知与可复现实验要求

1. **外部 CLI 合约：** immutable `hapi-remote-session` candidate 上核实 run argv、probe readiness、prompt transport、cwd、auth、resume/session ID、exit/status timing/schema。
2. **真实 remote lifecycle：** isolated daemon + isolated loop-data + real CLI + real HAPI machine，观察真实完成与 `status.json` admission。
3. **loss ordering：** 同一 production invocation 路径可控 endpoint loss，分别复现 terminal-first/loss-first，不能绕过 scheduler/run ledger。
4. **closure semantics：** retry/resume 观察相同 closureId/path/session；consumed 后观察资源清除；stop/delete/restart 按 current closure authority 保留或消费。
5. **local regression：** 最终 immutable candidate 执行 STD-602-9 与 candidate/live-merge-base STD-602-10。

## B10. 证据索引

- 设计：`AGG-548.md:151-275,285-294,350-362`。
- 历史 probe/domain：`8e9642c:src/runner-execution.ts:1-128`。
- 历史 runner/invocation：`8e9642c:src/loop.ts:403-408,891-916,5334-5358,6451-6477,6962-7113,7262-7267`。
- 历史 scheduler：`8e9642c:src/scheduler.ts:545-634,1071-1407,1536-1850,2406-2470`。
- 历史 daemon：`8e9642c:src/daemon.ts:763-875,2348-2399,2866-3271`。
- 历史 SQLite：`8e9642c:src/sqlite-state.ts:422,511-702,851-1027,1527-1533,1723-1736,1917-1918`。
- 历史 status/events：`8e9642c:src/loop.ts:3429-3584`; `8e9642c:src/observability.ts:82,576-607,1168-1169`。
- 历史 proof limit：`8e9642c:scripts/external-terminal-integration.ts:19-23,421-449,526`。
- current closure owner：`src/closure-lifecycle.ts:6-220`; `src/scheduler.ts:999-1172,1428-1523,1565-1773`; `src/sqlite-state.ts:459,677-760,974-1118,1945-2039`。
- current three-runner boundary：`src/loop.ts:402,885`; `src/sqlite-state.ts:459,741`。

## B11. 完成自检

- [x] 摘要与证据附录分层。
- [x] 覆盖调用链、T7逐项、ADT、事务/锁/crash、fairness、closure lifecycle、SQLite、tests、资产分类、未知。
- [x] 真实 HAPI 未验证处明确标注，不臆测。
- [x] 未写实现方案、规模、issue 重拆；未修改产品代码/测试/配置/数据库/WORKFLOW。
- [x] 尾部完整，非截断。
