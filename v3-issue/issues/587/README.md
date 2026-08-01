# #587 feat(engine): hook 全量元数据 stdin payload——编译产物投影与运行态快照契约

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:42Z  | updated: 2026-07-17T20:40:58Z
- closed: 2026-07-17T20:40:58Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/587
- comments: 2  | timeline events: 17

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "hook = 任意可执行文件。输入：全量元数据 JSON 经 stdin。" — #543 执行模型

> "**RFC-2（#547，已答）**：hook「全量元数据」= #547 编译产物投影 + 运行态快照，不另造第二套 shape；preset 级具名抽象 gate 点的 DSL 声明位（命名、required/optional 标志）由 #547「DSL 演进面」第 7 项承载。" — #543 跨 RFC 接口假设

操作员目标（verbatim）：

> "举例一个场景：daemon 每一次运行都可以去跑某个脚本，跑脚本会把元数据都传进去，然后 hook 可以计算迭代进行了几轮。" — `v3/v3-goals.md` 目标 5

## 目标

hook stdin 的「全量元数据」typed payload 契约与单一组装函数：触发上下文 + #547 编译产物投影 + 运行态快照，三块类型全部从既有 schema 派生，零平行 shape。

## 使用场景

- hook 作者（operator 脚本）从 stdin 读一份结构稳定的 JSON：为什么被调（挂点与触发事件/决策点）、任务定义长什么样（编译产物投影）、系统现在什么状态（运行态快照）。操作员例子「计算迭代进行了几轮」从运行态快照的 runs 维度可得。
- observer 与 gate 两类执行 children 共用同一组装函数——payload 是 hook 作者的输入契约面，shape 稳定性等同 API 承诺。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- 编译产物：#549 的 CompiledTaskModel + JSON 六块（`preset` / `statuses`+`stateGraph` / `phases` / `tools` / `fragments` / `findings`，带 `schemaVersion`）——payload 编译产物半边从其 schema 派生。
- 运行态快照：`buildCoderLoopStatusSnapshot`（`src/loop.ts:2724`）经 `StatusSnapshotBoundary`（`src/loop.ts:490`）——快照 boundary 顶层匿名槽的收紧归 #574；#558 落地后快照含树结构节。payload 引用同一 boundary，上游演进自动传导。
- 触发上下文：`ObservabilityEvent` 信封（`src/observability.ts`，含 chain/item/runId/phase 关联键）——observer 的触发事件半边直接复用；gate 决策点标识引用#586（声明模型） 的决策点闭集类型。
- payload 经 stdin 传递（#543 执行模型）——与现状 prompt 经 argv（spawn 调用 `src/scheduler.ts:1062`）不同路径；stdin 写入侧归执行 children，本 child 只出契约与组装。

## 问题

#543 执行模型要求「全量元数据 JSON 经 stdin」，接缝已裁「不另造第二套 shape」；当前不存在任何面向 hook 的元数据组装函数——若各执行 child 各自拼 JSON，必然手写平行 shape，违反接缝裁决，且 hook 作者面对的输入形态随执行路径漂移。

## 预期结果

性质表述：

1. **单一组装路径**：存在唯一 payload 组装函数与 typed 契约，三块组成——触发上下文（挂点 + 触发事件或决策点标识 + 关联键）、编译产物投影、运行态快照；observer/gate 两类执行路径共用，不存在第二套拼装。
2. **零平行 shape**：编译产物半边的类型从 #549 产物 schema 派生；运行态半边从 `StatusSnapshotBoundary` 派生；触发事件半边从 `ObservabilityEventBoundary` 派生——上游 shape 演进（#558 树结构节、#574 boundary 收紧）自动传导到 payload，本侧零同步代码。 运行中实例的编译产物半边必须解引用 #605 pinned definition；不得重新编译同路径当前 preset。
   运行态半边的红线适配：`StatusSnapshotBoundary` 现存匿名 `"object"` 槽（#574 收紧 child）——**匿名槽不透传进 payload**（透传即违反「禁匿名形状」红线）；payload 只投影已具精确 boundary 的节，#574 收紧后投影面经派生关系自动扩张，本侧零改动。
3. **版本化**：payload 自带版本标识；shape 演进 bump，PR body 列 shape diff（#456 先例）。
4. **schema 可导出**：hook 作者可获知 payload 精确形态（schema 导出面；作者文档载体归#593（收尾））。
5. **闭包元数据投影**（#546 body「资源模型公理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §2）：闭包转移边事件（`closure.create` / `run-spawn` / `run-exit` / `suspend` / `reopen` / `consume`）作为 observer 触发事件时，payload 运行态半边须投影闭包元数据（生命周期态 活跃/挂起/已消费、worktree 路径、闭包分支、par pin commit、sessionIds）。事实源 = #558 闭包状态表（四视图共同事实源）——投影关系派生自其 shape，本侧零平行定义；#558 落地后自动扩张。
6. **引擎不注入 GitHub 面字段**（L1 红线 + 权威记录 `v3/closure-lifecycle-decision.md` §5 打回记录）：payload 任何半边不得包含 mergedness、mergeCommit、PR 状态等 GitHub 面事实——「引擎理解 GitHub 字段」违反 L1 红线（`gh-issue-pr-iteration` preset 判定器自查 GitHub 面才是正确通道，供给条款 3）；边界 1 会话打回主张「引擎注入 mergedness 进判定 payload」的形态，本 child 从第一天起不留后门。相关 script 判定器自查形态见 #592。

### 显式决策项（落地时裁，裁决留本 thread）

- 编译产物投影的切片范围：全量六块 vs 按挂点相关切片（如 run 级挂点只投影所属 preset 的 phases 块）——「全量元数据」语义与 payload 体积的平衡。
- 无 chain/item 上下文的挂点（daemon startup/shutdown、tick）的运行态快照范围——与#590（决策点闭集） 协调（其 body 同步登记）。

## 不应残留

- 本 child 范围内：手写的 payload 平行 shape（任何字段与上游 schema 重复定义）；执行 children 可绕过的第二套组装入口。
- 本 issue 范围之外不应改动：stdin 写入与进程 spawn（归 #588（observer 执行））；decision 协议（归 #589（gate 执行））；#549 产物 shape 本身；`StatusSnapshotBoundary` 的收紧（归 #544 child）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 接缝裁决逐字（#543 跨 RFC 接口假设）："hook「全量元数据」= #547 编译产物投影 + 运行态快照，不另造第二套 shape"——本 child 的实现不得引入独立维护的第三套元数据形态。
- payload 是 hook 作者消费契约：shape 变更走版本标识 bump。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | payload 三块齐全且过 schema | 单元测试：fixture chain/run 组装 payload 后经边界 schema 校验 | local | 触发上下文/编译产物投影/运行态快照三块在场；校验通过；版本标识在场 |
| function | 操作员场景数据面 | 单元测试：多 runs fixture 下从 payload 运行态半边数出目标 item 的 run 次数 | local | 「计算迭代进行了几轮」可从 payload 得出 |
| type | 零平行 shape | 类型级断言 payload 类型由三个上游 schema 派生；`grep` 无重复字段手写定义 | local | 派生关系成立；无平行 shape |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |
| integration | stdin 端到端交付 | 登记：由 #588（observer 执行） 的「脚本收到含 run 元数据 JSON」验收行接管（本 child 落地时点为单元级） | local | — |

## 依赖关系

- Depends on: #549（编译管线 child 的产物 schema 是定义态投影半边的派生源）、#574（收紧后的 `StatusSnapshotBoundary` 是运行态投影半边的精确派生源；匿名 object boundary 不得作为完成态）、#605（运行实例的定义态投影必须来自 pinned definition）。
- Blocks: #588（observer 执行）、#589（gate 执行）。
- 协调边：#558（树运行态快照节落地后 payload 经性质 2 自动含树，零本侧工作）。#574 已提升为合并前硬依赖。


---

## Comments (2)

### comment #4866575713 by `RiriAgent` — 2026-07-02T14:01:30Z


## 架构切片

1. **系统定位**：L1 引擎 hook 面的输入投影级——把引擎已有的两个 typed 事实源（定义态：编译产物；运行态：status 快照）加触发上下文合成为 hook 子进程的 stdin 契约。不新增事实源，只做投影合成。
2. **全局坐标**：引擎 typed 域（CompiledTaskModel / snapshot / event 信封）→ hook 子进程域（外部不可信消费者，经 stdin 收 JSON）。方向是 typed 域向外投影——无入站 parse 需求（hook 的回程通道是 gate stdout decision，归 gate child 的边界 parse）。
3. **类型↔值不漂移**：防值漂移——「全量元数据」若由各执行路径各自拼装即出现同值多副本失同步；单一组装函数封死。防类型泄露——payload 不得手写复制上游 schema 字段（从 schema 派生），上游演进零同步。
4. **消除的错误类别**：「hook 看到的元数据与 status/compile 输出不一致」不可表达（同源投影）；「执行路径间 payload 形态漂移」不可表达（单一组装）。

## log/观测义务

- 无新增运行期事件义务（payload 组装是纯函数面；组装失败随执行 children 的 hook.* 失败事件呈现）。



### comment #5007298129 by `RiriAgent` — 2026-07-17T20:40:58Z

重新拆分后由 #710 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (17)

- 2026-07-02T12:02:42Z `assigned` @RiriAgent
- 2026-07-02T14:00:53Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:56Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:16Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:30Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:06Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-02T16:08:44Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:19Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:40:58Z `commented` @RiriAgent
- 2026-07-17T20:40:58Z `closed` @RiriAgentcommit=None