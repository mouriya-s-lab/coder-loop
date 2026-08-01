# #588 feat(daemon): observer hook 执行——事件订阅派发与异步脚本执行层

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:44Z  | updated: 2026-07-17T20:41:00Z
- closed: 2026-07-17T20:41:00Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/588
- comments: 2  | timeline events: 15

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "**observer**：订阅生命周期事件，异步旁路执行，不影响调度；失败只记 diagnostic 事件。挂点 = observability 事件类型枚举（hook 点清单不另发明命名，直接复用事件类型词表；事件枚举扩张时 observer 挂点面自动扩张）。" — #543 核心设计·两类 hook

> "hook = 任意可执行文件。输入：全量元数据 JSON 经 stdin。输出：gate hook 经 stdout 返回 decision JSON……observer 无输出契约。" — #543 执行模型

> "**hook 身份**：operator 全权——hook 子进程无凭证调 CLI，走操作员路径，不新增第三类主体。" — #543 设计裁决 3

> "hook 执行不得阻塞 daemon 主线程（禁止 `Bun.spawnSync` 形态；survey §2 已点名该债，不新增）。" — #543 约束

> "hook 执行自身进入事件流：新增 `hook.*` 事件类型（执行开始/结束/失败/gate decision），使 hold 状态与 hook 故障对 `status --json` 与 GUI（RFC-5）可见。" — #543 可观测性

## 目标

observer hook 端到端执行：事件发射点派发 → 异步 spawn 脚本 → stdin 写 payload → 超时回收 → 失败只记 diagnostic；同时建立 observer/gate 共用的 hook 进程执行层（spawn/stdin/超时/并发语义）。

## 使用场景

- operator 声明 observer 订阅 `agent.exit` 后，每次 agent 退出脚本被调起、stdin 收到全量元数据——通知、日志转发、统计类旁路自动化零引擎改动可挂。
- #589（gate 执行） 复用本 child 的进程执行层，只叠加 stdout decision 协议——执行层语义（互斥、超时、回收）一次裁决两类共用。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- 事件发射链：scheduler `emit`（`src/scheduler.ts:2299`，经 `SchedulerOptions.onEvent`，声明 `src/scheduler.ts:320`）→ daemon 接线点（`src/daemon.ts:2975`）→ `recordObservabilityEvent`（`src/daemon.ts:1674`）——observer 派发挂事件记录后沿。
- 异步进程先例：agent spawn 用 `node:child_process` 的 `spawn`（`src/scheduler.ts:1062`）；超时回收组信号 `sendSignalToChildProcessGroup`（`src/scheduler.ts:1673`，attempt timeout 主路径 `src/scheduler.ts:1468` SIGTERM→SIGKILL）——hook 子进程复用同族机制。
- `Bun.spawnSync` 现存非 test 命中 7 处（`src/daemon.ts:3943/3994/4097`、`src/loop.ts:3297/3978/3986`、`src/scheduler.ts:2475`，均为同步 shell 探针）——#543 约束禁止 hook 路径新增该形态。
- daemon tick 单飞：in-flight Promise（`src/daemon.ts:823`）+ 重入折叠（`src/daemon.ts:2867-2878`）——observer 派发不得使 tick 等待脚本。
- 声明来源：#586（声明模型） 的生效视图；payload 来源：#587（payload 契约） 的组装函数。

## 问题

声明模型与 payload 契约落地后，事件仍不触达任何脚本——#543 关闭验证行 1（observer 被调且元数据经 stdin）无机制承载；且 observer/gate 共用的「异步 spawn + stdin + 超时 + 并发语义」执行层不存在，gate children 无地基。

## 预期结果

性质表述：

1. **派发性质**：生效视图中订阅了事件类型 E 的每个 observer，在 E 发射时被异步 spawn（fire-and-forget）：调度路径不等待其完成、不消费其退出码；tick 时长不随 observer 数量与脚本时长增长。
2. **payload 经 stdin**：消费 #587（payload 契约） 的组装函数写入 stdin；任意可执行文件可消费（不要求特定语言/运行时）。
3. **超时与失败语义**：每 hook 声明超时生效（SIGTERM→SIGKILL 组信号回收）；observer 失败（非零退出/超时/spawn 失败）只记 diagnostic 事件——不影响调度、不重试、不升级。
4. **hook.* 事件**：hook 执行开始/结束/失败进入事件流（`ObservabilityEventTypeBoundary` 枚举扩张，经既有边界），含 hook 标识与触发事件关联键。事件发射路径对 `hook.*` 类型零 observer 派发（与#586（声明模型） 的自反挂点装载拒绝构成双层防护——自激励回路在声明期与发射期都不可表达）。
5. **零同步阻塞**：hook 路径无 `Bun.spawnSync` 新增；spawn/stdin 写入/回收全部异步。

### 显式决策项（落地时裁，裁决留本 thread）

- RFC 开放问题逐字："同一挂点多 hook / 跨 chain 并发触发同一脚本的互斥与重入语义。"——执行层公共语义，gate children 继承本裁决。

## 不应残留

- 本 child 范围内：observer 失败使调度失败/停摆的任何路径；调度侧同步等待脚本的点；`Bun.spawnSync` 新增。
- 本 issue 范围之外不应改动：gate 的 stdout decision 协议与 hold（归 #589（gate 执行））；hook 声明 schema（归#586（声明模型））；payload 契约（归 #587（payload 契约））；#534 audit 树正在修的 v2 缺陷。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 不阻塞 daemon 主线程（#543 约束逐字，见继承快照）。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 触同一批 `src/scheduler.ts`/`src/daemon.ts` 面，默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | observer 被调且 stdin 收 payload（RFC 行 1） | 声明 observer 订阅 `agent.exit`（fixture 脚本把 stdin 落文件），真跑一个 run | local | 脚本收到含该 run 元数据的 JSON；调度不受影响 |
| function | 失败只记 diagnostic | 必崩脚本 + 超时脚本各声明一个，真跑 | local | diagnostic 事件在场且点名 hook；调度照常推进；无重试 |
| function | 异步旁路 | 声明 sleep 长于 tick 间隔的慢脚本，观察 tick 事件节奏 | local | tick 节奏不被拉长；脚本与调度并行 |
| function | hook.* 事件（RFC 行 6 observer 份额） | 跑上述场景后查事件流 | local | 每次执行有开始/结束/失败事件，关联键可回溯触发事件 |
| function | 自反回路双层防护 | 事件发射路径对 `hook.*` 类型的派发检查（单元）+ 声明期拒绝（#586（声明模型） 验收已覆盖，此处发射期半边） | local | `hook.*` 事件零派发 |
| assumption | 无 spawnSync 新增 | 对本 child diff 范围 `grep -n "spawnSync"` | local | 零新增 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #586（声明模型）（生效视图）、#587（payload 契约）（stdin 内容）。
- Blocks: #589（gate 执行）（复用进程执行层）。


---

## Comments (2)

### comment #4866575948 by `RiriAgent` — 2026-07-02T14:01:31Z


## 架构切片

1. **系统定位**：daemon 事件面的消费者扩展级——在既有「事件记录」后沿加「事件派发」，加上 hook 子进程执行单元（与 agent run 并列的第二类引擎管理进程，但生命周期语义更弱：fire-and-forget、无 attempt/预算/resume）。
2. **全局坐标**：引擎事件域（typed `ObservabilityEvent`）→ hook 子进程域（stdin JSON 投影，出站）。子进程对引擎的回程只有事件流可见的退出码/超时事实（observer 无输出契约）——不存在需要 parse 的入站值。
3. **类型↔值不漂移**：防类型泄露——observer 订阅匹配直接用事件类型 union，不建平行的「挂点名」映射表；事件词表扩张零 hook 侧同步。
4. **消除的错误类别**：「observer 故障拖垮调度」不可表达（旁路性质 + 失败只记 diagnostic）；「hook 自激励回路」不可表达（发射期零派发 + 声明期拒绝双层）；「同步阻塞主线程」在 hook 路径不可表达（无 spawnSync、异步 API）。

## log/观测义务

- 新增 `hook.*` 执行事件（开始/结束/失败）：kind 归 lifecycle/diagnostic 按事件性质分（失败 = diagnostic，与 #543 observer 失败语义一致）；经 `ObservabilityEventTypeBoundary` 编译期 union 扩张，全部消费点由 typechecker 暴露。
- observer 失败的 diagnostic 事件必须含 hook 标识、触发事件类型、失败原因分类（非零退出/超时/spawn 失败）——headless 排障的最小字段集。



### comment #5007298313 by `RiriAgent` — 2026-07-17T20:40:59Z

重新拆分后由 #711 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (15)

- 2026-07-02T12:02:45Z `assigned` @RiriAgent
- 2026-07-02T14:00:50Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T14:00:51Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:17Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:31Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-11T08:33:36Z `referenced` @RiriAgentcommit=6bad6fcea488533dd230d4a26548957ddf0eec69
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:19Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:40:59Z `commented` @RiriAgent
- 2026-07-17T20:41:00Z `closed` @RiriAgentcommit=None