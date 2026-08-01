# #718 feat(engine): status snapshot 精确 schema boundary

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:35Z  | updated: 2026-07-27T01:00:24Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/718
- comments: 0  | timeline events: 9

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

收紧匿名 object 槽；不再把现有 read-write builder 描述为只读。

`StatusSnapshotBoundary` 顶层七个匿名 `"object"` 槽全部换成精确 arktype schema，使 `status --json` 成为 GUI 可依赖的运行态契约。

## 问题

> "**status 快照对 GUI 无契约力**。`StatusSnapshotBoundary` 顶层是七个匿名 `"object"` 槽（`src/loop.ts:490-498`），内部形态靠实现自觉，GUI 消费前必须收紧。" — #544 现状问题 4

## 预期结果

性质表述：

1. **无匿名槽**：`StatusSnapshotBoundary` 顶层与各槽内部不存在匿名 `"object"`/宽松 record 兜底——每个字段有精确 schema，非法形状被 parse 拒绝。
2. **类型单源**：TS 消费端类型从 boundary schema 派生，不手写平行 shape；快照字段演进时编译器暴露全部消费点。
3. **树结构节如约集成**：树结构节采 #558 shape 设计 comment 的 schema，本 child 不改写；其余槽的收紧不侵入 #558 范围。
4. **shape diff 可审**：PR body 显式列出收紧前后 shape diff（#456 先例）；既有消费者（CLAUDE.md 登记的 status JSON 稳定 API 面）字段语义不变或 diff 中显式声明。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 匿名槽清零 | `grep -n '"object"' src/loop.ts`（限 `StatusSnapshotBoundary` 定义区）+ 阅读 boundary 全文 | 本机 | 零匿名槽；每槽字段显式 |
| function | 负例拒绝 | `bun test`（新增用例：对每个槽注入非法形状，断言 parse 拒绝） | 本机 | 七槽各至少一条负例，全部拒绝 |
| integration | 真实快照过 boundary | `coder-loop status <target> --json` 对活 chain 跑一次 | 本机（真实 loop-data root） | 输出通过收紧后 boundary parse；`state.kind == "ok"` |
| assumption | 树结构节与 #558 一致 | 对照 #558 shape 设计 comment 逐字段核对 | GitHub + 本机 | 树结构节 schema 与 #558 记录一致，无本地改写 |
| environment | 既有消费不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：L1 观测面 status 快照的边界收紧——`StatusSnapshotBoundary` 从「形状靠实现自觉」升格为精确契约；构建器数据来源与只读语义不动。
2. **全局坐标**：引擎运行态域（SQLite/内存）→ 快照消费域（CLI JSON / 网关 route）；arktype boundary 是 parse 点；树结构节 shape 权威在 #558，本 child 集成不定义。
3. **类型↔值不漂移**：防类型泄露——消费端手写平行 shape 即把快照形状编码进前端，从 schema 派生封死；防值漂移——匿名槽内部形态自觉即漂移源。
4. **消除的错误类别**：「快照字段变更静默破坏消费者」从可能变为编译期可见（派生类型 + 七槽负例测试）。

## log/观测义务

无新增事件义务；shape diff 义务在 PR body（#456 先例）。

## 依赖关系

- Depends on: #716、#573。
- Blocks: #719、#720、#724、#729。


---

## Comments (0)

---

## Timeline (9)

- 2026-07-17T20:36:36Z `assigned` @RiriAgent
- 2026-07-17T20:38:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:45Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:48Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:17Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-26T16:14:08Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-26T16:14:15Z `cross-referenced` @RiriAgentsrc=716