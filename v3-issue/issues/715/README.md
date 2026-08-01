# #715 docs(v3): hook 与 gate 冻结 SHA 综合验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:27Z  | updated: 2026-07-27T01:00:21Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/715
- comments: 0  | timeline events: 11

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

唯一综合验收 owner；在 correction subtree 可运行的 #546 runtime 到位后执行 operator scenario。

hook 树收尾：操作员验收场景端到端真跑（RFC 行 3）、hook 作者文档（挂点/payload/decision/声明位，枚举内容从代码派生 + 测试守护）、引擎 gate 策略业务字面量全局守护（RFC 行 7）、RFC 关闭复核的证据映射。

## 问题

各 children 分片验收不等于操作员场景整链成立（gate → evaluation-scoped 检查 leaf → hold → 检查/修复完成 → advance）；hook 面无作者文档——「接口和能力」只存在于 issue 与源码；「引擎无 gate 策略业务字面量」是全局性质，各 child 切片 grep 不能替代全局守护。

## 预期结果

1. **操作员验收场景端到端成立（RFC 行 3 全语义）**：post-run gate 脚本按 payload 轮数达阈值 → 在同一 evaluation scope 创建检查 leaf → 返回 hold 扣住原决策点 → 检查 agent 经 createItems 派生修复 leaf → 检查/修复全部完成后返回 advance → 原 seq 才继续。全链真跑，事件序列可证；不得以队列 position 抢跑冒充 gate。
2. **hook 作者文档**：声明位四层、observer 挂点（事件词表引用）、gate 决策点闭集、payload schema、decision 协议与 onFailure、重放语义与幂等边界（评估代次、同代次重放的幂等吸收、I4 孤儿残留边界、gate 脚本对评估输入确定化的作者义务、引擎外副作用（GitHub comment 等）不受队列侧协议保护的提醒——#712）、能力契约（CLI mutation + operator 身份）、tick 节流与具名 gate 绑定、**闭包转移边事件词表**（#586 扩充）与**「转移边 observer-only、决策点闭集不扩」边界**（#546 body「资源模型公理·hook 挂点」+ 权威记录 `v3/closure-lifecycle-decision.md` §2；观测通道归 observer，阻止挂起走 #712 run post-exit gate hold）——枚举性内容从代码/schema 派生或测试守护，手写计数 drift 时测试红。
3. **全局守护（RFC 行 7）**：测试级守护「引擎源码无轮数阈值/检查任务类 gate 策略业务词」；引擎只含挂点、payload、decision 协议。
4. **RFC 关闭复核**：#543 的 8 行关闭验证 → children 验收证据的映射登记（本 issue 或 #543 comment），支撑 RFC 关闭。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 操作员场景（RFC 行 3） | 声明 post-run gate（fixture：轮数阈值 → evaluation-scoped `item add` 检查 leaf → hold；检查/修复完成后 → advance），多轮任务树真跑 | local | hold 期间原 seq 绝不推进；检查 agent 派生修复成功且全部完成后才继续；移除/改变 position 不影响正确性；事件序列完整可证 |
| function | 阻止挂起走 run post-exit gate hold（#546 转移边 observer-only 边界） | 声明 run post-exit gate hold（fixture 脚本首答 hold 次答 advance），观察某闭包在 phase 推进离开处 | local | hold 期间闭包不挂起（推进被扣，闭包停 active）；advance 后正常挂起进闭包分支；事件序列证「阻止挂起 = 推进被扣」而非「转移边被 gate」 |
| function | 文档派生守护 | `bun test`（文档清单守护测试） | local | 挂点清单/payload 字段/决策点闭集与代码同步；人为制造 drift 时测试红 |
| assumption | 业务字面量守护（RFC 行 7） | 守护测试 + 人工 grep 复核引擎源码 | local | 引擎无轮数/检查任务类 gate 策略词；只有挂点与协议 |
| assumption | RFC 关闭映射 | 查本 issue / #543 thread 的证据映射登记 | GitHub | 8 行关闭验证逐行指向 children 验收证据 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 伞 #543 的关闭终态条件（本 issue 复核对象）

以下是伞 #543 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | observer hook 在事件发生时被调用且元数据经 stdin 传入；自反订阅不可表达 | 声明 observer 订阅 `agent.exit` 并跑一个 run；另声明订阅 `hook.*` | `agent.exit` 脚本收到含该 run 元数据的 JSON且调度不受影响；`hook.*` 声明装载期拒绝且发射期零派发 |
| 2 | gate hook 能 hold 调度决策 | post-run gate 返回 `hold` | 该 chain 不选下一个 item，事件流可见 hold；返回 `advance` 后恢复 |
| 3 | 操作员验收场景成立 | post-run gate 脚本算轮数、达阈值后在同一 evaluation scope 创建检查 leaf 并 `hold`；检查/修复 leaf 完成后再 `advance` | hold 期间原 seq 不推进；检查 leaf 及其派生修复 leaf 全部完成后才恢复；正确性不依赖全局 `(position, id)` 排序 |
| 4 | `onFailure` 两种语义都成立 | 同一挂点分别声明 `hold` / `advance` 的必崩脚本 | `hold`：决策点退避重问且事件可见；`advance`：记 diagnostic 后放行 |
| 5 | 四层声明位与合成语义成立 | 全局+chain+preset+item 同挂点各声明一个 gate | 按 全局→chain→preset→item 顺序执行，任一 hold 即 hold |
| 6 | hook 执行可观测 | 跑 1/2/4 各场景后查事件流 | 每次 hook 执行有 `hook.*` 事件（开始/结束/失败/decision） |
| 7 | 引擎无 gate 策略业务字面量 | grep 引擎源码中轮数/检查任务等词表 | gate 策略全在 operator 脚本；引擎只有挂点与协议 |
| 8 | script gate 的 reopen 判定 | 容器推进点 gate 先经带 evaluation scope 的 CLI 插入纠正 item，再返回 `reopen(target, correctionItemIds)` | 精确 IDs 被校验并认领；target 重开、seq 游标回退、已 terminal item 状态不变；预插入 mutation 不被伪称为 decision 消费事务的一部分 |

## 架构切片

1. **系统定位**：hook 树的收尾对齐级（#708 同构）——机制全部在上游，本 child 交付整链组合验收、作者文档面、约束的持久执法（守护测试）。
2. **全局坐标**：无新域边界；文档是引擎 typed 事实（挂点 union、payload schema、decision ADT）向 operator 阅读域的派生投影——派生方向单一，防手写副本。
3. **类型↔值不漂移**：防值漂移——文档中的枚举清单是代码的派生视图 + 测试守护，不是第二份手写事实。
4. **消除的错误类别**：「文档与实现漂移无人发现」不可表达（守护测试红）；「gate 策略业务语义悄悄溜进引擎」从 review 约定升级为测试执法。

## log/观测义务

- 无新事件义务（组合验收消费上游 children 已铺的 `hook.*` 事件面；场景验收本身以事件序列为证据）。

## 依赖关系

- Depends on: #710、#711、#712、#713、#714、#698、#700、#701。
- Blocks: #543 closure。


---

## Comments (0)

---

## Timeline (11)

- 2026-07-17T20:36:28Z `assigned` @RiriAgent
- 2026-07-17T20:38:28Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:38:30Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:38:31Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:38:33Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:39:45Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:11Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-26T16:14:08Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-27T04:26:49Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-27T04:26:52Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-27T04:26:53Z `cross-referenced` @RiriAgentsrc=701