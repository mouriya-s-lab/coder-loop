# coder-loop v3 GUI — UX 设计

> 输入：`v3/gui-business-flows.md`。本文把 v3 的定义、任务树、任务闭包、evaluation 与因果记录翻译为操作员可理解的交互模型。
>
> 本文不规定视觉风格，也不为现有 `gui-prototype.pen` 提供兼容迁移。原型只有在本文获确认后才能作为下一阶段产物。

## 0. 产品判断

**GUI 是 v3 程序运行时的解释与控制面，不是 daemon dashboard，也不是数据库浏览器。**

它必须让操作员在任何时刻回答：

1. 系统现在还能否提供可信事实？
2. 哪些程序实例需要我注意？
3. 当前任务树为什么归约到这里？
4. 哪个任务闭包在运行或保留现场？
5. 哪个主体依据哪份定义、哪个 epoch/binding 作出了什么判定？
6. 我拥有哪种明确的操作权限，执行后如何证明结果？

## 1. 心智模型

### 1.1 双轴，而非单一实体层级

GUI 同时呈现两个正交轴。

**定义轴：**

```text
Definition bundle
→ CompiledTaskModel
→ definition node
```

**执行轴：**

```text
Chain / workflow instance
→ materialized task tree
→ task closure
→ attempt
→ evaluation / decision / correction
```

两轴通过 `(definitionHash, nodeId)` 连接。chain/item/run 等标识用于导航，但不取代定义—执行关联。

### 1.2 三种时间

界面必须区分：

- **定义时间**：实例创建时 pin 了什么；
- **执行时间**：closure/attempt/frontier 当前在哪里；
- **判定时间**：某个 evaluation epoch 采样了哪个 binding、产生了什么 decision。

把三者混成一个“当前状态”会让 definition drift、resume 和 join 演化不可解释。

### 1.3 结论必须带理由

`running`、`blocked`、`hold`、`suspended` 不能只做颜色 pill。任何非平凡状态必须提供结构化 reason：

- `waiting_on_children`
- `waiting_on_dependency`
- `evaluation_hold`
- `definition_unavailable`
- `tool_requirement_failed`
- `closure_suspended`
- `budget_exhausted`

reason 来自正式契约，不由 GUI 推断。

## 2. 信息架构

### 2.1 一级工作面

| 工作面 | 操作员问题 | 核心对象 |
|---|---|---|
| **Attention** | 现在什么需要我？ | 类型化 attention items |
| **Executions** | 有哪些运行实例，它们在如何归约？ | chain/workflow instances + task trees |
| **Definitions** | 这些实例承诺运行什么？ | pinned/current definitions |
| **Timeline** | 一条因果链如何形成？ | typed events + causal links |
| **System** | 网关/daemon/runner 是否可信？ | health evidence + rate limits |

默认入口是 **Attention**，不是 System。daemon 健康时只提供紧凑全局状态；证据分裂或死亡时，System 诊断自动提升为首要 attention。

### 2.2 对象子视图

以下不是独立资产清单，而是从一级工作面进入的对象视图：

- Execution explorer
- Decision dossier
- Task closure detail
- Definition detail / compare
- Event detail

### 2.3 导航纪律

任何关联键都必须保留进入时的调查上下文。例如从某次 decision 进入 closure，再返回时仍回到原 epoch，而不是回到一棵已变化任务树的默认顶部。

稳定 URL 至少编码：

```text
chain / instance
task node
closure
attempt
evaluation epoch
definitionHash + nodeId
event
```

## 3. Attention 工作面

### 3.1 第一视口

第一视口只回答三件事：

1. **事实源是否可信**：gateway / daemon 总判词；健康时一行，异常时展开三证。
2. **需要操作员的事项**：按责任与紧迫度排序的 attention feed。
3. **正在推进的实例**：只显示 active/recent/attention-bearing instances 的紧凑摘要。

不承诺显示所有 chain，也不承诺所有内容无滚动。完整发现由 Executions 工作面负责。

### 3.2 Attention item 契约

每条 attention item 必须包含：

- 类型：daemon split、evaluation hold、definition failure、closure failure、requirement violation 等；
- 对象：稳定 identity；
- 结论：发生了什么；
- reason：为什么需要人；
- authority：操作员是否有直接动作；
- next view：进入 Execution、Decision、Closure、Definition 或 System；
- age 与 latest change：只作排序辅助。

### 3.3 空状态

无 attention 时只显示：

```text
No operator attention required
N instances progressing · last causal event T ago
```

不填充虚荣指标和事件流来制造 dashboard 密度。

## 4. Executions 工作面

### 4.1 Executions browser

这是完整实例发现面，支持搜索、过滤和分页/游标遍历。默认过滤不是数据库 status，而是操作员语义：

- needs attention
- progressing
- held
- suspended closures retained
- completed/recent
- definition unavailable

每行显示：实例身份、pinned definition、当前 frontier 摘要、活跃 closure 数、当前 evaluation/hold、最近因果变化。不得用固定数量截断完整集合。

### 4.2 Execution explorer

主体是**定义对齐的运行态任务树**。

每个节点至少表达：

- 稳定 node identity；
- definition-owned 还是 runtime-materialized；
- 结构角色：leaf / seq / par；
- 当前归约角色：frontier / running / waiting / evaluating / complete；
- reason；
- 与其关联的 closure、evaluation 或 correction。

#### Leaf

显示任务语义、closure lifecycle、当前 attempt 与 outcome。run 只在 closure 内出现。

#### Seq

显示 cursor，但 cursor 不是唯一信息；必须同时标出：

- 已消费前缀；
- 当前 frontier；
- 尚不可达后缀；
- reopen 导致的回退/新增结构。

#### Par

显示：

- child outcome collection；
- 当前 join binding；
- evaluation epoch；
- hold/reopen/advance；
- correction lineage；
- runtime-materialized 时的 binding version 历史入口。

### 4.3 树的交互

- 单击节点：在同页 inspector 打开结构化摘要；不失去树上下文。
- 深入 closure/decision/definition：新路由保留 origin anchor。
- 大树使用折叠、虚拟化和按子树加载；不得用固定深度/节点数截断。
- 默认展开 frontier、attention 路径和最近 correction lineage，完成且无异常的子树折叠为摘要。
- GUI 不根据颜色或目录痕迹计算父节点状态；父节点投影来自正式 status tree。

## 5. Decision dossier

Decision dossier 是 v3 的核心解释面，不是 Events tab 的一组日志。

### 5.1 固定结构

1. **Decision summary**：container、decision point、epoch、结果。
2. **Authority**：join variant、判定主体、candidate identity、binding version、author/authority class。
3. **Frozen inputs**：outcome vector，每个 outcome 可跳到对应 closure。
4. **Reasoning output**：结构化 decision payload；script/validator 原始输出作为证据，不替代 typed result。
5. **Consequences**：advance 的后继、hold 的重问条件、reopen 生成的 corrections。
6. **History**：前后 epoch 与 binding evolution；明确哪些变化只影响下一 epoch。

### 5.2 操作员权限

界面根据 daemon 返回的 capability 渲染动作。per-epoch operator decision 已进入 #544 F 档：仅当 daemon 返回当前 operator 对该 evaluation epoch 的 decision capability 时，GUI 才渲染 `advance | hold | reopen`，并按原样转发带 evaluation scope 的 operator RPC；GUI 不自行推导判定。

禁止：

- 用 Resume 代替 advance；
- 用 Unblock 代替 operator decision；
- 用编辑 join 代替一次性 override；
- 对 definition-owned join 提供运行时编辑入口。

## 6. Task closure detail

### 6.1 Header

明确显示：

- closure identity = `(item, phase)` task；
- lifecycle：active / suspended / consumed；
- definition node；
- worktree/session/scratch 的保留状态；
- lifecycle reason 与消费证明。

### 6.2 Attempt timeline

attempt 是 closure 内部时间线。每次 attempt 显示：

- fresh / resume；
- runner/model；
- session identity；
- start/end/duration/outcome；
- prompt snapshot availability；
- tool/context contract result。

默认选中导致当前 attention/outcome 的 attempt，而不是机械选最新一条。

### 6.3 调查分面

- **Prompt & bindings**：实际 argv 同源文本、sha256、typed binding 值与 definition source；
- **Context**：该 closure 按合法 scope 实际可见/写入的 entries；body 原文透传；
- **Requirements**：tool/context requirements、outcome、enforcement 与实际结果；
- **Events**：仅该 closure/attempt 的因果事件；
- **Resources**：worktree/session 生命周期事实，不提供文件管理面；
- **Definition**：跳到 pinned definition node，而非当前磁盘 preset。

## 7. Definitions 工作面

### 7.1 Definitions browser

区分两类入口：

- **Current definitions**：当前源 bundle 编译结果，用于 authoring、新实例和 ingress 预校验；
- **Pinned definitions**：已被运行实例引用的内容寻址 bundle。

同一路径出现 H1/H2 时必须并列而不是覆盖。

### 7.2 Definition detail

统一消费 `preset compile --json`/同源 projection，展示：

- task tree；
- state graph；
- typed bindings；
- tools / requirements / outcomes；
- gate/join candidates；
- fragments；
- findings；
- schemaVersion、definitionHash、semantic hash。

这些不是平级卡片陈列，而是围绕“这个定义能生成什么程序、允许什么状态转移、需要哪些输入和判定主体”组织。

### 7.3 Instance ↔ Definition compare

从 Execution 进入 Definition 时默认打开 pinned version。若当前路径已产生另一 hash，提供显式 compare：

- 结构变化；
- 语义保护闭集变化；
- 仅观测/findings 的 additive 变化；
- 哪些变化只会影响新实例。

GUI 不建议或提供 rebind；definition identity 写一次。

## 8. Timeline 工作面

Timeline 不是原始 JSONL 浏览器，而是类型化、可连续遍历的因果记录。

### 8.1 两种模式

- **Live stream**：观察新事件，支持暂停但不改变系统；
- **Causal trace**：以某个 decision、closure、correction 或最终 outcome 为根，沿关联边重建前因后果。

### 8.2 过滤

过滤字段来自正式 envelope：kind/type、chain/instance、task node、closure、attempt/run、phase、evaluation、definition、time cursor。若协议没有 severity，就不在 UI 发明 severity。

完整历史使用 cursor/continuation 遍历，不设魔法数量上限。

### 8.3 Event detail

先展示 typed fields 和关联对象，再提供原始 envelope。raw JSON 是审计证据，不是主要阅读面。

## 9. System 工作面

### 9.1 健康态

一行总结：gateway、daemon、active closures、rate-limit。三证折叠。

### 9.2 Split / Down

展开：

- gateway reachability；
- pid / socket / RPC 三证；
- death time 与最后正式事件；
- 中断的 closures/attempts；
- 最后可用 SQLite/status snapshot；
- start/restart/stop capability。

“gateway unreachable”和“daemon down”必须是完全不同的错误态。

## 10. 写动作交互契约

### 10.1 能力驱动

daemon 返回对象当前允许的 typed capabilities；GUI 只渲染这些能力。daemon 执行时仍是唯一裁判。这避免前端复制规则，也避免把必然失败的按钮展示给用户。

### 10.2 Mutation 生命周期

```text
submitting
→ accepted(operationId)
→ applied(operationId, causalEvent)

或

submitting
→ rejected(code, message)
```

RPC ack 与后续 event/status 通过 `operationId` 关联。SSE 重连后可重新查询，不允许按钮永久 pending，也不靠“某个字段似乎变化了”猜本次操作成功。

错误同时展示稳定 code、操作员可执行说明和可展开的 daemon 原文。

### 10.3 当前动作位置

- daemon start/stop/restart：System 与对应 attention；
- chain stop/resume：Execution header；
- unblock：被 daemon capability 标记为 unblockable 的 task leaf/attention；
- reorder：Execution tree 的合法 scope 内，提供明确落点、结果预览、键盘与移动替代交互。

破坏性动作确认页必须说明影响的 active closures，而不是只问“Are you sure?”。

## 11. 移动端

移动端与桌面消费同一信息架构、路由和 typed contracts，但不要求像素级同构。

首视口目标：

1. 判断事实源是否可信；
2. 看见最高优先级 attention；
3. 进入相关 Decision/Closure；
4. 执行当前 GUI 合同允许的动作。

不承诺所有 chain、异常和动作无滚动显示。长树默认只展开 attention path；完整树可继续浏览。reorder 提供“移动到……之前/之后”的选择式替代，不能只依赖拖拽。

## 12. 组件规划原则

组件必须对应稳定领域语义，而不是视觉形状库存。

### 领域组件

- IdentityLink
- DefinitionRef / DefinitionDiff
- AttentionItem
- TaskNode / Leaf / Seq / Par
- FrontierMarker
- ClosureLifecycle
- AttemptTimeline
- OutcomeVector
- JoinBindingRef
- DecisionSummary
- CorrectionLineage
- RequirementResult
- CausalEvent
- CapabilityAction
- HealthEvidence

### 壳层组件

- AppShell
- WorkSurfaceHeader
- Inspector
- FilterBar
- VirtualizedTree/List
- ConfirmationSheet

状态颜色、pill、card、tab 只是这些领域组件的内部表现，不作为设计系统的第一层分类。

## 13. 待裁决缺口

1. per-epoch operator decision 的 capability/审计呈现是否与 #561 最终 wire contract 一致；
2. attention item 的权威生成者与 boundary shape；
3. daemon capability/operation contract 是否已有实现 child，若无应补 issue；
4. current definition 与 pinned definition 的语义 diff 是否由 compiler 输出，还是 GUI 消费公共 projection 后纯计算；
5. closure `consumed` proof 的公开投影 shape；
6. evaluation/outcome/correction 的 status 与 event identity 是否已由 #558/#561/#562 完整承诺。

这些缺口未裁前可以做线框验证，但不得在前端私自补语义。

## 14. 原型进入条件

只有以下条件同时满足才开始 Pencil：

1. 操作员确认本文的产品判断和一级工作面；
2. 用三条真实业务链走通纸面 walkthrough：恢复连续性、hold→reopen→correction、suspend→resume→consumed；
3. 待裁缺口被标成“已有 contract / 明确 deferred”，没有隐性猜测；
4. 每个画面能指出自己服务哪个控制循环，而不是对应哪个 issue closing row；
5. 原型从空白信息架构开始，不继承现有 `gui-prototype.pen` 的屏幕结构。

## 15. 纸面 walkthrough

以下 walkthrough 用当前 v3 权威裁决检查信息架构是否能闭合真实控制循环。它们验证的是“用户能否得到答案并采取合法动作”，不是页面是否都被访问。

### W1 · 定义 H1 的实例在磁盘切到 H2 后恢复

1. Attention 出现 `definition_unavailable` 或 daemon-down；对象指向旧实例与 H1。
2. 操作员进入 System，看见 daemon 三证与最后快照，执行 Start/Restart。
3. 恢复后回到原 attention；若成功，attention 自动解决，Execution 行仍显示 pinned H1。
4. 操作员从 Execution 的 DefinitionRef 进入 pinned H1；界面检测同源路径当前为 H2，提供 compare。
5. compare 明示：旧实例继续 H1，H2 只影响显式选择它的新实例；无 rebind 动作。

**结果**：定义时间与执行时间没有混淆。若 semantic hash 不匹配，流程停在显式 hold 并点名 H1 identity，而不是展示 H2 伪装恢复成功。

### W2 · par 首次 hold，随后 reopen corrections，第二次 advance

1. Attention 出现 evaluation hold，直接进入对应 Decision dossier，而不是先浏览全量事件。
2. dossier 显示 epoch E1、binding V1、判定主体、冻结 outcomes；每个 outcome 可下钻 closure。
3. 后续 E2 返回 `reopen(target, corrections)`；Consequences 显示新增 correction identity。
4. 返回 Execution，原 par 保持 place identity，correction lineage 自动展开，新 leaf 位于同一归约结构中。
5. correction closure 完成后 E3 创建；dossier 显示新的 outcome vector 与采样 binding，advance 后 Execution frontier 移到后继。

**结果**：hold、reopen 和 correction 是结构化控制流，不表现为状态字符串反复变化。若当前 operator 对该 epoch 无 decision capability，只展示 authority 缺口，不用 Resume 冒充。

### W3 · closure timeout 后 suspend/resume，最终 consumed

1. Attention 的 closure failure 指向 closure C，而不是孤立 run。
2. Closure detail 显示 attempt A1 timeout，但 C 为 suspended；worktree/session 明示 retained，未显示“已完成/已清理”。
3. Prompt、bindings、requirements 与 context 解释 A1 实际输入；若动作合同允许 retry/resume，则 capability 指向 C。
4. A2 作为 RESUME 加入同一 closure timeline，复用 worktree/session；Execution tree 中仍是同一 leaf/closure identity。
5. 控制流最终证明 C consumed 后，Closure header 展示消费证明与资源回收结果。

**结果**：attempt 进程生命周期没有冒充任务生命周期；resume 不被错误表达为新任务或跨 worktree 搬迁。

### Walkthrough 暴露的合同缺口

三条流程均可在信息架构层闭合，但实现前必须解决 §13 中三项直接阻塞：

- attention item 的 typed source；
- capability + operationId mutation contract；
- closure consumed proof 与 evaluation/correction identities 的正式投影。

这些是生产者契约缺口，不应由原型以假数据 shape 先行定案。
