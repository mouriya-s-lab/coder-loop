# #719 feat(engine+gui): status hooks 与 gate hold 可见性

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:37Z  | updated: 2026-07-27T01:00:25Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/719
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

只扩展精确 status/GUI projection，依赖真实 producer。

status 快照新增 hooks 节（精确 schema）：hook 声明四层合成后的生效视图 + gate hold 状态；GUI 呈现之。

## 问题

#543 落地后，hook 声明与 gate hold 是影响调度的一等运行态，但 status 快照没有它们的位置：operator 无法从 `status --json` 或 GUI 回答「这个 chain 为什么不动」（gate hold 中）与「现在生效的 hook 是哪些」（四层合成结果）——只能翻事件流反推。

## 预期结果

性质表述：

1. **hooks 节精确 schema**：快照新增 hooks 节，含生效 hook 清单（四层合成后视图，标注来源层）与 gate hold 状态（哪个决策点、hold 起始、重问节奏线索）；schema 精确无匿名槽，与 #718 同一红线。
2. **GUI 可见**：gate hold 状态在 GUI 的 chain 视图/首屏异常区呈现；生效 hook 清单在 chain 详情可达。
3. **快照与事件互补**：hooks 节反映「现在」，`hook.*` 事件反映「过程」；两者字段可关联（同一 hook 标识）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 四层合成生效视图 | 全局+chain+preset+item 各声明 hook 后 `coder-loop status <target> --json` | 本机（#543 机制已落地） | hooks 节列出全部生效 hook 且标注来源层，与 #543 合成语义一致 |
| function | gate hold 可见 | 用必 hold 的 gate 脚本触发 hold 后查快照与 GUI | 本机 + 浏览器 | 快照 hooks 节与 GUI chain 视图都显示 hold 中的决策点 |
| function | 负例拒绝 | `bun test`（hooks 节非法形状 parse 拒绝用例） | 本机 | 断言通过 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：status 快照的 hooks 节（运行态投影级）+ GUI 呈现位——#543 hook 状态的快照面；hook 语义与执行不在此。
2. **全局坐标**：#543 hook 运行态域 → 快照消费域（只读投影）→ GUI 呈现；GUI 只呈现快照事实。
3. **类型↔值不漂移**：防值漂移——「生效 hook 视图」若 GUI 侧自行合成即与 daemon 四层合成语义漂移；快照单源封死。
4. **消除的错误类别**：「gate hold 导致的停滞无线索」从必然变为不可表达（hold 状态必在快照与 GUI）。

## log/观测义务

无新增事件义务（`hook.*` 事件归 #543 children）；本 child 只加快照节与呈现。

## 依赖关系

- Depends on: #718、#710、#712。
- Blocks: #729。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:38Z `assigned` @RiriAgent
- 2026-07-17T20:38:37Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:49Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:19Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-27T04:27:00Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-27T04:27:02Z `cross-referenced` @RiriAgentsrc=712