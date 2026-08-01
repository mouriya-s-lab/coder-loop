# #724 feat(gui): chain/item/run 任务树层级展示

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:47Z  | updated: 2026-07-27T04:27:04Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/724
- comments: 0  | timeline events: 13

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

消费 status tree，展示完整层级。

GUI 全链路层级钻取成立：从首屏到任一 attempt 各层可达，chains→items 层渲染任务树（含 v2 退化树），事件与 run/item 可互相跳转。

## 问题

#544 现状问题 5："数据源良好但无消费面"——44 种事件、快照、SQLite 四表齐备，但 operator 没有任何层级化视图；v3 任务树落地（#546 树）后，「chain 里发生什么」将进一步超出 flat 队列直觉，无树渲染则 par/join/reopen 状态完全不可见。

## 预期结果

性质表述：

1. **各层可达**：daemon → chains → items → runs → phases/attempts 每层有视图且相邻层互链；任一层可直达（可分享的 URL 定位）。
2. **树如实渲染**：任务树节点（leaf/seq/par + join 声明与状态 + reopen 计数）按快照树结构节渲染；节点类型是 discriminated union 穷尽渲染——新增节点 kind 时编译器暴露渲染缺口；v2 退化树正常显示。
3. **事件↔对象跳转**：从任一携带关联键的事件跳到其 run/item；从 run/item 视图反查其事件序列。
4. **契约消费**：数据 shape 全部从 #718/#721 的边界类型派生，无平行 shape、无匿名透传。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 钻取全链（#544 关闭验证行 5 具体化） | 对真实 root 从首屏逐层点到一个 attempt | operator Mac + 浏览器 | 各层可达、无死链；URL 直达任一层 |
| integration | 事件跳转 | 在事件流选取带 runId 的事件点跳转；从该 run 反查事件 | 同上 | 双向跳转正确落位 |
| function | 树渲染（含退化树） | v2 线性 chain 与含 par 的树 fixture（#546 children 落地前用 #558 migration 后的退化树）各看一次 | 本机 | 节点类型/join/reopen 计数如实；退化树正常 |
| function | 穷尽渲染 | code review：树节点渲染处的 union 穷尽检查 | 本机 | 存在 `assertNever` 型穷尽保障 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：GUI 信息架构主干——层级钻取视图树 + 事件↔对象关联；消费 #718/#721 两契约。
2. **全局坐标**：快照契约域 + 事件契约域 → 前端渲染域；关联键（chain/item/runId/phase）是跨域连接值。
3. **类型↔值不漂移**：防类型泄露（平行 shape）与值漂移——slot 概念复活（#546 已裁退役的展示对象）不得再编码进前端。
4. **消除的错误类别**：「par/join/reopen 状态不可见」从必然变为不可表达（树节点穷尽渲染，新增 kind 编译期暴露）。

## log/观测义务

无新增义务；纯消费。

## 依赖关系

- Depends on: #698、#716、#718、#720、#721。
- Blocks: #729。



---

## Comments (0)

---

## Timeline (13)

- 2026-07-17T20:36:48Z `assigned` @RiriAgent
- 2026-07-17T20:38:35Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:38:37Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:41Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:56Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:30Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-26T16:14:27Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-26T16:14:30Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-26T23:49:26Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-26T23:49:28Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-27T04:26:49Z `cross-referenced` @RiriAgentsrc=698