# #738 feat(engine): tools 注册表与 phase requirements 编译

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:19Z  | updated: 2026-07-27T01:00:47Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/738
- comments: 0  | timeline events: 9

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

只交付声明/编译；runtime required outcome 由 #545 integration owner 验收。

新增 `[[tools]]` 注册表与 per-phase `toolRequirements` 声明位，把 provider、availability、outcome、enforcement 正交建模；编译期依据工具有无确定性输出条件（outcome）判定约束是否可执法，一张表喂 doctor、prompt 文档注入与 #545 执法。

## 问题

「可选的 prompt 要求必须调用某种特殊定义的 CLI 工具」（#547 操作员输入 verbatim，`v3/v3-goals.md` 目标 4）在 DSL 中没有声明位：约束只能写进 prompt 散文，引擎无从判定可执法性，doctor 无从知道该检查什么，#545 的执法机制无声明可消费。doctor 因此硬编码 `gh`（零原语残留第 6 处）。

## 预期结果

性质表述：

1. **一张表三消费端**：`[[tools]]` 注册表是工具事实的唯一声明位——doctor 存在性检查、prompt 文档注入（`toolRequirementsDoc`）、#545 执法全部查同一张表；引擎源码中不存在任何工具名字面量兜底。
2. **四维正交**：工具来源 `provider`、存在性解析 `availability`、输出条件 `outcome`、执法等级 `enforcement` 分别建模；不得用 `engine | external` 一个字段同时代替四种事实。
3. **可执法性定义期判定**：`required` 仅对定义了 `outcome`（确定性输出条件，#547 裁决 G 三重确定性：达成确定、判定确定、达成唯一）的工具合法，判定只消费 outcome 轴、provider 不参与；判据双向——不可伪造（条件成立 ⇒ 工具被使用）与构造性完备（合规使用 ⇒ 条件成立）缺一不可。external 工具当前无满足三重确定性的 outcome 形态，声明 required 即编译错误（wrapper 路径若要合法，须以「条件成立 ⟺ 经 wrapper 调用」双向成立为门槛回 RFC 层另裁）。档位与 outcome variant 均为封闭 ADT；outcome variant 按 #547 variant 准入纪律随真实场景与消费端落地，首波仅 entry-existence。
4. **doctor 声明驱动**：doctor 的 external 工具存在性检查由所查 preset 的 `[[tools]]` 声明驱动；`gh` 硬编码检查退役，bundled preset 显式声明 `gh` 为 external 工具——对既有 target 行为不变，对非 GitHub preset 不再误报。
5. **产物真实化**：编译产物 `tools` 块与 `phases[].toolRequirements` 携带真实声明。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 工具约束定义期判定（RFC 关闭验证行 5） | fixture 分别声明 external 无 outcome+required、engine 无 outcome+required、outcome=entry-existence+required → compile | local | 两个无 outcome 的 required 编译错误，错误点名 required 需要确定性输出条件（不提及 provider）；带 entry-existence outcome 的 required 编译通过；可执法性判定只消费 outcome 轴 |
| function | engine capability 引用校验 | fixture 声明 `provider = engine` 指向不存在的 capability → compile | local | 编译错误点名未知 capability |
| function | toolRequirementsDoc per-phase 切片 | fixture 两 phase 声明不同 toolRequirements，渲染各自 prompt | local | 各 phase doc 只含自己声明的工具约束 |
| function | doctor 声明驱动 | 对无 `gh` 声明的 fixture preset target 跑 `coder-loop doctor`；对 bundled preset target 跑 doctor | local | 前者不检查 `gh`；后者检查 `gh`（行为与现状等价） |
| function | gh 硬编码退役 | `grep -n 'whichBinary("gh")' src/install-commands.ts` 及等价字面量检查 | local | 无无条件调用（仅声明驱动路径） |
| integration | 产物真实化 | `coder-loop preset compile <fixture> --json \| jq '.tools, .phases[0].toolRequirements'` | local | 输出真实声明 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：编译管线的工具约束级（`[[tools]]` parse + 可执法性校验）+ 两个消费端切面（doctor 存在性检查、render 期 `toolRequirementsDoc` doc builder）。
2. **全局坐标**：工具声明域（preset TOML）→ 引擎 capability 闭合域（engine kind，穷尽 union）/ 外部工具存在性域（external kind，doctor PATH 检查）。执法消费端在 #545 域，本 child 只交付声明契约。
3. **类型↔值不漂移**：防值漂移——三消费端各自维护工具清单必失同步，单一注册表封死；防类型泄露——`gh` 字面量是 L2 业务工具名硬编码进 L1 doctor。
4. **消除的错误类别**：「声明了引擎观察不到的 required 约束」在编译期不可表达；「doctor 检查与 preset 真实依赖脱节」不可表达。

## log/观测义务

- compile 校验错误经 findings 通道；doctor 输出沿既有 results 行形态。
- 无新增运行期事件（「调用过」判定与执法事件归 #545）。

## 依赖关系

- Depends on: #549。
- Blocks: #732、#733、#744。


---

## Comments (0)

---

## Timeline (9)

- 2026-07-17T20:37:20Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:13Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:54Z `cross-referenced` @RiriAgentsrc=553
- 2026-07-26T16:14:34Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-26T16:14:36Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:32Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-26T23:49:39Z `cross-referenced` @RiriAgentsrc=736