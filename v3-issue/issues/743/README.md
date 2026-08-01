# #743 feat(engine): immutable execution definition ref

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:31Z  | updated: 2026-07-27T04:27:11Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/743
- comments: 0  | timeline events: 14

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

只交付 ref 创建、持久化和核心 resolution；hook/GUI consumer evidence 后置到各 consumer/final integration。

让每个运行实例绑定到**执行前已经完整计算出的不可变执行定义**：preset 源文件后续修改、daemon 重启或 GUI 重新读取，都不得把已运行一半的任务树悄悄接到另一份定义。

这不是 MVCC，也不要求运行时状态携带“执行事务”。保护边界只允许覆盖在运行前可完整计算、可内容寻址的定义；任何依赖实际运行结果的值继续属于运行态，不得伪装进定义快照。

## 问题

#549 当前把编译产物定义为“按需计算不落缓存”，#558 只要求运行态节点关联 compiled node id。稳定 id 只能回答“节点叫什么”，不能回答“节点来自哪一份执行定义”。preset 修改后重新编译，同一 id 可以对应不同 join、runner、rights、toolRequirements、prompt 或 fragment；daemon 重启若重新读取当前文件，durable runtime tree 会发生无显式迁移的语义漂移。

## 预期结果

- 发布一份**可保护字段闭集**：只含 item/chain 实例创建前可完整计算的执行定义；逐字段说明计算时点。运行结果、evaluation、cursor、decision、动态追加结果等运行态事实明确排除。
- 实例创建成功前完成对应 kind 定义的编译/规范化、边界校验和内容寻址；chain 运行态持久引用 `ChainDefinitionRef`，item 运行态持久引用 `PresetDefinitionRef`，任何消费者不得只接收无 tag 的裸 `definitionHash`。
- daemon/scheduler、status/events、hook payload 与 GUI 查看该实例时，沿实例引用读取同一份定义；不得按当前 preset 路径重新解释旧实例。**scheduler resume 重渲染路径显式在内**——普通 resume 实发重新渲染的完整 effectivePrompt（`src/scheduler.ts:1006-1022`，`v3/task-closure-decision.md` §4 已钉），其全部定义输入（模板、fragment、词表）必须来自 pin。
- preset 源后续变化只影响新实例；旧实例若绑定定义缺失或损坏，显式 hold/报错，不回退到当前文件重编译。
- 定义演进必须通过显式新实例或另行裁定的 migration；本 issue 不引入运行态 MVCC、事务版本、隐式 rebind 或“尽量兼容”路径。
- 运行时 join 演化不在本 issue 内冒充定义版本切换；其已由 `v3/join-evolution-decision.md` 与 #703 裁定为仅限物化态容器的 append-only 绑定版本追加，定义态 join 在实例生命周期内不可变。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | 可保护字段闭集与定义 kind | 查本 issue 的设计记录，对照 `CompiledTaskModel` schema 与 chain metadata schema | GitHub + local | preset/chain 两类被保护字段分别列全且有实例创建前计算来源；chain tree/join/baseBranch 不落入 preset bundle hash；无运行结果/事务状态混入 |
| function | preset 漂移不改旧实例 | 用 fixture preset `H1` 创建并跑到 hold；修改同路径为 `H2`（保留 node id、改变 join/prompt/rights），kill -9 daemon 后重启 | local | 旧实例继续消费 `H1`；新实例消费 `H2`；status/events 显示不同 definition identity |
| function | 缺失定义不 fallback | 删除/破坏旧实例引用的定义产物后重启 | local | 旧实例显式 hold/报错并点名 definition identity；不读取当前 preset 代替 |
| integration | 全消费者同源且 kind 不混淆 | 同一 chain 与其 item 分别读取 scheduler 行为、status/events、hook payload、GUI API | local | chain 消费者报告同一 `ChainDefinitionRef`，item 消费者报告同一 `PresetDefinitionRef`；两者均无消费者二次 parse 当前 metadata/TOML，也不存在无 tag 裸 hash |
| type | 定义与运行态边界 | `bun run typecheck && bun test` | local | 通过；定义 ADT 不含运行态 variant，运行态引用定义 identity 而非复制松散字段 |

## 依赖关系

- Depends on: #549、#558。
- Blocks: #698、#702、#710、#713、#726、#744。



---

## Comments (0)

---

## Timeline (14)

- 2026-07-17T20:37:32Z `assigned` @RiriAgent
- 2026-07-17T20:38:48Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:19Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:07Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-18T07:40:29Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-26T16:13:59Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-26T16:14:02Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-26T16:14:08Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-26T16:14:12Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-26T16:14:16Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-26T16:14:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547