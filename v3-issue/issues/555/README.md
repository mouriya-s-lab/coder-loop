# #555 具名 gate 点声明位

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:42Z  | updated: 2026-07-17T20:41:59Z
- closed: 2026-07-17T20:41:59Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/555
- comments: 2  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其「DSL 演进面」第 7 项，逐字快照：

> "7. **具名 gate 点声明位**（#543 需求）：preset 声明「此处需要一道命名 gate」（名字 + required/optional 标志），脚本绑定归全局/chain 层。声明只有在运行时 capability 能识别并执行时才可进入可调度模型；不得出现 compile 接受 required gate、scheduler 静默忽略的中间状态。" — #547 核心设计·DSL 演进面

跨 RFC 分工逐字快照：

> "答复 #543（RFC-4）：hook「全量元数据」= 编译产物投影 + 运行态快照，不另造第二套 shape；具名 gate 点 DSL 声明位由本 RFC 提供（上节第 7 项）。" — #547 接口假设

## 目标

preset DSL 获得具名 gate 点声明位：任务定义可声明「此处需要一道命名 gate」（名字 + required/optional），装载期校验并由编译产物暴露；但只有 runtime capability 已能识别并执行该声明时，模型才可进入调度。禁止 compile 接受 required gate 而 scheduler 静默忽略。

## 使用场景

- preset 作者在任务定义的某个位置声明 `gate "code-audit" required`——表达「此处必须有一道叫 code-audit 的 gate 才放行」；脚本绑定在全局/chain 层由 operator 配置（#543 语义），preset 只声明「需要」。
- #543 的「preset 级抽象 gate 点」child 消费本声明位：运行期在声明点查找绑定、执行 gate、按 `advance | hold | reopen` 契约判定——全部归 #543，本 child 不实现。
- required gate 未被绑定时的暴露：定义期即可从编译产物看出该 preset 需要哪些 gate——operator 部署前就知道要配什么。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- gate 语义侧（#543）的既有裁决词表：统一判定契约 `advance | hold | reopen(target, correctionItemIds)`（#546 核心模型 + #543 执行模型已统一，总控简报边 5）——本 child 只做声明位，不触判定契约。
- 编译产物侧：编译管线 child 已钉六块 shape——gate 点声明进 phases 块（或产物内的对应结构位），additive。
- 装载期校验同层先例：`checkPresetDag`（`src/preset-dag-check.ts`）findings 形态。

## 问题

#543 的 preset 级抽象 gate 点（操作员目标 5："这种 gate 怎么设计是后来人自己设计，程序要提供这种接口和能力"，`v3/v3-goals.md`）需要任务定义里有一个「此处要 gate」的声明位；当前 DSL 没有任何此类声明面，#543 的 preset 级 gate child 无从启动（总控简报边 3 钉此依赖）。

## 预期结果

性质表述：

1. **声明位存在且类型化**：gate 点声明 = 名字（合法标识符）+ `required | optional` 标志的 typed 结构，arktype 边界 parse；装载期校验重名与位置合法性，违规是编译错误点名。
2. **产物暴露**：编译产物含 gate 点全集（名字、标志、所在位置）——#543 与 #544 从产物读取，不 grep preset.toml。
3. **能力握手而非静默忽略**：本 child 不实现 gate 执行、绑定查找、判定处理；在 #543 runtime capability 落地前，含 gate 声明的模型可 compile/preview，但实例化或调度必须以结构化 `unsupported-capability` 拒绝。不得让 required/optional gate 都悄然等价于未声明。

### gate 点锚定裁决

具名 gate 不发明“phase 边界/树节点”第二套位置语法；声明必须引用 #590 的 `GateDecisionPoint` 封闭 ADT。phase 前后分别引用 `run.pre-spawn` / `run.post-exit`，容器推进引用带稳定 node id 的 `container.join`，chain-complete 引用顶层 join identity。非法点或点与宿主类型不匹配在 compile 期拒绝。编译产物原样投影 point variant + host identity，runtime 不从模板位置猜挂点。

## 不应残留

- 本 child 范围内：不留只进内存不进产物的声明（声明必须可被外部消费者看见）。
- 范围之外不动：gate 执行模型、脚本绑定存储（全局/chain 层，归 #543）、hook 点清单（归 #543）、判定契约文本（归 #546/#543）。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 「语法归本 RFC，语义归 #543」是已裁分工——本 child 不实现 gate 执行；但必须交付 capability mismatch 的结构化拒绝，不能以静默忽略越过接缝。
- 编译产物 shape 变更走 `schemaVersion`，PR body 列 shape diff。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 声明可编译可导出 | fixture preset 声明两个具名 gate 点（一 required 一 optional）→ `preset compile --json \| jq` 取 gate 集 | local | 产物含两点，名字/标志/位置齐全 |
| function | 装载期校验 | fixture 声明重名 gate / 非法位置 → compile | local | 编译错误点名 |
| function | 能力握手 | 在 gate runtime capability 未启用时，对含 required/optional gate 的 fixture 实例化并调度 | local | 在调度前结构化拒绝并点名 capability；不执行任何 phase，不把声明当不存在 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #549（编译管线 child）（产物暴露面）。
- 协调边: 任务树声明面 child（若锚定位置裁为树节点，语法需协调；两 child 可并行推进，锚定裁决先于两者合并完成）。
- Blocks: #591（#543 的 preset 级抽象 gate 点 child，总控简报边 3）。


---

## Comments (2)

### comment #4865082510 by `RiriAgent` — 2026-07-02T11:14:41Z

## 架构切片

1. **系统定位**：编译管线的 gate 声明级——具名 gate 点的 parse、校验与产物暴露；执行语义整体在 #543 域。
2. **全局坐标**：preset 声明域（「此处需要一道命名 gate」）→ 编译产物投影（#543/#544 消费）。脚本绑定在全局/chain 层域（#543），本 child 不触。
3. **类型↔值不漂移**：防类型泄露——gate 的执行/判定语义不得进本声明面类型；声明只承载名字、标志、位置。
4. **消除的错误类别**：「preset 的 gate 需求只存在于散文/口头」不可表达——需求成为产物里可枚举的事实。

## log/观测义务

- 无新事件义务（声明零运行期消费；gate 执行事件归 #543）。



### comment #5007304458 by `RiriAgent` — 2026-07-17T20:41:58Z

重新拆分后由 #740 承接，并硬依赖共享 gate ADT #712。旧 issue 无关联 PR，关闭。


---

## Timeline (16)

- 2026-07-02T11:12:42Z `assigned` @RiriAgent
- 2026-07-02T11:13:11Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:41Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T12:02:40Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-05T07:52:00Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-11T06:42:34Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-17T20:37:25Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:41:58Z `commented` @RiriAgent
- 2026-07-17T20:41:59Z `closed` @RiriAgentcommit=None