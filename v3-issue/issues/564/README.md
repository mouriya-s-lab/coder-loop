# #564 feat(daemon): 物化容器 join 判定权演化——绑定版本追加、候选引用与授权方向

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:15:56Z  | updated: 2026-07-17T20:15:00Z
- closed: 2026-07-17T20:15:00Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/564
- comments: 1  | timeline events: 30

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）与裁决权威记录 `v3/join-evolution-decision.md`（操作员裁决 2026-07-11，边界 B：运行中修改 join = future-function mutation）。继承条款逐字快照：

> "**join 判定权演化**（操作员裁决 2026-07-11，权威记录 `v3/join-evolution-decision.md`；#413「判定是 DB 里可随时修改的状态」条款废止）：join 是 future function——未归约汇合 redex 的函数位 + 判定主体绑定，不入 control-plane 字段类（`repoCwd`/`runner`/`priority` 改变 leaf 怎么被执行，join 携带判定权并生成纠正结构）。**定义态 join**（preset/#554 与 chain metadata/#566 声明，#605 保护域内）实例生命周期内不可变，救济 = operator per-epoch decision 或 cancel + 以修正后定义重建；**物化态 join**（#563 诞生，运行态域）允许演化——同容器 append-only **绑定版本追加**（每次演化 = 一等审计事件，含作者/授权类别/生效起始 epoch），**epoch 创建时采样生效**（同 epoch 主体冻结、在途 evaluation 零影响，下一 epoch 用新绑定），值域限 enclosing 实例 pinned 定义内的**编译期候选引用**（`(definitionRef, candidateId)`；`definitionRef` 是 #605 的 tagged `ExecutionDefinitionRef = preset | chain`，运行时可补边界 parse 的绑定值，不可注入调用结构）。授权方向敏感：加严（drain→validator）可经 preset rights 授 agent；放宽（validator→drain）恒 operator-only；授权语义复用 #409/#410 权利矩阵形态，不新增授权面。" — #546 body「join 策略与验证者判定」（2026-07-11 修订）

边界 A 交叉钉子（`v3/definition-pin-decision.md` §3）：

> "**函数演化（#564）的边界**：任何运行中语义变更不得以「切换定义版本」形态出现——rebind 在 API 面上不可表达，#564 的设计空间被限定在运行态域 + 显式 migration 门之内。"

## 目标

物化容器的判定权演化通道：容器未终结期间经 socket 追加 join 绑定版本（值域 = pinned 定义内候选引用），下一 evaluation epoch 采样生效；定义态容器与非法值被拒；授权方向敏感（加严可授 agent，放宽 operator-only）；每次演化留一等审计事件。

## 使用场景

事后给动态批次装/拆质量门。review agent 经 #563 物化的纠正批次容器（诞生时未指定 join，默认 drain）跑到中途，operator（或被授权 agent，仅加严方向）给它追加 `validator(候选引用)` 绑定——在途 evaluation 不受影响，批次成员下轮汇合时由新判定者裁决；反向拆除（validator→drain）仅 operator 可做，且已发生的 reopen/corrections 不被撤销、演化前后因果在事件流可重建。「一次性放行」不走本通道（归 #561 的 operator per-epoch decision）。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- **不入 control-plane 字段类**（裁决 1）：`PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS = ["repoCwd", "runner", "dependsOn", "priority"]`（`src/daemon.ts:202`）保持四字段不动；join 演化是独立命令面 + 独立授权分类，不把 join 塞进该 set。原 body「control-plane 化」方向作废。
- 绑定版本序列的持久化形态归 #558（树运行态 shape 的一部分：append-only 版本记录 + evaluation 记录携带 bindingVersion 引用）；epoch 创建时的采样动作归 #561（join 评估）/#599（write-ahead `evaluating`）——本 child 提供版本序列的写通道与读面，不实现采样。
- 候选引用的解析域 = enclosing 实例的 pinned 定义（`v3/definition-pin-decision.md` 不变量 7：动态物化继承 enclosing 实例中与自身 kind 匹配的 tagged `ExecutionDefinitionRef`）；候选具名声明位与编译产物候选表归 #554，本 child 消费。
- 授权先例：#409 命令四类分级 + #410 preset parser rights 校验；`ItemUpdateControlPlaneField` 分类器（`src/daemon.ts:217-229`）仅作形态参考，join 演化命令自持分类。
- **与闭包生命周期正交**（#546 资源模型公理节）：绑定追加只写容器的绑定版本序列，不触碰成员闭包生命周期态、不重算 par pin（凝固点语义）、不重置 reopen 预算与 `group` context scope。

## 问题

#563 物化容器的 join 是运行态事实，但没有演化通道：无 socket 命令面、无绑定版本身份、无候选引用校验、无方向敏感授权——#546「join 判定权演化」条款与关闭验证行 4 无法成立；「事后给动态批次装验证者」的业务能力悬空。裸字段覆写方案已被裁决否决：覆写后容器 id 只命名位置不命名程序，evaluation 无从引用「按哪版规则裁的」，且自由携带 item 调用声明的写入面 = 运行时代码注入。

## 预期结果

- **演化通道**：物化容器未终结期间，operator 经 socket 对其追加 join 绑定版本；值经 join ADT + 候选引用边界 parse——candidateId 在 enclosing 实例 pinned 定义的候选表中解析，悬空引用/词表外值/自由构造的调用声明均被拒；追加与审计事件（作者、授权类别、v(n)→v(n+1)、生效起始 epoch）同事务落地。
- **生效语义**：追加对在途 evaluation epoch 零影响（该 epoch 按创建时采样的绑定跑完，含同 epoch 崩溃重问）；下一 epoch 创建时采样最新版本（采样机制归 #561/#599，本 child 保证版本序列读面在采样点可用且 append-only 无中间态）。
- **定义态拒绝**：join 来自 preset/chain metadata 声明（非物化诞生）的容器，任何绑定追加被拒 + 审计事件，错误点名定义态不可变与 `v3/join-evolution-decision.md`。
- **授权方向敏感**：operator 恒可（双向）；agent 凭证默认拒绝；preset rights 显式授权的 phase 仅可加严方向（drain→validator），放宽方向（validator→drain）对 agent 恒拒；授权语义复用 #409/#410 权利矩阵形态，不新增授权面。
- **place 属性不变**：追加前后容器 id、par pin、reopen 预算计数、`group` scope 键全部不变。
- 已 terminal 容器的追加被拒（无意义写入）。

## 不应残留

- 本 child 范围内：join 进入 `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS` 或任何裸字段覆写路径；无版本身份的 join 写入；接受运行时自由构造 item 调用声明的边界；无审计的演化路径；追加触发 pin 重算/预算重置/闭包状态变更的路径；agent 放宽方向的任何授权形态。
- 本 issue 范围之外不应改动：不动 epoch 采样与判定通道（归 #561/#599）；不动 operator per-epoch decision（归 #561）；不动候选声明位与编译产物候选表（归 #554）；不动绑定版本序列的存储 shape 本体（归 #558，本 child 是写入方）；不动物化诞生时的 join 参数（归 #563）；不动其余四个 control-plane 字段语义。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。
- 裁决权威文本以 `v3/join-evolution-decision.md` 为唯一权威，本 child 实现与文档不得改写。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 演化生效于下一 epoch（预期结果 1+2） | 物化容器（drain）在途 evaluation 中追加 validator 候选绑定；观察本轮与下轮汇合 | local | 本轮按旧绑定完成；下轮 epoch 采样新绑定 spawn 验证者；审计事件含 v(n)→v(n+1) 与生效 epoch |
| function | 同 epoch 主体冻结（预期结果 2） | evaluation `evaluating` 中追加绑定后 kill -9 daemon 重启，观察同 epoch 重问 | local | 重问仍按 epoch 记录中采样的旧绑定执行；新绑定仅下一 epoch 生效 |
| function | 定义态拒绝（预期结果 3） | 对 preset phase 树声明 join 的容器追加绑定 | local | 被拒 + 审计事件，错误点名定义态不可变 |
| function | 授权方向敏感（预期结果 4） | 无 rights agent 追加；有 rights agent 分别追加加严与放宽；operator 双向 | local | 无 rights 拒；有 rights 加严成功、放宽被拒；operator 双向成功；每次尝试留审计事件 |
| function | 值域候选引用（预期结果 1） | 分别写入悬空 candidateId、自由构造的 item 调用声明 JSON、合法候选引用 | local | 前两者边界 parse 被拒且错误点名；合法引用解析进 enclosing 实例 pinned 定义 |
| function | place 属性不变（预期结果 5） | 追加前后比对容器 id、pin commit、reopen 计数、group 键 | local | 全部不变 |
| function | terminal 拒绝（预期结果 6） | 对已 terminal 容器追加 | local | 被拒 + 审计事件 |
| assumption | join 不在 control-plane set | `grep -rn "PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS" src/` 后人工核对 | local | set 仍为四字段；join 演化走独立命令分类 |
| type | 全链路 ADT | `bun run typecheck` | local | 通过 |

## 依赖关系

- Depends on: #558（绑定版本序列与 evaluation bindingVersion 的存储 shape）、#561（join 评估与 epoch 采样点）、#554（join 候选具名声明位与编译产物候选表）、#605（pinned 定义与 tagged `ExecutionDefinitionRef` 解析域）。
- Relates to: #563（物化诞生时 join 参数共用同一候选值域）、#599（evaluation epoch 生命周期，采样点 = write-ahead `evaluating`）、#409/#410（授权矩阵形态）。


---

## Comments (1)

### comment #5007118172 by `RiriAgent` — 2026-07-17T20:14:59Z

重新拆分后由 #703 承接物化容器 join binding 演化。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (30)

- 2026-07-02T11:15:57Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:21Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-02T11:18:23Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:09Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T12:02:40Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-10T11:50:22Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-10T11:51:49Z `cross-referenced` @RiriAgentsrc=606
- 2026-07-10T17:21:25Z `renamed` @RiriAgent
- 2026-07-10T17:26:26Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-10T17:27:30Z `referenced` @RiriAgentcommit=a720d74f93ef04080c001cf0fec1202db9e450b5
- 2026-07-11T07:25:27Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-15T06:26:45Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-15T17:12:01Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-16T03:45:41Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-16T08:23:00Z `cross-referenced` @RiriAgentsrc=690
- 2026-07-17T20:13:16Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:25Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:13:27Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:14:59Z `commented` @RiriAgent
- 2026-07-17T20:15:00Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:32Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-18T01:17:08Z `cross-referenced` @RiriAgentsrc=749