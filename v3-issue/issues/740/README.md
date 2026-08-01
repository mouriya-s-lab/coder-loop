# #740 feat(engine): 具名 gate point 声明位

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:24Z  | updated: 2026-07-27T01:00:50Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/740
- comments: 0  | timeline events: 8

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

硬依赖共享 GateDecisionPoint ADT owner，禁止复制 placeholder。

preset DSL 获得具名 gate 点声明位：任务定义可声明「此处需要一道命名 gate」（名字 + required/optional），装载期校验并由编译产物暴露；但只有 runtime capability 已能识别并执行该声明时，模型才可进入调度。禁止 compile 接受 required gate 而 scheduler 静默忽略。

## 问题

#543 的 preset 级抽象 gate 点（操作员目标 5："这种 gate 怎么设计是后来人自己设计，程序要提供这种接口和能力"，`v3/v3-goals.md`）需要任务定义里有一个「此处要 gate」的声明位；当前 DSL 没有任何此类声明面，#543 的 preset 级 gate child 无从启动（总控简报边 3 钉此依赖）。

## 预期结果

性质表述：

1. **声明位存在且类型化**：gate 点声明 = 名字（合法标识符）+ `required | optional` 标志的 typed 结构，arktype 边界 parse；装载期校验重名与位置合法性，违规是编译错误点名。
2. **产物暴露**：编译产物含 gate 点全集（名字、标志、所在位置）——#543 与 #544 从产物读取，不 grep preset.toml。
3. **能力握手而非静默忽略**：本 child 不实现 gate 执行、绑定查找、判定处理；在 #543 runtime capability 落地前，含 gate 声明的模型可 compile/preview，但实例化或调度必须以结构化 `unsupported-capability` 拒绝。不得让 required/optional gate 都悄然等价于未声明。

### gate 点锚定裁决

具名 gate 不发明“phase 边界/树节点”第二套位置语法；声明必须引用 #712 的 `GateDecisionPoint` 封闭 ADT。phase 前后分别引用 `run.pre-spawn` / `run.post-exit`，容器推进引用带稳定 node id 的 `container.join`，chain-complete 引用顶层 join identity。非法点或点与宿主类型不匹配在 compile 期拒绝。编译产物原样投影 point variant + host identity，runtime 不从模板位置猜挂点。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 声明可编译可导出 | fixture preset 声明两个具名 gate 点（一 required 一 optional）→ `preset compile --json \| jq` 取 gate 集 | local | 产物含两点，名字/标志/位置齐全 |
| function | 装载期校验 | fixture 声明重名 gate / 非法位置 → compile | local | 编译错误点名 |
| function | 能力握手 | 在 gate runtime capability 未启用时，对含 required/optional gate 的 fixture 实例化并调度 | local | 在调度前结构化拒绝并点名 capability；不执行任何 phase，不把声明当不存在 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：编译管线的 gate 声明级——具名 gate 点的 parse、校验与产物暴露；执行语义整体在 #543 域。
2. **全局坐标**：preset 声明域（「此处需要一道命名 gate」）→ 编译产物投影（#543/#544 消费）。脚本绑定在全局/chain 层域（#543），本 child 不触。
3. **类型↔值不漂移**：防类型泄露——gate 的执行/判定语义不得进本声明面类型；声明只承载名字、标志、位置。
4. **消除的错误类别**：「preset 的 gate 需求只存在于散文/口头」不可表达——需求成为产物里可枚举的事实。

## log/观测义务

- 无新事件义务（声明零运行期消费；gate 执行事件归 #543）。

## 依赖关系

- Depends on: #549、#712。
- Blocks: #713、#744。


---

## Comments (0)

---

## Timeline (8)

- 2026-07-17T20:37:25Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:15Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:59Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-26T16:14:12Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-26T16:14:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-27T04:27:02Z `cross-referenced` @RiriAgentsrc=712