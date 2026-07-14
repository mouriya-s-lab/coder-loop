# coder-loop v3 GUI 业务模型与操作员控制循环

> 本文只回答业务问题：v3 在运行什么、操作员何时需要理解或介入、介入后如何确认结果。它不是页面清单，也不从 SQLite 表、RPC 命令或既有原型反推场景。
>
> 权威输入：`v3/v3-goals.md`、`v3/design-boundary.md`、`v3/task-closure-decision.md`、`v3/closure-lifecycle-decision.md`、`v3/definition-pin-decision.md`、`v3/join-evolution-decision.md`，以及 RFC #543–#548。发生冲突时，以较新的专项裁决报告为准。

## 1. v3 的业务对象

coder-loop v3 不是“排队运行 issue”的工具，而是一个持久化、runner-neutral、类型驱动的结构化任务运行时。GUI 的业务对象必须与执行语义同构。

### 1.1 定义（Definition）

preset / chain metadata 经唯一编译管线变成 `CompiledTaskModel`。运行实例在创建时 pin 源 bundle，身份为 `definitionHash`；定义节点身份是 `(definitionHash, nodeId)`。实例创建后，当前磁盘上的 preset 不再是该实例的语义输入。

操作员关心定义，不是为了浏览 TOML，而是为了回答：

- 这个实例承诺执行什么程序？
- 当前节点、join、tool requirement、binding 和 exit 来自哪份不可变定义？
- 当前磁盘定义已经变化时，旧实例为什么仍按旧语义运行？
- 恢复失败是不是定义 bundle 缺失、损坏或语义 hash 不匹配？

### 1.2 运行实例与任务树（Instance / Task tree）

程序结构为：

```text
task ::= leaf
       | seq(task...)
       | par(task..., join)
```

树不是队列的视觉替代品，而是正在被归约的程序。操作员首先关心：

- 当前可归约 frontier 在哪里？
- 哪些 leaf 正在运行、哪些因依赖或父容器语义尚不可运行？
- seq 的 cursor 为什么停在这里？
- par 正在收集哪些 child outcome？
- 新 correction 是由哪次 reopen 决定生成的？

### 1.3 任务闭包（Task closure）

执行单元是同一 `(item, phase)` 的 attempt 链。闭包拥有私有 worktree、runner session 与 per-task scratch；resume 是闭包内部动作。

闭包生命周期是：

```text
active → suspended → active
active/suspended → consumed
```

`suspended` 只改变调度状态，零 GC；只有控制流证明闭包不可能再合法 resume/reopen，才成为 `consumed` 并允许回收。

操作员关心闭包，是为了区分：

- agent 进程已经退出，但任务现场仍应保留；
- 本次 attempt 是 fresh 还是恢复同一闭包；
- retry/reopen 为什么回到原 worktree/session，而不是创建新任务；
- 哪个消费证明允许系统回收现场。

### 1.4 Evaluation、判定权与 correction

`par(children, join)` 在 child outcome vector 冻结后进入 evaluation。join 是 future function：它既规定归约规则，也绑定判定主体。

判定结果为：

```text
advance
hold
reopen(target, corrections)
```

定义态 join 在实例生命周期内不可变。运行时物化容器可通过 append-only `JoinBinding` 版本演化；每个 evaluation epoch 在创建时采样一个 binding version，已决定的结果不可被后续演化改写。operator 一次性判定属于 per-epoch override，不等于修改 join。

操作员关心的是完整判定 dossier：

- outcome vector 是什么？
- 谁拥有判定权？
- 本 epoch 采样了哪个 binding version？
- 为什么 hold？何时重问？
- reopen 生成了哪些 correction，它们现在在哪里？
- 后续演化是否只影响下一 epoch？

### 1.5 因果记录（Causal record）

status、events、prompt/bindings、context entries 和 definition projection 是同一执行事实的不同投影。GUI 不从 worktree 存在性、进程状态或文件痕迹猜测任务语义。

任何关键结论必须能沿稳定身份回溯：

```text
definition node
→ materialized task
→ closure
→ attempt
→ evaluation epoch
→ decision
→ corrections
```

## 2. 操作员的核心控制循环

GUI 的核心不是页面浏览，而是以下六个控制循环。

### L1 · 判断系统是否仍能给出可信事实

**触发**：打开 GUI、收到外部异常、daemon/app 更新后。

**问题序列**：

1. 网关是否可达？
2. daemon 三证是否一致？
3. 若 daemon 已死，历史 events、最后 SQLite 快照和定义包是否仍可读？
4. 是否存在因定义损坏或恢复失败而进入的显式 hold？

**决策**：继续观察业务执行；查看 daemon 诊断；start/restart/stop daemon。

**完成判据**：不是“按钮变绿”，而是网关、daemon 证据和运行事实重新一致；恢复后的实例仍绑定原 `definitionHash`。

### L2 · 判断程序是否按预期归约

**触发**：例行检查、外部任务迟迟没有产出、并行工作进入复杂阶段。

**问题序列**：

1. 哪些运行实例需要注意？
2. 当前 frontier 是什么？
3. 正在运行的是哪些闭包？
4. 不在 frontier 的节点是正常等待、suspended、hold，还是异常？
5. par 是否已进入 evaluation，谁在等谁？

**决策**：无需介入；进入 L3 调查判定；进入 L4 调查闭包；停止某个 chain。

**完成判据**：操作员能够解释“为什么现在运行这些节点、为什么其他节点没有运行”，而不只是看到若干状态 pill。

### L3 · 理解并处理一次判定

**触发**：hold、reopen、预算临界、operator override 请求、join binding 演化。

**问题序列**：

1. 哪个 container / decision point 进入了哪个 epoch？
2. outcome vector 是否完整、来自哪些 closure？
3. 判定主体是 drain、validator、script gate 还是 operator override？
4. 使用的是哪个 binding version 与 pinned candidate？
5. hold 是等待事实变化还是判定者异常？
6. reopen 创建了哪些 correction，是否已被同一结构纳入？

**决策**：等待下一次 evaluation；修复定义后新建实例；取消并重建；在协议允许时作 per-epoch operator decision；停止 chain。

**完成判据**：decision 已被原子消费，或 hold 的责任主体与下一步已经明确。GUI 不把“改 join”伪装成普通参数调整。

### L4 · 调查一个任务闭包为何没有产生期望 outcome

**触发**：attempt timeout/exit、tool/context 合约失败、validator 给出意外结果、resume 行为异常。

**问题序列**：

1. 这是哪个 closure，而不仅是哪个 run？
2. 当前 attempt 是 fresh 还是 resume？继承了哪个 session/worktree？
3. agent 实际收到的 prompt 和 bindings 是什么？
4. closure 看到了哪些 context entries、产出了什么 outcome？
5. closure 是 active、suspended 还是 consumed？依据是什么？
6. 如果现场已回收，消费证明是什么？

**决策**：等待/retry/resume；处理 unblock；回到定义侧修复未来实例；接受该 outcome；进入 L3 检查 join 如何消费它。

**完成判据**：根因落在定义、输入、闭包私有现场、runner 行为、tool/context 合约或判定消费中的一个明确层级。

### L5 · 核对运行实例与定义承诺

**触发**：行为与当前 preset 不同、app 更新后恢复、编写或修改 workflow、非法引用/compile finding。

**问题序列**：

1. 当前查看的是磁盘上的最新定义，还是某实例 pinned 的定义？
2. 两者的 `definitionHash` 是否相同？
3. 某运行节点对应哪个定义节点？
4. join 候选、bindings、tool requirements、gate references 是否在创建前已经闭合？
5. 运行时物化结构继承了哪份 enclosing definition？

**决策**：继续旧实例；以新定义创建新实例；因 bundle/semantic hash 问题保持 hold；修复定义。

**完成判据**：不存在“GUI 展示当前 preset、实例却运行旧 preset”而用户不知情的情况。

### L6 · 审计一条完整因果链

**触发**：事后复盘、恢复验证、争议判定、系统 bug 调查。

**问题序列**：

1. 某个最终结果由哪些 task outcome 构成？
2. 哪个 epoch、哪个主体作出了 advance/hold/reopen？
3. correction 如何进入树并最终被消费？
4. daemon 重启前后 identity 是否连续？
5. operator mutation 是否走正式 RPC 并产生审计事件？

**决策**：确认系统行为正确；定位断裂的生产者/消费者契约；开 correction issue。

**完成判据**：可以仅凭正式 definition/status/events/prompt/context 契约重建因果关系，不读取私有表或靠目录启发式推断。

## 3. 关注信号，而不是“异常列表”

首页需要的是类型化 attention feed。每条关注项必须说明“什么对象、为什么需要人、能进入哪个控制循环”，至少包括：

- daemon 证据分裂或不可达；
- definition bundle 缺失、损坏或 semantic hash 不匹配；
- evaluation hold；
- reopen/correction 仍未收敛；
- tool/context requirement violation；
- closure timeout/runner failure；
- 需要 operator authority 的显式请求；
- 预算耗尽或无法证明 consumed；
- external ingress 拒绝。

相对时间、活 run 数和队列数量只是辅助排序信号，不是 attention 的语义。

## 4. 操作权限边界

RFC #544 的 GUI 写动作闭集是：

```text
daemon start / stop / restart
queue.unblock
chain.stop / chain.resume
item.reorder
operator decision(advance | hold | reopen, evaluation scope)
```

per-epoch operator decision 是较新的 join 裁决定义的解卡能力，现已纳入 F 档。GUI 必须：

1. 展示 decision dossier、evaluation identity 与 operator authority；
2. 仅在 daemon 返回当前 operator 对该 epoch 的 decision capability 时渲染 `advance | hold | reopen`；
3. 把 decision 作为带 evaluation scope 的 operator RPC 原样转发，不由 GUI 自己推导判定；
4. 不用 `chain.resume`、`unblock` 或“改 join”冒充 operator decision。

动作可见性应由 daemon 返回的 capability/command contract 驱动；GUI 不复制合法性规则，也不靠提交后报错教育用户。

## 5. 业务验收场景

GUI 的最终验收不按“每张页面打开成功”组织，而按完整控制循环组织：

1. **恢复连续性**：旧实例 pin H1，磁盘定义改为 H2，kill daemon 后恢复；GUI 清楚显示旧实例仍运行 H1，新实例才运行 H2。
2. **真实并行**：par 内两个闭包真实重叠运行；GUI 显示 frontier、独立 closure、outcome 汇集，而非两个平铺 run。
3. **hold → reopen → correction → advance**：从 hold 进入 decision dossier，看见主体/binding/epoch/outcomes；reopen 后 correction 进入原结构，第二次 evaluation advance。
4. **suspend/resume**：进程退出但 closure suspended、现场不回收；resume 复用同 worktree/session；最终 consumed 后才回收。
5. **daemon-down**：网关仍可解释死亡、历史与最后快照，并恢复 daemon；恢复不改变实例定义身份。
6. **移动处置**：手机完成“识别 attention → 定位 decision/closure → 执行当前 F 档允许动作（含有 capability 时的 per-epoch operator decision）”，不是只证明响应式页面能打开。

## 6. 明确排除的错误起点

- 不以数据库表或 API endpoint 数量决定页面。
- 不以 GUI children 的 closing rows 一一生成屏幕。
- 不把树当 flat queue 的装饰性替代。
- 不把 run 当最高执行身份；run 属于 closure 的 attempt。
- 不把当前磁盘 preset 当运行实例事实源。
- 不把 daemon 三证长期占据主要业务视图；健康时压缩，异常时展开。
- 不用“九个场景没有提到”证明某种发现或导航能力不需要。
- 不在业务模型确定前讨论 Card、Tab、Sidebar 或 Pencil 组件。
