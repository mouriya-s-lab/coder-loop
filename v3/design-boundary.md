# coder-loop v3 设计边界：最小执行代数与开放扩展面

> 本文用于固定 coder-loop v3 的方向边界，供后续 RFC 实现、PR review、连接性 Gate 与架构演进查阅。
>
> 它不是新的需求来源，也不替代 `v3-goals.md`、六个 RFC umbrella 或 `execution-orchestration.md`；它回答的是一个更高层的问题：**v3 为什么需要代数和类型系统，它们应当走到哪里，又必须在哪里停止。**

## 1. 方向判断

coder-loop v3 不是一门追求理论完备的 Agent 编程语言，也不是一个给现有 loop 添加并发开关的版本。

它的目标是：

> **用最小、闭合、可恢复的执行代数固定 Agent 工作流中不可回避的可靠性语义，把无限开放性留给 meta、hook、runner 和 adapter。**

因此，v3 的代数模型不是装饰性的 PL 化。只要系统要同时支持顺序、并行、汇合判定、返工、动态纠正、取消传播和 daemon 重启恢复，这些复杂度就已经客观存在。显式建模是在压缩复杂度；拒绝建模只会让复杂度退化成状态字符串、boolean 组合、scheduler 特判和 GUI 猜测。

但“需要执行代数”不等于“应当追求代数完备”。v3 应追求的是**场景闭合**，不是理论闭合。

## 2. 最小执行内核

### 2.1 结构代数

当前业务目标要求的最小结构可以表达为：

```ts
type Task =
  | Leaf
  | Seq<readonly Task[]>
  | Par<{
      readonly children: readonly Task[]
      readonly join: Drain | Validator
    }>
```

这三个结构承担不同且不可互相替代的语义：

- `Leaf`：一个可执行、可追踪、可恢复的工作单元；
- `Seq`：带 durable cursor 的有序组合；
- `Par`：带稳定容器身份、独立执行分支和显式 join 的结构化并发。

item 级并行与 phase 级并行应当是同一结构代数在不同层级的实例，而不是两套调度系统。若二者被分别实现，v3 会失去最重要的语义压缩能力。

### 2.2 汇合与判定代数

并行完成不等于工作可以继续。join 必须显式表示推进条件：

```ts
type Join =
  | Drain
  | Validator

type Decision =
  | Advance
  | Hold
  | Reopen
```

- `Drain`：全部分支到达终态即可汇合；
- `Validator`：分支完成后仍须由判定主体决定是否推进；
- `Advance`：当前决策点完成，允许继续；
- `Hold`：保持当前因果位置，等待外部条件或后续判定；
- `Reopen`：将纠正工作重新纳入当前任务结构，再次验证后方可推进。

join 还必须回答“谁拥有推进判定权”，不能只描述节点如何汇总。引擎负责确定性收集并冻结当前 evaluation 的 child outcome vector；`Drain` 的主体是内建结构谓词，`Validator` 的主体是声明实例化出的 validator，未来 script variant 的主体是具名 script gate。收集事实与业务判定必须分层，普通 child、GUI、observer 与 scheduler 其他路径无权代判。

返工因此不再是“把状态改回去”，而是正式控制流。correction 也不再是队列旁路，而是被当前 join 纳入、可追踪和可恢复的任务节点。

### 2.3 内核必须拥有的其他语义

以下能力不是外围功能，而是上述代数能够可靠执行的前提：

- 稳定的 task/container/run/attempt identity；
- durable tree state 与 seq cursor；
- 任务闭包隔离及 worktree 生命周期（执行单元 = 同一 (item, phase) 的 attempt 链；suspend 只改变调度状态且零 GC；worktree/session 保留到控制流证明闭包已完全消费；resume 是闭包内动作——详见 `task-closure-decision.md` 与 `closure-lifecycle-decision.md`）；
- 取消向子树传播；
- 动态追加任务时保持容器身份和 join 归属；
- daemon 重启后的精确恢复与幂等推进；
- 编译模型、SQLite、status、events、GUI 之间可关联的同一身份；
- 明确、可穷尽的错误和判定结果。

缺少其中任何一项，`seq/par/join` 都容易退化成只能在 happy path 上工作的语法外壳。

## 3. 类型系统的职责边界

### 3.1 类型系统应该消灭什么

`CompiledTaskModel` 的价值不是展示复杂类型，而是成为所有消费者共享的规范化 IR。装载/编译阶段应尽可能确定：

- 引用是否存在；
- task tree 是否结构合法；
- join、validator、gate 和 tool 引用是否有效；
- binding 的类型和 required 语义是否相容；
- 状态边、fragment 和决策点是否可达；
- 并行结构是否具备完整的汇合语义；
- scheduler、hook、status、GUI、ingress 将使用哪些稳定身份。

完成编译后，消费者不应重新 parse TOML、不应按 phase 名特判，也不应通过私有 adapter 猜测缺失字段。

长时间运行的实例还必须绑定到实例创建前已经完整计算、校验并内容寻址的不可变执行定义（#605）。这不是运行态 MVCC：只有事前可计算的定义字段能进入保护边界；cursor、evaluation、decision、动态 child 等运行事实仍是运行态。绑定形态已裁决为源 bundle 内容寻址 pin + 唯一编译管线重编译 + 闭集语义 hash 验证钉，pin 时点 = 实例创建——详见 `definition-pin-decision.md`。运行中修改 join 已裁（`join-evolution-decision.md`）：它是 future-function mutation——定义态 join 实例内不可变；物化态 join 以绑定版本追加演化（epoch 创建时采样生效，值域限 pinned 定义内候选引用），永不表现为定义版本切换。

### 3.2 类型系统不能消灭什么

“可计算元信息”不应被解释为“系统不再需要运行时验证”。类型系统无法静态证明：

- agent 真的执行了 required tool；
- hook 或外部 daemon 返回了符合协议的实际数据；
- validator 的业务判断正确；
- runner、GitHub、文件系统或脚本没有在运行时失败；
- daemon 没有在副作用中途崩溃；
- 外部输入天然可信。

准确的边界是：

> **定义结构在装载期编译并验证；所有外部输入在边界解析；执行过程中只维护编译模型允许的状态和转移。**

类型系统负责消灭结构性猜测，而不是假装消灭外部世界。

### 3.3 DSL 不是通用编程语言

“零原语纯 meta”应理解为：**引擎不内置 iteration、review、GitHub 等业务原语**，而不是引擎没有任何执行原语。

引擎必须原生理解 leaf、sequencing、concurrency、join、decision、cancellation 和 durable identity。否则这些概念只会被隐藏进字符串解释器。

声明 DSL 应保持有限和稳定。开放计算交给：

- agent；
- hook/script；
- runner；
- 外部 adapter。

不要在 TOML 中逐步加入条件表达式、模板运算、任意递归、动态求值，最终造出一门缺少成熟工具链的半编程语言。

## 4. 开放性应当放在哪里

v3 的长期扩展能力不应来自不断给引擎增加节点种类，而应来自四个外围面。

### 4.1 Meta / preset

定义业务任务结构、状态词表、bindings、工具要求、gate 绑定和 runner 选择。它描述“要运行什么”，但不把领域含义渗入引擎。

### 4.2 Hook

承担开放式生命周期计算和用户态策略，例如定期审计、插入检查任务、生成 correction、阻止或放行推进。hook 扩展策略，不扩张 scheduler 的业务知识。

observer 与 gate 必须有清晰区别，但 script gate、agent validator 等判定主体应尽量消费统一 decision 协议，避免形成多套推进语义。

### 4.3 Runner

负责如何执行一个 leaf。Codex、Claude、OpenCode、HAPI 或未来执行器都不应改变任务代数。runner 差异应终止于统一的 attempt/result boundary。

### 4.4 Adapter / ingress

GitHub webhook、外部 daemon、GUI 或其他业务系统负责把外部事件转换为结构化 workflow 调用。它们选择 workspace/chain、workflow 与 metadata，而不是向引擎直接注入 prompt，也不把 GitHub 业务字面量带回 L1。

## 5. 暂不进入内核的能力

除非出现当前最小代数无法自然表达、并且有真实端到端验收场景的需求，否则以下能力不应进入 v3 内核：

- `race` / `select`；
- 任意循环与递归；
- higher-order task；
- 用户自定义节点种类；
- 任意运行时图重写；
- 通用表达式语言；
- 复杂类型推导或跨 workflow 泛型；
- actor/mailbox 或通用数据流计算；
- 为未来集群执行预造的分布式一致性协议；
- 试图静态证明 agent 的业务结论。

这些能力不是永远禁止，而是必须由无法用现有模型表达的真实任务反向逼出，不能从 PL 概念目录正向填充。

## 6. 实现阶段的语义稀释风险

当前 v3 的主要风险不是抽象方向错误，而是几十个局部正确的实现 PR 将统一语义重新拆散。

以下现象应被视为架构回归信号：

1. 用临时字符串或 boolean flags 表示已有 ADT；
2. scheduler 按 preset、phase 名或 GitHub 字段特判；
3. phase 并行和 item 并行形成两套推进模型；
4. hook、agent validator、script validator 各自定义 decision 协议；
5. context 通过共享 worktree 文件形成旁路；
6. GUI 重新 parse preset、读取私有表或推断缺失状态；
7. ingress 复制一套与 compiler 不同的 validation；
8. compile、SQLite、status/events、GUI 使用不同节点身份；
9. 为兼容 v2 建立长期双轨，而不是让线性 preset 成为任务树的退化形式；
10. 用 typecheck、单元测试或各模块 mock 成功替代真实跨边界证明。

连接性 Gate 的意义正是防止这些局部实现把系统重新推回 stringly-typed orchestration。

## 7. 新原语准入测试

任何新增类型、节点、组合子或特殊状态在进入内核前，都必须回答：

1. **它删除了哪些 scheduler 分支、隐式约定或重复机制？**
2. **它是否至少服务两个真实业务场景，或者是一个关键场景不可缺少的语义？**
3. **没有它，哪项 G3/G4/G6 端到端验收无法表达？**
4. **它能否通过 compile → SQLite → status/events → GUI 保持同一身份和语义？**
5. **它为什么不能由 hook、runner 或 adapter 实现？**

前三项答不上来，通常是过度设计；第四项答不上来，说明设计尚未闭合；第五项答不上来，说明能力放错了层。

## 8. 产品定位与发散边界

如果上述边界成立，coder-loop v3 的准确定位不是“更好的 coding-agent wrapper”，而是：

> **一个运行可编译、可恢复、可审计 Agent 工作流的可靠执行内核。**

它可以从代码工程继续发散到研究、内容、数据分析、运维、合规和其他数字工作流，也可以逐步形成组织级 Agent control plane。但这些领域扩张必须通过 preset、hook、runner 和 adapter 完成，而不是持续扩大内核。

长期最有价值的资产可能不是某个 bundled workflow，而是稳定、版本化、runner-neutral 的 `CompiledTaskModel`：不同 DSL、GUI builder 和外部系统产生同一 IR，由 coder-loop 或其他兼容执行后端消费。

项目应主动拒绝以下身份漂移：

- 通用模型 API 聚合层；
- tool-calling SDK；
- vector memory 平台；
- agent persona/chat 编排器；
- 内建 GitHub 自动化平台；
- 以拖拽画布为核心的低代码工具；
- 在单机可靠语义尚未钉死前扩张成分布式调度平台。

## 9. 最终边界

判断 v3 是否设计得当，不看类型数量、RFC 数量或功能数量，而看最终是否形成：

> **一个非常小的内核，能够完整解释一个表面上非常复杂的自主 Agent 系统。**

代数和类型系统只应服务于这个目标：

- 让合法状态可表达；
- 让非法结构在执行前失败；
- 让运行时状态可恢复；
- 让每次推进可解释；
- 让所有消费者共享同一事实；
- 让领域变化不迫使内核变化。

一旦某项设计开始服务语言的纯洁性、理论完备性或未来想象，而不能增强上述六点，它就越过了 coder-loop v3 的边界。
