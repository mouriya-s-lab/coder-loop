# #747 feat(router): 使用 compile schema 预校验请求

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:40Z  | updated: 2026-07-27T01:00:58Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/747
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#548](https://github.com/mouriya-s-lab/coder-loop/issues/548) 的共享契约与关闭验证。

## 目标

只从公开 schema artifact 派生 consumer 类型；禁止手写平行 shape 或导入 private source。

消费 daemon 在触发任何引擎调用前，用 `preset compile --json` 编译产物对请求做预校验（preset 存在、字段名、类型、required），失败请求带 delivery id 在外挂侧可审计地拒绝。

## 问题

#746 基线下，消费 daemon 只能把畸形请求转给引擎、靠引擎拒绝：错误落在引擎侧审计流，外挂侧（带 delivery id）缺可审计的拒绝环；且 #737 落地前引擎对 preset 声明字段名 / required 不校验（上下文引证），畸形元信息会入队、spawn 后才在渲染期暴露——正是 RFC 行 2 要求封死的通路：

> "元信息漏 required 字段 / preset 引用不存在的调用 → 外挂预校验或引擎创建期拒绝，错误点名缺失字段；无 spawn 后才失败的通路" — #548 关闭验证行 2

## 预期结果

性质表述：

1. **准入前置**：一切引擎调用前的请求先过编译产物校验；未过校验的请求不产生任何 `chain create` / `item add` 调用。
2. **拒绝结构化**：点名缺失字段 / 未声明字段 / 类型不符 / preset 不存在，携带 delivery id，可从 daemon 日志审计。
3. **schema 派生**：消费端类型从产物 schema 派生（#549 性质 2 的消费端义务）——不手写平行 shape；`schemaVersion` 不符 → 显式失败，不静默降级。
4. **加速失败不替代兜底**：预校验通过而引擎仍拒绝时，正确回 `not-consumed`（引擎创建期校验保持兜底地位）。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|---|
| 1 | function | 漏 required 字段拒绝（RFC 行 2） | 构造缺 required 字段的 fixture push——在 coder-loop daemon **停机**状态下执行，证明拒绝不经引擎 | local | 拒绝响应点名缺失字段；daemon 日志行含 deliveryId + 违规明细；引擎停机也照常给出该拒绝（零引擎调用的判别面） |
| 2 | function | preset 不存在拒绝 | 映射到不存在 preset 名的 fixture push | local | 同行 1 形态，点名 preset 引用 |
| 3 | function | 类型不符拒绝 | 字段值类型与产物声明不符的 fixture push | local | 同行 1 形态，点名字段与期望类型 |
| 4 | function | 合法请求无误杀 | 完整合法 fixture push（引擎运行中）；`coder-loop status <target> --json` | local | 过预校验、入队 `consumed`（#746 验收行 1 的通路不回归） |
| 5 | assumption | schema 派生、无平行 shape | 检查消费端类型来源：类型定义 import/生成自产物 schema 的证据（构建脚本或 import 链） | local | 不存在手写重复 shape 文件；类型源头唯一 |
| 6 | assumption | schemaVersion 失配显式失败 | 经测试 seam 喂 `schemaVersion` 提高过的产物 fixture | local | 显式错误终止该请求处理（拒绝或 `not-consumed`），不静默继续 |
| 7 | environment | 类型与测试 | 本 repo typecheck + test | local | 全绿 |

## 架构切片

1. **系统定位**：消费 daemon 入口管线的准入级——#746 的「事件翻译（映射）→ 引擎调用」两级之间新增预校验级，准入词表来自 #549 编译产物（preset 定义态投影）。
2. **全局坐标**：mesh HMAC 域内、引擎调用前的最后一道边界——「翻译后的结构化请求」对照「preset 定义态契约」。校验点在消费 daemon 进程内；语料经 `preset compile --json` 取自引擎 typed 域投影，不逆向 preset 语义。
3. **类型↔值不漂移**：防值漂移——请求字段与 preset 声明脱节（漏 required / 未声明字段 / 类型不符）在入队前暴露；防类型泄露——消费端类型从产物 schema 派生，不手写平行 shape（#549 性质 2 消费端义务）。
4. **消除的错误类别**：「畸形元信息 spawn 后才在渲染期炸」在本通路不可表达；「外挂侧无对应审计的引擎侧拒绝」消失（拒绝带 delivery id 落外挂日志）。

## log/观测义务

- 预校验拒绝写结构化 JSON 日志行：deliveryId + 违规明细（字段 / 类型 / preset），与 #746 决策日志同流同形态。
- 引擎侧零新增事件义务（预校验不触达引擎）。

## 依赖关系

- Depends on: #745、#746。
- Blocks: #748。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:41Z `assigned` @RiriAgent
- 2026-07-17T20:39:12Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-17T20:39:13Z `cross-referenced` @RiriAgentsrc=746
- 2026-07-17T20:39:17Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-17T20:40:24Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:42:11Z `cross-referenced` @RiriAgentsrc=570
- 2026-07-26T16:15:09Z `cross-referenced` @RiriAgentsrc=548