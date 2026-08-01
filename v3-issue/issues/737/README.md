# #737 feat(engine): 变量绑定类型流与创建期 required 校验

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:17Z  | updated: 2026-07-27T04:27:09Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/737
- comments: 0  | timeline events: 13

---

## Body

## 必须先读的关联 issue

继承 [#547](https://github.com/mouriya-s-lab/coder-loop/issues/547) 的共享契约与关闭验证。

## 目标

贯通目标端类型与缺失语义。

变量绑定升级为分阶段类型流：source schema 是值类型的唯一权威，binding 只声明 source 引用、缺失策略与显式文本 projection；定义期检查类型兼容，chain/item 创建期检查实例完备性，动态 runtime 值在执行边界检查；消灭静默 `""` 降级。

## 问题

> "变量目标端一律 `String(...)` 坍缩且 `json` 字段渲染即 throw（`src/loop.ts` `stringifyBindingValue`）；渲染失败语义三套不一致（`item.*` 缺失静默 `""`、`chain.*` throw 可 default、`runtime.*` throw）" — #547 定位事实

静默 `""` 是最恶性形态：agent 拿到空占位符照常跑，失败被推迟到不可归因的下游（错 PR、错分支），没有任何错误现场。

## 预期结果

性质表述：

1. **source schema 是类型权威**：item/chain/runtime source 在各自 schema 中声明类型；同一 source 被多个 phase 引用时不得被重新声明成冲突类型。binding 只声明 source、`required | default` 与显式 projection；target expectation 如存在，编译器检查兼容性。
2. **不存在静默降级通路**：任何绑定解析失败，要么在创建期被拒（required 完备性可静态判定的部分），要么在 render 期 throw 且错误点名绑定 key 与来源——`""` 兜底代码路径物理移除，编译器（穷尽 union 分支）保证新增 source kind 必须显式选择失败语义。
3. **验证阶段准确**：default/type compatibility 在 compile 检查；`chain create` 只检查当时已选 workflow 可决定的 required chain 值；`item add`/`batch-add` 检查 item preset 的 required item 值；只有执行时产生的 runtime 值在 spawn 前检查。任何阶段不得提前臆断尚不存在的值，也不得把已可决定的失败拖到 render 后。
4. **结构类型可公开消费**：公开 DSL 用可序列化、递归、封闭的 `ValueType` ADT 表达结构化值；arktype 只负责实现层 boundary parse。结构值经 binding 的显式 canonical-json projection 渲染，不把 `json` 当不透明逃生舱。
5. **产物真实化**：编译产物 `phases[].variables[]` 携带 type/required/default 真实声明。

6. **转移输入沿同一类型流**：source union 增加 `exit.*`，仅用于 path-specific prompt bindings；其 schema 是 CLI 完成当前任务时 agent 必须构造的对象。`item.*` / `chain.*` / `runtime.*` / literal 仍由既有权威来源解析，不进入 agent 可写对象。完整输入按同一 `ValueType`、`required | default` 与 projection 规则形成，不另造 transition 专用类型语言。
7. **来源不可伪造**：同名 `exit.*` 与外部 binding 不得互相覆盖；编译产物与 CLI 查询明确标出 agent-owned 字段。已知 required 外部值在最早可决定阶段缺失时拒绝 transition；只能在 successor spawn 产生的 runtime 值保持 typed pending，解析失败使后继显式 blocked/error，不回写或伪造前驱结果。

补充验收：fixture 路径模板同时声明结构化 `exit.result`、`item.issue`、`chain.repository`、`runtime.base_sha` 与 typed literal；compile 产物逐项携带真实类型和 owner，agent CLI 只被要求填写 `exit.result`。错类型/缺失 result 被拒；agent 在 state object 伪造 repository/base_sha 不得覆盖权威 binding。

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- `json` 渲染呈现形态默认值（fenced code block vs inline）。
- `ValueType` 首批结构 variant 的最小集；裁决必须保证 GUI/hook/第三方只靠公共 JSON schema 即可解释，不要求执行 arktype expression。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | required 校验前移创建期（RFC 关闭验证行 3） | fixture chain 缺 required chain binding 跑 `chain create`；缺 required item 字段跑 `item add` | local | 均创建被拒，错误点名缺失字段；无静默 `""` render 通路 |
| function | json 类型可渲染（RFC 关闭验证行 4） | fixture preset 声明 json 字段绑定，真实 spawn 路径渲染 | local | 规范化 JSON 出现在渲染产物，无 throw |
| function | 静默 `""` 通路物理死亡 | 单元测试：item 字段缺失 + 未声明 default 的绑定走 render → 断言 throw 且信息含绑定 key；`grep -n 'return ""' src/loop.ts` 对照绑定解析区段 | local | 测试绿；绑定解析路径无 `""` 兜底 |
| function | default 类型校验 | fixture 声明 `type="number"` + `default="abc"` → compile | local | 编译错误点名类型不匹配 |
| function | 精化校验双点生效 | fixture json 绑定带 arktype 精化：写入不合规值 → `item update` 拒；声明不合法精化表达式 → compile 错 | local | 两处均拒且点名 |
| integration | 产物携带真实声明 | `coder-loop preset compile <fixture> --json \| jq '.phases[0].variables[0] \| {type, required}'` | local | 输出真实声明值 |
| function | source 类型唯一 | fixture 让两个 phase 以冲突类型引用同一 source → compile | local | 编译错误点名 source 与冲突 expectation；不存在 per-use 重解释 |
| function | 分阶段验证 | 分别制造 default 类型错、chain/item 缺值、动态 runtime 缺值 | local | 分别在 compile、对应 create/add、spawn boundary 最早可决定点失败 |
| integration | schema 可移植 | 独立 consumer 从 compile JSON 读取嵌套结构类型与 projection | local | 无 arktype expression 执行、无 `json` 不透明猜测 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：编译管线的变量类型流级（声明 parse + 编译期校验）+ daemon 创建期准入门（`handleChainCreate`/`handleItemAdd` 与 #397 status 准入门同类）。
2. **全局坐标**：创建请求域（不可信 JSON，socket 边界）→ typed bindings 域；render 期从 typed 域取值，规范化 JSON 是 typed 值向 prompt 文本域的显式投影。
3. **类型↔值不漂移**：防值漂移——`""` 静默降级让「缺失」与「空串」两个值在跨域时合并，下游不可区分；显式策略（required/default）使缺失在边界即被裁决。
4. **消除的错误类别**：「agent 拿着空占位符跑完全程」不可表达；「json 字段能存不能用」消失。

## log/观测义务

- 创建期拒绝沿既有 daemon `invalid_request` + validation/audit 事件形态（每 mutation 1-3 条审计的既有契约不变）。
- render 期 throw 沿既有 diagnostic 语义；无新事件类型，若需新增须过 `ObservabilityEventTypeBoundary` 枚举。

## 依赖关系

- Depends on: #549。
- Blocks: #698、#706、#709、#739、#744。



---

## Comments (0)

---

## Timeline (13)

- 2026-07-17T20:37:17Z `assigned` @RiriAgent
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:12Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:52Z `cross-referenced` @RiriAgentsrc=552
- 2026-07-18T06:19:39Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-18T06:19:40Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-18T06:19:41Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-18T06:19:43Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-26T16:14:16Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-26T16:14:52Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:26Z `cross-referenced` @RiriAgentsrc=725