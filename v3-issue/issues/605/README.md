# #605 运行实例绑定事前可计算的不可变执行定义

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-10T11:50:21Z  | updated: 2026-07-17T20:42:06Z
- closed: 2026-07-17T20:42:06Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/605
- comments: 1  | timeline events: 32

---

## Body

## 必须先读的关联 issue

- **umbrella #547**：继承 `CompiledTaskModel` 是唯一规范化 IR、定义结构在装载期编译、运行消费者不重新 parse TOML 的契约。
- **#549**：继承 `preset compile --json` 的源 hash、`schemaVersion`、稳定 node identity 与唯一投影函数。
- **#558**：运行态树以稳定 identity 关联编译节点，但当前尚未绑定产生这些节点的具体编译定义版本。

## 目标

让每个运行实例绑定到**执行前已经完整计算出的不可变执行定义**：preset 源文件后续修改、daemon 重启或 GUI 重新读取，都不得把已运行一半的任务树悄悄接到另一份定义。

这不是 MVCC，也不要求运行时状态携带“执行事务”。保护边界只允许覆盖在运行前可完整计算、可内容寻址的定义；任何依赖实际运行结果的值继续属于运行态，不得伪装进定义快照。

## 操作员裁决

> “我不认为这应该用mvcc，因为这等同于要求运行时状态携带执行事务……除非携带事务本身可在事前计算，结果是可保护，不然这个是bug产生场所。” — 操作员，2026-07-10

因此本 issue 的准入条件是：先列出被保护定义的字段闭集，并证明每个字段在实例创建前可计算。答不上来的字段不得进入绑定产物。

## 裁决记录（操作员，2026-07-11，边界 A 会话；权威记录 `v3/definition-pin-decision.md`）

- **绑定形态 = 两类不可混淆的内容寻址定义引用**：`PresetDefinitionRef` 在 item 创建时物化 preset 源 bundle（复用既有 `materializePreset` 内容寻址，`src/loop.ts:4084`），以 bundle 内容 hash + pin 时刻 canonical projection 的闭集语义 hash + schemaVersion 作验证钉；`ChainDefinitionRef` 在 chain 创建时把 chain metadata 中事前可计算的执行声明（chain task tree、顶层 join/validator、`baseBranch` 及其余被保护字段闭集）规范化为独立内容寻址 artifact，并记录其闭集语义 hash + schemaVersion。两者组成封闭 ADT，不得用 preset bundle hash 冒充 chain definition identity，也不得把两类 node identity 放进同一无 tag 的 hash 空间。持久化编译产物 DTO 并直接消费的模型仍被否决（需要第二构造路径 + 无限 schemaVersion 迁移义务）。
- **「事前」= 实例创建**：编译是确定性纯函数、无时点权威；chain create 冻结 `ChainDefinitionRef`，并可另带显式默认 `PresetDefinitionRef`；item create 冻结自己的 `PresetDefinitionRef`（未显式指定时只可继承 chain 的默认 preset ref，绝不继承或冒充 chain definition ref）。task materialize / attempt spawn 只解引用，永不 pin；动态物化分别继承 enclosing 实例中与自身 kind 匹配的定义引用。
- **重建按定义 kind 走唯一构造路径**：`PresetDefinitionRef` 按 bundle hash 定位源 → 唯一 compile 管线重编译；`ChainDefinitionRef` 按 artifact hash 定位规范化 chain declaration → #566 的唯一 typed boundary 重建。两类都须与 pin 时语义 hash 一致才继续；不一致或 artifact 缺失 → 显式 hold 并点名带 kind 的 definition identity。语义 hash 只盖各自可保护字段闭集，闭集外 additive 演进不参与。
- **唯一原子性面 = 创建期写序**：对应 kind 的 definition artifact 先于实例行写入（definitions 存储进 SQLite，与实例行同事务），防 crash 窗口悬空引用；chain 同时引用 chain/default-preset 两类定义时，两条引用与实例行同事务落地。这是事前可计算的创建期义务，不是运行态事务，与本 issue 禁令不冲突。
- **#549 裁决 A 加 scope**：「单一事实源是定义文件本身；按需计算不落缓存」回答「该 preset 现在说什么」（compile CLI、新实例创建、ingress 预校验）；运行中实例的事实源是其 pin。本 issue「问题」节指出的冲突以此调和。
- **配套工程义务**：preset bundle 与 chain definition artifact 各有按 ref kind 分离的 keep 集合；`prunePresetMaterializedRoot`（`src/loop.ts:4215`）只处理 `PresetDefinitionRef`，keep = 活实例 preset pin ∪ 当前源 hash，不能误删 chain artifact；chain artifact 的保留/回收按活 `ChainDefinitionRef` 独立计算。`loadedPresetCache`（`src/daemon.ts:833`）cache key 改为 `PresetDefinitionRef`，不得接受裸 hash 或 chain ref。

## 使用场景

一条长时间运行的 chain 使用 preset 定义 `H1` 创建 item；运行中 preset 文件被编辑成 `H2`，随后 daemon kill -9 并重启。旧 item 必须继续按 `H1` 的 phase tree、join/validator、rights、toolRequirements、binding 类型和 prompt/fragment 定义运行；新 item 才可选择 `H2`。相同 node id 不得被当作定义相同的证据。

## 问题

#549 当前把编译产物定义为“按需计算不落缓存”，#558 只要求运行态节点关联 compiled node id。稳定 id 只能回答“节点叫什么”，不能回答“节点来自哪一份执行定义”。preset 修改后重新编译，同一 id 可以对应不同 join、runner、rights、toolRequirements、prompt 或 fragment；daemon 重启若重新读取当前文件，durable runtime tree 会发生无显式迁移的语义漂移。

## 完成态片段

- 发布一份**可保护字段闭集**：只含 item/chain 实例创建前可完整计算的执行定义；逐字段说明计算时点。运行结果、evaluation、cursor、decision、动态追加结果等运行态事实明确排除。
- 实例创建成功前完成对应 kind 定义的编译/规范化、边界校验和内容寻址；chain 运行态持久引用 `ChainDefinitionRef`，item 运行态持久引用 `PresetDefinitionRef`，任何消费者不得只接收无 tag 的裸 `definitionHash`。
- daemon/scheduler、status/events、hook payload 与 GUI 查看该实例时，沿实例引用读取同一份定义；不得按当前 preset 路径重新解释旧实例。**scheduler resume 重渲染路径显式在内**——普通 resume 实发重新渲染的完整 effectivePrompt（`src/scheduler.ts:1006-1022`，`v3/task-closure-decision.md` §4 已钉），其全部定义输入（模板、fragment、词表）必须来自 pin。
- preset 源后续变化只影响新实例；旧实例若绑定定义缺失或损坏，显式 hold/报错，不回退到当前文件重编译。
- 定义演进必须通过显式新实例或另行裁定的 migration；本 issue 不引入运行态 MVCC、事务版本、隐式 rebind 或“尽量兼容”路径。
- 运行时 join 演化不在本 issue 内冒充定义版本切换；其已由 `v3/join-evolution-decision.md` 与 #564 裁定为仅限物化态容器的 append-only 绑定版本追加，定义态 join 在实例生命周期内不可变。

## 不应残留

- 仅持久化 node id、preset 名或文件路径，却声称定义已经绑定。
- daemon 重启后按当前磁盘 preset 重建旧实例语义。
- 把 cursor、evaluation epoch、decision、动态 child、物化态 join 绑定版本等运行态值塞进所谓定义快照。
- 定义找不到时静默使用最新 preset。

## 约束

- 先证明事前可计算，再允许持久保护；不可计算的值留在运行态。
- 编译模型仍只有一个构造路径；不得为持久化复制第二套 parser/IR。
- 全链路 ADT、边界 parse、无 `any`/匿名 shape/真 `as` 的既有红线继续成立。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | 可保护字段闭集与定义 kind | 查本 issue 的设计记录，对照 `CompiledTaskModel` schema 与 chain metadata schema | GitHub + local | preset/chain 两类被保护字段分别列全且有实例创建前计算来源；chain tree/join/baseBranch 不落入 preset bundle hash；无运行结果/事务状态混入 |
| function | preset 漂移不改旧实例 | 用 fixture preset `H1` 创建并跑到 hold；修改同路径为 `H2`（保留 node id、改变 join/prompt/rights），kill -9 daemon 后重启 | local | 旧实例继续消费 `H1`；新实例消费 `H2`；status/events 显示不同 definition identity |
| function | 缺失定义不 fallback | 删除/破坏旧实例引用的定义产物后重启 | local | 旧实例显式 hold/报错并点名 definition identity；不读取当前 preset 代替 |
| integration | 全消费者同源且 kind 不混淆 | 同一 chain 与其 item 分别读取 scheduler 行为、status/events、hook payload、GUI API | local | chain 消费者报告同一 `ChainDefinitionRef`，item 消费者报告同一 `PresetDefinitionRef`；两者均无消费者二次 parse 当前 metadata/TOML，也不存在无 tag 裸 hash |
| type | 定义与运行态边界 | `bun run typecheck && bun test` | local | 通过；定义 ADT 不含运行态 variant，运行态引用定义 identity 而非复制松散字段 |

## 依赖关系

- Depends on: #549（规范化编译产物与公共投影）、#558（运行态节点 identity 与持久化 shape）。
- Blocks: #547 关闭复核、G6 的 daemon 重启恢复证明。
- Relates to: #564（物化态 join 演化按 append-only 绑定版本追加落在运行态域；定义态 join 属本 issue 保护域并保持不可变）。


---

## Comments (1)

### comment #5007305290 by `RiriAgent` — 2026-07-17T20:42:06Z

重新拆分后由 #743 承接核心 definition ref，跨 consumer 验收归 #744。旧 issue 无关联 PR，关闭。


---

## Timeline (32)

- 2026-07-10T11:50:22Z `assigned` @RiriAgent
- 2026-07-10T11:50:31Z `parent_issue_added` @RiriAgent
- 2026-07-10T11:51:18Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-10T11:51:49Z `cross-referenced` @RiriAgentsrc=606
- 2026-07-10T11:55:45Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-10T17:02:41Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-10T17:02:43Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-10T17:03:18Z `referenced` @RiriAgentcommit=c1de2d3499056cca610d20d8e08121f562c51945
- 2026-07-10T17:21:26Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-11T06:42:39Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-11T06:42:42Z `cross-referenced` @RiriAgentsrc=572
- 2026-07-11T06:42:45Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-11T06:42:46Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-11T07:25:26Z `cross-referenced` @RiriAgentsrc=557
- 2026-07-11T07:25:27Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-11T10:10:27Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-12T00:31:28Z `cross-referenced` @RiriAgentsrc=658
- 2026-07-13T04:39:54Z `cross-referenced` @RiriAgentsrc=674
- 2026-07-13T05:51:25Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-15T19:03:57Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-17T20:13:32Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:33Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:30Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-17T20:37:32Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:42:06Z `commented` @RiriAgent
- 2026-07-17T20:42:07Z `closed` @RiriAgentcommit=None