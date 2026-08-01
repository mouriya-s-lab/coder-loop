# #589 feat(scheduler): script gate 执行与 decision 协议——run post-exit 决策点端到端

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:46Z  | updated: 2026-07-17T20:41:02Z
- closed: 2026-07-17T20:41:02Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/589
- comments: 2  | timeline events: 22

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）与 #546（RFC: v3 任务模型）。统一判定契约的唯一权威文本是 #546 body「join 策略与验证者判定」节（与 #546 树 children 共同引用，不复制不改写、不另立第二套词表），逐字引用：

> ```
> decision ::= advance                       -- 放行，外层 seq 推进
>            | hold                          -- 暂不放行，退避后重问（keep-active 语义）
>            | reopen(target, correctionItemIds) -- 退回并精确引用已创建的纠正 item
>              target      ::= self | 同一 seq 内更早的兄弟节点
>              correctionItemIds ::= 同 evaluation scope 下先经 CLI 创建、属于 target 的 item stable id，≥1
> ```

#543 继承条款逐字快照：

> "**gate**：挂在调度决策点上，逻辑 hold 住该宿主决策点（对应 run/item/container/chain/daemon/tick 的推进不发生）直到 hook 返回 decision；实现上异步 spawn 子进程，不阻塞 daemon 主线程与其他 chain 的调度。" — #543 核心设计·两类 hook

> "输出：gate hook 经 stdout 返回 decision JSON；容器点统一判定契约是 `advance | hold | reopen(target, correctionItemIds)`。corrections 先经带 evaluation scope 的 CLI 创建，decision 精确引用既存 item；stdout 不承载 mutation。非容器决策点声明期拒绝 reopen。" — #543 执行模型

> "每 hook 声明超时；超时/崩溃按其 `onFailure` 声明走 `hold`（该决策点退避重问，事件流可见）或 `advance`（记 diagnostic 后放行）。" — #543 执行模型

> "gate hold 后的重问需幂等防抖——chain-complete trigger 的 fingerprint 机制（`chain.metadata` 持久化 keep-active 指纹）是既有先例，具体形态归实现 child。" — #543 执行模型

> "hook 操作队列 = 在脚本内调 `coder-loop` CLI（socket 命令面），以 operator 身份。不引入「hook stdout 返回结构化 mutation 指令由引擎代执行」的第二套协议——mutation 全部走现有命令面，自动获得既有校验与审计事件。gate hook 的 stdout 只承载 decision，不承载 mutation。" — #543 能力契约

## 目标

script gate 在第一个决策点（run post-exit，下一次选择前）端到端成立：spawn（复用 hook 执行层）→ stdout decision JSON 边界 parse（三词 ADT + 可选 reason）→ onFailure 折叠 → 决策点消费（advance 放行 / hold 扣住退避重问）。

## 使用场景

- operator 在 chain 上声明 post-exit gate：每次 run 结束、调度器选下一个 item 之前脚本被问一次——#543 操作员验收场景（算轮数 → 同 evaluation scope 创建检查 leaf → hold；检查/修复完成后 → advance）的机制承载点；场景全链路验收归 #593（收尾），本 child 立机制。
- 后续 children 在其余决策点复用同一协议路径——协议语义（parse/onFailure/合成）一次落地，处处一致。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- run post-exit 决策点位置：run 终结处理后、`selectNextItemAndPhase`（`src/scheduler.ts:554`）下一次选择前。pending 的 `(position, id)` 排序只是普通调度顺序，不承担 #543 检查 gate 的因果正确性；检查 leaf 必须绑定当前 evaluation/task identity，gate 返回 hold 时原决策点不得推进。
- hold 先例：`chainCompletionTriggerAllowsCompletion`（`src/scheduler.ts:1809`）+ keep-active 指纹 `chainCompleteTriggerState`（`src/runtime-data.ts:454`）/ `coderLoopChainCompleteTrigger` metadata 字段（`src/runtime-data.ts:118`）——本 child 的 hold 退避重问**先复用该先例形态**（与 #561 同模式），泛化归#590（决策点闭集） 收编。
- stdout 路径区分：`parseFinalizerSummaryDecisionFromText`（`src/loop.ts:4863`）是 agent stdout 文本正则（v3 退役归 #566）；本 child 是 hook 子进程 stdout 的 JSON arktype 边界 parse——两者不共路径，本 child 不触前者。
- mutation 通道：`item.add` handler（`src/daemon.ts:2189`）、`item.reorder` handler（`src/daemon.ts:2538`）——gate 脚本以 operator 身份经 CLI 调用（#543 裁决 3），零新增鉴权面。
- 执行层：#588（observer 执行） 建立的 spawn/stdin/超时机制，本 child 叠加 stdout 捕获与 decision parse。
- **run post-exit gate hold 承载「阻止闭包挂起」语义**（#546 body「资源模型公理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §2「hook 挂点」）：闭包生命周期转移边（suspend/reopen/consume 等）**不可 gate**——suspend/consume 是推进后的闭包状态转移；suspend 本身零资源副作用，consume 才允许 GC，在副作用上放 gate = 让用户态扣住引擎资源管理、发明第二推进语义（design-boundary 红线）。要阻止某闭包挂起，正确形态 = **在本 child 的 run post-exit gate 上 hold**——推进被扣住，闭包自然不挂起（单一视图，无第二套语义）。转移边本身归 observer 观测通道（#586 事件词表扩充），不进 gate 决策点闭集（#590 边界登记）。

## 问题

gate 类 hook 的全部语义（hold 调度决策、stdout decision 协议、onFailure）无任何机制——#543 关闭验证行 2（gate hold）与行 4（onFailure 两语义）无处成立。决策点闭集全量接线体量配不上单 PR：先在操作员验收场景所在的一个决策点把协议端到端立起来，其余点由闭集 child 按同一路径扩展。

## 预期结果

性质表述：

1. **决策点评估**：post-exit 决策点上，生效视图命中的 gate 逐层逐个执行（顺序 全局→chain→preset→item）；合成 = AND 放行——本决策点词表是 `advance | hold` 二词子集（非容器推进点无 seq 游标可退），任一 hold 即整点 hold，全 advance 才放行。
2. **decision 边界 parse**：脚本 stdout 输出 decision JSON（统一判定契约三词 + 可选 reason），arktype 边界 parse 为穷尽 union；非法输出（非 JSON、词表外值、本决策点收到 reopen）按该 hook 的 `onFailure` 处置并记 diagnostic + 审计事件，无静默放行、无 default 兜底。stdout 不承载 mutation。
3. **onFailure 语义（RFC 行 4）**：超时/崩溃/协议违规 → `hold`（决策点扣住、退避重问、事件可见）或 `advance`（记 diagnostic 后放行）。
4. **hold 语义（RFC 行 2）**：该 chain 的 post-exit 决策扣住——不选下一个 item；其他 chain 调度不受影响；退避重问时脚本重新执行、可改判；幂等防抖先复用 chain-complete fingerprint 先例形态（泛化机制归#590（决策点闭集），落地后收编本 child 的复用点）。
5. **gate decision 可观测**：每次 decision 有 `hook.*` decision 事件（判定词 + reason）。
6. **引擎零策略语义**：放行/扣住的理由判断全在脚本内；引擎只执行协议。

### 非容器 reopen 裁决

声明只能约束挂点，不能证明任意脚本未来 stdout 不会输出 reopen，因此不伪造“装载期可证明脚本输出”的保证。非容器决策点的允许 decision boundary 是 `advance | hold`；若脚本实际输出 reopen，stdout boundary 将其判为 `decision_not_allowed_at_point`，记录 diagnostic，并严格按该 hook 已声明的 `onFailure = hold | advance` 处理。compile 仍负责拒绝把显式声明为 container-only 的 gate 绑定到非容器点；runtime boundary 负责不可信脚本输出。

## 不应残留

- 本 child 范围内：stdout 承载 mutation 的任何通道；decision parse 的 default 兜底（词表外静默当 advance 一类）；post-exit 之外决策点的接线（防单 PR 越界铺开，归闭集 child）。
- 本 issue 范围之外不应改动：其余决策点、tick 节流、指纹泛化（归#590（决策点闭集））；容器推进点与 reopen 派发（归 #592（join script））；chain-complete trigger 既有机制（归 #566 迁移，本 child 只参照不动）；#561 的 join 评估通道。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 统一判定契约文本以 #546 body 为唯一权威——本 child 的实现与文档不得改写或另立第二套词表。
- hook 执行不阻塞 daemon 主线程（#543 约束）；hold 是逻辑扣住，不是线程阻塞。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | gate hold（RFC 行 2） | chain 声明 post-exit gate（fixture 脚本首答 `hold` 次答 `advance`），真跑两 item 队列 | local | hold 期间不选下一 item、事件可见 hold 与退避重问；advance 后恢复选中 |
| function | onFailure 两语义（RFC 行 4） | 同挂点分别声明 `onFailure=hold` / `advance` 的必崩脚本 | local | hold：决策点扣住退避重问、事件可见；advance：diagnostic 后放行 |
| function | decision 边界 parse | fixture 脚本分别输出非 JSON、词表外值、reopen | local | 均按 onFailure 处置且 diagnostic/审计事件点名违规类别；无静默放行 |
| function | 多 gate AND 合成 | 同点两 gate：一 advance 一 hold | local | 合成 hold；改全 advance 后放行 |
| function | 检查 leaf 与 hold 因果闭环 | fixture gate 脚本在当前 evaluation scope 调 `coder-loop item add` 创建检查 leaf 后返回 hold；检查 leaf 完成后再返回 advance | local | item 创建成功且带稳定 evaluation/task identity；hold 期间原决策点不推进；完成后才恢复；stdout decision 不含 mutation 字段且不依赖 `(position,id)` 抢跑 |
| function | 其他 chain 不受影响 | 两 chain 一有 hold gate 一无，并行真跑 | local | 无 gate chain 照常推进 |
| type | decision ADT 穷尽 | `bun run typecheck`；临时向 decision union 加词观察编译错误面 | local | 全部处置点报错，无 default 吞掉 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #586（声明模型）、#587（payload 契约）、#588（observer 执行）（进程执行层）。
- Blocks: #599（evaluation epoch、decision journal 与幂等 consumer）、#590（决策点闭集）、#591（具名 gate）、#592（join script）、#593（收尾）。
- 协调边：#599（评估代次与幂等协议——本 child 预期结果 4 的「退避重问时脚本重新执行、可改判」不承担 mutation 重放安全语义，同代次幂等吸收与 decision 消费原子性归 #599，操作员裁决 2026-07-10 边界 4 审查；先合者定接线形态、后合者 rebase）；#561（hold 的 fingerprint 先例复用是同款模式；泛化后由#590（决策点闭集） 统一收编两处）；#559（树调度——post-exit/选中路径与其 seq 游标推进触同一 scheduler 推进面，无硬依赖、语义互不阻塞，先合者定接线形态、后合者 rebase 并在 PR 说明）。


---

## Comments (2)

### comment #4866576141 by `RiriAgent` — 2026-07-02T14:01:32Z


## 架构切片

1. **系统定位**：scheduler 决策面的 gate 评估级——在「run 终结 → 下一次选择」之间插入一个可编程放行点；decision 协议（stdout JSON 边界 parse + onFailure 折叠）是 script kind 判定器的执行器本体，与 #561 的 agent-phase 判定通道（CLI 写回）互为统一判定契约的两个 kind 实现。
2. **全局坐标**：hook 子进程域（不可信 stdout 字节）→ arktype 边界 parse → 引擎 typed decision 域 → 调度决策消费。入站信任升格点恰好一个（parse）；mutation 不走此边界（走既有 CLI 命令面，复用其校验与审计）。
3. **类型↔值不漂移**：防值漂移——decision 词表若在 parse 侧与消费侧各自定义即失同步；穷尽 union 单一定义封死。防类型泄露——非容器决策点的 `advance | hold` 子集限制以类型/校验表达，不靠散文约定。
4. **消除的错误类别**：「脚本输出垃圾被静默当放行」不可表达（边界 parse + onFailure，无 default）；「stdout 夹带 mutation 被引擎代执行」不可表达（decision schema 无 mutation 位，mutation 只经 CLI）；「一个 chain 的 hold 拖住别的 chain」不可表达（hold 作用域 = 该决策点）。

## log/观测义务

- 新增 `hook.*` gate decision 事件（decision kind 建议 `decision`，与 #411 五 kind 对齐）：含 hook 标识、决策点、判定词、reason。
- 协议违规/超时/崩溃：diagnostic + 审计事件，点名违规类别——与既有 `invalid_request` 审计契约同风格。
- hold 扣住状态经 status 快照 hooks 节可见（#586（声明模型） 的 hooks 节承载，本 child 填充 hold 运行态字段）。



### comment #5007298532 by `RiriAgent` — 2026-07-17T20:41:02Z

重新拆分后与 #590/#599 一并由 #712 承接，消除 decision/evaluation 循环。旧 issue 无关联 PR，关闭。


---

## Timeline (22)

- 2026-07-02T12:02:47Z `assigned` @RiriAgent
- 2026-07-02T14:00:50Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T14:00:51Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:00:53Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-02T14:00:56Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T14:00:58Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:18Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:32Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:27Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-11T08:33:36Z `referenced` @RiriAgentcommit=6bad6fcea488533dd230d4a26548957ddf0eec69
- 2026-07-16T23:17:59Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:19Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:41:02Z `commented` @RiriAgent
- 2026-07-17T20:41:02Z `closed` @RiriAgentcommit=None