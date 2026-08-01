# #570 GitHub 消费 daemon 请求预校验：消费 preset compile --json 编译产物

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:58:06Z  | updated: 2026-07-17T20:42:11Z
- closed: 2026-07-17T20:42:11Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/570
- comments: 2  | timeline events: 11

---

## Body

## 必须先读的关联 issue

#548（RFC: v3 第三方调用接口与 GitHub 外挂）。本 child 承接其裁决 D 与校验三层设计，逐字快照：

> "= per-item preset 引用（#412）+ preset 声明 fields/required bindings；确认 #547 接口假设：`preset compile --json` 编译产物是外挂侧请求预校验面" — #548 裁决 D

> "校验三层：外挂侧用 `preset compile --json` 产物预校验（字段名/类型/required，错误带 delivery id 在外挂侧可审计地拒绝）→ CLI/socket 边界 parse → 引擎创建期 required 完备性校验（#547 裁决 D）兜底。" — #548 核心设计

产物契约（#549，逐字快照）：

> "JSON 产物六块：`preset` 元信息（name/dir/源 hash）；`statuses` + `stateGraph`（节点=状态分类，边=「哪个 phase 的哪个 exit 写它」+ 引擎自有转移 entry/exhausted/unblock）；`phases`（exits/trigger/runner/model/typed variables/toolRequirements/rights）+ 任务树结构（#546 的 phase 层 seq/par 树）；`tools`；`fragments`；`findings`（warn 全列，error 已 throw）" — #549 必须先读节（引自 #547 核心设计·编译管线）

> "**schema 即契约**：JSON 产物 shape 由导出的边界 schema（arktype）定义，TS 消费端类型从该 schema 派生，不手写平行 shape；产物携带 `schemaVersion`，shape 演进时 bump。" — #549 预期结果 2

## 目标

消费 daemon 在触发任何引擎调用前，用 `preset compile --json` 编译产物对请求做预校验（preset 存在、字段名、类型、required），失败请求带 delivery id 在外挂侧可审计地拒绝。

## 使用场景

第三方事件映射漏 required 字段 / 引用不存在的 preset / 字段类型不符 → webhook 侧立即结构化拒绝并落审计日志；不产生半成品队列项，无 spawn 后才失败的通路（#548 关闭验证行 2 的外挂半边）。

## 上下文

- 宿主：#569 落地的消费 daemon（本 child 在其入口管线内新增预校验级）。
- 语料：#549 的编译产物。required/default 与真实 type 声明由 #552 真实化——#549 预期结果 3 明言基线是「variables 每项携带 `type` 字段（既有未类型化绑定 = `"string"` 基线）……内容由后续 children additive 真实化」。
- 引擎现状（main@a007fa4，佐证「兜底缺口」）：item.add 边界不对照 preset 声明的 `[item.fields]`——`validateItemExtra`（`src/daemon.ts:4306-4309`）→ `parseItemExtra` 只处理引擎已知键（`src/runtime-data.ts:397-412`）；`PresetItemField` 只有 `type` 无 required 概念（`src/loop.ts:4287-4309`）。required 前移创建期归 #552。
- delivery id 通路：router push 事件携带 deliveryId（router `src/types.ts:75`）；iac-daemon 先例在日志行携带它（`src/iacdaemon/api.py:57,77,98`）。

## 问题

#569 基线下，消费 daemon 只能把畸形请求转给引擎、靠引擎拒绝：错误落在引擎侧审计流，外挂侧（带 delivery id）缺可审计的拒绝环；且 #552 落地前引擎对 preset 声明字段名 / required 不校验（上下文引证），畸形元信息会入队、spawn 后才在渲染期暴露——正是 RFC 行 2 要求封死的通路：

> "元信息漏 required 字段 / preset 引用不存在的调用 → 外挂预校验或引擎创建期拒绝，错误点名缺失字段；无 spawn 后才失败的通路" — #548 关闭验证行 2

## 预期结果

性质表述：

1. **准入前置**：一切引擎调用前的请求先过编译产物校验；未过校验的请求不产生任何 `chain create` / `item add` 调用。
2. **拒绝结构化**：点名缺失字段 / 未声明字段 / 类型不符 / preset 不存在，携带 delivery id，可从 daemon 日志审计。
3. **schema 派生**：消费端类型从产物 schema 派生（#549 性质 2 的消费端义务）——不手写平行 shape；`schemaVersion` 不符 → 显式失败，不静默降级。
4. **加速失败不替代兜底**：预校验通过而引擎仍拒绝时，正确回 `not-consumed`（引擎创建期校验保持兜底地位）。

## 不应残留

- 本 child 范围内：不留绕过预校验直达引擎调用的入队通路；不留手写的第二份产物 shape。
- 范围之外不动：引擎校验语义（required 前移归 #552，#547 树）；router 侧；#569 已定的映射配置语义。

## 约束

- 代码红线（#548 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。消费 daemon repo 同样适用。"
- 产物消费契约（#549 约束节逐字）："编译产物是跨 RFC 消费契约：shape 变更必须走 `schemaVersion`，PR body 显式列 shape diff（#456 先例）。"

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | function | 漏 required 字段拒绝（RFC 行 2） | 构造缺 required 字段的 fixture push——在 coder-loop daemon **停机**状态下执行，证明拒绝不经引擎 | local | 拒绝响应点名缺失字段；daemon 日志行含 deliveryId + 违规明细；引擎停机也照常给出该拒绝（零引擎调用的判别面） |
| 2 | function | preset 不存在拒绝 | 映射到不存在 preset 名的 fixture push | local | 同行 1 形态，点名 preset 引用 |
| 3 | function | 类型不符拒绝 | 字段值类型与产物声明不符的 fixture push | local | 同行 1 形态，点名字段与期望类型 |
| 4 | function | 合法请求无误杀 | 完整合法 fixture push（引擎运行中）；`coder-loop status <target> --json` | local | 过预校验、入队 `consumed`（#569 验收行 1 的通路不回归） |
| 5 | assumption | schema 派生、无平行 shape | 检查消费端类型来源：类型定义 import/生成自产物 schema 的证据（构建脚本或 import 链） | local | 不存在手写重复 shape 文件；类型源头唯一 |
| 6 | assumption | schemaVersion 失配显式失败 | 经测试 seam 喂 `schemaVersion` 提高过的产物 fixture | local | 显式错误终止该请求处理（拒绝或 `not-consumed`），不静默继续 |
| 7 | environment | 类型与测试 | 本 repo typecheck + test | local | 全绿 |

## 依赖关系

- Depends on: #549（编译产物存在——总控简报已钉边 2 的下游端点）。
- Depends on: #552（required/type 声明真实化进产物；#549 基线产物无 required 信息，预校验的「漏 required 拒绝」在其前无语料。超出简报已钉边，理由即此）。
- Depends on: #569（宿主 daemon）。


---

## Comments (2)

### comment #4865424919 by `RiriAgent` — 2026-07-02T11:58:34Z

## 架构切片

1. **系统定位**：消费 daemon 入口管线的准入级——#569 的「事件翻译（映射）→ 引擎调用」两级之间新增预校验级，准入词表来自 #549 编译产物（preset 定义态投影）。
2. **全局坐标**：mesh HMAC 域内、引擎调用前的最后一道边界——「翻译后的结构化请求」对照「preset 定义态契约」。校验点在消费 daemon 进程内；语料经 `preset compile --json` 取自引擎 typed 域投影，不逆向 preset 语义。
3. **类型↔值不漂移**：防值漂移——请求字段与 preset 声明脱节（漏 required / 未声明字段 / 类型不符）在入队前暴露；防类型泄露——消费端类型从产物 schema 派生，不手写平行 shape（#549 性质 2 消费端义务）。
4. **消除的错误类别**：「畸形元信息 spawn 后才在渲染期炸」在本通路不可表达；「外挂侧无对应审计的引擎侧拒绝」消失（拒绝带 delivery id 落外挂日志）。

## log/观测义务

- 预校验拒绝写结构化 JSON 日志行：deliveryId + 违规明细（字段 / 类型 / preset），与 #569 决策日志同流同形态。
- 引擎侧零新增事件义务（预校验不触达引擎）。



### comment #5007305729 by `RiriAgent` — 2026-07-17T20:42:10Z

重新拆分后由 #747 承接，并新增公开 schema artifact 前置 #745。旧 issue 无关联 PR，关闭。


---

## Timeline (11)

- 2026-07-02T11:58:07Z `assigned` @RiriAgent
- 2026-07-02T11:58:15Z `cross-referenced` @RiriAgentsrc=569
- 2026-07-02T11:58:27Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:58:34Z `commented` @RiriAgent
- 2026-07-02T11:58:39Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-02T11:58:50Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-17T20:37:36Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:37:39Z `cross-referenced` @RiriAgentsrc=746
- 2026-07-17T20:37:41Z `cross-referenced` @RiriAgentsrc=747
- 2026-07-17T20:42:10Z `commented` @RiriAgent
- 2026-07-17T20:42:11Z `closed` @RiriAgentcommit=None