# #552 变量绑定类型流：目标端类型化与缺失语义统一（required 校验前移创建期）

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:12:26Z  | updated: 2026-07-17T20:41:52Z
- closed: 2026-07-17T20:41:52Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/552
- comments: 2  | timeline events: 21

---

## Body

## 必须先读的关联 issue

#547（RFC: v3 类型系统）。本 child 承接其裁决 C 与 D，逐字快照：

> "类型权威归 source schema；公开 DSL 使用可序列化、递归、封闭的 `ValueType` ADT，四型是基线 variant，结构化 JSON 由 array/record/union 等 schema variant 精化；arktype 仅作实现层 boundary parser，不作为公共类型语言" — #547 裁决记录 C

> "binding 显式声明 `required`（默认）或 typed `default`；杀 `item.*` 静默 `""`。定义可决定的 default/type compatibility 在装载期验证；chain/item 值完备性在对应实例创建期验证；动态 runtime 值在执行边界验证" — #547 裁决记录 D

上游产物契约（编译管线 child）逐字快照：产物 `phases` 块 "variables 每项携带 `type` 字段（既有未类型化绑定 = `"string"` 基线）"——本 child 把该基线替换为真实声明。

## 目标

变量绑定升级为分阶段类型流：source schema 是值类型的唯一权威，binding 只声明 source 引用、缺失策略与显式文本 projection；定义期检查类型兼容，chain/item 创建期检查实例完备性，动态 runtime 值在执行边界检查；消灭静默 `""` 降级。

## 使用场景

- preset 作者给绑定声明 `type = "json"` + `required`，operator 建 chain / 加 item 时缺字段**当场被拒**并点名字段——而不是几分钟后 agent 已 spawn 才 render throw，或更糟：拿着空字符串继续跑。
- #544 的 prompt 落盘 child（`bindings.json`）引用本 child 的类型化值形态——落盘的绑定值带类型，不是全员 string（总控简报边 6）。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行核对）。

- 来源端已是 tagged union：`PresetVariableSource` 三前缀（`src/loop.ts:539-548`）；目标端一律坍缩：`stringifyBindingValue`（`src/loop.ts:5420`）只接受 `string|number|boolean`，`json` 值 render 即 throw——`[item.fields]` 的 `json` 类型只约束存储/写入（`item update --field-json`），不能渲染。
- 渲染失败语义三套不一致：`item.<field>` 缺失/null → 静默 `""`；`chain.<field>` 缺失 → throw（可 `chainFallback`，`src/loop.ts:4177-4186`）；`runtime.<key>` 声明未供值 → throw。
- 四型词表已存在于 item 字段侧：`PRESET_ITEM_FIELD_TYPES = ["string","number","boolean","json"]`（`src/loop.ts:428`）。
- 创建期入口：`handleChainCreate`（`src/daemon.ts:1555`）、`handleItemAdd`（`src/daemon.ts:2189`）、`handleItemBatchAdd`——required 完备性校验的落点。
- doc 声明表已有 `label/suffix/style/blankBefore`（`src/loop.ts:553`、`4382-4384`），本 child 不动 doc 面（归 doc 渲染声明驱动 child）。

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

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- `json` 渲染呈现形态默认值（fenced code block vs inline）。
- `ValueType` 首批结构 variant 的最小集；裁决必须保证 GUI/hook/第三方只靠公共 JSON schema 即可解释，不要求执行 arktype expression。

## 不应残留

- 本 child 范围内：`stringifyBindingValue` 的 `""` 静默分支；「item/chain/runtime 三套失败语义」的文档与实现残留。
- 范围之外不动：doc 渲染声明面（`prefix` 扩展归 doc 渲染 child）、`[[tools]]`、任务树声明、#534 audit 树在修的 v2 缺陷。

## 约束

- 代码红线（#547 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 存量 bundled presets 同步迁移声明；`bun test` 全量既有 preset 加载用例必须继续通过。
- 排序默认（总控简报）：#534 audit 树 children（#535/#536/#538 触 `src/daemon.ts` 同一批面）先合，本 child 在其后 rebase。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
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

## 依赖关系

- Depends on: #549（编译管线 child）（产物 shape 与 type 字段基线由它钉住，本 child 真实化）。
- 被引用：#572（渲染后 prompt 与绑定值快照落盘 `prompt.md` + `bindings.json`）的类型化值形态引用本 child（总控简报边 6——其 `bindings.json` 携带类型化值形态由本 child 提供）。


---

## Comments (2)

### comment #4865082052 by `RiriAgent` — 2026-07-02T11:14:38Z

## 架构切片

1. **系统定位**：编译管线的变量类型流级（声明 parse + 编译期校验）+ daemon 创建期准入门（`handleChainCreate`/`handleItemAdd` 与 #397 status 准入门同类）。
2. **全局坐标**：创建请求域（不可信 JSON，socket 边界）→ typed bindings 域；render 期从 typed 域取值，规范化 JSON 是 typed 值向 prompt 文本域的显式投影。
3. **类型↔值不漂移**：防值漂移——`""` 静默降级让「缺失」与「空串」两个值在跨域时合并，下游不可区分；显式策略（required/default）使缺失在边界即被裁决。
4. **消除的错误类别**：「agent 拿着空占位符跑完全程」不可表达；「json 字段能存不能用」消失。

## log/观测义务

- 创建期拒绝沿既有 daemon `invalid_request` + validation/audit 事件形态（每 mutation 1-3 条审计的既有契约不变）。
- render 期 throw 沿既有 diagnostic 语义；无新事件类型，若需新增须过 `ObservabilityEventTypeBoundary` 枚举。



### comment #5007303739 by `RiriAgent` — 2026-07-17T20:41:51Z

重新拆分后由 #737 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (21)

- 2026-07-02T11:12:27Z `assigned` @RiriAgent
- 2026-07-02T11:13:07Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:14:38Z `commented` @RiriAgent
- 2026-07-02T11:15:25Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T11:58:07Z `cross-referenced` @RiriAgentsrc=570
- 2026-07-02T11:58:39Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-02T12:01:59Z `cross-referenced` @RiriAgentsrc=572
- 2026-07-02T12:02:21Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:52:00Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-12T00:31:28Z `cross-referenced` @RiriAgentsrc=658
- 2026-07-13T04:39:54Z `cross-referenced` @RiriAgentsrc=674
- 2026-07-16T23:17:59Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533
- 2026-07-17T20:36:33Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:37:18Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:37:41Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:41:51Z `commented` @RiriAgent
- 2026-07-17T20:41:52Z `closed` @RiriAgentcommit=None