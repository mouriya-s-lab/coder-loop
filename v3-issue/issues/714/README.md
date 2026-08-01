# #714 feat(engine): join script 判定器与 reopen 派发

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:25Z  | updated: 2026-07-27T04:27:03Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/714
- comments: 0  | timeline events: 13

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

消费共享 gate core 及 #546 validator/reopen runtime，不自建第二 decision consumer。

join ADT 的 `script` variant 真实化：容器推进点（par join；chain-complete 顶层实例）可绑 script 判定器——decision 经 stdout（script kind）进 #700 的 join 判定通道，reopen 校验后派发 #701 执行；容器点的三词合成（reopen 优先）与多 reopen 冲突裁决落地。

## 问题

#546 join ADT 尚无 `script` variant（已登记的未来方向，准入纪律要求连同全部消费点一次落齐）；#543 gate 决策点闭集的「容器推进/par join、chain-complete」两点未接线——RFC 关闭验证行 8（script gate 的 reopen 判定）无处成立；操作员目标 5 的 gate 场景在容器语境（并行批次质量门）无 script 承载。多 reopen 合成只在容器点存在（其余决策点词表无 reopen），按本 child 已裁规则执行。

## 预期结果

性质表述：

1. **script variant 真实化**：join 声明可取 `script`（绑定形态与 #739/#705 声明面协调，additive）；#700 join 评估的穷尽 switch 处置该 variant——容器全成员 terminal 时 spawn script gate（复用 hook 执行层与 decision 协议），而非 validator leaf。
2. **同一判定契约**：script 判定与 agent-phase validator 走同一 decision ADT 与派发路径——advance 放行、hold 扣住退避重问（指纹泛化机制）、reopen 校验后派发 #701；容器推进点三词全部合法（其余决策点的 `advance | hold` 子集限制不适用于此点）。
3. **corrections 先经 CLI、decision 精确引用**：脚本以 operator 身份先通过带 evaluation scope 的 `item add` 插入纠正 item，再返回 `reopen(target, correctionItemIds)`；stdout 不承载 mutation，只引用既存 item。#701 consumer 在单事务中校验/认领精确 IDs 并执行重开，不把先前 CLI mutation 伪装进同一事务。
4. **chain-complete 实例**：chain-complete 作为顶层 join 可绑 script（#705 声明位迁移落地后验收此半边）。
5. **容器点合成**：同一容器点多 gate 时 reopen 优先于 hold；多个 reopen 指向同一 target 时合并并去重 correction IDs，指向不同 target 时不推进，合成为 hold 并发出包含全部冲突 target 的 diagnostic。不得按声明顺序任选一个 target。
6. **mergedness ground truth 在 GitHub 面，script 判定器自查**（#546 body 供给条款 3 + 「引擎递出面定理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §4/§5）：合并真相（PR 是否 merged、mergeCommit）是 GitHub 面事实，由 script 判定器**经声明通道自查**（脚本内以 operator 身份调 `gh` / GitHub API），不由引擎注入进 payload——「引擎理解 GitHub 字段」违反 L1 红线，边界 1 会话打回「引擎注入 mergedness 进判定 payload」的形态。判定器读得到什么由供给条款 3 与谓词对象决定（引擎自有面：闭包分支上有无工作、发布没发布），mergedness 不在其中。

### 多 reopen 裁决

该问题只在容器推进点存在：相同 target 的 reopen 合并为一次 decision，correction IDs 取稳定顺序去重并集；不同 target 没有可证明安全的隐式优先级，因此合成为 hold + diagnostic，等待 operator 或下一 evaluation 改判。该规则是 decision ADT 的穷尽合成，不使用声明顺序兜底。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | script join advance | par(join=script) 全成员 terminal，fixture 脚本 advance，真跑 | local | 引擎 spawn 脚本（非 agent leaf）；外层 seq 推进 |
| function | script join hold | fixture 脚本首答 hold、重问改答 advance | local | 容器扣住退避重问（指纹防抖事件可证）；改判生效 |
| function | script reopen（RFC 行 8） | fixture 脚本先经带 evaluation scope 的 CLI 插入纠正 item，再 stdout `reopen(target, correctionItemIds)` 精确引用 | local | 纠正 item 追加进 target、seq 游标回退、已 terminal item 状态不变（与 #546 reopen 行同语义，#701 机制承接） |
| function | 非法 reopen target | fixture 脚本 reopen 指向未跑节点 / 跨 seq 节点 | local | 被拒 + 审计事件（#701 运行期校验路径）；容器状态不变 |
| function | reopen 合成 | 分别真跑：一 hold + 一 reopen；两个同 target reopen；两个不同 target reopen | local | reopen 优先于 hold；同 target 合并去重 IDs；不同 target 合成为 hold + diagnostic，容器不推进 |
| function | chain-complete script 实例 | chain metadata 顶层 join 绑 script，chain 全 item terminal | local | 脚本判定 chain 完成/keep-active（#705 落地后验收此行） |
| type | join ADT 穷尽兑现 | `bun run typecheck`（script variant 真实化后全消费点显式处置） | local | 通过；无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：#546 任务代数 join 策略 ADT 的 variant 实现级——统一判定器接口（#543 裁决 5）的 script kind 在容器推进点的落点；#700 是判定通道框架（spawn 判定器、接收 decision、派发），本 child 给该框架加第二种判定器 kind。
2. **全局坐标**：join 声明域（preset 树 / chain metadata 的 script variant）→ 引擎 join 评估域（穷尽 switch）→ hook 子进程域（stdout decision，经 #712（gate 执行） 的边界 parse 回引擎 typed decision）→ #701 reopen 执行域。跨了声明、评估、子进程三条既有边界，零新边界。
3. **类型↔值不漂移**：防值漂移——script 与 agent-phase 两 kind 的 decision 若各自定义即契约分裂；同一 typed decision 与同一派发路径封死。防类型泄露——script variant 的绑定形态不得把 hook 执行细节（脚本路径语义）泄进 join ADT 之外的调度类型。
4. **消除的错误类别**：「同一容器两种判定器行为不同」不可表达（同契约同派发）；「script 判定绕过 reopen 校验」不可表达（走 #700→#701 唯一通道）；「variant 被 default 静默吞掉」不可表达（穷尽 switch 兑现）。

## log/观测义务

- script join 判定沿 `hook.*` decision 事件契约（决策点标识 = 容器推进点，含容器 id）。
- reopen 派发/拒绝沿 #700/#701 的审计事件契约，本 child 不新增第二套。

## 依赖关系

- Depends on: #700、#701、#710、#712。
- Blocks: #715。



---

## Comments (0)

---

## Timeline (13)

- 2026-07-17T20:36:26Z `assigned` @RiriAgent
- 2026-07-17T20:38:27Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:38:30Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:39:43Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:09Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-26T16:13:55Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-26T16:14:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T16:15:00Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:11Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-27T04:26:53Z `cross-referenced` @RiriAgentsrc=701