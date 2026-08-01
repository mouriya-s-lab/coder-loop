# #593 docs(v3): 生命周期 hook 收尾对齐——操作员验收场景、作者文档与字面量守护

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:57Z  | updated: 2026-07-17T20:41:11Z
- closed: 2026-07-17T20:41:11Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/593
- comments: 2  | timeline events: 13

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "操作员场景在此契约下的分解：post-run gate hook 读元数据算轮数 → 达到阈值时以当前 evaluation scope 创建检查 leaf 并返回 `hold`；原决策点保持扣住。检查 leaf 及其派生修复 leaf 完成后，同一 gate 才返回 `advance`，原 seq 才继续；正确性不依赖全局 `(position, id)` 排序。此场景是本 RFC 的验收场景。" — #543 能力契约

> "| 3 | 操作员验收场景成立 | post-run gate 脚本算轮数、达阈值后在同一 evaluation scope 创建检查 leaf 并 `hold`；检查/修复 leaf 完成后再 `advance` | hold 期间原 seq 不推进；全部检查/修复完成后才恢复；正确性不依赖全局排序 |" — #543 关闭验证行 3

> "| 7 | 引擎无 gate 策略业务字面量 | grep 引擎源码中轮数/检查任务等词表 | gate 策略全在 operator 脚本；引擎只有挂点与协议 |" — #543 关闭验证行 7

操作员目标（verbatim）：

> "为了防止代码腐化，首先插队单独的全面检查代码任务，如果有问题继续插队由这个任务派生的修复任务，然后才继续。这种 gate 怎么设计是后来人自己设计，程序要提供这种接口和能力。" — `v3/v3-goals.md` 目标 5

## 目标

hook 树收尾：操作员验收场景端到端真跑（RFC 行 3）、hook 作者文档（挂点/payload/decision/声明位，枚举内容从代码派生 + 测试守护）、引擎 gate 策略业务字面量全局守护（RFC 行 7）、RFC 关闭复核的证据映射。

## 使用场景

- 后来人（operator 或其脚本作者）读一份 hook authoring 文档写出第一个 observer/gate——「这种 gate 怎么设计是后来人自己设计」的前提是后来人能从文档知道接口和能力。
- #543 关闭复核：8 行关闭验证逐行指认到 children 验收证据，RFC 可关。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- 操作员场景的机制成分全部来自上游：post-exit gate（#589）+ payload 轮数数据（#587）+ evaluation-scoped 检查 leaf 创建与幂等（#599）+ hold/advance decision + 检查 agent 派生修复（per-phase `createItems` right）——本 child 不新增机制，只做整链组合验收；`item reorder` 与 `(position,id)` 不承担控制流正确性。
- 文档守护先例：engine runtime fact 清单「用测试守护文档计数 / 清单不漂移」（CLAUDE.md、`docs/preset-authoring.md`）。
- 收尾对齐 child 形态先例：#568（#546 树收尾：文档、旧概念退场登记、机制/参数分离守护）。

## 问题

各 children 分片验收不等于操作员场景整链成立（gate → evaluation-scoped 检查 leaf → hold → 检查/修复完成 → advance）；hook 面无作者文档——「接口和能力」只存在于 issue 与源码；「引擎无 gate 策略业务字面量」是全局性质，各 child 切片 grep 不能替代全局守护。

## 预期结果

1. **操作员验收场景端到端成立（RFC 行 3 全语义）**：post-run gate 脚本按 payload 轮数达阈值 → 在同一 evaluation scope 创建检查 leaf → 返回 hold 扣住原决策点 → 检查 agent 经 createItems 派生修复 leaf → 检查/修复全部完成后返回 advance → 原 seq 才继续。全链真跑，事件序列可证；不得以队列 position 抢跑冒充 gate。
2. **hook 作者文档**：声明位四层、observer 挂点（事件词表引用）、gate 决策点闭集、payload schema、decision 协议与 onFailure、重放语义与幂等边界（评估代次、同代次重放的幂等吸收、I4 孤儿残留边界、gate 脚本对评估输入确定化的作者义务、引擎外副作用（GitHub comment 等）不受队列侧协议保护的提醒——#599）、能力契约（CLI mutation + operator 身份）、tick 节流与具名 gate 绑定、**闭包转移边事件词表**（#586 扩充）与**「转移边 observer-only、决策点闭集不扩」边界**（#546 body「资源模型公理·hook 挂点」+ 权威记录 `v3/closure-lifecycle-decision.md` §2；观测通道归 observer，阻止挂起走 #589 run post-exit gate hold）——枚举性内容从代码/schema 派生或测试守护，手写计数 drift 时测试红。
3. **全局守护（RFC 行 7）**：测试级守护「引擎源码无轮数阈值/检查任务类 gate 策略业务词」；引擎只含挂点、payload、decision 协议。
4. **RFC 关闭复核**：#543 的 8 行关闭验证 → children 验收证据的映射登记（本 issue 或 #543 comment），支撑 RFC 关闭。

## 不应残留

- 本 child 范围内：手写的挂点/字段计数（必须派生 + 守护）；文档与实现的 drift 无守护通路。
- 本 issue 范围之外不应改动：任何 hook 机制本体（全部归上游 children——本 child 发现机制缺陷时开新 issue 不顺手修）；CLAUDE.md 之外仓级文档的无关重写。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 引擎无 gate 策略业务语义（#543 约束）——本 child 的守护测试即该约束的持久执法。
- 文档正文中文、固定 token 英文（仓级惯例）。

## 本 issue 的验证边界

- **验证层级**：文档/残留守护；运行文档中列出的静态一致性检查与相关测试守护。
- **本 issue 必须证明**：文档只描述已经落地且有 owner 的行为，旧术语/旧路径按正文清单退场，命令与 schema 引用可由当前代码验证。
- **不在本 issue 内执行**：不运行 v3 整链路 integration，也不运行 bundled preset compatibility real E2E。若审计发现产品行为缺口，回到对应 implementation issue；合流证明分别归 #684/#685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 操作员场景（RFC 行 3） | 声明 post-run gate（fixture：轮数阈值 → evaluation-scoped `item add` 检查 leaf → hold；检查/修复完成后 → advance），多轮任务树真跑 | local | hold 期间原 seq 绝不推进；检查 agent 派生修复成功且全部完成后才继续；移除/改变 position 不影响正确性；事件序列完整可证 |
| function | 阻止挂起走 run post-exit gate hold（#546 转移边 observer-only 边界） | 声明 run post-exit gate hold（fixture 脚本首答 hold 次答 advance），观察某闭包在 phase 推进离开处 | local | hold 期间闭包不挂起（推进被扣，闭包停 active）；advance 后正常挂起进闭包分支；事件序列证「阻止挂起 = 推进被扣」而非「转移边被 gate」 |
| function | 文档派生守护 | `bun test`（文档清单守护测试） | local | 挂点清单/payload 字段/决策点闭集与代码同步；人为制造 drift 时测试红 |
| assumption | 业务字面量守护（RFC 行 7） | 守护测试 + 人工 grep 复核引擎源码 | local | 引擎无轮数/检查任务类 gate 策略词；只有挂点与协议 |
| assumption | RFC 关闭映射 | 查本 issue / #543 thread 的证据映射登记 | GitHub | 8 行关闭验证逐行指向 children 验收证据 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 本树全部上游 children——#586（声明模型）、#587（payload 契约）、#588（observer 执行）、#589（gate 执行）、#599（evaluation epoch、decision journal 与幂等消费）、#590（决策点闭集）、#591（具名 gate）、#592（join script）。
- Blocks: #543 关闭复核。


---

## Comments (2)

### comment #4866576882 by `RiriAgent` — 2026-07-02T14:01:37Z


## 架构切片

1. **系统定位**：hook 树的收尾对齐级（#568 同构）——机制全部在上游，本 child 交付整链组合验收、作者文档面、约束的持久执法（守护测试）。
2. **全局坐标**：无新域边界；文档是引擎 typed 事实（挂点 union、payload schema、decision ADT）向 operator 阅读域的派生投影——派生方向单一，防手写副本。
3. **类型↔值不漂移**：防值漂移——文档中的枚举清单是代码的派生视图 + 测试守护，不是第二份手写事实。
4. **消除的错误类别**：「文档与实现漂移无人发现」不可表达（守护测试红）；「gate 策略业务语义悄悄溜进引擎」从 review 约定升级为测试执法。

## log/观测义务

- 无新事件义务（组合验收消费上游 children 已铺的 `hook.*` 事件面；场景验收本身以事件序列为证据）。



### comment #5007299377 by `RiriAgent` — 2026-07-17T20:41:10Z

重新拆分后由 #715 承接冻结 SHA 综合验收。旧 issue 无关联 PR，关闭。


---

## Timeline (13)

- 2026-07-02T12:02:58Z `assigned` @RiriAgent
- 2026-07-02T14:00:51Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:56Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T14:01:23Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:37Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:41:10Z `commented` @RiriAgent
- 2026-07-17T20:41:11Z `closed` @RiriAgentcommit=None