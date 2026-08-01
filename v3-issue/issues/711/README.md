# #711 feat(daemon): observer hook 订阅派发与异步执行

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:18Z  | updated: 2026-07-27T01:00:16Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/711
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

只交付 observer 执行，不参与控制流。

observer hook 端到端执行：事件发射点派发 → 异步 spawn 脚本 → stdin 写 payload → 超时回收 → 失败只记 diagnostic；同时建立 observer/gate 共用的 hook 进程执行层（spawn/stdin/超时/并发语义）。

## 问题

声明模型与 payload 契约落地后，事件仍不触达任何脚本——#543 关闭验证行 1（observer 被调且元数据经 stdin）无机制承载；且 observer/gate 共用的「异步 spawn + stdin + 超时 + 并发语义」执行层不存在，gate children 无地基。

## 预期结果

性质表述：

1. **派发性质**：生效视图中订阅了事件类型 E 的每个 observer，在 E 发射时被异步 spawn（fire-and-forget）：调度路径不等待其完成、不消费其退出码；tick 时长不随 observer 数量与脚本时长增长。
2. **payload 经 stdin**：消费 #710（payload 契约） 的组装函数写入 stdin；任意可执行文件可消费（不要求特定语言/运行时）。
3. **超时与失败语义**：每 hook 声明超时生效（SIGTERM→SIGKILL 组信号回收）；observer 失败（非零退出/超时/spawn 失败）只记 diagnostic 事件——不影响调度、不重试、不升级。
4. **hook.* 事件**：hook 执行开始/结束/失败进入事件流（`ObservabilityEventTypeBoundary` 枚举扩张，经既有边界），含 hook 标识与触发事件关联键。事件发射路径对 `hook.*` 类型零 observer 派发（与#586（声明模型） 的自反挂点装载拒绝构成双层防护——自激励回路在声明期与发射期都不可表达）。
5. **零同步阻塞**：hook 路径无 `Bun.spawnSync` 新增；spawn/stdin 写入/回收全部异步。

### 显式决策项（落地时裁，裁决留本 thread）

- RFC 开放问题逐字："同一挂点多 hook / 跨 chain 并发触发同一脚本的互斥与重入语义。"——执行层公共语义，gate children 继承本裁决。

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

## 架构切片

1. **系统定位**：daemon 事件面的消费者扩展级——在既有「事件记录」后沿加「事件派发」，加上 hook 子进程执行单元（与 agent run 并列的第二类引擎管理进程，但生命周期语义更弱：fire-and-forget、无 attempt/预算/resume）。
2. **全局坐标**：引擎事件域（typed `ObservabilityEvent`）→ hook 子进程域（stdin JSON 投影，出站）。子进程对引擎的回程只有事件流可见的退出码/超时事实（observer 无输出契约）——不存在需要 parse 的入站值。
3. **类型↔值不漂移**：防类型泄露——observer 订阅匹配直接用事件类型 union，不建平行的「挂点名」映射表；事件词表扩张零 hook 侧同步。
4. **消除的错误类别**：「observer 故障拖垮调度」不可表达（旁路性质 + 失败只记 diagnostic）；「hook 自激励回路」不可表达（发射期零派发 + 声明期拒绝双层）；「同步阻塞主线程」在 hook 路径不可表达（无 spawnSync、异步 API）。

## log/观测义务

- 新增 `hook.*` 执行事件（开始/结束/失败）：kind 归 lifecycle/diagnostic 按事件性质分（失败 = diagnostic，与 #543 observer 失败语义一致）；经 `ObservabilityEventTypeBoundary` 编译期 union 扩张，全部消费点由 typechecker 暴露。
- observer 失败的 diagnostic 事件必须含 hook 标识、触发事件类型、失败原因分类（非零退出/超时/spawn 失败）——headless 排障的最小字段集。

## 依赖关系

- Depends on: #586、#710。
- Blocks: #715。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:19Z `assigned` @RiriAgent
- 2026-07-17T20:38:27Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:39:34Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:00Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-26T16:15:00Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-26T23:49:10Z `cross-referenced` @RiriAgentsrc=712