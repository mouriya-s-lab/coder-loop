# #565 feat(engine): 子树取消向下传播

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:15:58Z  | updated: 2026-07-17T20:15:02Z
- closed: 2026-07-17T20:15:02Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/565
- comments: 1  | timeline events: 11

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）。继承条款逐字快照：

> "**取消向下传播**：cancel 任一子树 → 终止其全部下属 run（SIGTERM→SIGKILL，复用现有看门狗路径）+ 未启动 item 落取消终态。" — #546 body「取消与错误传播」

> "错误向上归 join 消化：子任务失败（exhausted 等非 success 终态）不自动传播。" — #546 body「取消与错误传播」（取消向下、错误向上，两方向不对称是有意设计）

> "机制/参数分离（#396 契约延续）……状态字面量……均不在引擎，归 preset/元数据声明" — #546 body「关闭验证」行 10

闭包生命周期约束：取消终止执行并写取消终态，但**不得自动等同闭包已完全消费**。被取消闭包是否仍可能被上层 reopen/动态控制流重新命中，由 #560 的消费谓词判断；谓词成立前 worktree/分支/session 均保留。

## 目标

对任务树任一子树的取消操作：向下传播终止全部下属活 run（SIGTERM→SIGKILL 复用看门狗路径），未启动 item 落取消终态，兄弟子树不受影响；取消本身不触发 GC，闭包只有在 #560 消费谓词随后成立时才进入 consumed 并回收。

## 使用场景

operator 发现某个并行分支方向错误/失控时，按节点粒度取消该子树（单 leaf、整个 par、整段 seq），其余分支照常推进——现状只能停整条 chain 或杀 daemon。取消后的容器按失败终态归外层 join 消化（validator 可见、drain 照常放行）；取消只终止执行，不回收已创建闭包，GC 等待消费谓词。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- 击杀路径先例：attempt 超时 SIGTERM→SIGKILL（`src/scheduler.ts:1425-1464` 附近，`sendSignalToChildProcessGroup`、`attemptKillMs`）；回收窗口 SIGKILL（#452）。本 child 复用同一进程组信号路径，不另造击杀机制。
- 引擎写终态先例：`[statuses].exhausted` 由 preset 声明字面量、引擎在预算耗尽时写入（`src/scheduler.ts:1966` 附近）——取消终态跟随此形态：引擎写入、字面量来自声明。
- 现有停止面：`chain stop`（chain 级）、`daemon stop`（进程级）——均无子树粒度。
- 命令鉴权分级：`DaemonCommandAuthClass`（`src/daemon.ts:127`），新命令进编译期穷尽分类（#409）。
- 树结构与容器状态归 #558（树运行态 shape）；调度遍历归 #559（树调度）。
- **消费与 GC**归 #560：本 child 只终止执行并写取消终态，不删除 worktree/分支、不清 sessionIds。后续仅当消费谓词成立时由 #560 consume。

## 问题

取消粒度只有整 chain / 整 daemon：无法取消一个子树而保留兄弟；活 run 的中途终止只存在于看门狗（超时）路径，没有 operator 主动按节点触发的通道；「未启动 item 落取消终态」所需的终态字面量没有声明位；取消与消费目前未分层，容易把取消误接为 GC；#546 行 9 的取消传播缺少“取消不等于 consumed”的约束。

## 预期结果

- 性质：对任一节点的 cancel 使其整个子树到达终结——
  - 全部下属**活 run**被终止（SIGTERM→SIGKILL，复用看门狗信号路径与事件形态）；
  - 全部**未启动 item**落取消终态；
  - 容器节点落取消终结；
  - 子树内已 create 的闭包停止执行但环境原地保留；取消不证明 consumed，不触发 GC；从未 create 的 item 只落取消终态；
  - 子树外的节点（兄弟、祖先的其他分支）零影响——兄弟闭包不动、兄弟活 run 不中断、兄弟未启动 item 不落取消终态。
- 取消不上溯：被取消子树对外层呈现为失败终态，归外层 join 消化（drain 照常放行、validator 可见），不自动传播失败。
- 取消终态字面量不驻留引擎：跟随 `[statuses].exhausted` 先例——引擎写入、字面量来自声明；声明键名与声明位（preset statuses / chain 元数据）为本 child 显式决策项，落地时裁并登记在本 issue（声明语法与 #547 编译面协同）。
- 幂等：对已 terminal 子树 cancel 为 no-op（成功返回，无副作用）——闭包取消状态不重复写；活 run 已被杀过的不重发信号。
- 授权：cancel 是 mutation，进 #409 编译期穷尽分类；主体分级（operator 恒可；agent 是否可取消自身作用域）为本 child 显式决策项，落地时裁并登记。
- 每次 cancel 留审计事件（请求 + 每个被终止 run 的终止事件 + 每个被取消 run 的状态事件）。

## 不应残留

- 本 child 范围内：绕开看门狗信号路径的第二套击杀机制；引擎源码驻留取消终态字面量；取消向上传播（取消子树连带祖先失败）的路径；取消路径直接删闭包分支/清 sessionIds/发消费证据（GC 只能由 #560 的 consumed 转移触发）。
- 本 issue 范围之外不应改动：不动 join 评估对失败终态的消化逻辑（归 #561（join 评估））；不动 chain stop / daemon stop 既有语义；不实现消费谓词与 consumed 后 GC（归 #560）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 取消向下传播（#546 行 9） | cancel 一个含 1 活 run + 1 未启动 item 的子树，`ps` 验证进程、查 items 终态 | local | 活 run 进程组消失（SIGTERM→SIGKILL 事件可见）；未启动 item 落取消终态 |
| function | 取消不触发 GC（活跃闭包） | 取消活跃 run 后核对闭包状态、目录、分支、sessionIds | local | run 已停止、取消终态已写；worktree/分支/sessionIds 仍在；无消费证据 |
| function | 取消不触发 GC（挂起闭包） | 取消包含挂起闭包的子树 | local | 闭包保持可恢复环境；目录/分支/sessionIds 仍在；仅消费谓词成立后由 #560 回收 |
| function | 未 create 过闭包的 item | 子树内含从未启动的 item（无闭包记录），取消该子树 | local | 落取消终态；无 consume/GC 调用 |
| function | 兄弟零影响（#546 行 9） | 上一行的树中并行兄弟子树带活 run 与已挂起闭包 | local | 兄弟 run 不中断、照常推进到 terminal；兄弟挂起闭包环境与状态均不变 |
| function | 失败归 join 不上溯 | 被取消子树所在 par 的 join=drain 与 join=validator 各跑一次 | local | drain：全员 terminal 后照常放行；validator：判定输入可见被取消成员 |
| function | 幂等 | 对已 terminal 子树重复 cancel | local | no-op 成功返回，无新副作用；不重发信号、不重复写取消状态；GC 仍只由 consumed 触发 |
| function | 授权分级执法 | 主体分级决策项裁定后，以未授权主体（按裁决为 agent 或越作用域凭证）发 cancel | local | 被拒 + 审计事件；行为与本 issue 登记的裁决一致 |
| assumption | 终态字面量不驻留引擎（#546 行 10 切片） | 决策项裁决后 `grep -rn "<取消终态字面量>" src/` | local | 引擎零命中；字面量仅存在于声明（preset/元数据）与测试 fixture |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #558（树运行态 shape，子树寻址、容器终态表示、闭包状态表）、#559（树调度，取消后调度视图一致）、#560（消费谓词与 consumed 后 GC；取消本身不触发）。
- Relates to: #549（编译管线——取消终态声明键跟随 `[statuses]` DSL 现有位，落地时裁定后由编译产物承载）、#554（phase 树声明面装载期检查——终态键名合法性校验按 `[statuses]` 现有校验形态同层承接）。


---

## Comments (1)

### comment #5007118372 by `RiriAgent` — 2026-07-17T20:15:01Z

重新拆分后由 #704 承接子树取消向下传播。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (11)

- 2026-07-02T11:16:00Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:11Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-17T20:13:30Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-17T20:15:01Z `commented` @RiriAgent
- 2026-07-17T20:15:02Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739