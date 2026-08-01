# #592 feat(engine): join script 判定器——容器推进点 script gate 与 reopen 派发

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:54Z  | updated: 2026-07-17T20:41:09Z
- closed: 2026-07-17T20:41:09Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/592
- comments: 2  | timeline events: 23

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）与 #546（RFC: v3 任务模型）。统一判定契约的唯一权威文本是 #546 body「join 策略与验证者判定」节（本 child 与 #561/#562 引用同一文本，不复制不改写），逐字引用：

> ```
> decision ::= advance                       -- 放行，外层 seq 推进
>            | hold                          -- 暂不放行，退避后重问（keep-active 语义）
>            | reopen(target, correctionItemIds) -- 退回并精确引用已创建的纠正 item
>              target      ::= self | 同一 seq 内更早的兄弟节点
>              correctionItemIds ::= 同 evaluation scope 下先经 CLI 创建、属于 target 的 item stable id，≥1
> ```

> ```
> join ::= drain                       -- 全部子任务 terminal 即放行
>        | validator(item 调用声明)     -- 专用验证者 leaf 判定放行/reopen
> ```

#543 继承条款逐字快照：

> "`reopen(target, correctionItemIds)` 退回并精确引用同 evaluation scope 下先经 CLI 创建的 corrections；stdout 不承载 mutation。" — #543 执行模型

> "**与 RFC-1（#546，已裁）**：统一判定器接口成立——推进决策点上可绑定 kind = script（本 RFC）| agent-phase（#546 validator）判定器，decision 契约为同一 ADT `advance | hold | reopen(target, correctionItemIds)`……decision 通道各按其 kind（script = stdout JSON，agent-phase = CLI 写回，#546「判定经 CLI 写回」）。" — #543 跨 RFC 接口假设

> "hold 与 reopen 并存时 reopen 优先；多 reopen 同 target 合并 IDs，不同 target 合成为 hold + diagnostic。" — #543 声明位与合成语义

#561 的派发行为契约逐字：

> "`reopen(target, correctionItemIds)` → 校验精确 IDs 后转交 reopen 执行（#562）——其落地前引擎对 reopen 判定**显式拒绝**（错误信息点名未支持），不静默吞掉、不留半执行状态。" — #561 预期结果

## 目标

join ADT 的 `script` variant 真实化：容器推进点（par join；chain-complete 顶层实例）可绑 script 判定器——decision 经 stdout（script kind）进 #561 的 join 判定通道，reopen 校验后派发 #562 执行；容器点的三词合成（reopen 优先）与多 reopen 冲突裁决落地。

## 使用场景

- par 容器声明 `join = script(...)`：全成员 terminal 时引擎 spawn 脚本而非验证者 agent——纯计算判定（数值阈值、CI 结果核对）不烧 LLM。
- chain-complete 顶层 join（#566 迁移到 chain metadata 后）同样可绑 script——现有 chain-complete trigger 先例的 v3 归宿之一。
- 脚本要求纠正时：先以 operator 身份经带 evaluation scope 的 CLI 插入纠正 item，再 stdout 返回 `reopen(target, correctionItemIds)`，精确引用刚创建的 item——与 agent-phase validator 的 reopen 完全同语义（#562 执行）。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- join ADT 穷尽面：#561 已钉封闭 union + 全部消费点穷尽 switch（无 default 兜底）——本 child 按 #547 variant 准入纪律把 `script` variant 连同语义、持久化、观测投影与全部消费点一次落齐；向 union 新增该 variant 时编译器暴露的全部处置点即本 child 的接线清单。
- 判定通道分工（#546 接口假设）：script = stdout JSON（本 child，协议复用 #589（gate 执行））；agent-phase = CLI 写回（#561 已建）。
- reopen 执行本体：#562（纠正追加、seq 游标回退、级联再验证、预算耗尽）——本 child 只做校验后派发。
- chain-complete：声明位迁移与 FINALIZER stdout 退役（`parseFinalizerSummaryDecisionFromText`，`src/loop.ts:4863`）归 #566——本 child 在其迁移后的声明形态上生效，不动迁移本身。
- join 声明语法：preset 层树内 join 字段归 #554（join ADT 声明），chain 层归 #566（chain metadata）——script variant 的声明形态是两者的 additive 扩展，协调不重定义。

## 问题

#546 join ADT 尚无 `script` variant（已登记的未来方向，准入纪律要求连同全部消费点一次落齐）；#543 gate 决策点闭集的「容器推进/par join、chain-complete」两点未接线——RFC 关闭验证行 8（script gate 的 reopen 判定）无处成立；操作员目标 5 的 gate 场景在容器语境（并行批次质量门）无 script 承载。多 reopen 合成只在容器点存在（其余决策点词表无 reopen），按本 child 已裁规则执行。

## 预期结果

性质表述：

1. **script variant 真实化**：join 声明可取 `script`（绑定形态与 #554/#566 声明面协调，additive）；#561 join 评估的穷尽 switch 处置该 variant——容器全成员 terminal 时 spawn script gate（复用 hook 执行层与 decision 协议），而非 validator leaf。
2. **同一判定契约**：script 判定与 agent-phase validator 走同一 decision ADT 与派发路径——advance 放行、hold 扣住退避重问（指纹泛化机制）、reopen 校验后派发 #562；容器推进点三词全部合法（其余决策点的 `advance | hold` 子集限制不适用于此点）。
3. **corrections 先经 CLI、decision 精确引用**：脚本以 operator 身份先通过带 evaluation scope 的 `item add` 插入纠正 item，再返回 `reopen(target, correctionItemIds)`；stdout 不承载 mutation，只引用既存 item。#562 consumer 在单事务中校验/认领精确 IDs 并执行重开，不把先前 CLI mutation 伪装进同一事务。
4. **chain-complete 实例**：chain-complete 作为顶层 join 可绑 script（#566 声明位迁移落地后验收此半边）。
5. **容器点合成**：同一容器点多 gate 时 reopen 优先于 hold；多个 reopen 指向同一 target 时合并并去重 correction IDs，指向不同 target 时不推进，合成为 hold 并发出包含全部冲突 target 的 diagnostic。不得按声明顺序任选一个 target。
6. **mergedness ground truth 在 GitHub 面，script 判定器自查**（#546 body 供给条款 3 + 「引擎递出面定理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §4/§5）：合并真相（PR 是否 merged、mergeCommit）是 GitHub 面事实，由 script 判定器**经声明通道自查**（脚本内以 operator 身份调 `gh` / GitHub API），不由引擎注入进 payload——「引擎理解 GitHub 字段」违反 L1 红线，边界 1 会话打回「引擎注入 mergedness 进判定 payload」的形态。判定器读得到什么由供给条款 3 与谓词对象决定（引擎自有面：闭包分支上有无工作、发布没发布），mergedness 不在其中。

### 多 reopen 裁决

该问题只在容器推进点存在：相同 target 的 reopen 合并为一次 decision，correction IDs 取稳定顺序去重并集；不同 target 没有可证明安全的隐式优先级，因此合成为 hold + diagnostic，等待 operator 或下一 evaluation 改判。该规则是 decision ADT 的穷尽合成，不使用声明顺序兜底。

## 不应残留

- 本 child 范围内：绕过 #561 通道的第二套 join 评估；stdout 承载 mutation；FINALIZER stdout 解析路径的任何复用；join 消费点的 default 兜底（script variant 必须由穷尽 switch 显式处置）；**引擎侧 mergedness 计算/注入路径**（无论进 payload 还是进决策上下文）——mergedness 是 GitHub 面事实，只由 script 判定器经声明通道自查（预期结果 6），引擎不理解、不计算、不投递 GitHub 字段。
- 本 issue 范围之外不应改动：reopen 执行本体（归 #562）；validator/drain 语义（归 #561/#559）；chain-complete 声明位迁移与 FINALIZER 退役（归 #566）；join 声明语法本体（归 #554/#566，本 child 只做 additive variant 协调）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 统一判定契约文本以 #546 body 为唯一权威——本 child 不改写不另立词表。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | script join advance | par(join=script) 全成员 terminal，fixture 脚本 advance，真跑 | local | 引擎 spawn 脚本（非 agent leaf）；外层 seq 推进 |
| function | script join hold | fixture 脚本首答 hold、重问改答 advance | local | 容器扣住退避重问（指纹防抖事件可证）；改判生效 |
| function | script reopen（RFC 行 8） | fixture 脚本先经带 evaluation scope 的 CLI 插入纠正 item，再 stdout `reopen(target, correctionItemIds)` 精确引用 | local | 纠正 item 追加进 target、seq 游标回退、已 terminal item 状态不变（与 #546 reopen 行同语义，#562 机制承接） |
| function | 非法 reopen target | fixture 脚本 reopen 指向未跑节点 / 跨 seq 节点 | local | 被拒 + 审计事件（#562 运行期校验路径）；容器状态不变 |
| function | reopen 合成 | 分别真跑：一 hold + 一 reopen；两个同 target reopen；两个不同 target reopen | local | reopen 优先于 hold；同 target 合并去重 IDs；不同 target 合成为 hold + diagnostic，容器不推进 |
| function | chain-complete script 实例 | chain metadata 顶层 join 绑 script，chain 全 item terminal | local | 脚本判定 chain 完成/keep-active（#566 落地后验收此行） |
| type | join ADT 穷尽兑现 | `bun run typecheck`（script variant 真实化后全消费点显式处置） | local | 通过；无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #589（gate 执行）（decision 协议与执行层）、#590（决策点闭集）（指纹泛化与合成框架）；#561（join 评估通道与穷尽 variant 位）、#562（reopen 执行本体）。
- 协调边：#554（preset 层 join 声明语法的 script variant additive 扩展）、#566（chain 层声明位与 chain-complete 顶层实例——其未落地时本 child 的 par join 半边可先行，chain-complete 半边随其落地验收）。


---

## Comments (2)

### comment #4866576680 by `RiriAgent` — 2026-07-02T14:01:36Z
_(last edited 2026-07-10T06:12:35Z)_


## 架构切片

1. **系统定位**：#546 任务代数 join 策略 ADT 的 variant 实现级——统一判定器接口（#543 裁决 5）的 script kind 在容器推进点的落点；#561 是判定通道框架（spawn 判定器、接收 decision、派发），本 child 给该框架加第二种判定器 kind。
2. **全局坐标**：join 声明域（preset 树 / chain metadata 的 script variant）→ 引擎 join 评估域（穷尽 switch）→ hook 子进程域（stdout decision，经 #589（gate 执行） 的边界 parse 回引擎 typed decision）→ #562 reopen 执行域。跨了声明、评估、子进程三条既有边界，零新边界。
3. **类型↔值不漂移**：防值漂移——script 与 agent-phase 两 kind 的 decision 若各自定义即契约分裂；同一 typed decision 与同一派发路径封死。防类型泄露——script variant 的绑定形态不得把 hook 执行细节（脚本路径语义）泄进 join ADT 之外的调度类型。
4. **消除的错误类别**：「同一容器两种判定器行为不同」不可表达（同契约同派发）；「script 判定绕过 reopen 校验」不可表达（走 #561→#562 唯一通道）；「variant 被 default 静默吞掉」不可表达（穷尽 switch 兑现）。

## log/观测义务

- script join 判定沿 `hook.*` decision 事件契约（决策点标识 = 容器推进点，含容器 id）。
- reopen 派发/拒绝沿 #561/#562 的审计事件契约，本 child 不新增第二套。




### comment #5007299155 by `RiriAgent` — 2026-07-17T20:41:08Z

重新拆分后由 #714 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (23)

- 2026-07-02T12:02:55Z `assigned` @RiriAgent
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:56Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T14:00:57Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:22Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:36Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:27Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-10T11:18:23Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-11T06:30:11Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-11T06:30:13Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-11T06:30:15Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:41:08Z `commented` @RiriAgent
- 2026-07-17T20:41:09Z `closed` @RiriAgentcommit=None