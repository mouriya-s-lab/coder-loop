# #725 feat(gui): per-attempt prompt 与 bindings 展示

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:50Z  | updated: 2026-07-27T01:00:32Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/725
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

消费 prompt/bindings 快照。

任一 attempt 的实发 prompt 在 GUI 可见：渲染全文 + 变量→值对照 + fresh/resume 标记。

## 问题

> "**prompt 事后不可见**……「prompt 展示」缺硬前置。" — #544 现状问题 2

#717 补上持久化后，GUI 若无消费面，操作员目标「还得有 prompt 展示」仍未闭环。

## 预期结果

性质表述：

1. **全文如实**：attempt 页展示 `prompt.md` 全文，与文件字节一致（不截断、不 markdown 二次加工导致语义损失——原文透传呈现）。
2. **对照表**：`bindings.json` 的每个 KEY→值成对展示；resume attempt 明示 resume 标记、所续 session，并展示该 attempt 实发的完整 `effectivePrompt`；固定「继续」只属于 chain-complete finalizer 特例，不外推到普通 scheduler resume。
3. **缺失如实**：#717 落地前的历史 attempt（无落盘产物）显示「该 attempt 早于 prompt 持久化，无快照」——不报错、不留空白骗人。
4. **类型不塌**：`bindings.json` 经边界 parse 进精确类型再渲染。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 展示如实（#544 关闭验证行 4 具体化） | 起一轮真实 run 后打开该 attempt 页，与 `<logDir>/<runId>/<phase>/prompt.md`、`bindings.json` 逐字对照 | operator Mac + 浏览器 | 全文一致；对照表 KEY/值与文件一致；fresh 标记正确 |
| integration | resume 形态 | 对普通 scheduler resume attempt 与 chain-complete finalizer resume 特例分别重复上项 | 同上 | 普通 resume 显示 resume 标记 + 所续 session + 当次完整 `effectivePrompt`；仅 finalizer 特例显示固定「继续」；两者均与实际 argv 完全一致 |
| function | 历史缺失如实 | 打开一个 #717 之前的旧 attempt | 同上 | 明示无快照的原因说明 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：attempt 明细级的 prompt 展示视图——#717 产物的唯一 GUI 消费者。
2. **全局坐标**：run 目录观测产物域 → 前端（`bindings.json` 边界 parse；`prompt.md` 原文透传）。
3. **类型↔值不漂移**：防值漂移——GUI 重放渲染即第二套值来源（#544 已钉不可行亦不可为）；只读文件单源。
4. **消除的错误类别**：「展示的 prompt ≠ 实发的 prompt」不可表达（#717 同源性质 + 原文透传）。

## log/观测义务

无新增义务。

## 依赖关系

- Depends on: #717、#720。
- Blocks: #729。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:51Z `assigned` @RiriAgent
- 2026-07-17T20:38:36Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:57Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:33Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-26T23:49:24Z `cross-referenced` @RiriAgentsrc=724